// Workspace authorization. Every check starts from the stored resource: a board or record is loaded first and its
// workspace is taken from the database, never from an ID the browser sent.
//
//   VIEWER < MEMBER < WORKSPACE_ADMIN (per workspace, from workspaceMembers)  <  SYSTEM_ADMIN (Entra app role)
//
// Not a member → 404 (as if it didn't exist, so other workspaces can't be discovered).
// Member without the required role → 403 FORBIDDEN.
// AUTH_MODE=dev: the development actor is the local developer and is treated as SYSTEM_ADMIN (development only).
//
// ACCESS_POLICY (config/index.js):
//   role_based          (default, and whenever the setting is unset or unknown) everything above.
//   development_shared  DEVELOPMENT COLLABORATION: every signed-in employee of the configured tenant is a
//                       WORKSPACE_ADMIN in every workspace and can create and delete workspaces. Unchanged: imports stay
//                       SYSTEM_ADMIN only, and membership changes still need a real WORKSPACE_ADMIN membership (or
//                       SYSTEM_ADMIN), so nothing granted here survives a switch back to role_based.
//
// JARC_BETA_OPEN_EDITING=true (TEMPORARY beta testing; off unless exactly "true"): with either policy, every signed-in
// employee of the configured tenant may create, edit, organise and delete content in every workspace — the same open
// access as development_shared, granted at check time and never stored. Unchanged even then: JARC administrator
// actions (imports, integrations), membership changes and comment moderation (both need a real membership or the
// JARC.Admin role), read-only synchronized boards, version checks, CSRF, validation and rate limits. Turning it off
// restores the configured policy immediately.
//
// ACCOUNT_MANAGEMENT=enforced (Phase M4.3, auth/accounts.js) replaces both open-access settings: development_shared and
// beta open editing are IGNORED (reported as overridden), SYSTEM_ADMIN is only an active Super Admin account, and every
// membership role is capped by the person's global account role (VIEWER accounts are read-only everywhere). Pending
// and blocked accounts see nothing. Legacy users (no account yet) keep exactly their membership roles (role_based).
// staged and off: unchanged from the rules above.
const { ApiError } = require("../middleware/errors");
const { notFound } = require("../services/shared");
const { capWorkspaceRole } = require("./accounts");

const RANK = Object.freeze({ VIEWER: 1, MEMBER: 2, WORKSPACE_ADMIN: 3, SYSTEM_ADMIN: 4 });
const ACCESS_POLICIES = Object.freeze(["role_based", "development_shared"]);
const forbidden = (message = "You don't have permission to do this in this workspace.") => new ApiError(403, "FORBIDDEN", message);

class Access {
  constructor(repos, { policy = "role_based", betaOpenEditing = false, accountMode = "off" } = {}) {
    if (!ACCESS_POLICIES.includes(policy)) throw new Error(`Unknown access policy: ${policy}`);
    if (!["off", "staged", "enforced"].includes(accountMode)) throw new Error(`Unknown account management mode: ${accountMode}`);
    this.repos = repos;
    this.accountMode = accountMode;
    this.enforced = accountMode === "enforced";
    // What the environment asked for, and what is in effect (enforced accounts switch open access off).
    this.configured = Object.freeze({ policy, betaOpenEditing: betaOpenEditing === true });
    this.policy = this.enforced ? "role_based" : policy;
    this.betaOpenEditing = !this.enforced && betaOpenEditing === true;
    // Open access: development_shared, or beta open editing.
    this.shared = this.policy === "development_shared" || this.betaOpenEditing;
  }

  // Open-access settings that are configured but not in effect because accounts are enforced.
  get overridden() {
    if (!this.enforced) return [];
    return [...(this.configured.policy === "development_shared" ? ["ACCESS_POLICY=development_shared"] : []), ...(this.configured.betaOpenEditing ? ["JARC_BETA_OPEN_EDITING=true"] : [])];
  }

  // The membership role the caller may actually use (enforced accounts: capped by their global role).
  effective(actor, role) { return this.enforced && actor.account ? capWorkspaceRole(actor.account, role) : role; }

  // A role the caller holds in every workspace without a membership (null: memberships decide).
  globalRole(actor) {
    if (actor.isSystemAdmin) return "SYSTEM_ADMIN";
    return this.shared ? "WORKSPACE_ADMIN" : null;
  }

  // The caller's role in a workspace, or null when they aren't an active member. membershipOnly ignores
  // development_shared (used for membership changes).
  async roleIn(actor, workspaceId, { membershipOnly = false } = {}) {
    if (actor.isSystemAdmin) return "SYSTEM_ADMIN";
    if (this.shared && !membershipOnly) return "WORKSPACE_ADMIN";
    const membership = await this.repos.memberships.findActive(workspaceId, actor.userId);
    return membership ? this.effective(actor, membership.role) : null;
  }

  async check(actor, workspaceId, minimum, what, options = {}) {
    const role = await this.roleIn(actor, workspaceId, options);
    // Under development_shared every workspace is visible, so a missing membership is "not allowed", not "not found".
    if (!role && options.membershipOnly && this.shared) throw forbidden("Only this workspace's admins can manage its members.");
    if (!role) throw notFound(what);
    if (RANK[role] < RANK[minimum]) throw forbidden();
    return role;
  }

  async workspace(actor, workspaceId, minimum, options) {
    const workspace = await this.repos.workspaces.findById(workspaceId);
    if (!workspace) throw notFound("workspace");
    return { workspace, role: await this.check(actor, workspace._id, minimum, "workspace", options) };
  }

  // Creating and deleting workspaces: SYSTEM_ADMIN, or anyone under development_shared.
  canManageWorkspaces(actor) { return Boolean(actor.isSystemAdmin) || this.shared; }
  requireWorkspaceManager(actor) {
    if (!this.canManageWorkspaces(actor)) throw forbidden("Only JARC administrators can do this.");
  }
  deletableWorkspace(actor, workspaceId) { return this.workspace(actor, workspaceId, this.shared ? "WORKSPACE_ADMIN" : "SYSTEM_ADMIN"); }

  async board(actor, boardId, minimum) {
    const board = await this.repos.boards.findById(boardId);
    if (!board) throw notFound("board");
    return { board, role: await this.check(actor, board.workspaceId, minimum, "board") };
  }

  async record(actor, recordId, minimum) {
    const record = await this.repos.records.findById(recordId);
    if (!record) throw notFound("record");
    return { record, role: await this.check(actor, record.workspaceId, minimum, "record") };
  }

  requireSystemAdmin(actor) {
    if (!actor.isSystemAdmin) throw forbidden("Only JARC administrators can do this.");
  }

  // Workspace IDs the caller can see with their role (null: every workspace, with globalRole).
  async visibleRoles(actor) {
    if (this.globalRole(actor)) return null;
    const memberships = await this.repos.memberships.listForUser(actor.userId);
    return new Map(memberships.map((m) => [m.workspaceId.toHexString(), this.effective(actor, m.role)]).filter(([, role]) => role));
  }

  static atLeast(role, minimum) { return Boolean(role) && RANK[role] >= RANK[minimum]; }
}

module.exports = { Access, RANK, ACCESS_POLICIES, forbidden };
