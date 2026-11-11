// In-process monitoring for the System Health page (Q1.1, Q1.5): API timings per route pattern, recent errors, slow
// MongoDB commands, and integration operations (monday.com, Google Drive). Everything is held in memory with fixed limits,
// so it can never grow without bound, and it resets when the server restarts (Railway's logs keep the long history).
//
// What is recorded is deliberately thin: route PATTERNS (never the URL as sent, so no IDs or search text), status codes,
// error codes, durations, MongoDB command and collection names (never a filter or a document), and integration error
// codes. No request or response bodies, no query strings, no cookies, tokens or names.
//
// Kept free of app-level requires (no MongoDB driver, no middleware/errors): it is cheap to load anywhere.
const ROUTE_LIMIT = 200; // distinct route patterns tracked; any more share the "(other)" entry
const SAMPLES_PER_ROUTE = 200; // most recent durations kept per route, for percentiles
const GLOBAL_SAMPLES = 2000;
const RECENT_ERRORS = 50;
const SLOW_COMMANDS = 50;
const MINUTES = 60; // per-minute trend buckets
const PROVIDER_HISTORY = 50;
const PROVIDER_LIMIT = 20;

// A fixed-size ring: push is O(1) and old entries fall off.
class Ring {
  constructor(size) { this.size = size; this.items = []; this.next = 0; }
  push(item) { if (this.items.length < this.size) this.items.push(item); else { this.items[this.next] = item; this.next = (this.next + 1) % this.size; } }
  // Oldest first.
  values() { return this.items.length < this.size ? this.items.slice() : [...this.items.slice(this.next), ...this.items.slice(0, this.next)]; }
  get length() { return this.items.length; }
  clear() { this.items = []; this.next = 0; }
}

// Nearest-rank percentile of an unsorted list of numbers (0 for an empty list).
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}
const round = (n) => Math.round(n * 10) / 10;
function summarise(samples) {
  const n = samples.length;
  if (!n) return { samples: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  let sum = 0, max = 0;
  for (const v of samples) { sum += v; if (v > max) max = v; }
  return { samples: n, avgMs: round(sum / n), p50Ms: round(percentile(samples, 50)), p95Ms: round(percentile(samples, 95)), p99Ms: round(percentile(samples, 99)), maxMs: round(max) };
}

// Error codes and names are short identifiers; anything else is cut down so free text can't slip in.
const safeCode = (value) => (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : value == null ? null : "OTHER");
const safeName = (value, max = 80) => (typeof value === "string" && /^[A-Za-z0-9_.$:\-/ ]{1,200}$/.test(value) ? value.slice(0, max) : null);

class Monitor {
  constructor({ now = () => Date.now(), slowCommandMs = 500 } = {}) {
    this.now = now;
    this.slowCommandMs = slowCommandMs;
    this.startedAt = now();
    this.reset();
  }
  reset() {
    this.routes = new Map();
    this.all = new Ring(GLOBAL_SAMPLES);
    this.totals = { requests: 0, serverErrors: 0, clientErrors: 0 };
    this.statuses = new Map();
    this.errors = new Ring(RECENT_ERRORS);
    this.minutes = new Ring(MINUTES);
    this.db = { commands: 0, failed: 0, slow: 0 };
    this.slowCommands = new Ring(SLOW_COMMANDS);
    this.providers = new Map();
    this.jobFailures = new Ring(RECENT_ERRORS);
  }

  // ---- API requests
  // route: "GET /boards/:boardId/records" — the pattern Express matched, or "(unmatched)".
  recordRequest({ method, route, status, ms, requestId = null, code = null }) {
    const key = `${method} ${route}`;
    let entry = this.routes.get(key);
    if (!entry) {
      if (this.routes.size >= ROUTE_LIMIT) entry = this.routes.get("(other)") || this.routes.set("(other)", this.newRoute("(other)")).get("(other)");
      else entry = this.routes.set(key, this.newRoute(key)).get(key);
    }
    entry.count += 1; entry.samples.push(ms);
    if (status >= 500) entry.serverErrors += 1; else if (status >= 400) entry.clientErrors += 1;
    if (ms > entry.maxMs) entry.maxMs = ms;
    entry.lastAt = this.now();
    this.totals.requests += 1;
    if (status >= 500) this.totals.serverErrors += 1; else if (status >= 400) this.totals.clientErrors += 1;
    this.all.push(ms);
    const klass = `${Math.floor(status / 100)}xx`;
    this.statuses.set(klass, (this.statuses.get(klass) || 0) + 1);
    this.minute().count += 1; this.minute().sumMs += ms; if (status >= 500) this.minute().errors += 1;
    // 401s are the normal "signed out" answer and 404s are common and harmless, so they aren't listed as errors.
    if (status >= 500 || status === 403 || status === 429 || status === 413) this.errors.push({ at: new Date(this.now()).toISOString(), requestId, method, route, status, code: safeCode(code) });
  }
  newRoute(key) { return { key, count: 0, serverErrors: 0, clientErrors: 0, maxMs: 0, samples: new Ring(SAMPLES_PER_ROUTE), lastAt: 0 }; }
  minute() {
    const start = Math.floor(this.now() / 60000) * 60000, last = this.minutes.values().at(-1);
    if (last?.start === start) return last;
    const bucket = { start, count: 0, errors: 0, sumMs: 0 };
    this.minutes.push(bucket);
    return bucket;
  }

  // ---- MongoDB commands (from the driver's command monitoring; see db/connection.js)
  recordCommand({ command, collection = null, ms, ok = true, code = null }) {
    this.db.commands += 1;
    if (!ok) this.db.failed += 1;
    if (ms >= this.slowCommandMs || !ok) {
      if (ms >= this.slowCommandMs) this.db.slow += 1;
      this.slowCommands.push({ at: new Date(this.now()).toISOString(), command: safeName(command, 40) || "command", collection: safeName(collection), ms: Math.round(ms), ok, code: ok ? null : safeCode(code == null ? null : String(code)) });
    }
  }

  // ---- Integrations and background jobs
  // outcome: "ok" | "retry" | "failed" | "timeout". op: a short name ("query", "upload"). status: HTTP status or null.
  recordIntegration(provider, { op = "request", outcome, status = null, code = null, ms = null, retryAfterMs = null, note = null }) {
    const p = this.provider(provider);
    if (!p) return;
    const at = new Date(this.now()).toISOString();
    if (outcome === "ok") { p.ok += 1; p.lastSuccessAt = at; }
    else if (outcome === "retry") p.retries += 1;
    else { p.failed += 1; p.lastFailureAt = at; p.lastError = { at, op: safeName(op, 40), status: Number.isInteger(status) ? status : null, code: safeCode(code) }; }
    if (outcome === "timeout") p.timeouts += 1;
    if (status === 429 || code === "RATE_LIMITED" || /rate/i.test(String(code || ""))) { p.rateLimited += 1; p.lastRateLimit = { at, retryAfterMs: Number.isFinite(retryAfterMs) ? Math.round(retryAfterMs) : null }; }
    if (outcome !== "ok" || note) p.history.push({ at, op: safeName(op, 40), outcome, status: Number.isInteger(status) ? status : null, code: safeCode(code), ms: Number.isFinite(ms) ? Math.round(ms) : null, note: safeName(note, 120) });
  }
  provider(name) {
    if (!safeName(name, 40)) return null;
    if (!this.providers.has(name)) {
      if (this.providers.size >= PROVIDER_LIMIT) return null;
      this.providers.set(name, { ok: 0, failed: 0, retries: 0, timeouts: 0, rateLimited: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, lastRateLimit: null, history: new Ring(PROVIDER_HISTORY) });
    }
    return this.providers.get(name);
  }
  recordJobFailure({ kind, code = null }) { this.jobFailures.push({ at: new Date(this.now()).toISOString(), kind: safeName(kind, 60) || "job", code: safeCode(code) }); }

  // ---- Reading
  snapshot({ slowest = 10 } = {}) {
    const endpoints = [...this.routes.values()].map((r) => {
      const s = summarise(r.samples.values());
      return { route: r.key, count: r.count, serverErrors: r.serverErrors, clientErrors: r.clientErrors, errorRate: r.count ? round((r.serverErrors / r.count) * 100) : 0, ...s, lastAt: r.lastAt ? new Date(r.lastAt).toISOString() : null };
    });
    const cutoff = Math.floor(this.now() / 60000) * 60000 - (MINUTES - 1) * 60000;
    return {
      since: new Date(this.startedAt).toISOString(),
      api: { ...this.totals, errorRate: this.totals.requests ? round((this.totals.serverErrors / this.totals.requests) * 100) : 0, statuses: Object.fromEntries([...this.statuses].sort()), ...summarise(this.all.values()) },
      slowestEndpoints: endpoints.filter((e) => e.samples).sort((a, b) => b.p95Ms - a.p95Ms || b.maxMs - a.maxMs).slice(0, slowest),
      failingEndpoints: endpoints.filter((e) => e.serverErrors).sort((a, b) => b.errorRate - a.errorRate || b.serverErrors - a.serverErrors).slice(0, slowest),
      endpoints: endpoints.sort((a, b) => b.count - a.count),
      trend: this.minutes.values().filter((m) => m.start >= cutoff).map((m) => ({ at: new Date(m.start).toISOString(), requests: m.count, errors: m.errors, avgMs: m.count ? round(m.sumMs / m.count) : 0 })),
      recentErrors: this.errors.values().reverse(),
      database: { ...this.db, slowThresholdMs: this.slowCommandMs, slowCommands: this.slowCommands.values().reverse() },
      integrations: Object.fromEntries([...this.providers].map(([name, p]) => [name, { ok: p.ok, failed: p.failed, retries: p.retries, timeouts: p.timeouts, rateLimited: p.rateLimited, lastSuccessAt: p.lastSuccessAt, lastFailureAt: p.lastFailureAt, lastError: p.lastError, lastRateLimit: p.lastRateLimit, history: p.history.values().reverse() }])),
      jobFailures: this.jobFailures.values().reverse()
    };
  }
}

// One per process: the HTTP clients and the database connection report here without being handed an instance.
const monitor = new Monitor();

module.exports = { Monitor, Ring, monitor, percentile, summarise, LIMITS: Object.freeze({ ROUTE_LIMIT, SAMPLES_PER_ROUTE, GLOBAL_SAMPLES, RECENT_ERRORS, SLOW_COMMANDS, MINUTES, PROVIDER_HISTORY }) };
