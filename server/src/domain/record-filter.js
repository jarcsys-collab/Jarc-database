// Filter conditions for a board's records: what saved views store, and what GET /boards/:id/records?filter= runs against
// every record of the board (not only those a browser has loaded).
//
//   filter   { op: "and" | "or", rules: [{ key, cmp, values? }], groups?: [{ op, rules, groups? }] }. Groups nest up to
//            MAX.depth levels (a filter saved before nesting existed has one level and reads the same).
//   cmp      in, notIn          the cell equals (or doesn't equal) one of the values; "" means an empty cell
//            contains, notContains   the text contains a value, ignoring case
//            empty, notEmpty    the cell has no value / has a value
//            anyToken, noToken  one of a cell's comma-separated entries equals a value (monday.com linked and mirrored
//                               columns were migrated as display text, such as "Item A, Item B")
//            equalsText         the text equals a value, ignoring case
//            gt, lt             numerically greater or less than the value (numbers may be stored as text)
//            eq, ne, gte, lte   numerically equal / not equal (empty cells count as not equal) / at least / at most
//            between            numerically within [from, to], both included
//            startsWith, endsWith   the text starts or ends with a value, ignoring case
//            notEqualsText      the text isn't the value, ignoring case (the opposite of equalsText; empty cells included)
//            checked, unchecked a checkbox column is ticked / isn't
//            datePreset         a date column within a period counted from today when the query runs, in TIME_ZONE:
//                               ["today" | "yesterday" | "tomorrow" | "thisWeek" | "lastWeek" | "nextWeek" | "thisMonth" |
//                               "lastMonth" | "nextMonth"] or ["pastDays" | "nextDays", N]: pastDays N = today and the N days
//                               before it; nextDays N = today and the N days after it. Weeks run Monday to Sunday.
//   "@me"    in in / notIn / anyToken / noToken on a People column: the person reading, from their session (never a
//            value sent as an identity). The same saved filter shows each person their own records. With no reader
//            known, a rule using it matches no record at all (never "everyone"). Elsewhere "@me" is plain text.
//            before, after, onOrAfter, dateRange   dates, compared as their ISO text; dateRange is [from, to] inclusive
//   numbers  eq, gte, lte and between match only cells holding a number (numbers kept as text count); an empty or
//            non-numeric cell never matches them. ne matches every cell that isn't that number, empty ones included. gt and lt
//            keep their earlier answers (saved views from before): empty never matches; other non-numbers count as below every number.
//   group    a Group column with in / notIn and group names ("" = no group): the record's group (groupId), not a cell
//   connect  a Connect boards column: empty / notEmpty only. mirror: never (its values live on other boards)
//   key      a column; also updatedAt with onOrAfter (a date and time), and __record_id with in (exact record IDs)
//   orderBy  [{ key, dir }], at most four: a column, or pinned / createdAt / updatedAt / position / __record_id (the record's
//            permanent ID). _id always breaks ties, so nothing after __record_id changes the order and it is dropped.
//
// Column keys must exist on the board and values are compared literally (regular expressions are escaped), so nothing from
// a request reaches MongoDB as an operator or a field name. The same rules run in the browser (BoardModel.matchesViewFilter).
const { ObjectId } = require("mongodb");
const { fail, isSafeKey, RECORD_ID_KEY, OBJECT_ID } = require("../validation/common");
const { ApiError } = require("../middleware/errors");

const CMPS = Object.freeze(["in", "notIn", "contains", "notContains", "empty", "notEmpty", "anyToken", "noToken", "equalsText", "gt", "lt", "before", "after", "onOrAfter", "dateRange",
  "startsWith", "endsWith", "notEqualsText", "eq", "ne", "gte", "lte", "between", "checked", "unchecked", "datePreset"]);
const NO_VALUES = new Set(["empty", "notEmpty", "checked", "unchecked"]);
// The numeric comparisons added with Advanced Filters: their values must be numbers. (gt and lt are older and stay as they were.)
const NUMERIC = new Set(["eq", "ne", "gte", "lte", "between"]);
const ME = "@me", ME_CMPS = new Set(["in", "notIn", "anyToken", "noToken"]);
const PRESETS = Object.freeze(["today", "yesterday", "tomorrow", "thisWeek", "lastWeek", "nextWeek", "thisMonth", "lastMonth", "nextMonth", "pastDays", "nextDays"]);
// Relative dates are counted in this time zone (JARC's people are in the Philippines); the browser uses the same one.
const TIME_ZONE = "Asia/Manila";
const META_SORTS = Object.freeze({ pinned: "pinned", createdAt: "createdAt", updatedAt: "updatedAt", position: "position", [RECORD_ID_KEY]: "_id" });
const META_FILTERS = new Set(["updatedAt", RECORD_ID_KEY]);
// rules and groups: across the whole filter, nested groups included (the limits from before nesting, unchanged).
const MAX = Object.freeze({ rules: 25, groups: 10, depth: 3, values: 100, value: 500, orderBy: 4, text: 6000, days: 3650 });
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
  if (rule.cmp === "between" && rule.values.length !== 2) fail(`${where} needs a from and a to.`);
  if (NUMERIC.has(rule.cmp) && rule.values.slice(0, rule.cmp === "between" ? 2 : 1).some((v) => v.trim() === "" || !Number.isFinite(Number(v)))) fail(`${where} needs a number.`);
  if (rule.cmp === "datePreset") {
    const [preset, n] = rule.values;
    if (!PRESETS.includes(preset)) fail(`${where} has an unknown period.`);
    const counted = preset === "pastDays" || preset === "nextDays";
    if (counted ? !(rule.values.length === 2 && /^\d{1,4}$/.test(n) && Number(n) >= 1 && Number(n) <= MAX.days) : rule.values.length !== 1) fail(`${where} needs ${counted ? `a number of days from 1 to ${MAX.days}` : "just the period"}.`);
  }
  return { key: rule.key, cmp: rule.cmp, values: [...rule.values] };
}

// The stored shape, without looking at any board: a saved view can outlive a column.
function cleanFilter(raw) {
  let groups = 0, total = 0;
  const op = (v) => { if (v !== "and" && v !== "or") fail('A filter\x27s op must be "and" or "or".'); return v; };
  const node = (n, depth, where) => {
    if (!isPlain(n)) fail(`${where} must be an object.`);
    for (const k of Object.keys(n)) if (!["op", "rules", "groups"].includes(k)) fail(`${where} has an unknown field.`);
    const list = n.rules === undefined ? [] : n.rules, kids = n.groups === undefined ? [] : n.groups;
    if (!Array.isArray(list)) fail(`${where}'s rules must be a list.`);
    if (!Array.isArray(kids)) fail(`${where}'s groups must be a list.`);
    if (kids.length && depth >= MAX.depth) fail(`Groups can be nested at most ${MAX.depth} levels deep.`);
    groups += kids.length; if (groups > MAX.groups) fail(`A filter can have at most ${MAX.groups} groups.`);
    const clean = { op: op(n.op), rules: list.map((r, i) => cleanRule(r, `Condition ${i + 1}`)) };
    total += clean.rules.length; if (total > MAX.rules) fail(`A filter can have at most ${MAX.rules} conditions.`);
    const cleanKids = kids.map((g) => node(g, depth + 1, "A filter group"));
    if (cleanKids.length) clean.groups = cleanKids;
    return clean;
  };
  if (!isPlain(raw)) fail("The filter must be an object.");
  const clean = node(raw, 0, "The filter");
  if (!total) fail("A filter needs at least one condition.");
  return clean;
}

function cleanOrderBy(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX.orderBy) fail(`orderBy must list 1 to ${MAX.orderBy} columns.`);
  return raw.map((s) => {
    if (!isPlain(s) || !isSafeKey(s.key) || !["asc", "desc"].includes(s.dir) || Object.keys(s).some((k) => k !== "key" && k !== "dir")) fail("orderBy entries need a column key and a direction.");
    return { key: s.key, dir: s.dir };
  });
}

const rulesIn = (filter) => [...(filter.rules || []), ...(filter.groups || []).flatMap(rulesIn)];
// Against a board: every column must exist, and each comparison must suit the column's type (checkRuleType).
function filterForBoard(raw, board) {
  const filter = cleanFilter(raw), byKey = new Map(board.columns.map((c) => [c.key, c]));
  for (const r of rulesIn(filter)) {
    if (r.key === RECORD_ID_KEY && !byKey.has(r.key)) { if (r.cmp !== "in" || !r.values.every((v) => OBJECT_ID.test(v))) fail("A Record ID filter needs exact record IDs (24 hexadecimal characters)."); continue; }
    if (META_FILTERS.has(r.key) && !byKey.has(r.key)) { if (r.cmp !== "onOrAfter" || Number.isNaN(Date.parse(r.values?.[0]))) fail("updatedAt can only be filtered from a date."); continue; } const c = byKey.get(r.key); if (!c) fail(`The filter names a column this board doesn't have (${r.key.slice(0, 40)}).`); checkRuleType(r, c); }
  return filter;
}
// S0-B (plan 17 §1, X2 "lock only, no count"): a reader who can't open a Connect column's linked board may not filter by it (nor by
// the Mirrors that follow it). Even empty / not empty would tell them which records have links, through the rows or a count. The
// whole request is refused before any query, with a message that names only the column (which is already shown as locked).
// restricted: Set of the keys restrictedFor() returns for this reader. Applies to filter AND also (saved-view conditions).
function refuseRestricted(filters, board, restricted) {
  if (!restricted || !restricted.size) return;
  const byKey = new Map((board.columns || []).map((c) => [c.key, c]));
  for (const f of filters) if (f) for (const r of rulesIn(f)) if (restricted.has(r.key)) {
    const c = byKey.get(r.key);
    // details: which column (its key, as the reader's board already lists it) so the browser can say so; nothing about the linked board.
    throw new ApiError(400, "VALIDATION_ERROR", `"${String(c?.label || r.key).slice(0, 40)}" can't be filtered: you can't open the board it links to. Remove that condition to see the records.`, { reason: "restricted-filter", field: r.key });
  }
}
// Which comparisons a column type takes. The comparisons from before stay as permissive as they were (saved views from
// the monday.com migration use them on text columns); the newer ones are checked against the column's type.
function checkRuleType(r, c) {
  const refuse = (what) => fail(`"${String(c.label || c.key).slice(0, 40)}" can't be filtered ${what}.`);
  if (c.type === "mirror") refuse("(its values come from another board)");
  if (c.type === "connect" && !["empty", "notEmpty"].includes(r.cmp)) refuse("except by whether it has linked records");
  if (c.type === "group" && !["in", "notIn"].includes(r.cmp)) refuse("except by is / is not");
  if ((r.cmp === "checked" || r.cmp === "unchecked") && c.type !== "checkbox") refuse("as checked or unchecked");
  if (r.cmp === "datePreset" && c.type !== "date") refuse("by a period of dates");
  if (NUMERIC.has(r.cmp) && !["number", "text"].includes(c.type)) refuse("as a number");
}
// "@me" stands for the reader only on a People column compared with is / is not; anywhere else it is just text.
const meApplies = (rule, column) => column?.type === "owner" && ME_CMPS.has(rule.cmp) && (rule.values || []).includes(ME);
function orderByForBoard(raw, board) {
  const orderBy = cleanOrderBy(raw), byKey = new Map(board.columns.map((c) => [c.key, c]));
  const out = orderBy.map(({ key, dir }) => {
    if (META_SORTS[key] && !byKey.has(key)) return { key, dir, path: META_SORTS[key] };
    const c = byKey.get(key);
    if (!c || c.type === "group") fail(`orderBy names a column this board doesn't have (${key.slice(0, 40)}).`);
    return { key, dir, path: `values.${key}`, type: c.type };
  // S0-B / C3.0 (plan 17 §2, corrected rather than refused so saved views keep loading): a Connect cell holds record IDs and a
  // Mirror has no stored value, so the server never sorts by them (that would order by hex IDs, or by an always-missing field).
  // The browser sorts the loaded rows by linked name instead. A bounded server sort is M3.4.
  }).filter((s) => s.type !== "connect" && s.type !== "mirror").map(({ type, ...s }) => s);
  if (!out.length) return [{ key: "position", dir: "asc", path: "position" }];
  // Record IDs are unique: anything sorted after one can't change the order, and _id must stay the last key.
  const id = out.findIndex((s) => s.path === "_id");
  return id === -1 ? out : out.slice(0, id + 1);
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

// ---- Values that depend on when and by whom a filter is read ------------------------------------------------------------
// Today in TIME_ZONE as "YYYY-MM-DD", built from the parts (never from a locale's own format).
function dayIn(now = new Date(), timeZone = TIME_ZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
// Calendar arithmetic on a "YYYY-MM-DD" day, done in UTC: a day has no time of day, so daylight saving can't shift it.
const dayDate = (day) => new Date(`${day}T00:00:00Z`);
const dayText = (date) => date.toISOString().slice(0, 10);
const addDays = (day, n) => { const d = dayDate(day); d.setUTCDate(d.getUTCDate() + n); return dayText(d); };
const monthStart = (day, offset) => { const d = dayDate(day); return dayText(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1))); };
const monthEnd = (day, offset) => { const d = dayDate(day); return dayText(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset + 1, 0))); };
// A period counted from today: [from, to], both days included. Weeks run Monday to Sunday.
function presetRange(preset, n, today) {
  const monday = addDays(today, -((dayDate(today).getUTCDay() + 6) % 7));
  switch (preset) {
    case "today": return [today, today];
    case "yesterday": return [addDays(today, -1), addDays(today, -1)];
    case "tomorrow": return [addDays(today, 1), addDays(today, 1)];
    case "thisWeek": return [monday, addDays(monday, 6)];
    case "lastWeek": return [addDays(monday, -7), addDays(monday, -1)];
    case "nextWeek": return [addDays(monday, 7), addDays(monday, 13)];
    case "thisMonth": return [monthStart(today, 0), monthEnd(today, 0)];
    case "lastMonth": return [monthStart(today, -1), monthEnd(today, -1)];
    case "nextMonth": return [monthStart(today, 1), monthEnd(today, 1)];
    case "pastDays": return [addDays(today, -n), today];
    case "nextDays": return [today, addDays(today, n)];
    default: throw new TypeError("Unknown period.");
  }
}
// The filter made concrete for one reading. ctx.me: the reader as "user:<id>", taken by the caller from the authenticated
// session — never from the request. ctx.today: "YYYY-MM-DD" (default: today in TIME_ZONE).
//   datePreset → dateRange [from, to]
//   "@me" on a People column → ctx.me; without a reader the rule becomes "never" (matches no record, whatever the comparison)
function resolveFilter(filter, ctx, byKey) {
  const me = typeof ctx?.me === "string" && /^user:[0-9a-f]{24}$/.test(ctx.me) ? ctx.me : null, today = ctx?.today || dayIn();
  const rule = (r) => {
    if (r.cmp === "datePreset") return { key: r.key, cmp: "dateRange", values: presetRange(r.values[0], Number(r.values[1] || 0), today) };
    if (meApplies(r, byKey.get(r.key))) return me ? { ...r, values: r.values.map((v) => (v === ME ? me : v)) } : { key: r.key, cmp: "never" };
    return r;
  };
  const node = (n) => ({ op: n.op, rules: (n.rules || []).map(rule), ...(n.groups ? { groups: n.groups.map(node) } : {}) });
  return node(filter);
}

function ruleQuery(rule, byKey, board) {
  const path = `values.${rule.key}`, column = byKey.get(rule.key), values = rule.values || [];
  // The cell as a number: numbers, and numbers kept as text; anything else (empty, words, a list) is null — and null must not
  // take part in a comparison, because MongoDB orders null below every number (it would be "less than 7").
  const asNumber = { $convert: { input: `$${path}`, to: "double", onError: null, onNull: null } };
  const numeric = (op, value = values[0]) => ({ $expr: { $and: [{ $ne: [asNumber, null] }, { [op]: [asNumber, Number(value)] }] } });
  const legacyNumeric = (op) => ({ $expr: { [op]: [asNumber, Number(values[0])] } }); // gt / lt, unchanged
  if (rule.cmp === "never") return { _id: null }; // every record has an _id: matches nothing
  if (!column && rule.key === "updatedAt") return { updatedAt: { $gte: new Date(values[0]) } };
  if (!column && rule.key === RECORD_ID_KEY) return { _id: { $in: values.map((v) => new ObjectId(v)) } };
  // A Group column: the record's group by its stable ID (records keep it in groupId, not in a cell). "" = no group.
  if (column?.type === "group") {
    const ids = (board?.groups || []).filter((g) => values.includes(g.name)).map((g) => g.id);
    if (values.includes("")) ids.push(null);
    return { groupId: { [rule.cmp === "notIn" ? "$nin" : "$in"]: ids } };
  }
  switch (rule.cmp) {
    case "startsWith": return { [path]: { $regex: `^${escapeRegex(values[0])}`, $options: "i" } };
    case "endsWith": return { [path]: { $regex: `${escapeRegex(values[0])}$`, $options: "i" } };
    case "notEqualsText": return { [path]: { $not: { $regex: `^${escapeRegex(values[0].trim())}$`, $options: "i" } } };
    case "eq": return numeric("$eq");
    case "ne": return { $expr: { $ne: [asNumber, Number(values[0])] } }; // an empty or non-numeric cell isn't that number: included
    case "gte": return numeric("$gte");
    case "lte": return numeric("$lte");
    case "between": return { $and: [numeric("$gte", values[0]), numeric("$lte", values[1])] };
    case "checked": return { [path]: { $in: [true, "true"] } };
    case "unchecked": return { [path]: { $nin: [true, "true"] } };
    case "equalsText": return { [path]: { $regex: `^${escapeRegex(values[0].trim())}$`, $options: "i" } };
    // gt / lt answer exactly as before Advanced Filters (saved views keep their results): a cell that isn't a number counts
    // as below every number (MongoDB orders null first), so "lt" includes words; empty cells never match.
    case "gt": return { $and: [legacyNumeric("$gt"), { [path]: { $nin: ["", null] } }] };
    case "lt": return { $and: [legacyNumeric("$lt"), { [path]: { $nin: ["", null] } }] };
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
// ctx: { me, today } for this reading (see resolveFilter). Without ctx: no reader, today in TIME_ZONE.
function filterQuery(filter, board, ctx = {}) {
  const byKey = new Map(board.columns.map((c) => [c.key, c]));
  const node = ({ op, rules = [], groups = [] }) => {
    const parts = [...rules.map((r) => ruleQuery(r, byKey, board)), ...groups.map(node)];
    if (parts.length === 1) return parts[0];
    return { [op === "or" ? "$or" : "$and"]: parts };
  };
  return node(resolveFilter(filter, ctx, byKey));
}

// Everything after the last row of a page: lexicographic on the sort keys, then _id, with MongoDB's order for missing
// values (null sorts lowest).
function afterQuery(orderBy, values, id) {
  // A cursor carries a record ID as text; compared with _id it must be an ObjectId again.
  values = values.map((v, i) => (orderBy[i].path === "_id" && typeof v === "string" && OBJECT_ID.test(v) ? new ObjectId(v) : v));
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

module.exports = { TIME_ZONE, ME, PRESETS, dayIn, addDays, presetRange, resolveFilter, RECORD_ID_KEY, columnSortStages, SORT_FIELD, cleanFilter, cleanOrderBy, filterForBoard, refuseRestricted, orderByForBoard, filterQuery, afterQuery, encodeCursor, decodeCursor, rulesIn, escapeRegex, COLLATION, CMPS, MAX };
