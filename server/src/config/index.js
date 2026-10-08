// Runtime configuration from environment variables.
//
// DATA_STORE selects where the API keeps data:
//   memory  (default) Stage 9 behaviour: only the transitional /api/v1/state endpoints, in server memory.
//   mongodb           Stage 10: MongoDB through the official driver. Needs MONGODB_URI and MONGODB_DB_NAME.
//
// The MongoDB connection string is a secret. It is never logged, never returned by the API, and is kept out of
// JSON.stringify and console output of the config object (non-enumerable property).
const ENVIRONMENTS = ["development", "test", "production"];
const DATA_STORES = ["memory", "mongodb"];

// The Atlas cluster is shared with another JARC application that has its own database on the same cluster.
// JARC Database only ever uses this database; any other name stops startup.
const JARC_DB_NAME = "jarc_database";

class ConfigError extends Error {
  constructor(message) { super(message); this.name = "ConfigError"; }
}

function loadConfig(env = process.env) {
  const nodeEnv = ENVIRONMENTS.includes(env.NODE_ENV) ? env.NODE_ENV : "development";
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("PORT must be a whole number between 0 and 65535.");

  const dataStore = env.DATA_STORE ? env.DATA_STORE : "memory";
  if (!DATA_STORES.includes(dataStore)) throw new ConfigError(`DATA_STORE must be one of: ${DATA_STORES.join(", ")}.`);

  // Checked whenever it is set, in every mode, so a wrong database name can never reach the driver.
  if (env.MONGODB_DB_NAME !== undefined && env.MONGODB_DB_NAME !== "") assertJarcDatabaseName(env.MONGODB_DB_NAME);

  let mongo = null;
  if (dataStore === "mongodb") {
    const missing = ["MONGODB_URI", "MONGODB_DB_NAME"].filter((name) => !env[name]);
    if (missing.length) throw new ConfigError(`DATA_STORE=mongodb needs ${missing.join(" and ")} in the backend environment (never in site/ or Git).`);
    assertMongoUri(env.MONGODB_URI);
    mongo = Object.freeze(Object.defineProperty({ dbName: env.MONGODB_DB_NAME }, "uri", { value: env.MONGODB_URI, enumerable: false }));
  }

  const preAuth = nodeEnv !== "production";
  return Object.freeze({
    nodeEnv,
    port,
    host: env.HOST || "127.0.0.1",
    dataStore,
    mongo,
    // GET/PUT /api/v1/state is a transitional development endpoint with no authentication. Never in production.
    enableDevStateApi: preAuth,
    // The Stage 10 resource API (/workspaces, /boards, /records, /imports) has no authentication yet
    // (DEVELOPMENT / PRE-AUTH). It is only served outside production, and only with MongoDB.
    enableDevResourceApi: preAuth && dataStore === "mongodb"
  });
}

function assertJarcDatabaseName(name) {
  if (name !== JARC_DB_NAME) {
    throw new ConfigError(`MONGODB_DB_NAME must be exactly "${JARC_DB_NAME}". JARC Database shares its Atlas cluster with other applications and never uses another database.`);
  }
}

// Accepts only MongoDB connection strings whose path names no database, or the JARC database. A database in the
// URI path also becomes the default authentication database, so another application's database there is refused.
// Error messages never include the connection string.
function assertMongoUri(uri) {
  const match = /^mongodb(\+srv)?:\/\/([^/?#]+)(\/[^?#]*)?/.exec(uri);
  if (!match) throw new ConfigError("MONGODB_URI must be a mongodb:// or mongodb+srv:// connection string.");
  let pathDb;
  try { pathDb = decodeURIComponent((match[3] || "/").slice(1)); } catch { throw new ConfigError("MONGODB_URI is not a valid connection string."); }
  if (pathDb && pathDb !== JARC_DB_NAME) throw new ConfigError(`MONGODB_URI names a different database in its path. Remove it (or use "${JARC_DB_NAME}"); the database always comes from MONGODB_DB_NAME.`);
}

module.exports = { loadConfig, assertJarcDatabaseName, ConfigError, JARC_DB_NAME };
