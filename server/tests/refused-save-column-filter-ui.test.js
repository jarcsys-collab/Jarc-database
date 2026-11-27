// B1 + T0 in the REAL app (one headless Chrome/Edge, Entra test server, fake MongoDB): a refused cell edit while a saved
// view's column-header filter is active keeps the rows, keeps the filter applied and keeps the view unchanged (no "Save to
// this view"); with an unsaved column filter the view stays changed. Refusals are injected at the page's fetch.
// Skipped when no Chrome or Edge is installed. Synthetic data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["New", "Doing", "Done"] }, { key: "notes", label: "Notes", type: "text" }];

describe("Refused save with a saved view's column filter (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b;
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: r.status === 204 ? null : await r.json() }; })()`);
  const cell = (serial) => `tr:has([aria-label="Item: ${serial}"]) td[data-column-key="status"]`;
  const domRows = () => b.evaluate("document.querySelectorAll('.editable-table tbody tr [aria-label^=\"Item: \"]').length");
  const changed = () => b.evaluate("!!document.querySelector('[data-action=save-active-view]')");
  const failNext = (answer) => b.evaluate(`(() => { window.__fetch ||= window.fetch; window.__answer = ${answer}; window.fetch = (u, i) => { if (window.__answer && i?.method === 'PATCH' && String(u).includes('/records/')) { const a = window.__answer; window.__answer = null; return a(); } return window.__fetch(u, i); }; })()`);
  const refusal = (status, code) => `() => Promise.resolve(new Response(JSON.stringify({ error: { code: '${code}', message: 'x' } }), { status: ${status}, headers: { 'Content-Type': 'application/json' } }))`;
  const setStatus = async (serial, value) => {
    await b.evaluate(`document.querySelector(${JSON.stringify(cell(serial) + " .cell-display")}).click()`); await sleep(200);
    await b.evaluate(`document.querySelector('.cell-option[data-value="${value}"]').click()`);
  };
  const refusedShown = (serial) => b.waitFor(`document.querySelector(${JSON.stringify(cell(serial))})?.classList.contains('save-refused-flash') && document.querySelector(${JSON.stringify(cell(serial))})?.textContent.trim() === 'New' && !!document.querySelector('.toast[data-kind="save-error"]')`, 8000);
  const openView = async () => {
    await b.open(`${base}/`, { width: 1280, height: 860 });
    await b.waitFor("!!document.querySelector('.app-shell')", 10000);
    await b.evaluate(`(() => { const link = [...document.querySelectorAll('#sidebar .tree-item, a, button')].find((el) => el.textContent.trim().startsWith("Yards")); link?.click(); })()`);
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table td.cell')", 10000), "board loaded");
    await b.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((x) => x.textContent.includes("North yards"))?.click()`);
    assert.ok(await b.waitFor("document.querySelector('.view-tab.active')?.textContent.includes('North yards') && document.querySelectorAll('.editable-table tbody tr [aria-label^=\"Item: \"]').length === 8", 8000), "the view opens with its column filter (8 rows)");
    await sleep(400);
    await b.evaluate("window.__noReload = true");
  };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER);
    await b.open(`${base}/api/v1/health`, { width: 1280 });
    await b.evaluate(`(async () => { const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=0a0a0a0a-0000-4000-8000-0000000000b7&name=Ana%20Reyes&email=ana@example.invalid&nonce=" + start.nonce)).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); })()`);
    const ws = (await api("POST", "/workspaces", { name: "Yards" })).body.workspace;
    const board = (await api("POST", `/workspaces/${ws.id}/boards`, { name: "Yards", columns: COLUMNS })).body.board;
    await api("POST", `/boards/${board.id}/records/batch`, { records: Array.from({ length: 24 }, (_, i) => ({ values: { serial: `Yard-${String(i).padStart(2, "0")}`, status: "New", notes: i % 3 ? "south yard" : "north yard" }, groupId: board.groups[0].id })) });
    await api("PATCH", `/boards/${board.id}`, { expectedVersion: board.version, savedViews: [{ name: "North yards", state: { view: "table", columnFilter: JSON.stringify({ key: "notes", op: "contains", value: "north" }) } }] });
  });
  after(async () => { await b?.close(); server?.kill(); });

  test("saved column filter: a refused edit keeps the 8 filtered rows, the cell goes back marked, the view stays unchanged", async () => {
    await openView();
    assert.equal(await changed(), false);
    await failNext(refusal(400, "VALIDATION_ERROR"));
    await setStatus("Yard-03", "Done");
    assert.ok(await refusedShown("Yard-03"), "the refused cell shows its previous value, marked, with a toast");
    await sleep(300);
    assert.equal(await domRows(), 8, "still the view's 8 filtered rows");
    assert.equal(await changed(), false, "the view is still unchanged");
    assert.match(await b.evaluate("document.querySelector('.view-tab.active')?.textContent || ''"), /North yards/);
    assert.equal(await b.evaluate("window.__noReload === true"), true, "no page reload");
  });

  test("unsaved column filter: a refused edit keeps it applied and the view still changed", async () => {
    await openView();
    await b.evaluate("document.querySelector('th[data-column-key=notes] [data-action=column-menu]').click()"); await sleep(150);
    assert.equal(await b.evaluate("(() => { const el = document.querySelector('[data-action=filter-column][data-key=notes]'); el?.click(); return !!el; })()"), true);
    assert.ok(await b.waitFor("!!document.querySelector('form[data-action=column-filter-form]')", 3000));
    await b.evaluate("(() => { const f = document.querySelector('form[data-action=column-filter-form]'); f.querySelector('[name=op]').value = 'contains'; f.querySelector('[name=value]').value = 'south'; f.requestSubmit(); })()");
    assert.ok(await b.waitFor("document.querySelectorAll('.editable-table tbody tr [aria-label^=\"Item: \"]').length === 16", 5000), "16 south rows");
    assert.ok(await b.waitFor("!!document.querySelector('[data-action=save-active-view]')", 3000), "changed");
    await b.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove())");
    await failNext(refusal(500, "INTERNAL_ERROR"));
    await setStatus("Yard-01", "Done");
    assert.ok(await refusedShown("Yard-01"));
    await sleep(300);
    assert.equal(await domRows(), 16, "the unsaved column filter is still applied");
    assert.equal(await changed(), true, "the view still shows as changed");
  });
});
