// Stage 10 foundation: MongoDB configuration, the shared-cluster database guard, the connection manager, the
// idempotent bootstrap and MongoDB error translation. No real database or network access is needed.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const util = require("util");
const { MongoServerError, MongoNetworkError, MongoServerSelectionError } = require("mongodb");
const { loadConfig, assertJarcDatabaseName, JARC_DB_NAME } = require("../src/config");
const { MongoConnection, redact, CLIENT_OPTIONS } = require("../src/db/connection");
const { ensureDatabase, INDEXES, COLLECTIONS } = require("../src/db/bootstrap");
const { translateMongoError } = require("../src/db/errors");
const { FakeMongoClient } = require("./support/fake-mongo");
const { entraEnv } = require("./helpers");

// Placeholder values only: these strings are never real credentials and nothing connects to them.
const URI = "mongodb+srv://jarc_app:placeholder-not-a-secret@cluster.invalid/?retryWrites=true";
// The driver builds this error with a topology description; tests pass a minimal one.
const selectionError = (message) => new MongoServerSelectionError(message, { type: "Unknown", servers: new Map(), error: null });
const mongoEnv = (extra = {}) => ({ DATA_STORE: "mongodb", MONGODB_URI: URI, MONGODB_DB_NAME: "jarc_database", ...extra });

describe("MongoDB configuration", () => {
  test("memory is the default data store; MongoDB settings are optional then", () => {
    const config = loadConfig({});
    assert.equal(config.dataStore, "memory");
    assert.equal(config.mongo, null);
    assert.equal(config.enableDevResourceApi, false);
  });

  test("DATA_STORE=mongodb with both variables: database jarc_database, resource API outside production", () => {
    const config = loadConfig(mongoEnv());
    assert.equal(config.dataStore, "mongodb");
    assert.equal(config.mongo.dbName, "jarc_database");
    assert.equal(config.mongo.uri, URI);
    assert.equal(config.enableDevResourceApi, true);
  });

  test("DATA_STORE=mongodb fails clearly when MONGODB_URI or MONGODB_DB_NAME is missing, naming only the variables", () => {
    assert.throws(() => loadConfig({ DATA_STORE: "mongodb" }), (e) => e.name === "ConfigError" && /MONGODB_URI and MONGODB_DB_NAME/.test(e.message));
    assert.throws(() => loadConfig({ DATA_STORE: "mongodb", MONGODB_DB_NAME: "jarc_database" }), /needs MONGODB_URI/);
    assert.throws(() => loadConfig({ DATA_STORE: "mongodb", MONGODB_URI: URI }), (e) => /needs MONGODB_DB_NAME/.test(e.message) && !e.message.includes("placeholder"));
  });

  test("an unknown DATA_STORE is rejected", () => {
    assert.throws(() => loadConfig({ DATA_STORE: "postgres" }), /DATA_STORE must be one of: memory, mongodb/);
  });

  test("DATABASE SAFETY: MONGODB_DB_NAME=receipt_flow is rejected (shared cluster)", () => {
    assert.throws(() => loadConfig(mongoEnv({ MONGODB_DB_NAME: "receipt_flow" })), (e) => e.name === "ConfigError" && /must be exactly "jarc_database"/.test(e.message));
    // Rejected even when MongoDB is not the selected data store, so the wrong name can never reach the driver.
    assert.throws(() => loadConfig({ MONGODB_DB_NAME: "receipt_flow" }), /must be exactly "jarc_database"/);
  });

  test("DATABASE SAFETY: any other database name is rejected; only jarc_database is accepted", () => {
    for (const name of ["Receipt_Flow", "jarc_database_dev", "JARC_DATABASE", "jarc-database", " jarc_database", "admin", "local", "test", "config"]) {
      assert.throws(() => loadConfig(mongoEnv({ MONGODB_DB_NAME: name })), /must be exactly "jarc_database"/, name);
      assert.throws(() => assertJarcDatabaseName(name), /jarc_database/, name);
    }
    assert.equal(JARC_DB_NAME, "jarc_database");
    assert.doesNotThrow(() => assertJarcDatabaseName("jarc_database"));
  });

  test("DATABASE SAFETY: a connection string naming another database in its path is rejected", () => {
    assert.throws(() => loadConfig(mongoEnv({ MONGODB_URI: "mongodb+srv://u:p@cluster.invalid/receipt_flow?retryWrites=true" })), /names a different database/);
    assert.throws(() => loadConfig(mongoEnv({ MONGODB_URI: "mongodb://u:p@h1.invalid,h2.invalid/admin" })), /names a different database/);
    assert.doesNotThrow(() => loadConfig(mongoEnv({ MONGODB_URI: "mongodb+srv://u:p@cluster.invalid/jarc_database?retryWrites=true" })));
    assert.doesNotThrow(() => loadConfig(mongoEnv({ MONGODB_URI: "mongodb://127.0.0.1:27017" })));
  });

  test("a value that isn't a MongoDB connection string is rejected without echoing it", () => {
    for (const uri of ["https://secret-host.invalid/db", "secret-host.invalid:27017", "mongodb://"]) {
      assert.throws(() => loadConfig(mongoEnv({ MONGODB_URI: uri })), (e) => /mongodb:\/\/ or mongodb\+srv:\/\//.test(e.message) && !e.message.includes("secret-host"));
    }
  });

  test("the connection string is kept out of JSON and console output of the config", () => {
    const config = loadConfig(mongoEnv());
    assert.doesNotMatch(JSON.stringify(config), /placeholder-not-a-secret|mongodb\+srv/);
    assert.doesNotMatch(util.inspect(config, { depth: 5 }), /placeholder-not-a-secret|mongodb\+srv/);
  });

  test("production with MongoDB: the pre-auth resource API and state API are disabled", () => {
    const config = loadConfig({ ...mongoEnv({ NODE_ENV: "production" }), ...entraEnv() }); // Stage 12: production requires Entra ID
    assert.equal(config.enableDevResourceApi, false);
    assert.equal(config.enableDevStateApi, false);
    assert.equal(config.mongo.dbName, "jarc_database");
  });
});

describe("Connection manager", () => {
  const make = (fake, extra = {}) => new MongoConnection({ uri: URI, dbName: "jarc_database", createClient: (uri, options) => { make.last = { uri, options }; return fake; }, ...extra });

  test("creates one client, connects once, and reuses it (concurrent callers share the attempt)", async () => {
    const fake = new FakeMongoClient();
    let created = 0;
    const connection = new MongoConnection({ uri: URI, dbName: "jarc_database", createClient: () => { created += 1; return fake; } });
    const [a, b] = await Promise.all([connection.connect(), connection.connect()]);
    await connection.connect();
    assert.equal(created, 1);
    assert.equal(fake.connectCalls, 1);
    assert.equal(a, b);
    assert.equal(connection.db, a);
    assert.equal(connection.isConnected, true);
  });

  test("always selects jarc_database explicitly, with pooled client options", async () => {
    const fake = new FakeMongoClient();
    const connection = make(fake);
    await connection.connect();
    assert.deepEqual(fake.requestedDbNames, ["jarc_database"]);
    assert.equal(connection.db.databaseName, "jarc_database");
    assert.equal(make.last.options.maxPoolSize, CLIENT_OPTIONS.maxPoolSize);
    assert.equal(make.last.options.appName, "jarc-database-api");
  });

  test("refuses another database even if config checks were bypassed", () => {
    assert.throws(() => new MongoConnection({ uri: URI, dbName: "receipt_flow", createClient: () => new FakeMongoClient() }), /jarc_database/);
  });

  test("the connection string is not visible on the connection object", async () => {
    const connection = make(new FakeMongoClient());
    await connection.connect();
    assert.doesNotMatch(JSON.stringify(Object.keys(connection)), /uri/);
    assert.doesNotMatch(util.inspect(connection, { depth: 0 }), /placeholder-not-a-secret/);
  });

  test("a failed connection gives a safe error, closes the client, and can be retried", async () => {
    const fake = new FakeMongoClient({ connectError: selectionError(`getaddrinfo ENOTFOUND for ${URI}`) });
    const connection = make(fake);
    await assert.rejects(connection.connect(), (e) => e.name === "DatabaseConnectionError" && !e.message.includes("placeholder-not-a-secret") && !e.message.includes("jarc_app") && /<redacted>/.test(e.message));
    assert.equal(fake.closeCalls, 1);
    assert.equal(connection.isConnected, false);
    fake.connectError = null;
    await connection.connect();
    assert.equal(connection.isConnected, true);
  });

  test("ping reports readiness and never throws", async () => {
    const fake = new FakeMongoClient();
    const connection = make(fake);
    assert.equal(await connection.ping(), false); // not connected yet
    await connection.connect();
    assert.equal(await connection.ping(), true);
    fake.down = true;
    assert.equal(await connection.ping(), false);
  });

  test("graceful shutdown closes the pool once and is safe to repeat", async () => {
    const fake = new FakeMongoClient();
    const connection = make(fake);
    await connection.connect();
    await connection.close();
    await connection.close();
    assert.equal(fake.closeCalls, 1);
    assert.equal(connection.isConnected, false);
    assert.throws(() => connection.db, /not connected/);
  });

  test("redact removes connection strings and inline credentials", () => {
    const text = redact(`failed for ${URI} and //user:pass@host.invalid`);
    assert.doesNotMatch(text, /placeholder-not-a-secret|jarc_app|user:pass/);
    assert.match(text, /mongodb:\/\/<redacted>/);
  });
});

describe("Database bootstrap", () => {
  const connect = async (fake = new FakeMongoClient()) => { const c = new MongoConnection({ uri: URI, dbName: "jarc_database", createClient: () => fake }); await c.connect(); return { db: c.db, fake }; };

  test("creates the six collections and the documented indexes", async () => {
    const { db } = await connect();
    const result = await ensureDatabase(db);
    // Stage 12C added sessions and loginAttempts (server-side Entra sign-in sessions).
    assert.deepEqual(result.createdCollections.sort(), ["activities", "boards", "loginAttempts", "records", "sessions", "users", "workspaceMembers", "workspaces"]);
    assert.deepEqual(Object.values(COLLECTIONS).sort(), result.createdCollections.sort());
    const names = async (c) => (await db.collection(c).listIndexes().toArray()).map((i) => i.name).sort();
    assert.deepEqual(await names("workspaceMembers"), ["_id_", "uniq_workspace_user", "user_status"]);
    const members = (await db.collection("workspaceMembers").listIndexes().toArray()).find((i) => i.name === "uniq_workspace_user");
    assert.deepEqual(members.key, { workspaceId: 1, userId: 1 });
    assert.equal(members.unique, true);
    const records = await db.collection("records").listIndexes().toArray();
    assert.ok(records.some((i) => JSON.stringify(i.key) === JSON.stringify({ boardId: 1, position: 1, _id: 1 })));
    assert.ok(records.some((i) => JSON.stringify(i.key) === JSON.stringify({ workspaceId: 1, boardId: 1 })));
    const activities = await db.collection("activities").listIndexes().toArray();
    assert.ok(activities.some((i) => JSON.stringify(i.key) === JSON.stringify({ workspaceId: 1, createdAt: -1 })));
    assert.ok(activities.some((i) => JSON.stringify(i.key) === JSON.stringify({ boardId: 1, createdAt: -1 })));
    assert.ok((await db.collection("boards").listIndexes().toArray()).some((i) => i.key.workspaceId === 1));
    const users = (await db.collection("users").listIndexes().toArray()).find((i) => i.name === "uniq_entra_identity");
    assert.deepEqual(users.key, { tenantId: 1, entraObjectId: 1 });
    assert.equal(users.unique, true);
  });

  test("no index on individual flexible values (values.*)", () => {
    for (const specs of Object.values(INDEXES)) for (const spec of specs) for (const key of Object.keys(spec.key)) assert.doesNotMatch(key, /^values\./);
  });

  test("is idempotent: a second and third run create nothing, keep data, and never drop or delete", async () => {
    const { db } = await connect();
    await ensureDatabase(db);
    await db.collection("workspaces").insertOne({ name: "Existing", legacyId: "keep-me" });
    const again = await ensureDatabase(db);
    await ensureDatabase(db);
    assert.deepEqual(again.createdCollections, []);
    assert.equal((await db.collection("workspaces").find({}).toArray()).length, 1);
    const ops = [...db.collections.values()].flatMap((c) => c.calls.map((call) => call.op));
    assert.ok(!ops.some((op) => /delete|drop|update/i.test(op)), `unexpected operations: ${[...new Set(ops)]}`);
    assert.equal((await db.collection("records").listIndexes().toArray()).length, 1 + INDEXES.records.length);
  });

  test("a conflicting existing index stops startup instead of being replaced", async () => {
    const { db } = await connect();
    await db.createCollection("records");
    await db.collection("records").createIndex({ boardId: 1 }, { name: "board_position" });
    await assert.rejects(ensureDatabase(db), (e) => e.code === 85);
  });

  test("the membership unique index rejects a duplicate workspace + user", async () => {
    const { db } = await connect();
    await ensureDatabase(db);
    const membership = { workspaceId: "w", userId: "u", role: "MEMBER" };
    await db.collection("workspaceMembers").insertOne({ ...membership });
    await assert.rejects(db.collection("workspaceMembers").insertOne({ ...membership }), (e) => e.code === 11000);
  });
});

describe("MongoDB error translation", () => {
  test("duplicate key → 409 CONFLICT without index or value details", () => {
    const mapped = translateMongoError(new MongoServerError({ message: "E11000 duplicate key error collection: jarc_database.workspaces index: uniq_legacy_id dup key: { legacyId: \"ops\" }", code: 11000 }));
    assert.deepEqual(mapped, { status: 409, code: "CONFLICT", message: "This item already exists." });
  });
  test("network, server selection and transient errors → 503 SERVICE_UNAVAILABLE", () => {
    assert.equal(translateMongoError(new MongoNetworkError("socket hang up")).code, "SERVICE_UNAVAILABLE");
    assert.equal(translateMongoError(selectionError("Server selection timed out")).status, 503);
    assert.equal(translateMongoError(new MongoServerError({ message: "not primary", code: 10107 })).code, "SERVICE_UNAVAILABLE");
    assert.equal(translateMongoError(new MongoServerError({ message: "conflict", code: 112, errorLabels: ["TransientTransactionError"] })).code, "SERVICE_UNAVAILABLE");
  });
  test("anything else → 500 INTERNAL_ERROR with a generic message", () => {
    const mapped = translateMongoError(new MongoServerError({ message: "Unrecognized expression '$foo' at jarc_database.records", code: 168 }));
    assert.deepEqual(mapped, { status: 500, code: "INTERNAL_ERROR", message: "Something went wrong on the server." });
  });
});
