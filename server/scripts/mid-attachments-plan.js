#!/usr/bin/env node
// Builds the Machine Installation Database attachment import plan from the LOCAL, Git-ignored migration files. Writes
// nothing anywhere else and contacts nothing.
//
//   node server/scripts/mid-attachments-plan.js [--out monday-migration/mid-attachments-plan.json]
//
// Input:  monday-migration/dry-run/attachments-plan.json (the records migration's file inventory, with the planned JARC
//         record and attachment IDs) and dry-run-report.json (its run ID and destination board).
// Output: one entry per unique file on an item (sub-items and comments carry none of their own: a file attached in a
//         comment is the same file as in its record's "Files from Updates" column, and is listed there once, with the
//         comment IDs kept as provenance). External links (OneDrive) aren't files and aren't included.
// The output holds real business data (file names): it must stay in the Git-ignored monday-migration folder. The JARC
// server re-checks every entry against production before anything is imported.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const args = process.argv.slice(2);
const val = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

function buildPlan(inventory, { sourceRunId, boardId }) {
  const refs = inventory.references || [];
  const comments = new Map();
  for (const r of refs.filter((x) => x.ownerKind === "update")) (comments.get(String(r.assetId)) || comments.set(String(r.assetId), []).get(String(r.assetId))).push(String(r.ownerSourceId));
  const entries = refs.filter((r) => r.ownerKind === "item").map((r) => ({
    assetId: String(r.assetId), sourceItemId: String(r.ownerSourceId), attachmentId: String(r.attachmentId), recordId: String(r.recordId), columnKey: r.columnKey,
    name: r.name, extension: r.extension, sizeBytes: r.sizeBytes, sourceCreatedAt: r.createdAt || null, sourceUploadedBy: r.uploadedBySourceUserId == null ? null : String(r.uploadedBySourceUserId),
    linkedCommentIds: comments.get(String(r.assetId)) || []
  }));
  return { kind: "jarc-mid-attachments-plan", version: 1, sourceRunId, boardId, createdAt: new Date().toISOString(), entries };
}

if (require.main === module) {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, "monday-migration/dry-run/attachments-plan.json"), "utf8"));
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, "monday-migration/dry-run/dry-run-report.json"), "utf8"));
  const sourceRunId = report.runId;
  const boardId = report.destination?.board?.id;
  if (!/^monday-\d+-[0-9a-f]{12}$/.test(String(sourceRunId)) || !/^[0-9a-f]{24}$/.test(String(boardId))) {
    console.log("STOP: couldn't read the records migration's run ID and board ID from dry-run-report.json. Pass --run and --board.");
    if (!val("--run") || !val("--board")) process.exit(2);
  }
  const plan = buildPlan(inventory, { sourceRunId: val("--run", sourceRunId), boardId: val("--board", boardId) });
  const out = path.resolve(ROOT, val("--out", "monday-migration/mid-attachments-plan.json"));
  if (!out.startsWith(path.join(ROOT, "monday-migration") + path.sep)) { console.log("STOP: the plan must be written inside the Git-ignored monday-migration folder."); process.exit(2); }
  fs.writeFileSync(out, `${JSON.stringify(plan, null, 1)}\n`);
  const bytes = plan.entries.reduce((s, e) => s + e.sizeBytes, 0);
  console.log(`plan written: ${path.relative(ROOT, out)} — ${plan.entries.length} files, ${(bytes / 1048576).toFixed(1)} MB, run ${plan.sourceRunId}, board ${plan.boardId}`);
}

module.exports = { buildPlan };
