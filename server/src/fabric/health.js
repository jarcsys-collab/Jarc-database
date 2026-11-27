// Fabric index health, for System Health (GET /admin/system-health "fabric" part). Per dataset (datasets.js): whether the
// indexes its queries need exist, how it runs (indexed | small | unavailable), when that was last verified, its latest date
// (index-backed only) and whether the upstream copy was reloaded. Reuses DatasetSource.info() (listIndexes +
// estimatedDocumentCount, cached 60 s) and FabricIndexes.capabilities(); it never runs an unindexed query or a scan.
//
//   snapshot()   on a System Health load: the caches (no invalidate), index-backed bounds() in indexed mode only, and a
//                one-key probe of the _id index (hint _id_, $limit 1, _id only; cached 60 s) for the reload signal.
//   start()      the 5-minute background check (unref'd; never overlapping): invalidate + info() per dataset, i.e.
//                listIndexes + estimatedDocumentCount only (plus one listIndexes for the invoice views while they're on).
//   stop()       ends it (close() of the Fabric stack calls it).
// Each state transition per dataset logs ONE warn line made of constants only (dataset, state, mode, index names from
// datasets.js): "[fabric] index health: sales index_missing (mode unavailable; missing fabric_invoice_date)".
// Views: detailedView (Fabric readers) and generalView (everyone else who may see System Health: healthy | degraded |
// unavailable only). Both are built field by field (allow-lists), so no record value, _id, host or driver text gets out.
const { isFabricError, describe } = require("./errors");
const { DATASETS, DATASET_NAMES } = require("./datasets");
const { RECOMMENDED } = require("./indexes");
const { DatasetSource } = require("./source");

const STATES = Object.freeze(["ok", "small_mode", "index_missing", "source_missing", "unavailable", "unsafe"]);
const MODES = Object.freeze(["indexed", "small", "unavailable"]);
const CONNECTION_STATES = Object.freeze(["idle", "ready", "unavailable", "unsafe", "closed"]);
const OVERALL = Object.freeze(["healthy", "degraded", "unavailable"]);
const REASONS = Object.freeze(["FABRIC_SOURCE_MISSING", "FABRIC_UNSAFE_CREDENTIALS", "FABRIC_UNAVAILABLE", "FABRIC_TIMEOUT", "FABRIC_BUSY", "FABRIC_INDEX_REQUIRED"]);
const CODE_STATE = Object.freeze({ FABRIC_SOURCE_MISSING: "source_missing", FABRIC_UNSAFE_CREDENTIALS: "unsafe", FABRIC_INDEX_REQUIRED: "index_missing" });
const EVERY_MS = 5 * 60 * 1000;
const PROBE_CACHE_MS = 60 * 1000;
const PROBE_TIME_MS = 2000;
const RELOAD_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const NEAR_LIMIT = 0.8;
const INDEX_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const iso = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const isoText = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
const oneOf = (v, allowed, fallback = "unknown") => (typeof v === "string" && allowed.includes(v) ? v : fallback);
const idTime = (id) => { try { const t = typeof id?.getTimestamp === "function" ? id.getTimestamp() : null; return t instanceof Date && !Number.isNaN(t.getTime()) ? t.getTime() : null; } catch { return null; } };

// The index names and keys a dataset needs, from datasets.js (its sorts) and, for sales while the invoice views are on,
// indexes.js RECOMMENDED. The ONLY source of names and keys shown anywhere.
function requiredFor(name, invoiceViews) {
  const ds = DATASETS[name], out = [];
  const add = (index, need) => {
    const hit = out.find((r) => r.name === index.name);
    if (hit) hit.neededFor.push(need); else out.push({ name: index.name, keys: { ...index.keys }, neededFor: [need] });
  };
  for (const sort of Object.keys(ds.sorts)) add(ds.indexes[sort], `sort:${sort}`);
  if (name === "sales" && invoiceViews) { add(RECOMMENDED.date, "invoiceList"); add(RECOMMENDED.detail, "invoiceDetail"); }
  return out;
}

class FabricIndexHealth {
  // sources: { sales, inventory } DatasetSource; indexes: FabricIndexes (sales invoice views); repository: FabricRepository
  // (only for the _id probe); connection: FabricConnection (its state). config: config.fabricData.
  constructor({ sources, indexes = null, repository, connection = null, config = {}, logger = console, now = Date.now, everyMs = EVERY_MS, timers = { setInterval, clearInterval } }) {
    this.sources = sources; this.indexes = indexes; this.repository = repository; this.connection = connection;
    this.config = config; this.logger = logger; this.now = now; this.everyMs = everyMs; this.timers = timers;
    this.invoiceViews = config.invoiceViews === true;
    this.scanMax = config.unindexedScanMax ?? 20000;
    this.memory = Object.fromEntries(DATASET_NAMES.map((n) => [n, { state: undefined, since: null, lastVerifiedAt: null, latestDate: null, earliestDate: null, copy: null, probeAt: 0, reload: null }]));
    this.background = { lastRunAt: null, lastOkAt: null };
    this.timer = null; this.running = null;
  }

  // ---- Background check (approved: every 5 minutes, metadata only)
  start() {
    if (this.timer || this.config.enabled === false) return false;
    this.timer = this.timers.setInterval(() => { this.tick().catch(() => {}); }, this.everyMs);
    this.timer?.unref?.();
    return true;
  }
  stop() { if (this.timer) this.timers.clearInterval(this.timer); this.timer = null; }
  get started() { return Boolean(this.timer); }

  // One background round: never overlapping, skipped when the login is unsafe or the stack is closed.
  tick() {
    if (this.running) return this.running;
    if (["unsafe", "closed"].includes(this.connection?.state)) return Promise.resolve(null);
    this.running = (async () => {
      this.background.lastRunAt = this.now();
      try {
        for (const name of DATASET_NAMES) {
          this.sources[name].invalidate();
          if (name === "sales" && this.invoiceViews) this.indexes?.invalidate();
          await this.observe(name, { probe: false, dates: false });
        }
        this.background.lastOkAt = this.now();
      } catch (error) {
        if (!this.backgroundFailed) this.logger.warn?.(`[fabric] index health: background check failed (${describe(error)})`);
        this.backgroundFailed = true;
        return;
      }
      if (this.backgroundFailed) this.logger.warn?.("[fabric] index health: background check ok again");
      this.backgroundFailed = false;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  // ---- What System Health shows (≤ 60 s old; one dataset at a time)
  async snapshot() {
    const datasets = {};
    for (const name of DATASET_NAMES) datasets[name] = await this.observe(name, { probe: true, dates: true });
    return { checkedAt: iso(this.now()), connection: this.connection?.state ?? null, background: { everyMinutes: Math.round(this.everyMs / 60000), running: this.started, lastRunAt: iso(this.background.lastRunAt), lastOkAt: iso(this.background.lastOkAt) }, datasets };
  }

  // One dataset's health. Fabric errors become states; anything else is thrown (System Health's part() isolates it).
  async observe(name, { probe, dates }) {
    const source = this.sources[name], ds = source.dataset, mem = this.memory[name];
    let info = null, caps = null, reason = null, state;
    try {
      info = await source.info();
      if (source.cachedAt !== null) mem.lastVerifiedAt = source.cachedAt;
      if (name === "sales" && this.invoiceViews && this.indexes) caps = await this.indexes.capabilities();
    } catch (error) {
      if (!isFabricError(error)) throw error;
      reason = error.code;
      state = CODE_STATE[error.code] || "unavailable";
      if (state === "index_missing") state = "unavailable"; // never from info(); only a hint failure could say so
      info = null; caps = null;
    }
    const names = info ? source.indexNames || [] : null;
    const required = requiredFor(name, this.invoiceViews).map((r) => {
      if (!info) return { ...r, present: null, nameTaken: null, servedBy: null };
      const sortHints = r.neededFor.filter((n) => n.startsWith("sort:")).map((n) => info.hints[n.slice(5)]);
      const capOk = r.neededFor.filter((n) => !n.startsWith("sort:")).map((n) => (caps ? caps[n] === true : null));
      const present = [...sortHints.map(Boolean), ...capOk].every((v) => v === true);
      const servedBy = sortHints.find((h) => h && h !== r.name) || null;
      return { ...r, present, nameTaken: !present && names.includes(r.name), servedBy: servedBy ? (INDEX_NAME.test(servedBy) ? servedBy : "other") : null };
    });
    const mode = info ? DatasetSource.modeOf(info, ds) : "unavailable";
    if (info) {
      const unserved = Object.keys(ds.sorts).filter((s) => !info.hints[s]);
      const capsMissing = caps ? !(caps.invoiceList && caps.invoiceDetail) : false;
      state = (unserved.length && !info.small) || capsMissing ? "index_missing" : unserved.length ? "small_mode" : "ok";
      if (state === "index_missing") reason = "FABRIC_INDEX_REQUIRED";
    }
    // Dates: index-backed bounds() only (never the small-mode aggregate). The last known ones are kept across failures.
    if (dates && mode === "indexed") {
      try { const b = await source.bounds(); mem.latestDate = b.latestDate ? b.latestDate.getTime() : null; mem.earliestDate = b.earliestDate ? b.earliestDate.getTime() : null; }
      catch (error) { if (!isFabricError(error)) throw error; }
    } else if (dates && info) { mem.latestDate = null; mem.earliestDate = null; }
    if (probe && info) await this.probe(name, mem, ds);
    if (info && mem.state === "source_missing") mem.reload = { detectedAt: this.now(), basis: "source_returned" };
    if (mem.reload && this.now() - mem.reload.detectedAt > RELOAD_KEEP_MS) mem.reload = null;
    this.transition(name, mem, state, mode, required);
    return {
      label: ds.label, state, mode, reason, estimate: info ? num(info.estimate) : null, scanMax: this.scanMax,
      lastVerifiedAt: iso(mem.lastVerifiedAt), latestDate: iso(mem.latestDate), earliestDate: iso(mem.earliestDate),
      requiredIndexes: required,
      copy: mem.copy ? { loadedAt: iso(mem.copy.loadedAt), newestIdAt: iso(mem.copy.newestIdAt) } : null,
      reload: mem.reload ? { detectedAt: iso(mem.reload.detectedAt), basis: mem.reload.basis } : null
    };
  }

  // The _id index, one key each way (hint _id_, $limit 1, _id only, 2 s): only its timestamps are kept, never the _id. The
  // oldest _id moving forward means the copy was dropped and recreated (2026-11-26).
  async probe(name, mem, ds) {
    if (this.now() - mem.probeAt < PROBE_CACHE_MS) return;
    mem.probeAt = this.now();
    try {
      const one = async (dir) => {
        const [doc] = await this.repository.aggregate([{ $match: {} }, { $sort: { _id: dir } }, { $limit: 1 }, { $project: { _id: 1 } }], { collection: ds.collection, hint: "_id_", maxTimeMs: PROBE_TIME_MS });
        return idTime(doc?._id);
      };
      const loadedAt = await one(1), newestIdAt = await one(-1);
      if (loadedAt === null) { mem.copy = null; return; }
      if (mem.copy?.loadedAt && loadedAt > mem.copy.loadedAt) mem.reload = { detectedAt: this.now(), basis: "id" };
      mem.copy = { loadedAt, newestIdAt };
    } catch (error) {
      if (!isFabricError(error)) throw error;
    }
  }

  // One warn line per change between "working" (ok, small_mode) and anything else, or between two problem states; also on
  // the first observation after start when it isn't working (a restart during an outage still warns once). Constants only.
  transition(name, mem, state, mode, required) {
    const previous = mem.state;
    if (previous === state) return;
    mem.state = state; mem.since = this.now();
    const working = (s) => s === "ok" || s === "small_mode";
    if (working(state) && (previous === undefined || working(previous))) return;
    const missing = required.filter((r) => r.present === false).map((r) => r.name);
    this.logger.warn?.(`[fabric] index health: ${name} ${state} (mode ${mode}${missing.length ? `; missing ${missing.join(", ")}` : ""})${previous ? ` after ${previous}` : ""}`);
  }
}

// healthy | degraded | unavailable, from a snapshot (or a part() failure).
function overallStatus(snap) {
  if (!snap || snap.unavailable || !snap.datasets) return "unavailable";
  const list = Object.values(snap.datasets);
  if (!list.length || list.every((d) => ["unavailable", "unsafe"].includes(d.state))) return "unavailable";
  const near = (d) => d.state === "small_mode" && typeof d.estimate === "number" && d.estimate >= NEAR_LIMIT * (d.scanMax || 20000);
  return list.every((d) => d.state === "ok" || (d.state === "small_mode" && !near(d))) ? "healthy" : "degraded";
}

// Everyone allowed to see System Health but not Fabric Data: the overall status and when it was checked. Nothing else.
function generalView(snap) {
  return { detail: false, status: snap?.datasets || snap?.unavailable ? overallStatus(snap) : oneOf(snap?.status, OVERALL, "unavailable"), checkedAt: isoText(snap?.checkedAt) };
}

// Fabric readers: the detail, rebuilt field by field. Index names and keys are looked up again from datasets.js / RECOMMENDED
// by name (never copied from the input). admin (JARC administrators) adds servedBy and the background check's times.
function detailedView(snap, { admin = false } = {}) {
  if (!snap || snap.unavailable || !snap.datasets) return { detail: true, status: "unavailable", unavailable: true, checkedAt: null };
  const datasets = {};
  for (const name of DATASET_NAMES) {
    const d = snap.datasets[name];
    if (!d) continue;
    const known = requiredFor(name, true);
    datasets[name] = {
      label: DATASETS[name].label, state: oneOf(d.state, STATES), mode: oneOf(d.mode, MODES), reason: REASONS.includes(d.reason) ? d.reason : null,
      estimate: num(d.estimate), scanMax: num(d.scanMax), lastVerifiedAt: isoText(d.lastVerifiedAt), latestDate: isoText(d.latestDate), earliestDate: isoText(d.earliestDate),
      requiredIndexes: (Array.isArray(d.requiredIndexes) ? d.requiredIndexes : []).map((r) => {
        const k = known.find((x) => x.name === r?.name);
        if (!k) return null;
        const needs = (Array.isArray(r.neededFor) ? r.neededFor : []).filter((n) => k.neededFor.includes(n));
        return { name: k.name, keys: { ...k.keys }, neededFor: needs, present: bool(r.present), nameTaken: bool(r.nameTaken), ...(admin ? { servedBy: typeof r.servedBy === "string" && INDEX_NAME.test(r.servedBy) ? r.servedBy : null } : {}) };
      }).filter(Boolean),
      copy: d.copy ? { loadedAt: isoText(d.copy.loadedAt), newestIdAt: isoText(d.copy.newestIdAt) } : null,
      reload: d.reload ? { detectedAt: isoText(d.reload.detectedAt), basis: oneOf(d.reload.basis, ["id", "source_returned"]) } : null
    };
  }
  const b = snap.background;
  return {
    detail: true, status: overallStatus({ datasets }), checkedAt: isoText(snap.checkedAt), connection: oneOf(snap.connection, CONNECTION_STATES), datasets,
    ...(admin && b ? { background: { everyMinutes: num(b.everyMinutes), running: bool(b.running), lastRunAt: isoText(b.lastRunAt), lastOkAt: isoText(b.lastOkAt) } } : {})
  };
}

module.exports = { FabricIndexHealth, overallStatus, generalView, detailedView, requiredFor, STATES, EVERY_MS };
