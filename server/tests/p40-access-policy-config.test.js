// P4-0 hardening: ACCESS_POLICY, JARC_BETA_OPEN_EDITING and ACCOUNT_MANAGEMENT accept only their documented values. An
// unknown value (another spelling, case or surrounding spaces) stops startup with a ConfigError that names the variable and the
// allowed values, never the value that was set or any secret. Before P4-0 an unknown ACCESS_POLICY fell back to role_based
// silently, so a typo in a rollback value would have switched shared access off.
// The effective access configuration is shown to JARC administrators on System Health and in one startup log line; never to
// System Health viewers, other employees or anonymous callers. Offline: fake MongoDB, local Entra test keys, synthetic people.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadConfig } = require("../src/config");
const { SessionClient, startApp } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FakeMongoClient } = require("./support/fake-mongo");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { createEntraVerifier } = require("../src/auth/entra-token");
const { Monitor } = require("../src/monitoring/monitor");

// Placeholder secrets: they must never appear in an error message.
const SECRET_PASSWORD = "SyntheticP4ssw0rdNeverShown";
const ENTRA_ENV = {
  DATA_STORE: "mongodb", MONGODB_URI: `mongodb+srv://user:${SECRET_PASSWORD}@cluster.invalid/?retryWrites=true`, MONGODB_DB_NAME: "jarc_database", AUTH_MODE: "entra",
  ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111", ENTRA_SPA_CLIENT_ID: "22222222-2222-4222-8222-222222222222", ENTRA_REDIRECT_URI: "https://jarc.example.invalid/"
};
// The production shape (placeholder IDs): shared access with beta open editing, Account Management unset.
const PROD = { ...ENTRA_ENV, NODE_ENV: "production", HOST: "0.0.0.0", PORT: "8080", ACCESS_POLICY: "development_shared", JARC_BETA_OPEN_EDITING: "true" };

const INVALID_POLICIES = ["role-based", "Development_Shared", "shared", " development_shared ", "development_shared ", "ROLE_BASED", "true", "open"];
const INVALID_BETA = ["TRUE", "True", "1", "0", "yes", "on", " true", "true ", "off"];
const INVALID_ACCOUNTS = ["Staged", "OFF", " staged", "on", "true", "observation"];

// The error is a ConfigError naming the variable and its allowed values, and carries neither the value nor any secret.
function assertRefused(env, variable, allowed, badValue) {
  let error = null;
  try { loadConfig(env); } catch (e) { error = e; }
  assert.ok(error, `${variable}=${JSON.stringify(badValue)} must stop startup`);
  assert.equal(error.name, "ConfigError", JSON.stringify(badValue));
  assert.ok(error.message.includes(variable), error.message);
  for (const value of allowed) assert.ok(error.message.includes(value), `${error.message} names ${value}`);
  assert.ok(!error.message.includes(SECRET_PASSWORD) && !/mongodb(\+srv)?:\/\//.test(error.message), "no connection string");
  // (Skipped when the bad value is itself part of an allowed value, e.g. "shared" in development_shared.)
  if (badValue.trim().length > 2 && !allowed.some((value) => value.toLowerCase().includes(badValue.trim().toLowerCase()))) assert.ok(!error.message.includes(badValue.trim()), `the bad value is not echoed: ${error.message}`);
}

describe("ACCESS_POLICY values", () => {
  test("missing or empty → role_based (the documented default)", () => {
    assert.equal(loadConfig(ENTRA_ENV).accessPolicy, "role_based");
    assert.equal(loadConfig({ ...ENTRA_ENV, ACCESS_POLICY: "" }).accessPolicy, "role_based");
    assert.equal(loadConfig({}).accessPolicy, "role_based", "the plain development defaults");
  });
  test("each valid value is used as is", () => {
    assert.equal(loadConfig({ ...ENTRA_ENV, ACCESS_POLICY: "role_based" }).accessPolicy, "role_based");
    assert.equal(loadConfig({ ...ENTRA_ENV, ACCESS_POLICY: "development_shared" }).accessPolicy, "development_shared");
  });
  test("an unknown value (spelling, case, spaces) stops startup in every environment, with a clear message", () => {
    for (const NODE_ENV of ["development", "test", "production"]) {
      for (const value of INVALID_POLICIES) assertRefused({ ...ENTRA_ENV, NODE_ENV, ACCESS_POLICY: value }, "ACCESS_POLICY", ["role_based", "development_shared"], value);
    }
  });
  test("the config no longer carries the old accessPolicyIgnored flag", () => {
    assert.ok(!Object.hasOwn(loadConfig(ENTRA_ENV), "accessPolicyIgnored"));
  });
});

describe("JARC_BETA_OPEN_EDITING values", () => {
  test("missing, empty or false → off; true → on", () => {
    assert.equal(loadConfig(ENTRA_ENV).betaOpenEditing, false);
    for (const [value, expected] of [["", false], ["false", false], ["true", true]]) assert.equal(loadConfig({ ...ENTRA_ENV, JARC_BETA_OPEN_EDITING: value }).betaOpenEditing, expected, value);
  });
  test("anything else stops startup", () => {
    for (const value of INVALID_BETA) assertRefused({ ...ENTRA_ENV, JARC_BETA_OPEN_EDITING: value }, "JARC_BETA_OPEN_EDITING", ["true", "false"], value);
  });
});

describe("ACCOUNT_MANAGEMENT values (already strict before P4-0; the message now says unset means off)", () => {
  test("missing or empty → off; off and staged accepted (enforced outside production)", () => {
    assert.equal(loadConfig(ENTRA_ENV).accounts.mode, "off");
    for (const value of ["", "off"]) assert.equal(loadConfig({ ...ENTRA_ENV, ACCOUNT_MANAGEMENT: value }).accounts.mode, "off", value);
    assert.equal(loadConfig({ ...ENTRA_ENV, ACCOUNT_MANAGEMENT: "staged" }).accounts.mode, "staged");
    assert.equal(loadConfig({ ...ENTRA_ENV, ACCOUNT_MANAGEMENT: "enforced" }).accounts.mode, "enforced");
    assert.throws(() => loadConfig({ ...PROD, ACCOUNT_MANAGEMENT: "enforced" }), /not approved for production/, "unchanged: enforced is refused in production");
  });
  test("anything else stops startup", () => {
    for (const value of INVALID_ACCOUNTS) assertRefused({ ...ENTRA_ENV, ACCOUNT_MANAGEMENT: value }, "ACCOUNT_MANAGEMENT", ["off", "staged", "enforced"], value);
  });
});

describe("the production combination", () => {
  test("ACCESS_POLICY=development_shared + JARC_BETA_OPEN_EDITING=true (+ ACCOUNT_MANAGEMENT unset or staged) starts unchanged", () => {
    const c = loadConfig(PROD);
    assert.deepEqual([c.nodeEnv, c.authMode, c.accessPolicy, c.betaOpenEditing, c.accounts.mode, c.enableDevStateApi, c.enableDevResourceApi], ["production", "entra", "development_shared", true, "off", false, false]);
    assert.equal(loadConfig({ ...PROD, ACCOUNT_MANAGEMENT: "staged" }).accounts.mode, "staged");
    assert.equal(loadConfig({ ...PROD, ACCOUNT_MANAGEMENT: "" }).accounts.mode, "off");
  });
  test("the documented rollback (ACCESS_POLICY=role_based, beta false or removed) starts; a typo in it is refused, not guessed", () => {
    for (const rollback of [{ ACCESS_POLICY: "role_based", JARC_BETA_OPEN_EDITING: "false" }, { ACCESS_POLICY: "", JARC_BETA_OPEN_EDITING: "" }, { ACCESS_POLICY: undefined, JARC_BETA_OPEN_EDITING: undefined }]) {
      const c = loadConfig({ ...PROD, ...rollback });
      assert.deepEqual([c.accessPolicy, c.betaOpenEditing], ["role_based", false], JSON.stringify(rollback));
    }
    assert.throws(() => loadConfig({ ...PROD, ACCESS_POLICY: "role-based" }), /ACCESS_POLICY must be/);
    assert.throws(() => loadConfig({ ...PROD, ACCESS_POLICY: "development-shared" }), /ACCESS_POLICY must be/);
  });
});

describe("startup (src/server.js, refused before anything connects or listens)", () => {
  // Run without --env-file and with an explicit environment, so server/.env is never read. The invalid value stops loadConfig
  // before MongoDB is contacted or a port is opened.
  const run = (extra) => spawnSync(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
    env: { SystemRoot: process.env.SystemRoot || "", ...ENTRA_ENV, NODE_ENV: "production", HOST: "127.0.0.1", PORT: "0", ...extra },
    encoding: "utf8", timeout: 20000
  });
  test("an unknown ACCESS_POLICY exits 1 with the configuration error, without the value or the connection string", () => {
    const r = run({ ACCESS_POLICY: "Development_Shared", JARC_BETA_OPEN_EDITING: "true" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /JARC Database server did not start: ACCESS_POLICY must be role_based or development_shared/);
    assert.ok(!r.stderr.includes("Development_Shared") && !r.stderr.includes(SECRET_PASSWORD) && !/mongodb\+srv:/.test(r.stderr + r.stdout));
    assert.equal(r.stdout, "", "nothing was started");
  });
  test("an unknown JARC_BETA_OPEN_EDITING exits 1 the same way", () => {
    const r = run({ ACCESS_POLICY: "development_shared", JARC_BETA_OPEN_EDITING: "TRUE" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /JARC_BETA_OPEN_EDITING must be true or false/);
    assert.ok(!r.stderr.includes(SECRET_PASSWORD));
  });
});

describe("System Health shows the effective access configuration to administrators only (real app)", () => {
  let issuer, P, app;
  const clients = new Map();
  const as = async (k, method, url) => {
    if (k === "signedOut") return new SessionClient(app.url, issuer.config.appOrigin).request(method, url);
    if (!clients.has(k)) { const c = new SessionClient(app.url, issuer.config.appOrigin); assert.equal((await c.signIn(P[k])).status, 201); clients.set(k, c); }
    return clients.get(k).request(method, url);
  };

  before(async () => {
    issuer = await createTokenIssuer();
    P = { admin: issuer.person("Synthetic Admin", { admin: true }), viewer: issuer.person("Synthetic Viewer"), plain: issuer.person("Synthetic Plain") };
    const fake = new FakeMongoClient();
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
    await connection.connect();
    await ensureDatabase(connection.db);
    const logger = { errors: [], error() {}, warn() {}, info() {} };
    const dataLayer = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), environment: "test" });
    app = await startApp({
      dataLayer, logger, monitor: new Monitor({ slowCommandMs: 10 }), accessPolicy: "development_shared", betaOpenEditing: true, accounts: { mode: "off", superAdmin: null },
      auth: { mode: "entra", entra: issuer.config, verify: createEntraVerifier({ ...issuer.config, keySet: issuer.keySet }) },
      systemHealth: { viewerObjectIds: [P.viewer.oid] }
    });
  });
  after(async () => { await app?.close(); });

  test("a JARC administrator sees policy, betaOpenEditing and accountMode (mode names only)", async () => {
    const h = await as("admin", "GET", "/api/v1/admin/system-health");
    assert.equal(h.status, 200);
    assert.equal(h.body.scope, "admin");
    assert.deepEqual(h.body.access, { policy: "development_shared", betaOpenEditing: true, accountMode: "off", shared: true });
  });
  test("a System Health viewer gets the redacted view without it; other employees 403; signed out 401", async () => {
    const v = await as("viewer", "GET", "/api/v1/admin/system-health");
    assert.equal(v.status, 200);
    assert.equal(v.body.scope, "viewer");
    assert.ok(!Object.hasOwn(v.body, "access"));
    assert.ok(!/development_shared|betaOpenEditing|accountMode/.test(v.text));
    const plain = await as("plain", "GET", "/api/v1/admin/system-health");
    assert.equal(plain.status, 403);
    assert.ok(!/development_shared|betaOpenEditing/.test(plain.text));
    const anon = await as("signedOut", "GET", "/api/v1/admin/system-health");
    assert.equal(anon.status, 401);
    assert.ok(!/development_shared|betaOpenEditing/.test(anon.text));
  });
});
