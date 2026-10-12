// Live updates (Server-Sent Events). The source of events is the activities collection in MongoDB, not an in-memory
// broadcaster: every write appends its activity entry only after the change is saved (inside the same transaction for
// structural changes), so an event never announces something that wasn't stored, and every server instance sees every
// change — this works with one Railway replica or several.
//
// One poller per server instance reads new entries (about once a second, only while someone is connected) and hands
// them to each open connection, which filters them by that person's workspace access. Events carry IDs only
// ({ id, action, workspaceId, boardId, recordId, actorId, at }); browsers fetch the changed data through the normal,
// authorised REST API.
//
// Ordering: entries are read by loggedAt (when the entry was written; createdAt for entries written before that field
// existed). Entries from several instances or transactions still become visible slightly out of order, so each poll
// re-reads a short overlap window and skips entries already delivered (by ID); and every 15 s a sweep re-reads the last
// two minutes, so even a very slow commit is delivered (late rather than never). Browsers that reconnect replay from
// their last event ID; when that isn't possible they are told to resync.
const POLL_MS = 1000;
const OVERLAP_MS = 5000;
const SWEEP_EVERY_MS = 15000;
const SWEEP_WINDOW_MS = 120000;
const BATCH_LIMIT = 500;

const logTime = (doc) => (doc.loggedAt instanceof Date ? doc.loggedAt : doc.createdAt).getTime();
const toEvent = (doc) => ({
  id: doc._id.toHexString(), action: doc.action,
  workspaceId: doc.workspaceId ? doc.workspaceId.toHexString() : null,
  boardId: doc.boardId ? doc.boardId.toHexString() : null,
  recordId: doc.recordId ? doc.recordId.toHexString() : null,
  actorId: doc.actorUserId ? doc.actorUserId.toHexString() : null,
  at: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : null
});

class ActivityStream {
  constructor({ activities, logger = console, pollMs = POLL_MS, overlapMs = OVERLAP_MS, sweepEveryMs = SWEEP_EVERY_MS, sweepWindowMs = SWEEP_WINDOW_MS, now = () => new Date() }) {
    Object.assign(this, { activities, logger, pollMs, overlapMs, sweepEveryMs, sweepWindowMs, now });
    this.subscribers = new Set();
    this.seen = new Map(); // activity ID → log time (ms); kept for the sweep window
    this.cursor = null;     // newest log time delivered (ms)
    this.lastSweep = 0;
    this.startedAt = null; // when the stream (re)started: entries written before it are each connection's replay's job
    this.timer = null; this.polling = false;
  }

  // subscriber: { deliver(events) → Promise, close(reason) }. Returns an unsubscribe function.
  subscribe(subscriber) {
    this.subscribers.add(subscriber);
    if (!this.timer) {
      if (this.cursor === null) { this.cursor = this.now().getTime(); this.lastSweep = this.cursor; this.startedAt = this.cursor; }
      this.timer = setInterval(() => this.poll(), this.pollMs); this.timer.unref?.();
    }
    return () => {
      this.subscribers.delete(subscriber);
      if (!this.subscribers.size && this.timer) { clearInterval(this.timer); this.timer = null; this.cursor = null; this.seen.clear(); this.primed = false; }
    };
  }

  // Reads new entries and delivers them. Exposed for tests (and called by the timer).
  async poll() {
    if (this.polling || !this.subscribers.size) return;
    this.polling = true;
    try {
      const now = this.now().getTime();
      const sweep = now - this.lastSweep >= this.sweepEveryMs;
      const since = new Date((sweep ? Math.min(this.cursor - this.overlapMs, now - this.sweepWindowMs) : this.cursor - this.overlapMs));
      if (sweep) this.lastSweep = now;
      const docs = await this.activities.listSince(since, { limit: sweep ? BATCH_LIMIT * 4 : BATCH_LIMIT });
      const unseen = docs.filter((d) => !this.seen.has(d._id.toHexString()));
      for (const d of unseen) { this.seen.set(d._id.toHexString(), logTime(d)); this.cursor = Math.max(this.cursor, logTime(d)); }
      // Entries already visible when the stream started were covered by each connection's replay; only later ones (and
      // slow commits that become visible later) are new. After the first read every unseen entry is new.
      const fresh = this.primed ? unseen : unseen.filter((d) => logTime(d) >= this.startedAt);
      this.primed = true;
      for (const [id, at] of this.seen) if (at < now - this.sweepWindowMs - this.overlapMs) this.seen.delete(id);
      if (fresh.length) {
        const events = fresh.map(toEvent);
        await Promise.all([...this.subscribers].map((s) => s.deliver(events).catch(() => s.close("error"))));
      }
      // A full batch means more are waiting: read again straight away.
      if (!sweep && docs.length >= BATCH_LIMIT) setImmediate(() => this.poll());
    } catch (error) {
      this.logger.error(`[live] could not read activity: ${error?.name || "Error"}`);
    } finally { this.polling = false; }
  }

  // Entries after a given activity ID (a reconnecting browser's Last-Event-ID). null → the browser must resync.
  async replaySince(lastEventId, { maxAgeMs = 24 * 60 * 60 * 1000, limit = 1000 } = {}) {
    const last = await this.activities.findById(lastEventId);
    if (!last || this.now().getTime() - logTime(last) > maxAgeMs) return null;
    // Everything written from shortly before the last one on; the browser ignores entries it has already seen.
    const docs = await this.activities.listSince(new Date(logTime(last) - this.overlapMs), { limit: limit + 1 });
    if (docs.length > limit) return null;
    const lastId = last._id.toHexString();
    return docs.filter((d) => d._id.toHexString() !== lastId).map(toEvent);
  }

  // Entries since a moment (a browser's first connection: changes saved while it was loading its data).
  async replayFrom(since, { limit = 1000 } = {}) {
    const docs = await this.activities.listSince(new Date(since.getTime() - this.overlapMs), { limit: limit + 1 });
    return docs.length > limit ? null : docs.map(toEvent);
  }
  // The newest entry's ID (sent with "ready", so a browser that hasn't received anything yet can still resume).
  async latestId() { const [last] = await this.activities.listRecent({ limit: 1 }); return last ? last._id.toHexString() : null; }

  // Server shutdown: end every stream so the process can exit (browsers reconnect to the next instance).
  closeAll() { for (const s of [...this.subscribers]) s.close("shutdown"); }
}

module.exports = { ActivityStream, toEvent };
