// Employee Management errors: the API's { error: { code, message, details? } } envelope. Messages never echo a value, a field
// name the caller may not use, the source collection, the database or driver text.
const { ApiError } = require("../middleware/errors");

const MESSAGES = Object.freeze({
  EMPLOYEES_FORBIDDEN: "You don't have access to Employee Management. Ask the JARC owner if you need it.",
  EMPLOYEES_UNAVAILABLE: "The people directory can't be read right now. Try again in a few minutes.",
  NOT_FOUND: "Not found.",
  RATE_LIMITED: "Too many Employee Management requests. Wait a few seconds and try again."
});
const STATUS = Object.freeze({ EMPLOYEES_FORBIDDEN: 403, EMPLOYEES_UNAVAILABLE: 503, NOT_FOUND: 404, RATE_LIMITED: 429 });
const employeeError = (code) => new ApiError(STATUS[code], code, MESSAGES[code]);
const invalid = (message, path, reason) => new ApiError(400, "VALIDATION_ERROR", message, path === undefined ? undefined : { path, reason });

// A log-safe description of a driver error: class name and code only, never its message.
const describe = (error) => `${error?.name || "Error"}${error?.code !== undefined ? ` ${String(error.code).slice(0, 40)}` : ""}${error?.codeName ? ` ${String(error.codeName).slice(0, 40)}` : ""}`;

module.exports = { employeeError, invalid, describe, MESSAGES };
