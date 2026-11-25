// Fabric Data Phase 7: the advanced filter builder (FabricFilterBuilder.js), the filter model mirror (FabricFilterModel.js) and
// the explorer's filter state (FabricExplorer.js): operator catalog parity with the server, builder add/remove/nest/duplicate,
// Apply/Cancel (draft vs applied), validation, chips and badge, request encoding (filter=, orderBy=), the stale-response guard,
// the required Sales window, legacy parameters, filter-specific errors, keyboard (Escape, Enter, focus restore) and the hooks
// for the column menu / value picker / saved filters. Browser files in a vm with a stubbed adapter: no server, no network.
// Synthetic data only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const server = require("../src/fabric/filter-model");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
const ID1 = "a".repeat(24), ID2 = "b".repeat(24);
const HOSTILE = `<img src=x onerror="alert(1)">`;
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const plain = (v) => JSON.parse(JSON.stringify(v));

// focused: the selectors the explorer focused (document.querySelector returns a focusable stub only for focus targets).
function load({ extra = "" } = {}) {
  const focused = [];
  const m = new Map();
  const localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
  const window = { location: { pathname: "/fabric/sales", search: "", origin: "https://jarc.example.test" }, history: { replaceState() {}, pushState() {} }, localStorage, addEventListener() {}, dispatchEvent() {} };
  const document = {
    documentElement: { dataset: {}, style: { setProperty() {} } }, activeElement: null,
    querySelector: (sel) => (/^#fabric-root \[(data-action|data-focus-key)/.test(sel) ? { focus() { focused.push(sel.replace(/^#fabric-root /, "")); } } : null),
    querySelectorAll: () => [], addEventListener() {}, body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }
  };
  const context = vm.createContext({ window, document, console, Intl, Date, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, AbortController, CSS: { escape: (v) => v } });
  for (const f of ["AppView.js", "EntraAuth.js", "FabricApiDocs.js", "FabricApiPanel.js", "FabricFilterModel.js", "FabricFilterBuilder.js", "FabricExplorer.js", "FabricDataPanel.js"]) vm.runInContext(read(f), context, { filename: f });
  if (extra) vm.runInContext(extra, context, { filename: "stub.js" });
  const get = (name) => vm.runInContext(name, context);
  return { context, get, focused, M: get("FabricFilterModel"), FabricExplorer: get("FabricExplorer"), FabricDataPanel: get("FabricDataPanel"), AppView: get("AppView") };
}
function panelWith(env, answers) {
  const calls = [];
  const adapter = { mode: "resource", async request(method, p) { calls.push([method, p]); const hit = Object.entries(answers).find(([k]) => p === k || p.startsWith(`${k}?`)); if (!hit) throw Object.assign(new Error("no answer"), { code: "NOT_FOUND", cause: { status: 404 } }); return typeof hit[1] === "function" ? hit[1](p) : hit[1]; } };
  const view = new env.AppView({ innerHTML: "" });
  let synced = 0;
  const controller = { model: { features: { fabricData: { read: true } }, storage: { adapter }, screen: "fabric" }, view, update() {}, syncBoardUrl() { synced += 1; } };
  const panel = new env.FabricDataPanel(controller);
  view.fabricPanel = panel; controller.fabric = panel;
  return { panel, calls, synced: () => synced };
}
// An advanced (session) Sales schema as B1 publishes it: per-field kind, operators with class, valueSource, orderable.
const ops = (kind, fast = []) => server.BY_KIND[kind].map((op) => ({ op, class: fast.includes(op) ? "fast" : "bounded" }));
const FIELDS = [
  { name: "_id", type: "objectId", kind: "", operators: [] },
  { name: "invoice_date", type: "date", kind: "date", operators: ops("date", server.BY_KIND.date), orderable: true, requiresDateWindow: true },
  { name: "Company", type: "string", kind: "category", operators: ops("category", ["eq", "in"]), valueSource: "distinct", orderable: true },
  { name: "invoice_id", type: "string", kind: "text", operators: ops("text", ["eq", "in", "startsWith"]), orderable: true },
  { name: "customer_name", type: "string", kind: "text", operators: ops("text"), valueSource: "search", searchable: true },
  { name: "invoice_item_quantity", type: "decimal", kind: "number", operators: ops("number") },
  { name: "is_return", type: "bool", kind: "bool", operators: ops("bool") },
  { name: "invoice_status", type: "string", kind: "text", operators: [] },
  { name: "landed_cost", type: "string", kind: "text", operators: [], sensitive: true }
];
const schema = (over = {}) => ({ dataset: "sales", label: "Sales", fields: FIELDS,
  filters: [{ name: "company", field: "Company", type: "string" }], sorts: [{ name: "date", field: "invoice_date", keys: ["invoice_date", "Company", "invoice_id", "_id"], default: true }, { name: "entryNo", field: "invoice_id", keys: ["Company", "invoice_id", "_id"], requiresCompany: true, dateRange: false }],
  defaultColumns: ["invoice_date", "Company", "invoice_id", "customer_name", "invoice_item_quantity"], dateField: "invoice_date", companyField: "Company", recordKey: ["Company", "invoice_id"],
  filterModel: { version: 1, limits: { ...server.LIMITS } }, orderBy: { maxKeys: 3 }, dateWindow: { field: "invoice_date", required: true, defaultDays: 30, maxDays: 92 }, searchFields: [{ field: "customer_name", match: "contains" }], ...over });
const row = (id, over = {}) => ({ id, values: { invoice_date: "2026-03-01T00:00:00.000Z", Company: "CO_A", invoice_id: "INV-1", customer_name: "Example", invoice_item_quantity: "2", ...over } });
const page = (items, over = {}) => ({ items, pagination: { limit: 100, hasMore: true, nextCursor: "c1" }, window: { dateFrom: "2026-03-02", dateTo: "2026-03-31", defaulted: true }, ...over });
const STATUS = { available: true, datasets: { sales: { mode: "indexed", missingIndexes: [], window: { maxDays: 92, defaultDays: 30 } } }, access: { datasets: ["inventory", "sales"] } };
const answers = (records = page([row(ID1), row(ID2, { Company: "CO_B" })]), sch = schema()) => ({ "/fabric/status": STATUS, "/fabric/sales/schema": sch, "/fabric/sales/records": records });
const recordCalls = (calls) => calls.filter(([, p]) => p.startsWith("/fabric/sales/records?"));
const lastQuery = (calls) => new URLSearchParams(recordCalls(calls).at(-1)[1].split("?")[1]);
const decoded = (q) => JSON.parse(Buffer.from(q.get("filter"), "base64url").toString("utf8"));
async function ready(env, a = answers(), search = "") {
  const t = panelWith(env, a);
  t.panel.applyRoute({ view: "sales", query: env.FabricExplorer.parseQuery(search) });
  t.panel.ensure(); await settle();
  return { ...t, x: t.panel.explorers.sales };
}
const T = (dataset) => ({ dataset: { ds: "sales", ...dataset } });
const input = (action, path, value, edge = "value") => ({ dataset: { action, ds: "sales", path, edge }, value });
// Adds a condition through the UI: Add → choose the field (and operator) → type the value(s).
function addCondition(x, groupPath, field, op, value) {
  const B = x.builder(), M = x.constructor.model();
  const group = M.at(x.fb.draft, groupPath), path = groupPath === "" ? String(group.items.length) : `${groupPath}.${group.items.length}`;
  B.onAction(x, "fabric-f-add", T({ path: groupPath }));
  B.onAction(x, "fabric-f-field", T({ path, field }));
  if (op) B.onChange(x, { dataset: { action: "fabric-f-op", ds: "sales", path }, value: op });
  if (value !== undefined) {
    if (Array.isArray(value)) { const c = M.at(x.fb.draft, path); c.values = value; }
    else if (value && typeof value === "object") for (const [edge, v] of Object.entries(value)) B.onInput(x, input("fabric-f-value", path, v, edge));
    else B.onInput(x, input("fabric-f-value", path, value));
  }
  return path;
}

describe("Filter model mirror (FabricFilterModel ↔ server filter-model.js)", () => {
  test("operators per kind, labels, limits and units are exactly the server's catalog", () => {
    const { M } = load();
    assert.deepEqual(plain(M.OPERATORS), plain(server.BY_KIND));
    for (const [op, def] of Object.entries(server.OPERATORS)) {
      assert.equal(M.LABELS[op], def.label, `label of ${op}`);
      assert.equal(M.arity(op), { none: "none", one: "value", two: "range", list: "list", n: "relative" }[def.shape], `shape of ${op}`);
      assert.equal(M.NULLABLE.has(op), def.nullable, `nullable ${op}`);
    }
    assert.equal(Object.keys(M.ARITY).length, Object.keys(server.OPERATORS).length);
    for (const k of Object.keys(server.LIMITS)) assert.equal(M.LIMITS[k], server.LIMITS[k], k);
    assert.deepEqual(plain(M.UNITS), plain(server.UNITS));
  });
  test("encode/decode: the same base64url text as the server's encoder; the server parses and validates what the client sends", () => {
    const { M } = load();
    const model = { v: 1, op: "and", items: [{ field: "Company", op: "in", values: ["Cö A", null] }, { op: "or", items: [{ field: "customer_name", op: "contains", value: "välve 😀" }, { field: "invoice_item_quantity", op: "between", value: "10", to: "100.50" }] }, { field: "invoice_date", op: "lastN", n: 7, unit: "days" }] };
    const enc = M.encode(model);
    assert.equal(enc, server.encodeFilterParam(model));
    assert.deepEqual(plain(M.decode(enc)), plain(server.canonical(model)));
    assert.deepEqual(plain(server.parseFilterParam(enc)), plain(M.canonical(model)));
    assert.equal(M.encode(M.empty()), "", "no conditions: no filter parameter");
    for (const bad of ["", "!!", "eyJ2IjoyfQ", Buffer.from('{"v":1,"op":"and","items":[{"field":"$where","op":"eq","value":"1"}]}').toString("base64url"), Buffer.from('{"v":1,"op":"xor","items":[]}').toString("base64url")]) assert.equal(M.decode(bad), null, bad);
    // Three levels deep, or an unknown key: not well formed (the server refuses them too).
    assert.equal(M.decode(Buffer.from(JSON.stringify({ v: 1, op: "and", items: [{ op: "or", items: [{ op: "and", items: [{ field: "a", op: "blank" }] }] }] })).toString("base64url")), null);
    assert.equal(M.decode(Buffer.from(JSON.stringify({ v: 1, op: "and", items: [{ field: "a", op: "eq", value: "x", $gt: 1 }] })).toString("base64url")), null);
  });
  test("validate: values by kind (decimal text kept exactly), ranges, lists, N, limits; messages never echo a value", () => {
    const { M } = load();
    const fields = new Map(FIELDS.filter((f) => f.operators.length).map((f) => [f.name, { kind: f.kind, operators: f.operators.map((o) => o.op) }]));
    const v = (items) => M.validate({ v: 1, op: "and", items }, fields);
    assert.equal(v([{ field: "invoice_item_quantity", op: "gte", value: "12345678901234567890.123456" }]).ok, true, "34-digit decimal text accepted, kept as text");
    for (const bad of ["1e5", "12,5", "abc", "1.2.3"]) assert.equal(v([{ field: "invoice_item_quantity", op: "eq", value: bad }]).ok, false, bad);
    assert.match(v([{ field: "invoice_item_quantity", op: "between", value: "9", to: "2" }]).errors[0].message, /start must be less than or equal/);
    assert.match(v([{ field: "invoice_date", op: "on", value: "2026-02-30" }]).errors[0].message, /real date/);
    assert.match(v([{ field: "Company", op: "in", values: [] }]).errors[0].message, /at least one value/);
    assert.equal(v([{ field: "Company", op: "in", values: ["A", null] }]).ok, true, "null (blank) allowed in a list");
    assert.match(v([{ field: "invoice_date", op: "lastN", n: 0, unit: "days" }]).errors[0].message, /whole number from 1 to 366/);
    assert.match(v([{ field: "invoice_status", op: "eq", value: "x" }]).errors[0].message, /can't be used in filters/, "a disabled field");
    assert.match(v([{ field: "landed_cost", op: "eq", value: "x" }]).errors[0].message, /can't be used in filters/, "a sensitive field");
    assert.match(v([{ field: "Company", op: "contains", value: "x" }]).errors[0].message, /operator this field supports/);
    assert.match(v([{ field: "customer_name", op: "eq", value: "" }]).errors[0].message, /Enter a value, or choose “is blank”/);
    assert.match(v(Array.from({ length: 21 }, () => ({ field: "Company", op: "blank" }))).errors[0].message, /at most 20 conditions/);
    assert.match(v(Array.from({ length: 10 }, () => ({ op: "or", items: [{ field: "Company", op: "blank" }] }))).errors[0].message, /at most 10 groups/, "the root counts as a group");
    const secret = v([{ field: "invoice_item_quantity", op: "eq", value: "SECRET-VALUE" }]);
    assert.ok(secret.errors.every((e) => !e.message.includes("SECRET")), "no value echoed");
  });
});

describe("Advanced filter builder", () => {
  test("field selector: only filterable, authorized fields (label, exact id, type badge); operators per kind from the schema", async () => {
    const env = load(); const { x } = await ready(env);
    assert.equal(x.isAdvanced(), true);
    assert.deepEqual(plain(x.filterFields().map((f) => [f.name, f.kind])), [["invoice_date", "date"], ["Company", "category"], ["invoice_id", "text"], ["customer_name", "text"], ["invoice_item_quantity", "number"], ["is_return", "bool"]], "no _id, disabled or sensitive fields");
    x.onAction("fabric-x-filters", T({}));
    x.builder().onAction(x, "fabric-f-add", T({ path: "" }));
    const html = x.html();
    assert.match(html, /<div class="fx-fb__picker" id="fabric-sales-fb-picker" role="group" aria-label="Choose a field">/);
    assert.match(html, /data-field="customer_name"[^>]*><span class="fx-fb__optlabel">customer_name<\/span><code>customer_name<\/code><span class="fx-fb__kind">Abc<\/span>/);
    assert.match(html, /data-field="invoice_item_quantity"[\s\S]*?<span class="fx-fb__kind">123<\/span>/);
    assert.doesNotMatch(html, /data-field="(invoice_status|landed_cost|_id)"/);
    for (const [field, kind] of [["Company", "category"], ["customer_name", "text"], ["invoice_item_quantity", "number"], ["invoice_date", "date"], ["is_return", "bool"]]) {
      x.builder().onAction(x, "fabric-f-field", T({ path: "0", field }));
      const sel = x.html().match(/<select class="fx-fb__op"[^>]*>([\s\S]*?)<\/select>/)[1];
      assert.deepEqual([...sel.matchAll(/<option value="([A-Za-z]+)"/g)].map((m) => m[1]), [...server.BY_KIND[kind]], `operators for ${kind}`);
    }
    // Type-specific inputs: number as text (decimal kept), date input, relative N + unit, bool without a value, tag input for lists.
    const B = x.builder();
    B.onAction(x, "fabric-f-field", T({ path: "0", field: "invoice_item_quantity" }));
    assert.match(x.html(), /id="fabric-sales-fb-value-0" type="text" inputmode="decimal"/);
    B.onChange(x, { dataset: { action: "fabric-f-op", ds: "sales", path: "0" }, value: "between" });
    assert.match(x.html(), /fabric-sales-fb-value-0"[\s\S]*fx-fb__and">and<[\s\S]*fabric-sales-fb-to-0"/);
    B.onAction(x, "fabric-f-field", T({ path: "0", field: "invoice_date" }));
    assert.match(x.html(), /id="fabric-sales-fb-value-0" type="date"[\s\S]*id="fabric-sales-fb-to-0" type="date"/, "date between: two date inputs");
    B.onChange(x, { dataset: { action: "fabric-f-op", ds: "sales", path: "0" }, value: "lastN" });
    assert.match(x.html(), /id="fabric-sales-fb-n-0" type="number"[^>]*value="7"[\s\S]*data-action="fabric-f-unit"[^>]*><option value="days" selected>days/);
    B.onAction(x, "fabric-f-field", T({ path: "0", field: "is_return" }));
    assert.doesNotMatch(x.html().match(/<li class="fx-fb__item fx-fb__cond[\s\S]*?<\/li>/)[0], /fx-fb__val/, "bool: no value input");
    B.onAction(x, "fabric-f-field", T({ path: "0", field: "Company" }));
    assert.match(x.html(), /data-action="fabric-f-tag"[^>]*placeholder="Type a value, press Enter"/, "no value picker loaded: a tag input");
  });

  test("add, nest (depth ≤ 2), duplicate, remove, AND/OR per group, clear all; Apply sends one request with filter=", async () => {
    const env = load(); const { x, calls } = await ready(env);
    const M = env.M, B = x.builder();
    x.onAction("fabric-x-filters", T({}));
    addCondition(x, "", "Company", "in", ["CO_A", "CO_B"]);
    B.onAction(x, "fabric-f-add-group", T({}));
    B.onAction(x, "fabric-f-field", T({ path: "1.0", field: "customer_name" }));
    B.onInput(x, input("fabric-f-value", "1.0", "valve"));
    addCondition(x, "1", "invoice_item_quantity", "between", { value: " 10 ", to: "100.50" });
    assert.match(x.html(), /fx-fb__group--d2[\s\S]*data-action="fabric-f-join" data-ds="sales" data-path="1"[^>]*>[\s\S]*value="or" selected/, "a new nested group starts as OR inside the AND root");
    assert.doesNotMatch(x.html().match(/fx-fb__group--d2[\s\S]*?fx-fb__groupfoot[\s\S]*?<\/div>/)[0], /fabric-f-add-group/, "no group inside a nested group (depth 2)");
    B.onAction(x, "fabric-f-dup", T({ path: "1.1" }));
    assert.equal(M.count(x.fb.draft), 4);
    B.onAction(x, "fabric-f-remove", T({ path: "1.2" }));
    assert.equal(M.count(x.fb.draft), 3);
    const before = recordCalls(calls).length;
    assert.equal(before, 1, "nothing asked while editing");
    B.onAction(x, "fabric-f-apply", T({})); await settle();
    assert.equal(recordCalls(calls).length, 2, "one request on Apply");
    const q = lastQuery(calls);
    assert.deepEqual(decoded(q), { v: 1, op: "and", items: [{ field: "Company", op: "in", values: ["CO_A", "CO_B"] }, { op: "or", items: [{ field: "customer_name", op: "contains", value: "valve" }, { field: "invoice_item_quantity", op: "between", value: "10", to: "100.50" }] }] });
    assert.equal(q.get("cursor"), null); assert.equal(q.get("company"), null, "the condition isn't also sent as company=");
    assert.equal(x.fb.open, false); assert.match(x.panelUrl?.() || env.FabricExplorer.formatQuery(x.query), /filter=/);
    // Clear all empties the draft (kept until Apply); removing the nested group's last condition removes the group.
    x.onAction("fabric-x-filters", T({}));
    B.onAction(x, "fabric-f-remove", T({ path: "1.0" })); B.onAction(x, "fabric-f-remove", T({ path: "1.0" }));
    assert.equal(x.fb.draft.items.length, 1, "the empty nested group went with its last condition");
    B.onAction(x, "fabric-f-clear", T({}));
    assert.equal(M.count(x.fb.draft), 0); assert.equal(recordCalls(calls).length, 2);
    B.onAction(x, "fabric-f-apply", T({})); await settle();
    assert.equal(lastQuery(calls).get("filter"), null);
  });

  test("Cancel / Escape discard the draft (no request, focus back to Filters); draft vs applied is shown", async () => {
    const env = load(); const { x, calls } = await ready(env, answers(), `?filter=${server.encodeFilterParam({ v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "CO_A" }] })}`);
    const B = x.builder(), before = recordCalls(calls).length;
    assert.deepEqual(decoded(lastQuery(calls)), { v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "CO_A" }] }, "filter= from the address is applied");
    x.onAction("fabric-x-filters", T({}));
    assert.match(x.html(), /<span class="fx-fb__state">Matches what is applied<\/span>/);
    B.onInput(x, input("fabric-f-value", "0", "CO_B"));
    x.redrawInPlace();
    assert.match(x.html(), /fx-fb__state is-draft">Not applied yet</);
    env.focused.length = 0;
    B.onAction(x, "fabric-f-cancel", T({}));
    assert.equal(x.fb.open, false); assert.equal(x.query.filter.items[0].value, "CO_A", "applied filter unchanged");
    assert.deepEqual(env.focused.at(-1), '[data-action="fabric-x-filters"][data-ds="sales"]', "focus back to Filters");
    // Escape: first closes the field list (focus to the field button), then the builder.
    x.onAction("fabric-x-filters", T({}));
    B.onAction(x, "fabric-f-pick", T({ path: "0" }));
    const esc = () => ({ key: "Escape", target: { closest: (s) => (s === "#fabric-sales-fb" ? {} : null), dataset: {} }, preventDefault() {}, stopPropagation() {} });
    x.onKeydown(esc());
    assert.equal(x.fb.open, true); assert.equal(x.fb.picking, ""); assert.equal(env.focused.at(-1), '[data-focus-key="fb-field-0"]');
    x.onKeydown(esc());
    assert.equal(x.fb.open, false); assert.equal(env.focused.at(-1), '[data-action="fabric-x-filters"][data-ds="sales"]');
    assert.equal(recordCalls(calls).length, before, "Cancel and Escape never ask the server");
  });

  // 13-browser-responsive-review.md D4: on phones (≤620 px) the builder covers the screen: a modal dialog with a Tab trap.
  test("D4: on phones the builder is aria-modal and Tab / Shift+Tab wrap inside it; on wider screens it is not modal and Tab is left alone", async () => {
    const env = load(); const { x } = await ready(env);
    const win = env.get("window"), doc = env.get("document");
    let phone = false;
    win.matchMedia = (q) => ({ matches: phone && q === "(max-width: 620px)" });
    x.onAction("fabric-x-filters", T({}));
    assert.match(x.html(), /id="fabric-sales-fb" role="dialog" aria-modal="false"/);
    phone = true;
    assert.match(x.html(), /id="fabric-sales-fb" role="dialog" aria-modal="true"/);
    const focusedEls = [];
    const el = (name, extra = {}) => ({ name, hidden: false, closest: () => null, getClientRects: () => [1], focus() { focusedEls.push(name); }, ...extra });
    const list = [el("close"), el("hidden-one", { getClientRects: () => [] }), el("add"), el("apply")];
    const form = { querySelectorAll: () => list };
    const key = (shiftKey, on) => { const e = { key: "Tab", shiftKey, prevented: false, target: { closest: (s) => (s === "#fabric-sales-fb" ? form : null), dataset: {} }, preventDefault() { this.prevented = true; }, stopPropagation() {} }; doc.activeElement = on; return e; };
    let e = key(false, list[3]); x.onKeydown(e);
    assert.ok(e.prevented); assert.equal(focusedEls.at(-1), "close", "Tab on the last control wraps to the first");
    e = key(true, list[0]); x.onKeydown(e);
    assert.ok(e.prevented); assert.equal(focusedEls.at(-1), "apply", "Shift+Tab on the first wraps to the last");
    e = key(false, list[0]); x.onKeydown(e);
    assert.equal(e.prevented, false, "Tab in the middle is the browser's own");
    assert.equal(focusedEls.includes("hidden-one"), false, "controls that aren't drawn are skipped");
    phone = false;
    e = key(false, list[3]); x.onKeydown(e);
    assert.equal(e.prevented, false, "no trap on tablets and desktops");
    phone = true; // Escape still cancels and gives focus back to Filters.
    x.onKeydown({ key: "Escape", target: { closest: (s) => (s === "#fabric-sales-fb" ? form : null), dataset: {} }, preventDefault() {}, stopPropagation() {} });
    assert.equal(x.fb.open, false); assert.equal(env.focused.at(-1), '[data-action="fabric-x-filters"][data-ds="sales"]');
  });

  test("validation: problems block Apply (no request), are shown per condition with role=alert, and focus the first", async () => {
    const env = load(); const { x, calls } = await ready(env);
    const B = x.builder();
    x.onAction("fabric-x-filters", T({}));
    addCondition(x, "", "customer_name", "eq", "");
    addCondition(x, "", "invoice_item_quantity", "between", { value: "9", to: "1" });
    B.onAction(x, "fabric-f-add", T({ path: "" })); // a condition without a field
    env.focused.length = 0;
    const before = recordCalls(calls).length;
    B.onAction(x, "fabric-f-apply", T({})); await settle();
    assert.equal(recordCalls(calls).length, before, "nothing sent");
    const html = x.html();
    assert.match(html, /<p class="fx-fb__summary" id="fabric-sales-fb-summary" role="alert">3 problems to fix before applying\./);
    assert.match(html, /id="fabric-sales-fb-err-0" role="alert">Enter a value, or choose “is blank”\./);
    assert.match(html, /id="fabric-sales-fb-value-1"[^>]*aria-invalid="true" aria-describedby="fabric-sales-fb-err-1"/);
    assert.match(html, /fabric-sales-fb-err-1" role="alert">The start must be less than or equal to the end\./);
    assert.match(html, /fabric-sales-fb-err-2" role="alert">Choose a field\./);
    assert.equal(env.focused.at(-1), '[data-focus-key="fb-val-0"]');
    // The window: at most 92 days, both dates or none.
    B.onAction(x, "fabric-f-remove", T({ path: "2" })); B.onAction(x, "fabric-f-remove", T({ path: "1" })); B.onAction(x, "fabric-f-remove", T({ path: "0" }));
    B.onInput(x, { dataset: { action: "fabric-f-date", ds: "sales", edge: "from" }, value: "2026-01-01" });
    B.onInput(x, { dataset: { action: "fabric-f-date", ds: "sales", edge: "to" }, value: "2026-06-30" });
    B.onAction(x, "fabric-f-apply", T({})); await settle();
    assert.match(x.html(), /The date window can be at most 92 days \(this one is 181\)\./); assert.equal(env.focused.at(-1), '[data-focus-key="fb-from"]');
    B.onInput(x, { dataset: { action: "fabric-f-date", ds: "sales", edge: "to" }, value: "2026-01-31" });
    B.onAction(x, "fabric-f-apply", T({})); await settle();
    const q = lastQuery(calls);
    assert.equal(q.get("dateFrom"), "2026-01-01"); assert.equal(q.get("dateTo"), "2026-01-31"); assert.equal(q.get("filter"), null);
  });

  test("Sales date window: its own required control; its chip has no ×; Clear all keeps it; removing it is refused", async () => {
    const env = load(); const { x, calls } = await ready(env);
    let html = x.html();
    assert.match(html, /<span class="fx-chip fx-chip--filter is-locked"><span class="fx-chip__text" title="Dates: 2026-03-02 – 2026-03-31 \(default\) \(required: change it in Filters\)"><span class="fx-chip__label">Dates:<\/span> 2026-03-02 – 2026-03-31 \(default\)<\/span><span class="sr-only">, required<\/span><\/span>/);
    assert.doesNotMatch(html, /data-key="dates"/, "no remove button for the required window");
    assert.equal(x.removeFilter("dates"), false);
    x.onAction("fabric-x-filters", T({}));
    html = x.html();
    assert.match(html, /<fieldset class="fx-fb__window is-required"><legend>Date window <span class="fx-fb__req">required<\/span><\/legend>/);
    assert.match(html, /Up to 92 days\. Leave both empty for the default window \(the latest 30 days\)\./);
    assert.match(html, /id="fabric-sales-from" type="date" data-action="fabric-f-date"/);
    const B = x.builder();
    B.onInput(x, { dataset: { action: "fabric-f-date", ds: "sales", edge: "from" }, value: "2026-03-10" });
    B.onInput(x, { dataset: { action: "fabric-f-date", ds: "sales", edge: "to" }, value: "2026-03-20" });
    addCondition(x, "", "Company", "eq", "CO_A");
    B.onAction(x, "fabric-f-clear", T({}));
    assert.deepEqual(plain(x.fb.dates), { dateFrom: "2026-03-10", dateTo: "2026-03-20" }, "Clear all keeps the window");
    B.onAction(x, "fabric-f-apply", T({})); await settle();
    assert.equal(lastQuery(calls).get("dateFrom"), "2026-03-10");
    assert.match(x.html(), /is-locked"><span class="fx-chip__text" title="Dates: 2026-03-10 – 2026-03-20/);
    assert.doesNotMatch(x.html(), /data-key="dates"/);
  });

  test("chips: one per condition with ×, nested group bracketed with its AND/OR; badge counts conditions; × is one request", async () => {
    const env = load();
    const model = { v: 1, op: "and", items: [{ field: "Company", op: "in", values: ["CO_A", "CO_B", "CO_C", "CO_D"] }, { op: "or", items: [{ field: "customer_name", op: "contains", value: HOSTILE }, { field: "is_return", op: "isTrue" }] }, { field: "invoice_date", op: "lastN", n: 7, unit: "days" }] };
    const { x, calls } = await ready(env, answers(), `?q=abc&filter=${server.encodeFilterParam(model)}`);
    let html = x.html();
    assert.match(html, /<span class="fx-badge"><span class="sr-only">, <\/span>4<span class="sr-only"> active<\/span><\/span>/, "4 conditions (search not counted)");
    assert.match(html, /Company:<\/span> is one of CO_A, CO_B, CO_C \+1<\/span><button type="button" class="fx-chip__remove" data-action="fabric-x-chip" data-ds="sales" data-key="c:0" aria-label="Remove filter Company: is one of CO_A, CO_B, CO_C \+1">/);
    assert.match(html, /<span class="fx-chipgroup" role="group" aria-label="Any of"><span class="fx-chipgroup__join" aria-hidden="true">any of<\/span>[\s\S]*data-key="c:1\.0"[\s\S]*<span class="fx-chipgroup__op">or<\/span>[\s\S]*is_return:<\/span> is true[\s\S]*data-key="c:1\.1"/);
    assert.match(html, /invoice_date:<\/span> in the last 7 days/);
    assert.doesNotMatch(html, /<img/); assert.match(html, /contains &lt;img src=x/);
    assert.match(html, /<th scope="col" class="is-filtered" title="Company · string[^"]*· filtered">/, "a filtered column is marked in its header");
    const before = recordCalls(calls).length;
    x.onAction("fabric-x-chip", T({ key: "c:1.0" })); await settle();
    assert.equal(recordCalls(calls).length, before + 1);
    assert.deepEqual(decoded(lastQuery(calls)).items[1], { op: "or", items: [{ field: "is_return", op: "isTrue" }] });
    assert.equal(lastQuery(calls).get("cursor"), null, "page 1 again");
    x.onAction("fabric-x-chip", T({ key: "c:1.0" })); await settle();
    assert.equal(decoded(lastQuery(calls)).items.length, 2, "the group went with its last condition");
    x.onAction("fabric-x-chip", T({ key: "c:9" })); x.onAction("fabric-x-chip", T({ key: "c:__proto__" })); await settle();
    assert.equal(recordCalls(calls).length, before + 2, "unknown chips do nothing");
    assert.match(x.html(), /<span class="fx-badge"><span class="sr-only">, <\/span>2<span/);
  });

  test("stale responses never replace newer ones; filters stay applied on failure with Try again (no automatic retry)", async () => {
    const env = load();
    const pending = [];
    const { x, calls } = await ready(env, answers((p) => (pending.length || p.includes("filter=") ? new Promise((resolve, reject) => pending.push({ p, resolve, reject })) : page([row(ID1)]))));
    x.applyFilter({ v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "CO_A" }] });
    x.applyFilter({ v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "CO_B" }] });
    assert.equal(pending.length, 2);
    pending[1].resolve(page([row(ID2, { Company: "CO_B" })])); await settle();
    pending[0].resolve(page([row(ID1, { Company: "CO_A" })])); await settle();
    assert.equal(x.items[0].id, ID2, "the older answer was dropped");
    // A failure: specific message from the server's code, filters and chips kept, Try again + Edit filters, nothing retried.
    x.applyFilter({ v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "CO_C" }] });
    pending[2].reject(Object.assign(new Error("x"), { code: "VALIDATION", cause: { status: 400, serverCode: "VALIDATION_ERROR" } })); await settle(20);
    const html = x.html(), n = recordCalls(calls).length;
    assert.match(html, /The server didn&#39;t accept this filter or sort|The server didn't accept this filter or sort/);
    assert.match(html, /data-action="fabric-x-retry"[\s\S]*data-action="fabric-x-filters" data-ds="sales" data-focus-key="edit-filters"/);
    assert.match(html, /Company:<\/span> = CO_C/, "the chip stays");
    await settle(50); assert.equal(recordCalls(calls).length, n, "no automatic retry");
    x.onAction("fabric-x-retry", T({}));
    assert.equal(recordCalls(calls).length, n + 1, "Try again asks once");
    pending[3].reject(Object.assign(new Error("x"), { cause: { status: 400, serverCode: "FABRIC_RANGE_TOO_LARGE" } })); await settle(20);
    assert.match(x.html(), /Too many rows in this date window to filter\. Narrow the dates, or add an exact condition/);
  });

  test("search is debounced 300 ms; search, sort and filter changes reset paging; orderBy= replaces sort/dir", async () => {
    const env = load(); const { x, calls } = await ready(env);
    x.onAction("fabric-x-page", T({ dir: "next" })); await settle();
    assert.equal(lastQuery(calls).get("cursor"), "c1");
    const n = recordCalls(calls).length;
    x.onInput({ dataset: { action: "fabric-x-search", ds: "sales" }, value: "Ex" }); x.onInput({ dataset: { action: "fabric-x-search", ds: "sales" }, value: "Exa" });
    await settle(250); assert.equal(recordCalls(calls).length, n, "nothing within 300 ms");
    await settle(120); assert.equal(recordCalls(calls).length, n + 1);
    assert.equal(lastQuery(calls).get("q"), "Exa"); assert.equal(lastQuery(calls).get("cursor"), null, "search resets paging");
    assert.equal(x.setOrderBy([["invoice_date", "asc"], ["Company", "desc"], ["customer_name", "asc"]]), true);
    await settle();
    let q = lastQuery(calls);
    assert.equal(q.get("orderBy"), "invoice_date:asc,Company:desc", "only orderable fields (customer_name isn't)");
    assert.equal(q.get("sort"), null); assert.equal(q.get("dir"), null);
    assert.match(x.html(), /aria-sort="ascending">invoice_date<span class="fx-sort-mark fabric-sort-mark" aria-hidden="true">▲/);
    assert.match(x.html(), /<option value="" selected>Columns: invoice_date, Company<\/option>/);
    x.onAction("fabric-x-dir-toggle", T({})); await settle();
    assert.equal(lastQuery(calls).get("orderBy"), "invoice_date:desc,Company:desc");
    x.onChange({ dataset: { action: "fabric-x-sort-select", ds: "sales" }, value: "date" }); await settle();
    q = lastQuery(calls); assert.equal(q.get("orderBy"), null); assert.equal(q.get("sort"), "date");
  });

  test("legacy parameters become conditions with the advanced schema (address rewritten); a company-only sort still gets company=", async () => {
    const env = load(); const { x, calls, synced } = await ready(env, answers(), "?company=CO_A");
    assert.deepEqual(plain(x.query.filters), {});
    assert.deepEqual(plain(x.query.filter), { v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "CO_A" }] });
    assert.ok(synced() > 0, "the address is rewritten");
    assert.match(env.FabricExplorer.formatQuery(x.query), /^\?filter=/);
    let q = lastQuery(calls);
    assert.deepEqual(decoded(q), { v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "CO_A" }] }); assert.equal(q.get("company"), null);
    x.onAction("fabric-x-sort", T({ sort: "entryNo" })); await settle();
    q = lastQuery(calls);
    assert.equal(q.get("sort"), "entryNo"); assert.equal(q.get("company"), "CO_A", "sent the way the server checks it"); assert.equal(q.get("filter"), null);
    // Without a company condition, the company-only sort asks for one (no request).
    const n = recordCalls(calls).length;
    x.onAction("fabric-x-chip", T({ key: "c:0" })); await settle();
    assert.equal(recordCalls(calls).length, n);
    assert.match(x.html(), /Choose a company to see rows in this order\./);
  });

  test("hooks: openFilterFor, applyFilter, getState/setState, onStateChange, get(path, {signal}) with abort", async () => {
    const env = load(); const { x, calls, panel } = await ready(env);
    const seen = [];
    const off = x.onStateChange((s) => seen.push(s));
    assert.equal(x.openFilterFor("landed_cost"), false, "a sensitive field can't be filtered");
    assert.equal(x.openFilterFor("invoice_item_quantity", { op: "gte", value: "5.50" }), true);
    assert.equal(env.focused.at(-1), '[data-focus-key="fb-val-0"]', "focus in the new condition's value");
    x.builder().apply(x); await settle();
    assert.deepEqual(decoded(lastQuery(calls)), { v: 1, op: "and", items: [{ field: "invoice_item_quantity", op: "gte", value: "5.50" }] });
    assert.equal(seen.length, 1); assert.deepEqual(plain(seen[0].filter), { v: 1, op: "and", items: [{ field: "invoice_item_quantity", op: "gte", value: "5.50" }] });
    assert.deepEqual(plain(x.applyFilter({ v: 1, op: "and", items: [{ field: "landed_cost", op: "eq", value: "1" }] })).ok, false);
    const n = recordCalls(calls).length;
    x.setState({ filter: { v: 1, op: "or", items: [{ field: "Company", op: "eq", value: "CO_A" }, { field: "Company", op: "eq", value: "CO_B" }] }, dateFrom: "2026-03-01", dateTo: "2026-03-15", q: "abc", orderBy: [["invoice_date", "asc"]], columns: ["invoice_date", "Company", "nope"] });
    await settle();
    assert.equal(recordCalls(calls).length, n + 1, "one request for the whole state");
    const s = x.getState();
    assert.deepEqual(plain(s), { filter: { v: 1, op: "or", items: [{ field: "Company", op: "eq", value: "CO_A" }, { field: "Company", op: "eq", value: "CO_B" }] }, dateFrom: "2026-03-01", dateTo: "2026-03-15", datePreset: null, q: "abc", searchField: null, orderBy: [["invoice_date", "asc"]], columns: ["invoice_date", "Company"] });
    off(); x.clearFilters(); assert.equal(seen.length, 2, "unsubscribed");
    // get(): through the adapter; an aborted signal rejects with AbortError and the answer is never delivered.
    panel.c.model.storage.adapter.request = (m, p) => new Promise((r) => setTimeout(() => r({ p }), 20));
    assert.deepEqual(await x.get("/fabric/sales/values?field=Company"), { p: "/fabric/sales/values?field=Company" });
    const ctrl = new AbortController(), pr = x.get("/fabric/sales/values?field=Company", { signal: ctrl.signal });
    ctrl.abort();
    await assert.rejects(pr, (e) => e.name === "AbortError");
    await assert.rejects(x.get("/x", { signal: ctrl.signal }), (e) => e.name === "AbortError");
  });

  test("the value picker (FabricValuePicker) is used for list conditions on fields with a value source, and its Apply sets the values", async () => {
    const stub = `var made = []; class FabricValuePicker { constructor(x, field, opts) { this.field = field; this.opts = opts; made.push(this); } mount(el) { this.root = el; return this; } focus() {} destroy() { this.destroyed = true; } } window.FabricValuePicker = FabricValuePicker;`;
    const env = load({ extra: stub });
    const { x } = await ready(env);
    const B = x.builder();
    x.openFilterFor("Company");
    let html = x.html();
    assert.match(html, /data-action="fabric-f-values" data-ds="sales" data-path="0" data-focus-key="fb-values-0" aria-expanded="false">Choose values…<\/button>/);
    assert.doesNotMatch(html, /data-action="fabric-f-tag"/);
    assert.equal(env.focused.at(-1), '[data-focus-key="fb-values-0"]');
    B.onAction(x, "fabric-f-values", T({ path: "0" }));
    assert.match(x.html(), /<div class="fx-fb__vpick" id="fabric-sales-fb-vp" data-path="0"><\/div>/, "the mount point");
    // Mount (as after a redraw): the picker gets the field, multi-select and the current values.
    env.context.document.querySelector = (sel) => (sel === "#fabric-sales-fb-vp" ? { id: "vp" } : null);
    B.syncPicker(x);
    const made = env.get("made");
    assert.equal(made.length, 1); assert.equal(made[0].field, "Company"); assert.equal(made[0].opts.multi, true);
    made[0].opts.onApply(["CO_A", null]);
    assert.deepEqual(plain(x.fb.draft.items[0].values), ["CO_A", null]);
    assert.match(x.html(), /2 chosen · Change…/); assert.match(x.html(), /<em>\(blank\)<\/em>/);
    // A text field with valueSource none (invoice_id): the tag input; Enter adds, Backspace removes.
    B.onAction(x, "fabric-f-field", T({ path: "0", field: "invoice_id" }));
    B.onChange(x, { dataset: { action: "fabric-f-op", ds: "sales", path: "0" }, value: "in" });
    const tag = (key, value) => ({ key, target: { value, closest: (s) => (s === "#fabric-sales-fb" ? {} : null), dataset: { action: "fabric-f-tag", path: "0" } }, preventDefault() {}, stopPropagation() {} });
    x.onKeydown(tag("Enter", "INV-1")); x.onKeydown(tag("Enter", "INV-2, INV-3"));
    assert.deepEqual(plain(x.fb.draft.items[0].values), ["INV-1", "INV-2", "INV-3"]);
    x.onKeydown(tag("Backspace", ""));
    assert.deepEqual(plain(x.fb.draft.items[0].values), ["INV-1", "INV-2"]);
  });

  test("saved filters hook: Save filter applies the draft, then hands over to FabricSavedFilters; fabric-s-* actions are forwarded", async () => {
    const stub = `var saved = []; var FabricSavedFilters = { onAction(x, action, target) { saved.push([x.ds, action]); return true; }, toolbarHtml: () => '<span class="fx-sf-bar">SF</span>', noticeHtml: () => '' }; window.FabricSavedFilters = FabricSavedFilters;`;
    const env = load({ extra: stub });
    const { x, calls } = await ready(env);
    assert.match(x.html(), /<span class="fx-sf-bar">SF<\/span>/, "the saved-filters toolbar group is drawn");
    x.openFilterFor("Company", { op: "eq", value: "CO_A" });
    assert.match(x.html(), /data-action="fabric-f-save" data-ds="sales" data-focus-key="fb-save"/);
    x.onAction("fabric-f-save", T({})); await settle();
    assert.deepEqual(decoded(lastQuery(calls)), { v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "CO_A" }] }, "applied first");
    assert.deepEqual(plain(env.get("saved")), [["sales", "fabric-s-save"]]);
    x.onAction("fabric-s-open", T({ id: "abc" }));
    assert.deepEqual(plain(env.get("saved")).at(-1), ["sales", "fabric-s-open"]);
  });

  test("column menu hook: FabricColumnMenu.headerHtml is drawn in each header; fabric-c-* and Shift+F10 are forwarded", async () => {
    const stub = `var cm = []; var FabricColumnMenu = { headerHtml: (x, f) => '<button class="cm" data-field="' + x.attr(f) + '"></button>', onAction: (x, a, t) => { cm.push(["action", a, t.dataset.field]); return true; }, onContextMenu: (x, e) => { cm.push(["context", e.key]); return true; } }; window.FabricColumnMenu = FabricColumnMenu;`;
    const env = load({ extra: stub });
    const { x } = await ready(env);
    const html = x.html();
    assert.equal((html.match(/<button class="cm"/g) || []).length, 5, "one per column");
    assert.match(html, /<th scope="col" class="fx-grid__frozen" title="invoice_date · date" aria-sort="descending"><button[^>]*>invoice_date<span class="fx-sort-mark[^>]*>▼<\/span><\/button><button class="cm" data-field="invoice_date"><\/button><\/th>/);
    x.onAction("fabric-c-menu", T({ field: "Company" }));
    x.onKeydown({ key: "F10", shiftKey: true, target: { closest: (s) => (s === '[data-grid="sales"]' ? {} : null), dataset: {} }, preventDefault() {} });
    assert.deepEqual(plain(env.get("cm")), [["action", "fabric-c-menu", "Company"], ["context", "F10"]]);
  });
});
