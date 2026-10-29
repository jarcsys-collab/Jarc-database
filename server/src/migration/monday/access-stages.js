// Staged access to the imported workspace (Phase M4.1). Plans membership changes and checks their approval; applies
// them ONLY on a verified local test target in this phase (production stays locked). Live permissions are never
// changed by this module, and nothing here invites anyone.
//
//   stage 1  the verified JARC administrator only (WORKSPACE_ADMIN); any other existing member is reported, never
//            removed automatically
//   stage 2  selected employees as VIEWER, chosen by the administrator
//   stage 3  selected employees as MEMBER (editors), chosen by the administrator; only people who passed stage 2
// Rules: only existing, active JARC users who signed in with Entra in the administrator's own tenant (no external or
// guest tenants; no invitations); monday.com authorship never grants anything (people are given by JARC user ID only);
// never a downgrade; each stage needs an approval by the administrator (Entra identity) naming the exact changes.
// Conflicts reported: ACCESS_POLICY=development_shared and JARC_BETA_OPEN_EDITING=true give every employee access
// regardless of these memberships, so a stage can't be considered effective while they are on.
// Account Management (Phase M4.3; config.accountMode staged/enforced): stage 1 is the active Super Admin; stage 2 only
// approved accounts; stage 3 only approved accounts whose global role allows editing (EDITOR, ADMIN) — a VIEWER account
// can't become an editor here. Pending and blocked accounts are never given access. Unless accounts are enforced,
// that is reported as a conflict. (The plan digest still covers exactly { stage, workspaceId, changes }.)
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { COLLECTIONS } = require("../../db/bootstrap");
const { isVerifiedTarget } = require("./target");
const { sameIdentity } = require("./production-target");
const { MigrationError, MigrationLockedError, PRODUCTION_EXECUTION_ENABLED } = require("./executor");

const STAGE_ROLE = { 1: "WORKSPACE_ADMIN", 2: "VIEWER", 3: "MEMBER" };
const RANK = { VIEWER: 1, MEMBER: 2, WORKSPACE_ADMIN: 3 };

// workspace: { _id }; members: its workspaceMembers documents; users: Map(hex → user document) of the people named;
// administrator: { tenantId, objectId } (verified Entra identity); requested: [{ userId (hex), role }].
function planAccessStage({ stage, workspace, members, users, administrator, requested, config = {} }) {
  const problems = [], conflicts = [], changes = [];
  if (![1, 2, 3].includes(stage)) return { stage, changes, problems: ["unknown stage"], conflicts };
  const role = STAGE_ROLE[stage];
  const memberOf = new Map(members.filter((m) => m.status === "active").map((m) => [m.userId.toHexString(), m]));
  const adminUser = [...users.values()].find((u) => sameIdentity({ tenantId: u.tenantId, objectId: u.entraObjectId }, administrator));
  if (!adminUser) problems.push("the verified administrator has no JARC user (sign in once with Entra first)");
  if (config.accessPolicy === "development_shared") conflicts.push("ACCESS_POLICY=development_shared: every employee is a workspace admin everywhere, so staged access has no effect");
  if (config.betaOpenEditing) conflicts.push("JARC_BETA_OPEN_EDITING=true: every employee can edit every workspace, so stages 2 and 3 don't limit editing");
  const accounts = config.accountMode === "staged" || config.accountMode === "enforced";
  if (accounts && config.accountMode !== "enforced") conflicts.push("ACCOUNT_MANAGEMENT=staged: account roles are recorded but not enforced yet");
  const accountOk = (u) => u.account && u.account.status === "active";
  if (accounts && adminUser && !(accountOk(adminUser) && adminUser.account.role === "SUPER_ADMIN")) problems.push("the verified administrator is not the active Super Admin account");
  const seen = new Set();
  for (const r of requested) {
    const id = String(r.userId || "");
    if (!/^[0-9a-f]{24}$/.test(id)) { problems.push("a requested person is not a JARC user ID"); continue; }
    if (seen.has(id)) { problems.push(`user ${id} is listed twice`); continue; }
    seen.add(id);
    if (r.role !== role) { problems.push(`stage ${stage} only grants ${role} (user ${id})`); continue; }
    const u = users.get(id);
    if (!u) { problems.push(`user ${id} is not a JARC user (no invitations are sent)`); continue; }
    if (u.source !== "entra" || u.status !== "active") { problems.push(`user ${id} is not an active Entra-signed-in user`); continue; }
    if (!administrator || String(u.tenantId).toLowerCase() !== String(administrator.tenantId).toLowerCase()) { problems.push(`user ${id} is not in the organisation's Entra tenant (external people are never added)`); continue; }
    const isAdmin = adminUser && u._id.equals(adminUser._id);
    if (accounts && !isAdmin && !accountOk(u)) { problems.push(`user ${id} has no approved JARC account (pending, blocked or not reviewed)`); continue; }
    if (accounts && stage === 3 && !["EDITOR", "ADMIN", "SUPER_ADMIN"].includes(u.account.role)) { problems.push(`user ${id} has a ${u.account.role} account; approve them as an Editor first`); continue; }
    if (stage === 1 && !isAdmin) { problems.push(`stage 1 is the verified administrator only (user ${id})`); continue; }
    if (stage > 1 && isAdmin) { problems.push("the administrator already has access from stage 1"); continue; }
    const current = memberOf.get(id);
    if (current && RANK[current.role] >= RANK[role]) continue; // nothing to do; never a downgrade
    if (stage === 3 && current?.role !== "VIEWER") { problems.push(`user ${id} must pass stage 2 (viewer) before becoming an editor`); continue; }
    changes.push({ userId: id, from: current?.role ?? null, to: role });
  }
  if (stage === 1) {
    if (!requested.length) problems.push("stage 1 needs the verified administrator");
    for (const [id, m] of memberOf) if (!adminUser || id !== adminUser._id.toHexString()) problems.push(`stage 1: the workspace already has another member (${m.role}); remove them manually or choose an empty workspace`);
  }
  const digest = crypto.createHash("sha256").update(JSON.stringify({ stage, workspaceId: workspace._id.toHexString(), changes })).digest("hex");
  return { stage, workspaceId: workspace._id.toHexString(), changes, digest, problems, conflicts };
}

function checkAccessApproval(approval, plan, { administrator, now = new Date() }) {
  const p = [];
  if (!approval || approval.kind !== "workspace-access-approval" || approval.version !== 1) return ["not a version 1 workspace-access approval"];
  if (approval.stage !== plan.stage || approval.workspaceId !== plan.workspaceId) p.push("the approval is for another stage or workspace");
  if (approval.changesDigest !== plan.digest) p.push("the approval names different changes");
  if (!sameIdentity(approval.approver, administrator)) p.push("only the verified JARC administrator can approve access stages");
  const exp = Date.parse(approval.expiresAt), at = Date.parse(approval.approvedAt);
  if (Number.isNaN(at) || at > now.getTime() || Number.isNaN(exp) || exp <= now.getTime() || exp - at > 24 * 3600 * 1000) p.push("the approval is expired or invalid (at most 24 h)");
  if (plan.conflicts.length && approval.acknowledgeConflicts !== true) p.push("the access conflicts must be acknowledged in the approval");
  if (plan.problems.length) p.push("the stage plan has problems");
  return p;
}

// Applies an approved stage (local test target only in this phase).
async function applyAccessStage({ client, target, plan, approval, administrator, now = () => new Date() }) {
  if (require("./production-target").isVerifiedProductionTarget(target) || (!isVerifiedTarget(target) && !PRODUCTION_EXECUTION_ENABLED)) throw new MigrationLockedError("Changing workspace access in production is disabled in this phase.");
  const problems = checkAccessApproval(approval, plan, { administrator, now: now() });
  if (problems.length) throw new MigrationError("ACCESS_NOT_AUTHORIZED", `Not authorized: ${problems[0]}`, { problems });
  const col = client.db(target.dbName).collection(COLLECTIONS.workspaceMembers), workspaceId = new ObjectId(plan.workspaceId), at = now();
  for (const c of plan.changes) {
    const userId = new ObjectId(c.userId);
    if (c.from === null) await col.insertOne({ workspaceId, userId, role: c.to, status: "active", createdAt: at, updatedAt: at, grantedBy: "migration-access-stage", stage: plan.stage });
    else { const r = await col.updateOne({ workspaceId, userId, status: "active", role: c.from }, { $set: { role: c.to, updatedAt: at } }); if (r.matchedCount !== 1) throw new MigrationError("ACCESS_CHANGED_MEANWHILE", `The membership of ${c.userId} changed since the plan was made.`); }
  }
  return { applied: plan.changes.length };
}

module.exports = { planAccessStage, checkAccessApproval, applyAccessStage, STAGE_ROLE };
