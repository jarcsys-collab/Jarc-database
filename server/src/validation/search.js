// Query validation for the Command Center search (GET /api/v1/search/global). Every value arrives as a query-string
// string; anything unexpected is a 400 with a reason that is safe to show. Nothing here reaches MongoDB unchecked:
// IDs become ObjectIds, the text query is later escaped into a literal pattern, filter values are compared by equality.
const { ObjectId } = require("mongodb");
const { fail, allowOnly, queryString, parseId } = require("./common");

const TYPES = Object.freeze(["workspace", "board", "record", "comment"]);
const PAGED_TYPES = Object.freeze(["record", "comment"]);
const MIN_QUERY = 2, MAX_QUERY = 100, MAX_FILTER = 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const USER_REF = /^user:([0-9a-f]{24})$/;
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;
// Control characters never take part in a search (they can't be typed and only make odd patterns).
const clean = (text) => text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

function filterText(raw, label) {
  const value = queryString(raw, label);
  if (value === undefined) return undefined;
  const text = clean(value);
  if (!text) return undefined;
  if (text.length > MAX_FILTER) fail(`${label} must be at most ${MAX_FILTER} characters.`);
  return text;
}

function day(raw, label, { end = false } = {}) {
  const value = queryString(raw, label);
  if (value === undefined || value === "") return undefined;
  if (!DATE.test(value)) fail(`${label} must be a date such as 2026-01-31.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(`${label} is not a real date.`);
  // "to" includes the whole day: everything before the start of the next one.
  return end ? new Date(date.getTime() + 86400000) : date;
}

// Opaque position after the last result of a page: base64url JSON { k: type, t: time (ms) | null, i: id }.
function encodeCursor(type, time, id) {
  return Buffer.from(JSON.stringify({ k: type, t: time instanceof Date ? time.getTime() : null, i: id.toHexString() })).toString("base64url");
}
function decodeCursor(raw, type) {
  if (!CURSOR.test(raw)) fail("cursor is not valid.");
  let value;
  try { value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); } catch { fail("cursor is not valid."); }
  if (!value || typeof value !== "object" || value.k !== type || !(value.t === null || Number.isSafeInteger(value.t)) || typeof value.i !== "string" || !/^[0-9a-f]{24}$/.test(value.i)) fail("cursor is not valid.");
  return { time: value.t === null ? null : new Date(value.t), id: new ObjectId(value.i) };
}

// → { q, types, workspaceId, boardId, status, priority, assignee ("me" | ObjectId), from, to, cursor, limit }
function searchParams(query, actorId) {
  allowOnly(query, ["q", "type", "workspaceId", "boardId", "status", "priority", "assignee", "from", "to", "cursor", "limit"], "the query");
  const rawQ = queryString(query.q, "q");
  const q = rawQ === undefined ? "" : clean(rawQ);
  if (q && (q.length < MIN_QUERY || q.length > MAX_QUERY)) fail(`q must be ${MIN_QUERY} to ${MAX_QUERY} characters.`);
  const typeText = queryString(query.type, "type");
  const types = typeText === undefined || typeText === "" ? [...TYPES] : [...new Set(typeText.split(","))];
  if (!types.length || types.length > TYPES.length || types.some((t) => !TYPES.includes(t))) fail(`type must be one or more of ${TYPES.join(", ")}.`);
  const workspaceId = queryString(query.workspaceId, "workspaceId") === undefined ? null : parseId(query.workspaceId, "workspaceId");
  const boardId = queryString(query.boardId, "boardId") === undefined ? null : parseId(query.boardId, "boardId");
  const status = filterText(query.status, "status");
  const priority = filterText(query.priority, "priority");
  const assigneeText = queryString(query.assignee, "assignee");
  let assignee;
  if (assigneeText === "me") assignee = actorId;
  else if (assigneeText !== undefined && assigneeText !== "") { const m = USER_REF.exec(assigneeText); if (!m) fail('assignee must be "me" or a person ("user:<id>").'); assignee = new ObjectId(m[1]); }
  const from = day(query.from, "from"), to = day(query.to, "to", { end: true });
  if (from && to && from >= to) fail("from must be on or before to.");
  const narrowed = Boolean(status || priority || assignee || from || to);
  if (!q && !narrowed) fail(`Type at least ${MIN_QUERY} characters, or choose a filter.`);
  const limitText = queryString(query.limit, "limit");
  if (limitText !== undefined && (!/^\d{1,2}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 25)) fail("limit must be a whole number from 1 to 25.");
  const cursorText = queryString(query.cursor, "cursor");
  let cursor = null;
  if (cursorText !== undefined) {
    if (types.length !== 1 || !PAGED_TYPES.includes(types[0])) fail("cursor needs exactly one type: record or comment.");
    cursor = decodeCursor(cursorText, types[0]);
  }
  return { q, types, workspaceId, boardId, status, priority, assignee, from, to, cursor, limit: limitText === undefined ? null : Number(limitText), narrowed };
}

// GET /me/recents and POST /me/recents: "<type>:<24 hex>" references, nothing else.
const REF = /^(workspace|board|record):([0-9a-f]{24})$/;
function destinationRef(value, label = "ref") {
  if (typeof value !== "string" || !REF.test(value)) fail(`${label} must look like "board:<id>".`);
  const [, type, id] = REF.exec(value);
  return { type, id: new ObjectId(id) };
}

module.exports = { searchParams, encodeCursor, decodeCursor, destinationRef, TYPES, MIN_QUERY, MAX_QUERY };
