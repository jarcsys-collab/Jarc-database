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

// P4-0: the JARC.Admin app role as SEEN AT THE PERSON'S LAST SIGN-IN (users.adminRoleSeenAt / adminRoleClearedAt, routes/auth.js).
// True when the most recent sign-in that recorded anything carried the role. A historical observation, never a statement about
// Microsoft Entra ID now: it never grants anything and it NEVER expires (only a later sign-in without the role clears it). It
// fails safe (it only protects): a leaver who lost the role in Entra and never signs in again stays protected (TARGET_JARC_ADMIN).
const adminRoleHeld = (user) => user?.adminRoleSeenAt instanceof Date && !(user.adminRoleClearedAt instanceof Date && user.adminRoleClearedAt > user.adminRoleSeenAt);
// Whether any sign-in since this change recorded the role either way (adminRoleSeenAt or adminRoleClearedAt).
const adminRoleObserved = (user) => user?.adminRoleSeenAt instanceof Date || user?.adminRoleClearedAt instanceof Date;

const lower = (v) => (typeof v === "string" ? v.toLowerCase() : null);

// P4-0 (D-H2): what JARC's own records can say about whether this person is a JARC administrator. Pure; never the directory
// snapshot, never Microsoft Graph, never a guess. Inputs:
//   user          the stored users document (tenantId, entraObjectId, account, adminRoleSeenAt / adminRoleClearedAt)
//   superAdmin    the configured JARC_SUPER_ADMIN_* identity { tenantId, objectId } (or null)
//   liveSessions  the person's live JARC sessions ({ isSystemAdmin } each: the JARC.Admin role in the ID token of that sign-in)
// → one of
//   "super_admin"  an active Super Admin account (Account Management)                                    RECOGNISED
//   "configured"   the configured JARC_SUPER_ADMIN_* identity                                            RECOGNISED
//   "role"         JARC.Admin seen at their last recorded sign-in, or carried by a live session          RECOGNISED
//   "not_seen"     a sign-in since this change (or a live session) did NOT carry JARC.Admin              known non-administrator
//   "unknown"      no observation since this change and no live session: JARC can't tell                 (fail closed)
// What this can't establish: whether the person can still sign in to Microsoft, and whether Entra still assigns JARC.Admin today
// (both need fresh Entra information: a new sign-in, or a directory read this deliberately does not make).
const RECOGNISED_ADMIN = Object.freeze(["super_admin", "configured", "role"]);
function jarcAdminStatus({ user, superAdmin = null, liveSessions = [] }) {
  if (!user) return "unknown";
  if (isActiveSuperAdmin(accountOf(user))) return "super_admin";
  if (superAdmin?.objectId && lower(superAdmin.tenantId) === lower(user.tenantId) && lower(superAdmin.objectId) === lower(user.entraObjectId)) return "configured";
  const live = Array.isArray(liveSessions) ? liveSessions : [];
  if (adminRoleHeld(user) || live.some((s) => s?.isSystemAdmin === true)) return "role";
  if (adminRoleObserved(user) || live.length > 0) return "not_seen";
  return "unknown";
}
// The refusal in words, per basis (TARGET_JARC_ADMIN for the recognised kinds, ADMIN_STATUS_UNKNOWN for "unknown"). Worded as what
// JARC saw, never as a statement about Microsoft Entra ID now.
const JARC_ADMIN_MESSAGES = Object.freeze({
  super_admin: "This person has an active JARC Super Admin account, so their JARC access can't be suspended, revoked or blocked here.",
  configured: "This person is the configured JARC Super Admin, so their JARC access can't be suspended, revoked or blocked here.",
  role: "JARC saw the JARC administrator role (JARC.Admin) at this person's last sign-in, or in a JARC session that is still open, so their JARC access can't be suspended, revoked or blocked here. This is what JARC saw at that sign-in, not a live check: if the role has since been removed in Microsoft Entra ID, JARC sees that at their next sign-in. Disabling the person in Microsoft Entra ID blocks new sign-ins; their existing JARC and Fabric API keys must be revoked separately by an API administrator in Developer → API Keys.",
  unknown: "JARC doesn't know whether this person is a JARC administrator: it hasn't recorded a sign-in from them since this check was introduced, so their JARC access can't be suspended, revoked or blocked here yet. If they can still sign in, one JARC sign-in lets JARC see their role. Disabling them in Microsoft Entra ID blocks new sign-ins (if it isn't already disabled); their existing JARC and Fabric API keys must be revoked separately by an API administrator in Developer → API Keys."
});
const jarcAdminMessage = (kind) => JARC_ADMIN_MESSAGES[kind] || JARC_ADMIN_MESSAGES.unknown;
// The refusal code for a person about to lose access (null: allowed).
const jarcAdminRefusal = (kind) => (RECOGNISED_ADMIN.includes(kind) ? "TARGET_JARC_ADMIN" : kind === "unknown" ? "ADMIN_STATUS_UNKNOWN" : null);

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

module.exports = { ACCOUNT_MODES, ACCOUNT_ROLES, ACCOUNT_STATUSES, WORKSPACE_CAP, WORKSPACE_RANK, RECOGNISED_ADMIN, accountOf, isActiveSuperAdmin, capWorkspaceRole, usableWorkspaceAdmin, adminRoleHeld, adminRoleObserved, jarcAdminStatus, jarcAdminMessage, jarcAdminRefusal, JARC_ADMIN_MESSAGES, superAdminEligibility, reconciliationReport, CONFIRM };
