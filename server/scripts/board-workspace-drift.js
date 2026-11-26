#!/usr/bin/env node
// READ-ONLY drift check (P4-0, F10): records, attachments and comments whose copied workspaceId differs from their board's.
// Drift is harmless for access (auth/access.js authorizes by the board's workspace), but it shows that a board move's
// alignment didn't finish. This script only READS and prints counts (never record text, names or connection strings).
//
// SPEC FOR LATER APPROVAL: written for P4-0, not run against production. A production run, and any repair, needs the
// owner's explicit approval. The repair, once approved, is BoardSchemaService.reconcileWorkspace(boardId) per board listed
// here (bounded, idempotent batches; services/board-workspace-sync.js).
//
//   node scripts/board-workspace-drift.js --uri mongodb://127.0.0.1:27017 --db jarc_migration_test_x     loopback only
//
// The same check as a mongosh query (read-only), for an approved production check:
//   db.boards.find({}, { _id: 1, workspaceId: 1 }).forEach((b) => {
//     const n = ["records", "attachments", "comments"].map((c) => db[c].countDocuments({ boardId: b._id, workspaceId: { $ne: b.workspaceId } }));
//     if (n.some((x) => x)) printjson({ board: b._id, records: n[0], attachments: n[1], comments: n[2] });
//   });
// Cost: one boards read (projected) plus 3 countDocuments per board, each on a boardId-prefixed index (records
// board_position, attachments board_status, comments board_live); no collection scan.
"use strict";

const COPIES = ["records", "attachments", "comments"];

// db: a connected database. Returns { boards, drifted: [{ boardId, records, attachments, comments }], totals }.
async function detectDrift(db, { maxTimeMS = 30000 } = {}) {
  const boards = await db.collection("boards").find({}, { projection: { _id: 1, workspaceId: 1 } }).toArray();
  const drifted = [], totals = Object.fromEntries(COPIES.map((c) => [c, 0]));
  for (const b of boards) {
    const row = { boardId: b._id.toHexString() };
    for (const c of COPIES) row[c] = await db.collection(c).countDocuments({ boardId: b._id, workspaceId: { $ne: b.workspaceId } }, { maxTimeMS });
    if (COPIES.some((c) => row[c])) { drifted.push(row); for (const c of COPIES) totals[c] += row[c]; }
  }
  return { boards: boards.length, drifted, totals };
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const uri = arg("--uri"), dbName = arg("--db");
  if (!uri || !dbName) throw new Error("Usage: --uri mongodb://127.0.0.1:<port> --db <name>");
  // Loopback only: production needs an approved runbook (use the mongosh query above under that approval).
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(uri)) throw new Error("Refused: this script only connects to a loopback MongoDB.");
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(uri, { readPreference: "secondaryPreferred" });
  try {
    await client.connect();
    const result = await detectDrift(client.db(dbName));
    console.log(JSON.stringify({ boards: result.boards, driftedBoards: result.drifted.length, totals: result.totals, drifted: result.drifted }, null, 2));
  } finally { await client.close(); }
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { detectDrift };
