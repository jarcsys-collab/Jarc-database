// Error contract (Stage 7): every API error response is { "error": { "code", "message" } }.
// Responses never include stack traces, file paths, dependency internals or raw exception text.

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.name = "ApiError"; this.status = status; this.code = code; }
}

const SAFE_MESSAGES = Object.freeze({
  VALIDATION_ERROR: "The request is not valid.",
  NOT_FOUND: "This API endpoint does not exist.",
  PAYLOAD_TOO_LARGE: "The request is too large.",
  INTERNAL_ERROR: "Something went wrong on the server."
});

function sendError(res, status, code, message) {
  res.status(status).set("Cache-Control", "no-store").json({ error: { code, message: message || SAFE_MESSAGES[code] || SAFE_MESSAGES.INTERNAL_ERROR } });
}

// JSON 404 for any unknown /api/v1 path, so API calls never receive index.html.
function apiNotFound(req, res) { sendError(res, 404, "NOT_FOUND"); }

// Final error middleware. Known errors keep their code; everything else becomes a generic INTERNAL_ERROR.
function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars -- Express identifies error middleware by its four arguments.
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ApiError) return sendError(res, error.status, error.code, error.message);
    if (error?.type === "entity.too.large") return sendError(res, 413, "PAYLOAD_TOO_LARGE", "The data is larger than the server accepts.");
    if (error?.type === "entity.parse.failed") return sendError(res, 400, "VALIDATION_ERROR", "The request body is not valid JSON.");
    if (error?.status >= 400 && error?.status < 500) return sendError(res, error.status, "VALIDATION_ERROR");
    logger.error(`[api] ${req.method} ${req.originalUrl} failed:`, error); // server-side only
    return sendError(res, 500, "INTERNAL_ERROR");
  };
}

module.exports = { ApiError, sendError, apiNotFound, errorHandler };
