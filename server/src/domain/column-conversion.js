// Column type conversion safety (Column System S0-A; owner decisions D-S0-1, D-S0-2, D-S0-3).
//
// A type change is allowed only when it is provably lossless on EVERY record of the board: each stored value either stays
// exactly as it is, or is rewritten into a form that means the same (one entry ↔ a one-entry list, "yes" → ticked). Anything
// else refuses the whole change and nothing is written. Never, silently:
//   - clearing a value that doesn't fit (the old behaviour: "1,234" → "" in a Number column);
//   - keeping only the first of several entries (several-value Dropdown → Status / Text / one-value Dropdown …);
//   - turning leading-zero IDs ("00123") or numbers with more than 15 significant digits into numbers;
//   - adopting impossible dates (2026-02-30) or day/month forms that can't be told apart (03/04/2026);
//   - creating more Dropdown options than a column can hold (LIMITS.options);
//   - flattening People into names (D-S0-3: refused while any People value exists);
//   - Connect / Mirror / Files / Group conversions (refused structurally by the service, before any value is read).
//
// Rules for a value to fit:
//   number  optional "-", digits, optional "." and decimals; no thousands separators, spaces, hex, exponent or leading "+";
//           no leading zeros except "0" / "0.x"; at most 15 significant digits (exact in a double).
//   date    YYYY-MM-DD and a real calendar date, checked arithmetically (no Date overflow, no time zone).
//   link / email / phone  the same rules as a new write (validation/record-values.js), value kept exactly as stored.
//   checkbox  true, or the text true / yes / 1 (any case) → ticked; empty → unticked; anything else refused.
//
// The plan is computed from a stream of { _id, value } over the whole board, never from loaded rows or a sample. Examples of
// values that don't fit are masked (digits → 9, letters → a, at most 20 characters), are only returned to someone who can
// already read the board, and are never logged.
const crypto = require("crypto");
const { hasValue, valueList, sameValue, checkValue, LIMITS } = require("./board-schema");
const { checkTyped, TYPED_VALUE_TYPES } = require("../validation/record-values");

// The current converter rewrites records synchronously in one transaction: bounded until the resumable engine exists.
const SYNC_LIMITS = Object.freeze({ records: 2000, cells: 2000 });
const MAX_EXAMPLES = 3;
const LOSSY = Object.freeze(["truncatedMulti", "leadingZero", "longNumber", "invalidDate", "ambiguousDate", "tooManyOptions", "peopleReferences"]);
const TRUE_TEXT = new Set(["true", "yes", "1"]);

const PLAIN_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const LEADING_ZERO = /^-?0\d+(?:\.\d+)?$/;
// null when `text` is a plain decimal that a Number column can hold exactly, otherwise the reason.
function numberProblem(text) {
  if (PLAIN_NUMBER.test(text)) return text.replace(/^-/, "").replace(".", "").replace(/^0+/, "").length <= 15 ? null : "longNumber";
  return LEADING_ZERO.test(text) ? "leadingZero" : "notNumber";
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MONTH = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;
function isRealDate(text) {
  const m = ISO_DATE.exec(text);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
// null when `text` is a strict ISO calendar date, otherwise the reason.
function dateProblem(text) {
  if (isRealDate(text)) return null;
  return DAY_MONTH.test(text) ? "ambiguousDate" : "invalidDate";
}

// A value's shape without its content: digits → 9, letters → a, at most 20 characters.
function maskValue(value) {
  const text = Array.isArray(value) ? value.map(String).join(", ") : String(value);
  return [...text.replace(/\p{Nd}/gu, "9").replace(/\p{L}/gu, "a").replace(/\p{M}/gu, "")].slice(0, 20).join("");
}

// The value an EMPTY cell keeps (same as before S0: unticked for checkbox, an empty list for list columns, "" when a list or
// a false checkbox becomes a scalar; undefined = leave the cell alone).
function emptyNext(value, to, toMulti) {
  if (to.type === "checkbox") return value === false ? undefined : false;
  if (value === undefined) return undefined;
  if (toMulti) return Array.isArray(value) && !value.length ? undefined : [];
  if (Array.isArray(value) || typeof value === "boolean") return "";
  return undefined; // "", "  ", null stay as stored
}

const fail = (reason) => ({ ok: false, reason });
const keep = (next) => ({ ok: true, next });

// One NON-EMPTY cell: { ok: true, next } (next undefined = unchanged) or { ok: false, reason }.
//   from: the column now; to: { type, multiple } (the new column); toColumn: the new column definition (for write checks).
function convertCell(value, from, to, toColumn) {
  const toMulti = to.type === "owner" || (to.type === "dropdown" && to.multiple);
  if (from.type === "owner") return fail("peopleReferences"); // D-S0-3: People stay People
  let scalar = value, fromList = false;
  if (Array.isArray(value)) {
    const list = valueList(value);
    if (list.length !== value.length) return fail("invalid"); // entries that aren't text would be dropped
    if (toMulti) return writable(toColumn, list) ? keep(sameValue(list, value) ? undefined : list) : fail("invalid");
    if (list.length > 1) return fail("truncatedMulti");
    scalar = list[0];
    fromList = true;
  }
  if (typeof scalar === "boolean") return to.type === "checkbox" ? keep(undefined) : fail("checkbox"); // a tick has no text form here
  if (typeof scalar !== "string" && typeof scalar !== "number") return fail("invalid");
  if (typeof scalar === "number" && !Number.isFinite(scalar)) return fail("invalid");
  const text = String(scalar);
  const changed = (next) => keep(fromList || !sameValue(next, value) ? next : undefined);
  if (toMulti) { const list = [text]; return writable(toColumn, list) ? keep(list) : fail("invalid"); }
  switch (to.type) {
    case "number": { const problem = numberProblem(text); return problem ? fail(problem) : changed(scalar); }
    case "date": { if (typeof scalar !== "string") return fail("invalidDate"); const problem = dateProblem(text); return problem ? fail(problem) : changed(scalar); }
    case "checkbox": return TRUE_TEXT.has(text.trim().toLowerCase()) ? keep(true) : fail("checkbox");
    default: break;
  }
  if (TYPED_VALUE_TYPES.has(to.type)) return checkTyped(to.type, text).reason ? fail("invalid") : changed(scalar);
  if (to.type === "dropdown" && text.length > LIMITS.optionLength) return fail("invalid"); // it must become an option
  // text, status, priority, one-value dropdown: the text stays. Numbers become their exact text in option columns.
  const next = typeof scalar === "number" && ["status", "priority", "dropdown"].includes(to.type) ? text : scalar;
  if (!writable(toColumn, typeof next === "number" ? text : next)) return fail("invalid");
  return changed(next);
}

// Would a normal write accept this value in the new column? (legacy-length text is accepted: it is already stored.)
function writable(column, value) {
  try { checkValue(column, value, { maxLength: LIMITS.legacyValueLength }); return true; } catch { return false; }
}

// Accumulates the plan over a stream of cells. Usage: const p = conversionPlanner(...); for each record p.add(id, value);
// const result = p.finish().
//   board, column: as stored now; to: { type, multiple }; toColumn: the new column definition (options filled in finish()).
function conversionPlanner({ board, column, to, toColumn }) {
  const toMulti = to.type === "owner" || (to.type === "dropdown" && to.multiple);
  const lossy = Object.fromEntries(LOSSY.map((k) => [k, 0]));
  const counts = { total: 0, populated: 0, convertible: 0, incompatible: 0 };
  const examples = [], changes = [];
  const options = to.type === "dropdown" ? new Set(column.options || []) : null;
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify([String(board._id), board.version, column.key, column.type, Boolean(column.multiple), to.type, Boolean(to.multiple)]));
  return {
    add(id, value) {
      counts.total += 1;
      hash.update(`\n${String(id)}\u0000${JSON.stringify(value === undefined ? null : value)}`);
      let next;
      if (!hasValue(value)) next = emptyNext(value, to, toMulti);
      else {
        counts.populated += 1;
        const cell = convertCell(value, column, to, toColumn);
        if (!cell.ok) {
          counts.incompatible += 1;
          if (lossy[cell.reason] !== undefined) lossy[cell.reason] += 1;
          if (examples.length < MAX_EXAMPLES) examples.push(maskValue(value));
          return;
        }
        counts.convertible += 1;
        next = cell.next;
        if (options) for (const entry of valueList(next === undefined ? value : next)) options.add(entry);
      }
      if (next !== undefined && !sameValue(next, value)) changes.push({ id, next });
    },
    finish() {
      const optionList = options ? [...options] : null;
      if (optionList && optionList.length > LIMITS.options) lossy.tooManyOptions = optionList.length - LIMITS.options;
      const tooLarge = counts.total > SYNC_LIMITS.records || changes.length > SYNC_LIMITS.cells;
      const reason = counts.incompatible > 0 ? (lossy.peopleReferences ? "PEOPLE_REFERENCES" : "INCOMPATIBLE_VALUES")
        : lossy.tooManyOptions ? "TOO_MANY_OPTIONS" : tooLarge ? "BOARD_TOO_LARGE" : null;
      return {
        details: {
          from: describeType(column.type, column.multiple), to: describeType(to.type, to.multiple),
          ...counts, lossy, examples, reason,
          allowed: reason === null, tooLarge, rewrites: changes.length, limits: { ...SYNC_LIMITS, options: LIMITS.options },
          previewToken: hash.digest("hex").slice(0, 32)
        },
        changes, options: optionList
      };
    }
  };
}

const describeType = (type, multiple) => (type === "dropdown" && multiple ? "dropdown_multiple" : type);

const MESSAGES = Object.freeze({
  PEOPLE_REFERENCES: "People columns can't be changed to another type while they have values. Your data has not been changed.",
  INCOMPATIBLE_VALUES: "Some values don't fit the new type, so the column wasn't changed. Your data has not been changed.",
  TOO_MANY_OPTIONS: `The new column would need more than ${LIMITS.options} options, so it wasn't changed. Your data has not been changed.`,
  BOARD_TOO_LARGE: `This board is too large to convert safely with the current converter (more than ${SYNC_LIMITS.records.toLocaleString("en-US")} records or values to rewrite); your data has not been changed.`,
  PREVIEW_STALE: "The column's values changed after the preview. Check the preview again; your data has not been changed."
});

module.exports = { SYNC_LIMITS, LOSSY, MESSAGES, numberProblem, dateProblem, isRealDate, maskValue, convertCell, conversionPlanner, describeType };
