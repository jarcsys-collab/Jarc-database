// Fabric Data value discovery (src/fabric/values.js, repository.distinctValues): bounded distinct values for the filter value
// picker. Field refusal (unknown, sensitive, no value list), q as an escaped prefix/contains, `after` keyset paging without
// repeats, limit and `limited`, context narrowing with the field's own conditions removed, the Sales date window, blanks, the
// query shape (hint, maxTimeMS, $limit row cap) and the cache key. In-memory stand-in (tests/support/fabric-fake.js); synthetic
// data only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { createFabricData } = require("../src/fabric");
const { DATASET_NAMES, DATASETS } = require("../src/fabric/datasets");
const { FabricValues, VALUE_FIELDS, valueSourceOf, stripField } = require("../src/fabric/values");
const { assertSafePipeline } = require("../src/fabric/repository");
const { loadConfig } = require("../src/config");
const { entraEnv } = require("./helpers");
const { FabricFakeClient, row, invRow, inventoryRows, DEFAULT_INDEXES, ID_ONLY } = require("./support/fabric-fake");

const baseConfig = loadConfig(entraEnv({ JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb" })).fabricData;
const withConfig = (overrides) => Object.defineProperty({ ...baseConfig, ...overrides }, "uri", { value: baseConfig.uri });
const PLAIN = Object.freeze({ datasets: new Set(DATASET_NAMES), sensitive: false });
const SENSITIVE = Object.freeze({ datasets: new Set(DATASET_NAMES), sensitive: true });
const NOW = new Date("2026-11-24T10:00:00Z");
const day = (d) => new Date(`${d}T00:00:00Z`);
const b64 = (model) => Buffer.from(JSON.stringify(model)).toString("base64url");
const rejects = (promise, code, reason) => assert.rejects(promise, (e) => { assert.equal(e.code, code); if (reason) assert.equal(e.details?.reason, reason); return true; });

// A stand-in for B1's filter adapter (eq / in conditions under AND or OR): what values.js needs from it.
const testContext = {
  parse: (text) => { const m = JSON.parse(Buffer.from(text, "base64url").toString("utf8")); if (m.v !== 1) throw Object.assign(new Error("bad"), { code: "VALIDATION_ERROR" }); return m; },
  canonical: (m) => JSON.stringify(m),
  compile: (m) => {
    const one = (n) => (Array.isArray(n.items) ? { [n.op === "or" ? "$or" : "$and"]: n.items.map(one) } : n.op === "in" ? { [n.field]: { $in: n.values } } : { [n.field]: n.value });
    return one(m);
  }
};

const salesRows = () => [
  // Inside the default window (30 days ending at the latest date, 2026-11-20).
  ...["Synthetic Co A", "Synthetic Co A", "Synthetic Co B", "SYNCO-C", null, "", " "].map((Company, i) => row({ Company, invoice_date: day("2026-11-1" + (i % 9)), Location_Code: Company === "Synthetic Co B" ? "LOC-B" : "LOC-A", customer_name: `Example Customer ${i}`, customer_id: `C${100 + i}` })),
  row({ Company: "Synthetic Co B", invoice_date: day("2026-11-20"), Location_Code: "LOC-B2", customer_name: "Example (Special) Customer.*", customer_id: "C900" }),
  // Outside the default window and outside any 92-day window around it.
  row({ Company: "OLD-COMPANY", invoice_date: day("2025-01-10"), Location_Code: "LOC-OLD" }),
  row({ Company: "Synthetic Co D", invoice_date: day("2026-09-01"), Location_Code: "LOC-D" })
];
function stack({ sales = salesRows(), inventory = inventoryRows(300), config = baseConfig, context = testContext, cacheMs = 0, salesIndexes = DEFAULT_INDEXES } = {}) {
  const client = new FabricFakeClient({ docs: sales, indexes: salesIndexes, inventory: { docs: inventory, indexes: ID_ONLY } });
  const fabric = createFabricData({ config, logger: { warn() {}, error() {} }, createClient: () => client, now: () => NOW });
  const values = new FabricValues({ repository: fabric.repository, sources: fabric.sources, config, now: () => NOW, context: context === "default" ? undefined : context, cacheMs });
  return { ...fabric, client, values };
}
const lastAggregate = (s, collection) => s.client.calls.filter((c) => c.op === "aggregate" && c.collection === collection).at(-1);
const names = (out) => out.values.map((v) => v.value);

describe("Value fields", () => {
  test("only allow-listed, non-sensitive, undotted string fields; valueSource for the schema", () => {
    for (const name of DATASET_NAMES) {
      const ds = DATASETS[name];
      for (const f of Object.keys(VALUE_FIELDS[name])) {
        assert.ok(ds.fields.includes(f) && !ds.sensitive.includes(f) && !f.includes(".") && (ds.types[f] || "string") === "string", f);
      }
    }
    assert.equal(valueSourceOf("sales", "Company"), "distinct");
    assert.equal(valueSourceOf("sales", "customer_name"), "search");
    assert.equal(valueSourceOf("sales", "landed_cost"), "none");
    assert.equal(valueSourceOf("inventory", "Posting_Date"), "none");
    assert.equal(valueSourceOf("nope", "Company"), "none");
    // The same lists as the schema's valueSource (filter-model.js, datasets.js filtering).
    const filterModel = require("../src/fabric/filter-model");
    for (const name of DATASET_NAMES) for (const f of DATASETS[name].fields) assert.equal(valueSourceOf(name, f), filterModel.valueSource(DATASETS[name], f), `${name}.${f}`);
    assert.equal(VALUE_FIELDS.sales.customer_id.match, "prefix");
    assert.equal(VALUE_FIELDS.sales.customer_name.match, "contains");
    assert.equal(VALUE_FIELDS.inventory.Company.match, "contains");
  });

  test("unknown, sensitive (without permission) and missing fields are 'Unknown field.'; other fields have no value list; nothing reaches the database", async () => {
    const s = stack();
    for (const field of ["NoSuchField", "_id", "landed_cost", "Custom.2", "Text", "$where", "Company ", "__proto__", "constructor"]) await rejects(s.values.list("sales", { field }, PLAIN), "VALIDATION_ERROR", "unknownField");
    for (const field of ["Cost_Amount_Actual", "trade_price"]) await rejects(s.values.list("inventory", { field }, PLAIN), "VALIDATION_ERROR", "unknownField");
    // Visible but not offered: sensitive (even for sensitive readers), dates, numbers, Decimal128, booleans, constant, dotted.
    for (const field of ["landed_cost", "Custom.2", "invoice_date", "invoice_due_date", "Quantity", "Unit_Price", "invoice_item_amount_sales", "is_invoice_closed", "custom_1", "invoice_status", "invoice_id"]) await rejects(s.values.list("sales", { field }, SENSITIVE), "VALIDATION_ERROR", "noValueList");
    for (const field of ["Posting_Date", "Expiration_Date", "Quantity", "Open", "Cost_Amount_Actual", "Variant_Code", "ETag"]) await rejects(s.values.list("inventory", { field }, SENSITIVE), "VALIDATION_ERROR", "noValueList");
    await rejects(s.values.list("sales", {}, PLAIN), "VALIDATION_ERROR", "required");
    await rejects(s.values.list("sales", { field: ["Company", "Company"] }, PLAIN), "VALIDATION_ERROR", "repeated");
    await rejects(s.values.list("sales", { field: "Company", sort: "x" }, PLAIN), "VALIDATION_ERROR", "unknownParameter");
    await rejects(s.values.list("sales", { field: "Company", q: { $gt: "" } }, PLAIN), "VALIDATION_ERROR", "repeated");
    assert.equal(s.client.queries().length, 0);
  });

  test("errors never echo the field name or value", async () => {
    const s = stack();
    await assert.rejects(s.values.list("sales", { field: "landed_cost" }, PLAIN), (e) => { assert.doesNotMatch(e.message + JSON.stringify(e.details), /landed/); return true; });
    await assert.rejects(s.values.list("sales", { field: "Company", q: "x".repeat(101) }, PLAIN), (e) => { assert.doesNotMatch(e.message, /xxx/); return true; });
  });
});

describe("Sales values (indexed mode, always inside the date window)", () => {
  test("distinct values in BSON order with one blank bucket first; counts when complete; hinted, bounded, maxTimeMS", async () => {
    const s = stack();
    const out = await s.values.list("sales", { field: "Company" }, PLAIN);
    assert.deepEqual(out.window, { field: "invoice_date", dateFrom: "2026-10-22", dateTo: "2026-11-20", defaulted: true });
    assert.deepEqual(out.values, [{ value: null, blank: true, count: 3 }, { value: "SYNCO-C", count: 1 }, { value: "Synthetic Co A", count: 2 }, { value: "Synthetic Co B", count: 2 }]);
    assert.equal(out.complete, true);
    assert.equal(out.limited, null);
    assert.equal(out.nextAfter, null);
    assert.equal(out.mode, "indexed");
    assert.equal(out.contextual, false);
    assert.ok(!names(out).includes("OLD-COMPANY") && !names(out).includes("Synthetic Co D"), "outside the window");
    const call = lastAggregate(s, "FactSales");
    assert.equal(call.options.hint, "fabric_invoice_date");
    assert.equal(call.options.maxTimeMS, 2000);
    assert.equal(call.options.allowDiskUse, false);
    const pipeline = s.client.pipelines.at(-1);
    assertSafePipeline(pipeline);
    assert.deepEqual(pipeline.map((st) => Object.keys(st)[0]), ["$match", "$limit", "$project", "$group", "$facet"]);
    assert.equal(pipeline[1].$limit, 20001);
    assert.deepEqual(pipeline[0].$match, { invoice_date: { $gte: day("2026-10-22"), $lt: day("2026-11-21") } });
  });

  test("the window: an explicit one is used; more than 92 days or reversed is refused before any query", async () => {
    const s = stack();
    const sept = await s.values.list("sales", { field: "Company", dateFrom: "2026-08-25", dateTo: "2026-09-05" }, PLAIN);
    assert.deepEqual(names(sept), ["Synthetic Co D"]);
    assert.equal(sept.window.defaulted, false);
    const before = s.client.queries().length;
    await rejects(s.values.list("sales", { field: "Company", dateFrom: "2025-01-01", dateTo: "2026-11-20" }, PLAIN), "VALIDATION_ERROR");
    await rejects(s.values.list("sales", { field: "Company", dateFrom: "2026-11-20", dateTo: "2026-11-01" }, PLAIN), "VALIDATION_ERROR", "order");
    await rejects(s.values.list("sales", { field: "Company", dateFrom: "2026-02-30" }, PLAIN), "VALIDATION_ERROR", "date");
    assert.equal(s.client.queries().length, before);
  });

  test("the window stays a top-level conjunct whatever the context says", async () => {
    const s = stack();
    const filter = b64({ v: 1, op: "or", items: [{ field: "Location_Code", op: "eq", value: "LOC-OLD" }, { field: "Location_Code", op: "eq", value: "LOC-D" }] });
    const out = await s.values.list("sales", { field: "Company", filter }, PLAIN);
    assert.deepEqual(out.values, [], "OLD-COMPANY and Synthetic Co D are outside the window");
    const match = s.client.pipelines.at(-1)[0].$match;
    assert.ok(match.$and.some((c) => c.invoice_date), "window conjunct");
  });

  test("without the date index Sales values are FABRIC_INDEX_REQUIRED, never a collection scan", async () => {
    const s = stack({ salesIndexes: [DEFAULT_INDEXES[0]], sales: Array.from({ length: 30 }, () => row({ Company: "X" })), config: withConfig({ unindexedScanMax: 10 }) });
    await rejects(s.values.list("sales", { field: "Company" }, PLAIN), "FABRIC_INDEX_REQUIRED");
    assert.equal(s.client.queries("FactSales").length, 0);
  });
});

describe("Search (q)", () => {
  test("contains (case-insensitive) for names, anchored prefix for identifiers; regex characters are escaped", async () => {
    const s = stack();
    const names_ = await s.values.list("sales", { field: "customer_name", q: "special) customer.*" }, PLAIN);
    assert.deepEqual(names(names_), ["Example (Special) Customer.*"]);
    const none = await s.values.list("sales", { field: "customer_name", q: ".*" }, PLAIN);
    assert.deepEqual(names(none), ["Example (Special) Customer.*"], "'.*' is literal text, not a pattern");
    const prefix = await s.values.list("sales", { field: "customer_id", q: "c10" }, PLAIN);
    assert.deepEqual(names(prefix), ["C100", "C101", "C102", "C103", "C104", "C105", "C106"]);
    const notInside = await s.values.list("sales", { field: "customer_id", q: "00" }, PLAIN);
    assert.deepEqual(names(notInside), [], "identifiers match from the start only");
    const contains = await s.values.list("sales", { field: "Company", q: "co a" }, PLAIN);
    assert.deepEqual(names(contains), ["Synthetic Co A"]);
    const regex = s.client.pipelines.at(-1)[0].$match.$and.find((c) => c.Company)?.Company;
    assert.deepEqual(regex, { $regex: "co a", $options: "i" });
  });

  test("injection attempts in q stay literal text", async () => {
    const s = stack();
    for (const q of ["^", "$", "(", "[a-z]+", "\\", "a|b", "{\"$gt\":\"\"}", "$where", "'; return true; //"]) {
      const out = await s.values.list("sales", { field: "customer_name", q }, PLAIN);
      assert.ok(out.values.every((v) => typeof v.value === "string" && v.value.toLowerCase().includes(q.toLowerCase())), q);
    }
    await rejects(s.values.list("sales", { field: "Company", q: "a\u0000b" }, PLAIN), "VALIDATION_ERROR", "text");
    await rejects(s.values.list("sales", { field: "Company", q: "y".repeat(101) }, PLAIN), "VALIDATION_ERROR", "text");
    const blank = await s.values.list("sales", { field: "Company", q: "   " }, PLAIN);
    assert.equal(blank.values.length, 4, "a blank q is no search");
  });
});

describe("Paging, limit and limited", () => {
  const many = () => Array.from({ length: 250 }, (_, i) => row({ Company: `Co ${String(i % 120).padStart(3, "0")}`, invoice_date: day("2026-11-10"), Location_Code: i % 2 ? "LOC-ODD" : "LOC-EVEN" })).concat([row({ Company: null, invoice_date: day("2026-11-10") })]);

  test("limit + after walk every value exactly once, blank bucket first; limited = valueLimit until the last page", async () => {
    const s = stack({ sales: many() });
    const seen = [];
    let after, pages = 0;
    do {
      const out = await s.values.list("sales", { field: "Company", limit: "7", ...(after !== undefined ? { after } : {}) }, PLAIN);
      assert.ok(out.values.length <= 7);
      if (out.nextAfter !== null) { assert.equal(out.complete, false); assert.deepEqual(out.limited, { reason: "valueLimit", rowsScanned: out.limited.rowsScanned, rowCap: 20000 }); assert.ok(out.values.every((v) => v.count === undefined), "no counts unless complete"); }
      seen.push(...names(out)); after = out.nextAfter ?? undefined; pages += 1;
      assert.ok(pages < 100);
    } while (after !== undefined);
    assert.equal(seen[0], null);
    assert.equal(seen.length, 121);
    assert.equal(new Set(seen).size, 121, "no repeats");
    assert.deepEqual(seen.slice(1), [...seen.slice(1)].sort());
  });

  test("a page ending on the blank bucket continues with after='' and never repeats it or ' '", async () => {
    const s = stack();
    const first = await s.values.list("sales", { field: "Company", limit: "1" }, PLAIN);
    assert.deepEqual(first.values, [{ value: null, blank: true }]);
    assert.equal(first.nextAfter, "");
    const second = await s.values.list("sales", { field: "Company", limit: "10", after: "" }, PLAIN);
    assert.deepEqual(names(second), ["SYNCO-C", "Synthetic Co A", "Synthetic Co B"]);
    assert.equal(second.complete, true);
  });

  test("limit bounds: default 100, 1–1000", async () => {
    const s = stack({ sales: many() });
    const out = await s.values.list("sales", { field: "Company" }, PLAIN);
    assert.equal(out.values.length, 100);
    assert.equal(s.client.pipelines.at(-1)[4].$facet.values[1].$limit, 101);
    const all = await s.values.list("sales", { field: "Company", limit: "1000" }, PLAIN);
    assert.equal(all.values.length, 121);
    assert.equal(all.complete, true);
    for (const limit of ["0", "1001", "-1", "1.5", "abc", "", "99999"]) await rejects(s.values.list("sales", { field: "Company", limit }, PLAIN), "VALIDATION_ERROR", "range");
    await rejects(s.values.list("sales", { field: "Company", after: "z".repeat(401) }, PLAIN), "VALIDATION_ERROR", "text");
  });

  test("the row cap: limited = rowCap, no counts, still pageable", async () => {
    const s = stack({ sales: many(), config: withConfig({ valuesRowCap: 50 }) });
    const out = await s.values.list("sales", { field: "Company", limit: "1000" }, PLAIN);
    assert.equal(out.complete, false);
    assert.deepEqual(out.limited, { reason: "rowCap", rowsScanned: 50, rowCap: 50 });
    assert.ok(out.values.every((v) => v.count === undefined));
    assert.ok(out.nextAfter !== null, "a capped list can be paged further");
    assert.equal(s.client.pipelines.at(-1)[1].$limit, 51);
  });

  test("the row cap never exceeds FABRIC_MAX_WINDOW_ROWS; maxTimeMS never exceeds queryTimeMs", async () => {
    const s = stack({ config: withConfig({ valuesRowCap: 90000, maxWindowRows: 1000, queryTimeMs: 1500 }) });
    await s.values.list("sales", { field: "Company" }, PLAIN);
    assert.equal(s.client.pipelines.at(-1)[1].$limit, 1001);
    assert.equal(lastAggregate(s, "FactSales").options.maxTimeMS, 1500);
  });
});

describe("Context (the other active filters)", () => {
  test("company narrows location; the field's own conditions are removed", async () => {
    const s = stack();
    const all = await s.values.list("sales", { field: "Location_Code" }, PLAIN);
    assert.deepEqual(names(all), ["LOC-A", "LOC-B", "LOC-B2"]);
    const filter = b64({ v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "Synthetic Co B" }, { field: "Location_Code", op: "eq", value: "LOC-B" }] });
    const narrowed = await s.values.list("sales", { field: "Location_Code", filter }, PLAIN);
    assert.deepEqual(names(narrowed), ["LOC-B", "LOC-B2"], "Location_Code = LOC-B is ignored for its own picker");
    assert.equal(narrowed.contextual, true);
    const companies = await s.values.list("sales", { field: "Company", filter }, PLAIN);
    assert.deepEqual(names(companies), ["Synthetic Co B"], "the location condition applies to the company picker");
  });

  test("stripField: AND drops the field's conditions, an OR mentioning it goes whole, nothing left → no context", () => {
    const model = { v: 1, op: "and", items: [{ field: "A", op: "eq", value: "1" }, { op: "or", items: [{ field: "A", op: "eq", value: "2" }, { field: "B", op: "eq", value: "3" }] }, { op: "and", items: [{ field: "A", op: "eq", value: "x" }, { field: "C", op: "eq", value: "4" }] }] };
    assert.deepEqual(stripField(model, "A"), { v: 1, op: "and", items: [{ op: "and", items: [{ field: "C", op: "eq", value: "4" }] }] });
    assert.equal(stripField({ v: 1, op: "or", items: [{ field: "A", op: "eq", value: "1" }, { field: "B", op: "eq", value: "1" }] }, "A"), null);
    assert.equal(stripField({ v: 1, op: "and", items: [{ field: "A", op: "eq", value: "1" }] }, "A"), null);
    assert.deepEqual(stripField(model, "Z"), model);
  });

  // B1's real model and compiler (the default adapter), once filter-compile.js exists.
  const hasCompiler = (() => { try { require.resolve("../src/fabric/filter-compile"); return true; } catch { return false; } })();
  test("with filter-model.js and filter-compile.js: company narrows location; invalid filters are 400 before any query", { skip: !hasCompiler && "filter-compile.js not written yet" }, async () => {
    const s = stack({ context: "default" });
    const filter = b64({ v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "Synthetic Co B" }, { field: "Location_Code", op: "eq", value: "LOC-B" }] });
    assert.deepEqual(names(await s.values.list("sales", { field: "Location_Code", filter }, PLAIN)), ["LOC-B", "LOC-B2"]);
    assert.deepEqual(names(await s.values.list("sales", { field: "Company", filter }, PLAIN)), ["Synthetic Co B"]);
    const before = s.client.queries().length;
    await rejects(s.values.list("sales", { field: "Company", filter: b64({ v: 1, op: "and", items: [{ field: "landed_cost", op: "eq", value: "1" }] }) }, SENSITIVE), "VALIDATION_ERROR", "unknownField");
    await rejects(s.values.list("sales", { field: "Company", filter: b64({ v: 1, op: "and", items: [{ field: "Company", op: "$where", value: "1" }] }) }, PLAIN), "VALIDATION_ERROR");
    await rejects(s.values.list("sales", { field: "Company", filter: b64({ v: 2, op: "and", items: [] }) }, PLAIN), "VALIDATION_ERROR", "version");
    assert.equal(s.client.queries().length, before);
  });

  test("filter text is checked before use; without a filter adapter it is refused", async () => {
    const s = stack();
    for (const filter of ["", "not base64!", "a".repeat(6001)]) await rejects(s.values.list("sales", { field: "Company", filter }, PLAIN), "VALIDATION_ERROR", "encoding");
    const none = stack({ context: null });
    await rejects(none.values.list("sales", { field: "Company", filter: b64({ v: 1, op: "and", items: [] }) }, PLAIN), "VALIDATION_ERROR", "unsupported");
  });
});

describe("Inventory values (small-collection mode)", () => {
  test("whole collection without a window, unhinted, complete with counts; context narrows company → location", async () => {
    const s = stack();
    const out = await s.values.list("inventory", { field: "Company" }, PLAIN);
    assert.equal(out.mode, "small");
    assert.equal(out.window.all, true);
    assert.deepEqual(names(out), ["SYNCO-C", "Synthetic Co A", "Synthetic Co B"]);
    assert.equal(out.values.reduce((n, v) => n + v.count, 0), 300);
    const call = lastAggregate(s, "FactInventory");
    assert.equal(call.options.hint, undefined);
    assert.equal(s.client.pipelines.at(-1)[0].$match && Object.keys(s.client.pipelines.at(-1)[0].$match).length, 0, "no window");
    const types = await s.values.list("inventory", { field: "Document_Type" }, PLAIN);
    assert.equal(types.values[0].blank, true, "' ' is the blank bucket");
    assert.ok(!names(types).includes(" "));
    const custom = stack({ inventory: [invRow({ Company: "K1", Location_Code: "L1" }), invRow({ Company: "K1", Location_Code: "L2" }), invRow({ Company: "K2", Location_Code: "L3" })] });
    const loc = await custom.values.list("inventory", { field: "Location_Code", filter: b64({ v: 1, op: "and", items: [{ field: "Company", op: "in", values: ["K1"] }] }) }, PLAIN);
    assert.deepEqual(names(loc), ["L1", "L2"]);
  });

  test("an explicit window applies in small mode (no 92-day limit)", async () => {
    const s = stack({ inventory: [invRow({ Company: "K1", Posting_Date: day("2024-01-01") }), invRow({ Company: "K2", Posting_Date: day("2026-01-05") })] });
    const out = await s.values.list("inventory", { field: "Company", dateFrom: "2025-01-01", dateTo: "2026-06-30" }, PLAIN);
    assert.deepEqual(names(out), ["K2"]);
  });

  test("non-string values keep their JSON form (Decimal128 as exact text, dates as ISO)", async () => {
    const { Decimal128 } = require("mongodb");
    const s = stack({ inventory: [invRow({ Company: Decimal128.fromString("12.50") }), invRow({ Company: day("2026-01-02") }), invRow({ Company: "K" })] });
    const out = await s.values.list("inventory", { field: "Company" }, PLAIN);
    assert.deepEqual(names(out), ["12.50", "K", "2026-01-02T00:00:00.000Z"], "BSON order: numbers, strings, dates");
  });
});

describe("Cache", () => {
  test("keyed by field, q, window, context and access level; expires", async () => {
    let t = 0;
    const s = stack({ cacheMs: 60000 });
    s.values.clock = () => t;
    await s.values.list("sales", { field: "Company" }, PLAIN);
    const n = s.client.queries("FactSales").length;
    const again = await s.values.list("sales", { field: "Company" }, PLAIN);
    assert.equal(s.client.queries("FactSales").length, n, "served from the cache");
    assert.equal(again.access.sensitive, false);
    await s.values.list("sales", { field: "Company" }, SENSITIVE);
    await s.values.list("sales", { field: "Company", q: "a" }, PLAIN);
    await s.values.list("sales", { field: "Location_Code" }, PLAIN);
    // + 1: q is selective, so its window is counted first (L1).
    assert.equal(s.client.queries("FactSales").length, n + 4, "a different access level, q or field is a different entry");
    t = 60001;
    await s.values.list("sales", { field: "Company" }, PLAIN);
    assert.equal(s.client.queries("FactSales").length, n + 5, "expired");
  });

  test("the cache is bounded by size too (L2): least recently used answers go first; one over the budget isn't kept", async () => {
    const s = stack({ cacheMs: 60000 });
    const probe = await s.values.list("sales", { field: "Company" }, PLAIN);
    const one = s.values.cachedBytes;
    assert.ok(one > 0 && s.values.cache.size === 1 && probe.values.length);
    // Room for about two answers of this size.
    const t = stack({ cacheMs: 60000 });
    t.values.cacheBytes = Math.floor(one * 2.5);
    await t.values.list("sales", { field: "Company" }, PLAIN);               // A
    await t.values.list("sales", { field: "Company" }, SENSITIVE);           // B
    await t.values.list("sales", { field: "Company" }, PLAIN);               // A again: now most recently used
    await t.values.list("sales", { field: "Company", limit: "99" }, PLAIN);  // C evicts B, the least recently used
    const keys = [...t.values.cache.keys()].map((k) => JSON.parse(k));
    assert.equal(keys.length, 2);
    assert.ok(keys.some((k) => k[4] === 100 && k[8] === false), "A kept");
    assert.ok(!keys.some((k) => k[8] === true), "B evicted");
    assert.ok(t.values.cachedBytes <= t.values.cacheBytes);
    const u = stack({ cacheMs: 60000 });
    u.values.cacheBytes = 10;
    await u.values.list("sales", { field: "Company" }, PLAIN);
    assert.deepEqual([u.values.cache.size, u.values.cachedBytes], [0, 0], "larger than the whole budget: not cached");
  });
});

describe("Scan bound (L1)", () => {
  test("a selective request counts the window first and refuses one over FABRIC_MAX_WINDOW_ROWS; an unselective one doesn't count", async () => {
    // The default window holds 8 synthetic rows; a cap of 5 makes it too large.
    const s = stack({ config: withConfig({ maxWindowRows: 5 }) });
    const before = s.client.calls.filter((c) => c.op === "countDocuments").length;
    const plain = await s.values.list("sales", { field: "Company" }, PLAIN);
    assert.equal(plain.limited.reason, "rowCap", "every row matches: the row cap is the scan bound, no count");
    assert.equal(s.client.calls.filter((c) => c.op === "countDocuments").length, before);
    for (const extra of [{ q: "Synthetic" }, { after: "A" }, { filter: b64({ v: 1, op: "and", items: [{ field: "Location_Code", op: "eq", value: "LOC-A" }] }) }]) {
      await rejects(s.values.list("sales", { field: "Company", ...extra }, PLAIN), "FABRIC_RANGE_TOO_LARGE");
    }
    const counts = s.client.calls.filter((c) => c.op === "countDocuments");
    assert.equal(counts.length, before + 3);
    assert.ok(counts.every((c) => c.options.hint && c.options.limit === 6), "hinted, counted only up to the cap + 1");
    // Under the cap: answered as before.
    const ok = stack({ config: withConfig({ maxWindowRows: 50 }) });
    const out = await ok.values.list("sales", { field: "Company", q: "Synthetic" }, PLAIN);
    assert.ok(names(out).includes("Synthetic Co A"));
  });
});
