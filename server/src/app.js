// Creates and configures the Express application without listening on a port (server.js does that), so tests can
// exercise it directly.
//
//   /api/v1/*  → JSON API (unknown paths → JSON 404, never index.html)
//   /*         → the existing static frontend in site/ (same origin, so no CORS)
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
const { version } = require("../package.json");

// Larger than any state the frontend can produce today: browser storage caps at roughly 5 MB, and backup and CSV
// imports are limited to 10 MB. Bigger bodies get 413 PAYLOAD_TOO_LARGE.
const JSON_BODY_LIMIT = "10mb";
const DEFAULT_SITE_DIR = path.resolve(__dirname, "..", "..", "site");
// Microsoft sign-in library (MSAL Browser, pinned in package.json), served from this origin rather than a CDN.
const MSAL_BUNDLE = path.join(path.dirname(require.resolve("@azure/msal-browser/package.json")), "lib", "msal-browser.min.js");

// dataLayer (optional): { connection, repos, services } from createDataLayer. Without it the server behaves exactly
// as in Stage 9. Who may use the resource API:
//   auth = { mode: "entra", entra, verify }   Microsoft Entra ID sign-in → server session cookie (required in production)
//   enableDevResourceApi + devActor            the fixed development user (development and test only)
function createApp({ repository, environment = "development", enableDevStateApi = true, dataLayer = null, devActor = null, auth = null, enableDevResourceApi = Boolean(dataLayer) && !auth, siteDir = DEFAULT_SITE_DIR, logger = console } = {}) {
  if (environment === "production" && (enableDevStateApi || enableDevResourceApi)) {
    throw new Error("Development (pre-auth) APIs can't be enabled in production.");
  }
  if (auth && (auth.mode !== "entra" || typeof auth.verify !== "function" || !auth.entra)) throw new Error("createApp auth must be Entra ID token validation.");
  if (auth && enableDevResourceApi) throw new Error("Choose either Entra ID authentication or the development actor, not both.");
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); next(); });

  const api = express.Router();
  api.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));
  api.use(healthRoutes({ environment, version, database: dataLayer?.connection ?? null }));
  api.use(authConfigRoutes({ mode: auth ? "entra" : "dev", entra: auth?.entra }));
  if (enableDevStateApi) {
    if (!repository) throw new Error("createApp needs a repository when the development state API is enabled.");
    api.use(stateRoutes({ repository }));
  }
  if (enableDevResourceApi || auth) {
    if (!dataLayer) throw new Error("createApp needs a data layer for the resource API.");
    if (enableDevResourceApi && !devActor) throw new Error("createApp needs the development actor for the development resource API.");
    if (auth) api.use(signInRoutes({ entra: auth.entra, verify: auth.verify, repos: dataLayer.repos }));
    const identify = auth ? sessionAuthentication({ sessions: dataLayer.repos.sessions, users: dataLayer.repos.users, entra: auth.entra }) : devActorMiddleware(devActor, { environment });
    const access = new Access(dataLayer.repos);
    // Everything after `identify` requires a caller (in Entra mode, a valid session — including unknown paths).
    if (auth) api.use(identify, sessionRoutes({ repos: dataLayer.repos }));
    api.use(identify, meRoutes({ repos: dataLayer.repos, mode: auth ? "entra" : "dev" }), memberRoutes({ services: dataLayer.services, access }), resourceRoutes({ services: dataLayer.services, access }));
  }
  api.use(apiNotFound);
  app.use("/api/v1", api);
  app.use("/api", apiNotFound); // unversioned API paths are not served either

  app.get("/vendor/msal-browser.min.js", (req, res) => res.set("Cache-Control", "public, max-age=3600").type("text/javascript").sendFile(MSAL_BUNDLE));
  app.use(express.static(siteDir, { index: "index.html", dotfiles: "ignore" }));
  app.use((req, res) => sendError(res, 404, "NOT_FOUND", "Not found."));
  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp, JSON_BODY_LIMIT };
