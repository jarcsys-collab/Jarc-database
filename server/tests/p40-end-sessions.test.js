// P4-0 O5 "End sessions": an Employee Management administrator ends every JARC session of ONE person (and their live streams)
// without changing their status. Service level on JARC's real data layer over the in-memory fake (p40-world), then through the
// real app (Entra sign-in with the local test issuer, CSRF, the 60-minute re-auth, the live stream, the rate limit).
// Concurrency on the fake runs through serialised transactions (what a MongoDB WriteConflict plus the driver's retry amounts
// to; see p40-admin-authority). Synthetic people only, invented IDs; no network.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { FakeMongoClient } = require("./support/fake-mongo");
const { MongoConnection } = require("../src/db/connection");
const { buildWorld, ADMIN } = require("./support/p40-world");
const { END_SESSIONS_NOTE } = require("../src/employees/access-admin");
const { sensitiveAdminRequest } = require("../src/auth/session");
const { SessionClient, startApp } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { openStream } = require("./support/sse-client");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { createEntraVerifier } = require("../src/auth/entra-token");
const { createEmployees, profileId } = require("../src/employees");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const fakeConnection = async () => { const c = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => new FakeMongoClient() }); await c.connect(); return c; };
const world = async (options = {}) => buildWorld(await fakeConnection(), options);
const REASON = "Synthetic offboarding check";
const end = (w, i, actor, body = { reason: REASON }) => w.service.endSessions("all", w.idOf(i), body, ADMIN, actor);
const sessionsOf = (w, doc) => w.db.collection("sessions").countDocuments({ userId: doc._id });
const refusedWith = (status, code) => (e) => e.status === status && e.code === code;

describe("O5 End sessions (service)", () => {
  test("ends every session of the person, changes nothing else, audits actor / target / count / reason (no session IDs)", async () => {
    const w = await world();
    const me = await w.register(0);
    const t = await w.register(3, { accessVersion: 4 });
    await w.liveSession(t, false); await w.liveSession(t, false);
    const other = await w.register(4); await w.liveSession(other, false);
    const ids = (await w.db.collection("sessions").find({ userId: t._id }).toArray()).map((s) => s._id);
    const signalled = [];
    w.service.onSessionsEnded = (userId) => { signalled.push(String(userId)); };
    const res = await end(w, 3, w.actorOf(me));
    assert.deepEqual(res.result, { action: "end_sessions", sessionsEnded: 2 });
    assert.equal(await sessionsOf(w, t), 0, "the person's sessions are gone");
    assert.equal(await sessionsOf(w, other), 1, "nobody else's");
    const after = await w.fresh(3);
    assert.equal(after.status, "active", "no status change");
    assert.equal(after.accessVersion, 4, "no access version change");
    assert.deepEqual(signalled, [String(t._id)], "the live streams are signalled once, with that person");
    assert.equal(res.manageAccess.account.signedInNow, false);
    const audit = await w.db.collection("accountAudit").findOne({ action: "employee.sessions.ended" });
    assert.ok(audit.targetUserId.equals(t._id)); assert.ok(audit.actorUserId.equals(me._id));
    assert.equal(audit.reason, REASON); assert.equal(audit.result, "ok"); assert.equal(audit.source, "employee_management");
    assert.deepEqual(audit.changes, [{ field: "sessions", from: 2, to: 0 }]);
    const text = JSON.stringify(audit);
    for (const id of ids) assert.equal(text.includes(id), false, "no session ID in the audit");
    assert.doesNotMatch(text, /token|cookie|secret/i);
    const hist = await w.service.history("all", w.idOf(3), {}, ADMIN);
    assert.equal(hist.items[0].action, "employee.sessions.ended");
  });

  test("refuses self (403 SELF_END_SESSIONS, audited as a refused end_sessions) and someone without a JARC account", async () => {
    const w = await world();
    const me = await w.register(0);
    await w.liveSession(me, false);
    await assert.rejects(end(w, 0, w.actorOf(me)), refusedWith(403, "SELF_END_SESSIONS"));
    assert.equal(await sessionsOf(w, me), 1);
    const rejected = await w.db.collection("accountAudit").findOne({ action: "employee.access.rejected" });
    assert.equal(rejected.code, "SELF_END_SESSIONS"); assert.equal(rejected.attempted, "end_sessions");
    await assert.rejects(end(w, 5, w.actorOf(me)), refusedWith(409, "NOT_REGISTERED"));
    const view = await w.manage(0, w.actorOf(me));
    assert.deepEqual(view.actions.find((a) => a.action === "end_sessions"), { action: "end_sessions", allowed: false, code: "SELF_END_SESSIONS", reason: "You can't end your own JARC sessions here. Use Sign out instead." });
    assert.equal((await w.manage(5, w.actorOf(me))).actions.some((a) => a.action === "end_sessions"), false, "not listed for someone not registered");
  });

  test("the reason is required and bounded; no other field is accepted", async () => {
    const w = await world();
    const me = await w.register(0);
    const t = await w.register(3); await w.liveSession(t, false);
    for (const body of [{}, { reason: "  " }, { reason: "no" }, { reason: "x".repeat(501) }, { reason: "two\nlines" }, { reason: 42 }, { reason: REASON, all: true }, { reason: REASON, targets: ["a"] }, null, []]) {
      await assert.rejects(end(w, 3, w.actorOf(me), body), (e) => e.status === 400 && e.code === "VALIDATION_ERROR", JSON.stringify(body));
    }
    assert.equal(await sessionsOf(w, t), 1, "nothing ended");
    assert.equal((await end(w, 3, w.actorOf(me), { reason: "x".repeat(500) })).result.sessionsEnded, 1);
  });

  test("an UNKNOWN administrator status is allowed (reversible, non-escalating); the GET lists it allowed with the note", async () => {
    const w = await world();
    const me = await w.register(0);
    const t = await w.register(3, { adminRoleClearedAt: undefined });
    assert.equal((await w.manage(3, w.actorOf(me))).account.jarcAdministrator, "unknown");
    const listed = (await w.manage(3, w.actorOf(me))).actions.find((a) => a.action === "end_sessions");
    assert.deepEqual(listed, { action: "end_sessions", allowed: true, reasonRequired: true, note: END_SESSIONS_NOTE });
    assert.equal((await end(w, 3, w.actorOf(me))).result.sessionsEnded, 0);
    // Suspend stays blocked for the same person (O4: no exception).
    await assert.rejects(w.suspend(3, w.actorOf(me)), refusedWith(409, "ADMIN_STATUS_UNKNOWN"));
    assert.ok(t);
  });

  test("a recognised JARC administrator: refused while no OTHER usable recognised administrator remains; allowed once one does", async () => {
    const w = await world({ superAdminIndex: 6 });
    const me = await w.register(0); // an Employee Management administrator, not a JARC administrator
    const a = await w.register(3, { adminRoleSeenAt: new Date() });
    await w.liveSession(a, true);
    await assert.rejects(end(w, 3, w.actorOf(me)), refusedWith(409, "LAST_USABLE_JARC_ADMIN"));
    assert.equal(await sessionsOf(w, a), 1);
    assert.equal((await w.manage(3, w.actorOf(me))).actions.find((x) => x.action === "end_sessions").code, "LAST_USABLE_JARC_ADMIN");
    // Unusable "others" don't count: suspended, revoked, a blocked account, a role cleared at a later sign-in.
    await w.register(4, { adminRoleSeenAt: new Date(), status: "suspended" });
    await w.register(5, { adminRoleSeenAt: new Date(), account: { status: "blocked", role: "ADMIN", version: 2 } });
    await w.register(7, { adminRoleSeenAt: new Date(1000), adminRoleClearedAt: new Date(2000) });
    await w.register(8, { adminRoleSeenAt: new Date(), status: "revoked" });
    await assert.rejects(end(w, 3, w.actorOf(me)), refusedWith(409, "LAST_USABLE_JARC_ADMIN"));
    // A usable other: the configured Super Admin identity.
    await w.register(6);
    assert.equal((await end(w, 3, w.actorOf(me))).result.sessionsEnded, 1);
    assert.equal((await w.fresh(3)).status, "active");
  });

  test("each kind of other administrator counts: an active Super Admin account, a recorded role, a live JARC.Admin session", async () => {
    for (const make of [(w) => w.register(4, { account: w.superAdminAccount }), (w) => w.register(4, { adminRoleSeenAt: new Date() }), async (w) => w.liveSession(await w.register(4), true)]) {
      const w = await world();
      const me = await w.register(0);
      const a = await w.register(3, { adminRoleSeenAt: new Date() }); await w.liveSession(a, true);
      await make(w);
      assert.equal((await end(w, 3, w.actorOf(me))).result.sessionsEnded, 1);
    }
  });

  test("ACCOUNT_MANAGEMENT=enforced: only an active Super Admin counts as the other administrator", async () => {
    const w = await world({ accountMode: "enforced" });
    const me = await w.register(0, { account: { status: "active", role: "ADMIN", version: 1 } });
    const root = await w.register(3, { account: w.superAdminAccount }); await w.liveSession(root, true);
    await w.register(4, { adminRoleSeenAt: new Date(), account: { status: "active", role: "ADMIN", version: 1 } });
    await assert.rejects(end(w, 3, w.actorOf(me)), refusedWith(409, "LAST_USABLE_JARC_ADMIN"));
    await w.register(5, { account: w.superAdminAccount });
    assert.equal((await end(w, 3, w.actorOf(me))).result.sessionsEnded, 1);
  });

  test("concurrent: two administrators known only by their live JARC.Admin sessions, ended at once: one succeeds, one is refused", async () => {
    for (const order of [0, 1]) {
      const w = await world({ serial: true, admins: [0, 1] });
      const x = await w.register(0), y = await w.register(1);
      const a = await w.register(3), b = await w.register(4);
      await w.liveSession(a, true); await w.liveSession(b, true);
      const runs = [() => end(w, 3, w.actorOf(x)), () => end(w, 4, w.actorOf(y))];
      const results = await Promise.allSettled(order ? [runs[1](), runs[0]()] : [runs[0](), runs[1]()]);
      assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
      assert.equal(results.find((r) => r.status === "rejected").reason.code, "LAST_USABLE_JARC_ADMIN");
      assert.equal((await sessionsOf(w, a)) + (await sessionsOf(w, b)), 1, "one administrator stays signed in");
    }
  });

  test("concurrent: two administrators with a RECORDED role: both may be signed out (both stay recognised and can sign in again)", async () => {
    const w = await world({ serial: true, admins: [0, 1] });
    const x = await w.register(0), y = await w.register(1);
    const a = await w.register(3, { adminRoleSeenAt: new Date() }), b = await w.register(4, { adminRoleSeenAt: new Date() });
    await w.liveSession(a, true); await w.liveSession(b, true);
    const results = await Promise.allSettled([end(w, 3, w.actorOf(x)), end(w, 4, w.actorOf(y))]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
    for (const i of [3, 4]) assert.equal((await w.manage(i, w.actorOf(x))).account.jarcAdministrator, "role");
  });

  test("the transaction writes the target and the administrator it relied on (so concurrent decisions conflict on a real MongoDB)", async () => {
    const w = await world();
    const me = await w.register(0);
    const a = await w.register(3, { adminRoleSeenAt: new Date() }), b = await w.register(4, { adminRoleSeenAt: new Date() });
    await end(w, 3, w.actorOf(me));
    assert.ok((await w.fresh(3)).accessActionAt instanceof Date, "target touched");
    assert.ok((await w.fresh(4)).accessActionAt instanceof Date, "the other administrator touched");
    assert.ok(a && b);
  });

  test("a suspended actor can't act; the route is a sensitive administrator write (60-minute re-auth)", async () => {
    const w = await world();
    const me = await w.register(0, { status: "suspended" });
    await w.register(3);
    await assert.rejects(end(w, 3, w.actorOf(me)), refusedWith(403, "EMPLOYEES_FORBIDDEN"));
    for (const path of ["/api/v1/admin/employees/all/records/AAAAAAAAAAAAAAAAAAAAAA/end-sessions", "/admin/employees/all/records/AAAAAAAAAAAAAAAAAAAAAA/end-sessions/"]) {
      assert.equal(sensitiveAdminRequest({ method: "POST", baseUrl: "", path }), true, path);
      assert.equal(sensitiveAdminRequest({ method: "GET", baseUrl: "", path }), false);
    }
  });
});

// ---- The recent sign-in rule (auth/session.js middleware), in every account mode, with and without the claim
describe("O5 End sessions: recent sign-in in every account mode", () => {
  const { sessionAuthentication, csrfTokenFor, recentSignInRequest } = require("../src/auth/session");
  const SECRET = "SyntheticSessionSecretValue0000000000001";
  const entra = { tenantId: "t", appOrigin: "https://jarc.example.test", sessionIdleMinutes: 30 };
  const run = async ({ accountMode, isSystemAdmin, ageMin, path: p }) => {
    const now = Date.now();
    const user = { _id: "u1", status: "active", tenantId: "t", entraObjectId: "o", account: { status: "active", role: "SUPER_ADMIN", version: 1 } };
    const session = { _id: "s1", userId: "u1", tenantId: "t", objectId: "o", isSystemAdmin, createdAt: new Date(now - ageMin * 60000), lastSeenAt: new Date(now), idleExpiresAt: new Date(now + 3600000), expiresAt: new Date(now + 7200000) };
    const mw = sessionAuthentication({ sessions: { findBySecret: async () => session, touch: async () => {}, remove: async () => {} }, users: { findById: async () => user }, entra, accountMode });
    const headers = { cookie: `__Host-jarc_session=${SECRET}`, origin: entra.appOrigin, "x-csrf-token": csrfTokenFor(SECRET) };
    const req = { method: "POST", baseUrl: "/api/v1/admin/employees", path: p, get: (h) => headers[h.toLowerCase()] };
    let out = null, passed = false;
    const res = { locals: {}, append() {}, status(s) { out = { status: s }; return this; }, set() { return this; }, json(b) { out.body = b; return this; } };
    await mw(req, res, () => { passed = true; });
    return passed ? "next" : `${out.status} ${out.body.error.code}`;
  };
  const END = "/all/records/SyntheticProfileId0001/end-sessions";
  test("stale sign-in (61 min): REAUTH_REQUIRED for End sessions in off / staged / enforced, claim or not; fresh (5 min): passes", async () => {
    for (const accountMode of ["off", "staged", "enforced"]) for (const isSystemAdmin of [false, true]) {
      assert.equal(await run({ accountMode, isSystemAdmin, ageMin: 61, path: END }), "403 REAUTH_REQUIRED", `${accountMode} claim=${isSystemAdmin}`);
      assert.equal(await run({ accountMode, isSystemAdmin, ageMin: 5, path: END }), "next", `${accountMode} claim=${isSystemAdmin} fresh`);
    }
  });
  test("the other P3 routes keep their rule: a stale session without the claim passes; under enforced even with the claim", async () => {
    for (const accountMode of ["off", "staged", "enforced"]) assert.equal(await run({ accountMode, isSystemAdmin: false, ageMin: 61, path: "/all/records/SyntheticProfileId0001/access" }), "next", accountMode);
    assert.equal(await run({ accountMode: "enforced", isSystemAdmin: true, ageMin: 61, path: "/all/records/SyntheticProfileId0001/memberships" }), "next");
    assert.equal(await run({ accountMode: "staged", isSystemAdmin: true, ageMin: 61, path: "/all/records/SyntheticProfileId0001/access" }), "403 REAUTH_REQUIRED", "unchanged claim rule");
    assert.equal(recentSignInRequest({ method: "GET", baseUrl: "/api/v1/admin/employees", path: END }), false, "reads never");
  });
});

// ---- Through the real app
const BASE = "/api/v1/admin/employees";
const KEYS = ["owner", "admin2", "boss", "viewer", "outsider", "alice", "bob", "carol", "dana"];
async function boot({ issuer, P, accessAdmin = true }) {
  const fake = new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const logger = { errors: [], error(...a) { this.errors.push(a.join(" ")); }, warn() {}, info() {} };
  const dataLayer = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), environment: "test" });
  const docs = syntheticPeople(KEYS.length, { seed: "p40o5" });
  KEYS.forEach((k, i) => { docs[i].user_id = P[k].oid; docs[i].user_type = "Member"; docs[i].account_enabled = true; });
  const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: issuer.config.tenantId, viewerObjectIds: [P.viewer.oid], adminObjectIds: [P.owner.oid, P.admin2.oid, P.boss.oid], accessAdmin }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
  const employees = createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs }), idKey: TEST_ID_KEY, logger });
  // The stream's own session check runs once a minute here: only the explicit End sessions signal can end it within the test.
  const started = await startApp({ dataLayer, logger, employees, auth: { mode: "entra", entra: issuer.config, verify: createEntraVerifier({ ...issuer.config, keySet: issuer.keySet }) }, accessPolicy: "development_shared", betaOpenEditing: true, apiTokens: { key: Buffer.alloc(32, 9), adminObjectIds: [] }, employeeWriteLimiter: () => true, live: { pollMs: 50, overlapMs: 2000, timings: { session: 60000, access: 60000, heartbeat: 60000 } } });
  return { ...started, logger, db: connection.db, close: async () => { await started.close(); await employees.close(); } };
}

describe("O5 End sessions (real app)", () => {
  let issuer, P, app, off;
  const clients = new Map();
  const idOf = (k) => profileId(TEST_ID_KEY, P[k].oid);
  const clientOf = async (target, k, fresh = false) => {
    const key = `${target.url}|${k}`;
    if (fresh || !clients.has(key)) { const c = new SessionClient(target.url, issuer.config.appOrigin); assert.equal((await c.signIn(P[k])).status, 201, `sign-in ${k}`); clients.set(key, c); }
    return clients.get(key);
  };
  const path = (k) => `${BASE}/all/records/${idOf(k)}/end-sessions`;
  const post = async (who, k, body = { reason: REASON }, options, target = app) => (who === "signedOut" ? new SessionClient(target.url, issuer.config.appOrigin) : await clientOf(target, who)).request("POST", path(k), body, options);
  const userOf = (k) => app.db.collection("users").findOne({ entraObjectId: P[k].oid });
  const liveCount = async (k) => app.db.collection("sessions").countDocuments({ userId: (await userOf(k))._id });
  const cookieOf = (c) => [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ");

  before(async () => {
    issuer = await createTokenIssuer();
    P = Object.fromEntries(KEYS.map((k) => [k, issuer.person(`Synthetic ${k[0].toUpperCase()}${k.slice(1)}`, k === "outsider" || k === "boss" ? { admin: true } : {})]));
    app = await boot({ issuer, P });
    off = await boot({ issuer, P, accessAdmin: false });
  });
  after(async () => { await app?.close(); await off?.close(); });

  test("authorization: switch off 404; viewer and a JARC.Admin outsider 403; signed out and bearer 401; GET 405", async () => {
    await clientOf(app, "alice");
    for (const who of ["owner", "viewer"]) assert.equal((await post(who, "alice", undefined, undefined, off)).status, 404, `off ${who}`);
    for (const who of ["viewer", "outsider"]) { const r = await post(who, "alice"); assert.equal(r.status, 403, who); assert.equal(r.body.error.code, "EMPLOYEES_FORBIDDEN"); }
    assert.equal((await post("signedOut", "alice")).status, 401);
    assert.equal((await post("owner", "alice", { reason: REASON }, { headers: { Authorization: "Bearer jarc_synthetic_token" } })).status, 401);
    assert.equal((await (await clientOf(app, "owner")).request("GET", path("alice"))).status, 405);
    assert.equal((await (await clientOf(app, "owner")).request("POST", `${path("alice")}?all=1`, { reason: REASON })).status, 400, "no query (no bulk)");
    assert.ok(await liveCount("alice") >= 1, "nothing ended");
  });

  test("CSRF: a missing token or a foreign origin is refused before anything happens", async () => {
    await clientOf(app, "bob");
    const missing = await post("owner", "bob", { reason: REASON }, { csrf: null });
    assert.equal(missing.status, 403); assert.equal(missing.body.error.code, "CSRF_INVALID");
    const foreign = await post("owner", "bob", { reason: REASON }, { origin: "https://evil.example.com" });
    assert.equal(foreign.status, 403); assert.equal(foreign.body.error.code, "CSRF_INVALID");
    assert.ok(await liveCount("bob") >= 1);
  });

  test("freshness: an administrator session whose JARC.Admin claim is over 60 minutes old gets 403 REAUTH_REQUIRED; a new sign-in works", async () => {
    await clientOf(app, "carol");
    const boss = await clientOf(app, "boss");
    const bossUser = await userOf("boss");
    for (const s of await app.db.collection("sessions").find({ userId: bossUser._id }).toArray()) await app.db.collection("sessions").updateOne({ _id: s._id }, { $set: { createdAt: new Date(s.createdAt.getTime() - 2 * 3600 * 1000) } });
    const stale = await boss.request("POST", path("carol"), { reason: REASON });
    assert.equal(stale.status, 403); assert.equal(stale.body.error.code, "REAUTH_REQUIRED");
    assert.ok(await liveCount("carol") >= 1);
    const again = await clientOf(app, "boss", true);
    const ok = await again.request("POST", path("carol"), { reason: REASON });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.ok(ok.body.result.sessionsEnded >= 1);
    assert.equal(await liveCount("carol"), 0);
  });

  test("a recent sign-in is required for EVERY session: an Employee Management admin WITHOUT the claim, signed in over 60 minutes ago, is refused; after a new sign-in, allowed", async () => {
    assert.ok(await clientOf(app, "bob", true));
    const owner = await clientOf(app, "owner");
    const ownerUser = await userOf("owner");
    const own = await app.db.collection("sessions").find({ userId: ownerUser._id }).toArray();
    assert.ok(own.length && own.every((s) => s.isSystemAdmin === false), "the owner's session carries no JARC.Admin claim");
    for (const s of own) await app.db.collection("sessions").updateOne({ _id: s._id }, { $set: { createdAt: new Date(Date.now() - 61 * 60 * 1000) } });
    const stale = await owner.request("POST", path("bob"), { reason: REASON });
    assert.equal(stale.status, 403); assert.equal(stale.body.error.code, "REAUTH_REQUIRED");
    assert.ok(await liveCount("bob") >= 1, "nothing ended");
    // The other P3 routes keep their rule (no claim → not gated): the same stale session still reads Manage access.
    assert.equal((await owner.request("GET", `${BASE}/all/records/${idOf("bob")}/manage-access`)).status, 200);
    const fresh = await clientOf(app, "owner", true);
    const ok = await fresh.request("POST", path("bob"), { reason: REASON });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.ok(ok.body.result.sessionsEnded >= 1);
  });

  test("sessions gone and the live stream closed at once (session-ended); the person's cookie no longer works; status unchanged", async () => {
    const dana = await clientOf(app, "dana");
    const stream = await openStream(`${app.url}/api/v1/events`, { headers: { Cookie: cookieOf(dana) } });
    assert.ok(await stream.waitFor((m) => m.event === "ready", 3000), "stream open");
    const t0 = Date.now();
    const res = await post("owner", "dana");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.result.sessionsEnded, 1);
    assert.ok(await stream.waitFor((m) => m.event === "session-ended", 3000), "session-ended sent");
    assert.ok(Date.now() - t0 < 3000, "well before the stream's own 60 s check");
    await stream.close();
    assert.equal((await dana.request("GET", "/api/v1/auth/session")).status, 401);
    assert.equal((await userOf("dana")).status, "active", "not suspended");
    assert.equal(res.body.manageAccess.account.state, "active");
    assert.equal(JSON.stringify(res.body).includes(String((await userOf("dana"))._id)), false, "no raw user ID in the answer");
    // They can sign in again (the account isn't suspended).
    assert.equal((await new SessionClient(app.url, issuer.config.appOrigin).signIn(P.dana)).status, 201);
  });

  test("rate limit per administrator: 10 attempts per 10 minutes, the 11th is 429 (another administrator is unaffected)", async () => {
    for (let i = 0; i < 10; i += 1) { const r = await post("admin2", "admin2"); assert.equal(r.status, 403, `attempt ${i + 1}`); assert.equal(r.body.error.code, "SELF_END_SESSIONS"); }
    const limited = await post("admin2", "admin2");
    assert.equal(limited.status, 429); assert.equal(limited.body.error.code, "RATE_LIMITED"); assert.equal(limited.headers.get("retry-after"), "600");
    assert.equal((await post("owner", "owner")).body.error.code, "SELF_END_SESSIONS", "the owner's own budget");
  });
});

// ---- The Manage access tab (EmployeeManage.js in a vm, stubbed adapter)
describe("O5 End sessions (UI)", () => {
  const fs = require("fs"), pathMod = require("path"), vm = require("vm");
  const src = fs.readFileSync(pathMod.resolve(__dirname, "..", "..", "site", "assets", "EmployeeManage.js"), "utf8");
  const ctx = vm.createContext({ console, Intl, Date, URLSearchParams, encodeURIComponent, setTimeout, module: { exports: {} } });
  vm.runInContext(src, ctx, { filename: "EmployeeManage.js" });
  const M = vm.runInContext("module.exports", ctx);
  const ID = "SyntheticProfileId0001";
  const data = (endSessions) => ({ id: ID, version: 2, account: { state: "active", signedInNow: true, entraEnabled: true }, actions: [{ action: "suspend", allowed: true, reasonRequired: true }, endSessions], tokens: { jarcActive: 1, fabricActive: 0 }, workspaces: [], sharedAccess: { on: false }, warnings: [] });
  const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");
  const panel = (d) => {
    const overlays = [], calls = [], toasts = [];
    const p = { explorer: { ds: "all", recordId: ID, record: { data: { values: { displayName: "Synthetic Person 1" } } } }, manage: { ...M.slot(), key: `/admin/employees/all/records/${ID}/manage-access`, data: d }, redraw() {}, announce() {}, profileTabFor: () => "manage",
      adapter: { async request(m, path, body) { calls.push([m, path, body]); return { manageAccess: d, result: { action: "end_sessions", sessionsEnded: 2 } }; } },
      c: { view: { overlay: (h) => overlays.push(h), closeOverlay() {}, toast: (t) => toasts.push(t) } } };
    return { p, overlays, calls, toasts };
  };
  const form = (reason) => ({ elements: { reason: { value: reason } } });

  test("the button, the confirmation's exact words, a required reason, POST …/end-sessions { reason } only, the outcome", async () => {
    const { p, overlays, calls, toasts } = panel(data({ action: "end_sessions", allowed: true, reasonRequired: true }));
    const html = M.html(p.explorer, p.manage);
    assert.match(html, /<button type="button" class="fx-btn emp-m__act" data-action="emp-m-open" data-act="end_sessions"[^>]*>End sessions…<\/button>/);
    M.onAction(p, "emp-m-open", { dataset: { act: "end_sessions", focusKey: "emp-m-act-end_sessions" } });
    const d = overlays.at(-1);
    assert.match(d, /role="dialog" aria-modal="true"/); assert.match(d, /aria-labelledby="emp-m-d-title" aria-describedby="emp-m-d-lead"/);
    assert.match(text(d), /End Synthetic Person 1's JARC sessions\?/);
    assert.ok(text(d).includes("This signs them out of JARC now. It does not suspend the account: if their Microsoft account is still active they can sign in again. API keys are separate: revoke them in Developer → API Keys and Fabric Data → API Management."), text(d));
    assert.equal(M.END_SESSIONS_LEAD.join(" "), END_SESSIONS_NOTE, "the same words as the server");
    assert.match(d, /id="emp-m-d-reason"[^>]* required aria-required="true"/);
    assert.match(d, /class="fx-btn fx-btn--danger"[^>]*>End sessions</);
    assert.doesNotMatch(d, /style=|#[0-9a-f]{3,6}\b/i, "only theme classes (light and dark come from the design tokens)");
    await M.submit(p, form("no"));
    assert.equal(calls.length, 0, "a short reason is refused locally");
    await M.submit(p, form(REASON));
    assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(([m]) => m !== "GET"))), [["POST", `/admin/employees/all/records/${ID}/end-sessions`, { reason: REASON }]]);
    assert.deepEqual(toasts, ["Sessions ended"]);
    assert.match(p.manage.notice.text, /isn't suspended/); assert.match(p.manage.notice.text, /2 JARC sessions ended\./);
  });

  test("refused: disabled with the reason; refusal codes, history wording", () => {
    const { p } = panel(data({ action: "end_sessions", allowed: false, code: "LAST_USABLE_JARC_ADMIN", reason: "" }));
    const html = M.html(p.explorer, p.manage);
    assert.match(html, /data-act="end_sessions"[^>]*aria-describedby="emp-m-why-end_sessions-all"[^>]* disabled>End sessions…/);
    assert.match(text(html), /End sessions: This person is the only usable JARC administrator/);
    assert.match(M.info({ cause: { status: 403, serverCode: "SELF_END_SESSIONS" } }, false).message, /Use Sign out instead/);
    assert.match(M.info({ cause: { status: 409, serverCode: "LAST_USABLE_JARC_ADMIN" } }, false).message, /only usable JARC administrator/);
    const hist = M.historyHtml(p.explorer, { loaded: true, items: [{ at: "2026-11-26T01:00:00.000Z", action: "employee.sessions.ended", result: "ok", actor: "Synthetic Owner", changes: [{ field: "sessions", from: 2, to: 0 }], reason: REASON }, { at: "2026-11-26T00:00:00.000Z", action: "employee.access.rejected", result: "rejected", actor: "Synthetic Owner", changes: [], code: "SELF_END_SESSIONS", attempted: "end_sessions" }] }, false);
    assert.match(text(hist), /Sessions ended Done/); assert.match(text(hist), /JARC sessions: 2 → to 0/); assert.match(text(hist), /Change refused · End sessions/);
  });
});
