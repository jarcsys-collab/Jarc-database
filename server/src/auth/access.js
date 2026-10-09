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
const { ApiError } = require("../middleware/errors");
const { notFound } = require("../services/shared");

const RANK = Object.freeze({ VIEWER: 1, MEMBER: 2, WORKSPACE_ADMIN: 3, SYSTEM_ADMIN: 4 });
const ACCESS_POLICIES = Object.freeze(["role_based", "development_shared"]);
const forbidden = (message = "You don't have permission to do this in this workspace.") => new ApiError(403, "FORBIDDEN", message);

class Access {
  constructor(repos, { policy = "role_based" } = {}) {
    if (!ACCESS_POLICIES.includes(policy)) throw new Error(`Unknown access policy: ${policy}`);
    this.repos = repos;
    this.policy = policy;
    this.shared = policy === "development_shared";
  }

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
    return membership ? membership.role : null;
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
    return new Map(memberships.map((m) => [m.workspaceId.toHexString(), m.role]));
  }

  static atLeast(role, minimum) { return Boolean(role) && RANK[role] >= RANK[minimum]; }
}

module.exports = { Access, RANK, ACCESS_POLICIES, forbidden };
