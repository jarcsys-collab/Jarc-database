// Command Center search (services/search-service.js global): one time budget per request shared by records, the item-name
// lookup and comments; no second records scan when the first already holds every match; comments skipped or cut short with a
// flag (never silently) when the budget runs out; more / next from live results only; the board cap stated explicitly.
// Offline: fake MongoDB with the real services, and a fake clock.
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { searchParams } = require("../src/validation/search");
const { MAX_TIME_MS, MAX_BOARDS, SEARCH_ERRORS, timeBudget } = require("../src/services/search-service");
const { FakeMongoClient } = require("./support/fake-mongo");

const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "notes", label: "Notes", type: "text" }, { key: "status", label: "Status", type: "status", options: ["Open", "Done"] }];
const quiet = { log() {}, warn() {}, error() {} };
const actor = Object.freeze({ userId: new ObjectId(), kind: "entra", displayName: "Tester" });
const access = { roles: null, globalRole: "SYSTEM_ADMIN" };
const TIMEOUT = () => Object.assign(new Error("time limit"), { code: 50, codeName: "MaxTimeMSExpired" });

async function world(mode = "off") {
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => new FakeMongoClient() });
  await connection.connect();
  await ensureDatabase(connection.db);
  const dl = createDataLayer({ connection, logger: quiet, fileStore: new MemoryFileStore(), recordSearch: mode });
  dl.searchIndex.pauseMs = 0; dl.searchIndex.repairMs = 0;
  const s = dl.services, repos = dl.repos;
  const ws = await s.workspaces.create({ name: "Ops" }, actor);
  const board = await s.boards.create(ws._id, { name: "Pumps", columns: COLUMNS }, actor);
  const rows = [
    ...Array.from({ length: 15 }, (_, i) => ({ values: { serial: `Pump station ${i}`, notes: "routine", status: "Open" } })),
    { values: { serial: "Valve kalamansi", notes: "spare", status: "Done" } },
    { values: { serial: "Other job", notes: "has kalamansi inside", status: "Open" } }
  ];
  await s.records.createMany(board._id, { records: rows }, actor, { everyone: true });
  let i = 0;
  const all = await repos.records.collection.find({}).toArray();
  for (const r of all) { i += 1; await repos.records.collection.updateOne({ _id: r._id }, { $set: { updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)) } }); }
  if (mode === "on") await dl.searchIndex.catchUp();
  const byName = async (name) => repos.records.collection.findOne({ "values.serial": name });
  return { dl, s, repos, ws, board, byName, connection };
}

// Counts (and optionally slows or fails) the records and comments queries; t is the fake clock.
function instrument(w, { recordsCost = 0, commentsCost = 0, failRecords = null, failComments = null } = {}) {
  const clock = { t: 0 }, calls = { records: [], comments: [] };
  w.s.search.now = () => clock.t;
  const records = w.repos.records, original = records.searchPage.bind(records);
  records.searchPage = async (clauses, o) => { calls.records.push(o); clock.t += recordsCost; if (failRecords?.(calls.records.length)) throw TIMEOUT(); return original(clauses, o); };
  const comments = w.repos.comments, originalC = comments.searchPage.bind(comments);
  comments.searchPage = async (filter, o) => { calls.comments.push(o); clock.t += commentsCost; if (failComments?.(calls.comments.length)) throw TIMEOUT(); return originalC(filter, o); };
  return { clock, calls };
}
const run = (w, query) => w.s.search.global(access, searchParams(query, actor.userId));
const group = (res, type) => res.groups.find((g) => g.type === type);
const addComment = (w, record, body, minute) => w.repos.comments.insert({ _id: new ObjectId(), workspaceId: record.workspaceId, boardId: record.boardId, recordId: record._id, parentId: null, authorId: actor.userId, authorName: "Tester", body, mentions: [], createdAt: new Date(Date.UTC(2026, 1, 1, 0, minute)), updatedAt: new Date(), editedAt: null, deletedAt: null, deletedBy: null, version: 1 });

describe("one time budget per request", () => {
  let w;
  beforeEach(async () => { w = await world(); });

  test("a rare term reads the records once: the name matches come from the main results, name first as before", async () => {
    const { calls } = instrument(w);
    const res = await run(w, { q: "kalamansi", type: "record,comment" });
    assert.equal(calls.records.length, 1, "no second scan for the name boost");
    assert.deepEqual(group(res, "record").items.map((i) => i.title), ["Valve kalamansi", "Other job"], "item-name match still leads");
    assert.equal(group(res, "record").more, false);
    assert.equal(calls.records[0].maxTimeMS, MAX_TIME_MS);
  });

  test("a common term runs the name query after the main one, with only what is left of the budget", async () => {
    const { calls } = instrument(w, { recordsCost: 1200, commentsCost: 100 });
    const res = await run(w, { q: "pump", type: "record,comment" });
    assert.equal(calls.records.length, 2);
    assert.deepEqual(calls.records.map((o) => o.maxTimeMS), [3000, 1800]);
    assert.equal(calls.comments[0].maxTimeMS, 600, "comments get the rest, not another 3 s");
    assert.equal(group(res, "record").items.length, 10);
    assert.equal(group(res, "record").more, true);
    assert.deepEqual([res.partial, res.partialReasons], [false, []]);
  });

  test("when the budget is spent, comments are skipped and flagged — never silently missing", async () => {
    const { calls } = instrument(w, { recordsCost: 1480 });
    const res = await run(w, { q: "pump", type: "record,comment" });
    assert.equal(calls.comments.length, 0, "no comment query started");
    assert.deepEqual(group(res, "comment"), { type: "comment", items: [], more: false, next: null, partial: true, reason: "time_budget" });
    assert.equal(group(res, "record").items.length, 10, "records kept");
    assert.deepEqual([res.partial, res.partialReasons], [true, ["time_budget"]]);
  });

  test("a records time-out stays 503 SEARCH_TIMEOUT and nothing else runs", async () => {
    const { calls } = instrument(w, { failRecords: () => true });
    await assert.rejects(() => run(w, { q: "kalamansi" }), (e) => e.status === 503 && e.code === "SEARCH_TIMEOUT" && /took too long/.test(e.message));
    assert.deepEqual([calls.records.length, calls.comments.length], [1, 0]);
  });

  test("the name query timing out keeps the records found (flagged partial)", async () => {
    instrument(w, { failRecords: (n) => n === 2 });
    const res = await run(w, { q: "pump", type: "record" });
    assert.equal(group(res, "record").items.length, 10);
    assert.deepEqual([group(res, "record").partial, group(res, "record").reason, res.partialReasons], [true, "time_budget", ["time_budget"]]);
  });

  test("a comment time-out: partial with other types, 503 for a comments-only search", async () => {
    const valve = await w.byName("Valve kalamansi");
    await addComment(w, valve, "kalamansi delivery", 1);
    instrument(w, { failComments: () => true });
    const mixed = await run(w, { q: "kalamansi", type: "record,comment" });
    assert.equal(group(mixed, "record").items.length, 2);
    assert.deepEqual([group(mixed, "comment").partial, group(mixed, "comment").items], [true, []]);
    await assert.rejects(() => run(w, { q: "kalamansi", type: "comment" }), (e) => e.status === 503 && e.code === "SEARCH_TIMEOUT");
  });

  test("the budget never exceeds 3 s and never goes below 1 ms per query", () => {
    let t = 0;
    const b = timeBudget(MAX_TIME_MS, () => t);
    assert.equal(b.ms(), 3000); t = 2960; assert.equal(b.spent(), true); assert.equal(b.ms(), 40); t = 5000; assert.equal(b.ms(), 1);
    w.s.search.budgetMs = 10000; w.s.search.now = () => 0;
    assert.equal(w.s.search.budget().ms(), MAX_TIME_MS);
    assert.deepEqual(SEARCH_ERRORS.SEARCH_UNAVAILABLE.status, 503);
  });
});

describe("counts and flags from live results only", () => {
  test("comment more: comments on archived records no longer make an empty page claim more", async () => {
    const w = await world();
    const valve = await w.byName("Valve kalamansi"), other = await w.byName("Other job"), gone = await w.byName("Pump station 3");
    await addComment(w, valve, "kalamansi one", 1); await addComment(w, other, "kalamansi two", 2);
    for (const m of [10, 11, 12]) await addComment(w, gone, `kalamansi on archived ${m}`, m);
    await w.repos.records.collection.updateOne({ _id: gone._id }, { $set: { archived: true } });
    const res = await run(w, { q: "kalamansi", type: "comment", limit: "2" });
    const g = group(res, "comment");
    assert.deepEqual(g.items.map((i) => i.snippet).sort(), ["kalamansi one", "kalamansi two"], "the live comments, not an empty page");
    assert.deepEqual([g.more, g.next], [false, null]);
  });

  test("comment paging continues after the last shown live comment", async () => {
    const w = await world();
    const valve = await w.byName("Valve kalamansi");
    for (const m of [1, 2, 3, 4, 5]) await addComment(w, valve, `kalamansi ${m}`, m);
    const first = group(await run(w, { q: "kalamansi", type: "comment", limit: "2" }), "comment");
    assert.deepEqual([first.items.map((i) => i.snippet), first.more], [["kalamansi 5", "kalamansi 4"], true]);
    const second = group(await run(w, { q: "kalamansi", type: "comment", limit: "2", cursor: first.next }), "comment");
    assert.deepEqual(second.items.map((i) => i.snippet), ["kalamansi 3", "kalamansi 2"]);
  });

  test("index on: a stale index hit doesn't make more true (the old found counted it)", async () => {
    const w = await world("on");
    assert.ok(w.dl.searchIndex.active);
    // 15 "pump" names; limit 14 → 15 index hits. Archive one behind the index's back: 14 live, so no more.
    const stale = await w.byName("Pump station 7");
    await w.repos.records.collection.updateOne({ _id: stale._id }, { $set: { archived: true } });
    const g = group(await run(w, { q: "pump station", type: "record", limit: "14" }), "record");
    assert.equal(g.items.length, 14);
    assert.ok(!g.items.some((i) => i.id === stale._id.toHexString()));
    assert.deepEqual([g.more, g.next], [false, null]);
    const two = group(await run(w, { q: "pump station", type: "record", limit: "13" }), "record");
    assert.deepEqual([two.items.length, two.more], [13, true], "a real next page still says more");
  });
});

describe("the board cap is explicit", () => {
  test("more than 300 visible boards: partial with board_cap and maxBoards", async () => {
    const w = await world();
    const original = w.repos.boards.listForSearch.bind(w.repos.boards);
    w.repos.boards.listForSearch = async (ids, o) => {
      const real = await original(ids, o);
      return [...real, ...Array.from({ length: MAX_BOARDS }, (_, i) => ({ _id: new ObjectId(), workspaceId: w.ws._id, name: `Filler ${i}`, columns: COLUMNS }))].slice(0, o.limit);
    };
    const res = await run(w, { q: "kalamansi", type: "record" });
    assert.deepEqual([res.partial, res.partialReasons, res.maxBoards], [true, ["board_cap"], MAX_BOARDS]);
    assert.equal(group(res, "record").items.length, 2);
  });
});

describe("validation", () => {
  test("1-character q is rejected with a clear message, also with a filter; filters alone work", async () => {
    for (const query of [{ q: "k" }, { q: "k", status: "Open" }]) assert.throws(() => searchParams(query, actor.userId), (e) => e.status === 400 && /at least 2 characters/.test(e.message));
    assert.throws(() => searchParams({ q: "x".repeat(101) }, actor.userId), /at most 100 characters/);
    const w = await world();
    const res = await run(w, { status: "Done", type: "record" });
    assert.deepEqual(group(res, "record").items.map((i) => i.title), ["Valve kalamansi"]);
  });
});
