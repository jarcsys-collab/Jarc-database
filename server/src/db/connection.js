// MongoDB connection manager: one MongoClient per process, connected once, its connection pool reused by every
// request. Only the Express backend talks to MongoDB; the browser never does.
//
// The database is always selected explicitly with client.db(dbName) and must be the JARC database. The connection
// string is never logged; driver error text is redacted before it reaches a log.
const { MongoClient } = require("mongodb");
const { assertJarcDatabaseName } = require("../config");

const CLIENT_OPTIONS = Object.freeze({
  appName: "jarc-database-api",
  maxPoolSize: 20,
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
  retryWrites: true
});
const PING_TIMEOUT_MS = 2000;

class MongoConnection {
  // createClient is replaceable for tests; production always uses the official driver.
  constructor({ uri, dbName, createClient = (connectionString, options) => new MongoClient(connectionString, options), logger = console }) {
    assertJarcDatabaseName(dbName); // second guard after config: never another application's database
    if (!uri) throw new Error("MongoConnection needs a connection string.");
    Object.defineProperty(this, "uri", { value: uri, enumerable: false }); // kept out of logs and inspection
    this.dbName = dbName;
    this.createClient = createClient;
    this.logger = logger;
    this.client = null;
    this.database = null;
    this.connecting = null;
  }

  // Connects once. Concurrent callers share the same attempt; a failed attempt can be retried later.
  connect() {
    if (this.database) return Promise.resolve(this.database);
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = this.createClient(this.uri, CLIENT_OPTIONS);
        try {
          await client.connect();
        } catch (error) {
          await client.close().catch(() => {});
          throw new DatabaseConnectionError(error);
        }
        this.client = client;
        this.database = client.db(this.dbName);
        return this.database;
      })().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  get db() {
    if (!this.database) throw new Error("The database is not connected yet.");
    return this.database;
  }

  get isConnected() { return Boolean(this.database); }

  // Readiness check: true when the database answers a ping within a short time.
  async ping() {
    if (!this.database) return false;
    let timer;
    try {
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS); });
      const ping = this.database.command({ ping: 1 }).then((reply) => reply?.ok === 1, () => false);
      return await Promise.race([ping, timeout]);
    } finally { clearTimeout(timer); }
  }

  // Runs fn(session) inside a transaction (Atlas is a replica set, so transactions are available). The driver may
  // retry fn on transient errors, so fn must only depend on its inputs.
  async withTransaction(fn) {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(() => fn(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } finally {
      await session.endSession();
    }
  }

  async close() {
    const client = this.client;
    this.client = null;
    this.database = null;
    if (client) await client.close();
  }
}

// A startup connection failure, with a message that is safe to log (no connection string, user name or password).
class DatabaseConnectionError extends Error {
  constructor(cause) {
    super(`Could not connect to MongoDB (${cause?.name || "Error"}${cause?.code ? ` ${cause.code}` : ""}): ${redact(cause?.message || "")}`);
    this.name = "DatabaseConnectionError";
  }
}

// Removes connection strings and credentials from text before it is logged.
function redact(text) {
  return String(text)
    .replace(/mongodb(\+srv)?:\/\/[^\s"'<>]*/gi, "mongodb://<redacted>")
    .replace(/\/\/[^\s/@:"'<>]+:[^\s/@"'<>]+@/g, "//<redacted>@")
    .slice(0, 500);
}

module.exports = { MongoConnection, DatabaseConnectionError, redact, CLIENT_OPTIONS };
