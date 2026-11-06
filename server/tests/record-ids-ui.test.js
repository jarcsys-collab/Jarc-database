// The sidebar without its icon rail, and the Record ID system column, in the REAL app: a headless browser against the test Entra
// server (local test keys, fake MongoDB, synthetic data), on desktop, tablet and phone. Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const DESKTOP = { width: 1440, height: 900 }, TABLET = { width: 900, height: 900 }, PHONE = { width: 390, height: 844 };
const OID = "0e7e7e7e-0000-4000-8000-0000000000e1", OTHER = "0e7e7e7e-0000-4000-8000-0000000000e2";
const HEX = /^[0-9a-f]{24}$/;

describe("Sidebar without the icon rail, and Record IDs (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, wsId, boardId, ids;
  const start = async (env) => {
    const port = await freePort(), url = `http://localhost:${port}`;
    const proc = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore", env: { ...process.env, ...env } });
    await waitForServer(url, { child: proc });
    return { proc, url };
  };
  const signIn = (oid, name, admin) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${oid}&name=${encodeURIComponent(name)}&email=${oid}@example.invalid&admin=${admin ? 1 : 0}&nonce=" + encodeURIComponent(s.nonce))).json(); const r = await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); return r.status; })()`);
  const has = (sel) => b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  const text = (sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent || ""`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const wait = (expr, ms = 10000) => b.waitFor(expr, ms);
  const noSidewaysScroll = () => b.evaluate("document.documentElement.scrollWidth <= window.innerWidth");
  const api = (method, url, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return JSON.stringify({ status: r.status, body: await r.json().catch(() => null) }); })()`).then(JSON.parse);
  const captureClipboard = () => b.evaluate(`(() => { window.__copied = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } }); return true; })()`);
  const copied = () => b.evaluate("JSON.stringify(window.__copied)").then(JSON.parse);
  const shownIds = () => b.evaluate(`JSON.stringify([...document.querySelectorAll("tr[data-record-context] td.record-id-cell code")].map((c) => c.textContent))`).then(JSON.parse);
  const openApp = async (viewport) => { await b.open(`${base}/`, viewport); assert.ok(await wait("!!document.querySelector('.app-shell')", 15000), "app loaded"); };
  const openBoard = async (viewport) => {
    await openApp(viewport);
    await b.evaluate(`(() => { const el = [...document.querySelectorAll("#sidebar .tree-item, #sidebar button, button, a")].find((e) => /Customer Database/.test(e.textContent) && !e.closest(".popover")); el?.click(); })()`);
    assert.ok(await wait("document.querySelectorAll('tr[data-record-context] td.record-id-cell code').length >= 3", 10000), "the board shows its Record IDs");
  };

  before(async () => {
    server = await start({ JARC_TEST_API_TOKENS: "1" });
    base = server.url;
    b = await launch(BROWSER);
    await b.motionPreference("reduce");
    await b.open(`${base}/api/v1/health`, DESKTOP);
    assert.equal(await signIn(OID, "Rhea Records", true), 201);
    const ws = await api("POST", "/api/v1/workspaces", { name: "Synthetic Records" });
    wsId = ws.body.workspace.id;
    const board = await api("POST", `/api/v1/workspaces/${wsId}/boards`, { name: "Customer Database", columns: [{ key: "serial", label: "Customer", type: "text", required: true }, { key: "ref", label: "Item ID", type: "text" }, { key: "status", label: "Status", type: "status", options: ["New", "Done"] }] });
    boardId = board.body.board.id;
    await api("POST", `/api/v1/workspaces/${wsId}/boards`, { name: "Orders" });
    const made = await api("POST", `/api/v1/boards/${boardId}/records/batch`, { records: [1, 2, 3].map((i) => ({ values: { serial: `Customer ${i}`, ref: `BH-11200${i}`, status: "New" } })) });
    ids = made.body.items.map((r) => r.id);
  });
  after(async () => { await b?.close(); server?.proc?.kill(); });

  // ---- Sidebar
  test("desktop: the full sidebar is unchanged (board icons, counts, workspace badge, sections)", async () => {
    await openApp(DESKTOP);
    const sidebar = JSON.parse(await b.evaluate(`JSON.stringify((() => { const s = document.querySelector("#sidebar"), r = s.getBoundingClientRect(); return { width: Math.round(r.width), left: Math.round(r.left), visible: getComputedStyle(s).visibility, boardIcons: s.querySelectorAll(".tree-item .icon, .board-nav .icon").length, counts: [...s.querySelectorAll(".nav-count")].map((c) => c.textContent.trim()), text: s.textContent }; })())`));
    assert.deepEqual([sidebar.width, sidebar.left, sidebar.visible], [236, 0, "visible"]);
    assert.ok(sidebar.boardIcons >= 2, "board list icons kept");
    assert.ok(sidebar.counts.includes("3"), `board record counts kept: ${sidebar.counts}`);
    for (const label of ["Home", "My work", "Integrations", "Workspaces", "Synthetic Records", "Customer Database", "Orders", "Settings"]) assert.match(sidebar.text, new RegExp(label, "i"), label);
    assert.equal(await b.evaluate(`getComputedStyle(document.querySelector('.topbar [data-action="toggle-nav"]')).display`), "none", "no menu button while the sidebar is open");
  });

  test("desktop: collapsing hides the whole sidebar (no icon rail); the menu button brings it back, and the choice is kept", async () => {
    await openApp(DESKTOP);
    await click('#sidebar [data-action="collapse-nav"]');
    assert.ok(await wait("document.body.classList.contains('nav-collapsed')", 3000), "collapses");
    const collapsed = JSON.parse(await b.evaluate(`JSON.stringify({ right: Math.round(document.querySelector("#sidebar").getBoundingClientRect().right), visibility: getComputedStyle(document.querySelector("#sidebar")).visibility, contentLeft: Math.round(document.querySelector(".workspace").getBoundingClientRect().left), topbarLeft: Math.round(document.querySelector(".topbar").getBoundingClientRect().left), toggle: getComputedStyle(document.querySelector('.topbar [data-action="toggle-nav"]')).display, focused: document.activeElement?.dataset?.action })`));
    assert.ok(collapsed.right <= 0, "the sidebar is off screen, not a rail");
    assert.equal(collapsed.visibility, "hidden", "and out of the tab order");
    assert.deepEqual([collapsed.contentLeft, collapsed.topbarLeft], [0, 0], "the page uses the reclaimed space");
    assert.notEqual(collapsed.toggle, "none", "a menu button replaces it");
    assert.equal(collapsed.focused, "toggle-nav", "focus moves to that button");
    assert.ok(await noSidewaysScroll(), "no sideways scroll");
    // Reload: still collapsed.
    await openApp(DESKTOP);
    assert.ok(await b.evaluate("document.body.classList.contains('nav-collapsed')"), "still collapsed after a reload");
    await click('.topbar [data-action="toggle-nav"]');
    assert.ok(await wait("!document.body.classList.contains('nav-collapsed')", 3000), "the menu button expands the sidebar");
    assert.equal(await b.evaluate(`Math.round(document.querySelector("#sidebar").getBoundingClientRect().width)`), 236);
    assert.equal(await b.evaluate(`document.activeElement?.dataset?.action`), "collapse-nav");
  });

  for (const [label, viewport] of [["tablet", TABLET], ["phone", PHONE]]) {
    test(`${label}: no icon rail; the menu button opens the full navigation, and every destination still works`, async () => {
      await openApp(viewport);
      const closed = JSON.parse(await b.evaluate(`JSON.stringify({ right: Math.round(document.querySelector("#sidebar").getBoundingClientRect().right), visibility: getComputedStyle(document.querySelector("#sidebar")).visibility, contentLeft: Math.round(document.querySelector(".workspace").getBoundingClientRect().left) })`));
      assert.ok(closed.right <= 0, `no rail on the left (${closed.right})`);
      assert.equal(closed.visibility, "hidden");
      assert.equal(closed.contentLeft, 0, "the page starts at the left edge");
      assert.ok(await noSidewaysScroll());
      await click('.topbar [data-action="toggle-nav"]');
      assert.ok(await wait("document.querySelector('#sidebar').classList.contains('open') && getComputedStyle(document.querySelector('#sidebar')).visibility === 'visible'", 3000), "drawer opens");
      const drawer = await text("#sidebar");
      for (const label2 of ["Home", "My work", "Integrations", "Customer Database", "Orders", "Settings"]) assert.match(drawer, new RegExp(label2), label2);
      await b.evaluate(`[...document.querySelectorAll("#sidebar button, #sidebar a")].find((e) => /Customer Database/.test(e.textContent))?.click()`);
      assert.ok(await wait("!!document.querySelector('td.record-id-cell')", 8000), "a board opens from the drawer");
      assert.ok(await wait("!document.querySelector('#sidebar').classList.contains('open')", 3000), "and the drawer closes");
    });
  }

  // ---- Record ID column
  for (const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    test(`Record ID column (${label}): one read-only system column, the real IDs in full, copy works, business Item ID untouched`, async () => {
      await openBoard(viewport);
      await captureClipboard();
      const headers = JSON.parse(await b.evaluate(`JSON.stringify([...document.querySelectorAll(".editable-table thead th")].map((t) => t.textContent.trim()).filter(Boolean))`));
      assert.equal(headers.filter((h) => /^Record ID/.test(h)).length, 1, "exactly one Record ID column");
      assert.equal(headers.filter((h) => /^Item ID/.test(h)).length, 1, "the business Item ID column is still there");
      assert.deepEqual((await shownIds()).sort(), [...ids].sort(), "the stored IDs, not a copy or a counter");
      assert.ok((await shownIds()).every((id) => HEX.test(id)), "never shortened");
      assert.deepEqual(JSON.parse(await b.evaluate(`JSON.stringify([...document.querySelectorAll('tr[data-record-context] td[data-column-key="ref"]')].map((c) => c.textContent.trim()).sort())`)), ["BH-112001", "BH-112002", "BH-112003"]);
      assert.equal(await has("td.record-id-cell input, td.record-id-cell [contenteditable]"), false, "nothing to edit");
      await b.evaluate(`document.querySelector('td.record-id-cell [data-action="copy-record-id"]').click()`);
      assert.ok(await wait("window.__copied.length === 1", 3000));
      assert.ok(ids.includes((await copied())[0]));
      // The column fits: the ID isn't cut off inside its cell.
      assert.ok(await b.evaluate(`[...document.querySelectorAll("td.record-id-cell code")].every((c) => c.scrollWidth <= c.clientWidth + 1)`), "IDs aren't truncated");
      assert.ok(await noSidewaysScroll(), "the page doesn't scroll sideways; the table does");
    });
  }

  test("row menu: Copy Record ID and API Information (IDs, endpoint, copy, Open in API Explorer)", async () => {
    await openBoard(DESKTOP);
    await captureClipboard();
    const rowId = await b.evaluate(`document.querySelector('tr[data-record-context] [data-action="record-menu"]').dataset.id`);
    const id = await b.evaluate(`document.querySelector('tr[data-record-context] td.record-id-cell code').textContent`);
    await click('tr[data-record-context] [data-action="record-menu"]');
    assert.ok(await wait("!!document.querySelector('.record-menu-popover [data-action=\"copy-record-id\"]')", 3000));
    await click('.record-menu-popover [data-action="copy-record-id"]');
    assert.ok(await wait("window.__copied.length === 1", 3000));
    assert.equal((await copied())[0], id);
    await click(`[data-action="record-menu"][data-id="${rowId}"]`);
    assert.ok(await wait("!!document.querySelector('.record-menu-popover [data-action=\"apitok-record-info\"]')", 3000));
    await click('.record-menu-popover [data-action="apitok-record-info"]');
    assert.ok(await wait("!!document.querySelector('.apitok-record-info')", 3000));
    const info = await text(".apitok-record-info"), endpoint = `${base}/api/v1/external/records/${id}`;
    for (const part of ["Record ID", id, "Board name", "Customer Database", "Board API ID", boardId, "Workspace", "Synthetic Records", "Record endpoint", endpoint, "YOUR_JARC_API_TOKEN", "Copy Record ID", "Copy Endpoint", "Open in API Explorer"]) assert.ok(info.includes(part), part);
    assert.doesNotMatch(await b.evaluate(`document.querySelector(".apitok-record-info").innerHTML`), /jarc_[0-9a-f]{24}_/, "no token");
    await click('.apitok-record-info .modal-actions [data-label="Endpoint"]');
    assert.ok(await wait("window.__copied.length === 2", 3000));
    assert.equal((await copied())[1], endpoint);
    await click('.apitok-record-info [data-action="apitok-open-explorer"]');
    assert.ok(await wait(`document.querySelector('[data-action="apitok-ex-op"]')?.value === "record" && document.querySelector('[data-action="apitok-ex-record"]')?.value === ${JSON.stringify(id)}`, 8000), "the Explorer opens on this record");
    assert.ok((await text("#apitok-root")).includes(endpoint));
    assert.ok((await text("#apitok-example-ex-curl")).includes(endpoint) && (await text("#apitok-example-ex-curl")).includes("$JARC_API_TOKEN"));
    await click('[data-action="apitok-ex-example"]');
    assert.ok(await wait("!!document.querySelector('#apitok-ex-example')", 5000));
    assert.equal(JSON.parse(await text("#apitok-ex-example")).record.id, id, "the preview is that record");
    // A mistyped ID is explained, and never used.
    await b.evaluate(`(() => { const i = document.querySelector('[data-action="apitok-ex-record"]'); i.value = "abc"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    assert.ok(await wait(`/24 characters/.test(document.querySelector("#apitok-root .apitok-error")?.textContent || "")`, 3000));
    assert.ok((await text("#apitok-example-ex-curl")).includes("/records/RECORD_ID"));
  });

  test("a new row gets its permanent ID automatically, and keeps it after a reload; another employee sees the same ID", async () => {
    await openBoard(DESKTOP);
    await click('.quick-add-row [data-action="inline-add"]');
    assert.ok(await wait("!!document.querySelector('[data-action=draft-input]')", 3000));
    await b.evaluate(`(() => { const i = document.querySelector('[data-action=draft-input]'); i.value = 'Brand New Customer'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    const serverId = async () => (await api("GET", `/api/v1/boards/${boardId}/records`)).body.items.find((r) => r.values.serial === "Brand New Customer")?.id;
    assert.ok(await wait(`fetch("/api/v1/boards/${boardId}/records").then((r) => r.json()).then((x) => x.items.some((r) => r.values.serial === "Brand New Customer"))`, 10000), "saved");
    const id = await serverId();
    assert.match(id, HEX);
    const rowId = () => b.evaluate(`(() => { const row = [...document.querySelectorAll("tr[data-record-context]")].find((r) => r.textContent.includes("Brand New Customer")); return row?.querySelector("td.record-id-cell code")?.textContent || row?.querySelector("td.record-id-cell")?.textContent || ""; })()`);
    assert.ok(await wait(`(() => { const row = [...document.querySelectorAll("tr[data-record-context]")].find((r) => r.textContent.includes("Brand New Customer")); return row?.querySelector("td.record-id-cell code")?.textContent === ${JSON.stringify(id)}; })()`, 8000), `the row shows its ID (${await rowId()})`);
    await openBoard(DESKTOP);
    assert.equal(await rowId(), id, "unchanged after a reload");
    // Another employee (sign out, sign in as someone else with access to the workspace).
    const other = await b.evaluate(`fetch("/api/v1/me").then((r) => r.json()).then((x) => x.user.id)`);
    assert.ok(other);
    assert.equal(await signIn(OTHER, "Otto Other", false), 201);
    const otherUser = await b.evaluate(`fetch("/api/v1/me").then((r) => r.json()).then((x) => x.user.id)`);
    assert.equal(await signIn(OID, "Rhea Records", true), 201);
    assert.equal((await api("POST", `/api/v1/workspaces/${wsId}/members`, { userId: otherUser, role: "VIEWER" })).status, 201);
    assert.equal(await signIn(OTHER, "Otto Other", false), 201);
    await openBoard(DESKTOP);
    assert.equal(await rowId(), id, "the same ID for another employee");
    assert.deepEqual((await shownIds()).sort(), [...ids, id].sort());
    assert.equal(await signIn(OID, "Rhea Records", true), 201);
  });

  test("search for an exact Record ID; sort by Record ID; hide it for yourself and show it again", async () => {
    await openBoard(DESKTOP);
    const target = ids[1];
    await b.evaluate(`(() => { const i = document.querySelector("#board-search"); i.value = ${JSON.stringify(target)}; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    assert.ok(await wait(`(() => { const rows = [...document.querySelectorAll("tr[data-record-context] td.record-id-cell code")].map((c) => c.textContent); return rows.length === 1 && rows[0] === ${JSON.stringify(target)}; })()`, 8000), "only that record");
    await b.evaluate(`(() => { const i = document.querySelector("#board-search"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    assert.ok(await wait("document.querySelectorAll('tr[data-record-context]').length >= 4", 8000));
    for (const dir of ["asc", "desc"]) {
      await click('[data-action="record-id-menu"]');
      assert.ok(await wait(`!!document.querySelector('.record-id-menu [data-action="sort-column"][data-direction="${dir}"]')`, 3000));
      await click(`.record-id-menu [data-action="sort-column"][data-direction="${dir}"]`);
      // The board is grouped: records are sorted within each group.
      const groups = JSON.parse(await b.evaluate(`JSON.stringify([...document.querySelectorAll(".editable-table tbody")].map((t) => [...t.querySelectorAll("tr[data-record-context] td.record-id-cell code")].map((c) => c.textContent)).filter((g) => g.length))`));
      assert.ok(groups.flat().length >= 4, "every record shown");
      for (const shown of groups) { const sorted = [...shown].sort(); assert.deepEqual(shown, dir === "asc" ? sorted : sorted.reverse(), `sorted ${dir} within its group`); }
      assert.ok(groups.some((g) => g.length >= 3), "a group with several records to compare");
      assert.equal(await b.evaluate(`document.querySelector("th.record-id-col").getAttribute("aria-sort")`), dir === "asc" ? "ascending" : "descending");
    }
    await click('[data-action="record-id-menu"]');
    await click('.record-id-menu [data-action="record-id-visibility"][data-show="0"]');
    assert.ok(await wait("!document.querySelector('th.record-id-col') && !document.querySelector('td.record-id-cell')", 3000), "hidden");
    assert.ok(await has('tr[data-record-context] [data-action="record-menu"]'), "the rest of the table is fine");
    await openBoard(DESKTOP).catch(() => {});
    assert.equal(await has("th.record-id-col"), false, "still hidden after a reload, for this person");
    // The toolbar's Columns picker shows it again.
    await click('[data-action="column-picker"]');
    assert.ok(await wait(`!!document.querySelector('.column-picker [data-action="record-id-toggle"]')`, 3000), "the Columns picker lists Record ID");
    assert.equal(await b.evaluate(`document.querySelector('.column-picker [data-action="record-id-toggle"]').checked`), false);
    await b.evaluate(`(() => { const box = document.querySelector('.column-picker [data-action="record-id-toggle"]'); box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    assert.ok(await wait("!!document.querySelector('th.record-id-col')", 3000), "shown again");
    assert.ok(await has(".column-picker"), "the picker stays open");
  });

  test("column drag-and-drop still works; Record ID is never a drop target, never dragged and never edited", async () => {
    await openBoard(DESKTOP);
    const order = () => b.evaluate(`JSON.stringify([...document.querySelectorAll(".editable-table thead th[data-column-key]")].map((t) => t.dataset.columnKey))`).then(JSON.parse);
    const centre = (sel) => b.evaluate(`JSON.stringify((() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left + 8 }; })())`).then(JSON.parse);
    // A real mouse drag (pointer events), as a person does it.
    const drag = async (from, to) => {
      await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
      await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 8; i++) await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8, button: "left", buttons: 1 });
      await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
    };
    const before = await order();
    assert.deepEqual(before.slice(0, 3), ["serial", "ref", "status"]);
    assert.ok(!before.includes("__record_id"), "Record ID isn't one of the board's columns");
    // Status onto the left half of Item ID: Status moves before it, in the table and on the server.
    const item = await centre('th[data-column-key="ref"] .column-label');
    await drag(await centre('th[data-column-key="status"] .column-label'), { x: item.left, y: item.y });
    assert.ok(await wait(`[...document.querySelectorAll(".editable-table thead th[data-column-key]")].map((t) => t.dataset.columnKey).slice(0, 3).join() === "serial,status,ref"`, 5000), `moved: ${await order()}`);
    assert.ok(await wait(`fetch("/api/v1/boards/${boardId}").then((r) => r.json()).then((x) => x.board.columns.map((c) => c.key).join() === "serial,status,ref")`, 8000), "saved");
    // Item ID dropped on the Record ID header: nothing moves, Record ID stays last, and the board keeps its columns.
    await drag(await centre('th[data-column-key="ref"] .column-label'), await centre("th.record-id-col .column-label"));
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual((await order()).slice(0, 3), ["serial", "status", "ref"], "a drop on Record ID does nothing");
    assert.equal(await b.evaluate(`document.querySelector("th.record-id-col").nextElementSibling?.classList.contains("add-column-col")`), true, "Record ID stays at the end of the board's columns");
    // Dragging Record ID itself does nothing either.
    await drag(await centre("th.record-id-col .column-label"), await centre('th[data-column-key="serial"] .column-label'));
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual((await order()).slice(0, 3), ["serial", "status", "ref"]);
    const server = (await api("GET", `/api/v1/boards/${boardId}`)).body.board.columns.map((c) => c.key);
    assert.deepEqual(server, ["serial", "status", "ref"], "Record ID was never added to the board");
    // Not an ordinary editable column: no movable header, no column menu, no editor when its cell is clicked or typed into.
    assert.equal(await has("th.record-id-col.is-movable, th.record-id-col [data-action=\"column-menu\"]"), false);
    await b.evaluate(`document.querySelector("tr[data-record-context] td.record-id-cell code").click()`);
    await b.evaluate(`document.querySelector("tr[data-record-context] td.record-id-cell").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await has("td.record-id-cell input, td.record-id-cell textarea, td.record-id-cell.is-editing, .cell-input:focus"), false, "nothing opens to edit it");
    await click('[data-action="column-picker"]');
    assert.ok(await wait("!!document.querySelector('.column-picker .column-pick-list')", 3000));
    assert.ok(!(await text(".column-picker .column-pick-list")).includes("Record ID"), "not listed among the board's columns");
    assert.ok(await has('.column-picker [data-action="record-id-toggle"]'), "only as the separate system switch");
    // Put the columns back as they were.
    const ref = await centre('th[data-column-key="ref"] .column-label'), status = await centre('th[data-column-key="status"] .column-label');
    await b.evaluate("document.querySelector('#overlay-root').innerHTML = ''");
    await drag(ref, { x: status.left, y: status.y });
    assert.ok(await wait(`fetch("/api/v1/boards/${boardId}").then((r) => r.json()).then((x) => x.board.columns.map((c) => c.key).join() === "serial,ref,status")`, 8000), "restored");
  });

  test("with API tokens off: the Record ID column and Copy Record ID stay; API Information isn't offered", async () => {
    const off = await start({});
    try {
      await b.open(`${off.url}/api/v1/health`, DESKTOP);
      assert.equal(await signIn(OID, "Rhea Records", true), 201);
      const ws = await api("POST", "/api/v1/workspaces", { name: "Off" });
      const bd = await api("POST", `/api/v1/workspaces/${ws.body.workspace.id}/boards`, { name: "Customer Database" });
      await api("POST", `/api/v1/boards/${bd.body.board.id}/records/batch`, { records: [1, 2, 3].map((i) => ({ values: { serial: `Off ${i}` } })) });
      await b.open(`${off.url}/`, DESKTOP);
      assert.ok(await wait("!!document.querySelector('.app-shell')", 15000));
      await b.evaluate(`(() => { const el = [...document.querySelectorAll("#sidebar .tree-item, #sidebar button, button, a")].find((e) => /Customer Database/.test(e.textContent) && !e.closest(".popover")); el?.click(); })()`);
      assert.ok(await wait("document.querySelectorAll('td.record-id-cell code').length === 3", 10000));
      await click('tr[data-record-context] [data-action="record-menu"]');
      assert.ok(await wait("!!document.querySelector('.record-menu-popover [data-action=\"copy-record-id\"]')", 3000));
      assert.equal(await has('.record-menu-popover [data-action="apitok-record-info"]'), false);
    } finally { off.proc.kill(); }
  });
});
