// Column system and notifications in the REAL app, in a headless browser (Chrome/Edge), with two signed-in
// employees (Entra test server, ACCESS_POLICY=development_shared, fake MongoDB). Every edit is checked on the server
// (no local-only changes), after a reload, and from the other employee's browser. Also: keyboard use, phone touch,
// an empty board, a refused save, and who-did-what in notifications.
// Skipped when no Chrome or Edge is installed (set JARC_TEST_BROWSER to use a specific one).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort } = require("./support/headless-browser");

const BROWSER = findBrowser();
const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "status", label: "Status", type: "status", options: ["To do", "Working", "Done"], colors: ["#64748b", "#3b82f6", "#1f9d61"] },
  { key: "tags", label: "Tags", type: "dropdown", multiple: true, options: ["North", "South", "East", "West"] },
  { key: "done", label: "Done?", type: "checkbox" },
  { key: "owner", label: "People", type: "owner" },
  { key: "due", label: "Due", type: "date" },
  { key: "qty", label: "Qty", type: "number" },
  { key: "notes", label: "Notes", type: "text" }
];

describe("Columns and notifications (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, ana, ben, ws, board;
  const signIn = (b, name, email) => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=" + crypto.randomUUID() + "&name=${encodeURIComponent(name)}&email=${email}&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const api = (b, method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const record = async (b, serial) => (await api(b, "GET", `/boards/${board.id}/records?limit=200`)).body.items.find((r) => r.values.serial === serial);
  const cell = (serial, key) => `tr:has(td[data-column-key="serial"] [aria-label="Item: ${serial}"]) td[data-column-key="${key}"] .cell-display`;
  const reveal = (b, sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: "center", inline: "center" })`).then(() => sleep(150));
  const click = (b, sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "center", inline: "center" }); el.click(); return true; })()`);
  const text = (b, sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? null`);
  const openBoard = async (b, width = 1280) => {
    await b.open(`${base}/`, { width, height: 860 });
    await b.waitFor("!!document.querySelector('.app-shell')", 8000);
    await b.evaluate("[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes('Jobs'))?.click()");
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table tbody tr td.cell')", 8000), "board table loaded");
    await sleep(300);
  };
  const saved = (b) => b.waitFor("!document.querySelector('.save-state')?.textContent.includes('Saving')", 5000).then(() => sleep(250));
  const addRecord = (serial, values = {}) => api(ana, "POST", `/boards/${board.id}/records`, { values: { serial, ...values } });

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    for (let i = 0; i < 100; i += 1) { try { await fetch(`${base}/api/v1/health`); break; } catch { await sleep(100); } }
    ana = await launch(BROWSER); ben = await launch(BROWSER);
    for (const [b, name, email] of [[ana, "Ana Reyes", "ana@example.invalid"], [ben, "Ben Cruz", "ben@example.invalid"]]) { await b.open(`${base}/`, { width: 1280 }); await signIn(b, name, email); }
    ws = (await api(ana, "POST", "/workspaces", { name: "Operations" })).body.workspace;
    board = (await api(ana, "POST", `/workspaces/${ws.id}/boards`, { name: "Jobs", columns: COLUMNS })).body.board;
  });
  after(async () => { await ana?.close(); await ben?.close(); server?.kill(); });

  test("Status: the picker shows coloured labels; choosing one saves it; Clear empties it", async () => {
    await addRecord("S-1");
    await openBoard(ana);
    assert.ok(await click(ana, cell("S-1", "status")));
    assert.deepEqual(await ana.evaluate("[...document.querySelectorAll('.cell-options-popover .cell-option')].map(b => [b.dataset.value, b.getAttribute('role')])"), [["To do", "menuitemradio"], ["Working", "menuitemradio"], ["Done", "menuitemradio"]]);
    await click(ana, '.cell-option[data-value="Working"]'); await saved(ana);
    assert.equal((await record(ana, "S-1")).values.status, "Working");
    assert.equal(await ana.evaluate(`document.querySelector(${JSON.stringify(cell("S-1", "status"))} + " .pill").getAttribute("style")`), "--tone:#3b82f6");
    await click(ana, cell("S-1", "status")); await click(ana, '.popover-footer [data-action="set-cell-option"][data-value=""]'); await saved(ana);
    assert.equal((await record(ana, "S-1")).values.status, "");
  });

  test("Dropdown (several values): toggles stay open, search filters, chips show, the list is saved", async () => {
    await addRecord("D-1");
    await openBoard(ana);
    await click(ana, cell("D-1", "tags"));
    await click(ana, '.cell-option[data-value="North"]'); await sleep(200); await click(ana, '.cell-option[data-value="East"]'); await saved(ana);
    assert.equal(await ana.evaluate("!!document.querySelector('.cell-options-popover')"), true, "still open");
    assert.equal(await ana.evaluate("document.querySelector('.cell-option[data-value=North]').getAttribute('aria-checked')"), "true");
    await ana.evaluate("(() => { const i = document.querySelector('[data-action=cell-option-search]'); i.value = 'we'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    assert.deepEqual(await ana.evaluate("[...document.querySelectorAll('.cell-option')].filter(b => !b.hidden).map(b => b.dataset.value)"), ["West"]);
    await click(ana, ".popover-done");
    assert.deepEqual((await record(ana, "D-1")).values.tags, ["North", "East"]);
    assert.deepEqual(await ana.evaluate(`[...document.querySelectorAll(${JSON.stringify(cell("D-1", "tags"))} + " .pill")].map(p => p.textContent)`), ["North", "East"]);
  });

  test("People: colleagues from the directory (not invented), several assignees, shown with avatars; Ben sees the same", async () => {
    await api(ben, "GET", "/me"); // Ben has signed in, so he is a colleague in the directory
    await addRecord("P-1");
    await openBoard(ana);
    await click(ana, cell("P-1", "owner"));
    assert.ok(await ana.waitFor("document.querySelectorAll('.cell-option').length >= 2", 5000));
    assert.deepEqual(await ana.evaluate("[...document.querySelectorAll('.cell-option .person-name')].map(n => n.textContent)"), ["Ana Reyes (you)", "Ben Cruz"]);
    for (const name of ["Ana Reyes (you)", "Ben Cruz"]) { await ana.evaluate(`[...document.querySelectorAll('.cell-option')].find(b => b.textContent.includes(${JSON.stringify(name)})).click()`); await sleep(300); }
    await click(ana, ".popover-done"); await saved(ana);
    const owner = (await record(ana, "P-1")).values.owner;
    assert.equal(owner.length, 2); assert.ok(owner.every((v) => /^user:[0-9a-f]{24}$/.test(v)), "stored as user references");
    assert.equal(await text(ana, cell("P-1", "owner")), "ARBC2 people");
    await openBoard(ben);
    assert.equal(await ben.evaluate(`document.querySelector(${JSON.stringify(cell("P-1", "owner"))} + " .people-stack").title`), "Ana Reyes, Ben Cruz");
  });

  test("Checkbox, number and date: saved straight away, shown consistently; an invalid number isn't saved", async () => {
    await addRecord("C-1");
    await openBoard(ana);
    await click(ana, cell("C-1", "done")); await saved(ana);
    assert.equal((await record(ana, "C-1")).values.done, true);
    await click(ana, cell("C-1", "qty"));
    await ana.evaluate("(() => { const i = document.querySelector('.cell-input'); i.value = '1234.5'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()"); await saved(ana);
    assert.deepEqual([(await record(ana, "C-1")).values.qty, await text(ana, cell("C-1", "qty"))], ["1234.5", (1234.5).toLocaleString()]);
    await click(ana, cell("C-1", "qty"));
    const bad = await ana.evaluate("(() => { const i = document.querySelector('.cell-input'); i.value = 'abc'; return i.value; })()");
    assert.equal(bad, "", "the number field refuses letters");
    await ana.key("Escape"); await sleep(150);
    assert.equal((await record(ana, "C-1")).values.qty, "1234.5");
    await click(ana, cell("C-1", "due"));
    await ana.evaluate("(() => { const i = document.querySelector('.cell-input'); i.value = '2026-10-05'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()"); await saved(ana);
    assert.deepEqual([(await record(ana, "C-1")).values.due, await text(ana, cell("C-1", "due"))], ["2026-10-05", "Oct 5, 2026"]);
  });

  test("keyboard: Enter opens a picker, arrows move, Enter chooses; Space ticks a checkbox", async () => {
    await addRecord("K-1");
    await openBoard(ana);
    await ana.evaluate(`document.querySelector(${JSON.stringify(cell("K-1", "status"))}).focus()`);
    await ana.key("Enter"); await sleep(250);
    assert.equal(await ana.evaluate("!!document.querySelector('.cell-options-popover')"), true, "Enter opens the picker");
    assert.equal(await ana.evaluate("document.activeElement?.dataset.value"), "To do", "focus starts on the first label");
    await ana.key("ArrowDown"); await ana.key("Enter"); await saved(ana);
    assert.equal((await record(ana, "K-1")).values.status, "Working");
    await ana.evaluate(`document.querySelector(${JSON.stringify(cell("K-1", "done"))}).focus()`);
    await ana.key(" "); await saved(ana);
    assert.equal((await record(ana, "K-1")).values.done, true);
    assert.equal(await ana.evaluate(`document.querySelector(${JSON.stringify(cell("K-1", "done"))}).getAttribute("aria-checked")`), "true");
  });

  test("labels: rename, recolour and reorder update the column and every record that uses them", async () => {
    await addRecord("L-1", { status: "Working" });
    await openBoard(ana);
    await click(ana, 'th[data-column-key="status"] .column-menu-button'); await click(ana, '.column-menu-popover [data-action="edit-column-options"]'); await sleep(250);
    await ana.evaluate("(() => { const rows = [...document.querySelectorAll('.option-row')]; rows[1].querySelector('.option-name').value = 'In progress'; rows[2].querySelector('.option-color').value = '#8e4ec6'; rows[2].querySelector('[data-direction=up]').click(); rows[2].querySelector('[data-direction=up]').click(); document.querySelector('.option-editor').requestSubmit(); })()");
    await sleep(300); if (await ana.evaluate("!!document.querySelector('[data-action=confirm-options]')")) await click(ana, '[data-action="confirm-options"]');
    await saved(ana); await sleep(300);
    const status = (await api(ana, "GET", `/boards/${board.id}`)).body.board.columns.find((c) => c.key === "status");
    assert.deepEqual([status.options, status.colors], [["Done", "To do", "In progress"], ["#8e4ec6", "#64748b", "#3b82f6"]]);
    assert.equal((await record(ana, "L-1")).values.status, "In progress");
  });

  test("one value only: a confirmation when cells hold several, then each keeps its first value", async () => {
    await addRecord("M-1", { tags: ["South", "West"] });
    await openBoard(ana);
    await click(ana, 'th[data-column-key="tags"] .column-menu-button'); await click(ana, '.column-menu-popover [data-action="toggle-column-multiple"]'); await sleep(250);
    assert.match(await text(ana, "#overlay-root h2"), /Allow one value in Tags\?/);
    await click(ana, '[data-action="confirm-column-single"]'); await saved(ana); await sleep(300);
    assert.equal((await api(ana, "GET", `/boards/${board.id}`)).body.board.columns.find((c) => c.key === "tags").multiple, undefined);
    assert.equal((await record(ana, "M-1")).values.tags, "South");
    await click(ana, 'th[data-column-key="tags"] .column-menu-button'); await click(ana, '.column-menu-popover [data-action="toggle-column-multiple"]'); await saved(ana); await sleep(300);
    assert.equal((await api(ana, "GET", `/boards/${board.id}`)).body.board.columns.find((c) => c.key === "tags").multiple, true);
    assert.deepEqual((await record(ana, "M-1")).values.tags, ["South"]);
  });

  test("column menu: duplicate (with values), width, delete with confirmation", async () => {
    await addRecord("W-1", { notes: "Copy me" });
    await openBoard(ana);
    await click(ana, 'th[data-column-key="notes"] .column-menu-button');
    const actions = await ana.evaluate("[...document.querySelectorAll('.column-menu-popover button')].map(b => b.dataset.action)");
    for (const a of ["rename-column", "edit-column-options", "duplicate-column", "column-width", "hide-column", "move-column-menu", "request-delete-column"]) if (a !== "edit-column-options") assert.ok(actions.includes(a), a);
    assert.ok(!actions.includes("edit-column-options"), "no label editor for a text column");
    await click(ana, '.column-menu-popover [data-action="duplicate-column"]'); await saved(ana); await sleep(300);
    const copy = (await api(ana, "GET", `/boards/${board.id}`)).body.board.columns.find((c) => c.label === "Notes copy");
    assert.ok(copy); assert.equal((await record(ana, "W-1")).values[copy.key], "Copy me");
    await click(ana, `th[data-column-key="${copy.key}"] .column-menu-button`); await click(ana, '.column-menu-popover [data-action="column-width"]'); await sleep(150);
    await ana.evaluate("(() => { const f = document.querySelector('[data-action=column-width-form]'); f.width.value = '260'; f.requestSubmit(); })()"); await saved(ana); await sleep(300);
    assert.equal((await api(ana, "GET", `/boards/${board.id}`)).body.board.columns.find((c) => c.key === copy.key).width, 260);
    await click(ana, `th[data-column-key="${copy.key}"] .column-menu-button`); await click(ana, '.column-menu-popover [data-action="request-delete-column"]'); await sleep(200);
    assert.match(await text(ana, "#overlay-root h2"), /Delete "Notes copy"\?/);
    await click(ana, '[data-action="confirm-delete-column"]'); await saved(ana); await sleep(300);
    assert.ok(!(await api(ana, "GET", `/boards/${board.id}`)).body.board.columns.some((c) => c.key === copy.key));
  });

  test("everything survives a reload, and the other employee sees the same values", async () => {
    for (const b of [ana, ben]) {
      await openBoard(b);
      assert.equal(await text(b, cell("L-1", "status")), "In progress");
      assert.equal(await text(b, cell("C-1", "due")), "Oct 5, 2026");
      // D-1 kept its first tag when Tags was switched to one value and back (earlier test).
      assert.deepEqual(await b.evaluate(`[...document.querySelectorAll(${JSON.stringify(cell("D-1", "tags"))} + " .pill")].map(p => p.textContent)`), ["North"]);
      assert.equal(await b.evaluate(`document.querySelector(${JSON.stringify(cell("P-1", "owner"))} + " .people-stack")?.title`), "Ana Reyes, Ben Cruz");
    }
  });

  test("a refused save (assigning someone who was just deactivated) is rolled back and reported, not silently lost", async () => {
    await addRecord("E-1");
    await openBoard(ana);
    await click(ana, cell("E-1", "owner")); await ana.waitFor("document.querySelectorAll('.cell-option').length >= 2", 5000);
    await ana.evaluate("fetch('/__test/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disableEmail: 'ben@example.invalid' }) })"); await sleep(200);
    await ana.evaluate("[...document.querySelectorAll('.cell-option')].find(b => b.textContent.includes('Ben Cruz')).click()");
    assert.ok(await ana.waitFor("!!document.querySelector('.toast')", 5000), "the person is told");
    await sleep(400);
    assert.deepEqual((await record(ana, "E-1")).values.owner, [], "nothing saved (a new record starts with no one assigned)");
    assert.equal(await ana.evaluate(`document.querySelector(${JSON.stringify(cell("E-1", "owner"))} + " .people-stack") === null`), true, "the cell shows what is stored");
    await ana.evaluate("fetch('/__test/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enableEmail: 'ben@example.invalid' }) })");
  });

  test("an empty board: add a Status column and a record from the UI, then use the picker", async () => {
    const empty = (await api(ana, "POST", `/workspaces/${ws.id}/boards`, { name: "Empty" })).body.board;
    await ana.open(`${base}/`, { width: 1280, height: 860 }); await ana.waitFor("!!document.querySelector('.app-shell')", 8000);
    await ana.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find(b => b.textContent.includes('Empty')).click()`); await sleep(600);
    await click(ana, ".add-column-button"); await sleep(200);
    await click(ana, '.chooser-option[data-type="status"]'); await sleep(200);
    await ana.evaluate("document.querySelector('[data-action=create-column-form]').requestSubmit()"); await saved(ana); await sleep(400);
    const status = (await api(ana, "GET", `/boards/${empty.id}`)).body.board.columns.find((c) => c.type === "status");
    assert.ok(status, "the column exists on the server");
    await click(ana, '.quick-add-row [data-action="inline-add"]'); await sleep(200);
    await ana.evaluate("(() => { const i = document.querySelector('[data-action=draft-input]'); i.value = 'First'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()"); await saved(ana); await sleep(400);
    await click(ana, `tr:has([aria-label="Item: First"]) td[data-column-key="${status.key}"] .cell-display`); await sleep(200);
    await click(ana, `.cell-option[data-value="${status.options[1]}"]`); await saved(ana);
    const first = (await api(ana, "GET", `/boards/${empty.id}/records`)).body.items.find((r) => r.values.serial === "First");
    assert.equal(first.values[status.key], status.options[1]);
  });

  test("phones: the picker fits the screen with 44 px options, and taps save", async () => {
    await addRecord("T-1");
    await openBoard(ana, 390);
    await reveal(ana, cell("T-1", "status"));
    assert.ok(await ana.tapOn(cell("T-1", "status")));
    await sleep(300);
    assert.equal(await ana.evaluate("(() => { const r = document.querySelector('.cell-options-popover').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()"), true);
    assert.ok(await ana.evaluate("[...document.querySelectorAll('.cell-option')].every(b => b.getBoundingClientRect().height >= 44)"));
    await ana.tapOn('.cell-option[data-value="Done"]'); await saved(ana);
    assert.equal((await record(ana, "T-1")).values.status, "Done");
    await reveal(ana, cell("T-1", "tags"));
    await ana.tapOn(cell("T-1", "tags")); await sleep(300);
    assert.equal(await ana.evaluate("parseFloat(getComputedStyle(document.querySelector('[data-action=cell-option-search]')).fontSize) >= 16"), true, "no iOS zoom on the search field");
    await ana.tapOn('.cell-option[data-value="North"]'); await sleep(250); await ana.tapOn(".popover-done"); await saved(ana);
    assert.deepEqual((await record(ana, "T-1")).values.tags, ["North"]);
  });

  test("notifications: who did what, where and when; “You” for my own; “Unknown user” for older entries", async () => {
    await ben.evaluate(`fetch('/__test/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ legacyActivity: ${JSON.stringify(ws.id)} }) })`);
    await openBoard(ben);
    await click(ben, '[data-action="notifications"]');
    assert.ok(await ben.waitFor("document.querySelectorAll('.notification-item').length > 0", 5000));
    const items = await ben.evaluate("[...document.querySelectorAll('.notification-item')].map(n => ({ who: n.querySelector('.actor-name').textContent, initials: n.querySelector('.actor-avatar').textContent, text: n.querySelector('strong').textContent, where: n.querySelector('.notification-where')?.textContent || '', when: n.querySelector('time')?.getAttribute('datetime') }))");
    assert.equal(items[0].who, "Unknown user", "the older entry without an actor");
    assert.equal(items[0].initials, "?");
    const byAna = items.find((n) => n.who === "Ana Reyes" && /changed Status/.test(n.text));
    assert.ok(byAna, "Ana's change, by name"); assert.equal(byAna.initials, "AR"); assert.match(byAna.where, /^Jobs · /); assert.ok(byAna.when);
    await click(ben, '[data-action="notification-filter"][data-filter="assigned"]'); await sleep(200);
    assert.ok(await ben.evaluate("[...document.querySelectorAll('.notification-item')].some(n => n.textContent.includes('changed People'))"), "Assigned: Ana assigned Ben");
    await click(ben, '[data-action="mark-notifications"]'); await sleep(300);
    assert.equal(await ben.evaluate("document.querySelector('.notification-button b')"), null, "badge cleared");
    await ben.open(`${base}/`, { width: 1280 }); await ben.waitFor("!!document.querySelector('.app-shell')", 8000); await sleep(1200);
    assert.equal(await ben.evaluate("document.querySelector('.notification-button b')"), null, "still read after a reload");
    await api(ben, "POST", `/boards/${board.id}/records`, { values: { serial: "By Ben" } });
    await openBoard(ana);
    await click(ana, '[data-action="notifications"]'); await ana.waitFor("document.querySelectorAll('.notification-item').length > 0", 5000);
    const anaItems = await ana.evaluate("[...document.querySelectorAll('.notification-item')].map(n => n.querySelector('.actor-name').textContent)");
    assert.equal(anaItems[0], "Ben Cruz", "Ben's change, newest first");
    assert.ok(anaItems.includes("You"), "Ana's own changes say You");
  });
});
