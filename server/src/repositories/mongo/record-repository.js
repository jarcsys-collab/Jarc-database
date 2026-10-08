// records collection: one document per board row. Values live in `values`, keyed by stable column key.
const { COLLECTIONS } = require("../../db/bootstrap");
const { VersionedRepository, scopedId } = require("./base-repository");

// Only these fields can ever be sorted on; the API maps its allowlisted sort names onto them.
const SORTABLE = new Set(["position", "createdAt", "updatedAt"]);

class RecordRepository extends VersionedRepository {
  constructor(db) { super(db.collection(COLLECTIONS.records)); }

  // Cursor pagination on (sort field, _id): stable while other records are added or removed, and served by the
  // board_position / board_created / board_updated indexes. Fetches one extra document to know if more exist.
  async listPage(boardId, { sort, limit, after = null, filter = {} }) {
    if (!SORTABLE.has(sort.field)) throw new TypeError("Unsupported sort field.");
    const direction = sort.dir === "desc" ? -1 : 1;
    const query = { boardId };
    if (filter.groupId !== undefined) query.groupId = filter.groupId;
    if (filter.archived !== undefined) query.archived = filter.archived;
    if (filter.status) query[`values.${filter.status.key}`] = filter.status.value; // key is a validated column key
    if (after) {
      const beyond = direction === 1 ? "$gt" : "$lt";
      query.$or = [{ [sort.field]: { [beyond]: after.value } }, { [sort.field]: after.value, _id: { [beyond]: after.id } }];
    }
    const items = await this.collection.find(query, { sort: { [sort.field]: direction, _id: direction }, limit: limit + 1 }).toArray();
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  }

  // New records go first, like the frontend (which adds new rows to the top).
  async firstPosition(boardId) {
    const first = await this.collection.findOne({ boardId }, { sort: { position: 1 }, projection: { position: 1 } });
    return first ? first.position - 1000 : 0;
  }

  async countInGroups(boardId, groupIds) {
    if (!groupIds.length) return 0;
    return this.collection.countDocuments({ boardId, groupId: { $in: groupIds } });
  }

  async deleteByBoard(boardId, { session } = {}) {
    const { deletedCount } = await this.collection.deleteMany({ boardId: scopedId(boardId, "boardId") }, { session });
    return deletedCount;
  }

  async deleteByWorkspace(workspaceId, { session } = {}) {
    const { deletedCount } = await this.collection.deleteMany({ workspaceId: scopedId(workspaceId, "workspaceId") }, { session });
    return deletedCount;
  }
}

module.exports = { RecordRepository };
