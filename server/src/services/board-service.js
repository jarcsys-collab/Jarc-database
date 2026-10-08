// Boards: always inside an existing workspace. Columns, groups and saved views are embedded; records are not.
const { ObjectId } = require("mongodb");
const validate = require("../validation/resources");
const { normalizeColumns, normalizeGroups, BLANK_BOARD_COLUMNS, LEGACY_DEFAULT_GROUPS } = require("../domain/board-schema");
const { ApiError } = require("../middleware/errors");
const { notFound, conflict, missingOrStale, activityEntry, appendActivity, fieldChanges, sweepAfterCommit } = require("./shared");

class BoardService {
  constructor({ repos, connection, logger }) { Object.assign(this, { repos, connection, logger }); }

  // Board summaries carry recordCount (active records), so lists can show counts without loading records.
  async listByWorkspace(workspaceId) {
    if (!await this.repos.workspaces.findById(workspaceId)) throw notFound("workspace");
    const boards = await this.repos.boards.listByWorkspace(workspaceId);
    return Promise.all(boards.map(async (board) => ({ ...board, recordCount: await this.repos.records.countActive(board._id) })));
  }

  // Board history, newest first. Read-only: the API offers no way to write activity.
  async activity(boardId, query) {
    const { limit } = validate.activityQuery(query);
    await this.get(boardId);
    return this.repos.activities.listByBoard(boardId, { limit });
  }

  async get(id) {
    const board = await this.repos.boards.findById(id);
    if (!board) throw notFound("board");
    return board;
  }

  // The workspace ID comes from the URL and is checked against the database; a board is never created for a
  // workspace that doesn't exist. If the workspace is deleted while the board is being written, the board is
  // removed again (the workspace delete also sweeps after committing), so no orphan board remains.
  async create(workspaceId, raw, actor) {
    const now = new Date();
    const input = validate.boardCreate(raw, { actorId: actor.userId, now });
    if (!await this.repos.workspaces.findById(workspaceId)) throw notFound("workspace");
    const doc = {
      _id: new ObjectId(), workspaceId, name: input.name, description: input.description, icon: input.icon, archived: input.archived,
      position: input.position ?? await this.repos.boards.nextPosition(workspaceId), manualOrder: input.manualOrder,
      columns: input.columns ?? normalizeColumns(BLANK_BOARD_COLUMNS), groups: input.groups ?? normalizeGroups(LEGACY_DEFAULT_GROUPS.map((name) => ({ name }))),
      savedViews: input.savedViews ?? [], createdBy: actor.userId, createdAt: now, updatedAt: now, version: 1
    };
    await this.repos.boards.insert(doc);
    if (!await this.repos.workspaces.findById(workspaceId)) {
      await this.repos.boards.deleteVersioned(doc._id, 1);
      throw notFound("workspace");
    }
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId, boardId: doc._id, actorUserId: actor.userId, action: "board.created", entityType: "board", entityId: doc._id, summary: `Created board ${doc.name}`, now }));
    return doc;
  }

  // Groups that still contain records can't be removed (records would point at a missing group).
  async update(id, raw, actor) {
    const board = await this.get(id);
    const now = new Date();
    const { expectedVersion, set, removedGroupIds } = validate.boardPatch(raw, board, { actorId: actor.userId, now });
    if (board.version !== expectedVersion) throw conflict("board", board);
    if (removedGroupIds.length) {
      const inUse = await this.repos.records.countInGroups(id, removedGroupIds);
      if (inUse) throw new ApiError(400, "VALIDATION_ERROR", `${inUse} record${inUse === 1 ? " is" : "s are"} still in a group you removed. Move ${inUse === 1 ? "it" : "them"} to another group first.`);
    }
    const before = await this.repos.boards.updateVersioned(id, expectedVersion, { ...set, updatedAt: now });
    if (!before) throw await missingOrStale(this.repos.boards, id, "board");
    const after = { ...before, ...set, updatedAt: now, version: before.version + 1 };
    const changed = fieldChanges(before, after, Object.keys(set)).map((c) => (["columns", "groups", "savedViews"].includes(c.field) ? { field: c.field } : c));
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: board.workspaceId, boardId: id, actorUserId: actor.userId, action: "board.updated", entityType: "board", entityId: id, changes: changed, now }));
    return after;
  }

  // DELETE policy: cascade. One transaction removes the board's records (deleteMany scoped to this board's ObjectId)
  // and the board, if its version still matches; a scoped sweep after the commit catches records created meanwhile.
  // Activity history stays as the audit trail, plus one "board.deleted" entry.
  async delete(id, expectedVersion, actor) {
    const now = new Date();
    const removed = await this.connection.withTransaction(async (session) => {
      const board = await this.repos.boards.findById(id, { session });
      if (!board) throw notFound("board");
      if (board.version !== expectedVersion) throw conflict("board", board);
      const records = await this.repos.records.deleteByBoard(id, { session });
      if (!await this.repos.boards.deleteVersioned(id, expectedVersion, { session })) throw conflict("board", board);
      await this.repos.activities.append(activityEntry({ workspaceId: board.workspaceId, boardId: id, actorUserId: actor.userId, action: "board.deleted", entityType: "board", entityId: id, summary: `Deleted board ${board.name} with ${records} records`, now }), { session });
      return { records };
    });
    removed.records += await sweepAfterCommit(this.logger, "board records", () => this.repos.records.deleteByBoard(id));
    return removed;
  }
}

module.exports = { BoardService };
