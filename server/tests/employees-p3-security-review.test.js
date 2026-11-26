// Independent security review probes for Employee Management P3 (Access Administration) and the System Health viewer.
// Synthetic people only, invented IDs, in-memory FakeMongoClient. Each test states what it demonstrates; tests named
// "FIXED" reproduce a review finding and assert the fixed behaviour (they were "FINDING" tests that passed while the weakness
// existed).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { SessionClient, startApp } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FakeMongoClient } = require("./support/fake-mongo");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { Access } = require("../src/auth/access");
const { accountOf } = require("../src/auth/accounts");
const { createEntraVerifier } = require("../src/auth/entra-token");
const { createEmployees, JarcAccessIndex, AccessAdminService, profileId } = require("../src/employees");
const { viewerView } = require("../src/routes/system-health");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const TENANT = "00000000-0000-4000-8000-00000000a001";
const silent = { info() {}, warn() {}, error() {} };
const ADMIN = { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"], who: "u-admin", jarcAccess: true };

async function world({ policy = "development_shared", admins = [0], accountMode } = {}) {
  const fake = new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const dataLayer = createDataLayer({ connection, logger: silent, fileStore: new MemoryFileStore(), environment: "test" });
  const people = syntheticPeople(6, { seed: "p3review" });
  people.forEach((d) => { d.account_enabled = true; d.user_type = "Member"; d.user_id = d.user_id.toLowerCase(); });
  const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: TENANT, viewerObjectIds: [], adminObjectIds: admins.map((i) => people[i].user_id), accessAdmin: true }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
  const employees = createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs: people }), idKey: TEST_ID_KEY, logger: silent });
  const access = new Access(dataLayer.repos, { policy, ...(accountMode ? { accountMode } : {}) });
  const index = new JarcAccessIndex({ repos: dataLayer.repos, access, tenantId: TENANT, employeesConfig: config, logger: silent });
  const service = new AccessAdminService({ employees, jarcAccess: index, repos: dataLayer.repos, connection: dataLayer.connection, members: dataLayer.services.members, access, tenantId: TENANT, logger: silent });
  const users = connection.db.collection("users");
  const register = async (i, extra = {}) => { const doc = { _id: new ObjectId(), tenantId: TENANT, entraObjectId: people[i].user_id, source: "entra", status: "active", displayName: `Synthetic Person ${i + 1}`, createdAt: new Date(), lastLoginAt: new Date(), ...extra }; await users.insertOne(doc); return doc; };
  const actorOf = (doc) => ({ userId: doc._id, kind: "entra", isSystemAdmin: false, tenantId: TENANT, entraObjectId: doc.entraObjectId, displayName: doc.displayName });
  return { db: connection.db, repos: dataLayer.repos, people, service, register, actorOf, idOf: (i) => profileId(TEST_ID_KEY, people[i].user_id) };
}

describe("service-level probes", () => {
  test("FIXED (1): Grant pre-provisions a PENDING account (account.created recorded) when Account Management is staged or enforced", async () => {
    for (const accountMode of ["staged", "enforced"]) {
      const w = await world({ accountMode });
      const me = await w.register(0);
      await w.service.changeAccess("all", w.idOf(3), { action: "grant", expectedState: "not_registered", expectedVersion: 0 }, ADMIN, w.actorOf(me));
      const doc = await w.db.collection("users").findOne({ entraObjectId: w.people[3].user_id });
      assert.equal(doc.status, "active", accountMode);
      assert.deepEqual([doc.account.status, doc.account.role, doc.account.version], ["pending", null, 1], accountMode);
      assert.equal(accountOf(doc).legacy, false, accountMode);
      const created = await w.db.collection("accountAudit").find({ action: "account.created", targetUserId: doc._id }).toArray();
      assert.equal(created.length, 1, accountMode);
      assert.deepEqual(created[0].changes, [{ field: "status", from: null, to: "pending" }]);
    }
  });

  test("FIXED (1): enforced: a Grant-created (pending) account gets no workspace membership", async () => {
    const w = await world({ accountMode: "enforced" });
    const me = await w.register(0);
    const ws = new ObjectId(), now = new Date();
    await w.db.collection("workspaces").insertOne({ _id: ws, name: "Synthetic WS", archived: false, position: 1, createdAt: now, updatedAt: now, version: 1 });
    const res = await w.service.changeAccess("all", w.idOf(3), { action: "grant", expectedState: "not_registered", expectedVersion: 0 }, ADMIN, w.actorOf(me));
    const ref = res.manageAccess.workspaces[0].workspaceRef;
    const sysAdmin = { ...w.actorOf(me), isSystemAdmin: true };
    for (const role of ["VIEWER", "MEMBER", "WORKSPACE_ADMIN"]) {
      await assert.rejects(w.service.addMembership("all", w.idOf(3), { workspaceRef: ref, role }, ADMIN, sysAdmin), (e) => e.status === 400 && e.code === "ROLE_NOT_ALLOWED", role);
    }
    assert.equal(await w.db.collection("workspaceMembers").countDocuments({ workspaceId: ws }), 0);
  });

  test("off: Grant still creates no account (Account Management off: unchanged)", async () => {
    const w = await world();
    const me = await w.register(0);
    await w.service.changeAccess("all", w.idOf(3), { action: "grant", expectedState: "not_registered", expectedVersion: 0 }, ADMIN, w.actorOf(me));
    const doc = await w.db.collection("users").findOne({ entraObjectId: w.people[3].user_id });
    assert.equal(doc.account, undefined);
    assert.equal(await w.db.collection("accountAudit").countDocuments({ action: "account.created" }), 0);
  });

  test("FIXED (4): the only active WORKSPACE_ADMIN of a workspace: a LAST_WORKSPACE_ADMIN_OF warning (not a refusal) naming it", async () => {
    const w = await world();
    const me = await w.register(0);
    const target = await w.register(3);
    const ws = new ObjectId();
    const now = new Date();
    await w.db.collection("workspaces").insertOne({ _id: ws, name: "Synthetic WS", archived: false, position: 1, createdAt: now, updatedAt: now, version: 1 });
    await w.repos.memberships.add({ workspaceId: ws, userId: target._id, role: "WORKSPACE_ADMIN", now });
    // Another admin whose JARC account is suspended doesn't count.
    const other = await w.register(4, { status: "suspended" });
    await w.repos.memberships.add({ workspaceId: ws, userId: other._id, role: "WORKSPACE_ADMIN", now });
    const view = await w.service.manageAccess("all", w.idOf(3), ADMIN, w.actorOf(me));
    const warning = view.warnings.find((x) => x.code === "LAST_WORKSPACE_ADMIN_OF");
    assert.ok(warning);
    assert.deepEqual(warning.workspaces, ["Synthetic WS"]);
    assert.match(warning.message, /Synthetic WS/);
    // P4-0: the warning stays, and Suspend / Revoke are now refused (LAST_USABLE_WORKSPACE_ADMIN), naming the workspace.
    for (const a of ["suspend", "revoke"]) {
      const action = view.actions.find((x) => x.action === a);
      assert.equal(action.allowed, false, a);
      assert.equal(action.code, "LAST_USABLE_WORKSPACE_ADMIN", a);
      assert.match(action.reason, /Synthetic WS/, a);
    }
    await assert.rejects(w.service.changeAccess("all", w.idOf(3), { action: "suspend", expectedState: "active", expectedVersion: 0, reason: "Synthetic reason" }, ADMIN, w.actorOf(me)), (e) => e.status === 409 && e.code === "LAST_USABLE_WORKSPACE_ADMIN" && /Synthetic WS/.test(e.message));
    assert.equal((await w.db.collection("users").findOne({ _id: target._id })).status, "active", "nothing changed");
    // With a second ACTIVE admin there is no warning, and the suspend goes through.
    const third = await w.register(5);
    await w.repos.memberships.add({ workspaceId: ws, userId: third._id, role: "WORKSPACE_ADMIN", now });
    const after = await w.service.manageAccess("all", w.idOf(3), ADMIN, w.actorOf(me));
    assert.ok(!after.warnings.some((x) => x.code === "LAST_WORKSPACE_ADMIN_OF"));
    const res = await w.service.changeAccess("all", w.idOf(3), { action: "suspend", expectedState: "active", expectedVersion: 0, reason: "Synthetic reason" }, ADMIN, w.actorOf(me));
    assert.equal(res.result.to, "suspended");
  });

  test("FIXED (3): revoke reads the ACTIVE tokens directly, so an older active token behind 1000 revoked ones is revoked too", async () => {
    const w = await world();
    const me = await w.register(0);
    const target = await w.register(3);
    const tokens = w.db.collection("apiTokens");
    const far = new Date(Date.now() + 365 * 86400000);
    await tokens.insertOne({ _id: new ObjectId(), publicId: "old-active", ownerUserId: target._id, createdAt: new Date(Date.now() - 86400000 * 30), expiresAt: far, revokedAt: null, scopes: [] });
    const filler = Array.from({ length: 1000 }, (_, i) => ({ _id: new ObjectId(), publicId: `f${i}`, ownerUserId: target._id, createdAt: new Date(Date.now() - i * 1000), expiresAt: far, revokedAt: new Date(), scopes: [] }));
    await tokens.insertMany(filler);
    const res = await w.service.changeAccess("all", w.idOf(3), { action: "revoke", expectedState: "active", expectedVersion: 0, reason: "Synthetic reason", confirm: "REVOKE" }, ADMIN, w.actorOf(me));
    assert.equal(res.result.tokensRevoked.jarc, 1);
    assert.ok((await tokens.findOne({ publicId: "old-active" })).revokedAt instanceof Date);
    assert.equal(await w.db.collection("apiTokenAudit").countDocuments({ action: "token.revoked" }), 1);
  });

  test("history cursor: bound to the person, tamper-evident, and malformed input is a 400", async () => {
    const w = await world();
    const me = await w.register(0);
    await w.register(3);
    for (let i = 0; i < 3; i += 1) await w.service.changeAccess("all", w.idOf(3), { action: "suspend", expectedVersion: 99, reason: "Synthetic reason" }, ADMIN, w.actorOf(me)).catch(() => {});
    const page = await w.service.history("all", w.idOf(3), { limit: "1" }, ADMIN);
    assert.ok(page.nextBefore);
    assert.ok(!/[0-9a-f]{24}/.test(page.nextBefore));
    await assert.rejects(w.service.history("all", w.idOf(4), { before: page.nextBefore }, ADMIN), (e) => e.status === 400);
    const flipped = page.nextBefore.slice(0, 20) + (page.nextBefore[20] === "A" ? "B" : "A") + page.nextBefore.slice(21);
    await assert.rejects(w.service.history("all", w.idOf(3), { before: flipped }, ADMIN), (e) => e.status === 400);
    const two = await w.service.history("all", w.idOf(3), { limit: "1" }, ADMIN);
    assert.notEqual(two.nextBefore, page.nextBefore, "a fresh IV each time");
    const text = JSON.stringify(page);
    assert.ok(!text.includes(me._id.toHexString()));
  });

  test("a rejected attempt stores only the allow-listed fields, never the request body", async () => {
    const w = await world();
    const me = await w.register(0);
    await w.service.changeAccess("all", w.idOf(3), { action: "suspend", expectedVersion: 0, reason: "Synthetic reason", extra: "PLANTED-BODY" }, ADMIN, w.actorOf(me)).catch(() => {});
    const rows = await w.db.collection("accountAudit").find({ action: "employee.access.rejected" }).toArray();
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes("PLANTED-BODY"));
    assert.ok(!JSON.stringify(rows).includes("Synthetic reason"));
    assert.deepEqual(Object.keys(rows[0]).sort(), ["_id", "action", "actorName", "actorUserId", "at", "attempted", "changes", "code", "result", "source", "targetRef", "targetUserId"].sort());
  });
});

describe("viewerView (System Health viewer redaction)", () => {
  test("FIXED (7): planted host / URI / email / stack text in every field the builder reads never reaches the viewer", () => {
    const P = "mongodb+srv://u:p@host.example.com/x";
    const full = {
      scope: "admin", generatedAt: "2026-11-26T00:00:00.000Z",
      server: { status: P, environment: P, version: P, uptimeSeconds: 1, node: P, memoryMb: { rss: 1, heapUsed: 1 }, monitoringSince: P },
      database: { status: P, pingMs: 1, commands: 1, failed: 0, slow: 0, slowThresholdMs: 500, slowCommands: [{ collection: P }] },
      api: { requests: 1, statuses: { 200: 1, [P]: 2 }, samples: 1 },
      slowestEndpoints: [{ route: P, count: 1, lastAt: P, requestId: P }], failingEndpoints: [], endpoints: [],
      trend: [{ at: P, requests: 1 }],
      recentErrors: [{ status: 500, code: P, requestId: P, route: P, message: P }],
      integrations: { monday: { enabled: true, state: P, account: P, failedJobs: [{ error: P }], sync: { lastError: P, lastSyncAt: P }, activity: { lastError: { code: P, message: P } } }, googleDrive: { enabled: true, state: P, lastError: P, lastErrorAt: P, activity: null } },
      jobs: { integration: { monday: {} }, imports: { recent: [{ id: P }] }, midAttachments: [{ lastError: P }], searchIndex: { mode: P, ready: true }, recentFailures: [{ kind: P, code: P }] }
    };
    const out = JSON.stringify(viewerView(full));
    const leaks = [];
    const walk = (v, path) => { if (typeof v === "string" && v.includes("host.example")) leaks.push(path); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`); };
    walk(JSON.parse(out), "$");
    assert.deepEqual(leaks, []);
    const v = JSON.parse(out);
    assert.deepEqual([v.server.status, v.server.version, v.database.status, v.integrations.monday.state, v.integrations.googleDrive.state, v.jobs.searchIndex.mode], ["unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
    assert.deepEqual(v.slowestEndpoints, [], "an endpoint with a non-pattern route is dropped");
  });
});

describe("HTTP probes (real app)", () => {
  const BASE = "/api/v1/admin/employees";
  let issuer, P, app;
  before(async () => {
    issuer = await createTokenIssuer();
    P = { owner: issuer.person("Synthetic Owner"), alice: issuer.person("Synthetic Alice") };
    const fake = new FakeMongoClient();
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
    await connection.connect();
    await ensureDatabase(connection.db);
    const dataLayer = createDataLayer({ connection, logger: silent, fileStore: new MemoryFileStore(), environment: "test" });
    const docs = syntheticPeople(2, { seed: "p3review-http" });
    docs[0].user_id = P.owner.oid; docs[1].user_id = P.alice.oid;
    docs.forEach((d) => { d.user_type = "Member"; d.account_enabled = true; });
    const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: issuer.config.tenantId, viewerObjectIds: [], adminObjectIds: [P.owner.oid], accessAdmin: true }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
    const employees = createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs }), idKey: TEST_ID_KEY, logger: silent });
    const started = await startApp({ dataLayer, logger: silent, employees, auth: { mode: "entra", entra: issuer.config, verify: createEntraVerifier({ ...issuer.config, keySet: issuer.keySet }) }, accessPolicy: "development_shared", betaOpenEditing: true, apiTokens: { key: Buffer.alloc(32, 9), adminObjectIds: [] }, employeeWriteLimiter: () => true });
    app = { ...started, db: connection.db, close: async () => { await started.close(); await employees.close(); } };
  });
  after(async () => { await app?.close(); });

  test("FIXED (2): a case-variant P3 path gets the same 8 KB parser (413)", async () => {
    const c = new SessionClient(app.url, issuer.config.appOrigin);
    assert.equal((await c.signIn(P.owner)).status, 201);
    const id = profileId(TEST_ID_KEY, P.alice.oid);
    const big = { action: "grant", expectedState: "not_registered", expectedVersion: 0, pad: "x".repeat(20 * 1024) };
    const lower = await c.request("POST", `${BASE}/all/records/${id}/access`, big);
    assert.equal(lower.status, 413, "the 8 KB parser");
    const upper = await c.request("POST", `${BASE}/all/records/${id}/ACCESS`, big);
    assert.equal(upper.status, 413, "the same 8 KB parser");
    const mixed = await c.request("POST", `${BASE}/all/RECORDS/${id}/Memberships`, big);
    assert.equal(mixed.status, 413);
    const ok = await c.request("POST", `${BASE}/all/RECORDS/${id}/Access`, { action: "grant", expectedState: "not_registered", expectedVersion: 0 });
    assert.equal(ok.status, 200, "the case-variant path is the real P3 write");
  });
});
