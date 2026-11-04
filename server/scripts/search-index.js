#!/usr/bin/env node
// Check or repair the record search index (services/record-search-index.js). Run it yourself, from your computer.
//
//   verify  --target local --db DB                 read-only: counts of missing, stale and extra documents
//   rebuild --target local --db DB                 rewrites what differs, then verifies. Writes only recordSearch.
//   verify  --target production --railway-stdin    the same, read-only
//   rebuild --target production --railway-stdin --confirm-production
//                                                  writes only recordSearch, in jarc_database. Needs its own approval.
//
// Production credentials come from `railway variables --json` on stdin, in memory only, and are never printed.
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const command = process.argv[2], args = process.argv.slice(3);
const val = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const log = (m) => process.stdout.write(`${m}\n`);
const stop = (code, m) => { log(`STOPPED: ${m}`); process.exitCode = code; };
const setting = (key) => { const p = path.join(ROOT, ".env.migration-test"); if (!fs.existsSync(p)) return null; const m = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\r\\n]*)`, "m").exec(fs.readFileSync(p, "utf8")); return m ? m[1].trim() : null; };
const LOCAL_DB = /^jarc_migration_test_[a-z0-9_]{1,40}$/;

async function main() {
  if (!["verify", "rebuild"].includes(command)) return stop(2, "use verify or rebuild (see the top of this file).");
  const target = val("--target");
  let uri, dbName;
  if (target === "production") {
    if (command === "rebuild" && !args.includes("--confirm-production")) return stop(3, "LOCKED: a production rebuild needs --confirm-production and its own approval. Nothing was contacted.");
    if (!args.includes("--railway-stdin")) return stop(2, "Production needs --railway-stdin. Nothing was contacted.");
    let s = ""; for await (const chunk of process.stdin) s += chunk;
    const v = JSON.parse(s);
    if (v.MONGODB_DB_NAME !== "jarc_database") return stop(3, "Railway's MONGODB_DB_NAME is not jarc_database.");
    uri = v.MONGODB_URI; dbName = "jarc_database";
  } else if (target === "local") {
    dbName = val("--db");
    if (!LOCAL_DB.test(String(dbName))) return stop(3, "Local databases must be jarc_migration_test_<suffix>.");
    uri = setting("JARC_MIGRATION_TEST_MONGODB_URI");
    if (!uri || !/127\.0\.0\.1|localhost/.test(uri)) return stop(3, "The local test instance isn't configured. Nothing was contacted.");
  } else return stop(3, "--target must be local or production. Nothing was contacted.");
  const { MongoClient } = require("mongodb");
  const { RecordSearchIndex } = require("../src/services/record-search-index");
  const { RecordSearchRepository } = require("../src/repositories/mongo/record-search-repository");
  const { RecordRepository } = require("../src/repositories/mongo/record-repository");
  const { BoardRepository } = require("../src/repositories/mongo/board-repository");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, appName: "jarc-search-index" });
  await client.connect();
  try {
    const db = client.db(dbName), repos = { boards: new BoardRepository(db), records: new RecordRepository(db), recordSearch: new RecordSearchRepository(db) };
    const index = new RecordSearchIndex({ repos, logger: { log() {}, warn: log, error: log }, mode: "on", repairMs: 0 });
    if (command === "verify") {
      const health = await index.verify();
      log(JSON.stringify(health));
      if (health.missing || health.stale || health.extra) process.exitCode = 1;
      return;
    }
    const r = await index.catchUp();
    log(`rewritten ${r.rewritten} · ${JSON.stringify(r.health)}`);
    if (!index.active) process.exitCode = 1;
  } finally { await client.close(); }
}
main().catch((e) => stop(e.exitCode || 1, String(e.message).replace(/mongodb(\+srv)?:\/\/[^\s"']*/gi, "mongodb://<redacted>")));
