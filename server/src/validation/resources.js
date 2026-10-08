// Request validation for the resource API. Each function returns a new object containing only allowed, checked
// fields, so request bodies are never passed to MongoDB as they arrive.
const { fail, requireBody, allowOnly, text, color, bool, finiteNumber, version, queryString, parseId, isObject, isSafeKey } = require("./common");
const { normalizeColumns, normalizeGroups, normalizeSavedViews, groupColumnOf, checkValue, hasValue, PRIMARY_KEY, LIMITS } = require("../domain/board-schema");

const POSITION = { min: -1e15, max: 1e15 };

// ---- Workspaces
const WORKSPACE_FIELDS = { name: (v) => text(v, "name", { required: true }), description: (v) => text(v, "description", { max: 5000 }), icon: (v) => text(v, "icon", { max: 4 }), color: (v) => color(v), archived: (v) => bool(v, "archived"), position: (v) => finiteNumber(v, "position", POSITION) };

function pickFields(body, rules) {
  const result = {};
  for (const [key, check] of Object.entries(rules)) if (body[key] !== undefined) result[key] = check(body[key]);
  return result;
}

function workspaceCreate(raw) {
  const body = requireBody(raw);
  allowOnly(body, ["name", "description", "icon", "color", "position"], "the workspace");
  const fields = pickFields(body, WORKSPACE_FIELDS);
  if (fields.name === undefined) fail("name is required.");
  return { description: "", icon: fields.name.slice(0, 1).toUpperCase(), color: "", ...fields };
}

function workspacePatch(raw) {
  const body = requireBody(raw);
  allowOnly(body, ["expectedVersion", ...Object.keys(WORKSPACE_FIELDS)], "the workspace update");
  const expectedVersion = version(body.expectedVersion);
  const set = pickFields(body, WORKSPACE_FIELDS);
  if (!Object.keys(set).length) fail("Send at least one field to change.");
  return { expectedVersion, set };
}

// ---- Boards
const BOARD_SIMPLE_FIELDS = { name: (v) => text(v, "name", { required: true }), description: (v) => text(v, "description", { max: 5000 }), icon: (v) => text(v, "icon", { max: 4 }), archived: (v) => bool(v, "archived"), position: (v) => finiteNumber(v, "position", POSITION), manualOrder: (v) => bool(v, "manualOrder") };

function boardCreate(raw, { actorId, now }) {
  const body = requireBody(raw);
  allowOnly(body, [...Object.keys(BOARD_SIMPLE_FIELDS), "columns", "groups", "savedViews"], "the board");
  const fields = pickFields(body, BOARD_SIMPLE_FIELDS);
  if (fields.name === undefined) fail("name is required.");
  const result = { description: "", icon: "D", archived: false, manualOrder: false, ...fields };
  if (body.columns !== undefined) result.columns = normalizeColumns(body.columns);
  if (body.groups !== undefined) result.groups = normalizeGroups(body.groups);
  if (body.savedViews !== undefined) result.savedViews = normalizeSavedViews(body.savedViews, { actorId, now });
  return result;
}

// Column changes through PATCH are limited to changes that never rewrite record values: add columns, rename labels,
// reorder, show/hide, width, required, default, options and connection. Removing a column or changing a column's
// type would change stored values, so those need a dedicated endpoint (later stage) and are rejected here.
function boardPatch(raw, board, { actorId, now }) {
  const body = requireBody(raw);
  allowOnly(body, ["expectedVersion", ...Object.keys(BOARD_SIMPLE_FIELDS), "columns", "groups", "savedViews"], "the board update");
  const expectedVersion = version(body.expectedVersion);
  const set = pickFields(body, BOARD_SIMPLE_FIELDS);
  let removedGroupIds = [];
  if (body.columns !== undefined) {
    const columns = normalizeColumns(body.columns);
    const next = new Map(columns.map((c) => [c.key, c]));
    for (const column of board.columns) {
      if (!next.has(column.key)) fail(`Column "${column.label || column.key}" can't be removed with a board update.`);
      if (next.get(column.key).type !== column.type) fail(`The type of column "${column.label || column.key}" can't be changed with a board update.`);
    }
    if (groupColumnOf(columns)?.key !== groupColumnOf(board.columns)?.key) fail("The board's group column can't be changed with a board update.");
    set.columns = columns;
  }
  if (body.groups !== undefined) {
    const groups = normalizeGroups(body.groups);
    const kept = new Set(groups.map((g) => g.id));
    removedGroupIds = board.groups.filter((g) => !kept.has(g.id)).map((g) => g.id);
    set.groups = groups;
  }
  if (body.savedViews !== undefined) set.savedViews = normalizeSavedViews(body.savedViews, { existing: board.savedViews, actorId, now });
  if (!Object.keys(set).length) fail("Send at least one field to change.");
  return { expectedVersion, set, removedGroupIds };
}

// ---- Records
// values: { <column key>: value }. Keys must be columns of this board; the board's group column is set through
// groupId instead. Each value is checked against its column type.
function recordValues(values, board, { creating }) {
  if (!isObject(values)) fail("values must be an object keyed by column key.");
  const entries = Object.entries(values);
  if (entries.length > LIMITS.recordFields) fail("values has too many fields.");
  const columns = new Map(board.columns.map((c) => [c.key, c]));
  const groupKey = groupColumnOf(board.columns)?.key;
  const clean = {};
  for (const [key, value] of entries) {
    if (!isSafeKey(key)) fail("values contains a field name that is not allowed.");
    const column = columns.get(key);
    if (!column) fail(`"${key.slice(0, 40)}" is not a column of this board.`);
    if (key === groupKey) fail(`Set the record's group with groupId, not values.${key}.`);
    checkValue(column, value);
    if (column.required && !hasValue(value)) fail(`${column.label || column.key} is required.`);
    clean[key] = value;
  }
  if (creating) {
    // Like the frontend: columns without a value start with their default (checkboxes start unticked).
    for (const column of board.columns) {
      if (column.key === groupKey || clean[column.key] !== undefined) continue;
      clean[column.key] = column.type === "checkbox" ? false : column.defaultValue ?? "";
      if (column.required && !hasValue(clean[column.key])) fail(`${column.label || column.key} is required.`);
    }
  }
  return clean;
}

function groupIdFor(value, board) {
  if (value === null) return null;
  if (typeof value !== "string" || !board.groups.some((g) => g.id === value)) fail("groupId must be one of this board's group IDs, or null.");
  return value;
}

function recordCreate(raw, board) {
  const body = requireBody(raw);
  allowOnly(body, ["values", "groupId", "position", "archived", "pinned"], "the record");
  if (body.values === undefined) fail(`values is required and must include ${PRIMARY_KEY}.`);
  return {
    values: recordValues(body.values, board, { creating: true }),
    groupId: body.groupId === undefined ? null : groupIdFor(body.groupId, board),
    position: body.position === undefined ? undefined : finiteNumber(body.position, "position", POSITION),
    archived: body.archived === undefined ? false : bool(body.archived, "archived"),
    pinned: body.pinned === undefined ? false : bool(body.pinned, "pinned")
  };
}

function recordPatch(raw, board) {
  const body = requireBody(raw);
  allowOnly(body, ["expectedVersion", "values", "groupId", "position", "archived", "pinned"], "the record update");
  const expectedVersion = version(body.expectedVersion);
  const change = {};
  if (body.values !== undefined) {
    change.values = recordValues(body.values, board, { creating: false });
    if (!Object.keys(change.values).length) delete change.values;
  }
  if (body.groupId !== undefined) change.groupId = groupIdFor(body.groupId, board);
  if (body.position !== undefined) change.position = finiteNumber(body.position, "position", POSITION);
  if (body.archived !== undefined) change.archived = bool(body.archived, "archived");
  if (body.pinned !== undefined) change.pinned = bool(body.pinned, "pinned");
  if (!Object.keys(change).length) fail("Send at least one field to change.");
  return { expectedVersion, change };
}

// ---- Record listing: limit, cursor, an allowlisted sort, and a few exact filters.
const RECORD_SORTS = Object.freeze({ position: "position", createdAt: "createdAt", updatedAt: "updatedAt" });
const PAGE = Object.freeze({ defaultLimit: 50, maxLimit: 200 });

function recordListQuery(query, board) {
  allowOnly(query, ["limit", "cursor", "sort", "dir", "groupId", "status", "archived"], "the query");
  const rawLimit = queryString(query.limit, "limit");
  let limit = PAGE.defaultLimit;
  if (rawLimit !== undefined) {
    if (!/^\d{1,6}$/.test(rawLimit) || Number(rawLimit) < 1) fail(`limit must be a whole number from 1 to ${PAGE.maxLimit}.`);
    limit = Number(rawLimit);
    if (limit > PAGE.maxLimit) fail(`limit can be at most ${PAGE.maxLimit}.`);
  }
  const sortName = queryString(query.sort, "sort") ?? "position";
  if (!Object.hasOwn(RECORD_SORTS, sortName)) fail(`sort must be one of: ${Object.keys(RECORD_SORTS).join(", ")}.`);
  const dir = queryString(query.dir, "dir") ?? "asc";
  if (!["asc", "desc"].includes(dir)) fail("dir must be asc or desc.");
  const filter = {};
  const groupId = queryString(query.groupId, "groupId");
  if (groupId !== undefined) filter.groupId = groupId === "none" ? null : groupIdFor(groupId, board);
  const status = queryString(query.status, "status");
  if (status !== undefined) {
    const statusColumn = board.columns.find((c) => c.type === "status");
    if (!statusColumn) fail("This board has no status column to filter by.");
    filter.status = { key: statusColumn.key, value: text(status, "status", { max: 200, trim: false }) };
  }
  const archived = queryString(query.archived, "archived");
  if (archived !== undefined) {
    if (!["true", "false"].includes(archived)) fail("archived must be true or false.");
    filter.archived = archived === "true";
  }
  const sort = { field: RECORD_SORTS[sortName], name: sortName, dir };
  const cursorText = queryString(query.cursor, "cursor");
  const after = cursorText === undefined ? null : decodeCursor(cursorText, sort);
  return { limit, sort, filter, after };
}

// Opaque cursor: base64url JSON of the last item's sort value and ID, bound to the sort it was made for.
function encodeCursor(sort, value, id) {
  return Buffer.from(JSON.stringify({ s: sort.name, d: sort.dir, v: value instanceof Date ? value.toISOString() : value, id: id.toHexString() })).toString("base64url");
}

function decodeCursor(textValue, sort) {
  const invalid = () => fail("cursor is not valid for this list. Start again from the first page.");
  if (textValue.length > 500 || !/^[A-Za-z0-9_-]+$/.test(textValue)) invalid();
  let data;
  try { data = JSON.parse(Buffer.from(textValue, "base64url").toString("utf8")); } catch { invalid(); }
  if (!isObject(data) || data.s !== sort.name || data.d !== sort.dir || typeof data.id !== "string") invalid();
  let id;
  try { id = parseId(data.id); } catch { invalid(); }
  let value;
  if (sort.field === "position") {
    if (typeof data.v !== "number" || !Number.isFinite(data.v)) invalid();
    value = data.v;
  } else {
    if (typeof data.v !== "string" || Number.isNaN(Date.parse(data.v))) invalid();
    value = new Date(data.v);
  }
  return { value, id };
}

module.exports = { workspaceCreate, workspacePatch, boardCreate, boardPatch, recordCreate, recordPatch, recordListQuery, encodeCursor, decodeCursor, RECORD_SORTS, PAGE };
