// The in-memory directory snapshot: projected, normalised records only (fields.js), never written anywhere (no copy in JARC's
// database, no browser storage). Served from memory; the source is read only by:
//   - a check (at most every CHECK_MS, lazily on a request): one aggregate reading only the newest ingestion time and the count;
//   - a full load, only when that check shows a change (or there is no snapshot yet). Single-flight: concurrent requests share
//     one check/load.
// Acceptance (a full-replace upstream refresh may be half done): every document has a GUID user_id, the IDs are unique, and the
// count is at least MIN_RATIO of the previous snapshot (the first load: more than 0). A rejected load or a failed check keeps
// the last good snapshot, marked stale with a reason. Stale also when the last successful check is older than STALE_MS. With no
// snapshot at all, reads fail with 503 EMPLOYEES_UNAVAILABLE.
// Logs: counts and reason codes only, never a value.
const { normalize, PROJECTION } = require("./fields");
const { profileId } = require("./ids");
const { employeeError, describe } = require("./errors");

const CHECK_MS = 5 * 60 * 1000;
const STALE_MS = 30 * 60 * 1000;
const COLD_RETRY_MS = 10 * 1000; // without a snapshot, a failed load is retried at most this often
const MIN_RATIO = 0.9;
const SCAN_MAX = 20000;

// The source reads (the connection's single collection). Tests may replace it.
function directorySource(connection, { queryTimeMs = 8000 } = {}) {
  const run = async (fn) => {
    try { return await fn(await connection.collection()); } catch (error) {
      if (error?.code !== "EMPLOYEES_UNAVAILABLE") await connection.reset?.();
      throw error;
    }
  };
  return {
    // → { max: newest ingestion time (as stored), n: documents }
    probe: () => run(async (c) => {
      const [row] = await c.aggregate([{ $group: { _id: null, max: { $max: "$ingestion_datetime" }, n: { $sum: 1 } } }], { maxTimeMS: queryTimeMs }).toArray();
      return { max: row?.max ?? null, n: Number.isInteger(row?.n) ? row.n : 0 };
    }),
    // → the projected documents (at most SCAN_MAX + 1).
    loadAll: () => run((c) => c.find({}, { projection: { ...PROJECTION }, limit: SCAN_MAX + 1, maxTimeMS: queryTimeMs }).toArray())
  };
}

const iso = (v) => { if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString(); if (typeof v === "string") { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); } return null; };
const sameMax = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

class EmployeeSnapshot {
  // source: { probe(), loadAll() }; idKey: the profile ID key (Buffer); now: () => ms.
  constructor({ source, idKey, now = Date.now, logger = console }) {
    if (!source || !idKey) throw new Error("EmployeeSnapshot needs a source and an ID key.");
    this.source = source;
    Object.defineProperty(this, "idKey", { value: idKey, enumerable: false });
    this.now = now;
    this.logger = logger;
    this.snap = null;
    this.checkedAt = null; // last successful check (ms)
    this.attemptAt = null; // last attempt (ms)
    this.failure = null; // reason of the last failed attempt, or null
    this.inFlight = null;
    this.version = 0;
  }

  // The current snapshot (waits only when there is none yet). A due check runs in the background.
  async current() {
    const t = this.now();
    if (!this.snap) {
      if (this.inFlight) await this.inFlight;
      else if (this.attemptAt === null || t - this.attemptAt >= COLD_RETRY_MS) await this.refresh();
      if (!this.snap) throw employeeError("EMPLOYEES_UNAVAILABLE");
      return this.snap;
    }
    if (!this.inFlight && (this.attemptAt === null || t - this.attemptAt >= CHECK_MS)) this.refresh().catch(() => {});
    return this.snap;
  }

  // One check (and a load when needed). Never throws: failures are recorded as the stale reason.
  refresh() {
    this.inFlight ??= this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async run() {
    this.attemptAt = this.now();
    let probe;
    try { probe = await this.source.probe(); } catch (error) { return this.failed("source_unavailable", error); }
    if (this.snap && sameMax(probe.max, this.snap.rawMax) && probe.n === this.snap.count) { this.ok(); return; }
    let docs;
    try { docs = await this.source.loadAll(); } catch (error) { return this.failed("source_unavailable", error); }
    // An unexpected document must never become a 500 or skip the stale marking: it rejects this load like any other
    // acceptance failure (the last good snapshot stays, marked stale; with none, requests answer 503 EMPLOYEES_UNAVAILABLE).
    let built;
    try { built = this.build(docs, probe.max); } catch (error) { return this.failed("snapshot_rejected", error, "invalid_document"); }
    if (!built.ok) return this.failed("snapshot_rejected", null, built.reason);
    this.snap = built.snap;
    this.version += 1;
    this.ok();
    this.logger.info?.(`[employees] snapshot loaded: ${built.snap.count} accounts`);
    this.logger.info?.(`[employees] office values withheld: ${built.officeWithheld}`);
  }

  ok() { this.checkedAt = this.now(); this.failure = null; }
  failed(reason, error, detail) {
    this.failure = reason;
    this.logger.warn?.(`[employees] snapshot ${reason === "snapshot_rejected" ? `rejected (${detail})` : `check failed: ${describe(error)}`}${this.snap ? "; serving the last good snapshot" : ""}`);
  }

  // Acceptance + normalisation. → { ok: true, snap, officeWithheld } | { ok: false, reason }
  // oidById (P2): profile ID → lowercase object ID, the only link from a directory record to a JARC user (jarc-access.js). It is
  // a non-enumerable property holding a Map, so it never reaches JSON, a response or a log; nothing outside the access index
  // reads it.
  build(docs, rawMax) {
    if (!Array.isArray(docs) || !docs.length) return { ok: false, reason: "empty" };
    if (docs.length > SCAN_MAX) return { ok: false, reason: "too_large" };
    const records = [], byId = new Map(), oids = new Set(), oidById = new Map();
    let newest = null, officeWithheld = 0;
    for (const doc of docs) {
      const n = normalize(doc);
      if (!n) return { ok: false, reason: "invalid_id" };
      if (oids.has(n.oid)) return { ok: false, reason: "duplicate_id" };
      oids.add(n.oid);
      const id = profileId(this.idKey, n.oid);
      if (byId.has(id)) return { ok: false, reason: "duplicate_id" };
      const record = Object.freeze({ id, values: n.values });
      records.push(record); byId.set(id, record); oidById.set(id, n.oid);
      if (n.officeWithheld) officeWithheld += 1;
      const at = iso(doc.ingestion_datetime);
      if (at && (!newest || at > newest)) newest = at;
    }
    if (this.snap && records.length < Math.ceil(this.snap.count * MIN_RATIO)) return { ok: false, reason: "count_drop" };
    const loadedAt = new Date(this.now()).toISOString();
    const snap = { records: Object.freeze(records), byId, count: records.length, ingestedAt: newest ?? iso(rawMax), rawMax, loadedAt };
    Object.defineProperty(snap, "oidById", { value: oidById, enumerable: false });
    return { ok: true, snap: Object.freeze(snap), officeWithheld };
  }

  // { ingestedAt, loadedAt, checkedAt, stale, staleReason? } for responses.
  meta() {
    const t = this.now();
    const overdue = this.checkedAt === null || t - this.checkedAt > STALE_MS;
    const reason = this.failure || (overdue ? "check_overdue" : null);
    return { ingestedAt: this.snap?.ingestedAt ?? null, loadedAt: this.snap?.loadedAt ?? null, checkedAt: this.checkedAt === null ? null : new Date(this.checkedAt).toISOString(), stale: Boolean(reason), ...(reason ? { staleReason: reason } : {}) };
  }
}

module.exports = { EmployeeSnapshot, directorySource, CHECK_MS, STALE_MS, COLD_RETRY_MS, MIN_RATIO, SCAN_MAX };
