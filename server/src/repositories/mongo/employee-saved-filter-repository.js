// employeeSavedFilters collection (JARC's own database, never the directory source): each person's named Employee Management
// filters, one document per person per dataset (active, all, disabled, guests).
//   { _id: "<userId>:<dataset>", userId, dataset, filters: [{ id, name, nameKey, version: 1, state, createdAt, updatedAt }],
//     rev, updatedAt }
//   state: only the validated { filter, orderBy, columns, q, searchField } (routes/employee-saved-filters.js). No directory
//   record is ever stored here. rev: bumped on every write (optimistic concurrency).
// Every read and write is by _id (the default index): no extra index. Created lazily on the person's first saved filter.
const COLLECTION = "employeeSavedFilters";
const keyOf = (userId, dataset) => `${String(userId)}:${dataset}`;
const DUPLICATE_KEY = 11000;

class EmployeeSavedFilterRepository {
  constructor(db) { this.collection = db.collection(COLLECTION); }
  async get(userId, dataset) { return userId ? this.collection.findOne({ _id: keyOf(userId, dataset) }) : null; }
  // Writes `filters` only if nobody else wrote since `rev` (null: the document must not exist yet). → true when written.
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

module.exports = { EmployeeSavedFilterRepository, EMPLOYEE_SAVED_FILTERS_COLLECTION: COLLECTION, employeeSavedFilterKey: keyOf };
