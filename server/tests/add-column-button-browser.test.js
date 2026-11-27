// The header's Add Column "+" in the REAL app, in a headless browser, on the fake MongoDB (role_based, synthetic data).
// Regression for boards whose columns are wider than the screen: on desktop (table-layout: fixed) the "+" cell got no width
// and the button sat under the sticky record-actions column, so it was in the page but couldn't be seen or clicked. Every
// board shape must show the same "+" right after its last visible column (Record ID when shown), reachable with a real
// pointer: narrow and wide, small and large (row window and server paging), grouped and ungrouped, Main Table and a saved
// view with hidden columns, Excel-import / monday-migration / manual shapes; desktop and 390 px phone, light and dark.
// A viewer gets no "+". Narrow boards keep their columns' own widths (spare width still goes to the "+" cell).
// ADDCOL_SHOTS=<folder> saves screenshots. Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const SHOTS = process.env.ADDCOL_SHOTS || "";
const slug = (name) => name.toLowerCase().replace(/\s+/g, "-");
const OIDS = { admin: "0e0e0e0e-0000-4000-8000-0000000000a1", vera: "0e0e0e0e-0000-4000-8000-0000000000a2" };
const many = (n, prefix, type = "text") => Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i + 1}`, label: `${prefix.toUpperCase()} ${i + 1}`, type }));
const SHAPES = {
  // A board made by hand: three columns, fits on screen.
  "Manual narrow": [{ key: "serial", label: "Item", type: "text", required: true }, { key: "state", label: "State", type: "status", options: ["Open", "Done"] }, { key: "qty", label: "Qty", type: "number" }],
  // Excel-import shape: many text columns.
  "Import wide": [{ key: "serial", label: "Name", type: "text", required: true }, ...many(24, "col")],
  // monday.com-migration shape: mixed types, several groups.
  "Migrated grouped": [{ key: "serial", label: "Name", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["Working on it", "Done", "Stuck"] }, { key: "due", label: "Due", type: "date" }, { key: "tags", label: "Tags", type: "dropdown", options: ["A", "B"] }, ...many(14, "txt"), ...many(4, "num", "number")],
  // Large board: past LARGE_BOARD_ROWS (row window) and loaded in server pages.
  "Large board": [{ key: "serial", label: "Name", type: "text", required: true }, ...many(10, "f")]
};

describe("Add Column + on every board shape (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, ws; const boards = {};
  const signIn = (br, who, isAdmin = false) => br.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${who}&email=${who}@example.invalid&admin=${isAdmin ? 1 : 0}&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const api = (br, method, p, body) => br.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const shot = async (br, name) => {
    if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true });
    const s = await br.send("Page.captureScreenshot", { format: "png" });
    if (s.result?.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(s.result.data, "base64"));
  };
  const openApp = async (br, { width = 1440, height = 900, theme = "light", pageSize = 0 } = {}) => {
    await br.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
    await br.open(`${base}/`, { width, height });
    assert.ok(await br.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "app shown");
    await br.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    if (pageSize) await br.evaluate(`ResourceApiAdapter.FULL_LOAD_LIMIT = ${pageSize}; ResourceApiAdapter.PAGE_SIZE = ${pageSize}`);
  };
  const openBoard = async (br, name, opts) => {
    await openApp(br, opts);
    await br.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes(${JSON.stringify(name)}))?.click()`);
    assert.ok(await br.waitFor("document.querySelectorAll('.editable-table tbody tr[data-record-context]').length > 0", 15000), `${name}: rows`);
    await sleep(400);
  };
  // Where the "+" is once the table is scrolled to its end, and what a pointer at its centre would hit. Desktop and tablet pin
  // the record-actions column to the right, so the end of the scroll is where the + shows. Phones scroll that column with
  // the table (and keep the first columns pinned), so the table is scrolled just enough to bring the + to the right edge.
  const plus = async (br, shotName = "") => { const s = await br.evaluate(`(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t = document.querySelector(".editable-table"), wrap = t.closest(".table-wrap");
    wrap.scrollLeft = wrap.scrollWidth; await frame();
    const btn = t.querySelector('thead [data-action="add-column"]');
    if (!btn) return { present: false, headerCell: !!t.querySelector("thead th.add-column-col") };
    const th = btn.closest("th"), prev = th.previousElementSibling, act = t.querySelector("thead th.actions-col");
    const pinned = getComputedStyle(act).position === "sticky" && getComputedStyle(act).right !== "auto";
    if (!pinned) { wrap.scrollLeft -= wrap.getBoundingClientRect().right - 8 - btn.getBoundingClientRect().right; await frame(); }
    const r = btn.getBoundingClientRect(), a = act.getBoundingClientRect(), p = prev.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
    return { present: true, cellWidth: Math.round(th.getBoundingClientRect().width), hit: hit === btn || btn.contains(hit), clearOfActions: r.right <= a.left + 0.5,
      hitDesc: hit ? hit.tagName + "." + String(hit.className).slice(0, 40) : null, sw: wrap.scrollWidth, cw: wrap.clientWidth, pinned,
      afterLast: r.left >= p.right - 0.5, prev: prev.dataset.systemColumn || prev.dataset.columnKey, overflow: wrap.scrollWidth > wrap.clientWidth + 1, x, y };
  })()`); if (shotName) await shot(br, shotName); return s; };
  const expectReachable = (s, label, lastKey = "record-id") => {
    if (process.env.ADDCOL_DEBUG) console.log(label, JSON.stringify(s));
    assert.equal(s.present, true, `${label}: + rendered`);
    assert.ok(s.cellWidth >= 48, `${label}: the + cell has room (${s.cellWidth}px)`);
    assert.equal(s.hit, true, `${label}: a pointer at the + reaches it (not covered)`);
    assert.equal(s.clearOfActions, true, `${label}: + left of the record-actions column`);
    assert.equal(s.afterLast, true, `${label}: + right after the last visible column`);
    assert.equal(s.prev, lastKey, `${label}: the column before the + is ${lastKey}`);
  };
  // A real click (or tap on a phone) at the +'s centre opens the existing Column picker; Escape closes it, nothing created.
  const pressPlus = async (br, s, { touch = false } = {}) => {
    if (touch) await br.tap(s.x, s.y);
    else { for (const type of ["mousePressed", "mouseReleased"]) await br.send("Input.dispatchMouseEvent", { type, x: s.x, y: s.y, button: "left", clickCount: 1 }); }
    const opened = await br.waitFor("!!document.querySelector('#overlay-root .column-picker, #overlay-root .column-chooser')", 4000);
    await br.key("Escape"); await sleep(150);
    return opened;
  };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER);
    await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn(b, "admin", true);
    ws = (await api(b, "POST", "/workspaces", { name: "Plus check" })).body.workspace;
    for (const [name, columns] of Object.entries(SHAPES)) {
      const groups = name === "Migrated grouped" ? [{ name: "North" }, { name: "South" }, { name: "East" }, { name: "West" }] : undefined;
      const res = await api(b, "POST", `/workspaces/${ws.id}/boards`, { name, columns, ...(groups ? { groups } : {}) });
      assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 200)); boards[name] = res.body.board;
      const total = name === "Large board" ? 260 : name === "Migrated grouped" ? 60 : 12, board = res.body.board;
      for (let start = 0; start < total; start += 130) {
        const records = Array.from({ length: Math.min(130, total - start) }, (_, i) => ({ values: { serial: `Synthetic ${start + i + 1}` }, groupId: board.groups[(start + i) % board.groups.length].id }));
        assert.equal((await api(b, "POST", `/boards/${board.id}/records/batch`, { records })).status, 201);
      }
    }
    // A saved view on the wide board that hides its last columns: the + follows the view's last visible column.
    const wide = (await api(b, "GET", `/boards/${boards["Import wide"].id}`)).body.board;
    const view = await api(b, "PATCH", `/boards/${wide.id}`, { expectedVersion: wide.version, savedViews: [{ name: "Short view", state: { view: "table", hiddenColumns: ["col20", "col21", "col22", "col23", "col24"] } }] });
    assert.equal(view.status, 200, JSON.stringify(view.body).slice(0, 200));
  });
  after(async () => { await b?.close(); server?.kill(); });

  test("desktop, light: the + is visible and clickable after the last column on every board shape", async () => {
    for (const name of Object.keys(SHAPES)) {
      await openBoard(b, name, { pageSize: name === "Large board" ? 50 : 0 });
      const s = await plus(b, `desktop-light-${slug(name)}`);
      expectReachable(s, name);
      if (name !== "Manual narrow") assert.equal(s.overflow, true, `${name}: scrolls sideways`);
      assert.equal(await pressPlus(b, s), true, `${name}: a real click on the + opens the column picker`);
    }
  });

  test("a narrow board keeps its columns' own widths; spare width still goes to the + cell", async () => {
    await openBoard(b, "Manual narrow");
    const w = await b.evaluate(`(() => { const th = (k) => Math.round(document.querySelector('.editable-table thead th[data-column-key="' + k + '"]').getBoundingClientRect().width); return { serial: th("serial"), state: th("state"), qty: th("qty"), plus: Math.round(document.querySelector(".editable-table thead th.add-column-col").getBoundingClientRect().width) }; })()`);
    assert.deepEqual({ serial: w.serial, state: w.state, qty: w.qty }, { serial: 260, state: 160, qty: 120 }, "type widths unchanged");
    assert.ok(w.plus > 120, `the + cell takes the spare width (${w.plus}px)`);
  });

  test("saved view with hidden columns: the + follows the view's last visible column", async () => {
    await openBoard(b, "Import wide");
    await b.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((x) => x.textContent.includes("Short view"))?.click()`);
    assert.ok(await b.waitFor("!document.querySelector('.editable-table thead th[data-column-key=\"col24\"]')", 8000), "view applied");
    await sleep(300);
    const s = await plus(b, "desktop-light-saved-view");
    expectReachable(s, "Short view");
    const order = await b.evaluate(`[...document.querySelectorAll('.editable-table thead th')].slice(-4).map((th) => th.dataset.columnKey || th.dataset.systemColumn || th.className)`);
    assert.deepEqual(order, ["col19", "record-id", "add-column-col", "actions-col"]);
    assert.equal(await pressPlus(b, s), true, "a real click opens the picker in the view");
  });

  test("desktop, dark: wide and grouped boards", async () => {
    for (const name of ["Import wide", "Migrated grouped"]) {
      await openBoard(b, name, { theme: "dark" });
      const s = await plus(b, `desktop-dark-${slug(name)}`); expectReachable(s, `${name} (dark)`);
    }
  });

  test("390 px phone, light and dark: the + is reachable by a tap on wide and narrow boards", async () => {
    for (const theme of ["light", "dark"]) {
      for (const name of ["Import wide", "Manual narrow"]) {
        await openBoard(b, name, { width: 390, height: 844, theme });
        const s = await plus(b, `mobile-${theme}-${slug(name)}`); expectReachable(s, `${name} 390 px ${theme}`);
        assert.equal(await b.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true, "no page-level sideways scroll");
        if (theme === "light") assert.equal(await pressPlus(b, s, { touch: true }), true, `${name}: a tap on the + opens the picker`);
      }
    }
  });

  test("a viewer gets no + (header cell kept empty), the same on every board shape", async () => {
    await b.close();
    b = await launch(BROWSER);
    await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn(b, "vera");
    const veraId = (await api(b, "GET", "/me")).body.user.id;
    await b.close();
    b = await launch(BROWSER);
    await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn(b, "admin", true);
    assert.equal((await api(b, "POST", `/workspaces/${ws.id}/members`, { userId: veraId, role: "VIEWER" })).status, 201);
    await b.close();
    b = await launch(BROWSER);
    await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn(b, "vera");
    for (const name of ["Manual narrow", "Import wide"]) {
      await openBoard(b, name);
      const s = await plus(b);
      assert.deepEqual(s, { present: false, headerCell: true }, `${name}: no + for a viewer`);
      assert.equal(await b.evaluate(`!!document.querySelector('[data-action="add-column"]')`), false, `${name}: no add-column control anywhere`);
    }
  });
});
