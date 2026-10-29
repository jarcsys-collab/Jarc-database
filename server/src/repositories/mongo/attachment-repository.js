// attachments collection: one document per uploaded file (Files columns). The file's bytes are in GridFS under the
// same _id. This collection is the source of truth for which files a record has; record values never hold files.
//
//   { _id, workspaceId, boardId, recordId, columnKey, name, type, size, sha256, uploadKey?, status: "pending"|"ready",
//     uploadedBy, uploadedByName, createdAt, readyAt }
// "pending" documents belong to uploads in progress (or interrupted ones, removed by the sweep); only "ready" ones are
// ever listed or served.
const { COLLECTIONS } = require("../../db/bootstrap");

class AttachmentRepository {
  constructor(db) { this.collection = db.collection(COLLECTIONS.attachments); }

  insertPending(doc) { return this.collection.insertOne({ ...doc, status: "pending" }); }
  async markReady(id, fields) { await this.collection.updateOne({ _id: id, status: "pending" }, { $set: { ...fields, status: "ready" } }); }
  findById(id) { return this.collection.findOne({ _id: id }); }
  // Object-storage files are found by where their bytes are (GridFS bytes share the document's _id).
  findByStorageKey(provider, key) { return this.collection.findOne({ "storage.provider": provider, "storage.key": String(key) }); }
  findReady(id) { return this.collection.findOne({ _id: id, status: "ready" }); }
  findByUploadKey(recordId, uploadKey) { return this.collection.findOne({ recordId, uploadKey, status: "ready" }); }
  listByBoard(boardId) { return this.collection.find({ boardId, status: "ready" }, { sort: { createdAt: 1, _id: 1 }, limit: 20000 }).toArray(); }
  listByRecord(recordId) { return this.collection.find({ recordId, status: "ready" }, { sort: { createdAt: 1, _id: 1 }, limit: 1000 }).toArray(); }
  countForCell(recordId, columnKey) { return this.collection.countDocuments({ recordId, columnKey }); }
  find(filter, { limit = 1000 } = {}) { return this.collection.find(filter, { limit }).toArray(); }
  async delete(id) { return (await this.collection.deleteOne({ _id: id })).deletedCount === 1; }
  // Bytes held by all attachments (pending ones count their declared size), for the storage cap.
  async totalBytes() { let total = 0; for (const d of await this.collection.find({}, { projection: { size: 1 }, limit: 1000000 }).toArray()) total += Number(d.size) || 0; return total; }
  // A page of attachments in _id order (the orphan sweep walks the whole collection this way).
  listAfter(afterId, limit = 500) { return this.collection.find(afterId ? { _id: { $gt: afterId } } : {}, { sort: { _id: 1 }, limit }).toArray(); }
  async setWorkspace(boardId, workspaceId) { await this.collection.updateMany({ boardId }, { $set: { workspaceId } }); }
}

module.exports = { AttachmentRepository };
