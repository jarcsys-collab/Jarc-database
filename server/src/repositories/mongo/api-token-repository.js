// apiTokens and apiTokenAudit collections. A token document holds its public ID and keyed digest, never the token itself
// (auth/api-token.js). Revoked and expired tokens are kept as the record of what existed. Audit entries hold IDs, the action
// and a short reason; never token values, cookies, IP addresses or request contents. Lifecycle entries stay; entries about
// failed or refused use expire after 90 days (they can be frequent).
const { COLLECTIONS } = require("../../db/bootstrap");

const AUDIT_ACTIONS = Object.freeze(["token.created", "token.rotated", "token.revoked", "token.auth_failed", "token.use_refused", "token.rate_limited"]);
const SECURITY_ACTIONS = new Set(["token.auth_failed", "token.use_refused", "token.rate_limited"]);
const SECURITY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// PRODUCTS. Board tokens (every token issued before Fabric Data) have no product field; Fabric Data tokens have product: "fabric"
// (services/api-token-service.js FabricTokenService). Lists, counts, lookups by ID, revoke and rotate are limited to one product,
// the board one by default, so the board token screens and routes behave exactly as before and never see a Fabric token, and the
// Fabric screens see only Fabric tokens. Audit entries about a Fabric token carry product: "fabric" in the same way. Existing
// documents need no migration: a missing product is a board token.
const FABRIC = "fabric";
const ofProduct = (product) => (product === FABRIC ? { product: FABRIC } : { product: { $ne: FABRIC } });

class ApiTokenRepository {
  constructor(db) { this.tokens = db.collection(COLLECTIONS.apiTokens); this.audit = db.collection(COLLECTIONS.apiTokenAudit); }

  async insert(doc, { session } = {}) { await this.tokens.insertOne(doc, { session }); return doc; }
  // Shared by both products: verifying a presented token. Each API then refuses the other product's tokens by their scopes.
  findByPublicId(publicId) { return this.tokens.findOne({ publicId }); }
  findOwned(id, ownerUserId, { product } = {}) { return this.tokens.findOne({ _id: id, ownerUserId, ...ofProduct(product) }); }
  listForOwner(ownerUserId, { limit = 100, product } = {}) { return this.tokens.find({ ownerUserId, ...ofProduct(product) }, { sort: { createdAt: -1, _id: -1 }, limit }).toArray(); }
  countActive(ownerUserId, now, { product } = {}) { return this.tokens.countDocuments({ ownerUserId, revokedAt: null, expiresAt: { $gt: now }, ...ofProduct(product) }); }
  // Any owner's tokens, newest first (API administrators). The service describes them field by field and never returns the digest.
  findById(id, { product } = {}) { return this.tokens.findOne({ _id: id, ...ofProduct(product) }); }
  listAll({ limit = 500, product } = {}) { return this.tokens.find(ofProduct(product), { sort: { createdAt: -1, _id: -1 }, limit }).toArray(); }
  findManyByIds(ids) { return ids.length ? this.tokens.find({ _id: { $in: ids } }).toArray() : Promise.resolve([]); }

  // Null when it was already revoked or isn't this person's.
  revoke(id, ownerUserId, now, { session, product } = {}) {
    return this.tokens.findOneAndUpdate({ _id: id, ownerUserId, revokedAt: null, ...ofProduct(product) }, { $set: { revokedAt: now } }, { returnDocument: "after", session });
  }
  // Any owner's token, by an API administrator, who is recorded on it. Null when it was already revoked or doesn't exist.
  revokeAny(id, byUserId, now, { session, product } = {}) {
    return this.tokens.findOneAndUpdate({ _id: id, revokedAt: null, ...ofProduct(product) }, { $set: { revokedAt: now, revokedByUserId: byUserId } }, { returnDocument: "after", session });
  }
  // The newest audit entries, for API Activity. They hold IDs, the action and a short reason only.
  listAudit({ limit = 200, product } = {}) { return this.audit.find(ofProduct(product), { sort: { at: -1, _id: -1 }, limit }).toArray(); }

  // Marks a token as replaced, once only. Null when it was revoked or rotated meanwhile. Board tokens only (Fabric tokens aren't rotated).
  markRotated(id, ownerUserId, set, { session } = {}) {
    return this.tokens.findOneAndUpdate({ _id: id, ownerUserId, revokedAt: null, rotatedToId: null, ...ofProduct() }, { $set: set }, { returnDocument: "after", session });
  }

  async recordUse(id, at, requests) { await this.tokens.updateOne({ _id: id }, { $set: { lastUsedAt: at }, $inc: { requestCount: requests } }); }

  // workspaceIds: only for a token covering several workspaces (workspaceId is then the first of them).
  // product: "fabric" for an entry about a Fabric token; a board token's entry is stored exactly as before.
  async appendAudit({ action, tokenId = null, ownerUserId = null, actorUserId = null, actorName = null, workspaceId = null, workspaceIds = null, reason = null, at = new Date(), product = null }, { session } = {}) {
    if (!AUDIT_ACTIONS.includes(action)) throw new TypeError(`Unknown API token audit action: ${action}`);
    const doc = { action, tokenId, ownerUserId, actorUserId, actorName, workspaceId, ...(Array.isArray(workspaceIds) && workspaceIds.length > 1 ? { workspaceIds } : {}), ...(reason ? { reason } : {}), ...(product === FABRIC ? { product: FABRIC } : {}), at, ...(SECURITY_ACTIONS.has(action) ? { expiresAt: new Date(at.getTime() + SECURITY_RETENTION_MS) } : {}) };
    await this.audit.insertOne(doc, { session });
    return doc;
  }
}

module.exports = { ApiTokenRepository, AUDIT_ACTIONS, FABRIC_PRODUCT: FABRIC };
