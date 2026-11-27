// T0 toolbar fixes, on the real browser model and markup in Node (no browser, synthetic data only):
//   - a column-header filter is kept with a saved view: it marks the view changed, "Save to this view" stores it as one
//     flat text setting the server accepts, and opening the view again restores it; views without one open as before;
//   - rollback safety: the release before T0 (ROLLBACK_REF, read from git) opens a view saved by T0 exactly as it opened it
//     before (it ignores the setting) and keeps the setting when it saves the view, so this release finds it again;
//   - the toolbar Sort button shows the number of sort levels (never a record count) and loses it when the sort is cleared;
//   - "Filter conditions…" is a plain button, not a menu item outside a menu.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { execFileSync } = require("child_process");
const { loadBrowser, memoryStorage } = require("./support/browser-model");
const { viewState } = require("../src/domain/board-schema");

const ROLLBACK_REF = process.env.JARC_ROLLBACK_REF || "fc9c58a"; // production before T0
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ASSETS = path.join(REPO_ROOT, "site", "assets");
const MODEL_FILES = ["ResourceApiAdapter.js", "StorageService.js", "BoardModel.js"];

// The rollback release's browser model, loaded the way support/browser-model.js loads this one.
function rollbackSources() {
  try { return Object.fromEntries(MODEL_FILES.map((f) => [f, execFileSync("git", ["show", `${ROLLBACK_REF}:site/assets/${f}`], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 }).toString("utf8")])); }
  catch { return null; }
}
function loadModelFrom(sources) {
  const window = { location: { search: "" }, localStorage: memoryStorage(), sessionStorage: memoryStorage(), dispatchEvent() {}, addEventListener() {} };
  const context = vm.createContext({ window, console, URLSearchParams, AbortController, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } } });
  for (const file of MODEL_FILES) vm.runInContext(sources[file], context, { filename: `${ROLLBACK_REF}/${file}` });
  return window;
}
async function boardModel(window) {
  const m = new window.BoardModel(new window.StorageService(new window.LocalAsyncAdapter()));
  await m.init();
  m.screen = "board"; m.currentBoardId = m.workspace.boards[0].id;
  m.board.records = ["Done", "Done", "Working on it", "Stuck", ""].map((status, i) => ({ id: `r${i}`, serial: `JOB-${100 + i}`, status, notes: i % 2 ? "north site" : "south site", owner: "AR" }));
  return m;
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const stateOf = (window, view) => plain(window.ResourceApiAdapter.viewState(view));
// What the server stores for a view's state (domain/board-schema.js), and the view the browser builds back from it.
const stored = (window, view) => viewState(stateOf(window, view), 0);
const reloaded = (state, view) => ({ ...plain(state), id: view.id, name: view.name });

describe("T0: column-header filters are saved with views", () => {
  test("setting one marks the view changed; Save keeps it; reopening the view (or a reload) restores it", async () => {
    const { window } = loadBrowser();
    const m = await boardModel(window);
    const view = m.createView("Done work");
    assert.equal(m.columnFilter, null);
    assert.equal(m.viewChanged, false);
    m.columnFilter = { key: "status", op: "in", value: ["Done"] };
    assert.equal(m.viewChanged, true, "Save to this view is offered");
    assert.equal(m.visibleRows.length, 2);
    assert.equal(m.saveActiveView(), true);
    assert.equal(m.viewChanged, false);
    assert.equal(typeof view.columnFilter, "string", "kept as one flat text setting");
    const state = stored(window, view);
    assert.deepEqual(JSON.parse(state.columnFilter), { key: "status", op: "in", value: ["Done"] }, "the server accepts and keeps it");
    m.openMainTable();
    assert.equal(m.columnFilter, null, "Main Table has no column filter");
    assert.equal(m.visibleRows.length, 5);
    m.applyView(view.id);
    assert.deepEqual(plain(m.columnFilter), { key: "status", op: "in", value: ["Done"] });
    assert.equal(m.visibleRows.length, 2);
    assert.equal(m.viewChanged, false);
    // A reload: the board comes back from the server as { ...state, id, name }.
    const fresh = await boardModel(loadBrowser().window);
    fresh.board.savedViews = [reloaded(state, view)];
    fresh.applyView(view.id);
    assert.deepEqual(plain(fresh.columnFilter), { key: "status", op: "in", value: ["Done"] });
    assert.equal(fresh.visibleRows.length, 2);
    assert.equal(fresh.viewChanged, false);
    // Changing it or clearing it marks the view changed again; saving a cleared filter removes the setting.
    fresh.columnFilter = { key: "notes", op: "contains", value: "north" };
    assert.equal(fresh.viewChanged, true);
    fresh.columnFilter = null;
    assert.equal(fresh.viewChanged, true);
    fresh.saveActiveView();
    assert.equal("columnFilter" in fresh.activeView, false);
    assert.equal("columnFilter" in stored(window, fresh.activeView), false);
    assert.equal(fresh.viewChanged, false);
  });

  test("every column-filter operator round-trips; duplicates keep it; a deleted column's filter drops out", async () => {
    const { window } = loadBrowser();
    const m = await boardModel(window);
    const view = m.createView("Ops");
    for (const f of [{ key: "status", op: "in", value: ["Done", "Stuck"] }, { key: "notes", op: "contains", value: "north" }, { key: "notes", op: "equals", value: "south site" }, { key: "received", op: "on", value: "2026-11-02" }, { key: "received", op: "before", value: "2026-11-02" }, { key: "notes", op: "empty", value: "" }, { key: "notes", op: "not-empty", value: "" }]) {
      m.applyView(view.id); m.columnFilter = f; const before = plain(m.visibleRows.map((r) => r.id));
      m.saveActiveView(); m.applyView(view.id);
      assert.deepEqual(plain(m.columnFilter), f, f.op);
      assert.deepEqual(plain(m.visibleRows.map((r) => r.id)), before, `${f.op}: the same records`);
      assert.deepEqual(JSON.parse(stored(window, view).columnFilter), f);
    }
    const copy = m.duplicateView(view.id);
    assert.deepEqual(plain(m.columnFilter), { key: "notes", op: "not-empty", value: "" }, "a duplicate opens with it");
    assert.equal(m.activeView, copy);
    m.board.columns = m.board.columns.filter((c) => c.key !== "notes");
    assert.equal(m.viewChanged, false, "a filter on a deleted column is neither saved nor a change");
    assert.equal(m.visibleRows.length, 5);
  });

  test("views without one (all existing views) open exactly as before; malformed settings are ignored", async () => {
    const { window } = loadBrowser();
    const m = await boardModel(window);
    m.board.savedViews = [{ id: 1, name: "Legacy", status: "Done", sortKey: "serial", sortDirection: "asc", view: "table", hiddenColumns: ["notes"] }];
    m.columnFilter = { key: "notes", op: "contains", value: "x" };
    m.applyView(1);
    assert.equal(m.columnFilter, null);
    assert.equal(m.viewChanged, false);
    assert.deepEqual(plain(m.visibleRows.map((r) => r.serial)), ["JOB-100", "JOB-101"]);
    assert.equal("columnFilter" in m.viewSnapshot(), false);
    for (const bad of ["{", "null", '"text"', JSON.stringify({ key: "status", op: "regex", value: "x" }), JSON.stringify({ key: "status", op: "in", value: [{ $gt: "" }] }), JSON.stringify({ key: "", op: "empty", value: "" }), 42]) {
      m.board.savedViews = [{ id: 2, name: "Bad", view: "table", columnFilter: bad }];
      m.applyView(2);
      assert.equal(m.columnFilter, null, String(bad));
      assert.equal(m.visibleRows.length, 5);
    }
  });

  test("a filter too long for one view setting is refused before it is applied", async () => {
    const { window } = loadBrowser();
    const many = Array.from({ length: 80 }, (_, i) => `A long status label ${i}`);
    assert.ok(window.BoardModel.columnFilterText({ key: "status", op: "in", value: many }).length > window.BoardModel.COLUMN_FILTER_MAX);
    assert.throws(() => viewState({ columnFilter: window.BoardModel.columnFilterText({ key: "status", op: "in", value: many }) }, 0), /too long/, "the server's limit the browser mirrors");
    const src = fs.readFileSync(path.join(ASSETS, "AppController.js"), "utf8");
    assert.match(src, /columnFilterText\(\{key,op,value\}\)\.length>BoardModel\.COLUMN_FILTER_MAX/);
  });

  const sources = rollbackSources();
  test(`rollback: ${ROLLBACK_REF} opens a T0 view as it did before, and keeps the setting when it saves it`, { skip: sources ? false : `git can't read ${ROLLBACK_REF}` }, async () => {
    const now = loadBrowser().window;
    const m = await boardModel(now);
    const view = m.createView("Done work");
    m.status = "Done"; m.columnFilter = { key: "notes", op: "contains", value: "south" };
    m.saveActiveView();
    const state = stored(now, view);
    const oldWindow = loadModelFrom(sources);
    assert.equal(typeof oldWindow.BoardModel.columnFilterText, "undefined", "really the release before T0");
    const old = await boardModel(oldWindow);
    old.board.savedViews = [reloaded(state, view)];
    old.applyView(view.id);
    assert.equal(old.columnFilter, null, "the older release ignores the setting");
    assert.deepEqual(plain(old.visibleRows.map((r) => r.serial)), ["JOB-100", "JOB-101"], "and shows the view's other filters as before");
    assert.equal(old.viewChanged, false, "the view isn't shown as changed");
    // Saving there (a sort change) keeps the setting, and the server still accepts the state.
    old.sortKey = "serial"; old.sortDirection = "asc";
    assert.equal(old.viewChanged, true);
    old.saveActiveView();
    const again = stored(oldWindow, old.activeView);
    assert.equal(again.columnFilter, state.columnFilter);
    assert.equal(again.sortKey, "serial");
    // Back on this release: the filter is there again.
    const back = await boardModel(loadBrowser().window);
    back.board.savedViews = [reloaded(again, view)];
    back.applyView(view.id);
    assert.deepEqual(plain(back.columnFilter), { key: "notes", op: "contains", value: "south" });
    assert.deepEqual(plain(back.visibleRows.map((r) => r.serial)), ["JOB-100"]);
    assert.equal(back.viewChanged, false);
  });
});

// The real AppView markup for the board screen, as the page renders it (mobile-layout.test.js does the same).
function markup(m) {
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null };
  const context = vm.createContext({ window: {}, document, console, Intl, Date, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, setTimeout: () => 0, clearTimeout() {} });
  for (const file of ["AppView.js", "IconLibrary.js", "Appearance.js", "BoardGroups.js", "CommentsPanel.js"]) vm.runInContext(fs.readFileSync(path.join(ASSETS, file), "utf8"), context);
  const root = { innerHTML: "" };
  new context.window.AppView(root).render(m);
  return root.innerHTML;
}
const sortButton = (html) => html.match(/<button[^>]*data-action="sort"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";

describe("T0: toolbar state", () => {
  test("Sort shows the number of sort levels while a sort is on, and nothing once it is cleared", async () => {
    const m = await boardModel(loadBrowser().window);
    let button = sortButton(markup(m));
    assert.ok(button, "the Sort button is there");
    assert.doesNotMatch(button, /tool-count|class="tool-button active"|aria-label=/, "no sort: no badge");
    m.sortKey = "serial"; m.sortDirection = "asc"; m.manualSort = false;
    button = sortButton(markup(m));
    assert.match(button, /class="tool-button active"/);
    assert.match(button, /aria-label="Sort, 1 active"/);
    assert.match(button, /<small class="tool-count" aria-hidden="true">1<\/small>/);
    m.viewOrderBy = [{ key: "status", dir: "asc" }, { key: "serial", dir: "desc" }];
    button = sortButton(markup(m));
    assert.match(button, /aria-label="Sort, 2 active"/);
    assert.match(button, />2<\/small>/, "the number of levels, never a record count");
    m.viewOrderBy = null; m.sortKey = ""; m.manualSort = true;
    button = sortButton(markup(m));
    assert.doesNotMatch(button, /tool-count|active/, "cleared");
  });

  test('"Filter conditions…" is a plain button that opens a dialog, not a menu item outside a menu', async () => {
    const html = markup(await boardModel(loadBrowser().window));
    const button = html.match(/<button[^>]*data-action="view-filter"[^>]*>/)?.[0];
    assert.ok(button);
    assert.doesNotMatch(button, /role=/);
    assert.match(button, /type="button"/);
    assert.match(button, /aria-haspopup="dialog"/);
  });
});
