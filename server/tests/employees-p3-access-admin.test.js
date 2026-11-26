// Employee Management P3 (Access Administration) through the REAL app: createApp({ employees }) with
// config.employees.accessAdmin, JARC's data layer on the in-memory FakeMongoClient, real Entra sign-in with the local test token
// issuer, and the read-only fake directory. Synthetic people only ("Synthetic Person N", @example.com), invented IDs.
// Production-like policy: development_shared + beta open editing (shared access on).
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
const { createEntraVerifier } = require("../src/auth/entra-token");
const { createEmployees, profileId } = require("../src/employees");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const BASE = "/api/v1/admin/employees";
const OTHER_TENANT = "00000000-0000-4000-8000-00000000b002";
const KEYS = ["owner", "admin2", "viewer", "outsider", "alice", "bob", "carol", "dana", "erin", "frank", "gina", "hal"];

function makeLogger() {
  const lines = [];
  const push = (level) => (...args) => lines.push(`${level} ${args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`);
  return { lines, errors: lines, error: push("error"), warn: push("warn"), info: push("info") };
}

async function boot({ issuer, P, accessAdmin = true, writeLimiter = () => true }) {
  const fake = new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const logger = makeLogger();
  const dataLayer = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), environment: "test" });
  const docs = syntheticPeople(KEYS.length, { seed: "p3" });
  KEYS.forEach((k, i) => { docs[i].user_id = P[k].oid; docs[i].user_type = "Member"; docs[i].account_enabled = k !== "dana"; });
  const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: issuer.config.tenantId, viewerObjectIds: [P.viewer.oid], adminObjectIds: [P.owner.oid, P.admin2.oid], accessAdmin }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
  const employees = createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs }), idKey: TEST_ID_KEY, logger });
  const started = await startApp({ dataLayer, logger, employees, auth: { mode: "entra", entra: issuer.config, verify: createEntraVerifier({ ...issuer.config, keySet: issuer.keySet }) }, accessPolicy: "development_shared", betaOpenEditing: true, apiTokens: { key: Buffer.alloc(32, 9), adminObjectIds: [] }, ...(writeLimiter ? { employeeWriteLimiter: writeLimiter } : {}) });
  return { ...started, logger, db: connection.db, repos: dataLayer.repos, employees, close: async () => { await started.close(); await employees.close(); } };
}

describe("P3 Access Administration (real app)", () => {
  let issuer, P, app, off;
  const clients = new Map();
  const seen = []; // P3 response texts (checked for raw IDs at the end)
  const idOf = (k) => profileId(TEST_ID_KEY, P[k].oid);
  const clientOf = async (target, k) => {
    const key = `${target.url}|${k}`;
    if (!clients.has(key)) { const c = new SessionClient(target.url, issuer.config.appOrigin); assert.equal((await c.signIn(P[k])).status, 201, `sign-in ${k}`); clients.set(key, c); }
    return clients.get(key);
  };
  const as = async (k, method, path, body, options, target = app) => {
    const c = k === "signedOut" ? new SessionClient(target.url, issuer.config.appOrigin) : await clientOf(target, k);
    const res = await c.request(method, path, body, options);
    if (path.startsWith(BASE)) seen.push(res.text || "");
    return res;
  };
  const manage = (k, who = "owner") => as(who, "GET", `${BASE}/all/records/${idOf(k)}/manage-access`);
  const act = async (k, action, extra = {}, who = "owner") => {
    const loaded = extra.expectedVersion === undefined || extra.expectedState === undefined ? (await manage(k, who)).body : null;
    return as(who, "POST", `${BASE}/all/records/${idOf(k)}/access`, { action, ...extra, expectedState: extra.expectedState ?? loaded.account.state, expectedVersion: extra.expectedVersion ?? loaded.version });
  };
  const userOf = (k) => app.db.collection("users").findOne({ tenantId: issuer.config.tenantId, entraObjectId: P[k].oid });
  const audits = () => app.db.collection("accountAudit").find({}).toArray();
  const W = {};

  before(async () => {
    issuer = await createTokenIssuer();
    P = Object.fromEntries(KEYS.map((k) => [k, issuer.person(`Synthetic ${k[0].toUpperCase()}${k.slice(1)}`, k === "outsider" ? { admin: true } : {})]));
    app = await boot({ issuer, P });
    off = await boot({ issuer, P, accessAdmin: false });
    // Workspaces: the owner is the only admin of W1; admin2 is the only admin of W2 (the owner has no membership there).
    for (const k of ["owner", "admin2", "viewer", "outsider", "alice", "dana", "frank", "gina"]) await clientOf(app, k);
    const now = new Date();
    for (const [name, i] of [["Alpha WS", 1], ["Beta WS", 2]]) { W[name] = new ObjectId(); await app.db.collection("workspaces").insertOne({ _id: W[name], name, archived: false, position: i, createdAt: now, updatedAt: now, version: 1 }); }
    await app.repos.memberships.add({ workspaceId: W["Alpha WS"], userId: (await userOf("owner"))._id, role: "WORKSPACE_ADMIN", now });
    await app.repos.memberships.add({ workspaceId: W["Beta WS"], userId: (await userOf("admin2"))._id, role: "WORKSPACE_ADMIN", now });
  });
  after(async () => { await app?.close(); await off?.close(); });

  describe("who may use it", () => {
    const paths = () => [
      ["GET", `${BASE}/all/records/${idOf("alice")}/manage-access`],
      ["GET", `${BASE}/all/records/${idOf("alice")}/access-history`],
      ["POST", `${BASE}/all/records/${idOf("alice")}/access`, { action: "suspend", expectedVersion: 0, reason: "Synthetic reason" }],
      ["POST", `${BASE}/all/records/${idOf("alice")}/memberships`, { workspaceRef: "A".repeat(22), role: "MEMBER" }],
      ["PATCH", `${BASE}/all/records/${idOf("alice")}/memberships/${"A".repeat(22)}`, { role: "VIEWER" }],
      ["DELETE", `${BASE}/all/records/${idOf("alice")}/memberships/${"A".repeat(22)}`]
    ];

    test("switch off: every P3 path is 404 for every method and caller, and /features has no accessAdmin", async () => {
      for (const who of ["owner", "viewer"]) for (const [m, p, b] of paths()) {
        const res = await as(who, m, p, b, undefined, off);
        assert.equal(res.status, 404, `${who} ${m} ${p}`);
      }
      const flags = (await as("owner", "GET", "/api/v1/features", undefined, undefined, off)).body.features.employees;
      assert.deepEqual(flags, { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"], jarcAccess: true });
    });

    test("/features: employees.accessAdmin only for the administrator with the switch on", async () => {
      const flag = async (k) => (await as(k, "GET", "/api/v1/features")).body.features.employees;
      assert.equal((await flag("owner")).accessAdmin, true);
      assert.equal((await flag("admin2")).accessAdmin, true);
      assert.deepEqual(await flag("viewer"), { view: true, admin: false, datasets: ["active"] });
      assert.deepEqual(await flag("outsider"), { view: false, admin: false, datasets: [] });
    });

    test("viewer and outsider (JARC.Admin) 403 EMPLOYEES_FORBIDDEN, bearer and signed-out 401, on all six endpoints", async () => {
      for (const [m, p, b] of paths()) {
        for (const who of ["viewer", "outsider"]) {
          const res = await as(who, m, p, b);
          assert.equal(res.status, 403, `${who} ${m} ${p}`);
          assert.equal(res.body.error.code, "EMPLOYEES_FORBIDDEN");
        }
        assert.equal((await as("signedOut", m, p, b)).status, 401, `signed out ${m} ${p}`);
        const owner = await clientOf(app, "owner");
        const bearer = await owner.request(m, p, b, { headers: { Authorization: "Bearer jarc_synthetic_token" } });
        assert.equal(bearer.status, 401, `bearer ${m} ${p}`);
      }
      // A viewer's probe of the P3 path answers the same for a real and an unknown profile ID.
      const a = await as("viewer", "GET", `${BASE}/all/records/${idOf("alice")}/manage-access`), b = await as("viewer", "GET", `${BASE}/all/records/${"Q".repeat(22)}/manage-access`);
      assert.deepEqual([a.status, a.body], [b.status, b.body]);
      // No audit entries for refused non-administrators (no flooding by others).
      assert.equal((await audits()).filter((e) => e.action === "employee.access.rejected").length, 0);
    });

    test("CSRF: a write without X-CSRF-Token (or from another origin) is 403 CSRF_INVALID and changes nothing", async () => {
      const before = await userOf("alice");
      const owner = await clientOf(app, "owner");
      const body = { action: "suspend", expectedVersion: 0, reason: "Synthetic reason" };
      const a = await owner.request("POST", `${BASE}/all/records/${idOf("alice")}/access`, body, { csrf: null });
      assert.equal(a.status, 403); assert.equal(a.body.error.code, "CSRF_INVALID");
      const b = await owner.request("POST", `${BASE}/all/records/${idOf("alice")}/access`, body, { origin: "https://evil.example.invalid" });
      assert.equal(b.status, 403); assert.equal(b.body.error.code, "CSRF_INVALID");
      assert.equal((await userOf("alice")).status, before.status);
    });

    test("unknown and other-dataset IDs are 404; a viewer's P1/P2 is unchanged", async () => {
      assert.equal((await as("owner", "GET", `${BASE}/all/records/${"Q".repeat(22)}/manage-access`)).status, 404);
      assert.equal((await as("owner", "GET", `${BASE}/active/records/${idOf("dana")}/manage-access`)).status, 404, "dana is disabled in Entra: not in active");
      assert.equal((await as("owner", "GET", `${BASE}/nope/records/${idOf("alice")}/manage-access`)).status, 404);
      assert.equal((await as("viewer", "GET", `${BASE}/active/records?limit=5`)).status, 200);
      assert.equal((await as("viewer", "GET", `${BASE}/active/records/${idOf("alice")}`)).status, 200);
      assert.equal((await as("viewer", "GET", `${BASE}/active/records/${idOf("alice")}/jarc-access`)).status, 403);
      assert.equal((await as("viewer", "POST", `${BASE}/active/records`, {})).status, 405, "data routes stay GET-only");
    });
  });

  describe("manage-access body", () => {
    test("not registered: state, actions, tokens, workspaces with refs, shared access note", async () => {
      const res = await manage("bob");
      assert.equal(res.status, 200);
      const b = res.body;
      assert.equal(b.id, idOf("bob"));
      assert.equal(b.version, 0);
      assert.deepEqual(b.account, { state: "not_registered", provisioned: false, signedInNow: false, isSelf: false, isEmployeeAdmin: false, entraEnabled: true, statusChangedAt: null, statusReason: null });
      assert.deepEqual(b.actions.map((a) => [a.action, a.allowed]), [["grant", true], ["suspend", false], ["restore", false], ["revoke", true]]);
      assert.equal(b.actions.find((a) => a.action === "suspend").code, "INVALID_TRANSITION");
      assert.equal(b.actions.find((a) => a.action === "revoke").confirm, "REVOKE");
      assert.deepEqual(b.tokens, { jarcActive: 0, fabricActive: 0 });
      assert.deepEqual(b.workspaces.map((w) => w.name), ["Alpha WS", "Beta WS"]);
      for (const w of b.workspaces) { assert.match(w.workspaceRef, /^[A-Za-z0-9_-]{22}$/); assert.equal(w.membership, null); assert.equal(w.effectiveRole, null); assert.equal(w.sharedRole, null); }
      assert.deepEqual(b.workspaces.map((w) => w.canManage), [true, false], "the owner administers Alpha only");
      assert.equal(b.sharedAccess.on, true);
      assert.match(b.sharedAccess.note, /only Suspend and Revoke remove access/);
      assert.ok(b.warnings.some((w) => w.code === "SHARED_FIRST_SIGN_IN"));
      assert.equal(b.snapshot.stale, false);
    });

    test("a registered active person: shared Workspace admin everywhere, signed in now; self and admin flags", async () => {
      const b = (await manage("alice")).body;
      assert.equal(b.account.state, "active");
      assert.equal(b.account.signedInNow, true);
      assert.ok(b.workspaces.every((w) => w.sharedRole === "WORKSPACE_ADMIN" && w.effectiveRole === "WORKSPACE_ADMIN"));
      const self = (await manage("owner")).body;
      assert.equal(self.account.isSelf, true);
      assert.equal(self.account.isEmployeeAdmin, true);
      assert.deepEqual(self.actions.filter((a) => !a.allowed).map((a) => [a.action, a.code]), [["grant", "INVALID_TRANSITION"], ["suspend", "SELF_LOCKOUT"], ["restore", "INVALID_TRANSITION"], ["revoke", "SELF_LOCKOUT"]]);
      assert.equal(self.workspaces.find((w) => w.name === "Alpha WS").lastAdmin, true);
    });

    test("Entra-disabled person with JARC access: the warning and the suggested reason; suspend allowed", async () => {
      const b = (await manage("dana")).body;
      assert.equal(b.account.entraEnabled, false);
      assert.equal(b.account.suggestedSuspendReason, "Disabled in Microsoft Entra ID");
      assert.ok(b.warnings.some((w) => w.code === "ENTRA_DISABLED_WITH_ACCESS"));
      const res = await act("dana", "suspend", { reason: "Disabled in Microsoft Entra ID" });
      assert.equal(res.status, 200);
      assert.equal(res.body.manageAccess.account.state, "suspended");
      assert.ok(!res.body.manageAccess.warnings.some((w) => w.code === "ENTRA_DISABLED_WITH_ACCESS"));
    });
  });

  describe("account state machine", () => {
    test("Grant pre-provisions someone not registered; their first sign-in reuses the same document", async () => {
      const res = await act("bob", "grant");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.result, { action: "grant", from: "not_registered", to: "active", sessionsEnded: 0, tokensRevoked: { jarc: 0, fabric: 0 } });
      const m = res.body.manageAccess;
      assert.deepEqual([m.account.state, m.account.provisioned, m.version], ["active", true, 1]);
      const doc = await userOf("bob");
      assert.equal(doc.source, "entra");
      assert.equal(doc.tenantId, issuer.config.tenantId.toLowerCase());
      assert.equal(doc.entraObjectId, P.bob.oid.toLowerCase());
      assert.equal(doc.status, "active");
      assert.ok(doc.provisionedAt instanceof Date && doc.provisionedBy && !("lastLoginAt" in doc));
      assert.equal(doc.displayName, "Synthetic Person 6");
      // P2: provisioned, not signed in yet; registeredAt / first sign-in null.
      const row = (await as("owner", "GET", `${BASE}/all/records/${idOf("bob")}`)).body.values;
      assert.equal(row.jarcAccount, "Provisioned (not signed in yet)");
      assert.equal(row.jarcRegistered, null);
      assert.equal(row.jarcStatus, "Active");
      const detail = (await as("owner", "GET", `${BASE}/all/records/${idOf("bob")}/jarc-access`)).body;
      assert.equal(detail.account.provisioned, true);
      assert.equal(detail.account.registeredAt, null);
      // First sign-in: same _id, one document.
      const c = await clientOf(app, "bob");
      assert.ok(c);
      assert.equal(await app.db.collection("users").countDocuments({ entraObjectId: P.bob.oid.toLowerCase() }), 1);
      assert.equal(String((await userOf("bob"))._id), String(doc._id));
      const after = (await manage("bob")).body;
      assert.equal(after.account.provisioned, false);
      assert.equal(after.account.signedInNow, true, "read directly, not from the cached index");
      // (The P2 columns follow at the index's next refresh, at most 60 s; a P3 write refreshes them at once.)
    });

    test("Revoke before registration blocks the first sign-in (403) and the status stays revoked", async () => {
      const noReason = await act("carol", "revoke", { confirm: "REVOKE" });
      assert.equal(noReason.status, 400);
      const noConfirm = await act("carol", "revoke", { reason: "Synthetic offboarding" });
      assert.equal(noConfirm.status, 400);
      const res = await act("carol", "revoke", { reason: "Synthetic offboarding", confirm: "REVOKE" });
      assert.equal(res.status, 200);
      assert.equal(res.body.manageAccess.account.state, "revoked");
      const c = new SessionClient(app.url, issuer.config.appOrigin);
      const signIn = await c.signIn(P.carol);
      assert.equal(signIn.status, 403);
      assert.equal(signIn.body.error.code, "ACCOUNT_DISABLED");
      assert.equal((await userOf("carol")).status, "revoked");
      assert.equal(await app.db.collection("users").countDocuments({ entraObjectId: P.carol.oid.toLowerCase() }), 1);
      assert.equal((await as("owner", "GET", `${BASE}/all/records/${idOf("carol")}`)).body.values.jarcStatus, "Revoked");
    });

    test("suspend → sessions end, sign-in refused; restore; revoke also revokes JARC and Fabric tokens; grant again", async () => {
      const alice = await clientOf(app, "alice");
      assert.equal((await alice.request("GET", "/api/v1/me")).status, 200);
      const uid = (await userOf("alice"))._id;
      const now = Date.now();
      const token = (extra) => app.repos.apiTokens.insert({ _id: new ObjectId(), publicId: `pub${Math.random().toString(36).slice(2, 12)}`, digest: "synthetic", name: "Synthetic", ownerUserId: uid, workspaceId: null, boardIds: [], scopes: ["read"], createdAt: new Date(now), expiresAt: new Date(now + 86400000), revokedAt: null, lastUsedAt: null, requestCount: 0, ...extra });
      await token(); await token(); await token({ product: "fabric", scopes: ["fabric.sales.read"] });
      await token({ expiresAt: new Date(now - 1000) }); // expired: left alone
      assert.deepEqual((await manage("alice")).body.tokens, { jarcActive: 2, fabricActive: 1 });

      assert.equal((await act("alice", "suspend", {})).status, 400, "suspend needs a reason");
      assert.equal((await act("alice", "suspend", { reason: "x\ny" })).status, 400, "no control characters");
      assert.equal((await act("alice", "suspend", { reason: "ab" })).status, 400, "at least 3 characters");
      assert.equal((await act("alice", "suspend", { reason: "a".repeat(501) })).status, 400, "at most 500");
      const s = await act("alice", "suspend", { reason: "Synthetic leave of absence" });
      assert.equal(s.status, 200);
      assert.equal(s.body.result.sessionsEnded, 1);
      assert.equal(s.body.manageAccess.account.state, "suspended");
      assert.equal(s.body.manageAccess.account.statusReason, "Synthetic leave of absence");
      assert.ok(s.body.manageAccess.warnings.some((w) => w.code === "TOKENS_RETURN_ON_RESTORE"));
      // Her existing session is gone: the next request is refused.
      assert.ok([401, 403].includes((await alice.request("GET", "/api/v1/me")).status));
      const again = await new SessionClient(app.url, issuer.config.appOrigin).signIn(P.alice);
      assert.equal(again.status, 403);
      assert.equal((await userOf("alice")).status, "suspended", "a sign-in never changes the status");
      assert.equal((await as("owner", "GET", `${BASE}/all/records/${idOf("alice")}`)).body.values.jarcStatus, "Suspended");

      const r = await act("alice", "restore");
      assert.equal(r.status, 200);
      assert.equal(r.body.manageAccess.account.state, "active");
      assert.deepEqual(r.body.manageAccess.tokens, { jarcActive: 2, fabricActive: 1 }, "tokens are usable again after restore");
      const back = new SessionClient(app.url, issuer.config.appOrigin);
      assert.equal((await back.signIn(P.alice)).status, 201);
      clients.set(`${app.url}|alice`, back);

      const v = await act("alice", "revoke", { reason: "Synthetic offboarding", confirm: "REVOKE" });
      assert.equal(v.status, 200);
      assert.deepEqual(v.body.result.tokensRevoked, { jarc: 2, fabric: 1 });
      assert.equal(v.body.result.sessionsEnded, 1);
      assert.deepEqual(v.body.manageAccess.tokens, { jarcActive: 0, fabricActive: 0 });
      const tokenDocs = await app.db.collection("apiTokens").find({ ownerUserId: uid }).toArray();
      assert.equal(tokenDocs.filter((t) => t.revokedAt instanceof Date).length, 3);
      const ownerId = String((await userOf("owner"))._id);
      assert.ok(tokenDocs.filter((t) => t.revokedAt).every((t) => String(t.revokedByUserId) === ownerId), "the administrator is recorded on each token");
      const tokenAudit = await app.db.collection("apiTokenAudit").find({ action: "token.revoked" }).toArray();
      assert.equal(tokenAudit.length, 3);
      assert.equal(tokenAudit.filter((a) => a.product === "fabric").length, 1);
      assert.ok(tokenAudit.every((a) => /Employee Management/.test(a.reason) && a.actorUserId));
      assert.equal((await back.request("GET", "/api/v1/me")).status, 401);

      const g = await act("alice", "grant");
      assert.equal(g.status, 200);
      assert.equal(g.body.manageAccess.account.state, "active");
      assert.deepEqual(g.body.manageAccess.tokens, { jarcActive: 0, fabricActive: 0 }, "old tokens stay revoked");
      assert.equal((await audits()).filter((e) => e.action === "employee.access.granted").length, 1);
    });

    test("illegal transitions are 409 INVALID_TRANSITION and change nothing", async () => {
      const cases = [["frank", "restore"], ["frank", "grant"], ["hal", "suspend", { reason: "Synthetic" }], ["hal", "restore"], ["carol", "suspend", { reason: "Synthetic" }], ["carol", "restore"], ["carol", "revoke", { reason: "Synthetic", confirm: "REVOKE" }]];
      for (const [k, action, extra = {}] of cases) {
        const before = await userOf(k);
        const res = await act(k, action, extra);
        assert.equal(res.status, 409, `${k} ${action}`);
        assert.equal(res.body.error.code, "INVALID_TRANSITION");
        assert.deepEqual(await userOf(k), before);
      }
    });

    test("strict bodies: unknown fields, wrong types, confirm on other actions, query parameters", async () => {
      const p = `${BASE}/all/records/${idOf("frank")}/access`;
      for (const body of [{ action: "suspend", expectedVersion: 0, reason: "Synthetic", extra: 1 }, { action: "explode", expectedVersion: 0 }, { action: "grant", expectedVersion: "0" }, { action: "grant", expectedVersion: -1 }, { action: "restore", expectedVersion: 0, confirm: "REVOKE" }, { action: "suspend", expectedVersion: 0, reason: 42 }, [], "text"]) {
        const res = await as("owner", "POST", p, body);
        assert.equal(res.status, 400, JSON.stringify(body));
      }
      assert.equal((await as("owner", "POST", `${p}?x=1`, { action: "grant", expectedVersion: 0 })).status, 400);
      const big = await as("owner", "POST", p, { action: "suspend", expectedVersion: 0, reason: "a".repeat(9000) });
      assert.equal(big.status, 413);
      assert.equal((await userOf("frank")).status, "active");
    });

    test("stale expectedVersion is 409 CONFLICT; two writes with the same version: one succeeds, one 409", async () => {
      const v = (await manage("frank")).body.version;
      assert.equal((await act("frank", "suspend", { reason: "Synthetic", expectedVersion: v + 1 })).status, 409);
      const wrongState = await act("frank", "suspend", { reason: "Synthetic", expectedState: "suspended" });
      assert.equal(wrongState.status, 409, "expectedState must match too");
      assert.equal(wrongState.body.error.code, "CONFLICT");
      const missing = await as("owner", "POST", `${BASE}/all/records/${idOf("frank")}/access`, { action: "suspend", expectedVersion: v, reason: "Synthetic" });
      assert.equal(missing.status, 400, "expectedState is required");
      const body = { action: "suspend", expectedState: "active", expectedVersion: v, reason: "Synthetic race" };
      const [a, b] = await Promise.all([as("owner", "POST", `${BASE}/all/records/${idOf("frank")}/access`, body), as("admin2", "POST", `${BASE}/all/records/${idOf("frank")}/access`, body)]);
      assert.deepEqual([a.status, b.status].sort(), [200, 409]);
      assert.equal([a, b].find((r) => r.status === 409).body.error.code, "CONFLICT");
      const doc = await userOf("frank");
      assert.equal(doc.status, "suspended");
      assert.equal(doc.accessVersion, v + 1);
      assert.equal((await audits()).filter((e) => e.action === "employee.access.suspended" && String(e.targetUserId) === String(doc._id)).length, 1);
    });

    test("self-lockout: the administrator can't suspend or revoke their own account; another listed admin can be suspended", async () => {
      const s = await act("owner", "suspend", { reason: "Synthetic" });
      assert.equal(s.status, 403); assert.equal(s.body.error.code, "SELF_LOCKOUT");
      const r = await act("owner", "revoke", { reason: "Synthetic", confirm: "REVOKE" });
      assert.equal(r.status, 403); assert.equal(r.body.error.code, "SELF_LOCKOUT");
      assert.equal((await userOf("owner")).status, "active");
      // admin2 is listed too; the owner stays active, so suspending admin2 is allowed (and restored right after). P4-0: admin2 is
      // the only usable admin of Beta WS (LAST_USABLE_WORKSPACE_ADMIN), so Beta WS gets a usable co-admin for this check first.
      const coAdmin = { workspaceId: W["Beta WS"], userId: (await userOf("viewer"))._id };
      await app.repos.memberships.add({ ...coAdmin, role: "WORKSPACE_ADMIN", now: new Date() });
      try {
        assert.equal((await act("admin2", "suspend", { reason: "Synthetic check" })).status, 200);
        assert.equal((await act("admin2", "restore")).status, 200);
      } finally { await app.db.collection("workspaceMembers").deleteOne(coAdmin); }
      clients.delete(`${app.url}|admin2`);
    });

    test("tenant: a users document with the same object ID in another tenant is never matched or changed", async () => {
      const otherId = new ObjectId();
      await app.db.collection("users").insertOne({ _id: otherId, tenantId: OTHER_TENANT, entraObjectId: P.erin.oid.toLowerCase(), source: "entra", status: "active", displayName: "Synthetic Other", createdAt: new Date(), lastLoginAt: new Date() });
      assert.equal((await manage("erin")).body.account.state, "not_registered");
      const res = await act("erin", "revoke", { reason: "Synthetic", confirm: "REVOKE" });
      assert.equal(res.status, 200);
      const other = await app.db.collection("users").findOne({ _id: otherId });
      assert.equal(other.status, "active");
      assert.equal((await userOf("erin")).status, "revoked");
    });

    test("a stale directory snapshot: manual actions still work, the body says snapshot.stale with a warning", async () => {
      app.employees.snapshot.failure = "source_unavailable";
      try {
        const b = (await manage("gina")).body;
        assert.equal(b.snapshot.stale, true);
        assert.equal(b.snapshot.staleReason, "source_unavailable");
        assert.ok(b.warnings.some((w) => w.code === "SNAPSHOT_STALE"));
        assert.equal((await act("gina", "suspend", { reason: "Synthetic" })).status, 200);
        assert.equal((await act("gina", "restore")).status, 200);
        clients.delete(`${app.url}|gina`);
      } finally { app.employees.snapshot.failure = null; }
    });
  });

  describe("memberships", () => {
    const ref = async (name, k = "gina") => (await manage(k)).body.workspaces.find((w) => w.name === name).workspaceRef;
    const mpath = (k, r) => `${BASE}/all/records/${idOf(k)}/memberships${r ? `/${r}` : ""}`;

    test("add, duplicate 409, role change, remove; members-route authority; activity entries kept", async () => {
      const alpha = await ref("Alpha WS"), beta = await ref("Beta WS");
      const add = await as("owner", "POST", mpath("gina"), { workspaceRef: alpha, role: "MEMBER" });
      assert.equal(add.status, 201);
      const row = add.body.manageAccess.workspaces.find((w) => w.name === "Alpha WS");
      assert.deepEqual(row.membership, { role: "MEMBER", status: "active" });
      assert.equal(row.effectiveRole, "WORKSPACE_ADMIN", "shared access still gives Workspace admin");
      const dup = await as("owner", "POST", mpath("gina"), { workspaceRef: alpha, role: "VIEWER" });
      assert.equal(dup.status, 409); assert.equal(dup.body.error.code, "ALREADY_MEMBER");
      const noAuthority = await as("owner", "POST", mpath("gina"), { workspaceRef: beta, role: "MEMBER" });
      assert.equal(noAuthority.status, 403); assert.equal(noAuthority.body.error.code, "WORKSPACE_ADMIN_REQUIRED");
      const unknown = await as("owner", "POST", mpath("gina"), { workspaceRef: "Z".repeat(22), role: "MEMBER" });
      assert.equal(unknown.status, 404);
      assert.equal((await as("owner", "POST", mpath("gina"), { workspaceRef: alpha, role: "OWNER" })).status, 400);
      assert.equal((await as("owner", "POST", mpath("gina"), { workspaceRef: alpha, role: "MEMBER", userId: "x" })).status, 400);
      const patch = await as("owner", "PATCH", mpath("gina", alpha), { role: "VIEWER" });
      assert.equal(patch.status, 200);
      assert.equal(patch.body.manageAccess.workspaces.find((w) => w.name === "Alpha WS").membership.role, "VIEWER");
      const del = await as("owner", "DELETE", mpath("gina", alpha));
      assert.equal(del.status, 200);
      assert.equal(del.body.manageAccess.workspaces.find((w) => w.name === "Alpha WS").membership, null);
      const again = await as("owner", "DELETE", mpath("gina", alpha));
      assert.equal(again.status, 404); assert.equal(again.body.error.code, "NOT_MEMBER");
      const acts = await app.db.collection("activities").find({ action: { $in: ["member.added", "member.role_changed", "member.removed"] } }).toArray();
      assert.deepEqual(acts.map((a) => a.action).sort(), ["member.added", "member.removed", "member.role_changed"]);
      const mine = (await audits()).filter((e) => e.action.startsWith("employee.membership."));
      assert.deepEqual(mine.map((e) => e.action), ["employee.membership.added", "employee.membership.role_changed", "employee.membership.removed"]);
      assert.ok(mine.every((e) => String(e.workspaceId) === String(W["Alpha WS"]) && e.result === "ok" && e.source === "employee_management"));
    });

    test("last workspace admin 409; not registered 409; not active 409", async () => {
      const alpha = await ref("Alpha WS", "owner");
      const demote = await as("owner", "PATCH", mpath("owner", alpha), { role: "MEMBER" });
      assert.equal(demote.status, 409); assert.equal(demote.body.error.code, "LAST_WORKSPACE_ADMIN");
      const remove = await as("owner", "DELETE", mpath("owner", alpha));
      assert.equal(remove.status, 409); assert.equal(remove.body.error.code, "LAST_WORKSPACE_ADMIN");
      const nr = await as("owner", "POST", mpath("hal"), { workspaceRef: alpha, role: "MEMBER" });
      assert.equal(nr.status, 409); assert.equal(nr.body.error.code, "NOT_REGISTERED");
      const suspended = await as("owner", "POST", mpath("frank"), { workspaceRef: alpha, role: "MEMBER" });
      assert.equal(suspended.status, 409); assert.equal(suspended.body.error.code, "ACCOUNT_NOT_ACTIVE");
    });
  });

  describe("audit and history", () => {
    test("ok and rejected entries, newest first, actor display name, workspace name, no raw IDs; cursor paging", async () => {
      const h = await as("owner", "GET", `${BASE}/all/records/${idOf("alice")}/access-history?limit=100`);
      assert.equal(h.status, 200);
      const items = h.body.items;
      const actions = items.map((i) => i.action);
      assert.deepEqual(actions.filter((a) => a !== "employee.access.rejected"), ["employee.access.granted", "employee.access.revoked", "employee.access.restored", "employee.access.suspended"]);
      const rejected = items.filter((i) => i.result === "rejected");
      assert.ok(rejected.length >= 4, "the refused reason checks were recorded");
      assert.ok(rejected.every((i) => i.code && i.attempted && i.reason === undefined));
      assert.ok(items.every((i, n) => n === 0 || items[n - 1].at >= i.at), "newest first");
      const revoked = items.find((i) => i.action === "employee.access.revoked");
      assert.deepEqual(revoked.changes, [{ field: "status", from: "active", to: "revoked" }]);
      assert.equal(revoked.reason, "Synthetic offboarding");
      assert.equal(revoked.actor, "Synthetic Owner");
      for (const i of items) assert.deepEqual(Object.keys(i).filter((k) => !["at", "action", "result", "actor", "changes", "reason", "code", "attempted", "workspace"].includes(k)), []);
      // Paging: limit 2, then the cursor; a tampered or another person's cursor is refused.
      const p1 = (await as("owner", "GET", `${BASE}/all/records/${idOf("alice")}/access-history?limit=2`)).body;
      assert.equal(p1.items.length, 2);
      assert.ok(p1.nextBefore);
      const p2 = (await as("owner", "GET", `${BASE}/all/records/${idOf("alice")}/access-history?limit=2&before=${p1.nextBefore}`)).body;
      assert.deepEqual(p2.items.map((i) => i.at + i.action), items.slice(2, 4).map((i) => i.at + i.action));
      const tampered = p1.nextBefore.slice(0, -2) + (p1.nextBefore.endsWith("AA") ? "BB" : "AA");
      assert.equal((await as("owner", "GET", `${BASE}/all/records/${idOf("alice")}/access-history?before=${tampered}`)).status, 400);
      assert.equal((await as("owner", "GET", `${BASE}/all/records/${idOf("frank")}/access-history?before=${p1.nextBefore}`)).status, 400);
      assert.equal((await as("owner", "GET", `${BASE}/all/records/${idOf("alice")}/access-history?limit=0`)).status, 400);
      assert.equal((await as("owner", "GET", `${BASE}/all/records/${idOf("alice")}/access-history?limit=101`)).status, 400);
      assert.equal((await as("owner", "GET", `${BASE}/all/records/${idOf("alice")}/access-history?x=1`)).status, 400);
      // Membership history carries the workspace name.
      const g = (await as("owner", "GET", `${BASE}/all/records/${idOf("gina")}/access-history`)).body.items;
      assert.ok(g.filter((i) => i.action.startsWith("employee.membership.")).every((i) => i.workspace === "Alpha WS"));
      // A rejection for someone never registered: targetUserId null, targetRef = the profile ID, shown in their history.
      const hal = (await as("owner", "GET", `${BASE}/all/records/${idOf("hal")}/access-history`)).body.items;
      assert.ok(hal.some((i) => i.result === "rejected" && i.code === "INVALID_TRANSITION" && i.attempted === "suspend"));
      const stored = (await audits()).find((e) => e.targetRef === idOf("hal") && e.attempted === "suspend");
      assert.equal(stored.targetUserId, null);
    });

    test("stored entries never contain the request body beyond the allow-listed fields", async () => {
      await as("owner", "POST", `${BASE}/all/records/${idOf("hal")}/access`, { action: "grant", expectedVersion: 0, sneaky: "SYNTHETIC-SECRET-VALUE" });
      const all = JSON.stringify(await audits());
      assert.ok(!all.includes("SYNTHETIC-SECRET-VALUE"));
      for (const e of await audits()) for (const k of Object.keys(e)) assert.ok(["_id", "action", "targetUserId", "actorUserId", "actorName", "changes", "workspaceId", "at", "result", "reason", "code", "source", "targetRef", "attempted"].includes(k), k);
    });
  });

  describe("privacy", () => {
    test("no object ID, tenant ID, ObjectId hex or token in any P3 response or log line", async () => {
      const oids = KEYS.map((k) => P[k].oid.toLowerCase());
      const forbidden = [...oids, issuer.config.tenantId.toLowerCase(), OTHER_TENANT];
      const texts = seen.map((t) => t.toLowerCase());
      for (const t of texts) {
        for (const f of forbidden) assert.ok(!t.includes(f), "an identity leaked");
        assert.ok(!/(^|[^0-9a-f])[0-9a-f]{24}([^0-9a-f]|$)/.test(t), "an ObjectId leaked");
        assert.ok(!/jarc_[a-z0-9]{8,}/.test(t), "a token leaked");
      }
      const log = app.logger.lines.join("\n").toLowerCase();
      for (const f of forbidden) assert.ok(!log.includes(f));
      assert.ok(!/(^|[^0-9a-f])[0-9a-f]{24}([^0-9a-f]|$)/.test(log));
      assert.ok(!app.logger.lines.some((l) => l.startsWith("error")), app.logger.lines.filter((l) => l.startsWith("error")).join("\n"));
    });
  });
});

describe("P3 write rate limit (real app, the default limiter)", () => {
  test("20 writes per minute per administrator; the 21st is 429 RATE_LIMITED", async () => {
    const issuer = await createTokenIssuer();
    const P = Object.fromEntries(KEYS.map((k) => [k, issuer.person(`Synthetic ${k}`)]));
    const app = await boot({ issuer, P, writeLimiter: null });
    try {
      const owner = new SessionClient(app.url, issuer.config.appOrigin);
      assert.equal((await owner.signIn(P.owner)).status, 201);
      const p = `${BASE}/all/records/${profileId(TEST_ID_KEY, P.hal.oid)}/access`;
      const statuses = [];
      for (let i = 0; i < 21; i += 1) statuses.push((await owner.request("POST", p, { action: "restore", expectedState: "not_registered", expectedVersion: 0 })).status);
      assert.deepEqual(statuses.slice(0, 20), Array(20).fill(409));
      assert.equal(statuses[20], 429);
      // Reads aren't counted against the write budget.
      assert.equal((await owner.request("GET", `${BASE}/all/records/${profileId(TEST_ID_KEY, P.hal.oid)}/manage-access`)).status, 200);
    } finally { await app.close(); }
  });
});
