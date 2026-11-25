// Phase 6 permission matrix, session side: what each person sees on the Fabric Data screens (Inventory, Sales, sensitive fields
// in the grid, the record page and All Fields, and sensitive filters/sorts) under the target configuration. The same people as
// fabric-api-admins.test.js: the owner (oversight), a regular administrator who reads sensitive fields, a sensitive reader who is
// not an administrator, a plain reader, and an employee in no Fabric list. Synthetic identities and data; JARC on its fake
// MongoDB, Fabric on tests/support/fabric-fake.js. Nothing connects to a real database.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createFabricData, fabricLimiter } = require("../src/fabric");
const { loadConfig } = require("../src/config");
const { SessionClient, entraEnv } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FabricFakeClient, row, inventoryRows, startFabricApp, dec } = require("./support/fabric-fake");

const day = (d) => new Date(`2026-03-${String(d).padStart(2, "0")}T08:00:00Z`);
const docs = () => [
  row({ Company: "ALPHA", invoice_id: "1001", Line_No: 10000, invoice_date: day(10), customer_name: "Example Customer One", invoice_item_amount: 10, Unit_Price: dec("5.00"), landed_cost: "2.5" }),
  row({ Company: "BETA", invoice_id: "2002", invoice_date: day(12), customer_name: "Example Customer Two", invoice_item_amount: 7, landed_cost: "1.5" })
];
const SENSITIVE_FIELD = { sales: "landed_cost", inventory: "Cost_Amount_Actual" };
const KEY_FIELD = { sales: "invoice_id", inventory: "Item_No" };
const SENSITIVE_TEXT = /landed_cost|Cost_Amount|distributors_price|trade_price/;
const code = (res) => res.body?.error?.code;

let issuer, people, env, clients;
const oids = (...ps) => ps.map((p) => p.oid).join(",");

before(async () => {
  issuer = await createTokenIssuer();
  people = {
    owner: issuer.person("Ona Owner"), admin: issuer.person("Abe AdminOne"), readerCost: issuer.person("Cy CostReader"),
    readerPlain: issuer.person("Pia PlainReader"), outsider: issuer.person("Olive Outsider")
  };
  const cfg = loadConfig(entraEnv({
    JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb",
    FABRIC_DATA_READER_OIDS: oids(people.owner, people.admin, people.readerCost, people.readerPlain),
    FABRIC_DATA_COST_READER_OIDS: oids(people.owner, people.admin, people.readerCost),
    FABRIC_API_ADMIN_OIDS: oids(people.owner, people.admin),
    FABRIC_API_OVERSIGHT_OIDS: oids(people.owner)
  })).fabricData;
  const client = new FabricFakeClient({ docs: docs(), inventory: { docs: inventoryRows(50) } });
  const stack = { ...createFabricData({ config: cfg, logger: { warn() {}, error() {} }, createClient: () => client }), limiter: fabricLimiter({ perWindow: 10000 }) };
  const app = await startFabricApp({ issuer, fabricData: stack, accessPolicy: "development_shared", betaOpenEditing: true, apiTokens: { key: crypto.randomBytes(32), adminObjectIds: [], issuePerHour: 1000, maxActive: 1000 } });
  env = { app, close: async () => { await app.close(); await stack.close(); } };
  clients = {};
  for (const [name, person] of Object.entries(people)) {
    const c = new SessionClient(app.url, issuer.config.appOrigin);
    assert.equal((await c.signIn(person)).status, 201, name);
    clients[name] = c;
  }
});
after(() => env?.close());

describe("Phase 6 matrix: Fabric Data screens per person (target configuration)", () => {
  test("Fabric access, Inventory and Sales: every reader 200, the unauthorized employee 403 on every route", async () => {
    for (const name of ["owner", "admin", "readerCost", "readerPlain"]) {
      for (const ds of ["sales", "inventory"]) for (const path of [`/${ds}/schema`, `/${ds}/records?limit=5`]) {
        const res = await clients[name].request("GET", `/api/v1/fabric${path}`);
        assert.equal(res.status, 200, `${name} ${path} ${res.text}`);
      }
      assert.equal((await clients[name].request("GET", "/api/v1/fabric/status")).status, 200, name);
    }
    for (const path of ["/status", "/sales/schema", "/sales/records", "/inventory/schema", "/inventory/records"]) {
      const res = await clients.outsider.request("GET", `/api/v1/fabric${path}`);
      assert.deepEqual([res.status, code(res)], [403, "FABRIC_DATA_FORBIDDEN"], path);
      assert.ok(!SENSITIVE_TEXT.test(res.text) && !res.text.includes("ALPHA"));
    }
  });

  test("sensitive fields in the grid (schema + chosen columns), record page and All Fields: owner, admin and cost reader only", async () => {
    for (const ds of ["sales", "inventory"]) {
      const field = SENSITIVE_FIELD[ds];
      const plainSchema = (await clients.readerPlain.request("GET", `/api/v1/fabric/${ds}/schema`)).body;
      for (const name of ["owner", "admin", "readerCost"]) {
        const schema = await clients[name].request("GET", `/api/v1/fabric/${ds}/schema`);
        assert.ok(schema.body.fields.some((f) => f.name === field && f.sensitive), `${name} ${ds} schema lists ${field}, marked`);
        assert.ok(schema.body.fields.length > plainSchema.fields.length, `${name} ${ds}: more fields than a plain reader`);
        const grid = await clients[name].request("GET", `/api/v1/fabric/${ds}/records?limit=5&fields=${KEY_FIELD[ds]},${field}`);
        assert.equal(grid.status, 200, `${name} ${ds} ${grid.text}`);
        assert.ok(grid.body.items.every((i) => field in i.values), `${name} ${ds} grid column`);
        const detail = await clients[name].request("GET", `/api/v1/fabric/${ds}/records/${grid.body.items[0].id}`);
        assert.ok(detail.body.record.fields.some((f) => f.name === field), `${name} ${ds} record / All Fields`);
      }
      // Plain reader: absent everywhere, and refused like an unknown name.
      assert.ok(!plainSchema.fields.some((f) => f.sensitive), `readerPlain ${ds} schema`);
      const list = await clients.readerPlain.request("GET", `/api/v1/fabric/${ds}/records?limit=5`);
      const detail = await clients.readerPlain.request("GET", `/api/v1/fabric/${ds}/records/${list.body.items[0].id}`);
      for (const text of [JSON.stringify(plainSchema), list.text, detail.text]) assert.ok(!SENSITIVE_TEXT.test(text), `readerPlain ${ds}`);
      const chosen = await clients.readerPlain.request("GET", `/api/v1/fabric/${ds}/records?fields=${KEY_FIELD[ds]},${field}`);
      assert.deepEqual([chosen.status, code(chosen)], [400, "VALIDATION_ERROR"], `readerPlain ${ds} column`);
    }
  });

  test("sensitive fields are never a filter or a sort, for any reader", async () => {
    for (const name of ["owner", "admin", "readerCost", "readerPlain"]) for (const ds of ["sales", "inventory"]) {
      const field = SENSITIVE_FIELD[ds];
      for (const query of [`sort=${field}`, `${field}=1`]) {
        const res = await clients[name].request("GET", `/api/v1/fabric/${ds}/records?${query}`);
        assert.deepEqual([res.status, code(res)], [400, "VALIDATION_ERROR"], `${name} ${ds} ${query}`);
      }
      const searched = await clients[name].request("GET", `/api/v1/fabric/${ds}/records?q=2.5`);
      if (name === "readerPlain") assert.ok(!SENSITIVE_TEXT.test(searched.text), "a plain reader's search returns no sensitive field");
    }
  });

  test("/features drives the screens: API Management only for the owner and the admin; oversight only for the owner", async () => {
    const f = async (name) => (await clients[name].request("GET", "/api/v1/features")).body.features.fabricData;
    const pick = (x) => [x.read, x.sensitive, x.apiAdmin, x.apiOversight, x.canGrantSensitive, x.apiTokens];
    assert.deepEqual(pick(await f("owner")), [true, true, true, true, true, true]);
    assert.deepEqual(pick(await f("admin")), [true, true, true, false, true, true]);
    assert.deepEqual(pick(await f("readerCost")), [true, true, false, false, false, true]);
    assert.deepEqual(pick(await f("readerPlain")), [true, false, false, false, false, true]);
    assert.deepEqual(pick(await f("outsider")), [false, false, false, false, false, true]);
  });
});
