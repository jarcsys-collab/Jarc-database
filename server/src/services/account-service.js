// Account Management (Phase M4.3): the Super Admin reviews who has signed in, approves accounts, assigns a global role
// and explicit workspace memberships, blocks and reactivates. Rules (auth/accounts.js for the model):
//
//   who        only an active Super Admin account, re-checked inside each change's transaction
//   self       nobody changes their own role or status (no self-demotion, no self-block)
//   last       the last active Super Admin can't be demoted or blocked
//   escalation granting SUPER_ADMIN needs the JARC.Admin app role on the granting administrator's sign-in and the
//              typed confirmation "GRANT SUPER ADMIN"; nobody else can grant anything (Admins can't reach these routes)
//   versions   every change names the account version it was based on (expectedVersion); a stale one is refused (409)
//   workspaces a membership can't exceed what the global role allows (EDITOR → MEMBER, VIEWER → VIEWER); pending and
//              blocked accounts get no workspace access
//   sessions   blocking ends every session at once; any other change applies to the person's next request (the
//              session reads the account each time) and their live-update stream reconnects with the new permissions
//   audit      each change appends to accountAudit (previous and new values, administrator, time) in the same transaction
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { requireBody, allowOnly, parseId, fail } = require("../validation/common");
const { ROLES: WORKSPACE_ROLES } = require("../repositories/mongo/membership-repository");
const { ACCOUNT_ROLES, WORKSPACE_CAP, WORKSPACE_RANK, accountOf, isActiveSuperAdmin, capWorkspaceRole, superAdminEligibility, CONFIRM } = require("../auth/accounts");

const forbidden = (message) => new ApiError(403, "FORBIDDEN", message);
const notFound = () => new ApiError(404, "NOT_FOUND", "This account doesn't exist.");
const conflict = () => new ApiError(409, "CONFLICT", "This account was changed by someone else. Reload and try again.");
const hex = (id) => (id ? id.toHexString() : null);
const iso = (d) => (d instanceof Date ? d.toISOString() : null);
const STATUS_FILTERS = ["pending", "active", "blocked", "legacy"];

function role(value) { if (!ACCOUNT_ROLES.includes(value)) fail(`role must be one of: ${ACCOUNT_ROLES.join(", ")}.`); return value; }
function version(value) { if (!Number.isInteger(value) || value < 0) fail("expectedVersion must be the account version you saw (a whole number)."); return value; }

class AccountService {
  constructor({ repos, connection, logger }) { Object.assign(this, { repos, connection, logger, mode: "off", superAdmin: null, entra: null, environment: "development" }); }
  // Settings from the server configuration (app.js), set when the routes are mounted.
  configure({ mode, superAdmin = null, entra = null, environment = "development" }) { Object.assign(this, { mode, superAdmin, entra, environment }); return this; }
  get tracking() { return this.mode !== "off"; }

  requireSuperAdmin(actor) {
    if (!this.tracking) throw new ApiError(404, "NOT_FOUND", "Account Management is turned off on this server.");
    if (actor?.kind !== "entra" || !isActiveSuperAdmin(actor.account)) throw forbidden("Only the JARC Super Admin can manage accounts.");
  }

  // ---- Sign-in (routes/auth.js): creation and login are recorded; nothing about the account changes.
  async onSignIn(user, created, now) {
    if (!this.tracking) return;
    await this.repos.users.recordLogin(user._id, now);
    if (created) await this.repos.accountAudit.append({ action: "account.created", targetUserId: user._id, changes: [{ field: "status", from: null, to: "pending" }], at: now });
    await this.repos.accountAudit.append({ action: "account.signed_in", targetUserId: user._id, at: now });
  }

  // ---- Reading
  async list(query = {}) {
    allowOnly(query, ["q", "role", "status"], "the query");
    const q = typeof query.q === "string" ? query.q.trim().toLowerCase().slice(0, 100) : "";
    if (query.q !== undefined && typeof query.q !== "string") fail("q must be text.");
    if (query.role !== undefined && ![...ACCOUNT_ROLES, "none"].includes(query.role)) fail(`role must be one of: ${[...ACCOUNT_ROLES, "none"].join(", ")}.`);
    if (query.status !== undefined && !STATUS_FILTERS.includes(query.status)) fail(`status must be one of: ${STATUS_FILTERS.join(", ")}.`);
    const users = await this.repos.users.listEntra();
    const rows = await this.decorate(users);
    return rows.filter((r) => (!q || `${r.displayName} ${r.email || ""}`.toLowerCase().includes(q))
      && (query.role === undefined || (query.role === "none" ? !r.role : r.role === query.role))
      && (query.status === undefined || r.status === query.status));
  }

  async detail(userId) {
    const user = await this.repos.users.findById(userId);
    if (!user || user.source !== "entra") throw notFound();
    const [account] = await this.decorate([user]);
    const entries = await this.repos.accountAudit.listForUser(user._id, { limit: 200 });
    const names = new Map((await this.repos.workspaces.list()).map((w) => [hex(w._id), w.name]));
    const history = entries.map((e) => ({ action: e.action, at: iso(e.at), actorId: hex(e.actorUserId), actorName: e.actorName ?? null, changes: (e.changes || []).map((c) => ({ field: c.field, from: c.from ?? null, to: c.to ?? null })), ...(e.workspaceId ? { workspaceId: hex(e.workspaceId), workspaceName: names.get(hex(e.workspaceId)) ?? null } : {}) }));
    return { account, history };
  }

  // API shape: display details, account status and role, login times, approvals and workspace memberships. Never
  // tenant or object IDs, sessions or tokens.
  async decorate(users) {
    const workspaces = new Map((await this.repos.workspaces.list()).map((w) => [hex(w._id), w]));
    const approvers = new Map((await this.repos.users.findByIds([...new Set(users.map((u) => u.account?.approvedBy).filter((id) => id instanceof ObjectId).map(hex))].map((h) => new ObjectId(h)))).map((u) => [hex(u._id), u]));
    const rows = [];
    for (const u of users) {
      const account = accountOf(u);
      const memberships = await this.repos.memberships.listForUser(u._id);
      rows.push({
        id: hex(u._id), displayName: u.displayName || u.email || "Unnamed user", email: u.email ?? null,
        status: account.legacy ? "legacy" : account.status, role: account.role, disabled: u.status !== "active", version: account.version,
        firstLoginAt: iso(u.firstLoginAt) ?? iso(u.createdAt), lastLoginAt: iso(u.lastLoginAt),
        approvedBy: u.account?.approvedBy ? { id: hex(u.account.approvedBy), name: u.account.approvedByName ?? approvers.get(hex(u.account.approvedBy))?.displayName ?? null } : null,
        approvedAt: iso(u.account?.approvedAt), updatedAt: iso(u.account?.updatedAt),
        workspaces: memberships.map((m) => ({ workspaceId: hex(m.workspaceId), name: workspaces.get(hex(m.workspaceId))?.name ?? null, role: m.role, effectiveRole: this.mode === "enforced" ? capWorkspaceRole(account, m.role) : m.role }))
      });
    }
    return rows;
  }

  // ---- Changes to the global account
  async approve(actor, userId, raw) {
    const body = requireBody(raw); allowOnly(body, ["role", "expectedVersion", "confirm"], "the approval");
    const newRole = role(body.role);
    return this.change(actor, userId, version(body.expectedVersion), "account.approved", (target) => {
      if (target.account.status === "active") fail("This account is already approved. Change its role instead.");
      if (target.account.status === "blocked") fail("This account is blocked. Reactivate it instead.");
      this.checkGrant(actor, newRole, body.confirm);
      return { status: "active", role: newRole };
    }, { approval: true });
  }

  async changeRole(actor, userId, raw) {
    const body = requireBody(raw); allowOnly(body, ["role", "expectedVersion", "confirm"], "the role change");
    const newRole = role(body.role);
    return this.change(actor, userId, version(body.expectedVersion), "account.role_changed", (target) => {
      if (target.account.status !== "active") fail("Only approved accounts have a role to change. Approve or reactivate it first.");
      if (target.account.role === newRole) fail(`This account is already ${newRole}.`);
      this.checkGrant(actor, newRole, body.confirm);
      return { role: newRole };
    });
  }

  async block(actor, userId, raw) {
    const body = requireBody(raw); allowOnly(body, ["expectedVersion", "confirm"], "the block");
    if (body.confirm !== CONFIRM.block) fail(`Type ${CONFIRM.block} to confirm blocking this account.`);
    const result = await this.change(actor, userId, version(body.expectedVersion), "account.blocked", (target) => {
      if (target.account.status === "blocked") fail("This account is already blocked.");
      return { status: "blocked", role: target.account.role, blockedBy: actor.userId };
    });
    // Signed out everywhere at once (every request would refuse the session anyway).
    await this.repos.sessions.removeForUser(new ObjectId(result.id));
    return result;
  }

  async reactivate(actor, userId, raw) {
    const body = requireBody(raw); allowOnly(body, ["role", "expectedVersion", "confirm"], "the reactivation");
    return this.change(actor, userId, version(body.expectedVersion), "account.reactivated", (target) => {
      if (target.account.status !== "blocked") fail("Only blocked accounts can be reactivated.");
      const nextRole = body.role === undefined ? target.account.role : role(body.role);
      if (!nextRole) fail("Choose a role for this account.");
      this.checkGrant(actor, nextRole, body.confirm);
      return { status: "active", role: nextRole };
    });
  }

  // Granting SUPER_ADMIN is the one escalation possible here: it needs the existing JARC administrator authorization
  // (the JARC.Admin app role on this sign-in) and a typed confirmation.
  checkGrant(actor, newRole, confirm) {
    if (newRole !== "SUPER_ADMIN") return;
    if (!actor.hasAdminAppRole) throw forbidden("Granting Super Admin needs the JARC.Admin role on your Microsoft sign-in.");
    if (confirm !== CONFIRM.superAdmin) fail(`Type ${CONFIRM.superAdmin} to confirm.`);
  }

  // One account change: re-checks the administrator, refuses self-changes and losing the last Super Admin, applies the
  // change only at the expected version and records it, all in one transaction.
  async change(actor, userId, expectedVersion, action, plan, { approval = false } = {}) {
    this.requireSuperAdmin(actor);
    const id = userId instanceof ObjectId ? userId : parseId(userId, "userId");
    if (id.equals(actor.userId)) throw forbidden("You can't change your own account. Another Super Admin has to do it.");
    const now = new Date();
    const updated = await this.connection.withTransaction(async (session) => {
      const me = await this.repos.users.findByIdIn(actor.userId, { session });
      if (!me || me.status !== "active" || !isActiveSuperAdmin(accountOf(me))) throw forbidden("Only the JARC Super Admin can manage accounts.");
      await this.repos.users.touchAccountActor(actor.userId, now, { session });
      const doc = await this.repos.users.findByIdIn(id, { session });
      if (!doc || doc.source !== "entra") throw notFound();
      const account = accountOf(doc);
      if (account.version !== expectedVersion) throw conflict();
      const before = { status: account.legacy ? "legacy" : account.status, role: account.role };
      const target = { ...doc, account: { ...account, status: account.legacy ? "pending" : account.status } };
      const fields = plan(target);
      const losesSuperAdmin = before.status === "active" && before.role === "SUPER_ADMIN" && (fields.status && fields.status !== "active" || fields.role && fields.role !== "SUPER_ADMIN");
      if (losesSuperAdmin && await this.repos.users.countSuperAdmins({ session }) <= 1) throw new ApiError(400, "VALIDATION_ERROR", "JARC needs at least one Super Admin. Make someone else Super Admin first.");
      if (approval || (fields.status === "active" && before.status !== "active")) Object.assign(fields, { approvedBy: actor.userId, approvedByName: actor.displayName ?? null, approvedAt: now });
      const next = await this.repos.users.updateAccount(id, expectedVersion, fields, now, { session });
      if (!next) throw conflict();
      const changes = ["status", "role"].filter((f) => fields[f] !== undefined && fields[f] !== before[f]).map((f) => ({ field: f, from: before[f], to: fields[f] }));
      await this.repos.accountAudit.append({ action, targetUserId: id, actorUserId: actor.userId, actorName: actor.displayName ?? null, changes, at: now }, { session });
      return next;
    });
    const [row] = await this.decorate([updated]);
    return row;
  }

  // ---- Workspace access (explicit memberships)
  async assignWorkspace(actor, userId, workspaceId, raw, members) {
    this.requireSuperAdmin(actor);
    const body = requireBody(raw); allowOnly(body, ["role"], "the workspace access");
    if (!WORKSPACE_ROLES.includes(body.role)) fail(`role must be one of: ${WORKSPACE_ROLES.join(", ")}.`);
    const { user, account, workspace } = await this.workspaceTarget(userId, workspaceId);
    if (!account.legacy && account.status !== "active") fail(account.status === "blocked" ? "This account is blocked." : "Approve this account before giving it workspace access.");
    if (!account.legacy && WORKSPACE_RANK[body.role] > WORKSPACE_RANK[WORKSPACE_CAP[account.role]]) fail(`A ${account.role} account can be at most ${WORKSPACE_CAP[account.role]} in a workspace.`);
    const current = await this.repos.memberships.findActive(workspace._id, user._id);
    const now = new Date();
    if (current) {
      if (current.role === body.role) return this.detail(user._id);
      await members.changeRole(workspace._id, current._id, { role: body.role }, actor);
      await this.repos.accountAudit.append({ action: "account.workspace_role_changed", targetUserId: user._id, actorUserId: actor.userId, actorName: actor.displayName ?? null, workspaceId: workspace._id, changes: [{ field: "workspaceRole", from: current.role, to: body.role }], at: now });
    } else {
      await members.add(workspace._id, { userId: user._id.toHexString(), role: body.role }, actor);
      await this.repos.accountAudit.append({ action: "account.workspace_assigned", targetUserId: user._id, actorUserId: actor.userId, actorName: actor.displayName ?? null, workspaceId: workspace._id, changes: [{ field: "workspaceRole", from: null, to: body.role }], at: now });
    }
    return this.detail(user._id);
  }

  async removeWorkspace(actor, userId, workspaceId, members) {
    this.requireSuperAdmin(actor);
    const { user, workspace } = await this.workspaceTarget(userId, workspaceId);
    const current = await this.repos.memberships.findActive(workspace._id, user._id);
    if (!current) throw new ApiError(404, "NOT_FOUND", "This person has no access to that workspace.");
    await members.remove(workspace._id, current._id, actor); // refuses removing a workspace's last admin
    await this.repos.accountAudit.append({ action: "account.workspace_removed", targetUserId: user._id, actorUserId: actor.userId, actorName: actor.displayName ?? null, workspaceId: workspace._id, changes: [{ field: "workspaceRole", from: current.role, to: null }], at: new Date() });
    return this.detail(user._id);
  }

  async workspaceTarget(userId, workspaceId) {
    const user = await this.repos.users.findById(userId instanceof ObjectId ? userId : parseId(userId, "userId"));
    if (!user || user.source !== "entra") throw notFound();
    if (user.status !== "active") fail("This user's account is disabled.");
    const workspace = await this.repos.workspaces.findById(workspaceId instanceof ObjectId ? workspaceId : parseId(workspaceId, "workspaceId"));
    if (!workspace) throw new ApiError(404, "NOT_FOUND", "This workspace doesn't exist.");
    return { user, account: accountOf(user), workspace };
  }

  // ---- The first Super Admin (explicit claim by the configured administrator; see superAdminEligibility)
  async eligibility(actor, session) {
    if (!this.tracking || actor?.kind !== "entra" || !session) return { eligible: false, problems: ["Account Management is off"] };
    const user = await this.repos.users.findById(actor.userId);
    const [sameIdentityCount, sameEmailOthers, superAdmins] = await Promise.all([
      user ? this.repos.users.countIdentity(user.tenantId, user.entraObjectId) : 0,
      this.superAdmin?.email && user ? this.repos.users.countOthersWithEmail(this.superAdmin.email, user._id) : 0,
      this.repos.users.countSuperAdmins()
    ]);
    return superAdminEligibility({ superAdmin: this.superAdmin, entra: this.entra, session, user, sameIdentityCount, sameEmailOthers, superAdmins });
  }

  async bootstrap(actor, session, raw) {
    // Production: only in observation mode (staged), with the same identity, JARC.Admin and confirmation checks.
    if (this.environment === "production" && this.mode !== "staged") throw forbidden("Super Admin activation in production is only available in observation mode (ACCOUNT_MANAGEMENT=staged).");
    const body = requireBody(raw); allowOnly(body, ["confirm"], "the request");
    if (body.confirm !== CONFIRM.bootstrap) fail(`Type ${CONFIRM.bootstrap} to confirm.`);
    const now = new Date();
    const updated = await this.connection.withTransaction(async (tx) => {
      const check = await this.eligibility(actor, session);
      if (!check.eligible) throw forbidden(`You can't become Super Admin: ${check.problems[0]}.`);
      const user = await this.repos.users.findByIdIn(actor.userId, { session: tx });
      const account = accountOf(user);
      const next = await this.repos.users.updateAccount(user._id, account.version, { status: "active", role: "SUPER_ADMIN", approvedBy: user._id, approvedByName: actor.displayName ?? null, approvedAt: now, bootstrap: true }, now, { session: tx });
      if (!next) throw conflict();
      if (await this.repos.users.countSuperAdmins({ session: tx }) !== 1) throw conflict();
      await this.repos.accountAudit.append({ action: "account.super_admin_bootstrapped", targetUserId: user._id, actorUserId: user._id, actorName: actor.displayName ?? null, changes: [{ field: "status", from: account.legacy ? "legacy" : account.status, to: "active" }, { field: "role", from: account.role, to: "SUPER_ADMIN" }], at: now }, { session: tx });
      return next;
    });
    const [row] = await this.decorate([updated]);
    return row;
  }
}

module.exports = { AccountService };
