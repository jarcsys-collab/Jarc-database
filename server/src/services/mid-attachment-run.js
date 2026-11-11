// Machine Installation Database attachment import (monday.com board → JARC records, files into Google Drive). It runs
// INSIDE the JARC server because only the server holds the Google Drive connection. Off unless MID_ATTACHMENTS_MIGRATION
// is true; only Google Drive administrators can use it (routes/mid-attachments.js). It loads none of the migration tool's
// production policy: the file writer (files/migration-writer.js) is shared, the tool's approval gates are not.
//
//   plan      uploaded by an administrator from the Git-ignored local inventory (scripts/mid-attachments-plan.js): one
//             entry per file with the monday.com asset and item IDs and the planned JARC attachment and record IDs.
//             Nothing about the plan is stored in the repository. Its SHA-256 identifies the run (runId mid-<16 hex>).
//   dry run   READ-ONLY, in the background: the plan against production (record exists on the board, the item mapping
//             points at it, the Files column exists, nothing conflicting already exists), Drive and JARC capacity, and
//             optionally whether monday.com still serves every file with the expected size (about 80 s for 6,031 files).
//             The request returns a check ID at once; the page polls its progress. Results are kept in server memory only
//             (2 hours, one check at a time) and nothing is written anywhere.
//   prepare   from a completed check (less than an hour old, nothing blocked), in the background: the run (status
//             "preparing", then "prepared") and one item per file in integrationJobs. Deterministic _ids, so repeating it,
//             or resuming after a restart, adds nothing.
//   start     the 20-file pilot first (mandatory), then the full run, each with an explicit confirmation and enough
//             capacity. Before each start a read-only verification of the board's records, item mappings, attachments
//             and storage is recorded on the run as a snapshot; verify compares against it. pause / resume / stop at any
//             time; files already started finish.
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
const { MIGRATION_TYPES, MAX_FILE_BYTES, classifyAsset, detectContentType, correctedName } = require("../files/file-types");
const { MondayClient } = require("../integrations/monday/client");
const { AttachmentWriter, MAPPING_PROVIDER } = require("../files/migration-writer");
const { monitor } = require("../monitoring/monitor");

const PROVIDER = "mid-attachments";
const RUN_TYPE = "mid-attachments-run", ITEM_TYPE = "mid-attachment";
const PLAN_KIND = "jarc-mid-attachments-plan";
const PILOT_MAX = 20, MAX_ATTEMPTS = 5, MAX_ENTRIES = 20000;
const LEASE_MS = 10 * 60 * 1000;
const CHECK_KEEP_MS = 2 * 60 * 60 * 1000, CHECK_FRESH_MS = 60 * 60 * 1000, PROBLEM_ROWS_SHOWN = 500;
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
    // checks: background dry runs (server memory only). preparing: runs whose item list is being written by this process.
    Object.assign(this, { connection, repos, drive, files, config, maxFileBytes, logger, fetchImpl: fetch, now, faults, perPass, workerId, timer: null, ticking: null, checks: new Map(), preparing: new Map() });
    this.monday = new MondayClient({ token: config.mondayToken, apiVersion: config.apiVersion, fetch, ...(sleep ? { sleep } : {}) });
  }
  get db() { return this.connection.db; }
  col(name) { return this.db.collection(COLLECTIONS[name]); }
  get jobs() { return this.col("integrationJobs"); }

  // ---- Background dry runs (read-only; results in server memory only)
  // Validates the plan's shape at once, then checks it in the background. One check at a time: asking again for the same
  // plan and option while it runs returns that check; a different one is refused until it finishes.
  startCheck(raw, { checkSources = false } = {}, actor = null) {
    const { digest, runId } = normalizePlan(raw, { maxBytes: this.maxFileBytes });
    this.pruneChecks();
    const running = [...this.checks.values()].find((c) => c.status === "running");
    if (running) {
      if (running.planDigest === digest && running.checkSources === checkSources) return this.checkView(running);
      throw fail(409, "CHECK_IN_PROGRESS", "Another dry run is still running. Wait for it to finish.");
    }
    const c = { checkId: `chk-${crypto.randomBytes(8).toString("hex")}`, planDigest: digest, runId, checkSources, status: "running", stage: "starting", progress: null, startedAt: this.now(), finishedAt: null, startedByName: actor?.displayName || null, result: null, error: null, plan: raw };
    this.checks.set(c.checkId, c);
    c.done = (async () => {
      try {
        const r = await this.check(raw, { checkSources, onProgress: (stage, done = null, total = null) => { c.stage = stage; c.progress = total ? { done, total } : null; } });
        c.result = { summary: r.summary, problemRows: r.rows.filter((x) => x.problems.length).slice(0, PROBLEM_ROWS_SHOWN), rowsTotal: r.rows.length };
        c.status = "completed"; c.stage = "done";
      } catch (error) {
        c.status = "failed"; c.stage = "failed"; c.plan = null;
        const code = error?.name === "MondayApiError" ? `MONDAY_${error.code || "ERROR"}` : error?.code || error?.name || "ERROR";
        c.error = { code: String(code).slice(0, 60), message: String(error?.message || "").replace(/https?:\/\/\S+/g, "<url>").slice(0, 300) };
        this.logger.error(`[mid-attachments] dry run failed: ${c.error.code}`);
      } finally { c.finishedAt = this.now(); }
    })();
    return this.checkView(c);
  }
  getCheck(checkId) {
    this.pruneChecks();
    const c = typeof checkId === "string" ? this.checks.get(checkId) : null;
    if (!c) throw fail(404, "CHECK_NOT_FOUND", "This dry run isn't available any more (finished more than 2 hours ago, or the server restarted). Run it again.");
    return this.checkView(c);
  }
  checkView(c) { const { checkId, planDigest, runId, checkSources, status, stage, progress, startedAt, finishedAt, startedByName, result, error } = c; return { checkId, planDigest, runId, checkSources, status, stage, progress, startedAt, finishedAt, startedByName, result, error }; }
  pruneChecks() { const now = this.now().getTime(); for (const [id, c] of this.checks) if (c.finishedAt && now - c.finishedAt.getTime() > CHECK_KEEP_MS) this.checks.delete(id); }

  // ---- Read-only checks
  // onProgress(stage, done?, total?): "database", "capacity", "monday.com" (batches of 100).
  async check(raw, { checkSources = false, onProgress = () => {} } = {}) {
    const { plan, digest, runId, issues } = normalizePlan(raw, { maxBytes: this.maxFileBytes });
    onProgress("database");
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
    onProgress("capacity");
    const capacity = await this.capacity(todo.reduce((s, r) => s + r.sizeBytes, 0)).catch((error) => ({ error: error.code || "UNAVAILABLE" }));
    const sources = checkSources ? await this.checkSources(todo, (done, total) => onProgress("monday.com", done, total)) : null;
    const summary = {
      runId, planDigest: digest, sourceRunId: plan.sourceRunId, boardId: plan.boardId, boardLegacyId: board.legacyId || null, entries: rows.length,
      eligible: rows.filter((r) => r.status === "eligible").length, resumable: rows.filter((r) => r.status === "resumable").length, alreadyImported: rows.filter((r) => r.status === "already-imported").length, blocked: rows.filter((r) => r.status === "blocked").length,
      problems: rows.flatMap((r) => r.problems).reduce((acc, p) => ((acc[p] = (acc[p] || 0) + 1), acc), {}),
      bytesToImport: todo.reduce((s, r) => s + r.sizeBytes, 0), recordsReceivingFiles: new Set(todo.map((r) => r.recordId)).size,
      byType: todo.reduce((acc, r) => ((acc[r.type] = (acc[r.type] || 0) + 1), acc), {}), over10MB: todo.filter((r) => r.sizeBytes > MAX_FILE_BYTES).length,
      cellsOver20Files: [...perCell.values()].filter((n) => n > 20).length,
      capacity, ...(sources ? { sources } : {})
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
  async checkSources(rows, onBatch = () => {}) {
    const found = new Map(), batches = Math.ceil(rows.length / 100);
    for (let i = 0; i < rows.length; i += 100) {
      onBatch(i / 100, batches);
      const data = await this.monday.query("query ($ids: [ID!]!) { assets(ids: $ids) { id file_size } }", { ids: rows.slice(i, i + 100).map((r) => r.assetId) });
      for (const a of data.assets || []) if (a) found.set(String(a.id), Number(a.file_size));
    }
    onBatch(batches, batches);
    const missing = rows.filter((r) => !found.has(r.assetId)).map((r) => r.assetId), changed = rows.filter((r) => found.has(r.assetId) && found.get(r.assetId) !== r.sizeBytes).map((r) => r.assetId);
    return { checked: rows.length, available: rows.length - missing.length, missing: missing.length, sizeChanged: changed.length, missingAssetIds: missing.slice(0, 50), sizeChangedAssetIds: changed.slice(0, 50) };
  }

  // ---- Writes, each started explicitly by an administrator
  // Prepare from a completed dry run (no second upload of the plan): the run is created as "preparing" at once, and its
  // item list is written in the background, re-checked against production first. Repeating it, or resuming after a restart
  // (a run left "preparing"), adds only what is missing; an existing prepared run is kept as it is.
  async prepareFromCheck(checkId, actor) {
    this.pruneChecks();
    const c = typeof checkId === "string" ? this.checks.get(checkId) : null;
    if (!c) throw fail(404, "CHECK_NOT_FOUND", "This dry run isn't available any more. Run it again.");
    if (c.status !== "completed") throw fail(409, "CHECK_NOT_COMPLETED", c.status === "running" ? "Wait for the dry run to finish." : "The dry run didn't complete. Run it again.");
    if (this.now() - c.finishedAt > CHECK_FRESH_MS) throw fail(409, "CHECK_TOO_OLD", "This dry run is more than an hour old. Run it again.");
    const s = c.result.summary;
    if (s.blocked) throw fail(409, "PLAN_HAS_BLOCKED_FILES", `${s.blocked} file(s) can't be imported. Fix the plan first (see the dry run).`, { problems: s.problems });
    const runId = s.runId, existing = await this.jobs.findOne({ _id: runId });
    if (existing && existing.planDigest !== s.planDigest) throw fail(409, "RUN_CONFLICT", "A different plan already uses this run ID.");
    if (existing && !["prepared", "preparing"].includes(existing.status)) throw fail(409, "RUN_NOT_PREPARABLE", `The run is ${existing.status}; it is already prepared.`);
    if (this.preparing.has(runId)) return this.status(runId);
    const now = this.now();
    if (!existing) {
      const { plan } = normalizePlan(c.plan, { maxBytes: this.maxFileBytes });
      const board = await this.col("boards").findOne({ _id: new ObjectId(plan.boardId) }, { projection: { workspaceId: 1 } });
      if (!board) throw fail(404, "PLAN_BOARD_MISSING", "The plan's board doesn't exist in JARC.");
      try { await this.jobs.insertOne({ _id: runId, provider: PROVIDER, type: RUN_TYPE, status: "preparing", planDigest: s.planDigest, sourceRunId: plan.sourceRunId, boardId: board._id, workspaceId: board.workspaceId, totals: { files: plan.entries.length, bytes: plan.entries.reduce((n, e) => n + e.sizeBytes, 0) }, remaining: 0, mode: null, snapshots: [], createdBy: actor.userId, createdByName: actor.displayName || null, createdAt: now, updatedAt: now, runAfter: now }); }
      catch (error) { if (error?.code !== 11000) throw error; }
    } else await this.jobs.updateOne({ _id: runId, status: { $in: ["prepared", "preparing"] } }, { $set: { status: "preparing", lastError: null, updatedAt: now } });
    const raw = c.plan;
    this.preparing.set(runId, (async () => {
      try {
        const { summary, plan } = await this.check(raw);
        if (summary.blocked) throw Object.assign(new Error(`${summary.blocked} file(s) became impossible to import since the dry run.`), { code: "PLAN_HAS_BLOCKED_FILES" });
        const at = this.now();
        const items = plan.entries.map((e) => ({ _id: `${runId}:${e.assetId}`, provider: PROVIDER, type: ITEM_TYPE, runId, status: "queued", attempts: 0, runAfter: at, createdAt: at, params: e }));
        for (let i = 0; i < items.length; i += 500) {
          const batch = items.slice(i, i + 500);
          const have = new Set((await this.jobs.find({ _id: { $in: batch.map((x) => x._id) } }, { projection: { _id: 1 } }).toArray()).map((x) => x._id));
          const missing = batch.filter((x) => !have.has(x._id));
          if (missing.length) await this.jobs.insertMany(missing, { ordered: true });
        }
        await this.jobs.updateOne({ _id: runId, status: "preparing" }, { $set: { status: "prepared", preparedAt: this.now(), updatedAt: this.now() } });
        this.logger.log?.(`[mid-attachments] ${runId} prepared: ${items.length} files`);
      } catch (error) {
        const info = { code: String(error?.code || error?.name || "ERROR").slice(0, 60), message: String(error?.message || "").slice(0, 300), at: this.now() };
        await this.jobs.updateOne({ _id: runId, status: "preparing" }, { $set: { status: "prepare-failed", lastError: info, updatedAt: this.now() } }).catch(() => {});
        this.logger.error(`[mid-attachments] ${runId} prepare failed: ${info.code}`);
      } finally { this.preparing.delete(runId); }
    })());
    return this.status(runId);
  }

  // A read-only picture of what the import could affect, recorded on the run before each start (and compared by verify):
  // the board's records and their IDs, the records migration's item mappings, attachments (all, on the board, of this run),
  // asset mappings of this run and the Drive storage counter. It refuses to start if this run's own records disagree.
  async preStartSnapshot(run) {
    const boardId = run.boardId, runId = run._id, idHash = crypto.createHash("sha256"), mapHash = crypto.createHash("sha256");
    const board = await this.col("boards").findOne({ _id: boardId }, { projection: { archived: 1, columns: 1 } });
    // IDs only (a few thousand), sorted here so the digests don't depend on index order.
    const recordIds = (await this.col("records").find({ boardId }, { projection: { _id: 1 } }).toArray()).map((r) => r._id.toHexString()).sort();
    for (const id of recordIds) idHash.update(`${id}\n`);
    const records = recordIds.length;
    const pairs = (await this.col("integrationMappings").find({ provider: MAPPING_PROVIDER, kind: "item", runId: run.sourceRunId }, { projection: { sourceId: 1, targetId: 1 } }).toArray()).map((m) => `${m.sourceId}:${m.targetId.toHexString()}`).sort();
    for (const p of pairs) mapHash.update(`${p}\n`);
    const itemMappings = pairs.length;
    const imported = {};
    for (const a of await this.col("attachments").find({ "imported.runId": runId }, { projection: { status: 1 } }).toArray()) imported[a.status] = (imported[a.status] || 0) + 1;
    const items = {};
    for (const i of await this.jobs.find({ type: ITEM_TYPE, runId }, { projection: { status: 1 } }).toArray()) items[i.status] = (items[i.status] || 0) + 1;
    const usage = await this.col("storageUsage").findOne({ _id: "gdrive" });
    const snapshot = {
      at: this.now(), boardExists: Boolean(board), boardArchived: Boolean(board?.archived), filesColumns: (board?.columns || []).filter((c) => c.type === "files").map((c) => c.key),
      recordsOnBoard: records, recordIdsDigest: idHash.digest("hex"), itemMappings, itemMappingsDigest: mapHash.digest("hex"),
      attachmentsTotal: await this.col("attachments").countDocuments({}), attachmentsOnBoard: await this.col("attachments").countDocuments({ boardId }), importedByThisRun: imported,
      assetMappingsOfThisRun: await this.col("integrationMappings").countDocuments({ provider: MAPPING_PROVIDER, kind: "asset", runId }), items,
      storageUsage: usage ? { usedBytes: usage.usedBytes || 0, reservedBytes: usage.reservedBytes || 0 } : null
    };
    const problems = [];
    if (!snapshot.boardExists) problems.push("board-missing");
    if (snapshot.boardArchived) problems.push("board-archived");
    if ((imported.ready || 0) !== (items.done || 0)) problems.push("imported-attachments-differ-from-done-files");
    if (snapshot.assetMappingsOfThisRun !== (imported.ready || 0)) problems.push("asset-mappings-differ-from-imported-attachments");
    snapshot.problems = problems;
    return snapshot;
  }

  async start(runId, { mode, count, confirm }) {
    if (confirm !== true) throw fail(400, "CONFIRMATION_REQUIRED", "Confirm starting the import.");
    if (!["pilot", "full"].includes(mode)) throw fail(400, "VALIDATION_ERROR", "mode must be pilot or full.");
    const run = await this.run(runId);
    if (!["prepared", "paused", "stopped"].includes(run.status)) throw fail(409, "RUN_NOT_STARTABLE", `The run is ${run.status}.`);
    if (mode === "full") {
      if (!run.pilotFinishedAt) throw fail(409, "PILOT_REQUIRED", "Run the 20-file pilot and check it before starting the full import.");
      if (!(await this.jobs.countDocuments({ type: ITEM_TYPE, runId, status: "done" }))) throw fail(409, "PILOT_REQUIRED", "No file of the pilot was imported. Look at its failures and run the pilot again.");
    }
    const now = this.now();
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
    const snapshot = await this.preStartSnapshot(run);
    if (snapshot.problems.length) throw fail(409, "PRE_START_CHECK_FAILED", "The read-only check before starting found a problem. Verify the run first.", { problems: snapshot.problems });
    const set = { status: "running", mode, remaining: allowance, startedAt: now, updatedAt: now, pausedReason: null, lastError: null, capacityAtStart: capacity };
    const r = await this.jobs.updateOne({ _id: runId, status: run.status }, { $set: set, $push: { snapshots: { ...snapshot, mode, capacity } } });
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
  // READ-ONLY: what one file of the run really is. Downloads it from monday.com (as an import attempt would) and reports its
  // size, checksum, the type its name implied and the type its content signature shows. Writes nothing anywhere.
  async inspect(runId, assetId) {
    await this.run(runId);
    const item = await this.item(runId, assetId);
    let bytes;
    // A download problem is answered with its code (MIGRATION_SOURCE_MISSING, MONDAY_UNAUTHORIZED, …), not as a server error.
    try { bytes = await this.download(item.params); }
    catch (error) { if (error instanceof ApiError) throw error; throw fail(502, String(error?.code || "MIGRATION_SOURCE_UNAVAILABLE").slice(0, 60), "The file couldn't be downloaded from monday.com to inspect it. Nothing was changed."); }
    const sniff = detectContentType(bytes, item.params.type, TYPES);
    return { runId, assetId: item.params.assetId, status: item.status, attempts: item.attempts, lastError: item.error?.code || null, sizeBytes: bytes.length, sha256: sha256(bytes), declaredType: sniff.declared, detectedType: sniff.detected, matchesDeclared: sniff.matchesDeclared, wouldStoreAs: sniff.matchesDeclared ? sniff.declared : sniff.corrected, storedName: sniff.corrected ? correctedName(item.params.plannedName || item.params.name, sniff.corrected, TYPES) : null, retryWouldSucceedTypeCheck: Boolean(sniff.matchesDeclared || sniff.corrected) };
  }
  // Retries exactly one FAILED file of a finished run: the item goes back in line, the run runs with an allowance of one, and
  // ends completed again. Every other file stays as it is (done files aren't touched; nothing else is queued). The writer's
  // recovery removes the failed attempt's leftover document and any object under its old key before storing, and the unique
  // indexes (attachment per source asset, mapping per asset) make a second copy impossible.
  async retryOne(runId, assetId, { confirm } = {}) {
    if (confirm !== `RETRY ${assetId}`) throw fail(400, "CONFIRMATION_REQUIRED", `Type "RETRY ${assetId}" to confirm.`);
    const run = await this.run(runId);
    if (!["completed", "paused", "stopped"].includes(run.status)) throw fail(409, "RUN_NOT_RETRYABLE", `The run is ${run.status}.`);
    const item = await this.item(runId, assetId);
    if (item.status !== "failed") throw fail(409, "ITEM_NOT_FAILED", `This file is ${item.status}; only a failed file can be retried.`);
    if (await this.jobs.countDocuments({ type: ITEM_TYPE, runId, status: { $in: ["queued", "retry", "running"] } })) throw fail(409, "RUN_HAS_WORK", "Other files of this run are still waiting. Finish or stop them first.");
    const capacity = await this.capacity(item.params.sizeBytes);
    if (!capacity.enough) throw fail(409, "NOT_ENOUGH_STORAGE", "There isn't enough storage for this file.", { capacity });
    const snapshot = await this.preStartSnapshot(run);
    if (snapshot.problems.length) throw fail(409, "PRE_START_CHECK_FAILED", "The read-only check before starting found a problem. Verify the run first.", { problems: snapshot.problems });
    const now = this.now();
    const back = await this.jobs.updateOne({ _id: item._id, status: "failed" }, { $set: { status: "queued", attempts: 0, runAfter: now, previousError: item.error || null, updatedAt: now }, $unset: { error: "" } });
    if (back.matchedCount !== 1) throw fail(409, "RUN_CHANGED", "The file changed in the meantime. Reload and try again.");
    const r = await this.jobs.updateOne({ _id: runId, status: run.status }, { $set: { status: "running", remaining: 1, retryingAssetId: item.params.assetId, updatedAt: now, pausedReason: null, lastError: null }, $push: { snapshots: { ...snapshot, mode: "retry-one", capacity } } });
    if (r.matchedCount !== 1) {
      await this.jobs.updateOne({ _id: item._id, status: "queued" }, { $set: { status: "failed", error: item.error || null, updatedAt: this.now() } });
      throw fail(409, "RUN_CHANGED", "The run changed in the meantime. Reload and try again.");
    }
    this.logger.log?.(`[mid-attachments] ${runId} retrying asset ${item.params.assetId} only`);
    this.kick();
    return this.status(runId);
  }
  async item(runId, assetId) {
    if (typeof assetId !== "string" || !/^\d{1,20}$/.test(assetId)) throw fail(404, "NOT_FOUND", "No such file in this run.");
    const item = await this.jobs.findOne({ type: ITEM_TYPE, runId, "params.assetId": assetId });
    if (!item) throw fail(404, "NOT_FOUND", "No such file in this run.");
    return item;
  }
  async stop(runId) { return this.transition(runId, ["running", "paused"], { status: "stopped", remaining: 0, pausedReason: "stopped-by-administrator" }); }
  async transition(runId, from, set) {
    const r = await this.jobs.updateOne({ _id: runId, type: RUN_TYPE, status: { $in: from } }, { $set: { ...set, updatedAt: this.now() } });
    if (r.matchedCount !== 1) { const run = await this.run(runId); throw fail(409, "RUN_STATE", `The run is ${run.status}.`); }
    return this.status(runId);
  }
  async rollback(runId, { confirm }) {
    if (confirm !== `ROLLBACK ${runId}`) throw fail(400, "CONFIRMATION_REQUIRED", `Type "ROLLBACK ${runId}" to confirm.`);
    const out = await this.transition(runId, ["prepared", "prepare-failed", "paused", "stopped", "completed"], { status: "rolling-back", remaining: 0 });
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
    const snapshots = (run.snapshots || []).map(({ at, mode, recordsOnBoard, itemMappings, attachmentsTotal, attachmentsOnBoard, importedByThisRun, assetMappingsOfThisRun, storageUsage }) => ({ at, mode, recordsOnBoard, itemMappings, attachmentsTotal, attachmentsOnBoard, importedByThisRun, assetMappingsOfThisRun, storageUsage }));
    return { runId, status: run.status, mode: run.mode, remaining: run.remaining, pausedReason: run.pausedReason || null, lastError: run.lastError || null, sourceRunId: run.sourceRunId, boardId: String(run.boardId), totals: run.totals, counts, createdAt: run.createdAt, createdByName: run.createdByName, preparing: run.status === "preparing", prepareInterrupted: run.status === "preparing" && !this.preparing.has(runId), preparedAt: run.preparedAt || null, pilotFinishedAt: run.pilotFinishedAt || null, startedAt: run.startedAt || null, finishedAt: run.finishedAt || null, rolledBackAt: run.rolledBackAt || null, snapshots, failures };
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
    // Against the snapshot recorded before the last start. The import never writes records or item mappings, so their IDs
    // must be unchanged unless people edited the board meanwhile (reported, not a failure of the import). Attachments that
    // aren't this run's are compared the same way.
    let sinceSnapshot = null;
    const last = (run.snapshots || []).at(-1);
    if (last) {
      const now = await this.preStartSnapshot(run), ownThen = Object.values(last.importedByThisRun || {}).reduce((a, b) => a + b, 0), ownNow = Object.values(now.importedByThisRun).reduce((a, b) => a + b, 0);
      sinceSnapshot = {
        snapshotAt: last.at, mode: last.mode,
        recordsOnBoard: { then: last.recordsOnBoard, now: now.recordsOnBoard }, recordIdsUnchanged: last.recordIdsDigest === now.recordIdsDigest,
        itemMappings: { then: last.itemMappings, now: now.itemMappings }, itemMappingsUnchanged: last.itemMappingsDigest === now.itemMappingsDigest,
        otherAttachments: { then: last.attachmentsTotal - ownThen, now: now.attachmentsTotal - ownNow },
        importedByThisRun: { then: ownThen, now: ownNow }, assetMappingsOfThisRun: { then: last.assetMappingsOfThisRun, now: now.assetMappingsOfThisRun }
      };
    }
    return {
      runId, status: run.status, items: items.reduce((acc, i) => ((acc[i.status] = (acc[i.status] || 0) + 1), acc), {}), attachments: docs.size, readyAttachments: [...docs.values()].filter((d) => d.status === "ready").length,
      assetMappings: maps.size, driveFiles: [...driveFiles.values()].filter((f) => f.kind === "mig").length, strayDriveFiles, problems: problems.slice(0, 200), problemCount: problems.length, samples, sinceSnapshot, ok: problems.length === 0 && strayDriveFiles === 0 && samples.every((s) => s.ok)
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
        monitor.recordJobFailure({ kind: "mid-attachments.paused", code });
      } else if (PERMANENT.has(code) || item.attempts >= MAX_ATTEMPTS || error?.retry === false) {
        await this.finish(item, { status: "failed", error: info });
        this.logger.error(`[mid-attachments] ${runId} asset ${p.assetId} failed: ${code}`);
        monitor.recordJobFailure({ kind: "mid-attachments.file", code });
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
    if (run.remaining <= 0 && !busy) { await this.jobs.updateOne({ _id: runId, status: "running" }, { $set: { status: "paused", pausedReason: run.mode === "pilot" ? "pilot-finished" : "allowance-used", ...(run.mode === "pilot" ? { pilotFinishedAt: this.now() } : {}), updatedAt: this.now() } }); this.logger.log?.(`[mid-attachments] ${runId} paused: ${run.mode === "pilot" ? "pilot finished" : "allowance used"}`); }
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
    // The planned type came from the file's name. When the bytes are a different accepted image type, store it as what it
    // really is (the upload guard then checks the bytes against that type). Anything else is refused as before.
    const sniff = detectContentType(bytes, p.type, TYPES);
    const typed = sniff.corrected ? { type: sniff.corrected, plannedName: correctedName(p.plannedName || p.name, sniff.corrected, TYPES), typeCorrection: { declaredType: p.type, detectedType: sniff.corrected, originalName: p.name ?? null } } : null;
    if (typed) this.logger.log?.(`[mid-attachments] ${run._id} asset ${p.assetId}: content is ${sniff.corrected}, not ${p.type}; stored as ${sniff.corrected}`);
    const writer = new AttachmentWriter({ client: this.connection.client, db: this.db, runId: run._id, storage: this.files.storage, provider: "gdrive", maxBytes: this.maxFileBytes, limitBytes: this.files.limitOf("gdrive"), workspaceId: run.workspaceId, now: this.now, faults: this.faults, types: TYPES });
    const entry = { _id: attachmentId, sourceAssetId: p.assetId, recordId, boardId: run.boardId, columnKey: p.columnKey, action: p.action, plannedType: typed?.type || p.type, plannedName: typed?.plannedName || p.plannedName, ...(typed ? { typeCorrection: typed.typeCorrection } : {}), originalName: p.name, sizeBytes: p.sizeBytes, oversized: p.oversized, linkedCommentIds: p.linkedCommentIds || [], sourceUploadedBy: p.sourceUploadedBy, sourceCreatedAt: p.sourceCreatedAt };
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
