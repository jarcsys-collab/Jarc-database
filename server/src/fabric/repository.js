// The ONLY module that talks to the Fabric database driver, and only to read the datasets' collections (datasets.js: FactSales
// and FactInventory; connection.js refuses any other name). It has no write method of any kind, never lists collections, and
// builds every query itself from validated, typed parameters (client text only ever becomes an escaped regular expression or
// an equality value, never a field name or an operator). Every query carries maxTimeMS, a limit and an explicit projection, and
// a hint naming a detected index unless the caller (source.js small-collection mode) passes unindexed: true. Sensitive fields
// (landed cost, cost amounts, prices) are projected only when the caller asks for them.
const { Decimal128 } = require("mongodb");
const { FIELD_NAMES, COST_FIELD, DOTTED_FIELD, HEADER_FIELDS, isRestricted } = require("./fields");
const { DATASETS } = require("./datasets");
const { translateDriverError, describe, fabricError } = require("./errors");

const SALES = DATASETS.sales.collection;
// Stages and operators that write, run code, or read another collection: refused anywhere in a pipeline.
const FORBIDDEN = new Set(["$out", "$merge", "$function", "$accumulator", "$where", "$lookup", "$graphLookup", "$unionWith", "$documents", "$currentOp", "$listSessions", "$listLocalSessions", "$planCacheStats"]);
function assertSafePipeline(pipeline) {
  if (!Array.isArray(pipeline) || !pipeline.length || !pipeline[0]?.$match) throw new Error("fabric repository: a pipeline must start with $match.");
  if (!pipeline.some((stage) => stage.$limit !== undefined)) throw new Error("fabric repository: a pipeline needs a $limit.");
  if (!pipeline.some((stage) => stage.$project !== undefined)) throw new Error("fabric repository: a pipeline needs an explicit $project.");
  const walk = (node, depth) => {
    if (depth > 40) throw new Error("fabric repository: pipeline nested too deeply.");
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (node === null || typeof node !== "object" || node instanceof Date || node._bsontype) return;
    for (const key of Object.keys(node)) {
      if (FORBIDDEN.has(key)) throw new Error(`fabric repository: ${key} is never allowed.`);
      walk(node[key], depth + 1);
    }
  };
  walk(pipeline, 0);
}
const assertInclusion = (projection) => {
  if (!projection || typeof projection !== "object" || !Object.keys(projection).length || Object.entries(projection).some(([k, v]) => v !== 1 || k.includes(".") || k.startsWith("$"))) throw new Error("fabric repository: find needs an explicit inclusion projection.");
};

// landed_cost is text: converted to decimal, null when missing, empty or not a number. MongoDB converts "nan", "NaN",
// "Infinity" and "-inf" to non-finite decimals (which would turn every sum they touch into NaN), so only a finite result is kept:
// NaN sorts below -Infinity, so "above -Infinity and below Infinity" is exactly "finite".
const CONVERTED_COST = Object.freeze({ $convert: { input: "$" + COST_FIELD, to: "decimal", onError: null, onNull: null } });
const LANDED_COST = Object.freeze({ $cond: [{ $and: [{ $gt: [CONVERTED_COST, Decimal128.fromString("-Infinity")] }, { $gt: [Decimal128.fromString("Infinity"), CONVERTED_COST] }] }, CONVERTED_COST, null] });
const present = (expr) => ({ $ne: [{ $ifNull: [expr, null] }, null] });
// A non-null string sort key for a nullable value: null first ("0"), then the value ("1…").
const sortable = (expr) => ({ $cond: [present(expr), { $concat: ["1", { $toString: expr }] }, "0"] });
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const prefix = (field, q, ci) => ({ [field]: { $regex: `^${escapeRegex(q)}`, ...(ci ? { $options: "i" } : {}) } });
const contains = (field, q) => ({ [field]: { $regex: escapeRegex(q), $options: "i" } });
const INVOICE_SEARCH = (q) => [prefix("invoice_id", q, true), prefix("customer_id", q, false), contains("customer_name", q), contains("external_document_no", q)];

// company: undefined = any; null = no company (null or missing); text = exactly that.
const invoiceKey = (company, invoiceNo) => ({ Company: company, invoice_id: invoiceNo });
function windowMatch({ from, toExcl, company, q }, search) {
  const match = { invoice_date: { $gte: from, $lt: toExcl } };
  if (company !== undefined) match.Company = company;
  if (q && search) match.$or = search(q);
  return match;
}
const and = (...filters) => { const parts = filters.filter((f) => f && Object.keys(f).length); return parts.length > 1 ? { $and: parts } : parts[0] || {}; };

// Keyset: documents strictly after `values` in the order `keys` ([[field, 1|-1], …]). BSON order puts null (and missing) first.
function after(keys, values) {
  if (!values) return null;
  const branches = [];
  keys.forEach(([field, dir], i) => {
    const v = values[i];
    let cond;
    if (dir === 1) cond = v === null ? { [field]: { $ne: null } } : { [field]: { $gt: v } };
    else if (v === null) return; // nothing comes after null going down
    else cond = { $or: [{ [field]: { $lt: v } }, { [field]: null }] };
    const equal = keys.slice(0, i).map(([f], j) => ({ [f]: values[j] }));
    branches.push(equal.length ? { $and: [...equal, cond] } : cond);
  });
  return branches.length ? { $or: branches } : { _id: { $in: [] } };
}

// Keyset for a query that streams in an index's order (sales lines, an invoice's lines). The `after` $or above can't be used
// there: MongoDB plans its branches as separate index scans merged by SORT_MERGE, and that merge orders a missing field before
// null (the index treats both as null), so pages could skip or repeat rows wherever Company is missing on some rows and null
// on others. Here the keyset is one $expr filter (missing read as null, values as $literal, BSON order across types) and only
// the leading key becomes index bounds, so the plan is a single IXSCAN in index order. A descending leading key must never be
// null (invoice_date: the date window excludes null).
const field = (name) => ({ $ifNull: ["$" + name, null] });
// pinned: how many leading keys the query already fixes by equality (inventory entryNo: Company, always given). They're left
// out, so the next key (Entry_No) becomes the index bound and a later page starts at its position instead of re-walking the
// whole company from its first entry.
function afterInOrder(allKeys, allValues, pinned = 0) {
  if (!allValues) return null;
  const keys = allKeys.slice(pinned), values = allValues.slice(pinned);
  const branches = keys.map(([name, dir], i) => {
    const equal = keys.slice(0, i).map(([f], j) => ({ $eq: [field(f), { $literal: values[j] }] }));
    return { $and: [...equal, { [dir === 1 ? "$gt" : "$lt"]: [field(name), { $literal: values[i] }] }] };
  });
  const [[lead, dir]] = keys;
  // After a null lead value: going up, anything; going down, only the other null (or missing) ones.
  const bound = values[0] === null ? (dir === 1 ? {} : { [lead]: null }) :{ [lead]: { [dir === 1 ? "$gte" : "$lte"]: values[0] } };
  return and(bound, { $expr: { $or: branches } });
}

// Invoice list: sort orders over the grouped invoices (skc / skn are the null-safe company and customer-name keys).
const INVOICE_SORTS = Object.freeze({ invoiceDate: ["invoiceDate", "skc", "invoiceNo"], invoiceNo: ["invoiceNo", "skc"], customerName: ["skn", "skc", "invoiceNo"], amount: ["amount", "skc", "invoiceNo"] });
const invoiceSortKeys = (sort, dir) => INVOICE_SORTS[sort].map((field) => [field, dir]);
// Lines of one invoice: Line_No ascending (nulls first), then _id.
const LINE_KEYS = Object.freeze([["Line_No", 1], ["_id", 1]]);
// A dataset sort's keys for a direction (-1 desc / 1 asc on the lead field): the other keys follow the index or its exact
// reverse, so the query walks one index in order.
function sortKeys(sort, dir) {
  const flip = sort.keys.find(([f]) => f === sort.lead)[1] === dir ? 1 : -1;
  return sort.keys.map(([f, d]) => [f, d * flip]);
}
const toSort = (keys) => Object.fromEntries(keys);

const COST_ACCUMULATORS = Object.freeze({
  costSum: { $sum: { $cond: [present("$lc"), { $multiply: ["$invoice_item_quantity", "$lc"] }, 0] } },
  costAmount: { $sum: { $cond: [present("$lc"), "$invoice_item_amount", 0] } },
  rowsWithCost: { $sum: { $cond: [present("$lc"), 1, 0] } }
});
const COST_OUTPUTS = Object.freeze({
  costLanded: { $cond: [{ $eq: ["$rowsWithCost", 0] }, null, "$costSum"] },
  costProfit: { $cond: [{ $eq: ["$rowsWithCost", 0] }, null, { $subtract: ["$costAmount", "$costSum"] }] },
  costMargin: { $cond: [{ $or: [{ $eq: ["$rowsWithCost", 0] }, { $eq: ["$costAmount", 0] }] }, null, { $toDouble: { $multiply: [{ $divide: [{ $subtract: ["$costAmount", "$costSum"] }, "$costAmount"] }, 100] } }] },
  rowsWithCost: 1
});
const TOTALS = Object.freeze({
  rows: { $sum: 1 }, lineDetailRows: { $sum: { $cond: [present("$Line_No"), 1, 0] } },
  amount: { $sum: "$invoice_item_amount" }, quantity: { $sum: "$invoice_item_quantity" },
  // Repeated on every row and often null: the largest value, never a sum.
  headerTotal: { $max: "$invoice_total_amount" }, sources: { $addToSet: "$sales_data_source" }
});
const LINE_FIELDS = Object.freeze(["_id", "Line_No", "invoice_item_id", "invoice_item_name", "Description_2", "invoice_item_quantity", "invoice_item_amount", "invoice_item_quantity_sales", "invoice_item_amount_sales", "Unit_Price", "uom_code", "uom", "sales_data_source", "sales_type"]);
const ones = (fields) => Object.fromEntries(fields.map((f) => [f, 1]));
// Per line: cost = quantity × landed cost per unit; profit = amount − cost; margin = profit / amount × 100.
const LINE_COST_STAGES = Object.freeze([
  { $addFields: { lineCost: { $cond: [present("$lc"), { $multiply: ["$invoice_item_quantity", "$lc"] }, null] } } },
  { $addFields: {
    lineProfit: { $cond: [present("$lineCost"), { $subtract: ["$invoice_item_amount", "$lineCost"] }, null] },
    lineMargin: { $cond: [{ $or: [{ $eq: [{ $ifNull: ["$lineCost", null] }, null] }, { $eq: ["$invoice_item_amount", 0] }] }, null, { $toDouble: { $multiply: [{ $divide: [{ $subtract: ["$invoice_item_amount", "$lineCost"] }, "$invoice_item_amount"] }, 100] } }] }
  } }
]);
const lineProjection = (cost, extra = []) => ({ ...ones([...LINE_FIELDS, ...extra]), ...(cost ? { lc: LANDED_COST } : {}) });

// At most `max` Fabric database operations at once in this process (fewer than the pool, so a connection stays free for
// others); the rest wait up to waitMs for a slot, then fail with 503 FABRIC_BUSY instead of queueing behind slow queries.
class InFlightLimit {
  constructor({ max, waitMs }) {
    this.max = Math.max(1, max);
    this.waitMs = waitMs;
    this.active = 0;
    this.waiting = [];
  }

  acquire() {
    if (this.active < this.max) { this.active += 1; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => { this.waiting.splice(this.waiting.indexOf(entry), 1); reject(fabricError("FABRIC_BUSY")); }, this.waitMs);
      this.waiting.push(entry);
    });
  }

  // Hands the slot straight to the next waiter, if any.
  release() {
    const next = this.waiting.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); } else this.active -= 1;
  }
}

class FabricRepository {
  // connection: a FabricConnection. onInvalidate(kind): called with "source" or "index" when a query shows the collection or an
  // index is gone (indexes.js drops its cache). maxInFlight / busyWaitMs: the process-wide operation limit (InFlightLimit).
  constructor({ connection, queryTimeMs = 8000, logger = console, onInvalidate = () => {}, maxInFlight = 4, busyWaitMs = 1000 }) {
    this.connection = connection;
    this.queryTimeMs = queryTimeMs;
    this.logger = logger;
    this.onInvalidate = onInvalidate;
    this.inFlight = new InFlightLimit({ max: maxInFlight, waitMs: busyWaitMs });
  }

  async run(collection, fn) {
    await this.inFlight.acquire(); // throws FABRIC_BUSY
    try {
      return await fn(await this.connection.collection(collection));
    } catch (error) {
      const mapped = translateDriverError(error);
      if (mapped.kind) this.onInvalidate(mapped.kind, collection);
      if (mapped.error.code === "FABRIC_UNAVAILABLE" && error !== mapped.error) this.logger.warn?.(`[fabric] query failed: ${describe(error)}`);
      throw mapped.error;
    } finally {
      this.inFlight.release();
    }
  }

  // ---- Guarded primitives (read only) ----
  // collection: a datasets.js collection name (FactSales by default). hint: an index name. unindexed: true only in
  // small-collection mode (source.js decides; the query still has maxTimeMS, a $limit and a $project).
  // maxTimeMs: a shorter server time limit for this one query (never longer than queryTimeMs).
  aggregate(pipeline, { hint, unindexed = false, collection = SALES, maxTimeMs = null }) {
    assertSafePipeline(pipeline);
    if (!hint && unindexed !== true) throw new Error("fabric repository: every query needs a hint.");
    const maxTimeMS = Number.isInteger(maxTimeMs) && maxTimeMs > 0 ? Math.min(maxTimeMs, this.queryTimeMs) : this.queryTimeMs;
    return this.run(collection, (c) => c.aggregate(pipeline, { ...(hint ? { hint } : {}), maxTimeMS, allowDiskUse: false }).toArray());
  }

  countDocuments(filter, { hint, limit, unindexed = false, collection = SALES }) {
    if ((!hint && unindexed !== true) || !Number.isInteger(limit) || limit < 1) throw new Error("fabric repository: a count needs a hint and a limit.");
    return this.run(collection, (c) => c.countDocuments(filter, { ...(hint ? { hint } : {}), limit, maxTimeMS: this.queryTimeMs }));
  }

  find(filter, { projection, sort, hint, limit, collection = SALES }) {
    assertInclusion(projection);
    if (!hint || !Number.isInteger(limit) || limit < 1) throw new Error("fabric repository: a find needs a hint and a limit.");
    return this.run(collection, (c) => c.find(filter, { projection, ...(sort ? { sort } : {}), hint, limit, maxTimeMS: this.queryTimeMs }).toArray());
  }

  // The collection's indexes; throws FABRIC_SOURCE_MISSING when it doesn't exist.
  listIndexes(collection = SALES) { return this.run(collection, (c) => c.listIndexes({ maxTimeMS: this.queryTimeMs }).toArray()); }

  // From collection metadata (no scan).
  estimate(collection = SALES) { return this.run(collection, (c) => c.estimatedDocumentCount({ maxTimeMS: this.queryTimeMs })); }

  // ---- Dataset explorers ----
  // Documents matching `filter` (built by the service from validated values), counted only up to `limit`.
  countMatching(dataset, filter, { hint, limit }) { return this.countDocuments(filter, { collection: dataset.collection, limit, ...(hint ? { hint } : { unindexed: true }) }); }

  // One page of records: `match`, in `keys` order, limit + 1 rows, projected to `fields` plus the sort keys and _id.
  // Indexed: $match, $sort, $limit, $project (one index walked in order). Small mode: $match, $project, $sort, $limit (sorted
  // in memory over the projected fields only).
  records(dataset, { match, keys, limit, fields, hint }) {
    const projection = { $project: datasetProjection([...new Set([...fields, ...keys.map(([f]) => f).filter((f) => f !== "_id")])]) };
    const sort = { $sort: toSort(keys) }, lim = { $limit: limit + 1 };
    const pipeline = hint ? [{ $match: match }, sort, lim, projection] : [{ $match: match }, projection, sort, lim];
    return this.aggregate(pipeline, { collection: dataset.collection, ...(hint ? { hint } : { unindexed: true }) });
  }

  // Distinct values of one allow-listed (never sensitive, never dotted) field, for the value picker (values.js):
  //   $match (window + context + search + `after`) → $limit rowCap + 1 (a bound on MATCHED rows; values.js counts the window first when the match is selective) → $project (null, missing, "" and " "
  //   become one blank bucket: null) → $group (value, rows) → $facet { values: by value in BSON order (blank first), limit + 1;
  //   scanned: the rows grouped }.
  // Indexed mode hints the dataset's index (the date window is its bound); small mode runs unindexed over a collection of at
  // most FABRIC_UNINDEXED_SCAN_MAX documents. → { values: [{ _id, n }], rows }.
  async distinctValues(dataset, { match, field, rowCap, limit, hint, maxTimeMs }) {
    if (typeof field !== "string" || !dataset.fields.includes(field) || field.includes(".") || field.startsWith("$") || dataset.sensitive.includes(field)) throw new Error("fabric repository: values need an allow-listed, non-sensitive field.");
    if (!Number.isInteger(rowCap) || rowCap < 1 || !Number.isInteger(limit) || limit < 1) throw new Error("fabric repository: values need a row cap and a limit.");
    const ref = "$" + field;
    const blank = { $or: [{ $eq: [{ $ifNull: [ref, null] }, null] }, { $eq: [ref, ""] }, { $eq: [ref, " "] }] };
    const pipeline = [
      { $match: match },
      { $limit: rowCap + 1 },
      { $project: { _id: 0, v: { $cond: [blank, null, ref] } } },
      { $group: { _id: "$v", n: { $sum: 1 } } },
      { $facet: { values: [{ $sort: { _id: 1 } }, { $limit: limit + 1 }], scanned: [{ $group: { _id: null, rows: { $sum: "$n" } } }] } }
    ];
    const [out] = await this.aggregate(pipeline, { collection: dataset.collection, maxTimeMs, ...(hint ? { hint } : { unindexed: true }) });
    return { values: out?.values || [], rows: out?.scanned?.[0]?.rows ?? 0 };
  }

  // One record by _id with the given fields (the _id index always exists, so this is the same in every mode).
  async record(dataset, { id, fields }) {
    const [doc] = await this.aggregate([{ $match: { _id: id } }, { $limit: 1 }, { $project: datasetProjection(fields) }], { collection: dataset.collection, hint: "_id_" });
    return doc || null;
  }

  // ---- Invoice views (FactSales, FABRIC_INVOICE_VIEWS) ----
  // Rows in a date window (+ company), counted only up to max + 1.
  countWindow(window, { hint, max }) { return this.countDocuments(windowMatch({ ...window, q: null }), { hint, limit: max + 1 }); }

  // One page of invoices grouped from a date window, plus window totals and the companies in it.
  async invoiceList({ window, sort, dir, cursorValues, limit, cost, hint, rowLimit }) {
    const keys = invoiceSortKeys(sort, dir);
    const keyset = after(keys, cursorValues);
    const pipeline = [
      { $match: windowMatch(window, INVOICE_SEARCH) },
      { $limit: rowLimit },
      { $project: { _id: 0, ...ones(["Company", "invoice_id", "invoice_date", "invoice_due_date", "customer_id", "customer_name", "Line_No", "invoice_item_amount", "invoice_item_quantity", "invoice_total_amount", "sales_data_source", "is_invoice_cancelled", "is_invoice_closed"]), ...(cost ? { lc: LANDED_COST } : {}) } },
      { $group: {
        _id: { c: { $ifNull: ["$Company", null] }, i: "$invoice_id" },
        invoiceDate: { $min: "$invoice_date" }, dueDate: { $max: "$invoice_due_date" }, customerId: { $max: "$customer_id" }, customerName: { $max: "$customer_name" },
        cancelled: { $max: "$is_invoice_cancelled" }, closed: { $max: "$is_invoice_closed" }, ...TOTALS, ...(cost ? COST_ACCUMULATORS : {})
      } },
      { $project: { _id: 0, company: "$_id.c", invoiceNo: "$_id.i", ...ones(["invoiceDate", "dueDate", "customerId", "customerName", "cancelled", "closed", "rows", "lineDetailRows", "amount", "quantity", "headerTotal", "sources"]), skc: sortable("$_id.c"), skn: sortable("$customerName"), ...(cost ? COST_OUTPUTS : {}) } },
      { $facet: {
        items: [...(keyset ? [{ $match: keyset }] : []), { $sort: toSort(keys) }, { $limit: limit + 1 }],
        total: [{ $group: { _id: null, invoices: { $sum: 1 }, rows: { $sum: "$rows" } } }],
        companies: [{ $group: { _id: "$company", rows: { $sum: "$rows" } } }, { $sort: { rows: -1, _id: 1 } }, { $limit: 100 }]
      } }
    ];
    const [result] = await this.aggregate(pipeline, { hint });
    return { items: result?.items || [], total: result?.total?.[0] || { invoices: 0, rows: 0 }, companies: result?.companies || [], keys: keys.map(([f]) => f) };
  }

  // One invoice's totals and header. Each header value is the first non-null one in line order (Line_No, nulls first, then
  // _id), kept in constant memory: $min over { n: Line_No, i: _id, v: value } for the rows that have a value ($min skips
  // nulls, and documents compare field by field, so the smallest is the earliest line). h_<field>.v is the value.
  async invoiceSummary({ company, invoiceNo, cost, hint, rowLimit }) {
    // territory is Custom.2: a restricted field, so only for sensitive (cost) readers.
    const headerFields = [...HEADER_FIELDS, ...(cost ? ["territory"] : []), "dueDate", "customerId", "customerName"];
    const source = (f) => ({ dueDate: "$invoice_due_date", customerId: "$customer_id", customerName: "$customer_name" }[f] || `$${f}`);
    const firstInLineOrder = (expr) => ({ $min: { $cond: [present(expr), { n: { $ifNull: ["$Line_No", null] }, i: "$_id", v: expr }, null] } });
    const pipeline = [
      { $match: invoiceKey(company, invoiceNo) },
      { $sort: { Line_No: 1, _id: 1 } },
      { $limit: rowLimit },
      { $project: { _id: 1, ...ones(["invoice_date", "invoice_due_date", "customer_id", "customer_name", "Line_No", "invoice_item_amount", "invoice_item_quantity", "invoice_total_amount", "sales_data_source", "sales_type", ...HEADER_FIELDS]), ...(cost ? { territory: { $getField: DOTTED_FIELD }, lc: LANDED_COST } : {}) } },
      { $group: {
        _id: null, ...TOTALS, salesTypes: { $addToSet: "$sales_type" }, firstDate: { $min: "$invoice_date" }, lastDate: { $max: "$invoice_date" },
        ...Object.fromEntries(headerFields.map((f) => [`h_${f}`, firstInLineOrder(source(f))])),
        ...(cost ? COST_ACCUMULATORS : {})
      } },
      { $project: { _id: 0, ...ones(["rows", "lineDetailRows", "amount", "quantity", "headerTotal", "sources", "salesTypes", "firstDate", "lastDate", ...headerFields.map((f) => `h_${f}`)]), ...(cost ? COST_OUTPUTS : {}) } }
    ];
    const [summary] = await this.aggregate(pipeline, { hint });
    return summary || null;
  }

  // One page of an invoice's lines.
  invoiceLines({ company, invoiceNo, cursorValues, limit, cost, hint }) {
    return this.aggregate([
      { $match: and(invoiceKey(company, invoiceNo), afterInOrder(LINE_KEYS, cursorValues)) },
      { $sort: toSort(LINE_KEYS) },
      { $limit: limit + 1 },
      { $project: lineProjection(cost) },
      ...(cost ? LINE_COST_STAGES : [])
    ], { hint });
  }

  // One line with every verified field (Custom.2 through $getField), found by _id within its invoice.
  async line({ company, invoiceNo, id, cost }) {
    const fields = FIELD_NAMES.filter((f) => f !== DOTTED_FIELD && (cost || !isRestricted(f)));
    const [doc] = await this.aggregate([
      { $match: { _id: id, ...invoiceKey(company, invoiceNo) } },
      { $limit: 1 },
      { $project: { _id: 1, ...ones(fields), ...(cost ? { custom2: { $getField: DOTTED_FIELD } } : {}) } }
    ], { hint: "_id_" });
    return doc || null;
  }

}

// An inclusion projection for allow-listed field names. A dotted name ("Custom.2") is read with $getField under an alias: a
// dotted inclusion would mean a sub-document path.
const dottedAlias = (name) => `dot_${Buffer.from(name).toString("hex")}`;
const datasetProjection = (fields) => ({ _id: 1, ...Object.fromEntries(fields.map((f) => (f.includes(".") ? [dottedAlias(f), { $getField: f }] : [f, 1]))) });
const valueOf = (doc, name) => (name.includes(".") ? doc[dottedAlias(name)] : doc[name]);

module.exports = { FabricRepository, InFlightLimit, assertSafePipeline, after, afterInOrder, and, sortKeys, LINE_KEYS, INVOICE_SORTS, escapeRegex, prefix, contains, valueOf, SALES };
