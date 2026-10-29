// Destination safety for the migration executor (Phase M3). The executor writes ONLY to a verified local test
// instance. Safety is never inferred from a database name: a target must pass every check below, and the result is
// an unforgeable token that the executor requires.
//
//   static    mongodb:// only (no +srv: DNS seed lists are how Atlas is reached), every host a loopback address with
//             an explicit port, no Atlas/Railway hostnames, not the application's own MONGODB_URI, and a test database
//             name (jarc_migration_test or jarc_migration_test_<suffix>) — never jarc_database or another app's.
//   server    after connecting: the server reports itself on loopback (hello.me / hosts), is a replica set (needed for
//             transactions) and not a mongos, is not Atlas (atlasVersion must be unknown) and not an Enterprise build,
//             and holds the guard marker written by scripts/migration-test-db.js whose instance ID matches
//             JARC_MIGRATION_TEST_INSTANCE_ID. An instance without that marker is refused, whatever it is called.
// There is no "production" result: production execution stays disabled until a separate reviewed change.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const TEST_DB = /^jarc_migration_test(_[a-z0-9]{1,32})?$/;
const FORBIDDEN_HOST = /mongodb\.net|mongodb-dev\.net|atlas|railway|rlwy|receiptflow/i;
const GUARD_DB = "jarc_migration_guard";
const GUARD_ID = "local-test-instance";
const GUARD_PURPOSE = "jarc-monday-migration-local-test";
const INSTANCE_ID = /^[A-Za-z0-9_-]{16,64}$/;

class TargetRefusedError extends Error {
  constructor(problems) { super(`Refusing the migration target: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}`); this.name = "TargetRefusedError"; this.code = "MIGRATION_TARGET_REFUSED"; this.problems = problems; }
}

const verified = new WeakSet(); // only objects created by verifyTarget() are accepted by the executor
const isVerifiedTarget = (t) => verified.has(t);

// Hosts from a mongodb:// URI, credentials removed. Never returns or logs the credentials.
function hostsOf(uri) {
  const m = /^mongodb:\/\/(?:[^@/?#]*@)?([^/?#]+)/.exec(uri);
  if (!m) return null;
  return m[1].split(",").map((h) => {
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(h);
    if (v6) return { host: `[${v6[1]}]`, port: v6[2] ? Number(v6[2]) : null };
    const i = h.lastIndexOf(":");
    return i > 0 ? { host: h.slice(0, i).toLowerCase(), port: Number(h.slice(i + 1)) } : { host: h.toLowerCase(), port: null };
  });
}

function checkStatic({ uri, dbName, instanceId, env = process.env }) {
  const problems = [];
  if (typeof uri !== "string" || !uri) return ["no test connection string (JARC_MIGRATION_TEST_MONGODB_URI)"];
  if (/^mongodb\+srv:/i.test(uri)) problems.push("mongodb+srv connection strings are refused (DNS seed lists reach remote clusters such as Atlas)");
  else if (!/^mongodb:\/\//i.test(uri)) problems.push("the connection string must start with mongodb://");
  if (FORBIDDEN_HOST.test(uri.replace(/^mongodb:\/\/[^@/]*@/, "mongodb://"))) problems.push("the connection string names an Atlas, Railway or ReceiptFlow host");
  const hosts = hostsOf(uri);
  if (!hosts?.length) problems.push("no host in the connection string");
  else for (const h of hosts) {
    if (!LOOPBACK.has(h.host)) problems.push(`host is not a loopback address (only 127.0.0.1, localhost or ::1 are permitted)`);
    if (!Number.isInteger(h.port) || h.port < 1024 || h.port > 65535) problems.push("every host needs an explicit, unprivileged port");
  }
  for (const name of ["MONGODB_URI", "JARC_MONGODB_URI", "DATABASE_URL"]) if (env[name] && env[name] === uri) problems.push(`the test connection string is the same as ${name} (an application database)`);
  if (!TEST_DB.test(String(dbName || ""))) problems.push("the database name must be jarc_migration_test or jarc_migration_test_<suffix>");
  if (!INSTANCE_ID.test(String(instanceId || ""))) problems.push("JARC_MIGRATION_TEST_INSTANCE_ID is missing or malformed");
  return problems;
}

const hostOnly = (hp) => { const s = String(hp || ""); const v6 = /^\[([^\]]+)\]/.exec(s); return v6 ? `[${v6[1]}]` : s.replace(/:\d+$/, "").toLowerCase(); };

// Verifies a connected client. Returns the verified target token, or throws TargetRefusedError.
async function verifyTarget({ client, uri, dbName, instanceId, env = process.env }) {
  const problems = checkStatic({ uri, dbName, instanceId, env });
  if (problems.length) throw new TargetRefusedError(problems);
  const admin = client.db("admin");
  const hello = await admin.command({ hello: 1 });
  if (hello.msg === "isdbgrid") problems.push("the server is a mongos router, not a local test instance");
  if (!hello.setName) problems.push("the server is not a replica set (transactions are required)");
  for (const h of [hello.me, ...(hello.hosts || []), ...(hello.passives || [])].filter(Boolean)) if (!LOOPBACK.has(hostOnly(h))) problems.push("the server reports a non-loopback member");
  let atlas = false;
  try { await admin.command({ atlasVersion: 1 }); atlas = true; } catch { /* CommandNotFound on non-Atlas servers */ }
  if (atlas) problems.push("the server identifies itself as MongoDB Atlas");
  const build = await admin.command({ buildInfo: 1 });
  if ((build.modules || []).length) problems.push("the server is not a plain Community build");
  const marker = await client.db(GUARD_DB).collection("instance").findOne({ _id: GUARD_ID });
  if (!marker || marker.purpose !== GUARD_PURPOSE) problems.push("the server has no JARC local-test guard marker (create it with scripts/migration-test-db.js)");
  else if (marker.instanceId !== instanceId) problems.push("the server's guard marker belongs to a different test instance");
  if (dbName === GUARD_DB) problems.push("the guard database can't be the target");
  if (problems.length) throw new TargetRefusedError(problems);
  const target = Object.freeze({ scope: "local-test", dbName, instanceId, replicaSet: hello.setName, serverVersion: build.version, host: hostOnly(hello.me) });
  verified.add(target);
  return target;
}

module.exports = { verifyTarget, checkStatic, isVerifiedTarget, hostsOf, TargetRefusedError, LOOPBACK, TEST_DB, GUARD_DB, GUARD_ID, GUARD_PURPOSE };
