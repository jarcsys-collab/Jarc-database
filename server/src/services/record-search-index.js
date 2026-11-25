// The derived search index behind global search (repositories/mongo/record-search-repository.js).
//
//   RECORD_SEARCH_INDEX (config): "on" is the intended way search works: answers come from the index once it has caught up.
//                       "shadow" (production until the approved cutover) keeps the index up to date and compares it with
//                       the regular search, reporting only counts. "off" writes nothing and reads nothing.
//   regular search      reading the records' cells directly is TEMPORARY: it remains only as the recovery path (the moment the
//                       index isn't verified, and RECORD_SEARCH_INDEX=off as the rollback). Remove it once production has run
//                       on the index through verification; see the cutover section of server/README.md.
//   start (server)  start() runs an INCREMENTAL pass (never a scan of every record), then repeats it every 10 minutes:
//                   - boards marked for a full rewrite (column changes, deletions; the marks are stored, so they survive a
//                     restart) are rewritten board by board;
//                   - two index documents per board are sampled for a column signature that no longer matches;
//                   - per board, only records with updatedAt >= the stored watermark are compared (board_updated index,
//                     covered: _id and updatedAt only), 200 at a time with a pause, and only what differs is rewritten;
//                   - records deleted since the watermark (the activity log) and index documents of boards that are gone are
//                     removed, each only after re-checking the record or board really is gone.
//                   A pass is resumable: its progress (boards done, the position within a board) is stored after every batch.
//                   When it finishes the watermark moves to its start time minus a 5 minute margin (never past an update
//                   still waiting in the queue).
//   baseline        the index is used only once a full catch up (catchUp(), scripts/search-index.js rebuild, or
//                   scripts/record-search-reconcile.js --apply) has completed cleanly on this database; until then search
//                   answers from the records and start() only logs that the baseline is missing.
//   full catch up   catchUp() + verify(): on demand only (scripts, tests). Reads every record; paced.
//   updates      after each change the affected records are queued and rewritten in the background. A save never waits
//                for this and never fails because of it. A failed update takes the index out of use; the failed entries
//                are retried after a minute and an incremental pass then puts it back in use.
//   durability   the queue is in memory. Lost entries (crash, redeploy) are recovered by the watermark pass: every record
//                write sets updatedAt, so a record changed after the stored watermark is compared at the next pass (at most
//                10 minutes later, or at the next start). Board-wide rewrites are stored as marks first. Deletions are found
//                again in the activity log. On SIGTERM the queue is drained for up to 5 seconds (stop()).
//   concurrency  an index document is never replaced by one built from an older version of the record (see
//                guardedUpsert), so two servers during a deploy overlap, or a script, can't put older text over newer.
//   facets       the values of status, priority and People columns, so searches with those filters use the index too.
//   matching     the same text as the regular search: the item name and the text-like cells, strings only, compared
//                literally and case-insensitively. Cells are joined by a newline, which a query can never contain, so a
//                match can't span two cells.
//   access       the caller's boards are worked out by the search service exactly as before; this only narrows within them.
//   logging      counts, error names and codes only: never error messages, which can echo record text or a query.
const crypto = require("crypto");
const { ObjectId } = require("mongodb");

const SEARCHABLE_TYPES = new Set(["text", "status", "priority", "dropdown", "email", "phone", "link", "date"]);
const MODES = Object.freeze(["off", "shadow", "on"]);
const BATCH = 200;
// Between batches of index writes. A batch is about 200 operations, so this alone holds rewriting under 400 per second, whatever
// the database's speed, against the Atlas Flex limit of 500.
const PAUSE_MS = 500;
const STATE_ID = "sync";
const MARGIN_MS = 5 * 60 * 1000; // a write's updatedAt can precede its commit (and clocks differ slightly between servers)
const PASS_EVERY_MS = 10 * 60 * 1000;
const STOP_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (id) => id.toHexString();
const time = (d) => d?.getTime?.() ?? null;

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
// Index writes for records that were just inserted (the monday.com migration, inside its own transaction): a new record
// can only have an index document left behind by a removed one, so it is replaced outright.
function insertedRecordOps(records, boardsById) {
  return records.map((r) => { const { _id, ...set } = searchDocument(r, planOf(boardsById.get(hex(r.boardId)) || { columns: [] })); return { updateOne: { filter: { _id }, update: { $set: set }, upsert: true } }; });
}
// Whether a stored summary differs from what the record says ({ _id, updatedAt, archived? }).
const differs = (stored, record, sig, boardId = null) => !stored || stored.sig !== sig || Boolean(boardId && !stored.boardId?.equals?.(boardId)) || time(stored.updatedAt) !== time(record.updatedAt) || (record.archived !== undefined && Boolean(stored.archived) !== Boolean(record.archived));

class RecordSearchIndex {
  constructor({ repos, logger = console, mode = "off", pauseMs = PAUSE_MS, repairMs = 60000, passEveryMs = PASS_EVERY_MS, marginMs = MARGIN_MS, now = () => new Date() }) {
    if (!MODES.includes(mode)) throw new Error(`Unknown record search index mode: ${mode}`);
    Object.assign(this, { repos, logger, mode, pauseMs, repairMs, passEveryMs, marginMs, now, ready: false, repairTimer: null, passTimer: null, queue: new Map(), failed: new Map(), inflight: null, draining: null, marks: new Set(), passing: null, full: null, baselineWarned: false, reported: false });
  }

  get enabled() { return this.mode !== "off"; }
  // Searches are answered from the index only when it is switched on and has caught up.
  get active() { return this.mode === "on" && this.ready; }
  get shadowing() { return this.mode === "shadow" && this.ready; }
  get state() { return this.repos.recordSearch.state; }

  // Error name and code only (never the message: it can echo record text or a search).
  fail(what, error) { this.logger.error(`[search-index] ${what}: ${error?.name || "Error"}${error?.codeName || error?.code ? ` ${error.codeName || error.code}` : ""}`); }

  // ---- Updates after changes. None of these throw or delay the caller.
  entry(boardId) { const key = hex(boardId); const e = this.queue.get(key) || { boardId, ids: new Map(), all: false, since: Date.now() }; this.queue.set(key, e); return e; }
  refresh(boardId, ids) {
    if (!this.enabled) return;
    const entry = this.entry(boardId);
    for (const id of ids) entry.ids.set(hex(id), id);
    this.schedule();
  }
  // A whole board (columns changed, board deleted): stored as a mark first, so a restart before the rewrite still does it.
  refreshBoard(boardId) {
    if (!this.enabled) return;
    this.track(this.state.updateOne({ _id: STATE_ID }, { $max: { [`dirty.${hex(boardId)}`]: this.now() } }, { upsert: true }));
    this.entry(boardId).all = true;
    this.schedule();
  }
  // Records and boards that are gone. Deleted IDs simply find no record during the rewrite and are removed.
  remove(boardId, ids) { this.refresh(boardId, ids); }
  removeBoards(boardIds) { for (const id of boardIds) this.refreshBoard(id); }
  track(promise) {
    const p = Promise.resolve(promise).catch((error) => this.fail("could not store a board for the next catch up", error)).finally(() => this.marks.delete(p));
    this.marks.add(p);
  }

  schedule() {
    if (this.draining) return;
    this.draining = (async () => {
      await sleep(0);
      while (this.queue.size) {
        const [key, entry] = this.queue.entries().next().value;
        this.queue.delete(key);
        this.inflight = entry;
        try {
          if (entry.all) { await Promise.all([...this.marks]); await this.syncBoard(entry.boardId, { pause: this.pauseMs }); }
          else await this.rewrite(entry.boardId, [...entry.ids.values()], { pause: this.pauseMs });
        } catch (error) { this.fail("update failed; search uses the records until the index is repaired", error); this.keepFailed(key, entry); this.needsRepair(); }
        finally { this.inflight = null; }
      }
    })().finally(() => { this.draining = null; if (this.queue.size) this.schedule(); });
  }
  keepFailed(key, entry) {
    const f = this.failed.get(key);
    if (!f) { this.failed.set(key, entry); return; }
    for (const [k, id] of entry.ids) f.ids.set(k, id);
    f.all ||= entry.all; f.since = Math.min(f.since, entry.since);
  }
  // The earliest time of an update not yet written (queued, being written or failed), or null.
  oldestPending() {
    const all = [...this.queue.values(), ...this.failed.values(), ...(this.inflight ? [this.inflight] : [])];
    return all.length ? Math.min(...all.map((e) => e.since)) : null;
  }
  // Out of use now; failed entries are retried and an incremental pass puts it back in use.
  needsRepair() {
    this.ready = false;
    if (this.repairTimer || !this.repairMs) return;
    this.repairTimer = setTimeout(() => { this.repairTimer = null; this.repair(); }, this.repairMs);
    this.repairTimer.unref?.();
  }
  async repair() {
    for (const [key, f] of this.failed) { const e = this.entry(f.boardId); for (const [k, id] of f.ids) e.ids.set(k, id); e.all ||= f.all; e.since = Math.min(e.since, f.since); this.failed.delete(key); }
    this.schedule();
    await this.flush();
    if (this.failed.size) return this.needsRepair();
    return this.incremental();
  }
  // Waits until queued updates (and stored board marks) are written (tests and shutdown).
  async flush() { while (this.draining || this.marks.size) await Promise.all([this.draining, ...this.marks]); }

  // ---- Server lifetime: an incremental pass at start and every 10 minutes; a bounded drain at shutdown.
  start() {
    if (!this.enabled) return null;
    const first = this.incremental();
    if (this.passEveryMs && !this.passTimer) { this.passTimer = setInterval(() => this.incremental(), this.passEveryMs); this.passTimer.unref?.(); }
    return first;
  }
  async stop({ timeoutMs = STOP_MS } = {}) {
    clearInterval(this.passTimer); this.passTimer = null;
    clearTimeout(this.repairTimer); this.repairTimer = null;
    let timer;
    const drained = await Promise.race([this.flush().then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
    clearTimeout(timer);
    if (!drained) this.logger.warn?.(`[search-index] stopped with ${this.queue.size} board(s) of updates still queued; the next pass covers them.`);
    return drained;
  }

  // Rewrites the given records of one board from the records (a record that is gone loses its index document).
  async rewrite(boardId, ids, { pause = 0 } = {}) {
    const board = await this.repos.boards.findById(boardId);
    if (!board) { await this.repos.recordSearch.removeBoard(boardId); return; }
    const plan = planOf(board);
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const records = await this.repos.records.findManyInBoard(boardId, chunk);
      const docs = records.map((r) => searchDocument(r, plan));
      const result = await this.repos.recordSearch.upsertMany(docs);
      if (result?.skipped?.length) await this.settleSkipped(boardId, plan, docs.filter((d) => result.skipped.some((id) => id.equals(d._id))));
      const found = new Set(records.map((r) => hex(r._id)));
      await this.repos.recordSearch.removeMany(chunk.filter((id) => !found.has(hex(id))));
      if (pause && i + BATCH < ids.length) await sleep(pause);
    }
  }
  // A write was skipped because a newer-looking document is stored. If the record still says what we wrote (its
  // updatedAt went backwards: a direct database edit), the stored one is wrong and is replaced, only if unchanged meanwhile.
  async settleSkipped(boardId, plan, docs) {
    const live = new Map((await this.repos.records.findManyInBoard(boardId, docs.map((d) => d._id))).map((r) => [hex(r._id), r]));
    const stored = new Map((await this.repos.recordSearch.summariesOf(docs.map((d) => d._id))).map((s) => [hex(s._id), s]));
    for (const d of docs) {
      const r = live.get(hex(d._id)), s = stored.get(hex(d._id));
      if (!r || !s || time(r.updatedAt) !== time(d.updatedAt)) continue; // the record moved on: its own refresh writes it
      const { _id, ...set } = searchDocument(r, plan);
      await this.repos.recordSearch.collection.updateOne({ _id, updatedAt: s.updatedAt ?? null }, { $set: set });
    }
  }

  // Brings one board's index in line with its records, rewriting only what differs. Returns the number rewritten.
  async syncBoard(boardId, { pause = 0 } = {}) {
    const started = this.now();
    const board = await this.repos.boards.findById(boardId);
    if (!board) { await this.repos.recordSearch.removeBoard(boardId); await this.clearMark(boardId, started); return 0; }
    const { sig } = planOf(board);
    const stored = new Map((await this.repos.recordSearch.summaries(boardId)).map((d) => [hex(d._id), d]));
    const stale = [];
    for (const r of await this.repos.records.collection.find({ boardId }, { projection: { _id: 1, updatedAt: 1, archived: 1 } }).toArray()) {
      const s = stored.get(hex(r._id));
      stored.delete(hex(r._id));
      if (differs(s, r, sig)) stale.push(r._id);
    }
    await this.repos.recordSearch.removeMany([...stored.values()].map((d) => d._id));
    for (let i = 0; i < stale.length; i += BATCH) {
      await this.rewrite(boardId, stale.slice(i, i + BATCH));
      if (pause) await sleep(pause);
    }
    await this.clearMark(boardId, started);
    return stale.length;
  }
  // The board's mark goes only if nobody marked it again after this rewrite started.
  clearMark(boardId, started) { return this.state.updateOne({ _id: STATE_ID, [`dirty.${hex(boardId)}`]: { $lte: started } }, { $unset: { [`dirty.${hex(boardId)}`]: "" } }); }

  // FULL catch up: every board, every record (on demand: scripts/search-index.js rebuild, tests). Search keeps using the
  // records until it finishes; when it verifies clean it records the baseline the incremental passes build on. Never throws.
  catchUp() {
    if (!this.enabled) return Promise.resolve({ boards: 0, rewritten: 0 });
    if (this.full) return this.full;
    this.full = (async () => { if (this.passing) await this.passing; return this.fullCatchUp(); })().finally(() => { this.full = null; });
    return this.full;
  }
  async fullCatchUp() {
    const started = Date.now(), startedAt = this.now();
    let rewritten = 0, boards = 0;
    try {
      this.failed.clear(); // everything is compared again below
      const known = (await this.repos.boards.collection.find({}, { projection: { _id: 1 } }).toArray()).map((b) => b._id);
      for (const id of known) { rewritten += await this.syncBoard(id, { pause: this.pauseMs }); boards += 1; }
      // Index documents of boards that no longer exist.
      await this.repos.recordSearch.collection.deleteMany({ boardId: { $nin: known } });
      await this.flush();
      // Used only once verified complete. A change landing during the check just means one more pass.
      let health = await this.verify();
      for (let pass = 0; pass < 3 && (health.missing || health.stale || health.extra); pass += 1) { for (const id of known) rewritten += await this.syncBoard(id, { pause: this.pauseMs }); await this.flush(); health = await this.verify(); }
      if (health.missing || health.stale || health.extra) { this.needsRepair(); this.logger.warn?.(`[search-index] not used yet: ${health.missing} missing, ${health.stale} stale, ${health.extra} extra.`); return { boards, rewritten, health }; }
      await this.recordBaseline(startedAt);
      this.ready = true;
      this.logger.log?.(`[search-index] ${this.mode}: ready, ${boards} board(s), ${rewritten} record(s) rewritten, ${Math.round((Date.now() - started) / 1000)} s.`);
      return { boards, rewritten, health };
    } catch (error) { this.fail("catch up failed; search keeps using the records", error); this.needsRepair(); }
    return { boards, rewritten };
  }
  // After a clean full comparison that started at `startedAt`: everything changed before it (minus the margin) is indexed.
  recordBaseline(startedAt) {
    const watermark = new Date(Math.min(startedAt.getTime(), this.oldestPending() ?? Infinity) - this.marginMs);
    return this.state.updateOne({ _id: STATE_ID }, { $set: { baselineAt: this.now(), watermark }, $unset: { pass: "" } }, { upsert: true });
  }

  // ---- INCREMENTAL pass (start-up, every 10 minutes, after a repair). Bounded by what changed since the watermark. Never throws.
  incremental() {
    if (!this.enabled) return Promise.resolve({ boards: 0, rewritten: 0 });
    if (this.passing) return this.passing;
    if (this.full) return this.full;
    this.passing = this.runPass().finally(() => { this.passing = null; });
    return this.passing;
  }
  async runPass() {
    const started = Date.now();
    const out = { boards: 0, checked: 0, rewritten: 0, removed: 0, boardsRewritten: 0, resumed: false };
    try {
      const state = await this.state.findOne({ _id: STATE_ID });
      if (!state?.baselineAt) {
        this.ready = false;
        if (!this.baselineWarned) this.logger.warn?.("[search-index] no baseline yet: search uses the records until a full catch up has completed (scripts/record-search-reconcile.js, see the runbook).");
        this.baselineWarned = true;
        for (const id of Object.keys(state?.dirty || {})) await this.syncBoard(new ObjectId(id), { pause: this.pauseMs });
        return { ...out, baseline: false };
      }
      let pass = state.pass;
      if (pass?.from) out.resumed = true;
      else { pass = { startedAt: this.now(), from: state.watermark || new Date(state.baselineAt.getTime() - this.marginMs), done: [], cursor: null }; await this.state.updateOne({ _id: STATE_ID }, { $set: { pass } }); }
      const done = new Set(pass.done || []);
      // 1. Boards marked for a full rewrite.
      for (const id of Object.keys(state.dirty || {})) { out.rewritten += await this.syncBoard(new ObjectId(id), { pause: this.pauseMs }); out.boardsRewritten += 1; done.add(id); }
      // 2. Every board: a signature sample, then the records changed since the watermark.
      const boards = await this.repos.boards.collection.find({}, { projection: { _id: 1, columns: 1 } }).toArray();
      for (const b of boards) {
        const h = hex(b._id);
        if (done.has(h)) continue;
        const plan = planOf(b);
        if (await this.signatureDrift(b._id, plan.sig)) { out.rewritten += await this.syncBoard(b._id, { pause: this.pauseMs }); out.boardsRewritten += 1; }
        else { const r = await this.changedSince(b._id, plan, pass.from, pass.cursor?.board === h ? pass.cursor : null); out.checked += r.checked; out.rewritten += r.rewritten; }
        await this.state.updateOne({ _id: STATE_ID }, { $push: { "pass.done": h }, $set: { "pass.cursor": null } });
        out.boards += 1;
      }
      // 3. Deletions.
      out.removed += await this.deletedSince(pass.from);
      out.removed += await this.goneBoards(new Set(boards.map((b) => hex(b._id))));
      const watermark = new Date(Math.min(new Date(pass.startedAt).getTime(), this.oldestPending() ?? Infinity) - this.marginMs);
      await this.state.updateOne({ _id: STATE_ID }, { $set: { watermark, lastPass: { ...out, at: this.now(), ms: Date.now() - started } }, $unset: { pass: "" } });
      if (!this.failed.size) this.ready = true;
      if (out.rewritten || out.removed || out.resumed || !this.reported) this.logger.log?.(`[search-index] ${this.mode}: incremental pass${out.resumed ? " (resumed)" : ""}, ${out.boards} board(s), ${out.checked} changed record(s) checked, ${out.rewritten} rewritten, ${out.removed} removed, ${Math.round((Date.now() - started) / 100) / 10} s.`);
      this.reported = true;
      return out;
    } catch (error) { this.fail("incremental catch up failed; it resumes on the next pass", error); this.needsRepair(); return { ...out, failed: true }; }
  }
  // Two index documents (oldest and newest) with another column signature mean the board's columns changed unseen.
  async signatureDrift(boardId, sig) {
    for (const dir of [1, -1]) {
      const [d] = await this.repos.recordSearch.collection.find({ boardId }, { projection: { _id: 1, sig: 1 }, sort: { updatedAt: dir, _id: dir }, limit: 1 }).toArray();
      if (d && d.sig !== sig) return true;
    }
    return false;
  }
  // The board's records with updatedAt >= from, oldest first, 200 at a time; resumable from { t, id }.
  async changedSince(boardId, plan, from, cursor) {
    let after = cursor ? { t: new Date(cursor.t), id: cursor.id } : null, checked = 0, rewritten = 0;
    for (;;) {
      const filter = after ? { boardId, $or: [{ updatedAt: { $gt: after.t } }, { updatedAt: after.t, _id: { $gt: after.id } }] } : { boardId, updatedAt: { $gte: new Date(from) } };
      const rows = await this.repos.records.collection.find(filter, { projection: { _id: 1, updatedAt: 1 }, sort: { updatedAt: 1, _id: 1 }, limit: BATCH }).toArray();
      if (!rows.length) break;
      const stored = new Map((await this.repos.recordSearch.summariesOf(rows.map((r) => r._id))).map((d) => [hex(d._id), d]));
      const stale = rows.filter((r) => differs(stored.get(hex(r._id)), r, plan.sig, boardId)).map((r) => r._id);
      if (stale.length) await this.rewrite(boardId, stale);
      checked += rows.length; rewritten += stale.length;
      const last = rows.at(-1); after = { t: last.updatedAt, id: last._id };
      await this.state.updateOne({ _id: STATE_ID }, { $set: { "pass.cursor": { board: hex(boardId), t: after.t, id: after.id } } });
      if (rows.length < BATCH) break;
      if (this.pauseMs) await sleep(this.pauseMs);
    }
    return { checked, rewritten };
  }
  // Records deleted since `from` (from the activity log) whose index document is still there and whose record is gone.
  async deletedSince(from) {
    const activities = this.repos.activities?.collection;
    if (!activities) return 0;
    let after = null, removed = 0;
    for (;;) {
      const filter = { action: "record.deleted", ...(after ? { $or: [{ createdAt: { $gt: after.t } }, { createdAt: after.t, _id: { $gt: after.id } }] } : { createdAt: { $gte: new Date(from) } }) };
      const rows = await activities.find(filter, { projection: { _id: 1, recordId: 1, createdAt: 1 }, sort: { createdAt: 1, _id: 1 }, limit: BATCH }).toArray();
      if (!rows.length) break;
      removed += await this.removeOrphans(rows.map((r) => r.recordId).filter(Boolean));
      const last = rows.at(-1); after = { t: last.createdAt, id: last._id };
      if (rows.length < BATCH) break;
      if (this.pauseMs) await sleep(this.pauseMs);
    }
    return removed;
  }
  // Removes the index documents of these record IDs whose record really is gone (re-checked), if unchanged meanwhile.
  async removeOrphans(ids) {
    const present = await this.repos.recordSearch.summariesOf(ids);
    if (!present.length) return 0;
    const live = new Set((await this.repos.records.collection.find({ _id: { $in: present.map((d) => d._id) } }, { projection: { _id: 1 } }).toArray()).map((r) => hex(r._id)));
    return this.repos.recordSearch.removeUnchanged(present.filter((d) => !live.has(hex(d._id))));
  }
  // Index documents of boards that are gone: one indexed look-up per board in the index (boardId order), each re-checked.
  async goneBoards(live) {
    let last = null, removed = 0;
    for (let i = 0; i < 100000; i += 1) {
      const [d] = await this.repos.recordSearch.collection.find(last ? { boardId: { $gt: last } } : {}, { projection: { _id: 0, boardId: 1 }, sort: { boardId: 1 }, limit: 1 }).toArray();
      if (!d?.boardId) break;
      last = d.boardId;
      if (live.has(hex(last)) || await this.repos.boards.findById(last)) continue;
      removed += await this.repos.recordSearch.count({ boardId: last });
      await this.repos.recordSearch.removeBoard(last);
    }
    return removed;
  }

  // Read-only health check: how far the index is from the records. Reports counts only. Reads everything: on demand only.
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
        else if (differs(s, r, sig)) out.stale += 1;
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

module.exports = { RecordSearchIndex, searchDocument, searchableKeys, planOf, signature, insertedRecordOps, differs, SEARCHABLE_TYPES, MODES, STATE_ID, BATCH, MARGIN_MS };
