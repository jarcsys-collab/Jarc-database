// Rollback of ONE migration run (Phase M4.1), and backup-reference checks. Executes only on a verified local test
// target in this phase; production stays locked.
//
//   scope       only documents whose IDs come from the plan (deterministic) AND that carry this run's ID
//               (records/boards importId, comments imported.runId, attachments imported.runId, mappings runId), plus
//               this run's board.imported activities. Never a filter over a collection, never anything else.
//   blockers    the dry run refuses when imported data was touched after the import: a record edited (version > 1),
//               a comment added by a person on an imported record, a file uploaded by a person, a board edited, or
//               a run still holding its lock. Nobody's later work is removed silently.
//   order       attachments (bytes first, then documents, quota freed) → comments → records → boards → activities →
//               mappings, in batches inside transactions; the run document is kept and marked rolled-back (audit).
const { COLLECTIONS } = require("../../db/bootstrap");
const { MAPPING_PROVIDER } = require("./ids");
const { isVerifiedTarget } = require("./target");
const { MigrationError, MigrationLockedError } = require("./executor");
const { StorageUsageRepository } = require("../../repositories/mongo/storage-usage-repository");

const BATCH = 500;
const ids = (docs) => docs.map((d) => d._id);

async function planRollback(db, plan) {
  const col = (n) => db.collection(COLLECTIONS[n]);
  const boardIds = [plan.board._id, plan.subBoard._id];
  const recordIds = [...plan.records, ...plan.subRecords].map((r) => r._id);
  const commentIds = plan.comments.map((c) => c._id);
  const attachmentIds = (plan.attachments || []).map((a) => a._id);
  const blockers = [];
  const inChunks = async (name, list, filter, projection) => { const out = []; for (let i = 0; i < list.length; i += 1000) out.push(...await col(name).find({ _id: { $in: list.slice(i, i + 1000) }, ...filter }, { projection }).toArray()); return out; };
  const boards = await inChunks("boards", boardIds, { importId: plan.runId }, { _id: 1, version: 1 });
  const records = await inChunks("records", recordIds, { importId: plan.runId }, { _id: 1, version: 1 });
  const comments = await inChunks("comments", commentIds, { "imported.runId": plan.runId }, { _id: 1 });
  const attachments = await inChunks("attachments", attachmentIds, { "imported.runId": plan.runId }, { _id: 1, size: 1, status: 1, storage: 1 });
  const mappings = await col("integrationMappings").find({ provider: MAPPING_PROVIDER, runId: plan.runId }, { projection: { _id: 1 }, limit: 200000 }).toArray();
  const activities = await col("activities").find({ action: "board.imported", entityId: { $in: boardIds } }, { projection: { _id: 1 } }).toArray();
  // Work done by people after the import.
  const edited = records.filter((r) => r.version > 1).length;
  if (edited) blockers.push(`${edited} imported record(s) were edited after the import`);
  if (boards.some((b) => b.version > 1)) blockers.push("an imported board was changed after the import (columns, groups or settings)");
  let peopleComments = 0, peopleFiles = 0;
  for (let i = 0; i < recordIds.length; i += 1000) {
    const part = recordIds.slice(i, i + 1000);
    peopleComments += await col("comments").countDocuments({ recordId: { $in: part }, imported: { $exists: false } });
    peopleFiles += await col("attachments").countDocuments({ recordId: { $in: part }, imported: { $exists: false } });
  }
  if (peopleComments) blockers.push(`${peopleComments} update(s) were posted by people on imported records`);
  if (peopleFiles) blockers.push(`${peopleFiles} file(s) were uploaded by people to imported records`);
  const otherRecordsOnBoards = await col("records").countDocuments({ boardId: { $in: boardIds }, importId: { $ne: plan.runId } });
  if (otherRecordsOnBoards) blockers.push(`${otherRecordsOnBoards} record(s) were added to the imported boards by people`);
  const job = await col("integrationJobs").findOne({ _id: `monday-migration:${plan.runId}` });
  if (job?.lockedBy && job.lockedUntil > new Date()) blockers.push("a run of this import is in progress");
  return {
    runId: plan.runId, ok: blockers.length === 0, blockers,
    counts: { boards: boards.length, records: records.length, comments: comments.length, attachments: attachments.length, mappings: mappings.length, activities: activities.length },
    targets: { boards: ids(boards), records: ids(records), comments: ids(comments), attachments, mappings: ids(mappings), activities: ids(activities) }
  };
}

// approval: { kind: "migration-rollback-approval", version: 1, runId, planDigest, expectedCounts, approvedBy, expiresAt }
async function executeRollback({ client, target, plan, planDigest, approval, storage = null, now = () => new Date() }) {
  if (require("./production-target").isVerifiedProductionTarget(target)) throw new MigrationLockedError("Rollback in production is disabled in this phase.");
  if (!isVerifiedTarget(target)) throw new MigrationError("MIGRATION_TARGET_UNVERIFIED", "The target was not verified as a permitted local test database.");
  const db = client.db(target.dbName), col = (n) => db.collection(COLLECTIONS[n]);
  const dry = await planRollback(db, plan);
  const p = [];
  if (!approval || approval.kind !== "migration-rollback-approval" || approval.version !== 1) p.push("not a rollback approval");
  else {
    if (approval.runId !== plan.runId || approval.planDigest !== planDigest) p.push("the approval is for another run or plan");
    if (JSON.stringify(approval.expectedCounts) !== JSON.stringify(dry.counts)) p.push("the approval's counts differ from what the dry run found");
    if (!approval.approvedBy || Number.isNaN(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= now().getTime()) p.push("the approval is expired or unsigned");
  }
  if (!dry.ok) p.push(...dry.blockers);
  if (p.length) throw new MigrationError("MIGRATION_ROLLBACK_REFUSED", `Rollback refused: ${p[0]}`, { problems: p });
  const usage = new StorageUsageRepository(db);
  // Files: bytes first (only migration-owned objects), then documents and quota.
  for (const a of dry.targets.attachments) {
    if (storage) await storage.forAttachment(a).delete(storage.keyOf(a)).catch(() => {});
    const r = await col("attachments").deleteOne({ _id: a._id, "imported.runId": plan.runId });
    if (r.deletedCount === 1) await usage[a.status === "ready" ? "free" : "release"](storage ? storage.providerOf(a) : (a.storage?.provider || "gridfs"), Number(a.size) || 0);
  }
  const removeAll = async (name, list, guard) => {
    let removed = 0;
    for (let i = 0; i < list.length; i += BATCH) {
      const session = client.startSession();
      try { await session.withTransaction(async () => { removed += (await col(name).deleteMany({ _id: { $in: list.slice(i, i + BATCH) }, ...guard }, { session })).deletedCount; }); }
      finally { await session.endSession(); }
    }
    return removed;
  };
  const removed = {
    comments: await removeAll("comments", dry.targets.comments, { "imported.runId": plan.runId }),
    records: await removeAll("records", dry.targets.records, { importId: plan.runId, version: 1 }),
    boards: await removeAll("boards", dry.targets.boards, { importId: plan.runId }),
    activities: await removeAll("activities", dry.targets.activities, { action: "board.imported" }),
    mappings: await removeAll("integrationMappings", dry.targets.mappings, { provider: MAPPING_PROVIDER, runId: plan.runId }),
    attachments: dry.targets.attachments.length
  };
  await col("integrationJobs").updateOne({ _id: `monday-migration:${plan.runId}` }, { $set: { status: "rolled-back", rolledBackAt: now(), lockedBy: null, lockedUntil: null }, $push: { history: { event: "rollback", at: now(), approvedBy: approval.approvedBy, removed } } });
  return { removed };
}

// A production backup reference must be concrete and recent (checked again in the production approval).
function checkBackupReference(backup, { windowStart, now = new Date(), maxAgeHours = 24 }) {
  const p = [];
  if (!backup || !["atlas-snapshot", "mongodump"].includes(backup.kind)) return ["unknown backup kind (atlas-snapshot or mongodump)"];
  if (backup.kind === "atlas-snapshot" && !/^[0-9a-f]{24}$/.test(String(backup.reference || ""))) p.push("an Atlas snapshot reference is its 24-hex snapshot ID");
  if (backup.kind === "mongodump") {
    if (!/^[0-9a-f]{64}$/.test(String(backup.sha256 || ""))) p.push("a mongodump backup needs the archive's SHA-256");
    if (backup.database !== "jarc_database") p.push("the dump must be of jarc_database only");
    if (!Number.isInteger(backup.sizeBytes) || backup.sizeBytes <= 0) p.push("the dump's size is missing");
  }
  const taken = Date.parse(backup.takenAt), start = Date.parse(windowStart);
  if (Number.isNaN(taken) || taken > now.getTime()) p.push("the backup time is invalid");
  else if (!Number.isNaN(start) && (taken > start || start - taken > maxAgeHours * 3600 * 1000)) p.push(`the backup must be taken within ${maxAgeHours} h before the window`);
  if (backup.restoreTestedAt === undefined) p.push("the backup has not been restore-tested");
  return p;
}

module.exports = { planRollback, executeRollback, checkBackupReference };
