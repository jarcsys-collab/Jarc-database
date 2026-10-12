// Live updates in the browser (resource mode): listens to GET /api/v1/events (Server-Sent Events) and hands batches
// of change notices to the app. The session cookie authenticates the stream; nothing sensitive goes in the URL (only
// the last event ID, to resume).
//
//   connect     EventSource on the same origin. Each "change" carries IDs only; the app fetches what changed.
//   batching    changes arriving within 250 ms are handed over together (a burst becomes one refresh).
//   duplicates  every event ID is remembered (the last 1000), so a replayed or repeated event is handled once.
//   reconnect   on any error the stream is closed and reopened after 1 s, 2 s, 4 s … up to 30 s (with jitter),
//               resuming from the last event ID; the server replays what was missed or asks for a full resync.
//   fallback    no EventSource, or the stream never manages to open: the activity log is polled every 20 s instead.
//   offline     the browser going offline pauses everything; coming back online reconnects at once.
//
// States reported to the app: "connecting", "live", "reconnecting", "offline", "polling".
class LiveUpdates {
  static BATCH_MS = 250;
  static MAX_BACKOFF_MS = 30000;
  static POLL_MS = 20000;
  static FAILS_BEFORE_POLLING = 4;

  constructor({ baseUrl = "/api/v1", since = null, onChanges, onResync, onSessionEnded, onState, request, EventSourceImpl = window.EventSource, timers = window } = {}) {
    Object.assign(this, { baseUrl, since, onChanges, onResync, onSessionEnded, onState, request, EventSourceImpl, timers });
    this.lastEventId = null; this.seen = new Set(); this.queue = [];
    this.attempt = 0; this.everOpened = false; this.stopped = true; this.state = "connecting";
    this.onOnline = () => { if (!this.stopped) { this.attempt = 0; this.connect(); } };
    this.onOffline = () => { if (!this.stopped) { this.closeSource(); this.setState("offline"); } };
  }

  start() {
    if (!this.stopped) return this;
    this.stopped = false;
    window.addEventListener("online", this.onOnline); window.addEventListener("offline", this.onOffline);
    if (!this.EventSourceImpl) this.startPolling(); else this.connect();
    return this;
  }
  stop() {
    this.stopped = true; this.closeSource();
    this.timers.clearTimeout(this.retryTimer); this.timers.clearTimeout(this.batchTimer); this.timers.clearInterval(this.pollTimer);
    window.removeEventListener("online", this.onOnline); window.removeEventListener("offline", this.onOffline);
  }
  setState(state) { if (this.state !== state) { this.state = state; this.onState?.(state); } }
  closeSource() { if (this.source) { this.source.onopen = this.source.onerror = null; this.source.close(); this.source = null; } }

  connect() {
    this.closeSource(); this.timers.clearTimeout(this.retryTimer);
    if (this.stopped) return;
    if (navigator.onLine === false) { this.setState("offline"); return; }
    this.setState(this.everOpened ? "reconnecting" : "connecting");
    // Resume after the last event; or, on the very first connection, from when the app started loading its data.
    const query = this.lastEventId ? `?lastEventId=${encodeURIComponent(this.lastEventId)}` : this.since ? `?since=${encodeURIComponent(this.since)}` : "";
    const url = `${this.baseUrl}/events${query}`;
    const source = new this.EventSourceImpl(url);
    this.source = source;
    source.addEventListener("ready", (event) => { try { const ready = JSON.parse(event.data); if (!this.lastEventId && ready.lastEventId) this.lastEventId = ready.lastEventId; } catch { /* keep going */ } this.since = null; this.attempt = 0; this.everOpened = true; this.timers.clearInterval(this.pollTimer); this.pollTimer = null; this.setState("live"); });
    source.addEventListener("change", (event) => this.receive(event.lastEventId, event.data));
    source.addEventListener("resync", () => { this.flush(); this.onResync?.(); });
    source.addEventListener("session-ended", () => { this.stop(); this.onSessionEnded?.(); });
    // Our own backoff instead of EventSource's fixed retry: close, wait, reopen with the last event ID.
    source.onerror = () => { this.closeSource(); this.retry(); };
  }
  async retry() {
    if (this.stopped) return;
    this.attempt += 1;
    // The stream can't say why it failed: a quick authenticated request tells an ended session from a network blip.
    if (this.request) { try { await this.request("GET", "/me"); } catch (error) { if (error?.code === "UNAUTHENTICATED" || error?.code === "ACCOUNT_DISABLED") { this.stop(); this.onSessionEnded?.(); return; } } }
    if (this.stopped) return;
    if (!this.everOpened && this.attempt >= LiveUpdates.FAILS_BEFORE_POLLING) this.startPolling();
    const delay = Math.min(LiveUpdates.MAX_BACKOFF_MS, 1000 * 2 ** (this.attempt - 1)) * (0.8 + Math.random() * 0.4);
    this.setState(navigator.onLine === false ? "offline" : this.pollTimer ? "polling" : "reconnecting");
    this.retryTimer = this.timers.setTimeout(() => this.connect(), delay);
  }

  receive(id, data) {
    if (!id || this.seen.has(id)) return;
    this.seen.add(id); if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
    this.lastEventId = id;
    try { this.queue.push(typeof data === "string" ? JSON.parse(data) : data); } catch { return; }
    if (!this.batchTimer) this.batchTimer = this.timers.setTimeout(() => this.flush(), LiveUpdates.BATCH_MS);
  }
  flush() {
    this.timers.clearTimeout(this.batchTimer); this.batchTimer = null;
    const batch = this.queue.splice(0);
    if (batch.length) this.onChanges?.(batch);
  }

  // Fallback: poll the activity log (newest first) and feed unseen entries through the same path.
  startPolling() {
    if (this.pollTimer || !this.request) return;
    this.setState("polling");
    let baseline = !this.lastEventId; // nothing received yet: the first page is what the app already loaded
    const poll = async () => {
      try {
        const { items } = await this.request("GET", "/activity?limit=50");
        if (baseline) { items.forEach((e) => this.seen.add(e.id)); if (items[0]) this.lastEventId = items[0].id; baseline = false; return; }
        for (const e of [...items].reverse()) this.receive(e.id, { id: e.id, action: e.action, workspaceId: e.workspaceId, boardId: e.boardId, recordId: e.recordId, actorId: e.actorUserId, at: e.createdAt });
      } catch { /* try again next time */ }
    };
    poll();
    this.pollTimer = this.timers.setInterval(poll, LiveUpdates.POLL_MS);
  }
}

window.LiveUpdates = LiveUpdates;
