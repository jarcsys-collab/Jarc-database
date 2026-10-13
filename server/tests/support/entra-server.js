// TEST-ONLY server for browser tests of Microsoft Entra sign-in: the real app with AUTH_MODE=entra (ID tokens verified
// against a LOCAL test key, server sessions) on the fake MongoDB. Never imported by src/ and never started by npm start.
//
//   node tests/support/entra-server.js <port> [shared]   (sign-in redirect URI: http://localhost:<port>/)
//   GET  /__test/id-token?oid=&name=&email=&admin=0|1&nonce=   → a test ID token (what Microsoft would issue)
//   POST /__test/config { expireSessions, disableEmail, enableEmail, legacyActivity } → end every session / disable or
//        enable a user / add an old-style activity entry without an actor (legacyActivity: workspace ID)
//   GET  /__test/stats  → protected API requests, and any that arrived without a session cookie
//   JARC_TEST_MONDAY=1: the monday.com integration is configured against the MOCK monday.com (tests/support/mock-monday)
//   POST /__test/monday { connect, run }  → store a (mock) connection directly / run due integration jobs once
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
  const dataLayer = createDataLayer({ connection, logger: { error() {} }, fileStore: new MemoryFileStore(), monday: mondayConfig, ...(mock ? { fetch: mock.fetch } : {}) });
  const verify = createEntraVerifier({ ...entra, keySet: issuer.keySet });
  // Optional 2nd argument "shared": ACCESS_POLICY=development_shared (as on Railway); default role_based.
  const accessPolicy = process.argv[3] === "shared" ? "development_shared" : "role_based";
  const app = createApp({ repository: new MemoryStateRepository(), environment: "test", dataLayer, auth: { mode: "entra", entra, verify }, accessPolicy, logger: { error() {} } });
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
