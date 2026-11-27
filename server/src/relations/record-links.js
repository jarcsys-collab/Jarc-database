// recordLinks PROTOTYPE (Column System plan 17 §4, C3.1): a derived, rebuildable index of Connect cells. One document per link
// and per direction; cells stay the source of truth, always. NOT used for display (Mirror values are computed at read time and
// are never stored here or anywhere else).
//
// Gate: only while JARC_FEATURE_CONNECT_BOARDS is on (server.js runs the startup check then). With the switch off the collection
// is never created, never read, never written: code rollback below this prototype leaves an unused, harmless collection.
// Startup check (checkRecordLinks): CHECK ONLY, it never creates or changes anything. The collection must exist with exactly
// VALIDATOR and the four INDEXES. Missing or inconsistent → status { ok: false } and Connect / Mirror fail CLOSED (writes 503
// RELATIONS_UNAVAILABLE, /related unresolved with reason relations-unavailable); every other board function keeps working.
// Creating the collection is a separate, explicit, approved step: scripts/record-links-collection.js (ensureRecordLinks: creates
// what is missing, never changes what differs).
//
// Security (plan 17 §4.6): no route returns a link document; a row is never evidence of access.
const { ObjectId } = require("mongodb");

const COLLECTION = "recordLinks";
const SAFE_KEY_PATTERN = "^[A-Za-z0-9_-]{1,100}$";
const VALIDATOR = Object.freeze({
  $and: [
    { $jsonSchema: {
      bsonType: "object",
      additionalProperties: false,
      required: ["_id", "v", "fromBoardId", "fromRecordId", "columnKey", "toBoardId", "toRecordId", "origin", "createdAt"],
      properties: {
        _id: { bsonType: "objectId" },
        v: { bsonType: "int", enum: [1] },
        fromBoardId: { bsonType: "objectId" },
        fromRecordId: { bsonType: "objectId" },
        columnKey: { bsonType: "string", pattern: SAFE_KEY_PATTERN },
        toBoardId: { bsonType: "objectId" },
        toRecordId: { bsonType: "objectId" },
        pairId: { bsonType: "objectId" },
        origin: { enum: ["cell", "reciprocal", "rebuild"] },
        createdAt: { bsonType: "date" }
      }
    } },
    { $expr: { $ne: ["$fromRecordId", "$toRecordId"] } }
  ]
});
const VALIDATION = Object.freeze({ validationLevel: "strict", validationAction: "error" });
const INDEXES = Object.freeze([
  { name: "uniq_link", key: { fromRecordId: 1, columnKey: 1, toRecordId: 1 }, unique: true },
  { name: "to_record", key: { toRecordId: 1, fromBoardId: 1 } },
  { name: "to_board", key: { toBoardId: 1, _id: 1 } },
  { name: "from_board_column", key: { fromBoardId: 1, columnKey: 1, _id: 1 } }
]);
const BOUNDS = Object.freeze({ cascade: 2000, batch: 500, reconcileBatch: 200 });

// Canonical JSON (sorted keys) so a validator read back from the server compares equal regardless of key order.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" && !(v instanceof Date) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// → { ok, reason, created: [names] }. create false: only verify (never creates anything).
async function inspect(db, { create }) {
  const created = [];
  try {
    let [info] = await db.listCollections({ name: COLLECTION }).toArray();
    if (!info) {
      if (!create) return { ok: false, reason: "missing", created };
      try { await db.createCollection(COLLECTION, { validator: VALIDATOR, ...VALIDATION }); created.push(COLLECTION); }
      catch (error) { if (error?.code !== 48) throw error; } // created concurrently
      [info] = await db.listCollections({ name: COLLECTION }).toArray();
      if (!info) return { ok: false, reason: "missing", created };
    }
    const o = info.options || {};
    if (!same(o.validator || null, VALIDATOR) || o.validationLevel !== VALIDATION.validationLevel || o.validationAction !== VALIDATION.validationAction) return { ok: false, reason: "validator-differs", created };
    const existing = new Map((await db.collection(COLLECTION).listIndexes().toArray()).map((i) => [i.name, i]));
    for (const spec of INDEXES) {
      const have = existing.get(spec.name);
      if (!have) {
        if (!create) return { ok: false, reason: `index-missing:${spec.name}`, created };
        const { key, ...options } = spec;
        await db.collection(COLLECTION).createIndex(key, options);
        created.push(spec.name);
        continue;
      }
      if (!same(have.key, spec.key) || Boolean(have.unique) !== Boolean(spec.unique)) return { ok: false, reason: `index-differs:${spec.name}`, created };
    }
    // Verify again, from the server, after any creation.
    const after = new Set((await db.collection(COLLECTION).listIndexes().toArray()).map((i) => i.name));
    const absent = INDEXES.filter((s) => !after.has(s.name)).map((s) => s.name);
    if (absent.length) return { ok: false, reason: `index-missing:${absent[0]}`, created };
    return { ok: true, reason: null, created };
  } catch (error) {
    return { ok: false, reason: `error:${error?.codeName || error?.name || "Error"}`, created }; // class only, never a message
  }
}

// Startup: verify only (created is always []).
async function checkRecordLinks(db) { return inspect(db, { create: false }); }
// The explicit script only: creates the collection / missing indexes (never changes a differing validator or index), then verifies.
async function ensureRecordLinks(db) { return inspect(db, { create: true }); }

// The status handed to the routes: status() → { ok, reason } (frozen copy). set() after a re-check.
class RecordLinkStatus {
  #value;
  constructor(value = { ok: true, reason: null }) { this.#value = Object.freeze({ ok: Boolean(value.ok), reason: value.reason ?? null }); }
  status() { return this.#value; }
  set(value) { this.#value = Object.freeze({ ok: Boolean(value.ok), reason: value.reason ?? null }); }
}

const HEX = /^[0-9a-f]{24}$/;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));
const hexOf = (v) => (typeof v === "string" ? v : v?.toHexString?.());
const idsIn = (cell) => (Array.isArray(cell) ? [...new Set(cell.filter((id) => typeof id === "string" && HEX.test(id)))] : []);

// The single writer and the maintenance operations. connection: MongoConnection (withTransaction) or null (no transactions).
class RecordLinkService {
  constructor({ db, connection = null, now = () => new Date() }) { this.db = db; this.connection = connection; this.links = db.collection(COLLECTION); this.records = db.collection("records"); this.now = now; }

  // The rows a record's Connect cells imply.
  desired(board, record, origin = "cell") {
    const rows = [];
    for (const c of (board.columns || []).filter((x) => x.type === "connect")) {
      const to = c.link?.boardId;
      if (!to || !HEX.test(String(to))) continue;
      for (const id of idsIn(record.values?.[c.key])) {
        if (id === hexOf(record._id)) continue; // a record never links to itself (validator §4.3)
        rows.push({ v: 1, fromBoardId: oid(board._id), fromRecordId: oid(record._id), columnKey: c.key, toBoardId: oid(to), toRecordId: oid(id), origin, createdAt: this.now() });
      }
    }
    return rows;
  }

  // Makes the rows of ONE record equal to its cells (idempotent: unique upserts with $setOnInsert, deletes of extras).
  async syncRecord(board, record, { session, origin = "cell" } = {}) {
    const want = this.desired(board, record, origin);
    const keys = new Set(want.map((r) => `${r.columnKey}|${hexOf(r.toRecordId)}`));
    const connectKeys = (board.columns || []).filter((c) => c.type === "connect").map((c) => c.key);
    const have = await this.links.find({ fromRecordId: oid(record._id) }, { session, projection: { _id: 1, columnKey: 1, toRecordId: 1, pairId: 1 } }).toArray();
    const extra = have.filter((r) => !connectKeys.includes(r.columnKey) || !keys.has(`${r.columnKey}|${hexOf(r.toRecordId)}`));
    const ops = [
      ...want.map((r) => ({ updateOne: { filter: { fromRecordId: r.fromRecordId, columnKey: r.columnKey, toRecordId: r.toRecordId }, update: { $setOnInsert: r }, upsert: true } })),
      ...(extra.length ? [{ deleteMany: { filter: { _id: { $in: extra.map((r) => r._id) } } } }] : [])
    ];
    if (ops.length) await this.links.bulkWrite(ops, { session, ordered: true });
    return { upserted: want.length, deleted: extra.length };
  }

  async run(fn) { return this.connection ? this.connection.withTransaction(fn) : fn(undefined); }

  // L1 single writer: the cell ($set + $inc version, matched on version) and its rows in ONE transaction. Without a connection the
  // two writes run one after the other (cell first): a failure in between leaves rows stale, which reconcile repairs.
  async setLinks(board, recordId, columnKey, ids, expectedVersion) {
    return this.run(async (session) => {
      const after = await this.records.findOneAndUpdate({ _id: oid(recordId), boardId: oid(board._id), version: expectedVersion }, { $set: { [`values.${columnKey}`]: ids, updatedAt: this.now() }, $inc: { version: 1 } }, { session, returnDocument: "after" });
      const doc = after && after.value !== undefined && !after._id ? after.value : after; // driver 5/6 shapes
      if (!doc) { const e = new Error("stale or missing record"); e.status = 409; throw e; }
      await this.syncRecord(board, doc, { session });
      return doc;
    });
  }

  // C3.2 prototype: a two-way pair. Both cells and both rows (one per direction, same pairId; origin reciprocal on the far side) in
  // ONE transaction; any failure writes nothing (never silently one-way).
  async linkPair(a, b) {
    const pairId = new ObjectId();
    return this.run(async (session) => {
      for (const [from, to] of [[a, b], [b, a]]) {
        const res = await this.records.updateOne({ _id: oid(from.recordId), boardId: oid(from.board._id) }, { $addToSet: { [`values.${from.columnKey}`]: hexOf(to.recordId) }, $inc: { version: 1 } }, { session });
        if (res.matchedCount !== 1) { const e = new Error("record missing"); e.status = 404; throw e; }
      }
      await this.links.insertMany([
        { v: 1, fromBoardId: oid(a.board._id), fromRecordId: oid(a.recordId), columnKey: a.columnKey, toBoardId: oid(b.board._id), toRecordId: oid(b.recordId), pairId, origin: "cell", createdAt: this.now() },
        { v: 1, fromBoardId: oid(b.board._id), fromRecordId: oid(b.recordId), columnKey: b.columnKey, toBoardId: oid(a.board._id), toRecordId: oid(a.recordId), pairId, origin: "reciprocal", createdAt: this.now() }
      ], { session });
      return pairId;
    });
  }

  async unpair(pairId) {
    return this.run(async (session) => {
      const rows = await this.links.find({ pairId: oid(pairId) }, { session }).toArray();
      for (const r of rows) await this.records.updateOne({ _id: r.fromRecordId }, { $pull: { [`values.${r.columnKey}`]: hexOf(r.toRecordId) }, $inc: { version: 1 } }, { session });
      await this.links.deleteMany({ pairId: oid(pairId) }, { session });
      return rows.length;
    });
  }

  // Reconciliation (report by default): streams the board's records in batches and diffs their cells against from_board_column.
  // apply: upserts missing rows and deletes extra rows (each extra re-checked against its cell first). → counts only.
  async reconcile(board, { apply = false } = {}) {
    const report = { scanned: 0, missing: 0, extra: 0, applied: apply };
    const connectKeys = (board.columns || []).filter((c) => c.type === "connect").map((c) => c.key);
    let after = null;
    for (;;) {
      const page = await this.records.find({ boardId: oid(board._id), ...(after ? { _id: { $gt: after } } : {}) }, { sort: { _id: 1 }, limit: BOUNDS.reconcileBatch, projection: Object.fromEntries([["_id", 1], ...connectKeys.map((k) => [`values.${k}`, 1])]) }).toArray();
      if (!page.length) break;
      after = page.at(-1)._id;
      report.scanned += page.length;
      const ids = page.map((r) => r._id);
      const rows = await this.links.find({ fromRecordId: { $in: ids } }, { projection: { fromRecordId: 1, columnKey: 1, toRecordId: 1 } }).toArray();
      const have = new Set(rows.map((r) => `${hexOf(r.fromRecordId)}|${r.columnKey}|${hexOf(r.toRecordId)}`));
      const want = new Set();
      for (const r of page) for (const row of this.desired(board, r)) want.add(`${hexOf(row.fromRecordId)}|${row.columnKey}|${hexOf(row.toRecordId)}`);
      report.missing += [...want].filter((k) => !have.has(k)).length;
      report.extra += [...have].filter((k) => !want.has(k)).length;
      if (apply) for (const r of page) await this.syncRecord(board, r, { origin: "rebuild" });
    }
    // Rows whose source record no longer exists (deleted without the cascade).
    const orphanRows = await this.links.aggregate([{ $match: { fromBoardId: oid(board._id) } }, { $lookup: { from: "records", localField: "fromRecordId", foreignField: "_id", as: "r", pipeline: [{ $project: { _id: 1 } }] } }, { $match: { r: { $size: 0 } } }, { $project: { _id: 1 } }]).toArray();
    report.extra += orphanRows.length;
    if (apply && orphanRows.length) await this.links.deleteMany({ _id: { $in: orphanRows.map((r) => r._id) } });
    return report;
  }

  // Record deleted: its own rows go; links TO it are pulled from the source cells (≤ BOUNDS.cascade in this call; beyond that the
  // caller schedules a paced sweep) and their rows go, in one transaction when available.
  async onRecordDeleted(recordId) {
    return this.run(async (session) => {
      const own = await this.links.deleteMany({ fromRecordId: oid(recordId) }, { session });
      const inbound = await this.links.find({ toRecordId: oid(recordId) }, { session, limit: BOUNDS.cascade + 1, projection: { _id: 1, fromRecordId: 1, columnKey: 1 } }).toArray();
      const now = inbound.slice(0, BOUNDS.cascade);
      for (const r of now) await this.records.updateOne({ _id: r.fromRecordId }, { $pull: { [`values.${r.columnKey}`]: hexOf(recordId) }, $inc: { version: 1 } }, { session });
      if (now.length) await this.links.deleteMany({ _id: { $in: now.map((r) => r._id) } }, { session });
      return { own: own.deletedCount, pulled: now.length, more: inbound.length > BOUNDS.cascade };
    });
  }

  // Board deleted: its outgoing rows (from_board_column prefix) and the rows pointing at it (to_board), paced in batches by _id.
  // Source cells that pointed at the board keep their IDs (readers tolerate dangling IDs; tolerant writes drop them).
  async onBoardDeleted(boardId) {
    const out = { from: 0, to: 0 };
    for (const [field, count] of [["fromBoardId", "from"], ["toBoardId", "to"]]) {
      for (;;) {
        const batch = await this.links.find({ [field]: oid(boardId) }, { sort: { [field]: 1, _id: 1 }, limit: BOUNDS.batch, projection: { _id: 1 } }).toArray();
        if (!batch.length) break;
        out[count] += (await this.links.deleteMany({ _id: { $in: batch.map((r) => r._id) } })).deletedCount;
      }
    }
    return out;
  }

  // Connect column deleted: its rows, paced by from_board_column.
  async onColumnDeleted(boardId, columnKey) {
    let n = 0;
    for (;;) {
      const batch = await this.links.find({ fromBoardId: oid(boardId), columnKey }, { sort: { fromBoardId: 1, columnKey: 1, _id: 1 }, limit: BOUNDS.batch, projection: { _id: 1 } }).toArray();
      if (!batch.length) break;
      n += (await this.links.deleteMany({ _id: { $in: batch.map((r) => r._id) } })).deletedCount;
    }
    return n;
  }
}

module.exports = { COLLECTION, VALIDATOR, VALIDATION, INDEXES, BOUNDS, sameDefinition: same, checkRecordLinks, ensureRecordLinks, RecordLinkStatus, RecordLinkService };
