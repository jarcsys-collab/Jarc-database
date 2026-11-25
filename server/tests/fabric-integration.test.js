// Fabric Data wired into the REAL app (createApp): session data routes, Fabric API tokens, /external/fabric and the existing
// board API side by side, with production-like access (development_shared + beta open editing), Entra sign-in, API tokens on
// (a random test key) and JARC API administrators (JARC_API_ADMIN_OIDS style). Nothing is composed around createApp here: every
// path goes through app.js exactly as it mounts them. The invoice views are on (FABRIC_INVOICE_VIEWS=true) for the session API,
// so this also shows that /external/fabric never has them. Offline: JARC on its fake MongoDB, local Entra test keys, Fabric on
// tests/support/fabric-fake.js. Synthetic data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createApp } = require("../src/app");
const { createFabricData, fabricLimiter } = require("../src/fabric");
const { loadConfig } = require("../src/config");
const { MemoryStateRepository } = require("../src/repositories/memory-state-repository");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase, COLLECTIONS } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { createEntraVerifier } = require("../src/auth/entra-token");
const { SessionClient, entraEnv } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FakeMongoClient } = require("./support/fake-mongo");
const { FabricFakeClient, row, inventoryRows, dec } = require("./support/fabric-fake");

const KEY = crypto.randomBytes(32);
const Q = "dateFrom=2026-03-01&dateTo=2026-03-31";
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();
const code = (res) => res.body?.error?.code;
const day = (d) => new Date(`2026-03-${String(d).padStart(2, "0")}T08:00:00Z`);
const docs = () => [
  row({ Company: "ALPHA", invoice_id: "1001", Line_No: 10000, invoice_date: day(10), customer_name: "Example Customer One", invoice_item_quantity: 2, invoice_item_amount: 10, Unit_Price: dec("5.00"), landed_cost: "2.5" }),
  row({ Company: "ALPHA", invoice_id: "1001", Line_No: 20000, invoice_date: day(10), customer_name: "Example Customer One", invoice_item_amount: 30 }),
  row({ Company: "BETA", invoice_id: "2002", invoice_date: day(12), customer_name: "Example Customer Two", invoice_item_amount: 7 })
];
const SALES = "fabric.sales.read", INVENTORY = "fabric.inventory.read", SENSITIVE = "fabric.sensitive.read";
const BOTH = ["sales", "inventory"];
const INV_SENSITIVE = "fields=Item_No,Cost_Amount_Actual";

let issuer, people;
const oids = (...ps) => ps.map((p) => p.oid).join(",");
// The production-like environment: readers, sensitive readers and Fabric API administrators (overrides change the lists).
const fabricEnv = (overrides = {}) => entraEnv({
  JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb", FABRIC_INVOICE_VIEWS: "true",
  FABRIC_DATA_READER_OIDS: oids(people.fabAdmin, people.fabAdminNoCost, people.reader, people.costReader),
  FABRIC_DATA_COST_READER_OIDS: oids(people.fabAdmin, people.costReader),
  FABRIC_API_ADMIN_OIDS: oids(people.fabAdmin, people.fabAdminNoCost),
  ...overrides
});
const flags = (read, sensitive, apiAdmin, apiTokens = true, apiOversight = false) => ({ read, sensitive, cost: sensitive, apiAdmin, apiOversight, canGrantSensitive: apiAdmin && sensitive, datasets: read ? BOTH : [], invoiceViews: read, apiTokens });

// The real app over a (shareable) fake JARC database, so an app can be rebuilt with new configuration over the same tokens.
async function boot({ fake = new FakeMongoClient(), env = fabricEnv(), apiTokens = true } = {}) {
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const logger = { errors: [], warnings: [], error(...a) { this.errors.push(a.map(String).join(" ")); }, warn(...a) { this.warnings.push(a.map(String).join(" ")); } };
  const dataLayer = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), environment: "test" });
  const verify = createEntraVerifier({ ...issuer.config, keySet: issuer.keySet });
  const config = loadConfig(env).fabricData;
  const fabricClient = new FabricFakeClient({ docs: docs(), inventory: { docs: inventoryRows(250) } });
  const stack = config.enabled ? createFabricData({ config, logger: { warn() {}, error() {} }, createClient: () => fabricClient }) : null;
  const app = createApp({
    repository: new MemoryStateRepository(), environment: "test", logger, dataLayer,
    auth: { mode: "entra", entra: issuer.config, verify },
    accessPolicy: "development_shared", betaOpenEditing: true,
    ...(apiTokens ? { apiTokens: { key: KEY, adminObjectIds: [people.boardAdmin.oid.toLowerCase()], issuePerHour: 1000, maxActive: 1000 } } : {}),
    fabricData: stack ? { config, service: stack.service, limiter: fabricLimiter({ perWindow: 10000 }) } : (config.enabled ? null : { config, service: null })
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  server.keepAliveTimeout = 30000; server.headersTimeout = 31000;
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = new Map();
  const browserOf = async (person) => {
    if (!clients.has(person.name)) { const c = new SessionClient(url, issuer.config.appOrigin); assert.equal((await c.signIn(person)).status, 201, `sign-in ${person.name}`); clients.set(person.name, c); }
    return clients.get(person.name);
  };
  const as = async (person, method, path, body, options) => (await browserOf(person)).request(method, path, body, options);
  const close = async () => { app.locals.realtime?.closeAll(); await new Promise((resolve) => server.close(resolve)); await stack?.close(); };
  return { url, app, fake, db: connection.db, logger, dataLayer, fabricClient, as, browserOf, close };
}

// An integration's request: no cookie, no CSRF token, no Origin.
async function call(env, token, path, { method = "GET", headers = {} } = {}) {
  const res = await fetch(`${env.url}/api/v1/external${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
  const text = await res.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, headers: res.headers, text };
}
const issueFabric = (env, person, { scopes = [SALES, INVENTORY], ...rest } = {}) => env.as(person, "POST", "/api/v1/fabric/api-tokens", { name: "Fabric BI", scopes, expiresAt: inDays(30), ...rest });
async function boardSetup(env) {
  const ws = await env.as(people.boardAdmin, "POST", "/api/v1/workspaces", { name: "Synthetic" });
  assert.equal(ws.status, 201, ws.text);
  const board = await env.as(people.boardAdmin, "POST", `/api/v1/workspaces/${ws.body.workspace.id}/boards`, { name: "Alpha", columns: [{ key: "serial", label: "Item", type: "text" }] });
  assert.equal(board.status, 201, board.text);
  const token = await env.as(people.boardAdmin, "POST", "/api/v1/me/api-tokens", { name: "Board BI", workspaceId: ws.body.workspace.id, boardIds: [board.body.board.id], scopes: ["read"], expiresAt: inDays(30) });
  assert.equal(token.status, 201, token.text);
  return { workspace: ws.body.workspace, board: board.body.board, token: token.body };
}

before(async () => {
  issuer = await createTokenIssuer();
  people = {
    fabAdmin: issuer.person("Fay FabricAdmin"), fabAdminNoCost: issuer.person("Nico FabricAdmin"),
    reader: issuer.person("Rhea Reader"), costReader: issuer.person("Cora CostReader"),
    boardAdmin: issuer.person("Jay BoardApiAdmin", { admin: true }), outsider: issuer.person("Olive Outsider")
  };
});

describe("Fabric Data on, API tokens on (development_shared + beta open editing)", () => {
  let env, board;
  before(async () => { env = await boot(); board = await boardSetup(env); });
  after(() => env.close());

  test("1. /features: fabricData flags per person", async () => {
    const f = async (p) => (await env.as(p, "GET", "/api/v1/features")).body.features;
    assert.deepEqual((await f(people.reader)).fabricData, flags(true, false, false));
    assert.deepEqual((await f(people.costReader)).fabricData, flags(true, true, false));
    assert.deepEqual((await f(people.fabAdmin)).fabricData, flags(true, true, true));
    assert.deepEqual((await f(people.fabAdminNoCost)).fabricData, flags(true, false, true));
    assert.deepEqual((await f(people.outsider)).fabricData, flags(false, false, false));
    const boardOnly = await f(people.boardAdmin);
    assert.deepEqual(boardOnly.fabricData, flags(false, false, false));
    assert.equal(boardOnly.apiTokenAdmin, true);
    assert.equal((await f(people.fabAdmin)).apiTokenAdmin, false, "a Fabric API administrator is not a JARC API administrator");
  });

  test("2. session data routes: readers 200, non-readers 403, no session 401, bearer 401, POST 405", async () => {
    const status = await env.as(people.reader, "GET", "/api/v1/fabric/status");
    assert.equal(status.status, 200, status.text);
    assert.equal(status.body.available, true);
    assert.deepEqual(status.body.access, { datasets: BOTH, sensitive: false });
    for (const path of ["/sales/records", "/inventory/records", `/invoices?${Q}`]) {
      const res = await env.as(people.reader, "GET", `/api/v1/fabric${path}`);
      assert.equal(res.status, 200, `${path} ${res.text}`);
    }
    assert.equal(code(await env.as(people.reader, "GET", `/api/v1/fabric/inventory/records?${INV_SENSITIVE}`)), "VALIDATION_ERROR");
    assert.equal((await env.as(people.costReader, "GET", `/api/v1/fabric/inventory/records?${INV_SENSITIVE}`)).status, 200);
    assert.ok((await env.as(people.costReader, "GET", `/api/v1/fabric/invoices?${Q}`)).body.items.some((i) => i.cost));
    for (const p of [people.outsider, people.boardAdmin]) for (const path of ["/status", "/sales/records", "/inventory/schema", `/invoices?${Q}`]) {
      const res = await env.as(p, "GET", `/api/v1/fabric${path}`);
      assert.deepEqual([res.status, code(res)], [403, "FABRIC_DATA_FORBIDDEN"], `${p.name} ${path}`);
    }
    const anonymous = new SessionClient(env.url, issuer.config.appOrigin);
    assert.equal((await anonymous.request("GET", "/api/v1/fabric/status")).status, 401);
    assert.equal((await anonymous.request("GET", "/api/v1/fabric/inventory/records")).status, 401);
    const bearer = await env.as(people.reader, "GET", "/api/v1/fabric/status", undefined, { headers: { Authorization: `Bearer ${board.token.secret}` } });
    assert.deepEqual([bearer.status, code(bearer)], [401, "UNAUTHENTICATED"]);
    const post = await env.as(people.reader, "POST", "/api/v1/fabric/sales/records", {});
    assert.deepEqual([post.status, code(post)], [405, "METHOD_NOT_ALLOWED"]);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  });

  test("3. a Fabric API administrator issues a token (secret once) and it reads /external/fabric; sensitive fields only with fabric.sensitive.read AND a sensitive-reading owner", async () => {
    const noCsrf = await (await env.browserOf(people.fabAdmin)).request("POST", "/api/v1/fabric/api-tokens", { name: "x", scopes: [SALES], expiresAt: inDays(5) }, { csrf: null });
    assert.deepEqual([noCsrf.status, code(noCsrf)], [403, "CSRF_INVALID"]);
    const plain = await issueFabric(env, people.fabAdmin);
    assert.equal(plain.status, 201, plain.text);
    assert.match(plain.body.secret, /^jarc_/);
    const listed = await env.as(people.fabAdmin, "GET", "/api/v1/fabric/api-tokens");
    assert.equal(listed.status, 200);
    assert.ok(listed.body.tokens.some((t) => t.id === plain.body.token.id));
    assert.ok(!listed.text.includes(plain.body.secret), "the secret is shown only once");

    const s = await call(env, plain.body.secret, "/fabric/status");
    assert.equal(s.status, 200, s.text);
    assert.equal(s.body.available, true);
    assert.deepEqual(s.body.access, { datasets: BOTH, sensitive: false });
    assert.ok(s.headers.get("x-ratelimit-limit"));
    for (const path of ["/fabric/sales/records", "/fabric/inventory/records", "/fabric/inventory/schema"]) {
      const res = await call(env, plain.body.secret, path);
      assert.equal(res.status, 200, `${path} ${res.text}`);
      assert.equal(res.text.includes("landed_cost") || res.text.includes("Cost_Amount"), false, path);
    }
    assert.equal(code(await call(env, plain.body.secret, `/fabric/inventory/records?${INV_SENSITIVE}`)), "VALIDATION_ERROR");

    const costly = await issueFabric(env, people.fabAdmin, { scopes: [SALES, INVENTORY, SENSITIVE] });
    assert.equal(costly.status, 201, costly.text);
    const ci = await call(env, costly.body.secret, `/fabric/inventory/records?${INV_SENSITIVE}`);
    assert.equal(ci.status, 200, ci.text);
    assert.ok(ci.body.items.every((i) => "Cost_Amount_Actual" in i.values));
    const detail = await call(env, costly.body.secret, `/fabric/inventory/records/${ci.body.items[0].id}`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.record.fields.length, 87);

    // An administrator who can't read sensitive fields can't grant them.
    const refused = await issueFabric(env, people.fabAdminNoCost, { scopes: [SALES, SENSITIVE] });
    assert.deepEqual([refused.status, code(refused)], [403, "FABRIC_SENSITIVE_ACCESS_REQUIRED"]);
    // Readers who aren't Fabric API administrators, and the JARC API administrator, may not.
    for (const p of [people.reader, people.costReader, people.boardAdmin, people.outsider]) {
      const res = await issueFabric(env, p);
      assert.deepEqual([res.status, code(res)], [403, "FABRIC_API_ADMIN_REQUIRED"], p.name);
      const list = await env.as(p, "GET", "/api/v1/fabric/api-tokens");
      assert.deepEqual([list.status, code(list)], [403, "FABRIC_API_ADMIN_REQUIRED"], p.name);
    }
  });

  test("3b. dataset scopes: a sales-only token reads sales, gets 403 INSUFFICIENT_SCOPE on inventory; never the invoice views", async () => {
    const salesOnly = (await issueFabric(env, people.fabAdmin, { scopes: [SALES] })).body;
    assert.ok(salesOnly.secret, "issued");
    assert.equal((await call(env, salesOnly.secret, "/fabric/sales/records")).status, 200);
    assert.equal((await call(env, salesOnly.secret, "/fabric/sales/schema")).status, 200);
    for (const path of ["/fabric/inventory/records", "/fabric/inventory/schema", "/fabric/inventory/records/0123456789abcdef01234567"]) {
      const res = await call(env, salesOnly.secret, path);
      assert.deepEqual([res.status, code(res)], [403, "INSUFFICIENT_SCOPE"], path);
    }
    assert.deepEqual(Object.keys((await call(env, salesOnly.secret, "/fabric/status")).body.datasets), ["sales"]);
    const inventoryOnly = (await issueFabric(env, people.fabAdmin, { scopes: [INVENTORY] })).body;
    assert.equal((await call(env, inventoryOnly.secret, "/fabric/inventory/records")).status, 200);
    assert.equal(code(await call(env, inventoryOnly.secret, "/fabric/sales/records")), "INSUFFICIENT_SCOPE");
    // FABRIC_INVOICE_VIEWS is on for the session API here, and still nothing under /external/fabric.
    for (const path of [`/fabric/invoices?${Q}`, "/fabric/invoices/ALPHA/1001", "/fabric/invoices/ALPHA/1001/lines", "/fabric/sales-lines"]) {
      const res = await call(env, salesOnly.secret, path);
      assert.deepEqual([res.status, code(res)], [404, "NOT_FOUND"], path);
    }
    assert.equal((await env.as(people.reader, "GET", `/api/v1/fabric/invoices?${Q}`)).status, 200, "session invoice views on");
    // Unknown datasets: one 404 for every name.
    for (const name of ["EmployeeData", "FactSales", "Inventory"]) assert.deepEqual([(await call(env, salesOnly.secret, `/fabric/${name}/records`)).status], [404], name);
  });

  test("4. isolation both ways: board tokens and Fabric tokens never cross, and the lists stay separate", async () => {
    for (const path of ["/fabric/status", "/fabric/sales/records", "/fabric/inventory/records", `/fabric/invoices?${Q}`]) {
      const res = await call(env, board.token.secret, path);
      assert.deepEqual([res.status, code(res)], [403, "INSUFFICIENT_SCOPE"], path);
    }
    assert.equal((await call(env, board.token.secret, "/me")).status, 200, "the board token still reads the board API");
    assert.equal((await call(env, board.token.secret, `/boards/${board.board.id}`)).status, 200);

    const fabric = (await issueFabric(env, people.fabAdmin)).body;
    for (const path of ["/me", "/workspaces", `/boards/${board.board.id}`, `/workspaces/${board.workspace.id}/boards`, `/boards/${board.board.id}/records`]) {
      const res = await call(env, fabric.secret, path);
      assert.deepEqual([res.status, code(res)], [403, "INSUFFICIENT_SCOPE"], path);
    }

    const fabricIds = new Set((await env.db.collection(COLLECTIONS.apiTokens).find({ product: "fabric" }).toArray()).map((d) => d._id.toHexString()));
    assert.ok(fabricIds.has(fabric.token.id));
    const list = await env.as(people.boardAdmin, "GET", "/api/v1/me/api-tokens");
    assert.equal(list.status, 200, list.text);
    assert.ok(list.body.items.every((t) => !fabricIds.has(t.id)), "the board list shows no Fabric token");
    const activity = await env.as(people.boardAdmin, "GET", "/api/v1/me/api-tokens/activity");
    assert.equal(activity.status, 200);
    assert.ok(activity.body.items.length >= 1 && activity.body.items.every((e) => !e.token || !fabricIds.has(e.token.id)));
    const fabAdminBoard = await env.as(people.fabAdmin, "GET", "/api/v1/me/api-tokens");
    assert.deepEqual([fabAdminBoard.status, code(fabAdminBoard)], [403, "API_ADMIN_REQUIRED"]);
    assert.ok((await env.as(people.boardAdmin, "GET", "/api/v1/me/api-tokens")).body.items.some((t) => t.id === board.token.token.id));
    const fabricList = await env.as(people.fabAdmin, "GET", "/api/v1/fabric/api-tokens");
    assert.ok(fabricList.body.tokens.length >= 1 && fabricList.body.tokens.every((t) => fabricIds.has(t.id)));
    const fabricActivity = await env.as(people.fabAdmin, "GET", "/api/v1/fabric/api-tokens/activity");
    assert.equal(fabricActivity.status, 200);
    assert.ok(fabricActivity.body.items.every((e) => !e.token || e.token.id !== board.token.token.id));
    assert.equal((await env.as(people.boardAdmin, "POST", `/api/v1/me/api-tokens/${fabric.token.id}/revoke`)).status, 404);
    assert.equal((await env.as(people.fabAdmin, "POST", `/api/v1/fabric/api-tokens/${board.token.token.id}/revoke`)).status, 404);
    assert.equal((await call(env, board.token.secret, "/me")).status, 200);
  });

  test("5a. a revoked Fabric token is 401 TOKEN_REVOKED on its next use; another administrator (no oversight) can't revoke it", async () => {
    const made = (await issueFabric(env, people.fabAdminNoCost)).body;
    assert.equal((await call(env, made.secret, "/fabric/status")).status, 200);
    const other = await env.as(people.fabAdmin, "POST", `/api/v1/fabric/api-tokens/${made.token.id}/revoke`);
    assert.deepEqual([other.status, code(other)], [404, "NOT_FOUND"], "FABRIC_API_OVERSIGHT_OIDS is unset here: nobody manages other people's tokens");
    assert.equal((await call(env, made.secret, "/fabric/status")).status, 200);
    const revoke = await env.as(people.fabAdminNoCost, "POST", `/api/v1/fabric/api-tokens/${made.token.id}/revoke`);
    assert.equal(revoke.status, 200, revoke.text);
    const res = await call(env, made.secret, "/fabric/status");
    assert.deepEqual([res.status, code(res)], [401, "TOKEN_REVOKED"]);
  });

  test("6. /external/fabric: POST 405, token in the query 400, unknown paths a JSON 404 of its own", async () => {
    const made = (await issueFabric(env, people.fabAdmin)).body;
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await call(env, made.secret, "/fabric/sales/records", { method });
      assert.deepEqual([res.status, code(res)], [405, "METHOD_NOT_ALLOWED"], method);
    }
    const q = await call(env, made.secret, `/fabric/status?token=${made.secret}`);
    assert.deepEqual([q.status, code(q)], [400, "TOKEN_IN_QUERY"]);
    for (const path of ["/fabric/x", "/fabric/me", "/fabric/workspaces", `/fabric/boards/${board.board.id}`]) {
      const res = await call(env, made.secret, path);
      assert.equal(res.status, 404, path);
      assert.match(res.headers.get("content-type"), /application\/json/);
      assert.equal(code(res), "NOT_FOUND", path);
    }
    assert.equal(code(await call(env, board.token.secret, "/fabric/x")), "INSUFFICIENT_SCOPE");
    assert.equal((await call(env, null, "/fabric/x")).status, 401);
  });

  test("8a. HTML: the Fabric pages serve the page with root-relative assets (invoice pages only with the invoice views)", async () => {
    for (const path of ["/fabric/inventory", "/fabric/sales", "/fabric/api", "/fabric/sales/records/0123456789abcdef01234567", "/fabric/invoices", "/fabric/invoices/A/1"]) {
      const res = await fetch(env.url + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type"), /text\/html/);
      const html = await res.text();
      assert.doesNotMatch(html, /(?:href|src)="assets\//, path);
      assert.match(html, /(?:href|src)="\/assets\//, path);
    }
  });

  test("nothing about a token or Fabric data reaches the logs", () => {
    const all = env.logger.errors.concat(env.logger.warnings).join(" ");
    assert.ok(!all.includes("jarc_"));
    assert.ok(!all.includes("Example Customer"));
    assert.ok(!all.includes("Synthetic item"));
  });
});

describe("Rebuilt with new configuration over the same tokens", () => {
  test("5b. owner removed from readers → 403 TOKEN_ACCESS_REVOKED; owner lost sensitive access → sensitive fields drop", async () => {
    const first = await boot();
    let made, costly;
    try {
      made = (await issueFabric(first, people.fabAdmin)).body;
      costly = (await issueFabric(first, people.fabAdmin, { scopes: [SALES, INVENTORY, SENSITIVE] })).body;
      assert.equal((await call(first, made.secret, "/fabric/status")).status, 200);
      assert.equal((await call(first, costly.secret, `/fabric/inventory/records?${INV_SENSITIVE}`)).status, 200);
    } finally { await first.close(); }

    // Still a reader, no longer a sensitive reader (admins must be readers, so drop admin too only in the next step).
    const noCost = await boot({ fake: first.fake, env: fabricEnv({ FABRIC_DATA_COST_READER_OIDS: oids(people.costReader) }) });
    try {
      const res = await call(noCost, costly.secret, `/fabric/inventory/records?${INV_SENSITIVE}`);
      assert.deepEqual([res.status, code(res)], [400, "VALIDATION_ERROR"], "a fabric.sensitive.read token whose owner lost the permission can't name sensitive fields");
      const plain = await call(noCost, costly.secret, "/fabric/inventory/records");
      assert.equal(plain.status, 200, plain.text);
      assert.deepEqual((await call(noCost, costly.secret, "/fabric/status")).body.access, { datasets: BOTH, sensitive: false });
    } finally { await noCost.close(); }

    const removed = await boot({ fake: first.fake, env: fabricEnv({ FABRIC_DATA_READER_OIDS: oids(people.fabAdminNoCost, people.reader, people.costReader), FABRIC_DATA_COST_READER_OIDS: oids(people.costReader), FABRIC_API_ADMIN_OIDS: oids(people.fabAdminNoCost) }) });
    try {
      for (const secret of [made.secret, costly.secret]) {
        const res = await call(removed, secret, "/fabric/status");
        assert.deepEqual([res.status, code(res)], [403, "TOKEN_ACCESS_REVOKED"]);
      }
      assert.deepEqual((await removed.as(people.fabAdmin, "GET", "/api/v1/features")).body.features.fabricData, flags(false, false, false));
    } finally { await removed.close(); }
  });

  test("6b. the configured Fabric rate (FABRIC_API_RATE_PER_MINUTE) limits each token: 429 with X-RateLimit headers", async () => {
    const env = await boot({ env: fabricEnv({ FABRIC_API_RATE_PER_MINUTE: "3" }) });
    try {
      const a = (await issueFabric(env, people.fabAdmin)).body, b = (await issueFabric(env, people.fabAdmin)).body;
      for (let i = 0; i < 3; i += 1) {
        const res = await call(env, a.secret, "/fabric/status");
        assert.equal(res.status, 200, res.text);
        assert.equal(res.headers.get("x-ratelimit-limit"), "3");
        assert.equal(res.headers.get("x-ratelimit-remaining"), String(2 - i));
        assert.ok(res.headers.get("x-ratelimit-reset"));
      }
      const limited = await call(env, a.secret, "/fabric/status");
      assert.deepEqual([limited.status, code(limited)], [429, "RATE_LIMITED"]);
      assert.equal(limited.headers.get("x-ratelimit-limit"), "3");
      assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
      assert.equal((await call(env, b.secret, "/fabric/status")).status, 200, "another token isn't affected");
    } finally { await env.close(); }
  });

  test("7 + 8b. switched off: /api/v1/fabric/* and /external/fabric/* answer like unknown paths, /features has no fabricData, no HTML; the board API is unchanged", async () => {
    const on = await boot();
    let fabric, board;
    try {
      board = await boardSetup(on);
      fabric = (await issueFabric(on, people.fabAdmin)).body;
    } finally { await on.close(); }
    const off = await boot({ fake: on.fake, env: entraEnv() });
    try {
      const unknownSession = await off.as(people.fabAdmin, "GET", "/api/v1/zz-unknown");
      assert.deepEqual([unknownSession.status, code(unknownSession)], [404, "NOT_FOUND"]);
      for (const [method, path] of [["GET", "/api/v1/fabric/status"], ["GET", "/api/v1/fabric/inventory/records"], ["GET", `/api/v1/fabric/invoices?${Q}`], ["GET", "/api/v1/fabric/api-tokens"], ["POST", "/api/v1/fabric/api-tokens"]]) {
        const res = await off.as(people.fabAdmin, method, path, method === "POST" ? { name: "x", scopes: [SALES], expiresAt: inDays(5) } : undefined);
        assert.deepEqual([res.status, code(res)], [unknownSession.status, code(unknownSession)], `${method} ${path}`);
      }
      const features = (await off.as(people.fabAdmin, "GET", "/api/v1/features")).body.features;
      assert.equal("fabricData" in features, false);
      assert.equal(features.apiTokens, true);

      for (const secret of [fabric.secret, board.token.secret]) {
        const unknown = await call(off, secret, "/zz-unknown");
        const res = await call(off, secret, "/fabric/status");
        assert.deepEqual([res.status, code(res)], [unknown.status, code(unknown)]);
      }
      assert.equal(code(await call(off, fabric.secret, "/me")), "INSUFFICIENT_SCOPE");
      assert.equal((await call(off, board.token.secret, "/me")).status, 200);
      assert.equal((await call(off, board.token.secret, `/boards/${board.board.id}`)).status, 200);
      const boardList = await off.as(people.boardAdmin, "GET", "/api/v1/me/api-tokens");
      assert.equal(boardList.status, 200);
      assert.ok(boardList.body.items.some((t) => t.id === board.token.token.id));
      assert.ok(boardList.body.items.every((t) => t.id !== fabric.token.id));

      for (const path of ["/fabric/inventory", "/fabric/sales", "/fabric/invoices", "/fabric/invoices/A/1"]) assert.equal((await fetch(off.url + path)).status, 404, path);
    } finally { await off.close(); }
  });

  test("API tokens off, Fabric on: no Fabric token routes, /external answers like any unknown path, session reads still work", async () => {
    const env = await boot({ apiTokens: false });
    try {
      const features = (await env.as(people.fabAdmin, "GET", "/api/v1/features")).body.features;
      assert.deepEqual(features.fabricData, flags(true, true, true, false));
      assert.equal((await env.as(people.fabAdmin, "GET", "/api/v1/fabric/status")).status, 200);
      const tokens = await env.as(people.fabAdmin, "GET", "/api/v1/fabric/api-tokens");
      assert.deepEqual([tokens.status, code(tokens)], [404, "NOT_FOUND"], "no Fabric token routes without API tokens");
      const unknown = await call(env, "jarc_x", "/zz-unknown");
      const ext = await call(env, "jarc_x", "/fabric/status");
      assert.deepEqual([ext.status, code(ext)], [unknown.status, code(unknown)]);
    } finally { await env.close(); }
  });
});
