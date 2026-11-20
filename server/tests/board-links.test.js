// Direct board links (/boards/{boardId}): the server answers them with the app's own page, and nothing else changes (API paths,
// static files, health, other methods); Microsoft sign-in returns only to the app's own pages. Synthetic data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { startApp, startEntraApp } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

const BOARD = "0123456789abcdef01234567";
const ENTRA_AUTH = fs.readFileSync(path.resolve(__dirname, "..", "..", "site", "assets", "EntraAuth.js"), "utf8");

describe("Server: /boards/{boardId} serves the app (Microsoft sign-in configured)", () => {
  let app;
  before(async () => { app = await startEntraApp({ issuer: await createTokenIssuer() }); });
  after(async () => { await app.close(); });
  const get = (p, init) => fetch(app.url + p, init);

  test("GET /boards/{id} is the app page in resource mode, with every asset named from the site root", async () => {
    const res = await get(`/boards/${BOARD}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    const html = await res.text();
    assert.match(html, /<meta name="jarc-storage-default" content="resource">/);
    assert.doesNotMatch(html, /(href|src)="assets\//, "no page-relative asset (it would resolve under /boards/)");
    assert.match(html, /<script src="\/assets\/AppController\.js"><\/script>/);
    assert.match(html, /href="\/assets\/styles\.css"/);
    assert.match(html, /href="\/assets\/fonts\/poppins-latin-400-normal\.woff2"/);
    // Every asset the link page names really loads from there.
    for (const asset of [...html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)].map((m) => m[1])) assert.equal((await get(asset)).status, 200, asset);
  });

  test("the same page for a trailing slash, upper case and an invalid ID (the page explains it), and for HEAD", async () => {
    const page = await (await get(`/boards/${BOARD}`)).text();
    for (const p of [`/boards/${BOARD}/`, `/boards/${BOARD.toUpperCase()}`, "/boards/not-a-valid-board-id"]) assert.equal(await (await get(p)).text(), page, p);
    const head = await get(`/boards/${BOARD}`, { method: "HEAD" });
    assert.equal(head.status, 200);
  });

  test("/ and /index.html are unchanged (assets stay page-relative there)", async () => {
    const html = await (await get("/")).text();
    assert.match(html, /<script src="assets\/AppController\.js"><\/script>/);
    assert.equal(await (await get("/index.html")).text(), html);
  });

  test("other methods, deeper paths and /boards itself are not captured", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await get(`/boards/${BOARD}`, { method, headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(res.status, 404, method);
      assert.equal((await res.json()).error.code, "NOT_FOUND", method);
    }
    for (const p of ["/boards", "/boards/", `/boards/${BOARD}/records`, `/boards/${BOARD}/x/y`]) {
      const res = await get(p);
      assert.equal(res.status, 404, p);
      assert.match(res.headers.get("content-type"), /application\/json/, p);
    }
  });

  test("API paths keep their answers: the board API needs a session, unknown API paths are JSON 404, health and readiness work", async () => {
    const board = await get(`/api/v1/boards/${BOARD}`);
    assert.equal(board.status, 401);
    assert.equal((await board.json()).error.code, "UNAUTHENTICATED");
    for (const p of ["/api/v1/no-such-thing", "/api/boards/" + BOARD, "/api/v1/external/boards/" + BOARD]) {
      const res = await get(p);
      assert.ok([401, 404].includes(res.status), `${p} → ${res.status}`);
      assert.match(res.headers.get("content-type"), /application\/json/, p);
      assert.doesNotMatch(await res.text(), /<html/i, p);
    }
    assert.equal((await get("/api/v1/health")).status, 200);
    assert.equal((await get("/api/v1/health/ready")).status, 200);
    assert.equal((await get("/api/v1/auth/config")).status, 200);
  });

  test("static files and the sign-in library still load", async () => {
    assert.equal((await get("/assets/AppController.js")).status, 200);
    assert.equal((await get("/assets/styles.css")).status, 200);
    assert.equal((await get("/vendor/msal-browser.min.js")).status, 200);
    assert.equal((await get("/assets/no-such-file.js")).status, 404);
  });
});

describe("Server: /boards/{boardId} without Microsoft sign-in (local development)", () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await app.close(); });

  test("the app page in its usual (local) mode, assets from the site root; / unchanged", async () => {
    const html = await (await fetch(`${app.url}/boards/${BOARD}`)).text();
    assert.match(html, /<meta name="jarc-storage-default" content="local">/);
    assert.doesNotMatch(html, /(href|src)="assets\//);
    assert.match(await (await fetch(`${app.url}/`)).text(), /<script src="assets\/AppController\.js">/);
    assert.equal((await fetch(`${app.url}/boards/${BOARD}`, { method: "POST" })).status, 404);
  });
});

// EntraAuth on its own (no network): what it keeps before Microsoft and restores afterwards.
function entraPage(pathAndQuery, session = new Map()) {
  const at = new URL(pathAndQuery, "https://jarc.example.invalid");
  const location = { origin: at.origin, pathname: at.pathname, search: at.search, hash: at.hash, assigned: [], assign(target) { this.assigned.push(String(target)); } };
  const history = { calls: [], replaceState(_s, _t, target) { this.calls.push(target); const next = new URL(target, location.origin); Object.assign(location, { pathname: next.pathname, search: next.search, hash: next.hash }); } };
  const storage = { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)), removeItem: (k) => session.delete(k) };
  const context = vm.createContext({ window: {}, URL, console });
  vm.runInContext(ENTRA_AUTH, context, { filename: "EntraAuth.js" });
  const adapter = { requests: [], http: { request: async (method, p) => { adapter.requests.push(`${method} ${p}`); return {}; } }, useCsrfToken() {} };
  const config = { authority: "https://login.microsoftonline.com/tenant", redirectUri: "https://jarc.example.invalid/" };
  return { entra: new context.window.EntraAuth(config, adapter, { location, history, session: storage }), EntraAuth: context.window.EntraAuth, location, history, session, adapter };
}

describe("Microsoft sign-in keeps a board link", () => {
  test("before Microsoft: the board link (path and query, never a token) is what's kept", () => {
    const p = entraPage(`/boards/${BOARD}?storage=resource`);
    p.entra.rememberReturnUrl();
    assert.equal(p.session.get("jarc-auth-return"), `/boards/${BOARD}?storage=resource`);
  });

  test("back at the redirect URI (/): the board link is put back in the address bar, once", () => {
    const session = new Map([["jarc-auth-return", `/boards/${BOARD}`]]);
    const p = entraPage("/", session);
    p.entra.restoreReturnUrl();
    assert.deepEqual(p.history.calls, [`/boards/${BOARD}`]);
    assert.equal(p.location.pathname, `/boards/${BOARD}`);
    assert.equal(session.has("jarc-auth-return"), false, "used once");
  });

  test("only the app's own pages on this origin are restored: other origins and other paths leave the address alone", () => {
    for (const target of ["//evil.example.invalid/boards/x", "https://evil.example.invalid/", "/\\evil.example.invalid", "/api/v1/auth/sign-out", "/vendor/msal-browser.min.js", `/boards/${BOARD}/records`, "javascript:alert(1)", "boards/x"]) {
      const p = entraPage("/", new Map([["jarc-auth-return", target]]));
      p.entra.restoreReturnUrl();
      assert.deepEqual(p.history.calls, [], target);
      assert.equal(p.location.pathname, "/", target);
    }
    for (const ok of ["/", "/index.html", "/?storage=resource", `/boards/${BOARD}`, "/boards/not-valid"]) assert.equal(entraPage("/").EntraAuth.isAppPath(new URL(ok, "https://x.invalid").pathname), true, ok);
  });

  test("sign-out from a board: the JARC session ends, Microsoft's sign-out returns to the redirect URI, and the board link comes back after", async () => {
    const session = new Map();
    const p = entraPage(`/boards/${BOARD}`, session);
    await p.entra.signOut();
    assert.deepEqual(p.adapter.requests, ["POST /auth/sign-out"]);
    assert.equal(p.location.assigned.length, 1);
    const out = new URL(p.location.assigned[0]);
    assert.equal(out.origin, "https://login.microsoftonline.com");
    assert.equal(out.searchParams.get("post_logout_redirect_uri"), "https://jarc.example.invalid/");
    assert.equal(session.get("jarc-auth-signed-out"), "1");
    const back = entraPage("/", session);
    assert.equal(back.entra.returningFromSignOut(), true);
    back.entra.restoreReturnUrl();
    assert.equal(back.location.pathname, `/boards/${BOARD}`);
  });
});
