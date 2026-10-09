// Workspace authorization. Every check starts from the stored resource: a board or record is loaded first and its
// workspace is taken from the database, never from an ID the browser sent.
//
//   VIEWER < MEMBER < WORKSPACE_ADMIN (per workspace, from workspaceMembers)  <  SYSTEM_ADMIN (Entra app role)
//
// Not a member → 404 (as if it didn't exist, so other workspaces can't be discovered).
// Member without the required role → 403 FORBIDDEN.
// AUTH_MODE=dev: the development actor is the local developer and is treated as SYSTEM_ADMIN (development only).
const { ApiError } = require("../middleware/errors");
const { notFound } = require("../services/shared");

const RANK = Object.freeze({ VIEWER: 1, MEMBER: 2, WORKSPACE_ADMIN: 3, SYSTEM_ADMIN: 4 });
const forbidden = (message = "You don't have permission to do this in this workspace.") => new ApiError(403, "FORBIDDEN", message);

class Access {
  constructor(repos) { this.repos = repos; }

  // The caller's role in a workspace, or null when they aren't an active member.
  async roleIn(actor, workspaceId) {
    if (actor.isSystemAdmin) return "SYSTEM_ADMIN";
    const membership = await this.repos.memberships.findActive(workspaceId, actor.userId);
    return membership ? membership.role : null;
  }

  async check(actor, workspaceId, minimum, what) {
    const role = await this.roleIn(actor, workspaceId);
    if (!role) throw notFound(what);
    if (RANK[role] < RANK[minimum]) throw forbidden();
    return role;
  }

  async workspace(actor, workspaceId, minimum) {
    const workspace = await this.repos.workspaces.findById(workspaceId);
    if (!workspace) throw notFound("workspace");
    return { workspace, role: await this.check(actor, workspace._id, minimum, "workspace") };
  }

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

  // Workspace IDs the caller can see with their role (system admins: every workspace).
  async visibleRoles(actor) {
    if (actor.isSystemAdmin) return null;
    const memberships = await this.repos.memberships.listForUser(actor.userId);
    return new Map(memberships.map((m) => [m.workspaceId.toHexString(), m.role]));
  }

  static atLeast(role, minimum) { return Boolean(role) && RANK[role] >= RANK[minimum]; }
}

module.exports = { Access, RANK, forbidden };
