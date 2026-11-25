// Fabric Data advanced filters: a validated model (filter-model.js) → a MongoDB filter. A whitelist mapping, one case per
// catalog operator: client operators are never passed through, field names come only from the dataset allow-list (checked again
// here), and text only ever becomes an equality value, a list item or an ESCAPED regular expression. Numbers become Decimal128
// (exact, from the decimal text) for decimal fields and a Number otherwise; dates become BSON Dates (UTC half-open ranges).
// The service puts the result in its own top-level $and next to the date window, so no group in here can widen the window.
const crypto = require("crypto");
const { Decimal128 } = require("mongodb");
const { escapeRegex } = require("./repository");
const m = require("./filter-model");

const BLANK_TEXT = "^\\s*$"; // "" or whitespace only (" " is common in Business Central exports)
const day = (text) => new Date(`${text}T00:00:00.000Z`);

function operand(ds, field, text) {
  if (text === null) return null;
  return (ds.types[field] || "string") === "decimal" ? Decimal128.fromString(text) : Number(text);
}
function blank(ds, field, kind) {
  if (kind === "text" || kind === "category") return { $or: [{ [field]: null }, { [field]: { $regex: BLANK_TEXT } }] };
  if (kind === "date" && ds.blankDateFields.includes(field)) return { $or: [{ [field]: null }, { [field]: { $lt: m.BLANK_DATE_BEFORE } }] };
  return { [field]: null };
}
function dateCondition(ds, cond, now) {
  const r = Array.isArray(cond.range) ? { from: cond.range[0] && day(cond.range[0]), toExcl: cond.range[1] && day(cond.range[1]) } : m.dateRange(cond, now);
  let from = r.from || null;
  // The pre-1900 "no date" sentinel never matches a range on a blankDateFields field.
  if (ds.blankDateFields.includes(cond.field) && (!from || from < m.BLANK_DATE_BEFORE)) from = m.BLANK_DATE_BEFORE;
  const range = {};
  if (from) range.$gte = from;
  if (r.toExcl) range.$lt = r.toExcl;
  return { [cond.field]: range };
}
function conditionFilter(ds, cond, now) {
  const kind = m.fieldKind(ds, cond.field);
  if (!kind || !m.BY_KIND[kind].includes(cond.op)) throw new Error("filter-compile: the model was not validated.");
  const f = cond.field;
  switch (cond.op) {
    case "blank": return blank(ds, f, kind);
    case "notBlank": return { $nor: [blank(ds, f, kind)] };
    case "isNull": return { [f]: { $type: "null" } };
    case "missing": return { [f]: { $exists: false } };
    case "isTrue": return { [f]: true };
    case "isFalse": return { [f]: false };
    default: break;
  }
  if (kind === "date") return dateCondition(ds, cond, now);
  if (kind === "number") {
    const v = operand(ds, f, cond.value);
    switch (cond.op) {
      case "eq": return { [f]: v };
      case "ne": return { [f]: { $ne: v } };
      case "gt": return { [f]: { $gt: v } };
      case "gte": return { [f]: { $gte: v } };
      case "lt": return { [f]: { $lt: v } };
      case "lte": return { [f]: { $lte: v } };
      case "between": return { [f]: { $gte: v, $lte: operand(ds, f, cond.to) } };
      default: break;
    }
  } else {
    switch (cond.op) {
      case "eq": return { [f]: cond.value };
      case "ne": return { [f]: { $ne: cond.value } };
      case "in": return { [f]: { $in: [...cond.values] } };
      case "nin": return { [f]: { $nin: [...cond.values] } };
      case "contains": return { [f]: { $regex: escapeRegex(cond.value), $options: "i" } };
      case "notContains": return { [f]: { $not: { $regex: escapeRegex(cond.value), $options: "i" } } };
      case "startsWith": return { [f]: { $regex: `^${escapeRegex(cond.value)}` } };
      case "endsWith": return { [f]: { $regex: `${escapeRegex(cond.value)}$`, $options: "i" } };
      default: break;
    }
  }
  throw new Error("filter-compile: no mapping for this operator.");
}
function node(ds, n, now) {
  if (!Array.isArray(n.items)) return conditionFilter(ds, n, now);
  const parts = n.items.map((i) => node(ds, i, now));
  if (parts.length === 1) return parts[0];
  return { [n.op === "or" ? "$or" : "$and"]: parts };
}
// → a MongoDB filter, or null for an empty model.
function compileFilter(ds, model, { now = new Date() } = {}) {
  if (!model || !Array.isArray(model.items) || !model.items.length) return null;
  return node(ds, model, now);
}

// ---- Classes (indexed mode) ----
// The conditions that bound a query on their own: an equality or a list on an indexed key (null excluded: it also matches a
// missing field, which the index can't bound tightly), a date range on the window field.
function isFast(ds, cond, indexKeys) {
  if (cond.field === ds.dateField && m.DATE_RANGE_OPS.has(cond.op)) return true;
  if (!indexKeys.includes(cond.field)) return false;
  if (cond.op === "eq") return cond.value !== null;
  if (cond.op === "in") return !cond.values.includes(null);
  return cond.op === "startsWith";
}
// In indexed mode, a filter with any bounded condition needs the date window, or (without one) a top-level fast predicate: a
// root-AND condition that is fast, or a root-AND OR group whose every branch is. → null or a reason ("bounded").
function boundedProblem(ds, model, { mode, hasWindow, indexKeys, extraBound = false }) {
  if (!model || mode !== "indexed" || hasWindow || extraBound) return null;
  const conditions = m.conditionsOf(model);
  if (conditions.every((c) => isFast(ds, c, indexKeys))) return null;
  const top = model.op === "and" ? model.items : [model];
  const bounds = top.some((n) => (Array.isArray(n.items) ? n.op === "or" && n.items.every((c) => !Array.isArray(c.items) && isFast(ds, c, indexKeys)) : isFast(ds, n, indexKeys)));
  return bounds ? null : "bounded";
}

// A short stable hash of the normalized model (ranges included): cursors and caches are bound to it.
const filterHash = (model) => crypto.createHash("sha256").update(JSON.stringify(model || null)).digest("base64url").slice(0, 22);

// The model without the conditions on `field` (value lists): AND groups drop them, an OR group that mentions it is dropped whole.
const mentions = (n, field) => (Array.isArray(n.items) ? n.items.some((i) => mentions(i, field)) : n.field === field);
function withoutField(model, field) {
  const strip = (n) => {
    if (!Array.isArray(n.items)) return n.field === field ? null : n;
    if (n.op === "or") return mentions(n, field) ? null : n;
    const items = n.items.map(strip).filter(Boolean);
    return items.length ? { ...n, items } : null;
  };
  const out = model ? strip(model) : null;
  return out ? { v: m.VERSION, op: out.op, items: out.items } : null;
}

// Keyset for an in-memory sort (small mode, any orderable keys): documents strictly after `values` in `keys` order, as one $expr
// (missing read as null, values as $literal, BSON order across types). No index bound is needed: the collection is small, and a
// bound on a nullable descending key would wrongly drop the null rows that sort last.
function keysetExpr(keys, values) {
  if (!values) return null;
  const f = (name) => ({ $ifNull: ["$" + name, null] });
  const branches = keys.map(([name, dir], i) => ({ $and: [...keys.slice(0, i).map(([k], j) => ({ $eq: [f(k), { $literal: values[j] }] })), { [dir === 1 ? "$gt" : "$lt"]: [f(name), { $literal: values[i] }] }] }));
  return { $expr: { $or: branches } };
}

// Adapters with the argument order values.js (B2) looks for: compile(model, ds, opts).
const dsOf = (arg) => (arg && typeof arg === "object" && Array.isArray(arg.fields) ? arg : require("./datasets").datasetNamed(typeof arg === "string" ? arg : arg?.dataset?.name || arg?.dataset));
const compile = (model, ds, opts = {}) => compileFilter(dsOf(ds), model, opts);

module.exports = { compileFilter, compile, boundedProblem, isFast, filterHash, withoutField, keysetExpr };
