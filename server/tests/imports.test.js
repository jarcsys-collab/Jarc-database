// Excel and CSV imports: the file reader against hostile files; the job on the fake MongoDB with the real services (mapping,
// duplicates, crash and resume, pause, cancel); and the routes and screens in a real browser.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const path = require("path");
const { spawn } = require("child_process");
const { ObjectId } = require("mongodb");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase, COLLECTIONS } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { parseSpreadsheet, LIMITS } = require("../src/domain/spreadsheet");
const { dateText, cellValue, suggestMapping } = require("../src/services/import-job-service");
const { FakeMongoClient } = require("./support/fake-mongo");
const { findBrowser, launch, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
// A minimal ZIP writer, so tests can make exact and deliberately broken workbooks.
function zip(files, { store = false, flags = 0 } = {}) {
  const locals = [], central = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content), packed = store ? data : zlib.deflateRawSync(data), n = Buffer.from(name), method = store ? 0 : 8;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const head = Buffer.alloc(46); head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(flags, 8); head.writeUInt16LE(method, 10); head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(n.length, 28); head.writeUInt32LE(offset, 42);
    locals.push(local, n, packed); central.push(head, n); offset += 30 + n.length + packed.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
const WORKBOOK = '<workbook xmlns:r="x"><workbookPr/><sheets><sheet name="Hidden" sheetId="1" state="hidden" r:id="rId9"/><sheet name="Data &amp; more" sheetId="2" r:id="rId1"/><sheet name="Second" sheetId="3" r:id="rId2"/></sheets></workbook>';
const RELS = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId9" Target="worksheets/sheet9.xml"/></Relationships>';
const SHARED = '<sst><si><t>Item</t></si><si><t>When</t></si><si><r><t>Rich </t></r><r><t>text</t></r><rPh><t>phonetic</t></rPh></si><si><t>A &amp; B &lt;x&gt;</t></si></sst>';
const STYLES = '<styleSheet><numFmts><numFmt numFmtId="170" formatCode="&quot;day&quot; dd/mm"/><numFmt numFmtId="171" formatCode="0.00&quot; d&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="170"/><xf numFmtId="171"/></cellXfs></styleSheet>';
const SHEET = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Blank before me</t></is></c></row><row r="2"/><row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" s="1"><v>46000</v></c><c r="D3" t="b"><v>1</v></c></row><row r="5"><c r="A5" t="s"><v>3</v></c><c r="B5" s="2"><v>46001.5</v></c><c r="C5"><f>1+1</f><v>2</v></c><c r="D5" t="e"><v>#REF!</v></c></row><row r="6"><c r="A6" s="3"><v>12.5</v></c></row></sheetData></worksheet>';
const xlsx = (over = {}) => zip({ "xl/workbook.xml": WORKBOOK, "xl/_rels/workbook.xml.rels": RELS, "xl/sharedStrings.xml": SHARED, "xl/styles.xml": STYLES, "xl/worksheets/sheet1.xml": SHEET, "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row r="1"><c t="inlineStr"><is><t>Other</t></is></c></row><row r="2"><c t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>', ...over });

describe("reading files", () => {
  test("XLSX: shared and rich text, dates, gaps, formula results, booleans, row numbers, hidden sheets skipped", () => {
    const p = parseSpreadsheet(xlsx());
    assert.equal(p.kind, "xlsx"); assert.equal(p.sheet, "Data & more"); assert.deepEqual(p.sheets, ["Data & more", "Second"]);
    assert.deepEqual(p.headers, ["Item", "When", "Column 3", "Blank before me"]);
    assert.deepEqual(p.rows.map((r) => r.line), [3, 5, 6]);
    assert.deepEqual(p.rows[0].cells, ["Rich text", "2025-12-09", "", "true"]);
    assert.deepEqual(p.rows[1].cells, ["A & B <x>", "2025-12-10 12:00", "2", ""], "formula's saved result; an error cell is empty");
    assert.equal(p.rows[2].cells[0], "12.5", "a number with a quoted d in its format isn't a date");
  });
  test("XLSX: a chosen sheet, an unknown sheet", () => {
    assert.equal(parseSpreadsheet(xlsx(), { sheet: "Second" }).headers[0], "Other");
    assert.throws(() => parseSpreadsheet(xlsx(), { sheet: "Hidden" }), /isn't in this workbook/);
  });
  test("CSV: quotes, embedded newlines and delimiters, BOM, semicolons, tabs, CRLF, legacy encoding, UTF-16", () => {
    const p = parseSpreadsheet(Buffer.from('﻿Name,Note\r\n"A, B","two\nlines"\r\n"say ""hi""",\r\n\r\n'));
    assert.deepEqual(p.headers, ["Name", "Note"]); assert.deepEqual(p.rows.map((r) => r.cells), [["A, B", "two\nlines"], ['say "hi"', ""]]);
    assert.deepEqual(parseSpreadsheet(Buffer.from("a;b\n1,5;2\n")).rows[0].cells, ["1,5", "2"]);
    assert.deepEqual(parseSpreadsheet(Buffer.from("a\tb\n1\t2\n")).rows[0].cells, ["1", "2"]);
    assert.equal(parseSpreadsheet(Buffer.from([0x4e, 0x0a, 0x4d, 0xfc, 0x6c, 0x0a])).rows[0].cells[0], "Mül", "windows-1252");
    assert.equal(parseSpreadsheet(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Name\nÑino\n", "utf16le")])).rows[0].cells[0], "Ñino");
  });
  test("hostile and wrong files are refused with a clear reason, never a crash", () => {
    const refused = (buffer, pattern, options) => assert.throws(() => parseSpreadsheet(buffer, options), (e) => e.status === 422 && pattern.test(e.message), String(pattern));
    refused(Buffer.alloc(0), /empty/);
    refused(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0]), /older \.xls/);
    refused(Buffer.from("not a workbook"), /readable Excel/, { name: "x.xlsx" });
    refused(Buffer.from([1, 2, 0, 3, 4]), /doesn't look like/);
    refused(Buffer.from('a\n"never ends\n'), /never ends/);
    refused(Buffer.from("PK\x03\x04 truncated"), /readable Excel/);
    refused(zip({ "xl/workbook.xml": WORKBOOK }), /readable Excel/);
    refused(zip({ "xl/workbook.xml": WORKBOOK, "xl/_rels/workbook.xml.rels": RELS }, { flags: 1 }), /password/);
    refused(xlsx({ "xl/worksheets/sheet1.xml": '<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><worksheet><sheetData><row r="1"><c t="inlineStr"><is><t>&x;</t></is></c></row></sheetData></worksheet>' }), /safely/);
    refused(Buffer.alloc(LIMITS.fileBytes + 1, 97), /25 MB/);
    refused(Buffer.from(`${"h\n"}${"x\n".repeat(LIMITS.rows + 1)}`), /more than 100,000 rows/);
    refused(Buffer.from(`${Array.from({ length: 201 }, (_, i) => `c${i}`).join(",")}\n`), /more than 200 columns/);
    refused(Buffer.from(`a\n${"x".repeat(LIMITS.cellLength + 1)}\n`), /longer than/);
  });
  test("a zip bomb stops at the limit on its real size, without exhausting memory", () => {
    const original = zlib.inflateRawSync; let limit = null;
    zlib.inflateRawSync = (data, options) => { limit = options.maxOutputLength; return original(data, { ...options, maxOutputLength: 1024 }); }; // same mechanism, smaller limit
    try { assert.throws(() => parseSpreadsheet(xlsx({ "xl/worksheets/sheet1.xml": Buffer.alloc(5 * 1024 * 1024, 32) })), /expands to too much/); }
    finally { zlib.inflateRawSync = original; }
    assert.equal(limit, LIMITS.inflatedEntry);
  });
  test("cell conversions", () => {
    assert.equal(dateText("03/04/2026", "mdy"), "2026-03-04"); assert.equal(dateText("03/04/2026", "dmy"), "2026-04-03"); assert.equal(dateText("2026-02-30", "mdy"), null); assert.equal(dateText("soon", "mdy"), null); assert.equal(dateText("2026-01-02 10:00", "mdy"), "2026-01-02");
    const context = { people: new Map([["ann", ["user:a"]], ["sam", ["user:s1", "user:s2"]]]), dateOrder: "mdy" };
    assert.deepEqual(cellValue({ type: "checkbox" }, "Yes", context), { value: true }); assert.ok(cellValue({ type: "checkbox" }, "maybe", context).error);
    assert.deepEqual(cellValue({ type: "status", options: ["New"] }, "new", context), { value: "New" }, "matched to the option's own spelling"); assert.ok(cellValue({ type: "status", options: ["New"] }, "Old", context).error);
    assert.deepEqual(cellValue({ type: "dropdown", multiple: true, options: ["A", "B"] }, "a; B, a", context), { value: ["A", "B"] });
    assert.deepEqual(cellValue({ type: "owner" }, "Ann", context), { value: ["user:a"] }); assert.match(cellValue({ type: "owner" }, "Sam", context).error, /more than one/); assert.match(cellValue({ type: "owner" }, "Nobody", context).error, /doesn't match/);
    assert.deepEqual(cellValue({ type: "text" }, "   ", context), {});
  });
  test("columns are suggested by name, never twice, and never a Files column", () => {
    const board = { columns: [{ key: "serial", label: "Item", type: "text" }, { key: "state", label: "State", type: "status" }, { key: "doc", label: "Doc", type: "files" }] };
    assert.deepEqual(suggestMapping(["item", "STATE ", "Doc", "Item"], board), { serial: 0, state: 1 });
  });
});

const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "code", label: "Code", type: "text" }, { key: "state", label: "State", type: "status", options: ["New", "Done"] }, { key: "due", label: "Due", type: "date" }, { key: "ok", label: "OK", type: "checkbox" }, { key: "who", label: "Who", type: "owner" }];
const quiet = { log() {}, warn() {}, error() {} };

describe("the import job (real services, fake MongoDB)", () => {
  let dl, jobs, records, batches, board, actor, db, connection;
  const csv = (n, offset = 0, prefix = "Row") => Buffer.from(`Item,Code,State\n${Array.from({ length: n }, (_, i) => `${prefix} ${i + offset},C${i + offset},${i % 2 ? "Done" : "New"}`).join("\n")}\n`);
  const prepare = async (buffer, settings = {}, name = "f.csv") => { let job = await jobs.upload(board, buffer, { name }, actor); job = await jobs.configure(job, board, { mapping: { serial: 0, code: 1, state: 2 }, ...settings }); return job; };
  const finished = async (id) => { for (let i = 0; i < 500; i += 1) { const j = await jobs.find(id); if (!["queued", "running"].includes(j.status)) return j; await new Promise((r) => setTimeout(r, 5)); } throw new Error("never finished"); };
  const count = (filter = {}) => records.countDocuments({ boardId: board._id, ...filter });
  before(async () => {
    const fake = new FakeMongoClient();
    connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
    await connection.connect(); await ensureDatabase(connection.db); db = connection.db;
    dl = createDataLayer({ connection, logger: quiet, fileStore: new MemoryFileStore(), recordSearch: "on" });
    jobs = dl.services.importJobs; jobs.pauseMs = 0; records = dl.repos.records.collection; batches = db.collection(COLLECTIONS.importBatches);
    actor = { userId: new ObjectId(), kind: "entra", displayName: "Tester" };
    const w = await dl.services.workspaces.create({ name: "W" }, actor);
    board = await dl.services.boards.create(w._id, { name: "Target", columns: COLUMNS, groups: [{ name: "North" }, { name: "South" }] }, actor);
  });
  test("imports every row in file order, with progress, then removes the file's rows", async () => {
    const job = await prepare(csv(250));
    assert.equal(job.batchCount, 3);
    await jobs.start(job, board, {}, false);
    const done = await finished(job._id);
    assert.equal(done.status, "done"); assert.deepEqual([done.imported, done.skippedDuplicates, done.rejected, done.nextBatch], [250, 0, 0, 3]);
    assert.equal(await batches.countDocuments({ jobId: job._id }), 0, "no rows left behind");
    assert.equal(done.expiresAt, undefined, "the record of the import stays");
    const page = await records.find({ boardId: board._id }).sort({ position: 1 }).limit(3).toArray();
    assert.deepEqual(page.map((r) => r.values.serial), ["Row 0", "Row 1", "Row 2"]);
    assert.equal(page[0].groupId, board.groups[0].id, "the first group by default");
    assert.equal(page[0].createdBy.toHexString(), actor.userId.toHexString());
    const activity = await dl.repos.activities.collection.find({ boardId: board._id, action: "records.created" }).toArray();
    assert.ok(activity.some((a) => /Imported 250 records from f\.csv/.test(a.summary)), "one entry for the import");
  });
  test("the same file again is refused unless asked for", async () => {
    const job = await prepare(csv(3), {}, "again.csv"); await jobs.start(job, board, {}, false); await finished(job._id);
    const second = await prepare(csv(3), {}, "again.csv");
    assert.ok(second.previousImport);
    await assert.rejects(jobs.start(second, board, {}, false), (e) => e.code === "ALREADY_IMPORTED");
    await jobs.cancel(second);
  });
  test("a duplicate rule skips rows already on the board, and repeats within the file across batches", async () => {
    await records.deleteMany({ boardId: board._id });
    const first = await prepare(csv(5, 0, "Dup")); await jobs.start(first, board, {}, false); await finished(first._id);
    const rows = [...Array.from({ length: 150 }, (_, i) => `New ${i},X${i},New`), "Late,C1,New", "Late,X0,New", "No code,,New", "No code too,,New"];
    const job = await prepare(Buffer.from(`Item,Code,State\n${rows.join("\n")}\n`), { uniqueKey: "code" });
    const { check } = { check: await jobs.check(job, board) };
    assert.deepEqual([check.checked, check.duplicatesInFile, check.duplicatesOnBoard], [154, 1, 1]);
    await jobs.start(job, board, {}, false);
    const done = await finished(job._id);
    assert.deepEqual([done.imported, done.skippedDuplicates], [152, 2], "only real values count as duplicates; blanks are kept");
    assert.equal(await count(), 157);
  });
  test("a rejected row is reported by number and reason, without its values, and others continue", async () => {
    await records.deleteMany({ boardId: board._id });
    const secret = "Confidential value";
    const job = await prepare(Buffer.from(`Item,Code,State,Due,OK\nGood,1,New,2026-01-02,yes\n,2,New,,\nBad state,3,${secret},,\nBad date,4,New,${secret},\nBad tick,5,New,,${secret}\n`), { mapping: { serial: 0, code: 1, state: 2, due: 3, ok: 4 } });
    const check = await jobs.check(job, board);
    assert.deepEqual([check.checked, check.valid], [5, 1]);
    assert.ok(check.problems.every((p) => !p.reason.includes(secret)));
    await jobs.start(job, board, {}, false);
    const done = await finished(job._id);
    assert.deepEqual([done.imported, done.rejected], [1, 4]);
    assert.deepEqual(done.errors.map((e) => e.row), [3, 4, 5, 6]);
    assert.ok(!JSON.stringify(done.errors).includes(secret));
    const saved = (await records.find({ boardId: board._id }).toArray())[0];
    assert.equal(saved.values.due, "2026-01-02"); assert.equal(saved.values.ok, true);
  });
  test("settings are checked: unknown columns, Files, no item name, out-of-range source, a stray prototype key", async () => {
    const job = await jobs.upload(board, csv(1, 0, "S"), { name: "s.csv" }, actor);
    for (const bad of [{ mapping: {} }, { mapping: { serial: 0, nope: 1 } }, { mapping: { serial: 9 } }, { mapping: { serial: 0, code: 0 } }, { mapping: { serial: 0, code: "1" } }, { mapping: JSON.parse('{"serial":0,"__proto__":1}') }, { mapping: { serial: 0 }, uniqueKey: "code" }, { mapping: { serial: 0, who: 1 }, uniqueKey: "who" }, { dateOrder: "ymd" }, { extra: 1 }, { groupId: "grp_missing" }]) await assert.rejects(jobs.configure(job, board, bad), (e) => e.status === 400, JSON.stringify(bad));
    await jobs.cancel(job);
  });
  test("a batch that fails partway runs again: every row exactly once, counters exact", async () => {
    await records.deleteMany({ boardId: board._id });
    const job = await prepare(csv(250, 0, "Crash"), { uniqueKey: "code" });
    const original = records.insertMany.bind(records); let calls = 0;
    // The second batch inserts half its rows, then the connection drops.
    records.insertMany = async (docs, options) => { calls += 1; if (calls === 2) { await original(docs.slice(0, 40), options); const e = new Error("connection lost"); e.name = "MongoNetworkError"; throw e; } return original(docs, options); };
    try { await jobs.start(job, board, {}, false); const done = await finished(job._id); assert.equal(done.status, "done"); assert.deepEqual([done.imported, done.skippedDuplicates, done.rejected], [250, 0, 0]); }
    finally { records.insertMany = original; }
    assert.equal(await count(), 250);
    assert.equal(new Set((await records.find({ boardId: board._id }).toArray()).map((r) => r.values.serial)).size, 250);
  });
  test("a server that dies mid-import: another picks it up after the lease, from the batch it reached", async () => {
    await records.deleteMany({ boardId: board._id });
    let job = await prepare(csv(250, 0, "Restart"));
    job = await jobs.jobs.findOneAndUpdate({ _id: job._id }, { $set: { status: "running", basePosition: -1e6, everyone: false, leaseOwner: "gone", leaseUntil: new Date(Date.now() + 60000) } }, { returnDocument: "after" });
    // The old server finished batch 0 and inserted part of batch 1, then died before recording it.
    const worker = new (jobs.constructor)({ repos: dl.repos, connection, logger: quiet, pauseMs: 0 });
    const b0 = await batches.findOne({ jobId: job._id, n: 0 });
    await worker.runBatch(job, board, b0);
    await jobs.jobs.updateOne({ _id: job._id }, { $set: { nextBatch: 1 }, $inc: { imported: 100 } }); await batches.deleteOne({ _id: b0._id });
    job = await jobs.find(job._id);
    await worker.runBatch(job, board, { ...(await batches.findOne({ jobId: job._id, n: 1 })), rows: (await batches.findOne({ jobId: job._id, n: 1 })).rows.slice(0, 30) });
    assert.equal(await worker.claim().then((c) => c?._id?.equals(job._id) ?? false), false, "not while its lease is valid");
    await jobs.jobs.updateOne({ _id: job._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } });
    worker.wake();
    const done = await finished(job._id);
    assert.equal(done.status, "done"); assert.equal(done.imported, 250); assert.equal(await count(), 250);
  });
  test("two workers can't both run a job", async () => {
    const job = await prepare(csv(3, 0, "Two")); await jobs.jobs.updateOne({ _id: job._id }, { $set: { status: "queued", basePosition: 0, everyone: false } });
    const [a, b] = [new (jobs.constructor)({ repos: dl.repos, connection, logger: quiet }), new (jobs.constructor)({ repos: dl.repos, connection, logger: quiet })];
    const claims = await Promise.all([a.claim(), b.claim()]);
    assert.equal(claims.filter((c) => c?._id.equals(job._id)).length, 1);
    await jobs.jobs.updateOne({ _id: job._id }, { $set: { status: "cancelled" } }); await batches.deleteMany({ jobId: job._id });
  });
  test("pause, resume and cancel; a cancelled import keeps what it imported and drops the rest", async () => {
    await records.deleteMany({ boardId: board._id });
    jobs.pauseMs = 30;
    const job = await prepare(csv(450, 0, "Pause")); await jobs.start(job, board, {}, false);
    for (let i = 0; i < 300 && (await jobs.find(job._id)).nextBatch < 1; i += 1) await new Promise((r) => setTimeout(r, 5));
    const paused = await jobs.pause(await jobs.find(job._id));
    assert.equal(paused.status, "paused");
    await new Promise((r) => setTimeout(r, 80));
    const at = await count();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(await count(), at, "really stopped");
    await jobs.resume(paused);
    for (let i = 0; i < 300 && (await jobs.find(job._id)).nextBatch < 3; i += 1) await new Promise((r) => setTimeout(r, 5));
    const cancelled = await jobs.cancel(await jobs.find(job._id));
    jobs.pauseMs = 0;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(await batches.countDocuments({ jobId: job._id }), 0);
    assert.ok(await count() >= 300 && await count() < 450, "what was imported stays");
    await assert.rejects(jobs.cancel(cancelled), (e) => e.code === "IMPORT_ENDED");
  });
  test("a removed column pauses the job with a reason; a deleted board ends it", async () => {
    const other = await dl.services.boards.create(board.workspaceId, { name: "Other", columns: COLUMNS }, actor);
    let job = await jobs.upload(other, csv(2, 0, "Gone"), { name: "g.csv" }, actor); job = await jobs.configure(job, other, { mapping: { serial: 0, code: 1 } });
    await dl.repos.boards.collection.updateOne({ _id: other._id }, { $set: { columns: COLUMNS.filter((c) => c.key !== "code") } });
    await jobs.start(job, await dl.repos.boards.findById(other._id), {}, false);
    const halted = await finished(job._id);
    assert.equal(halted.status, "paused"); assert.match(halted.lastError, /column/);
    await dl.repos.boards.collection.deleteOne({ _id: other._id });
    await jobs.resume(halted);
    const ended = await finished(job._id);
    assert.equal(ended.status, "failed"); assert.match(ended.lastError, /deleted/);
    assert.equal(await batches.countDocuments({ jobId: job._id }), 0);
  });
  test("read-only boards and too many open imports are refused", async () => {
    await assert.rejects(jobs.upload({ ...board, source: { readOnly: true } }, csv(1), { name: "r.csv" }, actor), (e) => e.code === "READ_ONLY_BOARD");
    const someone = { ...actor, userId: new ObjectId() }, open = [];
    for (let i = 0; i < 3; i += 1) open.push(await jobs.upload(board, csv(1, i, "Many"), { name: `${i}.csv` }, someone));
    await assert.rejects(jobs.upload(board, csv(1, 9, "Many"), { name: "9.csv" }, someone), (e) => e.code === "TOO_MANY_IMPORTS");
    for (const j of open) await jobs.cancel(j);
  });
  test("searching finds imported records once the index has them", async () => {
    await records.deleteMany({ boardId: board._id });
    await dl.searchIndex.catchUp();
    const job = await prepare(csv(2, 0, "Findme")); await jobs.start(job, board, {}, false); await finished(job._id);
    await dl.searchIndex.flush();
    assert.equal(await db.collection(COLLECTIONS.recordSearch).countDocuments({ boardId: board._id, text: { $regex: "findme" } }), 2);
    assert.equal((await dl.searchIndex.verify()).missing, 0);
  });
});

describe("import routes and screens (real app, headless browser, role_based)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, ws, board; const browsers = {};
  const OIDS = { admin: "0d0d0d0d-0000-4000-8000-000000000081", mia: "0d0d0d0d-0000-4000-8000-000000000082", vic: "0d0d0d0d-0000-4000-8000-000000000083", out: "0d0d0d0d-0000-4000-8000-000000000084", ben: "0d0d0d0d-0000-4000-8000-000000000085" };
  const signIn = (b, who, isAdmin) => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${who}&email=${who}@example.invalid&admin=${isAdmin ? 1 : 0}&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const api = (who, method, p, body) => browsers[who].evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1" + ${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) }, ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`} }); let json = null; try { json = await r.json(); } catch {} return { status: r.status, body: json }; })()`);
  const upload = (who, text, name = "f.csv", boardId = board.id) => browsers[who].evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1/boards/${boardId}/imports?name=" + encodeURIComponent(${JSON.stringify(name)}), { method: "POST", headers: { "Content-Type": "application/octet-stream", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) }, body: ${JSON.stringify(text)} }); let json = null; try { json = await r.json(); } catch {} return { status: r.status, body: json }; })()`);
  const waitEnd = async (who, id) => { for (let i = 0; i < 200; i += 1) { const r = await api(who, "GET", `/imports/${id}`); if (!["queued", "running"].includes(r.body.import.status)) return r.body.import; await new Promise((x) => setTimeout(x, 100)); } throw new Error("never ended"); };
  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    for (const who of ["admin", "mia", "vic", "out", "ben", "anon"]) { browsers[who] = await launch(BROWSER); await browsers[who].open(`${base}/api/v1/health`, { width: 1440 }); if (who !== "anon") await signIn(browsers[who], who, who === "admin"); }
    ws = (await api("admin", "POST", "/workspaces", { name: "Imports" })).body.workspace;
    for (const [who, role] of [["mia", "MEMBER"], ["vic", "VIEWER"], ["ben", "MEMBER"]]) assert.equal((await api("admin", "POST", `/workspaces/${ws.id}/members`, { userId: (await api(who, "GET", "/me")).body.user.id, role })).status, 201);
    board = (await api("admin", "POST", `/workspaces/${ws.id}/boards`, { name: "Target", columns: COLUMNS })).body.board;
  });
  after(async () => { for (const b of Object.values(browsers)) await b?.close(); server?.kill(); });

  test("no session → 401 on every route", async () => {
    const id = "0".repeat(24);
    for (const [m, p] of [["GET", `/boards/${board.id}/imports`], ["POST", `/boards/${board.id}/imports`], ["GET", `/imports/${id}`], ["PATCH", `/imports/${id}`], ["POST", `/imports/${id}/start`], ["POST", `/imports/${id}/pause`], ["POST", `/imports/${id}/resume`], ["POST", `/imports/${id}/cancel`]]) assert.equal((await api("anon", m, p, m === "GET" ? undefined : {})).status, 401, `${m} ${p}`);
  });
  test("who can import: members yes, viewers no, outsiders see nothing; a job is its owner's and admins'", async () => {
    assert.equal((await upload("vic", "Item\nA\n")).status, 403);
    assert.equal((await upload("out", "Item\nA\n")).status, 404);
    const r = await upload("mia", "Item,Code\nA,1\nB,2\n");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.import.mapping, { serial: 0, code: 1 }); assert.equal(r.body.sample.length, 2);
    const id = r.body.import.id;
    assert.equal((await api("ben", "GET", `/imports/${id}`)).status, 404, "another member");
    assert.equal((await api("ben", "POST", `/imports/${id}/cancel`, {})).status, 404);
    assert.equal((await api("out", "GET", `/imports/${id}`)).status, 404);
    assert.equal((await api("admin", "GET", `/imports/${id}`)).status, 200);
    assert.ok(!(await api("ben", "GET", `/boards/${board.id}/imports`)).body.items.some((j) => j.id === id));
    assert.equal((await api("mia", "POST", `/imports/${id}/start`, {})).status, 409, "columns not confirmed yet");
    const set = await api("mia", "PATCH", `/imports/${id}`, { mapping: { serial: 0, code: 1 } });
    assert.equal(set.status, 200); assert.equal(set.body.check.valid, 2);
    assert.equal((await api("mia", "POST", `/imports/${id}/start`, {})).status, 200);
    const done = await waitEnd("mia", id);
    assert.equal(done.status, "done"); assert.equal(done.imported, 2);
    assert.equal((await api("mia", "PATCH", `/imports/${id}`, { mapping: { serial: 0 } })).status, 409, "too late to change");
  });
  test("an unreadable file is a clear error, and an oversized one is refused", async () => {
    const bad = await upload("mia", '"never ends', "bad.csv");
    assert.equal(bad.status, 422); assert.match(bad.body.error.message, /never ends/);
    const big = await browsers.mia.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1/boards/${board.id}/imports?name=big.csv", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-CSRF-Token": csrfToken }, body: new Blob([new Uint8Array(${LIMITS.fileBytes + 1024})]) }); return r.status; })()`);
    assert.equal(big, 413);
  });
  test("a CSRF token is required to upload", async () => {
    assert.equal(await browsers.mia.evaluate(`(async () => (await fetch("/api/v1/boards/${board.id}/imports?name=x.csv", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "Item\\nA\\n" })).status)()`), 403);
  });
  test("on screen: choose a file, map, check, start, see it finish, and the rows are on the board", async () => {
    const b = browsers.mia;
    await b.open(`${base}/`, { width: 1440 });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000));
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Target"))?.click()`);
    assert.ok(await b.waitFor("!!document.querySelector('.board-tools')", 10000));
    await b.evaluate(`(() => { const c = [...document.querySelectorAll('[data-action=import]')][0]; if (c) c.click(); })()`);
    assert.ok(await b.waitFor("!!document.querySelector('[data-action=xl-import-choose]')", 5000), "the import dialog offers Excel and CSV");
    await b.evaluate(`(() => { const input = document.querySelector('#xl-import-file'); const dt = new DataTransfer(); dt.items.add(new File(["Item,Code,State\\nOn screen 1,S1,New\\nOn screen 2,S2,Nonsense\\n"], "screen.csv", { type: "text/csv" })); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    assert.ok(await b.waitFor("!!document.querySelector('.xl-mapping')", 10000), "columns screen");
    assert.equal(await b.evaluate(`document.querySelector('[name="map:code"]').value`), "1", "suggested by name");
    assert.equal(await b.evaluate("document.querySelector('[data-action=xl-import-start]').disabled"), true, "must check first");
    await b.evaluate("document.querySelector('[data-action=xl-import-check]').click()");
    assert.ok(await b.waitFor("!!document.querySelector('.xl-check')", 5000));
    assert.match(await b.evaluate("document.querySelector('.xl-check').textContent"), /Row 3: State isn't one of its choices/);
    await b.evaluate("document.querySelector('[data-action=xl-import-start]').click()");
    assert.ok(await b.waitFor("document.querySelector('.xl-run h2')?.textContent === 'Import finished'", 20000), "finished on screen");
    assert.match(await b.evaluate("document.querySelector('.xl-run').textContent"), /1 imported/);
    await b.evaluate("document.querySelector('.xl-run .button.primary').click()");
    assert.ok(await b.waitFor(`[...document.querySelectorAll('tr[data-record-context]')].some((r) => r.textContent.includes("On screen 1"))`, 10000), "after closing the dialog, the new row is there without a page reload");
  });
});
