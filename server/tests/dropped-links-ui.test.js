// droppedLinks in the REAL app (doc 25 finding 3; one headless Chrome/Edge, Entra test server, fake MongoDB): when a save's
// response says the server removed stored links to records that no longer exist (`droppedLinks: { key: n }`), the person sees
// a notice with the count; a save without it shows none. The field is added at the page's fetch to the server's real reply
// (Connect writes stay off in this release). Skipped when no Chrome or Edge is installed. Synthetic data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["New", "Doing", "Done"] }];

describe("droppedLinks notice (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b;
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: r.status === 204 ? null : await r.json() }; })()`);
  const cell = (serial) => `tr:has([aria-label="Item: ${serial}"]) td[data-column-key="status"]`;
  const toasts = () => b.evaluate("[...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()).join(' | ')");
  // The next record PATCH gets the server's real reply with `extra` merged in.
  const augmentNext = (extra) => b.evaluate(`(() => { window.__fetch ||= window.fetch; window.__extra = ${JSON.stringify(extra)}; window.fetch = async (u, i) => { const r = await window.__fetch(u, i); if (window.__extra && i?.method === 'PATCH' && String(u).includes('/records')) { const extra = window.__extra; window.__extra = null; const body = await r.json(); return new Response(JSON.stringify({ ...body, ...extra }), { status: r.status, headers: { 'Content-Type': 'application/json' } }); } return r; }; })()`);
  const setStatus = async (serial, value) => {
    await b.evaluate(`document.querySelector(${JSON.stringify(cell(serial) + " .cell-display")}).click()`); await sleep(200);
    await b.evaluate(`document.querySelector('.cell-option[data-value="${value}"]').click()`);
  };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER);
    await b.open(`${base}/api/v1/health`, { width: 1280 });
    await b.evaluate(`(async () => { const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=0a0a0a0a-0000-4000-8000-0000000000a1&name=Ana%20Reyes&email=ana@example.invalid&nonce=" + start.nonce)).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); })()`);
    const ws = (await api("POST", "/workspaces", { name: "Links" })).body.workspace;
    const board = (await api("POST", `/workspaces/${ws.id}/boards`, { name: "Dropped board", columns: COLUMNS })).body.board;
    await api("POST", `/boards/${board.id}/records/batch`, { records: Array.from({ length: 3 }, (_, j) => ({ values: { serial: `D-${j}`, status: "New" }, groupId: board.groups[0].id })) });
  });
  after(async () => { await b?.close(); server?.kill(); });

  test("a save whose reply carries droppedLinks shows the count; a plain save shows no such notice", async () => {
    await b.open(`${base}/`, { width: 1280, height: 860 });
    await b.waitFor("!!document.querySelector('.app-shell')", 10000);
    await b.evaluate(`(() => { const link = [...document.querySelectorAll('#sidebar .tree-item, a, button')].find((el) => el.textContent.trim().startsWith("Dropped board")); link?.click(); })()`);
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table td.cell')", 10000), "board loaded");
    await sleep(600);
    // Plain save: no notice about links.
    await setStatus("D-0", "Doing");
    await sleep(1500);
    assert.doesNotMatch(await toasts(), /links? to deleted records/);
    // Save whose reply says 2 links were dropped.
    await augmentNext({ droppedLinks: { client: 2 } });
    await setStatus("D-1", "Done");
    assert.ok(await b.waitFor("[...document.querySelectorAll('.toast')].some((t) => /2 links to deleted records were removed/.test(t.textContent))", 8000), `notice shown: ${await toasts()}`);
    // The save itself went through (the cell keeps its new value).
    assert.equal(await b.evaluate(`document.querySelector(${JSON.stringify(cell("D-1"))}).textContent.trim()`), "Done");
    // One dropped link: singular wording.
    await augmentNext({ droppedLinks: { client: 1 } });
    await setStatus("D-2", "Doing");
    assert.ok(await b.waitFor("[...document.querySelectorAll('.toast')].some((t) => /1 link to deleted records was removed/.test(t.textContent))", 8000), `singular: ${await toasts()}`);
  });
});
