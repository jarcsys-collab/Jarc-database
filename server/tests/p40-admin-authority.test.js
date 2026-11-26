// P4-0 adjustment (owner decisions D-H1, D-H2, D-H3): administrator protection and authority. Synthetic people, invented IDs.
//   D-H1  no operation leaves a workspace without a usable owner (membership removal / demote, P3 suspend / revoke, Account
//         Management block), concurrent combinations included.
//   D-H2  P3 and Account Management never suspend, revoke or block a RECOGNISED JARC administrator (no exception), and refuse an
//         UNKNOWN administrator status (fail closed: 409 ADMIN_STATUS_UNKNOWN).
//   D-H3  the 60-minute re-auth: direct HTTP requests; a new sign-in is a NEW session whose JARC.Admin flag comes only from the
//         new ID token.
// Concurrency here runs on the in-memory fake through a connection whose transactions run one at a time (what a MongoDB
// WriteConflict plus the driver's retry amounts to). The real transaction behaviour is observed in p40-real-mongo-concurrency.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { FakeMongoClient } = require("./support/fake-mongo");
const { MongoConnection } = require("../src/db/connection");
const { buildWorld, TENANT } = require("./support/p40-world");
const { jarcAdminStatus, jarcAdminRefusal, RECOGNISED_ADMIN } = require("../src/auth/accounts");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

const LAST_ADMIN = (e) => e.status === 400 && /needs at least one admin/.test(e.message);
const fakeConnection = async () => { const c = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => new FakeMongoClient() }); await c.connect(); return c; };
const world = async (options = {}) => buildWorld(await fakeConnection(), options);
const code = (c) => (e) => e.status === 409 && e.code === c;

describe("jarcAdminStatus (pure): what JARC's records can establish", () => {
  const base = { _id: new ObjectId(), tenantId: TENANT, entraObjectId: "aaaaaaaa-0000-4000-8000-000000000001", status: "active" };
  test("each recognised kind, a cleared role, a live session without the role, unknown", () => {
    assert.equal(jarcAdminStatus({ user: { ...base, account: { status: "active", role: "SUPER_ADMIN", version: 1 } } }), "super_admin");
    assert.equal(jarcAdminStatus({ user: { ...base, account: { status: "blocked", role: "SUPER_ADMIN", version: 2 } }, liveSessions: [] }), "unknown", "a blocked Super Admin isn't an active one");
    assert.equal(jarcAdminStatus({ user: base, superAdmin: { tenantId: TENANT.toUpperCase(), objectId: base.entraObjectId.toUpperCase() } }), "configured");
    assert.equal(jarcAdminStatus({ user: { ...base, adminRoleSeenAt: new Date(2000) } }), "role");
    assert.equal(jarcAdminStatus({ user: base, liveSessions: [{ isSystemAdmin: false }, { isSystemAdmin: true }] }), "role");
    assert.equal(jarcAdminStatus({ user: { ...base, adminRoleSeenAt: new Date(1000), adminRoleClearedAt: new Date(2000) } }), "not_seen", "seen, then cleared at a later sign-in");
    assert.equal(jarcAdminStatus({ user: { ...base, adminRoleClearedAt: new Date(2000) } }), "not_seen");
    assert.equal(jarcAdminStatus({ user: base, liveSessions: [{ isSystemAdmin: false }] }), "not_seen", "a live session is an observation");
    assert.equal(jarcAdminStatus({ user: base }), "unknown");
    assert.equal(jarcAdminStatus({ user: null }), "unknown");
    assert.deepEqual(RECOGNISED_ADMIN.map(jarcAdminRefusal), ["TARGET_JARC_ADMIN", "TARGET_JARC_ADMIN", "TARGET_JARC_ADMIN"]);
    assert.equal(jarcAdminRefusal("unknown"), "ADMIN_STATUS_UNKNOWN");
    assert.equal(jarcAdminRefusal("not_seen"), null);
  });
});

describe("D-H2: P3 never suspends or revokes a recognised JARC administrator", () => {
  test("every recognised kind is refused for every actor (an ordinary and a fresh JARC administrator alike), with the basis", async () => {
    const w = await world({ superAdminIndex: 4 });
    const me = await w.register(0);
    await w.register(3, { account: w.superAdminAccount });
    await w.register(4); // the configured identity
    await w.register(5, { adminRoleSeenAt: new Date() });
    const live = await w.register(6, { adminRoleClearedAt: undefined });
    await w.liveSession(live, true);
    for (const [i, basis] of [[3, "super_admin"], [4, "configured"], [5, "role"], [6, "role"]]) {
      for (const actor of [w.actorOf(me), w.actorOf(me, { isSystemAdmin: true, hasAdminAppRole: true })]) {
        await assert.rejects(w.suspend(i, actor), (e) => code("TARGET_JARC_ADMIN")(e) && e.details.basis === basis, `suspend ${basis}`);
        await assert.rejects(w.revoke(i, actor), (e) => code("TARGET_JARC_ADMIN")(e) && e.details.basis === basis, `revoke ${basis}`);
      }
      const view = await w.manage(i, w.actorOf(me, { isSystemAdmin: true }));
      assert.equal(view.account.jarcAdministrator, basis);
      for (const a of ["suspend", "revoke"]) assert.equal(view.actions.find((x) => x.action === a).code, "TARGET_JARC_ADMIN");
      assert.ok(view.warnings.some((x) => x.code === "TARGET_JARC_ADMIN"));
      assert.equal(await w.statusOf(i), "active");
    }
    const refused = await w.db.collection("accountAudit").countDocuments({ action: "employee.access.rejected", code: "TARGET_JARC_ADMIN" });
    assert.equal(refused, 16, "every refusal audited");
  });

  test("a role previously seen and then cleared at a later sign-in: known non-administrator, P3 works", async () => {
    const w = await world();
    const me = await w.register(0);
    const t = await w.register(3, { adminRoleSeenAt: new Date(1000), adminRoleClearedAt: undefined });
    await assert.rejects(w.suspend(3, w.actorOf(me)), code("TARGET_JARC_ADMIN"));
    await w.repos.users.recordAdminRole(await w.fresh(3), false, new Date()); // a re-sign-in without the role
    assert.equal((await w.manage(3, w.actorOf(me))).account.jarcAdministratorLabel, "JARC administrator role not seen at their last sign-in");
    assert.equal((await w.suspend(3, w.actorOf(me))).result.to, "suspended");
    assert.ok(t);
  });

  test("UNKNOWN status (no observation, no live session): suspend and revoke refused 409 ADMIN_STATUS_UNKNOWN; the GET says why", async () => {
    const w = await world();
    const me = await w.register(0);
    await w.register(3, { adminRoleClearedAt: undefined });
    for (const run of [() => w.suspend(3, w.actorOf(me)), () => w.revoke(3, w.actorOf(me, { isSystemAdmin: true }))]) {
      await assert.rejects(run(), (e) => code("ADMIN_STATUS_UNKNOWN")(e) && e.details.basis === "unknown" && /sign in to JARC once/.test(e.message) && /disable them in Microsoft Entra ID/.test(e.message));
    }
    const view = await w.manage(3, w.actorOf(me));
    for (const a of ["suspend", "revoke"]) { const x = view.actions.find((y) => y.action === a); assert.equal(x.code, "ADMIN_STATUS_UNKNOWN"); assert.match(x.reason, /sign in to JARC once/); }
    assert.ok(view.warnings.some((x) => x.code === "ADMIN_STATUS_UNKNOWN"));
    assert.equal(view.account.jarcAdministrator, "unknown");
    assert.equal(await w.statusOf(3), "active");
    // Restore / grant paths are never guarded; an already-suspended unknown person can still be revoked (nothing usable is removed).
    await w.register(4, { adminRoleClearedAt: undefined, status: "suspended" });
    const res = await w.service.changeAccess("all", w.idOf(4), { action: "revoke", expectedState: "suspended", expectedVersion: 0, reason: "Synthetic reason", confirm: "REVOKE" }, { view: true, admin: true, datasets: ["all"], who: "u", jarcAccess: true }, w.actorOf(me));
    assert.equal(res.result.to, "revoked");
  });

  test("unknown becomes known: a live session without the role, or a sign-in recording it", async () => {
    const w = await world();
    const me = await w.register(0);
    const a = await w.register(3, { adminRoleClearedAt: undefined });
    await w.liveSession(a, false);
    assert.equal((await w.suspend(3, w.actorOf(me))).result.to, "suspended", "a live session without the role is an observation");
    const b = await w.register(4, { adminRoleClearedAt: undefined });
    await w.repos.users.recordAdminRole(b, false, new Date());
    assert.ok((await w.fresh(4)).adminRoleClearedAt instanceof Date, "the first sign-in records 'not seen'");
    assert.equal((await w.suspend(4, w.actorOf(me))).result.to, "suspended");
  });

  test("a role removed in Entra: until a re-sign-in JARC still sees it (protected); after a re-sign-in without it, not", async () => {
    const w = await world();
    const me = await w.register(0);
    const t = await w.register(3, { adminRoleClearedAt: undefined });
    await w.repos.users.recordAdminRole(t, true, new Date(Date.now() - 60000));
    await assert.rejects(w.suspend(3, w.actorOf(me)), code("TARGET_JARC_ADMIN"));
    await w.repos.users.recordAdminRole(await w.fresh(3), false, new Date());
    assert.equal((await w.suspend(3, w.actorOf(me))).result.to, "suspended");
  });

  test("attempts to remove every JARC administrator: all refused through P3 and Account Management; they all stay usable", async () => {
    const w = await world({ superAdminIndex: 2, admins: [0, 1] });
    const ops = await w.register(0), ops2 = await w.register(1);
    const root = await w.register(9, { account: w.superAdminAccount });
    await w.register(2); // configured
    await w.register(3, { adminRoleSeenAt: new Date() });
    await w.register(4, { adminRoleSeenAt: new Date(), account: { status: "active", role: "ADMIN", version: 1 } });
    const rootActor = w.actorOf(root, { isSystemAdmin: true, hasAdminAppRole: true });
    for (const i of [9, 2, 3, 4]) {
      for (const actor of [w.actorOf(ops), w.actorOf(ops2, { isSystemAdmin: true })]) {
        await assert.rejects(w.suspend(i, actor), code("TARGET_JARC_ADMIN"));
        await assert.rejects(w.revoke(i, actor), code("TARGET_JARC_ADMIN"));
      }
      if (i !== 9) await assert.rejects(w.block(i, rootActor), code("TARGET_JARC_ADMIN"), `block ${i}`);
    }
    for (const i of [9, 2, 3, 4]) assert.equal(await w.statusOf(i), "active");
    for (const i of [2, 3, 4]) assert.notEqual(await w.accountStatusOf(i), "blocked");
    assert.equal(await w.db.collection("accountAudit").countDocuments({ action: { $in: ["employee.access.suspended", "employee.access.revoked", "account.blocked"] } }), 0);
  });

  test("simultaneous suspensions / revocations of two JARC administrators (mutual, and of each other by a third): all refused", async () => {
    const w = await world({ serial: true, admins: [0, 3, 4] });
    const x = await w.register(0);
    const a = await w.register(3, { adminRoleSeenAt: new Date() }), b = await w.register(4, { adminRoleSeenAt: new Date() });
    const results = await Promise.allSettled([
      w.suspend(4, w.actorOf(a, { isSystemAdmin: true })), w.revoke(3, w.actorOf(b, { isSystemAdmin: true })),
      w.suspend(3, w.actorOf(x)), w.suspend(4, w.actorOf(x, { isSystemAdmin: true }))
    ]);
    assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected", "rejected", "rejected"]);
    assert.ok(results.every((r) => r.reason.code === "TARGET_JARC_ADMIN"));
    assert.deepEqual([await w.statusOf(3), await w.statusOf(4)], ["active", "active"]);
  });
});

describe("D-H2 d: Account Management block applies the same protection", () => {
  test("recognised administrators and an unknown status: block refused (409 with the basis); a known non-administrator: blocked", async () => {
    const w = await world({ superAdminIndex: 2 });
    const root = await w.register(9, { account: w.superAdminAccount });
    const rootActor = w.actorOf(root, { isSystemAdmin: true, hasAdminAppRole: true });
    await w.register(1, { account: w.superAdminAccount }); // a second Super Admin
    await w.register(2, { account: { status: "active", role: "ADMIN", version: 1 } }); // configured identity
    await w.register(3, { adminRoleSeenAt: new Date(), account: { status: "active", role: "ADMIN", version: 1 } });
    const live = await w.register(4, { adminRoleClearedAt: undefined, account: { status: "active", role: "ADMIN", version: 1 } });
    await w.liveSession(live, true);
    await w.register(5, { adminRoleClearedAt: undefined, account: { status: "active", role: "EDITOR", version: 1 } });
    await w.register(6, { account: { status: "active", role: "EDITOR", version: 1 } });
    for (const [i, c, basis] of [[1, "TARGET_JARC_ADMIN", "super_admin"], [2, "TARGET_JARC_ADMIN", "configured"], [3, "TARGET_JARC_ADMIN", "role"], [4, "TARGET_JARC_ADMIN", "role"], [5, "ADMIN_STATUS_UNKNOWN", "unknown"]]) {
      await assert.rejects(w.block(i, rootActor), (e) => code(c)(e) && e.details.basis === basis, `${i} ${basis}`);
      assert.equal(await w.accountStatusOf(i), "active", "rolled back");
    }
    assert.equal(await w.db.collection("accountAudit").countDocuments({ action: "account.blocked" }), 0);
    const blocked = await w.block(6, rootActor);
    assert.equal(blocked.status, "blocked");
    // A P3-suspended person (no JARC access today) may be blocked even when unknown: nothing usable is removed.
    await w.register(7, { adminRoleClearedAt: undefined, status: "suspended", account: { status: "active", role: "EDITOR", version: 1 } });
    assert.equal((await w.block(7, rootActor)).status, "blocked");
  });

  test("D-H1: the last-Super-Admin rule counts USABLE Super Admins (a P3-suspended one doesn't count)", async () => {
    const w = await world({ accountMode: "enforced" });
    const root = await w.register(9, { account: w.superAdminAccount });
    const s2 = await w.register(1, { account: w.superAdminAccount, status: "suspended" });
    const s3 = await w.register(2, { account: w.superAdminAccount });
    assert.equal(await w.repos.users.countSuperAdmins(), 3, "the old count included the suspended one");
    assert.equal(await w.repos.users.countUsableSuperAdmins(), 2);
    assert.equal(await w.repos.users.countUsableSuperAdmins({ exceptId: s3._id }), 1);
    assert.equal(await w.repos.users.countUsableSuperAdmins({ exceptId: root._id }), 1);
    // Demoting a usable Super Admin while another usable one (the actor) remains: allowed (a demotion isn't a block).
    const r = await w.accounts.changeRole(w.actorOf(root, { hasAdminAppRole: true }), s3._id, { role: "ADMIN", expectedVersion: 1 });
    assert.equal(r.role, "ADMIN");
    assert.equal(await w.repos.users.countUsableSuperAdmins(), 1, "root is now the last usable Super Admin");
    assert.ok(s2);
  });
});

describe("D-H1: no operation leaves a workspace without a usable owner (concurrent combinations)", () => {
  test("concurrent owner removal + P3 suspend + Account Management block of a workspace's three admins: two succeed, one usable remains", async () => {
    const w = await world({ serial: true });
    const me = await w.register(0);
    const root = await w.register(9, { account: w.superAdminAccount });
    const a = await w.register(3), b = await w.register(4), c = await w.register(5, { account: { status: "active", role: "ADMIN", version: 1 } });
    const ws = await w.workspace("Synthetic Triple");
    const ma = await w.admin(ws, a); await w.admin(ws, b); await w.admin(ws, c);
    const results = await Promise.allSettled([
      w.members.remove(ws, ma._id, w.actorOf(me)),
      w.suspend(4, w.actorOf(me)),
      w.block(5, w.actorOf(root, { isSystemAdmin: true, hasAdminAppRole: true }))
    ]);
    // The transactions run in whichever order they reach the database; whatever the order, exactly one is refused.
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "fulfilled", "rejected"]);
    const lost = results.find((r) => r.status === "rejected").reason;
    assert.ok(lost.code === "LAST_USABLE_WORKSPACE_ADMIN" || LAST_ADMIN(lost), String(lost.code));
    assert.equal(await w.usableAdmins(ws), 1);
  });

  test("each pair, started in both orders: exactly one wins, the workspace keeps a usable owner", async () => {
    const pairs = [["remove", "suspend"], ["suspend", "block"], ["block", "remove"], ["demote", "revoke"], ["revoke", "block"]];
    for (const order of [0, 1]) for (const pair of pairs) {
      const ops = order ? [...pair].reverse() : pair;
      const w = await world({ serial: true });
      const me = await w.register(0);
      const root = await w.register(9, { account: w.superAdminAccount });
      const a = await w.register(3, { account: { status: "active", role: "ADMIN", version: 1 } }), b = await w.register(4, { account: { status: "active", role: "ADMIN", version: 1 } });
      const ws = await w.workspace("Synthetic Pair");
      const rows = { 3: await w.admin(ws, a), 4: await w.admin(ws, b) };
      const run = (op, i) => ({
        remove: () => w.members.remove(ws, rows[i]._id, w.actorOf(me)),
        demote: () => w.members.changeRole(ws, rows[i]._id, { role: "MEMBER" }, w.actorOf(me)),
        suspend: () => w.suspend(i, w.actorOf(me)),
        revoke: () => w.revoke(i, w.actorOf(me)),
        block: () => w.block(i, w.actorOf(root, { isSystemAdmin: true, hasAdminAppRole: true }))
      }[op])();
      const results = await Promise.allSettled([run(ops[0], 3), run(ops[1], 4)]);
      assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"], ops.join("+"));
      const lost = results.find((r) => r.status === "rejected").reason;
      assert.ok(lost.code === "LAST_USABLE_WORKSPACE_ADMIN" || LAST_ADMIN(lost), `${ops.join("+")}: ${lost.code}`);
      assert.equal(await w.usableAdmins(ws), 1, ops.join("+"));
    }
  });

  test("missing, suspended, revoked and blocked co-admins never count; a duplicate users identity can't exist (unique index)", async () => {
    const w = await world();
    const me = await w.register(0);
    const root = await w.register(9, { account: w.superAdminAccount });
    const t = await w.register(3, { account: { status: "active", role: "ADMIN", version: 1 } });
    const ws = await w.workspace("Synthetic Unusable");
    await w.admin(ws, t);
    await w.admin(ws, { _id: new ObjectId() });
    await w.admin(ws, await w.register(4, { status: "suspended" }));
    await w.admin(ws, await w.register(5, { status: "revoked" }));
    await w.admin(ws, await w.register(6, { account: { status: "blocked", role: "ADMIN", version: 2 } }));
    await assert.rejects(w.suspend(3, w.actorOf(me)), code("LAST_USABLE_WORKSPACE_ADMIN"));
    await assert.rejects(w.block(3, w.actorOf(root, { isSystemAdmin: true, hasAdminAppRole: true })), code("LAST_USABLE_WORKSPACE_ADMIN"));
    await assert.rejects(w.register(3), (e) => e?.code === 11000, "uniq_entra_identity");
  });
});

describe("D-H3: the 60-minute re-auth, by direct HTTP requests", () => {
  let app, issuer;
  before(async () => { issuer = await createTokenIssuer(); app = await startEntraApp({ issuer, accounts: { mode: "staged" } }); });
  after(async () => { await app.close(); });
  const HOUR = 3600 * 1000;
  const SENSITIVE = [
    ["POST", "/api/v1/accounts/aaaaaaaaaaaaaaaaaaaaaaaa/block"], ["POST", "/api/v1/accounts/aaaaaaaaaaaaaaaaaaaaaaaa/role"], ["POST", "/api/v1/accounts/bootstrap"],
    ["PUT", "/api/v1/accounts/aaaaaaaaaaaaaaaaaaaaaaaa/workspaces/bbbbbbbbbbbbbbbbbbbbbbbb"], ["DELETE", "/api/v1/accounts/aaaaaaaaaaaaaaaaaaaaaaaa/workspaces/bbbbbbbbbbbbbbbbbbbbbbbb"],
    ["POST", "/api/v1/integrations/monday/connect"], ["POST", "/api/v1/integrations/monday/sync-now"],
    ["POST", "/api/v1/admin/employees/all/records/AAAAAAAAAAAAAAAAAAAAAA/access"], ["POST", "/api/v1/admin/employees/all/records/AAAAAAAAAAAAAAAAAAAAAA/memberships"],
    ["PATCH", "/api/v1/admin/employees/all/records/AAAAAAAAAAAAAAAAAAAAAA/memberships/r"], ["DELETE", "/api/v1/admin/employees/all/records/AAAAAAAAAAAAAAAAAAAAAA/memberships/r"],
    ["POST", "/api/v1/workspaces/aaaaaaaaaaaaaaaaaaaaaaaa/members"], ["PATCH", "/api/v1/workspaces/aaaaaaaaaaaaaaaaaaaaaaaa/members/bbbbbbbbbbbbbbbbbbbbbbbb"], ["DELETE", "/api/v1/workspaces/aaaaaaaaaaaaaaaaaaaaaaaa/members/bbbbbbbbbbbbbbbbbbbbbbbb"],
    ["POST", "/api/v1/imports"]
  ];
  const userOf = (p) => app.db.collection("users").findOne({ entraObjectId: p.oid });
  const sessionsOf = async (p) => app.db.collection("sessions").find({ userId: (await userOf(p))._id }).toArray();
  const age = async (p, ms) => { for (const s of await sessionsOf(p)) await app.db.collection("sessions").updateOne({ _id: s._id }, { $set: { createdAt: new Date(s.createdAt.getTime() - ms) } }); };
  const without = (p) => ({ ...p, idToken: (nonce, claims = {}) => p.idToken(nonce, { roles: [], ...claims }) });
  const send = (c, [m, path]) => c.request(m, path, m === "DELETE" ? undefined : {});

  test("old-claim session: 403 REAUTH_REQUIRED on every sensitive route; ordinary use keeps working; activity never refreshes the claim", async () => {
    const p = issuer.person("Synthetic Reauth Admin", { admin: true });
    const c = new SessionClient(app.url, app.entra.appOrigin);
    assert.equal((await c.signIn(p)).status, 201);
    await age(p, 2 * HOUR);
    for (const r of SENSITIVE) { const res = await send(c, r); assert.equal(res.status, 403, r.join(" ")); assert.equal(res.body.error.code, "REAUTH_REQUIRED", r.join(" ")); }
    for (let i = 0; i < 3; i += 1) assert.equal((await c.request("GET", "/api/v1/workspaces")).status, 200);
    await app.db.collection("sessions").updateMany({ userId: (await userOf(p))._id }, { $set: { lastSeenAt: new Date(0) } }); // force a touch
    assert.equal((await c.request("GET", "/api/v1/workspaces")).status, 200);
    const [s] = await sessionsOf(p);
    assert.ok(Date.now() - s.createdAt.getTime() > HOUR, "touch moves the idle expiry only, never createdAt (the claim's age)");
    assert.equal((await send(c, SENSITIVE[0])).body.error.code, "REAUTH_REQUIRED");
  });

  test("a new sign-in creates a NEW session and drops the old one from this browser; its isSystemAdmin comes only from the new token", async () => {
    const p = issuer.person("Synthetic Resign Admin", { admin: true });
    const c = new SessionClient(app.url, app.entra.appOrigin);
    await c.signIn(p);
    const other = new SessionClient(app.url, app.entra.appOrigin); // another browser, same person
    await other.signIn(p);
    await age(p, 2 * HOUR);
    const oldCookie = c.cookies.get("__Host-jarc_session");
    const before = (await sessionsOf(p)).map((s) => s._id);
    // Re-sign-in WITHOUT the role (removed in Entra): no admin, no freshness, adminRoleClearedAt recorded.
    const res = await c.signIn(without(p));
    assert.equal(res.status, 201);
    assert.equal(res.body.isSystemAdmin, false);
    assert.equal(res.body.adminFreshUntil, undefined);
    const after = await sessionsOf(p);
    assert.equal(after.length, 2, "this browser's old session was removed, a new one created; the other browser's remains");
    const created = after.find((s) => !before.includes(s._id));
    assert.ok(created && created.isSystemAdmin === false && Date.now() - created.createdAt.getTime() < 60000);
    const u = await userOf(p);
    assert.ok(u.adminRoleClearedAt instanceof Date && u.adminRoleClearedAt > u.adminRoleSeenAt, "adminRoleClearedAt recorded");
    // The old cookie no longer works (can't be "refreshed" or replayed).
    const replay = new SessionClient(app.url, app.entra.appOrigin); replay.cookies.set("__Host-jarc_session", oldCookie);
    assert.equal((await replay.request("GET", "/api/v1/auth/session")).status, 401);
    // The new session isn't an administrator: sensitive writes reach their routes and are refused there (never REAUTH_REQUIRED).
    for (const r of SENSITIVE) assert.notEqual((await send(c, r)).body?.error?.code, "REAUTH_REQUIRED", r.join(" "));
    assert.equal((await c.request("GET", "/api/v1/auth/session")).body.isSystemAdmin, false);
    // The other browser's old session stays valid for ordinary use, and its sensitive writes stay refused (its claim never refreshes).
    assert.equal((await other.request("GET", "/api/v1/workspaces")).status, 200);
    assert.equal((await other.request("GET", "/api/v1/auth/session")).body.isSystemAdmin, true, "frozen at its own sign-in");
    for (const r of SENSITIVE) assert.equal((await send(other, r)).body.error.code, "REAUTH_REQUIRED", r.join(" "));
    // Re-sign-in WITH the role: administrator again, and fresh.
    const back = await c.signIn(p);
    assert.equal(back.body.isSystemAdmin, true);
    assert.ok(Date.parse(back.body.adminFreshUntil) > Date.now() + 59 * 60 * 1000);
    for (const r of SENSITIVE) assert.notEqual((await send(c, r)).body?.error?.code, "REAUTH_REQUIRED", r.join(" "));
    const v = await userOf(p);
    assert.ok(v.adminRoleSeenAt > v.adminRoleClearedAt, "seen again");
  });

  test("an ID token can't be reused for a second session (its nonce is single-use), and a token for another nonce is refused", async () => {
    const p = issuer.person("Synthetic Nonce Admin", { admin: true });
    const c = new SessionClient(app.url, app.entra.appOrigin);
    const start = await c.request("POST", "/api/v1/auth/sign-in/start");
    const token = await p.idToken(start.body.nonce);
    assert.equal((await c.request("POST", "/api/v1/auth/session", { idToken: token })).status, 201);
    await c.request("POST", "/api/v1/auth/sign-in/start");
    assert.equal((await c.request("POST", "/api/v1/auth/session", { idToken: token })).status, 401, "the old token's nonce isn't this attempt's");
  });
});
