// Link, Email and Phone cell values (Column System S0-A, D-S0-4). Server-side rules for NEW writes into columns of those
// types; text and every other column type are never checked here.
//
//   link   http:, https:, mailto: or tel: URLs, or text with no scheme at all ("www.example.com", "see the shared drive"),
//          stored exactly as typed (trimmed). Any other scheme is refused: javascript:, data:, vbscript:, file:, blob:,
//          about:, and also when hidden by case, leading spaces or control characters, tabs or new lines inside it, HTML
//          entities (&#106; &colon; &Tab;), percent-encoding (%6A, %3A) or full-width letters. Control and invisible
//          characters (C0, DEL, C1, zero-width, bidirectional marks) are refused anywhere. At most 2,048 characters, the limit
//          of the frontend's safeHref (site/assets/AppView.js), which also opens only http, https, mailto and tel.
//          mailto: and tel: stay allowed in Link columns (10-SECURITY MUST 20 and safeHref): neither runs code.
//   email  one address, RFC-lite: local@domain.tld, no spaces, quotes, brackets, "?", "#", "%" or "/" (they would change a
//          mailto: link). An optional "mailto:" prefix is removed. At most 254 characters.
//   phone  digits, a leading "+", spaces, ( ) - . and an optional extension ("x 12", "ext. 12", "#12", ";ext=12"); 3 to 20
//          digits. An optional "tel:" prefix is removed. At most 50 characters.
//
// Values already stored are never rewritten or deleted (production has none of these columns today). They stay readable;
// unsafeValueKeys() flags them, and saving one again (even unchanged) is refused, so it must be replaced. Errors are
// 400 VALIDATION_ERROR with details { field, reason }; the value itself is never put in a message, the details or a log.
// ApiError is required only when a write is refused, so this module stays light for worker threads and the migration engine.

const LINK_SCHEMES = Object.freeze(["http", "https", "mailto", "tel"]);
const MAX = Object.freeze({ link: 2048, email: 254, phone: 50 });
const TYPES = new Set(["link", "email", "phone"]);

// C0 controls (tab and new line included), DEL, C1 controls; zero-width, word-joiner, bidirectional and BOM characters.
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
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
// Every reading of the text a browser, a spreadsheet or an integration might make, reduced the way URL parsers reduce a
// scheme: control characters dropped (browsers drop tabs and new lines anywhere), leading spaces trimmed.
function readings(text) {
  const forms = new Set();
  for (const base of [text, decodeEntities(text), decodePercent(text), decodePercent(decodeEntities(text)), decodeEntities(decodePercent(text))]) {
    forms.add(base);
    forms.add(base.normalize("NFKC"));
  }
  return [...forms].map((f) => f.replace(CONTROLS, "").replace(/^\s+/, ""));
}

// The scheme of a Link value ("" when it has none), or { problem } when any reading of it names a scheme that isn't allowed.
function linkScheme(text) {
  let scheme = "";
  for (const reading of readings(text)) {
    const m = SCHEME.exec(reading);
    if (!m) continue;
    const s = m[1].toLowerCase();
    if (!LINK_SCHEMES.includes(s)) return { problem: "scheme" };
    if (reading === text) scheme = s;
    else if (!scheme) scheme = s; // an allowed scheme only seen once decoded: checked as a URL below
  }
  return { scheme };
}

const problem = (reason, message) => ({ reason, message });
const asText = (value) => (typeof value === "number" ? String(value) : value);

// { value } (normalised) or { reason, message } for one Link / Email / Phone value. Empty and null are always fine.
function checkTyped(type, raw) {
  if (raw === null || raw === "") return { value: raw };
  const given = asText(raw);
  if (typeof given !== "string") return problem("type", "must be text");
  // Surrounding spaces and line breaks (a paste) are trimmed; any other control or invisible character is refused.
  let text = given.trim();
  if (HIDDEN.test(text)) return problem("control-characters", "contains control or invisible characters");
  if (!text) return { value: "" };
  const keep = (value) => ({ value: typeof raw === "number" ? raw : value }); // a number stays a number
  if (type === "link") {
    if (text.length > MAX.link) return problem("too-long", `must be at most ${MAX.link} characters`);
    const { scheme, problem: bad } = linkScheme(text);
    if (bad) return problem("scheme", "must be an http:// or https:// link (mailto: and tel: are also allowed), or text without a scheme");
    if (scheme) {
      let url;
      try { url = new URL(text); } catch { return problem("invalid-url", "isn't a valid link"); }
      if (!LINK_SCHEMES.includes(url.protocol.slice(0, -1))) return problem("scheme", "must be an http:// or https:// link (mailto: and tel: are also allowed), or text without a scheme");
      if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) return problem("invalid-url", "isn't a valid link");
    }
    return keep(text);
  }
  if (type === "email") {
    if (/^mailto:/i.test(text)) text = text.slice(7).trim();
    if (text.length > MAX.email) return problem("too-long", `must be at most ${MAX.email} characters`);
    const at = text.lastIndexOf("@");
    const local = text.slice(0, at), domain = text.slice(at + 1);
    const LOCAL = /^[\p{L}\p{N}!$&'*+=^_`{|}~-]+(?:\.[\p{L}\p{N}!$&'*+=^_`{|}~-]+)*$/u;
    const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
    const labels = domain.split(".");
    if (at < 1 || local.length > 64 || !LOCAL.test(local) || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels.at(-1))) return problem("invalid-email", "must be one email address, such as name@example.com");
    return keep(text);
  }
  // phone
  if (/^tel:/i.test(text)) text = text.slice(4).trim();
  if (text.length > MAX.phone) return problem("too-long", `must be at most ${MAX.phone} characters`);
  const m = /^(\+?[0-9 ().-]+?)(?:\s*(?:ext\.?|x|#|;ext=)\s*([0-9]{1,10}))?$/i.exec(text);
  const digits = m ? m[1].replace(/\D/g, "").length : 0;
  if (!m || digits < 3 || digits > 20) return problem("invalid-phone", "must be a phone number: digits, +, spaces, ( ) - . and an optional extension");
  return keep(text);
}

// For a write: the value to store, or a 400 naming the column (never echoing the value). Other column types: unchanged.
function typedValue(column, value) {
  if (!column || !TYPES.has(column.type)) return value;
  const out = checkTyped(column.type, value);
  if (out.reason) throw new (require("../middleware/errors").ApiError)(400, "VALIDATION_ERROR", `The value for "${String(column.label || column.key).slice(0, 60)}" ${out.message}.`, { field: column.key, reason: out.reason });
  return out.value;
}

// Is a stored value one that new writes would refuse? (Read-side flag; never changes the value.)
const isUnsafeValue = (column, value) => Boolean(column && TYPES.has(column.type) && checkTyped(column.type, value).reason);
// The keys of a record's Link / Email / Phone cells that would be refused today.
function unsafeValueKeys(board, values) {
  if (!board?.columns || !values) return [];
  return board.columns.filter((c) => TYPES.has(c.type) && Object.hasOwn(values, c.key) && isUnsafeValue(c, values[c.key])).map((c) => c.key);
}

module.exports = { typedValue, checkTyped, isUnsafeValue, unsafeValueKeys, LINK_SCHEMES, MAX, TYPED_VALUE_TYPES: TYPES };
