// Machine Installation Database attachment import (monday.com board → JARC records, files into Google Drive). It runs
// INSIDE the JARC server because only the server holds the Google Drive connection. Off unless MID_ATTACHMENTS_MIGRATION
// is true; only Google Drive administrators can use it (routes/mid-attachments.js). It loads none of the migration tool's
// production policy: the file writer (files/migration-writer.js) is shared, the tool's approval gates are not.
//
//   plan      uploaded by an administrator from the Git-ignored local inventory (scripts/mid-attachments-plan.js): one
//             entry per file with the monday.com asset and item IDs and the planned JARC attachment and record IDs.
//             Nothing about the plan is stored in the repository. Its SHA-256 identifies the run (runId mid-<16 hex>).
//   dry run   READ-ONLY: the plan against production (record exists on the board, the item mapping points at it, the
//             Files column exists, nothing conflicting already exists), Drive and JARC capacity, and optionally whether
//             monday.com still serves every file with the expected size. Writes nothing anywhere.
//   prepare   writes the run and one item per file to integrationJobs (deterministic _ids, so repeating it adds nothing).
//   start     a 20-file pilot or the full run, only with a recorded backup (reference + time, at most 24 h old) and
//             enough capacity. pause / resume / stop at any time; files already started finish.
//   worker    claims one item at a time with a lease (a crash or restart lets another pass take it over); per file:
//             fresh monday.com download URL → bytes (size-checked, SHA-256) → AttachmentWriter (the migration's own
//             duplicate-proof sequence) into Google Drive, tagged jarcKind "mig" + jarcRun. Temporary failures retry with
//             backoff (at most 5 attempts); a full or disconnected Drive pauses the run; permanent problems fail the item.
//   verify    READ-ONLY reconciliation: items, attachments, mappings and the run's Drive files (size and SHA-256 compared).
//   rollback  only this run: its Drive files to Trash, its attachments and asset mappings removed, storage counters given
//             back. Nothing else is touched: no record, no other attachment, no other mapping.
// Records are never written: an attachment never changes its record. Logs never contain tokens or download URLs.
const crypto = require("crypto");
const { Readable } = require("stream");
const { ObjectId } = require("mongodb");
const { COLLECTIONS } = require("../db/bootstrap");
const { ApiError } = require("../middleware/errors");
const { MIGRATION_TYPES, MAX_FILE_BYTES, classifyAsset } = require("../files/file-types");
const { MondayClient } = require("../integrations/monday/client");
const { AttachmentWriter, MAPPING_PROVIDER } = require("../files/migration-writer");

const PROVIDER = "mid-attachments";
const RUN_TYPE = "mid-attachments-run", ITEM_TYPE = "mid-attachment";
const PLAN_KIND = "jarc-mid-attachments-plan";
const PILOT_MAX = 20, MAX_ATTEMPTS = 5, MAX_ENTRIES = 20000;
const LEASE_MS = 10 * 60 * 1000, BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PER_PASS = 25; // files one worker handles before it looks at the run's state again
// JFIF files keep their names (the bytes are JPEG; image/jpeg is served).
const TYPES = Object.freeze({ ...MIGRATION_TYPES, "image/jpeg": { ...MIGRATION_TYPES["image/jpeg"], extensions: [...MIGRATION_TYPES["image/jpeg"].extensions, "jfif"] } });
const PERMANENT = new Set(["MIGRATION_ATTACHMENT_RECORD_MISSING", "MIGRATION_ATTACHMENT_COLUMN_MISSING", "MIGRATION_ATTACHMENT_NOT_IMPORTABLE", "MIGRATION_ATTACHMENT_TYPE", "MIGRATION_ATTACHMENT_SIZE", "MIGRATION_ATTACHMENT_TOO_LARGE", "MIGRATION_MAPPING_CONFLICT", "MIGRATION_DESTINATION_CONFLICT", "MIGRATION_SOURCE_MISSING", "MIGRATION_SOURCE_CHANGED", "UNSUPPORTED_FILE_TYPE", "CHECKSUM_MISMATCH", "PAYLOAD_TOO_LARGE"]);
// Problems no retry can fix, but an administrator can: the whole run pauses with the reason, and the file goes back in line.
const PAUSING = new Set(["MIGRATION_STORAGE_FULL", "STORAGE_FULL", "STORAGE_NOT_CONNECTED", "MONDAY_UNAUTHORIZED"]);
const HEX24 = /^[0-9a-f]{24}$/, DIGITS = /^\d{1,20}$/, KEY = /^[A-Za-z0-9_-]{1,100}$/;

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const fail = (status, code, message, details) => new ApiError(status, code, message, details);
const sourceError = (code, message, retry = false) => Object.assign(new Error(message), { code, retry });

// ---- The plan (pure: no database)
// Returns { plan, digest, runId, issues } where issues lists entries that can never be imported.
function normalizePlan(raw, { maxBytes }) {
  if (!raw || typeof raw !== "object" || raw.kind !== PLAN_KIND || raw.version !== 1) throw fail(400, "PLAN_INVALID", `This isn't a ${PLAN_KIND} (version 1) file.`);
  if (typeof raw.sourceRunId !== "string" || !/^monday-\d{1,20}-[0-9a-f]{12}$/.test(raw.sourceRunId)) throw fail(400, "PLAN_INVALID", "sourceRunId must be the records migration's run ID.");
  if (!HEX24.test(String(raw.boardId))) throw fail(400, "PLAN_INVALID", "boardId must be a JARC board ID.");
  if (!Array.isArray(raw.entries) || !raw.entries.length || raw.entries.length > MAX_ENTRIES) throw fail(400, "PLAN_INVALID", `entries must list 1 to ${MAX_ENTRIES} files.`);
  const issues = [], entries = [], seenAsset = new Set(), seenAttachment = new Set();
  raw.entries.forEach((e, i) => {
    const where = `entry ${i + 1}`;
    const ok = e && DIGITS.test(String(e.assetId)) && DIGITS.test(String(e.sourceItemId)) && HEX24.test(String(e.attachmentId)) && HEX24.test(String(e.recordId)) && KEY.test(String(e.columnKey))
      && typeof e.name === "string" && e.name.length > 0 && e.name.length <= 255 && Number.isSafeInteger(e.sizeBytes) && e.sizeBytes > 0;
    if (!ok) throw fail(400, "PLAN_INVALID", `${where} is incomplete or malformed.`);
    const assetId = String(e.assetId), attachmentId = String(e.attachmentId);
    if (seenAsset.has(assetId)) issues.push({ assetId, problem: "duplicate-asset-in-plan" });
    if (seenAttachment.has(attachmentId)) issues.push({ assetId, problem: "duplicate-attachment-id-in-plan" });
    seenAsset.add(assetId); seenAttachment.add(attachmentId);
    const extension = String(e.extension || "").replace(/^\./, "").toLowerCase();
    let c = classifyAsset({ name: e.name, extension, sizeBytes: e.sizeBytes }, { migrationMaxBytes: maxBytes });
    if (extension === "jfif") c = { action: e.sizeBytes > MAX_FILE_BYTES ? "store-oversized" : "store", type: "image/jpeg", plannedName: e.name, oversized: e.sizeBytes > MAX_FILE_BYTES };
    if (!c.type || ["quarantine", "hold-too-large"].includes(c.action)) issues.push({ assetId, problem: c.action === "hold-too-large" ? "larger-than-migration-limit" : "unsupported-type" });
    entries.push({
      assetId, sourceItemId: String(e.sourceItemId), attachmentId, recordId: String(e.recordId), columnKey: String(e.columnKey), name: e.name, extension, sizeBytes: e.sizeBytes,
      action: c.action, type: c.type, plannedName: c.plannedName, oversized: Boolean(c.oversized),
      sourceCreatedAt: typeof e.sourceCreatedAt === "string" ? e.sourceCreatedAt.slice(0, 40) : null, sourceUploadedBy: e.sourceUploadedBy == null ? null : String(e.sourceUploadedBy).slice(0, 40),
      linkedCommentIds: Array.isArray(e.linkedCommentIds) ? e.linkedCommentIds.map(String).filter((x) => DIGITS.test(x)).slice(0, 20) : []
    });
  });
  entries.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  const digest = sha256(JSON.stringify({ sourceRunId: raw.sourceRunId, boardId: String(raw.boardId), entries }));
  return { plan: { sourceRunId: raw.sourceRunId, boardId: String(raw.boardId), entries }, digest, runId: `mid-${digest.slice(0, 16)}`, issues };
}

class MidAttachmentRun {
  // drive: the GoogleDriveService; files: the FileService (storage registry and limits); fetch: for monday.com (tests: a mock).
  // perPass: files one worker handles before it re-reads the run (tests use 1 to stop a run part-way).
  constructor({ connection, repos, drive, files, config, maxFileBytes, logger = console, fetch = globalThis.fetch, now = () => new Date(), sleep, faults = null, perPass = PER_PASS, workerId = `mid-${crypto.randomBytes(4).toString("hex")}`, environment = "development" }) {
    if (faults && environment === "production") throw new Error("Fault injection is for tests only.");
    Object.assign(this, { connection, repos, drive, files, config, maxFileBytes, logger, fetchImpl: fetch, now, faults, perPass, workerId, timer: null, ticking: null });
    this.monday = new MondayClient({ token: config.mondayToken, apiVersion: config.apiVersion, fetch, ...(sleep ? { sleep } : {}) });
  }
  get db() { return this.connection.db; }
  col(name) { return this.db.collection(COLLECTIONS[name]); }
  get jobs() { return this.col("integrationJobs"); }

  // ---- Read-only checks
  async check(raw, { checkSources = false } = {}) {
    const { plan, digest, runId, issues } = normalizePlan(raw, { maxBytes: this.maxFileBytes });
    const boardId = new ObjectId(plan.boardId);
    const board = await this.col("boards").findOne({ _id: boardId }, { projection: { workspaceId: 1, archived: 1, columns: 1, legacyId: 1 } });
    if (!board) throw fail(404, "PLAN_BOARD_MISSING", "The plan's board doesn't exist in JARC.");
    const filesKeys = new Set((board.columns || []).filter((c) => c.type === "files").map((c) => c.key));
    const ids = (f) => plan.entries.map(f);
    const mappings = new Map((await this.col("integrationMappings").find({ provider: MAPPING_PROVIDER, kind: "item", sourceId: { $in: ids((e) => e.sourceItemId) } }, { projection: { sourceId: 1, targetId: 1, runId: 1 } }).toArray()).map((m) => [String(m.sourceId), m]));
    const records = new Map((await this.col("records").find({ _id: { $in: ids((e) => new ObjectId(e.recordId)) } }, { projection: { boardId: 1, archived: 1 } }).toArray()).map((r) => [r._id.toHexString(), r]));
    const existing = new Map((await this.col("attachments").find({ $or: [{ _id: { $in: ids((e) => new ObjectId(e.attachmentId)) } }, { "imported.sourceAssetId": { $in: ids((e) => e.assetId) } }] }, { projection: { status: 1, imported: 1, recordId: 1, columnKey: 1 } }).toArray()).flatMap((a) => [[a._id.toHexString(), a], ...(a.imported?.sourceAssetId ? [[`asset:${a.imported.sourceAssetId}`, a]] : [])]));
    const assetMaps = new Map((await this.col("integrationMappings").find({ provider: MAPPING_PROVIDER, kind: "asset", sourceId: { $in: ids((e) => e.assetId) } }, { projection: { sourceId: 1, targetId: 1, runId: 1 } }).toArray()).map((m) => [String(m.sourceId), m]));
    const perCell = new Map();
    for (const a of await this.col("attachments").find({ boardId, status: "ready" }, { projection: { recordId: 1, columnKey: 1 } }).toArray()) { const k = `${a.recordId}|${a.columnKey}`; perCell.set(k, (perCell.get(k) || 0) + 1); }
    const issueByAsset = new Map(); for (const i of issues) (issueByAsset.get(i.assetId) || issueByAsset.set(i.assetId, []).get(i.assetId)).push(i.problem);
    const rows = plan.entries.map((e) => {
      const problems = [...(issueByAsset.get(e.assetId) || [])];
      const m = mappings.get(e.sourceItemId), r = records.get(e.recordId);
      if (!m) problems.push("no-record-mapping");
      else { if (m.targetId.toHexString() !== e.recordId) problems.push("mapping-differs-from-plan"); if (m.runId && m.runId !== plan.sourceRunId) problems.push("mapping-from-another-run"); }
      if (!r) problems.push("record-missing"); else { if (!r.boardId.equals(boardId)) problems.push("record-on-another-board"); if (r.archived) problems.push("record-archived"); }
      if (!filesKeys.has(e.columnKey)) problems.push("files-column-missing");
      const mine = existing.get(e.attachmentId) || existing.get(`asset:${e.assetId}`), map = assetMaps.get(e.assetId);
      let status = problems.length ? "blocked" : "eligible";
      if (mine || map) {
        const done = mine?.status === "ready" && mine.imported?.runId === runId && map && map.targetId.toHexString() === e.attachmentId;
        if (done) status = "already-imported";
        else if (mine?.imported?.runId === runId || map?.runId === runId) status = problems.length ? "blocked" : "resumable";
        else { problems.push("conflicting-attachment-exists"); status = "blocked"; }
      }
      const k = `${e.recordId}|${e.columnKey}`; perCell.set(k, (perCell.get(k) || 0) + (status === "eligible" ? 1 : 0));
      return { assetId: e.assetId, sourceItemId: e.sourceItemId, recordId: e.recordId, attachmentId: e.attachmentId, columnKey: e.columnKey, name: e.name, sizeBytes: e.sizeBytes, type: e.type, action: e.action, status, problems };
    });
    const todo = rows.filter((r) => ["eligible", "resumable"].includes(r.status));
    const summary = {
      runId, planDigest: digest, sourceRunId: plan.sourceRunId, boardId: plan.boardId, boardLegacyId: board.legacyId || null, entries: rows.length,
      eligible: rows.filter((r) => r.status === "eligible").length, resumable: rows.filter((r) => r.status === "resumable").length, alreadyImported: rows.filter((r) => r.status === "already-imported").length, blocked: rows.filter((r) => r.status === "blocked").length,
      problems: rows.flatMap((r) => r.problems).reduce((acc, p) => ((acc[p] = (acc[p] || 0) + 1), acc), {}),
      bytesToImport: todo.reduce((s, r) => s + r.sizeBytes, 0), recordsReceivingFiles: new Set(todo.map((r) => r.recordId)).size,
      byType: todo.reduce((acc, r) => ((acc[r.type] = (acc[r.type] || 0) + 1), acc), {}), over10MB: todo.filter((r) => r.sizeBytes > MAX_FILE_BYTES).length,
      cellsOver20Files: [...perCell.values()].filter((n) => n > 20).length,
      capacity: await this.capacity(todo.reduce((s, r) => s + r.sizeBytes, 0)).catch((error) => ({ error: error.code || "UNAVAILABLE" })),
      ...(checkSources ? { sources: await this.checkSources(todo) } : {})
    };
    return { summary, rows, plan, board };
  }

  // Free space in the Google account and under JARC's own Drive limit, against what's still to be imported. Reads only.
  async capacity(neededBytes) {
    const quota = await this.drive.store.quota();
    const usage = await this.col("storageUsage").findOne({ _id: "gdrive" });
    const jarcUsed = usage ? Number(usage.usedBytes || 0) + Number(usage.reservedBytes || 0) : Object.values(await this.repos.storageUsage.count("gdrive")).reduce((a, b) => a + b, 0);
    const jarcLimit = this.files.limitOf("gdrive");
    const margin = Math.max(256 * 1024 * 1024, Math.ceil(neededBytes * 0.05));
    const driveFree = quota.limitBytes === null ? null : quota.limitBytes - quota.usageBytes;
    const problems = [...(driveFree !== null && driveFree < neededBytes + margin ? ["google-drive-too-full"] : []), ...(jarcLimit - jarcUsed < neededBytes ? ["jarc-drive-limit-too-low"] : [])];
    return { neededBytes, marginBytes: margin, drive: { limitBytes: quota.limitBytes, usageBytes: quota.usageBytes, freeBytes: driveFree }, jarc: { limitBytes: jarcLimit, usedBytes: jarcUsed, freeBytes: jarcLimit - jarcUsed }, enough: problems.length === 0, problems };
  }

  // Does monday.com still have every file, with the inventoried size? Metadata only; no file is downloaded.
  async checkSources(rows) {
    const found = new Map();
    for (let i = 0; i < rows.length; i += 100) {
      const data = await this.monday.query("query ($ids: [ID!]!) { assets(ids: $ids) { id file_size } }", { ids: rows.slice(i, i + 100).map((r) => r.assetId) });
      for (const a of data.assets || []) if (a) found.set(String(a.id), Number(a.file_size));
    }
    const missing = rows.filter((r) => !found.has(r.assetId)).map((r) => r.assetId), changed = rows.filter((r) => found.has(r.assetId) && found.get(r.assetId) !== r.sizeBytes).map((r) => r.assetId);
    return { checked: rows.length, available: rows.length - missing.length, missing: missing.length, sizeChanged: changed.length, missingAssetIds: missing.slice(0, 50), sizeChangedAssetIds: changed.slice(0, 50) };
  }

  // ---- Writes, each started explicitly by an administrator
  async prepare(raw, actor) {
    const { summary, plan, board } = await this.check(raw);
    if (summary.blocked) throw fail(409, "PLAN_HAS_BLOCKED_FILES", `${summary.blocked} file(s) can't be imported. Fix the plan first (see the dry run).`, { problems: summary.problems });
    const now = this.now(), runId = summary.runId;
    const run = await this.jobs.findOne({ _id: runId });
    if (!run) {
      await this.jobs.insertOne({ _id: runId, provider: PROVIDER, type: RUN_TYPE, status: "prepared", planDigest: summary.planDigest, sourceRunId: plan.sourceRunId, boardId: board._id, workspaceId: board.workspaceId, totals: { files: plan.entries.length, bytes: plan.entries.reduce((s, e) => s + e.sizeBytes, 0) }, remaining: 0, mode: null, backups: [], createdBy: actor.userId, createdByName: actor.displayName || null, createdAt: now, updatedAt: now, runAfter: now });
    } else if (run.planDigest !== summary.planDigest) throw fail(409, "RUN_CONFLICT", "A different plan already uses this run ID.");
    // Only the items not there yet: preparing twice (or after an interruption) never duplicates or resets one.
    const items = plan.entries.map((e) => ({ _id: `${runId}:${e.assetId}`, provider: PROVIDER, type: ITEM_TYPE, runId, status: "queued", attempts: 0, runAfter: now, createdAt: now, params: e }));
    for (let i = 0; i < items.length; i += 500) {
      const batch = items.slice(i, i + 500);
      const have = new Set((await this.jobs.find({ _id: { $in: batch.map((x) => x._id) } }, { projection: { _id: 1 } }).toArray()).map((x) => x._id));
      const missing = batch.filter((x) => !have.has(x._id));
      if (missing.length) await this.jobs.insertMany(missing, { ordered: true });
    }
    this.logger.log?.(`[mid-attachments] ${runId} prepared: ${items.length} files`);
    return this.status(runId);
  }

  async start(runId, { mode, count, backup, confirm }) {
    if (confirm !== true) throw fail(400, "CONFIRMATION_REQUIRED", "Confirm starting the import.");
    if (!["pilot", "full"].includes(mode)) throw fail(400, "VALIDATION_ERROR", "mode must be pilot or full.");
    const run = await this.run(runId);
    if (!["prepared", "paused", "stopped"].includes(run.status)) throw fail(409, "RUN_NOT_STARTABLE", `The run is ${run.status}.`);
    const reference = typeof backup?.reference === "string" ? backup.reference.trim() : "", takenAt = new Date(backup?.takenAt);
    const now = this.now();
    if (!reference || reference.length > 200) throw fail(400, "BACKUP_REQUIRED", "Record the backup of jarc_database (its reference) before importing.");
    if (Number.isNaN(takenAt.getTime()) || takenAt > now || now - takenAt > BACKUP_MAX_AGE_MS) throw fail(400, "BACKUP_TOO_OLD", "The backup must have been taken within the last 24 hours.");
    if (backup.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(String(backup.sha256))) throw fail(400, "VALIDATION_ERROR", "backup.sha256 must be 64 hexadecimal characters.");
    const pending = await this.jobs.countDocuments({ type: ITEM_TYPE, runId, status: { $in: ["queued", "retry", "running"] } });
    if (!pending) throw fail(409, "NOTHING_TO_IMPORT", "Every file of this run has been handled.");
    let allowance = pending;
    if (mode === "pilot") {
      allowance = count === undefined ? PILOT_MAX : Number(count);
      if (!Number.isInteger(allowance) || allowance < 1 || allowance > PILOT_MAX) throw fail(400, "VALIDATION_ERROR", `A pilot imports 1 to ${PILOT_MAX} files.`);
    }
    const queuedBytes = (await this.jobs.find({ type: ITEM_TYPE, runId, status: { $in: ["queued", "retry", "running"] } }, { projection: { "params.sizeBytes": 1 } }).toArray()).map((i) => i.params.sizeBytes).sort((a, b) => b - a).slice(0, allowance).reduce((s, n) => s + n, 0);
    const capacity = await this.capacity(queuedBytes);
    if (!capacity.enough) throw fail(409, "NOT_ENOUGH_STORAGE", "There isn't enough storage for this import.", { capacity });
    const set = { status: "running", mode, remaining: allowance, startedAt: now, updatedAt: now, pausedReason: null, lastError: null, capacityAtStart: capacity };
    const r = await this.jobs.updateOne({ _id: runId, status: run.status }, { $set: set, $push: { backups: { reference, takenAt, sha256: backup.sha256 || null, recordedAt: now, mode } } });
    if (r.matchedCount !== 1) throw fail(409, "RUN_CHANGED", "The run changed in the meantime. Reload and try again.");
    this.logger.log?.(`[mid-attachments] ${runId} started (${mode}, up to ${allowance} files)`);
    this.kick();
    return this.status(runId);
  }
  async pause(runId) { return this.transition(runId, ["running"], { status: "paused", pausedReason: "paused-by-administrator" }); }
  async resume(runId) {
    const run = await this.run(runId);
    if (run.status !== "paused" || !(run.remaining > 0)) throw fail(409, "RUN_NOT_RESUMABLE", run.status === "paused" ? "Nothing is left in this pilot or run: start it again." : `The run is ${run.status}.`);
    const out = await this.transition(runId, ["paused"], { status: "running", pausedReason: null });
    this.kick();
    return out;
  }
  async stop(runId) { return this.transition(runId, ["running", "paused"], { status: "stopped", remaining: 0, pausedReason: "stopped-by-administrator" }); }
  async transition(runId, from, set) {
    const r = await this.jobs.updateOne({ _id: runId, type: RUN_TYPE, status: { $in: from } }, { $set: { ...set, updatedAt: this.now() } });
    if (r.matchedCount !== 1) { const run = await this.run(runId); throw fail(409, "RUN_STATE", `The run is ${run.status}.`); }
    return this.status(runId);
  }
  async rollback(runId, { confirm }) {
    if (confirm !== `ROLLBACK ${runId}`) throw fail(400, "CONFIRMATION_REQUIRED", `Type "ROLLBACK ${runId}" to confirm.`);
    const out = await this.transition(runId, ["prepared", "paused", "stopped", "completed"], { status: "rolling-back", remaining: 0 });
    this.logger.log?.(`[mid-attachments] ${runId} rollback started`);
    this.kick();
    return out;
  }

  // ---- Reading
  async run(runId) {
    if (typeof runId !== "string" || !/^mid-[0-9a-f]{16}$/.test(runId)) throw fail(404, "NOT_FOUND", "No such import run.");
    const run = await this.jobs.findOne({ _id: runId, type: RUN_TYPE });
    if (!run) throw fail(404, "NOT_FOUND", "No such import run.");
    return run;
  }
  async status(runId) {
    const run = await this.run(runId);
    const counts = {};
    for (const i of await this.jobs.find({ type: ITEM_TYPE, runId }, { projection: { status: 1, "params.sizeBytes": 1 } }).toArray()) { const c = (counts[i.status] ||= { files: 0, bytes: 0 }); c.files += 1; c.bytes += i.params?.sizeBytes || 0; }
    const failures = (await this.jobs.find({ type: ITEM_TYPE, runId, status: { $in: ["failed", "retry"] } }, { sort: { updatedAt: -1 }, limit: 50, projection: { status: 1, attempts: 1, error: 1, updatedAt: 1, "params.assetId": 1, "params.attachmentId": 1, "params.recordId": 1, "params.name": 1 } }).toArray())
      .map((i) => ({ assetId: i.params.assetId, attachmentId: i.params.attachmentId, recordId: i.params.recordId, name: i.params.name, status: i.status, attempts: i.attempts, error: i.error || null, at: i.updatedAt || null }));
    return { runId, status: run.status, mode: run.mode, remaining: run.remaining, pausedReason: run.pausedReason || null, lastError: run.lastError || null, sourceRunId: run.sourceRunId, boardId: String(run.boardId), totals: run.totals, counts, createdAt: run.createdAt, createdByName: run.createdByName, startedAt: run.startedAt || null, finishedAt: run.finishedAt || null, rolledBackAt: run.rolledBackAt || null, backups: (run.backups || []).map(({ reference, takenAt, sha256: s, recordedAt, mode }) => ({ reference, takenAt, sha256: s, recordedAt, mode })), failures };
  }
  async list() { return Promise.all((await this.jobs.find({ type: RUN_TYPE }, { sort: { createdAt: -1 }, limit: 10, projection: { _id: 1 } }).toArray()).map((r) => this.status(r._id))); }

  // Reconciliation, read-only: every done item has a ready attachment on the planned record and column with its mapping,
  // and a Drive file of this run with the same size and SHA-256. sample: also download this many files and re-hash them.
  async verify(runId, { sample = 0 } = {}) {
    const run = await this.run(runId);
    const items = await this.jobs.find({ type: ITEM_TYPE, runId }, { projection: { status: 1, params: 1, result: 1 } }).toArray();
    const docs = new Map((await this.col("attachments").find({ "imported.runId": runId }, { projection: { status: 1, recordId: 1, columnKey: 1, size: 1, sha256: 1, storage: 1, imported: 1, name: 1, type: 1 } }).toArray()).map((d) => [d._id.toHexString(), d]));
    const maps = new Map((await this.col("integrationMappings").find({ provider: MAPPING_PROVIDER, kind: "asset", runId }, { projection: { sourceId: 1, targetId: 1 } }).toArray()).map((m) => [String(m.sourceId), m.targetId.toHexString()]));
    const driveFiles = new Map((await this.drive.store.runFiles(runId)).map((f) => [f.id, f]));
    const problems = [];
    for (const i of items.filter((x) => x.status === "done")) {
      const d = docs.get(i.params.attachmentId), p = (problem) => problems.push({ assetId: i.params.assetId, attachmentId: i.params.attachmentId, problem });
      if (!d || d.status !== "ready") { p("attachment-missing-or-not-ready"); continue; }
      if (d.recordId.toHexString() !== i.params.recordId || d.columnKey !== i.params.columnKey) p("wrong-record-or-column");
      if (maps.get(i.params.assetId) !== i.params.attachmentId) p("asset-mapping-missing");
      if (i.result?.sha256 && d.sha256 !== i.result.sha256) p("checksum-differs-from-run-log");
      const f = driveFiles.get(d.storage?.key);
      if (!f) p("drive-file-missing"); else { if (f.size !== d.size) p("drive-size-differs"); if (f.sha256 && f.sha256 !== d.sha256) p("drive-checksum-differs"); }
    }
    const ownedKeys = new Set([...docs.values()].map((d) => d.storage?.key));
    const strayDriveFiles = [...driveFiles.values()].filter((f) => f.kind === "mig" && !ownedKeys.has(f.id)).length;
    const samples = [];
    for (const d of [...docs.values()].filter((x) => x.status === "ready").slice(0, Math.max(0, Math.min(Number(sample) || 0, 50)))) {
      const h = crypto.createHash("sha256"); let size = 0;
      try { for await (const chunk of this.files.openDownload(d)) { h.update(chunk); size += chunk.length; } samples.push({ attachmentId: d._id.toHexString(), ok: size === d.size && h.digest("hex") === d.sha256 }); }
      catch (error) { samples.push({ attachmentId: d._id.toHexString(), ok: false, error: error.code || "DOWNLOAD_FAILED" }); }
    }
    return {
      runId, status: run.status, items: items.reduce((acc, i) => ((acc[i.status] = (acc[i.status] || 0) + 1), acc), {}), attachments: docs.size, readyAttachments: [...docs.values()].filter((d) => d.status === "ready").length,
      assetMappings: maps.size, driveFiles: [...driveFiles.values()].filter((f) => f.kind === "mig").length, strayDriveFiles, problems: problems.slice(0, 200), problemCount: problems.length, samples, ok: problems.length === 0 && strayDriveFiles === 0 && samples.every((s) => s.ok)
    };
  }

  // ---- The worker
  startWorker({ intervalMs = 5000 } = {}) { if (this.timer) return; this.timer = setInterval(() => { this.tick().catch((e) => this.logger.error(`[mid-attachments] pass failed: ${e?.code || e?.name || "Error"}`)); }, intervalMs); this.timer.unref?.(); }
  stopWorker() { clearInterval(this.timer); this.timer = null; }
  kick() { if (this.timer) setImmediate(() => this.tick().catch(() => {})); }
  async tick() {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      for (const run of await this.jobs.find({ type: RUN_TYPE, status: { $in: ["running", "rolling-back"] } }).toArray()) {
        if (run.status === "rolling-back") await this.rollbackPass(run); else await this.workPass(run);
      }
    })().finally(() => { this.ticking = null; });
    return this.ticking;
  }
  async workPass(run) {
    await Promise.all(Array.from({ length: this.config.concurrency }, () => this.worker(run._id)));
    await this.settle(run._id);
  }
  async worker(runId) {
    for (let n = 0; n < this.perPass; n += 1) {
      const fresh = await this.jobs.findOne({ _id: runId }, { projection: { status: 1 } });
      if (fresh?.status !== "running") return;
      const item = await this.claim(runId);
      if (!item) return;
      await this.process(runId, item);
    }
  }
  // A retry that is due, or one whose worker died (expired lease), first; otherwise a new file, which uses up one place of
  // the pilot or run allowance (so a pilot is exactly its number of files, however many retries they need).
  async claim(runId) {
    const now = this.now(), lease = { $set: { status: "running", lockedBy: this.workerId, lockedUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now }, $inc: { attempts: 1 } };
    const again = await this.jobs.findOneAndUpdate({ type: ITEM_TYPE, runId, $or: [{ status: "retry", runAfter: { $lte: now } }, { status: "running", lockedUntil: { $lt: now } }] }, lease, { returnDocument: "after", sort: { runAfter: 1 } });
    if (again) return again;
    const place = await this.jobs.findOneAndUpdate({ _id: runId, status: "running", remaining: { $gt: 0 } }, { $inc: { remaining: -1 } }, { returnDocument: "after" });
    if (!place) return null;
    const item = await this.jobs.findOneAndUpdate({ type: ITEM_TYPE, runId, status: "queued" }, lease, { returnDocument: "after", sort: { "params.assetId": 1 } });
    if (!item) await this.jobs.updateOne({ _id: runId }, { $inc: { remaining: 1 } });
    return item;
  }
  async process(runId, item) {
    const run = await this.jobs.findOne({ _id: runId });
    const p = item.params, started = this.now();
    try {
      const result = await this.importItem(run, p);
      await this.finish(item, { status: "done", result: { status: result.status, sha256: result.sha256 || null, size: p.sizeBytes, attachmentId: p.attachmentId, at: this.now(), ms: this.now() - started } });
      this.logger.log?.(`[mid-attachments] ${runId} asset ${p.assetId} → attachment ${p.attachmentId}: ${result.status}`);
    } catch (error) {
      if (error?.simulatedCrash) throw error; // tests: leave the item exactly as a real crash would
      const code = String(error?.causeCode && error.code === "MIGRATION_ATTACHMENT_FAILED" ? error.causeCode : error?.code || error?.name || "ERROR").slice(0, 60);
      const info = { code, message: String(error?.message || "").replace(/https?:\/\/\S+/g, "<url>").slice(0, 300), at: this.now() };
      if (PAUSING.has(code)) {
        // Back in line, and its place in the allowance given back (taking it from the line again uses one).
        await this.finish(item, { status: "queued", attempts: Math.max(0, item.attempts - 1), error: info });
        await this.jobs.updateOne({ _id: runId }, { $inc: { remaining: 1 } });
        await this.jobs.updateOne({ _id: runId, status: "running" }, { $set: { status: "paused", pausedReason: code, lastError: info, updatedAt: this.now() } });
        this.logger.error(`[mid-attachments] ${runId} paused: ${code}`);
      } else if (PERMANENT.has(code) || item.attempts >= MAX_ATTEMPTS || error?.retry === false) {
        await this.finish(item, { status: "failed", error: info });
        this.logger.error(`[mid-attachments] ${runId} asset ${p.assetId} failed: ${code}`);
      } else {
        const delay = Math.min(15 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, item.attempts - 1));
        await this.finish(item, { status: "retry", runAfter: new Date(this.now().getTime() + delay), error: info });
        this.logger.error(`[mid-attachments] ${runId} asset ${p.assetId} will retry: ${code}`);
      }
    }
  }
  async finish(item, set) {
    const { attempts, ...rest } = set;
    await this.jobs.updateOne({ _id: item._id, lockedBy: this.workerId }, { $set: { ...rest, ...(attempts !== undefined ? { attempts } : {}), lockedBy: null, lockedUntil: null, updatedAt: this.now() } });
  }
  // The run is done when nothing is waiting; a pilot (or a stopped allowance) ends paused.
  async settle(runId) {
    const run = await this.jobs.findOne({ _id: runId });
    if (run?.status !== "running") return;
    const open = await this.jobs.countDocuments({ type: ITEM_TYPE, runId, status: { $in: ["queued", "retry", "running"] } });
    if (!open) { await this.jobs.updateOne({ _id: runId, status: "running" }, { $set: { status: "completed", remaining: 0, finishedAt: this.now(), updatedAt: this.now() } }); this.logger.log?.(`[mid-attachments] ${runId} completed`); return; }
    const busy = await this.jobs.countDocuments({ type: ITEM_TYPE, runId, status: { $in: ["retry", "running"] } });
    if (run.remaining <= 0 && !busy) { await this.jobs.updateOne({ _id: runId, status: "running" }, { $set: { status: "paused", pausedReason: run.mode === "pilot" ? "pilot-finished" : "allowance-used", updatedAt: this.now() } }); this.logger.log?.(`[mid-attachments] ${runId} paused: ${run.mode === "pilot" ? "pilot finished" : "allowance used"}`); }
  }

  // One file: checks that need no download, then the bytes, then the migration's own writer.
  async importItem(run, p) {
    const attachmentId = new ObjectId(p.attachmentId), recordId = new ObjectId(p.recordId);
    const done = await this.col("attachments").findOne({ _id: attachmentId, status: "ready", "imported.runId": run._id });
    const map = done && await this.col("integrationMappings").findOne({ provider: MAPPING_PROVIDER, kind: "asset", sourceId: p.assetId });
    if (done && map?.targetId.equals(attachmentId)) return { status: "already", sha256: done.sha256 };
    const record = await this.col("records").findOne({ _id: recordId, boardId: run.boardId, workspaceId: run.workspaceId }, { projection: { _id: 1 } });
    if (!record) throw Object.assign(new Error("The record no longer exists on the board."), { code: "MIGRATION_ATTACHMENT_RECORD_MISSING" });
    const board = await this.col("boards").findOne({ _id: run.boardId }, { projection: { columns: 1 } });
    if (!board?.columns.some((c) => c.key === p.columnKey && c.type === "files")) throw Object.assign(new Error("The Files column no longer exists."), { code: "MIGRATION_ATTACHMENT_COLUMN_MISSING" });
    const bytes = await this.download(p);
    const hash = sha256(bytes);
    const writer = new AttachmentWriter({ client: this.connection.client, db: this.db, runId: run._id, storage: this.files.storage, provider: "gdrive", maxBytes: this.maxFileBytes, limitBytes: this.files.limitOf("gdrive"), workspaceId: run.workspaceId, now: this.now, faults: this.faults, types: TYPES });
    const entry = { _id: attachmentId, sourceAssetId: p.assetId, recordId, boardId: run.boardId, columnKey: p.columnKey, action: p.action, plannedType: p.type, plannedName: p.plannedName, originalName: p.name, sizeBytes: p.sizeBytes, oversized: p.oversized, linkedCommentIds: p.linkedCommentIds || [], sourceUploadedBy: p.sourceUploadedBy, sourceCreatedAt: p.sourceCreatedAt };
    const r = await writer.importOne(entry, { sha256: hash, size: bytes.length, open: () => Readable.from([bytes]) });
    return { ...r, sha256: hash };
  }
  // A fresh download URL for each attempt (monday.com's expire), the bytes read to exactly the inventoried size.
  async download(p) {
    let data;
    try { data = await this.monday.query("query ($ids: [ID!]!) { assets(ids: $ids) { id file_size public_url } }", { ids: [p.assetId] }); }
    catch (error) { throw sourceError(`MONDAY_${error.code || "ERROR"}`, "monday.com didn't answer.", error.code !== "UNAUTHORIZED"); }
    const asset = (data.assets || []).find((a) => a && String(a.id) === p.assetId);
    if (!asset) throw sourceError("MIGRATION_SOURCE_MISSING", "monday.com no longer has this file.");
    if (Number(asset.file_size) !== p.sizeBytes) throw sourceError("MIGRATION_SOURCE_CHANGED", "The file on monday.com has a different size than the inventory.");
    const url = String(asset.public_url || "");
    if (!url.startsWith("https://")) throw sourceError("MIGRATION_SOURCE_UNAVAILABLE", "monday.com didn't provide a download link.", true);
    let res;
    try { res = await this.fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(120000) }); }
    catch { throw sourceError("MIGRATION_SOURCE_UNAVAILABLE", "The download from monday.com didn't complete.", true); }
    if (!res.ok || !res.body) { await res.arrayBuffer?.().catch(() => {}); throw sourceError("MIGRATION_SOURCE_UNAVAILABLE", `monday.com answered ${res.status}.`, true); }
    if (res.url && !String(res.url).startsWith("https://")) throw sourceError("MIGRATION_SOURCE_UNAVAILABLE", "The download was redirected away from https.", true);
    const chunks = []; let size = 0;
    try {
      for await (const chunk of res.body) { size += chunk.length; if (size > p.sizeBytes) throw sourceError("MIGRATION_SOURCE_CHANGED", "The download is larger than the inventoried size."); chunks.push(Buffer.from(chunk)); }
    } catch (error) { if (error.code) throw error; throw sourceError("MIGRATION_SOURCE_UNAVAILABLE", "The download from monday.com was cut off.", true); }
    if (size !== p.sizeBytes) throw sourceError("MIGRATION_SOURCE_INCOMPLETE", "The download is smaller than the inventoried size.", true);
    return Buffer.concat(chunks, size);
  }

  // ---- Rollback, a batch per pass: only documents and files of this run.
  async rollbackPass(run) {
    const runId = run._id;
    const batch = await this.col("attachments").find({ "imported.runId": runId }, { limit: 50 }).toArray();
    for (const doc of batch) {
      try { await this.files.storage.forAttachment(doc).delete(this.files.storage.keyOf(doc)); }
      catch (error) { this.logger.error(`[mid-attachments] ${runId} rollback: file of ${doc._id.toHexString()} not moved to Trash yet: ${error.code || error.name}`); return; }
      await this.col("integrationMappings").deleteOne({ provider: MAPPING_PROVIDER, kind: "asset", sourceId: doc.imported.sourceAssetId, runId });
      const removed = await this.col("attachments").deleteOne({ _id: doc._id, "imported.runId": runId });
      if (removed.deletedCount === 1 && ["ready", "pending"].includes(doc.status)) await this.col("storageUsage").updateOne({ _id: "gdrive" }, { $inc: doc.status === "ready" ? { usedBytes: -doc.size } : { reservedBytes: -doc.size } });
    }
    if (batch.length) return;
    // Files of this run that have no document any more (a crash between storing and recording).
    for (const f of (await this.drive.store.runFiles(runId)).filter((x) => x.kind === "mig")) await this.drive.store.delete(f.id);
    await this.col("integrationMappings").deleteMany({ provider: MAPPING_PROVIDER, kind: "asset", runId });
    await this.jobs.updateMany({ type: ITEM_TYPE, runId }, { $set: { status: "rolled-back", lockedBy: null, lockedUntil: null, updatedAt: this.now() } });
    await this.jobs.updateOne({ _id: runId, status: "rolling-back" }, { $set: { status: "rolled-back", rolledBackAt: this.now(), updatedAt: this.now() } });
    this.logger.log?.(`[mid-attachments] ${runId} rolled back`);
  }
}

module.exports = { MidAttachmentRun, normalizePlan, PROVIDER, RUN_TYPE, ITEM_TYPE, PLAN_KIND, PILOT_MAX, MAX_ATTEMPTS, TYPES };
