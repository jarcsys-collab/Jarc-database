// Shared test helpers. Tests use an ephemeral port on 127.0.0.1 and never need MongoDB or network access: the
// MongoDB tests run the real connection manager, bootstrap, repositories and services on an in-memory fake client.
const { createApp } = require("../src/app");
const { MemoryStateRepository } = require("../src/repositories/memory-state-repository");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { ensureDevelopmentActor } = require("../src/context/dev-actor");
const { FakeMongoClient } = require("./support/fake-mongo");

async function startApp(options = {}) {
  const logger = { errors: [], error(...args) { this.errors.push(args); } };
  const repository = options.repository || new MemoryStateRepository();
  const app = createApp({ repository, environment: "test", logger, ...options });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, repository, logger, close: () => new Promise((resolve) => server.close(resolve)) };
}

// The smallest document with the shape the frontend saves.
function validState(overrides = {}) {
  return {
    schemaVersion: 1,
    workspaces: [{ id: "operations", name: "Operations", boards: [{ id: "ops-intake", name: "Operations intake", columns: [{ key: "serial", label: "Item", type: "text" }], records: [{ id: 1, serial: "First record" }] }] }],
    members: [],
    currentWorkspaceId: "operations",
    currentBoardId: "ops-intake",
    settings: { density: "comfortable" },
    profile: { name: "Test" },
    notifications: [],
    recentBoards: [],
    ...overrides
  };
}

// The full Stage 10 stack on a fake MongoDB client: connect → bootstrap → data layer → development actor → app.
async function startMongoApp(options = {}) {
  const fake = options.fake || new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const logger = { errors: [], error(...args) { this.errors.push(args.map(String).join(" ")); } };
  const dataLayer = createDataLayer({ connection, logger });
  const devActor = await ensureDevelopmentActor(dataLayer.repos.users, { environment: "test" });
  const started = await startApp({ dataLayer, devActor, logger, ...options.app });
  return { ...started, fake, connection, dataLayer, devActor, db: connection.db, logger };
}

// JSON request helper: returns { status, body, headers }.
async function api(base, method, path, body, { raw } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = raw ? body : JSON.stringify(body); }
  const res = await fetch(base + path, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

module.exports = { startApp, startMongoApp, api, validState };
