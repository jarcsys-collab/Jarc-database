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

describe("Slow request log", () => {
  const { slowRequestLog } = require("../src/middleware/slow-requests");
  const run = (thresholdMs, delay = 20, url = "/things/abc123?q=secret-text") => new Promise((resolve) => {
    const lines = [], app = express();
    app.use(slowRequestLog({ logger: { warn: (m) => lines.push(m) }, thresholdMs }));
    app.get("/things/:id", async (req, res) => { await sleep(delay); res.json({ ok: true }); });
    app.get("/events", async (req, res) => { await sleep(delay); res.json({ ok: true }); });
    const server = app.listen(0, "127.0.0.1", async () => { await fetch(`http://127.0.0.1:${server.address().port}${url}`); await sleep(10); server.close(); resolve(lines); });
  });
  test("logs the method, route pattern, status and time, and nothing from the request itself", async () => {
    const [line] = await run(5);
    assert.match(line, /^\[slow\] GET \/things\/:id 200 \d+ms$/);
    assert.doesNotMatch(line, /abc123|secret-text/);
  });
  test("fast requests, the live-update stream and a threshold of 0 log nothing", async () => {
    assert.deepEqual(await run(5000), []);
    assert.deepEqual(await run(5, 20, "/events"), []);
    assert.deepEqual(await run(0), []);
  });
});

describe("Record pages", () => {
  test("a page is requested in one batch, so it needs no second round trip", async () => {
    let options = null;
    const repo = new RecordRepository({ collection: () => ({ find: (query, o) => { options = o; return { toArray: async () => [] }; } }) });
    await repo.listPage(new ObjectId(), { sort: { field: "position", dir: "asc" }, limit: 200 });
    assert.deepEqual([options.limit, options.batchSize], [201, 201]);
  });
  test("specific records of one board: the IDs are checked, and only that board is read", async () => {
    const validate = require("../src/validation/resources");
    const board = { columns: [], groups: [] }, a = "a".repeat(24), b = "b".repeat(24);
    const { filter } = validate.recordListQuery({ ids: `${a},${b}` }, board);
    assert.deepEqual(filter.ids.map(String), [a, b]);
    for (const bad of ["nope", `${a},nope`, "$gt", Array(101).fill(a).join(",")]) assert.throws(() => validate.recordListQuery({ ids: bad }, board), /ids must be/);
    let query = null;
    const repo = new RecordRepository({ collection: () => ({ find: (q) => { query = q; return { toArray: async () => [] }; } }) });
    const boardId = new ObjectId();
    await repo.listPage(boardId, { sort: { field: "position", dir: "asc" }, limit: 100, filter });
    assert.equal(query.boardId, boardId);
    assert.equal(query._id.$in.length, 2);
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
describe("With the search index off, a partly loaded board behaves as it always has (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, b, port;
  before(async () => {
    port = await freePort();
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore", env: { ...process.env, JARC_TEST_RECORD_SEARCH: "off" } });
    await waitForServer(`http://localhost:${port}`, { child: server });
    b = await launch();
  });
  after(async () => { await b?.close(); server?.kill(); });
  test("typing in board search sends no search to the server, and the notice says so", async () => {
    const base = `http://localhost:${port}`;
    await b.open(`${base}/`, { width: 1440, height: 900 });
    await b.evaluate(`(async () => { const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=0d0d0d0d-0000-4000-8000-000000000092&name=Off&email=off@example.invalid&nonce=" + start.nonce)).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); })()`);
    const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken } ${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
    const ws = (await api("POST", "/workspaces", { name: "Off" })).body.workspace;
    await api("POST", `/workspaces/${ws.id}/boards`, { name: "Opens first", columns: [{ key: "serial", label: "Item", type: "text", required: true }] }); // so the limit below is set before the big board loads
    const board = (await api("POST", `/workspaces/${ws.id}/boards`, { name: "Off board", columns: [{ key: "serial", label: "Item", type: "text", required: true }] })).body.board;
    for (let n = 0; n < 3; n += 1) assert.equal((await api("POST", `/boards/${board.id}/records/batch`, { records: Array.from({ length: 100 }, (_, i) => ({ values: { serial: `Off ${n}-${i}` } })) })).status, 201);
    assert.deepEqual((await api("GET", "/search/status")).body, { boardSearch: false });
    await b.send("Page.navigate", { url: `${base}/` });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000));
    await b.evaluate("ResourceApiAdapter.FULL_LOAD_LIMIT = 100");
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Off board"))?.click()`);
    assert.ok(await b.waitFor("!!document.querySelector('.records-indicator')", 15000));
    await sleep(300);
    assert.ok(await b.waitFor("/300 records/.test(document.querySelector('.records-indicator')?.textContent || '')", 8000));
    await b.evaluate("performance.clearResourceTimings()");
    await b.evaluate(`(() => { const i = document.querySelector('#board-search'); i.value = 'Off 0-5'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(800);
    const asked = await b.evaluate("performance.getEntriesByType('resource').map((e) => e.name)");
    assert.deepEqual(asked.filter((n) => n.includes('/search') || /[?&]q=/.test(n)), [], "no text search reaches the server while the index is off");
    assert.match(await b.evaluate("document.querySelector('.records-indicator').textContent"), /search covers the records loaded so far/);
  });
});

describe("Row window on a large board (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, big, small;
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken } ${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const rows = () => b.evaluate("document.querySelectorAll('tr[data-record-context]').length");
  const open = async (name) => { await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes(${JSON.stringify(name)}))?.click()`); assert.ok(await b.waitFor("!!document.querySelector('tr[data-record-context]')", 30000), `${name} shows rows`); await sleep(300); };
  const search = async (text) => { await b.evaluate(`(() => { const i = [...document.querySelectorAll('input')].find((x) => /search/i.test(x.placeholder || '') && !x.closest('#sidebar') && x.closest('.board-view-region, .board-toolbar, .toolbar, main')) || [...document.querySelectorAll('input')].find((x) => /search/i.test(x.placeholder || '')); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(400); };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore", env: { ...process.env, JARC_TEST_RECORD_SEARCH: "on" } });
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
    for (const batch of [make(100, big, "Big", "unloaded-marker"), make(100, big, "Big-b"), make(100, big, "Big-c", "the-last-one")]) { const res = await api("POST", `/boards/${big.id}/records/batch`, { records: batch }); assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 300)); }
    assert.equal((await api("POST", `/boards/${small.id}/records/batch`, { records: make(40, small, "Small") })).status, 201);
    await b.send("Page.navigate", { url: `${base}/` });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "app shown");
    await sleep(300);
  });
  after(async () => { await b?.close(); server?.kill(); });

  test("a small board shows every row", async () => {
    await open("Small board");
    assert.equal(await rows(), 40);
    assert.equal(await b.evaluate("document.querySelectorAll('tr.row-spacer').length"), 0);
  });
  const toBottom = async (times = 12) => { for (let i = 0; i < times; i += 1) { await b.evaluate("(() => { const w = document.querySelector('.board-view-region .table-wrap'); w.scrollTop = w.scrollHeight; })()"); await sleep(120); } };
  test("a large board keeps only the rows near the viewport in the page, with true counts, and scrolling reaches every row", async () => {
    await open("Big board");
    assert.ok(await rows() <= 60, `few rows in the page: ${await rows()}`);
    assert.ok(await b.evaluate("document.querySelectorAll('tr.row-spacer').length") >= 1);
    assert.deepEqual(await b.evaluate("[...document.querySelectorAll('.group-count')].map((x) => x.textContent.trim())"), ["150 records", "150 records"]);
    await toBottom();
    assert.ok(await rows() <= 80, `still few after scrolling: ${await rows()}`);
    const last = await b.evaluate("[...document.querySelectorAll('tr[data-record-context]')].at(-1).textContent");
    assert.ok(last.length > 0);
    assert.equal(await b.evaluate("document.querySelector('.board-group[data-group=Second] tr[data-record-context]') !== null"), true, "the second group's rows appear when scrolled to");
    await b.evaluate("document.querySelector('.board-view-region .table-wrap').scrollTop = 0"); await sleep(200);
    assert.equal(await b.evaluate("document.querySelector('.board-group[data-group=First] tr[data-record-context]') !== null"), true, "and back again");
  });
  test("a partly loaded board: search reaches a record that isn't loaded, and the true count shows instead of a warning", async () => {
    await open("Small board"); // so the next load starts on another board, after the limit below is set
    await b.send("Page.navigate", { url: `${base}/` });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000));
    await b.evaluate("ResourceApiAdapter.FULL_LOAD_LIMIT = 100");
    await open("Big board");
    assert.ok(await b.waitFor("/300 records/.test(document.querySelector('.records-indicator')?.textContent || '')", 8000), "the true total");
    assert.equal(await b.evaluate("!!document.querySelector('.partial-notice')"), false, "no warning");
    assert.equal(await b.evaluate("[...document.querySelectorAll('tr[data-record-context]')].some((r) => r.textContent.includes('unloaded-marker'))"), false);
    await search("unloaded-marker");
    assert.ok(await b.waitFor("[...document.querySelectorAll('tr[data-record-context]')].some((r) => r.textContent.includes('unloaded-marker'))", 8000), "found on the server and shown");
    assert.match(await b.evaluate("document.querySelector('.records-indicator').textContent"), /1 record/);
    assert.equal(await b.evaluate("document.activeElement?.id"), "board-search", "typing focus is kept");
    await search("");
    await b.send("Page.navigate", { url: `${base}/` });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000));
    await sleep(300);
  });
  test("search and select-all still reach the records outside the page", async () => {
    await open("Big board");
    await search("the-last-one");
    assert.ok(await b.waitFor("[...document.querySelectorAll('tr[data-record-context]')].some((r) => r.textContent.includes('the-last-one'))", 5000), "a record outside the page is found");
    await search("");
    assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length > 20", 5000));
    await b.evaluate("document.querySelector('input[data-action=select-all]').click()");
    await sleep(300);
    assert.match(await b.evaluate("document.body.textContent.replace(/\\s+/g, ' ')"), /300 ?records? selected/i, "select-all covers every matching record, as before");
    await b.evaluate("document.querySelector('input[data-action=select-all]').click()");
    await sleep(200);
  });
});
