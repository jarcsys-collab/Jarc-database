// Attachment stage of the monday.com migration (Phase M4.1): stores ONE planned file (plan.attachments entry) safely.
// No HTTP route reaches this: it runs only from the migration tool, against a verified target, with a separately
// approved attachment-stage approval — the only way a file over 10 MB can enter JARC (the upload API stays at 10 MB).
// In this phase it is exercised with synthetic files only; no monday.com file is downloaded.
//
// Sequence for one file:
//   1 destination   the record exists on the planned board and the column is a genuine Files column
//   2 source        the action is importable, the type is a known migration type, the size matches the inventory and is
//                   within the migration limit (oversized files must be flagged as such), a SHA-256 is given
//   3 recovery      a previous attempt's leftovers are cleaned: pending/failed document → its object is deleted and the
//                   document removed (reservation given back); ready + mapping → already done; ready without mapping →
//                   bytes re-verified, then the mapping is written; a mapping without a document → stop (never guess)
//   4 reserve       quota reserved on the target provider (concurrency-safe counter)
//   5 pending       the attachment document is created as pending (so the bytes are never ownerless), with
//                   storage { provider, key: "mig/<run>/<id>" } and `imported` provenance
//   6 store         streamed through the same checks as uploads (signature, size, SHA-256), then read back (size and
//                   checksum) — a mismatch aborts and removes the object
//   7 complete      pending → ready, the mapping (kind "asset") and the quota commit, in one transaction
//   8 verify        the attachment is listed as ready on its record and column
// Any failure after 5 marks the document failed (never ready), removes the object and gives the reservation back.
const { ObjectId } = require("mongodb");
const { COLLECTIONS } = require("../../db/bootstrap");
const { MIGRATION_TYPES, MAX_FILE_BYTES, cleanFileName } = require("../../files/file-types");
const { receiveStream } = require("../../services/file-service");
const { StorageUsageRepository } = require("../../repositories/mongo/storage-usage-repository");
const { MAPPING_PROVIDER, PROVIDER } = require("./ids");
const { isVerifiedTarget } = require("./target");
const { isVerifiedProductionTarget } = require("./production-target");
const { checkAuthorization, MigrationError, MigrationLockedError, PRODUCTION_EXECUTION_ENABLED, IMPORTABLE_ACTIONS } = require("./executor");

const SHA256 = /^[0-9a-f]{64}$/;

class AttachmentImporter {
  // storage: an AttachmentStorage; provider: where migrated files go (production: "s3", Railway Buckets).
  constructor({ client, target, plan, planDigest, approval, storage, provider, maxBytes, limitBytes, operator, now = () => new Date(), faults = null }) {
    if (isVerifiedProductionTarget(target) && !PRODUCTION_EXECUTION_ENABLED) throw new MigrationLockedError();
    if (!isVerifiedTarget(target)) throw new MigrationError("MIGRATION_TARGET_UNVERIFIED", "The target was not verified as a permitted database.");
    if (target.scope !== "local-test" && !PRODUCTION_EXECUTION_ENABLED) throw new MigrationLockedError();
    const problems = checkAuthorization(approval, { planDigest, plan, target, operator, now: now(), stage: "attachments" });
    if (problems.length) throw new MigrationError("MIGRATION_NOT_AUTHORIZED", `Not authorized: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}`, { problems });
    if (faults && target.scope !== "local-test") throw new MigrationError("MIGRATION_FAULTS_REFUSED", "Fault injection is only possible on a local test target.");
    if (!(maxBytes >= MAX_FILE_BYTES && maxBytes <= 100 * 1024 * 1024)) throw new MigrationError("MIGRATION_LIMIT_INVALID", "The migration file limit must be between 10 and 100 MB.");
    const db = client.db(target.dbName);
    Object.assign(this, { client, db, plan, storage, provider, store: storage.store(provider), maxBytes, limitBytes, now, faults, workspaceId: new ObjectId(approval.targetWorkspaceId), usage: new StorageUsageRepository(db) });
  }
  col(name) { return this.db.collection(COLLECTIONS[name]); }
  keyFor(entry) { return this.provider === "gridfs" ? entry._id : `mig/${this.plan.runId}/${entry._id.toHexString()}`; }

  // entry: a plan.attachments entry; source: { sha256, size, open: () => Readable } (from the verified staging copy).
  async importOne(entry, source) {
    // 1 destination
    const record = await this.col("records").findOne({ _id: entry.recordId, boardId: entry.boardId, workspaceId: this.workspaceId });
    if (!record) throw new MigrationError("MIGRATION_ATTACHMENT_RECORD_MISSING", `Record for asset ${entry.sourceAssetId} is not in the target workspace.`);
    const board = await this.col("boards").findOne({ _id: entry.boardId });
    if (!board?.columns.some((c) => c.key === entry.columnKey && c.type === "files")) throw new MigrationError("MIGRATION_ATTACHMENT_COLUMN_MISSING", `Column ${entry.columnKey} is not a Files column.`);
    // 2 source
    if (!IMPORTABLE_ACTIONS.has(entry.action)) throw new MigrationError("MIGRATION_ATTACHMENT_NOT_IMPORTABLE", `Asset ${entry.sourceAssetId} is planned as "${entry.action}".`);
    const type = MIGRATION_TYPES[entry.plannedType];
    if (!type) throw new MigrationError("MIGRATION_ATTACHMENT_TYPE", `Asset ${entry.sourceAssetId} has an unsupported type.`);
    if (!SHA256.test(String(source.sha256 || ""))) throw new MigrationError("MIGRATION_ATTACHMENT_CHECKSUM", `Asset ${entry.sourceAssetId} has no SHA-256.`);
    if (source.size !== entry.sizeBytes) throw new MigrationError("MIGRATION_ATTACHMENT_SIZE", `Asset ${entry.sourceAssetId}: the staged size differs from the inventory.`);
    if (source.size > this.maxBytes || (source.size > MAX_FILE_BYTES && !entry.oversized)) throw new MigrationError("MIGRATION_ATTACHMENT_TOO_LARGE", `Asset ${entry.sourceAssetId} is larger than allowed.`);
    const name = cleanFileName(entry.plannedName || entry.originalName || "file", entry.plannedType, MIGRATION_TYPES);
    // 3 recovery
    const existing = await this.col("attachments").findOne({ _id: entry._id });
    const mapping = await this.col("integrationMappings").findOne({ provider: MAPPING_PROVIDER, kind: "asset", sourceId: entry.sourceAssetId });
    if (mapping && !mapping.targetId.equals(entry._id)) throw new MigrationError("MIGRATION_MAPPING_CONFLICT", `Asset ${entry.sourceAssetId} is mapped elsewhere.`);
    if (existing?.status === "ready" && mapping) return { status: "already", id: entry._id };
    if (!existing && mapping) throw new MigrationError("MIGRATION_DESTINATION_CONFLICT", `Asset ${entry.sourceAssetId} has a mapping but no attachment (manual deletion?).`);
    if (existing && !existing.imported) throw new MigrationError("MIGRATION_DESTINATION_CONFLICT", `Attachment ${entry._id.toHexString()} exists and is not a migrated file.`);
    if (existing?.status === "ready") {
      const st = await this.storage.forAttachment(existing).stat(this.storage.keyOf(existing));
      if (!st || st.size !== existing.size) throw new MigrationError("MIGRATION_ATTACHMENT_BYTES_MISSING", `Asset ${entry.sourceAssetId} is marked ready but its bytes are missing.`);
      await this.complete(existing, { alreadyReady: true });
      return { status: "repaired", id: entry._id };
    }
    if (existing) await this.cleanup(existing);
    // 4 reserve
    if (!await this.usage.reserve(this.provider, source.size, this.limitBytes)) throw new MigrationError("MIGRATION_STORAGE_FULL", "The storage limit would be exceeded.");
    // 5 pending
    const at = this.now(), key = this.keyFor(entry);
    const doc = {
      _id: entry._id, workspaceId: this.workspaceId, boardId: entry.boardId, recordId: entry.recordId, columnKey: entry.columnKey, name, type: entry.plannedType, size: source.size, sha256: source.sha256,
      storage: this.provider === "gridfs" ? { provider: "gridfs" } : { provider: this.provider, key },
      status: "pending", uploadedBy: null, uploadedByName: "monday.com migration", createdAt: at,
      imported: { provider: PROVIDER, runId: this.plan.runId, sourceAssetId: entry.sourceAssetId, action: entry.action, oversized: Boolean(entry.oversized), originalName: entry.originalName ?? null, linkedCommentIds: entry.linkedCommentIds, sourceUploadedBy: entry.sourceUploadedBy, sourceCreatedAt: entry.sourceCreatedAt, ...(type.downloadOnly ? { downloadOnly: true } : {}) }
    };
    try { await this.col("attachments").insertOne(doc); }
    catch (e) { await this.usage.release(this.provider, source.size); if (e?.code === 11000) throw new MigrationError("MIGRATION_DUPLICATE_REFUSED", `Asset ${entry.sourceAssetId} is already being stored.`); throw e; }
    // 6 store
    try {
      await receiveStream({ store: this.store, key }, { fileName: name, type: entry.plannedType, length: source.size }, source.open(), { maxBytes: this.maxBytes, types: MIGRATION_TYPES, sha256: source.sha256 });
      if (this.faults?.crashAfterStore === entry.sourceAssetId) throw Object.assign(new Error("Simulated crash after storing the bytes"), { simulatedCrash: true });
      const st = await this.store.stat(key);
      if (!st || st.size !== source.size || (st.sha256 && st.sha256 !== source.sha256)) throw new MigrationError("MIGRATION_ATTACHMENT_VERIFY", `Asset ${entry.sourceAssetId} did not read back as stored.`);
    } catch (error) {
      if (error.simulatedCrash) throw error; // leave everything as a real crash would: the next run's recovery cleans it
      await this.fail(doc, error);
      throw error instanceof MigrationError ? error : new MigrationError("MIGRATION_ATTACHMENT_FAILED", `Asset ${entry.sourceAssetId} could not be stored (${error.code || error.name}).`);
    }
    // 7 complete + 8 verify
    await this.complete(doc);
    return { status: "stored", id: entry._id };
  }

  async complete(doc, { alreadyReady = false } = {}) {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        if (!alreadyReady) {
          const r = await this.col("attachments").updateOne({ _id: doc._id, status: "pending" }, { $set: { status: "ready", readyAt: this.now() } }, { session });
          if (r.matchedCount !== 1) throw new MigrationError("MIGRATION_ATTACHMENT_STATE", "The attachment is no longer pending.");
          await this.col("storageUsage").updateOne({ _id: this.provider }, { $inc: { reservedBytes: -doc.size, usedBytes: doc.size } }, { session });
        }
        await this.col("integrationMappings").insertOne({ provider: MAPPING_PROVIDER, kind: "asset", sourceId: doc.imported.sourceAssetId, targetId: doc._id, boardId: doc.boardId, runId: this.plan.runId, createdAt: this.now() }, { session });
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } finally { await session.endSession(); }
    const ready = await this.col("attachments").findOne({ _id: doc._id, status: "ready", recordId: doc.recordId, columnKey: doc.columnKey });
    if (!ready) throw new MigrationError("MIGRATION_ATTACHMENT_VERIFY", "The attachment is not listed on its record after completion.");
  }
  async fail(doc, error) {
    await this.store.delete(this.storage.keyOf(doc)).catch(() => {});
    const r = await this.col("attachments").updateOne({ _id: doc._id, status: "pending" }, { $set: { status: "failed", failure: { code: String(error.code || error.name).slice(0, 60), at: this.now() } } });
    if (r.matchedCount === 1) await this.usage.release(this.provider, doc.size);
  }
  // Leftovers of an interrupted attempt: the (possibly partial) object, then the document; a pending one still holds
  // a reservation, a failed one already gave it back.
  async cleanup(doc) {
    await this.storage.forAttachment(doc).delete(this.storage.keyOf(doc)).catch(() => {});
    const r = await this.col("attachments").deleteOne({ _id: doc._id, status: { $in: ["pending", "failed"] } });
    if (r.deletedCount === 1 && doc.status === "pending") await this.usage.release(this.storage.providerOf(doc), doc.size);
  }
}

module.exports = { AttachmentImporter };
