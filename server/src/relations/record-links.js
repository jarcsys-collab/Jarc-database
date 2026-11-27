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
const MAX_PER_CELL = 100; // domain/board-schema.js MAX_MULTI_VALUES (single: 1)
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));
const hexOf = (v) => (typeof v === "string" ? v : v?.toHexString?.());
const idsIn = (cell) => (Array.isArray(cell) ? [...new Set(cell.filter((id) => typeof id === "string" && HEX.test(id)))] : []);
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const connectColumn = (board, key) => (board.columns || []).find((c) => c.key === key && c.type === "connect" && HEX.test(String(c.link?.boardId || "")));
const noTransactions = () => failure(503, "RELATIONS_UNAVAILABLE", "Link writes need MongoDB transactions.");

// LINK GUARD (TOCTOU fix, doc 25 finding 1). A plain find inside a snapshot transaction does NOT conflict with a concurrent delete
// or archive: the transaction would still commit a link to a record removed after its read. So every record that a write NEWLY
// links to is touched, inside the write transaction, with a CONDITIONAL WRITE: filter { _id, boardId: <linked board>, archived ≠
// true }, update $inc linkGuard. A concurrent delete / archive of that record is a write to the same document: whichever commits
// second either gets a WriteConflict (inside a transaction; withTransaction retries it on a fresh snapshot, where the filter no
// longer matches → refused) or waits for the first to commit (a write outside a transaction) and then applies after it. Either
// way a link never commits to a record whose delete / archive committed first. linkGuard is a counter only: it never changes
// version or updatedAt (no 409 for people editing the linked record) and is never serialized (api/serialize.js picks fields).
async function guardRecords(records, boardId, ids, session) {
  if (!ids.length) return { ok: true, missing: 0, archived: 0 };
  const res = await records.updateMany({ _id: { $in: ids.map(oid) }, boardId: oid(boardId), archived: { $ne: true } }, { $inc: { linkGuard: 1 } }, { session });
  if (res.matchedCount === ids.length) return { ok: true, missing: 0, archived: 0 };
  const there = await records.find({ _id: { $in: ids.map(oid) }, boardId: oid(boardId) }, { session, projection: { _id: 1, archived: 1 } }).toArray();
  return { ok: false, missing: ids.length - there.length, archived: there.filter((d) => d.archived === true).length };
}
const guardError = (g) => (g.missing ? failure(400, "VALIDATION_ERROR", "A linked record isn't on the linked board (deleted or moved).") : failure(400, "VALIDATION_ERROR", "An archived record can't be linked."));

// The single writer and the maintenance operations. connection: MongoConnection (withTransaction) or null (no transactions:
// reads and reports only; every write refuses with 503, because the link guard needs a transaction).
// activities: optional activities collection (default db.collection("activities")) for the two-way entries.
class RecordLinkService {
  constructor({ db, connection = null, now = () => new Date(), pause = null }) { this.db = db; this.connection = connection; this.links = db.collection(COLLECTION); this.records = db.collection("records"); this.activities = db.collection("activities"); this.now = now; this.pause = pause; }
  // Test seam: an awaited hook between the steps of a write (concurrency tests widen the race window with it).
  async step(name) { if (this.pause) await this.pause(name); }

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

  // Makes the rows of ONE record equal to its cells (idempotent: unique upserts with $setOnInsert, deletes of extras). A row from
  // another board, or pointing at a board other than the column's linked board, is an extra too (integrity).
  async syncRecord(board, record, { session, origin = "cell" } = {}) {
    const want = this.desired(board, record, origin);
    const keys = new Set(want.map((r) => `${r.columnKey}|${hexOf(r.toRecordId)}|${hexOf(r.toBoardId)}`));
    const connectKeys = (board.columns || []).filter((c) => c.type === "connect").map((c) => c.key);
    const have = await this.links.find({ fromRecordId: oid(record._id) }, { session, projection: { _id: 1, fromBoardId: 1, columnKey: 1, toBoardId: 1, toRecordId: 1, pairId: 1 } }).toArray();
    const extra = have.filter((r) => !connectKeys.includes(r.columnKey) || hexOf(r.fromBoardId) !== hexOf(board._id) || !keys.has(`${r.columnKey}|${hexOf(r.toRecordId)}|${hexOf(r.toBoardId)}`));
    // Extras first: a wrong-board row holds the unique key its correct replacement needs.
    const ops = [
      ...(extra.length ? [{ deleteMany: { filter: { _id: { $in: extra.map((r) => r._id) } } } }] : []),
      ...want.map((r) => ({ updateOne: { filter: { fromRecordId: r.fromRecordId, columnKey: r.columnKey, toRecordId: r.toRecordId }, update: { $setOnInsert: r }, upsert: true } }))
    ];
    if (ops.length) await this.links.bulkWrite(ops, { session, ordered: true });
    return { upserted: want.length, deleted: extra.length };
  }

  async run(fn) { return this.connection ? this.connection.withTransaction(fn) : fn(undefined); }
  // Every write: a transaction, or nothing (fail closed). Reads / reports may run without one.
  async write(fn) { if (!this.connection) throw noTransactions(); return this.connection.withTransaction(fn); }

  // L1 single writer: in ONE transaction, (1) the host record is read at expectedVersion (404 / 409), (2) the ids are validated
  // (Connect column, unique 24-hex, ≤ 1 single / ≤ 100 multiple, no self link), (3) every NEWLY added id is guarded on the linked
  // board (guardRecords: exists there and isn't archived, as a conflicting write), (4) stored ids that no longer exist on the
  // linked board are dropped (tolerant write, reported), (5) the cell ($set + $inc version, matched on version) and (6) its rows.
  // Authorization (host record.editValues + linked board.view) stays with the caller (routes, through the AuthzContext).
  // → { record, dropped }
  async setLinks(board, recordId, columnKey, ids, expectedVersion) {
    const column = connectColumn(board, columnKey);
    if (!column) throw failure(400, "VALIDATION_ERROR", "Not a Connect column of this board.");
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !HEX.test(id)) || new Set(ids).size !== ids.length) throw failure(400, "VALIDATION_ERROR", "Links must be a list of distinct record IDs.");
    if (ids.length > (column.multiple ? MAX_PER_CELL : 1)) throw failure(400, "VALIDATION_ERROR", column.multiple ? "Too many linked records." : "This column links only one record.");
    if (ids.includes(hexOf(oid(recordId)))) throw failure(400, "VALIDATION_ERROR", "A record can't link to itself.");
    const target = String(column.link.boardId);
    return this.write(async (session) => {
      const current = await this.records.findOne({ _id: oid(recordId), boardId: oid(board._id) }, { session, projection: { _id: 1, version: 1, [`values.${columnKey}`]: 1 } });
      if (!current) throw failure(404, "NOT_FOUND", "The record no longer exists.");
      if (current.version !== expectedVersion) throw failure(409, "CONFLICT", "The record was changed by someone else.");
      const stored = new Set(idsIn(current.values?.[columnKey]));
      const added = ids.filter((id) => !stored.has(id)), kept = ids.filter((id) => stored.has(id));
      await this.step("before-guard");
      const g = await guardRecords(this.records, target, added, session);
      if (!g.ok) throw guardError(g);
      const live = kept.length ? new Set((await this.records.find({ _id: { $in: kept.map(oid) }, boardId: oid(target) }, { session, projection: { _id: 1 } }).toArray()).map((d) => hexOf(d._id))) : new Set();
      const value = ids.filter((id) => !stored.has(id) || live.has(id));
      await this.step("before-write");
      const after = await this.records.findOneAndUpdate({ _id: oid(recordId), boardId: oid(board._id), version: expectedVersion }, { $set: { [`values.${columnKey}`]: value, updatedAt: this.now() }, $inc: { version: 1 } }, { session, returnDocument: "after" });
      const doc = after && after.value !== undefined && !after._id ? after.value : after; // driver 5/6 shapes
      if (!doc) throw failure(409, "CONFLICT", "The record was changed by someone else.");
      await this.syncRecord(board, doc, { session });
      return { record: doc, dropped: ids.length - value.length };
    });
  }

  // C3.2 prototype (NOT reachable from any route; two-way stays off): a two-way pair. Both cells, both rows (one per direction,
  // same pairId; origin reciprocal on the far side) and one activity entry per side (IDs only) in ONE transaction; any failure
  // writes nothing (never silently one-way). a / b: { board, recordId, columnKey }.
  //   authz (required, fail closed): { canEditValues(board) → boolean } from the caller's AuthzContext — two-way needs
  //     record.editValues on BOTH boards (doc 25 §5, X3); missing or false → 403 and nothing is read or written.
  //   actor: { userId, displayName } for the activity entries.
  // Checks: each column is a Connect column linking the other board; no self link; both records guarded (exist on their board,
  // not archived: guardRecords); single columns already holding another link → 400; ≤ 100 per cell; an existing link → 409.
  async linkPair(a, b, { authz, actor } = {}) {
    if (!authz || typeof authz.canEditValues !== "function" || !authz.canEditValues(a.board) || !authz.canEditValues(b.board)) throw failure(403, "FORBIDDEN", "Two-way links need edit rights on both boards.");
    const ca = connectColumn(a.board, a.columnKey), cb = connectColumn(b.board, b.columnKey);
    if (!ca || !cb || String(ca.link.boardId) !== hexOf(b.board._id) || String(cb.link.boardId) !== hexOf(a.board._id)) throw failure(400, "VALIDATION_ERROR", "Each column must be a Connect column linking the other board.");
    if (hexOf(oid(a.recordId)) === hexOf(oid(b.recordId))) throw failure(400, "VALIDATION_ERROR", "A record can't link to itself.");
    const pairId = new ObjectId();
    return this.write(async (session) => {
      for (const side of [a, b]) { const g = await guardRecords(this.records, side.board._id, [hexOf(oid(side.recordId))], session); if (!g.ok) throw g.missing ? failure(404, "NOT_FOUND", "A record of the pair no longer exists.") : guardError(g); }
      const now = this.now();
      const entries = [];
      for (const [from, to, column] of [[a, b, ca], [b, a, cb]]) {
        const doc = await this.records.findOne({ _id: oid(from.recordId) }, { session, projection: { workspaceId: 1, version: 1, [`values.${from.columnKey}`]: 1 } });
        const cell = idsIn(doc.values?.[from.columnKey]), id = hexOf(oid(to.recordId));
        if (cell.includes(id)) throw failure(409, "CONFLICT", "These records are already linked.");
        if (cell.length >= (column.multiple ? MAX_PER_CELL : 1)) throw failure(400, "VALIDATION_ERROR", column.multiple ? "Too many linked records." : "This column links only one record.");
        await this.records.updateOne({ _id: oid(from.recordId), boardId: oid(from.board._id), version: doc.version }, { $set: { [`values.${from.columnKey}`]: [...cell, id], updatedAt: now }, $inc: { version: 1 } }, { session });
        entries.push({ workspaceId: from.board.workspaceId ?? doc.workspaceId ?? null, boardId: oid(from.board._id), recordId: oid(from.recordId), actorUserId: actor?.userId ?? null, actorName: actor?.displayName ?? null, action: "record.updated", entityType: "record", entityId: oid(from.recordId), changes: [{ field: `values.${from.columnKey}`, from: cell, to: [...cell, id] }], summary: "", createdAt: now, loggedAt: now });
      }
      try {
        await this.links.insertMany([
          { v: 1, fromBoardId: oid(a.board._id), fromRecordId: oid(a.recordId), columnKey: a.columnKey, toBoardId: oid(b.board._id), toRecordId: oid(b.recordId), pairId, origin: "cell", createdAt: now },
          { v: 1, fromBoardId: oid(b.board._id), fromRecordId: oid(b.recordId), columnKey: b.columnKey, toBoardId: oid(a.board._id), toRecordId: oid(a.recordId), pairId, origin: "reciprocal", createdAt: now }
        ], { session });
      } catch (error) { if (error?.code === 11000) throw failure(409, "CONFLICT", "These records are already linked."); throw error; }
      await this.activities.insertMany(entries, { session });
      return pairId;
    });
  }

  // Removes a pair, scoped to the board it is asked from (boardId must be one side of the pair, else 404 — a pairId alone never
  // reaches another board's records), with the same authz rule and activity as linkPair. Each $pull is filtered by the row's
  // own board. → number of rows removed.
  async unpair(pairId, { boardId, authz, actor, boards } = {}) {
    if (!authz || typeof authz.canEditValues !== "function") throw failure(403, "FORBIDDEN", "Two-way links need edit rights on both boards.");
    if (!boardId || !HEX.test(hexOf(oid(boardId)))) throw failure(404, "NOT_FOUND", "Link not found.");
    return this.write(async (session) => {
      const rows = await this.links.find({ pairId: oid(pairId) }, { session }).toArray();
      if (!rows.some((r) => hexOf(r.fromBoardId) === hexOf(oid(boardId)))) throw failure(404, "NOT_FOUND", "Link not found.");
      const sides = rows.map((r) => boards?.get?.(hexOf(r.fromBoardId)) || { _id: r.fromBoardId });
      if (!sides.every((s) => authz.canEditValues(s))) throw failure(403, "FORBIDDEN", "Two-way links need edit rights on both boards.");
      const now = this.now(), entries = [];
      for (const r of rows) {
        const before = await this.records.findOneAndUpdate({ _id: r.fromRecordId, boardId: r.fromBoardId }, { $pull: { [`values.${r.columnKey}`]: hexOf(r.toRecordId) }, $inc: { version: 1 }, $set: { updatedAt: now } }, { session, returnDocument: "before", projection: { workspaceId: 1, [`values.${r.columnKey}`]: 1 } });
        const doc = before && before.value !== undefined && !before._id ? before.value : before;
        if (!doc) continue; // record already gone: its row goes below
        const cell = idsIn(doc.values?.[r.columnKey]);
        entries.push({ workspaceId: doc.workspaceId ?? null, boardId: r.fromBoardId, recordId: r.fromRecordId, actorUserId: actor?.userId ?? null, actorName: actor?.displayName ?? null, action: "record.updated", entityType: "record", entityId: r.fromRecordId, changes: [{ field: `values.${r.columnKey}`, from: cell, to: cell.filter((x) => x !== hexOf(r.toRecordId)) }], summary: "", createdAt: now, loggedAt: now });
      }
      await this.links.deleteMany({ pairId: oid(pairId) }, { session });
      if (entries.length) await this.activities.insertMany(entries, { session });
      return rows.length;
    });
  }

  // Reconciliation (report by default): streams the board's records in batches and diffs their cells against their rows (key
  // fromRecord | column | toRecord | toBoard, so a row pointing at the wrong board counts as extra + missing).
  // apply (finding 2): only records with a difference are repaired, each in its OWN transaction that re-reads the record and
  // then does a compare-and-set on it ({ _id, boardId, version: <just read> } → $inc linkGuard). Any concurrent write to that
  // record (setLinks, an ordinary edit, a cascade) is a write to the same document: it either committed before this read (the
  // repair uses the newer cell) or conflicts (WriteConflict → withTransaction retries with a fresh read) or waits for this commit
  // and then applies its own rows after it. Reconcile never writes a cell — only rows — so it can never overwrite an employee's
  // edit, and it can never write rows from a cell value that has since changed. apply without transactions refuses (503).
  // pauseMS: a pause between batches (the CLI paces production runs). → counts only (no IDs, no values).
  async reconcile(board, { apply = false, pauseMS = 0 } = {}) {
    if (apply && !this.connection) throw noTransactions();
    const report = { scanned: 0, missing: 0, extra: 0, applied: apply };
    const connectKeys = (board.columns || []).filter((c) => c.type === "connect").map((c) => c.key);
    const fields = Object.fromEntries([["_id", 1], ["version", 1], ...connectKeys.map((k) => [`values.${k}`, 1])]);
    const keyOf = (r) => `${hexOf(r.fromRecordId)}|${r.columnKey}|${hexOf(r.toRecordId)}|${hexOf(r.toBoardId)}`;
    let after = null;
    for (;;) {
      const page = await this.records.find({ boardId: oid(board._id), ...(after ? { _id: { $gt: after } } : {}) }, { sort: { _id: 1 }, limit: BOUNDS.reconcileBatch, projection: fields }).toArray();
      if (!page.length) break;
      after = page.at(-1)._id;
      report.scanned += page.length;
      const ids = page.map((r) => r._id);
      const rows = await this.links.find({ fromRecordId: { $in: ids } }, { projection: { fromRecordId: 1, fromBoardId: 1, columnKey: 1, toRecordId: 1, toBoardId: 1 } }).toArray();
      const have = new Set(rows.filter((r) => hexOf(r.fromBoardId) === hexOf(board._id)).map(keyOf));
      const foreign = rows.filter((r) => hexOf(r.fromBoardId) !== hexOf(board._id)).length;
      const want = new Set();
      for (const r of page) for (const row of this.desired(board, r)) want.add(keyOf(row));
      const missing = [...want].filter((k) => !have.has(k)), extra = [...have].filter((k) => !want.has(k));
      report.missing += missing.length;
      report.extra += extra.length + foreign;
      if (apply && (missing.length || extra.length || foreign)) {
        const drifted = new Set([...missing, ...extra].map((k) => k.split("|")[0]));
        for (const r of rows) if (hexOf(r.fromBoardId) !== hexOf(board._id)) drifted.add(hexOf(r.fromRecordId));
        for (const id of drifted) await this.repairRecord(board, id, fields);
      }
      if (pauseMS) await new Promise((resolve) => setTimeout(resolve, pauseMS));
    }
    // Rows whose source record no longer exists (deleted without the cascade).
    const orphanRows = await this.links.aggregate([{ $match: { fromBoardId: oid(board._id) } }, { $lookup: { from: "records", localField: "fromRecordId", foreignField: "_id", as: "r", pipeline: [{ $project: { _id: 1 } }] } }, { $match: { r: { $size: 0 } } }, { $project: { _id: 1 } }]).toArray();
    report.extra += orphanRows.length;
    if (apply && orphanRows.length) await this.write((session) => this.links.deleteMany({ _id: { $in: orphanRows.map((r) => r._id) }, fromBoardId: oid(board._id) }, { session }));
    return report;
  }

  // One record's rows made equal to its CURRENT cell, under compare-and-set (see reconcile). → "repaired" | "gone" | "conflict".
  async repairRecord(board, recordId, fields) {
    return this.write(async (session) => {
      const fresh = await this.records.findOne({ _id: oid(recordId), boardId: oid(board._id) }, { session, projection: fields });
      if (!fresh) { await this.links.deleteMany({ fromRecordId: oid(recordId), fromBoardId: oid(board._id) }, { session }); return "gone"; }
      await this.step("repair-after-read");
      const cas = await this.records.updateOne({ _id: fresh._id, boardId: oid(board._id), version: fresh.version ?? null }, { $inc: { linkGuard: 1 } }, { session });
      if (cas.matchedCount !== 1) return "conflict"; // changed since the read: the writer that changed it keeps its own rows
      await this.syncRecord(board, fresh, { session, origin: "rebuild" });
      return "repaired";
    });
  }

  // Record deleted (already, by the caller): its own rows go; links TO it are pulled from the source cells (≤ BOUNDS.cascade in
  // this call; beyond that the caller schedules a paced sweep) and their rows go, in one transaction.
  async onRecordDeleted(recordId) { return this.write((session) => this.cascade(recordId, session)); }

  // The record delete AND its cascade in ONE transaction (the L2 wiring target for RSV.delete / deleteMany): a link save racing
  // it either commits first (the cascade, reading after it, pulls it) or loses the guard write (refused). boardId scopes it.
  async deleteRecord(boardId, recordId, { expectedVersion } = {}) {
    return this.write(async (session) => {
      const res = await this.records.deleteOne({ _id: oid(recordId), boardId: oid(boardId), ...(expectedVersion === undefined ? {} : { version: expectedVersion }) }, { session });
      if (res.deletedCount !== 1) throw failure(404, "NOT_FOUND", "The record no longer exists or was changed.");
      return this.cascade(recordId, session);
    });
  }

  async cascade(recordId, session) {
    const own = await this.links.deleteMany({ fromRecordId: oid(recordId) }, { session });
    const inbound = await this.links.find({ toRecordId: oid(recordId) }, { session, limit: BOUNDS.cascade + 1, projection: { _id: 1, fromRecordId: 1, fromBoardId: 1, columnKey: 1 } }).toArray();
    const now = inbound.slice(0, BOUNDS.cascade);
    for (const r of now) await this.records.updateOne({ _id: r.fromRecordId, boardId: r.fromBoardId }, { $pull: { [`values.${r.columnKey}`]: hexOf(recordId) }, $inc: { version: 1 } }, { session });
    if (now.length) await this.links.deleteMany({ _id: { $in: now.map((r) => r._id) } }, { session });
    return { own: own.deletedCount, pulled: now.length, more: inbound.length > BOUNDS.cascade };
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
