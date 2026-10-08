// DEVELOPMENT migration: imports a legacy state document or browser backup into MongoDB.
//
//   dry run → validates, builds the plan and returns the report (counts, warnings, skipped items); writes nothing.
//   commit  → the same checks, then every document is inserted in ONE transaction: all or nothing. If anything fails
//             the transaction aborts and the database is unchanged.
//
// Idempotent by legacy ID: a workspace whose legacy ID was already imported makes the whole import return
// 409 CONFLICT ("already imported") before anything is written; the unique index on workspaces.legacyId also stops a
// concurrent duplicate inside the transaction.
const { buildImportPlan } = require("../migration/legacy-import");
const { ApiError } = require("../middleware/errors");

const BATCH = 1000;

class ImportService {
  constructor({ repos, connection }) { Object.assign(this, { repos, connection }); }

  async run(input, { dryRun, actor }) {
    const plan = buildImportPlan(input, { actorId: actor.userId });
    await this.assertNotImported(plan.report.legacyIds.workspaces);
    if (dryRun) return { dryRun: true, report: plan.report };
    try {
      await this.connection.withTransaction(async (session) => {
        await this.assertNotImported(plan.report.legacyIds.workspaces, { session });
        await this.repos.workspaces.insertMany(plan.workspaces, { session });
        await this.repos.memberships.insertMany(plan.memberships, { session });
        await this.repos.boards.insertMany(plan.boards, { session });
        for (let i = 0; i < plan.records.length; i += BATCH) await this.repos.records.insertMany(plan.records.slice(i, i + BATCH), { session });
        for (let i = 0; i < plan.activities.length; i += BATCH) await this.repos.activities.appendMany(plan.activities.slice(i, i + BATCH), { session });
      });
    } catch (error) {
      if (error?.code === 11000) throw alreadyImported([]);
      throw error;
    }
    return { dryRun: false, importId: plan.importId, report: plan.report };
  }

  async assertNotImported(legacyIds, options) {
    const existing = await this.repos.workspaces.existingLegacyIds(legacyIds, options);
    if (existing.length) throw alreadyImported(existing);
  }
}

function alreadyImported(legacyIds) {
  return new ApiError(409, "CONFLICT", "This data was already imported. Nothing was changed.", { alreadyImported: legacyIds });
}

module.exports = { ImportService };
