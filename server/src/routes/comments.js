// Record comments ("Updates"); see services/comment-service.js. Mounted after the session check (changes need CSRF).
//   GET    /records/:recordId/comments            the discussion (VIEWER)
//   POST   /records/:recordId/comments            { body, parentId?, mentions? } (MEMBER)
//   PATCH  /comments/:commentId                   { body, mentions?, expectedVersion } (the author, MEMBER)
//   DELETE /comments/:commentId                   the author, or a moderator
//   GET    /records/:recordId/mentionable         people who can be @mentioned (VIEWER)
//   GET    /boards/:boardId/comment-counts        { counts: { recordId: n } } (VIEWER)
// A comment is found through its record, so an ID from a board the caller can't see answers 404 like any other.
const express = require("express");
const { allowOnly, requireBody, parseId } = require("../validation/common");
const { sendError } = require("../middleware/errors");

const PER_WINDOW = 30, WINDOW_MS = 60000;
function commentLimiter({ perWindow = PER_WINDOW, windowMs = WINDOW_MS } = {}) {
  const hits = new Map();
  return (key) => {
    const now = Date.now(), list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= perWindow) { hits.set(key, list); return false; }
    list.push(now); hits.set(key, list); if (hits.size > 10000) hits.clear(); return true;
  };
}

function commentRoutes({ services, access, limiter = commentLimiter() }) {
  const router = express.Router();
  const comments = services.comments;
  comments.access = access;
  const send = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);
  const noQuery = (req) => allowOnly(req.query, [], "the query");
  const throttled = (req, res) => { if (limiter(req.actor.userId.toHexString())) return false; sendError(res, 429, "RATE_LIMITED", "You're posting very quickly. Wait a moment and try again."); return true; };
  async function forComment(req, minimum) {
    const comment = await comments.repos.comments.findById(parseId(req.params.commentId, "commentId"));
    if (!comment) return null;
    const { record, role } = await access.record(req.actor, comment.recordId, minimum).catch((error) => { if (error?.status === 404) return {}; throw error; });
    if (!record) return null;
    return { comment, record, role, board: await services.records.board(record.boardId) };
  }

  router.get("/records/:recordId/comments", async (req, res) => {
    const { record } = await access.record(req.actor, parseId(req.params.recordId, "recordId"), "VIEWER");
    noQuery(req);
    send(res, 200, { items: await comments.list(req.actor, record) });
  });
  router.get("/records/:recordId/mentionable", async (req, res) => {
    const { record } = await access.record(req.actor, parseId(req.params.recordId, "recordId"), "VIEWER");
    noQuery(req);
    const users = await comments.mentionable(req.actor, record.workspaceId);
    send(res, 200, { items: users.map((u) => ({ id: `user:${u._id.toHexString()}`, displayName: u.displayName || u.email || "Unnamed user", isYou: u._id.equals(req.actor.userId) })).sort((a, b) => a.displayName.localeCompare(b.displayName)) });
  });
  router.post("/records/:recordId/comments", async (req, res) => {
    const { record } = await access.record(req.actor, parseId(req.params.recordId, "recordId"), "MEMBER");
    noQuery(req);
    const body = requireBody(req.body); allowOnly(body, ["body", "parentId", "mentions"], "the update");
    if (throttled(req, res)) return;
    send(res, 201, { comment: await comments.create(req.actor, { record, board: await services.records.board(record.boardId) }, body) });
  });
  router.patch("/comments/:commentId", async (req, res) => {
    noQuery(req);
    const found = await forComment(req, "MEMBER");
    if (!found) return sendError(res, 404, "NOT_FOUND", "That update doesn't exist.");
    const body = requireBody(req.body); allowOnly(body, ["body", "mentions", "expectedVersion"], "the update");
    if (throttled(req, res)) return;
    send(res, 200, { comment: await comments.update(req.actor, found, body) });
  });
  router.delete("/comments/:commentId", async (req, res) => {
    noQuery(req);
    const found = await forComment(req, "VIEWER");
    if (!found) return sendError(res, 404, "NOT_FOUND", "That update doesn't exist.");
    // Authors need to be able to write here to remove their own words; moderators are checked by the service.
    if (found.comment.authorId.equals(req.actor.userId)) await access.record(req.actor, found.record._id, "MEMBER");
    send(res, 200, await comments.remove(req.actor, found));
  });
  router.get("/boards/:boardId/comment-counts", async (req, res) => {
    const { board } = await access.board(req.actor, parseId(req.params.boardId, "boardId"), "VIEWER");
    noQuery(req);
    send(res, 200, { counts: await comments.counts(board._id) });
  });
  return router;
}

module.exports = { commentRoutes, commentLimiter };
