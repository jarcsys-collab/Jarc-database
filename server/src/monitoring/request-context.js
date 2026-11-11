// Request correlation IDs (Q1.1/Q1.4). Every API request gets an ID: the caller's X-Request-Id when it is a plain token
// (8–64 letters, digits, "-", "_" or "."), otherwise a new random one. It is returned in the X-Request-Id response header,
// written into server log lines and activity entries made while handling the request, and listed with recent errors on the
// System Health page, so one failure can be followed from the browser to the log to the audit trail.
//
// The ID is kept in AsyncLocalStorage, so code deep inside a service can read it without it being passed around.
// Kept free of app-level requires.
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const { monitor: defaultMonitor } = require("./monitor");

const storage = new AsyncLocalStorage();
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const newRequestId = () => crypto.randomBytes(9).toString("base64url");

// The request ID of the request being handled, or null outside one (startup, background workers).
const currentRequestId = () => storage.getStore()?.requestId ?? null;

// The route pattern Express matched ("/boards/:boardId/records"), never the URL as sent.
const routeOf = (req) => (req.route?.path !== undefined ? `${req.baseUrl || ""}${typeof req.route.path === "string" ? req.route.path : "(pattern)"}` : "(unmatched)");

// Mounted first on /api/v1. The live-update stream stays open by design, so it isn't timed.
function requestContext({ monitor = defaultMonitor } = {}) {
  return (req, res, next) => {
    const sent = req.get("x-request-id");
    const requestId = typeof sent === "string" && REQUEST_ID.test(sent) ? sent : newRequestId();
    req.requestId = requestId;
    res.set("X-Request-Id", requestId);
    if (req.path !== "/events") {
      const started = process.hrtime.bigint();
      res.once("finish", () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        monitor.recordRequest({ method: req.method, route: routeOf(req), status: res.statusCode, ms, requestId, code: res.locals.errorCode || null });
      });
    }
    storage.run({ requestId }, next);
  };
}

module.exports = { requestContext, currentRequestId, routeOf, newRequestId, REQUEST_ID };
