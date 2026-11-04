// Server-side filtering of a board's records (domain/record-filter.js). Validation and the API on the fake MongoDB; the same
// conditions on the VERIFIED LOCAL TEST INSTANCE (skipped when it isn't running) against the browser's rules, so server and
// browser always agree; a pagination walk; and the guarantees: Main Table's list is unchanged and access still applies.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { ObjectId, MongoClient } = require("mongodb");
const F = require("../src/domain/record-filter");
const validate = require("../src/validation/resources");
const { normalizeSavedViews } = require("../src/domain/board-schema");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { FakeMongoClient } = require("./support/fake-mongo");
const { loadBrowser } = require("./support/browser-model");

const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true }, { key: "eng", label: "Engineer", type: "text" }, { key: "state", label: "State", type: "status", options: ["Open", "Done"] },
  { key: "linked", label: "Linked", type: "text" }, { key: "qty", label: "Qty", type: "number" }, { key: "ok", label: "OK", type: "checkbox" }, { key: "tags", label: "Tags", type: "dropdown", options: ["Red", "Blue", "Green"], multiple: true }, { key: "notes", label: "Notes", type: "text" }, { key: "group", label: "Group", type: "group" }
];
const board = { columns: COLUMNS, groups: [] };
const quiet = { log() {}, warn() {}, error() {} };
const actor = Object.freeze({ userId: new ObjectId(), kind: "entra", displayName: "Tester" });

describe("Validation", () => {
  const f = (over) => ({ op: "and", rules: [{ key: "eng", cmp: "in", values: ["A"] }], ...over });
  test("accepts the documented shape and keeps only what it knows", () => {
    assert.deepEqual(F.filterForBoard({ op: "or", rules: [{ key: "eng", cmp: "empty" }], groups: [{ op: "and", rules: [{ key: "state", cmp: "notIn", values: ["Done", ""] }] }] }, board), { op: "or", rules: [{ key: "eng", cmp: "empty" }], groups: [{ op: "and", rules: [{ key: "state", cmp: "notIn", values: ["Done", ""] }] }] });
  });
  test("refuses anything unexpected: operators, unknown columns, wrong types, too much", () => {
    const refused = [
      null, [], "x", f({ op: "nor" }), f({ extra: 1 }), f({ rules: [] }), f({ rules: [{ key: "$where", cmp: "in", values: ["1"] }] }), f({ rules: [{ key: "values.eng", cmp: "in", values: ["1"] }] }), f({ rules: [{ key: "__proto__", cmp: "in", values: ["1"] }] }),
      f({ rules: [{ key: "eng", cmp: "$gt", values: ["1"] }] }), f({ rules: [{ key: "eng", cmp: "in", values: [{ $gt: "" }] }] }), f({ rules: [{ key: "eng", cmp: "in", values: "A" }] }), f({ rules: [{ key: "eng", cmp: "in" }] }), f({ rules: [{ key: "eng", cmp: "in", values: ["x"], extra: 1 }] }),
      f({ rules: [{ key: "gone", cmp: "in", values: ["x"] }] }), f({ rules: [{ key: "group", cmp: "in", values: ["x"] }] }), f({ rules: Array(26).fill({ key: "eng", cmp: "empty" }) }), f({ rules: [{ key: "eng", cmp: "in", values: Array(101).fill("x") }] }), f({ rules: [{ key: "eng", cmp: "in", values: ["x".repeat(501)] }] }), f({ groups: [{ op: "and", rules: [{ key: "eng", cmp: "empty" }], groups: [] }] })
    ];
    for (const bad of refused) assert.throws(() => F.filterForBoard(bad, board), (e) => e.status === 400 || e.statusCode === 400 || e.code === "VALIDATION_ERROR", JSON.stringify(bad)?.slice(0, 80));
    for (const bad of [[], [{ key: "eng" }], [{ key: "eng", dir: "up" }], [{ key: "gone", dir: "asc" }], Array(5).fill({ key: "eng", dir: "asc" })]) assert.throws(() => F.orderByForBoard(bad, board), undefined, JSON.stringify(bad)?.slice(0, 80));
  });
  test("query text is validated: bad JSON, oversized, mixed with sort", () => {
    for (const q of [{ filter: "{" }, { orderBy: "nope" }, { filter: JSON.stringify({ op: "and", rules: [{ key: "eng", cmp: "in", values: ["x".repeat(7000)] }] }) }, { filter: JSON.stringify(f()), sort: "updated" }, { unknown: "1" }]) assert.throws(() => validate.recordListQuery(q, board), undefined, JSON.stringify(q).slice(0, 60));
  });
  test("values are matched literally: regular expression characters are escaped", () => {
    const q = F.filterQuery(F.filterForBoard({ op: "and", rules: [{ key: "notes", cmp: "contains", values: [".*(a|b)$"] }] }, board), board);
    assert.equal(q.$or[0]["values.notes"].$regex, "\\.\\*\\(a\\|b\\)\\$");
  });
  test("a cursor is tied to its ordering and refused when damaged", () => {
    const orderBy = F.orderByForBoard([{ key: "eng", dir: "asc" }], board);
    const good = F.encodeCursor(orderBy, { _id: new ObjectId(), values: { eng: "A" } });
    assert.deepEqual(F.decodeCursor(good, orderBy).values, ["A"]);
    assert.throws(() => F.decodeCursor(good, F.orderByForBoard([{ key: "eng", dir: "desc" }], board)));
    for (const bad of ["x", "!!!", Buffer.from('{"o":["eng:asc"],"v":[{"$gt":1}],"i":"zz"}').toString("base64url")]) assert.throws(() => F.decodeCursor(bad, orderBy));
  });
  test("saved views store a filter and an order, checked for shape; other nested settings stay refused", () => {
    const now = new Date(), id = new ObjectId();
    const [v] = normalizeSavedViews([{ id: "view_m123456", name: "V", state: { view: "table", filter: { op: "and", rules: [{ key: "eng", cmp: "in", values: ["A"] }] }, orderBy: [{ key: "eng", dir: "asc" }] } }], { actorId: id, now });
    assert.equal(v.state.filter.rules[0].key, "eng");
    assert.throws(() => normalizeSavedViews([{ name: "V", state: { filter: { op: "and", rules: [{ key: "$x", cmp: "in", values: ["A"] }] } } }], { actorId: id, now }));
    assert.throws(() => normalizeSavedViews([{ name: "V", state: { other: { a: { b: 1 } } } }], { actorId: id, now }));
  });
});

// The same scenario on the fake MongoDB (always) and on real MongoDB (when the local test instance runs).
function rows(n) {
  const engs = ["Mark Gutierrez", "Axyll Pandan", "", null, undefined, "JR Pagulayan"], links = ["Item A", "Item A, Item B", "Lipa City, Batangas", "", null, "Item C, Lipa City, Batangas"];
  return Array.from({ length: n }, (_, i) => {
    const values = { serial: `R${String(i).padStart(4, "0")}`, state: i % 3 === 0 ? "Open" : i % 3 === 1 ? "Done" : "", linked: links[i % links.length], qty: i % 4 === 0 ? String(i) : i % 4 === 1 ? i : null, ok: i % 2 === 0, tags: i % 5 === 0 ? ["Red", "Blue"] : i % 5 === 1 ? ["Green"] : [], notes: i % 7 === 0 ? "Needs (urgent) check" : "routine" };
    const e = engs[i % engs.length]; if (e !== undefined) values.eng = e;
    return { values, position: (i % 11) * 1000 + i, archived: i % 13 === 0 };
  });
}
const CASES = [
  { op: "and", rules: [{ key: "eng", cmp: "in", values: ["Mark Gutierrez"] }] },
  { op: "and", rules: [{ key: "eng", cmp: "in", values: ["Mark Gutierrez", "JR Pagulayan"] }] },
  { op: "and", rules: [{ key: "eng", cmp: "in", values: [""] }] },
  { op: "and", rules: [{ key: "eng", cmp: "notIn", values: ["Mark Gutierrez"] }] },
  { op: "and", rules: [{ key: "eng", cmp: "notIn", values: ["", "Axyll Pandan"] }] },
  { op: "and", rules: [{ key: "eng", cmp: "empty" }] }, { op: "and", rules: [{ key: "eng", cmp: "notEmpty" }] },
  { op: "and", rules: [{ key: "tags", cmp: "empty" }] }, { op: "and", rules: [{ key: "tags", cmp: "notEmpty" }] },
  { op: "and", rules: [{ key: "tags", cmp: "in", values: ["Blue"] }] }, { op: "and", rules: [{ key: "tags", cmp: "notIn", values: ["Blue"] }] },
  { op: "and", rules: [{ key: "notes", cmp: "contains", values: ["URGENT"] }] }, { op: "and", rules: [{ key: "notes", cmp: "contains", values: ["(urgent)"] }] }, { op: "and", rules: [{ key: "notes", cmp: "notContains", values: ["urgent"] }] },
  { op: "and", rules: [{ key: "linked", cmp: "anyToken", values: ["Item A"] }] }, { op: "and", rules: [{ key: "linked", cmp: "anyToken", values: ["Item B", "Item C"] }] }, { op: "and", rules: [{ key: "linked", cmp: "anyToken", values: ["Lipa City, Batangas"] }] }, { op: "and", rules: [{ key: "linked", cmp: "anyToken", values: [""] }] },
  { op: "and", rules: [{ key: "linked", cmp: "noToken", values: ["Item A"] }] }, { op: "and", rules: [{ key: "linked", cmp: "noToken", values: ["Lipa City, Batangas", ""] }] },
  { op: "and", rules: [{ key: "qty", cmp: "in", values: ["8"] }] }, { op: "and", rules: [{ key: "qty", cmp: "in", values: ["9"] }] }, { op: "and", rules: [{ key: "ok", cmp: "in", values: ["true"] }] },
  { op: "or", rules: [{ key: "eng", cmp: "in", values: ["Axyll Pandan"] }, { key: "state", cmp: "in", values: ["Done"] }] },
  { op: "and", rules: [{ key: "eng", cmp: "in", values: ["Axyll Pandan"] }, { key: "state", cmp: "notIn", values: ["Done"] }, { key: "linked", cmp: "noToken", values: ["Item A"] }] },
  { op: "and", rules: [], groups: [{ op: "or", rules: [{ key: "eng", cmp: "empty" }, { key: "state", cmp: "in", values: ["Open"] }] }, { op: "and", rules: [{ key: "ok", cmp: "in", values: ["true"] }] }] },
  { op: "or", rules: [{ key: "notes", cmp: "contains", values: ["urgent"] }], groups: [{ op: "and", rules: [{ key: "eng", cmp: "in", values: ["JR Pagulayan"] }, { key: "state", cmp: "in", values: ["Done"] }] }] }
];
async function scenario(world, s) {
  const ws = await s.workspaces.create({ name: "W" }, actor), b = await s.boards.create(ws._id, { name: "Big", columns: COLUMNS.filter((c) => c.key !== "group"), groups: [{ name: "One" }, { name: "Two" }] }, actor);
  const docs = rows(180).map((r, i) => ({ _id: new ObjectId(), workspaceId: ws._id, boardId: b._id, values: r.values, groupId: b.groups[i % 2].id, position: r.position, archived: r.archived, pinned: false, createdBy: actor.userId, updatedBy: actor.userId, createdAt: new Date(2026, 0, 1, 0, i), updatedAt: new Date(2026, 0, 1, 0, 200 - i), version: 1 }));
  await world.db.collection("records").insertMany(docs);
  return { ws, b, docs };
}
let browserProto = null;
const browserModel = () => (browserProto ||= loadBrowser().window.BoardModel.prototype);
const clientMatch = (filter, rowValues) => { const proto = browserModel(); const m = Object.create(proto); return m.matchesFilterNode(rowValues, filter); };
function shared(getWorld) {
  const list = (s, b, query) => s.records.list(b._id, query);
  test("every condition: the server returns exactly the records the browser's rules select, with correct totals", async () => {
    const { s, ctx } = getWorld(), active = ctx.docs.filter((d) => !d.archived);
    for (const filter of CASES) {
      const got = []; let cursor = null, pages = 0;
      do { const page = await list(s, ctx.b, { filter: JSON.stringify(filter), limit: "40", ...(cursor ? { cursor } : {}) }); got.push(...page.items.map((d) => d._id.toHexString())); cursor = page.nextCursor; pages += 1; } while (cursor && pages < 50);
      const expected = active.filter((d) => clientMatch(filter, d.values)).map((d) => d._id.toHexString());
      assert.deepEqual([...got].sort(), [...expected].sort(), `page walk: ${JSON.stringify(filter)}`);
      assert.equal(new Set(got).size, got.length, "no duplicates across pages");
      const count = await s.records.count(ctx.b._id, { filter: JSON.stringify(filter) });
      assert.equal(count.total, expected.length, `count: ${JSON.stringify(filter)}`);
      assert.equal(Object.values(count.groups).reduce((a, n) => a + n, 0), expected.length);
    }
  });
  test("pagination holds for each ordering: nothing lost, nothing repeated, in order, nulls included", async () => {
    const { s, ctx } = getWorld(), total = ctx.docs.filter((d) => !d.archived).length;
    for (const orderBy of [[{ key: "position", dir: "asc" }], [{ key: "updatedAt", dir: "desc" }], [{ key: "eng", dir: "asc" }], [{ key: "eng", dir: "desc" }], [{ key: "state", dir: "asc" }, { key: "eng", dir: "desc" }], [{ key: "qty", dir: "asc" }], [{ key: "qty", dir: "desc" }, { key: "serial", dir: "asc" }]]) {
      const got = []; let cursor = null, pages = 0;
      do { const page = await list(s, ctx.b, { orderBy: JSON.stringify(orderBy), limit: "17", ...(cursor ? { cursor } : {}) }); got.push(...page.items.map((d) => d._id.toHexString())); cursor = page.nextCursor; pages += 1; } while (cursor && pages < 40);
      if (orderBy.some((o) => o.key === "qty") && !getWorld().real) continue; // mixed text and numbers order only with real MongoDB's collation
      assert.equal(got.length, total, JSON.stringify(orderBy));
      assert.equal(new Set(got).size, total, `no repeats: ${JSON.stringify(orderBy)}`);
    }
  });
  test("archived records stay out by default and can be asked for", async () => {
    const { s, ctx } = getWorld(), filter = JSON.stringify({ op: "and", rules: [{ key: "serial", cmp: "notEmpty" }] });
    assert.equal((await s.records.count(ctx.b._id, { filter })).total, ctx.docs.filter((d) => !d.archived).length);
    assert.equal((await s.records.count(ctx.b._id, { filter, archived: "true" })).total, ctx.docs.filter((d) => d.archived).length);
    const page = await list(s, ctx.b, { filter, archived: "true", limit: "200" });
    assert.ok(page.items.every((d) => d.archived));
  });
  test("Main Table's list is unchanged when no filter is sent: same order, same cursor kind", async () => {
    const { s, ctx } = getWorld();
    const page = await list(s, ctx.b, { limit: "10" });
    assert.deepEqual(page.items.map((d) => d.position), [...page.items.map((d) => d.position)].sort((a, b) => a - b));
    assert.ok(page.items.some((d) => d.archived) || ctx.docs.filter((d) => d.archived).every((d) => d.position > page.items.at(-1).position), "archived records aren't removed from the plain list");
    const decoded = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString());
    assert.equal(decoded.s, "position");
  });
  test("a filter never reaches another board's records", async () => {
    const { s, ctx, world } = getWorld();
    const other = await s.boards.create(ctx.ws._id, { name: "Other", columns: COLUMNS.filter((c) => c.key !== "group") }, actor);
    await world.db.collection("records").insertOne({ _id: new ObjectId(), workspaceId: ctx.ws._id, boardId: other._id, values: { serial: "Other one", eng: "Mark Gutierrez" }, position: 1, archived: false, version: 1, createdAt: new Date(), updatedAt: new Date() });
    const filter = JSON.stringify({ op: "and", rules: [{ key: "eng", cmp: "in", values: ["Mark Gutierrez"] }] });
    assert.ok(!(await list(s, ctx.b, { filter, limit: "200" })).items.some((d) => d.values.serial === "Other one"));
    assert.equal((await s.records.count(other._id, { filter })).total, 1);
  });
  test("a filter that runs too long gives a clear error", async () => {
    const { s, ctx, dl } = getWorld(), o = dl.repos.records.countFiltered;
    dl.repos.records.countFiltered = async () => { throw Object.assign(new Error("limit"), { code: 50, codeName: "MaxTimeMSExpired" }); };
    await assert.rejects(() => s.records.count(ctx.b._id, { filter: JSON.stringify(CASES[0]) }), (e) => e.code === "FILTER_TIMEOUT");
    dl.repos.records.countFiltered = o;
  });
}

describe("On the fake MongoDB", () => {
  const state = {};
  before(async () => {
    const fake = new FakeMongoClient(), connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
    await connection.connect(); await ensureDatabase(connection.db);
    const dl = createDataLayer({ connection, logger: quiet, fileStore: new MemoryFileStore() });
    Object.assign(state, { dl, s: dl.services, world: { db: connection.db }, real: false });
    state.ctx = await scenario(state.world, state.s);
  });
  shared(() => state);
});

const settingFile = path.join(__dirname, "../../.env.migration-test");
const setting = (key) => { if (!fs.existsSync(settingFile)) return null; const m = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\r\\n]*)`, "m").exec(fs.readFileSync(settingFile, "utf8")); return m ? m[1].trim() : null; };
describe("On real MongoDB (local test instance)", () => {
  const state = {}; let client = null, skip = false, dbName;
  before(async () => {
    const uri = setting("JARC_MIGRATION_TEST_MONGODB_URI");
    if (!uri) { skip = true; return; }
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
    try { await client.connect(); await client.db("admin").command({ ping: 1 }); } catch { skip = true; await client.close().catch(() => {}); client = null; return; }
    dbName = `jarc_migration_test_t${crypto.randomBytes(6).toString("hex")}`;
    const raw = client, connection = new MongoConnection({ uri: "mongodb://local.invalid", dbName: "jarc_database", createClient: () => ({ connect: async () => {}, close: async () => {}, startSession: (...a) => raw.startSession(...a), db: () => raw.db(dbName) }) });
    await connection.connect(); await ensureDatabase(connection.db);
    const dl = createDataLayer({ connection, logger: quiet, fileStore: new MemoryFileStore() });
    Object.assign(state, { dl, s: dl.services, world: { db: connection.db }, real: true });
    state.ctx = await scenario(state.world, state.s);
  });
  after(async () => { if (client) { await client.db(dbName).dropDatabase().catch(() => {}); await client.close(); } });
  const guarded = (name, fn) => test(name, async (t) => { if (skip) return t.skip("the local test instance isn't running"); return fn(); });
  const real = () => state;
  guarded("every condition matches the browser's rules; totals are right", async () => {
    const { s, ctx } = real(), active = ctx.docs.filter((d) => !d.archived);
    for (const filter of CASES) {
      const got = []; let cursor = null;
      do { const page = await s.records.list(ctx.b._id, { filter: JSON.stringify(filter), limit: "40", ...(cursor ? { cursor } : {}) }); got.push(...page.items.map((d) => d._id.toHexString())); cursor = page.nextCursor; } while (cursor);
      const expected = active.filter((d) => clientMatch(filter, d.values)).map((d) => d._id.toHexString());
      assert.deepEqual([...got].sort(), [...expected].sort(), JSON.stringify(filter));
      assert.equal((await s.records.count(ctx.b._id, { filter: JSON.stringify(filter) })).total, expected.length, JSON.stringify(filter));
    }
  });
  guarded("performance guard: 5,000 records of realistic size stay quick, whichever way a filter goes", async () => {
    const { s, world } = real(), ws = await s.workspaces.create({ name: "Perf" }, actor), b = await s.boards.create(ws._id, { name: "Perf", columns: COLUMNS.filter((c) => c.key !== "group") }, actor);
    const pad = "x".repeat(3500), docs = Array.from({ length: 5000 }, (_, i) => ({ _id: new ObjectId(), workspaceId: ws._id, boardId: b._id, groupId: null, values: { serial: `P${i}`, eng: i % 500 === 0 ? "Rare" : "Common", notes: pad, state: i % 2 ? "Open" : "Done" }, position: i, archived: false, pinned: false, version: 1, createdAt: new Date(), updatedAt: new Date() }));
    for (let i = 0; i < docs.length; i += 1000) await world.db.collection("records").insertMany(docs.slice(i, i + 1000));
    const time = async (fn) => { const t = Date.now(); const r = await fn(); return [Date.now() - t, r]; };
    const q = (rules) => JSON.stringify({ op: "and", rules });
    const budgets = [[q([{ key: "eng", cmp: "in", values: ["Common"] }]), 201], [q([{ key: "eng", cmp: "in", values: ["Rare"] }]), 10], [q([{ key: "eng", cmp: "in", values: ["None"] }]), 0], [q([{ key: "eng", cmp: "notIn", values: ["Common"] }, { key: "state", cmp: "in", values: ["Done"] }]), 10]];
    for (const [filter, n] of budgets) {
      const [ms, page] = await time(() => s.records.list(b._id, { filter, limit: "200" }));
      assert.equal(page.items.length, Math.min(n, 200), filter);
      assert.ok(ms < 1500, `page ${ms} ms: ${filter}`);
      const [cms] = await time(() => s.records.count(b._id, { filter }));
      assert.ok(cms < 1500, `count ${cms} ms: ${filter}`);
    }
    const [sorted, page] = await time(() => s.records.list(b._id, { orderBy: JSON.stringify([{ key: "serial", dir: "desc" }]), limit: "200" }));
    assert.equal(page.items[0].values.serial, "P4999", "numbers in text order numerically");
    assert.ok(sorted < 2000, `sorted page ${sorted} ms`);
  });
  guarded("pagination holds for each ordering, including nulls and numbers kept as text", async () => {
    const { s, ctx } = real(), total = ctx.docs.filter((d) => !d.archived).length;
    for (const orderBy of [[{ key: "position", dir: "asc" }], [{ key: "updatedAt", dir: "desc" }], [{ key: "eng", dir: "asc" }], [{ key: "eng", dir: "desc" }], [{ key: "state", dir: "asc" }, { key: "eng", dir: "desc" }], [{ key: "serial", dir: "desc" }]]) {
      const got = []; let cursor = null, pages = 0;
      do { const page = await s.records.list(ctx.b._id, { orderBy: JSON.stringify(orderBy), limit: "17", ...(cursor ? { cursor } : {}) }); got.push(...page.items); cursor = page.nextCursor; pages += 1; } while (cursor && pages < 40);
      assert.equal(new Set(got.map((d) => d._id.toHexString())).size, total, `all records exactly once: ${JSON.stringify(orderBy)}`);
      assert.equal(got.length, total, JSON.stringify(orderBy));
    }
  });
});
