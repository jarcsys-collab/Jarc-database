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
  const { authMode, entra } = loadAuthConfig(env, nodeEnv, dataStore);
  const { accessPolicy, accessPolicyIgnored } = loadAccessPolicy(env);
  return Object.freeze({
    nodeEnv,
    port,
    host: env.HOST || "127.0.0.1",
    dataStore,
    mongo,
    authMode,
    entra,
    accessPolicy,
    // An ACCESS_POLICY value that wasn't recognised (role_based is used instead); reported at startup.
    accessPolicyIgnored,
    // GET/PUT /api/v1/state is a transitional development endpoint with no authentication. Never in production.
    enableDevStateApi: preAuth,
    // AUTH_MODE=dev: the resource API attributes every change to the fixed development user (DEVELOPMENT / PRE-AUTH).
    // Only outside production, and only with MongoDB.
    enableDevResourceApi: preAuth && dataStore === "mongodb" && authMode === "dev"
  });
}

// AUTH_MODE selects how the resource API knows who is calling:
//   dev   (default outside production) the fixed development user; refused in production.
//   entra Microsoft Entra ID sign-in with a server-managed session (HttpOnly cookie). REQUIRED in production.
//
// Entra mode uses ONE app registration — the existing single-page application (SPA) — and no client secret: the
// browser signs in with authorization code + PKCE (scopes openid, profile, email), and the server verifies the
// resulting ID token (signature, issuer, audience = the SPA, tenant, freshness and a server-issued single-use nonce)
// once, then issues its own session cookie. The ENTRA_* values are public identifiers, not secrets.
const AUTH_MODES = ["dev", "entra"];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRA_REQUIRED = ["ENTRA_TENANT_ID", "ENTRA_SPA_CLIENT_ID", "ENTRA_REDIRECT_URI"];

function wholeNumberSetting(env, name, fallback, min, max) {
  if (env[name] === undefined || env[name] === "") return fallback;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new ConfigError(`${name} must be a whole number from ${min} to ${max}.`);
  return value;
}

function loadAuthConfig(env, nodeEnv, dataStore) {
  const production = nodeEnv === "production";
  if (production && env.AUTH_MODE !== "entra") throw new ConfigError("Production requires AUTH_MODE=entra. The server will not start without Microsoft Entra ID authentication.");
  const authMode = env.AUTH_MODE ? env.AUTH_MODE : "dev";
  if (!AUTH_MODES.includes(authMode)) throw new ConfigError(`AUTH_MODE must be one of: ${AUTH_MODES.join(", ")}.`);
  if (authMode === "dev") return { authMode, entra: null };

  const missing = ENTRA_REQUIRED.filter((name) => !env[name]);
  if (missing.length) throw new ConfigError(`AUTH_MODE=entra needs ${missing.join(", ")}.`);
  if (dataStore !== "mongodb") throw new ConfigError("AUTH_MODE=entra needs DATA_STORE=mongodb: sign-in sessions are kept in the jarc_database database.");
  for (const name of ["ENTRA_TENANT_ID", "ENTRA_SPA_CLIENT_ID"]) if (!GUID.test(env[name])) throw new ConfigError(`${name} must be a GUID (the ID shown in the Entra app registration).`);
  let redirect;
  try { redirect = new URL(env.ENTRA_REDIRECT_URI); } catch { throw new ConfigError("ENTRA_REDIRECT_URI must be a full URL such as http://localhost:3000/."); }
  const local = redirect.hostname === "localhost";
  if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && local)) throw new ConfigError("ENTRA_REDIRECT_URI must use https (plain http is only allowed for localhost).");
  if (production && local) throw new ConfigError("ENTRA_REDIRECT_URI can't be a localhost address in production.");
  const adminRole = env.ENTRA_ADMIN_ROLE || "JARC.Admin";
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(adminRole)) throw new ConfigError("ENTRA_ADMIN_ROLE must be an app role value such as JARC.Admin.");
  return {
    authMode,
    entra: Object.freeze({
      tenantId: env.ENTRA_TENANT_ID.toLowerCase(), clientId: env.ENTRA_SPA_CLIENT_ID.toLowerCase(), redirectUri: redirect.href,
      // Requests that change data must come from this origin (checked with the CSRF token).
      appOrigin: redirect.origin, adminRole,
      sessionIdleMinutes: wholeNumberSetting(env, "SESSION_IDLE_MINUTES", 30, 5, 480),
      sessionMaxHours: wholeNumberSetting(env, "SESSION_MAX_HOURS", 8, 1, 24)
    })
  };
}

// ACCESS_POLICY selects how workspace permissions are decided (auth/access.js):
//   role_based          (default) workspace memberships and the JARC.Admin app role. Use this in production.
//   development_shared  DEVELOPMENT COLLABORATION: every signed-in employee of the configured Entra tenant can create
//                       workspaces and manage every workspace and its boards, columns and records. Sign-in, sessions,
//                       CSRF and tenant checks are unchanged.
// Only the exact value development_shared turns sharing on; unset, empty or anything else is role_based (fails safe).
const ACCESS_POLICIES = ["role_based", "development_shared"];

function loadAccessPolicy(env) {
  const value = env.ACCESS_POLICY;
  if (value === "development_shared") return { accessPolicy: "development_shared", accessPolicyIgnored: false };
  return { accessPolicy: "role_based", accessPolicyIgnored: value !== undefined && value !== "" && value !== "role_based" };
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

module.exports = { loadConfig, assertJarcDatabaseName, ConfigError, JARC_DB_NAME, ACCESS_POLICIES };
