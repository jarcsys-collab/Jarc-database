// activities collection: an append-only history of changes. It is never the source of truth for workspaces, boards
// or records, and the API offers no way to update or delete entries.
const { COLLECTIONS } = require("../../db/bootstrap");

class ActivityRepository {
  constructor(db) { this.collection = db.collection(COLLECTIONS.activities); }

  async append(entry, { session } = {}) { await this.collection.insertOne(entry, { session }); return entry; }

  async appendMany(entries, { session } = {}) { if (entries.length) await this.collection.insertMany(entries, { session }); return entries.length; }

  listByWorkspace(workspaceId, { limit = 50 } = {}) { return this.collection.find({ workspaceId }, { sort: { createdAt: -1 }, limit: Math.min(limit, 200) }).toArray(); }
}

module.exports = { ActivityRepository };
