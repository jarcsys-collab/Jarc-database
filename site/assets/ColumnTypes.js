// Column type registry (Column System R0), ONE description of the 15 column types JARC supports today, for the browser
// (loaded as a classic script: window.ColumnTypes) and Node (module.exports; tests and, from R1, the server). It follows the
// FormRules.js pattern. Pure: no DOM, no network, no clock, no require. It is served publicly, so nothing secret lives here.
//
// R0 rule: the registry DESCRIBES today's behaviour and changes none of it. Stored type ids, labels, option lists, value
// rules and the conversions the server accepts are reproduced exactly; tests/column-types-registry.test.js proves the parity
// with server/src/domain/board-schema.js (COLUMN_TYPES, OPTION_TYPES, isMultiColumn, checkValue), the S0-A conversion
// rules (services/board-schema-service.js assertConvertible, through the API), validation/record-values.js (Link, Email,
// Phone), both SEARCHABLE_TYPES sets, BoardModel.columnTypes and AppView's icons. No type is gained or lost.
//
//   list(ctx)                   descriptors that can be ADDED, in picker order. ctx = { relationsAvailable, filesAvailable,
//                               hasConnectColumn } (relationsAvailable false hides Connect and Mirror; the other two are
//                               optional and default to true: false hides Files / Mirror, as the Add column chooser does).
//   get(id)                     a descriptor, or null (an unknown id is never offered).
//   search(query, ctx)          list(ctx) ranked: label (exact, then prefix) > keyword / synonym > category; [] when nothing matches.
//   categories(ctx)             [{ id, label }]: essentials, more, and relations only when relationsAvailable.
//   conversionTargets(column)   the type ids "Change type" may offer: only changes the server performs (S0-A), never
//                               Connect / Mirror / Files / Group (as source or target) and never for the Item column.
//   canConvert(column, to)      the same rule for one { type, multiple } (Dropdown one ↔ several included).
//   defaultName(id, names)      "Status", "Status 2", … (case-insensitive, like BoardModel.uniqueColumnLabel).
//   validate(id, value, column) the server's write rules for one cell value → { ok, code } (descriptor.validate(value, column)).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ColumnTypes = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---- Shared constants (exactly the values used today) -------------------------------------------------------------
  // Storage order: the server's COLUMN_TYPES and BoardModel.columnTypes use this order.
  const IDS = Object.freeze(["text", "number", "status", "dropdown", "checkbox", "priority", "owner", "date", "email", "phone", "link", "group", "files", "connect", "mirror"]);
  const PRIMARY_KEY = "serial";
  const OPTION_TYPES = Object.freeze(["status", "dropdown", "priority"]);
  // Labels an EXISTING status / priority column without its own options shows (board-schema FALLBACK_OPTIONS, BoardModel.effectiveOptions).
  const FALLBACK_OPTIONS = Object.freeze({ status: Object.freeze(["New", "In Progress", "Waiting", "Completed", "Cancelled", "Review", "Defective", "Clear"]), priority: Object.freeze(["Low", "Medium", "High", "Critical"]) });
  // Labels a NEW column starts with (BoardModel.newColumnOptions).
  const NEW_OPTIONS = Object.freeze({ status: Object.freeze(["New", "In Progress", "Waiting", "Completed", "Cancelled"]), priority: Object.freeze(["Low", "Medium", "High", "Critical"]) });
  const SEARCHABLE = Object.freeze(["text", "status", "priority", "dropdown", "email", "phone", "link", "date"]);
  const LIMITS = Object.freeze({ valueLength: 10000, optionLength: 200, multiValues: 100 });
  const RECORD_REF = /^[0-9a-f]{24}$/;
  const USER_REF = /^user:[0-9a-f]{24}$/;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  // Change type never touches these, as source or target (services/board-schema-service.js assertConvertible).
  const NOT_CONVERTIBLE = Object.freeze(["connect", "mirror", "files", "group"]);

  const CATEGORIES = Object.freeze([
    Object.freeze({ id: "essentials", label: "Essentials" }),
    Object.freeze({ id: "more", label: "More" }),
    Object.freeze({ id: "relations", label: "Connect data" })
  ]);

  // ---- Icons: AppView's glyphs (svgPaths), as 16 px inline SVG in currentColor ------------------------------------------
  const PATHS = Object.freeze({
    text: '<path d="M5 6h14M12 6v13"/>',
    hash: '<path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/>',
    dropdown: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m9 11 3 3 3-3"/>',
    checkbox: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
    flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
    group: '<rect x="4" y="5" width="16" height="4" rx="1"/><rect x="4" y="15" width="16" height="4" rx="1"/>',
    paperclip: '<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'
  });
  const svg = (name) => `<svg class="icon column-type-icon" width="16" height="16" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] || PATHS.text}</svg>`;

  // ---- Link / Email / Phone value rules --------------------------------------------------------------------------------
  // A faithful copy of server/src/validation/record-values.js checkTyped (S0-A, D-S0-4), so the browser can give the same
  // answer before it saves. The server stays authoritative and re-checks every write; the parity test runs both over the
  // same corpus and fails on any difference. Do not edit one without the other.
  const LINK_SCHEMES = Object.freeze(["http", "https", "mailto", "tel"]);
  const TYPED_MAX = Object.freeze({ link: 2048, email: 254, phone: 50 });
  const TYPED = new Set(["link", "email", "phone"]);
  const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/;
  const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
  const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
  const DANGEROUS_SCHEMES = new Set(["javascript", "vbscript", "livescript", "mocha", "data", "file", "blob", "about", "filesystem", "jar", "view-source", "wyciwyg", "res", "ms-its", "mhtml", "intent", "chrome", "chrome-extension", "moz-extension", "resource", "ms-settings", "ms-appinstaller", "search-ms", "shell", "vnd.ms-office"]);
  const isDangerousScheme = (s) => DANGEROUS_SCHEMES.has(s) || s.includes("script") || s.startsWith("ms-");
  function unknownSchemeIsText(token, rest) {
    if (rest.startsWith("//")) return false;
    if (/^\d{1,5}(?:[/?#]|$)/.test(rest) || /^\s/.test(rest)) return true;
    return !/[+.-]/.test(token);
  }
  const NAMED = Object.freeze({ colon: ":", tab: "\t", newline: "\n", amp: "&", sol: "/", period: ".", lpar: "(", rpar: ")", quot: "\"", apos: "'", lt: "<", gt: ">", nbsp: " ", semi: ";", excl: "!", num: "#", percnt: "%", plus: "+", equals: "=", quest: "?", commat: "@", bsol: "\\" });
  const fromCode = (n) => (Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");
  function decodeEntities(text) {
    let out = text;
    for (let i = 0; i < 3; i += 1) {
      const next = out.replace(/&#x0*([0-9a-f]{1,6});?/gi, (_, h) => fromCode(parseInt(h, 16)))
        .replace(/&#0*([0-9]{1,7});?/g, (_, d) => fromCode(Number(d)))
        .replace(/&([a-z]{2,8});/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
      if (next === out) break;
      out = next;
    }
    return out;
  }
  function decodePercent(text) {
    let out = text;
    for (let i = 0; i < 3; i += 1) {
      const next = out.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      if (next === out) break;
      out = next;
    }
    return out;
  }
  function readings(text) {
    const forms = new Set();
    for (const base of [text, decodeEntities(text), decodePercent(text), decodePercent(decodeEntities(text)), decodeEntities(decodePercent(text))]) {
      forms.add(base);
      forms.add(base.normalize("NFKC"));
    }
    return [...forms].map((f) => f.replace(CONTROLS, "").replace(/^\s+/, ""));
  }
  function linkScheme(text) {
    let scheme = "";
    for (const reading of readings(text)) {
      const m = SCHEME.exec(reading);
      if (!m) continue;
      const s = m[1].toLowerCase();
      if (isDangerousScheme(s)) return { problem: "scheme" };
      if (!LINK_SCHEMES.includes(s)) {
        if (unknownSchemeIsText(s, reading.slice(m[0].length))) continue;
        return { problem: "scheme" };
      }
      if (reading === text) scheme = s;
      else if (!scheme) scheme = s;
    }
    return { scheme };
  }
  // { value } (normalised) or { reason } for one Link / Email / Phone value. Empty and null are always fine.
  function checkTyped(type, raw) {
    if (raw === null || raw === "") return { value: raw };
    const given = typeof raw === "number" ? String(raw) : raw;
    if (typeof given !== "string") return { reason: "type" };
    let text = given.trim();
    if (HIDDEN.test(text)) return { reason: "control-characters" };
    if (!text) return { value: "" };
    const keep = (value) => ({ value: typeof raw === "number" ? raw : value });
    if (type === "link") {
      if (text.length > TYPED_MAX.link) return { reason: "too-long" };
      const { scheme, problem: bad } = linkScheme(text);
      if (bad) return { reason: "scheme" };
      if (scheme) {
        let url;
        try { url = new URL(text); } catch { return { reason: "invalid-url" }; }
        if (!LINK_SCHEMES.includes(url.protocol.slice(0, -1))) return { reason: "scheme" };
        if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) return { reason: "invalid-url" };
      }
      return keep(text);
    }
    if (type === "email") {
      if (/^mailto:/i.test(text)) text = text.slice(7).trim();
      if (text.length > TYPED_MAX.email) return { reason: "too-long" };
      const at = text.lastIndexOf("@");
      const local = text.slice(0, at), domain = text.slice(at + 1);
      const LOCAL = /^[\p{L}\p{N}!$&'*+=^_`{|}~-][\p{L}\p{M}\p{N}!$&'*+=^_`{|}~-]*(?:\.[\p{L}\p{N}!$&'*+=^_`{|}~-][\p{L}\p{M}\p{N}!$&'*+=^_`{|}~-]*)*$/u;
      const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]{0,61}[\p{L}\p{M}\p{N}])?$/u;
      const labels = domain.split(".");
      if (at < 1 || local.length > 64 || !LOCAL.test(local) || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels.at(-1))) return { reason: "invalid-email" };
      return keep(text);
    }
    if (/^tel:/i.test(text)) text = text.slice(4).trim();
    if (text.length > TYPED_MAX.phone) return { reason: "too-long" };
    const m = /^(\+?[0-9 ().-]+?)(?:\s*(?:ext\.?|x|#|;ext=)\s*([0-9]{1,10}))?$/i.exec(text);
    const digits = m ? m[1].replace(/\D/g, "").length : 0;
    if (!m || digits < 3 || digits > 20) return { reason: "invalid-phone" };
    return keep(text);
  }

  // ---- Cell value rules for a write (server/src/domain/board-schema.js checkValue, then the Link/Email/Phone check) -------
  const isPrimitive = (v) => v === null || (["string", "number", "boolean"].includes(typeof v) && (typeof v !== "number" || Number.isFinite(v))); // validation/common.js
  const isMultiColumn = (column) => Boolean(column) && (column.type === "owner" || column.type === "connect" || (column.type === "dropdown" && column.multiple === true));
  const OK = Object.freeze({ ok: true, code: null });
  const bad = (code) => ({ ok: false, code });
  function validateValue(type, value, column = {}, { maxLength = LIMITS.valueLength } = {}) {
    const col = { ...(column || {}), type };
    if (value === null) return OK;
    if (type === "mirror") return value === "" || (Array.isArray(value) && !value.length) ? OK : bad("readOnly");
    if (type === "connect") {
      if (value === "") return OK;
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !RECORD_REF.test(v))) return bad("recordRef");
      if (new Set(value).size !== value.length) return bad("duplicate");
      if (value.length > (col.multiple ? LIMITS.multiValues : 1)) return bad("tooMany");
      return OK;
    }
    if (Array.isArray(value)) {
      if (!isMultiColumn(col)) return bad("single");
      if (value.length > LIMITS.multiValues) return bad("tooMany");
      const seen = new Set();
      for (const item of value) {
        if (typeof item !== "string" || !item.trim() || item.length > LIMITS.optionLength) return bad("list");
        if (item.startsWith("user:") && !USER_REF.test(item)) return bad("userRef");
        if (seen.has(item)) return bad("duplicate");
        seen.add(item);
      }
      return OK;
    }
    if (type === "files") return value === "" ? OK : bad("readOnly");
    if (!isPrimitive(value)) return bad("type");
    if (typeof value === "string" && value.length > maxLength) return bad("too-long");
    if (type === "checkbox") return typeof value === "boolean" ? OK : bad("type");
    if (typeof value === "boolean") return bad("type");
    if (type === "number") return typeof value === "string" && value.trim() !== "" && !Number.isFinite(Number(value)) ? bad("number") : OK;
    if (type === "date") {
      if (typeof value !== "string") return bad("date");
      if (value !== "" && (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) return bad("date");
      return OK;
    }
    if (typeof value !== "string") return bad("type");
    if (TYPED.has(type)) { const r = checkTyped(type, value); if (r.reason) return bad(r.reason); }
    return OK;
  }

  // ---- Column display settings (G3 / D12: the optional column `settings` object) -----------------------------------------
  // Display only: nothing here changes a stored value, and sorting, filters, search, CSV export and the APIs keep the raw
  // value. One allow-listed shape per type; unknown keys, wrong kinds and out-of-range values are refused (never dropped).
  // A key equal to its default is not stored, and settings with nothing left are absent (null): untouched columns never gain
  // the field. The server (domain/board-schema.js) validates every write with cleanSettings; the browser formats with it.
  const SETTINGS_MAX_JSON = 4096; // 05 §4.2: ≤ 4 KB of JSON per column (today's shapes are far smaller)
  const AFFIX_MAX = 8;
  const DATE_FORMATS = Object.freeze(["medium", "long", "iso", "dmy", "mdy"]);
  function freezeAll(o) { Object.values(o).forEach((v) => { if (v && typeof v === "object") freezeAll(v); }); return Object.freeze(o); }
  const SETTINGS_SCHEMA = freezeAll({
    number: { precision: { kind: "int", min: 0, max: 6 }, thousands: { kind: "bool", default: true }, prefix: { kind: "affix", default: "" }, suffix: { kind: "affix", default: "" }, align: { kind: "enum", values: ["right", "left"], default: "right" } },
    date: { displayFormat: { kind: "enum", values: [...DATE_FORMATS], default: "medium" }, weekday: { kind: "bool", default: false } },
    text: { wrap: { kind: "bool", default: false } },
    link: { display: { kind: "enum", values: ["url", "text"], default: "url" } }
  });
  // A plain object (from JSON, a literal or a structured clone, also from another realm): no class instances, no arrays.
  const plainObject = (v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v) || Object.prototype.toString.call(v) !== "[object Object]") return false;
    const proto = Object.getPrototypeOf(v);
    return proto === null || Object.getPrototypeOf(proto) === null;
  };
  const schemaFor = (type) => (typeof type === "string" && Object.hasOwn(SETTINGS_SCHEMA, type) ? SETTINGS_SCHEMA[type] : null);
  // { ok: true, settings: object | null } or { ok: false, message }. null / undefined / {} (or all defaults) → settings null.
  function cleanSettings(type, raw) {
    if (raw === undefined || raw === null) return { ok: true, settings: null };
    if (!plainObject(raw)) return { ok: false, message: "must be an object" };
    let size = 0;
    try { size = JSON.stringify(raw).length; } catch { return { ok: false, message: "can't be read" }; }
    if (size > SETTINGS_MAX_JSON) return { ok: false, message: "are too large" };
    const keys = Object.keys(raw);
    if (!keys.length) return { ok: true, settings: null };
    const schema = schemaFor(type);
    if (!schema) return { ok: false, message: "aren't available for this column type" };
    const out = {};
    for (const key of keys) {
      const rule = Object.hasOwn(schema, key) ? schema[key] : null;
      if (!rule) return { ok: false, message: `have an unknown setting "${String(key).slice(0, 40)}"` };
      const value = raw[key];
      if (rule.kind === "bool" && typeof value !== "boolean") return { ok: false, message: `need ${key} to be true or false` };
      if (rule.kind === "int" && (!Number.isInteger(value) || value < rule.min || value > rule.max)) return { ok: false, message: `need ${key} to be a whole number from ${rule.min} to ${rule.max}` };
      if (rule.kind === "enum" && !rule.values.includes(value)) return { ok: false, message: `need ${key} to be one of ${rule.values.join(", ")}` };
      if (rule.kind === "affix" && (typeof value !== "string" || [...value].length > AFFIX_MAX || HIDDEN.test(value) || /[<>]/.test(value))) return { ok: false, message: `need ${key} to be text of at most ${AFFIX_MAX} characters (no < or >)` };
      if (Object.hasOwn(rule, "default") && value === rule.default) continue;
      out[key] = value;
    }
    return { ok: true, settings: Object.keys(out).length ? out : null };
  }
  // The settings that still apply after a type change: keys the new type doesn't define are dropped, the rest re-checked.
  function settingsForType(type, settings) {
    const schema = schemaFor(type);
    if (!schema || !plainObject(settings)) return null;
    const r = cleanSettings(type, Object.fromEntries(Object.entries(settings).filter(([k]) => Object.hasOwn(schema, k))));
    return r.ok ? r.settings : null;
  }
  const settingsOf = (column) => (column && plainObject(column.settings) ? column.settings : null);

  // Formatting (pure; display text only). Each returns null when the column has no setting that changes the display, so
  // the caller keeps today's rendering exactly.
  const NUMBER_FORMATS = new Map();
  function numberFormatter(precision, grouping) {
    const key = `${precision ?? "a"}|${grouping}`;
    if (!NUMBER_FORMATS.has(key)) NUMBER_FORMATS.set(key, new Intl.NumberFormat(undefined, { minimumFractionDigits: precision ?? 0, maximumFractionDigits: precision ?? 10, useGrouping: grouping }));
    return NUMBER_FORMATS.get(key);
  }
  function formatNumber(value, column) {
    const s = settingsOf(column);
    if (!s) return null;
    const text = String(value ?? "");
    const n = Number(value);
    if (text.trim() === "" || !Number.isFinite(n)) return text;
    const body = numberFormatter(s.precision, s.thousands !== false).format(Math.abs(n));
    const negative = n < 0 && /[1-9]/.test(body);
    return `${negative ? "-" : ""}${s.prefix || ""}${body}${s.suffix || ""}`;
  }
  const MONTHS = Object.freeze(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]);
  const WEEKDAYS = Object.freeze(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
  function formatDate(value, column) {
    const s = settingsOf(column);
    if (!s) return null;
    const text = String(value ?? "");
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.slice(0, 10));
    if (!m) return text;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const at = new Date(Date.UTC(y, mo - 1, d));
    if (Number.isNaN(at.getTime()) || at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return text;
    const format = s.displayFormat || "medium";
    const out = format === "iso" ? `${m[1]}-${m[2]}-${m[3]}`
      : format === "dmy" ? `${m[3]}/${m[2]}/${m[1]}`
        : format === "mdy" ? `${m[2]}/${m[3]}/${m[1]}`
          : format === "long" ? `${MONTHS[mo - 1]} ${d}, ${y}`
            : `${MONTHS[mo - 1].slice(0, 3)} ${d}, ${y}`;
    if (!s.weekday) return out;
    const day = WEEKDAYS[at.getUTCDay()];
    return `${format === "long" ? day : day.slice(0, 3)}, ${out}`;
  }
  // A link shown as text: the address without its scheme, a leading "www." or a trailing "/". The link it opens is unchanged.
  function formatLink(value, column) {
    const s = settingsOf(column);
    if (!s || s.display !== "text") return null;
    const text = String(value ?? "").trim();
    return text.replace(/^(?:https?:\/\/|mailto:|tel:)/i, "").replace(/^www\./i, "").replace(/\/$/, "") || text;
  }
  // The display text of one cell, or null for today's rendering (no settings, or none that applies to this type).
  function displayText(column, value) {
    if (!settingsOf(column)) return null;
    if (column.type === "number") return formatNumber(value, column);
    if (column.type === "date") return formatDate(value, column);
    if (column.type === "link") return formatLink(value, column);
    return null;
  }
  // Presentation of the cell (not its text): { align: "left" | null, wrap }.
  function cellLayout(column) {
    const s = settingsOf(column) || {};
    return { align: column?.type === "number" && s.align === "left" ? "left" : null, wrap: column?.type === "text" && s.wrap === true };
  }

  // ---- The 15 types ------------------------------------------------------------------------------------------------------
  // legacyCategory: the group shown by today's Add column chooser (BoardModel.columnTypes). category: the picker's group.
  // renderer / editor: the AppView methods that draw and edit the cell today (referenced, not reimplemented).
  // settings: the settings panels the type supports among labels / options / default / numberFormat / dateFormat /
  // textFormat (the last three edit the column's display `settings`, settingsSchema below).
  // requires: what must be available for the type to be added ("relations": the Connect switch; "files": attachment
  // storage; "connectColumn": a Connect column on the board).
  const ALL_ACTIONS = { changeType: true, settings: true, sort: true, filter: true, group: false, duplicate: true };
  const DEFS = [
    { id: "text", label: "Text", iconName: "text", category: "essentials", legacyCategory: "Basic", description: "Names, notes and short values", keywords: ["notes", "description", "words", "name"], renderer: "cellDisplay", editor: "cellInput", inputType: "text", settings: ["default", "textFormat"] },
    { id: "number", label: "Number", iconName: "hash", category: "essentials", legacyCategory: "Basic", description: "Quantities, amounts and scores", keywords: ["amount", "price", "qty", "quantity", "count", "cost", "total"], renderer: "number", editor: "cellInput", inputType: "number", settings: ["default", "numberFormat"] },
    { id: "status", label: "Status", iconName: "tag", category: "essentials", legacyCategory: "Selection", description: "Track progress with labelled stages", keywords: ["state", "stage", "progress", "phase"], renderer: "cellLabel", editor: "showCellOptions", settings: ["labels"], actions: { group: true } },
    { id: "dropdown", label: "Dropdown", iconName: "dropdown", category: "more", legacyCategory: "Selection", description: "Pick one or several values from your own list", keywords: ["select", "tags", "options", "category", "choice", "list"], renderer: "cellLabel", editor: "showCellOptions", settings: ["options"], actions: { group: true } },
    { id: "checkbox", label: "Checkbox", iconName: "checkbox", category: "more", legacyCategory: "Selection", description: "Yes or no, done or not done", keywords: ["done", "tick", "boolean", "yes", "no", "check"], renderer: "cellDisplay", editor: "toggle", settings: [], actions: { group: true } },
    { id: "priority", label: "Priority", iconName: "flag", category: "more", legacyCategory: "Selection", description: "Low, medium, high or critical", keywords: ["urgency", "importance", "severity"], renderer: "cellLabel", editor: "showCellOptions", settings: ["labels"], actions: { group: true } },
    { id: "owner", label: "People", iconName: "user", category: "essentials", legacyCategory: "People", description: "Assign one or more colleagues", keywords: ["person", "owner", "assignee", "assign", "who", "people"], renderer: "people", editor: "showCellOptions", settings: [], actions: { group: true } },
    { id: "date", label: "Date", iconName: "calendar", category: "essentials", legacyCategory: "Dates", description: "Deadlines, milestones and events", keywords: ["deadline", "due", "calendar", "when", "day"], renderer: "date", editor: "cellInput", inputType: "date", settings: ["default", "dateFormat"] },
    { id: "email", label: "Email", iconName: "mail", category: "more", legacyCategory: "Contact", description: "Email addresses", keywords: ["mail", "e-mail", "address"], renderer: "cellDisplay", editor: "cellInput", inputType: "email", settings: ["default"] },
    { id: "phone", label: "Phone", iconName: "phone", category: "more", legacyCategory: "Contact", description: "Phone numbers", keywords: ["tel", "mobile", "telephone", "cell"], renderer: "cellDisplay", editor: "cellInput", inputType: "tel", settings: ["default"] },
    { id: "link", label: "Link", iconName: "link", category: "more", legacyCategory: "Contact", description: "Web addresses", keywords: ["url", "website", "web", "hyperlink"], renderer: "cellDisplay", editor: "cellInput", inputType: "url", settings: ["default", "textFormat"] },
    { id: "group", label: "Group", iconName: "group", category: "more", legacyCategory: "Organization", description: "Sort records into this board's groups", keywords: ["section", "bucket"], renderer: "pill", editor: "showCellOptions", settings: ["default"], actions: { changeType: false } },
    { id: "files", label: "Files", iconName: "paperclip", category: "more", legacyCategory: "Files", description: "PDFs and photos (JPEG, PNG, WebP), up to 10 MB each", keywords: ["attachment", "upload", "document", "pdf", "photo", "image"], renderer: "filesCell", editor: "showFilesPanel", settings: [], requires: "files", actions: { changeType: false, filter: false } },
    { id: "connect", label: "Connect boards", iconName: "link", category: "relations", legacyCategory: "Boards", description: "Link records of another board (nothing is copied)", keywords: ["relation", "related", "lookup", "board", "linked"], renderer: "relationDisplay", editor: "showConnectPicker", settings: [], requires: "relations", needsSetup: true, actions: { changeType: false } },
    { id: "mirror", label: "Mirror", iconName: "copy", category: "relations", legacyCategory: "Boards", description: "Show a column of the linked records, read-only", keywords: ["lookup", "related", "reference", "linked"], renderer: "relationDisplay", editor: null, settings: [], requires: "connectColumn", needsSetup: true, readOnly: true, actions: { changeType: false } }
  ];
  // Picker order: essentials as the design lists them, then more, then the relations.
  const PICKER_ORDER = Object.freeze(["status", "owner", "date", "number", "text", "checkbox", "dropdown", "priority", "email", "phone", "link", "files", "group", "connect", "mirror"]);

  const freezeDeep = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === "object" && !Object.isFrozen(v)) freezeDeep(v); }); return Object.freeze(o); };
  const BY_ID = new Map();
  for (const d of DEFS) {
    const id = d.id;
    const descriptor = {
      id, label: d.label, icon: svg(d.iconName), iconName: d.iconName, category: d.category, legacyCategory: d.legacyCategory,
      keywords: d.keywords, description: d.description,
      // Arguments for today's create call, BoardModel.addColumn (the Add column form sends exactly these; the adapter then
      // POSTs /boards/:id/columns { column, index }). options "" = the type's starting labels. Connect / Mirror also need
      // extra.link = { boardId } or extra.mirror = { via, column, show } (needsSetup), otherwise addColumn refuses them.
      createPayload(name, extra = {}) {
        const out = { label: String(name ?? "").trim(), type: id, options: "" };
        if (id === "dropdown" || id === "connect") out.multiple = extra.multiple === true || (id === "connect" && extra.multiple !== false);
        if (id === "connect") out.link = extra.link ? { boardId: String(extra.link.boardId) } : null;
        if (id === "mirror") out.mirror = extra.mirror ? { via: extra.mirror.via, column: extra.mirror.column, show: extra.mirror.show || "list" } : null;
        return out;
      },
      // The value a new record gets in an empty column of this type (BoardModel.addColumn / normalizeRecord).
      defaultValue: id === "checkbox" ? false : id === "owner" || id === "connect" ? [] : "",
      options: OPTION_TYPES.includes(id),
      fallbackOptions: FALLBACK_OPTIONS[id] || Object.freeze([]),
      newOptions: NEW_OPTIONS[id] || Object.freeze([]),
      multi: id === "owner" || id === "connect" ? "always" : id === "dropdown" ? "optional" : "never",
      searchable: SEARCHABLE.includes(id),
      settings: d.settings,
      // The allow-listed display settings of this type ({ key: { kind, min, max, values, default } }), or null.
      settingsSchema: schemaFor(id),
      actions: { ...ALL_ACTIONS, ...(d.actions || {}) },
      renderer: d.renderer, editor: d.editor, inputType: d.inputType || null,
      requires: d.requires || null, needsSetup: Boolean(d.needsSetup), readOnly: Boolean(d.readOnly),
      validate(value, column) { return validateValue(id, value, column); }
    };
    BY_ID.set(id, freezeDeep(descriptor));
  }

  const ctxOf = (ctx) => ({ relationsAvailable: Boolean(ctx?.relationsAvailable), filesAvailable: ctx?.filesAvailable !== false, hasConnectColumn: ctx?.hasConnectColumn !== false });
  const offered = (d, c) => d.requires === "relations" ? c.relationsAvailable
    : d.requires === "connectColumn" ? c.relationsAvailable && c.hasConnectColumn
    : d.requires === "files" ? c.filesAvailable : true;

  function get(id) { return typeof id === "string" && BY_ID.has(id) ? BY_ID.get(id) : null; }
  function ids() { return [...IDS]; }
  function list(ctx) { const c = ctxOf(ctx); return PICKER_ORDER.map((id) => BY_ID.get(id)).filter((d) => offered(d, c)); }
  function categories(ctx) { const c = ctxOf(ctx); return CATEGORIES.filter((cat) => cat.id !== "relations" || c.relationsAvailable).map((cat) => ({ ...cat })); }

  // Local search, no network: words of the query against the label, the keywords (synonyms) and the category.
  const words = (s) => String(s ?? "").toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  function search(query, ctx) {
    const q = words(query), all = list(ctx);
    if (!q.length) return all;
    const catLabel = new Map(CATEGORIES.map((c) => [c.id, c.label.toLowerCase()]));
    const scored = all.map((d, order) => {
      const label = d.label.toLowerCase(), labelWords = words(d.label), cat = words(catLabel.get(d.category));
      let score = 0;
      for (const w of q) {
        let best = 0;
        if (label === q.join(" ") || labelWords.includes(w)) best = 40;
        else if (labelWords.some((lw) => lw.startsWith(w))) best = 30;
        else if (d.keywords.some((k) => k === w)) best = 20;
        else if (d.keywords.some((k) => k.startsWith(w)) || d.id.startsWith(w)) best = 15;
        else if (cat.some((cw) => cw.startsWith(w))) best = 5;
        score += best;
      }
      return { d, score, order };
    }).filter((s) => s.score > 0);
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    return scored.map((s) => s.d);
  }

  // Change type (S0-A): only what the server performs. Connect / Mirror / Files / Group never convert; the Item column never
  // changes type; a Dropdown may switch between one and several values (same type id, different multiple). Whether every
  // VALUE fits is decided by the server's dry run over the whole board (People with values are refused there, D-S0-3).
  function canConvert(column, to) {
    if (!column || !to || !get(column.type) || !get(to.type)) return false;
    if (column.key === PRIMARY_KEY) return false;
    if (NOT_CONVERTIBLE.includes(column.type) || NOT_CONVERTIBLE.includes(to.type)) return false;
    if (to.multiple && to.type !== "dropdown") return false;
    const modeChange = to.type === "dropdown" && column.type === "dropdown" && Boolean(to.multiple) !== Boolean(column.multiple);
    return column.type !== to.type || modeChange;
  }
  // The other type ids offered (the same-type Dropdown mode switch is its own menu item, BoardModel.setColumnMultiple).
  function conversionTargets(column) {
    if (!column || !get(column.type)) return [];
    return PICKER_ORDER.filter((id) => id !== column.type && canConvert(column, { type: id, multiple: false }));
  }
  // The actions one column offers (descriptor.actions with the column's own rules: the Item column can't change type or be
  // duplicated; a several-value Dropdown can't be grouped by).
  function columnActions(column) {
    const d = get(column?.type);
    if (!d) return null;
    const primary = column.key === PRIMARY_KEY;
    return { ...d.actions, changeType: d.actions.changeType && conversionTargets(column).length > 0, duplicate: d.actions.duplicate && !primary, group: d.actions.group && !(column.type === "dropdown" && column.multiple === true) };
  }
  function defaultName(id, existingNames = []) {
    const base = get(id)?.label || "Column";
    const used = new Set([...(existingNames || [])].map((n) => String(n).toLowerCase()));
    let name = base, n = 2;
    while (used.has(name.toLowerCase())) name = `${base} ${n++}`;
    return name;
  }
  // Today's Add column chooser entries (BoardModel.columnTypes): storage order, legacy categories.
  function chooserEntries() { return IDS.map((id) => { const d = BY_ID.get(id); return { type: id, label: d.label, category: d.legacyCategory, description: d.description }; }); }
  const newOptions = (type) => [...(NEW_OPTIONS[type] || [])];
  const fallbackOptions = (type) => [...(FALLBACK_OPTIONS[type] || [])];
  const validate = (type, value, column) => (get(type) ? validateValue(type, value, column) : bad("unsupported"));

  return Object.freeze({
    IDS, PRIMARY_KEY, OPTION_TYPES, FALLBACK_OPTIONS, NEW_OPTIONS, SEARCHABLE, LIMITS, CATEGORIES, PICKER_ORDER, LINK_SCHEMES, TYPED_MAX,
    ids, get, list, search, categories, conversionTargets, canConvert, columnActions, defaultName, chooserEntries, newOptions, fallbackOptions,
    isMultiColumn, validate, checkTyped, iconSvg: svg,
    SETTINGS_SCHEMA, SETTINGS_MAX_JSON, DATE_FORMATS, cleanSettings, settingsForType, displayText, cellLayout, formatNumber, formatDate, formatLink
  });
});
