// New token under SHARED ORGANIZATIONAL ACCESS (ACCESS_POLICY=development_shared with JARC_BETA_OPEN_EDITING, as in production), in the
// REAL app, in a headless browser, against the test Entra server (local test keys, fake MongoDB, synthetic data only).
// Regression: the app listed every workspace, but New token offered only workspaces where the person had their own membership, so
// a workspace another employee created (with all its boards) was missing from the Workspace choice. Now New token offers the same
// workspaces and boards as the app, read afresh on opening and on switching workspace, while a token still holds only the boards
// ticked when it was created. Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const DESKTOP = { width: 1440, height: 900 }, MOBILE = { width: 390, height: 844 };
const CREATOR = "0e7e7e7e-0000-4000-8000-0000000000b1", COLLEAGUE = "0e7e7e7e-0000-4000-8000-0000000000b2";
const SALES_BOARDS = 16, CORE_BOARDS = 5; // synthetic sizes: a workspace with many boards and one with a few

describe("New token: shared workspaces and other employees' boards (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed", concurrency: false }, () => {
  let server, base, b, c; const ids = { sales: [], core: [] };
  // Neither person has the JARC.Admin role: shared access alone lets them in.
  const signIn = (oid, name, br = b) => br.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${oid}&name=${encodeURIComponent(name)}&email=${oid}@example.invalid&admin=0&nonce=" + encodeURIComponent(s.nonce))).json(); return (await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) })).status; })()`);
  const api = (method, p, body, br = b) => br.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1" + ${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) }, ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`} }); let json = null; try { json = await r.json(); } catch {} return { status: r.status, body: json }; })()`);
  const has = (sel) => b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const wait = (expr, ms = 10000) => b.waitFor(expr, ms);
  const boardValues = () => b.evaluate(`[...document.querySelectorAll("form.apitok-modal input[name=board]")].map((i) => i.value)`);
  const workspaceNames = () => b.evaluate(`[...document.querySelectorAll("form.apitok-modal select[name=workspaceId] option")].map((o) => o.textContent.trim())`);
  const chooseWorkspace = (id) => b.evaluate(`(() => { const s = document.querySelector("form.apitok-modal select[name=workspaceId]"); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const createBoard = async (workspaceId, name) => { const r = await api("POST", `/workspaces/${workspaceId}/boards`, { name, columns: [{ key: "serial", label: "Item", type: "text", required: true }] }, c); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.board.id; };
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
    assert.ok(await wait("!!document.querySelector('[data-action=apitok-new]')"), "New token offered (no membership needed)");
  };
  const openNewToken = async () => { await click('[data-action="apitok-new"]'); assert.ok(await wait("!!document.querySelector('form.apitok-modal')", 3000), "the window opens"); };
  const listed = () => wait("!!document.querySelector('form.apitok-modal input[name=board]')", 5000);

  before(async () => {
    const port = await freePort(); base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore", env: { ...process.env, JARC_TEST_API_TOKENS: "1", JARC_TEST_BETA: "1" } });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER); c = await launch(BROWSER); // b: the colleague; c: the employee who creates everything
    await b.motionPreference("reduce");
    await b.open(`${base}/api/v1/health`, DESKTOP); await c.open(`${base}/api/v1/health`, DESKTOP);
    // Another employee creates both workspaces and every board. The colleague who later issues the token is a member of nothing.
    assert.equal(await signIn(CREATOR, "Cara Creator", c), 201);
    ids.salesWs = (await api("POST", "/workspaces", { name: "Field Sales Space" }, c)).body.workspace.id;
    ids.coreWs = (await api("POST", "/workspaces", { name: "Core Space" }, c)).body.workspace.id;
    for (let i = 1; i <= SALES_BOARDS; i++) ids.sales.push(await createBoard(ids.salesWs, `Field Board ${String(i).padStart(2, "0")}`));
    for (let i = 1; i <= CORE_BOARDS; i++) ids.core.push(await createBoard(ids.coreWs, `Core Board ${i}`));
    assert.equal((await api("POST", `/boards/${ids.sales[0]}/records`, { values: { serial: "first row" } }, c)).status, 201);
    assert.equal(await signIn(COLLEAGUE, "Cole Colleague"), 201);
    assert.equal(((await api("GET", "/me")).body.memberships || []).length, 0, "the colleague has no membership");
  });
  after(async () => { await b?.close(); await c?.close(); server?.kill(); });

  test("another employee's workspaces are offered, with all their boards, and switching follows the choice", async () => {
    await openDeveloper();
    await openNewToken(); assert.ok(await listed());
    assert.deepEqual((await workspaceNames()).sort(), ["Core Space", "Field Sales Space"]);
    await chooseWorkspace(ids.salesWs);
    assert.deepEqual(await boardValues(), ids.sales, `all ${SALES_BOARDS} boards`);
    assert.match(await b.evaluate("document.querySelector('.apitok-all').textContent"), new RegExp(`All ${SALES_BOARDS} current boards`));
    await chooseWorkspace(ids.coreWs);
    assert.deepEqual(await boardValues(), ids.core, `all ${CORE_BOARDS} boards`);
    await click('[data-action="apitok-cancel"]');
  });

  test("a board another employee creates while the window is open appears on switching workspace, without reloading", async () => {
    await openNewToken(); assert.ok(await listed());
    await chooseWorkspace(ids.coreWs);
    // The other employee creates a board in their own browser; this window stays open.
    ids.coreLater = await createBoard(ids.coreWs, "Core Board Later");
    await chooseWorkspace(ids.salesWs); await chooseWorkspace(ids.coreWs);
    assert.ok(await wait(`[...document.querySelectorAll("form.apitok-modal input[name=board]")].some((i) => i.value === ${JSON.stringify(ids.coreLater)})`, 5000), "the new board is offered");
    assert.deepEqual(await boardValues(), [...ids.core, ids.coreLater]);
    await click('[data-action="apitok-cancel"]');
  });

  test("the colleague's token reads only the boards ticked; new records appear; a board created later is never added", async () => {
    await openDeveloper();
    await openNewToken(); assert.ok(await listed());
    await chooseWorkspace(ids.salesWs);
    await b.evaluate(`(() => { const f = document.querySelector("form.apitok-modal"); f.elements.name.value = "Power BI Integration"; for (const id of ${JSON.stringify(ids.sales.slice(0, 2))}) f.querySelector("input[name=board][value='" + id + "']").checked = true; f.requestSubmit(); })()`);
    assert.ok(await wait("!!document.querySelector('#apitok-secret')"), "token revealed");
    const secret = await b.evaluate("document.querySelector('#apitok-secret').value");
    await click('[data-action="apitok-done"]');
    const read = (id) => b.evaluate(`fetch("/api/v1/external/boards/${id}/records", { credentials: "omit", headers: { Authorization: "Bearer " + ${JSON.stringify(secret)} } }).then(async (r) => ({ status: r.status, body: r.ok ? await r.json() : null }))`);
    const first = await read(ids.sales[0]);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.items.map((r) => r.values.serial), ["first row"]);
    assert.equal((await read(ids.sales[1])).status, 200);
    for (const other of [ids.sales[2], ids.sales[SALES_BOARDS - 1], ...ids.core]) assert.equal((await read(other)).status, 404, "a board not ticked answers as if it didn't exist");
    // A record another employee adds is returned on the next read.
    assert.equal((await api("POST", `/boards/${ids.sales[0]}/records`, { values: { serial: "added later" } }, c)).status, 201);
    const later = await createBoard(ids.salesWs, "Field Board Later");
    assert.deepEqual((await read(ids.sales[0])).body.items.map((r) => r.values.serial).sort(), ["added later", "first row"]);
    assert.equal((await read(later)).status, 404, "a board created later is never added to the token");
    const token = (await api("GET", "/me/api-tokens")).body.items.find((t) => t.name === "Power BI Integration");
    assert.deepEqual(token.boards.map((x) => x.id), ids.sales.slice(0, 2));
    // Forged IDs are refused even under shared access.
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
    for (const forged of [[ids.core[0]], ["0123456789abcdef01234567"], ["not-an-id"]]) assert.equal((await api("POST", "/me/api-tokens", { name: "Forged", workspaceId: ids.salesWs, boardIds: forged, scopes: ["read"], expiresAt })).status, 400, JSON.stringify(forged));
  });

  test("phone: the shared workspaces are offered and the window fits with no sideways scrolling", async () => {
    await openDeveloper(MOBILE);
    await openNewToken(); assert.ok(await listed());
    assert.deepEqual((await workspaceNames()).sort(), ["Core Space", "Field Sales Space"]);
    assert.equal(await b.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
    await click('[data-action="apitok-cancel"]');
  });
});
