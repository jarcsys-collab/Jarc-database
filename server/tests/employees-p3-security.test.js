// Employee Management P3 (Access Administration): security probes at the service and repository level (no HTTP), on JARC's
// real data layer over the in-memory FakeMongoClient and the read-only fake directory. Synthetic people only, invented IDs.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { FakeMongoClient } = require("./support/fake-mongo");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { Access } = require("../src/auth/access");
const { createEmployees, JarcAccessIndex, AccessAdminService, profileId } = require("../src/employees");
const { TRANSITIONS } = require("../src/employees/access-admin");
const { AccountAuditRepository, EMPLOYEE_ACTIONS } = require("../src/repositories/mongo/account-audit-repository");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const TENANT = "00000000-0000-4000-8000-00000000a001";
const silent = { info() {}, warn() {}, error() {} };
const ADMIN = { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"], who: "u-admin", jarcAccess: true };

async function world({ policy = "development_shared", admins = [0] } = {}) {
  const fake = new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const dataLayer = createDataLayer({ connection, logger: silent, fileStore: new MemoryFileStore(), environment: "test" });
  const people = syntheticPeople(6, { seed: "p3sec" });
  people.forEach((d) => { d.account_enabled = true; d.user_type = "Member"; d.user_id = d.user_id.toLowerCase(); });
  const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: TENANT, viewerObjectIds: [], adminObjectIds: admins.map((i) => people[i].user_id), accessAdmin: true }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
  const employees = createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs: people }), idKey: TEST_ID_KEY, logger: silent });
  const access = new Access(dataLayer.repos, { policy });
  const index = new JarcAccessIndex({ repos: dataLayer.repos, access, tenantId: TENANT, employeesConfig: config, logger: silent });
  const service = new AccessAdminService({ employees, jarcAccess: index, repos: dataLayer.repos, connection: dataLayer.connection, members: dataLayer.services.members, access, tenantId: TENANT, logger: silent });
  const users = connection.db.collection("users");
  const register = async (i, extra = {}) => { const doc = { _id: new ObjectId(), tenantId: TENANT, entraObjectId: people[i].user_id, source: "entra", status: "active", displayName: `Synthetic Person ${i + 1}`, createdAt: new Date(), lastLoginAt: new Date(), ...extra }; await users.insertOne(doc); return doc; };
  const actorOf = (doc) => ({ userId: doc._id, kind: "entra", isSystemAdmin: false, tenantId: TENANT, entraObjectId: doc.entraObjectId, displayName: doc.displayName });
  return { fake, db: connection.db, repos: dataLayer.repos, people, service, index, employees, register, actorOf, idOf: (i) => profileId(TEST_ID_KEY, people[i].user_id) };
}

describe("state machine and guards", () => {
  test("the transition table is exactly the contract's (§2), plus restore / revoke for a status written outside P3", () => {
    const legal = Object.fromEntries(Object.entries(TRANSITIONS).map(([s, t]) => [s, Object.entries(t).map(([a, to]) => `${a}→${to}`)]));
    assert.deepEqual(legal, {
      not_registered: ["grant→active", "revoke→revoked"], active: ["suspend→suspended", "revoke→revoked"], suspended: ["restore→active", "revoke→revoked"],
      revoked: ["grant→active"], disabled: ["restore→active", "revoke→revoked"]
    });
  });

  test("refusal(): self-lockout first, then the last Employee Management administrator", async () => {
    const w = await world();
    assert.equal(w.service.refusal("suspend", { state: "active", isSelf: true, isEmployeeAdmin: true, othersActive: 0 }), "SELF_LOCKOUT");
    assert.equal(w.service.refusal("revoke", { state: "active", isSelf: false, isEmployeeAdmin: true, othersActive: 0 }), "LAST_EMPLOYEE_ADMIN");
    assert.equal(w.service.refusal("suspend", { state: "active", isSelf: false, isEmployeeAdmin: true, othersActive: 1 }), null);
    assert.equal(w.service.refusal("restore", { state: "suspended", isSelf: true, isEmployeeAdmin: true, othersActive: 0 }), null, "restore is never a lockout");
  });

  test("LAST_EMPLOYEE_ADMIN in a write: the other listed administrator is suspended, so suspending this one is refused", async () => {
    const w = await world({ admins: [0, 1, 2] });
    const actorDoc = await w.register(0);
    await w.register(1);
    await w.register(2, { status: "suspended" });
    // The actor leaves the list (it is read on every request); the remaining listed admins are person 1 (active) and person 2
    // (suspended), so suspending person 1 would leave no active listed administrator.
    w.employees.config.adminObjectIds.splice(0, 1);
    const v = await w.service.manageAccess("all", w.idOf(1), ADMIN, w.actorOf(actorDoc));
    assert.equal(v.account.isEmployeeAdmin, true);
    assert.equal(v.actions.find((a) => a.action === "suspend").code, "LAST_EMPLOYEE_ADMIN");
    await assert.rejects(w.service.changeAccess("all", w.idOf(1), { action: "suspend", expectedState: "active", expectedVersion: 0, reason: "Synthetic" }, ADMIN, w.actorOf(actorDoc)), (e) => e.status === 409 && e.code === "LAST_EMPLOYEE_ADMIN");
    assert.equal((await w.db.collection("users").findOne({ entraObjectId: w.people[1].user_id })).status, "active");
  });

  test("the acting administrator is re-checked inside the transaction: a suspended administrator can't act", async () => {
    const w = await world();
    const actorDoc = await w.register(0, { status: "suspended" });
    await assert.rejects(w.service.changeAccess("all", w.idOf(3), { action: "grant", expectedState: "not_registered", expectedVersion: 0 }, ADMIN, w.actorOf(actorDoc)), (e) => e.status === 403 && e.code === "EMPLOYEES_FORBIDDEN");
    assert.equal(await w.db.collection("users").countDocuments({ entraObjectId: w.people[3].user_id }), 0, "nothing provisioned");
  });

  test("a failed write inside the transaction rolls back the status change and the audit entry", async () => {
    const w = await world();
    const actorDoc = await w.register(0);
    await w.register(3);
    w.fake.failNext({ collection: "accountAudit", op: "insertOne", error: Object.assign(new Error("synthetic"), { name: "MongoNetworkError" }) });
    await assert.rejects(w.service.changeAccess("all", w.idOf(3), { action: "suspend", expectedState: "active", expectedVersion: 0, reason: "Synthetic" }, ADMIN, w.actorOf(actorDoc)));
    assert.equal((await w.db.collection("users").findOne({ entraObjectId: w.people[3].user_id })).status, "active");
  });

  test("a mixed-case or other-tenant identity is never treated as this person (lower-case exact match only)", async () => {
    const w = await world();
    const actorDoc = await w.register(0);
    await w.db.collection("users").insertOne({ _id: new ObjectId(), tenantId: TENANT, entraObjectId: w.people[4].user_id.toUpperCase(), source: "entra", status: "active", createdAt: new Date() });
    const v = await w.service.manageAccess("all", w.idOf(4), ADMIN, w.actorOf(actorDoc));
    assert.equal(v.account.state, "not_registered");
  });

  test("a membership change and its accountAudit entry are one transaction: a failed audit write leaves no membership", async () => {
    const w = await world();
    const actorDoc = await w.register(0);
    await w.register(3);
    const ws = new ObjectId(), now = new Date();
    await w.db.collection("workspaces").insertOne({ _id: ws, name: "Synthetic WS", archived: false, position: 1, createdAt: now, updatedAt: now, version: 1 });
    const actor = { ...w.actorOf(actorDoc), isSystemAdmin: true };
    const ref = (await w.service.manageAccess("all", w.idOf(3), ADMIN, actor)).workspaces[0].workspaceRef;
    w.fake.failNext({ collection: "accountAudit", op: "insertOne", error: Object.assign(new Error("synthetic"), { name: "MongoNetworkError" }) });
    await assert.rejects(w.service.addMembership("all", w.idOf(3), { workspaceRef: ref, role: "MEMBER" }, ADMIN, actor));
    assert.equal(await w.db.collection("workspaceMembers").countDocuments({ workspaceId: ws }), 0);
    assert.equal(await w.db.collection("activities").countDocuments({ action: "member.added" }), 0);
    const ok = await w.service.addMembership("all", w.idOf(3), { workspaceRef: ref, role: "MEMBER" }, ADMIN, actor);
    assert.equal(ok.manageAccess.workspaces[0].membership.role, "MEMBER");
    assert.equal(await w.db.collection("accountAudit").countDocuments({ action: "employee.membership.added" }), 1);
  });
});

describe("design warnings (not refusals)", () => {
  test("TARGET_GUEST for a guest account; TARGET_JARC_ADMIN for a live JARC.Admin session or an active Super Admin", async () => {
    const w = await world();
    w.people[4].user_type = "Guest";
    const actorDoc = await w.register(0);
    const guest = (await w.service.manageAccess("all", w.idOf(4), ADMIN, w.actorOf(actorDoc))).warnings.map((x) => x.code);
    assert.ok(guest.includes("TARGET_GUEST"));
    assert.ok(guest.includes("SHARED_FIRST_SIGN_IN"));
    const admin = await w.register(3);
    const t = Date.now();
    await w.db.collection("sessions").insertOne({ _id: "synthetic-session-hash", userId: admin._id, tenantId: TENANT, objectId: admin.entraObjectId, isSystemAdmin: true, createdAt: new Date(t), lastSeenAt: new Date(t), idleExpiresAt: new Date(t + 3600000), expiresAt: new Date(t + 7200000) });
    w.index.invalidate();
    const v = await w.service.manageAccess("all", w.idOf(3), ADMIN, w.actorOf(actorDoc));
    assert.ok(v.warnings.some((x) => x.code === "TARGET_JARC_ADMIN"));
    // P4-0: TARGET_JARC_ADMIN is now also a refusal (409), unless the acting administrator is a JARC administrator themselves
    // (a JARC.Admin role holder only).
    const suspend = v.actions.find((a) => a.action === "suspend");
    assert.equal(suspend.allowed, false, "P4-0: a warning and a refusal");
    assert.equal(suspend.code, "TARGET_JARC_ADMIN");
    assert.equal((await w.service.manageAccess("all", w.idOf(3), ADMIN, { ...w.actorOf(actorDoc), isSystemAdmin: true })).actions.find((a) => a.action === "suspend").allowed, true, "a JARC administrator may still suspend a JARC.Admin holder");
    const superAdmin = await w.register(5, { account: { status: "active", role: "SUPER_ADMIN", version: 1 } });
    assert.ok(superAdmin);
    assert.ok((await w.service.manageAccess("all", w.idOf(5), ADMIN, w.actorOf(actorDoc))).warnings.some((x) => x.code === "TARGET_JARC_ADMIN"));
    assert.ok(!(await w.service.manageAccess("all", w.idOf(1), ADMIN, w.actorOf(actorDoc))).warnings.some((x) => x.code === "TARGET_JARC_ADMIN" || x.code === "TARGET_GUEST"));
  });

  test("the after-commit token sweep revokes a token issued during the race (audited the same way)", async () => {
    const w = await world();
    const actorDoc = await w.register(0);
    const target = await w.register(3);
    // A token that appears only after the transaction's own sweep: inserted when the sessions are ended (right after commit).
    const orig = w.repos.sessions.removeForUser.bind(w.repos.sessions);
    w.repos.sessions.removeForUser = async (id) => {
      await w.db.collection("apiTokens").insertOne({ _id: new ObjectId(), publicId: "late", ownerUserId: target._id, product: "fabric", createdAt: new Date(), expiresAt: new Date(Date.now() + 86400000), revokedAt: null, scopes: [] });
      return orig(id);
    };
    const res = await w.service.changeAccess("all", w.idOf(3), { action: "revoke", expectedState: "active", expectedVersion: 0, reason: "Synthetic", confirm: "REVOKE" }, ADMIN, w.actorOf(actorDoc));
    assert.deepEqual(res.result.tokensRevoked, { jarc: 0, fabric: 1 });
    assert.ok((await w.db.collection("apiTokens").findOne({ publicId: "late" })).revokedAt instanceof Date);
    assert.equal(await w.db.collection("apiTokenAudit").countDocuments({ action: "token.revoked", product: "fabric" }), 1);
  });
});

describe("audit repository (append-only, allow-listed)", () => {
  test("only the P3 fields with valid values are stored; anything else throws; no update or delete method exists", async () => {
    const w = await world();
    const repo = w.repos.accountAudit;
    for (const a of EMPLOYEE_ACTIONS) await repo.append({ action: a, targetUserId: null, result: "ok", source: "employee_management", targetRef: "A".repeat(22) });
    for (const bad of [{ secret: "x" }, { result: "maybe" }, { reason: "a\nb" }, { reason: "x".repeat(501) }, { code: "lower" }, { source: "elsewhere" }, { targetRef: "short" }, { attempted: "delete_everything" }]) {
      await assert.rejects(repo.append({ action: "employee.access.rejected", targetUserId: null, ...bad }), TypeError, JSON.stringify(bad));
    }
    await assert.rejects(repo.append({ action: "employee.access.nuked", targetUserId: null }), TypeError);
    const methods = Object.getOwnPropertyNames(AccountAuditRepository.prototype).filter((m) => m !== "constructor").sort();
    assert.deepEqual(methods, ["append", "listForTarget", "listForUser"]);
  });
});

describe("opaque references", () => {
  test("workspaceRef is 22 characters, stable, per workspace, and not the ObjectId", async () => {
    const w = await world();
    const id = new ObjectId();
    const a = w.service.workspaceRef(id), b = w.service.workspaceRef(id), c = w.service.workspaceRef(new ObjectId());
    assert.match(a, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(a, b); assert.notEqual(a, c);
    assert.ok(!a.includes(id.toHexString().slice(0, 8)));
    // Another key gives another reference (the profile-ID key is the secret).
    assert.notEqual(crypto.createHmac("sha256", Buffer.alloc(32, 1)).update(id.toHexString()).digest("base64url").slice(0, 22), a);
  });

  test("history cursors are encrypted and bound to the person: tampered, oversized, foreign or replayed-elsewhere cursors are 400", async () => {
    const w = await world();
    const entry = { at: new Date(), _id: new ObjectId() };
    const ref = w.idOf(1);
    const cursor = w.service.encodeCursor(entry, ref);
    assert.ok(!Buffer.from(cursor, "base64url").toString("latin1").includes(entry._id.toHexString()), "the entry ID isn't readable");
    assert.deepEqual(w.service.decodeCursor(cursor, ref), { at: entry.at, id: entry._id });
    const flipped = cursor.slice(0, 20) + (cursor[20] === "A" ? "B" : "A") + cursor.slice(21);
    for (const bad of [cursor.slice(1), flipped, "x".repeat(201), "not/base64", Buffer.from(JSON.stringify({ t: 1, i: entry._id.toHexString() })).toString("base64url")]) {
      assert.throws(() => w.service.decodeCursor(bad, ref), (e) => e.status === 400, bad.slice(0, 20));
    }
    assert.throws(() => w.service.decodeCursor(cursor, w.idOf(2)), (e) => e.status === 400);
  });
});

describe("router gates (stub service)", () => {
  test("at most 2 writes of one administrator at once (the 3rd is 429), reads unaffected; P3 paths never reach the GET-only guard", async () => {
    const express = require("express");
    const { employeeRoutes } = require("../src/employees");
    let release;
    const gate = new Promise((r) => { release = r; });
    const stub = {
      manageAccess: async () => ({ ok: true }), history: async () => ({ items: [], nextBefore: null }),
      changeAccess: async () => { await gate; return { manageAccess: {} }; }, addMembership: async () => ({}), changeMembership: async () => ({}), removeMembership: async () => ({})
    };
    const employees = { service: { dataset: () => ({}) }, accessFor: () => ({ view: true, admin: true, datasets: ["all"], jarcAccess: true }) };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.actor = { userId: "synthetic", kind: "entra" }; next(); });
    app.use(employeeRoutes({ employees, jarcAccess: { current: async () => ({}) }, accessAdmin: stub, writeLimiter: () => true, logger: silent }));
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const post = () => fetch(`${url}/all/records/${"A".repeat(22)}/access`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const first = [post(), post()];
      await new Promise((r) => setTimeout(r, 50));
      assert.equal((await post()).status, 429);
      assert.equal((await fetch(`${url}/all/records/${"A".repeat(22)}/manage-access`)).status, 200, "reads have their own budget");
      release();
      assert.deepEqual((await Promise.all(first)).map((r) => r.status), [200, 200]);
      assert.equal((await post()).status, 200, "released after the responses closed");
      assert.equal((await fetch(`${url}/all/records/${"A".repeat(22)}/access`, { method: "PUT" })).status, 405);
      assert.equal((await fetch(`${url}/all/records/${"A".repeat(22)}`, { method: "POST" })).status, 405, "the data routes stay read-only");
    } finally { await new Promise((r) => server.close(r)); }
  });
});

describe("P2 integration", () => {
  test("labels: Active / Suspended / Revoked / Disabled in JARC; Provisioned (not signed in yet) with registeredAt null", async () => {
    const w = await world();
    await w.register(1, { status: "suspended" });
    await w.register(2, { status: "revoked" });
    await w.register(3, { status: "disabled" });
    await w.register(4, { lastLoginAt: undefined, provisionedAt: new Date() });
    await w.register(5);
    const snap = await w.employees.snapshot.current();
    const rows = w.index.joined(snap, await w.index.current()).byId;
    const v = (i) => rows.get(w.idOf(i)).values;
    assert.deepEqual([1, 2, 3, 4, 5].map((i) => v(i).jarcStatus), ["Suspended", "Revoked", "Disabled in JARC", "Active", "Active"]);
    assert.equal(v(4).jarcAccount, "Provisioned (not signed in yet)");
    assert.equal(v(4).jarcRegistered, null);
    assert.equal(v(5).jarcAccount, "Registered");
    assert.ok(v(5).jarcRegistered instanceof Date);
    const d = w.index.detail(snap, await w.index.current(), snap.byId.get(w.idOf(1)));
    assert.equal(d.account.status, "suspended");
    assert.ok(d.notes.some((n) => /suspended/.test(n)));
  });

  test("invalidate(): the next read rebuilds; a refresh running during a write is followed by another", async () => {
    const w = await world();
    let reads = 0;
    const orig = w.repos.users.listEntraForAccessIndex.bind(w.repos.users);
    w.repos.users.listEntraForAccessIndex = async () => { reads += 1; return orig(); };
    await w.index.current(); await w.index.current();
    assert.equal(reads, 1, "cached within the TTL");
    w.index.invalidate();
    await w.index.current();
    assert.equal(reads, 2);
    const running = w.index.refresh();
    w.index.invalidate();
    await running;
    await w.index.current();
    assert.equal(reads, 4, "the refresh that started before the write doesn't count as fresh");
  });
});
