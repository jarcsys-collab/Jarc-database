// P4-0 (F2): admin freshness. The JARC.Admin claim is frozen on the session at sign-in; sensitive administrator writes refuse an
// old claim with 403 REAUTH_REQUIRED, everything else is unchanged. Also: the sign-in records when the role was last seen
// (users.adminRoleSeenAt / adminRoleClearedAt). Offline: local test keys, fake MongoDB, synthetic people only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { sensitiveAdminRequest, adminReauthMs, adminFreshUntil, ADMIN_REAUTH_MINUTES } = require("../src/auth/session");
const { adminRoleHeld } = require("../src/auth/accounts");

const HOUR = 60 * 60 * 1000;
const P3_WRITE = "/api/v1/admin/employees/all/records/AAAAAAAAAAAAAAAAAAAAAA/access";

describe("sensitiveAdminRequest (pure)", () => {
  const req = (method, path, baseUrl = "") => ({ method, path, baseUrl });
  test("the conservative set: Account Management writes, monday.com integration writes, P3 writes; only unsafe methods", () => {
    for (const [m, p] of [["POST", "/api/v1/accounts/bootstrap"], ["PATCH", "/api/v1/accounts/abc"], ["PUT", "/api/v1/accounts/a/workspaces/b"], ["DELETE", "/api/v1/accounts/a/workspaces/b"],
      ["POST", "/api/v1/integrations/monday/connect"], ["POST", "/api/v1/integrations/monday/sync-now"], ["POST", "/api/v1/integrations/monday/jobs/x/retry"],
      ["POST", P3_WRITE], ["POST", "/api/v1/admin/employees/all/records/x/memberships"], ["PATCH", "/api/v1/admin/employees/all/records/x/memberships/ref"], ["DELETE", "/api/v1/admin/employees/all/records/x/memberships/ref"],
      // Security review: workspace member changes and the legacy state import.
      ["POST", "/api/v1/workspaces/x/members"], ["PATCH", "/api/v1/workspaces/x/members/m"], ["DELETE", "/api/v1/workspaces/x/members/m"], ["POST", "/api/v1/imports"], ["POST", "/api/v1/imports/"]]) {
      assert.equal(sensitiveAdminRequest(req(m, p)), true, `${m} ${p}`);
    }
    for (const [m, p] of [["GET", "/api/v1/accounts"], ["GET", "/api/v1/integrations/monday"], ["GET", "/api/v1/admin/employees/all/records/x/manage-access"],
      ["POST", "/api/v1/integrations/monday/webhook/token123"], ["GET", "/api/v1/integrations/monday/callback"],
      ["POST", "/api/v1/workspaces"], ["PATCH", "/api/v1/boards/x/records/y"], ["GET", "/api/v1/workspaces/x/members"], ["POST", "/api/v1/workspaces/x/imports"],
      ["POST", "/api/v1/imports/x/start"], ["PATCH", "/api/v1/imports/x"], ["POST", "/api/v1/workspaces/x/members/m/extra"],
      ["POST", "/api/v1/auth/sign-out"], ["PUT", "/api/v1/me/preferences"], ["POST", "/api/v1/admin/employees/saved-filters"], ["GET", "/api/v1/admin/activity"]]) {
      assert.equal(sensitiveAdminRequest(req(m, p)), false, `${m} ${p}`);
    }
  });
  test("matched on the full path whatever the mount point (baseUrl + path)", () => {
    assert.equal(sensitiveAdminRequest(req("POST", "/all/records/x/access", "/api/v1/admin/employees")), true);
    assert.equal(sensitiveAdminRequest(req("POST", "/monday/connect", "/api/v1/integrations")), true);
  });
  test("ACCOUNT_MANAGEMENT=enforced: only the Account Management writes (SYSTEM_ADMIN is then the account, read per request)", () => {
    assert.equal(sensitiveAdminRequest(req("POST", "/api/v1/accounts/bootstrap"), "enforced"), true);
    assert.equal(sensitiveAdminRequest(req("POST", "/api/v1/integrations/monday/connect"), "enforced"), false);
    assert.equal(sensitiveAdminRequest(req("POST", P3_WRITE), "enforced"), false);
    assert.equal(sensitiveAdminRequest(req("POST", P3_WRITE), "staged"), true);
    assert.equal(sensitiveAdminRequest(req("POST", "/api/v1/workspaces/x/members"), "enforced"), false);
    assert.equal(sensitiveAdminRequest(req("POST", "/api/v1/imports"), "enforced"), false);
  });
  test("the re-auth age: 60 minutes by default; entra.adminReauthMinutes only as a whole number from 5 to 480", () => {
    assert.equal(ADMIN_REAUTH_MINUTES, 60);
    assert.equal(adminReauthMs({}), HOUR);
    assert.equal(adminReauthMs({ adminReauthMinutes: 15 }), 15 * 60 * 1000);
    for (const bad of [0, 4, 481, 1.5, "30", null]) assert.equal(adminReauthMs({ adminReauthMinutes: bad }), HOUR, String(bad));
  });
  test("adminFreshUntil: null without the claim; createdAt + age with it; a missing createdAt is already stale", () => {
    const t = new Date("2026-01-01T00:00:00Z");
    assert.equal(adminFreshUntil({ isSystemAdmin: false, createdAt: t }, HOUR), null);
    assert.equal(adminFreshUntil({ createdAt: t }, HOUR), null);
    assert.equal(adminFreshUntil({ isSystemAdmin: true, createdAt: t }, HOUR).getTime(), t.getTime() + HOUR);
    assert.equal(adminFreshUntil({ isSystemAdmin: true }, HOUR).getTime(), 0);
  });
});

describe("REAUTH_REQUIRED through the real app", () => {
  let app, issuer;
  before(async () => { issuer = await createTokenIssuer(); app = await startEntraApp({ issuer }); });
  after(async () => { await app.close(); });
  const signedIn = async (p) => { const c = new SessionClient(app.url, app.entra.appOrigin); const res = await c.signIn(p); assert.equal(res.status, 201); return { c, res }; };
  const age = async (p, ms) => {
    const user = await app.db.collection("users").findOne({ entraObjectId: p.oid });
    const sessions = await app.db.collection("sessions").find({ userId: user._id }).toArray();
    for (const s of sessions) await app.db.collection("sessions").updateOne({ _id: s._id }, { $set: { createdAt: new Date(s.createdAt.getTime() - ms) } });
  };

  test("a fresh admin claim: sensitive writes reach their route; adminFreshUntil is in the sign-in and session responses", async () => {
    const p = issuer.person("Synthetic Fresh Admin", { admin: true });
    const { c, res } = await signedIn(p);
    assert.equal(res.body.isSystemAdmin, true);
    const until = Date.parse(res.body.adminFreshUntil);
    assert.ok(Math.abs(until - (Date.now() + HOUR)) < 60 * 1000, "about an hour from the sign-in");
    const s = await c.request("GET", "/api/v1/auth/session");
    assert.equal(s.body.adminFreshUntil, res.body.adminFreshUntil);
    const w = await c.request("POST", P3_WRITE, { action: "suspend" });
    assert.notEqual(w.body?.error?.code, "REAUTH_REQUIRED");
    assert.equal(w.status, 404, "Employee Management isn't mounted in this app: the route itself answers");
  });

  test("an old admin claim: 403 REAUTH_REQUIRED for sensitive writes only; reads, board requests and the session keep working", async () => {
    const p = issuer.person("Synthetic Stale Admin", { admin: true });
    const { c } = await signedIn(p);
    await age(p, 2 * HOUR);
    for (const [m, path] of [["POST", P3_WRITE], ["POST", "/api/v1/integrations/monday/connect"], ["POST", "/api/v1/integrations/monday/sync-now"], ["DELETE", "/api/v1/admin/employees/all/records/x/memberships/ref"]]) {
      const r = await c.request(m, path, m === "DELETE" ? undefined : {});
      assert.equal(r.status, 403, `${m} ${path}`);
      assert.equal(r.body.error.code, "REAUTH_REQUIRED");
    }
    const s = await c.request("GET", "/api/v1/auth/session");
    assert.equal(s.status, 200, "the session stays valid");
    assert.equal(s.body.isSystemAdmin, true, "the flag itself is unchanged for everything else");
    assert.ok(Date.parse(s.body.adminFreshUntil) < Date.now());
    const created = await c.request("POST", "/api/v1/workspaces", { name: "Synthetic Stale WS" });
    assert.equal(created.status, 201, "ordinary writes are unaffected");
    assert.equal((await c.request("GET", "/api/v1/workspaces")).status, 200);
    assert.notEqual((await c.request("GET", "/api/v1/integrations/monday")).body?.error?.code, "REAUTH_REQUIRED", "reads are never gated");
    // Signing in again gives a fresh claim.
    await c.signIn(p);
    assert.notEqual((await c.request("POST", P3_WRITE, {})).body?.error?.code, "REAUTH_REQUIRED");
  });

  test("a session without the claim is never gated, however old", async () => {
    const p = issuer.person("Synthetic Old Employee");
    const { c, res } = await signedIn(p);
    assert.equal(res.body.adminFreshUntil, undefined);
    await age(p, 7 * HOUR);
    const r = await c.request("POST", P3_WRITE, {});
    assert.notEqual(r.body?.error?.code, "REAUTH_REQUIRED");
    assert.equal((await c.request("GET", "/api/v1/auth/session")).body.adminFreshUntil, undefined);
  });

  test("workspace member changes and the legacy state import: an old admin claim is refused; an employee without the claim is not", async () => {
    const p = issuer.person("Synthetic Stale Member Admin", { admin: true });
    const { c } = await signedIn(p);
    const ws = (await c.request("POST", "/api/v1/workspaces", { name: "Synthetic Members WS" })).body;
    const wsId = ws.workspace?.id ?? ws.id;
    assert.ok(wsId, "a workspace to work in");
    await age(p, 2 * HOUR);
    for (const [m, path] of [["POST", `/api/v1/workspaces/${wsId}/members`], ["PATCH", `/api/v1/workspaces/${wsId}/members/aaaaaaaaaaaaaaaaaaaaaaaa`], ["DELETE", `/api/v1/workspaces/${wsId}/members/aaaaaaaaaaaaaaaaaaaaaaaa`], ["POST", "/api/v1/imports?dryRun=true"]]) {
      const r = await c.request(m, path, m === "DELETE" ? undefined : {});
      assert.equal(r.status, 403, `${m} ${path}`);
      assert.equal(r.body.error.code, "REAUTH_REQUIRED", `${m} ${path}`);
    }
    assert.equal((await c.request("GET", `/api/v1/workspaces/${wsId}/members`)).status, 200, "reading members is never gated");
    // An employee without the claim, however old the session: the routes answer as before (their own rules), never REAUTH_REQUIRED.
    const e = issuer.person("Synthetic Old Member Employee");
    const { c: ec } = await signedIn(e);
    await age(e, 7 * HOUR);
    for (const [m, path] of [["POST", `/api/v1/workspaces/${wsId}/members`], ["POST", "/api/v1/imports?dryRun=true"]]) {
      const r = await ec.request(m, path, {});
      assert.notEqual(r.body?.error?.code, "REAUTH_REQUIRED", `${m} ${path}`);
    }
  });

  test("CSRF is still checked first (a forged sensitive write is CSRF_INVALID, not REAUTH_REQUIRED)", async () => {
    const p = issuer.person("Synthetic Csrf Admin", { admin: true });
    const { c } = await signedIn(p);
    await age(p, 2 * HOUR);
    const r = await c.request("POST", P3_WRITE, {}, { csrf: "wrong" });
    assert.equal(r.body.error.code, "CSRF_INVALID");
  });
});

describe("entra.adminReauthMinutes (a proposed setting, read only when present)", () => {
  let app, issuer;
  before(async () => { issuer = await createTokenIssuer(); app = await startEntraApp({ issuer, entra: { adminReauthMinutes: 5 } }); });
  after(async () => { await app.close(); });
  test("a 5-minute age: a 10-minute-old claim is refused, a fresh one is not", async () => {
    const p = issuer.person("Synthetic Short Admin", { admin: true });
    const c = new SessionClient(app.url, app.entra.appOrigin);
    const res = await c.signIn(p);
    assert.ok(Math.abs(Date.parse(res.body.adminFreshUntil) - (Date.now() + 5 * 60 * 1000)) < 60 * 1000);
    assert.notEqual((await c.request("POST", P3_WRITE, {})).body?.error?.code, "REAUTH_REQUIRED");
    const user = await app.db.collection("users").findOne({ entraObjectId: p.oid });
    await app.db.collection("sessions").updateMany({ userId: user._id }, { $set: { createdAt: new Date(Date.now() - 10 * 60 * 1000) } });
    assert.equal((await c.request("POST", P3_WRITE, {})).body.error.code, "REAUTH_REQUIRED");
  });
});

describe("the sign-in records the JARC.Admin role (users.adminRoleSeenAt / adminRoleClearedAt)", () => {
  let app, issuer;
  before(async () => { issuer = await createTokenIssuer(); app = await startEntraApp({ issuer }); });
  after(async () => { await app.close(); });
  const userOf = (p) => app.db.collection("users").findOne({ entraObjectId: p.oid });

  test("with the role: adminRoleSeenAt; without it later: adminRoleClearedAt; with it again: held again", async () => {
    const p = issuer.person("Synthetic Role Holder", { admin: true });
    await new SessionClient(app.url, app.entra.appOrigin).signIn(p);
    const first = await userOf(p);
    assert.ok(first.adminRoleSeenAt instanceof Date);
    assert.equal(first.adminRoleClearedAt, undefined);
    assert.equal(adminRoleHeld(first), true);
    await new Promise((r) => setTimeout(r, 5));
    const without = { ...p, idToken: (nonce, claims = {}) => p.idToken(nonce, { roles: [], ...claims }) };
    await new SessionClient(app.url, app.entra.appOrigin).signIn(without);
    const cleared = await userOf(p);
    assert.ok(cleared.adminRoleClearedAt instanceof Date && cleared.adminRoleClearedAt >= cleared.adminRoleSeenAt);
    assert.equal(adminRoleHeld(cleared), false);
    await new Promise((r) => setTimeout(r, 5));
    await new SessionClient(app.url, app.entra.appOrigin).signIn(p);
    assert.equal(adminRoleHeld(await userOf(p)), true);
  });

  test("a failed adminRoleSeenAt write never fails the sign-in: 201, a working session, and only the error class in the log", async () => {
    const users = app.dataLayer.repos.users, original = users.recordAdminRole;
    users.recordAdminRole = async () => { throw Object.assign(new Error("synthetic secret-looking detail"), { name: "MongoNetworkError" }); };
    const logged = app.logger.errors.length;
    try {
      const p = issuer.person("Synthetic Unrecorded Admin", { admin: true });
      const c = new SessionClient(app.url, app.entra.appOrigin);
      const res = await c.signIn(p);
      assert.equal(res.status, 201);
      assert.equal(res.body.isSystemAdmin, true);
      assert.equal((await c.request("GET", "/api/v1/auth/session")).status, 200);
      const lines = app.logger.errors.slice(logged);
      assert.ok(lines.some((l) => /MongoNetworkError/.test(l)), "the class is logged");
      assert.ok(!lines.some((l) => /secret-looking/.test(l)), "never the message");
    } finally { users.recordAdminRole = original; }
  });

  test("someone never seen with the role gets no admin fields (no write for ordinary sign-ins)", async () => {
    const p = issuer.person("Synthetic Plain Person");
    await new SessionClient(app.url, app.entra.appOrigin).signIn(p);
    await new SessionClient(app.url, app.entra.appOrigin).signIn(p);
    const u = await userOf(p);
    assert.equal(u.adminRoleSeenAt, undefined);
    assert.equal(u.adminRoleClearedAt, undefined);
  });

  test("a refused sign-in (disabled user) records nothing", async () => {
    const p = issuer.person("Synthetic Disabled Admin", { admin: true });
    await new SessionClient(app.url, app.entra.appOrigin).signIn({ ...p, idToken: (nonce, claims = {}) => p.idToken(nonce, { roles: [], ...claims }) });
    await app.db.collection("users").updateOne({ entraObjectId: p.oid }, { $set: { status: "suspended" } });
    assert.equal((await new SessionClient(app.url, app.entra.appOrigin).signIn(p)).status, 403);
    assert.equal((await userOf(p)).adminRoleSeenAt, undefined);
  });
});
