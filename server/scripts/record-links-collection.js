#!/usr/bin/env node
// recordLinks (Column System plan 17 §4): creates the collection (strict $jsonSchema validator) and its four indexes. Startup
// NEVER creates them (server.js only checks; missing → Connect / Mirror fail closed), so this is the one explicit, approved step.
// Idempotent; never drops, renames or modifies anything: a validator or index that differs is REPORTED and the run stops with
// nothing changed. Never reads server/.env.
//
//   node scripts/record-links-collection.js --dry-run
//        prints the exact definitions (collection, validator, indexes) and exits; no connection.
//   node scripts/record-links-collection.js --dry-run --local --db <name>
//   node scripts/record-links-collection.js --dry-run --uri-env <VARIABLE> --db <name> [--remote-confirm <name>]
//        read-only: also lists what exists and what --apply would create.
//   node scripts/record-links-collection.js --apply  (same connection options)   creates what is missing, then verifies
//   node scripts/record-links-collection.js --verify (same connection options)   read-only check; exit code 1 on any problem
//
//   --local                 the local test instance (.env.migration-test at the repository root, loopback only)
//   --uri-env <VARIABLE>    the connection string is read from that environment variable (never from a file or the command line)
//   --db <name>             the database (required with a connection)
//   --remote-confirm <name> required, and equal to --db, for any host other than 127.0.0.1 / localhost
// Output names the collection, indexes and reasons only; the connection string is never printed.
"use strict";
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const { COLLECTION, VALIDATOR, VALIDATION, INDEXES, sameDefinition, checkRecordLinks, ensureRecordLinks } = require("../src/relations/record-links");

const ROOT = path.resolve(__dirname, "../..");

function definitions() {
  return {
    collection: { name: COLLECTION, options: { validator: VALIDATOR, ...VALIDATION } },
    indexes: INDEXES.map(({ name, key, ...options }) => ({ name, key, options }))
  };
}

// Read-only: what exists and what --apply would do. A drifted validator or index is a conflict (apply refuses, changes nothing).
async function plan(db) {
  const out = { createCollection: false, createIndexes: [], conflicts: [], present: [] };
  const [info] = await db.listCollections({ name: COLLECTION }).toArray();
  if (!info) return { ...out, createCollection: true, createIndexes: INDEXES.map((i) => i.name) };
  const o = info.options || {};
  if (!sameDefinition(o.validator || null, VALIDATOR) || o.validationLevel !== VALIDATION.validationLevel || o.validationAction !== VALIDATION.validationAction) out.conflicts.push("validator-differs");
  else out.present.push(COLLECTION);
  const existing = new Map((await db.collection(COLLECTION).listIndexes().toArray()).map((i) => [i.name, i]));
  for (const i of INDEXES) {
    const e = existing.get(i.name);
    if (!e) out.createIndexes.push(i.name);
    else if (!sameDefinition(e.key, i.key) || Boolean(e.unique) !== Boolean(i.unique)) out.conflicts.push(`index-differs:${i.name}`);
    else out.present.push(i.name);
  }
  return out;
}

async function apply(db) {
  const before = await plan(db);
  if (before.conflicts.length) return { before, created: [], verify: await checkRecordLinks(db), refused: `existing definition differs (${before.conflicts.join(", ")}); nothing was changed` };
  const result = await ensureRecordLinks(db);
  return { before, created: result.created, verify: await checkRecordLinks(db) };
}

function parseArgs(argv) {
  const args = { mode: null, local: false, uriEnv: null, db: null, remoteConfirm: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run" || a === "--apply" || a === "--verify") { if (args.mode) throw new Error("Choose one of --dry-run, --apply, --verify."); args.mode = a.slice(2); }
    else if (a === "--local") args.local = true;
    else if (a === "--uri-env") args.uriEnv = argv[++i];
    else if (a === "--db") args.db = argv[++i];
    else if (a === "--remote-confirm") args.remoteConfirm = argv[++i];
    else throw new Error(`Unknown option ${a}`);
  }
  if (!args.mode) throw new Error("Choose one of --dry-run, --apply, --verify.");
  if (args.local && args.uriEnv) throw new Error("Use --local or --uri-env, not both.");
  if ((args.local || args.uriEnv) && !/^[A-Za-z0-9_-]{1,63}$/.test(args.db || "")) throw new Error("--db <name> is required with a connection.");
  if (args.mode !== "dry-run" && !args.local && !args.uriEnv) throw new Error(`--${args.mode} needs --local or --uri-env <VARIABLE>.`);
  return args;
}

function connectionString(args, env = process.env) {
  let uri;
  if (args.local) {
    const file = path.join(ROOT, ".env.migration-test");
    if (!fs.existsSync(file)) throw new Error("No .env.migration-test (node scripts/migration-test-db.js init).");
    uri = (/^\s*JARC_MIGRATION_TEST_MONGODB_URI\s*=\s*(\S+)/m.exec(fs.readFileSync(file, "utf8")) || [])[1];
  } else uri = env[args.uriEnv];
  if (!uri) throw new Error("No connection string found.");
  let hosts;
  try { hosts = uri.replace(/^mongodb(\+srv)?:\/\//, "").split("@").pop().split("/")[0].split(",").map((h) => h.split(":")[0].toLowerCase()); } catch { throw new Error("The connection string can't be read."); }
  const loopback = hosts.every((h) => h === "127.0.0.1" || h === "localhost");
  if (args.local && !loopback) throw new Error("--local must point at this machine.");
  if (!loopback && args.remoteConfirm !== args.db) throw new Error(`This is not a local database. Repeat the database name with --remote-confirm ${args.db} to continue.`);
  return uri;
}

async function main(argv = process.argv.slice(2), out = (s) => process.stdout.write(`${s}\n`), env = process.env) {
  const args = parseArgs(argv);
  if (args.mode === "dry-run" && !args.local && !args.uriEnv) { out(JSON.stringify(definitions(), null, 2)); return 0; }
  const client = new MongoClient(connectionString(args, env), { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const db = client.db(args.db);
    if (args.mode === "dry-run") { out(JSON.stringify({ database: args.db, definitions: definitions(), plan: await plan(db) }, null, 2)); return 0; }
    if (args.mode === "verify") { const v = await checkRecordLinks(db); out(JSON.stringify({ database: args.db, ok: v.ok, reason: v.reason }, null, 2)); return v.ok ? 0 : 1; }
    const r = await apply(db);
    out(JSON.stringify({ database: args.db, ...r }, null, 2));
    return r.verify.ok && !r.refused ? 0 : 1;
  } finally { await client.close(); }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(`record-links-collection: ${String(error?.message || error).replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>")}\n`); process.exitCode = 1; });
}

module.exports = { definitions, plan, apply, parseArgs, connectionString, main };
