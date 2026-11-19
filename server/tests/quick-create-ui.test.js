// Quick record creation in the REAL app (New record → type a name → Enter), in a headless browser against the test Entra server
// configured as in production (shared workspaces, beta open editing; fake MongoDB, synthetic data). The person creating records is
// an ordinary employee with no membership and no administrator role. Desktop and phone. Skipped without Chrome or Edge.
// QC_PERF=1 also measures bigger boards and prints the timings: QC_SIZES (record counts, comma-separated; default 100,160,2500,5000),
// QC_COLUMNS (columns per board; default 100) and QC_CPU (CPU slowdown factor; default 1). Synthetic names and data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const DESKTOP = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
const OWNER = "0e7e7e7e-0000-4000-8000-0000000000f1", EMPLOYEE = "0e7e7e7e-0000-4000-8000-0000000000f2";
// Shaped like a large imported product board: the Name, business identifiers kept as plain text, and many other text columns.
const COLUMN_COUNT = Math.max(30, Number(process.env.QC_COLUMNS || 100));
const COLUMNS = [{ key: "serial", label: "Name", type: "text", required: true }, { key: "col_1", label: "Unique ID", type: "text" }, { key: "col_5", label: "Legacy Product Code", type: "text" }, { key: "col_6", label: "ERP Item ID", type: "text" }, { key: "col_8", label: "Accounting ID", type: "text" },
  ...Array.from({ length: COLUMN_COUNT - 5 }, (_, i) => ({ key: `col_${i + 10}`, label: `Field ${i + 10}`, type: "text" }))];
const GROUPS = [{ name: "Incoming" }, { name: "Current" }, { name: "Retired" }];
const SIZES = String(process.env.QC_SIZES || "100,160,2500,5000").split(",").map(Number).filter((n) => n > 0);

describe("Quick record creation (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, wsId;
  const boards = {};
  const signIn = (oid, name) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${oid}&name=${encodeURIComponent(name)}&email=${oid}@example.invalid&admin=0&nonce=" + encodeURIComponent(s.nonce))).json(); const r = await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); return r.status; })()`);
  const api = (method, url, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return JSON.stringify({ status: r.status, body: await r.json().catch(() => null) }); })()`).then(JSON.parse);
  const has = (sel) => b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  const text = (sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent || ""`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const wait = (expr, ms = 10000) => b.waitFor(expr, ms);
  const type = (value) => b.send("Input.insertText", { text: value });
  const noSidewaysScroll = () => b.evaluate("document.documentElement.scrollWidth <= window.innerWidth");
  const records = async (boardId) => { const all = []; let cursor = ""; do { const page = await api("GET", `/api/v1/boards/${boardId}/records?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); all.push(...page.body.items); cursor = page.body.pagination?.nextCursor || ""; } while (cursor); return all; };
  const named = async (boardId, name) => (await records(boardId)).filter((r) => r.values.serial === name);
  const makeBoard = async (name, count) => {
    const board = (await api("POST", `/api/v1/workspaces/${wsId}/boards`, { name, columns: COLUMNS, groups: GROUPS })).body.board;
    for (let i = 0; i < count; i += 2000) {
      const rows = Array.from({ length: Math.min(2000, count - i) }, (_, j) => { const n = i + j; return { values: { serial: `Product ${String(n).padStart(5, "0")}`, col_1: `U-${100000 + n}`, col_5: `NP-${n}`, col_6: `ERP${n}`, col_8: `AC-${n}`, col_12: `Supplier ${n % 40}`, col_20: `Box of ${1 + (n % 12)}` }, groupId: board.groups[n % 2].id }; });
      const res = await api("POST", `/api/v1/boards/${board.id}/records/batch`, { records: rows });
      assert.equal(res.status, 201, `seed ${name}: ${JSON.stringify(res.body).slice(0, 200)}`);
    }
    return board;
  };
  // Loading waits grow with the CPU throttling the measurements use (QC_CPU), so a slowed-down page isn't mistaken for a failure.
  const SLOW = Math.max(1, Number(process.env.QC_CPU || 1));
  const openBoard = async (board, viewport = DESKTOP) => {
    await b.open(`${base}/`, viewport);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 20000 * SLOW), "app loaded");
    await b.evaluate(`(() => { const el = [...document.querySelectorAll("#sidebar .tree-item, #sidebar button, #sidebar a")].find((e) => e.textContent.trim().startsWith(${JSON.stringify(board.name)})); el?.click(); })()`);
    assert.ok(await wait(`document.querySelector(".board-title-input, .board-head h1")?.value === ${JSON.stringify(board.name)} || document.querySelector(".board-head")?.textContent.includes(${JSON.stringify(board.name)})`, 20000 * SLOW), `${board.name} opens`);
    assert.ok(await wait("!!document.querySelector('[data-action=\"open-form\"]') && !document.querySelector('.board-view-region [aria-busy=\"true\"]')", 30000 * SLOW), "records loaded");
  };
  const openQuickCreate = async () => {
    assert.ok(await click('.board-tools [data-action="open-form"], [data-action="open-form"]'), "New record button");
    assert.ok(await wait("!!document.querySelector('form.quick-create-modal')", 5000), "the quick create dialog opens");
  };
  const rowShown = (name) => `[...document.querySelectorAll("tr[data-record-context]")].some((tr) => tr.textContent.includes(${JSON.stringify(name)}))`;

  before(async () => {
    const port = await freePort(); base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore", env: { ...process.env, JARC_TEST_BETA: "1", JARC_TEST_API_TOKENS: "1", JARC_TEST_API_ADMINS: OWNER } });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER);
    await b.motionPreference("reduce");
    await b.open(`${base}/api/v1/health`, DESKTOP);
    // Another employee owns the workspace and the board; the person creating records later is a member of nothing.
    assert.equal(await signIn(OWNER, "Olga Owner"), 201);
    wsId = (await api("POST", "/api/v1/workspaces", { name: "Product Space" })).body.workspace.id;
    boards.main = await makeBoard("Products", 60);
    assert.equal(await signIn(EMPLOYEE, "Emil Employee"), 201);
  });
  after(async () => { await b?.close(); server?.kill(); });

  test("New record asks only for the name: Enter creates it in the chosen group, with a server Record ID and empty optional columns", async () => {
    await openBoard(boards.main);
    await openQuickCreate();
    const dialog = JSON.parse(await b.evaluate(`JSON.stringify((() => { const f = document.querySelector("form.quick-create-modal"); return { focused: document.activeElement === f.elements.serial, inputs: f.querySelectorAll("input:not([type=hidden]), select, textarea").length, groups: [...f.elements.group.options].map((o) => o.value), chosen: f.elements.group.value, drawer: !!document.querySelector(".record-drawer") }; })())`));
    assert.equal(dialog.focused, true, "the Name has focus");
    assert.equal(dialog.inputs, 2, "only the name and the group, not 105 other columns");
    assert.deepEqual(dialog.groups, ["Incoming", "Current", "Retired"]);
    assert.equal(dialog.chosen, "Incoming", "the board's usual default: its first active group");
    assert.equal(dialog.drawer, false);
    await b.evaluate(`document.querySelector("form.quick-create-modal").elements.group.value = "Current"`);
    await b.evaluate(`document.querySelector("form.quick-create-modal").elements.serial.focus()`);
    await type("  Centrifuge Rotor 24 × 2 mL  ");
    await b.key("Enter");
    assert.ok(await wait("!document.querySelector('form.quick-create-modal')", 8000), "the dialog closes once it's saved");
    assert.ok(await wait(rowShown("Centrifuge Rotor 24 × 2 mL"), 5000), "the record is on the board");
    assert.match(await text("#toast-region"), /Created “Centrifuge Rotor 24 × 2 mL”/);
    const [made] = await named(boards.main.id, "Centrifuge Rotor 24 × 2 mL");
    assert.ok(made, "stored, with the name trimmed");
    assert.match(made.id, /^[0-9a-f]{24}$/);
    assert.equal(made.groupId, boards.main.groups[1].id, "in the group chosen");
    for (const key of ["col_1", "col_5", "col_6", "col_8", "col_20"]) assert.equal(made.values[key], "", `${key} left empty, never generated`);
    // Its Record ID is shown on its row, and its group count went up.
    assert.ok(await wait(`[...document.querySelectorAll("tr[data-record-context]")].some((tr) => tr.textContent.includes("Centrifuge Rotor") && tr.querySelector("td.record-id-cell")?.textContent.includes(${JSON.stringify(made.id)}))`, 5000), "the server's Record ID on the row");
    const counts = await b.evaluate(`JSON.stringify([...document.querySelectorAll(".group-header")].map((h) => h.textContent.replace(/\\s+/g, " ").trim()))`);
    assert.match(counts, /Current[^"]*31 records/, `Current went from 30 to 31: ${counts}`);
  });

  test("the new record can be edited straight away, in the table and in the full record", async () => {
    const [made] = await named(boards.main.id, "Centrifuge Rotor 24 × 2 mL");
    const toastOpen = await b.evaluate(`(() => { const btn = [...document.querySelectorAll("#toast-region button")].find((x) => x.textContent === "Open"); btn?.click(); return Boolean(btn); })()`);
    if (!toastOpen) await click(`[data-action="edit"][data-id="${made.id}"]`);
    assert.ok(await wait("!!document.querySelector('form.record-drawer')", 5000), "the full record opens from the toast");
    await b.evaluate(`(() => { const f = document.querySelector("form.record-drawer"); f.elements.col_6.value = "ERP-NEW-1"; f.elements.col_20.value = "Pack of 2"; f.requestSubmit(); })()`);
    assert.ok(await wait("!document.querySelector('form.record-drawer')", 8000));
    let saved = null;
    for (let i = 0; i < 40 && !saved; i++) { const [r] = await named(boards.main.id, "Centrifuge Rotor 24 × 2 mL"); if (r?.values.col_6 === "ERP-NEW-1") saved = r; else await new Promise((res) => setTimeout(res, 100)); }
    assert.ok(saved, "the edit was saved");
    assert.equal(saved.values.col_20, "Pack of 2");
    assert.equal(saved.id, made.id, "the same record");
  });

  test("an empty or whitespace name is explained and nothing is sent; Escape cancels and creates nothing", async () => {
    const before = (await records(boards.main.id)).length;
    await openQuickCreate();
    await type("    ");
    await b.key("Enter");
    assert.match(await text("form.quick-create-modal .quick-create-error"), /Type a name/);
    assert.ok(await has("form.quick-create-modal"), "still open");
    await b.key("Escape");
    assert.ok(await wait("!document.querySelector('form.quick-create-modal')", 3000), "Escape closes it");
    await openQuickCreate();
    await type("Typed then cancelled");
    await b.key("Escape");
    assert.ok(await wait("!document.querySelector('form.quick-create-modal')", 3000));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await records(boards.main.id)).length, before, "nothing was created");
    assert.equal(await b.evaluate(rowShown("Typed then cancelled")), false);
  });

  test("pressing Enter repeatedly creates exactly one record", async () => {
    await openQuickCreate();
    await type("Only once please");
    // Three submissions in the same moment, then a fourth by keyboard.
    await b.evaluate(`(() => { const f = document.querySelector("form.quick-create-modal"); f.requestSubmit(); f.requestSubmit(); f.requestSubmit(); return document.querySelector('[data-role="quick-create-submit"]')?.disabled; })()`);
    await b.key("Enter");
    assert.ok(await wait("!document.querySelector('form.quick-create-modal')", 8000));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await named(boards.main.id, "Only once please")).length, 1);
  });

  test("when saving fails, the dialog says so and keeps the name; the record isn't left on the board; trying again works", async () => {
    await openQuickCreate();
    // The next record creation fails once at the network level, as a dropped connection would.
    await b.evaluate(`(() => { const real = window.fetch; window.__failed = false; window.__calls = []; window.fetch = function (url, init) { const u = String(url?.url || url), m = String(init?.method || url?.method || "GET").toUpperCase(); window.__calls.push(m + " " + u.replace(location.origin, "")); if (!window.__failed && m === "POST" && /\\/boards\\/[0-9a-f]{24}\\/records(\\/batch)?(\\?|$)/.test(u)) { window.__failed = true; return Promise.reject(new TypeError("Failed to fetch")); } return real.apply(this, arguments); }; return true; })()`);
    await type("Network hiccup record");
    await b.key("Enter");
    const explained = await wait(`/wasn't created/.test(document.querySelector("form.quick-create-modal .quick-create-error")?.textContent || "")`, 15000);
    assert.ok(explained, `the failure is explained: ${JSON.stringify(await b.evaluate(`JSON.stringify({ error: document.querySelector("form.quick-create-modal .quick-create-error")?.textContent, open: !!document.querySelector("form.quick-create-modal"), failed: window.__failed, calls: window.__calls.slice(-8), connection: window.jarcStorage?.connection })`))}`);
    assert.equal(await b.evaluate(`document.querySelector("form.quick-create-modal").elements.serial.value`), "Network hiccup record", "what was typed is kept");
    assert.equal(await b.evaluate(`document.querySelector('[data-role="quick-create-submit"]').disabled`), false, "and it can be sent again");
    assert.ok(await wait(`!${rowShown("Network hiccup record")}`, 5000), "the optimistic row was taken back");
    assert.equal((await named(boards.main.id, "Network hiccup record")).length, 0, "nothing stored");
    // Retry from the same dialog.
    await b.evaluate(`document.querySelector("form.quick-create-modal").elements.serial.focus()`);
    await b.key("Enter");
    assert.ok(await wait("!document.querySelector('form.quick-create-modal')", 15000), "the second try saves");
    assert.equal((await named(boards.main.id, "Network hiccup record")).length, 1);
  });

  test("the board keeps its scroll position and focus returns to the page; More fields… carries the name to the full form", async () => {
    await openBoard(boards.main);
    const scroller = `(() => { const c = [document.querySelector(".table-wrap"), document.querySelector(".workspace"), document.scrollingElement].filter(Boolean); return c.find((el) => el.scrollHeight > el.clientHeight + 50) || document.scrollingElement; })()`;
    await b.evaluate(`(() => { const s = ${scroller}; s.scrollTop = 600; return s.scrollTop; })()`);
    const before = await b.evaluate(`${scroller}.scrollTop`);
    assert.ok(before > 100, `the board scrolls (${before})`);
    await openQuickCreate();
    await type("Keep my place");
    await b.key("Enter");
    assert.ok(await wait("!document.querySelector('form.quick-create-modal')", 8000));
    await new Promise((r) => setTimeout(r, 300));
    const after = await b.evaluate(`${scroller}.scrollTop`);
    assert.ok(Math.abs(after - before) <= 2, `scroll kept: ${before} → ${after}`);
    // More fields: the full form, with the name already typed and the group chosen.
    await openQuickCreate();
    await type("Needs the full form");
    await b.evaluate(`document.querySelector("form.quick-create-modal").elements.group.value = "Retired"`);
    await click('form.quick-create-modal [data-action="quick-create-more"]');
    assert.ok(await wait("!!document.querySelector('form.record-drawer')", 5000), "the full form opens");
    assert.equal(await b.evaluate(`document.querySelector("form.record-drawer").elements.serial.value`), "Needs the full form");
    await b.evaluate(`(() => { const f = document.querySelector("form.record-drawer"); f.elements.col_5.value = "NP-FULL"; f.requestSubmit(); })()`);
    assert.ok(await wait("!document.querySelector('form.record-drawer')", 8000));
    let full = [];
    for (let i = 0; i < 40 && !full.length; i++) { full = await named(boards.main.id, "Needs the full form"); if (!full.length) await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(full.length, 1);
    assert.deepEqual([full[0].values.col_5, full[0].groupId], ["NP-FULL", boards.main.groups[2].id], "the full form kept the chosen group");
  });

  test("a board with a required column asks for just that column, and the rule still holds", async () => {
    const strict = (await api("POST", `/api/v1/workspaces/${wsId}/boards`, { name: "Strict board", columns: [{ key: "serial", label: "Name", type: "text", required: true }, { key: "code", label: "Supplier code", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["New", "Done"], defaultValue: "New" }, ...COLUMNS.slice(5, 30)], groups: GROUPS })).body.board;
    await openBoard(strict);
    await openQuickCreate();
    const fields = await b.evaluate(`JSON.stringify([...document.querySelectorAll("form.quick-create-modal [name]")].map((x) => x.name))`);
    assert.deepEqual(JSON.parse(fields), ["serial", "group", "code"], "the name, the group and the one required column without a default");
    await type("Strict one");
    await b.key("Enter");
    assert.match(await text("form.quick-create-modal .quick-create-error"), /Supplier code is required/);
    await b.evaluate(`(() => { const f = document.querySelector("form.quick-create-modal"); f.elements.code.value = "SC-9"; f.requestSubmit(); })()`);
    assert.ok(await wait("!document.querySelector('form.quick-create-modal')", 8000));
    const [made] = await named(strict.id, "Strict one");
    assert.deepEqual([made.values.code, made.values.status], ["SC-9", "New"], "the required value, and the column's default");
    // The group's own "+ Add record" row also asks through the same dialog on this board (it can't be saved by name alone).
    await click('.quick-add-row [data-action="inline-add"]');
    assert.ok(await wait("!!document.querySelector('form.quick-create-modal [name=code]')", 5000), "inline add opens quick create here");
    await b.key("Escape");
  });

  test("a filter that hides the new record says so instead of looking like a failure", async () => {
    await openBoard(boards.main);
    await b.evaluate(`(() => { const s = document.querySelector("#board-search, .board-tools input[type=search]"); s.value = "Product 0001"; s.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await new Promise((r) => setTimeout(r, 600));
    await openQuickCreate();
    await type("Hidden by the search");
    await b.key("Enter");
    assert.ok(await wait("!document.querySelector('form.quick-create-modal')", 8000));
    assert.ok(await wait(`/current search or filters hide it/.test(document.querySelector("#toast-region")?.textContent || "")`, 3000), "explained");
    assert.equal((await named(boards.main.id, "Hidden by the search")).length, 1, "created all the same");
    await b.evaluate(`(() => { const btn = [...document.querySelectorAll("#toast-region button")].find((x) => x.textContent === "Show"); btn?.click(); })()`);
    assert.ok(await wait(rowShown("Hidden by the search"), 5000), "Show clears the search and shows it");
  });

  test("phone: the dialog fits as a bottom sheet with finger-sized buttons, and creates the same way", async () => {
    await openBoard(boards.main, PHONE);
    await openQuickCreate();
    const layout = JSON.parse(await b.evaluate(`JSON.stringify((() => { const f = document.querySelector("form.quick-create-modal").getBoundingClientRect(), btn = document.querySelector('[data-role="quick-create-submit"]').getBoundingClientRect(); return { left: f.left, right: f.right, bottom: Math.round(f.bottom), height: innerHeight, width: innerWidth, button: Math.round(btn.height) }; })())`));
    assert.ok(layout.left >= -1 && layout.right <= layout.width + 1, `inside the screen: ${JSON.stringify(layout)}`);
    assert.ok(layout.bottom >= layout.height - 20, "at the bottom, like a sheet");
    assert.ok(layout.button >= 44, `finger-sized button (${layout.button}px)`);
    assert.ok(await noSidewaysScroll());
    await type("Made on a phone");
    await b.key("Enter");
    assert.ok(await wait("!document.querySelector('form.quick-create-modal')", 8000));
    assert.equal((await named(boards.main.id, "Made on a phone")).length, 1);
  });

  test("the board's existing records are unchanged by all of this", async () => {
    const seeded = (await records(boards.main.id)).filter((r) => /^Product \d{5}$/.test(r.values.serial));
    assert.equal(seeded.length, 60);
    for (const r of seeded) {
      const n = Number(r.values.serial.slice(8));
      assert.deepEqual([r.values.col_1, r.values.col_5, r.values.col_6, r.values.col_8, r.version], [`U-${100000 + n}`, `NP-${n}`, `ERP${n}`, `AC-${n}`, 1], r.values.serial);
    }
  });

  // ---- Measurements (QC_PERF=1): typing, the time until the new row is shown, and until it's saved, on bigger boards. Plain
  // numbers from this computer, printed for the report; the assertions only check that large boards stay windowed.
  for (const size of SIZES) {
    test(`timing on a board of ${size.toLocaleString("en-US")} records (${COLUMNS.length} columns)`, { skip: process.env.QC_PERF === "1" ? false : "set QC_PERF=1 to measure" }, async () => {
      const board = await (async () => { await signIn(OWNER, "Olga Owner"); const made = await makeBoard(`Perf ${size}`, size); await signIn(EMPLOYEE, "Emil Employee"); return made; })();
      await b.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.QC_CPU || 1) });
      try {
        await openBoard(board);
        const rendered = await b.evaluate(`document.querySelectorAll("tr[data-record-context]").length`);
        if (size >= 200) assert.ok(rendered < 400, `a ${size}-record board draws a window of rows, not all of them (${rendered})`);
        await openQuickCreate();
        // Typing: the longest event the browser handled per key (Event Timing), over 24 real keystrokes.
        await b.evaluate(`(() => { window.__events = []; new PerformanceObserver((l) => window.__events.push(...l.getEntries().map((e) => e.duration))).observe({ type: "event", durationThreshold: 16, buffered: false }); window.__longTasks = []; new PerformanceObserver((l) => window.__longTasks.push(...l.getEntries().map((e) => e.duration))).observe({ type: "longtask" }); return true; })()`);
        const name = `Perf record ${size}`;
        const t0 = Date.now();
        for (const ch of name.padEnd(24, ".")) await b.send("Input.dispatchKeyEvent", { type: "char", text: ch });
        const typingMs = Date.now() - t0;
        const slowestKey = await b.evaluate(`Math.max(0, ...window.__events)`);
        // Enter → the row on screen (the optimistic change) → the dialog closed (the server saved it).
        await b.evaluate(`(() => { window.__marks = {}; const name = ${JSON.stringify(name.padEnd(24, "."))}; const form = document.querySelector("form.quick-create-modal"); document.addEventListener("keydown", (e) => { if (e.key === "Enter" && !window.__marks.enter) window.__marks.enter = performance.now(); }, { capture: true, once: true }); const seen = () => [...document.querySelectorAll("tr[data-record-context]")].some((tr) => tr.textContent.includes(name)); new MutationObserver((list, obs) => { if (!window.__marks.row && seen()) window.__marks.row = performance.now(); if (!form.isConnected && !window.__marks.saved) { window.__marks.saved = performance.now(); obs.disconnect(); } }).observe(document.body, { childList: true, subtree: true }); window.__longTasks = []; return true; })()`);
        // QC_PROFILE=1: how long each step of a create takes (the classes are page globals; wrapped for this measurement only).
        if (process.env.QC_PROFILE === "1") await b.evaluate(`(() => { window.__prof = {}; const wrap = (proto, name, label) => { const fn = proto[name]; proto[name] = function (...a) { const t = performance.now(); const out = fn.apply(this, a); const add = () => { window.__prof[label] = (window.__prof[label] || 0) + performance.now() - t; }; if (out && typeof out.then === "function") out.then(add, add); else add(); return out; }; }; wrap(BoardModel.prototype, "snapshot", "undoSnapshot"); wrap(BoardModel.prototype, "toStorageState", "serialiseState"); wrap(AppView.prototype, "boardView", "drawBoard"); wrap(ResourceApiAdapter.prototype, "commitState", "commitToServer(total, incl. network)"); wrap(ResourceApiAdapter.prototype, "recordFields", "diffRecords"); return true; })()`);
        await b.key("Enter");
        assert.ok(await wait("!!window.__marks.saved", 30000 * SLOW), "saved");
        if (process.env.QC_PROFILE === "1") console.log(`QC_PROFILE size=${size} ${Object.entries(JSON.parse(await b.evaluate("JSON.stringify(window.__prof)"))).map(([k, v]) => `${k}=${Math.round(v)}ms`).join(" ")}`);
        const marks = JSON.parse(await b.evaluate(`JSON.stringify({ row: window.__marks.row - window.__marks.enter, saved: window.__marks.saved - window.__marks.enter, longest: Math.max(0, ...window.__longTasks), blocked: window.__longTasks.reduce((a, x) => a + x, 0) })`));
        const shown = await b.evaluate(rowShown(name.padEnd(24, ".")));
        console.log(`QC_PERF size=${size} cpu=x${process.env.QC_CPU || 1} rowsDrawn=${rendered} typing24keys=${typingMs}ms slowestKeyEvent=${Math.round(slowestKey)}ms enterToRow=${Math.round(marks.row)}ms enterToSaved=${Math.round(marks.saved)}ms longestTask=${Math.round(marks.longest)}ms blockedTotal=${Math.round(marks.blocked)}ms rowVisible=${shown}`);
        assert.equal((await named(board.id, name.padEnd(24, "."))).length, 1);
      } finally { await b.send("Emulation.setCPUThrottlingRate", { rate: 1 }); }
    });
  }
});
