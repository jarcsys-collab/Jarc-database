// Public board numbers (domain/board-public-id.js; boards.publicId, counters.boardPublicId) and their backfill
// (src/migration/board-public-ids.js), on the fake MongoDB with synthetic data. Also the browser model's link lookup.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { startMongoApp, api } = require("./helpers");
const { FakeMongoClient } = require("./support/fake-mongo");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { BoardRepository } = require("../src/repositories/mongo/board-repository");
const { BASE, allocateBoardPublicId, isCanonicalText } = require("../src/domain/board-public-id");
const { planBoardPublicIds, applyBoardPublicIds, readOnly } = require("../src/migration/board-public-ids");
const { loadBrowser } = require("./support/browser-model");

const COLUMNS = [{ key: "serial", label: "Name", type: "text", required: true }];
async function freshDb({ bootstrap = true } = {}) {
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => new FakeMongoClient() });
  await connection.connect();
  if (bootstrap) await ensureDatabase(connection.db);
  return connection.db;
}
// A board as an older server version stored it: no publicId.
const legacyBoard = (workspaceId, name, createdAt) => ({ _id: new ObjectId(), workspaceId, name, description: "", icon: "D", archived: false, position: 1000, manualOrder: false, columns: [], groups: [], savedViews: [], createdBy: null, createdAt, updatedAt: createdAt, version: 3 });

describe("Public board numbers through the API", () => {
  let app, ws;
  const call = (method, p, body) => api(app.url, method, p, body);
  before(async () => { app = await startMongoApp(); ws = (await call("POST", "/api/v1/workspaces", { name: "Numbers" })).body.workspace.id; });
  after(async () => { await app.close(); });

  test("each new board gets the next number from 100001, shown in the API; numbers are canonical decimal", async () => {
    const a = (await call("POST", `/api/v1/workspaces/${ws}/boards`, { name: "A", columns: COLUMNS })).body.board;
    const b = (await call("POST", `/api/v1/workspaces/${ws}/boards`, { name: "B", columns: COLUMNS })).body.board;
    assert.equal(a.publicId, BASE + 1);
    assert.equal(b.publicId, BASE + 2);
    assert.ok(isCanonicalText(String(a.publicId)));
    const listed = (await call("GET", `/api/v1/workspaces/${ws}/boards`)).body.items;
    assert.deepEqual(listed.map((x) => x.publicId).sort(), [a.publicId, b.publicId].sort());
    assert.equal((await call("GET", `/api/v1/boards/${a.id}`)).body.board.publicId, a.publicId);
    assert.match(a.id, /^[0-9a-f]{24}$/, "the board's ID is still its MongoDB _id");
  });

  test("boards created at the same moment never share a number", async () => {
    const made = await Promise.all(Array.from({ length: 25 }, (_, i) => call("POST", `/api/v1/workspaces/${ws}/boards`, { name: `Parallel ${i}`, columns: COLUMNS })));
    assert.ok(made.every((r) => r.status === 201));
    const ids = made.map((r) => r.body.board.publicId);
    assert.equal(new Set(ids).size, 25);
    assert.ok(ids.every((n) => Number.isSafeInteger(n) && n > BASE));
  });

  test("a client can't choose or change a number; rename, move and archive keep it; a deleted board's number is never reused", async () => {
    assert.equal((await call("POST", `/api/v1/workspaces/${ws}/boards`, { name: "Mine", columns: COLUMNS, publicId: 999999 })).status, 400);
    const board = (await call("POST", `/api/v1/workspaces/${ws}/boards`, { name: "Keep", columns: COLUMNS })).body.board;
    assert.equal((await call("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: board.version, publicId: 100001 })).status, 400);
    let doc = (await call("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: board.version, name: "Kept" })).body.board;
    assert.equal(doc.publicId, board.publicId);
    doc = (await call("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: doc.version, archived: true })).body.board;
    assert.equal(doc.publicId, board.publicId);
    const other = (await call("POST", "/api/v1/workspaces", { name: "Elsewhere" })).body.workspace.id;
    const moved = await call("POST", `/api/v1/boards/${board.id}/move`, { expectedVersion: doc.version, workspaceId: other });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.board.publicId, board.publicId);
    assert.equal(moved.body.board.id, board.id);
    assert.equal((await call("DELETE", `/api/v1/boards/${board.id}?expectedVersion=${moved.body.board.version}`)).status, 200);
    const next = (await call("POST", `/api/v1/workspaces/${ws}/boards`, { name: "After", columns: COLUMNS })).body.board;
    assert.ok(next.publicId > board.publicId, "never recycled");
  });

  test("the database refuses a duplicate number (unique index)", async () => {
    const indexes = await app.db.collection("boards").listIndexes().toArray();
    const ix = indexes.find((i) => i.name === "uniq_board_public_id");
    assert.ok(ix && ix.unique);
    const [one] = (await call("GET", `/api/v1/workspaces/${ws}/boards`)).body.items;
    await assert.rejects(app.db.collection("boards").insertOne({ ...legacyBoard(new ObjectId(ws), "Dup", new Date()), publicId: one.publicId }), (e) => e.code === 11000);
  });
});

describe("Every way of creating boards assigns a number", () => {
  test("insert and insertMany (the monday.com integration, spreadsheet imports) allocate before writing; an existing number is kept", async () => {
    const db = await freshDb(), repo = new BoardRepository(db), ws = new ObjectId();
    const one = await repo.insert(legacyBoard(ws, "One", new Date()));
    const many = [legacyBoard(ws, "Two", new Date()), legacyBoard(ws, "Three", new Date())];
    await repo.insertMany(many);
    assert.deepEqual([one.publicId, ...many.map((b) => b.publicId)], [BASE + 1, BASE + 2, BASE + 3]);
    const kept = await repo.insert({ ...legacyBoard(ws, "Kept", new Date()), publicId: BASE + 500 });
    assert.equal(kept.publicId, BASE + 500);
  });
  test("two first allocations racing for the counter document both succeed with different numbers", async () => {
    const db = await freshDb();
    const got = await Promise.all(Array.from({ length: 10 }, () => allocateBoardPublicId(db)));
    assert.equal(new Set(got).size, 10);
  });
});

describe("Backfill of existing boards", () => {
  const seedLegacy = async (db, n) => { const ws = new ObjectId(), docs = Array.from({ length: n }, (_, i) => legacyBoard(ws, `Old ${i}`, new Date(Date.UTC(2026, 0, 1 + ((i * 7) % n))))); await db.collection("boards").insertMany(docs); return docs; };

  test("dry run: counts and the numbers they'd get, oldest first; nothing written", async () => {
    const db = await freshDb(), docs = await seedLegacy(db, 6);
    await db.collection("boards").insertOne({ ...legacyBoard(new ObjectId(), "Numbered", new Date()), publicId: BASE + 40 });
    const before = JSON.stringify(await db.collection("boards").find({}).toArray());
    const plan = await planBoardPublicIds(db);
    assert.deepEqual([plan.boards, plan.numbered, plan.missing, plan.indexReady, plan.maxExisting, plan.firstNumber, plan.lastNumber], [7, 1, 6, true, BASE + 40, BASE + 41, BASE + 46]);
    const byAge = [...docs].sort((a, b) => a.createdAt - b.createdAt || String(a._id).localeCompare(String(b._id))).map((d) => String(d._id));
    assert.deepEqual(plan.order, byAge);
    assert.equal(JSON.stringify(await db.collection("boards").find({}).toArray()), before, "read-only");
  });

  test("apply: every board numbered once, past the numbers in use; only publicId changes; a rerun changes nothing", async () => {
    const db = await freshDb(), docs = await seedLegacy(db, 8);
    await db.collection("boards").insertOne({ ...legacyBoard(new ObjectId(), "Numbered", new Date()), publicId: BASE + 40 });
    const snapshot = new Map((await db.collection("boards").find({}).toArray()).map((d) => [String(d._id), d]));
    const r = await applyBoardPublicIds(db);
    assert.deepEqual([r.assigned, r.skipped, r.after.missing, r.after.duplicates.length], [8, 0, 0, 0]);
    const after = await db.collection("boards").find({}).toArray();
    for (const d of after) {
      const was = snapshot.get(String(d._id)), { publicId, ...rest } = d, { publicId: before, ...restBefore } = was;
      assert.deepEqual(rest, restBefore, "nothing else changed (version included)");
      if (before !== undefined) assert.equal(publicId, before, "an existing number is kept");
    }
    const numbers = docs.map((d) => after.find((x) => String(x._id) === String(d._id)).publicId);
    assert.ok(numbers.every((n) => n > BASE + 40), "the counter was raised past the number already in use");
    assert.equal(new Set(numbers).size, 8);
    const again = await applyBoardPublicIds(db);
    assert.deepEqual([again.assigned, again.skipped], [0, 0]);
    assert.deepEqual(await db.collection("boards").find({}).toArray(), after);
    // A board created by the app afterwards continues the sequence.
    const next = await new BoardRepository(db).insert(legacyBoard(new ObjectId(), "New", new Date()));
    assert.equal(next.publicId, Math.max(...numbers) + 1);
  });

  test("stopped half-way (connection lost), then run again: finishes with every board numbered once", async () => {
    const db = await freshDb();
    await seedLegacy(db, 10);
    const boards = db.collection("boards"), real = boards.updateOne.bind(boards);
    let calls = 0;
    boards.updateOne = async (...args) => { calls += 1; if (calls === 5) throw new Error("connection lost"); return real(...args); };
    await assert.rejects(applyBoardPublicIds(db), /connection lost/);
    boards.updateOne = real;
    const mid = await planBoardPublicIds(db);
    assert.equal(mid.missing, 6);
    const r = await applyBoardPublicIds(db);
    assert.equal(r.assigned, 6);
    assert.equal(r.after.missing, 0);
    assert.equal(r.after.duplicates.length, 0);
  });

  test("boards created while the backfill runs get their own numbers: no duplicates", async () => {
    const db = await freshDb();
    await seedLegacy(db, 12);
    const repo = new BoardRepository(db), extra = [];
    const r = await applyBoardPublicIds(db, { onProgress: (n) => { if (n % 3 === 0) extra.push(repo.insert(legacyBoard(new ObjectId(), `During ${n}`, new Date()))); } });
    await Promise.all(extra);
    const after = await planBoardPublicIds(db);
    assert.equal(r.assigned, 12);
    assert.deepEqual([after.missing, after.duplicates.length, after.boards], [0, 0, 16]);
  });

  test("the plan through the read-only guard: same answer; every write, index or collection change is refused before it runs", async () => {
    const db = await freshDb({ bootstrap: false });
    await seedLegacy(db, 4);
    const guarded = readOnly(db), plan = await planBoardPublicIds(guarded);
    assert.deepEqual({ ...plan, order: plan.order.length }, { ...(await planBoardPublicIds(db)), order: 4 });
    assert.equal(plan.indexReady, false);
    for (const op of ["insertOne", "updateOne", "updateMany", "deleteMany", "findOneAndUpdate", "createIndex", "drop", "bulkWrite", "aggregate"]) assert.throws(() => guarded.collection("boards")[op], /read-only plan refused/, op);
    await assert.rejects(applyBoardPublicIds(guarded), /refused|doesn't exist yet/, "apply through the guard stops before any write");
    assert.equal(await db.collection("counters").findOne({}), null, "no counter was created");
    assert.deepEqual((await db.collection("boards").listIndexes().toArray()).map((i) => i.name), ["_id_"], "no index was created");
  });

  test("boards stored with an _id that isn't an ObjectId, or without createdAt, are reported and numbered too", async () => {
    const db = await freshDb(), ws = new ObjectId();
    await db.collection("boards").insertMany([{ ...legacyBoard(ws, "String id", new Date()), _id: "board-from-elsewhere" }, { ...legacyBoard(ws, "No date", null), createdAt: undefined }, legacyBoard(ws, "Normal", new Date())]);
    const plan = await planBoardPublicIds(db);
    assert.deepEqual(plan.idTypes, { string: 1, ObjectId: 2 });
    assert.equal(plan.noCreatedAt, 1);
    const r = await applyBoardPublicIds(db);
    assert.deepEqual([r.assigned, r.skipped, r.after.missing], [3, 0, 0]);
    assert.ok((await db.collection("boards").findOne({ _id: "board-from-elsewhere" })).publicId > BASE);
  });

  test("refuses to run without the unique index (older server still running) or with invalid numbers; writes nothing", async () => {
    const db = await freshDb({ bootstrap: false });
    await seedLegacy(db, 3);
    await assert.rejects(applyBoardPublicIds(db), /index uniq_board_public_id doesn't exist/);
    assert.equal((await planBoardPublicIds(db)).missing, 3);
    const db2 = await freshDb();
    await db2.collection("boards").insertOne({ ...legacyBoard(new ObjectId(), "Bad", new Date()), publicId: "100001" });
    await assert.rejects(applyBoardPublicIds(db2), /need attention/);
  });
});

describe("Board links in the browser model", () => {
  test("a number, an older server-ID link and nothing else find a board — only among the boards listed for this person", () => {
    const { window } = loadBrowser();
    const model = Object.create(window.BoardModel.prototype);
    model.storage = { adapter: null };
    model.workspaces = [{ id: "w1", boards: [{ id: "0123456789abcdef01234567", publicId: 100007, name: "Seven" }, { id: "abcdefabcdefabcdefabcdef", publicId: null, name: "Old" }] }];
    assert.equal(model.findBoardByLink("100007")?.board.name, "Seven");
    assert.equal(model.findBoardByLink("0123456789ABCDEF01234567")?.board.name, "Seven", "older links keep working");
    assert.equal(model.findBoardByLink("abcdefabcdefabcdefabcdef")?.board.name, "Old", "a board without a number yet: by server ID");
    for (const bad of ["0100007", "100008", "-100007", "1e5", " 100007", "100007.0", "", "abc"]) assert.equal(model.findBoardByLink(bad), null, bad);
  });
});
