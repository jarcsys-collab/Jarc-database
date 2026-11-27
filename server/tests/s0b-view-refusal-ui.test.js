// S0-B, browser side, in Node (no server, no browser): the unchanged BoardModel, AppView, StorageService and AppController's
// class in a vm context with synthetic boards. A saved view whose conditions name a Connect / Mirror column the reader can't open
// FAILS SAFELY on both paths: on a board filtered here the condition is never evaluated (the same refusal as the server); on a
// large board the server's 400 refusal (details.reason "restricted-filter") becomes the same message. Never unfiltered records
// under the view's name, never anything about the linked board beyond the column label; the conditions are kept for saving.
// Also: "partial" in CSV export and after a live refresh. Synthetic values only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { memoryStorage } = require("./support/browser-model");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (file) => fs.readFileSync(path.join(ASSETS, file), "utf8");
const hex = (n) => n.toString(16).padStart(24, "0");

function load() {
  const window = { location: { search: "", origin: "http://jarc.invalid" }, localStorage: memoryStorage(), sessionStorage: memoryStorage(), dispatchEvent() {}, addEventListener() {} };
  const overlay = { innerHTML: "", querySelector: () => null };
  const context = vm.createContext({
    window, console, Intl, Date, URL, URLSearchParams, AbortController, encodeURIComponent, JSON, Map, Set, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto,
    document: { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: (sel) => (sel === "#overlay-root" ? overlay : null), querySelectorAll: () => [], body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  });
  context.window = Object.assign(context, window);
  for (const file of ["ColumnTypes.js", "IconLibrary.js", "AppView.js", "ResourceApiAdapter.js", "StorageService.js", "BoardModel.js"]) vm.runInContext(read(file), context, { filename: file });
  const source = read("AppController.js"), bootstrap = 'try { new AppController(document.querySelector("#app")); }';
  assert.ok(source.includes(bootstrap));
  vm.runInContext(`${source.slice(0, source.indexOf(bootstrap))}\nglobalThis.AppController = AppController;`, context, { filename: "AppController.js" });
  return context;
}

describe("a saved view with a condition on a restricted Connect column (S0-B follow-up A)", () => {
  const ctx = load();
  const columns = [{ key: "serial", label: "Project", type: "text" }, { key: "client", label: "Clients", type: "connect", link: { boardId: hex(9) } }, { key: "total", label: "Total value", type: "mirror", mirror: { via: "client", column: "v", show: "sum" } }];
  const filter = { op: "and", rules: [{ key: "serial", cmp: "notEmpty" }, { key: "client", cmp: "notEmpty" }] };
  const rows = [{ id: hex(1), serial: "Alpha" }, { id: hex(2), serial: "Beta" }];
  const make = ({ restricted = new Set(["client", "total"]), view = true, storage = {}, viewFilter = filter, columnFilter = null } = {}) => {
    const m = Object.create(ctx.BoardModel.prototype);
    const board = { id: hex(7), name: "Projects", columns, groups: ["G"], savedViews: view ? [{ id: "v1", name: "Linked only", filter }] : [] };
    Object.defineProperties(m, { board: { value: board }, rows: { value: rows }, storage: { value: { restrictedColumns: () => restricted, canFilterOnServer: false, ...storage } } });
    Object.assign(m, { viewFilter, columnFilter, activeSavedViewId: view ? "v1" : null, query: "", status: "All", quickFilter: "all", personFilter: "", screen: "board", currentView: "table", sortDirection: "desc", sortKey: "", grouped: false, groupBy: "", showArchived: false });
    m.matchesFilterRule = () => { throw new Error("a restricted condition must never be evaluated in the browser"); };
    m.boardLoadState = () => ({ state: "full", loaded: rows.length, total: rows.length });
    return m;
  };
  const view = new ctx.AppView({ innerHTML: "" });

  test("client-filtered board: refused before any evaluation; no rows; the message names only the column and offers Main Table / other views", () => {
    const m = make();
    assert.deepEqual({ ...m.viewAccess() }, { state: "refused", scope: "view", key: "client", label: "Clients" });
    assert.deepEqual([...m.visibleRows], [], "no records under the view's name");
    const html = view.boardView(m);
    assert.match(html, /“Linked only” can't be shown/);
    assert.match(html, /This view filters on “Clients”, which links to a board you can't open, so it can't be shown to you\./);
    assert.match(html, /data-action="main-table"[^>]*>Go to Main Table</); assert.match(html, /data-action="views-menu"[^>]*>Choose another view</);
    assert.doesNotMatch(html, /Alpha|Beta|matching|record-row|<table/, "no rows, no count");
  });

  test("the conditions are kept as saved (never stripped): the snapshot that 'Save to this view' writes still holds them", () => {
    const m = make();
    assert.deepEqual(JSON.parse(JSON.stringify(m.viewSnapshot().filter)), filter);
    assert.deepEqual(JSON.parse(JSON.stringify(m.liveViewFilter)), filter);
  });

  test("unknown yet (saved copy, server not asked): 'checking', nothing evaluated; nothing restricted: no refusal", () => {
    const checking = make({ restricted: null });
    assert.deepEqual({ ...checking.viewAccess() }, { state: "checking" });
    assert.deepEqual([...checking.visibleRows], []);
    assert.match(view.boardView(checking), /Checking access to this view…/);
    const fine = make({ restricted: new Set() });
    assert.equal(fine.viewAccess(), null);
    assert.equal(make({ restricted: null, viewFilter: { op: "and", rules: [{ key: "serial", cmp: "notEmpty" }] } }).viewAccess(), null, "no Connect / Mirror condition: never held back");
  });

  test("a toolbar filter on the restricted column is refused the same way, with Clear filters", () => {
    const m = make({ view: false, viewFilter: null, columnFilter: { key: "client", op: "not-empty" } });
    assert.equal(m.viewAccess().scope, "filter");
    const html = view.boardView(m);
    assert.match(html, /You can't filter by “Clients”: it links to a board you can't open\./); assert.match(html, /data-action="clear-filters"/);
  });

  test("large board (server-filtered): the server's 400 refusal becomes the same message; never an error banner over unfiltered rows", async () => {
    const refusal = Object.assign(new ctx.StorageError("VALIDATION_ERROR", null), { details: ctx.StorageError.filterDetails({ reason: "restricted-filter", field: "client" }) });
    let asked = 0;
    // The server knows; the browser hasn't been told yet (no restricted columns on the page it saw).
    const m = make({ restricted: new Set(), storage: { canFilterOnServer: true, countFiltered: async () => { asked += 1; throw refusal; }, loadFiltered: async () => { throw new Error("no page after a refused count"); } } });
    m.statusChanged = () => {};
    assert.equal(m.viewAccess(), null);
    await m.startServerView(hex(7), "k", m.serverQuery(), true);
    assert.equal(asked, 1); assert.equal(m.serverView, null, "no server view (no error banner, no rows)");
    assert.deepEqual({ ...m.viewAccess() }, { state: "refused", scope: "view", key: "client", label: "Clients" });
    assert.deepEqual([...m.visibleRows], []);
    m.boardLoadState = () => ({ state: "partial", loaded: 2, total: 50000 });
    m.syncServerQuery(); assert.equal(asked, 1, "not asked again"); assert.equal(m.serverView, null);
    assert.match(view.boardView(m), /This view filters on “Clients”/);
    // Only a known reason with a safe key is kept from the server's details; any other text is dropped.
    assert.equal(ctx.StorageError.filterDetails({ reason: "restricted-filter", field: "a.b" }), null);
    assert.equal(ctx.StorageError.filterDetails({ reason: "other", field: "client" }), null);
  });
});

describe("partial in CSV export and after a live refresh (S0-B follow-up B)", () => {
  const ctx = load();
  const columns = [{ key: "serial", label: "Item", type: "text" }, { key: "client", label: "Clients", type: "connect", link: { boardId: hex(9) } }, { key: "n", label: "N", type: "mirror", mirror: { via: "client", column: "v", show: "count" } }];
  const many = Array.from({ length: 101 }, (_, i) => hex(1000 + i));
  const rows = [{ id: hex(1), serial: "Big", client: many }, { id: hex(2), serial: "Small", client: [hex(1000)] }];
  const model = (answer) => {
    const m = Object.create(ctx.BoardModel.prototype);
    Object.defineProperties(m, { board: { value: { id: hex(7), columns } }, rows: { value: rows }, storage: { value: { related: async () => answer() } } });
    return m;
  };
  const csvFor = (m) => { const c = Object.create(ctx.AppController.prototype); c.model = m; return rows.map((r) => c.csvLine(r)); };
  let partial = true;
  const answer = () => ({ linked: { client: { [hex(1000)]: { name: "Acme", archived: false } } }, values: { [hex(1)]: { n: 100 }, [hex(2)]: { n: 1 } }, restricted: [], unavailable: [], partial: partial ? { client: "cell-limit", n: "cell-limit" } : {} });

  test("export: the cut row's Connect and Mirror cells say [partial]; complete cells don't; mirrored values are exported", async () => {
    const m = model(answer);
    m.relatedState().wanted = new Set([hex(1), hex(2)]); await m.flushRelated();
    const [big, small] = csvFor(m);
    assert.match(big, /^"Big","Acme, linked record.*\[partial\]","100 \[partial\]"$/);
    assert.equal(small, '"Small","Acme","1"');
  });

  test("live refresh (invalidateRelated + a new answer): the mark follows the server's latest answer", async () => {
    const m = model(answer);
    partial = true; m.relatedState().wanted = new Set([hex(1)]); await m.flushRelated();
    assert.equal(m.relatedPartial(rows[0], "n"), "cell-limit");
    m.invalidateRelated(); partial = false; m.relatedState().wanted = new Set([hex(1)]); await m.flushRelated();
    assert.equal(m.relatedPartial(rows[0], "n"), null);
    assert.doesNotMatch(csvFor(m)[0], /partial/);
  });

  test("board cache: the mark lives only in memory with the /related answer, never on the rows a saved copy keeps", async () => {
    const m = model(answer);
    partial = true; m.relatedState().wanted = new Set([hex(1), hex(2)]); await m.flushRelated();
    for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ["client", "id", "serial"], "rows unchanged (BoardCache stores rows)");
    assert.doesNotMatch(read("BoardCache.js"), /relatedStore|partial/, "the saved copy never stores relation answers");
  });

  test("export of a restricted column: [restricted], never IDs or a count", async () => {
    const m = model(() => ({ linked: {}, values: { [hex(1)]: {}, [hex(2)]: {} }, restricted: ["client", "n"], unavailable: [], partial: {} }));
    m.relatedState().wanted = new Set([hex(1), hex(2)]); await m.flushRelated();
    for (const line of csvFor(m)) { assert.match(line, /^"(Big|Small)","\[restricted\]","\[restricted\]"$/); assert.ok(!line.includes(hex(1000))); }
  });
});

// T0 x S0-B: since T0 a saved view keeps its column-header filter as one text setting (columnFilter, JSON) and restores it when
// the view opens. A saved columnFilter on a Connect column the reader can't open must be refused exactly like the toolbar filter
// and the view's own conditions: never evaluated here, sent to the server only inside `also` (which the server refuses), and kept
// as saved (never stripped) so 'Save to this view' doesn't lose it.
describe("T0 saved column filter on a restricted Connect column (T0 x S0-B)", () => {
  const ctx = load();
  const { refuseRestricted } = require("../src/domain/record-filter");
  const columns = [{ key: "serial", label: "Project", type: "text" }, { key: "client", label: "Clients", type: "connect", link: { boardId: hex(9) } }];
  const rows = [{ id: hex(1), serial: "Alpha" }, { id: hex(2), serial: "Beta" }];
  const saved = (key) => ({ id: "v2", name: "Linked", columnFilter: ctx.BoardModel.columnFilterText({ key, op: "not-empty", value: "" }) });
  const open = (key, restricted = new Set(["client"])) => {
    const m = Object.create(ctx.BoardModel.prototype);
    const board = { id: hex(7), name: "Projects", columns, groups: ["G"], savedViews: [saved(key)] };
    Object.defineProperties(m, { board: { value: board }, rows: { value: rows }, storage: { value: { restrictedColumns: () => restricted, canFilterOnServer: false } } });
    Object.assign(m, { viewFilter: null, columnFilter: null, activeSavedViewId: null, query: "", status: "All", quickFilter: "all", personFilter: "", screen: "board", currentView: "table", sortDirection: "desc", sortKey: "", grouped: false, groupBy: "", showArchived: false });
    m.save = () => {}; m.idAliases = new Map();
    m.matchesFilterRule = () => { throw new Error("a restricted condition must never be evaluated in the browser"); };
    m.matchesColumnFilter = () => { throw new Error("a restricted column filter must never be evaluated in the browser"); };
    m.boardLoadState = () => ({ state: "full", loaded: rows.length, total: rows.length });
    m.applyView("v2");
    return m;
  };
  const view = new ctx.AppView({ innerHTML: "" });

  test("opening the view restores the filter and refuses it (scope filter): no rows, no count, nothing evaluated", () => {
    const m = open("client");
    assert.deepEqual({ ...m.columnFilter }, { key: "client", op: "not-empty", value: "" });
    assert.deepEqual({ ...m.viewAccess() }, { state: "refused", scope: "filter", key: "client", label: "Clients" });
    assert.deepEqual([...m.visibleRows], []);
    const html = view.boardView(m);
    assert.match(html, /You can't filter by “Clients”: it links to a board you can't open\./);
    assert.doesNotMatch(html, /Alpha|Beta|record-row|<table/);
  });

  test("kept as saved: the view snapshot still holds the columnFilter text", () => {
    const m = open("client");
    assert.deepEqual({ ...ctx.BoardModel.columnFilterFrom(m.viewSnapshot().columnFilter) }, { key: "client", op: "not-empty", value: "" });
  });

  test("server path: the filter travels in `also`, which the server refuses with restricted-filter (no oracle)", () => {
    const q = open("client").serverQuery();
    const also = JSON.parse(JSON.stringify(q.also));
    assert.deepEqual(also, { op: "and", rules: [{ key: "client", cmp: "notEmpty" }] });
    assert.throws(() => refuseRestricted([q.filter, also], { columns }, new Set(["client"])), (e) => e.details?.reason === "restricted-filter" && e.details.field === "client");
  });

  test("a saved column filter on a column the reader can open is not held back", () => {
    const m = open("serial");
    m.matchesColumnFilter = () => true;
    assert.equal(m.viewAccess(), null);
    assert.equal(open("client", new Set()).viewAccess(), null);
  });
});
