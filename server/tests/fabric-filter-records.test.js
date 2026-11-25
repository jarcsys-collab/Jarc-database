// Fabric Data advanced filters end to end over the in-memory stand-in (tests/support/fabric-fake.js): every operator against
// synthetic rows (results checked against an independent JS predicate), blanks, Decimal128 precision, AND/OR/nested groups,
// several conditions on one field, the Sales date window that no OR can bypass, the row cap, orderBy (index-only in indexed
// mode, any field in small mode; stable across pages with duplicate and null keys, booleans included), cursor binding and
// tampering, searchField, and the external (token) mount staying exactly as before. Synthetic data only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createFabricData, fabricDataRouter, fabricLimiter } = require("../src/fabric");
const { DATASET_NAMES } = require("../src/fabric/datasets");
const { loadConfig } = require("../src/config");
const { entraEnv } = require("./helpers");
const { FabricFakeClient, row, invRow, DEFAULT_INDEXES, ID_ONLY, dec } = require("./support/fabric-fake");

const baseConfig = loadConfig(entraEnv({ JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb" })).fabricData;
const withConfig = (overrides) => Object.defineProperty({ ...baseConfig, ...overrides }, "uri", { value: baseConfig.uri });
const NOW = new Date("2026-11-25T10:00:00Z");
const ME = Object.freeze({ datasets: new Set(DATASET_NAMES), sensitive: false, via: "session", actorId: "u1" });
const ADV = { advanced: true };
const enc = (model) => Buffer.from(JSON.stringify(model)).toString("base64url");
const root = (...items) => ({ v: 1, op: "and", items });
const D = (t) => new Date(`${t}T00:00:00Z`);
const rejects = (promise, code, reason) => assert.rejects(promise, (e) => { assert.equal(e.code, code); if (reason) assert.equal(e.details?.reason, reason); return true; });

// Inventory (small mode): a row per interesting value shape.
function inventoryDocs() {
  const shapes = [
    { Item_No: "ITEM-A", Entry_Type: "Sale", Quantity: dec("1"), Posting_Date: D("2026-11-25"), Expiration_Date: D("0001-01-01"), Completely_Invoiced: true, Item_Description: "Valve small" },
    { Item_No: "ITEM-B", Entry_Type: "Sale", Quantity: dec("1.000000000000000000000000000000001"), Posting_Date: D("2026-11-24"), Expiration_Date: D("2027-02-01"), Completely_Invoiced: false, Item_Description: "VALVE big" },
    { Item_No: "item-c", Entry_Type: "Purchase", Quantity: dec("2.5"), Posting_Date: D("2026-11-19"), Expiration_Date: null, Completely_Invoiced: true, Item_Description: "pipe (a.b)" },
    { Item_No: "", Entry_Type: "Purchase", Quantity: dec("-3"), Posting_Date: D("2026-11-18"), Expiration_Date: D("1899-12-31"), Completely_Invoiced: null, Item_Description: "Fitting" },
    { Item_No: " ", Entry_Type: " ", Quantity: null, Posting_Date: D("2026-11-23"), Expiration_Date: D("2026-12-01"), Completely_Invoiced: false, Item_Description: "pipe" },
    { Item_No: "   ", Entry_Type: "Transfer", Quantity: dec("0"), Posting_Date: D("2026-11-30"), Expiration_Date: D("2026-11-25"), Completely_Invoiced: true, Item_Description: null },
    { Item_No: null, Entry_Type: null, Quantity: dec("10"), Posting_Date: D("2026-10-26"), Expiration_Date: D("2026-10-31"), Completely_Invoiced: false, Item_Description: "Valve.*" },
    { Item_No: "ITEM-A", Entry_Type: "Sale", Quantity: dec("100"), Posting_Date: D("2026-10-25"), Expiration_Date: D("2027-01-01"), Completely_Invoiced: true, Item_Description: "valve" }
  ];
  const docs = shapes.map((s, i) => invRow({ Entry_No: 1000 + i, Company: i % 2 ? "Synthetic Co B" : "Synthetic Co A", Cost_Amount_Actual: dec("9"), ...s }));
  const missing = invRow({ Entry_No: 2000, Company: "Synthetic Co A", Entry_Type: "Sale", Posting_Date: D("2026-11-20"), Quantity: dec("5") });
  delete missing.Item_No; delete missing.Completely_Invoiced; delete missing.Quantity;
  missing.Quantity = undefined; delete missing.Quantity;
  return [...docs, missing];
}
function salesDocs() {
  const out = [];
  for (let i = 0; i < 30; i += 1) out.push(row({ Company: ["ALPHA", "BETA", null][i % 3], invoice_id: String(5000 + i), customer_name: i % 4 ? `Example Customer ${i % 5}` : " ", invoice_date: D(`2026-11-${String(1 + (i % 28)).padStart(2, "0")}`), Unit_Price: dec(i % 2 ? "1.5" : "1.500000000000000000000000000000001") }));
  out.push(row({ Company: "ALPHA", invoice_id: "OLD-1", customer_name: "Example Customer 1", invoice_date: D("2025-01-15") })); // outside every window used here
  return out;
}
function stack({ inventory = inventoryDocs(), sales = salesDocs(), config = baseConfig } = {}) {
  const client = new FabricFakeClient({ docs: sales, indexes: DEFAULT_INDEXES, inventory: { docs: inventory, indexes: ID_ONLY } });
  const fabric = createFabricData({ config, logger: { warn() {}, error() {} }, createClient: () => client, now: () => NOW });
  return { ...fabric, client, inventory, sales };
}
const inv = (s, query = {}, access = ME) => s.service.listRecords("inventory", { fields: "Item_No,Entry_No", limit: "200", ...query }, access, ADV);
const ids = (out) => out.items.map((i) => i.id).sort();
const expect = (s, pred) => s.inventory.filter(pred).map((d) => d._id.toHexString()).sort();
async function walk(s, name, query, access = ME) {
  const seen = []; let cursor, pages = 0;
  do {
    const out = await s.service.listRecords(name, { ...query, ...(cursor ? { cursor } : {}) }, access, ADV);
    seen.push(...out.items); cursor = out.pagination.nextCursor; pages += 1;
    assert.ok(pages < 200, "paging must end");
  } while (cursor);
  return seen;
}
const blankText = (v) => v === null || v === undefined || (typeof v === "string" && /^\s*$/.test(v));
const n = (v) => (v?._bsontype === "Decimal128" ? Number(v.toString()) : v);

describe("Every operator against synthetic rows (Inventory, small mode, no window)", () => {
  const s = stack();
  const cases = [
    [{ field: "Item_No", op: "eq", value: "ITEM-A" }, (d) => d.Item_No === "ITEM-A"],
    [{ field: "Item_No", op: "eq", value: null }, (d) => d.Item_No == null],
    [{ field: "Item_No", op: "eq", value: "" }, (d) => d.Item_No === ""],
    [{ field: "Item_No", op: "ne", value: "ITEM-A" }, (d) => d.Item_No !== "ITEM-A"],
    [{ field: "Item_No", op: "contains", value: "item" }, (d) => /item/i.test(d.Item_No ?? "")],
    [{ field: "Item_No", op: "notContains", value: "item" }, (d) => !/item/i.test(d.Item_No ?? "")],
    [{ field: "Item_No", op: "startsWith", value: "ITEM" }, (d) => typeof d.Item_No === "string" && d.Item_No.startsWith("ITEM")],
    [{ field: "Item_No", op: "endsWith", value: "-C" }, (d) => /-c$/i.test(d.Item_No ?? "")],
    [{ field: "Item_No", op: "in", values: ["ITEM-B", null] }, (d) => d.Item_No === "ITEM-B" || d.Item_No == null],
    [{ field: "Item_No", op: "nin", values: ["ITEM-B", "ITEM-A"] }, (d) => !["ITEM-B", "ITEM-A"].includes(d.Item_No)],
    [{ field: "Item_No", op: "blank" }, (d) => blankText(d.Item_No)],
    [{ field: "Item_No", op: "notBlank" }, (d) => !blankText(d.Item_No)],
    [{ field: "Item_No", op: "isNull" }, (d) => d.Item_No === null],
    [{ field: "Item_No", op: "missing" }, (d) => !("Item_No" in d)],
    [{ field: "Item_Description", op: "contains", value: "(a.b)" }, (d) => (d.Item_Description ?? "").includes("(a.b)")],
    [{ field: "Item_Description", op: "contains", value: ".*" }, (d) => (d.Item_Description ?? "").includes(".*")],
    [{ field: "Entry_Type", op: "in", values: ["Sale", " "] }, (d) => ["Sale", " "].includes(d.Entry_Type)],
    [{ field: "Entry_Type", op: "blank" }, (d) => blankText(d.Entry_Type)],
    [{ field: "Quantity", op: "eq", value: "1" }, (d) => d.Quantity?.toString() === "1"],
    [{ field: "Quantity", op: "gt", value: "1" }, (d) => d.Quantity != null && (n(d.Quantity) > 1 || d.Quantity.toString() === "1.000000000000000000000000000000001")],
    [{ field: "Quantity", op: "gte", value: "2.5" }, (d) => d.Quantity != null && n(d.Quantity) >= 2.5],
    [{ field: "Quantity", op: "lt", value: "0" }, (d) => d.Quantity != null && n(d.Quantity) < 0],
    [{ field: "Quantity", op: "lte", value: "0" }, (d) => d.Quantity != null && n(d.Quantity) <= 0],
    [{ field: "Quantity", op: "between", value: "0", to: "10" }, (d) => d.Quantity != null && n(d.Quantity) >= 0 && n(d.Quantity) <= 10],
    [{ field: "Quantity", op: "ne", value: "1" }, (d) => d.Quantity?.toString() !== "1"],
    [{ field: "Quantity", op: "blank" }, (d) => d.Quantity == null],
    [{ field: "Quantity", op: "notBlank" }, (d) => d.Quantity != null],
    [{ field: "Posting_Date", op: "today" }, (d) => d.Posting_Date?.toISOString().startsWith("2026-11-25")],
    [{ field: "Posting_Date", op: "lastN", n: 7, unit: "days" }, (d) => d.Posting_Date >= D("2026-11-19") && d.Posting_Date < D("2026-11-26")],
    [{ field: "Posting_Date", op: "prevN", n: 7, unit: "days" }, (d) => d.Posting_Date >= D("2026-11-18") && d.Posting_Date < D("2026-11-25")],
    [{ field: "Posting_Date", op: "thisWeek" }, (d) => d.Posting_Date >= D("2026-11-23") && d.Posting_Date < D("2026-11-30")],
    [{ field: "Posting_Date", op: "lastN", n: 1, unit: "months" }, (d) => d.Posting_Date >= D("2026-10-26") && d.Posting_Date < D("2026-11-26")],
    [{ field: "Posting_Date", op: "between", value: "2026-11-18", to: "2026-11-19" }, (d) => d.Posting_Date >= D("2026-11-18") && d.Posting_Date < D("2026-11-20")],
    [{ field: "Expiration_Date", op: "blank" }, (d) => d.Expiration_Date == null || d.Expiration_Date.getUTCFullYear() < 1900],
    [{ field: "Expiration_Date", op: "notBlank" }, (d) => d.Expiration_Date != null && d.Expiration_Date.getUTCFullYear() >= 1900],
    [{ field: "Expiration_Date", op: "before", value: "2027-01-01" }, (d) => d.Expiration_Date != null && d.Expiration_Date < D("2027-01-01") && d.Expiration_Date.getUTCFullYear() >= 1900],
    [{ field: "Completely_Invoiced", op: "isTrue" }, (d) => d.Completely_Invoiced === true],
    [{ field: "Completely_Invoiced", op: "isFalse" }, (d) => d.Completely_Invoiced === false],
    [{ field: "Completely_Invoiced", op: "isNull" }, (d) => d.Completely_Invoiced === null],
    [{ field: "Completely_Invoiced", op: "missing" }, (d) => !("Completely_Invoiced" in d)]
  ];
  for (const [cond, pred] of cases) {
    test(`${cond.field} ${cond.op} ${JSON.stringify(cond.value ?? cond.values ?? cond.n ?? "")}`, async () => {
      const expected = expect(s, pred);
      assert.ok(expected.length > 0 && expected.length < s.inventory.length, "the case separates rows");
      assert.deepEqual(ids(await inv(s, { filter: enc(root(cond)) })), expected);
    });
  }

  test("AND, OR, a nested OR, and several conditions on one field", async () => {
    const both = root({ field: "Quantity", op: "gte", value: "0" }, { field: "Quantity", op: "lte", value: "2.5" });
    assert.deepEqual(ids(await inv(s, { filter: enc(both) })), expect(s, (d) => d.Quantity != null && n(d.Quantity) >= 0 && n(d.Quantity) <= 2.5));
    const or = { v: 1, op: "or", items: [{ field: "Item_No", op: "eq", value: "item-c" }, { field: "Entry_Type", op: "eq", value: "Transfer" }] };
    assert.deepEqual(ids(await inv(s, { filter: enc(or) })), expect(s, (d) => d.Item_No === "item-c" || d.Entry_Type === "Transfer"));
    const nested = root({ field: "Entry_Type", op: "eq", value: "Sale" }, { op: "or", items: [{ field: "Item_Description", op: "contains", value: "valve" }, { field: "Quantity", op: "gt", value: "4" }] });
    assert.deepEqual(ids(await inv(s, { filter: enc(nested) })), expect(s, (d) => d.Entry_Type === "Sale" && (/valve/i.test(d.Item_Description ?? "") || (d.Quantity != null && n(d.Quantity) > 4))));
  });

  test("the filter combines with the legacy parameters, search and searchField", async () => {
    const out = await inv(s, { filter: enc(root({ field: "Entry_Type", op: "eq", value: "Sale" })), company: "Synthetic Co A", q: "valve", searchField: "Item_Description" });
    assert.deepEqual(ids(out), expect(s, (d) => d.Entry_Type === "Sale" && d.Company === "Synthetic Co A" && /valve/i.test(d.Item_Description ?? "")));
    assert.equal(out.searchField, "Item_Description");
    // Without searchField the search spans every search field (Item_No prefix included).
    assert.deepEqual(ids(await inv(s, { q: "ITEM-A", searchField: "Item_No" })), expect(s, (d) => (d.Item_No ?? "").startsWith("ITEM-A")));
    await rejects(inv(s, { q: "x", searchField: "Entry_Type" }), "VALIDATION_ERROR");
    await rejects(inv(s, { q: "x", searchField: "trade_price" }), "VALIDATION_ERROR");
  });

  test("appliedFilter is the normalized model with resolved UTC ranges; invalid filters are 400 before any query", async () => {
    const out = await inv(s, { filter: enc(root({ field: "Posting_Date", op: "lastN", n: 7, unit: "days" })) });
    assert.deepEqual(out.appliedFilter, { v: 1, op: "and", items: [{ field: "Posting_Date", op: "lastN", n: 7, unit: "days", range: ["2026-11-19", "2026-11-26"] }] });
    const before = s.client.queries().length;
    await rejects(inv(s, { filter: enc(root({ field: "Cost_Amount_Actual", op: "eq", value: "9" })) }, { ...ME, sensitive: true }), "VALIDATION_ERROR", "unknownField");
    await rejects(inv(s, { filter: "%%%" }), "VALIDATION_ERROR", "encoding");
    await rejects(inv(s, { filter: enc({ $where: "1" }) }), "VALIDATION_ERROR");
    assert.equal(s.client.queries().length, before);
  });
});

describe("Decimal128 precision", () => {
  test("equality and ranges on decimal fields are exact (no rounding through a JS number)", async () => {
    const s = stack();
    const one = await inv(s, { filter: enc(root({ field: "Quantity", op: "eq", value: "1" })) });
    assert.deepEqual(ids(one), expect(s, (d) => d.Quantity?.toString() === "1"));
    assert.equal(one.items.length, 1, "1.000…001 is not 1");
    const exact = await inv(s, { filter: enc(root({ field: "Quantity", op: "eq", value: "1.000000000000000000000000000000001" })) });
    assert.equal(exact.items.length, 1);
    assert.notEqual(exact.items[0].id, one.items[0].id);
    const pipeline = s.client.pipelines.at(-1);
    assert.equal(JSON.stringify(pipeline[0].$match).includes("1.000000000000000000000000000000001"), true);
  });
});

describe("Sales: the mandatory date window", () => {
  const W = { dateFrom: "2026-11-01", dateTo: "2026-11-30", limit: "200", fields: "invoice_id,Company,invoice_date" };
  test("an OR (or a date condition) inside the filter cannot widen the window: it stays its own top-level conjunct", async () => {
    const s = stack();
    const sneaky = { v: 1, op: "or", items: [{ field: "invoice_id", op: "eq", value: "OLD-1" }, { field: "invoice_date", op: "onOrAfter", value: "2000-01-01" }, { field: "customer_name", op: "notBlank" }] };
    const out = await s.service.listRecords("sales", { ...W, filter: enc(sneaky) }, ME, ADV);
    assert.ok(out.items.length > 0);
    assert.ok(out.items.every((i) => i.values.invoice_date >= "2026-11-01" && i.values.invoice_date < "2026-12-01"));
    assert.ok(!out.items.some((i) => i.values.invoice_id === "OLD-1"));
    const match = s.client.pipelines.at(-1)[0].$match;
    assert.deepEqual(match.$and[0], { invoice_date: { $gte: D("2026-11-01"), $lt: D("2026-12-01") } });
    // Without dates, the server's default window (30 days ending at the latest date) still applies.
    const dflt = await s.service.listRecords("sales", { filter: enc(sneaky), fields: "invoice_id" }, ME, ADV);
    assert.equal(dflt.window.defaulted, true);
    assert.ok(!dflt.items.some((i) => i.values.invoice_id === "OLD-1"));
    // A wider window is refused as before.
    await rejects(s.service.listRecords("sales", { dateFrom: "2026-01-01", dateTo: "2026-11-30", filter: enc(sneaky) }, ME, ADV), "VALIDATION_ERROR");
  });

  test("a filter counts the base range first: over FABRIC_MAX_WINDOW_ROWS it is FABRIC_RANGE_TOO_LARGE", async () => {
    const s = stack({ config: withConfig({ maxWindowRows: 5 }) });
    await rejects(s.service.listRecords("sales", { ...W, filter: enc(root({ field: "customer_name", op: "contains", value: "Example" })) }, ME, ADV), "FABRIC_RANGE_TOO_LARGE");
    assert.ok(s.client.calls.some((c) => c.op === "countDocuments" && c.options.hint === "fabric_invoice_date"));
    // A later filter on the same window reuses the count (11-benchmarks pattern 3) and is refused the same way.
    const counts = () => s.client.calls.filter((c) => c.op === "countDocuments").length, before = counts();
    await rejects(s.service.listRecords("sales", { ...W, filter: enc(root({ field: "invoice_id", op: "startsWith", value: "50" })) }, ME, ADV), "FABRIC_RANGE_TOO_LARGE");
    await rejects(s.service.listRecords("sales", { ...W, q: "Example" }, ME, ADV), "FABRIC_RANGE_TOO_LARGE");
    assert.equal(counts(), before, "the same range isn't counted again");
  });

  test("paging doesn't recount the window; an exact company filter is bounded like company= (no count); the cap still holds", async () => {
    const filter = enc(root({ field: "customer_name", op: "contains", value: "Example" }));
    const s = stack({ config: withConfig({ maxWindowRows: 1000 }) });
    const counts = (x) => x.client.calls.filter((c) => c.op === "countDocuments").length;
    const seen = await walk(s, "sales", { ...W, filter, limit: "3" });
    assert.ok(seen.length > 6, "several pages");
    assert.equal(counts(s), 1, "counted once for the first page, never for the pages after it");
    const co = stack({ config: withConfig({ maxWindowRows: 5 }) });
    const out = await co.service.listRecords("sales", { ...W, filter: enc(root({ field: "Company", op: "eq", value: "ALPHA" })), limit: "50" }, ME, ADV);
    assert.ok(out.items.length > 0);
    assert.equal(counts(co), 0, "Company = X walks the index like company=X");
    const legacy = await co.service.listRecords("sales", { ...W, company: "ALPHA", limit: "50" }, ME, ADV);
    assert.deepEqual(out.items.map((i) => i.id), legacy.items.map((i) => i.id), "same rows as company=");
    // Company = X with anything else still counts, and is refused over the cap.
    await rejects(co.service.listRecords("sales", { ...W, filter: enc(root({ field: "Company", op: "eq", value: "ALPHA" }, { field: "customer_name", op: "contains", value: "Example" })) }, ME, ADV), "FABRIC_RANGE_TOO_LARGE");
    // A cursor for one window is refused on another (its count can't be borrowed).
    const first = await s.service.listRecords("sales", { ...W, filter, limit: "3" }, ME, ADV);
    await rejects(s.service.listRecords("sales", { ...W, dateFrom: "2026-11-02", filter, limit: "3", cursor: first.pagination.nextCursor }, ME, ADV), "VALIDATION_ERROR");
  });

  test("L4: a session cursor carries its signed issued-at time; after 30 s its later page recounts the window (fixed clock)", async () => {
    let at = NOW.getTime();
    const client = new FabricFakeClient({ docs: salesDocs(), indexes: DEFAULT_INDEXES, inventory: { docs: inventoryDocs(), indexes: ID_ONLY } });
    const fabric = createFabricData({ config: withConfig({ maxWindowRows: 1000 }), logger: { warn() {}, error() {} }, createClient: () => client, now: () => new Date(at) });
    const counts = () => client.calls.filter((c) => c.op === "countDocuments").length;
    const filter = enc(root({ field: "customer_name", op: "contains", value: "Example" }));
    const list = (cursor) => fabric.service.listRecords("sales", { ...W, filter, limit: "3", ...(cursor ? { cursor } : {}) }, ME, ADV);
    const first = await list();
    assert.equal(counts(), 1);
    const c1 = first.pagination.nextCursor;
    const body = JSON.parse(Buffer.from(c1, "base64url").toString("utf8"));
    assert.deepEqual(Object.keys(body), ["b", "v", "t"]);
    assert.equal(body.t, at, "issued at the time of the count");
    // Within 30 s: no recount, and the next cursor keeps the time of that count (paging can't extend it).
    at += 29_999;
    const second = await list(c1);
    assert.equal(counts(), 1, "fresh: the count is skipped");
    assert.equal(JSON.parse(Buffer.from(second.pagination.nextCursor, "base64url").toString("utf8")).t, NOW.getTime());
    // 30 s or more after the count: the same cursor recounts (the window-count reuse has expired too).
    at = NOW.getTime() + 30_000;
    const third = await list(c1);
    assert.equal(counts(), 2, "stale: the window is counted again");
    assert.equal(JSON.parse(Buffer.from(third.pagination.nextCursor, "base64url").toString("utf8")).t, at, "a fresh time after the recount");
    // ...and is refused when the window has since grown past the cap.
    const other = createFabricData({ config: withConfig({ maxWindowRows: 1000 }), logger: { warn() {}, error() {} }, createClient: () => client, now: () => new Date(at) });
    const p1 = await other.service.listRecords("sales", { ...W, filter, limit: "3" }, ME, ADV);
    other.service.config = withConfig({ maxWindowRows: 5 }); // as if the window had been backfilled past the cap
    at += 10_000;
    const fresh = await other.service.listRecords("sales", { ...W, filter, limit: "3", cursor: p1.pagination.nextCursor }, ME, ADV);
    assert.ok(fresh.items.length > 0, "within 30 s the signed check still holds");
    at += 30_000;
    await rejects(other.service.listRecords("sales", { ...W, filter, limit: "3", cursor: p1.pagination.nextCursor }, ME, ADV), "FABRIC_RANGE_TOO_LARGE");
    // A future-dated cursor (clock moved back) recounts too; a tampered time or an untimed cursor is refused.
    at = NOW.getTime() - 1;
    const before = counts();
    await list(c1);
    assert.equal(counts(), before + 1, "future-dated: recounted");
    const forged = Buffer.from(JSON.stringify({ ...body, t: body.t + 60_000 })).toString("base64url");
    await rejects(list(forged), "VALIDATION_ERROR");
    const untimed = Buffer.from(JSON.stringify({ b: body.b, v: body.v })).toString("base64url");
    await rejects(list(untimed), "VALIDATION_ERROR");
  });

  test("L4: external (token) cursors stay untimed { b, v } and skip the count as before", async () => {
    let at = NOW.getTime();
    const client = new FabricFakeClient({ docs: salesDocs(), indexes: DEFAULT_INDEXES, inventory: { docs: inventoryDocs(), indexes: ID_ONLY } });
    const fabric = createFabricData({ config: withConfig({ maxWindowRows: 1000 }), logger: { warn() {}, error() {} }, createClient: () => client, now: () => new Date(at) });
    const TOKEN = Object.freeze({ datasets: new Set(DATASET_NAMES), sensitive: false, via: "token", tokenId: "t1" });
    const counts = () => client.calls.filter((c) => c.op === "countDocuments").length;
    const first = await fabric.service.listRecords("sales", { ...W, q: "Example", limit: "3" }, TOKEN);
    const body = JSON.parse(Buffer.from(first.pagination.nextCursor, "base64url").toString("utf8"));
    assert.deepEqual(Object.keys(body), ["b", "v"], "no issued-at time on the external API");
    assert.equal(counts(), 1);
    at += 60 * 60 * 1000;
    await fabric.service.listRecords("sales", { ...W, q: "Example", limit: "3", cursor: first.pagination.nextCursor }, TOKEN);
    assert.equal(counts(), 1, "unchanged external behaviour");
  });

  test("Company in, invoice_id startsWith and Decimal128 Unit_Price (fast and bounded) inside the window", async () => {
    const s = stack();
    const inWindow = (d) => d.invoice_date >= D("2026-11-01") && d.invoice_date < D("2026-12-01");
    const got = async (model) => (await s.service.listRecords("sales", { ...W, filter: enc(model) }, ME, ADV)).items.map((i) => i.id).sort();
    const want = (pred) => s.sales.filter((d) => inWindow(d) && pred(d)).map((d) => d._id.toHexString()).sort();
    assert.deepEqual(await got(root({ field: "Company", op: "in", values: ["BETA", null] })), want((d) => d.Company === "BETA" || d.Company == null));
    assert.deepEqual(await got(root({ field: "invoice_id", op: "startsWith", value: "501" })), want((d) => d.invoice_id.startsWith("501")));
    assert.deepEqual(await got(root({ field: "Unit_Price", op: "gt", value: "1.5" })), want((d) => d.Unit_Price.toString() !== "1.5"));
    assert.deepEqual(await got(root({ field: "customer_name", op: "blank" })), want((d) => blankText(d.customer_name)));
  });
});

describe("orderBy and keyset paging", () => {
  test("Sales (indexed): an index prefix in either direction walks the index; anything else is refused; orderBy can't mix with sort", async () => {
    const s = stack();
    const W = { dateFrom: "2026-11-01", dateTo: "2026-11-30", limit: "7", fields: "invoice_id" };
    const asc = await s.service.listRecords("sales", { ...W, orderBy: "invoice_date:asc" }, ME, ADV);
    assert.deepEqual(asc.orderBy, [{ field: "invoice_date", dir: "asc" }, { field: "Company", dir: "desc" }, { field: "invoice_id", dir: "desc" }, { field: "_id", dir: "desc" }]);
    assert.equal(s.client.calls.at(-1).options.hint, "fabric_invoice_date");
    const desc = await s.service.listRecords("sales", { ...W, orderBy: "invoice_date:desc,Company:asc" }, ME, ADV);
    assert.deepEqual(desc.orderBy.map((k) => k.dir), ["desc", "asc", "asc", "asc"]);
    const all = await walk(s, "sales", { ...W, orderBy: "invoice_date:asc" });
    assert.equal(all.length, 30);
    assert.equal(new Set(all.map((i) => i.id)).size, 30);
    for (const ob of ["Company:asc", "customer_name:asc", "invoice_date:asc,Company:asc", "invoice_date:desc,invoice_id:asc"]) await rejects(s.service.listRecords("sales", { ...W, orderBy: ob }, ME, ADV), "VALIDATION_ERROR", ob.startsWith("invoice_date:desc,invoice_id") ? undefined : undefined);
    await rejects(s.service.listRecords("sales", { ...W, orderBy: "invoice_date:asc", sort: "date" }, ME, ADV), "VALIDATION_ERROR");
    await rejects(s.service.listRecords("sales", { ...W, orderBy: "landed_cost:asc" }, { ...ME, sensitive: true }, ADV), "VALIDATION_ERROR", "unknownField");
  });

  test("Inventory (small): any orderable field; pages are complete and in order with duplicate, null and boolean keys", async () => {
    const docs = [];
    for (let i = 0; i < 57; i += 1) docs.push(invRow({ Entry_No: i, Company: "Synthetic Co A", Posting_Date: D("2026-11-01"), Entry_Type: ["Sale", "Purchase", null][i % 3], Completely_Invoiced: [true, false, null][i % 3 === 0 ? 0 : i % 2], item_name: i % 5 ? `Synthetic item ${i % 4}` : null, Quantity: dec(String(i % 6)) }));
    const s = stack({ inventory: docs });
    const rank = (v) => (v === null || v === undefined ? 0 : typeof v === "boolean" ? 2 : 1);
    const cmp = (a, b) => (rank(a) - rank(b)) || (a === b ? 0 : typeof a === "boolean" ? Number(a) - Number(b) : a?._bsontype ? Number(a.toString()) - Number(b.toString()) : a < b ? -1 : a > b ? 1 : 0);
    for (const ob of ["Completely_Invoiced:asc,Entry_Type:desc", "item_name:desc", "Entry_Type:asc,Quantity:desc,Completely_Invoiced:asc", "Quantity:asc"]) {
      const keys = ob.split(",").map((p) => p.split(":"));
      const seen = await walk(s, "inventory", { orderBy: ob, limit: "4", fields: "Entry_No" });
      assert.equal(seen.length, 57, ob);
      assert.equal(new Set(seen.map((i) => i.id)).size, 57, `${ob}: no row twice`);
      const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
      const order = seen.map((i) => byId.get(i.id));
      for (let i = 1; i < order.length; i += 1) {
        let c = 0;
        for (const [f, dir] of keys) { c = cmp(order[i - 1][f], order[i][f]) * (dir === "asc" ? 1 : -1); if (c) break; }
        if (!c) c = order[i - 1]._id.toHexString() < order[i]._id.toHexString() ? -1 : 1;
        assert.ok(c < 0, `${ob}: row ${i} out of order`);
      }
    }
  });

  test("a key text too long for a cursor is reported (cursorTooLong), never handed out as a cursor that would be refused", async () => {
    const docs = [0, 1, 2].map((i) => invRow({ Entry_No: i, Company: "Synthetic Co A", Posting_Date: D("2026-11-01"), Item_Description: "d".repeat(450) + i }));
    const s = stack({ inventory: docs });
    const out = await inv(s, { orderBy: "Item_Description:asc", limit: "1" });
    assert.equal(out.pagination.hasMore, true);
    assert.equal(out.pagination.nextCursor, null);
    assert.equal(out.pagination.cursorTooLong, true);
  });

  test("I1: 2,048-character cursors and cursorTooLong only on the session mount; the token mount keeps 512 and no flag", async () => {
    const docs = [0, 1, 2].map((i) => invRow({ Entry_No: i, Company: "Synthetic Co A", Posting_Date: D("2026-11-01"), Item_No: "k".repeat(350) + i }));
    const s = stack({ inventory: docs });
    const TOKEN = Object.freeze({ datasets: new Set(DATASET_NAMES), sensitive: false, via: "token", tokenId: "t1" });
    const query = { fields: "Item_No", limit: "1", dir: "asc" };
    // Default sort keys include no long text here, so use the session orderBy for the long key and the external default sort.
    const session = await inv(s, { orderBy: "Item_No:asc", limit: "1" });
    assert.equal(typeof session.pagination.nextCursor, "string");
    assert.ok(session.pagination.nextCursor.length > 512 && session.pagination.nextCursor.length <= 2048);
    const external = await s.service.listRecords("inventory", query, TOKEN);
    assert.equal(external.pagination.cursorTooLong, undefined, "never on the token mount");
    const { CURSOR_MAX, SESSION_CURSOR_MAX, decodeCursor, recordsQuery } = require("../src/fabric/validation");
    assert.deepEqual([CURSOR_MAX, SESSION_CURSOR_MAX], [512, 2048]);
    const long = "A".repeat(600);
    assert.throws(() => recordsQuery(s.datasets?.inventory || require("../src/fabric/datasets").DATASETS.inventory, { cursor: long }), (e) => e.code === "VALIDATION_ERROR");
    assert.throws(() => decodeCursor(long, "records:inventory", {}, 3), (e) => e.code === "VALIDATION_ERROR");
    // A token page whose keys don't fit in 512 stops after the page, as on efbfdf4: no cursor, no flag.
    const big = [0, 1].map((i) => invRow({ Entry_No: i, Company: "C".repeat(380) + i, Posting_Date: D("2026-11-01") }));
    const t = stack({ inventory: big });
    const page = await t.service.listRecords("inventory", { limit: "1" }, TOKEN);
    assert.deepEqual([page.pagination.hasMore, page.pagination.nextCursor, page.pagination.cursorTooLong], [true, null, undefined]);
    const sess = await t.service.listRecords("inventory", { limit: "1" }, ME, ADV);
    assert.equal(typeof sess.pagination.nextCursor, "string", "the session mount carries it (2,048)");
  });
});

describe("Cursor binding and tampering", () => {
  test("a cursor works only for the same filter, order, search field, access level and caller", async () => {
    const s = stack();
    const q = { filter: enc(root({ field: "Entry_Type", op: "ne", value: "Transfer" })), limit: "2" };
    const first = await inv(s, q);
    const cursor = first.pagination.nextCursor;
    assert.ok(cursor);
    assert.ok((await inv(s, { ...q, cursor })).items.length);
    const refused = (query, access = ME) => rejects(inv(s, { cursor, ...query }, access), "VALIDATION_ERROR");
    await refused({ ...q, filter: enc(root({ field: "Entry_Type", op: "ne", value: "Sale" })) });
    await refused({ limit: "2" });
    await refused({ ...q, orderBy: "Entry_No:asc" });
    await refused({ ...q, q: "x", searchField: "Item_No" });
    await refused(q, { ...ME, sensitive: true });
    await refused(q, { ...ME, actorId: "u2" });
    await refused(q, { ...ME, via: "token", tokenId: "u1" });
    // Tampering: a changed position or signature, or another encoding, is refused.
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    const forged = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    await refused({ ...q, cursor: forged({ ...parsed, v: parsed.v.map(() => ({ s: "zzz" })) }) });
    await refused({ ...q, cursor: forged({ ...parsed, b: "A".repeat(22) }) });
    await refused({ ...q, cursor: forged({ ...parsed, v: [{ $gt: "" }, ...parsed.v.slice(1)] }) });
    await rejects(inv(s, { ...q, cursor: "x".repeat(2049) }), "VALIDATION_ERROR");
  });

  test("boolean keys round-trip through the cursor", async () => {
    const { encodeCursor, decodeCursor } = require("../src/fabric/validation");
    const c = encodeCursor("r", { x: 1 }, [true, false, null, "a"]);
    assert.deepEqual(decodeCursor(c, "r", { x: 1 }, 4), [true, false, null, "a"]);
  });
});

describe("Routes: the session mount is advanced; the external (token) mount is unchanged", () => {
  const mount = ({ service, values = null, access, advanced }) => {
    const app = express();
    app.use("/fabric", (req, res, next) => { req.fabricAccess = access; next(); }, fabricDataRouter({ service, values, advanced, logger: { error() {} }, limiter: fabricLimiter({ perWindow: 10000 }) }));
    return new Promise((resolve) => { const srv = app.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${srv.address().port}/fabric`, close: () => new Promise((r) => srv.close(r)) })); });
  };
  const get = async (url) => { const res = await fetch(url); return { status: res.status, body: await res.json().catch(() => null) }; };

  test("external: filter, orderBy, searchField are unknown parameters, /values is 404, the schema is byte-identical to before", async () => {
    const s = stack();
    const token = { datasets: new Set(DATASET_NAMES), sensitive: false, via: "token", tokenId: "t1" };
    const ext = await mount({ service: s.service, values: s.values, access: token, advanced: false });
    const ses = await mount({ service: s.service, values: s.values, access: ME, advanced: true });
    try {
      for (const p of [`filter=${enc(root())}`, "orderBy=Posting_Date:desc", "searchField=Item_No"]) {
        const res = await get(`${ext.url}/inventory/records?${p}`);
        assert.deepEqual([res.status, res.body.error.code], [400, "VALIDATION_ERROR"], p);
        assert.match(res.body.error.message, /Unknown parameter/);
      }
      assert.equal((await get(`${ext.url}/inventory/values?field=Company`)).status, 404);
      const schema = (await get(`${ext.url}/sales/schema`)).body;
      assert.deepEqual(schema, JSON.parse(JSON.stringify(s.service.baseSchema("sales", token))));
      assert.ok(!("filterModel" in schema) && !("operators" in schema.fields[0]));
      const plain = (await get(`${ext.url}/inventory/records?limit=3`)).body;
      assert.ok(!("appliedFilter" in plain) && !("orderBy" in plain) && !("searchField" in plain));
      // Session: the same records request works with a filter, and the schema carries the capabilities.
      const rec = await get(`${ses.url}/inventory/records?filter=${enc(root({ field: "Entry_Type", op: "eq", value: "Sale" }))}`);
      assert.equal(rec.status, 200);
      assert.ok(rec.body.items.length > 0);
      const adv = (await get(`${ses.url}/sales/schema`)).body;
      assert.equal(adv.filterModel.version, 1);
      assert.deepEqual(adv.filterModel.limits, { maxDepth: 2, maxConditions: 20, maxGroups: 10, maxListValues: 200, maxText: 100, maxEncoded: 6000, maxN: 366 });
      assert.deepEqual(adv.orderBy, { maxKeys: 3 });
      assert.deepEqual(adv.dateWindow, { field: "invoice_date", required: true, defaultDays: 30, maxDays: 92 });
      assert.ok(adv.searchFields.some((f) => f.field === "customer_name" && f.match === "contains"));
      const field = (name) => adv.fields.find((f) => f.name === name);
      assert.deepEqual(field("Company").operators.find((o) => o.op === "in"), { op: "in", class: "fast" });
      assert.equal(field("Company").valueSource, "distinct");
      assert.equal(field("customer_name").valueSource, "search");
      assert.equal(field("invoice_id").kind, "text");
      assert.equal(field("Unit_Price").kind, "number");
      assert.deepEqual(field("invoice_status").operators, []);
      assert.equal(field("landed_cost"), undefined, "sensitive fields are absent for a non-sensitive caller");
      const sens = await mount({ service: s.service, access: { ...ME, sensitive: true }, advanced: true });
      try {
        const lc = (await get(`${sens.url}/sales/schema`)).body.fields.find((f) => f.name === "landed_cost");
        assert.deepEqual([lc.sensitive, lc.operators, lc.orderable, lc.valueSource], [true, [], false, "none"]);
      } finally { await sens.close(); }
      const inv2 = (await get(`${ses.url}/inventory/schema`)).body;
      assert.equal(inv2.dateWindow.required, false);
      // The session values route reaches B2's FabricValues when it's there.
      if (s.values) assert.notEqual((await get(`${ses.url}/inventory/values?field=Company`)).status, 404);
      // Errors carry { path, reason } and never echo the value.
      const badRes = await get(`${ses.url}/inventory/records?filter=${enc(root({ field: "Item_No", op: "eq", value: "SECRET-VALUE".padEnd(120, "x") }))}`);
      assert.equal(badRes.status, 400);
      assert.deepEqual(badRes.body.error.details, { path: "$.items[0].value", reason: "value" });
      assert.doesNotMatch(JSON.stringify(badRes.body), /SECRET-VALUE/);
    } finally { await ext.close(); await ses.close(); }
  });
});
