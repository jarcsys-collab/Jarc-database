// recordSearch collection: one small derived document per record, so global search reads one lower-cased string instead
// of running a regular expression over every searchable cell of every record. Never the source of truth: it can be
// rebuilt from records at any time, and nothing here reads or writes the records collection.
//   { _id: record ID, boardId, archived, updatedAt, name, text, sig }
// recordSearchState: a few small documents about the sync itself (services/record-search-index.js), never record data.
const { COLLECTIONS } = require("../../db/bootstrap");

const duplicate = (e) => e?.code === 11000 || (Array.isArray(e?.writeErrors) && e.writeErrors.length > 0 && e.writeErrors.every((w) => (w.code ?? w.err?.code) === 11000));

// An index document is written only when it is not older than the one stored: the stored updatedAt must be at most
// ours (or absent). When a newer document is already there the filter doesn't match, the upsert's insert collides on
// _id (E11000) and nothing is written, so two writers (two servers, a script) can never put older text over newer.
function guardedUpsert({ _id, ...set }) {
  const filter = set.updatedAt instanceof Date ? { _id, $or: [{ updatedAt: { $lte: set.updatedAt } }, { updatedAt: null }] } : { _id, updatedAt: null };
  return { updateOne: { filter, update: { $set: set }, upsert: true } };
}

// Applies guarded upserts; a collision means "a newer document is already stored" and is skipped. Returns
// { written, skipped: [IDs not written] }. Retried one by one after a collision (each write is idempotent), so the
// result is the same whatever the bulk ordering.
async function writeGuarded(collection, docs) {
  if (!docs.length) return { written: 0, skipped: [] };
  const ops = docs.map(guardedUpsert);
  try { await collection.bulkWrite(ops, { ordered: false }); return { written: docs.length, skipped: [] }; }
  catch (error) {
    if (!duplicate(error)) throw error;
    const skipped = [];
    for (const op of ops) {
      try { await collection.bulkWrite([op], { ordered: true }); } catch (e) { if (!duplicate(e)) throw e; skipped.push(op.updateOne.filter._id); }
    }
    return { written: docs.length - skipped.length, skipped };
  }
}

class RecordSearchRepository {
  constructor(db) { this.collection = db.collection(COLLECTIONS.recordSearch); this.state = db.collection(COLLECTIONS.recordSearchState); }

  // Newest-updated first with a stable _id tie-break, like the records query it replaces; each board branch walks the
  // board_updated index, and the server stops after `limit` documents or maxTimeMS.
  searchPage(clauses, { limit, maxTimeMS }) {
    return this.collection.find({ archived: false, $or: clauses }, { projection: { _id: 1, boardId: 1, updatedAt: 1 }, sort: { updatedAt: -1, _id: -1 }, limit, maxTimeMS }).toArray();
  }

  // What is stored for one board, without the text: enough to find what differs from the records.
  summaries(boardId) { return this.collection.find({ boardId }, { projection: { _id: 1, updatedAt: 1, sig: 1, archived: 1 } }).toArray(); }
  // The same for given record IDs (any board).
  summariesOf(ids) { return ids.length ? this.collection.find({ _id: { $in: ids } }, { projection: { _id: 1, boardId: 1, updatedAt: 1, sig: 1, archived: 1 } }).toArray() : Promise.resolve([]); }

  // Never replaces a newer document with an older one (see guardedUpsert). Returns { written, skipped: [IDs] }.
  upsertMany(docs) { return writeGuarded(this.collection, docs); }

  async removeMany(ids) { if (ids.length) await this.collection.deleteMany({ _id: { $in: ids } }); }
  // Removes documents only if they are still exactly as seen ({ _id, updatedAt }), so one rewritten meanwhile stays.
  async removeUnchanged(seen) {
    if (!seen.length) return 0;
    const r = await this.collection.bulkWrite(seen.map((d) => ({ deleteOne: { filter: { _id: d._id, updatedAt: d.updatedAt ?? null } } })), { ordered: false });
    return r.deletedCount ?? 0;
  }
  async removeBoard(boardId) { await this.collection.deleteMany({ boardId }); }
  count(filter = {}) { return this.collection.countDocuments(filter); }
}

module.exports = { RecordSearchRepository, guardedUpsert, writeGuarded };
