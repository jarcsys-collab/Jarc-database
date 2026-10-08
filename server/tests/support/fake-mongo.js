// TEST-ONLY in-memory stand-in for the part of the official MongoDB driver API that the repositories use, so the
// data layer is tested deterministically without Atlas or a mongod binary. It uses the real driver's ObjectId and
// error classes. Anything outside the supported subset (unknown query or update operators) throws, so tests can't
// silently pass on behaviour the real driver wouldn't have.
//
// Also enforces: unique indexes (with partial filters) → E11000; transactions roll back on error; deleteMany with an
// empty filter is refused; drop() is refused; every call is recorded in collection.calls for query assertions.
const { ObjectId, MongoServerError, MongoNetworkError } = require("mongodb");

const clone = (v) => {
  if (v instanceof ObjectId) return new ObjectId(v.id);
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
};
const getPath = (doc, path) => path.split(".").reduce((node, part) => (node == null ? undefined : node[part]), doc);
const setPath = (doc, path, value) => { const parts = path.split("."); let n = doc; for (const p of parts.slice(0, -1)) n = n[p] ??= {}; n[parts.at(-1)] = value; };
const unsetPath = (doc, path) => { const parts = path.split("."); const parent = getPath(doc, parts.slice(0, -1).join(".")) ?? (parts.length === 1 ? doc : undefined); if (parent) delete parent[parts.at(-1)]; };
const isOperatorObject = (v) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof ObjectId) && !(v instanceof Date) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith("$"));

function typeOrder(v) {
  if (v === undefined || v === null) return 1;
  if (typeof v === "number") return 2;
  if (typeof v === "string") return 3;
  if (v instanceof ObjectId) return 7;
  if (typeof v === "boolean") return 8;
  if (v instanceof Date) return 9;
  if (Array.isArray(v)) return 5;
  return 4;
}
function compare(a, b) {
  const ta = typeOrder(a), tb = typeOrder(b);
  if (ta !== tb) return ta - tb;
  if (ta === 1) return 0;
  if (a instanceof ObjectId) return a.toHexString() < b.toHexString() ? -1 : a.toHexString() > b.toHexString() ? 1 : 0;
  if (a instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number") return a - b;
  if (typeof a === "string" || typeof a === "boolean") return a < b ? -1 : a > b ? 1 : 0;
  return JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0;
}
function equalValues(a, b) {
  if (a instanceof ObjectId || b instanceof ObjectId) return a instanceof ObjectId && b instanceof ObjectId && a.equals(b);
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equalValues(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") { const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every((k) => equalValues(a[k], b[k])); }
  return a === b;
}
function eq(value, cond) {
  if (cond === null) return value === null || value === undefined;
  if (Array.isArray(value) && !Array.isArray(cond)) return value.some((v) => equalValues(v, cond));
  return equalValues(value, cond);
}

function matches(doc, filter = {}) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$or") { if (!cond.some((f) => matches(doc, f))) return false; continue; }
    if (key === "$and") { if (!cond.every((f) => matches(doc, f))) return false; continue; }
    if (key.startsWith("$")) throw new Error(`fake-mongo: unsupported top-level operator ${key}`);
    const value = getPath(doc, key);
    if (!isOperatorObject(cond)) { if (!eq(value, cond)) return false; continue; }
    for (const [op, arg] of Object.entries(cond)) {
      const comparable = value !== undefined && typeOrder(value) === typeOrder(arg);
      const ok = {
        $eq: () => eq(value, arg), $ne: () => !eq(value, arg),
        $gt: () => comparable && compare(value, arg) > 0, $gte: () => comparable && compare(value, arg) >= 0,
        $lt: () => comparable && compare(value, arg) < 0, $lte: () => comparable && compare(value, arg) <= 0,
        $in: () => arg.some((x) => eq(value, x)), $nin: () => !arg.some((x) => eq(value, x)),
        $exists: () => (value !== undefined) === Boolean(arg),
        $type: () => ({ string: typeof value === "string", number: typeof value === "number", bool: typeof value === "boolean", objectId: value instanceof ObjectId, date: value instanceof Date })[arg]
      }[op];
      if (!ok) throw new Error(`fake-mongo: unsupported query operator ${op}`);
      if (!ok()) return false;
    }
  }
  return true;
}

function applyUpdate(doc, update, { inserting = false } = {}) {
  const keys = Object.keys(update);
  if (!keys.length || !keys.every((k) => k.startsWith("$"))) throw new Error("fake-mongo: only operator updates are supported");
  for (const [op, fields] of Object.entries(update)) {
    if (op === "$set") for (const [p, v] of Object.entries(fields)) setPath(doc, p, clone(v));
    else if (op === "$setOnInsert") { if (inserting) for (const [p, v] of Object.entries(fields)) setPath(doc, p, clone(v)); }
    else if (op === "$inc") for (const [p, v] of Object.entries(fields)) setPath(doc, p, (getPath(doc, p) ?? 0) + v);
    else if (op === "$unset") for (const p of Object.keys(fields)) unsetPath(doc, p);
    else throw new Error(`fake-mongo: unsupported update operator ${op}`);
  }
  return doc;
}

function project(doc, projection) {
  if (!projection || !Object.keys(projection).length) return doc;
  const result = { _id: doc._id };
  for (const [k, v] of Object.entries(projection)) { if (v) { const value = getPath(doc, k); if (value !== undefined) setPath(result, k, value); } else if (k === "_id") delete result._id; }
  return result;
}

const duplicateKey = () => new MongoServerError({ message: "E11000 duplicate key error (fake)", code: 11000, codeName: "DuplicateKey" });

class FakeCursor {
  constructor(collection, filter, options = {}) { Object.assign(this, { collection, filter, sortSpec: options.sort, limitN: options.limit, projection: options.projection }); }
  sort(spec) { this.sortSpec = spec; return this; }
  limit(n) { this.limitN = n; return this; }
  async toArray() {
    this.collection.client.maybeFail(this.collection.name, "find");
    let docs = this.collection.docs.filter((d) => matches(d, this.filter));
    if (this.sortSpec) {
      const spec = Object.entries(this.sortSpec);
      docs = [...docs].sort((a, b) => { for (const [k, dir] of spec) { const c = compare(getPath(a, k), getPath(b, k)); if (c) return dir === -1 ? -c : c; } return 0; });
    }
    if (this.limitN) docs = docs.slice(0, this.limitN);
    return docs.map((d) => clone(project(d, this.projection)));
  }
}

class FakeCollection {
  constructor(name, db) { Object.assign(this, { name, db, client: db.client, docs: [], indexes: [{ name: "_id_", key: { _id: 1 }, unique: true }], calls: [] }); }
  record(op, args) { this.calls.push({ op, ...args }); this.client.maybeFail(this.name, op); this.db.created.add(this.name); }

  assertUnique(docs) {
    for (const index of this.indexes.filter((i) => i.unique)) {
      const seen = new Set();
      for (const doc of docs) {
        if (index.partialFilterExpression && !matches(doc, index.partialFilterExpression)) continue;
        const tuple = JSON.stringify(Object.keys(index.key).map((k) => { const v = getPath(doc, k); return v instanceof ObjectId ? `oid:${v.toHexString()}` : v instanceof Date ? `date:${v.getTime()}` : v ?? null; }));
        if (seen.has(tuple)) throw duplicateKey();
        seen.add(tuple);
      }
    }
  }

  async insertOne(doc, options = {}) {
    this.record("insertOne", { doc, options });
    doc._id ??= new ObjectId(); // the real driver also adds _id to the passed object
    const next = [...this.docs, clone(doc)];
    this.assertUnique(next);
    this.docs = next;
    return { acknowledged: true, insertedId: doc._id };
  }
  async insertMany(docs, options = {}) {
    this.record("insertMany", { count: docs.length, options });
    for (const doc of docs) { doc._id ??= new ObjectId(); const next = [...this.docs, clone(doc)]; this.assertUnique(next); this.docs = next; }
    return { acknowledged: true, insertedCount: docs.length };
  }
  find(filter = {}, options = {}) { this.calls.push({ op: "find", filter, options }); return new FakeCursor(this, filter, options); }
  async findOne(filter = {}, options = {}) { this.calls.push({ op: "findOne", filter, options }); const [doc] = await new FakeCursor(this, filter, { ...options, limit: 1 }).toArray(); return doc ?? null; }
  async countDocuments(filter = {}) { this.record("countDocuments", { filter }); return this.docs.filter((d) => matches(d, filter)).length; }

  replaceAt(index, doc) { const next = [...this.docs]; next[index] = doc; this.assertUnique(next); this.docs = next; }
  async updateOne(filter, update, options = {}) {
    this.record("updateOne", { filter, update, options });
    const index = this.docs.findIndex((d) => matches(d, filter));
    if (index < 0) {
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      const base = Object.fromEntries(Object.entries(filter).filter(([k, v]) => !k.startsWith("$") && !isOperatorObject(v)));
      const doc = applyUpdate({ _id: new ObjectId(), ...clone(base) }, update, { inserting: true });
      const next = [...this.docs, doc]; this.assertUnique(next); this.docs = next;
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: doc._id };
    }
    this.replaceAt(index, applyUpdate(clone(this.docs[index]), update));
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
  }
  async updateMany(filter, update, options = {}) {
    if (!filter || !Object.keys(filter).length) throw new Error("fake-mongo: refusing an unscoped updateMany");
    this.record("updateMany", { filter, update, options });
    let modified = 0;
    const next = this.docs.map((d) => { if (!matches(d, filter)) return d; modified += 1; return applyUpdate(clone(d), update); });
    this.assertUnique(next); this.docs = next;
    return { matchedCount: modified, modifiedCount: modified };
  }
  // Supports updateOne and deleteOne operations, applied in order (ordered: true semantics).
  async bulkWrite(operations, options = {}) {
    this.record("bulkWrite", { count: operations.length, options });
    let matchedCount = 0, modifiedCount = 0, deletedCount = 0;
    for (const operation of operations) {
      if (operation.updateOne) {
        const { filter, update } = operation.updateOne;
        if (!filter || !Object.keys(filter).length) throw new Error("fake-mongo: refusing an unscoped bulk update");
        const index = this.docs.findIndex((d) => matches(d, filter));
        if (index < 0) continue;
        this.replaceAt(index, applyUpdate(clone(this.docs[index]), update)); matchedCount += 1; modifiedCount += 1;
      } else if (operation.deleteOne) {
        const { filter } = operation.deleteOne;
        if (!filter || !Object.keys(filter).length) throw new Error("fake-mongo: refusing an unscoped bulk delete");
        const index = this.docs.findIndex((d) => matches(d, filter));
        if (index >= 0) { this.docs = this.docs.filter((_, i) => i !== index); deletedCount += 1; }
      } else throw new Error("fake-mongo: unsupported bulkWrite operation");
    }
    return { matchedCount, modifiedCount, deletedCount };
  }
  async findOneAndUpdate(filter, update, options = {}) {
    this.record("findOneAndUpdate", { filter, update, options });
    const index = this.docs.findIndex((d) => matches(d, filter));
    if (index < 0) return null;
    const before = clone(this.docs[index]);
    const after = applyUpdate(clone(before), update);
    this.replaceAt(index, after);
    return clone(options.returnDocument === "after" ? after : before);
  }
  async deleteOne(filter, options = {}) {
    this.record("deleteOne", { filter, options });
    const index = this.docs.findIndex((d) => matches(d, filter));
    if (index < 0) return { deletedCount: 0 };
    this.docs = this.docs.filter((_, i) => i !== index);
    return { deletedCount: 1 };
  }
  async deleteMany(filter, options = {}) {
    if (!filter || !Object.keys(filter).length) throw new Error("fake-mongo: refusing an unscoped deleteMany");
    this.record("deleteMany", { filter, options });
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !matches(d, filter));
    return { deletedCount: before - this.docs.length };
  }
  async createIndex(key, options = {}) {
    this.record("createIndex", { key, options });
    const name = options.name || Object.entries(key).map(([k, v]) => `${k}_${v}`).join("_");
    const spec = { name, key, unique: Boolean(options.unique), partialFilterExpression: options.partialFilterExpression };
    const existing = this.indexes.find((i) => i.name === name);
    if (existing) {
      const same = JSON.stringify(existing.key) === JSON.stringify(key) && Boolean(existing.unique) === spec.unique && JSON.stringify(existing.partialFilterExpression) === JSON.stringify(spec.partialFilterExpression);
      if (!same) throw new MongoServerError({ message: "Index already exists with different options (fake)", code: 85, codeName: "IndexOptionsConflict" });
      return name;
    }
    if (spec.unique) this.assertUnique.call({ indexes: [spec] }, this.docs);
    this.indexes.push(spec);
    return name;
  }
  listIndexes() { return { toArray: async () => this.indexes.map((i) => ({ ...i })) }; }
  async drop() { throw new Error("fake-mongo: drop() must never be called by JARC code"); }
}

class FakeDb {
  constructor(name, client) { Object.assign(this, { databaseName: name, client, collections: new Map(), created: new Set() }); }
  collection(name) { if (!this.collections.has(name)) this.collections.set(name, new FakeCollection(name, this)); return this.collections.get(name); }
  async createCollection(name) {
    this.client.maybeFail(name, "createCollection");
    if (this.created.has(name)) throw new MongoServerError({ message: "Collection already exists (fake)", code: 48, codeName: "NamespaceExists" });
    this.created.add(name); this.collection(name);
    return this.collection(name);
  }
  listCollections() { return { toArray: async () => [...this.created].map((name) => ({ name, type: "collection" })) }; }
  async command(command) {
    if (this.client.down) throw new MongoNetworkError("connection refused (fake)");
    if (command.ping === 1) return { ok: 1 };
    throw new Error("fake-mongo: unsupported command");
  }
  async dropDatabase() { throw new Error("fake-mongo: dropDatabase() must never be called by JARC code"); }
}

class FakeMongoClient {
  constructor({ connectError = null, transactions = true } = {}) {
    Object.assign(this, { connectError, transactions, dbs: new Map(), requestedDbNames: [], connectCalls: 0, closeCalls: 0, transactionsRun: 0, down: false, failures: [] });
  }
  async connect() { this.connectCalls += 1; if (this.connectError) throw this.connectError; return this; }
  db(name) { this.requestedDbNames.push(name); if (!this.dbs.has(name)) this.dbs.set(name, new FakeDb(name, this)); return this.dbs.get(name); }
  async close() { this.closeCalls += 1; }
  // Fails matching operation(s): { collection, op, error, times = 1, skip = 0 } (skip lets the first N through).
  failNext(rule) { this.failures.push({ times: 1, skip: 0, ...rule }); }
  maybeFail(collection, op) {
    if (this.down) throw new MongoNetworkError("connection refused (fake)");
    const rule = this.failures.find((f) => (!f.collection || f.collection === collection) && (!f.op || f.op === op));
    if (!rule) return;
    if (rule.skip > 0) { rule.skip -= 1; return; }
    if (--rule.times <= 0) this.failures.splice(this.failures.indexOf(rule), 1);
    throw rule.error;
  }
  startSession() {
    const client = this;
    return {
      async withTransaction(fn) {
        if (!client.transactions) throw new MongoServerError({ message: "Transaction numbers are only allowed on a replica set member or mongos (fake)", code: 20, codeName: "IllegalOperation" });
        client.transactionsRun += 1;
        const snapshot = [...client.dbs.values()].map((db) => ({ db, created: new Set(db.created), docs: new Map([...db.collections].map(([n, c]) => [n, c.docs])) }));
        try { return await fn(this); }
        catch (error) {
          for (const { db, created, docs } of snapshot) { db.created = created; for (const [n, c] of db.collections) c.docs = docs.get(n) ?? []; }
          throw error;
        }
      },
      async endSession() {}
    };
  }
}

module.exports = { FakeMongoClient, matches };
