// New token: which boards it offers, in the REAL app, in a headless browser, against the test Entra server (local test keys,
// fake MongoDB, synthetic data). Regression: the window used the workspaces and boards read when the Developer Center opened,
// so a board created or imported while it was open never appeared. Now every opening reads them afresh (one request at a
// time), the window opens at once and fills in, and the list follows the chosen workspace. Security stays on the server:
// only the boards ticked are in a token, the server checks every board ID against the workspace and the person's own
// membership, and a board created later is never added to an existing token. Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, freePort, waitForServer, sleep } = require("./support/headless-browser");
const { wizard } = require("./support/api-key-wizard");
// Since the multi-workspace upgrade the window is Create API key (ApiKeyWizard.js): details, then every workspace's boards on one
// list (expand a workspace, or search), review, created. The same guarantees are checked through that window.

const BROWSER = findBrowser();
const DESKTOP = { width: 1440, height: 900 }, MOBILE = { width: 390, height: 844 };
const OID = "0e7e7e7e-0000-4000-8000-0000000000a1", OUTSIDER = "0e7e7e7e-0000-4000-8000-0000000000a2";

describe("New token: board discovery (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed", concurrency: false }, () => {
  let server, base, b; const ids = {};
  const signIn = (oid, name, admin = true) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${oid}&name=${encodeURIComponent(name)}&email=${oid}@example.invalid&admin=${admin ? 1 : 0}&nonce=" + encodeURIComponent(s.nonce))).json(); return (await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) })).status; })()`);
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1" + ${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) }, ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`} }); let json = null; try { json = await r.json(); } catch {} return { status: r.status, body: json }; })()`);
  const has = (sel) => b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  const text = (sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent || ""`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const wait = (expr, ms = 10000) => b.waitFor(expr, ms);
  let wz; // the Create API key window's controls (support/api-key-wizard.js)
  const createBoard = async (workspaceId, name) => { const r = await api("POST", `/workspaces/${workspaceId}/boards`, { name, columns: [{ key: "serial", label: "Item", type: "text", required: true }] }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.board.id; };
  // The page's own adapter: the /options request can be delayed, made to fail, or answered with a given body (this browser only).
  const steerOptions = (mode) => b.evaluate(`(() => { const A = ResourceApiAdapter.prototype; A.__real = A.__real || A.request; window.__optionsCalls = 0; const mode = ${JSON.stringify(mode)};
    A.request = function (m, p, ...rest) { if (m === "GET" && String(p).endsWith("/me/api-tokens/options")) { window.__optionsCalls += 1;
      if (mode === "fail") return Promise.reject(Object.assign(new Error("The server didn't answer."), { code: "INTERNAL_ERROR" }));
      if (mode && mode.delay) return new Promise((ok) => setTimeout(ok, mode.delay)).then(() => A.__real.call(this, m, p, ...rest));
      if (mode && mode.body) return Promise.resolve(JSON.parse(JSON.stringify(mode.body))); }
      return A.__real.call(this, m, p, ...rest); }; })()`);
  const openDeveloper = async (viewport = DESKTOP) => {
    await b.open(`${base}/`, viewport);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 15000), "app loaded");
    let open = false;
    for (let i = 0; i < 4 && !open; i++) {
      if (!(await has(".developer-window"))) { if (!(await has(".profile-popover"))) await click('[data-action="profile-menu"]'); await wait("!!document.querySelector('.profile-popover [data-action=\"developer\"]')", 2000); await click('.profile-popover [data-action="developer"]'); }
      open = await wait("!!document.querySelector('.developer-window #apitok-root')", 3000);
    }
    assert.ok(open, "Developer opens");
    await click('.developer-window .settings-nav [data-action="apitok-tab"][data-tab="tokens"]');
    assert.ok(await wait("!!document.querySelector('[data-action=apitok-new]')"), "Create API key offered");
  };
  // Opens Create API key and goes on to its board list (the step that replaces the old window's workspace and board fields).
  const openNewToken = async () => { await wz.open(); assert.ok(await wz.toBoards(), "the board step opens"); };
  const listed = () => wz.listed(5000);

  before(async () => {
    const port = await freePort(); base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore", env: { ...process.env, JARC_TEST_API_TOKENS: "1", JARC_TEST_API_ADMINS: [OID, OUTSIDER].join(",") } });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER);
    wz = wizard(b);
    await b.motionPreference("reduce");
    await b.open(`${base}/api/v1/health`, DESKTOP);
    // Someone else's workspace, which this person is not a member of. (Both sign in with the JARC.Admin role so they may
    // create workspaces; a token's workspaces come only from the person's OWN memberships, which the role doesn't change.)
    assert.equal(await signIn(OUTSIDER, "Olive Outside"), 201);
    ids.outside = (await api("POST", "/workspaces", { name: "Outsider Space" })).body.workspace.id;
    ids.outsideBoard = await createBoard(ids.outside, "Outsider Board");
    // This person's own workspaces (creating one makes them its admin): two boards in the first, one in the second.
    assert.equal(await signIn(OID, "Tia Token"), 201);
    ids.core = (await api("POST", "/workspaces", { name: "Core Space" })).body.workspace.id;
    ids.sales = (await api("POST", "/workspaces", { name: "Sales Space" })).body.workspace.id;
    ids.product = await createBoard(ids.core, "Product Board");
    ids.customer = await createBoard(ids.core, "Customer Board");
    ids.occ = await createBoard(ids.sales, "Field Board");
    for (const id of [ids.product, ids.customer, ids.occ]) assert.equal((await api("POST", `/boards/${id}/records`, { values: { serial: `row of ${id.slice(-4)}` } })).status, 201);
  });
  after(async () => { await b?.close(); server?.kill(); });

  test("a board created while the Developer Center is open appears in New token, in its own workspace only", async () => {
    await openDeveloper();
    ids.terms = await createBoard(ids.core, "Agreements Board"); // after the Center read its lists
    await openNewToken(); assert.ok(await listed());
    await wz.expand(ids.core);
    assert.ok(await wait(`[...document.querySelectorAll('#apikey-workspaces input[data-action="apitok-wiz-board"]')].some((i) => i.value === ${JSON.stringify(ids.terms)})`, 5000), "the new board is offered");
    assert.deepEqual(await wz.boardNames(ids.core), ["Product Board", "Customer Board", "Agreements Board"]);
    assert.match(await b.evaluate(`document.querySelector('#apikey-workspaces input[data-action="apitok-wiz-all"][value="${ids.core}"]').getAttribute("aria-label")`), /Select all 3 boards in Core Space/);
    await wz.expand(ids.sales);
    assert.deepEqual(await wz.boardNames(ids.sales), ["Field Board"], "another workspace: only its boards");
    await wz.cancel();
  });

  test("only workspaces this person can issue for are offered; someone else's workspace and boards never appear", async () => {
    await openNewToken(); assert.ok(await listed());
    assert.deepEqual((await wz.workspaceNames()).sort(), ["Core Space", "Sales Space"]);
    for (const ws of [ids.core, ids.sales]) await wz.expand(ws);
    const all = JSON.stringify(await b.evaluate("document.querySelector('form.apikey-wizard').outerHTML"));
    assert.ok(!all.includes(ids.outside) && !all.includes(ids.outsideBoard) && !all.includes("Outsider"), "nothing from the outsider's workspace");
    await wz.cancel();
  });

  test("the selection is kept across workspaces, searching, collapsing and the steps; the name and expiry stay", async () => {
    await wz.open();
    await wz.details({ name: "Power BI Integration", expires: "max", next: false });
    const expires = await b.evaluate("document.querySelector('form.apikey-wizard').elements.expires.value");
    await wz.next(); assert.ok(await listed());
    await wz.tick(ids.product, ids.core);
    // Searching shows only what matches; what was ticked stays ticked, whether drawn or not.
    await wz.search("field"); await wz.settle();
    assert.deepEqual(await wz.workspaceNames(), ["Sales Space"], "only the workspace with a matching board");
    assert.deepEqual(await wz.boardNames(ids.sales), ["Field Board"]);
    await wz.tick(ids.occ);
    await wz.search(""); await wz.settle();
    await wz.collapse(ids.core);
    assert.match(await wz.count(), /2 boards · 2 workspaces selected/);
    await wz.expand(ids.core); await wz.expand(ids.sales);
    assert.deepEqual((await wz.checked()).sort(), [ids.product, ids.occ].sort(), "both still ticked");
    // Back to the details and forward again: nothing is lost.
    await wz.back();
    assert.ok(await wait("document.querySelector('form.apikey-wizard')?.dataset.step === 'details'"));
    assert.equal(await b.evaluate("document.querySelector('form.apikey-wizard').elements.name.value"), "Power BI Integration");
    assert.equal(await b.evaluate("document.querySelector('form.apikey-wizard').elements.expires.value"), expires);
    await wz.next(); assert.ok(await listed());
    assert.match(await wz.count(), /2 boards · 2 workspaces selected/);
    // Select all, then Clear selection.
    await wz.selectAll(ids.core);
    assert.match(await wz.count(), /4 boards · 2 workspaces selected/);
    await click('[data-action="apitok-wiz-clear"]');
    assert.match(await wz.count(), /No boards selected/);
    await wz.next();
    assert.match(await text("form.apikey-wizard .apitok-error"), /Select at least one board/, "a key needs a board");
    await wz.cancel();
  });

  test("a late answer never changes the selection, and one opening sends one request", async () => {
    await steerOptions({ delay: 700 });
    await openNewToken(); // the earlier list shows at once; a fresh one is on its way
    assert.ok(await listed(), "the list known so far shows at once");
    await wz.tick(ids.customer, ids.core);
    await sleep(1100); // the fresh answer has arrived and the list was drawn again
    assert.deepEqual(await wz.checked(), [ids.customer], "the tick survived the refresh");
    assert.equal(await wz.expanded(ids.core), true, "the open workspace stays open");
    assert.equal(await b.evaluate("window.__optionsCalls"), 1, "one request for this opening");
    await wz.cancel();
    await steerOptions(null);
  });

  test("an answer for an earlier opening never fills a newer window", async () => {
    await steerOptions({ delay: 900 });
    await wz.open(); await wz.cancel();
    await openNewToken(); // the request of the first opening is shared, and answers the second
    await sleep(1200);
    assert.equal(await b.evaluate("document.querySelectorAll('form.apikey-wizard').length"), 1);
    assert.equal(await b.evaluate("window.__optionsCalls"), 1, "the two quick openings share one request");
    assert.ok(await listed());
    await wz.cancel();
    await steerOptions(null);
  });

  test("duplicate entries in an answer are shown once", async () => {
    const dup = { workspaces: [{ id: ids.core, name: "Core Space", archived: false, boards: [{ id: ids.product, name: "Product Board", archived: false }, { id: ids.product, name: "Product Board", archived: false }, { id: ids.customer, name: "Customer Board", archived: false }] }, { id: ids.core, name: "Core Space", archived: false, boards: [] }] };
    await steerOptions({ body: dup });
    await openNewToken(); assert.ok(await listed());
    await wz.expand(ids.core);
    assert.deepEqual(await wz.boardValues(ids.core), [ids.product, ids.customer]);
    assert.deepEqual(await wz.workspaceNames(), ["Core Space"]);
    await wz.cancel();
    await steerOptions(null);
  });

  test("a failed refresh keeps the known list usable, says so, and Try again refreshes it; the empty state", async () => {
    await openDeveloper();
    // A failing refresh with a list already known: it stays usable and says it may be out of date, with Try again.
    await steerOptions("fail");
    await openNewToken();
    assert.ok(await wait("/may be out of date/.test(document.querySelector('#apikey-workspaces')?.textContent || '')", 3000), "says the list may be out of date");
    assert.ok(await has("#apikey-workspaces .apikey-ws"), "still usable");
    await steerOptions(null);
    await click('[data-action="apitok-boards-retry"]');
    assert.ok(await wait("!/may be out of date/.test(document.querySelector('#apikey-workspaces')?.textContent || '')", 3000), "Try again refreshes it");
    await wz.cancel();
    // Empty: no workspace with boards.
    await steerOptions({ body: { workspaces: [{ id: ids.core, name: "Core Space", archived: false, boards: [] }] } });
    await openNewToken();
    assert.ok(await wait("/no boards you can create a key for/i.test(document.querySelector('#apikey-workspaces')?.textContent || '')", 3000), "empty state");
    assert.equal(await b.evaluate(`document.querySelector('form.apikey-wizard [data-role="next"]').disabled`), true, "nothing to choose, so no next step");
    await wz.cancel();
    await steerOptions(null);
  });

  test("first opening on a fresh page: a loading line, then an error with Try again, then the boards", async () => {
    await b.open(`${base}/`, DESKTOP);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 15000));
    await steerOptions({ delay: 600 });
    // The panel's very first list: call Create API key straight from the page, before any list was read.
    await b.evaluate("(() => { const el = document.createElement('button'); el.dataset.action = 'apitok-new'; el.hidden = true; document.querySelector('#app').append(el); el.click(); el.remove(); })()");
    assert.ok(await wait("!!document.querySelector('form.apikey-wizard')", 1000), "opens at once");
    await wz.details({ name: "Fresh" });
    assert.match(await text("#apikey-workspaces"), /Loading workspaces and boards/);
    assert.equal(await b.evaluate(`document.querySelector('form.apikey-wizard [data-role="next"]').disabled`), true, "can't go on while loading");
    assert.ok(await listed(), "then the boards");
    await wz.cancel();
    await b.open(`${base}/`, DESKTOP);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 15000));
    await steerOptions("fail");
    await b.evaluate("(() => { const el = document.createElement('button'); el.dataset.action = 'apitok-new'; el.hidden = true; document.querySelector('#app').append(el); el.click(); el.remove(); })()");
    assert.ok(await wait("!!document.querySelector('form.apikey-wizard')", 1000));
    await wz.details({ name: "Fresh" });
    assert.ok(await wait("/Couldn't load the workspaces and boards/.test(document.querySelector('#apikey-workspaces')?.textContent || '')", 3000), "the error is shown");
    assert.ok(await has('[data-action="apitok-boards-retry"]'), "with Try again");
    await steerOptions(null);
    await click('[data-action="apitok-boards-retry"]');
    assert.ok(await listed(), "Try again loads the boards");
    await wz.cancel();
  });

  test("phone: the window fits, with no sideways scrolling, and the boards can be ticked", async () => {
    await openDeveloper(MOBILE);
    await openNewToken(); assert.ok(await listed());
    await wz.expand(ids.core);
    assert.equal(await b.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
    assert.ok(await b.evaluate("(() => { const r = document.querySelector('form.apikey-wizard').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; })()"), "the window fits the screen");
    assert.ok(await b.evaluate(`(() => { const i = document.querySelector('form.apikey-wizard input[data-action="apitok-wiz-board"]'); const r = i.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`), "boards can be ticked");
    assert.ok(await b.evaluate("(() => { const f = document.querySelector('form.apikey-wizard'); return f.scrollWidth <= f.clientWidth + 1; })()"), "nothing in the window scrolls sideways");
    await wz.cancel();
  });

  test("the token holds only the boards ticked; it reads them and nothing else; a board created later is never added", async () => {
    await openDeveloper();
    await wz.open();
    await wz.details({ name: "Scoped" }); assert.ok(await listed());
    await wz.tick(ids.terms, ids.core);
    const secret = await wz.create();
    await click('[data-action="apitok-done"]');
    const read = (id) => b.evaluate(`fetch("/api/v1/external/boards/${id}/records", { credentials: "omit", headers: { Authorization: "Bearer " + ${JSON.stringify(secret)} } }).then((r) => r.status)`);
    assert.equal(await read(ids.terms), 200, "the board ticked");
    for (const other of [ids.product, ids.customer, ids.occ, ids.outsideBoard]) assert.equal(await read(other), 404, "any other board answers as if it didn't exist");
    const tokens = () => api("GET", "/me/api-tokens");
    const before = (await tokens()).body.items.find((t) => t.name === "Scoped");
    assert.deepEqual(before.boards.map((x) => x.id), [ids.terms]);
    const later = await createBoard(ids.core, "Later Board");
    const after = (await tokens()).body.items.find((t) => t.name === "Scoped");
    assert.deepEqual(after.boards.map((x) => x.id), [ids.terms], "the existing token keeps exactly its boards");
    assert.equal(await read(later), 404, "and can't read the board created later");
  });

  test("the server checks every board ID: another workspace's board, an unknown ID and a malformed one are refused", async () => {
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
    const make = (boardIds) => api("POST", "/me/api-tokens", { name: "Forged", workspaceId: ids.core, boardIds, scopes: ["read"], expiresAt });
    for (const forged of [[ids.occ], [ids.outsideBoard], [ids.product, ids.outsideBoard], ["0123456789abcdef01234567"]]) assert.equal((await make(forged)).status, 400, JSON.stringify(forged));
    assert.equal((await make(["not-an-id"])).status, 400);
    assert.equal((await api("POST", "/me/api-tokens", { name: "Outside", workspaceId: ids.outside, boardIds: [ids.outsideBoard], scopes: ["read"], expiresAt })).status >= 400, true, "no token for someone else's workspace");
    assert.equal((await api("POST", "/me/api-tokens", { name: "Write", workspaceId: ids.core, boardIds: [ids.product], scopes: ["write"], expiresAt })).status, 400, "read-only only");
    assert.ok(!(await api("GET", "/me/api-tokens")).body.items.some((t) => ["Forged", "Outside", "Write"].includes(t.name)), "none of them was created");
    // Without a workspace (the Create API key window's request): unknown, unreachable and repeated boards are refused too.
    const multi = (boardIds) => api("POST", "/me/api-tokens", { name: "Forged multi", boardIds, scopes: ["read"], expiresAt });
    for (const forged of [[ids.product, ids.outsideBoard], [ids.product, "0123456789abcdef01234567"], [ids.product, ids.product], [ids.product, ids.occ, ids.product]]) assert.equal((await multi(forged)).status, 400, JSON.stringify(forged));
    assert.ok(!(await api("GET", "/me/api-tokens")).body.items.some((t) => t.name === "Forged multi"), "none was created");
  });

  test("one key for boards in two workspaces: review, one creation despite repeated clicks, the secret once, every endpoint", async () => {
    await openDeveloper();
    const before = (await api("GET", "/me/api-tokens")).body.items.length;
    await wz.open();
    await wz.details({ name: "Company Reports", description: "Power BI dashboards" }); assert.ok(await listed());
    await wz.tick(ids.product, ids.core); await wz.tick(ids.occ, ids.sales);
    await wz.next();
    assert.ok(await wait("document.querySelector('form.apikey-wizard')?.dataset.step === 'review'"));
    const review = await text("form.apikey-wizard .apikey-step-body");
    assert.match(review, /Company Reports/); assert.match(review, /Read-only/); assert.match(review, /2 boards in 2 workspaces/);
    assert.match(review, /Core Space[\s\S]*Product Board/); assert.match(review, /Sales Space[\s\S]*Field Board/);
    assert.equal(await b.evaluate(`document.querySelector('form.apikey-wizard [data-role="create"]').disabled`), true, "Create waits for the confirmation");
    const secret = await wz.create({ clicks: 3 });
    const items = (await api("GET", "/me/api-tokens")).body.items;
    assert.equal(items.length, before + 1, "three clicks, one key");
    const made = items.find((t) => t.name === "Company Reports");
    assert.deepEqual(made.workspaces.map((w) => w.name), ["Core Space", "Sales Space"]);
    // The created screen: the secret, both boards with their IDs and endpoints, and Escape can't lose it.
    const shown = await text(".apikey-created");
    for (const id of [ids.product, ids.occ]) { assert.ok(shown.includes(id), `board ID ${id}`); assert.ok(shown.includes(`/api/v1/external/boards/${id}/records`), `records endpoint ${id}`); }
    assert.match(shown, /2 boards in 2 workspaces/);
    const copyAll = await b.evaluate(`document.querySelector('.apikey-created [data-action="apitok-copy-all"]').dataset.copy`);
    assert.ok(copyAll.includes(`/boards/${ids.occ}/records`) && copyAll.includes("Authorization: Bearer YOUR_JARC_API_TOKEN"));
    assert.ok(!copyAll.includes(secret), "Copy all endpoints never includes the secret");
    await b.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    assert.ok(await has("#apitok-secret"), "Escape doesn't close the one-time screen");
    // Every board's records answer with the one key; a board that wasn't chosen doesn't.
    const read = (id) => b.evaluate(`fetch("/api/v1/external/boards/${id}/records", { credentials: "omit", headers: { Authorization: "Bearer " + ${JSON.stringify(secret)} } }).then((r) => r.status)`);
    assert.equal(await read(ids.product), 200); assert.equal(await read(ids.occ), 200);
    assert.equal(await read(ids.customer), 404); assert.equal(await read(ids.outsideBoard), 404);
    // Closing forgets the secret; Connection details show the boards and endpoints again, without it.
    await click('[data-action="apitok-done"]');
    assert.ok(await wait("!!document.querySelector('#apikey-list')"));
    assert.ok(!(await b.evaluate("document.body.innerHTML")).includes(secret), "the secret is gone from the page");
    assert.ok(!(await b.evaluate("JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })")).includes(secret), "and was never stored");
    await click(`#apikey-list [data-action="apitok-details"][data-id="${made.id}"]`);
    assert.ok(await wait("!!document.querySelector('.apikey-details')"));
    const details = await text(".apikey-details");
    assert.ok(details.includes(`/api/v1/external/boards/${ids.product}`) && details.includes(ids.occ));
    assert.match(details, /The secret isn't shown again/);
    assert.ok(!(await b.evaluate("document.body.innerHTML")).includes(secret) && !(await has("#apitok-secret")), "no secret in the details");
    await click('[data-action="apitok-conn-close"]');
  });
});
