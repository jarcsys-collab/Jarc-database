// JARC API tokens: who may issue them, what they may reach, and whether one may be used right now.
//
// A token never carries authority of its own. It is a narrowing of its owner's CURRENT access: a chosen list of boards, from one
// workspace or several (see SCOPE below), read-only. Every request checks the token and then the owner, so disabling or blocking the person, or removing their
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
// MANAGING tokens is a separate right from reading boards: only the JARC API ADMINISTRATORS may do it, the Microsoft Entra object
// IDs in JARC_API_ADMIN_OIDS within this tenant, matched against the identity verified at sign-in (isAdmin). Open access, workspace
// roles and JARC.Admin never grant it, so every employee keeps seeing every shared board while only these people handle tokens.
// An empty list means nobody (fails closed). Everyone else gets 403 API_ADMIN_REQUIRED from every route below.
//
//   list              API administrators: every owner's tokens (never a digest or a secret)
//   create or rotate  API administrators, with read access to the token's workspace (VIEWER or above, as above: every shared
//                     workspace, whoever created or imported its boards); rotate only your own tokens. A read-only token never
//                     reads more than its owner already can.
//   revoke            API administrators, anyone's token; the administrator who did it is recorded on the token and in the audit
//   activity          API administrators: the audit entries (created, rotated, revoked, refused use)
//   use               read access to the token's workspace, right now (a read-only token is never more than a VIEWER can do). It
//                     doesn't depend on the owner still being an API administrator: existing tokens keep working until revoked.
// The boards are always chosen explicitly and checked against the workspace: a token never grows to cover a board created after
// it, and seeing a board in the app doesn't add it to an existing token.
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { Access } = require("../auth/access");
const { accountOf } = require("../auth/accounts");
const { allowOnly, parseId, requireBody, text, fail } = require("../validation/common");
const { generateToken, digestOf, publicIdOf, sameDigest, displayPrefix } = require("../auth/api-token");
const { hex, iso } = require("../api/serialize");
const { FABRIC_PRODUCT } = require("../repositories/mongo/api-token-repository");

const SCOPES = Object.freeze(["read"]);
// The least real membership that may issue a read-only token.
const ISSUER_ROLE = "VIEWER";
// maxLifetimeYears: a token expires at most 5 CALENDAR years after it is created (latestExpiry). Every token expires: there is no
// non-expiring token, and an existing token's expiry is never changed.
const LIMITS = Object.freeze({ boardsPerToken: 100, activePerOwner: 25, maxLifetimeYears: 5, maxGraceHours: 168, defaultGraceHours: 24 });

// The same moment `years` calendar years later, in UTC. A day that doesn't exist that year (29 February) becomes the last day of the
// month (28 February), so the limit never moves into the next month.
function addUtcYears(date, years) {
  const y = date.getUTCFullYear() + years, m = date.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(date.getUTCDate(), lastDay), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
}
const latestExpiry = (createdAt) => addUtcYears(createdAt, LIMITS.maxLifetimeYears);
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const USE_RECORD_INTERVAL_MS = 60 * 1000;
const AUDIT_THROTTLE_MS = 10 * 60 * 1000;

// SCOPE, stored on the token document (additive and backward compatible):
//   one workspace      { workspaceId, boardIds }                       every token issued before multi-workspace scopes, and every
//                                                                      new token whose boards are all in one workspace (unchanged)
//   several workspaces { workspaceId, workspaceIds, boardIds, scopeVersion: 2 }
//                      workspaceIds lists every workspace of the chosen boards, in the order chosen; workspaceId is the first of
//                      them, so code that knows only workspaceId (an older deployment) reaches at most that workspace's boards:
//                      always less than the token was issued for, never more.
// The boards are the authority: a token reads a board only when the board is in boardIds AND is now in one of the token's
// workspaces AND the owner can read that workspace right now. Workspaces come from the stored boards, never from the request.
const workspacesOf = (doc) => (Array.isArray(doc.workspaceIds) && doc.workspaceIds.length ? doc.workspaceIds : [doc.workspaceId]).filter(Boolean);
const scopeFields = (workspaceIds) => (workspaceIds.length > 1 ? { workspaceId: workspaceIds[0], workspaceIds, scopeVersion: 2 } : { workspaceId: workspaceIds[0] });
// The workspaces of these boards, each once, in the order the boards were given.
const workspacesIn = (boardIds, boards) => {
  const where = new Map(boards.map((b) => [hex(b._id), b.workspaceId])), seen = new Map();
  for (const id of boardIds) { const w = where.get(hex(id)); if (w && !seen.has(hex(w))) seen.set(hex(w), w); }
  return [...seen.values()];
};

const invalidToken = () => new ApiError(401, "INVALID_TOKEN", "This API token isn't valid.");
const conflict = (code, message) => new ApiError(409, code, message);

class ApiTokenService {
  constructor({ repos, connection, logger }) {
    this.repos = repos; this.connection = connection; this.logger = logger; this.key = null; this.access = null; this.tenantId = null;
    this.uses = new Map(); this.audited = new Map();
  }

  // Attached when the routes are mounted, like Account Management: the access rules and the key come from the app's settings.
  configure({ key, access, tenantId, adminObjectIds = [], maxActive = LIMITS.activePerOwner }) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("API tokens need a 32-byte key.");
    if (!(access instanceof Access)) throw new Error("API tokens need the access rules.");
    if (!Array.isArray(adminObjectIds) || adminObjectIds.some((id) => typeof id !== "string")) throw new Error("API tokens need the administrators' object IDs as a list.");
    Object.defineProperty(this, "key", { value: key, enumerable: false, writable: true });
    this.access = access; this.tenantId = tenantId; this.maxActive = maxActive;
    this.adminObjectIds = Object.freeze([...new Set(adminObjectIds.map((id) => id.toLowerCase()))]);
    return this;
  }

  // ---- The JARC API administrators
  // A signed-in Microsoft Entra session whose verified tenant is JARC's and whose object ID is listed. Taken only from the session
  // (auth/session.js checks it against the stored user on every request), never from anything the browser sends.
  isAdmin(sessionActor) {
    const lower = (v) => (typeof v === "string" ? v.toLowerCase() : null);
    const tid = lower(sessionActor?.tenantId), oid = lower(sessionActor?.entraObjectId);
    return Boolean(sessionActor?.kind === "entra" && this.tenantId && tid && oid && tid === lower(this.tenantId) && (this.adminObjectIds || []).includes(oid));
  }
  requireAdmin(sessionActor) {
    if (!this.isAdmin(sessionActor)) throw new ApiError(403, "API_ADMIN_REQUIRED", "Only JARC API administrators can manage API tokens.");
  }

  // ---- Authority
  // The stored person as an actor, or null when they may not hold or use tokens. Never takes anything from a session.
  async ownerActor(userId) {
    const owner = await this.ownerRecord(userId);
    if (!owner) return null;
    const { user, account } = owner;
    return Object.freeze({ userId: user._id, kind: "api_token_owner", isSystemAdmin: false, account, displayName: user.displayName || user.email || null });
  }
  // The stored person and their account, when they may hold or use tokens at all (active, this tenant, not blocked), or null.
  async ownerRecord(userId) {
    const user = await this.repos.users.findById(userId);
    if (!user || user.status !== "active" || user.tenantId !== this.tenantId) return null;
    const account = this.access.accountMode === "off" ? null : accountOf(user);
    if (account && !account.legacy && account.status === "blocked") return null;
    return { user, account };
  }
  // A real membership role, or VIEWER through shared organizational access (open access in effect), or null.
  async roleOf(actor, workspaceId) { return (await this.access.roleIn(actor, workspaceId, { membershipOnly: true })) || this.sharedRole(); }
  sharedRole() { return this.access.shared ? ISSUER_ROLE : null; }

  // The right to create or rotate a token here. Someone who can't see the workspace at all can't tell whether it exists,
  // unless it's named by a token of their own (ownToken).
  async requireIssuer(sessionActor, workspaceId, { ownToken = false } = {}) {
    this.requireAdmin(sessionActor);
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
    this.requireAdmin(sessionActor);
    const actor = await this.ownerActor(sessionActor.userId);
    if (!actor) return { workspaces: [] };
    const roles = new Map((await this.repos.memberships.listForUser(actor.userId)).map((m) => [m.workspaceId.toHexString(), this.access.effective(actor, m.role)]));
    const all = (await this.repos.workspaces.list()).filter((w) => Access.atLeast(roles.get(w._id.toHexString()) || this.sharedRole(), ISSUER_ROLE));
    // Only each board's ID, name and archived flag: the columns and views of every board aren't read for a list to choose from.
    const workspaces = await Promise.all(all.map(async (w) => ({ id: hex(w._id), name: w.name, archived: Boolean(w.archived), boards: (await this.repos.boards.listSummariesByWorkspace(w._id)).map((b) => ({ id: hex(b._id), name: b.name, archived: Boolean(b.archived) })) })));
    return { workspaces, limits: { boardsPerToken: LIMITS.boardsPerToken, maxLifetimeYears: LIMITS.maxLifetimeYears } };
  }

  // An ISO 8601 date and time with its offset (as toISOString() writes it), on a calendar date that exists: JavaScript would
  // otherwise read 30 February as 2 March. Compared as an instant, so the offset it was written in doesn't matter.
  parseExpiry(value, now) {
    const parts = typeof value === "string" ? ISO_DATE_TIME.exec(value) : null;
    const at = parts ? new Date(value) : null;
    const [, y, m, d] = parts || [];
    const real = parts && new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).getUTCDate() === Number(d) && Number(m) >= 1 && Number(m) <= 12;
    if (!at || !real || Number.isNaN(at.getTime())) fail("expiresAt must be a date and time, such as 2030-06-30T15:59:59.000Z.");
    if (at.getTime() <= now.getTime() + 60 * 1000) fail("The expiry date must be in the future.");
    if (at.getTime() > latestExpiry(now).getTime()) fail(`A token can last at most ${LIMITS.maxLifetimeYears} years: choose an expiry no later than ${latestExpiry(now).toISOString()}.`);
    return at;
  }

  // { name, description?, boardIds, scopes: ["read"], expiresAt } and, from clients that choose one workspace, workspaceId.
  // With workspaceId every board must be in that workspace (as before). Without it the boards may come from several
  // workspaces: each board is looked up in the database, its workspace is the one it is stored in, and this administrator must
  // be able to issue tokens in every one of them. A board ID that doesn't exist, or that they can't reach, refuses the whole
  // request, and naming a board twice is refused too, so the token holds exactly the boards that were reviewed.
  async create(sessionActor, raw) {
    this.requireAdmin(sessionActor);
    const body = requireBody(raw);
    allowOnly(body, ["name", "description", "workspaceId", "boardIds", "scopes", "expiresAt"], "the token");
    const name = text(body.name, "name", { max: 100, required: true });
    const description = body.description === undefined || body.description === null ? "" : text(body.description, "description", { max: 500 });
    const workspaceId = body.workspaceId === undefined ? null : parseId(body.workspaceId, "workspaceId");
    if (!Array.isArray(body.boardIds) || !body.boardIds.length || body.boardIds.length > LIMITS.boardsPerToken) fail(`boardIds must list 1 to ${LIMITS.boardsPerToken} boards.`);
    const boardIds = body.boardIds.map((id) => parseId(id, "boardIds"));
    if (new Set(boardIds.map(hex)).size !== boardIds.length) fail("boardIds lists the same board more than once.");
    if (!Array.isArray(body.scopes) || body.scopes.length !== 1 || !SCOPES.includes(body.scopes[0])) fail('scopes must be ["read"]: API tokens are read-only.');
    const now = new Date();
    const expiresAt = this.parseExpiry(body.expiresAt, now);
    const { actor, workspaceIds, boards } = workspaceId ? await this.oneWorkspaceScope(sessionActor, workspaceId, boardIds) : await this.boardScope(sessionActor, boardIds);
    if (await this.repos.apiTokens.countActive(actor.userId, now) >= this.maxActive) throw conflict("TOKEN_LIMIT_REACHED", `You can have ${this.maxActive} active tokens. Revoke one you no longer need.`);
    const { doc, token } = this.newDocument({ name, description, ownerUserId: actor.userId, workspaceIds, boardIds: boards, expiresAt, now });
    await this.connection.withTransaction(async (session) => {
      await this.repos.apiTokens.insert(doc, { session });
      await this.repos.apiTokens.appendAudit({ action: "token.created", tokenId: doc._id, ownerUserId: actor.userId, actorUserId: actor.userId, actorName: actor.displayName, workspaceId: doc.workspaceId, workspaceIds: doc.workspaceIds, at: now }, { session });
    });
    return { token: await this.describe(doc, actor), secret: token };
  }

  // One workspace named by the client (the original request shape): every board must be in it.
  async oneWorkspaceScope(sessionActor, workspaceId, boardIds) {
    const actor = await this.requireIssuer(sessionActor, workspaceId);
    const workspace = await this.repos.workspaces.findById(workspaceId);
    if (!workspace) throw new ApiError(404, "NOT_FOUND", "This workspace doesn't exist or you don't have access to it.");
    const boards = await this.repos.boards.findManyInWorkspace(workspaceId, boardIds);
    if (boards.length !== boardIds.length) fail("A selected board isn't a board of this workspace.");
    return { actor, workspaceIds: [workspaceId], boards: boardIds };
  }

  // Boards from anywhere: their workspaces are read from the database. Any board that doesn't exist, or whose workspace this
  // person can't issue tokens for, gets the same answer, so a guessed ID tells them nothing.
  async boardScope(sessionActor, boardIds) {
    this.requireAdmin(sessionActor);
    const actor = await this.ownerActor(sessionActor.userId);
    if (!actor) throw new ApiError(403, "FORBIDDEN", "Your JARC account can't manage API tokens.");
    const boards = await this.repos.boards.findSummariesByIds(boardIds);
    const unreachable = () => fail("A selected board doesn't exist or you can't create tokens for it. Refresh the list and choose again.");
    if (boards.length !== boardIds.length) unreachable();
    const workspaceIds = workspacesIn(boardIds, boards);
    const found = await Promise.all(workspaceIds.map(async (id) => [await this.repos.workspaces.findById(id), await this.roleOf(actor, id)]));
    if (found.some(([workspace, role]) => !workspace || !Access.atLeast(role, ISSUER_ROLE))) unreachable();
    return { actor, workspaceIds, boards: boardIds };
  }

  newDocument({ name, description = "", ownerUserId, workspaceIds, boardIds, expiresAt, now, rotatedFromId = null }) {
    const { publicId, token, digest } = generateToken(this.key);
    return { token, doc: { _id: new ObjectId(), publicId, digest, name, ...(description ? { description } : {}), ownerUserId, ...scopeFields(workspaceIds), boardIds, scopes: [...SCOPES], createdAt: now, expiresAt, revokedAt: null, lastUsedAt: null, requestCount: 0, rotatedFromId, rotatedToId: null } };
  }

  // Every owner's tokens, for an API administrator. Each token's status and names follow its OWNER's current access (that is
  // what the token can reach), and the people involved are named.
  async list(sessionActor) {
    this.requireAdmin(sessionActor);
    const docs = await this.repos.apiTokens.listAll();
    const people = await this.peopleNamed(docs.flatMap((d) => [d.ownerUserId, d.revokedByUserId]));
    const owners = new Map(), roles = new Map();
    await Promise.all([...new Set(docs.map((d) => hex(d.ownerUserId)))].map(async (id) => owners.set(id, await this.ownerActor(new ObjectId(id)))));
    await Promise.all([...new Set(docs.flatMap((d) => workspacesOf(d).map((w) => `${hex(d.ownerUserId)}:${hex(w)}`)))].map(async (key) => {
      const [owner, workspace] = key.split(":"), actor = owners.get(owner);
      roles.set(key, actor ? await this.roleOf(actor, new ObjectId(workspace)) : null);
    }));
    // Every workspace and board named by any token, read once for the whole list (names only).
    const context = await this.scopeContext(docs);
    return Promise.all(docs.map((doc) => this.describe(doc, owners.get(hex(doc.ownerUserId)), new Map(workspacesOf(doc).map((w) => [hex(w), roles.get(`${hex(doc.ownerUserId)}:${hex(w)}`) ?? null])), { viewerUserId: sessionActor.userId, people, context })));
  }

  // The workspaces and boards these tokens name, as they are now: { workspaces: Map(id → doc), boards: Map(id → summary) }.
  async scopeContext(docs) {
    const workspaceIds = [...new Set(docs.flatMap((d) => workspacesOf(d).map(hex)))].map((id) => new ObjectId(id));
    const boardIds = [...new Set(docs.flatMap((d) => (d.boardIds || []).map(hex)))].map((id) => new ObjectId(id));
    const [workspaces, boards] = await Promise.all([Promise.all(workspaceIds.map((id) => this.repos.workspaces.findById(id))), this.repos.boards.findSummariesByIds(boardIds)]);
    return { workspaces: new Map(workspaces.filter(Boolean).map((w) => [hex(w._id), w])), boards: new Map(boards.map((b) => [hex(b._id), b])) };
  }

  // Display names of stored people, by ID (a person no longer stored has none).
  async peopleNamed(ids) {
    const unique = [...new Set(ids.filter(Boolean).map((id) => hex(id)))].map((id) => new ObjectId(id));
    const users = await this.repos.users.findByIds(unique);
    return new Map(users.map((u) => [hex(u._id), u.displayName || u.email || null]));
  }

  // A token's details for an API administrator: never the digest. Workspace and board names appear only while the owner still has
  // access. mine: the viewer owns it (only the owner may rotate it); owner and revokedBy name the people involved.
  // knownRoles: Map(workspace id → the owner's role there, or null), when the caller has worked them out already.
  // workspace is the first (or only) workspace, as before; workspaces lists them all. A board is named, and counted as reachable,
  // only while it is still in one of the token's workspaces and the owner can read that workspace (what the token can read now).
  async describe(doc, actor, knownRoles, { viewerUserId = actor?.userId ?? null, people = null, context = null } = {}) {
    const spaces = workspacesOf(doc);
    const roles = knownRoles instanceof Map ? knownRoles : new Map(await Promise.all(spaces.map(async (w) => [hex(w), actor ? await this.roleOf(actor, w) : null])));
    const readable = spaces.filter((w) => roles.get(hex(w)));
    const ctx = context || await this.scopeContext([doc]);
    const named = people || await this.peopleNamed([doc.ownerUserId, doc.revokedByUserId]);
    const now = new Date();
    const status = doc.revokedAt ? "revoked" : doc.expiresAt <= now ? "expired" : readable.length ? (doc.rotatedToId ? "rotating" : "active") : "no_access";
    const mine = Boolean(viewerUserId && doc.ownerUserId?.equals?.(viewerUserId));
    const canRotate = mine && readable.length === spaces.length && spaces.every((w) => Access.atLeast(roles.get(hex(w)), ISSUER_ROLE));
    const inScope = new Set(spaces.map(hex)), canRead = new Set(readable.map(hex));
    const boardOf = (id) => { const b = ctx.boards.get(hex(id)); return b && inScope.has(hex(b.workspaceId)) && canRead.has(hex(b.workspaceId)) ? b : null; };
    const workspaceName = (id) => (canRead.has(hex(id)) ? ctx.workspaces.get(hex(id))?.name ?? null : null);
    const boards = doc.boardIds.map((id) => { const b = boardOf(id); return { id: hex(id), name: b?.name ?? null, workspaceId: b ? hex(b.workspaceId) : null, archived: Boolean(b?.archived), available: Boolean(b) }; });
    return {
      id: hex(doc._id), name: doc.name, description: doc.description || "", prefix: displayPrefix(doc.publicId), status, canRotate, mine, scopes: [...doc.scopes],
      owner: { id: hex(doc.ownerUserId), name: named.get(hex(doc.ownerUserId)) ?? null },
      workspace: { id: hex(doc.workspaceId), name: workspaceName(doc.workspaceId) },
      workspaces: spaces.map((w) => ({ id: hex(w), name: workspaceName(w), available: canRead.has(hex(w)), boardCount: boards.filter((b) => b.workspaceId === hex(w)).length })),
      boards,
      createdAt: iso(doc.createdAt), expiresAt: iso(doc.expiresAt), lastUsedAt: iso(doc.lastUsedAt), revokedAt: iso(doc.revokedAt), requestCount: doc.requestCount || 0,
      revokedBy: doc.revokedByUserId ? { id: hex(doc.revokedByUserId), name: named.get(hex(doc.revokedByUserId)) ?? null } : null,
      rotatedFromId: hex(doc.rotatedFromId), rotatedToId: hex(doc.rotatedToId)
    };
  }

  // A new token with the same scope; the old one keeps working for the grace period so its integration can be updated without
  // an outage. No other token is touched. graceHours 0 ends the old one immediately.
  async rotate(sessionActor, tokenId, raw) {
    this.requireAdmin(sessionActor);
    const body = requireBody(raw ?? {});
    allowOnly(body, ["expiresAt", "graceHours"], "the rotation");
    const graceHours = body.graceHours === undefined ? LIMITS.defaultGraceHours : body.graceHours;
    if (!Number.isInteger(graceHours) || graceHours < 0 || graceHours > LIMITS.maxGraceHours) fail(`graceHours must be a whole number from 0 to ${LIMITS.maxGraceHours}.`);
    const old = await this.repos.apiTokens.findOwned(tokenId, sessionActor.userId);
    if (!old) throw new ApiError(404, "NOT_FOUND", "This token doesn't exist.");
    const now = new Date();
    if (old.revokedAt || old.expiresAt <= now) throw conflict("TOKEN_NOT_ACTIVE", "This token has ended. Create a new one instead.");
    if (old.rotatedToId) throw conflict("TOKEN_ALREADY_ROTATED", "This token was already rotated. Rotate its replacement instead.");
    // Every workspace of the token is checked, as when it was created; the replacement keeps the boards that are still in them.
    let actor = null;
    for (const w of workspacesOf(old)) {
      actor = await this.requireIssuer(sessionActor, w, { ownToken: true });
      if (!await this.repos.workspaces.findById(w)) throw new ApiError(404, "NOT_FOUND", "This workspace doesn't exist or you don't have access to it.");
    }
    const inScope = new Set(workspacesOf(old).map(hex));
    const current = (await this.repos.boards.findSummariesByIds(old.boardIds)).filter((b) => inScope.has(hex(b.workspaceId)));
    const still = new Set(current.map((b) => hex(b._id)));
    const boards = old.boardIds.filter((id) => still.has(hex(id)));
    if (!boards.length) throw conflict("TOKEN_NO_BOARDS", "None of this token's boards are available any more. Create a new token instead.");
    const lifetime = Math.min(old.expiresAt.getTime() - old.createdAt.getTime(), latestExpiry(now).getTime() - now.getTime());
    const expiresAt = body.expiresAt === undefined ? new Date(now.getTime() + lifetime) : this.parseExpiry(body.expiresAt, now);
    // The workspaces that still hold one of its boards, in the token's own order (never one it didn't have).
    const holding = new Set(current.map((b) => hex(b.workspaceId)));
    const remaining = workspacesOf(old).filter((w) => holding.has(hex(w)));
    const { doc, token } = this.newDocument({ name: old.name, description: old.description || "", ownerUserId: actor.userId, workspaceIds: remaining, boardIds: boards, expiresAt, now, rotatedFromId: old._id });
    const graceEnds = new Date(now.getTime() + graceHours * 60 * 60 * 1000);
    const change = { rotatedToId: doc._id, expiresAt: graceEnds < old.expiresAt ? graceEnds : old.expiresAt, ...(graceHours === 0 ? { revokedAt: now } : {}) };
    await this.connection.withTransaction(async (session) => {
      if (!await this.repos.apiTokens.markRotated(old._id, actor.userId, change, { session })) throw conflict("TOKEN_ALREADY_ROTATED", "This token was already rotated or revoked.");
      await this.repos.apiTokens.insert(doc, { session });
      await this.repos.apiTokens.appendAudit({ action: "token.rotated", tokenId: old._id, ownerUserId: actor.userId, actorUserId: actor.userId, actorName: actor.displayName, workspaceId: old.workspaceId, workspaceIds: old.workspaceIds, at: now }, { session });
    });
    return { token: await this.describe(doc, actor), secret: token, previous: await this.describe({ ...old, ...change }, actor) };
  }

  // An API administrator may end ANY token, whoever owns it and whatever anyone's role is now: it only ever removes access. The
  // administrator is recorded on the token (revokedByUserId) and in the audit, next to the owner. The token stops on its very next
  // request (verify reads it on every use). Repeating it changes nothing.
  async revoke(sessionActor, tokenId) {
    this.requireAdmin(sessionActor);
    const now = new Date();
    const revoked = await this.repos.apiTokens.revokeAny(tokenId, sessionActor.userId, now);
    if (revoked) await this.repos.apiTokens.appendAudit({ action: "token.revoked", tokenId, ownerUserId: revoked.ownerUserId, actorUserId: sessionActor.userId, actorName: sessionActor.displayName ?? null, workspaceId: revoked.workspaceId, workspaceIds: revoked.workspaceIds, at: now });
    const doc = revoked || await this.repos.apiTokens.findById(tokenId);
    if (!doc) throw new ApiError(404, "NOT_FOUND", "This token doesn't exist.");
    return { token: await this.describe(doc, await this.ownerActor(doc.ownerUserId), undefined, { viewerUserId: sessionActor.userId }) };
  }

  // API Activity: the newest audit entries (created, rotated, revoked, refused or failed use), with the token's safe label (name and
  // prefix, never its secret or digest) and the people involved. Each entry is what the audit stored; nothing is worked out again.
  async activity(sessionActor) {
    this.requireAdmin(sessionActor);
    const entries = await this.repos.apiTokens.listAudit({ limit: 200 });
    const tokens = new Map((await this.repos.apiTokens.findManyByIds([...new Set(entries.map((e) => hex(e.tokenId)).filter(Boolean))].map((id) => new ObjectId(id)))).map((t) => [hex(t._id), t]));
    const people = await this.peopleNamed(entries.flatMap((e) => [e.ownerUserId, e.actorUserId]));
    const workspaces = new Map((await this.repos.workspaces.list()).map((w) => [hex(w._id), w.name]));
    const person = (id, fallback = null) => (id ? { id: hex(id), name: people.get(hex(id)) ?? fallback } : null);
    return {
      items: entries.map((e) => { const t = tokens.get(hex(e.tokenId)); return {
        action: e.action, at: iso(e.at), reason: e.reason || null,
        // boardIds: the token's boards (identifiers, not secrets), so Activity can be filtered by board. Requests aren't logged per board.
        token: e.tokenId ? { id: hex(e.tokenId), name: t?.name ?? null, prefix: t ? displayPrefix(t.publicId) : null, boardIds: (t?.boardIds || []).map(hex) } : null,
        actor: person(e.actorUserId, e.actorName || null), owner: person(e.ownerUserId),
        workspace: e.workspaceId ? { id: hex(e.workspaceId), name: workspaces.get(hex(e.workspaceId)) ?? null } : null,
        workspaces: (Array.isArray(e.workspaceIds) && e.workspaceIds.length ? e.workspaceIds : e.workspaceId ? [e.workspaceId] : []).map((w) => ({ id: hex(w), name: workspaces.get(hex(w)) ?? null }))
      }; })
    };
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
    // Each of the token's workspaces, now. A token keeps reading the workspaces its owner can still read; with none left it stops.
    const spaces = workspacesOf(doc);
    const roles = await Promise.all(spaces.map((w) => this.roleOf(actor, w)));
    const readable = spaces.filter((_, i) => roles[i]);
    if (!readable.length) { this.auditOnce(doc, "token.use_refused", "owner lost access"); throw new ApiError(403, "TOKEN_ACCESS_REVOKED", "The person who created this API token no longer has access to its workspace."); }
    return { actor, role: roles.find(Boolean), workspaceIds: readable };
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
    this.repos.apiTokens.appendAudit({ action, tokenId: doc._id, ownerUserId: doc.ownerUserId, workspaceId: doc.workspaceId, workspaceIds: doc.workspaceIds, reason, ...(doc.product === FABRIC_PRODUCT ? { product: FABRIC_PRODUCT } : {}) }).catch((error) => this.logger?.error?.(`[api-tokens] couldn't record an audit entry: ${error.name}`));
  }
}

// ---- Fabric Data API tokens (product: "fabric")
// The same documents, digest, publicId, display prefix, expiry rules (latestExpiry), revocation, recordUse and audit as board tokens,
// through the ApiTokenService above; only who may issue and use them differs. A Fabric token is
//   { ..., product: "fabric", scopes: [one or both dataset scopes, optionally "fabric.sensitive.read"], boardIds: [] }
// with no workspace fields, so the board API refuses it (authorize() needs "read") and it never reaches a board. One token is
// never both: the board create accepts only ["read"] and this one only the fabric.* scopes.
//
// SCOPES (all read-only; any other string, including the earlier fabric_data.* names, is refused when issuing and at use):
//   fabric.sales.read      the sales dataset
//   fabric.inventory.read  the inventory dataset
//   fabric.sensitive.read  the sensitive fields of the datasets the token reads: only together with at least one dataset scope,
//                          and only issued by an administrator who is a sensitive reader
// A Fabric token always has at least one dataset scope. Scopes are stored in the order sales, inventory, sensitive.
//
// Authority never comes from workspace roles, open access (development_shared, beta open editing) or JARC.Admin. It comes from the
// injected permissions, each given a verified Microsoft Entra identity { kind: "entra", tenantId, entraObjectId }:
//   isApiAdmin(identity)         may issue, list and revoke Fabric tokens and read their activity (FABRIC_API_ADMIN_OIDS ∩ readers)
//   isReader(identity)           may read both Fabric datasets (FABRIC_DATA_READER_OIDS)
//   isSensitiveReader(identity)  may also read the sensitive fields (FABRIC_DATA_COST_READER_OIDS); isCostReader is accepted as
//                                the earlier name of the same check
// For a session the identity is the session actor (verified at sign-in); for a token it is the OWNER as stored in the users
// collection now (tenant + Entra object ID, as ownerActor uses), re-checked on every request.
const FABRIC_SCOPES = Object.freeze({ sales: "fabric.sales.read", inventory: "fabric.inventory.read", sensitive: "fabric.sensitive.read" });
// Dataset scope → dataset name.
const FABRIC_DATASET_SCOPES = Object.freeze({ [FABRIC_SCOPES.sales]: "sales", [FABRIC_SCOPES.inventory]: "inventory" });
const FABRIC_SCOPE_ORDER = Object.freeze([FABRIC_SCOPES.sales, FABRIC_SCOPES.inventory, FABRIC_SCOPES.sensitive]);
// The datasets a list of scopes grants, in a fixed order; [] for anything that isn't an array.
const fabricDatasetsOf = (scopes) => (Array.isArray(scopes) ? Object.keys(FABRIC_DATASET_SCOPES).filter((s) => scopes.includes(s)).map((s) => FABRIC_DATASET_SCOPES[s]) : []);

// The injected checks, with isSensitiveReader taken from isCostReader when only the earlier name is given.
function fabricPermissionsOf(permissions) {
  const checks = { isApiAdmin: permissions?.isApiAdmin, isReader: permissions?.isReader, isSensitiveReader: permissions?.isSensitiveReader ?? permissions?.isCostReader };
  for (const [name, check] of Object.entries(checks)) if (typeof check !== "function") throw new Error(`Fabric API tokens need permissions.${name}.`);
  return Object.freeze(checks);
}

class FabricTokenService {
  constructor({ tokens, permissions }) {
    if (!(tokens instanceof ApiTokenService)) throw new Error("Fabric API tokens need the API token service.");
    this.tokens = tokens; this.permissions = fabricPermissionsOf(permissions);
  }
  get repos() { return this.tokens.repos; }

  // A stored person's verified identity, as the permission checks take it.
  static identityOf(user) { return Object.freeze({ kind: "entra", tenantId: user.tenantId, entraObjectId: user.entraObjectId }); }
  sessionIdentity(sessionActor) {
    return sessionActor?.kind === "entra" ? Object.freeze({ kind: "entra", tenantId: sessionActor.tenantId, entraObjectId: sessionActor.entraObjectId }) : null;
  }
  isAdmin(sessionActor) {
    const identity = this.sessionIdentity(sessionActor);
    return Boolean(identity && this.permissions.isApiAdmin({ ...sessionActor, ...identity }));
  }
  requireAdmin(sessionActor) {
    if (!this.isAdmin(sessionActor)) throw new ApiError(403, "FABRIC_API_ADMIN_REQUIRED", "Only Fabric API administrators can manage Fabric API tokens.");
  }

  // At least one of fabric.sales.read and fabric.inventory.read, optionally fabric.sensitive.read, each once, and nothing else
  // (in any order; returned in the stored order).
  parseScopes(value) {
    const valid = Array.isArray(value) && value.every((s) => typeof s === "string" && FABRIC_SCOPE_ORDER.includes(s)) && new Set(value).size === value.length
      && fabricDatasetsOf(value).length >= 1;
    if (!valid) fail(`scopes must include "${FABRIC_SCOPES.sales}" and/or "${FABRIC_SCOPES.inventory}", optionally with "${FABRIC_SCOPES.sensitive}", each once: Fabric API tokens are read-only.`);
    return FABRIC_SCOPE_ORDER.filter((s) => value.includes(s));
  }

  // { name, description?, scopes, expiresAt } → { token, secret } (the secret this once; only its digest is stored).
  async create(sessionActor, raw) {
    this.requireAdmin(sessionActor);
    const body = requireBody(raw);
    allowOnly(body, ["name", "description", "scopes", "expiresAt"], "the token");
    const name = text(body.name, "name", { max: 100, required: true });
    const description = body.description === undefined || body.description === null ? "" : text(body.description, "description", { max: 500 });
    const scopes = this.parseScopes(body.scopes);
    const now = new Date();
    const expiresAt = this.tokens.parseExpiry(body.expiresAt, now);
    if (scopes.includes(FABRIC_SCOPES.sensitive) && !this.permissions.isSensitiveReader(this.sessionIdentity(sessionActor))) {
      throw new ApiError(403, "FABRIC_SENSITIVE_ACCESS_REQUIRED", "Only a Fabric API administrator who can read sensitive fields can issue a token that reads them.");
    }
    const actor = await this.tokens.ownerActor(sessionActor.userId);
    if (!actor) throw new ApiError(403, "FORBIDDEN", "Your JARC account can't manage API tokens.");
    const { maxActive } = this.tokens;
    if (await this.repos.apiTokens.countActive(actor.userId, now, { product: FABRIC_PRODUCT }) >= maxActive) throw conflict("TOKEN_LIMIT_REACHED", `You can have ${maxActive} active Fabric API tokens. Revoke one you no longer need.`);
    const { publicId, token, digest } = generateToken(this.tokens.key);
    const doc = { _id: new ObjectId(), publicId, digest, name, ...(description ? { description } : {}), ownerUserId: actor.userId, product: FABRIC_PRODUCT, boardIds: [], scopes, createdAt: now, expiresAt, revokedAt: null, lastUsedAt: null, requestCount: 0 };
    await this.tokens.connection.withTransaction(async (session) => {
      await this.repos.apiTokens.insert(doc, { session });
      await this.repos.apiTokens.appendAudit({ action: "token.created", tokenId: doc._id, ownerUserId: actor.userId, actorUserId: actor.userId, actorName: actor.displayName, product: FABRIC_PRODUCT, at: now }, { session });
    });
    return { token: await this.describe(doc), secret: token };
  }

  // Whether the owner may read Fabric data right now (and the sensitive fields), from the stored person; null when they can't use
  // tokens at all.
  async ownerAccess(userId) {
    const owner = await this.tokens.ownerRecord(userId);
    if (!owner) return null;
    const identity = FabricTokenService.identityOf(owner.user);
    const read = Boolean(this.permissions.isReader(identity));
    return { read, sensitive: read && Boolean(this.permissions.isSensitiveReader(identity)) };
  }

  // Never the digest. status: revoked, expired, no_access (the owner can't read Fabric data now) or active. datasets and sensitive
  // are what the scopes grant (at use, sensitive also needs the owner to be a sensitive reader then).
  async describe(doc, { people = null, owner } = {}) {
    const named = people || await this.tokens.peopleNamed([doc.ownerUserId, doc.revokedByUserId]);
    const access = owner === undefined ? await this.ownerAccess(doc.ownerUserId) : owner;
    const status = doc.revokedAt ? "revoked" : doc.expiresAt <= new Date() ? "expired" : access?.read ? "active" : "no_access";
    return {
      id: hex(doc._id), name: doc.name, description: doc.description || "", prefix: displayPrefix(doc.publicId), status, scopes: [...doc.scopes],
      datasets: fabricDatasetsOf(doc.scopes), sensitive: doc.scopes.includes(FABRIC_SCOPES.sensitive),
      owner: { id: hex(doc.ownerUserId), name: named.get(hex(doc.ownerUserId)) ?? null },
      createdAt: iso(doc.createdAt), expiresAt: iso(doc.expiresAt), lastUsedAt: iso(doc.lastUsedAt), revokedAt: iso(doc.revokedAt),
      revokedBy: doc.revokedByUserId ? { id: hex(doc.revokedByUserId), name: named.get(hex(doc.revokedByUserId)) ?? null } : null,
      requestCount: doc.requestCount || 0
    };
  }

  // Every owner's Fabric tokens (only those), newest first.
  async list(sessionActor) {
    this.requireAdmin(sessionActor);
    const docs = await this.repos.apiTokens.listAll({ product: FABRIC_PRODUCT });
    const people = await this.tokens.peopleNamed(docs.flatMap((d) => [d.ownerUserId, d.revokedByUserId]));
    const owners = new Map();
    await Promise.all([...new Set(docs.map((d) => hex(d.ownerUserId)))].map(async (id) => owners.set(id, await this.ownerAccess(new ObjectId(id)))));
    return Promise.all(docs.map((doc) => this.describe(doc, { people, owner: owners.get(hex(doc.ownerUserId)) ?? null })));
  }

  // Any Fabric token, by a Fabric API administrator, who is recorded on it. Repeating it changes nothing. A board token's ID is
  // "doesn't exist" here (and a Fabric token's ID is "doesn't exist" on the board routes).
  async revoke(sessionActor, tokenId) {
    this.requireAdmin(sessionActor);
    const now = new Date();
    const revoked = await this.repos.apiTokens.revokeAny(tokenId, sessionActor.userId, now, { product: FABRIC_PRODUCT });
    if (revoked) await this.repos.apiTokens.appendAudit({ action: "token.revoked", tokenId, ownerUserId: revoked.ownerUserId, actorUserId: sessionActor.userId, actorName: sessionActor.displayName ?? null, product: FABRIC_PRODUCT, at: now });
    const doc = revoked || await this.repos.apiTokens.findById(tokenId, { product: FABRIC_PRODUCT });
    if (!doc) throw new ApiError(404, "NOT_FOUND", "This token doesn't exist.");
    return { token: await this.describe(doc) };
  }

  // The newest audit entries about Fabric tokens only.
  async activity(sessionActor) {
    this.requireAdmin(sessionActor);
    const entries = await this.repos.apiTokens.listAudit({ limit: 200, product: FABRIC_PRODUCT });
    const tokens = new Map((await this.repos.apiTokens.findManyByIds([...new Set(entries.map((e) => hex(e.tokenId)).filter(Boolean))].map((id) => new ObjectId(id)))).map((t) => [hex(t._id), t]));
    const people = await this.tokens.peopleNamed(entries.flatMap((e) => [e.ownerUserId, e.actorUserId]));
    const person = (id, fallback = null) => (id ? { id: hex(id), name: people.get(hex(id)) ?? fallback } : null);
    return {
      items: entries.map((e) => { const t = tokens.get(hex(e.tokenId)); return {
        action: e.action, at: iso(e.at), reason: e.reason || null,
        token: e.tokenId ? { id: hex(e.tokenId), name: t?.name ?? null, prefix: t ? displayPrefix(t.publicId) : null } : null,
        actor: person(e.actorUserId, e.actorName || null), owner: person(e.ownerUserId)
      }; })
    };
  }

  // ---- Using a token (after tokens.verify and the rate limit): the scope, then the OWNER's Fabric access right now.
  // → { datasets, sensitive }: datasets = a Set of the token's datasets ("sales", "inventory"); sensitive = the token has
  // fabric.sensitive.read AND the owner is a sensitive reader now. A token with no dataset scope (a board token, or anything
  // else) is refused; the data router refuses a dataset that isn't in the set.
  async authorize(doc) {
    const datasets = doc.product === FABRIC_PRODUCT ? fabricDatasetsOf(doc.scopes) : [];
    if (!datasets.length) throw new ApiError(403, "INSUFFICIENT_SCOPE", "This API token doesn't allow reading Fabric data.");
    const access = await this.ownerAccess(doc.ownerUserId);
    if (!access) { this.tokens.auditOnce(doc, "token.use_refused", "owner disabled"); throw new ApiError(403, "TOKEN_OWNER_DISABLED", "The person who created this API token can no longer use JARC."); }
    if (!access.read) { this.tokens.auditOnce(doc, "token.use_refused", "owner lost access"); throw new ApiError(403, "TOKEN_ACCESS_REVOKED", "The person who created this API token can no longer read Fabric data."); }
    return { datasets: new Set(datasets), sensitive: doc.scopes.includes(FABRIC_SCOPES.sensitive) && access.sensitive };
  }
}

module.exports = { ApiTokenService, FabricTokenService, SCOPES, FABRIC_SCOPES, FABRIC_DATASET_SCOPES, LIMITS, ISSUER_ROLE, addUtcYears, latestExpiry, workspacesOf };
