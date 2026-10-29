// accountAudit collection (Phase M4.3): an append-only history of account changes — creation, sign-ins, approval,
// role changes, workspace access changes, blocking and reactivation — with who did it, when, and the previous and new
// values. Entries are never updated or deleted by JARC. They hold IDs, role and status names and a display-name
// snapshot of the administrator; never tokens, cookies, session IDs, IP addresses or device details.
const { COLLECTIONS } = require("../../db/bootstrap");

const ACTIONS = Object.freeze(["account.created", "account.signed_in", "account.approved", "account.role_changed", "account.blocked", "account.reactivated", "account.workspace_assigned", "account.workspace_role_changed", "account.workspace_removed", "account.super_admin_bootstrapped"]);

class AccountAuditRepository {
  constructor(db) { this.collection = db.collection(COLLECTIONS.accountAudit); }

  // changes: [{ field, from, to }]; actorUserId null for the person's own sign-in.
  async append({ action, targetUserId, actorUserId = null, actorName = null, changes = [], workspaceId = null, at = new Date() }, { session } = {}) {
    if (!ACTIONS.includes(action)) throw new TypeError(`Unknown account audit action: ${action}`);
    const doc = { action, targetUserId, actorUserId, actorName, changes, ...(workspaceId ? { workspaceId } : {}), at };
    await this.collection.insertOne(doc, { session });
    return doc;
  }

  // Newest first. Sign-ins are left out unless asked for (they are frequent and say little).
  listForUser(targetUserId, { limit = 100, signIns = false } = {}) {
    const filter = signIns ? { targetUserId } : { targetUserId, action: { $ne: "account.signed_in" } };
    return this.collection.find(filter, { sort: { at: -1 }, limit }).toArray();
  }
}

module.exports = { AccountAuditRepository, ACTIONS };
