// Fabric Data advanced filters, model version 1 (session API only; Fabric-Data-Plan/phase7-advanced-filters/02 §2(b), catalog in
// 04-operator-catalog.md). Pure: no driver, no database. The client sends a structured model; this module checks every key,
// field, operator and value against the dataset allow-lists and returns a normalized copy. filter-compile.js turns that copy into
// a MongoDB filter. Client text never becomes an operator, a field name or a raw regular expression.
//
//   group      { op: "and" | "or", items: [group | condition] }     the root also carries v: 1
//   condition  { field, op, value?, to?, values?, n?, unit? }       (an echoed `range` from appliedFilter is accepted and ignored)
//
// Kinds: text | number | date | bool | category (datasets.js types + categories). Sensitive, dotted and disabled fields have no
// operators: they are refused exactly like an unknown field ("Unknown field"). Values are strings (or null where allowed): numbers
// as decimal text, dates as UTC YYYY-MM-DD. Relative dates are resolved here against UTC today; weeks start on Monday.
const { ApiError } = require("../middleware/errors");

const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION = 1;
const LIMITS = Object.freeze({ maxDepth: 2, maxConditions: 20, maxGroups: 10, maxListValues: 200, maxText: 100, maxEncoded: 6000, maxCanonical: 4096, maxN: 366 });
const ORDER_BY = Object.freeze({ maxKeys: 3 });
const KINDS = Object.freeze(["text", "number", "date", "bool", "category"]);
const UNITS = Object.freeze(["days", "weeks", "months"]);
// The pre-1900 "no date" value (Business Central writes 0001-01-01): blank for the dataset's blankDateFields.
const BLANK_DATE_BEFORE = new Date(Date.UTC(1900, 0, 1));

// The operator catalog. shape: none | one (value) | two (value, to) | list (values) | n (n, unit).
// nullable: value (or a list item) may be null (exact null-or-missing match, MongoDB's { field: null }).
const OPERATORS = Object.freeze(Object.fromEntries([
  ["eq", "equals", "one", { nullable: true }], ["ne", "does not equal (blanks included)", "one", { nullable: true }],
  ["contains", "contains", "one"], ["notContains", "does not contain (blanks included)", "one"],
  ["startsWith", "begins with (case-sensitive)", "one"], ["endsWith", "ends with", "one"],
  ["in", "is one of", "list", { nullable: true }], ["nin", "is not one of (blanks included)", "list", { nullable: true }],
  ["blank", "is blank", "none"], ["notBlank", "is not blank", "none"],
  ["isNull", "is null", "none"], ["missing", "is missing", "none"],
  ["gt", "greater than", "one"], ["gte", "greater than or equal to", "one"], ["lt", "less than", "one"], ["lte", "less than or equal to", "one"],
  ["between", "between (inclusive)", "two"],
  ["on", "on", "one"], ["before", "before", "one"], ["onOrBefore", "on or before", "one"], ["after", "after", "one"], ["onOrAfter", "on or after", "one"],
  ["today", "today", "none"], ["yesterday", "yesterday", "none"],
  ["lastN", "in the last N (including today)", "n"], ["prevN", "in the previous N (excluding today)", "n"],
  ["thisWeek", "this week (Monday to Sunday)", "none"], ["thisMonth", "this month", "none"], ["thisQuarter", "this quarter", "none"], ["thisYear", "this year", "none"],
  ["lastMonth", "last calendar month", "none"], ["lastYear", "last calendar year", "none"],
  ["isTrue", "is true", "none"], ["isFalse", "is false", "none"]
].map(([id, label, shape, extra = {}]) => [id, Object.freeze({ id, label, shape, nullable: extra.nullable === true })])));

const BY_KIND = Object.freeze({
  text: Object.freeze(["eq", "ne", "contains", "notContains", "startsWith", "endsWith", "in", "nin", "blank", "notBlank", "isNull", "missing"]),
  number: Object.freeze(["eq", "ne", "gt", "gte", "lt", "lte", "between", "blank", "notBlank", "isNull", "missing"]),
  date: Object.freeze(["on", "before", "onOrBefore", "after", "onOrAfter", "between", "today", "yesterday", "lastN", "prevN", "thisWeek", "thisMonth", "thisQuarter", "thisYear", "lastMonth", "lastYear", "blank", "notBlank"]),
  bool: Object.freeze(["isTrue", "isFalse", "isNull", "missing"]),
  category: Object.freeze(["eq", "ne", "in", "nin", "blank", "notBlank"])
});
// The date operators that resolve to one UTC half-open range [from, toExcl).
const DATE_RANGE_OPS = new Set(["on", "before", "onOrBefore", "after", "onOrAfter", "between", "today", "yesterday", "lastN", "prevN", "thisWeek", "thisMonth", "thisQuarter", "thisYear", "lastMonth", "lastYear"]);
// Fast on an indexed key (indexed mode): exact equality, a list, a case-sensitive anchored prefix; any range on the window field.
const FAST_ON_INDEX_KEY = new Set(["eq", "in", "startsWith"]);
// Not used to bound a query (they match most rows or need every key): bounded wherever they appear.
const CONDITION_KEYS = new Set(["field", "op", "value", "to", "values", "n", "unit", "range"]);
const GROUP_KEYS = new Set(["op", "items"]);
const ROOT_KEYS = new Set(["v", "op", "items"]);

const CONTROL = /[\u0000-\u001f\u007f]/;
const NUMBER_TEXT = /^-?(\d{1,34})(\.(\d{1,34}))?$/;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

// ---- Errors: 400 VALIDATION_ERROR with { path, reason }; values are never echoed. ----
function fail(path, reason, message) {
  throw new ApiError(400, "VALIDATION_ERROR", message || `filter is not valid (${reason} at ${path}).`, { path, reason });
}
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

// ---- Field kinds (datasets.js) ----
// The field's kind, or null when it can't be filtered at all for this caller: unknown, dotted, sensitive (decision A: never
// filterable, sortable or searchable, even for sensitive readers) or disabled (constant, always empty or always null).
function fieldKind(ds, field) {
  if (typeof field !== "string" || !ds.fields.includes(field) || field.includes(".")) return null;
  if (ds.sensitive.includes(field) || ds.filtering.disabled.includes(field)) return null;
  const type = ds.types[field] || "string";
  if (type === "date") return "date";
  if (type === "number" || type === "decimal") return "number";
  if (type === "bool") return "bool";
  return ds.filtering.categories.includes(field) ? "category" : "text";
}
// The keys of the dataset's index for its default sort (fast keys in indexed mode).
const indexKeys = (ds, sortName = ds.defaultSort) => ds.sorts[sortName].keys.map(([f]) => f).filter((f) => f !== "_id");
// fast | bounded for one operator on one field, in indexed mode (small mode treats everything as bounded by size).
function operatorClass(ds, field, op, { sortName = ds.defaultSort } = {}) {
  if (field === ds.dateField && DATE_RANGE_OPS.has(op)) return "fast";
  if (indexKeys(ds, sortName).includes(field) && FAST_ON_INDEX_KEY.has(op)) return "fast";
  return "bounded";
}
// [{ op, class }] permitted for the field (empty when it can't be filtered).
function fieldOperators(ds, field) {
  const kind = fieldKind(ds, field);
  return kind ? BY_KIND[kind].map((op) => ({ op, class: operatorClass(ds, field, op) })) : [];
}
function valueSource(ds, field) {
  const kind = fieldKind(ds, field);
  if (kind === "category") return "distinct";
  if (kind === "text" && ds.filtering.valueSearch.includes(field)) return "search";
  return "none";
}
// orderBy may use the field (small mode: any of these; indexed mode: index keys only, checked by the service).
const orderable = (ds, field) => fieldKind(ds, field) !== null;

// ---- Dates (UTC, half-open) ----
const utcToday = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
// Calendar months, the day clamped to the target month's length (31 March − 1 month = 28/29 February).
function addMonths(d, n) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last)));
}
const dayText = (d) => d.toISOString().slice(0, 10);
function parseDay(text, path) {
  if (typeof text !== "string" || !DATE_TEXT.test(text)) fail(path, "date", "A date must be written as YYYY-MM-DD.");
  const d = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || dayText(d) !== text) fail(path, "date", "A date in the filter is not a real date.");
  return d;
}
const mondayOf = (d) => addDays(d, -((d.getUTCDay() + 6) % 7));
// { from, toExcl } (Dates; either may be null = open) for a date operator. today = UTC midnight of `now`.
function dateRange(cond, now) {
  const t = utcToday(now);
  const day = (text) => new Date(`${text}T00:00:00.000Z`);
  switch (cond.op) {
    case "on": return { from: day(cond.value), toExcl: addDays(day(cond.value), 1) };
    case "before": return { from: null, toExcl: day(cond.value) };
    case "onOrBefore": return { from: null, toExcl: addDays(day(cond.value), 1) };
    case "after": return { from: addDays(day(cond.value), 1), toExcl: null };
    case "onOrAfter": return { from: day(cond.value), toExcl: null };
    case "between": return { from: day(cond.value), toExcl: addDays(day(cond.to), 1) };
    case "today": return { from: t, toExcl: addDays(t, 1) };
    case "yesterday": return { from: addDays(t, -1), toExcl: t };
    case "lastN": { // the N units ending today, today included
      const end = addDays(t, 1);
      if (cond.unit === "days") return { from: addDays(t, -(cond.n - 1)), toExcl: end };
      if (cond.unit === "weeks") return { from: addDays(t, -(7 * cond.n - 1)), toExcl: end };
      return { from: addDays(addMonths(t, -cond.n), 1), toExcl: end };
    }
    case "prevN": { // the N units ending yesterday, today excluded
      if (cond.unit === "days") return { from: addDays(t, -cond.n), toExcl: t };
      if (cond.unit === "weeks") return { from: addDays(t, -7 * cond.n), toExcl: t };
      return { from: addMonths(t, -cond.n), toExcl: t };
    }
    case "thisWeek": { const m = mondayOf(t); return { from: m, toExcl: addDays(m, 7) }; }
    case "thisMonth": { const s = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)); return { from: s, toExcl: addMonths(s, 1) }; }
    case "thisQuarter": { const s = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - (t.getUTCMonth() % 3), 1)); return { from: s, toExcl: addMonths(s, 3) }; }
    case "thisYear": return { from: new Date(Date.UTC(t.getUTCFullYear(), 0, 1)), toExcl: new Date(Date.UTC(t.getUTCFullYear() + 1, 0, 1)) };
    case "lastMonth": { const s = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1)); return { from: s, toExcl: addMonths(s, 1) }; }
    case "lastYear": return { from: new Date(Date.UTC(t.getUTCFullYear() - 1, 0, 1)), toExcl: new Date(Date.UTC(t.getUTCFullYear(), 0, 1)) };
    default: return null;
  }
}

// ---- Values ----
function textValue(value, path, { nullable, allowEmpty }) {
  if (value === null) { if (!nullable) fail(path, "value", "This filter needs a value."); return null; }
  if (typeof value !== "string") fail(path, "value", "Filter values must be text.");
  if (value.length > LIMITS.maxText || CONTROL.test(value)) fail(path, "value", `Filter values must be at most ${LIMITS.maxText} characters, without control characters.`);
  if (!allowEmpty && !value.length) fail(path, "value", "This filter needs a value.");
  return value;
}
// exact: false for decimal fields (compared as Decimal128 from the exact text). Other number fields are compared as a JS
// Number, which holds at most 15 significant digits exactly: longer values are refused rather than silently rounded (I2,
// 10-security-review). Leading zeros and trailing zeros are not significant ("0.000125", "1200000" are fine).
const MAX_EXACT_DIGITS = 15;
const significantDigits = (intPart, fracPart = "") => (intPart + fracPart).replace(/^0+/, "").replace(/0+$/, "").length;
function numberValue(value, path, nullable, exact = false) {
  if (value === null && nullable) return null;
  if (typeof value !== "string") fail(path, "value", "Numbers must be written as text, such as \"12.5\".");
  const m = NUMBER_TEXT.exec(value);
  if (!m || m[1].length + (m[3]?.length || 0) > 34) fail(path, "value", "Numbers must be decimal text such as -12.5 (at most 34 digits, no exponent).");
  if (!Number.isFinite(Number(value))) fail(path, "value", "The number is out of range.");
  if (exact && significantDigits(m[1], m[3]) > MAX_EXACT_DIGITS) fail(path, "precision", `This field holds numbers with at most ${MAX_EXACT_DIGITS} significant digits. Use a shorter number.`);
  return value;
}

// ---- Validation ----
// model: the parsed JSON. → the normalized model { v: 1, op, items } (date conditions carry range: [from, toExcl] as UTC days,
// toExcl exclusive, either null when open; numbers stay decimal text). Throws 400 VALIDATION_ERROR.
// opts.now: the clock for relative dates (UTC).
function validateFilter(ds, model, { now = new Date() } = {}) {
  if (!isPlainObject(model)) fail("$", "shape", "filter must be a JSON object.");
  for (const key of Object.keys(model)) if (!ROOT_KEYS.has(key)) fail("$", "unknownKey");
  if (model.v !== VERSION) fail("$.v", "version", `filter must have v: ${VERSION}.`);
  const counts = { conditions: 0, groups: 0 };
  const root = group(ds, model, "$", 1, counts, now, true);
  return { v: VERSION, op: root.op, items: root.items };
}
function group(ds, node, path, depth, counts, now, isRoot = false) {
  if (!isPlainObject(node)) fail(path, "shape", "Each filter group must be an object.");
  if (!isRoot) for (const key of Object.keys(node)) if (!GROUP_KEYS.has(key)) fail(path, "unknownKey");
  if (node.op !== "and" && node.op !== "or") fail(`${path}.op`, "groupOp", "A filter group's op must be and or or.");
  if (!Array.isArray(node.items)) fail(`${path}.items`, "shape", "A filter group needs items.");
  if (!isRoot && !node.items.length) fail(`${path}.items`, "empty", "A filter group needs at least one condition.");
  counts.groups += 1;
  if (counts.groups > LIMITS.maxGroups) fail(path, "tooManyGroups", `A filter can have at most ${LIMITS.maxGroups} groups.`);
  const items = node.items.map((item, i) => {
    const at = `${path}.items[${i}]`;
    if (isPlainObject(item) && Object.hasOwn(item, "items")) {
      if (depth + 1 > LIMITS.maxDepth) fail(at, "tooDeep", `Filter groups can be nested only ${LIMITS.maxDepth - 1} level deep.`);
      return group(ds, item, at, depth + 1, counts, now);
    }
    counts.conditions += 1;
    if (counts.conditions > LIMITS.maxConditions) fail(at, "tooManyConditions", `A filter can have at most ${LIMITS.maxConditions} conditions.`);
    return condition(ds, item, at, now);
  });
  return { op: node.op, items };
}
function condition(ds, node, path, now) {
  if (!isPlainObject(node)) fail(path, "shape", "Each filter condition must be an object.");
  for (const key of Object.keys(node)) if (!CONDITION_KEYS.has(key)) fail(path, "unknownKey");
  const kind = fieldKind(ds, node.field);
  // Unknown, sensitive, dotted and disabled fields get the same answer, and the name is never echoed.
  if (!kind) fail(`${path}.field`, "unknownField", "Unknown field in the filter.");
  const op = node.op;
  if (typeof op !== "string" || !Object.hasOwn(OPERATORS, op) || !BY_KIND[kind].includes(op)) fail(`${path}.op`, "operator", "This operator can't be used with this field.");
  const def = OPERATORS[op];
  const has = (k) => Object.hasOwn(node, k);
  const allowed = { none: [], one: ["value"], two: ["value", "to"], list: ["values"], n: ["n", "unit"] }[def.shape];
  for (const k of ["value", "to", "values", "n", "unit"]) {
    if (allowed.includes(k) && !has(k)) fail(`${path}.${k}`, "missingValue", "This filter needs a value.");
    if (!allowed.includes(k) && has(k)) fail(`${path}.${k}`, "unexpectedValue");
  }
  const out = { field: node.field, op };
  const one = (value, at) => {
    if (kind === "number") return numberValue(value, at, def.nullable, (ds.types[node.field] || "string") !== "decimal");
    if (kind === "date") { parseDay(value, at); return value; }
    return textValue(value, at, { nullable: def.nullable, allowEmpty: op === "eq" || op === "ne" });
  };
  if (def.shape === "one" || def.shape === "two") out.value = one(node.value, `${path}.value`);
  if (def.shape === "two") {
    out.to = one(node.to, `${path}.to`);
    const a = out.value, b = out.to;
    if (kind === "date" && a > b) fail(`${path}.to`, "range", "The first date must be on or before the second.");
    if (kind === "number" && Number(a) > Number(b)) fail(`${path}.to`, "range", "The first number must be at most the second.");
  }
  if (def.shape === "list") {
    if (!Array.isArray(node.values) || node.values.length < 1 || node.values.length > LIMITS.maxListValues) fail(`${path}.values`, "list", `A list needs 1 to ${LIMITS.maxListValues} values.`);
    const seen = new Set(), values = [];
    node.values.forEach((value, i) => {
      const v = textValue(value, `${path}.values[${i}]`, { nullable: true, allowEmpty: true });
      const key = v === null ? "\u0000null" : v;
      if (!seen.has(key)) { seen.add(key); values.push(v); }
    });
    out.values = values;
  }
  if (def.shape === "n") {
    if (!Number.isInteger(node.n) || node.n < 1 || node.n > LIMITS.maxN) fail(`${path}.n`, "n", `N must be a whole number from 1 to ${LIMITS.maxN}.`);
    if (!UNITS.includes(node.unit)) fail(`${path}.unit`, "unit", "unit must be days, weeks or months.");
    out.n = node.n; out.unit = node.unit;
  }
  if (kind === "date" && DATE_RANGE_OPS.has(op)) {
    const r = dateRange(out, now);
    out.range = [r.from ? dayText(r.from) : null, r.toExcl ? dayText(r.toExcl) : null];
  }
  return out;
}

// A non-throwing check (saved filters: valid is recomputed on every read). → { valid: true, filter } | { valid: false, problem,
// path, reason }. The problem text never names a field.
function checkFilter(ds, model, opts) {
  try { return { valid: true, filter: validateFilter(ds, model, opts) }; } catch (error) {
    if (error?.code !== "VALIDATION_ERROR") throw error;
    const reason = error.details?.reason;
    return { valid: false, reason, path: error.details?.path, problem: reason === "unknownField" ? "uses a field you can't use now" : error.message };
  }
}

// ---- Canonical form and transport ----
// The client-facing canonical form: fixed key order, no resolved ranges. Two equal filters give the same text.
function canonical(model) {
  const node = (n) => {
    if (Array.isArray(n.items)) return { op: n.op, items: n.items.map(node) };
    const out = { field: n.field, op: n.op };
    for (const k of ["value", "to", "values", "n", "unit"]) if (Object.hasOwn(n, k)) out[k] = n[k];
    return out;
  };
  return { v: VERSION, ...node(model) };
}
const canonicalJson = (model) => JSON.stringify(canonical(model));
const encodeFilterParam = (model) => Buffer.from(canonicalJson(model), "utf8").toString("base64url");
// filter=<base64url(JSON)> → the parsed (not yet validated) model.
function parseFilterParam(text) {
  if (typeof text !== "string" || !text.length || text.length > LIMITS.maxEncoded || !/^[A-Za-z0-9_-]+$/.test(text)) fail("$", "encoding", `filter must be base64url JSON of at most ${LIMITS.maxEncoded} characters.`);
  const json = Buffer.from(text, "base64url").toString("utf8");
  if (Buffer.byteLength(json, "utf8") > LIMITS.maxCanonical) fail("$", "tooLong", `filter can be at most ${LIMITS.maxCanonical} bytes of JSON.`);
  try { return JSON.parse(json); } catch { return fail("$", "encoding", "filter must be base64url JSON."); }
}
// Every condition, flattened (for checks and counting).
const conditionsOf = (model) => (model?.items || []).flatMap((n) => (Array.isArray(n.items) ? conditionsOf(n) : [n]));

// ---- orderBy ----
// orderBy=field:asc|desc,… → [[field, 1 | -1]] (at most 3 distinct orderable fields; _id is added by the service).
function parseOrderBy(ds, text) {
  if (text === undefined) return null;
  const parts = text.split(",");
  if (!text.length || parts.length > ORDER_BY.maxKeys) fail("orderBy", "orderBy", `orderBy takes 1 to ${ORDER_BY.maxKeys} fields, such as invoice_date:desc.`);
  const seen = new Set();
  return parts.map((part) => {
    const m = /^([^:]{1,80}):(asc|desc)$/.exec(part);
    if (!m) fail("orderBy", "orderBy", "orderBy must list field:asc or field:desc.");
    if (!orderable(ds, m[1])) fail("orderBy", "unknownField", "Unknown field in orderBy.");
    if (seen.has(m[1])) fail("orderBy", "duplicate", "orderBy can use each field once.");
    seen.add(m[1]);
    return [m[1], m[2] === "asc" ? 1 : -1];
  });
}

// The catalog as the schema and 04-operator-catalog.md publish it.
const catalog = () => ({
  version: VERSION, limits: { ...LIMITS }, orderBy: { ...ORDER_BY }, units: [...UNITS], weekStarts: "monday", timeZone: "UTC",
  operators: Object.values(OPERATORS).map((o) => ({ ...o })), byKind: Object.fromEntries(KINDS.map((k) => [k, [...BY_KIND[k]]]))
});

// Adapters with the argument order values.js (B2) and routes/fabric-saved-filters.js (B3) use: validate(model, ds | name |
// { dataset }, opts) → the canonical form (no resolved ranges: compile resolves them again against its own clock); decode(text).
function validate(model, dsArg, opts = {}) {
  const { datasetNamed } = require("./datasets");
  const ds = dsArg && Array.isArray(dsArg.fields) ? dsArg : dsArg?.dataset && Array.isArray(dsArg.dataset.fields) ? dsArg.dataset : datasetNamed(typeof dsArg === "string" ? dsArg : dsArg?.dataset);
  if (!ds) throw new Error("filter-model: validate needs a dataset.");
  return canonical(validateFilter(ds, model, opts));
}
const decode = (text) => parseFilterParam(text);

module.exports = {
  validate, decode,
  VERSION, LIMITS, ORDER_BY, KINDS, UNITS, OPERATORS, BY_KIND, DATE_RANGE_OPS, BLANK_DATE_BEFORE,
  fieldKind, fieldOperators, operatorClass, valueSource, orderable, indexKeys,
  validateFilter, checkFilter, canonical, canonicalJson, encodeFilterParam, parseFilterParam, conditionsOf, parseOrderBy,
  dateRange, utcToday, catalog
};
