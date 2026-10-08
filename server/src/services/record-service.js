// Records: always on an existing board, and always in that board's workspace (workspaceId is copied from the board,
// never taken from the request). Updates and deletes are version checked: a stale expectedVersion gets 409.
const { ObjectId } = require("mongodb");
const validate = require("../validation/resources");
const { applyVersionedUpdate } = require("../repositories/mongo/base-repository");
const { notFound, missingOrStale, activityEntry, appendActivity } = require("./shared");

class RecordService {
  constructor({ repos, logger }) { Object.assign(this, { repos, logger }); }

  async board(boardId) {
    const board = await this.repos.boards.findById(boardId);
    if (!board) throw notFound("board");
    return board;
  }

  async list(boardId, query) {
    const board = await this.board(boardId);
    const { limit, sort, filter, after } = validate.recordListQuery(query, board);
    const page = await this.repos.records.listPage(boardId, { sort, limit, after, filter });
    const last = page.items.at(-1);
    return { items: page.items, limit, nextCursor: page.hasMore ? validate.encodeCursor(sort, last[sort.field], last._id) : null };
  }

  async get(id) {
    const record = await this.repos.records.findById(id);
    if (!record) throw notFound("record");
    return record;
  }

  // If the board is deleted while the record is being written, the record is removed again (the board delete also
  // sweeps after committing), so a record never outlives its board.
  async create(boardId, raw, actor) {
    const board = await this.board(boardId);
    const input = validate.recordCreate(raw, board);
    const now = new Date();
    const doc = {
      _id: new ObjectId(), workspaceId: board.workspaceId, boardId, values: input.values, groupId: input.groupId,
      position: input.position ?? await this.repos.records.firstPosition(boardId), archived: input.archived, pinned: input.pinned,
      createdBy: actor.userId, updatedBy: actor.userId, createdAt: now, updatedAt: now, version: 1
    };
    await this.repos.records.insert(doc);
    if (!await this.repos.boards.findById(boardId)) {
      await this.repos.records.deleteVersioned(doc._id, 1);
      throw notFound("board");
    }
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: board.workspaceId, boardId, recordId: doc._id, actorUserId: actor.userId, action: "record.created", entityType: "record", entityId: doc._id, now }));
    return doc;
  }

  // Partial update: only the values sent are changed ($set on values.<column key>), with $inc on version, matched on
  // _id AND expectedVersion in one atomic operation.
  async update(id, raw, actor) {
    const record = await this.get(id);
    const board = await this.board(record.boardId);
    const { expectedVersion, change } = validate.recordPatch(raw, board);
    const now = new Date();
    const set = { updatedBy: actor.userId, updatedAt: now };
    for (const [key, value] of Object.entries(change.values || {})) set[`values.${key}`] = value; // validated column keys
    for (const field of ["groupId", "position", "archived", "pinned"]) if (change[field] !== undefined) set[field] = change[field];
    const before = await this.repos.records.updateVersioned(id, expectedVersion, set);
    if (!before) throw await missingOrStale(this.repos.records, id, "record");
    const after = applyVersionedUpdate(before, set);
    const changes = [
      ...Object.entries(change.values || {}).filter(([key, value]) => before.values[key] !== value).map(([key, value]) => ({ field: `values.${key}`, from: before.values[key] ?? null, to: value })),
      ...["groupId", "position", "archived", "pinned"].filter((f) => change[f] !== undefined && before[f] !== change[f]).map((f) => ({ field: f, from: before[f] ?? null, to: change[f] }))
    ];
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: record.workspaceId, boardId: record.boardId, recordId: id, actorUserId: actor.userId, action: "record.updated", entityType: "record", entityId: id, changes, now }));
    return after;
  }

  async delete(id, expectedVersion, actor) {
    const record = await this.get(id);
    if (!await this.repos.records.deleteVersioned(id, expectedVersion)) throw await missingOrStale(this.repos.records, id, "record");
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: record.workspaceId, boardId: record.boardId, recordId: id, actorUserId: actor.userId, action: "record.deleted", entityType: "record", entityId: id, summary: String(record.values?.serial ?? "").slice(0, 200), now: new Date() }));
  }
}

module.exports = { RecordService };
