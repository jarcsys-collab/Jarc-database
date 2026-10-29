// monday.com → JARC one-time migration engine (Phase M2). Stages, each in its own module:
//   source.js     load + verify the private extraction (checksums, completeness, shapes)
//   identity.js   source authors → historical attribution; verified mappings only
//   columns.js    explicit per-column decisions and cell conversion
//   transform.js  destination documents (the plan), deterministic
//   validate.js   JARC rules, relationships, counts, attachments; plan digest
//   executor.js   the future write path — LOCKED in this phase
//   report.js     private machine-readable and Markdown reports
// dryRun() never opens a database connection and never makes a network request.
const { loadExtraction } = require("./source");
const { buildPlan } = require("./transform");
const { validatePlan, planDigest } = require("./validate");

function dryRun(extractionDir, { decisions, confirmedUsers = null } = {}) {
  const source = loadExtraction(extractionDir);
  const plan = buildPlan(source, { decisions, confirmedUsers });
  const validation = validatePlan(plan, source);
  return { source, plan, validation, digest: planDigest(plan) };
}

module.exports = { dryRun };
