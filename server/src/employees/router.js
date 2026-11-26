// The Employee Management session routes (a JARC administration feature). Mounted by app.js behind `identify` (a JARC session;
// state-changing requests need the CSRF token, auth/session.js). All paths are relative; the mount point decides the prefix
// (/api/v1/admin/employees):
//   GET /status
//   GET /:ds/schema | /:ds/records | /:ds/records/:id | /:ds/values         ds ∈ active | all | disabled | guests
//   GET /:ds/records/:id/jarc-access                                        P2: EMPLOYEE_ADMIN_OIDS only (jarcAccess)
//   GET|POST /saved-filters/:ds, PUT|DELETE /saved-filters/:ds/:id          (routes/employee-saved-filters.js)
//   P3 (Access Administration, access-admin.js; JARC_FEATURE_EMPLOYEE_ACCESS_ADMIN=true and EMPLOYEE_ADMIN_OIDS only):
//   GET /:ds/records/:id/manage-access | /:ds/records/:id/access-history
//   POST /:ds/records/:id/access | /:ds/records/:id/memberships | /:ds/records/:id/end-sessions (P4-0 O5, its own rate limit)
//   PATCH|DELETE /:ds/records/:id/memberships/:workspaceRef
//   Switched off: 404 for every method for a listed viewer or administrator; everyone else gets the router's usual answer first
//   (signed out or a bearer token 401, not listed 403). On: anyone but an administrator 403 EMPLOYEES_FORBIDDEN. Writes: CSRF (the
//   session middleware), their own 8 KB JSON parser (app.js), WRITES_PER_MINUTE per administrator and WRITES_IN_FLIGHT at once.
// Who: EMPLOYEE_VIEWER_OIDS / EMPLOYEE_ADMIN_OIDS within the tenant only (access.js). A bearer token is refused (401), no
// session → 401, anyone else → 403 EMPLOYEES_FORBIDDEN on every path (records, IDs and saved filters included). An admin
// dataset for a viewer → 403; an unknown dataset → 404 (never echoed). Data routes are GET/HEAD only, never cached
// (Cache-Control: no-store) and rate limited per person. Errors are logged by route only: never a value or query text.
const express = require("express");
const { sendError, apiNotFound } = require("../middleware/errors");
const { searchLimiter } = require("../routes/search");
const { employeeSavedFilterRoutes } = require("../routes/employee-saved-filters");
const { employeeError, invalid, describe, MESSAGES } = require("./errors");

const invalidQuery = () => invalid("Unknown parameter.", "query", "unknownParameter");

const READS_PER_WINDOW = 60, WINDOW_MS = 10 * 1000, PER_CALLER_IN_FLIGHT = 4;
const WRITES_PER_MINUTE = 20, WRITES_IN_FLIGHT = 2;
// O5 End sessions: its own limit per administrator, on top of the P3 write limit (one person per request; no bulk path).
const END_SESSIONS_PER_WINDOW = 10, END_SESSIONS_WINDOW_MS = 10 * 60 * 1000;
// The P3 paths (any method): answered here, never by the GET-only data routes below.
// Case-insensitive, as Express routes are (app.js's 8 KB parser path matches the same way).
const P3_PATH = /^\/[^/]+\/records\/[^/]+\/(?:manage-access|access|access-history|end-sessions|memberships(?:\/[^/]+)?)\/?$/i;

// employees: createEmployees(...) result ({ service, accessFor }). savedFilterRepo: dataLayer.repos.employeeSavedFilters (or
// null: no saved filter paths). limiter: (userKey) → boolean for the data routes. savedFilters: { readLimiter, writeLimiter,
// maxPerDataset } passed to the saved filter routes (tests).
// jarcAccess (P2): the JARC access index (jarc-access.js JarcAccessIndex), or null. Without it (P1 mounts, tests) nobody gets
// jarcAccess: the JARC fields and GET /:ds/records/:id/jarc-access don't exist for anyone (403 EMPLOYEES_FORBIDDEN on that path).
// accessAdmin (P3): an AccessAdminService (access-admin.js), or null while JARC_FEATURE_EMPLOYEE_ACCESS_ADMIN is off. writeLimiter:
// (adminKey) → boolean for the P3 writes (tests). endSessionsLimiter: (adminKey) → boolean for O5 End sessions (default
// END_SESSIONS_PER_WINDOW per END_SESSIONS_WINDOW_MS per administrator).
function employeeRoutes({ employees, savedFilterRepo = null, jarcAccess = null, accessAdmin = null, limiter = searchLimiter({ perWindow: READS_PER_WINDOW, windowMs: WINDOW_MS }), writeLimiter = searchLimiter({ perWindow: WRITES_PER_MINUTE, windowMs: 60 * 1000 }), endSessionsLimiter = searchLimiter({ perWindow: END_SESSIONS_PER_WINDOW, windowMs: END_SESSIONS_WINDOW_MS }), savedFilters = {}, logger = console, perCallerInFlight = PER_CALLER_IN_FLIGHT, writesInFlight = WRITES_IN_FLIGHT }) {
  if (!employees?.service || typeof employees.accessFor !== "function") throw new Error("employeeRoutes needs createEmployees(...).");
  if (jarcAccess && typeof jarcAccess.current !== "function") throw new Error("employeeRoutes jarcAccess must be a JarcAccessIndex.");
  const { service } = employees;
  const router = express.Router();
  const send = (res, body) => res.status(200).set("Cache-Control", "no-store").json(body);
  const running = new Map();

  // Session only, listed people only; decided on every request (the lists come from configuration, re-read each time).
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.get("authorization") !== undefined) return sendError(res, 401, "UNAUTHENTICATED", "Sign in to JARC to use Employee Management. API tokens aren't accepted here.");
    if (!req.actor) return sendError(res, 401, "UNAUTHENTICATED", "Sign in to JARC to use Employee Management.");
    const access = employees.accessFor(req.actor);
    if (!access.view) return sendError(res, 403, "EMPLOYEES_FORBIDDEN", MESSAGES.EMPLOYEES_FORBIDDEN);
    const { jarcAccess: jarcGranted, ...p1 } = access;
    req.employeeAccess = Object.freeze({ ...p1, datasets: Object.freeze([...access.datasets]), who: String(req.actor.userId), ...(jarcGranted === true && jarcAccess ? { jarcAccess: true } : {}) });
    return next();
  });

  const datasetOf = (req) => service.dataset(req.params.ds, req.employeeAccess);
  if (savedFilterRepo) router.use("/saved-filters", employeeSavedFilterRoutes({ repo: savedFilterRepo, datasetOf, ...savedFilters }));
  else router.use("/saved-filters", apiNotFound);

  // At most `max` requests of this caller at once in `map` (released when the response closes).
  const admit = (map, key, max, res) => {
    const count = map.get(key) || 0;
    if (count >= max) return false;
    map.set(key, count + 1);
    let done = false;
    res.on("close", () => { if (done) return; done = true; const left = (map.get(key) || 1) - 1; if (left > 0) map.set(key, left); else map.delete(key); });
    return true;
  };
  const readGate = (req, res, next) => {
    const key = req.employeeAccess.who;
    if (limiter && !limiter(key)) { res.set("Retry-After", String(Math.ceil(WINDOW_MS / 1000))); return sendError(res, 429, "RATE_LIMITED", MESSAGES.RATE_LIMITED); }
    if (!admit(running, key, perCallerInFlight, res)) { res.set("Retry-After", "2"); return sendError(res, 429, "RATE_LIMITED", MESSAGES.RATE_LIMITED); }
    return next();
  };

  // ---- P3 (Access Administration), before the GET-only guard.
  if (!accessAdmin) router.all(P3_PATH, (req, res) => { const e = employeeError("NOT_FOUND"); sendError(res, e.status, e.code, e.message); });
  else {
    const writing = new Map();
    const adminOnly = (req, res, next) => (req.employeeAccess.admin === true && req.employeeAccess.jarcAccess === true ? next() : sendError(res, 403, "EMPLOYEES_FORBIDDEN", MESSAGES.EMPLOYEES_FORBIDDEN));
    const writeGate = (req, res, next) => {
      const key = req.employeeAccess.who;
      if (writeLimiter && !writeLimiter(key)) { res.set("Retry-After", "60"); return sendError(res, 429, "RATE_LIMITED", MESSAGES.RATE_LIMITED); }
      if (!admit(writing, key, writesInFlight, res)) { res.set("Retry-After", "2"); return sendError(res, 429, "RATE_LIMITED", MESSAGES.RATE_LIMITED); }
      return next();
    };
    const noQuery = (req) => { if (Object.keys(req.query || {}).length) throw invalidQuery(); };
    const p = "/:ds/records/:id";
    router.get(`${p}/manage-access`, adminOnly, readGate, async (req, res) => { noQuery(req); send(res, await accessAdmin.manageAccess(req.params.ds, req.params.id, req.employeeAccess, req.actor)); });
    router.get(`${p}/access-history`, adminOnly, readGate, async (req, res) => send(res, await accessAdmin.history(req.params.ds, req.params.id, req.query, req.employeeAccess)));
    router.post(`${p}/access`, adminOnly, writeGate, async (req, res) => { noQuery(req); send(res, await accessAdmin.changeAccess(req.params.ds, req.params.id, req.body, req.employeeAccess, req.actor)); });
    const endSessionsGate = (req, res, next) => {
      if (endSessionsLimiter && !endSessionsLimiter(req.employeeAccess.who)) { res.set("Retry-After", String(Math.ceil(END_SESSIONS_WINDOW_MS / 1000))); return sendError(res, 429, "RATE_LIMITED", MESSAGES.RATE_LIMITED); }
      return next();
    };
    router.post(`${p}/end-sessions`, adminOnly, endSessionsGate, writeGate, async (req, res) => { noQuery(req); send(res, await accessAdmin.endSessions(req.params.ds, req.params.id, req.body, req.employeeAccess, req.actor)); });
    router.post(`${p}/memberships`, adminOnly, writeGate, async (req, res) => { noQuery(req); res.status(201).set("Cache-Control", "no-store").json(await accessAdmin.addMembership(req.params.ds, req.params.id, req.body, req.employeeAccess, req.actor)); });
    router.patch(`${p}/memberships/:workspaceRef`, adminOnly, writeGate, async (req, res) => { noQuery(req); send(res, await accessAdmin.changeMembership(req.params.ds, req.params.id, req.params.workspaceRef, req.body, req.employeeAccess, req.actor)); });
    router.delete(`${p}/memberships/:workspaceRef`, adminOnly, writeGate, async (req, res) => { noQuery(req); send(res, await accessAdmin.removeMembership(req.params.ds, req.params.id, req.params.workspaceRef, req.body, req.employeeAccess, req.actor)); });
    router.all(P3_PATH, (req, res) => sendError(res, 405, "METHOD_NOT_ALLOWED", "This method isn't supported here."));
  }

  router.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.set("Allow", "GET, HEAD"); return sendError(res, 405, "METHOD_NOT_ALLOWED", "The people directory is read-only."); }
    return readGate(req, res, next);
  });

  // The index only for jarcAccess callers; everyone else's requests never touch it.
  const jarcOf = (req) => (req.employeeAccess.jarcAccess === true ? jarcAccess : null);
  router.get("/status", async (req, res) => send(res, await service.status(req.query, req.employeeAccess, jarcOf(req))));
  router.get("/:ds/schema", (req, res) => send(res, service.schema(req.params.ds, req.query, req.employeeAccess)));
  router.get("/:ds/records", async (req, res) => send(res, await service.listRecords(req.params.ds, req.query, req.employeeAccess, jarcOf(req))));
  router.get("/:ds/records/:id", async (req, res) => send(res, await service.getRecord(req.params.ds, req.params.id, req.query, req.employeeAccess, jarcOf(req))));
  router.get("/:ds/records/:id/jarc-access", async (req, res) => send(res, await service.jarcAccessOf(req.params.ds, req.params.id, req.query, req.employeeAccess, jarcOf(req))));
  router.get("/:ds/values", async (req, res) => send(res, await service.values(req.params.ds, req.query, req.employeeAccess, jarcOf(req))));
  router.use((req, res) => { const e = employeeError("NOT_FOUND"); sendError(res, e.status, e.code, e.message); });

  // Known errors keep their code; anything else is logged by route (never its message, the path or the query) and is a 500.
  // eslint-disable-next-line no-unused-vars -- Express identifies error middleware by its four arguments.
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === "entity.too.large") return sendError(res, 413, "PAYLOAD_TOO_LARGE", "The data is larger than the server accepts.");
    if (error?.type === "entity.parse.failed") return sendError(res, 400, "VALIDATION_ERROR", "The request body is not valid JSON.");
    if (error?.status && error?.code && error.status < 600 && (error.status < 500 || error.code === "EMPLOYEES_UNAVAILABLE")) return sendError(res, error.status, error.code, error.message, error.details);
    logger.error?.(`[employees]${req.requestId ? ` [req ${req.requestId}]` : ""} ${req.method} ${req.route?.path || "route"} failed: ${describe(error)}`);
    return sendError(res, 500, "INTERNAL_ERROR");
  });
  return router;
}

module.exports = { employeeRoutes };
