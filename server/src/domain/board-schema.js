// Board configuration rules shared by the resource API and the legacy migration: flexible columns, groups with
// stable IDs, saved views and record values. They mirror the current frontend (site/assets/BoardModel.js).
const crypto = require("crypto");
const { fail, isObject, isPrimitive, isSafeKey, text, color, bool, RECORD_ID_KEY } = require("../validation/common");
const { ApiError } = require("../middleware/errors");
const { cleanFilter, cleanOrderBy } = require("./record-filter");
const { checkTyped, TYPED_VALUE_TYPES } = require("../validation/record-values");
const { cleanSettings, settingsForType } = require("./column-types");

const COLUMN_TYPES = Object.freeze(["text", "number", "status", "dropdown", "checkbox", "priority", "owner", "date", "email", "phone", "link", "group", "files", "connect", "mirror"]);
// connect: cells hold linked record IDs (24 hex) of one other board, column.link = { boardId }; "multiple" allows several.
// mirror:  read-only; shows a column of the records linked through one of this board's connect columns, worked out when
//          read (services/related-service.js): column.mirror = { via: connect column key, column: source column key, show }.
//          Nothing is stored in its cells. A mirror of a connect or mirror column is refused when read (no chains).
const MIRROR_SHOWS = Object.freeze(["list", "count", "sum", "avg", "min", "max", "earliest", "latest"]);
const RECORD_REF = /^[0-9a-f]{24}$/;
const PRIMARY_KEY = "serial"; // the required Item column; its key never changes (label may)
// settings (G3 / D12): optional DISPLAY configuration (number, date, text and link formats), validated per type by the shared
// registry (site/assets/ColumnTypes.js cleanSettings). It never changes a stored value. Accepted on an INCOMING column only:
// it is stored apart, in the board's top-level `columnSettings` (see columnSettingsFor below), never inside `columns`, so a
// release without settings (which refuses unknown column fields and re-checks the stored columns when it adds a column or
// changes a type) keeps working after a rollback. normalizeColumn validates it but never returns it.
const COLUMN_FIELDS = ["key", "label", "type", "required", "visible", "defaultValue", "options", "width", "connection", "colors", "multiple", "description", "link", "mirror", "settings"];
// Columns whose cells may hold several values (stored as a list of strings): People always (several assignees), and a
// Dropdown set to "multiple". People entries are "user:<user ID>" for signed-in employees, or (older data) plain text.
const MAX_MULTI_VALUES = 100;
const USER_REF = /^user:[0-9a-f]{24}$/;
const isMultiColumn = (column) => column.type === "owner" || column.type === "connect" || (column.type === "dropdown" && column.multiple === true);
const LIMITS = Object.freeze({ columns: 200, options: 200, optionLength: 200, groups: 200, savedViews: 50, valueLength: 10000, legacyValueLength: 100000, recordFields: 300 });
const GROUP_ID = /^grp_[A-Za-z0-9]{6,40}$/;
const VIEW_ID = /^view_[A-Za-z0-9]{6,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The frontend's default columns, used for legacy boards saved before boards had their own column list.
const LEGACY_DEFAULT_COLUMNS = Object.freeze([
  { key: "serial", label: "Record / Serial", type: "text" }, { key: "group", label: "Group", type: "group" },
  { key: "owner", label: "Owner", type: "owner" }, { key: "received", label: "Date received", type: "date" },
  { key: "invoice", label: "RR / Invoice", type: "text" }, { key: "invoiceDate", label: "Invoice date", type: "date" },
  { key: "dueDate", label: "Due date", type: "date" }, { key: "status", label: "Status", type: "status" },
  { key: "priority", label: "Priority", type: "priority" }, { key: "notes", label: "Updates / Notes", type: "text" }
]);
const LEGACY_DEFAULT_GROUPS = Object.freeze(["New", "Working", "Done"]);
const BLANK_BOARD_COLUMNS = Object.freeze([{ key: PRIMARY_KEY, label: "Item", type: "text", required: true }]);

const randomId = (prefix) => `${prefix}${crypto.randomBytes(8).toString("base64url").replace(/[^A-Za-z0-9]/g, "").padEnd(10, "0").slice(0, 10)}`;
const newGroupId = () => randomId("grp_");
const newViewId = () => randomId("view_");

// Validates one column and returns it with only the known fields and their defaults.
function normalizeColumn(column, where = "a column") {
  if (!isObject(column)) fail(`${where} is not a column.`);
  for (const key of Object.keys(column)) if (!COLUMN_FIELDS.includes(key)) fail(`${where} has an unknown setting "${key.slice(0, 40)}".`);
  if (!isSafeKey(column.key)) fail(`${where} needs a key made of letters, digits, "_" or "-".`);
  if (column.key === RECORD_ID_KEY) fail(`${where} can't use the key "${RECORD_ID_KEY}": it is the system Record ID.`);
  const label = text(column.label ?? "", `The label of column "${column.key}"`, { max: 200 });
  if (!COLUMN_TYPES.includes(column.type)) fail(`Column "${column.key}" has an unsupported type.`);
  const result = {
    key: column.key, label, type: column.type,
    required: column.required === undefined ? column.key === PRIMARY_KEY : bool(column.required, `required on column "${column.key}"`),
    visible: column.visible === undefined ? true : bool(column.visible, `visible on column "${column.key}"`),
    defaultValue: column.defaultValue === undefined || column.defaultValue === null ? "" : column.defaultValue,
    options: column.options === undefined ? [] : column.options,
    connection: column.connection === undefined || column.connection === null ? "" : text(column.connection, `connection on column "${column.key}"`, { max: 500 })
  };
  if (!isPrimitive(result.defaultValue)) fail(`Column "${column.key}" has an invalid default value.`);
  if (typeof result.defaultValue === "string" && result.defaultValue.length > LIMITS.valueLength) fail(`Column "${column.key}" has a default value that is too long.`);
  // Link / Email / Phone defaults follow the same rules as new values (S0-A, validation/record-values.js).
  if (TYPED_VALUE_TYPES.has(result.type) && result.defaultValue) { const r = checkTyped(result.type, result.defaultValue); if (r.reason) fail(`The default for "${column.key}" ${r.message}.`); }
  if (!Array.isArray(result.options) || result.options.length > LIMITS.options || !result.options.every((o) => typeof o === "string" && o.length <= LIMITS.optionLength)) fail(`Column "${column.key}" has invalid options.`);
  result.options = [...result.options];
  // Label colours, in the same order as options ("" = the app's automatic colour). Only for option columns.
  if (column.colors !== undefined && column.colors !== null) {
    if (!OPTION_TYPES.includes(result.type) || !Array.isArray(column.colors) || column.colors.length > LIMITS.options) fail(`Column "${column.key}" has invalid label colours.`);
    result.colors = column.colors.map((value) => color(value, `A label colour of column "${column.key}"`));
  }
  // Optional guidance shown from the column header (plain text).
  if (column.description !== undefined && column.description !== null && column.description !== "") {
    const description = text(column.description, `The description of column "${column.key}"`, { max: 500 });
    if (description) result.description = description;
  }
  if (column.multiple !== undefined && column.multiple !== null) {
    const multiple = bool(column.multiple, `multiple on column "${column.key}"`);
    if (multiple && result.type !== "dropdown" && result.type !== "connect") fail(`Only Dropdown and Connect columns can allow several values ("${column.key}").`);
    if (multiple) result.multiple = true;
  }
  if (column.width !== undefined && column.width !== null) {
    if (typeof column.width !== "number" || !Number.isFinite(column.width) || column.width < 0 || column.width > 5000) fail(`Column "${column.key}" has an invalid width.`);
    result.width = column.width;
  }
  // Connect: the board it links to (who may link to it is checked by the routes, which know the person).
  if (column.link !== undefined && column.link !== null) {
    if (result.type !== "connect") fail(`Only Connect columns link to another board ("${column.key}").`);
    if (!isObject(column.link) || Object.keys(column.link).some((k) => k !== "boardId") || typeof column.link.boardId !== "string" || !RECORD_REF.test(column.link.boardId)) fail(`Column "${column.key}" needs the ID of the board it links to.`);
    result.link = { boardId: column.link.boardId };
  } else if (result.type === "connect") fail(`Connect column "${column.key}" needs the board it links to.`);
  // Mirror: which connect column it follows, which column of the linked records it shows, and how.
  if (column.mirror !== undefined && column.mirror !== null) {
    const m = column.mirror;
    if (result.type !== "mirror") fail(`Only Mirror columns mirror another board ("${column.key}").`);
    if (!isObject(m) || Object.keys(m).some((k) => !["via", "column", "show"].includes(k)) || !isSafeKey(m.via) || !isSafeKey(m.column) || !MIRROR_SHOWS.includes(m.show ?? "list")) fail(`Mirror column "${column.key}" needs a Connect column, a column to show and how to show it (${MIRROR_SHOWS.join(", ")}).`);
    result.mirror = { via: m.via, column: m.column, show: m.show ?? "list" };
  } else if (result.type === "mirror") fail(`Mirror column "${column.key}" needs a Connect column and a column to show.`);
  if ((result.type === "connect" || result.type === "mirror") && (result.required || hasValue(result.defaultValue))) fail(`Column "${column.key}" can't be required or have a default value.`);
  // Display settings: checked here (same messages), stored apart (columnSettingsFor); never part of the stored column.
  incomingSettings(column, result.type);
  return result;
}

// ---- Column display settings storage (G3 / D12): board.columnSettings = { <column key>: <settings> }, absent when empty.
// A release older than G3 never reads, checks or writes this field: its $set updates of named fields leave it as it is, so
// after a rollback the settings stay dormant and show again on the next G3 release. Entries are always read through
// settingsForType(<the column's current type>): one for a column that no longer exists, or that a rollback release changed
// to another type, is ignored.
// An incoming column's settings: undefined = not sent (keep the stored ones), null = none (cleared, or only defaults),
// otherwise the canonical object. Bad shapes are refused with the messages they always had.
function incomingSettings(column, type) {
  if (!isObject(column) || column.settings === undefined) return undefined;
  if (column.settings === null) return null;
  const checked = cleanSettings(type, column.settings);
  if (!checked.ok) fail(`The display settings of column "${column.key}" ${checked.message}.`);
  return checked.settings;
}
// The stored settings of one column that apply to its current type (null = none).
function storedSettings(board, column) {
  const all = board?.columnSettings;
  return column && isObject(all) && Object.hasOwn(all, column.key) ? settingsForType(column.type, all[column.key]) : null;
}
// The board's next columnSettings (null = none: the field is removed) for a new column list.
//   raw      the incoming columns, in the order normalizeColumns returned `columns` (null: nothing sent)
//   columns  the validated columns that will be stored
//   board    the stored board (its columns and columnSettings), or null for a new board
// A column sent WITHOUT `settings` keeps the stored ones when its type is unchanged (a page that doesn't know the field, an
// older tab or a script, never erases them); entries of columns no longer on the board are dropped.
function columnSettingsFor(raw, columns, board = null) {
  const before = new Map((board?.columns || []).map((c) => [c.key, c]));
  const out = {};
  columns.forEach((column, i) => {
    const sent = raw ? incomingSettings(raw[i], column.type) : undefined;
    const old = before.get(column.key);
    const next = sent !== undefined ? sent : old && old.type === column.type ? storedSettings(board, old) : null;
    if (next) out[column.key] = next;
  });
  return Object.keys(out).length ? out : null;
}
// The board's columnSettings after one column's entry is set (an object) or removed (null): `columns` is the board's
// column list after the change; entries of other columns that no longer apply are dropped.
function withColumnSettings(board, columns, key, settings) {
  const out = {};
  for (const column of columns) {
    const s = column.key === key ? settings : storedSettings(board, column);
    if (s) out[column.key] = s;
  }
  return Object.keys(out).length ? out : null;
}
// Read side (session API): the columns with their settings, the shape G3 browsers expect (`columns[].settings`).
function columnsWithSettings(board) {
  return (board.columns || []).map((c) => { const s = storedSettings(board, c); return s ? { ...c, settings: s } : c; });
}

// Each mirror follows a Connect column of the same board.
function checkMirrors(columns) {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  for (const c of columns) if (c.type === "mirror" && byKey.get(c.mirror.via)?.type !== "connect") fail(`Mirror column "${c.key}" must follow a Connect column of this board.`);
}

function normalizeColumns(columns) {
  if (!Array.isArray(columns) || !columns.length) fail("columns must be a non-empty list.");
  if (columns.length > LIMITS.columns) fail(`A board can have at most ${LIMITS.columns} columns.`);
  const keys = new Set();
  const result = columns.map((column, index) => {
    const clean = normalizeColumn(column, `Column ${index + 1}`);
    if (keys.has(clean.key)) fail(`Column key "${clean.key}" is used twice.`);
    keys.add(clean.key);
    return clean;
  });
  const primary = result.find((c) => c.key === PRIMARY_KEY);
  if (!primary) fail(`The board needs its primary "${PRIMARY_KEY}" (Item) column.`);
  if (primary.type !== "text") fail("The primary Item column must be a text column.");
  checkMirrors(result);
  return result;
}

// The column whose value is the record's group. Records store it as groupId (a stable group ID), not in values.
const groupColumnOf = (columns) => columns.find((c) => c.type === "group") || null;

// Groups: [{ id, name, color, archived, position }] in display order. Missing IDs are assigned; names must be unique.
function normalizeGroups(groups) {
  if (!Array.isArray(groups)) fail("groups must be a list.");
  if (groups.length > LIMITS.groups) fail(`A board can have at most ${LIMITS.groups} groups.`);
  const ids = new Set(), names = new Set();
  return groups.map((group, index) => {
    if (!isObject(group)) fail(`Group ${index + 1} must be an object with a name.`);
    for (const key of Object.keys(group)) if (!["id", "name", "color", "archived"].includes(key)) fail(`Group ${index + 1} has an unknown field "${key.slice(0, 40)}".`);
    const id = group.id === undefined ? newGroupId() : group.id;
    if (typeof id !== "string" || !GROUP_ID.test(id)) fail(`Group ${index + 1} has an invalid ID.`);
    const name = text(group.name, `The name of group ${index + 1}`, { max: 200, required: true });
    if (ids.has(id)) fail(`Group ID "${id}" is used twice.`);
    if (names.has(name)) fail(`Group name "${name.slice(0, 60)}" is used twice.`);
    ids.add(id); names.add(name);
    if (group.archived !== undefined && typeof group.archived !== "boolean") fail(`Group "${name.slice(0, 60)}": archived must be true or false.`);
    return { id, name, color: group.color === undefined ? "" : color(group.color, `The colour of group "${name.slice(0, 60)}"`), archived: Boolean(group.archived), position: (index + 1) * 1000 };
  });
}

// Saved views on the board: [{ id, legacyId?, name, state, createdBy, createdAt }] — SHARED views only, seen by everyone
// who can see the board. Personal views are stored apart (repositories/mongo/personal-view-repository.js), so nothing that
// serves a board document can show them to anyone else. state holds the view's filters and layout. A view's ID never
// changes, and deleting a view never touches records.
//   canEditShared  false for a workspace Viewer: the shared views must stay exactly as stored (403 otherwise)
const sameId = (a, b) => Boolean(a && b) && String(a) === String(b);
function normalizeSavedViews(views, { existing = [], actorId, now, canEditShared = true }) {
  if (!Array.isArray(views)) fail("savedViews must be a list.");
  if (views.length > LIMITS.savedViews) fail(`A board can have at most ${LIMITS.savedViews} saved views.`);
  const kept = existing.filter((v) => v.personal !== true); // never a personal view in a board document
  const previous = new Map(kept.map((view) => [view.id, view]));
  const ids = new Set();
  const clean = views.map((view, index) => {
    if (!isObject(view)) fail(`Saved view ${index + 1} must be an object.`);
    for (const key of Object.keys(view)) if (!["id", "name", "state", "personal"].includes(key)) fail(`Saved view ${index + 1} has an unknown field "${key.slice(0, 40)}".`);
    if (view.personal === true) fail(`Saved view ${index + 1} is personal: personal views are kept apart from the board.`);
    if (view.personal !== undefined && view.personal !== false) fail(`Saved view ${index + 1}: personal must be true or false.`);
    const id = view.id === undefined || view.id === null ? newViewId() : view.id;
    if (typeof id !== "string" || !VIEW_ID.test(id) || ids.has(id)) fail(`Saved view ${index + 1} has an invalid or duplicate ID.`);
    ids.add(id);
    const before = previous.get(id);
    const out = { id, name: text(view.name, `The name of saved view ${index + 1}`, { max: 200, required: true }), state: viewState(view.state ?? {}, index), createdBy: before ? before.createdBy : actorId, createdAt: before ? before.createdAt : now };
    if (before?.legacyId !== undefined) out.legacyId = before.legacyId;
    return out;
  });
  if (!canEditShared && !sameSharedViews(clean, kept)) throw new ApiError(403, "FORBIDDEN", "Viewers can keep personal views, but only editors can change the board's shared views.");
  return clean;
}
const sameSharedViews = (a, b) => JSON.stringify(a.map((v) => [v.id, v.name, v.state])) === JSON.stringify(b.filter((v) => v.personal !== true).map((v) => [v.id, v.name, v.state]));

// A board update's savedViews, as one person sees them (their order, shared and personal mixed), split into
//   shared    for the board document (then normalizeSavedViews)        personal  this person's personal views (clean)
//   order     every view ID in their order                                sharedChanged  whether the board must be written
// mine: their stored personal views of this board (or null). A view keeps being personal unless the page says otherwise
// (older pages don't send "personal"). Only its creator can make a shared view personal (it would vanish for everyone
// else); a Viewer can't share one (that changes the shared views). allowPersonal: the feature switch, for new ones.
function splitSavedViews(views, { board, mine = null, actorId, now, canEditShared = true, allowPersonal = true }) {
  if (!Array.isArray(views)) fail("savedViews must be a list.");
  if (views.length > LIMITS.savedViews) fail(`A board can have at most ${LIMITS.savedViews} saved views.`);
  const minePrev = new Map((mine?.views || []).map((v) => [v.id, v])), sharedPrev = new Map(board.savedViews.filter((v) => v.personal !== true).map((v) => [v.id, v]));
  const shared = [], personal = [], order = [], ids = new Set();
  views.forEach((view, index) => {
    if (!isObject(view)) fail(`Saved view ${index + 1} must be an object.`);
    if (view.personal !== undefined && typeof view.personal !== "boolean") fail(`Saved view ${index + 1}: personal must be true or false.`);
    const id = view.id === undefined || view.id === null ? newViewId() : view.id;
    if (typeof id !== "string" || !VIEW_ID.test(id) || ids.has(id)) fail(`Saved view ${index + 1} has an invalid or duplicate ID.`);
    ids.add(id); order.push(id);
    const wasMine = minePrev.get(id), wasShared = sharedPrev.get(id), isPersonal = view.personal === undefined ? Boolean(wasMine) : view.personal;
    for (const key of Object.keys(view)) if (!["id", "name", "state", "personal"].includes(key)) fail(`Saved view ${index + 1} has an unknown field "${key.slice(0, 40)}".`);
    if (!isPersonal) { shared.push({ id, name: view.name, state: view.state }); return; }
    if (!wasMine && !allowPersonal) fail("Personal views aren't switched on yet.");
    if (wasShared && !sameId(wasShared.createdBy, actorId)) fail(`Saved view "${String(wasShared.name).slice(0, 60)}" was created by someone else, so it can't be made personal. Duplicate it instead.`);
    const before = wasMine || wasShared;
    personal.push({ id, name: text(view.name, `The name of saved view ${index + 1}`, { max: 200, required: true }), state: viewState(view.state ?? {}, index), createdAt: before?.createdAt ?? now, ...(before?.legacyId !== undefined ? { legacyId: before.legacyId } : {}) });
  });
  const cleanShared = normalizeSavedViews(shared, { existing: board.savedViews, actorId, now, canEditShared });
  return { shared: cleanShared, personal, order, sharedChanged: !sameSharedViews(cleanShared, board.savedViews) };
}

// A view's state: primitives, lists of column keys, or a { columnKey: width } map. Nothing deeper.
function viewState(state, index) {
  if (!isObject(state)) fail(`Saved view ${index + 1} has an invalid state.`);
  const entries = Object.entries(state);
  if (entries.length > 50) fail(`Saved view ${index + 1} has too many settings.`);
  const clean = {};
  for (const [key, value] of entries) {
    if (!isSafeKey(key)) fail(`Saved view ${index + 1} has an invalid setting name.`);
    if (key === "filter" && value !== null) { clean.filter = cleanFilter(value); continue; }
    if (key === "orderBy" && value !== null) { clean.orderBy = cleanOrderBy(value); continue; }
    if (isPrimitive(value)) { if (typeof value === "string" && value.length > 1000) fail(`Saved view ${index + 1} has a setting that is too long.`); clean[key] = value; }
    else if (Array.isArray(value) && value.length <= LIMITS.columns && value.every(isSafeKey)) clean[key] = [...value];
    else if (isObject(value) && Object.keys(value).length <= LIMITS.columns && Object.entries(value).every(([k, v]) => isSafeKey(k) && (v === null || (typeof v === "number" && Number.isFinite(v))))) clean[key] = { ...value };
    else fail(`Saved view ${index + 1} has an unsupported setting "${key.slice(0, 40)}".`);
  }
  return clean;
}

// Checks one record value against its column type. Numbers may be sent as numbers or as numeric text (the frontend
// keeps numbers as text today); values are stored exactly as sent.
function checkValue(column, value, { maxLength = LIMITS.valueLength } = {}) {
  const where = `The value for "${column.label || column.key}"`;
  if (value === null) return;
  // Mirror cells are worked out from the linked board when read; nothing can be written to them.
  if (column.type === "mirror") { if (value !== "" && !(Array.isArray(value) && !value.length)) fail(`${where} comes from another board and can't be edited.`); return; }
  // Connect cells: the IDs of linked records (each once; one only unless the column allows several). Whether they exist on
  // the linked board, and whether the person may see it, is checked by the routes (services/related-service.js).
  if (column.type === "connect") {
    if (value === "") return;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !RECORD_REF.test(v))) fail(`${where} must be a list of record IDs.`);
    if (new Set(value).size !== value.length) fail(`${where} links the same record twice.`);
    if (value.length > (column.multiple ? MAX_MULTI_VALUES : 1)) fail(column.multiple ? `${where} has too many linked records.` : `${where} can link only one record.`);
    return;
  }
  if (Array.isArray(value)) {
    if (!isMultiColumn(column)) fail(`${where} must be a single value.`);
    if (value.length > MAX_MULTI_VALUES) fail(`${where} has too many entries.`);
    const seen = new Set();
    for (const item of value) {
      if (typeof item !== "string" || !item.trim() || item.length > LIMITS.optionLength) fail(`${where} must be a list of names.`);
      if (item.startsWith("user:") && !USER_REF.test(item)) fail(`${where} refers to a person in an invalid way.`);
      if (seen.has(item)) fail(`${where} lists the same entry twice.`);
      seen.add(item);
    }
    return;
  }
  // Files columns hold nothing in the record: attachments are their own documents (see services/file-service.js).
  if (column.type === "files") { if (value !== "") fail(`${where} can only be changed by uploading or removing files.`); return; }
  if (!isPrimitive(value)) fail(`${where} must be text, a number, true/false or null.`);
  if (typeof value === "string" && value.length > maxLength) fail(`${where} is too long.`);
  if (column.type === "checkbox") { if (typeof value !== "boolean") fail(`${where} must be true or false.`); return; }
  if (typeof value === "boolean") fail(`${where} must not be true/false.`);
  if (column.type === "number") { if (typeof value === "string" && value.trim() !== "" && !Number.isFinite(Number(value))) fail(`${where} must be a number.`); return; }
  if (column.type === "date") {
    if (typeof value !== "string") fail(`${where} must be a date in YYYY-MM-DD form.`);
    if (value !== "" && (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) fail(`${where} must be a real date in YYYY-MM-DD form.`);
    return;
  }
  if (typeof value !== "string") fail(`${where} must be text.`);
}

const hasValue = (value) => Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== false && String(value).trim() !== "";
// The entries of a cell as a list (a single value becomes a one-item list; empty → []).
const valueList = (value) => Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.trim()) : hasValue(value) && typeof value !== "boolean" ? [String(value)] : [];
// Same value? (lists compare item by item).
const sameValue = (a, b) => Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a ?? null) === JSON.stringify(b ?? null) : a === b;

// ---- Schema-change rules (Stage 11). Exact ports of the frontend's BoardModel rules, so a change made through the
// API rewrites stored values the same way the browser does.
const OPTION_TYPES = Object.freeze(["status", "dropdown", "priority"]);
const FALLBACK_OPTIONS = Object.freeze({ status: ["New", "In Progress", "Waiting", "Completed", "Cancelled", "Review", "Defective", "Clear"], priority: ["Low", "Medium", "High", "Critical"] });

// The options a column offers: its own list, or the app's built-in list for status/priority columns without one.
function effectiveOptions(column) {
  if (column.options?.length) return [...column.options];
  return [...(FALLBACK_OPTIONS[column.type] || [])];
}

// Can an existing value be kept when a column becomes `type`? Empty values always fit (BoardModel.valueFits).
// valueFits / convertValue are kept as the browser-parity reference (tests/columns-model.test.js). Since S0-A the server's
// type change uses the strict, lossless-only rules of domain/column-conversion.js instead (link / email / phone included).
function valueFits(value, type) {
  if (!hasValue(value)) return true;
  if (Array.isArray(value)) return !["number", "date", "checkbox"].includes(type) || (value.length === 1 && valueFits(value[0], type));
  const text = String(value).trim();
  if (type === "number") return Number.isFinite(Number(text));
  if (type === "date") return DATE.test(text) && !Number.isNaN(new Date(`${text}T00:00:00`).getTime());
  if (type === "checkbox") return value === true || ["true", "yes", "1"].includes(text.toLowerCase());
  return typeof value !== "boolean";
}

// The value a record keeps after its column changes to `type` (BoardModel.changeColumnType). multiple: the new
// column allows several values. names: display names for "user:<id>" entries when they become plain text.
function convertValue(value, type, { multiple = false, names = new Map() } = {}) {
  const toMulti = type === "owner" || (type === "dropdown" && multiple);
  if (Array.isArray(value) || toMulti) {
    const list = valueList(value);
    if (toMulti) return list;
    if (!list.length) return type === "checkbox" ? false : "";
    const plain = list.map((item) => names.get(item) ?? (USER_REF.test(item) ? "Unknown user" : item));
    if (["number", "date", "checkbox"].includes(type)) return convertValue(plain.length === 1 ? plain[0] : "", type);
    return ["status", "priority", "dropdown"].includes(type) ? plain[0] : plain.join(", ");
  }
  const fits = valueFits(value, type);
  if (type === "checkbox") return fits && hasValue(value);
  return !fits || typeof value === "boolean" ? "" : value;
}

// Option edit plan (BoardModel.optionsEditPlan): items are [{ from: existing option or null, to: new text, color? }]
// in the new order; options left out are removed. Uses Maps, so option text can never act as an object key.
// Multi-value cells keep their other entries; a removed option just drops out of the list.
function optionsPlan(column, items) {
  const previous = effectiveOptions(column);
  const kept = items.filter((item) => String(item.to || "").trim());
  const removed = new Set(previous.filter((option) => !kept.some((item) => item.from === option)));
  const renames = new Map(kept.filter((item) => item.from && item.from !== item.to.trim()).map((item) => [item.from, item.to.trim()]));
  const options = [], colors = [];
  for (const item of kept) {
    const name = item.to.trim();
    if (options.includes(name)) continue;
    options.push(name);
    const before = item.from === null ? -1 : previous.indexOf(item.from);
    colors.push(item.color !== undefined ? item.color : before >= 0 ? (column.colors?.[before] ?? "") : "");
  }
  const mapOne = (value) => (renames.has(value) ? renames.get(value) : removed.has(value) ? "" : value);
  const mapValue = (value) => Array.isArray(value) ? [...new Set(value.map(mapOne).filter(Boolean))] : mapOne(value);
  return { options, colors: colors.some(Boolean) ? colors : null, removed, renames, mapValue };
}

module.exports = {
  COLUMN_TYPES, MIRROR_SHOWS, RECORD_REF, PRIMARY_KEY, LIMITS, GROUP_ID, VIEW_ID, LEGACY_DEFAULT_COLUMNS, LEGACY_DEFAULT_GROUPS, BLANK_BOARD_COLUMNS, OPTION_TYPES, USER_REF,
  newGroupId, newViewId, normalizeColumn, normalizeColumns, normalizeGroups, normalizeSavedViews, splitSavedViews, viewState, groupColumnOf, checkValue, hasValue,
  valueList, sameValue, isMultiColumn, effectiveOptions, valueFits, convertValue, optionsPlan, settingsForType,
  incomingSettings, storedSettings, columnSettingsFor, withColumnSettings, columnsWithSettings
};
