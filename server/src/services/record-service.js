// Records: always on an existing board, and always in that board's workspace (workspaceId is copied from the board,
// never taken from the request). Updates and deletes are version checked: a stale expectedVersion gets 409.
const { ObjectId } = require("mongodb");
const validate = require("../validation/resources");
const { applyVersionedUpdate } = require("../repositories/mongo/base-repository");
const { notFound, missingOrStale, activityEntry, appendActivity } = require("./shared");
const { sameValue, valueList, USER_REF } = require("../domain/board-schema");

const { ApiError } = require("../middleware/errors");

class RecordService {
  constructor({ repos, connection, logger }) { Object.assign(this, { repos, connection, logger }); }

  // People cells may only name real, active JARC users ("user:<id>") who may be assigned in this workspace:
  // { everyone: true } (development_shared) → any active user; otherwise → the workspace's active members.
  // Anything else is refused before writing. Without a rule (internal callers), members only — the strict default.
  async checkPeople(board, valueSets, { everyone = false } = {}) {
    const keys = board.columns.filter((c) => c.type === "owner").map((c) => c.key);
    const refs = [...new Set(valueSets.flatMap((values) => keys.flatMap((k) => valueList(values?.[k]))).filter((v) => USER_REF.test(v)))];
    if (!refs.length) return;
    const users = await this.repos.users.findByIds(refs.map((r) => new ObjectId(r.slice(5))));
    let eligible = users.filter((u) => u.status === "active");
    if (!everyone) {
      const members = new Set((await this.repos.memberships.listByWorkspace(board.workspaceId)).filter((m) => m.status === "active").map((m) => m.userId.toHexString()));
      eligible = eligible.filter((u) => members.has(u._id.toHexString()));
    }
    const active = new Set(eligible.map((u) => `user:${u._id.toHexString()}`));
    const unknown = refs.filter((r) => !active.has(r));
    if (unknown.length) throw new ApiError(400, "VALIDATION_ERROR", "A People value names someone who can't be assigned in this workspace.", { unknown: unknown.length });
  }

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

  async exists(id) { return Boolean(await this.repos.records.findById(id)); }

  async get(id) {
    const record = await this.repos.records.findById(id);
    if (!record) throw notFound("record");
    return record;
  }

  // If the board is deleted while the record is being written, the record is removed again (the board delete also
  // sweeps after committing), so a record never outlives its board.
  async create(boardId, raw, actor, people) {
    const board = await this.board(boardId);
    const input = validate.recordCreate(raw, board);
    await this.checkPeople(board, [input.values], people);
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
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: board.workspaceId, boardId, recordId: doc._id, actorUserId: actor.userId, actorName: actor.displayName, action: "record.created", entityType: "record", entityId: doc._id, now }));
    return doc;
  }

  // Partial update: only the values sent are changed ($set on values.<column key>), with $inc on version, matched on
  // _id AND expectedVersion in one atomic operation.
  async update(id, raw, actor, people) {
    const record = await this.get(id);
    const board = await this.board(record.boardId);
    const { expectedVersion, change } = validate.recordPatch(raw, board);
    await this.checkPeople(board, [change.values], people);
    const now = new Date();
    const set = { updatedBy: actor.userId, updatedAt: now };
    for (const [key, value] of Object.entries(change.values || {})) set[`values.${key}`] = value; // validated column keys
    for (const field of ["groupId", "position", "archived", "pinned"]) if (change[field] !== undefined) set[field] = change[field];
    const before = await this.repos.records.updateVersioned(id, expectedVersion, set);
    if (!before) throw await missingOrStale(this.repos.records, id, "record");
    const after = applyVersionedUpdate(before, set);
    const changes = [
      ...Object.entries(change.values || {}).filter(([key, value]) => !sameValue(before.values[key], value)).map(([key, value]) => ({ field: `values.${key}`, from: before.values[key] ?? null, to: value })),
      ...["groupId", "position", "archived", "pinned"].filter((f) => change[f] !== undefined && before[f] !== change[f]).map((f) => ({ field: f, from: before[f] ?? null, to: change[f] }))
    ];
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: record.workspaceId, boardId: record.boardId, recordId: id, actorUserId: actor.userId, actorName: actor.displayName, action: "record.updated", entityType: "record", entityId: id, changes, now }));
    return after;
  }

  async delete(id, expectedVersion, actor) {
    const record = await this.get(id);
    if (!await this.repos.records.deleteVersioned(id, expectedVersion)) throw await missingOrStale(this.repos.records, id, "record");
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: record.workspaceId, boardId: record.boardId, recordId: id, actorUserId: actor.userId, actorName: actor.displayName, action: "record.deleted", entityType: "record", entityId: id, summary: String(record.values?.serial ?? "").slice(0, 200), now: new Date() }));
  }
}

// ---- Batch operations (Stage 11): CSV import, bulk edits, multi-delete, reorders and undo. Each batch is ONE
// transaction: every record is validated first, versions are checked for all of them, and either everything is
// written or nothing is. A stale version anywhere → 409 CONFLICT listing the records.
RecordService.prototype.createMany = async function createMany(boardId, raw, actor, people) {
  const board = await this.board(boardId);
  const inputs = validate.recordBatchCreate(raw, board);
  await this.checkPeople(board, inputs.map((i) => i.values), people);
  const now = new Date();
  let next = await this.repos.records.firstPosition(boardId) - 1000 * (inputs.length + 1);
  const docs = inputs.map((input) => ({
    _id: new ObjectId(), workspaceId: board.workspaceId, boardId, values: input.values, groupId: input.groupId,
    position: input.position ?? (next += 1000), archived: input.archived, pinned: input.pinned,
    createdBy: actor.userId, updatedBy: actor.userId, createdAt: now, updatedAt: now, version: 1
  }));
  await this.connection.withTransaction(async (session) => {
    await this.repos.records.insertMany(docs, { session });
    await this.repos.activities.append(activityEntry({ workspaceId: board.workspaceId, boardId, actorUserId: actor.userId, actorName: actor.displayName, action: "records.created", entityType: "board", entityId: boardId, summary: `Added ${docs.length} records`, now }), { session });
  });
  if (!await this.repos.boards.findById(boardId)) { await this.repos.records.deleteByBoard(boardId); throw notFound("board"); }
  return docs;
};

// Checks that every listed record exists on this board with the expected version. Missing records → 404 (or are
// skipped for deletes); stale versions → 409 with each record's current version.
async function checkVersions(repos, boardId, items, { session, skipMissing = false }) {
  const found = new Map((await repos.records.findManyInBoard(boardId, items.map((i) => i.id), { session })).map((r) => [r._id.toHexString(), r]));
  const missing = items.filter((i) => !found.has(i.id.toHexString()));
  if (missing.length && !skipMissing) throw new ApiError(404, "NOT_FOUND", `${missing.length} record(s) no longer exist.`, { missing: missing.map((i) => i.id.toHexString()) });
  const stale = items.filter((i) => found.has(i.id.toHexString()) && found.get(i.id.toHexString()).version !== i.expectedVersion);
  if (stale.length) throw new ApiError(409, "CONFLICT", "Some records were changed by someone else. Reload them and try again.", { conflicts: stale.map((i) => ({ id: i.id.toHexString(), currentVersion: found.get(i.id.toHexString()).version })) });
  return found;
}

RecordService.prototype.updateMany = async function updateMany(boardId, raw, actor, people) {
  const board = await this.board(boardId);
  const items = validate.recordBatchUpdate(raw, board);
  await this.checkPeople(board, items.map((i) => i.change.values), people);
  const now = new Date();
  return this.connection.withTransaction(async (session) => {
    const found = await checkVersions(this.repos, boardId, items, { session });
    const entries = [];
    const updates = items.map(({ id, expectedVersion, change }) => {
      const before = found.get(id.toHexString());
      const set = { updatedBy: actor.userId, updatedAt: now };
      for (const [key, value] of Object.entries(change.values || {})) set[`values.${key}`] = value; // validated column keys
      for (const field of ["groupId", "position", "archived", "pinned"]) if (change[field] !== undefined) set[field] = change[field];
      const changes = [
        ...Object.entries(change.values || {}).filter(([k, v]) => !sameValue(before.values[k], v)).map(([k, v]) => ({ field: `values.${k}`, from: before.values[k] ?? null, to: v })),
        ...["groupId", "archived", "pinned"].filter((f) => change[f] !== undefined && before[f] !== change[f]).map((f) => ({ field: f, from: before[f] ?? null, to: change[f] }))
      ];
      if (changes.length) entries.push(activityEntry({ workspaceId: board.workspaceId, boardId, recordId: id, actorUserId: actor.userId, actorName: actor.displayName, action: "record.updated", entityType: "record", entityId: id, changes, now }));
      return { filter: { _id: id, boardId, version: expectedVersion }, update: { $set: set, $inc: { version: 1 } } };
    });
    const matched = await this.repos.records.bulkUpdate(updates, { session });
    if (matched !== items.length) throw new ApiError(409, "CONFLICT", "Some records were changed by someone else. Reload them and try again.");
    await this.repos.activities.appendMany(entries, { session });
    const after = new Map((await this.repos.records.findManyInBoard(boardId, items.map((i) => i.id), { session })).map((r) => [r._id.toHexString(), r]));
    return items.map((i) => after.get(i.id.toHexString()));
  });
};

// Records that are already gone are skipped, so repeating a delete is safe.
RecordService.prototype.deleteMany = async function deleteMany(boardId, raw, actor) {
  const board = await this.board(boardId);
  const items = validate.recordBatchDelete(raw);
  const now = new Date();
  return this.connection.withTransaction(async (session) => {
    const found = await checkVersions(this.repos, boardId, items, { session, skipMissing: true });
    const present = items.filter((i) => found.has(i.id.toHexString()));
    const deleted = await this.repos.records.bulkDelete(present.map((i) => ({ _id: i.id, boardId, version: i.expectedVersion })), { session });
    if (deleted !== present.length) throw new ApiError(409, "CONFLICT", "Some records were changed by someone else. Reload them and try again.");
    await this.repos.activities.appendMany(present.map((i) => activityEntry({ workspaceId: board.workspaceId, boardId, recordId: i.id, actorUserId: actor.userId, actorName: actor.displayName, action: "record.deleted", entityType: "record", entityId: i.id, summary: String(found.get(i.id.toHexString()).values?.serial ?? "").slice(0, 200), now })), { session });
    return { deleted, alreadyDeleted: items.length - present.length };
  });
};

module.exports = { RecordService };
