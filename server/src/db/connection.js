// MongoDB connection manager: one MongoClient per process, connected once, its connection pool reused by every
// request. Only the Express backend talks to MongoDB; the browser never does.
//
// The database is always selected explicitly with client.db(dbName) and must be the JARC database. The connection
// string is never logged; driver error text is redacted before it reaches a log.
const { MongoClient } = require("mongodb");
const { assertJarcDatabaseName } = require("../config");
const { monitor: defaultMonitor } = require("../monitoring/monitor");

const CLIENT_OPTIONS = Object.freeze({
  appName: "jarc-database-api",
  maxPoolSize: 20,
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
  retryWrites: true
});
const PING_TIMEOUT_MS = 2000;
// Commands still waiting for their reply, for slow-command monitoring. More than this in flight and the rest go untimed.
const IN_FLIGHT_LIMIT = 1000;

// Slow MongoDB commands (Q1.1): the driver's command monitoring reports each command's duration. Only the command name
// ("find", "aggregate") and its collection name are kept — never a filter, a pipeline, a document or a reply.
function watchCommands(client, monitor) {
  if (typeof client?.on !== "function") return;
  const started = new Map();
  client.on("commandStarted", (e) => {
    if (started.size >= IN_FLIGHT_LIMIT) return;
    const target = e.command?.[e.commandName];
    started.set(e.requestId, typeof target === "string" ? target : null);
  });
  const done = (ok) => (e) => {
    const collection = started.get(e.requestId) ?? null;
    started.delete(e.requestId);
    monitor.recordCommand({ command: e.commandName, collection, ms: Number(e.duration) || 0, ok, code: ok ? null : e.failure?.codeName || e.failure?.code || e.failure?.name || null });
  };
  client.on("commandSucceeded", done(true));
  client.on("commandFailed", done(false));
}

class MongoConnection {
  // createClient is replaceable for tests; production always uses the official driver.
  // monitor: where command timings go (null: no command monitoring).
  constructor({ uri, dbName, createClient = (connectionString, options) => new MongoClient(connectionString, options), logger = console, monitor = defaultMonitor }) {
    assertJarcDatabaseName(dbName); // second guard after config: never another application's database
    if (!uri) throw new Error("MongoConnection needs a connection string.");
    Object.defineProperty(this, "uri", { value: uri, enumerable: false }); // kept out of logs and inspection
    this.dbName = dbName;
    this.createClient = createClient;
    this.logger = logger;
    this.client = null;
    this.database = null;
    this.connecting = null;
    this.monitor = monitor;
  }

  // Connects once. Concurrent callers share the same attempt; a failed attempt can be retried later.
  connect() {
    if (this.database) return Promise.resolve(this.database);
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = this.createClient(this.uri, this.monitor ? { ...CLIENT_OPTIONS, monitorCommands: true } : CLIENT_OPTIONS);
        if (this.monitor) watchCommands(client, this.monitor);
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

  // Ping round trip in milliseconds, or null when the database doesn't answer (System Health).
  async pingMs() {
    const started = process.hrtime.bigint();
    return (await this.ping()) ? Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10 : null;
  }

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

module.exports = { MongoConnection, DatabaseConnectionError, redact, CLIENT_OPTIONS, watchCommands };
