// Backfill of public board numbers for boards created before they existed (domain/board-public-id.js). Used by
// scripts/board-public-ids.js. Safe to stop and run again at any point:
//   - only boards without a number are touched, and only their publicId field ($set where publicId doesn't exist yet):
//     no other field, no record, no version, no _id changes (people editing a board meanwhile aren't affected)
//   - the counter is first raised past every number already in use; numbers come from the same atomic counter the app
//     uses, so a board created while the backfill runs can never get the same number
//   - boards are numbered oldest first (createdAt, then _id); a number allocated for a board that got one meanwhile is
//     simply skipped (a gap), never given twice
//   - nothing runs unless the unique index exists, and nothing runs if the existing numbers are invalid or duplicated
const { COLLECTIONS } = require("../db/bootstrap");
const { COUNTER_ID, BASE, isPublicId, allocateBoardPublicId, raiseCounterTo } = require("../domain/board-public-id");

const INDEX_NAME = "uniq_board_public_id";

// Read-only. Counts and identifiers only (never board names).
async function planBoardPublicIds(db) {
  const boards = await db.collection(COLLECTIONS.boards).find({}, { projection: { _id: 1, publicId: 1, createdAt: 1 } }).toArray();
  const numbered = boards.filter((b) => b.publicId !== undefined), missing = boards.filter((b) => b.publicId === undefined);
  const invalid = numbered.filter((b) => !isPublicId(b.publicId)).map((b) => String(b._id));
  const seen = new Map(); for (const b of numbered) seen.set(b.publicId, (seen.get(b.publicId) || 0) + 1);
  const duplicates = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  const maxExisting = numbered.filter((b) => isPublicId(b.publicId)).reduce((m, b) => Math.max(m, b.publicId), 0);
  const counter = (await db.collection(COLLECTIONS.counters).findOne({ _id: COUNTER_ID }))?.value ?? 0;
  const indexes = await db.collection(COLLECTIONS.boards).listIndexes().toArray();
  const index = indexes.find((i) => i.name === INDEX_NAME);
  const indexReady = Boolean(index && index.unique && JSON.stringify(index.key) === JSON.stringify({ publicId: 1 }));
  missing.sort((a, b) => (new Date(a.createdAt || 0) - new Date(b.createdAt || 0)) || String(a._id).localeCompare(String(b._id)));
  const next = BASE + Math.max(counter, maxExisting ? maxExisting - BASE : 0) + 1;
  // How the boards' _id and createdAt are stored (the backfill writes by the _id exactly as stored, whatever its type).
  const idTypes = {}; for (const b of boards) { const t = b._id?._bsontype === "ObjectId" || b._id?.constructor?.name === "ObjectId" ? "ObjectId" : typeof b._id; idTypes[t] = (idTypes[t] || 0) + 1; }
  const noCreatedAt = boards.filter((b) => !(b.createdAt instanceof Date) || Number.isNaN(b.createdAt.getTime())).length;
  Object.defineProperty(missing, "ids", { value: missing.map((b) => b._id) });
  return {
    boards: boards.length, numbered: numbered.length, missing: missing.length, invalid, duplicates, maxExisting: maxExisting || null, counter, indexReady, idTypes, noCreatedAt,
    firstNumber: missing.length ? next : null, lastNumber: missing.length ? next + missing.length - 1 : null,
    order: missing.map((b) => String(b._id)), _ids: missing.ids
  };
}

// Writes publicId on the boards that have none. Returns { assigned, skipped, before, after }; throws before writing anything
// if the database isn't ready. onProgress(n) after every board.
async function applyBoardPublicIds(db, { onProgress = () => {} } = {}) {
  const before = await planBoardPublicIds(db);
  if (!before.indexReady) throw new Error(`The unique index ${INDEX_NAME} doesn't exist yet: start the new server version once (it creates it), then run this again. Nothing was changed.`);
  if (before.invalid.length || before.duplicates.length) throw new Error(`Existing numbers need attention first (invalid: ${before.invalid.length}, duplicated: ${before.duplicates.length}). Nothing was changed.`);
  await raiseCounterTo(db, before.maxExisting || 0);
  const boards = db.collection(COLLECTIONS.boards);
  let assigned = 0, skipped = 0;
  for (const _id of before._ids) { // the _id exactly as stored (an ObjectId, or anything else)
    const publicId = await allocateBoardPublicId(db);
    const r = await boards.updateOne({ _id, publicId: { $exists: false } }, { $set: { publicId } });
    if (r.matchedCount) assigned += 1; else skipped += 1; // numbered meanwhile, or deleted: that number stays unused
    onProgress(assigned + skipped);
  }
  const after = await planBoardPublicIds(db);
  if (after.duplicates.length || after.invalid.length) throw new Error(`Verification failed after the backfill (duplicated: ${after.duplicates.length}, invalid: ${after.invalid.length}).`);
  return { assigned, skipped, before: { ...before, order: undefined, _ids: undefined }, after: { ...after, order: undefined, _ids: undefined } };
}

// The database as the read-only plan may use it: collection(name) with find, findOne and listIndexes only. Any other call — a
// write, an index, a collection created, a command — throws here, before anything reaches the server.
const READS = new Set(["find", "findOne", "listIndexes"]);
function readOnly(db) {
  return {
    collection(name) {
      const c = db.collection(name);
      return new Proxy({}, { get: (_t, op) => { if (!READS.has(op)) throw new Error(`The read-only plan refused ${String(op)} on ${name}.`); return c[op].bind(c); } });
    }
  };
}

module.exports = { planBoardPublicIds, applyBoardPublicIds, readOnly, INDEX_NAME };
