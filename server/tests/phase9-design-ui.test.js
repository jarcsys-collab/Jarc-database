// Phase 9A/9B design system in the REAL app (headless browser, Entra test server, fake MongoDB): the compact toolbar
// (primary actions in one row of equal-height controls; filters in one Filter menu; secondary actions in More),
// menus that stay inside the viewport at 1280/1440/1920 px, themed surfaces in dark and light mode, readable text
// contrast (WCAG AA), reduced motion, no page-level horizontal overflow, and editing still working.
// Skipped when no Chrome or Edge is installed.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort } = require("./support/headless-browser");

const BROWSER = findBrowser();
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["Not started", "Working on it", "Done"] }, { key: "owner", label: "Owner", type: "owner" }, { key: "due", label: "Due date", type: "date" }, { key: "notes", label: "Notes", type: "text" }];

describe("Phase 9: design system and compact UI (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, board;
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json().catch(() => null) }; })()`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const escape = () => b.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  const inViewport = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return "missing"; const r = el.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && el.scrollHeight <= el.clientHeight + 1 ? true : JSON.stringify([Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom), innerWidth, innerHeight, el.scrollHeight, el.clientHeight]); })()`);
  const openBoard = async (width, height) => {
    await b.open(`${base}/`, { width, height });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000));
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Design board"))?.click()`);
    assert.ok(await b.waitFor("document.querySelectorAll('.board-group').length >= 3 && document.querySelector('.save-state')?.dataset.state === 'live'", 15000));
    await sleep(300);
  };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    for (let i = 0; i < 100; i += 1) { try { await fetch(`${base}/api/v1/health`); break; } catch { await sleep(100); } }
    b = await launch(BROWSER);
    await b.motionPreference("no-preference");
    await b.open(`${base}/api/v1/health`, { width: 1440 });
    await b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=0f9f9f9f-0000-4000-8000-0000000000d1&name=Dee%20Designer&email=dee@example.invalid&nonce=" + encodeURIComponent(s.nonce))).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token, state: s.state }) }); })()`);
    const ws = (await api("POST", "/workspaces", { name: "Design" })).body.workspace;
    board = (await api("POST", `/workspaces/${ws.id}/boards`, { name: "Design board", columns: COLUMNS, groups: [{ name: "Planning", color: "#3b82f6" }, { name: "Doing", color: "#f97316" }, { name: "Done", color: "#16a34a" }] })).body.board;
    const g = Object.fromEntries(board.groups.map((x) => [x.name, x.id]));
    await api("POST", `/boards/${board.id}/records/batch`, { records: Array.from({ length: 9 }, (_, i) => ({ values: { serial: `Task ${i + 1}`, status: ["Not started", "Working on it", "Done"][i % 3], notes: `note ${i + 1}` }, groupId: g[["Planning", "Doing", "Done"][i % 3]] })) });
  });
  after(async () => { await b?.close(); server?.kill(); });

  test("toolbar: primary actions in one row of equal-height controls; filters in one menu; More holds the rest", async () => {
    await openBoard(1440, 900);
    const t = await b.evaluate(`(() => { const sel = ['[data-action=open-form]', '#board-search', '[data-menu=filter]', '[data-action=sort]', '[data-menu=groupby]', '[data-action=column-picker]', '[data-action=view-overflow]'];
      const els = sel.map((s) => document.querySelector('.board-tools ' + s)); const box = (e) => (e.closest('.search-field') || e).getBoundingClientRect();
      return { missing: sel.filter((s, i) => !els[i]), heights: [...new Set(els.filter(Boolean).map((e) => Math.round(box(e).height)))], rows: [...new Set(els.filter(Boolean).map((e) => Math.round(box(e).top)))].length, old: document.querySelectorAll('.board-tools [data-menu=person], .board-tools [data-menu=status], .board-tools [data-menu=quick], .board-tools select').length }; })()`);
    assert.deepEqual(t.missing, []);
    assert.deepEqual(t.heights, [32], "one control height");
    assert.equal(t.rows, 1, "one row at 1440 px");
    assert.equal(t.old, 0, "no separate filter buttons or native selects");
    await click('[data-action="toolbar-menu"][data-menu="filter"]');
    assert.ok(await b.waitFor("!!document.querySelector('.toolbar-menu-popover')", 3000));
    const sections = await b.evaluate("[...document.querySelectorAll('.toolbar-menu-popover .menu-section-label')].map((s) => s.textContent.trim())");
    assert.deepEqual(sections, ["Show", "Status", "Person"]);
    await click('.toolbar-menu-popover [data-menu=status][data-value="Done"]');
    assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length === 3 && /1/.test(document.querySelector('[data-menu=filter] .tool-count')?.textContent || '')", 3000), "filtered, with an active count");
    await click('[data-action="toolbar-menu"][data-menu="filter"]'); await b.waitFor("!!document.querySelector('[data-action=toolbar-clear-filters]')", 3000);
    await click("[data-action=toolbar-clear-filters]");
    assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length === 9", 3000), "Clear filters");
    await click("[data-action=view-overflow]");
    assert.ok(await b.waitFor("!!document.querySelector('#overlay-root .popover')", 3000));
    const more = await b.evaluate("document.querySelector('#overlay-root .popover').textContent");
    for (const label of ["Import", "Export", "Archived", "Manage groups"]) assert.match(more, new RegExp(label), `More menu offers ${label}`);
    await escape();
  });

  test("menus stay inside the viewport without scrolling at 1280, 1440 and 1920 px; no page-level horizontal overflow", async () => {
    for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080]]) {
      await openBoard(w, h);
      assert.equal(await b.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), true, `${w}px: no page overflow`);
      for (const [trigger, panel] of [['.board-group[data-group="Done"] [data-action=group-menu]', ".group-menu-popover"], ['[data-menu=filter]', ".toolbar-menu-popover"], ["[data-action=view-overflow]", "#overlay-root .popover"], ['tr[data-record-context] [data-action=record-menu]', ".record-menu-popover"]]) {
        assert.ok(await click(trigger), `${w}px trigger ${trigger}`);
        assert.ok(await b.waitFor(`!!document.querySelector(${JSON.stringify(panel)})`, 3000));
        await sleep(250);
        assert.equal(await inViewport(panel), true, `${w}px ${panel}`);
        await escape(); await sleep(150);
      }
    }
  });

  test("dark and light themes: menus, tables and dialogs follow the theme; text contrast meets WCAG AA", async () => {
    await openBoard(1440, 900);
    const lum = (rgb) => { const [r, g, bb] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * bb; };
    const ratio = (a, c) => { const [x, y] = [lum(a), lum(c)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    for (const theme of ["dark", "light"]) {
      await b.evaluate(`document.documentElement.dataset.theme = "${theme}"`); await sleep(150);
      for (let i = 0; i < 2 && !(await b.evaluate("!!document.querySelector('.toolbar-menu-popover')")); i += 1) { await click('[data-menu=filter]'); await b.waitFor("!!document.querySelector('.toolbar-menu-popover')", 1500); }
      assert.ok(await b.evaluate("!!document.querySelector('.toolbar-menu-popover')"), `${theme}: Filter menu opens`);
      const c = await b.evaluate(`(() => { const cs = (s, p) => getComputedStyle(document.querySelector(s))[p];
        return { menu: cs('.toolbar-menu-popover', 'backgroundColor'), menuText: cs('.toolbar-menu-popover button', 'color'), head: cs('.editable-table thead th', 'backgroundColor'), headPrimary: cs('.editable-table thead th.is-primary', 'backgroundColor'), cell: cs('.editable-table td.cell', 'color'), surface: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(), muted: cs('.editable-table thead th .column-label', 'color'), bg: cs('body', 'backgroundColor') }; })()`);
      const dark = lum(c.menu) < 0.05;
      assert.equal(dark, theme === "dark", `${theme}: menu surface ${c.menu}`);
      assert.equal(c.head, c.headPrimary, `${theme}: one header colour`);
      assert.ok(ratio(c.menuText, c.menu) >= 4.5, `${theme}: menu text contrast ${ratio(c.menuText, c.menu).toFixed(2)}`);
      assert.ok(ratio(c.cell, c.head) >= 4.5, `${theme}: cell text contrast`);
      assert.ok(ratio(c.muted, c.head) >= 4.5, `${theme}: muted header text contrast ${ratio(c.muted, c.head).toFixed(2)}`);
      if (theme === "dark") assert.notEqual(c.bg, "rgb(0, 0, 0)", "never pure black");
      await escape(); await sleep(150);
    }
    await b.evaluate(`document.documentElement.dataset.theme = "dark"`);
  });

  test("reduced motion turns transitions off; group collapse and inline editing still work", async () => {
    await b.motionPreference("reduce");
    await openBoard(1440, 900);
    assert.equal(await b.evaluate("getComputedStyle(document.querySelector('.board-tools .tool-button')).transitionDuration"), "0s");
    await b.motionPreference("no-preference");
    await openBoard(1440, 900);
    assert.notEqual(await b.evaluate("getComputedStyle(document.querySelector('.board-tools .tool-button')).transitionDuration"), "0s", "hover transitions when motion is allowed");
    await click('.board-group[data-group="Doing"] [data-action=group-toggle]');
    assert.ok(await b.waitFor("document.querySelector('.board-group[data-group=\"Doing\"]').classList.contains('is-collapsed')", 3000));
    await click('.board-group[data-group="Doing"] [data-action=group-toggle]');
    await b.evaluate(`document.querySelector('tr:has([aria-label="Item: Task 1"]) td[data-column-key="notes"] .cell-display').click()`);
    assert.ok(await b.waitFor("!!document.querySelector('.cell-input')", 3000));
    await b.evaluate(`(() => { const i = document.querySelector('.cell-input'); i.value = "styled edit"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
    assert.ok(await b.waitFor("['live','saved'].includes(document.querySelector('.save-state')?.dataset.state)", 8000)); await sleep(400);
    const rec = (await api("GET", `/boards/${board.id}/records`)).body.items.find((r) => r.values.serial === "Task 1");
    assert.equal(rec.values.notes, "styled edit");
  });
});
