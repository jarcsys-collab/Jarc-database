// TEST-ONLY server for browser tests of Microsoft Entra sign-in: the real app with AUTH_MODE=entra (ID tokens verified
// against a LOCAL test key, server sessions) on the fake MongoDB. Never imported by src/ and never started by npm start.
//
//   node tests/support/entra-server.js <port>        (sign-in redirect URI: http://localhost:<port>/)
//   GET  /__test/id-token?oid=&name=&email=&admin=0|1&nonce=   → a test ID token (what Microsoft would issue)
//   POST /__test/config { expireSessions, disableEmail, enableEmail } → end every session / disable or enable a user
//   GET  /__test/stats  → protected API requests, and any that arrived without a session cookie
const express = require("express");
const { MongoConnection } = require("../../src/db/connection");
const { ensureDatabase } = require("../../src/db/bootstrap");
const { createDataLayer } = require("../../src/data-layer");
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
  const dataLayer = createDataLayer({ connection, logger: { error() {} } });
  const verify = createEntraVerifier({ ...entra, keySet: issuer.keySet });
  const app = createApp({ repository: new MemoryStateRepository(), environment: "test", dataLayer, auth: { mode: "entra", entra, verify }, logger: { error() {} } });
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
    res.json({ ok: true });
  });
  outer.get("/__test/stats", (req, res) => res.json(sim));
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
