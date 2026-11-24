// Which Fabric Data features the indexes support. JARC's reader can't create indexes (the data owner does). The v1 invoice views
// (FactSales only, FABRIC_INVOICE_VIEWS) never run without their index: a missing one is 503 FABRIC_INDEX_REQUIRED. The
// dataset explorers (source.js) use detectSorts below and may also run in small-collection mode. Detected from listIndexes,
// cached for 60 s; invalidated when a hinted query fails because its index is gone, or when the collection itself is missing.
const { fabricError } = require("./errors");

// What the data owner should create for the invoice views (also listed by GET /status while they're on).
const RECOMMENDED = Object.freeze({
  date: Object.freeze({ name: "fabric_invoice_date", keys: Object.freeze({ invoice_date: -1, Company: 1, invoice_id: 1, _id: 1 }) }),
  detail: Object.freeze({ name: "fabric_invoice_detail", keys: Object.freeze({ Company: 1, invoice_id: 1, Line_No: 1, _id: 1 }) })
});
const CACHE_MS = 60 * 1000;

const direction = (v) => (typeof v === "number" || typeof v?.valueOf?.() === "number" ? Math.sign(Number(v)) : 0);
// [[field, ±1], …] for a plain ascending/descending index; null for text, hashed, wildcard, partial, sparse or collated ones,
// which can't serve every document the way the queries expect.
function plainKeys(index) {
  if (!index?.key || typeof index.name !== "string" || index.partialFilterExpression || index.sparse || index.collation?.locale && index.collation.locale !== "simple") return null;
  const keys = Object.entries(index.key).map(([field, v]) => [field, direction(v)]);
  return keys.length && keys.every(([, d]) => d === 1 || d === -1) ? keys : null;
}
const sameKeys = (keys, wanted, flip) => keys.length === wanted.length && keys.every(([f, d], i) => f === wanted[i][0] && d === wanted[i][1] * flip);

// The invoice-view capabilities of a FactSales listIndexes result: { invoiceList, invoiceDetail, hints: { list, detail }, missingIndexes }.
function detectCapabilities(indexes) {
  const plain = plainIndexes(indexes);
  const dateWanted = Object.entries(RECOMMENDED.date.keys);
  // The invoice list groups a date window: any index led by invoice_date bounds it (the exact one, or its reverse, preferred).
  const list = plain.find((i) => sameKeys(i.keys, dateWanted, 1) || sameKeys(i.keys, dateWanted, -1)) || plain.find((i) => i.keys[0][0] === "invoice_date") || null;
  // Invoice detail and lines: Company + invoice_id first (with Line_No next preferred: lines come back in that order).
  const ledByInvoice = plain.filter((i) => i.keys.length >= 2 && i.keys[0][0] === "Company" && i.keys[1][0] === "invoice_id");
  const detail = ledByInvoice.find((i) => i.keys[2]?.[0] === "Line_No") || ledByInvoice[0] || null;
  const missingIndexes = [];
  if (!list) missingIndexes.push({ ...RECOMMENDED.date, keys: { ...RECOMMENDED.date.keys }, neededFor: ["invoiceList"] });
  if (!detail) missingIndexes.push({ ...RECOMMENDED.detail, keys: { ...RECOMMENDED.detail.keys }, neededFor: ["invoiceDetail"] });
  return { invoiceList: Boolean(list), invoiceDetail: Boolean(detail), hints: { list: list?.name ?? null, detail: detail?.name ?? null }, missingIndexes };
}
const plainIndexes = (indexes) => (indexes || []).map((index) => ({ name: index.name, keys: plainKeys(index) })).filter((i) => i.keys);

// A dataset's sorts (datasets.js): each streams in index order with a keyset on all its keys, so only that exact index (or its
// exact reverse) will do. → { hints: { sortName: indexName | null }, missingIndexes: [{ name, keys, neededFor: ["sort:<name>"] }] }
function detectSorts(dataset, indexes) {
  const plain = plainIndexes(indexes);
  const hints = {}, missingIndexes = [];
  for (const [name, sort] of Object.entries(dataset.sorts)) {
    const found = plain.find((i) => sameKeys(i.keys, sort.keys, 1) || sameKeys(i.keys, sort.keys, -1));
    hints[name] = found?.name ?? null;
    if (!found) missingIndexes.push({ name: dataset.indexes[name].name, keys: { ...dataset.indexes[name].keys }, neededFor: [`sort:${name}`] });
  }
  return { hints, missingIndexes };
}

class FabricIndexes {
  // listIndexes: async () => the FactSales index list (repository.listIndexes); it throws FABRIC_SOURCE_MISSING when there's no collection.
  constructor({ listIndexes, cacheMs = CACHE_MS, now = Date.now }) {
    this.listIndexes = listIndexes;
    this.cacheMs = cacheMs;
    this.now = now;
    this.cached = null;
    this.loading = null;
  }

  async capabilities() {
    if (this.cached && this.now() - this.cached.at < this.cacheMs) return this.cached.value;
    this.loading ??= (async () => {
      const value = detectCapabilities(await this.listIndexes());
      this.cached = { at: this.now(), value };
      return value;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  // The capability's hint (an index name), or 503 FABRIC_INDEX_REQUIRED before any query is sent.
  async require(capability) {
    const caps = await this.capabilities();
    if (!caps[capability]) throw fabricError("FABRIC_INDEX_REQUIRED", { missingIndexes: caps.missingIndexes.filter((m) => m.neededFor.includes(capability)) });
    return caps.hints[{ invoiceList: "list", invoiceDetail: "detail" }[capability]];
  }

  invalidate() { this.cached = null; }
}

module.exports = { FabricIndexes, detectCapabilities, detectSorts, plainKeys, RECOMMENDED, CACHE_MS };
