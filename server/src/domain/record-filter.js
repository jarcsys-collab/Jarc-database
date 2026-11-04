// Filter conditions for a board's records: what saved views store, and what GET /boards/:id/records?filter= runs against
// every record of the board (not only those a browser has loaded).
//
//   filter   { op: "and" | "or", rules: [{ key, cmp, values? }], groups?: [{ op, rules }] }. One level of groups.
//   cmp      in, notIn          the cell equals (or doesn't equal) one of the values; "" means an empty cell
//            contains, notContains   the text contains a value, ignoring case
//            empty, notEmpty    the cell has no value / has a value
//            anyToken, noToken  one of a cell's comma-separated entries equals a value (monday.com linked and mirrored
//                               columns were migrated as display text, such as "Item A, Item B")
//            equalsText         the text equals a value, ignoring case
//            gt, lt             numerically greater or less than the value (numbers may be stored as text)
//            before, after, onOrAfter, dateRange   dates, compared as their ISO text; dateRange is [from, to] inclusive
//   key      a column; also updatedAt with onOrAfter (a date and time)
//   orderBy  [{ key, dir }], at most four: a column, or pinned / createdAt / updatedAt / position. _id always breaks ties.
//
// Column keys must exist on the board and values are compared literally (regular expressions are escaped), so nothing from
// a request reaches MongoDB as an operator or a field name. The same rules run in the browser (BoardModel.matchesViewFilter).
const { fail, isSafeKey } = require("../validation/common");

const CMPS = Object.freeze(["in", "notIn", "contains", "notContains", "empty", "notEmpty", "anyToken", "noToken", "equalsText", "gt", "lt", "before", "after", "onOrAfter", "dateRange"]);
const NO_VALUES = new Set(["empty", "notEmpty"]);
const META_SORTS = Object.freeze({ pinned: "pinned", createdAt: "createdAt", updatedAt: "updatedAt", position: "position" });
const META_FILTERS = new Set(["updatedAt"]);
const MAX = Object.freeze({ rules: 25, groups: 10, values: 100, value: 500, orderBy: 4, text: 6000 });
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function cleanRule(rule, where) {
  if (!isPlain(rule)) fail(`${where} must be an object.`);
  for (const k of Object.keys(rule)) if (!["key", "cmp", "values"].includes(k)) fail(`${where} has an unknown field.`);
  if (!isSafeKey(rule.key)) fail(`${where} names an invalid column.`);
  if (!CMPS.includes(rule.cmp)) fail(`${where} has an unknown comparison.`);
  if (NO_VALUES.has(rule.cmp)) return { key: rule.key, cmp: rule.cmp };
  if (!Array.isArray(rule.values) || !rule.values.length || rule.values.length > MAX.values) fail(`${where} needs 1 to ${MAX.values} values.`);
  if (rule.values.some((v) => typeof v !== "string" || v.length > MAX.value)) fail(`${where} has a value that isn't text or is too long.`);
  return { key: rule.key, cmp: rule.cmp, values: [...rule.values] };
}

// The stored shape, without looking at any board: a saved view can outlive a column.
function cleanFilter(raw) {
  if (!isPlain(raw)) fail("The filter must be an object.");
  for (const k of Object.keys(raw)) if (!["op", "rules", "groups"].includes(k)) fail("The filter has an unknown field.");
  const op = (v) => { if (v !== "and" && v !== "or") fail('A filter\'s op must be "and" or "or".'); return v; };
  const rulesOf = (list = [], where) => { if (!Array.isArray(list)) fail(`${where} must be a list.`); return list.map((r, i) => cleanRule(r, `Condition ${i + 1}`)); };
  const groups = raw.groups === undefined ? [] : raw.groups;
  if (!Array.isArray(groups) || groups.length > MAX.groups) fail(`A filter can have at most ${MAX.groups} groups.`);
  const clean = { op: op(raw.op), rules: rulesOf(raw.rules, "rules") };
  const cleanGroups = groups.map((g) => { if (!isPlain(g)) fail("A filter group must be an object."); for (const k of Object.keys(g)) if (!["op", "rules"].includes(k)) fail("A filter group has an unknown field."); return { op: op(g.op), rules: rulesOf(g.rules, "group rules") }; });
  if (cleanGroups.length) clean.groups = cleanGroups;
  const total = clean.rules.length + cleanGroups.reduce((n, g) => n + g.rules.length, 0);
  if (!total) fail("A filter needs at least one condition.");
  if (total > MAX.rules) fail(`A filter can have at most ${MAX.rules} conditions.`);
  return clean;
}

function cleanOrderBy(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX.orderBy) fail(`orderBy must list 1 to ${MAX.orderBy} columns.`);
  return raw.map((s) => {
    if (!isPlain(s) || !isSafeKey(s.key) || !["asc", "desc"].includes(s.dir) || Object.keys(s).some((k) => k !== "key" && k !== "dir")) fail("orderBy entries need a column key and a direction.");
    return { key: s.key, dir: s.dir };
  });
}

const rulesIn = (filter) => [...filter.rules, ...(filter.groups || []).flatMap((g) => g.rules)];
// Against a board: every column must exist. Filtering by the group column isn't a cell comparison, so it is refused.
function filterForBoard(raw, board) {
  const filter = cleanFilter(raw), byKey = new Map(board.columns.map((c) => [c.key, c]));
  for (const r of rulesIn(filter)) { if (META_FILTERS.has(r.key) && !byKey.has(r.key)) { if (r.cmp !== "onOrAfter" || Number.isNaN(Date.parse(r.values?.[0]))) fail("updatedAt can only be filtered from a date."); continue; } const c = byKey.get(r.key); if (!c || c.type === "group") fail(`The filter names a column this board doesn't have (${r.key.slice(0, 40)}).`); }
  return filter;
}
function orderByForBoard(raw, board) {
  const orderBy = cleanOrderBy(raw), byKey = new Map(board.columns.map((c) => [c.key, c]));
  return orderBy.map(({ key, dir }) => {
    if (META_SORTS[key] && !byKey.has(key)) return { key, dir, path: META_SORTS[key] };
    const c = byKey.get(key);
    if (!c || c.type === "group") fail(`orderBy names a column this board doesn't have (${key.slice(0, 40)}).`);
    return { key, dir, path: `values.${key}` };
  });
}

// Values as a column stores them: numbers and checkboxes aren't text.
function literals(values, column) {
  const out = [];
  for (const v of values) {
    if (v === "") { out.push("", null); continue; }
    out.push(v);
    if (column?.type === "number" && v.trim() !== "" && Number.isFinite(Number(v))) out.push(Number(v));
    if (column?.type === "checkbox" && (v === "true" || v === "false")) out.push(v === "true");
  }
  return out;
}
const tokenPattern = (values) => `(^|, )(${values.map(escapeRegex).join("|")})(, |$)`;

function ruleQuery(rule, byKey) {
  const path = `values.${rule.key}`, column = byKey.get(rule.key), values = rule.values || [];
  const numeric = (op) => ({ $expr: { [op]: [{ $convert: { input: `$${path}`, to: "double", onError: null, onNull: null } }, Number(values[0])] } });
  if (!column && rule.key === "updatedAt") return { updatedAt: { $gte: new Date(values[0]) } };
  switch (rule.cmp) {
    case "equalsText": return { [path]: { $regex: `^${escapeRegex(values[0].trim())}$`, $options: "i" } };
    case "gt": return { $and: [numeric("$gt"), { [path]: { $nin: ["", null] } }] };
    case "lt": return { $and: [numeric("$lt"), { [path]: { $nin: ["", null] } }] };
    case "before": return { [path]: { $lt: values[0], $nin: ["", null] } };
    case "after": return { [path]: { $gt: values[0] } };
    case "onOrAfter": return { [path]: { $gte: values[0] } };
    case "dateRange": return { [path]: { $gte: values[0], $lte: values[1] ?? values[0] } };
    case "in": return { [path]: { $in: literals(values, column) } };
    case "notIn": return { [path]: { $nin: literals(values, column) } };
    case "contains": return { $or: values.map((v) => ({ [path]: { $regex: escapeRegex(v), $options: "i" } })) };
    case "notContains": return { $and: values.map((v) => ({ [path]: { $not: { $regex: escapeRegex(v), $options: "i" } } })) };
    case "empty": return { [path]: { $in: ["", null, []] } };
    case "notEmpty": return { [path]: { $nin: ["", null, []] } };
    case "anyToken": { const named = values.filter(Boolean), or = []; if (named.length) or.push({ [path]: { $regex: tokenPattern(named) } }); if (named.length !== values.length) or.push({ [path]: { $in: ["", null] } }); return or.length === 1 ? or[0] : { $or: or }; }
    case "noToken": { const named = values.filter(Boolean), and = []; if (named.length) and.push({ [path]: { $not: { $regex: tokenPattern(named) } } }); if (named.length !== values.length) and.push({ [path]: { $nin: ["", null] } }); return and.length === 1 ? and[0] : { $and: and }; }
    default: throw new TypeError("Unknown comparison.");
  }
}
function filterQuery(filter, board) {
  const byKey = new Map(board.columns.map((c) => [c.key, c]));
  const node = ({ op, rules = [], groups = [] }) => {
    const parts = [...rules.map((r) => ruleQuery(r, byKey)), ...groups.map(node)];
    if (parts.length === 1) return parts[0];
    return { [op === "or" ? "$or" : "$and"]: parts };
  };
  return node(filter);
}

// Everything after the last row of a page: lexicographic on the sort keys, then _id, with MongoDB's order for missing
// values (null sorts lowest).
function afterQuery(orderBy, values, id) {
  const beyond = ({ path, dir }, value) => {
    if (dir === "asc") return value === null ? { [path]: { $ne: null } } : { [path]: { $gt: value } };
    return value === null ? null : { $or: [{ [path]: { $lt: value } }, { [path]: null }] };
  };
  const branches = [];
  const equal = {};
  orderBy.forEach((s, i) => {
    const b = beyond(s, values[i]);
    if (b) branches.push({ ...equal, ...b });
    equal[s.path] = values[i];
  });
  const idDir = orderBy.at(-1).dir === "desc" ? "$lt" : "$gt";
  branches.push({ ...equal, _id: { [idDir]: id } });
  return { $or: branches };
}

// Sorting by a column, which may hold anything: several values (MongoDB orders a list by its lowest value going up and its highest
// going down), or numbers next to numbers kept as text. A query on a field only reaches values of the same type and looks inside
// lists, so paging with one would lose or repeat rows. These pages compute each row's sort value instead, and order and continue on
// that, so every row has exactly one place. Used only for column sorts; the indexed orders keep using afterQuery.
const sortValue = ({ path, dir }) => ({ $let: { vars: { v: `$${path}` }, in: { $cond: [{ $isArray: "$$v" }, { $ifNull: [{ [dir === "desc" ? "$max" : "$min"]: "$$v" }, null] }, { $ifNull: ["$$v", null] }] } } });
const SORT_FIELD = "__sort";
function columnSortStages(orderBy, after) {
  const keyOf = (i) => `${SORT_FIELD}.k${i}`, sort = Object.fromEntries(orderBy.map((s, i) => [keyOf(i), s.dir === "desc" ? -1 : 1]));
  const idDir = orderBy.at(-1).dir === "desc" ? -1 : 1;
  const stages = [{ $addFields: { [SORT_FIELD]: Object.fromEntries(orderBy.map((s, i) => [`k${i}`, sortValue(s)])) } }];
  if (after) {
    const equal = [], branches = [];
    orderBy.forEach((s, i) => {
      const k = `$${keyOf(i)}`, value = { $literal: after.values[i] };
      branches.push({ $and: [...equal, { [s.dir === "desc" ? "$lt" : "$gt"]: [k, value] }] });
      equal.push({ $eq: [k, value] });
    });
    branches.push({ $and: [...equal, { [idDir === -1 ? "$lt" : "$gt"]: ["$_id", after.oid] }] });
    stages.push({ $match: { $expr: { $or: branches } } });
  }
  stages.push({ $sort: { ...sort, _id: idDir } });
  return stages;
}

const pathValue = (doc, path) => { let v = doc; for (const p of path.split(".")) v = v?.[p]; return v === undefined ? null : v; };
// sortValues: the row's computed sort values, on a page sorted by a column.
function encodeCursor(orderBy, doc, sortValues = null) {
  const values = orderBy.map((s, i) => { const v = sortValues ? (sortValues[`k${i}`] ?? null) : pathValue(doc, s.path); return v instanceof Date ? { d: v.toISOString() } : v; });
  return Buffer.from(JSON.stringify({ o: orderBy.map((s) => `${s.key}:${s.dir}`), v: values, i: doc._id.toHexString() })).toString("base64url");
}
function decodeCursor(text, orderBy) {
  const invalid = () => fail("cursor is not valid for this list. Start again from the first page.");
  if (typeof text !== "string" || text.length > 4000 || !/^[A-Za-z0-9_-]+$/.test(text)) invalid();
  let c; try { c = JSON.parse(Buffer.from(text, "base64url").toString("utf8")); } catch { invalid(); }
  if (!isPlain(c) || !Array.isArray(c.v) || !Array.isArray(c.o) || c.o.join() !== orderBy.map((s) => `${s.key}:${s.dir}`).join() || c.v.length !== orderBy.length || typeof c.i !== "string" || !/^[0-9a-f]{24}$/.test(c.i)) invalid();
  const values = c.v.map((v) => {
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) return v;
    if (isPlain(v) && typeof v.d === "string" && !Number.isNaN(Date.parse(v.d))) return new Date(v.d);
    return invalid();
  });
  return { values, id: c.i };
}

// Sorting by a column: numbers kept as text order numerically, as people expect, and comparisons stay case-sensitive.
const COLLATION = Object.freeze({ locale: "en", numericOrdering: true });

module.exports = { columnSortStages, SORT_FIELD, cleanFilter, cleanOrderBy, filterForBoard, orderByForBoard, filterQuery, afterQuery, encodeCursor, decodeCursor, rulesIn, escapeRegex, COLLATION, CMPS, MAX };
