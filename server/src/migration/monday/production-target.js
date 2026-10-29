// Production target verification and production approvals (Phase M4.1). IMPLEMENTED AND TESTED WITH MOCKS ONLY.
// Production execution stays disabled (executor.PRODUCTION_EXECUTION_ENABLED = false): even a fully verified
// production target and a valid approval are refused by the executor in this build.
//
// Target (all required):
//   cluster      mongodb+srv to exactly one allowlisted JARC Atlas host, written in reviewed code (PRODUCTION_POLICY);
//                the server's replica set name and member hosts must match it. Today the allowlist is EMPTY, so every
//                production target is refused until a reviewed change names the cluster.
//   database     exactly jarc_database
//   credentials  a temporary user named jarc_migration_<suffix>; `connectionStatus` (with privileges) must show
//                privileges on jarc_database ONLY — any other database (ReceiptFlow included), any cluster-wide
//                action or any "any database" role refuses the target
// Approval (version 3, scope "production"):
//   exact plan digest, jarc_database, the allowlisted cluster, target workspace, a backup reference (Atlas snapshot ID
//   or a checksummed mongodump) taken within 24 h before the window, a named maintenance window that is open now (at
//   most 4 h), an expiry (at most 24 h), the approver and the operator as Entra identities (tenant + object ID), and
//   the operator's fresh Entra sign-in (ID token verified by JARC's Entra verifier: JARC.Admin role, signed in within
//   15 minutes, same tenant + object ID).
// Administrators: approval authority belongs ONLY to Entra identities listed in the migration administrator policy
// (tenant + object ID; an email is never an identity). With a single administrator, approver and operator may be the
// same person; set requireSeparateApprover to require two different people once a second administrator exists.
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[?::1\]?)$/i;

// Reviewed, in code. Empty until a separate reviewed change names the production cluster and administrators.
const PRODUCTION_POLICY = Object.freeze({
  clusterHosts: Object.freeze([]),        // e.g. "jarc-cluster.abcde.mongodb.net" (the SRV host)
  replicaSetName: null,                    // e.g. "atlas-xxxx-shard-0"
  memberHostSuffix: null,                  // e.g. ".abcde.mongodb.net"
  dbName: "jarc_database",
  administrators: Object.freeze([]),       // [{ tenantId, objectId, label }] — Entra identities with approval authority
  requireSeparateApprover: false,          // single administrator today; recommended true once a second one exists
  freshSignInSeconds: 15 * 60,
  maxWindowHours: 4,
  maxBackupAgeHours: 24
});

class ProductionTargetRefused extends Error { constructor(problems) { super(`Refusing the production target: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}`); this.name = "ProductionTargetRefused"; this.code = "MIGRATION_PRODUCTION_TARGET_REFUSED"; this.problems = problems; } }
const verifiedProduction = new WeakSet();
const isVerifiedProductionTarget = (t) => verifiedProduction.has(t);

function srvHost(uri) { const m = /^mongodb\+srv:\/\/(?:[^@/?#]*@)?([^/?#,]+)(\/[^?#]*)?/i.exec(String(uri || "")); return m ? { host: m[1].toLowerCase(), pathDb: decodeURIComponent((m[2] || "/").slice(1)) } : null; }

function checkProductionStatic({ uri, dbName, policy = PRODUCTION_POLICY }) {
  const problems = [];
  if (!policy.clusterHosts.length) problems.push("no production cluster is approved in code (PRODUCTION_POLICY.clusterHosts is empty)");
  const srv = srvHost(uri);
  if (!srv) problems.push("production targets must use the cluster's mongodb+srv address");
  else {
    if (!policy.clusterHosts.includes(srv.host)) problems.push("the connection string names a cluster that is not the approved JARC cluster");
    if (srv.pathDb && srv.pathDb !== policy.dbName) problems.push("the connection string names another database in its path");
    if (LOOPBACK.test(srv.host)) problems.push("a loopback host is not a production target");
  }
  if (dbName !== policy.dbName) problems.push(`the production database must be exactly ${policy.dbName}`);
  return problems;
}

// Privileges of the connected user: only jarc_database; no cluster or any-database powers; a temporary migration user.
function checkPrivileges(status, policy = PRODUCTION_POLICY) {
  const problems = [];
  const info = status?.authInfo || {};
  const users = info.authenticatedUsers || [];
  if (users.length !== 1 || !/^jarc_migration_[a-z0-9]{2,24}$/.test(users[0].user || "")) problems.push("the connection must use one temporary jarc_migration_<suffix> user");
  for (const r of info.authenticatedUserRoles || []) {
    if (/AnyDatabase$|^root$|^clusterAdmin$|^atlasAdmin$|^dbOwner$|^userAdmin/.test(r.role) || (r.db !== policy.dbName && r.db !== "admin")) problems.push(`the user holds role ${r.role}@${r.db}, which reaches beyond ${policy.dbName}`);
    if (r.db === "admin" && !/^jarcMigration[A-Za-z]*$/.test(r.role)) problems.push(`the user holds the admin-database role ${r.role}`);
  }
  for (const p of info.authenticatedUserPrivileges || []) {
    const res = p.resource || {};
    if (res.cluster || res.anyResource) problems.push("the user has cluster-wide privileges");
    else if (res.db !== policy.dbName) problems.push(`the user has privileges on ${res.db === "" ? "every database" : `database ${res.db}`}`);
  }
  if (!(info.authenticatedUserPrivileges || []).length) problems.push("the user's privileges could not be read");
  return [...new Set(problems)];
}

async function verifyProductionTarget({ client, uri, dbName, policy = PRODUCTION_POLICY }) {
  const problems = checkProductionStatic({ uri, dbName, policy });
  if (problems.length) throw new ProductionTargetRefused(problems);
  const admin = client.db("admin");
  const hello = await admin.command({ hello: 1 });
  if (!hello.setName || hello.setName !== policy.replicaSetName) problems.push("the server's replica set is not the approved cluster");
  for (const h of [hello.me, ...(hello.hosts || [])].filter(Boolean)) if (!policy.memberHostSuffix || !String(h).toLowerCase().replace(/:\d+$/, "").endsWith(policy.memberHostSuffix)) problems.push("a cluster member is outside the approved cluster");
  if (hello.msg === "isdbgrid") problems.push("the server is a mongos router, not the approved replica set");
  problems.push(...checkPrivileges(await admin.command({ connectionStatus: 1, showPrivileges: true }), policy));
  if (problems.length) throw new ProductionTargetRefused([...new Set(problems)]);
  const target = Object.freeze({ scope: "production", dbName, cluster: srvHost(uri).host, replicaSet: hello.setName });
  verifiedProduction.add(target);
  return target;
}

const sameIdentity = (a, b) => Boolean(a && b && a.tenantId && a.objectId && String(a.tenantId).toLowerCase() === String(b.tenantId).toLowerCase() && String(a.objectId).toLowerCase() === String(b.objectId).toLowerCase());
const isAdministrator = (who, policy) => policy.administrators.some((a) => sameIdentity(a, who));

// operatorAuth: the result of JARC's Entra ID-token verification for the operator's fresh sign-in
// ({ tid, oid, roles, auth_time | iat }). Returns problems (empty = authorized for a production run).
function checkProductionApproval(approval, { planDigest, target, operatorAuth, expectedCounts, workspace, now = new Date(), policy = PRODUCTION_POLICY }) {
  const p = [];
  if (!approval || approval.kind !== "monday-migration-approval" || approval.version !== 3 || approval.scope !== "production") return ["not a version 3 production approval"];
  if (!target || target.scope !== "production") p.push("the target is not a verified production target");
  if (approval.planDigest !== planDigest) p.push("the approval was given for a different plan (digest mismatch)");
  if (approval.targetDatabase !== policy.dbName || approval.targetDatabase !== target?.dbName) p.push("the approval names a different database");
  if (approval.targetCluster !== target?.cluster || !policy.clusterHosts.includes(approval.targetCluster)) p.push("the approval names a different cluster");
  if (!/^[0-9a-f]{24}$/.test(String(approval.targetWorkspaceId || "")) || !workspace || workspace._id.toHexString() !== approval.targetWorkspaceId) p.push("the target workspace is missing or different");
  const t = now.getTime(), hour = 3600 * 1000;
  const exp = Date.parse(approval.expiresAt), approvedAt = Date.parse(approval.approvedAt);
  if (Number.isNaN(approvedAt) || approvedAt > t) p.push("the approval date is invalid");
  if (Number.isNaN(exp) || exp <= t) p.push("the approval has expired");
  else if (exp - approvedAt > 24 * hour) p.push("the approval is valid for more than 24 hours");
  const ws = Date.parse(approval.window?.start), we = Date.parse(approval.window?.end);
  if (typeof approval.window?.name !== "string" || !approval.window.name.trim()) p.push("the maintenance window has no name");
  if (Number.isNaN(ws) || Number.isNaN(we) || we <= ws || we - ws > policy.maxWindowHours * hour) p.push(`the maintenance window is invalid or longer than ${policy.maxWindowHours} h`);
  else if (t < ws || t > we) p.push("the maintenance window is not open now");
  const b = approval.backup || {};
  const taken = Date.parse(b.takenAt);
  if (!["atlas-snapshot", "mongodump"].includes(b.kind) || typeof b.reference !== "string" || !b.reference.trim()) p.push("the approval has no backup reference");
  else if (b.kind === "mongodump" && !/^[0-9a-f]{64}$/.test(String(b.sha256 || ""))) p.push("a mongodump backup needs its SHA-256");
  if (Number.isNaN(taken) || Number.isNaN(ws) || taken > ws || ws - taken > policy.maxBackupAgeHours * hour) p.push(`the backup must be taken within ${policy.maxBackupAgeHours} h before the window`);
  if (!isAdministrator(approval.approver, policy)) p.push("the approver is not a JARC migration administrator (verified Entra identity)");
  if (!isAdministrator(approval.operator, policy)) p.push("the operator is not a JARC migration administrator (verified Entra identity)");
  if (policy.requireSeparateApprover && sameIdentity(approval.approver, approval.operator)) p.push("this policy requires a separate approver and operator");
  const auth = operatorAuth || {};
  if (!sameIdentity({ tenantId: auth.tid, objectId: auth.oid }, approval.operator)) p.push("the operator's sign-in is not the operator named in the approval");
  if (!Array.isArray(auth.roles) || !auth.roles.includes("JARC.Admin")) p.push("the operator's sign-in does not carry the JARC.Admin role");
  const signedIn = Number(auth.auth_time ?? auth.iat) * 1000;
  if (!Number.isFinite(signedIn) || t - signedIn > policy.freshSignInSeconds * 1000 || signedIn > t + 60000) p.push("the operator must have signed in within the last 15 minutes");
  if (JSON.stringify(approval.expectedCounts || {}) !== JSON.stringify(expectedCounts || {})) p.push("the approval's expected counts differ from the plan");
  return p;
}

module.exports = { PRODUCTION_POLICY, verifyProductionTarget, isVerifiedProductionTarget, checkProductionStatic, checkPrivileges, checkProductionApproval, sameIdentity, ProductionTargetRefused };
