// Phase 5 desktop workspace in the REAL app, in a headless browser (Chrome/Edge), on a role_based Entra test server
// (fake MongoDB, in-memory files): compact layout, centred global search (results, keyboard, highlighting,
// authorisation, no extra downloads), the views system (Main Table + created views, persistence, renaming, deleting,
// view-only columns, live for colleagues), archived records from the board menu, Import/Export in the header, column
// widths and resizing, and reduced motion from the device setting.
// Skipped when no Chrome or Edge is installed (set JARC_TEST_BROWSER to use a specific one).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "status", label: "Status", type: "status", options: ["To do", "Done"] },
  { key: "notes", label: "Site notes", type: "text" },
  { key: "done", label: "Checked", type: "checkbox" },
  { key: "due", label: "Due", type: "date" },
  { key: "docs", label: "Files", type: "files" }
];

describe("Desktop workspace (real app, headless browser, role_based)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, admin, mia, ben, visible, secret, jobs, hidden;
  const OIDS = { admin: "0d0d0d0d-0000-4000-8000-000000000041", mia: "0d0d0d0d-0000-4000-8000-000000000042", ben: "0d0d0d0d-0000-4000-8000-000000000043" };
  const signIn = (b, who, name, isAdmin = false) => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${encodeURIComponent(name)}&email=${who}@example.invalid&admin=${isAdmin ? 1 : 0}&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const api = (b, method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const click = (b, sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "center", inline: "center" }); el.click(); return true; })()`);
  const text = (b, sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? null`);
  const openApp = async (b, { width = 1440, height = 900 } = {}) => {
    await b.motionPreference("no-preference");
    await b.open(`${base}/`, { width, height });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "app shown");
  };
  const openBoard = async (b, name) => {
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes(${JSON.stringify(name)}))?.click()`);
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table tbody tr td.cell')", 15000), `${name} loaded`);
    await sleep(300);
  };
  const createView = async (b, type, name) => {
    await click(b, '[data-action="views-menu"]');
    assert.ok(await b.waitFor(`!!document.querySelector('[data-action="new-view"][data-type="${type}"]')`, 2000), "+ Views offers the view types");
    await click(b, `[data-action="new-view"][data-type="${type}"]`);
    assert.ok(await b.waitFor("!!document.querySelector('form[data-action=create-view-form]')", 2000));
    await b.evaluate(`document.querySelector('form[data-action=create-view-form] input[name=name]').value = ${JSON.stringify(name)}`);
    await click(b, 'form[data-action="create-view-form"] .button.primary');
    await sleep(400);
  };
  const tabs = (b) => b.evaluate("[...document.querySelectorAll('.view-tabs [role=tab]')].map((t) => t.textContent.replace(/\\s+/g, ' ').trim())");
  const savedViews = async () => (await api(mia, "GET", `/boards/${jobs.id}`)).body.board.savedViews;

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore" }); // role_based
    await waitForServer(base, { child: server });
    admin = await launch(BROWSER); mia = await launch(BROWSER); ben = await launch(BROWSER);
    for (const [b, who, name, isAdmin] of [[admin, "admin", "Ada Admin", true], [mia, "mia", "Mia Member"], [ben, "ben", "Ben Member"]]) { await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn(b, who, name, isAdmin); }
    visible = (await api(admin, "POST", "/workspaces", { name: "Field operations" })).body.workspace;
    secret = (await api(admin, "POST", "/workspaces", { name: "Board of directors" })).body.workspace;
    for (const b of [mia, ben]) await api(admin, "POST", `/workspaces/${visible.id}/members`, { userId: (await api(b, "GET", "/me")).body.user.id, role: "MEMBER" });
    jobs = (await api(admin, "POST", `/workspaces/${visible.id}/boards`, { name: "Service jobs", columns: COLUMNS })).body.board;
    hidden = (await api(admin, "POST", `/workspaces/${secret.id}/boards`, { name: "Salary review", columns: COLUMNS })).body.board;
    await api(admin, "POST", `/boards/${jobs.id}/records/batch`, { records: [
      { values: { serial: "JOB-1", status: "To do", notes: "Replace zebra crossing paint", due: "2026-03-01" } },
      { values: { serial: "JOB-2", status: "Done", notes: "Inspect boiler", due: "2026-01-15" } },
      { values: { serial: "JOB-3", status: "To do", notes: "Archive me" } } ] });
    const schedule = (await api(admin, "POST", `/workspaces/${visible.id}/boards`, { name: "Field schedule", columns: COLUMNS })).body.board;
    await api(admin, "POST", `/boards/${schedule.id}/records`, { values: { serial: "Kestrel survey", notes: "Nest inspection on roof" } });
    await api(admin, "POST", `/boards/${hidden.id}/records/batch`, { records: [{ values: { serial: "PAY-1", notes: "zebra bonus confidential" } }] });
  });
  after(async () => { for (const b of [admin, mia, ben]) await b?.close(); server?.kill(); });

  test("compact desktop layout: records start high on the page, full width, no page-level sideways scrolling, one global search centred in the top bar", async () => {
    await openApp(mia); await openBoard(mia, "Service jobs");
    const m = await mia.evaluate(`(() => { const r = (s) => document.querySelector(s)?.getBoundingClientRect(); const top = r('.topbar'), search = r('.global-search-button'), wrap = r('.table-wrap'), main = r('main.workspace');
      return { tableTop: Math.round(wrap.top), wrapWidth: Math.round(wrap.width), mainWidth: Math.round(main.width), searchCentre: Math.round(search.left + search.width / 2), barCentre: Math.round(top.left + top.width / 2), pageOverflow: document.documentElement.scrollWidth - innerWidth,
        searchBoxes: [...document.querySelectorAll('[data-action="command-palette"]')].filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').length, breadcrumb: !!document.querySelector('.board-breadcrumb')?.getClientRects().length,
        wrapBottom: Math.round(wrap.bottom), viewport: innerHeight }; })()`);
    assert.ok(m.tableTop <= 240, `records table starts at ${m.tableTop}px (was 389px)`);
    assert.ok(m.wrapWidth >= m.mainWidth - 48, `board uses the width (${m.wrapWidth} of ${m.mainWidth})`);
    assert.ok(m.pageOverflow <= 0, "no page-level horizontal scrolling");
    assert.ok(Math.abs(m.searchCentre - m.barCentre) <= 24, `search centred (${m.searchCentre} vs ${m.barCentre})`);
    assert.equal(m.searchBoxes, 1, "one visible global search entry point");
    assert.equal(m.breadcrumb, false, "no repeated breadcrumb on desktop");
    assert.ok(m.wrapBottom <= m.viewport, "the table fits the window (it scrolls inside the board)");
    assert.equal(await mia.evaluate("getComputedStyle(document.querySelector('.editable-table thead th')).position"), "sticky", "sticky column headers");
    // Import and Export sit in the board header, top right.
    const header = await mia.evaluate("['import','export'].map((a) => { const b = document.querySelector(`.board-actions [data-action=${a}]`); return b ? [b.title.length > 0, b.getBoundingClientRect().top < 120] : null; })");
    assert.deepEqual(header, [[true, true], [true, true]]);
  });

  test("Import and Export still work from the header", async () => {
    await mia.evaluate("(() => { window.__downloads = 0; const create = URL.createObjectURL; URL.createObjectURL = (b) => { window.__downloads += 1; return create(b); }; })()");
    await click(mia, '.board-actions [data-action="export"]');
    assert.ok(await mia.waitFor("window.__downloads === 1", 3000), "a CSV download is produced");
    assert.match(await text(mia, "#toast-region") || "", /Board exported/);
    await click(mia, '.board-actions [data-action="import"]');
    assert.ok(await mia.waitFor("!!document.querySelector('.import-modal')", 2000), "the import dialog opens");
    assert.match(await text(mia, ".import-modal h2"), /Import into Service jobs/);
    await mia.key("Escape");
  });

  test("global search (Ctrl K): grouped, highlighted, with context; keyboard navigation opens the result; nothing extra is downloaded", async () => {
    await mia.evaluate("(() => { window.__requests = []; const f = window.fetch; window.fetch = (u, i) => { window.__requests.push(String(u)); return f(u, i); }; })()");
    await mia.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))");
    assert.ok(await mia.waitFor("document.activeElement?.dataset.action === 'command-search'", 2000), "Ctrl K opens search with focus in the box");
    const type = async (q) => { await mia.evaluate(`(() => { const i = document.querySelector('[data-action=command-search]'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(150); await mia.waitFor("!document.querySelector('.search-status .loading-spinner')", 5000); await sleep(100); };
    const groups = () => mia.evaluate("[...document.querySelectorAll('.command-results section')].map((s) => [s.querySelector('h3').textContent, [...s.querySelectorAll('button')].map((b) => [...b.querySelectorAll('strong, small')].map((e) => e.textContent.trim()).join(' ') || b.textContent.trim())])");
    await type("service");
    assert.deepEqual((await groups()).find(([g]) => g === "Boards"), ["Boards", ["Service jobs Field operations"]]);
    assert.equal(await mia.evaluate("document.querySelector('.command-results mark')?.textContent"), "Service", "matching text is highlighted");
    await type("site notes");
    assert.match(JSON.stringify((await groups()).find(([g]) => g === "Columns")), /Site notes.*Column · Service jobs · Field operations/, "column names, with board context");
    await type("zebra");
    const zebra = await groups();
    assert.deepEqual(zebra.find(([g]) => g === "Records"), ["Records", ["JOB-1 Site notes: Replace zebra crossing paint · Service jobs · Field operations"]], "a record found by a cell value, with context");
    assert.doesNotMatch(JSON.stringify(zebra), /PAY-1|confidential|Salary|directors/, "AUTHORISATION: nothing from a workspace Mia can't see");
    await type("directors");
    assert.equal(await mia.evaluate("document.querySelector('.command-results .search-empty')?.textContent || ''").then((t) => /No matches/.test(t)), true, "empty state");
    assert.equal(await mia.evaluate("window.__requests.filter((u) => /\\/api\\/v1\\/(boards|records|workspaces)/.test(u)).length"), 0, "typing never downloads boards or records");
    assert.ok(await mia.evaluate("window.__requests.some((u) => u.includes('/api/v1/search/global?q='))"), "it asks the Command Center search endpoint instead");
    // Keyboard: ↓ moves to the first result, Enter opens it.
    await type("JOB-2");
    await mia.key("ArrowDown"); await mia.key("Enter");
    assert.ok(await mia.waitFor("!!document.querySelector('.record-drawer')", 3000), "Enter opens the record");
    assert.equal(await mia.evaluate("[...document.querySelectorAll('.record-drawer input')].some((i) => i.value === 'JOB-2')"), true, "JOB-2's details");
    await mia.key("Escape");
  });

  test("server search: finds records on boards never opened, shows loading, no duplicates, errors with Try again, opens the record", async () => {
    await openApp(mia); await openBoard(mia, "Service jobs");
    // Slow, failing or normal answers from /search (shaped inside this page only).
    await mia.evaluate("(() => { window.__searchMode = 'slow'; const f = window.fetch; window.fetch = async (u, i) => { if (String(u).includes('/api/v1/search')) { if (window.__searchMode === 'slow') await new Promise((r) => setTimeout(r, 900)); if (window.__searchMode === 'fail') throw new TypeError('Failed to fetch'); } return f(u, i); }; })()");
    await click(mia, ".global-search-button");
    assert.ok(await mia.waitFor("!!document.querySelector('[data-action=command-search]')", 2000));
    const typeNow = (q) => mia.evaluate(`(() => { const i = document.querySelector('[data-action=command-search]'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await typeNow("kestrel");
    assert.ok(await mia.waitFor("/Searching all boards/.test(document.querySelector('.command-results').textContent)", 2000), "loading state while the server searches");
    assert.equal(await mia.evaluate("!!document.querySelector('.search-empty')"), false, "no empty state while still searching");
    assert.ok(await mia.waitFor("!document.querySelector('.search-status .loading-spinner')", 5000));
    const records = await mia.evaluate("[...document.querySelectorAll('.command-results section[aria-label=Records] button[data-action=palette-record]')].map((b) => [...b.querySelectorAll('strong, small')].map((e) => e.textContent.trim()).join(' '))");
    assert.equal(records.length, 1);
    assert.match(records[0], /Kestrel survey.*Field schedule.*Field operations/, "a record on a board never opened, with its board and workspace");
    assert.match(await mia.evaluate("document.querySelector('.command-scope').textContent"), /all your boards/);
    // No duplicates: JOB-1 is found both in this browser (loaded board) and by the server.
    await mia.evaluate("window.__searchMode = 'normal'");
    await typeNow("zebra crossing");
    assert.ok(await mia.waitFor("!document.querySelector('.search-status .loading-spinner') && !!document.querySelector('section[aria-label=Records]')", 5000));
    await sleep(300);
    assert.equal(await mia.evaluate("document.querySelectorAll('section[aria-label=Records] [data-action=palette-record]').length"), 1, "listed once");
    assert.doesNotMatch(await mia.evaluate("document.querySelector('.command-results').textContent"), /PAY-1|confidential/, "AUTHORISATION: nothing from another workspace");
    // A failure: a clear message and Try again (results from this browser stay).
    await mia.evaluate("window.__searchMode = 'fail'");
    await typeNow("kestrel s");
    assert.ok(await mia.waitFor("!!document.querySelector('.search-status.is-error [data-action=search-retry]')", 5000), "error with Try again");
    await mia.evaluate("window.__searchMode = 'normal'");
    await click(mia, ".search-status [data-action=search-retry]");
    assert.ok(await mia.waitFor("/Kestrel survey/.test(document.querySelector('.command-results').textContent) && !document.querySelector('.search-status.is-error')", 5000), "Try again recovers");
    // Opening it: the board loads, then the record opens.
    await click(mia, "section[aria-label=Records] [data-action=palette-record]");
    assert.ok(await mia.waitFor("document.querySelector('h1 input')?.value === 'Field schedule' && !!document.querySelector('.record-drawer')", 8000), "board opened and record shown");
    assert.equal(await mia.evaluate("[...document.querySelectorAll('.record-drawer input')].some((i) => i.value === 'Kestrel survey')"), true);
    await mia.key("Escape");
  });

  // ---- Views = column configurations of the same board (Main Table + custom views), Display columns popover.
  const shownColumns = (b) => b.evaluate("[...document.querySelectorAll('.editable-table thead th[data-column-key]')].map((th) => th.dataset.columnKey)");
  const openPicker = async (b) => { await click(b, '.board-tools [data-action="column-picker"]'); assert.ok(await b.waitFor("!!document.querySelector('.column-picker')", 2000), "Display columns opens"); };
  const toggleColumn = (b, key) => b.evaluate(`(() => { const box = document.querySelector('.column-picker [data-action=column-toggle][data-key=${key}]'); box.focus(); box.click(); return box.checked; })()`);
  const recordCount = async () => (await api(mia, "GET", `/boards/${jobs.id}/records?limit=200`)).body.items.length;
  const viewByName = async (name) => (await savedViews()).find((v) => v.name === name);
  const waitSaved = async (b) => { assert.ok(await b.waitFor("document.querySelector('.save-state')?.dataset.state !== 'saving'", 5000)); await sleep(400); };

  test("Main Table shows every column; a new view starts from it, shows the same records (nothing copied) and gets its own tab", async () => {
    await openApp(mia); await openBoard(mia, "Service jobs");
    assert.deepEqual(await tabs(mia), ["Main Table"], "only Main Table by default (no permanent List/Board/Calendar/Archived tabs)");
    assert.deepEqual(await shownColumns(mia), COLUMNS.map((c) => c.key), "Main Table shows all board columns");
    const before = await recordCount();
    await createView(mia, "table", "Sales view");
    assert.deepEqual(await tabs(mia), ["Main Table", "Sales view"]);
    assert.ok(await mia.waitFor("!!document.querySelector('.editable-table')", 2000), "a new view is a table (no layout choice needed)");
    assert.deepEqual(await shownColumns(mia), COLUMNS.map((c) => c.key), "it starts with Main Table's columns");
    await waitSaved(mia);
    assert.equal(await recordCount(), before, "no records were duplicated");
    assert.deepEqual((await viewByName("Sales view")).state.hiddenColumns, []);
  });

  test("Display columns: searchable, per-column checkboxes, All columns, count; hiding affects only the active view; Save to this view persists", async () => {
    await openPicker(mia);
    assert.match(await text(mia, ".column-picker-count"), /6 of 6 columns shown/);
    assert.equal(await mia.evaluate("document.querySelector('.column-picker [data-key=serial]').disabled"), true, "Item is always shown");
    await mia.evaluate("(() => { const i = document.querySelector('[data-action=column-picker-search]'); i.value = 'fil'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    assert.deepEqual(await mia.evaluate("[...document.querySelectorAll('.column-pick-list [data-action=column-toggle]')].map((b) => b.dataset.key)"), ["docs"], "search narrows the list");
    assert.equal(await toggleColumn(mia, "docs"), false);
    assert.ok(await mia.waitFor("!document.querySelector('th[data-column-key=docs]')", 2000), "Files disappears at once in this view");
    assert.match(await text(mia, ".column-picker-count"), /5 of 6 columns shown/);
    assert.equal(await mia.evaluate("!!document.querySelector('.column-picker')"), true, "the popover stays open");
    assert.equal(await mia.evaluate("document.activeElement?.dataset.key"), "docs", "keyboard focus stays on the checkbox");
    assert.ok(await mia.waitFor("!!document.querySelector('.column-picker [data-action=save-active-view]')", 2000), "unsaved changes are clear: Save to this view");
    assert.match(await text(mia, ".board-tools [data-action=column-picker]"), /1 hidden/);
    assert.equal((await viewByName("Sales view")).state.hiddenColumns.length, 0, "not saved until asked");
    await click(mia, '.column-picker [data-action="save-active-view"]');
    await waitSaved(mia);
    assert.deepEqual((await viewByName("Sales view")).state.hiddenColumns, ["docs"], "saved on the board's view");
    assert.match(await text(mia, "#toast-region") || "", /View saved/);
    // Main Table still has Files; the column and its data still exist on the board.
    await click(mia, '[data-action="main-table"]');
    assert.ok(await mia.waitFor("!!document.querySelector('th[data-column-key=docs]')", 2000), "Main Table still shows Files");
    const board = (await api(mia, "GET", `/boards/${jobs.id}`)).body.board;
    assert.equal(board.columns.find((c) => c.key === "docs").visible, true, "the board's column is untouched");
  });

  test("independent views: Finance hides other columns; switching restores each view's columns, filters and sorting; reload keeps them", async () => {
    await createView(mia, "table", "Finance view");
    await openPicker(mia);
    for (const key of ["notes", "due"]) await toggleColumn(mia, key);
    // Status filter: the toolbar's themed menu (Phase 8 replaced the native select).
    await click(mia, '[data-action="toolbar-menu"][data-menu="filter"]');
    assert.ok(await mia.waitFor("!!document.querySelector('.toolbar-menu-popover [data-value=Done]')", 3000));
    await click(mia, '.toolbar-menu-popover [data-value="Done"]');
    await sleep(300);
    await click(mia, '[data-action="save-active-view"]');
    await waitSaved(mia);
    const finance = await viewByName("Finance view");
    assert.deepEqual(finance.state.hiddenColumns, ["due", "notes"]);
    assert.equal(finance.state.status, "Done", "the filter is saved with the view");
    const switchTo = async (name) => { await mia.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((t) => t.textContent.trim() === ${JSON.stringify(name)})?.click()`); await sleep(350); };
    await switchTo("Sales view");
    assert.deepEqual(await shownColumns(mia), ["serial", "status", "notes", "done", "due"], "Sales: everything but Files");
    assert.equal(await mia.evaluate("document.querySelector('[data-action=toolbar-menu][data-menu=filter]').dataset.status"), "All", "Sales has no status filter");
    await switchTo("Finance view");
    assert.deepEqual(await shownColumns(mia), ["serial", "status", "done", "docs"], "Finance: its own columns");
    assert.equal(await mia.evaluate("document.querySelector('[data-action=toolbar-menu][data-menu=filter]').dataset.status"), "Done");
    await switchTo("Main Table");
    assert.deepEqual(await shownColumns(mia), COLUMNS.map((c) => c.key), "Main Table: all columns, no filter");
    assert.equal(await mia.evaluate("document.querySelector('[data-action=toolbar-menu][data-menu=filter]').dataset.status"), "All");
    // After a reload (a new session in the same browser) everything is still there.
    await openApp(mia); await openBoard(mia, "Service jobs");
    assert.deepEqual(await tabs(mia), ["Main Table", "Sales view", "Finance view"]);
    await switchTo("Finance view");
    assert.deepEqual(await shownColumns(mia), ["serial", "status", "done", "docs"]);
    // A colleague sees the same views and configurations.
    await openApp(ben); await openBoard(ben, "Service jobs");
    assert.deepEqual(await tabs(ben), ["Main Table", "Sales view", "Finance view"]);
  });

  test("hidden columns keep their data and files; a new board column appears in every view", async () => {
    const job1 = (await api(mia, "GET", `/boards/${jobs.id}/records?limit=50`)).body.items.find((r) => r.values.serial === "JOB-1");
    const uploaded = await mia.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1/records/${job1.id}/attachments?column=docs", { method: "POST", headers: { "Content-Type": "application/pdf", "X-File-Name": "quote.pdf", "X-CSRF-Token": csrfToken }, body: "%PDF-1.4 test" }); return r.status; })()`);
    assert.equal(uploaded, 201);
    // Sales hides Files and Finance hides notes: data and attachments are all still there.
    assert.equal((await api(mia, "GET", `/records/${job1.id}`)).body.record.values.notes, "Replace zebra crossing paint");
    assert.equal((await api(mia, "GET", `/records/${job1.id}/attachments`)).body.items.length, 1, "the attachment is intact");
    // A new column (added by anyone) appears in Main Table and in every view (views list what they hide).
    const b = (await api(mia, "GET", `/boards/${jobs.id}`)).body.board;
    assert.equal((await api(mia, "POST", `/boards/${jobs.id}/columns`, { expectedVersion: b.version, column: { key: "region", label: "Region", type: "text" } })).status, 201);
    await openApp(mia); await openBoard(mia, "Service jobs");
    assert.ok((await shownColumns(mia)).includes("region"), "Main Table shows the new column");
    for (const name of ["Sales view", "Finance view"]) {
      await mia.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((t) => t.textContent.trim() === ${JSON.stringify(name)})?.click()`); await sleep(300);
      assert.ok((await shownColumns(mia)).includes("region"), `${name} shows the new column`);
    }
    // The Files cell still shows the file in Main Table.
    await click(mia, '[data-action="main-table"]');
    assert.ok(await mia.waitFor("document.querySelectorAll('td[data-column-key=docs] .file-thumb').length === 1", 5000), "the file is still shown where Files is visible");
  });

  test("views can be renamed, duplicated and deleted; Main Table can't be deleted", async () => {
    await mia.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((t) => t.textContent.trim() === "Sales view")?.click()`); await sleep(300);
    await click(mia, '.view-tab.active [data-action="view-menu"]');
    await click(mia, '.view-menu [data-action="duplicate-view"]');
    await sleep(400);
    assert.deepEqual(await tabs(mia), ["Main Table", "Sales view", "Finance view", "Sales view copy"]);
    assert.equal((await shownColumns(mia)).includes("docs"), false, "the copy keeps Sales' columns (no Files)");
    assert.equal((await shownColumns(mia)).includes("notes"), true);
    await click(mia, '.view-tab.active [data-action="view-menu"]');
    await click(mia, '.view-menu [data-action="rename-view"]');
    assert.ok(await mia.waitFor("!!document.querySelector('form[data-action=rename-view-form]')", 2000));
    await mia.evaluate("document.querySelector('form[data-action=rename-view-form] input[name=name]').value = 'Sales (north)'");
    await click(mia, 'form[data-action="rename-view-form"] .button.primary');
    await sleep(300);
    assert.deepEqual(await tabs(mia), ["Main Table", "Sales view", "Finance view", "Sales (north)"]);
    await click(mia, '.view-tab.active [data-action="view-menu"]');
    await click(mia, '.view-menu [data-action="request-delete-view"]');
    assert.ok(await mia.waitFor("!!document.querySelector('[data-action=\"confirm-delete-view\"]')", 2000), "deleting asks first");
    await click(mia, '[data-action="confirm-delete-view"]');
    await waitSaved(mia);
    assert.deepEqual(await tabs(mia), ["Main Table", "Sales view", "Finance view"]);
    assert.equal(await mia.evaluate("document.querySelector('.view-tab.active')?.textContent.trim()"), "Main Table", "back to Main Table");
    assert.equal(await mia.evaluate("!!document.querySelector('.view-tabs .view-tab:first-child [data-action=view-menu]')"), false, "Main Table has no delete/rename menu");
    assert.deepEqual((await savedViews()).map((v) => v.name), ["Sales view", "Finance view"]);
    assert.ok(await ben.waitFor("[...document.querySelectorAll('.view-tabs [role=tab]')].map((t) => t.textContent.trim()).join('|') === 'Main Table|Sales view|Finance view'", 10000), "a colleague's tabs update live");
  });

  test("AUTHORISATION: a viewer can look at views but can't change shared views; nothing is saved for them", async () => {
    const vic = await launch(BROWSER);
    try {
      await vic.open(`${base}/api/v1/health`, { width: 1440 });
      await vic.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=0d0d0d0d-0000-4000-8000-000000000044&name=Vic%20Viewer&email=vic@example.invalid&nonce=" + s.nonce)).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); })()`);
      await api(admin, "POST", `/workspaces/${visible.id}/members`, { userId: (await api(vic, "GET", "/me")).body.user.id, role: "VIEWER" });
      const before = await savedViews();
      const b = (await api(vic, "GET", `/boards/${jobs.id}`)).body.board;
      assert.equal((await api(vic, "PATCH", `/boards/${jobs.id}`, { expectedVersion: b.version, savedViews: [] })).status, 403, "the API refuses a viewer's change to views");
      await openApp(vic); await openBoard(vic, "Service jobs");
      assert.deepEqual(await tabs(vic), ["Main Table", "Sales view", "Finance view"], "a viewer sees the views");
      await vic.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((t) => t.textContent.trim() === "Sales view")?.click()`); await sleep(300);
      await openPicker(vic); await toggleColumn(vic, "status");
      await click(vic, '.column-picker [data-action="save-active-view"]');
      await sleep(1200);
      assert.deepEqual(await savedViews(), before, "shared views unchanged on the server");
    } finally { await vic.close(); }
  });

  test("each view restores its own saved sorting (and Main Table keeps its own)", async () => {
    await openApp(mia); await openBoard(mia, "Service jobs");
    const switchTo = async (name) => { await mia.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((t) => t.textContent.trim() === ${JSON.stringify(name)})?.click()`); await sleep(350); };
    const order = () => mia.evaluate("[...document.querySelectorAll('.editable-table tbody tr[data-record-context] td[data-column-key=serial]')].map((td) => td.textContent.trim()).filter((t) => /^JOB-[12]$/.test(t))");
    await switchTo("Main Table");
    const mainOrder = await order();
    assert.deepEqual(mainOrder, ["JOB-1", "JOB-2"], "Main Table's own order differs from a sort by Due (so the check below proves the view's sorting)");
    await switchTo("Sales view");
    await click(mia, '.board-tools [data-action="sort"]');
    assert.ok(await mia.waitFor("!!document.querySelector('form[data-action=sort-form]')", 2000));
    await mia.evaluate("(() => { const f = document.querySelector('form[data-action=sort-form]'); f.querySelector('[name=key]').value = 'due'; f.querySelector('[name=direction]').value = 'asc'; })()");
    await click(mia, 'form[data-action="sort-form"] .button.primary');
    await sleep(400);
    assert.deepEqual(await order(), ["JOB-2", "JOB-1"], "sorted by Due, earliest first");
    await click(mia, '[data-action="save-active-view"]');
    await waitSaved(mia);
    const sales = (await viewByName("Sales view")).state;
    assert.deepEqual([sales.sortKey, sales.sortDirection], ["due", "asc"], "saved with the view");
    assert.equal((await viewByName("Finance view")).state.sortKey, "", "Finance keeps its own (none)");
    await switchTo("Main Table");
    assert.deepEqual(await order(), mainOrder, "Main Table keeps its own order");
    await switchTo("Sales view");
    assert.deepEqual(await order(), ["JOB-2", "JOB-1"], "switching back restores the view's sorting");
    await openApp(mia); await openBoard(mia, "Service jobs"); await switchTo("Sales view");
    assert.deepEqual(await order(), ["JOB-2", "JOB-1"], "and after reloading");
  });

  test("archived records: reached from the board's More menu (and + Views); restore still works", async () => {
    const rec = (await api(mia, "GET", `/boards/${jobs.id}/records?limit=50`)).body.items.find((r) => r.values.serial === "JOB-3");
    await api(mia, "PATCH", `/records/${rec.id}`, { expectedVersion: rec.version, archived: true });
    await openApp(mia); await openBoard(mia, "Service jobs");
    await click(mia, '.board-actions [data-action="board-menu"]');
    assert.ok(await mia.waitFor("!!document.querySelector('.board-popover [data-action=\"archived-view\"]')", 2000), "Archived records in the board menu");
    await click(mia, '.board-popover [data-action="archived-view"]');
    assert.ok(await mia.waitFor("!!document.querySelector('.archived-tab')", 2000), "an Archived records tab appears");
    assert.match(await mia.evaluate("document.querySelector('.board-view-region').textContent"), /JOB-3/, "the archived record is listed");
    await click(mia, '.archived-tab [data-action="main-table"]');
    assert.ok(await mia.waitFor("!document.querySelector('.archived-tab')", 2000));
    assert.doesNotMatch(await mia.evaluate("document.querySelector('.board-view-region').textContent"), /JOB-3/, "Main Table hides archived records");
    await click(mia, '[data-action="views-menu"]');
    assert.ok(await mia.waitFor("!!document.querySelector('.views-menu [data-action=\"archived-view\"]')", 2000), "also in + Views");
    await mia.key("Escape");
  });

  test("columns: sensible default widths by type; resizing (keyboard) is saved on the board", async () => {
    await openApp(mia); await openBoard(mia, "Service jobs");
    const widths = await mia.evaluate("Object.fromEntries([...document.querySelectorAll('.editable-table thead th[data-column-key]')].map((th) => [th.dataset.columnKey, Math.round(th.getBoundingClientRect().width)]))");
    assert.ok(widths.done <= 110, `checkbox column is narrow (${widths.done})`);
    assert.ok(widths.serial >= 240, `item column is wide (${widths.serial})`);
    await mia.evaluate("document.querySelector('th[data-column-key=notes] .column-resizer').focus()");
    await mia.key("ArrowRight", "ArrowRight");
    await sleep(800);
    assert.equal((await api(mia, "GET", `/boards/${jobs.id}`)).body.board.columns.find((c) => c.key === "notes").width, 240, "220 (default for text) + 20, saved");
  });

  test("reduced motion comes from the device setting only; essential feedback stays; there is no Animations setting", async () => {
    await mia.motionPreference("reduce");
    await click(mia, 'th[data-column-key="status"] .column-menu-button');
    assert.equal(await mia.evaluate("getComputedStyle(document.querySelector('.column-menu-popover')).animationName"), "none");
    await mia.key("Escape");
    await mia.motionPreference("no-preference");
    await click(mia, 'th[data-column-key="status"] .column-menu-button');
    assert.notEqual(await mia.evaluate("getComputedStyle(document.querySelector('.column-menu-popover')).animationName"), "none", "animations on by default");
    await mia.key("Escape");
    await click(mia, '[data-action="settings"]');
    await mia.waitFor("!!document.querySelector('[data-action=\"settings-section\"][data-section=\"appearance\"]')", 3000);
    await click(mia, '[data-action="settings-section"][data-section="appearance"]');
    await sleep(300);
    assert.equal(await mia.evaluate("!!document.querySelector('[data-action=motion-preference]') || /Reduce motion|Full animations/.test(document.querySelector('#overlay-root').textContent)"), false, "no animation setting");
    await mia.key("Escape");
  });
});
