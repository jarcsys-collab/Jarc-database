// Maps MongoDB driver and server errors to the API error contract. Raw MongoServerError text (which can contain
// collection names, index names and duplicate values) never reaches a client.
const { MongoError, MongoNetworkError, MongoServerSelectionError, MongoTopologyClosedError, MongoNotConnectedError, MongoOperationTimeoutError } = require("mongodb");

const DUPLICATE_KEY = new Set([11000, 11001]);
// Primary stepped down, shutting down, exceeded time limit, network-ish server states: worth retrying later.
const UNAVAILABLE_CODES = new Set([6, 7, 50, 89, 91, 189, 262, 9001, 10107, 11600, 11602, 13435, 13436]);

function isMongoError(error) { return error instanceof MongoError; }

// Returns { status, code, message } for any MongoDB error.
function translateMongoError(error) {
  if (DUPLICATE_KEY.has(error.code)) return { status: 409, code: "CONFLICT", message: "This item already exists." };
  if (error instanceof MongoNetworkError || error instanceof MongoServerSelectionError || error instanceof MongoTopologyClosedError
    || error instanceof MongoNotConnectedError || error instanceof MongoOperationTimeoutError
    || UNAVAILABLE_CODES.has(error.code) || error.hasErrorLabel?.("TransientTransactionError")) {
    return { status: 503, code: "SERVICE_UNAVAILABLE", message: "The database is temporarily unavailable. Try again in a moment." };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "Something went wrong on the server." };
}

module.exports = { isMongoError, translateMongoError };
