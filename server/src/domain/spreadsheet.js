// Reads an uploaded CSV or XLSX into rows of text, without any third-party parser. An upload is untrusted, so everything
// here has a hard limit: inflated size (enforced while inflating, not taken from the file's own claim), rows, columns and
// cell length. XML is only ever read as text with a fixed set of patterns: DOCTYPE is refused, and no entity, external
// reference, macro or formula is ever evaluated (a formula's last saved result is what gets imported).
//
//   parseSpreadsheet(buffer, { name, sheet }) → { kind, sheets, sheet, headers, rows: [{ line, cells: [text] }], encoding }
const zlib = require("zlib");
const { ApiError } = require("../middleware/errors");

const LIMITS = Object.freeze({ fileBytes: 25 * 1024 * 1024, inflatedEntry: 256 * 1024 * 1024, rows: 100000, columns: 200, cellLength: 10000, textBytes: 64 * 1024 * 1024 });
const refuse = (message) => { throw new ApiError(422, "IMPORT_UNREADABLE", message); };

// ---- CSV
function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(buffer.subarray(2)), encoding: "utf-16le" };
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(buffer.subarray(2)), encoding: "utf-16be" };
  const start = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(start)), encoding: "utf-8" }; }
  catch { return { text: new TextDecoder("windows-1252").decode(buffer), encoding: "windows-1252" }; } // what Excel's plain "CSV" saves
}
// The delimiter used most on the first line, outside quotes.
function delimiterOf(text) {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < text.length && i < 65536; i += 1) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && counts[ch] !== undefined) counts[ch] += 1;
  }
  return Object.keys(counts).reduce((best, d) => (counts[d] > counts[best] ? d : best), ",");
}
function parseCsv(buffer) {
  const { text, encoding } = decodeText(buffer);
  const delimiter = delimiterOf(text), rows = [];
  let cells = [], cell = "", quoted = false, line = 1, rowLine = 1;
  const endCell = () => { if (cell.length > LIMITS.cellLength) refuse(`Line ${rowLine} has a value longer than ${LIMITS.cellLength.toLocaleString("en-US")} characters.`); cells.push(cell); cell = ""; if (cells.length > LIMITS.columns) refuse(`Line ${rowLine} has more than ${LIMITS.columns} columns.`); };
  const endRow = () => { endCell(); if (cells.some((c) => c.trim())) { if (rows.length >= LIMITS.rows + 1) refuse(`This file has more than ${LIMITS.rows.toLocaleString("en-US")} rows.`); rows.push({ line: rowLine, cells }); } cells = []; rowLine = line; };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; }
      else { if (ch === "\n") line += 1; cell += ch; }
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i += 1; line += 1; endRow(); }
    else cell += ch;
  }
  if (quoted) refuse(`A quoted value starting near line ${rowLine} never ends.`);
  if (cell || cells.length) endRow();
  return { kind: "csv", encoding, sheets: [], sheet: null, table: rows };
}

// ---- XLSX: a ZIP of XML. Only the entries needed are inflated, each with a hard limit on its real size.
function zipEntries(buffer) {
  const lowest = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= lowest; i -= 1) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) refuse("This file isn't a readable Excel workbook.");
  const count = buffer.readUInt16LE(eocd + 10), offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) refuse("This workbook is too large to read. Save a smaller copy.");
  const entries = new Map();
  let at = offset;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) refuse("This file isn't a readable Excel workbook.");
    const flags = buffer.readUInt16LE(at + 8), method = buffer.readUInt16LE(at + 10), compressed = buffer.readUInt32LE(at + 20), nameLen = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32), local = buffer.readUInt32LE(at + 42);
    entries.set(buffer.toString("utf8", at + 46, at + 46 + nameLen).replace(/\\/g, "/"), { flags, method, compressed, local });
    at += 46 + nameLen + extra + comment;
  }
  return entries;
}
function readEntry(buffer, entries, name, required = true) {
  const e = entries.get(name);
  if (!e) { if (required) refuse("This file isn't a readable Excel workbook."); return null; }
  if (e.flags & 1) refuse("This workbook is password protected. Remove the password and try again.");
  if (e.local + 30 > buffer.length || buffer.readUInt32LE(e.local) !== 0x04034b50) refuse("This file isn't a readable Excel workbook.");
  const start = e.local + 30 + buffer.readUInt16LE(e.local + 26) + buffer.readUInt16LE(e.local + 28), data = buffer.subarray(start, start + e.compressed);
  let out;
  if (e.method === 0) out = data;
  else if (e.method === 8) {
    try { out = zlib.inflateRawSync(data, { maxOutputLength: LIMITS.inflatedEntry }); }
    catch (error) { refuse(error?.code === "ERR_BUFFER_TOO_LARGE" ? "This workbook expands to too much data. Save a smaller copy." : "This file isn't a readable Excel workbook."); }
  } else refuse("This workbook uses a compression that can't be read.");
  if (out.length > LIMITS.inflatedEntry) refuse("This workbook expands to too much data. Save a smaller copy.");
  const text = out.toString("utf8");
  if (/<!DOCTYPE/i.test(text.slice(0, 4096))) refuse("This workbook contains something that can't be read safely.");
  return text;
}
const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unescapeXml = (s) => s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g, (m, d, h, n) => { if (n) return ENTITIES[n]; const code = d ? Number(d) : parseInt(h, 16); return code <= 0x10ffff ? String.fromCodePoint(code) : m; });
const attrOf = (attrs, name) => { const m = new RegExp(`(?:^|\\s)(?:\\w+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs); return m ? (m[1] ?? m[2]) : undefined; };
const textRuns = (xml) => [...xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "").matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)].map((m) => unescapeXml(m[1] ?? "")).join("");
const columnIndex = (ref) => { const m = /^([A-Za-z]+)/.exec(ref || ""); if (!m) return null; let n = 0; for (const c of m[1].toUpperCase()) n = n * 26 + c.charCodeAt(0) - 64; return n - 1; };

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const isDateCode = (code) => /[ymdh]/i.test(code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "").replace(/general/i, ""));
function dateStyles(xml) {
  const custom = new Map(), styles = [];
  if (!xml) return styles;
  for (const m of xml.matchAll(/<(?:\w+:)?numFmt\b([^>]*)\/?>/g)) custom.set(Number(attrOf(m[1], "numFmtId")), unescapeXml(attrOf(m[1], "formatCode") || ""));
  const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml);
  if (xfs) for (const m of xfs[1].matchAll(/<(?:\w+:)?xf\b([^>]*?)\/?>/g)) { const id = Number(attrOf(m[1], "numFmtId") || 0); styles.push(BUILTIN_DATE.has(id) || (custom.has(id) && isDateCode(custom.get(id)))); }
  return styles;
}
function serialDate(serial, date1904) {
  const ms = Math.round((serial + (date1904 ? 1462 : 0)) * 86400000) + Date.UTC(1899, 11, 30);
  if (!Number.isFinite(ms) || serial < 0 || ms > 8.64e15) return String(serial);
  const iso = new Date(ms).toISOString();
  return iso.slice(11, 19) === "00:00:00" ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
function parseXlsx(buffer, { sheet: wanted } = {}) {
  const entries = zipEntries(buffer);
  const workbook = readEntry(buffer, entries, "xl/workbook.xml"), rels = readEntry(buffer, entries, "xl/_rels/workbook.xml.rels");
  const targets = new Map([...rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)].map((m) => [attrOf(m[1], "Id"), attrOf(m[1], "Target")]));
  const sheets = [...workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)].map((m) => ({ name: unescapeXml(attrOf(m[1], "name") || ""), hidden: Boolean(attrOf(m[1], "state")) && attrOf(m[1], "state") !== "visible", target: targets.get(attrOf(m[1], "id")) }));
  const visible = sheets.filter((s) => !s.hidden);
  if (!visible.length) refuse("This workbook has no worksheets to import.");
  const chosen = wanted ? visible.find((s) => s.name === wanted) : visible[0];
  if (!chosen) refuse("That worksheet isn't in this workbook.");
  if (!chosen.target) refuse("This file isn't a readable Excel workbook.");
  const path = chosen.target.startsWith("/") ? chosen.target.slice(1) : `xl/${chosen.target}`;
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*date1904\s*=\s*["'](?:1|true)["']/.test(workbook);
  const sharedXml = readEntry(buffer, entries, "xl/sharedStrings.xml", false);
  const shared = sharedXml ? [...sharedXml.matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)].map((m) => textRuns(m[1] ?? "")) : [];
  const styles = dateStyles(readEntry(buffer, entries, "xl/styles.xml", false));
  const xml = readEntry(buffer, entries, path);
  const table = [];
  let auto = 0;
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    auto += 1;
    const line = Number(attrOf(rowMatch[1], "r")) || auto;
    auto = line;
    if (!rowMatch[2]) continue;
    const cells = [];
    let next = 0;
    for (const cellMatch of rowMatch[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = cellMatch[1], body = cellMatch[2] ?? "", at = columnIndex(attrOf(attrs, "r")) ?? next;
      next = at + 1;
      if (at >= LIMITS.columns) refuse(`Row ${line} has more than ${LIMITS.columns} columns.`);
      const type = attrOf(attrs, "t") || "n", raw = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
      let value = "";
      if (type === "inlineStr") value = textRuns(body);
      else if (raw === undefined) value = "";
      else if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "str" || type === "d") value = unescapeXml(raw);
      else if (type === "b") value = raw === "1" ? "true" : "false";
      else if (type === "e") value = "";
      else value = styles[Number(attrOf(attrs, "s") || 0)] && Number.isFinite(Number(raw)) ? serialDate(Number(raw), date1904) : raw;
      if (value.length > LIMITS.cellLength) refuse(`Row ${line} has a value longer than ${LIMITS.cellLength.toLocaleString("en-US")} characters.`);
      cells[at] = value;
    }
    for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = "";
    if (!cells.some((c) => c.trim())) continue;
    if (table.length >= LIMITS.rows + 1) refuse(`This worksheet has more than ${LIMITS.rows.toLocaleString("en-US")} rows.`);
    table.push({ line, cells });
  }
  return { kind: "xlsx", encoding: null, sheets: visible.map((s) => s.name), sheet: chosen.name, table };
}

function parseSpreadsheet(buffer, { name = "", sheet } = {}) {
  if (!buffer?.length) refuse("This file is empty.");
  if (buffer.length > LIMITS.fileBytes) refuse("This file is larger than 25 MB.");
  let parsed;
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) parsed = parseXlsx(buffer, { sheet });
  else if (buffer[0] === 0xd0 && buffer[1] === 0xcf) refuse("This is an older .xls file, or a password-protected workbook. In Excel, save it as .xlsx without a password and try again.");
  else if (/\.(xlsx|xlsm|xls)$/i.test(name)) refuse("This file isn't a readable Excel workbook.");
  else if (buffer.subarray(0, 4096).includes(0) && !(buffer[0] === 0xff && buffer[1] === 0xfe) && !(buffer[0] === 0xfe && buffer[1] === 0xff)) refuse("This doesn't look like a CSV or Excel file.");
  else parsed = parseCsv(buffer);
  const { table, ...rest } = parsed;
  if (!table.length) refuse("This file has no rows.");
  const width = Math.min(LIMITS.columns, Math.max(...table.slice(0, 1).map((r) => r.cells.length)));
  const headers = table[0].cells.slice(0, width).map((h, i) => h.trim().slice(0, 200) || `Column ${i + 1}`);
  const rows = table.slice(1);
  if (rows.length > LIMITS.rows) refuse(`This file has more than ${LIMITS.rows.toLocaleString("en-US")} rows.`);
  return { ...rest, headers, rows };
}

module.exports = { parseSpreadsheet, LIMITS };
