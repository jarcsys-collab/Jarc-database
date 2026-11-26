// Employee Management P3 release verification: the gaps not already covered by the P3 suites.
//   A. Code deployed with JARC_FEATURE_EMPLOYEE_ACCESS_ADMIN AND SYSTEM_HEALTH_VIEWER_OIDS both absent.
//   B. Suspend / revoke end an open live-updates stream; sign-in after a revoke is refused with the status unchanged.
//   C. API tokens (JARC and Fabric) of the target vs other people across suspend, restore, revoke, grant and another person's restore.
//   D. Exactly one accountAudit entry per P3 action (with its fields); token audit per revoked token; failed audit writes roll back.
//   E. CSRF on every P3 write; no method on the history route changes it.
// The real app (createApp) on the in-memory FakeMongoClient, real Entra sign-in with the local test issuer, the read-only fake
// directory. Synthetic people only, invented IDs, no network beyond 127.0.0.1.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { SessionClient, startApp, entraEnv } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FakeMongoClient } = require("./support/fake-mongo");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { createEntraVerifier } = require("../src/auth/entra-token");
const { createEmployees, profileId } = require("../src/employees");
const { generateToken } = require("../src/auth/api-token");
const { FabricTokenService } = require("../src/services/api-token-service");
const { loadConfig } = require("../src/config");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const BASE = "/api/v1/admin/employees";
const KEY = Buffer.alloc(32, 7);
const KEYS = ["owner", "viewer", "sysadmin", "plain", "tara", "otto", "sam", "rex", "rita", "uma", "mel", "fay"];

async function boot({ issuer, P, accessAdmin }) {
  const fake = new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const logger = { errors: [], error(...a) { this.errors.push(a); }, warn() {}, info() {} };
  const dataLayer = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), environment: "test" });
  const docs = syntheticPeople(KEYS.length, { seed: "p3rv" });
  KEYS.forEach((k, i) => { docs[i].user_id = P[k].oid; docs[i].user_type = "Member"; docs[i].account_enabled = true; });
  // Only the owner is an Employee Management administrator (and is NOT JARC.Admin); sysadmin is JARC.Admin and not listed.
  const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: issuer.config.tenantId, viewerObjectIds: [P.viewer.oid], adminObjectIds: [P.owner.oid], accessAdmin }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
  const employees = createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs }), idKey: TEST_ID_KEY, logger });
  // No systemHealth option: SYSTEM_HEALTH_VIEWER_OIDS absent. live.timings.session: the stream's session re-check every 100 ms.
  const started = await startApp({ dataLayer, logger, employees, auth: { mode: "entra", entra: issuer.config, verify: createEntraVerifier({ ...issuer.config, keySet: issuer.keySet }) }, accessPolicy: "development_shared", betaOpenEditing: true, apiTokens: { key: KEY, adminObjectIds: [] }, employeeWriteLimiter: () => true, live: { timings: { session: 100 } } });
  return { ...started, fake, dataLayer, db: connection.db, repos: dataLayer.repos, close: async () => { await started.close(); await employees.close(); } };
}

// An open GET /api/v1/events stream for this client: resolves `ended` with the text received once the server closes it.
async function openStream(app, client) {
  const ctrl = new AbortController();
  const headers = { Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "), Accept: "text/event-stream" };
  const res = await fetch(`${app.url}/api/v1/events`, { headers, signal: ctrl.signal });
  assert.equal(res.status, 200, "the stream opens");
  const reader = res.body.getReader(), dec = new TextDecoder();
  let text = "", readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  const ended = (async () => {
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); if (text.includes("event: ready")) readyResolve(); } } catch { /* aborted */ }
    readyResolve();
    return text;
  })();
  await ready;
  return { ended, abort: () => ctrl.abort() };
}
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms))]);

describe("P3 release verification", () => {
  let issuer, P, app, off;
  const clients = new Map();
  const idOf = (k) => profileId(TEST_ID_KEY, P[k].oid);
  const clientOf = async (target, k) => {
    const key = `${target.url}|${k}`;
    if (!clients.has(key)) { const c = new SessionClient(target.url, issuer.config.appOrigin); assert.equal((await c.signIn(P[k])).status, 201, `sign-in ${k}`); clients.set(key, c); }
    return clients.get(key);
  };
  const as = async (k, method, path, body, options, target = app) => {
    const c = k === "signedOut" ? new SessionClient(target.url, issuer.config.appOrigin) : await clientOf(target, k);
    return c.request(method, path, body, options);
  };
  const manage = (k, target = app) => as("owner", "GET", `${BASE}/all/records/${idOf(k)}/manage-access`, undefined, undefined, target);
  const act = async (k, action, extra = {}) => {
    const loaded = (await manage(k)).body;
    return as("owner", "POST", `${BASE}/all/records/${idOf(k)}/access`, { action, expectedState: loaded.account.state, expectedVersion: loaded.version, ...extra });
  };
  const userOf = (k, target = app) => target.db.collection("users").findOne({ tenantId: issuer.config.tenantId, entraObjectId: P[k].oid });
  const audits = (target = app) => target.db.collection("accountAudit").find({}).toArray();
  const newAudits = async (fn) => { const before = new Set((await audits()).map((e) => String(e._id))); const res = await fn(); return { res, entries: (await audits()).filter((e) => !before.has(String(e._id))) }; };
  let W;

  before(async () => {
    issuer = await createTokenIssuer();
    P = Object.fromEntries(KEYS.map((k) => [k, issuer.person(`Synthetic ${k[0].toUpperCase()}${k.slice(1)}`, k === "sysadmin" ? { admin: true } : {})]));
    app = await boot({ issuer, P, accessAdmin: true });
    off = await boot({ issuer, P, accessAdmin: false });
    for (const k of ["owner", "viewer", "sysadmin", "plain", "tara", "otto", "sam", "rex", "mel", "fay"]) { await clientOf(app, k); }
    for (const k of ["owner", "viewer", "sysadmin", "plain", "tara"]) await clientOf(off, k);
    const now = new Date();
    W = new ObjectId();
    await app.db.collection("workspaces").insertOne({ _id: W, name: "Synthetic WS", archived: false, position: 1, createdAt: now, updatedAt: now, version: 1 });
    await app.repos.memberships.add({ workspaceId: W, userId: (await userOf("owner"))._id, role: "WORKSPACE_ADMIN", now });
  });
  after(async () => { await app?.close(); await off?.close(); });

  // ---------------------------------------------------------------------------------------------------------------- A
  describe("A. deployed with both variables absent", () => {
    const paths = () => [
      ["GET", `${BASE}/all/records/${idOf("tara")}/manage-access`],
      ["GET", `${BASE}/all/records/${idOf("tara")}/access-history`],
      ["POST", `${BASE}/all/records/${idOf("tara")}/access`, { action: "suspend", expectedState: "active", expectedVersion: 0, reason: "Synthetic reason" }],
      ["POST", `${BASE}/all/records/${idOf("tara")}/memberships`, { workspaceRef: "A".repeat(22), role: "MEMBER" }],
      ["PATCH", `${BASE}/all/records/${idOf("tara")}/memberships/${"A".repeat(22)}`, { role: "VIEWER" }],
      ["DELETE", `${BASE}/all/records/${idOf("tara")}/memberships/${"A".repeat(22)}`]
    ];

    test("config: with neither variable set, accessAdmin is false and the System Health viewer list is empty", () => {
      // Entra sign-in with the People directory on (production-like), and neither P3 variable present.
      const env = entraEnv({ JARC_FEATURE_EMPLOYEES: "true", EMPLOYEE_DIRECTORY_COLLECTION: "DirectorySnapshot", FABRIC_MONGODB_URI: "mongodb://directory.invalid", FABRIC_MONGODB_DB_NAME: "SyntheticDirectoryDb", JARC_API_TOKEN_KEY: Buffer.alloc(32, 3).toString("base64") });
      assert.ok(!("JARC_FEATURE_EMPLOYEE_ACCESS_ADMIN" in env) && !("SYSTEM_HEALTH_VIEWER_OIDS" in env));
      const c = loadConfig(env);
      assert.equal(c.employees.enabled, true);
      assert.equal(c.employees.accessAdmin, false);
      assert.deepEqual([...c.systemHealth.viewerObjectIds], []);
    });

    test("every P3 path: owner and viewer 404; JARC.Admin and an unlisted employee 403; signed out and bearer 401; nothing written", async () => {
      const before = { status: (await userOf("tara", off)).status, audit: (await audits(off)).length, sessions: await off.db.collection("sessions").countDocuments({}) };
      for (const [m, p, b] of paths()) {
        for (const who of ["owner", "viewer"]) {
          const res = await as(who, m, p, b, undefined, off);
          assert.equal(res.status, 404, `${who} ${m} ${p}`);
          assert.equal(res.body.error.code, "NOT_FOUND");
        }
        for (const who of ["sysadmin", "plain"]) assert.equal((await as(who, m, p, b, undefined, off)).status, 403, `${who} ${m} ${p}`);
        assert.equal((await as("signedOut", m, p, b, undefined, off)).status, 401, `signed out ${m} ${p}`);
        const owner = await clientOf(off, "owner");
        assert.equal((await owner.request(m, p, b, { headers: { Authorization: "Bearer jarc_synthetic_token" } })).status, 401, `bearer ${m} ${p}`);
      }
      assert.equal((await userOf("tara", off)).status, before.status, "no status change");
      assert.equal((await audits(off)).length, before.audit, "no audit entry");
      assert.equal(await off.db.collection("sessions").countDocuments({}), before.sessions, "no session ended");
    });

    test("/features: no accessAdmin for anyone; systemHealth only for JARC.Admin (view, admin, activity)", async () => {
      const f = async (k) => (await as(k, "GET", "/api/v1/features", undefined, undefined, off)).body.features;
      for (const k of ["owner", "viewer", "plain"]) {
        const features = await f(k);
        assert.ok(!Object.hasOwn(features, "systemHealth"), `${k}: no systemHealth`);
        assert.ok(!Object.hasOwn(features.employees, "accessAdmin"), `${k}: no accessAdmin`);
      }
      assert.deepEqual((await f("owner")).employees, { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"], jarcAccess: true }, "P2 flags unchanged");
      assert.deepEqual((await f("viewer")).employees, { view: true, admin: false, datasets: ["active"] });
      const sys = await f("sysadmin");
      assert.deepEqual(sys.systemHealth, { view: true, admin: true, activity: true });
      assert.ok(!Object.hasOwn(sys.employees, "accessAdmin"));
    });

    test("System Health and Activity History: JARC.Admin only (scope admin); everyone else 403", async () => {
      const h = await as("sysadmin", "GET", "/api/v1/admin/system-health", undefined, undefined, off);
      assert.equal(h.status, 200);
      assert.equal(h.body.scope, "admin");
      assert.equal((await as("sysadmin", "GET", "/api/v1/admin/activity", undefined, undefined, off)).status, 200);
      for (const k of ["owner", "viewer", "plain"]) {
        assert.equal((await as(k, "GET", "/api/v1/admin/system-health", undefined, undefined, off)).status, 403, k);
        assert.equal((await as(k, "GET", "/api/v1/admin/activity", undefined, undefined, off)).status, 403, k);
      }
      assert.equal((await as("signedOut", "GET", "/api/v1/admin/system-health", undefined, undefined, off)).status, 401);
    });

    test("P1 / P2 unchanged: directory, profile and JARC access for the owner; viewer active only; data routes read-only", async () => {
      assert.equal((await as("owner", "GET", `${BASE}/all/records?limit=5`, undefined, undefined, off)).status, 200);
      assert.equal((await as("owner", "GET", `${BASE}/all/records/${idOf("tara")}`, undefined, undefined, off)).status, 200);
      const j = await as("owner", "GET", `${BASE}/all/records/${idOf("tara")}/jarc-access`, undefined, undefined, off);
      assert.equal(j.status, 200);
      assert.equal(j.body.account.status, "active");
      assert.ok(!Object.hasOwn(j.body.account, "provisioned"), "no provisioned key without a P3 pre-provision");
      assert.equal((await as("viewer", "GET", `${BASE}/active/records/${idOf("tara")}`, undefined, undefined, off)).status, 200);
      assert.equal((await as("viewer", "GET", `${BASE}/active/records/${idOf("tara")}/jarc-access`, undefined, undefined, off)).status, 403);
      assert.equal((await as("owner", "POST", `${BASE}/active/records`, {}, undefined, off)).status, 405);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------- B
  describe("B. sessions and sign-in", () => {
    test("suspend: an open events stream ends with session-ended; the cookie then gets 401/403 on /me and /events; sign-in refused, status unchanged", async () => {
      const tara = await clientOf(app, "tara");
      const stream = await openStream(app, tara);
      const s = await act("tara", "suspend", { reason: "Synthetic leave" });
      assert.equal(s.status, 200);
      const text = await within(stream.ended, 5000, "stream end after suspend");
      assert.match(text, /event: session-ended/);
      assert.ok([401, 403].includes((await tara.request("GET", "/api/v1/me")).status));
      assert.ok([401, 403].includes((await tara.request("GET", "/api/v1/events")).status));
      const again = await new SessionClient(app.url, issuer.config.appOrigin).signIn(P.tara);
      assert.equal(again.status, 403);
      assert.equal((await userOf("tara")).status, "suspended");
      assert.equal((await act("tara", "restore")).status, 200);
      const back = new SessionClient(app.url, issuer.config.appOrigin);
      assert.equal((await back.signIn(P.tara)).status, 201);
      clients.set(`${app.url}|tara`, back);
    });

    test("revoke: an open events stream ends; the cookie gets 401/403; sign-in afterwards refused (ACCOUNT_DISABLED) and the status stays revoked", async () => {
      const rex = await clientOf(app, "rex");
      const stream = await openStream(app, rex);
      const v = await act("rex", "revoke", { reason: "Synthetic offboarding", confirm: "REVOKE" });
      assert.equal(v.status, 200);
      assert.equal(v.body.result.sessionsEnded, 1);
      assert.match(await within(stream.ended, 5000, "stream end after revoke"), /event: session-ended/);
      assert.ok([401, 403].includes((await rex.request("GET", "/api/v1/me")).status));
      assert.ok([401, 403].includes((await rex.request("GET", "/api/v1/events")).status));
      for (let i = 0; i < 2; i += 1) {
        const again = await new SessionClient(app.url, issuer.config.appOrigin).signIn(P.rex);
        assert.equal(again.status, 403);
        assert.equal(again.body.error.code, "ACCOUNT_DISABLED");
      }
      assert.equal((await userOf("rex")).status, "revoked", "no automatic reactivation");
      assert.equal(await app.db.collection("sessions").countDocuments({ userId: (await userOf("rex"))._id }), 0);
    });

    test("revoke before registration: sign-in refused twice, no session, status stays revoked, one users document", async () => {
      const v = await act("rita", "revoke", { reason: "Synthetic pre-block", confirm: "REVOKE" });
      assert.equal(v.status, 200);
      assert.equal(v.body.result.from, "not_registered");
      for (let i = 0; i < 2; i += 1) {
        const c = new SessionClient(app.url, issuer.config.appOrigin);
        const r = await c.signIn(P.rita);
        assert.equal(r.status, 403);
        assert.equal(r.body.error.code, "ACCOUNT_DISABLED");
        assert.equal((await c.request("GET", "/api/v1/events")).status, 401);
      }
      const doc = await userOf("rita");
      assert.equal(doc.status, "revoked");
      assert.equal(await app.db.collection("users").countDocuments({ entraObjectId: P.rita.oid.toLowerCase() }), 1);
      assert.equal(await app.db.collection("sessions").countDocuments({ userId: doc._id }), 0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------- C + D
  describe("C/D. tokens and audit across the lifecycle", () => {
    const tok = {};
    let fabric;
    const mint = async (k, product) => {
      const uid = (await userOf(k))._id, now = Date.now();
      const { publicId, token, digest } = generateToken(KEY);
      const _id = new ObjectId();
      await app.repos.apiTokens.insert({ _id, publicId, digest, name: `Synthetic ${product}`, ownerUserId: uid, workspaceId: product === "fabric" ? null : W, boardIds: [], scopes: product === "fabric" ? ["fabric.sales.read"] : ["read"], createdAt: new Date(now), expiresAt: new Date(now + 86400000), revokedAt: null, lastUsedAt: null, requestCount: 0, ...(product === "fabric" ? { product: "fabric" } : {}) });
      return { _id, token };
    };
    // JARC board token: the real external API. Fabric token: the same verify + FabricTokenService.authorize the Fabric API uses.
    const useJarc = async (t) => { const r = await fetch(`${app.url}/api/v1/external/me`, { headers: { Authorization: `Bearer ${t.token}` } }); const b = await r.json().catch(() => null); return r.status === 200 ? "ok" : b?.error?.code; };
    const useFabric = async (t) => { try { await fabric.authorize(await app.dataLayer.services.apiTokens.verify(t.token)); return "ok"; } catch (e) { return e.code; } };
    const uses = async () => Object.fromEntries(await Promise.all(Object.entries(tok).map(async ([k, t]) => [k, k.endsWith("F") ? await useFabric(t) : await useJarc(t)])));
    const tokenDocs = () => app.db.collection("apiTokens").find({ _id: { $in: Object.values(tok).map((t) => t._id) } }).toArray();
    const revokedAudit = () => app.db.collection("apiTokenAudit").find({ action: "token.revoked" }).toArray();
    const ownerUid = async () => (await userOf("owner"))._id;
    const checkEntry = async (e, { action, k, from, to, reason, result = "ok" }) => {
      assert.equal(e.action, action);
      assert.equal(String(e.actorUserId), String(await ownerUid()), "actor");
      assert.equal(e.actorName, "Synthetic Owner");
      assert.equal(e.targetRef, idOf(k), "target (profile ref)");
      const u = await userOf(k);
      if (u) assert.equal(String(e.targetUserId), String(u._id), "target (user)");
      assert.ok(e.at instanceof Date, "at");
      assert.equal(e.result, result);
      assert.equal(e.source, "employee_management");
      if (from !== undefined) assert.deepEqual(e.changes, [{ field: "status", from, to }]);
      if (reason !== undefined) assert.equal(e.reason, reason);
    };

    before(async () => {
      fabric = new FabricTokenService({ tokens: app.dataLayer.services.apiTokens, permissions: { isApiAdmin: () => false, isReader: () => true, isSensitiveReader: () => false } });
      tok.taraJ = await mint("tara", "jarc"); tok.taraF = await mint("tara", "fabric");
      tok.ottoJ = await mint("otto", "jarc"); tok.ottoF = await mint("otto", "fabric");
      tok.samJ = await mint("sam", "jarc"); tok.samF = await mint("sam", "fabric");
    });

    test("baseline: every token works", async () => {
      assert.deepEqual(await uses(), { taraJ: "ok", taraF: "ok", ottoJ: "ok", ottoF: "ok", samJ: "ok", samF: "ok" });
    });

    test("suspend: the target's tokens are refused (not revoked); others untouched; exactly one audit entry; no token audit", async () => {
      const tokenAuditBefore = (await revokedAudit()).length;
      const { res, entries } = await newAudits(() => act("tara", "suspend", { reason: "Synthetic suspension" }));
      assert.equal(res.status, 200);
      assert.equal(entries.length, 1);
      await checkEntry(entries[0], { action: "employee.access.suspended", k: "tara", from: "active", to: "suspended", reason: "Synthetic suspension" });
      const u = await uses();
      assert.equal(u.taraJ, "TOKEN_OWNER_DISABLED"); assert.equal(u.taraF, "TOKEN_OWNER_DISABLED");
      assert.deepEqual([u.ottoJ, u.ottoF, u.samJ, u.samF], ["ok", "ok", "ok", "ok"]);
      assert.ok((await tokenDocs()).every((d) => d.revokedAt === null), "suspend revokes nothing");
      assert.equal((await revokedAudit()).length, tokenAuditBefore);
    });

    test("restore: the target's tokens work again (intended); exactly one audit entry", async () => {
      const { res, entries } = await newAudits(() => act("tara", "restore"));
      assert.equal(res.status, 200);
      assert.equal(entries.length, 1);
      await checkEntry(entries[0], { action: "employee.access.restored", k: "tara", from: "suspended", to: "active" });
      assert.deepEqual(await uses(), { taraJ: "ok", taraF: "ok", ottoJ: "ok", ottoF: "ok", samJ: "ok", samF: "ok" });
    });

    test("revoke: only the target's JARC and Fabric tokens are revoked, each with a token.revoked audit; one accountAudit entry", async () => {
      const others = JSON.stringify((await tokenDocs()).filter((d) => ![String(tok.taraJ._id), String(tok.taraF._id)].includes(String(d._id))).map(({ lastUsedAt, requestCount, ...d }) => d));
      const auditBefore = (await revokedAudit()).length;
      const { res, entries } = await newAudits(() => act("tara", "revoke", { reason: "Synthetic offboarding", confirm: "REVOKE" }));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.result.tokensRevoked, { jarc: 1, fabric: 1 });
      assert.equal(entries.length, 1);
      await checkEntry(entries[0], { action: "employee.access.revoked", k: "tara", from: "active", to: "revoked", reason: "Synthetic offboarding" });
      const added = (await revokedAudit()).slice(auditBefore);
      assert.equal(added.length, 2);
      assert.deepEqual(added.map((a) => String(a.tokenId)).sort(), [String(tok.taraJ._id), String(tok.taraF._id)].sort());
      assert.ok(added.every((a) => String(a.actorUserId) === String(entries[0].actorUserId) && String(a.ownerUserId) === String(entries[0].targetUserId)));
      const after = JSON.stringify((await tokenDocs()).filter((d) => ![String(tok.taraJ._id), String(tok.taraF._id)].includes(String(d._id))).map(({ lastUsedAt, requestCount, ...d }) => d));
      assert.equal(after, others, "other people's tokens unchanged");
      const u = await uses();
      assert.equal(u.taraJ, "TOKEN_REVOKED"); assert.equal(u.taraF, "TOKEN_REVOKED");
      assert.deepEqual([u.ottoJ, u.ottoF, u.samJ, u.samF], ["ok", "ok", "ok", "ok"]);
    });

    test("another person's suspend and restore: the target's revoked tokens stay revoked; that person's tokens refused, then work again", async () => {
      const revokedAt = (await tokenDocs()).filter((d) => d.revokedAt).map((d) => [String(d._id), d.revokedAt.getTime()]);
      assert.equal((await act("sam", "suspend", { reason: "Synthetic short leave" })).status, 200);
      let u = await uses();
      assert.deepEqual([u.samJ, u.samF], ["TOKEN_OWNER_DISABLED", "TOKEN_OWNER_DISABLED"]);
      assert.equal((await act("sam", "restore")).status, 200);
      u = await uses();
      assert.deepEqual(u, { taraJ: "TOKEN_REVOKED", taraF: "TOKEN_REVOKED", ottoJ: "ok", ottoF: "ok", samJ: "ok", samF: "ok" });
      assert.deepEqual((await tokenDocs()).filter((d) => d.revokedAt).map((d) => [String(d._id), d.revokedAt.getTime()]), revokedAt);
    });

    test("grant after revoke: access back, the old tokens stay revoked; exactly one audit entry", async () => {
      const { res, entries } = await newAudits(() => act("tara", "grant"));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.manageAccess.tokens, { jarcActive: 0, fabricActive: 0 });
      assert.equal(entries.length, 1);
      await checkEntry(entries[0], { action: "employee.access.granted", k: "tara", from: "revoked", to: "active" });
      const u = await uses();
      assert.deepEqual(u, { taraJ: "TOKEN_REVOKED", taraF: "TOKEN_REVOKED", ottoJ: "ok", ottoF: "ok", samJ: "ok", samF: "ok" });
    });

    test("audit: provisioned (grant, not registered), revoke before registration, rejected, membership added / role_changed / removed: one entry each", async () => {
      const g = await newAudits(() => act("uma", "grant"));
      assert.equal(g.res.status, 200);
      assert.equal(g.entries.length, 1);
      await checkEntry(g.entries[0], { action: "employee.access.provisioned", k: "uma", from: null, to: "active" });
      // rita was revoked before registration in B: exactly one entry, from null.
      const rita = (await audits()).filter((e) => e.targetRef === idOf("rita"));
      assert.equal(rita.length, 1);
      await checkEntry(rita[0], { action: "employee.access.revoked", k: "rita", from: null, to: "revoked", reason: "Synthetic pre-block" });
      // Rejected: restore on an active account.
      const r = await newAudits(() => act("otto", "restore"));
      assert.equal(r.res.status, 409);
      assert.equal(r.entries.length, 1);
      await checkEntry(r.entries[0], { action: "employee.access.rejected", k: "otto", result: "rejected" });
      assert.equal(r.entries[0].code, "INVALID_TRANSITION");
      assert.equal(r.entries[0].attempted, "restore");
      assert.deepEqual(r.entries[0].changes, []);
      // Memberships.
      const ref = (await manage("mel")).body.workspaces.find((w) => w.name === "Synthetic WS").workspaceRef;
      const mpath = (x) => `${BASE}/all/records/${idOf("mel")}/memberships${x ? `/${x}` : ""}`;
      const steps = [
        ["employee.membership.added", () => as("owner", "POST", mpath(), { workspaceRef: ref, role: "MEMBER" }), 201, null, "MEMBER"],
        ["employee.membership.role_changed", () => as("owner", "PATCH", mpath(ref), { role: "VIEWER" }), 200, "MEMBER", "VIEWER"],
        ["employee.membership.removed", () => as("owner", "DELETE", mpath(ref)), 200, "VIEWER", null]
      ];
      for (const [action, run, status, from, to] of steps) {
        const m = await newAudits(run);
        assert.equal(m.res.status, status, action);
        assert.equal(m.entries.length, 1, action);
        await checkEntry(m.entries[0], { action, k: "mel" });
        assert.deepEqual(m.entries[0].changes, [{ field: "workspaceRole", from, to }]);
        assert.equal(String(m.entries[0].workspaceId), String(W));
      }
    });

    test("a failed accountAudit write rolls back the revoke: status, version and tokens unchanged, no token audit", async () => {
      const f = await mint("fay", "jarc"), ff = await mint("fay", "fabric");
      const before = await userOf("fay");
      const tokenAuditBefore = (await revokedAudit()).length;
      app.fake.failNext({ collection: "accountAudit", op: "insertOne", error: new Error("synthetic audit failure") });
      const res = await act("fay", "revoke", { reason: "Synthetic offboarding", confirm: "REVOKE" });
      assert.ok(res.status >= 500, `status ${res.status}`);
      const now = await userOf("fay");
      assert.equal(now.status, "active");
      assert.equal(now.accessVersion ?? 0, before.accessVersion ?? 0);
      const docs = await app.db.collection("apiTokens").find({ _id: { $in: [f._id, ff._id] } }).toArray();
      assert.ok(docs.every((d) => d.revokedAt === null), "tokens not revoked");
      assert.equal((await revokedAudit()).length, tokenAuditBefore);
      assert.equal(await useJarc(f), "ok");
      assert.equal((await audits()).filter((e) => e.targetRef === idOf("fay") && e.action === "employee.access.revoked").length, 0);
    });

    test("a failed token-audit write rolls back the revoke too", async () => {
      const before = await userOf("fay");
      app.fake.failNext({ collection: "apiTokenAudit", op: "insertOne", error: new Error("synthetic token audit failure") });
      const res = await act("fay", "revoke", { reason: "Synthetic offboarding", confirm: "REVOKE" });
      assert.ok(res.status >= 500, `status ${res.status}`);
      assert.equal((await userOf("fay")).status, "active");
      assert.equal((await userOf("fay")).accessVersion ?? 0, before.accessVersion ?? 0);
      const docs = await app.db.collection("apiTokens").find({ ownerUserId: before._id }).toArray();
      assert.ok(docs.length === 2 && docs.every((d) => d.revokedAt === null));
      assert.equal((await audits()).filter((e) => e.targetRef === idOf("fay") && e.action === "employee.access.revoked").length, 0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------- E
  describe("E. write protection", () => {
    test("CSRF: every P3 write without the token (or from another origin) is 403 CSRF_INVALID and writes nothing", async () => {
      const ref = (await manage("otto")).body.workspaces.find((w) => w.name === "Synthetic WS").workspaceRef;
      const p = `${BASE}/all/records/${idOf("otto")}`;
      const writes = [["POST", `${p}/access`, { action: "suspend", expectedState: "active", expectedVersion: 0, reason: "Synthetic" }], ["POST", `${p}/memberships`, { workspaceRef: ref, role: "MEMBER" }], ["PATCH", `${p}/memberships/${ref}`, { role: "VIEWER" }], ["DELETE", `${p}/memberships/${ref}`]];
      const owner = await clientOf(app, "owner");
      const before = { audit: (await audits()).length, members: await app.db.collection("workspaceMembers").countDocuments({}), status: (await userOf("otto")).status };
      for (const [m, path, body] of writes) {
        for (const opts of [{ csrf: null }, { origin: "https://evil.example.invalid" }]) {
          const r = await owner.request(m, path, body, opts);
          assert.equal(r.status, 403, `${m} ${path} ${JSON.stringify(opts)}`);
          assert.equal(r.body.error.code, "CSRF_INVALID");
        }
      }
      assert.deepEqual({ audit: (await audits()).length, members: await app.db.collection("workspaceMembers").countDocuments({}), status: (await userOf("otto")).status }, before);
    });

    test("the history route is read-only: POST / PUT / PATCH / DELETE are 405 and leave the audit unchanged; PUT on access too", async () => {
      const before = JSON.stringify(await audits());
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await as("owner", m, `${BASE}/all/records/${idOf("tara")}/access-history`, m === "DELETE" ? undefined : {})).status, 405, m);
      for (const m of ["PUT", "DELETE"]) assert.equal((await as("owner", m, `${BASE}/all/records/${idOf("tara")}/access`, m === "DELETE" ? undefined : {})).status, 405, m);
      assert.equal(JSON.stringify(await audits()), before);
    });

    test("no raw ObjectId (user, workspace, token) in the manage-access or history bodies", async () => {
      const ids = [String(W), String((await userOf("tara"))._id), String((await userOf("owner"))._id)];
      for (const path of [`${BASE}/all/records/${idOf("tara")}/manage-access`, `${BASE}/all/records/${idOf("tara")}/access-history`, `${BASE}/all/records/${idOf("mel")}/access-history`]) {
        const r = await as("owner", "GET", path);
        assert.equal(r.status, 200);
        for (const id of ids) assert.ok(!r.text.includes(id), `${path} leaks an ID`);
        assert.ok(!/(^|[^0-9a-f])[0-9a-f]{24}([^0-9a-f]|$)/.test(r.text), `${path}: ObjectId-shaped text`);
        assert.ok(!/"workspaceId"/.test(r.text), `${path}: workspaceId key`);
      }
    });
  });
});
