// Starts the JARC Database server: the API under /api/v1 and the frontend from site/, on one origin.
//
//   DATA_STORE=memory  (default) Stage 9 behaviour: transitional /api/v1/state in server memory.
//   DATA_STORE=mongodb Stage 10: connects to MongoDB (database jarc_database only), creates missing collections and
//                      indexes, and serves the resource API:
//                        AUTH_MODE=entra  Microsoft Entra ID sign-in → server session cookie (required in production)
//                        AUTH_MODE=dev    the fixed development user (development only; refused in production)
const { loadConfig } = require("./config");
const { createApp } = require("./app");
const { MemoryStateRepository } = require("./repositories/memory-state-repository");
const { MongoConnection, redact } = require("./db/connection");
const { ensureDatabase } = require("./db/bootstrap");
const { createDataLayer } = require("./data-layer");
const { ensureDevelopmentActor } = require("./context/dev-actor");
const { createEntraVerifier } = require("./auth/entra-token");

async function main() {
  const config = loadConfig();
  const repository = config.enableDevStateApi ? new MemoryStateRepository() : null;
  let connection = null, dataLayer = null, devActor = null;

  if (config.dataStore === "mongodb") {
    connection = new MongoConnection({ uri: config.mongo.uri, dbName: config.mongo.dbName });
    await connection.connect();
    const { createdCollections } = await ensureDatabase(connection.db);
    dataLayer = createDataLayer({ connection });
    if (config.enableDevResourceApi) devActor = await ensureDevelopmentActor(dataLayer.repos.users, { environment: config.nodeEnv });
    console.log(`MongoDB connected (database ${config.mongo.dbName}).${createdCollections.length ? ` Created collections: ${createdCollections.join(", ")}.` : ""}`);
  }

  // Entra mode: the sign-in ID token is checked once against this tenant's published signing keys, then a server
  // session cookie is used. No client secret is involved.
  const auth = config.authMode === "entra" ? { mode: "entra", entra: config.entra, verify: createEntraVerifier(config.entra) } : null;
  const app = createApp({ repository, environment: config.nodeEnv, enableDevStateApi: config.enableDevStateApi, dataLayer, devActor, auth, enableDevResourceApi: config.enableDevResourceApi, accessPolicy: config.accessPolicy });
  const server = app.listen(config.port, config.host, () => {
    const { port } = server.address();
    console.log(`JARC Database server (${config.nodeEnv}) on http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${port}/`);
    if (config.enableDevStateApi) console.log("Development state API enabled: data is kept in memory only and is cleared when the server restarts.");
    else console.log("Development state API disabled (production). Only health endpoints and the frontend are served.");
    if (config.enableDevResourceApi) console.log("Resource API enabled for DEVELOPMENT / PRE-AUTH use: no authentication; every change is attributed to the local development actor.");
    if (auth) console.log(`Microsoft Entra ID sign-in enabled: sessions last up to ${config.entra.sessionMaxHours} h (${config.entra.sessionIdleMinutes} min idle).`);
    if (config.accessPolicyIgnored) console.warn("ACCESS_POLICY has an unrecognised value; using role_based (workspace memberships and the JARC.Admin role).");
    if (config.accessPolicy === "development_shared") console.warn("ACCESS_POLICY=development_shared: every signed-in employee can create, edit and delete every workspace, board and record. Development collaboration only — set ACCESS_POLICY=role_based before production rollout.");
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close(async () => {
      await connection?.close().catch(() => {});
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  // Written without connection strings or credentials: driver text is redacted.
  const known = error.name === "ConfigError" || error.name === "DatabaseConnectionError";
  console.error(`JARC Database server did not start: ${known ? error.message : `${error.name || "Error"}${error.code ? ` ${error.code}` : ""}: ${redact(error.message || "")}`}`);
  process.exit(1);
});
