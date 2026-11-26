// accountAudit collection (Phase M4.3): an append-only history of account changes — creation, sign-ins, approval,
// role changes, workspace access changes, blocking and reactivation — with who did it, when, and the previous and new
// values. Entries are never updated or deleted by JARC. They hold IDs, role and status names and a display-name
// snapshot of the administrator; never tokens, cookies, session IDs, IP addresses or device details.
const { COLLECTIONS } = require("../../db/bootstrap");

const ACCOUNT_ACTIONS = ["account.created", "account.signed_in", "account.approved", "account.role_changed", "account.blocked", "account.reactivated", "account.workspace_assigned", "account.workspace_role_changed", "account.workspace_removed", "account.super_admin_bootstrapped"];
// Employee Management P3 (Access Administration, employees/access-admin.js): the owner's account and membership actions, and
// every refused P3 write (employee.access.rejected).
const EMPLOYEE_ACTIONS = Object.freeze(["employee.access.granted", "employee.access.provisioned", "employee.access.suspended", "employee.access.restored", "employee.access.revoked", "employee.membership.added", "employee.membership.role_changed", "employee.membership.removed", "employee.access.rejected"]);
const ACTIONS = Object.freeze([...ACCOUNT_ACTIONS, ...EMPLOYEE_ACTIONS]);
// The P3 fields, each checked here (allow-listed values only), so no request body can reach the collection:
//   result     "ok" | "rejected"
//   reason     the administrator's reason text (at most 500 characters, no control characters)
//   code       a rejection code (A–Z and "_")
//   source     "employee_management"
//   targetRef  the opaque directory profile ID (employees/ids.js), for someone who may not have a users document yet
//   attempted  the action that was refused (grant | suspend | restore | revoke | membership_add | membership_role | membership_remove)
const ATTEMPTS = Object.freeze(["grant", "suspend", "restore", "revoke", "membership_add", "membership_role", "membership_remove"]);
const P3_FIELDS = Object.freeze({
  result: (v) => v === "ok" || v === "rejected",
  reason: (v) => typeof v === "string" && v.length >= 1 && v.length <= 500 && !/[\u0000-\u001f\u007f]/.test(v),
  code: (v) => typeof v === "string" && /^[A-Z_]{1,40}$/.test(v),
  source: (v) => v === "employee_management",
  targetRef: (v) => typeof v === "string" && /^[A-Za-z0-9_-]{22}$/.test(v),
  attempted: (v) => ATTEMPTS.includes(v)
});

class AccountAuditRepository {
  constructor(db) { this.collection = db.collection(COLLECTIONS.accountAudit); }

  // changes: [{ field, from, to }]; actorUserId null for the person's own sign-in. extra: the P3 fields above (an invalid value
  // is a programming error and throws; nothing else is stored).
  async append({ action, targetUserId, actorUserId = null, actorName = null, changes = [], workspaceId = null, at = new Date(), ...extra }, { session } = {}) {
    if (!ACTIONS.includes(action)) throw new TypeError(`Unknown account audit action: ${action}`);
    const fields = {};
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null) continue;
      if (!Object.hasOwn(P3_FIELDS, k) || !P3_FIELDS[k](v)) throw new TypeError(`Account audit field not allowed: ${String(k).slice(0, 40)}`);
      fields[k] = v;
    }
    const doc = { action, targetUserId, actorUserId, actorName, changes, ...(workspaceId ? { workspaceId } : {}), ...fields, at };
    await this.collection.insertOne(doc, { session });
    return doc;
  }

  // P3 history (Employee Management): one person's entries, newest first, keyset-paged on (at, _id). targetUserId (null for
  // someone never registered) or targetRef (their profile ID: entries written before a users document existed). Sign-ins are
  // left out. before: { at: Date, id: ObjectId } from the previous page's last entry.
  listForTarget({ targetUserId = null, targetRef = null, before = null, limit = 50 }) {
    const who = [...(targetUserId ? [{ targetUserId }] : []), ...(targetRef ? [{ targetRef }] : [])];
    if (!who.length) throw new Error("listForTarget needs targetUserId or targetRef.");
    const and = [{ $or: who }, { action: { $ne: "account.signed_in" } }];
    if (before) and.push({ $or: [{ at: { $lt: before.at } }, { at: before.at, _id: { $lt: before.id } }] });
    return this.collection.find({ $and: and }, { sort: { at: -1, _id: -1 }, limit: Math.min(Math.max(1, limit), 101) }).toArray();
  }

  // Newest first. Sign-ins are left out unless asked for (they are frequent and say little).
  listForUser(targetUserId, { limit = 100, signIns = false } = {}) {
    const filter = signIns ? { targetUserId } : { targetUserId, action: { $ne: "account.signed_in" } };
    return this.collection.find(filter, { sort: { at: -1 }, limit }).toArray();
  }
}

module.exports = { AccountAuditRepository, ACTIONS, EMPLOYEE_ACTIONS, ATTEMPTS };
