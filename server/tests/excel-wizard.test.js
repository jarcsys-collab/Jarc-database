// A new board from a file: JARC's usual access rules, reading monday.com-shaped workbooks, keeping values exactly, checking every row, repeated files,
// recovery, removal, staying responsive, and the guided screens in a real browser.
const { test, describe, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { spawn } = require("child_process");
const { ObjectId, MongoClient } = require("mongodb");
const { numberText, readTable } = require("../src/domain/spreadsheet");
const { analyzeTable, validateTable, convertCell } = require("../src/domain/workbook-structure");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase, COLLECTIONS } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { FakeMongoClient } = require("./support/fake-mongo");
const { startMongoApp, api } = require("./helpers");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const quiet = { log() {}, warn() {}, error() {} };
const actor = Object.freeze({ userId: new ObjectId(), kind: "entra", displayName: "Importer" });
const t = (lines) => lines.map(([line, ...cells]) => ({ line, cells }));
const tableFor = (rows) => { const out = []; rows.forEach((cells, i) => { if (cells.some((c) => String(c ?? "").trim())) out.push({ line: i + 1, cells: cells.map((c) => String(c ?? "")) }); }); return out; };

// ---- A minimal XLSX writer, so a test states exactly what's in the file.
function crc32(buf) { let c, crc = 0xffffffff; for (let i = 0; i < buf.length; i += 1) { c = (crc ^ buf[i]) & 0xff; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function zip(files) {
  const zlib = require("zlib"), parts = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = zlib.deflateRawSync(raw), n = Buffer.from(name), crc = crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n); offset += local.length + n.length + data.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const col = (i) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
// rows: arrays of cells; a cell is text, null (no cell), or { n: raw number, s: style, f: formula, e: true }. styles: numFmt codes.
function xlsx(rows, { styles = [], extra = {} } = {}) {
  const body = rows.map((cells, r) => (cells.length ? `<row r="${r + 1}">${cells.map((c, i) => { const at = `${col(i)}${r + 1}`; if (c === null || c === undefined) return ""; if (typeof c === "string") return `<c r="${at}" t="inlineStr"><is><t xml:space="preserve">${esc(c)}</t></is></c>`; if (c.e) return `<c r="${at}" t="e"><v>#N/A</v></c>`; return `<c r="${at}"${c.s !== undefined ? ` s="${c.s}"` : ""}>${c.f ? `<f>${esc(c.f)}</f>` : ""}<v>${c.n}</v></c>`; }).join("")}</row>` : "")).join("");
  const xfs = ['<xf numFmtId="0"/>', ...styles.map((_, i) => `<xf numFmtId="${200 + i}"/>`)].join("");
  return zip({
    "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/styles.xml": `<styleSheet><numFmts>${styles.map((code, i) => `<numFmt numFmtId="${200 + i}" formatCode="${esc(code)}"/>`).join("")}</numFmts><cellXfs>${xfs}</cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${body}</sheetData></worksheet>`, ...extra
  });
}
const HEAD = ["Name", "Serial ID", "Install date", "Status", "Notes"];
const mondayRows = () => [["Installations"], [], ["North region"], HEAD, ["Machine A", "00123", "2026-01-02", "Done", "first"], ["Machine B", "00124", "2026-01-03", "", ""], [], ["South region"], HEAD, ["Machine C", "00125", "2026-01-04", "Working on it", "ñandú 日本語 🚀"]];
const mondayFile = () => xlsx(mondayRows());

describe("The reader keeps what the file shows", () => {
  test("numbers are never in scientific notation, and nothing is rounded while writing them out", () => {
    assert.equal(numberText("1.5E+21").text, "1500000000000000000000");
    assert.equal(numberText("1.2345678901234E+15").text, "1234567890123400");
    assert.equal(numberText("3968041").text, "3968041");
    assert.equal(numberText("1E-3").text, "0.001");
    assert.equal(numberText("0.30000000000000004").text, "0.3", "Excel's own 15 digits");
    assert.equal(numberText("-12.50").text, "-12.5");
  });
  test("digits Excel already lost are flagged, ordinary numbers aren't", () => {
    assert.ok(numberText("1.2345678901234568E+19").digits > 15);
    assert.ok(numberText("12345678901234567").digits > 15);
    assert.equal(numberText("123456789012345").digits, 0);
    assert.equal(numberText("0.5").digits, 0);
  });
  test("text IDs, leading zeros, dates, times, Unicode and blanks", () => {
    const file = xlsx([["Name", "A", "B", "C", "D", "E", "F", "G"], ["日本語 ñ 🚀", "00123", { n: 123, s: 3 }, { n: 46085, s: 1 }, { n: 46085.5625, s: 2 }, { n: 0.5625, s: 4 }, "", "1E5"], ["Pct", "", { n: "1.5E+21" }, { n: 0.25, s: 5 }, { n: 46085.56309, s: 2 }, null, "  spaced  ", null]], { styles: ["yyyy-mm-dd", "yyyy-mm-dd hh:mm:ss", "00000", "h:mm", "0%"] });
    const { table, notes } = readTable(file, { name: "a.xlsx" }), [, a, b] = table;
    assert.deepEqual(a.cells, ["日本語 ñ 🚀", "00123", "00123", "2026-03-04", "2026-03-04 13:30", "13:30", "", "1E5"]);
    assert.equal(b.cells[2], "1500000000000000000000");
    assert.equal(b.cells[3], "25%");
    assert.match(b.cells[4], /^2026-03-04 13:30:5\d$/, "seconds are kept when there are any");
    assert.equal(b.cells[6], "  spaced  ");
    assert.equal(notes.precision.count, 0, "1.5E+21 has few digits, so nothing was lost");
  });
  test("what a cell's text can't carry is counted: formulas, errors, links, pictures, comments, lost digits", () => {
    const file = xlsx([["Name", "Calc", "Bad", "Long"], ["A", { n: 4, f: "2+2" }, { e: true }, { n: "1.2345678901234568E+19" }]], { extra: { "xl/media/image1.png": "x", "xl/comments1.xml": "<comments/>" } });
    const { notes } = readTable(file, { name: "n.xlsx" });
    assert.equal(notes.formulas, 1); assert.equal(notes.errorCells, 1); assert.equal(notes.pictures, true); assert.equal(notes.comments, true);
    assert.equal(notes.precision.count, 1); assert.equal(notes.precision.first, "D2");
  });
});

describe("Working out a workbook's structure", () => {
  test("a monday.com export: title, groups, repeated headers, and only the real records", () => {
    const a = analyzeTable(tableFor(mondayRows()));
    assert.equal(a.status, "clear", JSON.stringify(a.reasons));
    assert.equal(a.boardTitle, "Installations"); assert.equal(a.headerLine, 4); assert.equal(a.itemColumn, 0);
    assert.deepEqual(a.breaks.map((b) => b.name), ["North region", "South region"]);
    assert.deepEqual(a.columns.map((c) => c.label), HEAD);
    assert.equal(a.counts.records, 3); assert.equal(a.counts.headerRows, 1); assert.equal(a.counts.groupHeadings, 2); assert.equal(a.counts.titles, 1);
    const v = validateTable(tableFor(mondayRows()), a);
    assert.deepEqual(v.groups, [{ name: "North region", records: 2 }, { name: "South region", records: 1 }]);
    assert.equal(v.errorCount, 0); assert.equal(v.records, 3);
  });
  test("a plain table: the first row is the header, one default group", () => {
    const rows = [["Item", "Code"], ["One", "1"], ["Two", "2"]], a = analyzeTable(tableFor(rows));
    assert.equal(a.status, "clear"); assert.equal(a.headerLine, 1); assert.equal(a.counts.records, 2);
    assert.deepEqual(validateTable(tableFor(rows), a).groups, [{ name: "Imported records", records: 2 }]);
  });
  test("sub-item sections are recognized, and rows of only numbers at a group's end wait for a decision, because they may be records", () => {
    const rows = [["Board"], [], ["Group"], HEAD, ["Parent", "1", "2026-01-02", "Done", ""], ["Subitems", "Name", "Owner"], ["", "Child 1", "Ann"], ["", "Child 2", "Bo"], ["Next", "2", "2026-01-03", "", ""], ["", "3", "", "", ""], [], ["Other"], HEAD, ["Last", "4", "", "", ""]];
    const open = analyzeTable(tableFor(rows));
    assert.ok(open.reasons.some((r) => r.code === "total-rows")); assert.deepEqual(open.totalLines, [10]); assert.equal(open.counts.summaryRows, 0);
    const kept = analyzeTable(tableFor(rows), { totalRows: "records" });
    assert.equal(kept.status, "clear"); assert.equal(validateTable(tableFor(rows), kept).errorCount, 1, "a record with no name is then an error");
    const a = analyzeTable(tableFor(rows), { totalRows: "skip" });
    assert.equal(a.status, "clear", JSON.stringify(a.reasons));
    assert.equal(a.counts.subitemRows, 3); assert.equal(a.counts.summaryRows, 1); assert.equal(a.counts.records, 3);
    const v = validateTable(tableFor(rows), a);
    assert.equal(v.records, 3); assert.equal(v.errorCount, 0);
    assert.ok(v.warnings.some((w) => w.code === "subitems" && /3 sub-item rows/.test(w.message)));
    assert.ok(v.warnings.some((w) => w.code === "summaries"));
  });
  test("monday.com's own summary rows: one at the end of every group, with date ranges, fractions and the word null, are left out without asking", () => {
    const head = ["Name", "Unique ID", "Created", "Tier code", "Qty"], summary = (d) => ["", "", d, "null", "12"];
    const rows = [["Board"], ["First"], head, ["A", "90000000001", "2026-01-23", "x", "5"], summary("2026-01-23 to 2026-01-23"), [], ["Second"], head, ["B", "90000000002", "", "y", "7"], ["", "", "2026-02-01", "null", "3/10"]];
    const a = analyzeTable(tableFor(rows));
    assert.equal(a.status, "clear", JSON.stringify(a.reasons));
    assert.equal(a.counts.records, 2); assert.equal(a.counts.summaryRows, 2); assert.equal(a.counts.groupHeadings, 2); assert.equal(a.counts.titles, 1);
    const v = validateTable(tableFor(rows), a);
    assert.equal(v.errorCount, 0); assert.deepEqual(v.groups, [{ name: "First", records: 1 }, { name: "Second", records: 1 }]);
    assert.ok(v.warnings.some((w) => w.code === "summaries"));
  });
  test("a nameless row is only left out when every group has one; otherwise a person decides", () => {
    const head = ["Name", "Code"];
    const one = analyzeTable(tableFor([["First"], head, ["A", "1"], ["", "2"], [], ["Second"], head, ["B", "3"]]));
    assert.ok(one.reasons.some((r) => r.code === "total-rows"), "only one of the two groups has it");
    const text = analyzeTable(tableFor([["First"], head, ["A", "1"], ["", "real words"]]));
    assert.equal(text.counts.summaryRows, 0); assert.equal(validateTable(tableFor([["First"], head, ["A", "1"], ["", "real words"]]), text).errorCount, 1, "words aren't a summary: a record missing its name");
  });
  test("no clear header: a person has to choose, nothing is guessed", () => {
    const rows = [["Report"], ["2026-01-02", "12", "34"], ["2026-01-03", "56", "78"]], a = analyzeTable(tableFor(rows));
    assert.equal(a.status, "needs-confirmation"); assert.ok(a.reasons.some((r) => r.code === "header-unclear"));
    assert.ok(a.candidates.length >= 3);
    const chosen = analyzeTable(tableFor(rows), { headerLine: 2, itemColumn: 0 });
    assert.equal(chosen.headerLine, 2); assert.equal(chosen.counts.records, 1);
  });
  test("no column called Name: a person chooses which column names each record", () => {
    const rows = [["Serial", "Site"], ["A", "1"]], a = analyzeTable(tableFor(rows));
    assert.ok(a.reasons.some((r) => r.code === "item-column-unclear")); assert.equal(a.status, "needs-confirmation");
    assert.equal(analyzeTable(tableFor(rows), { itemColumn: 1 }).status, "clear");
  });
  test("a lone name after a blank row could be either, so a person decides", () => {
    const rows = [["Name", "Code"], ["A", "1"], [], ["Lone"], ["B", "2"]];
    const a = analyzeTable(tableFor(rows));
    assert.ok(a.reasons.some((r) => r.code === "solo-rows")); assert.deepEqual(a.soloLines, [4]);
    const asGroups = analyzeTable(tableFor(rows), { soloRows: "groups" });
    assert.equal(asGroups.status, "clear"); assert.deepEqual(asGroups.breaks.map((b) => b.name), ["Lone"]); assert.equal(asGroups.counts.records, 2);
    const asRecords = analyzeTable(tableFor(rows), { soloRows: "records" });
    assert.equal(asRecords.status, "clear"); assert.equal(asRecords.counts.records, 3);
  });
  test("a group whose column names differ is flagged, because its values line up by position", () => {
    const a = analyzeTable(tableFor([["Name", "Code"], ["A", "1"], ["Name", "Other"], ["B", "2"]]));
    assert.ok(a.reasons.some((r) => r.code === "header-differs"));
  });
  test("columns: repeated names are told apart, a value past the header isn't dropped, an empty unnamed column is", () => {
    const a = analyzeTable(tableFor([["Name", "Status", "Status", ""], ["A", "x", "y", "", "beyond"]]));
    assert.deepEqual(a.columns.map((c) => [c.index, c.label]), [[0, "Name"], [1, "Status"], [2, "Status (2)"], [4, "Column 5"]]);
  });
  test("an empty file and a file with only a header say so", () => {
    assert.equal(analyzeTable([]).status, "needs-confirmation");
    assert.ok(analyzeTable(tableFor([["Name", "Code"]])).reasons.some((r) => r.code === "no-records"));
  });
});

describe("Checking every row", () => {
  const check = (rows, settings = {}, notes = {}) => { const table = tableFor(rows), a = analyzeTable(table); return validateTable(table, a, { ...settings, columns: settings.columns?.(a.columns) ?? a.columns }, notes); };
  test("a missing name is an error however far down it is, and every problem is counted", () => {
    const rows = [["Name", "Code"], ...Array.from({ length: 3000 }, (_, i) => [i === 2750 ? "" : `Row ${i}`, String(i)])];
    const v = check(rows);
    assert.equal(v.records, 3000); assert.equal(v.errorCount, 1); assert.equal(v.errors[0].row, 2752); assert.match(v.errors[0].reason, /no name/);
  });
  test("a date or number column only when asked; text keeps anything", () => {
    assert.deepEqual(convertCell("text", "Mar 4, 2026"), { value: "Mar 4, 2026" });
    assert.deepEqual(convertCell("text", "  spaced  "), { value: "  spaced  " });
    assert.deepEqual(convertCell("text", "   "), {}, "only spaces is blank");
    assert.deepEqual(convertCell("date", "2026-03-04"), { value: "2026-03-04" });
    assert.ok(convertCell("date", "Mar 4, 2026").error); assert.ok(convertCell("number", "1,234").error);
    assert.deepEqual(convertCell("number", "1.5"), { value: "1.5" });
    const v = check([["Name", "When"], ["A", "soon"], ["B", "2026-03-04 13:30"]], { columns: (c) => c.map((x) => (x.index === 1 ? { ...x, type: "date" } : x)) });
    assert.equal(v.errorCount, 1); assert.ok(v.warnings.some((w) => w.code === "time-dropped"));
  });
  test("repeats are counted, and a chosen column counts its own", () => {
    const v = check([["Name", "Code"], ["A", "1"], ["A", "1"], ["B", "1"]], { uniqueColumn: 1 });
    assert.equal(v.duplicates.sameRows, 1); assert.equal(v.duplicates.sameNames, 1); assert.equal(v.duplicates.sameUnique, 2);
    assert.ok(v.warnings.some((w) => w.code === "same-rows"));
  });
  test("it never claims to bring what a workbook doesn't hold", () => {
    const v = check([["Name", "Subitems", "Files", "Item updates", "Connect boards", "Formula"], ["A", "x", "y", "z", "w", "1"]], {}, { formulas: 2, errorCells: 1, hyperlinks: 3, pictures: true, comments: true, precision: { count: 2, first: "B2" } });
    const codes = v.warnings.map((w) => w.code);
    for (const c of ["column-subitems", "column-attachments", "column-relationships", "column-formulas", "formulas", "error-cells", "hyperlinks", "attachments", "comments", "precision", "not-in-file"]) assert.ok(codes.includes(c), c);
    assert.match(v.warnings.find((w) => w.code === "precision").message, /already lost/);
  });
  test("a preview shows the first rows with their groups", () => {
    const table = tableFor(mondayRows()), v = validateTable(table, analyzeTable(table));
    assert.equal(v.preview[0].group, "North region"); assert.equal(v.preview[0].cells[1], "00123"); assert.equal(v.preview.at(-1).group, "South region");
  });
});

async function world({ fake = new FakeMongoClient(), search = "off" } = {}) {
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect(); await ensureDatabase(connection.db);
  const dl = createDataLayer({ connection, logger: quiet, fileStore: new MemoryFileStore(), recordSearch: search }), s = dl.services, jobs = s.importJobs;
  jobs.pauseMs = 0; jobs.writePauseMs = 0; jobs.removePauseMs = 0; dl.searchIndex.pauseMs = 0;
  const ws = await s.workspaces.create({ name: "W" }, actor);
  return { dl, s, jobs, ws, db: connection.db, fake, connection, records: dl.repos.records.collection, boards: dl.repos.boards.collection };
}
const finished = async (jobs, id) => { for (let i = 0; i < 600; i += 1) { const j = await jobs.find(id); if (!["queued", "running"].includes(j.status)) return j; await sleep(10); } throw new Error("never ended"); };
const removeBoard = async (w, job) => { const { job: started } = await w.jobs.cleanUp(job, actor); assert.equal(started.status, "removing"); w.jobs.wake(); for (let i = 0; i < 600; i += 1) { const j = await w.jobs.find(job._id); if (j.status !== "removing") return j; await sleep(10); } throw new Error("the removal never ended"); };
const importFile = async (w, file, { name = "m.xlsx", review = {}, start = { confirmNewBoard: true } } = {}) => { let job = await w.jobs.createFromFile(w.ws, file, { name }, actor); job = await w.jobs.review(job, review); job = await w.jobs.startNewBoard(job, start); w.jobs.wake(); return finished(w.jobs, job._id); };

describe("API IDs of imported columns", () => {
  test("every imported row gets its own permanent Record ID, and a workbook's own Item ID column keeps its values", async () => {
    const rows = [["Name", "Item ID", "Qty"], ...Array.from({ length: 30 }, (_, i) => [`Row ${i + 1}`, `BH-1120${String(i).padStart(3, "0")}`, String(i)])];
    const w = await world(), done = await importFile(w, xlsx(rows), { name: "with-item-ids.xlsx" });
    assert.equal(done.status, "done", done.lastError);
    const board = await w.dl.repos.boards.findById(done.boardId), records = await w.dl.repos.records.listAllForBoard(board._id);
    assert.equal(records.length, 30);
    const ids = records.map((r) => r._id.toHexString());
    assert.ok(ids.every((id) => /^[0-9a-f]{24}$/.test(id)) && new Set(ids).size === 30, "30 different permanent IDs");
    const itemId = board.columns.find((c) => c.label === "Item ID");
    assert.ok(itemId && itemId.key !== "__record_id", "the workbook's Item ID is an ordinary column");
    assert.deepEqual(records.map((r) => r.values[itemId.key]).sort(), rows.slice(1).map((r) => r[1]).sort(), "its BH- values are unchanged");
    // A second import adds new rows with new IDs; the first rows keep theirs.
    const again = await importFile(w, xlsx([["Name", "Item ID"], ["Later", "BH-9"]]), { name: "later.xlsx" });
    assert.equal(again.status, "done", again.lastError);
    const later = (await w.dl.repos.records.listAllForBoard(again.boardId)).map((r) => r._id.toHexString());
    assert.ok(later.every((id) => !ids.includes(id)));
    assert.deepEqual((await w.dl.repos.records.listAllForBoard(board._id)).map((r) => r._id.toHexString()).sort(), [...ids].sort());
  });

  test("an imported board's column IDs are unique, valid and unchanged by renaming, and another import doesn't disturb them", async () => {
    const w = await world(), done = await importFile(w, xlsx([["Name", "Code", "When"], ["A", "1", "2026-03-04"], ["B", "2", "2026-03-05"]]), { name: "first.xlsx" });
    assert.equal(done.status, "done", done.lastError);
    const board = await w.dl.repos.boards.findById(done.boardId), keys = board.columns.map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.includes("serial") && keys.every((k) => /^[A-Za-z0-9_-]{1,100}$/.test(k)));
    const renamed = board.columns.map((c) => ({ ...c, label: `${c.label} renamed` }));
    const after = await w.s.boards.update(board._id, { expectedVersion: board.version, columns: renamed }, actor);
    assert.deepEqual(after.columns.map((c) => c.key), keys);
    const stored = (await w.dl.repos.records.listAllForBoard(board._id)).map((r) => Object.keys(r.values).filter((k) => k !== "group").sort());
    for (const row of stored) for (const k of row) assert.ok(keys.includes(k), `record value ${k} belongs to a column`);
    const second = await importFile(w, xlsx([["Name", "Other"], ["C", "x"]]), { name: "second.xlsx" });
    assert.equal(second.status, "done", second.lastError);
    assert.notEqual(second.boardId.toHexString(), board._id.toHexString());
    assert.deepEqual((await w.dl.repos.boards.findById(board._id)).columns.map((c) => c.key), keys, "the first board's IDs are untouched");
  });
});

describe("A new board from a monday.com workbook", () => {
  test("the board, its columns and groups are made, and every value arrives exactly", async () => {
    const w = await world(), done = await importFile(w, mondayFile(), { name: "Installations.xlsx" });
    assert.equal(done.status, "done", done.lastError); assert.deepEqual([done.imported, done.rejected], [3, 0]);
    const board = await w.dl.repos.boards.findById(done.boardId);
    assert.equal(board.name, "Installations", "named after the workbook's title"); assert.equal(board.importJobId.toHexString(), done._id.toHexString());
    assert.deepEqual(board.columns.map((c) => [c.label, c.type]), HEAD.map((h) => [h, "text"]));
    assert.equal(board.columns[0].key, "serial", "Name is the Item column");
    assert.deepEqual(board.groups.map((g) => g.name), ["North region", "South region"]);
    const rows = await w.records.find({ boardId: board._id }).sort({ position: 1 }).toArray(), byGroup = new Map(board.groups.map((g) => [g.id, g.name]));
    const k = (label) => board.columns.find((c) => c.label === label).key;
    assert.deepEqual(rows.map((r) => [r.values.serial, r.values[k("Serial ID")], r.values[k("Install date")], r.values[k("Status")], r.values[k("Notes")], byGroup.get(r.groupId)]), [
      ["Machine A", "00123", "2026-01-02", "Done", "first", "North region"], ["Machine B", "00124", "2026-01-03", "", "", "North region"], ["Machine C", "00125", "2026-01-04", "Working on it", "ñandú 日本語 🚀", "South region"]
    ]);
    assert.equal(rows.some((r) => ["Name", "North region", "South region", "Installations"].includes(r.values.serial)), false, "no heading became a record");
    assert.equal(await w.db.collection(COLLECTIONS.importBatches).countDocuments({ jobId: done._id }), 0, "uploaded rows are gone");
    assert.equal(done.validation.preview, undefined, "the preview's values aren't kept");
  });
  test("nothing else changes: other boards are byte-identical, and nothing runs until confirmed", async () => {
    const w = await world(), other = await w.s.boards.create(w.ws._id, { name: "Migrated", columns: [{ key: "serial", label: "Item", type: "text", required: true }] }, actor);
    await w.s.records.create(other._id, { values: { serial: "Keep me" } }, actor, { everyone: true });
    const snapshot = async () => JSON.stringify([await w.boards.find({ _id: other._id }).toArray(), await w.records.find({ boardId: other._id }).toArray()]), before = await snapshot();
    let job = await w.jobs.createFromFile(w.ws, mondayFile(), { name: "m.xlsx" }, actor);
    job = await w.jobs.review(job, {});
    assert.equal(await w.boards.countDocuments({ workspaceId: w.ws._id }), 1, "no board yet");
    await assert.rejects(w.jobs.startNewBoard(job, {}), (e) => e.code === "CONFIRMATION_NEEDED");
    assert.equal(await w.boards.countDocuments({ workspaceId: w.ws._id }), 1);
    job = await w.jobs.startNewBoard(job, { confirmNewBoard: true }); w.jobs.wake();
    await finished(w.jobs, job._id);
    assert.equal(await w.boards.countDocuments({ workspaceId: w.ws._id }), 2);
    assert.equal(await snapshot(), before);
  });
  test("a missing name stops the import before anything is created, and the report lists it", async () => {
    const w = await world(); let job = await w.jobs.createFromFile(w.ws, xlsx([["Name", "Code"], ["A", "1"], ["", "2"], ["C", "3"]]), { name: "bad.xlsx" }, actor);
    job = await w.jobs.review(job, {});
    assert.equal(job.status, "mapping"); assert.equal(job.validation.errorCount, 1);
    await assert.rejects(w.jobs.startNewBoard(job, { confirmNewBoard: true }), (e) => e.code === "IMPORT_NOT_READY");
    assert.equal(await w.boards.countDocuments({}), 0);
    const csv = w.jobs.reportCsv(job);
    assert.match(csv, /"Row","Column","Problem"/); assert.match(csv, /"3","Name","has no name/);
  });
  test("a nameless row of numbers can't be skipped or imported until a person decides", async () => {
    const w = await world(); let job = await w.jobs.createFromFile(w.ws, xlsx([["Name", "Qty"], ["A", "1"], ["", "1"]]), { name: "t.xlsx" }, actor);
    job = await w.jobs.review(job, {});
    assert.equal(job.status, "mapping"); assert.ok(job.structure.reasons.some((r) => r.code === "total-rows"));
    const skip = await w.jobs.review(job, { totalRows: "skip" });
    assert.equal(skip.status, "ready"); assert.equal(skip.validation.records, 1);
    assert.ok(skip.validation.warnings.some((x) => x.code === "summaries"), "and it's reported");
    const asRecords = await w.jobs.review(skip, { totalRows: "records" });
    assert.equal(asRecords.status, "mapping"); assert.equal(asRecords.validation.errorCount, 1);
  });
  test("every later step keeps what was found: the second and third checks agree with the first", async () => {
    const w = await world(), head = ["Name", "Code"], file = xlsx([["Board"], ["First"], head, ["A", "1"], ["", "2026-01-01 to 2026-01-02"], [], ["Second"], head, ["B", "2"], ["", "null"]]);
    let job = await w.jobs.createFromFile(w.ws, file, { name: "s.xlsx" }, actor);
    assert.equal(job.validation.records, 2); assert.equal(job.validation.errorCount, 0);
    for (const body of [{}, { columns: job.columns.map((c) => ({ index: c.index, label: c.label, type: "text", include: true })), boardName: "Kept", uniqueColumn: null, dateOrder: "mdy" }, {}]) {
      job = await w.jobs.review(job, body);
      assert.equal(job.status, "ready", JSON.stringify(job.structure.reasons)); assert.equal(job.validation.records, 2); assert.equal(job.validation.errorCount, 0); assert.equal(job.structure.counts.summaryRows, 2);
    }
  });
  test("an ambiguous file can't start until a person has settled it", async () => {
    const w = await world(); let job = await w.jobs.createFromFile(w.ws, xlsx([["Name", "Code"], ["A", "1"], [], ["Lone"], ["B", "2"]]), { name: "amb.xlsx" }, actor);
    assert.equal(job.structureConfirmed, false);
    job = await w.jobs.review(job, {});
    assert.equal(job.status, "mapping");
    await assert.rejects(w.jobs.startNewBoard(job, { confirmNewBoard: true }), (e) => e.code === "IMPORT_NOT_READY");
    job = await w.jobs.review(job, { soloRows: "groups" });
    assert.equal(job.status, "ready"); assert.deepEqual(job.validation.groups.map((g) => g.name), ["Imported records", "Lone"]);
  });
  test("choosing another header row re-reads every stored row", async () => {
    const w = await world(); let job = await w.jobs.createFromFile(w.ws, xlsx([["Report"], ["Name", "Code"], ["A", "1"], ["B", "2"]]), { name: "h.xlsx" }, actor);
    assert.equal(job.structure.headerLine, 2);
    job = await w.jobs.review(job, { headerLine: 3, itemColumn: 0 });
    assert.equal(job.structure.headerLine, 3); assert.equal(job.validation.records, 1);
    job = await w.jobs.review(job, { headerLine: 2, itemColumn: 0 });
    assert.equal(job.validation.records, 2); assert.equal(job.status, "ready");
  });
  test("columns: renamed, left out, and a chosen type", async () => {
    const w = await world(), file = xlsx([["Name", "Code", "When", "Secret"], ["A", "007", "2026-03-04", "x"]]);
    const done = await importFile(w, file, { review: { boardName: "Renamed", columns: [{ index: 0, label: "Name" }, { index: 1, label: "Asset code" }, { index: 2, label: "When", type: "date" }, { index: 3, include: false }] } });
    const board = await w.dl.repos.boards.findById(done.boardId), [r] = await w.records.find({ boardId: board._id }).toArray();
    assert.equal(board.name, "Renamed");
    assert.deepEqual(board.columns.map((c) => [c.label, c.type]), [["Name", "text"], ["Asset code", "text"], ["When", "date"]]);
    assert.equal(r.values[board.columns[1].key], "007"); assert.equal(r.values[board.columns[2].key], "2026-03-04");
    assert.equal(JSON.stringify(r.values).includes('"x"'), false, "the left-out column isn't stored");
  });
  test("settings are checked: unknown fields, bad types, repeated names, and the item column can't be left out", async () => {
    const w = await world(); const job = await w.jobs.createFromFile(w.ws, mondayFile(), { name: "m.xlsx" }, actor);
    await assert.rejects(w.jobs.review(job, { nope: 1 }), /unknown|nope|allowed/i);
    await assert.rejects(w.jobs.review(job, { columns: [{ index: 1, type: "status" }] }), /text, a number or a date/);
    await assert.rejects(w.jobs.review(job, { columns: [{ index: 1, label: "Same" }, { index: 2, label: "same" }] }), /same name/);
    await assert.rejects(w.jobs.review(job, { boardName: "" }), /name must be/);
    const out = await w.jobs.review(job, { columns: [{ index: 0, include: false }] });
    assert.equal(out.status, "mapping"); assert.ok(out.structure.reasons.some((r) => r.code === "item-column-excluded"));
  });
  test("a chosen column skips repeats within the file", async () => {
    const w = await world(), done = await importFile(w, xlsx([["Name", "Code"], ["A", "X"], ["B", "X"], ["C", "Y"], ["D", ""]]), { review: { uniqueColumn: 1 } });
    assert.deepEqual([done.imported, done.skippedDuplicates], [3, 1]);
  });
});

describe("Repeated files and jobs", () => {
  test("the same file while one is open goes back to that import, not a second job", async () => {
    const w = await world(), first = await w.jobs.createFromFile(w.ws, mondayFile(), { name: "m.xlsx" }, actor);
    await assert.rejects(w.jobs.createFromFile(w.ws, mondayFile(), { name: "renamed.xlsx" }, actor), (e) => e.code === "IMPORT_ALREADY_OPEN" && e.details.importId === first._id.toHexString());
    assert.equal(await w.db.collection(COLLECTIONS.importJobs).countDocuments({}), 1);
  });
  test("after it finished: flagged, refused without confirmation, and only then a second board", async () => {
    const w = await world(), done = await importFile(w, mondayFile());
    let again = await w.jobs.createFromFile(w.ws, mondayFile(), { name: "m.xlsx" }, actor);
    assert.equal(again.previousImport.imported, 3); assert.equal(again.previousImport.boardName, done.boardName);
    again = await w.jobs.review(again, {});
    await assert.rejects(w.jobs.startNewBoard(again, { confirmNewBoard: true }), (e) => e.code === "ALREADY_IMPORTED");
    again = await w.jobs.startNewBoard(again, { confirmNewBoard: true, repeat: true }); w.jobs.wake();
    const second = await finished(w.jobs, again._id);
    assert.notEqual(second.boardId.toHexString(), done.boardId.toHexString());
  });
  test("a cancelled file isn't treated as imported", async () => {
    const w = await world(), job = await w.jobs.createFromFile(w.ws, mondayFile(), { name: "m.xlsx" }, actor);
    await w.jobs.cancel(job);
    assert.equal((await w.jobs.createFromFile(w.ws, mondayFile(), { name: "m.xlsx" }, actor)).previousImport, null);
  });
  test("too many open at once is refused", async () => {
    const w = await world();
    for (let i = 0; i < 3; i += 1) await w.jobs.createFromFile(w.ws, xlsx([["Name", "N"], ["A", String(i)]]), { name: `${i}.xlsx` }, actor);
    await assert.rejects(w.jobs.createFromFile(w.ws, xlsx([["Name", "N"], ["A", "9"]]), { name: "9.xlsx" }, actor), (e) => e.code === "TOO_MANY_IMPORTS");
  });
});

describe("Recovery, cancelling and removing the board", () => {
  const big = (n = 250) => xlsx([["Name", "Code"], ...Array.from({ length: n }, (_, i) => [`Row ${i}`, `C${i}`])]);
  test("a job interrupted after making its board finds the same board and repeats no row", async () => {
    const w = await world(); let job = await w.jobs.createFromFile(w.ws, big(), { name: "b.xlsx" }, actor);
    job = await w.jobs.review(job, {}); job = await w.jobs.startNewBoard(job, { confirmNewBoard: true });
    w.jobs.stopWorker();
    // The server stopped right after the board and half of a batch were written.
    const b = await w.jobs.ensureBoard(job), first = await w.jobs.batches.findOne({ jobId: job._id, n: 0 }), now = new Date();
    await w.records.insertMany(first.rows.slice(1, 40).map(([line, cells], i) => ({ _id: new ObjectId(), workspaceId: w.ws._id, boardId: b._id, legacyId: `import:${job._id.toHexString()}:${line}`, values: { serial: cells[0], col_1: cells[1] }, groupId: b.groups[0].id, position: i, archived: false, pinned: false, createdBy: actor.userId, updatedBy: actor.userId, createdAt: now, updatedAt: now, version: 1 })));
    await w.jobs.jobs.updateOne({ _id: job._id }, { $set: { status: "running", leaseOwner: "gone", leaseUntil: new Date(Date.now() - 1000), boardId: null } });
    w.jobs.stopping = false; w.jobs.leaseMs = 60000; w.jobs.wake();
    const done = await finished(w.jobs, job._id);
    assert.equal(done.status, "done"); assert.equal(done.boardId.toHexString(), b._id.toHexString(), "the same board");
    assert.equal(await w.boards.countDocuments({ workspaceId: w.ws._id }), 1);
    const rows = await w.records.find({ boardId: b._id }).toArray();
    assert.equal(rows.length, 250); assert.equal(new Set(rows.map((r) => r.values.serial)).size, 250, "no row twice");
    assert.equal(done.imported, 250);
  });
  test("cancelling before starting leaves nothing behind", async () => {
    const w = await world(), job = await w.jobs.createFromFile(w.ws, big(), { name: "b.xlsx" }, actor);
    await w.jobs.cancel(job);
    assert.equal(await w.boards.countDocuments({}), 0); assert.equal(await w.jobs.batches.countDocuments({ jobId: job._id }), 0);
  });
  test("a stopped import's board can be removed; nothing else goes with it", async () => {
    const w = await world(), other = await w.s.boards.create(w.ws._id, { name: "Other", columns: [{ key: "serial", label: "Item", type: "text", required: true }] }, actor);
    await w.s.records.create(other._id, { values: { serial: "Keep" } }, actor, { everyone: true });
    const done = await importFile(w, big(120));
    const job = await removeBoard(w, done);
    assert.equal(job.status, "removed"); assert.equal(job.removedRecords, 120);
    assert.equal(await w.dl.repos.boards.findById(done.boardId), null);
    assert.equal(await w.records.countDocuments({ boardId: done.boardId }), 0);
    assert.equal(await w.records.countDocuments({ boardId: other._id }), 1, "the other board keeps its record");
  });
  test("a board someone has changed is refused: an edit, an added record or a comment", async () => {
    for (const change of [
      (w, b) => w.records.updateOne({ boardId: b }, { $inc: { version: 1 } }),
      (w, b) => w.s.records.create(b, { values: { serial: "Added by hand" } }, actor, { everyone: true }),
      (w, b) => w.db.collection(COLLECTIONS.comments).insertOne({ boardId: b, body: "hi" })
    ]) {
      const w = await world(), done = await importFile(w, mondayFile());
      await change(w, done.boardId);
      await assert.rejects(w.jobs.cleanUp(done, actor), (e) => e.code === "IMPORT_BOARD_CHANGED");
      assert.ok(await w.dl.repos.boards.findById(done.boardId), "still there");
    }
  });
  test("a removal continues after a restart, in batches, and something added meanwhile stops it with the board kept", async () => {
    const w = await world(), done = await importFile(w, big(450));
    w.jobs.stopWorker(); await sleep(20);
    await w.jobs.jobs.updateOne({ _id: done._id }, { $set: { status: "removing", removedBy: actor.userId, removedByName: "Importer", removedRecords: 0, leaseOwner: "gone", leaseUntil: new Date(Date.now() - 1000) } });
    const someone = await w.s.records.create(done.boardId, { values: { serial: "Added during the removal" } }, actor, { everyone: true });
    w.jobs.stopping = false; w.jobs.wake();
    let ended; for (let i = 0; i < 600; i += 1) { ended = await w.jobs.find(done._id); if (ended.status !== "removing") break; await sleep(10); }
    assert.equal(ended.status, "failed"); assert.match(ended.lastError, /changed this board/); assert.equal(ended.removedRecords, 450);
    assert.ok(await w.dl.repos.boards.findById(done.boardId), "the board stays");
    assert.ok(await w.records.findOne({ _id: someone._id }), "with what was added");
  });
  test("removal is refused while running, and for a board the job didn't make", async () => {
    const w = await world(); let job = await w.jobs.createFromFile(w.ws, mondayFile(), { name: "m.xlsx" }, actor);
    job = await w.jobs.review(job, {});
    await assert.rejects(w.jobs.cleanUp(job, actor), (e) => e.code === "IMPORT_RUNNING");
    const stranger = await w.s.boards.create(w.ws._id, { name: "Stranger", columns: [{ key: "serial", label: "Item", type: "text", required: true }] }, actor);
    await assert.rejects(w.jobs.cleanUp({ ...job, status: "failed", plannedBoardId: stranger._id }, actor), (e) => e.code === "IMPORT_BOARD_MISMATCH");
    assert.ok(await w.dl.repos.boards.findById(stranger._id));
  });
  test("a job never writes to a board it didn't make", async () => {
    const w = await world(); let job = await w.jobs.createFromFile(w.ws, mondayFile(), { name: "m.xlsx" }, actor);
    job = await w.jobs.review(job, {});
    const stranger = await w.s.boards.create(w.ws._id, { name: "Stranger", columns: [{ key: "serial", label: "Item", type: "text", required: true }] }, actor);
    await w.jobs.jobs.updateOne({ _id: job._id }, { $set: { plannedBoardId: stranger._id } });
    job = await w.jobs.startNewBoard(await w.jobs.find(job._id), { confirmNewBoard: true }); w.jobs.wake();
    const ended = await finished(w.jobs, job._id);
    assert.equal(ended.status, "failed"); assert.equal(await w.records.countDocuments({ boardId: stranger._id }), 0);
  });
  test("pause and resume carry on from where it was", async () => {
    const w = await world(); w.jobs.pauseMs = 20; let job = await w.jobs.createFromFile(w.ws, big(400), { name: "b.xlsx" }, actor);
    job = await w.jobs.review(job, {}); job = await w.jobs.startNewBoard(job, { confirmNewBoard: true }); w.jobs.wake();
    for (let i = 0; i < 200; i += 1) { if ((await w.jobs.find(job._id)).nextBatch >= 1) break; await sleep(10); }
    await w.jobs.pause(await w.jobs.find(job._id));
    assert.equal((await w.jobs.find(job._id)).status, "paused");
    await w.jobs.resume(await w.jobs.find(job._id));
    const done = await finished(w.jobs, job._id);
    assert.equal(done.status, "done"); assert.equal(await w.records.countDocuments({ boardId: done.boardId }), 400);
  });
  test("cancelling while a batch is being written: its count matches the rows it really left on the board", async () => {
    const w = await world(); let job = await w.jobs.createFromFile(w.ws, big(400), { name: "b.xlsx" }, actor);
    job = await w.jobs.review(job, {}); job = await w.jobs.startNewBoard(job, { confirmNewBoard: true });
    // Holds a batch's write open, so the cancel lands exactly while it's on its way.
    const realRun = w.jobs.runBatch.bind(w.jobs); let release, holding = false; const held = new Promise((r) => { release = r; });
    w.jobs.runBatch = async (...a) => { const out = await realRun(...a); if (!holding) { holding = true; await held; } return out; };
    w.jobs.wake();
    for (let i = 0; i < 300 && !holding; i += 1) await sleep(10);
    assert.equal(holding, true);
    const cancelled = await w.jobs.cancel(await w.jobs.find(job._id));
    assert.equal(cancelled.status, "cancelled");
    release();
    let ended; for (let i = 0; i < 300; i += 1) { ended = await w.jobs.find(job._id); if (ended.imported === await w.records.countDocuments({ boardId: ended.boardId }) && !w.jobs.running) break; await sleep(10); }
    const onBoard = await w.records.countDocuments({ boardId: ended.boardId });
    assert.ok(onBoard > 0); assert.equal(ended.imported, onBoard); assert.equal(ended.status, "cancelled");
  });
  // A file where some rows repeat a chosen column, and a stand-in for one row the last batch rejects, with that batch held open on request.
  const repeating = () => xlsx([["Name", "Code"], ...Array.from({ length: 450 }, (_, i) => [`Row ${i}`, i % 5 === 0 ? "SAME" : `C${i}`])]);
  const holdFirstBatch = (w) => { const real = w.jobs.runBatch.bind(w.jobs), hold = { holding: false }; const held = new Promise((r) => { hold.release = r; }); w.jobs.runBatch = async (...a) => { const out = await real(...a); if (!hold.holding) { hold.holding = true; out.errors.push({ row: 2, reason: "a stand-in rejection" }); hold.out = { skipped: out.skippedDuplicates, rejected: out.errors.length, imported: out.imported }; await held; } return out; }; return hold; };
  const startRepeating = async (w) => { let job = await w.jobs.createFromFile(w.ws, repeating(), { name: "r.xlsx" }, actor); job = await w.jobs.review(job, { uniqueColumn: 1 }); job = await w.jobs.startNewBoard(job, { confirmNewBoard: true }); const hold = holdFirstBatch(w); w.jobs.wake(); for (let i = 0; i < 300 && !hold.holding; i += 1) await sleep(10); assert.equal(hold.holding, true); return { job, hold }; };
  const idle = async (w) => { for (let i = 0; i < 300 && w.jobs.running; i += 1) await sleep(10); };
  test("cancelled mid-batch: that batch's skipped and rejected rows are counted, once", async () => {
    const w = await world(), { job, hold } = await startRepeating(w);
    assert.ok(hold.out.skipped > 0, "the batch has repeats");
    await w.jobs.cancel(await w.jobs.find(job._id)); hold.release(); await idle(w);
    const ended = await w.jobs.find(job._id);
    assert.equal(ended.skippedDuplicates, hold.out.skipped); assert.equal(ended.rejected, hold.out.rejected); assert.equal(ended.imported, hold.out.imported);
    assert.ok(ended.errors.some((e) => e.reason === "a stand-in rejection"), "and it's in the report"); assert.equal(ended.uncounted, undefined);
    assert.equal(await w.records.countDocuments({ boardId: ended.boardId }), ended.imported);
  });
  test("paused mid-batch, then cancelled: that batch's figures are applied when cancelling, once", async () => {
    const w = await world(), { job, hold } = await startRepeating(w);
    await w.jobs.pause(await w.jobs.find(job._id)); hold.release(); await idle(w);
    const paused = await w.jobs.find(job._id);
    assert.equal(paused.status, "paused"); assert.equal(paused.skippedDuplicates, 0, "not counted while it can still run again"); assert.equal(paused.uncounted.skippedDuplicates, hold.out.skipped);
    const ended = await w.jobs.cancel(paused);
    assert.equal(ended.skippedDuplicates, hold.out.skipped); assert.equal(ended.rejected, hold.out.rejected); assert.equal(ended.uncounted, undefined); assert.equal(ended.imported, await w.records.countDocuments({ boardId: ended.boardId }));
  });
  test("paused mid-batch, then resumed: that batch runs again and nothing is counted twice", async () => {
    const w = await world(), { job, hold } = await startRepeating(w);
    await w.jobs.pause(await w.jobs.find(job._id)); hold.release(); await idle(w);
    assert.ok((await w.jobs.find(job._id)).uncounted);
    w.jobs.runBatch = Object.getPrototypeOf(w.jobs).runBatch.bind(w.jobs);
    await w.jobs.resume(await w.jobs.find(job._id));
    const done = await finished(w.jobs, job._id), unique = 361; // 450 rows: 360 with a code of their own, plus the first "SAME"
    assert.equal(done.status, "done"); assert.equal(done.uncounted, undefined);
    assert.equal(done.imported, unique); assert.equal(done.skippedDuplicates, 450 - unique); assert.equal(done.imported + done.skippedDuplicates + done.rejected, 450, "every row counted once");
    assert.equal(await w.records.countDocuments({ boardId: done.boardId }), unique);
  });
  test("the board deleted while a batch is being written: the job fails, saying why, and leaves no rows behind", async () => {
    const w = await world(); let job = await w.jobs.createFromFile(w.ws, big(450), { name: "b.xlsx" }, actor);
    job = await w.jobs.review(job, {}); job = await w.jobs.startNewBoard(job, { confirmNewBoard: true });
    const real = w.jobs.runBatch.bind(w.jobs); let holding = false, release; const held = new Promise((r) => { release = r; });
    w.jobs.runBatch = async (...a) => { if (!holding) { holding = true; await held; } return real(...a); }; // the board goes just before this batch writes
    w.jobs.wake(); for (let i = 0; i < 300 && !holding; i += 1) await sleep(10);
    const running = await w.jobs.find(job._id), board = await w.dl.repos.boards.findById(running.boardId);
    await w.s.boards.delete(board._id, board.version, actor); release();
    const ended = await finished(w.jobs, job._id);
    assert.equal(ended.status, "failed"); assert.match(ended.lastError, /deleted/);
    assert.equal(await w.records.countDocuments({ boardId: running.boardId }), 0, "nothing is left on a board that no longer exists");
    assert.equal(await w.jobs.batches.countDocuments({ jobId: job._id }), 0);
  });
  test("pausing while a batch is being written doesn't count its rows twice after resuming", async () => {
    const w = await world(); let job = await w.jobs.createFromFile(w.ws, big(400), { name: "b.xlsx" }, actor);
    job = await w.jobs.review(job, {}); job = await w.jobs.startNewBoard(job, { confirmNewBoard: true });
    const realRun = w.jobs.runBatch.bind(w.jobs); let release, holding = false; const held = new Promise((r) => { release = r; });
    w.jobs.runBatch = async (...a) => { const out = await realRun(...a); if (!holding) { holding = true; await held; } return out; };
    w.jobs.wake();
    for (let i = 0; i < 300 && !holding; i += 1) await sleep(10);
    await w.jobs.pause(await w.jobs.find(job._id));
    release();
    for (let i = 0; i < 300 && w.jobs.running; i += 1) await sleep(10);
    const paused = await w.jobs.find(job._id), onBoard = await w.records.countDocuments({ boardId: paused.boardId });
    assert.equal(paused.status, "paused"); assert.ok(onBoard > paused.imported, "the batch landed after the counter stopped");
    await w.jobs.resume(paused);
    const done = await finished(w.jobs, job._id);
    assert.equal(done.status, "done"); assert.equal(done.imported, 400); assert.equal(await w.records.countDocuments({ boardId: done.boardId }), 400, "no row twice");
  });
  test("the search index reaches a new board's records and forgets a removed one", async () => {
    const w = await world({ search: "on" }); await w.dl.searchIndex.catchUp();
    const done = await importFile(w, mondayFile()); await w.dl.searchIndex.flush();
    assert.equal(await w.dl.repos.recordSearch.count({ boardId: done.boardId }), 3);
    await removeBoard(w, done); await w.dl.searchIndex.flush();
    assert.equal(await w.dl.repos.recordSearch.count({ boardId: done.boardId }), 0);
  });
});

describe("Reading doesn't hold up the app", () => {
  test("the worker thread loads only what reading needs, never the database driver", async () => {
    const { Worker } = require("worker_threads"), domain = path.join(__dirname, "../src/domain");
    const loaded = await new Promise((resolve, reject) => {
      const w = new Worker(`require(${JSON.stringify(path.join(domain, "spreadsheet"))}); require(${JSON.stringify(path.join(domain, "workbook-structure"))}); require("worker_threads").parentPort.postMessage(Object.keys(require.cache));`, { eval: true });
      w.once("message", (files) => { w.terminate(); resolve(files); }); w.once("error", reject);
    });
    assert.deepEqual(loaded.filter((f) => /node_modules/.test(f)), [], "no third-party package");
    assert.ok(loaded.length <= 3, `only the reading code: ${loaded.join(", ")}`);
  });
  test("a refused file still gets the usual API error", () => {
    const { ApiError } = require("../src/middleware/errors");
    assert.throws(() => readTable(Buffer.from("not a workbook"), { name: "x.xlsx" }), (e) => e instanceof ApiError && e.status === 422 && e.code === "IMPORT_UNREADABLE");
  });
  test("a wide file is read off the main thread: other work keeps running throughout", async () => {
    const w = await world(), rows = [Array.from({ length: 84 }, (_, c) => (c ? `Col ${c}` : "Name")), ...Array.from({ length: 6000 }, (_, r) => Array.from({ length: 84 }, (_, c) => `r${r}c${c}`))];
    let longest = 0, last = Date.now(), reading = true;
    const tick = () => { const now = Date.now(); longest = Math.max(longest, now - last); last = now; if (reading) setTimeout(tick, 5); };
    const file = xlsx(rows); last = Date.now(); tick();
    const job = await w.jobs.createFromFile(w.ws, file, { name: "wide.xlsx" }, actor);
    reading = false;
    assert.equal(job.validation.records, 6000); assert.equal(job.columns.length, 84);
    assert.ok(longest < 500, `the main thread stalled for ${longest} ms`);
  });
  test("a file that can't be read is a clear refusal, and the worker leaves nothing stored", async () => {
    const w = await world();
    await assert.rejects(w.jobs.createFromFile(w.ws, Buffer.from("not a workbook"), { name: "x.xlsx" }, actor), (e) => e.code === "IMPORT_UNREADABLE" && /readable Excel/.test(e.message));
    await assert.rejects(w.jobs.createFromFile(w.ws, Buffer.from('"never ends'), { name: "x.csv" }, actor), (e) => /never ends/.test(e.message));
    assert.equal(await w.jobs.batches.countDocuments({}), 0); assert.equal(await w.db.collection(COLLECTIONS.importJobs).countDocuments({}), 0);
  });
  test("only a couple of files are read at once", async () => {
    const w = await world(); w.jobs.reading = 2;
    await assert.rejects(w.jobs.createFromFile(w.ws, mondayFile(), { name: "m.xlsx" }, actor), (e) => e.code === "IMPORT_BUSY");
    w.jobs.reading = 0;
  });
});

describe("The import API", () => {
  let allowed, board, ws;
  const raw = (app, method, p, body, type = "application/octet-stream") => fetch(`${app.url}/api/v1${p}`, { method, headers: { "Content-Type": type, "X-Requested-With": "x" }, body });
  before(async () => {
    allowed = await startMongoApp({ app: { features: { spreadsheetImports: true } } });
    Object.assign(allowed.dataLayer.services.importJobs, { pauseMs: 0, writePauseMs: 0, removePauseMs: 0 });
    ws = (await api(allowed.url, "POST", "/api/v1/workspaces", { name: "W" })).body.workspace;
    board = (await api(allowed.url, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Existing", columns: [{ key: "serial", label: "Item", type: "text", required: true }] })).body.board;
  });
  after(async () => { await allowed?.close(); });
  test("existing boards are refused", async () => {
    for (const [m, p] of [["GET", `/boards/${board.id}/imports`], ["POST", `/boards/${board.id}/imports`]]) { const r = await api(allowed.url, m, `/api/v1${p}`, m === "GET" ? undefined : {}); assert.equal(r.status, 403); assert.equal(r.body.error.code, "IMPORT_NEW_BOARDS_ONLY"); }
    assert.deepEqual((await api(allowed.url, "GET", "/api/v1/features")).body.features.spreadsheetImports, true);
  });
  test("the whole journey through the API, and a report as a download", async () => {
    const up = await raw(allowed, "POST", `/workspaces/${ws.id}/imports?name=Installations.xlsx`, mondayFile());
    assert.equal(up.status, 201); const { import: job } = await up.json();
    assert.equal(job.target, "new-board"); assert.equal(job.boardId, null); assert.equal(job.validation.records, 3); assert.equal(job.structure.boardTitle, "Installations");
    const listed = (await api(allowed.url, "GET", `/api/v1/workspaces/${ws.id}/imports`)).body.items;
    assert.ok(listed.some((j) => j.id === job.id));
    assert.equal((await api(allowed.url, "POST", `/api/v1/imports/${job.id}/start`, {})).status, 409, "not checked yet");
    const reviewed = await api(allowed.url, "PATCH", `/api/v1/imports/${job.id}`, { boardName: "From the API" });
    assert.equal(reviewed.body.import.status, "ready");
    assert.equal((await api(allowed.url, "POST", `/api/v1/imports/${job.id}/start`, {})).status, 409, "no confirmation");
    assert.equal((await api(allowed.url, "POST", `/api/v1/imports/${job.id}/start`, { confirmNewBoard: true })).status, 200);
    let state; for (let i = 0; i < 300; i += 1) { state = (await api(allowed.url, "GET", `/api/v1/imports/${job.id}`)).body.import; if (!["queued", "running"].includes(state.status)) break; await sleep(10); }
    assert.equal(state.status, "done"); assert.equal(state.imported, 3);
    const created = (await api(allowed.url, "GET", `/api/v1/boards/${state.boardId}`)).body.board;
    assert.equal(created.name, "From the API"); assert.equal(created.importJobId, undefined, "internal");
    const report = await fetch(`${allowed.url}/api/v1/imports/${job.id}/report`);
    assert.match(report.headers.get("content-type"), /text\/csv/); assert.match(report.headers.get("content-disposition"), /attachment/);
    const removed = await api(allowed.url, "POST", `/api/v1/imports/${job.id}/remove-board`, {});
    assert.equal(removed.status, 200); assert.equal(removed.body.import.status, "removing");
    for (let i = 0; i < 300; i += 1) { state = (await api(allowed.url, "GET", `/api/v1/imports/${job.id}`)).body.import; if (state.status !== "removing") break; await sleep(10); }
    assert.equal(state.status, "removed"); assert.equal(state.removedRecords, 3);
    assert.equal((await api(allowed.url, "GET", `/api/v1/boards/${state.boardId}`)).status, 404);
  });
  test("the tracker's view: started imports only, small, with the board's real count; a board carries its count too", async () => {
    const list = async () => (await api(allowed.url, "GET", `/api/v1/workspaces/${ws.id}/imports?view=progress`)).body.items;
    const up = await raw(allowed, "POST", `/workspaces/${ws.id}/imports?name=progress.csv`, "Name,Code\nP1,1\nP2,2\n"), { import: job } = await up.json();
    assert.equal((await list()).some((j) => j.id === job.id), false, "not started yet");
    await api(allowed.url, "PATCH", `/api/v1/imports/${job.id}`, {}); await api(allowed.url, "POST", `/api/v1/imports/${job.id}/start`, { confirmNewBoard: true });
    let item; for (let i = 0; i < 300; i += 1) { item = (await list()).find((j) => j.id === job.id); if (item?.status === "done") break; await sleep(10); }
    assert.equal(item.status, "done"); assert.equal(item.imported, 2); assert.equal(item.recordsOnBoard, 2); assert.ok(item.updatedAt); assert.equal(item.rowCount, 2);
    for (const heavy of ["structure", "validation", "columns", "mapping"]) assert.equal(item[heavy], undefined, heavy);
    assert.equal((await api(allowed.url, "GET", `/api/v1/boards/${item.boardId}`)).body.board.recordCount, 2);
    assert.equal((await api(allowed.url, "GET", `/api/v1/workspaces/${ws.id}/imports?view=other`)).status, 400);
    assert.equal((await api(allowed.url, "GET", `/api/v1/workspaces/${ws.id}/imports?other=1`)).status, 400);
    await api(allowed.url, "POST", `/api/v1/imports/${job.id}/remove-board`, {});
    for (let i = 0; i < 300; i += 1) { item = (await list()).find((j) => j.id === job.id); if (item.status === "removed") break; await sleep(10); }
    assert.equal(item.recordsOnBoard, null, "no board left to count");
  });
  test("an oversized file is refused", async () => {
    assert.equal((await raw(allowed, "POST", `/workspaces/${ws.id}/imports?name=x.csv`, Buffer.alloc(26 * 1024 * 1024, 65))).status, 413);
  });
});

describe("Access and screens, with Microsoft sign-in (real app, headless browser, role_based)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  const OIDS = { ann: "0d0d0d0d-0000-4000-8000-0000000000a1", ben: "0d0d0d0d-0000-4000-8000-0000000000a2", vic: "0d0d0d0d-0000-4000-8000-0000000000a3", out: "0d0d0d0d-0000-4000-8000-0000000000a4", root: "0d0d0d0d-0000-4000-8000-0000000000a5" };
  let server, base, ws, files; const browsers = {};
  const signIn = (b, who, isAdmin) => b.evaluate(`(async () => { const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${who}&email=${who}@example.invalid&admin=${isAdmin ? 1 : 0}&nonce=" + start.nonce)).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); })()`);
  const call = (who, method, p, body) => browsers[who].evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1" + ${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))}`} }); return { status: r.status, body: await r.json().catch(() => null) }; })()`);
  const uploadAs = (who, text, name) => browsers[who].evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1/workspaces/${ws.id}/imports?name=${name}", { method: "POST", headers: { "Content-Type": "text/csv", "X-CSRF-Token": csrfToken }, body: ${JSON.stringify(text)} }); return { status: r.status, body: await r.json().catch(() => null) }; })()`);
  const pickFile = (b, base64, name) => b.evaluate(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0)); const input = document.querySelector('#xl-import-file'); const dt = new DataTransfer(); dt.items.add(new File([bytes], ${JSON.stringify(name)})); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const click = (b, sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  // A step that never arrives fails right there, saying what the page showed instead, rather than as a confusing error further on.
  const reached = async (b, sel, ms) => assert.ok(await b.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, ms), `${sel}: ${JSON.stringify(await b.evaluate("({ wizard: document.querySelector('.xl-wizard')?.className, toast: document.querySelector('#toast-region')?.textContent, overlay: document.querySelector('#overlay-root')?.textContent.slice(0, 200) })"))}`);
  // One test's unfinished import mustn't change what the next one sees. What finished stays: "the same file again" relies on it.
  afterEach(async () => {
    const { body } = await call("ann", "GET", `/workspaces/${ws.id}/imports`);
    for (const j of body?.items || []) if (["mapping", "ready", "queued", "running", "paused"].includes(j.status)) await call("ann", "POST", `/imports/${j.id}/cancel`, {});
  });
  before(async () => {
    const port = await freePort(); base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    for (const who of Object.keys(OIDS)) { browsers[who] = await launch(BROWSER); await browsers[who].open(`${base}/api/v1/health`, { width: 1440, height: 900 }); await signIn(browsers[who], who, who === "root"); }
    ws = (await call("root", "POST", "/workspaces", { name: "Imports" })).body.workspace;
    for (const [who, role] of [["ann", "MEMBER"], ["ben", "MEMBER"], ["vic", "VIEWER"]]) assert.equal((await call("root", "POST", `/workspaces/${ws.id}/members`, { userId: (await call(who, "GET", "/me")).body.user.id, role })).status, 201, who);
    await call("ann", "POST", `/workspaces/${ws.id}/boards`, { name: "Existing", columns: [{ key: "serial", label: "Item", type: "text", required: true }] });
    files = { monday: mondayFile().toString("base64") };
  });
  after(async () => { for (const b of Object.values(browsers)) await b?.close(); server?.kill(); });
  test("JARC's usual rules decide: a member may import, a viewer may not, and an outsider can't see the workspace", async () => {
    for (const who of ["ann", "ben"]) assert.equal((await call(who, "GET", `/workspaces/${ws.id}/imports`)).status, 200, who);
    assert.equal((await uploadAs("vic", "Name,Code\nA,1\n", "v.csv")).status, 403, "a viewer can't upload");
    assert.equal((await uploadAs("out", "Name,Code\nA,1\n", "o.csv")).status, 404, "an outsider can't see it");
    assert.equal((await call("vic", "GET", `/workspaces/${ws.id}/imports`)).status, 403);
    assert.equal((await call("out", "GET", `/workspaces/${ws.id}/imports`)).status, 404);
  });
  test("an import is its owner's and the workspace admins': another member can't see or control it", async () => {
    const up = await uploadAs("ann", "Name,Code\nOwned,1\n", "owned.csv"); assert.equal(up.status, 201);
    const id = up.body.import.id;
    for (const [m, p, body] of [["GET", `/imports/${id}`], ["PATCH", `/imports/${id}`, {}], ["GET", `/imports/${id}/report`], ["POST", `/imports/${id}/start`, { confirmNewBoard: true }], ["POST", `/imports/${id}/cancel`, {}], ["POST", `/imports/${id}/remove-board`, {}]]) {
      assert.equal((await call("ben", m, p, body)).status, 404, `${m} ${p} as another member`);
      assert.equal((await call("out", m, p, body)).status, 404, `${m} ${p} as an outsider`);
    }
    assert.equal((await call("ben", "GET", `/workspaces/${ws.id}/imports`)).body.items.some((j) => j.id === id), false, "not in another member's list");
    assert.equal((await call("ann", "GET", `/workspaces/${ws.id}/imports`)).body.items.some((j) => j.id === id), true, "in the owner's");
    assert.equal((await call("root", "GET", `/workspaces/${ws.id}/imports`)).body.items.some((j) => j.id === id), true, "in an administrator's");
    assert.equal((await call("root", "GET", `/imports/${id}`)).status, 200, "a JARC administrator can");
    assert.equal((await call("ann", "POST", `/imports/${id}/cancel`, {})).status, 200);
  });
  test("no session: 401 on every route", async () => {
    const id = "0".repeat(24);
    for (const [m, p] of [["GET", `/workspaces/${ws.id}/imports`], ["POST", `/workspaces/${ws.id}/imports`], ["GET", `/boards/${id}/imports`], ["POST", `/boards/${id}/imports`], ["GET", `/imports/${id}`], ["PATCH", `/imports/${id}`], ["GET", `/imports/${id}/report`], ["POST", `/imports/${id}/start`], ["POST", `/imports/${id}/pause`], ["POST", `/imports/${id}/resume`], ["POST", `/imports/${id}/cancel`], ["POST", `/imports/${id}/remove-board`]]) assert.equal((await fetch(`${base}/api/v1${p}`, { method: m })).status, 401, `${m} ${p}`);
  });
  test("a CSRF token is required to upload", async () => {
    assert.equal(await browsers.ann.evaluate(`(async () => (await fetch("/api/v1/workspaces/${ws.id}/imports?name=x.csv", { method: "POST", headers: { "Content-Type": "text/csv" }, body: "Name,Code\\nA,1\\n" })).status)()`), 403);
  });
  const openApp = async (b, width = 1440) => {
    await b.open(`${base}/`, { width, height: 900 });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000));
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Existing"))?.click()`);
    assert.ok(await b.waitFor("!!document.querySelector('.board-tools')", 10000));
  };
  // The ways in: a board's Import dialog, and Home's Import data. The sidebar has neither button.
  const startWizard = async (b) => {
    assert.equal(await click(b, "[data-action=import]"), true, "the board's Import button"); await reached(b, ".import-modal", 5000);
    assert.equal(await click(b, "[data-action=xl-import-new]"), true, "offered in the Import dialog");
    assert.ok(await b.waitFor("!!document.querySelector('#xl-import-file')", 5000), "the upload step");
  };
  const goHome = async (b) => { await click(b, ".nav-item[data-screen=home]"); assert.ok(await b.waitFor("!!document.querySelector('.page-head [data-action=new-board]')", 10000), "Home"); };
  const homeChooser = async (b) => { assert.equal(await click(b, "[data-action=home-import]"), true); assert.ok(await b.waitFor("!!document.querySelector('.choice-list')", 5000), "Home's Import data"); };
  const sidebarHasNoBoardButtons = (b) => b.evaluate("!document.querySelector('#sidebar [data-action=new-board], #sidebar [data-action=xl-import-new]')");
  test("a viewer isn't offered the import, anywhere", async () => {
    const b = browsers.vic; await openApp(b);
    assert.equal(await b.evaluate("!!document.querySelector('[data-action=xl-import-new]')"), false);
    await goHome(b); await homeChooser(b);
    assert.equal(await b.evaluate("!!document.querySelector('[data-action=xl-import-new]')"), false, "nor in Home's Import data");
    await click(b, "#overlay-root [data-action=close-overlay]");
  });
  test("with the feature off, nobody is offered it and its routes don't exist", async () => {
    const port = await freePort(), off = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore", env: { ...process.env, JARC_TEST_FEATURES: "off" } });
    try {
      await waitForServer(`http://localhost:${port}`, { child: off });
      const b = await launch(BROWSER);
      try {
        await b.open(`http://localhost:${port}/api/v1/health`, { width: 1440, height: 900 }); await signIn(b, "root", true);
        const made = await b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1/workspaces", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ name: "Off" }) }); return (await r.json()).workspace.id; })()`);
        assert.equal(await b.evaluate(`(async () => (await fetch("/api/v1/workspaces/${made}/imports")).status)()`), 404);
        await b.send("Page.navigate", { url: `http://localhost:${port}/` }); assert.ok(await b.waitFor("!!document.querySelector('.page-head [data-action=new-board]')", 15000));
        assert.equal(await b.evaluate("!!document.querySelector('[data-action=xl-import-new]')"), false);
        assert.equal(await b.evaluate("document.querySelector('[data-action=home-import]').disabled"), true, "with no boards and no wizard, Home's Import data has nothing to offer");
      } finally { await b.close(); }
    } finally { off.kill(); }
  });
  test("on screen, step by step: upload, what's found, columns, the check, explicit confirmation, a new board", async () => {
    const b = browsers.ann; await openApp(b);
    await startWizard(b);
    await pickFile(b, files.monday, "Installations.xlsx");
    assert.ok(await b.waitFor("!!document.querySelector('.xl-step-structure')", 15000), "what's in the file");
    const found = await b.evaluate("document.querySelector('.xl-step-structure').textContent");
    assert.match(found, /3\s*records/); assert.match(found, /2\s*groups/); assert.match(found, /5\s*columns/); assert.match(found, /North region/); assert.match(found, /South region/);
    await click(b, "[data-action=xl-import-structure]");
    assert.ok(await b.waitFor("!!document.querySelector('.xl-step-columns')", 10000), "columns");
    assert.match(await b.evaluate("document.querySelector('.xl-map .is-main').textContent"), /Name[\s\S]*Item column/, "Name goes to the Item column");
    assert.equal(await b.evaluate("document.querySelector('[name=boardName]').value"), "Installations");
    assert.equal(await b.evaluate("document.querySelector('[name=\"type:1\"]').value"), "text", "text by default");
    await click(b, "[data-action=xl-import-columns]");
    assert.ok(await b.waitFor("!!document.querySelector('.xl-step-check')", 10000), `the check: ${JSON.stringify(await b.evaluate("({ wizard: document.querySelector('.xl-wizard')?.className, toast: document.querySelector('#toast-region')?.textContent, overlay: document.querySelector('#overlay-root')?.textContent.slice(0, 200) })"))}`);
    const checked = await b.evaluate("document.querySelector('.xl-step-check').textContent");
    assert.match(checked, /Every row can be imported/); assert.match(checked, /00123/, "the preview shows the value as written"); assert.match(checked, /doesn't hold updates/, "says what a workbook lacks");
    await b.evaluate(`document.querySelector('[data-step=confirm]').click()`);
    assert.ok(await b.waitFor("!!document.querySelector('.xl-step-confirm')", 5000));
    assert.equal(await b.evaluate("document.querySelector('[data-action=xl-import-start]').disabled"), true, "can't start without confirming");
    await click(b, "[name=confirmNewBoard]");
    assert.equal(await b.evaluate("document.querySelector('[data-action=xl-import-start]').disabled"), false);
    await click(b, "[data-action=xl-import-start]");
    assert.ok(await b.waitFor("document.querySelector('.xl-step-run h2')?.textContent === 'Import finished'", 20000), "finished");
    assert.match(await b.evaluate("document.querySelector('.xl-step-run').textContent"), /3\s*imported/);
    await click(b, "[data-action=xl-import-open-board]");
    assert.ok(await b.waitFor("[...document.querySelectorAll('tr[data-record-context]')].some((r) => r.textContent.includes('Machine C'))", 15000), "the new board opens with its records");
    assert.equal(await b.evaluate("[...document.querySelectorAll('tr[data-record-context]')].some((r) => /^\\s*(Name|North region)\\b/.test(r.textContent))"), false);
    assert.ok(await b.waitFor("[...document.querySelectorAll('.group-name')].map((g) => g.textContent).join('|').includes('South region')", 5000), "with its groups");
  });
  test("on screen: the same file again needs its own confirmation", async () => {
    const b = browsers.ann; await openApp(b);
    await startWizard(b);
    await pickFile(b, files.monday, "Installations again.xlsx");
    await reached(b, ".xl-step-structure", 15000);
    await click(b, "[data-action=xl-import-structure]"); await reached(b, ".xl-step-columns", 10000);
    await click(b, "[data-action=xl-import-columns]"); await reached(b, ".xl-step-check", 10000);
    await b.evaluate(`document.querySelector('[data-step=confirm]').click()`); await reached(b, ".xl-step-confirm", 5000);
    assert.match(await b.evaluate("document.querySelector('.xl-step-confirm').textContent"), /already imported/);
    await click(b, "[name=confirmNewBoard]");
    assert.equal(await b.evaluate("document.querySelector('[data-action=xl-import-start]').disabled"), true, "one checkbox isn't enough");
    await click(b, "[name=repeat]");
    assert.equal(await b.evaluate("document.querySelector('[data-action=xl-import-start]').disabled"), false);
    await click(b, "[data-action=xl-import-cancel]");
    assert.ok(await b.waitFor("!document.querySelector('.xl-wizard')", 5000), "cancelled before anything was created");
  });
  test("on screen: a problem blocks importing and offers the full list", async () => {
    const b = browsers.ann; await openApp(b);
    await startWizard(b);
    await pickFile(b, xlsx([["Name", "Code"], ["A", "1"], ["", "no name here"]]).toString("base64"), "bad.xlsx");
    await reached(b, ".xl-step-structure", 15000);
    await click(b, "[data-action=xl-import-structure]"); await reached(b, ".xl-step-columns", 10000);
    await click(b, "[data-action=xl-import-columns]"); await reached(b, ".xl-step-check", 10000);
    assert.match(await b.evaluate("document.querySelector('.xl-step-check').textContent"), /Row 3: Name has no name/);
    assert.equal(await b.evaluate("document.querySelector('[data-step=confirm]').disabled"), true);
    assert.equal(await b.evaluate("!!document.querySelector('[data-action=xl-import-report]')"), true);
    await click(b, "[data-action=xl-import-cancel]");
  });
  // Holds this browser's next PATCH until told to continue (or to fail), counting how many were sent.
  const holdPatches = (b, outcome = "pass") => b.evaluate(`(() => { const real = window.__realFetch ||= window.fetch; window.__patches = 0; window.__release = null; window.fetch = (url, options) => { if (options?.method !== "PATCH") return real(url, options); window.__patches += 1; return new Promise((resolve) => { window.__release = () => resolve(${outcome === "fail" ? `new Response(JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "Test refusal." } }), { status: 400, headers: { "Content-Type": "application/json" } })` : "real(url, options)"}); }); }; })()`);
  const toColumns = async (b, name, rows) => {
    await openApp(b); await startWizard(b);
    await pickFile(b, xlsx(rows).toString("base64"), name); await reached(b, ".xl-step-structure", 15000);
    await click(b, "[data-action=xl-import-structure]"); await reached(b, ".xl-step-columns", 10000);
  };
  test("on screen: while every row is checked, the window says so, and pressing again sends nothing", async () => {
    const b = browsers.ann; await toColumns(b, "busy.xlsx", [["Name", "Code"], ["Busy", "1"]]);
    assert.equal(await b.evaluate("document.querySelector('.xl-wizard').getAttribute('aria-busy')"), null, "not busy yet");
    await holdPatches(b);
    await click(b, "[data-action=xl-import-columns]");
    assert.ok(await b.waitFor("window.__patches === 1", 5000));
    assert.match(await b.evaluate("document.querySelector('.xl-working[role=status]')?.textContent"), /Checking every row/, "it says what's happening");
    assert.equal(await b.evaluate("!!document.querySelector('.xl-working .loading-spinner')"), true);
    assert.equal(await b.evaluate("document.querySelector('.xl-wizard').getAttribute('aria-busy')"), "true");
    assert.equal(await b.evaluate("document.querySelector('[data-action=xl-import-columns]').classList.contains('is-busy')"), true);
    for (const sel of ["[data-action=xl-import-columns]", "[data-action=xl-import-cancel]", "[data-step=structure]", "[name=boardName]", "[name=uniqueColumn]"]) assert.equal(await b.evaluate(`document.querySelector(${JSON.stringify(sel)}).disabled`), true, sel);
    for (let i = 0; i < 3; i += 1) await click(b, "[data-action=xl-import-columns]");
    await b.evaluate("document.querySelector('[data-action=xl-import-columns]').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
    await sleep(150);
    assert.equal(await b.evaluate("window.__patches"), 1, "only one request");
    await b.evaluate("window.__release()");
    await reached(b, ".xl-step-check", 10000);
    assert.equal(await b.evaluate("!!document.querySelector('.xl-working')"), false, "it's gone once the step is done");
    await click(b, "[data-action=xl-import-cancel]");
  });
  test("on screen: if the check fails, the window comes back as it was, with what was typed", async () => {
    const b = browsers.ann; await toColumns(b, "refused.xlsx", [["Name", "Code"], ["Refused", "1"]]);
    await b.evaluate("document.querySelector('[name=boardName]').value = 'My own name'");
    assert.equal(await b.evaluate("document.querySelector('.is-main [name^=type]').disabled"), true, "already disabled before");
    await holdPatches(b, "fail");
    await click(b, "[data-action=xl-import-columns]"); assert.ok(await b.waitFor("window.__patches === 1", 5000));
    await b.evaluate("window.__release()");
    assert.ok(await b.waitFor("!document.querySelector('.xl-working')", 5000), "no longer working");
    assert.equal(await b.evaluate("document.querySelector('.xl-wizard').getAttribute('aria-busy')"), null);
    assert.equal(await b.evaluate("document.querySelector('[data-action=xl-import-columns]').disabled"), false, "it can be tried again");
    assert.equal(await b.evaluate("document.querySelector('[name=boardName]').value"), "My own name");
    assert.equal(await b.evaluate("document.querySelector('.is-main [name^=type]').disabled"), true, "what was disabled before stays so");
    assert.equal(await b.evaluate("!!document.querySelector('.xl-step-columns')"), true);
    await click(b, "[data-action=xl-import-cancel]");
  });
  test("on screen: closing the window while it checks doesn't bring it back afterwards", async () => {
    const b = browsers.ann; await toColumns(b, "closed.xlsx", [["Name", "Code"], ["Closed", "1"]]);
    await holdPatches(b);
    await click(b, "[data-action=xl-import-columns]"); assert.ok(await b.waitFor("window.__patches === 1", 5000));
    await b.key("Escape");
    assert.ok(await b.waitFor("!document.querySelector('.xl-wizard')", 5000), "closed");
    await b.evaluate("window.__release()");
    await sleep(800);
    assert.equal(await b.evaluate("!!document.querySelector('.xl-wizard')"), false, "still closed");
  });
  test("on a phone: the steps fit, with no sideways scrolling of the page", async () => {
    const b = browsers.ann; await openApp(b, 390);
    await goHome(b); await homeChooser(b);
    assert.equal(await click(b, ".choice-list [data-action=xl-import-new]"), true); assert.ok(await b.waitFor("!!document.querySelector('#xl-import-file')", 5000), "the upload step");
    await pickFile(b, xlsx([["Name", "Code", "Site"], ["P1", "1", "x"]]).toString("base64"), "phone.xlsx");
    await reached(b, ".xl-step-structure", 15000);
    await click(b, "[data-action=xl-import-structure]"); await reached(b, ".xl-step-columns", 10000);
    assert.equal(await b.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
    assert.ok(await b.evaluate("document.querySelector('.xl-wizard').getBoundingClientRect().width <= window.innerWidth"));
    await click(b, "[data-action=xl-import-cancel]");
  });
  test("the sidebar has no board buttons, while its other controls and the boards stay", async () => {
    for (const [width, label] of [[1440, "desktop"], [390, "phone"]]) {
      const b = browsers.ann; await openApp(b, width);
      assert.equal(await sidebarHasNoBoardButtons(b), true, label);
      assert.equal(await b.evaluate("[...document.querySelectorAll('#sidebar .tree-item')].some((el) => el.textContent.includes('Existing'))"), true, `${label}: the boards`);
      for (const sel of [".nav-item[data-screen=home]", ".nav-item[data-screen=mywork]", "#sidebar [data-action=command-palette]", "#sidebar [data-action=workspace-menu]", "#sidebar [data-action=board-menu]", "#sidebar [data-action=create-workspace]"]) assert.equal(await b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`), true, `${label}: ${sel}`);
    }
  });
  test("a new board is still made from Home, once, and from the command palette", async () => {
    const b = browsers.ann; await openApp(b); await goHome(b);
    assert.equal(await b.evaluate("document.querySelectorAll('[data-action=new-board]').length"), 1, "one button on Home");
    await click(b, ".page-head [data-action=new-board]"); await reached(b, "#overlay-root .modal [name=name]", 5000);
    await b.evaluate("(() => { const form = document.querySelector('#overlay-root form'); form.querySelector('[name=name]').value = 'Made from Home'; form.requestSubmit(); })()");
    assert.ok(await b.waitFor("[...document.querySelectorAll('#sidebar .tree-item')].some((el) => el.textContent.includes('Made from Home'))", 10000), "it's in the sidebar");
    await goHome(b);
    await click(b, "#sidebar [data-action=command-palette]"); await reached(b, ".command-modal", 5000);
    assert.ok(await b.waitFor("!!document.querySelector('[data-command=new-board]')", 5000), "Create board in the palette");
    await b.key("Escape");
  });
  test("Home's Import data offers a new board from a file, above the existing boards", async () => {
    const b = browsers.ann; await openApp(b); await goHome(b); await homeChooser(b);
    assert.equal(await b.evaluate("document.querySelector('.choice-list > button').dataset.action"), "xl-import-new", "first in the list");
    assert.match(await b.evaluate("document.querySelector('.choice-list [data-action=xl-import-new]').textContent"), /New board from a file[\s\S]*Excel or CSV/);
    assert.equal(await b.evaluate("document.querySelectorAll('.choice-list [data-action=xl-import-new]').length"), 1);
    assert.equal(await b.evaluate("document.querySelectorAll('.choice-list [data-action=choose-board-action]').length > 0"), true, "importing into a board is still there");
    await click(b, ".choice-list [data-action=xl-import-new]"); assert.ok(await b.waitFor("!!document.querySelector('#xl-import-file')", 5000), "the wizard's upload step");
    await click(b, "#overlay-root [data-action=close-overlay]");
  });
  // ---- The progress tracker.
  const csv = (prefix, n) => `Name,Code\n${Array.from({ length: n }, (_, i) => `${prefix} ${i},${prefix}${i}`).join("\n")}\n`;
  const startImport = async (who, prefix, n) => {
    const up = await uploadAs(who, csv(prefix, n), `${prefix}.csv`); assert.equal(up.status, 201, JSON.stringify(up.body));
    const id = up.body.import.id;
    assert.equal((await call(who, "PATCH", `/imports/${id}`, {})).status, 200);
    assert.equal((await call(who, "POST", `/imports/${id}/start`, { confirmNewBoard: true })).status, 200);
    return id;
  };
  const jobOf = async (who, id) => (await call(who, "GET", `/imports/${id}`)).body.import;
  const until = async (who, id, test, ms = 60000) => { const end = Date.now() + ms; for (;;) { const j = await jobOf(who, id); if (test(j)) return j; if (Date.now() > end) throw new Error(`waited too long: ${j.status} ${j.imported}`); await sleep(100); } };
  const trackerText = (b) => b.evaluate("document.querySelector('.import-tracker:not([hidden])')?.textContent.replace(/\\s+/g, ' ') || ''");
  const clearTracker = (b) => b.evaluate("(() => { try { localStorage.removeItem('jarc-import-tracker-minimized'); } catch {} })()");
  const badgeOf = (b, name) => b.evaluate(`[...document.querySelectorAll('#sidebar .board-nav')].find((n) => n.textContent.includes(${JSON.stringify(name)}))?.querySelector('.nav-count')?.textContent`);
  // Clears what earlier tests finished, after the tracker has had its first look at the server.
  const dismissAll = async (b) => {
    await sleep(800);
    for (let i = 0; i < 30; i += 1) {
      await b.evaluate("document.querySelector('.import-tracker [data-xt=toggle][aria-expanded=false]')?.click()");
      if (!await click(b, ".import-tracker [data-xt=dismiss]")) return;
      await sleep(30);
    }
  };
  test("the tracker: from the wizard's Close to a finished board, through a refresh, with the sidebar's count following", async () => {
    const b = browsers.ann; await clearTracker(b); await openApp(b); await dismissAll(b);
    await startWizard(b); await pickFile(b, Buffer.from(csv("Tracked", 1200)).toString("base64"), "Tracked.csv"); await reached(b, ".xl-step-structure", 15000);
    await click(b, "[data-action=xl-import-structure]"); await reached(b, ".xl-step-columns", 10000);
    await click(b, "[data-action=xl-import-columns]"); await reached(b, ".xl-step-check", 10000);
    await b.evaluate("document.querySelector('[data-step=confirm]').click()"); await reached(b, ".xl-step-confirm", 5000);
    await click(b, "[name=confirmNewBoard]"); await click(b, "[data-action=xl-import-start]"); await reached(b, ".xl-step-run", 10000);
    const id = (await call("ann", "GET", `/workspaces/${ws.id}/imports?view=progress`)).body.items[0].id;
    await click(b, ".xl-step-run [data-action=close-overlay]");
    assert.ok(await b.waitFor("!document.querySelector('.xl-wizard')", 5000), "the window closed");
    assert.ok(await b.waitFor("/Tracked/.test(document.querySelector('.import-tracker:not([hidden])')?.textContent || '')", 10000), "the tracker stays");
    assert.ok(await b.waitFor("/(Preparing|Importing) [\\d,]+ \\/ 1,200 \\(\\d+%\\)/.test(document.querySelector('.import-tracker').textContent.replace(/\\s+/g, ' '))", 10000), await trackerText(b));
    assert.notEqual((await jobOf("ann", id)).status, "cancelled", "closing never stops it");
    // The right job reopens from the tracker.
    await click(b, ".import-tracker [data-xt=open]"); await reached(b, ".xl-step-run", 5000);
    assert.match(await b.evaluate("document.querySelector('.xl-step-run').textContent"), /Tracked\.csv/);
    await click(b, ".xl-step-run [data-action=close-overlay]");
    // It stays through navigation, the same card, and keeps moving.
    await b.evaluate("window.__card = document.querySelector('.import-tracker')");
    for (const [sel, ready] of [[".nav-item[data-screen=mywork]", ".nav-item[data-screen=mywork].active"], [".nav-item[data-screen=home]", ".page-head [data-action=new-board]"], ["#sidebar .board-nav .tree-item", ".board-tools"]]) {
      await click(b, sel); assert.ok(await b.waitFor(`!!document.querySelector(${JSON.stringify(ready)})`, 10000), ready);
      assert.equal(await b.evaluate("window.__card === document.querySelector('.import-tracker') && !window.__card.hidden && /Tracked/.test(window.__card.textContent)"), true, `the tracker after ${sel}`);
    }
    const onBoard = (await jobOf("ann", id)).imported;
    assert.ok(await b.waitFor(`Number(/([\\d,]+) \\/ 1,200/.exec(document.querySelector('.import-tracker').textContent)?.[1]?.replace(/,/g, '')) > ${onBoard}`, 15000), "it keeps moving after navigating");
    // The sidebar's count rises while it runs, and a refresh brings the tracker back.
    assert.ok(await b.waitFor("[...document.querySelectorAll('#sidebar .board-nav')].some((n) => n.textContent.includes('Tracked') && Number(n.querySelector('.nav-count')?.textContent.replace(/\\D/g, '')) > 0)", 30000), "the count moves off zero while importing");
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("/Tracked/.test(document.querySelector('.import-tracker:not([hidden])')?.textContent || '')", 15000), "back after a refresh");
    const seen = []; for (let i = 0; i < 400; i += 1) { const t = await b.evaluate("Number(/([\\d,]+) \\/ 1,200/.exec(document.querySelector('.import-tracker')?.textContent || '')?.[1]?.replace(/,/g, '') ?? -1)"); if (t >= 0) seen.push(t); if (/Completed/.test(await trackerText(b))) break; await sleep(100); }
    assert.ok(seen.length > 1); assert.deepEqual(seen, [...seen].sort((x, y) => x - y), "progress never goes backwards");
    const text = await trackerText(b);
    assert.match(text, /Completed 1,200 \/ 1,200 \(100%\)/);
    assert.equal(await badgeOf(b, "Tracked"), "1,200", "the sidebar shows the finished count without a refresh");
    await b.open(`${base}/`, { width: 1440, height: 900 }); await b.waitFor("!!document.querySelector('#sidebar .board-nav')", 15000);
    assert.equal(await badgeOf(b, "Tracked"), "1,200", "and after one");
    // Open Board, then Dismiss, which only hides the card and stays hidden after a refresh.
    assert.ok(await b.waitFor("!!document.querySelector('.import-tracker [data-xt=board]')", 15000));
    await click(b, ".import-tracker [data-xt=board]");
    assert.ok(await b.waitFor("[...document.querySelectorAll('tr[data-record-context]')].some((r) => r.textContent.includes('Tracked 0'))", 15000), "the board opens");
    await click(b, ".import-tracker [data-xt=dismiss]"); assert.ok(await b.waitFor("document.querySelector('.import-tracker').hidden", 3000), "dismissed");
    await b.open(`${base}/`, { width: 1440, height: 900 }); await b.waitFor("!!document.querySelector('#sidebar .board-nav')", 15000); await sleep(1200);
    assert.equal((await trackerText(b)).includes("Tracked"), false, "stays dismissed");
    assert.equal(await badgeOf(b, "Tracked"), "1,200", "the board is untouched");
    assert.equal((await jobOf("ann", id)).status, "done");
  });
  test("the tracker: pause, resume and cancel show as they happen, and a cancelled import keeps the records it made", async () => {
    const b = browsers.ann; await clearTracker(b); await openApp(b); await dismissAll(b);
    const id = await startImport("ann", "Controlled", 1500);
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("/Controlled/.test(document.querySelector('.import-tracker:not([hidden])')?.textContent || '')", 15000), "the tracker finds an import started elsewhere");
    await until("ann", id, (j) => j.imported > 0);
    assert.equal((await call("ann", "POST", `/imports/${id}/pause`, {})).status, 200);
    assert.ok(await b.waitFor("/Paused/.test(document.querySelector('.import-tracker').textContent)", 10000), await trackerText(b));
    // A batch on its way at the moment of pausing still lands: the sidebar and the tracker show what's really on the board, and agree.
    await sleep(1500);
    const paused = await jobOf("ann", id), onBoard = (await call("ann", "GET", `/workspaces/${ws.id}/imports?view=progress`)).body.items.find((j) => j.id === id).recordsOnBoard;
    assert.ok(onBoard >= paused.imported && onBoard - paused.imported <= 100, `${onBoard} on the board, ${paused.imported} counted`);
    const shown = onBoard.toLocaleString("en-US");
    assert.ok(await b.waitFor(`[...document.querySelectorAll('#sidebar .board-nav')].some((n) => n.textContent.includes('Controlled') && n.querySelector('.nav-count')?.textContent === '${shown}')`, 10000), `the sidebar: ${await badgeOf(b, "Controlled")} for ${shown}`);
    assert.ok(await b.waitFor(`document.querySelector('.import-tracker').textContent.replace(/\\s+/g, ' ').includes('Paused ${shown} / 1,500')`, 10000), `the tracker agrees: ${await trackerText(b)}`);
    assert.equal((await call("ann", "POST", `/imports/${id}/resume`, {})).status, 200);
    await until("ann", id, (j) => j.imported > onBoard);
    assert.ok(await b.waitFor("/(Preparing|Importing)/.test(document.querySelector('.import-tracker').textContent)", 10000));
    assert.equal((await call("ann", "POST", `/imports/${id}/cancel`, {})).status, 200);
    assert.ok(await b.waitFor("/Cancelled/.test(document.querySelector('.import-tracker').textContent)", 10000), await trackerText(b));
    await sleep(1500); // a batch on its way at that moment lands, and its rows are counted
    const ended = await jobOf("ann", id), board = (await call("ann", "GET", `/boards/${ended.boardId}`)).body.board;
    assert.ok(ended.imported > 0); assert.equal(ended.imported, board.recordCount, "a cancelled import's count is what it really wrote");
    assert.ok(await b.waitFor(`[...document.querySelectorAll('#sidebar .board-nav')].some((n) => n.textContent.includes('Controlled') && n.querySelector('.nav-count')?.textContent === '${ended.imported.toLocaleString("en-US")}')`, 15000), `the sidebar: ${await badgeOf(b, "Controlled")} for ${ended.imported}`);
    await dismissAll(b);
  });
  test("the tracker: several imports stay apart, as a summary that opens into a list, and another member doesn't see them", async () => {
    const b = browsers.ann; await clearTracker(b); await openApp(b); await dismissAll(b);
    const first = await startImport("ann", "Alpha", 900), second = await startImport("ann", "Beta", 150);
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("/2 imports/.test(document.querySelector('.import-tracker:not([hidden])')?.textContent || '')", 15000), await trackerText(b));
    assert.equal(await b.evaluate("document.querySelectorAll('.import-tracker .xt-job').length"), 0, "a compact summary first");
    await click(b, ".import-tracker [data-xt=toggle]");
    assert.equal(await b.evaluate("document.querySelectorAll('.import-tracker .xt-job').length"), 2);
    assert.match(await trackerText(b), /Alpha/); assert.match(await trackerText(b), /Beta/);
    await b.evaluate(`document.querySelector('.import-tracker [data-xt=open][data-id="${second}"]').click()`); await reached(b, ".xl-step-run", 5000);
    assert.match(await b.evaluate("document.querySelector('.xl-step-run').textContent"), /Beta\.csv/, "each opens its own");
    await click(b, ".xl-step-run [data-action=close-overlay]");
    await browsers.ben.open(`${base}/`, { width: 1440, height: 900 }); await browsers.ben.waitFor("!!document.querySelector('#sidebar')", 15000); await sleep(1500);
    const benSees = await trackerText(browsers.ben); assert.equal(/Alpha|Beta/.test(benSees), false, "another member's tracker shows only their own");
    const a = await until("ann", first, (j) => j.status === "done", 90000), c = await until("ann", second, (j) => j.status === "done", 90000);
    assert.equal(a.imported, 900); assert.equal(c.imported, 150);
    assert.ok(await b.waitFor("/2 imports · 0 active/.test(document.querySelector('.import-tracker').textContent)", 15000), await trackerText(b));
    assert.equal(await badgeOf(b, "Alpha"), "900"); assert.equal(await badgeOf(b, "Beta"), "150");
    await dismissAll(b);
  });
  test("the tracker: a failed import says why and stays inspectable; a stale response can't move it back; minimizing keeps it", async () => {
    const b = browsers.ann; await clearTracker(b); await openApp(b); await dismissAll(b); await sleep(300);
    const id = "f".repeat(24), boardFree = { id, workspaceId: ws.id, boardId: null, boardName: "Failing board", status: "failed", fileName: "failing.csv", rowCount: 500, imported: 100, skippedDuplicates: 0, rejected: 2, removedRecords: 0, processedBatches: 1, batchCount: 5, errors: [{ row: 3, reason: "Name is missing" }], lastError: "The database couldn't be reached.", recordsOnBoard: null, updatedAt: "2099-01-01T00:00:00.000Z", finishedAt: new Date().toISOString() };
    await b.evaluate(`(() => { const real = window.fetch, stub = ${JSON.stringify(boardFree)}; window.__view = (extra) => ({ items: [{ ...stub, ...extra }] }); window.__next = window.__view({}); window.fetch = async (url, o) => { if (String(url).includes('view=progress')) return new Response(JSON.stringify(window.__next), { status: 200, headers: { "Content-Type": "application/json" } }); return real(url, o); }; document.dispatchEvent(new Event('visibilitychange')); })()`);
    assert.ok(await b.waitFor("/Failed 100 \\/ 500/.test(document.querySelector('.import-tracker:not([hidden])')?.textContent.replace(/\\s+/g, ' ') || '')", 10000), await trackerText(b));
    assert.match(await trackerText(b), /The database couldn't be reached/); assert.match(await trackerText(b), /2 rows rejected/);
    // An older answer arriving late is ignored.
    await b.evaluate(`(() => { window.__next = window.__view({ status: "running", imported: 5, updatedAt: "2001-01-01T00:00:00.000Z" }); document.dispatchEvent(new Event('visibilitychange')); })()`); await sleep(600);
    assert.match(await trackerText(b), /Failed 100 \/ 500/, "not moved back");
    // Minimizing keeps it, across a refresh of what's shown.
    await click(b, ".import-tracker [data-xt=minimize]");
    assert.equal(await b.evaluate("!!document.querySelector('.import-tracker.is-minimized .xt-pill')"), true); assert.match(await trackerText(b), /Failed/);
    await click(b, ".import-tracker [data-xt=restore]"); assert.equal(await b.evaluate("!!document.querySelector('.import-tracker .xt-job')"), true);
    await dismissAll(b); await clearTracker(b);
  });
  test("the tracker, on a real failure: the board is deleted during the import, it says why, and the job can still be inspected", async () => {
    const b = browsers.ann; await clearTracker(b); await openApp(b); await dismissAll(b);
    const id = await startImport("ann", "Doomed", 1500);
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("/Doomed/.test(document.querySelector('.import-tracker:not([hidden])')?.textContent || '')", 15000), await trackerText(b));
    const running = await until("ann", id, (j) => j.imported > 0 && j.boardId), board = (await call("root", "GET", `/boards/${running.boardId}`)).body.board;
    assert.equal((await call("root", "DELETE", `/boards/${running.boardId}?expectedVersion=${board.version}`)).status, 200, "a real deletion, by an administrator");
    const failed = await until("ann", id, (j) => j.status === "failed");
    assert.match(failed.lastError, /deleted/);
    assert.ok(await b.waitFor("/Failed/.test(document.querySelector('.import-tracker').textContent)", 15000), await trackerText(b));
    assert.match(await trackerText(b), /The board was deleted/);
    assert.equal(await b.evaluate("!!document.querySelector('.import-tracker [data-xt=board]')"), false, "no Open board for a board that's gone");
    await click(b, ".import-tracker [data-xt=open]"); await reached(b, ".xl-step-run", 5000);
    const shown = await b.evaluate("document.querySelector('.xl-step-run').textContent"); assert.match(shown, /Import stopped/); assert.match(shown, /The board was deleted/);
    await click(b, ".xl-step-run [data-action=close-overlay]");
    assert.equal((await call("ann", "GET", `/imports/${id}`)).status, 200, "the job stays to inspect");
    await dismissAll(b);
  });
  test("the tracker, on a real halt: a column it needs is removed, it pauses and says why; cancelling then keeps what it made", async () => {
    const b = browsers.ann; await clearTracker(b); await openApp(b); await dismissAll(b);
    const id = await startImport("ann", "Halted", 1500);
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("/Halted/.test(document.querySelector('.import-tracker:not([hidden])')?.textContent || '')", 15000), await trackerText(b));
    const running = await until("ann", id, (j) => j.imported > 0 && j.boardId), board = (await call("root", "GET", `/boards/${running.boardId}`)).body.board, code = board.columns.find((c) => c.label === "Code");
    assert.equal((await call("root", "DELETE", `/boards/${running.boardId}/columns/${code.key}?expectedVersion=${board.version}`)).status, 200, "a real column removal");
    const halted = await until("ann", id, (j) => j.status === "paused");
    assert.match(halted.lastError, /column this import uses was removed/);
    assert.ok(await b.waitFor("/Paused/.test(document.querySelector('.import-tracker').textContent) && /column this import uses/.test(document.querySelector('.import-tracker').textContent)", 15000), await trackerText(b));
    const ended = (await call("ann", "POST", `/imports/${id}/cancel`, {})).body.import;
    assert.equal(ended.status, "cancelled"); assert.equal(ended.imported, (await call("ann", "GET", `/boards/${ended.boardId}`)).body.board.recordCount);
    assert.ok(await b.waitFor("/Cancelled/.test(document.querySelector('.import-tracker').textContent)", 15000));
    await dismissAll(b);
  });
  test("the tracker on a phone: fits the screen, with no sideways scrolling", async () => {
    const b = browsers.ann; await clearTracker(b); await openApp(b, 390); await dismissAll(b);
    const id = await startImport("ann", "Phone", 800);
    await b.open(`${base}/`, { width: 390, height: 844 });
    assert.ok(await b.waitFor("/Phone/.test(document.querySelector('.import-tracker:not([hidden])')?.textContent || '')", 15000), await trackerText(b));
    const box = await b.evaluate("(() => { const r = document.querySelector('.import-tracker').getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, height: r.height, w: innerWidth, h: innerHeight, sideways: document.documentElement.scrollWidth > innerWidth }; })()");
    assert.ok(box.left >= 0 && box.right <= box.w && box.bottom <= box.h, JSON.stringify(box)); assert.equal(box.sideways, false); assert.ok(box.height < box.h / 3, "it stays small");
    await b.evaluate("document.querySelector('[data-action=toggle-nav]')?.click()"); await sleep(200);
    assert.equal(await b.evaluate("getComputedStyle(document.querySelector('.import-tracker')).display"), "none", "out of the way of the menu");
    await b.evaluate("document.querySelector('[data-action=toggle-nav]')?.click()");
    await call("ann", "POST", `/imports/${id}/cancel`, {});
    assert.ok(await b.waitFor("/Cancelled/.test(document.querySelector('.import-tracker').textContent)", 10000)); await dismissAll(b);
  });
  test("a colleague's browser sees a count change on a board it hasn't opened", async () => {
    const b = browsers.ben; await b.open(`${base}/`, { width: 1440, height: 900 }); assert.ok(await b.waitFor("!!document.querySelector('#sidebar .board-nav')", 15000)); await sleep(1000);
    const made = (await call("root", "POST", `/workspaces/${ws.id}/boards`, { name: "Shared count", columns: [{ key: "serial", label: "Item", type: "text", required: true }] })).body.board;
    assert.ok(await b.waitFor("[...document.querySelectorAll('#sidebar .board-nav')].some((n) => n.textContent.includes('Shared count'))", 15000), "the board arrives");
    assert.equal(await badgeOf(b, "Shared count"), "0");
    assert.equal((await call("root", "POST", `/boards/${made.id}/records`, { values: { serial: "One" } })).status, 201);
    assert.ok(await b.waitFor("[...document.querySelectorAll('#sidebar .board-nav')].some((n) => n.textContent.includes('Shared count') && n.querySelector('.nav-count')?.textContent === '1')", 15000), `the count follows: ${await badgeOf(b, "Shared count")}`);
  });
  test("a workspace with no boards can still reach the wizard from Home, and its sidebar says it's empty", async () => {
    const empty = (await call("root", "POST", "/workspaces", { name: "No boards here" })).body.workspace;
    assert.equal((await call("root", "POST", `/workspaces/${empty.id}/members`, { userId: (await call("ben", "GET", "/me")).body.user.id, role: "MEMBER" })).status, 201);
    const b = browsers.ben; await b.open(`${base}/`, { width: 1440, height: 900 }); assert.ok(await b.waitFor("!!document.querySelector('#sidebar [data-action=workspace-menu]')", 15000));
    await click(b, "#sidebar [data-action=workspace-menu]"); assert.ok(await b.waitFor("!!document.querySelector('[data-action=switch-workspace]')", 5000));
    await b.evaluate(`[...document.querySelectorAll('[data-action=switch-workspace]')].find((el) => el.textContent.includes("No boards here")).click()`);
    assert.ok(await b.waitFor("[...document.querySelectorAll('#sidebar .nav-empty')].some((el) => /No boards yet/.test(el.textContent))", 10000), "the sidebar says so");
    assert.equal(await sidebarHasNoBoardButtons(b), true);
    await goHome(b);
    assert.equal(await b.evaluate("document.querySelector('[data-action=home-import]').disabled"), false, "Import data stays available");
    await homeChooser(b);
    await click(b, ".choice-list [data-action=xl-import-new]"); assert.ok(await b.waitFor("!!document.querySelector('#xl-import-file')", 5000), "the wizard");
    await pickFile(b, xlsx([["Name", "Code"], ["Empty start", "1"]]).toString("base64"), "empty-workspace.xlsx"); await reached(b, ".xl-step-structure", 15000);
    assert.match(await b.evaluate("document.querySelector('.xl-step-structure').textContent"), /1\s*records?/);
    await click(b, "[data-action=xl-import-cancel]");
    await reached(b, ".page-head [data-action=new-board]", 5000);
  });
});

// ---- Real MongoDB, when the local test instance runs.
const settingFile = path.join(__dirname, "../../.env.migration-test");
const setting = (key) => { if (!fs.existsSync(settingFile)) return null; const m = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\r\\n]*)`, "m").exec(fs.readFileSync(settingFile, "utf8")); return m ? m[1].trim() : null; };
describe("On real MongoDB (local test instance)", () => {
  let client = null, skip = false, dbName, w;
  before(async () => {
    const uri = setting("JARC_MIGRATION_TEST_MONGODB_URI");
    if (!uri) { skip = true; return; }
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
    try { await client.connect(); await client.db("admin").command({ ping: 1 }); } catch { skip = true; await client.close().catch(() => {}); client = null; return; }
    dbName = `jarc_migration_test_t${crypto.randomBytes(6).toString("hex")}`;
    const raw = client;
    w = await world({ fake: { connect: async () => {}, close: async () => {}, startSession: (...a) => raw.startSession(...a), db: () => raw.db(dbName) } });
  });
  after(async () => { if (client) { await client.db(dbName).dropDatabase().catch(() => {}); await client.close(); } });
  const real = (name, fn) => test(name, async (t) => { if (skip) return t.skip("the local test instance isn't running"); return fn(); });
  real("a workbook becomes a board, with groups, and can be removed again", async () => {
    const done = await importFile(w, mondayFile());
    assert.equal(done.status, "done", done.lastError); assert.equal(done.imported, 3);
    const board = await w.dl.repos.boards.findById(done.boardId);
    assert.deepEqual(board.groups.map((g) => g.name), ["North region", "South region"]);
    const rows = await w.records.find({ boardId: board._id }).toArray();
    assert.ok(rows.some((r) => r.values[board.columns[1].key] === "00123"));
    const ended = await removeBoard(w, done);
    assert.equal(ended.status, "removed"); assert.equal(ended.removedRecords, 3);
    assert.equal(await w.records.countDocuments({ boardId: board._id }), 0);
    assert.equal(await w.dl.repos.boards.findById(board._id), null);
  });
  real("removal refuses a board with a changed record", async () => {
    const done = await importFile(w, xlsx([["Name", "N"], ["Z", "9"]]));
    await w.records.updateOne({ boardId: done.boardId }, { $inc: { version: 1 } });
    await assert.rejects(w.jobs.cleanUp(done, actor), (e) => e.code === "IMPORT_BOARD_CHANGED");
  });
});

// ---- The original monday.com export, when it's on this computer. The workbook and what it should hold (expected-structure.json beside it) are private and
// Git-ignored, because this repository is public: no real names, IDs or counts belong in this file. Skipped on any computer without them.
const REFERENCE_FOLDER = path.join(__dirname, "../../monday-migration/reference"), EXPECTED_FILE = path.join(REFERENCE_FOLDER, "expected-structure.json");
const EXPECTED = fs.existsSync(EXPECTED_FILE) ? JSON.parse(fs.readFileSync(EXPECTED_FILE, "utf8")) : null, REFERENCE = EXPECTED && path.join(REFERENCE_FOLDER, EXPECTED.file);
describe("The original monday.com export", { skip: REFERENCE && fs.existsSync(REFERENCE) ? false : "the reference workbook isn't on this computer" }, () => {
  test("its structure: title, groups, repeated headers, summaries, columns and records, exactly as expected, with nothing to ask", () => {
    assert.ok(EXPECTED.groups.length > 0 && EXPECTED.counts.records > 0 && EXPECTED.columns > 0, "there's something to compare");
    const { table, sheets, notes } = readTable(fs.readFileSync(REFERENCE), { name: "real.xlsx" }), a = analyzeTable(table);
    assert.deepEqual(sheets, EXPECTED.sheets);
    assert.equal(a.status, "clear", JSON.stringify(a.reasons));
    assert.equal(a.boardTitle, EXPECTED.boardTitle); assert.equal(a.headerLine, EXPECTED.headerLine); assert.equal(a.itemColumn, EXPECTED.itemColumn); assert.equal(a.columns.length, EXPECTED.columns);
    assert.deepEqual(a.counts, EXPECTED.counts);
    const v = validateTable(table, a, {}, notes);
    assert.equal(v.records, EXPECTED.counts.records); assert.equal(v.errorCount, 0);
    assert.equal(analyzeTable(table, { headerLine: EXPECTED.headerLine, itemColumn: EXPECTED.itemColumn, soloRows: null, totalRows: null }).counts.records, EXPECTED.counts.records, "and again on a later step");
    assert.deepEqual(v.groups, EXPECTED.groups);
  });
});
