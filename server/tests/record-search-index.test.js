// The search index behind global search (services/record-search-index.js), on the fake MongoDB with the real services:
// off changes nothing; results are identical to searching the records; access scope is unchanged; every kind of change
// reaches the index; a failure never affects a save; a catch up repairs anything missed.
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase, INDEXES, COLLECTIONS } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { searchParams } = require("../src/validation/search");
const { searchDocument, searchableKeys } = require("../src/services/record-search-index");
const { loadConfig } = require("../src/config");
const { FakeMongoClient } = require("./support/fake-mongo");

const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true }, { key: "notes", label: "Notes", type: "text" },
  { key: "status", label: "Status", type: "status", options: ["To do", "Done"] }, { key: "qty", label: "Qty", type: "number" },
  { key: "tags", label: "Tags", type: "dropdown", options: ["Red", "Blue"], multiple: true }, { key: "who", label: "Who", type: "owner" }, { key: "ok", label: "OK", type: "checkbox" }, { key: "due", label: "Due", type: "date" }
];
const quiet = { log() {}, warn() {}, error() {} };
const actor = Object.freeze({ userId: new ObjectId(), kind: "entra", displayName: "Tester" });
const people = { everyone: true };

async function world(mode, logger = quiet) {
  const fake = new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const dl = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), recordSearch: mode });
  dl.searchIndex.pauseMs = 0;
  return { dl, fake, s: dl.services, repos: dl.repos, index: dl.searchIndex, db: connection.db };
}
async function seed({ s, repos }) {
  const w1 = await s.workspaces.create({ name: "One" }, actor), w2 = await s.workspaces.create({ name: "Two" }, actor);
  const a = await s.boards.create(w1._id, { name: "Alpha", columns: COLUMNS }, actor), b = await s.boards.create(w1._id, { name: "Beta", columns: COLUMNS }, actor), secret = await s.boards.create(w2._id, { name: "Secret", columns: COLUMNS }, actor);
  const rows = (prefix, n) => Array.from({ length: n }, (_, i) => ({ values: { serial: `${prefix} ${i}`, notes: i % 3 === 0 ? `Lipa City, Batangas (a+b) ${prefix}` : `plain note ${i}`, status: i % 2 ? "To do" : "Done", qty: i, tags: i % 4 === 0 ? ["Red", "Blue"] : ["Red"], ok: true, due: "2026-03-15" } }));
  await s.records.createMany(a._id, { records: rows("ALPHA", 30) }, actor, people);
  await s.records.createMany(b._id, { records: rows("Beta", 12) }, actor, people);
  await s.records.createMany(secret._id, { records: [{ values: { serial: "Hidden zebra", notes: "secret zebra note" } }] }, actor, people);
  // Spread the update times, so ordering and paging are exercised, without going through the versioned API.
  let i = 0;
  for (const r of await repos.records.collection.find({}).toArray()) { i += 1; await repos.records.collection.updateOne({ _id: r._id }, { $set: { updatedAt: new Date(Date.UTC(2026, 0, 1 + (i % 25), 0, i)) } }); }
  const one = (await repos.records.collection.find({ boardId: a._id }).toArray())[1];
  await repos.records.collection.updateOne({ _id: one._id }, { $set: { archived: true } });
  return { w1, w2, a, b, secret, archivedId: one._id };
}
const access = { roles: null, globalRole: "SYSTEM_ADMIN" };
const search = (svc, query, scope = access) => svc.global(scope, searchParams({ type: "record", ...query }, actor.userId));
const recordsOf = (r) => r.groups.find((g) => g.type === "record");

describe("Off (the default)", () => {
  test("configuration defaults to off and refuses unknown values", () => {
    const base = { NODE_ENV: "development", DATA_STORE: "memory" };
    assert.equal(loadConfig(base).recordSearch, "off");
    assert.equal(loadConfig({ ...base, RECORD_SEARCH_INDEX: "on" }).recordSearch, "on");
    assert.throws(() => loadConfig({ ...base, RECORD_SEARCH_INDEX: "yes" }), /must be off, shadow or on/);
  });
  test("writes nothing and search reads the records, as it always has", async () => {
    const w = await world("off"); await seed(w);
    assert.deepEqual(await w.index.catchUp(), { boards: 0, rewritten: 0 });
    let usedRecords = 0; const original = w.repos.records.searchPage; w.repos.records.searchPage = (...a) => { usedRecords += 1; return original.apply(w.repos.records, a); };
    assert.equal(recordsOf(await search(w.s.search, { q: "alpha" })).items.length > 0, true);
    assert.ok(usedRecords > 0);
    await w.index.flush();
    assert.equal(await w.repos.recordSearch.count(), 0);
  });
  test("the collection and index exist, and the new active-record index is declared", () => {
    assert.equal(COLLECTIONS.recordSearch, "recordSearch");
    assert.ok(INDEXES.recordSearch.some((i) => i.name === "board_updated"));
    assert.ok(INDEXES.records.some((i) => i.name === "board_active"));
  });
});

describe("What is indexed", () => {
  const board = { columns: COLUMNS }, keys = searchableKeys(board);
  test("the same columns as the regular search: name and text-like cells, never people, numbers or checkboxes", () => {
    assert.deepEqual(keys, ["serial", "notes", "status", "tags", "due"]);
    const doc = searchDocument({ _id: 1, boardId: 2, archived: false, updatedAt: null, values: { serial: "AB-1", notes: "Hello World", qty: 77, who: ["user:abc"], ok: true, tags: ["Red", "Blue"], due: "2026-01-02" } }, keys);
    assert.equal(doc.name, "ab-1");
    assert.equal(doc.text, "ab-1\nhello world\nred\nblue\n2026-01-02");
    assert.doesNotMatch(doc.text, /77|user:|true/);
  });
});

describe("Results identical to searching the records", () => {
  let on, off, sOn, sOff;
  before(async () => {
    // The same data in two databases: IDs differ, so results are compared by item name.
    off = await world("off"); sOff = await seed(off);
    on = await world("on"); sOn = await seed(on);
    await on.index.catchUp();
    assert.equal(on.index.active, true);
  });
  const names = (r) => recordsOf(r).items.map((i) => i.title);
  const fields = (r) => recordsOf(r).items.map((i) => [i.title, i.field?.key ?? null, i.snippet]);

  for (const q of ["alpha", "ALPHA", "Lipa City", "lipa city, batangas", "(a+b)", "a+b", "plain note 2", "2026-03", "Red", "red", "zzqx-none", "beta 1", ".*", "[a", "to do"]) {
    test(`q=${q}: same records, same order, same matched field and snippet`, async () => {
      assert.deepEqual(fields(await search(on.s.search, { q })), fields(await search(off.s.search, { q })));
    });
  }
  test("no match across two cells: a query can't span a cell boundary", async () => {
    assert.equal(recordsOf(await search(on.s.search, { q: "alpha 1 plain" })).items.length, 0);
    assert.equal(recordsOf(await search(off.s.search, { q: "alpha 1 plain" })).items.length, 0);
  });
  test("archived records stay out; numbers, people and checkboxes are not searched", async () => {
    const archived = await on.repos.records.findById(sOn.archivedId);
    assert.ok(!names(await search(on.s.search, { q: archived.values.serial })).includes(archived.values.serial));
  });
  test("a filter to one board, and a date range, give the same results", async () => {
    assert.deepEqual(names(await search(on.s.search, { q: "plain", boardId: sOn.b._id.toHexString() })), names(await search(off.s.search, { q: "plain", boardId: sOff.b._id.toHexString() })));
    assert.deepEqual(names(await search(on.s.search, { q: "plain", from: "2026-01-05", to: "2026-01-09" })), names(await search(off.s.search, { q: "plain", from: "2026-01-05", to: "2026-01-09" })));
  });
  test("paging reaches every match exactly as before", async () => {
    const walk = async (svc) => { const seen = []; let cursor; for (let i = 0; i < 20; i += 1) { const g = recordsOf(await search(svc, { q: "plain", limit: "5", ...(cursor ? { cursor } : {}) })); seen.push(...g.items.map((x) => x.title)); if (!g.next) break; cursor = g.next; } return [...new Set(seen)].sort(); };
    assert.deepEqual(await walk(on.s.search), await walk(off.s.search));
  });
  test("searches with a status filter stay on the records and give the same results", async () => {
    let used = 0; const o = on.repos.records.searchPage; on.repos.records.searchPage = (...a) => { used += 1; return o.apply(on.repos.records, a); };
    const a = names(await search(on.s.search, { q: "plain", status: "Done" })); on.repos.records.searchPage = o;
    assert.ok(used > 0);
    assert.deepEqual(a, names(await search(off.s.search, { q: "plain", status: "Done" })));
  });
  test("the older /search endpoint gives the same records", async () => {
    const list = async (w) => (await w.s.search.records("plain", { workspaceIds: null, limit: 50 })).items.map((i) => i.title).sort();
    assert.deepEqual(await list(on), await list(off));
  });
  test("access is unchanged: a caller limited to one workspace never sees another's records", async () => {
    const scope = { roles: new Map([[sOn.w1._id.toHexString(), "VIEWER"]]), globalRole: null };
    assert.equal(names(await search(on.s.search, { q: "zebra" }, scope)).length, 0);
    assert.deepEqual(names(await search(on.s.search, { q: "zebra" })), ["Hidden zebra"]);
    const other = { roles: new Map([[sOn.w2._id.toHexString(), "VIEWER"]]), globalRole: null };
    assert.equal(names(await search(on.s.search, { q: "alpha" }, other)).length, 0);
  });
  test("the search itself is bounded: time limit and result limit reach the index query", async () => {
    let options; const o = on.repos.recordSearch.searchPage; on.repos.recordSearch.searchPage = (c, opts) => { options = opts; return o.call(on.repos.recordSearch, c, opts); };
    await search(on.s.search, { q: "plain" }); on.repos.recordSearch.searchPage = o;
    assert.ok(options.maxTimeMS > 0 && options.limit > 0);
  });
  test("a time-out from the index is the same clear error as before", async () => {
    const o = on.repos.recordSearch.searchPage; on.repos.recordSearch.searchPage = async () => { throw Object.assign(new Error("limit"), { code: 50, codeName: "MaxTimeMSExpired" }); };
    await assert.rejects(() => search(on.s.search, { q: "plain" }), (e) => e.code === "SEARCH_TIMEOUT");
    on.repos.recordSearch.searchPage = o;
  });
});

describe("Every change reaches the index", () => {
  let w, seeded;
  const clean = async () => { await w.index.flush(); return w.index.verify(); };
  const titles = async (q) => recordsOf(await search(w.s.search, { q })).items.map((i) => i.title);
  before(async () => { w = await world("on"); seeded = await seed(w); await w.index.catchUp(); });

  test("after catching up: nothing missing, stale or extra", async () => {
    assert.deepEqual(await clean(), { boards: 3, records: 43, indexed: 43, missing: 0, stale: 0, extra: 0 });
  });
  test("create, edit and delete one record", async () => {
    const doc = await w.s.records.create(seeded.a._id, { values: { serial: "Fresh unicorn" } }, actor, people);
    await w.index.flush(); assert.deepEqual(await titles("unicorn"), ["Fresh unicorn"]);
    const edited = await w.s.records.update(doc._id, { expectedVersion: 1, values: { serial: "Renamed pegasus" } }, actor, people);
    await w.index.flush(); assert.deepEqual([await titles("unicorn"), await titles("pegasus")], [[], ["Renamed pegasus"]]);
    await w.s.records.delete(doc._id, edited.version, actor);
    await w.index.flush(); assert.deepEqual(await titles("pegasus"), []);
    assert.equal((await clean()).missing + (await clean()).extra, 0);
  });
  test("archiving hides a record; restoring brings it back", async () => {
    const doc = await w.s.records.create(seeded.a._id, { values: { serial: "Archive falcon" } }, actor, people);
    const a = await w.s.records.update(doc._id, { expectedVersion: 1, archived: true }, actor, people);
    await w.index.flush(); assert.deepEqual(await titles("falcon"), []);
    await w.s.records.update(doc._id, { expectedVersion: a.version, archived: false }, actor, people);
    await w.index.flush(); assert.deepEqual(await titles("falcon"), ["Archive falcon"]);
  });
  test("batch create, update and delete", async () => {
    const made = await w.s.records.createMany(seeded.b._id, { records: [{ values: { serial: "Batch otter 1" } }, { values: { serial: "Batch otter 2" } }] }, actor, people);
    await w.index.flush(); assert.equal((await titles("otter")).length, 2);
    const done = await w.s.records.updateMany(seeded.b._id, { items: made.map((m) => ({ id: m._id.toHexString(), expectedVersion: m.version, values: { serial: `Batch badger ${m.values.serial.slice(-1)}` } })) }, actor, people);
    await w.index.flush(); assert.deepEqual([(await titles("otter")).length, (await titles("badger")).length], [0, 2]);
    await w.s.records.deleteMany(seeded.b._id, { records: done.map((m) => ({ id: m._id.toHexString(), expectedVersion: m.version })) }, actor);
    await w.index.flush(); assert.equal((await titles("badger")).length, 0);
  });
  test("deleting a column removes its text from the index", async () => {
    await w.s.records.create(seeded.b._id, { values: { serial: "Column test", notes: "walrus text" } }, actor, people);
    await w.index.flush(); assert.deepEqual(await titles("walrus"), ["Column test"]);
    const board = await w.repos.boards.findById(seeded.b._id);
    await w.s.schema.deleteColumn(seeded.b._id, "notes", { expectedVersion: String(board.version) }, actor);
    await w.index.flush(); assert.deepEqual(await titles("walrus"), []);
    assert.equal((await clean()).stale, 0);
  });
  test("deleting a board and a workspace removes their index documents", async () => {
    const board = await w.repos.boards.findById(seeded.b._id);
    await w.s.boards.delete(seeded.b._id, board.version, actor);
    await w.index.flush();
    assert.equal(await w.repos.recordSearch.count({ boardId: seeded.b._id }), 0);
    const ws = await w.repos.workspaces.findById(seeded.w2._id);
    await w.s.workspaces.delete(seeded.w2._id, ws.version, actor);
    await w.index.flush();
    assert.equal(await w.repos.recordSearch.count({ boardId: seeded.secret._id }), 0);
    assert.deepEqual(await titles("zebra"), []);
  });
});

describe("Failures and recovery", () => {
  test("search keeps using the records until the index has caught up", async () => {
    const w = await world("on"); await seed(w);
    assert.equal(w.index.active, false);
    assert.ok(recordsOf(await search(w.s.search, { q: "plain" })).items.length > 0, "results before the index is ready");
    await w.index.catchUp();
    assert.equal(w.index.active, true);
  });
  test("a failing index never fails or delays a save; it is logged, and the next catch up repairs it", async () => {
    const errors = [], w = await world("on", { ...quiet, error: (m) => errors.push(m) }); const seeded = await seed(w); await w.index.catchUp();
    const original = w.repos.recordSearch.upsertMany; w.repos.recordSearch.upsertMany = async () => { throw new Error("index down mongodb://user:secret@host"); };
    const doc = await w.s.records.create(seeded.a._id, { values: { serial: "Survivor heron" } }, actor, people);
    assert.equal(doc.values.serial, "Survivor heron");
    await w.index.flush();
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0], /secret/, "error text is redacted");
    w.repos.recordSearch.upsertMany = original;
    assert.equal((await w.index.verify()).missing, 1);
    await w.index.catchUp();
    assert.deepEqual([(await w.index.verify()).missing, recordsOf(await search(w.s.search, { q: "heron" })).items.length], [0, 1]);
  });
  test("catch up repairs records changed behind its back, and only rewrites what differs", async () => {
    const w = await world("on"); const seeded = await seed(w); await w.index.catchUp();
    assert.equal((await w.index.catchUp()).rewritten, 0, "nothing to do the second time");
    const r = await w.repos.records.collection.findOne({ boardId: seeded.a._id, archived: false });
    await w.repos.records.collection.updateOne({ _id: r._id }, { $set: { "values.serial": "Direct edit lynx", updatedAt: new Date() } });
    assert.equal((await w.index.catchUp()).rewritten, 1);
    assert.equal(recordsOf(await search(w.s.search, { q: "lynx" })).items.length, 1);
  });
  test("never writes to the records collection", async () => {
    const w = await world("on"); await seed(w);
    const before = JSON.stringify(await w.repos.records.collection.find({}).sort({ _id: 1 }).toArray());
    await w.index.catchUp(); await w.index.verify();
    assert.equal(JSON.stringify(await w.repos.records.collection.find({}).sort({ _id: 1 }).toArray()), before);
  });
  test("shadow: serves the regular results, keeps the index current, and reports only counts of differences", async () => {
    const warnings = [], w = await world("shadow", { ...quiet, warn: (m) => warnings.push(m) }); const seeded = await seed(w); await w.index.catchUp();
    assert.deepEqual([w.index.active, w.index.shadowing], [false, true]);
    assert.ok(recordsOf(await search(w.s.search, { q: "plain" })).items.length > 0);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(warnings, [], "no differences on matching data");
    const one = await w.repos.records.collection.findOne({ boardId: seeded.a._id, archived: false });
    await w.repos.recordSearch.removeMany([one._id]);
    await search(w.s.search, { q: one.values.serial });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /only regular 1/);
    assert.ok(!warnings[0].includes(one.values.serial), "never the search text");
  });
});
