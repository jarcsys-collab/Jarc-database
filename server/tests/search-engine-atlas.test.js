// Phase 3: the Atlas Search record engine (services/search-engines) behind RECORD_SEARCH_ENGINE, on the fake MongoDB with its
// documented-semantics $search emulation (tests/support/fake-mongo.js). Real Atlas behaviour (analyzer, positions, lag,
// latency) is proved only on a staging cluster. Covers: config, query shape, substring correctness against the regular search
// on a generated corpus (same top N, same order, same pages), 2 characters, cross-cell, authorization and lifecycle with stale
// index entries, verified counts, the candidate cap, unavailability (503 SEARCH_UNAVAILABLE, one-board fallback), shadow mode,
// logs without the query, the default regex path unchanged, static exclusions, and the printed index commands.
// Security spec: JARC-Search-Plan/10-security-review.md (S-numbers below).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ObjectId } = require("mongodb");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { searchParams, decodeCursor } = require("../src/validation/search");
const { SearchService } = require("../src/services/search-service");
const { loadConfig, ConfigError } = require("../src/config");
const { recordSearchPipeline } = require("../src/services/search-engines/atlas-query");
const { liveMatch, boardPlan } = require("../src/services/search-engines/atlas-engine");
const { commands } = require("../src/services/search-engines/atlas-index-commands");
const definition = require("../src/services/search-engines/atlas-index-definition.json");
const { FakeMongoClient } = require("./support/fake-mongo");

const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true }, { key: "notes", label: "Notes", type: "text" },
  { key: "status", label: "Status", type: "status", options: ["Open", "Done"] }, { key: "prio", label: "Priority", type: "priority", options: ["Low", "High"] },
  { key: "tags", label: "Tags", type: "dropdown", options: ["Red", "Blue"], multiple: true }, { key: "who", label: "Who", type: "owner" },
  { key: "qty", label: "Qty", type: "number" }, { key: "ok", label: "OK", type: "checkbox" }, { key: "mail", label: "Mail", type: "email" }
];
const actor = Object.freeze({ userId: new ObjectId(), kind: "entra", displayName: "Tester" });
const people = { everyone: true };
const ADMIN = { roles: null, globalRole: "SYSTEM_ADMIN" };
const logs = () => { const lines = []; const push = (l) => lines.push(String(l)); return { lines, log: push, warn: push, error: push }; };
const recordsOf = (r) => r.groups.find((g) => g.type === "record");

async function world({ engine = "atlas", index = "on", sample = 100, indexReady = true, logger = logs() } = {}) {
  const fake = new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const recordSearchEngine = engine === null ? null : { mode: engine, atlasIndex: "jarc_text", shadowSamplePercent: sample };
  const dl = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), recordSearch: index, recordSearchEngine });
  dl.searchIndex.pauseMs = 0; dl.searchIndex.repairMs = 0;
  const rs = connection.db.collection("recordSearch");
  if (indexReady !== null) await rs.createSearchIndex({ name: "jarc_text", definition }, { queryable: indexReady });
  const spy = { stages: [] }; const original = rs.aggregate.bind(rs);
  rs.aggregate = (stages, options) => { spy.stages.push(stages); return original(stages, options); };
  return { fake, dl, s: dl.services, repos: dl.repos, rs, spy, logger, engine: dl.services.search.engine, regular: new SearchService({ repos: dl.repos }) };
}
async function board(w, name, workspace, columns = COLUMNS) { return w.s.boards.create(workspace._id, { name, columns }, actor); }
async function add(w, b, rows) { await w.s.records.createMany(b._id, { records: rows.map((values) => ({ values })) }, actor, people); }
// Distinct, spread update times (with a few deliberate ties so the _id tie-break is exercised), then a catch up.
async function settle(w) {
  let i = 0;
  for (const r of await w.repos.records.collection.find({}).sort({ _id: 1 }).toArray()) { i += 1; await w.repos.records.collection.updateOne({ _id: r._id }, { $set: { updatedAt: new Date(Date.UTC(2026, 0, 1, 0, Math.floor(i / 3))) } }); }
  await w.dl.searchIndex.catchUp();
}
const run = (svc, query, scope = ADMIN) => svc.global(scope, searchParams({ type: "record", ...query }, actor.userId));
async function allPages(svc, query, scope = ADMIN) {
  const out = []; let cursor;
  for (let n = 0; n < 200; n += 1) {
    const g = recordsOf(await run(svc, { ...query, ...(cursor ? { cursor } : {}) }, scope));
    out.push(...g.items.map((i) => i.id));
    if (!g.next) return out;
    cursor = g.next;
  }
  throw new Error("pagination did not end");
}
const searchStages = (w) => w.spy.stages.filter((s) => s[0]?.$search);
const ids = (g) => g.items.map((i) => i.id);

describe("Configuration", () => {
  const base = { NODE_ENV: "development", DATA_STORE: "memory" };
  test("defaults to regex; accepts shadow and atlas only with the recordSearch index; validates the index name and sample", () => {
    assert.deepEqual({ ...loadConfig(base).recordSearchEngine }, { mode: "regex", atlasIndex: "jarc_text", shadowSamplePercent: 10 });
    assert.equal(loadConfig({ ...base, RECORD_SEARCH_ENGINE: "atlas", RECORD_SEARCH_INDEX: "shadow" }).recordSearchEngine.mode, "atlas");
    assert.equal(loadConfig({ ...base, RECORD_SEARCH_ENGINE: "shadow", RECORD_SEARCH_INDEX: "on", RECORD_SEARCH_SHADOW_SAMPLE_PERCENT: "0" }).recordSearchEngine.shadowSamplePercent, 0);
    assert.throws(() => loadConfig({ ...base, RECORD_SEARCH_ENGINE: "elastic" }), ConfigError);
    assert.throws(() => loadConfig({ ...base, RECORD_SEARCH_ENGINE: "atlas" }), /needs RECORD_SEARCH_INDEX/);
    assert.throws(() => loadConfig({ ...base, RECORD_SEARCH_ENGINE: "atlas", RECORD_SEARCH_INDEX: "on", RECORD_SEARCH_ATLAS_INDEX: "bad name;" }), ConfigError);
    assert.throws(() => loadConfig({ ...base, RECORD_SEARCH_SHADOW_SAMPLE_PERCENT: "101" }), ConfigError);
  });
  test("regex (default) builds no engine: the data layer's search service is the regular one and never runs $search", async () => {
    const w = await world({ engine: null, index: "off" });
    assert.equal(w.engine, null);
    const ws = await w.s.workspaces.create({ name: "W" }, actor), b = await board(w, "B", ws);
    await add(w, b, [{ serial: "Alpha pump" }]);
    assert.equal(recordsOf(await run(w.s.search, { q: "pump" })).items.length, 1);
    assert.equal(w.spy.stages.length, 0);
  });
});

describe("Query shape (S4, S11, S17)", () => {
  const boardIds = [new ObjectId(), new ObjectId()];
  test("3+ characters: phrase slop 0 on the trigram path; 2: one bigram term; 1: refused", () => {
    const [three] = recordSearchPipeline({ index: "jarc_text", boardIds, q: "AbC-1", limit: 11 });
    assert.deepEqual(three.$search.compound.must, [{ phrase: { path: "text", query: "abc-1", slop: 0 } }]);
    const [two] = recordSearchPipeline({ index: "jarc_text", boardIds, field: "name", q: "Ab", limit: 11 });
    assert.deepEqual(two.$search.compound.must, [{ text: { path: { value: "name", multi: "bi" }, query: "ab" } }]);
    assert.throws(() => recordSearchPipeline({ index: "jarc_text", boardIds, q: "a", limit: 11 }));
    assert.throws(() => recordSearchPipeline({ index: "jarc_text", boardIds: [], q: "abc", limit: 11 }));
  });
  test("scope and archived:false are filters inside $search; bounded; no highlights or scores; q only as a query value", () => {
    const q = '{"$gt":""} $where (a+)+$';
    const pipeline = recordSearchPipeline({ index: "jarc_text", boardIds, q, facets: { status: "Open", owner: "user:abc" }, from: new Date(0), to: new Date(1), after: { time: new Date(5), id: new ObjectId() }, limit: 7 });
    const s = pipeline[0].$search;
    assert.deepEqual(s.compound.filter[0], { in: { path: "boardId", value: boardIds } });
    assert.deepEqual(s.compound.filter[1], { equals: { path: "archived", value: false } });
    assert.deepEqual(s.sort, { updatedAt: -1, _id: -1 });
    assert.ok(pipeline.some((st) => st.$limit === 7));
    const text = JSON.stringify(pipeline);
    for (const banned of ["highlight", "searchHighlights", "scoreDetails", "searchScore"]) assert.ok(!text.includes(banned), banned);
    // The query text appears exactly once, as the phrase's query value; every path is a constant.
    assert.equal(text.split(JSON.stringify(q.toLowerCase()).slice(1, -1)).length - 1, 1);
    const paths = [...text.matchAll(/"path":("[^"]*"|\{[^}]*\})/g)].map((m) => m[1]);
    for (const p of paths) assert.ok(['"boardId"', '"archived"', '"status"', '"owner"', '"updatedAt"', '"text"'].includes(p), p);
  });
  test("the index definition matches the approved §5 design", () => {
    assert.equal(definition.mappings.dynamic, false);
    assert.equal(definition.mappings.fields.text.analyzer, "jarcTrigram");
    assert.equal(definition.mappings.fields.text.multi.bi.analyzer, "jarcBigram");
    assert.deepEqual(definition.analyzers.map((a) => [a.name, a.tokenizer.minGram, a.tokenizer.maxGram]), [["jarcTrigram", 3, 3], ["jarcBigram", 2, 2]]);
    assert.deepEqual(definition.storedSource, { include: ["boardId", "updatedAt"] });
    // _id (objectId) is indexed so the query's sort { updatedAt: -1, _id: -1 } has its tie-break key in the index.
    assert.deepEqual(definition.mappings.fields._id, { type: "objectId" });
    assert.deepEqual(Object.keys(definition.mappings.fields).sort(), ["_id", "archived", "boardId", "name", "owner", "priority", "status", "text", "updatedAt"]);
    assert.ok(Buffer.byteLength(JSON.stringify(definition)) < 3000, "within Atlas's 3 KB definition limit on Flex");
  });
});

// A small seeded generator, so the corpus is the same on every run.
function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }

describe("Substring correctness against the regular search (generated corpus)", () => {
  test("same top N, same order and same pages for 3+ characters, 2 characters and no-match terms; never across cells", async () => {
    const w = await world();
    const ws1 = await w.s.workspaces.create({ name: "One" }, actor), ws2 = await w.s.workspaces.create({ name: "Two" }, actor);
    const boards = [await board(w, "A", ws1), await board(w, "B", ws1), await board(w, "C", ws2)];
    const random = rng(42), alphabet = "abcdeFGH 12-.(+*?[$", word = (n) => Array.from({ length: n }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    for (const b of boards) await add(w, b, Array.from({ length: 70 }, (_, i) => ({ serial: `${word(6)} ${i}`, notes: word(14), mail: random() < 0.5 ? `${word(4)}@x.example` : "", tags: random() < 0.3 ? ["Red", "Blue"] : ["Red"], status: random() < 0.5 ? "Open" : "Done", qty: i, ok: true })));
    await settle(w);
    const docs = await w.repos.records.collection.find({}).toArray(), r2 = rng(7);
    const terms = new Set(["abc", "ab", "fg", "1-", "(+", "*?", "[$", "zzz", "qq", "red", "lue", "ed\nbl".replace("\n", " ")]);
    for (let i = 0; i < 25; i += 1) { const d = docs[Math.floor(r2() * docs.length)], t = d.values.notes, at = Math.floor(r2() * (t.length - 4)); terms.add(t.slice(at, at + 2 + Math.floor(r2() * 3)).trim() || "ab"); }
    let compared = 0;
    for (const q of terms) {
      if (q.replace(/\s+/g, " ").trim().length < 2) continue;
      const regular = recordsOf(await run(w.regular, { q, limit: "10" })), atlas = recordsOf(await run(w.s.search, { q, limit: "10" }));
      assert.deepEqual(ids(atlas), ids(regular), `top 10 for ${JSON.stringify(q)}`);
      assert.equal(atlas.more, regular.more, `more for ${JSON.stringify(q)}`);
      assert.deepEqual(atlas.items.map((i) => i.snippet), regular.items.map((i) => i.snippet));
      assert.deepEqual(await allPages(w.s.search, { q, limit: "7" }), await allPages(w.regular, { q, limit: "7" }), `pages for ${JSON.stringify(q)}`);
      compared += 1;
    }
    assert.ok(compared >= 20);
    // Filters keep their semantics too.
    for (const extra of [{ status: "Open" }, { priority: "High" }, { from: "2026-01-01", to: "2026-01-01" }]) assert.deepEqual(await allPages(w.s.search, { q: "ab", limit: "9", ...extra }), await allPages(w.regular, { q: "ab", limit: "9", ...extra }));
    assert.ok(searchStages(w).length > 0);
  });
  test("2 characters match exactly; a term spanning two cells never matches (cells are separate)", async () => {
    const w = await world();
    const ws = await w.s.workspaces.create({ name: "W" }, actor), b = await board(w, "B", ws);
    await add(w, b, [{ serial: "Gearbox", notes: "oil" }, { serial: "Rotor", notes: "XY plate" }, { serial: "pump", notes: "valve" }]);
    await settle(w);
    assert.deepEqual(recordsOf(await run(w.s.search, { q: "xy" })).items.map((i) => i.title), ["Rotor"]);
    assert.deepEqual(recordsOf(await run(w.s.search, { q: "il" })).items.map((i) => i.title), ["Gearbox"]);
    // "pump\nvalve" is stored for the third record: "pva" / "mp va" would only match across the two cells.
    for (const q of ["pva", "mp va", "boxoil"]) { assert.equal(recordsOf(await run(w.s.search, { q })).items.length, 0, q); assert.equal(recordsOf(await run(w.regular, { q })).items.length, 0, q); }
  });
  test("People, Files, number and checkbox cells are never matched (S24)", async () => {
    const w = await world();
    const ws = await w.s.workspaces.create({ name: "W" }, actor), b = await board(w, "B", ws);
    await add(w, b, [{ serial: "Plain", qty: 987654, ok: true }]);
    await w.repos.records.collection.updateMany({ boardId: b._id }, { $set: { "values.who": ["user:aaaaaaaaaaaaaaaaaaaaaaaa"] } });
    await settle(w);
    for (const q of ["aaaaaa", "987654", "true", "user:"]) assert.equal(recordsOf(await run(w.s.search, { q })).items.length, 0, q);
    const stored = await w.rs.find({}).toArray();
    assert.ok(stored.every((d) => !d.text.includes("987654") && !d.text.includes("user:")));
  });
});

describe("Authorization and lifecycle (S1-S4, S9, S10, S12, S14)", () => {
  async function two() {
    const w = await world();
    const wa = await w.s.workspaces.create({ name: "Alpha WS" }, actor), wb = await w.s.workspaces.create({ name: "Bravo WS" }, actor);
    const a = await board(w, "Alpha board", wa), b = await board(w, "Bravo board", wb);
    await add(w, a, [{ serial: "Alpha zqx one", notes: "zqx" }, { serial: "Alpha two", notes: "nothing" }]);
    await add(w, b, [{ serial: "Bravo zqx secret", notes: "zqx salary" }]);
    await settle(w);
    return { w, wa, wb, a, b, onlyA: { roles: new Map([[wa._id.toHexString(), "MEMBER"]]), globalRole: null } };
  }
  test("S1/S2: a member of A finds nothing of B, including with B as a filter; no flags or IDs leak", async () => {
    const { w, wb, b, onlyA } = await two();
    const res = await run(w.s.search, { q: "salary" }, onlyA), g = recordsOf(res);
    assert.deepEqual([g.items.length, g.more, g.next, res.partial], [0, false, null, false]);
    const body = JSON.stringify(res);
    for (const leak of [b._id.toHexString(), wb._id.toHexString(), "Bravo"]) assert.ok(!body.includes(leak));
    for (const filter of [{ workspaceId: wb._id.toHexString() }, { boardId: b._id.toHexString() }]) assert.deepEqual(recordsOf(await run(w.s.search, { q: "zqx", ...filter }, onlyA)), { type: "record", items: [], more: false, next: null });
  });
  test("S4: the $search `in` value is exactly the caller's boards after filters; an empty scope runs no $search", async () => {
    const { w, a, onlyA } = await two();
    w.spy.stages.length = 0;
    await run(w.s.search, { q: "zqx" }, onlyA);
    for (const stages of searchStages(w)) assert.deepEqual(stages[0].$search.compound.filter[0].in.value.map(String), [a._id.toHexString()]);
    assert.ok(searchStages(w).length >= 1);
    w.spy.stages.length = 0;
    await run(w.s.search, { q: "zqx" }, { roles: new Map(), globalRole: null });
    assert.equal(searchStages(w).length, 0);
  });
  test("S3: revocation applies on the next request, also through an old cursor", async () => {
    const { w, wa, a } = await two();
    await add(w, a, Array.from({ length: 12 }, (_, i) => ({ serial: `zqx extra ${i}` })));
    await settle(w);
    const member = { roles: new Map([[wa._id.toHexString(), "MEMBER"]]), globalRole: null };
    const first = recordsOf(await run(w.s.search, { q: "zqx", limit: "5" }, member));
    assert.ok(first.next);
    const revoked = { roles: new Map(), globalRole: null };
    assert.deepEqual(recordsOf(await run(w.s.search, { q: "zqx", limit: "5", cursor: first.next }, revoked)).items, []);
  });
  test("S9/S10/S14: stale index entries (moved, archived, deleted, changed text, orphan) are never returned; more stays false", async () => {
    const { w, a, b, onlyA } = await two();
    const [one] = await w.repos.records.collection.find({ boardId: a._id, "values.serial": "Alpha zqx one" }).toArray();
    // Every change below goes straight to `records`, so recordSearch still says "zqx" on board A.
    const check = async (label) => { const g = recordsOf(await run(w.s.search, { q: "zqx" }, onlyA)); assert.deepEqual([g.items.length, g.more, g.next], [0, false, null], label); };
    await w.repos.records.collection.updateOne({ _id: one._id }, { $set: { "values.serial": "Alpha one", "values.notes": "clean" } }); await check("changed text (S10)");
    await w.repos.records.collection.updateOne({ _id: one._id }, { $set: { "values.serial": "Alpha zqx one", "values.notes": "zqx", boardId: b._id } }); await check("moved to an unreadable board (S9)");
    await w.repos.records.collection.updateOne({ _id: one._id }, { $set: { boardId: a._id, archived: true } }); await check("archived");
    await w.repos.records.collection.deleteOne({ _id: one._id }); await check("deleted");
    await w.rs.insertOne({ _id: new ObjectId(), boardId: a._id, archived: false, updatedAt: new Date(), name: "zqx orphan", text: "zqx orphan", status: [], priority: [], owner: [] }); await check("orphan index document");
    assert.ok((await w.rs.countDocuments({ text: { $regex: "zqx" } })) >= 2, "the index really was stale");
  });
  test("S12: 11 index hits of which 10 are stale, limit 1: one item, more only while a verified item remains, no totals", async () => {
    const w = await world();
    const ws = await w.s.workspaces.create({ name: "W" }, actor), b = await board(w, "B", ws);
    await add(w, b, Array.from({ length: 11 }, (_, i) => ({ serial: `row ${i}`, notes: "zqx" })));
    await settle(w);
    const rows = await w.repos.records.collection.find({}).sort({ updatedAt: -1, _id: -1 }).toArray();
    for (const r of rows.slice(0, 10)) await w.repos.records.collection.updateOne({ _id: r._id }, { $set: { "values.notes": "gone" } });
    const g = recordsOf(await run(w.s.search, { q: "zqx", limit: "1" }));
    assert.deepEqual([g.items.length, g.items[0].id, g.more, g.next], [1, rows[10]._id.toHexString(), false, null]);
    for (const k of ["found", "total", "count"]) assert.ok(!(k in g));
  });
  test("the candidate cap: at most 50 records re-read per page; a page that runs out says partial and moves on", async () => {
    const w = await world();
    const ws = await w.s.workspaces.create({ name: "W" }, actor), b = await board(w, "B", ws);
    await add(w, b, Array.from({ length: 70 }, (_, i) => ({ serial: `row ${i}`, notes: "zqx" })));
    await settle(w);
    const rows = await w.repos.records.collection.find({}).sort({ updatedAt: -1, _id: -1 }).toArray();
    for (const r of rows.slice(0, 65)) await w.repos.records.collection.updateOne({ _id: r._id }, { $set: { "values.notes": "gone" } });
    let reread = 0; const byIds = w.repos.records.byIds.bind(w.repos.records); w.repos.records.byIds = (list, o) => { reread += list.length; return byIds(list, o); };
    const first = recordsOf(await run(w.s.search, { q: "zqx", limit: "5" }));
    assert.ok(reread <= 50, `re-read ${reread}`);
    assert.deepEqual([first.items.length, first.partial, first.more, Boolean(first.next)], [0, true, true, true]);
    const cursor = decodeCursor(first.next, "record");
    assert.deepEqual(Object.keys(cursor).sort(), ["exclude", "id", "time"]);
    // Stale-heavy: the round cap (3 per page) may need a few pages; they reach exactly the live five.
    w.repos.records.byIds = byIds;
    assert.deepEqual(await allPages(w.s.search, { q: "zqx", limit: "5", cursor: first.next }), rows.slice(65).map((r) => r._id.toHexString()));
  });
  for (const engine of ["atlas", null]) {
    test(`L2 (${engine ? "engine" : "index path"}): at most 3 candidate round trips per page, then partial with reason candidate_cap`, async () => {
      const w = await world({ engine, index: "on" });
      const ws = await w.s.workspaces.create({ name: "W" }, actor), b = await board(w, "B", ws);
      await add(w, b, Array.from({ length: 70 }, (_, i) => ({ serial: `row ${i}`, notes: "zqx" })));
      await settle(w);
      const rows = await w.repos.records.collection.find({}).sort({ updatedAt: -1, _id: -1 }).toArray();
      for (const r of rows.slice(0, 65)) await w.repos.records.collection.updateOne({ _id: r._id }, { $set: { "values.notes": "gone" } });
      let rereads = 0; const byIds = w.repos.records.byIds.bind(w.repos.records); w.repos.records.byIds = (list, o) => { rereads += 1; return byIds(list, o); };
      let hits = 0; const ih = w.dl.searchIndex.hits.bind(w.dl.searchIndex); w.dl.searchIndex.hits = (...x) => { hits += 1; return ih(...x); };
      const before = searchStages(w).length;
      const res = await run(w.s.search, { q: "zqx", limit: "1" }), g = recordsOf(res);
      const rounds = engine ? searchStages(w).length - before : hits;
      assert.ok(rounds >= 1 && rounds <= 3, `round trips ${rounds}`);
      assert.ok(rereads <= 3, `re-reads ${rereads}`);
      assert.deepEqual([g.items.length, g.partial, g.reason, g.more, Boolean(g.next)], [0, true, "candidate_cap", true, true]);
      assert.deepEqual(res.partialReasons, ["candidate_cap"]);
    });
  }
});

describe("Unavailability (S21, S22)", () => {
  const SECRET = "SECRET-Ünique-123";
  async function setup(state) {
    const logger = logs();
    const w = await world({ indexReady: state === "missing" ? null : state !== "building", logger });
    const ws = await w.s.workspaces.create({ name: "W" }, actor), a = await board(w, "Hidden Board Name", ws), b = await board(w, "Other", ws);
    await add(w, a, [{ serial: `x ${SECRET}` }]); await add(w, b, [{ serial: "y" }]);
    await settle(w);
    let regularCalls = 0; const sp = w.repos.records.searchPage.bind(w.repos.records); w.repos.records.searchPage = (...x) => { regularCalls += 1; return sp(...x); };
    return { w, a, logger, regular: () => regularCalls };
  }
  for (const state of ["missing", "building", "throws"]) {
    test(`index ${state}: fixed 503 SEARCH_UNAVAILABLE without the all-board scan; logs hold no query text`, async () => {
      const { w, logger, regular } = await setup(state);
      if (state === "throws") w.fake.failNext({ collection: "recordSearch", op: "aggregate", times: 5, error: Object.assign(new Error(`$search failed for "${SECRET}" on Hidden Board Name`), { codeName: "SearchNotEnabled", code: 31082 }) });
      const started = Date.now();
      const error = await run(w.s.search, { q: SECRET }).then(() => null, (e) => e);
      assert.ok(Date.now() - started < 1000);
      assert.deepEqual([error?.status, error?.code], [503, "SEARCH_UNAVAILABLE"]);
      assert.ok(!error.message.includes("SECRET") && !error.message.includes("Hidden"));
      assert.equal(regular(), 0);
      // A second search is answered from the remembered failure: no further Atlas call.
      const before = w.spy.stages.length;
      await assert.rejects(run(w.s.search, { q: SECRET }), { code: "SEARCH_UNAVAILABLE" });
      assert.equal(w.spy.stages.length, before);
      assert.ok(logger.lines.some((l) => l.includes("[search-engine] atlas unavailable") && l.includes(`query length ${SECRET.length}`)));
      for (const line of logger.lines) for (let i = 0; i + 4 <= SECRET.length; i += 1) assert.ok(!line.includes(SECRET.slice(i, i + 4)), line);
      assert.ok(logger.lines.every((l) => !l.includes("Hidden Board Name")));
    });
  }
  test("exactly one board in scope: the scoped regular search answers instead", async () => {
    const { w, a, regular } = await setup("building");
    const g = recordsOf(await run(w.s.search, { q: "ique-123", boardId: a._id.toHexString() }));
    assert.equal(g.items.length, 1);
  });
  test("a queryable index again is used after the short failure memory", async () => {
    const { w } = await setup("building");
    await assert.rejects(run(w.s.search, { q: "ique-123" }), { code: "SEARCH_UNAVAILABLE" });
    w.rs.setSearchIndexState("jarc_text", { queryable: true });
    w.engine.status.at -= 10000;
    assert.equal(recordsOf(await run(w.s.search, { q: "ique-123" })).items.length, 1);
  });
  test("L3: a single non-index $search error fails only that request (503); the next search still uses Atlas", async () => {
    const { w } = await setup("ready");
    // The status check passes first (a cached OK status after one search), so the failure lands on $search itself.
    assert.equal(recordsOf(await run(w.s.search, { q: "ique-123" })).items.length, 1);
    w.fake.failNext({ collection: "recordSearch", op: "aggregate", times: 1, error: Object.assign(new Error(`odd failure for "${SECRET}"`), { codeName: "InternalError", code: 1 }) });
    await assert.rejects(run(w.s.search, { q: "ique-123" }), (e) => e.status === 503 && e.code === "SEARCH_UNAVAILABLE" && !e.message.includes("SECRET"));
    assert.equal(w.engine.status?.ok, true, "not remembered as unavailable for everyone");
    const before = searchStages(w).length;
    assert.equal(recordsOf(await run(w.s.search, { q: "ique-123" })).items.length, 1);
    assert.ok(searchStages(w).length > before, "Atlas was asked again at once");
  });
  test("L3: an index-unavailable class $search error (IndexNotFound, SearchNotEnabled) is still remembered for everyone", async () => {
    for (const error of [{ codeName: "IndexNotFound", code: 27 }, { codeName: "SearchNotEnabled", code: 31082 }]) {
      const { w } = await setup("ready");
      assert.equal(recordsOf(await run(w.s.search, { q: "ique-123" })).items.length, 1);
      w.fake.failNext({ collection: "recordSearch", op: "aggregate", times: 1, error: Object.assign(new Error("index gone"), error) });
      await assert.rejects(run(w.s.search, { q: "ique-123" }), { code: "SEARCH_UNAVAILABLE" });
      assert.equal(w.engine.status?.ok, false, error.codeName);
      const before = w.spy.stages.length;
      await assert.rejects(run(w.s.search, { q: "ique-123" }), { code: "SEARCH_UNAVAILABLE" });
      assert.equal(w.spy.stages.length, before, "answered from the remembered failure");
    }
  });
});

describe("Shadow mode", () => {
  async function shadow(sample) {
    const logger = logs(), w = await world({ engine: "shadow", index: "shadow", sample, logger });
    const ws = await w.s.workspaces.create({ name: "W" }, actor), a = await board(w, "A", ws), b = await board(w, "B", ws);
    await add(w, a, [{ serial: "pump one" }, { serial: "pump two" }]); await add(w, b, [{ serial: "pump three" }]);
    await settle(w);
    return { w, a, logger };
  }
  test("serves the regular results; compares only one-board searches, logs counts and timings only", async () => {
    const { w, a, logger } = await shadow(100);
    const compare = w.engine.shadowCompare.bind(w.engine); let pending = null;
    w.engine.shadowCompare = (...x) => (pending = compare(...x));
    w.spy.stages.length = 0;
    const all = recordsOf(await run(w.s.search, { q: "pump" }));
    assert.equal(all.items.length, 3);
    assert.equal(searchStages(w).length, 0, "never on the all-board path");
    const one = recordsOf(await run(w.s.search, { q: "pump", boardId: a._id.toHexString() }));
    assert.deepEqual(one.items.map((i) => i.title).sort(), ["pump one", "pump two"]);
    assert.deepEqual(await pending, { regex: 2, atlas: 2, onlyRegex: 0, onlyAtlas: 0 });
    assert.ok(logger.lines.some((l) => /\[search-engine\] shadow: regex 2, atlas 2, only regex 0, only atlas 0, \d+ ms\./.test(l)));
    assert.ok(logger.lines.every((l) => !l.includes("pump")));
  });
  test("sample 0: never runs Atlas", async () => {
    const { w, a } = await shadow(0);
    w.spy.stages.length = 0;
    await run(w.s.search, { q: "pump", boardId: a._id.toHexString() });
    assert.equal(w.spy.stages.length, 0);
  });
});

describe("Index-backed regex path (RECORD_SEARCH_INDEX=on) also re-checks live text (audit gap 9, F1)", () => {
  test("a stale recordSearch entry is not shown in Command Center or board search, and doesn't use up the page", async () => {
    const w = await world({ engine: null, index: "on" });
    const ws = await w.s.workspaces.create({ name: "W" }, actor), b = await board(w, "B", ws);
    await add(w, b, Array.from({ length: 8 }, (_, i) => ({ serial: `row ${i}`, notes: "zqx" })));
    await settle(w);
    assert.ok(w.dl.searchIndex.active);
    const rows = await w.repos.records.collection.find({}).sort({ updatedAt: -1, _id: -1 }).toArray();
    for (const r of rows.slice(0, 5)) await w.repos.records.collection.updateOne({ _id: r._id }, { $set: { "values.notes": "gone" } });
    const g = recordsOf(await run(w.s.search, { q: "zqx", limit: "3" }));
    assert.deepEqual([g.items.map((i) => i.id), g.more], [rows.slice(5).map((r) => r._id.toHexString()), false]);
    const listed = await w.s.records.list(b._id, { q: "zqx", limit: "50" }, { me: actor.userId });
    assert.deepEqual(listed.items.map((r) => String(r._id)).sort(), rows.slice(5).map((r) => r._id.toHexString()).sort());
  });
});

// Integration of Phase 1 (one time budget, partialReasons) with Phase 3 (engine, live-checked index refills, candidate cap).
describe("Integration: time budget and partial reasons across the engine and the index path", () => {
  async function stale(opts) {
    const w = await world(opts);
    const ws = await w.s.workspaces.create({ name: "W" }, actor), b = await board(w, "B", ws);
    await add(w, b, Array.from({ length: 70 }, (_, i) => ({ serial: `row ${i}`, notes: "zqx" })));
    await settle(w);
    const rows = await w.repos.records.collection.find({}).sort({ updatedAt: -1, _id: -1 }).toArray();
    for (const r of rows.slice(0, 65)) await w.repos.records.collection.updateOne({ _id: r._id }, { $set: { "values.notes": "gone" } });
    return { w, rows };
  }
  for (const engine of ["atlas", null]) {
    test(`${engine ? "engine" : "index path"}: the candidate cap says partial with reason candidate_cap, and the next page continues`, async () => {
      const { w, rows } = await stale({ engine, index: "on" });
      const res = await run(w.s.search, { q: "zqx", limit: "5" }), first = recordsOf(res);
      assert.deepEqual([first.items.length, first.partial, first.reason, first.more, Boolean(first.next)], [0, true, "candidate_cap", true, true]);
      assert.deepEqual([res.partial, res.partialReasons], [true, ["candidate_cap"]]);
      // The next pages continue (each partial page says candidate_cap) until the live five, and no page repeats a row.
      const reasons = new Set(); let cursor = first.next; const seen = [];
      for (let n = 0; cursor && n < 20; n += 1) { const g = recordsOf(await run(w.s.search, { q: "zqx", limit: "5", cursor })); if (g.partial) reasons.add(g.reason); seen.push(...g.items.map((i) => i.id)); cursor = g.next; }
      assert.equal(cursor, null);
      assert.deepEqual(seen, rows.slice(65).map((r) => r._id.toHexString()));
      assert.ok([...reasons].every((r) => r === "candidate_cap"), [...reasons].join());
    });
  }
  test("engine: gets what is left of the request budget, not MAX_TIME_MS", async () => {
    const w = await world();
    const ws = await w.s.workspaces.create({ name: "W" }, actor), b = await board(w, "B", ws);
    await add(w, b, [{ serial: "zqx one" }]);
    await settle(w);
    const clock = { t: 0 }; w.s.search.now = () => clock.t;
    const list = w.repos.workspaces.list.bind(w.repos.workspaces); w.repos.workspaces.list = async (...x) => { clock.t += 1000; return list(...x); };
    const seen = []; const page = w.engine.recordPage.bind(w.engine); w.engine.recordPage = (ctx, o) => { seen.push(o.budgetMs); return page(ctx, o); };
    assert.equal(recordsOf(await run(w.s.search, { q: "zqx" })).items.length, 1);
    assert.deepEqual(seen, [2000]);
  });
  test("index path: a refill isn't started once the budget is spent; the group says time_budget and the next page continues", async () => {
    const { w, rows } = await stale({ engine: null, index: "on" });
    const clock = { t: 0 }; w.s.search.now = () => clock.t;
    const byIds = w.repos.records.byIds.bind(w.repos.records), budgets = [];
    w.repos.records.byIds = async (list, o) => { budgets.push(o.maxTimeMS); clock.t += 2990; return byIds(list, o); };
    const res = await run(w.s.search, { q: "zqx", limit: "5" }), first = recordsOf(res);
    assert.deepEqual([first.items.length, first.partial, first.reason, first.more, Boolean(first.next)], [0, true, "time_budget", true, true]);
    assert.deepEqual(res.partialReasons, ["time_budget"]);
    assert.equal(budgets.length, 1);
    assert.ok(budgets[0] <= 3000, String(budgets));
    // The next page starts after the hits already examined: none of the first read's stale rows again, the live five reached.
    w.repos.records.byIds = byIds; w.s.search.now = Date.now;
    const ids = await allPages(w.s.search, { q: "zqx", limit: "5", cursor: first.next });
    assert.deepEqual(ids, rows.slice(65).map((r) => r._id.toHexString()));
  });
});

describe("Verification cost (S18)", () => {
  test("the live check is a plain contains: hostile terms on 50 records of 64 KB take well under 50 ms", () => {
    const plan = boardPlan({ columns: COLUMNS }), big = "a".repeat(64 * 1024);
    const records = Array.from({ length: 50 }, () => ({ values: { serial: "x", notes: big, mail: big } }));
    for (const term of ["(a+)+$", ".*.*.*", "\\\\", "[", "a".repeat(100)]) {
      // Best of three, so a busy test machine doesn't decide the result.
      const times = [0, 1, 2].map(() => { const started = process.hrtime.bigint(); for (const r of records) liveMatch(r, plan, { needle: term.toLowerCase() }); return Number(process.hrtime.bigint() - started) / 1e6; });
      assert.ok(Math.min(...times) < 50, `${term}: ${times}`);
    }
  });
});

describe("Static checks (S7, S23) and the printed index commands", () => {
  const src = path.join(__dirname, "..", "src");
  const engineFiles = fs.readdirSync(path.join(src, "services", "search-engines")).filter((f) => f.endsWith(".js")).map((f) => path.join(src, "services", "search-engines", f));
  const files = [...engineFiles, path.join(src, "services", "search-service.js"), path.join(src, "services", "record-search-index.js"), path.join(src, "routes", "search.js"),
    path.join(src, "repositories", "mongo", "record-search-repository.js"), path.join(__dirname, "..", "scripts", "record-search-reconcile.js")];
  test("L7: the static exclusion list covers the search repository and the reconcile script", () => {
    for (const f of ["record-search-repository.js", "record-search-reconcile.js"]) assert.ok(files.some((x) => x.endsWith(f) && fs.existsSync(x)), f);
  });
  // The directory source collection's name is built from parts so it never appears literally in this public repository.
  const FORBIDDEN_SOURCES = new RegExp(["FactSales", "FactInventory", ["Entra", "User"].join(""), "DirectorySnapshot", "fabric"].join("|"), "i");
  test("search code never reaches Fabric Data or the employee collection", () => {
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      assert.ok(!/require\([^)]*fabric/i.test(text), f);
      assert.ok(!FORBIDDEN_SOURCES.test(text), f);
    }
    assert.equal(require("../src/config").JARC_DB_NAME, "jarc_database");
  });
  test("the engine has no access-policy shortcut and no module-level per-actor cache", () => {
    for (const f of engineFiles) {
      const text = fs.readFileSync(f, "utf8");
      assert.ok(!/development_shared|accessPolicy|\bshared\b|employeeAccess\s*[.[(]|visibility\(/.test(text.replace(/^\s*\/\/.*$/gm, "")), f);
      assert.ok(!/require\(["'][^"']*auth\/access/.test(text), f);
    }
  });
  test("the index commands are printed, never run: create, read-only status, rollback", () => {
    const c = commands("jarc_text");
    assert.match(c.create, /createSearchIndexes: "recordSearch"/);
    assert.match(c.create, /"jarcTrigram"/);
    assert.match(c.status, /\$listSearchIndexes: \{ name: "jarc_text" \}/);
    assert.match(c.drop, /dropSearchIndex\("jarc_text"\)/);
    assert.throws(() => commands('x"; db.dropDatabase(); "'));
    const text = fs.readFileSync(path.join(src, "services", "search-engines", "atlas-index-commands.js"), "utf8");
    assert.ok(!/require\(["'](mongodb|\.\.\/\.\.\/db)/.test(text) && !/\.env/.test(text.replace(/^\s*\/\/.*$/gm, "")));
  });
});
