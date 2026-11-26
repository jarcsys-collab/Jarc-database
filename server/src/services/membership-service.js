// Workspace membership management: list, add, change role, remove. Only WORKSPACE_ADMIN (or SYSTEM_ADMIN) may change
// memberships (checked by the routes). A workspace always keeps at least one active WORKSPACE_ADMIN: demoting or
// removing an admin runs in a transaction that also increments the workspace's membersVersion, so two admins
// demoting each other at the same moment conflict (one is retried and then refused) instead of both succeeding.
// P4-0: "an admin" means a USABLE one (auth/accounts.js usableWorkspaceAdmin: the users document exists and is active, and the
// account isn't blocked, or, under ACCOUNT_MANAGEMENT=enforced, pending or capped below WORKSPACE_ADMIN). Distinct people are
// counted (duplicate rows count once; a row whose user is missing counts zero). Employee Management P3 suspend / revoke uses the
// same count (countUsableAdmins) and touches the same membersVersion, so a status change and a membership change conflict too.
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { requireBody, allowOnly, parseId, text, fail } = require("../validation/common");
const { ROLES } = require("../repositories/mongo/membership-repository");
const { ACCOUNT_MODES, usableWorkspaceAdmin } = require("../auth/accounts");
const { activityEntry, appendActivity } = require("./shared");

const memberNotFound = () => new ApiError(404, "NOT_FOUND", "This member doesn't exist in the workspace.");
const lastAdmin = () => new ApiError(400, "VALIDATION_ERROR", "A workspace needs at least one admin. Make someone else an admin first.");
const role = (value) => { if (!ROLES.includes(value)) fail(`role must be one of: ${ROLES.join(", ")}.`); return value; };

class MembershipService {
  // accountMode: ACCOUNT_MANAGEMENT, for the usable-admin count. Until configure() is called it is "staged" (a blocked account
  // never counts; pending and capped accounts count, as they still work unless enforced), the safe reading for off and staged.
  constructor({ repos, connection, logger }) { Object.assign(this, { repos, connection, logger, accountMode: "staged" }); }
  configure({ accountMode } = {}) { if (ACCOUNT_MODES.includes(accountMode)) this.accountMode = accountMode; return this; }

  // { rows, usable }: the workspace's active WORKSPACE_ADMIN rows other than exceptMemberId / exceptUserId's, and how many
  // distinct people behind them can use JARC right now. Read in the caller's transaction (session).
  async countUsableAdmins(workspaceId, { session, exceptMemberId = null, exceptUserId = null, accountMode = this.accountMode } = {}) {
    const rows = (await this.repos.memberships.listActiveAdmins(workspaceId, { session })).filter((r) => !(exceptMemberId && r._id.equals(exceptMemberId)) && !(exceptUserId && r.userId.equals(exceptUserId)));
    const ids = [...new Map(rows.map((r) => [r.userId.toHexString(), r.userId])).values()];
    const users = await this.repos.users.findByIdsIn(ids, { session });
    return { rows: rows.length, usable: new Set(users.filter((u) => usableWorkspaceAdmin(u, accountMode)).map((u) => u._id.toHexString())).size };
  }

  async list(workspaceId) {
    const members = await this.repos.memberships.listByWorkspace(workspaceId);
    const users = new Map((await this.repos.users.findByIds(members.map((m) => m.userId))).map((u) => [u._id.toHexString(), u]));
    return members.map((m) => ({ ...m, user: users.get(m.userId.toHexString()) || null }));
  }

  // Add an existing user (they must have signed in once) by userId or by exact email.
  // options.session (optional, Employee Management P3): run inside the caller's transaction, so its own audit entry commits or
  // rolls back with the change; the activity entry is then written in that transaction too. Without it: exactly as before.
  async add(workspaceId, raw, actor, { session } = {}) {
    const body = requireBody(raw);
    allowOnly(body, ["userId", "email", "role"], "the member");
    if ((body.userId === undefined) === (body.email === undefined)) fail("Send either userId or email.");
    const newRole = role(body.role);
    const user = body.userId !== undefined ? await this.repos.users.findById(parseId(body.userId, "userId")) : await this.repos.users.findByEmail(text(body.email, "email", { max: 320, required: true }));
    if (!user) throw new ApiError(404, "NOT_FOUND", "No JARC user found. They need to sign in to JARC once before they can be added.");
    if (user.status !== "active") fail("This user's account is disabled.");
    const now = new Date();
    let member;
    try { member = await this.repos.memberships.add({ workspaceId, userId: user._id, role: newRole, now }, session ? { session } : {}); }
    catch (error) { if (error?.code === 11000) throw new ApiError(409, "CONFLICT", "This person is already a member of the workspace."); throw error; }
    const entry = activityEntry({ workspaceId, actorUserId: actor.userId, actorName: actor.displayName, action: "member.added", entityType: "member", entityId: member._id, changes: [{ field: "role", from: null, to: newRole }], summary: `Added ${user.displayName || "a member"} as ${newRole}`, now });
    if (session) await this.repos.activities.append(entry, { session });
    else await appendActivity(this.repos.activities, this.logger, entry);
    return { ...member, user };
  }

  async changeRole(workspaceId, memberId, raw, actor, { session: outer, accountMode } = {}) {
    const body = requireBody(raw);
    allowOnly(body, ["role"], "the member update");
    const newRole = role(body.role);
    const member = await this.guarded(workspaceId, memberId, actor, async (member, session, now) => {
      if (member.role === newRole) return member;
      await this.repos.memberships.updateRole(member._id, newRole, now, { session });
      await this.repos.activities.append(activityEntry({ workspaceId, actorUserId: actor.userId, actorName: actor.displayName, action: "member.role_changed", entityType: "member", entityId: member._id, changes: [{ field: "role", from: member.role, to: newRole }], now }), { session });
      return { ...member, role: newRole, updatedAt: now };
    }, (current) => current.role === "WORKSPACE_ADMIN" && newRole !== "WORKSPACE_ADMIN", outer, accountMode);
    return { ...member, user: await this.repos.users.findById(member.userId) };
  }

  async remove(workspaceId, memberId, actor, { session: outer, accountMode } = {}) {
    return this.guarded(workspaceId, memberId, actor, async (member, session, now) => {
      await this.repos.memberships.remove(member._id, { session });
      await this.repos.activities.append(activityEntry({ workspaceId, actorUserId: actor.userId, actorName: actor.displayName, action: "member.removed", entityType: "member", entityId: member._id, changes: [{ field: "role", from: member.role, to: null }], now }), { session });
      return { removed: true };
    }, (member) => member.role === "WORKSPACE_ADMIN", outer, accountMode);
  }

  // Runs a membership change in a transaction, refusing it if it would leave the workspace without an admin. outer: a session
  // the caller's transaction already holds (the change then runs in it instead of a transaction of its own).
  // Refused (P4-0, D-H1) whenever no other USABLE admin would remain, whatever this member's own state: no operation may leave a
  // workspace without a usable owner. That includes removing or demoting an already-unusable (suspended, revoked, blocked or
  // missing) admin's row while no usable admin remains: that row is the workspace's way back (restoring the person), so someone
  // usable is made an admin first.
  async guarded(workspaceId, memberId, actor, apply, losesAdmin, outer = null, accountMode = this.accountMode) {
    const mode = ACCOUNT_MODES.includes(accountMode) ? accountMode : this.accountMode;
    const id = memberId instanceof ObjectId ? memberId : parseId(memberId, "memberId");
    const now = new Date();
    const run = outer ? (fn) => fn(outer) : (fn) => this.connection.withTransaction(fn);
    const result = await run(async (session) => {
      const member = await this.repos.memberships.findById(id, { session });
      if (!member || !member.workspaceId.equals(workspaceId)) throw memberNotFound();
      // Touch the workspace so concurrent membership changes in this workspace conflict with each other.
      await this.repos.workspaces.touchMembers(workspaceId, { session });
      if (member.status === "active" && losesAdmin(member)) {
        const { rows, usable } = await this.countUsableAdmins(workspaceId, { session, exceptMemberId: member._id, accountMode: mode });
        if (rows === 0 || usable === 0) throw lastAdmin();
      }
      return apply(member, session, now);
    });
    return result;
  }
}

module.exports = { MembershipService };
