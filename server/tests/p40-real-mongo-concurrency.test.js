// P4-0 (D-H1, D-H2): conflicting administrator operations run CONCURRENTLY against a REAL MongoDB: the isolated local test
// instance (loopback 127.0.0.1:27027 only, single-node replica set; node scripts/migration-test-db.js start), in a throwaway
// database removed afterwards. It observes MongoDB's own WriteConflict (TransientTransactionError) and the driver's retry, and that
// exactly the expected operations win. Skipped when that instance isn't running. Never reads server/.env; synthetic people only.
//
// Each scenario opens every transaction, lets each read its snapshot, and holds them at a barrier just before their first write
// (so they genuinely overlap), then releases them together.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto"), fs = require("fs"), net = require("net"), path = require("path");
const { MongoClient } = require("mongodb");
const { MongoConnection } = require("../src/db/connection");
const { buildWorld } = require("./support/p40-world");

const ENV_FILE = path.resolve(__dirname, "..", "..", ".env.migration-test");
function localUri() {
  if (process.env.JARC_MIGRATION_TEST_MONGODB_URI) return process.env.JARC_MIGRATION_TEST_MONGODB_URI;
  if (!fs.existsSync(ENV_FILE)) return null;
  const match = /^\s*JARC_MIGRATION_TEST_MONGODB_URI\s*=\s*(\S+)/m.exec(fs.readFileSync(ENV_FILE, "utf8"));
  return match ? match[1] : null;
}
const portOpen = () => new Promise((resolve) => { const s = net.connect({ host: "127.0.0.1", port: 27027 }); s.once("connect", () => { s.end(); resolve(true); }); s.once("error", () => resolve(false)); setTimeout(() => { s.destroy(); resolve(false); }, 1000); });

// The first n calls wait until n have arrived (or 5 s), then all proceed; later calls (the driver's retries) pass straight through.
function barrier(n) {
  let arrived = 0, open;
  const opened = new Promise((r) => { open = r; });
  const timer = setTimeout(() => open(), 5000);
  return async () => { if (arrived >= n) return; arrived += 1; if (arrived === n) { clearTimeout(timer); open(); } await opened; };
}
function gate(obj, method, wait) {
  const original = obj[method];
  obj[method] = async function gated(...args) { await wait(); return original.apply(this, args); };
  return () => { obj[method] = original; };
}

describe("P4-0 administrator protection on the local test MongoDB (real transactions)", { concurrency: false }, async () => {
  const uri = localUri();
  if (!uri || !(await portOpen())) { test("local test instance not running (scripts/migration-test-db.js start): SKIPPED, nothing proven here", { skip: true }, () => {}); return; }
  assert.match(uri, /^mongodb:\/\/[^@]+@127\.0\.0\.1:27027\//, "never anything but this machine");
  const dbNames = [];
  let client;
  const conflicts = [];
  before(async () => {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, monitorCommands: true });
    client.on("commandFailed", (e) => { if (e.failure?.codeName === "WriteConflict" || e.failure?.code === 112) conflicts.push(e.commandName); });
    await client.connect();
  });
  after(async () => { for (const n of dbNames) await client.db(n).dropDatabase().catch(() => {}); await client?.close(); });

  // A fresh throwaway database (jarc_migration_test_t<12 hex>, as migration-test-db.js prune expects) behind JARC's connection.
  const fresh = async (options = {}) => {
    const dbName = `jarc_migration_test_t${crypto.randomBytes(6).toString("hex")}`;
    dbNames.push(dbName);
    const connection = new MongoConnection({ uri: "mongodb://127.0.0.1:27027", dbName: "jarc_database", monitor: null, createClient: () => ({ connect: async () => {}, close: async () => {}, db: () => client.db(dbName), startSession: (...a) => client.startSession(...a) }) });
    await connection.connect();
    const attempts = [];
    const run = connection.withTransaction.bind(connection);
    connection.withTransaction = (fn) => { const record = { n: 0 }; attempts.push(record); return run((session) => { record.n += 1; return fn(session); }); };
    const w = await buildWorld(connection, options);
    conflicts.length = 0;
    return { w, attempts, retried: () => attempts.filter((a) => a.n > 1).length };
  };
  const statuses = (results) => results.map((r) => r.status).sort();
  const lostCode = (results) => results.filter((r) => r.status === "rejected").map((r) => (/needs at least one admin/.test(r.reason?.message) ? "LAST_WORKSPACE_ADMIN" : r.reason?.code || r.reason?.name));

  test("P3 suspend of one admin + demote of the other (two usable admins): WriteConflict, retry, exactly one wins", async () => {
    const { w, retried } = await fresh();
    const me = await w.register(0);
    const a = await w.register(3), b = await w.register(4);
    const ws = await w.workspace("Synthetic Real WS");
    await w.admin(ws, a); const mb = await w.admin(ws, b);
    const release = gate(w.repos.workspaces, "touchMembers", barrier(2));
    try {
      const results = await Promise.allSettled([w.suspend(3, w.actorOf(me)), w.members.changeRole(ws, mb._id, { role: "MEMBER" }, w.actorOf(me))]);
      assert.deepEqual(statuses(results), ["fulfilled", "rejected"], JSON.stringify(lostCode(results)));
      assert.ok(["LAST_USABLE_WORKSPACE_ADMIN", "LAST_WORKSPACE_ADMIN"].includes(lostCode(results)[0]), lostCode(results)[0]);
    } finally { release(); }
    assert.ok(conflicts.length >= 1, "MongoDB reported a WriteConflict");
    assert.ok(retried() >= 1, "the driver retried the losing transaction");
    assert.equal(await w.usableAdmins(ws), 1);
  });

  test("P3 suspend + Account Management block of the two admins: exactly one wins", async () => {
    const { w, retried } = await fresh();
    const me = await w.register(0);
    const root = await w.register(9, { account: w.superAdminAccount });
    const a = await w.register(3), b = await w.register(4, { account: { status: "active", role: "ADMIN", version: 1 } });
    const ws = await w.workspace("Synthetic Real WS");
    await w.admin(ws, a); await w.admin(ws, b);
    const release = gate(w.repos.workspaces, "touchMembers", barrier(2));
    let results;
    try { results = await Promise.allSettled([w.suspend(3, w.actorOf(me)), w.block(4, w.actorOf(root, { isSystemAdmin: true, hasAdminAppRole: true }))]); } finally { release(); }
    assert.deepEqual(statuses(results), ["fulfilled", "rejected"]);
    assert.deepEqual(lostCode(results), ["LAST_USABLE_WORKSPACE_ADMIN"]);
    assert.ok(conflicts.length >= 1 && retried() >= 1);
    assert.equal(await w.usableAdmins(ws), 1);
  });

  test("three at once: owner removal + P3 suspend + Account Management block of three admins: two win, one usable owner remains", async () => {
    const { w, retried } = await fresh();
    const me = await w.register(0);
    const root = await w.register(9, { account: w.superAdminAccount });
    const a = await w.register(3), b = await w.register(4), c = await w.register(5, { account: { status: "active", role: "ADMIN", version: 1 } });
    const ws = await w.workspace("Synthetic Real Triple");
    const ma = await w.admin(ws, a); await w.admin(ws, b); await w.admin(ws, c);
    const release = gate(w.repos.workspaces, "touchMembers", barrier(3));
    let results;
    try { results = await Promise.allSettled([w.members.remove(ws, ma._id, w.actorOf(me)), w.suspend(4, w.actorOf(me)), w.block(5, w.actorOf(root, { isSystemAdmin: true, hasAdminAppRole: true }))]); } finally { release(); }
    assert.deepEqual(statuses(results), ["fulfilled", "fulfilled", "rejected"], JSON.stringify(lostCode(results)));
    assert.ok(conflicts.length >= 2, `WriteConflicts observed: ${conflicts.length}`);
    assert.ok(retried() >= 1);
    assert.equal(await w.usableAdmins(ws), 1);
  });

  test("two Employee Management administrators suspending each other: one wins, the other's retry finds its administrator suspended", async () => {
    const { w, retried } = await fresh({ admins: [3, 4] });
    const a = await w.register(3), b = await w.register(4);
    const release = gate(w.repos.users, "touchAccessActor", barrier(2));
    let results;
    try { results = await Promise.allSettled([w.suspend(4, w.actorOf(a)), w.suspend(3, w.actorOf(b))]); } finally { release(); }
    assert.deepEqual(statuses(results), ["fulfilled", "rejected"]);
    assert.deepEqual(lostCode(results), ["EMPLOYEES_FORBIDDEN"]);
    assert.ok(conflicts.length >= 1 && retried() >= 1);
    assert.deepEqual([await w.statusOf(3), await w.statusOf(4)].sort(), ["active", "suspended"]);
  });

  test("a sign-in with JARC.Admin lands while a P3 suspend is in flight: WriteConflict, the retry sees the role and refuses", async () => {
    const { w, retried } = await fresh();
    const me = await w.register(0);
    const t = await w.register(3); // known non-administrator when the suspend starts
    let signIn = null;
    // Inside the suspend's transaction (after its reads, before its writes), the person signs in with the role (no transaction).
    const release = gate(w.repos.sessions, "listLiveForUser", async () => { if (!signIn) { signIn = w.repos.users.recordAdminRole(await w.fresh(3), true, new Date()); await signIn; } });
    let result;
    try { result = await Promise.allSettled([w.suspend(3, w.actorOf(me))]); } finally { release(); }
    assert.equal(result[0].status, "rejected");
    assert.equal(result[0].reason.code, "TARGET_JARC_ADMIN");
    assert.ok(conflicts.length >= 1, "the suspend's write conflicted with the sign-in's");
    assert.ok(retried() >= 1);
    assert.equal(await w.statusOf(3), "active");
    assert.ok(t);
  });
});
