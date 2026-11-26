// P4-0 hardening (security review F5): GET /integrations/monday returns the full status (imported boards with their JARC
// IDs and names, the monday.com account, jobs, errors) only to JARC administrators. Every other signed-in person gets the
// connection state only. Entirely offline and synthetic: the mock monday.com from tests/support/mock-monday refuses every
// other URL. Runs with ACCESS_POLICY=development_shared and beta open editing on, so the shared-access setting is shown not
// to grant it.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { startEntraApp, SessionClient, api } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { loadMondayConfig } = require("../src/config");
const { IntegrationWorker } = require("../src/integrations/monday/worker");
const { publicStatus } = require("../src/routes/integrations");
const { mockMonday, ENV } = require("./support/mock-monday");

const STATUS = "/api/v1/integrations/monday";
const PUBLIC_KEYS = ["account", "canManage", "configured", "connected", "enabled", "failed", "importedBoardCount", "importedBoards", "imports", "provider", "state", "sync"];

describe("P4-0: monday.com integration status is limited for non-administrators", () => {
  let app, issuer, admin, member, mock, workspace, boardId, worker;

  before(async () => {
    issuer = await createTokenIssuer();
    mock = mockMonday();
    const ada = issuer.person("Ada Admin", { admin: true });
    // Ada is also a JARC API administrator, so she can issue the API token used in the bearer test.
    app = await startEntraApp({ issuer, monday: loadMondayConfig(ENV), fetch: mock.fetch, accessPolicy: "development_shared", betaOpenEditing: true, apiTokens: { key: crypto.randomBytes(32), issuePerHour: 1000, maxActive: 1000, adminObjectIds: [ada.oid] } });
    admin = new SessionClient(app.url, app.entra.appOrigin); member = new SessionClient(app.url, app.entra.appOrigin);
    assert.equal((await admin.signIn(ada)).status, 201);
    assert.equal((await member.signIn(issuer.person("Mia Member"))).status, 201);
    workspace = (await admin.request("POST", "/api/v1/workspaces", { name: "Synthetic imports" })).body.workspace;
    const service = app.dataLayer.services.integration;
    service.logger = { error() {} };
    worker = new IntegrationWorker({ integration: service, repos: app.dataLayer.repos, logger: { error() {} } });
    // Connect through the mock OAuth flow and import the mock board "Projects" (monday.com ID 111).
    const start = await admin.request("POST", `${STATUS}/connect`);
    const state = new URL(start.body.authorizeUrl).searchParams.get("state");
    const cb = await fetch(`${app.url}${STATUS}/callback?code=auth-code-1&state=${state}`, { redirect: "manual" });
    assert.match(cb.headers.get("location"), /result=connected/);
    assert.equal((await admin.request("POST", `${STATUS}/imports`, { boardIds: ["111"], workspaceId: workspace.id, confirm: true })).status, 202);
    await worker.tick({ max: 20 });
    const job = await app.db.collection("integrationJobs").findOne({ type: "import" });
    assert.equal(job.status, "done");
    boardId = job.progress.boardId.toHexString();
  });
  after(async () => { app.app?.locals?.realtime?.closeAll(); await app.close(); });

  test("a JARC administrator gets the full status, unchanged", async () => {
    const res = await admin.request("GET", STATUS);
    assert.equal(res.status, 200); assert.equal(res.headers.get("cache-control"), "no-store");
    const s = res.body;
    assert.equal(s.canManage, true); assert.equal(s.state, "connected"); assert.equal(s.connected, true);
    assert.equal(s.account.name, "Mock Account");
    assert.equal(s.importedBoards.length, 1);
    assert.equal(s.importedBoards[0].boardId, boardId); assert.equal(s.importedBoards[0].name, "Projects"); assert.equal(s.importedBoards[0].sourceBoardId, "111");
    assert.equal(s.imports[0].status, "done");
    assert.equal(s.importedBoardCount, undefined, "the administrator's body keeps its original shape");
    // Same body the service builds for this administrator.
    const actor = { isSystemAdmin: true };
    assert.deepEqual(Object.keys(s).sort(), Object.keys(await app.dataLayer.services.integration.status(actor)).sort());
  });

  test("an employee (shared access + beta open editing) gets the state only: no board names, IDs, account or jobs", async () => {
    const res = await member.request("GET", STATUS);
    assert.equal(res.status, 200); assert.equal(res.headers.get("cache-control"), "no-store");
    const s = res.body, text = res.text;
    assert.deepEqual(Object.keys(s).sort(), PUBLIC_KEYS);
    assert.equal(s.canManage, false); assert.equal(s.state, "connected"); assert.equal(s.connected, true);
    assert.equal(s.configured, true); assert.equal(s.enabled, true);
    assert.equal(s.importedBoardCount, 1);
    assert.deepEqual(s.importedBoards, []); assert.deepEqual(s.imports, []); assert.deepEqual(s.failed, []);
    assert.equal(s.account, null); assert.equal(s.sync.lastError, null); assert.equal(s.missing, undefined);
    for (const secret of [boardId, "Projects", "111", "Mock Account", "Test Admin", workspace.id]) assert.equal(text.includes(secret), false, `leaked ${secret}`);
    // The employee can still see the imported board through the normal, permission-checked board API (shared access).
    assert.equal((await member.request("GET", `/api/v1/boards/${boardId}`)).status, 200);
  });

  test("an employee still can't manage the integration", async () => {
    for (const [method, path] of [["POST", "/connect"], ["POST", "/disconnect"], ["POST", "/test"], ["GET", "/workspaces"], ["GET", "/boards"], ["GET", "/boards/111/preview"], ["POST", "/sync-now"]]) {
      assert.equal((await member.request(method, `${STATUS}${path}`)).status, 403, path);
    }
    assert.equal((await member.request("POST", `${STATUS}/sync`, { syncEnabled: true })).status, 403);
  });

  test("signed out: 401", async () => {
    const res = await api(app.url, "GET", STATUS);
    assert.equal(res.status, 401);
    assert.equal(JSON.stringify(res.body || {}).includes("Projects"), false);
  });

  test("bearer credentials (API token, Entra ID token, garbage) don't reach the status", async () => {
    const issued = await admin.request("POST", "/api/v1/me/api-tokens", { name: "Synthetic", workspaceId: workspace.id, boardIds: [boardId], scopes: ["read"], expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    const idToken = await issuer.person("Ada Admin", { admin: true }).idToken("n".repeat(32));
    for (const bearer of [issued.body.secret, idToken, "not-a-token"]) {
      const res = await fetch(`${app.url}${STATUS}`, { headers: { Authorization: `Bearer ${bearer}` } });
      assert.ok([401, 403].includes(res.status), `bearer got ${res.status}`);
      const text = await res.text();
      for (const secret of [boardId, "Projects", "Mock Account"]) assert.equal(text.includes(secret), false);
    }
  });

  test("publicStatus is an allow-list: fields added to the full status later don't pass through", () => {
    const full = { provider: "monday", configured: true, enabled: true, canManage: true, missing: ["X"], connected: true, state: "connected", account: { name: "A", user: "U" }, sync: { enabled: true, paused: false, lastSyncAt: "2026-01-01T00:00:00.000Z", lastError: "boom", extra: 1 }, importedBoards: [{ boardId: "b", name: "n", sourceBoardId: "1" }, {}], imports: [{ id: "j" }], failed: [{ id: "f" }], future: "secret" };
    const p = publicStatus(full);
    assert.deepEqual(Object.keys(p).sort(), PUBLIC_KEYS);
    assert.deepEqual(p.sync, { enabled: true, paused: false, lastSyncAt: "2026-01-01T00:00:00.000Z", lastError: null });
    assert.equal(p.importedBoardCount, 2); assert.equal(p.canManage, false);
    assert.equal(JSON.stringify(p).includes("secret") || JSON.stringify(p).includes("boom"), false);
  });
});
