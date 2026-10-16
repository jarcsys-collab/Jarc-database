// boards collection. A board holds its bounded configuration (columns, groups, saved views); records are separate.
const { COLLECTIONS } = require("../../db/bootstrap");
const { VersionedRepository, scopedId } = require("./base-repository");

const MAX_BOARDS_PER_WORKSPACE = 1000;

class BoardRepository extends VersionedRepository {
  constructor(db) { super(db.collection(COLLECTIONS.boards)); }

  // Global search: the non-archived boards of the given workspaces (null = all), only the fields search needs.
  // withNames (Command Center): also the name, icon and read-only source, to show and open board results.
  listForSearch(workspaceIds, { limit, withNames = false }) {
    const projection = { _id: 1, workspaceId: 1, columns: 1, ...(withNames ? { name: 1, icon: 1, "source.readOnly": 1 } : {}) };
    return this.collection.find({ archived: false, ...(workspaceIds ? { workspaceId: { $in: workspaceIds } } : {}) }, { sort: { workspaceId: 1, position: 1, _id: 1 }, limit, projection }).toArray();
  }

  listByWorkspace(workspaceId) {
    return this.collection.find({ workspaceId }, { sort: { position: 1, _id: 1 }, limit: MAX_BOARDS_PER_WORKSPACE }).toArray();
  }

  async nextPosition(workspaceId, { session } = {}) {
    const last = await this.collection.findOne({ workspaceId }, { sort: { position: -1 }, projection: { position: 1 }, session });
    return (last?.position ?? 0) + 1000;
  }

  async countByWorkspace(workspaceId, { session } = {}) { return this.collection.countDocuments({ workspaceId }, { session }); }

  async deleteByWorkspace(workspaceId, { session } = {}) {
    const { deletedCount } = await this.collection.deleteMany({ workspaceId: scopedId(workspaceId, "workspaceId") }, { session });
    return deletedCount;
  }
}

module.exports = { BoardRepository, MAX_BOARDS_PER_WORKSPACE };
