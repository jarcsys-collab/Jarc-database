// Fabric Data value discovery for the filter value picker (session API only; the router mounts it with `advanced`).
//
//   const values = new FabricValues({ repository, sources, config, now, context?, cacheMs?, clock? });
//   await values.list(name, rawQuery, access)   // GET /:dataset/values
//
// name: a datasets.js name the router has already authorised (datasetOf). rawQuery: req.query. access: the router's accessOf()
// result ({ datasets, sensitive, … }). Throws ApiError 400 VALIDATION_ERROR (details { path, reason }; values never echoed) or a
// Fabric error (FABRIC_INDEX_REQUIRED, FABRIC_TIMEOUT, FABRIC_BUSY, …) exactly like the records route.
//
// Query parameters (each once, as text; anything else is refused):
//   field     required. Only the fields in VALUE_FIELDS below (category = "distinct", identifiers and names = "search"). A field the
//             caller can't see (sensitive without permission, or not in the dataset) is "Unknown field."; a visible field without
//             a value list (dates, numbers, booleans, sensitive, constant or dotted fields) is "This field has no value list."
//   q         optional search, 1–100 characters, no control characters. Matched as an escaped, case-insensitive regex: anchored
//             prefix for identifier fields (match "prefix"), contains otherwise. Never a raw regex.
//   after     optional keyset: values strictly after this one in sort order (the last page's nextAfter). "" = after the blank
//             bucket. At most 400 characters.
//   limit     1–1000, default 100.
//   filter    optional context: the other active filters (base64url canonical v1 model, filter-model.js). The conditions on
//             `field` itself are removed first (a top-level AND condition is dropped; an OR group that mentions it is dropped
//             whole), so the picker never narrows itself. Compiled by filter-compile.js; never client text as an operator.
//   dateFrom / dateTo   the date window (UTC days, inclusive). Sales (indexed mode) ALWAYS runs inside a window: the dataset
//             default (30 days ending at its latest date) or the given one, at most 92 days. Inventory in small mode may have none.
//
// Answer (200):
//   { dataset, field, values: [{ value, count?, blank? }], complete, limited, nextAfter, next, contextual, window, mode, access }
//   value: the stored value as JSON carries it (strings stay strings; Decimal128 → exact text, Date → ISO, as service.plain),
//          null for the blank bucket (null, missing, "" and " " together; blank: true, first in the list).
//   count: rows per value, ONLY when complete (every row in range was grouped and every value is listed).
//   complete: false when the row cap was reached or more values follow.
//   limited: null | { reason: "rowCap" | "valueLimit", rowsScanned, rowCap }.
//   nextAfter (alias next): pass as `after` for the next page; null when there is nothing more.
//
// Query: one aggregate (repository.distinctValues): $match window + context + q + after → $limit rowCap+1 → $project → $group →
// $facet sort/limit+1, maxTimeMS FABRIC_VALUES_TIME_MS (default 2000, never above queryTimeMs), hinted in indexed mode. Rate
// limits and per-caller concurrency are the Fabric router's (fabricLimiter), shared with every other Fabric route.
// rowCap (20,000) caps MATCHED rows. With q, after or a context the window is first counted (countMatching, hinted, up to
// FABRIC_MAX_WINDOW_ROWS + 1) and a larger window is refused with FABRIC_RANGE_TOO_LARGE, so the rows examined are bounded too.
// Cache: at most 500 entries and about 5 MB in all (least recently used out), an in-process 60 s cache keyed by dataset, field, q, after, limit, resolved window, canonical filter, mode and the
// caller's sensitive flag (dataset authorisation is checked by the router before this runs). cacheMs: 0 turns it off.
const { ApiError } = require("../middleware/errors");
const { fabricError } = require("./errors");
const { DATASET_NAMES, datasetNamed } = require("./datasets");
const filterModel = require("./filter-model");
const { and, escapeRegex } = require("./repository");
const { resolveWindow } = require("./validation");
const { plain } = require("./service");

const fail = (message, path, reason) => { throw new ApiError(400, "VALIDATION_ERROR", message, { path, reason }); };
const CONTROL = /[\u0000-\u001f\u007f]/;
const VALUE_LIMITS = Object.freeze({ defaultLimit: 100, maxLimit: 1000, maxQ: 100, maxAfter: 400, maxFilter: 6000, rowCap: 20000, timeMs: 2000, cacheMs: 60000, cacheEntries: 500, cacheBytes: 5 * 1024 * 1024 });

// The fields with a value list come from datasets.js `filtering` through filter-model.valueSource (B1, the single source of
// truth): "distinct" (categories, few values) or "search" (identifiers and names: the client should ask with q). The match for
// q: "prefix" (anchored) for the identifier fields below, "contains" for names and categories. Both case-insensitive.
const PREFIX_FIELDS = Object.freeze({
  sales: Object.freeze(["customer_id", "invoice_item_id", "Order_No"]),
  inventory: Object.freeze(["Item_No", "Document_No", "Lot_No", "Serial_No", "Source_No"])
});
const VALUE_FIELDS = Object.freeze(Object.fromEntries(DATASET_NAMES.map((name) => {
  const ds = datasetNamed(name);
  const entries = ds.fields.map((f) => [f, filterModel.valueSource(ds, f)]).filter(([, source]) => source !== "none")
    .map(([f, source]) => [f, Object.freeze({ source, match: PREFIX_FIELDS[name].includes(f) ? "prefix" : "contains" })]);
  return [name, Object.freeze(Object.fromEntries(entries))];
})));
// Self-check at load: every value field is allow-listed, string-typed, never sensitive, never dotted.
for (const [name, fields] of Object.entries(VALUE_FIELDS)) {
  const ds = datasetNamed(name);
  for (const f of Object.keys(fields)) {
    if (!ds.fields.includes(f) || ds.sensitive.includes(f) || f.includes(".") || (ds.types[f] || "string") !== "string") throw new Error(`fabric/values: ${name} offers values for a field it may not.`);
  }
}
// "distinct" | "search" | "none".
const valueSourceOf = (dsName, field) => (Object.hasOwn(VALUE_FIELDS[dsName] || {}, field) ? VALUE_FIELDS[dsName][field].source : "none");

function params(query) {
  const allowed = ["field", "q", "after", "limit", "filter", "dateFrom", "dateTo"];
  const out = {};
  for (const key of Object.keys(query || {})) {
    if (!allowed.includes(key)) fail("Unknown parameter.", key.slice(0, 40).replace(new RegExp(CONTROL.source, "g"), ""), "unknownParameter");
    if (typeof query[key] !== "string") fail(`${key} must be given once.`, key, "repeated");
    out[key] = query[key];
  }
  return out;
}
function utcDay(text, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`${label} must be a date such as 2026-01-31.`, label, "date");
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) fail(`${label} is not a real date.`, label, "date");
  return date;
}

// The other active filters as a MongoDB match, through B1's filter-model.js (parse, validate, canonical) and filter-compile.js
// (compileFilter, withoutField), read only. filter-compile.js is loaded lazily: until it exists, filter= is refused here.
// Tests inject the same three-function adapter.
function defaultContext() {
  let compiler;
  try { compiler = require("./filter-compile"); } catch (error) { if (error?.code === "MODULE_NOT_FOUND") return null; throw error; }
  if (typeof compiler.compileFilter !== "function") return null;
  return {
    parse: (text, ds, { now }) => filterModel.validateFilter(ds, filterModel.parseFilterParam(text), { now }), // 400s
    strip: typeof compiler.withoutField === "function" ? (m, field) => compiler.withoutField(m, field) : null,
    canonical: (m) => filterModel.canonicalJson(m),
    compile: (m, ds, { now }) => compiler.compileFilter(ds, m, { now })
  };
}

// The model without the conditions on `field`: AND groups drop them, an OR group mentioning it is dropped whole (a superset:
// the picker never hides a value because of its own field). null when nothing is left.
const mentions = (node, field) => (node && Array.isArray(node.items) ? node.items.some((n) => mentions(n, field)) : node?.field === field);
function stripField(node, field) {
  if (!node || typeof node !== "object") return null;
  if (!Array.isArray(node.items)) return node.field === field ? null : node;
  if (node.op === "or") return mentions(node, field) ? null : node;
  const items = node.items.map((n) => stripField(n, field)).filter(Boolean);
  return items.length ? { ...node, items } : null;
}

class FabricValues {
  // repository: FabricRepository; sources: { [dataset]: DatasetSource }; config: config.fabricData; now: for tests.
  // context: the filter adapter (defaultContext); cacheMs / clock: the result cache.
  constructor({ repository, sources = {}, config = {}, now = () => new Date(), context, cacheMs = VALUE_LIMITS.cacheMs, clock = Date.now, cacheBytes = VALUE_LIMITS.cacheBytes }) {
    this.cacheBytes = cacheBytes;
    this.cachedBytes = 0;
    this.repository = repository;
    this.sources = sources;
    this.config = config;
    this.now = now;
    this.context = context === undefined ? undefined : context; // undefined: resolved lazily
    this.cacheMs = cacheMs;
    this.clock = clock;
    this.cache = new Map();
  }

  get rowCap() { return Math.max(1, Math.min(this.config.valuesRowCap ?? VALUE_LIMITS.rowCap, this.config.maxWindowRows ?? 50000)); }
  get timeMs() { return Math.min(this.config.valuesTimeMs ?? VALUE_LIMITS.timeMs, this.config.queryTimeMs ?? 8000); }
  filterContext() { if (this.context === undefined) this.context = defaultContext(); return this.context; }

  // The request checked against the dataset's value fields, before any database call.
  parse(ds, rawQuery, sensitive) {
    const p = params(rawQuery);
    if (p.field === undefined || !p.field.length || p.field.length > 80) fail("field is required.", "field", "required");
    // The field name used from here on is the allow-list's own string, never the client's.
    const field = ds.fields.find((f) => f === p.field);
    if (!field || (!sensitive && ds.sensitive.includes(field))) fail("Unknown field.", "field", "unknownField");
    const def = VALUE_FIELDS[ds.name][field];
    if (!def) fail("This field has no value list.", "field", "noValueList");
    let q = null;
    if (p.q !== undefined) {
      q = p.q.trim();
      if (q.length > VALUE_LIMITS.maxQ || CONTROL.test(q)) fail(`q must be at most ${VALUE_LIMITS.maxQ} characters.`, "q", "text");
      if (!q) q = null;
    }
    let after = null;
    if (p.after !== undefined) {
      if (p.after.length > VALUE_LIMITS.maxAfter || CONTROL.test(p.after)) fail("after is not valid.", "after", "text");
      after = p.after;
    }
    let limit = VALUE_LIMITS.defaultLimit;
    if (p.limit !== undefined) {
      if (!/^\d{1,4}$/.test(p.limit) || Number(p.limit) < 1 || Number(p.limit) > VALUE_LIMITS.maxLimit) fail(`limit must be a whole number from 1 to ${VALUE_LIMITS.maxLimit}.`, "limit", "range");
      limit = Number(p.limit);
    }
    const from = p.dateFrom !== undefined ? utcDay(p.dateFrom, "dateFrom") : null;
    const to = p.dateTo !== undefined ? utcDay(p.dateTo, "dateTo") : null;
    if (from && to && from > to) fail("dateFrom must be on or before dateTo.", "dateFrom", "order");
    let filter = null;
    if (p.filter !== undefined) {
      if (!p.filter.length || p.filter.length > VALUE_LIMITS.maxFilter || !/^[A-Za-z0-9_-]+$/.test(p.filter)) fail("filter is not valid.", "filter", "encoding");
      filter = p.filter;
    }
    return { field, def, q, after, limit, from, to, filter };
  }

  // The context match (the other filters) and its canonical text, or nulls.
  contextOf(ds, query, sensitive, window) {
    if (!query.filter) return { match: null, canonical: null };
    const ctx = this.filterContext();
    if (!ctx) fail("filter is not supported here.", "filter", "unsupported");
    const model = ctx.parse(query.filter, ds, { sensitive, now: this.now() });
    const rest = (ctx.strip || stripField)(model, query.field);
    if (!rest || (Array.isArray(rest.items) && !rest.items.length)) return { match: null, canonical: null };
    return { match: ctx.compile(rest, ds, { sensitive, now: this.now(), window }) || null, canonical: ctx.canonical(rest) };
  }

  async list(name, rawQuery, access) {
    const ds = datasetNamed(name);
    const source = this.sources[name];
    if (!ds || !source) throw new Error("fabric values: no such dataset source.");
    const sensitive = access?.sensitive === true;
    const query = this.parse(ds, rawQuery, sensitive); // 400s before any database call
    const plan = await source.plan(ds.defaultSort); // FABRIC_INDEX_REQUIRED before any query (small mode: fresh estimate)
    // Indexed mode (Sales): always inside a window of at most maxDays. Small mode: optional, unlimited.
    const optional = Boolean(ds.windowOptionalWhenSmall && plan.mode === "small");
    const latest = !query.to && !(optional && !query.from) ? (await source.bounds()).latestDate : null;
    const window = resolveWindow(query, { latest, now: this.now(), maxDays: optional ? null : ds.maxDays, optional });
    if (!window && plan.mode !== "small") throw new Error("fabric values: an indexed query needs a date window.");
    const context = this.contextOf(ds, query, sensitive, window);

    const key = JSON.stringify([ds.name, query.field, query.q, query.after, query.limit, window ? [window.dateFrom, window.dateTo] : null, context.canonical, plan.mode, sensitive]);
    let found = this.cacheMs > 0 ? this.cache.get(key) : null;
    if (found && this.clock() - found.at >= this.cacheMs) { this.cache.delete(key); this.cachedBytes -= found.bytes || 0; found = null; }
    let result = found?.value;
    if (!result) {
      await this.checkScan(ds, query, window, context.match, plan, source);
      result = await this.query(ds, query, window, context.match, plan);
      if (this.cacheMs > 0) this.remember(key, result);
    } else {
      // Least recently used first out: a hit moves to the end.
      this.cache.delete(key); this.cache.set(key, found);
    }
    return {
      dataset: ds.name, field: query.field, source: query.def.source, match: query.def.match,
      ...result,
      contextual: Boolean(context.match),
      window: window ? { field: ds.dateField, dateFrom: window.dateFrom, dateTo: window.dateTo, defaulted: window.defaulted } : { field: ds.dateField, dateFrom: null, dateTo: null, defaulted: false, all: true },
      mode: plan.mode,
      access: { datasets: [...(access?.datasets || [])].filter((n) => datasetNamed(n)), sensitive }
    };
  }

  // L1 (10-security-review): $limit rowCap + 1 bounds the rows that MATCH, not the rows examined. With a selective predicate
  // (q, after or a context) the $match could walk a whole window before it finds rowCap matches, so, like the records route
  // (service.listRecords), the window is counted first with the query's own index, up to FABRIC_MAX_WINDOW_ROWS + 1, and a
  // larger one is refused with FABRIC_RANGE_TOO_LARGE (422). Small mode skips the count only when the whole collection is
  // under the cap. Without a selective predicate every row in the window matches, so the row cap is already the scan bound.
  async checkScan(ds, query, window, contextMatch, plan, source) {
    if (!query.q && query.after === null && !contextMatch) return;
    const max = this.config.maxWindowRows ?? 50000;
    if (plan.mode !== "indexed" && typeof source.info === "function" && (await source.info()).estimate <= max) return;
    const windowMatch = window ? { [ds.dateField]: { $gte: window.from, $lt: window.toExcl } } : {};
    const rows = await this.repository.countMatching(ds, windowMatch, { hint: plan.hint, limit: max + 1 });
    if (rows > max) throw fabricError("FABRIC_RANGE_TOO_LARGE", { rows, max });
  }

  // L2: the cache is bounded by entries AND by approximate size (the JSON length of each answer, about a byte per character,
  // twice for JS strings); least recently used entries go first. An answer larger than the whole budget isn't cached.
  remember(key, value) {
    const bytes = 2 * (key.length + JSON.stringify(value).length);
    const budget = this.cacheBytes;
    if (bytes > budget) return;
    while (this.cache.size && (this.cache.size >= VALUE_LIMITS.cacheEntries || this.cachedBytes + bytes > budget)) {
      const [oldest, entry] = this.cache.entries().next().value;
      this.cache.delete(oldest); this.cachedBytes -= entry.bytes;
    }
    this.cache.set(key, { at: this.clock(), value, bytes });
    this.cachedBytes += bytes;
  }

  async query(ds, query, window, contextMatch, plan) {
    const { field, def, q, after, limit } = query;
    const rowCap = this.rowCap;
    const search = q ? { [field]: { $regex: def.match === "prefix" ? `^${escapeRegex(q)}` : escapeRegex(q), $options: "i" } } : null;
    // After a value: only strings above it (type bracketing leaves out the blank bucket); " " belongs to the blank bucket.
    const keyset = after !== null ? { [field]: { $gt: after, $ne: " " } } : null;
    const windowMatch = window ? { [ds.dateField]: { $gte: window.from, $lt: window.toExcl } } : null;
    // The window is always its own top-level conjunct: nothing in the context can replace it.
    const match = and(windowMatch, contextMatch, search, keyset);
    const { values, rows } = await this.repository.distinctValues(ds, { match, field, rowCap, limit, hint: plan.hint, maxTimeMs: this.timeMs });
    const capped = rows > rowCap;
    const more = values.length > limit;
    const shown = values.slice(0, limit);
    const complete = !capped && !more;
    const last = shown.at(-1);
    // A capped scan may have missed values after the last one shown, so it can still be paged.
    const nextAfter = (more || (capped && shown.length)) && last ? (last._id === null ? "" : String(plain(last._id))) : null;
    return {
      values: shown.map((v) => ({ value: plain(v._id), ...(v._id === null ? { blank: true } : {}), ...(complete ? { count: v.n } : {}) })),
      complete,
      limited: complete ? null : { reason: capped ? "rowCap" : "valueLimit", rowsScanned: Math.min(rows, rowCap), rowCap },
      nextAfter, next: nextAfter
    };
  }
}

module.exports = { FabricValues, VALUE_FIELDS, VALUE_LIMITS, valueSourceOf, stripField };
