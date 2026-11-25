// The Employee Management session routes (a JARC administration feature). Mounted by app.js behind `identify` (a JARC session;
// state-changing requests need the CSRF token, auth/session.js). All paths are relative; the mount point decides the prefix
// (/api/v1/admin/employees):
//   GET /status
//   GET /:ds/schema | /:ds/records | /:ds/records/:id | /:ds/values         ds ∈ active | all | disabled | guests
//   GET|POST /saved-filters/:ds, PUT|DELETE /saved-filters/:ds/:id          (routes/employee-saved-filters.js)
// Who: EMPLOYEE_VIEWER_OIDS / EMPLOYEE_ADMIN_OIDS within the tenant only (access.js). A bearer token is refused (401), no
// session → 401, anyone else → 403 EMPLOYEES_FORBIDDEN on every path (records, IDs and saved filters included). An admin
// dataset for a viewer → 403; an unknown dataset → 404 (never echoed). Data routes are GET/HEAD only, never cached
// (Cache-Control: no-store) and rate limited per person. Errors are logged by route only: never a value or query text.
const express = require("express");
const { sendError, apiNotFound } = require("../middleware/errors");
const { searchLimiter } = require("../routes/search");
const { employeeSavedFilterRoutes } = require("../routes/employee-saved-filters");
const { employeeError, describe, MESSAGES } = require("./errors");

const READS_PER_WINDOW = 60, WINDOW_MS = 10 * 1000, PER_CALLER_IN_FLIGHT = 4;

// employees: createEmployees(...) result ({ service, accessFor }). savedFilterRepo: dataLayer.repos.employeeSavedFilters (or
// null: no saved filter paths). limiter: (userKey) → boolean for the data routes. savedFilters: { readLimiter, writeLimiter,
// maxPerDataset } passed to the saved filter routes (tests).
function employeeRoutes({ employees, savedFilterRepo = null, limiter = searchLimiter({ perWindow: READS_PER_WINDOW, windowMs: WINDOW_MS }), savedFilters = {}, logger = console, perCallerInFlight = PER_CALLER_IN_FLIGHT }) {
  if (!employees?.service || typeof employees.accessFor !== "function") throw new Error("employeeRoutes needs createEmployees(...).");
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
    req.employeeAccess = Object.freeze({ ...access, datasets: Object.freeze([...access.datasets]), who: String(req.actor.userId) });
    return next();
  });

  const datasetOf = (req) => service.dataset(req.params.ds, req.employeeAccess);
  if (savedFilterRepo) router.use("/saved-filters", employeeSavedFilterRoutes({ repo: savedFilterRepo, datasetOf, ...savedFilters }));
  else router.use("/saved-filters", apiNotFound);

  router.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.set("Allow", "GET, HEAD"); return sendError(res, 405, "METHOD_NOT_ALLOWED", "The people directory is read-only."); }
    const key = req.employeeAccess.who;
    if (limiter && !limiter(key)) { res.set("Retry-After", String(Math.ceil(WINDOW_MS / 1000))); return sendError(res, 429, "RATE_LIMITED", MESSAGES.RATE_LIMITED); }
    const count = running.get(key) || 0;
    if (count >= perCallerInFlight) { res.set("Retry-After", "2"); return sendError(res, 429, "RATE_LIMITED", MESSAGES.RATE_LIMITED); }
    running.set(key, count + 1);
    let done = false;
    res.on("close", () => { if (done) return; done = true; const left = (running.get(key) || 1) - 1; if (left > 0) running.set(key, left); else running.delete(key); });
    return next();
  });

  router.get("/status", async (req, res) => send(res, await service.status(req.query, req.employeeAccess)));
  router.get("/:ds/schema", (req, res) => send(res, service.schema(req.params.ds, req.query, req.employeeAccess)));
  router.get("/:ds/records", async (req, res) => send(res, await service.listRecords(req.params.ds, req.query, req.employeeAccess)));
  router.get("/:ds/records/:id", async (req, res) => send(res, await service.getRecord(req.params.ds, req.params.id, req.query, req.employeeAccess)));
  router.get("/:ds/values", async (req, res) => send(res, await service.values(req.params.ds, req.query, req.employeeAccess)));
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
