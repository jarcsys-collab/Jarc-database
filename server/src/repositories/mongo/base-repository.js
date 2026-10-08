// Persistence helpers shared by the MongoDB repositories. Repositories only build queries and run them: no HTTP,
// no request objects, no validation messages. Every filter, update and sort here is assembled from known field
// names and already-validated values.
const { ObjectId } = require("mongodb");

// Bulk deletes are only ever scoped to one parent document's ObjectId, never to an empty or client-built filter.
function scopedId(id, label) {
  if (!(id instanceof ObjectId)) throw new TypeError(`${label} must be an ObjectId for a scoped delete.`);
  return id;
}

class VersionedRepository {
  constructor(collection) { this.collection = collection; }

  findById(id, { session } = {}) { return this.collection.findOne({ _id: id }, { session }); }

  async insert(doc, { session } = {}) { await this.collection.insertOne(doc, { session }); return doc; }

  async insertMany(docs, { session } = {}) { if (docs.length) await this.collection.insertMany(docs, { session, ordered: true }); return docs.length; }

  // Optimistic concurrency: updates only if the stored version still equals expectedVersion, then increments it
  // atomically. Returns the document as it was before the update, or null when nothing matched (missing or stale).
  updateVersioned(id, expectedVersion, set, { session } = {}) {
    return this.collection.findOneAndUpdate({ _id: id, version: expectedVersion }, { $set: set, $inc: { version: 1 } }, { returnDocument: "before", session });
  }

  async deleteVersioned(id, expectedVersion, { session } = {}) {
    const { deletedCount } = await this.collection.deleteOne({ _id: id, version: expectedVersion }, { session });
    return deletedCount === 1;
  }
}

// The document after a $set/$inc version update, computed from the "before" document (supports "a.b" paths).
function applyVersionedUpdate(before, set) {
  const after = structuredCloneDoc(before);
  for (const [path, value] of Object.entries(set)) {
    const parts = path.split(".");
    let target = after;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)] = value;
  }
  after.version = before.version + 1;
  return after;
}

// Deep copy that keeps ObjectId and Date instances.
function structuredCloneDoc(value) {
  if (value instanceof ObjectId) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(structuredCloneDoc);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, structuredCloneDoc(v)]));
  return value;
}

module.exports = { VersionedRepository, scopedId, applyVersionedUpdate };
