// Account Management (Phase M4.3): global account status and role, kept on each user document (users.account), on top
// of the per-workspace memberships in workspaceMembers. Deny by default.
//
//   status   pending (new sign-in, awaiting approval) · active (approved) · blocked
//   role     SUPER_ADMIN · ADMIN · EDITOR · VIEWER (null while pending)
//
// A global role never grants a workspace by itself (only SUPER_ADMIN sees every workspace). It CAPS what a membership
// gives: ADMIN → up to WORKSPACE_ADMIN, EDITOR → up to MEMBER, VIEWER → VIEWER only, in the workspaces they are
// assigned to. Users created before account management (no `account` field) are "legacy": never promoted, never
// locked out automatically; they keep their membership-based access until the Super Admin reviews them.
//
// ACCOUNT_MANAGEMENT (config/index.js):
//   off       (default) nothing here is used; behaviour is exactly as before.
//   staged    accounts are recorded and the Super Admin can review, approve and assign roles and workspaces, but roles
//             and pending status are NOT enforced yet: ACCESS_POLICY and JARC_BETA_OPEN_EDITING still decide access.
//             Only blocking takes effect (it can only remove access).
//   enforced  roles are enforced; ACCESS_POLICY=development_shared and JARC_BETA_OPEN_EDITING are ignored; pending
//             users can reach nothing but their own session; the JARC.Admin app role alone no longer grants anything.
// Production: off or staged (observation mode, Phase M4.4A); enforced is refused at startup until separately approved.

const ACCOUNT_MODES = Object.freeze(["off", "staged", "enforced"]);
const ACCOUNT_ROLES = Object.freeze(["SUPER_ADMIN", "ADMIN", "EDITOR", "VIEWER"]);
const ACCOUNT_STATUSES = Object.freeze(["pending", "active", "blocked"]);
// The highest workspace role each global role can hold through a membership.
const WORKSPACE_CAP = Object.freeze({ SUPER_ADMIN: "WORKSPACE_ADMIN", ADMIN: "WORKSPACE_ADMIN", EDITOR: "MEMBER", VIEWER: "VIEWER" });
const WORKSPACE_RANK = Object.freeze({ VIEWER: 1, MEMBER: 2, WORKSPACE_ADMIN: 3 });

// The account part of an actor, from the stored user (never from the request).
function accountOf(user) {
  const a = user?.account;
  if (!a || typeof a !== "object") return Object.freeze({ legacy: true, status: null, role: null, version: 0 });
  return Object.freeze({ legacy: false, status: ACCOUNT_STATUSES.includes(a.status) ? a.status : "pending", role: ACCOUNT_ROLES.includes(a.role) ? a.role : null, version: Number.isInteger(a.version) ? a.version : 0 });
}

const isActiveSuperAdmin = (account) => Boolean(account && !account.legacy && account.status === "active" && account.role === "SUPER_ADMIN");

// A membership role limited by the global role (legacy accounts: unchanged).
function capWorkspaceRole(account, role) {
  if (!role || !account || account.legacy) return role;
  if (account.status !== "active" || !account.role) return null;
  const cap = WORKSPACE_CAP[account.role];
  return WORKSPACE_RANK[role] <= WORKSPACE_RANK[cap] ? role : cap;
}

// P4-0 (lockout protection): whether the person holding an active WORKSPACE_ADMIN membership can actually use it right now, from
// the stored users document only (never the Entra directory snapshot). Pure.
//   missing user, or users.status !== "active"      no (every sign-in, request and token refuses them)
//   staged / enforced: a blocked account               no (its sessions end, auth/session.js)
//   enforced: a pending account, or a role capped below WORKSPACE_ADMIN (EDITOR / VIEWER)   no
// Legacy users (no account) keep their membership-based access, so they count. Off: the account is not read at all.
function usableWorkspaceAdmin(user, accountMode = "staged") {
  if (!user || user.status !== "active") return false;
  if (accountMode === "off") return true;
  const account = accountOf(user);
  if (account.legacy) return true;
  if (account.status === "blocked") return false;
  if (accountMode !== "enforced") return true;
  return capWorkspaceRole(account, "WORKSPACE_ADMIN") === "WORKSPACE_ADMIN";
}

// P4-0: the JARC.Admin app role as last seen at a sign-in (users.adminRoleSeenAt / adminRoleClearedAt, routes/auth.js). True when
// the most recent sign-in that recorded anything carried the role. Evidence only: it never grants anything. It NEVER expires:
// only a later sign-in without the role clears it. That fails safe (it only protects), but a leaver who lost the role in Entra
// and never signs in again stays protected (TARGET_JARC_ADMIN), so suspending them needs a JARC administrator with a fresh
// sign-in (the access-admin exception for an acting JARC administrator).
const adminRoleHeld = (user) => user?.adminRoleSeenAt instanceof Date && !(user.adminRoleClearedAt instanceof Date && user.adminRoleClearedAt > user.adminRoleSeenAt);

const lower = (v) => (typeof v === "string" ? v.toLowerCase() : null);

// Whether this signed-in person may become the first Super Admin. Pure, so every rule is tested on its own.
//   superAdmin  the configured identity { tenantId, objectId, email? } (JARC_SUPER_ADMIN_*)
//   entra       the server's Entra settings (tenantId)
//   session     the stored session: verified tenantId + objectId, and isSystemAdmin = JARC.Admin app role at sign-in
//   user        the stored JARC user of the session
//   sameIdentityCount   users with this tenant + object ID (must be exactly 1)
//   sameEmailOthers     users with the configured email but another identity (must be 0: ambiguous mapping)
//   superAdmins         active Super Admins that already exist (must be 0: bootstrap is for the first one only)
function superAdminEligibility({ superAdmin, entra, session, user, sameIdentityCount, sameEmailOthers, superAdmins }) {
  const problems = [];
  if (!superAdmin) return { eligible: false, problems: ["no Super Admin identity is configured on this server"] };
  if (!entra || lower(superAdmin.tenantId) !== lower(entra.tenantId)) problems.push("the configured Super Admin tenant is not this server's Microsoft tenant");
  if (!session || lower(session.tenantId) !== lower(superAdmin.tenantId)) problems.push("the signed-in Microsoft tenant does not match");
  if (!session || lower(session.objectId) !== lower(superAdmin.objectId)) problems.push("the signed-in Microsoft account is not the configured administrator");
  if (!user || lower(user.tenantId) !== lower(session?.tenantId) || lower(user.entraObjectId) !== lower(session?.objectId)) problems.push("the JARC user does not match the signed-in identity");
  if (sameIdentityCount !== 1) problems.push("the identity maps to more than one JARC user");
  if (superAdmin.email && lower(user?.email) !== lower(superAdmin.email)) problems.push("the JARC user's email does not match the configured administrator email");
  if (sameEmailOthers > 0) problems.push("another JARC user has the administrator's email (ambiguous mapping)");
  if (session && session.isSystemAdmin !== true) problems.push("the sign-in did not carry the JARC administrator (JARC.Admin) authorization");
  if (user && user.status !== "active") problems.push("the JARC user is disabled");
  const account = accountOf(user);
  if (!account.legacy && account.status === "blocked") problems.push("the account is blocked");
  if (superAdmins > 0) problems.push("a Super Admin already exists");
  return { eligible: problems.length === 0, problems };
}

// What the Super Admin needs to review before ACCOUNT_MANAGEMENT=enforced (pure; see docs in the final report).
//   users: user documents; memberships: active workspaceMembers documents
function reconciliationReport(users, memberships) {
  const byUser = new Map();
  for (const m of memberships) { const k = m.userId.toHexString(); byUser.set(k, [...(byUser.get(k) || []), m]); }
  const rows = users.filter((u) => u.source === "entra").map((u) => {
    const account = accountOf(u), ms = byUser.get(u._id.toHexString()) || [];
    const overCap = account.legacy ? [] : ms.filter((m) => capWorkspaceRole(account, m.role) !== m.role).map((m) => ({ workspaceId: m.workspaceId.toHexString(), role: m.role, effective: capWorkspaceRole(account, m.role) }));
    return { userId: u._id.toHexString(), legacy: account.legacy, status: account.legacy ? "legacy" : account.status, role: account.role, disabled: u.status !== "active", workspaces: ms.length, overCap };
  });
  const count = (fn) => rows.filter(fn).length;
  const summary = { users: rows.length, legacy: count((r) => r.legacy), pending: count((r) => r.status === "pending"), active: count((r) => r.status === "active"), blocked: count((r) => r.status === "blocked"), superAdmins: count((r) => r.status === "active" && r.role === "SUPER_ADMIN"), activeWithoutWorkspace: count((r) => r.status === "active" && r.role !== "SUPER_ADMIN" && r.workspaces === 0), overCap: count((r) => r.overCap.length > 0) };
  const blockers = [];
  if (summary.superAdmins < 1) blockers.push("no active Super Admin");
  if (summary.legacy) blockers.push(`${summary.legacy} account(s) not reviewed yet`);
  return { summary, rows, readyToEnforce: blockers.length === 0, blockers };
}

// The confirmation phrase high-impact account changes must carry (typed by the Super Admin in the UI).
const CONFIRM = Object.freeze({ block: "BLOCK", superAdmin: "GRANT SUPER ADMIN", bootstrap: "I AM THE SUPER ADMIN" });

module.exports = { ACCOUNT_MODES, ACCOUNT_ROLES, ACCOUNT_STATUSES, WORKSPACE_CAP, WORKSPACE_RANK, accountOf, isActiveSuperAdmin, capWorkspaceRole, usableWorkspaceAdmin, adminRoleHeld, superAdminEligibility, reconciliationReport, CONFIRM };
