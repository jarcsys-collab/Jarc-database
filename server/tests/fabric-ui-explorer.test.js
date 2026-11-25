// Fabric Data explorer list view (site/assets/FabricExplorer.js, Phase 4 redesign): compact toolbar, collapsible filter bar
// with removable chips, object navigation from known values only, enterprise grid with primary/secondary sort marks, footer
// without totals, and the record-view delegation hook. Drives the unchanged browser files in a vm with a stubbed adapter:
// no server, no network. Synthetic data only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
const ID1 = "a".repeat(24), ID2 = "b".repeat(24);
const HOSTILE = `<img src=x onerror="alert(1)">`;
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function load({ extra = "" } = {}) {
  const m = new Map();
  const localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
  const window = { location: { pathname: "/fabric/inventory", search: "", origin: "https://jarc.example.test" }, history: { replaceState() {}, pushState() {} }, localStorage, addEventListener() {}, dispatchEvent() {} };
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } } };
  const context = vm.createContext({ window, document, console, Intl, Date, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, CSS: { escape: (v) => v } });
  for (const f of ["AppView.js", "EntraAuth.js", "FabricApiDocs.js", "FabricApiPanel.js", "FabricFilterModel.js", "FabricFilterBuilder.js", "FabricExplorer.js", "FabricDataPanel.js"]) vm.runInContext(read(f), context, { filename: f });
  if (extra) vm.runInContext(extra, context, { filename: "stub.js" });
  const get = (name) => vm.runInContext(name, context);
  return { context, get, FabricDataPanel: get("FabricDataPanel"), FabricExplorer: get("FabricExplorer"), AppView: get("AppView") };
}
function panelWith(env, answers) {
  const calls = [];
  const adapter = { mode: "resource", async request(method, p) { calls.push([method, p]); const hit = Object.entries(answers).find(([k]) => p === k || p.startsWith(`${k}?`)); if (!hit) throw Object.assign(new Error("no answer"), { code: "NOT_FOUND", cause: { status: 404 } }); return typeof hit[1] === "function" ? hit[1](p) : hit[1]; } };
  const view = new env.AppView({ innerHTML: "" });
  const controller = { model: { features: { fabricData: { read: true } }, storage: { adapter }, screen: "fabric", me: "user:u1" }, view, update() {}, syncBoardUrl() {} };
  const panel = new env.FabricDataPanel(controller);
  view.fabricPanel = panel; controller.fabric = panel;
  return { panel, calls, x: panel.explorers.inventory };
}
// The schema as the server sends it (sorts with field + keys), synthetic.
const FIELDS = [["_id", "objectId"], ["Posting_Date", "date"], ["Company", "string"], ["Entry_No", "int"], ["Entry_Type", "string"], ["Item_No", "string"], ["Item_Description", "string"], ["Quantity", "decimal"], ["Open", "bool"]];
const schema = () => ({ dataset: "inventory", label: "Inventory", fields: FIELDS.map(([name, type]) => ({ name, type, searchable: ["Item_No", "Item_Description"].includes(name) })),
  filters: [{ name: "company", field: "Company", type: "company" }, { name: "entryType", field: "Entry_Type", type: "string" }, { name: "open", field: "Open", type: "bool" }],
  sorts: [{ name: "date", field: "Posting_Date", keys: ["Posting_Date", "Company", "Entry_No", "_id"], default: true, requiresCompany: false, dateRange: true }, { name: "entryNo", field: "Entry_No", keys: ["Company", "Entry_No", "_id"], default: false, requiresCompany: true, dateRange: false }],
  defaultColumns: ["Posting_Date", "Company", "Entry_No", "Entry_Type", "Item_No", "Item_Description", "Quantity"], dateField: "Posting_Date", companyField: "Company", recordKey: ["Company", "Entry_No"] });
const row = (id, over = {}) => ({ id, values: { Posting_Date: "2026-03-01T00:00:00.000Z", Company: "CO_A", Entry_No: 1001, Entry_Type: "Sale", Item_No: "ITEM-0001", Item_Description: "Example item", Quantity: -2, ...over } });
const page = (items, over = {}) => ({ items, pagination: { limit: 100, hasMore: false, nextCursor: null }, window: { dateFrom: "2026-02-14", dateTo: "2026-03-15", defaulted: true, all: false }, ...over });
const STATUS = { available: true, datasets: { inventory: { mode: "indexed", missingIndexes: [] } }, access: { datasets: ["inventory", "sales"] } };
const answers = (records = page([row(ID1), row(ID2, { Company: "CO_B", Entry_No: 1002 })])) => ({ "/fabric/status": STATUS, "/fabric/inventory/schema": schema(), "/fabric/inventory/records": records });
const recordCalls = (calls) => calls.filter(([, p]) => p.startsWith("/fabric/inventory/records?"));
const lastQuery = (calls) => new URLSearchParams(recordCalls(calls).at(-1)[1].split("?")[1]);
async function ready(env, a = answers()) { const t = panelWith(env, a); t.panel.ensure(); await settle(); return t; }
const T = (dataset) => ({ dataset });

describe("Fabric explorer list view", () => {
  test("toolbar: Refresh, search, Filters, Save filter, Columns, Sort + order, Rows per page; Clear filters not in it; read-only", async () => {
    const env = load(); const { x } = await ready(env);
    const html = x.html();
    assert.match(html, /class="fx-toolbar fx-explorer__toolbar"/);
    assert.match(html, /data-action="fabric-refresh"[^>]*>[\s\S]*?Refresh/);
    assert.match(html, /<form class="fx-search" role="search"[^>]*data-action="fabric-x-form"/);
    assert.match(html, /<input id="fabric-inventory-q" class="fx-search__input" type="search" data-action="fabric-x-search"/);
    // A short placeholder; the searchable fields are named in the tooltip and the input's description.
    const search = html.match(/<input id="fabric-inventory-q"[^>]*>/)[0];
    assert.match(search, /placeholder="Search…"/);
    const help = (search.match(/aria-describedby="([^"]+)"/) || [])[1];
    if (help) { assert.match(search, /title="Searches [^"]+"/); assert.match(html, new RegExp(`<span class="sr-only" id="${help}">Searches [^<]+</span>`)); }
    assert.match(html, /data-action="fabric-x-filters"[^>]*aria-expanded="false"/);
    assert.match(html, /data-action="fabric-x-columns"[^>]*data-focus-key="cols"/);
    assert.match(html, /<select id="fabric-inventory-sort" data-action="fabric-x-sort-select"[^>]*><option value="date" selected>Posting_Date<\/option><option value="entryNo" >Entry_No<\/option>/);
    assert.match(html, /data-action="fabric-x-dir-toggle"[^>]*aria-label="Descending\. Switch to ascending"/);
    // Nothing to clear yet: no Clear filters at all (not a disabled one), and none in the toolbar ever.
    assert.doesNotMatch(html, /data-action="fabric-x-clear"/, "no Clear filters while nothing is applied");
    const toolbar = html.match(/<div class="fx-toolbar fx-explorer__toolbar"[\s\S]*?Rows per page<select[\s\S]*?<\/select><\/label><\/div>/)[0];
    assert.doesNotMatch(toolbar, /fabric-x-clear/);
    // The order, also the Tab order (DOM order, no tabindex): Refresh, Search, Filters, [Save filter…], Columns, Sort, order, Rows per page.
    const at = (re) => { const i = toolbar.search(re); assert.ok(i >= 0, `${re} in the toolbar`); return i; };
    const order = [/data-action="fabric-refresh"/, /id="fabric-inventory-q"/, /data-action="fabric-x-filters"/, /data-action="fabric-x-columns"/, /id="fabric-inventory-sort"/, /data-action="fabric-x-dir-toggle"/, /id="fabric-inventory-limit"/].map(at);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "toolbar order");
    assert.doesNotMatch(toolbar, /tabindex="[1-9]/, "no positive tabindex: the Tab order is the visual order");
    assert.match(html, /Rows per page<select id="fabric-inventory-limit"[^>]*><option value="50" >50<\/option><option value="100" selected>100<\/option>/);
    assert.doesNotMatch(html, /data-action="[^"]*(create|edit|delete|import|export|archive)/);
  });

  test("Filters opens the builder popover (no static form); toggles make no request; chips bar hidden while empty", async () => {
    const env = load(); const { x, calls } = await ready(env);
    let html = x.html();
    assert.match(html, /<div class="fx-filterbar is-empty" id="fabric-inventory-filters"><\/div>/);
    assert.doesNotMatch(html, /class="fx-fb"|data-action="fabric-x-filter"/, "no builder and no old filter form until Filters is pressed");
    assert.match(html, /data-action="fabric-x-filters"[^>]*aria-haspopup="dialog" aria-expanded="false" aria-controls="fabric-inventory-fb"/);
    const before = calls.length;
    x.onAction("fabric-x-filters", T({ ds: "inventory" })); await settle();
    html = x.html();
    assert.match(html, /<form class="fx-fb" id="fabric-inventory-fb" role="dialog"[^>]*data-action="fabric-f-form"/);
    assert.match(html, /data-action="fabric-x-filters"[^>]*aria-expanded="true"/);
    assert.match(html, /The default window is 2026-02-14 – 2026-03-15\./, "the builder names the server's window");
    x.onAction("fabric-x-filters", T({})); assert.equal(x.fb.open, false, "pressed again: closed, draft discarded");
    x.onAction("fabric-x-columns", T({})); x.onAction("fabric-x-columns", T({}));
    x.onAction("fabric-x-select", T({ id: ID2 })); await settle();
    assert.equal(calls.length, before, "the builder, the chooser and row selection never fetch");
    assert.match(x.html(), new RegExp(`<tr data-action="fabric-x-select" data-ds="inventory" data-id="${ID2}" class="is-selected" aria-selected="true">`));
    assert.equal((x.html().match(/aria-selected="true"/g) || []).length, 1);
    // A date problem (from the address or the legacy date action) is shown in place of the rows, with Edit filters.
    x.onChange({ dataset: { action: "fabric-x-date", edge: "from" }, value: "2026-03-10" }); await settle();
    x.onChange({ dataset: { action: "fabric-x-date", edge: "to" }, value: "2026-03-01" }); await settle();
    assert.match(x.html(), /id="fabric-inventory-problem"><strong>Fix the dates to see rows\.<\/strong> The start date must be on or before the end date\.[\s\S]*data-focus-key="edit-filters"/);
  });

  test("column chooser: a batch of ticks is one request (after a short pause, or at once on Done); names still saved per tick", async () => {
    const env = load(); const { x, calls } = await ready(env);
    const before = recordCalls(calls).length;
    x.onAction("fabric-x-columns", T({}));
    for (const name of ["Open", "Item_Description", "Entry_No"]) x.onChange({ dataset: { action: "fabric-x-col", name }, checked: name === "Open" });
    assert.equal(recordCalls(calls).length, before, "nothing asked while ticking");
    assert.deepEqual(JSON.parse(env.get("window").localStorage.getItem("jarc.fabric.columns.u1.inventory")), ["Posting_Date", "Company", "Entry_Type", "Item_No", "Quantity", "Open"], "remembered at once");
    await settle(400);
    assert.equal(recordCalls(calls).length, before + 1, "one request for the batch");
    assert.equal(lastQuery(calls).get("fields"), "Posting_Date,Company,Entry_Type,Item_No,Quantity,Open");
    // Ticks, then Done straight away: applied on close, and the pending timer adds nothing.
    x.onChange({ dataset: { action: "fabric-x-col", name: "Entry_No" }, checked: true }); x.onChange({ dataset: { action: "fabric-x-col", name: "Open" }, checked: false });
    x.onAction("fabric-x-columns", T({ focusKey: "cols-done" }));
    assert.equal(recordCalls(calls).length, before + 2); assert.equal(x.chooser, false);
    await settle(400);
    assert.equal(recordCalls(calls).length, before + 2, "exactly one request per batch");
    assert.equal(lastQuery(calls).get("fields"), "Posting_Date,Company,Entry_Type,Item_No,Quantity,Entry_No");
    // Open and close without a change: no request.
    x.onAction("fabric-x-columns", T({})); x.onAction("fabric-x-columns", T({})); await settle(400);
    assert.equal(recordCalls(calls).length, before + 2);
  });

  test("chips: one per active filter (friendly text), badge count, removing a chip clears it with one request", async () => {
    const env = load(); const { x, calls } = await ready(env);
    x.onChange({ dataset: { action: "fabric-x-filter", filter: "company" }, value: "~" }); await settle();
    x.onChange({ dataset: { action: "fabric-x-filter", filter: "open" }, value: "true" }); await settle();
    x.onInput({ dataset: { action: "fabric-x-search" }, value: "ITEM" }); await settle(400);
    let html = x.html();
    assert.match(html, /<span class="fx-chip__label">Search:<\/span> ITEM<\/span><button type="button" class="fx-chip__remove" data-action="fabric-x-chip" data-ds="inventory" data-key="q" aria-label="Remove filter Search">/);
    assert.match(html, /<span class="fx-chip__label">Company:<\/span> No company/);
    assert.match(html, /<span class="fx-chip__label">Open:<\/span> Yes/);
    // The badge counts conditions (Company, Open); the search is a chip but not a condition.
    assert.match(html, /<span class="fx-badge"><span class="sr-only">, <\/span>2<span class="sr-only"> active<\/span><\/span>/);
    // Clear filters: in the chips row, after the chips (far right), enabled; never in the toolbar.
    assert.match(html, /<div class="fx-filterbar" id="fabric-inventory-filters"><div class="fx-filterbar__info"[\s\S]*?<\/div><button type="button" class="fx-btn fx-filterbar__clear" data-action="fabric-x-clear" data-ds="inventory" data-focus-key="clear-top">[\s\S]*?<span>Clear filters<\/span><\/button><\/div>/);
    assert.doesNotMatch(html, /data-focus-key="clear-top"[^>]*disabled/);
    assert.equal((html.match(/data-focus-key="clear-top"/g) || []).length, 1, "one Clear filters");
    const before = recordCalls(calls).length;
    x.onAction("fabric-x-chip", T({ key: "f:company" })); await settle();
    assert.equal(recordCalls(calls).length, before + 1, "one request");
    let q = lastQuery(calls);
    assert.equal(q.get("company"), null); assert.equal(q.get("open"), "true"); assert.equal(q.get("q"), "ITEM");
    x.onAction("fabric-x-chip", T({ key: "q" })); await settle();
    assert.equal(lastQuery(calls).get("q"), null);
    x.onAction("fabric-x-chip", T({ key: "f:notAFilter" })); x.onAction("fabric-x-chip", T({ key: "__proto__" })); await settle();
    assert.equal(recordCalls(calls).length, before + 2, "unknown chips do nothing");
    html = x.html();
    assert.doesNotMatch(html, /Company:<\/span>/); assert.match(html, /Open:<\/span> Yes/);
    assert.match(html, /data-focus-key="clear-top"/, "still one filter: Clear filters stays");
    // The last clearable chip removed: Clear filters goes at once, and the empty row keeps no space.
    x.onAction("fabric-x-chip", T({ key: "f:open" })); await settle();
    html = x.html();
    assert.doesNotMatch(html, /data-action="fabric-x-clear"/);
    assert.match(html, /<div class="fx-filterbar is-empty" id="fabric-inventory-filters"><\/div>/);
    // An unapplied draft in the builder doesn't bring it back.
    x.onAction("fabric-x-filters", T({ ds: "inventory" })); await settle();
    assert.equal(x.fb.open, true);
    assert.doesNotMatch(x.html(), /data-action="fabric-x-clear"/, "opening the builder isn't applying a filter");
    x.onAction("fabric-x-filters", T({}));
    // A sort alone isn't a filter.
    x.onAction("fabric-x-dir-toggle", T({})); await settle();
    assert.doesNotMatch(x.html(), /data-action="fabric-x-clear"/, "a sort alone shows no Clear filters");
  });

  test("sort marks: the primary key has the arrow and aria-sort; later keys of the compound sort get a 'then' mark", async () => {
    const env = load(); const { x, calls } = await ready(env);
    let html = x.html();
    assert.match(html, /<th scope="col" class="fx-grid__frozen" title="Posting_Date · date" aria-sort="descending"><button[^>]*data-sort="date"[^>]*>Posting_Date<span class="fx-sort-mark fabric-sort-mark" aria-hidden="true">▼<\/span><\/button>/);
    // Later keys: a "2nd"/"3rd" badge attached to the label, "sorted second" for screen readers, explained in the Sort tooltip.
    assert.match(html, /<th scope="col" class="" title="Company · string · sorted second, after Posting_Date">Company<span class="fx-sort-then" aria-hidden="true">2nd<\/span><span class="sr-only">, sorted second<\/span><\/th>/);
    assert.match(html, /data-sort="entryNo"[^>]*>Entry_No<span class="fx-sort-then" aria-hidden="true">3rd<\/span><span class="sr-only">, sorted third<\/span><\/button>/);
    assert.equal((html.match(/aria-sort=/g) || []).length, 1, "aria-sort only on the primary");
    assert.equal((html.match(/class="fx-sort-mark/g) || []).length, 1, "the arrow only on the primary");
    assert.match(html, /<label class="fx-toolbar__field" title="Sorted by Posting_Date \(descending, ▲\/▼ in its header\), then Company \(2nd\), then Entry_No \(3rd\)\. A &quot;2nd&quot;\/&quot;3rd&quot; badge in a column header marks a later sort key\. Click a column header to sort by it\.">Sort<select/);
    // entryNo: one company at a time; without a company the existing message, and no request.
    const before = recordCalls(calls).length;
    x.onAction("fabric-x-sort", T({ sort: "entryNo" })); await settle();
    assert.equal(recordCalls(calls).length, before, "no request without a company");
    assert.match(x.html(), /Sorting by entry no lists one company at a time\. Choose a company \(~ for rows without one\), or sort by another column\./);
    x.onChange({ dataset: { action: "fabric-x-filter", filter: "company" }, value: "CO_A" }); await settle();
    const q = lastQuery(calls);
    assert.equal(q.get("sort"), "entryNo"); assert.equal(q.get("company"), "CO_A"); assert.equal(q.get("dateFrom"), null, "no dates with entryNo");
    html = x.html();
    assert.match(html, /aria-sort="descending"><button[^>]*data-sort="entryNo"[^>]*>Entry_No<span class="fx-sort-mark fabric-sort-mark" aria-hidden="true">▼/);
    // Company is filtered now (company=CO_A): its header also carries the filter mark.
    assert.match(html, /class="is-filtered" title="Company · string · sorted second, after Entry_No · filtered">Company<span class="fx-sort-then" aria-hidden="true">2nd[\s\S]*?<span class="fx-col-filtered"/);
    assert.doesNotMatch(html, /data-sort="date"[^>]*>Posting_Date<span class="fx-sort-mark fabric-sort-mark" aria-hidden="true">▼/);
    assert.equal((html.match(/aria-sort=/g) || []).length, 1);
    x.onAction("fabric-x-dir-toggle", T({})); await settle();
    assert.equal(lastQuery(calls).get("dir"), "asc");
    assert.match(x.html(), /aria-sort="ascending"><button[^>]*data-sort="entryNo"/);
  });

  test("footer: page and rows, window, filter summary, Previous/Next; never a total", async () => {
    const env = load();
    const { x, calls } = await ready(env, answers((p) => page([row(ID1)], { pagination: { limit: 100, hasMore: !p.includes("cursor="), nextCursor: p.includes("cursor=") ? null : "c1" } })));
    let html = x.html();
    assert.match(html, /<span class="fx-gridfoot__range" role="status">Page 1 · Rows 1–1 · more available<\/span>/);
    assert.match(html, /<span class="fabric-window">Showing [^<]*2026[^<]*\(UTC\)<\/span><span class="fx-gridfoot__filters">No filters<\/span>/);
    assert.match(html, /data-dir="prev" data-focus-key="prev" disabled/);
    assert.doesNotMatch(html, / of \d|[Tt]otal/);
    x.onAction("fabric-x-page", T({ dir: "next" })); await settle();
    assert.equal(lastQuery(calls).get("cursor"), "c1");
    html = x.html();
    assert.match(html, /Page 2 · Rows 101–101</); assert.match(html, /data-dir="next" data-focus-key="next" disabled/);
    x.onChange({ dataset: { action: "fabric-x-filter", filter: "entryType" }, value: "Sale" }); await settle();
    assert.match(x.html(), /fx-gridfoot__filters">Entry type: Sale</);
    assert.match(x.html(), /Page 1 · Rows 1–1/, "a filter change starts again at page 1");
    const sales = await ready(load(), { ...answers(page([row(ID1)], { window: { dateFrom: null, dateTo: null, all: true } })) });
    assert.match(sales.x.html(), /Showing all dates/);
  });

  test("no company shortcuts: Company is an ordinary filter field (the builder offers it), one request on Apply", async () => {
    const env = load(); const { x, calls } = await ready(env);
    const fetched = calls.length;
    const html = x.html();
    assert.doesNotMatch(html, /fx-explorer__nav|fabric-x-nav|Seen on loaded pages/, "the Phase 4 company navigation is gone (FabricObjects is the navigation)");
    assert.ok(x.filterFields().some((f) => f.name === "Company"), "Company is a filter field");
    assert.equal(x.openFilterFor("Company", { op: "eq", value: "CO_B" }), true);
    assert.equal(calls.length, fetched, "opening the builder asks nothing");
    x.onAction("fabric-f-apply", T({ ds: "inventory" })); await settle();
    assert.equal(lastQuery(calls).get("company"), "CO_B", "legacy schema: sent as the equality parameter"); assert.equal(calls.length, fetched + 1);
    x.onAction("fabric-x-chip", T({ key: "f:company" })); await settle();
    assert.equal(lastQuery(calls).get("company"), null); assert.equal(calls.length, fetched + 2);
  });

  test("hostile values are escaped in cells, chips, navigation and the footer; empty values get an accessible marker", async () => {
    const env = load();
    const { x } = await ready(env, answers(page([row(ID1, { Company: HOSTILE, Item_Description: `"'><script>x</script>`, Quantity: null, Entry_Type: "" })])));
    x.onChange({ dataset: { action: "fabric-x-filter", filter: "entryType" }, value: HOSTILE }); await settle();
    const html = x.html();
    assert.doesNotMatch(html, /<img|<script/);
    assert.match(html, /Entry type:<\/span> &lt;img/);
    x.openFilterFor("Entry_Type");
    assert.doesNotMatch(x.html(), /<img|<script/, "the builder escapes the draft's values");
    assert.match(x.html(), /value="&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;"/);
    assert.match(html, /<span class="fx-null" title="No value"><span aria-hidden="true">—<\/span><span class="sr-only">No value<\/span><\/span>/);
    assert.match(html, /<td data-label="Quantity" class="fx-grid__num fabric-num"><span class="fx-null"/);
  });

  test("grid: frozen first column links to the record; labels and formatting from FabricFieldMeta, requests keep field names", async () => {
    const meta = `var FabricFieldMeta = { label: (ds, f) => ({ Posting_Date: "Posting date", Entry_No: "Entry no.", Entry_Type: "Entry type <b>" })[f] || f.replace(/_/g, " "), format: (v, type) => ({ text: type === "date" ? String(v).slice(0, 10) : String(v), cls: type === "int" ? "fx-num" : "", title: "" }) };`;
    const env = load({ extra: meta }); const { x, calls } = await ready(env);
    const html = x.html();
    // One data attribute per cell (the friendly label, for the phone card), the formatter's class on the cell itself.
    assert.match(html, new RegExp(`<th scope="row" class="fx-grid__frozen" data-label="Posting date"><a class="fx-link fabric-link" href="/fabric/inventory/records/${ID1}" data-action="fabric-x-open"[^>]*>2026-03-01</a></th>`));
    assert.match(html, /data-sort="date"[^>]*>Posting date<span/); assert.match(html, /Entry type &lt;b&gt;/);
    assert.match(html, /<td data-label="Entry type &lt;b&gt;">Sale<\/td>/, "the label is escaped");
    assert.match(html, /<td data-label="Entry no\." class="fx-grid__num fabric-num fx-num">1001<\/td>/);
    assert.doesNotMatch(html, /data-title=/);
    assert.equal((html.match(/<td[ >]/g) || []).length, 12, "6 cells × 2 rows"); assert.doesNotMatch(html, /<td[^>]* title=/, "short values: no tooltip");
    assert.equal(lastQuery(calls).get("fields"), schema().defaultColumns.join(","), "original names in the request");
    assert.match(html, /<div class="fx-grid fabric-explorer-scroll" tabindex="0" data-focus-key="results" data-grid="inventory" role="region" aria-label="Inventory rows"><table class="fx-grid__table fabric-explorer-table"><thead>/);
    // A value long enough to be cut off gets its whole text as a tooltip (escaped); a short one doesn't.
    const long = `${"Long synthetic description ".repeat(3)}"<x>`;
    const wide = await ready(load({ extra: meta }), answers(page([row(ID1, { Item_Description: long })])));
    assert.match(wide.x.html(), /<td data-label="Item Description" title="(Long synthetic description ){3}&quot;&lt;x&gt;">/);
    const plain = await ready(load(), answers(page([row(ID1, { Item_Description: long })])));
    assert.match(plain.x.html(), /<td data-label="Item_Description" title="(Long synthetic description ){3}&quot;&lt;x&gt;">/, "also without FabricFieldMeta");
  });

  test("200 rows × many columns: slim cells (one data attribute, no wrapper span, tooltips only for long values)", async () => {
    const meta = read("FabricFieldMeta.js");
    const types = ["string", "date", "decimal", "int", "string", "bool", "string"];
    const fields = [{ name: "_id", type: "objectId" }, ...Array.from({ length: 85 }, (_, i) => ({ name: `Field_${i}`, type: types[i % types.length] }))];
    const big = { dataset: "inventory", label: "Inventory", fields, filters: [], sorts: [{ name: "date", field: "Field_1", keys: ["Field_1", "_id"], default: true }], defaultColumns: fields.slice(1).map((f) => f.name) };
    const v = (t, r, i) => (t === "date" ? "2026-03-01T00:00:00.000Z" : t === "decimal" ? r + i / 4 : t === "int" ? r * 100 + i : t === "bool" ? r % 2 === 0 : i % 10 === 0 ? `A longer synthetic description value ${r}-${i} for the grid` : `VAL-${r}-${i}`);
    const items = Array.from({ length: 200 }, (_, r) => ({ id: r.toString(16).padStart(24, "0"), values: Object.fromEntries(fields.slice(1).map((f, i) => [f.name, v(f.type, r, i)])) }));
    const { x } = await ready(load({ extra: meta }), { "/fabric/status": STATUS, "/fabric/inventory/schema": big, "/fabric/inventory/records": page(items) });
    const html = x.tableHtml(x.records.data);
    assert.equal((html.match(/<td[ >]|<th scope="row"/g) || []).length, 200 * 85);
    assert.doesNotMatch(html, /data-title=/);
    assert.equal((html.match(/<span/g) || []).length, 1, "no wrapper span per cell (one in the headers)");
    assert.ok((html.match(/<td[^>]* title="/g) || []).length <= 200 * 9, "tooltips only on the long values");
    assert.ok(html.length < 1.5e6, `about half the old ~2.4 MB: ${html.length}`);
  });

  test("loading: the last page stays on screen (busy, paging off) while the next one loads; first load is a skeleton", async () => {
    const env = load();
    let hold = false;
    const { x } = await ready(env, answers((p) => (hold ? new Promise(() => {}) : page([row(ID1)]))));
    hold = true;
    x.onChange({ dataset: { action: "fabric-x-filter", filter: "entryType" }, value: "Sale" }); await settle();
    const html = x.html();
    assert.match(html, /class="fx-grid fabric-explorer-scroll is-busy"[^>]*aria-busy="true"/);
    assert.match(html, /fx-gridfoot__range" role="status">Loading…</); assert.match(html, /data-dir="next" data-focus-key="next" disabled/);
    assert.equal(x.items.length, 0, "items are the current page only");
    const first = await ready(load(), answers(() => new Promise(() => {})));
    assert.match(first.x.html(), /fabric-loading[^>]*aria-busy="true"/);
  });

  test("record detail: delegates to FabricRecordView (html, fabric-r-* actions) and keeps the old detail without it", async () => {
    const stub = `var seen = []; var FabricRecordView = { html: (x) => '<section class="fx-object" data-id="' + x.attr(x.recordId) + '">' + x.esc(x.info.label) + ' ' + x.items.length + ' ' + x.listHref() + ' ' + x.recordHref(x.recordId) + '</section>', onAction: (x, action, target, event) => { seen.push([x.ds, action, target.dataset.tab, Boolean(event)]); }, onInput: (x, t) => { seen.push([x.ds, "input", t.value]); } };`;
    const env = load({ extra: stub });
    const record = { record: { id: ID1, key: { Company: "CO_A", Entry_No: 1001 }, fields: [{ name: "Entry_No", value: 1001, type: "int" }] } };
    const { x, calls } = await ready(env, { ...answers(), [`/fabric/inventory/records/${ID1}`]: record });
    assert.equal(x.items.length, 2);
    x.onAction("fabric-x-open", T({ id: ID1 })); x.ensure(); await settle();
    assert.ok(calls.some(([, p]) => p === `/fabric/inventory/records/${ID1}`), "one /records/:id request");
    assert.equal(x.record.data.record.id, ID1); assert.equal(x.info.label, "Inventory");
    assert.match(x.html(), new RegExp(`<section class="fx-object" data-id="${ID1}">Inventory 2 /fabric/inventory /fabric/inventory/records/${ID1}</section>`));
    x.onAction("fabric-r-tab", T({ tab: "keys" }), {}); x.onInput({ dataset: { action: "fabric-r-filter" }, value: "abc" });
    assert.deepEqual(JSON.parse(JSON.stringify(env.get("seen"))), [["inventory", "fabric-r-tab", "keys", true], ["inventory", "input", "abc"]]);
    assert.equal(typeof x.refresh, "function");
    x.onAction("fabric-x-back", T({})); assert.equal(x.recordId, "");
    assert.match(x.html(), new RegExp(`data-id="${ID1}" class="is-selected"`), "the opened row stays selected on return");
    // Without FabricRecordView: the minimal fallback detail.
    const plain = await ready(load(), { ...answers(), [`/fabric/inventory/records/${ID1}`]: record });
    plain.x.onAction("fabric-x-open", T({ id: ID1 })); plain.x.ensure(); await settle();
    assert.match(plain.x.html(), /fabric-breadcrumb[\s\S]*<dt><code>Company<\/code><\/dt>/);
    plain.x.onAction("fabric-r-tab", T({}));
  });

  test("index.html links fabric-explorer.css after jarc-theme.css; the stylesheet stays scoped to .fx-app", () => {
    const html = fs.readFileSync(path.resolve(ASSETS, "..", "index.html"), "utf8");
    assert.ok(html.indexOf("assets/fabric-explorer.css") > html.indexOf("assets/jarc-theme.css"));
    const css = read("fabric-explorer.css").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const block of css.split("}")) { const sel = block.split("{").at(-2)?.replace(/\([^)]*\)/g, "()").trim() ?? ""; if (!sel || sel.startsWith("@")) continue; for (const s of sel.split(",")) { const t = s.trim().replace(/^@media[^{]*/, ""); if (t) assert.ok(t.startsWith(".fx-app"), `scoped: ${t}`); } }
  });

  test("responsive stabilization: the footer stays a row (the legacy .fabric-pager phone rule can't make it a column); the chooser is clamped on tablets", () => {
    const css = read("fabric-explorer.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (sel, scope = css) => { const i = scope.indexOf(`${sel} {`); assert.ok(i >= 0, sel); return scope.slice(i, scope.indexOf("}", i)); };
    const block = (q) => { const i = css.indexOf(`@media ${q} {`); assert.ok(i >= 0, q); return css.slice(i, css.indexOf("\n}", i)); };
    // fabric-data.css (loaded later) turns .fabric-pager into a column on phones; the footer's own rule says row and outranks it.
    assert.match(read("fabric-data.css"), /\.fabric-pager \{ flex-direction: column;/);
    assert.match(rule(".fx-app .fx-explorer .fx-gridfoot"), /flex-direction: row;/);
    const phone = block("(max-width: 620px)");
    assert.match(rule(".fx-app .fx-explorer .fx-gridfoot__page", phone), /flex: 1 1 100%/);
    assert.match(rule(".fx-app .fx-explorer .fx-gridfoot__page .fx-btn", phone), /flex: 1 1 0;.*min-height: 36px/);
    const tablet = block("(max-width: 1024px)");
    assert.match(rule(".fx-app .fx-explorer .fx-colpop", tablet), /position: static/);
    assert.match(rule(".fx-app .fx-explorer__chooser", tablet), /right: 8px; width: min\(440px, calc\(100% - 16px\)\)/);
    // Desktop (the first, unconditional rules): the chooser still opens under the Columns button, 440px wide.
    assert.match(rule(".fx-app .fx-explorer .fx-colpop"), /position: relative/);
    assert.match(rule(".fx-app .fx-explorer__chooser"), /top: calc\(100% \+ 4px\); left: 0;.*width: 440px/);
  });
});
