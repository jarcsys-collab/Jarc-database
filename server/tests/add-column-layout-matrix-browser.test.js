// The Add Column "+" and the table's minimum width across the owner's board matrix, in the REAL app in ONE headless browser,
// in-process on the fake MongoDB (role_based, synthetic data only). Every visibility assertion uses tests/support/interactable.js
// (real visibility, size, viewport/scroll reachability, clipping, elementFromPoint obstruction, focus), never DOM existence,
// and clicks are real DevTools pointer events at the control's centre.
//   boards: wide Excel-import shape (ungrouped), wide monday.com-migrated (source flag, grouped), large server-paginated (2,100),
//           narrow manual board; Main Table and a saved view with hidden columns
//   widths: 1,000 / 1,025 / 1,440 (below / at / above the desktop layout's 1,025 px), 390 px phone; light and dark
//   also: locked Record ID before the +, sticky actions and Item columns, horizontal scrolling, a viewer gets no +, the type
//   picker and the toolbar Columns picker open and close, T0 column filters, a B1 refused save keeps the rows, and
//   --columns-width (the table's minimum width) stays exact after hide, show, resize, add, delete and reorder.
// Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { ObjectId } = require("mongodb");
const { createApp } = require("../src/app");
const { MemoryStateRepository } = require("../src/repositories/memory-state-repository");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { createEntraVerifier } = require("../src/auth/entra-token");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FakeMongoClient } = require("./support/fake-mongo");
const { findBrowser, launch, sleep, freePort } = require("./support/headless-browser");
const { verifyControl, checkInteractable, realClick, summary } = require("./support/interactable");

const BROWSER = findBrowser();
const DEBUG = Boolean(process.env.ADDCOL_DEBUG);
const OIDS = { admin: "0e0e0e0e-0000-4000-8000-0000000000b1", vera: "0e0e0e0e-0000-4000-8000-0000000000b2" };
const many = (n, prefix, type = "text") => Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i + 1}`, label: `${prefix.toUpperCase()} ${i + 1}`, type }));
const BOARDS = {
  "Import wide": { columns: [{ key: "serial", label: "Name", type: "text", required: true }, ...many(24, "col")], records: 12 },
  "Migrated wide": { columns: [{ key: "serial", label: "Name", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["Working on it", "Done", "Stuck"] }, { key: "due", label: "Due", type: "date" }, { key: "tags", label: "Tags", type: "dropdown", options: ["A", "B"] }, ...many(14, "txt"), ...many(4, "num", "number")], records: 40, groups: ["North", "South", "East", "West"], source: true },
  "Large paged": { columns: [{ key: "serial", label: "Name", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["New", "Done"] }, ...many(9, "f")], records: 2100 },
  "Manual narrow": { columns: [{ key: "serial", label: "Item", type: "text", required: true }, { key: "state", label: "State", type: "status", options: ["Open", "Done"] }, { key: "qty", label: "Qty", type: "number" }], records: 8 }
};
const PLUS = '.editable-table thead [data-action="add-column"]';
const TYPE_PICKER = "!!document.querySelector('#overlay-root .column-picker .column-picker-option')";
const NO_OVERLAY = "!document.querySelector('#overlay-root .column-picker, #overlay-root .column-menu-popover, #overlay-root .modal, #overlay-root .popover')";

describe("Add Column + and table minimum width across the board matrix (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let app, server, base, b, ws, connection; const boards = {};
  const page = () => ({ evaluate: (e) => b.evaluate(e), send: (m, p) => b.send(m, p) });
  const signIn = (who, isAdmin = false) => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${who}&email=${who}@example.invalid&admin=${isAdmin ? 1 : 0}&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: r.status === 204 ? null : await r.json() }; })()`);
  const freshBrowser = async (who, isAdmin) => { await b?.close(); b = await launch(BROWSER); await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn(who, isAdmin); };
  const openBoard = async (name, { width = 1440, height = 900, theme = "light" } = {}) => {
    await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
    await b.open(`${base}/`, { width, height });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "app shown");
    await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes(${JSON.stringify(name)}))?.click()`);
    assert.ok(await b.waitFor("document.querySelectorAll('.editable-table tbody tr[data-record-context]').length > 0", 20000), `${name}: rows`);
    // The app re-applies its own (light) theme on every render: keep the page in the theme under test.
    await b.evaluate(`(() => { const d = document.documentElement, t = ${JSON.stringify(theme)}; d.dataset.theme = t; new MutationObserver(() => { if (d.dataset.theme !== t) d.dataset.theme = t; }).observe(d, { attributes: true, attributeFilter: ["data-theme"] }); })()`);
    await sleep(350);
  };
  // The user's own move: scroll the table's real scroll container to its right end (the helper then brings the + into view).
  const scrollTableEnd = () => b.evaluate("(async () => { const w = document.querySelector('.editable-table').closest('.table-wrap'); w.scrollLeft = w.scrollWidth; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return { sw: w.scrollWidth, cw: w.clientWidth, left: Math.round(w.scrollLeft) }; })()");
  // The layout facts the + depends on: header order, sticky columns, overflow, and the table's minimum width.
  const layout = () => b.evaluate(`(() => {
    const t = document.querySelector(".editable-table"), wrap = t.closest(".table-wrap"), head = [...t.querySelectorAll("thead tr:first-child > th")];
    const keyOf = (th) => th.dataset.columnKey || th.dataset.systemColumn || [...th.classList].find((c) => c.endsWith("-col")) || th.className;
    const data = head.filter((th) => th.dataset.columnKey), w = (sel) => { const el = t.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().width * 10) / 10 : null; };
    const plusTh = t.querySelector("thead th.add-column-col"), rid = !!t.querySelector("thead th.record-id-col");
    const act = getComputedStyle(t.querySelector("thead th.actions-col")), first = getComputedStyle(t.querySelector("thead th.is-primary"));
    return { order: head.map(keyOf), dataKeys: data.map((th) => th.dataset.columnKey), varPx: parseFloat(t.style.getPropertyValue("--columns-width")),
      styleSum: data.reduce((s, th) => s + parseFloat(th.style.width), 0), renderedSum: Math.round(data.reduce((s, th) => s + th.getBoundingClientRect().width, 0) * 10) / 10,
      minWidth: getComputedStyle(t).minWidth, tableWidth: Math.round(t.getBoundingClientRect().width), rid, check: w("thead th.check-col"), actions: w("thead th.actions-col"), recordId: w("thead th.record-id-col"),
      plusCell: plusTh ? Math.round(plusTh.getBoundingClientRect().width) : null, actionsSticky: act.position === "sticky" && act.right !== "auto", itemSticky: first.position === "sticky",
      wrapOverflow: wrap.scrollWidth - wrap.clientWidth, wrapClient: wrap.clientWidth, pageOverflow: document.documentElement.scrollWidth - innerWidth, width: innerWidth };
  })()`);
  // --columns-width is exactly the visible columns' set widths; each rendered header has that width; on desktop the table's
  // min-width is that plus check (72) + "+" (56) + actions (78) [+ Record ID (236)], which are the rendered widths of those cells.
  const expectExactMinWidth = (l, label, desktop = l.width >= 1025) => {
    if (DEBUG) console.log(label, JSON.stringify(l));
    assert.equal(l.varPx, l.styleSum, `${label}: --columns-width (${l.varPx}) = the visible columns' widths (${l.styleSum})`);
    // Below 1,025 px the table lays out automatically (content may widen a column) and has no min-width rule.
    if (!desktop) return;
    assert.ok(Math.abs(l.renderedSum - l.varPx) <= 1, `${label}: rendered headers (${l.renderedSum}) = --columns-width (${l.varPx})`);
    const fixed = 72 + 56 + 78 + (l.rid ? 236 : 0);
    assert.equal(l.minWidth, `${l.varPx + fixed}px`, `${label}: table min-width = columns + ${fixed}`);
    assert.ok(l.plusCell >= 56, `${label}: the + cell keeps at least 56 px (${l.plusCell})`);
    assert.ok(l.tableWidth >= l.varPx + fixed - 1, `${label}: the table is at least its min-width`);
    // No unexpected sideways overflow: the table is exactly as wide as the screen area or its columns need, never wider.
    assert.ok(l.tableWidth <= Math.max(l.wrapClient, l.varPx + fixed) + 1, `${label}: table ${l.tableWidth}px, area ${l.wrapClient}px, needed ${l.varPx + fixed}px`);
    assert.deepEqual([Math.round(l.check), Math.round(l.actions), l.rid ? Math.round(l.recordId) : null], [72, 78, l.rid ? 236 : null], `${label}: the fixed cells have the widths the min-width assumes`);
  };
  // The + itself, measured by the shared helper; optionally a real click that must open the type picker, then a real Escape.
  const plusUsable = async (label, { click = true, touch = false } = {}) => {
    await scrollTableEnd();
    const r = await verifyControl(page(), PLUS, click ? { click: touch ? "touch" : true, expect: TYPE_PICKER, minWidth: 20, minHeight: 20 } : { minWidth: 20, minHeight: 20 });
    if (DEBUG) console.log(label, JSON.stringify(summary(r)));
    assert.equal(r.ok, true, `${label}: + usable ${JSON.stringify(summary(r))}`);
    assert.ok(await b.waitFor(NO_OVERLAY, 3000), `${label}: closed, nothing chosen`);
    return r;
  };

  before(async () => {
    const issuer = await createTokenIssuer();
    const port = await freePort();
    base = `http://localhost:${port}`;
    const entra = { ...issuer.config, redirectUri: `${base}/`, appOrigin: base };
    const fake = new FakeMongoClient();
    connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
    await connection.connect();
    await ensureDatabase(connection.db);
    const dataLayer = createDataLayer({ connection, logger: { error() {} }, fileStore: new MemoryFileStore(), recordSearch: "off" });
    app = createApp({ repository: new MemoryStateRepository(), environment: "test", dataLayer, auth: { mode: "entra", entra, verify: createEntraVerifier({ ...entra, keySet: issuer.keySet }) }, accessPolicy: "role_based", logger: { error() {} } });
    const outer = express();
    outer.get("/__test/id-token", async (req, res) => {
      const email = String(req.query.email || "");
      const claims = { oid: String(req.query.oid), name: String(req.query.name || ""), email, preferred_username: email, nonce: String(req.query.nonce || "") };
      if (req.query.admin === "1") claims.roles = ["JARC.Admin"];
      res.set("Cache-Control", "no-store").json({ token: await issuer.token(claims) });
    });
    outer.use((req, res, next) => app(req, res, next));
    server = await new Promise((resolve) => { const s = outer.listen(port, "127.0.0.1", () => resolve(s)); });
    await freshBrowser("admin", true);
    ws = (await api("POST", "/workspaces", { name: "Layout matrix" })).body.workspace;
    for (const [name, spec] of Object.entries(BOARDS)) {
      const res = await api("POST", `/workspaces/${ws.id}/boards`, { name, columns: spec.columns, ...(spec.groups ? { groups: spec.groups.map((g) => ({ name: g })) } : {}) });
      assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 200)); const board = res.body.board; boards[name] = board;
      for (let start = 0; start < spec.records; start += 500) {
        const records = Array.from({ length: Math.min(500, spec.records - start) }, (_, i) => ({ values: { serial: `Synthetic ${start + i + 1}`, ...(name === "Manual narrow" ? { state: "Open", qty: i } : {}) }, groupId: board.groups[(start + i) % board.groups.length].id }));
        assert.equal((await api("POST", `/boards/${board.id}/records/batch`, { records })).status, 201);
      }
      // A monday.com-migrated board: the source flag the migration stores (editable after the move).
      if (spec.source) await connection.db.collection("boards").updateOne({ _id: new ObjectId(board.id) }, { $set: { source: { provider: "monday", sourceBoardId: "9000000001", readOnly: false } } });
    }
    assert.equal((await api("GET", `/boards/${boards["Migrated wide"].id}`)).body.board.source?.provider, "monday", "migrated board carries the source flag");
    const wide = (await api("GET", `/boards/${boards["Import wide"].id}`)).body.board;
    const view = await api("PATCH", `/boards/${wide.id}`, { expectedVersion: wide.version, savedViews: [{ name: "Short view", state: { view: "table", hiddenColumns: ["col20", "col21", "col22", "col23", "col24"] } }] });
    assert.equal(view.status, 200, JSON.stringify(view.body).slice(0, 200));
  });
  after(async () => { await b?.close(); app?.locals?.realtime?.closeAll?.(); await new Promise((r) => (server ? server.close(r) : r())); });

  test("desktop 1,000 / 1,025 / 1,440 (light): on every board the + is visible, unobstructed, focusable, and a real click opens the picker", async () => {
    for (const width of [1000, 1025, 1440]) {
      for (const name of Object.keys(BOARDS)) {
        await openBoard(name, { width });
        const label = `${name} @${width}`;
        await plusUsable(label);
        const l = await layout();
        expectExactMinWidth(l, label);
        assert.deepEqual(l.order.slice(-3), ["record-id", "add-column-col", "actions-col"], `${label}: locked Record ID, then +, then actions`);
        assert.equal(l.actionsSticky, true, `${label}: the actions column is pinned right`);
        assert.ok(l.pageOverflow <= 1, `${label}: no page-level sideways scroll (${l.pageOverflow})`);
        // A narrow board scrolls only when its columns don't fit the table area (at 1,025 px beside the sidebar), and then only by
        // what they need (checked in expectExactMinWidth); at 1,440 it fits.
        if (name === "Manual narrow") { if (DEBUG) console.log(label, "narrow overflow", l.wrapOverflow, "area", l.wrapClient); if (width === 1440) assert.ok(l.wrapOverflow <= 1, `${label}: a narrow board does not scroll sideways (${l.wrapOverflow})`); }
        else assert.ok(l.wrapOverflow > 100, `${label}: a wide board scrolls sideways inside the table`);
      }
    }
  });

  test("large board (2,100 records) loads in server pages; the + works after scrolling down and to the end", async () => {
    await openBoard("Large paged");
    const rows = await b.evaluate("document.querySelectorAll('.editable-table tbody tr[data-record-context]').length");
    assert.ok(rows > 0 && rows < 2100, `only a window of rows is rendered (${rows})`);
    for (let i = 0; i < 4; i += 1) { await b.evaluate("(() => { const w = document.querySelector('.table-wrap'); w.scrollTop = w.scrollHeight; })()"); await sleep(300); }
    await plusUsable("Large paged, scrolled down");
    expectExactMinWidth(await layout(), "Large paged, scrolled down");
  });

  test("sticky Item column holds and the + is reached by horizontal scrolling; the actions column never covers it", async () => {
    for (const name of ["Import wide", "Migrated wide"]) {
      await openBoard(name);
      const before = await b.evaluate("(() => { const t = document.querySelector('.editable-table'), w = t.closest('.table-wrap'); w.scrollLeft = 0; return { item: t.querySelector('thead th.is-primary').getBoundingClientRect().left, sticky: document.documentElement.dataset.stickyColumn }; })()");
      const start = await checkInteractable(page(), PLUS, { scroll: false, focus: false });
      assert.equal(start.inViewport && !start.obstructed && !start.clippedBy, false, `${name}: before scrolling the + is off to the right (clipped or covered)`);
      const end = await scrollTableEnd();
      assert.ok(end.left > 0, `${name}: the table scrolled sideways`);
      assert.equal(before.sticky, "on", `${name}: the sticky first column is on (default)`);
      const item = await checkInteractable(page(), ".editable-table thead th.is-primary .column-label", { scroll: false, focus: false });
      assert.equal(item.ok, true, `${name}: after scrolling to the end the sticky Item header is still shown, unclipped and uncovered ${JSON.stringify(summary(item))}`);
      const cellItem = await checkInteractable(page(), ".editable-table tbody tr[data-record-context] td[data-column-key=serial] .cell-display", { scroll: false, focus: false });
      assert.equal(cellItem.ok, true, `${name}: the sticky Item cells too ${JSON.stringify(summary(cellItem))}`);
      const r = await checkInteractable(page(), PLUS, { scroll: false });
      assert.equal(r.ok, true, `${name}: at the end of the scroll the + is usable without further scrolling ${JSON.stringify(summary(r))}`);
      const actions = await checkInteractable(page(), ".editable-table tbody tr[data-record-context] [data-action=record-menu]", { focus: false, scroll: false });
      assert.equal(actions.sized && actions.inViewport, true, `${name}: the pinned actions column is shown at the right`);
    }
  });

  test("dark mode at 1,440 and 390 px: the + is usable on wide, grouped and narrow boards", async () => {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      for (const name of ["Import wide", "Migrated wide", "Manual narrow"]) {
        await openBoard(name, { width, height, theme: "dark" });
        await plusUsable(`${name} dark @${width}`, { touch: width < 768 });
        const bg = await b.evaluate("getComputedStyle(document.querySelector('.editable-table thead th.is-primary')).backgroundColor");
        const [cr, cg, cb] = bg.match(/[\d.]+/g).map(Number), lum = (0.2126 * cr + 0.7152 * cg + 0.0722 * cb) / 255;
        assert.ok(lum < 0.3, `${name} dark @${width}: a dark surface (${lum.toFixed(2)})`);
      }
    }
  });

  test("390 px phone (light): a tap on the + opens the picker on every board; no page-level sideways scroll", async () => {
    for (const name of Object.keys(BOARDS)) {
      await openBoard(name, { width: 390, height: 844 });
      await plusUsable(`${name} @390`, { touch: true });
      const l = await layout();
      expectExactMinWidth(l, `${name} @390`, false);
      assert.ok(l.pageOverflow <= 1, `${name} @390: no page-level sideways scroll (${l.pageOverflow})`);
    }
  });

  test("saved view with hidden columns: + after the view's last column; --columns-width counts only the view's columns", async () => {
    await openBoard("Import wide");
    await b.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((x) => x.textContent.includes("Short view"))?.click()`);
    assert.ok(await b.waitFor("!document.querySelector('.editable-table thead th[data-column-key=\"col24\"]')", 8000), "view applied");
    await sleep(250);
    await plusUsable("Short view");
    const l = await layout();
    expectExactMinWidth(l, "Short view");
    assert.deepEqual(l.order.slice(-4), ["col19", "record-id", "add-column-col", "actions-col"]);
    assert.equal(l.varPx, 260 + 19 * 220, "Name + 19 text columns");
  });

  test("--columns-width stays exact after hide, show, resize (during and after the drag), add, delete and reorder", async () => {
    await openBoard("Import wide");
    let l = await layout(); expectExactMinWidth(l, "start");
    const startPx = l.varPx;
    const menu = async (key, action, extra = "") => {
      await b.evaluate(`document.querySelector('.editable-table thead th[data-column-key="${key}"] [data-action=column-menu]').click()`);
      assert.ok(await b.waitFor(`!!document.querySelector('.column-menu-popover [data-action="${action}"]${extra}')`, 3000), `${action} in the menu`);
      await b.evaluate(`document.querySelector('.column-menu-popover [data-action="${action}"]${extra}').click()`);
    };
    // Hide.
    await menu("col5", "hide-column");
    assert.ok(await b.waitFor("!document.querySelector('.editable-table thead th[data-column-key=col5]')", 4000));
    l = await layout(); expectExactMinWidth(l, "after hide"); assert.equal(l.varPx, startPx - 220);
    // Show again from the toolbar's Columns picker.
    await b.evaluate("document.querySelector('.board-tools [data-action=column-picker]').click()");
    assert.ok(await b.waitFor("!!document.querySelector('#overlay-root [data-action=column-toggle][data-key=col5]')", 3000));
    await b.evaluate("document.querySelector('#overlay-root [data-action=column-toggle][data-key=col5]').click()");
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table thead th[data-column-key=col5]')", 4000));
    await b.key("Escape"); await b.waitFor(NO_OVERLAY, 3000);
    l = await layout(); expectExactMinWidth(l, "after show"); assert.equal(l.varPx, startPx);
    // Resize with a real pointer drag: the variable follows the drag, and is exact after the save re-renders the table.
    const h = await b.evaluate("(() => { const el = document.querySelector('.editable-table thead th[data-column-key=col3] [data-action=resize-column]'); el.scrollIntoView({ inline: 'center', block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: h.x, y: h.y });
    await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: h.x, y: h.y, button: "left", buttons: 1, clickCount: 1 });
    for (const dx of [30, 60, 90]) { await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: h.x + dx, y: h.y, button: "left", buttons: 1 }); await sleep(30); }
    l = await layout(); expectExactMinWidth(l, "during the drag"); assert.equal(l.varPx, startPx + 90, "the variable follows the drag");
    await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: h.x + 90, y: h.y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(400);
    l = await layout(); expectExactMinWidth(l, "after resize"); assert.equal(l.varPx, startPx + 90);
    await plusUsable("after resize");
    // Add: a real click on the + and one type chosen (a local write on this synthetic board).
    await scrollTableEnd();
    const p = await checkInteractable(page(), PLUS);
    await realClick(page(), p.center.x, p.center.y);
    assert.ok(await b.waitFor(TYPE_PICKER, 4000));
    await b.evaluate("document.querySelector('#overlay-root .column-picker-option[data-type=\"number\"]').click()");
    assert.ok(await b.waitFor(`document.querySelectorAll('.editable-table thead th[data-column-key]').length === ${l.dataKeys.length + 1}`, 6000), "column added");
    await sleep(300); await b.key("Escape"); await sleep(200);
    l = await layout(); expectExactMinWidth(l, "after add"); assert.equal(l.varPx, startPx + 90 + 120, "+ a number column (120)");
    const added = l.dataKeys.find((k) => k.startsWith("custom_"));
    assert.ok(added, "the new column is shown");
    await plusUsable("after add");
    // Reorder: Move left from the menu.
    const beforeOrder = l.dataKeys.join(",");
    await menu("col2", "move-column-menu", '[data-direction="left"]');
    assert.ok(await b.waitFor(`[...document.querySelectorAll('.editable-table thead th[data-column-key]')].map((t) => t.dataset.columnKey).join(",") !== ${JSON.stringify(beforeOrder)}`, 4000), "reordered");
    l = await layout(); expectExactMinWidth(l, "after reorder"); assert.equal(l.varPx, startPx + 90 + 120);
    // Delete the added column (confirm when asked).
    await menu(added, "request-delete-column");
    if (await b.waitFor("!!document.querySelector('[data-action=confirm-delete-column]')", 1500)) await b.evaluate("document.querySelector('[data-action=confirm-delete-column]').click()");
    assert.ok(await b.waitFor(`!document.querySelector('.editable-table thead th[data-column-key="${added}"]')`, 5000), "deleted");
    await sleep(200);
    l = await layout(); expectExactMinWidth(l, "after delete"); assert.equal(l.varPx, startPx + 90);
    await plusUsable("after delete");
    // In a saved view: hide and resize are the view's own; the variable follows them too.
    await b.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((x) => x.textContent.includes("Short view"))?.click()`);
    assert.ok(await b.waitFor("!document.querySelector('.editable-table thead th[data-column-key=\"col24\"]')", 8000));
    await sleep(200);
    const viewStart = (await layout()).varPx;
    await menu("col7", "hide-column");
    assert.ok(await b.waitFor("!document.querySelector('.editable-table thead th[data-column-key=col7]')", 4000));
    l = await layout(); expectExactMinWidth(l, "view: after hide"); assert.equal(l.varPx, viewStart - 220);
    await plusUsable("view: after hide");
  });

  test("Columns picker (toolbar) and the + type picker open and close with real clicks and Escape", async () => {
    await openBoard("Migrated wide");
    const cols = await verifyControl(page(), '.board-tools [data-action="column-picker"]', { click: true, expect: "!!document.querySelector('#overlay-root [data-action=column-toggle-all]')" });
    assert.equal(cols.ok, true, `Columns picker ${JSON.stringify(summary(cols))}`);
    await plusUsable("Migrated wide type picker");
    const menuBtn = await verifyControl(page(), '.editable-table thead th[data-column-key="status"] [data-action="column-menu"]', { hover: "th", click: true, expect: "!!document.querySelector('#overlay-root .column-menu-popover')" });
    assert.equal(menuBtn.ok, true, `header menu ${JSON.stringify(summary(menuBtn))}`);
  });

  test("T0 column filter: rows filter, the + still works and the min-width is unchanged; clearing restores the rows", async () => {
    await openBoard("Manual narrow");
    const before = await layout();
    await b.evaluate("document.querySelector('th[data-column-key=serial] [data-action=column-menu]').click()"); await sleep(150);
    await b.evaluate("document.querySelector('[data-action=filter-column][data-key=serial]').click()");
    assert.ok(await b.waitFor("!!document.querySelector('form[data-action=column-filter-form]')", 3000));
    await b.evaluate("(() => { const f = document.querySelector('form[data-action=column-filter-form]'); f.querySelector('[name=op]').value = 'contains'; f.querySelector('[name=value]').value = 'Synthetic 1'; f.requestSubmit(); })()");
    assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length === 1", 5000), "filtered to one row");
    await plusUsable("with a column filter");
    const l = await layout(); expectExactMinWidth(l, "with a column filter"); assert.equal(l.varPx, before.varPx);
    await b.evaluate("document.querySelector('th[data-column-key=serial] [data-action=column-menu]').click()"); await sleep(150);
    await b.evaluate("document.querySelector('[data-action=clear-column-filter]').click()");
    assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length === 8", 5000), "filter cleared");
  });

  test("B1 refused save: the rows stay, the cell goes back, and the + and min-width are unchanged", async () => {
    await openBoard("Manual narrow");
    const before = await layout(), rows = () => b.evaluate("document.querySelectorAll('tr[data-record-context]').length");
    await b.evaluate("(() => { window.__fetch ||= window.fetch; window.__refuse = true; window.fetch = (u, i) => { if (window.__refuse && i?.method === 'PATCH' && String(u).includes('/records/')) { window.__refuse = false; return Promise.resolve(new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'x' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })); } return window.__fetch(u, i); }; })()");
    const cell = 'tr:has([aria-label="Item: Synthetic 3"]) td[data-column-key="state"]';
    await b.evaluate(`document.querySelector(${JSON.stringify(cell + " .cell-display")}).click()`); await sleep(200);
    await b.evaluate("document.querySelector('.cell-option[data-value=\"Done\"]').click()");
    assert.ok(await b.waitFor(`document.querySelector(${JSON.stringify(cell)})?.classList.contains('save-refused-flash') && document.querySelector(${JSON.stringify(cell)})?.textContent.trim() === 'Open'`, 8000), "refused cell shown");
    assert.equal(await rows(), 8, "every row still shown");
    await b.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove())");
    await plusUsable("after a refused save");
    const l = await layout(); expectExactMinWidth(l, "after a refused save"); assert.equal(l.varPx, before.varPx);
  });

  test("a viewer (no column creation permission) gets no + on any board; the Columns picker still works for them", async () => {
    await freshBrowser("vera");
    const veraId = (await api("GET", "/me")).body.user.id;
    await freshBrowser("admin", true);
    assert.equal((await api("POST", `/workspaces/${ws.id}/members`, { userId: veraId, role: "VIEWER" })).status, 201);
    await freshBrowser("vera");
    for (const name of ["Manual narrow", "Import wide", "Migrated wide"]) {
      await openBoard(name);
      await scrollTableEnd();
      const r = await checkInteractable(page(), PLUS);
      assert.equal(r.found, false, `${name}: no + for a viewer`);
      assert.equal(await b.evaluate("!!document.querySelector('.editable-table thead th.add-column-col')"), true, `${name}: the header cell is kept`);
      const l = await layout(); expectExactMinWidth(l, `${name} (viewer)`);
      const cols = await verifyControl(page(), '.board-tools [data-action="column-picker"]', { click: true, expect: "!!document.querySelector('#overlay-root [data-action=column-toggle-all]')" });
      assert.equal(cols.ok, true, `${name}: viewer's Columns picker ${JSON.stringify(summary(cols))}`);
    }
  });
});
