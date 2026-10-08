// workspaces collection. A workspace is a team space; its boards and memberships are separate documents.
const { COLLECTIONS } = require("../../db/bootstrap");
const { VersionedRepository } = require("./base-repository");

const MAX_WORKSPACES = 1000;

class WorkspaceRepository extends VersionedRepository {
  constructor(db) { super(db.collection(COLLECTIONS.workspaces)); }

  // Workspaces are few (the frontend allows up to 1000), so they are listed in one bounded query.
  list() { return this.collection.find({}, { sort: { position: 1, _id: 1 }, limit: MAX_WORKSPACES }).toArray(); }

  async nextPosition({ session } = {}) {
    const last = await this.collection.findOne({}, { sort: { position: -1 }, projection: { position: 1 }, session });
    return (last?.position ?? 0) + 1000;
  }

  // Legacy (pre-MongoDB) IDs that already exist, for import duplicate detection.
  async existingLegacyIds(legacyIds, { session } = {}) {
    if (!legacyIds.length) return [];
    const found = await this.collection.find({ legacyId: { $in: legacyIds } }, { projection: { legacyId: 1 }, session }).toArray();
    return found.map((doc) => doc.legacyId);
  }
}

module.exports = { WorkspaceRepository, MAX_WORKSPACES };
