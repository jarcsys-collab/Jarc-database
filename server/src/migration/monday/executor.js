// The one-time import's write path (Phase M3). It runs ONLY against a verified local test target (target.js);
// production execution is disabled in code and no approval can enable it.
//
//   authorize   a version 2 approval naming the scope ("local-test"), the exact plan digest, the target database and
//               instance, the target workspace, the approver, the operator, an expiry, the full import scope and the
//               expected counts. A local-test approval can never authorize production (different scope, and bound to
//               one local instance ID).
//   preflight   the workspace must exist; stored mappings must point at the plan's own IDs and their documents must
//               exist; no planned ID may already exist without its mapping (unexpected destination data). Any
//               disagreement stops the run before writing. Nothing is ever updated in place, overwritten or deleted.
//   batches     boards (+ an activity entry each), then records, then sub-items, each batch with its comments, in one
//               transaction together with its integrationMappings and the progress checkpoint. Deterministic IDs and
//               unique indexes (records.uniq_board_legacy_id, integrationMappings.uniq_source) make a duplicate insert
//               fail the transaction instead of creating a copy.
//   resume      remaining batches are computed from the mappings already stored, so an interrupted run continues where
//               it stopped; a completed run re-run inserts nothing.
//   verify      every batch is read back by ID after commit; at the end, counts, groups, parents, same-board links,
//               threads and attachment references are checked against the plan.
//   no files    attachments stay references (status not-migrated): no GridFS files or attachment documents are created.
const crypto = require("crypto");
const os = require("os");
const { COLLECTIONS, ensureDatabase } = require("../../db/bootstrap");
const { activityEntry } = require("../../services/shared");
const { MAPPING_PROVIDER } = require("./ids");
const { isVerifiedTarget } = require("./target");

const PRODUCTION_EXECUTION_ENABLED = false; // Do not change without a separate reviewed change AND explicit approval.
const BATCH_SIZE = 250;
const SCOPE = ["boards", "records", "subitems", "comments"];
const JOB_TYPE = "monday-migration-import";

class MigrationError extends Error { constructor(code, message, details = {}) { super(message); this.name = "MigrationError"; this.code = code; Object.assign(this, details); } }
class MigrationLockedError extends MigrationError { constructor(message = "Production execution of the monday.com migration is disabled.") { super("MIGRATION_PRODUCTION_LOCKED", message); this.name = "MigrationLockedError"; } }

const planCounts = (plan) => ({ items: plan.records.length, subitems: plan.subRecords.length, updates: plan.comments.filter((c) => !c.parentId).length, replies: plan.comments.filter((c) => c.parentId).length });
// The attachment stage has its own approval scope and counts (only files whose action stores them).
const ATTACHMENT_SCOPE = ["attachments"];
const IMPORTABLE_ACTIONS = new Set(["store", "store-oversized", "rename-jfif", "preserve-heic", "download-only"]);
const attachmentCounts = (plan) => { const a = (plan.attachments || []).filter((x) => IMPORTABLE_ACTIONS.has(x.action)); return { attachments: a.length, oversized: a.filter((x) => x.oversized).length, bytes: a.reduce((s, x) => s + x.sizeBytes, 0) }; };

// Checks an approval against the plan, target and operator. Returns problems (empty = authorized).
// stage: "records" (boards, records, sub-items, comments) or "attachments" (the file stage, approved separately).
function checkAuthorization(approval, { planDigest, plan, target, operator, now = new Date(), stage = "records" }) {
  const problems = [];
  if (!approval || typeof approval !== "object") return ["no approval document"];
  if (approval.kind !== "monday-migration-approval" || approval.version !== 2) problems.push("not a version 2 monday-migration approval");
  if (approval.scope === "production") problems.push("production execution is disabled; no approval can enable it in this build");
  else if (approval.scope !== "local-test") problems.push("the approval has no valid scope");
  if (!target || target.scope !== approval.scope) problems.push("the approval's scope does not match the verified target");
  if (approval.planDigest !== planDigest) problems.push("the approval was given for a different plan (digest mismatch)");
  if (!target || approval.targetDatabase !== target.dbName) problems.push("the approval names a different target database");
  if (!target || approval.targetInstanceId !== target.instanceId) problems.push("the approval is bound to a different local test instance");
  if (!/^[0-9a-f]{24}$/.test(String(approval.targetWorkspaceId || ""))) problems.push("the approval has no valid target workspace");
  if (typeof approval.approvedBy !== "string" || !approval.approvedBy.trim()) problems.push("the approval doesn't say who approved it");
  if (typeof approval.operator !== "string" || approval.operator !== operator) problems.push("the operator running this is not the operator named in the approval");
  const expires = Date.parse(approval.expiresAt), approvedAt = Date.parse(approval.approvedAt);
  if (Number.isNaN(approvedAt) || approvedAt > now.getTime()) problems.push("the approval date is invalid");
  if (Number.isNaN(expires) || expires <= now.getTime()) problems.push("the approval has expired");
  else if (!Number.isNaN(approvedAt) && expires - approvedAt > 24 * 3600 * 1000) problems.push("the approval is valid for more than 24 hours");
  const scope = stage === "attachments" ? ATTACHMENT_SCOPE : SCOPE;
  if (!Array.isArray(approval.include) || approval.include.length !== scope.length || !scope.every((s) => approval.include.includes(s))) problems.push(`the import scope must be exactly: ${scope.join(", ")}`);
  if (plan && JSON.stringify(approval.expectedCounts || {}) !== JSON.stringify(stage === "attachments" ? attachmentCounts(plan) : planCounts(plan))) problems.push("the approval's expected counts differ from the plan");
  return problems;
}

// Run lock (one progress document per run). A live lock refuses; an expired one (its holder died) is only taken over
// when the operator asks for it, and every takeover is recorded in the run's history.
async function acquireRunLock(jobs, { jobId, now, operator, takeOverStaleLock = false, leaseMs = 15 * 60 * 1000, init }) {
  const lockId = crypto.randomUUID(), at = now();
  const job = await jobs.findOne({ _id: jobId });
  const lease = () => new Date(now().getTime() + leaseMs);
  if (!job) {
    try { await jobs.insertOne({ _id: jobId, ...init, status: "running", attempts: 1, lockedBy: lockId, lockedUntil: lease(), createdAt: at, lastStartedAt: at, operator, history: [] }); return { lockId, lease }; }
    catch (e) { if (e?.code === 11000) throw new MigrationError("MIGRATION_RUN_LOCKED", "Another run of this import holds the lock."); throw e; }
  }
  if (job.lockedBy && job.lockedUntil > at) throw new MigrationError("MIGRATION_RUN_LOCKED", "Another run of this import holds the lock.");
  const stale = Boolean(job.lockedBy);
  if (stale && !takeOverStaleLock) throw new MigrationError("MIGRATION_STALE_LOCK", "A previous run stopped without releasing its lock (its lease has expired). Re-run with an explicit stale-lock takeover to continue.", { previousLockedUntil: job.lockedUntil });
  const update = { $set: { lockedBy: lockId, lockedUntil: lease(), status: "running", lastStartedAt: at, operator }, $inc: { attempts: 1 } };
  if (stale) update.$push = { history: { event: "stale-lock-takeover", previousLockedBy: job.lockedBy, previousLockedUntil: job.lockedUntil, by: operator, at } };
  const claimed = await jobs.findOneAndUpdate({ _id: jobId, lockedBy: job.lockedBy ?? null }, update, { returnDocument: "after" });
  if (!claimed) throw new MigrationError("MIGRATION_RUN_LOCKED", "Another run of this import holds the lock.");
  return { lockId, lease, tookOver: stale };
}

// The batches still to run, given stored mappings ({ kind, sourceId, targetId(hex) }). Throws on disagreement.
function remainingBatches(plan, existingMappings = [], { batchSize = BATCH_SIZE } = {}) {
  const existing = new Map(existingMappings.map((m) => [`${m.kind}|${m.sourceId}`, String(m.targetId)]));
  const conflicts = [];
  const done = (kind, sourceId, targetId) => {
    const found = existing.get(`${kind}|${sourceId}`);
    if (found === undefined) return false;
    if (found !== targetId.toHexString()) conflicts.push(`${kind} ${sourceId}`);
    return true;
  };
  const commentsByRecord = new Map();
  for (const c of plan.comments) { const k = c.recordId.toHexString(); (commentsByRecord.get(k) || commentsByRecord.set(k, []).get(k)).push(c); }
  const batches = [];
  const boardDocs = [["board", plan.board], ["subitems-board", plan.subBoard]].filter(([kind, b]) => !done(kind, b.migration.parentSourceBoardId || b.migration.sourceBoardId, b._id));
  if (boardDocs.length) batches.push({ step: "boards", boards: boardDocs.map(([kind, b]) => ({ kind, board: b })), records: [], comments: [] });
  const chunk = (records, kind, step) => {
    const todo = [];
    for (const r of records) {
      const recordDone = done(kind, r.migration.sourceItemId, r._id);
      // Parents before replies: replies sort after their top-level comment.
      const comments = (commentsByRecord.get(r._id.toHexString()) || []).filter((c) => !done(c.parentId ? "reply" : "update", c.imported.sourceReplyId || c.imported.sourceUpdateId, c._id)).sort((a, b) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)));
      if (!recordDone || comments.length) todo.push({ record: recordDone ? null : r, comments });
    }
    for (let i = 0; i < todo.length; i += batchSize) {
      const part = todo.slice(i, i + batchSize);
      batches.push({ step, records: part.map((p) => p.record).filter(Boolean), comments: part.flatMap((p) => p.comments) });
    }
  };
  chunk(plan.records, "item", "records");
  chunk(plan.subRecords, "subitem", "subitems");
  if (conflicts.length) throw new MigrationError("MIGRATION_MAPPING_CONFLICT", `Stored migration mappings disagree with this plan (${conflicts.length}); nothing will be overwritten.`, { conflicts: conflicts.slice(0, 50) });
  return batches;
}

// After a batch: the documents read back must be exactly the batch (same IDs, nothing missing, nothing extra).
function verifyBatch(batch, found) {
  const want = (docs) => new Set(docs.map((d) => d._id.toHexString()));
  const problems = [];
  for (const [name, docs] of [["records", batch.records], ["comments", batch.comments]]) {
    const w = want(docs), f = new Set((found[name] || []).map((d) => d._id.toHexString()));
    for (const id of w) if (!f.has(id)) problems.push(`${name}: ${id} missing after insert`);
    for (const id of f) if (!w.has(id)) problems.push(`${name}: unexpected ${id}`);
  }
  return problems;
}

const mappingKey = (kind, doc) => ({ kind, sourceId: kind === "board" || kind === "subitems-board" ? doc.migration.parentSourceBoardId || doc.migration.sourceBoardId : kind === "item" || kind === "subitem" ? doc.migration.sourceItemId : doc.imported.sourceReplyId || doc.imported.sourceUpdateId });
const kindOfComment = (c) => (c.parentId ? "reply" : "update");

async function preflight(db, plan, workspaceId) {
  const col = (n) => db.collection(COLLECTIONS[n]);
  if (!(await col("workspaces").findOne({ _id: workspaceId }, { projection: { _id: 1 } }))) throw new MigrationError("MIGRATION_WORKSPACE_MISSING", "The target workspace does not exist.");
  const stored = await col("integrationMappings").find({ provider: MAPPING_PROVIDER }, { limit: 200000 }).toArray();
  // Asset mappings come from the attachment stage of the same plan.
  const planned = new Map([...plan.mappings, ...(plan.attachments || []).map((a) => ({ kind: "asset", sourceId: a.sourceAssetId, targetId: a._id }))].map((m) => [`${m.kind}|${m.sourceId}`, m]));
  const problems = [];
  for (const m of stored) {
    const p = planned.get(`${m.kind}|${m.sourceId}`);
    if (!p) problems.push(`stored mapping ${m.kind} ${m.sourceId} is not part of this plan`);
    else if (!p.targetId.equals(m.targetId)) problems.push(`stored mapping ${m.kind} ${m.sourceId} points elsewhere`);
    if (m.runId !== plan.runId) problems.push(`stored mapping ${m.kind} ${m.sourceId} belongs to run ${m.runId}`);
  }
  const mapped = new Set(stored.map((m) => m.targetId.toHexString()));
  const groups = { boards: [plan.board, plan.subBoard], records: [...plan.records, ...plan.subRecords], comments: plan.comments };
  for (const [name, docs] of Object.entries(groups)) {
    for (let i = 0; i < docs.length; i += 1000) {
      const ids = docs.slice(i, i + 1000).map((d) => d._id);
      const found = await col(name).find({ _id: { $in: ids } }, { projection: { _id: 1, importId: 1, imported: 1, workspaceId: 1 } }).toArray();
      for (const f of found) {
        const hex = f._id.toHexString();
        if (!mapped.has(hex)) problems.push(`${name} ${hex} already exists without a migration mapping (unexpected destination data)`);
        else if (name !== "comments" && f.importId !== plan.runId) problems.push(`${name} ${hex} was not created by this run`);
        else if (name === "comments" && f.imported?.runId !== plan.runId) problems.push(`comment ${hex} was not created by this run`);
        if (f.workspaceId && !f.workspaceId.equals(workspaceId)) problems.push(`${name} ${hex} is in another workspace`);
      }
      const foundIds = new Set(found.map((f) => f._id.toHexString()));
      for (const id of ids) if (mapped.has(id.toHexString()) && !foundIds.has(id.toHexString())) problems.push(`${name} ${id.toHexString()} has a mapping but no document (manual deletion?)`);
    }
  }
  if (problems.length) throw new MigrationError("MIGRATION_DESTINATION_CONFLICT", `The destination disagrees with this plan (${problems.length}); nothing was written.`, { problems: problems.slice(0, 50) });
  return stored.map((m) => ({ kind: m.kind, sourceId: m.sourceId, targetId: m.targetId.toHexString() }));
}

// Runs (or resumes) the import. faults: local-test-only interruption simulation { failInsideBatch, crashAfterCommit }.
async function runImport({ client, target, plan, planDigest, approval, operator = os.userInfo().username, now = () => new Date(), batchSize = BATCH_SIZE, faults = null, takeOverStaleLock = false, log = () => {} }) {
  // A verified PRODUCTION target is refused here in this build, whatever the approval says.
  if (require("./production-target").isVerifiedProductionTarget(target) && !PRODUCTION_EXECUTION_ENABLED) throw new MigrationLockedError();
  if (!isVerifiedTarget(target)) throw new MigrationError("MIGRATION_TARGET_UNVERIFIED", "The target was not verified as a permitted local test database.");
  if (target.scope !== "local-test" && !PRODUCTION_EXECUTION_ENABLED) throw new MigrationLockedError();
  const problems = checkAuthorization(approval, { planDigest, plan, target, operator, now: now() });
  if (problems.length) throw new MigrationError("MIGRATION_NOT_AUTHORIZED", `Not authorized: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}`, { problems });
  if (faults && target.scope !== "local-test") throw new MigrationError("MIGRATION_FAULTS_REFUSED", "Fault injection is only possible on a local test target.");
  const db = client.db(target.dbName);
  const col = (n) => db.collection(COLLECTIONS[n]);
  await ensureDatabase(db);
  const { ObjectId } = require("mongodb");
  const workspaceId = new ObjectId(approval.targetWorkspaceId);
  const existing = await preflight(db, plan, workspaceId);
  const batches = remainingBatches(plan, existing, { batchSize });

  // Progress document (one per run); a lease stops two operators running the same import at once.
  const jobId = `monday-migration:${plan.runId}`;
  const { lockId, lease: leaseUntil } = await acquireRunLock(col("integrationJobs"), { jobId, now, operator, takeOverStaleLock, init: { provider: MAPPING_PROVIDER, type: JOB_TYPE, runId: plan.runId, planDigest, scope: target.scope, workspaceId, batchesDone: 0, approvedBy: approval.approvedBy } });
  const release = (set) => col("integrationJobs").updateOne({ _id: jobId, lockedBy: lockId }, { $set: { lockedBy: null, lockedUntil: null, ...set } });

  const summary = { batchesPlanned: batches.length, batchesDone: 0, inserted: { boards: 0, records: 0, comments: 0, mappings: 0, activities: 0 } };
  try {
    let position = null;
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index], at = now();
      if (batch.step === "boards" && position === null) {
        const last = await col("boards").find({ workspaceId }, { sort: { position: -1 }, limit: 1, projection: { position: 1 } }).toArray();
        position = (last[0]?.position || 0) + 1000;
      }
      const boards = (batch.boards || []).map(({ kind, board }, i) => ({ kind, doc: { ...board, workspaceId, position: position + i * 1000, createdAt: at, updatedAt: at } }));
      const records = batch.records.map((r) => ({ ...r, workspaceId }));
      const comments = batch.comments.map((c) => ({ ...c, workspaceId }));
      const mappings = [
        ...boards.map(({ kind, doc }) => ({ provider: MAPPING_PROVIDER, ...mappingKey(kind, doc), targetId: doc._id, boardId: doc._id, runId: plan.runId, createdAt: at })),
        ...records.map((r) => ({ provider: MAPPING_PROVIDER, ...mappingKey(batch.step === "subitems" ? "subitem" : "item", r), targetId: r._id, boardId: r.boardId, runId: plan.runId, createdAt: at })),
        ...comments.map((c) => ({ provider: MAPPING_PROVIDER, ...mappingKey(kindOfComment(c), c), targetId: c._id, boardId: c.boardId, runId: plan.runId, createdAt: at }))
      ];
      const activities = boards.map(({ doc }) => activityEntry({ workspaceId, boardId: doc._id, actorUserId: null, actorName: "monday.com migration", action: "board.imported", entityType: "board", entityId: doc._id, summary: `Imported from monday.com board ${doc.migration.sourceBoardId || doc.migration.parentSourceBoardId} (${doc._id.equals(plan.board._id) ? plan.records.length : plan.subRecords.length} records)`, now: at }));
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          if (boards.length) await col("boards").insertMany(boards.map((b) => b.doc), { session, ordered: true });
          if (records.length) await col("records").insertMany(records, { session, ordered: true });
          if (comments.length) await col("comments").insertMany(comments, { session, ordered: true });
          if (mappings.length) await col("integrationMappings").insertMany(mappings, { session, ordered: true });
          if (activities.length) await col("activities").insertMany(activities, { session, ordered: true });
          if (faults?.failInsideBatch === index) throw new MigrationError("MIGRATION_SIMULATED_INTERRUPTION", `Simulated interruption inside batch ${index}`);
          await col("integrationJobs").updateOne({ _id: jobId, lockedBy: lockId }, { $inc: { batchesDone: 1 }, $set: { lastBatch: { index, step: batch.step, records: records.length, comments: comments.length, at }, lockedUntil: leaseUntil() } }, { session });
        }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      } catch (error) {
        if (error?.code === 11000) throw new MigrationError("MIGRATION_DUPLICATE_REFUSED", "A document or mapping of this batch already exists; the batch was rolled back and nothing was overwritten.");
        throw error;
      } finally { await session.endSession(); }
      if (faults?.crashAfterCommit === index) throw new MigrationError("MIGRATION_SIMULATED_CRASH", `Simulated crash after committing batch ${index}`);
      // Read back what was just committed.
      const readBack = { records: records.length ? await col("records").find({ _id: { $in: records.map((r) => r._id) } }, { projection: { _id: 1 } }).toArray() : [], comments: comments.length ? await col("comments").find({ _id: { $in: comments.map((c) => c._id) } }, { projection: { _id: 1 } }).toArray() : [] };
      const vb = verifyBatch({ records, comments }, readBack);
      const storedMaps = await col("integrationMappings").countDocuments({ provider: MAPPING_PROVIDER, targetId: { $in: mappings.map((m) => m.targetId) } });
      if (storedMaps !== mappings.length) vb.push(`mappings: ${storedMaps}/${mappings.length} after insert`);
      if (boards.length && (await col("boards").countDocuments({ _id: { $in: boards.map((b) => b.doc._id) } })) !== boards.length) vb.push("boards missing after insert");
      if (vb.length) throw new MigrationError("MIGRATION_VERIFY_FAILED", `Batch ${index} did not read back as written.`, { problems: vb });
      summary.batchesDone += 1;
      summary.inserted.boards += boards.length; summary.inserted.records += records.length; summary.inserted.comments += comments.length; summary.inserted.mappings += mappings.length; summary.inserted.activities += activities.length;
      log(`batch ${index + 1}/${batches.length} (${batch.step}): ${records.length} records, ${comments.length} comments`);
    }
    const verification = await verifyImport(db, plan, workspaceId);
    await release({ status: verification.ok ? "completed" : "failed-verification", finishedAt: now(), verification: { ok: verification.ok, counts: verification.counts, problems: verification.problems.slice(0, 50) } });
    if (!verification.ok) throw new MigrationError("MIGRATION_VERIFY_FAILED", "The finished import does not match the plan.", { problems: verification.problems });
    return { ...summary, verification };
  } catch (error) {
    await release({ status: "interrupted", lastError: { code: error.code || error.name, message: String(error.message).slice(0, 300), at: now() } }).catch(() => {});
    throw error;
  }
}

// Whole-import verification: everything planned is present, exactly once, with consistent references.
async function verifyImport(db, plan, workspaceId) {
  const col = (n) => db.collection(COLLECTIONS[n]);
  const problems = [];
  const boardIds = [plan.board._id, plan.subBoard._id];
  const counts = {
    boards: await col("boards").countDocuments({ _id: { $in: boardIds }, workspaceId }),
    records: await col("records").countDocuments({ boardId: plan.board._id }),
    subitems: await col("records").countDocuments({ boardId: plan.subBoard._id }),
    updates: await col("comments").countDocuments({ boardId: { $in: boardIds }, parentId: null }),
    replies: await col("comments").countDocuments({ boardId: { $in: boardIds }, parentId: { $ne: null } }),
    mappings: await col("integrationMappings").countDocuments({ provider: MAPPING_PROVIDER, runId: plan.runId, kind: { $ne: "asset" } }),
    attachmentsCreated: await col("attachments").countDocuments({ boardId: { $in: boardIds }, imported: { $exists: false } }),
    gridFsFiles: await db.collection(COLLECTIONS.attachmentFiles).countDocuments({ "metadata.boardId": { $in: boardIds } })
  };
  const expected = { boards: 2, records: plan.records.length, subitems: plan.subRecords.length, updates: plan.comments.filter((c) => !c.parentId).length, replies: plan.comments.filter((c) => c.parentId).length, mappings: plan.mappings.length, attachmentsCreated: 0, gridFsFiles: 0 };
  for (const [k, v] of Object.entries(expected)) if (counts[k] !== v) problems.push(`${k}: ${counts[k]} in the database, ${v} planned`);
  const board = await col("boards").findOne({ _id: plan.board._id });
  if (board?.source !== undefined) problems.push("the imported board is marked as a synchronized (read-only) board");
  return { ok: problems.length === 0, counts, expected, problems };
}

module.exports = { runImport, verifyImport, checkAuthorization, remainingBatches, verifyBatch, planCounts, attachmentCounts, acquireRunLock, MigrationError, MigrationLockedError, PRODUCTION_EXECUTION_ENABLED, BATCH_SIZE, SCOPE, ATTACHMENT_SCOPE, IMPORTABLE_ACTIONS, JOB_TYPE };
