// Fabric Data request parsing. Every failure is 400 VALIDATION_ERROR with a short reason that is safe to show. Query values
// arrive as strings: unknown, repeated (array) or object parameters are refused, so nothing a client sends can become a field
// name or an operator. Cursors are opaque (base64url JSON) and bound to the route, the sort and the filters they were issued
// for: at most 512 characters, as before phase 7 (the external token API and the invoice views), and 2,048 only on the session
// API's records route (advanced), where filter models and orderBy keys make longer positions. The session API (advanced) also takes filter= (the v1 model, filter-model.js), orderBy= and
// searchField=; the external API refuses them as unknown parameters.
const crypto = require("crypto");
const { ObjectId, Decimal128 } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const fm = require("./filter-model");

const DAY_MS = 24 * 60 * 60 * 1000;
const CURSOR_MAX = 512; // the efbfdf4 limit: every route by default, the external API always
const SESSION_CURSOR_MAX = 2048; // the session records route only (advanced)
const LIMITS = Object.freeze({ defaultDays: 30, maxDays: 92, invoicePageMax: 100, linePageMax: 200, recordPageMax: 200, recordPageDefault: 100 });
const fail = (message) => { throw new ApiError(400, "VALIDATION_ERROR", message); };
const CONTROL = /[\u0000-\u001f\u007f]/;

// Only the listed parameters, each given once as text.
function params(query, allowed) {
  const out = {};
  for (const key of Object.keys(query || {})) {
    if (!allowed.includes(key)) fail(`Unknown parameter "${key.slice(0, 40).replace(CONTROL, "")}".`);
    const value = query[key];
    if (typeof value !== "string") fail(`${key} must be given once.`);
    out[key] = value;
  }
  return out;
}

// YYYY-MM-DD → that UTC day's midnight, or a 400.
function utcDay(text, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`${label} must be a date such as 2026-01-31.`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) fail(`${label} is not a real date.`);
  return date;
}
const dayText = (date) => date.toISOString().slice(0, 10);

// dateFrom / dateTo: UTC days, both inclusive; default the last 30 days ending today; at most 92 days.
function dateWindow(p, now) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = p.dateTo !== undefined ? utcDay(p.dateTo, "dateTo") : null;
  const from = p.dateFrom !== undefined ? utcDay(p.dateFrom, "dateFrom") : null;
  const end = to || (from ? new Date(Math.min(from.getTime() + (LIMITS.defaultDays - 1) * DAY_MS, Math.max(today.getTime(), from.getTime()))) : today);
  const start = from || new Date(end.getTime() - (LIMITS.defaultDays - 1) * DAY_MS);
  if (start > end) fail("dateFrom must be on or before dateTo.");
  if ((end - start) / DAY_MS + 1 > LIMITS.maxDays) fail(`The date range can be at most ${LIMITS.maxDays} days.`);
  return { from: start, toExcl: new Date(end.getTime() + DAY_MS), dateFrom: dayText(start), dateTo: dayText(end) };
}

// company: exact; "~" means no company (null). Path segments may be longer than the query parameter.
function company(text, max = 64) {
  if (text === undefined) return undefined;
  if (!text.length || text.length > max || CONTROL.test(text)) fail(`company must be 1 to ${max} characters.`);
  return text === "~" ? null : text;
}
function searchText(text) {
  if (text === undefined) return null;
  const q = text.trim();
  if (!q) return null; // an empty search box is no search
  if (q.length > 100 || CONTROL.test(q)) fail("q must be 1 to 100 characters.");
  return q;
}
function limit(text, max, fallback) {
  if (text === undefined) return fallback;
  if (!/^\d{1,3}$/.test(text) || Number(text) < 1 || Number(text) > max) fail(`limit must be a whole number from 1 to ${max}.`);
  return Number(text);
}
const choice = (text, allowed, fallback, label) => {
  if (text === undefined) return fallback;
  if (!allowed.includes(text)) fail(`${label} must be one of: ${allowed.join(", ")}.`);
  return text;
};

// ---- Cursors ----
// Values are typed so that they go back into a query exactly as they came out: s string, n number, d date, o ObjectId,
// m Decimal128 (its exact text, never rounded through a JS number), null.
const DECIMAL_TEXT = /^-?\d{1,34}(\.\d{1,34})?(E[+-]?\d{1,4})?$/;
const encodeValue = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return { s: v };
  if (typeof v === "boolean") return { b: v };
  if (typeof v === "number" && Number.isFinite(v)) return { n: v };
  if (v instanceof Date) return { d: v.toISOString() };
  if (v?._bsontype === "ObjectId") return { o: v.toHexString() };
  if (v?._bsontype === "Decimal128") { const text = v.toString(); return DECIMAL_TEXT.test(text) ? { m: text } : null; }
  return null;
};
const decodeValue = (v) => {
  if (v === null) return null;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 1) fail("cursor is not valid.");
  if (typeof v.s === "string" && v.s.length <= 400) return v.s;
  if (typeof v.b === "boolean") return v.b;
  if (typeof v.n === "number" && Number.isFinite(v.n)) return v.n;
  if (typeof v.d === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.d) && !Number.isNaN(Date.parse(v.d))) return new Date(v.d);
  if (typeof v.o === "string" && /^[0-9a-f]{24}$/.test(v.o)) return ObjectId.createFromHexString(v.o);
  if (typeof v.m === "string" && v.m.length <= 80 && DECIMAL_TEXT.test(v.m)) { try { return Decimal128.fromString(v.m); } catch { return fail("cursor is not valid."); } }
  return fail("cursor is not valid.");
};
// A cursor is signed (HMAC-SHA256 with a random key made when the process starts) over the route, every filter and sort that
// shaped the page, and its own position values: a client can neither forge a position nor reuse a cursor for another list.
// After a restart every earlier cursor is refused (400, "start again from the first page").
const CURSOR_KEY = crypto.randomBytes(32);
// A timed cursor (session records route only) also signs its issued-at time t; an untimed one signs exactly what efbfdf4 signed.
const signatureOf = (route, binding, encoded, t) => crypto.createHmac("sha256", CURSOR_KEY).update(JSON.stringify(t === undefined ? [route, binding, encoded] : [route, binding, encoded, t])).digest("base64url").slice(0, 22);
// null when a position can't be carried (more than `max` characters in all; with the session limit also a key text over 400
// characters): the client gets no further page (the session records route then reports pagination.cursorTooLong).
// max: CURSOR_MAX (512, the default and the external API) or SESSION_CURSOR_MAX (the session records route).
// issuedAt (ms, session records route only): carried and signed as t, { b, v, t }; without it the cursor is { b, v } as in efbfdf4.
function encodeCursor(route, binding, values, max = CURSOR_MAX, { issuedAt } = {}) {
  if (max > CURSOR_MAX && values.some((v) => typeof v === "string" && v.length > 400)) return null;
  const encoded = values.map(encodeValue);
  const timed = Number.isSafeInteger(issuedAt) && issuedAt >= 0;
  const payload = timed ? { b: signatureOf(route, binding, encoded, issuedAt), v: encoded, t: issuedAt } : { b: signatureOf(route, binding, encoded), v: encoded };
  const text = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return text.length <= max ? text : null;
}
function readCursor(text, route, binding, length, max, timed) {
  if (!text.length || text.length > max || !/^[A-Za-z0-9_-]+$/.test(text)) fail("cursor is not valid.");
  let parsed;
  try { parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8")); } catch { fail("cursor is not valid."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== (timed ? 3 : 2) || typeof parsed.b !== "string" || !Array.isArray(parsed.v) || parsed.v.length !== length) fail("cursor is not valid.");
  if (timed && !(Number.isSafeInteger(parsed.t) && parsed.t >= 0)) fail("cursor is not valid.");
  const expected = Buffer.from(timed ? signatureOf(route, binding, parsed.v, parsed.t) : signatureOf(route, binding, parsed.v));
  const given = Buffer.from(parsed.b);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) fail("cursor belongs to a different list or filter, or has expired. Start again from the first page.");
  return { values: parsed.v.map(decodeValue), issuedAt: timed ? parsed.t : null };
}
function decodeCursor(text, route, binding, length, max = CURSOR_MAX) {
  if (text === undefined) return null;
  return readCursor(text, route, binding, length, max, false).values;
}
// A timed cursor (encodeCursor with issuedAt): { values, issuedAt } (null without a cursor); an untimed one is refused.
function decodeTimedCursor(text, route, binding, length, max = SESSION_CURSOR_MAX) {
  if (text === undefined) return null;
  return readCursor(text, route, binding, length, max, true);
}

// ---- Per route ----
const INVOICE_SORT = ["invoiceDate", "invoiceNo", "customerName", "amount"];
const INVOICE_SORT_LENGTH = { invoiceDate: 3, invoiceNo: 2, customerName: 3, amount: 3 };
function invoiceListQuery(query, now = new Date()) {
  const p = params(query, ["dateFrom", "dateTo", "company", "q", "sort", "dir", "limit", "cursor"]);
  const window = { ...dateWindow(p, now), company: company(p.company), q: searchText(p.q) };
  const sort = choice(p.sort, INVOICE_SORT, "invoiceDate", "sort");
  const dir = choice(p.dir, ["asc", "desc"], "desc", "dir");
  const binding = { w: [window.dateFrom, window.dateTo, window.company ?? (window.company === null ? "~" : undefined), window.q], sort, dir };
  return { window, sort, dir: dir === "asc" ? 1 : -1, limit: limit(p.limit, LIMITS.invoicePageMax, 50), binding, cursorValues: decodeCursor(p.cursor, "invoices", binding, INVOICE_SORT_LENGTH[sort]) };
}
// ---- Dataset explorers (datasets.js) ----
// GET /:dataset/records, first step (no database needed): every parameter checked against the dataset's allow-lists. A
// sensitive field the caller may not see is refused exactly like a field that doesn't exist. The window and the cursor are
// resolved by the service (resolveWindow, decodeCursor), which knows the dataset's latest date and the query mode.
// advanced (the session API only): filter= (validated and normalized against `now`), orderBy= and searchField= are accepted.
function recordsQuery(ds, query, { sensitive = false, advanced = false, now = new Date() } = {}) {
  const filterNames = Object.keys(ds.filters);
  const p = params(query, ["dateFrom", "dateTo", "q", "sort", "dir", "limit", "cursor", "fields", ...filterNames, ...(advanced ? ["filter", "orderBy", "searchField"] : [])]);
  const orderBy = advanced ? fm.parseOrderBy(ds, p.orderBy) : null;
  if (orderBy && (p.sort !== undefined || p.dir !== undefined)) fail("orderBy can't be combined with sort or dir.");
  const filter = advanced && p.filter !== undefined ? fm.validateFilter(ds, fm.parseFilterParam(p.filter), { now }) : null;
  let searchField = null;
  if (advanced && p.searchField !== undefined) {
    const entry = ds.searchFields.find(([f]) => f === p.searchField);
    if (!entry) fail("searchField must be one of the schema's searchFields.");
    searchField = entry;
  }
  const from = p.dateFrom !== undefined ? utcDay(p.dateFrom, "dateFrom") : null;
  const to = p.dateTo !== undefined ? utcDay(p.dateTo, "dateTo") : null;
  if (from && to && from > to) fail("dateFrom must be on or before dateTo.");
  const filters = [];
  for (const name of filterNames) {
    if (p[name] === undefined) continue;
    const { field, type } = ds.filters[name];
    filters.push({ name, field, value: filterValue(name, type, p[name]) });
  }
  if (p.cursor !== undefined && (!p.cursor.length || p.cursor.length > (advanced ? SESSION_CURSOR_MAX : CURSOR_MAX) || !/^[A-Za-z0-9_-]+$/.test(p.cursor))) fail("cursor is not valid.");
  const sort = choice(p.sort, Object.keys(ds.sorts), ds.defaultSort, "sort");
  // A sort whose index isn't led by the date (inventory entryNo: Company, Entry_No, _id) reads one company in entry order: the
  // company bounds the index walk, and a date window (which that index can't bound) is refused rather than scanned for.
  const def = ds.sorts[sort];
  if (def.requiresCompany && !filters.some((f) => f.name === "company")) fail(`sort=${sort} needs a company (company=… or company=~ for none).`);
  if (def.noDateWindow && (from || to)) fail(`sort=${sort} lists one company in entry order: leave out dateFrom and dateTo.`);
  return {
    from, to, q: searchText(p.q), filters, filter, orderBy, searchField,
    sort,
    dir: choice(p.dir, ["asc", "desc"], "desc", "dir") === "asc" ? 1 : -1,
    limit: limit(p.limit, LIMITS.recordPageMax, LIMITS.recordPageDefault),
    fields: fieldList(ds, p.fields, sensitive),
    cursor: p.cursor
  };
}
function filterValue(name, type, text) {
  if (type === "company") return company(text);
  if (type === "bool") { if (text !== "true" && text !== "false") fail(`${name} must be true or false.`); return text === "true"; }
  if (!text.length || text.length > 128 || CONTROL.test(text)) fail(`${name} must be 1 to 128 characters.`);
  return text;
}
// fields: a comma list of allowed (and, for sensitive fields, permitted) names; default the dataset's default columns.
function fieldList(ds, text, sensitive) {
  if (text === undefined) return [...ds.defaultColumns];
  const names = text.split(",");
  if (!text.length || names.length > ds.fields.length) fail(`fields must list 1 to ${ds.fields.length} field names.`);
  const permitted = new Set(ds.fields.filter((f) => sensitive || !ds.sensitive.includes(f)));
  for (const name of names) if (!permitted.has(name)) fail(`Unknown field "${name.slice(0, 60).replace(new RegExp(CONTROL.source, "g"), "")}".`);
  return [...new Set(names)];
}
// The date window: UTC days, both inclusive. Without dates: the defaultDays ending at the dataset's latest date (today when it
// isn't known), or no window at all when `optional` (small-collection inventory). maxDays: null = no limit.
// → { from, toExcl, dateFrom, dateTo, defaulted } or null (no window).
function resolveWindow(parsed, { latest = null, now = new Date(), maxDays = LIMITS.maxDays, optional = false } = {}) {
  const { from, to } = parsed;
  if (!from && !to && optional) return null;
  const refDate = latest instanceof Date && !Number.isNaN(latest.getTime()) ? latest : now;
  const ref = new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), refDate.getUTCDate()));
  const end = to || (from ? new Date(Math.min(from.getTime() + (LIMITS.defaultDays - 1) * DAY_MS, Math.max(ref.getTime(), from.getTime()))) : ref);
  const start = from || new Date(end.getTime() - (LIMITS.defaultDays - 1) * DAY_MS);
  if (start > end) fail("dateFrom must be on or before dateTo.");
  if (maxDays && (end - start) / DAY_MS + 1 > maxDays) fail(`The date range can be at most ${maxDays} days.`);
  return { from: start, toExcl: new Date(end.getTime() + DAY_MS), dateFrom: dayText(start), dateTo: dayText(end), defaulted: !from && !to };
}
function recordId(text) {
  if (typeof text !== "string" || !/^[0-9a-fA-F]{24}$/.test(text)) fail("id must be 24 hexadecimal characters.");
  return ObjectId.createFromHexString(text.toLowerCase());
}
// Path segments are already URL-decoded by Express. company "~" = no company.
function invoicePath(params_) {
  const segment = (value, label) => { if (typeof value !== "string" || !value.length || value.length > 128 || CONTROL.test(value)) fail(`${label} must be 1 to 128 characters.`); return value; };
  const c = segment(params_.company, "company");
  return { company: c === "~" ? null : c, invoiceNo: segment(params_.invoiceNo, "invoiceNo") };
}
function invoiceLinesQuery(query, key) {
  const p = params(query, ["limit", "cursor"]);
  const binding = [key.company, key.invoiceNo];
  return { limit: limit(p.limit, LIMITS.linePageMax, 100), binding, cursorValues: decodeCursor(p.cursor, "lines", binding, 2) };
}
function lineId(text) {
  if (typeof text !== "string" || !/^[0-9a-fA-F]{24}$/.test(text)) fail("lineId must be 24 hexadecimal characters.");
  return ObjectId.createFromHexString(text.toLowerCase());
}
const noParams = (query) => params(query, []);

module.exports = { invoiceListQuery, invoicePath, invoiceLinesQuery, lineId, recordsQuery, resolveWindow, recordId, noParams, encodeCursor, decodeCursor, decodeTimedCursor, dateWindow, LIMITS, CURSOR_MAX, SESSION_CURSOR_MAX };
