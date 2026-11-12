// A form: a chosen set of a board's columns that employees fill in to create or update a record of that board.
// Internal only: every form needs a signed-in JARC session and the usual role in the board's workspace. There is no public
// form, and nothing in a form's definition can make one.
//
//   { name, description, status: draft | published, mode: create | update, confirmation, groupId, uniqueKey,
//     fields: [{ key, label, help, required, defaultValue, hidden, showWhen: { key, cmp: is | isNot | hasValue, values } }] }
//
// Guided forms (schemaVersion 2, set automatically when any of these is used; older forms are stored exactly as before):
//   layout: "wizard" with sections: [{ id, title, description }] (one step per section) and review: true (a summary step);
//   per field: section, placeholder, suffix (shown after the input, e.g. "%"), requiredWhen, validation { min, max,
//   maxDecimals, maxLength }, and showWhen / requiredWhen as AND / OR groups with equals | notEquals | contains | isEmpty |
//   isNotEmpty (site/assets/FormRules.js — the same rules run in the browser and here);
//   calculations: [{ id, label, op, args, target, enabled, note }] — previews shown next to a question, never stored.
//
// A field's showWhen makes it apply only when another field has (or doesn't have) a value: a field that doesn't apply is
// neither required nor accepted. A hidden field only ever supplies its default. Values are still checked against the
// column's type by the record service, exactly as for any other change.
const { fail, requireBody, allowOnly, text, isObject, isSafeKey } = require("../validation/common");
const { PRIMARY_KEY, isMultiColumn, effectiveOptions, checkValue } = require("./board-schema");
const rules = require("./form-rules");
const { MAX_FILES_PER_CELL } = require("../files/file-types");

const MAX = Object.freeze({ fields: 100, name: 200, description: 2000, label: 200, help: 500, confirmation: 500, values: 50, value: 200, sections: 12, sectionTitle: 120, placeholder: 200, suffix: 10, calculations: 10, note: 300, decimal: 30 });
const UPLOAD_TYPES = new Set(["files"]);
const SLUG = /^[a-z][a-z0-9_-]{0,39}$/;
const CALC_OPS = new Set(["add", "subtract", "multiply", "divide", "percentOf"]);

// A condition (showWhen / requiredWhen): one comparison, or an AND / OR group. Returned cleaned; anything else refused.
function cleanCondition(raw, { keys, self, where, depth = 1, count = { n: 0 } }) {
  if (!isObject(raw)) fail(`The condition on ${where} must be an object.`);
  if (rules.isGroup(raw)) {
    const op = Array.isArray(raw.all) ? "all" : "any";
    allowOnly(raw, [op], `the condition on ${where}`);
    if (depth > rules.LIMITS.depth) fail(`The condition on ${where} is nested too deeply.`);
    if (!raw[op].length || raw[op].length > 10) fail(`The condition on ${where} needs 1 to 10 parts.`);
    return { [op]: raw[op].map((c) => cleanCondition(c, { keys, self, where, depth: depth + 1, count })) };
  }
  allowOnly(raw, ["key", "cmp", "values"], `the condition on ${where}`);
  count.n += 1;
  if (count.n > rules.LIMITS.comparisons) fail(`The condition on ${where} has too many comparisons.`);
  if (!keys.has(raw.key) || raw.key === self) fail(`The condition on ${where} must name another field of this form.`);
  if (!rules.COMPARISONS.includes(raw.cmp)) fail(`The condition on ${where} has an unknown comparison.`);
  if (!rules.NEEDS_VALUES.has(raw.cmp)) return { key: raw.key, cmp: raw.cmp }; // values, if sent, mean nothing here
  if (!Array.isArray(raw.values) || !raw.values.length || raw.values.length > MAX.values || raw.values.some((v) => typeof v !== "string" || !v.length || v.length > MAX.value)) fail(`The condition on ${where} needs values.`);
  return { key: raw.key, cmp: raw.cmp, values: [...raw.values] };
}
const usesNewComparisons = (c) => Boolean(c) && (rules.isGroup(c) ? (c.all || c.any).some(usesNewComparisons) : !rules.LEGACY.includes(c.cmp));
const decimalText = (v, where) => { if (typeof v !== "string" || v.length > MAX.decimal || !rules.decimal.parse(v)) fail(`${where} must be a number written as text, e.g. "100".`); return v; };

function cleanField(raw, index, byKey, keys, sectionIds) {
  if (!isObject(raw)) fail(`Field ${index + 1} must be an object.`);
  allowOnly(raw, ["key", "label", "help", "required", "defaultValue", "hidden", "showWhen", "requiredWhen", "section", "placeholder", "suffix", "validation"], `field ${index + 1}`);
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
  const where = `field ${index + 1}`;
  if (raw.showWhen !== undefined && raw.showWhen !== null) field.showWhen = cleanCondition(raw.showWhen, { keys, self: raw.key, where });
  if (raw.requiredWhen !== undefined && raw.requiredWhen !== null) {
    if (field.hidden) fail(`Field ${index + 1} can't be hidden and conditionally required.`);
    if (field.required) fail(`Field ${index + 1} is already always required; remove its requiredWhen.`);
    field.requiredWhen = cleanCondition(raw.requiredWhen, { keys, self: raw.key, where: `${where} (required when)` });
  }
  if (raw.section !== undefined && raw.section !== null) { if (!sectionIds.has(raw.section)) fail(`Field ${index + 1} names a section this form doesn't have.`); field.section = raw.section; }
  if (raw.placeholder !== undefined && raw.placeholder !== "") field.placeholder = text(raw.placeholder, `The placeholder of field ${index + 1}`, { max: MAX.placeholder });
  if (raw.suffix !== undefined && raw.suffix !== "") field.suffix = text(raw.suffix, `The suffix of field ${index + 1}`, { max: MAX.suffix });
  if (raw.validation !== undefined && raw.validation !== null) {
    const v = raw.validation, out = {};
    if (!isObject(v)) fail(`The validation of field ${index + 1} must be an object.`);
    allowOnly(v, ["min", "max", "maxDecimals", "maxLength"], `the validation of field ${index + 1}`);
    if ((v.min !== undefined || v.max !== undefined || v.maxDecimals !== undefined) && column.type !== "number") fail(`Only number fields have min, max or decimal rules (field ${index + 1}).`);
    if (v.min !== undefined) out.min = decimalText(v.min, `The minimum of field ${index + 1}`);
    if (v.max !== undefined) out.max = decimalText(v.max, `The maximum of field ${index + 1}`);
    if (out.min !== undefined && out.max !== undefined && rules.decimal.compare(rules.decimal.parse(out.min), rules.decimal.parse(out.max)) > 0) fail(`The minimum of field ${index + 1} is above its maximum.`);
    if (v.maxDecimals !== undefined) { if (!Number.isInteger(v.maxDecimals) || v.maxDecimals < 0 || v.maxDecimals > 10) fail(`maxDecimals of field ${index + 1} must be 0 to 10.`); out.maxDecimals = v.maxDecimals; }
    if (v.maxLength !== undefined) { if (column.type !== "text" || !Number.isInteger(v.maxLength) || v.maxLength < 1 || v.maxLength > 10000) fail(`maxLength of field ${index + 1} must be 1 to 10000, on a text field.`); out.maxLength = v.maxLength; }
    if (Object.keys(out).length) field.validation = out;
  }
  return field;
}

function cleanSections(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX.sections) fail(`A form needs 1 to ${MAX.sections} sections.`);
  const ids = new Set();
  return raw.map((s, i) => {
    if (!isObject(s)) fail(`Section ${i + 1} must be an object.`);
    allowOnly(s, ["id", "title", "description"], `section ${i + 1}`);
    if (typeof s.id !== "string" || !SLUG.test(s.id) || ids.has(s.id)) fail(`Section ${i + 1} needs its own short ID (letters, digits, - or _).`);
    ids.add(s.id);
    return { id: s.id, title: text(s.title, `The title of section ${i + 1}`, { max: MAX.sectionTitle, required: true }), ...(s.description ? { description: text(s.description, `The description of section ${i + 1}`, { max: MAX.description }) } : {}) };
  });
}

// Calculation previews: shown beside a question, never stored, never changing an answer.
function cleanCalculations(raw, fields, byKey) {
  if (!Array.isArray(raw) || raw.length > MAX.calculations) fail(`A form can have at most ${MAX.calculations} calculations.`);
  const numberKeys = new Set(fields.filter((f) => byKey.get(f.key)?.type === "number").map((f) => f.key)), ids = new Set();
  return raw.map((c, i) => {
    const where = `calculation ${i + 1}`;
    if (!isObject(c)) fail(`The ${where} must be an object.`);
    allowOnly(c, ["id", "label", "op", "args", "target", "enabled", "note"], `the ${where}`);
    if (typeof c.id !== "string" || !SLUG.test(c.id) || ids.has(c.id)) fail(`The ${where} needs its own short ID.`);
    ids.add(c.id);
    if (!CALC_OPS.has(c.op)) fail(`The ${where} has an unknown operation.`);
    if (!Array.isArray(c.args) || c.args.length !== 2) fail(`The ${where} needs exactly two inputs.`);
    const args = c.args.map((a, j) => {
      if (!isObject(a)) fail(`Input ${j + 1} of the ${where} must be an object.`);
      allowOnly(a, ["key", "value"], `input ${j + 1} of the ${where}`);
      if ((a.key === undefined) === (a.value === undefined)) fail(`Input ${j + 1} of the ${where} is either a field or a number.`);
      if (a.key !== undefined) { if (!numberKeys.has(a.key)) fail(`Input ${j + 1} of the ${where} must be a number field of this form.`); return { key: a.key }; }
      return { value: decimalText(a.value, `Input ${j + 1} of the ${where}`) };
    });
    if (c.target !== undefined && c.target !== null && !numberKeys.has(c.target)) fail(`The ${where} must be shown beside a number field of this form.`);
    if (typeof c.enabled !== "boolean") fail(`The ${where} must say whether it is enabled.`);
    return { id: c.id, label: text(c.label, `The label of the ${where}`, { max: MAX.sectionTitle, required: true }), op: c.op, args, ...(c.target ? { target: c.target } : {}), enabled: c.enabled, ...(c.note ? { note: text(c.note, `The note of the ${where}`, { max: MAX.note }) } : {}) };
  });
}

// The whole definition, for creating a form or replacing one. Anything unknown, including any attempt to mark a form public, is refused.
function cleanForm(raw, board) {
  const body = requireBody(raw);
  allowOnly(body, ["expectedVersion", "name", "description", "status", "mode", "confirmation", "groupId", "uniqueKey", "fields", "layout", "sections", "review", "calculations", "schemaVersion"], "the form");
  const byKey = new Map(board.columns.map((c) => [c.key, c]));
  if (!Array.isArray(body.fields) || !body.fields.length || body.fields.length > MAX.fields) fail(`A form needs 1 to ${MAX.fields} fields.`);
  const keys = new Set(body.fields.map((f) => f?.key));
  if (keys.size !== body.fields.length) fail("A form can use each column only once.");
  // schemaVersion is never taken from the request: it follows from what the definition uses.
  if (body.schemaVersion !== undefined && ![1, 2].includes(body.schemaVersion)) fail("schemaVersion must be 1 or 2.");
  const layout = body.layout ?? "single";
  if (!["single", "wizard"].includes(layout)) fail("layout must be single or wizard.");
  const sections = body.sections !== undefined && body.sections !== null ? cleanSections(body.sections) : null;
  if (layout === "wizard" && !sections) fail("A step-by-step form needs its sections.");
  // A create form always requires the item name. Marked before cleaning, so the stored field has the same canonical
  // shape however often the definition is saved (cleaning a cleaned definition changes nothing).
  const creates = (body.mode ?? "create") === "create";
  const rawFields = body.fields.map((f) => (creates && isObject(f) && f.key === PRIMARY_KEY && f.hidden !== true && !f.showWhen ? { ...f, required: true } : f));
  const fields = rawFields.map((f, i) => cleanField(f, i, byKey, keys, new Set((sections || []).map((s) => s.id))));
  if (layout === "wizard") { const missing = fields.find((f) => !f.section); if (missing) fail(`Every field of a step-by-step form needs a section ("${missing.key}").`); }
  if (body.review !== undefined && typeof body.review !== "boolean") fail("review must be true or false.");
  const calculations = body.calculations !== undefined && body.calculations !== null ? cleanCalculations(body.calculations, fields, byKey) : null;
  const mode = body.mode ?? "create";
  if (!["create", "update"].includes(mode)) fail("mode must be create or update.");
  const status = body.status ?? "draft";
  if (!["draft", "published"].includes(status)) fail("status must be draft or published.");
  if (mode === "create") { const primary = fields.find((f) => f.key === PRIMARY_KEY); if (!primary || primary.hidden || primary.showWhen) fail("A form that creates records must always ask for the item name."); primary.required = true; }
  let groupId = null;
  if (body.groupId !== undefined && body.groupId !== null) { if (!board.groups.some((g) => g.id === body.groupId)) fail("groupId must be one of this board's groups."); groupId = body.groupId; }
  let uniqueKey = null;
  if (body.uniqueKey !== undefined && body.uniqueKey !== null) { if (!keys.has(body.uniqueKey) || UPLOAD_TYPES.has(byKey.get(body.uniqueKey)?.type)) fail("uniqueKey must be a field of this form."); uniqueKey = body.uniqueKey; }
  const out = { name: text(body.name, "The form's name", { max: MAX.name, required: true }), description: body.description ? text(body.description, "The description", { max: MAX.description }) : "", status, mode, confirmation: body.confirmation ? text(body.confirmation, "The confirmation message", { max: MAX.confirmation }) : "", groupId, uniqueKey, fields };
  // Guided-form settings only when used, so every older form keeps exactly its stored shape.
  const guided = layout !== "single" || sections || body.review === true || (calculations && calculations.length) || fields.some((f) => f.section || f.placeholder || f.suffix || f.validation || f.requiredWhen || usesNewComparisons(f.showWhen));
  if (guided) Object.assign(out, { schemaVersion: 2, layout, sections: sections || [], review: body.review === true, calculations: calculations || [] });
  return out;
}

// Does this field apply, given the submitted values? Conditions follow chains; a field whose condition's field doesn't
// apply doesn't either (the shared rules: site/assets/FormRules.js).
const fieldApplies = (field, form, values) => rules.fieldApplies(field, form, values);

// Submitted values → what may be saved, or the fields still needing an answer. Only fields of this form that apply are accepted.
// files: { columnKey: number of files about to be uploaded } for the form's Files questions. The files themselves go through
// the usual secured upload route after the record exists; this only lets the server apply required and conditional
// rules to file questions, and refuse files for a question that doesn't apply.
function submittedValues(form, board, rawValues, { files } = {}) {
  if (!isObject(rawValues)) fail("values must be an object.");
  const byKey = new Map(board.columns.map((c) => [c.key, c])), known = new Map(form.fields.map((f) => [f.key, f]));
  for (const key of Object.keys(rawValues)) { const field = known.get(key); if (!field || field.hidden) fail(`This form doesn't accept a value for "${String(key).slice(0, 40)}".`); }
  if (files !== undefined && files !== null) {
    if (!isObject(files)) fail("files must be an object.");
    for (const [key, n] of Object.entries(files)) {
      const field = known.get(key);
      if (!field || !UPLOAD_TYPES.has(byKey.get(key)?.type)) fail(`This form has no file question "${String(key).slice(0, 40)}".`);
      if (!Number.isInteger(n) || n < 0 || n > MAX_FILES_PER_CELL) fail(`A file question takes 0 to ${MAX_FILES_PER_CELL} files.`);
    }
  }
  const values = {}, missing = [];
  for (const field of form.fields) {
    const column = byKey.get(field.key);
    if (!column) continue;
    const applies = fieldApplies(field, form, rawValues);
    if (UPLOAD_TYPES.has(column.type)) {
      const n = files?.[field.key] ?? 0;
      if (!applies) { if (n > 0) fail(`"${field.label || column.label}" doesn't apply to this submission.`); continue; }
      if (n === 0 && rules.isRequired(field, form, rawValues)) missing.push(field.label || column.label);
      continue;
    }
    if (!applies) { if (rawValues[field.key] !== undefined) fail(`"${field.label || column.label}" doesn't apply to this submission.`); continue; }
    const given = field.hidden ? undefined : rawValues[field.key];
    const empty = given === undefined || given === null || given === "" || (Array.isArray(given) && !given.length);
    if (empty && rules.isRequired(field, form, rawValues)) { missing.push(field.label || column.label); continue; }
    // Checked here, before anything uses the value: the duplicate check puts it in a database query.
    if (!empty) {
      checkValue(column, given); checkOptions(column, given);
      const problem = rules.checkRules(field, column, given); if (problem) fail(problem);
      values[field.key] = given;
    }
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
