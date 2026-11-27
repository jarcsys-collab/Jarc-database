// A refused save in the REAL app (one headless Chrome/Edge, Entra test server, fake MongoDB): the board keeps every row, its
// saved view, filters and scroll position; only the refused cell goes back and is marked; a toast says why; no reload.
// Refusals are injected at the page's fetch. Skipped when no Chrome or Edge is installed. Synthetic data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["New", "Doing", "Done"] }];

describe("Refused saves keep the board (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, small, big;
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: r.status === 204 ? null : await r.json() }; })()`);
  const cell = (serial) => `tr:has([aria-label="Item: ${serial}"]) td[data-column-key="status"]`;
  const domRows = () => b.evaluate("document.querySelectorAll('.editable-table tbody tr [aria-label^=\"Item: \"]').length");
  const openBoard = async (name, width = 1280) => {
    await b.open(`${base}/`, { width, height: 860 });
    await b.waitFor("!!document.querySelector('.app-shell')", 10000);
    await b.evaluate(`(() => { const link = [...document.querySelectorAll('#sidebar .tree-item, a, button')].find((el) => el.textContent.trim().startsWith(${JSON.stringify(name)})); link?.click(); })()`);
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table td.cell')", 10000), `${name} loaded`);
    await sleep(600);
    await b.evaluate("window.__noReload = true");
  };
  // The next record PATCH (a cell edit) gets `answer` instead of the server's reply.
  const failNext = (answer) => b.evaluate(`(() => { window.__fetch ||= window.fetch; window.__answer = ${answer}; window.fetch = (u, i) => { if (window.__answer && i?.method === 'PATCH' && String(u).includes('/records/')) { const a = window.__answer; window.__answer = null; return a(); } return window.__fetch(u, i); }; })()`);
  const refusal = (status, code) => `() => Promise.resolve(new Response(JSON.stringify({ error: { code: '${code}', message: 'x' } }), { status: ${status}, headers: { 'Content-Type': 'application/json' } }))`;
  const setStatus = async (serial, value) => {
    await b.evaluate(`document.querySelector(${JSON.stringify(cell(serial) + " .cell-display")}).click()`); await sleep(200);
    await b.evaluate(`document.querySelector('.cell-option[data-value="${value}"]').click()`);
  };
  const refusedShown = (serial) => b.waitFor(`document.querySelector(${JSON.stringify(cell(serial))})?.classList.contains('save-refused-flash') && document.querySelector(${JSON.stringify(cell(serial))})?.textContent.trim() === 'New' && !!document.querySelector('.toast[data-kind="save-error"]')`, 8000);

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER);
    await b.open(`${base}/api/v1/health`, { width: 1280 });
    await b.evaluate(`(async () => { const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=0a0a0a0a-0000-4000-8000-0000000000a1&name=Ana%20Reyes&email=ana@example.invalid&nonce=" + start.nonce)).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); })()`);
    const ws = (await api("POST", "/workspaces", { name: "Refusals" })).body.workspace;
    const make = async (name, count) => {
      const board = (await api("POST", `/workspaces/${ws.id}/boards`, { name, columns: COLUMNS })).body.board;
      for (let i = 0; i < count; i += 500) await api("POST", `/boards/${board.id}/records/batch`, { records: Array.from({ length: Math.min(500, count - i) }, (_, j) => ({ values: { serial: `${name.split(" ")[0]}-${String(i + j).padStart(4, "0")}`, status: "New" }, groupId: board.groups[0].id })) });
      return board;
    };
    small = await make("Small board", 30);
    big = await make("Big board", 2100);
    await api("PATCH", `/boards/${small.id}`, { expectedVersion: small.version, savedViews: [{ name: "First ten", state: { view: "table", filter: { op: "and", rules: [{ key: "serial", cmp: "startsWith", values: ["Small-000"] }] } } }] });
  });
  after(async () => { await b?.close(); server?.kill(); });

  test("desktop, small board: a refused edit keeps all 30 rows and the scroll position; the cell goes back, is marked, and a toast says why", async () => {
    await openBoard("Small board");
    assert.equal(await domRows(), 30);
    await b.evaluate("document.querySelector('.table-wrap').scrollTop = 160; window.scrollTo(0, 80)");
    // The refusal waits until the edit is made, so the scroll position is read right before the rollback.
    await failNext(`() => new Promise((go) => { window.__go = go; }).then(${refusal(400, "VALIDATION_ERROR")})`);
    await setStatus("Small-0012", "Done");
    assert.ok(await b.waitFor("typeof window.__go === 'function'", 5000)); await sleep(200);
    const scroll = await b.evaluate("[document.querySelector('.table-wrap').scrollTop, window.scrollY]");
    await b.evaluate("window.__go()");
    assert.ok(await refusedShown("Small-0012"), "the refused cell shows its previous value, marked, with a toast");
    assert.equal(await domRows(), 30, "every row is still shown");
    assert.deepEqual(await b.evaluate("[document.querySelector('.table-wrap').scrollTop, window.scrollY]"), scroll, "scroll position kept");
    assert.equal(await b.evaluate("window.__noReload === true"), true, "no page reload");
    // A later edit saves normally, and the rows stay.
    await setStatus("Small-0013", "Doing");
    assert.ok(await b.waitFor(`document.querySelector('.save-state')?.dataset.state !== 'saving' && document.querySelector(${JSON.stringify(cell("Small-0013"))})?.textContent.trim() === 'Doing'`, 8000));
    assert.equal(await domRows(), 30);
  });

  test("each failure class in the app (403, 409 COLUMN_CONVERTING, 409 conflict, 500, network) keeps the rows and marks the cell", async () => {
    await openBoard("Small board");
    const cases = [[refusal(403, "FORBIDDEN"), "Small-0020"], [refusal(409, "COLUMN_CONVERTING"), "Small-0021"], [refusal(409, "CONFLICT"), "Small-0022"], [refusal(500, "INTERNAL_ERROR"), "Small-0023"], ["() => Promise.reject(new TypeError('Failed to fetch'))", "Small-0024"]];
    for (const [answer, serial] of cases) {
      await b.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove())");
      await failNext(answer);
      await setStatus(serial, "Done");
      assert.ok(await refusedShown(serial), `${serial}: refused cell shown`);
      assert.equal(await domRows(), 30, `${serial}: every row is still shown`);
    }
    assert.equal(await b.evaluate("window.__noReload === true"), true);
  });

  test("saved view with a filter: the view stays active and filtered after a refused edit", async () => {
    await openBoard("Small board");
    await b.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((x) => x.textContent.includes("First ten"))?.click()`);
    assert.ok(await b.waitFor("document.querySelectorAll('.editable-table tbody tr [aria-label^=\"Item: \"]').length === 10", 8000), "the view shows its 10 rows");
    const active = () => b.evaluate("document.querySelector('.view-tabs [role=tab][aria-selected=true]')?.textContent.trim()");
    const tab = await active();
    assert.match(tab, /First ten/);
    await failNext(refusal(400, "VALIDATION_ERROR"));
    await setStatus("Small-0004", "Done");
    assert.ok(await refusedShown("Small-0004"));
    assert.equal(await domRows(), 10, "still the view's 10 rows");
    assert.equal(await active(), tab, "the same view is active");
  });

  test("large board (2,100, server paging): rows loaded by scrolling stay after a refused edit; scroll kept", async () => {
    await openBoard("Big board");
    const indicator = () => b.evaluate("document.querySelector('.records-indicator')?.textContent.trim() || ''");
    // Scroll down so more pages arrive.
    for (let i = 0; i < 6; i += 1) { await b.evaluate("(() => { const w = document.querySelector('.table-wrap'); w.scrollTop = w.scrollHeight; window.scrollTo(0, document.body.scrollHeight); })()"); await sleep(400); }
    await b.evaluate("(() => { const w = document.querySelector('.table-wrap'); w.scrollTop = 0; window.scrollTo(0, 0); })()"); await sleep(400);
    const before = { rows: await domRows(), text: await indicator() };
    const serial = await b.evaluate("document.querySelector('.editable-table tbody tr [aria-label^=\"Item: \"]').getAttribute('aria-label').slice(6)");
    await failNext(`() => new Promise((go) => { window.__go = go; }).then(${refusal(500, "INTERNAL_ERROR")})`);
    await b.evaluate("window.__go = null");
    await setStatus(serial, "Done");
    assert.ok(await b.waitFor("typeof window.__go === 'function'", 5000)); await sleep(200);
    const scroll = await b.evaluate("[document.querySelector('.table-wrap').scrollTop, window.scrollY]");
    await b.evaluate("window.__go()");
    assert.ok(await refusedShown(serial), "the refused cell shown");
    await sleep(300);
    assert.deepEqual({ rows: await domRows(), text: await indicator() }, before, "the same rows and record count are shown");
    assert.ok(before.rows > 0);
    assert.deepEqual(await b.evaluate("[document.querySelector('.table-wrap').scrollTop, window.scrollY]"), scroll, "scroll position kept");
    assert.equal(await b.evaluate("window.__noReload === true"), true);
  });

  test("mobile (390 px): a refused edit keeps the rows and shows the error", async () => {
    await openBoard("Small board", 390);
    const rows = await domRows();
    assert.ok(rows >= 10);
    await failNext(refusal(400, "VALIDATION_ERROR"));
    await setStatus("Small-0002", "Done");
    assert.ok(await refusedShown("Small-0002"));
    assert.equal(await domRows(), rows);
    assert.equal(await b.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), true, "no horizontal page scroll");
  });
});
