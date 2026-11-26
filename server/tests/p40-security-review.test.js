// P4-0 independent security review: synthetic probes only (no database, no network beyond loopback, no real data).
// 1. REAUTH path matching: for every URL variant that Express 5 routes to a sensitive handler, sensitiveAdminRequest must be true.
// 2. Usable-admin rule (pure) and the JARC administrator refusal matrix.
// 3. Config strictness with today's production values.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { sensitiveAdminRequest, adminFreshUntil } = require("../src/auth/session");
const { usableWorkspaceAdmin, adminRoleHeld } = require("../src/auth/accounts");
const { publicStatus } = require("../src/routes/integrations");
const { loadConfig } = require("../src/config");

describe("REAUTH matcher vs Express 5 routing (mount shape of app.js)", () => {
  let server, base;
  const seen = [];
  before(async () => {
    const app = express();
    const api = express.Router();
    // The first `identify` in app.js is a root mount of the /api/v1 router: record what the matcher decides there.
    api.use((req, res, next) => { req.sensitive = sensitiveAdminRequest(req, "off"); next(); });
    const hit = (name) => (req, res) => { seen.push({ name, url: req.originalUrl, sensitive: req.sensitive }); res.json({ name }); };
    const root = express.Router();
    root.post("/integrations/monday/connect", hit("monday.connect"));
    root.post("/integrations/monday/jobs/:jobId/retry", hit("monday.retry"));
    root.post("/accounts/:userId/block", hit("accounts.block"));
    root.put("/accounts/:userId/workspaces/:workspaceId", hit("accounts.ws"));
    root.post("/accounts/bootstrap", hit("accounts.bootstrap"));
    api.use(root);
    const employees = express.Router();
    const p = "/:ds/records/:id";
    employees.post(`${p}/access`, hit("p3.access"));
    employees.post(`${p}/memberships`, hit("p3.memberships.add"));
    employees.patch(`${p}/memberships/:workspaceRef`, hit("p3.memberships.patch"));
    employees.delete(`${p}/memberships/:workspaceRef`, hit("p3.memberships.delete"));
    api.use("/admin/employees", employees);
    app.use("/api/v1", api);
    app.use((req, res) => res.status(404).end());
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  const send = (method, path) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers: { "content-type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", () => resolve(-1)); req.end(["HEAD", "GET", "OPTIONS"].includes(method) ? undefined : "{}");
  });

  const variants = [
    ["POST", "/api/v1/integrations/monday/connect"], ["POST", "/api/v1/integrations/monday/connect/"], ["POST", "/API/V1/Integrations/Monday/Connect"],
    ["POST", "/api/v1/integrations/monday/%63onnect"], ["POST", "/api/v1/integrations/MONDAY/connect"], ["POST", "/api/v1//integrations/monday/connect"],
    ["POST", "/api/v1/integrations/monday/connect?x=1"], ["POST", "/api/v1/integrations/monday/webhook/../connect"], ["POST", "/api/v1/integrations/monday/jobs/webhook/retry"],
    ["POST", "/api/v1/accounts/abc/block"], ["POST", "/api/v1/Accounts/abc/block/"], ["POST", "/api/v1/accounts/bootstrap"], ["PUT", "/api/v1/ACCOUNTS/a/workspaces/b"],
    ["POST", "/api/v1/admin/employees/all/records/AAAA/access"], ["POST", "/api/v1/admin/employees/all/records/AAAA/access/"], ["POST", "/api/v1/Admin/Employees/all/records/AAAA/ACCESS"],
    ["POST", "/api/v1/admin/employees/a%2Fb/records/AAAA/access"], ["POST", "/api/v1/admin/employees/all/records/AAAA/memberships"], ["POST", "/api/v1/admin/employees/all/records/AAAA/memberships/"],
    ["PATCH", "/api/v1/admin/employees/all/records/AAAA/memberships/ref"], ["DELETE", "/api/v1/admin/employees/all/records/AAAA/memberships/ref/"], ["PATCH", "/api/v1/admin/employees/all/records/AAAA/memberships/r%2Fef"],
    ["POST", "/api/v1/admin/employees/all/records/AAAA/access?y=2"], ["POST", "/api/v1/admin/employees//all/records/AAAA/access"]
  ];
  test("no variant reaches a sensitive handler with the matcher saying false", async () => {
    for (const [m, p] of variants) { seen.length = 0; const code = await send(m, p); if (process.env.P40_TRACE) console.log(m, p, code, seen.map((s) => `${s.name}:${s.sensitive}`).join(",")); for (const s of seen) assert.equal(s.sensitive, true, `${m} ${p} reached ${s.name} unflagged`); }
  });
  test("HEAD / OPTIONS / GET never reach a write handler", async () => {
    for (const m of ["HEAD", "OPTIONS", "GET"]) { seen.length = 0; await send(m, "/api/v1/integrations/monday/connect"); await send(m, "/api/v1/admin/employees/all/records/AAAA/access"); assert.deepEqual(seen, [], m); }
  });
  test("enforced: only /accounts stays flagged", () => {
    assert.equal(sensitiveAdminRequest({ method: "POST", baseUrl: "/api/v1", path: "/accounts/x/block" }, "enforced"), true);
    assert.equal(sensitiveAdminRequest({ method: "POST", baseUrl: "/api/v1", path: "/integrations/monday/connect" }, "enforced"), false);
  });
  test("FIXED: the generic workspace member routes and the legacy state import are now flagged; other workspace writes are not", () => {
    for (const [m, p] of [["POST", "/workspaces/x/members"], ["PATCH", "/workspaces/x/members/y"], ["DELETE", "/workspaces/x/members/y"], ["POST", "/imports"]]) {
      assert.equal(sensitiveAdminRequest({ method: m, baseUrl: "/api/v1", path: p }, "off"), true, `${m} ${p}`);
    }
    assert.equal(sensitiveAdminRequest({ method: "DELETE", baseUrl: "/api/v1", path: "/workspaces/x" }, "off"), false, "DELETE /workspaces/x");
  });
});

describe("freshness and role evidence (pure)", () => {
  test("adminFreshUntil: no claim → null; bad createdAt → epoch (stale)", () => {
    assert.equal(adminFreshUntil({ isSystemAdmin: false, createdAt: new Date() }, 1000), null);
    assert.equal(adminFreshUntil({ isSystemAdmin: "true", createdAt: new Date() }, 1000), null);
    assert.equal(adminFreshUntil({ isSystemAdmin: true }, 1000).getTime(), 0);
  });
  test("adminRoleHeld: string dates (e.g. JSON-injected) never count", () => {
    assert.equal(adminRoleHeld({ adminRoleSeenAt: "2026-01-01" }), false);
    const t = new Date(1000);
    assert.equal(adminRoleHeld({ adminRoleSeenAt: t, adminRoleClearedAt: t }), true, "equal timestamps: still held (fails safe = protected)");
  });
  test("usableWorkspaceAdmin matrix", () => {
    assert.equal(usableWorkspaceAdmin(null, "off"), false);
    assert.equal(usableWorkspaceAdmin({ status: "suspended" }, "off"), false);
    assert.equal(usableWorkspaceAdmin({ status: "active" }, "off"), true);
    assert.equal(usableWorkspaceAdmin({ status: "active", account: { status: "blocked", role: "EDITOR", version: 1 } }, "staged"), false);
  });
});

describe("integrations public body", () => {
  test("allow-list drops everything sensitive, including unknown future fields", () => {
    const full = { provider: "monday", configured: true, enabled: true, canManage: true, missing: ["MONDAY_CLIENT_SECRET"], connected: true, state: "connected",
      account: { name: "Acme", user: "a@example.invalid" }, sync: { enabled: true, paused: false, lastSyncAt: "x", lastError: "boom" },
      importedBoards: [{ boardId: "b", name: "Secret board", sourceBoardId: "123" }], imports: [{ id: 1 }], failed: [{ error: "e" }], futureSecret: "s" };
    const body = JSON.stringify(publicStatus(full));
    for (const leak of ["MONDAY_CLIENT_SECRET", "Acme", "a@example", "boom", "Secret board", "123", "futureSecret", "\"e\""]) assert.ok(!body.includes(leak), leak);
  });
});

describe("config strictness with production-shaped values", () => {
  const ENV = { DATA_STORE: "mongodb", MONGODB_URI: "mongodb+srv://u:p@cluster.invalid/", MONGODB_DB_NAME: "jarc_database", AUTH_MODE: "entra",
    ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111", ENTRA_SPA_CLIENT_ID: "22222222-2222-4222-8222-222222222222", ENTRA_REDIRECT_URI: "https://jarc.example.invalid/",
    NODE_ENV: "production", HOST: "0.0.0.0", PORT: "8080" };
  test("development_shared + true + unset ACCOUNT_MANAGEMENT loads", () => {
    const c = loadConfig({ ...ENV, ACCESS_POLICY: "development_shared", JARC_BETA_OPEN_EDITING: "true" });
    assert.equal(c.accessPolicy, "development_shared"); assert.equal(c.betaOpenEditing, true); assert.equal(c.accounts.mode, "off");
  });
  test("a trailing newline / space refuses startup (operational risk if Railway stores one)", () => {
    assert.throws(() => loadConfig({ ...ENV, ACCESS_POLICY: "development_shared\n", JARC_BETA_OPEN_EDITING: "true" }));
    assert.throws(() => loadConfig({ ...ENV, ACCESS_POLICY: "development_shared", JARC_BETA_OPEN_EDITING: "true " }));
  });
});
