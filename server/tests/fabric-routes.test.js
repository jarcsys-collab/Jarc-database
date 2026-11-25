// Fabric Data over HTTP: who may call it (only FABRIC_DATA_READER_OIDS, whatever open access or JARC.Admin say), read-only
// methods, sensitive-field visibility, the dataset routes, the invoice views switch, /features, deep links, the switch, failures
// that leave JARC healthy, and what reaches the log.
// Offline: JARC on its fake MongoDB, local Entra test keys, Fabric on tests/support/fabric-fake.js. Synthetic data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const { createFabricData, fabricDataRouter, fabricLimiter } = require("../src/fabric");
const { loadConfig } = require("../src/config");
const { loggedUrl } = require("../src/middleware/errors");
const { createApp } = require("../src/app");
const { SessionClient, entraEnv } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FabricFakeClient, row, inventoryRows, startFabricApp, DEFAULT_INDEXES, dec } = require("./support/fabric-fake");

const day = (d) => new Date(`2026-03-${String(d).padStart(2, "0")}T08:00:00Z`);
const docs = () => [
  row({ Company: "ALPHA", invoice_id: "1001", Line_No: 10000, invoice_date: day(10), customer_name: "Example Customer One", invoice_item_quantity: 2, invoice_item_amount: 10, Unit_Price: dec("5.00"), landed_cost: "2.5", "Custom.2": "Territory North", upstream_new_field: "never returned" }),
  row({ Company: "ALPHA", invoice_id: "1001", Line_No: null, invoice_date: day(10), customer_name: "Example Customer One", invoice_item_amount: 30 }),
  row({ Company: null, invoice_id: "A/2002", invoice_date: day(12), customer_name: "Example Customer Two", invoice_item_amount: 7 })
];
const Q = "dateFrom=2026-03-01&dateTo=2026-03-31";
const fabricEnv = (people, overrides = {}) => entraEnv({ JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb", FABRIC_DATA_READER_OIDS: [people.reader, people.cost, people.admin].map((p) => p.oid).join(","), FABRIC_DATA_COST_READER_OIDS: people.cost.oid, FABRIC_API_ADMIN_OIDS: people.admin.oid, ...overrides });
const generous = () => fabricLimiter({ perWindow: 10000 });
const DATASETS = ["sales", "inventory"];

let issuer, people;
before(async () => {
  issuer = await createTokenIssuer();
  people = { reader: issuer.person("Fabric Reader"), cost: issuer.person("Cost Reader"), admin: issuer.person("Fabric Api Admin"), outsider: issuer.person("Jarc Admin Outsider", { admin: true }), other: issuer.person("Other Employee") };
});
async function signedIn(app, person) {
  const client = new SessionClient(app.url, issuer.config.appOrigin);
  assert.equal((await client.signIn(person)).status, 201);
  return client;
}
async function boot({ fake = {}, fabric = true, apiTokens = null, config = null, env = {} } = {}) {
  const client = new FabricFakeClient({ docs: docs(), inventory: { docs: inventoryRows(300) }, ...fake });
  let created = 0;
  const cfg = config || loadConfig(fabricEnv(people, env)).fabricData;
  const stack = cfg.enabled ? { ...createFabricData({ config: cfg, logger: { warn() {}, error() {} }, createClient: () => { created += 1; return client; } }), limiter: generous() } : null;
  const app = await startFabricApp({ issuer, fabricData: fabric ? (stack || { config: cfg, service: {} }) : null, accessPolicy: "development_shared", betaOpenEditing: true, apiTokens });
  return { app, client, created: () => created, close: async () => { await app.close(); await stack?.close(); } };
}
const VIEWS = { FABRIC_INVOICE_VIEWS: "true" };

describe("Fabric Data permissions (open access and JARC.Admin on: neither grants it)", () => {
  let env, reader, cost, admin, outsider, other;
  before(async () => {
    env = await boot({ env: VIEWS });
    [reader, cost, admin, outsider, other] = await Promise.all([people.reader, people.cost, people.admin, people.outsider, people.other].map((p) => signedIn(env.app, p)));
  });
  after(() => env.close());

  test("401 without a session, and 401 for any Authorization header even with a reader's session", async () => {
    const anonymous = new SessionClient(env.app.url, issuer.config.appOrigin);
    for (const path of ["/status", "/sales/records", "/inventory/schema", `/invoices?${Q}`, "/nothing-here"]) {
      const res = await anonymous.request("GET", `/api/v1/fabric${path}`);
      assert.equal(res.status, 401, path);
      assert.equal(res.body.error.code, "UNAUTHENTICATED");
    }
    for (const header of ["Bearer jarc_abc", "Basic eDp5", ""]) {
      const res = await reader.request("GET", "/api/v1/fabric/status", undefined, { headers: { Authorization: header } });
      assert.equal(res.status, 401, header);
      assert.equal(res.body.error.code, "UNAUTHENTICATED");
    }
  });

  test("403 FABRIC_DATA_FORBIDDEN for signed-in non-readers: an employee, and a JARC.Admin under development_shared + beta open editing", async () => {
    for (const client of [outsider, other]) for (const path of ["/status", "/sales/records", "/inventory/records", "/inventory/schema", "/sales/records/0123456789abcdef01234567", `/invoices?${Q}`, "/invoices/ALPHA/1001"]) {
      const res = await client.request("GET", `/api/v1/fabric${path}`);
      assert.equal(res.status, 403, path);
      assert.equal(res.body.error.code, "FABRIC_DATA_FORBIDDEN");
      assert.equal(JSON.stringify(res.body).includes("ALPHA"), false);
    }
    assert.equal(env.client.queries().length, 0, "nothing was read for them");
  });

  test("/features: fabricData for this caller (read, sensitive + its cost alias, apiAdmin, datasets, invoiceViews), apiTokens false while API tokens are off", async () => {
    const flags = async (c) => (await c.request("GET", "/api/v1/features")).body.features.fabricData;
    assert.deepEqual(await flags(reader), { read: true, sensitive: false, cost: false, apiAdmin: false, apiOversight: false, canGrantSensitive: false, datasets: DATASETS, invoiceViews: true, apiTokens: false });
    assert.deepEqual(await flags(cost), { read: true, sensitive: true, cost: true, apiAdmin: false, apiOversight: false, canGrantSensitive: false, datasets: DATASETS, invoiceViews: true, apiTokens: false });
    assert.deepEqual(await flags(admin), { read: true, sensitive: false, cost: false, apiAdmin: true, apiOversight: false, canGrantSensitive: false, datasets: DATASETS, invoiceViews: true, apiTokens: false });
    assert.deepEqual(await flags(outsider), { read: false, sensitive: false, cost: false, apiAdmin: false, apiOversight: false, canGrantSensitive: false, datasets: [], invoiceViews: false, apiTokens: false });
  });

  test("a reader gets 200 with Cache-Control: no-store; status answers per dataset", async () => {
    const res = await reader.request("GET", "/api/v1/fabric/status");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.body.available, true);
    assert.deepEqual(Object.keys(res.body.datasets), DATASETS);
    assert.deepEqual([res.body.datasets.sales.mode, res.body.datasets.inventory.mode], ["indexed", "small"]);
    assert.equal(res.body.datasets.inventory.estimate, 300);
    assert.match(res.body.datasets.inventory.latestDate, /^2026-0[45]-\d\dT/);
    assert.deepEqual(res.body.access, { datasets: DATASETS, sensitive: false });
    assert.deepEqual(res.body.invoiceViews.capabilities, { invoiceList: true, invoiceDetail: true });
    assert.equal((await reader.request("HEAD", "/api/v1/fabric/status")).status, 200);
    assert.equal(/\b[A-Z][a-z]+User\b/.test(res.text), false, "no other collection is named");
  });

  test("dataset routes: schema, records and one record, sensitive fields only for sensitive readers", async () => {
    for (const name of DATASETS) {
      const rs = await reader.request("GET", `/api/v1/fabric/${name}/schema`);
      const cs = await cost.request("GET", `/api/v1/fabric/${name}/schema`);
      assert.equal(rs.status, 200, rs.text);
      assert.equal(rs.body.dataset, name);
      assert.ok(rs.body.fields.every((f) => !f.sensitive), name);
      assert.ok(cs.body.fields.some((f) => f.sensitive), name);
      assert.ok(rs.body.fields.length < cs.body.fields.length);
      const rr = await reader.request("GET", `/api/v1/fabric/${name}/records?limit=5`);
      assert.equal(rr.status, 200, rr.text);
      assert.ok(rr.body.items.length >= 1);
      const detail = await reader.request("GET", `/api/v1/fabric/${name}/records/${rr.body.items[0].id}`);
      assert.equal(detail.status, 200, detail.text);
      const costDetail = await cost.request("GET", `/api/v1/fabric/${name}/records/${rr.body.items[0].id}`);
      // sales: landed_cost + Text, Custom, custom_1, Custom.2 (restricted until confirmed); inventory: 9 cost and price fields.
      assert.equal(detail.body.record.fields.length + (name === "sales" ? 5 : 9), costDetail.body.record.fields.length);
      if (name === "sales") for (const f of ["Text", "Custom", "custom_1", "Custom.2"]) assert.equal(detail.body.record.fields.some((x) => x.name === f), false, f);
      assert.equal(detail.text.includes("landed_cost") || detail.text.includes("never returned"), false);
    }
    const refused = await reader.request("GET", "/api/v1/fabric/inventory/records?fields=Item_No,Cost_Amount_Actual");
    const unknown = await reader.request("GET", "/api/v1/fabric/inventory/records?fields=Item_No,No_Such_Field");
    assert.deepEqual([refused.status, refused.body.error.code], [400, "VALIDATION_ERROR"]);
    assert.equal(refused.body.error.message.replace("Cost_Amount_Actual", "X"), unknown.body.error.message.replace("No_Such_Field", "X"), "a sensitive field is refused like an unknown one");
    assert.equal((await cost.request("GET", "/api/v1/fabric/inventory/records?fields=Item_No,Cost_Amount_Actual")).status, 200);
    const gone = await reader.request("GET", "/api/v1/fabric/sales/records/0123456789abcdef01234567");
    assert.deepEqual([gone.status, gone.body.error.code, gone.body.error.message], [404, "FABRIC_RECORD_NOT_FOUND", "This record is no longer in the source (the data may have been refreshed)."]);
    assert.equal((await reader.request("GET", "/api/v1/fabric/sales/records/xyz")).status, 400);
  });

  test("unknown datasets are one 404 that never echoes the name (other collections, case variants, collection names, traversal)", async () => {
    const answers = new Set();
    for (const name of ["EmployeeData", "employeedata", "OtherCollection", "FactSales", "FactInventory", "Sales", "INVENTORY", "..%2Fx", "..%2F..%2Fboards", "constructor", "__proto__", "x".repeat(300)]) {
      for (const suffix of ["/schema", "/records", "/records/0123456789abcdef01234567"]) {
        const res = await reader.request("GET", `/api/v1/fabric/${name}${suffix}`);
        assert.equal(res.status, 404, `${name}${suffix}`);
        assert.equal(res.body.error.code, "NOT_FOUND");
        assert.equal(res.text.toLowerCase().includes(decodeURIComponent(name).toLowerCase().slice(0, 20)), false, name);
        answers.add(res.text);
      }
    }
    // ("%2E%2E" never reaches the router: URL parsing resolves it as "..".)
    assert.equal(answers.size, 1, "the same answer for every unknown name");
    assert.equal(env.client.listCollectionsCalls, 0);
    assert.ok(env.client.collectionNames.every((n) => ["FactSales", "FactInventory"].includes(n)));
  });

  test("invoice views (FABRIC_INVOICE_VIEWS=true): cost fields absent for a reader, present for a sensitive reader", async () => {
    const r = await reader.request("GET", `/api/v1/fabric/invoices?${Q}`);
    const c = await cost.request("GET", `/api/v1/fabric/invoices?${Q}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.items.every((i) => !("cost" in i)));
    assert.equal(r.text.includes("landed"), false);
    assert.ok(c.body.items.every((i) => i.cost && "rowsWithCost" in i.cost));
    assert.deepEqual(c.body.access, { cost: true });
    const rd = await reader.request("GET", "/api/v1/fabric/invoices/ALPHA/1001");
    const cd = await cost.request("GET", "/api/v1/fabric/invoices/ALPHA/1001");
    assert.equal(rd.status, 200);
    assert.equal("cost" in rd.body.invoice, false);
    assert.equal(cd.body.invoice.cost.rowsWithCost, 1);
    const rl = await reader.request("GET", "/api/v1/fabric/invoices/ALPHA/1001/lines");
    const cl = await cost.request("GET", "/api/v1/fabric/invoices/ALPHA/1001/lines");
    assert.ok(rl.body.items.every((l) => !("cost" in l)));
    assert.equal(cl.body.items.find((l) => l.lineNo === 10000).cost.landedCostPerUnit, "2.5");
    const id = rl.body.items.find((l) => l.lineNo === 10000).id;
    const rf = await reader.request("GET", `/api/v1/fabric/invoices/ALPHA/1001/lines/${id}`);
    const cf = await cost.request("GET", `/api/v1/fabric/invoices/ALPHA/1001/lines/${id}`);
    assert.equal(rf.status, 200);
    assert.equal(rf.body.line.fields.some((f) => f.name === "landed_cost"), false);
    assert.equal(rf.text.includes("2.5"), false);
    assert.equal(cf.body.line.fields.find((f) => f.name === "landed_cost").value, "2.5");
    assert.equal(rf.text.includes("never returned") || cf.text.includes("upstream_new_field"), false, "unknown upstream fields are never returned");
    assert.equal((await reader.request("GET", `/api/v1/fabric/sales-lines?${Q}`)).status, 404, "/sales-lines is gone");
  });

  test("invoice path segments: ~ is no company, encoded slashes work, a missing invoice or line is 404, a bad lineId 400", async () => {
    const res = await reader.request("GET", `/api/v1/fabric/invoices/~/${encodeURIComponent("A/2002")}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.invoice.company, null);
    assert.equal(res.body.invoice.invoiceNo, "A/2002");
    assert.equal((await reader.request("GET", "/api/v1/fabric/invoices/GAMMA/1001")).body.error.code, "FABRIC_INVOICE_NOT_FOUND");
    const gone = await reader.request("GET", "/api/v1/fabric/invoices/ALPHA/1001/lines/0123456789abcdef01234567");
    assert.deepEqual([gone.status, gone.body.error.code], [404, "FABRIC_LINE_NOT_FOUND"]);
    assert.equal((await reader.request("GET", "/api/v1/fabric/invoices/ALPHA/1001/lines/xyz")).status, 400);
    assert.equal((await reader.request("GET", "/api/v1/fabric/unknown")).body.error.code, "NOT_FOUND");
  });

  test("L3: /api/v1/fabric ends in its own JSON 404; /fabric/api-tokens with API tokens off is a JSON 404 for every method", async () => {
    for (const path of ["/nothing-here", "/sales/other", "/inventory/records/0123456789abcdef01234567/x", "/a/b/c/d"]) {
      const res = await reader.request("GET", `/api/v1/fabric${path}`);
      assert.deepEqual([res.status, res.body.error.code], [404, "NOT_FOUND"], path);
      assert.match(res.headers.get("content-type"), /application\/json/);
    }
    for (const [method, path] of [["GET", "/api-tokens"], ["POST", "/api-tokens"], ["DELETE", "/api-tokens/x"], ["GET", "/api-tokens/activity"]]) {
      const res = await admin.request(method, `/api/v1/fabric${path}`, method === "POST" ? {} : undefined);
      assert.deepEqual([res.status, res.body.error.code], [404, "NOT_FOUND"], `${method} ${path}`);
    }
    const anonymous = new SessionClient(env.app.url, issuer.config.appOrigin);
    assert.equal((await anonymous.request("GET", "/api/v1/fabric/api-tokens")).status, 401, "still behind sign-in");
  });

  test("405 METHOD_NOT_ALLOWED (Allow: GET, HEAD) for every other method, before anything is read", async () => {
    const before = env.client.queries().length;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) for (const path of ["/status", "/sales/records", "/inventory/schema", "/inventory/records/0123456789abcdef01234567", "/invoices", "/invoices/ALPHA/1001"]) {
      const res = await reader.request(method, `/api/v1/fabric${path}`, method === "DELETE" ? undefined : {});
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.body.error.code, "METHOD_NOT_ALLOWED");
      assert.equal(res.headers.get("allow"), "GET, HEAD");
    }
    assert.equal(env.client.queries().length, before);
  });

  test("validation over HTTP: unknown, repeated and $ parameters, bad dates, ranges, limits, sorts, filters and cursors are 400", async () => {
    for (const query of ["foo=1", "q=a&q=b", "%24where=1", "company%5B%24ne%5D=x", "dateFrom=2026-02-30", "dateFrom=2026-01-01&dateTo=2026-04-03", "dateFrom=2026-03-02&dateTo=2026-03-01", "limit=0", "limit=201", "cursor=%%%", "cursor=abc", "sort=landed_cost", "sort=entryNo", "landed_cost=1", "fields=", "fields=Custom.2,landed_cost", "entryType=Sale"]) {
      const res = await reader.request("GET", `/api/v1/fabric/sales/records?${query}`);
      assert.equal(res.status, 400, query);
      assert.equal(res.body.error.code, "VALIDATION_ERROR", query);
    }
    for (const query of ["open=yes", "sort=amount", "Cost_Amount_Actual=1", "dir=up"]) assert.equal((await reader.request("GET", `/api/v1/fabric/inventory/records?${query}`)).status, 400, query);
    assert.equal((await reader.request("GET", "/api/v1/fabric/invoices?limit=101")).status, 400);
    assert.equal((await reader.request("GET", "/api/v1/fabric/status?x=1")).status, 400);
    assert.equal((await reader.request("GET", "/api/v1/fabric/sales/schema?x=1")).status, 400);
  });
});

describe("Fabric Data failures and the switch", () => {
  test("switched off: /api/v1/fabric/* is 404, no fabricData in /features, no deep links, and no client is ever created", async () => {
    const env = await boot({ config: loadConfig(entraEnv()).fabricData });
    try {
      const reader = await signedIn(env.app, people.reader);
      for (const path of ["/status", "/sales/records", "/inventory/schema", `/invoices?${Q}`]) {
        const res = await reader.request("GET", `/api/v1/fabric${path}`);
        assert.deepEqual([res.status, res.body.error.code], [404, "NOT_FOUND"], path);
      }
      const features = (await reader.request("GET", "/api/v1/features")).body.features;
      assert.equal("fabricData" in features, false);
      assert.equal((await reader.request("GET", "/fabric/inventory")).status, 404);
      assert.equal(env.created(), 0);
    } finally { await env.close(); }
  });

  test("invoice views are off by default: /invoices… are 404 and /features says invoiceViews: false; the dataset routes work", async () => {
    const env = await boot();
    try {
      const reader = await signedIn(env.app, people.reader);
      for (const path of [`/invoices?${Q}`, "/invoices/ALPHA/1001", "/invoices/ALPHA/1001/lines", `/invoices/ALPHA/1001/lines/0123456789abcdef01234567`, "/sales-lines"]) {
        const res = await reader.request("GET", `/api/v1/fabric${path}`);
        assert.deepEqual([res.status, res.body.error.code], [404, "NOT_FOUND"], path);
      }
      assert.equal((await reader.request("GET", "/api/v1/features")).body.features.fabricData.invoiceViews, false);
      const status = await reader.request("GET", "/api/v1/fabric/status");
      assert.equal("invoiceViews" in status.body, false);
      assert.equal((await reader.request("GET", "/api/v1/fabric/inventory/records")).status, 200);
    } finally { await env.close(); }
  });

  test("HTML deep links are served (root-relative) only while it's on; invoice pages only with the invoice views", async () => {
    const env = await boot();
    const views = await boot({ env: VIEWS });
    try {
      for (const path of ["/fabric/inventory", "/fabric/sales/", "/fabric/api", "/fabric/api/", "/fabric/inventory/records/0123456789abcdef01234567", "/fabric/sales/records/abc"]) {
        const res = await fetch(env.app.url + path);
        assert.equal(res.status, 200, path);
        assert.match(res.headers.get("content-type"), /text\/html/);
        assert.doesNotMatch(await res.text(), /(?:href|src)="assets\//, path);
      }
      for (const path of ["/fabric", "/fabric/other", "/fabric/invoices", "/fabric/sales-lines", "/fabric/api/records/x", "/fabric/inventory/x", "/fabric/sales/records/a/b"]) assert.equal((await fetch(env.app.url + path)).status, 404, path);
      for (const path of ["/fabric/invoices", "/fabric/invoices/", "/fabric/invoices/ALPHA/1001", `/fabric/invoices/~/${encodeURIComponent("A/2002")}`, "/fabric/inventory"]) assert.equal((await fetch(views.app.url + path)).status, 200, path);
      for (const path of ["/fabric/invoices/ALPHA", "/fabric/invoices/a/b/c"]) assert.equal((await fetch(views.app.url + path)).status, 404, path);
      assert.equal(env.created() + views.created(), 0, "serving the page doesn't touch Fabric");
    } finally { await env.close(); await views.close(); }
  });

  test("Fabric unreachable: data routes 503 FABRIC_UNAVAILABLE, status 200 (available false), JARC's readiness stays 200", async () => {
    const env = await boot({ fake: { connectError: Object.assign(new Error("getaddrinfo ENOTFOUND fabric.invalid"), { name: "MongoServerSelectionError" }) } });
    try {
      const reader = await signedIn(env.app, people.reader);
      const data = await reader.request("GET", "/api/v1/fabric/sales/records");
      assert.deepEqual([data.status, data.body.error.code], [503, "FABRIC_UNAVAILABLE"]);
      assert.equal(data.text.includes("fabric.invalid"), false);
      const status = await reader.request("GET", "/api/v1/fabric/status");
      assert.deepEqual([status.status, status.body.available, status.body.reason], [200, false, "FABRIC_UNAVAILABLE"]);
      const ready = await fetch(`${env.app.url}/api/v1/health/ready`);
      assert.equal(ready.status, 200);
      assert.equal((await ready.text()).toLowerCase().includes("fabric"), false);
    } finally { await env.close(); }
  });

  test("unsafe credentials, a missing collection and missing indexes are reported by status and refused by data routes", async () => {
    const unsafe = await boot({ fake: { authInfo: { authenticatedUserRoles: [{ role: "readWrite", db: "FabricTestDb" }], authenticatedUserPrivileges: [{ resource: { db: "FabricTestDb", collection: "" }, actions: ["find", "insert"] }] } } });
    const missing = await boot({ fake: { missing: true } });
    const limited = await boot({ fake: { indexes: [DEFAULT_INDEXES[0]] }, env: { ...VIEWS, FABRIC_UNINDEXED_SCAN_MAX: "0" } });
    try {
      const u = await signedIn(unsafe.app, people.reader), m = await signedIn(missing.app, people.reader), l = await signedIn(limited.app, people.reader);
      assert.equal((await u.request("GET", "/api/v1/fabric/status")).body.reason, "FABRIC_UNSAFE_CREDENTIALS");
      assert.deepEqual([(await u.request("GET", "/api/v1/fabric/inventory/records")).status, (await u.request("GET", "/api/v1/fabric/sales/records")).body.error.code], [503, "FABRIC_UNSAFE_CREDENTIALS"]);
      assert.equal((await m.request("GET", "/api/v1/fabric/status")).body.reason, "FABRIC_SOURCE_MISSING");
      assert.equal((await m.request("GET", "/api/v1/fabric/sales/records")).body.error.code, "FABRIC_SOURCE_MISSING");
      for (const path of [`/invoices?${Q}`, "/sales/records", "/inventory/records"]) {
        const res = await l.request("GET", `/api/v1/fabric${path}`);
        assert.deepEqual([res.status, res.body.error.code], [503, "FABRIC_INDEX_REQUIRED"], path);
        assert.ok(res.body.error.details.missingIndexes[0].name.startsWith("fabric_"), path);
      }
      assert.equal(limited.client.queries().length, 0, "no query without its index");
      const status = (await l.request("GET", "/api/v1/fabric/status")).body;
      assert.deepEqual([status.datasets.sales.mode, status.datasets.inventory.mode], ["unavailable", "unavailable"]);
      assert.deepEqual(status.datasets.inventory.missingIndexes.map((x) => x.name), ["fabric_inventory_date", "fabric_inventory_entry"]);
      assert.equal(status.invoiceViews.missingIndexes.length, 2);
    } finally { await Promise.all([unsafe.close(), missing.close(), limited.close()]); }
  });

  test("with API tokens on, /features says apiTokens: true", async () => {
    const env = await boot({ apiTokens: { key: crypto.randomBytes(32), adminObjectIds: [] } });
    try {
      const admin = await signedIn(env.app, people.admin);
      const features = (await admin.request("GET", "/api/v1/features")).body.features;
      assert.deepEqual(features.fabricData, { read: true, sensitive: false, cost: false, apiAdmin: true, apiOversight: false, canGrantSensitive: false, datasets: DATASETS, invoiceViews: false, apiTokens: true });
      assert.equal(features.apiTokens, true);
    } finally { await env.close(); }
  });

  test("createApp refuses Fabric Data without Microsoft sign-in, and app.locals.fabric exposes the service for the token routes", async () => {
    const cfg = loadConfig(fabricEnv(people)).fabricData;
    assert.throws(() => createApp({ environment: "test", repository: { load() {} }, fabricData: { config: cfg, service: {} } }), /needs Microsoft Entra ID sign-in/);
    const env = await boot();
    try {
      assert.equal(typeof env.app.app.locals.fabric.service.listRecords, "function");
      assert.equal(typeof env.app.app.locals.fabric.canManageFabricApi, "function");
      assert.equal(typeof env.app.app.locals.fabric.canReadFabricSensitive, "function");
    } finally { await env.close(); }
  });
});

describe("The shared router and logging", () => {
  const mount = ({ service, access, limiter, invoiceViews = false }) => {
    const app = express();
    const logger = { errors: [], error(m) { this.errors.push(String(m)); } };
    app.use("/fabric", (req, res, next) => { if (access) req.fabricAccess = access; next(); }, fabricDataRouter({ service, logger, invoiceViews, ...(limiter ? { limiter } : {}) }));
    return new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, logger, close: () => new Promise((r) => s.close(r)) })); });
  };

  test("no req.fabricAccess → 401; tokens are rate-limited per token with Retry-After", async () => {
    const service = { status: async (a) => ({ ok: true, access: a }) };
    const none = await mount({ service });
    const token = await mount({ service, access: { datasets: new Set(["sales"]), sensitive: false, via: "token", tokenId: "t1" }, limiter: fabricLimiter({ perWindow: 2 }) });
    try {
      assert.equal((await fetch(`${none.url}/fabric/status`)).status, 401);
      assert.equal((await fetch(`${token.url}/fabric/status`)).status, 200);
      assert.equal((await fetch(`${token.url}/fabric/status`)).status, 200);
      const limited = await fetch(`${token.url}/fabric/status`);
      assert.equal(limited.status, 429);
      assert.equal((await limited.json()).error.code, "RATE_LIMITED");
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    } finally { await Promise.all([none.close(), token.close()]); }
  });

  test("the session limiter: 30 requests per 10 s per caller", () => {
    let t = 0;
    const limit = fabricLimiter({ now: () => t });
    for (let i = 0; i < 30; i += 1) assert.equal(limit("session:a"), 0);
    assert.equal(limit("session:a"), 10);
    assert.equal(limit("session:b"), 0, "per caller");
    t = 10001;
    assert.equal(limit("session:a"), 0);
  });

  test("an unexpected failure is a plain 500, logged without the path, query or error text", async () => {
    const service = { listRecords: async () => { throw new TypeError("boom ALPHA 1001 Example Customer"); } };
    const env = await mount({ service, access: { datasets: new Set(["sales", "inventory"]), sensitive: false, via: "session", actorId: "u1" } });
    try {
      const res = await fetch(`${env.url}/fabric/sales/records?q=Example%20Customer&company=ALPHA`);
      assert.equal(res.status, 500);
      assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
      assert.equal(env.logger.errors.length, 1);
      assert.doesNotMatch(env.logger.errors[0], /ALPHA|Example|1001|q=/);
    } finally { await env.close(); }
  });

  test("the general error log names only the Fabric route prefix; other paths keep their behaviour", () => {
    assert.equal(loggedUrl({ originalUrl: "/api/v1/fabric/invoices/ALPHA/1001?q=Example" }), "/api/v1/fabric/[redacted]");
    assert.equal(loggedUrl({ originalUrl: "/api/v1/external/fabric/inventory/records?company=ALPHA" }), "/api/v1/external/fabric/[redacted]");
    assert.equal(loggedUrl({ originalUrl: "/api/v1/fabric" }), "/api/v1/fabric/[redacted]");
    assert.equal(loggedUrl({ originalUrl: "/api/v1/boards/1/records" }), "/api/v1/boards/1/records");
    assert.equal(loggedUrl({ originalUrl: "/api/v1/search?q=x" }), "/api/v1/search?[redacted]");
    assert.equal(loggedUrl({ originalUrl: "/api/v1/fabricated" }), "/api/v1/fabricated");
  });
});
