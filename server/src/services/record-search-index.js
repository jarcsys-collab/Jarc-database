// The derived search index behind global search (repositories/mongo/record-search-repository.js).
//
//   RECORD_SEARCH_INDEX (config): "off" (default) writes nothing and reads nothing; search works as it always has.
//                       "shadow" keeps the index up to date and compares it with the regular search, reporting only counts.
//                       "on" answers searches from the index once it has caught up with the records.
//   catch up     at start: per board, stored summaries are compared with the records and only what differs is rewritten,
//                so a restart after any missed update repairs it. Search keeps using the records until this finishes.
//   updates      after each change the affected records are queued and rewritten in the background. A save never waits
//                for this and never fails because of it; a failure is logged and the next catch up repairs it.
//   matching     the same text as the regular search: the item name and the text-like cells, strings only, compared
//                literally and case-insensitively. Cells are joined by a newline, which a query can never contain, so a
//                match can't span two cells.
//   access       the caller's boards are worked out by the search service exactly as before; this only narrows within them.
const crypto = require("crypto");
const { redact } = require("../db/connection");

const SEARCHABLE_TYPES = new Set(["text", "status", "priority", "dropdown", "email", "phone", "link", "date"]);
const MODES = Object.freeze(["off", "shadow", "on"]);
const BATCH = 200;
const PAUSE_MS = 100; // between catch-up batches: stays well inside a shared cluster's operation limits
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (id) => id.toHexString();

const searchableKeys = (board) => (board.columns || []).filter((c) => c.key === "serial" || SEARCHABLE_TYPES.has(c.type)).map((c) => c.key);
const signature = (keys) => crypto.createHash("sha256").update([...keys].sort().join("\n")).digest("hex").slice(0, 12);
const strings = (value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);

// One record → its index document. Pure, so it can be tested against the regular search's matching rules.
function searchDocument(record, keys, sig = signature(keys)) {
  const text = keys.flatMap((k) => strings(record.values?.[k])).filter(Boolean).join("\n").toLowerCase();
  return { _id: record._id, boardId: record.boardId, archived: Boolean(record.archived), updatedAt: record.updatedAt ?? null, name: strings(record.values?.serial).join("\n").toLowerCase(), text, sig };
}

class RecordSearchIndex {
  constructor({ repos, logger = console, mode = "off", pauseMs = PAUSE_MS }) {
    if (!MODES.includes(mode)) throw new Error(`Unknown record search index mode: ${mode}`);
    Object.assign(this, { repos, logger, mode, pauseMs, ready: false, queue: new Map(), draining: null });
  }

  get enabled() { return this.mode !== "off"; }
  // Searches are answered from the index only when it is switched on and has caught up.
  get active() { return this.mode === "on" && this.ready; }
  get shadowing() { return this.mode === "shadow" && this.ready; }

  fail(what, error) { this.logger.error(`[search-index] ${what}: ${error?.name || "Error"} ${redact(error?.message || "")}`); }

  // ---- Updates after changes. None of these throw or delay the caller.
  refresh(boardId, ids) {
    if (!this.enabled) return;
    const entry = this.queue.get(hex(boardId)) || { boardId, ids: new Map(), all: false };
    for (const id of ids) entry.ids.set(hex(id), id);
    this.queue.set(hex(boardId), entry);
    this.schedule();
  }
  refreshBoard(boardId) {
    if (!this.enabled) return;
    const entry = this.queue.get(hex(boardId)) || { boardId, ids: new Map(), all: false };
    entry.all = true;
    this.queue.set(hex(boardId), entry);
    this.schedule();
  }
  // Records and boards that are gone. Deleted IDs simply find no record during the rewrite and are removed.
  remove(boardId, ids) { this.refresh(boardId, ids); }
  removeBoards(boardIds) { for (const id of boardIds) this.refreshBoard(id); }

  schedule() {
    if (this.draining) return;
    this.draining = (async () => {
      await sleep(0);
      while (this.queue.size) {
        const [key, entry] = this.queue.entries().next().value;
        this.queue.delete(key);
        try { if (entry.all) await this.syncBoard(entry.boardId); else await this.rewrite(entry.boardId, [...entry.ids.values()]); }
        catch (error) { this.fail("update failed (repaired at the next start)", error); }
      }
    })().finally(() => { this.draining = null; if (this.queue.size) this.schedule(); });
  }
  // Waits until queued updates are written (tests and shutdown).
  async flush() { while (this.draining) await this.draining; }

  async rewrite(boardId, ids) {
    const board = await this.repos.boards.findById(boardId);
    if (!board) { await this.repos.recordSearch.removeBoard(boardId); return; }
    const keys = searchableKeys(board), sig = signature(keys);
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const records = await this.repos.records.findManyInBoard(boardId, chunk);
      await this.repos.recordSearch.upsertMany(records.map((r) => searchDocument(r, keys, sig)));
      const found = new Set(records.map((r) => hex(r._id)));
      await this.repos.recordSearch.removeMany(chunk.filter((id) => !found.has(hex(id))));
    }
  }

  // Brings one board's index in line with its records, rewriting only what differs. Returns the number rewritten.
  async syncBoard(boardId, { pause = 0 } = {}) {
    const board = await this.repos.boards.findById(boardId);
    if (!board) { await this.repos.recordSearch.removeBoard(boardId); return 0; }
    const sig = signature(searchableKeys(board));
    const stored = new Map((await this.repos.recordSearch.summaries(boardId)).map((d) => [hex(d._id), d]));
    const stale = [];
    for (const r of await this.repos.records.collection.find({ boardId }, { projection: { _id: 1, updatedAt: 1, archived: 1 } }).toArray()) {
      const s = stored.get(hex(r._id));
      stored.delete(hex(r._id));
      if (!s || s.sig !== sig || Boolean(s.archived) !== Boolean(r.archived) || (s.updatedAt?.getTime?.() ?? null) !== (r.updatedAt?.getTime?.() ?? null)) stale.push(r._id);
    }
    await this.repos.recordSearch.removeMany([...stored.values()].map((d) => d._id));
    for (let i = 0; i < stale.length; i += BATCH) {
      await this.rewrite(boardId, stale.slice(i, i + BATCH));
      if (pause) await sleep(pause);
    }
    return stale.length;
  }

  // Runs at start when switched on. Search keeps using the records until it finishes. Never throws.
  async catchUp() {
    if (!this.enabled) return { boards: 0, rewritten: 0 };
    const started = Date.now();
    let rewritten = 0, boards = 0;
    try {
      const known = (await this.repos.boards.collection.find({}, { projection: { _id: 1 } }).toArray()).map((b) => b._id);
      for (const id of known) { rewritten += await this.syncBoard(id, { pause: this.pauseMs }); boards += 1; }
      // Index documents of boards that no longer exist.
      await this.repos.recordSearch.collection.deleteMany({ boardId: { $nin: known } });
      await this.flush();
      this.ready = true;
      this.logger.log?.(`[search-index] ${this.mode}: ready, ${boards} board(s), ${rewritten} record(s) rewritten, ${Math.round((Date.now() - started) / 1000)} s.`);
    } catch (error) { this.fail("catch up failed; search keeps using the records", error); }
    return { boards, rewritten };
  }

  // Read-only health check: how far the index is from the records. Reports counts only.
  async verify() {
    const out = { boards: 0, records: 0, indexed: 0, missing: 0, stale: 0, extra: 0 };
    for (const b of await this.repos.boards.collection.find({}, { projection: { _id: 1, columns: 1 } }).toArray()) {
      const sig = signature(searchableKeys(b)), stored = new Map((await this.repos.recordSearch.summaries(b._id)).map((d) => [hex(d._id), d]));
      out.boards += 1; out.indexed += stored.size;
      for (const r of await this.repos.records.collection.find({ boardId: b._id }, { projection: { _id: 1, updatedAt: 1, archived: 1 } }).toArray()) {
        out.records += 1;
        const s = stored.get(hex(r._id));
        stored.delete(hex(r._id));
        if (!s) out.missing += 1;
        else if (s.sig !== sig || Boolean(s.archived) !== Boolean(r.archived) || (s.updatedAt?.getTime?.() ?? null) !== (r.updatedAt?.getTime?.() ?? null)) out.stale += 1;
      }
      out.extra += stored.size;
    }
    return out;
  }

  // ---- Search. Returns the IDs in result order; the search service then loads those records and builds its results.
  // boards: the caller's boards (already scoped by access). field: "text" or "name". pattern: the escaped, lower-cased query.
  ids(boards, { pattern, field = "text", extra = {}, and = [], limit, maxTimeMS }) {
    const clauses = boards.map((b) => ({ boardId: b._id, [field]: { $regex: pattern }, ...extra, ...(and.length ? { $and: and } : {}) }));
    if (!clauses.length) return Promise.resolve([]);
    return this.repos.recordSearch.searchPage(clauses, { limit, maxTimeMS }).then((docs) => docs.map((d) => d._id));
  }

  // Shadow mode: compares a finished regular search with the index. Logs counts only, never the search text or results.
  compare(regularIds, boards, options) {
    this.ids(boards, options).then((indexed) => {
      const a = new Set(regularIds.map(hex)), b = new Set(indexed.map(hex));
      const missing = [...a].filter((x) => !b.has(x)).length, extra = [...b].filter((x) => !a.has(x)).length;
      if (missing || extra) this.logger.warn?.(`[search-index] shadow difference: regular ${a.size}, index ${b.size}, only regular ${missing}, only index ${extra}.`);
    }).catch((error) => this.fail("shadow comparison failed", error));
  }
}

module.exports = { RecordSearchIndex, searchDocument, searchableKeys, signature, SEARCHABLE_TYPES, MODES };
