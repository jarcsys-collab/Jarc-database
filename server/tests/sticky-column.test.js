// The sticky first column on a wide board (real app on the fake MongoDB, headless browser; generic synthetic data from
// tests/support/superform-fixture.js, the shape of a migrated terms board: statuses, dropdowns, 25 columns, 4 groups).
// Regression: a hovered row's cells took a TRANSLUCENT background (var(--hover), 5% ink over transparent), so while the
// board was scrolled sideways the cells underneath the sticky name column (status labels, dropdown pills, text) showed
// through it. Every sticky cell must paint an opaque background in every state: resting, hovered, selected, selected and
// hovered, light and dark, desktop and phone. Hovering a selected row keeps its selection colour.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const { findBrowser, launch, freePort, waitForServer, sleep } = require("./support/headless-browser");
const F = require("./support/superform-fixture");

const BROWSER = findBrowser();

describe("sticky first column while scrolled sideways (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed", concurrency: false }, () => {
  let server, base, board, b;
  const call = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1" + ${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) }, ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`} }); let json = null; try { json = await r.json(); } catch {} return { status: r.status, body: json }; })()`);

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER);
    await b.open(`${base}/api/v1/health`, { width: 1440 });
    await b.evaluate(`(async () => { const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=0d0d0d0d-0000-4000-8000-0000000000c1&name=admin&email=admin@example.invalid&admin=1&nonce=" + start.nonce)).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); })()`);
    const ws = (await call("POST", "/workspaces", { name: "Fictional Workspace" })).body.workspace;
    const created = await call("POST", `/workspaces/${ws.id}/boards`, { name: F.BOARD_NAME, columns: F.COLUMNS, groups: F.GROUPS });
    assert.equal(created.status, 201, JSON.stringify(created.body)); board = created.body.board;
    const K = F.K;
    for (let i = 0; i < 12; i += 1) {
      const r = await call("POST", `/boards/${board.id}/records`, { groupId: F.GROUPS[i % 2 ? 2 : 1].id, values: { [K.name]: i === 3 ? "Agreement with a deliberately long name that never fits in its column" : `Agreement ${i + 1}`, [K.kind]: i % 2 ? F.SELLER : F.BUYER, [K.codes]: ["T-01"], [K.dueRule]: `Net ${30 + i} days`, [K.pctDown]: String(i), [K.recordStatus]: "Pending", [K.payMode]: ["Check"] } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
  });
  after(async () => { await b?.close(); server?.kill(); });

  const openBoard = async (width) => {
    await b.open(`${base}/`, { width });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item') || !!document.querySelector('[data-action=open-board]')", 15000), "app shown");
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item, [data-action=open-board]')].find((el) => el.textContent.includes(${JSON.stringify(F.BOARD_NAME)}))?.click()`);
    assert.ok(await b.waitFor("document.querySelectorAll('.editable-table tbody tr[data-record-context]').length >= 12", 15000), "rows shown");
    await sleep(200);
  };
  // The app's own theme switch (the delegated handler of the theme buttons: updateSetting + applyDisplay).
  const theme = async (name) => { await b.evaluate(`(() => { const x = document.createElement('button'); x.dataset.action = 'login-theme-choice'; x.dataset.theme = ${JSON.stringify(name)}; x.hidden = true; document.querySelector('#app').append(x); x.click(); x.remove(); })()`); assert.ok(await b.waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(name)}`, 2000), `${name} theme`); };
  const scrollSideways = async () => {
    const left = await b.evaluate("(() => { const w = [...document.querySelectorAll('.table-wrap')].find((x) => x.scrollWidth > x.clientWidth); if (!w) return -1; w.scrollLeft = 480; return w.scrollLeft; })()");
    assert.ok(left > 200, `the board scrolls sideways (scrollLeft ${left})`);
    await sleep(150);
  };
  const row = (n) => `[...document.querySelectorAll('.editable-table tbody tr[data-record-context]')].filter((r) => r.getBoundingClientRect().top > 0)[${n}]`;
  // A real mouse move over the row's name cell, so :hover applies exactly as for a person.
  const hover = async (n) => { const p = await b.evaluate(`(() => { const c = ${row(n)}.children[1].getBoundingClientRect(); return { x: c.left + c.width * 0.7, y: c.top + c.height / 2 }; })()`); await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }); await sleep(150); };
  const unhover = async () => { await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }); await sleep(100); };
  // Every sticky cell of the visible rows (name column, actions column): position sticky and a fully opaque background.
  const stickyCells = () => b.evaluate(`(() => {
    const alpha = (c) => { const m = c.match(/\\/\\s*([\\d.]+)\\s*\\)$/) || c.match(/^rgba\\([^)]*,\\s*([\\d.]+)\\)$/); return m ? Number(m[1]) : (c === 'transparent' ? 0 : 1); };
    const rows = [...document.querySelectorAll('.editable-table tbody tr[data-record-context]')].filter((r) => { const x = r.getBoundingClientRect(); return x.top > 0 && x.bottom < innerHeight; });
    const out = [];
    for (const r of rows) for (const cell of [r.children[1], r.querySelector('td.row-actions')]) { if (!cell) continue; const c = getComputedStyle(cell); out.push({ key: cell.dataset.columnKey || 'actions', position: c.position, bg: c.backgroundColor, alpha: alpha(c.backgroundColor), hovered: r.matches(':hover'), selected: r.classList.contains('is-selected') }); }
    return out;
  })()`);
  const assertOpaque = async (label) => {
    const cells = await stickyCells();
    assert.ok(cells.length >= 4, `${label}: sticky cells found`);
    const name = cells.filter((c) => c.key === F.K.name);
    assert.ok(name.length && name.every((c) => c.position === "sticky"), `${label}: the name column is sticky`);
    const seeThrough = cells.filter((c) => c.position === "sticky" && c.alpha < 1);
    assert.deepEqual(seeThrough, [], `${label}: no sticky cell is see-through`);
    return cells;
  };
  // Nothing from the scrolled columns is on top of the name cell: every point across it belongs to that cell.
  const nameCellOnTop = (n) => b.evaluate(`(() => { const td = ${row(n)}.children[1], x = td.getBoundingClientRect(); const bad = []; for (let fx = 0.05; fx < 1; fx += 0.15) { const el = document.elementFromPoint(x.left + x.width * fx, x.top + x.height / 2); if (el && !td.contains(el) && !el.closest('#overlay-root, .ui-tooltip, .popover')) bad.push(el.className); } return bad; })()`);

  test("desktop, light: scrolled sideways, the name column stays put and stays opaque at rest, on hover, and over the cells beneath it", async () => {
    await openBoard(1440); await theme("light");
    await scrollSideways();
    // Stuck to the left edge of the scrolling table, and it stays there as the board scrolls further.
    const edge = () => b.evaluate(`(() => { const w = [...document.querySelectorAll('.table-wrap')].find((x) => x.scrollWidth > x.clientWidth); return [Math.round(${row(0)}.children[1].getBoundingClientRect().left - w.getBoundingClientRect().left - w.clientLeft), w.scrollLeft]; })()`);
    const [at, scrolled] = await edge();
    assert.equal(at, 0, "the name column is stuck to the table's left edge");
    await b.evaluate("(() => { const w = [...document.querySelectorAll('.table-wrap')].find((x) => x.scrollWidth > x.clientWidth); w.scrollLeft += 300; })()"); await sleep(100);
    const [at2, scrolled2] = await edge();
    assert.ok(scrolled2 > scrolled, "scrolled further"); assert.equal(at2, 0, "still stuck to the edge");
    await assertOpaque("at rest");
    await hover(1);
    const cells = await assertOpaque("hovering the name column");
    assert.ok(cells.some((c) => c.hovered && c.key === F.K.name), "the hovered row is measured");
    assert.deepEqual(await nameCellOnTop(1), [], "nothing from the scrolled columns is on top of the hovered name cell");
    // The hover colour is still a visible change from the resting colour.
    const resting = cells.find((c) => !c.hovered && !c.selected && c.key === F.K.name).bg, hovered = cells.find((c) => c.hovered && c.key === F.K.name).bg;
    assert.notEqual(hovered, resting, "a hovered row is still highlighted");
    await unhover();
  });

  test("a selected row keeps its selection colour when hovered, and its sticky cells stay opaque", async () => {
    await b.evaluate(`${row(2)}.querySelector('input[type=checkbox]').click()`);
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table tbody tr.is-selected')", 2000), "a row is selected");
    const selectedBg = await b.evaluate("getComputedStyle(document.querySelector('.editable-table tbody tr.is-selected').children[1]).backgroundColor");
    await assertOpaque("selected");
    const p = await b.evaluate("(() => { const c = document.querySelector('.editable-table tbody tr.is-selected').children[1].getBoundingClientRect(); return { x: c.left + c.width * 0.7, y: c.top + c.height / 2 }; })()");
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }); await sleep(150);
    assert.equal(await b.evaluate("document.querySelector('.editable-table tbody tr.is-selected').matches(':hover')"), true);
    await assertOpaque("selected and hovered");
    assert.equal(await b.evaluate("getComputedStyle(document.querySelector('.editable-table tbody tr.is-selected').children[1]).backgroundColor"), selectedBg, "the selection colour stays while hovered");
    await unhover();
    await b.evaluate("document.querySelector('.editable-table tbody tr.is-selected input[type=checkbox]').click()");
  });

  test("desktop, dark: the same while scrolled and hovered", async () => {
    await openBoard(1440); await theme("dark");
    await scrollSideways(); await hover(1);
    await assertOpaque("dark, hovered");
    assert.deepEqual(await nameCellOnTop(1), []);
    await unhover(); await theme("light");
  });

  test("phone: scrolled sideways, a tapped row (hover can stay on after a tap) keeps the name column opaque", async () => {
    await openBoard(390);
    await scrollSideways();
    await assertOpaque("phone, at rest");
    const p = await b.evaluate(`(() => { const c = ${row(1)}.children[1].getBoundingClientRect(); return { x: c.left + c.width * 0.8, y: c.top + c.height / 2 }; })()`);
    await b.tap(p.x, p.y);
    await assertOpaque("phone, after a tap");
    assert.equal(await b.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true, "no sideways scrolling of the page itself");
  });
});
