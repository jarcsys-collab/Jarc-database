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

  // Files columns: the most all attachments together may use in the database (MB). Optional; default 300 MB, which
  // keeps a free 512 MB Atlas cluster from being filled by uploads.
  let maxFileStorageMb = 300;
  if (env.ATTACHMENTS_MAX_TOTAL_MB !== undefined && env.ATTACHMENTS_MAX_TOTAL_MB !== "") {
    if (!/^\d{1,7}$/.test(env.ATTACHMENTS_MAX_TOTAL_MB) || Number(env.ATTACHMENTS_MAX_TOTAL_MB) < 1) throw new ConfigError("ATTACHMENTS_MAX_TOTAL_MB must be a whole number of megabytes (1 or more).");
    maxFileStorageMb = Number(env.ATTACHMENTS_MAX_TOTAL_MB);
  }
  const preAuth = nodeEnv !== "production";
  const { authMode, entra } = loadAuthConfig(env, nodeEnv, dataStore);
  const { accessPolicy, accessPolicyIgnored } = loadAccessPolicy(env);
  const accounts = loadAccountConfig(env, nodeEnv, authMode, entra);
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
    // Account Management (Phase M4.3, see auth/accounts.js): { mode, superAdmin }.
    accounts,
    maxFileStorageBytes: maxFileStorageMb * 1024 * 1024,
    attachments: loadAttachmentConfig(env, nodeEnv),
    monday: loadMondayConfig(env),
    // Google Drive attachment storage: off unless GOOGLE_DRIVE_ENABLED=true (integrations/google-drive/service.js).
    googleDrive: loadGoogleDriveConfig(env, nodeEnv, authMode),
    // Machine Installation Database attachment import: a temporary, off-by-default server-side migration run.
    midAttachments: loadMidAttachmentsConfig(env),
    // Search index (services/record-search-index.js): off, shadow or on. Unset: off, which writes nothing.
    recordSearch: loadRecordSearchMode(env),
    // Optional features, each with its own switch: { nativeForms, spreadsheetImports }. Off in production unless turned on.
    features: loadFeatureSwitches(env, nodeEnv),
    // API tokens for other systems: { enabled, perMinute } and a key kept out of logs and inspection.
    apiTokens: loadApiTokenConfig(env, authMode),
    // Requests slower than this are logged by route pattern (middleware/slow-requests.js). 0 turns it off.
    slowRequestMs: loadSlowRequestMs(env),
    // MongoDB commands at least this slow are listed on the System Health page (monitoring/monitor.js). Unset: 500.
    slowCommandMs: loadSlowCommandMs(env),
    // TEMPORARY beta collaboration (see auth/access.js). Only the exact value "true" turns it on.
    betaOpenEditing: env.JARC_BETA_OPEN_EDITING === "true",
    // GET/PUT /api/v1/state is a transitional development endpoint with no authentication. Never in production.
    enableDevStateApi: preAuth,
    // AUTH_MODE=dev: the resource API attributes every change to the fixed development user (DEVELOPMENT / PRE-AUTH).
    // Only outside production, and only with MongoDB.
    enableDevResourceApi: preAuth && dataStore === "mongodb" && authMode === "dev"
  });
}

function loadSlowRequestMs(env) {
  if (env.SLOW_REQUEST_MS === undefined || env.SLOW_REQUEST_MS === "") return 2000;
  if (!/^\d{1,6}$/.test(env.SLOW_REQUEST_MS)) throw new ConfigError("SLOW_REQUEST_MS must be a whole number of milliseconds (0 turns it off).");
  return Number(env.SLOW_REQUEST_MS);
}

function loadSlowCommandMs(env) {
  if (env.MONGO_SLOW_COMMAND_MS === undefined || env.MONGO_SLOW_COMMAND_MS === "") return 500;
  if (!/^\d{1,6}$/.test(env.MONGO_SLOW_COMMAND_MS) || Number(env.MONGO_SLOW_COMMAND_MS) < 1) throw new ConfigError("MONGO_SLOW_COMMAND_MS must be a whole number of milliseconds, at least 1.");
  return Number(env.MONGO_SLOW_COMMAND_MS);
}

// JARC_FEATURE_FORMS, JARC_FEATURE_IMPORTS: true or false; anything else stops startup rather than being guessed. Unset means off
// in production and on elsewhere. While off, the feature's API paths don't exist (app.js), its screens are hidden, the import
// worker doesn't run and its database collections aren't created. Stored forms and imports are kept and return when it's on again.
const FEATURE_SWITCHES = Object.freeze({ nativeForms: "JARC_FEATURE_FORMS", spreadsheetImports: "JARC_FEATURE_IMPORTS" });
function loadFeatureSwitches(env, nodeEnv) {
  const out = {};
  for (const [feature, name] of Object.entries(FEATURE_SWITCHES)) {
    const value = env[name];
    if (value !== undefined && value !== "" && value !== "true" && value !== "false") throw new ConfigError(`${name} must be true or false.`);
    out[feature] = value === undefined || value === "" ? nodeEnv !== "production" : value === "true";
  }
  return Object.freeze(out);
}

// API tokens (auth/api-token.js, routes/external-api.js). Off in every environment unless JARC_FEATURE_API_TOKENS=true, because they
// need a secret of their own. While off, their API paths don't exist, the Settings section is hidden and nothing is added to the database.
//   JARC_API_TOKEN_KEY         required when on: 32 random bytes, base64-encoded (openssl rand -base64 32). Tokens are stored as digests
//                              keyed with it, so replacing it ends every existing token.
//   JARC_API_TOKEN_RATE_PER_MINUTE  optional: requests per minute for each token (default 120).
function loadApiTokenConfig(env, authMode) {
  const value = env.JARC_FEATURE_API_TOKENS;
  if (value !== undefined && value !== "" && value !== "true" && value !== "false") throw new ConfigError("JARC_FEATURE_API_TOKENS must be true or false.");
  const enabled = value === "true";
  let key = null;
  if (env.JARC_API_TOKEN_KEY) { key = Buffer.from(env.JARC_API_TOKEN_KEY, "base64"); if (key.length !== 32) throw new ConfigError("JARC_API_TOKEN_KEY must be 32 random bytes, base64-encoded (for example: openssl rand -base64 32)."); }
  if (enabled && authMode !== "entra") throw new ConfigError("JARC_FEATURE_API_TOKENS=true needs AUTH_MODE=entra.");
  if (enabled && !key) throw new ConfigError("JARC_FEATURE_API_TOKENS=true needs JARC_API_TOKEN_KEY.");
  const config = { enabled, perMinute: wholeNumberSetting(env, "JARC_API_TOKEN_RATE_PER_MINUTE", 120, 10, 6000) };
  Object.defineProperty(config, "key", { value: key, enumerable: false });
  return Object.freeze(config);
}

function loadRecordSearchMode(env) {
  const mode = env.RECORD_SEARCH_INDEX === undefined || env.RECORD_SEARCH_INDEX === "" ? "off" : env.RECORD_SEARCH_INDEX;
  if (!["off", "shadow", "on"].includes(mode)) throw new ConfigError("RECORD_SEARCH_INDEX must be off, shadow or on.");
  return mode;
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

// Attachment storage (Phase M4.1).
//   ATTACHMENTS_STORE                gridfs (default; unchanged behaviour) | s3 | gdrive — where NEW uploads go. Existing
//                                    files are always read from where they are (GridFS files stay in GridFS). gdrive also
//                                    needs GOOGLE_DRIVE_ENABLED=true (see loadGoogleDriveConfig).
//   ATTACHMENTS_S3_ENDPOINT / _REGION / _BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY / _FORCE_PATH_STYLE
//                                    a private S3-compatible bucket (Railway Buckets: map its variables onto these).
//                                    All or none: a partial set stops startup. HTTPS required except a loopback
//                                    endpoint outside production (local tests).
//   ATTACHMENTS_S3_MAX_TOTAL_MB      required with S3: the most the bucket may hold (separate from the GridFS cap).
//   ATTACHMENTS_MIGRATION_MAX_FILE_MB the per-file limit of the monday.com migration path only (default 20, at most
//                                    100). Uploads through the app stay at 10 MB.
const S3_VARS = ["ATTACHMENTS_S3_ENDPOINT", "ATTACHMENTS_S3_BUCKET", "ATTACHMENTS_S3_ACCESS_KEY_ID", "ATTACHMENTS_S3_SECRET_ACCESS_KEY", "ATTACHMENTS_S3_MAX_TOTAL_MB"];
function loadAttachmentConfig(env, nodeEnv) {
  const defaultProvider = env.ATTACHMENTS_STORE ? env.ATTACHMENTS_STORE : "gridfs";
  if (!["gridfs", "s3", "gdrive"].includes(defaultProvider)) throw new ConfigError('ATTACHMENTS_STORE must be "gridfs", "s3" or "gdrive".');
  if (defaultProvider === "gdrive" && env.GOOGLE_DRIVE_ENABLED !== "true") throw new ConfigError("ATTACHMENTS_STORE=gdrive needs GOOGLE_DRIVE_ENABLED=true.");
  const set = S3_VARS.filter((name) => env[name] !== undefined && env[name] !== "");
  let s3 = null;
  if (set.length && set.length !== S3_VARS.length) throw new ConfigError(`Object storage is partly configured; also set ${S3_VARS.filter((n) => !set.includes(n)).join(", ")} (or remove the others).`);
  if (set.length) {
    let endpoint;
    try { endpoint = new URL(env.ATTACHMENTS_S3_ENDPOINT); } catch { throw new ConfigError("ATTACHMENTS_S3_ENDPOINT must be a full URL."); }
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback && nodeEnv !== "production")) throw new ConfigError("ATTACHMENTS_S3_ENDPOINT must use https://.");
    if (endpoint.username || endpoint.password || endpoint.search) throw new ConfigError("ATTACHMENTS_S3_ENDPOINT must not contain credentials or a query.");
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.ATTACHMENTS_S3_BUCKET)) throw new ConfigError("ATTACHMENTS_S3_BUCKET is not a valid bucket name.");
    if (!/^\d{1,8}$/.test(env.ATTACHMENTS_S3_MAX_TOTAL_MB) || Number(env.ATTACHMENTS_S3_MAX_TOTAL_MB) < 1) throw new ConfigError("ATTACHMENTS_S3_MAX_TOTAL_MB must be a whole number of megabytes (1 or more).");
    if (env.ATTACHMENTS_S3_FORCE_PATH_STYLE !== undefined && !["true", "false"].includes(env.ATTACHMENTS_S3_FORCE_PATH_STYLE)) throw new ConfigError("ATTACHMENTS_S3_FORCE_PATH_STYLE must be true or false.");
    s3 = { endpoint: endpoint.href.replace(/\/$/, ""), region: env.ATTACHMENTS_S3_REGION || "auto", bucket: env.ATTACHMENTS_S3_BUCKET, forcePathStyle: env.ATTACHMENTS_S3_FORCE_PATH_STYLE === "true", accessKeyId: env.ATTACHMENTS_S3_ACCESS_KEY_ID, maxTotalBytes: Number(env.ATTACHMENTS_S3_MAX_TOTAL_MB) * 1024 * 1024 };
    Object.defineProperty(s3, "secretAccessKey", { value: env.ATTACHMENTS_S3_SECRET_ACCESS_KEY, enumerable: false }); // kept out of logs and inspection
    Object.freeze(s3);
  }
  if (defaultProvider === "s3" && !s3) throw new ConfigError(`ATTACHMENTS_STORE=s3 needs ${S3_VARS.join(", ")}.`);
  let migrationMaxFileMb = 20;
  if (env.ATTACHMENTS_MIGRATION_MAX_FILE_MB !== undefined && env.ATTACHMENTS_MIGRATION_MAX_FILE_MB !== "") {
    if (!/^\d{1,3}$/.test(env.ATTACHMENTS_MIGRATION_MAX_FILE_MB) || Number(env.ATTACHMENTS_MIGRATION_MAX_FILE_MB) < 10 || Number(env.ATTACHMENTS_MIGRATION_MAX_FILE_MB) > 100) throw new ConfigError("ATTACHMENTS_MIGRATION_MAX_FILE_MB must be between 10 and 100.");
    migrationMaxFileMb = Number(env.ATTACHMENTS_MIGRATION_MAX_FILE_MB);
  }
  return Object.freeze({ defaultProvider, s3, migrationMaxFileBytes: migrationMaxFileMb * 1024 * 1024 });
}

// Google Drive attachment storage. Two separate switches, so that it can be connected and checked before any file goes there:
//   GOOGLE_DRIVE_ENABLED              true: its routes exist and an administrator can connect it. Anything but true/false stops
//                                     startup; unset or false means off, and the variables below aren't even looked at.
//   ATTACHMENTS_STORE=gdrive          new uploads go to Drive (see loadAttachmentConfig).
// Required when on (a missing or wrong value stops startup; secrets are non-enumerable, never in JSON or logs):
//   GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET   the OAuth web client
//   GOOGLE_DRIVE_REDIRECT_URI         the callback's full URL, also entered in Google Cloud Console
//   GOOGLE_DRIVE_TOKEN_KEY            32 random bytes, base64-encoded: encrypts the refresh token
//   GOOGLE_DRIVE_ACCOUNT_EMAIL        the only Google account allowed to connect
//   ATTACHMENTS_GDRIVE_MAX_TOTAL_MB   the most JARC may store there
// Optional when on:
//   GOOGLE_DRIVE_ADMIN_OIDS           who may connect, reconnect, test and disconnect the company Drive: Microsoft Entra object
//                                     IDs (GUIDs) of ENTRA_TENANT_ID, separated by commas or spaces, at most 20. Unset or empty:
//                                     nobody (fails closed). A malformed entry stops startup. Employees always see the status.
const GOOGLE_DRIVE_CALLBACK_PATH = "/api/v1/integrations/google-drive/callback";
const MAX_DRIVE_ADMINS = 20;
function loadGoogleDriveConfig(env, nodeEnv, authMode) {
  const value = env.GOOGLE_DRIVE_ENABLED;
  if (value !== undefined && value !== "" && value !== "true" && value !== "false") throw new ConfigError("GOOGLE_DRIVE_ENABLED must be true or false.");
  const hide = (config, clientSecret, tokenKey) => { Object.defineProperties(config, { clientSecret: { value: clientSecret, enumerable: false }, tokenKey: { value: tokenKey, enumerable: false } }); return Object.freeze(config); };
  if (value !== "true") return hide({ enabled: false, clientId: null, redirectUri: null, accountEmail: null, maxTotalBytes: null }, null, null);
  if (authMode !== "entra") throw new ConfigError("GOOGLE_DRIVE_ENABLED=true needs AUTH_MODE=entra.");
  const missing = ["GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET", "GOOGLE_DRIVE_REDIRECT_URI", "GOOGLE_DRIVE_TOKEN_KEY", "GOOGLE_DRIVE_ACCOUNT_EMAIL", "ATTACHMENTS_GDRIVE_MAX_TOTAL_MB"].filter((name) => !env[name]);
  if (missing.length) throw new ConfigError(`GOOGLE_DRIVE_ENABLED=true needs ${missing.join(", ")}.`);
  const tokenKey = Buffer.from(env.GOOGLE_DRIVE_TOKEN_KEY, "base64");
  if (tokenKey.length !== 32) throw new ConfigError("GOOGLE_DRIVE_TOKEN_KEY must be 32 random bytes, base64-encoded (for example: openssl rand -base64 32).");
  let redirect;
  try { redirect = new URL(env.GOOGLE_DRIVE_REDIRECT_URI); } catch { throw new ConfigError("GOOGLE_DRIVE_REDIRECT_URI must be a full URL."); }
  const local = redirect.protocol === "http:" && redirect.hostname === "localhost" && nodeEnv !== "production";
  if (redirect.protocol !== "https:" && !local) throw new ConfigError("GOOGLE_DRIVE_REDIRECT_URI must use https.");
  if (redirect.pathname !== GOOGLE_DRIVE_CALLBACK_PATH || redirect.search || redirect.hash || redirect.username || redirect.password) throw new ConfigError(`GOOGLE_DRIVE_REDIRECT_URI must end in ${GOOGLE_DRIVE_CALLBACK_PATH}, with nothing after it.`);
  const email = env.GOOGLE_DRIVE_ACCOUNT_EMAIL.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new ConfigError("GOOGLE_DRIVE_ACCOUNT_EMAIL must be an email address.");
  if (!/^\d{1,8}$/.test(env.ATTACHMENTS_GDRIVE_MAX_TOTAL_MB) || Number(env.ATTACHMENTS_GDRIVE_MAX_TOTAL_MB) < 1) throw new ConfigError("ATTACHMENTS_GDRIVE_MAX_TOTAL_MB must be a whole number of megabytes (1 or more).");
  const admins = String(env.GOOGLE_DRIVE_ADMIN_OIDS || "").split(/[\s,;]+/).filter(Boolean).map((id) => id.toLowerCase());
  if (admins.some((id) => !GUID.test(id))) throw new ConfigError("GOOGLE_DRIVE_ADMIN_OIDS must list Microsoft Entra object IDs (GUIDs), separated by commas.");
  const adminObjectIds = Object.freeze([...new Set(admins)]);
  if (adminObjectIds.length > MAX_DRIVE_ADMINS) throw new ConfigError(`GOOGLE_DRIVE_ADMIN_OIDS can list at most ${MAX_DRIVE_ADMINS} people.`);
  return hide({ enabled: true, clientId: env.GOOGLE_DRIVE_CLIENT_ID, redirectUri: redirect.href, accountEmail: email, maxTotalBytes: Number(env.ATTACHMENTS_GDRIVE_MAX_TOTAL_MB) * 1024 * 1024, adminObjectIds }, env.GOOGLE_DRIVE_CLIENT_SECRET, tokenKey);
}

// Machine Installation Database attachment import (services/mid-attachment-run.js). TEMPORARY: set for the import,
// remove afterwards. While off, its routes don't exist and its worker doesn't run.
//   MID_ATTACHMENTS_MIGRATION   true or false (anything else stops startup). true also needs GOOGLE_DRIVE_ENABLED=true.
//   MID_MIGRATION_MONDAY_TOKEN  required when on: a monday.com API token that can read the board's files. A secret:
//                               non-enumerable, never in JSON, logs or responses.
//   MID_MIGRATION_CONCURRENCY   optional: files processed at once, 1-3 (default 2).
// MONDAY_API_VERSION (optional) pins the monday.com API version, as for the integration.
function loadMidAttachmentsConfig(env) {
  const value = env.MID_ATTACHMENTS_MIGRATION;
  if (value !== undefined && value !== "" && value !== "true" && value !== "false") throw new ConfigError("MID_ATTACHMENTS_MIGRATION must be true or false.");
  const config = { enabled: value === "true", concurrency: 2, apiVersion: env.MONDAY_API_VERSION || null };
  if (config.enabled) {
    if (env.GOOGLE_DRIVE_ENABLED !== "true") throw new ConfigError("MID_ATTACHMENTS_MIGRATION=true needs GOOGLE_DRIVE_ENABLED=true.");
    if (!env.MID_MIGRATION_MONDAY_TOKEN) throw new ConfigError("MID_ATTACHMENTS_MIGRATION=true needs MID_MIGRATION_MONDAY_TOKEN.");
    config.concurrency = wholeNumberSetting(env, "MID_MIGRATION_CONCURRENCY", 2, 1, 3);
  }
  Object.defineProperty(config, "mondayToken", { value: config.enabled ? env.MID_MIGRATION_MONDAY_TOKEN : null, enumerable: false });
  return Object.freeze(config);
}

// monday.com integration (one-way into JARC). Off unless MONDAY_INTEGRATION_ENABLED=true; usable only when the OAuth
// app credentials, redirect URI and token-encryption key are all set. Secrets are non-enumerable (never in JSON or logs).
function loadMondayConfig(env) {
  const httpsUrl = (value, name) => { let url; try { url = new URL(value); } catch { throw new ConfigError(`${name} must be a full URL.`); } if (url.protocol !== "https:" && url.hostname !== "localhost") throw new ConfigError(`${name} must use https.`); return url.toString(); };
  let tokenKey = null;
  if (env.MONDAY_TOKEN_KEY) { tokenKey = Buffer.from(env.MONDAY_TOKEN_KEY, "base64"); if (tokenKey.length !== 32) throw new ConfigError("MONDAY_TOKEN_KEY must be 32 random bytes, base64-encoded (for example: openssl rand -base64 32)."); }
  const redirectUri = env.MONDAY_REDIRECT_URI ? httpsUrl(env.MONDAY_REDIRECT_URI, "MONDAY_REDIRECT_URI") : null;
  if (env.MONDAY_API_VERSION && !/^\d{4}-\d{2}$/.test(env.MONDAY_API_VERSION)) throw new ConfigError("MONDAY_API_VERSION must look like 2026-07.");
  const required = { MONDAY_CLIENT_ID: env.MONDAY_CLIENT_ID, MONDAY_CLIENT_SECRET: env.MONDAY_CLIENT_SECRET, MONDAY_REDIRECT_URI: redirectUri, MONDAY_TOKEN_KEY: tokenKey };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  const config = {
    enabled: env.MONDAY_INTEGRATION_ENABLED === "true", configured: missing.length === 0, missing,
    clientId: env.MONDAY_CLIENT_ID || null, redirectUri, apiVersion: env.MONDAY_API_VERSION || null,
    scopes: env.MONDAY_SCOPES || "me:read boards:read workspaces:read",
    // monday.com's documented OAuth flow (tokens don't expire). Its newer OAuth 2.1 flow (expiring tokens, refresh, PKCE)
    // is not supported yet.
    oauth: { authorizeUrl: "https://auth.monday.com/oauth2/authorize", tokenUrl: "https://auth.monday.com/oauth2/token" }
  };
  Object.defineProperties(config, { clientSecret: { value: env.MONDAY_CLIENT_SECRET || null, enumerable: false }, signingSecret: { value: env.MONDAY_SIGNING_SECRET || null, enumerable: false }, tokenKey: { value: tokenKey, enumerable: false } });
  return Object.freeze(config);
}

// Account Management (Phase M4.3; auth/accounts.js).
//   ACCOUNT_MANAGEMENT          off (default) | staged | enforced. Any other value stops startup (never guessed).
//                               staged and enforced need AUTH_MODE=entra. Production (Phase M4.4A): off or staged only;
//                               enforced needs a separate approval, so it stops startup there (never silently ignored).
//   JARC_SUPER_ADMIN_TENANT_ID  the intended first Super Admin: Microsoft tenant ID (must be ENTRA_TENANT_ID) …
//   JARC_SUPER_ADMIN_OBJECT_ID  … and immutable Entra object ID. Both or neither.
//   JARC_SUPER_ADMIN_EMAIL      optional cross-check of the stored JARC user's email (never the identity itself).
// These are identifiers, not secrets. Being configured grants nothing: the person must still sign in with these exact
// verified claims AND the JARC.Admin app role, and claim the role explicitly (POST /api/v1/accounts/bootstrap).
function loadAccountConfig(env, nodeEnv, authMode, entra) {
  const mode = env.ACCOUNT_MANAGEMENT ? env.ACCOUNT_MANAGEMENT : "off";
  if (!["off", "staged", "enforced"].includes(mode)) throw new ConfigError("ACCOUNT_MANAGEMENT must be off, staged or enforced.");
  if (mode === "enforced" && nodeEnv === "production") throw new ConfigError("ACCOUNT_MANAGEMENT=enforced is not approved for production yet. Use staged (observation mode) or leave it unset.");
  if (mode !== "off" && authMode !== "entra") throw new ConfigError(`ACCOUNT_MANAGEMENT=${mode} needs AUTH_MODE=entra (accounts are Microsoft Entra identities).`);
  const tenantId = env.JARC_SUPER_ADMIN_TENANT_ID || "", objectId = env.JARC_SUPER_ADMIN_OBJECT_ID || "";
  let superAdmin = null;
  if (tenantId || objectId) {
    if (!tenantId || !objectId) throw new ConfigError("Set both JARC_SUPER_ADMIN_TENANT_ID and JARC_SUPER_ADMIN_OBJECT_ID, or neither.");
    for (const [name, value] of [["JARC_SUPER_ADMIN_TENANT_ID", tenantId], ["JARC_SUPER_ADMIN_OBJECT_ID", objectId]]) if (!GUID.test(value)) throw new ConfigError(`${name} must be a GUID.`);
    if (entra && tenantId.toLowerCase() !== entra.tenantId) throw new ConfigError("JARC_SUPER_ADMIN_TENANT_ID must be the same tenant as ENTRA_TENANT_ID (no cross-tenant administrators).");
    const email = env.JARC_SUPER_ADMIN_EMAIL || null;
    if (email && (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email))) throw new ConfigError("JARC_SUPER_ADMIN_EMAIL must be an email address.");
    superAdmin = Object.freeze({ tenantId: tenantId.toLowerCase(), objectId: objectId.toLowerCase(), email: email ? email.toLowerCase() : null });
  }
  return Object.freeze({ mode, superAdmin });
}

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

module.exports = { FEATURE_SWITCHES, loadConfig, loadAccountConfig, loadMondayConfig, loadGoogleDriveConfig, loadMidAttachmentsConfig, loadAttachmentConfig, assertJarcDatabaseName, ConfigError, JARC_DB_NAME, ACCESS_POLICIES };
