// Attachment stage of the monday.com migration (Phase M4.1), for the LOCAL migration tool: stores ONE planned file
// (plan.attachments entry) safely. No HTTP route reaches this: it runs only from the migration tool, against a verified
// target, with a separately approved attachment-stage approval — the only way a file over 10 MB can enter JARC from this
// tool (the upload API stays at 10 MB).
//
// The eight-step sequence itself (destination, source, recovery, reserve, pending, store, complete, verify) lives in
// files/migration-writer.js, which the server's own Machine Installation Database import also uses. This file adds only
// the migration tool's gates, and throws its own MigrationError. Google Drive isn't possible here: the Drive connection
// exists only on the server (services/mid-attachment-run.js).
const { ObjectId } = require("mongodb");
const { AttachmentWriter } = require("../../files/migration-writer");
const { isVerifiedTarget } = require("./target");
const { isVerifiedProductionTarget } = require("./production-target");
const { checkAuthorization, MigrationError, MigrationLockedError, PRODUCTION_EXECUTION_ENABLED } = require("./executor");

class AttachmentImporter extends AttachmentWriter {
  // storage: an AttachmentStorage; provider: where migrated files go ("s3" or "gridfs").
  constructor({ client, target, plan, planDigest, approval, storage, provider, maxBytes, limitBytes, operator, now = () => new Date(), faults = null }) {
    if (provider === "gdrive") throw new MigrationError("MIGRATION_PROVIDER_UNSUPPORTED", "The local migration tool can't store files in Google Drive; use the server-side run.");
    if (isVerifiedProductionTarget(target) && !PRODUCTION_EXECUTION_ENABLED) throw new MigrationLockedError();
    if (!isVerifiedTarget(target)) throw new MigrationError("MIGRATION_TARGET_UNVERIFIED", "The target was not verified as a permitted database.");
    if (target.scope !== "local-test" && !PRODUCTION_EXECUTION_ENABLED) throw new MigrationLockedError();
    const problems = checkAuthorization(approval, { planDigest, plan, target, operator, now: now(), stage: "attachments" });
    if (problems.length) throw new MigrationError("MIGRATION_NOT_AUTHORIZED", `Not authorized: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}`, { problems });
    if (faults && target.scope !== "local-test") throw new MigrationError("MIGRATION_FAULTS_REFUSED", "Fault injection is only possible on a local test target.");
    if (!(maxBytes >= 10 * 1024 * 1024 && maxBytes <= 100 * 1024 * 1024)) throw new MigrationError("MIGRATION_LIMIT_INVALID", "The migration file limit must be between 10 and 100 MB.");
    super({ client, db: client.db(target.dbName), runId: plan.runId, storage, provider, maxBytes, limitBytes, workspaceId: new ObjectId(approval.targetWorkspaceId), now, faults, Err: MigrationError });
    this.plan = plan;
  }
}

module.exports = { AttachmentImporter, AttachmentWriter };
