// Fabric API administrators with per-key ownership, and oversight for one person (FABRIC_API_OVERSIGHT_OIDS). The REAL app
// (createApp) with Entra sign-in, development_shared + beta open editing (every employee edits boards), API tokens on (a random
// test key), JARC on its fake MongoDB and Fabric on tests/support/fabric-fake.js. Synthetic people and data only; nothing
// connects to a real database.
//
// The target configuration: the same people in FABRIC_DATA_READER_OIDS, FABRIC_DATA_COST_READER_OIDS and FABRIC_API_ADMIN_OIDS,
// and only the owner in FABRIC_API_OVERSIGHT_OIDS. Every administrator issues keys with any scope combination and manages only
// their own; the owner sees and revokes everyone's; nobody sees a secret after creation.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
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
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();
const code = (res) => res.body?.error?.code;
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const day = (d) => new Date(`2026-03-${String(d).padStart(2, "0")}T08:00:00Z`);
const docs = () => [
  row({ Company: "ALPHA", invoice_id: "1001", Line_No: 10000, invoice_date: day(10), customer_name: "Example Customer One", invoice_item_amount: 10, Unit_Price: dec("5.00"), landed_cost: "2.5" }),
  row({ Company: "BETA", invoice_id: "2002", invoice_date: day(12), customer_name: "Example Customer Two", invoice_item_amount: 7, landed_cost: "1.5" })
];
const SALES = "fabric.sales.read", INVENTORY = "fabric.inventory.read", SENSITIVE = "fabric.sensitive.read";
const INV_SENSITIVE = "fields=Item_No,Cost_Amount_Actual";
const SALES_SENSITIVE = "fields=invoice_id,landed_cost";
const TOKENS = "/api/v1/fabric/api-tokens";

let issuer, people;
const oids = (...ps) => ps.map((p) => p.oid).join(",");
// The target: owner, a1 and a2 are readers, sensitive readers and administrators; only the owner has oversight. readerCost reads
// sensitive fields but isn't an administrator; readerPlain only reads; outsider and boardAdmin (a JARC API administrator with
// JARC.Admin) are in no Fabric list.
const targetEnv = (overrides = {}) => entraEnv({
  JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb",
  FABRIC_DATA_READER_OIDS: oids(people.owner, people.a1, people.a2, people.readerCost, people.readerPlain),
  FABRIC_DATA_COST_READER_OIDS: oids(people.owner, people.a1, people.a2, people.readerCost),
  FABRIC_API_ADMIN_OIDS: oids(people.owner, people.a1, people.a2),
  FABRIC_API_OVERSIGHT_OIDS: oids(people.owner),
  ...overrides
});

async function boot({ fake = new FakeMongoClient(), env = targetEnv() } = {}) {
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const logger = { errors: [], warnings: [], error(...a) { this.errors.push(a.map(String).join(" ")); }, warn(...a) { this.warnings.push(a.map(String).join(" ")); } };
  const dataLayer = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), environment: "test" });
  const verify = createEntraVerifier({ ...issuer.config, keySet: issuer.keySet });
  const config = loadConfig(env).fabricData;
  const fabricClient = new FabricFakeClient({ docs: docs(), inventory: { docs: inventoryRows(50) } });
  const stack = createFabricData({ config, logger: { warn() {}, error() {} }, createClient: () => fabricClient });
  const app = createApp({
    repository: new MemoryStateRepository(), environment: "test", logger, dataLayer,
    auth: { mode: "entra", entra: issuer.config, verify },
    accessPolicy: "development_shared", betaOpenEditing: true,
    apiTokens: { key: KEY, adminObjectIds: [people.boardAdmin.oid.toLowerCase()], issuePerHour: 1000, maxActive: 1000 },
    fabricData: { config, service: stack.service, limiter: fabricLimiter({ perWindow: 10000 }) }
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
  const close = async () => { app.locals.realtime?.closeAll(); await new Promise((resolve) => server.close(resolve)); await stack.close(); };
  return { url, fake, db: connection.db, logger, as, browserOf, close };
}

async function call(env, token, path, { method = "GET" } = {}) {
  const res = await fetch(`${env.url}/api/v1/external${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}
const issue = (env, person, { scopes = [SALES, INVENTORY], ...rest } = {}) => env.as(person, "POST", TOKENS, { name: "Fabric BI", scopes, expiresAt: inDays(30), ...rest });
const userIdOf = async (env, person) => (await env.as(person, "GET", "/api/v1/me")).body.user.id;
const storedToken = (env, id) => env.db.collection(COLLECTIONS.apiTokens).findOne({ _id: new ObjectId(id) });

before(async () => {
  issuer = await createTokenIssuer();
  people = {
    owner: issuer.person("Ona Owner"), a1: issuer.person("Abe AdminOne"), a2: issuer.person("Bea AdminTwo"),
    readerCost: issuer.person("Cy CostReader"), readerPlain: issuer.person("Pia PlainReader"),
    outsider: issuer.person("Olive Outsider"), boardAdmin: issuer.person("Jay BoardApiAdmin", { admin: true })
  };
});

describe("Configuration: FABRIC_API_OVERSIGHT_OIDS", () => {
  test("unset means nobody; each must be a Fabric API administrator; at most 5", () => {
    assert.deepEqual(loadConfig(targetEnv({ FABRIC_API_OVERSIGHT_OIDS: undefined })).fabricData.apiOversightObjectIds, []);
    assert.deepEqual(loadConfig(targetEnv({ FABRIC_API_OVERSIGHT_OIDS: "" })).fabricData.apiOversightObjectIds, []);
    assert.deepEqual(loadConfig(targetEnv()).fabricData.apiOversightObjectIds, [people.owner.oid.toLowerCase()]);
    assert.throws(() => loadConfig(targetEnv({ FABRIC_API_OVERSIGHT_OIDS: oids(people.readerCost) })), /FABRIC_API_OVERSIGHT_OIDS must also be in FABRIC_API_ADMIN_OIDS/);
    assert.throws(() => loadConfig(targetEnv({ FABRIC_API_OVERSIGHT_OIDS: "not-a-guid" })), /FABRIC_API_OVERSIGHT_OIDS must list/);
    const six = Array.from({ length: 6 }, () => crypto.randomUUID());
    assert.throws(() => loadConfig(targetEnv({ FABRIC_DATA_READER_OIDS: six.join(","), FABRIC_DATA_COST_READER_OIDS: "", FABRIC_API_ADMIN_OIDS: six.join(","), FABRIC_API_OVERSIGHT_OIDS: six.join(",") })), /at most 5/);
    // Switched off: the variable isn't looked at.
    assert.equal(loadConfig(entraEnv({ FABRIC_API_OVERSIGHT_OIDS: "not-a-guid" })).fabricData.enabled, false);
  });
});

describe("The permission matrix (target configuration)", () => {
  let env, ids;
  before(async () => {
    env = await boot();
    ids = {};
    for (const p of Object.keys(people)) ids[p] = await userIdOf(env, people[p]);
  });
  after(() => env.close());

  test("/features: apiAdmin, apiOversight and canGrantSensitive per person", async () => {
    const f = async (p) => (await env.as(p, "GET", "/api/v1/features")).body.features.fabricData;
    const pick = (x) => [x.read, x.sensitive, x.apiAdmin, x.apiOversight, x.canGrantSensitive, x.apiTokens];
    assert.deepEqual(pick(await f(people.owner)), [true, true, true, true, true, true]);
    for (const p of [people.a1, people.a2]) assert.deepEqual(pick(await f(p)), [true, true, true, false, true, true], p.name);
    assert.deepEqual(pick(await f(people.readerCost)), [true, true, false, false, false, true]);
    assert.deepEqual(pick(await f(people.readerPlain)), [true, false, false, false, false, true]);
    for (const p of [people.outsider, people.boardAdmin]) assert.deepEqual(pick(await f(p)), [false, false, false, false, false, true], p.name);
  });

  test("every administrator issues keys with any scope combination, expiry included; the secret is returned only then", async () => {
    const combos = [[SALES], [INVENTORY], [SALES, INVENTORY], [SALES, SENSITIVE], [INVENTORY, SENSITIVE], [SALES, INVENTORY, SENSITIVE]];
    for (const p of [people.owner, people.a1, people.a2]) {
      for (const scopes of combos) {
        const expiresAt = inDays(90);
        const res = await issue(env, p, { scopes, expiresAt });
        assert.equal(res.status, 201, `${p.name} ${scopes} ${res.text}`);
        assert.deepEqual(res.body.token.scopes, scopes);
        assert.equal(res.body.token.mine, true);
        assert.equal(res.body.token.owner.id, ids[p === people.owner ? "owner" : p === people.a1 ? "a1" : "a2"]);
        assert.ok(Math.abs(new Date(res.body.token.expiresAt).getTime() - new Date(expiresAt).getTime()) <= 86400000, "the expiry chosen");
        assert.match(res.body.secret, /^jarc_/);
        const stored = await storedToken(env, res.body.token.id);
        assert.ok(!JSON.stringify(stored).includes(res.body.secret.slice(30)), "only the digest is stored");
      }
    }
  });

  test("an administrator lists only their own keys (scope own); the owner lists everyone's (scope all); no secret or digest", async () => {
    const a1Key = (await issue(env, people.a1, { name: "A1 key" })).body, a2Key = (await issue(env, people.a2, { name: "A2 key" })).body, ownerKey = (await issue(env, people.owner, { name: "Owner key" })).body;
    const a1List = await env.as(people.a1, "GET", TOKENS);
    assert.equal(a1List.status, 200);
    assert.equal(a1List.body.scope, "own");
    assert.ok(a1List.body.tokens.length >= 1);
    assert.ok(a1List.body.tokens.every((t) => t.owner.id === ids.a1 && t.mine === true), "only a1's own keys");
    assert.ok(a1List.body.tokens.some((t) => t.id === a1Key.token.id));
    assert.ok(!a1List.body.tokens.some((t) => t.id === a2Key.token.id || t.id === ownerKey.token.id));

    const all = await env.as(people.owner, "GET", TOKENS);
    assert.equal(all.body.scope, "all");
    const byId = new Map(all.body.tokens.map((t) => [t.id, t]));
    assert.equal(byId.get(a1Key.token.id).mine, false);
    assert.equal(byId.get(a2Key.token.id).owner.id, ids.a2);
    assert.equal(byId.get(ownerKey.token.id).mine, true);
    for (const res of [a1List, all]) {
      for (const secret of [a1Key.secret, a2Key.secret, ownerKey.secret]) assert.ok(!res.text.includes(secret) && !res.text.includes(secret.slice(30)));
      assert.ok(!res.text.includes("digest"));
    }
  });

  test("bypass: revoking another person's key is the same 404 as an unknown ID, changes nothing and records nothing", async () => {
    const a2Key = (await issue(env, people.a2)).body, ownerKey = (await issue(env, people.owner)).body;
    const unknown = await env.as(people.a1, "POST", `${TOKENS}/${new ObjectId().toHexString()}/revoke`);
    assert.deepEqual([unknown.status, code(unknown)], [404, "NOT_FOUND"]);
    for (const target of [a2Key, ownerKey]) {
      const res = await env.as(people.a1, "POST", `${TOKENS}/${target.token.id}/revoke`);
      assert.deepEqual([res.status, res.body], [unknown.status, unknown.body], "indistinguishable from an unknown ID");
      assert.equal((await storedToken(env, target.token.id)).revokedAt, null);
      assert.equal((await call(env, target.secret, "/fabric/status")).status, 200, "the key still works");
      assert.equal(await env.db.collection(COLLECTIONS.apiTokenAudit).countDocuments({ tokenId: new ObjectId(target.token.id), action: "token.revoked" }), 0);
    }
  });

  test("bypass: no update, rename, regenerate or delete endpoint exists for anyone", async () => {
    const own = (await issue(env, people.a1)).body, other = (await issue(env, people.a2)).body;
    for (const p of [people.a1, people.owner]) for (const id of [own.token.id, other.token.id]) {
      for (const [method, path, body] of [["PATCH", `${TOKENS}/${id}`, { name: "renamed", scopes: [SALES, SENSITIVE] }], ["PUT", `${TOKENS}/${id}`, { name: "renamed" }], ["DELETE", `${TOKENS}/${id}`], ["POST", `${TOKENS}/${id}/rotate`, {}], ["POST", `${TOKENS}/${id}/regenerate`, {}], ["GET", `${TOKENS}/${id}`], ["POST", `${TOKENS}/${id}`, { scopes: [SALES, SENSITIVE] }]]) {
        const res = await env.as(p, method, path, body);
        assert.equal(res.status, 404, `${p.name} ${method} ${path}`);
      }
    }
    for (const id of [own.token.id, other.token.id]) assert.deepEqual((await storedToken(env, id)).scopes, [SALES, INVENTORY], "scopes unchanged");
  });

  test("bypass: a key can't be issued for someone else or with extra fields", async () => {
    for (const extra of [{ ownerUserId: ids.a2 }, { owner: ids.a2 }, { product: "board" }, { boardIds: [] }, { workspaceId: new ObjectId().toHexString() }, { secret: "jarc_x" }]) {
      const res = await issue(env, people.a1, extra);
      assert.equal(res.status, 400, JSON.stringify(extra));
    }
  });

  test("own revoke works (recorded as revoked by its owner); the owner revokes anyone's key (recorded as the owner)", async () => {
    const mine = (await issue(env, people.a1)).body;
    const own = await env.as(people.a1, "POST", `${TOKENS}/${mine.token.id}/revoke`);
    assert.equal(own.status, 200, own.text);
    assert.deepEqual([own.body.token.status, own.body.token.revokedBy.id, own.body.token.mine], ["revoked", ids.a1, true]);
    assert.deepEqual([(await call(env, mine.secret, "/fabric/status")).status, code(await call(env, mine.secret, "/fabric/status"))], [401, "TOKEN_REVOKED"]);

    const theirs = (await issue(env, people.a2)).body;
    const overseen = await env.as(people.owner, "POST", `${TOKENS}/${theirs.token.id}/revoke`);
    assert.equal(overseen.status, 200, overseen.text);
    assert.deepEqual([overseen.body.token.status, overseen.body.token.revokedBy.id, overseen.body.token.mine, overseen.body.token.owner.id], ["revoked", ids.owner, false, ids.a2]);
    assert.ok(!overseen.text.includes(theirs.secret));
    assert.equal(code(await call(env, theirs.secret, "/fabric/status")), "TOKEN_REVOKED");
    // a2 sees the revoke on their own key, and who did it.
    const a2Sees = (await env.as(people.a2, "GET", TOKENS)).body.tokens.find((t) => t.id === theirs.token.id);
    assert.deepEqual([a2Sees.status, a2Sees.revokedBy.id], ["revoked", ids.owner]);
  });

  test("activity: an administrator reads only entries about their own keys (security entries included); the owner reads all", async () => {
    const a2Key = (await issue(env, people.a2, { name: "A2 activity" })).body, a1Key = (await issue(env, people.a1, { name: "A1 activity" })).body;
    // A refused use of a2's key (expired) is audited about a2's key.
    await env.db.collection(COLLECTIONS.apiTokens).updateOne({ _id: new ObjectId(a2Key.token.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal(code(await call(env, a2Key.secret, "/fabric/status")), "TOKEN_EXPIRED");
    await tick();
    const a1Activity = await env.as(people.a1, "GET", `${TOKENS}/activity`);
    assert.equal(a1Activity.status, 200);
    assert.equal(a1Activity.body.scope, "own");
    assert.ok(a1Activity.body.items.length >= 1);
    assert.ok(a1Activity.body.items.every((e) => e.owner?.id === ids.a1), "only entries about a1's keys");
    assert.ok(a1Activity.body.items.some((e) => e.token?.id === a1Key.token.id));
    assert.ok(!a1Activity.body.items.some((e) => e.token?.id === a2Key.token.id));
    assert.ok(!a1Activity.text.includes(a1Key.secret));

    const all = await env.as(people.owner, "GET", `${TOKENS}/activity`);
    assert.equal(all.body.scope, "all");
    assert.ok(all.body.items.some((e) => e.token?.id === a2Key.token.id && e.action === "token.use_refused"));
    assert.ok(all.body.items.some((e) => e.token?.id === a1Key.token.id && e.action === "token.created"));
    assert.ok(!all.text.includes(a2Key.secret) && !all.text.includes(a1Key.secret));
  });

  test("non-administrators and unauthorized employees: no API Management at all, whatever they send", async () => {
    const target = (await issue(env, people.a1)).body;
    for (const p of [people.readerCost, people.readerPlain, people.outsider, people.boardAdmin]) {
      for (const [method, path, body] of [["GET", TOKENS], ["GET", `${TOKENS}/activity`], ["POST", TOKENS, { name: "x", scopes: [SALES], expiresAt: inDays(5) }], ["POST", TOKENS, { name: "x", scopes: [SALES, SENSITIVE], expiresAt: inDays(5) }], ["POST", `${TOKENS}/${target.token.id}/revoke`]]) {
        const res = await env.as(p, method, path, body);
        assert.deepEqual([res.status, code(res)], [403, "FABRIC_API_ADMIN_REQUIRED"], `${p.name} ${method} ${path}`);
        assert.ok(!res.text.includes(target.token.id) || method === "POST");
      }
    }
    // Unauthorized employees have no Fabric data either.
    for (const p of [people.outsider, people.boardAdmin]) for (const path of ["/status", "/sales/records", "/inventory/schema"]) {
      assert.deepEqual([(await env.as(p, "GET", `/api/v1/fabric${path}`)).status, code(await env.as(p, "GET", `/api/v1/fabric${path}`))], [403, "FABRIC_DATA_FORBIDDEN"], `${p.name} ${path}`);
    }
    assert.equal((await storedToken(env, target.token.id)).revokedAt, null);
  });

  test("key scopes on the data endpoints: datasets, and sensitive fields only with fabric.sensitive.read", async () => {
    // A fresh app: issuing is limited to 20 keys an hour per administrator.
    const env = await boot();
    try {
    const key = async (scopes) => { const res = await issue(env, people.a1, { scopes }); assert.equal(res.status, 201, res.text); return res.body.secret; };
    const salesOnly = await key([SALES]), inventoryOnly = await key([INVENTORY]), both = await key([SALES, INVENTORY]);
    const salesSensitive = await key([SALES, SENSITIVE]), inventorySensitive = await key([INVENTORY, SENSITIVE]), all = await key([SALES, INVENTORY, SENSITIVE]);
    const ok = async (secret, path) => { const r = await call(env, secret, path); assert.equal(r.status, 200, `${path} ${r.text}`); return r; };
    const refused = async (secret, path, expected) => { const r = await call(env, secret, path); assert.equal(code(r), expected, `${path} ${r.text}`); };

    await ok(salesOnly, "/fabric/sales/records"); await refused(salesOnly, "/fabric/inventory/records", "INSUFFICIENT_SCOPE"); await refused(salesOnly, "/fabric/inventory/schema", "INSUFFICIENT_SCOPE");
    await ok(inventoryOnly, "/fabric/inventory/records"); await refused(inventoryOnly, "/fabric/sales/records", "INSUFFICIENT_SCOPE");
    await ok(both, "/fabric/sales/records"); await ok(both, "/fabric/inventory/records");

    // Without fabric.sensitive.read (the creator CAN read sensitive fields): absent from schema, records and detail; refused in
    // fields, as filters and as sorts like unknown names.
    for (const [secret, ds, sens] of [[both, "sales", SALES_SENSITIVE], [both, "inventory", INV_SENSITIVE], [salesOnly, "sales", SALES_SENSITIVE], [inventoryOnly, "inventory", INV_SENSITIVE]]) {
      const schema = await ok(secret, `/fabric/${ds}/schema`);
      assert.ok(!schema.body.fields.some((f) => f.sensitive), `${ds} schema`);
      const list = await ok(secret, `/fabric/${ds}/records`);
      const detail = await ok(secret, `/fabric/${ds}/records/${list.body.items[0].id}`);
      for (const text of [schema.text, list.text, detail.text]) assert.ok(!/landed_cost|Cost_Amount|distributors_price|trade_price/.test(text), ds);
      await refused(secret, `/fabric/${ds}/records?${sens}`, "VALIDATION_ERROR");
      const field = ds === "sales" ? "landed_cost" : "Cost_Amount_Actual";
      await refused(secret, `/fabric/${ds}/records?sort=${field}`, "VALIDATION_ERROR");
      await refused(secret, `/fabric/${ds}/records?${field}=1`, "VALIDATION_ERROR");
      const searched = await call(env, secret, `/fabric/${ds}/records?q=2.5`);
      assert.ok(!/landed_cost|Cost_Amount/.test(searched.text), "a search never returns sensitive fields");
    }
    // With fabric.sensitive.read: present (still never a filter or a sort).
    for (const [secret, ds, sens, field] of [[all, "sales", SALES_SENSITIVE, "landed_cost"], [all, "inventory", INV_SENSITIVE, "Cost_Amount_Actual"], [salesSensitive, "sales", SALES_SENSITIVE, "landed_cost"], [inventorySensitive, "inventory", INV_SENSITIVE, "Cost_Amount_Actual"]]) {
      const schema = await ok(secret, `/fabric/${ds}/schema`);
      assert.ok(schema.body.fields.some((f) => f.sensitive && f.name === field), `${ds} schema`);
      const list = await ok(secret, `/fabric/${ds}/records?${sens}`);
      assert.ok(list.body.items.every((i) => field in i.values), ds);
      await refused(secret, `/fabric/${ds}/records?sort=${field}`, "VALIDATION_ERROR");
    }
    await refused(salesSensitive, "/fabric/inventory/records", "INSUFFICIENT_SCOPE");
    await refused(inventorySensitive, "/fabric/sales/records", "INSUFFICIENT_SCOPE");
    } finally { await env.close(); }
  });

  test("expired and revoked keys are refused; Fabric keys are read-only", async () => {
    const made = (await issue(env, people.a2)).body;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await call(env, made.secret, "/fabric/sales/records", { method })).status, 405, method);
    await env.db.collection(COLLECTIONS.apiTokens).updateOne({ _id: new ObjectId(made.token.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.deepEqual([(await call(env, made.secret, "/fabric/status")).status, code(await call(env, made.secret, "/fabric/status"))], [401, "TOKEN_EXPIRED"]);
    assert.equal((await env.as(people.a2, "GET", TOKENS)).body.tokens.find((t) => t.id === made.token.id).status, "expired");
  });

  test("Fabric keys never reach the JARC board API, and JARC board keys never reach Fabric", async () => {
    const ws = await env.as(people.boardAdmin, "POST", "/api/v1/workspaces", { name: "Synthetic" });
    const board = await env.as(people.boardAdmin, "POST", `/api/v1/workspaces/${ws.body.workspace.id}/boards`, { name: "Alpha", columns: [{ key: "serial", label: "Item", type: "text" }] });
    const boardKey = await env.as(people.boardAdmin, "POST", "/api/v1/me/api-tokens", { name: "Board BI", workspaceId: ws.body.workspace.id, boardIds: [board.body.board.id], scopes: ["read"], expiresAt: inDays(30) });
    assert.equal(boardKey.status, 201, boardKey.text);
    const fabricKey = (await issue(env, people.owner, { scopes: [SALES, INVENTORY, SENSITIVE] })).body;
    for (const path of ["/me", "/workspaces", `/boards/${board.body.board.id}`, `/workspaces/${ws.body.workspace.id}/boards`]) {
      const res = await call(env, fabricKey.secret, path);
      assert.deepEqual([res.status, code(res)], [403, "INSUFFICIENT_SCOPE"], path);
    }
    for (const path of ["/fabric/status", "/fabric/sales/records", "/fabric/inventory/records"]) {
      const res = await call(env, boardKey.body.secret, path);
      assert.deepEqual([res.status, code(res)], [403, "INSUFFICIENT_SCOPE"], path);
    }
    // A board key's ID doesn't exist on the Fabric screens (even for the owner's oversight), nor a Fabric key's on the board ones.
    assert.equal((await env.as(people.owner, "POST", `${TOKENS}/${boardKey.body.token.id}/revoke`)).status, 404);
    assert.ok(!(await env.as(people.owner, "GET", TOKENS)).body.tokens.some((t) => t.id === boardKey.body.token.id));
    assert.equal((await env.as(people.boardAdmin, "POST", `/api/v1/me/api-tokens/${fabricKey.token.id}/revoke`)).status, 404);
    // Fabric session routes refuse any bearer key.
    const bearer = await env.as(people.owner, "GET", "/api/v1/fabric/status", undefined, { headers: { Authorization: `Bearer ${fabricKey.secret}` } });
    assert.deepEqual([bearer.status, code(bearer)], [401, "UNAUTHENTICATED"]);
  });

  test("nothing about a key reaches the logs", () => {
    assert.ok(!env.logger.errors.concat(env.logger.warnings).join(" ").includes("jarc_"));
  });
});

describe("Existing keys and changed permissions (rebuilt over the same database)", () => {
  test("keys issued before the change keep their scopes (never gaining sensitive) and keep working; unset oversight = own keys only", async () => {
    // Today's production shape: one person in every list, FABRIC_API_OVERSIGHT_OIDS unset.
    const today = targetEnv({ FABRIC_DATA_READER_OIDS: oids(people.owner), FABRIC_DATA_COST_READER_OIDS: oids(people.owner), FABRIC_API_ADMIN_OIDS: oids(people.owner), FABRIC_API_OVERSIGHT_OIDS: undefined });
    const first = await boot({ env: today });
    let plain, sensitive;
    try {
      plain = (await issue(first, people.owner, { scopes: [SALES] })).body;
      sensitive = (await issue(first, people.owner, { scopes: [SALES, INVENTORY, SENSITIVE] })).body;
      const list = await first.as(people.owner, "GET", TOKENS);
      assert.equal(list.body.scope, "own", "unset oversight: nobody oversees, the owner still sees their own keys");
      assert.ok([plain, sensitive].every((k) => list.body.tokens.some((t) => t.id === k.token.id)));
    } finally { await first.close(); }

    const target = await boot({ fake: first.fake });
    try {
      assert.deepEqual((await storedToken(target, plain.token.id)).scopes, [SALES], "no scope is added");
      assert.deepEqual((await storedToken(target, sensitive.token.id)).scopes, [SALES, INVENTORY, SENSITIVE]);
      assert.deepEqual((await call(target, plain.secret, "/fabric/status")).body.access, { datasets: ["sales"], sensitive: false });
      assert.equal(code(await call(target, plain.secret, `/fabric/sales/records?${SALES_SENSITIVE}`)), "VALIDATION_ERROR");
      assert.equal((await call(target, sensitive.secret, `/fabric/inventory/records?${INV_SENSITIVE}`)).status, 200);
      const all = await target.as(people.owner, "GET", TOKENS);
      assert.equal(all.body.scope, "all");
      const listed = all.body.tokens.find((t) => t.id === plain.token.id);
      assert.deepEqual([listed.scopes, listed.sensitive, listed.status], [[SALES], false, "active"]);
      // The new administrators don't see them.
      for (const p of [people.a1, people.a2]) assert.ok(!(await target.as(p, "GET", TOKENS)).body.tokens.some((t) => t.id === plain.token.id || t.id === sensitive.token.id), p.name);
    } finally { await target.close(); }
  });

  test("losing rights: no sensitive grant without the cost list; no management without the admin list; nothing without the reader list", async () => {
    const first = await boot();
    let key;
    try { key = (await issue(first, people.a1, { scopes: [SALES, INVENTORY, SENSITIVE] })).body; } finally { await first.close(); }

    // a1 removed from FABRIC_DATA_COST_READER_OIDS (still an administrator).
    const noCost = await boot({ fake: first.fake, env: targetEnv({ FABRIC_DATA_COST_READER_OIDS: oids(people.owner, people.a2, people.readerCost) }) });
    try {
      assert.equal((await noCost.as(people.a1, "GET", "/api/v1/features")).body.features.fabricData.canGrantSensitive, false);
      for (const scopes of [[SALES, SENSITIVE], [INVENTORY, SENSITIVE], [SALES, INVENTORY, SENSITIVE]]) {
        const res = await issue(noCost, people.a1, { scopes });
        assert.deepEqual([res.status, code(res)], [403, "FABRIC_SENSITIVE_ACCESS_REQUIRED"], "the server refuses it, whatever the UI showed");
      }
      assert.equal((await issue(noCost, people.a1, { scopes: [SALES] })).status, 201);
      assert.equal(code(await call(noCost, key.secret, `/fabric/inventory/records?${INV_SENSITIVE}`)), "VALIDATION_ERROR", "the existing key loses sensitive fields at use");
      assert.deepEqual((await call(noCost, key.secret, "/fabric/status")).body.access, { datasets: ["sales", "inventory"], sensitive: false });
      assert.deepEqual((await storedToken(noCost, key.token.id)).scopes, [SALES, INVENTORY, SENSITIVE], "the stored scopes are unchanged");
    } finally { await noCost.close(); }

    // a1 removed from FABRIC_API_ADMIN_OIDS (still a reader): the key keeps working; a1 can't manage it; the owner can.
    const noAdmin = await boot({ fake: first.fake, env: targetEnv({ FABRIC_API_ADMIN_OIDS: oids(people.owner, people.a2) }) });
    try {
      assert.equal((await call(noAdmin, key.secret, "/fabric/status")).status, 200);
      for (const [method, path] of [["GET", TOKENS], ["GET", `${TOKENS}/activity`], ["POST", `${TOKENS}/${key.token.id}/revoke`]]) {
        assert.equal(code(await noAdmin.as(people.a1, method, path)), "FABRIC_API_ADMIN_REQUIRED", `${method} ${path}`);
      }
      assert.ok((await noAdmin.as(people.owner, "GET", TOKENS)).body.tokens.some((t) => t.id === key.token.id && t.status === "active"));
    } finally { await noAdmin.close(); }

    // a1 removed from every list: the key is refused at use and listed as no_access to the owner.
    const removed = await boot({ fake: first.fake, env: targetEnv({ FABRIC_DATA_READER_OIDS: oids(people.owner, people.a2, people.readerCost, people.readerPlain), FABRIC_DATA_COST_READER_OIDS: oids(people.owner, people.a2, people.readerCost), FABRIC_API_ADMIN_OIDS: oids(people.owner, people.a2) }) });
    try {
      assert.deepEqual([(await call(removed, key.secret, "/fabric/status")).status, code(await call(removed, key.secret, "/fabric/status"))], [403, "TOKEN_ACCESS_REVOKED"]);
      assert.equal((await removed.as(people.owner, "GET", TOKENS)).body.tokens.find((t) => t.id === key.token.id).status, "no_access");
      const revoke = await removed.as(people.owner, "POST", `${TOKENS}/${key.token.id}/revoke`);
      assert.deepEqual([revoke.status, revoke.body.token.status], [200, "revoked"]);
    } finally { await removed.close(); }
  });

  test("oversight follows the list: a person removed from FABRIC_API_OVERSIGHT_OIDS sees only their own keys again", async () => {
    const first = await boot();
    let theirs;
    try { theirs = (await issue(first, people.a2)).body; } finally { await first.close(); }
    const noOversight = await boot({ fake: first.fake, env: targetEnv({ FABRIC_API_OVERSIGHT_OIDS: "" }) });
    try {
      const list = await noOversight.as(people.owner, "GET", TOKENS);
      assert.equal(list.body.scope, "own");
      assert.ok(!list.body.tokens.some((t) => t.id === theirs.token.id));
      assert.equal((await noOversight.as(people.owner, "POST", `${TOKENS}/${theirs.token.id}/revoke`)).status, 404);
      assert.equal((await noOversight.as(people.owner, "GET", `${TOKENS}/activity`)).body.scope, "own");
      assert.equal((await noOversight.as(people.owner, "GET", "/api/v1/features")).body.features.fabricData.apiOversight, false);
    } finally { await noOversight.close(); }
  });
});
