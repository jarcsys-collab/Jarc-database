// Responsive layout regression checks in a real headless browser (Chrome/Edge, exact device emulation) at 320, 390,
// 768 and 1440 px: the real AppView markup for an empty and a populated database, with the site's real stylesheets.
//   - the page never scrolls sideways (wide tables and tab strips scroll inside their own containers)
//   - navigation, search, profile and workspace creation stay reachable on every width
//   - the icon-only sidebar keeps text labels for assistive technology
// Skipped when no Chrome or Edge is installed (set JARC_TEST_BROWSER to use a specific one).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const { loadBrowser } = require("./support/browser-model");
const { findBrowser, launch } = require("./support/headless-browser");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const WIDTHS = [320, 390, 768, 1440];
const BROWSER = findBrowser();

async function model({ empty = false, screen = "home" } = {}) {
  const b = loadBrowser();
  const m = new b.window.BoardModel(new b.window.StorageService(new b.window.LocalAsyncAdapter()));
  await m.init();
  m.profile.name = "Ana Reyes"; m.profile.initials = "AR";
  if (empty) { m.workspaces = []; m.storage = { adapter: { mode: "resource" } }; }
  if (screen === "board") {
    m.screen = "board"; m.currentBoardId = m.workspace.boards[0].id;
    for (let i = 0; i < 6; i += 1) m.board.records.push({ id: `r${i}`, serial: `JOB-10${i}`, status: "In progress", notes: `A longer note for record ${i}`, owner: "AR" });
  }
  return m;
}
function markup(m) {
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null };
  const context = vm.createContext({ window: {}, document, console, Intl, Date, URL, encodeURIComponent });
  vm.runInContext(fs.readFileSync(path.join(ASSETS, "AppView.js"), "utf8"), context);
  const root = { innerHTML: "" };
  new context.window.AppView(root).render(m);
  return root.innerHTML;
}

// Page-level horizontal overflow, plus whether a selector is visible inside the viewport.
const OVERFLOW = "document.documentElement.scrollWidth - document.documentElement.clientWidth";
const reachable = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return "missing";
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el); if (cs.display === "none" || cs.visibility === "hidden" || !r.width || !r.height) return "hidden";
  return r.left >= -0.5 && r.right <= document.documentElement.clientWidth + 0.5 && r.top >= -0.5 ? "ok" : "outside"; })()`;
const labelState = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return "missing"; const cs = getComputedStyle(el);
  return cs.display === "none" ? "removed" : el.getBoundingClientRect().width <= 1 ? "visually-hidden" : "visible"; })()`;

describe("Responsive layout (headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let browser, dir;
  const pages = {};
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarc-layout-"));
    const base = "file:///" + ASSETS.split(path.sep).join("/");
    const css = ["styles.css", "table-clarity.css", "ui-foundation.css"].map((f) => `<link rel="stylesheet" href="${base}/${f}">`).join("");
    const write = (name, html, theme = "dark") => {
      const file = path.join(dir, `${name}.html`);
      fs.writeFileSync(file, `<!doctype html><html data-theme="${theme}" data-density="comfortable"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css}</head><body><div id="app">${html}</div></body></html>`);
      pages[name] = file;
    };
    const empty = markup(await model({ empty: true })), home = markup(await model()), board = markup(await model({ screen: "board" }));
    write("empty", empty); write("empty-light", empty, "light"); write("home", home); write("board", board);
    write("empty-drawer", empty.replace('class="sidebar" id="sidebar"', 'class="sidebar open" id="sidebar"'));
    write("home-drawer", home.replace('class="sidebar" id="sidebar"', 'class="sidebar open" id="sidebar"'));
    browser = await launch(BROWSER);
  });
  after(async () => { await browser?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test("no page-level horizontal overflow: empty and populated layouts, dark and light, 320–1440 px", async () => {
    for (const name of ["empty", "empty-light", "home", "board", "empty-drawer", "home-drawer"]) {
      for (const width of WIDTHS) {
        await browser.open(pages[name], { width });
        assert.equal(await browser.evaluate(OVERFLOW), 0, `${name} @ ${width}px scrolls sideways`);
      }
    }
  });

  test("header controls stay reachable on every width: menu/navigation, search, notifications, profile", async () => {
    for (const name of ["empty", "home", "board"]) {
      for (const width of WIDTHS) {
        await browser.open(pages[name], { width });
        for (const selector of ['[data-action="command-palette"].global-search-button', '[data-action="notifications"]', '[data-action="profile-menu"]']) {
          assert.equal(await browser.evaluate(reachable(selector)), "ok", `${name} @ ${width}px: ${selector}`);
        }
        // Phones and tablets open navigation with the menu button; desktops show the sidebar itself.
        const nav = width <= 1024 ? '[data-action="toggle-nav"]' : '#sidebar [data-screen="home"]';
        assert.equal(await browser.evaluate(reachable(nav)), "ok", `${name} @ ${width}px: navigation`);
      }
    }
  });

  test("workspace creation is reachable: the empty-state button on every width, the sidebar action on desktop and in the drawer", async () => {
    for (const width of WIDTHS) {
      await browser.open(pages.empty, { width });
      assert.equal(await browser.evaluate(reachable(".no-workspace-create")), "ok", `panel button @ ${width}px`);
    }
    await browser.open(pages.empty, { width: 1440 });
    assert.equal(await browser.evaluate(reachable('.nav-empty-workspaces [data-action="create-workspace"]')), "ok", "sidebar @ 1440px");
    for (const width of [320, 390, 768]) {
      for (const name of ["empty-drawer", "home-drawer"]) {
        await browser.open(pages[name], { width });
        assert.equal(await browser.evaluate(reachable('.workspace-heading [data-action="create-workspace"]')), "ok", `${name} Workspaces + @ ${width}px`);
        assert.equal(await browser.evaluate(reachable('#sidebar [data-action="settings"]')), "ok", `${name} settings @ ${width}px`);
        assert.equal(await browser.evaluate(labelState('#sidebar [data-screen="home"] .nav-text')), "visible", `${name} labels @ ${width}px`);
      }
    }
  });

  test("icon-only sidebar (tablet rail) keeps every label for assistive technology; desktop shows them", async () => {
    await browser.open(pages.empty, { width: 768 });
    for (const selector of ['#sidebar [data-screen="home"] .nav-text', '#sidebar [data-screen="mywork"] .nav-text', '.nav-empty-workspaces [data-action="create-workspace"] .nav-text', '#sidebar [data-action="settings"] span']) {
      assert.equal(await browser.evaluate(labelState(selector)), "visually-hidden", `768px rail: ${selector}`);
    }
    await browser.open(pages.home, { width: 768 });
    assert.equal(await browser.evaluate(labelState('#sidebar .tree-item .nav-text')), "visually-hidden", "board links keep their names");
    await browser.open(pages.empty, { width: 1440 });
    assert.equal(await browser.evaluate(labelState('#sidebar [data-screen="home"] .nav-text')), "visible");
  });

  test("the empty-state panel stacks its steps on phones and lays them out in a row on wider screens", async () => {
    const columns = "getComputedStyle(document.querySelector('.no-workspace-steps')).gridTemplateColumns.split(' ').length";
    await browser.open(pages.empty, { width: 390 });
    assert.equal(await browser.evaluate(columns), 1);
    await browser.open(pages.empty, { width: 1440 });
    assert.equal(await browser.evaluate(columns), 3);
  });
});
