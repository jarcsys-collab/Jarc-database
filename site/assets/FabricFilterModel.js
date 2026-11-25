// Fabric Data advanced filters: the structured filter model, version 1 (pure: no DOM, no requests).
// Mirrors the server's catalog (server/src/fabric/filter-model.js, Phase 7 04-operator-catalog.md): the same kinds, operators,
// limits and shapes. The server is authoritative and validates everything again; this copy only lets the builder offer what
// the server accepts and say what is wrong before a request is sent.
//
// Model: { v: 1, op: "and"|"or", items: [condition | group] }; a group is { op, items }; a condition is
// { field, op, value?, to?, values?, n?, unit? } with only the keys its operator takes. Depth ≤ 2 (the root plus one nested
// level). Values are strings (numbers as exact decimal text, dates as UTC YYYY-MM-DD) or null in a list.
// Transport: GET …/records?filter=<base64url(canonical JSON)>.
class FabricFilterModel {
  static VERSION = 1;
  static LIMITS = Object.freeze({ maxDepth: 2, maxConditions: 20, maxGroups: 10, maxListValues: 200, maxText: 100, maxEncoded: 6000, maxCanonical: 4096, minN: 1, maxN: 366 });
  static KINDS = Object.freeze(["text", "number", "date", "bool", "category"]);
  static UNITS = Object.freeze(["days", "weeks", "months"]);
  // Operators per kind, in the order the builder lists them (the server's catalog order).
  static OPERATORS = Object.freeze({
    text: Object.freeze(["eq", "ne", "contains", "notContains", "startsWith", "endsWith", "in", "nin", "blank", "notBlank", "isNull", "missing"]),
    number: Object.freeze(["eq", "ne", "gt", "gte", "lt", "lte", "between", "blank", "notBlank", "isNull", "missing"]),
    date: Object.freeze(["on", "before", "onOrBefore", "after", "onOrAfter", "between", "today", "yesterday", "lastN", "prevN", "thisWeek", "thisMonth", "thisQuarter", "thisYear", "lastMonth", "lastYear", "blank", "notBlank"]),
    bool: Object.freeze(["isTrue", "isFalse", "isNull", "missing"]),
    category: Object.freeze(["eq", "ne", "in", "nin", "blank", "notBlank"])
  });
  // What each operator takes: value (one), range (value + to), list (values), relative (n + unit) or none.
  static ARITY = Object.freeze({
    eq: "value", ne: "value", contains: "value", notContains: "value", startsWith: "value", endsWith: "value",
    gt: "value", gte: "value", lt: "value", lte: "value", on: "value", before: "value", onOrBefore: "value", after: "value", onOrAfter: "value",
    between: "range", in: "list", nin: "list", lastN: "relative", prevN: "relative",
    blank: "none", notBlank: "none", isNull: "none", missing: "none", isTrue: "none", isFalse: "none", today: "none", yesterday: "none",
    thisWeek: "none", thisMonth: "none", thisQuarter: "none", thisYear: "none", lastMonth: "none", lastYear: "none"
  });
  // Labels: the server's catalog (filter-model.js OPERATORS[].label). "ne"/"nin"/"notContains" say that blanks are included
  // (MongoDB's $ne/$nin semantics, kept by the server).
  static LABELS = Object.freeze({
    eq: "equals", ne: "does not equal (blanks included)", contains: "contains", notContains: "does not contain (blanks included)",
    startsWith: "begins with (case-sensitive)", endsWith: "ends with", in: "is one of", nin: "is not one of (blanks included)",
    blank: "is blank", notBlank: "is not blank", isNull: "is null", missing: "is missing",
    gt: "greater than", gte: "greater than or equal to", lt: "less than", lte: "less than or equal to", between: "between (inclusive)",
    on: "on", before: "before", onOrBefore: "on or before", after: "after", onOrAfter: "on or after", today: "today", yesterday: "yesterday",
    lastN: "in the last N (including today)", prevN: "in the previous N (excluding today)", thisWeek: "this week (Monday to Sunday)",
    thisMonth: "this month", thisQuarter: "this quarter", thisYear: "this year", lastMonth: "last calendar month", lastYear: "last calendar year",
    isTrue: "is true", isFalse: "is false"
  });
  // nullable: the value (or a list item) may be null (the server's OPERATORS[].nullable).
  static NULLABLE = Object.freeze(new Set(["eq", "ne", "in", "nin"]));
  // Short forms for chips ("Quantity ≥ 10").
  static SHORT = Object.freeze({ eq: "=", ne: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", in: "is one of", nin: "is not one of", contains: "contains", notContains: "doesn't contain", startsWith: "begins with", endsWith: "ends with", on: "on", before: "before", onOrBefore: "on or before", after: "after", onOrAfter: "on or after" });
  static FIELD = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;
  static DAY = /^\d{4}-\d{2}-\d{2}$/;
  static DECIMAL = /^-?(\d{1,34})(\.(\d{1,34}))?$/;
  static isDecimal(v) { const m = typeof v === "string" ? FabricFilterModel.DECIMAL.exec(v) : null; return Boolean(m) && m[1].length + (m[3]?.length || 0) <= 34 && Number.isFinite(Number(v)); }
  static CONTROL = /[\u0000-\u001f\u007f]/;

  // ---- Small helpers
  static isDay(v) { if (typeof v !== "string" || !FabricFilterModel.DAY.test(v)) return false; const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }
  static isGroup(item) { return Boolean(item && typeof item === "object" && Array.isArray(item.items)); }
  static kindOf(type) {
    const t = String(type || "").toLowerCase();
    if (["int", "long", "double", "decimal", "number", "integer", "float"].includes(t)) return "number";
    if (t === "date" || t === "datetime") return "date";
    if (t === "bool" || t === "boolean") return "bool";
    if (t === "category" || t === "company") return "category";
    return "text";
  }
  static operatorsFor(kind) { return FabricFilterModel.OPERATORS[kind] || FabricFilterModel.OPERATORS.text; }
  static arity(op) { return FabricFilterModel.ARITY[op] || "none"; }
  static label(op) { return FabricFilterModel.LABELS[op] || String(op); }
  static empty(op = "and") { return { v: FabricFilterModel.VERSION, op: op === "or" ? "or" : "and", items: [] }; }
  static clone(m) { return m === null || m === undefined ? m : JSON.parse(JSON.stringify(m)); }
  // A new condition for a field: the first operator its kind (or the field's own list) offers, empty values.
  static condition(field, op) { const c = { field, op }; const a = FabricFilterModel.arity(op); if (a === "value") c.value = ""; else if (a === "range") { c.value = ""; c.to = ""; } else if (a === "list") c.values = []; else if (a === "relative") { c.n = "7"; c.unit = "days"; } return c; }
  // Changing the operator keeps what still fits (one value stays one value, a range keeps its start, a list keeps its items).
  static withOp(c, op) {
    const next = FabricFilterModel.condition(c.field, op), a = FabricFilterModel.arity(op), was = FabricFilterModel.arity(c.op);
    if (a === "value" && (was === "value" || was === "range")) next.value = c.value ?? "";
    if (a === "value" && was === "list" && Array.isArray(c.values) && typeof c.values[0] === "string") next.value = c.values[0];
    if (a === "range" && (was === "value" || was === "range")) { next.value = c.value ?? ""; if (was === "range") next.to = c.to ?? ""; }
    if (a === "list" && was === "list") next.values = [...(c.values || [])];
    if (a === "list" && was === "value" && typeof c.value === "string" && c.value) next.values = [c.value];
    if (a === "relative" && was === "relative") { next.n = c.n; next.unit = c.unit; }
    return next;
  }

  // ---- Paths: "2" is the root's third item, "2.0" the first item of that nested group. "" is the root.
  static parsePath(path) { if (path === "" || path === null || path === undefined) return []; const parts = String(path).split("."); return parts.every((p) => /^\d{1,3}$/.test(p)) ? parts.map(Number) : null; }
  static at(model, path) {
    const parts = FabricFilterModel.parsePath(path); if (!parts || !model) return null;
    let node = model;
    for (const i of parts) { if (!FabricFilterModel.isGroup(node) || i >= node.items.length) return null; node = node.items[i]; }
    return node;
  }
  static parentOf(model, path) { const parts = FabricFilterModel.parsePath(path); if (!parts || !parts.length) return null; return { group: FabricFilterModel.at(model, parts.slice(0, -1).join(".")), index: parts.at(-1) }; }
  // Removing an item: a nested group left empty goes too. Returns a new model.
  static removeAt(model, path) {
    const m = FabricFilterModel.clone(model), p = FabricFilterModel.parentOf(m, path);
    if (!p || !FabricFilterModel.isGroup(p.group) || p.index >= p.group.items.length) return m;
    p.group.items.splice(p.index, 1);
    const parts = FabricFilterModel.parsePath(path);
    if (parts.length === 2 && !p.group.items.length) m.items.splice(parts[0], 1);
    return m;
  }
  static duplicateAt(model, path) {
    const m = FabricFilterModel.clone(model), p = FabricFilterModel.parentOf(m, path);
    if (!p || !FabricFilterModel.isGroup(p.group) || p.index >= p.group.items.length) return m;
    p.group.items.splice(p.index + 1, 0, FabricFilterModel.clone(p.group.items[p.index]));
    return m;
  }
  static replaceAt(model, path, item) {
    const m = FabricFilterModel.clone(model), p = FabricFilterModel.parentOf(m, path);
    if (!p || !FabricFilterModel.isGroup(p.group) || p.index >= p.group.items.length) return m;
    p.group.items[p.index] = item; return m;
  }
  // Every condition with its path, depth-first (chips, counts, the field list in a column's menu).
  static conditions(model) {
    const out = [];
    const walk = (g, prefix, depth) => { if (!FabricFilterModel.isGroup(g)) return; g.items.forEach((it, i) => { const path = prefix === "" ? String(i) : `${prefix}.${i}`; if (FabricFilterModel.isGroup(it)) walk(it, path, depth + 1); else if (it && typeof it === "object") out.push({ path, condition: it, group: g, depth }); }); };
    walk(model, "", 1);
    return out;
  }
  static count(model) { return model ? FabricFilterModel.conditions(model).length : 0; }
  static groupCount(model) { let n = 0; const walk = (g) => { if (!FabricFilterModel.isGroup(g)) return; n += 1; g.items.forEach(walk); }; walk(model); return n; }

  // ---- Validation. fields: optional Map/obj name → { kind, operators: [op…] } (the schema's filterable fields). Returns
  // { ok, errors: [{ path, field, message }] }; path "" is the whole filter. Messages never echo a value.
  static validate(model, fields = null) {
    const L = FabricFilterModel.LIMITS, errors = [];
    const err = (path, message, field = "") => errors.push({ path, field, message });
    if (model === null || model === undefined) return { ok: true, errors };
    if (!FabricFilterModel.isGroup(model) || (model.v !== undefined && model.v !== FabricFilterModel.VERSION)) { err("", "This filter isn't in a format this page understands."); return { ok: false, errors }; }
    const lookup = (name) => (!fields ? null : typeof fields.get === "function" ? fields.get(name) || null : Object.hasOwn(fields, name) ? fields[name] : null);
    let conditions = 0, groups = 0;
    const text = (v) => typeof v === "string" && v.length <= L.maxText && !FabricFilterModel.CONTROL.test(v);
    // The builder is stricter than the server in one way: an empty text box is "no value yet", never "equals the empty text"
    // (use "is blank" for that). A null value (a value list's "(blank)") is accepted where the server accepts it.
    const checkValue = (kind, v, path, field, what = "a value", op = "") => {
      if (v === null && FabricFilterModel.NULLABLE.has(op)) return true;
      if (typeof v !== "string" || v.trim() === "") { err(path, `Enter ${what}${op === "eq" || op === "ne" ? ", or choose “is blank”" : ""}.`, field); return false; }
      if (!text(v)) { err(path, `Values can be at most ${L.maxText} characters, without line breaks.`, field); return false; }
      if (kind === "number" && !FabricFilterModel.isDecimal(v)) { err(path, "Enter a number such as -12.5 (digits, at most 34, no exponent).", field); return false; }
      if (kind === "date" && !FabricFilterModel.isDay(v)) { err(path, "Enter a real date.", field); return false; }
      return true;
    };
    const walk = (g, prefix, depth) => {
      groups += 1;
      if (g.op !== "and" && g.op !== "or") err(prefix, "Choose All (AND) or Any (OR).");
      if (depth > L.maxDepth) { err(prefix, `Groups can be nested only ${L.maxDepth - 1} level deep.`); return; }
      if (depth > 1 && !g.items.length) err(prefix, "This group is empty: add a condition or remove the group.");
      g.items.forEach((it, i) => {
        const path = prefix === "" ? String(i) : `${prefix}.${i}`;
        if (FabricFilterModel.isGroup(it)) { walk(it, path, depth + 1); return; }
        conditions += 1;
        if (!it || typeof it !== "object" || typeof it.field !== "string" || !it.field) { err(path, "Choose a field."); return; }
        const f = lookup(it.field);
        if (!FabricFilterModel.FIELD.test(it.field) || (fields && !f)) { err(path, "This field can't be used in filters.", it.field); return; }
        const kind = f?.kind || "text", ops = Array.isArray(f?.operators) && f.operators.length ? f.operators : FabricFilterModel.operatorsFor(kind);
        if (!FabricFilterModel.ARITY[it.op] || !ops.includes(it.op)) { err(path, "Choose an operator this field supports.", it.field); return; }
        const a = FabricFilterModel.arity(it.op);
        if (a === "value") checkValue(kind, it.value, path, it.field, "a value", it.op);
        else if (a === "range") {
          const ok1 = checkValue(kind, it.value, path, it.field, "a start value"), ok2 = ok1 && checkValue(kind, it.to, path, it.field, "an end value");
          if (ok1 && ok2) {
            const bad = kind === "number" ? Number(it.value) > Number(it.to) : kind === "date" ? it.value > it.to : false;
            if (bad) err(path, "The start must be less than or equal to the end.", it.field);
          }
        } else if (a === "list") {
          const vs = Array.isArray(it.values) ? it.values : [];
          if (!vs.length) err(path, "Choose at least one value.", it.field);
          else if (vs.length > L.maxListValues) err(path, `Choose at most ${L.maxListValues} values.`, it.field);
          else if (vs.some((v) => v !== null && !text(v))) err(path, `Values can be at most ${L.maxText} characters, without line breaks.`, it.field);
          else if (kind === "number" && vs.some((v) => v === null || !FabricFilterModel.isDecimal(v))) err(path, "Every value must be a number.", it.field);
        } else if (a === "relative") {
          const n = Number(it.n);
          if (!Number.isInteger(n) || n < L.minN || n > L.maxN) err(path, `Enter a whole number from ${L.minN} to ${L.maxN}.`, it.field);
          if (!FabricFilterModel.UNITS.includes(it.unit)) err(path, "Choose days, weeks or months.", it.field);
        }
      });
    };
    walk(model, "", 1);
    if (conditions > L.maxConditions) err("", `A filter can have at most ${L.maxConditions} conditions.`);
    if (groups > L.maxGroups) err("", `A filter can have at most ${L.maxGroups} groups (including the outer one).`);
    if (!errors.length) {
      const c = FabricFilterModel.canonical(model);
      if (c && FabricFilterModel.utf8(JSON.stringify(c)).length > L.maxCanonical) err("", "This filter is too long. Remove some conditions or values.");
    }
    return { ok: errors.length === 0, errors };
  }

  // ---- Canonical form: fixed key order, only the keys an operator takes, trimmed numbers, de-duplicated lists, empty nested
  // groups dropped, a nested group of one condition kept as written. No conditions at all → null (no filter).
  static canonical(model) {
    if (!FabricFilterModel.isGroup(model)) return null;
    const cond = (c) => {
      if (!c || typeof c !== "object" || typeof c.field !== "string") return null;
      const out = { field: c.field, op: c.op }, a = FabricFilterModel.arity(c.op);
      // Text is kept exactly as typed (eq is exact); the builder trims number and date inputs as they are entered.
      if (a === "value") out.value = c.value === undefined ? "" : c.value;
      else if (a === "range") { out.value = c.value === undefined ? "" : c.value; out.to = c.to === undefined ? "" : c.to; }
      else if (a === "list") { const seen = new Set(); out.values = (Array.isArray(c.values) ? c.values : []).filter((v) => { const k = v === null ? "\u0000null" : String(v); if (seen.has(k)) return false; seen.add(k); return true; }); }
      else if (a === "relative") { out.n = Number(c.n); out.unit = c.unit; }
      return out;
    };
    const group = (g) => { const items = g.items.map((it) => (FabricFilterModel.isGroup(it) ? group(it) : cond(it))).filter((it) => it && (!FabricFilterModel.isGroup(it) || it.items.length)); return { op: g.op === "or" ? "or" : "and", items }; };
    const root = group(model);
    return root.items.length ? { v: FabricFilterModel.VERSION, op: root.op, items: root.items } : null;
  }
  static same(a, b) { return JSON.stringify(FabricFilterModel.canonical(a)) === JSON.stringify(FabricFilterModel.canonical(b)); }

  // ---- base64url of UTF-8 JSON (no btoa/TextEncoder needed, so it also runs in the tests' vm).
  static utf8(s) {
    const out = [];
    for (const ch of String(s)) {
      let c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else { c = Math.min(c, 0x10ffff); out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
  }
  static fromUtf8(bytes) {
    let s = "", i = 0;
    while (i < bytes.length) {
      const b = bytes[i];
      let c, n;
      if (b < 0x80) { c = b; n = 1; } else if (b >> 5 === 6) { c = b & 31; n = 2; } else if (b >> 4 === 14) { c = b & 15; n = 3; } else if (b >> 3 === 30) { c = b & 7; n = 4; } else return null;
      if (i + n > bytes.length) return null;
      for (let k = 1; k < n; k += 1) { if (bytes[i + k] >> 6 !== 2) return null; c = (c << 6) | (bytes[i + k] & 63); }
      s += String.fromCodePoint(c); i += n;
    }
    return s;
  }
  static B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  static base64url(bytes) {
    const A = FabricFilterModel.B64; let s = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      s += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : "") + (i + 2 < bytes.length ? A[n & 63] : "");
    }
    return s;
  }
  static unbase64url(s) {
    if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
    const A = FabricFilterModel.B64, out = [];
    for (let i = 0; i < s.length; i += 4) {
      const c = [0, 1, 2, 3].map((k) => (i + k < s.length ? A.indexOf(s[i + k]) : -1));
      const n = (c[0] << 18) | (c[1] << 12) | (Math.max(c[2], 0) << 6) | Math.max(c[3], 0);
      out.push((n >> 16) & 255); if (c[2] >= 0) out.push((n >> 8) & 255); if (c[3] >= 0) out.push(n & 255);
    }
    return out;
  }
  // The filter= parameter for a model, or "" when there is nothing to filter.
  static encode(model) { const c = FabricFilterModel.canonical(model); return c ? FabricFilterModel.base64url(FabricFilterModel.utf8(JSON.stringify(c))) : ""; }
  // A filter= parameter back to a model: null when it isn't a well-formed v1 filter (an edited or truncated link). The schema
  // check happens later (validate with the schema's fields), and the server checks again.
  static decode(param) {
    if (typeof param !== "string" || !param || param.length > FabricFilterModel.LIMITS.maxEncoded) return null;
    const bytes = FabricFilterModel.unbase64url(param), json = bytes ? FabricFilterModel.fromUtf8(bytes) : null;
    if (json === null) return null;
    let m; try { m = JSON.parse(json); } catch { return null; }
    if (!FabricFilterModel.wellFormed(m)) return null;
    return FabricFilterModel.canonical(m);
  }
  // Shape only (keys, types, depth, limits): no field or operator lookup.
  static wellFormed(m) {
    // `range` is what the server echoes in appliedFilter (resolved dates): accepted, and dropped by canonical().
    const L = FabricFilterModel.LIMITS, CK = new Set(["field", "op", "value", "to", "values", "n", "unit", "range"]);
    if (!m || typeof m !== "object" || Array.isArray(m) || m.v !== FabricFilterModel.VERSION) return false;
    let conditions = 0, groups = 0;
    const scalar = (v) => v === null || (typeof v === "string" && v.length <= L.maxText && !FabricFilterModel.CONTROL.test(v));
    const walk = (g, depth, root) => {
      if (!g || typeof g !== "object" || Array.isArray(g) || !Array.isArray(g.items) || (g.op !== "and" && g.op !== "or") || depth > L.maxDepth) return false;
      if (Object.keys(g).some((k) => !(k === "op" || k === "items" || (root && k === "v")))) return false;
      groups += 1;
      return g.items.every((it) => {
        if (it && typeof it === "object" && Array.isArray(it.items)) return walk(it, depth + 1, false);
        if (!it || typeof it !== "object" || Array.isArray(it) || Object.keys(it).some((k) => !CK.has(k))) return false;
        conditions += 1;
        if (typeof it.field !== "string" || !FabricFilterModel.FIELD.test(it.field) || !FabricFilterModel.ARITY[it.op]) return false;
        if (it.value !== undefined && !scalar(it.value)) return false;
        if (it.to !== undefined && !scalar(it.to)) return false;
        if (it.values !== undefined && (!Array.isArray(it.values) || it.values.length > L.maxListValues || !it.values.every(scalar))) return false;
        if (it.n !== undefined && !(Number.isInteger(it.n) && it.n >= L.minN && it.n <= L.maxN)) return false;
        if (it.unit !== undefined && !FabricFilterModel.UNITS.includes(it.unit)) return false;
        return true;
      });
    };
    return walk(m, 1, true) && conditions <= L.maxConditions && groups <= L.maxGroups;
  }

  // ---- Chip text: "Quantity ≥ 10", "Company is one of A, B +3", "Posting date is in the last 7 days".
  static valueText(v) { return v === null ? "(blank)" : String(v); }
  static describe(c, labelOf = (f) => f) {
    if (!c || typeof c !== "object") return "";
    const name = labelOf(c.field) || c.field, a = FabricFilterModel.arity(c.op), short = FabricFilterModel.SHORT[c.op];
    const opText = short || FabricFilterModel.label(c.op).replace(/ \(.*\)$/, "").replace(/…$/, "");
    if (a === "none") return /^(blank|notBlank|isNull|missing|isTrue|isFalse)$/.test(c.op) ? `${name} ${FabricFilterModel.label(c.op)}` : `${name}: ${FabricFilterModel.label(c.op)}`;
    if (a === "value") return `${name} ${opText} ${FabricFilterModel.valueText(c.value)}`;
    if (a === "range") return `${name} between ${FabricFilterModel.valueText(c.value)} and ${FabricFilterModel.valueText(c.to)}`;
    if (a === "list") { const vs = Array.isArray(c.values) ? c.values : []; const shown = vs.slice(0, 3).map(FabricFilterModel.valueText).join(", "); return `${name} ${opText} ${shown}${vs.length > 3 ? ` +${vs.length - 3}` : ""}`; }
    if (a === "relative") { const n = Number(c.n), unit = n === 1 ? String(c.unit || "days").replace(/s$/, "") : c.unit; return `${name} ${c.op === "prevN" ? "in the previous" : "in the last"} ${n} ${unit}`; }
    return name;
  }
}
if (typeof window !== "undefined") window.FabricFilterModel = FabricFilterModel;
if (typeof module !== "undefined" && module.exports) module.exports = FabricFilterModel;
