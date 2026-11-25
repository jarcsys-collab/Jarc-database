// The read-only directory source connection: a MongoClient of its own (appName jarc-employees, pool of 2), apart from JARC's
// MongoConnection and from any other client in the process (no shared pool or in-flight limit). It reuses only the connection
// string and database name of FABRIC_MONGODB_URI / FABRIC_MONGODB_DB_NAME; permissions never come from there.
//
// Read-only by construction and by check: on first connect, connectionStatus { showPrivileges } must report only the role
// read@<database> and only read actions (the same check, privilegesAreReadOnly, that guards the other read-only source). Anything
// more and the connection is closed and stays "unsafe" until the server restarts. Exactly ONE collection can be opened: the
// configured EMPLOYEE_DIRECTORY_COLLECTION. Nothing lists collections. Connected lazily, never part of /health/ready.
const { MongoClient } = require("mongodb");
const { privilegesAreReadOnly } = require("../fabric/connection");
const { employeeError, describe } = require("./errors");

const CLIENT_OPTIONS = Object.freeze({ appName: "jarc-employees", readPreference: "secondaryPreferred", retryWrites: false, retryReads: true, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000, minPoolSize: 0, maxIdleTimeMS: 5 * 60 * 1000, waitQueueTimeoutMS: 2000 });
const RETRY_AFTER_MS = 10000; // after a failed attempt, fail fast for this long

class EmployeeSourceConnection {
  constructor({ uri, dbName, collection, poolSize = 2, queryTimeMs = 8000, logger = console, createClient = (cs, options) => new MongoClient(cs, options), now = Date.now }) {
    if (!uri || !dbName || !collection) throw new Error("EmployeeSourceConnection needs a connection string, a database and a collection name.");
    Object.defineProperty(this, "uri", { value: uri, enumerable: false });
    Object.defineProperty(this, "collectionName", { value: collection, enumerable: false }); // kept out of inspection and logs
    this.dbName = dbName;
    this.poolSize = poolSize;
    this.queryTimeMs = queryTimeMs;
    this.logger = logger;
    this.createClient = createClient;
    this.now = now;
    this.client = null; this.database = null; this.connecting = null;
    this.state = "idle"; // idle | ready | unavailable | unsafe | closed
    this.failedAt = 0;
  }

  async db() {
    if (this.state === "unsafe" || this.state === "closed") throw employeeError("EMPLOYEES_UNAVAILABLE");
    if (this.database) return this.database;
    if (this.state === "unavailable" && this.now() - this.failedAt < RETRY_AFTER_MS) throw employeeError("EMPLOYEES_UNAVAILABLE");
    this.connecting ??= this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async open() {
    const client = this.createClient(this.uri, { ...CLIENT_OPTIONS, maxPoolSize: this.poolSize, socketTimeoutMS: this.queryTimeMs + 2000 });
    try { await client.connect(); } catch (error) {
      await client.close?.().catch(() => {});
      this.state = "unavailable"; this.failedAt = this.now();
      this.logger.warn?.(`[employees] directory source unreachable: ${describe(error)}`);
      throw employeeError("EMPLOYEES_UNAVAILABLE");
    }
    const database = client.db(this.dbName);
    let reply = null;
    try { reply = await database.command({ connectionStatus: 1, showPrivileges: true }); } catch (error) { this.logger.warn?.(`[employees] privilege check failed: ${describe(error)}`); }
    if (!privilegesAreReadOnly(reply, this.dbName)) {
      await client.close?.().catch(() => {});
      this.state = "unsafe"; this.failedAt = this.now();
      this.logger.error?.("[employees] the directory source login is not read-only (or its privileges couldn't be checked). Employee Management stays unavailable until the server restarts with a read-only login.");
      throw employeeError("EMPLOYEES_UNAVAILABLE");
    }
    this.client = client; this.database = database; this.state = "ready";
    return database;
  }

  // The configured directory collection, never any other.
  async collection() { return (await this.db()).collection(this.collectionName); }

  // After a failed query: drop the client so the next attempt reconnects (unless unsafe).
  async reset() {
    const client = this.client;
    this.client = null; this.database = null;
    if (this.state === "ready") { this.state = "unavailable"; this.failedAt = this.now(); }
    if (client) await client.close?.().catch(() => {});
  }

  status() { return { state: this.state }; }

  async close() {
    const client = this.client;
    this.client = null; this.database = null;
    if (this.state !== "unsafe") this.state = "closed";
    if (client) await client.close?.().catch(() => {});
  }
}

module.exports = { EmployeeSourceConnection, CLIENT_OPTIONS };
