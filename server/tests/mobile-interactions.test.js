// Mobile interaction regression tests in a real headless browser (Chrome/Edge) with touch input, against the REAL
// app: the Entra test server (offline: local test keys, fake MongoDB), signed in, with a workspace, a board and
// records. Covers the navigation drawer, background re-renders during taps, dialogs on small screens, iOS-safe form
// field sizes and the startup save. Phones are emulated (Chrome's touch emulation, not iOS Safari).
// Skipped when no Chrome or Edge is installed (set JARC_TEST_BROWSER to use a specific one).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort } = require("./support/headless-browser");

const BROWSER = findBrowser();
const PHONES = [320, 375, 390, 430];

describe("Mobile interactions (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, browser, base;
  const open = (width, height = 780) => browser.open(`${base}/`, { width, height }).then(() => browser.waitFor("!!document.querySelector('.app-shell')", 8000)).then(() => sleep(300));
  const drawerOpen = () => browser.evaluate("document.querySelector('#sidebar').classList.contains('open') && document.documentElement.classList.contains('nav-drawer-open')");
  const drawerClosed = async () => !(await browser.evaluate("document.querySelector('#sidebar').classList.contains('open') || document.documentElement.classList.contains('nav-drawer-open')"));
  const tapMenu = (settle) => browser.tapOn('[data-action="toggle-nav"]', settle === undefined ? undefined : { settle });
  const menuCentre = () => browser.evaluate("(() => { const r = document.querySelector('[data-action=toggle-nav]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  const backgroundRefresh = () => browser.evaluate("window.dispatchEvent(new CustomEvent('jarc-board-status', { detail: {} }))");

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore" });
    for (let i = 0; i < 100; i += 1) { try { await fetch(`${base}/api/v1/health`); break; } catch { await sleep(100); } }
    browser = await launch(BROWSER);
    await browser.open(`${base}/`, { width: 390 });
    // Sign in as the test server's Microsoft would (nonce → ID token → session cookie), then create test data.
    await browser.evaluate(`(async () => {
      const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
      const { token } = await (await fetch("/__test/id-token?oid=" + crypto.randomUUID() + "&name=Ana%20Reyes&email=ana@example.invalid&admin=1&nonce=" + start.nonce)).json();
      await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
      const { csrfToken } = await (await fetch("/api/v1/auth/session")).json();
      const post = async (p, body) => (await fetch("/api/v1" + p, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) })).json();
      const { workspace } = await post("/workspaces", { name: "Operations" });
      const columns = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["New", "Done"] }, { key: "notes", label: "Notes", type: "text" }];
      const { board } = await post("/workspaces/" + workspace.id + "/boards", { name: "Service tickets", columns });
      await post("/boards/" + board.id + "/records/batch", { records: Array.from({ length: 8 }, (_, i) => ({ values: { serial: "TCK-" + (100 + i), status: "New", notes: "Note " + i } })) });
    })()`);
  });
  after(async () => { await browser?.close(); server?.kill(); });

  test("the menu button opens the drawer on the first tap, at every phone width and on tablets", async () => {
    for (const width of [...PHONES, 768]) {
      await open(width);
      await tapMenu();
      assert.equal(await drawerOpen(), true, `${width}px`);
      assert.deepEqual(await browser.evaluate("['aria-expanded','aria-label','aria-controls'].map(a => document.querySelector('[data-action=toggle-nav]').getAttribute(a))"), ["true", "Close navigation", "sidebar"], `${width}px`);
      assert.equal(await browser.evaluate("document.activeElement?.closest('#sidebar') !== null"), true, `${width}px: focus moves into the drawer`);
      assert.equal(await browser.evaluate("getComputedStyle(document.documentElement).overflow"), "hidden", `${width}px: page behind doesn't scroll`);
      await tapMenu();
      assert.equal(await drawerClosed(), true, `${width}px: the same button (✕) closes it`);
      assert.equal(await browser.evaluate("getComputedStyle(document.documentElement).overflow"), "visible", `${width}px: scrolling restored`);
    }
  });

  test("tapping outside the drawer closes it: the dimmed page, or an empty part of the top bar; focus returns to the menu button", async () => {
    for (const width of [320, 390, 768]) {
      await open(width);
      await tapMenu(); await browser.tap(width - 12, 500);
      assert.equal(await drawerClosed(), true, `${width}px backdrop`);
      assert.equal(await browser.evaluate("document.activeElement?.dataset.action"), "toggle-nav", `${width}px focus`);
      await tapMenu(); await browser.tap(width - 70 > 230 ? 200 : width - 120, 29);
      assert.equal(await drawerClosed(), true, `${width}px top bar`);
    }
  });

  test("Escape closes it; choosing a screen, a board or Settings closes it and does the action", async () => {
    await open(390);
    await tapMenu(); await browser.key("Escape");
    assert.equal(await drawerClosed(), true, "Escape");
    await tapMenu(); await browser.tapOn('#sidebar [data-screen="mywork"]', { settle: 300 });
    assert.equal(await drawerClosed(), true); assert.equal(await browser.evaluate("document.querySelector('.topbar strong')?.textContent"), "My work");
    await tapMenu(); await browser.tapOn("#sidebar .tree-item", { settle: 700 });
    assert.equal(await drawerClosed(), true); assert.equal(await browser.evaluate("!!document.querySelector('.board-head')"), true);
    await tapMenu(); await browser.tapOn('#sidebar [data-action="settings"]', { settle: 300 });
    assert.equal(await drawerClosed(), true, "a dialog closes the drawer"); assert.equal(await browser.evaluate("!!document.querySelector('.settings-window')"), true);
    await browser.key("Escape");
    await tapMenu(); await browser.tapOn('#sidebar [data-action="workspace-menu"]', { settle: 300 });
    assert.equal(await drawerClosed(), true);
    assert.equal(await browser.evaluate("(() => { const r = document.querySelector('.workspace-popover').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()"), true, "workspace switcher stays on screen");
    await browser.key("Escape");
  });

  test("background re-renders: an open drawer stays open, and a tap in progress isn't lost", async () => {
    await open(390);
    await tapMenu(); await backgroundRefresh(); await sleep(150);
    assert.equal(await drawerOpen(), true, "records finishing loading don't close the drawer");
    await tapMenu();
    const point = await menuCentre();
    await browser.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await backgroundRefresh();
    await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(200);
    assert.equal(await drawerOpen(), true, "finger down → re-render → finger up still opens the drawer");
    await tapMenu(); await sleep(500);
    assert.equal(await drawerClosed(), true);
  });

  test("rapid and repeated taps never leave the backdrop stuck or the menu button covered", async () => {
    await open(390);
    for (let i = 0; i < 6; i += 1) await tapMenu(15);
    await sleep(200);
    assert.equal(await drawerClosed(), true, "an even number of taps ends closed");
    for (let i = 0; i < 20; i += 1) { await tapMenu(25); await browser.tap(378, 500, { settle: 25 }); }
    await sleep(200);
    assert.equal(await drawerClosed(), true);
    assert.equal(await browser.evaluate("(() => { const p = document.querySelector('[data-action=toggle-nav]').getBoundingClientRect(); return document.elementFromPoint(p.left + p.width / 2, p.top + p.height / 2)?.closest('[data-action]')?.dataset.action; })()"), "toggle-nav");
    assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.nav-backdrop')).display"), "none");
    assert.deepEqual(await browser.evaluate("(() => { const r = document.querySelector('[data-action=toggle-nav]').getBoundingClientRect(); return [r.width, r.height]; })()"), [44, 44], "44 px touch target");
  });

  test("desktop is unchanged: no drawer or backdrop, the collapse chevron still works; resizing to desktop clears an open drawer", async () => {
    await open(390);
    await tapMenu();
    await browser.viewport({ width: 1440, height: 900 }); await sleep(200);
    assert.equal(await drawerClosed(), true, "drawer state cleared on desktop");
    assert.equal(await browser.evaluate("getComputedStyle(document.documentElement).overflow"), "visible");
    await open(1440, 900);
    assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('[data-action=toggle-nav]')).display"), "none", "menu button hidden");
    assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.nav-backdrop')).display"), "none");
    const collapsed = () => browser.evaluate("document.body.classList.contains('nav-collapsed')");
    const before = await collapsed();
    await browser.evaluate("document.querySelector('.sidebar-collapse-top').click()");
    assert.equal(await collapsed(), !before, "collapse chevron toggles the desktop sidebar");
    await browser.evaluate("document.querySelector('.sidebar-collapse-top').click()");
    assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#board-search, .global-search-button input, select')).fontSize === '16px'"), false, "desktop field sizes untouched");
  });

  test("startup never shows a false “wasn't saved” error, and no screen scrolls sideways (320–1440 px)", async () => {
    for (const width of [...PHONES, 768, 1440]) {
      // A fresh start (nothing remembered in this browser) is when the open board's records arrive mid-save.
      await browser.evaluate("localStorage.clear()");
      await open(width); await sleep(1200);
      assert.equal(await browser.evaluate("document.querySelector('.toast')?.textContent || null"), null, `${width}px toast`);
      assert.equal(await browser.evaluate("document.querySelector('.save-state')?.classList.contains('save-error') || false"), false);
      assert.ok(await browser.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), `${width}px home`);
      await browser.evaluate("document.querySelector('.board-list-row .board-list-open')?.scrollIntoView({ block: 'center' })"); await sleep(100);
      await browser.tapOn(".board-list-row .board-list-open", { settle: 800 });
      assert.equal(await browser.evaluate("!!document.querySelector('.board-head')"), true, `${width}px board opens`);
      assert.ok(await browser.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), `${width}px board`);
      assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.table-wrap')).overflowX"), "auto", "the table scrolls inside its own container");
    }
  });

  test("phones: every form field is at least 16 px (no iOS zoom on focus) and dialogs stay on screen", async () => {
    const smallest = "[...document.querySelectorAll('input:not([type=checkbox]):not([type=hidden]):not([type=file]):not([type=color]), select, textarea')].filter(e => e.getBoundingClientRect().width).reduce((m, e) => Math.min(m, parseFloat(getComputedStyle(e).fontSize)), 99)";
    const onScreen = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; const r = el.getBoundingClientRect(); return r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5; })()`;
    for (const width of [320, 390]) {
      await open(width);
      for (const [trigger, panel] of [[".global-search-button", ".command-modal"], ['[data-action="notifications"]', ".notification-drawer"], ['[data-action="profile-menu"]', ".profile-popover"], ['.page-head [data-action="new-board"]', "#overlay-root .modal"]]) {
        await browser.tapOn(trigger, { settle: 350 });
        assert.equal(await browser.evaluate(onScreen(panel)), true, `${width}px ${panel}`);
        assert.ok(await browser.evaluate(smallest) >= 16, `${width}px ${panel} fields`);
        await browser.key("Escape");
      }
      await browser.evaluate("document.querySelector('.board-list-row .board-list-open')?.scrollIntoView({ block: 'center' })"); await sleep(100);
      await browser.tapOn(".board-list-row .board-list-open", { settle: 800 });
      assert.ok(await browser.evaluate(smallest) >= 16, `${width}px board toolbar fields`);
      await browser.tapOn('.board-tools [data-action="open-form"]', { settle: 400 });
      assert.equal(await browser.evaluate(onScreen(".record-drawer")), true, `${width}px record form`);
      assert.ok(await browser.evaluate(smallest) >= 16, `${width}px record form fields`);
      await browser.key("Escape");
    }
  });
});
