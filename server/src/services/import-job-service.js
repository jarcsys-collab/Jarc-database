// Excel and CSV imports into one board, as a background job that survives closing the browser or restarting the server.
//
//   upload      the file is parsed (domain/spreadsheet.js) and its rows kept in importBatches until the job ends; they are
//               removed at the end and, if a job is abandoned, by a TTL after 7 days. The file itself isn't kept.
//   settings    which column each file column goes to, the duplicate rule, and a check of the first rows that writes nothing.
//   run         one batch at a time, paced for the database. Each row has a fixed legacyId (import:<job>:<row>), protected by
//               uniq_board_legacy_id, and a batch's counters and the "next batch" move in one update. So a batch interrupted
//               at any moment can simply run again: rows already inserted are recognized, never repeated or double-counted.
//   restart     a job whose lease expired (its server stopped) is picked up where it left off.
//   duplicates  uniqueKey skips a row whose value is already on the board, or earlier in the file. The same file imported
//               to the same board again is refused unless asked for explicitly.
//   report      counts, and for rejected rows the row number and reason. Never the values.
//
// New boards (target "new-board", the only kind the API offers): the file is read and checked on a worker thread (services/workbook-runner.js),
// a person confirms what it found and the columns, every row is validated, and only after an explicit confirmation does the job create its own
// board and fill it. The board's ID is fixed in advance and the board records which job made it, so a restarted job finds the same board and a
// job can only ever write to the board it created. That board can be removed again, as long as nobody has changed it since.
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { COLLECTIONS } = require("../db/bootstrap");
const { fail, isObject, requireBody, allowOnly } = require("../validation/common");
const validate = require("../validation/resources");
const { effectiveOptions, isMultiColumn, groupColumnOf, PRIMARY_KEY } = require("../domain/board-schema");
const { parseSpreadsheet, LIMITS } = require("../domain/spreadsheet");
const { convertCell, lineLookup, DEFAULT_GROUP, LIMITS: BOARD_LIMITS } = require("../domain/workbook-structure");
const { readWorkbook, checkWorkbook } = require("./workbook-runner");
const { activityEntry, appendActivity } = require("./shared");

const BATCH_ROWS = 100, BATCH_BYTES = 4 * 1024 * 1024, KEEP_MS = 7 * 24 * 3600 * 1000, PREVIEW_ROWS = 500, MAX_ERRORS = 200;
// A batch costs about 230 database operations. This pace keeps an import well under the Atlas Flex limit of 500 per second.
const LEASE_MS = 60000, PAUSE_MS = 800, POLL_MS = 15000, MAX_ACTIVE_PER_USER = 3, MAX_ATTEMPTS = 5;
const UNMAPPABLE = new Set(["files", "group"]);
const REMOVE_BATCH = 200, REMOVE_PAUSE_MS = 500;
const OPEN = ["mapping", "ready", "queued", "running", "paused"], WRITE_PIECES = 20, WRITE_PAUSE_MS = 50, MAX_READING = 2, COLUMN_TYPES = new Set(["text", "number", "date"]);
const notFound = () => new ApiError(404, "NOT_FOUND", "This import doesn't exist or has ended.");
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const safeName = (name) => String(name || "file").replace(/[\u0000-\u001f<>]/g, "").slice(-120);

// ---- One cell of the file → one value of the column. Returns { value } (undefined: leave to the column's default) or { error }.
function dateText(text, order) {
  const t = text.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(t), parts;
  if (m) parts = [m[1], m[2], m[3]];
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T].*)?$/.exec(t))) parts = order === "dmy" ? [m[3], m[2], m[1]] : [m[3], m[1], m[2]];
  else return null;
  const iso = `${parts[0]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`, at = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === iso ? iso : null;
}
function cellValue(column, raw, { people, dateOrder }) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  if (column.type === "checkbox") {
    if (/^(true|yes|y|1|x|✓|checked)$/i.test(text)) return { value: true };
    if (/^(false|no|n|0)$/i.test(text)) return { value: false };
    return { error: "must be yes or no" };
  }
  if (column.type === "date") { const iso = dateText(text, dateOrder); return iso ? { value: iso } : { error: "isn't a date" }; }
  if (column.type === "owner") {
    const ids = [];
    for (const who of text.split(/[,;]/).map((v) => v.trim()).filter((v) => v && v !== "Unassigned")) {
      const hits = people.get(who.toLowerCase()) || [];
      if (hits.length !== 1) return { error: hits.length ? "matches more than one person" : "doesn't match a person in this workspace" };
      if (!ids.includes(hits[0])) ids.push(hits[0]);
    }
    return ids.length ? { value: ids } : {};
  }
  if (["status", "priority", "dropdown"].includes(column.type)) {
    const options = effectiveOptions(column), byLower = new Map(options.map((o) => [o.toLowerCase(), o]));
    const given = isMultiColumn(column) ? text.split(/[,;]/).map((v) => v.trim()).filter(Boolean) : [text];
    const out = given.map((v) => (options.length ? byLower.get(v.toLowerCase()) : v));
    if (out.some((v) => v === undefined)) return { error: "isn't one of its choices" };
    return { value: isMultiColumn(column) ? [...new Set(out)] : out[0] };
  }
  return { value: text };
}
function peopleIndex(users) {
  const index = new Map(), add = (key, ref) => { if (!key) return; const k = key.trim().toLowerCase(); index.set(k, [...new Set([...(index.get(k) || []), ref])]); };
  for (const u of users) { const ref = `user:${u._id.toHexString()}`; add(u.displayName, ref); add(u.email, ref); }
  return index;
}
// A row → the record input, or the first problem. No value of the row appears in the message.
function rowToInput(cells, job, board, context) {
  const columns = new Map(board.columns.map((c) => [c.key, c])), values = {};
  for (const [key, index] of Object.entries(job.mapping)) {
    const column = columns.get(key);
    const { value, error } = cellValue(column, cells[index], context);
    if (error) return { error: `${column.label || key} ${error}` };
    if (value !== undefined) values[key] = value;
  }
  let groupId = job.groupId || board.groups?.[0]?.id || null;
  if (job.groupFrom !== null && job.groupFrom !== undefined) {
    const name = String(cells[job.groupFrom] ?? "").trim().toLowerCase();
    if (name) { const hit = (board.groups || []).find((g) => g.name.trim().toLowerCase() === name); if (!hit) return { error: "Its group isn't on this board" }; groupId = hit.id; }
  }
  try { return { input: validate.recordCreate({ values, ...(groupId ? { groupId } : {}) }, board) }; }
  catch (error) { return { error: error instanceof ApiError ? error.message : "It couldn't be read" }; }
}

class ImportJobService {
  constructor({ boards = null, repos, connection, logger = console, searchIndex = null, pauseMs = PAUSE_MS, pollMs = POLL_MS, leaseMs = LEASE_MS }) {
    Object.assign(this, { boards, repos, connection, logger, searchIndex, pauseMs, pollMs, leaseMs, workerId: crypto.randomBytes(6).toString("hex"), running: false, timer: null });
    this.jobs = connection.db.collection(COLLECTIONS.importJobs);
    this.batches = connection.db.collection(COLLECTIONS.importBatches);
  }

  find(id) { return this.jobs.findOne({ _id: id }); }
  async sample(job, count) { const first = await this.batches.findOne({ jobId: job._id, n: 0 }); return (first?.rows || []).slice(0, count).map(([, cells]) => cells); }
  list(boardId, { userId = null } = {}) { return this.jobs.find({ boardId, ...(userId ? { createdBy: userId } : {}) }, { sort: { createdAt: -1 }, limit: 20 }).toArray(); }

  // ---- Upload
  async upload(board, buffer, { name, sheet }, actor) {
    if (board.source?.readOnly) throw new ApiError(403, "READ_ONLY_BOARD", "This board is synchronized from monday.com and is read-only in JARC.");
    const active = await this.jobs.countDocuments({ createdBy: actor.userId, status: { $in: ["mapping", "ready", "queued", "running", "paused"] } });
    if (active >= MAX_ACTIVE_PER_USER) throw new ApiError(409, "TOO_MANY_IMPORTS", `You have ${active} imports open. Finish or cancel one first.`);
    const parsed = parseSpreadsheet(buffer, { name, sheet });
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
    const previous = await this.jobs.findOne({ boardId: board._id, fileHash, status: "done" }, { projection: { finishedAt: 1, imported: 1 } });
    const now = new Date(), expiresAt = new Date(now.getTime() + KEEP_MS), jobId = new ObjectId();
    // Rows split by count and size, with an overall limit on what a file may occupy while it waits.
    let total = 0, n = 0, rows = [], bytes = 0, pending = [];
    const flush = async (force = false) => {
      if (rows.length) { pending.push({ _id: new ObjectId(), jobId, n, rows, expiresAt }); n += 1; rows = []; bytes = 0; }
      if (pending.length >= 50 || (force && pending.length)) { await this.batches.insertMany(pending, { ordered: true }); pending = []; }
    };
    try {
      for (const row of parsed.rows) {
        const size = row.cells.reduce((sum, c) => sum + Buffer.byteLength(c, "utf8") + 8, 16);
        total += size;
        if (total > LIMITS.textBytes) throw new ApiError(422, "IMPORT_UNREADABLE", "This file holds too much text to import at once. Split it into smaller files.");
        if (rows.length && (rows.length >= BATCH_ROWS || bytes + size > BATCH_BYTES)) await flush();
        rows.push([row.line, row.cells.slice(0, parsed.headers.length)]); bytes += size;
      }
      await flush(true);
    } catch (error) { await this.batches.deleteMany({ jobId }).catch(() => {}); throw error; }
    const doc = {
      _id: jobId, workspaceId: board.workspaceId, boardId: board._id, createdBy: actor.userId, actorName: actor.displayName, status: "mapping",
      fileName: safeName(name), fileHash, kind: parsed.kind, sheet: parsed.sheet, sheets: parsed.sheets, headers: parsed.headers, rowCount: parsed.rows.length, batchCount: n, nextBatch: 0,
      mapping: suggestMapping(parsed.headers, board), groupId: null, groupFrom: null, uniqueKey: null, dateOrder: "mdy", previousImport: previous ? { at: previous.finishedAt, imported: previous.imported } : null,
      imported: 0, skippedDuplicates: 0, rejected: 0, errors: [], attempts: 0, lastError: null, leaseOwner: null, leaseUntil: null, createdAt: now, updatedAt: now, expiresAt
    };
    await this.jobs.insertOne(doc);
    return doc;
  }

  // ---- A new board from a file. Reading happens on a worker thread; only the job's rows are stored here.
  listForWorkspace(workspaceId, { userId = null } = {}) { return this.jobs.find({ workspaceId, target: "new-board", ...(userId ? { createdBy: userId } : {}) }, { sort: { createdAt: -1 }, limit: 20 }).toArray(); }

  async createFromFile(workspace, buffer, { name, sheet }, actor) {
    const active = await this.jobs.countDocuments({ createdBy: actor.userId, status: { $in: OPEN } });
    if (active >= MAX_ACTIVE_PER_USER) throw new ApiError(409, "TOO_MANY_IMPORTS", `You have ${active} imports open. Finish or cancel one first.`);
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
    const open = await this.jobs.findOne({ workspaceId: workspace._id, fileHash, status: { $in: OPEN } }, { projection: { _id: 1 } });
    if (open) throw new ApiError(409, "IMPORT_ALREADY_OPEN", "This same file is already being imported in this workspace. Open that import instead.", { importId: open._id.toHexString() });
    const previous = await this.jobs.findOne({ workspaceId: workspace._id, fileHash, status: "done" }, { projection: { finishedAt: 1, imported: 1, boardName: 1 } });
    if ((this.reading || 0) >= MAX_READING) throw new ApiError(429, "IMPORT_BUSY", "Other files are being read right now. Try again in a moment.");
    this.reading = (this.reading || 0) + 1;
    const now = new Date(), expiresAt = new Date(now.getTime() + KEEP_MS), jobId = new ObjectId();
    let n = 0, pending = [];
    const store = async (force = false) => { if (pending.length >= WRITE_PIECES || (force && pending.length)) { await this.batches.insertMany(pending, { ordered: true }); pending = []; await sleep(this.writePauseMs ?? WRITE_PAUSE_MS); } };
    try {
      const read = await readWorkbook({ buffer, name, sheet, onRows: async (rows) => { pending.push({ _id: new ObjectId(), jobId, n, rows, expiresAt }); n += 1; await store(); } });
      await store(true);
      const doc = {
        _id: jobId, target: "new-board", workspaceId: workspace._id, boardId: null, plannedBoardId: new ObjectId(), createdBy: actor.userId, actorName: actor.displayName, status: "mapping",
        fileName: safeName(name), fileHash, kind: read.kind, sheet: read.sheet, sheets: read.sheets, notes: read.notes, rowCount: read.validation?.records ?? 0, batchCount: n, nextBatch: 0,
        structure: read.analysis, boardName: (read.analysis.boardTitle || safeName(name).replace(/\.[a-z0-9]+$/i, "")).slice(0, 200), columns: read.analysis.columns, itemColumn: read.analysis.itemColumn, uniqueColumn: null, dateOrder: "mdy", structureConfirmed: read.analysis.status === "clear",
        validation: read.validation, previousImport: previous ? { at: previous.finishedAt, imported: previous.imported, boardName: previous.boardName } : null,
        mapping: {}, groupId: null, groupFrom: null, uniqueKey: null, imported: 0, skippedDuplicates: 0, rejected: 0, errors: [], attempts: 0, lastError: null, leaseOwner: null, leaseUntil: null, createdAt: now, updatedAt: now, expiresAt
      };
      await this.jobs.insertOne(doc);
      return doc;
    } catch (error) { await this.batches.deleteMany({ jobId }).catch(() => {}); throw error; }
    finally { this.reading -= 1; }
  }

  // The person's decisions: which row holds the column names, what lone rows are, the columns and the board's name. Re-reads every stored
  // row on the worker thread, so the totals shown are always for the whole file. Writes no records.
  async review(job, raw) {
    const body = requireBody(raw);
    allowOnly(body, ["headerLine", "itemColumn", "soloRows", "totalRows", "columns", "boardName", "uniqueColumn", "dateOrder"], "the import settings");
    if (!["mapping", "ready"].includes(job.status)) throw new ApiError(409, "IMPORT_STARTED", "This import has already started.");
    if (body.headerLine !== undefined && !Number.isInteger(body.headerLine)) fail("headerLine must be a row number.");
    if (body.itemColumn !== undefined && !Number.isInteger(body.itemColumn)) fail("itemColumn must be a column number.");
    if (body.soloRows !== undefined && !["groups", "records"].includes(body.soloRows)) fail("soloRows must be groups or records.");
    if (body.totalRows !== undefined && !["skip", "records"].includes(body.totalRows)) fail("totalRows must be skip or records.");
    if (body.dateOrder !== undefined && !["mdy", "dmy"].includes(body.dateOrder)) fail("dateOrder must be mdy or dmy.");
    if (body.uniqueColumn !== undefined && body.uniqueColumn !== null && !Number.isInteger(body.uniqueColumn)) fail("uniqueColumn must be a column number or null.");
    if (body.boardName !== undefined && (typeof body.boardName !== "string" || !body.boardName.trim() || body.boardName.length > 200)) fail("The board's name must be 1 to 200 characters.");
    const headerChanged = body.headerLine !== undefined && body.headerLine !== job.structure.headerLine;
    if (body.columns !== undefined) {
      if (!Array.isArray(body.columns) || body.columns.length > BOARD_LIMITS.columns) fail("columns must be a list.");
      for (const c of body.columns) {
        if (!isObject(c) || !Number.isInteger(c.index)) fail("Each column needs its position in the file.");
        allowOnly(c, ["index", "label", "type", "include"], "a column");
        if (c.type !== undefined && !COLUMN_TYPES.has(c.type)) fail("A column can be text, a number or a date.");
        if (c.label !== undefined && (typeof c.label !== "string" || !c.label.trim() || c.label.length > 200)) fail("A column's name must be 1 to 200 characters.");
        if (c.include !== undefined && typeof c.include !== "boolean") fail("include must be true or false.");
      }
      const labels = body.columns.filter((c) => c.include !== false && c.label).map((c) => c.label.trim().toLowerCase());
      if (new Set(labels).size !== labels.length) fail("Two columns have the same name. Give each its own.");
    }
    const choices = { headerLine: body.headerLine ?? job.structure.headerLine ?? undefined, itemColumn: headerChanged ? body.itemColumn : (body.itemColumn ?? job.itemColumn ?? undefined), soloRows: body.soloRows ?? job.soloRows, totalRows: body.totalRows ?? job.totalRows };
    const settings = { columns: headerChanged ? undefined : (body.columns ?? job.columns), uniqueColumn: body.uniqueColumn === undefined ? job.uniqueColumn : body.uniqueColumn, dateOrder: body.dateOrder ?? job.dateOrder };
    const { analysis, validation } = await checkWorkbook({ rows: this.batches.find({ jobId: job._id }, { sort: { n: 1 } }), choices, settings, notes: job.notes });
    // Rows the file made ambiguous are settled by the person's choices; anything left is still shown and blocks starting.
    const open = analysis.reasons.filter((r) => !(r.code === "header-unclear" && choices.headerLine !== undefined) && !(r.code === "item-column-unclear" && choices.itemColumn !== undefined) && r.code !== "header-differs");
    const included = analysis.columns.filter((c) => c.include !== false);
    if (analysis.headerLine !== null && !included.some((c) => c.index === analysis.itemColumn)) open.push({ code: "item-column-excluded", message: "The column that names each record has to be imported." });
    const set = { structure: { ...analysis, reasons: open }, columns: analysis.columns, itemColumn: analysis.itemColumn, soloRows: choices.soloRows ?? null, totalRows: choices.totalRows ?? null, uniqueColumn: settings.uniqueColumn ?? null, dateOrder: settings.dateOrder, validation, rowCount: validation?.records ?? 0, structureConfirmed: open.length === 0, boardName: body.boardName?.trim() ?? job.boardName, status: open.length === 0 && validation && !validation.errorCount && validation.records ? "ready" : "mapping", updatedAt: new Date() };
    const updated = await this.jobs.findOneAndUpdate({ _id: job._id, status: { $in: ["mapping", "ready"] } }, { $set: set }, { returnDocument: "after" });
    if (!updated) throw new ApiError(409, "IMPORT_STARTED", "This import has already started.");
    return updated;
  }

  // Only with an explicit confirmation. The board itself is created by the worker, so a restart can't lose or repeat it.
  async startNewBoard(job, raw) {
    const body = raw === undefined ? {} : requireBody(raw);
    allowOnly(body, ["confirmNewBoard", "repeat"], "the request");
    if (job.status !== "ready") throw new ApiError(409, "IMPORT_NOT_READY", job.validation?.errorCount ? "This file still has problems. Fix them in the file and upload it again." : "Check this file's columns first.");
    if (body.confirmNewBoard !== true) throw new ApiError(409, "CONFIRMATION_NEEDED", "Confirm creating the new board first.");
    if (job.previousImport && body.repeat !== true) throw new ApiError(409, "ALREADY_IMPORTED", "This same file was already imported in this workspace. Confirm importing it again to continue.", { previousImport: job.previousImport });
    if (await this.batches.countDocuments({ jobId: job._id }) !== job.batchCount) throw new ApiError(409, "IMPORT_EXPIRED", "This upload has expired. Upload the file again.");
    const keyOf = (c) => (c.index === job.itemColumn ? PRIMARY_KEY : `col_${c.index}`);
    const included = job.columns.filter((c) => c.include !== false), mapping = Object.fromEntries(included.map((c) => [keyOf(c), c.index]));
    const uniqueKey = job.uniqueColumn !== null && job.uniqueColumn !== undefined && mapping[`col_${job.uniqueColumn}`] !== undefined ? `col_${job.uniqueColumn}` : job.uniqueColumn === job.itemColumn && job.uniqueColumn !== null ? PRIMARY_KEY : null;
    const updated = await this.jobs.findOneAndUpdate({ _id: job._id, status: "ready" }, { $set: { status: "queued", mapping, uniqueKey, basePosition: 0, everyone: false, startedAt: new Date(), updatedAt: new Date() } }, { returnDocument: "after" });
    if (!updated) throw new ApiError(409, "IMPORT_NOT_READY", "This import has already started.");
    this.logger.log?.(`[imports] ${job._id.toHexString()} started: ${job.rowCount} records, new board ${job.plannedBoardId.toHexString()}.`);
    this.wake();
    return updated;
  }

  // The job's own board. Found again if it was already made; a board this job didn't make is never used.
  async ensureBoard(job) {
    const existing = await this.repos.boards.findById(job.plannedBoardId);
    if (existing) { if (!existing.importJobId?.equals?.(job._id)) throw new ApiError(409, "IMPORT_BOARD_MISMATCH", "This import's board belongs to something else."); return existing; }
    if (job.boardId) return null; // it was made, and has since been deleted
    const keyOf = (c) => (c.index === job.itemColumn ? PRIMARY_KEY : `col_${c.index}`), ordered = job.columns.filter((c) => c.include !== false).sort((a, b) => (a.index === job.itemColumn ? -1 : b.index === job.itemColumn ? 1 : a.index - b.index));
    const columns = ordered.map((c) => ({ key: keyOf(c), label: c.label, type: c.index === job.itemColumn ? "text" : c.type || "text", required: c.index === job.itemColumn }));
    const groups = (job.validation.groups.length ? job.validation.groups : [{ name: DEFAULT_GROUP }]).map((g) => ({ name: g.name.slice(0, 200) }));
    const actor = { userId: job.createdBy, displayName: job.actorName };
    try { return await this.boards.create(job.workspaceId, { name: job.boardName, columns, groups }, actor, { id: job.plannedBoardId, importJobId: job._id }); }
    catch (error) { if (error?.code === 11000) return this.repos.boards.findById(job.plannedBoardId); throw error; }
  }

  // Removes a new board this import made, only if it's still exactly what the import put there. Never touches anything else.
  async cleanUp(job, actor) {
    if (job.target !== "new-board") throw new ApiError(409, "IMPORT_NOT_REMOVABLE", "Only a new board made by an import can be removed this way.");
    if (!["done", "failed", "cancelled"].includes(job.status)) throw new ApiError(409, "IMPORT_RUNNING", "Stop this import first.");
    const board = await this.repos.boards.findById(job.plannedBoardId);
    if (!board) { const ended = await this.jobs.findOneAndUpdate({ _id: job._id }, { $set: { status: "removed", removedAt: new Date(), updatedAt: new Date() } }, { returnDocument: "after" }); return { removed: false, job: ended }; }
    if (!board.importJobId?.equals?.(job._id)) throw new ApiError(409, "IMPORT_BOARD_MISMATCH", "This board wasn't made by this import, so it wasn't removed.");
    const prefix = `^import:${job._id.toHexString()}:`, records = this.repos.records.collection;
    const foreign = await records.countDocuments({ boardId: board._id, $or: [{ legacyId: { $not: { $regex: prefix } } }, { version: { $ne: 1 } }] });
    const talk = await this.repos.comments.collection.countDocuments({ boardId: board._id }), files = await this.repos.attachments.collection.countDocuments({ boardId: board._id });
    if (foreign || talk || files) throw new ApiError(409, "IMPORT_BOARD_CHANGED", "People have changed this board since the import, so it wasn't removed. Delete the board from its menu if you're sure.", { changedRecords: foreign, comments: talk, files });
    // Paced by the worker, like the import itself: a large board's records can't all be deleted at once on a shared cluster.
    const started = await this.jobs.findOneAndUpdate({ _id: job._id, status: { $in: ["done", "failed", "cancelled"] } }, { $set: { status: "removing", removedBy: actor.userId, removedByName: actor.displayName, removedRecords: 0, leaseOwner: null, leaseUntil: null, lastError: null, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!started) throw new ApiError(409, "IMPORT_RUNNING", "This import has changed. Open it again.");
    this.wake();
    return { removed: true, job: started };
  }

  // Deletes only what the import wrote and nobody has changed, in paced batches, then the board. A restart continues it. If anything else is
  // on the board by the end, the board stays and the job says why.
  async runRemoval(job) {
    const board = await this.repos.boards.findById(job.plannedBoardId);
    const done = (set) => this.jobs.findOneAndUpdate({ _id: job._id, leaseOwner: this.workerId }, { $set: { leaseOwner: null, leaseUntil: null, updatedAt: new Date(), ...set } }, { returnDocument: "after" });
    if (!board) return done({ status: "removed", removedAt: new Date() });
    if (!board.importJobId?.equals?.(job._id)) return done({ status: "failed", lastError: "This board wasn't made by this import, so it wasn't removed." });
    const records = this.repos.records.collection, mine = { boardId: board._id, version: 1, legacyId: { $regex: `^import:${job._id.toHexString()}:` } };
    let removed = job.removedRecords || 0;
    while (!this.stopping) {
      const ids = (await records.find(mine, { projection: { _id: 1 }, limit: REMOVE_BATCH }).toArray()).map((r) => r._id);
      if (!ids.length) break;
      const { deletedCount } = await records.deleteMany({ ...mine, _id: { $in: ids } });
      removed += deletedCount;
      const held = await this.jobs.findOneAndUpdate({ _id: job._id, leaseOwner: this.workerId }, { $set: { removedRecords: removed, leaseUntil: new Date(Date.now() + this.leaseMs), updatedAt: new Date() } });
      if (!held) return undefined;
      await sleep(this.removePauseMs ?? REMOVE_PAUSE_MS);
    }
    if (this.stopping) return undefined;
    if (await records.countDocuments({ boardId: board._id })) return done({ status: "failed", removedRecords: removed, lastError: "Someone changed this board during the removal, so the board and those records were kept." });
    const current = await this.repos.boards.findById(board._id);
    await this.boards.delete(board._id, current.version, { userId: job.removedBy, displayName: job.removedByName });
    this.logger.log?.(`[imports] ${job._id.toHexString()} removed its board ${board._id.toHexString()} and ${removed} records.`);
    return done({ status: "removed", removedRecords: removed, removedAt: new Date() });
  }

  // Every problem found in the file, as a CSV to download. Row numbers, column names and reasons, never the values.
  reportCsv(job) {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`, lines = [["Row", "Column", "Problem"].map(q).join(",")];
    const list = job.status === "mapping" || job.status === "ready" ? job.validation?.errors || [] : [...(job.validation?.errors || []), ...(job.errors || []).map((e) => ({ row: e.row, column: "", reason: e.reason }))];
    for (const e of list) lines.push([e.row, e.column, e.reason].map(q).join(","));
    if ((job.validation?.errorCount || 0) > (job.validation?.errors?.length || 0)) lines.push(q(`And ${job.validation.errorCount - job.validation.errors.length} more of the same kinds.`));
    return `${lines.join("\r\n")}\r\n`;
  }

  // ---- Settings and the check before starting
  async configure(job, board, raw) {
    const body = requireBody(raw);
    allowOnly(body, ["mapping", "groupId", "groupFrom", "uniqueKey", "dateOrder"], "the import settings");
    if (!["mapping", "ready"].includes(job.status)) throw new ApiError(409, "IMPORT_STARTED", "This import has already started.");
    const settings = cleanSettings(body, job, board);
    const updated = await this.jobs.findOneAndUpdate({ _id: job._id, status: { $in: ["mapping", "ready"] } }, { $set: { ...settings, status: "ready", updatedAt: new Date() } }, { returnDocument: "after" });
    if (!updated) throw new ApiError(409, "IMPORT_STARTED", "This import has already started.");
    return updated;
  }
  async peopleFor(board, everyone) {
    if (everyone) return peopleIndex(await this.repos.users.listActive());
    const ids = (await this.repos.memberships.listByWorkspace(board.workspaceId)).filter((m) => m.status === "active").map((m) => m.userId);
    return peopleIndex((await this.repos.users.findByIds(ids)).filter((u) => u.status === "active"));
  }
  // The first rows, as the run would treat them. Writes nothing.
  async check(job, board, everyone = false) {
    const context = { people: await this.peopleFor(board, everyone), dateOrder: job.dateOrder }, problems = [], seen = new Set(), keys = [];
    let checked = 0, valid = 0, inFile = 0;
    for (let n = job.nextBatch; n < job.batchCount && checked < PREVIEW_ROWS; n += 1) {
      const batch = await this.batches.findOne({ jobId: job._id, n });
      if (!batch) break;
      for (const [line, cells] of batch.rows) {
        if (checked >= PREVIEW_ROWS) break;
        checked += 1;
        const { input, error } = rowToInput(cells, job, board, context);
        if (error) { if (problems.length < 20) problems.push({ row: line, reason: error }); continue; }
        valid += 1;
        if (job.uniqueKey) { const v = input.values[job.uniqueKey]; if (hasKey(v)) { if (seen.has(v)) inFile += 1; else { seen.add(v); keys.push(v); } } }
      }
    }
    const existing = job.uniqueKey && keys.length ? await this.repos.records.collection.countDocuments({ boardId: board._id, archived: false, [`values.${job.uniqueKey}`]: { $in: keys } }) : 0;
    return { checked, valid, problems, rowCount: job.rowCount, duplicatesInFile: inFile, duplicatesOnBoard: existing };
  }

  // ---- Control
  async start(job, board, raw, everyone) {
    const body = raw === undefined ? {} : requireBody(raw);
    allowOnly(body, ["repeat"], "the request");
    if (job.status !== "ready") throw new ApiError(409, "IMPORT_NOT_READY", "Choose the columns for this import first.");
    if (job.previousImport && body.repeat !== true) throw new ApiError(409, "ALREADY_IMPORTED", "This same file was already imported to this board.", { previousImport: job.previousImport });
    if (await this.batches.countDocuments({ jobId: job._id }) !== job.batchCount) throw new ApiError(409, "IMPORT_EXPIRED", "This upload has expired. Upload the file again.");
    const first = await this.repos.records.firstPosition(board._id);
    const updated = await this.jobs.findOneAndUpdate({ _id: job._id, status: "ready" }, { $set: { status: "queued", basePosition: first - 1000 * (job.rowCount + 1), everyone: Boolean(everyone), startedAt: new Date(), updatedAt: new Date() } }, { returnDocument: "after" });
    if (!updated) throw new ApiError(409, "IMPORT_NOT_READY", "This import has already started.");
    this.wake();
    return updated;
  }
  async pause(job) {
    const updated = await this.jobs.findOneAndUpdate({ _id: job._id, status: { $in: ["queued", "running"] } }, { $set: { status: "paused", leaseOwner: null, leaseUntil: null, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!updated) throw new ApiError(409, "IMPORT_NOT_RUNNING", "This import isn't running.");
    return updated;
  }
  async resume(job) {
    const updated = await this.jobs.findOneAndUpdate({ _id: job._id, status: "paused" }, { $set: { status: "queued", attempts: 0, lastError: null, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!updated) throw new ApiError(409, "IMPORT_NOT_PAUSED", "This import isn't paused.");
    this.wake();
    return updated;
  }
  // Records already imported stay on the board; what hasn't run yet is dropped.
  async cancel(job) {
    const updated = await this.jobs.findOneAndUpdate({ _id: job._id, status: { $in: ["mapping", "ready", "queued", "running", "paused"] } }, { $set: { status: "cancelled", finishedAt: new Date(), leaseOwner: null, leaseUntil: null, updatedAt: new Date() }, $unset: { "validation.preview": "" } }, { returnDocument: "after" });
    if (!updated) throw new ApiError(409, "IMPORT_ENDED", "This import has already ended.");
    await this.batches.deleteMany({ jobId: job._id });
    if (updated.imported) await this.announce(updated);
    return updated;
  }

  // ---- The worker
  startWorker() {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), this.pollMs);
    this.timer.unref?.();
    this.wake();
  }
  stopWorker() { clearInterval(this.timer); this.timer = null; this.stopping = true; }
  wake() { if (!this.running) this.drain().catch((error) => this.logger.error?.(`[imports] worker: ${error?.name || "Error"}`)); }
  async drain() {
    this.running = true;
    try {
      while (!this.stopping) {
        const removal = await this.claimRemoval();
        if (removal) { await this.runRemoval(removal); continue; }
        const job = await this.claim();
        if (!job) return;
        await this.run(job);
      }
    }
    finally { this.running = false; }
  }
  claimRemoval() {
    const now = new Date();
    return this.jobs.findOneAndUpdate({ status: "removing", $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] }, { $set: { leaseOwner: this.workerId, leaseUntil: new Date(now.getTime() + this.leaseMs), updatedAt: now } }, { sort: { updatedAt: 1 }, returnDocument: "after" });
  }
  claim() {
    const now = new Date();
    return this.jobs.findOneAndUpdate({ $or: [{ status: "queued" }, { status: "running", leaseUntil: { $lt: now } }] }, { $set: { status: "running", leaseOwner: this.workerId, leaseUntil: new Date(now.getTime() + this.leaseMs), updatedAt: now } }, { sort: { updatedAt: 1 }, returnDocument: "after" });
  }
  async run(job) {
    if (job.target === "new-board" && !job.boardId) {
      let made;
      try { made = await this.ensureBoard(job); }
      catch (error) { this.logger.error?.(`[imports] couldn't create the board: ${error?.code || error?.name || "Error"}`); return this.finish(job, "failed", error instanceof ApiError ? error.message : "The new board couldn't be created. Nothing was imported."); }
      const held = await this.jobs.findOneAndUpdate({ _id: job._id, leaseOwner: this.workerId, status: "running" }, { $set: { boardId: made._id, updatedAt: new Date() } }, { returnDocument: "after" });
      if (!held) return undefined;
      job = held;
    }
    while (!this.stopping) {
      const board = await this.repos.boards.findById(job.boardId);
      if (!board) return this.finish(job, "failed", "The board was deleted.");
      // A job only ever writes to the board it made.
      if (job.target === "new-board" && !board.importJobId?.equals?.(job._id)) return this.finish(job, "failed", "This import's board belongs to something else. Nothing more was imported.");
      const columns = new Set(board.columns.map((c) => c.key)), gone = Object.keys(job.mapping).find((k) => !columns.has(k));
      if (gone) return this.halt(job, "A column this import uses was removed from the board. Resume after restoring it, or cancel.");
      const batch = await this.batches.findOne({ jobId: job._id, n: job.nextBatch });
      if (!batch) {
        if (job.nextBatch >= job.batchCount) return this.finish(job, "done");
        return this.finish(job, "failed", "This upload's rows have expired. Upload the file again; rows already imported are recognized if you use the same duplicate rule.");
      }
      let outcome;
      try { outcome = await this.runBatch(job, board, batch); }
      catch (error) {
        const attempts = (job.attempts || 0) + 1;
        this.logger.error?.(`[imports] batch failed: ${error?.name || "Error"}${error?.code ? ` ${error.code}` : ""}`);
        if (attempts >= MAX_ATTEMPTS) return this.halt(job, "The database couldn't be reached. Resume to continue from where it stopped.");
        const held = await this.jobs.findOneAndUpdate({ _id: job._id, leaseOwner: this.workerId, status: "running" }, { $set: { attempts, leaseUntil: new Date(Date.now() + this.leaseMs), updatedAt: new Date() } }, { returnDocument: "after" });
        if (!held) return undefined;
        job = held;
        await sleep(this.pauseMs * 2 ** attempts);
        continue;
      }
      // The batch's counters and the position move together, and only while this worker still holds the job.
      const moved = await this.jobs.findOneAndUpdate({ _id: job._id, leaseOwner: this.workerId, status: "running", nextBatch: job.nextBatch }, {
        $set: { nextBatch: job.nextBatch + 1, attempts: 0, leaseUntil: new Date(Date.now() + this.leaseMs), updatedAt: new Date() },
        $inc: { imported: outcome.imported, skippedDuplicates: outcome.skippedDuplicates, rejected: outcome.errors.length },
        ...(outcome.errors.length ? { $push: { errors: { $each: outcome.errors, $slice: MAX_ERRORS } } } : {})
      }, { returnDocument: "after" });
      if (!moved) return undefined; // paused, cancelled or taken over: whoever holds it carries on
      job = moved;
      await this.batches.deleteOne({ _id: batch._id });
      await sleep(this.pauseMs);
    }
    return undefined;
  }
  async runBatch(job, board, batch) {
    const hex = job._id.toHexString(), legacyOf = (line) => `import:${hex}:${line}`;
    if (job.target === "new-board") { const { skip, groupOf } = lineLookup(job.structure), groupIds = new Map(board.groups.map((g) => [g.name, g.id])); batch = { ...batch, rows: batch.rows.filter(([line]) => !skip.has(line) && line >= job.structure.headerLine) }; job = { ...job, groupOf: (line) => groupIds.get(groupOf(line)) ?? board.groups[0]?.id ?? null }; }
    const context = job.target === "new-board" ? { dateOrder: job.dateOrder } : { people: await this.peopleFor(board, job.everyone), dateOrder: job.dateOrder };
    const written = await this.repos.records.collection.find({ boardId: board._id, legacyId: { $in: batch.rows.map(([line]) => legacyOf(line)) } }, { projection: { legacyId: 1 } }).toArray();
    const already = new Set(written.map((r) => r.legacyId));
    const errors = [], prepared = [];
    for (const [line, cells] of batch.rows) {
      const { input, error } = job.target === "new-board" ? newBoardInput(line, cells, job, board, context) : rowToInput(cells, job, board, context);
      if (error) errors.push({ row: line, reason: error }); else prepared.push({ line, input });
    }
    let skippedDuplicates = 0, candidates = prepared;
    if (job.uniqueKey) {
      const field = `values.${job.uniqueKey}`, keys = [...new Set(prepared.filter((p) => !already.has(legacyOf(p.line))).map((p) => p.input.values[job.uniqueKey]).filter(hasKey))];
      const found = keys.length ? new Set((await this.repos.records.collection.find({ boardId: board._id, archived: false, [field]: { $in: keys } }, { projection: { [field]: 1 } }).toArray()).map((r) => r.values[job.uniqueKey])) : new Set();
      const seen = new Set();
      candidates = prepared.filter((p) => {
        if (already.has(legacyOf(p.line))) return true;
        const v = p.input.values[job.uniqueKey];
        if (!hasKey(v)) return true;
        if (found.has(v) || seen.has(v)) { skippedDuplicates += 1; return false; }
        seen.add(v);
        return true;
      });
    }
    const now = new Date(), fresh = candidates.filter((p) => !already.has(legacyOf(p.line)));
    const docs = fresh.map(({ line, input }, i) => ({
      _id: new ObjectId(), workspaceId: board.workspaceId, boardId: board._id, legacyId: legacyOf(line), values: input.values, groupId: input.groupId,
      position: job.basePosition + 1000 * (job.nextBatch * BATCH_ROWS + i + 1), archived: false, pinned: false, createdBy: job.createdBy, updatedBy: job.createdBy, createdAt: now, updatedAt: now, version: 1
    }));
    // Rows an interrupted attempt wrote are refreshed too: that attempt may have stopped before it could queue them.
    if (written.length) this.searchIndex?.refresh(board._id, written.map((r) => r._id));
    if (docs.length) {
      // Even a failed insert may have written some rows. Queued regardless: an ID that wasn't written simply finds no record.
      try { await this.repos.records.collection.insertMany(docs, { ordered: false }); }
      catch (error) { if (!isOnlyDuplicates(error)) { this.searchIndex?.refresh(board._id, docs.map((d) => d._id)); throw error; } }
      this.searchIndex?.refresh(board._id, docs.map((d) => d._id));
    }
    return { imported: candidates.length, skippedDuplicates, errors };
  }
  halt(job, reason) { return this.jobs.updateOne({ _id: job._id, leaseOwner: this.workerId }, { $set: { status: "paused", lastError: reason, leaseOwner: null, leaseUntil: null, updatedAt: new Date() } }); }
  async finish(job, status, reason = null) {
    const updated = await this.jobs.findOneAndUpdate({ _id: job._id, leaseOwner: this.workerId }, { $set: { status, lastError: reason, finishedAt: new Date(), leaseOwner: null, leaseUntil: null, updatedAt: new Date() }, $unset: { expiresAt: "", "validation.preview": "" } }, { returnDocument: "after" });
    this.logger.log?.(`[imports] ${job._id.toHexString()} ${status}: ${updated?.imported ?? 0} imported, ${updated?.skippedDuplicates ?? 0} skipped, ${updated?.rejected ?? 0} rejected.`);
    await this.batches.deleteMany({ jobId: job._id });
    if (updated?.imported) await this.announce(updated);
  }
  // One entry for the whole import: colleagues' open boards refresh from it.
  announce(job) {
    return appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: job.workspaceId, boardId: job.boardId, actorUserId: job.createdBy, actorName: job.actorName, action: "records.created", entityType: "board", entityId: job.boardId, summary: `Imported ${job.imported} record${job.imported === 1 ? "" : "s"} from ${job.fileName}`, now: new Date() }));
  }
}

// One row → a record of the job's new board. Text is kept exactly as written; only a date or number column the person chose converts it.
function newBoardInput(line, cells, job, board, { dateOrder }) {
  const columns = new Map(board.columns.map((c) => [c.key, c])), values = {};
  for (const [key, index] of Object.entries(job.mapping)) {
    const column = columns.get(key), { value, error } = convertCell(column.type, cells[index], { dateOrder });
    if (error) return { error: `${column.label || key} ${error}` };
    if (value !== undefined) values[key] = value;
  }
  const groupId = job.groupOf(line);
  try { return { input: validate.recordCreate({ values, ...(groupId ? { groupId } : {}) }, board) }; }
  catch (error) { return { error: error instanceof ApiError ? error.message : "It couldn't be read" }; }
}

const hasKey = (v) => v !== undefined && v !== null && v !== "" && !Array.isArray(v);
const isOnlyDuplicates = (error) => error?.code === 11000 && (error.writeErrors ? [].concat(error.writeErrors).every((e) => (e.code ?? e.err?.code) === 11000) : true);

function suggestMapping(headers, board) {
  const mapping = {}, used = new Set(), group = groupColumnOf(board.columns)?.key;
  for (const column of board.columns) {
    if (UNMAPPABLE.has(column.type) || column.key === group) continue;
    const label = String(column.label || "").trim().toLowerCase(), key = column.key.toLowerCase();
    const i = headers.findIndex((h, n) => !used.has(n) && (h.trim().toLowerCase() === label || h.trim().toLowerCase() === key));
    if (i >= 0) { mapping[column.key] = i; used.add(i); }
  }
  return mapping;
}
function cleanSettings(body, job, board) {
  const out = {}, columns = new Map(board.columns.map((c) => [c.key, c])), group = groupColumnOf(board.columns)?.key, width = job.headers.length;
  const index = (v, label) => { if (!Number.isInteger(v) || v < 0 || v >= width) fail(`${label} must be one of the file's columns.`); return v; };
  const mapping = body.mapping ?? job.mapping;
  if (!isObject(mapping)) fail("mapping must be an object of column key → file column.");
  const clean = {}, used = new Set();
  for (const [key, v] of Object.entries(mapping)) {
    const column = Object.hasOwn(mapping, key) ? columns.get(key) : null;
    if (!column || UNMAPPABLE.has(column.type) || key === group) fail(`"${String(key).slice(0, 40)}" can't take imported values.`);
    index(v, `The source of ${column.label || key}`);
    if (used.has(v)) fail("Each file column can go to only one board column.");
    used.add(v); clean[key] = v;
  }
  if (clean[PRIMARY_KEY] === undefined) fail("Choose which file column holds the item name.");
  out.mapping = clean;
  if (body.groupId !== undefined) { if (body.groupId !== null && !(board.groups || []).some((g) => g.id === body.groupId)) fail("groupId must be one of this board's groups."); out.groupId = body.groupId; }
  if (body.groupFrom !== undefined) out.groupFrom = body.groupFrom === null ? null : index(body.groupFrom, "The group source");
  if (body.uniqueKey !== undefined) {
    if (body.uniqueKey !== null) { const c = columns.get(body.uniqueKey); if (clean[body.uniqueKey] === undefined || !c || isMultiColumn(c) || c.type === "checkbox") fail("Duplicates can be detected on a single-value column being imported."); }
    out.uniqueKey = body.uniqueKey;
  }
  if (body.dateOrder !== undefined) { if (!["mdy", "dmy"].includes(body.dateOrder)) fail("dateOrder must be mdy or dmy."); out.dateOrder = body.dateOrder; }
  return out;
}

module.exports = { ImportJobService, BATCH_ROWS, MAX_ACTIVE_PER_USER, cellValue, dateText, suggestMapping };
