// T0 toolbar fixes in the REAL app in a headless browser, on the fake MongoDB (test server, synthetic data only):
//   - a phone (390 px): Filter and Sort are on screen, and their panels open inside the viewport, light and dark;
//   - the Sort button shows the number of sort levels while a sort is on (tinted, with an accessible name) and loses it
//     when the sort is cleared, in light and dark mode;
//   - a column-header filter marks a saved view changed, "Save to this view" stores it on the server, and after a reload
//     the view opens with it again.
// Skipped when no Chrome or Edge is installed.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "state", label: "State", type: "status", options: ["Open", "Done"] }, { key: "notes", label: "Notes", type: "text" }];
const OID = "0d0d0d0d-0000-4000-8000-000000000081";

describe("T0 toolbar fixes (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, board;
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken } ${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const rows = () => b.evaluate("document.querySelectorAll('tr[data-record-context]').length");
  // Shown, with a size, and wholly inside the viewport.
  const inViewport = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return "missing"; const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || !r.width || !r.height) return "hidden";
    return r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5 ? "ok" : "outside " + JSON.stringify([r.left, r.top, r.right, r.bottom, innerWidth, innerHeight]); })()`);
  const openBoard = async (width) => {
    await b.open(`${base}/`, { width, height: 760 });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "app shown");
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Toolbar board"))?.click()`);
    assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length === 6", 15000), "rows");
    await sleep(200);
  };
  const lum = (c) => { const [r, g, bl] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const contrast = (a, z) => { const [x, y] = [lum(a), lum(z)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER);
    await b.open(`${base}/api/v1/health`, { width: 1440 });
    await b.evaluate(`(async () => {
      const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
      const { token } = await (await fetch("/__test/id-token?oid=${OID}&name=tara&email=tara@example.invalid&admin=1&nonce=" + start.nonce)).json();
      await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
    })()`);
    const ws = (await api("POST", "/workspaces", { name: "Toolbar" })).body.workspace;
    board = (await api("POST", `/workspaces/${ws.id}/boards`, { name: "Toolbar board", columns: COLUMNS })).body.board;
    const records = Array.from({ length: 6 }, (_, i) => ({ values: { serial: `Job ${i + 1}`, state: i % 2 ? "Open" : "Done", notes: i < 2 ? "north yard" : "south yard" } }));
    assert.equal((await api("POST", `/boards/${board.id}/records/batch`, { records })).status, 201);
    board = (await api("GET", `/boards/${board.id}`)).body.board;
    const patched = await api("PATCH", `/boards/${board.id}`, { expectedVersion: board.version, savedViews: [{ name: "Yard work", state: { view: "table" } }] });
    assert.equal(patched.status, 200, JSON.stringify(patched.body).slice(0, 200));
  });
  after(async () => { await b?.close(); server?.kill(); });

  test("on a 390 px phone Filter and Sort are on screen and their panels open inside the viewport (light and dark)", async () => {
    await openBoard(390);
    for (const theme of ["light", "dark"]) {
      await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      assert.equal(await b.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0, `${theme}: no sideways scroll`);
      for (const sel of ['.board-tools [data-action="toolbar-menu"][data-menu="filter"]', '.board-tools [data-action="sort"]']) {
        await b.evaluate(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: "center" })`); await sleep(100);
        assert.equal(await inViewport(sel), "ok", `${theme}: ${sel}`);
      }
      await click('.board-tools [data-action="toolbar-menu"][data-menu="filter"]');
      assert.ok(await b.waitFor("!!document.querySelector('.toolbar-menu-popover')", 3000), "Filter menu opens");
      assert.equal(await inViewport(".toolbar-menu-popover"), "ok", `${theme}: Filter menu inside the viewport`);
      assert.ok(await b.evaluate("[...document.querySelectorAll('.toolbar-menu-popover .menu-section-label')].map((s) => s.textContent.trim()).includes('Show')"), "the quick filters");
      await b.key("Escape");
      assert.ok(await b.waitFor("!document.querySelector('.toolbar-menu-popover')", 3000), "Escape closes it");
      await click('.board-tools [data-action="sort"]');
      assert.ok(await b.waitFor("!!document.querySelector('form[data-action=sort-form]')", 3000), "Sort opens");
      assert.equal(await inViewport("form[data-action=sort-form]"), "ok", `${theme}: Sort panel inside the viewport`);
      assert.equal(await inViewport("form[data-action=sort-form] .button.primary"), "ok", `${theme}: Apply sort reachable`);
      await click("form[data-action=sort-form] [data-action=close-overlay]");
      assert.ok(await b.waitFor("!document.querySelector('form[data-action=sort-form]')", 3000));
    }
  });

  test("Sort shows its number of levels while a sort is on (light and dark), and loses it when cleared", async () => {
    await openBoard(1440);
    const sortSel = '.board-tools [data-action="sort"]';
    assert.equal(await b.evaluate(`!!document.querySelector('${sortSel} .tool-count')`), false, "no sort, no badge");
    await click(sortSel);
    assert.ok(await b.waitFor("!!document.querySelector('form[data-action=sort-form]')", 3000));
    await b.evaluate("(() => { const f = document.querySelector('form[data-action=sort-form]'); f.querySelector('[name=key]').value = 'serial'; f.querySelector('[name=direction]').value = 'asc'; f.requestSubmit(); })()");
    assert.ok(await b.waitFor(`document.querySelector('${sortSel} .tool-count')?.textContent === '1'`, 3000), "badge 1");
    assert.equal(await b.evaluate(`document.querySelector('${sortSel}').getAttribute('aria-label')`), "Sort, 1 active");
    assert.equal(await b.evaluate(`document.querySelector('${sortSel}').classList.contains('active')`), true, "tinted");
    assert.deepEqual(await b.evaluate("[...document.querySelectorAll('.board-tools .tool-button, .board-tools .search-field')].map((e) => Math.round(e.getBoundingClientRect().height)).filter((h, i, a) => a.indexOf(h) === i)"), [32], "the badge keeps one control height");
    for (const theme of ["light", "dark"]) {
      await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`); await sleep(150);
      const c = await b.evaluate(`(() => { const badge = getComputedStyle(document.querySelector('${sortSel} .tool-count')), btn = getComputedStyle(document.querySelector('${sortSel}')); return { fg: badge.color, bg: badge.backgroundColor, button: btn.backgroundColor, page: getComputedStyle(document.querySelector('.board-tools')).backgroundColor }; })()`);
      assert.ok(contrast(c.fg, c.bg) >= 4.5, `${theme}: badge text readable (${c.fg} on ${c.bg})`);
      assert.notEqual(c.button, "rgba(0, 0, 0, 0)", `${theme}: the active button is tinted`);
    }
    await b.evaluate("document.querySelector('th[data-column-key=serial] [data-action=column-menu]').click()"); await sleep(150);
    assert.equal(await click("[data-action=clear-sort]"), true, "Clear sort in the column menu");
    assert.ok(await b.waitFor(`!document.querySelector('${sortSel} .tool-count')`, 3000), "cleared: no badge");
    assert.equal(await b.evaluate(`document.querySelector('${sortSel}').hasAttribute('aria-label')`), false);
    assert.equal(await b.evaluate(`document.querySelector('${sortSel}').classList.contains('active')`), false);
    assert.equal(await b.evaluate("document.querySelector('[data-action=view-filter]').hasAttribute('role')"), false, "Filter conditions… is a plain button");
  });

  test("a column-header filter marks the view changed, is saved to the view, and comes back after a reload", async () => {
    await openBoard(1440);
    const openView = async () => {
      await b.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((x) => x.textContent.includes("Yard work"))?.click()`);
      assert.ok(await b.waitFor("document.querySelector('.view-tab.active')?.textContent.includes('Yard work')", 5000)); await sleep(200);
    };
    await openView();
    assert.equal(await rows(), 6);
    assert.equal(await b.evaluate("!!document.querySelector('[data-action=save-active-view]')"), false);
    await b.evaluate("document.querySelector('th[data-column-key=notes] [data-action=column-menu]').click()"); await sleep(150);
    assert.equal(await click("[data-action=filter-column][data-key=notes]"), true, "Filter… in the column menu");
    assert.ok(await b.waitFor("!!document.querySelector('form[data-action=column-filter-form]')", 3000));
    await b.evaluate("(() => { const f = document.querySelector('form[data-action=column-filter-form]'); f.querySelector('[name=op]').value = 'contains'; f.querySelector('[name=value]').value = 'north'; f.requestSubmit(); })()");
    assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length === 2", 5000), "filtered");
    assert.ok(await b.waitFor("!!document.querySelector('[data-action=save-active-view]')", 3000), "the view shows as changed");
    await click("[data-action=save-active-view]");
    let saved = null;
    for (let i = 0; i < 60 && !saved; i += 1) { const v = (await api("GET", `/boards/${board.id}`)).body.board.savedViews.find((x) => x.name === "Yard work"); if (v?.state.columnFilter) saved = v.state; else await sleep(100); }
    assert.ok(saved, "stored on the server");
    assert.deepEqual(JSON.parse(saved.columnFilter), { key: "notes", op: "contains", value: "north" });
    assert.ok(await b.waitFor("!document.querySelector('[data-action=save-active-view]')", 3000), "no longer changed");
    // A reload: the board comes from the server again.
    await openBoard(1440);
    await openView();
    assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length === 2", 5000), "the view opens filtered after a reload");
    assert.equal(await b.evaluate("!!document.querySelector('[data-action=save-active-view]')"), false, "and unchanged");
    await b.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((x) => x.textContent.includes("Main Table"))?.click()`);
    assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length === 6", 5000), "Main Table has no column filter");
  });
});
