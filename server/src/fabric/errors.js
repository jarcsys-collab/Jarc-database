// Fabric Data errors: the API's { error: { code, message, details? } } envelope (middleware/errors.js ApiError). Driver errors
// from the Fabric database are translated here and never reach a client or a log with their text (it can carry filter values).
const { ApiError } = require("../middleware/errors");

const MESSAGES = Object.freeze({
  FABRIC_UNAVAILABLE: "Fabric Data can't be reached right now. Try again in a moment.",
  FABRIC_SOURCE_MISSING: "This Fabric data isn't available right now (it may be being refreshed). Try again in a few minutes.",
  FABRIC_INDEX_REQUIRED: "This part of Fabric Data needs a database index that doesn't exist yet. Ask the data owner to create it.",
  FABRIC_UNSAFE_CREDENTIALS: "Fabric Data is switched off for safety: its database login can do more than read. Ask an administrator to use a read-only login.",
  FABRIC_TIMEOUT: "This took too long. Narrow the date range or add a company filter.",
  FABRIC_BUSY: "Fabric Data is busy with other requests. Try again in a few seconds.",
  FABRIC_RANGE_TOO_LARGE: "This date range has too many rows. Narrow the date range or add a company filter.",
  FABRIC_INVOICE_NOT_FOUND: "This invoice isn't in the Fabric sales data.",
  FABRIC_LINE_NOT_FOUND: "This line is no longer in the source (the data may have been refreshed). Reload the invoice.",
  FABRIC_RECORD_NOT_FOUND: "This record is no longer in the source (the data may have been refreshed)."
});
const STATUS = Object.freeze({ FABRIC_UNAVAILABLE: 503, FABRIC_SOURCE_MISSING: 503, FABRIC_INDEX_REQUIRED: 503, FABRIC_UNSAFE_CREDENTIALS: 503, FABRIC_TIMEOUT: 503, FABRIC_BUSY: 503, FABRIC_RANGE_TOO_LARGE: 422, FABRIC_INVOICE_NOT_FOUND: 404, FABRIC_LINE_NOT_FOUND: 404, FABRIC_RECORD_NOT_FOUND: 404 });

const fabricError = (code, details) => new ApiError(STATUS[code], code, MESSAGES[code], details);
const isFabricError = (error) => error instanceof ApiError && Object.hasOwn(STATUS, error.code);

// MongoDB server codes: 26 NamespaceNotFound, 50 MaxTimeMSExpired, 27 IndexNotFound, 2 BadValue (a hint naming no index).
const NAMESPACE_NOT_FOUND = 26, MAX_TIME_EXPIRED = 50, INDEX_NOT_FOUND = 27, BAD_VALUE = 2;
const isHintError = (error) => error?.code === INDEX_NOT_FOUND || (error?.code === BAD_VALUE && /hint|index/i.test(String(error?.message || "")));

// Any driver or server failure → one of the Fabric codes. `kind` says what to invalidate: "source" or "index" (see indexes.js).
function translateDriverError(error) {
  if (isFabricError(error)) return { error, kind: null };
  if (error?.code === NAMESPACE_NOT_FOUND || error?.codeName === "NamespaceNotFound") return { error: fabricError("FABRIC_SOURCE_MISSING"), kind: "source" };
  // Server time limit (maxTimeMS), or the driver's socket timeout (connection.js) when the server doesn't answer in time.
  if (error?.code === MAX_TIME_EXPIRED || error?.codeName === "MaxTimeMSExpired" || error?.name === "MongoOperationTimeoutError" || error?.name === "MongoNetworkTimeoutError") return { error: fabricError("FABRIC_TIMEOUT"), kind: null };
  // No pooled connection came free in time (waitQueueTimeoutMS).
  if (error?.name === "MongoWaitQueueTimeoutError") return { error: fabricError("FABRIC_BUSY"), kind: null };
  if (isHintError(error)) return { error: fabricError("FABRIC_INDEX_REQUIRED", { missingIndexes: [] }), kind: "index" };
  return { error: fabricError("FABRIC_UNAVAILABLE"), kind: null };
}

// A log-safe description of a driver error: class name and code only, never its message.
const describe = (error) => `${error?.name || "Error"}${error?.code !== undefined ? ` ${error.code}` : ""}${error?.codeName ? ` ${error.codeName}` : ""}`;

module.exports = { fabricError, isFabricError, translateDriverError, describe, MESSAGES };
