// P4-0 (F10): workspace / board move consistency. A record's workspace is its BOARD's: authorization never trusts the record's
// copied workspaceId; a board move aligns the copies (records, attachments, comments) in bounded, idempotent, resumable batches;
// record writers re-read the board after writing so a concurrent move can't leave stale copies. Synthetic data on the in-memory
// FakeMongoClient (no network, no real data).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { FakeMongoClient } = require("./support/fake-mongo");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { Access } = require("../src/auth/access");
const { alignBoardWorkspace, settleRecords } = require("../src/services/board-workspace-sync");
const { recordToExternal } = require("../src/routes/external-api");
const { detectDrift } = require("../scripts/board-workspace-drift");
const { startMongoApp, api } = require("./helpers");

const silent = { info() {}, warn() {}, error() {}, log() {} };

async function world() {
  const fake = new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const dl = createDataLayer({ connection, logger: silent, fileStore: new MemoryFileStore(), environment: "test" });
  const warnings = [];
  const access = new Access(dl.repos, { policy: "role_based", logger: { warn: (m) => warnings.push(m) } });
  const db = connection.db;
  const person = async (name) => { const doc = { _id: new ObjectId(), tenantId: "t", source: "entra", status: "active", displayName: name, createdAt: new Date() }; await db.collection("users").insertOne(doc); return { userId: doc._id, kind: "entra", isSystemAdmin: false, displayName: name }; };
  const admin = await person("Synthetic Admin");
  const wsA = await dl.services.workspaces.create({ name: "Synthetic A" }, admin);
  const wsB = await dl.services.workspaces.create({ name: "Synthetic B" }, admin);
  const board = await dl.services.boards.create(wsA._id, { name: "Synthetic board" }, admin);
  const member = async (name, ws, role = "MEMBER") => { const a = await person(name); await dl.repos.memberships.add({ workspaceId: ws._id, userId: a.userId, role, now: new Date() }); return a; };
  return { fake, db, dl, access, warnings, admin, wsA, wsB, board, member, repos: dl.repos, services: dl.services };
}
const col = (w, name) => w.db.collection(name);
const wsOf = async (w, name, id) => (await col(w, name).findOne({ _id: id })).workspaceId;
const addRecords = async (w, n, boardId = w.board._id) => { const out = []; for (let i = 0; i < n; i += 1) out.push(await w.services.records.create(boardId, { values: { serial: `R${i}` } }, w.admin)); return out; };
const sideDocs = async (w, record, workspaceId) => {
  const base = { _id: new ObjectId(), workspaceId, boardId: record.boardId, recordId: record._id, createdAt: new Date() };
  await col(w, "attachments").insertOne({ ...base, columnKey: "docs", name: "synthetic.pdf", type: "application/pdf", size: 1, status: "ready" });
  await col(w, "comments").insertOne({ ...base, _id: new ObjectId(), parentId: null, authorId: w.admin.userId, body: "synthetic", mentions: [], deletedAt: null, version: 1 });
};

describe("authorization follows the board, never the record's copy", () => {
  test("a record with a stale workspaceId: 404 for old-workspace members, allowed for the board's workspace", async () => {
    const w = await world();
    const [record] = await addRecords(w, 1);
    // The board is in B now, the record still says A (a move that didn't finish aligning).
    await col(w, "boards").updateOne({ _id: w.board._id }, { $set: { workspaceId: w.wsB._id } });
    assert.ok((await wsOf(w, "records", record._id)).equals(w.wsA._id));
    const oldMember = await w.member("Old member", w.wsA, "WORKSPACE_ADMIN"), newViewer = await w.member("New viewer", w.wsB, "VIEWER");
    await assert.rejects(w.access.record(oldMember, record._id, "VIEWER"), (e) => e.status === 404);
    await assert.rejects(w.access.record(oldMember, record._id, "MEMBER"), (e) => e.status === 404);
    const seen = await w.access.record(newViewer, record._id, "VIEWER");
    assert.equal(seen.role, "VIEWER");
    assert.ok(seen.record.workspaceId.equals(w.wsB._id), "the record comes back with the board's workspace");
    await assert.rejects(w.access.record(newViewer, record._id, "MEMBER"), (e) => e.status === 403, "the role comes from the board's workspace too");
    await w.access.record(newViewer, record._id, "VIEWER");
    assert.equal(w.access.drift.count, 5, "every read of the drifted record is counted, refused or not");
    assert.equal(w.warnings.length, 1, "drift is logged once per board");
    assert.doesNotMatch(w.warnings[0], /R0|Synthetic/, "the log names no record content");
  });

  test("a consistent record: no drift noted, one projected board read", async () => {
    const w = await world();
    const [record] = await addRecords(w, 1);
    const m = await w.member("Member", w.wsA);
    const boards = w.fake.dbs.get("jarc_database").collections.get("boards");
    const before = boards.calls.length;
    const { record: seen } = await w.access.record(m, record._id, "MEMBER");
    assert.ok(seen.workspaceId.equals(w.wsA._id)); assert.equal(w.access.drift.count, 0);
    const reads = boards.calls.slice(before).filter((c) => c.op === "findOne");
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0].options.projection, { _id: 1, workspaceId: 1 });
  });

  test("a record whose board is gone does not exist", async () => {
    const w = await world();
    const [record] = await addRecords(w, 1);
    await col(w, "boards").deleteOne({ _id: w.board._id });
    const m = await w.member("Member", w.wsA);
    await assert.rejects(w.access.record(m, record._id, "VIEWER"), (e) => e.status === 404);
  });

  test("attachments and comments (authorized through their record) follow the board", async () => {
    const w = await world();
    const [record] = await addRecords(w, 1);
    await sideDocs(w, record, w.wsA._id);
    await col(w, "boards").updateOne({ _id: w.board._id }, { $set: { workspaceId: w.wsB._id } });
    const att = await col(w, "attachments").findOne({ recordId: record._id }), com = await col(w, "comments").findOne({ recordId: record._id });
    const oldMember = await w.member("Old member", w.wsA), newMember = await w.member("New member", w.wsB);
    // files.js and comments.js authorize attachment.recordId / comment.recordId with access.record.
    for (const ref of [att.recordId, com.recordId]) {
      await assert.rejects(w.access.record(oldMember, ref, "VIEWER"), (e) => e.status === 404);
      assert.equal((await w.access.record(newMember, ref, "VIEWER")).role, "MEMBER");
    }
    // A comment written through the corrected record carries the board's workspace (and so does its activity entry).
    w.services.comments.access = w.access;
    const { record: seen } = await w.access.record(newMember, record._id, "MEMBER");
    const created = await w.services.comments.create(newMember, { record: seen, board: await w.services.records.board(record.boardId) }, { body: "synthetic reply" });
    assert.ok((await wsOf(w, "comments", new ObjectId(created.id))).equals(w.wsB._id));
    const entry = await col(w, "activities").findOne({ entityId: new ObjectId(created.id) });
    assert.ok(entry.workspaceId.equals(w.wsB._id));
  });

  test("record update and delete activity entries go to the board's workspace, not the stale copy", async () => {
    const w = await world();
    const [a, b] = await addRecords(w, 2);
    await col(w, "boards").updateOne({ _id: w.board._id }, { $set: { workspaceId: w.wsB._id } });
    const updated = await w.services.records.update(a._id, { expectedVersion: 1, values: { serial: "changed" } }, w.admin);
    assert.ok(updated.workspaceId.equals(w.wsB._id));
    await w.services.records.delete(b._id, 1, w.admin);
    for (const action of ["record.updated", "record.deleted"]) assert.ok((await col(w, "activities").findOne({ action })).workspaceId.equals(w.wsB._id), action);
  });

  test("the token API reports the board's workspace for a record", () => {
    const wsB = new ObjectId(), wsA = new ObjectId(), boardId = new ObjectId();
    const out = recordToExternal({ _id: new ObjectId(), workspaceId: wsA, boardId, values: {}, createdAt: new Date(), updatedAt: new Date(), version: 1 }, { _id: boardId, workspaceId: wsB, columns: [] }, []);
    assert.equal(out.workspaceId, wsB.toHexString());
  });
});

describe("board move: bounded, idempotent, resumable alignment", () => {
  test("moving aligns records, attachments and comments outside the move's transaction", async () => {
    const w = await world();
    const records = await addRecords(w, 4);
    await sideDocs(w, records[0], w.wsA._id);
    const txBefore = w.fake.transactionsRun;
    const result = await w.services.schema.moveBoard(w.board._id, { expectedVersion: 1, workspaceId: w.wsB._id.toHexString() }, w.admin);
    assert.equal(w.fake.transactionsRun - txBefore, 1, "one small transaction: the board and its activity entry");
    assert.equal(result.records, 4); assert.equal(result.aligned, true);
    for (const name of ["records", "attachments", "comments"]) assert.equal(await col(w, name).countDocuments({ boardId: w.board._id, workspaceId: { $ne: w.wsB._id } }), 0, name);
    assert.deepEqual((await detectDrift(w.db)).drifted, []);
  });

  test("batches are bounded; an interrupted alignment resumes and a repeat changes nothing", async () => {
    const w = await world();
    await addRecords(w, 7);
    await col(w, "boards").updateOne({ _id: w.board._id }, { $set: { workspaceId: w.wsB._id } });
    const records = w.fake.dbs.get("jarc_database").collections.get("records");
    const mark = records.calls.length;
    w.fake.failNext({ collection: "records", op: "updateMany", skip: 1, error: new Error("synthetic interruption") });
    await assert.rejects(alignBoardWorkspace(w.repos, w.board._id, { from: w.wsA._id, batch: 3 }), /synthetic interruption/);
    const finds = records.calls.slice(mark).filter((c) => c.op === "find");
    assert.ok(finds.length >= 1 && finds.every((c) => c.options.limit === 3), "every read is bounded by the batch size");
    assert.equal(await col(w, "records").countDocuments({ boardId: w.board._id, workspaceId: w.wsB._id }), 3, "the first batch stayed");
    const resumed = await alignBoardWorkspace(w.repos, w.board._id, { from: w.wsA._id, batch: 3 });
    assert.equal(resumed.records, 4);
    assert.equal(await col(w, "records").countDocuments({ boardId: w.board._id, workspaceId: { $ne: w.wsB._id } }), 0);
    const again = await alignBoardWorkspace(w.repos, w.board._id, { batch: 3 });
    assert.deepEqual([again.records, again.attachments, again.comments], [0, 0, 0], "idempotent");
  });

  test("a failed alignment never fails the move; reconcileWorkspace finishes it; any other stale value is swept too", async () => {
    const w = await world();
    const recs = await addRecords(w, 3);
    const elsewhere = new ObjectId();
    await col(w, "records").updateOne({ _id: recs[2]._id }, { $set: { workspaceId: elsewhere } }); // drift from some older event
    w.fake.failNext({ collection: "records", op: "updateMany", error: new Error("synthetic outage") });
    const result = await w.services.schema.moveBoard(w.board._id, { expectedVersion: 1, workspaceId: w.wsB._id.toHexString() }, w.admin);
    assert.equal(result.aligned, false);
    assert.ok((await col(w, "boards").findOne({ _id: w.board._id })).workspaceId.equals(w.wsB._id), "the move stands");
    const drift = await detectDrift(w.db);
    assert.equal(drift.totals.records, 3);
    const fixed = await w.services.schema.reconcileWorkspace(w.board._id);
    assert.equal(fixed.records, 3);
    assert.equal((await detectDrift(w.db)).drifted.length, 0);
  });

  test("two moves in a row: an alignment that read the earlier workspace ends on the board's final one", async () => {
    const w = await world();
    const wsC = await w.services.workspaces.create({ name: "Synthetic C" }, w.admin);
    await addRecords(w, 5);
    await col(w, "boards").updateOne({ _id: w.board._id }, { $set: { workspaceId: wsC._id } });
    // The first alignment (for the move to B) still sees B on its first read; the board is in C by the time it checks again.
    const real = w.repos.boards.workspaceOf.bind(w.repos.boards);
    let first = true;
    w.repos.boards.workspaceOf = async (id) => { if (first) { first = false; return { _id: id, workspaceId: w.wsB._id }; } return real(id); };
    await alignBoardWorkspace(w.repos, w.board._id, { batch: 2 });
    w.repos.boards.workspaceOf = real;
    assert.equal(await col(w, "records").countDocuments({ boardId: w.board._id, workspaceId: { $ne: wsC._id } }), 0);
  });
});

describe("concurrent move and create", () => {
  test("the move commits between the create's board read and its insert: the record follows the board", async () => {
    const w = await world();
    const insert = w.repos.records.insert.bind(w.repos.records);
    w.repos.records.insert = async (doc, o) => {
      w.repos.records.insert = insert;
      await w.services.schema.moveBoard(w.board._id, { expectedVersion: 1, workspaceId: w.wsB._id.toHexString() }, w.admin);
      return insert(doc, o); // still carries A, read before the move
    };
    const doc = await w.services.records.create(w.board._id, { values: { serial: "racing" } }, w.admin);
    assert.ok(doc.workspaceId.equals(w.wsB._id));
    assert.ok((await wsOf(w, "records", doc._id)).equals(w.wsB._id));
    assert.ok((await col(w, "activities").findOne({ action: "record.created", recordId: doc._id })).workspaceId.equals(w.wsB._id));
  });

  test("the move commits right after the insert: its alignment finds the record", async () => {
    const w = await world();
    const insert = w.repos.records.insert.bind(w.repos.records);
    w.repos.records.insert = async (doc, o) => {
      w.repos.records.insert = insert;
      const out = await insert(doc, o);
      await w.services.schema.moveBoard(w.board._id, { expectedVersion: 1, workspaceId: w.wsB._id.toHexString() }, w.admin);
      return out;
    };
    const doc = await w.services.records.create(w.board._id, { values: { serial: "racing" } }, w.admin);
    assert.ok((await wsOf(w, "records", doc._id)).equals(w.wsB._id));
    assert.ok(doc.workspaceId.equals(w.wsB._id));
  });

  test("a batch create racing a move ends consistent", async () => {
    const w = await world();
    const insertMany = w.repos.records.insertMany.bind(w.repos.records);
    w.repos.records.insertMany = async (docs, o) => {
      w.repos.records.insertMany = insertMany;
      const out = await insertMany(docs, o);
      // The move lands after the batch's transaction but before its re-read: simulated by moving the board alone.
      await w.db.collection("boards").updateOne({ _id: w.board._id }, { $set: { workspaceId: w.wsB._id } });
      return out;
    };
    const docs = await w.services.records.createMany(w.board._id, { records: [{ values: { serial: "a" } }, { values: { serial: "b" } }] }, w.admin);
    assert.ok(docs.every((d) => d.workspaceId.equals(w.wsB._id)));
    assert.equal(await col(w, "records").countDocuments({ boardId: w.board._id, workspaceId: { $ne: w.wsB._id } }), 0);
  });

  test("settleRecords touches only the given records, and only when the board moved", async () => {
    const w = await world();
    const [a, b] = await addRecords(w, 2);
    const records = w.fake.dbs.get("jarc_database").collections.get("records"), mark = records.calls.length;
    await settleRecords(w.repos, w.board._id, w.wsA._id, [a._id]);
    assert.equal(records.calls.slice(mark).filter((c) => c.op === "updateMany").length, 0, "no write when nothing moved");
    await col(w, "boards").updateOne({ _id: w.board._id }, { $set: { workspaceId: w.wsB._id } });
    await settleRecords(w.repos, w.board._id, w.wsA._id, [a._id]);
    assert.ok((await wsOf(w, "records", a._id)).equals(w.wsB._id));
    assert.ok((await wsOf(w, "records", b._id)).equals(w.wsA._id), "other records are left to the move's alignment");
  });
});

describe("HTTP: move route and responses", () => {
  test("the move route aligns copies; record responses show the board's workspace even for a stale copy", async () => {
    const app = await startMongoApp();
    try {
      const call = (method, path, body) => api(app.url, method, `/api/v1${path}`, body);
      const a = (await call("POST", "/workspaces", { name: "Synthetic A" })).body.workspace;
      const b = (await call("POST", "/workspaces", { name: "Synthetic B" })).body.workspace;
      const board = (await call("POST", `/workspaces/${a.id}/boards`, { name: "Synthetic" })).body.board;
      const rec = (await call("POST", `/boards/${board.id}/records`, { values: { serial: "one" } })).body.record;
      assert.equal((await call("POST", `/records/${rec.id}/comments`, { body: "synthetic" })).status, 201);
      const moved = await call("POST", `/boards/${board.id}/move`, { expectedVersion: board.version, workspaceId: b.id });
      assert.equal(moved.status, 200); assert.equal(moved.body.recordsMoved, 1);
      assert.equal(await app.db.collection("comments").countDocuments({ workspaceId: new ObjectId(a.id) }), 0);
      // Simulate a leftover stale copy: every response still names the board's workspace.
      await app.db.collection("records").updateOne({ _id: new ObjectId(rec.id) }, { $set: { workspaceId: new ObjectId(a.id) } });
      assert.equal((await call("GET", `/records/${rec.id}`)).body.record.workspaceId, b.id);
      assert.equal((await call("GET", `/boards/${board.id}/records`)).body.items[0].workspaceId, b.id);
      const patched = await call("PATCH", `/records/${rec.id}`, { expectedVersion: 1, values: { serial: "two" } });
      assert.equal(patched.status, 200); assert.equal(patched.body.record.workspaceId, b.id);
    } finally { await app.close(); }
  });
});

describe("spreadsheet import jobs follow the board (security review)", () => {
  test("the workspace import list (and the progress view) leaves out a job whose board has moved to another workspace", async () => {
    const express = require("express");
    const { importRoutes } = require("../src/routes/imports");
    const { errorHandler } = require("../src/middleware/errors");
    const w = await world();
    const now = new Date();
    const job = (extra) => ({ _id: new ObjectId(), target: "new-board", workspaceId: w.wsA._id, createdBy: w.admin.userId, status: "done", fileName: "synthetic.csv", kind: "csv", createdAt: now, startedAt: now, ...extra });
    const moved = job({ boardId: w.board._id }), staying = job({ boardId: null, plannedBoardId: null, createdAt: new Date(now.getTime() - 1000) });
    await col(w, "importJobs").insertMany([moved, staying]);
    await w.services.schema.moveBoard(w.board._id, { expectedVersion: 1, workspaceId: w.wsB._id.toHexString() }, w.admin);
    const app = express();
    app.use((req, res, next) => { req.actor = w.admin; next(); });
    app.use(importRoutes({ services: w.services, access: w.access }));
    app.use(errorHandler(silent));
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
      const get = async (path) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`); assert.equal(r.status, 200, path); return (await r.json()).items.map((i) => i.id); };
      assert.deepEqual(await get(`/workspaces/${w.wsA._id}/imports`), [staying._id.toHexString()], "the moved board's job is no longer listed in its old workspace");
      assert.deepEqual(await get(`/workspaces/${w.wsA._id}/imports?view=progress`), [staying._id.toHexString()]);
      // jobFor agrees: the job itself is reached through the board's current workspace.
      const r = await fetch(`http://127.0.0.1:${server.address().port}/imports/${moved._id}`);
      assert.equal(r.status, 200);
      assert.equal((await r.json()).import.id, moved._id.toHexString());
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});

describe("drift check (read-only)", () => {
  test("reports counts per board and writes nothing", async () => {
    const w = await world();
    const [record] = await addRecords(w, 2);
    await sideDocs(w, record, w.wsA._id);
    await col(w, "boards").updateOne({ _id: w.board._id }, { $set: { workspaceId: w.wsB._id } });
    const db = w.fake.dbs.get("jarc_database"), writes = () => [...db.collections.values()].flatMap((c) => c.calls).filter((c) => /insert|update|delete|bulk|replace/i.test(c.op)).length;
    const before = writes();
    const out = await detectDrift(w.db);
    assert.equal(writes(), before);
    assert.deepEqual(out.totals, { records: 2, attachments: 1, comments: 1 });
    assert.equal(out.drifted[0].boardId, w.board._id.toHexString());
  });
});
