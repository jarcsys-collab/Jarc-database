// monday.com migration executor (Phase M3). Two parts:
//   unit         always run: destination refusal rules, the approval gate, target verification against fake servers that
//                impersonate Atlas, a mongos or a remote host, and the guarantee that production execution is disabled.
//   integration  only against the VERIFIED LOCAL TEST INSTANCE from .env.migration-test (scripts/migration-test-db.js),
//                skipped when it isn't running. Each test uses its own throwaway jarc_migration_test_<id> database on that
//                instance. Covers the full import of the private extraction (or the synthetic one), fidelity, the app's
//                own services reading the result, interruption inside a batch and after commit, resume, idempotent
//                re-runs, conflicts, unexpected destination data, missing documents, the run lock, approvals bound to
//                another instance, and that no users, memberships, attachments or GridFS files are created.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { MongoClient, ObjectId } = require("mongodb");
const { dryRun } = require("../src/migration/monday");
const { checkStatic, verifyTarget, hostsOf, GUARD_DB, GUARD_ID, GUARD_PURPOSE } = require("../src/migration/monday/target");
const executor = require("../src/migration/monday/executor");
const { verifyFidelity } = require("../src/migration/monday/fidelity");
const { COLLECTIONS } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { recordToApi, boardToApi } = require("../src/api/serialize");
const { fixture } = require("./support/monday-migration-fixture");

const ID = "A".repeat(24);
const LOCAL = "mongodb://u:p@127.0.0.1:27027/?authSource=admin&replicaSet=jarcmigtest&directConnection=true";
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

describe("destination refusal rules (static)", () => {
  const problems = (uri, extra = {}) => checkStatic({ uri, dbName: "jarc_migration_test", instanceId: ID, env: {}, ...extra });
  test("only loopback mongodb:// with an explicit port and a test database name", () => {
    assert.deepEqual(problems(LOOPBACK_OK()), []);
    assert.deepEqual(problems("mongodb://[::1]:27027/"), []);
    assert.ok(problems("mongodb+srv://u:p@cluster0.abcde.mongodb.net/").length, "Atlas SRV");
    assert.ok(problems("mongodb://u:p@ac-123-shard-00-00.abcde.mongodb.net:27017/").length, "Atlas host");
    assert.ok(problems("mongodb://u:p@containers-us-west-1.railway.app:6543/").length, "Railway");
    assert.ok(problems("mongodb://u:p@mongo.rlwy.net:12345/").length, "Railway proxy");
    assert.ok(problems("mongodb://10.0.0.5:27017/").length, "LAN host");
    assert.ok(problems("mongodb://127.0.0.1:27017,db.example.com:27017/").length, "mixed hosts");
    assert.ok(problems("mongodb://127.0.0.1/").length, "no port");
    assert.ok(problems("mongodb://u:p@receiptflow-db.internal:27017/").length, "ReceiptFlow host");
    assert.ok(problems(LOOPBACK_OK(), { dbName: "jarc_database" }).length, "production database name");
    assert.ok(problems(LOOPBACK_OK(), { dbName: "receiptflow" }).length, "another app");
    assert.ok(problems(LOOPBACK_OK(), { instanceId: "short" }).length, "instance ID");
    assert.ok(problems(LOOPBACK_OK(), { env: { MONGODB_URI: LOOPBACK_OK() } }).length, "same as the app's MONGODB_URI");
    assert.deepEqual(hostsOf("mongodb://user:p%40ss@127.0.0.1:27027,localhost:27028/x"), [{ host: "127.0.0.1", port: 27027 }, { host: "localhost", port: 27028 }]);
  });
  function LOOPBACK_OK() { return LOCAL; }
});

describe("server verification refuses impostors", () => {
  // A stand-in server answering the identity commands. The real executor tests below use a real mongod.
  const fake = ({ hello = { setName: "rs", me: "127.0.0.1:27027", hosts: ["127.0.0.1:27027"] }, atlas = false, modules = [], marker = { _id: GUARD_ID, purpose: GUARD_PURPOSE, instanceId: ID } } = {}) => ({
    db: (name) => ({
      command: async (c) => { if (c.hello) return hello; if (c.atlasVersion) { if (atlas) return { atlasVersion: "x" }; throw new Error("no such command"); } if (c.buildInfo) return { version: "8.0.12", modules }; throw new Error("unexpected command"); },
      collection: () => ({ findOne: async () => (name === GUARD_DB ? marker : null) })
    })
  });
  const verify = (client, extra = {}) => verifyTarget({ client, uri: LOCAL, dbName: "jarc_migration_test", instanceId: ID, env: {}, ...extra });
  test("Atlas, mongos, non-replica-set, remote members, Enterprise builds and missing/foreign markers", async () => {
    await assert.rejects(() => verify(fake({ atlas: true })), /Atlas/);
    await assert.rejects(() => verify(fake({ hello: { msg: "isdbgrid", setName: "x", me: "127.0.0.1:27027" } })), /mongos/);
    await assert.rejects(() => verify(fake({ hello: { me: "127.0.0.1:27027" } })), /replica set/);
    await assert.rejects(() => verify(fake({ hello: { setName: "rs", me: "127.0.0.1:27027", hosts: ["127.0.0.1:27027", "db2.internal:27017"] } })), /non-loopback/);
    await assert.rejects(() => verify(fake({ modules: ["enterprise"] })), /Community/);
    await assert.rejects(() => verify(fake({ marker: null })), /guard marker/);
    await assert.rejects(() => verify(fake({ marker: { _id: GUARD_ID, purpose: GUARD_PURPOSE, instanceId: "B".repeat(24) } })), /different test instance/);
    await assert.rejects(() => verify(fake(), { dbName: "jarc_database" }), /database name/);
    const t = await verify(fake());
    assert.equal(t.scope, "local-test"); assert.ok(Object.isFrozen(t));
  });
});

describe("approval gate", () => {
  let r;
  before(() => { const d = fixture(); tmpDirs.push(d); r = dryRun(d); });
  const target = { scope: "local-test", dbName: "jarc_migration_test_x", instanceId: ID };
  const now = new Date("2026-10-28T05:00:00Z");
  const ok = () => ({ kind: "monday-migration-approval", version: 2, scope: "local-test", planDigest: r.digest, targetDatabase: target.dbName, targetInstanceId: ID, targetWorkspaceId: new ObjectId().toHexString(), approvedBy: "Owner", operator: "op", approvedAt: "2026-10-28T04:00:00Z", expiresAt: "2026-10-28T06:00:00Z", include: [...executor.SCOPE], expectedCounts: executor.planCounts(r.plan) });
  const check = (a, extra = {}) => executor.checkAuthorization(a, { planDigest: r.digest, plan: r.plan, target, operator: "op", now, ...extra });
  test("everything must match: digest, database, instance, workspace, approver, operator, expiry, scope and counts", () => {
    assert.deepEqual(check(ok()), []);
    const bad = (patch, extra) => assert.ok(check({ ...ok(), ...patch }, extra).length, JSON.stringify(patch));
    bad({ planDigest: "0".repeat(64) });
    bad({ targetDatabase: "jarc_database" });
    bad({ targetInstanceId: "B".repeat(24) });
    bad({ targetWorkspaceId: "nope" });
    bad({ approvedBy: " " });
    bad({ operator: "someone-else" });
    bad({ expiresAt: "2026-10-28T04:30:00Z" });
    bad({ expiresAt: "2026-10-30T04:00:00Z" }); // > 24 h
    bad({ approvedAt: "2026-10-29T00:00:00Z" }); // in the future
    bad({ include: ["records"] });
    bad({ expectedCounts: { ...executor.planCounts(r.plan), items: 1 } });
    bad({ version: 1 });
  });
  test("a production-scope approval is always refused, and a local-test approval never authorizes another target", () => {
    assert.ok(check({ ...ok(), scope: "production" }).some((p) => /production execution is disabled/.test(p)));
    assert.ok(check(ok(), { target: { ...target, scope: "production" } }).length);
    assert.ok(check(ok(), { target: { ...target, instanceId: "C".repeat(24) } }).length);
    assert.equal(executor.PRODUCTION_EXECUTION_ENABLED, false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Integration: the verified local test instance.
const ROOT = path.resolve(__dirname, "../..");
const ENV_FILE = path.join(ROOT, ".env.migration-test");
function localEnv() {
  if (!fs.existsSync(ENV_FILE)) return null;
  const out = {};
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) { const m = /^\s*(JARC_MIGRATION_TEST_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m) out[m[1]] = m[2]; }
  return out.JARC_MIGRATION_TEST_MONGODB_URI ? out : null;
}
const portOpen = () => new Promise((resolve) => { const s = net.connect({ host: "127.0.0.1", port: 27027 }); s.once("connect", () => { s.end(); resolve(true); }); s.once("error", () => resolve(false)); setTimeout(() => { s.destroy(); resolve(false); }, 1000); });
const REAL = path.join(ROOT, "monday-extraction");

describe("executor against the verified local test instance", { concurrency: false }, async () => {
  const env = localEnv();
  const available = env && await portOpen();
  if (!available) { test("local test instance not running (scripts/migration-test-db.js init)", { skip: true }, () => {}); return; }
  const client = new MongoClient(env.JARC_MIGRATION_TEST_MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  const created = [];
  let source, r;
  before(async () => {
    await client.connect();
    source = fs.existsSync(path.join(REAL, "extraction-manifest.json")) ? REAL : (() => { const d = fixture(); tmpDirs.push(d); return d; })();
    r = dryRun(source);
  });
  // The test user can't drop databases (least privilege); throwaway jarc_migration_test_t* databases are removed by an
  // administrator with `migration-test-db.js prune`.
  after(async () => { await client.close(); });
  // A fresh test database with a workspace, a verified target and a matching approval.
  async function setup({ batchSize } = {}) {
    const dbName = `jarc_migration_test_t${crypto.randomBytes(6).toString("hex")}`;
    created.push(dbName);
    const target = await verifyTarget({ client, uri: env.JARC_MIGRATION_TEST_MONGODB_URI, dbName, instanceId: env.JARC_MIGRATION_TEST_INSTANCE_ID, env: {} });
    const db = client.db(dbName), workspaceId = new ObjectId(), at = new Date();
    await db.collection(COLLECTIONS.workspaces).insertOne({ _id: workspaceId, name: "Rehearsal", description: "", icon: "R", color: "", archived: false, position: 1000, createdBy: null, createdAt: at, updatedAt: at, version: 1 });
    const userId = new ObjectId();
    await db.collection(COLLECTIONS.users).insertOne({ _id: userId, displayName: "Existing member", status: "active", source: "entra", createdAt: at });
    await db.collection(COLLECTIONS.workspaceMembers).insertOne({ workspaceId, userId, role: "MEMBER", status: "active", createdAt: at, updatedAt: at });
    const approval = { kind: "monday-migration-approval", version: 2, scope: "local-test", planDigest: r.digest, targetDatabase: dbName, targetInstanceId: target.instanceId, targetWorkspaceId: workspaceId.toHexString(), approvedBy: "Test", operator: "tester", approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), include: [...executor.SCOPE], expectedCounts: executor.planCounts(r.plan) };
    const run = (extra = {}) => executor.runImport({ client, target, plan: r.plan, planDigest: r.digest, approval, operator: "tester", batchSize, ...extra });
    return { db, dbName, target, workspaceId, userId, approval, run };
  }
  const count = (db, name, filter = {}) => db.collection(COLLECTIONS[name]).countDocuments(filter);

  test("full import: exact fidelity, nothing extra, readable by the app's own services", async () => {
    const { db, workspaceId, userId, run } = await setup();
    const res = await run();
    assert.equal(res.verification.ok, true, JSON.stringify(res.verification.problems));
    const f = await verifyFidelity(db, r.plan, r.validation, workspaceId);
    assert.equal(f.ok, true, JSON.stringify(f.problems.slice(0, 5)));
    assert.equal(f.counts.recordsIdenticalToPlan, r.plan.records.length + r.plan.subRecords.length);
    assert.equal(f.counts.commentsIdenticalToPlan, r.plan.comments.length);
    assert.equal(f.counts.sameBoardLinksResolved, r.validation.relationLinks);
    assert.equal(f.counts.deletedLabelValuesRecoverable, f.counts.deletedLabelValues);
    if (source === REAL) {
      assert.deepEqual([f.counts.records, f.counts.subitems, f.counts.comments, f.counts.groups, f.counts.columns], [4688, 26, 1476, 12, 84]); // 81 from the source + 3 native Files columns (Phase M4.1);
      assert.deepEqual([f.counts.sameBoardLinks, f.counts.attachmentReferences, f.counts.deletedLabelValuesRecoverable, f.counts.systemGeneratedComments], [665, 6083, 1705, 1171]);
    }
    // Attribution grants nothing; no attachments or files; access unchanged.
    assert.equal(await count(db, "users"), 1);
    assert.equal(await count(db, "workspaceMembers"), 1);
    assert.equal(await count(db, "attachments"), 0);
    assert.equal(await db.collection(COLLECTIONS.attachmentFiles).countDocuments(), 0);
    assert.equal(await count(db, "comments", { authorId: { $ne: null } }), 0);
    assert.equal(await count(db, "activities", { action: "board.imported" }), 2);
    // The app reads it: serializers, board listing, record pages and the Updates panel (comment service).
    const connection = { db, withTransaction: async (fn) => { const s = client.startSession(); try { return await s.withTransaction(() => fn(s)); } finally { await s.endSession(); } } };
    const layer = createDataLayer({ connection, logger: { error() {} } });
    const board = await layer.repos.boards.findById(r.plan.board._id);
    const api = boardToApi(board);
    assert.equal(api.source, undefined); assert.equal(api.columns.length, r.plan.board.columns.length); assert.equal("migration" in api, false);
    const page = await layer.repos.records.listPage(board._id, { sort: { field: "position", dir: "asc" }, limit: 50 });
    assert.equal(page.items.length, Math.min(50, r.plan.records.length));
    assert.equal("migration" in recordToApi(page.items[0]), false);
    const withComments = r.plan.comments[0].recordId;
    layer.services.comments.access = { roleIn: async () => "MEMBER", shared: false };
    const actor = { userId, displayName: "Existing member", isSystemAdmin: false };
    const list = await layer.services.comments.list(actor, await layer.repos.records.findById(withComments));
    assert.ok(list.length >= 1);
    assert.ok(list.every((c) => c.imported && c.canEdit === false && c.canDelete === false && c.author.isYou === false));
  });

  test("interruption inside a batch rolls that batch back; resume completes with no duplicates", async () => {
    const { db, workspaceId, run } = await setup({ batchSize: 100 });
    await assert.rejects(() => run({ faults: { failInsideBatch: 4 } }), (e) => e.code === "MIGRATION_SIMULATED_INTERRUPTION");
    // Batches 0 (boards) to 3 committed: 300 records (or fewer on a small source); batch 4 left nothing behind.
    const committed = await count(db, "records");
    assert.equal(committed, Math.min(300, r.plan.records.length));
    const mapped = await count(db, "integrationMappings", { kind: { $in: ["item", "subitem"] } });
    assert.equal(mapped, committed);
    const orphanComments = await db.collection(COLLECTIONS.comments).aggregate([{ $lookup: { from: COLLECTIONS.records, localField: "recordId", foreignField: "_id", as: "r" } }, { $match: { r: { $size: 0 } } }, { $count: "n" }]).toArray();
    assert.equal(orphanComments[0]?.n ?? 0, 0);
    const job = await db.collection(COLLECTIONS.integrationJobs).findOne({ type: executor.JOB_TYPE });
    assert.equal(job.status, "interrupted"); assert.equal(job.batchesDone, 4); assert.equal(job.lockedBy, null);
    const res = await run();
    assert.equal(res.verification.ok, true);
    assert.equal(res.inserted.records, r.plan.records.length + r.plan.subRecords.length - committed);
    const f = await verifyFidelity(db, r.plan, r.validation, workspaceId);
    assert.equal(f.ok, true, JSON.stringify(f.problems.slice(0, 5)));
    assert.equal(await count(db, "records"), r.plan.records.length + r.plan.subRecords.length);
    assert.equal(await count(db, "comments"), r.plan.comments.length);
    assert.equal((await db.collection(COLLECTIONS.integrationJobs).findOne({ type: executor.JOB_TYPE })).status, "completed");
  });

  test("a crash after commit resumes from the next batch; a finished import re-run inserts nothing", async () => {
    const { db, workspaceId, run } = await setup({ batchSize: 500 });
    await assert.rejects(() => run({ faults: { crashAfterCommit: 2 } }), (e) => e.code === "MIGRATION_SIMULATED_CRASH");
    const afterCrash = await count(db, "records");
    const res = await run();
    assert.equal(res.inserted.records + afterCrash, r.plan.records.length + r.plan.subRecords.length);
    const again = await run();
    assert.equal(again.batchesPlanned, 0); assert.equal(again.inserted.records, 0); assert.equal(again.inserted.comments, 0);
    assert.equal((await verifyFidelity(db, r.plan, r.validation, workspaceId)).ok, true);
    assert.equal(await count(db, "integrationMappings"), r.plan.mappings.length);
  });

  test("conflicts and unexpected destination data stop the run before anything is written", async () => {
    // A stored mapping pointing elsewhere.
    const a = await setup({ batchSize: 200 });
    await assert.rejects(() => a.run({ faults: { failInsideBatch: 2 } }));
    const someMap = await a.db.collection(COLLECTIONS.integrationMappings).findOne({ kind: "item" });
    await a.db.collection(COLLECTIONS.integrationMappings).updateOne({ _id: someMap._id }, { $set: { targetId: new ObjectId() } });
    const before = await count(a.db, "records");
    await assert.rejects(() => a.run(), (e) => e.code === "MIGRATION_DESTINATION_CONFLICT");
    assert.equal(await count(a.db, "records"), before);
    // A planned document already present without its mapping.
    const b = await setup();
    await b.db.collection(COLLECTIONS.records).insertOne({ ...r.plan.records[0], workspaceId: b.workspaceId });
    await assert.rejects(() => b.run(), (e) => e.code === "MIGRATION_DESTINATION_CONFLICT" && e.problems.some((p) => /without a migration mapping/.test(p)));
    assert.equal(await count(b.db, "records"), 1);
    assert.equal(await count(b.db, "boards"), 0);
    // A mapped document that was deleted by hand: reported, never silently recreated.
    const c = await setup();
    await c.run();
    await c.db.collection(COLLECTIONS.records).deleteOne({ _id: r.plan.records[0]._id }); // test-only manual deletion
    await assert.rejects(() => c.run(), (e) => e.code === "MIGRATION_DESTINATION_CONFLICT" && e.problems.some((p) => /mapping but no document/.test(p)));
    // The target workspace must exist.
    const d = await setup();
    await assert.rejects(() => d.run({ approval: { ...d.approval, targetWorkspaceId: new ObjectId().toHexString() } }), (e) => e.code === "MIGRATION_WORKSPACE_MISSING");
  });

  test("the run lock, approvals for another instance or database, and an unverified target are refused", async () => {
    const { db, approval, run, target } = await setup();
    await db.collection(COLLECTIONS.integrationJobs).insertOne({ _id: `monday-migration:${r.plan.runId}`, type: executor.JOB_TYPE, lockedBy: "other-operator", lockedUntil: new Date(Date.now() + 600e3), status: "running" });
    await assert.rejects(() => run(), (e) => e.code === "MIGRATION_RUN_LOCKED");
    assert.equal(await count(db, "records"), 0);
    await assert.rejects(() => run({ approval: { ...approval, targetInstanceId: "Z".repeat(24) } }), (e) => e.code === "MIGRATION_NOT_AUTHORIZED");
    await assert.rejects(() => run({ approval: { ...approval, targetDatabase: "jarc_migration_test" } }), (e) => e.code === "MIGRATION_NOT_AUTHORIZED");
    await assert.rejects(() => run({ approval: { ...approval, scope: "production" } }), (e) => e.code === "MIGRATION_NOT_AUTHORIZED");
    await assert.rejects(() => run({ target: { ...target } }), (e) => e.code === "MIGRATION_TARGET_UNVERIFIED");
    await assert.rejects(() => verifyTarget({ client, uri: env.JARC_MIGRATION_TEST_MONGODB_URI, dbName: "jarc_database", instanceId: env.JARC_MIGRATION_TEST_INSTANCE_ID, env: {} }), /database name/);
    await assert.rejects(() => verifyTarget({ client, uri: env.JARC_MIGRATION_TEST_MONGODB_URI, dbName: "jarc_migration_test_x", instanceId: "Q".repeat(24), env: {} }), /different test instance/);
  });

  test("the CLI refuses non-loopback connections at the socket level", () => {
    // Every way a socket can be opened: net.connect(options), net.createConnection(port, host), new Socket().connect(),
    // a hostname that would need DNS, and a Unix/pipe path. Loopback stays allowed (the local test instance).
    const script = `const net=require("net");require(${JSON.stringify(path.join(__dirname, "../scripts/monday-migrate.js"))});setImmediate(()=>{const t=(name,fn)=>{try{const s=fn();s.on("error",()=>{});s.destroy();console.log(name+":CONNECTED")}catch(e){console.log(name+":BLOCKED")}};t("connect-options",()=>net.connect({host:"8.8.8.8",port:53}));t("createConnection-args",()=>net.createConnection(53,"8.8.8.8"));t("socket-connect",()=>new net.Socket().connect(53,"1.1.1.1"));t("hostname",()=>net.connect({host:"cluster0.mongodb.net",port:27017}));t("pipe",()=>net.connect({path:"\\\\\\\\.\\\\pipe\\\\x"}));t("loopback",()=>net.connect({host:"127.0.0.1",port:27027}));});`;
    const res = spawnSync(process.execPath, ["-e", script, "x", "execute"], { encoding: "utf8", timeout: 60000 });
    for (const name of ["connect-options", "createConnection-args", "socket-connect", "hostname", "pipe"]) assert.match(res.stdout, new RegExp(`${name}:BLOCKED`), res.stdout);
    assert.match(res.stdout, /loopback:CONNECTED/);
  });
});
