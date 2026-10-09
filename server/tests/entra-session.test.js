// Stage 12C: Microsoft Entra sign-in → server-managed session (HttpOnly cookie), CSRF protection, expiry and sign-out.
// Offline: local test keys, fake MongoDB.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

let app, issuer;
const client = () => new SessionClient(app.url, app.entra.appOrigin);
before(async () => { issuer = await createTokenIssuer(); app = await startEntraApp({ issuer }); });
after(async () => { await app.close(); });

describe("Sign-in creates a server session", () => {
  test("nonce → ID token → session: 201 with the user from the VERIFIED token and a CSRF token", async () => {
    const p = issuer.person("Ana Reyes");
    const c = client();
    const res = await c.signIn(p);
    assert.equal(res.status, 201);
    assert.deepEqual([res.body.user.displayName, res.body.user.email, res.body.isSystemAdmin], ["Ana Reyes", p.email, false]);
    assert.match(res.body.csrfToken, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!res.text.includes("eyJ"), "no token is returned");
    const session = await c.request("GET", "/api/v1/auth/session");
    assert.equal(session.status, 200);
    assert.equal(session.body.csrfToken, res.body.csrfToken, "the page can recover its CSRF token after a refresh");
  });

  test("cookies: __Host- prefix, HttpOnly, Secure, SameSite=Strict, Path=/, no Domain; sign-in cookie cleared", async () => {
    const c = client();
    await c.signIn(issuer.person("Cookie Check"));
    const sessionLine = c.setCookies.find((l) => l.startsWith("__Host-jarc_session=") && !/Max-Age=0/.test(l));
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=28800"]) assert.ok(sessionLine.includes(flag), flag);
    assert.ok(!/Domain=/i.test(sessionLine));
    assert.ok(c.setCookies.some((l) => l.startsWith("__Host-jarc_signin=;") && /Max-Age=0/.test(l)), "the one-time sign-in cookie is cleared");
    assert.ok(!c.cookies.has("__Host-jarc_signin"));
  });

  test("the database stores only a hash of the session secret, never the cookie value", async () => {
    const c = client();
    await c.signIn(issuer.person("Hash Check"));
    const secret = c.cookies.get("__Host-jarc_session");
    const sessions = await app.db.collection("sessions").find({}).toArray();
    assert.ok(!JSON.stringify(sessions).includes(secret));
    assert.ok(sessions.some((s) => s._id === crypto.createHash("sha256").update(secret).digest("hex")));
  });

  test("a session is bound to the verified tenant and object ID", async () => {
    const p = issuer.person("Bound User");
    const c = client();
    await c.signIn(p);
    const stored = await app.db.collection("sessions").findOne({ _id: crypto.createHash("sha256").update(c.cookies.get("__Host-jarc_session")).digest("hex") });
    assert.deepEqual([stored.tenantId, stored.objectId], [issuer.config.tenantId, p.oid]);
  });

  test("a session whose stored tenant or object ID no longer matches is ended (401, deleted)", async () => {
    for (const change of [{ tenantId: "00000000-0000-0000-0000-000000000000" }, { objectId: crypto.randomUUID() }]) {
      const c = client();
      await c.signIn(issuer.person("Rebound"));
      const id = { _id: crypto.createHash("sha256").update(c.cookies.get("__Host-jarc_session")).digest("hex") };
      await app.db.collection("sessions").updateOne(id, { $set: change });
      assert.equal((await c.request("GET", "/api/v1/me")).status, 401, Object.keys(change)[0]);
      assert.equal(await app.db.collection("sessions").countDocuments(id), 0);
    }
  });
});

describe("Sign-in is refused", () => {
  test("without the sign-in cookie (nonce not issued to this browser)", async () => {
    const a = client(), b = client();
    const { body } = await a.request("POST", "/api/v1/auth/sign-in/start");
    const res = await b.request("POST", "/api/v1/auth/session", { idToken: await issuer.person("X").idToken(body.nonce) });
    assert.equal(res.status, 401);
  });
  test("with an ID token carrying a different nonce", async () => {
    const res = await client().signIn(issuer.person("Y"), { nonce: "not-the-issued-nonce-000000000000000" });
    assert.equal(res.status, 401);
  });
  test("REPLAY: the same nonce/attempt can't create a second session", async () => {
    const c = client();
    const start = await c.request("POST", "/api/v1/auth/sign-in/start");
    const attempt = c.cookies.get("__Host-jarc_signin");
    const idToken = await issuer.person("Replay").idToken(start.body.nonce);
    assert.equal((await c.request("POST", "/api/v1/auth/session", { idToken })).status, 201);
    const attacker = client();
    attacker.cookies.set("__Host-jarc_signin", attempt);
    assert.equal((await attacker.request("POST", "/api/v1/auth/session", { idToken })).status, 401);
  });
  test("an expired sign-in attempt", async () => {
    const c = client();
    const start = await c.request("POST", "/api/v1/auth/sign-in/start");
    await app.db.collection("loginAttempts").updateOne({ _id: crypto.createHash("sha256").update(c.cookies.get("__Host-jarc_signin")).digest("hex") }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await c.request("POST", "/api/v1/auth/session", { idToken: await issuer.person("Late").idToken(start.body.nonce) })).status, 401);
  });
  test("browser-supplied identity is refused (only { idToken } is accepted)", async () => {
    const c = client();
    const start = await c.request("POST", "/api/v1/auth/sign-in/start");
    const res = await c.request("POST", "/api/v1/auth/session", { idToken: await issuer.person("Z").idToken(start.body.nonce), email: "ceo@example.invalid" });
    assert.equal(res.status, 400);
    assert.equal((await c.request("POST", "/api/v1/auth/session", { email: "ceo@example.invalid", name: "CEO" })).status, 400);
  });
  test("from another origin", async () => {
    const c = client();
    assert.equal((await c.request("POST", "/api/v1/auth/sign-in/start", undefined, { origin: "https://evil.example.invalid" })).status, 403);
  });
  test("an access token or a token for another app in place of the ID token", async () => {
    const c = client();
    const start = await c.request("POST", "/api/v1/auth/sign-in/start");
    const accessToken = await issuer.token({ nonce: start.body.nonce, scp: "User.Read" });
    assert.equal((await c.request("POST", "/api/v1/auth/session", { idToken: accessToken })).status, 401);
    const c2 = client();
    const s2 = await c2.request("POST", "/api/v1/auth/sign-in/start");
    assert.equal((await c2.request("POST", "/api/v1/auth/session", { idToken: await issuer.token({ nonce: s2.body.nonce, aud: "00000000-0000-4000-8000-00000000ffff" }) })).status, 401);
  });
  test("a disabled account can't sign in", async () => {
    const p = issuer.person("Disabled Sign In");
    await client().signIn(p);
    await app.db.collection("users").updateOne({ entraObjectId: p.oid }, { $set: { status: "disabled" } });
    const res = await client().signIn(p);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "ACCOUNT_DISABLED");
  });
});

describe("Unauthorized access", () => {
  test("no cookie, a made-up cookie, or a deleted session → 401 for every protected route", async () => {
    const forged = client();
    forged.cookies.set("__Host-jarc_session", crypto.randomBytes(32).toString("base64url"));
    for (const c of [client(), forged]) {
      for (const [method, path] of [["GET", "/api/v1/workspaces"], ["GET", "/api/v1/me"], ["GET", "/api/v1/auth/session"], ["POST", "/api/v1/workspaces"], ["GET", "/api/v1/boards/aaaaaaaaaaaaaaaaaaaaaaaa/records"]]) {
        assert.equal((await c.request(method, path, method === "GET" ? undefined : {})).status, 401, `${method} ${path}`);
      }
    }
  });
  test("a Bearer header is not accepted as authentication", async () => {
    const res = await fetch(`${app.url}/api/v1/workspaces`, { headers: { Authorization: `Bearer ${await issuer.token({})}` } });
    assert.equal(res.status, 401);
  });
});

describe("CSRF protection", () => {
  test("state-changing requests need the CSRF token; reads don't", async () => {
    const c = client();
    await c.signIn(issuer.person("Csrf Admin", { admin: true }));
    assert.equal((await c.request("GET", "/api/v1/workspaces", undefined, { csrf: null })).status, 200);
    for (const csrf of [null, "wrong-token", c.csrf.slice(0, -1) + (c.csrf.endsWith("A") ? "B" : "A")]) {
      const res = await c.request("POST", "/api/v1/workspaces", { name: "Blocked" }, { csrf });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "CSRF_INVALID");
    }
    assert.equal((await c.request("POST", "/api/v1/workspaces", { name: "Allowed" })).status, 201);
    assert.equal(await app.db.collection("workspaces").countDocuments({ name: "Blocked" }), 0);
  });
  test("another session's CSRF token doesn't work", async () => {
    const a = client(), b = client();
    await a.signIn(issuer.person("Session A", { admin: true }));
    await b.signIn(issuer.person("Session B", { admin: true }));
    assert.equal((await a.request("POST", "/api/v1/workspaces", { name: "Cross" }, { csrf: b.csrf })).status, 403);
  });
  test("a state-changing request from another origin is refused even with the token", async () => {
    const c = client();
    await c.signIn(issuer.person("Origin Admin", { admin: true }));
    for (const method of ["POST", "PATCH", "DELETE"]) assert.equal((await c.request(method, "/api/v1/workspaces", {}, { origin: "https://evil.example.invalid" })).status, 403, method);
    assert.equal((await c.request("POST", "/api/v1/auth/sign-out", undefined, { origin: "https://evil.example.invalid" })).status, 403, "sign-out too");
  });
});

describe("Expiry and sign-out", () => {
  const sessionOf = (c) => ({ _id: crypto.createHash("sha256").update(c.cookies.get("__Host-jarc_session")).digest("hex") });
  test("idle timeout: an idle session expires (401) and is deleted", async () => {
    const c = client();
    await c.signIn(issuer.person("Idle"));
    const id = sessionOf(c);
    await app.db.collection("sessions").updateOne(id, { $set: { idleExpiresAt: new Date(Date.now() - 1000) } });
    const res = await c.request("GET", "/api/v1/workspaces");
    assert.equal(res.status, 401);
    assert.match(res.body.error.message, /expired/);
    assert.equal(await app.db.collection("sessions").countDocuments(id), 0);
  });
  test("absolute lifetime: a session can't outlive its maximum even when active", async () => {
    const c = client();
    await c.signIn(issuer.person("Absolute"));
    await app.db.collection("sessions").updateOne(sessionOf(c), { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await c.request("GET", "/api/v1/workspaces")).status, 401);
  });
  test("activity extends the idle timeout (sliding), at most once a minute", async () => {
    const c = client();
    await c.signIn(issuer.person("Sliding"));
    const id = sessionOf(c);
    await app.db.collection("sessions").updateOne(id, { $set: { lastSeenAt: new Date(Date.now() - 5 * 60 * 1000), idleExpiresAt: new Date(Date.now() + 60 * 1000) } });
    await c.request("GET", "/api/v1/workspaces");
    const after = await app.db.collection("sessions").findOne(id);
    assert.ok(after.idleExpiresAt - Date.now() > 29 * 60 * 1000);
  });
  test("SIGN-OUT ends the session server-side and clears the cookie; the old cookie no longer works", async () => {
    const c = client();
    await c.signIn(issuer.person("Leaving"));
    const oldCookie = c.cookies.get("__Host-jarc_session");
    const res = await c.request("POST", "/api/v1/auth/sign-out");
    assert.deepEqual([res.status, res.body.signedOut], [200, true]);
    assert.ok(c.setCookies.some((l) => l.startsWith("__Host-jarc_session=;") && /Max-Age=0/.test(l)));
    const replay = client();
    replay.cookies.set("__Host-jarc_session", oldCookie);
    assert.equal((await replay.request("GET", "/api/v1/workspaces")).status, 401);
  });
  test("SESSION FIXATION: signing in again replaces the earlier session", async () => {
    const c = client();
    const p = issuer.person("Twice");
    await c.signIn(p);
    const first = c.cookies.get("__Host-jarc_session");
    await c.signIn(p);
    assert.notEqual(c.cookies.get("__Host-jarc_session"), first);
    const old = client();
    old.cookies.set("__Host-jarc_session", first);
    assert.equal((await old.request("GET", "/api/v1/me")).status, 401);
  });
  test("a user disabled during a session is signed out immediately (403 ACCOUNT_DISABLED, session deleted)", async () => {
    const p = issuer.person("Disabled Later");
    const c = client();
    await c.signIn(p);
    await app.db.collection("users").updateOne({ entraObjectId: p.oid }, { $set: { status: "disabled" } });
    const res = await c.request("GET", "/api/v1/workspaces");
    assert.deepEqual([res.status, res.body.error.code], [403, "ACCOUNT_DISABLED"]);
    await app.db.collection("users").updateOne({ entraObjectId: p.oid }, { $set: { status: "active" } });
    assert.equal((await c.request("GET", "/api/v1/workspaces")).status, 401, "the session is gone; sign in again");
  });
});
