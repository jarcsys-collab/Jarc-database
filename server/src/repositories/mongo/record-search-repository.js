// recordSearch collection: one small derived document per record, so global search reads one lower-cased string instead
// of running a regular expression over every searchable cell of every record. Never the source of truth: it can be
// rebuilt from records at any time, and nothing here reads or writes the records collection.
//   { _id: record ID, boardId, archived, updatedAt, name, text, sig }
const { COLLECTIONS } = require("../../db/bootstrap");

class RecordSearchRepository {
  constructor(db) { this.collection = db.collection(COLLECTIONS.recordSearch); }

  // Newest-updated first with a stable _id tie-break, like the records query it replaces; each board branch walks the
  // board_updated index, and the server stops after `limit` documents or maxTimeMS.
  searchPage(clauses, { limit, maxTimeMS }) {
    return this.collection.find({ archived: false, $or: clauses }, { projection: { _id: 1, boardId: 1, updatedAt: 1 }, sort: { updatedAt: -1, _id: -1 }, limit, maxTimeMS }).toArray();
  }

  // What is stored for one board, without the text: enough to find what differs from the records.
  summaries(boardId) { return this.collection.find({ boardId }, { projection: { _id: 1, updatedAt: 1, sig: 1, archived: 1 } }).toArray(); }

  async upsertMany(docs) {
    if (!docs.length) return 0;
    await this.collection.bulkWrite(docs.map(({ _id, ...set }) => ({ updateOne: { filter: { _id }, update: { $set: set }, upsert: true } })), { ordered: false });
    return docs.length;
  }

  async removeMany(ids) { if (ids.length) await this.collection.deleteMany({ _id: { $in: ids } }); }
  async removeBoard(boardId) { await this.collection.deleteMany({ boardId }); }
  count(filter = {}) { return this.collection.countDocuments(filter); }
}

module.exports = { RecordSearchRepository };
