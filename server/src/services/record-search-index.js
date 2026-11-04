// The derived search index behind global search (repositories/mongo/record-search-repository.js).
//
//   RECORD_SEARCH_INDEX (config): "on" is the intended way search works: answers come from the index once it has caught up.
//                       "shadow" (production until the approved cutover) keeps the index up to date and compares it with
//                       the regular search, reporting only counts. "off" writes nothing and reads nothing.
//   regular search      reading the records' cells directly is TEMPORARY: it remains only as the recovery path (the moment the
//                       index isn't verified, and RECORD_SEARCH_INDEX=off as the rollback). Remove it once production has run
//                       on the index through verification; see the cutover section of server/README.md.
//   catch up     at start: per board, stored summaries are compared with the records and only what differs is rewritten,
//                then the whole index is verified. Search answers from the records until that passes, so an incomplete
//                index can never give incomplete results.
//   updates      after each change the affected records are queued and rewritten in the background. A save never waits
//                for this and never fails because of it. A failed update takes the index out of use until a catch up
//                has repaired and verified it again.
//   facets       the values of status, priority and People columns, so searches with those filters use the index too.
//   matching     the same text as the regular search: the item name and the text-like cells, strings only, compared
//                literally and case-insensitively. Cells are joined by a newline, which a query can never contain, so a
//                match can't span two cells.
//   access       the caller's boards are worked out by the search service exactly as before; this only narrows within them.
const crypto = require("crypto");
const { redact } = require("../db/connection");

const SEARCHABLE_TYPES = new Set(["text", "status", "priority", "dropdown", "email", "phone", "link", "date"]);
const MODES = Object.freeze(["off", "shadow", "on"]);
const BATCH = 200;
// Between batches of index writes. A batch is about 200 operations, so this alone holds rewriting under 400 per second, whatever
// the database's speed, against the Atlas Flex limit of 500.
const PAUSE_MS = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (id) => id.toHexString();

const searchableKeys = (board) => (board.columns || []).filter((c) => c.key === "serial" || SEARCHABLE_TYPES.has(c.type)).map((c) => c.key);
const keysOfType = (board, type) => (board.columns || []).filter((c) => c.type === type).map((c) => c.key);
const signature = (keys, facets = {}) => crypto.createHash("sha256").update(JSON.stringify([[...keys].sort(), ...["status", "priority", "owner"].map((f) => [...(facets[f] || [])].sort())])).digest("hex").slice(0, 12);
// What a board's columns contribute to its index documents.
const planOf = (board) => { const keys = searchableKeys(board), facets = { status: keysOfType(board, "status"), priority: keysOfType(board, "priority"), owner: keysOfType(board, "owner") }; return { keys, facets, sig: signature(keys, facets) }; };
const strings = (value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);

// One record → its index document. Pure, so it can be tested against the regular search's matching rules.
function searchDocument(record, { keys, facets, sig }) {
  const text = keys.flatMap((k) => strings(record.values?.[k])).filter(Boolean).join("\n").toLowerCase();
  const facet = (list) => [...new Set(list.flatMap((k) => strings(record.values?.[k])))];
  return { _id: record._id, boardId: record.boardId, archived: Boolean(record.archived), updatedAt: record.updatedAt ?? null, name: strings(record.values?.serial).join("\n").toLowerCase(), text, status: facet(facets.status), priority: facet(facets.priority), owner: facet(facets.owner), sig };
}

class RecordSearchIndex {
  constructor({ repos, logger = console, mode = "off", pauseMs = PAUSE_MS, repairMs = 60000 }) {
    if (!MODES.includes(mode)) throw new Error(`Unknown record search index mode: ${mode}`);
    Object.assign(this, { repos, logger, mode, pauseMs, repairMs, ready: false, repairTimer: null, queue: new Map(), draining: null });
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
        try { if (entry.all) await this.syncBoard(entry.boardId, { pause: this.pauseMs }); else await this.rewrite(entry.boardId, [...entry.ids.values()], { pause: this.pauseMs }); }
        catch (error) { this.fail("update failed; search uses the records until the index is repaired", error); this.needsRepair(); }
      }
    })().finally(() => { this.draining = null; if (this.queue.size) this.schedule(); });
  }
  // Out of use now; a catch up repairs and verifies it, and only then is it used again.
  needsRepair() {
    this.ready = false;
    if (this.repairTimer || !this.repairMs) return;
    this.repairTimer = setTimeout(() => { this.repairTimer = null; this.catchUp(); }, this.repairMs);
    this.repairTimer.unref?.();
  }
  // Waits until queued updates are written (tests and shutdown).
  async flush() { while (this.draining) await this.draining; }

  async rewrite(boardId, ids, { pause = 0 } = {}) {
    const board = await this.repos.boards.findById(boardId);
    if (!board) { await this.repos.recordSearch.removeBoard(boardId); return; }
    const plan = planOf(board);
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const records = await this.repos.records.findManyInBoard(boardId, chunk);
      await this.repos.recordSearch.upsertMany(records.map((r) => searchDocument(r, plan)));
      const found = new Set(records.map((r) => hex(r._id)));
      await this.repos.recordSearch.removeMany(chunk.filter((id) => !found.has(hex(id))));
      if (pause && i + BATCH < ids.length) await sleep(pause);
    }
  }

  // Brings one board's index in line with its records, rewriting only what differs. Returns the number rewritten.
  async syncBoard(boardId, { pause = 0 } = {}) {
    const board = await this.repos.boards.findById(boardId);
    if (!board) { await this.repos.recordSearch.removeBoard(boardId); return 0; }
    const { sig } = planOf(board);
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
      // Used only once verified complete. A change landing during the check just means one more pass.
      let health = await this.verify();
      for (let pass = 0; pass < 3 && (health.missing || health.stale || health.extra); pass += 1) { for (const id of known) rewritten += await this.syncBoard(id, { pause: this.pauseMs }); await this.flush(); health = await this.verify(); }
      if (health.missing || health.stale || health.extra) { this.needsRepair(); this.logger.warn?.(`[search-index] not used yet: ${health.missing} missing, ${health.stale} stale, ${health.extra} extra.`); return { boards, rewritten, health }; }
      this.ready = true;
      this.logger.log?.(`[search-index] ${this.mode}: ready, ${boards} board(s), ${rewritten} record(s) rewritten, ${Math.round((Date.now() - started) / 1000)} s.`);
      return { boards, rewritten, health };
    } catch (error) { this.fail("catch up failed; search keeps using the records", error); this.needsRepair(); }
    return { boards, rewritten };
  }

  // Read-only health check: how far the index is from the records. Reports counts only.
  async verify() {
    const out = { boards: 0, records: 0, indexed: 0, missing: 0, stale: 0, extra: 0 };
    for (const b of await this.repos.boards.collection.find({}, { projection: { _id: 1, columns: 1 } }).toArray()) {
      const { sig } = planOf(b), stored = new Map((await this.repos.recordSearch.summaries(b._id)).map((d) => [hex(d._id), d]));
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

  // ---- Search. Returns { _id, boardId, updatedAt } in result order; the search service then loads those records and builds its results.
  // boards: the caller's boards (already scoped by access). field: "text" or "name". pattern: the escaped, lower-cased query.
  hits(boards, { pattern = null, field = "text", extra = {}, and = [], limit, maxTimeMS }) {
    const clauses = boards.map((b) => ({ boardId: b._id, ...(pattern ? { [field]: { $regex: pattern } } : {}), ...extra, ...(and.length ? { $and: and } : {}) }));
    if (!clauses.length) return Promise.resolve([]);
    return this.repos.recordSearch.searchPage(clauses, { limit, maxTimeMS });
  }
  ids(boards, options) { return this.hits(boards, options).then((docs) => docs.map((d) => d._id)); }

  // Every matching record ID of one board, active or archived as asked (board search combines these with the board's filters).
  async boardIds(boardId, pattern, { maxTimeMS, archived = false }) {
    const docs = await this.repos.recordSearch.collection.find({ boardId, archived, text: { $regex: pattern } }, { projection: { _id: 1 }, maxTimeMS }).toArray();
    return docs.map((d) => d._id);
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

module.exports = { RecordSearchIndex, searchDocument, searchableKeys, planOf, signature, SEARCHABLE_TYPES, MODES };
