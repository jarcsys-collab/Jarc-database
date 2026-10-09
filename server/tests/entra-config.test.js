// Stage 12C: AUTH_MODE configuration, production fail-closed behaviour and development-mode compatibility.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../src/config");
const { createApp } = require("../src/app");
const { startApp, startMongoApp, startEntraApp, SessionClient, entraEnv, TEST_ENTRA } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

const prod = (extra = {}) => ({ NODE_ENV: "production", ...extra });

describe("AUTH_MODE configuration", () => {
  test("development defaults to AUTH_MODE=dev with no Entra settings", () => {
    const config = loadConfig({});
    assert.deepEqual([config.authMode, config.entra], ["dev", null]);
  });

  test("AUTH_MODE=entra needs only the tenant, the SPA client ID and the redirect URI (no API app, no secret)", () => {
    const config = loadConfig(entraEnv({ ENTRA_REDIRECT_URI: "http://localhost:3000/", ENTRA_TENANT_ID: TEST_ENTRA.ENTRA_TENANT_ID.toUpperCase() }));
    assert.equal(config.authMode, "entra");
    assert.equal(config.entra.tenantId, TEST_ENTRA.ENTRA_TENANT_ID);
    assert.equal(config.entra.clientId, TEST_ENTRA.ENTRA_SPA_CLIENT_ID);
    assert.equal(config.entra.redirectUri, "http://localhost:3000/");
    assert.equal(config.entra.appOrigin, "http://localhost:3000");
    assert.deepEqual([config.entra.adminRole, config.entra.sessionIdleMinutes, config.entra.sessionMaxHours], ["JARC.Admin", 30, 8]);
    assert.equal(config.enableDevResourceApi, false, "Entra mode never uses the development user");
    assert.ok(!Object.keys(config.entra).some((k) => /secret|api/i.test(k)));
  });

  test("unknown AUTH_MODE is rejected", () => assert.throws(() => loadConfig({ AUTH_MODE: "basic" }), /AUTH_MODE must be one of: dev, entra/));

  test("every required Entra setting is listed by name when missing", () => {
    for (const name of ["ENTRA_TENANT_ID", "ENTRA_SPA_CLIENT_ID", "ENTRA_REDIRECT_URI"]) {
      assert.throws(() => loadConfig(entraEnv({ [name]: "" })), (e) => e.name === "ConfigError" && e.message.includes(name), name);
    }
  });

  test("Entra sign-in needs MongoDB (sessions live in jarc_database)", () => {
    assert.throws(() => loadConfig(entraEnv({ DATA_STORE: "memory" })), /AUTH_MODE=entra needs DATA_STORE=mongodb/);
  });

  test("malformed settings are rejected", () => {
    const cases = [
      [{ ENTRA_TENANT_ID: "contoso.onmicrosoft.com" }, /ENTRA_TENANT_ID must be a GUID/],
      [{ ENTRA_SPA_CLIENT_ID: "jarc-spa" }, /ENTRA_SPA_CLIENT_ID must be a GUID/],
      [{ ENTRA_REDIRECT_URI: "not a url" }, /full URL/],
      [{ ENTRA_REDIRECT_URI: "http://jarc.example.invalid/" }, /must use https/],
      [{ ENTRA_REDIRECT_URI: "http://127.0.0.1:3000/" }, /must use https/],
      [{ ENTRA_ADMIN_ROLE: "JARC Admin; drop" }, /ENTRA_ADMIN_ROLE/],
      [{ SESSION_IDLE_MINUTES: "0" }, /SESSION_IDLE_MINUTES must be a whole number from 5 to 480/],
      [{ SESSION_MAX_HOURS: "48" }, /SESSION_MAX_HOURS must be a whole number from 1 to 24/]
    ];
    for (const [overrides, message] of cases) assert.throws(() => loadConfig(entraEnv(overrides)), message, JSON.stringify(overrides));
  });
});

describe("Production fails closed", () => {
  test("production without AUTH_MODE=entra does not start", () => {
    for (const mode of [undefined, "dev", "", "ENTRA"]) assert.throws(() => loadConfig(prod(mode === undefined ? {} : { AUTH_MODE: mode })), /Production requires AUTH_MODE=entra/, String(mode));
  });
  test("production with AUTH_MODE=entra but incomplete settings does not start", () => {
    assert.throws(() => loadConfig(prod({ AUTH_MODE: "entra" })), /AUTH_MODE=entra needs ENTRA_TENANT_ID, ENTRA_SPA_CLIENT_ID, ENTRA_REDIRECT_URI/);
  });
  test("production refuses a localhost redirect URI", () => {
    assert.throws(() => loadConfig(entraEnv(prod({ ENTRA_REDIRECT_URI: "http://localhost:3000/" }))), /localhost address in production/);
    assert.throws(() => loadConfig(entraEnv(prod({ ENTRA_REDIRECT_URI: "https://localhost/" }))), /localhost address in production/);
  });
  test("valid production Entra config: no development APIs at all", () => {
    const config = loadConfig(entraEnv(prod()));
    assert.deepEqual([config.authMode, config.enableDevStateApi, config.enableDevResourceApi], ["entra", false, false]);
  });
  test("createApp refuses development identity in production, and dev + Entra together", async () => {
    const mongo = await startMongoApp();
    try {
      assert.throws(() => createApp({ environment: "production", enableDevStateApi: false, dataLayer: mongo.dataLayer, devActor: mongo.devActor, enableDevResourceApi: true }), /can't be enabled in production/);
      assert.throws(() => createApp({ environment: "production", enableDevStateApi: false, dataLayer: mongo.dataLayer, auth: { mode: "dev", verify() {}, entra: {} } }), /must be Entra ID/);
      assert.throws(() => createApp({ environment: "development", dataLayer: mongo.dataLayer, devActor: mongo.devActor, auth: { mode: "entra", verify() {}, entra: {} }, enableDevResourceApi: true }), /not both/);
    } finally { await mongo.close(); }
  });
  test("a production app with Entra: every protected path needs a session (401, never data); /state is absent", async () => {
    const issuer = await createTokenIssuer();
    const entra = await startEntraApp({ issuer });
    const { createEntraVerifier } = require("../src/auth/entra-token");
    const prodApp = await startApp({ environment: "production", enableDevStateApi: false, repository: null, dataLayer: entra.dataLayer, auth: { mode: "entra", entra: issuer.config, verify: createEntraVerifier({ ...issuer.config, keySet: issuer.keySet }) } });
    try {
      const anonymous = new SessionClient(prodApp.url, issuer.config.appOrigin);
      for (const [method, path] of [["GET", "/api/v1/workspaces"], ["POST", "/api/v1/workspaces"], ["GET", "/api/v1/me"], ["POST", "/api/v1/imports"], ["GET", "/api/v1/boards/aaaaaaaaaaaaaaaaaaaaaaaa/records"], ["PATCH", "/api/v1/records/aaaaaaaaaaaaaaaaaaaaaaaa"], ["GET", "/api/v1/workspaces/aaaaaaaaaaaaaaaaaaaaaaaa/members"], ["GET", "/api/v1/state"]]) {
        assert.equal((await anonymous.request(method, path, method === "GET" ? undefined : {})).status, 401, `${method} ${path}`);
      }
      assert.equal((await anonymous.request("GET", "/api/v1/health")).status, 200);
      assert.equal((await anonymous.request("GET", "/api/v1/auth/config")).body.mode, "entra");
      const signedIn = new SessionClient(prodApp.url, issuer.config.appOrigin);
      assert.equal((await signedIn.signIn(issuer.person("Prod User"))).status, 201);
      assert.equal((await signedIn.request("GET", "/api/v1/workspaces")).status, 200);
      assert.equal((await signedIn.request("GET", "/api/v1/state")).status, 404, "/state isn't served in production");
    } finally { await prodApp.close(); await entra.close(); }
  });
  test("the development actor can't be created or used in production", async () => {
    const { ensureDevelopmentActor, devActorMiddleware } = require("../src/context/dev-actor");
    await assert.rejects(ensureDevelopmentActor({}, { environment: "production" }), /never available in production/);
    assert.throws(() => devActorMiddleware({ _id: 1 }, { environment: "production" }), /never available in production/);
  });
});

describe("Development mode compatibility (AUTH_MODE=dev)", () => {
  test("auth config says dev; /me is the development user (system admin); /state still works; no cookies needed", async () => {
    const dev = await startMongoApp();
    try {
      const c = new SessionClient(dev.url);
      assert.deepEqual((await c.request("GET", "/api/v1/auth/config")).body, { mode: "dev" });
      const me = (await c.request("GET", "/api/v1/me")).body;
      assert.deepEqual([me.authMode, me.isSystemAdmin, me.user.displayName], ["dev", true, "Local developer (pre-auth)"]);
      assert.equal((await c.request("GET", "/api/v1/state")).status, 200);
      const ws = await c.request("POST", "/api/v1/workspaces", { name: "Dev workspace" });
      assert.equal(ws.status, 201);
      assert.equal(c.setCookies.length, 0, "dev mode sets no cookies");
      assert.equal((await c.request("POST", "/api/v1/auth/sign-in/start")).status, 404, "no Entra sign-in routes in dev mode");
    } finally { await dev.close(); }
  });
  test("memory mode (Stage 9) is unchanged: no resource API, /state works, auth config reports dev", async () => {
    const memory = await startApp();
    try {
      const c = new SessionClient(memory.url);
      assert.equal((await c.request("GET", "/api/v1/workspaces")).status, 404);
      assert.equal((await c.request("GET", "/api/v1/me")).status, 404);
      assert.equal((await c.request("GET", "/api/v1/state")).status, 200);
      assert.equal((await c.request("GET", "/api/v1/auth/config")).body.mode, "dev");
    } finally { await memory.close(); }
  });
});
