// Employee Management wired into the real app (app.js): createApp({ employees }) with employees = createEmployees(...) mounts
// /api/v1/admin/employees and adds features.employees { view, admin, datasets }. Skipped until app.js accepts the option (the
// coordinator wires it). Synthetic people and the read-only fake source only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { startApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FakeMongoClient } = require("./support/fake-mongo");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { createEmployees } = require("../src/employees");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const appSource = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const wired = /function createApp\(\{[^)]*\bemployees\b/.test(appSource);
const BASE = "/api/v1/admin/employees";

async function start({ issuer, employeesFor }) {
  const fake = new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const logger = { errors: [], error(...args) { this.errors.push(args.map(String).join(" ")); }, warn() {}, info() {} };
  const dataLayer = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), environment: "test" });
  const { createEntraVerifier } = require("../src/auth/entra-token");
  const verify = createEntraVerifier({ ...issuer.config, keySet: issuer.keySet });
  const employees = employeesFor ? employeesFor(issuer.config.tenantId) : null;
  const started = await startApp({ dataLayer, auth: { mode: "entra", entra: issuer.config, verify }, logger, ...(employees ? { employees } : {}) });
  const as = async (client, method, p, body, options) => client.request(method, p, body, options);
  return { ...started, as, close: async () => { await started.close(); await employees?.close(); } };
}
const signedIn = async (url, origin, person) => { const c = new SessionClient(url, origin); assert.equal((await c.signIn(person)).status, 201); return c; };

describe("createApp({ employees })", { skip: wired ? false : "app.js doesn't accept the employees option yet (the coordinator wires it)" }, () => {
  let issuer, persons, on, off;
  before(async () => {
    issuer = await createTokenIssuer();
    persons = { owner: issuer.person("Synthetic Owner"), viewer: issuer.person("Synthetic Viewer"), outsider: issuer.person("Synthetic Outsider", { admin: true }) };
    on = await start({ issuer, employeesFor: (tenantId) => {
      const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId, viewerObjectIds: [persons.viewer.oid], adminObjectIds: [persons.owner.oid] }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
      return createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs: syntheticPeople(20) }), idKey: TEST_ID_KEY, logger: { info() {}, warn() {}, error() {} } });
    } });
    off = await start({ issuer });
  });
  after(async () => { await on?.close(); await off?.close(); });

  test("mounted at /api/v1/admin/employees for listed people only", async () => {
    const origin = issuer.config.appOrigin;
    const owner = await signedIn(on.url, origin, persons.owner), viewer = await signedIn(on.url, origin, persons.viewer), outsider = await signedIn(on.url, origin, persons.outsider);
    assert.equal((await fetch(`${on.url}${BASE}/status`)).status, 401);
    assert.equal((await on.as(owner, "GET", `${BASE}/status`)).status, 200);
    assert.equal((await on.as(owner, "GET", `${BASE}/guests/records`)).status, 200);
    assert.equal((await on.as(viewer, "GET", `${BASE}/active/records`)).status, 200);
    assert.equal((await on.as(viewer, "GET", `${BASE}/all/records`)).status, 403);
    const denied = await on.as(outsider, "GET", `${BASE}/status`);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "EMPLOYEES_FORBIDDEN");
    const sf = await on.as(viewer, "POST", `${BASE}/saved-filters/active`, { name: "Mine", state: {} });
    assert.equal(sf.status, 201);
  });

  test("/features: employees { view, admin, datasets } for this caller", async () => {
    const origin = issuer.config.appOrigin;
    const flag = async (person) => (await (await signedIn(on.url, origin, person)).request("GET", "/api/v1/features")).body.features.employees;
    assert.deepEqual(await flag(persons.owner), { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"] });
    assert.deepEqual(await flag(persons.viewer), { view: true, admin: false, datasets: ["active"] });
    assert.deepEqual(await flag(persons.outsider), { view: false, admin: false, datasets: [] });
  });

  test("switched off: no paths, no flag", async () => {
    const owner = await signedIn(off.url, issuer.config.appOrigin, persons.owner);
    assert.equal((await off.as(owner, "GET", `${BASE}/status`)).status, 404);
    const features = (await off.as(owner, "GET", "/api/v1/features")).body.features;
    assert.ok(!Object.hasOwn(features, "employees"));
  });
});
