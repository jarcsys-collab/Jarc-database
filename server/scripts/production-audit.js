#!/usr/bin/env node
// READ-ONLY production audit of jarc_database (Phase M4.2A). Run it yourself; it never writes.
//
//   node server/scripts/production-audit.js [--admin-email you@company] [--out monday-migration/audit]
//
// Credentials: ONLY JARC_AUDIT_MONGODB_URI, read from .env.audit at the repository root (ignored by Git and Docker),
// for a temporary Atlas user with the single built-in role read@jarc_database. server/.env is never read.
// Before any query the script proves the connection is read-only and limited to jarc_database (connectionStatus with
// privileges): any write action, any other database (ReceiptFlow included), any cluster or any-database privilege →
// it stops. Outgoing connections are allowed only to the cluster's own hosts.
// Output: identifiers, counts and byte totals only — never record contents, names, emails, file names, passwords or
// connection strings. The admin lookup prints only the tenant ID and Entra object ID of the matching JARC user, to
// compare with what Microsoft Entra shows (an email alone is never treated as identity).
"use strict";
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const DB = "jarc_database";
const READ_ACTIONS = new Set(["find", "listCollections", "listIndexes", "collStats", "dbStats", "dbHash", "killCursors", "listSearchIndexes", "planCacheRead", "changeStream"]);
const args = process.argv.slice(2);
const val = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const log = (m) => process.stdout.write(`${m}\n`);

function readUri() {
  const file = path.join(ROOT, ".env.audit");
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const m = /^\s*JARC_AUDIT_MONGODB_URI\s*=\s*(.*?)\s*$/.exec(line); if (m) return m[1]; }
  return null;
}
const srvHost = (uri) => { const m = /^mongodb\+srv:\/\/(?:[^@/?#]*@)?([^/?#,]+)/i.exec(uri || ""); return m ? m[1].toLowerCase() : null; };

// Pure checks (unit-tested): the connection must be read-only on jarc_database only.
function checkReadOnly(status) {
  const p = [];
  const info = status?.authInfo || {};
  const roles = info.authenticatedUserRoles || [];
  if (!(info.authenticatedUsers || []).length) p.push("not authenticated");
  if (roles.length !== 1 || roles[0].role !== "read" || roles[0].db !== DB) p.push(`the user must have exactly one role, read@${DB} (found: ${roles.map((r) => `${r.role}@${r.db}`).join(", ") || "none"})`);
  const privileges = info.authenticatedUserPrivileges || [];
  if (!privileges.length) p.push("the user's privileges could not be read");
  for (const pr of privileges) {
    const res = pr.resource || {};
    if (res.cluster || res.anyResource) p.push("the user has cluster-wide privileges");
    else if (res.db !== DB) p.push(`the user has privileges outside ${DB}`);
    const writes = (pr.actions || []).filter((a) => !READ_ACTIONS.has(a));
    if (writes.length) p.push(`the user can do more than read (${writes.slice(0, 5).join(", ")})`);
  }
  return [...new Set(p)];
}

// Pure summary of what was read (unit-tested with a fake database).
async function collect(db, { adminEmail = null } = {}) {
  const out = {};
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
  out.collections = {};
  for (const n of names) out.collections[n] = await db.collection(n).estimatedDocumentCount();
  const has = (n) => names.includes(n);
  if (has("attachments")) {
    const rows = await db.collection("attachments").aggregate([{ $group: { _id: { provider: { $ifNull: ["$storage.provider", "gridfs"] }, status: "$status" }, files: { $sum: 1 }, bytes: { $sum: { $ifNull: ["$size", 0] } } } }]).toArray();
    out.attachments = rows.map((r) => ({ provider: r._id.provider, status: r._id.status, files: r.files, mb: +(r.bytes / 1048576).toFixed(1) }));
  }
  if (has("attachmentFiles.files")) {
    const [g] = await db.collection("attachmentFiles.files").aggregate([{ $group: { _id: null, files: { $sum: 1 }, bytes: { $sum: "$length" } } }]).toArray();
    out.gridfsStored = g ? { files: g.files, mb: +(g.bytes / 1048576).toFixed(1) } : { files: 0, mb: 0 };
  }
  if (has("users")) {
    out.users = (await db.collection("users").aggregate([{ $group: { _id: { source: "$source", status: "$status" }, n: { $sum: 1 } } }]).toArray()).map((r) => ({ source: r._id.source ?? null, status: r._id.status ?? null, count: r.n }));
    if (adminEmail) {
      const matches = await db.collection("users").find({ emailNormalized: String(adminEmail).toLowerCase() }, { projection: { _id: 0, tenantId: 1, entraObjectId: 1, source: 1, status: 1 }, limit: 3 }).toArray();
      out.administratorCandidates = matches.map((m) => ({ tenantId: m.tenantId ?? null, entraObjectId: m.entraObjectId ?? null, source: m.source ?? null, status: m.status ?? null }));
    }
  }
  if (has("workspaces") && has("workspaceMembers")) {
    const workspaces = await db.collection("workspaces").find({}, { projection: { _id: 1, archived: 1 } }).toArray();
    const members = await db.collection("workspaceMembers").find({ status: "active" }, { projection: { _id: 0, workspaceId: 1, userId: 1, role: 1 } }).toArray();
    const byWs = new Map(workspaces.map((w) => [w._id.toHexString(), []]));
    for (const m of members) byWs.get(m.workspaceId?.toHexString?.())?.push(m);
    const activeUsers = has("users") ? await db.collection("users").find({ status: "active" }, { projection: { _id: 1 } }).toArray() : [];
    const withMembership = new Set(members.map((m) => m.userId?.toHexString?.()));
    out.access = {
      workspaces: workspaces.length, archivedWorkspaces: workspaces.filter((w) => w.archived).length,
      membershipsByRole: members.reduce((m, x) => ((m[x.role] = (m[x.role] || 0) + 1), m), {}),
      workspacesWithoutAnyMember: [...byWs.values()].filter((l) => !l.length).length,
      workspacesWithoutAdmin: [...byWs.values()].filter((l) => !l.some((m) => m.role === "WORKSPACE_ADMIN")).length,
      activeUsersWithoutAnyMembership: activeUsers.filter((u) => !withMembership.has(u._id.toHexString())).length,
      note: "Under ACCESS_POLICY=role_based with beta open editing off, people only see workspaces they are members of (JARC.Admin sees all)."
    };
  }
  if (has("boards")) out.boards = { total: await db.collection("boards").countDocuments({}), mondayImported: await db.collection("boards").countDocuments({ legacyId: /^monday-/ }), syncedReadOnly: await db.collection("boards").countDocuments({ "source.readOnly": true }) };
  if (has("integrationMappings")) out.migrationMappings = await db.collection("integrationMappings").countDocuments({ provider: "monday-migration" });
  return out;
}

async function main() {
  const uri = readUri();
  if (!uri) { log("No JARC_AUDIT_MONGODB_URI in .env.audit. Nothing was contacted."); process.exitCode = 2; return; }
  const host = srvHost(uri);
  if (!host || !/\.mongodb\.net$/.test(host)) { log("JARC_AUDIT_MONGODB_URI must be the Atlas cluster's mongodb+srv address."); process.exitCode = 2; return; }
  if (/mongodb\+srv:\/\/[^@]*@[^/]*\/[^?]/.test(uri) && !new RegExp(`/${DB}(\\?|$)`).test(uri)) { log(`The connection string names another database in its path; use /${DB} or none.`); process.exitCode = 2; return; }
  // Only the cluster's own hosts (same domain as the SRV host) may be contacted; DNS lookups are made by Node itself.
  const domain = host.split(".").slice(1).join(".");
  const allowed = (h) => typeof h === "string" && (h === host || h.endsWith(`.${domain}`));
  const guard = (orig, pick) => function (...a) { const o = pick(a); if (!allowed(o?.host || o?.servername)) throw new Error("Blocked: only the Atlas cluster may be contacted."); return orig.apply(this, a); };
  const firstArg = (a) => { const x = Array.isArray(a[0]) ? a[0][0] : a[0]; return x && typeof x === "object" ? x : { host: typeof a[1] === "string" ? a[1] : undefined }; };
  net.Socket.prototype.connect = guard(net.Socket.prototype.connect, firstArg);
  tls.connect = guard(tls.connect, firstArg);
  globalThis.fetch = () => { throw new Error("Blocked."); };

  const { MongoClient } = require("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, appName: "jarc-production-audit-readonly", readPreference: "secondaryPreferred" });
  try {
    await client.connect();
    const admin = client.db(DB);
    const status = await admin.command({ connectionStatus: 1, showPrivileges: true });
    const problems = checkReadOnly(status);
    if (problems.length) { log("STOPPED before reading anything: the audit user is not read-only on jarc_database."); for (const p of problems) log(`  - ${p}`); process.exitCode = 3; return; }
    const hello = await admin.command({ hello: 1 });
    let atlas = null; try { atlas = (await admin.command({ atlasVersion: 1 })).atlasVersion || "yes"; } catch { /* not exposed */ }
    const build = await admin.command({ buildInfo: 1 });
    const stats = await admin.command({ dbStats: 1, scale: 1048576 });
    const report = {
      at: new Date().toISOString(), readOnlyVerified: true,
      cluster: { srvHost: host, replicaSet: hello.setName || null, memberHosts: (hello.hosts || []).map((h) => String(h)), memberHostSuffix: `.${domain}`, mongodbVersion: build.version, atlas: Boolean(atlas) },
      database: { name: DB, dataMB: +Number(stats.dataSize).toFixed(1), storageMB: +Number(stats.storageSize).toFixed(1), indexMB: +Number(stats.indexSize).toFixed(1) },
      ...(await collect(admin, { adminEmail: val("--admin-email") }))
    };
    const outDir = path.resolve(val("--out", path.join(ROOT, "monday-migration", "audit")));
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `production-audit-${report.at.replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    log(JSON.stringify(report, null, 2));
    log(`saved: ${path.relative(ROOT, file)}`);
  } catch (error) {
    log(`FAILED: ${error.name}: ${String(error.message).replace(/mongodb(\+srv)?:\/\/[^\s"']*/gi, "mongodb://<redacted>")}`);
    process.exitCode = 1;
  } finally { await client.close().catch(() => {}); }
}

if (require.main === module) main();
module.exports = { checkReadOnly, collect, READ_ACTIONS };
