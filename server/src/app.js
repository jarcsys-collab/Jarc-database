// Creates and configures the Express application without listening on a port (server.js does that), so tests can
// exercise it directly.
//
//   /api/v1/*  → JSON API (unknown paths → JSON 404, never index.html)
//   /*         → the existing static frontend in site/ (same origin, so no CORS)
//   /boards/:id → the same page (a direct board link; GET only)
const fs = require("fs");
const path = require("path");
const express = require("express");
const { healthRoutes } = require("./routes/health");
const { slowRequestLog } = require("./middleware/slow-requests");
const { requestContext } = require("./monitoring/request-context");
const { monitor: defaultMonitor } = require("./monitoring/monitor");
const { systemHealthRoutes, isSystemHealthViewer } = require("./routes/system-health");
const { stateRoutes } = require("./routes/state");
const { resourceRoutes } = require("./routes/resources");
const { memberRoutes } = require("./routes/members");
const { authConfigRoutes, signInRoutes, sessionRoutes, meRoutes } = require("./routes/auth");
const { devActorMiddleware } = require("./context/dev-actor");
const { sessionAuthentication, stillAllowed } = require("./auth/session");
const { canManageDrive, actorCanManageDrive } = require("./integrations/google-drive/access");
const { Access } = require("./auth/access");
const { apiNotFound, errorHandler, sendError } = require("./middleware/errors");
const { securityHeaders, cspReportHandler } = require("./middleware/security-headers");
const { employeeRoutes, JarcAccessIndex, AccessAdminService } = require("./employees");
const { ActivityStream } = require("./realtime/activity-stream");
const { eventRoutes, entraSessionCheck } = require("./routes/events");
const { fileRoutes } = require("./routes/files");
const { searchRoutes, searchLimiter: createSearchLimiter } = require("./routes/search");
const { integrationRoutes, integrationPublicRoutes } = require("./routes/integrations");
const { googleDriveRoutes, googleDrivePublicRoutes } = require("./routes/google-drive");
const { midAttachmentRoutes } = require("./routes/mid-attachments");
const { commentRoutes } = require("./routes/comments");
const { formRoutes } = require("./routes/forms");
const { importRoutes } = require("./routes/imports");
const { preferenceRoutes } = require("./routes/preferences");
const { accountRoutes } = require("./routes/accounts");
const { apiTokenRoutes } = require("./routes/api-tokens");
const { externalApiRoutes, windowLimiter, FAILED_AUTH } = require("./routes/external-api");
const { externalFabricRoutes } = require("./routes/external-fabric");
const { fabricApiTokenRoutes } = require("./routes/fabric-api-tokens");
const { fabricSavedFilterRoutes } = require("./routes/fabric-saved-filters");
const { validate: validateFabricFilter } = require("./fabric/filter-model");
const { fabricDataRouter, requireFabricDataRead, canReadFabric, canReadFabricSensitive, canReadFabricCost, canManageFabricApi, canOverseeFabricApi, DATASET_NAMES } = require("./fabric");
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
// Direct board links: /boards/{boardId} is the same page as /. Its stylesheets, fonts and scripts are named relative to the
// page ("assets/…"), which from /boards/ would mean /boards/assets/…, so here they are named from the site root.
const BOARD_LINK_PATH = /^\/boards\/[^/]{1,200}\/?$/;
// Fabric Data pages (only while JARC_FEATURE_FABRIC_DATA is on): the same page; the app shows the Fabric view.
// /fabric/inventory, /fabric/sales, /fabric/api and /fabric/{inventory|sales}/records/{id}; the invoice pages only with
// FABRIC_INVOICE_VIEWS.
const FABRIC_LINK_PATH = /^\/fabric\/((inventory|sales)(\/records\/[^/]{1,64})?|api)\/?$/;
const FABRIC_INVOICE_LINK_PATH = /^\/fabric\/invoices(\/[^/]{1,400}\/[^/]{1,400})?\/?$/;
// People directory (Employee Management) links: the screen itself asks the server what this person may see. …/records/{id}/access
// is the profile's JARC access tab (P2; the page shows it only to Employee Management admins).
const EMPLOYEES_LINK_PATH = /^\/admin\/employees(?:\/(?:active|all|disabled|guests)(?:\/records\/[A-Za-z0-9_-]{22}(?:\/access|\/manage)?)?|\/groups\/(?:department|jobTitle|officeLocation|emailDomain))?\/?$/;
// Case-insensitive like Express routing, so /RECORDS/…/ACCESS can't reach the P3 handlers past this parser.
const EMPLOYEE_P3_WRITE_PATH = /^\/[^/]+\/records\/[^/]+\/(?:access|memberships(?:\/[^/]+)?)\/?$/i;
const rootRelative = (html) => html.replace(/(\s(?:href|src))="assets\//g, '$1="/assets/');

// An optional feature not stated is off in production and on elsewhere.
const resolveFeatures = (features = {}, environment = "development") => { const on = (name) => (typeof features[name] === "boolean" ? features[name] : environment !== "production"); return Object.freeze({ nativeForms: on("nativeForms"), spreadsheetImports: on("spreadsheetImports"), personalViews: on("personalViews"), connectBoards: on("connectBoards") }); };

// dataLayer (optional): { connection, repos, services } from createDataLayer. Without it the server behaves exactly
// as in Stage 9. Who may use the resource API:
//   auth = { mode: "entra", entra, verify }   Microsoft Entra ID sign-in → server session cookie (required in production)
//   enableDevResourceApi + devActor            the fixed development user (development and test only)
// accessPolicy: "role_based" (default) or "development_shared" (see auth/access.js). betaOpenEditing: temporary
// beta collaboration (JARC_BETA_OPEN_EDITING), see auth/access.js. accounts: Account Management (Phase M4.3,
// auth/accounts.js) { mode: off | staged | enforced, superAdmin }; Entra sign-in only. features: the optional features switched
// on, { nativeForms, spreadsheetImports } (config/index.js); anything not stated is off in production and on elsewhere.
// apiTokens: { key, perMinute? } turns on API tokens for other systems (config/index.js); Entra sign-in only. Without it their paths don't exist.
// fabricData: { config, service, limiter? } (config.fabricData with the switch on, and a FabricService from src/fabric) turns on Fabric Data;
// Entra sign-in only. Without it (or with the switch off) its paths don't exist and /features doesn't mention it.
function createApp({ securityHeadersOptions = {}, employees: employeesOption = null, fabricData = null, apiTokens = null, features = {}, repository, environment = "development", enableDevStateApi = true, dataLayer = null, devActor = null, auth = null, enableDevResourceApi = Boolean(dataLayer) && !auth, accessPolicy = "role_based", betaOpenEditing = false, accounts = null, live = {}, searchLimiter = null, employeeWriteLimiter = null, systemHealth = null, siteDir = DEFAULT_SITE_DIR, logger = console, slowRequestMs = 0, monitor = defaultMonitor } = {}) {
  if (environment === "production" && (enableDevStateApi || enableDevResourceApi)) {
    throw new Error("Development (pre-auth) APIs can't be enabled in production.");
  }
  if (auth && (auth.mode !== "entra" || typeof auth.verify !== "function" || !auth.entra)) throw new Error("createApp auth must be Entra ID token validation.");
  if (auth && enableDevResourceApi) throw new Error("Choose either Entra ID authentication or the development actor, not both.");
  const accountMode = accounts?.mode || "off";
  if (accountMode !== "off" && !auth) throw new Error("Account Management needs Microsoft Entra ID sign-in.");
  // Production: observation mode (staged) only until enforcement is separately approved (config refuses it too).
  if (accountMode === "enforced" && environment === "production") throw new Error("ACCOUNT_MANAGEMENT=enforced is not approved for production yet.");
  const enabled = resolveFeatures(features, environment);
  const fabric = fabricData?.config?.enabled ? fabricData : null;
  if (fabric && !auth) throw new Error("Fabric Data needs Microsoft Entra ID sign-in.");
  if (fabric && !fabric.service) throw new Error("createApp needs the Fabric service when Fabric Data is on.");
  // Employee Management (JARC administration): its own permission lists; it shares only the read-only directory connection.
  const employees = employeesOption?.config?.enabled ? employeesOption : null;
  if (employees && !auth) throw new Error("Employee Management needs Microsoft Entra ID sign-in.");
  const app = express();
  app.disable("x-powered-by");
  // P0 security headers: nosniff, X-Frame-Options DENY, enforced frame-ancestors/base-uri/object-src, Referrer-Policy,
  // Permissions-Policy, HSTS (production over HTTPS) and the full Content-Security-Policy in REPORT-ONLY mode (enforced
  // after the reports are reviewed). A route's own stricter headers (attachments, Google Drive return) are kept.
  app.use(securityHeaders({ environment, entra: auth?.entra || null, reportUri: "/api/v1/csp-report", ...securityHeadersOptions }));

  const api = express.Router();
  api.use(slowRequestLog({ logger, thresholdMs: slowRequestMs }));
  // First, so every API response (errors included) carries X-Request-Id and is timed for System Health.
  api.use(requestContext({ monitor }));
  // The token API takes no request bodies, so it comes before the body parser. Filled in below when API tokens are on.
  const external = express.Router();
  api.use("/external", external);
  // inflate: false — compressed (gzip/deflate/br) request bodies are refused with 415 before anything is read or
  // decompressed. JARC's browser app never sends them, and this parser runs before authentication, so decompression
  // would be reachable without signing in (body-parser advisory GHSA-27r3-jxmh-p828).
  // Saved Fabric filters take small bodies only (a filter is at most 4 KB canonical): their own 32 KB parser runs first, so the
  // app-wide 10 MB parser below sees the body as already read and skips it (L3, Fabric phase 7 security review).
  if (fabric) api.use("/fabric/saved-filters", express.json({ limit: "32kb", strict: true, inflate: false }));
  if (employees) api.use("/admin/employees/saved-filters", express.json({ limit: "32kb", strict: true, inflate: false }));
  // P3 Access Administration writes: their own 8 KB parser (an action body is a few hundred bytes).
  const employeeWriteParser = express.json({ limit: "8kb", strict: true, inflate: false });
  if (employees) api.use("/admin/employees", (req, res, next) => (EMPLOYEE_P3_WRITE_PATH.test(req.path) ? employeeWriteParser(req, res, next) : next()));
  // CSP violation reports (report-only policy): own 8 KB parser, logs directive + blocked origin only, rate-limited.
  api.use("/csp-report", cspReportHandler({ logger }));
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
    const access = new Access(dataLayer.repos, { policy: accessPolicy, betaOpenEditing, accountMode, logger });
    // P4-0: the usable-workspace-admin rule follows ACCOUNT_MANAGEMENT (blocked / pending / capped admins don't count).
    dataLayer.services?.members?.configure?.({ accountMode });
    const accountService = accountMode !== "off" ? dataLayer.services.accounts.configure({ mode: accountMode, superAdmin: accounts.superAdmin || null, entra: auth.entra, environment }) : null;
    // monday.com OAuth return and webhooks: no JARC session (each has its own protection).
    if (dataLayer.services?.integration) api.use(integrationPublicRoutes({ integration: dataLayer.services.integration }));
    // Google Drive's OAuth return, only with Microsoft sign-in and only while the feature is on. Managing Drive is decided by
    // GOOGLE_DRIVE_ADMIN_OIDS within this tenant (integrations/google-drive/access.js), never by JARC.Admin.
    const googleDrive = auth ? dataLayer.services?.googleDrive : null;
    const driveAdmin = (identity) => canManageDrive(identity, googleDrive.config, auth.entra.tenantId);
    if (googleDrive) api.use(googleDrivePublicRoutes({ drive: googleDrive, logger, stillAdmin: stillAllowed({ sessions: dataLayer.repos.sessions, users: dataLayer.repos.users, accountMode, allow: driveAdmin }) }));
    if (auth) api.use(signInRoutes({ entra: auth.entra, verify: auth.verify, repos: dataLayer.repos, access, accounts: accountService, logger }));
    const authenticate = auth ? sessionAuthentication({ sessions: dataLayer.repos.sessions, users: dataLayer.repos.users, entra: auth.entra, accountMode }) : devActorMiddleware(devActor, { environment });
    // Each router below is mounted with `identify`, and a request passes through every mount until one answers: the
    // full check runs once per request and later mounts reuse its verified result (req.actor).
    const identify = (req, res, next) => (req.actor ? next() : authenticate(req, res, next));
    // Everything after `identify` requires a caller (in Entra mode, a valid session — including unknown paths).
    if (auth) api.use(identify, sessionRoutes({ repos: dataLayer.repos, access, accounts: accountService }));
    // API tokens: managed with a session (and CSRF) here; used only under /external, which never reads a session. Managing them is
    // for the JARC API administrators only (apiTokens.adminObjectIds, JARC_API_ADMIN_OIDS in this tenant), never decided by
    // open access, workspace roles or JARC.Admin.
    const tokenService = auth && apiTokens ? dataLayer.services.apiTokens.configure({ key: apiTokens.key, access, tenantId: auth.entra.tenantId, adminObjectIds: apiTokens.adminObjectIds || [], ...(apiTokens.maxActive ? { maxActive: apiTokens.maxActive } : {}) }) : null;
    // Fabric Data (src/fabric): readers are FABRIC_DATA_READER_OIDS within this tenant only, never JARC.Admin, open access or
    // workspace roles. app.locals.fabric gives the Fabric API token routes the same service and permission checks.
    // /features fabricData: read, sensitive (cost: its alias for one release), apiAdmin, the datasets a reader may read and whether
    // the invoice views are mounted.
    const fabricAccessFor = fabric ? (actor) => {
      const read = canReadFabric(actor, fabric.config, auth.entra.tenantId);
      const sensitive = canReadFabricSensitive(actor, fabric.config, auth.entra.tenantId);
      const apiAdmin = canManageFabricApi(actor, fabric.config, auth.entra.tenantId);
      // apiOversight: manages every person's Fabric tokens (FABRIC_API_OVERSIGHT_OIDS); canGrantSensitive: may issue fabric.sensitive.read.
      return { read, sensitive, cost: sensitive, apiAdmin, apiOversight: canOverseeFabricApi(actor, fabric.config, auth.entra.tenantId), canGrantSensitive: apiAdmin && sensitive, datasets: read ? [...DATASET_NAMES] : [], invoiceViews: read && fabric.config.invoiceViews === true };
    } : null;
    if (fabric) app.locals.fabric = Object.freeze({ service: fabric.service, config: fabric.config, tenantId: auth.entra.tenantId, router: fabricDataRouter, canReadFabric, canReadFabricSensitive, canReadFabricCost, canManageFabricApi, canOverseeFabricApi });
    // Fabric API tokens (only with both switches on): the same token system as the board API (secret, digest, expiry, revocation,
    // audit), told apart by product "fabric" and the fabric.sales.read / fabric.inventory.read / fabric.sensitive.read scopes. A
    // Fabric token never reads boards (board authorize needs "read") and a board token never reads Fabric (403 INSUFFICIENT_SCOPE).
    // Who may issue them: FABRIC_API_ADMIN_OIDS ∩ readers (each manages their own); every person's: FABRIC_API_OVERSIGHT_OIDS ∩ admins.
    const fabricTokens = fabric && tokenService ? { permissions: {
      isApiAdmin: (identity) => canManageFabricApi(identity, fabric.config, auth.entra.tenantId),
      isApiOversight: (identity) => canOverseeFabricApi(identity, fabric.config, auth.entra.tenantId),
      isReader: (identity) => canReadFabric(identity, fabric.config, auth.entra.tenantId),
      isSensitiveReader: (identity) => canReadFabricSensitive(identity, fabric.config, auth.entra.tenantId),
      // The earlier name of the same check (the token service accepts either; remove once nothing reads it).
      isCostReader: (identity) => canReadFabricSensitive(identity, fabric.config, auth.entra.tenantId) }, failures: windowLimiter(apiTokens.failedAuth || FAILED_AUTH) } : null;
    if (tokenService) {
      // /external/fabric first, so its requests never reach the board token middleware (it ends with its own JSON 404). Failed
      // sign-in attempts are counted once per address across both APIs.
      if (fabricTokens) external.use("/fabric", externalFabricRoutes({ tokens: tokenService, fabricPermissions: fabricTokens.permissions, fabricDataRouter: fabricDataRouter({ service: fabric.service, logger, invoiceViews: false }), environment, rate: { perWindow: fabric.config.apiRatePerMinute, windowMs: 60 * 1000 }, failures: fabricTokens.failures }));
      external.use(externalApiRoutes({ tokens: tokenService, repos: dataLayer.repos, environment, ...(apiTokens.perMinute ? { rate: { perWindow: apiTokens.perMinute, windowMs: 60 * 1000 } } : {}), ...(apiTokens.failedAuth ? { failedAuth: apiTokens.failedAuth } : {}), ...(fabricTokens ? { failures: fabricTokens.failures } : {}) }));
      api.use(identify, apiTokenRoutes({ tokens: tokenService, access, repos: dataLayer.repos, ...(apiTokens.issuePerHour ? { limiter: createSearchLimiter({ perWindow: apiTokens.issuePerHour, windowMs: 60 * 60 * 1000 }) } : {}) }));
    }
    // Fabric API token management (session + CSRF; Fabric API administrators only), before the GET-only data router.
    // With API tokens off those paths don't exist: a JSON 404 for any method (never the data router's 405 or a fall-through).
    if (fabricTokens) api.use("/fabric/api-tokens", identify, fabricApiTokenRoutes({ tokens: tokenService, fabricPermissions: fabricTokens.permissions }), apiNotFound);
    else if (fabric) api.use("/fabric/api-tokens", identify, apiNotFound);
    // Fabric Data routes: GET/HEAD only, session only (a bearer token here is 401), readers only (403 FABRIC_DATA_FORBIDDEN).
    // The v1 invoice views only with FABRIC_INVOICE_VIEWS=true (never under /external/fabric). Ends in its own JSON 404:
    // nothing under /api/v1/fabric falls through to the routers below.
    // Saved filters (JARC's own database, session + CSRF, readers only; never for tokens), before the GET-only data router.
    if (fabric && dataLayer?.repos?.fabricSavedFilters) api.use("/fabric/saved-filters", identify, requireFabricDataRead({ config: fabric.config, tenantId: auth.entra.tenantId }), fabricSavedFilterRoutes({ repo: dataLayer.repos.fabricSavedFilters, validateFilter: validateFabricFilter }), apiNotFound);
    // advanced (this session mount only): filter= / orderBy= / searchField=, schema capabilities and GET /:dataset/values.
    if (fabric) api.use("/fabric", identify, requireFabricDataRead({ config: fabric.config, tenantId: auth.entra.tenantId }), fabricDataRouter({ service: fabric.service, logger, invoiceViews: fabric.config.invoiceViews === true, advanced: true, values: fabric.values || null, ...(fabric.limiter ? { limiter: fabric.limiter } : {}) }), apiNotFound);
    if (accountService) api.use(identify, accountRoutes({ services: dataLayer.services, repos: dataLayer.repos }));
    api.use(identify, meRoutes({ repos: dataLayer.repos, mode: auth ? "entra" : "dev", access }), memberRoutes({ services: dataLayer.services, access, repos: dataLayer.repos }), resourceRoutes({ services: dataLayer.services, access, features: enabled }));
    // Files columns (attachments in GridFS).
    if (dataLayer.services?.files) api.use(identify, fileRoutes({ services: dataLayer.services, access }));
    // Global search across the boards the caller may see.
    if (dataLayer.services?.search) api.use(identify, searchRoutes({ services: dataLayer.services, access, repos: dataLayer.repos, ...(searchLimiter ? { limiter: searchLimiter } : {}) }));
    if (dataLayer.services?.comments) api.use(identify, commentRoutes({ services: dataLayer.services, access }));
    // A feature that's off has no routes at all: its paths answer like any unknown path, whoever asks and however they ask.
    if (enabled.nativeForms && dataLayer.services?.forms) api.use(identify, formRoutes({ services: dataLayer.services, access }));
    if (enabled.spreadsheetImports && dataLayer.services?.importJobs) api.use(identify, importRoutes({ services: dataLayer.services, access }));
    // What this server has switched on, so the browser shows only what will work. The routes above are what enforce it.
    // apiTokenAdmin: whether THIS caller is a JARC API administrator (only to show or hide the Developer sections).
    // fabricData (only while it's on): what THIS caller may do there; apiTokens: whether Fabric API tokens can exist at all.
    // Employee Management (People directory): only the employee lists decide; never Fabric lists or workspace roles.
    // P2 (Employee Access Visibility, EMPLOYEE_ADMIN_OIDS only): the JARC access index reads JARC's own users, memberships,
    // workspaces, boards and live sessions (bounded, read-only) and mirrors THIS app's Access (same policy, beta open editing and
    // account mode), tenant and API administrators. Lazy: nothing is read until an admin asks.
    // features: which of the actions it describes exist on this server at all (spreadsheet imports and the monday.com integration
    // are mounted only when on, lines below).
    const jarcAccess = employees && auth ? new JarcAccessIndex({ repos: dataLayer.repos, access, tenantId: auth.entra.tenantId, apiAdminObjectIds: tokenService ? apiTokens.adminObjectIds || [] : null, employeesConfig: employees.config, features: { spreadsheetImports: Boolean(enabled.spreadsheetImports && dataLayer.services?.importJobs), mondayIntegration: Boolean(dataLayer.services?.integration) }, logger }) : null;
    // P3 (Access Administration, JARC_FEATURE_EMPLOYEE_ACCESS_ADMIN=true): account and membership changes for EMPLOYEE_ADMIN_OIDS,
    // through JARC's own users, memberships (MembershipService), sessions, API tokens and accountAudit. Off: its paths answer 404.
    const accessAdmin = jarcAccess && employees.config.accessAdmin === true && dataLayer.services?.members ? new AccessAdminService({ employees, jarcAccess, repos: dataLayer.repos, connection: dataLayer.connection, members: dataLayer.services.members, access, tenantId: auth.entra.tenantId, superAdmin: accounts?.superAdmin || null, logger }) : null;
    if (employees) api.use("/admin/employees", identify, employeeRoutes({ employees, savedFilterRepo: dataLayer.repos.employeeSavedFilters || null, jarcAccess, accessAdmin, logger, ...(employeeWriteLimiter ? { writeLimiter: employeeWriteLimiter } : {}) }));
    // employees.jarcAccess only when true (an admin, with the index wired): viewers and outsiders never see the key.
    // employees.accessAdmin (P3) only for that admin with the switch on.
    const employeeFlags = (actor) => { const { jarcAccess: jarc, ...flags } = employees.accessFor(actor); const admin = jarc === true && jarcAccess; return { ...flags, ...(admin ? { jarcAccess: true } : {}), ...(admin && accessAdmin ? { accessAdmin: true } : {}) }; };
    // systemHealth (only for someone who may open it): view, admin (the full view), activity (Activity History).
    const healthViewers = auth ? systemHealth?.viewerObjectIds || [] : [];
    const healthFlags = (actor) => (actor?.isSystemAdmin ? { view: true, admin: true, activity: true } : isSystemHealthViewer(actor, healthViewers, auth?.entra?.tenantId) ? { view: true, admin: false, activity: false } : null);
    api.get("/features", identify, (req, res) => {
      const health = healthFlags(req.actor);
      const fabricFlags = { ...(fabricAccessFor ? { fabricData: { ...fabricAccessFor(req.actor), apiTokens: Boolean(tokenService) } } : {}), ...(employees ? { employees: employeeFlags(req.actor) } : {}), ...(health ? { systemHealth: health } : {}) };
      // columnSettings: a capability of this server version, not a switch (no variable): it accepts, validates and keeps
      // column display `settings` (G3 / D12). Browsers write them only when it is true, so an older server never sees them.
      res.status(200).set("Cache-Control", "no-store").json({ features: tokenService ? { ...enabled, columnSettings: true, apiTokens: true, apiTokenAdmin: tokenService.isAdmin(req.actor), ...fabricFlags } : { ...enabled, columnSettings: true, ...fabricFlags } });
    });
    api.use(identify, preferenceRoutes({ repos: dataLayer.repos }));
    if (dataLayer.services?.integration) api.use(identify, integrationRoutes({ integration: dataLayer.services.integration, access }));
    if (googleDrive) api.use(identify, googleDriveRoutes({ drive: googleDrive, canManage: (actor) => actorCanManageDrive(actor, googleDrive.config, auth.entra.tenantId) }));
    // The Machine Installation Database attachment import: only while switched on, only for Google Drive administrators.
    if (googleDrive && dataLayer.services?.midAttachments) api.use(identify, midAttachmentRoutes({ migration: dataLayer.services.midAttachments, canManage: (actor) => actorCanManageDrive(actor, googleDrive.config, auth.entra.tenantId) }));
    // Live updates (Server-Sent Events) from the activity log; live: { pollMs, overlapMs, timings } for tests.
    // System Health, Integration Reliability and Activity History: JARC administrators only (checked in each route).
    // SYSTEM_HEALTH_VIEWER_OIDS (Entra sign-in only): a redacted System Health view, never Activity History.
    // Fabric index health (only while Fabric Data is on): the detail only for Fabric readers (FABRIC_DATA_READER_OIDS; Fabric API
    // administrators are readers too); everyone else who may see System Health gets the overall status only.
    const fabricHealth = fabric?.health || null;
    const canSeeFabricDetail = fabric ? (actor) => canReadFabric(actor, fabric.config, auth.entra.tenantId) || canManageFabricApi(actor, fabric.config, auth.entra.tenantId) : () => false;
    api.use(identify, systemHealthRoutes({ dataLayer, access, environment, version, monitor, enabled, canManageDrive: googleDrive ? (actor) => actorCanManageDrive(actor, googleDrive.config, auth.entra.tenantId) : () => false, viewerObjectIds: healthViewers, tenantId: auth?.entra?.tenantId || null, fabricHealth, canSeeFabricDetail }));
    const stream = new ActivityStream({ activities: dataLayer.repos.activities, logger, ...(live.pollMs ? { pollMs: live.pollMs } : {}), ...(live.overlapMs ? { overlapMs: live.overlapMs } : {}) });
    app.locals.realtime = stream;
    api.use(identify, eventRoutes({ stream, access, repos: dataLayer.repos, sessionCheck: auth ? entraSessionCheck({ sessions: dataLayer.repos.sessions, users: dataLayer.repos.users }) : null, timings: live.timings, logger }));
  }
  api.use(apiNotFound);
  app.use("/api/v1", api);
  app.use("/api", apiNotFound); // unversioned API paths are not served either

  let boardLinkHtml = null;
  if (auth) {
    const indexHtml = resourceModeIndex(siteDir);
    boardLinkHtml = rootRelative(indexHtml);
    app.get(["/", "/index.html"], (req, res) => res.set("Cache-Control", "no-cache").type("html").send(indexHtml));
  }
  // GET (and HEAD) only, one path segment only; the page itself checks the ID and whether this person may see the board.
  app.get(BOARD_LINK_PATH, (req, res, next) => {
    try { boardLinkHtml ??= rootRelative(fs.readFileSync(path.join(siteDir, "index.html"), "utf8")); } catch { return next(); }
    res.set("Cache-Control", "no-cache").type("html").send(boardLinkHtml);
  });
  // Fabric Data links (/fabric/inventory, /fabric/sales, /fabric/api, …/records/{id}; the invoice pages only with the invoice
  // views): only while it's on. The page itself checks whether this person may read Fabric Data.
  if (fabric) app.get(fabric.config.invoiceViews === true ? [FABRIC_LINK_PATH, FABRIC_INVOICE_LINK_PATH] : FABRIC_LINK_PATH, (req, res, next) => {
    try { boardLinkHtml ??= rootRelative(fs.readFileSync(path.join(siteDir, "index.html"), "utf8")); } catch { return next(); }
    res.set("Cache-Control", "no-cache").type("html").send(boardLinkHtml);
  });
  // People directory links: the page HTML only (no data); every directory request is authorised by the employee lists.
  if (employees) app.get(EMPLOYEES_LINK_PATH, (req, res, next) => {
    try { boardLinkHtml ??= rootRelative(fs.readFileSync(path.join(siteDir, "index.html"), "utf8")); } catch { return next(); }
    res.set("Cache-Control", "no-cache").type("html").send(boardLinkHtml);
  });
  app.get("/vendor/msal-browser.min.js", (req, res) => res.set("Cache-Control", "public, max-age=3600").type("text/javascript").sendFile(MSAL_BUNDLE));
  app.use(express.static(siteDir, { index: "index.html", dotfiles: "ignore" }));
  app.use((req, res) => sendError(res, 404, "NOT_FOUND", "Not found."));
  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp, resolveFeatures, JSON_BODY_LIMIT };
