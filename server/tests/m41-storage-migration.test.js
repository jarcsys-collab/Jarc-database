// Phase M4.1: object storage (Railway-compatible S3) next to GridFS, quotas, the migration attachment path, production
// target/approval checks (mocks only), staged workspace access, rollback and stale-lock takeover. Everything offline:
// object storage is the in-process S3 mock (tests/support/mock-s3), databases are the fake client or the verified
// LOCAL test instance (skipped when it isn't running). No live bucket, no Atlas, no monday.com, no real files.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { MongoClient, ObjectId } = require("mongodb");
const { startMongoApp, startApp, api } = require("./helpers");
const { startMockS3 } = require("./support/mock-s3");
const { fixture } = require("./support/monday-migration-fixture");
const { FakeMongoClient } = require("./support/fake-mongo");
const { loadAttachmentConfig } = require("../src/config");
const { createS3FileStore, MemoryFileStore, AttachmentStorage } = require("../src/files/file-store");
const { StorageUsageRepository } = require("../src/repositories/mongo/storage-usage-repository");
const { ensureDatabase, COLLECTIONS } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { ensureDevelopmentActor } = require("../src/context/dev-actor");
const { dryRun } = require("../src/migration/monday");
const { classifyAsset } = require("../src/migration/monday/compat");
const executor = require("../src/migration/monday/executor");
const { verifyTarget } = require("../src/migration/monday/target");
const { AttachmentImporter } = require("../src/migration/monday/attachments");
const prod = require("../src/migration/monday/production-target");
const access = require("../src/migration/monday/access-stages");
const { planRollback, executeRollback, checkBackupReference } = require("../src/migration/monday/rollback");

const MB = 1024 * 1024;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body-".repeat(50))]);
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "docs", label: "Documents", type: "files" }];
const s3Settings = (s3) => ({ endpoint: s3.endpoint, region: "auto", bucket: s3.bucket, forcePathStyle: true, accessKeyId: s3.accessKeyId, secretAccessKey: "test-secret" });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
async function upload(base, recordId, file, { column = "docs", type = "image/png", name = "photo.png" } = {}) {
  const res = await fetch(`${base}/api/v1/records/${recordId}/attachments?column=${column}`, { method: "POST", body: file, headers: { "Content-Type": type, "X-File-Name": encodeURIComponent(name) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function downloadSafe(base, p) { try { const res = await fetch(base + p); return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) }; } catch (e) { return { status: 0, error: e }; } }

describe("attachment storage configuration", () => {
  const S3 = { ATTACHMENTS_S3_ENDPOINT: "https://storage.example.invalid", ATTACHMENTS_S3_BUCKET: "jarc-files", ATTACHMENTS_S3_ACCESS_KEY_ID: "AKIDTEST", ATTACHMENTS_S3_SECRET_ACCESS_KEY: "do-not-print", ATTACHMENTS_S3_MAX_TOTAL_MB: "10240" };
  test("GridFS by default; object storage only when fully and safely configured", () => {
    assert.deepEqual(loadAttachmentConfig({}, "production"), { defaultProvider: "gridfs", s3: null, migrationMaxFileBytes: 20 * MB });
    const c = loadAttachmentConfig({ ...S3, ATTACHMENTS_STORE: "s3" }, "production");
    assert.equal(c.defaultProvider, "s3"); assert.equal(c.s3.bucket, "jarc-files"); assert.equal(c.s3.maxTotalBytes, 10240 * MB);
    assert.equal(c.s3.secretAccessKey, "do-not-print");
    assert.doesNotMatch(JSON.stringify(c), /do-not-print/, "the secret is not enumerable");
    assert.throws(() => loadAttachmentConfig({ ATTACHMENTS_STORE: "s3" }, "production"), /needs/);
    assert.throws(() => loadAttachmentConfig({ ATTACHMENTS_S3_BUCKET: "x" }, "production"), /partly configured/);
    assert.throws(() => loadAttachmentConfig({ ...S3, ATTACHMENTS_S3_ENDPOINT: "http://storage.example.invalid" }, "production"), /https/);
    assert.throws(() => loadAttachmentConfig({ ...S3, ATTACHMENTS_S3_ENDPOINT: "http://127.0.0.1:9000" }, "production"), /https/);
    assert.ok(loadAttachmentConfig({ ...S3, ATTACHMENTS_S3_ENDPOINT: "http://127.0.0.1:9000" }, "test").s3);
    assert.throws(() => loadAttachmentConfig({ ...S3, ATTACHMENTS_S3_ENDPOINT: "https://key:secret@storage.example.invalid" }, "production"), /credentials/);
    assert.throws(() => loadAttachmentConfig({ ATTACHMENTS_STORE: "dropbox" }, "production"), /gridfs/);
    assert.throws(() => loadAttachmentConfig({ ATTACHMENTS_MIGRATION_MAX_FILE_MB: "500" }, "production"), /between 10 and 100/);
    assert.equal(loadAttachmentConfig({ ATTACHMENTS_MIGRATION_MAX_FILE_MB: "25" }, "production").migrationMaxFileBytes, 25 * MB);
  });
});

describe("object storage beside GridFS (app on the fake database, S3 mock)", () => {
  let s3, app, board, record;
  const call = (method, p, body) => api(app.url, method, `/api/v1${p}`, body);
  before(async () => {
    s3 = await startMockS3();
    const s3Store = createS3FileStore(s3Settings(s3));
    s3Store.maxTotalBytes = 50 * MB;
    app = await startMongoApp({ s3Store, attachments: { defaultProvider: "gridfs", s3: null } });
    const ws = (await call("POST", "/workspaces", { name: "Files" })).body.workspace;
    board = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Docs", columns: COLUMNS })).body.board;
    record = (await call("POST", `/boards/${board.id}/records`, { values: { serial: "R1" } })).body.record;
  });
  after(async () => { await app.close(); await s3.close(); });
  const docs = () => app.db.collection("attachments").docs;
  const files = () => app.dataLayer.services.files;

  test("an existing GridFS file keeps working after new uploads switch to the bucket; each is read and deleted where it lives", async () => {
    const a = await upload(app.url, record.id, PNG, { name: "gridfs.png" });
    assert.equal(a.status, 201);
    const aDoc = docs().find((d) => d._id.toHexString() === a.body.attachment.id);
    assert.equal(aDoc.storage, undefined, "GridFS documents keep their old shape");
    files().storage.defaultProvider = "s3"; // the configured switch (ATTACHMENTS_STORE=s3)
    const b = await upload(app.url, record.id, PNG, { name: "bucket.png" });
    assert.equal(b.status, 201);
    const bDoc = docs().find((d) => d._id.toHexString() === b.body.attachment.id);
    assert.deepEqual(bDoc.storage, { provider: "s3", key: `att/${b.body.attachment.id}` });
    assert.ok(s3.objects.has(`att/${b.body.attachment.id}`)); assert.ok(!s3.objects.has(a.body.attachment.id));
    assert.ok(!bDoc.storage.key.includes("bucket"), "object keys never contain file names");
    for (const x of [a, b]) { const d = await downloadSafe(app.url, `/api/v1/attachments/${x.body.attachment.id}/content`); assert.equal(d.status, 200); assert.ok(d.bytes.equals(PNG)); }
    assert.equal((await call("DELETE", `/attachments/${a.body.attachment.id}`)).status, 200);
    assert.ok(s3.objects.has(`att/${b.body.attachment.id}`), "deleting a GridFS file leaves the bucket alone");
    assert.equal((await call("DELETE", `/attachments/${b.body.attachment.id}`)).status, 200);
    assert.ok(!s3.objects.has(`att/${b.body.attachment.id}`));
    assert.equal(app.fileStore.files.size, 0);
  });

  test("the bucket is private and credentials stay on the server", async () => {
    const b = await upload(app.url, record.id, PNG);
    const key = `att/${b.body.attachment.id}`;
    const anonymous = await fetch(`${s3.endpoint}/${s3.bucket}/${key}`);
    assert.equal(anonymous.status, 403);
    const meta = await call("GET", `/records/${record.id}/attachments`);
    assert.doesNotMatch(JSON.stringify(meta.body), /test-secret|att\/|storage|127\.0\.0\.1/);
    await call("DELETE", `/attachments/${b.body.attachment.id}`);
  });

  test("download failures: missing object → 404, truncated transfer → connection dropped (never a silent short file)", async () => {
    const b = await upload(app.url, record.id, PNG);
    s3.truncateNextGet();
    const cut = await downloadSafe(app.url, `/api/v1/attachments/${b.body.attachment.id}/content`);
    assert.ok(cut.status === 0 || !cut.bytes.equals(PNG) && cut.bytes.length < PNG.length);
    s3.objects.delete(`att/${b.body.attachment.id}`);
    assert.equal((await downloadSafe(app.url, `/api/v1/attachments/${b.body.attachment.id}/content`)).status, 404);
    await call("DELETE", `/attachments/${b.body.attachment.id}`);
  });

  test("an interrupted bucket upload leaves no attachment, no object and no reserved quota", async () => {
    for (let i = 0; i < 4; i += 1) s3.failNext({ op: "PutObject", status: 500 });
    const before = docs().length, objects = s3.objects.size;
    const r = await upload(app.url, record.id, PNG);
    assert.ok(r.status >= 400);
    assert.equal(docs().length, before); assert.equal(s3.objects.size, objects);
    const usage = await app.db.collection("storageUsage").findOne({ _id: "s3" });
    assert.equal(usage.reservedBytes, 0);
  });

  test("public uploads stay at 10 MB and the four types, also with object storage", async () => {
    const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(10 * MB + 1)]);
    const before = docs().length, objects = s3.objects.size;
    // Over 10 MB the server answers 413 and closes the connection without reading the body (existing behaviour),
    // which a client may see as the 413 or as a reset. Either way nothing is stored.
    const res = await upload(app.url, record.id, big).catch((e) => ({ status: 0, error: e }));
    assert.ok(res.status === 413 || res.error?.cause?.code === "ECONNRESET", String(res.status));
    assert.equal(docs().length, before); assert.equal(s3.objects.size, objects);
    assert.equal((await upload(app.url, record.id, Buffer.from("a,b\n1,2\n"), { type: "text/csv", name: "x.csv" })).status, 415);
    assert.equal((await upload(app.url, record.id, Buffer.from("....ftypheic........"), { type: "image/heic", name: "x.heic" })).status, 415);
  });

  test("the sweep: orphaned bucket objects go; migration objects and migrated pending files stay; stale normal uploads go", async () => {
    s3.objects.set("att/orphan", { body: Buffer.from("x"), contentType: "image/png", meta: {}, lastModified: new Date(Date.now() - 3 * 3600e3) });
    s3.objects.set("mig/run1/pending", { body: Buffer.from("y"), contentType: "image/png", meta: {}, lastModified: new Date(Date.now() - 3 * 3600e3) });
    const old = new Date(Date.now() - 3 * 3600e3), wsId = new ObjectId(board.workspaceId), bId = new ObjectId(board.id), rId = new ObjectId(record.id);
    const imported = { _id: new ObjectId(), workspaceId: wsId, boardId: bId, recordId: rId, columnKey: "docs", name: "m.png", type: "image/png", size: 1, status: "pending", storage: { provider: "s3", key: "mig/run1/pending" }, imported: { provider: "monday.com", runId: "run1", sourceAssetId: "1" }, createdAt: old };
    const stale = { _id: new ObjectId(), workspaceId: wsId, boardId: bId, recordId: rId, columnKey: "docs", name: "s.png", type: "image/png", size: 7, status: "pending", storage: { provider: "s3", key: "att/stale" }, createdAt: old };
    await app.db.collection("attachments").insertOne(imported); await app.db.collection("attachments").insertOne(stale);
    await app.db.collection("storageUsage").updateOne({ _id: "s3" }, { $inc: { reservedBytes: 7 } });
    await files().sweep();
    assert.ok(!s3.objects.has("att/orphan"), "an object without a document is removed");
    assert.ok(s3.objects.has("mig/run1/pending"), "migration objects are never swept");
    assert.ok(docs().some((d) => d._id.equals(imported._id)), "a migrated pending file is left to the migration's recovery");
    assert.ok(!docs().some((d) => d._id.equals(stale._id)), "a stale normal upload is removed");
    assert.equal((await app.db.collection("storageUsage").findOne({ _id: "s3" })).reservedBytes, 0, "and its reservation given back");
  });
});

describe("storage quota counters", () => {
  const fakeDb = async () => { const fake = new FakeMongoClient(); const db = fake.db("jarc_database"); await ensureDatabase(db); return db; };
  test("start from what is already stored (existing GridFS files included), reserve/commit/release/free, reconcile", async () => {
    const db = await fakeDb();
    await db.collection("attachments").insertOne({ _id: new ObjectId(), size: 100, status: "ready" }); // old GridFS document (no storage field)
    await db.collection("attachments").insertOne({ _id: new ObjectId(), size: 40, status: "ready", storage: { provider: "s3", key: "att/a" } });
    const u = new StorageUsageRepository(db);
    assert.equal(await u.total("gridfs"), 100); assert.equal(await u.total("s3"), 40);
    assert.equal(await u.reserve("gridfs", 50, 160), true); assert.equal(await u.total("gridfs"), 150);
    assert.equal(await u.reserve("gridfs", 20, 160), false, "over the limit"); assert.equal(await u.total("gridfs"), 150, "a refused reservation is taken back");
    await u.commit("gridfs", 50); await u.free("gridfs", 100);
    assert.deepEqual((({ usedBytes, reservedBytes }) => ({ usedBytes, reservedBytes }))(await db.collection("storageUsage").findOne({ _id: "gridfs" })), { usedBytes: 50, reservedBytes: 0 });
    await db.collection("storageUsage").updateOne({ _id: "gridfs" }, { $set: { usedBytes: 999 } });
    const r = await u.reconcile("gridfs");
    assert.equal(r.before.usedBytes, 999); assert.deepEqual(r.after, { usedBytes: 100, reservedBytes: 0 });
  });
});

describe("file compatibility decisions", () => {
  test("each monday file kind has a defined, non-destructive handling", () => {
    assert.equal(classifyAsset({ name: "a.pdf", extension: ".pdf", sizeBytes: 1000 }).action, "store");
    assert.deepEqual((({ action, oversized }) => ({ action, oversized }))(classifyAsset({ name: "scan.pdf", extension: "pdf", sizeBytes: 15 * MB })), { action: "store-oversized", oversized: true });
    assert.equal(classifyAsset({ name: "huge.pdf", extension: "pdf", sizeBytes: 25 * MB }).action, "hold-too-large");
    assert.deepEqual((({ action, type, plannedName }) => ({ action, type, plannedName }))(classifyAsset({ name: "photo.jfif", extension: ".jfif", sizeBytes: 10 })), { action: "rename-jfif", type: "image/jpeg", plannedName: "photo.jpg" });
    assert.deepEqual((({ action, type }) => ({ action, type }))(classifyAsset({ name: "IMG.HEIC", extension: "heic", sizeBytes: 10 })), { action: "preserve-heic", type: "image/heic" });
    assert.deepEqual((({ action, type }) => ({ action, type }))(classifyAsset({ name: "x.csv", extension: "csv", sizeBytes: 10 })), { action: "download-only", type: "text/csv" });
    assert.equal(classifyAsset({ name: "x.exe", extension: "exe", sizeBytes: 10 }).action, "quarantine");
  });
});

// ---- the migration plan ------------------------------------------------------------------------------------------
const withFileKinds = (d) => {
  d["attachments-manifest.json"].references.push({ asset_id: "901", name: "scan.jfif", file_extension: ".jfif", file_size_bytes: 300, source: "item", item_id: "1011" }, { asset_id: "902", name: "export.csv", file_extension: ".csv", file_size_bytes: 200, source: "item", item_id: "1012" });
};
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const freshPlan = (mutate = withFileKinds) => { const d = fixture(mutate); tmpDirs.push(d); return dryRun(d); };

describe("plan: native Files columns and the attachment plan", () => {
  test("text snapshots kept, genuine Files columns added, one attachment per stored file, Updates linked, digest changes", () => {
    const r = freshPlan();
    assert.equal(r.validation.ok, true, JSON.stringify(r.validation.errors.slice(0, 3)));
    const keys = r.plan.board.columns.map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length, "no duplicate column keys");
    assert.equal(r.plan.board.columns.find((c) => c.key === "m_files1").type, "text", "the text snapshot stays");
    assert.equal(r.plan.board.columns.find((c) => c.key === "m_files1_files").type, "files");
    assert.equal(r.plan.board.columns.find((c) => c.key === "m_update_files").type, "files");
    for (const rec of r.plan.records) assert.equal(rec.values.m_files1_files, "");
    const byAsset = new Map(r.plan.attachments.map((a) => [a.sourceAssetId, a]));
    assert.equal(byAsset.get("555").columnKey, "m_files1_files"); assert.equal(byAsset.get("555").action, "store-oversized");
    assert.equal(byAsset.get("777").columnKey, "m_update_files", "an Update's file goes to Files from Updates");
    assert.equal(byAsset.get("777").linkedCommentIds.length, 1);
    const u = r.plan.comments.find((c) => c.imported.sourceUpdateId === "3001" && !c.parentId);
    assert.ok(u.imported.attachments[0].attachmentId.equals(byAsset.get("777")._id), "the Update links to the stored file");
    assert.equal(byAsset.get("888").action, "preserve-heic"); assert.equal(byAsset.get("901").action, "rename-jfif"); assert.equal(byAsset.get("902").action, "download-only");
    assert.equal(r.plan.attachments.length, r.validation.attachments.uniqueAssets, "every asset once, duplicates folded");
    const old = freshPlan(() => {});
    assert.notEqual(r.digest, old.digest);
  });
  test("old approvals stop working automatically when the plan changes", () => {
    const r = freshPlan();
    const target = { scope: "local-test", dbName: "jarc_migration_test_x", instanceId: "A".repeat(24) };
    const approval = { kind: "monday-migration-approval", version: 2, scope: "local-test", planDigest: "85de7019c7f928e0e765095befb56a53cda6ea82619a9e3e433c6ccc9f4261e9", targetDatabase: target.dbName, targetInstanceId: target.instanceId, targetWorkspaceId: new ObjectId().toHexString(), approvedBy: "x", operator: "op", approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), include: [...executor.SCOPE], expectedCounts: executor.planCounts(r.plan) };
    assert.ok(executor.checkAuthorization(approval, { planDigest: r.digest, plan: r.plan, target, operator: "op" }).some((p) => /digest/.test(p)));
  });
});

// ---- production target and approvals (mocks only) -------------------------------------------------------------------
describe("production target verification (mocks; production execution stays disabled)", () => {
  const POLICY = Object.freeze({ ...prod.PRODUCTION_POLICY, clusterHosts: ["jarc-cluster.abcde.mongodb.net"], replicaSetName: "atlas-abc-shard-0", memberHostSuffix: ".abcde.mongodb.net", administrators: [{ tenantId: "00000000-0000-4000-8000-00000000a001", objectId: "00000000-0000-4000-8000-0000000000ad", label: "the JARC administrator" }] });
  const URI = "mongodb+srv://jarc_migration_m1:secret@jarc-cluster.abcde.mongodb.net/?retryWrites=true";
  const goodStatus = { authInfo: { authenticatedUsers: [{ user: "jarc_migration_m1", db: "admin" }], authenticatedUserRoles: [{ role: "readWrite", db: "jarc_database" }], authenticatedUserPrivileges: [{ resource: { db: "jarc_database", collection: "" }, actions: ["find", "insert"] }] } };
  const fakeAtlas = ({ status = goodStatus, hello = { setName: "atlas-abc-shard-0", me: "ac-1-shard-00-01.abcde.mongodb.net:27017", hosts: ["ac-1-shard-00-00.abcde.mongodb.net:27017", "ac-1-shard-00-01.abcde.mongodb.net:27017"] } } = {}) => ({ db: () => ({ command: async (c) => (c.hello ? hello : c.connectionStatus ? status : assert.fail("unexpected command")) }) });
  test("refused today: no production cluster is approved in code", async () => {
    await assert.rejects(() => prod.verifyProductionTarget({ client: fakeAtlas(), uri: URI, dbName: "jarc_database" }), /no production cluster is approved/);
  });
  test("with a reviewed policy: exact cluster, jarc_database, and a temporary user with jarc_database privileges only", async () => {
    const v = (o = {}) => prod.verifyProductionTarget({ client: fakeAtlas(o), uri: o.uri || URI, dbName: o.dbName || "jarc_database", policy: POLICY });
    const t = await v();
    assert.equal(t.scope, "production");
    await assert.rejects(() => v({ uri: "mongodb+srv://u:p@other-cluster.zzz.mongodb.net/" }), /not the approved JARC cluster/);
    await assert.rejects(() => v({ uri: "mongodb://u:p@ac-1-shard-00-00.abcde.mongodb.net:27017/" }), /mongodb\+srv/);
    await assert.rejects(() => v({ dbName: "receiptflow" }), /exactly jarc_database/);
    await assert.rejects(() => v({ hello: { setName: "other", me: "x.abcde.mongodb.net:27017", hosts: [] } }), /replica set/);
    const priv = (extra) => ({ authInfo: { ...goodStatus.authInfo, ...extra } });
    await assert.rejects(() => v({ status: priv({ authenticatedUserPrivileges: [...goodStatus.authInfo.authenticatedUserPrivileges, { resource: { db: "receiptflow", collection: "" }, actions: ["find"] }] }) }), /database receiptflow/);
    await assert.rejects(() => v({ status: priv({ authenticatedUserRoles: [{ role: "readWriteAnyDatabase", db: "admin" }] }) }), /reaches beyond/);
    await assert.rejects(() => v({ status: priv({ authenticatedUserPrivileges: [{ resource: { cluster: true }, actions: ["shutdown"] }] }) }), /cluster-wide/);
    await assert.rejects(() => v({ status: priv({ authenticatedUsers: [{ user: "app_user", db: "admin" }] }) }), /temporary jarc_migration_/);
  });
  test("a verified production target is still refused by the executor and the attachment importer", async () => {
    const t = await prod.verifyProductionTarget({ client: fakeAtlas(), uri: URI, dbName: "jarc_database", policy: POLICY });
    const r = freshPlan();
    await assert.rejects(() => executor.runImport({ client: {}, target: t, plan: r.plan, planDigest: r.digest, approval: {} }), (e) => e.code === "MIGRATION_PRODUCTION_LOCKED");
    assert.throws(() => new AttachmentImporter({ client: {}, target: t, plan: r.plan, planDigest: r.digest, approval: {}, storage: new AttachmentStorage({ stores: { gridfs: new MemoryFileStore() } }), provider: "gridfs", maxBytes: 20 * MB }), (e) => e.code === "MIGRATION_PRODUCTION_LOCKED");
    assert.equal(executor.PRODUCTION_EXECUTION_ENABLED, false);
  });
  test("production approval: single verified administrator, fresh Entra sign-in, backup, window, digest, workspace", async () => {
    const t = await prod.verifyProductionTarget({ client: fakeAtlas(), uri: URI, dbName: "jarc_database", policy: POLICY });
    const now = new Date("2026-11-10T02:00:00Z"), ws = { _id: new ObjectId() };
    const admin = { tenantId: POLICY.administrators[0].tenantId, objectId: POLICY.administrators[0].objectId };
    const ok = { kind: "monday-migration-approval", version: 3, scope: "production", planDigest: "d".repeat(64), targetDatabase: "jarc_database", targetCluster: "jarc-cluster.abcde.mongodb.net", targetWorkspaceId: ws._id.toHexString(), approver: admin, operator: admin, approvedAt: "2026-11-09T20:00:00Z", expiresAt: "2026-11-10T06:00:00Z", window: { name: "Machine Installations migration", start: "2026-11-10T01:00:00Z", end: "2026-11-10T04:00:00Z" }, backup: { kind: "atlas-snapshot", reference: "6ae1868eae8f30185315b058", takenAt: "2026-11-10T00:30:00Z" }, expectedCounts: { items: 1 } };
    const auth = { tid: admin.tenantId, oid: admin.objectId, roles: ["JARC.Admin"], auth_time: now.getTime() / 1000 - 300 };
    const check = (a, extra = {}) => prod.checkProductionApproval(a, { planDigest: "d".repeat(64), target: t, operatorAuth: auth, expectedCounts: { items: 1 }, workspace: ws, now, policy: POLICY, ...extra });
    assert.deepEqual(check(ok), [], "one verified administrator may approve and operate");
    const bad = (patch, extra) => assert.ok(check({ ...ok, ...patch }, extra).length, JSON.stringify(patch));
    bad({}, { policy: { ...POLICY, requireSeparateApprover: true } });
    bad({ approver: { tenantId: admin.tenantId, objectId: "00000000-0000-4000-8000-0000000000ff" } });
    bad({ approver: { email: "super.admin@jarc.example.invalid" } }); // an email is never an identity
    bad({}, { operatorAuth: { ...auth, roles: [] } });
    bad({}, { operatorAuth: { ...auth, auth_time: now.getTime() / 1000 - 3600 } });
    bad({}, { operatorAuth: { ...auth, oid: "00000000-0000-4000-8000-0000000000ee" } });
    bad({ planDigest: "e".repeat(64) });
    bad({ targetWorkspaceId: new ObjectId().toHexString() });
    bad({ window: { ...ok.window, end: "2026-11-10T01:30:00Z" } });
    bad({ backup: { ...ok.backup, takenAt: "2026-11-08T00:00:00Z" } });
    bad({ backup: { kind: "mongodump", reference: "dump.gz", takenAt: "2026-11-10T00:30:00Z" } });
    bad({ expiresAt: "2026-11-10T01:59:00Z" });
    bad({ version: 2 });
  });
});

describe("staged workspace access (plan and approval)", () => {
  const tenant = "00000000-0000-4000-8000-00000000a001", admin = { tenantId: tenant, objectId: "00000000-0000-4000-8000-0000000000ad" };
  const user = (oid, extra = {}) => ({ _id: new ObjectId(), source: "entra", status: "active", tenantId: tenant, entraObjectId: oid, ...extra });
  const adminUser = user(admin.objectId), viewer = user("00000000-0000-4000-8000-000000000001"), external = user("00000000-0000-4000-8000-000000000002", { tenantId: "00000000-0000-4000-8000-0000000000ff" });
  const users = new Map([adminUser, viewer, external].map((u) => [u._id.toHexString(), u]));
  const ws = { _id: new ObjectId() };
  test("stage 1 is the administrator only; stage 2 viewers; stage 3 editors only after stage 2; no external people", () => {
    const s1 = access.planAccessStage({ stage: 1, workspace: ws, members: [], users, administrator: admin, requested: [{ userId: adminUser._id.toHexString(), role: "WORKSPACE_ADMIN" }] });
    assert.deepEqual(s1.problems, []); assert.deepEqual(s1.changes.map((c) => c.to), ["WORKSPACE_ADMIN"]);
    const crowded = access.planAccessStage({ stage: 1, workspace: ws, members: [{ userId: viewer._id, role: "MEMBER", status: "active" }], users, administrator: admin, requested: [{ userId: adminUser._id.toHexString(), role: "WORKSPACE_ADMIN" }] });
    assert.ok(crowded.problems.some((p) => /another member/.test(p)));
    assert.ok(access.planAccessStage({ stage: 1, workspace: ws, members: [], users, administrator: admin, requested: [{ userId: viewer._id.toHexString(), role: "WORKSPACE_ADMIN" }] }).problems.length);
    const s2 = access.planAccessStage({ stage: 2, workspace: ws, members: [], users, administrator: admin, requested: [{ userId: viewer._id.toHexString(), role: "VIEWER" }, { userId: external._id.toHexString(), role: "VIEWER" }, { userId: new ObjectId().toHexString(), role: "VIEWER" }] });
    assert.deepEqual(s2.changes, [{ userId: viewer._id.toHexString(), from: null, to: "VIEWER" }]);
    assert.ok(s2.problems.some((p) => /tenant/.test(p))); assert.ok(s2.problems.some((p) => /no invitations/.test(p)));
    assert.ok(access.planAccessStage({ stage: 3, workspace: ws, members: [], users, administrator: admin, requested: [{ userId: viewer._id.toHexString(), role: "MEMBER" }] }).problems.some((p) => /stage 2/.test(p)));
    const s3 = access.planAccessStage({ stage: 3, workspace: ws, members: [{ userId: viewer._id, role: "VIEWER", status: "active" }], users, administrator: admin, requested: [{ userId: viewer._id.toHexString(), role: "MEMBER" }] });
    assert.deepEqual(s3.changes, [{ userId: viewer._id.toHexString(), from: "VIEWER", to: "MEMBER" }]);
  });
  test("open-editing settings are reported as conflicts; only the verified administrator can approve a stage", () => {
    const plan = access.planAccessStage({ stage: 2, workspace: ws, members: [], users, administrator: admin, requested: [{ userId: viewer._id.toHexString(), role: "VIEWER" }], config: { betaOpenEditing: true } });
    assert.ok(plan.conflicts.some((c) => /JARC_BETA_OPEN_EDITING/.test(c)));
    const now = new Date();
    const approval = { kind: "workspace-access-approval", version: 1, stage: 2, workspaceId: ws._id.toHexString(), changesDigest: plan.digest, approver: admin, approvedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now.getTime() + 3600e3).toISOString() };
    assert.ok(access.checkAccessApproval(approval, plan, { administrator: admin, now }).some((p) => /acknowledged/.test(p)));
    assert.deepEqual(access.checkAccessApproval({ ...approval, acknowledgeConflicts: true }, plan, { administrator: admin, now }), []);
    assert.ok(access.checkAccessApproval({ ...approval, acknowledgeConflicts: true, approver: { email: "someone@jarc.example.invalid" } }, plan, { administrator: admin, now }).length);
    assert.ok(access.checkAccessApproval({ ...approval, acknowledgeConflicts: true, changesDigest: "0".repeat(64) }, plan, { administrator: admin, now }).length);
  });
});

describe("backup references", () => {
  test("concrete, recent, jarc_database-only and restore-tested", () => {
    const now = new Date("2026-11-10T02:00:00Z"), windowStart = "2026-11-10T01:00:00Z";
    assert.deepEqual(checkBackupReference({ kind: "atlas-snapshot", reference: "6ae1868eae8f30185315b058", takenAt: "2026-11-10T00:30:00Z", restoreTestedAt: "2026-11-10T00:50:00Z" }, { windowStart, now }), []);
    assert.deepEqual(checkBackupReference({ kind: "mongodump", database: "jarc_database", sha256: "a".repeat(64), sizeBytes: 123, takenAt: "2026-11-10T00:30:00Z", restoreTestedAt: "x" }, { windowStart, now }), []);
    assert.ok(checkBackupReference({ kind: "mongodump", database: "receiptflow", sha256: "a".repeat(64), sizeBytes: 1, takenAt: "2026-11-10T00:30:00Z", restoreTestedAt: "x" }, { windowStart, now }).length);
    assert.ok(checkBackupReference({ kind: "atlas-snapshot", reference: "6ae1868eae8f30185315b058", takenAt: "2026-11-08T00:30:00Z", restoreTestedAt: "x" }, { windowStart, now }).length);
    assert.ok(checkBackupReference({ kind: "atlas-snapshot", reference: "6ae1868eae8f30185315b058", takenAt: "2026-11-10T00:30:00Z" }, { windowStart, now }).some((p) => /restore-tested/.test(p)));
    assert.ok(checkBackupReference({ kind: "screenshot" }, { windowStart, now }).length);
  });
});

// ---- integration: the verified local test instance + S3 mock -----------------------------------------------------
const ROOT = path.resolve(__dirname, "../..");
function localEnv() {
  const f = path.join(ROOT, ".env.migration-test"); if (!fs.existsSync(f)) return null;
  const out = {}; for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) { const m = /^\s*(JARC_MIGRATION_TEST_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m) out[m[1]] = m[2]; }
  return out.JARC_MIGRATION_TEST_MONGODB_URI ? out : null;
}
const portOpen = () => new Promise((resolve) => { const s = net.connect({ host: "127.0.0.1", port: 27027 }); s.once("connect", () => { s.end(); resolve(true); }); s.once("error", () => resolve(false)); setTimeout(() => { s.destroy(); resolve(false); }, 1000); });
const synthetic = (entry) => {
  const n = entry.sizeBytes, pad = (head) => Buffer.concat([head, Buffer.alloc(Math.max(0, n - head.length), 0x41)]).subarray(0, n);
  const body = entry.plannedType === "application/pdf" ? pad(Buffer.from("%PDF-1.7\n")) : entry.plannedType === "image/jpeg" ? pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])) : entry.plannedType === "image/png" ? pad(PNG.subarray(0, 8)) : entry.plannedType === "image/heic" ? pad(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic")])) : pad(Buffer.from("a,b\n1,2\n"));
  return { body, source: { sha256: sha(body), size: body.length, open: () => Readable.from([body]) } };
};

describe("migration attachments, rollback and locks on the verified local test instance", { concurrency: false }, async () => {
  const env = localEnv();
  if (!(env && await portOpen())) { test("local test instance not running (scripts/migration-test-db.js start)", { skip: true }, () => {}); return; }
  const client = new MongoClient(env.JARC_MIGRATION_TEST_MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  let s3, r;
  before(async () => { await client.connect(); s3 = await startMockS3(); r = freshPlan(); });
  after(async () => { await client.close(); await s3.close(); });
  async function setup() {
    const dbName = `jarc_migration_test_t${crypto.randomBytes(6).toString("hex")}`;
    const target = await verifyTarget({ client, uri: env.JARC_MIGRATION_TEST_MONGODB_URI, dbName, instanceId: env.JARC_MIGRATION_TEST_INSTANCE_ID, env: {} });
    const db = client.db(dbName), workspaceId = new ObjectId(), at = new Date();
    await ensureDatabase(db);
    await db.collection(COLLECTIONS.workspaces).insertOne({ _id: workspaceId, name: "Rehearsal", description: "", icon: "R", color: "", archived: false, position: 1000, createdBy: null, createdAt: at, updatedAt: at, version: 1 });
    const base = { kind: "monday-migration-approval", version: 2, scope: "local-test", planDigest: r.digest, targetDatabase: dbName, targetInstanceId: target.instanceId, targetWorkspaceId: workspaceId.toHexString(), approvedBy: "Test", operator: "tester", approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString() };
    const recordsApproval = { ...base, include: [...executor.SCOPE], expectedCounts: executor.planCounts(r.plan) };
    const filesApproval = { ...base, include: [...executor.ATTACHMENT_SCOPE], expectedCounts: executor.attachmentCounts(r.plan) };
    await executor.runImport({ client, target, plan: r.plan, planDigest: r.digest, approval: recordsApproval, operator: "tester" });
    const storage = new AttachmentStorage({ stores: { gridfs: new MemoryFileStore(), s3: createS3FileStore(s3Settings(s3)) }, defaultProvider: "s3" });
    const importer = (extra = {}) => new AttachmentImporter({ client, target, plan: r.plan, planDigest: r.digest, approval: filesApproval, storage, provider: "s3", maxBytes: 20 * MB, limitBytes: 100 * MB, operator: "tester", ...extra });
    return { db, dbName, target, workspaceId, storage, importer, recordsApproval, filesApproval };
  }
  const entry = (asset) => r.plan.attachments.find((a) => a.sourceAssetId === asset);
  const mig = () => [...s3.objects.keys()].filter((k) => k.startsWith(`mig/${r.plan.runId}/`));

  test("stores every planned file safely: pending → bytes → verified → ready, quota exact, Updates linked, served correctly", async () => {
    const { db, storage, importer } = await setup();
    const imp = importer();
    let bytes = 0;
    for (const e of r.plan.attachments) { const { source } = synthetic(e); bytes += source.size; assert.equal((await imp.importOne(e, source)).status, "stored", e.sourceAssetId); }
    const docs = await db.collection("attachments").find({}).toArray();
    assert.equal(docs.length, r.plan.attachments.length);
    assert.ok(docs.every((d) => d.status === "ready" && d.storage.provider === "s3" && d.storage.key.startsWith(`mig/${r.plan.runId}/`) && d.imported.runId === r.plan.runId));
    assert.equal(mig().length, r.plan.attachments.length);
    assert.equal(docs.find((d) => d.imported.sourceAssetId === "555").imported.oversized, true);
    assert.equal(docs.find((d) => d.imported.sourceAssetId === "901").name, "scan.jpg"); assert.equal(docs.find((d) => d.imported.sourceAssetId === "901").imported.originalName, "scan.jfif");
    assert.equal(docs.find((d) => d.imported.sourceAssetId === "777").imported.linkedCommentIds.length, 1);
    const usage = await db.collection("storageUsage").findOne({ _id: "s3" });
    assert.deepEqual([usage.usedBytes, usage.reservedBytes], [bytes, 0]);
    assert.equal(await db.collection("integrationMappings").countDocuments({ kind: "asset" }), r.plan.attachments.length);
    assert.equal(await imp.importOne(entry("777"), synthetic(entry("777")).source).then((x) => x.status), "already", "re-running stores nothing twice");
    // Served through the app: PDF inline, CSV/HEIC only as downloads; the sweep leaves migrated files alone.
    const connection = { db, withTransaction: async (fn) => { const s = client.startSession(); try { return await s.withTransaction(() => fn(s)); } finally { await s.endSession(); } } };
    const layer = createDataLayer({ connection, logger: { error() {} }, fileStore: storage.store("gridfs"), s3Store: storage.store("s3") });
    const devActor = await ensureDevelopmentActor(layer.repos.users, { environment: "test" });
    const app = await startApp({ dataLayer: layer, devActor });
    try {
      for (const [asset, inline] of [["777", true], ["902", false], ["888", false]]) {
        const d = docs.find((x) => x.imported.sourceAssetId === asset);
        const res = await downloadSafe(app.url, `/api/v1/attachments/${d._id.toHexString()}/content`);
        assert.equal(res.status, 200); assert.ok(res.bytes.equals(synthetic(entry(asset)).body));
        assert.match(res.headers.get("content-disposition"), inline ? /^inline/ : /^attachment/);
        if (!inline) assert.equal(res.headers.get("content-type"), "application/octet-stream");
      }
      await layer.services.files.sweep();
      assert.equal(await db.collection("attachments").countDocuments({ status: "ready" }), r.plan.attachments.length);
    } finally { await app.close(); }
  });

  test("refusals: wrong stage approval, oversized without the migration flag, size or checksum mismatch, full quota", async () => {
    const { importer, recordsApproval, db } = await setup();
    assert.throws(() => importer({ approval: recordsApproval }), (e) => e.code === "MIGRATION_NOT_AUTHORIZED");
    assert.throws(() => importer({ operator: "someone-else" }), (e) => e.code === "MIGRATION_NOT_AUTHORIZED");
    assert.throws(() => importer({ planDigest: "0".repeat(64) }), (e) => e.code === "MIGRATION_NOT_AUTHORIZED");
    const imp = importer();
    const big = entry("555");
    await assert.rejects(() => imp.importOne({ ...big, oversized: false }, synthetic(big).source), (e) => e.code === "MIGRATION_ATTACHMENT_TOO_LARGE");
    await assert.rejects(() => imp.importOne(big, { ...synthetic(big).source, size: big.sizeBytes - 1 }), (e) => e.code === "MIGRATION_ATTACHMENT_SIZE");
    const pdf = entry("777"), wrong = synthetic(pdf);
    await assert.rejects(() => imp.importOne(pdf, { ...wrong.source, sha256: "0".repeat(64) }));
    const failed = await db.collection("attachments").findOne({ _id: pdf._id });
    assert.equal(failed.status, "failed"); assert.ok(!s3.objects.has(`mig/${r.plan.runId}/${pdf._id.toHexString()}`));
    assert.equal((await db.collection("storageUsage").findOne({ _id: "s3" })).reservedBytes, 0);
    assert.equal((await imp.importOne(pdf, wrong.source)).status, "stored", "a retry after a failure cleans up and stores");
    const tight = importer({ limitBytes: 1000 });
    await assert.rejects(() => tight.importOne(big, synthetic(big).source), (e) => e.code === "MIGRATION_STORAGE_FULL");
    assert.equal(await db.collection("attachments").countDocuments({ _id: big._id }), 0, "nothing pending left behind");
    const notType = { ...pdf, plannedType: "application/x-msdownload" };
    await assert.rejects(() => imp.importOne(notType, wrong.source), (e) => e.code === "MIGRATION_ATTACHMENT_TYPE");
  });

  test("interruption: a crash after storing leaves a pending file the sweep won't touch; the next run cleans and completes it; a source error mid-stream fails cleanly", async () => {
    const { db, importer, storage } = await setup();
    const heic = entry("888");
    await assert.rejects(() => importer({ faults: { crashAfterStore: "888" } }).importOne(heic, synthetic(heic).source));
    assert.equal((await db.collection("attachments").findOne({ _id: heic._id })).status, "pending");
    const connection = { db, withTransaction: async (fn) => fn() };
    await createDataLayer({ connection, logger: { error() {} }, fileStore: storage.store("gridfs"), s3Store: storage.store("s3") }).services.files.sweep();
    assert.equal((await db.collection("attachments").findOne({ _id: heic._id })).status, "pending", "the sweep leaves migrated files to the migration");
    assert.equal((await importer().importOne(heic, synthetic(heic).source)).status, "stored");
    assert.equal(mig().filter((k) => k.endsWith(heic._id.toHexString())).length, 1, "one object, no duplicates");
    const csv = entry("902"), body = synthetic(csv).body;
    const broken = { ...synthetic(csv).source, open: () => new Readable({ read() { this.push(body.subarray(0, 50)); this.destroy(new Error("network dropped")); } }) };
    await assert.rejects(() => importer().importOne(csv, broken));
    assert.equal((await db.collection("attachments").findOne({ _id: csv._id })).status, "failed");
    assert.equal((await db.collection("storageUsage").findOne({ _id: "s3" })).reservedBytes, 0);
  });

  test("a conflicting mapping or a non-migrated document in the way stops the importer", async () => {
    const { db, importer, workspaceId } = await setup();
    const e = entry("901");
    await db.collection("integrationMappings").insertOne({ provider: "monday-migration", kind: "asset", sourceId: "901", targetId: new ObjectId(), runId: r.plan.runId });
    await assert.rejects(() => importer().importOne(e, synthetic(e).source), (x) => x.code === "MIGRATION_MAPPING_CONFLICT");
    const e2 = entry("902");
    await db.collection("attachments").insertOne({ _id: e2._id, workspaceId, recordId: e2.recordId, boardId: e2.boardId, columnKey: e2.columnKey, status: "ready", size: 1 });
    await assert.rejects(() => importer().importOne(e2, synthetic(e2).source), (x) => x.code === "MIGRATION_DESTINATION_CONFLICT");
  });

  test("rollback: dry run first, blocked by later work, then removes exactly this run (files, records, comments, boards, mappings)", async () => {
    const { db, target, importer, storage } = await setup();
    const imp = importer();
    for (const e of r.plan.attachments) await imp.importOne(e, synthetic(e).source);
    const other = { _id: new ObjectId(), name: "Someone else's board", workspaceId: new ObjectId(), columns: [], groups: [], version: 1 };
    await db.collection("boards").insertOne(other);
    let dry = await planRollback(db, r.plan);
    assert.equal(dry.ok, true, JSON.stringify(dry.blockers));
    assert.deepEqual(dry.counts, { boards: 2, records: r.plan.records.length + r.plan.subRecords.length, comments: r.plan.comments.length, attachments: r.plan.attachments.length, mappings: r.plan.mappings.length + r.plan.attachments.length, activities: 2 });
    await db.collection("records").updateOne({ _id: r.plan.records[0]._id }, { $set: { version: 2 } });
    await db.collection("comments").insertOne({ _id: new ObjectId(), recordId: r.plan.records[1]._id, boardId: r.plan.board._id, body: "a person's note", createdAt: new Date() });
    dry = await planRollback(db, r.plan);
    assert.ok(dry.blockers.some((b) => /edited/.test(b))); assert.ok(dry.blockers.some((b) => /posted by people/.test(b)));
    const approval = (counts) => ({ kind: "migration-rollback-approval", version: 1, runId: r.plan.runId, planDigest: r.digest, expectedCounts: counts, approvedBy: "Test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
    await assert.rejects(() => executeRollback({ client, target, plan: r.plan, planDigest: r.digest, approval: approval(dry.counts), storage }), (e) => e.code === "MIGRATION_ROLLBACK_REFUSED");
    await db.collection("records").updateOne({ _id: r.plan.records[0]._id }, { $set: { version: 1 } });
    await db.collection("comments").deleteOne({ body: "a person's note" }); // test-only: undo the simulated later work
    dry = await planRollback(db, r.plan);
    await assert.rejects(() => executeRollback({ client, target, plan: r.plan, planDigest: r.digest, approval: approval({ ...dry.counts, records: 1 }), storage }), (e) => e.code === "MIGRATION_ROLLBACK_REFUSED");
    const res = await executeRollback({ client, target, plan: r.plan, planDigest: r.digest, approval: approval(dry.counts), storage });
    assert.deepEqual(res.removed, { comments: dry.counts.comments, records: dry.counts.records, boards: 2, activities: 2, mappings: dry.counts.mappings, attachments: dry.counts.attachments });
    for (const c of ["records", "comments", "attachments", "integrationMappings"]) assert.equal(await db.collection(c).countDocuments({}), 0, c);
    assert.equal(mig().filter((k) => r.plan.attachments.some((a) => k.endsWith(a._id.toHexString()))).length, 0, "migration objects removed");
    assert.ok(await db.collection("boards").findOne({ _id: other._id }), "nothing outside the run is touched");
    assert.equal((await db.collection("integrationJobs").findOne({ _id: `monday-migration:${r.plan.runId}` })).status, "rolled-back");
    const usage = await db.collection("storageUsage").findOne({ _id: "s3" });
    assert.deepEqual([usage.usedBytes, usage.reservedBytes], [0, 0]);
  });

  test("an expired run lock is only taken over on request, and the takeover is recorded", async () => {
    const { db, target, recordsApproval } = await setup();
    const jobId = `monday-migration:${r.plan.runId}`;
    await db.collection("integrationJobs").updateOne({ _id: jobId }, { $set: { lockedBy: "crashed-run", lockedUntil: new Date(Date.now() - 60e3) } });
    await assert.rejects(() => executor.runImport({ client, target, plan: r.plan, planDigest: r.digest, approval: recordsApproval, operator: "tester" }), (e) => e.code === "MIGRATION_STALE_LOCK");
    const res = await executor.runImport({ client, target, plan: r.plan, planDigest: r.digest, approval: recordsApproval, operator: "tester", takeOverStaleLock: true });
    assert.equal(res.batchesDone, 0);
    const job = await db.collection("integrationJobs").findOne({ _id: jobId });
    assert.equal(job.history.at(-1).event, "stale-lock-takeover"); assert.equal(job.history.at(-1).previousLockedBy, "crashed-run"); assert.equal(job.history.at(-1).by, "tester");
    assert.equal(job.lockedBy, null);
  });

  test("concurrent quota reservations never exceed the limit (real MongoDB)", async () => {
    const { db } = await setup();
    const u = new StorageUsageRepository(db);
    const results = await Promise.all(Array.from({ length: 60 }, () => u.reserve("s3", 10, 250)));
    const won = results.filter(Boolean).length;
    assert.ok(won <= 25 && won > 0, String(won));
    const d = await db.collection("storageUsage").findOne({ _id: "s3" });
    assert.equal(d.reservedBytes, won * 10); assert.ok(d.usedBytes + d.reservedBytes <= 250);
  });

  test("access stages apply only on the local test target, after the administrator's approval", async () => {
    const { db, target, workspaceId } = await setup();
    const tenant = "00000000-0000-4000-8000-00000000a001", admin = { tenantId: tenant, objectId: "00000000-0000-4000-8000-0000000000ad" };
    const adminUser = { _id: new ObjectId(), source: "entra", status: "active", tenantId: tenant, entraObjectId: admin.objectId };
    await db.collection("users").insertOne(adminUser);
    const plan = access.planAccessStage({ stage: 1, workspace: { _id: workspaceId }, members: [], users: new Map([[adminUser._id.toHexString(), adminUser]]), administrator: admin, requested: [{ userId: adminUser._id.toHexString(), role: "WORKSPACE_ADMIN" }] });
    const approval = { kind: "workspace-access-approval", version: 1, stage: 1, workspaceId: workspaceId.toHexString(), changesDigest: plan.digest, approver: admin, approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString() };
    await assert.rejects(() => access.applyAccessStage({ client, target, plan, approval: { ...approval, approver: { tenantId: tenant, objectId: "00000000-0000-4000-8000-0000000000ff" } }, administrator: admin }), (e) => e.code === "ACCESS_NOT_AUTHORIZED");
    assert.equal(await db.collection("workspaceMembers").countDocuments({}), 0);
    assert.deepEqual(await access.applyAccessStage({ client, target, plan, approval, administrator: admin }), { applied: 1 });
    assert.equal((await db.collection("workspaceMembers").findOne({ userId: adminUser._id })).role, "WORKSPACE_ADMIN");
  });
});
