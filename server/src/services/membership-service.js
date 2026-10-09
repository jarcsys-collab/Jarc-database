// Workspace membership management: list, add, change role, remove. Only WORKSPACE_ADMIN (or SYSTEM_ADMIN) may change
// memberships (checked by the routes). A workspace always keeps at least one active WORKSPACE_ADMIN: demoting or
// removing an admin runs in a transaction that also increments the workspace's membersVersion, so two admins
// demoting each other at the same moment conflict (one is retried and then refused) instead of both succeeding.
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { requireBody, allowOnly, parseId, text, fail } = require("../validation/common");
const { ROLES } = require("../repositories/mongo/membership-repository");
const { activityEntry, appendActivity } = require("./shared");

const memberNotFound = () => new ApiError(404, "NOT_FOUND", "This member doesn't exist in the workspace.");
const lastAdmin = () => new ApiError(400, "VALIDATION_ERROR", "A workspace needs at least one admin. Make someone else an admin first.");
const role = (value) => { if (!ROLES.includes(value)) fail(`role must be one of: ${ROLES.join(", ")}.`); return value; };

class MembershipService {
  constructor({ repos, connection, logger }) { Object.assign(this, { repos, connection, logger }); }

  async list(workspaceId) {
    const members = await this.repos.memberships.listByWorkspace(workspaceId);
    const users = new Map((await this.repos.users.findByIds(members.map((m) => m.userId))).map((u) => [u._id.toHexString(), u]));
    return members.map((m) => ({ ...m, user: users.get(m.userId.toHexString()) || null }));
  }

  // Add an existing user (they must have signed in once) by userId or by exact email.
  async add(workspaceId, raw, actor) {
    const body = requireBody(raw);
    allowOnly(body, ["userId", "email", "role"], "the member");
    if ((body.userId === undefined) === (body.email === undefined)) fail("Send either userId or email.");
    const newRole = role(body.role);
    const user = body.userId !== undefined ? await this.repos.users.findById(parseId(body.userId, "userId")) : await this.repos.users.findByEmail(text(body.email, "email", { max: 320, required: true }));
    if (!user) throw new ApiError(404, "NOT_FOUND", "No JARC user found. They need to sign in to JARC once before they can be added.");
    if (user.status !== "active") fail("This user's account is disabled.");
    const now = new Date();
    let member;
    try { member = await this.repos.memberships.add({ workspaceId, userId: user._id, role: newRole, now }); }
    catch (error) { if (error?.code === 11000) throw new ApiError(409, "CONFLICT", "This person is already a member of the workspace."); throw error; }
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId, actorUserId: actor.userId, action: "member.added", entityType: "member", entityId: member._id, changes: [{ field: "role", from: null, to: newRole }], summary: `Added ${user.displayName || "a member"} as ${newRole}`, now }));
    return { ...member, user };
  }

  async changeRole(workspaceId, memberId, raw, actor) {
    const body = requireBody(raw);
    allowOnly(body, ["role"], "the member update");
    const newRole = role(body.role);
    const member = await this.guarded(workspaceId, memberId, actor, async (member, session, now) => {
      if (member.role === newRole) return member;
      await this.repos.memberships.updateRole(member._id, newRole, now, { session });
      await this.repos.activities.append(activityEntry({ workspaceId, actorUserId: actor.userId, action: "member.role_changed", entityType: "member", entityId: member._id, changes: [{ field: "role", from: member.role, to: newRole }], now }), { session });
      return { ...member, role: newRole, updatedAt: now };
    }, (current) => current.role === "WORKSPACE_ADMIN" && newRole !== "WORKSPACE_ADMIN");
    return { ...member, user: await this.repos.users.findById(member.userId) };
  }

  async remove(workspaceId, memberId, actor) {
    return this.guarded(workspaceId, memberId, actor, async (member, session, now) => {
      await this.repos.memberships.remove(member._id, { session });
      await this.repos.activities.append(activityEntry({ workspaceId, actorUserId: actor.userId, action: "member.removed", entityType: "member", entityId: member._id, changes: [{ field: "role", from: member.role, to: null }], now }), { session });
      return { removed: true };
    }, (member) => member.role === "WORKSPACE_ADMIN");
  }

  // Runs a membership change in a transaction, refusing it if it would leave the workspace without an admin.
  async guarded(workspaceId, memberId, actor, apply, losesAdmin) {
    const id = memberId instanceof ObjectId ? memberId : parseId(memberId, "memberId");
    const now = new Date();
    const result = await this.connection.withTransaction(async (session) => {
      const member = await this.repos.memberships.findById(id, { session });
      if (!member || !member.workspaceId.equals(workspaceId)) throw memberNotFound();
      // Touch the workspace so concurrent membership changes in this workspace conflict with each other.
      await this.repos.workspaces.touchMembers(workspaceId, { session });
      if (member.status === "active" && losesAdmin(member) && await this.repos.memberships.countActiveAdmins(workspaceId, { session }) <= 1) throw lastAdmin();
      return apply(member, session, now);
    });
    return result;
  }
}

module.exports = { MembershipService };
