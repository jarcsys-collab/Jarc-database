// Long boards keep only the rows near the viewport in the page (AppView.VIRTUAL_ROWS = 100 rows and more; BoardGroups,
// AppController.syncVirtual), in the REAL app on the fake MongoDB, in a headless browser, with generic synthetic data.
// Nothing a person relies on may depend on which rows happen to be drawn: search, Select all, export and printing use every
// record; Ctrl+F leads to the board search (a second press is the browser's own Find); keyboard focus survives redraws
// and follows a moved row; an open cell editor is never redrawn away; spacers match a fully drawn table, so the scroll
// height and row positions are exact; the sticky first column, groups, records and phones work as before.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const { findBrowser, launch, freePort, waitForServer, sleep } = require("./support/headless-browser");
const F = require("./support/superform-fixture");

const BROWSER = findBrowser();
const K = F.K;
// The long board's size (160 by default; VB_LONG=260 runs the same checks on a board above the earlier 200-row threshold).
const N = Number(process.env.VB_LONG || 160), HALF = Math.ceil(N / 2);

describe("long boards: rows near the viewport only (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed", concurrency: false }, () => {
  let server, base, b; const boards = {};
  const call = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1" + ${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) }, ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`} }); let json = null; try { json = await r.json(); } catch {} return { status: r.status, body: json }; })()`);
  const seed = async (ws, name, count, columns) => {
    const created = await call("POST", `/workspaces/${ws}/boards`, { name, columns, groups: F.GROUPS.slice(1, 3) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const board = created.body.board, half = Math.ceil(count / 2);
    for (let i = 0; i < count; i += 100) {
      const records = Array.from({ length: Math.min(100, count - i) }, (_, j) => { const n = i + j + 1; return { groupId: F.GROUPS[n <= half ? 1 : 2].id, values: { [K.name]: `${name} row ${String(n).padStart(3, "0")}`, ...(columns.length > 2 ? { [K.kind]: n % 2 ? F.SELLER : F.BUYER, [K.dueRule]: `Due rule ${n}`, [K.pctDown]: String(n % 50) } : {}) } }; });
      const r = await call("POST", `/boards/${board.id}/records/batch`, { records });
      assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    }
    return board;
  };

  before(async () => {
    const port = await freePort(); base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER);
    await b.motionPreference("reduce");
    await b.open(`${base}/api/v1/health`, { width: 1440 });
    await b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=0d0d0d0d-0000-4000-8000-0000000000d1&name=admin&email=admin@example.invalid&admin=1&nonce=" + s.nonce)).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); })()`);
    const ws = (await call("POST", "/workspaces", { name: "Fictional Workspace" })).body.workspace.id;
    const narrow = [{ key: K.name, label: "Name", type: "text", required: true }, { key: "group", label: "Group", type: "group" }];
    boards.below = await seed(ws, "Ninety Nine", 99, narrow);
    boards.edge = await seed(ws, "Exactly Hundred", 100, narrow);
    boards.long = await seed(ws, "Long Board", N, F.COLUMNS);
  });
  after(async () => { await b?.close(); server?.kill(); });

  const open = async (name, width = 1440) => {
    await b.open(`${base}/`, { width, height: 800 });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "app shown");
    let ok = false;
    for (let i = 0; i < 5 && !ok; i += 1) {
      await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes(${JSON.stringify(name)}))?.click()`);
      ok = await b.waitFor(`document.querySelectorAll('.editable-table tbody tr[data-record-context]').length >= 20 && document.querySelector('.board-title-input')?.value === ${JSON.stringify(name)}`, 4000);
    }
    assert.ok(ok, `${name} opened`);
    await sleep(250);
  };
  const drawn = () => b.evaluate("document.querySelectorAll('.editable-table tbody tr[data-record-context]').length");
  const wrap = "document.querySelector('.board-view-region .table-wrap')";
  const frames = (n = 2) => b.evaluate(`new Promise((r) => { let i = 0; const f = () => (++i >= ${n} ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); })`);
  const typeSearch = async (text) => { await b.evaluate(`(() => { const i = document.querySelector('#board-search'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(350); };
  const ctrlF = () => b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 }).then(() => b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 }));

  test("the threshold: 99 rows are drawn in full; exactly 100 and more are drawn near the viewport only", async () => {
    await open("Ninety Nine");
    assert.equal(await drawn(), 99, "all 99 rows");
    assert.equal(await b.evaluate("document.querySelectorAll('tr.row-spacer').length"), 0, "no spacers");
    await open("Exactly Hundred");
    const edge = await drawn();
    assert.ok(edge < 100 && edge > 0, `100 rows: only some are drawn (${edge})`);
    await open("Long Board");
    const long = await drawn();
    assert.ok(long < N && long >= 20, `${N} rows: only some are drawn (${long})`);
    assert.ok(await b.evaluate("document.querySelectorAll('tr.row-spacer').length") >= 1, "spacers stand in for the rest");
  });

  test("search finds a record that isn't drawn, and clearing it brings the whole board back", async () => {
    await open("Long Board");
    assert.equal(await b.evaluate("[...document.querySelectorAll('tr[data-record-context]')].some((r) => r.textContent.includes('Long Board row 157'))"), false, "row 157 isn't in the page");
    await typeSearch("Long Board row 157");
    assert.ok(await b.waitFor("[...document.querySelectorAll('tr[data-record-context]')].some((r) => r.textContent.includes('Long Board row 157'))", 4000), "found and shown");
    assert.equal(await drawn(), 1);
    await typeSearch("");
    assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length >= 20", 4000));
    assert.match(await b.evaluate("[...document.querySelectorAll('.group-count')].map((e) => e.textContent).join(' ')"), new RegExp(`${HALF} records.*${N - HALF} records`),"both groups count all their records");
  });

  test("Select all and export use every record, not only the drawn ones", async () => {
    await open("Long Board");
    await b.evaluate("document.querySelector('input[data-action=select-all]').click()");
    assert.ok(await b.waitFor(`/${N}/.test(document.querySelector('.bulk-bar, .bulk-sheet, [class*=bulk]')?.textContent || '')`, 4000), `${N} selected`);
    await b.evaluate("document.querySelector('input[data-action=select-all]').click()");
    await b.evaluate("(() => { window.__csv = null; const create = URL.createObjectURL; URL.createObjectURL = (blob) => { blob.text().then((t) => { window.__csv = t; }); return create(blob); }; })()");
    await b.evaluate("document.querySelector('.board-actions [data-action=export]').click()");
    assert.ok(await b.waitFor("window.__csv !== null", 4000), "a CSV is produced");
    const lines = await b.evaluate("window.__csv.split(/\\r?\\n/).filter((l) => l.trim()).length");
    assert.equal(lines, N + 1, `header + all ${N} records`);
  });

  test("printing draws every record for the print, then only the rows near the viewport again", async () => {
    await open("Long Board");
    const before = await drawn();
    await b.evaluate("window.dispatchEvent(new Event('beforeprint'))");
    assert.equal(await drawn(), N, `all ${N} for the print`);
    assert.equal(await b.evaluate("document.querySelectorAll('tr.row-spacer').length"), 0, "no spacers in the print");
    await b.evaluate("window.dispatchEvent(new Event('afterprint'))"); await frames(3);
    assert.ok(await drawn() <= before + 40, "back to the rows near the viewport");
    // A real print (PDF): the page has every row while it prints.
    await b.evaluate("(() => { window.__most = 0; new MutationObserver(() => { window.__most = Math.max(window.__most, document.querySelectorAll('tr[data-record-context]').length); }).observe(document.body, { childList: true, subtree: true }); })()");
    const pdf = await b.send("Page.printToPDF", { printBackground: false });
    assert.ok((pdf.result?.data || "").length > 1000, "a PDF was made");
    await frames(3);
    assert.equal(await b.evaluate("window.__most"), N, "every record was in the page for the print");
    assert.ok(await drawn() < N, "and the board is windowed again afterwards");
    // Recovery: a browser that never sends afterprint. The person's next pointer (or key, wheel, focus) ends print mode.
    await b.evaluate("window.dispatchEvent(new Event('beforeprint'))");
    assert.equal(await drawn(), N, "drawn in full for the print");
    await frames(3); // the recovery listeners are added after the print starts
    await b.evaluate("window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))"); await frames(3);
    assert.ok(await drawn() < N, "the next pointer brings the board back to the rows near the viewport, with no afterprint");
  });

  test("Ctrl+F: on a long board the first press goes to the board search; pressed there it is the browser's own; a short board is left alone", async () => {
    await open("Long Board");
    await b.evaluate("document.activeElement?.blur()");
    await ctrlF(); await sleep(150);
    assert.equal(await b.evaluate("document.activeElement?.id"), "board-search", "the board search has focus");
    assert.match(await b.evaluate("document.querySelector('#toast-region')?.textContent || ''"), /covers every record/);
    assert.equal(await b.evaluate("(() => { const e = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(e); return e.defaultPrevented; })()"), false, "a second press isn't taken");
    await open("Ninety Nine");
    await b.evaluate("document.activeElement?.blur()");
    assert.equal(await b.evaluate("(() => { const e = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; })()"), false, "a board drawn in full keeps the browser's Find");
    assert.notEqual(await b.evaluate("document.activeElement?.id"), "board-search");
  });

  test("Alt+Down on the last drawn row moves it below the drawn rows: it is drawn, focused and on screen", async () => {
    await open("Long Board");
    const id = await b.evaluate("(() => { const body = document.querySelector('tbody[data-window-key]'); const rows = body.querySelectorAll(':scope > tr[data-record-context]'); return rows[rows.length - 1].dataset.recordContext; })()");
    await b.evaluate(`(() => { const h = document.querySelector('[data-action=row-drag][data-id="${id}"]'); h.focus(); h.scrollIntoView({ block: 'nearest' }); })()`); await frames(2);
    // Keep the drawn rows where they are, so the moved row ends up just outside them.
    await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, modifiers: 1 });
    await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, modifiers: 1 });
    await sleep(250);
    const state = await b.evaluate(`(() => { const a = document.activeElement; const w = ${wrap}.getBoundingClientRect(), r = a?.getBoundingClientRect(); return { action: a?.dataset.action, id: a?.dataset.id, onScreen: r ? r.top >= w.top - 1 && r.bottom <= w.bottom + 1 : false }; })()`);
    assert.equal(state.action, "row-drag"); assert.equal(state.id, id, "focus stays on the moved row");
    assert.ok(state.onScreen, "and it is on screen");
    assert.match(await b.evaluate("document.querySelector('#toast-region')?.textContent || ''"), /Row moved/);
  });

  test("arrow keys move down through rows that weren't drawn, without losing focus", async () => {
    await open("Long Board");
    await b.evaluate(`document.querySelector('tbody[data-window-key] tr[data-record-context] .cell-display[data-field="${K.dueRule}"]').focus()`);
    const start = await b.evaluate("document.activeElement.dataset.id");
    const visited = [start];
    for (let i = 0; i < 60; i += 1) {
      await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }); await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }); await frames(1);
      const at = await b.evaluate("(() => { const a = document.activeElement; return { field: a.dataset.field, id: a.dataset.id, cell: a.classList.contains('cell-display') }; })()");
      assert.ok(at.cell && at.field === K.dueRule, `press ${i + 1}: focus is on a cell in the same column`);
      visited.push(at.id);
    }
    // Every press went one row further: 61 different records, in the board's order, past the rows drawn at the start.
    assert.equal(new Set(visited).size, 61, "each press reached a new row");
  });

  test("an open cell editor is never redrawn away while the table scrolls", async () => {
    await open("Long Board");
    await b.evaluate(`document.querySelector('tbody[data-window-key] tr[data-record-context] .cell-display[data-field="${K.dueRule}"]').focus()`);
    await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "x", code: "KeyX", text: "x", windowsVirtualKeyCode: 88 });
    await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "x", code: "KeyX", windowsVirtualKeyCode: 88 });
    assert.ok(await b.waitFor("document.activeElement?.dataset.action === 'cell-input'", 2000), "editing");
    for (let i = 0; i < 6; i += 1) { await b.evaluate(`${wrap}.scrollTop += 300`); await frames(2); }
    assert.equal(await b.evaluate("document.activeElement?.dataset.action"), "cell-input", "the editor still has focus");
    assert.match(await b.evaluate("document.activeElement.value"), /x$/);
    await b.key("Escape");
  });

  test("spacers match a fully drawn table: the same scroll height and the same row positions", async () => {
    await open("Long Board");
    await b.evaluate(`${wrap}.scrollTop = 2600`); await frames(4); await sleep(100);
    const windowed = await b.evaluate(`(() => { const w = ${wrap}; const t = w.querySelector('table').getBoundingClientRect().top; const r = [...w.querySelectorAll('tr[data-record-context]')].find((x) => x.getBoundingClientRect().top > w.getBoundingClientRect().top + 60); return { height: w.scrollHeight, id: r.dataset.recordContext, top: r.getBoundingClientRect().top - t }; })()`);
    await b.evaluate("window.dispatchEvent(new Event('beforeprint'))");
    const full = await b.evaluate(`(() => { const w = ${wrap}; const t = w.querySelector('table').getBoundingClientRect().top; const r = w.querySelector('tr[data-record-context="${windowed.id}"]'); return { height: w.scrollHeight, top: r.getBoundingClientRect().top - t }; })()`);
    await b.evaluate("window.dispatchEvent(new Event('afterprint'))");
    assert.ok(Math.abs(windowed.height - full.height) <= 3, `scroll height ${windowed.height} vs ${full.height}`);
    assert.ok(Math.abs(windowed.top - full.top) <= 3, `row position ${windowed.top} vs ${full.top}`);
  });

  test("groups collapse and expand; a record far down opens; the sticky first column stays opaque on hover", async () => {
    await open("Long Board");
    await b.evaluate("document.querySelector('[data-action=group-toggle]').click()");
    assert.ok(await b.waitFor("document.querySelector('tbody.board-group')?.classList.contains('is-collapsed')", 3000), "collapsed");
    await frames(3);
    // The next group now starts at the top: its rows are drawn from its first one (no spacer before them).
    assert.ok(await b.waitFor("(() => { const t = [...document.querySelectorAll('tbody.board-group')][1]; const first = t?.querySelector(':scope > tr[data-record-context], :scope > tr.row-spacer'); return Boolean(first?.matches('tr[data-record-context]')) && t.querySelectorAll('tr[data-record-context]').length >= 10; })()", 3000), "the next group's rows are drawn from its first one");
    await b.evaluate("document.querySelector('[data-action=group-toggle]').click()");
    assert.ok(await b.waitFor("!document.querySelector('tbody.board-group')?.classList.contains('is-collapsed')", 3000), "expanded");
    await b.evaluate(`${wrap}.scrollTop = ${wrap}.scrollHeight`); await frames(4); await sleep(100);
    const id = await b.evaluate("(() => { const rows = [...document.querySelectorAll('tr[data-record-context]')]; return rows[rows.length - 1].dataset.recordContext; })()");
    // Scrolled to the end, the group's very last record is drawn (no spacer after it).
    assert.equal(await b.evaluate(`(() => { let n = document.querySelector('tr[data-record-context="${id}"]').nextElementSibling; while (n && !n.matches('tr[data-record-context], tr.row-spacer:not(.row-reserved)')) n = n.nextElementSibling; return n === null; })()`), true, "the last record is drawn at the bottom");
    const lastName = await b.evaluate(`document.querySelector('tr[data-record-context="${id}"]').children[1].textContent.trim()`);
    await b.evaluate(`${wrap}.scrollLeft = 400`); await frames(2);
    const p = await b.evaluate(`(() => { const c = document.querySelector('tr[data-record-context="${id}"]').children[1].getBoundingClientRect(); return { x: c.left + c.width * 0.7, y: c.top + c.height / 2 }; })()`);
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }); await sleep(120);
    assert.equal(await b.evaluate(`(() => { const c = getComputedStyle(document.querySelector('tr[data-record-context="${id}"]').children[1]); return c.position + ' ' + (c.backgroundColor.includes('/') || c.backgroundColor.startsWith('rgba') ? 'translucent' : 'opaque'); })()`), "sticky opaque");
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
    await b.evaluate(`document.querySelector('tr[data-record-context="${id}"] [data-action=edit]').click()`);
    assert.ok(await b.waitFor("!!document.querySelector('.record-drawer')", 3000), "the record opens");
    assert.ok((await b.evaluate("document.querySelector('.record-drawer').textContent")).includes(lastName.match(/Long Board row \d+/)[0]), "it is that record");
  });

  test("phone: a long board scrolls, its rows follow, and the page never scrolls sideways", async () => {
    await open("Long Board", 390);
    assert.ok(await drawn() < N);
    await b.evaluate(`${wrap}.scrollTop = 3000`); await frames(4); await sleep(100);
    assert.ok(await b.evaluate(`(() => { const w = ${wrap}.getBoundingClientRect(); return [...document.querySelectorAll('tr[data-record-context]')].some((r) => { const x = r.getBoundingClientRect(); return x.top >= w.top && x.bottom <= w.bottom; }); })()`), "rows are drawn where the table is scrolled to");
    assert.equal(await b.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true);
  });
});
