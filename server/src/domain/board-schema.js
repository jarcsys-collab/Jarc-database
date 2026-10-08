// Board configuration rules shared by the resource API and the legacy migration: flexible columns, groups with
// stable IDs, saved views and record values. They mirror the current frontend (site/assets/BoardModel.js).
const crypto = require("crypto");
const { fail, isObject, isPrimitive, isSafeKey, text, color, bool } = require("../validation/common");

const COLUMN_TYPES = Object.freeze(["text", "number", "status", "dropdown", "checkbox", "priority", "owner", "date", "email", "phone", "link", "group"]);
const PRIMARY_KEY = "serial"; // the required Item column; its key never changes (label may)
const COLUMN_FIELDS = ["key", "label", "type", "required", "visible", "defaultValue", "options", "width", "connection"];
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
  if (!Array.isArray(result.options) || result.options.length > LIMITS.options || !result.options.every((o) => typeof o === "string" && o.length <= LIMITS.optionLength)) fail(`Column "${column.key}" has invalid options.`);
  result.options = [...result.options];
  if (column.width !== undefined && column.width !== null) {
    if (typeof column.width !== "number" || !Number.isFinite(column.width) || column.width < 0 || column.width > 5000) fail(`Column "${column.key}" has an invalid width.`);
    result.width = column.width;
  }
  return result;
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
  return result;
}

// The column whose value is the record's group. Records store it as groupId (a stable group ID), not in values.
const groupColumnOf = (columns) => columns.find((c) => c.type === "group") || null;

// Groups: [{ id, name, color, position }] in display order. Missing IDs are assigned; names must be unique.
function normalizeGroups(groups) {
  if (!Array.isArray(groups)) fail("groups must be a list.");
  if (groups.length > LIMITS.groups) fail(`A board can have at most ${LIMITS.groups} groups.`);
  const ids = new Set(), names = new Set();
  return groups.map((group, index) => {
    if (!isObject(group)) fail(`Group ${index + 1} must be an object with a name.`);
    for (const key of Object.keys(group)) if (!["id", "name", "color"].includes(key)) fail(`Group ${index + 1} has an unknown field "${key.slice(0, 40)}".`);
    const id = group.id === undefined ? newGroupId() : group.id;
    if (typeof id !== "string" || !GROUP_ID.test(id)) fail(`Group ${index + 1} has an invalid ID.`);
    const name = text(group.name, `The name of group ${index + 1}`, { max: 200, required: true });
    if (ids.has(id)) fail(`Group ID "${id}" is used twice.`);
    if (names.has(name)) fail(`Group name "${name.slice(0, 60)}" is used twice.`);
    ids.add(id); names.add(name);
    return { id, name, color: group.color === undefined ? "" : color(group.color, `The colour of group "${name.slice(0, 60)}"`), position: (index + 1) * 1000 };
  });
}

// Saved views: [{ id, legacyId?, name, state, createdBy, createdAt }]. state holds the view's filters and layout.
function normalizeSavedViews(views, { existing = [], actorId, now }) {
  if (!Array.isArray(views)) fail("savedViews must be a list.");
  if (views.length > LIMITS.savedViews) fail(`A board can have at most ${LIMITS.savedViews} saved views.`);
  const previous = new Map(existing.map((view) => [view.id, view]));
  const ids = new Set();
  return views.map((view, index) => {
    if (!isObject(view)) fail(`Saved view ${index + 1} must be an object.`);
    for (const key of Object.keys(view)) if (!["id", "name", "state"].includes(key)) fail(`Saved view ${index + 1} has an unknown field "${key.slice(0, 40)}".`);
    const id = view.id === undefined ? newViewId() : view.id;
    if (typeof id !== "string" || !VIEW_ID.test(id) || ids.has(id)) fail(`Saved view ${index + 1} has an invalid or duplicate ID.`);
    ids.add(id);
    const before = previous.get(id);
    const clean = { id, name: text(view.name, `The name of saved view ${index + 1}`, { max: 200, required: true }), state: viewState(view.state ?? {}, index), createdBy: before ? before.createdBy : actorId, createdAt: before ? before.createdAt : now };
    if (before?.legacyId !== undefined) clean.legacyId = before.legacyId;
    return clean;
  });
}

// A view's state: primitives, lists of column keys, or a { columnKey: width } map. Nothing deeper.
function viewState(state, index) {
  if (!isObject(state)) fail(`Saved view ${index + 1} has an invalid state.`);
  const entries = Object.entries(state);
  if (entries.length > 50) fail(`Saved view ${index + 1} has too many settings.`);
  const clean = {};
  for (const [key, value] of entries) {
    if (!isSafeKey(key)) fail(`Saved view ${index + 1} has an invalid setting name.`);
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

const hasValue = (value) => value !== undefined && value !== null && value !== false && String(value).trim() !== "";

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
function valueFits(value, type) {
  if (!hasValue(value)) return true;
  const text = String(value).trim();
  if (type === "number") return Number.isFinite(Number(text));
  if (type === "date") return DATE.test(text) && !Number.isNaN(new Date(`${text}T00:00:00`).getTime());
  if (type === "checkbox") return value === true || ["true", "yes", "1"].includes(text.toLowerCase());
  return typeof value !== "boolean";
}

// The value a record keeps after its column changes to `type` (BoardModel.changeColumnType).
function convertValue(value, type) {
  const fits = valueFits(value, type);
  if (type === "checkbox") return fits && hasValue(value);
  return !fits || typeof value === "boolean" ? "" : value;
}

// Option edit plan (BoardModel.optionsEditPlan): items are [{ from: existing option or null, to: new text }];
// options left out are removed. Uses Maps, so option text can never act as an object key.
function optionsPlan(column, items) {
  const previous = effectiveOptions(column);
  const kept = items.filter((item) => String(item.to || "").trim());
  const removed = new Set(previous.filter((option) => !kept.some((item) => item.from === option)));
  const renames = new Map(kept.filter((item) => item.from && item.from !== item.to.trim()).map((item) => [item.from, item.to.trim()]));
  const options = [...new Set(kept.map((item) => item.to.trim()))];
  const mapValue = (value) => (renames.has(value) ? renames.get(value) : removed.has(value) ? "" : value);
  return { options, removed, renames, mapValue };
}

module.exports = {
  COLUMN_TYPES, PRIMARY_KEY, LIMITS, GROUP_ID, VIEW_ID, LEGACY_DEFAULT_COLUMNS, LEGACY_DEFAULT_GROUPS, BLANK_BOARD_COLUMNS, OPTION_TYPES,
  newGroupId, newViewId, normalizeColumn, normalizeColumns, normalizeGroups, normalizeSavedViews, viewState, groupColumnOf, checkValue, hasValue,
  effectiveOptions, valueFits, convertValue, optionsPlan
};
