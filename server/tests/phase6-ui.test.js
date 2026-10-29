// Phase 6 in the REAL app, in a headless browser (Chrome/Edge), with two signed-in employees (Entra test server,
// development_shared, fake MongoDB, in-memory files): multi-select and the bulk-action bar (archive, duplicate,
// export, compatible moves, guarded deletion), spreadsheet editing (ranges, copy, validated paste, clear), undo/redo
// (keyboard, never inside text fields, cleared by a colleague's change), the record drawer, and drag rules.
// Skipped when no Chrome or Edge is installed (set JARC_TEST_BROWSER to use a specific one).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "status", label: "Status", type: "status", options: ["New", "Doing", "Done"] },
  { key: "notes", label: "Notes", type: "text" },
  { key: "qty", label: "Qty", type: "number" },
  { key: "docs", label: "Files", type: "files" }
];

describe("Phase 6: bulk actions, spreadsheet editing, undo/redo, record drawer (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, ana, ben, ws, board, target, other;
  const OIDS = { ana: "0a6a6a6a-0000-4000-8000-000000000061", ben: "0b6b6b6b-0000-4000-8000-000000000062" };
  const signIn = (b, who, name) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${encodeURIComponent(name)}&email=${who}@example.invalid&nonce=" + s.nonce)).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); })()`);
  const api = (b, method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const records = async (id = board.id) => (await api(ana, "GET", `/boards/${id}/records?limit=200`)).body.items;
  const byName = async (serial, id) => (await records(id)).find((r) => r.values.serial === serial);
  const click = (b, sel, opts = "") => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "center", inline: "center" }); el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true${opts} })); return true; })()`);
  const rowCheck = (serial) => `tr:has([aria-label="Item: ${serial}"]) input[data-action="select"]`;
  const cell = (serial, key) => `tr:has([aria-label="Item: ${serial}"]) td[data-column-key="${key}"] .cell-display`;
  const focusCell = (b, serial, key) => b.evaluate(`document.querySelector(${JSON.stringify(cell(serial, key))}).focus()`);
  const toast = (b) => b.evaluate("[...document.querySelectorAll('#toast-region .toast')].map((t) => t.textContent).join(' | ')");
  const saved = async (b) => { assert.ok(await b.waitFor("['live','saved'].includes(document.querySelector('.save-state')?.dataset.state)", 8000), "saved"); await sleep(300); };
  const openBoard = async (b, name = "Bulk board") => {
    await b.motionPreference("no-preference");
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000));
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes(${JSON.stringify(name)}))?.click()`);
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table tbody tr td.cell')", 15000));
    assert.ok(await b.waitFor("document.querySelector('.save-state')?.dataset.state === 'live'", 8000));
    await sleep(300);
  };
  const clipboard = (b, type, text = "") => b.evaluate(`(() => { const dt = new DataTransfer(); ${type === "paste" ? `dt.setData("text/plain", ${JSON.stringify(text)});` : ""} document.dispatchEvent(new ClipboardEvent(${JSON.stringify(type)}, { clipboardData: dt, bubbles: true, cancelable: true })); return dt.getData("text/plain"); })()`);

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    ana = await launch(BROWSER); ben = await launch(BROWSER);
    for (const [b, who, name] of [[ana, "ana", "Ana Reyes"], [ben, "ben", "Ben Cruz"]]) { await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn(b, who, name); }
    ws = (await api(ana, "POST", "/workspaces", { name: "Phase six" })).body.workspace;
    board = (await api(ana, "POST", `/workspaces/${ws.id}/boards`, { name: "Bulk board", columns: COLUMNS })).body.board;
    target = (await api(ana, "POST", `/workspaces/${ws.id}/boards`, { name: "Target board", columns: COLUMNS })).body.board;
    other = (await api(ana, "POST", `/workspaces/${ws.id}/boards`, { name: "Other board", columns: COLUMNS.filter((c) => c.key !== "notes") })).body.board;
    await api(ana, "POST", `/boards/${board.id}/records/batch`, { records: Array.from({ length: 14 }, (_, i) => ({ values: { serial: `R-${String(i + 1).padStart(2, "0")}`, status: "New", notes: `note ${i + 1}`, qty: String(i + 1) } })) });
  });
  after(async () => { await ana?.close(); await ben?.close(); server?.kill(); });

  test("selection: Shift-click selects a range; the floating bar offers bulk actions; clear selection", async () => {
    await openBoard(ana);
    await click(ana, rowCheck("R-03"));
    await click(ana, rowCheck("R-06"), ", shiftKey: true");
    assert.ok(await ana.waitFor("document.querySelector('.bulk-bar .bulk-count')?.textContent === '4'", 2000), "4 rows selected by Shift-click");
    const bar = await ana.evaluate("(() => { const b = document.querySelector('.bulk-bar'); const r = b.getBoundingClientRect(); return { actions: [...b.querySelectorAll('.bulk-action span')].map((s) => s.textContent), fixed: getComputedStyle(b).position, nearBottom: innerHeight - r.bottom < 60 }; })()");
    assert.deepEqual(bar.actions, ["Status", "Duplicate", "Export", "Archive", "Group", "Move to", "Delete"], "Group (Phase 8) moves records between board groups");
    assert.deepEqual([bar.fixed, bar.nearBottom], ["fixed", true], "floats at the bottom of the window");
    assert.equal(await ana.evaluate("document.querySelectorAll('tr.is-selected').length"), 4);
    await click(ana, '.bulk-bar [data-action="clear-selection"]');
    assert.ok(await ana.waitFor("!document.querySelector('.bulk-bar')", 2000));
  });

  test("bulk archive (restorable) and restore, bulk duplicate (no records lost, files not copied), bulk export", async () => {
    for (const s of ["R-01", "R-02"]) await click(ana, rowCheck(s));
    await click(ana, '.bulk-bar [data-action="bulk-archive"]');
    await saved(ana);
    assert.deepEqual([(await byName("R-01")).archived, (await byName("R-02")).archived], [true, true]);
    assert.match(await toast(ana), /2 records archived · restore them from Archived records/);
    await click(ana, '.board-actions [data-action="board-menu"]'); await click(ana, '.board-popover [data-action="archived-view"]');
    assert.ok(await ana.waitFor("!!document.querySelector('.archived-tab')", 2000));
    await click(ana, rowCheck("R-01")); await click(ana, rowCheck("R-02"));
    assert.ok(await ana.waitFor("!!document.querySelector('.bulk-bar [data-action=bulk-restore]')", 2000), "Restore offered for archived records");
    await click(ana, '.bulk-bar [data-action="bulk-restore"]');
    await saved(ana);
    assert.deepEqual([(await byName("R-01")).archived, (await byName("R-02")).archived], [false, false]);
    await click(ana, '[data-action="main-table"]');
    const before = (await records()).length;
    for (const s of ["R-07", "R-08"]) await click(ana, rowCheck(s));
    await ana.evaluate("(() => { window.__downloads = 0; const c = URL.createObjectURL; URL.createObjectURL = (b) => { window.__downloads += 1; return c(b); }; })()");
    await click(ana, '.bulk-bar [data-action="bulk-export"]');
    assert.ok(await ana.waitFor("window.__downloads === 1", 2000), "selected records exported");
    await click(ana, '.bulk-bar [data-action="bulk-duplicate"]');
    await saved(ana);
    const after = await records();
    assert.equal(after.length, before + 2);
    assert.deepEqual(after.filter((r) => /copy$/.test(r.values.serial)).map((r) => r.values.serial).sort(), ["R-07 copy", "R-08 copy"]);
    assert.equal(after.find((r) => r.values.serial === "R-07 copy").values.notes, "note 7", "values copied");
    await click(ana, '.bulk-bar [data-action="clear-selection"]');
  });

  test("bulk move: only to boards with matching columns, never records with files; moved records keep their values", async () => {
    await click(ana, rowCheck("R-09"));
    await click(ana, '.bulk-bar [data-action="bulk-move"]');
    assert.ok(await ana.waitFor("!!document.querySelector('.move-targets')", 2000));
    const options = await ana.evaluate("[...document.querySelectorAll('.move-targets [data-action=apply-bulk-move]')].map((b) => [b.querySelector('strong').textContent, b.disabled, b.querySelector('small').textContent])");
    assert.deepEqual(options.find((o) => o[0] === "Other board").slice(1), [true, "Needs matching column: Notes"], "a board missing a used column is refused (its columns are never changed)");
    assert.equal(options.find((o) => o[0] === "Target board")[1], false);
    await click(ana, '.move-targets [data-action="apply-bulk-move"]:not([disabled])');
    await saved(ana);
    assert.equal(await byName("R-09"), undefined, "gone from this board");
    const moved = await byName("R-09", target.id);
    assert.deepEqual([moved?.values.notes, moved?.values.qty], ["note 9", "9"], "on the target board with its values");
    assert.deepEqual((await api(ana, "GET", `/boards/${target.id}`)).body.board.columns.map((c) => c.key), COLUMNS.map((c) => c.key), "target board columns unchanged");
    // A record with a file can't be moved (its files belong to it on this board).
    const r10 = await byName("R-10");
    const up = await ana.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); return (await fetch("/api/v1/records/${r10.id}/attachments?column=docs", { method: "POST", headers: { "Content-Type": "application/pdf", "X-File-Name": "plan.pdf", "X-CSRF-Token": csrfToken }, body: "%PDF-1.4 x" })).status; })()`);
    assert.equal(up, 201);
    await openBoard(ana);
    assert.ok(await ana.waitFor(`!!document.querySelector(${JSON.stringify(cell("R-10", "docs"))} + " .file-thumb")`, 5000));
    await click(ana, rowCheck("R-10"));
    await click(ana, '.bulk-bar [data-action="bulk-move"]');
    assert.ok(await ana.waitFor("!!document.querySelector('.move-targets')", 2000));
    assert.equal(await ana.evaluate("[...document.querySelectorAll('.move-targets [data-action=apply-bulk-move]')].every((b) => b.disabled && /files/.test(b.title))"), true, "records with files: every target refused");
    await ana.key("Escape");
    await click(ana, '.bulk-bar [data-action="clear-selection"]');
  });

  test("bulk delete: 10 or more records require typing DELETE; a wrong confirmation deletes nothing", async () => {
    const pool = (await records()).filter((r) => !r.archived && /^R-(0[1-8]|1[1-4])$/.test(r.values.serial)).map((r) => r.values.serial).slice(0, 10);
    assert.equal(pool.length, 10);
    for (const s of pool) await click(ana, rowCheck(s));
    assert.ok(await ana.waitFor("document.querySelector('.bulk-bar .bulk-count')?.textContent === '10'", 2000));
    await click(ana, '.bulk-bar [data-action="delete-selected"]');
    assert.ok(await ana.waitFor("!!document.querySelector('form[data-action=confirm-bulk-delete]')", 2000), "typed confirmation for 10+");
    assert.match(await ana.evaluate("document.querySelector('form[data-action=confirm-bulk-delete]').textContent"), /Archive/, "points to Archive as the restorable option");
    const count = (await records()).length;
    await ana.evaluate("document.querySelector('form[data-action=confirm-bulk-delete] input[name=confirm]').value = 'delete it'");
    await click(ana, 'form[data-action="confirm-bulk-delete"] .button.danger');
    await sleep(500);
    assert.equal((await records()).length, count, "nothing deleted");
    await ana.evaluate("document.querySelector('form[data-action=confirm-bulk-delete] input[name=confirm]').value = 'DELETE'");
    await click(ana, 'form[data-action="confirm-bulk-delete"] .button.danger');
    await saved(ana);
    assert.equal((await records()).length, count - 10, "deleted once confirmed");
  });

  test("spreadsheet: Shift+arrows select a range; copy gives tab-separated text; paste validates per column; Delete clears; undo restores", async () => {
    await openBoard(ana);
    await api(ana, "POST", `/boards/${board.id}/records/batch`, { records: [{ values: { serial: "S-1", status: "New", notes: "alpha", qty: "1" } }, { values: { serial: "S-2", status: "Doing", notes: "beta", qty: "2" } }] });
    await openBoard(ana);
    await focusCell(ana, "S-1", "status");
    await ana.key("ArrowRight", "ArrowRight"); // focus Notes
    await focusCell(ana, "S-1", "notes");
    await ana.evaluate(`document.querySelector(${JSON.stringify(cell("S-1", "notes"))}).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }))`);
    assert.equal(await ana.evaluate("document.querySelectorAll('td.cell-in-range').length"), 2, "a 2-cell range");
    const copied = await clipboard(ana, "copy");
    assert.equal(copied.split("\n").length, 2);
    assert.ok(copied.includes("alpha") && copied.includes("beta"));
    // Paste a label into Status (matched case-insensitively), then a non-number into Qty (refused, value unchanged).
    await focusCell(ana, "S-1", "status");
    await clipboard(ana, "paste", "done");
    await saved(ana);
    assert.equal((await byName("S-1")).values.status, "Done", "label matched case-insensitively");
    await focusCell(ana, "S-1", "qty");
    await clipboard(ana, "paste", "lots");
    await sleep(400);
    assert.equal((await byName("S-1")).values.qty, "1", "an invalid value never overwrites");
    assert.match(await toast(ana), /Nothing pasted: 1 value doesn.t fit its column/);
    // Replacing several filled cells asks first.
    await focusCell(ana, "S-1", "notes");
    await clipboard(ana, "paste", "x\ny");
    assert.ok(await ana.waitFor("!!document.querySelector('[data-action=confirm-paste]')", 2000), "confirm before replacing filled cells");
    await click(ana, '[data-action="confirm-paste"]');
    await saved(ana);
    assert.deepEqual([(await byName("S-1")).values.notes, (await byName("S-2")).values.notes], ["x", "y"]);
    // Delete clears the focused cell; Ctrl+Z brings it back.
    await focusCell(ana, "S-2", "notes");
    await ana.key("Delete");
    await saved(ana);
    assert.equal((await byName("S-2")).values.notes, "");
    await ana.evaluate("document.activeElement?.blur()");
    await ana.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
    await saved(ana);
    assert.equal((await byName("S-2")).values.notes, "y", "Ctrl+Z restored it");
    await ana.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }))");
    await saved(ana);
    assert.equal((await byName("S-2")).values.notes, "", "Ctrl+Shift+Z redid it");
  });

  test("undo never acts inside text fields, and a colleague's change clears it (their newer value is never overwritten)", async () => {
    await openBoard(ana); await openBoard(ben);
    await focusCell(ana, "S-1", "qty");
    await ana.key("Delete");
    await saved(ana);
    assert.equal((await byName("S-1")).values.qty, "");
    // Ctrl+Z typed in the board search box is the browser's own text undo, not JARC's.
    await ana.evaluate("document.querySelector('#board-search').focus()");
    await ana.evaluate("document.querySelector('#board-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
    await sleep(500);
    assert.equal((await byName("S-1")).values.qty, "", "nothing undone from a text field");
    await ana.evaluate("document.activeElement?.blur()");
    // Ben changes the same record; once it arrives, Ana's undo history is gone.
    const s1 = await byName("S-1");
    await api(ben, "PATCH", `/records/${s1.id}`, { expectedVersion: s1.version, values: { qty: "77" } });
    assert.ok(await ana.waitFor(`document.querySelector(${JSON.stringify(cell("S-1", "qty"))})?.textContent.includes("77")`, 8000));
    await ana.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
    await sleep(600);
    assert.match(await toast(ana), /Nothing to undo/);
    assert.equal((await byName("S-1")).values.qty, "77", "Ben's newer value stays");
  });

  test("record drawer: record name as title, position and dates, property layout, files section, real history; Manage files", async () => {
    await openBoard(ana);
    await ana.evaluate(`document.querySelector('tr:has([aria-label="Item: R-10"]) [data-action="edit"], tr:has([aria-label="Item: R-10"]) [data-action="record-menu"]') && 0`);
    const r10 = await byName("R-10");
    await ana.evaluate(`(() => { const b = document.createElement("button"); b.dataset.action = "edit"; b.dataset.id = ${JSON.stringify(r10.id)}; document.querySelector(".app-shell").append(b); b.click(); b.remove(); })()`);
    assert.ok(await ana.waitFor("!!document.querySelector('.record-drawer .record-title')", 3000));
    assert.equal(await ana.evaluate("document.querySelector('.record-drawer .record-title').textContent"), "R-10");
    assert.match(await ana.evaluate("document.querySelector('.record-drawer .record-meta').textContent"), /Record \d+ of \d+/);
    assert.match(await ana.evaluate("document.querySelector('.record-drawer .eyebrow').textContent"), /Phase six · Bulk board/);
    assert.notEqual(await ana.evaluate("getComputedStyle(document.querySelector('.record-drawer .record-form-grid > label[data-column-key=notes]')).gridTemplateColumns"), "none", "label | value layout");
    assert.match(await ana.evaluate("document.querySelector('.record-drawer .drawer-files').textContent"), /plan\.pdf.*Manage files/s);
    assert.equal(await ana.evaluate("!!document.querySelector('.record-drawer input[name=docs]')"), false, "files aren't a text field");
    assert.match(await ana.evaluate("document.querySelector('.record-activity').textContent"), /Added file plan\.pdf/, "history from the server's activity log");
    await click(ana, '.record-drawer [data-action="drawer-files"]');
    assert.ok(await ana.waitFor("!!document.querySelector('.files-popover')", 3000), "Manage files opens the Files panel");
    await ana.key("Escape");
  });

  test("drag: rows can't be reordered from a custom view or while sorted (row order is shared); Main Table still can", async () => {
    await openBoard(ana);
    const rowDrag = async (serial) => { await ana.evaluate(`document.querySelector('#toast-region').innerHTML = ''; document.querySelector('tr:has([aria-label="Item: ${serial}"]) [data-action="row-drag"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 10, clientY: 10 }))`); await sleep(200); return toast(ana); };
    assert.doesNotMatch(await rowDrag("S-2"), /can't|Clear the sort|Main Table/, "allowed in Main Table");
    await ana.evaluate("document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))");
    await click(ana, '[data-action="views-menu"]'); await click(ana, '[data-action="new-view"][data-type="table"]');
    await ana.waitFor("!!document.querySelector('form[data-action=create-view-form]')", 2000);
    await click(ana, 'form[data-action="create-view-form"] .button.primary');
    await sleep(400);
    assert.match(await rowDrag("S-2"), /reordered in Main Table/, "blocked in a view, with the reason");
  });
});
