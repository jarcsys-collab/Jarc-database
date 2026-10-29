// Phase 4: motion, loading states and feedback in the REAL app, in a headless browser (Chrome/Edge), with two signed-in
// employees (Entra test server, ACCESS_POLICY=development_shared, fake MongoDB, in-memory file store).
// Network conditions are shaped inside the page (window.fetch / XMLHttpRequest wrappers): slow and failing requests
// are simulated for this browser only — the server and its data are never changed by the shaping.
// Skipped when no Chrome or Edge is installed (set JARC_TEST_BROWSER to use a specific one).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "status", label: "Status", type: "status", options: ["To do", "Done"], colors: ["#64748b", "#1f9d61"] },
  { key: "notes", label: "Notes", type: "text" },
  { key: "done", label: "Done?", type: "checkbox" },
  { key: "docs", label: "Docs", type: "files" }
];
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("Motion, loading states and feedback (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, ana, ben, ws, alpha, beta;
  const OIDS = { "ana@example.invalid": "0a0a0a0a-0000-4000-8000-000000000021", "ben@example.invalid": "0b0b0b0b-0000-4000-8000-000000000022" };
  const signIn = (b, name, email) => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OIDS[email]}&name=${encodeURIComponent(name)}&email=${email}&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const api = (b, method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const cell = (serial, key) => `tr:has(td[data-column-key="serial"] [aria-label="Item: ${serial}"]) td[data-column-key="${key}"] .cell-display`;
  const click = (b, sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "center", inline: "center" }); el.click(); return true; })()`);
  // In-page instrumentation: which motion classes were applied (and to what), page errors, and network shaping.
  const instrument = (b) => b.evaluate(`(() => {
    window.__seen = []; window.__errors = [];
    addEventListener("error", (e) => __errors.push(String(e.message)));
    addEventListener("unhandledrejection", (e) => __errors.push(String(e.reason && e.reason.message || e.reason)));
    new MutationObserver((ms) => { for (const m of ms) { const el = m.target; if (!el.classList) continue; for (const c of ["view-enter", "content-ready", "row-enter", "row-exit", "just-changed", "is-leaving"]) if (el.classList.contains(c) && !(el.__seen || (el.__seen = new Set())).has(c)) { el.__seen.add(c); __seen.push({ c, tag: el.tagName, cls: String(el.className).slice(0, 80), id: (el.dataset && el.dataset.recordContext) || "" }); } } }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
    window.__shape = [];
    if (!window.__realFetch) { window.__realFetch = window.fetch; window.fetch = async (url, init = {}) => { const rule = __shape.find((r) => new RegExp(r.match).test(String(url)) && (!r.method || r.method === (init.method || "GET"))); if (rule) { if (rule.after) { const res = await __realFetch(url, init); await new Promise((r) => setTimeout(r, rule.after)); return res; } if (rule.delay) await new Promise((res) => setTimeout(res, rule.delay)); if (rule.fail) throw new TypeError("Failed to fetch"); if (rule.status) return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Simulated" } }), { status: rule.status, headers: { "Content-Type": "application/json" } }); } return __realFetch(url, init); }; }
    return true;
  })()`);
  const shape = (b, rules) => b.evaluate(`window.__shape = ${JSON.stringify(rules)}`);
  const seen = (b) => b.evaluate("window.__seen");
  const errors = (b) => b.evaluate("window.__errors");
  const openApp = async (b, width = 1280) => {
    // Motion on, whatever this computer's own setting is (Windows "Animation effects" off → reduce); tests switch it.
    await b.motionPreference("no-preference");
    await b.open(`${base}/`, { width, height: 860 });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item') || !!document.querySelector('.entra-login')", 15000), "app shown");
    await instrument(b);
  };
  const openBoard = async (b, name) => {
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes(${JSON.stringify(name)}))?.click()`);
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table tbody tr td.cell')", 15000), `${name} loaded`);
    await sleep(300);
  };
  // Reduced motion is the device's accessibility setting (JARC has no setting of its own).
  const reduced = (b, on) => b.motionPreference(on ? "reduce" : "no-preference");
  // Creates a view through + Views (type: table | list | kanban | calendar).
  const createView = async (b, type, name) => {
    await click(b, '[data-action="views-menu"]');
    assert.ok(await b.waitFor(`!!document.querySelector('[data-action="new-view"][data-type="${type}"]')`, 2000));
    await click(b, `[data-action="new-view"][data-type="${type}"]`);
    assert.ok(await b.waitFor("!!document.querySelector('form[data-action=create-view-form]')", 2000));
    await b.evaluate(`document.querySelector('form[data-action=create-view-form] input[name=name]').value = ${JSON.stringify(name)}`);
    await click(b, 'form[data-action="create-view-form"] .button.primary');
  };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    ana = await launch(BROWSER); ben = await launch(BROWSER);
    for (const [b, name, email] of [[ana, "Ana Reyes", "ana@example.invalid"], [ben, "Ben Cruz", "ben@example.invalid"]]) { await b.open(`${base}/api/v1/health`, { width: 1280 }); await signIn(b, name, email); }
    ws = (await api(ana, "POST", "/workspaces", { name: "Motion" })).body.workspace;
    alpha = (await api(ana, "POST", `/workspaces/${ws.id}/boards`, { name: "Alpha board", columns: COLUMNS })).body.board;
    beta = (await api(ana, "POST", `/workspaces/${ws.id}/boards`, { name: "Beta board", columns: COLUMNS })).body.board;
    for (const s of ["A-1", "A-2", "A-3"]) await api(ana, "POST", `/boards/${alpha.id}/records`, { values: { serial: s } });
    await api(ana, "POST", `/boards/${beta.id}/records`, { values: { serial: "B-1" } });
  });
  after(async () => { await ana?.close(); await ben?.close(); server?.kill(); });

  test("navigation animates the content once; a view switch animates only the records area; live updates never animate the screen", async () => {
    await openApp(ana); await openApp(ben);
    await openBoard(ana, "Alpha board"); await openBoard(ben, "Alpha board");
    assert.ok((await seen(ana)).some((s) => s.c === "view-enter" && !/topbar/.test(s.cls)), "opening a board fades the content in");
    assert.equal((await seen(ana)).filter((s) => s.c === "view-enter" && /topbar/.test(s.cls)).length, 0, "the top bar never animates");
    await instrument(ana);
    await createView(ana, "kanban", "Motion kanban");
    await ana.waitFor("!!document.querySelector('.kanban-board')", 3000);
    const viewSwitch = (await seen(ana)).filter((s) => s.c === "view-enter");
    assert.deepEqual(viewSwitch.map((s) => /board-view-region/.test(s.cls)), [true], "only the records area animates on a view switch");
    await click(ana, '[data-action="main-table"]');
    await ana.waitFor("!!document.querySelector('.editable-table')", 3000);
    await sleep(300);
    await instrument(ana);
    // A colleague's change arrives live: no screen or region animation, just the changed cell.
    const rec = (await api(ben, "GET", `/boards/${alpha.id}/records?limit=50`)).body.items.find((r) => r.values.serial === "A-1");
    await api(ben, "PATCH", `/records/${rec.id}`, { expectedVersion: rec.version, values: { status: "Done" } });
    assert.ok(await ana.waitFor(`document.querySelector(${JSON.stringify(cell("A-1", "status"))})?.textContent.includes("Done")`, 8000), "the live change arrived");
    await sleep(300);
    const live = await seen(ana);
    assert.equal(live.filter((s) => ["view-enter", "content-ready"].includes(s.c)).length, 0, `no screen animation on a live update (${JSON.stringify(live)})`);
    assert.deepEqual(await errors(ana), []);
  });

  test("rapid navigation (home, boards, my work, boards) ends on the right screen with no stuck loading state or errors", async () => {
    await openApp(ana);
    await shape(ana, [{ match: "/records\\?", delay: 300 }]); // slower record loads make overlaps likely
    await ana.evaluate(`(() => { const nav = (sel) => document.querySelector(sel)?.click(); const board = (n) => [...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes(n))?.click();
      board("Beta board"); board("Alpha board"); nav('[data-action="nav"][data-screen="home"]'); nav('[data-action="nav"][data-screen="mywork"]'); board("Beta board"); board("Alpha board"); })()`);
    assert.ok(await ana.waitFor(`document.querySelector('h1 input')?.value === "Alpha board" && !!document.querySelector(${JSON.stringify(cell("A-2", "notes"))})`, 10000), "ends on Alpha with its records");
    assert.ok(await ana.waitFor("!document.querySelector('[aria-busy=\"true\"]')", 5000), "no loading state left behind");
    await sleep(500);
    assert.equal(await ana.evaluate("document.querySelector('h1 input')?.value"), "Alpha board", "a late response never switches the screen back");
    assert.deepEqual(await errors(ana), []);
    await shape(ana, []);
  });

  test("skeletons: shaped like the view, delayed so fast loads never flash, replaced by an error (not stuck) when loading fails, and Try again works", async () => {
    await openApp(ana);
    await shape(ana, [{ match: `/boards/${beta.id}/records`, fail: true }]);
    await ana.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Beta board"))?.click()`);
    assert.ok(await ana.waitFor("!!document.querySelector('[data-action=\"retry-board-load\"]')", 8000), "the failure is shown");
    assert.equal(await ana.evaluate("document.querySelectorAll('[aria-busy=\"true\"]').length"), 0, "no skeleton left behind");
    await shape(ana, [{ match: `/boards/${beta.id}/records`, delay: 1200 }]);
    await click(ana, '[data-action="retry-board-load"]');
    assert.ok(await ana.waitFor("!!document.querySelector('.skeleton-region, .data-region[aria-busy=\"true\"]')", 3000), "loading again shows a skeleton");
    const style = await ana.evaluate("(() => { const s = getComputedStyle(document.querySelector('[aria-busy=\"true\"]')); return { name: s.animationName, delay: s.animationDelay }; })()");
    assert.deepEqual(style, { name: "jarc-skeleton-reveal", delay: "0.15s" }, "skeletons wait 150 ms before appearing");
    const shapeOf = await ana.evaluate("document.querySelector('[aria-busy=\"true\"]').className");
    assert.match(shapeOf, /skeleton-kanban|data-region/, "kanban skeleton for the board view");
    assert.ok(await ana.waitFor(`!!document.querySelector('.kanban-board') || !!document.querySelector(${JSON.stringify(cell("B-1", "notes"))})`, 8000), "records appear when the load finishes");
    assert.ok((await seen(ana)).some((s) => s.c === "content-ready"), "records fade in once loaded");
    await shape(ana, []);
    // With reduced motion the skeleton is visible at once (no delay).
    await reduced(ana, true);
    const visible = await ana.evaluate(`(() => { const d = document.createElement("div"); d.innerHTML = '<section class="data-region skeleton-region" aria-busy="true"></section>'; document.body.append(d); const s = getComputedStyle(d.firstChild); const out = { name: s.animationName, opacity: s.opacity }; d.remove(); return out; })()`);
    assert.deepEqual(visible, { name: "none", opacity: "1" });
    await reduced(ana, false);
  });

  test("Saving… is shown until the server confirms; Saved only afterwards; a failed save says so (never 'Saved')", async () => {
    await openApp(ana); await openBoard(ana, "Alpha board");
    await shape(ana, [{ match: "/api/v1/(records|boards/[0-9a-f]+/records)", method: "PATCH", delay: 900 }]);
    assert.ok(await click(ana, cell("A-3", "notes")));
    assert.ok(await ana.waitFor("!!document.querySelector('.cell-input')", 3000));
    await ana.evaluate("(() => { const i = document.querySelector('.cell-input'); i.value = 'Typed note'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await ana.key("Enter");
    assert.ok(await ana.waitFor("document.querySelector('.save-state')?.dataset.state === 'saving'", 2000), "Saving… while the request is in flight");
    await sleep(400);
    assert.equal(await ana.evaluate("document.querySelector('.save-state').dataset.state"), "saving", "still Saving… — not claimed saved before the server answers");
    assert.ok(await ana.waitFor("['live','saved'].includes(document.querySelector('.save-state')?.dataset.state)", 4000), "Saved once confirmed");
    assert.ok((await seen(ana)).some((s) => s.c === "just-changed"), "the edited cell settles in");
    await shape(ana, [{ match: "/api/v1/(records|boards/[0-9a-f]+/records)", method: "PATCH", status: 500 }]);
    await click(ana, cell("A-3", "done"));
    assert.ok(await ana.waitFor("document.querySelector('.save-state')?.dataset.state === 'error'", 5000), "a failed save is reported");
    await shape(ana, []);
    await ana.key("Escape");
  });

  test("menus, dialogs and toasts leave smoothly without blocking the page; nothing lingers for the page's own code; reduced motion skips it", async () => {
    await openApp(ana); await openBoard(ana, "Alpha board");
    // Warm-up close creates the exit layer; then watch it (timing-independent: records each copy added and removed).
    await click(ana, 'th[data-column-key="notes"] .column-menu-button'); await ana.key("Escape"); await sleep(400);
    await ana.evaluate("(() => { window.__ghost = { added: 0, removed: 0 }; new MutationObserver((ms) => { for (const m of ms) { __ghost.added += [...m.addedNodes].filter((n) => n.querySelector && n.querySelector('.is-exiting.column-menu-popover')).length; __ghost.removed += m.removedNodes.length; } }).observe(document.getElementById('jarc-exit-layer').shadowRoot, { childList: true }); })()");
    await click(ana, 'th[data-column-key="notes"] .column-menu-button');
    assert.ok(await ana.waitFor("!!document.querySelector('.column-menu-popover')", 2000));
    await ana.key("Escape");
    assert.equal(await ana.evaluate("document.querySelector('.column-menu-popover')"), null, "closed at once for the page");
    assert.deepEqual(await ana.evaluate("(() => { const h = document.getElementById('jarc-exit-layer'); return { hidden: h.getAttribute('aria-hidden'), inert: h.inert }; })()"), { hidden: "true", inert: true }, "the copy lives on an inert, hidden layer");
    assert.ok(await ana.waitFor("window.__ghost.added === 1 && window.__ghost.removed === 1", 3000), "one fading copy was shown, then removed");
    assert.equal(await ana.evaluate("document.getElementById('jarc-exit-layer').shadowRoot.childElementCount"), 0);
    // A dialog: close and immediately reopen something else — the new one works normally.
    await click(ana, 'th[data-column-key="notes"] .column-menu-button');
    await click(ana, '.column-menu-popover [data-action="rename-column"]');
    assert.ok(await ana.waitFor("!!document.querySelector('form[data-action=rename-column-form]')", 2000));
    await ana.key("Escape");
    await click(ana, 'th[data-column-key="status"] .column-menu-button');
    assert.ok(await ana.waitFor("!!document.querySelector('.column-menu-popover')", 2000), "a new menu opens right away");
    await ana.key("Escape");
    await sleep(300);
    // Reduced motion: no copy at all.
    await reduced(ana, true);
    await click(ana, 'th[data-column-key="notes"] .column-menu-button');
    await ana.key("Escape");
    assert.equal(await ana.evaluate("document.getElementById('jarc-exit-layer').shadowRoot.childElementCount"), 0);
    await reduced(ana, false);
    // Toasts are announced (role=status), fade out, then are removed.
    await ana.evaluate("document.querySelector('#toast-region').innerHTML = ''");
    await ana.evaluate(`(() => { const b = document.createElement("button"); b.dataset.action = "download-file"; b.dataset.name = "report.pdf"; document.querySelector(".app-shell").append(b); b.click(); b.remove(); })()`);
    assert.equal(await ana.evaluate("document.querySelector('#toast-region .toast')?.getAttribute('role')"), "status");
    assert.ok(await ana.waitFor("!!document.querySelector('#toast-region .toast.is-leaving')", 6000), "the toast fades out");
    assert.ok(await ana.waitFor("!document.querySelector('#toast-region .toast')", 1000), "and is removed");
    assert.deepEqual(await errors(ana), []);
  });

  test("records: a colleague's new record slides in once; a deleted record slides out only after the server confirms", async () => {
    await openApp(ana); await openBoard(ana, "Alpha board");
    await instrument(ana);
    const made = (await api(ben, "POST", `/boards/${alpha.id}/records`, { values: { serial: "A-NEW" } })).body.record;
    assert.ok(await ana.waitFor(`!!document.querySelector(${JSON.stringify(cell("A-NEW", "notes"))})`, 8000));
    await sleep(200);
    assert.deepEqual((await seen(ana)).filter((s) => s.c === "row-enter").map((s) => s.id), [made.id], "only the new row animates");
    // Delete A-NEW from the record menu, with the server answer delayed: no exit animation before it confirms.
    await shape(ana, [{ match: "/records/delete|/records/[0-9a-f]+\\?expectedVersion", method: "DELETE", delay: 700 }, { match: "/records/delete", method: "POST", delay: 700 }]);
    await ana.evaluate(`(() => { const b = document.createElement("button"); b.dataset.action = "delete"; b.dataset.id = ${JSON.stringify(made.id)}; document.querySelector(".app-shell").append(b); b.click(); b.remove(); })()`);
    assert.ok(await ana.waitFor("!!document.querySelector('[data-action=\"confirm-delete-records\"]')", 2000));
    await click(ana, '[data-action="confirm-delete-records"]');
    await sleep(350);
    assert.equal((await seen(ana)).filter((s) => s.c === "row-exit").length, 0, "no exit before the server confirms");
    assert.ok(await ana.waitFor(`!document.querySelector(${JSON.stringify(cell("A-NEW", "notes"))})`, 5000), "removed after confirmation");
    assert.deepEqual((await seen(ana)).filter((s) => s.c === "row-exit").map((s) => s.id), [made.id], "the confirmed row slid out");
    await shape(ana, []);
  });

  test("files: loading and failed states in cells and the panel; Uploading n files… until the server confirms; Uploaded shown in the panel; preview loading state", async () => {
    await shape(ana, []);
    await ana.motionPreference("no-preference");
    await ana.open(`${base}/`, { width: 1280, height: 860 });
    await ana.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000);
    await instrument(ana);
    await shape(ana, [{ match: "/attachments$", fail: true }]);
    await openBoard(ana, "Alpha board");
    assert.ok(await ana.waitFor(`!!document.querySelector(${JSON.stringify(cell("A-1", "docs"))} + " .files-error")`, 5000), "a failed file load is shown in the cell");
    assert.ok(await click(ana, cell("A-1", "docs")));
    assert.ok(await ana.waitFor("!!document.querySelector('.files-popover [data-action=\"retry-attachments\"]')", 2000), "the panel offers Try again");
    await shape(ana, [{ match: "/attachments$", delay: 900 }]);
    await click(ana, '.files-popover [data-action="retry-attachments"]');
    assert.ok(await ana.waitFor("!!document.querySelector('.files-popover .file-list-skeleton')", 1500), "the panel shows loading rows");
    assert.ok(await ana.waitFor(`!!document.querySelector(${JSON.stringify(cell("A-2", "docs"))} + " .file-skeleton")`, 1500), "cells show a loading placeholder");
    assert.ok(await ana.waitFor("!document.querySelector('.files-popover .file-list-skeleton') && !document.querySelector('.file-skeleton')", 5000), "loading finishes");
    await shape(ana, []);
    // A slow upload: the save indicator says Uploading (not Saved), the row shows real progress, then "Uploaded".
    await ana.evaluate(`(() => { const send = XMLHttpRequest.prototype.send; XMLHttpRequest.prototype.send = function (body) { setTimeout(() => send.call(this, body), 900); }; window.__restoreXhr = () => { XMLHttpRequest.prototype.send = send; }; })()`);
    await ana.evaluate(`(() => { const input = document.querySelector('.files-popover input[type=file]'); const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob("${PNG_B64}"), c => c.charCodeAt(0))], "dot.png", { type: "image/png" })); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    assert.ok(await ana.waitFor("document.querySelector('.save-state')?.dataset.state === 'uploading'", 2000), "Uploading… while the upload runs");
    assert.match(await ana.evaluate("document.querySelector('.save-state').textContent"), /Uploading 1 file/);
    assert.ok(await ana.waitFor("!!document.querySelector('.files-popover .file-row.is-uploading progress')", 1000), "a per-file progress bar (real upload progress events)");
    assert.ok(await ana.waitFor("!!document.querySelector('.files-popover .file-done')", 6000), "Uploaded, once the server confirmed");
    assert.notEqual(await ana.evaluate("document.querySelector('.save-state').dataset.state"), "uploading");
    assert.equal(await ana.evaluate("[...document.querySelectorAll('#toast-region .toast')].some(t => /Added dot\\.png/.test(t.textContent))"), false, "no toast while the panel shows it");
    await ana.evaluate("window.__restoreXhr()");
    // Preview: loading state until the image has loaded.
    await shape(ana, [{ match: "/content$", delay: 0 }]);
    await click(ana, '.files-popover [data-action="preview-file"]');
    assert.ok(await ana.waitFor("document.querySelector('.file-preview-body')?.dataset.previewState === 'ready'", 5000), "preview loads and leaves its loading state");
    await ana.key("Escape");
    assert.deepEqual(await errors(ana), []);
  });

  test("RACE: a slow board-wide file list never overwrites newer files a colleague just uploaded", async () => {
    await ana.motionPreference("no-preference");
    await ana.open(`${base}/`, { width: 1280, height: 860 });
    await ana.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000);
    await instrument(ana);
    // Alpha's board-wide file list is read now (before the upload) but its answer arrives 2.5 s later; record-level
    // reads are normal.
    await shape(ana, [{ match: `/boards/${alpha.id}/attachments$`, after: 2500 }]);
    await openBoard(ana, "Alpha board");
    const target = (await api(ben, "GET", `/boards/${alpha.id}/records?limit=50`)).body.items.find((r) => r.values.serial === "A-3");
    const status = await ben.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const blob = new Blob([Uint8Array.from(atob("${PNG_B64}"), c => c.charCodeAt(0))], { type: "image/png" }); const r = await fetch("/api/v1/records/${target.id}/attachments?column=docs", { method: "POST", headers: { "Content-Type": "image/png", "X-File-Name": "race.png", "X-CSRF-Token": csrfToken }, body: blob }); return r.status; })()`);
    assert.equal(status, 201);
    assert.ok(await ana.waitFor(`document.querySelectorAll(${JSON.stringify(cell("A-3", "docs"))} + " .file-thumb img").length === 1`, 8000), "the colleague's file arrives live");
    await sleep(3000); // the slow board-wide answer (from before the upload) has now arrived
    assert.equal(await ana.evaluate(`document.querySelectorAll(${JSON.stringify(cell("A-3", "docs"))} + " .file-thumb img").length`), 1, "still shown: the older list did not overwrite it");
    await shape(ana, []);
  });

  test("accessibility: visible keyboard focus, loading regions announced as busy, the exit layer hidden from assistive technology", async () => {
    await openApp(ana); await openBoard(ana, "Alpha board");
    await ana.evaluate("document.querySelector('[data-action=\"main-table\"]').focus()");
    await ana.key("Tab");
    const outline = await ana.evaluate("(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2; })()");
    assert.ok(outline, "keyboard focus is visible");
    await click(ana, 'th[data-column-key="notes"] .column-menu-button'); await ana.key("Escape");
    assert.deepEqual(await ana.evaluate("(() => { const h = document.getElementById('jarc-exit-layer'); return [h.getAttribute('aria-hidden'), h.inert, getComputedStyle(h).pointerEvents]; })()"), ["true", true, "none"], "exit layer: hidden, inert, never clickable");
    // A slow board load: the placeholder is a busy region with a status and a text alternative.
    await ana.open(`${base}/`, { width: 1280, height: 860 }); await ana.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000); await instrument(ana);
    await shape(ana, [{ match: `/boards/${beta.id}/records`, delay: 1500 }]);
    await ana.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Beta board"))?.click()`);
    assert.ok(await ana.waitFor("!!document.querySelector('.skeleton-region[aria-busy=\"true\"] [role=status]')", 2000), "busy region with a status");
    assert.match(await ana.evaluate("document.querySelector('.skeleton-region .sr-only').textContent"), /Loading records/);
    assert.ok(await ana.waitFor("!document.querySelector('[aria-busy=\"true\"]')", 6000), "busy state cleared once loaded");
    await shape(ana, []);
    assert.deepEqual(await errors(ana), []);
  });
});
