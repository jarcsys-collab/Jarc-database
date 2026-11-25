// recordSearch data integrity (Phase 2), on the fake MongoDB with the real services:
//   start-up       the server's catch up is incremental and bounded (no read of every record), resumable, and recovers
//                  updates the in-memory queue lost (crash/redeploy), board rewrites (stored marks) and deletions;
//   writers        the monday.com migration executor and its rollback keep the index in step (they run as a CLI);
//                  board column PATCHes, import removals and workspace deletions reach the index;
//   concurrency    an index document is never replaced by an older one;
//   reconcile      scripts/record-search-reconcile.js: dry run reports and writes nothing; --apply repairs, is idempotent,
//                  resumable and paced; orphans are removed only after a re-check;
//   shutdown       the queue is drained within a bound; server.js wires start()/stop(), not the full catch up;
//   logging        error names and codes only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ObjectId } = require("mongodb");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase, COLLECTIONS } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { RecordSearchIndex, searchDocument, planOf, STATE_ID } = require("../src/services/record-search-index");
const { writeGuarded } = require("../src/repositories/mongo/record-search-repository");
const { reconcile, rateLimiter, main, isLoopbackUri, CHECKPOINT_ID } = require("../scripts/record-search-reconcile");
const { FakeMongoClient } = require("./support/fake-mongo");

const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "notes", label: "Notes", type: "text" }, { key: "status", label: "Status", type: "status", options: ["To do", "Done"] }, { key: "qty", label: "Qty", type: "number" }];
const quiet = { log() {}, warn() {}, error() {} };
const actor = Object.freeze({ userId: new ObjectId(), kind: "entra", displayName: "Tester" });
const people = { everyone: true };

async function world(mode = "on", { logger = quiet, fake = new FakeMongoClient() } = {}) {
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const dl = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), recordSearch: mode });
  dl.searchIndex.pauseMs = 0; dl.searchIndex.repairMs = 0; dl.searchIndex.passEveryMs = 0;
  return { dl, fake, connection, s: dl.services, repos: dl.repos, index: dl.searchIndex, db: connection.db };
}
async function seeded(w, n = 30) {
  const ws = await w.s.workspaces.create({ name: "W" }, actor);
  const a = await w.s.boards.create(ws._id, { name: "A", columns: COLUMNS }, actor), b = await w.s.boards.create(ws._id, { name: "B", columns: COLUMNS }, actor);
  const rows = (p, k) => Array.from({ length: k }, (_, i) => ({ values: { serial: `${p} ${i}`, notes: `note ${p} ${i}`, status: i % 2 ? "To do" : "Done", qty: i } }));
  const ra = await w.s.records.createMany(a._id, { records: rows("alpha", n) }, actor, people);
  const rb = await w.s.records.createMany(b._id, { records: rows("beta", n) }, actor, people);
  await w.index.flush();
  return { ws, a, b, ra, rb };
}
// A new server process on the same database: the in-memory queue is empty, the stored state is what survived.
const restart = (w) => { const i = new RecordSearchIndex({ repos: w.repos, logger: quiet, mode: w.index.mode, pauseMs: 0, repairMs: 0, passEveryMs: 0 }); return i; };
// Records every find on records: its filter and how many documents it returned.
function spyFinds(collection) {
  const seen = [], original = collection.find.bind(collection);
  collection.find = (filter = {}, options = {}) => { const cursor = original(filter, options), toArray = cursor.toArray.bind(cursor); cursor.toArray = async () => { const docs = await toArray(); seen.push({ filter, n: docs.length }); return docs; }; return cursor; };
  return { seen, restore: () => { collection.find = original; } };
}
const clean = async (w) => { await w.index.flush(); const h = await w.index.verify(); return { missing: h.missing, stale: h.stale, extra: h.extra }; };

describe("Start-up catch up is incremental and bounded", () => {
  test("without a baseline it is not used, reads no records, and says how to establish one", async () => {
    const warnings = [], w = await world("on", { logger: { ...quiet, warn: (m) => warnings.push(m) } }); await seeded(w);
    const spy = spyFinds(w.repos.records.collection);
    const r = await w.index.incremental();
    spy.restore();
    assert.equal(r.baseline, false);
    assert.equal(w.index.active, false);
    assert.equal(spy.seen.length, 0, "no record read at all");
    assert.match(warnings.join("\n"), /no baseline yet/);
  });
  test("after a baseline: a restart reads only what changed since the watermark, never every record, and is then ready", async () => {
    const w = await world(); const { a, ra } = await seeded(w, 300);
    await w.index.catchUp(); assert.equal(w.index.active, true);
    const state = await w.repos.recordSearch.state.findOne({ _id: STATE_ID });
    assert.ok(state.baselineAt instanceof Date && state.watermark instanceof Date);
    // Changed behind the queue's back (another process), now.
    for (const r of ra.slice(0, 3)) await w.repos.records.collection.updateOne({ _id: r._id }, { $set: { "values.notes": "changed quietly", updatedAt: new Date() } });
    const next = restart(w), spy = spyFinds(w.repos.records.collection);
    const out = await next.start();
    spy.restore();
    assert.equal(next.active, true);
    assert.equal(out.rewritten, 3);
    for (const f of spy.seen) {
      const bounded = f.filter._id?.$in || f.filter.updatedAt?.$gte || f.filter.$or?.some((x) => x.updatedAt);
      assert.ok(bounded, `every records read is bounded by IDs or the watermark: ${JSON.stringify(Object.keys(f.filter))}`);
    }
    // 600 records exist; all of them were written within the margin, so at most those plus nothing else are read.
    assert.ok(spy.seen.reduce((s, f) => s + f.n, 0) <= 600 + 3 * 2, "bounded by the records changed since the watermark");
    assert.equal((await w.repos.recordSearch.collection.findOne({ _id: ra[0]._id })).text.includes("changed quietly"), true);
    assert.deepEqual(await clean(w), { missing: 0, stale: 0, extra: 0 });
    assert.ok(a);
  });
  test("an old watermark's pass reads only the few changed records, whatever the size of the board", async () => {
    const w = await world(); const { ra } = await seeded(w, 400);
    await w.index.catchUp();
    // Move the whole board into the past and the watermark with it: only one record changes afterwards.
    await w.repos.records.collection.updateMany({ boardId: ra[0].boardId }, { $set: { updatedAt: new Date("2026-01-01") } });
    await w.repos.recordSearch.collection.updateMany({ boardId: ra[0].boardId }, { $set: { updatedAt: new Date("2026-01-01") } });
    await w.repos.records.collection.updateMany({ boardId: { $ne: ra[0].boardId } }, { $set: { updatedAt: new Date("2026-01-01") } });
    await w.repos.recordSearch.collection.updateMany({ boardId: { $ne: ra[0].boardId } }, { $set: { updatedAt: new Date("2026-01-01") } });
    await w.repos.recordSearch.state.updateOne({ _id: STATE_ID }, { $set: { watermark: new Date("2026-06-01") } });
    await w.repos.records.collection.updateOne({ _id: ra[5]._id }, { $set: { "values.serial": "late edit", updatedAt: new Date("2026-07-01") } });
    const next = restart(w), spy = spyFinds(w.repos.records.collection);
    const out = await next.start();
    spy.restore();
    assert.equal(out.checked, 1); assert.equal(out.rewritten, 1);
    assert.ok(spy.seen.reduce((s, f) => s + f.n, 0) <= 3, `read ${spy.seen.reduce((s, f) => s + f.n, 0)} record documents for 800 records`);
    assert.equal(next.active, true);
  });
  test("an interrupted pass resumes where it stopped (stored progress), and a second pass rewrites nothing", async () => {
    const w = await world(); const { ra, rb } = await seeded(w, 250);
    await w.index.catchUp();
    await w.repos.recordSearch.state.updateOne({ _id: STATE_ID }, { $set: { watermark: new Date(Date.now() - 3600e3) } });
    // Every index document goes stale behind the queue's back (a lost queue), then the pass is interrupted part-way.
    await w.repos.recordSearch.collection.updateMany({ boardId: { $in: [ra[0].boardId, rb[0].boardId] } }, { $set: { text: "", updatedAt: new Date(0) } });
    const errors = [], next = restart(w); next.logger = { ...quiet, error: (m) => errors.push(m) };
    w.fake.failNext({ collection: COLLECTIONS.records, op: "find", skip: 3, error: Object.assign(new Error("network blip with record text"), { name: "MongoNetworkError", code: 6 }) });
    const first = await next.incremental();
    assert.equal(first.failed, true); assert.equal(next.active, false);
    assert.doesNotMatch(errors.join("\n"), /record text/, "error names and codes only");
    const st = await w.repos.recordSearch.state.findOne({ _id: STATE_ID });
    assert.ok(st.pass?.from && (st.pass.done.length || st.pass.cursor), "progress was stored");
    const second = await next.incremental();
    assert.equal(second.resumed, true);
    assert.equal(next.active, true);
    assert.deepEqual(await clean(w), { missing: 0, stale: 0, extra: 0 });
    assert.equal((await next.incremental()).rewritten, 0, "idempotent");
  });
  test("lost queue entries are recovered: an edit, a board's column change (stored mark) and a deletion", async () => {
    const w = await world(); const { a, ra } = await seeded(w);
    await w.index.catchUp();
    // The process dies before its queue is written: refreshes are dropped, but the board mark was stored.
    const realRewrite = w.index.rewrite.bind(w.index), realSync = w.index.syncBoard.bind(w.index);
    w.index.rewrite = async () => {}; w.index.syncBoard = async () => 0;
    const edited = await w.s.records.update(ra[0]._id, { expectedVersion: 1, values: { notes: "lost edit" } }, actor, people);
    await w.s.records.delete(ra[1]._id, 1, actor);
    const board = await w.repos.boards.findById(a._id);
    await w.s.boards.update(a._id, { expectedVersion: board.version, columns: [...board.columns, { key: "extra", label: "Extra", type: "text" }] }, actor);
    await w.index.flush();
    w.index.rewrite = realRewrite; w.index.syncBoard = realSync;
    assert.ok((await w.repos.recordSearch.state.findOne({ _id: STATE_ID })).dirty?.[a._id.toHexString()], "the board's rewrite was stored");
    assert.ok(edited);
    const next = restart(w);
    await next.start();
    assert.equal(next.active, true);
    assert.match((await w.repos.recordSearch.collection.findOne({ _id: ra[0]._id })).text, /lost edit/);
    assert.equal(await w.repos.recordSearch.count({ _id: ra[1]._id }), 0, "the deleted record's document is gone (activity log)");
    assert.equal((await w.repos.recordSearch.state.findOne({ _id: STATE_ID })).dirty?.[a._id.toHexString()], undefined, "mark cleared");
    assert.deepEqual(await clean(w), { missing: 0, stale: 0, extra: 0 });
  });
  test("index documents of a board deleted by another process are removed, after re-checking the board is gone", async () => {
    const w = await world(); const { b } = await seeded(w);
    await w.index.catchUp();
    await w.repos.records.collection.deleteMany({ boardId: b._id });
    await w.repos.boards.collection.deleteOne({ _id: b._id });
    const out = await restart(w).start();
    assert.equal(out.removed, 30);
    assert.equal(await w.repos.recordSearch.count({ boardId: b._id }), 0);
  });
  test("a board whose columns changed unseen (no mark) is found by the signature sample and rewritten", async () => {
    const w = await world(); const { a, ra } = await seeded(w);
    await w.index.catchUp();
    await w.repos.boards.collection.updateOne({ _id: a._id }, { $set: { columns: COLUMNS.filter((c) => c.key !== "notes") } });
    const out = await restart(w).start();
    assert.equal(out.boardsRewritten, 1);
    assert.doesNotMatch((await w.repos.recordSearch.collection.findOne({ _id: ra[2]._id })).text, /note/);
  });
});

describe("Writers outside the queue's reach and audit gaps", () => {
  test("a board PATCH that changes searchable columns rewrites the board; one that doesn't, doesn't", async () => {
    const w = await world(); const { a, ra } = await seeded(w);
    await w.index.catchUp();
    let board = await w.repos.boards.findById(a._id);
    let calls = 0; const o = w.index.refreshBoard.bind(w.index); w.index.refreshBoard = (id) => { calls += 1; o(id); };
    board = await w.s.boards.update(a._id, { expectedVersion: board.version, name: "Renamed" }, actor);
    assert.equal(calls, 0);
    const after = await w.s.boards.update(a._id, { expectedVersion: board.version, columns: [...board.columns, { key: "memo", label: "Memo", type: "text" }] }, actor);
    await w.index.flush();
    assert.equal(calls, 1);
    assert.equal((await w.repos.recordSearch.collection.findOne({ _id: ra[0]._id })).sig, planOf(after).sig, "rewritten for the new columns");
    assert.deepEqual(await clean(w), { missing: 0, stale: 0, extra: 0 });
  });
  test("deleting a workspace removes the index documents of every board it had, including one made meanwhile", async () => {
    const w = await world(); const { ws, a, b } = await seeded(w);
    await w.index.catchUp();
    // A board inserted directly (as by a concurrent request) after the service listed nothing yet.
    const late = { _id: new ObjectId(), workspaceId: ws._id, name: "Late", columns: COLUMNS, groups: [], version: 1, archived: false };
    await w.repos.boards.collection.insertOne(late);
    await w.repos.recordSearch.collection.insertOne({ _id: new ObjectId(), boardId: late._id, archived: false, updatedAt: new Date(), name: "late", text: "late", status: [], priority: [], owner: [], sig: planOf(late).sig });
    await w.s.workspaces.delete(ws._id, 1, actor);
    await w.index.flush();
    for (const id of [a._id, b._id, late._id]) assert.equal(await w.repos.recordSearch.count({ boardId: id }), 0);
  });
});

describe("Never older over newer", () => {
  test("a guarded write skips an index document that is newer, and writes over an older one", async () => {
    const w = await world(); const col = w.repos.recordSearch.collection, id = new ObjectId(), boardId = new ObjectId();
    const doc = (t, text) => ({ _id: id, boardId, archived: false, updatedAt: new Date(t), name: "n", text, status: [], priority: [], owner: [], sig: "x" });
    await writeGuarded(col, [doc(2000, "newer")]);
    const r = await writeGuarded(col, [doc(1000, "older")]);
    assert.deepEqual([r.written, r.skipped.length], [0, 1]);
    assert.equal((await col.findOne({ _id: id })).text, "newer");
    assert.equal((await writeGuarded(col, [doc(3000, "newest")])).written, 1);
    assert.equal((await col.findOne({ _id: id })).text, "newest");
    assert.equal(await col.countDocuments({ _id: id }), 1, "keyed by record _id: never a duplicate");
  });
  test("a slow writer holding an old version can't put it over the newer one another server wrote", async () => {
    const w = await world(); const { ra } = await seeded(w);
    await w.index.catchUp();
    const r = await w.repos.records.findById(ra[0]._id), plan = planOf(await w.repos.boards.findById(r.boardId));
    const old = searchDocument(r, plan); // read before the edit
    await w.s.records.update(r._id, { expectedVersion: 1, values: { notes: "the newest text" } }, actor, people);
    await w.index.flush();
    await w.repos.recordSearch.upsertMany([old]); // the other server, late
    assert.match((await w.repos.recordSearch.collection.findOne({ _id: r._id })).text, /the newest text/);
  });
});

describe("monday.com migration executor and rollback", () => {
  const { verifyTarget, GUARD_DB, GUARD_ID, GUARD_PURPOSE } = require("../src/migration/monday/target");
  const executor = require("../src/migration/monday/executor");
  const { executeRollback, planRollback } = require("../src/migration/monday/rollback");
  const { dryRun } = require("../src/migration/monday");
  const { fixture } = require("./support/monday-migration-fixture");
  const ID = "A".repeat(24), URI = "mongodb://u:p@127.0.0.1:27027/?replicaSet=rs";
  // The fake database behind a client that answers the local-test identity checks (as the executor's own tests do).
  async function setup() {
    const fake = new FakeMongoClient(), dbName = "jarc_migration_test_sync";
    const client = { startSession: () => fake.startSession(), db: (name) => (name === "admin" ? { command: async (c) => { if (c.hello) return { setName: "rs", me: "127.0.0.1:27027", hosts: ["127.0.0.1:27027"] }; if (c.buildInfo) return { version: "8.0.12", modules: [] }; throw new Error("no such command"); } } : name === GUARD_DB ? { collection: () => ({ findOne: async () => ({ _id: GUARD_ID, purpose: GUARD_PURPOSE, instanceId: ID }) }) } : fake.db(name)) };
    const target = await verifyTarget({ client, uri: URI, dbName, instanceId: ID, env: {} });
    const dir = fixture(), r = dryRun(dir); fs.rmSync(dir, { recursive: true, force: true });
    const db = fake.db(dbName), workspaceId = new ObjectId(), at = new Date();
    await ensureDatabase(db);
    await db.collection(COLLECTIONS.workspaces).insertOne({ _id: workspaceId, name: "Rehearsal", archived: false, position: 1000, createdAt: at, updatedAt: at, version: 1 });
    const approval = { kind: "monday-migration-approval", version: 2, scope: "local-test", planDigest: r.digest, targetDatabase: dbName, targetInstanceId: ID, targetWorkspaceId: workspaceId.toHexString(), approvedBy: "Test", operator: "tester", approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), include: [...executor.SCOPE], expectedCounts: executor.planCounts(r.plan) };
    return { fake, client, target, r, db, approval, run: (extra = {}) => executor.runImport({ client, target, plan: r.plan, planDigest: r.digest, approval, operator: "tester", batchSize: 5, ...extra }) };
  }
  test("every imported record gets its index document in the batch's transaction; an interrupted batch leaves neither", async () => {
    const { db, r, run } = await setup();
    await assert.rejects(() => run({ faults: { failInsideBatch: 1 } }), (e) => e.code === "MIGRATION_SIMULATED_INTERRUPTION");
    assert.equal(await db.collection("recordSearch").countDocuments({}), await db.collection("records").countDocuments({}), "records and index documents commit together");
    await db.collection("integrationJobs").updateOne({}, { $set: { lockedBy: null, lockedUntil: null } });
    const res = await run();
    assert.equal(res.verification.ok, true, JSON.stringify(res.verification.problems));
    const total = r.plan.records.length + r.plan.subRecords.length;
    assert.equal(res.verification.counts.searchIndex, total);
    const board = await db.collection("boards").findOne({ _id: r.plan.board._id }), rec = await db.collection("records").findOne({ boardId: r.plan.board._id });
    const { _id, ...want } = searchDocument(rec, planOf(board));
    const got = await db.collection("recordSearch").findOne({ _id: rec._id });
    for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, k);
    const again = await run();
    assert.equal(again.inserted.searchIndex, 0, "a re-run writes nothing");
    assert.equal(await db.collection("recordSearch").countDocuments({}), total, "no duplicates");
  });
  test("records committed by an older run without index documents get them before verification", async () => {
    const { db, r, run } = await setup();
    await run();
    await db.collection("recordSearch").deleteMany({ boardId: r.plan.board._id });
    const res = await run();
    assert.equal(res.searchIndexRepaired, r.plan.records.length);
    assert.equal(res.verification.ok, true);
  });
  test("rollback removes the run's index documents with its records, and nothing else", async () => {
    const { db, r, run, client, target } = await setup();
    await run();
    const otherBoard = new ObjectId(), other = { _id: new ObjectId(), boardId: otherBoard, archived: false, updatedAt: new Date(), name: "x", text: "x", status: [], priority: [], owner: [], sig: "s" };
    await db.collection("recordSearch").insertOne(other);
    const dry = await planRollback(db, r.plan);
    assert.equal(dry.ok, true, JSON.stringify(dry.blockers));
    const res = await executeRollback({ client, target, plan: r.plan, planDigest: r.digest, approval: { kind: "migration-rollback-approval", version: 1, runId: r.plan.runId, planDigest: r.digest, expectedCounts: dry.counts, approvedBy: "Test", expiresAt: new Date(Date.now() + 3600e3).toISOString() } });
    assert.equal(res.removed.searchIndex, dry.counts.records);
    assert.equal(await db.collection("recordSearch").countDocuments({}), 1, "only the unrelated document stays");
    assert.ok(await db.collection("recordSearch").findOne({ _id: other._id }));
  });
});

describe("Reconciliation script", () => {
  async function drifted() {
    const w = await world("on"); const { ra, rb } = await seeded(w, 120);
    await w.index.catchUp();
    const col = w.repos.recordSearch.collection;
    await col.deleteMany({ _id: { $in: ra.slice(0, 7).map((r) => r._id) } }); // 7 missing
    await col.updateMany({ _id: { $in: rb.slice(0, 5).map((r) => r._id) } }, { $set: { sig: "old", text: "old" } }); // 5 stale
    for (let i = 0; i < 4; i += 1) await col.insertOne({ _id: new ObjectId(), boardId: ra[0].boardId, archived: false, updatedAt: new Date(), name: "ghost", text: "ghost", status: [], priority: [], owner: [], sig: "x" }); // 4 orphans
    return w;
  }
  const fast = () => rateLimiter(1e9);
  test("dry run: reports missing, stale and orphan counts, and writes nothing at all", async () => {
    const w = await drifted();
    const writes = (c) => c.calls.filter((x) => !["find", "findOne", "countDocuments"].includes(x.op)).length;
    const before = [COLLECTIONS.recordSearch, COLLECTIONS.recordSearchState, COLLECTIONS.records].map((n) => writes(w.db.collection(n)));
    const { counts, done } = await reconcile({ db: w.db, limiter: fast() });
    assert.equal(done, true);
    assert.deepEqual([counts.records, counts.missing, counts.stale, counts.orphans, counts.written, counts.removed], [240, 7, 5, 4, 0, 0]);
    assert.deepEqual([COLLECTIONS.recordSearch, COLLECTIONS.recordSearchState, COLLECTIONS.records].map((n) => writes(w.db.collection(n))), before, "no writes");
  });
  test("--apply repairs everything, records the baseline, and a second run is a no-op", async () => {
    const w = await drifted();
    await w.repos.recordSearch.state.deleteOne({ _id: STATE_ID });
    const r = await reconcile({ db: w.db, apply: true, limiter: fast() });
    assert.deepEqual([r.counts.written, r.counts.removed], [12, 4]);
    assert.deepEqual(await clean(w), { missing: 0, stale: 0, extra: 0 });
    const st = await w.repos.recordSearch.state.findOne({ _id: STATE_ID });
    assert.ok(st.baselineAt && st.watermark);
    const again = await reconcile({ db: w.db, apply: true, limiter: fast() });
    assert.deepEqual([again.counts.missing, again.counts.stale, again.counts.orphans, again.counts.written, again.counts.removed], [0, 0, 0, 0, 0]);
    assert.equal(await w.repos.recordSearch.count(), 240, "keyed by _id: no duplicates");
  });
  test("an interrupted --apply resumes from its stored checkpoint, and --restart starts over", async () => {
    const w = await drifted();
    const part = await reconcile({ db: w.db, apply: true, batch: 50, stopAfterBatches: 2, limiter: fast() });
    assert.equal(part.done, false);
    const ck = await w.repos.recordSearch.state.findOne({ _id: CHECKPOINT_ID });
    assert.equal(ck.status, "running"); assert.equal(ck.phase, "records"); assert.ok(ck.after);
    const logs = [], rest = await reconcile({ db: w.db, apply: true, batch: 50, limiter: fast(), log: (m) => logs.push(m) });
    assert.equal(rest.done, true);
    assert.match(logs[0], /resuming from the stored checkpoint/);
    assert.equal(rest.counts.records, 240, "counts carry over: every record seen once");
    assert.deepEqual(await clean(w), { missing: 0, stale: 0, extra: 0 });
    assert.equal((await w.repos.recordSearch.state.findOne({ _id: CHECKPOINT_ID })).status, "done");
  });
  test("a record changed while the script runs is never overwritten with older data", async () => {
    const w = await drifted();
    const target = (await w.repos.records.collection.find({}, { sort: { _id: 1 }, limit: 1 }).toArray())[0];
    await w.repos.recordSearch.collection.deleteOne({ _id: target._id }); // missing → the script will write it
    // Between the script's read of the full records and its write, someone edits that record and the server indexes it.
    const index = w.db.collection(COLLECTIONS.recordSearch), o = index.bulkWrite.bind(index);
    let once = false;
    index.bulkWrite = async (ops, opts) => {
      if (!once && ops.some((x) => x.updateOne?.filter?._id?.equals?.(target._id))) {
        once = true;
        await w.s.records.update(target._id, { expectedVersion: 1, values: { notes: "edited during the run" } }, actor, people);
        await w.index.flush();
      }
      return o(ops, opts);
    };
    const r = await reconcile({ db: w.db, apply: true, limiter: fast() });
    index.bulkWrite = o;
    assert.ok(r.counts.skippedNewer >= 1);
    assert.match((await index.findOne({ _id: target._id })).text, /edited during the run/);
  });
  test("an orphan whose record reappears before the delete is kept (re-checked)", async () => {
    const w = await drifted();
    const ghost = await w.repos.recordSearch.collection.findOne({ name: "ghost" });
    const records = w.db.collection(COLLECTIONS.records), o = records.find.bind(records);
    let n = 0;
    records.find = (filter, opts) => { if (filter?._id?.$in?.some?.((id) => id.equals(ghost._id))) { n += 1; if (n === 2) records.insertOne({ _id: ghost._id, boardId: ghost.boardId, values: { serial: "ghost" }, archived: false, updatedAt: ghost.updatedAt, version: 1 }); } return o(filter, opts); };
    const r = await reconcile({ db: w.db, apply: true, limiter: fast() });
    records.find = o;
    assert.equal(r.counts.keptOnRecheck, 1);
    assert.ok(await w.repos.recordSearch.collection.findOne({ _id: ghost._id }));
    assert.equal(r.counts.removed, 3);
  });
  test("pacing: never more than the operations per second asked for; above 450 is refused", async () => {
    let clock = 0; const waits = [];
    const limiter = rateLimiter(100, { clock: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; } });
    for (let i = 0; i < 10; i += 1) await limiter.take(50);
    assert.ok(clock >= 4500, `500 operations at 100/s take at least 4.5 s (took ${clock} ms)`);
    const w = await world();
    await assert.rejects(() => reconcile({ db: w.db, maxOps: 500 }), /at most 450/);
  });
  // Command-line guards: each stops before any connection is made (process.exitCode is restored after each run).
  async function cli(argv, input = []) {
    const lines = [], saved = process.exitCode;
    try { await main(argv, (m) => lines.push(String(m)), input); return { lines, code: process.exitCode }; } finally { process.exitCode = saved; }
  }
  test("L5: malformed Railway variables give a fixed message and never echo any part of the input", async () => {
    const SECRET = "s3cr3tPW-zq9";
    for (const raw of [`{"MONGODB_URI":"mongodb://jarc:${SECRET}@cluster.example/","MONGODB_DB_NAME":"jarc_database"`, `${SECRET}{`, "null", "[1]", `"${SECRET}"`]) {
      const { lines, code } = await cli(["--target", "production", "--railway-stdin"], [raw]);
      assert.deepEqual(lines, ["STOPPED: Railway variables were not valid JSON. Nothing was contacted."], raw);
      assert.equal(code, 2);
      for (const line of lines) for (let i = 0; i + 3 <= SECRET.length; i += 1) assert.ok(!line.includes(SECRET.slice(i, i + 3)), line);
    }
  });
  test("L6: the local --uri check accepts only a single 127.0.0.1 / localhost host", async () => {
    for (const ok of ["mongodb://127.0.0.1:27017/", "mongodb://localhost:27017/?directConnection=true", "mongodb://user:pw@localhost/", "mongodb://127.0.0.1"]) assert.equal(isLoopbackUri(ok), true, ok);
    for (const bad of ["mongodb://127.0.0.1:27017,other-host/", "mongodb://localhost,other:27017/", "mongodb://u:p@127.0.0.1:1,evil.example:2/", "mongodb+srv://localhost/", "mongodb://localhost.evil.example/", "mongodb://127.0.0.1.evil.example/", "mongodb://evil.example/127.0.0.1", "mongodb://evil.example?h=127.0.0.1", "", null]) assert.equal(isLoopbackUri(bad), false, String(bad));
    const { lines, code } = await cli(["--target", "local", "--db", "jarc_migration_test_l6", "--uri", "mongodb://127.0.0.1:27017,other-host/"]);
    assert.deepEqual([lines, code], [["STOPPED: The local test instance isn't configured (loopback only). Nothing was contacted."], 3]);
  });
});

describe("Server lifetime", () => {
  test("server.js starts the incremental catch up (not the full one) and drains the queue at shutdown", () => {
    const text = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
    assert.match(text, /dataLayer\?\.searchIndex\.start\(\);/);
    assert.doesNotMatch(text, /searchIndex\.catchUp\(/);
    assert.match(text, /searchIndex\.stop\(\{ timeoutMs: 5000 \}\)/);
  });
  test("start() returns at once (the pass runs in the background) and repeats; stop() drains within its bound", async () => {
    const w = await world(); await seeded(w); await w.index.catchUp();
    w.index.passEveryMs = 20;
    let passes = 0; const o = w.index.runPass.bind(w.index); w.index.runPass = async () => { passes += 1; return o(); };
    const t0 = Date.now(); const first = w.index.start(); assert.ok(Date.now() - t0 < 50);
    await first; await new Promise((r) => setTimeout(r, 70));
    assert.ok(passes >= 2, `periodic passes (${passes})`);
    const rec = (await w.repos.records.collection.find({}, { limit: 1 }).toArray())[0];
    w.index.refresh(rec.boardId, [rec._id]);
    assert.equal(await w.index.stop({ timeoutMs: 1000 }), true);
    assert.equal(w.index.queue.size, 0);
    const slow = await world(); const s2 = await seeded(slow);
    slow.index.rewrite = () => new Promise((r) => setTimeout(r, 300));
    slow.index.refresh(s2.a._id, [s2.ra[0]._id]);
    const t1 = Date.now(); assert.equal(await slow.index.stop({ timeoutMs: 30 }), false); assert.ok(Date.now() - t1 < 250, "bounded");
  });
  test("off: start, stop and every pass do nothing", async () => {
    const w = await world("off"); await seeded(w);
    assert.equal(w.index.start(), null);
    assert.deepEqual(await w.index.incremental(), { boards: 0, rewritten: 0 });
    assert.equal(await w.repos.recordSearch.count(), 0);
    assert.equal(await w.repos.recordSearch.state.countDocuments({}), 0);
  });
});
