// What one dataset (datasets.js) can do right now, cached for 60 s: its indexes (listIndexes), its size
// (estimatedDocumentCount, collection metadata, no scan) and its earliest / latest date. From these, per sort:
//   indexed  a plain index with exactly the sort's keys (or their reverse) exists: queries hint it
//   small    no such index, but the dataset has at most FABRIC_UNINDEXED_SCAN_MAX documents: queries may run without an index
//            (still maxTimeMS, an inclusion projection and a limit; sorted in memory over the projected fields)
//   otherwise 503 FABRIC_INDEX_REQUIRED before any query is sent.
// The dates come from the date index (sort + limit 1, twice) or, in small mode, from one bounded aggregate; they are cached
// separately, so the cheap index re-check after an empty answer doesn't re-read them.
const { detectSorts, CACHE_MS } = require("./indexes");
const { fabricError, isFabricError } = require("./errors");

// The earliest date BSON can hold that JS can too: { field: { $gte: MIN_DATE } } keeps dates only (type bracketing) and gives an
// index bound.
const MIN_DATE = new Date(-8.64e15);

class DatasetSource {
  // dataset: a datasets.js entry. repository: FabricRepository. scanMax: config.unindexedScanMax.
  constructor({ dataset, repository, scanMax = 20000, cacheMs = CACHE_MS, now = Date.now }) {
    this.dataset = dataset;
    this.repository = repository;
    this.scanMax = scanMax;
    this.cacheMs = cacheMs;
    this.now = now;
    this.cached = null; this.loading = null;
    this.boundsCache = null; this.boundsLoading = null;
  }

  // { estimate, hints: { sort: name|null }, missingIndexes, small } — throws FABRIC_SOURCE_MISSING when there's no collection.
  async info() {
    if (this.cached && this.now() - this.cached.at < this.cacheMs) return this.cached.value;
    this.loading ??= (async () => {
      const collection = this.dataset.collection;
      const list = await this.repository.listIndexes(collection);
      const { hints, missingIndexes } = detectSorts(this.dataset, list);
      const estimate = await this.repository.estimate(collection);
      const value = { estimate, hints, missingIndexes, small: Number.isInteger(estimate) && estimate <= this.scanMax };
      // The index names seen (internal, for index health only: kept beside the value, so /status never sees them).
      this.cached = { at: this.now(), value, names: (Array.isArray(list) ? list : []).map((i) => i?.name).filter((n) => typeof n === "string") };
      return value;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  // How a query with this sort runs: { mode: "indexed", hint } | { mode: "small", hint: null }, or FABRIC_INDEX_REQUIRED.
  async plan(sortName) {
    const info = await this.info();
    const hint = info.hints[sortName];
    if (hint) return { mode: "indexed", hint };
    // Small mode is never decided from the cached size alone: the estimate (collection metadata, no scan) is re-read right
    // before every unindexed query; a collection grown past FABRIC_UNINDEXED_SCAN_MAX is FABRIC_INDEX_REQUIRED.
    if (info.small && await this.stillSmall()) return { mode: "small", hint: null };
    throw fabricError("FABRIC_INDEX_REQUIRED", { missingIndexes: info.missingIndexes.filter((m) => m.neededFor.includes(`sort:${sortName}`)) });
  }

  // A fresh estimate ≤ the threshold; otherwise the cached size is dropped (status then reports the larger one).
  async stillSmall() {
    const estimate = await this.repository.estimate(this.dataset.collection);
    if (Number.isInteger(estimate) && estimate <= this.scanMax) return true;
    this.invalidate();
    return false;
  }

  // The dataset's mode as a whole (its default sort): indexed | small | unavailable.
  static modeOf(info, dataset) {
    return info.hints[dataset.defaultSort] ? "indexed" : info.small ? "small" : "unavailable";
  }

  // { earliestDate, latestDate } (Date or null). Never fails for a timeout or an index problem: the dates are then null.
  // The cached dates are only reused while they were worked out the same way (same index, or small mode, or neither): dates
  // cached as null while an index was missing are dropped as soon as the index appears, instead of up to a minute later.
  async bounds() {
    const current = await this.info();
    const basis = current.hints[this.dataset.defaultSort] || (current.small ? "small" : "none");
    if (this.boundsCache && this.boundsCache.basis === basis && this.now() - this.boundsCache.at < this.cacheMs) return this.boundsCache.value;
    this.boundsLoading ??= (async () => {
      const info = await this.info();
      const ds = this.dataset, field = ds.dateField;
      const hint = info.hints[ds.defaultSort];
      let value = { earliestDate: null, latestDate: null };
      try {
        if (hint) {
          const one = async (dir) => {
            const [doc] = await this.repository.aggregate([{ $match: { [field]: { $gte: MIN_DATE } } }, { $sort: { [field]: dir } }, { $limit: 1 }, { $project: { _id: 0, [field]: 1 } }], { collection: ds.collection, hint });
            return doc?.[field] instanceof Date ? doc[field] : null;
          };
          value = { latestDate: await one(-1), earliestDate: await one(1) };
        } else if (info.small && await this.stillSmall()) {
          const [doc] = await this.repository.aggregate([
            { $match: { [field]: { $gte: MIN_DATE } } }, { $limit: this.scanMax + 1 }, { $project: { _id: 0, d: "$" + field } },
            { $group: { _id: null, min: { $min: "$d" }, max: { $max: "$d" } } }
          ], { collection: ds.collection, unindexed: true });
          value = { earliestDate: doc?.min instanceof Date ? doc.min : null, latestDate: doc?.max instanceof Date ? doc.max : null };
        }
      } catch (error) {
        if (!isFabricError(error) || ["FABRIC_SOURCE_MISSING", "FABRIC_UNSAFE_CREDENTIALS", "FABRIC_UNAVAILABLE"].includes(error.code)) throw error;
      }
      this.boundsCache = { at: this.now(), value, basis: hint || (info.small ? "small" : "none") };
      return value;
    })().finally(() => { this.boundsLoading = null; });
    return this.boundsLoading;
  }

  // Index health (health.js), read-only, never a query: when info() last succeeded (ms, or null) and the index names it saw.
  get cachedAt() { return this.cached ? this.cached.at : null; }
  get indexNames() { return this.cached ? [...this.cached.names] : null; }

  // After a query on a dropped collection (MongoDB answers it with nothing, not an error) or a vanished index.
  invalidate({ bounds = false } = {}) { this.cached = null; if (bounds) this.boundsCache = null; }
}

module.exports = { DatasetSource, MIN_DATE };
