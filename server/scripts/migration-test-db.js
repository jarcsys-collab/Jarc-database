#!/usr/bin/env node
// Local, isolated MongoDB for testing the monday.com migration executor (Phase M3). Never touches Atlas, Railway or any
// application database.
//
//   node server/scripts/migration-test-db.js init               create + start the instance, users, guard marker and .env.migration-test
//   node server/scripts/migration-test-db.js start | stop | status | prune   (prune: drop the tests' throwaway databases)
//   node server/scripts/migration-test-db.js create-workspace "Name" [--db jarc_migration_test]
//
// The instance: mongod from JARC_MIGRATION_TEST_MONGOD (default %LOCALAPPDATA%\jarc-migration-test\mongodb\…\bin\mongod.exe),
// bound to 127.0.0.1 only, port 27027, single-node replica set "jarcmigtest" (transactions), authentication on.
// Credentials are random and local: the setup administrator in %LOCALAPPDATA%\jarc-migration-test\admin.json, the
// migration test user in .env.migration-test at the repository root (ignored by Git and Docker). server/.env is never read.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { MongoClient, ObjectId } = require("mongodb");
const { GUARD_DB, GUARD_ID, GUARD_PURPOSE, checkStatic } = require("../src/migration/monday/target");
const { ensureDatabase, COLLECTIONS } = require("../src/db/bootstrap");

const ROOT = path.resolve(__dirname, "../..");
const HOME = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "jarc-migration-test");
const PORT = 27027, RS = "jarcmigtest", HOST = "127.0.0.1";
const ENV_FILE = path.join(ROOT, ".env.migration-test");
const ADMIN_FILE = path.join(HOME, "admin.json");
const log = (m) => process.stdout.write(`${m}\n`);
const secret = () => crypto.randomBytes(24).toString("base64url");

function mongodPath() {
  if (process.env.JARC_MIGRATION_TEST_MONGOD) return process.env.JARC_MIGRATION_TEST_MONGOD;
  const dir = path.join(HOME, "mongodb");
  const found = fs.existsSync(dir) && fs.readdirSync(dir).map((d) => path.join(dir, d, "bin", process.platform === "win32" ? "mongod.exe" : "mongod")).find((p) => fs.existsSync(p));
  if (!found) throw new Error(`mongod not found under ${dir} (set JARC_MIGRATION_TEST_MONGOD)`);
  return found;
}
const portOpen = () => new Promise((resolve) => { const s = net.connect({ host: HOST, port: PORT }); s.once("connect", () => { s.end(); resolve(true); }); s.once("error", () => resolve(false)); });
const waitPort = async (open, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await portOpen()) === open) return true; await new Promise((r) => setTimeout(r, 300)); } return false; };

function readEnvFile() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) { const m = /^\s*(JARC_MIGRATION_TEST_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m) out[m[1]] = m[2]; }
  return out;
}
const adminUri = () => { const a = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8")); return `mongodb://${encodeURIComponent(a.user)}:${encodeURIComponent(a.password)}@${HOST}:${PORT}/?authSource=admin&replicaSet=${RS}&directConnection=true`; };

async function start() {
  if (await portOpen()) { log(`already running on ${HOST}:${PORT}`); return; }
  const data = path.join(HOME, "data"), logs = path.join(HOME, "logs"), keyFile = path.join(HOME, "keyfile");
  for (const d of [data, logs]) fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(48).toString("base64"), { mode: 0o400 });
  const child = spawn(mongodPath(), ["--dbpath", data, "--logpath", path.join(logs, "mongod.log"), "--logappend", "--bind_ip", HOST, "--port", String(PORT), "--replSet", RS, "--auth", "--keyFile", keyFile,
    // Memory-safe: the default WiredTiger cache is ~50% of RAM; a test instance needs very little.
    "--wiredTigerCacheSizeGB", "0.25"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  if (!(await waitPort(true))) throw new Error("mongod did not start; see the log in " + logs);
  log(`started mongod on ${HOST}:${PORT} (pid ${child.pid})`);
}

async function init() {
  fs.mkdirSync(HOME, { recursive: true });
  await start();
  const firstTime = !fs.existsSync(ADMIN_FILE);
  if (firstTime) {
    // Localhost exception: before any user exists, a loopback client may initiate the set and create the first user.
    const bare = new MongoClient(`mongodb://${HOST}:${PORT}/?directConnection=true`, { serverSelectionTimeoutMS: 10000 });
    await bare.connect();
    try { await bare.db("admin").command({ replSetInitiate: { _id: RS, members: [{ _id: 0, host: `${HOST}:${PORT}` }] } }); } catch (e) { if (!/already initialized/i.test(e.message)) throw e; }
    for (let i = 0; i < 60; i += 1) { const h = await bare.db("admin").command({ hello: 1 }); if (h.isWritablePrimary) break; await new Promise((r) => setTimeout(r, 500)); }
    const admin = { user: "jarc_migration_admin", password: secret() };
    await bare.db("admin").command({ createUser: admin.user, pwd: admin.password, roles: [{ role: "root", db: "admin" }] });
    await bare.close();
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(admin), { mode: 0o600 });
    log("created the local setup administrator (credentials kept in the instance folder, outside the repository)");
  }
  const client = new MongoClient(adminUri(), { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  try {
    const env = readEnvFile();
    const user = "jarc_migration_test", password = env.JARC_MIGRATION_TEST_MONGODB_URI ? decodeURIComponent(/:\/\/[^:]+:([^@]+)@/.exec(env.JARC_MIGRATION_TEST_MONGODB_URI)[1]) : secret();
    const exists = (await client.db("admin").command({ usersInfo: user })).users.length;
    if (!exists) await client.db("admin").command({ createUser: user, pwd: password, roles: [{ role: "readWriteAnyDatabase", db: "admin" }] });
    let marker = await client.db(GUARD_DB).collection("instance").findOne({ _id: GUARD_ID });
    if (!marker) { marker = { _id: GUARD_ID, purpose: GUARD_PURPOSE, instanceId: crypto.randomBytes(18).toString("base64url"), createdAt: new Date(), host: os.hostname() }; await client.db(GUARD_DB).collection("instance").insertOne(marker); }
    const uri = `mongodb://${user}:${encodeURIComponent(password)}@${HOST}:${PORT}/?authSource=admin&replicaSet=${RS}&directConnection=true`;
    const problems = checkStatic({ uri, dbName: "jarc_migration_test", instanceId: marker.instanceId });
    if (problems.length) throw new Error(problems.join("; "));
    fs.writeFileSync(ENV_FILE, `# Local migration test instance (Phase M3). Loopback only; not an application database. Ignored by Git and Docker.\nJARC_MIGRATION_TEST_MONGODB_URI=${uri}\nJARC_MIGRATION_TEST_DB=jarc_migration_test\nJARC_MIGRATION_TEST_INSTANCE_ID=${marker.instanceId}\n`, { mode: 0o600 });
    log(`instance ready: replica set ${RS} on ${HOST}:${PORT}; guard marker present; test user configured; ${path.relative(ROOT, ENV_FILE)} written`);
  } finally { await client.close(); }
}

async function stop() {
  if (!(await portOpen())) { log("not running"); return; }
  const client = new MongoClient(adminUri(), { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try { await client.db("admin").command({ shutdown: 1 }); } catch { /* the connection drops on shutdown */ }
  await client.close().catch(() => {});
  log((await waitPort(false)) ? "stopped" : "still running");
}

async function status() {
  if (!(await portOpen())) { log("not running"); return; }
  const env = readEnvFile();
  const client = new MongoClient(env.JARC_MIGRATION_TEST_MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const { verifyTarget } = require("../src/migration/monday/target");
    const t = await verifyTarget({ client, uri: env.JARC_MIGRATION_TEST_MONGODB_URI, dbName: env.JARC_MIGRATION_TEST_DB, instanceId: env.JARC_MIGRATION_TEST_INSTANCE_ID, env: {} });
    log(`verified local test target: ${t.host}, replica set ${t.replicaSet}, MongoDB ${t.serverVersion}, database ${t.dbName}`);
  } finally { await client.close(); }
}

async function createWorkspace(name, dbName) {
  const env = readEnvFile();
  const client = new MongoClient(env.JARC_MIGRATION_TEST_MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const { verifyTarget } = require("../src/migration/monday/target");
    await verifyTarget({ client, uri: env.JARC_MIGRATION_TEST_MONGODB_URI, dbName, instanceId: env.JARC_MIGRATION_TEST_INSTANCE_ID, env: {} });
    const db = client.db(dbName);
    await ensureDatabase(db);
    const now = new Date();
    const doc = { _id: new ObjectId(), name: String(name).slice(0, 200), description: "Local migration test workspace", icon: name.slice(0, 1).toUpperCase(), color: "", archived: false, position: 1000, createdBy: null, createdAt: now, updatedAt: now, version: 1 };
    await db.collection(COLLECTIONS.workspaces).insertOne(doc);
    log(`workspace ${doc._id.toHexString()} created in ${dbName}`);
  } finally { await client.close(); }
}

// Removes the throwaway databases left by the executor tests (jarc_migration_test_t<12 hex>) on THIS local instance,
// using the setup administrator. Never touches jarc_migration_test itself, the guard database or anything else.
async function prune() {
  const client = new MongoClient(adminUri(), { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const marker = await client.db(GUARD_DB).collection("instance").findOne({ _id: GUARD_ID });
    if (marker?.purpose !== GUARD_PURPOSE) throw new Error("this is not the local migration test instance");
    const { databases } = await client.db("admin").command({ listDatabases: 1, nameOnly: true });
    const throwaway = databases.map((d) => d.name).filter((n) => /^jarc_migration_test_t[0-9a-f]{12}$/.test(n));
    for (const name of throwaway) await client.db(name).dropDatabase();
    log(`removed ${throwaway.length} throwaway test database(s)`);
  } finally { await client.close(); }
}

const [cmd, ...rest] = process.argv.slice(2);
const dbArg = rest.includes("--db") ? rest[rest.indexOf("--db") + 1] : "jarc_migration_test";
({ init, start, stop, status, prune, "create-workspace": () => createWorkspace(rest[0] || "monday migration test", dbArg) }[cmd] || (async () => { log("Usage: migration-test-db.js init|start|stop|status|create-workspace NAME [--db DB]"); process.exitCode = 2; }))()
  .catch((e) => { log(`FAILED: ${String(e.message).replace(/mongodb:\/\/[^\s]*/g, "mongodb://<redacted>")}`); process.exitCode = 1; });
