// Fabric Data limits: driver timeouts, the process-wide operation limit, the per-caller request limit, the records search
// cap, bounded invoice headers and exact Decimal128 cursors. In-memory stand-in only; synthetic data only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { Decimal128 } = require("mongodb");
const { createFabricData, fabricDataRouter } = require("../src/fabric");
const { clientOptions } = require("../src/fabric/connection");
const { FabricRepository, InFlightLimit } = require("../src/fabric/repository");
const { translateDriverError } = require("../src/fabric/errors");
const v = require("../src/fabric/validation");
const { loadConfig } = require("../src/config");
const { entraEnv } = require("./helpers");
const { FabricFakeClient, row } = require("./support/fabric-fake");

const baseConfig = loadConfig(entraEnv({ JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb" })).fabricData;
const withConfig = (overrides) => Object.defineProperty({ ...baseConfig, ...overrides }, "uri", { value: baseConfig.uri });
const day = (d) => new Date(`2026-03-${String(d).padStart(2, "0")}T08:00:00Z`);
const WINDOW = { dateFrom: "2026-03-01", dateTo: "2026-03-31" };
const rejectsWith = (promise, code) => assert.rejects(promise, (e) => { assert.equal(e.code, code); return true; });

describe("Driver limits", () => {
  test("socket timeout = query time + 2 s and a 2 s wait for a pooled connection", () => {
    const o = clientOptions(5, 8000);
    assert.equal(o.maxPoolSize, 5);
    assert.equal(o.socketTimeoutMS, 10000);
    assert.equal(o.waitQueueTimeoutMS, 2000);
    assert.equal(o.timeoutMS, undefined, "no CSOT: every query sets its own maxTimeMS");
  });

  test("driver timeouts become 503s that never carry driver text", () => {
    const socket = translateDriverError(Object.assign(new Error("socket text"), { name: "MongoNetworkTimeoutError" }));
    assert.equal(socket.error.code, "FABRIC_TIMEOUT"); assert.equal(socket.error.status, 503);
    const queue = translateDriverError(Object.assign(new Error("pool text"), { name: "MongoWaitQueueTimeoutError" }));
    assert.equal(queue.error.code, "FABRIC_BUSY"); assert.equal(queue.error.status, 503);
    assert.ok(!queue.error.message.includes("pool text"));
  });
});

describe("Process-wide operation limit", () => {
  test("InFlightLimit: up to max at once, the next waits for a release, one waiting too long is FABRIC_BUSY", async () => {
    const limit = new InFlightLimit({ max: 2, waitMs: 30 });
    await limit.acquire(); await limit.acquire();
    let third = false;
    const waiting = limit.acquire().then(() => { third = true; });
    const one = new InFlightLimit({ max: 1, waitMs: 10 });
    await one.acquire();
    await rejectsWith(one.acquire(), "FABRIC_BUSY");
    assert.equal(one.waiting.length, 0, "a waiter that gave up is gone");
    assert.equal(third, false);
    limit.release();
    await waiting;
    assert.equal(third, true);
    assert.equal(limit.active, 2, "the slot was handed over, not freed");
    limit.release(); limit.release();
    assert.equal(limit.active, 0);
    assert.equal(limit.waiting.length, 0);
  });

  test("the repository holds a slot for each operation and frees it on failure", async () => {
    let unblock;
    const blocked = new Promise((resolve) => { unblock = resolve; });
    const collection = { estimatedDocumentCount: () => blocked, listIndexes: () => ({ toArray: async () => { throw Object.assign(new Error("x"), { code: 26 }); } }) };
    const repository = new FabricRepository({ connection: { collection: async () => collection }, logger: { warn() {} }, maxInFlight: 1, busyWaitMs: 20 });
    const slow = repository.estimate();
    await rejectsWith(repository.listIndexes(), "FABRIC_BUSY");
    unblock(7);
    assert.equal(await slow, 7);
    await rejectsWith(repository.listIndexes(), "FABRIC_SOURCE_MISSING");
    assert.equal(repository.inFlight.active, 0, "released after a failure too");
  });

  test("createFabricData keeps one pooled connection free", () => {
    const f = createFabricData({ config: withConfig({ poolSize: 5 }), logger: { warn() {}, error() {} }, createClient: () => new FabricFakeClient({ docs: [] }) });
    assert.equal(f.repository.inFlight.max, 4);
    const one = createFabricData({ config: withConfig({ poolSize: 1 }), logger: { warn() {}, error() {} }, createClient: () => new FabricFakeClient({ docs: [] }) });
    assert.equal(one.repository.inFlight.max, 1);
  });
});

describe("Per-caller request limit", () => {
  test("a fourth request in flight from one caller is 503 FABRIC_BUSY with Retry-After; others are unaffected", async () => {
    const gates = [];
    const service = { status: (a) => new Promise((resolve) => gates.push(() => resolve({ ok: true, access: a }))) };
    const app = express();
    app.use("/fabric", (req, res, next) => { req.fabricAccess = { cost: false, via: "session", actorId: req.get("x-actor") }; next(); }, fabricDataRouter({ service, logger: { error() {} } }));
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}/fabric/status`;
    const get = (actor) => fetch(url, { headers: { "x-actor": actor } });
    try {
      const running = [get("a"), get("a"), get("a")];
      while (gates.length < 3) await new Promise((r) => setTimeout(r, 5));
      const busy = await get("a");
      assert.equal(busy.status, 503);
      assert.equal((await busy.json()).error.code, "FABRIC_BUSY");
      assert.equal(busy.headers.get("retry-after"), "2");
      const other = get("b");
      while (gates.length < 4) await new Promise((r) => setTimeout(r, 5));
      gates.forEach((open) => open());
      for (const res of await Promise.all([...running, other])) assert.equal(res.status, 200);
      const again = get("a");
      while (gates.length < 5) await new Promise((r) => setTimeout(r, 5));
      gates[4]();
      assert.equal((await again).status, 200, "slots are freed when responses finish");
    } finally { await new Promise((r) => server.close(r)); }
  });
});

describe("Records search cap and invoice header", () => {
  const docs = () => [
    row({ Company: "ALPHA", invoice_id: "1001", Line_No: 20000, invoice_date: day(10), Order_No: "ORD-B", invoice_item_amount: 1 }),
    row({ Company: "ALPHA", invoice_id: "1001", Line_No: 10000, invoice_date: day(10), Order_No: null, Salesperson_Code: "SP-1", invoice_item_amount: 2 }),
    row({ Company: "ALPHA", invoice_id: "1001", Line_No: 9, invoice_date: day(10), Order_No: "ORD-A", invoice_item_amount: 3 }),
    row({ Company: "ALPHA", invoice_id: "1002", Line_No: null, invoice_date: day(11), invoice_item_amount: 4 })
  ];
  const stack = (overrides = {}) => {
    const client = new FabricFakeClient({ docs: docs() });
    return { ...createFabricData({ config: withConfig(overrides), logger: { warn() {}, error() {} }, createClient: () => client }), client };
  };

  test("a records search over a window with more rows than FABRIC_MAX_WINDOW_ROWS is 422 (counted with the index); without q it streams", async () => {
    const access = { datasets: new Set(["sales"]), sensitive: false };
    const s = stack({ maxWindowRows: 3 });
    await rejectsWith(s.service.listRecords("sales", { ...WINDOW, q: "nomatch" }, access), "FABRIC_RANGE_TOO_LARGE");
    const count = s.client.queries().find((q) => q.op === "countDocuments");
    assert.deepEqual([count.options.hint, count.options.limit], ["fabric_invoice_date", 4]);
    assert.equal((await s.service.listRecords("sales", WINDOW, access)).items.length, 4);
    const roomy = stack({ maxWindowRows: 10 });
    assert.equal((await roomy.service.listRecords("sales", { ...WINDOW, q: "1002" }, access)).items.length, 1);
  });

  test("header: first non-null value in line order (numeric Line_No order, not text order), without collecting every row", async () => {
    const s = stack();
    const { invoice } = await s.service.getInvoice("ALPHA", "1001", { cost: false });
    assert.equal(invoice.header.Order_No, "ORD-A", "Line_No 9 comes before 10000 and 20000");
    assert.equal(invoice.header.Salesperson_Code, "SP-1");
    const pipeline = JSON.stringify(s.client.pipelines.at(-1));
    assert.ok(pipeline.includes("$min") && !pipeline.includes("$push"), "no per-row arrays");
  });
});

describe("Cursors keep Decimal128 exact", () => {
  test("a decimal goes out as its text and comes back as the same Decimal128", () => {
    const exact = Decimal128.fromString("12345678901234567890.123456789");
    const cursor = v.encodeCursor("records:inventory", { k: 1 }, [exact, null, "x"]);
    const [back, none, text] = v.decodeCursor(cursor, "records:inventory", { k: 1 }, 3);
    assert.equal(back._bsontype, "Decimal128");
    assert.equal(back.toString(), "12345678901234567890.123456789");
    assert.equal(none, null); assert.equal(text, "x");
    assert.ok(!JSON.parse(Buffer.from(cursor, "base64url").toString()).v[0].n, "never a JS number");
  });

  test("a malformed or forged position in a cursor is refused (cursors are signed); a real decimal comes back exact", () => {
    const forge = (m) => Buffer.from(JSON.stringify({ b: JSON.parse(Buffer.from(v.encodeCursor("lines", ["a"], [1]), "base64url").toString()).b, v: [{ m }] })).toString("base64url");
    for (const m of ["NaN", "Infinity", "1,5", "$gt", "1".repeat(90), "-0.50"]) assert.throws(() => v.decodeCursor(forge(m), "lines", ["a"], 1), (e) => e.code === "VALIDATION_ERROR", m);
    const real = v.encodeCursor("lines", ["a"], [Decimal128.fromString("-0.50")]);
    assert.equal(v.decodeCursor(real, "lines", ["a"], 1)[0].toString(), "-0.50");
    assert.throws(() => v.decodeCursor(real, "lines", ["b"], 1), /Start again from the first page/);
  });
});
