// Board links by public number (/boards/100001) and the keyboard shortcuts (KeyboardShortcuts.js: registry, Quick search,
// help), in the REAL app in a headless browser against the test Entra server configured as in production (shared workspaces,
// beta open editing; fake MongoDB, synthetic data). Keys are real key presses (DevTools protocol) unless a test needs to see
// whether a key was left to the browser (then a dispatched event's defaultPrevented tells). Skipped without Chrome or Edge.
// NK_SHOTS=<folder>: screenshots of Quick search and the shortcut list (light/dark, desktop/phone).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, freePort, waitForServer, sleep } = require("./support/headless-browser");

const BROWSER = findBrowser();
const DESKTOP = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
const OWNER = "0e7e7e7e-0000-4000-8000-0000000000e1", EMPLOYEE = "0e7e7e7e-0000-4000-8000-0000000000e2";
const COLUMNS = [{ key: "serial", label: "Name", type: "text", required: true }, { key: "note", label: "Note", type: "text" }, { key: "qty", label: "Qty", type: "number" }];
const SHOTS = process.env.NK_SHOTS || "";

describe("Numeric board links and keyboard shortcuts (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, ws, ws2;
  const boards = {};
  const signIn = (oid, name) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${oid}&name=${encodeURIComponent(name)}&email=${oid}@example.invalid&admin=0&nonce=" + encodeURIComponent(s.nonce))).json(); return (await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) })).status; })()`);
  const api = (method, url, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return JSON.stringify({ status: r.status, body: await r.json().catch(() => null) }); })()`).then(JSON.parse);
  const wait = (expr, ms = 15000) => b.waitFor(expr, ms);
  const evaluate = (expr) => b.evaluate(expr);
  const make = async (workspace, name, rows, groups) => {
    const board = (await api("POST", `/api/v1/workspaces/${workspace}/boards`, { name, columns: COLUMNS, ...(groups ? { groups: groups.map((g) => ({ name: g })) } : {}) })).body.board;
    for (let i = 0; i < rows; i += 2000) assert.equal((await api("POST", `/api/v1/boards/${board.id}/records/batch`, { records: Array.from({ length: Math.min(2000, rows - i) }, (_, j) => { const n = i + j; return { values: { serial: `${name} ${String(n + 1).padStart(3, "0")}`, note: `n${n + 1}`, qty: n }, ...(groups ? { groupId: board.groups[n < rows / 2 ? 0 : 1].id } : {}) }; }) })).status, 201);
    return board;
  };
  const open = async (p, viewport = DESKTOP) => { await b.open(`${base}${p}`, viewport); assert.ok(await wait("!!document.querySelector('.app-shell')", 20000), `app at ${p}`); };
  const loaded = (name) => wait(`document.querySelector(".board-title-input")?.value === ${JSON.stringify(name)} && !!document.querySelector("tr[data-record-context]") && !document.querySelector('.skeleton-region[aria-busy="true"]')`);
  // A real key press. mods: "ctrl" | "shift" | "alt" | "meta", combined with "+".
  const press = async (key, mods = "") => {
    const m = { alt: 1, ctrl: 2, meta: 4, shift: 8 }, modifiers = mods.split("+").filter(Boolean).reduce((s, k) => s | m[k], 0);
    const codes = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Tab: 9, Delete: 46, Backspace: 8, ".": 190, "?": 191, "/": 191 };
    const vk = codes[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const code = key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key === "." ? "Period" : key === "?" || key === "/" ? "Slash" : key;
    const text = key === "Enter" ? "\r" : key.length === 1 && !(modifiers & 6) ? key : undefined;
    await b.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
    await b.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(60);
  };
  // Whether the app took a key (defaultPrevented) when it's pressed on the given element. The element keeps focus.
  const tookKey = (selector, init) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...${JSON.stringify(init)} }); el.dispatchEvent(e); return e.defaultPrevented; })()`);
  const overlay = () => evaluate(`document.querySelector("#overlay-root")?.children.length || 0`);
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const r = await b.send("Page.captureScreenshot", { format: "png" }); if (r.result?.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64")); };
  const cell = (serial, key) => `tr:has([aria-label="Name: ${serial}"]) td[data-column-key="${key}"] .cell-display`;
  const records = async (boardId) => { const all = []; let c = ""; do { const p = (await api("GET", `/api/v1/boards/${boardId}/records?limit=1000${c ? `&cursor=${encodeURIComponent(c)}` : ""}`)).body; all.push(...p.items); c = p.nextCursor || ""; } while (c); return all; };

  before(async () => {
    const port = await freePort(); base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore", env: { ...process.env, JARC_TEST_BETA: "1" } });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER);
    await b.motionPreference("reduce");
    await b.open(`${base}/api/v1/health`, DESKTOP);
    assert.equal(await signIn(OWNER, "Olga Owner"), 201);
    ws = (await api("POST", "/api/v1/workspaces", { name: "Ops Space" })).body.workspace.id;
    ws2 = (await api("POST", "/api/v1/workspaces", { name: "Sales Space" })).body.workspace.id;
    boards.small = await make(ws, "Orders", 6, ["Open", "Done"]);
    boards.long = await make(ws, "Inventory", 300, ["Shelf A", "Shelf B"]);
    boards.twin = await make(ws2, "Orders", 2);
    boards.archived = await make(ws, "Retired", 2);
    const doc = (await api("GET", `/api/v1/boards/${boards.archived.id}`)).body.board;
    await api("PATCH", `/api/v1/boards/${boards.archived.id}`, { expectedVersion: doc.version, archived: true });
    assert.equal(await signIn(EMPLOYEE, "Emil Employee"), 201);
  });
  after(async () => { await b?.close(); server?.kill(); });

  // ---- Numeric links ----------------------------------------------------------------------------------------------------
  test("the address shows the board's number; an older server-ID link opens the same board and becomes the number, without a new history entry", async () => {
    for (const x of Object.values(boards)) assert.ok(Number.isSafeInteger(x.publicId) && x.publicId > 100000, "every board has a number");
    await open(`/boards/${boards.small.publicId}`);
    assert.ok(await loaded("Orders"));
    assert.equal(await evaluate("location.pathname"), `/boards/${boards.small.publicId}`);
    await open(`/boards/${boards.long.id}`);
    assert.ok(await loaded("Inventory"));
    const length = await evaluate("history.length");
    assert.ok(await wait(`location.pathname === "/boards/${boards.long.publicId}"`), "canonical numeric link");
    assert.equal(await evaluate("history.length"), length, "replaced, not added");
    assert.equal(await evaluate(`(window.jarcPerf?.entries || []).filter((e) => e.name === "board-open").length`), 1, "opened once (one board state, whichever link)");
  });

  test("Back/Forward between numeric links; leading zeros or an unknown number: the usual not-valid / not-found screens", async () => {
    await open(`/boards/${boards.small.publicId}`); assert.ok(await loaded("Orders"));
    await evaluate(`[...document.querySelectorAll("#sidebar .tree-item[data-action='open-board']")].find((e) => e.textContent.trim().startsWith("Inventory")).click()`);
    assert.ok(await loaded("Inventory"));
    assert.equal(await evaluate("location.pathname"), `/boards/${boards.long.publicId}`);
    await evaluate("history.back()"); assert.ok(await loaded("Orders"));
    assert.equal(await evaluate("location.pathname"), `/boards/${boards.small.publicId}`);
    await evaluate("history.forward()"); assert.ok(await loaded("Inventory"));
    await open(`/boards/0${boards.small.publicId}`);
    assert.ok(await wait(`document.querySelector(".board-link-problem h2")?.textContent === "This board link isn't valid."`));
    await open("/boards/999999999");
    assert.ok(await wait(`document.querySelector(".board-link-problem h2")?.textContent === "This board could not be found."`));
  });

  test("Copy board link copies the numeric link", async () => {
    await open(`/boards/${boards.small.publicId}`); assert.ok(await loaded("Orders"));
    await evaluate(`(() => { window.__copied = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } }); })()`);
    await evaluate(`document.querySelector('.board-actions [data-action="copy-board-link"]').click()`);
    assert.ok(await wait("window.__copied.length === 1", 3000));
    assert.equal(await evaluate("window.__copied[0]"), `${base}/boards/${boards.small.publicId}`);
  });

  // ---- Quick search -----------------------------------------------------------------------------------------------------
  test("Ctrl+B: Quick search opens focused; typing filters boards (with their workspace); arrows and Enter open one; the address is its number", async () => {
    await open(`/boards/${boards.small.publicId}`); assert.ok(await loaded("Orders"));
    await evaluate(`document.querySelector(${JSON.stringify(cell("Orders 001", "note"))}).focus()`);
    await press("b", "ctrl");
    assert.ok(await wait(`document.activeElement?.id === "quick-search-input"`, 3000), "focused");
    assert.equal(await evaluate(`document.querySelector(".quick-search").getAttribute("role")`), "dialog");
    await b.send("Input.insertText", { text: "ord" }); await sleep(150);
    const items = await evaluate(`JSON.stringify([...document.querySelectorAll(".quick-search-item")].map((li) => li.textContent.trim()))`).then(JSON.parse);
    assert.equal(items.length, 2, `two boards called Orders: ${items}`);
    assert.ok(items.some((t) => t.includes("Ops Space")) && items.some((t) => t.includes("Sales Space")), "each with its workspace");
    assert.ok(items.every((t) => t.includes("same name in another workspace")));
    assert.ok(!items.some((t) => t.includes("Retired")), "archived boards aren't offered");
    await press("ArrowDown");
    const target = await evaluate(`document.querySelector(".quick-search-item.is-active").textContent`);
    assert.equal(await evaluate(`document.querySelector("#quick-search-input").getAttribute("aria-activedescendant")`), "quick-search-option-1");
    await press("Enter");
    const expected = target.includes("Sales Space") ? boards.twin : boards.small;
    assert.ok(await wait(`location.pathname === "/boards/${expected.publicId}"`), "opened, numeric link");
    assert.equal(await overlay(), 0);
    // Escape closes it and gives focus back.
    await evaluate(`document.querySelector("#board-search").focus()`);
    await press("b", "ctrl"); assert.ok(await wait(`!!document.querySelector(".quick-search")`, 3000));
    await press("Escape");
    assert.ok(await wait(`!document.querySelector(".quick-search") && document.activeElement?.id === "board-search"`, 3000), "closed, focus restored");
    await b.send("Input.insertText", { text: "" });
    await press("b", "ctrl"); await b.send("Input.insertText", { text: "zzzz" }); await sleep(150);
    assert.equal(await evaluate(`document.querySelector(".quick-search-status").textContent`), "No board with that name");
    await press("Escape");
  });

  // ---- Shortcuts registry -----------------------------------------------------------------------------------------------
  test("Ctrl+. toggles the sidebar; Shift+? opens the shortcut list (platform keys, unavailable ones marked); Escape closes it and restores focus", async () => {
    await open("/");
    const before = await evaluate(`document.body.classList.contains("nav-collapsed")`);
    await press(".", "ctrl");
    assert.equal(await evaluate(`document.body.classList.contains("nav-collapsed")`), !before);
    await press(".", "ctrl");
    assert.equal(await evaluate(`document.body.classList.contains("nav-collapsed")`), before);
    await evaluate(`document.querySelector('[data-action="nav"][data-screen="home"]').focus()`);
    await press("?", "shift");
    assert.ok(await wait(`!!document.querySelector(".shortcuts-modal")`, 3000));
    const help = JSON.parse(await evaluate(`JSON.stringify({ text: document.querySelector(".shortcuts-modal").textContent, groups: [...document.querySelectorAll(".shortcuts-modal h3")].map((h) => h.textContent), unavailable: document.querySelectorAll(".shortcuts-modal .shortcut-item.is-unavailable").length, focus: document.activeElement?.dataset.action })`));
    assert.deepEqual(help.groups, ["System", "Board navigation", "Editing", "Selection", "Board actions"]);
    for (const t of ["Quick search", "Ctrl", "Shift", "Search this board", "New group", "New column", "Export"]) assert.ok(help.text.includes(t), t);
    assert.ok(help.unavailable > 0, "board shortcuts are marked unavailable on Home");
    assert.equal(help.focus, "close-overlay", "focus goes into the dialog");
    await press("Escape");
    assert.ok(await wait(`!document.querySelector(".shortcuts-modal") && document.activeElement?.dataset.screen === "home"`, 3000), "focus restored");
  });

  test("Ctrl+F goes to the board's search (every record); inside a field it stays the browser's Find", async () => {
    await open(`/boards/${boards.small.publicId}`); assert.ok(await loaded("Orders"));
    await evaluate(`document.querySelector(${JSON.stringify(cell("Orders 002", "note"))}).focus()`);
    await press("f", "ctrl");
    assert.equal(await evaluate("document.activeElement?.id"), "board-search");
    assert.equal(await tookKey("#board-search", { key: "f", ctrlKey: true }), false, "in the search field: left to the browser");
    await open("/");
    assert.equal(await tookKey("body", { key: "f", ctrlKey: true }), false, "off a board: left to the browser");
  });

  test("grid: arrows run through a long virtualized board and into the next group; Tab; Enter edits; Escape cancels without saving", async () => {
    await open(`/boards/${boards.long.publicId}`); assert.ok(await loaded("Inventory"));
    await evaluate(`document.querySelector(${JSON.stringify(cell("Inventory 001", "note"))}).focus()`);
    for (let i = 0; i < 155; i += 1) await press("ArrowDown");
    assert.equal(await evaluate(`document.activeElement?.closest("tr")?.querySelector("[aria-label^='Name: ']")?.getAttribute("aria-label")`), "Name: Inventory 156", "into the second group");
    assert.equal(await evaluate(`document.activeElement?.dataset.field`), "note", "same column");
    assert.ok(await evaluate(`document.querySelectorAll("tr[data-record-context]").length`) < 200, "rows still drawn near the viewport only");
    for (let i = 0; i < 3; i += 1) await press("ArrowUp");
    assert.equal(await evaluate(`document.activeElement?.closest("tr")?.querySelector("[aria-label^='Name: ']")?.getAttribute("aria-label")`), "Name: Inventory 153", "back up across the group boundary");
    await press("Tab");
    assert.equal(await evaluate(`document.activeElement?.dataset.field`), "qty");
    await press("Enter");
    assert.ok(await wait(`document.activeElement?.classList.contains("cell-input")`, 3000), "editing");
    await b.send("Input.insertText", { text: "999" });
    await press("Escape");
    await sleep(300);
    assert.equal((await records(boards.long.id)).find((r) => r.values.serial === "Inventory 153").values.qty, 152, "cancelled: nothing saved");
  });

  test("Delete clears a cell (never the record); Ctrl+C / Ctrl+X / Ctrl+V copy, cut and paste checked values", async () => {
    await open(`/boards/${boards.small.publicId}`); assert.ok(await loaded("Orders"));
    const before = (await records(boards.small.id)).length;
    await evaluate(`document.querySelector(${JSON.stringify(cell("Orders 003", "note"))}).focus()`);
    await press("Delete");
    assert.ok(await wait(`document.querySelector(${JSON.stringify(cell("Orders 003", "note"))})?.textContent.trim() === ""`, 5000));
    const clip = (type, focusSel, data) => evaluate(`(() => { document.querySelector(${JSON.stringify(focusSel)}).focus(); const dt = new DataTransfer(); ${data ? `dt.setData("text/plain", ${JSON.stringify(data)});` : ""} const e = new ClipboardEvent(${JSON.stringify(type)}, { clipboardData: dt, bubbles: true, cancelable: true }); document.dispatchEvent(e); return JSON.stringify({ prevented: e.defaultPrevented, text: dt.getData("text/plain") }); })()`).then(JSON.parse);
    assert.deepEqual(await clip("copy", cell("Orders 004", "note"), null), { prevented: true, text: "n4" });
    assert.deepEqual(await clip("cut", cell("Orders 005", "note"), null), { prevented: true, text: "n5" });
    assert.ok(await wait(`document.querySelector(${JSON.stringify(cell("Orders 005", "note"))})?.textContent.trim() === ""`, 5000), "cut clears");
    await clip("paste", cell("Orders 006", "qty"), "not a number");
    await sleep(300);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(cell("Orders 006", "qty"))}).textContent.trim()`), "5", "an invalid value isn't pasted");
    await clip("paste", cell("Orders 006", "note"), "pasted");
    assert.ok(await wait(`document.querySelector(${JSON.stringify(cell("Orders 006", "note"))})?.textContent.includes("pasted")`, 5000));
    const end = Date.now() + 6000; let list;
    while (Date.now() < end) { list = await records(boards.small.id); if (list.find((r) => r.values.serial === "Orders 006").values.note === "pasted") break; await sleep(150); }
    assert.equal(list.length, before, "no record deleted");
    assert.equal(list.find((r) => r.values.serial === "Orders 003").values.note ?? "", "");
    // Text selected in a field: the browser's own copy.
    assert.equal((await evaluate(`(() => { const i = document.querySelector("#board-search"); i.value = "abc"; i.focus(); i.select(); const dt = new DataTransfer(); const e = new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }); i.dispatchEvent(e); return e.defaultPrevented; })()`)), false);
  });

  test("Ctrl+Enter selects the focused record; Shift+Enter selects up to it, on screen only (never in a collapsed group)", async () => {
    await open(`/boards/${boards.small.publicId}`); assert.ok(await loaded("Orders"));
    await evaluate(`document.querySelector(${JSON.stringify(cell("Orders 001", "note"))}).focus()`);
    await press("Enter", "ctrl");
    assert.ok(await wait(`document.querySelectorAll('input[data-action="select"]:checked').length === 1`, 3000));
    assert.equal(await evaluate(`document.activeElement?.dataset.field`), "note", "focus stays on the cell");
    await evaluate(`document.querySelector(${JSON.stringify(cell("Orders 003", "note"))}).focus()`);
    await press("Enter", "shift");
    assert.ok(await wait(`document.querySelectorAll('input[data-action="select"]:checked').length === 3`, 3000));
    await press("Enter", "ctrl");
    assert.ok(await wait(`document.querySelectorAll('input[data-action="select"]:checked').length === 2`, 3000), "Ctrl+Enter again unselects");
    // A collapsed group in between: its records are not selected.
    await evaluate(`document.querySelector('[data-action="clear-selection"], [data-action="select-none"]')?.click()`);
    await open(`/boards/${boards.small.publicId}`); assert.ok(await loaded("Orders"));
    await evaluate(`document.querySelector(${JSON.stringify(cell("Orders 001", "note"))}).focus()`);
    await press("Enter", "ctrl");
    const total = await evaluate(`document.querySelectorAll('input[data-action="select"]:checked').length`);
    assert.equal(total, 1);
  });

  test("Ctrl+G collapses all groups, again expands them; Ctrl+Shift+G opens New group (cancel: nothing made); Ctrl+Shift+C the column chooser; Ctrl+Shift+L the activity; Ctrl+Shift+E exports", async () => {
    await open(`/boards/${boards.small.publicId}`); assert.ok(await loaded("Orders"));
    await evaluate(`document.querySelector(${JSON.stringify(cell("Orders 001", "note"))}).focus()`);
    await press("g", "ctrl");
    assert.ok(await wait(`document.querySelectorAll("tr[data-record-context]").length === 0`, 3000), "collapsed");
    await press("g", "ctrl");
    assert.ok(await wait(`document.querySelectorAll("tr[data-record-context]").length === 6`, 3000), "expanded again");
    const groupsBefore = (await api("GET", `/api/v1/boards/${boards.small.id}`)).body.board.groups.length;
    await evaluate(`document.activeElement?.blur()`);
    await press("g", "ctrl+shift");
    assert.ok(await wait(`!!document.querySelector("#overlay-root form, #overlay-root .modal")`, 3000), "the New group form");
    await press("Escape"); await sleep(200);
    assert.equal((await api("GET", `/api/v1/boards/${boards.small.id}`)).body.board.groups.length, groupsBefore, "cancelled: no group");
    await press("c", "ctrl+shift");
    assert.ok(await wait(`!!document.querySelector("#overlay-root .column-chooser, #overlay-root [data-action='column-type-search']")`, 3000), "the column chooser");
    await press("Escape"); await sleep(150);
    await press("l", "ctrl+shift");
    assert.ok(await wait(`(document.querySelector("#overlay-root")?.textContent || "").length > 0`, 3000), "the activity");
    await press("Escape"); await sleep(150);
    await evaluate(`(() => { window.__exports = 0; const real = URL.createObjectURL.bind(URL); URL.createObjectURL = (blob) => { window.__exports += 1; window.__exportType = blob.type; return real(blob); }; HTMLAnchorElement.prototype.click = function () {}; })()`);
    await press("e", "ctrl+shift");
    assert.ok(await wait("window.__exports === 1", 3000), "exported once, by the existing export");
    assert.match(await evaluate("window.__exportType"), /csv/);
  });

  test("Ctrl+click on column headers sorts by several columns", async () => {
    await open(`/boards/${boards.long.publicId}`); assert.ok(await loaded("Inventory"));
    await evaluate(`document.querySelector('.editable-table thead th[data-column-key="note"]').dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }))`);
    assert.ok(await wait(`document.querySelector("#toast-region")?.textContent.includes("Sorted by Note ↑")`, 3000));
    await evaluate(`document.querySelector('.editable-table thead th[data-column-key="qty"]').dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }))`);
    assert.ok(await wait(`document.querySelector("#toast-region")?.textContent.includes("Sorted by Note ↑, then Qty ↑")`, 3000));
    await evaluate(`document.querySelector('.editable-table thead th[data-column-key="qty"]').dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }))`);
    assert.ok(await wait(`document.querySelector("#toast-region")?.textContent.includes("then Qty ↓")`, 3000), "again: reversed");
  });

  test("shortcuts stay quiet while typing, composing with an input method, in dialogs, and where they can't act", async () => {
    await open(`/boards/${boards.small.publicId}`); assert.ok(await loaded("Orders"));
    for (const init of [{ key: "n" }, { key: "?", shiftKey: true }, { key: "/" }, { key: "g", ctrlKey: true }, { key: "G", ctrlKey: true, shiftKey: true }, { key: "C", ctrlKey: true, shiftKey: true }, { key: "E", ctrlKey: true, shiftKey: true }, { key: ".", ctrlKey: true }, { key: "Enter", ctrlKey: true }])
      assert.equal(await tookKey("#board-search", init), false, `typing in a field: ${JSON.stringify(init)}`);
    assert.equal(await overlay(), 0);
    assert.equal(await tookKey("body", { key: "b", ctrlKey: true, isComposing: true }), false, "input method composing");
    assert.equal(await overlay(), 0);
    assert.equal(await tookKey("body", { key: "b", metaKey: true }), false, "⌘ is the Mac's key, not Windows'");
    assert.equal(await tookKey("body", { key: "b", ctrlKey: true, altKey: true }), false, "Ctrl+Alt is something else (AltGr)");
    await open(`/boards/${boards.archived.publicId}`); assert.ok(await loaded("Retired"));
    assert.equal(await tookKey("body", { key: "G", ctrlKey: true, shiftKey: true }), false, "archived board: no new group, the key is left alone");
    assert.equal(await overlay(), 0);
  });

  test("right after deploying, before the backfill (no board has a number): links use the server ID and work; new boards get numbers", async () => {
    assert.equal(await evaluate(`fetch("/__test/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stripBoardPublicIds: true }) }).then((r) => r.status)`), 200);
    assert.equal((await api("GET", `/api/v1/boards/${boards.small.id}`)).body.board.publicId, undefined, "no number, as in production now");
    await open("/");
    await evaluate(`[...document.querySelectorAll("#sidebar .tree-item[data-action='open-board']")].find((e) => e.textContent.trim().startsWith("Inventory"))?.click() ?? (async () => {})()`);
    if (!(await evaluate(`document.querySelector(".board-title-input")?.value === "Inventory"`))) { await open(`/boards/${boards.long.id}`); }
    assert.ok(await loaded("Inventory"));
    assert.equal(await evaluate("location.pathname"), `/boards/${boards.long.id}`, "the server-ID link, as before");
    await evaluate(`(() => { window.__copied = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } }); })()`);
    await evaluate(`document.querySelector('.board-actions [data-action="copy-board-link"]').click()`);
    assert.ok(await wait("window.__copied.length === 1", 3000));
    assert.equal(await evaluate("window.__copied[0]"), `${base}/boards/${boards.long.id}`, "Copy board link: the server-ID link");
    await open(`/boards/${boards.small.id}`); assert.ok(await loaded("Orders"));
    assert.equal(await evaluate("location.pathname"), `/boards/${boards.small.id}`, "no rewrite to a number that doesn't exist");
    await press("b", "ctrl"); await b.send("Input.insertText", { text: "inventory" }); await sleep(150); await press("Enter");
    assert.ok(await wait(`location.pathname === "/boards/${boards.long.id}"`), "Quick search opens it by its server-ID link");
    await open(`/boards/${boards.small.publicId}`);
    assert.ok(await wait(`document.querySelector(".board-link-problem h2")?.textContent === "This board could not be found."`), "a number no board has yet: not found, nothing revealed");
    const fresh = (await api("POST", `/api/v1/workspaces/${ws}/boards`, { name: "Brand New", columns: COLUMNS })).body.board;
    assert.ok(Number.isSafeInteger(fresh.publicId) && fresh.publicId > boards.long.publicId, "a board created now gets the next number");
    await open(`/boards/${fresh.publicId}`);
    assert.ok(await wait(`document.querySelector(".board-title-input")?.value === "Brand New"`), "and opens by it");
  });

  test("phone and laptop: Quick search and the shortcut list fit the screen, light and dark", async () => {
    for (const [name, view] of [["laptop", { width: 1280, height: 720 }], ["phone", PHONE]]) for (const theme of ["light", "dark"]) {
      await open(`/boards/${boards.small.id}`, view); assert.ok(await loaded("Orders")); // the server-ID link works with or without numbers
      for (let k = 0; k < 2; k += 1) { await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`); await sleep(150); }
      await press("b", "ctrl"); assert.ok(await wait(`!!document.querySelector(".quick-search")`, 3000));
      const q = JSON.parse(await evaluate(`JSON.stringify((() => { const r = document.querySelector(".quick-search").getBoundingClientRect(); return { inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, sideways: document.documentElement.scrollWidth > innerWidth }; })())`));
      assert.deepEqual(q, { inside: true, sideways: false }, `${name} ${theme} quick search`);
      await shot(`quick-search-${name}-${theme}`);
      await press("Escape");
      await evaluate(`document.activeElement?.blur()`);
      await press("?", "shift"); assert.ok(await wait(`!!document.querySelector(".shortcuts-modal")`, 3000));
      const h = JSON.parse(await evaluate(`JSON.stringify((() => { const m = document.querySelector(".shortcuts-modal"), r = m.getBoundingClientRect(), body = m.querySelector(".shortcuts-body"); return { inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight + 1, sideways: document.documentElement.scrollWidth > innerWidth, scrolls: body.scrollHeight > body.clientHeight ? getComputedStyle(body).overflowY : "fits", bodySideways: body.scrollWidth > body.clientWidth + 1 }; })())`));
      assert.equal(h.inside, true, `${name} ${theme} list`); assert.equal(h.sideways, false);
      assert.ok(["auto", "fits"].includes(h.scrolls));
      assert.equal(h.bodySideways, false, `${name} ${theme}: no sideways scrolling inside the list`);
      await shot(`shortcuts-${name}-${theme}`);
      await press("Escape");
    }
  });
});
