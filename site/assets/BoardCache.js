// Saved copies of boards in this browser (IndexedDB), so a board opened before shows at once after a reload while the
// server's copy is fetched. Resource mode with Microsoft sign-in only.
//
// What is kept: per signed-in JARC user, per board, the records exactly as the server last confirmed them (the adapter's
// copy — never an unsaved edit), the board's version and when it was saved. Never: tokens, cookies, session answers,
// comments, file contents. Only boards loaded completely (up to ResourceApiAdapter.FULL_LOAD_LIMIT records) are kept.
//
// Safety rules (see ResourceApiAdapter.loadBoardRecords and AppController.start):
//   - read only after the server confirmed the session AND listed the board for this person (access checked again), and
//     only if the board's version is unchanged; the copy is shown as "saved copy, updating" and replaced by the server's
//   - other people's copies are deleted when someone signs in; everything is deleted on sign-out or a refused account
//   - copies expire (TTL_MS), the total is bounded (MAX_BYTES, MAX_BOARDS, least recently used first)
//   - anything unreadable, malformed or slow is ignored: the board loads from the server as before
class BoardCache {
  static DB_NAME = "jarc-board-cache";
  static DB_VERSION = 1;
  // 2 (S0-B, D-S0B-5): copies saved before S0-B may hold Connect IDs the reader can no longer see; they are discarded.
  static SCHEMA = 2;
  static TTL_MS = 72 * 60 * 60 * 1000;          // 3 days
  static MAX_BYTES = 40 * 1024 * 1024;          // all boards together (measured: about 1 KB per record of 20 columns)
  static MAX_BOARD_BYTES = 8 * 1024 * 1024;     // one board
  static MAX_BOARDS = 40;
  static MAX_RECORDS = 2000;                    // = ResourceApiAdapter.FULL_LOAD_LIMIT: larger boards load in pages, never cached
  static TIMEOUT_MS = 1500;                     // a slow or stuck database never delays a board: it loads from the server
  static OFF_KEY = "jarc-board-cache";          // localStorage "off" switches the cache off in this browser (support)

  static available() {
    try { return typeof indexedDB !== "undefined" && indexedDB !== null && window.localStorage?.getItem(BoardCache.OFF_KEY) !== "off"; } catch { return typeof indexedDB !== "undefined" && indexedDB !== null; }
  }
  // The cache of one signed-in person (their JARC user ID), or null when this browser can't keep one.
  static forScope(userId) { return userId && BoardCache.available() ? new BoardCache(String(userId)) : null; }

  constructor(scope) { this.scope = scope; this.ready = null; this.stats = { hits: 0, misses: 0, writes: 0, errors: 0 }; }

  static timeout(promise, ms = BoardCache.TIMEOUT_MS) {
    let timer; return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(BoardCache.TIMED_OUT), ms); })]).finally(() => clearTimeout(timer));
  }
  static TIMED_OUT = Symbol("timed out");
  static request(req) { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
  static done(tx) { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error("aborted")); }); }

  // One connection per page. Another tab deleting the database (sign-out) closes it here.
  static open() {
    if (BoardCache.connection) return BoardCache.connection;
    BoardCache.connection = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(BoardCache.DB_NAME, BoardCache.DB_VERSION); } catch (error) { reject(error); return; }
      // Versioned schema. Version 1: snapshots (the records) and meta (small: who, when, size), so pruning never reads records.
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (event.oldVersion < 1) {
          db.createObjectStore("snapshots", { keyPath: "key" });
          const meta = db.createObjectStore("meta", { keyPath: "key" });
          meta.createIndex("scope", "scope");
        }
      };
      req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); BoardCache.connection = null; }; db.onclose = () => { BoardCache.connection = null; }; resolve(db); };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("blocked"));
    }).catch((error) => { BoardCache.connection = null; throw error; });
    return BoardCache.connection;
  }
  key(boardId) { return `${this.scope}|${boardId}`; }

  // Before the first read: other people's copies and expired ones are deleted, and the total is brought within bounds.
  prepare() { this.ready ??= BoardCache.timeout(this.prune(), 4000).catch(() => null); return this.ready; }
  async prune(now = Date.now()) {
    const db = await BoardCache.open();
    const all = await BoardCache.request(db.transaction("meta").objectStore("meta").getAll());
    const drop = new Set(all.filter((m) => m.scope !== this.scope || !(now - m.savedAt < BoardCache.TTL_MS) || m.schema !== BoardCache.SCHEMA).map((m) => m.key));
    const mine = all.filter((m) => !drop.has(m.key)).sort((a, b) => b.usedAt - a.usedAt);
    let bytes = 0;
    mine.forEach((m, i) => { bytes += m.bytes || 0; if (i >= BoardCache.MAX_BOARDS || bytes > BoardCache.MAX_BYTES) drop.add(m.key); });
    if (drop.size) await this.removeKeys(db, [...drop]);
    return drop.size;
  }
  async removeKeys(db, keys) {
    const tx = db.transaction(["snapshots", "meta"], "readwrite");
    for (const k of keys) { tx.objectStore("snapshots").delete(k); tx.objectStore("meta").delete(k); }
    await BoardCache.done(tx);
  }

  // The saved copy of a board, or null. version: the board's version as the server listed it just now; any other version
  // (columns, groups, views changed since) means the copy isn't used. A malformed copy is deleted.
  async read(boardId, { version } = {}) {
    const result = await BoardCache.timeout((async () => {
      await this.prepare();
      const db = await BoardCache.open();
      const entry = await BoardCache.request(db.transaction("snapshots").objectStore("snapshots").get(this.key(boardId)));
      if (!entry) return null;
      if (!BoardCache.valid(entry, this.scope, boardId) || entry.boardVersion !== version || !(Date.now() - entry.savedAt < BoardCache.TTL_MS)) { await this.removeKeys(db, [this.key(boardId)]); return null; }
      this.touch(db, boardId);
      return entry;
    })()).catch(() => { this.stats.errors += 1; return null; });
    if (result === BoardCache.TIMED_OUT || !result) { this.stats.misses += 1; return null; }
    this.stats.hits += 1;
    return result;
  }
  touch(db, boardId) {
    try {
      const tx = db.transaction("meta", "readwrite"), store = tx.objectStore("meta"), req = store.get(this.key(boardId));
      req.onsuccess = () => { if (req.result) store.put({ ...req.result, usedAt: Date.now() }); };
    } catch { /* only the order of eviction */ }
  }
  static ID = /^[0-9a-f]{24}$/;
  static valid(entry, scope, boardId) {
    if (!entry || typeof entry !== "object" || entry.schema !== BoardCache.SCHEMA || entry.scope !== scope || entry.boardId !== boardId) return false;
    if (!Number.isFinite(entry.savedAt) || !Number.isInteger(entry.boardVersion) || !Array.isArray(entry.records) || entry.records.length > BoardCache.MAX_RECORDS) return false;
    return entry.records.every((r) => r && typeof r === "object" && typeof r.id === "string" && BoardCache.ID.test(r.id) && r.boardId === boardId && r.values && typeof r.values === "object" && !Array.isArray(r.values) && Number.isInteger(r.version));
  }

  // Keeps a board's records (the server's copy). Larger than the bounds: not kept (and an older copy is deleted).
  async write(boardId, { boardVersion, records }) {
    const out = await BoardCache.timeout((async () => {
      await this.prepare();
      const db = await BoardCache.open(), key = this.key(boardId);
      const bytes = records.length > BoardCache.MAX_RECORDS ? Infinity : BoardCache.estimateBytes(records);
      if (bytes > BoardCache.MAX_BOARD_BYTES) { await this.removeKeys(db, [key]); return false; }
      const now = Date.now(), tx = db.transaction(["snapshots", "meta"], "readwrite");
      tx.objectStore("snapshots").put({ key, schema: BoardCache.SCHEMA, scope: this.scope, boardId, boardVersion, savedAt: now, records });
      tx.objectStore("meta").put({ key, schema: BoardCache.SCHEMA, scope: this.scope, boardId, savedAt: now, usedAt: now, bytes });
      await BoardCache.done(tx);
      this.stats.writes += 1;
      await this.prune(now);
      return true;
    })()).catch(() => { this.stats.errors += 1; return false; });
    return out === true;
  }
  // Keeps only the copies of these boards (the ones the server lists for this person now); the others are deleted.
  async retainOnly(boardIds) {
    const keep = new Set(boardIds.map((id) => this.key(String(id))));
    await BoardCache.timeout((async () => {
      await this.prepare();
      const db = await BoardCache.open();
      const mine = await BoardCache.request(db.transaction("meta").objectStore("meta").index("scope").getAllKeys(this.scope));
      const drop = mine.filter((k) => !keep.has(k));
      if (drop.length) await this.removeKeys(db, drop);
    })()).catch(() => { this.stats.errors += 1; });
  }
  // Size of a board's records as text, estimated from up to 50 of them spread across the board (measuring every record
  // would hold up the page on a large board for no real gain in accuracy; the bounds have ample margin).
  static estimateBytes(records) {
    if (!records.length) return 2;
    const step = Math.max(1, Math.floor(records.length / 50)); let sampled = 0, bytes = 0;
    for (let i = 0; i < records.length; i += step) { bytes += JSON.stringify(records[i]).length + 1; sampled += 1; }
    return Math.ceil((bytes / sampled) * records.length);
  }
  async remove(boardId) {
    await BoardCache.timeout((async () => { await this.prepare(); await this.removeKeys(await BoardCache.open(), [this.key(boardId)]); })()).catch(() => { this.stats.errors += 1; });
  }

  // Sign-out, a refused account: every saved copy in this browser goes (the whole database). Never takes longer than a
  // moment, so signing out is never held up; if the database can't be deleted now, it's emptied the next time someone signs in.
  static async clearAll() {
    if (typeof indexedDB === "undefined" || indexedDB === null) return;
    try { const db = await BoardCache.timeout(BoardCache.connection || Promise.resolve(null), 500); if (db && db !== BoardCache.TIMED_OUT) db.close(); } catch { /* not open */ }
    BoardCache.connection = null;
    await BoardCache.timeout(new Promise((resolve) => { try { const req = indexedDB.deleteDatabase(BoardCache.DB_NAME); req.onsuccess = req.onerror = req.onblocked = () => resolve(); } catch { resolve(); } }), 1500);
  }
}
BoardCache.connection = null;
window.BoardCache = BoardCache;
