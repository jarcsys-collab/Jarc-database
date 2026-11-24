// Fabric Data dataset explorers (sales → FactSales, inventory → FactInventory): the dataset allow-list, small-collection mode
// versus FABRIC_INDEX_REQUIRED, the default window at the dataset's latest date, sensitive fields, BC blank dates, filters,
// search, keyset paging in every sort, and the router's dataset-scope and invoice-view rules. In-memory stand-in
// (tests/support/fabric-fake.js); synthetic data only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { ObjectId } = require("mongodb");
const { createFabricData, fabricDataRouter, fabricLimiter } = require("../src/fabric");
const { DATASETS, DATASET_NAMES, COLLECTIONS, datasetNamed, permittedFields, INVENTORY_FIELDS } = require("../src/fabric/datasets");
const { FIELD_NAMES } = require("../src/fabric/fields");
const { loadConfig } = require("../src/config");
const { entraEnv } = require("./helpers");
const { FabricFakeClient, row, invRow, inventoryRows, DEFAULT_INDEXES, INVENTORY_INDEXES, ID_ONLY } = require("./support/fabric-fake");

const baseConfig = loadConfig(entraEnv({ JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb" })).fabricData;
const withConfig = (overrides) => Object.defineProperty({ ...baseConfig, ...overrides }, "uri", { value: baseConfig.uri });
const BOTH = Object.freeze({ datasets: new Set(DATASET_NAMES), sensitive: false });
const SENSITIVE = Object.freeze({ datasets: new Set(DATASET_NAMES), sensitive: true });
const NOW = new Date("2026-11-24T10:00:00Z");
const rejects = (promise, code) => assert.rejects(promise, (e) => { assert.equal(e.code, code); return true; });
const salesDocs = () => [
  row({ Company: "ALPHA", invoice_id: "1001", Line_No: 10000, invoice_date: new Date("2026-03-10T08:00:00Z"), customer_name: "Example Customer One", landed_cost: "2.5" }),
  row({ Company: "BETA", invoice_id: null, invoice_date: new Date("2026-03-12T08:00:00Z"), customer_name: "Example Customer Two" }),
  row({ Company: "ALPHA", invoice_id: "0999", invoice_date: new Date("2026-01-02T00:00:00Z") })
];
function stack({ inventory = inventoryRows(400), inventoryIndexes = ID_ONLY, sales = salesDocs(), salesIndexes = DEFAULT_INDEXES, config = baseConfig } = {}) {
  const client = new FabricFakeClient({ docs: sales, indexes: salesIndexes, inventory: { docs: inventory, indexes: inventoryIndexes } });
  const fabric = createFabricData({ config, logger: { warn() {}, error() {} }, createClient: () => client, now: () => NOW });
  return { ...fabric, client, inventory };
}
const inv = (s, query = {}, access = BOTH) => s.service.listRecords("inventory", query, access);
async function walk(s, name, query, access = BOTH) {
  const seen = [];
  let cursor, pages = 0;
  do {
    const out = await s.service.listRecords(name, { ...query, ...(cursor ? { cursor } : {}) }, access);
    seen.push(...out.items); cursor = out.pagination.nextCursor; pages += 1;
    assert.ok(pages < 500, "paging must end");
  } while (cursor);
  return seen;
}
// BSON-ish order for the synthetic values (strings, numbers, dates, ObjectIds; no nulls in the sort keys).
const cmp = (a, b) => (a instanceof Date ? a - b : typeof a === "number" ? a - b : a?._bsontype === "ObjectId" ? (a.toHexString() < b.toHexString() ? -1 : a.toHexString() > b.toHexString() ? 1 : 0) : a < b ? -1 : a > b ? 1 : 0);
const order = (keys) => (x, y) => { for (const [f, d] of keys) { const c = cmp(x[f], y[f]); if (c) return c * d; } return 0; };

describe("The dataset allow-list", () => {
  test("exactly two datasets with constant collection names; field lists in the verified order; nothing else resolves", () => {
    assert.deepEqual(DATASET_NAMES, ["sales", "inventory"]);
    assert.deepEqual(COLLECTIONS, ["FactSales", "FactInventory"]);
    assert.equal(DATASETS.sales.fields, FIELD_NAMES);
    assert.equal(DATASETS.sales.fields.length, 85);
    assert.equal(INVENTORY_FIELDS.length, 87);
    assert.deepEqual([INVENTORY_FIELDS[0], INVENTORY_FIELDS.at(-1)], ["Entry_No", "date_today"]);
    assert.ok(Object.isFrozen(DATASETS) && Object.isFrozen(DATASETS.inventory) && Object.isFrozen(DATASETS.inventory.sensitive));
    for (const name of ["EmployeeData", "employeedata", "OtherCollection", "FactSales", "FactInventory", "Sales", "INVENTORY", "../x", "", "constructor", "__proto__", "toString", "hasOwnProperty", null, undefined, 1, ["sales"]]) assert.equal(datasetNamed(name), null, String(name));
    assert.equal(datasetNamed("inventory").collection, "FactInventory");
    // landed_cost, and (until their meaning is confirmed) the four custom columns.
    assert.deepEqual(DATASETS.sales.sensitive, ["landed_cost", "Text", "Custom", "custom_1", "Custom.2"]);
    assert.deepEqual(DATASETS.inventory.sensitive, ["Cost_Amount_Expected", "Cost_Amount_Actual", "Cost_Amount_Non_Invtbl", "Cost_Amount_Expected_ACY", "Cost_Amount_Actual_ACY", "Cost_Amount_Non_Invtbl_ACY", "landed_cost", "distributors_price", "trade_price"]);
    assert.equal(permittedFields(DATASETS.inventory, false).length, 78);
  });

  test("the connection opens only the two collections; nothing in src/fabric lists collections or names another one", async () => {
    const s = stack();
    await assert.rejects(s.connection.collection("EmployeeData"), /not a Fabric dataset collection/);
    await assert.rejects(s.connection.collection("factsales"), /not a Fabric dataset collection/);
    await s.service.status(BOTH);
    await inv(s);
    await s.service.listRecords("sales", {}, BOTH);
    assert.deepEqual([...new Set(s.client.collectionNames)].sort(), ["FactInventory", "FactSales"]);
    assert.equal(s.client.listCollectionsCalls, 0);
    assert.ok(!s.client.commands.includes("listCollections"));
    const dir = path.join(__dirname, "..", "src", "fabric");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      assert.doesNotMatch(text, /listCollections\s*\(|listCollections\s*:|collectionNames\s*\(/, file);
      // Only the two dataset collections are ever named, and no "…User"-style collection identifier.
      for (const m of text.matchAll(/["'`](Fact[A-Za-z]*)["'`]/g)) assert.ok(["FactSales", "FactInventory"].includes(m[1]), `${file}: ${m[1]}`);
      assert.doesNotMatch(text, /\b[A-Z][a-z]+User\b/, file);
    }
  });
});

describe("Small-collection mode and FABRIC_INDEX_REQUIRED", () => {
  test("inventory with only _id and ≤ FABRIC_UNINDEXED_SCAN_MAX documents: unhinted, projected, limited, sorted in memory; whole collection by cursor", async () => {
    const s = stack();
    const first = await inv(s, { limit: "50" });
    assert.equal(first.mode, "small");
    assert.deepEqual(first.window, { field: "Posting_Date", dateFrom: null, dateTo: null, defaulted: false, all: true }, "no window: the whole collection");
    const records = s.client.calls.filter((c) => c.op === "aggregate" && c.collection === "FactInventory").at(-1);
    assert.equal(records.options.hint, undefined, "no hint in small mode");
    assert.equal(records.options.maxTimeMS, baseConfig.queryTimeMs);
    assert.equal(records.options.allowDiskUse, false);
    const pipeline = s.client.pipelines.at(-1);
    assert.deepEqual(pipeline.map((st) => Object.keys(st)[0]), ["$match", "$project", "$sort", "$limit"], "the sort sees only projected fields");
    assert.equal(pipeline[3].$limit, 51);
    assert.ok(Object.values(pipeline[1].$project).every((v) => v === 1));
    for (const [sort, dir] of [["date", "desc"], ["date", "asc"]]) {
      const seen = await walk(s, "inventory", { sort, dir, limit: "37", fields: "Entry_No,Company,Posting_Date" });
      assert.equal(seen.length, 400, `${sort} ${dir}`);
      assert.equal(new Set(seen.map((i) => i.id)).size, 400, `${sort} ${dir}: each once`);
      const flip = dir === "desc" ? 1 : -1;
      const expected = [...s.inventory].sort(order([["Posting_Date", -1], ["Company", 1], ["Entry_No", 1], ["_id", 1]].map(([f, d]) => [f, d * flip])));
      assert.deepEqual(seen.map((i) => i.id), expected.map((d) => d._id.toHexString()), `${sort} ${dir}: order`);
    }
    // entryNo: one company at a time, in entry order, each entry once.
    for (const dir of ["asc", "desc"]) for (const company of ["Synthetic Co A", "Synthetic Co B", "SYNCO-C"]) {
      const seen = await walk(s, "inventory", { sort: "entryNo", dir, company, limit: "23", fields: "Entry_No,Company" });
      const flip = dir === "asc" ? 1 : -1;
      const expected = s.inventory.filter((d) => d.Company === company).sort(order([["Entry_No", flip], ["_id", flip]]));
      assert.deepEqual(seen.map((i) => i.id), expected.map((d) => d._id.toHexString()), `entryNo ${dir} ${company}`);
    }
  });

  test("M3: small mode re-reads the estimate before every unindexed query; a collection grown past the threshold is 503 at once", async () => {
    const s = stack({ config: withConfig({ unindexedScanMax: 400 }) });
    assert.equal((await inv(s)).mode, "small");
    const estimates = () => s.client.calls.filter((c) => c.op === "estimatedDocumentCount" && c.collection === "FactInventory").length;
    const before = estimates();
    await inv(s);
    assert.ok(estimates() > before, "a fresh metadata estimate, even with the 60 s cache warm");
    s.client.inventory.docs.push(invRow({ Entry_No: 1, Posting_Date: new Date("2026-02-01T00:00:00Z"), Company: "SYNCO-C", Item_No: "ITEM-GROWN" }));
    const queries = s.client.queries("FactInventory").length;
    await rejects(inv(s), "FABRIC_INDEX_REQUIRED");
    await rejects(inv(s, { sort: "entryNo", company: "SYNCO-C" }), "FABRIC_INDEX_REQUIRED");
    assert.equal(s.client.queries("FactInventory").length, queries, "no unindexed query on the larger collection");
    assert.equal((await s.service.status(BOTH)).datasets.inventory.mode, "unavailable");
  });

  test("M1: sort=entryNo needs a company and refuses a date window; /schema says so", async () => {
    for (const s of [stack(), stack({ inventoryIndexes: INVENTORY_INDEXES })]) {
      await assert.rejects(inv(s, { sort: "entryNo" }), (e) => e.status === 400 && /needs a company/.test(e.message));
      await assert.rejects(inv(s, { sort: "entryNo", company: "SYNCO-C", dateFrom: "2026-01-01" }), (e) => e.status === 400 && /leave out dateFrom and dateTo/.test(e.message));
      await assert.rejects(inv(s, { sort: "entryNo", company: "SYNCO-C", dateTo: "2026-01-01" }), (e) => e.status === 400);
      const out = await inv(s, { sort: "entryNo", company: "~" });
      assert.deepEqual([out.items.length, out.window.all], [0, true]);
    }
    const sorts = stack().service.schema("inventory", BOTH).sorts;
    assert.deepEqual(sorts.map((x) => [x.name, x.requiresCompany, x.dateRange]), [["date", false, true], ["entryNo", true, false]]);
    assert.deepEqual(stack().service.schema("sales", BOTH).sorts.map((x) => [x.name, x.requiresCompany, x.dateRange]), [["date", false, true]]);
  });

  test("M2: any filter but company, or q, is counted first over the index-bounded range (window + company) and capped", async () => {
    const s = stack({ inventoryIndexes: INVENTORY_INDEXES, config: withConfig({ maxWindowRows: 1000 }) });
    const counts = () => s.client.calls.filter((c) => c.op === "countDocuments" && c.collection === "FactInventory");
    await inv(s, { dateFrom: "2026-01-01", dateTo: "2026-03-31" });
    await inv(s, { dateFrom: "2026-01-01", dateTo: "2026-03-31", company: "SYNCO-C" });
    assert.equal(counts().length, 0, "window and company alone are bounded by the index: no count");
    await inv(s, { dateFrom: "2026-01-01", dateTo: "2026-03-31", itemNo: "ITEM-SYN-001" });
    assert.deepEqual([counts().at(-1).options.hint, counts().at(-1).options.limit], ["fabric_inventory_date", 1001]);
    await inv(s, { sort: "entryNo", company: "SYNCO-C", locationCode: "WH-EAST" });
    assert.equal(counts().at(-1).options.hint, "fabric_inventory_entry", "counted with the sort's own index over the company");
    const tight = stack({ inventoryIndexes: INVENTORY_INDEXES, config: withConfig({ maxWindowRows: 300 }) });
    tight.client.inventory.docs.push(...inventoryRows(1200, { seed: 99 }));
    for (const query of [{ itemNo: "ITEM-SYN-001" }, { open: "true" }, { q: "nomatch" }, { sort: "entryNo", company: "SYNCO-C", itemNo: "x" }].map((x) => x.sort ? x : { dateFrom: "2026-01-01", dateTo: "2026-03-31", ...x })) {
      await assert.rejects(inv(tight, query), (e) => e.status === 422 && e.code === "FABRIC_RANGE_TOO_LARGE", JSON.stringify(query));
    }
    // Small mode skips the count only while the whole collection is under the cap.
    const small = stack({ config: withConfig({ maxWindowRows: 1000 }) });
    await inv(small, { itemNo: "ITEM-SYN-001" });
    assert.equal(small.client.calls.filter((c) => c.op === "countDocuments").length, 0);
    const bigSmall = stack({ inventory: inventoryRows(1500), config: withConfig({ maxWindowRows: 1000 }) });
    await rejects(inv(bigSmall, { itemNo: "nomatch" }), "FABRIC_RANGE_TOO_LARGE");
  });

  test("M2/L1: cursors are signed: a forged position, another direction or another filter is refused", async () => {
    const s = stack();
    const page = await inv(s, { limit: "5", fields: "Entry_No" });
    const cursor = page.pagination.nextCursor;
    assert.equal((await inv(s, { limit: "5", fields: "Entry_No", cursor })).items.length, 5);
    await assert.rejects(inv(s, { limit: "5", dir: "asc", cursor }), (e) => e.status === 400 && /Start again from the first page/.test(e.message), "bound to dir");
    await assert.rejects(inv(s, { limit: "5", entryType: "Sale", cursor }), (e) => e.status === 400);
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    parsed.v[0] = { d: "2000-01-01T00:00:00.000Z" };
    const forged = Buffer.from(JSON.stringify(parsed)).toString("base64url");
    await assert.rejects(inv(s, { limit: "5", cursor: forged }), (e) => e.status === 400 && e.code === "VALIDATION_ERROR" && /Start again/.test(e.message));
  });

  test("the threshold: estimate ≤ max is small mode, above it 503 FABRIC_INDEX_REQUIRED before any query; 0 means never", async () => {
    const at = stack({ config: withConfig({ unindexedScanMax: 400 }) });
    assert.equal((await inv(at)).mode, "small");
    for (const max of [399, 0]) {
      const above = stack({ config: withConfig({ unindexedScanMax: max }) });
      await assert.rejects(inv(above), (e) => e.status === 503 && e.code === "FABRIC_INDEX_REQUIRED" && e.details.missingIndexes.map((m) => m.name).join() === "fabric_inventory_date");
      await rejects(inv(above, { sort: "entryNo", company: "SYNCO-C" }), "FABRIC_INDEX_REQUIRED");
      assert.deepEqual(above.client.queries(), [], "only listIndexes and the metadata estimate ran");
      const status = await above.service.status(BOTH);
      assert.deepEqual([status.datasets.inventory.mode, status.datasets.inventory.reason, status.datasets.inventory.estimate, status.datasets.inventory.latestDate], ["unavailable", "FABRIC_INDEX_REQUIRED", 400, null]);
      assert.ok(above.client.queries("FactInventory").length === 0, "no unindexed date query either");
    }
    // FABRIC_UNINDEXED_SCAN_MAX: 0–50000, default 20000.
    assert.equal(baseConfig.unindexedScanMax, 20000);
  });

  test("indexed inventory: hinted, index order, the 92-day rule and the default 30-day window at the latest Posting_Date", async () => {
    const s = stack({ inventoryIndexes: INVENTORY_INDEXES });
    const latest = s.inventory.reduce((m, d) => (d.Posting_Date > m ? d.Posting_Date : m), new Date(0));
    const out = await inv(s);
    assert.equal(out.mode, "indexed");
    const end = latest.toISOString().slice(0, 10);
    const start = new Date(Date.parse(`${end}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
    assert.deepEqual(out.window, { field: "Posting_Date", dateFrom: start, dateTo: end, defaulted: true });
    assert.ok(out.items.every((i) => i.values.Posting_Date.slice(0, 10) >= start && i.values.Posting_Date.slice(0, 10) <= end));
    const call = s.client.calls.filter((c) => c.op === "aggregate" && c.collection === "FactInventory").at(-1);
    assert.equal(call.options.hint, "fabric_inventory_date");
    assert.deepEqual(s.client.pipelines.at(-1).map((st) => Object.keys(st)[0]), ["$match", "$sort", "$limit", "$project"]);
    const byEntry = await inv(s, { sort: "entryNo", company: "SYNCO-C" });
    assert.equal(s.client.calls.filter((c) => c.op === "aggregate").at(-1).options.hint, "fabric_inventory_entry");
    assert.equal(byEntry.items.length, 100);
    assert.ok(byEntry.items.every((i) => i.values.Company === "SYNCO-C"));
    assert.deepEqual(Object.keys(s.client.pipelines.at(-1)[0].$match), ["Company"], "the company bounds the index walk; no date filter");
    await assert.rejects(inv(s, { dateFrom: "2026-01-01", dateTo: "2026-04-03" }), (e) => e.status === 400 && /at most 92 days/.test(e.message));
    const all = await walk(s, "inventory", { dateFrom: "2026-01-01", dateTo: "2026-04-01", limit: "200" });
    assert.equal(all.length, s.inventory.filter((d) => d.Posting_Date < new Date("2026-04-02T00:00:00Z")).length);
    // Small mode has no 92-day limit for inventory (the whole collection is allowed anyway).
    const small = stack();
    assert.equal((await inv(small, { dateFrom: "2025-01-01", dateTo: "2026-12-31", limit: "200" })).items.length, 200);
  });

  test("sales: the default window ends at the latest invoice_date, not today; today when the date is unknown; max 92 days even in small mode", async () => {
    const s = stack();
    const out = await s.service.listRecords("sales", {}, BOTH);
    assert.deepEqual(out.window, { field: "invoice_date", dateFrom: "2026-02-11", dateTo: "2026-03-12", defaulted: true });
    assert.equal(out.items.length, 2);
    assert.ok(out.items.some((i) => i.values.invoice_id === null), "invoice_id may be null");
    const status = await s.service.status(BOTH);
    assert.deepEqual([status.datasets.sales.latestDate, status.datasets.sales.earliestDate], ["2026-03-12T08:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
    const onlyFrom = await s.service.listRecords("sales", { dateFrom: "2026-03-01" }, BOTH);
    assert.deepEqual([onlyFrom.window.dateFrom, onlyFrom.window.dateTo], ["2026-03-01", "2026-03-12"]);
    const empty = stack({ sales: [] });
    const none = await empty.service.listRecords("sales", {}, BOTH);
    assert.deepEqual([none.window.dateFrom, none.window.dateTo], ["2026-10-26", "2026-11-24"], "today (injected) when there is no latest date");
    const smallSales = stack({ salesIndexes: [DEFAULT_INDEXES[0]] });
    assert.equal((await smallSales.service.listRecords("sales", {}, BOTH)).mode, "small");
    await assert.rejects(smallSales.service.listRecords("sales", { dateFrom: "2026-01-01", dateTo: "2026-04-03" }, BOTH), /at most 92 days/);
    assert.equal((await smallSales.service.status(BOTH)).datasets.sales.latestDate, "2026-03-12T08:00:00.000Z", "from one bounded aggregate");
  });
});

describe("Sensitive fields", () => {
  for (const name of DATASET_NAMES) {
    test(`${name}: omitted from schema, records and detail; refused like unknown names in fields, filters and sort; never searched; never in cursors`, async () => {
      const ds = DATASETS[name];
      const s = stack();
      const schema = s.service.schema(name, BOTH);
      assert.equal(schema.fields.some((f) => ds.sensitive.includes(f.name)), false);
      assert.equal(JSON.stringify(schema).includes("Cost_Amount") || JSON.stringify(schema).includes("landed_cost"), false);
      const full = s.service.schema(name, SENSITIVE);
      assert.deepEqual(full.fields.filter((f) => f.sensitive).map((f) => f.name), ds.sensitive);
      assert.equal(full.fields.length, ds.fields.length);
      for (const field of ds.sensitive) {
        const query = name === "sales" ? { dateFrom: "2026-03-01", dateTo: "2026-03-31" } : {};
        await assert.rejects(s.service.listRecords(name, { ...query, fields: `${ds.defaultColumns[0]},${field}` }, BOTH), (e) => e.status === 400 && e.code === "VALIDATION_ERROR" && e.message === `Unknown field "${field}".`);
        await assert.rejects(s.service.listRecords(name, { ...query, [field]: "1" }, BOTH), (e) => e.status === 400 && e.message === `Unknown parameter "${field}".`);
        await assert.rejects(s.service.listRecords(name, { ...query, sort: field }, BOTH), (e) => e.status === 400 && /^sort must be one of: /.test(e.message) && !e.message.includes(field));
        await assert.rejects(s.service.listRecords(name, { ...query, [field]: "1" }, SENSITIVE), (e) => e.status === 400, "not a filter even for sensitive readers");
      }
      const allowed = await s.service.listRecords(name, { ...(name === "sales" ? { dateFrom: "2026-03-01", dateTo: "2026-03-31" } : {}), fields: ds.sensitive.join(","), limit: "2" }, SENSITIVE);
      assert.deepEqual(Object.keys(allowed.items[0].values), ds.sensitive);
      // A cursor carries sort keys only.
      const page = await s.service.listRecords(name, { ...(name === "sales" ? { dateFrom: "2026-03-01", dateTo: "2026-03-31" } : {}), fields: ds.sensitive.join(","), limit: "1" }, SENSITIVE);
      const decoded = page.pagination.nextCursor ? Buffer.from(page.pagination.nextCursor, "base64url").toString() : "";
      for (const v of Object.values(page.items[0].values)) if (v !== null && String(v).length > 1) assert.equal(decoded.includes(`"${v}"`), false, "no sensitive value in the cursor");
      // Detail.
      const id = ObjectId.createFromHexString(allowed.items[0].id);
      const plainDetail = await s.service.getRecord(name, id, BOTH);
      assert.equal(plainDetail.record.fields.some((f) => ds.sensitive.includes(f.name)), false);
      assert.deepEqual(plainDetail.record.fields.map((f) => f.name), permittedFields(ds, false));
      const fullDetail = await s.service.getRecord(name, id, SENSITIVE);
      assert.deepEqual(fullDetail.record.fields.map((f) => f.name), ds.fields);
      assert.equal(JSON.stringify(fullDetail).includes("never returned"), false, "unknown upstream fields are never returned");
      // Non-sensitive pipelines never project a sensitive field.
      const s2 = stack({ inventory: s.inventory, sales: s.client.store.docs });
      await s2.service.listRecords(name, name === "sales" ? { dateFrom: "2026-03-01", dateTo: "2026-03-31" } : {}, BOTH);
      await s2.service.getRecord(name, id, BOTH);
      const text = JSON.stringify(s2.client.pipelines);
      for (const field of ds.sensitive) assert.equal(text.includes(`"${field}"`), false, field);
    });
  }

  test("search never looks at sensitive fields (a value only a price holds finds nothing)", async () => {
    const s = stack({ inventory: [invRow({ Entry_No: 1, Posting_Date: new Date("2026-02-01T00:00:00Z"), Company: "C", Item_No: "ITEM-1", trade_price: "SECRET-PRICE-9", Cost_Amount_Actual: null })] });
    assert.equal((await inv(s, { q: "SECRET" }, SENSITIVE)).items.length, 0);
    assert.equal((await inv(s, { q: "ITEM-1" })).items.length, 1);
  });
});

describe("Inventory values, filters and search", () => {
  test("Expiration_Date before 1900 (BC's blank 0001-01-01) is null in records, keys and detail; real dates stay", async () => {
    const s = stack();
    const blank = s.inventory.find((d) => d.Expiration_Date.getUTCFullYear() === 1);
    const real = s.inventory.find((d) => d.Expiration_Date.getUTCFullYear() === 2027);
    const all = await walk(s, "inventory", { fields: "Entry_No,Expiration_Date", limit: "200" });
    assert.equal(all.find((i) => i.id === blank._id.toHexString()).values.Expiration_Date, null);
    assert.equal(all.find((i) => i.id === real._id.toHexString()).values.Expiration_Date, real.Expiration_Date.toISOString());
    const detail = await s.service.getRecord("inventory", blank._id, BOTH);
    assert.deepEqual(detail.record.fields.find((f) => f.name === "Expiration_Date"), { name: "Expiration_Date", value: null, type: "date" });
    assert.deepEqual(Object.keys(detail.record.key), ["Company", "Entry_No"]);
    assert.deepEqual(detail.record.key, { Company: blank.Company, Entry_No: blank.Entry_No });
    assert.deepEqual(detail.record.fields.find((f) => f.name === "Quantity").type, "decimal");
    await rejects(s.service.getRecord("inventory", new ObjectId("0123456789abcdef01234567"), BOTH), "FABRIC_RECORD_NOT_FOUND");
  });

  test("filters: company (exact, ~ = none), entryType, documentType, locationCode, itemNo, open (true/false)", async () => {
    const docs = inventoryRows(400);
    docs.push(invRow({ Entry_No: 1, Posting_Date: new Date("2026-02-01T00:00:00Z"), Company: null, Item_No: "ITEM-NOCO", Open: true }));
    const s = stack({ inventory: docs });
    const count = async (query) => (await walk(s, "inventory", { ...query, limit: "200", fields: "Entry_No" })).length;
    assert.equal(await count({ company: "SYNCO-C" }), docs.filter((d) => d.Company === "SYNCO-C").length);
    assert.equal(await count({ company: "~" }), 1);
    assert.equal(await count({ company: "synco-c" }), 0, "exact");
    assert.equal(await count({ entryType: "Sale" }), docs.filter((d) => d.Entry_Type === "Sale").length);
    assert.equal(await count({ open: "true" }), docs.filter((d) => d.Open === true).length);
    assert.equal(await count({ open: "false" }), docs.filter((d) => d.Open === false).length);
    assert.equal(await count({ locationCode: "WH-EAST", entryType: "Purchase" }), docs.filter((d) => d.Location_Code === "WH-EAST" && d.Entry_Type === "Purchase").length);
    assert.equal(await count({ itemNo: "ITEM-SYN-001" }), docs.filter((d) => d.Item_No === "ITEM-SYN-001").length);
    await assert.rejects(inv(s, { open: "1" }), /open must be true or false/);
    // A cursor is bound to its filters.
    const page = await inv(s, { entryType: "Sale", limit: "5" });
    await assert.rejects(inv(s, { entryType: "Purchase", limit: "5", cursor: page.pagination.nextCursor }), /different list or filter/);
    await assert.rejects(s.service.listRecords("sales", { cursor: page.pagination.nextCursor }, BOTH), /cursor/);
  });

  test("search: Item_No / Document_No / Lot_No / Serial_No prefix (case-sensitive), descriptions case-insensitive substring; regex escaped", async () => {
    const s = stack();
    const n = async (q) => (await walk(s, "inventory", { q, limit: "200", fields: "Entry_No" })).length;
    assert.equal(await n("ITEM-SYN-00"), s.inventory.filter((d) => d.Item_No.startsWith("ITEM-SYN-00")).length);
    assert.equal(await n("DOC-SYN-0001"), s.inventory.filter((d) => d.Document_No.startsWith("DOC-SYN-0001")).length);
    assert.equal(await n("synthetic ITEM 01"), s.inventory.filter((d) => /synthetic item 01/i.test(d.Item_Description)).length);
    assert.equal(await n(".*"), 0);
  });
});

describe("The router: dataset scope, invoice views, unknown datasets", () => {
  const mount = ({ service, access, invoiceViews = false }) => {
    const app = express();
    app.use("/fabric", (req, res, next) => { req.fabricAccess = access; next(); }, fabricDataRouter({ service, logger: { error() {} }, invoiceViews, limiter: fabricLimiter({ perWindow: 10000 }) }));
    return new Promise((resolve) => { const srv = app.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${srv.address().port}/fabric`, close: () => new Promise((r) => srv.close(r)) })); });
  };
  const get = async (url) => { const res = await fetch(url); return { status: res.status, body: await res.json().catch(() => null) }; };

  test("req.fabricAccess.datasets is enforced per request: 403 INSUFFICIENT_SCOPE for a dataset not granted; status lists only granted ones", async () => {
    const s = stack({ inventoryIndexes: INVENTORY_INDEXES });
    const id = s.inventory[0]._id.toHexString();
    const salesOnly = await mount({ service: s.service, access: { datasets: new Set(["sales"]), sensitive: false, via: "token", tokenId: "t1" } });
    const invOnly = await mount({ service: s.service, access: { datasets: ["inventory"], sensitive: false, via: "token", tokenId: "t2" } });
    const none = await mount({ service: s.service, access: { via: "token", tokenId: "t3", cost: false } });
    try {
      for (const p of ["/inventory/schema", "/inventory/records", `/inventory/records/${id}`]) {
        const res = await get(salesOnly.url + p);
        assert.deepEqual([res.status, res.body.error.code], [403, "INSUFFICIENT_SCOPE"], p);
        assert.deepEqual([(await get(none.url + p)).status], [403], p);
        assert.equal((await get(invOnly.url + p)).status, 200, p);
      }
      assert.equal((await get(`${salesOnly.url}/sales/records`)).status, 200);
      assert.equal((await get(`${invOnly.url}/sales/schema`)).status, 403);
      const status = await get(`${salesOnly.url}/status`);
      assert.deepEqual(Object.keys(status.body.datasets), ["sales"]);
      assert.deepEqual(status.body.access, { datasets: ["sales"], sensitive: false });
      assert.deepEqual(Object.keys((await get(`${none.url}/status`)).body.datasets), []);
    } finally { await Promise.all([salesOnly.close(), invOnly.close(), none.close()]); }
  });

  test("sensitive: req.fabricAccess.sensitive decides; `cost` is only a fallback when `sensitive` is absent", async () => {
    const s = stack();
    const fieldsOf = async (access) => {
      const m = await mount({ service: s.service, access: { datasets: new Set(DATASET_NAMES), via: "session", actorId: "u", ...access } });
      try { return (await get(`${m.url}/inventory/schema`)).body.fields.length; } finally { await m.close(); }
    };
    assert.equal(await fieldsOf({ sensitive: true }), 87);
    assert.equal(await fieldsOf({ sensitive: false, cost: true }), 78);
    assert.equal(await fieldsOf({ cost: true }), 87);
    assert.equal(await fieldsOf({ sensitive: "yes" }), 78);
    assert.equal(await fieldsOf({}), 78);
  });

  test("unknown datasets: one 404 NOT_FOUND that never echoes the name, before the scope check and without a query", async () => {
    const s = stack();
    const m = await mount({ service: s.service, access: { datasets: new Set(DATASET_NAMES), sensitive: true, via: "session", actorId: "u" } });
    try {
      const bodies = new Set();
      for (const name of ["EmployeeData", "employeedata", "OtherCollection", "FactSales", "FactInventory", "Sales", "..%2Fx", "x%2F..%2FEmployeeData", "constructor", "__proto__"]) for (const suffix of ["/schema", "/records", "/records/0123456789abcdef01234567"]) {
        const res = await fetch(`${m.url}/${name}${suffix}`);
        const text = await res.text();
        assert.equal(res.status, 404, `${name}${suffix}`);
        assert.equal(text.includes(decodeURIComponent(name)), false);
        bodies.add(text);
      }
      assert.deepEqual([...bodies], [JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found." } })]);
      assert.deepEqual(s.client.queries(), []);
      assert.equal(s.client.listCollectionsCalls, 0);
    } finally { await m.close(); }
  });

  test("invoice views: not mounted by default (404, /sales-lines gone too), mounted with invoiceViews; they need the sales dataset", async () => {
    const s = stack();
    const access = { datasets: new Set(DATASET_NAMES), sensitive: false, via: "session", actorId: "u" };
    const off = await mount({ service: s.service, access });
    const on = await mount({ service: s.service, access, invoiceViews: true });
    const invOnly = await mount({ service: s.service, access: { ...access, datasets: new Set(["inventory"]) }, invoiceViews: true });
    try {
      for (const p of ["/invoices?dateFrom=2026-03-01&dateTo=2026-03-31", "/invoices/ALPHA/1001", "/invoices/ALPHA/1001/lines", "/sales-lines"]) assert.equal((await fetch(off.url + p)).status, 404, p);
      assert.equal((await get(`${on.url}/invoices?dateFrom=2026-03-01&dateTo=2026-03-31`)).status, 200);
      assert.equal((await get(`${on.url}/invoices/ALPHA/1001`)).status, 200);
      assert.equal((await fetch(`${on.url}/sales-lines`)).status, 404);
      assert.equal((await get(`${invOnly.url}/invoices?dateFrom=2026-03-01&dateTo=2026-03-31`)).body.error.code, "INSUFFICIENT_SCOPE");
    } finally { await Promise.all([off.close(), on.close(), invOnly.close()]); }
  });

  test("app.js never mounts the invoice views on /external/fabric", () => {
    const text = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
    const external = text.split("\n").find((l) => l.includes("externalFabricRoutes({"));
    assert.match(external, /fabricDataRouter\(\{ service: fabric\.service, logger, invoiceViews: false \}\)/);
  });
});
