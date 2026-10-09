// Stage 12C: the browser's Microsoft Entra sign-in (EntraAuth.js + StorageService + ResourceApiAdapter + BoardModel,
// unchanged) with a SIMULATED MSAL (tests/support/fake-msal.js) against the real API: nonce → ID token → server session
// cookie → CSRF-protected requests. The page "lives" at the configured redirect origin; a fetch wrapper forwards that
// origin to the local test server and keeps cookies like a browser. No Microsoft or Atlas connection is made.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { MongoServerError } = require("mongodb");
const { startEntraApp, startMongoApp } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { memoryStorage } = require("./support/browser-model");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const FAKE_MSAL = fs.readFileSync(path.join(__dirname, "support", "fake-msal.js"), "utf8");
const ORIGIN = "https://jarc.example.invalid"; // the test configuration's redirect URI origin
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);
let app, issuer, people;
const consoleLines = [];

before(async () => {
  issuer = await createTokenIssuer();
  app = await startEntraApp({ issuer });
  people = new Map();
  for (const [key, options] of [["admin", { admin: true }], ["ana", {}], ["ben", {}]]) people.set(key, issuer.person(key, options));
});
after(async () => { await app.close(); });

// One browser (cookie jar + storage) that can load several pages (redirects, refresh).
function browser() { return { cookies: new Map(), session: memoryStorage(), local: memoryStorage() }; }
function page(b, url = "/?storage=resource") {
  const at = new URL(url, ORIGIN);
  const events = [], navigations = [], requests = [];
  const location = { origin: ORIGIN, pathname: at.pathname, search: at.search, hash: at.hash, assign(target) { navigations.push(String(target)); } };
  const history = { replaceState(_s, _t, target) { const next = new URL(target, ORIGIN); Object.assign(location, { pathname: next.pathname, search: next.search, hash: next.hash }); } };
  const fetchImpl = async (target, init = {}) => {
    const u = new URL(target, ORIGIN);
    const headers = { ...(init.headers || {}) };
    requests.push({ origin: u.origin, method: init.method || "GET", path: u.pathname, csrf: Boolean(headers["X-CSRF-Token"]), authorization: Boolean(headers.Authorization), bodyHasToken: /eyJ/.test(String(init.body || "")) });
    if (u.origin !== ORIGIN) return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    if (b.cookies.size) headers.Cookie = [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    headers.Origin = ORIGIN;
    const res = await fetch(app.url + u.pathname + u.search, { ...init, headers });
    for (const line of res.headers.getSetCookie()) { const [pair] = line.split(";"); const i = pair.indexOf("="); const k = pair.slice(0, i), v = pair.slice(i + 1); if (/Max-Age=0/.test(line) || !v) b.cookies.delete(k); else b.cookies.set(k, v); }
    return res;
  };
  const window = { location, history, sessionStorage: b.session, localStorage: b.local, dispatchEvent: (e) => events.push(e.type), addEventListener() {}, fetch: fetchImpl };
  const quiet = { log: (...a) => consoleLines.push(a.join(" ")), warn: (...a) => consoleLines.push(a.join(" ")), error: (...a) => consoleLines.push(a.join(" ")), info() {}, debug() {} };
  const context = vm.createContext({ window, console: quiet, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, document: {}, CustomEvent: class { constructor(type) { this.type = type; } } });
  vm.runInContext(FAKE_MSAL, context, { filename: "fake-msal.js" });
  for (const file of ["ResourceApiAdapter.js", "EntraAuth.js", "StorageService.js", "BoardModel.js"]) vm.runInContext(fs.readFileSync(path.join(ASSETS, file), "utf8"), context, { filename: file });
  window.__fakeMsal.idTokenSource = ({ person, nonce }) => people.get(person.key).idToken(nonce);
  const adapter = new window.ResourceApiAdapter({ baseUrl: `${ORIGIN}/api/v1`, fetch: fetchImpl, timeoutMs: 5000 });
  return { window, adapter, events, navigations, requests, location, msal: window.__fakeMsal, selectedMode: window.jarcStorage.adapter.mode, prepare: () => window.EntraAuth.prepare(adapter), model: () => new window.BoardModel(new window.StorageService(adapter)) };
}
const loginAs = (p, key) => { const x = people.get(key); p.msal.setNextLogin({ key, oid: x.oid, name: x.name, email: x.email, admin: x.admin }); };
async function signedIn(key, b = browser()) {
  const first = page(b);
  const out = await first.prepare();
  loginAs(first, key);
  await out.entra.signIn();
  const back = page(b, first.navigations[0]);
  return { b, first, back, result: await back.prepare() };
}
const protectedCalls = (p) => p.requests.filter((r) => !["/api/v1/auth/config", "/api/v1/auth/sign-in/start"].includes(r.path) && !(r.path === "/api/v1/auth/session" && r.method === "POST"));

describe("Sign-in", () => {
  test("no session: the sign-in state; only the public config and the session check are requested; MSAL isn't loaded", async () => {
    const p = page(browser());
    const out = await p.prepare();
    same([out.mode, out.state], ["entra", "signed-out"]);
    same(p.requests.map((r) => `${r.method} ${r.path}`), ["GET /api/v1/auth/config", "GET /api/v1/auth/session"]);
    assert.ok(!p.msal.calls().some((c) => c.call === "construct"));
  });

  test("Sign in with Microsoft: a server nonce, then a redirect asking only for openid, profile and email", async () => {
    const p = page(browser());
    const out = await p.prepare();
    loginAs(p, "ana");
    await out.entra.signIn();
    same(p.requests.slice(-1).map((r) => `${r.method} ${r.path}`), ["POST /api/v1/auth/sign-in/start"]);
    const login = p.msal.calls().find((c) => c.call === "loginRedirect");
    same([login.scopes, login.prompt, login.hasNonce], [["openid", "profile", "email"], "select_account", true]);
    const construct = p.msal.calls().find((c) => c.call === "construct");
    same([construct.clientId, construct.authority, construct.redirectUri, construct.cacheLocation, construct.navigateToLoginRequestUrl], [issuer.config.clientId, `https://login.microsoftonline.com/${issuer.config.tenantId}`, issuer.config.redirectUri, "sessionStorage", false]);
    assert.ok(!construct.keys.some((k) => /secret|password/i.test(k)));
    assert.ok(!JSON.stringify(p.msal.calls()).includes("access_as_user"));
    assert.equal(p.window.sessionStorage.getItem("jarc-auth-return"), "/?storage=resource");
    assert.ok(p.navigations[0].startsWith(issuer.config.redirectUri));
  });

  test("REDIRECT CALLBACK: back at the redirect URI → resource mode kept, ID token sent once, session cookie set, URL restored", async () => {
    const { b, back, result } = await signedIn("ana");
    assert.equal(back.selectedMode, "resource", "the landing page (no ?storage) still starts in resource mode");
    assert.equal(result.state, "signed-in");
    same([result.me.user.displayName, result.me.user.email], ["ana", people.get("ana").email]);
    assert.equal(`${back.location.pathname}${back.location.search}${back.location.hash}`, "/?storage=resource");
    assert.ok(b.cookies.has("__Host-jarc_session"));
    assert.equal(back.requests.filter((r) => r.bodyHasToken).length, 1, "the ID token travels exactly once");
    assert.ok(back.msal.calls().some((c) => c.call === "clearCache"), "MSAL's cache is cleared after sign-in");
    assert.ok(![...b.session.store.values(), ...b.local.store.values()].some((v) => /eyJ/.test(v)), "no token is kept in browser storage");
  });

  test("a page without a pending sign-in doesn't switch modes", () => {
    assert.equal(page(browser(), "/").selectedMode, "local");
    assert.equal(page(browser(), "/#code=x").selectedMode, "local");
    assert.equal(page(browser(), "/?storage=api").selectedMode, "api");
  });

  test("Microsoft returned an error: the error state (try again), no session", async () => {
    const b = browser();
    const first = page(b);
    const out = await first.prepare();
    loginAs(first, "ana");
    first.msal.setFailure("error");
    await out.entra.signIn();
    const back = page(b, first.navigations[0]);
    assert.equal((await back.prepare()).state, "error");
    assert.ok(!b.cookies.has("__Host-jarc_session"));
    back.msal.setFailure("none");
  });

  test("STARTUP ORDER: data loads only after the session exists; every protected request carries the cookie, none a token", async () => {
    const { back } = await signedIn("admin");
    const model = back.model();
    await model.init();
    assert.ok((await model.applyAfterSave(() => model.createWorkspace({ name: "Order workspace" }))).ok);
    const calls = protectedCalls(back);
    assert.ok(calls.length >= 2);
    assert.ok(back.requests.findIndex((r) => r.path === "/api/v1/auth/session" && r.method === "POST") < back.requests.findIndex((r) => r.path === "/api/v1/workspaces"));
    assert.ok(back.requests.every((r) => !r.authorization), "no Authorization header is ever sent");
    assert.ok(calls.filter((r) => r.method !== "GET").every((r) => r.csrf), "changes carry the CSRF token");
    assert.ok(calls.filter((r) => r.method === "GET").every((r) => !r.csrf), "reads don't");
  });

  test("REFRESH: the session cookie signs the user straight back in (no Microsoft, no MSAL)", async () => {
    const { b } = await signedIn("ana");
    const refreshed = page(b);
    const out = await refreshed.prepare();
    assert.equal(out.state, "signed-in");
    assert.equal(refreshed.navigations.length, 0);
    assert.ok(!refreshed.msal.calls().slice(-3).some((c) => ["construct", "loginRedirect"].includes(c.call)));
  });
});

describe("Requests, errors and sessions", () => {
  test("the CSRF token is never sent to another origin", async () => {
    const { back } = await signedIn("ana");
    const foreign = new back.window.ResourceApiAdapter({ baseUrl: "https://evil.example.invalid/api/v1", fetch: back.window.fetch });
    foreign.useCsrfToken("should-never-leave-jarc");
    await foreign.http.request("POST", "/workspaces", "{}");
    const sent = back.requests.find((r) => r.origin === "https://evil.example.invalid");
    assert.equal(sent.csrf, false);
  });

  test("SESSION EXPIRED while working: the change is rolled back, the app is told, nothing is retried", async () => {
    const { back } = await signedIn("admin");
    const model = back.model();
    await model.init();
    await app.db.collection("sessions").updateMany({ _id: { $exists: true } }, { $set: { idleExpiresAt: new Date(0) } });
    const before = protectedCalls(back).length;
    const res = await model.applyAfterSave(() => model.createWorkspace({ name: "Expired" }));
    same([res.ok, res.code], [false, "UNAUTHENTICATED"]);
    assert.ok(back.events.includes("jarc-session-expired"));
    assert.equal(protectedCalls(back).slice(before).filter((r) => r.method === "POST").length, 1, "sent once, not replayed");
    assert.ok(!model.workspaces.some((w) => w.name === "Expired"));
  });

  test("a failed write (server error) is never replayed", async () => {
    const { back } = await signedIn("admin");
    const model = back.model();
    await model.init();
    const before = protectedCalls(back).length;
    app.fake.failNext({ collection: "workspaces", op: "insertOne", error: new MongoServerError({ message: "boom", code: 1 }) });
    assert.equal((await model.applyAfterSave(() => model.createWorkspace({ name: "Not replayed" }))).ok, false);
    assert.equal(protectedCalls(back).slice(before).filter((r) => r.method === "POST").length, 1);
  });

  test("ACCESS DENIED: a disabled account gets the denied state", async () => {
    const { b } = await signedIn("ben");
    await app.db.collection("users").updateOne({ entraObjectId: people.get("ben").oid }, { $set: { status: "disabled" } });
    const p = page(b);
    assert.equal((await p.prepare()).state, "denied");
    assert.ok(p.events.includes("jarc-access-denied"));
    await app.db.collection("users").updateOne({ entraObjectId: people.get("ben").oid }, { $set: { status: "active" } });
  });

  test("PERMISSION DENIED (403): a non-admin can't create a workspace; rolled back with FORBIDDEN", async () => {
    const { back } = await signedIn("ana");
    const model = back.model();
    await model.init();
    const res = await model.applyAfterSave(() => model.createWorkspace({ name: "Not allowed" }));
    same([res.ok, res.code], [false, "FORBIDDEN"]);
  });

  test("SIGN-OUT: the server session ends, then Microsoft sign-out back to JARC's sign-in page in resource mode", async () => {
    const { b, back, result } = await signedIn("ana");
    await result.entra.signOut();
    const signOut = back.requests.find((r) => r.path === "/api/v1/auth/sign-out");
    assert.ok(signOut && signOut.csrf, "sign-out is a CSRF-protected request");
    assert.ok(!b.cookies.has("__Host-jarc_session"), "cookie cleared");
    const url = new URL(back.navigations.at(-1));
    same([url.origin + url.pathname, url.searchParams.get("post_logout_redirect_uri")], [`https://login.microsoftonline.com/${issuer.config.tenantId}/oauth2/v2.0/logout`, issuer.config.redirectUri]);
    const landing = page(b, issuer.config.redirectUri);
    assert.equal(landing.selectedMode, "resource");
    assert.equal((await landing.prepare()).state, "signed-out");
    assert.equal(`${landing.location.pathname}${landing.location.search}`, "/?storage=resource");
  });

  test("ACCOUNT ISOLATION: two people in the same browser keep separate JARC preferences", async () => {
    const b = browser();
    const ana = (await signedIn("ana", b)).back;
    const modelA = ana.model(); await modelA.init();
    modelA.updateSetting("theme", "light"); await modelA.whenSaved();
    const anaKey = ana.adapter.userKey;
    await (await ana.prepare()).entra.signOut();
    const ben = (await signedIn("ben", b)).back;
    const modelB = ben.model(); await modelB.init();
    assert.equal(modelB.settings.theme, "dark", "Ben doesn't get Ana's settings");
    modelB.updateSetting("density", "compact"); await modelB.whenSaved();
    assert.notEqual(ben.adapter.userKey, anaKey);
    same(JSON.parse(b.local.getItem(anaKey)).settings.theme, "light");
  });

  test("tokens never appear in console output", () => {
    assert.ok(!consoleLines.some((line) => /eyJ[A-Za-z0-9_-]{20,}/.test(line)));
  });

  test("AUTH_MODE=dev resource mode: prepare reports dev (no Microsoft)", async () => {
    const dev = await startMongoApp();
    try {
      const window = { location: { origin: dev.url, search: "?storage=resource", hash: "", pathname: "/" }, sessionStorage: memoryStorage(), localStorage: memoryStorage(), dispatchEvent() {}, addEventListener() {} };
      const context = vm.createContext({ window, console, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, document: {}, CustomEvent: class {} });
      for (const file of ["ResourceApiAdapter.js", "EntraAuth.js", "StorageService.js"]) vm.runInContext(fs.readFileSync(path.join(ASSETS, file), "utf8"), context);
      const adapter = new window.ResourceApiAdapter({ baseUrl: `${dev.url}/api/v1`, fetch: (...a) => fetch(...a) });
      same(await window.EntraAuth.prepare(adapter), { mode: "dev" });
    } finally { await dev.close(); }
  });
});
