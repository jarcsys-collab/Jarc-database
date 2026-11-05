// Works out what the rows of a spreadsheet are, so a monday.com export can become a new board: which row holds the column
// names, which rows are group headings, and which are repeated headers, sub-items and totals rather than records. Pure, with
// no database, so it can run on a worker thread. When the file doesn't make it clear, it says so and a person decides.
//
//   analyzeTable(table, choices) → the structure, with reasons when it needs confirming
//   validateTable(table, structure, settings, notes) → totals, every problem and warning, and a preview
//   convertCell(type, raw, { dateOrder }) → { value } or { error }; text is kept exactly as written
const ITEM_NAMES = /^(name|item|item name)$/i;
const SUBITEM_HEADER = /^sub-?items?$/i;
const SCAN_ROWS = 30; // the header is looked for this far down
const MAX_CANDIDATES = 12;
const MAX_ERRORS = 2000; // kept for the report; the count is always exact
const PREVIEW_ROWS = 10;
const LIMITS = Object.freeze({ columns: 200, groups: 200, skipLines: 20000 });
const DEFAULT_GROUP = "Imported records";
// Columns monday.com fills from things a workbook only holds as text.
const TEXT_ONLY_COLUMNS = [
  [/^sub-?items?$/i, "subitems", "Sub-items"], [/files?|attachments?|documents?/i, "attachments", "Files"], [/^(item )?updates?$|^last updated$/i, "updates", "Updates"],
  [/mirror|connect|link(ed)? to|relation|dependen/i, "relationships", "Connected or mirrored columns"], [/formula/i, "formulas", "Formula columns"]
];

const clean = (v) => String(v ?? "").trim();
const filledAt = (cells) => { const out = []; for (let i = 0; i < cells.length; i += 1) if (clean(cells[i])) out.push(i); return out; };
// What a monday.com group summary holds: sums, date ranges, single dates, "3/10" style progress, percentages, and the word null for a mirror column.
const SUMMARY_VALUE = /^(?:[-+]?[\d.,]+%?|\d{4}-\d{2}-\d{2}(?: to \d{4}-\d{2}-\d{2})?|\d+\/\d+|null)$/i;
const lookLikeData = (text) => /^[-+]?[\d.,]+%?$/.test(text) || /^\d{4}-\d{2}-\d{2}/.test(text) || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(text);
const sameRow = (a, b) => { const n = Math.max(a.length, b.length); for (let i = 0; i < n; i += 1) if (clean(a[i]).toLowerCase() !== clean(b[i]).toLowerCase()) return false; return true; };

// A row that could hold column names: two or more short pieces of text, none of which look like data. They must differ, unless the row starts
// with Name or Item, because a board can have two columns with the same name.
function headerShaped(cells) {
  const filled = filledAt(cells);
  if (filled.length < 2) return false;
  const named = ITEM_NAMES.test(clean(cells[filled[0]])), seen = new Set();
  for (const i of filled) { const t = clean(cells[i]); if (t.length > 200 || lookLikeData(t)) return false; const k = t.toLowerCase(); if (seen.has(k) && !named) return false; seen.add(k); }
  return true;
}

function findHeader(table, wanted) {
  const scan = table.slice(0, SCAN_ROWS), reasons = [];
  if (wanted !== undefined && wanted !== null) {
    const at = table.findIndex((r) => r.line === wanted);
    return at >= 0 ? { at, reasons, chosen: true } : { at: -1, reasons: [{ code: "header-missing", message: `Row ${wanted} isn't in this file.` }] };
  }
  const shaped = scan.map((r, i) => (headerShaped(r.cells) ? i : -1)).filter((i) => i >= 0);
  const named = shaped.filter((i) => ITEM_NAMES.test(clean(scan[i].cells[filledAt(scan[i].cells)[0]])));
  if (named.length) return { at: named[0], reasons };
  if (shaped.length && shaped[0] === 0 && !(scan[1] && headerShaped(scan[1].cells) && !sameRow(scan[0].cells, scan[1].cells))) return { at: 0, reasons };
  return { at: shaped.length ? shaped[0] : -1, reasons: [{ code: "header-unclear", message: shaped.length ? "This file doesn't have a clear row of column names. Choose the row that holds them." : "No row in this file looks like column names. Choose the row that holds them." }] };
}

function analyzeTable(table, { headerLine, itemColumn, soloRows, totalRows } = {}) {
  const candidates = table.slice(0, MAX_CANDIDATES).map((r) => ({ line: r.line, cells: r.cells.slice(0, 8).map((c) => clean(c).slice(0, 80)) }));
  const base = { status: "needs-confirmation", reasons: [], candidates, headerLine: null, boardTitle: null, columns: [], itemColumn: null, breaks: [], skipLines: [], soloLines: [], totalLines: [], counts: { titles: 0, headerRows: 0, groupHeadings: 0, subitemRows: 0, summaryRows: 0, records: 0 } };
  if (!table.length) return { ...base, reasons: [{ code: "empty", message: "This file has no rows." }] };
  const found = findHeader(table, headerLine);
  base.reasons.push(...found.reasons);
  if (found.at < 0) return base;
  const header = table[found.at], skip = [header.line], breaks = [], counts = { ...base.counts };
  // Above the header: the board's title, and possibly the first group's heading right on top of it.
  const above = table.slice(0, found.at);
  const repeated = table.slice(found.at + 1).some((r) => sameRow(r.cells, header.cells));
  for (let i = 0; i < above.length; i += 1) {
    const r = above[i], solo = filledAt(r.cells).length === 1, first = clean(r.cells[filledAt(r.cells)[0]]);
    skip.push(r.line);
    if (solo && i === above.length - 1 && r.line === header.line - 1 && (above.length > 1 || repeated)) { breaks.push({ line: r.line, name: first }); counts.groupHeadings += 1; }
    else { counts.titles += 1; if (solo && !base.boardTitle) base.boardTitle = first; }
  }
  // The column that names each record.
  const headerCells = filledAt(header.cells);
  let item = itemColumn;
  if (item === undefined || item === null) {
    const named = headerCells.find((i) => ITEM_NAMES.test(clean(header.cells[i])));
    if (named !== undefined) item = named;
    else { item = headerCells[0] ?? 0; base.reasons.push({ code: "item-column-unclear", message: `No column is called Name. Choose which column names each record; "${clean(header.cells[item]).slice(0, 80)}" is suggested.` }); }
  } else if (!headerCells.includes(item)) base.reasons.push({ code: "item-column-missing", message: "The chosen item column has no name in the header row. Choose another." });
  // The rows below it.
  let subitems = false, width = header.cells.length; const soloLines = [], totalLines = [];
  // Per group, as they go by: how many records it has and how many rows that could be its summary.
  const tally = new Map(), inGroup = () => { const k = breaks.length; if (!tally.has(k)) tally.set(k, { records: 0, totals: 0 }); return tally.get(k); };
  const isHeading = (next) => next && sameRow(next.cells, header.cells);
  for (let i = found.at + 1; i < table.length; i += 1) {
    const r = table[i], prev = table[i - 1], next = table[i + 1], filled = filledAt(r.cells), name = clean(r.cells[item]);
    if (sameRow(r.cells, header.cells)) { skip.push(r.line); counts.headerRows += 1; subitems = false; continue; }
    if (filled.length >= 2 && SUBITEM_HEADER.test(clean(r.cells[filled[0]]))) { skip.push(r.line); counts.subitemRows += 1; subitems = true; continue; }
    if (subitems) { if (!name) { skip.push(r.line); counts.subitemRows += 1; continue; } subitems = false; }
    if (filled.length >= 2 && ITEM_NAMES.test(clean(r.cells[filled[0]])) && headerShaped(r.cells)) {
      skip.push(r.line); counts.headerRows += 1;
      base.reasons.push({ code: "header-differs", message: `Row ${r.line} looks like column names but differs from row ${header.line}, so its group may have different columns. Check that this file's columns line up.`, lines: [r.line] });
      continue;
    }
    if (filled.length === 1 && filled[0] === item) {
      const gapBefore = prev.line < r.line - 1;
      if (isHeading(next)) { skip.push(r.line); breaks.push({ line: r.line, name }); counts.groupHeadings += 1; continue; }
      // A lone name after a blank row is a heading in one workbook and a record in another.
      if (gapBefore) {
        if (soloRows === "groups") { skip.push(r.line); breaks.push({ line: r.line, name }); counts.groupHeadings += 1; continue; }
        if (soloRows !== "records") soloLines.push(r.line);
      }
    } else if (!name && filled.length) {
      const last = !next || next.line > r.line + 1 || isHeading(next);
      // Only summary values and no name, at the end of a group: most likely its totals, but it could be a record whose name is missing.
      if (last && filled.every((c) => SUMMARY_VALUE.test(clean(r.cells[c])))) {
        if (totalRows === "skip") { skip.push(r.line); counts.summaryRows += 1; continue; }
        if (totalRows !== "records") { totalLines.push(r.line); inGroup().totals += 1; counts.records += 1; continue; }
      }
    }
    if (r.cells.length > width) { let w = r.cells.length; while (w > width && !clean(r.cells[w - 1])) w -= 1; width = Math.max(width, w); }
    counts.records += 1;
    inGroup().records += 1;
  }
  // monday.com ends every group with exactly one summary row. Only that whole pattern settles it without asking: every group has a heading, and
  // every group with records ends with one. A single nameless row in a plain table could just as well be a record, so a person decides that.
  const everyGroup = breaks.length > 0 && !tally.has(0) && [...tally.values()].every((g) => g.totals === 1 || (g.totals === 0 && g.records === 0));
  if (totalLines.length && !totalRows && everyGroup) { skip.push(...totalLines); counts.summaryRows += totalLines.length; counts.records -= totalLines.length; totalLines.length = 0; }
  if (soloLines.length) base.reasons.push({ code: "solo-rows", message: `${soloLines.length.toLocaleString("en-US")} row${soloLines.length === 1 ? " has" : "s have"} only a name after a blank row (the first is row ${soloLines[0]}). Choose whether these are group headings or records.`, lines: soloLines.slice(0, 20) });
  if (totalLines.length) base.reasons.push({ code: "total-rows", message: `${totalLines.length.toLocaleString("en-US")} row${totalLines.length === 1 ? " has" : "s have"} only numbers and no name at the end of a group (the first is row ${totalLines[0]}). Choose whether these are totals to leave out, or records to fix.`, lines: totalLines.slice(0, 20) });
  if (counts.records === 0 && !soloLines.length) base.reasons.push({ code: "no-records", message: "No records were found under the column names. Check the chosen row." });
  if (skip.length > LIMITS.skipLines) base.reasons.push({ code: "too-irregular", message: "This file has too many rows that aren't records to read safely." });
  // Columns: every name in the header, and any column that holds values beyond it, so nothing is dropped silently.
  const used = new Map(), columns = [];
  for (let i = 0; i < width; i += 1) {
    const source = clean(header.cells[i]);
    if (!source && !table.slice(found.at + 1).some((r) => clean(r.cells[i]))) continue;
    let label = (source || `Column ${i + 1}`).slice(0, 200); const k = label.toLowerCase(); const n = (used.get(k) || 0) + 1; used.set(k, n);
    if (n > 1) label = `${label.slice(0, 190)} (${n})`;
    columns.push({ index: i, source, label, type: "text", include: true });
  }
  if (columns.length > LIMITS.columns) base.reasons.push({ code: "too-many-columns", message: `This file has ${columns.length} columns. A board can have at most ${LIMITS.columns}.` });
  const status = base.reasons.length ? "needs-confirmation" : "clear";
  return { ...base, status, headerLine: header.line, itemColumn: item, columns, breaks: breaks.sort((a, b) => a.line - b.line), skipLines: skip.sort((a, b) => a - b), soloLines, totalLines, counts };
}

// ---- One cell → one value of its destination column. Text stays exactly as written; a blank stays blank.
function dateText(text, order = "mdy") {
  const t = text.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(t), parts;
  if (m) parts = [m[1], m[2], m[3]];
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T].*)?$/.exec(t))) parts = order === "dmy" ? [m[3], m[2], m[1]] : [m[3], m[1], m[2]];
  else return null;
  const iso = `${parts[0]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`, at = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === iso ? iso : null;
}
function convertCell(type, raw, { dateOrder = "mdy" } = {}) {
  const text = String(raw ?? "");
  if (!text.trim()) return {};
  if (type === "date") { const iso = dateText(text, dateOrder); return iso ? { value: iso } : { error: "isn't a date" }; }
  if (type === "number") return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text.trim()) ? { value: text.trim() } : { error: "isn't a number" };
  return { value: text };
}

// ---- The whole file against the structure and the chosen columns.
const lineLookup = (structure) => { const skip = new Set(structure.skipLines), breaks = structure.breaks; return { skip, groupOf: (line) => { let name = null; for (const b of breaks) { if (b.line < line) name = b.name; else break; } return name; } }; };

function validateTable(table, structure, { columns = structure.columns, itemColumn = structure.itemColumn, uniqueColumn = null, dateOrder = "mdy" } = {}, notes = {}) {
  const errors = [], warnings = [], groups = new Map(), preview = [], included = columns.filter((c) => c.include !== false);
  let errorCount = 0, records = 0, sameRows = 0, sameNames = 0, sameUnique = 0, timeDropped = 0;
  const addError = (row, column, reason) => { errorCount += 1; if (errors.length < MAX_ERRORS) errors.push({ row, column, reason }); };
  const { skip } = lineLookup(structure), rowSeen = new Set(), nameSeen = new Set(), uniqueSeen = new Set(), itemLabel = columns.find((c) => c.index === itemColumn)?.label || "Item";
  let cursor = 0, group = null;
  for (const r of table) {
    while (cursor < structure.breaks.length && structure.breaks[cursor].line < r.line) { group = structure.breaks[cursor].name; if (!groups.has(group)) groups.set(group, 0); cursor += 1; }
    if (skip.has(r.line) || r.line < structure.headerLine) continue;
    records += 1;
    const groupName = group ?? DEFAULT_GROUP;
    groups.set(groupName, (groups.get(groupName) || 0) + 1);
    const name = clean(r.cells[itemColumn]);
    if (!name) addError(r.line, itemLabel, "has no name, and every record needs one");
    else { if (nameSeen.has(name)) sameNames += 1; nameSeen.add(name); }
    for (const c of included) {
      if (c.index === itemColumn) continue;
      const { error } = convertCell(c.type || "text", r.cells[c.index], { dateOrder });
      if (error) addError(r.line, c.label, error);
      else if (c.type === "date" && /\d[ T]\d{1,2}:\d{2}/.test(String(r.cells[c.index] ?? ""))) timeDropped += 1;
    }
    const whole = r.cells.map(clean).join("\u0000");
    if (rowSeen.has(whole)) sameRows += 1; rowSeen.add(whole);
    if (uniqueColumn !== null && uniqueColumn !== undefined) { const v = clean(r.cells[uniqueColumn]); if (v) { if (uniqueSeen.has(v)) sameUnique += 1; uniqueSeen.add(v); } }
    if (preview.length < PREVIEW_ROWS) preview.push({ row: r.line, group: groupName, cells: included.map((c) => String(r.cells[c.index] ?? "").slice(0, 200)) });
  }
  for (; cursor < structure.breaks.length; cursor += 1) if (!groups.has(structure.breaks[cursor].name)) groups.set(structure.breaks[cursor].name, 0); // a group with no records
  const warn = (code, message) => warnings.push({ code, message });
  const { counts } = structure;
  if (counts.subitemRows) warn("subitems", `${counts.subitemRows.toLocaleString("en-US")} sub-item row${counts.subitemRows === 1 ? "" : "s"} won't be imported. Sub-items aren't supported in this release.`);
  if (counts.summaryRows) warn("summaries", `${counts.summaryRows.toLocaleString("en-US")} total row${counts.summaryRows === 1 ? "" : "s"} won't be imported, because they hold group totals rather than records.`);
  if (structure.reasons.some((r) => r.code === "header-differs")) warn("header-differs", "A group's column names differ from the first group's. Their values are imported by position, so check those columns.");
  if (sameNames) warn("same-names", `${sameNames.toLocaleString("en-US")} record${sameNames === 1 ? " has" : "s have"} the same name as an earlier record. They'll all be imported, since monday.com allows this. Choose a column to check if they're real duplicates.`);
  if (sameRows) warn("same-rows", `${sameRows.toLocaleString("en-US")} row${sameRows === 1 ? " is" : "s are"} identical to an earlier row and will still be imported unless you choose a column to check for duplicates.`);
  if (timeDropped) warn("time-dropped", `${timeDropped.toLocaleString("en-US")} value${timeDropped === 1 ? "" : "s"} in a date column include a time, which a date column can't keep. Keep that column as text to preserve it.`);
  if (notes.formulas) warn("formulas", `${notes.formulas.toLocaleString("en-US")} formula cell${notes.formulas === 1 ? "" : "s"} will be imported as the last saved result, not as a formula.`);
  if (notes.errorCells) warn("error-cells", `${notes.errorCells.toLocaleString("en-US")} cell${notes.errorCells === 1 ? "" : "s"} showed an Excel error such as #N/A and will be imported as blank.`);
  if (notes.hyperlinks) warn("hyperlinks", `${notes.hyperlinks.toLocaleString("en-US")} cell${notes.hyperlinks === 1 ? " has a link" : "s have links"}. Only the text shown in the cell is imported, not the link behind it.`);
  if (notes.pictures) warn("attachments", "This workbook contains pictures or attached files. They won't be imported.");
  if (notes.comments) warn("comments", "This workbook contains cell comments. They won't be imported.");
  if (notes.precision?.count) warn("precision", `${notes.precision.count.toLocaleString("en-US")} number${notes.precision.count === 1 ? "" : "s"} have more than 15 digits (the first is ${notes.precision.first}). Excel keeps only 15, so the last digits were already lost in this file and can't be recovered. Check these against monday.com if they're IDs.`);
  for (const [pattern, code, name] of TEXT_ONLY_COLUMNS) {
    const hit = columns.filter((c) => pattern.test(c.source || c.label));
    if (hit.length) warn(`column-${code}`, `${name} (${hit.map((c) => `"${c.label}"`).slice(0, 3).join(", ")}): only the text in the workbook is imported. The real ${code === "subitems" ? "sub-items" : code === "attachments" ? "files" : code === "updates" ? "updates" : code === "relationships" ? "connections" : "formulas"} aren't in the file.`);
  }
  if (columns.some((c) => !c.source)) warn("unnamed-columns", "Some columns had no name in the file and were given one, such as “Column 5”.");
  warn("not-in-file", "A workbook doesn't hold updates, files, automations, or connections between boards, so a board made from one won't have them either.");
  const groupList = (structure.breaks.length || records ? [...groups] : []).map(([name, n]) => ({ name, records: n }));
  if (groupList.length > LIMITS.groups) { addError(structure.headerLine, "Groups", `This file has ${groupList.length} groups. A board can have at most ${LIMITS.groups}.`); }
  return { records, columns: included.length, groups: groupList, errorCount, errors, warnings, duplicates: { sameRows, sameNames, sameUnique }, preview, previewColumns: included.map((c) => c.label) };
}

module.exports = { analyzeTable, validateTable, convertCell, lineLookup, DEFAULT_GROUP, LIMITS, MAX_ERRORS };
