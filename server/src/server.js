// Starts the JARC Database server: the API under /api/v1 and the frontend from site/, on one origin.
//
//   DATA_STORE=memory  (default) Stage 9 behaviour: transitional /api/v1/state in server memory.
//   DATA_STORE=mongodb Stage 10: connects to MongoDB (database jarc_database only), creates missing collections and
//                      indexes, and — outside production — serves the pre-auth resource API.
const { loadConfig } = require("./config");
const { createApp } = require("./app");
const { MemoryStateRepository } = require("./repositories/memory-state-repository");
const { MongoConnection, redact } = require("./db/connection");
const { ensureDatabase } = require("./db/bootstrap");
const { createDataLayer } = require("./data-layer");
const { ensureDevelopmentActor } = require("./context/dev-actor");

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

  const app = createApp({ repository, environment: config.nodeEnv, enableDevStateApi: config.enableDevStateApi, dataLayer, devActor, enableDevResourceApi: config.enableDevResourceApi });
  const server = app.listen(config.port, config.host, () => {
    const { port } = server.address();
    console.log(`JARC Database server (${config.nodeEnv}) on http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${port}/`);
    if (config.enableDevStateApi) console.log("Development state API enabled: data is kept in memory only and is cleared when the server restarts.");
    else console.log("Development state API disabled (production). Only health endpoints and the frontend are served.");
    if (config.enableDevResourceApi) console.log("Resource API enabled for DEVELOPMENT / PRE-AUTH use: no authentication; every change is attributed to the local development actor.");
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
