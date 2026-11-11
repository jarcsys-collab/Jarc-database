// activities collection: an append-only history of changes. It is never the source of truth for workspaces, boards
// or records, and the API offers no way to update or delete entries.
const { COLLECTIONS } = require("../../db/bootstrap");

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class ActivityRepository {
  constructor(db) { this.collection = db.collection(COLLECTIONS.activities); }

  // loggedAt: when the entry was written (createdAt is when the change began; a long transaction can be seconds apart).
  // Live updates read by loggedAt, so a slow change can't fall behind the stream's read position.
  async append(entry, { session } = {}) { entry.loggedAt = new Date(); await this.collection.insertOne(entry, { session }); return entry; }

  async appendMany(entries, { session } = {}) { const at = new Date(); for (const e of entries) e.loggedAt = at; if (entries.length) await this.collection.insertMany(entries, { session }); return entries.length; }

  listByBoard(boardId, { limit = 50 } = {}) { return this.collection.find({ boardId }, { sort: { createdAt: -1, _id: -1 }, limit: Math.min(limit, 200) }).toArray(); }

  findById(id) { return this.collection.findOne({ _id: id }); }

  // Oldest first by when entries were written (older entries without loggedAt: by createdAt), for the live update
  // stream and its replay after a reconnect.
  listSince(since, { limit = 500 } = {}) {
    return this.collection.find({ $or: [{ loggedAt: { $gte: since } }, { loggedAt: { $exists: false }, createdAt: { $gte: since } }] }, { sort: { loggedAt: 1, createdAt: 1, _id: 1 }, limit: Math.min(limit, 2000) }).toArray();
  }

  // Newest first across several workspaces (null = all), for the notification feed. before: only entries older than
  // this date (paging).
  listRecent({ workspaceIds = null, limit = 50, before = null } = {}) {
    const filter = {};
    if (workspaceIds) filter.workspaceId = { $in: workspaceIds };
    if (before) filter.createdAt = { $lt: before };
    return this.collection.find(filter, { sort: { createdAt: -1, _id: -1 }, limit: Math.min(limit, 100) }).toArray();
  }

  // Activity History (administrators; Q1.4): newest first, filtered. Every value arrives validated (routes/system-health.js):
  // action and text filters are plain strings matched literally (escaped), dates are Dates, IDs are ObjectIds.
  //   before = { at: Date, id: ObjectId } continues after the last entry of the previous page.
  // Reads the "created" index backwards; maxTimeMS keeps a broad text filter on a large history from running long.
  search({ from = null, to = null, before = null, action = null, actionPrefix = null, actor = null, text = null, boardId = null, limit = 50 } = {}) {
    const and = [];
    const createdAt = {};
    if (from) createdAt.$gte = from;
    if (to) createdAt.$lte = to;
    if (Object.keys(createdAt).length) and.push({ createdAt });
    if (before) and.push({ $or: [{ createdAt: { $lt: before.at } }, { createdAt: before.at, _id: { $lt: before.id } }] });
    if (action) and.push({ action });
    else if (actionPrefix) and.push({ action: { $regex: `^${escapeRegex(actionPrefix)}` } });
    if (actor) and.push({ $or: [{ actorName: { $regex: escapeRegex(actor), $options: "i" } }, { legacyActor: { $regex: escapeRegex(actor), $options: "i" } }] });
    if (text) and.push({ $or: [{ summary: { $regex: escapeRegex(text), $options: "i" } }, { "changes.field": { $regex: escapeRegex(text), $options: "i" } }] });
    if (boardId) and.push({ boardId });
    return this.collection.find(and.length ? { $and: and } : {}, { sort: { createdAt: -1, _id: -1 }, limit: Math.min(Math.max(limit, 1), 100), maxTimeMS: 5000 }).toArray();
  }

  listByWorkspace(workspaceId, { limit = 50 } = {}) { return this.collection.find({ workspaceId }, { sort: { createdAt: -1 }, limit: Math.min(limit, 200) }).toArray(); }
}

module.exports = { ActivityRepository };
