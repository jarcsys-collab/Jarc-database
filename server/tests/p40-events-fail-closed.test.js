// P4-0 (D-H6, A6 F9 / F2): the live-update stream fails closed. A failed access re-read or session check ends the stream (the
// browser reconnects and is re-authorized) instead of keeping the old scope; a change of the session's JARC.Admin claim, the
// users.status or the account ends it too. Normal events are unaffected. Offline: fake MongoDB, local test keys, synthetic people.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { openStream } = require("./support/sse-client");
const { entraSessionCheck } = require("../src/routes/events");

const LIVE = { pollMs: 50, overlapMs: 2000, timings: { session: 150, access: 150, heartbeat: 1000 } };
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }];
const cookieOf = (client) => [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
const waitEnded = async (s, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end && !s.ended) await new Promise((r) => setTimeout(r, 25)); return s.ended; };

describe("entraSessionCheck (unit)", () => {
  const session = (extra = {}) => ({ userId: "u", expiresAt: new Date(Date.now() + 60000), idleExpiresAt: new Date(Date.now() + 60000), isSystemAdmin: false, ...extra });
  const check = (s, user) => entraSessionCheck({ sessions: { findBySecret: async () => s }, users: { findById: async () => user } });
  const account = { legacy: false, status: "active", role: "ADMIN", version: 3 };
  test("the JARC.Admin claim differs from the stream's → refresh; same → ok", async () => {
    const user = { status: "active" };
    assert.equal(await check(session({ isSystemAdmin: true }), user)({ sessionSecret: "x", actor: { hasAdminAppRole: false } }), "refresh");
    assert.equal(await check(session({ isSystemAdmin: false }), user)({ sessionSecret: "x", actor: { hasAdminAppRole: true } }), "refresh");
    assert.equal(await check(session(), user)({ sessionSecret: "x", actor: { hasAdminAppRole: false } }), true);
  });
  test("users.status not active → session ended; account status / role / version change → refresh", async () => {
    assert.equal(await check(session(), { status: "suspended" })({ sessionSecret: "x", actor: { hasAdminAppRole: false } }), false);
    const actor = { hasAdminAppRole: false, account };
    const userWith = (a) => ({ status: "active", account: a });
    assert.equal(await check(session(), userWith({ status: "active", role: "ADMIN", version: 3 }))({ sessionSecret: "x", actor }), true);
    assert.equal(await check(session(), userWith({ status: "active", role: "EDITOR", version: 3 }))({ sessionSecret: "x", actor }), "refresh", "role (even at the same version)");
    assert.equal(await check(session(), userWith({ status: "pending", role: "ADMIN", version: 3 }))({ sessionSecret: "x", actor }), "refresh", "status");
    assert.equal(await check(session(), userWith({ status: "active", role: "ADMIN", version: 4 }))({ sessionSecret: "x", actor }), "refresh", "version");
    assert.equal(await check(session(), userWith({ status: "blocked", role: "ADMIN", version: 4 }))({ sessionSecret: "x", actor }), false, "blocked ends the session");
  });
});

describe("the live stream fails closed (through the real app)", () => {
  let app, issuer, admin, ana, ws, board;
  const client = () => new SessionClient(app.url, app.entra.appOrigin);
  const listen = (c) => openStream(`${app.url}/api/v1/events`, { headers: { Cookie: cookieOf(c) } });
  before(async () => {
    issuer = await createTokenIssuer();
    app = await startEntraApp({ issuer, live: LIVE });
    admin = client(); ana = client();
    await admin.signIn(issuer.person("Synthetic Live Admin", { admin: true }));
    await ana.signIn(issuer.person("Synthetic Live Member"));
    ws = (await admin.request("POST", "/api/v1/workspaces", { name: "Synthetic Live WS" })).body.workspace;
    await admin.request("POST", `/api/v1/workspaces/${ws.id}/members`, { userId: (await ana.request("GET", "/api/v1/me")).body.user.id, role: "MEMBER" });
    board = (await admin.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Synthetic Jobs", columns: COLUMNS })).body.board;
  });
  after(async () => { app.app?.locals?.realtime?.closeAll(); await app.close(); });

  test("normal events are unaffected: the stream stays open across several checks and delivers changes", async () => {
    const s = await listen(ana);
    assert.ok(await s.waitFor((m) => m.event === "ready"));
    await new Promise((r) => setTimeout(r, 600)); // several access (150 ms) and session (150 ms) checks
    assert.equal(s.ended, false);
    await admin.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Synthetic live 1" } });
    assert.ok(await s.waitFor((m) => m.event === "change" && m.data.action === "record.created"), "change delivered");
    assert.equal(s.ended, false);
    await s.close();
  });

  test("a failed access re-read ends the stream (no old scope kept); only the error class is logged", async () => {
    const s = await listen(ana);
    assert.ok(await s.waitFor((m) => m.event === "ready"));
    const memberships = app.dataLayer.repos.memberships, original = memberships.listForUser;
    const logged = app.logger.errors.length;
    memberships.listForUser = async () => { throw Object.assign(new Error("synthetic secret-looking detail"), { name: "MongoNetworkError" }); };
    try {
      assert.equal(await waitEnded(s), true, "the stream ended");
      assert.equal(s.messages.some((m) => m.event === "session-ended"), false, "a reconnect, not a sign-out");
    } finally { memberships.listForUser = original; }
    const lines = app.logger.errors.slice(logged);
    assert.ok(lines.some((l) => /\[events\].*MongoNetworkError/.test(l)), lines.join("\n"));
    assert.ok(!lines.some((l) => /secret-looking/.test(l)));
    // Reconnecting works again once the database answers.
    const again = await listen(ana);
    assert.ok(await again.waitFor((m) => m.event === "ready"));
    await again.close();
  });

  test("a failed session check ends the stream", async () => {
    const s = await listen(ana);
    assert.ok(await s.waitFor((m) => m.event === "ready"));
    const sessions = app.dataLayer.repos.sessions, original = sessions.findBySecret;
    let calls = 0;
    // The stream's own check fails; the reconnect afterwards (a new request) must still authenticate, so fail only while open.
    sessions.findBySecret = async (...a) => { calls += 1; if (!s.ended) throw Object.assign(new Error("x"), { name: "MongoServerSelectionError" }); return original.apply(sessions, a); };
    try { assert.equal(await waitEnded(s), true); } finally { sessions.findBySecret = original; }
    assert.ok(calls > 0);
    assert.ok(app.logger.errors.some((l) => /\[events\] session check failed.*MongoServerSelectionError/.test(l)));
  });

  test("users.status changes (P3 suspend) → session-ended; the JARC.Admin claim changing on the session → stream ends", async () => {
    const p = issuer.person("Synthetic Live Suspended");
    const c = client(); await c.signIn(p);
    const s = await listen(c);
    assert.ok(await s.waitFor((m) => m.event === "ready"));
    await app.db.collection("users").updateOne({ entraObjectId: p.oid }, { $set: { status: "suspended" } });
    assert.ok(await s.waitFor((m) => m.event === "session-ended", 3000));
    assert.equal(await waitEnded(s), true);

    const q = issuer.person("Synthetic Live Claim");
    const d = client(); await d.signIn(q);
    const t = await listen(d);
    assert.ok(await t.waitFor((m) => m.event === "ready"));
    const user = await app.db.collection("users").findOne({ entraObjectId: q.oid });
    await app.db.collection("sessions").updateMany({ userId: user._id }, { $set: { isSystemAdmin: true } });
    assert.equal(await waitEnded(t), true, "the stream ended: it reconnects with the session's current claim");
    assert.equal(t.messages.some((m) => m.event === "session-ended"), false);
  });
});
