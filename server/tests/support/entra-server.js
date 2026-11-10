// TEST-ONLY server for browser tests of Microsoft Entra sign-in: the real app with AUTH_MODE=entra (ID tokens verified
// against a LOCAL test key, server sessions) on the fake MongoDB. Never imported by src/ and never started by npm start.
//
//   node tests/support/entra-server.js <port> [shared]   (sign-in redirect URI: http://localhost:<port>/)
//   GET  /__test/id-token?oid=&name=&email=&admin=0|1&nonce=   → a test ID token (what Microsoft would issue)
//   POST /__test/config { expireSessions, disableEmail, enableEmail, legacyActivity } → end every session / disable or
//        enable a user / add an old-style activity entry without an actor (legacyActivity: workspace ID)
//   GET  /__test/stats  → protected API requests, and any that arrived without a session cookie
//   JARC_TEST_BETA=1: JARC_BETA_OPEN_EDITING (beta open editing) on top of the access policy
//   JARC_TEST_ACCOUNTS=staged|enforced: Account Management; JARC_TEST_SUPER_ADMIN_OID: the configured Super Admin
//   JARC_TEST_MONDAY=1: the monday.com integration is configured against the MOCK monday.com (tests/support/mock-monday)
//   POST /__test/monday { connect, run }  → store a (mock) connection directly / run due integration jobs once
//   JARC_TEST_GDRIVE=1: Google Drive storage is on, against the MOCK Google (tests/support/mock-google-drive);
//   JARC_TEST_GDRIVE_ADMINS: the Drive administrators' object IDs (GOOGLE_DRIVE_ADMIN_OIDS)
//   JARC_TEST_MID=1 (with JARC_TEST_GDRIVE=1): the Machine Installation Database attachment import is on (monday.com refused)
//   POST /__test/mid { run: true }  → store a synthetic prepared run with two files, to show its controls
//   POST /__test/google-drive { connect, revoke }  → store a (mock) connection directly / make Google refuse it
const express = require("express");
const { ObjectId } = require("mongodb");
const { MongoConnection } = require("../../src/db/connection");
const { ensureDatabase } = require("../../src/db/bootstrap");
const { createDataLayer } = require("../../src/data-layer");
const { MemoryFileStore } = require("../../src/files/file-store");
const { createApp } = require("../../src/app");
const { createEntraVerifier } = require("../../src/auth/entra-token");
const { MemoryStateRepository } = require("../../src/repositories/memory-state-repository");
const { FakeMongoClient } = require("./fake-mongo");
const { createTokenIssuer } = require("./entra-tokens");

const PUBLIC = new Set(["GET /health", "GET /health/ready", "GET /auth/config", "POST /auth/sign-in/start", "POST /auth/session"]);

(async () => {
  const port = Number(process.argv[2] || 3103);
  const issuer = await createTokenIssuer();
  const entra = { ...issuer.config, redirectUri: `http://localhost:${port}/`, appOrigin: `http://localhost:${port}` };
  const fake = new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const monday = process.env.JARC_TEST_MONDAY === "1" ? require("./mock-monday") : null;
  const mock = monday?.mockMonday();
  const mondayConfig = monday ? require("../../src/config").loadMondayConfig(monday.ENV) : null;
  const googleMock = process.env.JARC_TEST_GDRIVE === "1" ? require("./mock-google-drive") : null;
  const google = googleMock?.mockGoogle();
  // JARC_TEST_GDRIVE_ADMINS: GOOGLE_DRIVE_ADMIN_OIDS for this run (comma-separated test object IDs).
  const googleConfig = googleMock ? require("../../src/config").loadGoogleDriveConfig({ ...googleMock.ENV, GOOGLE_DRIVE_ADMIN_OIDS: process.env.JARC_TEST_GDRIVE_ADMINS || "" }, "test", "entra") : null;
  const midConfig = googleMock && process.env.JARC_TEST_MID === "1" ? require("../../src/config").loadMidAttachmentsConfig({ MID_ATTACHMENTS_MIGRATION: "true", GOOGLE_DRIVE_ENABLED: "true", MID_MIGRATION_MONDAY_TOKEN: "test-only" }) : null;
  const dataLayer = createDataLayer({ connection, logger: { error() {} }, fileStore: new MemoryFileStore(), monday: mondayConfig, googleDrive: googleConfig, midAttachments: midConfig, midAttachmentsOptions: { mondayFetch: async (u) => { throw new Error(`refused ${u}`); } }, recordSearch: process.env.JARC_TEST_RECORD_SEARCH || "off", ...(mock ? { fetch: mock.fetch } : google ? { fetch: google.fetch } : {}) });
  await dataLayer.searchIndex.catchUp();
  const verify = createEntraVerifier({ ...entra, keySet: issuer.keySet });
  // Optional 2nd argument "shared": ACCESS_POLICY=development_shared (as on Railway); default role_based.
  const accessPolicy = process.argv[3] === "shared" ? "development_shared" : "role_based";
  // JARC_TEST_API_TOKENS=1: API tokens on, with a key made up for this run.
  const app = createApp({ ...(process.env.JARC_TEST_API_TOKENS === "1" ? { apiTokens: { key: require("crypto").randomBytes(32) } } : {}), ...(process.env.JARC_TEST_FEATURES === "off" ? { features: { nativeForms: false, spreadsheetImports: false } } : {}), repository: new MemoryStateRepository(), environment: "test", dataLayer, auth: { mode: "entra", entra, verify }, accessPolicy, betaOpenEditing: process.env.JARC_TEST_BETA === "1", ...(process.env.JARC_TEST_ACCOUNTS ? { accounts: { mode: process.env.JARC_TEST_ACCOUNTS, superAdmin: process.env.JARC_TEST_SUPER_ADMIN_OID ? { tenantId: entra.tenantId, objectId: process.env.JARC_TEST_SUPER_ADMIN_OID.toLowerCase(), email: null } : null } } : {}), logger: { error() {} } });
  const sim = { protected: 0, withSession: 0, withoutSession: [] };

  const outer = express();
  outer.get("/__test/id-token", async (req, res) => {
    const email = String(req.query.email || "");
    const claims = { oid: String(req.query.oid), name: String(req.query.name || ""), email, preferred_username: email, nonce: String(req.query.nonce || "") };
    if (req.query.admin === "1") claims.roles = ["JARC.Admin"];
    res.set("Cache-Control", "no-store").json({ token: await issuer.token(claims) });
  });
  outer.post("/__test/config", express.json(), async (req, res) => {
    if (req.body.expireSessions) await connection.db.collection("sessions").updateMany({ _id: { $exists: true } }, { $set: { idleExpiresAt: new Date(0) } });
    for (const [field, status] of [["disableEmail", "disabled"], ["enableEmail", "active"]]) {
      if (req.body[field]) await connection.db.collection("users").updateOne({ emailNormalized: String(req.body[field]).toLowerCase() }, { $set: { status } });
    }
    if (req.body.legacyActivity) await connection.db.collection("activities").insertOne({ workspaceId: new ObjectId(String(req.body.legacyActivity)), boardId: null, recordId: null, actorUserId: null, action: "legacy.board.activity", entityType: "board", entityId: null, changes: [], summary: "Imported history", createdAt: new Date() });
    res.json({ ok: true });
  });
  outer.get("/__test/stats", (req, res) => res.json(sim));
  outer.post("/__test/mid", express.json(), async (req, res) => {
    if (!midConfig) return res.status(404).json({ error: "import not enabled" });
    const runId = "mid-0123456789abcdef", now = new Date(), board = new ObjectId();
    await connection.db.collection("integrationJobs").insertOne({ _id: runId, provider: "mid-attachments", type: "mid-attachments-run", status: "prepared", planDigest: "0".repeat(64), sourceRunId: "monday-1-000000000000", boardId: board, workspaceId: new ObjectId(), totals: { files: 2, bytes: 2048 }, remaining: 0, backups: [], createdAt: now, updatedAt: now, runAfter: now });
    for (const assetId of ["1", "2"]) await connection.db.collection("integrationJobs").insertOne({ _id: `${runId}:${assetId}`, provider: "mid-attachments", type: "mid-attachment", runId, status: "queued", attempts: 0, runAfter: now, createdAt: now, params: { assetId, attachmentId: new ObjectId().toHexString(), recordId: new ObjectId().toHexString(), name: `file-${assetId}.pdf`, sizeBytes: 1024 } });
    res.json({ ok: true, runId });
  });
  outer.post("/__test/google-drive", express.json(), async (req, res) => {
    if (!google) return res.status(404).json({ error: "Google mock not enabled" });
    if (req.body.connect) {
      const { encrypt } = require("../../src/integrations/monday/secrets");
      google.refreshTokens.add("refresh-ui-test");
      google.add({ id: "folder-ui-test", name: "JARC Attachments", mimeType: "application/vnd.google-apps.folder", appProperties: { jarcKind: "folder" } });
      await connection.db.collection("integrations").updateOne({ _id: "google-drive" }, { $set: { refreshToken: encrypt("refresh-ui-test", googleConfig.tokenKey), status: "connected", accountEmail: googleMock.ACCOUNT, accountPermissionId: google.permissionId, folderId: "folder-ui-test", folderName: "JARC Attachments", connectedByName: "Ada Admin", connectedAt: new Date(), lastCheckedAt: new Date(), lastError: null } }, { upsert: true });
    }
    if (req.body.revoke) { google.refreshTokens.clear(); google.accessTokens.clear(); dataLayer.services.googleDrive.cached = null; }
    res.json({ ok: true });
  });
  outer.post("/__test/monday", express.json(), async (req, res) => {
    if (!monday) return res.status(404).json({ error: "monday mock not enabled" });
    const { encrypt } = require("../../src/integrations/monday/secrets");
    if (req.body.connect) await connection.db.collection("integrations").updateOne({ _id: "monday" }, { $set: { token: encrypt(monday.ACCESS_TOKEN, mondayConfig.tokenKey), status: "connected", accountName: "Mock Account", accountUser: "Test Admin", connectedAt: new Date(), syncEnabled: false, paused: false, webhookSecret: "test-webhook-secret-0123456789" } }, { upsert: true });
    let ran = 0;
    if (req.body.run) { const { IntegrationWorker } = require("../../src/integrations/monday/worker"); ran = (await new IntegrationWorker({ integration: dataLayer.services.integration, repos: dataLayer.repos, logger: { error() {} } }).tick({ max: 20 })).ran; }
    res.json({ ok: true, ran, outside: mock.outside });
  });
  outer.use("/api/v1", (req, res, next) => {
    if (!PUBLIC.has(`${req.method} ${req.path}`)) {
      sim.protected += 1;
      if (/__Host-jarc_session=/.test(req.get("cookie") || "")) sim.withSession += 1; else sim.withoutSession.push(`${req.method} ${req.path}`);
    }
    next();
  });
  outer.use((req, res, next) => app(req, res, next));
  outer.listen(port, "127.0.0.1", () => console.log(`entra test server on http://localhost:${port}/`));
})();
