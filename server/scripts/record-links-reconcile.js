#!/usr/bin/env node
// recordLinks (Column System plan 17 §4, doc 25 §4 / §10): integrity verification and safe backfill / repair FROM THE CELLS (the
// Connect cells are the source of truth; the index is derived and rebuildable). Never reads server/.env; never changes a cell.
//
//   node scripts/record-links-reconcile.js --report  (--board <id> | --all) <connection>   read-only diff per board (default mode)
//   node scripts/record-links-reconcile.js --verify  (--board <id> | --all) <connection>   read-only; exit code 1 unless the index is
//        ready (collection, validator, 4 indexes) AND every board's diff is 0 — the activation gate check
//   node scripts/record-links-reconcile.js --apply   (--board <id> | --all) <connection>   backfill / repair: each drifted record is
//        re-read and repaired under compare-and-set in its own transaction (RecordLinkService.reconcile), paced between batches
//
//   <connection>  --local --db <name>  |  --uri-env <VARIABLE> --db <name> [--remote-confirm <name>]  (as record-links-collection.js)
//   --pause-ms <n>  pause between batches of 200 records (default 800; Atlas Flex pacing)
// Fails closed: if the index isn't ready nothing is written (exit 1; create it first with record-links-collection.js --apply).
// Output: board IDs and counts only — never values, names or link IDs.
"use strict";
const { MongoClient, ObjectId } = require("mongodb");
const { checkRecordLinks, RecordLinkService } = require("../src/relations/record-links");
const { connectionString } = require("./record-links-collection");

function parseArgs(argv) {
  const args = { mode: null, local: false, uriEnv: null, db: null, remoteConfirm: null, board: null, all: false, pauseMS: 800 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--report" || a === "--apply" || a === "--verify") { if (args.mode) throw new Error("Choose one of --report, --verify, --apply."); args.mode = a.slice(2); }
    else if (a === "--local") args.local = true;
    else if (a === "--uri-env") args.uriEnv = argv[++i];
    else if (a === "--db") args.db = argv[++i];
    else if (a === "--remote-confirm") args.remoteConfirm = argv[++i];
    else if (a === "--board") args.board = argv[++i];
    else if (a === "--all") args.all = true;
    else if (a === "--pause-ms") args.pauseMS = Number(argv[++i]);
    else throw new Error(`Unknown option ${a}`);
  }
  args.mode = args.mode || "report";
  if (args.local === Boolean(args.uriEnv)) throw new Error("Use --local or --uri-env <VARIABLE>.");
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(args.db || "")) throw new Error("--db <name> is required.");
  if (Boolean(args.board) === args.all) throw new Error("Choose --board <id> or --all.");
  if (args.board && !/^[0-9a-f]{24}$/.test(args.board)) throw new Error("--board must be a board ID.");
  if (!Number.isInteger(args.pauseMS) || args.pauseMS < 0 || args.pauseMS > 60000) throw new Error("--pause-ms must be 0–60000.");
  return args;
}

// → { ready, reason, boards: [{ boardId, scanned, missing, extra }], total: { missing, extra }, ok }
async function run(db, connection, { mode, board, pauseMS = 0 }) {
  const ready = await checkRecordLinks(db);
  if (!ready.ok) return { ready: false, reason: ready.reason, boards: [], total: { missing: 0, extra: 0 }, ok: false };
  const filter = { "columns.type": "connect", ...(board ? { _id: new ObjectId(board) } : {}) };
  const boards = await db.collection("boards").find(filter, { projection: { _id: 1, columns: 1 } }).sort({ _id: 1 }).toArray();
  const links = new RecordLinkService({ db, connection: mode === "apply" ? connection : null });
  const out = [];
  for (const b of boards) {
    if (mode === "apply") await links.reconcile(b, { apply: true, pauseMS });
    const r = await links.reconcile(b, { pauseMS: mode === "apply" ? pauseMS : 0 });
    out.push({ boardId: b._id.toHexString(), scanned: r.scanned, missing: r.missing, extra: r.extra });
  }
  const total = out.reduce((t, r) => ({ missing: t.missing + r.missing, extra: t.extra + r.extra }), { missing: 0, extra: 0 });
  return { ready: true, reason: null, boards: out, total, ok: total.missing === 0 && total.extra === 0 };
}

async function main(argv = process.argv.slice(2), out = (s) => process.stdout.write(`${s}\n`), env = process.env) {
  const args = parseArgs(argv);
  const client = new MongoClient(connectionString(args, env), { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const db = client.db(args.db);
    const connection = { withTransaction: async (fn) => { const s = client.startSession(); try { return await s.withTransaction(() => fn(s), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }); } finally { await s.endSession(); } } };
    const result = await run(db, connection, { mode: args.mode, board: args.board, pauseMS: args.pauseMS });
    out(JSON.stringify({ database: args.db, mode: args.mode, ...result }, null, 2));
    if (!result.ready) return 1;
    return args.mode === "report" ? 0 : result.ok ? 0 : 1;
  } finally { await client.close(); }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(`record-links-reconcile: ${String(error?.message || error).replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>")}\n`); process.exitCode = 1; });
}

module.exports = { parseArgs, run, main };
