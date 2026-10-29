// Phase M4.2A read-only verification tools, offline: the audit's read-only gate (privilege shapes as MongoDB reports
// them), its summary (on a throwaway database of the LOCAL test instance, skipped when it isn't running — never
// Atlas), the CLI refusing without credentials, and the Railway variable filter never printing secrets.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { MongoClient, ObjectId } = require("mongodb");
const { checkReadOnly, collect } = require("../scripts/production-audit");
const { summarize } = require("../scripts/railway-variables-filter");

const status = (roles, privileges, users = [{ user: "jarc_audit_ro", db: "admin" }]) => ({ authInfo: { authenticatedUsers: users, authenticatedUserRoles: roles, authenticatedUserPrivileges: privileges } });
const READ = [{ resource: { db: "jarc_database", collection: "" }, actions: ["changeStream", "collStats", "dbHash", "dbStats", "find", "killCursors", "listCollections", "listIndexes", "listSearchIndexes", "planCacheRead"] }];

describe("production audit: read-only gate", () => {
  test("only the built-in read role on jarc_database passes", () => {
    assert.deepEqual(checkReadOnly(status([{ role: "read", db: "jarc_database" }], READ)), []);
    assert.ok(checkReadOnly(status([{ role: "readWrite", db: "jarc_database" }], [{ resource: { db: "jarc_database", collection: "" }, actions: ["find", "insert", "update", "remove"] }])).some((p) => /more than read/.test(p)));
    assert.ok(checkReadOnly(status([{ role: "read", db: "jarc_database" }, { role: "read", db: "receiptflow" }], [...READ, { resource: { db: "receiptflow", collection: "" }, actions: ["find"] }])).some((p) => /outside jarc_database/.test(p)));
    assert.ok(checkReadOnly(status([{ role: "readAnyDatabase", db: "admin" }], [{ resource: { db: "", collection: "" }, actions: ["find"] }])).length);
    assert.ok(checkReadOnly(status([{ role: "read", db: "jarc_database" }], [...READ, { resource: { cluster: true }, actions: ["serverStatus"] }])).some((p) => /cluster-wide/.test(p)));
    assert.ok(checkReadOnly(status([], [], [])).length);
  });
  test("the CLI contacts nothing without .env.audit and never reads server/.env", () => {
    const script = path.join(__dirname, "../scripts/production-audit.js");
    const source = fs.readFileSync(script, "utf8");
    assert.doesNotMatch(source, /server[\\/]\.env['"]|"\.env"\)|\.env\.monday/);
    if (!fs.existsSync(path.join(__dirname, "../../.env.audit"))) {
      const res = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30000 });
      assert.equal(res.status, 2); assert.match(res.stdout, /Nothing was contacted/);
    }
  });
});

describe("railway variable filter", () => {
  test("names always, values only for non-secret settings, no credentials", () => {
    const rows = Object.fromEntries(summarize({
      ACCESS_POLICY: "development_shared", JARC_BETA_OPEN_EDITING: "true", ENTRA_TENANT_ID: "00000000-0000-4000-8000-00000000a001",
      MONGODB_URI: "mongodb+srv://jarc_app:SuperSecret@jarc-cluster.abcde.mongodb.net/?retryWrites=true", MONGODB_DB_NAME: "jarc_database",
      MONDAY_TOKEN_KEY: "c2VjcmV0", ATTACHMENTS_S3_SECRET_ACCESS_KEY: "abc", ENTRA_ADMIN_ROLE: "JARC.Admin", RAILWAY_GIT_BRANCH: "backend-stage-12-entra", SOMETHING_ELSE: "x", EMPTY: ""
    }));
    assert.equal(rows.ACCESS_POLICY, "development_shared"); assert.equal(rows.JARC_BETA_OPEN_EDITING, "true"); assert.equal(rows.RAILWAY_GIT_BRANCH, "backend-stage-12-entra");
    assert.equal(rows.MONGODB_URI, "mongodb+srv://<credentials hidden>@jarc-cluster.abcde.mongodb.net");
    assert.equal(rows.MONDAY_TOKEN_KEY, "(set, hidden)"); assert.equal(rows.ATTACHMENTS_S3_SECRET_ACCESS_KEY, "(set, hidden)"); assert.equal(rows.SOMETHING_ELSE, "(set, hidden)"); assert.equal(rows.EMPTY, "(empty)");
    assert.doesNotMatch(JSON.stringify(rows), /SuperSecret|jarc_app|c2VjcmV0|"abc"/);
  });
});

// The summary on a throwaway database of the local test instance (real aggregation; no Atlas involved).
const ROOT = path.resolve(__dirname, "../..");
function localUri() { const f = path.join(ROOT, ".env.migration-test"); if (!fs.existsSync(f)) return null; const m = /JARC_MIGRATION_TEST_MONGODB_URI\s*=\s*(\S+)/.exec(fs.readFileSync(f, "utf8")); return m ? m[1] : null; }
const portOpen = () => new Promise((resolve) => { const s = net.connect({ host: "127.0.0.1", port: 27027 }); s.once("connect", () => { s.end(); resolve(true); }); s.once("error", () => resolve(false)); setTimeout(() => { s.destroy(); resolve(false); }, 1000); });

describe("production audit: summary (local test instance)", async () => {
  const uri = localUri();
  if (!(uri && await portOpen())) { test("local test instance not running", { skip: true }, () => {}); return; }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  let db;
  before(async () => {
    await client.connect();
    db = client.db(`jarc_migration_test_t${crypto.randomBytes(6).toString("hex")}`);
    const w1 = new ObjectId(), w2 = new ObjectId(), u1 = new ObjectId(), u2 = new ObjectId(), u3 = new ObjectId();
    await db.collection("workspaces").insertMany([{ _id: w1, archived: false }, { _id: w2, archived: false }]);
    await db.collection("users").insertMany([{ _id: u1, source: "entra", status: "active", tenantId: "t-1", entraObjectId: "o-1", emailNormalized: "admin@example.invalid", displayName: "Hidden Name" }, { _id: u2, source: "entra", status: "active" }, { _id: u3, source: "entra", status: "active" }]);
    await db.collection("workspaceMembers").insertMany([{ workspaceId: w1, userId: u1, role: "WORKSPACE_ADMIN", status: "active" }, { workspaceId: w1, userId: u2, role: "MEMBER", status: "active" }]);
    await db.collection("attachments").insertMany([{ size: 1048576, status: "ready", name: "secret-file-name.pdf" }, { size: 2097152, status: "ready", storage: { provider: "s3", key: "att/x" } }]);
  });
  after(async () => { await client.close(); });
  test("counts, sizes, access gaps and the administrator's identifiers only", async () => {
    const out = await collect(db, { adminEmail: "Admin@Example.invalid" });
    assert.equal(out.collections.users, 3);
    assert.deepEqual(out.attachments.sort((a, b) => a.provider.localeCompare(b.provider)), [{ provider: "gridfs", status: "ready", files: 1, mb: 1 }, { provider: "s3", status: "ready", files: 1, mb: 2 }]);
    assert.deepEqual(out.administratorCandidates, [{ tenantId: "t-1", entraObjectId: "o-1", source: "entra", status: "active" }]);
    assert.equal(out.access.workspaces, 2); assert.equal(out.access.workspacesWithoutAnyMember, 1); assert.equal(out.access.workspacesWithoutAdmin, 1);
    assert.equal(out.access.activeUsersWithoutAnyMembership, 1);
    assert.doesNotMatch(JSON.stringify(out), /Hidden Name|secret-file-name|admin@example/);
  });
});
