// TEST-ONLY: an in-memory stand-in for the Fabric MongoDB (FactSales), with just the query semantics src/fabric/repository.js
// uses: $match (equality, $gt/$gte/$lt/$lte/$ne/$in/$regex/$or/$and/$expr), $project, $addFields, $group ($sum/$max/$min/$addToSet/
// $push), $sort, $limit, $facet, and the expressions $ifNull, $cond, $eq, $ne, $gt, $lt, $or, $and, $concat, $toString, $toDouble, $convert
// (to decimal), $multiply, $subtract, $divide and $getField. It follows MongoDB's BSON ordering (null first) and its hint rule
// (a hint naming no index fails). Synthetic data only. It has NO write methods: any write attempt throws a TypeError.
const { Decimal128, ObjectId } = require("mongodb");
const { createApp } = require("../../src/app");
const { MemoryStateRepository } = require("../../src/repositories/memory-state-repository");
const { MongoConnection } = require("../../src/db/connection");
const { ensureDatabase } = require("../../src/db/bootstrap");
const { createDataLayer } = require("../../src/data-layer");
const { MemoryFileStore } = require("../../src/files/file-store");
const { FakeMongoClient } = require("./fake-mongo");

const isDec = (v) => v?._bsontype === "Decimal128";
const isOid = (v) => v?._bsontype === "ObjectId";
const num = (v) => (isDec(v) ? Number(v.toString()) : v);
const isNum = (v) => typeof v === "number" || isDec(v);
const dec = (n) => Decimal128.fromString(String(n));
// BSON comparison order: missing/null, numbers, strings, objects, arrays, ObjectId, booleans, dates.
const rank = (v) => (v === undefined || v === null ? 1 : isNum(v) ? 2 : typeof v === "string" ? 3 : isOid(v) ? 7 : typeof v === "boolean" ? 8 : v instanceof Date ? 9 : Array.isArray(v) ? 5 : 4);
function cmp(a, b) {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 1: return 0;
    case 2: return num(a) - num(b);
    case 3: return a < b ? -1 : a > b ? 1 : 0;
    case 7: { const x = a.toHexString(), y = b.toHexString(); return x < y ? -1 : x > y ? 1 : 0; }
    case 8: return Number(a) - Number(b);
    case 9: return a.getTime() - b.getTime();
    case 4: { // documents: field by field (name, then value), as MongoDB compares them
      const x = Object.entries(a), y = Object.entries(b);
      for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
        const c = (x[i][0] < y[i][0] ? -1 : x[i][0] > y[i][0] ? 1 : 0) || cmp(x[i][1], y[i][1]);
        if (c) return c;
      }
      return x.length - y.length;
    }
    default: { const x = JSON.stringify(a), y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; }
  }
}
const get = (doc, path) => path.split(".").reduce((v, k) => (v === null || v === undefined || typeof v !== "object" ? undefined : v[k]), doc);
const isOperators = (v) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !v._bsontype && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith("$"));
const sameType = (a, b) => rank(a) === rank(b);

function matches(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$or") { if (!cond.some((f) => matches(doc, f))) return false; continue; }
    if (key === "$and") { if (!cond.every((f) => matches(doc, f))) return false; continue; }
    if (key === "$expr") { if (!evaluate(cond, doc)) return false; continue; }
    if (key.startsWith("$")) throw new Error(`fabric-fake: unsupported ${key}`);
    const v = get(doc, key);
    const equal = (want) => (want === null ? v === null || v === undefined : sameType(v, want) && cmp(v, want) === 0);
    if (!isOperators(cond)) { if (!equal(cond)) return false; continue; }
    for (const [op, arg] of Object.entries(cond)) {
      let ok;
      switch (op) {
        case "$gt": ok = sameType(v, arg) && cmp(v, arg) > 0; break;
        case "$gte": ok = arg === null ? equal(null) : sameType(v, arg) && cmp(v, arg) >= 0; break;
        case "$lt": ok = sameType(v, arg) && cmp(v, arg) < 0; break;
        case "$lte": ok = arg === null ? equal(null) : sameType(v, arg) && cmp(v, arg) <= 0; break;
        case "$ne": ok = !equal(arg); break;
        case "$in": ok = arg.some((a) => equal(a)); break;
        case "$regex": ok = typeof v === "string" && new RegExp(arg, cond.$options || "").test(v); break;
        case "$options": ok = true; break;
        case "$exists": ok = (v !== undefined) === Boolean(arg); break;
        default: throw new Error(`fabric-fake: unsupported ${op}`);
      }
      if (!ok) return false;
    }
  }
  return true;
}

const arith = (args, fn) => {
  if (args.some((a) => a === null || a === undefined)) return null;
  const result = fn(...args.map(num));
  return args.some(isDec) ? dec(result) : result;
};
const DECIMAL_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
function evaluate(expr, doc) {
  if (typeof expr === "string") {
    if (expr === "$$REMOVE") return undefined;
    if (expr === "$$ROOT" || expr === "$$CURRENT") return doc;
    return expr.startsWith("$") ? get(doc, expr.slice(1)) : expr;
  }
  if (Array.isArray(expr)) return expr.map((e) => evaluate(e, doc));
  if (expr === null || typeof expr !== "object" || expr instanceof Date || expr._bsontype) return expr;
  const keys = Object.keys(expr);
  if (keys.length === 1 && keys[0].startsWith("$")) {
    const op = keys[0], arg = expr[op];
    const args = () => arg.map((a) => evaluate(a, doc));
    switch (op) {
      case "$literal": return arg;
      case "$ifNull": { const [a, b] = arg; const v = evaluate(a, doc); return v === null || v === undefined ? evaluate(b, doc) : v; }
      case "$cond": { const [c, t, f] = Array.isArray(arg) ? arg : [arg.if, arg.then, arg.else]; return evaluate(c, doc) ? evaluate(t, doc) : evaluate(f, doc); }
      case "$eq": { const [a, b] = args(); return (a === undefined) === (b === undefined) && cmp(a, b) === 0; }
      case "$ne": { const [a, b] = args(); return !((a === undefined) === (b === undefined) && cmp(a, b) === 0); }
      case "$gt": { const [a, b] = args(); return cmp(a, b) > 0; }
      case "$lt": { const [a, b] = args(); return cmp(a, b) < 0; }
      case "$or": return args().some(Boolean);
      case "$and": return args().every(Boolean);
      case "$concat": { const parts = args(); return parts.some((p) => typeof p !== "string") ? null : parts.join(""); }
      case "$toString": { const v = evaluate(arg, doc); return v === null || v === undefined ? null : isDec(v) || isOid(v) ? v.toString() : String(v); }
      case "$toDouble": { const v = evaluate(arg, doc); return v === null || v === undefined ? null : Number(num(v)); }
      case "$multiply": return arith(args(), (...n) => n.reduce((x, y) => x * y, 1));
      case "$subtract": return arith(args(), (a, b) => a - b);
      case "$divide": return arith(args(), (a, b) => { if (b === 0) throw Object.assign(new Error("can't divide by zero"), { code: 16608 }); return a / b; });
      case "$convert": {
        if (arg.to !== "decimal") throw new Error(`fabric-fake: unsupported $convert to ${arg.to}`);
        const v = evaluate(arg.input, doc);
        if (v === null || v === undefined) return arg.onNull;
        if (isDec(v)) return v;
        if (typeof v === "number") return dec(v);
        if (typeof v === "string" && DECIMAL_TEXT.test(v)) return Decimal128.fromString(v);
        return arg.onError;
      }
      case "$getField": { if (typeof arg !== "string") throw new Error("fabric-fake: only the $getField shorthand is supported"); return doc?.[arg]; }
      default: throw new Error(`fabric-fake: unsupported expression ${op}`);
    }
  }
  return Object.fromEntries(keys.map((k) => [k, evaluate(expr[k], doc)]).filter(([, v]) => v !== undefined));
}

const keyOf = (v) => JSON.stringify(v, (k, x) => (x instanceof Date ? `D:${x.toISOString()}` : x === undefined ? null : x));
function group(rows, spec) {
  const groups = new Map();
  for (const row of rows) {
    const id = evaluate(spec._id, row);
    const k = keyOf(id ?? null);
    if (!groups.has(k)) groups.set(k, { _id: id ?? null, rows: [] });
    groups.get(k).rows.push(row);
  }
  return [...groups.values()].map(({ _id, rows: members }) => {
    const out = { _id };
    for (const [field, acc] of Object.entries(spec)) {
      if (field === "_id") continue;
      const [op] = Object.keys(acc), e = acc[op];
      const values = members.map((r) => evaluate(e, r));
      switch (op) {
        case "$sum": { const nums = values.filter(isNum); const total = nums.reduce((s, v) => s + num(v), 0); out[field] = nums.some(isDec) ? dec(total) : total; break; }
        case "$max": case "$min": { const present = values.filter((v) => v !== null && v !== undefined); out[field] = present.length ? present.reduce((a, b) => ((op === "$max" ? cmp(b, a) > 0 : cmp(b, a) < 0) ? b : a)) : null; break; }
        case "$addToSet": { const set = []; for (const v of values) if (v !== undefined && !set.some((s) => sameType(s, v) && cmp(s, v) === 0)) set.push(v); out[field] = set; break; }
        case "$push": out[field] = values.filter((v) => v !== undefined); break;
        case "$first": out[field] = values[0] ?? null; break;
        default: throw new Error(`fabric-fake: unsupported accumulator ${op}`);
      }
    }
    return out;
  });
}

function project(doc, spec) {
  const out = {};
  if (spec._id !== 0 && spec._id !== false && doc._id !== undefined && (spec._id === undefined || spec._id === 1 || spec._id === true)) out._id = doc._id;
  for (const [k, v] of Object.entries(spec)) {
    if (k === "_id" && (v === 0 || v === false || v === 1 || v === true)) continue;
    if (v === 1 || v === true) { if (k.includes(".")) throw new Error("fabric-fake: dotted inclusion"); if (doc[k] !== undefined) out[k] = doc[k]; continue; }
    if (v === 0 || v === false) throw new Error("fabric-fake: exclusion in an inclusion projection");
    const value = evaluate(v, doc);
    if (value !== undefined) out[k] = value;
  }
  return out;
}

function sortRows(rows, spec) {
  const keys = Object.entries(spec);
  return rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => { for (const [k, d] of keys) { const c = cmp(get(a, k), get(b, k)); if (c) return c * d; } return i - j; }).map(([r]) => r);
}

function run(rows, pipeline) {
  let out = rows;
  for (const stage of pipeline) {
    const [name] = Object.keys(stage), arg = stage[name];
    switch (name) {
      case "$match": out = out.filter((d) => matches(d, arg)); break;
      case "$limit": out = out.slice(0, arg); break;
      case "$project": out = out.map((d) => project(d, arg)); break;
      case "$addFields": out = out.map((d) => ({ ...d, ...Object.fromEntries(Object.entries(arg).map(([k, e]) => [k, evaluate(e, d)])) })); break;
      case "$group": out = group(out, arg); break;
      case "$sort": out = sortRows(out, arg); break;
      case "$facet": { const input = out; out = [Object.fromEntries(Object.entries(arg).map(([k, p]) => [k, run(input, p)]))]; break; }
      default: throw new Error(`fabric-fake: unsupported stage ${name}`);
    }
  }
  return out;
}

const serverError = (code, codeName, message) => Object.assign(new Error(message), { name: "MongoServerError", code, codeName });
const DEFAULT_INDEXES = Object.freeze([
  { v: 2, key: { _id: 1 }, name: "_id_" },
  { v: 2, key: { invoice_date: -1, Company: 1, invoice_id: 1, _id: 1 }, name: "fabric_invoice_date" },
  { v: 2, key: { Company: 1, invoice_id: 1, Line_No: 1, _id: 1 }, name: "fabric_invoice_detail" }
]);
// FactInventory as it is today: only _id (small-collection mode). INVENTORY_INDEXES: the recommended ones.
const ID_ONLY = Object.freeze([{ v: 2, key: { _id: 1 }, name: "_id_" }]);
const INVENTORY_INDEXES = Object.freeze([
  ID_ONLY[0],
  { v: 2, key: { Posting_Date: -1, Company: 1, Entry_No: 1, _id: 1 }, name: "fabric_inventory_date" },
  { v: 2, key: { Company: 1, Entry_No: 1, _id: 1 }, name: "fabric_inventory_entry" }
]);

class FabricFakeCollection {
  // shared: { calls, pipelines, failures } for the whole client; store: this collection's { name, docs, indexes, missing }.
  constructor(store, shared = store) { this.store = store; this.shared = shared; }
  get calls() { return this.shared.calls; }
  check(op, options) {
    this.shared.calls.push({ op, options, collection: this.store.name });
    const failure = this.shared.failures.shift();
    if (failure) throw failure;
    if (options?.hint && !this.store.indexes.some((i) => i.name === options.hint)) throw serverError(2, "BadValue", "hint provided does not correspond to an existing index");
  }
  rows() { return this.store.missing ? [] : this.store.docs; }
  aggregate(pipeline, options = {}) {
    this.shared.pipelines.push(pipeline);
    return { toArray: async () => { this.check("aggregate", options); return run(this.rows(), pipeline); } };
  }
  async countDocuments(filter, options = {}) {
    this.check("countDocuments", options);
    const n = this.rows().filter((d) => matches(d, filter)).length;
    return options.limit ? Math.min(n, options.limit) : n;
  }
  find(filter, options = {}) {
    return { toArray: async () => { this.check("find", options); let rows = this.rows().filter((d) => matches(d, filter)); if (options.sort) rows = sortRows(rows, options.sort); return rows.slice(0, options.limit).map((d) => project(d, options.projection)); } };
  }
  listIndexes() {
    return { toArray: async () => { this.check("listIndexes", {}); if (this.store.missing) throw serverError(26, "NamespaceNotFound", "ns does not exist"); return this.store.indexes.map((i) => ({ ...i })); } };
  }
  async estimatedDocumentCount(options = {}) { this.check("estimatedDocumentCount", options); return this.rows().length; }
}

// A MongoClient look-alike with two collections: FactSales (docs, indexes, missing) and FactInventory (inventory: { docs,
// indexes, missing }; default empty with only _id). Any other collection name throws. authInfo: the connectionStatus authInfo
// (default: read@<db> with read actions only). listCollections is counted (listCollectionsCalls) and always fails: nothing in
// src/fabric may ever call it.
class FabricFakeClient {
  constructor({ docs = [], indexes = DEFAULT_INDEXES, connectError = null, authInfo = null, missing = false, inventory = {} } = {}) {
    this.shared = { calls: [], pipelines: [], failures: [] };
    this.store = { name: "FactSales", docs, indexes: indexes.map((i) => ({ ...i })), missing };
    this.inventory = { name: "FactInventory", docs: inventory.docs || [], indexes: (inventory.indexes || ID_ONLY).map((i) => ({ ...i })), missing: inventory.missing ?? missing };
    this.stores = { FactSales: this.store, FactInventory: this.inventory };
    this.connectError = connectError;
    this.authInfo = authInfo;
    this.connectCalls = 0; this.closeCalls = 0; this.created = [];
    this.commands = [];
    this.collectionNames = [];
    this.listCollectionsCalls = 0;
  }
  get calls() { return this.shared.calls; }
  get pipelines() { return this.shared.pipelines; }
  queries(collection) { return this.shared.calls.filter((c) => ["aggregate", "countDocuments", "find"].includes(c.op) && (!collection || c.collection === collection)); }
  failNext(error) { this.shared.failures.push(error); }
  async connect() { this.connectCalls += 1; if (this.connectError) throw this.connectError; return this; }
  async close() { this.closeCalls += 1; }
  db(name) {
    return {
      collection: (collection) => {
        this.collectionNames.push(collection);
        if (!this.stores[collection]) throw new Error(`fabric-fake: no collection ${collection}`);
        return new FabricFakeCollection(this.stores[collection], this.shared);
      },
      listCollections: () => { this.listCollectionsCalls += 1; throw new Error("fabric-fake: listCollections is never allowed"); },
      command: async (command) => {
        this.commands.push(Object.keys(command)[0]);
        if (command.listCollections) { this.listCollectionsCalls += 1; throw new Error("fabric-fake: listCollections is never allowed"); }
        if (command.ping) return { ok: 1 };
        if (command.connectionStatus) return { ok: 1, authInfo: this.authInfo || { authenticatedUsers: [{ user: "reader", db: "admin" }], authenticatedUserRoles: [{ role: "read", db: name }], authenticatedUserPrivileges: [{ resource: { db: name, collection: "" }, actions: ["changeStream", "collStats", "dbHash", "dbStats", "find", "killCursors", "listCollections", "listIndexes", "listSearchIndexes"] }, { resource: { db: name, collection: "system.js" }, actions: ["find", "listIndexes"] }] } };
        throw new Error(`fabric-fake: unsupported command ${Object.keys(command)[0]}`);
      }
    };
  }
}

// ---- Synthetic FactSales rows (invented values; never real data) ----
let seq = 0;
const oid = () => { seq += 1; return ObjectId.createFromHexString((0xf0000000 + seq).toString(16).padStart(24, "0")); };
// One FactSales row with every verified field (null unless given). detail: a Business Central style line.
function row(fields = {}) {
  const { FIELD_NAMES } = require("../../src/fabric/fields");
  const doc = { _id: oid() };
  for (const name of FIELD_NAMES) doc[name] = null;
  return Object.assign(doc, { invoice_item_quantity: 1, invoice_item_amount: 10, sales_data_source: "Source One", invoice_date: new Date("2026-03-10T00:00:00Z") }, fields);
}

// ---- Synthetic FactInventory rows (an item-ledger look-alike; invented values; never real data) ----
// One row with every verified field (null unless given).
function invRow(fields = {}) {
  const { INVENTORY_FIELDS } = require("../../src/fabric/datasets");
  const doc = { _id: oid() };
  for (const name of INVENTORY_FIELDS) doc[name] = null;
  return Object.assign(doc, fields);
}
// n ledger entries over companies, locations and items, deterministic (seeded). Entry_No is unique per company; Posting_Date
// runs from 2026-01-01 over `days` days; every 10th entry has BC's blank Expiration_Date (0001-01-01); cost amounts, landed
// cost and prices are filled so that sensitive-field leaks would show.
function inventoryRows(n = 400, { days = 120, seed = 7 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const companies = ["Synthetic Co A", "Synthetic Co B", "SYNCO-C"];
  const next = Object.fromEntries(companies.map((c) => [c, 1000]));
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const company = pick(companies);
    next[company] += 1 + Math.floor(rnd() * 3);
    const qty = Math.floor(rnd() * 40) - 10;
    const entryType = pick(["Purchase", "Sale", "Positive Adjmt.", "Negative Adjmt.", "Transfer"]);
    const item = `ITEM-SYN-${String(1 + Math.floor(rnd() * 60)).padStart(3, "0")}`;
    rows.push(invRow({
      Entry_No: next[company], Posting_Date: new Date(Date.UTC(2026, 0, 1) + Math.floor(rnd() * days) * 86400000),
      Entry_Type: entryType, Document_Type: pick(["Sales Shipment", "Purchase Receipt", " ", "Transfer Receipt"]),
      Document_No: `DOC-SYN-${String(i).padStart(5, "0")}`, External_Document_No: rnd() < 0.8 ? "" : `EXT-${i}`, Document_Line_No: 10000 * (1 + (i % 4)),
      Item_No: item, Item_Description: `Synthetic item ${item.slice(-3)}`, Variant_Code: "", Description: "",
      Expiration_Date: i % 10 === 0 ? new Date("0001-01-01T00:00:00Z") : new Date(Date.UTC(2027, i % 12, 1)),
      Serial_No: rnd() < 0.7 ? "" : `SN-SYN-${i}`, Lot_No: rnd() < 0.6 ? "" : `LOT${String(i).padStart(6, "0")}`,
      Location_Code: pick(["WH-NORTH", "WH-SOUTH", "WH-EAST"]),
      Quantity: dec(qty), Invoiced_Quantity: dec(qty), Remaining_Quantity: dec(Math.max(0, qty)), Unit_of_Measure_Code: pick(["PCS", "BOX"]),
      Sales_Amount_Actual: dec(entryType === "Sale" ? qty * 10 : 0), Cost_Amount_Actual: dec((qty * 7.25).toFixed(2)), Cost_Amount_Expected: dec("0"),
      Completely_Invoiced: rnd() < 0.9, Open: qty > 0 && rnd() < 0.5, Company: company,
      item_name: `Synthetic item ${item.slice(-3)}`, landed_cost: String((rnd() * 100).toFixed(2)), distributors_price: "123", trade_price: "456",
      upstream_new_field: "never returned"
    }));
  }
  return rows;
}

// The JARC app with Microsoft Entra sign-in (on JARC's own fake MongoDB) and an optional Fabric Data stack.
async function startFabricApp({ issuer, fabricData = null, accessPolicy, betaOpenEditing = false, apiTokens = null, siteDir } = {}) {
  const { createEntraVerifier } = require("../../src/auth/entra-token");
  const fake = new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const logger = { errors: [], warnings: [], error(...args) { this.errors.push(args.map(String).join(" ")); }, warn(...args) { this.warnings.push(args.map(String).join(" ")); } };
  const dataLayer = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), environment: "test" });
  const verify = createEntraVerifier({ ...issuer.config, keySet: issuer.keySet });
  const app = createApp({ repository: new MemoryStateRepository(), environment: "test", logger, dataLayer, auth: { mode: "entra", entra: issuer.config, verify }, fabricData, betaOpenEditing, ...(accessPolicy ? { accessPolicy } : {}), ...(apiTokens ? { apiTokens } : {}), ...(siteDir ? { siteDir } : {}) });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  server.keepAliveTimeout = 30000; server.headersTimeout = 31000;
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, app, logger, dataLayer, close: () => { app.locals.realtime?.closeAll(); return new Promise((resolve) => server.close(resolve)); } };
}

module.exports = { FabricFakeClient, row, invRow, inventoryRows, oid, startFabricApp, DEFAULT_INDEXES, INVENTORY_INDEXES, ID_ONLY, serverError, dec };
