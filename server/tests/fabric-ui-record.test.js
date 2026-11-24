// Fabric Data record detail (site/assets/FabricFieldMeta.js and FabricRecordView.js): labels and groups for every verified field,
// value formatting, and the read-only object page drawn from a stub explorer. The browser files run unchanged in a vm with no
// DOM and no network: the stub adapter records any request, and none may be made. Synthetic data only (field names from the
// verified FactSales/FactInventory schemas, values made up).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { DATASETS } = require("../src/fabric/datasets");
const { KEY_FIELDS } = require("../src/fabric/fields");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
const ID1 = "a".repeat(24), ID2 = "b".repeat(24), ID3 = "c".repeat(24), ID4 = "d".repeat(24);
const plain = (v) => JSON.parse(JSON.stringify(v));
const HOSTILE = `<img src=x onerror="alert(1)">`;

function load() {
  const requests = [];
  const forbidden = (name) => () => { requests.push(name); throw new Error(`${name} is not allowed`); };
  const context = vm.createContext({ window: {}, console, Intl, Date, Map, Set, WeakMap, JSON, Number, String, Array, Object, RegExp, fetch: forbidden("fetch"), XMLHttpRequest: forbidden("XMLHttpRequest") });
  for (const f of ["AppView.js", "FabricFieldMeta.js", "FabricRecordView.js"]) vm.runInContext(read(f), context, { filename: f });
  const get = (n) => vm.runInContext(n, context);
  return { context, requests, AppView: get("AppView"), FabricFieldMeta: get("FabricFieldMeta"), FabricRecordView: get("FabricRecordView") };
}
const env = load();
const { FabricFieldMeta: M, FabricRecordView: V } = env;

function explorer({ ds = "sales", record = null, error = null, loading = false, items = [], recordId = ID1, sensitive = [] } = {}) {
  const view = new env.AppView({ innerHTML: "" }), calls = [], requests = env.requests;
  const fields = DATASETS[ds].fields.map((name) => ({ name, type: DATASETS[ds].types[name] || "string", sensitive: sensitive.includes(name) }));
  return {
    ds, recordId, items, calls, requests,
    record: { key: "x", loading, error, data: record ? { record } : null },
    info: { label: DATASETS[ds].label, byName: new Map(fields.map((f) => [f.name, f])), recordKey: [...DATASETS[ds].recordKey] },
    p: { adapter: { request: (...a) => { requests.push(a); throw new Error("no requests"); } }, redraw: () => calls.push(["redraw"]) },
    esc: (v) => view.escape(v ?? ""), attr: (v) => view.attr(v),
    listHref() { return `/fabric/${ds}`; }, recordHref(id) { return `/fabric/${ds}/records/${id}`; },
    refresh() { calls.push(["refresh"]); }, retry() { calls.push(["retry"]); }, openRecord(id) { calls.push(["openRecord", id]); this.recordId = id; },
    onAction(action, target) { calls.push(["explorer", action, target?.dataset?.id]); }
  };
}
const salesRecord = (over = {}) => {
  const values = { Company: "Synthetic Co", invoice_id: "INV0001", Line_No: 20000, invoice_date: "2026-02-03T00:00:00.000Z", customer_name: "Example Customer", is_invoice_closed: true, Unit_Price: "1234567.891234", invoice_item_amount: 99.5, uom_code: null, join_key_Company_Invoice: "Synthetic Co/INV0001", connect_to_rmr: "x/1", "Custom.2": "Zone A", ...over };
  const types = { invoice_date: "date", is_invoice_closed: "bool", Unit_Price: "decimal", invoice_item_amount: "number", Line_No: "number" };
  return { id: ID1, key: { Company: values.Company, invoice_id: values.invoice_id, Line_No: values.Line_No }, fields: Object.entries(values).map(([name, value]) => ({ name, value, type: value === null ? "null" : types[name] || "string" })) };
};
const rows = (...ids) => ids.map((id, i) => ({ id, values: { Company: "Synthetic Co", invoice_id: `INV000${i + 1}` } }));

describe("FabricFieldMeta: labels and groups for the verified schemas", () => {
  for (const ds of ["sales", "inventory"]) {
    test(`${ds}: every verified field has a label and exactly one group`, () => {
      const verified = DATASETS[ds].fields;
      assert.equal(verified.length, ds === "sales" ? 85 : 87);
      const groups = M.groups(ds), seen = new Map();
      for (const g of groups) for (const f of g.fields) seen.set(f, (seen.get(f) || 0) + 1);
      for (const f of verified) {
        assert.equal(seen.get(f), 1, `${f} is in exactly one group`);
        const label = M.label(ds, f);
        assert.ok(typeof label === "string" && label.trim().length > 0 && !label.includes("_"), `${f} has a friendly label (${label})`);
      }
      assert.deepEqual([...seen.keys()].sort(), [...verified].sort(), "groups name only verified fields");
      assert.ok(groups.every((g) => g.id && g.title && g.fields.length), "no empty group");
      assert.equal(new Set(groups.map((g) => g.id)).size, groups.length);
    });
    test(`${ds}: every label is unique (no two fields read the same)`, () => {
      const byLabel = new Map();
      for (const f of DATASETS[ds].fields) { const l = M.label(ds, f).toLowerCase(); byLabel.set(l, [...(byLabel.get(l) || []), f]); }
      assert.deepEqual([...byLabel].filter(([, names]) => names.length > 1), [], "duplicate labels");
    });
  }
  test("sales: the two quantity fields are told apart", () => {
    assert.equal(M.label("sales", "invoice_item_quantity"), "Quantity (line)");
    assert.equal(M.label("sales", "Quantity"), "Quantity (source column)");
    assert.equal(M.label("inventory", "Quantity"), "Quantity");
  });
  test("group titles follow the agreed sections", () => {
    assert.deepEqual(plain(M.groups("sales").map((g) => g.title)), ["Invoice & header", "Customer", "Sales line", "Product classification", "Sales attribution", "Source", "Technical identifiers", "Financial & cost"]);
    assert.deepEqual(plain(M.groups("inventory").map((g) => g.title)), ["Item", "Ledger entry", "Company & location", "Quantities", "Document references", "Posting", "Amounts & cost", "Technical identifiers"]);
    for (const f of DATASETS.inventory.sensitive) assert.equal(M.groupOf("inventory", f), "cost");
    assert.equal(M.groupOf("sales", "landed_cost"), "financial");
  });
  test("specific labels, the fallback and isKey", () => {
    assert.equal(M.label("sales", "invoice_id"), "Invoice no.");
    assert.equal(M.label("inventory", "Posting_Date"), "Posting date");
    assert.equal(M.label("inventory", "Cost_Amount_Actual"), "Cost amount (actual)");
    assert.equal(M.label("sales", "Custom.2"), "Custom 2");
    assert.equal(M.label("sales", "brand_new_field"), "Brand new field");
    assert.equal(M.label("nope", "x_y"), "X y");
    assert.deepEqual(DATASETS.sales.recordKey.filter((f) => M.isKey("sales", f)), DATASETS.sales.recordKey);
    assert.deepEqual(DATASETS.inventory.recordKey.filter((f) => M.isKey("inventory", f)), DATASETS.inventory.recordKey);
    assert.equal(M.isKey("sales", "customer_name"), false);
    assert.equal(M.isKey("inventory", "invoice_id"), false);
    assert.deepEqual(plain(M.joinKeys("sales")), [...KEY_FIELDS]);
    for (const f of M.joinKeys("inventory")) assert.ok(DATASETS.inventory.fields.includes(f));
  });
  test("arrange: only present fields, empty groups dropped, unknown names kept in Other", () => {
    const out = M.arrange("sales", ["invoice_id", "Company", "zz_new", "customer_id"]);
    assert.deepEqual(plain(out.map((g) => [g.id, g.fields])), [["invoice", ["invoice_id", "Company"]], ["customer", ["customer_id"]], ["other", ["zz_new"]]]);
  });
});

describe("FabricFieldMeta.format", () => {
  const f = (v, t, n) => { const r = M.format(v, t, n); return { text: r.text, cls: r.cls, title: r.title }; };
  test("dates as UTC YYYY-MM-DD", () => {
    assert.equal(f("2026-02-03T00:00:00.000Z", "date").text, "2026-02-03");
    assert.equal(f("2026-02-03T23:30:00.000Z", "date").text, "2026-02-03 23:30 UTC");
    assert.equal(f("2026-02-03T00:00:00.000Z", "date").title, "2026-02-03T00:00:00.000Z");
    assert.equal(f("not a date", "date").text, "not a date");
  });
  test("null, undefined and empty strings show the No value marker", () => {
    for (const v of [null, undefined, ""]) assert.deepEqual(f(v, "string"), { text: "—", cls: "fx-null", title: "No value" });
  });
  test("Decimal128 strings stay exact, with digit grouping only", () => {
    const sep = M.separators();
    assert.equal(f("1234567.891234567890", "decimal").text, `1${sep.group}234${sep.group}567${sep.decimal}891234567890`);
    assert.equal(f("-0.10", "decimal").text, `-0${sep.decimal}10`);
    assert.equal(f("1.5E+3", "decimal").text, "1.5E+3");
    assert.equal(f("1234567.891234567890", "decimal").title, "1234567.891234567890");
    assert.equal(f("9007199254740993", "number").text.replace(/\D/g, ""), "9007199254740993", "a Long sent as a string loses no digits");
    assert.match(f("12", "decimal").cls, /fx-num/);
  });
  test("numbers localised, booleans Yes/No, strings as given", () => {
    assert.equal(f(1234.5, "number").text, (1234.5).toLocaleString(undefined, { maximumFractionDigits: 20 }));
    assert.equal(f(0.1, "number").text, (0.1).toLocaleString());
    assert.equal(f(true, "bool").text, "Yes"); assert.equal(f(false, "bool").text, "No");
    assert.equal(f("null", "string").text, "null");
    assert.equal(f(HOSTILE, "string").text, HOSTILE, "format returns plain text; escaping is the caller's job");
    assert.match(f("A/B", "string", "join_key_Company_Invoice").cls, /fx-mono/);
  });
  test("identifier-like whole numbers have no digit grouping; quantities and amounts keep it", () => {
    for (const name of ["Line_No", "Entry_No", "Document_Line_No", "Order_Line_No", "Prod_Order_Comp_Line_No", "Dimension_Set_ID", "invoice_id", "No", "Job_Task_No", "customer_id"]) {
      assert.equal(f(10000, "int", name).text, "10000", name);
      assert.equal(f(1076, "number", name).text, "1076", name);
      assert.equal(f("20000", "decimal", name).text, "20000", `${name} as an exact string`);
      assert.match(f(10000, "int", name).cls, /fx-num/);
      assert.ok(M.isIdentifier(name), name);
    }
    for (const name of ["Quantity", "invoice_item_quantity", "Remaining_Quantity", "invoice_item_amount", "Unit_Price", "RunningBalance", "Cost_Amount_Actual"]) {
      assert.equal(M.isIdentifier(name), false, name);
      assert.equal(f(10000, "int", name).text, (10000).toLocaleString(undefined, { maximumFractionDigits: 20 }), name);
    }
    assert.equal(f(12.5, "decimal", "Line_No").text, (12.5).toLocaleString(undefined, { maximumFractionDigits: 20 }), "a fraction is not an identifier");
  });
});

describe("FabricRecordView.html", () => {
  test("object page: title, actions, tabs, groups and keys", () => {
    const x = explorer({ record: salesRecord(), items: rows(ID1, ID2) });
    const html = V.html(x);
    assert.match(html, /class="fx-object/);
    assert.match(html, /Sales record <span class="fx-object__dot" aria-hidden="true">·<\/span> Synthetic Co <span[^>]*>·<\/span> INV0001 <span[^>]*>·<\/span> line 20[^<]*000/);
    for (const t of ["Overview", "All fields \\(12\\)", "Keys"]) assert.match(html, new RegExp(`role="tab"[^>]*>${t}</button>`));
    assert.match(html, /href="\/fabric\/sales" data-action="fabric-r-back"/);
    assert.match(html, /data-action="fabric-r-refresh"/);
    for (const g of ["Invoice &amp; header", "Customer", "Sales attribution", "Technical identifiers", "Financial &amp; cost"]) assert.match(html, new RegExp(`<legend class="fx-fieldgroup__legend">${g}</legend>`));
    assert.doesNotMatch(html, /Product classification/, "a group with no fields in the response is not drawn");
    assert.match(html, /<dt class="fx-field__label" title="invoice_id">Invoice no\.<\/dt><dd class="fx-field__value fx-field__value--key" title="INV0001">/);
    assert.match(html, /<dd class="fx-field__value" title="No value"><span class="fx-null" aria-label="No value">—<\/span><\/dd>/);
    assert.match(html, /title="2026-02-03T00:00:00\.000Z"><span class="fx-date">2026-02-03<\/span>/);
    // All fields: original names shown, filter box wired to the fabric-r- prefix
    assert.match(html, /<code class="fx-allfields__name">Custom\.2<\/code>/);
    assert.match(html, /data-action="fabric-r-filter"/);
    // Keys: record ID, record key, join/connect keys present in the response
    const keys = html.slice(html.indexOf('data-group="keys"'));
    assert.match(keys, /Record ID/); assert.match(keys, new RegExp(ID1));
    assert.match(keys, /Join and connect keys/); assert.match(keys, /title="join_key_Company_Invoice"/); assert.match(keys, /title="connect_to_rmr"/);
    assert.doesNotMatch(keys, /title="Ref"/, "a join key missing from the response isn't invented");
    // Only the Overview panel is visible by default; read-only (no form controls besides the filter box)
    assert.match(html, /id="fx-rpanel-sales-overview"[^>]*tabindex="0" >/);
    assert.match(html, /id="fx-rpanel-sales-fields"[^>]*hidden/);
    assert.doesNotMatch(html, /<textarea|<select|contenteditable|type="checkbox"|data-action="fabric-r-(save|edit|delete|export)/);
    assert.equal((html.match(/<input /g) || []).length, 1);
  });
  test("hostile values are escaped everywhere", () => {
    const x = explorer({ record: salesRecord({ Company: HOSTILE, customer_name: `"'><script>alert(1)</script>`, zz_new: HOSTILE }), items: [{ id: ID1, values: { Company: HOSTILE } }, { id: ID2, values: { invoice_id: `<b onmouseover=1>` } }] });
    const html = V.html(x);
    assert.doesNotMatch(html, /<img|<script|<b onmouseover/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /<legend class="fx-fieldgroup__legend">Other<\/legend>/, "an unknown field is kept, in Other");
  });
  test("no restricted group when the server left those fields out; shown with a marker when present", () => {
    const without = salesRecord(); without.fields = without.fields.filter((f) => !DATASETS.sales.sensitive.includes(f.name));
    const h1 = V.html(explorer({ record: without }));
    assert.doesNotMatch(h1, /Restricted|Custom 2|Landed cost/);
    const invNo = { id: ID1, key: { Company: "Synthetic Co", Entry_No: 7 }, fields: [{ name: "Company", value: "Synthetic Co", type: "string" }, { name: "Entry_No", value: 7, type: "number" }, { name: "Quantity", value: "5.00", type: "decimal" }] };
    const h2 = V.html(explorer({ ds: "inventory", record: invNo }));
    assert.doesNotMatch(h2, /Amounts &amp; cost|Cost amount/);
    assert.match(h2, /Inventory entry <span[^>]*>·<\/span> Synthetic Co <span[^>]*>·<\/span> entry 7/);
    const withCost = { ...invNo, fields: [...invNo.fields, { name: "Cost_Amount_Actual", value: "10.50", type: "decimal" }] };
    const h3 = V.html(explorer({ ds: "inventory", record: withCost, sensitive: ["Cost_Amount_Actual"] }));
    assert.match(h3, /<legend class="fx-fieldgroup__legend">Amounts &amp; cost<\/legend>/);
    assert.match(h3, /Cost amount \(actual\) <span class="fx-chip fx-chip--restricted"/);
  });
  test("previous/next and the object list use only the loaded page rows", () => {
    const x = explorer({ record: salesRecord(), items: rows(ID1, ID2, ID3), recordId: ID2 });
    const html = V.html(x);
    assert.match(html, new RegExp(`href="/fabric/sales/records/${ID1}" data-action="fabric-r-open" data-ds="sales" data-id="${ID1}" data-focus-key="record-prev"`));
    assert.match(html, new RegExp(`href="/fabric/sales/records/${ID3}" data-action="fabric-r-open" data-ds="sales" data-id="${ID3}" data-focus-key="record-next"`));
    assert.match(html, /2 \/ 3/);
    assert.match(html, /Rows on this page \(3\)/);
    assert.match(html, new RegExp(`data-id="${ID2}" aria-current="true"`));
    assert.doesNotMatch(html, new RegExp(ID4));
    const last = V.html(explorer({ record: salesRecord(), items: rows(ID1, ID2), recordId: ID2 }));
    assert.match(last, /<button type="button" class="fx-btn" disabled data-focus-key="record-next"/, "no next on the last loaded row (never loads more)");
    const off = V.html(explorer({ record: salesRecord(), items: rows(ID2, ID3), recordId: ID4 }));
    assert.match(off, /disabled data-focus-key="record-prev"/); assert.match(off, /disabled data-focus-key="record-next"/);
    const none = V.html(explorer({ record: salesRecord(), items: [] }));
    assert.doesNotMatch(none, /fx-object__nav/);
  });
  test("loading, error and not-found states", () => {
    assert.match(V.html(explorer({ loading: true })), /aria-busy="true"[\s\S]*Loading the record/);
    const err = V.html(explorer({ error: { kind: "generic", code: "X", message: `Broke ${HOSTILE}`, reference: "req-12345678" } }));
    assert.match(err, /fx-status--error/); assert.match(err, /data-action="fabric-r-retry"/); assert.doesNotMatch(err, /<img/); assert.match(err, /req-12345678/);
    const nf = V.html(explorer({ error: { kind: "record", code: "FABRIC_RECORD_NOT_FOUND", message: "gone" } }));
    assert.match(nf, /may have been refreshed upstream/); assert.match(nf, /href="\/fabric\/sales" data-action="fabric-r-reload"/);
  });
  test("works without FabricFieldMeta (degrades to raw names)", () => {
    const ctx = vm.createContext({ window: {}, console, Intl, Date, Map, Set, WeakMap });
    for (const f of ["AppView.js", "FabricRecordView.js"]) vm.runInContext(read(f), ctx, { filename: f });
    const RV = vm.runInContext("FabricRecordView", ctx), x = explorer({ record: salesRecord() });
    const html = RV.html(x);
    assert.match(html, /<legend class="fx-fieldgroup__legend">Fields<\/legend>/); assert.match(html, /invoice id/);
  });
});

describe("FabricRecordView.onAction: no requests, delegated navigation", () => {
  test("actions delegate to the explorer and never call the network", () => {
    const before = env.requests.length, x = explorer({ record: salesRecord(), items: rows(ID1, ID2) });
    const ev = { preventDefault() { this.prevented = true; } };
    V.onAction(x, "fabric-r-open", { tagName: "A", dataset: { id: ID2 } }, ev);
    assert.equal(ev.prevented, true);
    V.onAction(x, "fabric-r-open", { tagName: "A", dataset: { id: "nope" } }, {});
    V.onAction(x, "fabric-r-open", { tagName: "A", dataset: { id: ID2 } }, { ctrlKey: true, preventDefault() { throw new Error("modifier clicks open a new tab"); } });
    V.onAction(x, "fabric-r-back", { tagName: "A", dataset: {} }, {});
    V.onAction(x, "fabric-r-refresh", { tagName: "BUTTON", dataset: {} });
    V.onAction(x, "fabric-r-retry", { tagName: "BUTTON", dataset: {} });
    V.onAction(x, "fabric-r-tab", { tagName: "BUTTON", dataset: { tab: "keys" } });
    V.onAction(x, "fabric-r-tab", { tagName: "BUTTON", dataset: { tab: "bogus" } });
    V.onAction(x, "fabric-r-nav", { tagName: "BUTTON", dataset: {} });
    V.onInput(x, { dataset: { action: "fabric-r-filter" }, value: "invoice" });
    assert.deepEqual(x.calls.map((c) => c.filter((p) => p !== undefined).join(" ")), ["explorer fabric-x-open " + ID2, "explorer fabric-x-back", "refresh", "retry", "redraw", "redraw"]);
    assert.equal(env.requests.length, before, "no request was made");
    const html = V.html(x);
    assert.match(html, /id="fx-rpanel-sales-keys"[^>]*tabindex="0" >/, "the chosen tab is kept in the view state");
    assert.match(html, /fx-object__nav is-collapsed/);
    assert.match(html, /value="invoice"/); assert.match(html, /\d+ of 12 fields/);
    assert.match(html, /<tr data-filter="[^"]*" hidden>/);
  });
  test("keyboard: arrows move between tabs", () => {
    const x = explorer({ record: salesRecord() });
    const ev = { key: "ArrowRight", target: { dataset: { action: "fabric-r-tab", tab: "overview" } }, preventDefault() {} };
    assert.equal(V.onKeydown(x, ev), true);
    assert.match(V.html(x), /id="fx-rpanel-sales-fields"[^>]*tabindex="0" >/);
    assert.equal(V.onKeydown(x, { key: "x", target: { dataset: { action: "fabric-r-tab", tab: "fields" } } }), false);
  });
  test("the view sources make no requests and hold no storage", () => {
    for (const f of ["FabricRecordView.js", "FabricFieldMeta.js"]) {
      const src = read(f);
      assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|\.request\(|localStorage|sessionStorage|indexedDB|EventSource|WebSocket/, `${f} is request- and storage-free`);
    }
  });
  test("index.html loads the files before FabricExplorer.js", () => {
    const html = fs.readFileSync(path.join(ASSETS, "..", "index.html"), "utf8");
    const at = (s) => html.indexOf(s);
    assert.ok(at("assets/fabric-record.css") > at("assets/jarc-theme.css"));
    assert.ok(at("assets/FabricFieldMeta.js") > 0 && at("assets/FabricFieldMeta.js") < at("assets/FabricRecordView.js") && at("assets/FabricRecordView.js") < at("assets/FabricExplorer.js"));
  });
});
