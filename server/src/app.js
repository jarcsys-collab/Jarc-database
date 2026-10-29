// Creates and configures the Express application without listening on a port (server.js does that), so tests can
// exercise it directly.
//
//   /api/v1/*  → JSON API (unknown paths → JSON 404, never index.html)
//   /*         → the existing static frontend in site/ (same origin, so no CORS)
const fs = require("fs");
const path = require("path");
const express = require("express");
const { healthRoutes } = require("./routes/health");
const { stateRoutes } = require("./routes/state");
const { resourceRoutes } = require("./routes/resources");
const { memberRoutes } = require("./routes/members");
const { authConfigRoutes, signInRoutes, sessionRoutes, meRoutes } = require("./routes/auth");
const { devActorMiddleware } = require("./context/dev-actor");
const { sessionAuthentication } = require("./auth/session");
const { Access } = require("./auth/access");
const { apiNotFound, errorHandler, sendError } = require("./middleware/errors");
const { ActivityStream } = require("./realtime/activity-stream");
const { eventRoutes, entraSessionCheck } = require("./routes/events");
const { fileRoutes } = require("./routes/files");
const { searchRoutes } = require("./routes/search");
const { integrationRoutes, integrationPublicRoutes } = require("./routes/integrations");
const { commentRoutes } = require("./routes/comments");
const { preferenceRoutes } = require("./routes/preferences");
const { accountRoutes } = require("./routes/accounts");
const { version } = require("../package.json");

// Larger than any state the frontend can produce today: browser storage caps at roughly 5 MB, and backup and CSV
// imports are limited to 10 MB. Bigger bodies get 413 PAYLOAD_TOO_LARGE.
const JSON_BODY_LIMIT = "10mb";
const DEFAULT_SITE_DIR = path.resolve(__dirname, "..", "..", "site");
// Microsoft sign-in library (MSAL Browser, pinned in package.json), served from this origin rather than a CDN.
const MSAL_BUNDLE = path.join(path.dirname(require.resolve("@azure/msal-browser/package.json")), "lib", "msal-browser.min.js");

// The page's default storage mode (site/index.html; see StorageService.createAdapter). With Microsoft sign-in configured
// the app opens in resource mode (MongoDB + Microsoft sign-in) without ?storage=resource; ?storage=local still works.
const STORAGE_DEFAULT_LOCAL = '<meta name="jarc-storage-default" content="local">';
const STORAGE_DEFAULT_RESOURCE = '<meta name="jarc-storage-default" content="resource">';
function resourceModeIndex(siteDir) {
  const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf8");
  if (!html.includes(STORAGE_DEFAULT_LOCAL)) throw new Error("site/index.html has no jarc-storage-default marker.");
  return html.replace(STORAGE_DEFAULT_LOCAL, STORAGE_DEFAULT_RESOURCE);
}

// dataLayer (optional): { connection, repos, services } from createDataLayer. Without it the server behaves exactly
// as in Stage 9. Who may use the resource API:
//   auth = { mode: "entra", entra, verify }   Microsoft Entra ID sign-in → server session cookie (required in production)
//   enableDevResourceApi + devActor            the fixed development user (development and test only)
// accessPolicy: "role_based" (default) or "development_shared" (see auth/access.js). betaOpenEditing: temporary
// beta collaboration (JARC_BETA_OPEN_EDITING), see auth/access.js. accounts: Account Management (Phase M4.3,
// auth/accounts.js) { mode: off | staged | enforced, superAdmin }; Entra sign-in only.
function createApp({ repository, environment = "development", enableDevStateApi = true, dataLayer = null, devActor = null, auth = null, enableDevResourceApi = Boolean(dataLayer) && !auth, accessPolicy = "role_based", betaOpenEditing = false, accounts = null, live = {}, searchLimiter = null, siteDir = DEFAULT_SITE_DIR, logger = console } = {}) {
  if (environment === "production" && (enableDevStateApi || enableDevResourceApi)) {
    throw new Error("Development (pre-auth) APIs can't be enabled in production.");
  }
  if (auth && (auth.mode !== "entra" || typeof auth.verify !== "function" || !auth.entra)) throw new Error("createApp auth must be Entra ID token validation.");
  if (auth && enableDevResourceApi) throw new Error("Choose either Entra ID authentication or the development actor, not both.");
  const accountMode = accounts?.mode || "off";
  if (accountMode !== "off" && !auth) throw new Error("Account Management needs Microsoft Entra ID sign-in.");
  // Production: observation mode (staged) only until enforcement is separately approved (config refuses it too).
  if (accountMode === "enforced" && environment === "production") throw new Error("ACCOUNT_MANAGEMENT=enforced is not approved for production yet.");
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); next(); });

  const api = express.Router();
  // inflate: false — compressed (gzip/deflate/br) request bodies are refused with 415 before anything is read or
  // decompressed. JARC's browser app never sends them, and this parser runs before authentication, so decompression
  // would be reachable without signing in (body-parser advisory GHSA-27r3-jxmh-p828).
  api.use(express.json({ limit: JSON_BODY_LIMIT, strict: true, inflate: false }));
  api.use(healthRoutes({ environment, version, database: dataLayer?.connection ?? null }));
  api.use(authConfigRoutes({ mode: auth ? "entra" : "dev", entra: auth?.entra }));
  if (enableDevStateApi) {
    if (!repository) throw new Error("createApp needs a repository when the development state API is enabled.");
    api.use(stateRoutes({ repository }));
  }
  if (enableDevResourceApi || auth) {
    if (!dataLayer) throw new Error("createApp needs a data layer for the resource API.");
    if (enableDevResourceApi && !devActor) throw new Error("createApp needs the development actor for the development resource API.");
    const access = new Access(dataLayer.repos, { policy: accessPolicy, betaOpenEditing, accountMode });
    const accountService = accountMode !== "off" ? dataLayer.services.accounts.configure({ mode: accountMode, superAdmin: accounts.superAdmin || null, entra: auth.entra, environment }) : null;
    // monday.com OAuth return and webhooks: no JARC session (each has its own protection).
    if (dataLayer.services?.integration) api.use(integrationPublicRoutes({ integration: dataLayer.services.integration }));
    if (auth) api.use(signInRoutes({ entra: auth.entra, verify: auth.verify, repos: dataLayer.repos, access, accounts: accountService }));
    const identify = auth ? sessionAuthentication({ sessions: dataLayer.repos.sessions, users: dataLayer.repos.users, entra: auth.entra, accountMode }) : devActorMiddleware(devActor, { environment });
    // Everything after `identify` requires a caller (in Entra mode, a valid session — including unknown paths).
    if (auth) api.use(identify, sessionRoutes({ repos: dataLayer.repos, access, accounts: accountService }));
    if (accountService) api.use(identify, accountRoutes({ services: dataLayer.services, repos: dataLayer.repos }));
    api.use(identify, meRoutes({ repos: dataLayer.repos, mode: auth ? "entra" : "dev", access }), memberRoutes({ services: dataLayer.services, access, repos: dataLayer.repos }), resourceRoutes({ services: dataLayer.services, access }));
    // Files columns (attachments in GridFS).
    if (dataLayer.services?.files) api.use(identify, fileRoutes({ services: dataLayer.services, access }));
    // Global search across the boards the caller may see.
    if (dataLayer.services?.search) api.use(identify, searchRoutes({ services: dataLayer.services, access, repos: dataLayer.repos, ...(searchLimiter ? { limiter: searchLimiter } : {}) }));
    if (dataLayer.services?.comments) api.use(identify, commentRoutes({ services: dataLayer.services, access }));
    api.use(identify, preferenceRoutes({ repos: dataLayer.repos }));
    if (dataLayer.services?.integration) api.use(identify, integrationRoutes({ integration: dataLayer.services.integration, access }));
    // Live updates (Server-Sent Events) from the activity log; live: { pollMs, overlapMs, timings } for tests.
    const stream = new ActivityStream({ activities: dataLayer.repos.activities, logger, ...(live.pollMs ? { pollMs: live.pollMs } : {}), ...(live.overlapMs ? { overlapMs: live.overlapMs } : {}) });
    app.locals.realtime = stream;
    api.use(identify, eventRoutes({ stream, access, repos: dataLayer.repos, sessionCheck: auth ? entraSessionCheck({ sessions: dataLayer.repos.sessions, users: dataLayer.repos.users }) : null, timings: live.timings }));
  }
  api.use(apiNotFound);
  app.use("/api/v1", api);
  app.use("/api", apiNotFound); // unversioned API paths are not served either

  if (auth) {
    const indexHtml = resourceModeIndex(siteDir);
    app.get(["/", "/index.html"], (req, res) => res.set("Cache-Control", "no-cache").type("html").send(indexHtml));
  }
  app.get("/vendor/msal-browser.min.js", (req, res) => res.set("Cache-Control", "public, max-age=3600").type("text/javascript").sendFile(MSAL_BUNDLE));
  app.use(express.static(siteDir, { index: "index.html", dotfiles: "ignore" }));
  app.use((req, res) => sendError(res, 404, "NOT_FOUND", "Not found."));
  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp, JSON_BODY_LIMIT };
