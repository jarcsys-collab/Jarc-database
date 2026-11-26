// P4-0 final independent security review probes (synthetic people, invented IDs; in-memory fake database only).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { FakeMongoClient } = require("./support/fake-mongo");
const { MongoConnection } = require("../src/db/connection");
const { buildWorld } = require("./support/p40-world");
const { jarcAdminStatus, accountOf } = require("../src/auth/accounts");
const { entraSessionCheck } = require("../src/routes/events");

const fakeConnection = async () => { const c = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => new FakeMongoClient() }); await c.connect(); return c; };
const world = async (options = {}) => buildWorld(await fakeConnection(), options);

describe("final review: observation timestamps", () => {
  test("FIXED: seen and cleared at the same millisecond no longer latch 'role': a later sign-in without the role clears it", async () => {
    const w = await world();
    const t = new Date(5000);
    const u = await w.register(3, { adminRoleSeenAt: t, adminRoleClearedAt: t });
    assert.equal(jarcAdminStatus({ user: u }), "role", "equal timestamps read as held (fail safe)");
    await w.repos.users.recordAdminRole(await w.fresh(3), false, new Date());
    const after = await w.fresh(3);
    // Fixed in user-repository.recordAdminRole (strictly-later rule, same as adminRoleHeld): the absent-role write now happens.
    assert.equal(jarcAdminStatus({ user: after }), "not_seen");
  });

  test("first sign-in without the role writes once; later ones don't write again", async () => {
    const w = await world();
    await w.register(3, { adminRoleClearedAt: undefined });
    const now1 = new Date(10000), now2 = new Date(20000);
    await w.repos.users.recordAdminRole(await w.fresh(3), false, now1);
    assert.equal((await w.fresh(3)).adminRoleClearedAt.getTime(), 10000);
    await w.repos.users.recordAdminRole(await w.fresh(3), false, now2);
    assert.equal((await w.fresh(3)).adminRoleClearedAt.getTime(), 10000, "no further write");
  });
});

describe("final review: leaver with an Entra-disabled account and an unknown status", () => {
  test("P3 suspend / revoke refused ADMIN_STATUS_UNKNOWN even though the directory says the account is disabled", async () => {
    const w = await world();
    w.people[3].account_enabled = false;
    const me = await w.register(0);
    await w.register(3, { adminRoleClearedAt: undefined });
    const view = await w.manage(3, w.actorOf(me));
    const codes = view.warnings.map((x) => x.code);
    assert.ok(codes.includes("ADMIN_STATUS_UNKNOWN"));
    assert.equal(view.actions.find((a) => a.action === "suspend").code, "ADMIN_STATUS_UNKNOWN");
    await assert.rejects(w.suspend(3, w.actorOf(me)), (e) => e.code === "ADMIN_STATUS_UNKNOWN");
    await assert.rejects(w.revoke(3, w.actorOf(me)), (e) => e.code === "ADMIN_STATUS_UNKNOWN");
    assert.equal(await w.statusOf(3), "active");
    // Record what the directory told the page (for the report: whether ENTRA_DISABLED_WITH_ACCESS shows next to it).
    console.log("final-review warnings:", JSON.stringify(codes), "entraEnabled:", view.account.entraEnabled);
  });
});

describe("final review: Super Admin demotion never removes the last usable one", () => {
  test("two Super Admins: A demotes B; nobody can then demote or block A (self) and B can't act", async () => {
    const w = await world({ accountMode: "enforced" });
    const a = await w.register(1, { account: w.superAdminAccount });
    const b = await w.register(2, { account: w.superAdminAccount });
    await w.accounts.changeRole(w.actorOf(a), b._id, { role: "ADMIN", expectedVersion: 1 });
    assert.equal(accountOf(await w.fresh(2)).role, "ADMIN");
    await assert.rejects(w.accounts.changeRole(w.actorOf(a), a._id, { role: "ADMIN", expectedVersion: 1 }), (e) => e.status === 403);
    await assert.rejects(w.accounts.changeRole(w.actorOf(await w.fresh(2)), a._id, { role: "ADMIN", expectedVersion: 1 }), (e) => e.status === 403);
    assert.equal(accountOf(await w.fresh(1)).role, "SUPER_ADMIN");
  });

  test("a Super Admin whose users.status is suspended can't act (re-checked in the transaction)", async () => {
    const w = await world({ accountMode: "enforced" });
    const a = await w.register(1, { account: w.superAdminAccount, status: "suspended" });
    const b = await w.register(2, { account: w.superAdminAccount });
    await assert.rejects(w.accounts.changeRole(w.actorOf(a), b._id, { role: "ADMIN", expectedVersion: 1 }), (e) => e.status === 403);
  });
});

describe("final review: SSE session check is stable (no reconnect loop)", () => {
  const user = { _id: new ObjectId(), status: "active", account: { status: "active", role: "ADMIN", version: 3 } };
  const session = { userId: user._id, isSystemAdmin: true, expiresAt: new Date(Date.now() + 3600e3), idleExpiresAt: new Date(Date.now() + 3600e3) };
  const check = (u) => entraSessionCheck({ sessions: { findBySecret: async () => session }, users: { findById: async () => u } });
  const req = { sessionSecret: "x", actor: { hasAdminAppRole: true, account: accountOf(user) } };
  test("unchanged → true; a changed role → refresh; reopened with the new account → true", async () => {
    assert.equal(await check(user)(req), true);
    const changed = { ...user, account: { ...user.account, role: "EDITOR", version: 4 } };
    assert.equal(await check(changed)(req), "refresh");
    assert.equal(await check(changed)({ ...req, actor: { ...req.actor, account: accountOf(changed) } }), true);
  });
  test("a legacy user (no account) under staged: stable", async () => {
    const legacy = { _id: user._id, status: "active" };
    assert.equal(await check(legacy)({ ...req, actor: { ...req.actor, account: accountOf(legacy) } }), true);
  });
});
