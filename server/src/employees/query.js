// In-memory evaluation over the snapshot: the validated v1 filter model (fabric/filter-model.js validateFilter output, which
// carries resolved date ranges), the q search, orderBy sorting and signed keyset cursors. No database query per request.
// Values are normalised (fields.js): strings or null (blank text is null), booleans or null, Dates or null.
const crypto = require("crypto");
const fm = require("../fabric/filter-model");
const { invalid } = require("./errors");

// ---- Filter evaluation (one case per catalog operator; same meaning as the MongoDB compiler) ----
const lowerOf = (v) => (typeof v === "string" ? v.toLowerCase() : null);
const day = (text) => (text ? new Date(`${text}T00:00:00.000Z`).getTime() : null);
function condition(ds, cond, row, now) {
  const kind = fm.fieldKind(ds, cond.field);
  if (!kind || !fm.BY_KIND[kind].includes(cond.op)) throw new Error("employees: the filter model was not validated.");
  const v = row.values[cond.field] ?? null;
  const eq = (want) => (want === null ? v === null : v === want);
  switch (cond.op) {
    case "blank": case "isNull": case "missing": return v === null;
    case "notBlank": return v !== null;
    case "isTrue": return v === true;
    case "isFalse": return v === false;
    default: break;
  }
  if (kind === "date") {
    const r = Array.isArray(cond.range) ? { from: day(cond.range[0]), to: day(cond.range[1]) } : (() => { const x = fm.dateRange(cond, now); return { from: x.from?.getTime() ?? null, to: x.toExcl?.getTime() ?? null }; })();
    if (!(v instanceof Date)) return false;
    const t = v.getTime();
    return (r.from === null || t >= r.from) && (r.to === null || t < r.to);
  }
  switch (cond.op) {
    case "eq": return eq(cond.value);
    case "ne": return !eq(cond.value);
    case "in": return cond.values.some(eq);
    case "nin": return !cond.values.some(eq);
    case "contains": return v !== null && lowerOf(v).includes(cond.value.toLowerCase());
    case "notContains": return v === null || !lowerOf(v).includes(cond.value.toLowerCase());
    case "startsWith": return typeof v === "string" && v.startsWith(cond.value); // case-sensitive, as the catalog says
    case "endsWith": return typeof v === "string" && lowerOf(v).endsWith(cond.value.toLowerCase());
    default: throw new Error("employees: no evaluation for this operator.");
  }
}
function matchNode(ds, node, row, now) {
  if (!Array.isArray(node.items)) return condition(ds, node, row, now);
  if (!node.items.length) return true;
  return node.op === "or" ? node.items.some((n) => matchNode(ds, n, row, now)) : node.items.every((n) => matchNode(ds, n, row, now));
}
// A predicate for a validated model (null/empty = everything).
const filterPredicate = (ds, model, now = new Date()) => (!model || !Array.isArray(model.items) || !model.items.length ? () => true : (row) => matchNode(ds, model, row, now));

// The model without the conditions on `field` (value lists never narrow themselves): AND groups drop them, an OR group that
// mentions the field is dropped whole. null when nothing is left.
const mentions = (node, field) => (Array.isArray(node?.items) ? node.items.some((n) => mentions(n, field)) : node?.field === field);
function stripField(node, field) {
  if (!node || typeof node !== "object") return null;
  if (!Array.isArray(node.items)) return node.field === field ? null : node;
  if (node.op === "or") return mentions(node, field) ? null : node;
  const items = node.items.map((n) => stripField(n, field)).filter(Boolean);
  return items.length ? { ...node, items } : null;
}

// ---- Search: case-insensitive contains over the dataset's search fields (or one of them) ----
function searchPredicate(ds, q, searchField) {
  if (!q) return () => true;
  const needle = q.toLowerCase();
  const fields = searchField ? [searchField] : ds.searchFields.map(([f]) => f);
  return (row) => fields.some((f) => { const v = row.values[f]; return typeof v === "string" && v.toLowerCase().includes(needle); });
}

// ---- Sorting: orderBy keys, then the profile ID. Blanks come last in either direction. ----
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
function compareValue(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const x = String(a), y = String(b);
  return collator.compare(x, y) || (x < y ? -1 : x > y ? 1 : 0);
}
// keys: [[field, 1 | -1]]. a, b: { id, values }.
function comparator(keys) {
  return (a, b) => {
    for (const [f, dir] of keys) {
      const x = a.values[f] ?? null, y = b.values[f] ?? null;
      if (x === null && y === null) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = compareValue(x, y);
      if (c) return dir * c;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

// ---- Cursors: opaque base64url JSON of the last row's sort values and ID, HMAC-signed with a key made when the process starts,
// bound to the dataset, filter, q, searchField, order and caller. Another list, a changed filter or another person → 400.
const CURSOR_KEY = crypto.randomBytes(32);
const CURSOR_MAX = 2048;
const enc = (v) => (v === null || v === undefined ? null : v instanceof Date ? { d: v.toISOString() } : typeof v === "boolean" ? { b: v } : { s: String(v) });
function dec(v) {
  if (v === null) return null;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 1) throw invalid("cursor is not valid.", "cursor", "cursor");
  if (typeof v.s === "string" && v.s.length <= 400) return v.s;
  if (typeof v.b === "boolean") return v.b;
  if (typeof v.d === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.d)) return new Date(v.d);
  throw invalid("cursor is not valid.", "cursor", "cursor");
}
const sign = (binding, values) => crypto.createHmac("sha256", CURSOR_KEY).update(JSON.stringify([binding, values])).digest("base64url").slice(0, 22);
function encodeCursor(binding, keys, row) {
  const values = [...keys.map(([f]) => enc(row.values[f] ?? null)), { s: row.id }];
  const text = Buffer.from(JSON.stringify({ b: sign(binding, values), v: values })).toString("base64url");
  return text.length <= CURSOR_MAX ? text : null;
}
// → a pseudo row { id, values } positioned at the cursor, or null without one.
function decodeCursor(text, binding, keys) {
  if (text === undefined) return null;
  if (typeof text !== "string" || !text.length || text.length > CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(text)) throw invalid("cursor is not valid.", "cursor", "cursor");
  let parsed;
  try { parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8")); } catch { throw invalid("cursor is not valid.", "cursor", "cursor"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 2 || typeof parsed.b !== "string" || !Array.isArray(parsed.v) || parsed.v.length !== keys.length + 1) throw invalid("cursor is not valid.", "cursor", "cursor");
  const expected = Buffer.from(sign(binding, parsed.v)), given = Buffer.from(parsed.b);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw invalid("cursor belongs to a different list or filter. Start again from the first page.", "cursor", "cursor");
  const values = parsed.v.map(dec);
  const id = values.at(-1);
  if (typeof id !== "string") throw invalid("cursor is not valid.", "cursor", "cursor");
  return { id, values: Object.fromEntries(keys.map(([f], i) => [f, values[i]])) };
}

module.exports = { filterPredicate, searchPredicate, comparator, stripField, encodeCursor, decodeCursor, CURSOR_MAX };
