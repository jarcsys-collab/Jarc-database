// Small helpers shared by the resource services.
const { ApiError } = require("../middleware/errors");
const { redact } = require("../db/connection");

const notFound = (what) => new ApiError(404, "NOT_FOUND", `This ${what} doesn't exist or was deleted.`);
const conflict = (what, current) => new ApiError(409, "CONFLICT", `This ${what} was changed by someone else. Reload it and try again.`, { currentVersion: current.version });

// After a versioned update or delete matched nothing: 404 if the document is gone, otherwise 409 (stale version).
async function missingOrStale(repository, id, what) {
  const current = await repository.findById(id);
  return current ? conflict(what, current) : notFound(what);
}

function activityEntry({ workspaceId, boardId = null, recordId = null, actorUserId, action, entityType, entityId, changes = [], summary = "", now }) {
  return { workspaceId, boardId, recordId, actorUserId, action, entityType, entityId, changes, summary, createdAt: now };
}

// Activity is history, not the source of truth: outside a transaction, a failure to append it is logged and the
// (already saved) change still succeeds.
async function appendActivity(activities, logger, entry) {
  try { await activities.append(entry); }
  catch (error) { logger.error(`[activity] could not record ${entry.action}: ${error?.name || "Error"} ${redact(error?.message || "")}`); }
}

// The scoped sweep after a cascade commit is a safety net for children created concurrently. The delete itself has
// already committed, so a failing sweep is logged and does not turn a successful delete into an error.
async function sweepAfterCommit(logger, what, fn) {
  try { return await fn(); }
  catch (error) { logger.error(`[cascade] post-commit sweep for ${what} failed: ${error?.name || "Error"} ${redact(error?.message || "")}`); return 0; }
}

// Field-level changes between two plain documents, for activity entries.
function fieldChanges(before, after, fields) {
  return fields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field])).map((field) => ({ field, from: before[field] ?? null, to: after[field] ?? null }));
}

module.exports = { notFound, conflict, missingOrStale, activityEntry, appendActivity, fieldChanges, sweepAfterCommit };
