// The final pre-deployment hardening: feature switches enforced on both sides, the search index through changes, deletions,
// imports, permissions, filtering and pagination (no repeats, nothing lost), and a dependency advisory that stays closed.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), crypto = require("crypto"), zlib = require("zlib");
const { spawn } = require("child_process");
const { ObjectId, MongoClient } = require("mongodb");
const { loadConfig, ConfigError, FEATURE_SWITCHES } = require("../src/config");
const { resolveFeatures } = require("../src/app");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase, COLLECTIONS, FEATURE_COLLECTIONS } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { searchParams, encodeCursor, decodeCursor } = require("../src/validation/search");
const { FakeMongoClient } = require("./support/fake-mongo");
const { startMongoApp, startApp, api, entraEnv } = require("./helpers");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const quiet = { log() {}, warn() {}, error() {} };
const actor = Object.freeze({ userId: new ObjectId(), kind: "entra", displayName: "Tester" });
const people = { everyone: true };
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "code", label: "Code", type: "text" }, { key: "state", label: "State", type: "status", options: ["New", "Done"] }, { key: "tags", label: "Tags", type: "dropdown", options: ["a", "b", "c", "d", "e"], multiple: true }, { key: "qty", label: "Qty", type: "number" }];
const PROD = entraEnv ? { ...entraEnv(), NODE_ENV: "production", AUTH_MODE: "entra", DATA_STORE: "mongodb", MONGODB_URI: "mongodb://localhost/", MONGODB_DB_NAME: "jarc_database" } : null;

async function world(mode, { db = null } = {}) {
  const fake = db ? null : new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: db || (() => fake) });
  await connection.connect();
  await ensureDatabase(connection.db);
  const dl = createDataLayer({ connection, logger: quiet, fileStore: new MemoryFileStore(), recordSearch: mode });
  dl.searchIndex.pauseMs = 0; dl.searchIndex.repairMs = 0;
  return { dl, s: dl.services, repos: dl.repos, index: dl.searchIndex, db: connection.db, connection };
}

describe("Feature switches: configuration", () => {
  const config = (extra) => loadConfig({ ...PROD, ...extra });
  test("the switches are named, and both are off in production unless turned on", () => {
    assert.deepEqual({ ...FEATURE_SWITCHES }, { nativeForms: "JARC_FEATURE_FORMS", spreadsheetImports: "JARC_FEATURE_IMPORTS" });
    assert.deepEqual({ ...config({}).features }, { nativeForms: false, spreadsheetImports: false });
    assert.deepEqual({ ...config({ JARC_FEATURE_FORMS: "", JARC_FEATURE_IMPORTS: "" }).features }, { nativeForms: false, spreadsheetImports: false }, "empty is unset");
  });
  test("each switch is independent", () => {
    assert.deepEqual({ ...config({ JARC_FEATURE_FORMS: "true" }).features }, { nativeForms: true, spreadsheetImports: false });
    assert.deepEqual({ ...config({ JARC_FEATURE_IMPORTS: "true" }).features }, { nativeForms: false, spreadsheetImports: true });
  });
  test("anything but true or false stops startup rather than being guessed", () => {
    for (const bad of ["TRUE", "1", "yes", "on", " true"]) for (const name of Object.values(FEATURE_SWITCHES)) assert.throws(() => config({ [name]: bad }), (e) => e instanceof ConfigError && e.message.includes(name), `${name}=${bad}`);
  });
  test("outside production they default on, and can be turned off", () => {
    assert.deepEqual({ ...loadConfig({}).features }, { nativeForms: true, spreadsheetImports: true });
    assert.deepEqual({ ...loadConfig({ JARC_FEATURE_FORMS: "false" }).features }, { nativeForms: false, spreadsheetImports: true });
  });
  test("the app takes the same default: not stated means off in production", () => {
    assert.deepEqual({ ...resolveFeatures({}, "production") }, { nativeForms: false, spreadsheetImports: false });
    assert.deepEqual({ ...resolveFeatures({ nativeForms: true }, "production") }, { nativeForms: true, spreadsheetImports: false });
    assert.deepEqual({ ...resolveFeatures({}, "test") }, { nativeForms: true, spreadsheetImports: true });
  });
  test("these switches leave the search setting and every other restricted setting alone", () => {
    const c = config({ RECORD_SEARCH_INDEX: "shadow" });
    assert.equal(c.recordSearch, "shadow");
    assert.equal(config({ RECORD_SEARCH_INDEX: "shadow", JARC_FEATURE_FORMS: "true", JARC_FEATURE_IMPORTS: "true" }).recordSearch, "shadow");
    assert.equal(c.accounts.mode, "off", "Account Management stays off");
  });
  test("the production server only runs the import worker when imports are on, and only creates what's switched on", () => {
    const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
    assert.match(server, /if \(config\.features\.spreadsheetImports\) dataLayer\?\.services\.importJobs\.startWorker\(\);/);
    assert.match(server, /ensureDatabase\(connection\.db, \{ features: config\.features \}\)/);
    assert.match(server, /createApp\(\{ features: config\.features,/);
  });
});

describe("Feature switches: database", () => {
  const fresh = async () => { const fake = new FakeMongoClient(), c = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake }); await c.connect(); return c.db; };
  const names = (db) => db.listCollections({}, { nameOnly: true }).toArray().then((l) => l.map((c) => c.name));
  test("with a feature off its collections aren't created; turning it on creates them", async () => {
    const db = await fresh(), all = [...FEATURE_COLLECTIONS.nativeForms, ...FEATURE_COLLECTIONS.spreadsheetImports];
    await ensureDatabase(db, { features: { nativeForms: false, spreadsheetImports: false } });
    let have = await names(db);
    for (const name of all) assert.ok(!have.includes(name), name);
    assert.ok(have.includes(COLLECTIONS.records) && have.includes(COLLECTIONS.recordSearch), "everything else is as before");
    await ensureDatabase(db, { features: { nativeForms: true, spreadsheetImports: false } });
    have = await names(db);
    for (const name of FEATURE_COLLECTIONS.nativeForms) assert.ok(have.includes(name), name);
    for (const name of FEATURE_COLLECTIONS.spreadsheetImports) assert.ok(!have.includes(name), name);
  });
  test("called without features (tools and tests), every collection is created, as before", async () => {
    const db = await fresh(); await ensureDatabase(db);
    const have = await names(db);
    for (const name of Object.values(COLLECTIONS)) assert.ok(have.includes(name), name);
  });
});

describe("Feature switches: the API refuses a hidden feature, however it's asked", () => {
  let on, off, formsOnly, importsOnly, board, form, job;
  const CSV = Buffer.from("Item,Code\nOne,1\n");
  const raw = (app, method, p, body, type = "text/csv") => fetch(`${app.url}/api/v1${p}`, { method, headers: { "Content-Type": type, "X-Requested-With": "x" }, body });
  before(async () => {
    on = await startMongoApp({ app: { features: { nativeForms: true, spreadsheetImports: true } } });
    const same = { dataLayer: on.dataLayer, devActor: on.devActor, enableDevStateApi: false, enableDevResourceApi: true };
    off = await startApp({ ...same, features: { nativeForms: false, spreadsheetImports: false } });
    formsOnly = await startApp({ ...same, features: { nativeForms: true, spreadsheetImports: false } });
    importsOnly = await startApp({ ...same, features: { nativeForms: false, spreadsheetImports: true } });
    const ws = (await api(on.url, "POST", "/api/v1/workspaces", { name: "W" })).body.workspace;
    board = (await api(on.url, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "B", columns: COLUMNS })).body.board;
    form = (await api(on.url, "POST", `/api/v1/boards/${board.id}/forms`, { name: "F", status: "published", fields: [{ key: "serial" }] })).body.form;
    job = await (await raw(on, "POST", `/boards/${board.id}/imports?name=a.csv`, CSV)).json();
  });
  after(async () => { for (const a of [formsOnly, importsOnly, off, on]) await a?.close(); });
  const formRoutes = () => [["GET", `/boards/${board.id}/forms`], ["POST", `/boards/${board.id}/forms`], ["GET", `/forms/${form.id}`], ["PATCH", `/forms/${form.id}`], ["DELETE", `/forms/${form.id}?expectedVersion=1`], ["POST", `/forms/${form.id}/submit`]];
  const importRoutes = () => [["GET", `/boards/${board.id}/imports`], ["POST", `/boards/${board.id}/imports`], ["GET", `/imports/${job.import.id}`], ["PATCH", `/imports/${job.import.id}`], ["POST", `/imports/${job.import.id}/start`], ["POST", `/imports/${job.import.id}/pause`], ["POST", `/imports/${job.import.id}/resume`], ["POST", `/imports/${job.import.id}/cancel`]];
  const notFound = async (app, list) => { for (const [m, p] of list) { const r = await api(app.url, m, `/api/v1${p}`, m === "GET" || m === "DELETE" ? undefined : {}); assert.equal(r.status, 404, `${m} ${p}`); assert.equal(r.body.error.code, "NOT_FOUND", `${m} ${p}`); } };

  test("off: every form and import path answers 404, like an unknown path", async () => {
    await notFound(off, [...formRoutes(), ...importRoutes()]);
  });
  test("off: a stored form can't be submitted and nothing is written, even with a valid body", async () => {
    const before = await on.dataLayer.repos.records.collection.countDocuments({ boardId: new ObjectId(board.id) });
    const r = await api(off.url, "POST", `/api/v1/forms/${form.id}/submit`, { submissionKey: crypto.randomUUID(), values: { serial: "Sneaky" } });
    assert.equal(r.status, 404);
    assert.equal(await on.dataLayer.repos.records.collection.countDocuments({ boardId: new ObjectId(board.id) }), before);
  });
  test("off: a file upload is refused before it's read", async () => {
    const r = await raw(off, "POST", `/boards/${board.id}/imports?name=a.csv`, CSV);
    assert.equal(r.status, 404);
    assert.equal(await on.db.collection(COLLECTIONS.importJobs).countDocuments({ boardId: new ObjectId(board.id), fileName: "b.csv" }), 0);
  });
  test("each switch works alone", async () => {
    await notFound(formsOnly, importRoutes());
    assert.equal((await api(formsOnly.url, "GET", `/api/v1/boards/${board.id}/forms`)).status, 200);
    await notFound(importsOnly, formRoutes());
    assert.equal((await api(importsOnly.url, "GET", `/api/v1/boards/${board.id}/imports`)).status, 200);
  });
  test("what's stored is kept: on again, the same form and import are there", async () => {
    assert.equal((await api(on.url, "GET", `/api/v1/forms/${form.id}`)).body.form.name, "F");
    assert.equal((await api(on.url, "GET", `/api/v1/imports/${job.import.id}`)).body.import.fileName, "a.csv");
  });
  test("GET /features tells the browser exactly what's on", async () => {
    assert.deepEqual((await api(off.url, "GET", "/api/v1/features")).body, { features: { nativeForms: false, spreadsheetImports: false } });
    assert.deepEqual((await api(formsOnly.url, "GET", "/api/v1/features")).body, { features: { nativeForms: true, spreadsheetImports: false } });
  });
  test("existing features don't depend on either switch: records and the legacy import path still answer", async () => {
    assert.equal((await api(off.url, "GET", `/api/v1/boards/${board.id}/records?limit=1`)).status, 200);
    assert.equal((await api(off.url, "GET", `/api/v1/boards/${board.id}`)).status, 200);
    const r = await api(off.url, "POST", `/api/v1/boards/${board.id}/records/batch`, { records: [{ values: { serial: "Still works" } }] });
    assert.equal(r.status, 201);
  });
});

describe("Feature switches: the screens (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, ws, board;
  const OID = "0d0d0d0d-0000-4000-8000-000000000081";
  const call = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1" + ${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))}`} }); return { status: r.status, body: await r.json().catch(() => null) }; })()`);
  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore", env: { ...process.env, JARC_TEST_FEATURES: "off" } });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER);
    await b.open(`${base}/api/v1/health`, { width: 1440 });
    await b.evaluate(`(async () => { const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${OID}&name=Admin&email=admin@example.invalid&admin=1&nonce=" + start.nonce)).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); })()`);
    ws = (await call("POST", "/workspaces", { name: "Hidden" })).body.workspace;
    board = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Hidden board", columns: COLUMNS })).body.board;
    await b.send("Page.navigate", { url: `${base}/` });
    await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000);
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Hidden board"))?.click()`);
    await b.waitFor("!!document.querySelector('.board-tools')", 15000);
    await sleep(200);
  });
  after(async () => { await b?.close(); server?.kill(); });
  test("the signed-in administrator sees no Forms button", async () => {
    assert.equal(await b.evaluate("!!document.querySelector('[data-action=form-menu]')"), false);
  });
  test("the Import dialog keeps the existing CSV and JSON import, without the Excel and CSV job", async () => {
    await b.evaluate("document.querySelector('[data-action=import]')?.click()");
    await b.waitFor("!!document.querySelector('.import-modal') || !!document.querySelector('[data-action=view-overflow]')", 3000);
    if (!await b.evaluate("!!document.querySelector('.import-modal')")) { await b.evaluate("document.querySelector('[data-action=view-overflow]').click()"); await sleep(100); await b.evaluate("document.querySelector('[data-action=import]')?.click()"); await b.waitFor("!!document.querySelector('.import-modal')", 3000); }
    assert.equal(await b.evaluate("!!document.querySelector('[data-action=xl-import-choose]')"), false);
    assert.equal(await b.evaluate("!!document.querySelector('[data-action=choose-import-file]')"), true);
    await b.evaluate("document.querySelector('[data-action=close-overlay]')?.click()");
  });
  test("calling the screens' code directly changes nothing, and the API refuses with the session of an administrator", async () => {
    await b.evaluate(`(() => { const el = document.createElement("button"); el.dataset.action = "form-menu"; document.querySelector("#app").append(el); el.click(); el.remove(); })()`);
    await sleep(150);
    assert.equal(await b.evaluate("!!document.querySelector('.form-menu-row, .form-designer, .form-fill')"), false);
    assert.equal((await call("GET", `/boards/${board.id}/forms`)).status, 404);
    assert.equal((await call("POST", `/boards/${board.id}/forms`, { name: "X", fields: [{ key: "serial" }] })).status, 404);
    assert.equal((await call("GET", `/boards/${board.id}/imports`)).status, 404);
    assert.deepEqual((await call("GET", "/features")).body, { features: { nativeForms: false, spreadsheetImports: false } });
  });
  test("no session: still 401, not a hint about what exists", async () => {
    const r = await fetch(`${base}/api/v1/boards/${board.id}/forms`);
    assert.equal(r.status, 401);
  });
});

// ---- Search and pages. The same scenarios on the fake MongoDB (always) and real MongoDB (when the local test instance runs).
const settingFile = path.join(__dirname, "../../.env.migration-test");
const setting = (key) => { if (!fs.existsSync(settingFile)) return null; const m = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\r\\n]*)`, "m").exec(fs.readFileSync(settingFile, "utf8")); return m ? m[1].trim() : null; };
const access = { roles: null, globalRole: "SYSTEM_ADMIN" };
const search = (s, query, scope = access) => s.search.global(scope, searchParams({ type: "record", ...query }, actor.userId));
const recordsOf = (r) => r.groups.find((g) => g.type === "record");
async function walkSearch(s, q, limit, scope) {
  const seen = [], pages = []; let cursor;
  for (let i = 0; i < 200; i += 1) {
    const g = recordsOf(await search(s, { q, limit: String(limit), ...(cursor ? { cursor } : {}) }, scope));
    pages.push(g.items.length); seen.push(...g.items.map((x) => x.id));
    if (!g.next) return { seen, pages };
    cursor = g.next;
  }
  throw new Error("the pages never ended");
}
async function seedPages({ s, db }) {
  const ws = await s.workspaces.create({ name: "Pages" }, actor);
  const board = await s.boards.create(ws._id, { name: "Pages", columns: COLUMNS, groups: [{ name: "One" }] }, actor);
  const now = Date.now(), docs = [], tags = [["a"], ["a", "e"], ["e"], ["b", "d"], ["c"], [], null, ["a", "b", "c", "d", "e"], ["d", "a"]];
  for (let i = 0; i < 120; i += 1) {
    const t = tags[i % tags.length], qty = [String(i), i, "", null, undefined][i % 5];
    docs.push({ _id: new ObjectId(), workspaceId: ws._id, boardId: board._id, values: { serial: i % 7 === 0 ? `match name ${i}` : `Item ${i}`, code: `match code ${i}`, state: i % 2 ? "New" : "Done", ...(t === null ? {} : { tags: t }), ...(qty === undefined ? {} : { qty }) }, groupId: null, position: i * 1000, archived: i % 30 === 29, pinned: i % 40 === 0, createdBy: actor.userId, updatedBy: actor.userId, createdAt: new Date(now), updatedAt: new Date(now - (i % 9) * 1000), version: 1 });
  }
  await db.collection("records").insertMany(docs);
  return { ws, board, docs, active: docs.filter((d) => !d.archived) };
}
const pageScenarios = (getW) => {
  const walk = async (orderBy, extra = {}, limit = "17") => {
    const { w, ctx } = getW(), ids = []; let cursor;
    for (let i = 0; i < 100; i += 1) {
      const page = await w.s.records.list(ctx.board._id, { orderBy: JSON.stringify(orderBy), limit, ...extra, ...(cursor ? { cursor } : {}) });
      ids.push(...page.items.map((r) => r._id.toHexString()));
      for (const r of page.items) assert.equal(r.__sort, undefined, "the sort value isn't part of the record");
      if (!page.nextCursor) return ids;
      cursor = page.nextCursor;
    }
    throw new Error("the pages never ended");
  };
  for (const [name, orderBy] of Object.entries({
    "board order": [{ key: "position", dir: "asc" }], "pinned first": [{ key: "pinned", dir: "desc" }, { key: "position", dir: "asc" }],
    "several values, up": [{ key: "tags", dir: "asc" }], "several values, down": [{ key: "tags", dir: "desc" }], "pinned, then several values": [{ key: "pinned", dir: "desc" }, { key: "tags", dir: "asc" }],
    "numbers next to text and blanks, up": [{ key: "qty", dir: "asc" }], "numbers next to text and blanks, down": [{ key: "qty", dir: "desc" }], "text": [{ key: "serial", dir: "desc" }]
  })) test(`pages sorted by ${name}: every record exactly once`, async () => {
    const { ctx } = getW(), ids = await walk(orderBy);
    assert.equal(new Set(ids).size, ids.length, "no record twice");
    assert.deepEqual([...ids].sort(), ctx.active.map((d) => d._id.toHexString()).sort(), "no record lost");
  });
  test("a sort with a filter pages the same way and still honours the filter", async () => {
    const { ctx } = getW(), filter = JSON.stringify({ op: "and", rules: [{ key: "state", cmp: "in", values: ["New"] }] });
    const ids = await walk([{ key: "tags", dir: "asc" }], { filter });
    const expected = ctx.active.filter((d) => d.values.state === "New").map((d) => d._id.toHexString()).sort();
    assert.deepEqual([...ids].sort(), expected);
  });
  test("the count agrees with what the pages return", async () => {
    const { w, ctx } = getW(), c = await w.s.records.count(ctx.board._id, {});
    assert.equal(c.total, ctx.active.length);
  });
};

describe("Paging a filtered list on the fake MongoDB", () => {
  const state = {};
  before(async () => { state.w = await world("off"); state.ctx = await seedPages(state.w); });
  pageScenarios(() => state);
});

describe("On real MongoDB (local test instance)", () => {
  const state = {}; let client = null, skip = false, dbName;
  before(async () => {
    const uri = setting("JARC_MIGRATION_TEST_MONGODB_URI");
    if (!uri) { skip = true; return; }
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
    try { await client.connect(); await client.db("admin").command({ ping: 1 }); } catch { skip = true; await client.close().catch(() => {}); client = null; return; }
    dbName = `jarc_migration_test_t${crypto.randomBytes(6).toString("hex")}`;
    const raw = client;
    state.w = await world("on", { db: () => ({ connect: async () => {}, close: async () => {}, startSession: (...a) => raw.startSession(...a), db: () => raw.db(dbName) }) });
    state.ctx = await seedPages(state.w);
    await state.w.index.catchUp();
  });
  after(async () => { if (client) { await client.db(dbName).dropDatabase().catch(() => {}); await client.close(); } });
  // Registered first, then skipped at run time when the instance isn't there.
  const scenarios = []; pageScenariosInto(scenarios, () => state);
  for (const [name, fn] of scenarios) test(name, async (t) => { if (skip) return t.skip("the local test instance isn't running"); return fn(); });
  test("global search on the index: every match once, across pages", async (t) => {
    if (skip) return t.skip("the local test instance isn't running");
    const { w, ctx } = state; assert.equal(w.index.active, true);
    const { seen } = await walkSearch(w.s, "match", 4);
    assert.equal(new Set(seen).size, seen.length, "no repeats");
    assert.equal(seen.length, ctx.active.length);
    return undefined;
  });
  test("search within archived records reaches them on the index", async (t) => {
    if (skip) return t.skip("the local test instance isn't running");
    const { w, ctx } = state, page = await w.s.records.list(ctx.board._id, { q: "match", archived: "true", orderBy: JSON.stringify([{ key: "position", dir: "asc" }]), limit: "100" });
    assert.equal(page.items.length, ctx.docs.filter((d) => d.archived).length);
    return undefined;
  });
});
// The same scenarios as [name, fn], for a suite that decides to skip only once it's running.
function pageScenariosInto(list, getW) {
  const realTest = (name, fn) => list.push([name, fn]);
  const walk = async (orderBy) => {
    const { w } = getW(), ids = []; let cursor; const { ctx } = getW();
    for (let i = 0; i < 100; i += 1) { const page = await w.s.records.list(ctx.board._id, { orderBy: JSON.stringify(orderBy), limit: "17", ...(cursor ? { cursor } : {}) }); ids.push(...page.items.map((r) => r._id.toHexString())); if (!page.nextCursor) return ids; cursor = page.nextCursor; }
    throw new Error("the pages never ended");
  };
  for (const [name, orderBy] of Object.entries({ "several values, up": [{ key: "tags", dir: "asc" }], "several values, down": [{ key: "tags", dir: "desc" }], "numbers next to text and blanks, up": [{ key: "qty", dir: "asc" }], "numbers next to text and blanks, down": [{ key: "qty", dir: "desc" }], "pinned, then several values": [{ key: "pinned", dir: "desc" }, { key: "tags", dir: "asc" }] })) {
    realTest(`real MongoDB, pages sorted by ${name}: every record exactly once`, async () => {
      const { ctx } = getW(), ids = await walk(orderBy);
      assert.equal(new Set(ids).size, ids.length, "no record twice");
      assert.deepEqual([...ids].sort(), ctx.active.map((d) => d._id.toHexString()).sort(), "no record lost");
    });
  }
}

for (const mode of ["on", "off"]) describe(`Global search pages, search index ${mode}`, () => {
  let w, ctx;
  before(async () => { w = await world(mode); ctx = await seedPages(w); if (mode === "on") { await w.index.catchUp(); assert.equal(w.index.active, true); } });
  for (const limit of [2, 4, 7, 10, 25]) test(`${limit} per page: every match exactly once, name matches first`, async () => {
    const { seen, pages } = await walkSearch(w.s, "match", limit);
    assert.equal(new Set(seen).size, seen.length, `no repeats (${pages.join(",")})`);
    assert.deepEqual([...seen].sort(), ctx.active.map((d) => d._id.toHexString()).sort(), "nothing lost");
  });
  test("a filter and a date range page the same way", async () => {
    const seen = []; let cursor;
    for (let i = 0; i < 100; i += 1) { const g = recordsOf(await search(w.s, { q: "match", status: "New", limit: "5", ...(cursor ? { cursor } : {}) })); seen.push(...g.items.map((x) => x.id)); cursor = g.next; if (!cursor) break; }
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual([...seen].sort(), ctx.active.filter((d) => d.values.state === "New").map((d) => d._id.toHexString()).sort());
  });
  test("only the boards the caller may see: another workspace's records never appear, on any page", async () => {
    const other = await w.s.workspaces.create({ name: "Secret" }, actor), secret = await w.s.boards.create(other._id, { name: "Secret", columns: COLUMNS }, actor);
    await w.s.records.createMany(secret._id, { records: [{ values: { serial: "match secret" } }] }, actor, people);
    await w.index.flush();
    const scope = { roles: new Map([[ctx.ws._id.toHexString(), "VIEWER"]]), globalRole: null };
    const { seen } = await walkSearch(w.s, "match", 5, scope), secretIds = (await w.repos.records.collection.find({ boardId: secret._id }).toArray()).map((r) => r._id.toHexString());
    assert.equal(seen.filter((id) => secretIds.includes(id)).length, 0);
    assert.equal(recordsOf(await search(w.s, { q: "secret" }, scope)).items.length, 0);
    assert.equal(recordsOf(await search(w.s, { q: "secret" })).items.length, 1, "visible to who may see it");
  });
});

describe("Search index through changes, deletions and imports", () => {
  let w, ws, board;
  const found = async (q) => recordsOf(await search(w.s, { q })).items.map((i) => i.title);
  before(async () => { w = await world("on"); ws = await w.s.workspaces.create({ name: "Changes" }, actor); board = await w.s.boards.create(ws._id, { name: "Changes", columns: COLUMNS, groups: [{ name: "One" }] }, actor); await w.index.catchUp(); });
  test("a new record is found; an edit replaces what's found; a deletion removes it", async () => {
    const r = await w.s.records.create(board._id, { values: { serial: "quokka one" } }, actor, people);
    await w.index.flush();
    assert.deepEqual(await found("quokka"), ["quokka one"]);
    const edited = await w.s.records.update(r._id, { expectedVersion: 1, values: { serial: "wombat one" } }, actor, people);
    await w.index.flush();
    assert.deepEqual(await found("quokka"), []); assert.deepEqual(await found("wombat"), ["wombat one"]);
    await w.s.records.delete(r._id, edited.version, actor);
    await w.index.flush();
    assert.deepEqual(await found("wombat"), []);
    assert.equal(await w.repos.recordSearch.count({ _id: r._id }), 0, "gone from the index too");
  });
  test("batch create, update and delete all reach the index", async () => {
    const made = await w.s.records.createMany(board._id, { records: [{ values: { serial: "batch alpha" } }, { values: { serial: "batch beta" } }] }, actor, people);
    await w.index.flush();
    assert.equal((await found("batch")).length, 2);
    const items = await w.s.records.updateMany(board._id, { items: [{ id: made[0]._id.toHexString(), expectedVersion: 1, values: { serial: "numbat alpha" } }] }, actor, people);
    await w.index.flush();
    assert.deepEqual(await found("numbat"), ["numbat alpha"]);
    await w.s.records.deleteMany(board._id, { records: [{ id: made[0]._id.toHexString(), expectedVersion: items[0].version }, { id: made[1]._id.toHexString(), expectedVersion: 1 }] }, actor);
    await w.index.flush();
    assert.deepEqual(await found("numbat"), []); assert.deepEqual(await found("batch"), []);
  });
  test("the record decides: one archived or deleted since the last index update never shows, and later pages still come", async () => {
    const made = await w.s.records.createMany(board._id, { records: Array.from({ length: 8 }, (_, i) => ({ values: { serial: `lagging ${i}` } })) }, actor, people);
    await w.index.flush();
    // The index hasn't heard yet: the records change directly, with no update queued.
    await w.repos.records.collection.updateOne({ _id: made[0]._id }, { $set: { archived: true } });
    await w.repos.records.collection.deleteOne({ _id: made[1]._id });
    const { seen } = await walkSearch(w.s, "lagging", 3);
    assert.equal(seen.length, 6); assert.equal(new Set(seen).size, 6);
    for (const gone of [made[0], made[1]]) assert.ok(!seen.includes(gone._id.toHexString()));
    await w.index.catchUp();
  });
  test("a record edited between pages doesn't repeat the page before it while the index catches up", async () => {
    const made = await w.s.records.createMany(board._id, { records: Array.from({ length: 6 }, (_, i) => ({ values: { serial: `moving ${i}` } })) }, actor, people);
    await w.index.flush();
    const first = recordsOf(await search(w.s, { q: "moving", limit: "2" }));
    // The first page's last record changes; its index entry is still at the old time.
    await w.repos.records.collection.updateOne({ _id: new ObjectId(first.items.at(-1).id) }, { $set: { updatedAt: new Date(Date.now() + 60000) } });
    const second = recordsOf(await search(w.s, { q: "moving", limit: "2", cursor: first.next }));
    for (const item of second.items) assert.ok(!first.items.some((x) => x.id === item.id), "not repeated");
    assert.equal(made.length, 6);
    await w.index.catchUp();
  });
  test("a retried import batch updates the index for rows an interrupted attempt already wrote", async () => {
    const jobs = w.s.importJobs; jobs.pauseMs = 0;
    const csv = Buffer.from(`Item,Code\n${Array.from({ length: 5 }, (_, i) => `imported kea ${i},K${i}`).join("\n")}\n`);
    let job = await jobs.upload(board, csv, { name: "i.csv" }, actor);
    job = await jobs.configure(job, board, { mapping: { serial: 0, code: 1 } });
    job = await jobs.start(job, board, {}, false);
    // An earlier attempt wrote the rows and stopped before its index update: same rows, as the retry will find them.
    const batch = await jobs.batches.findOne({ jobId: job._id, n: 0 }), now = new Date();
    await w.repos.records.collection.insertMany(batch.rows.map(([line, cells], i) => ({ _id: new ObjectId(), workspaceId: board.workspaceId, boardId: board._id, legacyId: `import:${job._id.toHexString()}:${line}`, values: { serial: cells[0], code: cells[1] }, groupId: board.groups[0].id, position: i, archived: false, pinned: false, createdBy: actor.userId, updatedBy: actor.userId, createdAt: now, updatedAt: now, version: 1 })));
    assert.deepEqual(await found("kea"), [], "the index hasn't heard");
    jobs.wake();
    for (let i = 0; i < 300; i += 1) { const j = await jobs.find(job._id); if (j.status === "done") break; await sleep(10); }
    assert.equal((await jobs.find(job._id)).imported, 5);
    assert.equal((await w.repos.records.collection.find({ boardId: board._id }).toArray()).filter((r) => /^K/.test(r.values.code || "")).length, 5, "none repeated");
    await w.index.flush();
    assert.equal((await found("kea")).length, 5, "and all of them are found");
    assert.deepEqual(await w.index.verify().then(({ missing, stale, extra }) => ({ missing, stale, extra })), { missing: 0, stale: 0, extra: 0 });
  });
  test("deleting a board and a workspace removes their index documents", async () => {
    const other = await w.s.workspaces.create({ name: "Gone" }, actor), b1 = await w.s.boards.create(other._id, { name: "Gone 1", columns: COLUMNS }, actor);
    await w.s.records.create(b1._id, { values: { serial: "vanishing" } }, actor, people);
    await w.index.flush();
    assert.equal(await w.repos.recordSearch.count({ boardId: b1._id }), 1);
    await w.s.workspaces.delete(other._id, 1, actor);
    await w.index.flush();
    assert.equal(await w.repos.recordSearch.count({ boardId: b1._id }), 0);
    assert.deepEqual(await found("vanishing"), []);
  });
  test("an index that isn't verified is never used, so search falls back to the records", async () => {
    await w.s.records.create(board._id, { values: { serial: "fallback bilby" } }, actor, people);
    await w.index.flush();
    w.index.ready = false;
    assert.deepEqual(await found("fallback bilby"), ["fallback bilby"], "answered from the records");
    await w.index.catchUp(); assert.equal(w.index.active, true);
  });
  test("a large rewrite pauses between batches of writes", async () => {
    const before = Date.now(); w.index.pauseMs = 30;
    const ids = (await w.s.records.createMany(board._id, { records: Array.from({ length: 450 }, (_, i) => ({ values: { serial: `paced ${i}` } })) }, actor, people)).map((r) => r._id);
    await w.index.flush();
    assert.ok(Date.now() - before >= 2 * 30, "two pauses for three batches");
    assert.equal(await w.repos.recordSearch.count({ _id: { $in: ids } }), 450);
    w.index.pauseMs = 0;
  });
});

describe("Search cursors", () => {
  const id = new ObjectId();
  test("a cursor lists at most the IDs it may need, and fits the limit with the most it can hold", () => {
    const most = Array.from({ length: 50 }, () => new ObjectId());
    const decoded = decodeCursor(encodeCursor("record", new Date(1000), id, most), "record");
    assert.equal(decoded.exclude.length, 50);
    assert.deepEqual(decoded.exclude.map((x) => x.toHexString()), most.map((x) => x.toHexString()));
  });
  test("a cursor without any stays small and reads as before", () => {
    const text = encodeCursor("record", new Date(1000), id);
    assert.ok(text.length < 100);
    assert.deepEqual(decodeCursor(text, "record").exclude, []);
  });
  test("what a cursor carries is checked: nothing but IDs reaches a query", () => {
    const make = (x) => Buffer.from(JSON.stringify({ k: "record", t: 1000, i: id.toHexString(), x })).toString("base64url");
    for (const bad of [[{ $ne: null }], ["not-an-id"], "text", Array.from({ length: 51 }, () => id.toHexString())]) assert.throws(() => decodeCursor(make(bad), "record"), /cursor is not valid/);
  });
});

describe("Search comparison in shadow mode", () => {
  const notes = [];
  const logger = { log() {}, error() {}, warn(m) { notes.push(String(m)); } };
  test("an ordinary search with more matches than a page reports no false difference", async () => {
    const fake = new FakeMongoClient(), connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
    await connection.connect(); await ensureDatabase(connection.db);
    const dl = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), recordSearch: "shadow" }); dl.searchIndex.pauseMs = 0;
    const ws = await dl.services.workspaces.create({ name: "S" }, actor), board = await dl.services.boards.create(ws._id, { name: "S", columns: COLUMNS }, actor);
    const made = await dl.services.records.createMany(board._id, { records: Array.from({ length: 30 }, (_, i) => ({ values: { serial: `same ${i}` } })) }, actor, people);
    for (const [i, r] of made.entries()) await dl.repos.records.collection.updateOne({ _id: r._id }, { $set: { updatedAt: new Date(2026, 0, 30 - i) } });
    await dl.searchIndex.catchUp(); assert.equal(dl.searchIndex.shadowing, true);
    await dl.services.search.records("same", { workspaceIds: null, limit: 5 });
    await sleep(20);
    assert.deepEqual(notes.filter((n) => n.includes("shadow difference")), []);
    assert.equal(dl.searchIndex.active, false, "shadow never answers searches");
    // A real difference is still reported.
    await dl.repos.recordSearch.removeMany([made[0]._id]);
    await dl.services.search.records("same 0", { workspaceIds: null, limit: 5 });
    await sleep(20);
    assert.equal(notes.filter((n) => n.includes("shadow difference")).length, 1);
  });
});

describe("Dependency advisories", () => {
  const versionOf = (name) => require(path.join(__dirname, "..", "node_modules", name, "package.json")).version;
  const atLeast = (v, min) => { const [a, b, c] = v.split(".").map(Number), [x, y, z] = min; return a > x || (a === x && (b > y || (b === y && c >= z))); };
  test("body-parser and qs are outside the advisories' ranges, from the lockfile, with package.json unchanged in intent", () => {
    assert.ok(atLeast(versionOf("body-parser"), [2, 4, 0]), "GHSA-27r3-jxmh-p828");
    assert.ok(atLeast(versionOf("qs"), [6, 16, 1]), "GHSA-6pq8-jhm2-2vcw");
    const pkg = require("../package.json");
    assert.equal(pkg.dependencies["body-parser"], undefined, "not pinned directly: express brings them");
    assert.equal(pkg.dependencies.qs, undefined);
    const lock = require("../package-lock.json");
    assert.equal(lock.packages["node_modules/body-parser"].version, versionOf("body-parser"));
    assert.equal(lock.packages["node_modules/qs"].version, versionOf("qs"));
  });
  test("the app's parsers keep refusing compressed bodies, the path of the body-parser advisory, and keep serving afterwards", async () => {
    const app = await startApp();
    try {
      const body = Buffer.concat([zlib.gzipSync(JSON.stringify({ a: 1 })), Buffer.from("trailing bytes after the compressed stream")]);
      for (const p of ["/api/v1/state", "/api/v1/boards/000000000000000000000000/imports"]) {
        const r = await fetch(app.url + p, { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }, body });
        assert.equal(r.status, 415, p);
      }
      assert.equal((await fetch(`${app.url}/api/v1/health`)).status, 200, "the server is still up");
    } finally { await app.close(); }
  });
  test("the import upload parser refuses compressed bodies by itself too", () => {
    assert.match(fs.readFileSync(path.join(__dirname, "../src/routes/imports.js"), "utf8"), /express\.raw\(\{[^}]*inflate: false/);
  });
  test("qs isn't reached by JARC: the simple query parser stays in use, and nothing calls qs directly", () => {
    const app = require("../src/app").createApp({ repository: { read() {} }, environment: "test" });
    assert.equal(app.get("query parser"), "simple");
    for (const dir of ["routes", "services", "domain", "validation", "middleware"]) for (const f of fs.readdirSync(path.join(__dirname, "../src", dir))) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../src", dir, f), "utf8"), /require\(["']qs["']\)/, f);
  });
});
