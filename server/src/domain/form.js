// A form: a chosen set of a board's columns that employees fill in to create or update a record of that board.
// Internal only: every form needs a signed-in JARC session and the usual role in the board's workspace. There is no public
// form, and nothing in a form's definition can make one.
//
//   { name, description, status: draft | published, mode: create | update, confirmation, groupId, uniqueKey,
//     fields: [{ key, label, help, required, defaultValue, hidden, showWhen: { key, cmp: is | isNot | hasValue, values } }] }
//
// A field's showWhen makes it apply only when another field has (or doesn't have) a value: a field that doesn't apply is
// neither required nor accepted. A hidden field only ever supplies its default. Values are still checked against the
// column's type by the record service, exactly as for any other change.
const { fail, requireBody, allowOnly, text, isObject, isSafeKey } = require("../validation/common");
const { PRIMARY_KEY, isMultiColumn, effectiveOptions, checkValue } = require("./board-schema");

const MAX = Object.freeze({ fields: 100, name: 200, description: 2000, label: 200, help: 500, confirmation: 500, values: 50, value: 200 });
const UPLOAD_TYPES = new Set(["files"]);

function cleanField(raw, index, byKey, keys) {
  if (!isObject(raw)) fail(`Field ${index + 1} must be an object.`);
  allowOnly(raw, ["key", "label", "help", "required", "defaultValue", "hidden", "showWhen"], `field ${index + 1}`);
  const column = isSafeKey(raw.key) ? byKey.get(raw.key) : null;
  if (!column || column.type === "group") fail(`Field ${index + 1} names a column this board doesn't have.`);
  const field = { key: raw.key };
  if (raw.label !== undefined && raw.label !== "") field.label = text(raw.label, `The label of field ${index + 1}`, { max: MAX.label });
  if (raw.help !== undefined && raw.help !== "") field.help = text(raw.help, `The help of field ${index + 1}`, { max: MAX.help });
  if (raw.required !== undefined) { if (typeof raw.required !== "boolean") fail(`required on field ${index + 1} must be true or false.`); field.required = raw.required; }
  if (raw.hidden !== undefined) { if (typeof raw.hidden !== "boolean") fail(`hidden on field ${index + 1} must be true or false.`); field.hidden = raw.hidden; }
  if (raw.defaultValue !== undefined && raw.defaultValue !== null && raw.defaultValue !== "") { if (typeof raw.defaultValue !== "string" || raw.defaultValue.length > MAX.value) fail(`The default of field ${index + 1} must be short text.`); field.defaultValue = raw.defaultValue; }
  if (field.hidden && field.required) fail(`Field ${index + 1} can't be both hidden and required.`);
  if (field.hidden && UPLOAD_TYPES.has(column.type)) fail(`A Files field can't be hidden.`);
  if (raw.showWhen !== undefined && raw.showWhen !== null) {
    const w = raw.showWhen;
    if (!isObject(w)) fail(`The condition on field ${index + 1} must be an object.`);
    allowOnly(w, ["key", "cmp", "values"], `the condition on field ${index + 1}`);
    if (!keys.has(w.key) || w.key === raw.key) fail(`The condition on field ${index + 1} must name another field of this form.`);
    if (!["is", "isNot", "hasValue"].includes(w.cmp)) fail(`The condition on field ${index + 1} has an unknown comparison.`);
    if (w.cmp !== "hasValue" && (!Array.isArray(w.values) || !w.values.length || w.values.length > MAX.values || w.values.some((v) => typeof v !== "string" || v.length > MAX.value))) fail(`The condition on field ${index + 1} needs values.`);
    field.showWhen = { key: w.key, cmp: w.cmp, ...(w.cmp === "hasValue" ? {} : { values: [...w.values] }) };
  }
  return field;
}

// The whole definition, for creating a form or replacing one. Anything unknown, including any attempt to mark a form public, is refused.
function cleanForm(raw, board) {
  const body = requireBody(raw);
  allowOnly(body, ["expectedVersion", "name", "description", "status", "mode", "confirmation", "groupId", "uniqueKey", "fields"], "the form");
  const byKey = new Map(board.columns.map((c) => [c.key, c]));
  if (!Array.isArray(body.fields) || !body.fields.length || body.fields.length > MAX.fields) fail(`A form needs 1 to ${MAX.fields} fields.`);
  const keys = new Set(body.fields.map((f) => f?.key));
  if (keys.size !== body.fields.length) fail("A form can use each column only once.");
  const fields = body.fields.map((f, i) => cleanField(f, i, byKey, keys));
  const mode = body.mode ?? "create";
  if (!["create", "update"].includes(mode)) fail("mode must be create or update.");
  const status = body.status ?? "draft";
  if (!["draft", "published"].includes(status)) fail("status must be draft or published.");
  if (mode === "create") { const primary = fields.find((f) => f.key === PRIMARY_KEY); if (!primary || primary.hidden || primary.showWhen) fail("A form that creates records must always ask for the item name."); primary.required = true; }
  let groupId = null;
  if (body.groupId !== undefined && body.groupId !== null) { if (!board.groups.some((g) => g.id === body.groupId)) fail("groupId must be one of this board's groups."); groupId = body.groupId; }
  let uniqueKey = null;
  if (body.uniqueKey !== undefined && body.uniqueKey !== null) { if (!keys.has(body.uniqueKey) || UPLOAD_TYPES.has(byKey.get(body.uniqueKey)?.type)) fail("uniqueKey must be a field of this form."); uniqueKey = body.uniqueKey; }
  return { name: text(body.name, "The form's name", { max: MAX.name, required: true }), description: body.description ? text(body.description, "The description", { max: MAX.description }) : "", status, mode, confirmation: body.confirmation ? text(body.confirmation, "The confirmation message", { max: MAX.confirmation }) : "", groupId, uniqueKey, fields };
}

const textOf = (v) => (Array.isArray(v) ? v.map(String) : v === null || v === undefined || v === "" ? [] : [String(v)]);
// Does this field apply, given the submitted values? Conditions follow chains; a field whose condition's field doesn't apply doesn't either.
function fieldApplies(field, form, values, seen = new Set()) {
  if (!field.showWhen) return true;
  if (seen.has(field.key)) return false; // a loop in conditions never applies
  seen.add(field.key);
  const other = form.fields.find((f) => f.key === field.showWhen.key);
  if (!other || !fieldApplies(other, form, values, seen)) return false;
  const given = textOf(values[other.key] ?? other.defaultValue);
  if (field.showWhen.cmp === "hasValue") return given.length > 0;
  const hit = field.showWhen.values.some((v) => given.includes(v));
  return field.showWhen.cmp === "is" ? hit : !hit;
}

// Submitted values → what may be saved, or the fields still needing an answer. Only fields of this form that apply are accepted.
function submittedValues(form, board, rawValues) {
  if (!isObject(rawValues)) fail("values must be an object.");
  const byKey = new Map(board.columns.map((c) => [c.key, c])), known = new Map(form.fields.map((f) => [f.key, f]));
  for (const key of Object.keys(rawValues)) { const field = known.get(key); if (!field || field.hidden) fail(`This form doesn't accept a value for "${String(key).slice(0, 40)}".`); }
  const values = {}, missing = [];
  for (const field of form.fields) {
    const column = byKey.get(field.key);
    if (!column || UPLOAD_TYPES.has(column.type)) continue; // files are uploaded separately, through the usual file route
    const applies = fieldApplies(field, form, rawValues);
    if (!applies) { if (rawValues[field.key] !== undefined) fail(`"${field.label || column.label}" doesn't apply to this submission.`); continue; }
    const given = field.hidden ? undefined : rawValues[field.key];
    const empty = given === undefined || given === null || given === "" || (Array.isArray(given) && !given.length);
    if (empty && field.required) { missing.push(field.label || column.label); continue; }
    // Checked here, before anything uses the value: the duplicate check puts it in a database query.
    if (!empty) { checkValue(column, given); checkOptions(column, given); values[field.key] = given; }
    // Updating a record: an unanswered question leaves its cell alone, unless the form always sets it (hidden).
    else if (field.defaultValue !== undefined && (form.mode !== "update" || field.hidden)) values[field.key] = defaultFor(field, column);
  }
  return { values, missing };
}

// A default is stored as text in the definition; a cell needs its column's own shape.
function defaultFor(field, column) {
  if (column.type === "checkbox") return field.defaultValue === "true";
  return isMultiColumn(column) ? [field.defaultValue] : field.defaultValue;
}
// Status, priority and dropdown answers must be options the column offers. The record route allows a new option (people add
// them while editing), but someone filling in a form only chooses among the choices given.
function checkOptions(column, value) {
  if (!["status", "priority", "dropdown"].includes(column.type)) return;
  const options = effectiveOptions(column);
  if (options.length && [].concat(value).some((v) => !options.includes(v))) fail(`"${column.label || column.key}" must be one of its choices.`);
}

module.exports = { cleanForm, submittedValues, fieldApplies, MAX };
