#!/usr/bin/env node
// Public board numbers for boards created before they existed (src/migration/board-public-ids.js). Run it yourself.
//
//   plan  --target local --db DB                        read-only: how many boards need a number, which numbers they'd get
//   apply --target local --db DB                        writes publicId on boards that have none (and the counter), verifies
//   plan  --target production --railway-stdin           the same, read-only
//   apply --target production --railway-stdin --confirm-production
//                                                       writes only boards.publicId and counters.boardPublicId, in
//                                                       jarc_database. Needs its own approval.
//
// Production credentials come from `railway variables --json` on stdin, in memory only, and are never printed. Output:
// counts, numbers and board IDs only — never board names or record contents.
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const command = process.argv[2], args = process.argv.slice(3);
const val = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const log = (m) => process.stdout.write(`${m}\n`);
const stop = (code, m) => { log(`STOPPED: ${m}`); process.exitCode = code; };
const setting = (key) => { const p = path.join(ROOT, ".env.migration-test"); if (!fs.existsSync(p)) return null; const m = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\r\\n]*)`, "m").exec(fs.readFileSync(p, "utf8")); return m ? m[1] : null; };
const LOCAL_DB = /^jarc_migration_test_[a-z0-9_]{1,40}$/;

async function main() {
  if (!["plan", "apply"].includes(command)) return stop(2, "use plan or apply (see the top of this file).");
  const target = val("--target");
  let uri, dbName;
  if (target === "production") {
    if (command === "apply" && !args.includes("--confirm-production")) return stop(3, "LOCKED: a production backfill needs --confirm-production and its own approval. Nothing was contacted.");
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
  const { planBoardPublicIds, applyBoardPublicIds, readOnly } = require("../src/migration/board-public-ids");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, appName: "jarc-board-public-ids" });
  await client.connect();
  try {
    const db = client.db(dbName);
    if (command === "plan") {
      const p = await planBoardPublicIds(readOnly(db)); // reads only: find, findOne, listIndexes (anything else throws)
      log(JSON.stringify({ ...p, order: undefined, _ids: undefined, sample: p.order.slice(0, 5) }, null, 1));
      if (!p.indexReady) log("Note: the unique index isn't there yet; the new server version creates it when it starts.");
      return;
    }
    const r = await applyBoardPublicIds(db, { onProgress: (n) => { if (n % 25 === 0) log(`… ${n}`); } });
    log(JSON.stringify({ assigned: r.assigned, skipped: r.skipped, after: r.after }, null, 1));
    if (r.after.missing) { log("Some boards still have no number (created by a server version that doesn't assign them?). Run again."); process.exitCode = 1; }
  } finally { await client.close(); }
}
main().catch((e) => stop(e.exitCode || 1, String(e.message).replace(/mongodb(\+srv)?:\/\/[^\s"']*/gi, "mongodb://<redacted>")));
