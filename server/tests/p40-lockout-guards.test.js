// P4-0 (F3, F4): usable last-owner protection and JARC administrator lockout protection, at the service level on JARC's real data
// layer over the in-memory FakeMongoClient and the read-only fake directory. Synthetic people only, invented IDs.
//
// Concurrency: the fake runs transactions without write-conflict detection, so "concurrent" operations are proved in two parts:
// (1) they are started together through a connection whose transactions run one at a time (what a MongoDB WriteConflict plus the
// driver's retry amounts to), and exactly one wins; (2) both operations write the SAME conflict document (the workspace's
// membersVersion, or the acting administrator's users document), which is what makes MongoDB abort one of two overlapping
// snapshot transactions.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { FakeMongoClient } = require("./support/fake-mongo");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { Access } = require("../src/auth/access");
const { usableWorkspaceAdmin, adminRoleHeld } = require("../src/auth/accounts");
const { createEmployees, JarcAccessIndex, AccessAdminService, profileId } = require("../src/employees");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const TENANT = "00000000-0000-4000-8000-00000000a001";
const silent = { info() {}, warn() {}, error() {} };
const ADMIN = { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"], who: "u-admin", jarcAccess: true };
const LAST_ADMIN = (e) => e.status === 400 && /needs at least one admin/.test(e.message);

async function world({ accountMode = "off", admins = [0], superAdminIndex = null, serial = false } = {}) {
  const fake = new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  if (serial) {
    const run = connection.withTransaction.bind(connection);
    let chain = Promise.resolve();
    connection.withTransaction = (fn) => { const p = chain.then(() => run(fn)); chain = p.catch(() => {}); return p; };
  }
  const dataLayer = createDataLayer({ connection, logger: silent, fileStore: new MemoryFileStore(), environment: "test" });
  const people = syntheticPeople(8, { seed: "p40lock" });
  people.forEach((d) => { d.account_enabled = true; d.user_type = "Member"; d.user_id = d.user_id.toLowerCase(); });
  const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: TENANT, viewerObjectIds: [], adminObjectIds: admins.map((i) => people[i].user_id), accessAdmin: true }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
  const employees = createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs: people }), idKey: TEST_ID_KEY, logger: silent });
  const access = new Access(dataLayer.repos, { policy: "role_based", accountMode });
  const members = dataLayer.services.members.configure({ accountMode });
  const index = new JarcAccessIndex({ repos: dataLayer.repos, access, tenantId: TENANT, employeesConfig: config, logger: silent });
  const superAdmin = superAdminIndex === null ? null : { tenantId: TENANT, objectId: people[superAdminIndex].user_id };
  const service = new AccessAdminService({ employees, jarcAccess: index, repos: dataLayer.repos, connection: dataLayer.connection, members, access, tenantId: TENANT, superAdmin, logger: silent });
  const users = connection.db.collection("users");
  const register = async (i, extra = {}) => { const doc = { _id: new ObjectId(), tenantId: TENANT, entraObjectId: people[i].user_id, source: "entra", status: "active", displayName: `Synthetic Person ${i + 1}`, createdAt: new Date(), lastLoginAt: new Date(), adminRoleClearedAt: new Date(1), ...extra }; await users.insertOne(doc); return doc; };
  const actorOf = (doc, extra = {}) => ({ userId: doc._id, kind: "entra", isSystemAdmin: false, tenantId: TENANT, entraObjectId: doc.entraObjectId, displayName: doc.displayName, ...extra });
  const workspace = async (name) => { const _id = new ObjectId(), now = new Date(); await connection.db.collection("workspaces").insertOne({ _id, name, archived: false, position: 1, createdAt: now, updatedAt: now, version: 1 }); return _id; };
  const admin = (ws, user, role = "WORKSPACE_ADMIN") => dataLayer.repos.memberships.add({ workspaceId: ws, userId: user._id, role, now: new Date() });
  const membersVersion = async (ws) => (await connection.db.collection("workspaces").findOne({ _id: ws })).membersVersion ?? 0;
  const suspend = (i, actor, extra = {}) => service.changeAccess("all", profileId(TEST_ID_KEY, people[i].user_id), { action: "suspend", expectedState: "active", expectedVersion: 0, reason: "Synthetic reason", ...extra }, ADMIN, actor);
  const revoke = (i, actor, extra = {}) => service.changeAccess("all", profileId(TEST_ID_KEY, people[i].user_id), { action: "revoke", expectedState: "active", expectedVersion: 0, reason: "Synthetic reason", confirm: "REVOKE", ...extra }, ADMIN, actor);
  const manage = (i, actor) => service.manageAccess("all", profileId(TEST_ID_KEY, people[i].user_id), ADMIN, actor);
  const statusOf = async (i) => (await users.findOne({ entraObjectId: people[i].user_id })).status;
  return { fake, connection, db: connection.db, repos: dataLayer.repos, members, service, index, people, register, actorOf, workspace, admin, membersVersion, suspend, revoke, manage, statusOf };
}

describe("usableWorkspaceAdmin and adminRoleHeld (pure)", () => {
  test("missing or non-active users never count; blocked counts zero when accounts are tracked; pending / capped only when enforced", () => {
    const u = (extra) => ({ _id: new ObjectId(), status: "active", ...extra });
    for (const mode of ["off", "staged", "enforced"]) {
      assert.equal(usableWorkspaceAdmin(null, mode), false);
      assert.equal(usableWorkspaceAdmin(u({ status: "suspended" }), mode), false);
      assert.equal(usableWorkspaceAdmin(u({ status: "revoked" }), mode), false);
      assert.equal(usableWorkspaceAdmin(u({}), mode), true, `legacy in ${mode}`);
      assert.equal(usableWorkspaceAdmin(u({ account: { status: "active", role: "ADMIN", version: 1 } }), mode), true);
    }
    const blocked = u({ account: { status: "blocked", role: "ADMIN", version: 2 } });
    assert.deepEqual(["off", "staged", "enforced"].map((m) => usableWorkspaceAdmin(blocked, m)), [true, false, false]);
    const pending = u({ account: { status: "pending", role: null, version: 1 } });
    assert.deepEqual(["off", "staged", "enforced"].map((m) => usableWorkspaceAdmin(pending, m)), [true, true, false]);
    for (const role of ["EDITOR", "VIEWER"]) assert.deepEqual(["staged", "enforced"].map((m) => usableWorkspaceAdmin(u({ account: { status: "active", role, version: 1 } }), m)), [true, false], role);
    assert.equal(usableWorkspaceAdmin(u({ account: { status: "active", role: "SUPER_ADMIN", version: 1 } }), "enforced"), true);
    assert.equal(usableWorkspaceAdmin(blocked), false, "the default reading is staged");
  });
  test("adminRoleHeld: the latest recorded sign-in decides", () => {
    const t1 = new Date(1000), t2 = new Date(2000);
    assert.equal(adminRoleHeld(null), false);
    assert.equal(adminRoleHeld({}), false);
    assert.equal(adminRoleHeld({ adminRoleSeenAt: t1 }), true);
    assert.equal(adminRoleHeld({ adminRoleSeenAt: t1, adminRoleClearedAt: t2 }), false);
    assert.equal(adminRoleHeld({ adminRoleSeenAt: t2, adminRoleClearedAt: t1 }), true);
    assert.equal(adminRoleHeld({ adminRoleSeenAt: "2026-01-01" }), false, "only a stored Date counts");
  });
});

describe("MembershipService: the last USABLE admin", () => {
  test("demote / remove refused when the only other admin is suspended (previously allowed: the row counted)", async () => {
    const w = await world();
    const a = await w.register(1), b = await w.register(2, { status: "suspended" });
    const ws = await w.workspace("Synthetic WS");
    const ma = await w.admin(ws, a); await w.admin(ws, b);
    await assert.rejects(w.members.changeRole(ws, ma._id, { role: "MEMBER" }, w.actorOf(a)), LAST_ADMIN);
    await assert.rejects(w.members.remove(ws, ma._id, w.actorOf(a)), LAST_ADMIN);
    assert.equal((await w.repos.memberships.findById(ma._id)).role, "WORKSPACE_ADMIN");
  });

  test("a co-admin whose users document is missing counts zero", async () => {
    const w = await world();
    const a = await w.register(1);
    const ws = await w.workspace("Synthetic WS");
    const ma = await w.admin(ws, a);
    await w.admin(ws, { _id: new ObjectId() });
    await assert.rejects(w.members.changeRole(ws, ma._id, { role: "VIEWER" }, w.actorOf(a)), LAST_ADMIN);
  });

  // The unique (workspaceId, userId) index prevents duplicate rows going forward; older or hand-written data could still hold
  // them, so the read is made to return every row twice.
  const duplicated = (w) => { const read = w.repos.memberships.listActiveAdmins.bind(w.repos.memberships); w.repos.memberships.listActiveAdmins = async (...args) => (await read(...args)).flatMap((r) => [r, { ...r, _id: new ObjectId() }]); };

  test("duplicate rows: a co-admin with two rows counts once; a suspended co-admin with two rows still counts zero", async () => {
    const w = await world();
    duplicated(w);
    const a = await w.register(1), b = await w.register(2), c = await w.register(3, { status: "suspended" });
    const ws = await w.workspace("Synthetic WS");
    const ma = await w.admin(ws, a);
    await w.admin(ws, b);
    assert.deepEqual(await w.members.countUsableAdmins(ws, { exceptMemberId: ma._id }), { rows: 3, usable: 2 }, "a's twin row and b's two rows: two people");
    assert.deepEqual(await w.members.countUsableAdmins(ws, { exceptUserId: a._id }), { rows: 2, usable: 1 });
    const ws2 = await w.workspace("Synthetic WS 2");
    await w.admin(ws2, a); await w.admin(ws2, c);
    assert.deepEqual(await w.members.countUsableAdmins(ws2, { exceptUserId: a._id }), { rows: 2, usable: 0 });
    await assert.rejects(w.suspend(1, w.actorOf(b)), (e) => e.code === "LAST_USABLE_WORKSPACE_ADMIN" && e.details.workspaces.join() === "Synthetic WS 2");
  });

  test("ACCOUNT_MANAGEMENT: blocked co-admin counts zero when tracked; under enforced an EDITOR-capped or pending co-admin too", async () => {
    for (const [mode, other, refused] of [["off", { account: { status: "blocked", role: "ADMIN", version: 1 } }, false], ["staged", { account: { status: "blocked", role: "ADMIN", version: 1 } }, true],
      ["staged", { account: { status: "active", role: "EDITOR", version: 1 } }, false], ["enforced", { account: { status: "active", role: "EDITOR", version: 1 } }, true], ["enforced", { account: { status: "pending", role: null, version: 1 } }, true]]) {
      const w = await world({ accountMode: mode });
      const a = await w.register(1), b = await w.register(2, other);
      const ws = await w.workspace("Synthetic WS");
      const ma = await w.admin(ws, a); await w.admin(ws, b);
      const run = w.members.changeRole(ws, ma._id, { role: "MEMBER" }, w.actorOf(a));
      if (refused) await assert.rejects(run, LAST_ADMIN, `${mode} ${JSON.stringify(other)}`); else await run;
    }
  });

  test("D-H1 strict: an already-unusable admin row can't be removed or demoted while no usable admin remains; with one, it can", async () => {
    const w = await world();
    const a = await w.register(1, { status: "suspended" }), b = await w.register(2, { status: "revoked" });
    const ws = await w.workspace("Synthetic WS");
    const ma = await w.admin(ws, a); const mb = await w.admin(ws, b);
    await assert.rejects(w.members.remove(ws, ma._id, w.actorOf(b)), LAST_ADMIN, "no usable admin would remain (and none does now)");
    await assert.rejects(w.members.changeRole(ws, mb._id, { role: "VIEWER" }, w.actorOf(b)), LAST_ADMIN);
    const c = await w.register(3);
    await w.admin(ws, c);
    await w.members.remove(ws, ma._id, w.actorOf(c));
    await w.members.changeRole(ws, mb._id, { role: "VIEWER" }, w.actorOf(c));
    assert.deepEqual(await w.members.countUsableAdmins(ws), { rows: 1, usable: 1 });
  });

  test("unchanged: demote with another usable admin works; non-admin changes are never counted", async () => {
    const w = await world();
    const a = await w.register(1), b = await w.register(2), c = await w.register(3);
    const ws = await w.workspace("Synthetic WS");
    const ma = await w.admin(ws, a); await w.admin(ws, b); const mc = await w.admin(ws, c, "MEMBER");
    await w.members.changeRole(ws, ma._id, { role: "MEMBER" }, w.actorOf(b));
    await w.members.remove(ws, mc._id, w.actorOf(b));
    assert.equal(await w.membersVersion(ws), 2, "each change touched the workspace (the conflict point)");
  });
});

describe("P3 suspend / revoke: LAST_USABLE_WORKSPACE_ADMIN", () => {
  test("the last usable owner: suspend and revoke refused with 409, naming the workspaces; nothing changes; refusal audited", async () => {
    const w = await world();
    const me = await w.register(0);
    const target = await w.register(3);
    const co = await w.register(4, { status: "suspended" }); // an already-suspended co-admin doesn't count
    const wsA = await w.workspace("Synthetic Alpha"), wsB = await w.workspace("Synthetic Beta"), wsC = await w.workspace("Synthetic Gamma");
    await w.admin(wsA, target); await w.admin(wsA, co);
    await w.admin(wsB, target);
    await w.admin(wsC, target); await w.admin(wsC, me); // wsC keeps a usable admin
    const view = await w.manage(3, w.actorOf(me));
    for (const a of ["suspend", "revoke"]) {
      const action = view.actions.find((x) => x.action === a);
      assert.equal(action.allowed, false, a);
      assert.equal(action.code, "LAST_USABLE_WORKSPACE_ADMIN");
      assert.match(action.reason, /Synthetic Alpha, Synthetic Beta/);
    }
    const warning = view.warnings.find((x) => x.code === "LAST_WORKSPACE_ADMIN_OF");
    assert.deepEqual(warning.workspaces, ["Synthetic Alpha", "Synthetic Beta"], "the warning stays");
    for (const run of [() => w.suspend(3, w.actorOf(me)), () => w.revoke(3, w.actorOf(me))]) {
      await assert.rejects(run(), (e) => e.status === 409 && e.code === "LAST_USABLE_WORKSPACE_ADMIN" && e.details.workspaces.join("|") === "Synthetic Alpha|Synthetic Beta" && /Synthetic Alpha, Synthetic Beta/.test(e.message));
    }
    assert.equal(await w.statusOf(3), "active");
    const rejected = await w.db.collection("accountAudit").find({ action: "employee.access.rejected", code: "LAST_USABLE_WORKSPACE_ADMIN" }).toArray();
    assert.deepEqual(rejected.map((r) => r.attempted), ["suspend", "revoke"]);
    assert.equal(await w.db.collection("accountAudit").countDocuments({ action: "employee.access.suspended" }), 0);
  });

  test("a co-admin whose users document is missing doesn't save the workspace; a usable co-admin does", async () => {
    const w = await world();
    const me = await w.register(0);
    const target = await w.register(3);
    const ws = await w.workspace("Synthetic WS");
    await w.admin(ws, target); await w.admin(ws, { _id: new ObjectId() });
    await assert.rejects(w.suspend(3, w.actorOf(me)), (e) => e.code === "LAST_USABLE_WORKSPACE_ADMIN");
    await w.admin(ws, await w.register(5));
    const before = await w.membersVersion(ws);
    const res = await w.suspend(3, w.actorOf(me));
    assert.equal(res.result.to, "suspended");
    assert.equal(await w.membersVersion(ws), before + 1, "the suspend touched the workspace it checked");
  });

  test("not an admin anywhere, or already suspended: P3 is unchanged (suspend, restore, revoke of a suspended admin)", async () => {
    const w = await world();
    const me = await w.register(0);
    await w.register(3);
    assert.equal((await w.suspend(3, w.actorOf(me))).result.to, "suspended");
    // Person 4: the only (but already suspended) admin of a workspace: revoking removes nothing usable, so it is allowed.
    const p4 = await w.register(4, { status: "suspended" });
    const ws = await w.workspace("Synthetic WS");
    await w.admin(ws, p4);
    const res = await w.service.changeAccess("all", profileId(TEST_ID_KEY, w.people[4].user_id), { action: "revoke", expectedState: "suspended", expectedVersion: 0, reason: "Synthetic reason", confirm: "REVOKE" }, ADMIN, w.actorOf(me));
    assert.equal(res.result.to, "revoked");
    // Restoring person 3 is never guarded.
    const v = (await w.db.collection("users").findOne({ entraObjectId: w.people[3].user_id })).accessVersion;
    assert.equal((await w.service.changeAccess("all", profileId(TEST_ID_KEY, w.people[3].user_id), { action: "restore", expectedState: "suspended", expectedVersion: v }, ADMIN, w.actorOf(me))).result.to, "active");
  });

  test("P3 membership routes use the usable count too (demote refused when the co-admin is suspended)", async () => {
    const w = await world();
    const me = await w.register(0);
    const target = await w.register(3), co = await w.register(4, { status: "suspended" });
    const ws = await w.workspace("Synthetic WS");
    await w.admin(ws, target); await w.admin(ws, co);
    const ref = (await w.manage(3, w.actorOf(me, { isSystemAdmin: true }))).workspaces.find((x) => x.name === "Synthetic WS");
    assert.equal(ref.lastAdmin, true, "the row says it can't be demoted");
    await assert.rejects(w.service.changeMembership("all", profileId(TEST_ID_KEY, w.people[3].user_id), ref.workspaceRef, { role: "MEMBER" }, ADMIN, w.actorOf(me, { isSystemAdmin: true })), (e) => e.code === "LAST_WORKSPACE_ADMIN");
  });
});

describe("concurrency: status changes and membership changes conflict", () => {
  test("concurrent demote + suspend of the two usable admins: exactly one wins, the workspace keeps a usable admin", async () => {
    const w = await world({ serial: true });
    const me = await w.register(0);
    const a = await w.register(3), b = await w.register(4);
    const ws = await w.workspace("Synthetic WS");
    await w.admin(ws, a); const mb = await w.admin(ws, b);
    const touched = [];
    const original = w.repos.workspaces.touchMembers.bind(w.repos.workspaces);
    w.repos.workspaces.touchMembers = async (id, o) => { touched.push(String(id)); return original(id, o); };
    const results = await Promise.allSettled([w.suspend(3, w.actorOf(me)), w.members.changeRole(ws, mb._id, { role: "MEMBER" }, w.actorOf(me))]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    const lost = results.find((r) => r.status === "rejected").reason;
    assert.ok(lost.code === "LAST_USABLE_WORKSPACE_ADMIN" || LAST_ADMIN(lost), String(lost?.code));
    assert.deepEqual(await w.members.countUsableAdmins(ws), { rows: (await w.repos.memberships.countActiveAdmins(ws)), usable: 1 });
    assert.deepEqual(touched, [String(ws), String(ws)], "both transactions write the same workspace document (MongoDB WriteConflict)");
  });

  test("concurrent suspensions of two co-admins by two administrators: one is refused", async () => {
    const w = await world({ serial: true, admins: [0, 1] });
    const x = await w.register(0), y = await w.register(1);
    const a = await w.register(3), b = await w.register(4);
    const ws = await w.workspace("Synthetic WS");
    await w.admin(ws, a); await w.admin(ws, b);
    const results = await Promise.allSettled([w.suspend(3, w.actorOf(x)), w.suspend(4, w.actorOf(y))]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(results.find((r) => r.status === "rejected").reason.code, "LAST_USABLE_WORKSPACE_ADMIN");
    assert.equal(await w.membersVersion(ws), 1, "only the winner's touch committed (the loser rolled back)");
  });
});

describe("P3 suspend / revoke: TARGET_JARC_ADMIN", () => {
  test("an active Super Admin account: refused, even by an administrator who is a JARC administrator", async () => {
    const w = await world({ accountMode: "staged" });
    const me = await w.register(0);
    await w.register(3, { account: { status: "active", role: "SUPER_ADMIN", version: 1 } });
    for (const actor of [w.actorOf(me), w.actorOf(me, { isSystemAdmin: true })]) {
      await assert.rejects(w.suspend(3, actor), (e) => e.status === 409 && e.code === "TARGET_JARC_ADMIN");
      await assert.rejects(w.revoke(3, actor), (e) => e.code === "TARGET_JARC_ADMIN");
    }
    const view = await w.manage(3, w.actorOf(me));
    assert.equal(view.actions.find((a) => a.action === "suspend").code, "TARGET_JARC_ADMIN");
    assert.ok(view.warnings.some((x) => x.code === "TARGET_JARC_ADMIN"), "the warning stays");
    assert.equal(await w.statusOf(3), "active");
  });

  test("the configured JARC_SUPER_ADMIN identity: refused (no account needed)", async () => {
    const w = await world({ superAdminIndex: 3 });
    const me = await w.register(0);
    await w.register(3);
    await assert.rejects(w.suspend(3, w.actorOf(me, { isSystemAdmin: true })), (e) => e.code === "TARGET_JARC_ADMIN");
    // Someone else is not protected by it.
    await w.register(5);
    assert.equal((await w.suspend(5, w.actorOf(me))).result.to, "suspended");
  });

  test("the JARC.Admin role seen at the last sign-in: refused for every administrator, a fresh JARC administrator included (D-H2 a)", async () => {
    const w = await world();
    const me = await w.register(0);
    await w.register(3, { adminRoleSeenAt: new Date() });
    for (const actor of [w.actorOf(me), w.actorOf(me, { isSystemAdmin: true })]) {
      await assert.rejects(w.suspend(3, actor), (e) => e.status === 409 && e.code === "TARGET_JARC_ADMIN" && e.details.basis === "role" && /last sign-in/.test(e.message) && /not a live check/.test(e.message));
      await assert.rejects(w.revoke(3, actor), (e) => e.code === "TARGET_JARC_ADMIN");
      const view = await w.manage(3, actor);
      for (const a of ["suspend", "revoke"]) assert.equal(view.actions.find((x) => x.action === a).code, "TARGET_JARC_ADMIN", a);
      assert.equal(view.account.jarcAdministrator, "role");
      assert.equal(view.account.jarcAdministratorLabel, "JARC administrator role seen at their last sign-in");
    }
    assert.equal(await w.statusOf(3), "active");
  });

  test("the role no longer seen at a later sign-in: not protected", async () => {
    const w = await world();
    const me = await w.register(0);
    await w.register(3, { adminRoleSeenAt: new Date(1000), adminRoleClearedAt: new Date(2000) });
    assert.equal((await w.suspend(3, w.actorOf(me))).result.to, "suspended");
  });

  test("a live session carrying JARC.Admin (the access index; sessions from before adminRoleSeenAt existed): refused", async () => {
    const w = await world();
    const me = await w.register(0);
    const t = await w.register(3);
    const now = Date.now();
    await w.db.collection("sessions").insertOne({ _id: "synthetic-session-hash", userId: t._id, tenantId: TENANT, objectId: t.entraObjectId, isSystemAdmin: true, createdAt: new Date(now), lastSeenAt: new Date(now), idleExpiresAt: new Date(now + 3600000), expiresAt: new Date(now + 7200000) });
    w.index.invalidate();
    await assert.rejects(w.suspend(3, w.actorOf(me)), (e) => e.code === "TARGET_JARC_ADMIN");
  });

  test("an already-suspended JARC administrator can still be revoked (nothing usable is removed)", async () => {
    const w = await world();
    const me = await w.register(0);
    await w.register(3, { status: "suspended", adminRoleSeenAt: new Date() });
    const res = await w.service.changeAccess("all", profileId(TEST_ID_KEY, w.people[3].user_id), { action: "revoke", expectedState: "suspended", expectedVersion: 0, reason: "Synthetic reason", confirm: "REVOKE" }, ADMIN, w.actorOf(me));
    assert.equal(res.result.to, "revoked");
  });

  test("concurrent: two JARC administrators suspending / revoking each other: both refused, both stay active", async () => {
    const w = await world({ serial: true, admins: [3, 4] });
    const a = await w.register(3, { adminRoleSeenAt: new Date() }), b = await w.register(4, { adminRoleSeenAt: new Date() });
    const results = await Promise.allSettled([w.suspend(4, w.actorOf(a, { isSystemAdmin: true })), w.revoke(3, w.actorOf(b, { isSystemAdmin: true }))]);
    assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
    assert.deepEqual(results.map((r) => r.reason.code), ["TARGET_JARC_ADMIN", "TARGET_JARC_ADMIN"]);
    assert.deepEqual([await w.statusOf(3), await w.statusOf(4)], ["active", "active"]);
  });

  test("concurrent: two Employee Management administrators (known non-JARC administrators) suspending each other: the second is refused", async () => {
    const w = await world({ serial: true, admins: [3, 4] });
    const a = await w.register(3), b = await w.register(4);
    const results = await Promise.allSettled([w.suspend(4, w.actorOf(a)), w.suspend(3, w.actorOf(b))]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(results.find((r) => r.status === "rejected").reason.code, "EMPLOYEES_FORBIDDEN");
    assert.deepEqual([await w.statusOf(3), await w.statusOf(4)].sort(), ["active", "suspended"]);
  });

  test("ordinary targets are unaffected; grant / restore never consult the guards", async () => {
    const w = await world();
    const me = await w.register(0);
    await w.register(3);
    assert.equal((await w.revoke(3, w.actorOf(me))).result.to, "revoked");
    const res = await w.service.changeAccess("all", profileId(TEST_ID_KEY, w.people[6].user_id), { action: "grant", expectedState: "not_registered", expectedVersion: 0 }, ADMIN, w.actorOf(me));
    assert.equal(res.result.to, "active");
  });
});
