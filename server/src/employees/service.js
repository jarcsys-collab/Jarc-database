// Employee Management, read only: status, schema, records, one record and value lists over the in-memory snapshot. The response
// shapes follow the advanced session explorer's (schema fields with kind / operators / valueSource / orderable, filterModel,
// searchFields; records { items: [{ id, values }], pagination }; values { values: [{ value, count, blank? }] }) so the same
// explorer UI can read them. Every response is built field by field from the API allow-list (fields.js): no document is ever
// spread, and the account's object ID, source _id, phones and company never appear.
// access: { view, admin, datasets: [...] } (access.js) plus who (the caller's JARC user id, which binds cursors).
// P2: access.jarcAccess (set by the router only when the JARC access index is wired AND the caller is an Employee Management
// admin) selects the P2 descriptor (fields.js JARC_DATASETS): the P1 fields plus the JARC access fields. Every method then takes
// the index as `jarc`; the rows carry the JARC values only when the request uses one of those fields (or a profile is read),
// so a plain directory request never waits for JARC's database. Without jarcAccess everything is exactly P1.
const fm = require("../fabric/filter-model");
const { ALL_FIELDS: FIELDS, DATASET_NAMES, datasetNamed, outValue, isJarcField } = require("./fields");
const { ID_PATTERN } = require("./ids");
const { employeeError, invalid } = require("./errors");
const { filterPredicate, searchPredicate, comparator, stripField, encodeCursor, decodeCursor } = require("./query");

const LIMITS = Object.freeze({ recordPageDefault: 100, recordPageMax: 200, valuesDefault: 100, valuesMax: 500, maxQ: 100, maxAfter: 400 });
const CONTROL = /[\u0000-\u001f\u007f]/;

// Only the listed parameters, each once as text. The parameter name is never echoed.
function params(query, allowed) {
  const out = {};
  for (const key of Object.keys(query || {})) {
    if (!allowed.includes(key)) throw invalid("Unknown parameter.", "query", "unknownParameter");
    if (typeof query[key] !== "string") throw invalid("Each parameter can be given once.", "query", "repeated");
    out[key] = query[key];
  }
  return out;
}
function searchText(text) {
  if (text === undefined) return null;
  const q = text.trim();
  if (!q) return null;
  if (q.length > LIMITS.maxQ || CONTROL.test(q)) throw invalid(`q must be 1 to ${LIMITS.maxQ} characters.`, "q", "text");
  return q;
}
function whole(text, max, fallback, name) {
  if (text === undefined) return fallback;
  if (!/^\d{1,4}$/.test(text) || Number(text) < 1 || Number(text) > max) throw invalid(`${name} must be a whole number from 1 to ${max}.`, name, "range");
  return Number(text);
}
const typeOf = (f) => (["bool", "date", "number"].includes(FIELDS[f].type) ? FIELDS[f].type : "string");
// P2-only keys on a JARC access field (never on a P1 field, so viewers' schema and profiles don't change).
const jarcKeys = (f) => (isJarcField(f) ? { group: "jarc", ...(FIELDS[f].multi ? { multiValued: true } : {}) } : {});
// The fields a validated filter model names.
const modelFields = (node, out = new Set()) => { if (Array.isArray(node?.items)) node.items.forEach((n) => modelFields(n, out)); else if (node?.field) out.add(node.field); return out; };
const shownKind = (ds, f) => fm.fieldKind(ds, f) || (FIELDS[f].type === "string" ? "text" : FIELDS[f].type);
const valueFields = (ds) => ds.fields.filter((f) => fm.valueSource(ds, f) !== "none");

class EmployeeService {
  constructor({ snapshot, now = () => new Date() }) {
    if (!snapshot) throw new Error("EmployeeService needs the snapshot.");
    this.snapshot = snapshot;
    this.now = () => { const v = now(); return v instanceof Date ? v : new Date(v); };
  }

  // The dataset descriptor for a path segment the caller may read: unknown → 404 (never echoed), not granted → 403.
  // The caller's descriptor (P2 for jarcAccess), so saved filters (router datasetOf) validate against the same field list.
  dataset(name, access) {
    const ds = datasetNamed(name, { jarc: access?.jarcAccess === true });
    if (!ds) throw employeeError("NOT_FOUND");
    if (!access?.view || !access.datasets.includes(ds.name)) throw employeeError("EMPLOYEES_FORBIDDEN");
    return ds;
  }
  descriptor(name) { return datasetNamed(name); }

  // jarcAccess appears only when true: a viewer's (and a P1 mount's) access object is unchanged.
  accessOut(access) { return { datasets: [...access.datasets], admin: access.admin === true, ...(access.jarcAccess === true ? { jarcAccess: true } : {}) }; }
  rowsOf(snap, ds) { return snap.records.filter(ds.base); }
  // The rows to read: with the JARC access values when `needed` (P2 descriptor and a JARC field in use), else the snapshot's.
  // → { rows, byId }. A JARC index that can't be built at all answers 503 EMPLOYEES_UNAVAILABLE.
  async rowsFor(snap, ds, jarc, needed) {
    if (!ds.jarc || !needed) return { rows: this.rowsOf(snap, ds), byId: snap.byId };
    if (!jarc) throw employeeError("EMPLOYEES_UNAVAILABLE");
    const joined = jarc.joined(snap, await jarc.current());
    return { rows: joined.rows.filter(ds.base), byId: joined.byId };
  }

  async status(rawQuery, access, jarc = null) {
    params(rawQuery, []);
    const snap = await this.snapshot.current();
    const counts = {};
    for (const name of access.datasets) counts[name] = this.rowsOf(snap, datasetNamed(name)).length;
    const out = { available: true, snapshot: this.snapshot.meta(), access: this.accessOut(access), counts, datasets: access.datasets.map((n) => ({ name: n, label: datasetNamed(n).label })) };
    // P2 counts only (no person, no ID). The directory stays usable when JARC's database can't be read: null instead of a 503.
    if (access.jarcAccess === true && jarc) {
      try {
        const state = await jarc.current();
        out.jarcAccess = { ...jarc.joined(snap, state).summary, ...jarc.meta(state) };
      } catch (error) {
        if (error?.code !== "EMPLOYEES_UNAVAILABLE") throw error;
        out.jarcAccess = null;
      }
    }
    return out;
  }

  // No source call: the schema is fixed per dataset.
  schema(name, rawQuery, access) {
    const ds = this.dataset(name, access);
    params(rawQuery, []);
    const searchable = new Set(ds.searchFields.map(([f]) => f));
    const c = fm.catalog();
    const { maxDepth, maxConditions, maxGroups, maxListValues, maxText, maxEncoded, maxN } = c.limits;
    return {
      dataset: ds.name, label: ds.label,
      fields: ds.fields.map((f) => ({
        name: f, label: FIELDS[f].label, type: typeOf(f), sensitive: false, filterable: fm.fieldKind(ds, f) !== null, sortable: f === "displayName", sort: f === "displayName" ? "name" : null,
        searchable: searchable.has(f), kind: shownKind(ds, f), operators: fm.fieldOperators(ds, f), valueSource: fm.valueSource(ds, f), orderable: fm.orderable(ds, f), requiresDateWindow: false, ...jarcKeys(f)
      })),
      filters: [],
      sorts: [{ name: "name", field: "displayName", keys: ["displayName"], default: true, requiresCompany: false, dateRange: false, dir: "asc" }],
      search: ds.searchFields.map(([field, match]) => ({ field, match })),
      searchFields: ds.searchFields.map(([field, match]) => ({ field, match })),
      defaultColumns: [...ds.defaultColumns], recordKey: ["displayName"],
      filterModel: { version: c.version, limits: { maxDepth, maxConditions, maxGroups, maxListValues, maxText, maxEncoded, maxN }, weekStarts: c.weekStarts, timeZone: c.timeZone, units: c.units, operators: c.operators.map(({ id, label, shape, nullable }) => ({ op: id, label, shape, nullable })) },
      orderBy: { maxKeys: c.orderBy.maxKeys },
      limits: { recordPageDefault: LIMITS.recordPageDefault, recordPageMax: LIMITS.recordPageMax, valuesMax: LIMITS.valuesMax },
      access: this.accessOut(access)
    };
  }

  // The records query, checked before the snapshot is read.
  parseRecords(ds, rawQuery, now) {
    const p = params(rawQuery, ["q", "searchField", "filter", "orderBy", "limit", "cursor", "fields", "sort", "dir"]);
    let orderBy;
    try { orderBy = fm.parseOrderBy(ds, p.orderBy); } catch (error) {
      if (error?.code !== "VALIDATION_ERROR") throw error;
      const reason = error.details?.reason;
      throw invalid(reason === "unknownField" ? "Unknown field in orderBy." : reason === "duplicate" ? "orderBy can use each field once." : "orderBy takes 1 to 3 fields, such as displayName:asc.", "orderBy", reason || "orderBy");
    }
    if (orderBy && (p.sort !== undefined || p.dir !== undefined)) throw invalid("orderBy can't be combined with sort or dir.", "orderBy", "orderBy");
    if (p.sort !== undefined && p.sort !== "name") throw invalid("sort must be name.", "sort", "sort");
    if (p.dir !== undefined && p.dir !== "asc" && p.dir !== "desc") throw invalid("dir must be asc or desc.", "dir", "dir");
    const filter = p.filter !== undefined ? fm.validateFilter(ds, fm.parseFilterParam(p.filter), { now }) : null;
    let searchField = null;
    if (p.searchField !== undefined) {
      const entry = ds.searchFields.find(([f]) => f === p.searchField);
      if (!entry) throw invalid("searchField must be one of the schema's searchFields.", "searchField", "unknownField");
      searchField = entry[0];
    }
    let fields = [...ds.defaultColumns];
    if (p.fields !== undefined) {
      const names = p.fields.split(",");
      if (!p.fields.length || names.length > ds.fields.length) throw invalid(`fields must list 1 to ${ds.fields.length} field names.`, "fields", "fields");
      // The allow-list's own strings from here on; a name the dataset doesn't have is never echoed.
      fields = [...new Set(names.map((n) => { const f = ds.fields.find((x) => x === n); if (!f) throw invalid("Unknown field.", "fields", "unknownField"); return f; }))];
    }
    const keys = orderBy || [["displayName", p.dir === "desc" ? -1 : 1]];
    return { q: searchText(p.q), searchField, filter, orderBy, keys, limit: whole(p.limit, LIMITS.recordPageMax, LIMITS.recordPageDefault, "limit"), fields, cursor: p.cursor };
  }

  async listRecords(name, rawQuery, access, jarc = null) {
    const ds = this.dataset(name, access);
    const now = this.now();
    const query = this.parseRecords(ds, rawQuery, now); // 400s before the snapshot is touched
    const binding = { ds: ds.name, f: query.filter ? fm.canonicalJson(query.filter) : null, q: query.q, sf: query.searchField, ob: query.keys, who: String(access.who ?? "") };
    const after = decodeCursor(query.cursor, binding, query.keys);
    const snap = await this.snapshot.current();
    const needed = [...query.fields, ...query.keys.map(([f]) => f), ...modelFields(query.filter)].some(isJarcField);
    const { rows: source } = await this.rowsFor(snap, ds, jarc, needed);
    const pass = filterPredicate(ds, query.filter, now), search = searchPredicate(ds, query.q, query.searchField), order = comparator(query.keys);
    let rows = source.filter((r) => pass(r) && search(r)).sort(order);
    if (after) rows = rows.filter((r) => order(r, after) > 0);
    const more = rows.length > query.limit;
    const shown = rows.slice(0, query.limit);
    const last = shown.at(-1);
    const nextCursor = more && last ? encodeCursor(binding, query.keys, last) : null;
    return {
      dataset: ds.name, fields: query.fields,
      items: shown.map((r) => ({ id: r.id, values: Object.fromEntries(query.fields.map((f) => [f, outValue(r.values[f])])) })),
      pagination: { limit: query.limit, hasMore: more, nextCursor, ...(more && !nextCursor ? { cursorTooLong: true } : {}) },
      sort: query.orderBy ? { name: null, dir: query.keys[0][1] === 1 ? "asc" : "desc" } : { name: "name", dir: query.keys[0][1] === 1 ? "asc" : "desc" },
      appliedFilter: query.filter ? fm.canonical(query.filter) : null,
      orderBy: query.orderBy ? query.orderBy.map(([field, d]) => ({ field, dir: d === 1 ? "asc" : "desc" })) : null,
      searchField: query.searchField,
      snapshot: this.snapshot.meta(),
      access: this.accessOut(access)
    };
  }

  // One profile: the dataset's allow-listed fields. An ID outside the caller's dataset answers exactly like an unknown one.
  async getRecord(name, id, rawQuery, access, jarc = null) {
    const ds = this.dataset(name, access);
    params(rawQuery, []);
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw employeeError("NOT_FOUND");
    const snap = await this.snapshot.current();
    if (!snap.byId.has(id) || !ds.base(snap.byId.get(id))) throw employeeError("NOT_FOUND");
    // An admin's profile never fails because JARC's database can't be read: the P1 values, the JARC fields null, and
    // jarcAccessUnavailable: true (the access tab answers 503 on its own).
    let r, unavailable = false;
    try { r = (await this.rowsFor(snap, ds, jarc, true)).byId.get(id); } catch (error) {
      if (error?.code !== "EMPLOYEES_UNAVAILABLE") throw error;
      r = snap.byId.get(id); unavailable = true;
    }
    const values = Object.fromEntries(ds.fields.map((f) => [f, outValue(r.values[f])]));
    return {
      dataset: ds.name, id: r.id, values, ...(unavailable ? { jarcAccessUnavailable: true } : {}),
      record: { id: r.id, key: { displayName: values.displayName }, fields: ds.fields.map((f) => ({ name: f, label: FIELDS[f].label, value: values[f], type: typeOf(f), ...jarcKeys(f) })) },
      snapshot: this.snapshot.meta(),
      access: this.accessOut(access)
    };
  }

  // GET /:ds/values?field&q&after&limit&filter: the values of one value-list field over the caller's dataset (plus the other
  // active filters), with counts; the blank bucket first ({ value: null, blank: true }); at most 500 per page.
  async values(name, rawQuery, access, jarc = null) {
    const ds = this.dataset(name, access);
    const p = params(rawQuery, ["field", "q", "after", "limit", "filter"]);
    if (p.field === undefined || !p.field.length || p.field.length > 80) throw invalid("field is required.", "field", "required");
    const field = ds.fields.find((f) => f === p.field);
    if (!field) throw invalid("Unknown field.", "field", "unknownField");
    if (!valueFields(ds).includes(field)) throw invalid("This field has no value list.", "field", "noValueList");
    const q = p.q === undefined ? null : searchText(p.q);
    let after = null;
    if (p.after !== undefined) { if (p.after.length > LIMITS.maxAfter || CONTROL.test(p.after)) throw invalid("after is not valid.", "after", "text"); after = p.after; }
    const limit = whole(p.limit, LIMITS.valuesMax, LIMITS.valuesDefault, "limit");
    const now = this.now();
    const model = p.filter !== undefined ? fm.validateFilter(ds, fm.parseFilterParam(p.filter), { now }) : null;
    const context = model ? stripField(model, field) : null;
    const snap = await this.snapshot.current();
    const { rows } = await this.rowsFor(snap, ds, jarc, [field, ...modelFields(context)].some(isJarcField));
    const pass = filterPredicate(ds, context, now);
    const counts = new Map();
    const add = (v) => counts.set(v, (counts.get(v) || 0) + 1);
    for (const r of rows) {
      if (!pass(r)) continue;
      const v = r.values[field] ?? null;
      // A multi-valued field counts each element once per person; no element is the blank bucket.
      if (Array.isArray(v)) v.forEach(add); else add(v);
    }
    const needle = q ? q.toLowerCase() : null;
    // Blank first, then values in code-point order (a stable keyset for `after`).
    let list = [...counts.entries()].filter(([v]) => (needle ? v !== null && v.toLowerCase().includes(needle) : true))
      .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0));
    if (after !== null) list = list.filter(([v]) => v !== null && (after === "" || v > after));
    const more = list.length > limit;
    const shown = list.slice(0, limit);
    const last = shown.at(-1);
    const nextAfter = more && last ? (last[0] === null ? "" : last[0]) : null;
    return {
      dataset: ds.name, field, source: fm.valueSource(ds, field), match: "contains",
      values: shown.map(([value, count]) => ({ value, count, ...(value === null ? { blank: true } : {}) })),
      complete: !more, limited: more ? { reason: "valueLimit" } : null, nextAfter, next: nextAfter,
      contextual: Boolean(context),
      snapshot: this.snapshot.meta(),
      access: this.accessOut(access)
    };
  }

  // GET /:ds/records/:id/jarc-access (P2): what this account can do in JARC. jarcAccess callers only (403 EMPLOYEES_FORBIDDEN
  // otherwise, after the dataset check); the dataset and ID rules are the profile's (unknown or outside the dataset → 404). No
  // query parameters. The body (jarc-access.js detail) carries no object ID, JARC user ID or database _id.
  async jarcAccessOf(name, id, rawQuery, access, jarc = null) {
    const ds = this.dataset(name, access);
    if (access.jarcAccess !== true || !jarc) throw employeeError("EMPLOYEES_FORBIDDEN");
    params(rawQuery, []);
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw employeeError("NOT_FOUND");
    const snap = await this.snapshot.current();
    const r = snap.byId.get(id);
    if (!r || !ds.base(r)) throw employeeError("NOT_FOUND");
    const state = await jarc.current();
    return { dataset: ds.name, id: r.id, ...jarc.detail(snap, state, r) };
  }
}

module.exports = { EmployeeService, LIMITS: Object.freeze(LIMITS), DATASET_NAMES };
