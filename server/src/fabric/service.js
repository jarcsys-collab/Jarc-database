// Fabric Data, read only: the dataset explorers (sales → FactSales, inventory → FactInventory; datasets.js) and the v1 invoice
// views over FactSales (FABRIC_INVOICE_VIEWS). Dataset access = { datasets: Set, sensitive: boolean }: sensitive fields are
// never projected or returned without it. Invoice access = { cost: boolean } (= sensitive): landed cost, profit and margin are
// computed only for it. Output values: JS numbers stay numbers, Decimal128 becomes an exact string, dates ISO strings,
// ObjectIds hex; no driver type reaches JSON.
const { FIELD_NAMES, COST_FIELD, DOTTED_FIELD, KEY_FIELDS, HEADER_FIELDS, isRestricted } = require("./fields");
const { DATASET_NAMES, datasetNamed, permittedFields, typeOfField } = require("./datasets");
const { DatasetSource } = require("./source");
const { and, afterInOrder, sortKeys, prefix, contains, valueOf } = require("./repository");
const { fabricError, isFabricError } = require("./errors");
const { encodeCursor, decodeCursor, recordsQuery, resolveWindow, LIMITS } = require("./validation");

// A value as JSON may carry it.
function plain(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  switch (value._bsontype) {
    case "Decimal128": return value.toString();
    case "ObjectId": return value.toHexString();
    case "Long": return value.toString();
    case "Int32": case "Double": return Number(value.valueOf());
    default: break;
  }
  if (Array.isArray(value)) return value.map(plain);
  return null; // nested documents and other BSON types are never passed through
}
function typeOf(value) {
  if (value === undefined || value === null) return "null";
  if (value instanceof Date) return "date";
  if (typeof value === "number" || value?._bsontype === "Int32" || value?._bsontype === "Double" || value?._bsontype === "Long") return "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "bool";
  if (value?._bsontype === "Decimal128") return "decimal";
  if (value?._bsontype === "ObjectId") return "objectId";
  return "null";
}
const round2 = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
// A header value from repository.invoiceSummary: { n, i, v } for the first line that has one, or null.
const firstPresent = (first) => (first && typeof first === "object" && !first._bsontype && !(first instanceof Date) ? first.v ?? null : null);
const distinct = (values) => (Array.isArray(values) ? [...new Set(values.filter((v) => v !== null && v !== undefined).map(plain))].sort() : []);
const costOf = (doc) => ({ landedCost: plain(doc.costLanded), profit: plain(doc.costProfit), marginPct: round2(doc.costMargin), rowsWithCost: doc.rowsWithCost ?? 0 });
const accessOut = (access) => ({ cost: Boolean(access?.cost) });

function lineItem(doc, cost) {
  const item = {
    id: plain(doc._id), lineNo: plain(doc.Line_No), hasLineDetail: doc.Line_No !== null && doc.Line_No !== undefined,
    itemId: plain(doc.invoice_item_id), itemName: plain(doc.invoice_item_name), description2: plain(doc.Description_2),
    quantity: plain(doc.invoice_item_quantity), amount: plain(doc.invoice_item_amount),
    quantitySales: plain(doc.invoice_item_quantity_sales), amountSales: plain(doc.invoice_item_amount_sales), unitPrice: plain(doc.Unit_Price),
    uom: plain(doc.uom_code ?? doc.uom), salesDataSource: plain(doc.sales_data_source), salesType: plain(doc.sales_type)
  };
  if (cost) item.cost = { landedCostPerUnit: plain(doc.lc), landedCost: plain(doc.lineCost), profit: plain(doc.lineProfit), marginPct: round2(doc.lineMargin) };
  return item;
}

// ---- Dataset explorers ----
// The access a dataset response reports: the datasets this caller may read and whether it sees sensitive fields.
const datasetAccess = (access) => ({ datasets: DATASET_NAMES.filter((n) => access?.datasets?.has?.(n)), sensitive: access?.sensitive === true });
// A field's value as JSON carries it; Business Central's blank dates (0001-01-01) become null.
function outValue(ds, field, raw) {
  if (raw instanceof Date && ds.blankDateFields.includes(field) && raw.getUTCFullYear() < 1900) return null;
  return plain(raw);
}
const REASON_ORDER = ["FABRIC_UNSAFE_CREDENTIALS", "FABRIC_UNAVAILABLE", "FABRIC_SOURCE_MISSING", "FABRIC_INDEX_REQUIRED"];
const sortModes = (ds, info) => Object.fromEntries(Object.keys(ds.sorts).map((s) => [s, info?.hints[s] ? "indexed" : info?.small ? "small" : "unavailable"]));

class FabricService {
  // repository: FabricRepository; sources: { [dataset]: DatasetSource }; indexes: FabricIndexes (the invoice views);
  // config: config.fabricData; now: for tests.
  constructor({ repository, sources = {}, indexes, config, connection = null, now = () => new Date() }) {
    this.repository = repository;
    this.sources = sources;
    this.indexes = indexes;
    this.config = config;
    this.connection = connection;
    this.now = now;
  }

  get limits() {
    return { defaultDays: LIMITS.defaultDays, maxDays: LIMITS.maxDays, maxWindowRows: this.config.maxWindowRows, recordPageMax: LIMITS.recordPageMax, recordPageDefault: LIMITS.recordPageDefault, unindexedScanMax: this.config.unindexedScanMax ?? 20000, invoicePageMax: LIMITS.invoicePageMax, linePageMax: LIMITS.linePageMax };
  }

  source(name) {
    const source = this.sources[name];
    if (!source || !datasetNamed(name)) throw new Error("fabric service: no such dataset source.");
    return source;
  }

  // Always answers (the route sends 200): per dataset the caller may read, whether it's there, its mode (indexed | small |
  // unavailable), size estimate, missing indexes and date span. available: at least one dataset can be read.
  async status(access) {
    const datasets = {};
    for (const name of datasetAccess(access).datasets) datasets[name] = await this.datasetStatus(name);
    const states = Object.values(datasets);
    const available = states.some((d) => d.available);
    const reason = available ? null : REASON_ORDER.find((r) => states.some((d) => d.reason === r)) || "FABRIC_UNAVAILABLE";
    const out = { available, reason, checkedAt: this.now().toISOString(), datasets, access: datasetAccess(access), limits: this.limits };
    if (this.config.invoiceViews && access?.datasets?.has?.("sales")) {
      try {
        const caps = await this.indexes.capabilities();
        out.invoiceViews = { capabilities: { invoiceList: caps.invoiceList, invoiceDetail: caps.invoiceDetail }, missingIndexes: caps.missingIndexes };
      } catch (error) {
        if (!isFabricError(error)) throw error;
        out.invoiceViews = { capabilities: { invoiceList: false, invoiceDetail: false }, missingIndexes: [] };
      }
    }
    return out;
  }

  async datasetStatus(name) {
    const ds = datasetNamed(name), source = this.source(name);
    const window = (small) => ({ field: ds.dateField, defaultDays: LIMITS.defaultDays, maxDays: ds.windowOptionalWhenSmall && small ? null : ds.maxDays, optional: Boolean(ds.windowOptionalWhenSmall && small) });
    try {
      // Fresh: MongoDB counts a missing collection as 0 documents, and listIndexes says it's gone (FABRIC_SOURCE_MISSING).
      source.invalidate();
      const info = await source.info();
      const bounds = await source.bounds();
      const mode = DatasetSource.modeOf(info, ds);
      return {
        available: mode !== "unavailable", reason: mode === "unavailable" ? "FABRIC_INDEX_REQUIRED" : null, label: ds.label, mode,
        estimate: info.estimate, missingIndexes: info.missingIndexes, earliestDate: plain(bounds.earliestDate), latestDate: plain(bounds.latestDate),
        sorts: sortModes(ds, info), window: window(mode === "small")
      };
    } catch (error) {
      if (!isFabricError(error)) throw error;
      const reason = ["FABRIC_SOURCE_MISSING", "FABRIC_UNSAFE_CREDENTIALS"].includes(error.code) ? error.code : "FABRIC_UNAVAILABLE";
      return { available: false, reason, label: ds.label, mode: "unavailable", estimate: null, missingIndexes: [], earliestDate: null, latestDate: null, sorts: sortModes(ds, null), window: window(false) };
    }
  }

  // GET /:dataset/schema: no database call. Sensitive fields are left out entirely unless the caller may see them.
  schema(name, access) {
    const ds = datasetNamed(name);
    const sensitive = access?.sensitive === true;
    const filterFields = new Set(Object.values(ds.filters).map((f) => f.field));
    const searchFields = new Set(ds.searchFields.map(([f]) => f));
    const sortOf = Object.fromEntries(Object.entries(ds.sorts).map(([s, def]) => [def.lead, s]));
    return {
      dataset: ds.name, label: ds.label,
      fields: permittedFields(ds, sensitive).map((f) => ({ name: f, type: typeOfField(ds, f), sensitive: ds.sensitive.includes(f), filterable: filterFields.has(f), sortable: Boolean(sortOf[f]), sort: sortOf[f] || null, searchable: searchFields.has(f) })),
      filters: Object.entries(ds.filters).map(([filter, f]) => ({ name: filter, field: f.field, type: f.type })),
      // requiresCompany: the records request must name a company (company=~ for none); dateRange false: dateFrom / dateTo
      // are refused with this sort.
      sorts: Object.entries(ds.sorts).map(([s, def]) => ({ name: s, field: def.lead, keys: def.keys.map(([f]) => f), default: s === ds.defaultSort, requiresCompany: def.requiresCompany === true, dateRange: def.noDateWindow !== true })),
      search: ds.searchFields.map(([field, match]) => ({ field, match })),
      defaultColumns: [...ds.defaultColumns], dateField: ds.dateField, companyField: ds.companyField, recordKey: [...ds.recordKey],
      access: datasetAccess(access)
    };
  }

  // GET /:dataset/records: one page in a sort's order (keyset cursor). No totals: they would need a scan.
  async listRecords(name, rawQuery, access) {
    const ds = datasetNamed(name), source = this.source(name);
    const sensitive = access?.sensitive === true;
    const query = recordsQuery(ds, rawQuery, { sensitive }); // 400s before any database call
    const plan = await source.plan(query.sort); // FABRIC_INDEX_REQUIRED before any query (small mode: on a fresh estimate)
    const sortDef = ds.sorts[query.sort];
    // A sort not led by the date (noDateWindow) never has a window: its company bounds the index walk instead.
    const optional = Boolean(sortDef.noDateWindow || (ds.windowOptionalWhenSmall && plan.mode === "small"));
    const needsLatest = !query.to && !(optional && !query.from);
    const latest = needsLatest ? (await source.bounds()).latestDate : null;
    const window = sortDef.noDateWindow ? null : resolveWindow(query, { latest, now: this.now(), maxDays: optional ? null : ds.maxDays, optional });
    const keys = sortKeys(sortDef, query.dir);
    const binding = { w: window ? [window.dateFrom, window.dateTo] : null, f: query.filters.map((f) => [f.name, f.value]), q: query.q, s: query.sort, d: query.dir };
    const route = `records:${ds.name}`;
    const cursorValues = decodeCursor(query.cursor, route, binding, keys.length);

    const base = [];
    if (window) base.push({ [ds.dateField]: { $gte: window.from, $lt: window.toExcl } });
    const company = query.filters.find((f) => f.name === "company");
    if (company) base.push({ [company.field]: company.value });
    const others = query.filters.filter((f) => f.name !== "company").map((f) => ({ [f.field]: f.value }));
    const search = query.q ? { $or: ds.searchFields.map(([f, kind]) => (kind === "prefix" ? prefix(f, query.q, false) : contains(f, query.q))) } : null;

    // A search or an equality filter can match few rows, so a page might walk the whole window (or the whole company, for a
    // company-bounded sort): only ranges of at most FABRIC_MAX_WINDOW_ROWS rows are searched or filtered. They are counted
    // with the query's own index over exactly the range it bounds (window + company), up to max + 1; small mode skips the
    // count only when the whole collection is under the cap.
    if (query.q || others.length) {
      const max = this.config.maxWindowRows;
      const info = await source.info();
      if (plan.mode === "indexed" || info.estimate > max) {
        const rows = await this.repository.countMatching(ds, and(...base), { hint: plan.hint, limit: max + 1 });
        if (rows > max) throw fabricError("FABRIC_RANGE_TOO_LARGE", { rows, max });
      }
    }

    // A company-bound sort led by the company key: that key is fixed by the company filter (and the signed cursor matches it).
    const pinned = sortDef.requiresCompany && keys[0][0] === ds.companyField ? 1 : 0;
    const match = and(...base, ...others, search, afterInOrder(keys, cursorValues, pinned));
    const docs = await this.repository.records(ds, { match, keys, limit: query.limit, fields: query.fields, hint: plan.hint });
    if (!docs.length) { source.invalidate(); await source.plan(query.sort); } // a dropped collection answers with nothing
    const more = docs.length > query.limit;
    const shown = docs.slice(0, query.limit);
    const last = shown.at(-1);
    return {
      dataset: ds.name, mode: plan.mode, fields: query.fields,
      items: shown.map((doc) => ({ id: plain(doc._id), values: Object.fromEntries(query.fields.map((f) => [f, outValue(ds, f, valueOf(doc, f))])) })),
      pagination: { limit: query.limit, hasMore: more, nextCursor: more && last ? encodeCursor(route, binding, keys.map(([f]) => valueOf(last, f) ?? null)) : null },
      window: window ? { field: ds.dateField, dateFrom: window.dateFrom, dateTo: window.dateTo, defaulted: window.defaulted } : { field: ds.dateField, dateFrom: null, dateTo: null, defaulted: false, all: true },
      sort: { name: query.sort, dir: query.dir === 1 ? "asc" : "desc" },
      access: datasetAccess(access)
    };
  }

  // GET /:dataset/records/:id: every permitted field in the verified order, and the display key.
  async getRecord(name, id, access) {
    const ds = datasetNamed(name), source = this.source(name);
    const fields = permittedFields(ds, access?.sensitive === true);
    const doc = await this.repository.record(ds, { id, fields });
    if (!doc) { source.invalidate(); await source.info(); throw fabricError("FABRIC_RECORD_NOT_FOUND"); }
    return {
      dataset: ds.name,
      record: {
        id: plain(doc._id),
        key: Object.fromEntries(ds.recordKey.map((f) => [f, outValue(ds, f, valueOf(doc, f))])),
        fields: fields.map((f) => { const raw = valueOf(doc, f); return { name: f, value: outValue(ds, f, raw), type: typeOf(raw) }; })
      },
      access: datasetAccess(access)
    };
  }

  // ---- Invoice views (FABRIC_INVOICE_VIEWS) ----
  // A query on a dropped collection (e.g. during an upstream reload) simply finds nothing: MongoDB doesn't fail it, not even
  // with a hint. So an empty answer is confirmed by re-reading the indexes, bypassing their cache: FABRIC_SOURCE_MISSING when
  // the collection is gone, FABRIC_INDEX_REQUIRED when it came back without the capability's index.
  async recheck(capability = null) {
    this.indexes.invalidate();
    if (capability) await this.indexes.require(capability);
    return this.indexes.capabilities();
  }

  async listInvoices(query, access) {
    const cost = Boolean(access?.cost);
    const hint = await this.indexes.require("invoiceList");
    const max = this.config.maxWindowRows;
    const rows = await this.repository.countWindow(query.window, { hint, max });
    if (rows > max) throw fabricError("FABRIC_RANGE_TOO_LARGE", { rows, max });
    if (rows === 0) await this.recheck("invoiceList");
    const sort = query.sort, dir = query.dir;
    const page = await this.repository.invoiceList({ window: query.window, sort, dir, cursorValues: query.cursorValues, limit: query.limit, cost, hint, rowLimit: max + 1 });
    const more = page.items.length > query.limit;
    const docs = page.items.slice(0, query.limit);
    const last = docs.at(-1);
    const items = docs.map((doc) => {
      const item = {
        company: plain(doc.company), invoiceNo: plain(doc.invoiceNo), invoiceDate: plain(doc.invoiceDate), dueDate: plain(doc.dueDate),
        customerId: plain(doc.customerId), customerName: plain(doc.customerName), rows: doc.rows, lineDetailRows: doc.lineDetailRows,
        amount: plain(doc.amount), quantity: plain(doc.quantity), headerTotal: plain(doc.headerTotal), sources: distinct(doc.sources),
        cancelled: plain(doc.cancelled), closed: plain(doc.closed)
      };
      if (cost) item.cost = costOf(doc);
      return item;
    });
    return {
      items,
      pagination: { limit: query.limit, hasMore: more, nextCursor: more && last ? encodeCursor("invoices", query.binding, page.keys.map((k) => last[k])) : null },
      total: { invoices: page.total.invoices ?? 0, rows: page.total.rows ?? 0 },
      window: { dateFrom: query.window.dateFrom, dateTo: query.window.dateTo },
      companies: page.companies.map((c) => ({ company: plain(c._id), rows: c.rows })),
      access: accessOut(access)
    };
  }

  async getInvoice(company, invoiceNo, access) {
    const cost = Boolean(access?.cost);
    const hint = await this.indexes.require("invoiceDetail");
    const s = await this.repository.invoiceSummary({ company, invoiceNo, cost, hint, rowLimit: this.config.maxWindowRows });
    if (!s || !s.rows) { await this.recheck("invoiceDetail"); throw fabricError("FABRIC_INVOICE_NOT_FOUND"); }
    const header = Object.fromEntries(HEADER_FIELDS.map((f) => [f, plain(firstPresent(s[`h_${f}`]))]));
    header.sales_data_source = distinct(s.sources);
    header.sales_type = distinct(s.salesTypes);
    if (cost) header.territory = plain(firstPresent(s.h_territory)); // Custom.2: restricted
    const invoice = {
      company, invoiceNo, invoiceDate: plain(s.firstDate), dueDate: plain(firstPresent(s.h_dueDate)),
      customerId: plain(firstPresent(s.h_customerId)), customerName: plain(firstPresent(s.h_customerName)), header,
      summary: { rows: s.rows, lineDetailRows: s.lineDetailRows, amount: plain(s.amount), quantity: plain(s.quantity), headerTotal: plain(s.headerTotal), sources: distinct(s.sources), firstDate: plain(s.firstDate), lastDate: plain(s.lastDate) }
    };
    if (cost) invoice.cost = costOf(s);
    return { invoice, access: accessOut(access) };
  }

  async listInvoiceLines(company, invoiceNo, query, access) {
    const cost = Boolean(access?.cost);
    const hint = await this.indexes.require("invoiceDetail");
    const docs = await this.repository.invoiceLines({ company, invoiceNo, cursorValues: query.cursorValues, limit: query.limit, cost, hint });
    if (!docs.length) await this.recheck("invoiceDetail");
    if (!docs.length && !query.cursorValues) throw fabricError("FABRIC_INVOICE_NOT_FOUND");
    return this.page(docs, query, "lines", (doc) => [doc.Line_No ?? null, doc._id], (doc) => lineItem(doc, cost), access);
  }

  async getLine(company, invoiceNo, id, access) {
    const cost = Boolean(access?.cost);
    const doc = await this.repository.line({ company, invoiceNo, id, cost });
    if (!doc) { await this.recheck(); throw fabricError("FABRIC_LINE_NOT_FOUND"); }
    // A final allow-list: only the verified names, in their order, whatever else the document has.
    const fields = FIELD_NAMES.filter((name) => cost || !isRestricted(name)).map((name) => {
      const raw = name === DOTTED_FIELD ? doc.custom2 : doc[name];
      return { name, value: plain(raw), type: typeOf(raw) };
    });
    const keys = Object.fromEntries(KEY_FIELDS.map((k) => [k, plain(doc[k])]));
    return { line: { id: plain(doc._id), fields, keys }, access: accessOut(access) };
  }

  page(docs, query, route, keyOf, map, access) {
    const more = docs.length > query.limit;
    const shown = docs.slice(0, query.limit);
    const last = shown.at(-1);
    return { items: shown.map(map), pagination: { limit: query.limit, hasMore: more, nextCursor: more && last ? encodeCursor(route, query.binding, keyOf(last)) : null }, access: accessOut(access) };
  }
}

module.exports = { FabricService, plain, typeOf };
