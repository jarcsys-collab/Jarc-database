// boards collection. A board holds its bounded configuration (columns, groups, saved views); records are separate.
const { COLLECTIONS } = require("../../db/bootstrap");
const { VersionedRepository, scopedId } = require("./base-repository");
const { allocateBoardPublicId } = require("../../domain/board-public-id");

const MAX_BOARDS_PER_WORKSPACE = 1000;

class BoardRepository extends VersionedRepository {
  constructor(db) { super(db.collection(COLLECTIONS.boards)); this.db = db; }

  // Every new board gets its public number here, however it is created (the app, the monday.com integration, an import):
  // allocated before the board is written and outside any transaction, so an aborted creation only leaves a gap.
  async insert(doc, options) { await this.assignPublicIds([doc]); return super.insert(doc, options); }
  async insertMany(docs, options) { await this.assignPublicIds(docs); return super.insertMany(docs, options); }
  async assignPublicIds(docs) { for (const doc of docs) if (doc.publicId === undefined) doc.publicId = await allocateBoardPublicId(this.db); }

  // Global search: the non-archived boards of the given workspaces (null = all), only the fields search needs.
  // withNames (Command Center): also the name, icon and read-only source, to show and open board results.
  listForSearch(workspaceIds, { limit, withNames = false }) {
    const projection = { _id: 1, workspaceId: 1, columns: 1, ...(withNames ? { name: 1, icon: 1, "source.readOnly": 1 } : {}) };
    return this.collection.find({ archived: false, ...(workspaceIds ? { workspaceId: { $in: workspaceIds } } : {}) }, { sort: { workspaceId: 1, position: 1, _id: 1 }, limit, projection }).toArray();
  }

  listByWorkspace(workspaceId) {
    return this.collection.find({ workspaceId }, { sort: { position: 1, _id: 1 }, limit: MAX_BOARDS_PER_WORKSPACE }).toArray();
  }

  // The given boards, if they are in this workspace, in board order.
  findManyInWorkspace(workspaceId, ids) {
    return this.collection.find({ workspaceId, _id: { $in: ids } }, { sort: { position: 1, _id: 1 }, limit: ids.length }).toArray();
  }

  // API tokens: boards by ID, wherever they are, with only what a token's scope needs (never the columns or views), in board
  // order. Missing IDs are simply absent: the caller compares the counts.
  findSummariesByIds(ids) {
    if (!ids.length) return Promise.resolve([]);
    return this.collection.find({ _id: { $in: ids } }, { sort: { workspaceId: 1, position: 1, _id: 1 }, limit: ids.length, projection: { _id: 1, workspaceId: 1, name: 1, archived: 1, position: 1 } }).toArray();
  }
  // Employee Management P2 (employees/jarc-access.js, read-only): every board in one bounded query, only ID, workspace, name,
  // public number, archived and whether it is a read-only synchronized board (never the columns or views).
  listForAccessIndex() {
    return this.collection.find({}, { sort: { workspaceId: 1, position: 1, _id: 1 }, limit: 5000, projection: { _id: 1, workspaceId: 1, name: 1, publicId: 1, archived: 1, "source.readOnly": 1 } }).toArray();
  }
  // API tokens: a workspace's boards as a list to choose from (ID, name, archived), without each board's configuration.
  listSummariesByWorkspace(workspaceId) {
    return this.collection.find({ workspaceId }, { sort: { position: 1, _id: 1 }, limit: MAX_BOARDS_PER_WORKSPACE, projection: { _id: 1, workspaceId: 1, name: 1, archived: 1, position: 1 } }).toArray();
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
