#!/usr/bin/env node
// One-time monday.com → JARC migration (Phases M2–M3).
//
//   dry-run       [--source DIR] [--out DIR] [--users FILE]        offline: plan, validation and reports; no writes
//   approve-local --workspace ID --approved-by NAME [--hours N] [--db DB] [--users FILE]
//                 writes a LOCAL-TEST approval bound to this plan digest and the verified local test instance
//   execute       --approval FILE [--db DB] [--users FILE]           import into the verified LOCAL TEST instance only
//   verify        --workspace ID [--db DB] [--users FILE]            read-back fidelity check of a finished import
//
// Production execution is disabled. The only database this tool will write to is the local test instance described
// by .env.migration-test (written by migration-test-db.js): loopback host, guard marker, matching instance ID.
// server/.env is never read. Outgoing connections are blocked for the whole process except to loopback addresses
// (dry-run blocks everything). Terminal output is limited to status, counts and IDs.
"use strict";
const net = require("net");
const tls = require("tls");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const command = process.argv[2];
{
  const refuse = () => { throw new Error("Network access to non-loopback hosts is disabled for the migration tool."); };
  const allowLoopback = (orig) => function (...a) {
    // net.connect()/createConnection() hand Socket#connect their normalized arguments as one array: [options, cb].
    const args = Array.isArray(a[0]) ? a[0] : a;
    const o = args[0] && typeof args[0] === "object" ? args[0] : { port: args[0], host: typeof args[1] === "string" ? args[1] : undefined };
    if (command === "dry-run" || o.path || !LOOPBACK.has(String(o.host ?? "localhost").replace(/^\[|\]$/g, ""))) refuse();
    return orig.apply(this, a);
  };
  globalThis.fetch = refuse;
  net.Socket.prototype.connect = allowLoopback(net.Socket.prototype.connect);
  tls.connect = refuse;
}

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");
const { dryRun } = require("../src/migration/monday");
const { writeReports } = require("../src/migration/monday/report");
const { runImport, planCounts, SCOPE, MigrationError } = require("../src/migration/monday/executor");
const { verifyTarget, TargetRefusedError } = require("../src/migration/monday/target");
const { verifyFidelity } = require("../src/migration/monday/fidelity");
const { SourceError } = require("../src/migration/monday/source");

const ROOT = path.resolve(__dirname, "../..");
const args = process.argv.slice(3);
const has = (n) => args.includes(n);
const val = (n, d = null) => (has(n) ? args[args.indexOf(n) + 1] : d);
const opt = (n, d) => (has(n) ? path.resolve(val(n) || "") : d);
const log = (m) => process.stdout.write(`${m}\n`);
const SOURCE = () => opt("--source", path.join(ROOT, "monday-extraction"));
const users = () => (has("--users") ? JSON.parse(fs.readFileSync(opt("--users"), "utf8")) : null);
const redact = (s) => String(s).replace(/mongodb(\+srv)?:\/\/[^\s"']*/gi, "mongodb://<redacted>");

// Only JARC_MIGRATION_TEST_* keys, only from .env.migration-test (never server/.env).
function testEnv() {
  const file = path.join(ROOT, ".env.migration-test"), out = {};
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const m = /^\s*(JARC_MIGRATION_TEST_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m) out[m[1]] = m[2]; }
  return { uri: out.JARC_MIGRATION_TEST_MONGODB_URI, dbName: val("--db", out.JARC_MIGRATION_TEST_DB), instanceId: out.JARC_MIGRATION_TEST_INSTANCE_ID };
}
async function connectVerified() {
  const env = testEnv();
  const client = new MongoClient(env.uri || "mongodb://invalid", { serverSelectionTimeoutMS: 5000, appName: "jarc-monday-migration-local-test" });
  // Static checks before any connection attempt.
  const { checkStatic } = require("../src/migration/monday/target");
  const pre = checkStatic({ uri: env.uri, dbName: env.dbName, instanceId: env.instanceId });
  if (pre.length) throw new TargetRefusedError(pre);
  await client.connect();
  try { return { client, target: await verifyTarget({ client, ...env }) }; } catch (e) { await client.close(); throw e; }
}

async function main() {
  if (command === "dry-run") {
    const outDir = opt("--out", path.join(ROOT, "monday-migration", "dry-run")), sourceDir = SOURCE();
    if (path.resolve(outDir) === path.resolve(sourceDir) || path.resolve(outDir).startsWith(path.resolve(sourceDir) + path.sep)) { log("The output folder must not be inside the extraction folder (extraction files are never modified)."); process.exitCode = 2; return; }
    const started = Date.now(), result = dryRun(sourceDir, { confirmedUsers: users() });
    const { report } = writeReports(outDir, result), v = result.validation;
    log(`Dry run: ${report.status} in ${((Date.now() - started) / 1000).toFixed(1)}s — database writes 0, network requests 0`);
    log(`  planned: items ${v.counts.items}, subitems ${v.counts.subitems}, updates ${v.counts.updates}, replies ${v.counts.replies}; columns ${report.destination.board.columns} + ${report.destination.subitemsBoard.columns}; groups ${report.destination.board.groups}`);
    log(`  attachments: ${report.attachments.plannedReferences}/${report.attachments.sourceReferences} references traceable, ${report.attachments.uniqueAssets} unique, stored in JARC ${report.attachments.storedInJarc}`);
    log(`  issues: errors ${v.errors.length}, warnings ${v.warnings.length}, info ${v.info.length}`);
    for (const [k, n] of Object.entries(v.summary)) log(`    ${k}: ${n}`);
    log(`  plan digest ${result.digest}`);
    log(`  reports: ${path.relative(ROOT, outDir) || outDir}`);
    if (!v.ok) process.exitCode = 1;
    return;
  }
  if (command === "approve-local") {
    const workspace = val("--workspace"), approvedBy = val("--approved-by"), hours = Number(val("--hours", "2"));
    if (!/^[0-9a-f]{24}$/.test(workspace || "") || !approvedBy || !(hours > 0 && hours <= 24)) { log("Usage: approve-local --workspace ID --approved-by NAME [--hours 1-24]"); process.exitCode = 2; return; }
    const { client, target } = await connectVerified();
    await client.close();
    const r = dryRun(SOURCE(), { confirmedUsers: users() });
    if (!r.validation.ok) { log("The dry run has blocking errors; no approval written."); process.exitCode = 1; return; }
    const now = new Date();
    const approval = { kind: "monday-migration-approval", version: 2, scope: "local-test", planDigest: r.digest, targetDatabase: target.dbName, targetInstanceId: target.instanceId, targetWorkspaceId: workspace, approvedBy, operator: os.userInfo().username, approvedAt: now.toISOString(), expiresAt: new Date(now.getTime() + hours * 3600 * 1000).toISOString(), include: [...SCOPE], expectedCounts: planCounts(r.plan), nonce: crypto.randomUUID() };
    const dir = path.join(ROOT, "monday-migration", "approvals"); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `local-test-${r.plan.runId}-${now.toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, `${JSON.stringify(approval, null, 2)}\n`);
    log(`local-test approval written: ${path.relative(ROOT, file)} (digest ${r.digest.slice(0, 12)}…, database ${target.dbName}, expires ${approval.expiresAt})`);
    return;
  }
  if (command === "execute" || command === "verify") {
    if ((command === "execute" && !(val("--approval") && fs.existsSync(opt("--approval")) && fs.statSync(opt("--approval")).isFile())) || (command === "verify" && !/^[0-9a-f]{24}$/.test(val("--workspace") || ""))) { log(`Usage: ${command === "execute" ? "execute --approval FILE" : "verify --workspace ID"} [--db DB]`); process.exitCode = 2; return; }
    const approval = command === "execute" ? JSON.parse(fs.readFileSync(opt("--approval"), "utf8")) : null;
    const { client, target } = await connectVerified();
    try {
      log(`verified local test target: ${target.host}, replica set ${target.replicaSet}, MongoDB ${target.serverVersion}, database ${target.dbName}`);
      const r = dryRun(SOURCE(), { confirmedUsers: users() });
      if (!r.validation.ok) throw new MigrationError("MIGRATION_PLAN_INVALID", "The dry run has blocking errors.");
      const workspaceId = new ObjectId(command === "execute" ? approval.targetWorkspaceId : val("--workspace"));
      let summary = null;
      if (command === "execute") {
        const t = Date.now();
        summary = await runImport({ client, target, plan: r.plan, planDigest: r.digest, approval, log: (m) => log(`  ${m}`) });
        log(`import finished in ${((Date.now() - t) / 1000).toFixed(1)}s: ${summary.batchesDone} batch(es) run; inserted boards ${summary.inserted.boards}, records ${summary.inserted.records}, comments ${summary.inserted.comments}, mappings ${summary.inserted.mappings}`);
        log(`  verification: ${summary.verification.ok ? "OK" : "FAILED"} ${JSON.stringify(summary.verification.counts)}`);
      }
      const fidelity = await verifyFidelity(client.db(target.dbName), r.plan, r.validation, workspaceId);
      log(`fidelity: ${fidelity.ok ? "OK" : "PROBLEMS"} ${JSON.stringify(fidelity.counts)}`);
      for (const p of fidelity.problems.slice(0, 10)) log(`  - ${p}`);
      const dir = path.join(ROOT, "monday-migration", "runs"); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${command}-${target.dbName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), `${JSON.stringify({ target, planDigest: r.digest, summary, fidelity }, null, 2)}\n`);
      if (!fidelity.ok || (summary && !summary.verification.ok)) process.exitCode = 1;
    } finally { await client.close(); }
    return;
  }
  log("Usage: monday-migrate.js dry-run | approve-local | execute | verify  (see the header of this file)");
  process.exitCode = 2;
}

main().catch((error) => {
  if (error instanceof SourceError) { log(`STOPPED: ${error.message}`); for (const p of error.problems.slice(0, 20)) log(`  - ${p}`); process.exitCode = 1; return; }
  if (error instanceof TargetRefusedError) { log(`REFUSED: ${error.message}`); for (const p of error.problems) log(`  - ${p}`); process.exitCode = 3; return; }
  if (error instanceof MigrationError) { log(`STOPPED (${error.code}): ${redact(error.message)}`); for (const p of (error.problems || error.conflicts || []).slice(0, 20)) log(`  - ${redact(p)}`); process.exitCode = error.code === "MIGRATION_PRODUCTION_LOCKED" || error.code === "MIGRATION_NOT_AUTHORIZED" ? 3 : 1; return; }
  log(`FAILED: ${error.name}: ${redact(error.message)}`);
  process.exitCode = 1;
});
