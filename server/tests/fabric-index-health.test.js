// Fabric index health in System Health (src/fabric/health.js, GET /admin/system-health "fabric", SystemHealthPanel):
// detailed view for Fabric readers, general status (healthy / degraded / unavailable) for everyone else; one warn line per
// state transition; the 5-minute background check (metadata only, unref'd, stops cleanly, never while Fabric is off); only
// listIndexes / estimatedDocumentCount / hinted queries ever reach Fabric; failures degrade to "unavailable" without breaking
// the rest of System Health. Offline: JARC on its fake MongoDB, local Entra test keys, Fabric on tests/support/fabric-fake.js.
// Synthetic data only. The browser test needs Chrome or Edge (one browser, closed at the end).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { createFabricData } = require("../src/fabric");
const { FabricIndexHealth, generalView, detailedView, overallStatus } = require("../src/fabric/health");
const { viewerView } = require("../src/routes/system-health");
const { loadConfig } = require("../src/config");
const { createApp } = require("../src/app");
const { MemoryStateRepository } = require("../src/repositories/memory-state-repository");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { createEntraVerifier } = require("../src/auth/entra-token");
const { SessionClient, entraEnv } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FakeMongoClient } = require("./support/fake-mongo");
const { findBrowser, launch, freePort } = require("./support/headless-browser");
const { FabricFakeClient, row, inventoryRows, startFabricApp, DEFAULT_INDEXES, ID_ONLY, serverError } = require("./support/fabric-fake");

const HEALTH_LINE = "[fabric] index health:";
const at = (iso) => ObjectId.createFromTime(Math.floor(Date.parse(iso) / 1000));
const salesDocs = (loaded = "2026-11-20T00:00:00Z") => [
  row({ _id: at(loaded), Company: "ALPHA", invoice_id: "1001", Line_No: 10000, invoice_date: new Date("2026-03-10T00:00:00Z"), customer_name: "Example Customer One" }),
  row({ _id: at("2026-11-21T00:00:00Z"), Company: "ALPHA", invoice_id: "1002", Line_No: 10000, invoice_date: new Date("2026-03-12T00:00:00Z"), customer_name: "Example Customer Two" })
];
const fabricEnv = (people, overrides = {}) => entraEnv({ JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb", FABRIC_DATA_READER_OIDS: [people.reader.oid, people.adminReader.oid].join(","), FABRIC_API_ADMIN_OIDS: people.adminReader.oid, ...overrides });
const QUERY_OPS = ["aggregate", "countDocuments", "find"];

let issuer, people;
before(async () => {
  issuer = await createTokenIssuer();
  people = {
    reader: issuer.person("Synthetic Fabric Reader"), viewer: issuer.person("Synthetic Health Viewer"), plain: issuer.person("Synthetic Plain"),
    admin: issuer.person("Synthetic Jarc Admin", { admin: true }), adminReader: issuer.person("Synthetic Admin Reader", { admin: true })
  };
});

// A Fabric stack over the fake (createFabricData), with a log that keeps every line, and a controllable clock.
const SCAN_1 = { FABRIC_UNINDEXED_SCAN_MAX: "1" }; // every dataset is "large": no small mode
function stack({ fake = {}, env = {} } = {}) {
  const client = new FabricFakeClient({ docs: salesDocs(), inventory: { docs: inventoryRows(50) }, ...fake });
  const log = { warns: [], errors: [], warn(...a) { this.warns.push(a.join(" ")); }, error(...a) { this.errors.push(a.join(" ")); }, info() {} };
  const clock = { t: Date.parse("2026-11-27T03:00:00Z") };
  const cfg = loadConfig(fabricEnv(people, env)).fabricData;
  const s = createFabricData({ config: cfg, logger: log, createClient: () => client, now: () => new Date(clock.t) });
  return { ...s, client, log, clock, healthLines: () => log.warns.filter((l) => l.startsWith(HEALTH_LINE)) };
}
// Only metadata commands and HINTED queries ever reached Fabric (never an unindexed aggregate, count or find).
const assertOnlySafeOps = (client) => {
  for (const c of client.calls) {
    assert.ok(["listIndexes", "estimatedDocumentCount", ...QUERY_OPS].includes(c.op), c.op);
    if (QUERY_OPS.includes(c.op)) { assert.equal(c.op, "aggregate", "only aggregates"); assert.ok(c.options?.hint, `every query is hinted: ${JSON.stringify(c.options)}`); }
  }
  assert.equal(client.listCollectionsCalls, 0);
};

describe("FabricIndexHealth.snapshot (unit, fake Fabric)", () => {
  test("indexed sales + small inventory: ok / small_mode, index-backed dates only, _id probe hinted, healthy; no unindexed query", async () => {
    const s = stack();
    try {
      const snap = await s.health.snapshot();
      const sales = snap.datasets.sales, inv = snap.datasets.inventory;
      assert.equal(sales.state, "ok"); assert.equal(sales.mode, "indexed");
      assert.equal(sales.latestDate, "2026-03-12T00:00:00.000Z"); assert.equal(sales.earliestDate, "2026-03-10T00:00:00.000Z");
      assert.deepEqual(sales.requiredIndexes.map((r) => [r.name, r.present, r.nameTaken]), [["fabric_invoice_date", true, false]]);
      assert.equal(sales.copy.loadedAt, "2026-11-20T00:00:00.000Z");
      assert.equal(inv.state, "small_mode"); assert.equal(inv.mode, "small"); assert.equal(inv.estimate, 50);
      assert.equal(inv.latestDate, null, "small mode: no dates (never the unindexed aggregate)");
      assert.deepEqual(inv.requiredIndexes.map((r) => r.present), [false, false]);
      assert.equal(overallStatus(snap), "healthy");
      assertOnlySafeOps(s.client);
      const probes = s.client.calls.filter((c) => c.op === "aggregate" && c.options.hint === "_id_");
      assert.equal(probes.length, 4, "one key each way, per dataset");
      for (const p of s.client.pipelines.filter((pl) => pl[1]?.$sort?._id)) assert.deepEqual(p.slice(2), [{ $limit: 1 }, { $project: { _id: 1 } }]);
      assert.ok(!/[0-9a-f]{24}/i.test(JSON.stringify(snap)), "no _id leaves health");
      assert.deepEqual(s.healthLines(), [], "first observation: logs only when not ok; small mode is a state of its own");
    } finally { await s.close(); }
  });

  test("a missing index: index_missing, no dates, one warn; repeated → no new line; recreated → one warn back to ok", async () => {
    const s = stack({ fake: { indexes: ID_ONLY }, env: SCAN_1 });
    try {
      let snap = await s.health.snapshot();
      assert.equal(snap.datasets.sales.state, "index_missing"); assert.equal(snap.datasets.sales.mode, "unavailable");
      assert.equal(snap.datasets.sales.reason, "FABRIC_INDEX_REQUIRED"); assert.equal(snap.datasets.sales.latestDate, null);
      assert.equal(snap.datasets.sales.requiredIndexes[0].present, false);
      assert.equal(overallStatus(snap), "degraded");
      assert.deepEqual(s.healthLines(), ["[fabric] index health: sales index_missing (mode unavailable; missing fabric_invoice_date)", "[fabric] index health: inventory index_missing (mode unavailable; missing fabric_inventory_date, fabric_inventory_entry)"]);
      await s.health.snapshot(); await s.health.tick();
      assert.equal(s.healthLines().length, 2, "same state: no new line");
      s.client.store.indexes = DEFAULT_INDEXES.map((i) => ({ ...i }));
      await s.health.tick();
      snap = await s.health.snapshot();
      assert.equal(snap.datasets.sales.state, "ok");
      assert.deepEqual(s.healthLines().slice(2), ["[fabric] index health: sales ok (mode indexed) after index_missing"]);
      assertOnlySafeOps(s.client);
      for (const l of s.healthLines()) assert.ok(!/ALPHA|Example|fabric\.invalid|FabricTestDb|[0-9a-f]{24}/.test(l), l);
    } finally { await s.close(); }
  });

  test("an index with the right name but the wrong shape (partial / sparse / collated / reordered): nameTaken", async () => {
    for (const extra of [{ partialFilterExpression: { Company: { $exists: true } } }, { sparse: true }, { collation: { locale: "en" } }, { key: { Company: 1, invoice_date: -1, invoice_id: 1, _id: 1 } }]) {
      const s = stack({ fake: { indexes: [ID_ONLY[0], { ...DEFAULT_INDEXES[1], ...extra }] }, env: SCAN_1 });
      try {
        const r = (await s.health.snapshot()).datasets.sales.requiredIndexes[0];
        assert.deepEqual([r.present, r.nameTaken], [false, true], JSON.stringify(extra));
      } finally { await s.close(); }
    }
  });

  test("invoice views on: the detail index is required too (listed with the date index's needs merged)", async () => {
    const s = stack({ env: { FABRIC_INVOICE_VIEWS: "true" }, fake: { indexes: [ID_ONLY[0], DEFAULT_INDEXES[1]] } });
    try {
      const sales = (await s.health.snapshot()).datasets.sales;
      assert.equal(sales.state, "index_missing");
      assert.deepEqual(sales.requiredIndexes.map((r) => [r.name, r.neededFor, r.present]), [["fabric_invoice_date", ["sort:date", "invoiceList"], true], ["fabric_invoice_detail", ["invoiceDetail"], false]]);
    } finally { await s.close(); }
  });

  test("uses the 60 s caches: two snapshots → one listIndexes per collection", async () => {
    const s = stack();
    try {
      await s.health.snapshot(); await s.health.snapshot();
      for (const c of ["FactSales", "FactInventory"]) assert.equal(s.client.calls.filter((x) => x.op === "listIndexes" && x.collection === c).length, 1, c);
    } finally { await s.close(); }
  });

  test("reload detection: the oldest _id moving forward → basis id; collection back after missing → source_returned; first observation never", async () => {
    const s = stack();
    try {
      assert.equal((await s.health.snapshot()).datasets.sales.reload, null);
      s.client.store.docs = salesDocs("2026-11-26T02:14:00Z").map((d, i) => (i ? { ...d, _id: at("2026-11-26T02:15:00Z") } : d));
      s.clock.t += 61 * 1000;
      s.health.sources.sales.invalidate({ bounds: true });
      const reload = (await s.health.snapshot()).datasets.sales.reload;
      assert.deepEqual(reload, { detectedAt: new Date(s.clock.t).toISOString(), basis: "id" });
    } finally { await s.close(); }
    const m = stack({ fake: { missing: true } });
    try {
      let snap = await m.health.snapshot();
      assert.equal(snap.datasets.sales.state, "source_missing"); assert.equal(snap.datasets.sales.requiredIndexes[0].present, null, "unknown, never 'missing'");
      assert.ok(m.healthLines().some((l) => l === "[fabric] index health: sales source_missing (mode unavailable)"));
      m.client.store.missing = false; m.client.inventory.missing = false;
      await m.health.tick();
      snap = await m.health.snapshot();
      assert.equal(snap.datasets.sales.reload.basis, "source_returned");
      assertOnlySafeOps(m.client);
    } finally { await m.close(); }
  });
});

describe("Failure modes degrade to unavailable", () => {
  test("unreachable Fabric: unavailable, present null, lastVerifiedAt kept from the last success, one warn per dataset", async () => {
    const s = stack();
    try {
      const ok = await s.health.snapshot();
      const verified = ok.datasets.sales.lastVerifiedAt;
      assert.ok(verified);
      s.client.connectError = Object.assign(new Error("getaddrinfo ENOTFOUND cluster0.fabric.invalid"), { name: "MongoServerSelectionError" });
      await s.connection.close(); s.connection.state = "idle";
      s.health.sources.sales.invalidate(); s.health.sources.inventory.invalidate();
      const snap = await s.health.snapshot();
      assert.equal(snap.datasets.sales.state, "unavailable"); assert.equal(snap.datasets.sales.reason, "FABRIC_UNAVAILABLE");
      assert.equal(snap.datasets.sales.requiredIndexes[0].present, null);
      assert.equal(snap.datasets.sales.lastVerifiedAt, verified, "kept across failures");
      assert.equal(snap.datasets.sales.latestDate, "2026-03-12T00:00:00.000Z", "last known date kept");
      assert.equal(overallStatus(snap), "unavailable");
      assert.deepEqual(generalView(snap), { detail: false, status: "unavailable", checkedAt: snap.checkedAt });
      assert.ok(!s.healthLines().join("\n").includes("ENOTFOUND"), "no driver text");
    } finally { await s.close(); }
  });

  test("a permission error (listIndexes refused, code 13) and a missing collection are states, not exceptions", async () => {
    const s = stack();
    try {
      s.client.failNext(serverError(13, "Unauthorized", "not authorized on FabricTestDb to execute command { listIndexes: \"FactSales\" }"));
      const snap = await s.health.snapshot();
      assert.equal(snap.datasets.sales.state, "unavailable"); assert.equal(snap.datasets.inventory.state, "small_mode", "the other dataset is unaffected");
      assert.ok(!JSON.stringify(snap).includes("not authorized"));
    } finally { await s.close(); }
    const m = stack({ fake: { inventory: { docs: [], missing: true } } });
    try {
      const snap = await m.health.snapshot();
      assert.equal(snap.datasets.inventory.state, "source_missing"); assert.equal(snap.datasets.sales.state, "ok");
      assert.equal(overallStatus(snap), "degraded");
    } finally { await m.close(); }
  });

  test("an unsafe login: unsafe, and the background check skips it entirely", async () => {
    const s = stack({ fake: { authInfo: { authenticatedUserRoles: [{ role: "readWrite", db: "FabricTestDb" }], authenticatedUserPrivileges: [] } } });
    try {
      const snap = await s.health.snapshot();
      assert.equal(snap.datasets.sales.state, "unsafe");
      const n = s.client.calls.length;
      assert.equal(await s.health.tick(), null);
      assert.equal(s.client.calls.length, n);
    } finally { await s.close(); }
  });
});

describe("Background check (5 minutes, metadata only)", () => {
  const fakeTimers = () => {
    const t = { set: [], cleared: [], unrefs: 0 };
    t.setInterval = (fn, ms) => { const h = { fn, ms, unref() { t.unrefs += 1; return h; } }; t.set.push(h); return h; };
    t.clearInterval = (h) => t.cleared.push(h);
    return t;
  };
  test("start(): one unref'd 5-minute interval (idempotent); a tick runs listIndexes + estimatedDocumentCount only; stop() and close() end it", async () => {
    const s = stack();
    const timers = fakeTimers();
    const h = new FabricIndexHealth({ sources: s.sources, indexes: s.indexes, repository: s.repository, connection: s.connection, config: s.config, logger: s.log, timers });
    try {
      assert.equal(h.start(), true); assert.equal(h.start(), false);
      assert.equal(timers.set.length, 1); assert.equal(timers.set[0].ms, 5 * 60 * 1000); assert.equal(timers.unrefs, 1);
      assert.equal(s.client.calls.length, 0, "nothing runs at start");
      await new Promise((r) => { timers.set[0].fn(); setTimeout(r, 50); });
      await h.tick();
      const ops = [...new Set(s.client.calls.map((c) => c.op))].sort();
      assert.deepEqual(ops, ["estimatedDocumentCount", "listIndexes"]);
      assert.ok(h.background.lastOkAt);
      h.stop();
      assert.deepEqual(timers.cleared, [timers.set[0]]); assert.equal(h.started, false);
    } finally { h.stop(); await s.close(); }
    // The real stack: close() stops it.
    const r = stack();
    assert.equal(r.health.start(), true); assert.equal(r.health.started, true);
    await r.close();
    assert.equal(r.health.started, false);
  });

  test("never overlapping: a tick while one runs returns the same run", async () => {
    const s = stack();
    try {
      const a = s.health.tick(), b = s.health.tick();
      assert.equal(a, b);
      await a;
      assert.equal(s.client.calls.filter((c) => c.op === "listIndexes").length, 2);
    } finally { await s.close(); }
  });

  test("Fabric off: start() does nothing; createFabricData refuses; System Health has no fabric part", async () => {
    const h = new FabricIndexHealth({ sources: {}, config: { enabled: false }, timers: fakeTimers() });
    assert.equal(h.start(), false); assert.equal(h.started, false);
    assert.throws(() => createFabricData({ config: { enabled: false } }));
  });

  test("a background failure that is not a Fabric error: logged once (code only), lastOkAt kept, ok again logged once", async () => {
    const s = stack();
    try {
      await s.health.tick();
      const okAt = s.health.background.lastOkAt;
      const real = s.sources.sales.info.bind(s.sources.sales);
      s.sources.sales.info = async () => { throw Object.assign(new TypeError("secret detail fabric.invalid"), { code: "X1" }); };
      s.clock.t += 1000;
      await s.health.tick(); await s.health.tick();
      assert.equal(s.health.background.lastOkAt, okAt);
      s.sources.sales.info = real;
      await s.health.tick();
      const lines = s.healthLines().filter((l) => l.includes("background"));
      assert.deepEqual(lines, ["[fabric] index health: background check failed (TypeError X1)", "[fabric] index health: background check ok again"]);
    } finally { await s.close(); }
  });
});

describe("Views (D1): general status vs detail", () => {
  const SECRET = "mongodb+srv://user:pass@cluster0.example.invalid/FabricProdDb 0123456789abcdef01234567 Example Customer Error: boom";
  const planted = () => ({
    checkedAt: "2026-11-27T03:00:00.000Z", connection: SECRET, background: { everyMinutes: 5, running: true, lastRunAt: SECRET, lastOkAt: "2026-11-27T02:55:00.000Z", extra: SECRET },
    datasets: { sales: { label: SECRET, state: "index_missing", mode: SECRET, reason: SECRET, estimate: 385326, scanMax: 20000, lastVerifiedAt: "2026-11-27T02:59:00.000Z", latestDate: SECRET, earliestDate: null, extra: SECRET,
      requiredIndexes: [{ name: "fabric_invoice_date", keys: { [SECRET]: 1 }, neededFor: ["sort:date", SECRET], present: false, nameTaken: SECRET, servedBy: SECRET }, { name: SECRET, keys: {}, neededFor: [], present: true }],
      copy: { loadedAt: SECRET, newestIdAt: "2026-11-26T02:14:00.000Z", id: SECRET }, reload: { detectedAt: "2026-11-26T02:20:00.000Z", basis: SECRET } } }
  });
  test("generalView: only detail, status, checkedAt — no counts, dates, names or keys", () => {
    const g = generalView(planted());
    assert.deepEqual(g, { detail: false, status: "degraded", checkedAt: "2026-11-27T03:00:00.000Z" });
    assert.deepEqual(generalView({ unavailable: true, error: "X" }), { detail: false, status: "unavailable", checkedAt: null });
    assert.deepEqual(generalView(g), g, "idempotent");
  });
  test("detailedView: rebuilt field by field; names and keys re-looked-up; admin extras only for admins", () => {
    const d = detailedView(planted(), { admin: false });
    const text = JSON.stringify(d);
    assert.ok(!/example\.invalid|FabricProdDb|0123456789abcdef|Example Customer|boom/.test(text), text);
    assert.equal(d.connection, "unknown"); assert.equal(d.datasets.sales.label, "Sales"); assert.equal(d.datasets.sales.mode, "unknown"); assert.equal(d.datasets.sales.reason, null);
    assert.equal(d.datasets.sales.estimate, 385326);
    assert.deepEqual(d.datasets.sales.requiredIndexes, [{ name: "fabric_invoice_date", keys: { invoice_date: -1, Company: 1, invoice_id: 1, _id: 1 }, neededFor: ["sort:date"], present: false, nameTaken: null }]);
    assert.equal(d.datasets.sales.reload.basis, "unknown");
    assert.ok(!("background" in d));
    const a = detailedView(planted(), { admin: true });
    assert.equal(a.background.lastRunAt, null); assert.equal(a.background.everyMinutes, 5);
    assert.equal(a.datasets.sales.requiredIndexes[0].servedBy, null, "an unsafe index name is never shown");
    assert.deepEqual(detailedView({ unavailable: true }), { detail: true, status: "unavailable", unavailable: true, checkedAt: null });
  });
  test("viewerView passes only the allow-listed Fabric part (general stays general)", () => {
    const base = { generatedAt: null, server: {}, database: {}, api: {}, integrations: { monday: {}, googleDrive: {} }, jobs: { integration: null, imports: null, searchIndex: null, recentFailures: [] } };
    assert.deepEqual(viewerView({ ...base, fabric: generalView(planted()) }).fabric, { detail: false, status: "degraded", checkedAt: "2026-11-27T03:00:00.000Z" });
    assert.ok(!("fabric" in viewerView({ ...base, fabric: null })));
    const v = viewerView({ ...base, fabric: detailedView(planted(), { admin: true }) }).fabric;
    assert.ok(!("background" in v) && !("servedBy" in v.datasets.sales.requiredIndexes[0]));
  });
});

describe("GET /admin/system-health with Fabric (real app)", () => {
  let app, fab, clients = new Map();
  const as = async (k, path = "/api/v1/admin/system-health") => {
    if (!clients.has(k)) { const c = new SessionClient(app.url, issuer.config.appOrigin); assert.equal((await c.signIn(people[k])).status, 201); clients.set(k, c); }
    return clients.get(k).request("GET", path);
  };
  before(async () => {
    fab = stack({ fake: { indexes: ID_ONLY }, env: SCAN_1 });
    app = await startFabricApp({ issuer, fabricData: fab, accessPolicy: "development_shared", betaOpenEditing: true, systemHealth: { viewerObjectIds: [people.viewer.oid, people.reader.oid] } });
  });
  after(async () => { await app?.close(); await fab?.close(); });

  test("System Health viewer without Fabric read: general status only — no counts, dates, names, keys", async () => {
    const h = await as("viewer");
    assert.equal(h.status, 200); assert.equal(h.body.scope, "viewer");
    assert.deepEqual(Object.keys(h.body.fabric).sort(), ["checkedAt", "detail", "status"]);
    assert.equal(h.body.fabric.status, "degraded"); assert.equal(h.body.fabric.detail, false);
    for (const x of ["fabric_invoice", "fabric_inventory", "FactSales", "FactInventory", "estimate", "latestDate", "requiredIndexes", "invoice_date", "Posting_Date", "2026-03-", "lastVerifiedAt", "reload"]) assert.ok(!h.text.includes(x), x);
  });

  test("System Health viewer who reads Fabric: the detail, without the admin extras", async () => {
    const h = await as("reader");
    assert.equal(h.body.scope, "viewer"); assert.equal(h.body.fabric.detail, true);
    assert.equal(h.body.fabric.datasets.sales.state, "index_missing");
    assert.deepEqual(h.body.fabric.datasets.sales.requiredIndexes[0].keys, { invoice_date: -1, Company: 1, invoice_id: 1, _id: 1 });
    assert.ok(!("background" in h.body.fabric) && !("servedBy" in h.body.fabric.datasets.sales.requiredIndexes[0]));
    assert.ok(!/fabric\.invalid|FabricTestDb|ALPHA|Example Customer/.test(h.text));
  });

  test("JARC administrator: general without Fabric read; detail + background with it; unlisted 403", async () => {
    const plainAdmin = await as("admin");
    assert.equal(plainAdmin.body.scope, "admin"); assert.equal(plainAdmin.body.fabric.detail, false);
    assert.ok(!plainAdmin.text.includes("fabric_invoice_date"));
    const readerAdmin = await as("adminReader");
    assert.equal(readerAdmin.body.fabric.detail, true); assert.equal(readerAdmin.body.fabric.background.everyMinutes, 5);
    assert.equal((await as("plain")).status, 403);
  });

  test("a health snapshot that throws: fabric unavailable, the rest of System Health still answers", async () => {
    const real = fab.health.snapshot;
    fab.health.snapshot = async () => { throw new Error("boom mongodb://secret.invalid"); };
    try {
      for (const k of ["viewer", "reader", "adminReader"]) {
        const h = await as(k);
        assert.equal(h.status, 200, k); assert.equal(h.body.fabric.status, "unavailable");
        assert.ok(h.body.server && h.body.database && h.body.api, "rest of the page");
        assert.ok(!h.text.includes("secret.invalid") && !h.text.includes("boom"));
      }
    } finally { fab.health.snapshot = real; }
  });

  test("/fabric/status is unchanged by index health (no index names leak into it, the same keys as before)", async () => {
    const st = await as("reader", "/api/v1/fabric/status");
    assert.equal(st.status, 200, `${st.text} ${app.logger.errors.join("\n")}`);
    assert.ok(!st.text.includes("indexNames") && !st.text.includes("lastVerifiedAt") && !st.text.includes("_id_"));
  });
});

const BROWSER = findBrowser();
describe("System Health → Fabric index health (headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let b, server, fab, base, signedIn = null;
  before(async () => {
    const port = await freePort(); base = `http://localhost:${port}`;
    const entra = { ...issuer.config, redirectUri: `${base}/`, appOrigin: base };
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => new FakeMongoClient() });
    await connection.connect(); await ensureDatabase(connection.db);
    const dataLayer = createDataLayer({ connection, logger: { error() {} }, fileStore: new MemoryFileStore(), environment: "test" });
    fab = stack({ fake: { indexes: ID_ONLY }, env: SCAN_1 });
    const app = createApp({ repository: new MemoryStateRepository(), environment: "test", logger: { error() {}, warn() {} }, dataLayer, fabricData: fab, auth: { mode: "entra", entra, verify: createEntraVerifier({ ...entra, keySet: issuer.keySet }) }, accessPolicy: "development_shared", betaOpenEditing: true, systemHealth: { viewerObjectIds: [people.viewer.oid] } });
    server = await new Promise((resolve) => { const s = app.listen(port, "127.0.0.1", () => resolve(s)); });
    server.app = app;
    fab.health.start(); // unref'd, 5 minutes; stopped by fab.close()
    b = await launch(BROWSER);
  });
  after(async () => { await b?.close(); server?.app.locals.realtime?.closeAll(); if (server) await new Promise((r) => server.close(r)); await fab?.close(); });
  const signIn = async (who) => {
    if (signedIn === who) return;
    await b.open(`${base}/api/v1/health`, { width: 1280, height: 900 });
    const nonce = await b.evaluate(`fetch("/api/v1/auth/sign-in/start", { method: "POST" }).then((r) => r.json()).then((s) => s.nonce)`);
    const idToken = await people[who].idToken(nonce);
    assert.equal(await b.evaluate(`fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: ${JSON.stringify(idToken)} }) }).then((r) => r.status)`), 201);
    signedIn = who;
  };
  const openHealth = async () => {
    await b.open(`${base}/`, { width: 1280, height: 900 });
    assert.ok(await b.waitFor("!!document.querySelector('.app-shell')", 20000), "app");
    await b.evaluate("(() => { const x = document.createElement('button'); x.dataset.action = 'nav'; x.dataset.screen = 'system-health'; document.querySelector('#app').appendChild(x); x.click(); x.remove(); })()");
    assert.ok(await b.waitFor("!!document.querySelector('.health-tiles')", 20000), "System Health overview");
  };
  const integrations = async () => { await b.evaluate("document.querySelector('[data-action=\"health-tab\"][data-tab=\"integrations\"]').click()"); assert.ok(await b.waitFor("!!document.querySelector('.health-fabric')", 10000), "Fabric card"); };

  test("JARC admin + Fabric reader: tile, per-dataset detail, missing index with keys and How to fix", async () => {
    await signIn("adminReader"); await openHealth();
    const tiles = await b.evaluate("document.querySelector('.health-tiles').textContent");
    assert.match(tiles, /Fabric indexes\s*Needs attention/);
    await integrations();
    const card = await b.evaluate("document.querySelector('.health-fabric').textContent");
    assert.match(card, /Sales[\s\S]*Waiting for an index/);
    assert.match(card, /fabric_invoice_date[\s\S]*invoice_date: -1, Company: 1, invoice_id: 1, _id: 1[\s\S]*Missing/);
    assert.match(card, /How to fix/);
    assert.match(card, /db\.FactSales\.createIndex\(\{"invoice_date": -1, "Company": 1, "invoice_id": 1, "_id": 1\}, \{ name: "fabric_invoice_date" \}\)/);
    assert.match(card, /Ask the data team to recreate these indexes after each refresh/);
    assert.match(card, /background check every 5 min/);
  });

  test("System Health viewer without Fabric read: the overall status only", async () => {
    await signIn("viewer"); await openHealth();
    assert.match(await b.evaluate("document.querySelector('.health-tiles').textContent"), /Fabric indexes\s*Needs attention\s*Details are for Fabric Data readers/);
    await integrations();
    const card = await b.evaluate("document.querySelector('.health-fabric').innerHTML");
    assert.ok(!/fabric_invoice|FactSales|createIndex|Documents|Latest date/.test(card), card);
    assert.match(card, /shown only to Fabric Data readers/);
  });
});
