// Large boards and API round trips: one authentication per request (same outcomes), one database round trip per record
// page, startup that never waits for a board's records, and a row window in the page that hides no data. The UI part
// runs the REAL app in a headless browser on the fake MongoDB (skipped without Chrome or Edge).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const { ObjectId } = require("mongodb");
const { sessionAuthentication, SESSION_COOKIE } = require("../src/auth/session");
const { RecordRepository } = require("../src/repositories/mongo/record-repository");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");
const { loadBrowser } = require("./support/browser-model");

describe("Authentication runs once per request", () => {
  // The same mounting as src/app.js: several routers, each behind `identify`, and a route on the last one.
  const SECRET = "a".repeat(43), userId = new ObjectId(), sessionId = new ObjectId();
  const entra = { tenantId: "t1", appOrigin: "http://localhost", sessionIdleMinutes: 30 };
  const start = (session, user) => {
    const calls = { sessions: 0, users: 0, removed: 0 };
    const sessions = { findBySecret: async () => { calls.sessions += 1; return session; }, remove: async () => { calls.removed += 1; }, touch: async () => {} };
    const users = { findById: async () => { calls.users += 1; return user; } };
    const authenticate = sessionAuthentication({ sessions, users, entra });
    const identify = (req, res, next) => (req.actor ? next() : authenticate(req, res, next));
    const app = express(), api = express.Router();
    for (let i = 0; i < 6; i += 1) api.use(identify, express.Router());
    api.use(identify, express.Router().get("/thing", (req, res) => res.json({ user: String(req.actor.userId) })));
    app.use(api);
    return new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve({ calls, url: `http://127.0.0.1:${server.address().port}/thing`, close: () => server.close() })); });
  };
  const liveSession = () => ({ _id: sessionId, userId, tenantId: "t1", objectId: "o1", expiresAt: new Date(Date.now() + 3600000), idleExpiresAt: new Date(Date.now() + 3600000), lastSeenAt: new Date() });
  const user = { _id: userId, tenantId: "t1", entraObjectId: "o1", status: "active" };
  const get = (url, cookie = `${SESSION_COOKIE}=${SECRET}`) => fetch(url, { headers: cookie ? { cookie } : {} });

  test("a valid session reaches the route with one session read and one user read, however many routers it passes", async () => {
    const s = await start(liveSession(), user);
    try { const res = await get(s.url); assert.equal(res.status, 200); assert.deepEqual(await res.json(), { user: String(userId) }); assert.deepEqual(s.calls, { sessions: 1, users: 1, removed: 0 }); } finally { s.close(); }
  });
  test("every refusal is unchanged: no cookie, expired session, disabled user, identity mismatch", async () => {
    const cases = [
      [liveSession(), user, null, 401, "UNAUTHENTICATED"],
      [{ ...liveSession(), expiresAt: new Date(0) }, user, undefined, 401, "UNAUTHENTICATED"],
      [{ ...liveSession(), idleExpiresAt: new Date(0) }, user, undefined, 401, "UNAUTHENTICATED"],
      [null, user, undefined, 401, "UNAUTHENTICATED"],
      [liveSession(), { ...user, status: "disabled" }, undefined, 403, "ACCOUNT_DISABLED"],
      [liveSession(), { ...user, entraObjectId: "other" }, undefined, 401, "UNAUTHENTICATED"]
    ];
    for (const [session, who, cookie, status, code] of cases) {
      const s = await start(session, who);
      try { const res = await get(s.url, cookie === undefined ? `${SESSION_COOKIE}=${SECRET}` : cookie); assert.equal(res.status, status, code); assert.equal((await res.json()).error.code, code); } finally { s.close(); }
    }
  });
  test("the real app mounts its routers through the once-per-request wrapper", () => {
    const source = require("fs").readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
    assert.match(source, /const identify = \(req, res, next\) => \(req\.actor \? next\(\) : authenticate\(req, res, next\)\);/);
  });
});

describe("Record pages", () => {
  test("a page is requested in one batch, so it needs no second round trip", async () => {
    let options = null;
    const repo = new RecordRepository({ collection: () => ({ find: (query, o) => { options = o; return { toArray: async () => [] }; } }) });
    await repo.listPage(new ObjectId(), { sort: { field: "position", dir: "asc" }, limit: 200 });
    assert.deepEqual([options.limit, options.batchSize], [201, 201]);
  });
});

describe("Startup does not wait for records", () => {
  test("loading the app reads workspaces and boards only, even when the stored current board is large", async () => {
    const { newResourceModel } = loadBrowser();
    const boardId = "b".repeat(24), workspaceId = "a".repeat(24), asked = [];
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    const model = newResourceModel({ baseUrl: "http://local.invalid/api/v1", fetchImpl: async (url) => {
      const p = new URL(url).pathname.replace("/api/v1", ""); asked.push(p);
      if (p === "/workspaces") return json({ items: [{ id: workspaceId, name: "W", version: 1, role: "WORKSPACE_ADMIN" }] });
      if (p === `/workspaces/${workspaceId}/boards`) return json({ items: [{ id: boardId, workspaceId, name: "Big", version: 1, recordCount: 5000, columns: [{ key: "serial", label: "Item", type: "text" }], groups: [], savedViews: [] }] });
      return json({ items: [], nextCursor: null, limit: 200 });
    } });
    model.storage.adapter.readUserState = () => ({ currentBoardId: boardId, currentWorkspaceId: workspaceId });
    const { data } = await model.storage.adapter.loadResourceState();
    assert.deepEqual(asked, ["/workspaces", `/workspaces/${workspaceId}/boards`], "no record requests while the app starts");
    assert.equal(data.workspaces[0].boards[0].id, boardId);
  });
});

const BROWSER = findBrowser();
describe("Row window on a large board (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, big, small;
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken } ${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const rows = () => b.evaluate("document.querySelectorAll('tr[data-record-context]').length");
  const open = async (name) => { await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes(${JSON.stringify(name)}))?.click()`); assert.ok(await b.waitFor("!!document.querySelector('tr[data-record-context]')", 30000), `${name} shows rows`); await sleep(300); };
  const search = async (text) => { await b.evaluate(`(() => { const i = [...document.querySelectorAll('input')].find((x) => /search/i.test(x.placeholder || '') && !x.closest('#sidebar') && x.closest('.board-view-region, .board-toolbar, .toolbar, main')) || [...document.querySelectorAll('input')].find((x) => /search/i.test(x.placeholder || '')); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(400); };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    b = await launch();
    await b.open(`${base}/`, { width: 1440, height: 900 });
    await b.evaluate(`(async () => { const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=0d0d0d0d-0000-4000-8000-000000000091&name=Rows&email=rows@example.invalid&nonce=" + start.nonce)).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); })()`);
    const ws = (await api("POST", "/workspaces", { name: "Large" })).body.workspace;
    const columns = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "notes", label: "Notes", type: "text" }];
    const created = async (name, groups) => { const res = await api("POST", `/workspaces/${ws.id}/boards`, { name, columns, groups }); assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 300)); return res.body.board; };
    big = await created("Big board", [{ id: "grp_first1", name: "First" }, { id: "grp_second1", name: "Second" }]);
    small = await created("Small board", [{ id: "grp_only01", name: "Only" }]);
    const make = (n, board, prefix, last = "") => Array.from({ length: n }, (_, i) => ({ values: { serial: `${prefix} ${String(i).padStart(4, "0")}`, notes: i === n - 1 ? last : "" }, groupId: board.groups[i % board.groups.length].id }));
    for (const batch of [make(100, big, "Big"), make(100, big, "Big-b"), make(100, big, "Big-c", "the-last-one")]) { const res = await api("POST", `/boards/${big.id}/records/batch`, { records: batch }); assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 300)); }
    assert.equal((await api("POST", `/boards/${small.id}/records/batch`, { records: make(40, small, "Small") })).status, 201);
    await b.send("Page.navigate", { url: `${base}/` });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "app shown");
    await sleep(300);
  });
  after(async () => { await b?.close(); server?.kill(); });

  test("a small board shows every row and no Show more", async () => {
    await open("Small board");
    assert.equal(await rows(), 40);
    assert.equal(await b.evaluate("document.querySelectorAll('[data-action=rows-show-more]').length"), 0);
  });
  test("a large board shows a window, true group counts, and Show more reveals more without a request for data", async () => {
    await open("Big board");
    assert.equal(await rows(), 55, "50 in the first open group, 5 in the next");
    assert.deepEqual(await b.evaluate("[...document.querySelectorAll('.group-count')].map((x) => x.textContent.trim())"), ["150 records", "150 records"]);
    assert.equal(await b.evaluate("document.querySelectorAll('[data-action=rows-show-more]').length"), 2);
    await b.evaluate("document.querySelector('[data-action=rows-show-more]').click()");
    await sleep(200);
    assert.equal(await rows(), 105);
    assert.match(await b.evaluate("document.querySelector('.rows-more-row').textContent"), /100 of 150 shown/);
  });
  test("search and select-all still reach the records outside the window", async () => {
    await open("Big board");
    await search("the-last-one");
    assert.ok(await b.waitFor("[...document.querySelectorAll('tr[data-record-context]')].some((r) => r.textContent.includes('the-last-one'))", 5000), "a record outside the window is found");
    await search("");
    assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length > 50", 5000));
    await b.evaluate("document.querySelector('input[data-action=select-all]').click()");
    await sleep(300);
    assert.match(await b.evaluate("document.body.textContent.replace(/\\s+/g, ' ')"), /300 ?records? selected/i, "select-all covers every matching record, as before");
    await b.evaluate("document.querySelector('input[data-action=select-all]').click()");
    await sleep(200);
  });
});
