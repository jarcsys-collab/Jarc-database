#!/usr/bin/env node
// Reconciles the record search index (recordSearch) with the records, which are the source of truth. Run it yourself,
// from your computer; every production run needs the owner's approval (see JARC-Search-Plan/RECONCILIATION-RUNBOOK.md).
//
//   node scripts/record-search-reconcile.js --target local --db jarc_migration_test_x            DRY RUN (the default)
//   node scripts/record-search-reconcile.js --target local --db jarc_migration_test_x --apply
//   railway variables --json | node scripts/record-search-reconcile.js --target production --railway-stdin          dry run
//   railway variables --json | node scripts/record-search-reconcile.js --target production --railway-stdin --apply --confirm-production
//
//   --max-ops N   operations per second, at most (default 250, refused above 450: Atlas Flex allows 500)
//   --batch N     records per batch (default 200, 50–500)
//   --restart     ignore a stored checkpoint and start from the beginning (--apply only; dry runs never store one)
//   --start-phase records|orphans --start-after <24-hex>   a dry run's own resume point (printed in every progress line
//                 and in RESULT; a dry run's counts then cover only the part it read)
//   --uri         local only: a loopback mongodb:// URI instead of .env.migration-test
//
// What it does, in two phases, each walking a collection by _id (the _id index: no sort in memory, no full scan at once):
//   records  200 records at a time ({_id, boardId, updatedAt, archived}); their index summaries by _id; each is missing,
//            stale (column signature, updatedAt, archived or board differ) or current. --apply rewrites missing and stale
//            ones from the full records, keyed by record _id (an upsert: a duplicate can't be created) and never over a
//            newer index document (the write is conditional on the stored updatedAt; see record-search-repository.js).
//   orphans  200 index documents at a time; those whose record doesn't exist are orphans. --apply re-reads those records
//            right before deleting, and deletes an index document only if it is still exactly as seen.
// Archived records keep their index document (marked archived): archived-record search uses it.
// Never drops, truncates or empties a collection; never writes records; writes only recordSearch and recordSearchState.
// Resumable: --apply stores a checkpoint (phase, last _id, counts) in recordSearchState after every batch; a re-run
// continues from it. Idempotent: a second --apply over a clean index writes nothing.
// When an --apply run completes, it records the baseline the server's incremental catch-up builds on.
// Output: counts only (never record text, names or connection strings).
"use strict";
const fs = require("fs");
const path = require("path");
const { planOf, searchDocument, differs, STATE_ID, MARGIN_MS } = require("../src/services/record-search-index");
const { writeGuarded } = require("../src/repositories/mongo/record-search-repository");
const { COLLECTIONS } = require("../src/db/bootstrap");

const CHECKPOINT_ID = "reconcile";
const hex = (id) => id.toHexString();
const time = (d) => d?.getTime?.() ?? null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// At most `perSecond` operations per second, spread evenly (a batch of n operations waits until it fits).
function rateLimiter(perSecond, { clock = Date.now, wait = sleep } = {}) {
  let nextAt = 0, total = 0;
  return {
    async take(n = 1) { const now = clock(); if (nextAt > now) await wait(nextAt - now); nextAt = Math.max(now, nextAt) + (n * 1000) / perSecond; total += n; },
    get total() { return total; }
  };
}

const zero = () => ({ records: 0, current: 0, missing: 0, stale: 0, noBoard: 0, written: 0, skippedNewer: 0, indexDocs: 0, orphans: 0, removed: 0, keptOnRecheck: 0 });

// db: a connected database. Returns { counts, done, phase, after }. stopAfterBatches / shouldStop() stop between batches
// (tests: an interruption; the command line: Ctrl+C). startPhase/startAfter: a dry run's resume point.
async function reconcile({ db, apply = false, batch = 200, maxOps = 250, restart = false, startPhase = "records", startAfter = null, log = () => {}, progressEvery = 25, stopAfterBatches = null, shouldStop = () => false, now = () => new Date(), limiter = rateLimiter(maxOps) }) {
  const stopNow = (batches) => (stopAfterBatches && batches >= stopAfterBatches) || shouldStop();
  if (!(batch >= 1 && batch <= 500)) throw new Error("batch must be 1–500");
  if (!(maxOps > 0 && maxOps <= 450)) throw new Error("--max-ops must be above 0 and at most 450 (Atlas Flex allows 500 operations per second)");
  const col = (n) => db.collection(COLLECTIONS[n]);
  const records = col("records"), index = col("recordSearch"), state = col("recordSearchState");
  const op = (n = 1) => limiter.take(n);
  let ck = null;
  if (apply && !restart) { await op(); ck = await state.findOne({ _id: CHECKPOINT_ID }); if (ck?.status !== "running") ck = null; }
  const run = ck ? { phase: ck.phase, after: ck.after ?? null, counts: { ...zero(), ...ck.counts }, startedAt: ck.startedAt } : { phase: startPhase === "orphans" ? "orphans" : "records", after: startAfter, counts: zero(), startedAt: now() };
  if (ck) log(`resuming from the stored checkpoint: phase ${run.phase}${run.after ? ` after ${hex(run.after)}` : ""}`);
  const save = async (extra = {}) => { if (!apply) return; await op(); await state.updateOne({ _id: CHECKPOINT_ID }, { $set: { status: "running", phase: run.phase, after: run.after, counts: run.counts, startedAt: run.startedAt, updatedAt: now(), ...extra } }, { upsert: true }); };
  await save();

  // Boards: all, small ({_id, columns}); re-read once when a record names one not seen yet (created meanwhile).
  const boards = new Map();
  const loadBoards = async () => { await op(); for (const b of await col("boards").find({}, { projection: { _id: 1, columns: 1 } }).toArray()) boards.set(hex(b._id), { board: b, plan: planOf(b) }); };
  await loadBoards();
  let batches = 0, reloaded = false;
  const c = run.counts;
  const progress = () => log(`${run.phase}: ${JSON.stringify(c)} after=${run.after ? hex(run.after) : "-"} ops=${limiter.total}`);

  while (run.phase === "records") {
    await op();
    const rows = await records.find(run.after ? { _id: { $gt: run.after } } : {}, { projection: { _id: 1, boardId: 1, updatedAt: 1, archived: 1 }, sort: { _id: 1 }, limit: batch }).toArray();
    if (!rows.length) { run.phase = "orphans"; run.after = null; await save(); break; }
    if (!reloaded && rows.some((r) => r.boardId && !boards.has(hex(r.boardId)))) { await loadBoards(); reloaded = true; }
    await op();
    const stored = new Map((await index.find({ _id: { $in: rows.map((r) => r._id) } }, { projection: { _id: 1, boardId: 1, updatedAt: 1, sig: 1, archived: 1 } }).toArray()).map((d) => [hex(d._id), d]));
    const fix = [];
    for (const r of rows) {
      c.records += 1;
      const b = r.boardId && boards.get(hex(r.boardId));
      if (!b) { c.noBoard += 1; continue; } // a record of a board that is gone: not searchable, left alone
      const s = stored.get(hex(r._id));
      if (!s) { c.missing += 1; fix.push(r._id); } else if (differs(s, r, b.plan.sig, r.boardId)) { c.stale += 1; fix.push(r._id); } else c.current += 1;
    }
    if (apply && fix.length) {
      await op();
      const full = await records.find({ _id: { $in: fix } }).toArray(); // read again now: the newest version is written
      const docs = full.filter((r) => boards.has(hex(r.boardId))).map((r) => searchDocument(r, boards.get(hex(r.boardId)).plan));
      await op(docs.length);
      const { written, skipped } = await writeGuarded(index, docs);
      c.written += written;
      // Skipped: a newer-looking index document is stored. Replaced only if the record itself still has the updatedAt we
      // wrote (it went backwards: a direct database edit) and the stored document is unchanged meanwhile.
      if (skipped.length) {
        await op(2);
        const live = new Map((await records.find({ _id: { $in: skipped } }).toArray()).map((r) => [hex(r._id), r]));
        const now2 = new Map((await index.find({ _id: { $in: skipped } }, { projection: { _id: 1, updatedAt: 1 } }).toArray()).map((d) => [hex(d._id), d]));
        for (const d of docs.filter((x) => skipped.some((id) => id.equals(x._id)))) {
          const r = live.get(hex(d._id)), s = now2.get(hex(d._id));
          if (r && s && time(r.updatedAt) === time(d.updatedAt) && boards.has(hex(r.boardId))) { const { _id, ...set } = searchDocument(r, boards.get(hex(r.boardId)).plan); await op(); const u = await index.updateOne({ _id, updatedAt: s.updatedAt ?? null }, { $set: set }); if (u.modifiedCount) { c.written += 1; continue; } }
          c.skippedNewer += 1;
        }
      }
    }
    run.after = rows.at(-1)._id;
    await save();
    batches += 1;
    if (batches % progressEvery === 0) progress();
    if (stopNow(batches)) { progress(); return { counts: c, done: false, phase: run.phase, after: run.after }; }
    if (rows.length < batch) { run.phase = "orphans"; run.after = null; await save(); }
  }

  while (run.phase === "orphans") {
    await op();
    const docs = await index.find(run.after ? { _id: { $gt: run.after } } : {}, { projection: { _id: 1, updatedAt: 1 }, sort: { _id: 1 }, limit: batch }).toArray();
    if (!docs.length) break;
    c.indexDocs += docs.length;
    await op();
    const live = new Set((await records.find({ _id: { $in: docs.map((d) => d._id) } }, { projection: { _id: 1 } }).toArray()).map((r) => hex(r._id)));
    const orphans = docs.filter((d) => !live.has(hex(d._id)));
    c.orphans += orphans.length;
    if (apply && orphans.length) {
      await op();
      const back = new Set((await records.find({ _id: { $in: orphans.map((d) => d._id) } }, { projection: { _id: 1 } }).toArray()).map((r) => hex(r._id)));
      const gone = orphans.filter((d) => !back.has(hex(d._id)));
      c.keptOnRecheck += orphans.length - gone.length;
      if (gone.length) { await op(gone.length); c.removed += (await index.bulkWrite(gone.map((d) => ({ deleteOne: { filter: { _id: d._id, updatedAt: d.updatedAt ?? null } } })), { ordered: false })).deletedCount ?? 0; }
    }
    run.after = docs.at(-1)._id;
    await save();
    batches += 1;
    if (batches % progressEvery === 0) progress();
    if (stopNow(batches)) { progress(); return { counts: c, done: false, phase: run.phase, after: run.after }; }
    if (docs.length < batch) break;
  }

  run.phase = "done";
  if (apply) {
    await save({ status: "done", finishedAt: now() });
    // The baseline: everything changed before this run started (minus the margin) has been compared. The server's
    // incremental catch-up continues from there; a watermark already earlier is kept.
    const watermark = new Date(new Date(run.startedAt).getTime() - MARGIN_MS);
    await op(2);
    await state.updateOne({ _id: STATE_ID }, { $set: { baselineAt: now(), baselineBy: "record-search-reconcile" } }, { upsert: true });
    await state.updateOne({ _id: STATE_ID, $or: [{ watermark: { $exists: false } }, { watermark: null }, { watermark: { $gt: watermark } }] }, { $set: { watermark } });
  }
  progress();
  return { counts: c, done: true, phase: "done", after: null };
}

// ---- Command line.
const ROOT = path.resolve(__dirname, "../..");
const LOCAL_DB = /^jarc_migration_test_[a-z0-9_]{1,40}$/;
// A local URI names exactly one loopback host: no seed list (a "," anywhere in the host part), no SRV, nothing else.
function isLoopbackUri(uri) {
  const m = /^mongodb:\/\/([^/?#]*)(?:[/?#]|$)/.exec(String(uri || ""));
  if (!m) return false;
  const host = m[1].slice(m[1].lastIndexOf("@") + 1);
  return /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host);
}
async function main(argv = process.argv.slice(2), out = (m) => process.stdout.write(`${m}\n`), input = process.stdin) {
  const val = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const stop = (code, m) => { out(`STOPPED: ${m}`); process.exitCode = code; };
  const setting = (key) => { const p = path.join(ROOT, ".env.migration-test"); if (!fs.existsSync(p)) return null; const m = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\r\\n]*)`, "m").exec(fs.readFileSync(p, "utf8")); return m ? m[1].trim() : null; };
  const apply = argv.includes("--apply"), target = val("--target");
  const maxOps = Number(val("--max-ops", 250)), batch = Number(val("--batch", 200));
  if (!(maxOps > 0 && maxOps <= 450)) return stop(2, "--max-ops must be above 0 and at most 450. Nothing was contacted.");
  if (!(batch >= 50 && batch <= 500)) return stop(2, "--batch must be 50–500. Nothing was contacted.");
  const startAfterHex = val("--start-after");
  if (startAfterHex && (!/^[0-9a-f]{24}$/.test(startAfterHex) || apply)) return stop(2, "--start-after takes a 24-hex ID and is for dry runs only (--apply resumes from its own checkpoint).");
  let uri, dbName;
  if (target === "production") {
    if (apply && !argv.includes("--confirm-production")) return stop(3, "LOCKED: a production --apply needs --confirm-production and the owner's approval. Nothing was contacted.");
    if (!argv.includes("--railway-stdin")) return stop(2, "Production needs --railway-stdin. Nothing was contacted.");
    let s = ""; for await (const chunk of input) s += chunk;
    // Never echo the input (JSON.parse's message quotes part of it, and it holds secrets): a fixed message only.
    let v; try { v = JSON.parse(s); } catch { v = null; }
    s = "";
    if (!v || typeof v !== "object" || Array.isArray(v)) return stop(2, "Railway variables were not valid JSON. Nothing was contacted.");
    if (v.MONGODB_DB_NAME !== "jarc_database") return stop(3, "Railway's MONGODB_DB_NAME is not jarc_database.");
    uri = v.MONGODB_URI; dbName = "jarc_database";
  } else if (target === "local") {
    dbName = val("--db");
    if (!LOCAL_DB.test(String(dbName))) return stop(3, "Local databases must be jarc_migration_test_<suffix>.");
    uri = val("--uri") || setting("JARC_MIGRATION_TEST_MONGODB_URI");
    if (!isLoopbackUri(uri)) return stop(3, "The local test instance isn't configured (loopback only). Nothing was contacted.");
  } else return stop(3, "--target must be local or production. Nothing was contacted.");
  const { MongoClient, ObjectId } = require("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, appName: "jarc-search-reconcile" });
  await client.connect();
  let interrupted = false;
  const onSignal = () => { interrupted = true; out("Stopping after the current batch (the checkpoint is kept; re-run to continue)."); };
  process.once("SIGINT", onSignal);
  try {
    const db = client.db(dbName);
    out(`${apply ? "APPLY" : "DRY RUN"} on ${target} (${dbName}); at most ${maxOps} operations/s, ${batch} per batch.`);
    const started = Date.now(), limiter = rateLimiter(maxOps);
    const result = await reconcile({ db, apply, batch, maxOps, limiter, restart: argv.includes("--restart"), startPhase: val("--start-phase", "records"), startAfter: startAfterHex ? new ObjectId(startAfterHex) : null, log: out, shouldStop: () => interrupted });
    out(`RESULT ${JSON.stringify({ apply, done: result.done, phase: result.phase, after: result.after ? hex(result.after) : null, seconds: Math.round((Date.now() - started) / 1000), ops: limiter.total, ...result.counts })}`);
    if (!result.done) process.exitCode = 4;
    else if (!apply && (result.counts.missing || result.counts.stale || result.counts.orphans)) process.exitCode = 1;
  } finally { process.removeListener("SIGINT", onSignal); await client.close(); }
}

if (require.main === module) main().catch((e) => { process.stdout.write(`STOPPED: ${e.name || "Error"}${e.code ? ` ${e.code}` : ""}: ${String(e.message).replace(/mongodb(\+srv)?:\/\/[^\s"']*/gi, "mongodb://<redacted>")}\n`); process.exitCode = 1; });

module.exports = { reconcile, rateLimiter, main, isLoopbackUri, CHECKPOINT_ID };
