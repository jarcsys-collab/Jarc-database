// OPTIONAL: Fabric Data against a REAL local MongoDB (the other fabric-*.test.js files use an in-memory stand-in). Skipped unless
// both variables are set; it never connects anywhere by default, and it refuses any host that isn't this machine (it drops
// its database's FactSales and FactInventory collections):
//   FABRIC_REAL_MONGO_TEST_URI        a login with ONLY read@<db>, e.g. mongodb://fabric_reader:…@127.0.0.1:27037/?authSource=admin
//   FABRIC_REAL_MONGO_TEST_ADMIN_URI  an admin login on the same server (seeds data, creates indexes, explains, profiles)
//   FABRIC_REAL_MONGO_TEST_DB         the database the reader may read (default FabricTest)
// Synthetic data only: invented companies, invoice numbers, customers and amounts.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { MongoClient, ObjectId, Decimal128 } = require("mongodb");
const { createFabricData } = require("../src/fabric");
const { RECOMMENDED } = require("../src/fabric/indexes");
const v = require("../src/fabric/validation");
const { DATASETS } = require("../src/fabric/datasets");
const { inventoryRows } = require("./support/fabric-fake");

const READER_URI = process.env.FABRIC_REAL_MONGO_TEST_URI;
const ADMIN_URI = process.env.FABRIC_REAL_MONGO_TEST_ADMIN_URI;
const DB = process.env.FABRIC_REAL_MONGO_TEST_DB || "FabricTest";
const loopbackOnly = (uri) => {
  const m = /^mongodb:\/\/(?:[^@/]*@)?([^/?#]+)/.exec(String(uri || ""));
  return Boolean(m) && m[1].split(",").every((h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h.trim()));
};
const SKIP = !READER_URI || !ADMIN_URI ? "set FABRIC_REAL_MONGO_TEST_URI and FABRIC_REAL_MONGO_TEST_ADMIN_URI to run against a local MongoDB"
  : !loopbackOnly(READER_URI) || !loopbackOnly(ADMIN_URI) ? "FABRIC_REAL_MONGO_TEST_* must point at 127.0.0.1 / localhost only" : false;

// ---- Synthetic FactSales ----
const COMPANIES = ["CO-ALPHA", "CO-BETA", "CO-GAMMA", "CO-DELTA", null];
const COSTS = ["2.5", "10", "0.125", "4.75", "n/a", "", "1,234.50", "nan", "Infinity", null, "3"];
const WINDOW = { dateFrom: "2026-01-05", dateTo: "2026-02-28" };
const BIG = { company: "CO-ALPHA", invoiceNo: "INV-BIG-0001" };
const DUP = "INV-DUP-0001";
const NOCO = "INV-NOCO-0001";
const DAY = 86400000;

function seedRows() {
  let s = 20260105;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const rows = [];
  const base = Date.UTC(2026, 0, 5);
  const add = (company, invoiceNo, date, k, extra = {}) => {
    const detail = rnd() >= 0.63;
    const qty = 1 + Math.floor(rnd() * 9);
    const amount = rnd() < 0.5 ? 5 + Math.floor(rnd() * 500) : 5 + Math.floor(rnd() * 500) + pick([0.5, 0.25, 0.75]);
    const doc = {
      _id: new ObjectId(), invoice_id: invoiceNo, Company: company, invoice_date: new Date(date), invoice_due_date: new Date(date + 30 * DAY),
      customer_id: `CUST${String(Math.floor(rnd() * 300)).padStart(4, "0")}`, customer_name: `Example Customer ${invoiceNo.slice(-3)}`,
      external_document_no: `PO-${invoiceNo.slice(-4)}`, Line_No: detail ? 10000 * (k + 1) : null,
      invoice_item_id: `ITEM-${String(Math.floor(rnd() * 80)).padStart(3, "0")}`, invoice_item_name: pick(["Widget Small", "Widget Large", "Gadget", "Example Part"]),
      invoice_item_quantity: qty, invoice_item_amount: amount,
      invoice_item_quantity_sales: detail ? Decimal128.fromString(`${qty}`) : null, invoice_item_amount_sales: detail ? Decimal128.fromString(`${amount.toFixed(2)}`) : null,
      Unit_Price: detail ? Decimal128.fromString((amount / qty).toFixed(4)) : null, uom_code: detail ? "PCS" : null,
      invoice_total_amount: rnd() < 0.3 ? null : 1000 + Math.floor(rnd() * 9000), landed_cost: detail ? pick(COSTS) : null,
      sales_data_source: pick(["Source One", "Source Two"]), sales_type: pick(["Type A", "Type B"]),
      is_invoice_cancelled: rnd() < 0.1 ? null : rnd() < 0.05, is_invoice_closed: rnd() < 0.8, Order_No: `ORD-${invoiceNo.slice(-4)}`,
      Salesperson_Code: rnd() < 0.6 ? null : `SP-${String(Math.floor(rnd() * 90)).padStart(2, "0")}`,
      "Custom.2": pick(["Territory North", "Territory South", null]), join_key_Company_Invoice: `${company}|${invoiceNo}`, upstream_extra: "never returned", ...extra
    };
    if (company === null && rnd() < 0.5) delete doc.Company; // missing counts as "no company"
    rows.push(doc);
  };
  // ~1,500 invoices; numbers drawn from one shared range, so the same number turns up in several companies.
  for (let i = 0; i < 1800; i += 1) {
    const company = pick(COMPANIES), invoiceNo = `INV-${String(1 + Math.floor(rnd() * 1200)).padStart(5, "0")}`;
    if (rows.some((r) => r.invoice_id === invoiceNo && (r.Company ?? null) === company)) continue;
    const date = base + Math.floor(rnd() * 55) * DAY + Math.floor(rnd() * 10) * 3600000;
    const n = 1 + Math.floor(rnd() * 5);
    for (let k = 0; k < n; k += 1) add(company, invoiceNo, date + (k === 4 ? DAY : 0), k);
  }
  for (const company of ["CO-ALPHA", "CO-BETA", null]) for (let k = 0; k < 3; k += 1) add(company, DUP, Date.UTC(2026, 1, 2, 8), k);
  // One invoice with 1,100 rows: some without Line_No, a few repeated Line_No values.
  for (let k = 0; k < 1100; k += 1) add(BIG.company, BIG.invoiceNo, Date.UTC(2026, 1, 10, 9), k % 50 === 7 ? k - 1 : k);
  // A no-company invoice whose rows have Company null on some and no Company field on others (both mean "no company").
  for (let k = 0; k < 450; k += 1) add(null, NOCO, Date.UTC(2026, 1, 11, 9), k);
  // Outside the window on both sides.
  add("CO-ALPHA", "INV-OUT-0001", Date.UTC(2026, 0, 4, 23, 59, 59), 0);
  add("CO-BETA", "INV-OUT-0002", Date.UTC(2026, 2, 1, 0, 0, 0), 0);
  return rows;
}

// ---- Brute force (what the answers must be) ----
const inWindow = (r) => r.invoice_date >= new Date(`${WINDOW.dateFrom}T00:00:00Z`) && r.invoice_date < new Date(Date.parse(`${WINDOW.dateTo}T00:00:00Z`) + DAY);
const companyOf = (r) => r.Company ?? null;
const lcOf = (r) => (typeof r.landed_cost === "string" && /^-?\d+(\.\d+)?$/.test(r.landed_cost) ? Number(r.landed_cost) : null);
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const invoiceHit = (q) => (r) => !q || new RegExp(`^${esc(q)}`, "i").test(r.invoice_id ?? "") || new RegExp(`^${esc(q)}`).test(r.customer_id ?? "") || new RegExp(esc(q), "i").test(r.customer_name ?? "") || new RegExp(esc(q), "i").test(r.external_document_no ?? "");
// /sales/records search: invoice_id, customer_id and invoice_item_id prefix (case-sensitive); names and document no. substring.
const lineHit = (q) => (r) => !q || [r.invoice_id, r.customer_id, r.invoice_item_id].some((x) => typeof x === "string" && x.startsWith(q)) || [r.customer_name, r.invoice_item_name, r.external_document_no].some((x) => typeof x === "string" && new RegExp(esc(q), "i").test(x));
const ALL = Object.freeze({ datasets: new Set(["sales", "inventory"]), sensitive: false });
const ALL_SENSITIVE = Object.freeze({ datasets: new Set(["sales", "inventory"]), sensitive: true });
const salesRecords = (service, query, access = ALL) => service.listRecords("sales", { ...WINDOW, fields: "invoice_date,Company,invoice_id", ...query }, access);
function expectedInvoices(rows, { company, q } = {}) {
  const groups = new Map();
  for (const r of rows.filter(inWindow).filter((r) => company === undefined || companyOf(r) === company).filter(invoiceHit(q))) {
    const key = JSON.stringify([companyOf(r), r.invoice_id]);
    const g = groups.get(key) || { company: companyOf(r), invoiceNo: r.invoice_id, rows: 0, lineDetailRows: 0, amount: 0, quantity: 0, headerTotal: null, invoiceDate: r.invoice_date, customerName: null, costSum: 0, costAmount: 0, rowsWithCost: 0 };
    g.rows += 1; if (r.Line_No !== null && r.Line_No !== undefined) g.lineDetailRows += 1;
    g.amount += r.invoice_item_amount; g.quantity += r.invoice_item_quantity;
    if (r.invoice_total_amount !== null && (g.headerTotal === null || r.invoice_total_amount > g.headerTotal)) g.headerTotal = r.invoice_total_amount;
    if (r.invoice_date < g.invoiceDate) g.invoiceDate = r.invoice_date;
    if (r.customer_name && (g.customerName === null || r.customer_name > g.customerName)) g.customerName = r.customer_name;
    const lc = lcOf(r);
    if (lc !== null) { g.costSum += r.invoice_item_quantity * lc; g.costAmount += r.invoice_item_amount; g.rowsWithCost += 1; }
    groups.set(key, g);
  }
  return groups;
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const skc = (c) => (c === null ? "0" : `1${c}`);
const SORT_VALUES = { invoiceDate: (i) => [Date.parse(i.invoiceDate), skc(i.company), i.invoiceNo], invoiceNo: (i) => [i.invoiceNo, skc(i.company)], customerName: (i) => [i.customerName === null ? "0" : `1${i.customerName}`, skc(i.company), i.invoiceNo], amount: (i) => [i.amount, skc(i.company), i.invoiceNo] };
const salesOrder = (dir) => (a, b) => dir * (cmp(+a.invoice_date, +b.invoice_date) || -cmp(skc(companyOf(a)), skc(companyOf(b))) || -cmp(a.invoice_id, b.invoice_id) || -cmp(a._id.toHexString(), b._id.toHexString()));

// ---- Explain helpers ----
function planStages(explain) {
  const stages = [], indexes = new Set(), pipelineStages = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (typeof node.stage === "string") stages.push(node.stage);
    if (typeof node.indexName === "string") indexes.add(node.indexName);
    for (const [k, value] of Object.entries(node)) if (k !== "rejectedPlans") walk(value);
  };
  walk(explain);
  for (const s of explain.stages || []) pipelineStages.push(Object.keys(s)[0]);
  return { stages, indexes: [...indexes], pipelineStages };
}
const totalDocsExamined = (explain) => { let n = 0; const walk = (o) => { if (Array.isArray(o)) return o.forEach(walk); if (!o || typeof o !== "object") return; if (typeof o.totalDocsExamined === "number") n = Math.max(n, o.totalDocsExamined); Object.values(o).forEach(walk); }; walk(explain); return n; };

describe("Fabric Data on a real MongoDB", { skip: SKIP }, () => {
  let admin, adb, rows, fabric, calls;
  const config = (overrides = {}) => Object.defineProperty({ enabled: true, dbName: DB, queryTimeMs: 8000, poolSize: 3, maxWindowRows: 50000, unindexedScanMax: 20000, invoiceViews: true, readerObjectIds: [], costReaderObjectIds: [], apiAdminObjectIds: [], apiRatePerMinute: 60, ...overrides }, "uri", { value: overrides.uri || READER_URI });
  const quiet = { warn() {}, error() {} };
  // A stack on the reader login whose repository records every aggregate it sends (for explain).
  const open = (overrides) => {
    const f = createFabricData({ config: config(overrides), logger: quiet });
    const aggregate = f.repository.aggregate.bind(f.repository);
    f.repository.aggregate = (pipeline, options) => { calls.push({ kind: "aggregate", pipeline, hint: options.hint, collection: options.collection || "FactSales" }); return aggregate(pipeline, options); };
    const count = f.repository.countDocuments.bind(f.repository);
    f.repository.countDocuments = (filter, options) => { calls.push({ kind: "count", filter, hint: options.hint, limit: options.limit, collection: options.collection || "FactSales" }); return count(filter, options); };
    return f;
  };
  const rejects = (promise, code) => assert.rejects(promise, (e) => { assert.equal(e.code, code); return true; });
  const listQ = (q = {}) => v.invoiceListQuery({ ...WINDOW, ...q });
  async function allInvoicePages(service, q, access = { cost: false }, limit = 100) {
    const seen = [];
    let cursor, pages = 0, total;
    do {
      const out = await service.listInvoices(listQ({ ...q, limit: String(limit), ...(cursor ? { cursor } : {}) }), access);
      seen.push(...out.items); total = out.total; cursor = out.pagination.nextCursor; pages += 1;
      assert.ok(pages < 500, "paging must end");
    } while (cursor);
    return { seen, total, pages };
  }
  const reseed = async () => {
    await adb.collection("FactSales").drop().catch(() => {});
    await adb.collection("FactSales").insertMany(rows, { ordered: false });
  };
  let inventory;
  const reseedInventory = async () => {
    await adb.collection("FactInventory").drop().catch(() => {});
    await adb.collection("FactInventory").insertMany(inventory, { ordered: false });
  };
  const createIndexes = () => Promise.all(Object.values(RECOMMENDED).map((r) => adb.collection("FactSales").createIndex(r.keys, { name: r.name })));

  before(async () => {
    admin = new MongoClient(ADMIN_URI, { directConnection: true });
    await admin.connect();
    adb = admin.db(DB);
    rows = seedRows();
    await reseed();
    inventory = inventoryRows(3000, { days: 400 });
    await reseedInventory();
    calls = [];
  });
  after(async () => {
    await fabric?.close();
    if (adb) { await adb.command({ profile: 0 }).catch(() => {}); if (!process.env.FABRIC_REAL_MONGO_TEST_KEEP) await adb.dropDatabase().catch(() => {}); }
    await admin?.close();
  });

  test("seed has the shapes the source has", () => {
    assert.ok(rows.length >= 5000, `${rows.length} rows`);
    const noDetail = rows.filter((r) => r.Line_No === null).length / rows.length;
    assert.ok(noDetail > 0.55 && noDetail < 0.7, `${noDetail} without line detail`);
    assert.equal(rows.filter((r) => r.invoice_id === BIG.invoiceNo).length, 1100);
  });

  test("privilege check: read@db passes; readWrite and root are refused as unsafe", async () => {
    const reader = open();
    const status = await reader.service.status(ALL);
    assert.equal(reader.connection.state, "ready", JSON.stringify(status));
    assert.equal(status.available, true);
    await reader.close();
    const user = `fabric_real_test_rw_${process.pid}`, anyUser = `fabric_real_test_any_${process.pid}`, pwd = new ObjectId().toHexString();
    await admin.db("admin").command({ createUser: user, pwd, roles: [{ role: "readWrite", db: DB }] });
    await admin.db("admin").command({ createUser: anyUser, pwd, roles: [{ role: "readAnyDatabase", db: "admin" }] }); // Atlas "Only read any database"
    try {
      const uriFor = (name) => { const url = new URL(ADMIN_URI); url.username = name; url.password = pwd; url.searchParams.set("authSource", "admin"); return url.toString(); };
      for (const uri of [uriFor(user), uriFor(anyUser), ADMIN_URI]) {
        const unsafe = open({ uri });
        const s = await unsafe.service.status(ALL);
        assert.equal(s.available, false); assert.equal(s.reason, "FABRIC_UNSAFE_CREDENTIALS");
        await rejects(unsafe.service.listInvoices(listQ(), { cost: false }), "FABRIC_UNSAFE_CREDENTIALS");
        assert.equal(unsafe.connection.state, "unsafe");
        await unsafe.close();
      }
    } finally { await admin.db("admin").command({ dropUser: user }); await admin.db("admin").command({ dropUser: anyUser }); }
  });

  test("writes really fail for the reader login (outside the app)", async () => {
    const c = new MongoClient(READER_URI, { directConnection: true });
    await c.connect();
    try {
      await assert.rejects(c.db(DB).collection("FactSales").insertOne({ invoice_id: "SHOULD-NOT-EXIST" }), (e) => e.code === 13 || e.codeName === "Unauthorized");
      await assert.rejects(c.db(DB).collection("FactSales").createIndex({ invoice_id: 1 }), (e) => e.code === 13);
      await assert.rejects(c.db(DB).collection("FactSales").aggregate([{ $match: {} }, { $limit: 1 }, { $out: "Copy" }]).toArray(), (e) => e.code === 13);
    } finally { await c.close(); }
    assert.equal(await adb.collection("FactSales").countDocuments({ invoice_id: "SHOULD-NOT-EXIST" }), 0);
  });

  test("without indexes, above FABRIC_UNINDEXED_SCAN_MAX: limited mode, FABRIC_INDEX_REQUIRED, and no collection scan is ever sent", async () => {
    await adb.command({ profile: 2 });
    const f = open({ unindexedScanMax: 1000 }); // both collections are larger
    try {
      const status = await f.service.status(ALL);
      assert.deepEqual(status.invoiceViews.capabilities, { invoiceList: false, invoiceDetail: false });
      assert.deepEqual(status.invoiceViews.missingIndexes.map((m) => m.name).sort(), ["fabric_invoice_date", "fabric_invoice_detail"]);
      assert.deepEqual([status.datasets.sales.mode, status.datasets.inventory.mode], ["unavailable", "unavailable"]);
      assert.equal(status.datasets.sales.estimate, rows.length);
      assert.equal(status.datasets.inventory.estimate, inventory.length);
      await rejects(f.service.listInvoices(listQ(), { cost: true }), "FABRIC_INDEX_REQUIRED");
      await rejects(salesRecords(f.service, {}), "FABRIC_INDEX_REQUIRED");
      await rejects(f.service.listRecords("inventory", {}, ALL), "FABRIC_INDEX_REQUIRED");
      await rejects(f.service.listRecords("inventory", { sort: "entryNo", company: "SYNCO-C" }, ALL), "FABRIC_INDEX_REQUIRED");
      await rejects(f.service.getInvoice(BIG.company, BIG.invoiceNo, { cost: false }), "FABRIC_INDEX_REQUIRED");
      await rejects(f.service.listInvoiceLines(BIG.company, BIG.invoiceNo, v.invoiceLinesQuery({}, BIG), { cost: false }), "FABRIC_INDEX_REQUIRED");
      // getLine needs only _id_ (always there).
      const r = rows.find((x) => x.invoice_id === BIG.invoiceNo);
      assert.equal((await f.service.getLine(BIG.company, BIG.invoiceNo, r._id, { cost: false })).line.id, r._id.toHexString());
      // So does one record of either dataset.
      assert.equal((await f.service.getRecord("inventory", inventory[5]._id, ALL)).record.id, inventory[5]._id.toHexString());
    } finally { await f.close(); await adb.command({ profile: 0 }); }
    const ops = await adb.collection("system.profile").find({ appName: "jarc-fabric" }).toArray();
    assert.ok(ops.length > 0, "the app's commands were profiled");
    assert.deepEqual(ops.filter((o) => /COLLSCAN/.test(o.planSummary || "")).map((o) => o.op + " " + o.planSummary), []);
  });

  describe("FactInventory in small-collection mode (only _id, ≤ FABRIC_UNINDEXED_SCAN_MAX)", () => {
    const keysFor = { date: [["Posting_Date", -1], ["Company", 1], ["Entry_No", 1], ["_id", 1]], entryNo: [["Company", 1], ["Entry_No", 1], ["_id", 1]] };
    const icmp = (a, b) => (a instanceof Date ? a - b : typeof a === "number" ? a - b : a?._bsontype === "ObjectId" ? cmp(a.toHexString(), b.toHexString()) : cmp(a, b));

    test("status: small mode with the date span from one bounded aggregate", async () => {
      const f = open();
      try {
        const s = (await f.service.status(ALL)).datasets.inventory;
        assert.deepEqual([s.available, s.mode, s.estimate], [true, "small", inventory.length]);
        const dates = inventory.map((d) => d.Posting_Date.getTime());
        assert.equal(s.latestDate, new Date(Math.max(...dates)).toISOString());
        assert.equal(s.earliestDate, new Date(Math.min(...dates)).toISOString());
        assert.deepEqual(s.window, { field: "Posting_Date", defaultDays: 30, maxDays: null, optional: true });
      } finally { await f.close(); }
    });

    for (const [sort, dir] of [["date", "desc"], ["date", "asc"], ["entryNo", "asc"], ["entryNo", "desc"]]) {
      test(`small mode sort=${sort} dir=${dir}: the whole collection by cursor, each entry once, in order; sensitive fields only when allowed`, async () => {
        const f = open();
        calls = [];
        try {
          const flip = (sort === "date") === (dir === "desc") ? 1 : -1;
          const expected = [...inventory].sort((x, y) => { for (const [k, d] of keysFor[sort]) { const c = icmp(x[k], y[k]); if (c) return c * d * flip; } return 0; });
          const seen = [];
          // entryNo lists one company at a time (company required): walked company by company in that sort's company order.
          const companies = [...new Set(inventory.map((d) => d.Company))].sort((a, b) => cmp(a, b) * flip);
          for (const company of sort === "entryNo" ? companies : [undefined]) {
            let cursor, pages = 0;
            do {
              const out = await f.service.listRecords("inventory", { sort, dir, limit: "200", fields: "Entry_No,Company,Expiration_Date,Cost_Amount_Actual", ...(company ? { company } : {}), ...(cursor ? { cursor } : {}) }, ALL_SENSITIVE);
              assert.equal(out.mode, "small");
              seen.push(...out.items); cursor = out.pagination.nextCursor; pages += 1;
              assert.ok(pages < 100);
            } while (cursor);
          }
          assert.deepEqual(seen.map((i) => i.id), expected.map((d) => d._id.toHexString()));
          assert.ok(seen.every((i) => i.values.Expiration_Date === null || i.values.Expiration_Date >= "1900"), "BC blank dates are null");
          assert.ok(seen.some((i) => i.values.Expiration_Date === null));
          await assert.rejects(f.service.listRecords("inventory", { fields: "Cost_Amount_Actual" }, ALL), (e) => e.status === 400);
          // Explain: unindexed (COLLSCAN is the point of small mode), but projected, limited and bounded in time.
          const call = calls.find((c) => c.collection === "FactInventory" && c.pipeline.some((s) => s.$sort) && !c.pipeline.some((s) => s.$group));
          assert.equal(call.hint, undefined);
          const explain = await adb.collection("FactInventory").aggregate(call.pipeline).explain("executionStats");
          const { stages, pipelineStages } = planStages(explain);
          if (process.env.FABRIC_REAL_MONGO_TEST_VERBOSE) console.log(`  explain inventory small ${sort} ${dir}: ${[...new Set(stages)].join(">")} pipeline=${pipelineStages} examined=${totalDocsExamined(explain)}`);
          assert.ok(stages.includes("COLLSCAN") || stages.includes("PROJECTION_DEFAULT") || stages.length > 0);
          assert.ok(totalDocsExamined(explain) <= inventory.length, "never more than the collection");
        } finally { await f.close(); }
      });
    }

    test("small mode: filters, search and the 92-day window not applying; one record with every permitted field", async () => {
      const f = open();
      try {
        const all = async (query, access = ALL) => {
          const seen = []; let cursor;
          do { const out = await f.service.listRecords("inventory", { limit: "200", fields: "Entry_No", ...query, ...(cursor ? { cursor } : {}) }, access); seen.push(...out.items); cursor = out.pagination.nextCursor; } while (cursor);
          return seen.length;
        };
        assert.equal(await all({ entryType: "Sale" }), inventory.filter((d) => d.Entry_Type === "Sale").length);
        assert.equal(await all({ company: "SYNCO-C", open: "true" }), inventory.filter((d) => d.Company === "SYNCO-C" && d.Open === true).length);
        assert.equal(await all({ q: "ITEM-SYN-01" }), inventory.filter((d) => d.Item_No.startsWith("ITEM-SYN-01")).length);
        assert.equal(await all({ q: "synthetic ITEM 02" }), inventory.filter((d) => /synthetic item 02/i.test(d.Item_Description)).length);
        assert.equal(await all({ dateFrom: "2025-06-01", dateTo: "2027-06-01" }), inventory.length, "no 92-day limit in small mode");
        const one = await f.service.getRecord("inventory", inventory[0]._id, ALL);
        assert.equal(one.record.fields.length, 78);
        assert.equal((await f.service.getRecord("inventory", inventory[0]._id, ALL_SENSITIVE)).record.fields.length, 87);
        assert.ok(!JSON.stringify(one).includes("never returned"));
      } finally { await f.close(); }
    });
  });

  describe("with the recommended indexes", () => {
    before(async () => {
      await createIndexes();
      await Promise.all(Object.values(DATASETS.inventory.indexes).map((r) => adb.collection("FactInventory").createIndex(r.keys, { name: r.name })));
      fabric = open(); calls = [];
    });

    test("status: available, every capability on, nothing missing", async () => {
      const status = await fabric.service.status(ALL);
      assert.equal(status.available, true);
      assert.deepEqual(status.invoiceViews.capabilities, { invoiceList: true, invoiceDetail: true });
      assert.deepEqual(status.invoiceViews.missingIndexes, []);
      assert.deepEqual([status.datasets.sales.mode, status.datasets.inventory.mode], ["indexed", "indexed"]);
      assert.deepEqual([status.datasets.sales.missingIndexes, status.datasets.inventory.missingIndexes], [[], []]);
      assert.deepEqual(status.datasets.inventory.sorts, { date: "indexed", entryNo: "indexed" });
    });

    test("inventory indexed: hinted, index order without a blocking SORT, the default 30 days at the latest Posting_Date, 92-day rule", async () => {
      const f = open();
      calls = [];
      try {
        const latest = new Date(Math.max(...inventory.map((d) => d.Posting_Date.getTime()))).toISOString().slice(0, 10);
        const out = await f.service.listRecords("inventory", {}, ALL);
        assert.deepEqual([out.mode, out.window.dateTo, out.window.defaulted], ["indexed", latest, true]);
        await assert.rejects(f.service.listRecords("inventory", { dateFrom: "2026-01-01", dateTo: "2026-06-01" }, ALL), /at most 92 days/);
        const walkAll = async (query) => {
          const seen = []; let cursor;
          do { const page = await f.service.listRecords("inventory", { ...query, ...(cursor ? { cursor } : {}) }, ALL); seen.push(...page.items); cursor = page.pagination.nextCursor; } while (cursor);
          return seen;
        };
        for (const dir of ["desc", "asc"]) {
          const seen = await walkAll({ sort: "date", dir, dateFrom: "2026-01-01", dateTo: "2026-03-31", limit: "150", fields: "Entry_No" });
          const inRange = inventory.filter((d) => d.Posting_Date >= new Date("2026-01-01T00:00:00Z") && d.Posting_Date < new Date("2026-04-01T00:00:00Z"));
          assert.equal(seen.length, inRange.length, `date ${dir}`);
          assert.equal(new Set(seen.map((i) => i.id)).size, inRange.length);
        }
        // M1: entryNo lists one company (no window): the company bounds the walk of { Company, Entry_No, _id }.
        await assert.rejects(f.service.listRecords("inventory", { sort: "entryNo", dateFrom: "2026-01-01", company: "SYNCO-C" }, ALL), (e) => e.status === 400);
        await assert.rejects(f.service.listRecords("inventory", { sort: "entryNo" }, ALL), (e) => e.status === 400);
        for (const dir of ["asc", "desc"]) {
          const seen = await walkAll({ sort: "entryNo", dir, company: "SYNCO-C", limit: "150", fields: "Entry_No" });
          assert.equal(seen.length, inventory.filter((d) => d.Company === "SYNCO-C").length, `entryNo ${dir}`);
        }
        // M2: a filter is counted first with the query's own index over its bounded range.
        await f.service.listRecords("inventory", { dateFrom: "2026-01-01", dateTo: "2026-03-31", itemNo: "ITEM-SYN-001" }, ALL);
        await f.service.listRecords("inventory", { sort: "entryNo", company: "SYNCO-C", locationCode: "WH-EAST" }, ALL);
        const counts = calls.filter((c) => c.collection === "FactInventory" && c.kind === "count");
        assert.deepEqual(counts.map((c) => c.hint), ["fabric_inventory_date", "fabric_inventory_entry"]);
        for (const c of counts) {
          const explain = await adb.collection("FactInventory").aggregate([{ $match: c.filter }, { $limit: c.limit }, { $group: { _id: 1, n: { $sum: 1 } } }], { hint: c.hint }).explain("executionStats");
          const { stages, indexes } = planStages(explain);
          if (process.env.FABRIC_REAL_MONGO_TEST_VERBOSE) console.log(`  explain inventory count ${c.hint}: ${[...new Set(stages)].join(">")} examined=${totalDocsExamined(explain)}`);
          assert.ok(!stages.includes("COLLSCAN")); assert.deepEqual(indexes, [c.hint]);
        }
        for (const call of calls.filter((c) => c.collection === "FactInventory" && c.hint && c.hint !== "_id_" && c.kind === "aggregate")) {
          const explain = await adb.collection("FactInventory").aggregate(call.pipeline, { hint: call.hint }).explain("executionStats");
          const { stages, indexes, pipelineStages } = planStages(explain);
          const examined = totalDocsExamined(explain);
          if (process.env.FABRIC_REAL_MONGO_TEST_VERBOSE) console.log(`  explain inventory ${call.hint}: ${[...new Set(stages)].join(">")} pipeline=${pipelineStages} examined=${examined}`);
          assert.ok(!stages.includes("COLLSCAN"), call.hint);
          assert.deepEqual(indexes, [call.hint]);
          assert.ok(!stages.includes("SORT") && !pipelineStages.includes("$sort"), `blocking SORT: ${stages}`);
          const filtered = JSON.stringify(call.pipeline[0]).includes("Item_No") || JSON.stringify(call.pipeline[0]).includes("Location_Code");
          if (call.hint === "fabric_inventory_entry" && !filtered) assert.ok(examined <= 160, `entryNo page examined ${examined}`);
        }
      } finally { await f.close(); }
    });

    for (const sort of ["invoiceDate", "invoiceNo", "customerName", "amount"]) for (const dir of ["asc", "desc"]) {
      test(`invoice list sort=${sort} dir=${dir}: every invoice exactly once, in order, totals as brute force`, async () => {
        const expected = expectedInvoices(rows);
        const t = Date.now();
        const { seen, total, pages } = await allInvoicePages(fabric.service, { sort, dir });
        const ms = Date.now() - t;
        const keys = seen.map((i) => JSON.stringify([i.company, i.invoiceNo]));
        assert.equal(new Set(keys).size, keys.length, "no invoice twice");
        assert.equal(seen.length, expected.size, "no invoice missing");
        assert.deepEqual(total, { invoices: expected.size, rows: [...expected.values()].reduce((n, g) => n + g.rows, 0) });
        const d = dir === "asc" ? 1 : -1;
        for (let i = 1; i < seen.length; i += 1) {
          const a = SORT_VALUES[sort](seen[i - 1]), b = SORT_VALUES[sort](seen[i]);
          const c = a.map((x, j) => cmp(x, b[j])).find((x) => x !== 0) ?? 0;
          assert.equal(c, -d, `order at ${i}: ${JSON.stringify(a)} then ${JSON.stringify(b)}`);
        }
        for (const item of seen) {
          const g = expected.get(JSON.stringify([item.company, item.invoiceNo]));
          assert.equal(item.rows, g.rows); assert.equal(item.lineDetailRows, g.lineDetailRows);
          assert.equal(item.amount, g.amount); assert.equal(item.quantity, g.quantity);
          assert.equal(item.headerTotal, g.headerTotal); assert.equal(item.invoiceDate, g.invoiceDate.toISOString());
          assert.ok(!("cost" in item));
        }
        if (process.env.FABRIC_REAL_MONGO_TEST_VERBOSE) console.log(`  invoices ${sort} ${dir}: ${seen.length} in ${pages} pages, ${ms} ms`);
      });
    }

    test("invoice list: company filter (incl. ~), q search, cost for cost readers only", async () => {
      for (const [param, company] of [["CO-BETA", "CO-BETA"], ["~", null]]) {
        const { seen } = await allInvoicePages(fabric.service, { company: param });
        const expected = expectedInvoices(rows, { company });
        assert.equal(seen.length, expected.size, param);
        assert.ok(seen.every((i) => i.company === company));
      }
      for (const q of ["inv-dup", "Customer 01", "PO-00", "CUST01", "ITEM", "("]) {
        const { seen } = await allInvoicePages(fabric.service, { q });
        assert.equal(seen.length, expectedInvoices(rows, { q }).size, q);
      }
      const { seen } = await allInvoicePages(fabric.service, {}, { cost: true });
      const expected = expectedInvoices(rows);
      let withCost = 0;
      for (const item of seen) {
        const g = expected.get(JSON.stringify([item.company, item.invoiceNo]));
        assert.equal(item.cost.rowsWithCost, g.rowsWithCost);
        if (!g.rowsWithCost) { assert.deepEqual(item.cost, { landedCost: null, profit: null, marginPct: null, rowsWithCost: 0 }); continue; }
        withCost += 1;
        assert.match(item.cost.landedCost, /^-?\d+(\.\d+)?$/, "a plain decimal string");
        assert.ok(Math.abs(Number(item.cost.landedCost) - g.costSum) < 1e-9, `${item.cost.landedCost} vs ${g.costSum}`);
        assert.ok(Math.abs(Number(item.cost.profit) - (g.costAmount - g.costSum)) < 1e-9);
        if (g.costAmount) assert.ok(Math.abs(item.cost.marginPct - Math.round(((g.costAmount - g.costSum) / g.costAmount) * 10000) / 100) <= 0.01);
      }
      assert.ok(withCost > 50);
    });

    test("range too large: counted with the index, refused before grouping", async () => {
      const small = open({ maxWindowRows: 1000 });
      try {
        await rejects(small.service.listInvoices(listQ(), { cost: false }), "FABRIC_RANGE_TOO_LARGE");
        // A sales-lines search over the same window is capped too; without q it streams.
        await rejects(salesRecords(small.service, { q: "nomatch" }), "FABRIC_RANGE_TOO_LARGE");
        assert.equal((await salesRecords(small.service, { limit: "5" })).items.length, 5);
        const out = await small.service.listInvoices(listQ({ dateFrom: "2026-02-20", dateTo: "2026-02-21" }), { cost: false });
        assert.ok(out.items.length > 0);
      } finally { await small.close(); }
    });

    test("getInvoice: the same number in three companies is three invoices", async () => {
      for (const company of ["CO-ALPHA", "CO-BETA", null]) {
        const { invoice } = await fabric.service.getInvoice(company, DUP, { cost: true });
        const mine = rows.filter((r) => r.invoice_id === DUP && companyOf(r) === company);
        assert.equal(invoice.company, company);
        assert.equal(invoice.summary.rows, mine.length);
        assert.equal(invoice.summary.amount, mine.reduce((n, r) => n + r.invoice_item_amount, 0));
        assert.ok(invoice.header.territory === null || /^Territory /.test(invoice.header.territory));
        assert.ok("cost" in invoice);
      }
      // Header = first non-null in line order (Line_No, nulls first, then _id), checked over many invoices.
      const lineOrder = (a, b) => cmp(a.Line_No === null ? -Infinity : a.Line_No, b.Line_No === null ? -Infinity : b.Line_No) || cmp(a._id.toHexString(), b._id.toHexString());
      const keys = [...new Set(rows.map((r) => JSON.stringify([companyOf(r), r.invoice_id])))].slice(0, 60).concat([JSON.stringify([BIG.company, BIG.invoiceNo])]);
      for (const key of keys) {
        const [company, invoiceNo] = JSON.parse(key);
        const mine = rows.filter((r) => r.invoice_id === invoiceNo && companyOf(r) === company).sort(lineOrder);
        const { invoice } = await fabric.service.getInvoice(company, invoiceNo, { cost: false });
        for (const f of ["Salesperson_Code", "is_invoice_cancelled", "Order_No"]) assert.equal(invoice.header[f], mine.find((r) => r[f] !== null && r[f] !== undefined)?.[f] ?? null, `${key} ${f}`);
        // territory (Custom.2) is restricted: only sensitive (cost) readers get it.
        assert.equal("territory" in invoice.header, false, `${key} territory hidden`);
        const sensitive = await fabric.service.getInvoice(company, invoiceNo, { cost: true });
        assert.equal(sensitive.invoice.header.territory, mine.find((r) => r["Custom.2"])?.["Custom.2"] ?? null, `${key} territory`);
      }
      const big = await fabric.service.getInvoice(BIG.company, BIG.invoiceNo, { cost: false });
      assert.equal(big.invoice.summary.rows, 1100);
      assert.ok(!("cost" in big.invoice));
      await rejects(fabric.service.getInvoice("CO-GAMMA", "INV-NOPE-0000", { cost: false }), "FABRIC_INVOICE_NOT_FOUND");
    });

    test("invoice lines: all 1,100 rows of one invoice across pages, nulls first, each once", async () => {
      const walk = async (key, limit) => {
        const expected = rows.filter((r) => r.invoice_id === key.invoiceNo && companyOf(r) === key.company)
          .sort((a, b) => cmp(a.Line_No === null ? -Infinity : a.Line_No, b.Line_No === null ? -Infinity : b.Line_No) || cmp(a._id.toHexString(), b._id.toHexString()));
        const seen = [];
        let cursor, pages = 0;
        do {
          const q = v.invoiceLinesQuery({ limit: String(limit), ...(cursor ? { cursor } : {}) }, key);
          const out = await fabric.service.listInvoiceLines(key.company, key.invoiceNo, q, { cost: pages % 2 === 0 });
          assert.equal(out.items.every((i) => "cost" in i), pages % 2 === 0, "cost only on cost pages");
          seen.push(...out.items); cursor = out.pagination.nextCursor; pages += 1;
        } while (cursor);
        assert.equal(pages, Math.ceil(expected.length / limit));
        assert.deepEqual(seen.map((i) => i.id), expected.map((r) => r._id.toHexString()), `${key.company} ${key.invoiceNo}`);
        return { seen, expected };
      };
      const { seen, expected } = await walk(BIG, 200);
      assert.equal(expected.length, 1100);
      assert.ok(expected.filter((r) => r.Line_No === null).length > 300, "many rows without Line_No (they come first)");
      await walk({ company: null, invoiceNo: NOCO }, 37); // Company null on some rows, missing on others
      const detail = seen.find((i) => i.hasLineDetail);
      assert.match(detail.unitPrice, /^\d+\.\d{4}$/, "Decimal128 keeps its digits as a string");
      const costed = seen.filter((i) => i.cost && i.cost.landedCostPerUnit !== null);
      assert.ok(costed.length > 20, "costed lines on the cost pages");
      for (const line of costed) {
        const lc = Number(line.cost.landedCostPerUnit);
        assert.ok(Number.isFinite(lc), `finite landed cost: ${line.cost.landedCostPerUnit}`);
        assert.match(line.cost.landedCost, /^\d+(\.\d+)?$/);
        assert.ok(Math.abs(Number(line.cost.landedCost) - line.quantity * lc) < 1e-9);
        assert.ok(Math.abs(Number(line.cost.profit) - (line.amount - line.quantity * lc)) < 1e-9);
      }
      const r = rows.find((x) => ["nan", "Infinity"].includes(x.landed_cost) && x.invoice_id === BIG.invoiceNo);
      if (r) assert.equal(seen.find((i) => i.id === r._id.toHexString()).cost?.landedCostPerUnit ?? null, null, "nan / Infinity text is no landed cost");
    });

    test("one line: every allowed field (Custom.2 by $getField), nothing else; restricted fields only for sensitive readers", async () => {
      const r = rows.find((x) => x.invoice_id === DUP && x.Company === "CO-BETA" && x["Custom.2"]) || rows.find((x) => x["Custom.2"] && x.Company);
      const plain = await fabric.service.getLine(companyOf(r), r.invoice_id, r._id, { cost: false });
      const byName = Object.fromEntries(plain.line.fields.map((f) => [f.name, f]));
      assert.equal(plain.line.fields.length, 80);
      for (const f of ["landed_cost", "Text", "Custom", "custom_1", "Custom.2", "upstream_extra"]) assert.ok(!(f in byName), f);
      assert.equal(byName.invoice_date.type, "date");
      const costed = await fabric.service.getLine(companyOf(r), r.invoice_id, r._id, { cost: true });
      assert.equal(costed.line.fields.length, 85);
      assert.deepEqual(Object.fromEntries(costed.line.fields.map((f) => [f.name, f]))["Custom.2"], { name: "Custom.2", value: r["Custom.2"], type: "string" });
      await rejects(fabric.service.getLine("CO-GAMMA", r.invoice_id, r._id, { cost: false }), "FABRIC_LINE_NOT_FOUND");
      const d = rows.find((x) => x.Unit_Price && x.Company);
      const withDec = await fabric.service.getLine(d.Company, d.invoice_id, d._id, { cost: false });
      const unit = withDec.line.fields.find((f) => f.name === "Unit_Price");
      assert.deepEqual(unit, { name: "Unit_Price", value: d.Unit_Price.toString(), type: "decimal" });
    });

    for (const dir of ["desc", "asc"]) {
      test(`sales lines dir=${dir}: every row in the window exactly once, in index order`, async () => {
        for (const filter of [{}, { company: "CO-DELTA" }, { company: "~" }, { q: "widget" }]) {
          const company = filter.company === undefined ? undefined : filter.company === "~" ? null : filter.company;
          const expected = rows.filter(inWindow).filter((r) => company === undefined || companyOf(r) === company).filter(lineHit(filter.q)).sort(salesOrder(dir === "asc" ? 1 : -1));
          const seen = [];
          let cursor, pages = 0;
          do {
            const out = await salesRecords(fabric.service, { ...filter, dir, limit: "200", ...(cursor ? { cursor } : {}) }, ALL_SENSITIVE);
            seen.push(...out.items); cursor = out.pagination.nextCursor; pages += 1;
            assert.ok(pages < 200);
          } while (cursor);
          const at = seen.findIndex((item, i) => item.id !== expected[i]?._id.toHexString());
          const show = (i) => (i >= 0 ? JSON.stringify([seen[i]?.values.invoice_date, seen[i]?.values.Company, seen[i]?.values.invoice_id, seen[i]?.id, "expected", expected[i]?.invoice_date, companyOf(expected[i] || {}), expected[i]?.invoice_id, expected[i]?._id.toHexString()]) : "");
          assert.equal(at === -1 && seen.length === expected.length, true, `${JSON.stringify(filter)}: ${seen.length}/${expected.length} rows, first difference at ${at} (page ${Math.floor(at / 200)}): ${show(at)}`);
        }
      });
    }

    test("explain: every query the repository sent uses its hinted index, never COLLSCAN; lines need no blocking SORT", async () => {
      const coll = adb.collection("FactSales");
      const seenKinds = new Map();
      for (const call of calls.filter((c) => c.collection === "FactSales" && c.hint && !(c.pipeline?.[2]?.$limit === 1 && !c.pipeline.some((s) => s.$group)))) {
        const pipeline = call.kind === "count" ? [{ $match: call.filter }, { $limit: call.limit }, { $group: { _id: 1, n: { $sum: 1 } } }] : call.pipeline;
        const kind = call.kind === "count" ? "count" : call.hint === "_id_" ? "line" : pipeline.some((s) => s.$facet) ? "invoiceList" : pipeline.some((s) => s.$group) ? "invoiceSummary" : pipeline[1]?.$sort?.invoice_date ? "salesLines" : "invoiceLines";
        const n = (seenKinds.get(kind) || 0) + 1;
        seenKinds.set(kind, n);
        if (n > 12 && n % 5 !== 0) continue; // the first dozen of each kind, then every fifth (filters, q, both directions)
        const explain = await coll.aggregate(pipeline, { hint: call.hint }).explain("executionStats");
        const { stages, indexes, pipelineStages } = planStages(explain);
        if (process.env.FABRIC_REAL_MONGO_TEST_VERBOSE && n <= 2) console.log(`  explain ${kind}: ${[...new Set(stages)].join(">")} index=${indexes} pipeline=${pipelineStages} examined=${totalDocsExamined(explain)}`);
        assert.ok(!stages.includes("COLLSCAN"), `${kind}: COLLSCAN`);
        assert.ok(stages.includes("IXSCAN") || stages.includes("EXPRESS_IXSCAN") || stages.includes("IDHACK") || stages.includes("EXPRESS_CLUSTERED_IXSCAN"), `${kind}: ${stages}`);
        if (kind !== "line") assert.deepEqual(indexes, [call.hint], `${kind}: index`);
        if (["salesLines", "invoiceLines", "invoiceSummary"].includes(kind)) {
          assert.ok(!stages.includes("SORT"), `${kind}: blocking SORT in ${stages}`);
          assert.ok(!pipelineStages.includes("$sort"), `${kind}: $sort left in the pipeline (${pipelineStages})`);
        }
      }
      assert.deepEqual([...seenKinds.keys()].sort(),["count", "invoiceLines", "invoiceList", "invoiceSummary", "line", "salesLines"]);
    });

    test("one sales-lines page examines about a page of documents, not the window", async () => {
      calls = [];
      const first = await salesRecords(fabric.service, { limit: "100" });
      await salesRecords(fabric.service, { limit: "100", cursor: first.pagination.nextCursor });
      for (const call of calls.filter((c) => c.collection === "FactSales" && c.kind === "aggregate")) {
        const explain = await adb.collection("FactSales").aggregate(call.pipeline, { hint: call.hint }).explain("executionStats");
        const examined = totalDocsExamined(explain);
        assert.ok(examined <= 400, `examined ${examined}`);
      }
    });

    test("FactSales dropped while running: no crash, source missing; recreated: recovers", async () => {
      const f = open();
      try {
        assert.equal((await f.service.status(ALL)).available, true);
        await adb.collection("FactSales").drop();
        // Within the index cache window. MongoDB answers queries on a missing collection with nothing (no error, even with a
        // hint) and counts it as 0 documents: status and every empty answer re-check instead of reporting "no data".
        const status = await f.service.status(ALL);
        assert.equal(status.datasets.sales.available, false); assert.equal(status.datasets.sales.reason, "FABRIC_SOURCE_MISSING");
        assert.equal(status.available, true, "the inventory is still there");
        // Reloaded without indexes yet: limited mode.
        await adb.collection("FactSales").insertMany(rows.slice(0, 500));
        await rejects(f.service.listInvoices(listQ(), { cost: false }), "FABRIC_INDEX_REQUIRED");
        await createIndexes();
        f.indexes.invalidate(); // (otherwise up to 60 s)
        await adb.collection("FactSales").insertMany(rows.slice(500));
        assert.equal((await f.service.status(ALL)).datasets.sales.available, true);
        const out = await f.service.listInvoices(listQ(), { cost: false });
        assert.equal(out.total.invoices, expectedInvoices(rows).size);
        // Dropped again, with the capabilities freshly cached: each query notices by itself.
        await adb.collection("FactSales").drop();
        await rejects(f.service.listInvoices(listQ(), { cost: false }), "FABRIC_SOURCE_MISSING");
        await reseed(); await createIndexes(); await f.indexes.capabilities();
        await adb.collection("FactSales").drop();
        await rejects(f.service.getInvoice(BIG.company, BIG.invoiceNo, { cost: false }), "FABRIC_SOURCE_MISSING");
        await reseed(); await createIndexes(); await f.indexes.capabilities();
        await adb.collection("FactSales").drop();
        await rejects(salesRecords(f.service, {}), "FABRIC_SOURCE_MISSING");
        await reseed(); await createIndexes(); await f.sources.sales.info();
        await adb.collection("FactSales").drop();
        await rejects(f.service.getRecord("sales", rows[0]._id, ALL), "FABRIC_SOURCE_MISSING");
        await reseed(); await createIndexes(); await f.indexes.capabilities();
        await adb.collection("FactSales").drop();
        await rejects(f.service.listInvoiceLines(BIG.company, BIG.invoiceNo, v.invoiceLinesQuery({}, BIG), { cost: false }), "FABRIC_SOURCE_MISSING");
        await reseed(); await createIndexes(); await f.indexes.capabilities();
        await adb.collection("FactSales").drop();
        await rejects(f.service.getLine(BIG.company, BIG.invoiceNo, rows.at(-1)._id, { cost: false }), "FABRIC_SOURCE_MISSING");
        await reseed(); await createIndexes();
        assert.equal((await f.service.listInvoices(listQ(), { cost: false })).total.invoices, expectedInvoices(rows).size, "recovered");
      } finally { await f.close(); }
    });
  });
});
