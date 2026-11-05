// apiTokens and apiTokenAudit collections. A token document holds its public ID and keyed digest, never the token itself
// (auth/api-token.js). Revoked and expired tokens are kept as the record of what existed. Audit entries hold IDs, the action
// and a short reason; never token values, cookies, IP addresses or request contents. Lifecycle entries stay; entries about
// failed or refused use expire after 90 days (they can be frequent).
const { COLLECTIONS } = require("../../db/bootstrap");

const AUDIT_ACTIONS = Object.freeze(["token.created", "token.rotated", "token.revoked", "token.auth_failed", "token.use_refused", "token.rate_limited"]);
const SECURITY_ACTIONS = new Set(["token.auth_failed", "token.use_refused", "token.rate_limited"]);
const SECURITY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

class ApiTokenRepository {
  constructor(db) { this.tokens = db.collection(COLLECTIONS.apiTokens); this.audit = db.collection(COLLECTIONS.apiTokenAudit); }

  async insert(doc, { session } = {}) { await this.tokens.insertOne(doc, { session }); return doc; }
  findByPublicId(publicId) { return this.tokens.findOne({ publicId }); }
  findOwned(id, ownerUserId) { return this.tokens.findOne({ _id: id, ownerUserId }); }
  listForOwner(ownerUserId, { limit = 100 } = {}) { return this.tokens.find({ ownerUserId }, { sort: { createdAt: -1, _id: -1 }, limit }).toArray(); }
  countActive(ownerUserId, now) { return this.tokens.countDocuments({ ownerUserId, revokedAt: null, expiresAt: { $gt: now } }); }

  // Null when it was already revoked or isn't this person's.
  revoke(id, ownerUserId, now, { session } = {}) {
    return this.tokens.findOneAndUpdate({ _id: id, ownerUserId, revokedAt: null }, { $set: { revokedAt: now } }, { returnDocument: "after", session });
  }

  // Marks a token as replaced, once only. Null when it was revoked or rotated meanwhile.
  markRotated(id, ownerUserId, set, { session } = {}) {
    return this.tokens.findOneAndUpdate({ _id: id, ownerUserId, revokedAt: null, rotatedToId: null }, { $set: set }, { returnDocument: "after", session });
  }

  async recordUse(id, at, requests) { await this.tokens.updateOne({ _id: id }, { $set: { lastUsedAt: at }, $inc: { requestCount: requests } }); }

  async appendAudit({ action, tokenId = null, ownerUserId = null, actorUserId = null, actorName = null, workspaceId = null, reason = null, at = new Date() }, { session } = {}) {
    if (!AUDIT_ACTIONS.includes(action)) throw new TypeError(`Unknown API token audit action: ${action}`);
    const doc = { action, tokenId, ownerUserId, actorUserId, actorName, workspaceId, ...(reason ? { reason } : {}), at, ...(SECURITY_ACTIONS.has(action) ? { expiresAt: new Date(at.getTime() + SECURITY_RETENTION_MS) } : {}) };
    await this.audit.insertOne(doc, { session });
    return doc;
  }
}

module.exports = { ApiTokenRepository, AUDIT_ACTIONS };
