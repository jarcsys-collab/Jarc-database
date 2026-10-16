// comments collection: the human conversation about a record (Updates). Separate from activities (the system's
// change log): an activity entry records THAT a comment was posted/edited/deleted, by whom, with IDs only — the text
// lives here.
//   { _id, workspaceId, boardId, recordId, parentId|null, authorId, authorName (snapshot from the session),
//     body (plain text), mentions: [userId], createdAt, updatedAt, editedAt|null, deletedAt|null, deletedBy|null,
//     version }
// Deleting a comment keeps a tombstone (body removed) so replies stay attached to their thread.
const { COLLECTIONS } = require("../../db/bootstrap");

class CommentRepository {
  constructor(db) { this.collection = db.collection(COLLECTIONS.comments); }
  findById(id) { return this.collection.findOne({ _id: id }); }
  insert(doc, { session } = {}) { return this.collection.insertOne(doc, { session }).then(() => doc); }
  listForRecord(recordId, { limit = 500 } = {}) { return this.collection.find({ recordId }, { sort: { createdAt: 1, _id: 1 }, limit }).toArray(); }
  // Command Center search: newest first, bounded by limit and a server time limit (board_created index per board).
  searchPage(filter, { limit, maxTimeMS }) {
    return this.collection.find(filter, { sort: { createdAt: -1, _id: -1 }, limit, maxTimeMS, projection: { _id: 1, workspaceId: 1, boardId: 1, recordId: 1, authorName: 1, body: 1, createdAt: 1 } }).toArray();
  }
  countForRecord(recordId) { return this.collection.countDocuments({ recordId }); }
  // Visible (not deleted) comments per record of a board: { recordIdHex: count }.
  async countsForBoard(boardId) {
    const docs = await this.collection.find({ boardId, deletedAt: null }, { projection: { recordId: 1 } }).toArray();
    const counts = {};
    for (const d of docs) { const k = d.recordId.toHexString(); counts[k] = (counts[k] || 0) + 1; }
    return counts;
  }
  updateVersioned(id, version, set, { session } = {}) {
    return this.collection.findOneAndUpdate({ _id: id, version }, { $set: set, $inc: { version: 1 } }, { returnDocument: "after", session });
  }
  async moveBoard(boardId, workspaceId) { await this.collection.updateMany({ boardId }, { $set: { workspaceId } }); }
  async purge(filter) { if (Object.keys(filter).length) await this.collection.deleteMany(filter); }
}

module.exports = { CommentRepository };
