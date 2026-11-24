// The Fabric Data connection: a MongoClient of its own for the separate Fabric database, apart from JARC's MongoConnection (no
// shared pool, no command monitoring, not part of /health/ready). Connected lazily, on the first Fabric request, so JARC starts
// and serves normally whether or not Fabric is reachable.
//
// Read-only by construction and by check: on first connect, connectionStatus { showPrivileges } must report only the role
// read@<database> and only read actions. Anything more and the connection is closed and stays "unsafe" until the server restarts:
// every call throws FABRIC_UNSAFE_CREDENTIALS. Never required from src/domain/* or src/workers/* (worker threads stay light).
const { MongoClient } = require("mongodb");
const { COLLECTIONS } = require("./datasets");
const { fabricError, describe } = require("./errors");

const CLIENT_OPTIONS = Object.freeze({ appName: "jarc-fabric", readPreference: "secondaryPreferred", retryWrites: false, retryReads: true, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000, minPoolSize: 0, maxIdleTimeMS: 5 * 60 * 1000 });
// What the built-in read role grants (and a few harmless monitoring actions). Anything else makes the login unsafe.
const READ_ACTIONS = new Set(["find", "listCollections", "listIndexes", "listSearchIndexes", "collStats", "dbStats", "dbHash", "killCursors", "changeStream", "planCacheRead", "listDatabases", "connPoolStats", "serverStatus", "indexStats"]);
const PING_TIMEOUT_MS = 2000;
// After a failed connection attempt, requests fail fast for this long instead of each waiting for server selection.
const RETRY_AFTER_MS = 10000;
// Driver-side limits, so no request waits on Fabric for long whatever the server does: a socket that stays silent for
// queryTimeMs + this margin is dropped (FABRIC_TIMEOUT; the server's own maxTimeMS normally ends the query first), and a
// request that can't get a pooled connection within WAIT_QUEUE_TIMEOUT_MS fails (FABRIC_BUSY). Not CSOT (timeoutMS): every
// query already sets maxTimeMS itself, and the driver doesn't combine the two cleanly (explain refuses both together).
const SOCKET_MARGIN_MS = 2000;
const WAIT_QUEUE_TIMEOUT_MS = 2000;
const clientOptions = (poolSize, queryTimeMs) => ({ ...CLIENT_OPTIONS, maxPoolSize: poolSize, socketTimeoutMS: queryTimeMs + SOCKET_MARGIN_MS, waitQueueTimeoutMS: WAIT_QUEUE_TIMEOUT_MS });

// Whether connectionStatus shows a read-only login for dbName: exactly the role read@dbName and only read actions.
function privilegesAreReadOnly(reply, dbName) {
  const info = reply?.authInfo;
  const roles = info?.authenticatedUserRoles;
  if (!Array.isArray(roles) || !roles.length) return false;
  if (roles.some((r) => r?.role !== "read" || r?.db !== dbName)) return false;
  const privileges = info.authenticatedUserPrivileges;
  if (!Array.isArray(privileges)) return false;
  return privileges.every((p) => Array.isArray(p?.actions) && p.actions.every((a) => READ_ACTIONS.has(a)));
}

class FabricConnection {
  // createClient is replaceable for tests; production always uses the official driver.
  constructor({ uri, dbName, poolSize = 5, queryTimeMs = 8000, logger = console, createClient = (connectionString, options) => new MongoClient(connectionString, options), now = Date.now }) {
    if (!uri || !dbName) throw new Error("FabricConnection needs a connection string and a database name.");
    Object.defineProperty(this, "uri", { value: uri, enumerable: false }); // kept out of logs and inspection
    this.dbName = dbName;
    this.poolSize = poolSize;
    this.queryTimeMs = queryTimeMs;
    this.logger = logger;
    this.createClient = createClient;
    this.now = now;
    this.client = null;
    this.database = null;
    this.connecting = null;
    this.state = "idle"; // idle | ready | unavailable | unsafe | closed
    this.failedAt = 0;
    this.checkedAt = null;
  }

  // The connected, privilege-checked database. Concurrent callers share one attempt.
  async db() {
    if (this.state === "unsafe") throw fabricError("FABRIC_UNSAFE_CREDENTIALS");
    if (this.state === "closed") throw fabricError("FABRIC_UNAVAILABLE");
    if (this.database) return this.database;
    if (this.state === "unavailable" && this.now() - this.failedAt < RETRY_AFTER_MS) throw fabricError("FABRIC_UNAVAILABLE");
    this.connecting ??= this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async open() {
    const client = this.createClient(this.uri, clientOptions(this.poolSize, this.queryTimeMs));
    try {
      await client.connect();
    } catch (error) {
      await client.close().catch(() => {});
      this.fail("unavailable");
      this.logger.warn?.(`[fabric] could not connect: ${describe(error)}`); // never the URI, host or driver text
      throw fabricError("FABRIC_UNAVAILABLE");
    }
    const database = client.db(this.dbName);
    let reply = null;
    try { reply = await database.command({ connectionStatus: 1, showPrivileges: true }); } catch (error) { this.logger.warn?.(`[fabric] privilege check failed: ${describe(error)}`); }
    this.checkedAt = new Date(this.now());
    if (!privilegesAreReadOnly(reply, this.dbName)) {
      await client.close().catch(() => {});
      this.fail("unsafe");
      this.logger.error?.("[fabric] the Fabric database login is not read-only (or its privileges couldn't be checked). Fabric Data stays off until the server restarts with a read-only login.");
      throw fabricError("FABRIC_UNSAFE_CREDENTIALS");
    }
    this.client = client;
    this.database = database;
    this.state = "ready";
    return database;
  }

  fail(state) { this.state = state; this.failedAt = this.now(); this.checkedAt ??= new Date(this.now()); }

  // One of the datasets' collections (datasets.js), never any other name; collections are never listed.
  async collection(name) {
    if (!COLLECTIONS.includes(name)) throw new Error("fabric connection: not a Fabric dataset collection.");
    return (await this.db()).collection(name);
  }

  // true when Fabric answers a ping within a short time (never part of JARC's readiness).
  async ping() {
    let timer;
    try {
      const database = await this.db();
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS); });
      return await Promise.race([database.command({ ping: 1 }).then((r) => r?.ok === 1, () => false), timeout]);
    } catch { return false; } finally { clearTimeout(timer); }
  }

  status() { return { state: this.state, checkedAt: this.checkedAt ? this.checkedAt.toISOString() : null }; }

  async close() {
    const client = this.client;
    this.client = null; this.database = null;
    if (this.state !== "unsafe") this.state = "closed";
    if (client) await client.close().catch(() => {});
  }
}

module.exports = { FabricConnection, privilegesAreReadOnly, clientOptions, READ_ACTIONS, CLIENT_OPTIONS };
