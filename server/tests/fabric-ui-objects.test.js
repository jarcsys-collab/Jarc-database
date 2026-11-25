// Fabric Data: the Objects panel (site/assets/FabricObjects.js), the app's primary navigation in place of the old app-bar tabs.
//   - vm: who sees which node (API Management only for apiAdmin && apiTokens), the tree markup (roles, levels, aria-current,
//     one tab stop, real hrefs), the saved-filters hook (FabricSavedFilters.navItems), actions, per-person storage of node IDs
//     only, and that addresses are unchanged;
//   - headless Chrome/Edge (skipped without one): keyboard (arrows, Home/End, Enter), collapse to a rail and reopen, the drawer
//     at ≤1024 px (focus trap, Escape, focus back to its button), no sideways page scroll.
// No server, no network: the adapter never answers (the panel stays in its loading state). Synthetic values only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const { findBrowser, launch } = require("./support/headless-browser");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
const HOSTILE = `<img src=x onerror="alert(1)">`;
const FILES = ["AppView.js", "AppModules.js", "FabricFieldMeta.js", "FabricRecordView.js", "FabricExplorer.js", "FabricApiDocs.js", "FabricApiPanel.js", "FabricObjects.js", "FabricDataPanel.js"];

function fakeStorage() {
  const m = new Map();
  return { map: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
// The browser files in a vm (no DOM: document.querySelector finds nothing, so redraws are no-ops).
function load({ storage = fakeStorage(), saved = null } = {}) {
  const window = { localStorage: storage, location: { pathname: "/fabric/inventory", search: "" }, addEventListener() {} };
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, activeElement: null };
  const context = vm.createContext({ window, document, console, Intl, Date, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, CSS: { escape: (v) => v } });
  for (const f of FILES.filter((f) => fs.existsSync(path.join(ASSETS, f)))) vm.runInContext(read(f), context, { filename: f });
  if (saved) context.FabricSavedFilters = saved;
  if (saved) vm.runInContext("var FabricSavedFilters = globalThis.FabricSavedFilters;", context);
  const get = (n) => vm.runInContext(n, context);
  return { context, window, storage, FabricDataPanel: get("FabricDataPanel"), FabricObjects: get("FabricObjects"), FabricExplorer: get("FabricExplorer"), AppView: get("AppView") };
}
function panelWith(env, { features = { read: true }, userId = "a1b2c3", view = "inventory" } = {}) {
  const adapter = { mode: "resource", request: () => new Promise(() => {}) };
  const controller = { auth: { userId }, model: { features: { fabricData: features }, storage: { adapter }, screen: "fabric" }, view: new env.AppView({ innerHTML: "" }), updates: 0, update() { this.updates += 1; }, syncBoardUrl() {} };
  const panel = new env.FabricDataPanel(controller);
  controller.fabric = panel;
  if (view !== "inventory") panel.applyRoute({ view });
  return { panel, controller };
}
const target = (dataset = {}, inside = true) => ({ tagName: "A", dataset, closest: (sel) => (inside && sel === "#fabric-objects" ? {} : null) });
const ids = (html) => [...html.matchAll(/id="fabric-obj-([\w-]+)" role="treeitem"/g)].map((m) => m[1]);

describe("Objects panel: who sees what", () => {
  test("Inventory and Sales for every reader; API Management only with apiAdmin AND apiTokens (never drawn otherwise)", () => {
    const env = load();
    const tree = (features) => ids(panelWith(env, { features }).panel.html());
    assert.deepEqual(tree({ read: true }), ["inventory", "inventory-all", "sales", "sales-all"]);
    for (const f of [{ read: true, apiAdmin: true }, { read: true, apiTokens: true }, { read: true, apiAdmin: false, apiTokens: true }]) {
      const html = panelWith(env, { features: f }).panel.html();
      assert.doesNotMatch(html, /API Management|fabric-obj-api|\/fabric\/api/, JSON.stringify(f));
    }
    assert.deepEqual(tree({ read: true, apiAdmin: true, apiTokens: true }), ["inventory", "inventory-all", "sales", "sales-all", "api"]);
    assert.deepEqual(tree({ read: true, datasets: ["sales"] }), ["sales", "sales-all"], "a dataset /features leaves out is not listed");
    assert.deepEqual(tree({ read: true, invoiceViews: true }), ["inventory", "inventory-all", "sales", "sales-all", "invoices"], "v1 invoice views only with their flag");
  });

  test("no company list anywhere in the panel (company is a filter now)", () => {
    const env = load();
    const { panel } = panelWith(env);
    panel.explorers.inventory.seenCompanies = ["CO_A", "CO_B"];
    const aside = env.FabricObjects.html(panel);
    assert.doesNotMatch(aside, /CO_A|Seen on loaded pages|company/i);
  });

  test("not a reader: no app bar button, no panel", () => {
    const env = load();
    const { panel } = panelWith(env, { features: { read: false } });
    assert.doesNotMatch(panel.html(), /fabric-objects|fabric-o-/);
  });
});

describe("Objects panel: markup", () => {
  test("a navigation tree: links with role=treeitem, levels, expanded groups (aria-owns), one tab stop on the open page", () => {
    const env = load();
    const { panel } = panelWith(env, { features: { read: true, apiAdmin: true, apiTokens: true } });
    const html = env.FabricObjects.html(panel);
    assert.match(html, /^<aside id="fabric-objects" class="fx-objects" aria-labelledby="fabric-objects-title">/);
    assert.match(html, /<ul id="fabric-objects-tree" class="fx-objects__tree" role="tree" aria-labelledby="fabric-objects-title">/);
    assert.match(html, /<a class="fx-objects__row fx-objects__row--l1 is-active" href="\/fabric\/inventory" data-action="fabric-section" data-section="inventory" id="fabric-obj-inventory" role="treeitem" data-o-id="inventory" aria-level="1" tabindex="-1" aria-expanded="true" aria-owns="fabric-obj-inventory-group">/);
    assert.match(html, /<ul class="fx-objects__group" role="group" id="fabric-obj-inventory-group" aria-label="Inventory">/);
    assert.match(html, /href="\/fabric\/inventory" data-action="fabric-o-all" data-ds="inventory" id="fabric-obj-inventory-all" role="treeitem" data-o-id="inventory-all" aria-level="2" tabindex="0" aria-current="page">/);
    assert.match(html, /href="\/fabric\/sales" data-action="fabric-o-all" data-ds="sales" id="fabric-obj-sales-all"[^>]*tabindex="-1">/);
    assert.match(html, /href="\/fabric\/api" data-action="fabric-section" data-section="api" id="fabric-obj-api" role="treeitem" data-o-id="api" aria-level="1" tabindex="-1">/);
    assert.equal((html.match(/tabindex="0"/g) || []).length, 1, "one tab stop (roving tabindex)");
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
    assert.match(html, /data-action="fabric-o-collapse"[^>]*aria-controls="fabric-objects-tree" aria-expanded="true" aria-label="Hide the Objects panel"/);
    assert.match(html, /<div class="fx-objects__backdrop" data-action="fabric-o-close" aria-hidden="true" hidden><\/div>$/);
  });

  test("the open page is highlighted: API Management, a record page (under its dataset), Sales", () => {
    const env = load();
    const { panel } = panelWith(env, { features: { read: true, apiAdmin: true, apiTokens: true } });
    panel.applyRoute({ view: "api" });
    assert.match(env.FabricObjects.html(panel), /id="fabric-obj-api"[^>]*tabindex="0" aria-current="page"/);
    panel.applyRoute({ view: "sales", recordId: "a".repeat(24) });
    const html = env.FabricObjects.html(panel);
    assert.match(html, /id="fabric-obj-sales-all"[^>]*aria-current="page"/);
    assert.match(html, /class="fx-objects__row fx-objects__row--l1 is-active"[^>]*id="fabric-obj-sales"/);
    assert.match(panel.html(), /<span id="fabric-section-title">Sales<\/span>/);
  });

  test("a collapsed node hides its group (and keeps no tab stop inside it)", () => {
    const env = load();
    const { panel } = panelWith(env);
    env.FabricObjects.state(panel).open.delete("inventory");
    const html = env.FabricObjects.html(panel);
    assert.match(html, /id="fabric-obj-inventory"[^>]*tabindex="0" aria-expanded="false"/, "the tab stop moves to the visible parent");
    assert.match(html, /id="fabric-obj-inventory-group" aria-label="Inventory" hidden><\/ul>/);
    assert.doesNotMatch(html, /fabric-obj-inventory-all/);
  });
});

describe("Objects panel: My saved filters hook (FabricSavedFilters.navItems)", () => {
  const savedStub = (answer) => { const calls = []; return { calls, navItems(x) { calls.push(x.ds); return typeof answer === "function" ? answer(x) : answer; }, clearCurrent(x) { calls.push(`clear:${x.ds}`); } }; };

  test("the node appears only with the module; navItems is called only while the node is expanded", () => {
    assert.doesNotMatch(env0().FabricObjects.html(panelWith(env0()).panel), /My saved filters/, "no module, no node");
    const saved = savedStub([]), env = load({ saved });
    const { panel } = panelWith(env);
    const html = env.FabricObjects.html(panel);
    assert.match(html, /<span class="fx-objects__row fx-objects__row--l2" data-action="fabric-o-toggle" id="fabric-obj-inventory-saved" role="treeitem" data-o-id="inventory-saved" aria-level="2" tabindex="-1" aria-expanded="false" aria-owns="fabric-obj-inventory-saved-group">/);
    assert.deepEqual(saved.calls, [], "collapsed: nothing requested");
    env.FabricObjects.onAction(panel, "fabric-o-toggle", { dataset: { oId: "inventory-saved" } }, { preventDefault() {}, stopPropagation() {} });
    assert.match(env.FabricObjects.html(panel), /No saved filters yet/);
    assert.ok(saved.calls.includes("inventory") && !saved.calls.includes("sales"));
  });
  function env0() { return load(); }

  test("null means loading; items are escaped links with data-ds and data-id; current moves aria-current; invalid is marked", () => {
    let answer = null;
    const saved = savedStub(() => answer), env = load({ saved });
    const { panel } = panelWith(env);
    env.FabricObjects.state(panel).open.add("inventory-saved");
    assert.match(env.FabricObjects.html(panel), /Loading…/);
    answer = [{ id: "f1", name: HOSTILE, current: true }, { id: "f2", name: "Last 7 days", invalid: true, problem: "Uses a field you can't use now" }, { id: "../bad", name: "dropped" }];
    const html = env.FabricObjects.html(panel);
    assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img src=x/);
    assert.match(html, /href="\/fabric\/inventory" data-action="fabric-s-open" data-ds="inventory" data-id="f1" id="fabric-obj-inventory-saved-f1" role="treeitem"[^>]*aria-level="3" tabindex="0" aria-current="page"/);
    assert.doesNotMatch(html, /id="fabric-obj-inventory-all"[^>]*aria-current/, "All records isn't current while a saved filter is");
    assert.match(html, /is-invalid[^>]*data-id="f2"[\s\S]*fx-objects__warn" title="Uses a field you can&#39;t use now|data-id="f2"[\s\S]*fx-objects__warn/);
    assert.doesNotMatch(html, /dropped/, "an item ID outside [A-Za-z0-9_-] is ignored");
  });

  test("fabric-s-open from the panel shows that dataset first, then hands the action to the explorer; All records clears the current filter", () => {
    const saved = savedStub([{ id: "f1", name: "Mine" }]), env = load({ saved });
    const { panel, controller } = panelWith(env);
    const got = [];
    panel.explorers.sales.onAction = (action, t) => got.push([action, t.dataset.id]);
    panel.onAction("fabric-s-open", target({ ds: "sales", id: "f1" }), { preventDefault() {} });
    assert.equal(panel.route.view, "sales"); assert.deepEqual(got, [["fabric-s-open", "f1"]]); assert.ok(controller.updates >= 1);
    panel.explorers.sales.applyQuery({ ...env.FabricExplorer.emptyQuery(), q: "abc" });
    panel.onAction("fabric-o-all", target({ ds: "sales" }), { preventDefault() {} });
    assert.equal(panel.explorers.sales.query.q, "", "All records: no search or filter");
    assert.ok(saved.calls.includes("clear:sales"));
  });
});

describe("Objects panel: actions and URLs", () => {
  test("choosing a section opens it (and its node); a record page goes back to the list; the address is unchanged", () => {
    const env = load();
    const { panel, controller } = panelWith(env, { features: { read: true, apiAdmin: true, apiTokens: true } });
    panel.applyRoute({ view: "inventory", recordId: "b".repeat(24) });
    assert.equal(panel.urlFor().path, `/fabric/inventory/records/${"b".repeat(24)}`, "record URLs as before");
    panel.onAction("fabric-section", target({ section: "sales" }), { preventDefault() {} });
    assert.equal(panel.route.view, "sales"); assert.equal(panel.urlFor().path, "/fabric/sales");
    panel.onAction("fabric-section", target({ section: "api" }), { preventDefault() {} });
    assert.equal(panel.urlFor().path, "/fabric/api");
    assert.equal(controller.updates, 2);
    // Ctrl/⌘-click keeps the browser's own behaviour (a new tab): nothing happens here.
    panel.onAction("fabric-section", target({ section: "inventory" }), { ctrlKey: true, preventDefault() { throw new Error("must not prevent"); } });
    assert.equal(panel.route.view, "api");
  });

  test("direct URLs still parse; /fabric/api for someone without the right falls back to Inventory, highlighted", () => {
    const env = load();
    const F = env.FabricDataPanel;
    for (const p of ["/fabric/inventory", "/fabric/sales", "/fabric/api", `/fabric/sales/records/${"c".repeat(24)}`]) assert.ok(F.parsePath(p), p);
    const { panel } = panelWith(env);
    panel.applyRoute(F.parsePath("/fabric/api"));
    assert.equal(panel.route.view, "inventory");
    assert.match(env.FabricObjects.html(panel), /id="fabric-obj-inventory-all"[^>]*aria-current="page"/);
  });

  test("collapse and expand are remembered per person, as node IDs only; another person starts from the defaults", () => {
    const storage = fakeStorage(), env = load({ storage });
    const { panel } = panelWith(env, { userId: "person1" });
    env.FabricObjects.onAction(panel, "fabric-o-collapse", { dataset: {} }, {});
    env.FabricObjects.onAction(panel, "fabric-o-toggle", { dataset: { oId: "sales" } }, { preventDefault() {}, stopPropagation() {} });
    assert.deepEqual([...storage.map.keys()], ["jarc.fabric.objects.person1"]);
    assert.deepEqual(JSON.parse(storage.map.get("jarc.fabric.objects.person1")), { v: 1, collapsed: true, open: ["inventory"] });
    assert.match(env.FabricObjects.html(panel), /class="fx-objects is-collapsed"/);
    assert.match(env.FabricObjects.html(panel), /aria-expanded="false" aria-label="Show the Objects panel"/, "the rail's button reopens it");
    // The same person later: restored. Someone else on this browser: defaults.
    const again = panelWith(env, { userId: "person1" }).panel;
    assert.match(env.FabricObjects.html(again), /is-collapsed/);
    const other = panelWith(env, { userId: "person2" }).panel;
    assert.doesNotMatch(env.FabricObjects.html(other), /is-collapsed/);
    // Unknown IDs and junk are ignored; no person known → nothing stored.
    storage.map.set("jarc.fabric.objects.person3", JSON.stringify({ v: 1, collapsed: "yes", open: ["sales", "x<y>", "__proto__"] }));
    const third = panelWith(env, { userId: "person3" }).panel;
    assert.deepEqual([...env.FabricObjects.state(third).open], ["sales"]); assert.equal(env.FabricObjects.state(third).collapsed, false);
    storage.map.set("jarc.fabric.objects.person4", "{not json");
    assert.doesNotThrow(() => env.FabricObjects.html(panelWith(env, { userId: "person4" }).panel));
    const before = storage.map.size, anon = panelWith(env, { userId: "" }).panel;
    env.FabricObjects.onAction(anon, "fabric-o-collapse", { dataset: {} }, {});
    assert.equal(storage.map.size, before, "no person, nothing stored");
  });

  test("index.html links fabric-objects.css and loads FabricObjects.js (and every Phase 7 file) before FabricDataPanel.js", () => {
    const html = fs.readFileSync(path.resolve(ASSETS, "..", "index.html"), "utf8"), at = (s) => html.indexOf(s);
    for (const css of ["fabric-objects.css", "fabric-filter.css", "fabric-menus.css"]) assert.ok(at(`assets/${css}`) > at("assets/fabric-ui.css") && at("assets/fabric-ui.css") > 0, css);
    for (const js of ["FabricFilterModel.js", "FabricValuePicker.js", "FabricFilterBuilder.js", "FabricColumnMenu.js", "FabricSavedFilters.js"]) assert.ok(at(`assets/${js}`) > 0 && at(`assets/${js}`) < at("assets/FabricExplorer.js"), js);
    assert.ok(at("assets/FabricFilterModel.js") < at("assets/FabricFilterBuilder.js"));
    assert.ok(at("assets/FabricObjects.js") > 0 && at("assets/FabricObjects.js") < at("assets/FabricDataPanel.js"));
    assert.ok(at("assets/FabricDataPanel.js") < at("assets/AppController.js"));
    const css = read("fabric-objects.css");
    for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.trim()).filter((r) => r && !r.startsWith("@") && r.includes("{"))) {
      const sel = rule.split("{")[0].replace(/^@media[^{]*\{/, "").trim();
      if (sel) assert.match(sel, /^(\.fx-app\b|[^,]*\.fx-app\b)/, `scoped: ${sel}`);
    }
  });
});

// ---- In a real browser
const BROWSER = findBrowser();
describe("Objects panel in a browser (keyboard, collapse, drawer)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let browser, dir, page;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarc-objects-"));
    const base = "file:///" + ASSETS.split(path.sep).join("/");
    const css = ["styles.css", "ui-foundation.css", "design-system.css", "fabric-ui.css", "fabric-objects.css", "fabric-explorer.css", "fabric-data.css"].map((f) => `<link rel="stylesheet" href="${base}/${f}">`).join("");
    const scripts = FILES.map((f) => `<script src="${base}/${f}"></script>`).join("");
    // A stand-in for AppController: the module body, click routing for fabric-… actions, update() redraws.
    const harness = `<script>
      const root = document.querySelector("#app");
      const c = { auth: { userId: "synthetic-user" }, model: { screen: "fabric", features: { fabricData: { read: true, apiAdmin: true, apiTokens: true } }, storage: { adapter: { mode: "resource", request: () => new Promise(() => {}) } } }, view: new AppView(root), syncBoardUrl() {}, update() { root.innerHTML = '<div class="module-body" style="height:100vh;display:flex;flex-direction:column">' + this.fabric.html() + '</div>'; } };
      c.fabric = new FabricDataPanel(c); c.view.fabricPanel = c.fabric;
      document.addEventListener("click", (e) => { const t = e.target.closest("[data-action]"); if (t && t.dataset.action.startsWith("fabric-")) c.fabric.onAction(t.dataset.action, t, e); });
      c.update(); window.__c = c;
    </script>`;
    page = path.join(dir, "objects.html");
    fs.writeFileSync(page, `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css}</head><body style="margin:0"><div id="app"></div>${scripts}${harness}</body></html>`);
    browser = await launch(BROWSER);
    await browser.motionPreference("reduce");
  });
  after(async () => { await browser?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  const active = () => browser.evaluate("document.activeElement?.id || document.activeElement?.dataset?.focusKey || document.activeElement?.tagName");
  const key = (k, shift = false) => browser.evaluate(`(() => { const e = new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, shiftKey: ${shift}, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(e); return e.defaultPrevented; })()`);
  const OVERFLOW = "document.documentElement.scrollWidth - document.documentElement.clientWidth";

  test("desktop: arrows, Home/End, ←/→ collapse and expand, Enter opens; the open page is aria-current", async () => {
    await browser.open(page, { width: 1440, height: 800 });
    await browser.evaluate("localStorage.clear(); __c.fabric.objects = null; __c.update(); document.querySelector('#fabric-objects [tabindex=\"0\"]').focus()");
    assert.equal(await active(), "fabric-obj-inventory-all");
    await key("ArrowDown"); assert.equal(await active(), "fabric-obj-sales");
    await key("ArrowDown"); assert.equal(await active(), "fabric-obj-sales-all");
    await key("ArrowLeft"); assert.equal(await active(), "fabric-obj-sales", "← goes to the parent");
    await key("ArrowLeft");
    assert.equal(await browser.evaluate("document.querySelector('#fabric-obj-sales').getAttribute('aria-expanded')"), "false");
    assert.equal(await browser.evaluate("document.querySelector('#fabric-obj-sales-group').hidden"), true);
    assert.equal(await active(), "fabric-obj-sales", "focus stays on the node after it collapses");
    await key("ArrowRight");
    assert.equal(await browser.evaluate("document.querySelector('#fabric-obj-sales').getAttribute('aria-expanded')"), "true");
    await key("End"); assert.equal(await active(), "fabric-obj-api");
    await key("Home"); assert.equal(await active(), "fabric-obj-inventory");
    await key("End"); await key("Enter");
    assert.ok(await browser.waitFor("__c.fabric.route.view === 'api' && document.querySelector('#fabric-obj-api')?.getAttribute('aria-current') === 'page'"), "Enter opens API Management");
    assert.equal(await active(), "fabric-obj-api", "focus stays on the chosen item");
    assert.equal(await browser.evaluate("[...document.querySelectorAll('#fabric-objects [role=treeitem]')].filter((e) => e.tabIndex === 0).length"), 1);
    assert.equal(await browser.evaluate("document.querySelector('#fabric-section-title').textContent"), "API Management");
    assert.equal(await browser.evaluate(OVERFLOW), 0);
  });

  test("desktop: Hide collapses to a rail with an obvious reopen button; remembered for this person", async () => {
    await browser.open(page, { width: 1440, height: 800 });
    await browser.evaluate("localStorage.clear(); __c.fabric.objects = null; __c.update()");
    const before = await browser.evaluate("document.querySelector('#fabric-root').getBoundingClientRect().width");
    await browser.evaluate("document.querySelector('[data-action=\"fabric-o-collapse\"]').click()");
    assert.equal(await browser.evaluate("Math.round(document.querySelector('#fabric-objects').getBoundingClientRect().width)"), 32);
    assert.ok((await browser.evaluate("document.querySelector('#fabric-root').getBoundingClientRect().width")) > before + 150, "the body gets the width");
    assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#fabric-objects-tree')).display"), "none");
    assert.equal(await active(), "objects-collapse", "focus stays on the toggle");
    assert.equal(await browser.evaluate("document.querySelector('[data-action=\"fabric-o-collapse\"]').getAttribute('aria-label')"), "Show the Objects panel");
    assert.deepEqual(JSON.parse(await browser.evaluate("localStorage.getItem('jarc.fabric.objects.synthetic-user')")), { v: 1, collapsed: true, open: ["inventory", "sales"] });
    await browser.evaluate("document.querySelector('[data-action=\"fabric-o-collapse\"]').click()");
    assert.ok((await browser.evaluate("document.querySelector('#fabric-objects').getBoundingClientRect().width")) >= 200, "reopened");
    await browser.evaluate("document.querySelector('#fabric-objects-toggle').click()");
    assert.equal(await browser.evaluate("document.querySelector('#fabric-objects').classList.contains('is-collapsed')"), true, "the app bar button toggles it too");
    await browser.evaluate("document.querySelector('#fabric-objects-toggle').click()");
  });

  for (const width of [768, 390, 320]) {
    test(`${width} px: a closed drawer (no tab stops); the Objects button opens it with focus inside; Tab is trapped; Escape closes and restores focus; no sideways scroll`, async () => {
      await browser.open(page, { width, height: 700 });
      await browser.evaluate("localStorage.clear(); __c.fabric.objects = null; __c.update()");
      assert.equal(await browser.evaluate(OVERFLOW), 0, "no sideways page scroll");
      assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#fabric-objects')).visibility"), "hidden", "closed drawer");
      const toggle = await browser.evaluate("(() => { const r = document.querySelector('#fabric-objects-toggle').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width > 0; })()");
      assert.equal(toggle, true, "the Objects button is on screen");
      assert.ok((await browser.evaluate("document.querySelector('#fabric-root').getBoundingClientRect().width")) >= width - 2, "rows get the full width");
      await browser.evaluate("document.querySelector('#fabric-objects-toggle').focus(); document.querySelector('#fabric-objects-toggle').click()");
      assert.ok(await browser.waitFor("getComputedStyle(document.querySelector('#fabric-objects')).visibility === 'visible'"));
      assert.equal(await browser.evaluate("document.querySelector('#fabric-objects').getAttribute('role') + '/' + document.querySelector('#fabric-objects').getAttribute('aria-modal')"), "dialog/true");
      assert.equal(await browser.evaluate("document.querySelector('#fabric-objects-toggle').getAttribute('aria-expanded')"), "true");
      assert.equal(await active(), "fabric-obj-inventory-all", "focus moves into the drawer");
      assert.equal(await browser.evaluate("(() => { const r = document.querySelector('#fabric-objects').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()"), true, "the drawer fits the viewport");
      // Tab cycles inside: Close (first) → the tree's stop (last) → wraps to Close; Shift+Tab on Close wraps to the tree.
      assert.equal(await key("Tab"), true, "Tab on the last stop wraps");
      assert.equal(await active(), "objects-close");
      assert.equal(await key("Tab", true), true, "Shift+Tab on the first wraps");
      assert.equal(await active(), "fabric-obj-inventory-all");
      await key("Escape");
      assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#fabric-objects')).visibility"), "hidden");
      assert.equal(await active(), "fabric-objects-toggle", "focus back to the Objects button");
      // Choosing an item closes the drawer and gives focus back too.
      await browser.evaluate("document.querySelector('#fabric-objects-toggle').click()");
      await browser.evaluate("document.querySelector('#fabric-obj-sales-all').click()");
      assert.ok(await browser.waitFor("__c.fabric.route.view === 'sales' && getComputedStyle(document.querySelector('#fabric-objects')).visibility === 'hidden'"));
      assert.equal(await active(), "fabric-objects-toggle");
      // The backdrop closes it as well.
      await browser.evaluate("document.querySelector('#fabric-objects-toggle').click()");
      await browser.evaluate("document.querySelector('.fx-objects__backdrop').click()");
      assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#fabric-objects')).visibility"), "hidden");
      assert.equal(await browser.evaluate(OVERFLOW), 0);
    });
  }

  test("dark theme: the panel uses the dark tokens", async () => {
    await browser.open(page, { width: 1440, height: 800 });
    await browser.evaluate("document.documentElement.dataset.theme = 'dark'");
    const bg = await browser.evaluate("getComputedStyle(document.querySelector('#fabric-objects')).backgroundColor");
    assert.equal(bg, "rgb(33, 42, 52)", "--fx-surface (dark)");
  });
});
