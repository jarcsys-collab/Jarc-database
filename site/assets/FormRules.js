// Form rules, ONE implementation for the browser (FormsPanel.js, loaded as a script: window.FormRules) and the server
// (server/src/domain/form-rules.js requires this very file). Pure: no DOM, no network, no clock. The server decides in
// the end; the browser uses the same rules so people see the same answers before they submit.
//
//   conditions   { key, cmp, values? } or { all: [ … ] } / { any: [ … ] } (AND / OR), nested at most 3 deep, at most 20
//                comparisons per field. cmp: equals | notEquals | contains | isEmpty | isNotEmpty, and the original
//                is | isNot | hasValue (unchanged: a condition on a question that doesn't apply is false). With the
//                newer comparisons, a question that doesn't apply counts as empty (its value is never sent).
//                equals / notEquals: any answer (one, or one of several selections) is / isn't one of the values.
//                contains: an answer contains one of the values as text (case-insensitive) — for a multi-select, a
//                selection's name.
//   applies      a field with showWhen applies only when it holds; conditions follow chains; a loop never applies.
//   required     required, or requiredWhen holds — only for a field that applies.
//   validation   { min, max } (decimal strings, inclusive), maxDecimals, maxLength. Exact decimal comparison.
//   decimals     exact decimal arithmetic on strings (BigInt), for calculation PREVIEWS only: nothing here writes a value.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FormRules = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const LEGACY = ["is", "isNot", "hasValue"];
  const COMPARISONS = Object.freeze([...LEGACY, "equals", "notEquals", "contains", "isEmpty", "isNotEmpty"]);
  const NEEDS_VALUES = new Set(["is", "isNot", "equals", "notEquals", "contains"]);
  const LIMITS = Object.freeze({ depth: 3, comparisons: 20, values: 50, value: 200 });

  const listOf = (v) => (Array.isArray(v) ? v.map(String).filter((s) => s !== "") : v === undefined || v === null || v === "" || v === false ? [] : [String(v)]);
  const isGroup = (c) => c && typeof c === "object" && (Array.isArray(c.all) || Array.isArray(c.any));

  // The keys a condition reads (for designers and validation).
  function keysOf(cond, out = new Set()) {
    if (!cond || typeof cond !== "object") return out;
    if (isGroup(cond)) for (const c of cond.all || cond.any) keysOf(c, out); else if (typeof cond.key === "string") out.add(cond.key);
    return out;
  }

  function test(cond, form, values, seen) {
    if (!cond) return true;
    if (Array.isArray(cond.all)) return cond.all.every((c) => test(c, form, values, new Set(seen)));
    if (Array.isArray(cond.any)) return cond.any.some((c) => test(c, form, values, new Set(seen)));
    const other = form.fields.find((f) => f.key === cond.key);
    if (!other) return false;
    const applies = fieldApplies(other, form, values, seen);
    if (!applies && LEGACY.includes(cond.cmp)) return false;
    const raw = values[other.key] !== undefined ? values[other.key] : other.defaultValue;
    const given = applies ? listOf(raw) : [];
    const wanted = (cond.values || []).map(String);
    switch (cond.cmp) {
      case "hasValue": case "isNotEmpty": return given.length > 0;
      case "isEmpty": return given.length === 0;
      case "is": case "equals": return wanted.some((v) => given.includes(v));
      case "isNot": case "notEquals": return !wanted.some((v) => given.includes(v));
      case "contains": return wanted.some((v) => given.some((g) => g.toLowerCase().includes(v.toLowerCase())));
      default: return false;
    }
  }
  // Does this field apply, given the answers? A loop in conditions never applies.
  function fieldApplies(field, form, values, seen = new Set()) {
    if (!field || !field.showWhen) return true;
    if (seen.has(field.key)) return false;
    seen.add(field.key);
    return test(field.showWhen, form, values, seen);
  }
  function isRequired(field, form, values) {
    if (!fieldApplies(field, form, values)) return false;
    if (field.required === true) return true;
    return Boolean(field.requiredWhen) && test(field.requiredWhen, form, values, new Set([field.key]));
  }

  // ---- Exact decimals: "4.17" → { n: 417n, s: 2 }. Only plain decimal notation (what number columns store).
  const DECIMAL = /^-?(\d+(\.\d*)?|\.\d+)$/;
  function parse(text) {
    const t = String(text ?? "").trim();
    if (!DECIMAL.test(t)) return null;
    const neg = t.startsWith("-"), body = neg ? t.slice(1) : t, [i, f = ""] = body.split(".");
    return { n: BigInt(`${neg ? "-" : ""}${i || "0"}${f}`), s: f.length };
  }
  const scaleTo = (a, s) => a.n * 10n ** BigInt(s - a.s);
  function compare(a, b) { const s = Math.max(a.s, b.s), x = scaleTo(a, s), y = scaleTo(b, s); return x < y ? -1 : x > y ? 1 : 0; }
  function format({ n, s }) {
    const neg = n < 0n, digits = (neg ? -n : n).toString().padStart(s + 1, "0");
    let out = s ? `${digits.slice(0, -s)}.${digits.slice(-s)}` : digits;
    if (s) out = out.replace(/0+$/, "").replace(/\.$/, "");
    return `${neg && out !== "0" ? "-" : ""}${out}`;
  }
  const add = (a, b) => { const s = Math.max(a.s, b.s); return { n: scaleTo(a, s) + scaleTo(b, s), s }; };
  const subtract = (a, b) => { const s = Math.max(a.s, b.s); return { n: scaleTo(a, s) - scaleTo(b, s), s }; };
  const multiply = (a, b) => ({ n: a.n * b.n, s: a.s + b.s });
  // Division to `places` decimals, rounded half away from zero; flagged as rounded when not exact.
  function divide(a, b, places = 10) {
    if (b.n === 0n) return null;
    const s = Math.max(a.s, b.s), x = scaleTo(a, s) * 10n ** BigInt(places + 1), y = scaleTo(b, s);
    let q = x / y; const exact = x % y === 0n && q % 10n === 0n;
    q = q >= 0n ? (q + 5n) / 10n : (q - 5n) / 10n;
    return { n: q, s: places, rounded: !exact };
  }
  const decimals = (text) => { const p = parse(text); return p ? p.s : null; };

  // A field's validation rules → the first problem, or null. Empty answers aren't checked here (required is separate).
  function checkRules(field, column, value) {
    const v = field.validation;
    if (!v || value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return null;
    const label = field.label || column?.label || field.key;
    if (column?.type === "number") {
      const p = parse(value);
      if (!p) return `"${label}" must be a number.`;
      if (v.min !== undefined && compare(p, parse(v.min)) < 0) return `"${label}" must be at least ${v.min}.`;
      if (v.max !== undefined && compare(p, parse(v.max)) > 0) return `"${label}" must be at most ${v.max}.`;
      // Trailing zeros don't count: "1.50" has one significant decimal place.
      const significant = (String(value).trim().split(".")[1] || "").replace(/0+$/, "").length;
      if (v.maxDecimals !== undefined && significant > v.maxDecimals) return `"${label}" can have at most ${v.maxDecimals} decimal place${v.maxDecimals === 1 ? "" : "s"}.`;
    }
    if (v.maxLength !== undefined && typeof value === "string" && value.length > v.maxLength) return `"${label}" can be at most ${v.maxLength} characters.`;
    return null;
  }

  // Calculation previews: { id, label, op: add | subtract | multiply | divide | percentOf, args: [{ key } | { value }],
  // enabled }. → { value, rounded } or null when an input is missing or not a number. Never writes anything.
  function calculate(calc, form, values) {
    if (!calc || calc.enabled !== true) return null;
    const args = [];
    for (const a of calc.args || []) {
      let raw;
      if (a.value !== undefined) raw = a.value;
      else { const f = form.fields.find((x) => x.key === a.key); if (!f || !fieldApplies(f, form, values)) return null; raw = values[a.key]; }
      const p = parse(raw); if (!p) return null; args.push(p);
    }
    if (args.length !== 2) return null;
    const [a, b] = args;
    let r;
    if (calc.op === "add") r = add(a, b);
    else if (calc.op === "subtract") r = subtract(a, b);
    else if (calc.op === "multiply") r = multiply(a, b);
    else if (calc.op === "divide") r = divide(a, b);
    else if (calc.op === "percentOf") { const m = multiply(a, b); r = { n: m.n, s: m.s + 2 }; } // a × b / 100, exact
    if (!r) return null;
    return { value: format(r), rounded: Boolean(r.rounded) };
  }

  return { COMPARISONS, LEGACY, NEEDS_VALUES, LIMITS, listOf, keysOf, isGroup, test, fieldApplies, isRequired, checkRules, calculate, decimal: { parse, compare, format, add, subtract, multiply, divide, decimals } };
});
