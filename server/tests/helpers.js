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

// Placeholder Microsoft Entra settings for tests (AUTH_MODE=entra). Not real tenant or application IDs, and the
// MongoDB URI points at a reserved, non-existent host.
const TEST_ENTRA = Object.freeze({
  AUTH_MODE: "entra",
  ENTRA_TENANT_ID: "00000000-0000-4000-8000-00000000a001",
  ENTRA_SPA_CLIENT_ID: "00000000-0000-4000-8000-00000000a003",
  ENTRA_REDIRECT_URI: "https://jarc.example.invalid/",
  DATA_STORE: "mongodb",
  MONGODB_URI: "mongodb://db.invalid",
  MONGODB_DB_NAME: "jarc_database"
});
const entraEnv = (overrides = {}) => ({ ...TEST_ENTRA, ...overrides });

// The full stack with Microsoft Entra ID sign-in (AUTH_MODE=entra): ID tokens verified against a local test key set,
// server sessions in the fake MongoDB. No development user exists in this mode.
async function startEntraApp({ issuer, entra = {}, fake = new FakeMongoClient(), accessPolicy } = {}) {
  const { createEntraVerifier } = require("../src/auth/entra-token");
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const logger = { errors: [], error(...args) { this.errors.push(args.map(String).join(" ")); } };
  const dataLayer = createDataLayer({ connection, logger });
  const config = { ...issuer.config, ...entra };
  const verify = createEntraVerifier({ ...config, keySet: issuer.keySet });
  const started = await startApp({ dataLayer, auth: { mode: "entra", entra: config, verify }, logger, ...(accessPolicy ? { accessPolicy } : {}) });
  return { ...started, fake, connection, dataLayer, db: connection.db, logger, entra: config };
}

// A browser-like client for one person: keeps cookies like a browser would (HttpOnly cookies included — they are
// simply sent back), sends Origin, and adds X-CSRF-Token to state-changing requests once signed in.
class SessionClient {
  constructor(base, origin) { this.base = base; this.origin = origin; this.cookies = new Map(); this.csrf = null; this.setCookies = []; }
  async request(method, path, body, { headers = {}, origin = this.origin, csrf = this.csrf } = {}) {
    const init = { method, headers: { ...headers } };
    if (this.cookies.size) init.headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (origin) init.headers.Origin = origin;
    if (csrf && !["GET", "HEAD"].includes(method)) init.headers["X-CSRF-Token"] = csrf;
    if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    const res = await fetch(this.base + path, init);
    for (const line of res.headers.getSetCookie()) {
      this.setCookies.push(line);
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim();
      if (/max-age=0/i.test(line) || !value) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, text };
  }
  // The real flow: nonce → (Microsoft) ID token carrying that nonce → session.
  async signIn(person, { claims = {}, nonce: override } = {}) {
    const start = await this.request("POST", "/api/v1/auth/sign-in/start");
    const nonce = override ?? start.body?.nonce;
    const res = await this.request("POST", "/api/v1/auth/session", { idToken: await person.idToken(nonce, claims) });
    if (res.status === 201) this.csrf = res.body.csrfToken;
    return res;
  }
}

module.exports = { startApp, startMongoApp, startEntraApp, SessionClient, api, validState, entraEnv, TEST_ENTRA };
