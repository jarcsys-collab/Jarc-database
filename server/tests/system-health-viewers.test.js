// System Health viewers (SYSTEM_HEALTH_VIEWER_OIDS): listed people may VIEW a redacted System Health; JARC administrators keep
// the full view and Activity History. Real app on the in-memory FakeMongoClient, local Entra test keys. Synthetic people and
// invented GUIDs only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SessionClient, startApp, entraEnv } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FakeMongoClient } = require("./support/fake-mongo");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { createEntraVerifier } = require("../src/auth/entra-token");
const { Monitor } = require("../src/monitoring/monitor");
const { viewerView, isSystemHealthViewer } = require("../src/routes/system-health");
const { loadConfig, ConfigError } = require("../src/config");

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const OBJECTID_RE = /(^|[^0-9a-f])[0-9a-f]{24}([^0-9a-f]|$)/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// The exact keys of the viewer view (the allow-list).
const VIEWER_SHAPE = {
  "": ["scope", "generatedAt", "server", "database", "api", "slowestEndpoints", "failingEndpoints", "endpoints", "trend", "errors", "integrations", "jobs"],
  server: ["status", "version", "uptimeSeconds", "memoryMb", "monitoringSince"],
  database: ["status", "pingMs", "commands", "failed", "slow", "slowThresholdMs"],
  api: ["requests", "serverErrors", "clientErrors", "errorRate", "statuses", "samples", "avgMs", "p50Ms", "p95Ms", "p99Ms", "maxMs"],
  errors: ["recent", "byStatus", "byCode"],
  integrations: ["monday", "googleDrive"],
  jobs: ["integration", "imports", "searchIndex", "recentFailures"]
};
const ENDPOINT_KEYS = ["route", "count", "serverErrors", "clientErrors", "errorRate", "samples", "avgMs", "p50Ms", "p95Ms", "p99Ms", "maxMs", "lastAt"];
const assertShape = (body) => {
  for (const [path, keys] of Object.entries(VIEWER_SHAPE)) assert.deepEqual(Object.keys(path ? body[path] : body).sort(), [...keys].sort(), path || "top level");
  for (const e of [...body.endpoints, ...body.slowestEndpoints, ...body.failingEndpoints]) assert.deepEqual(Object.keys(e).sort(), [...ENDPOINT_KEYS].sort());
};
const assertClean = (text, extra = []) => {
  assert.ok(!/mongodb(\+srv)?:\/\//i.test(text), "a connection string");
  assert.ok(!GUID_RE.test(text), "a GUID");
  assert.ok(!OBJECTID_RE.test(text), "an ObjectId");
  assert.ok(!EMAIL_RE.test(text), "an email");
  assert.ok(!/\bat .+:\d+:\d+\)?/.test(text) && !/Error:/.test(text), "a stack or raw error");
  assert.ok(!/"environment"|"node"|requestId|"production"|"test"/.test(text), "environment details");
  for (const x of extra) assert.ok(!text.includes(x), x);
};

describe("System Health viewers (real app)", () => {
  let issuer, P, app, monitor;
  const clients = new Map();
  const as = async (k, method, path, opts, body) => {
    if (k === "signedOut") return new SessionClient(app.url, issuer.config.appOrigin).request(method, path, body, opts);
    if (!clients.has(k)) { const c = new SessionClient(app.url, issuer.config.appOrigin); assert.equal((await c.signIn(P[k])).status, 201); clients.set(k, c); }
    return clients.get(k).request(method, path, body, opts);
  };

  before(async () => {
    issuer = await createTokenIssuer();
    P = {
      owner: issuer.person("Synthetic Owner", { admin: true }),
      v1: issuer.person("Synthetic Viewer One"), v2: issuer.person("Synthetic Viewer Two"), v3: issuer.person("Synthetic Viewer Three"), v4: issuer.person("Synthetic Viewer Four"),
      plain: issuer.person("Synthetic Plain"), wsAdmin: issuer.person("Synthetic Workspace Admin")
    };
    const fake = new FakeMongoClient();
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
    await connection.connect();
    await ensureDatabase(connection.db);
    const logger = { errors: [], error() {}, warn() {}, info() {} };
    const dataLayer = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), environment: "test" });
    monitor = new Monitor({ slowCommandMs: 10 });
    // Monitoring entries carrying things a viewer must never see.
    monitor.recordRequest({ method: "GET", route: "/api/v1/boards/:boardId", status: 500, ms: 12, code: "INTERNAL_ERROR", requestId: "req-synthetic-123" });
    monitor.recordRequest({ method: "GET", route: "/api/v1/boards/:boardId", status: 403, ms: 3, code: "FORBIDDEN", requestId: "req-synthetic-456" });
    monitor.recordCommand({ command: "find", collection: "secretCollectionName", ms: 50 });
    monitor.recordIntegration("monday", { outcome: "failed", code: "UPSTREAM_DOWN", status: 502, note: "synthetic note" });
    monitor.recordJobFailure({ kind: "import", code: "BAD_FILE" });
    app = await startApp({
      dataLayer, logger, monitor, accessPolicy: "development_shared", betaOpenEditing: true,
      auth: { mode: "entra", entra: issuer.config, verify: createEntraVerifier({ ...issuer.config, keySet: issuer.keySet }) },
      apiTokens: { key: Buffer.alloc(32, 4), adminObjectIds: [] },
      systemHealth: { viewerObjectIds: [P.owner.oid, P.v1.oid, P.v2.oid, P.v3.oid, P.v4.oid] }
    });
    // The workspace admin holds a real membership (shared access gives everyone Workspace admin anyway).
    const ws = await as("wsAdmin", "POST", "/api/v1/workspaces", undefined, { name: "Synthetic WS" });
    assert.equal(ws.status, 201);
  });
  after(async () => { await app?.close(); });

  test("owner (JARC.Admin and listed): the full view, scope admin, and Activity History", async () => {
    const h = await as("owner", "GET", "/api/v1/admin/system-health");
    assert.equal(h.status, 200);
    assert.equal(h.body.scope, "admin");
    assert.ok(Array.isArray(h.body.recentErrors) && h.body.server.environment === "test", "the admin view is unchanged");
    assert.equal((await as("owner", "GET", "/api/v1/admin/activity")).status, 200);
    assert.deepEqual((await as("owner", "GET", "/api/v1/features")).body.features.systemHealth, { view: true, admin: true, activity: true });
  });

  test("each of the four listed viewers: the redacted view (allow-list keys only, nothing sensitive); Activity History 403", async () => {
    for (const k of ["v1", "v2", "v3", "v4"]) {
      const h = await as(k, "GET", "/api/v1/admin/system-health");
      assert.equal(h.status, 200, k);
      assert.equal(h.body.scope, "viewer");
      assertShape(h.body);
      assertClean(h.text, ["req-synthetic", "secretCollectionName", "synthetic note", P.owner.oid, P[k].oid, "fake.invalid"]);
      assert.equal(h.body.errors.byStatus["500"], 1);
      assert.equal(h.body.errors.byCode.INTERNAL_ERROR, 1);
      assert.equal(h.body.database.slow, 1);
      assert.equal(h.body.integrations.monday.activity.lastErrorCode, "UPSTREAM_DOWN");
      assert.equal(h.body.jobs.recentFailures.byKind.import, 1);
      const a = await as(k, "GET", "/api/v1/admin/activity");
      assert.equal(a.status, 403, `${k} activity`);
      assert.deepEqual((await as(k, "GET", "/api/v1/features")).body.features.systemHealth, { view: true, admin: false, activity: false });
    }
  });

  test("an unlisted registered user and an unlisted workspace admin (shared access): 403 on both, no /features key", async () => {
    for (const k of ["plain", "wsAdmin"]) {
      assert.equal((await as(k, "GET", "/api/v1/admin/system-health")).status, 403, k);
      assert.equal((await as(k, "GET", "/api/v1/admin/activity")).status, 403, k);
      assert.ok(!Object.hasOwn((await as(k, "GET", "/api/v1/features")).body.features, "systemHealth"));
    }
  });

  test("signed out and a bearer token without a session: 401; query parameters 400; read-only (no write methods)", async () => {
    assert.equal((await as("signedOut", "GET", "/api/v1/admin/system-health")).status, 401);
    assert.equal((await as("signedOut", "GET", "/api/v1/admin/system-health", { headers: { Authorization: "Bearer jarc_synthetic" } })).status, 401);
    assert.equal((await as("signedOut", "GET", "/api/v1/admin/activity", { headers: { Authorization: "Bearer jarc_synthetic" } })).status, 401);
    assert.equal((await as("v1", "GET", "/api/v1/admin/system-health?x=1")).status, 400);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await as("v1", m, "/api/v1/admin/system-health")).status, 404, m);
  });
});

describe("viewerView (unit)", () => {
  test("built field by field: secrets planted in every admin field never reach the viewer", () => {
    const secret = "mongodb+srv://user:pass@cluster0.example.invalid/db person@example.invalid 00000000-0000-4000-8000-00000000c0de 0123456789abcdef01234567 Error: boom\n    at x (/app/x.js:1:2)";
    const full = {
      scope: "admin", generatedAt: "2026-11-26T00:00:00.000Z",
      server: { status: "ok", environment: secret, version: "1.2.3", uptimeSeconds: 10, node: secret, memoryMb: { rss: 1, heapUsed: 2, extra: secret }, monitoringSince: secret, extra: secret },
      database: { status: "connected", pingMs: 3, commands: 4, failed: 0, slow: 1, slowThresholdMs: 500, slowCommands: [{ collection: secret }], uri: secret },
      api: { requests: 1, serverErrors: 0, clientErrors: 0, errorRate: 0, statuses: { 200: 1, [secret]: 2 }, samples: 1, avgMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1, maxMs: 1, extra: secret },
      slowestEndpoints: [{ route: "GET /x", count: 1, extra: secret, lastAt: secret }], failingEndpoints: [], endpoints: [],
      trend: [{ at: secret, requests: 1, errors: 0, avgMs: 1, extra: secret }],
      recentErrors: [{ requestId: secret, route: secret, status: 500, code: secret }],
      integrations: {
        monday: { enabled: true, configured: true, connected: true, state: "connected", account: secret, sync: { enabled: true, paused: false, lastSyncAt: null, lastError: secret }, importedBoards: 2, failedJobs: [{ id: secret, error: secret }], recentImports: [{ id: secret }], activity: { ok: 1, failed: 1, lastError: { code: secret, status: 500 }, history: [{ note: secret }] } },
        googleDrive: { enabled: true, connected: false, state: "needs_reconnect", activeForNewUploads: false, canManage: true, lastError: secret, lastErrorAt: secret, activity: null }
      },
      jobs: { integration: { monday: { queued: 1, running: 0, retry: 0, failed: 0, extra: secret } }, imports: { active: 1, failed: 0, recent: [{ id: secret }] }, midAttachments: [{ runId: secret, lastError: secret }], searchIndex: { mode: "on", ready: true }, recentFailures: [{ kind: secret, code: secret }] }
    };
    const v = viewerView(full);
    assertShape(v);
    const text = JSON.stringify(v);
    assert.ok(!text.includes("example.invalid") && !text.includes("boom") && !text.includes("c0de") && !text.includes("0123456789abcdef"), text);
    assertClean(text);
    assert.equal(v.integrations.googleDrive.hasError, true);
    assert.equal(v.integrations.monday.failedJobs, 1);
  });

  test("isSystemHealthViewer: entra session actors in this tenant only; empty list = nobody", () => {
    const T = "00000000-0000-4000-8000-00000000a001", O = "00000000-0000-4000-8000-0000000000a1";
    assert.equal(isSystemHealthViewer({ kind: "entra", tenantId: T, entraObjectId: O.toUpperCase() }, [O], T), true);
    assert.equal(isSystemHealthViewer({ kind: "entra", tenantId: "00000000-0000-4000-8000-00000000b002", entraObjectId: O }, [O], T), false);
    assert.equal(isSystemHealthViewer({ kind: "development", tenantId: T, entraObjectId: O }, [O], T), false);
    assert.equal(isSystemHealthViewer({ kind: "entra", tenantId: T, entraObjectId: O }, [], T), false);
    assert.equal(isSystemHealthViewer({ kind: "entra", tenantId: T, entraObjectId: O }, [O], null), false);
  });
});

describe("SYSTEM_HEALTH_VIEWER_OIDS configuration", () => {
  const A = "00000000-0000-4000-8000-0000000000a1", B = "00000000-0000-4000-8000-0000000000b2";
  test("its own list: GUIDs, lower-cased, at most 20, empty = nobody; other lists are neither read nor implied", () => {
    assert.deepEqual(loadConfig(entraEnv()).systemHealth.viewerObjectIds, []);
    assert.deepEqual(loadConfig(entraEnv({ SYSTEM_HEALTH_VIEWER_OIDS: `${A.toUpperCase()}, ${B}` })).systemHealth.viewerObjectIds, [A, B]);
    assert.throws(() => loadConfig(entraEnv({ SYSTEM_HEALTH_VIEWER_OIDS: "not-a-guid" })), (e) => e instanceof ConfigError && /SYSTEM_HEALTH_VIEWER_OIDS/.test(e.message));
    const many = Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",");
    assert.throws(() => loadConfig(entraEnv({ SYSTEM_HEALTH_VIEWER_OIDS: many })), (e) => e instanceof ConfigError && /at most 20/.test(e.message));
    const other = loadConfig(entraEnv({ JARC_API_ADMIN_OIDS: A, EMPLOYEE_VIEWER_OIDS: A, FABRIC_DATA_READER_OIDS: A, GOOGLE_DRIVE_ADMIN_OIDS: A }));
    assert.deepEqual(other.systemHealth.viewerObjectIds, [], "no other feature's list is read into it");
    const mine = loadConfig(entraEnv({ SYSTEM_HEALTH_VIEWER_OIDS: A }));
    assert.deepEqual(mine.employees.viewerObjectIds, []);
    assert.deepEqual(mine.employees.adminObjectIds, []);
    assert.deepEqual(mine.fabricData.readerObjectIds || [], []);
  });
});
