// fabricSavedFilters collection (JARC's own database, never Fabric's): each person's named Fabric Data filters, one document
// per person per dataset, kept apart from everything else (the personalViews pattern).
//   { _id: "<userId hex>:<dataset>", userId, dataset, filters: [{ id, name, nameKey, version: 1, state, createdAt, updatedAt }],
//     rev, updatedAt }
//   nameKey: the name folded for the per-person, per-dataset uniqueness check. rev: bumped on every write (optimistic
//   concurrency: two tabs saving at once never lose each other's filters).
// Every read and write is by _id (the default index): no extra index is needed. Created on the person's first saved filter.
const COLLECTION = "fabricSavedFilters";
const keyOf = (userId, dataset) => `${String(userId)}:${dataset}`;
const DUPLICATE_KEY = 11000;

class FabricSavedFilterRepository {
  constructor(db) { this.collection = db.collection(COLLECTION); }
  // → the document, or null.
  async get(userId, dataset) { return userId ? this.collection.findOne({ _id: keyOf(userId, dataset) }) : null; }
  // Writes `filters` only if nobody else wrote since `rev` was read (rev null: the document must not exist yet).
  // → true when written, false when another write got there first (the caller re-reads and retries).
  async put(userId, dataset, filters, rev, now = new Date()) {
    const _id = keyOf(userId, dataset);
    if (rev === null || rev === undefined) {
      try {
        await this.collection.insertOne({ _id, userId, dataset, filters, rev: 1, updatedAt: now });
        return true;
      } catch (error) {
        if (error?.code === DUPLICATE_KEY) return false;
        throw error;
      }
    }
    const result = await this.collection.updateOne({ _id, rev }, { $set: { filters, updatedAt: now }, $inc: { rev: 1 } });
    return result.matchedCount === 1;
  }
}

module.exports = { FabricSavedFilterRepository, FABRIC_SAVED_FILTERS_COLLECTION: COLLECTION, fabricSavedFilterKey: keyOf };
