// Error contract (Stage 7): every API error response is { "error": { "code", "message", "details"? } }.
// Responses never include stack traces, file paths, dependency internals, database errors or raw exception text.
const { isMongoError, translateMongoError } = require("../db/errors");
const { redact } = require("../db/connection");

class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.name = "ApiError"; this.status = status; this.code = code; if (details !== undefined) this.details = details; }
}

const SAFE_MESSAGES = Object.freeze({
  VALIDATION_ERROR: "The request is not valid.",
  NOT_FOUND: "This API endpoint does not exist.",
  PAYLOAD_TOO_LARGE: "The request is too large.",
  INTERNAL_ERROR: "Something went wrong on the server."
});

function sendError(res, status, code, message, details) {
  const error = { code, message: message || SAFE_MESSAGES[code] || SAFE_MESSAGES.INTERNAL_ERROR };
  if (details !== undefined) error.details = details;
  res.status(status).set("Cache-Control", "no-store").json({ error });
}

// JSON 404 for any unknown /api/v1 path, so API calls never receive index.html.
function apiNotFound(req, res) { sendError(res, 404, "NOT_FOUND"); }

// Logged request path: search text (q and filter values) is personal and never written to the server log.
const loggedUrl = (req) => {
  const url = String(req.originalUrl || "");
  return url.startsWith("/api/v1/search") && url.includes("?") ? `${url.split("?")[0]}?[redacted]` : url;
};

// Final error middleware. Known errors keep their code; everything else becomes a generic INTERNAL_ERROR.
function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars -- Express identifies error middleware by its four arguments.
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ApiError) return sendError(res, error.status, error.code, error.message, error.details);
    if (error?.type === "entity.too.large") return sendError(res, 413, "PAYLOAD_TOO_LARGE", "The data is larger than the server accepts.");
    if (error?.type === "entity.parse.failed") return sendError(res, 400, "VALIDATION_ERROR", "The request body is not valid JSON.");
    if (isMongoError(error)) {
      const mapped = translateMongoError(error);
      // Server-side only, and redacted: driver messages can name hosts or contain connection strings.
      if (mapped.status >= 500) logger.error(`[api] ${req.method} ${loggedUrl(req)} database error: ${error.name}${error.code ? ` ${error.code}` : ""} ${redact(error.message)}`);
      return sendError(res, mapped.status, mapped.code, mapped.message);
    }
    if (error?.status >= 400 && error?.status < 500) return sendError(res, error.status, "VALIDATION_ERROR");
    logger.error(`[api] ${req.method} ${loggedUrl(req)} failed:`, error); // server-side only
    return sendError(res, 500, "INTERNAL_ERROR");
  };
}

module.exports = { ApiError, sendError, apiNotFound, errorHandler };
