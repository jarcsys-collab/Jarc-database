// Fabric Data frontend (site/assets/FabricDataPanel.js, FabricExplorer.js, FabricApiPanel.js, FabricApiDocs.js and the
// AppView/AppController/EntraAuth integration), contract v2: Inventory · Sales · API Management. Drives the unchanged browser
// files in a vm with stubbed DOM pieces, a stubbed adapter and a fake localStorage: no server, no network. Synthetic data only
// (field names as in the verified FactInventory/FactSales schemas, values made up).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
const NOW = new Date("2026-03-15T10:00:00Z");
const ID1 = "a".repeat(24), ID2 = "b".repeat(24);

function fakeStorage() {
  const m = new Map();
  return { map: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear() };
}

function load({ pathname = "/", search = "" } = {}) {
  const listeners = {};
  const history = { state: null, calls: [], pushState(s, _t, url) { this.calls.push(["push", url]); this.state = s; apply(url); }, replaceState(s, _t, url) { this.calls.push(["replace", url]); this.state = s; apply(url); } };
  const location = { pathname, search, origin: "https://jarc.example.test", protocol: "https:", href: `https://jarc.example.test${pathname}${search}` };
  function apply(url) { const u = new URL(url, location.origin); location.pathname = u.pathname; location.search = u.search; location.href = u.href; }
  const localStorage = fakeStorage();
  const window = { location, history, localStorage, addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); }, dispatchEvent() {} };
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } } };
  const context = vm.createContext({ window, document, console, Intl, Date, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, CSS: { escape: (v) => v } });
  // As index.html loads them (files another part of the redesign adds are loaded when present).
  const files = ["AppView.js", "EntraAuth.js", "AppModules.js", "FabricFieldMeta.js", "FabricRecordView.js", "FabricApiDocs.js", "FabricApiPanel.js", "FabricExplorer.js", "FabricDataPanel.js"].filter((f) => fs.existsSync(path.join(ASSETS, f)));
  for (const f of files) vm.runInContext(read(f), context, { filename: f });
  const source = read("AppController.js"), bootstrap = 'try { new AppController(document.querySelector("#app")); }';
  assert.ok(source.includes(bootstrap), "AppController.js still ends with its bootstrap line");
  vm.runInContext(source.slice(0, source.indexOf(bootstrap)), context, { filename: "AppController.js" });
  const get = (name) => vm.runInContext(name, context);
  const FabricDataPanel = get("FabricDataPanel");
  FabricDataPanel.now = () => NOW;
  return { context, window, document, history, location, listeners, localStorage, get, FabricDataPanel, FabricExplorer: get("FabricExplorer"), AppView: get("AppView"), AppController: get("AppController"), EntraAuth: get("EntraAuth") };
}

// A FabricDataPanel with a stub controller; adapter.request answers from `answers` (path → value, function or Error; matched
// exactly or as the path before "?") and records calls.
function panelWith(env, { features = { read: true }, answers = {}, screen = "fabric" } = {}) {
  const calls = [];
  const adapter = { mode: "resource", async request(method, p, body) { calls.push([method, p, body]); const hit = Object.entries(answers).find(([k]) => p === k || p.startsWith(`${k}?`)); if (!hit) throw Object.assign(new Error("no answer"), { code: "NOT_FOUND", cause: { status: 404 } }); if (hit[1] instanceof Error) throw hit[1]; return typeof hit[1] === "function" ? hit[1](p) : hit[1]; } };
  const view = new env.AppView({ innerHTML: "" });
  const controller = { model: { features: features === null ? {} : { fabricData: features }, storage: { adapter }, screen }, view, updates: 0, update() { this.updates += 1; }, syncBoardUrl() {} };
  const panel = new env.FabricDataPanel(controller);
  view.fabricPanel = panel; controller.fabric = panel;
  return { panel, controller, calls, view, answers };
}
const serverError = (status, serverCode, requestId) => Object.assign(new Error("x"), { code: status === 403 ? "FORBIDDEN" : status === 503 ? "SERVICE_UNAVAILABLE" : "VALIDATION_ERROR", cause: { status, serverCode }, requestId });
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const HOSTILE = `<img src=x onerror="alert(1)">`;
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---- Synthetic schemas and rows (contract v2 §3)
const INV_FIELDS = [["_id", "objectId"], ["Entry_No", "int"], ["Posting_Date", "date"], ["Entry_Type", "string"], ["Document_Type", "string"], ["Document_No", "string"], ["Item_No", "string"], ["Item_Description", "string"], ["Location_Code", "string"], ["Quantity", "decimal"], ["Remaining_Quantity", "decimal"], ["Unit_of_Measure_Code", "string"], ["Open", "bool"], ["Company", "string"]];
const SENSITIVE_FIELD = "Cost_Amount_Actual"; // only ever in a fixture the server would send to sensitive readers
function inventorySchema({ sensitive = false, extra = [] } = {}) {
  const fields = INV_FIELDS.map(([name, type]) => ({ name, type, filterable: ["Entry_Type", "Item_No", "Open", "Company"].includes(name), sortable: ["Posting_Date", "Entry_No"].includes(name), searchable: ["Item_No", "Item_Description", "Document_No"].includes(name) }));
  if (sensitive) fields.push({ name: SENSITIVE_FIELD, type: "decimal", sensitive: true, filterable: false, sortable: false, searchable: false });
  return { dataset: "inventory", label: "Inventory", fields: [...fields, ...extra],
    filters: [{ name: "company", field: "Company", type: "string", options: ["CO_A", null, HOSTILE] }, { name: "entryType", field: "Entry_Type", type: "string" }, { name: "itemNo", field: "Item_No", type: "string" }, { name: "open", field: "Open", type: "bool" }],
    sorts: [{ name: "date", fields: ["Posting_Date", "Company", "Entry_No", "_id"] }, { name: "entryNo", fields: ["Company", "Entry_No", "_id"] }],
    defaultColumns: ["Posting_Date", "Company", "Entry_No", "Entry_Type", "Document_No", "Item_No", "Item_Description", "Location_Code", "Quantity", "Remaining_Quantity", "Unit_of_Measure_Code"],
    dateField: "Posting_Date", recordKey: ["Company", "Entry_No"] };
}
const salesSchema = () => ({ dataset: "sales", label: "Sales", fields: [{ name: "invoice_date", type: "date", sortable: true }, { name: "Company", type: "string" }, { name: "invoice_id", type: "string", searchable: true }, { name: "customer_name", type: "string", searchable: true }, { name: "invoice_item_amount", type: "decimal" }],
  filters: { company: { field: "Company", type: "string" }, salesType: { field: "sales_type", type: "string" } }, sorts: { date: ["invoice_date", "Company", "invoice_id", "_id"] }, defaultColumns: ["invoice_date", "Company", "invoice_id", "customer_name"], dateField: "invoice_date", recordKey: ["Company", "invoice_id"] });
const row = (id, over = {}) => ({ id, values: { Posting_Date: "2026-03-01T00:00:00.000Z", Company: "CO_A", Entry_No: 1001, Entry_Type: "Sale", Document_No: "DOC-0001", Item_No: "ITEM-0001", Item_Description: "Example item", Location_Code: "LOC1", Quantity: -2, Remaining_Quantity: 0, Unit_of_Measure_Code: "PCS", ...over } });
const page = (items, over = {}) => ({ items, pagination: { limit: 100, hasMore: false, nextCursor: null }, window: { dateFrom: "2026-02-14", dateTo: "2026-03-15" }, access: { sensitive: false }, ...over });
const STATUS_OK = { available: true, datasets: { inventory: { mode: "small", latestDate: "2026-03-15T00:00:00Z", missingIndexes: [] }, sales: { mode: "indexed", missingIndexes: [] } }, access: { datasets: ["sales", "inventory"], sensitive: false } };
function inventoryPanel(env, { schema = inventorySchema(), records = page([row(ID1)]), status = STATUS_OK, features = { read: true }, extra = {} } = {}) {
  return panelWith(env, { features, answers: { "/fabric/status": status, "/fabric/inventory/schema": schema, "/fabric/inventory/records": records, ...extra } });
}
const recordsCall = (calls) => { const c = calls.filter(([, p]) => p.startsWith("/fabric/inventory/records?")).at(-1); return c ? new URLSearchParams(c[1].split("?")[1]) : null; };

describe("Fabric Data: addresses (contract v2 routes)", () => {
  const env = load();
  const F = env.FabricDataPanel, X = env.FabricExplorer;

  test("dataset, record and API paths parse; record IDs must be 24 hex characters", () => {
    assert.deepEqual(plain(F.parsePath("/fabric/inventory")), { view: "inventory", recordId: "", query: plain(X.emptyQuery()) });
    assert.equal(F.parsePath("/fabric/sales/").view, "sales");
    assert.deepEqual(plain(F.parsePath(`/fabric/sales/records/${ID1}`)).recordId, ID1);
    assert.equal(F.parsePath(`/fabric/inventory/records/${"A".repeat(24)}`).recordId, "A".repeat(24));
    assert.deepEqual(plain(F.parsePath("/fabric/api")), { view: "api" });
    for (const p of ["/", "/fabric", "/fabric/", "/fabric/inventory/records", `/fabric/inventory/records/${"g".repeat(24)}`, `/fabric/inventory/records/${ID1}/x`, "/fabric/sales/abc", "/fabric/other", "/fabric/api/x/y", "/fabric/sales-lines/a/b", "/boards/100001"]) assert.equal(F.parsePath(p), undefined, p);
  });

  test("filters in the query string: parsed, invalid values dropped, written back canonically", () => {
    const q = X.parseQuery("?dateFrom=2026-01-01&dateTo=2026-01-31&q=%20abc%20&company=~&entryType=Sale&sort=entryNo&dir=asc&limit=200&cursor=zzz&fields=a,b");
    assert.deepEqual(plain(q), { dateFrom: "2026-01-01", dateTo: "2026-01-31", q: "abc", sort: "entryNo", dir: "asc", limit: 200, filters: { company: "~", entryType: "Sale" } });
    assert.equal(X.formatQuery(q), "?dateFrom=2026-01-01&dateTo=2026-01-31&q=abc&company=~&entryType=Sale&sort=entryNo&dir=asc&limit=200");
    const bad = X.parseQuery("?dateFrom=2026-02-30&dateTo=2026-03-01&limit=7&dir=sideways&sort=a%20b&__proto__=x&9x=1&ok=%01");
    assert.deepEqual(plain(bad), plain(X.emptyQuery()), "only valid parts survive");
    assert.equal(X.formatQuery(X.emptyQuery()), "", "defaults stay out of the address");
    assert.equal(X.formatQuery(X.parseQuery("?dateFrom=2026-01-01")), "", "one date alone is ignored");
  });

  test("formatPath writes every view; records encode their ID; samePath compares what is asked", () => {
    assert.deepEqual(plain(F.formatPath({ view: "inventory", query: { ...X.emptyQuery(), q: "x y" } })), { path: "/fabric/inventory", search: "?q=x+y" });
    assert.equal(F.formatPath({ view: "sales", recordId: ID1, query: X.emptyQuery() }).path, `/fabric/sales/records/${ID1}`);
    assert.equal(F.formatPath({ view: "sales", recordId: "not-an-id" }).path, "/fabric/sales");
    assert.equal(F.formatPath({ view: "api" }).path, "/fabric/api");
    assert.equal(F.formatPath(null).path, "/fabric/inventory");
    assert.ok(F.samePath("/fabric/sales-lines", "/fabric/sales"), "the old Sales Lines path counts as Sales");
    assert.ok(F.samePath("/fabric/inventory/", "/fabric/inventory"));
    assert.ok(!F.samePath(`/fabric/sales/records/${ID1}`, `/fabric/sales/records/${ID2}`));
    assert.ok(!F.samePath("/fabric/inventory", "/fabric/sales"));
  });

  test("legacy paths: /fabric/sales-lines is Sales; invoice paths still parse (shown only with invoiceViews)", () => {
    const sl = F.parsePath("/fabric/sales-lines", "?dateFrom=2026-01-01&dateTo=2026-01-02&company=CO_A");
    assert.equal(sl.view, "sales"); assert.equal(sl.legacy, true); assert.equal(sl.query.dateFrom, "2026-01-01"); assert.equal(sl.query.filters.company, "CO_A");
    const inv = F.parsePath("/fabric/invoices/~/A%2FB", "?q=1");
    assert.equal(inv.view, "invoice"); assert.equal(inv.company, null); assert.equal(inv.invoiceNo, "A/B"); assert.equal(inv.query.q, "1");
    assert.equal(F.parsePath("/fabric/invoices").view, "invoices");
    assert.equal(F.formatPath({ view: "invoice", company: "CO A", invoiceNo: "1/2", filters: F.parseFilters("invoices", "") }).path, "/fabric/invoices/CO%20A/1%2F2");
  });

  test("EntraAuth.isAppPath accepts the v2 Fabric pages (and the legacy ones the page redirects) and nothing broader", () => {
    const ok = ["/", "/index.html", "/boards/100001", "/fabric/inventory", "/fabric/sales/", `/fabric/inventory/records/${ID1}`, `/fabric/sales/records/${ID1}/`, "/fabric/api", "/fabric/sales-lines", "/fabric/invoices", "/fabric/invoices/~/12345"];
    for (const p of ok) assert.ok(env.EntraAuth.isAppPath(p), p);
    for (const p of ["/fabric", "/fabric/", "/fabric/inventory/records", `/fabric/inventory/records/${ID1}x`, "/fabric/sales/x", "/fabric/other", "//fabric/sales", "/api/v1/fabric/sales", "/fabric/invoices/a"]) assert.ok(!env.EntraAuth.isAppPath(p), p);
  });
});

describe("Fabric Data: navigation and gating", () => {
  test("hidden without features.fabricData.read; shown above Settings with it", () => {
    const env = load();
    for (const features of [null, { read: false, apiAdmin: true, apiTokens: true }]) {
      const { panel, view } = panelWith(env, { features });
      assert.equal(panel.visible, false);
      assert.equal(view.fabricNav({ screen: "fabric" }), "");
      assert.doesNotMatch(panel.html(), /fabric-root/);
    }
    const { panel, view } = panelWith(env, { features: { read: true } });
    assert.equal(panel.visible, true);
    const nav = view.fabricNav({ screen: "fabric" });
    assert.match(nav, /data-screen="fabric"/); assert.match(nav, /data-tooltip="Fabric Data"/); assert.match(nav, /aria-current="page"/);
    assert.match(nav, /class="sidebar-settings nav-module nav-fabric active"/);
    assert.match(read("AppView.js"), /<div class="sidebar-footer">\$\{this\.moduleNav\(model\)\}<button class="sidebar-settings" data-action="settings"/);
  });

  test("tabs: Inventory · Sales; Invoices only with invoiceViews; API Management only for API admins with tokens on", () => {
    const env = load();
    const tabs = (features) => panelWith(env, { features }).panel.sections().map(([id]) => id).join(",");
    assert.equal(tabs({ read: true }), "inventory,sales");
    assert.equal(tabs({ read: true, apiAdmin: true }), "inventory,sales");
    assert.equal(tabs({ read: true, apiTokens: true }), "inventory,sales");
    assert.equal(tabs({ read: true, apiAdmin: true, apiTokens: true }), "inventory,sales,api");
    assert.equal(tabs({ read: true, invoiceViews: true }), "inventory,sales,invoices");
    assert.equal(tabs({ read: true, datasets: ["sales"] }), "sales", "a dataset /features leaves out has no tab");
    const { panel } = panelWith(env, { features: { read: true, apiAdmin: true, apiTokens: true } });
    const html = panel.html();
    assert.match(html, /<span>API Management<\/span><\/button>/); assert.doesNotMatch(html, /Sales Lines|Fabric API<\/span><\/button>/);
    assert.match(html, /Read-only/);
  });

  test("app bar: icon, name, tabs, Read-only, connection chip and Refresh; no page title or description; nothing editable", () => {
    const env = load();
    const { panel } = panelWith(env, { features: { read: true, apiAdmin: true, apiTokens: true } });
    const html = panel.html();
    assert.match(html, /^<div class="fx-app" data-fx-view="inventory"><header class="fx-appbar">/);
    assert.match(html, /<h1 class="fx-appbar__title">Fabric Data<\/h1>/);
    assert.match(html, /<nav class="fx-appbar__tabs" role="tablist" aria-label="Fabric Data sections">/);
    assert.deepEqual([...html.matchAll(/data-section="(\w+)"/g)].map((m) => m[1]), ["inventory", "sales", "api"], "Inventory · Sales · API Management");
    assert.match(html, /class="fx-chip fx-chip--readonly"/); assert.match(html, /class="fx-chip fx-chip--conn is-info"[^>]*>.*Checking…/, "before /status answers");
    assert.match(html, /data-action="fabric-refresh"[^>]*aria-label="Refresh"/);
    assert.match(html, /<div id="fabric-root" class="fx-app__body fabric-root" role="tabpanel" aria-labelledby="fabric-tab-inventory" data-module-scroll/);
    assert.doesNotMatch(html, /page-head|eyebrow|apitok-tabs|Rows from the Fabric/, "no large page title, description or the old tab strip");
    assert.doesNotMatch(html, /data-action="fabric-[a-z-]*(create|edit|delete|import|export|archive)/);
  });

  test("status: statusFor and the connection chip (connected / index required / refreshing upstream / unavailable / access denied)", () => {
    const env = load();
    const { panel } = panelWith(env);
    const chip = () => panel.connectionHtml().match(/is-(\w+)"[^>]*>.*<span>([^<]+)<\/span><\/span>$/).slice(1).join(" ");
    assert.equal(panel.statusFor("inventory"), null);
    panel.status = STATUS_OK;
    assert.equal(chip(), "ok Connected"); assert.equal(panel.statusHtml(), "", "nothing more to say when all is well");
    assert.deepEqual(plain(panel.statusFor("inventory")), { mode: "small", available: true, reason: null, missingIndexes: [], window: null });
    panel.status = { available: true, datasets: { inventory: { available: false, mode: "unavailable", reason: "FABRIC_INDEX_REQUIRED", missingIndexes: [{ name: "idx_<b>" }] } } };
    assert.equal(panel.statusFor("inventory").mode, "indexrequired"); assert.equal(chip(), "warn Index required");
    assert.match(panel.statusHtml(), /fx-status fx-status--warn/); assert.match(panel.statusHtml(), /Index: idx_&lt;b&gt;/); assert.match(panel.statusHtml(), /<pre id="fabric-status-details" class="fx-status__details" hidden>/);
    panel.status = { available: true, datasets: { inventory: { available: false, mode: "unavailable", reason: "FABRIC_SOURCE_MISSING" } } };
    assert.equal(chip(), "warn Refreshing upstream");
    panel.status = { available: false, reason: "FABRIC_UNAVAILABLE" };
    assert.equal(chip(), "error Unavailable"); assert.equal(panel.statusFor("sales").available, false);
    panel.status = null; panel.statusError = { kind: "unavailable", code: "SERVICE_UNAVAILABLE", message: "x", reference: "" };
    assert.equal(chip(), "error Unavailable");
    panel.denied = true; assert.equal(chip(), "error Access denied");
  });

  test("status: the small-collection index advice is a compact info line with collapsed details (Details toggles them)", () => {
    const env = load();
    const { panel } = panelWith(env);
    panel.status = { ...STATUS_OK, datasets: { ...STATUS_OK.datasets, inventory: { mode: "small", missingIndexes: [{ name: "fabric_inventory_date" }] } } };
    let line = panel.statusHtml();
    assert.match(line, /^<div class="fx-status fx-status--info" role="status">/); assert.match(line, /Indexes recommended/);
    assert.match(line, /aria-expanded="false" aria-controls="fabric-status-details">Details<\/button>/); assert.match(line, /hidden>Mode: small\nIndex: fabric_inventory_date<\/pre>/);
    panel.onAction("fabric-status-details", { tagName: "BUTTON", dataset: {} }, {});
    line = panel.statusHtml();
    assert.match(line, /aria-expanded="true"/); assert.doesNotMatch(line, / hidden>/);
    panel.forget(); assert.equal(panel.statusOpen, false, "forgotten when the session ends");
  });

  test("fabric-r-… actions, inputs and changes go to the explorer named by data-ds", () => {
    const env = load();
    const { panel } = panelWith(env);
    const seen = [];
    panel.explorers.sales.onAction = (a) => seen.push(["action", a]); panel.explorers.sales.onInput = (t) => seen.push(["input", t.dataset.action]); panel.explorers.sales.onChange = (t) => seen.push(["change", t.dataset.action]);
    const target = { tagName: "BUTTON", dataset: { action: "fabric-r-tab", ds: "sales" } };
    panel.onAction("fabric-r-tab", target, {}); panel.onInput(target); panel.onChange(target);
    panel.onAction("fabric-r-tab", { tagName: "BUTTON", dataset: { ds: "other" } }, {});
    assert.deepEqual(seen, [["action", "fabric-r-tab"], ["input", "fabric-r-tab"], ["change", "fabric-r-tab"]]);
  });

  test("applyRoute: API without the right → Inventory; invoice paths → Sales unless invoiceViews; Sales Lines → Sales", () => {
    const env = load(), F = env.FabricDataPanel;
    const a = panelWith(env, { features: { read: true } }).panel;
    a.applyRoute(F.parsePath("/fabric/api")); assert.equal(a.route.view, "inventory");
    a.applyRoute(F.parsePath("/fabric/invoices/CO/1", "?q=abc")); assert.equal(a.route.view, "sales"); assert.equal(a.explorers.sales.query.q, "abc");
    assert.equal(a.urlFor().path, "/fabric/sales");
    a.applyRoute(F.parsePath("/fabric/sales-lines", "?company=~")); assert.equal(a.route.view, "sales"); assert.equal(a.explorers.sales.query.filters.company, "~");
    assert.deepEqual(plain(a.urlFor()), { path: "/fabric/sales", search: "?company=~" });
    const b = panelWith(env, { features: { read: true, invoiceViews: true } }).panel;
    b.applyRoute(F.parsePath("/fabric/invoices/~/9")); assert.equal(b.route.view, "invoice"); assert.equal(b.route.company, null);
    assert.equal(b.urlFor().path, "/fabric/invoices/~/9");
    const c = panelWith(env, { features: { read: true, datasets: ["sales"] } }).panel;
    c.applyRoute(F.parsePath(`/fabric/inventory/records/${ID1}`)); assert.equal(c.route.view, "sales"); assert.equal(c.explorers.inventory.recordId, "");
  });

  test("a saved or linked Fabric screen falls back to Home when not permitted", () => {
    const env = load();
    const { view } = panelWith(env, { features: null });
    let homes = 0; view.home = () => { homes += 1; return "HOME"; };
    assert.equal(view.content({ screen: "fabric", workspace: { id: "w" } }), "HOME");
    assert.equal(homes, 1);
    assert.match(read("AppController.js"), /if \(this\.model\.screen === "fabric" && !this\.fabric\?\.visible\) this\.model\.screen = "home";/);
  });

  test("syncBoardUrl: /fabric/inventory first; a filter change replaces; a record pushes; another screen goes back to /", () => {
    const env = load({ pathname: "/" });
    const { panel, controller } = panelWith(env);
    const ctrl = { ready: true, boardLinksEnabled: true, signedIn: true, boardUrlStart: false, model: controller.model, fabric: panel };
    const sync = () => env.AppController.prototype.syncBoardUrl.call(ctrl);
    sync();
    assert.deepEqual(env.history.calls.at(-1), ["push", "/fabric/inventory"]);
    sync();
    assert.equal(env.history.calls.length, 1, "already there: nothing more");
    panel.explorers.inventory.query = { ...panel.explorers.inventory.query, q: "abc" };
    sync();
    assert.deepEqual(env.history.calls.at(-1), ["replace", "/fabric/inventory?q=abc"]);
    panel.explorers.inventory.openRecord(ID1);
    sync();
    assert.deepEqual(env.history.calls.at(-1), ["push", `/fabric/inventory/records/${ID1}?q=abc`]);
    panel.applyRoute({ view: "sales", query: env.FabricExplorer.emptyQuery() }); sync();
    assert.deepEqual(env.history.calls.at(-1), ["push", "/fabric/sales"]);
    controller.model.screen = "home"; sync();
    assert.deepEqual(env.history.calls.at(-1), ["push", "/"]);
    controller.model.features = {}; controller.model.screen = "fabric"; sync();
    assert.equal(env.location.pathname, "/", "without the right, never a Fabric address");
  });

  test("applyBoardUrl opens a Fabric link (legacy Sales Lines → /fabric/sales in place) and ignores it for others", () => {
    const env = load({ pathname: "/fabric/sales-lines", search: "?q=x" });
    const { panel, controller } = panelWith(env, { screen: "home" });
    controller.model.openScreen = function (s) { this.screen = s; this.boardLinkProblem = null; };
    const ctrl = { boardLinksEnabled: true, model: controller.model, fabric: panel, ready: true, signedIn: true, boardUrlStart: false };
    assert.equal(env.AppController.prototype.applyBoardUrl.call(ctrl, {}), true);
    assert.equal(controller.model.screen, "fabric"); assert.equal(panel.route.view, "sales"); assert.equal(panel.explorers.sales.query.q, "x");
    env.AppController.prototype.syncBoardUrl.call(ctrl);
    assert.deepEqual(env.history.calls.at(-1), ["replace", "/fabric/sales?q=x"], "the old address is replaced, not pushed");
    const other = panelWith(env, { features: null, screen: "home" });
    other.controller.model.openScreen = function (s) { this.screen = s; };
    assert.equal(env.AppController.prototype.applyBoardUrl.call({ boardLinksEnabled: true, model: other.controller.model, fabric: other.panel }, {}), false);
    assert.equal(other.controller.model.screen, "home");
  });
});

describe("Fabric Data: error messages", () => {
  const { FabricDataPanel: F } = load();
  test("each server code has its own message and kind", () => {
    const cases = [
      [403, "FABRIC_DATA_FORBIDDEN", "denied", /don't have access to Fabric Data/],
      [503, "FABRIC_INDEX_REQUIRED", "index", /waiting for the data team to add indexes/],
      [503, "FABRIC_SOURCE_MISSING", "source", /being refreshed upstream/],
      [404, "FABRIC_RECORD_NOT_FOUND", "record", /may have been refreshed[\s\S]*Reload/],
      [422, "FABRIC_RANGE_TOO_LARGE", "range", /narrow the date range or choose a company/i],
      [429, "FABRIC_BUSY", "busy", /busy\. Try again in a moment/],
      [503, "FABRIC_UNAVAILABLE", "unavailable", /can't be reached/],
      [503, "FABRIC_TIMEOUT", "range", /Narrow the date range/],
      [404, "FABRIC_INVOICE_NOT_FOUND", "missing", /isn't in the Fabric data/]
    ];
    for (const [status, code, kind, re] of cases) { const info = F.errorInfo(serverError(status, code)); assert.equal(info.kind, kind, code); assert.match(info.message, re, code); assert.doesNotMatch(info.message, /permission to make this change/); }
  });
  test("a 403 without a code is access denied; the request reference is kept only when well-formed", () => {
    const info = F.errorInfo(serverError(403, null, "req-abcdef12"));
    assert.equal(info.kind, "denied"); assert.equal(info.reference, "req-abcdef12");
    assert.equal(F.errorInfo(serverError(503, null, "bad id with spaces")).reference, "");
  });
});

describe("Fabric Data: explorer (schema-driven)", () => {
  test("columns, filters and sortable headers come from the schema; the request names the default columns", async () => {
    const env = load();
    const { panel, calls } = inventoryPanel(env);
    panel.ensure(); await settle();
    const q = recordsCall(calls);
    assert.ok(calls.some(([, p]) => p === "/fabric/inventory/schema"), "schema first");
    assert.equal(q.get("fields"), inventorySchema().defaultColumns.join(","));
    assert.equal(q.get("limit"), "100"); assert.equal(q.get("dateFrom"), null, "no dates: the server's window"); assert.equal(q.get("cursor"), null);
    const html = panel.body();
    // Headers show friendly labels; each header's title starts with the schema field name it stands for.
    const heads = [...html.matchAll(/<th scope="col"[^>]*title="([A-Za-z_]+)[ "]/g)].map((m) => m[1]);
    assert.deepEqual(heads, inventorySchema().defaultColumns);
    assert.match(html, /aria-sort="descending"[^>]*><button[^>]*data-sort="date"/, "Posting_Date sorts by the date sort");
    assert.match(html, /data-sort="entryNo"/, "Entry_No sorts by entryNo");
    assert.doesNotMatch(html, /data-action="fabric-x-sort"[^>]*data-sort="[^"]*"[^>]*data-focus-key="sort-Item_No"/, "a column without a sort isn't sortable");
    // Filters from schema.filters: company select with "~" = no company, bool as Any/Yes/No, the rest as text.
    assert.match(html, /<option value="">All companies<\/option><option value="CO_A" >CO_A<\/option><option value="~" >No company<\/option>/);
    assert.match(html, /data-filter="open"[^>]*><option value="">Any<\/option><option value="true" >Yes<\/option><option value="false" >No<\/option>/);
    assert.match(html, /<input [^>]*data-filter="entryType"[^>]*type="search"/);
    assert.match(html, /Showing [^<]*Feb[^<]*2026[^<]*Mar[^<]*2026 \(UTC\)/, "the window the server returned");
    assert.match(html, /value="2026-02-14"/); assert.match(html, /value="2026-03-15"/);
    assert.match(html, /Rows per page<select[^>]*><option value="50" >50<\/option><option value="100" selected>100<\/option><option value="200" >200<\/option>/);
    assert.match(html, /href="\/fabric\/inventory\/records\/a{24}"/, "the first cell links to the record");
    assert.doesNotMatch(html, /data-action="(create|edit|delete|import|archive)/);
  });

  test("filters, sort, page size and dates go to the server and the address; search is debounced", async () => {
    const env = load();
    const { panel, calls } = inventoryPanel(env);
    const x = panel.explorers.inventory;
    let synced = 0; panel.c.syncBoardUrl = () => { synced += 1; };
    panel.ensure(); await settle();
    x.onChange({ dataset: { action: "fabric-x-filter", filter: "company" }, value: "~" }); await settle();
    x.onChange({ dataset: { action: "fabric-x-filter", filter: "open" }, value: "true" }); await settle();
    x.onChange({ dataset: { action: "fabric-x-filter", filter: "notAFilter" }, value: "x" }); await settle();
    x.onChange({ dataset: { action: "fabric-x-limit" }, value: "200" }); await settle();
    x.onAction("fabric-x-sort", { dataset: { sort: "entryNo" } }); await settle();
    x.onChange({ dataset: { action: "fabric-x-date", edge: "from" }, value: "2026-03-01" }); await settle();
    let q = recordsCall(calls);
    assert.equal(q.get("company"), "~"); assert.equal(q.get("open"), "true"); assert.equal(q.get("notAFilter"), null);
    assert.equal(q.get("limit"), "200"); assert.equal(q.get("sort"), "entryNo"); assert.equal(q.get("dir"), "desc");
    assert.equal(q.get("dateFrom"), "2026-03-01"); assert.equal(q.get("dateTo"), "2026-03-15", "the other end is the window shown");
    assert.ok(synced >= 5);
    assert.equal(panel.urlFor().search, "?dateFrom=2026-03-01&dateTo=2026-03-15&company=~&open=true&sort=entryNo&dir=desc&limit=200");
    const before = calls.length;
    x.onInput({ dataset: { action: "fabric-x-search" }, value: "ITEM" }); x.onInput({ dataset: { action: "fabric-x-search" }, value: "ITEM-0" });
    await settle(50); assert.equal(calls.length, before, "nothing while typing");
    await settle(400); q = recordsCall(calls);
    assert.equal(q.get("q"), "ITEM-0"); assert.equal(calls.length, before + 1, "one request for the typed text");
    x.onChange({ dataset: { action: "fabric-x-date", edge: "to" }, value: "2026-02-01" }); await settle();
    assert.match(panel.body(), /start date must be on or before the end date/);
    x.onAction("fabric-x-clear", { dataset: {} }); await settle();
    assert.equal(panel.urlFor().search, "?limit=200", "Clear filters keeps the page size only");
  });

  test("cursor paging with Previous / Next", async () => {
    const env = load();
    const { panel, calls } = inventoryPanel(env, { records: (p) => page([row(ID1, { Entry_No: p.includes("cursor=") ? 2 : 1 })], { pagination: { limit: 100, hasMore: !p.includes("cursor="), nextCursor: p.includes("cursor=") ? null : "c1" } }) });
    const x = panel.explorers.inventory;
    panel.ensure(); await settle();
    assert.match(panel.body(), /data-dir="prev"[^>]*disabled/);
    x.onAction("fabric-x-page", { dataset: { dir: "next" } }); await settle();
    assert.equal(recordsCall(calls).get("cursor"), "c1");
    assert.match(panel.body(), /Rows 101–101/); assert.match(panel.body(), /data-dir="next"[^>]*disabled/);
    x.onAction("fabric-x-page", { dataset: { dir: "prev" } }); await settle();
    assert.equal(recordsCall(calls).get("cursor"), null);
  });

  test("column chooser: names only in localStorage (never values), restored next time, unknown names dropped", async () => {
    const env = load();
    const secretValue = "VALUE-NEVER-STORED-123";
    const { panel } = inventoryPanel(env, { records: page([row(ID1, { Item_Description: secretValue, Company: HOSTILE })]) });
    const x = panel.explorers.inventory;
    panel.ensure(); await settle();
    x.onAction("fabric-x-columns", { dataset: {} });
    let html = panel.body();
    assert.match(html, /aria-expanded="true"/); assert.match(html, /data-action="fabric-x-col"[^>]*data-name="Open"/);
    x.onChange({ dataset: { action: "fabric-x-col", name: "Open" }, checked: true }); await settle();
    x.onChange({ dataset: { action: "fabric-x-col", name: "Item_Description" }, checked: false }); await settle();
    x.onChange({ dataset: { action: "fabric-x-col", name: "NotAField" }, checked: true });
    const stored = env.localStorage.map;
    assert.deepEqual([...stored.keys()], ["jarc.fabric.columns.inventory"]);
    const names = JSON.parse(stored.get("jarc.fabric.columns.inventory"));
    assert.ok(names.includes("Open") && !names.includes("Item_Description") && !names.includes("NotAField"));
    const known = new Set(inventorySchema().fields.map((f) => f.name));
    assert.ok(names.every((n) => known.has(n)), "only field names from the schema");
    const everything = [...stored.values()].join("|");
    for (const v of [secretValue, "DOC-0001", "ITEM-0001", "CO_A", HOSTILE, "2026-03-01", "1001", ID1]) assert.ok(!everything.includes(v), `no data value in storage: ${v}`);
    // Next time (or another person's saved list with a name the schema no longer has): restored, unknown names dropped.
    env.localStorage.setItem("jarc.fabric.columns.inventory", JSON.stringify(["Open", "Gone_Field", "Entry_No"]));
    const again = inventoryPanel(env);
    again.panel.ensure(); await settle();
    assert.deepEqual(plain(again.panel.explorers.inventory.columns), ["Open", "Entry_No"]);
    assert.equal(recordsCall(again.calls).get("fields"), "Open,Entry_No");
    // The last column can't be removed; Default columns forgets the choice.
    const y = again.panel.explorers.inventory;
    y.onChange({ dataset: { action: "fabric-x-col", name: "Open" }, checked: false });
    const last = { dataset: { action: "fabric-x-col", name: "Entry_No" }, checked: false }; y.onChange(last);
    assert.deepEqual(plain(y.columns), ["Entry_No"]); assert.equal(last.checked, true);
    y.onAction("fabric-x-columns-reset", { dataset: {} });
    assert.equal(env.localStorage.getItem("jarc.fabric.columns.inventory"), null);
    assert.deepEqual(plain(y.columns), inventorySchema().defaultColumns);
  });

  test("sensitive fields: absent unless the schema returns them (then marked), never named by the client", async () => {
    const env = load();
    const a = inventoryPanel(env);
    a.panel.ensure(); await settle();
    a.panel.explorers.inventory.chooser = true;
    assert.doesNotMatch(a.panel.body(), new RegExp(SENSITIVE_FIELD));
    env.localStorage.setItem("jarc.fabric.columns.inventory", JSON.stringify(["Posting_Date", SENSITIVE_FIELD]));
    const b = inventoryPanel(env);
    b.panel.ensure(); await settle();
    assert.equal(recordsCall(b.calls).get("fields"), "Posting_Date", "a saved sensitive column isn't asked for without the permission");
    const c = inventoryPanel(env, { schema: inventorySchema({ sensitive: true }), records: page([row(ID1, { [SENSITIVE_FIELD]: "12.50" })]) });
    c.panel.ensure(); await settle();
    assert.equal(recordsCall(c.calls).get("fields"), `Posting_Date,${SENSITIVE_FIELD}`);
    assert.match(c.panel.body(), new RegExp(`<th scope="col"[^>]*title="${SENSITIVE_FIELD}[ "][^>]*>[^<]* <span class="account-badge is-warn fabric-sensitive"`), "the sensitive column's header is marked");
    // The UI never hard-codes sensitive field names. The one exception: FabricApiDocs.RESTRICTED, the documented list of the
    // restricted fields per dataset (the API docs must name them exactly); outside that list the docs don't name them either.
    const SENSITIVE_NAMES = [SENSITIVE_FIELD, "landed_cost", "trade_price", "distributors_price", "Cost_Amount"];
    const ui = ["FabricExplorer.js", "FabricDataPanel.js", "FabricApiPanel.js", "AppModules.js", "FabricRecordView.js"].filter((f) => fs.existsSync(path.join(ASSETS, f)));
    for (const f of ui) for (const name of SENSITIVE_NAMES) assert.ok(!read(f).includes(name), `${f} doesn't name ${name}`);
    // Second approved exception (2026-11-24): FabricFieldMeta.js holds presentation labels and groups for EVERY verified field,
    // sensitive ones included, so a sensitive reader sees friendly labels. It never decides visibility: it has no sensitive
    // list or flag, and arrange() places only the names the server actually returned.
    if (fs.existsSync(path.join(ASSETS, "FabricFieldMeta.js"))) {
      const code = read("FabricFieldMeta.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
      assert.doesNotMatch(code, /\b\w*(sensitive|restricted|visible|hidden|allowed)\w*\s*[(=:]/i, "FabricFieldMeta has no visibility logic (no such identifiers)");
      const FM = env.window.FabricFieldMeta || env.context?.FabricFieldMeta;
      if (FM?.arrange) {
        const placed = FM.arrange("inventory", ["Posting_Date"]).flatMap((g) => g.fields.map((f) => (typeof f === "string" ? f : f.name)));
        assert.equal(JSON.stringify(placed), JSON.stringify(["Posting_Date"]), "only fields present in the response are arranged");
      }
    }
    // RESTRICTED as `static RESTRICTED = …;` or as an object property `RESTRICTED: Object.freeze({ sales: […], inventory: […] })`.
    const docs = read("FabricApiDocs.js")
      .replace(/static\s+RESTRICTED\s*=\s*(?:Object\.freeze\()?\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*\)?\s*;/, "")
      .replace(/\bRESTRICTED\s*:\s*Object\.freeze\(\{[\s\S]*?\}\)/, "");
    for (const name of SENSITIVE_NAMES) assert.ok(!docs.includes(name), `FabricApiDocs.js names ${name} only in RESTRICTED`);
  });

  test("hostile values and field names are escaped in cells and in the record detail", async () => {
    const env = load();
    const schema = inventorySchema({ extra: [{ name: `<b onmouseover=x>`, type: "string" }] });
    const record = { record: { id: ID1, key: { Company: HOSTILE, Entry_No: 7 }, fields: [{ name: "Item_Description", value: HOSTILE, type: "string" }, { name: "Posting_Date", value: "2026-03-01T00:00:00.000Z", type: "date" }, { name: "Open", value: true, type: "bool" }, { name: "Quantity", value: null, type: "decimal" }] } };
    const { panel, calls } = inventoryPanel(env, { schema, records: page([row(ID1, { Item_Description: HOSTILE, Company: `"'><script>` })]), extra: { [`/fabric/inventory/records/${ID1}`]: record } });
    panel.ensure(); await settle();
    let html = panel.body();
    assert.doesNotMatch(html, /<img|<script|<b onmouseover/); assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /&lt;img src=x[^<]*<\/option>/, "a hostile company option is escaped too");
    panel.explorers.inventory.chooser = true; html = panel.body();
    assert.doesNotMatch(html, /onmouseover/, "a field name outside the safe pattern is dropped");
    panel.explorers.inventory.onAction("fabric-x-open", { dataset: { id: ID1 } }); panel.ensure(); await settle();
    assert.ok(calls.some(([, p]) => p === `/fabric/inventory/records/${ID1}`));
    assert.equal(panel.urlFor().path, `/fabric/inventory/records/${ID1}`);
    html = panel.body();
    assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/);
    // The record object page (FabricRecordView): the record key in the Keys tab's fx-fieldgroup dl, its values escaped.
    const keys = html.match(/<dl class="fx-fieldgroup__grid" data-keys="record">([\s\S]*?)<\/dl>/);
    assert.ok(keys, "the record key");
    assert.match(keys[1], /<dt class="fx-field__label" title="Company">[^<]*<\/dt><dd class="fx-field__value fx-field__value--key"[^>]*><span[^>]*>&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;<\/span><\/dd>/, "a hostile key value is escaped");
    assert.match(keys[1], /<dt class="fx-field__label" title="Entry_No">[^<]*<\/dt><dd class="fx-field__value fx-field__value--key"[^>]*><span[^>]*>7<\/span><\/dd>/);
    assert.match(html, /<code class="fx-allfields__name">Open<\/code><\/th><td[^>]*><span[^>]*>Yes<\/span><\/td><td class="fx-allfields__type">bool<\/td>/);
    assert.match(html, /<code class="fx-allfields__name">Item_Description<\/code><\/th><td[^>]*><span[^>]*>&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;<\/span><\/td>/, "a hostile field value is escaped");
    assert.match(html, /4 fields/);
  });

  test("states: skeleton, empty with Clear filters, error with retry and reference, record refreshed, index required, busy", async () => {
    const env = load();
    const loading = inventoryPanel(env, { records: () => new Promise(() => {}) });
    loading.panel.ensure(); await settle();
    assert.match(loading.panel.body(), /fabric-loading[^>]*aria-busy="true"/);
    const empty = inventoryPanel(env, { records: page([]) });
    empty.panel.ensure(); await settle();
    assert.match(empty.panel.body(), /No rows match[\s\S]*data-action="fabric-x-clear"/);
    const failing = inventoryPanel(env, { records: serverError(500, "INTERNAL_ERROR", "req-12345678") });
    failing.panel.ensure(); await settle();
    let html = failing.panel.body();
    assert.match(html, /data-action="fabric-x-retry" data-ds="inventory"/); assert.match(html, /Reference <code>req-12345678<\/code>/);
    for (const [code, re] of [["FABRIC_RANGE_TOO_LARGE", /Too much data/], ["FABRIC_BUSY", /busy\. Try again in a moment/], ["FABRIC_SOURCE_MISSING", /being refreshed upstream/]]) {
      const p = inventoryPanel(env, { records: serverError(code === "FABRIC_BUSY" ? 429 : 503, code) }); p.panel.ensure(); await settle();
      assert.match(p.panel.body(), re, code);
    }
    const gone = inventoryPanel(env, { extra: { [`/fabric/inventory/records/${ID1}`]: serverError(404, "FABRIC_RECORD_NOT_FOUND") } });
    gone.panel.applyRoute({ view: "inventory", recordId: ID1, query: env.FabricExplorer.emptyQuery() }); gone.panel.ensure(); await settle();
    html = gone.panel.body();
    assert.match(html, /may have been refreshed/); assert.match(html, /data-action="fabric-r-reload" data-ds="inventory"/);
    gone.panel.explorers.inventory.onAction("fabric-r-reload", { dataset: {} });
    assert.equal(gone.panel.explorers.inventory.recordId, "");
    // /status says the dataset waits for indexes: no records request at all.
    const blocked = inventoryPanel(env, { status: { available: true, datasets: { inventory: { mode: "index_required", missingIndexes: [{ name: "fabric_inventory_date" }] } } } });
    await blocked.panel.loadStatus(); blocked.panel.ensure(); await settle();
    assert.ok(!blocked.calls.some(([, p]) => p.startsWith("/fabric/inventory/")), "nothing asked while its index is missing");
    assert.match(blocked.panel.body(), /waiting for the data team to add indexes/);
    const small = inventoryPanel(env, { status: { available: true, datasets: { inventory: { mode: "small", missingIndexes: [{ name: "fabric_inventory_date" }] } } } });
    await small.panel.loadStatus(); small.panel.ensure(); await settle();
    // The index advice is shown once, compact, under the app bar (with the index name in its collapsed details), not again in the list.
    const smallPage = small.panel.html();
    assert.equal(smallPage.match(/small enough to browse without/g)?.length, 1, "the advice appears once");
    assert.match(smallPage, /<div class="fx-status fx-status--info" role="status">[\s\S]*Details[\s\S]*fabric_inventory_date/);
    assert.doesNotMatch(small.panel.body(), /small enough to browse without|fabric_inventory_date/, "no second banner in the list");
    assert.ok(small.calls.some(([, p]) => p.startsWith("/fabric/inventory/records?")), "a small dataset is still browsed");
  });

  test("403 drops everything in memory; the session ending forgets the explorers too", async () => {
    const env = load();
    const { panel } = inventoryPanel(env, { records: serverError(403, "FABRIC_DATA_FORBIDDEN") });
    panel.ensure(); await settle();
    assert.equal(panel.denied, true);
    assert.equal(panel.explorers.inventory.records.data, null); assert.equal(panel.explorers.inventory.info, null);
    assert.match(panel.body(), /No access to Fabric Data/);
    const other = inventoryPanel(env);
    other.panel.ensure(); await settle();
    assert.ok(other.panel.explorers.inventory.records.data);
    other.panel.api.secret = "jarc_secret_placeholder";
    for (const fn of env.listeners["jarc-session-expired"]) fn();
    assert.equal(other.panel.explorers.inventory.records.data, null); assert.equal(other.panel.explorers.inventory.schema.data, null); assert.equal(other.panel.api.secret, null);
  });

  test("Sales uses the same explorer with its own schema (object-shaped filters and sorts)", async () => {
    const env = load();
    const { panel, calls } = panelWith(env, { answers: { "/fabric/status": STATUS_OK, "/fabric/sales/schema": salesSchema(), "/fabric/sales/records": { items: [{ id: ID2, values: { invoice_date: "2026-03-02T00:00:00Z", Company: null, invoice_id: "INV-1", customer_name: "Example" } }], pagination: { hasMore: false }, window: null } } });
    panel.applyRoute({ view: "sales", query: env.FabricExplorer.parseQuery("?salesType=X&ignored=1") });
    panel.ensure(); await settle();
    const c = calls.find(([, p]) => p.startsWith("/fabric/sales/records?")), q = new URLSearchParams(c[1].split("?")[1]);
    assert.equal(q.get("fields"), "invoice_date,Company,invoice_id,customer_name"); assert.equal(q.get("salesType"), "X"); assert.equal(q.get("ignored"), null, "only schema filters are sent");
    const html = panel.body();
    assert.match(html, /Showing all dates/); assert.match(html, /data-filter="salesType"/); assert.match(html, /Company &lt;|placeholder="Exact name; ~ = no company"/);
    assert.match(panel.html(), /id="fabric-tab-sales"[^>]*aria-selected="true"[^>]*class="fx-appbar__tab is-active active">/);
  });
});

describe("Fabric Data: v1 invoice views (only with invoiceViews)", () => {
  const invoice = (over = {}) => ({ company: HOSTILE, invoiceNo: `${HOSTILE}"'`, invoiceDate: "2026-03-01T00:00:00.000Z", dueDate: null, customerId: HOSTILE, customerName: HOSTILE, rows: 3, lineDetailRows: 0, amount: 10.5, quantity: 2, headerTotal: null, sources: [HOSTILE], cancelled: false, closed: null, ...over });
  const listAnswer = (items) => ({ items, pagination: { limit: 50, hasMore: true, nextCursor: "c1" }, total: { invoices: 812, rows: 5231 }, window: { dateFrom: "2026-02-14", dateTo: "2026-03-15" }, companies: [{ company: HOSTILE, rows: 1 }, { company: null, rows: 2 }], access: { cost: false } });
  test("the list still renders (escaped) behind the flag, and never without it", async () => {
    const env = load();
    const { panel } = panelWith(env, { features: { read: true, invoiceViews: true }, answers: { "/fabric/status": { available: true }, "/fabric/invoices": listAnswer([invoice()]) } });
    panel.applyRoute(env.FabricDataPanel.parsePath("/fabric/invoices"));
    panel.ensure(); await settle();
    const html = panel.body();
    assert.doesNotMatch(html, /<img/); assert.match(html, /812 invoices · 5,231 rows/); assert.match(html, /<option value="~"[^>]*>No company<\/option>/);
    const off = panelWith(env, { features: { read: true }, answers: { "/fabric/invoices": listAnswer([invoice()]) } });
    off.panel.applyRoute(env.FabricDataPanel.parsePath("/fabric/invoices")); off.panel.ensure(); await settle();
    assert.ok(!off.calls.some(([, p]) => p.startsWith("/fabric/invoices")), "no invoice request without invoiceViews");
  });
});

describe("API Management", () => {
  const tokens = { tokens: [{ id: "t1", name: HOSTILE, description: HOSTILE, prefix: "jarc_ab", status: "active", scopes: ["fabric.sensitive.read", "fabric.sales.read", "fabric.inventory.read"], owner: { id: "u", name: HOSTILE }, createdAt: "2026-03-01T00:00:00Z", expiresAt: "2027-03-01T00:00:00Z", lastUsedAt: null, requestCount: 4 }] };
  const admin = { read: true, apiAdmin: true, apiTokens: true };
  test("token list: datasets and the sensitive badge, escaped; activity; docs for the v2 routes, naming no other collection", async () => {
    const env = load();
    const { panel } = panelWith(env, { features: admin, answers: { "/fabric/status": STATUS_OK, "/fabric/api-tokens": tokens, "/fabric/api-tokens/activity": { items: [{ action: "token.created", at: "2026-03-01T00:00:00Z", token: { id: "t1", name: HOSTILE, prefix: "jarc_ab" }, actor: { name: HOSTILE } }] } } });
    panel.applyRoute({ view: "api" }); assert.equal(panel.route.view, "api");
    panel.ensure(); await settle();
    let html = panel.body();
    assert.doesNotMatch(html, /<img/); assert.match(html, /<th>Datasets<\/th>/);
    assert.match(html, /<span class="account-badge ">Sales<\/span> <span class="account-badge ">Inventory<\/span> <span class="account-badge is-warn fabric-sensitive">Sensitive fields<\/span>/);
    assert.match(html, /data-action="fabric-api-revoke" data-id="t1"/);
    panel.api.tab = "activity"; html = panel.body(); assert.doesNotMatch(html, /<img/); assert.match(html, /Created/);
    panel.api.tab = "docs"; html = panel.body();
    for (const part of ["/api/v1/external/fabric/status", "GET /{dataset}/schema", "GET /{dataset}/records", "GET /{dataset}/records/{id}", "fabric.sales.read", "fabric.inventory.read", "fabric.sensitive.read", "cursor", "X-RateLimit-Limit", "Retry-After", "List.Generate", "Web.Contents", "Authorization", "HTTP Request", "Pagination", "\"type\": \"Http\"", "curl"]) assert.ok(html.includes(viewEscape(part)), part);
    // No other collection is named: no "…User"-style collection identifier anywhere in the docs or the Fabric UI code.
    const OTHER_COLLECTION = /\b[A-Z][a-z]+User\b/;
    assert.doesNotMatch(html, OTHER_COLLECTION); assert.doesNotMatch(read("FabricApiDocs.js") + read("FabricApiPanel.js") + read("FabricExplorer.js") + read("FabricDataPanel.js"), OTHER_COLLECTION);
    assert.doesNotMatch(html, /\/invoices|sales-lines/, "the docs use the dataset routes");
    assert.doesNotMatch(html, /jarc_[A-Za-z0-9]{20,}/, "no real-looking secret");
  });

  test("create: Sales / Inventory checkboxes (≥ 1 required), Sensitive fields only with features.sensitive", async () => {
    const env = load();
    let overlay = "";
    const plainAdmin = panelWith(env, { features: admin });
    plainAdmin.view.overlay = (h) => { overlay = h; };
    plainAdmin.panel.api.showCreate();
    assert.match(overlay, /name="ds-sales"[^>]*checked/); assert.match(overlay, /name="ds-inventory"[^>]*checked/); assert.doesNotMatch(overlay, /name="sensitive"/);
    assert.match(overlay, /API Management/);
    const sensitiveAdmin = panelWith(env, { features: { ...admin, sensitive: true }, answers: { "/fabric/api-tokens": { token: { name: "N", scopes: ["fabric.sales.read"] }, secret: "jarc_placeholder" } } });
    sensitiveAdmin.view.overlay = (h) => { overlay = h; };
    sensitiveAdmin.panel.api.showCreate(); assert.match(overlay, /name="sensitive"/);
    assert.match((() => { const p = panelWith(env, { features: { ...admin, cost: true } }); p.view.overlay = (h) => { overlay = h; }; p.panel.api.showCreate(); return overlay; })(), /name="sensitive"/, "cost is still read as the old name of sensitive");
    let revealed = null; sensitiveAdmin.panel.api.reveal = (r) => { revealed = r; };
    const expires = sensitiveAdmin.panel.api.dateInput(30);
    let said = "";
    const form = (sales, inventory, sensitive) => ({ elements: { name: { value: " Power BI " }, description: { value: "" }, expires: { value: expires }, "ds-sales": { checked: sales }, "ds-inventory": { checked: inventory }, sensitive: { checked: sensitive } }, querySelector: (s) => (s === ".apitok-error" ? { set textContent(t) { said = t; } } : null) });
    const calls = sensitiveAdmin.calls;
    await sensitiveAdmin.panel.api.submitCreate(form(false, false, true));
    assert.equal(calls.length, 0); assert.match(said, /at least one dataset/);
    await sensitiveAdmin.panel.api.submitCreate(form(true, false, false));
    let [method, p, body] = calls.at(-1);
    assert.equal(method, "POST"); assert.equal(p, "/fabric/api-tokens"); assert.deepEqual(plain(body.scopes), ["fabric.sales.read"]); assert.equal(body.name, "Power BI");
    await sensitiveAdmin.panel.api.submitCreate(form(true, true, true));
    assert.deepEqual(plain(calls.at(-1)[2].scopes), ["fabric.sales.read", "fabric.inventory.read", "fabric.sensitive.read"]);
    const noSensitive = panelWith(env, { features: admin, answers: { "/fabric/api-tokens": { token: {}, secret: "jarc_placeholder" } } });
    noSensitive.panel.api.reveal = () => {};
    await noSensitive.panel.api.submitCreate(form(false, true, true));
    assert.deepEqual(plain(noSensitive.calls.at(-1)[2].scopes), ["fabric.inventory.read"], "sensitive is never sent without the right");
    assert.equal(revealed.secret, "jarc_placeholder");
  });
});

// The docs escape their text: compare against the escaped form.
function viewEscape(s) { return String(s).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }

describe("Fabric Data: browser storage", () => {
  test("only FabricExplorer touches localStorage, under jarc.fabric.columns.*; nothing uses sessionStorage, IndexedDB or BoardCache", () => {
    for (const f of ["FabricDataPanel.js", "FabricApiPanel.js", "FabricApiDocs.js", "FabricExplorer.js"]) {
      const src = read(f).replace(/^\s*\/\/.*$/gm, "");
      assert.doesNotMatch(src, /sessionStorage|indexedDB|BoardCache|jarcStorage|setPreference/, f);
      if (f !== "FabricExplorer.js") assert.doesNotMatch(src, /localStorage/, f);
    }
    const src = read("FabricExplorer.js");
    assert.equal((src.match(/localStorage\?\.(setItem|getItem|removeItem)\(this\.storageKey/g) || []).length, 3, "every access uses the column-names key");
    assert.match(src, /static STORAGE_PREFIX = "jarc\.fabric\.columns\.";/);
  });
  test("index.html loads the Fabric files before AppController.js, the explorer before the panel", () => {
    const html = fs.readFileSync(path.resolve(ASSETS, "..", "index.html"), "utf8");
    const at = (s) => html.indexOf(s);
    for (const s of ["assets/FabricApiDocs.js", "assets/FabricApiPanel.js", "assets/FabricExplorer.js", "assets/FabricDataPanel.js", "assets/fabric-data.css"]) assert.ok(at(s) > 0, s);
    assert.ok(at("assets/FabricExplorer.js") < at("assets/FabricDataPanel.js"));
    assert.ok(at("assets/FabricDataPanel.js") < at("assets/AppController.js"));
  });
});
