// Record comments ("Updates"): posting, replying, editing, deleting and @mentions. See
// repositories/mongo/comment-repository.js for the stored shape.
//
//   identity      the author is always the signed-in person (req.actor); names come from the session, never the
//                 request body
//   text          plain text only (1–5,000 characters, control characters removed); browsers render it escaped, so
//                 no stored markup can run
//   threads       one level: a reply to a reply attaches to the top-level comment
//   mentions      stable user IDs ("user:<id>"), each checked against the people who may be assigned in the workspace
//   ownership     only the author edits; the author or a moderator (JARC administrator, or a real workspace-admin
//                 membership) deletes. Deleting keeps a tombstone so replies stay in their thread
//   records       archived records keep their discussion (readable, closed to new posts); deleting a record, board or
//                 workspace deletes its comments
//   activity      each post/edit/delete adds an activity entry (IDs only, no text): live updates, the notification
//                 feed (mentions, replies) and the audit trail. It is written in the same transaction as the comment
//   read-only     boards synchronized from monday.com refuse new comments, edits and deletions
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { activityEntry, conflict } = require("./shared");

const MAX_BODY = 5000, MAX_MENTIONS = 20;
const invalid = (message) => new ApiError(400, "VALIDATION_ERROR", message);
const userRef = (id) => `user:${id.toHexString()}`;
const USER_REF = /^user:([0-9a-f]{24})$/;

function cleanBody(value) {
  if (typeof value !== "string") throw invalid("Write something first.");
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!text) throw invalid("Write something first.");
  if (text.length > MAX_BODY) throw invalid(`An update can be at most ${MAX_BODY.toLocaleString("en-US")} characters.`);
  return text;
}

class CommentService {
  constructor({ repos, connection, access, logger = console }) { Object.assign(this, { repos, connection, access, logger }); }

  // People who may be mentioned in this workspace: the same rule as People columns.
  async mentionable(actor, workspaceId) {
    const everyone = this.access.shared || actor.kind === "development";
    const users = everyone ? await this.repos.users.listActive() : await this.repos.users.findByIds((await this.repos.memberships.listByWorkspace(workspaceId)).filter((m) => m.status === "active").map((m) => m.userId));
    return users.filter((u) => u.status === "active");
  }
  async checkMentions(actor, workspaceId, raw) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_MENTIONS) throw invalid(`Mention at most ${MAX_MENTIONS} people.`);
    const ids = [...new Set(raw.map((r) => { const m = typeof r === "string" && USER_REF.exec(r); if (!m) throw invalid("Mentions must be people from this workspace."); return m[1]; }))];
    if (!ids.length) return [];
    const allowed = new Set((await this.mentionable(actor, workspaceId)).map((u) => u._id.toHexString()));
    if (ids.some((id) => !allowed.has(id))) throw invalid("You can only mention people who can see this workspace.");
    return ids.map((id) => new ObjectId(id));
  }
  async isModerator(actor, workspaceId) {
    if (actor.isSystemAdmin) return true;
    return (await this.access.roleIn(actor, workspaceId, { membershipOnly: true })) === "WORKSPACE_ADMIN";
  }
  writable(board, record) {
    if (board?.source?.readOnly) throw new ApiError(403, "READ_ONLY_BOARD", "This board is synchronized from monday.com and is read-only in JARC.");
    if (record?.archived) throw new ApiError(409, "RECORD_ARCHIVED", "This record is archived. Restore it to add or change updates.");
  }

  async list(actor, record) {
    const docs = await this.repos.comments.listForRecord(record._id);
    const moderator = await this.isModerator(actor, record.workspaceId);
    // Tombstones only matter when they still hold replies.
    const withReplies = new Set(docs.filter((d) => d.parentId && !d.deletedAt).map((d) => d.parentId.toHexString()));
    return docs.filter((d) => !d.deletedAt || withReplies.has(d._id.toHexString())).map((d) => this.toApi(d, actor, moderator));
  }
  counts(boardId) { return this.repos.comments.countsForBoard(boardId); }

  async create(actor, { record, board }, body) {
    this.writable(board, record);
    const text = cleanBody(body.body), mentions = await this.checkMentions(actor, record.workspaceId, body.mentions);
    let parent = null;
    if (body.parentId !== undefined && body.parentId !== null) {
      if (typeof body.parentId !== "string" || !ObjectId.isValid(body.parentId)) throw invalid("parentId must be an update ID.");
      parent = await this.repos.comments.findById(new ObjectId(body.parentId));
      if (!parent || !parent.recordId.equals(record._id) || parent.deletedAt) throw invalid("You can only reply to an update on this record.");
      if (parent.parentId) parent = await this.repos.comments.findById(parent.parentId) || parent; // one level of replies
    }
    const now = new Date();
    const doc = { _id: new ObjectId(), workspaceId: record.workspaceId, boardId: record.boardId, recordId: record._id, parentId: parent?._id || null, authorId: actor.userId, authorName: actor.displayName || null, body: text, mentions, createdAt: now, updatedAt: now, editedAt: null, deletedAt: null, deletedBy: null, version: 1 };
    const replyTo = parent && !parent.authorId.equals(actor.userId) ? parent.authorId : null;
    await this.connection.withTransaction(async (session) => {
      await this.repos.comments.insert(doc, { session });
      await this.repos.activities.append(this.entry(actor, doc, "comment.created", { mentions: mentions.filter((m) => !m.equals(actor.userId)), replyTo, now }), { session });
    });
    return this.toApi(doc, actor, false);
  }

  async update(actor, { comment, record, board }, body) {
    this.writable(board, record);
    if (comment.deletedAt) throw new ApiError(404, "NOT_FOUND", "That update no longer exists.");
    if (!comment.authorId.equals(actor.userId)) throw new ApiError(403, "FORBIDDEN", "Only the author can edit this update.");
    if (!Number.isInteger(body.expectedVersion)) throw invalid("expectedVersion is required.");
    const text = cleanBody(body.body), mentions = await this.checkMentions(actor, record.workspaceId, body.mentions);
    const now = new Date(), before = new Set(comment.mentions.map((m) => m.toHexString()));
    let saved;
    await this.connection.withTransaction(async (session) => {
      saved = await this.repos.comments.updateVersioned(comment._id, body.expectedVersion, { body: text, mentions, updatedAt: now, editedAt: now }, { session });
      if (!saved) throw conflict("update", await this.repos.comments.findById(comment._id) || comment);
      // Only people newly mentioned by the edit are notified (no repeats).
      await this.repos.activities.append(this.entry(actor, saved, "comment.updated", { mentions: mentions.filter((m) => !before.has(m.toHexString()) && !m.equals(actor.userId)), now }), { session });
    });
    return this.toApi(saved, actor, false);
  }

  async remove(actor, { comment, record, board }) {
    this.writable(board, null);
    if (comment.deletedAt) return { deleted: true };
    const own = comment.authorId.equals(actor.userId);
    if (!own && !await this.isModerator(actor, record.workspaceId)) throw new ApiError(403, "FORBIDDEN", "Only the author or a workspace admin can delete this update.");
    const now = new Date();
    await this.connection.withTransaction(async (session) => {
      const saved = await this.repos.comments.updateVersioned(comment._id, comment.version, { body: "", mentions: [], deletedAt: now, deletedBy: actor.userId, updatedAt: now }, { session });
      if (!saved) throw conflict("update", await this.repos.comments.findById(comment._id) || comment);
      await this.repos.activities.append(this.entry(actor, saved, "comment.deleted", { now }), { session });
    });
    return { deleted: true };
  }

  entry(actor, doc, action, { mentions = [], replyTo = null, now }) {
    const changes = [];
    if (mentions.length) changes.push({ field: "mentions", from: null, to: mentions.map(userRef) });
    if (replyTo) changes.push({ field: "replyTo", from: null, to: userRef(replyTo) });
    const summary = { "comment.created": doc.parentId ? "Replied to an update" : "Posted an update", "comment.updated": "Edited an update", "comment.deleted": "Deleted an update" }[action];
    return activityEntry({ workspaceId: doc.workspaceId, boardId: doc.boardId, recordId: doc.recordId, actorUserId: actor.userId, actorName: actor.displayName, action, entityType: "comment", entityId: doc._id, changes, summary, now });
  }

  toApi(d, actor, moderator) {
    const own = d.authorId.equals(actor.userId), deleted = Boolean(d.deletedAt);
    return {
      id: d._id.toHexString(), recordId: d.recordId.toHexString(), parentId: d.parentId ? d.parentId.toHexString() : null,
      author: { id: userRef(d.authorId), name: d.authorName || "Unknown user", isYou: own },
      body: deleted ? "" : d.body, mentions: deleted ? [] : d.mentions.map(userRef), deleted,
      createdAt: d.createdAt.toISOString(), editedAt: d.editedAt ? d.editedAt.toISOString() : null, version: d.version,
      canEdit: own && !deleted, canDelete: !deleted && (own || moderator)
    };
  }
}

module.exports = { CommentService, cleanBody, MAX_BODY };
