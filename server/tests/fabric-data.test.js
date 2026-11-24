// Fabric Data service, repository, indexes and connection on an in-memory FactSales stand-in (tests/support/fabric-fake.js).
// Synthetic data only: invented companies, invoice numbers and customers.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { createFabricData } = require("../src/fabric");
const { privilegesAreReadOnly } = require("../src/fabric/connection");
const { detectCapabilities } = require("../src/fabric/indexes");
const { assertSafePipeline } = require("../src/fabric/repository");
const v = require("../src/fabric/validation");
const { loadConfig } = require("../src/config");
const { entraEnv } = require("./helpers");
const { FabricFakeClient, row, serverError, DEFAULT_INDEXES, dec } = require("./support/fabric-fake");

const baseConfig = loadConfig(entraEnv({ JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb" })).fabricData;
const withConfig = (overrides) => Object.defineProperty({ ...baseConfig, ...overrides }, "uri", { value: baseConfig.uri });
const day = (d) => new Date(`2026-03-${String(d).padStart(2, "0")}T08:00:00Z`);

// Invoice 1001 exists in two companies; 2002 has no company; one row lies outside the window.
function dataset() {
  return [
    row({ Company: "ALPHA", invoice_id: "1001", Line_No: 10000, invoice_date: day(10), invoice_due_date: new Date("2026-04-09T00:00:00Z"), customer_id: "CUST0001", customer_name: "Example Customer One", invoice_item_quantity: 2, invoice_item_amount: 10, invoice_item_quantity_sales: dec("2"), invoice_item_amount_sales: dec("10.00"), Unit_Price: dec("5.00"), uom_code: "PCS", landed_cost: "2.5", invoice_total_amount: 60, "Custom.2": "Territory North", Order_No: "ORD-1", is_invoice_cancelled: false, is_invoice_closed: true, sales_type: "Type A", join_key_Company_Invoice: "ALPHA|1001", upstream_new_field: "never returned" }),
    row({ Company: "ALPHA", invoice_id: "1001", Line_No: 20000, invoice_date: day(10), customer_id: "CUST0001", customer_name: "Example Customer One", invoice_item_quantity: 4, invoice_item_amount: 20, landed_cost: "n/a", invoice_total_amount: 60, sales_type: "Type B", sales_data_source: "Source Two" }),
    row({ Company: "ALPHA", invoice_id: "1001", Line_No: null, invoice_date: day(10), customer_id: "CUST0001", customer_name: "Example Customer One", invoice_item_quantity: 1, invoice_item_amount: 30, landed_cost: null, invoice_total_amount: null, Order_No: "ORD-LATER" }),
    row({ Company: "BETA", invoice_id: "1001", Line_No: null, invoice_date: day(11), customer_id: "CUST0002", customer_name: "Example Customer Two", invoice_item_quantity: 3, invoice_item_amount: 5, landed_cost: "" }),
    row({ Company: null, invoice_id: "2002", Line_No: null, invoice_date: day(12), customer_id: null, customer_name: "Example Customer Three", invoice_item_quantity: 1, invoice_item_amount: 7 }),
    row({ Company: "ALPHA", invoice_id: "0999", invoice_date: new Date("2026-01-02T00:00:00Z"), invoice_item_amount: 999 })
  ];
}
function stack({ docs = dataset(), config = baseConfig, ...fake } = {}) {
  const client = new FabricFakeClient({ docs, ...fake });
  let created = 0;
  const logger = { warnings: [], errors: [], warn(m) { this.warnings.push(m); }, error(m) { this.errors.push(m); } };
  const fabric = createFabricData({ config, logger, createClient: () => { created += 1; return client; } });
  return { ...fabric, client, logger, created: () => created };
}
const WINDOW = { dateFrom: "2026-03-01", dateTo: "2026-03-31" };
const list = (s, query = {}, access = { cost: false }) => s.service.listInvoices(v.invoiceListQuery({ ...WINDOW, ...query }), access);
const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code);

describe("Invoice list", () => {
  test("groups rows by Company + invoice_id: duplicate invoice numbers in two companies are separate invoices", async () => {
    const s = stack();
    const out = await list(s);
    assert.deepEqual(out.items.map((i) => [i.company, i.invoiceNo]), [[null, "2002"], ["BETA", "1001"], ["ALPHA", "1001"]], "invoiceDate desc");
    assert.deepEqual(out.total, { invoices: 3, rows: 5 });
    assert.deepEqual(out.window, WINDOW);
    assert.deepEqual(out.companies, [{ company: "ALPHA", rows: 3 }, { company: null, rows: 1 }, { company: "BETA", rows: 1 }]);
    assert.deepEqual(out.pagination, { limit: 50, hasMore: false, nextCursor: null });
    const alpha = out.items[2];
    assert.equal(alpha.rows, 3);
    assert.equal(alpha.lineDetailRows, 2, "rows without Line_No have no line detail");
    assert.equal(alpha.amount, 60);
    assert.equal(alpha.quantity, 7);
    assert.equal(alpha.headerTotal, 60, "invoice_total_amount repeats on every row: never summed");
    assert.deepEqual(alpha.sources, ["Source One", "Source Two"]);
    assert.equal(alpha.invoiceDate, "2026-03-10T08:00:00.000Z");
    assert.equal(alpha.dueDate, "2026-04-09T00:00:00.000Z");
    assert.equal(alpha.cancelled, false);
    assert.equal(alpha.closed, true);
    assert.equal(out.items[0].headerTotal, null, "null when no row has it");
  });

  test("cost is absent (and never computed) for a non-cost reader, present for a cost reader", async () => {
    const s = stack();
    const plain = await list(s);
    assert.ok(plain.items.every((i) => !("cost" in i)));
    assert.deepEqual(plain.access, { cost: false });
    const pipeline = JSON.stringify(s.client.pipelines.at(-1));
    assert.ok(!pipeline.includes("landed_cost") && !pipeline.includes("$convert"), "cost is not even in the pipeline");
    const costed = await list(s, {}, { cost: true });
    const alpha = costed.items.find((i) => i.company === "ALPHA");
    // Only the row with a convertible landed_cost counts: 2 × 2.5 = 5 cost on 10 amount.
    // (Decimal128 strings: MongoDB itself would write "5.0"; the stand-in's decimal arithmetic writes "5".)
    assert.deepEqual(alpha.cost, { landedCost: "5", profit: "5", marginPct: 50, rowsWithCost: 1 });
    const beta = costed.items.find((i) => i.company === "BETA");
    assert.deepEqual(beta.cost, { landedCost: null, profit: null, marginPct: null, rowsWithCost: 0 }, "an empty landed_cost doesn't convert");
    assert.deepEqual(costed.access, { cost: true });
  });

  test("filters: company (exact, ~ = none) and q (invoice prefix, customer id prefix, name or document substring)", async () => {
    const s = stack();
    assert.deepEqual((await list(s, { company: "BETA" })).items.map((i) => i.company), ["BETA"]);
    assert.deepEqual((await list(s, { company: "~" })).items.map((i) => i.invoiceNo), ["2002"]);
    assert.deepEqual((await list(s, { company: "alpha" })).items, [], "company is exact");
    assert.deepEqual((await list(s, { q: "100" })).items.map((i) => i.company).sort(), ["ALPHA", "BETA"]);
    assert.deepEqual((await list(s, { q: "customer three" })).items.map((i) => i.invoiceNo), ["2002"]);
    assert.deepEqual((await list(s, { q: "CUST0002" })).items.map((i) => i.company), ["BETA"]);
    assert.deepEqual((await list(s, { q: "cust0002" })).items, [], "customer id prefix is case-sensitive");
    assert.deepEqual((await list(s, { q: ".*" })).items, [], "regular expression characters are escaped");
    assert.equal((await list(s, { dateFrom: "2026-03-11", dateTo: "2026-03-11" })).items.length, 1, "UTC days: from 00:00Z to the next day's 00:00Z");
  });

  test("sorting and keyset pages walk every invoice exactly once", async () => {
    const s = stack();
    for (const sort of ["invoiceDate", "invoiceNo", "customerName", "amount"]) for (const dir of ["asc", "desc"]) {
      const seen = [];
      let cursor;
      for (let i = 0; i < 5; i += 1) {
        const page = await list(s, { sort, dir, limit: "1", ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((x) => `${x.company}/${x.invoiceNo}`));
        if (!page.pagination.hasMore) break;
        cursor = page.pagination.nextCursor;
      }
      assert.equal(new Set(seen).size, 3, `${sort} ${dir}: ${seen}`);
      assert.equal(seen.length, 3, `${sort} ${dir}`);
    }
    const byAmount = await list(s, { sort: "amount", dir: "asc" });
    assert.deepEqual(byAmount.items.map((i) => i.amount), [5, 7, 60]);
  });

  test("a window above FABRIC_MAX_WINDOW_ROWS is 422 with the row count; only the bounded count runs", async () => {
    const s = stack({ config: withConfig({ maxWindowRows: 2 }) });
    await assert.rejects(list(s), (e) => e.status === 422 && e.code === "FABRIC_RANGE_TOO_LARGE" && e.details.max === 2 && e.details.rows === 3);
    assert.deepEqual(s.client.queries().map((q) => q.op), ["countDocuments"]);
    assert.equal(s.client.queries()[0].options.limit, 3, "the count stops at max + 1");
  });

  test("every query carries maxTimeMS, a hint and a limit, and every pipeline has an inclusion $project", async () => {
    const s = stack();
    await list(s, { q: "1" }, { cost: true });
    await s.service.getInvoice("ALPHA", "1001", { cost: true });
    await s.service.listInvoiceLines("ALPHA", "1001", v.invoiceLinesQuery({}, { company: "ALPHA", invoiceNo: "1001" }), { cost: true });
    await s.service.listRecords("sales", { ...WINDOW, q: "100" }, { datasets: new Set(["sales"]), sensitive: true });
    const queries = s.client.queries();
    assert.ok(queries.length >= 5);
    for (const q of queries) { assert.equal(q.options.maxTimeMS, baseConfig.queryTimeMs, q.op); assert.ok(q.options.hint, q.op); }
    for (const p of s.client.pipelines) { assert.ok(p.some((st) => st.$limit), "limit"); assert.ok(p.some((st) => st.$project), "projection"); }
  });
});

describe("Invoice detail, lines and one line", () => {
  test("detail: header = first non-null value in line order, distinct sources and sales types, summary totals; Custom.2 as territory for sensitive readers only", async () => {
    const s = stack();
    const { invoice, access } = await s.service.getInvoice("ALPHA", "1001", { cost: false });
    assert.deepEqual(access, { cost: false });
    assert.equal(invoice.company, "ALPHA");
    assert.equal(invoice.customerName, "Example Customer One");
    assert.equal(invoice.header.Order_No, "ORD-LATER", "Line_No null sorts first, so its value comes first");
    // Custom.2 (territory) is restricted until its meaning is confirmed: absent, and never projected, for other readers.
    assert.equal("territory" in invoice.header, false);
    assert.equal(JSON.stringify(s.client.calls?.filter?.((c) => c.op === "aggregate").at(-1) ?? "").includes("Custom.2"), false);
    assert.equal((await s.service.getInvoice("ALPHA", "1001", { cost: true })).invoice.header.territory, "Territory North");
    assert.deepEqual(invoice.header.sales_data_source, ["Source One", "Source Two"]);
    assert.deepEqual(invoice.header.sales_type, ["Type A", "Type B"]);
    assert.equal(invoice.header.is_invoice_closed, true);
    assert.deepEqual(invoice.summary, { rows: 3, lineDetailRows: 2, amount: 60, quantity: 7, headerTotal: 60, sources: ["Source One", "Source Two"], firstDate: "2026-03-10T08:00:00.000Z", lastDate: "2026-03-10T08:00:00.000Z" });
    assert.equal("cost" in invoice, false);
    const costed = await s.service.getInvoice("ALPHA", "1001", { cost: true });
    assert.deepEqual(costed.invoice.cost, { landedCost: "5", profit: "5", marginPct: 50, rowsWithCost: 1 });
    // The same number in another company, and the null company.
    assert.equal((await s.service.getInvoice("BETA", "1001", {})).invoice.summary.amount, 5);
    assert.equal((await s.service.getInvoice(null, "2002", {})).invoice.summary.amount, 7);
    await rejects(s.service.getInvoice("GAMMA", "1001", {}), "FABRIC_INVOICE_NOT_FOUND");
    await rejects(s.service.getInvoice("ALPHA", "1001 ", {}), "FABRIC_INVOICE_NOT_FOUND"); // never trimmed
  });

  test("lines: Line_No ascending with nulls first, then _id; Decimal128 as exact strings; cost only for cost readers; pages", async () => {
    const s = stack();
    const key = { company: "ALPHA", invoiceNo: "1001" };
    const out = await s.service.listInvoiceLines("ALPHA", "1001", v.invoiceLinesQuery({}, key), { cost: false });
    assert.deepEqual(out.items.map((l) => l.lineNo), [null, 10000, 20000]);
    const first = out.items[1];
    assert.deepEqual(first, { id: first.id, lineNo: 10000, hasLineDetail: true, itemId: null, itemName: null, description2: null, quantity: 2, amount: 10, quantitySales: "2", amountSales: "10.00", unitPrice: "5.00", uom: "PCS", salesDataSource: "Source One", salesType: "Type A" });
    assert.match(first.id, /^[0-9a-f]{24}$/);
    assert.equal(out.items[0].hasLineDetail, false);
    const costed = await s.service.listInvoiceLines("ALPHA", "1001", v.invoiceLinesQuery({}, key), { cost: true });
    assert.deepEqual(costed.items.map((l) => l.cost), [
      { landedCostPerUnit: null, landedCost: null, profit: null, marginPct: null },
      { landedCostPerUnit: "2.5", landedCost: "5", profit: "5", marginPct: 50 },
      { landedCostPerUnit: null, landedCost: null, profit: null, marginPct: null }
    ]);
    const p1 = await s.service.listInvoiceLines("ALPHA", "1001", v.invoiceLinesQuery({ limit: "2" }, key), {});
    assert.equal(p1.pagination.hasMore, true);
    const p2 = await s.service.listInvoiceLines("ALPHA", "1001", v.invoiceLinesQuery({ limit: "2", cursor: p1.pagination.nextCursor }, key), {});
    assert.deepEqual([...p1.items, ...p2.items].map((l) => l.lineNo), [null, 10000, 20000]);
    assert.equal(p2.pagination.hasMore, false);
    await rejects(s.service.listInvoiceLines("GAMMA", "1001", v.invoiceLinesQuery({}, { company: "GAMMA", invoiceNo: "1001" }), {}), "FABRIC_INVOICE_NOT_FOUND");
    assert.throws(() => v.invoiceLinesQuery({ cursor: p1.pagination.nextCursor }, { company: "BETA", invoiceNo: "1001" }), /different list/, "a cursor is bound to its invoice");
  });

  test("one line: the 85 verified fields in order (restricted fields only for sensitive readers), keys, and nothing upstream added", async () => {
    const docs = dataset();
    const s = stack({ docs });
    const id = docs[0]._id;
    const { line } = await s.service.getLine("ALPHA", "1001", id, { cost: false });
    assert.equal(line.id, id.toHexString());
    // 85 minus landed_cost, Text, Custom, custom_1 and Custom.2.
    assert.equal(line.fields.length, 80);
    for (const restricted of ["landed_cost", "Text", "Custom", "custom_1", "Custom.2"]) assert.equal(line.fields.some((f) => f.name === restricted), false, restricted);
    assert.equal(line.fields[0].name, "invoice_id");
    assert.equal(line.fields.at(-1).name, "Ref");
    const byName = Object.fromEntries(line.fields.map((f) => [f.name, f]));
    const sensitiveLine = Object.fromEntries((await s.service.getLine("ALPHA", "1001", id, { cost: true })).line.fields.map((f) => [f.name, f]));
    assert.deepEqual(sensitiveLine["Custom.2"], { name: "Custom.2", value: "Territory North", type: "string" });
    assert.deepEqual(byName.Unit_Price, { name: "Unit_Price", value: "5.00", type: "decimal" });
    assert.deepEqual(byName.invoice_date, { name: "invoice_date", value: "2026-03-10T08:00:00.000Z", type: "date" });
    assert.deepEqual(byName.Line_No, { name: "Line_No", value: 10000, type: "number" });
    assert.deepEqual(byName.is_invoice_closed, { name: "is_invoice_closed", value: true, type: "bool" });
    assert.deepEqual(byName.Ship_to_Code, { name: "Ship_to_Code", value: null, type: "null" });
    assert.equal(JSON.stringify(line).includes("never returned"), false);
    assert.equal(JSON.stringify(line).includes("upstream_new_field"), false);
    assert.equal(line.keys.join_key_Company_Invoice, "ALPHA|1001");
    assert.deepEqual(Object.keys(line.keys), ["join_key_Company_Invoice", "join_key_Invoice_CustLedger", "join_key_bc_company_item_uom", "join_key_bc_valueEntries_Sales_Invoice", "join_key_company_salesperson_code", "connect_to_rmr", "connect_to_salescreditmemo", "Ref"]);
    const costed = await s.service.getLine("ALPHA", "1001", id, { cost: true });
    assert.equal(costed.line.fields.length, 85);
    assert.deepEqual(costed.line.fields.find((f) => f.name === "landed_cost"), { name: "landed_cost", value: "2.5", type: "string" });
    // It must belong to that invoice; a reloaded line is gone.
    await rejects(s.service.getLine("BETA", "1001", id, {}), "FABRIC_LINE_NOT_FOUND");
    await rejects(s.service.getLine("ALPHA", "1001", v.lineId("0123456789abcdef01234567"), {}), "FABRIC_LINE_NOT_FOUND");
    assert.equal(require("../src/fabric/errors").MESSAGES.FABRIC_LINE_NOT_FOUND, "This line is no longer in the source (the data may have been refreshed). Reload the invoice.");
  });
});

describe("Sales records (/sales/records, replacing /sales-lines)", () => {
  const BOTH = { datasets: new Set(["sales", "inventory"]), sensitive: false };
  const records = (s, query = {}, access = BOTH) => s.service.listRecords("sales", { ...WINDOW, ...query }, access);

  test("stream in index order with a 4-key keyset; default columns; no totals; landed_cost only for sensitive readers", async () => {
    const s = stack();
    const out = await records(s);
    assert.equal("total" in out, false);
    assert.equal(out.mode, "indexed");
    assert.equal(out.items.length, 5);
    assert.deepEqual(out.fields, ["invoice_date", "Company", "invoice_id", "customer_name", "invoice_item_name", "invoice_item_quantity", "invoice_item_amount", "sales_data_source"]);
    assert.deepEqual(out.items.map((i) => i.values.invoice_date.slice(0, 10)), ["2026-03-12", "2026-03-11", "2026-03-10", "2026-03-10", "2026-03-10"]);
    assert.deepEqual(Object.keys(out.items[0]), ["id", "values"]);
    assert.deepEqual(out.window, { field: "invoice_date", dateFrom: "2026-03-01", dateTo: "2026-03-31", defaulted: false });
    for (const dir of ["desc", "asc"]) {
      const seen = [];
      let cursor;
      for (let i = 0; i < 10; i += 1) {
        const page = await records(s, { dir, limit: "2", ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((x) => x.id));
        if (!page.pagination.hasMore) break;
        cursor = page.pagination.nextCursor;
      }
      assert.equal(new Set(seen).size, 5, dir);
      assert.equal(seen.length, 5, dir);
    }
    const sorted = s.client.pipelines.at(-1).find((st) => st.$sort).$sort;
    assert.deepEqual(sorted, { invoice_date: 1, Company: -1, invoice_id: -1, _id: -1 }, "asc is the exact reverse of the index");
    assert.equal((await records(s, { q: "100" })).items.length, 4);
    await assert.rejects(records(s, { fields: "invoice_id,landed_cost" }), (e) => e.status === 400 && e.message === 'Unknown field "landed_cost".');
    const costed = await records(s, { fields: "invoice_id,landed_cost" }, { ...BOTH, sensitive: true });
    assert.deepEqual(costed.items.find((i) => i.values.invoice_id === "1001" && i.values.landed_cost === "2.5").values, { invoice_id: "1001", landed_cost: "2.5" });
    const plainText = JSON.stringify(s.client.pipelines.filter((p) => p.some((st) => st.$project?.invoice_id)).slice(0, 3));
    assert.equal(plainText.includes("landed_cost"), false, "a non-sensitive request never projects it");
  });

  test("needs the exact date index (or its reverse) above FABRIC_UNINDEXED_SCAN_MAX; a prefix index allows the invoice list only", async () => {
    const indexes = [DEFAULT_INDEXES[0], { v: 2, key: { invoice_date: -1, Company: 1, invoice_id: 1 }, name: "date3" }, DEFAULT_INDEXES[2]];
    const s = stack({ indexes, config: withConfig({ unindexedScanMax: 0 }) });
    assert.equal((await list(s)).items.length, 3);
    const before = s.client.queries().length;
    await assert.rejects(records(s), (e) => e.status === 503 && e.code === "FABRIC_INDEX_REQUIRED" && e.details.missingIndexes[0].name === "fabric_invoice_date");
    assert.equal(s.client.queries().length, before, "no query is issued without the index");
    const reverse = stack({ indexes: [DEFAULT_INDEXES[0], { v: 2, key: { invoice_date: 1, Company: -1, invoice_id: -1, _id: -1 }, name: "rev" }], config: withConfig({ unindexedScanMax: 0 }) });
    assert.equal((await records(reverse)).items.length, 5);
  });
});

describe("Limited mode, source problems and the connection", () => {
  test("only the _id index, above FABRIC_UNINDEXED_SCAN_MAX: every data route is 503 FABRIC_INDEX_REQUIRED and no query is sent; status lists what's missing", async () => {
    const s = stack({ indexes: [DEFAULT_INDEXES[0]], config: withConfig({ unindexedScanMax: 5, invoiceViews: true }) }); // 6 rows
    const all = { datasets: new Set(["sales", "inventory"]), sensitive: false };
    await assert.rejects(list(s), (e) => e.code === "FABRIC_INDEX_REQUIRED" && e.details.missingIndexes.length === 1 && e.details.missingIndexes[0].keys.invoice_date === -1);
    await rejects(s.service.getInvoice("ALPHA", "1001", {}), "FABRIC_INDEX_REQUIRED");
    await rejects(s.service.listInvoiceLines("ALPHA", "1001", v.invoiceLinesQuery({}, { company: "ALPHA", invoiceNo: "1001" }), {}), "FABRIC_INDEX_REQUIRED");
    await rejects(s.service.listRecords("sales", WINDOW, all), "FABRIC_INDEX_REQUIRED");
    assert.deepEqual(s.client.queries(), []);
    const status = await s.service.status(all);
    assert.equal(status.available, true, "the (empty) inventory is in small mode");
    assert.deepEqual([status.datasets.sales.available, status.datasets.sales.mode, status.datasets.sales.reason, status.datasets.sales.estimate], [false, "unavailable", "FABRIC_INDEX_REQUIRED", 6]);
    assert.deepEqual(status.datasets.sales.missingIndexes.map((m) => [m.name, m.neededFor]), [["fabric_invoice_date", ["sort:date"]]]);
    assert.deepEqual(status.invoiceViews.capabilities, { invoiceList: false, invoiceDetail: false });
    assert.deepEqual(status.invoiceViews.missingIndexes.map((m) => [m.name, m.neededFor]), [["fabric_invoice_date", ["invoiceList"]], ["fabric_invoice_detail", ["invoiceDetail"]]]);
    assert.deepEqual(status.limits, { defaultDays: 30, maxDays: 92, maxWindowRows: 50000, recordPageMax: 200, recordPageDefault: 100, unindexedScanMax: 5, invoicePageMax: 100, linePageMax: 200 });
    // At or under the threshold the same collection is readable without an index (small-collection mode).
    const small = stack({ indexes: [DEFAULT_INDEXES[0]], config: withConfig({ unindexedScanMax: 6 }) });
    const out = await small.service.listRecords("sales", WINDOW, all);
    assert.deepEqual([out.mode, out.items.length], ["small", 5]);
    assert.equal("invoiceViews" in (await small.service.status(all)), false, "invoice views are off by default");
  });

  test("index capabilities are cached and re-read after a hinted query fails because its index is gone", async () => {
    const s = stack();
    await list(s);
    await list(s);
    assert.equal(s.client.calls.filter((c) => c.op === "listIndexes").length, 1, "cached");
    s.client.store.indexes = [DEFAULT_INDEXES[0], DEFAULT_INDEXES[2]]; // dropped upstream
    await rejects(list(s), "FABRIC_INDEX_REQUIRED");
    await rejects(list(s), "FABRIC_INDEX_REQUIRED");
    assert.equal(s.client.calls.filter((c) => c.op === "listIndexes").length, 2, "invalidated once, then cached again");
  });

  test("FactSales missing (mid-reload): FABRIC_SOURCE_MISSING; status says so with 200-style data", async () => {
    const s = stack({ missing: true });
    await rejects(list(s), "FABRIC_SOURCE_MISSING");
    await rejects(s.service.listRecords("inventory", {}, { datasets: new Set(["inventory"]), sensitive: false }), "FABRIC_SOURCE_MISSING");
    const status = await s.service.status({ datasets: new Set(["sales", "inventory"]), sensitive: true });
    assert.deepEqual([status.available, status.reason, status.access.sensitive], [false, "FABRIC_SOURCE_MISSING", true]);
    assert.deepEqual([status.datasets.sales.reason, status.datasets.inventory.reason], ["FABRIC_SOURCE_MISSING", "FABRIC_SOURCE_MISSING"]);
  });

  test("timeouts are FABRIC_TIMEOUT; other driver errors are FABRIC_UNAVAILABLE, logged by code only", async () => {
    const s = stack();
    await list(s);
    s.client.failNext(serverError(50, "MaxTimeMSExpired", "operation exceeded time limit"));
    await assert.rejects(list(s), (e) => e.status === 503 && e.code === "FABRIC_TIMEOUT" && /Narrow the date range or add a company filter/.test(e.message));
    s.client.failNext(serverError(8000, "AtlasError", "secret detail ALPHA 1001"));
    await rejects(list(s), "FABRIC_UNAVAILABLE");
    assert.ok(s.logger.warnings.some((w) => w.includes("8000")));
    assert.ok(s.logger.warnings.every((w) => !w.includes("ALPHA") && !w.includes("secret")));
  });

  test("the client is created lazily (first use), with read-only options, and only FactSales is ever opened", async () => {
    let options = null;
    const client = new FabricFakeClient({ docs: dataset() });
    const fabric = createFabricData({ config: baseConfig, logger: { warn() {}, error() {} }, createClient: (uri, o) => { options = o; return client; } });
    assert.equal(options, null, "nothing connects until the first Fabric request");
    await fabric.service.listInvoices(v.invoiceListQuery(WINDOW), {});
    assert.equal(options.readPreference, "secondaryPreferred");
    assert.equal(options.retryWrites, false);
    assert.equal(options.appName, "jarc-fabric");
    assert.equal(options.serverSelectionTimeoutMS, 5000);
    assert.equal(options.maxPoolSize, 5);
    assert.equal(options.monitorCommands, undefined, "no shared command monitor");
    assert.deepEqual([...new Set(client.collectionNames)], ["FactSales"]);
    await fabric.service.status({ datasets: new Set(["sales", "inventory"]), sensitive: false });
    assert.deepEqual([...new Set(client.collectionNames)].sort(), ["FactInventory", "FactSales"], "only the two dataset collections, ever");
    assert.deepEqual(client.commands, ["connectionStatus"]);
    assert.equal(client.listCollectionsCalls, 0);
    await fabric.close();
    assert.equal(client.closeCalls, 1);
  });

  test("connection failure: FABRIC_UNAVAILABLE, fail fast for a few seconds, and status still answers", async () => {
    const s = stack({ connectError: Object.assign(new Error("getaddrinfo ENOTFOUND fabric-cluster.example.invalid"), { name: "MongoServerSelectionError" }) });
    await rejects(list(s), "FABRIC_UNAVAILABLE");
    await rejects(list(s), "FABRIC_UNAVAILABLE");
    assert.equal(s.client.connectCalls, 1, "the second request didn't wait on another attempt");
    assert.ok(s.logger.warnings.every((w) => !w.includes("example.invalid")));
    const status = await s.service.status({ datasets: new Set(["sales", "inventory"]), sensitive: false });
    assert.deepEqual([status.available, status.reason, status.datasets.sales.estimate, status.datasets.inventory.reason], [false, "FABRIC_UNAVAILABLE", null, "FABRIC_UNAVAILABLE"]);
  });

  test("privilege self-check: any write action or another role → FABRIC_UNSAFE_CREDENTIALS for every call, client closed", async () => {
    const db = "FabricTestDb";
    const readOnly = { authenticatedUserRoles: [{ role: "read", db }], authenticatedUserPrivileges: [{ resource: { db, collection: "" }, actions: ["find", "listIndexes"] }] };
    assert.equal(privilegesAreReadOnly({ authInfo: readOnly }, db), true);
    for (const authInfo of [
      { ...readOnly, authenticatedUserPrivileges: [{ resource: { db, collection: "" }, actions: ["find", "insert"] }] },
      { ...readOnly, authenticatedUserRoles: [{ role: "readWrite", db }] },
      { ...readOnly, authenticatedUserRoles: [{ role: "read", db }, { role: "read", db: "jarc_database" }] },
      { ...readOnly, authenticatedUserRoles: [{ role: "read", db: "other" }] },
      { ...readOnly, authenticatedUserRoles: [] },
      {}
    ]) assert.equal(privilegesAreReadOnly({ authInfo }, db), false, JSON.stringify(authInfo));
    const s = stack({ authInfo: { ...readOnly, authenticatedUserPrivileges: [{ resource: { db, collection: "" }, actions: ["find", "update"] }] } });
    await rejects(list(s), "FABRIC_UNSAFE_CREDENTIALS");
    await rejects(s.service.getInvoice("ALPHA", "1001", {}), "FABRIC_UNSAFE_CREDENTIALS");
    assert.equal(s.client.connectCalls, 1, "never retried");
    assert.equal(s.client.closeCalls, 1, "closed at once");
    assert.deepEqual(s.client.queries(), []);
    const status = await s.service.status({ datasets: new Set(["inventory"]), sensitive: false });
    assert.deepEqual([status.available, status.reason], [false, "FABRIC_UNSAFE_CREDENTIALS"]);
  });
});

describe("Building blocks", () => {
  test("the repository refuses write, code and cross-collection stages anywhere in a pipeline", () => {
    for (const stage of [{ $out: "x" }, { $merge: { into: "x" } }, { $lookup: { from: "x" } }, { $unionWith: "x" }, { $addFields: { a: { $function: {} } } }, { $facet: { a: [{ $merge: "x" }] } }]) {
      assert.throws(() => assertSafePipeline([{ $match: {} }, { $limit: 1 }, { $project: { a: 1 } }, stage]), /never allowed/);
    }
    assert.throws(() => assertSafePipeline([{ $limit: 1 }, { $project: { a: 1 } }]), /start with \$match/);
    assert.throws(() => assertSafePipeline([{ $match: {} }, { $project: { a: 1 } }]), /\$limit/);
    const { FabricRepository } = require("../src/fabric/repository");
    const names = Object.getOwnPropertyNames(FabricRepository.prototype).join(" ");
    assert.doesNotMatch(names, /insert|update|delete|replace|drop|createIndex|bulk|write/i);
  });

  test("isolation: no write calls anywhere in src/fabric; never required from domain/ or workers/; never JARC's connection", () => {
    const fs = require("fs"), path = require("path");
    const src = path.join(__dirname, "..", "src");
    const read = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".js")).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
    for (const [file, text] of read(path.join(src, "fabric"))) {
      assert.doesNotMatch(text, /\.(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate|findOneAndDelete|findOneAndReplace|bulkWrite|createIndex|createIndexes|dropIndex|drop|createCollection|renameCollection)\(/, file);
      assert.doesNotMatch(text, /require\(["']\.\.\/db\/connection["']\)|require\(["']\.\.\/monitoring\/monitor["']\)/, file);
    }
    for (const dir of ["domain", "workers"]) if (fs.existsSync(path.join(src, dir))) for (const [file, text] of read(path.join(src, dir))) assert.doesNotMatch(text, /fabric/i, `${dir}/${file}`);
  });

  test("index detection ignores partial, sparse, text and collated indexes", () => {
    const caps = detectCapabilities([
      { key: { invoice_date: -1, Company: 1, invoice_id: 1, _id: 1 }, name: "partial", partialFilterExpression: { Company: "ALPHA" } },
      { key: { Company: 1, invoice_id: 1 }, name: "sparse", sparse: true },
      { key: { invoice_date: "text" }, name: "text" },
      { key: { Company: 1, invoice_id: 1, Line_No: 1 }, name: "ci", collation: { locale: "en", strength: 2 } }
    ]);
    assert.deepEqual([caps.invoiceList, caps.invoiceDetail], [false, false]);
  });

  test("validation: parameters, dates, ranges, limits, cursors and path segments", () => {
    const bad = (fn, pattern) => assert.throws(fn, (e) => e.status === 400 && e.code === "VALIDATION_ERROR" && (!pattern || pattern.test(e.message)));
    const now = new Date("2026-03-20T15:00:00Z");
    assert.deepEqual(v.invoiceListQuery({}, now).window.dateFrom, "2026-02-19", "default: the last 30 UTC days ending today");
    assert.deepEqual(v.invoiceListQuery({}, now).window.dateTo, "2026-03-20");
    assert.equal(v.invoiceListQuery({ dateFrom: "2026-01-01", dateTo: "2026-04-02" }, now).window.dateTo, "2026-04-02", "92 days inclusive");
    bad(() => v.invoiceListQuery({ dateFrom: "2026-01-01", dateTo: "2026-04-03" }, now), /at most 92 days/);
    bad(() => v.invoiceListQuery({ dateFrom: "2026-03-02", dateTo: "2026-03-01" }, now), /on or before/);
    for (const d of ["2026-02-30", "2026-3-01", "20260301", "2026-03-01T00:00:00Z", "yesterday"]) bad(() => v.invoiceListQuery({ dateFrom: d, dateTo: "2026-03-10" }, now));
    bad(() => v.invoiceListQuery({ extra: "1" }, now), /Unknown parameter/);
    bad(() => v.invoiceListQuery({ $where: "1" }, now), /Unknown parameter/);
    bad(() => v.invoiceListQuery({ "company.$ne": "x" }, now), /Unknown parameter/);
    bad(() => v.invoiceListQuery({ q: ["a", "b"] }, now), /given once/);
    bad(() => v.invoiceListQuery({ company: { $ne: "x" } }, now), /given once/);
    bad(() => v.invoiceListQuery({ q: "x".repeat(101) }, now), /q must be/);
    bad(() => v.invoiceListQuery({ company: "x".repeat(65) }, now), /company/);
    bad(() => v.invoiceListQuery({ sort: "landed_cost" }, now), /sort/);
    bad(() => v.invoiceListQuery({ dir: "up" }, now), /dir/);
    for (const limit of ["0", "101", "-1", "1.5", "ten"]) bad(() => v.invoiceListQuery({ limit }, now), /limit/);
    assert.equal(v.invoiceListQuery({ limit: "100" }, now).limit, 100);
    const { DATASETS } = require("../src/fabric/datasets");
    for (const limit of ["0", "201"]) bad(() => v.recordsQuery(DATASETS.sales, { limit }), /limit/);
    assert.equal(v.recordsQuery(DATASETS.sales, { limit: "200" }).limit, 200);
    assert.equal(v.recordsQuery(DATASETS.sales, {}).limit, 100);
    for (const cursor of ["", "not base64!", "x".repeat(513), Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ b: "x", v: [] })).toString("base64url")]) bad(() => v.invoiceListQuery({ cursor }, now), /cursor/);
    const q = v.invoiceListQuery({ dateFrom: "2026-03-01", dateTo: "2026-03-10" }, now);
    const cursor = v.encodeCursor("invoices", q.binding, [new Date("2026-03-05T00:00:00Z"), "1ALPHA", "1001"]);
    assert.equal(v.invoiceListQuery({ dateFrom: "2026-03-01", dateTo: "2026-03-10", cursor }, now).cursorValues[2], "1001");
    bad(() => v.invoiceListQuery({ dateFrom: "2026-03-01", dateTo: "2026-03-11", cursor }, now), /different list or filter/);
    bad(() => v.invoiceListQuery({ dateFrom: "2026-03-01", dateTo: "2026-03-10", sort: "amount", cursor }, now), /cursor/);
    bad(() => v.decodeCursor(cursor, "records:sales", q.binding, 3), /different list/);
    const forged = Buffer.from(JSON.stringify({ b: JSON.parse(Buffer.from(cursor, "base64url")).b, v: [{ $gt: "" }, { s: "1" }, { s: "1" }] })).toString("base64url");
    bad(() => v.invoiceListQuery({ dateFrom: "2026-03-01", dateTo: "2026-03-10", cursor: forged }, now), /cursor/);
    assert.deepEqual(v.invoicePath({ company: "~", invoiceNo: "A/1" }), { company: null, invoiceNo: "A/1" });
    bad(() => v.invoicePath({ company: "x".repeat(129), invoiceNo: "1" }));
    bad(() => v.invoicePath({ company: "A", invoiceNo: "1\n2" }));
    for (const id of ["1", "zzzzzzzzzzzzzzzzzzzzzzzz", "0123456789abcdef012345678"]) bad(() => v.lineId(id), /lineId/);
    bad(() => v.noParams({ a: "1" }));
  });
});
