// JARC API tokens: who may issue them, what they may reach, and whether one may be used right now.
//
// A token never carries authority of its own. It is a narrowing of its owner's CURRENT access: one workspace, a chosen list of
// boards, read-only. Every request checks the token and then the owner, so disabling or blocking the person, or removing their
// membership, stops the token on its very next use.
//
// Authority comes from the stored person (an active user of the configured tenant, not blocked) and their access to the token's
// workspace, worked out the same way as for the app's own workspace list (roleOf):
//   - a real workspace membership (Access with membershipOnly), capped by the account role when ACCOUNT_MANAGEMENT=enforced; or
//   - SHARED ORGANIZATIONAL ACCESS: while open access is in effect (ACCESS_POLICY=development_shared or JARC_BETA_OPEN_EDITING, and
//     accounts not enforced), every workspace is shared with every signed-in employee, so each of them has read access (VIEWER)
//     for tokens in every workspace, including boards other employees created or imported. This is exactly what their session
//     already reads. It is evaluated on every use and never stored: switching open access off (role_based, or enforced accounts)
//     leaves memberships deciding again, and a token whose owner has no membership stops on its next request.
// The JARC.Admin app role and the Super Admin account role add nothing here (they exist only in a session, which a token outlives).
//
//   create or rotate  read access to the token's workspace (VIEWER or above, as above), and only your own tokens. A read-only token
//                     never reads more than its owner already can, so admin rights aren't needed.
//   revoke            only your own tokens, whatever your role now: it only ever removes access
//   use               read access to the token's workspace, right now (a read-only token is never more than a VIEWER can do)
// The boards are always chosen explicitly and checked against the workspace: a token never grows to cover a board created after
// it, and seeing a board in the app doesn't add it to an existing token.
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { Access } = require("../auth/access");
const { accountOf } = require("../auth/accounts");
const { allowOnly, parseId, requireBody, text, fail } = require("../validation/common");
const { generateToken, digestOf, publicIdOf, sameDigest, displayPrefix } = require("../auth/api-token");
const { hex, iso } = require("../api/serialize");

const SCOPES = Object.freeze(["read"]);
// The least real membership that may issue a read-only token.
const ISSUER_ROLE = "VIEWER";
const LIMITS = Object.freeze({ boardsPerToken: 100, activePerOwner: 25, maxLifetimeDays: 366, maxGraceHours: 168, defaultGraceHours: 24 });
const DAY_MS = 24 * 60 * 60 * 1000;
const USE_RECORD_INTERVAL_MS = 60 * 1000;
const AUDIT_THROTTLE_MS = 10 * 60 * 1000;

const invalidToken = () => new ApiError(401, "INVALID_TOKEN", "This API token isn't valid.");
const conflict = (code, message) => new ApiError(409, code, message);

class ApiTokenService {
  constructor({ repos, connection, logger }) {
    this.repos = repos; this.connection = connection; this.logger = logger; this.key = null; this.access = null; this.tenantId = null;
    this.uses = new Map(); this.audited = new Map();
  }

  // Attached when the routes are mounted, like Account Management: the access rules and the key come from the app's settings.
  configure({ key, access, tenantId, maxActive = LIMITS.activePerOwner }) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("API tokens need a 32-byte key.");
    if (!(access instanceof Access)) throw new Error("API tokens need the access rules.");
    Object.defineProperty(this, "key", { value: key, enumerable: false, writable: true });
    this.access = access; this.tenantId = tenantId; this.maxActive = maxActive;
    return this;
  }

  // ---- Authority
  // The stored person as an actor, or null when they may not hold or use tokens. Never takes anything from a session.
  async ownerActor(userId) {
    const user = await this.repos.users.findById(userId);
    if (!user || user.status !== "active" || user.tenantId !== this.tenantId) return null;
    const account = this.access.accountMode === "off" ? null : accountOf(user);
    if (account && !account.legacy && account.status === "blocked") return null;
    return Object.freeze({ userId: user._id, kind: "api_token_owner", isSystemAdmin: false, account, displayName: user.displayName || user.email || null });
  }
  // A real membership role, or VIEWER through shared organizational access (open access in effect), or null.
  async roleOf(actor, workspaceId) { return (await this.access.roleIn(actor, workspaceId, { membershipOnly: true })) || this.sharedRole(); }
  sharedRole() { return this.access.shared ? ISSUER_ROLE : null; }

  // The right to create or rotate a token here. Someone who can't see the workspace at all can't tell whether it exists,
  // unless it's named by a token of their own (ownToken).
  async requireIssuer(sessionActor, workspaceId, { ownToken = false } = {}) {
    const actor = await this.ownerActor(sessionActor.userId);
    if (!actor) throw new ApiError(403, "FORBIDDEN", "Your JARC account can't manage API tokens.");
    const role = await this.roleOf(actor, workspaceId);
    if (!role && !ownToken && !await this.access.roleIn(sessionActor, workspaceId)) throw new ApiError(404, "NOT_FOUND", "This workspace doesn't exist or you don't have access to it.");
    if (!Access.atLeast(role, ISSUER_ROLE)) throw new ApiError(403, "FORBIDDEN", "Only someone with access to this workspace can create or rotate its API tokens: you need your own workspace membership.");
    return actor;
  }

  // ---- Managing tokens (a signed-in session; CSRF is checked by the session middleware)
  // What this person could issue a token for: the workspaces they have read access to (their memberships, or every workspace
  // while shared organizational access is in effect), and those workspaces' current boards, read afresh on every call.
  async options(sessionActor) {
    const actor = await this.ownerActor(sessionActor.userId);
    if (!actor) return { workspaces: [] };
    const roles = new Map((await this.repos.memberships.listForUser(actor.userId)).map((m) => [m.workspaceId.toHexString(), this.access.effective(actor, m.role)]));
    const all = (await this.repos.workspaces.list()).filter((w) => Access.atLeast(roles.get(w._id.toHexString()) || this.sharedRole(), ISSUER_ROLE));
    const workspaces = await Promise.all(all.map(async (w) => ({ id: hex(w._id), name: w.name, archived: Boolean(w.archived), boards: (await this.repos.boards.listByWorkspace(w._id)).map((b) => ({ id: hex(b._id), name: b.name, archived: Boolean(b.archived) })) })));
    return { workspaces };
  }

  parseExpiry(value, now) {
    const at = typeof value === "string" ? new Date(value) : null;
    if (!at || Number.isNaN(at.getTime())) fail("expiresAt must be a date and time.");
    if (at.getTime() <= now.getTime() + 60 * 1000) fail("The expiry date must be in the future.");
    if (at.getTime() > now.getTime() + LIMITS.maxLifetimeDays * DAY_MS) fail(`A token can last at most ${LIMITS.maxLifetimeDays} days.`);
    return at;
  }

  async create(sessionActor, raw) {
    const body = requireBody(raw);
    allowOnly(body, ["name", "workspaceId", "boardIds", "scopes", "expiresAt"], "the token");
    const name = text(body.name, "name", { max: 100, required: true });
    const workspaceId = parseId(body.workspaceId, "workspaceId");
    if (!Array.isArray(body.boardIds) || !body.boardIds.length || body.boardIds.length > LIMITS.boardsPerToken) fail(`boardIds must list 1 to ${LIMITS.boardsPerToken} boards.`);
    const boardIds = [...new Set(body.boardIds.map((id) => parseId(id, "boardIds").toHexString()))].map((id) => new ObjectId(id));
    if (!Array.isArray(body.scopes) || body.scopes.length !== 1 || !SCOPES.includes(body.scopes[0])) fail('scopes must be ["read"]: API tokens are read-only.');
    const now = new Date();
    const expiresAt = this.parseExpiry(body.expiresAt, now);
    const actor = await this.requireIssuer(sessionActor, workspaceId);
    const workspace = await this.repos.workspaces.findById(workspaceId);
    if (!workspace) throw new ApiError(404, "NOT_FOUND", "This workspace doesn't exist or you don't have access to it.");
    const boards = await this.repos.boards.findManyInWorkspace(workspaceId, boardIds);
    if (boards.length !== boardIds.length) fail("A selected board isn't a board of this workspace.");
    if (await this.repos.apiTokens.countActive(actor.userId, now) >= this.maxActive) throw conflict("TOKEN_LIMIT_REACHED", `You can have ${this.maxActive} active tokens. Revoke one you no longer need.`);
    const { doc, token } = this.newDocument({ name, ownerUserId: actor.userId, workspaceId, boardIds, expiresAt, now });
    await this.connection.withTransaction(async (session) => {
      await this.repos.apiTokens.insert(doc, { session });
      await this.repos.apiTokens.appendAudit({ action: "token.created", tokenId: doc._id, ownerUserId: actor.userId, actorUserId: actor.userId, actorName: actor.displayName, workspaceId, at: now }, { session });
    });
    return { token: await this.describe(doc, actor), secret: token };
  }

  newDocument({ name, ownerUserId, workspaceId, boardIds, expiresAt, now, rotatedFromId = null }) {
    const { publicId, token, digest } = generateToken(this.key);
    return { token, doc: { _id: new ObjectId(), publicId, digest, name, ownerUserId, workspaceId, boardIds, scopes: [...SCOPES], createdAt: now, expiresAt, revokedAt: null, lastUsedAt: null, requestCount: 0, rotatedFromId, rotatedToId: null } };
  }

  async list(sessionActor) {
    const actor = await this.ownerActor(sessionActor.userId);
    const docs = await this.repos.apiTokens.listForOwner(sessionActor.userId);
    const roles = new Map();
    await Promise.all([...new Set(docs.map((d) => hex(d.workspaceId)))].map(async (id) => roles.set(id, actor ? await this.roleOf(actor, new ObjectId(id)) : null)));
    return Promise.all(docs.map((doc) => this.describe(doc, actor, roles.get(hex(doc.workspaceId)))));
  }

  // A token's details for its owner: never the digest. Names appear only while the owner still has access.
  async describe(doc, actor, knownRole) {
    const role = knownRole !== undefined ? knownRole : (actor ? await this.roleOf(actor, doc.workspaceId) : null);
    const [workspace, boards] = role ? await Promise.all([this.repos.workspaces.findById(doc.workspaceId), this.repos.boards.findManyInWorkspace(doc.workspaceId, doc.boardIds)]) : [null, []];
    const names = new Map(boards.map((b) => [hex(b._id), b.name]));
    const now = new Date();
    const status = doc.revokedAt ? "revoked" : doc.expiresAt <= now ? "expired" : role ? (doc.rotatedToId ? "rotating" : "active") : "no_access";
    const canRotate = Access.atLeast(role, ISSUER_ROLE);
    return {
      id: hex(doc._id), name: doc.name, prefix: displayPrefix(doc.publicId), status, canRotate, scopes: [...doc.scopes],
      workspace: { id: hex(doc.workspaceId), name: workspace?.name ?? null },
      boards: doc.boardIds.map((id) => ({ id: hex(id), name: names.get(hex(id)) ?? null })),
      createdAt: iso(doc.createdAt), expiresAt: iso(doc.expiresAt), lastUsedAt: iso(doc.lastUsedAt), revokedAt: iso(doc.revokedAt), requestCount: doc.requestCount || 0,
      rotatedFromId: hex(doc.rotatedFromId), rotatedToId: hex(doc.rotatedToId)
    };
  }

  // A new token with the same scope; the old one keeps working for the grace period so its integration can be updated without
  // an outage. No other token is touched. graceHours 0 ends the old one immediately.
  async rotate(sessionActor, tokenId, raw) {
    const body = requireBody(raw ?? {});
    allowOnly(body, ["expiresAt", "graceHours"], "the rotation");
    const graceHours = body.graceHours === undefined ? LIMITS.defaultGraceHours : body.graceHours;
    if (!Number.isInteger(graceHours) || graceHours < 0 || graceHours > LIMITS.maxGraceHours) fail(`graceHours must be a whole number from 0 to ${LIMITS.maxGraceHours}.`);
    const old = await this.repos.apiTokens.findOwned(tokenId, sessionActor.userId);
    if (!old) throw new ApiError(404, "NOT_FOUND", "This token doesn't exist.");
    const now = new Date();
    if (old.revokedAt || old.expiresAt <= now) throw conflict("TOKEN_NOT_ACTIVE", "This token has ended. Create a new one instead.");
    if (old.rotatedToId) throw conflict("TOKEN_ALREADY_ROTATED", "This token was already rotated. Rotate its replacement instead.");
    const actor = await this.requireIssuer(sessionActor, old.workspaceId, { ownToken: true });
    const workspace = await this.repos.workspaces.findById(old.workspaceId);
    if (!workspace) throw new ApiError(404, "NOT_FOUND", "This workspace doesn't exist or you don't have access to it.");
    const boards = await this.repos.boards.findManyInWorkspace(old.workspaceId, old.boardIds);
    if (!boards.length) throw conflict("TOKEN_NO_BOARDS", "None of this token's boards are available any more. Create a new token instead.");
    const lifetime = Math.min(old.expiresAt.getTime() - old.createdAt.getTime(), LIMITS.maxLifetimeDays * DAY_MS);
    const expiresAt = body.expiresAt === undefined ? new Date(now.getTime() + lifetime) : this.parseExpiry(body.expiresAt, now);
    const { doc, token } = this.newDocument({ name: old.name, ownerUserId: actor.userId, workspaceId: old.workspaceId, boardIds: boards.map((b) => b._id), expiresAt, now, rotatedFromId: old._id });
    const graceEnds = new Date(now.getTime() + graceHours * 60 * 60 * 1000);
    const change = { rotatedToId: doc._id, expiresAt: graceEnds < old.expiresAt ? graceEnds : old.expiresAt, ...(graceHours === 0 ? { revokedAt: now } : {}) };
    await this.connection.withTransaction(async (session) => {
      if (!await this.repos.apiTokens.markRotated(old._id, actor.userId, change, { session })) throw conflict("TOKEN_ALREADY_ROTATED", "This token was already rotated or revoked.");
      await this.repos.apiTokens.insert(doc, { session });
      await this.repos.apiTokens.appendAudit({ action: "token.rotated", tokenId: old._id, ownerUserId: actor.userId, actorUserId: actor.userId, actorName: actor.displayName, workspaceId: old.workspaceId, at: now }, { session });
    });
    return { token: await this.describe(doc, actor), secret: token, previous: await this.describe({ ...old, ...change }, actor) };
  }

  // The owner may always end their own token, whatever their role is now and even with no membership left: it only ever removes
  // access. The signed-in session has already proved the account is active. Repeating it changes nothing.
  async revoke(sessionActor, tokenId) {
    const now = new Date();
    const revoked = await this.repos.apiTokens.revoke(tokenId, sessionActor.userId, now);
    if (revoked) await this.repos.apiTokens.appendAudit({ action: "token.revoked", tokenId, ownerUserId: sessionActor.userId, actorUserId: sessionActor.userId, actorName: sessionActor.displayName ?? null, workspaceId: revoked.workspaceId, at: now });
    const doc = revoked || await this.repos.apiTokens.findOwned(tokenId, sessionActor.userId);
    if (!doc) throw new ApiError(404, "NOT_FOUND", "This token doesn't exist.");
    return { token: await this.describe(doc, await this.ownerActor(sessionActor.userId)) };
  }

  // ---- Using a token
  // The token text → its document, or a refusal. Only someone holding the right secret learns that a token was revoked or expired.
  async verify(token) {
    const publicId = publicIdOf(token);
    if (!publicId) throw invalidToken();
    const doc = await this.repos.apiTokens.findByPublicId(publicId);
    const digest = digestOf(this.key, token); // worked out whether or not the document exists
    if (!doc || !sameDigest(doc.digest, digest)) {
      if (doc) this.auditOnce(doc, "token.auth_failed", "wrong secret");
      throw invalidToken();
    }
    const now = new Date();
    if (doc.revokedAt) { this.auditOnce(doc, "token.use_refused", "revoked"); throw new ApiError(401, "TOKEN_REVOKED", "This API token has been revoked."); }
    if (doc.expiresAt <= now) { this.auditOnce(doc, "token.use_refused", "expired"); throw new ApiError(401, "TOKEN_EXPIRED", "This API token has expired. Create or rotate a token in JARC."); }
    return doc;
  }

  // The owner's access right now. A separate step so rate limiting can come first.
  async authorize(doc) {
    if (!doc.scopes.includes("read")) throw new ApiError(403, "INSUFFICIENT_SCOPE", "This API token doesn't allow reading.");
    const actor = await this.ownerActor(doc.ownerUserId);
    if (!actor) { this.auditOnce(doc, "token.use_refused", "owner disabled"); throw new ApiError(403, "TOKEN_OWNER_DISABLED", "The person who created this API token can no longer use JARC."); }
    const role = await this.roleOf(actor, doc.workspaceId);
    if (!role) { this.auditOnce(doc, "token.use_refused", "owner lost access"); throw new ApiError(403, "TOKEN_ACCESS_REVOKED", "The person who created this API token no longer has access to its workspace."); }
    return { actor, role };
  }

  // lastUsedAt and a request count, at most once a minute per token. Failing to record it never fails the request.
  async recordUse(doc, now = new Date()) {
    const key = doc.publicId, use = this.uses.get(key) || { pending: 0, savedAt: 0 };
    use.pending += 1;
    this.uses.set(key, use);
    if (now.getTime() - use.savedAt < USE_RECORD_INTERVAL_MS) return;
    const requests = use.pending;
    use.pending = 0; use.savedAt = now.getTime();
    if (this.uses.size > 5000) this.uses.clear();
    try { await this.repos.apiTokens.recordUse(doc._id, now, requests); }
    catch (error) { this.logger?.error?.(`[api-tokens] couldn't record token use: ${error.name}`); }
  }

  // Refused or failed use, at most one entry per token and reason in 10 minutes, so that a misconfigured client can't fill the log.
  auditOnce(doc, action, reason) {
    const key = `${doc.publicId}:${action}:${reason}`, now = Date.now();
    if (now - (this.audited.get(key) || 0) < AUDIT_THROTTLE_MS) return;
    this.audited.set(key, now);
    if (this.audited.size > 5000) this.audited.clear();
    this.repos.apiTokens.appendAudit({ action, tokenId: doc._id, ownerUserId: doc.ownerUserId, workspaceId: doc.workspaceId, reason }).catch((error) => this.logger?.error?.(`[api-tokens] couldn't record an audit entry: ${error.name}`));
  }
}

module.exports = { ApiTokenService, SCOPES, LIMITS, ISSUER_ROLE };
