// Fabric Data → Inventory and Sales: one read-only explorer for every Fabric dataset, driven entirely by what the server reports
// (GET /api/v1/fabric/{dataset}/schema and /records). Columns, filters and sorts come from the schema, so a field the server
// leaves out (for example a sensitive one, for someone without that permission) never appears: no field name is hard-coded here.
//
// Browser storage holds one thing only: the names of the columns chosen per dataset ("jarc.fabric.columns.<dataset>"), never a
// value read from Fabric. Rows, records and the schema live in this object's memory and are dropped with FabricDataPanel.forget().
// Every value is shown through AppView.escape()/attr(); path segments go through encodeURIComponent.
class FabricExplorer {
  static DATASETS = { inventory: "Inventory", sales: "Sales" };
  static PAGE_SIZES = [50, 100, 200];
  static DEFAULT_LIMIT = 100;
  static RESERVED = new Set(["dateFrom", "dateTo", "q", "sort", "dir", "limit", "cursor", "fields"]);
  static NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
  static FIELD = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;
  static ID = /^[A-Fa-f0-9]{24}$/;
  static DAY = /^\d{4}-\d{2}-\d{2}$/;
  static STORAGE_PREFIX = "jarc.fabric.columns.";
  static NUMERIC = new Set(["int", "long", "double", "decimal", "number", "integer", "float"]);
  static MAX_FILTERS = 20;

  // ---- Pure helpers (also used by FabricDataPanel for the address bar, and by tests)
  static isDay(v) { if (typeof v !== "string" || !FabricExplorer.DAY.test(v)) return false; const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }
  static clean(v, max) { const t = typeof v === "string" ? v.trim() : ""; return t.length <= max && !/[\u0000-\u001f\u007f]/.test(t) ? t : ""; }
  static emptyQuery() { return { dateFrom: "", dateTo: "", q: "", sort: "", dir: "", limit: FabricExplorer.DEFAULT_LIMIT, filters: {} }; }
  // A query string → what the explorer asks for. Anything invalid is dropped (the address may have been typed or edited); filter
  // names are checked against the schema later, and the server checks everything again.
  static parseQuery(search) {
    const p = new URLSearchParams(search || ""), q = FabricExplorer.emptyQuery();
    const from = p.get("dateFrom"), to = p.get("dateTo");
    if (FabricExplorer.isDay(from) && FabricExplorer.isDay(to)) { q.dateFrom = from; q.dateTo = to; }
    q.q = FabricExplorer.clean(p.get("q"), 100);
    const sort = p.get("sort"); q.sort = typeof sort === "string" && FabricExplorer.NAME.test(sort) ? sort : "";
    q.dir = p.get("dir") === "asc" || p.get("dir") === "desc" ? p.get("dir") : "";
    const limit = Number(p.get("limit")); q.limit = FabricExplorer.PAGE_SIZES.includes(limit) ? limit : FabricExplorer.DEFAULT_LIMIT;
    for (const [k, v] of p) {
      if (FabricExplorer.RESERVED.has(k) || !FabricExplorer.NAME.test(k) || Object.hasOwn(q.filters, k) || Object.keys(q.filters).length >= FabricExplorer.MAX_FILTERS) continue;
      const t = FabricExplorer.clean(v, 100); if (t) q.filters[k] = t;
    }
    return q;
  }
  // The query string for a query: only what is set, filters in name order (one spelling per page).
  static formatQuery(q) {
    const p = new URLSearchParams();
    if (!q) return "";
    if (q.dateFrom && q.dateTo) { p.set("dateFrom", q.dateFrom); p.set("dateTo", q.dateTo); }
    if (q.q) p.set("q", q.q);
    for (const k of Object.keys(q.filters || {}).sort()) if (q.filters[k] !== "" && q.filters[k] !== null && q.filters[k] !== undefined) p.set(k, String(q.filters[k]));
    if (q.sort) p.set("sort", q.sort);
    if (q.dir) p.set("dir", q.dir);
    if (q.limit && q.limit !== FabricExplorer.DEFAULT_LIMIT) p.set("limit", String(q.limit));
    const s = p.toString();
    return s ? `?${s.replace(/%7E/g, "~")}` : ""; // "~" (no company) is a safe URL character: shown as typed
  }
  static recordPath(dataset, id) { return `/fabric/${encodeURIComponent(dataset)}/records/${encodeURIComponent(id)}`; }
  static keyNames(k) {
    if (Array.isArray(k)) return k.map((x) => (typeof x === "string" ? x : Array.isArray(x) ? x[0] : x?.field ?? x?.name)).filter((s) => typeof s === "string");
    if (k && typeof k === "object") return Object.keys(k);
    return [];
  }
  // The schema as the explorer uses it, whatever reasonable shape the server sends (arrays or name → definition objects).
  static normalize(schema) {
    const s = schema && typeof schema === "object" ? schema : {};
    const fields = (Array.isArray(s.fields) ? s.fields : []).filter((f) => f && typeof f.name === "string" && FabricExplorer.FIELD.test(f.name))
      .map((f) => ({ name: f.name, type: typeof f.type === "string" ? f.type.toLowerCase() : "", sensitive: f.sensitive === true, filterable: f.filterable === true, sortable: f.sortable === true, searchable: f.searchable === true }));
    const byName = new Map(fields.map((f) => [f.name, f]));
    const filters = [];
    const addFilter = (name, d) => {
      if (typeof name !== "string" || !FabricExplorer.NAME.test(name) || filters.some((f) => f.name === name)) return;
      const def = d && typeof d === "object" ? d : { field: typeof d === "string" ? d : name };
      const options = Array.isArray(def.options) ? def.options : Array.isArray(def.values) ? def.values : null;
      filters.push({ name, field: typeof def.field === "string" ? def.field : name, type: String(def.type || "string").toLowerCase(), label: typeof def.label === "string" ? def.label : "", options: options ? options.filter((o) => o === null || typeof o === "string" || typeof o === "number" || typeof o?.value === "string" || o?.value === null).slice(0, 500) : null });
    };
    if (Array.isArray(s.filters)) s.filters.forEach((d) => (typeof d === "string" ? addFilter(d, null) : addFilter(d?.name ?? d?.param ?? d?.key, d)));
    else if (s.filters && typeof s.filters === "object") Object.entries(s.filters).forEach(([k, d]) => addFilter(k, d));
    const sorts = [];
    const addSort = (name, d) => {
      if (typeof name !== "string" || !FabricExplorer.NAME.test(name) || sorts.some((x) => x.name === name)) return;
      const keys = FabricExplorer.keyNames(Array.isArray(d) || (d && typeof d === "object" && !d.fields && !d.keys) ? d : d?.fields ?? d?.keys);
      // requiresCompany: the server lists this sort one company at a time (company=… or ~); dateRange false: no dates with it.
      // lead: the column the sort is named after (schema sorts[].field), when the server says so.
      const lead = typeof d?.field === "string" && FabricExplorer.FIELD.test(d.field) ? d.field : typeof d?.lead === "string" && FabricExplorer.FIELD.test(d.lead) ? d.lead : "";
      sorts.push({ name, fields: keys, lead, label: typeof d?.label === "string" ? d.label : "", default: d?.default === true, requiresCompany: d?.requiresCompany === true, dateRange: d?.dateRange !== false });
    };
    if (Array.isArray(s.sorts)) s.sorts.forEach((d) => (typeof d === "string" ? addSort(d, []) : addSort(d?.name ?? d?.key, d)));
    else if (s.sorts && typeof s.sorts === "object") Object.entries(s.sorts).forEach(([k, d]) => addSort(k, d));
    // The server's default sort (schema sorts[].default) first: the explorer treats sorts[0] as the one used without ?sort=.
    const def = sorts.findIndex((x) => x.default);
    if (def > 0) sorts.unshift(...sorts.splice(def, 1));
    const defaults = (Array.isArray(s.defaultColumns) ? s.defaultColumns : []).filter((n) => byName.has(n));
    const recordKey = FabricExplorer.keyNames(s.recordKey).filter((n) => byName.has(n));
    return { label: typeof s.label === "string" ? s.label : "", fields, byName, filters, sorts, defaultColumns: [...new Set(defaults)], dateField: typeof s.dateField === "string" ? s.dateField : "", companyField: typeof s.companyField === "string" ? s.companyField : "", recordKey };
  }
  static humanize(name) { const t = String(name).replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim(); return t ? t[0].toUpperCase() + t.slice(1) : ""; }
  // Optional collaborators (FabricFieldMeta.js, FabricRecordView.js): used when loaded, never required.
  static global(name) {
    let g;
    try { g = name === "FabricFieldMeta" ? (typeof FabricFieldMeta !== "undefined" ? FabricFieldMeta : undefined) : name === "FabricRecordView" ? (typeof FabricRecordView !== "undefined" ? FabricRecordView : undefined) : undefined; } catch { g = undefined; }
    if (g === undefined && typeof window !== "undefined" && window) g = window[name];
    return g && (typeof g === "object" || typeof g === "function") ? g : null;
  }
  static NULL_MARK = `<span class="fx-null" title="No value"><span aria-hidden="true">—</span><span class="sr-only">No value</span></span>`;

  constructor(panel, dataset) { this.p = panel; this.ds = dataset; this.reset(); }
  reset() {
    clearTimeout(this.searchTimer); clearTimeout(this.columnTimer); this.columnTimer = null; this.columnsDirty = false;
    this.query = FabricExplorer.emptyQuery(); this.draft = null; this.page = { cursor: null, stack: [] };
    this.schema = FabricExplorer.slot(); this.records = FabricExplorer.slot(); this.record = FabricExplorer.slot();
    this.info = null; this.columns = null; this.recordId = ""; this.chooser = false; this.columnFilter = ""; this.fieldFilter = ""; this.hideEmpty = false; this.problem = ""; this.notice = "";
    // List view only (memory, never storage): filter bar open, object navigation open, the selected row, the company values
    // seen on pages already loaded (quick filters, no extra request) and the last page shown (kept on screen while the next loads).
    this.filtersOpen = false; this.navOpen = true; this.selectedId = ""; this.seenCompanies = []; this.shown = null;
  }
  // The rows of the page on screen (FabricRecordView reads these for prev/next; nothing is fetched for it).
  get items() { const d = this.records.data; return Array.isArray(d?.items) ? d.items : []; }
  static slot() { return { key: null, data: null, loading: false, error: null, seq: 0 }; }
  forget() { this.reset(); }
  get label() { return this.info?.label || FabricExplorer.DATASETS[this.ds] || this.ds; }
  esc(v) { return this.p.esc(v); }
  attr(v) { return this.p.attr(v); }
  get storageKey() { return `${FabricExplorer.STORAGE_PREFIX}${this.ds}`; }
  get statusInfo() {
    const d = this.p.status?.datasets?.[this.ds];
    if (d && typeof d === "object") return d;
    const s = typeof this.p.statusFor === "function" ? this.p.statusFor(this.ds) : null; // the panel's summary, when it offers one
    return s && typeof s === "object" ? s : null;
  }

  // ---- Route (FabricDataPanel.applyRoute / routeForUrl)
  state() { return `${FabricExplorer.formatQuery(this.query)}|${this.recordId}`; }
  applyQuery(q) {
    if (!q || FabricExplorer.formatQuery(q) === FabricExplorer.formatQuery(this.query)) return;
    this.query = { ...FabricExplorer.emptyQuery(), ...q, filters: { ...(q.filters || {}) } }; this.draft = null; this.page = { cursor: null, stack: [] }; this.problem = "";
  }
  openRecord(id) {
    const next = typeof id === "string" && FabricExplorer.ID.test(id) ? id : "";
    if (next !== this.recordId) { this.recordId = next; this.fieldFilter = ""; this.record = FabricExplorer.slot(); }
  }
  listHref() { return `/fabric/${this.ds}${FabricExplorer.formatQuery(this.query)}`; }
  recordHref(id) { return `/fabric/${this.ds}/records/${encodeURIComponent(id)}${FabricExplorer.formatQuery(this.query)}`; }

  // ---- Columns (names only in browser storage)
  savedColumns() {
    try { const raw = window.localStorage?.getItem(this.storageKey); const v = raw ? JSON.parse(raw) : null; return Array.isArray(v) ? v.filter((n) => typeof n === "string") : null; } catch { return null; }
  }
  saveColumns() {
    const names = (this.columns || []).filter((n) => this.info?.byName.has(n));
    try { window.localStorage?.setItem(this.storageKey, JSON.stringify(names)); } catch { /* a convenience: it simply isn't remembered */ }
  }
  defaultColumns() { const d = this.info?.defaultColumns || []; return d.length ? [...d] : (this.info?.fields || []).slice(0, 8).map((f) => f.name); }
  chooseColumns() {
    const saved = (this.savedColumns() || []).filter((n) => this.info.byName.has(n));
    this.columns = saved.length ? [...new Set(saved)] : this.defaultColumns();
  }
  toggleColumn(name, on) {
    if (!this.info?.byName.has(name) || !this.columns) return false;
    const has = this.columns.includes(name);
    if (on && !has) this.columns = [...this.columns, name];
    else if (!on && has) { if (this.columns.length === 1) { this.p.announce("Keep at least one column."); return false; } this.columns = this.columns.filter((n) => n !== name); }
    else return false;
    this.saveColumns(); return true;
  }
  // Ticking columns in the chooser changes the choice (and what is remembered) at once; the page is asked for once per batch:
  // COLUMN_DELAY after the last tick, or when the chooser closes (Done), whichever comes first.
  static COLUMN_DELAY = 300;
  queueColumns() {
    this.columnsDirty = true; clearTimeout(this.columnTimer);
    this.columnTimer = setTimeout(() => this.applyColumns(), FabricExplorer.COLUMN_DELAY);
    if (typeof document === "undefined") return;
    const ds = this.ds, count = document.querySelector(`#fabric-${ds}-col-count`), badge = document.querySelector(`#fabric-${ds}-head [data-focus-key="cols"] .fx-btn__count`);
    if (count) count.textContent = this.colCountText();
    if (badge) badge.textContent = `(${this.columns.length})`;
  }
  applyColumns() {
    clearTimeout(this.columnTimer); this.columnTimer = null;
    if (!this.columnsDirty) return false;
    this.columnsDirty = false; this.page = { cursor: null, stack: [] };
    const list = () => (typeof document !== "undefined" ? document.querySelector(`#fabric-${this.ds}-col-list`) : null), top = list()?.scrollTop || 0;
    this.redrawAfter();
    const after = list(); if (after && top) after.scrollTop = top;
    return true;
  }
  resetColumns() { clearTimeout(this.columnTimer); this.columnsDirty = false; try { window.localStorage?.removeItem(this.storageKey); } catch { /* storage blocked */ } this.columns = this.defaultColumns(); }

  // ---- Loading
  blocked() {
    const s = this.p.status;
    if (!s) return null;
    if (s.available === false) return FabricDataPanel.errorInfo({ cause: { serverCode: s.reason || "FABRIC_UNAVAILABLE" } });
    if (Array.isArray(s.access?.datasets) && !s.access.datasets.includes(this.ds)) return { kind: "forbidden", code: "FABRIC_DATASET_FORBIDDEN", message: `You don't have access to ${FabricExplorer.DATASETS[this.ds] || "this dataset"}.`, reference: "" };
    // The panel's summary (statusFor) is the one reading of /status; the raw dataset entry is the fallback without it.
    const st = typeof this.p.statusFor === "function" ? this.p.statusFor(this.ds) : null;
    const d = st && typeof st === "object" ? st : this.statusInfo;
    if (!d) return null;
    const mode = String(d.mode || "").toLowerCase().replace(/[-_]/g, "");
    if (d.available === false || mode === "indexrequired" || mode === "unavailable" || mode === "sourcemissing") return FabricDataPanel.errorInfo({ cause: { serverCode: typeof d.reason === "string" && d.reason ? d.reason : mode === "unavailable" ? "FABRIC_UNAVAILABLE" : mode === "sourcemissing" ? "FABRIC_SOURCE_MISSING" : "FABRIC_INDEX_REQUIRED" } });
    return null;
  }
  schemaPath() { return `/fabric/${encodeURIComponent(this.ds)}/schema`; }
  recordsPath() {
    const q = this.query, info = this.info, p = new URLSearchParams();
    if (q.dateFrom && q.dateTo && this.datesApply()) { p.set("dateFrom", q.dateFrom); p.set("dateTo", q.dateTo); }
    if (q.q) p.set("q", q.q);
    for (const f of info.filters) { const v = q.filters[f.name]; if (v !== undefined && v !== "") p.set(f.name, v); }
    if (q.sort && info.sorts.some((s) => s.name === q.sort)) p.set("sort", q.sort);
    if (q.dir) p.set("dir", q.dir);
    p.set("limit", String(q.limit));
    if (this.page.cursor) p.set("cursor", this.page.cursor);
    p.set("fields", this.columns.join(","));
    return `/fabric/${encodeURIComponent(this.ds)}/records?${p}`;
  }
  ensure() {
    if (this.blocked()) return;
    this.want(this.schema, this.schemaPath());
    if (!this.info) return;
    if (this.recordId) { this.want(this.record, FabricExplorer.recordPath(this.ds, this.recordId)); return; }
    const problem = this.rangeProblem() || this.sortProblem();
    if (problem !== this.problem) { this.problem = problem; this.p.redraw(); this.startMode = "full"; }
    if (!this.problem) this.want(this.records, this.recordsPath());
  }
  // The sort in use (the query's, or the server's default) and the company filter the schema offers.
  activeSort() { const sorts = this.info?.sorts || []; return sorts.find((s) => s.name === this.query.sort) || sorts[0] || null; }
  companyFilter() { const info = this.info; return info?.filters.find((f) => f.name === "company" || (info.companyField && f.field === info.companyField)) || null; }
  // A sort the server lists one company at a time (schema sorts[].requiresCompany) is sent only with a company chosen.
  sortProblem() {
    const s = this.activeSort();
    if (!s?.requiresCompany) return "";
    const c = this.companyFilter();
    if (c && this.query.filters[c.name]) return "";
    return `Sorting by ${s.label || FabricExplorer.humanize(s.name).toLowerCase()} lists one company at a time. Choose a company${c ? " (~ for rows without one)" : ""}, or sort by another column.`;
  }
  datesApply() { return this.activeSort()?.dateRange !== false; }
  want(slot, path) { if (slot.key !== path) this.load(slot, path); }
  async load(slot, path, { keep = false } = {}) {
    const seq = ++slot.seq;
    if (!keep) slot.data = null;
    slot.key = path; slot.loading = true; slot.error = null;
    // The start of a page load: when the page on screen stays (same columns), it is only marked busy in place; the one full
    // redraw comes with the answer. startMode tells redrawAfter() what was drawn.
    if (slot === this.records && this.markBusy()) this.startMode = "inplace";
    else { this.p.redraw(); this.startMode = "full"; }
    try {
      const data = await this.p.adapter.request("GET", path);
      if (slot.seq !== seq) return;
      slot.data = data;
      if (slot === this.schema) { this.info = FabricExplorer.normalize(data); this.chooseColumns(); }
      if (slot === this.records && data && Array.isArray(data.items)) { this.shown = { data, cols: (this.columns || []).join(",") }; this.noteCompanies(data.items); }
    } catch (error) {
      if (slot.seq !== seq) return;
      slot.error = FabricDataPanel.errorInfo(error);
      if (slot.error.kind === "denied") { slot.loading = false; this.p.deny(); return; }
      // A page cursor the server no longer accepts (cursors are signed per server process, so a restart or a deploy ends them):
      // back to the first page with a short note, instead of an error. Only for a request that carried a cursor, so it can't loop.
      if (slot === this.records && slot.error.code === "VALIDATION_ERROR" && this.page.cursor && path.includes("cursor=")) {
        slot.loading = false; slot.error = null; slot.key = null;
        this.page = { cursor: null, stack: [] }; this.notice = "That page is no longer available, so the list starts again from the first page.";
        this.p.announce(this.notice); this.ensure(); return;
      }
    } finally { if (slot.seq === seq) slot.loading = false; }
    if (this.p.denied) return;
    this.p.redraw(); this.announce(slot);
    if (slot === this.schema && this.info) this.ensure();
  }
  announce(slot) {
    if (slot.error) { this.p.announce(slot.error.message); return; }
    if (slot === this.records && slot.data) { const n = Array.isArray(slot.data.items) ? slot.data.items.length : 0; this.p.announce(n ? `${n} ${this.label} rows shown${slot.data.pagination?.hasMore ? ", more available" : ""}` : `No ${this.label} rows match`); }
  }
  refresh() {
    const again = (slot) => { if (slot.key) this.load(slot, slot.key, { keep: true }); };
    again(this.schema);
    if (this.recordId) again(this.record); else again(this.records);
  }
  retry() { for (const slot of [this.schema, this.records, this.record]) if (slot.error) slot.key = null; this.ensure(); }

  // ---- Filters
  // The dates as shown: the ones chosen, or else the window the server used (it is authoritative).
  shownWindow() {
    if (!this.datesApply()) return { dateFrom: "", dateTo: "" };
    if (this.query.dateFrom && this.query.dateTo) return { dateFrom: this.query.dateFrom, dateTo: this.query.dateTo };
    const w = this.records.data?.window, day = (v) => (typeof v === "string" && FabricExplorer.isDay(v.slice(0, 10)) ? v.slice(0, 10) : "");
    return { dateFrom: day(w?.dateFrom), dateTo: day(w?.dateTo) };
  }
  rangeProblem() {
    const { dateFrom: from, dateTo: to } = this.query;
    if ((!from && !to) || !this.datesApply()) return "";
    if (!FabricExplorer.isDay(from) || !FabricExplorer.isDay(to)) return "Enter both dates as real days.";
    if (from > to) return "The start date must be on or before the end date.";
    return "";
  }
  get maxDays() {
    // /status datasets.{ds}.window.maxDays is this dataset's own limit; null there means none (small-mode inventory).
    const w = this.statusInfo?.window;
    if (w && typeof w === "object" && Object.hasOwn(w, "maxDays") && w.maxDays === null) return null;
    const d = Number((w && typeof w === "object" ? w.maxDays : undefined) ?? this.statusInfo?.maxDays ?? this.statusInfo?.limits?.maxDays ?? this.p.status?.limits?.maxDays);
    return Number.isInteger(d) && d > 0 && d <= 3660 ? d : null;
  }
  setQuery(changes) {
    const next = { ...this.query, ...changes, filters: { ...this.query.filters, ...(changes.filters || {}) } };
    for (const [k, v] of Object.entries(next.filters)) if (v === "" || v === null || v === undefined) delete next.filters[k];
    if (FabricExplorer.formatQuery(next) === FabricExplorer.formatQuery(this.query)) return;
    this.query = next; this.page = { cursor: null, stack: [] }; this.notice = "";
    this.after();
  }
  after() { this.redrawAfter(); this.p.syncUrl(); }
  // After a change that may start a request: one full redraw at most before the answer. A load drawn in full already shows
  // the new state; one marked busy in place needs only the toolbar, filter bar and navigation brought up to date.
  redrawAfter() {
    this.startMode = "";
    this.ensure();
    if (this.startMode === "full") return;
    if (this.startMode !== "inplace" || !this.redrawChrome()) this.p.redraw();
  }
  setDate(edge, value) {
    const shown = this.shownWindow(), v = String(value || "");
    let from = edge === "from" ? v : this.query.dateFrom || shown.dateFrom, to = edge === "to" ? v : this.query.dateTo || shown.dateTo;
    if (!v) { from = ""; to = ""; } // a cleared date: back to the server's window
    this.setQuery({ dateFrom: from, dateTo: to });
  }
  clearFilters() { clearTimeout(this.searchTimer); this.draft = null; const limit = this.query.limit; this.query = { ...FabricExplorer.emptyQuery(), limit }; this.page = { cursor: null, stack: [] }; this.after(); }
  commitSearch() {
    clearTimeout(this.searchTimer);
    if (this.draft === null || this.draft === undefined) return;
    const q = FabricExplorer.clean(this.draft, 100); this.draft = null;
    this.setQuery({ q });
  }
  // The column a sort is led by: the schema's field, else its first key that isn't the company or _id.
  leadOf(s) { if (!s) return ""; if (s.lead) return s.lead; const skip = new Set([this.info?.companyField, "_id"]); return s.fields.filter((k) => !skip.has(k))[0] || s.fields[0] || ""; }
  sortFor(column) { return (this.info?.sorts || []).find((s) => this.leadOf(s) === column) || null; }
  // How a column takes part in the sort in use: primary (its arrow, aria-sort) or a later key of a compound sort ("then" n).
  sortRole(column) {
    const s = this.activeSort(), lead = this.leadOf(s);
    if (!s) return { primary: false, then: 0 };
    if (lead === column) return { primary: true, then: 0 };
    const later = s.fields.filter((k) => k !== lead && k !== "_id"), i = later.indexOf(column);
    return { primary: false, then: i >= 0 ? i + 2 : 0 };
  }
  // The order in words: "2nd", "3rd"… (header badges) and "second", "third"… (screen readers and tooltips).
  static ordinal(n) { return n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`; }
  static ordinalWord(n) { return ["", "first", "second", "third", "fourth", "fifth", "sixth"][n] || `key ${n}`; }
  // The Sort control's tooltip: the whole order of the sort in use, and what the header marks mean.
  sortLegend() {
    const s = this.activeSort(), lead = this.leadOf(s);
    if (!s) return "";
    const dir = this.query.dir === "asc" ? "ascending" : "descending";
    const later = s.fields.filter((k) => k !== lead && k !== "_id");
    const parts = [`${lead ? this.fieldLabel(lead) : this.sortLabel(s)} (${dir}, ▲/▼ in its header)`, ...later.map((k, i) => `then ${this.fieldLabel(k)} (${FabricExplorer.ordinal(i + 2)})`)];
    return `Sorted by ${parts.join(", ")}. A "2nd"/"3rd" badge in a column header marks a later sort key. Click a column header to sort by it.`;
  }
  sortBy(name) {
    const sorts = this.info?.sorts || [];
    if (!sorts.some((s) => s.name === name)) return;
    const current = this.query.sort || sorts[0]?.name, dir = this.query.dir || "desc";
    this.setQuery({ sort: name, dir: current === name ? (dir === "asc" ? "desc" : "asc") : "desc" });
  }
  movePage(dir) {
    this.notice = "";
    const d = this.records.data;
    if (dir === "next") { const next = d?.pagination?.nextCursor; if (!d?.pagination?.hasMore || typeof next !== "string" || !next) return; this.page.stack.push(this.page.cursor); this.page.cursor = next; }
    else { if (!this.page.stack.length) return; this.page.cursor = this.page.stack.pop(); }
    this.ensure();
    if (typeof document !== "undefined") document.querySelector("#fabric-root [data-focus-key='results']")?.scrollIntoView?.({ block: "nearest" });
  }

  // ---- Formatting
  isNumeric(type) { return FabricExplorer.NUMERIC.has(String(type || "").toLowerCase()); }
  cell(value, type) {
    if (value === null || value === undefined || value === "") return `<span class="muted">—</span>`;
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (String(type).toLowerCase() === "date" && typeof value === "string") {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return this.esc(value);
      const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
      let text;
      try { text = new Intl.DateTimeFormat(undefined, midnight ? { dateStyle: "medium", timeZone: "UTC" } : { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(d); } catch { text = d.toISOString(); }
      return `<time datetime="${this.attr(value)}" title="${this.attr(value)}">${this.esc(text)}</time>`;
    }
    if (typeof value === "number") return this.esc(value.toLocaleString(undefined, { maximumFractionDigits: 6 }));
    if (typeof value === "object") { let t = ""; try { t = JSON.stringify(value); } catch { t = ""; } return this.esc(t); }
    return this.esc(String(value));
  }
  plain(value) { if (value === null || value === undefined) return ""; if (typeof value === "boolean") return value ? "Yes" : "No"; if (typeof value === "object") { try { return JSON.stringify(value); } catch { return ""; } } return String(value); }

  // Friendly labels and formatting come from FabricFieldMeta when it is loaded; without it, the field name and cell() as before.
  // Requests always use the original field names.
  fieldLabel(name) {
    const m = FabricExplorer.global("FabricFieldMeta");
    if (m && typeof m.label === "function") { try { const t = m.label(this.ds, name); if (typeof t === "string" && t.trim()) return t.trim(); } catch { /* fall back */ } }
    return String(name);
  }
  filterLabel(f) {
    if (f.label) return f.label;
    const m = FabricExplorer.global("FabricFieldMeta");
    if (m && typeof m.label === "function") { try { const t = m.label(this.ds, f.field); if (typeof t === "string" && t.trim()) return t.trim(); } catch { /* fall back */ } }
    return FabricExplorer.humanize(f.name);
  }
  sortLabel(s) { return s.label || (this.leadOf(s) ? this.fieldLabel(this.leadOf(s)) : "") || FabricExplorer.humanize(s.name); }
  // One grid cell: its inner HTML, a class for the cell itself (no wrapper element) and a tooltip only for a value long enough
  // to be cut off (cells are one line, at most 360px wide): 200 rows × 85 columns stay a light page.
  static TITLE_MIN = 40;
  gridCell(value, type, name) {
    if (value === null || value === undefined || value === "") return { html: FabricExplorer.NULL_MARK, cls: "", title: "" };
    const long = (t) => (typeof t === "string" && t.length > FabricExplorer.TITLE_MIN ? t : "");
    const m = FabricExplorer.global("FabricFieldMeta");
    if (m && typeof m.format === "function") {
      try {
        const r = m.format(value, type, name);
        if (r && typeof r.text === "string") return { html: this.esc(r.text), cls: typeof r.cls === "string" ? r.cls : "", title: long(r.text) ? (typeof r.title === "string" && r.title ? r.title : r.text) : "" };
      } catch { /* fall back */ }
    }
    return { html: this.cell(value, type), cls: "", title: typeof value === "string" && String(type).toLowerCase() !== "date" ? long(value) : "" };
  }

  // ---- The page
  html() {
    const blocked = this.blocked();
    if (blocked) return this.bannersHtml() + this.p.errorHtml(blocked, "fabric-refresh");
    if (this.schema.error) return this.p.errorHtml(this.schema.error, "fabric-x-retry", "", `data-ds="${this.ds}"`);
    if (!this.info) return `<div class="fabric-explorer fx-explorer">${this.p.skeleton(6, 6)}</div>`;
    if (this.recordId) {
      // The record page is FabricRecordView's (it reads this.record, this.info, this.items…); the old detail is the fallback.
      const view = FabricExplorer.global("FabricRecordView");
      let inner = "";
      if (view && typeof view.html === "function") { try { inner = view.html(this); } catch { inner = ""; } }
      return `<div class="fabric-explorer fx-explorer fx-explorer--record" data-ds="${this.ds}">${this.bannersHtml()}${typeof inner === "string" && inner ? inner : this.recordHtml()}</div>`;
    }
    return `<div class="fabric-explorer fx-explorer" data-ds="${this.ds}">${this.bannersHtml()}${this.listHtml()}</div>`;
  }
  bannersHtml() {
    // The panel's app bar already shows the index advice once (FabricDataPanel.statusHtml): no second banner here.
    if (typeof this.p.statusHtml === "function") return "";
    const d = this.statusInfo;
    if (!d) return "";
    const missing = Array.isArray(d.missingIndexes) ? d.missingIndexes : [];
    const mode = String(d.mode || "").toLowerCase();
    if (!missing.length) return "";
    const list = `<details class="fx-status__more"><summary class="fx-status__toggle">Indexes recommended</summary><ul class="fx-status__details">${missing.map((m) => `<li><code>${this.esc(typeof m === "string" ? m : m?.name || "")}</code></li>`).join("")}</ul></details>`;
    const text = mode.startsWith("small") ? "This dataset is small enough to browse without indexes. Searches and sorting may be slower until the data team adds them." : "Some searches or sorts are waiting for the data team to add indexes.";
    return `<div class="fx-status fx-status--info fabric-banner is-index" role="status"><span class="fx-status__msg">${text}</span>${list}</div>`;
  }
  isCompany(f) { return f.name === "company" || Boolean(this.info?.companyField && f.field === this.info.companyField); }
  filterControl(f) {
    const id = `fabric-${this.ds}-f-${f.name}`, value = this.query.filters[f.name] ?? "", label = this.esc(this.filterLabel(f));
    const common = `id="${this.attr(id)}" data-action="fabric-x-filter" data-ds="${this.ds}" data-filter="${this.attr(f.name)}" title="${this.attr(f.field)}"`;
    if (f.type === "bool" || f.type === "boolean") return `<label class="fx-filterbar__item">${label}<select ${common}><option value="">Any</option><option value="true" ${value === "true" ? "selected" : ""}>Yes</option><option value="false" ${value === "false" ? "selected" : ""}>No</option></select></label>`;
    const company = f.name === "company" || (this.info.companyField && f.field === this.info.companyField);
    let options = f.options;
    if (!options && company && Array.isArray(this.statusInfo?.companies)) options = this.statusInfo.companies;
    if (options && options.length) {
      const opts = options.map((o) => { const raw = o !== null && typeof o === "object" ? o.value : o, v = raw === null ? "~" : String(raw), text = o !== null && typeof o === "object" && typeof o.label === "string" ? o.label : raw === null ? "No company" : String(raw); return `<option value="${this.attr(v)}" ${v === value ? "selected" : ""}>${this.esc(text)}</option>`; });
      if (value && !options.some((o) => { const raw = o !== null && typeof o === "object" ? o.value : o; return (raw === null ? "~" : String(raw)) === value; })) opts.push(`<option value="${this.attr(value)}" selected>${this.esc(value === "~" ? "No company" : value)}</option>`);
      return `<label class="fx-filterbar__item">${label}<select ${common}><option value="">${company ? "All companies" : "Any"}</option>${opts.join("")}</select></label>`;
    }
    return `<label class="fx-filterbar__item">${label}<input ${common} type="search" value="${this.attr(value)}" maxlength="100" autocomplete="off" placeholder="${company ? "Exact name; ~ = no company" : "Exact value"}"></label>`;
  }
  filtersHtml() {
    const info = this.info, w = this.shownWindow(), max = this.maxDays, ds = this.ds;
    const dates = this.datesApply(), off = dates ? "" : "disabled";
    const help = this.problem ? `<p id="fabric-${ds}-range-help" class="fabric-help is-error" role="alert">${this.esc(this.problem)}</p>` : !dates ? `<p id="fabric-${ds}-range-help" class="fabric-help">This order lists one company's rows by entry number; dates don't apply to it.</p>` : `<p id="fabric-${ds}-range-help" class="fabric-help">${info.dateField ? `Dates filter <code>${this.esc(info.dateField)}</code> (UTC days). ` : ""}${max ? `Up to ${max} days. ` : ""}Leave them empty for the server's default window.</p>`;
    return `<form class="fx-filterbar__form fabric-filters" aria-label="Filter ${this.attr(this.label)}" data-action="fabric-x-form" data-ds="${ds}"><div class="fx-filterbar__grid">
      <label class="fx-filterbar__item">From (UTC)<input id="fabric-${ds}-from" type="date" data-action="fabric-x-date" data-ds="${ds}" data-edge="from" value="${this.attr(w.dateFrom)}" aria-describedby="fabric-${ds}-range-help" ${off}></label>
      <label class="fx-filterbar__item">To (UTC)<input id="fabric-${ds}-to" type="date" data-action="fabric-x-date" data-ds="${ds}" data-edge="to" value="${this.attr(w.dateTo)}" aria-describedby="fabric-${ds}-range-help" ${off}></label>
      ${info.filters.map((f) => this.filterControl(f)).join("")}</div>
      <div class="fx-filterbar__foot">${help}<button type="button" class="fx-btn" data-action="fabric-x-clear" data-ds="${ds}" data-focus-key="clear-panel">Reset</button></div></form>`;
  }
  // ---- Toolbar, filter bar (collapsed by default, chips for what is active) and object navigation: nothing here fetches.
  activeFilters() {
    const q = this.query, info = this.info, out = [];
    if (!info) return out;
    if (q.q) out.push({ key: "q", label: "Search", text: q.q });
    if (q.dateFrom && q.dateTo && this.datesApply()) out.push({ key: "dates", label: "Dates", text: `${q.dateFrom} – ${q.dateTo}` });
    for (const f of info.filters) { const v = q.filters[f.name]; if (v !== undefined && v !== null && v !== "") out.push({ key: `f:${f.name}`, label: this.filterLabel(f), text: this.optionText(f, String(v)) }); }
    return out;
  }
  optionText(f, v) {
    if (f.type === "bool" || f.type === "boolean") return v === "true" ? "Yes" : v === "false" ? "No" : v;
    const company = this.isCompany(f), options = f.options || (company && Array.isArray(this.statusInfo?.companies) ? this.statusInfo.companies : []);
    const hit = options.find((o) => o !== null && typeof o === "object" && typeof o.label === "string" && (o.value === null ? "~" : String(o.value)) === v);
    if (hit) return hit.label;
    return company && v === "~" ? "No company" : v;
  }
  removeFilter(key) {
    if (key === "q") { clearTimeout(this.searchTimer); this.draft = null; this.setQuery({ q: "" }); return true; }
    if (key === "dates") { this.setQuery({ dateFrom: "", dateTo: "" }); return true; }
    const name = typeof key === "string" && key.startsWith("f:") ? key.slice(2) : "";
    if (!this.info?.filters.some((f) => f.name === name)) return false;
    this.setQuery({ filters: { [name]: "" } }); return true;
  }
  hasQuery() { return FabricExplorer.formatQuery({ ...this.query, limit: FabricExplorer.DEFAULT_LIMIT }) !== ""; }
  toolbarHtml() {
    const ds = this.ds, q = this.query, info = this.info, n = this.activeFilters().length, open = this.filtersOpen || Boolean(this.problem);
    // A short placeholder (never cut off); the searchable fields are in the tooltip and the input's description.
    const searchable = info.fields.filter((f) => f.searchable).map((f) => this.fieldLabel(f.name));
    const searchHelp = searchable.length ? `Searches ${searchable.join(", ")}` : "";
    const value = this.draft ?? q.q;
    const search = `<form class="fx-search" role="search" aria-label="Search ${this.attr(this.label)}" data-action="fabric-x-form" data-ds="${ds}"><span class="fx-search__icon" aria-hidden="true">${icon("search")}</span><input id="fabric-${ds}-q" class="fx-search__input" type="search" data-action="fabric-x-search" data-ds="${ds}" value="${this.attr(value)}" maxlength="100" placeholder="Search…" aria-label="Search"${searchHelp ? ` title="${this.attr(searchHelp)}" aria-describedby="fabric-${ds}-q-help"` : ""} autocomplete="off">${searchHelp ? `<span class="sr-only" id="fabric-${ds}-q-help">${this.esc(searchHelp)}</span>` : ""}${value ? `<button type="button" class="fx-btn fx-btn--icon fx-search__clear" data-action="fabric-x-search-clear" data-ds="${ds}" data-focus-key="search-clear" aria-label="Clear search">${icon("close")}</button>` : ""}</form>`;
    const badge = n ? `<span class="fx-badge"><span class="sr-only">, </span>${n}<span class="sr-only"> active</span></span>` : "";
    const active = this.activeSort(), dir = q.dir === "asc" ? "asc" : "desc", legend = this.attr(this.sortLegend());
    const sort = info.sorts.length > 1 ? `<label class="fx-toolbar__field" title="${legend}">Sort<select id="fabric-${ds}-sort" data-action="fabric-x-sort-select" data-ds="${ds}">${info.sorts.map((s) => `<option value="${this.attr(s.name)}" ${active?.name === s.name ? "selected" : ""}>${this.esc(this.sortLabel(s))}</option>`).join("")}</select></label>` : active ? `<span class="fx-toolbar__text" title="${legend}">Sort <strong>${this.esc(this.sortLabel(active))}</strong></span>` : "";
    const order = info.sorts.length ? `<button type="button" class="fx-btn fx-btn--icon fx-explorer__dir" data-action="fabric-x-dir-toggle" data-ds="${ds}" data-focus-key="dir" aria-label="${dir === "asc" ? "Ascending. Switch to descending" : "Descending. Switch to ascending"}" title="${dir === "asc" ? "Ascending" : "Descending"}"><span aria-hidden="true">${dir === "asc" ? "▲" : "▼"}</span></button>` : "";
    return `<div class="fx-toolbar fx-explorer__toolbar" role="group" aria-label="${this.attr(this.label)} list tools">
      <button type="button" class="fx-btn" data-action="fabric-refresh" data-focus-key="x-refresh" title="Load this page again">${icon("refresh")}<span>Refresh</span></button><span class="fx-sep" aria-hidden="true"></span>
      ${search}
      <button type="button" class="fx-btn" data-action="fabric-x-filters" data-ds="${ds}" data-focus-key="filters" aria-expanded="${open}" aria-controls="fabric-${ds}-filters">${icon("filter")}<span>Filters</span>${badge}</button>
      <span class="fx-colpop"><button type="button" class="fx-btn" data-action="fabric-x-columns" data-ds="${ds}" data-focus-key="cols" aria-expanded="${this.chooser}" aria-controls="fabric-${ds}-chooser">${icon("columns")}<span>Columns</span> <small class="fx-btn__count">(${this.columns.length})</small></button>${this.chooser ? this.chooserHtml() : ""}</span>
      <span class="fx-sep" aria-hidden="true"></span><span class="fx-toolbar__sort">${sort}${order}</span>
      <button type="button" class="fx-btn fx-toolbar__secondary" data-action="fabric-x-clear" data-ds="${ds}" data-focus-key="clear-top" ${this.hasQuery() ? "" : "disabled"}>${icon("close")}<span>Clear filters</span></button>
      <span class="fx-toolbar__spacer"></span>
      <label class="fx-toolbar__field fx-toolbar__secondary">Rows per page<select id="fabric-${ds}-limit" data-action="fabric-x-limit" data-ds="${ds}">${FabricExplorer.PAGE_SIZES.map((v) => `<option value="${v}" ${q.limit === v ? "selected" : ""}>${v}</option>`).join("")}</select></label></div>`;
  }
  chipHtml(c) {
    return `<span class="fx-chip fx-chip--filter"><span class="fx-chip__text" title="${this.attr(`${c.label}: ${c.text}`)}"><span class="fx-chip__label">${this.esc(c.label)}:</span> ${this.esc(c.text)}</span><button type="button" class="fx-chip__remove" data-action="fabric-x-chip" data-ds="${this.ds}" data-key="${this.attr(c.key)}" aria-label="Remove filter ${this.attr(c.label)}"><span aria-hidden="true">×</span></button></span>`;
  }
  filterbarHtml() {
    const chips = this.activeFilters(), open = this.filtersOpen || Boolean(this.problem), ds = this.ds;
    const info = chips.length ? `<div class="fx-filterbar__info" role="group" aria-label="Active filters">${chips.map((c) => this.chipHtml(c)).join("")}</div>` : "";
    return `<div class="fx-filterbar${open ? " is-open" : " is-collapsed"}${!open && !chips.length ? " is-empty" : ""}"><div class="fx-filterbar__panel" id="fabric-${ds}-filters" ${open ? "" : "hidden"}>${this.filtersHtml()}</div>${info}</div>`;
  }
  // Company quick filters: only values already known (schema or status options, rows on pages already loaded, the current filter).
  noteCompanies(items) {
    const cf = this.info?.companyField;
    if (!cf || !this.companyFilter()) return;
    for (const item of items) {
      const values = item && typeof item.values === "object" && item.values ? item.values : null;
      if (!values || !Object.hasOwn(values, cf) || this.seenCompanies.length >= 50) continue;
      const v = values[cf], n = v === null ? "~" : FabricExplorer.clean(typeof v === "string" ? v : "", 100);
      if (n && !this.seenCompanies.includes(n)) this.seenCompanies.push(n);
    }
  }
  navCompanies() {
    const c = this.companyFilter();
    if (!c) return [];
    const out = [], seen = new Set();
    const add = (v, text) => { if (typeof v !== "string" || !v || v.length > 100 || seen.has(v) || out.length >= 60) return; seen.add(v); out.push({ value: v, text: typeof text === "string" && text ? text : v === "~" ? "No company" : v }); };
    const fromOption = (o) => { const raw = o !== null && typeof o === "object" ? o.value : o; if (raw !== null && typeof raw !== "string" && typeof raw !== "number") return; add(raw === null ? "~" : String(raw), o !== null && typeof o === "object" ? o.label : ""); };
    (c.options || []).forEach(fromOption);
    if (Array.isArray(this.statusInfo?.companies)) this.statusInfo.companies.forEach(fromOption);
    this.seenCompanies.forEach((v) => add(v));
    const current = this.query.filters[c.name];
    if (current) add(current);
    return out;
  }
  navHtml() {
    const ds = this.ds, c = this.companyFilter(), current = c ? this.query.filters[c.name] || "" : "";
    const toggle = `<button type="button" class="fx-btn fx-btn--icon fx-nav__collapse" data-action="fabric-x-nav" data-ds="${ds}" data-focus-key="nav-toggle" aria-expanded="${this.navOpen}" aria-controls="fabric-${ds}-nav" aria-label="${this.navOpen ? "Hide" : "Show"} object navigation">${icon(this.navOpen ? "left" : "right")}</button>`;
    if (!this.navOpen) return `<aside class="fx-nav fx-explorer__nav is-collapsed" id="fabric-${ds}-nav" aria-label="Objects"><div class="fx-nav__caption">${toggle}</div></aside>`;
    const row = (value, text, i) => `<li class="fx-nav__node"><button type="button" class="fx-nav__row${value === current ? " is-current" : ""}" data-action="fabric-x-nav-company" data-ds="${ds}" data-company="${this.attr(value)}" data-focus-key="nav-${i}"${value === current ? ' aria-current="true"' : ""}>${this.esc(text)}</button></li>`;
    const companies = this.navCompanies();
    // The company shortcuts are only the values already known (filter options, rows on pages loaded so far): labelled as such so
    // they never read as the complete list of companies in the data.
    const seen = companies.length ? `<li class="fx-nav__subhead" role="presentation">Seen on loaded pages <span class="fx-nav__hint">(not a complete list)</span></li>${companies.map((x, i) => row(x.value, x.text, i)).join("")}` : "";
    const list = c ? `<ul class="fx-nav__group">${row("", "All records", "all")}${seen}</ul>` : `<ul class="fx-nav__group">${row("", "All records", "all")}</ul>`;
    const foot = c ? "These shortcuts show only companies seen on the pages loaded so far. To choose any company, use Filters → Company." : "Use Filters to narrow the list.";
    return `<aside class="fx-nav fx-explorer__nav" id="fabric-${ds}-nav" aria-label="Objects"><div class="fx-nav__caption"><span>Objects</span>${toggle}</div><ul class="fx-nav__tree"><li class="fx-nav__node is-root"><span class="fx-nav__rowtitle">${icon("list")}<span>${this.esc(this.label)}</span></span>${list}</li></ul><footer class="fx-nav__foot">${foot}</footer></aside>`;
  }
  windowText() {
    const w = this.records.data?.window;
    if (!this.records.data) return "";
    const day = (v) => { const d = typeof v === "string" ? new Date(`${v.slice(0, 10)}T00:00:00Z`) : null; if (!d || Number.isNaN(d.getTime())) return ""; try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(d); } catch { return v.slice(0, 10); } };
    const from = day(w?.dateFrom), to = day(w?.dateTo);
    if (from && to) return `Showing ${this.esc(from)} – ${this.esc(to)} (UTC)`;
    return "Showing all dates";
  }
  colCountText() { return `${this.columns.length} of ${this.info.fields.length} columns shown.`; }
  chooserHtml() {
    const ds = this.ds, term = this.columnFilter.trim().toLowerCase();
    const rows = this.info.fields.map((f) => {
      const on = this.columns.includes(f.name), label = this.fieldLabel(f.name), key = (label === f.name ? f.name : `${f.name} ${label}`).toLowerCase(), hide = term && !key.includes(term);
      return `<label class="fabric-check" data-col="${this.attr(key)}" ${hide ? "hidden" : ""}><input type="checkbox" data-action="fabric-x-col" data-ds="${ds}" data-name="${this.attr(f.name)}" data-focus-key="col-${this.attr(f.name)}" ${on ? "checked" : ""}> ${label === f.name ? "" : `<span>${this.esc(label)}</span> `}<code>${this.esc(f.name)}</code> <small class="muted">${this.esc(f.type)}</small></label>`;
    }).join("");
    return `<div class="fx-explorer__chooser fabric-chooser" id="fabric-${ds}-chooser" role="group" aria-label="Columns"><div class="fabric-chooser-head fx-chooser__head"><span class="fx-search fx-chooser__search"><span class="fx-search__icon" aria-hidden="true">${icon("search")}</span><input id="fabric-${ds}-col-filter" class="fx-search__input" type="search" data-action="fabric-x-col-filter" data-ds="${ds}" value="${this.attr(this.columnFilter)}" maxlength="64" autocomplete="off" placeholder="Find a column" aria-label="Find a column"></span><button type="button" class="fx-btn" data-action="fabric-x-columns-reset" data-ds="${ds}" data-focus-key="cols-reset">Default columns</button><button type="button" class="fx-btn" data-action="fabric-x-columns" data-ds="${ds}" data-focus-key="cols-done">Done</button></div><p class="fabric-help"><span id="fabric-${ds}-col-count">${this.colCountText()}</span> Your choice is remembered in this browser (column names only).</p><div class="fabric-chooser-list" id="fabric-${ds}-col-list">${rows}</div></div>`;
  }
  // While a new page loads, the last page stays on screen (dimmed, aria-busy, paging off) instead of a skeleton: no layout
  // jump. Only with the same columns; the very first load shows the skeleton.
  stalePage() { const s = this.records; return !s.data && s.loading && !s.error && !this.problem && this.shown && this.shown.cols === this.columns.join(",") ? this.shown.data : null; }
  // The toolbar, the filter bar and the column chooser: one region (#fabric-{ds}-head, display: contents) redrawn on its own.
  headHtml() { return `${this.toolbarHtml()}${this.filterbarHtml()}`; }
  listHtml() {
    const s = this.records, ds = this.ds;
    const stale = this.stalePage();
    let results;
    if (this.problem) results = `<p class="fx-status fx-status--warn fx-explorer__msg" role="status">${this.rangeProblem() ? "Fix the dates to see rows." : "Choose a company to see rows in this order."}</p>`;
    else if (s.error) results = this.p.errorHtml(s.error, "fabric-x-retry", "", `data-ds="${ds}"`);
    else if (s.data && Array.isArray(s.data.items) && s.data.items.length) results = this.tableHtml(s.data, s.loading) + this.pagerHtml(s.data, s.loading);
    else if (stale && stale.items.length) results = this.tableHtml(stale, true) + this.pagerHtml(stale, true);
    else if (!s.data) results = this.p.skeleton(Math.min(this.columns.length, 8));
    else results = `<div class="fx-grid__empty quiet-empty fabric-empty">${icon("search")}<span><strong>No rows match</strong><small>Try other dates, another filter or different search text.</small></span><button type="button" class="fx-btn" data-action="fabric-x-clear" data-ds="${ds}" data-focus-key="clear">Clear filters</button></div>`;
    const notice = this.notice ? `<p class="fx-status fx-status--info fabric-notice" role="status">${this.esc(this.notice)}</p>` : "";
    return `<div class="fx-explorer__head" id="fabric-${ds}-head">${this.headHtml()}</div>${notice}<div class="fx-explorer__split${this.navOpen ? "" : " is-nav-collapsed"}" id="fabric-${ds}-split">${this.navHtml()}<div class="fx-explorer__main fabric-results" ${s.loading ? 'aria-busy="true"' : ""}>${results}</div></div>`;
  }
  headerHtml(name, i = 1) {
    const f = this.info.byName.get(name), sort = this.sortFor(name), role = this.sortRole(name), dir = this.query.dir === "asc" ? "asc" : "desc";
    const cls = [i === 0 ? "fx-grid__frozen" : "", this.isNumeric(f?.type) ? "fx-grid__num fabric-num" : ""].filter(Boolean).join(" ");
    const label = `${this.esc(this.fieldLabel(name))}${f?.sensitive ? ` <span class="account-badge is-warn fabric-sensitive" title="Sensitive field">S</span>` : ""}`;
    const lead = role.then ? this.leadOf(this.activeSort()) : "";
    const title = `${name}${f?.type ? ` · ${f.type}` : ""}${role.then ? ` · sorted ${FabricExplorer.ordinalWord(role.then)}${lead ? `, after ${this.fieldLabel(lead)}` : ""}` : ""}`;
    // A later key of a compound sort: a small "2nd"/"3rd" badge attached to the label, and "sorted second" for screen readers.
    const then = role.then ? `<span class="fx-sort-then" aria-hidden="true">${FabricExplorer.ordinal(role.then)}</span><span class="sr-only">, sorted ${FabricExplorer.ordinalWord(role.then)}</span>` : "";
    if (!sort) return `<th scope="col" class="${cls}" title="${this.attr(title)}">${label}${then}</th>`;
    // aria-sort only on the primary key of the sort in use; the arrow is drawn only there.
    const aria = role.primary ? ` aria-sort="${dir === "asc" ? "ascending" : "descending"}"` : "";
    const mark = role.primary ? `<span class="fx-sort-mark fabric-sort-mark" aria-hidden="true">${dir === "asc" ? "▲" : "▼"}</span>` : "";
    return `<th scope="col" class="${cls}" title="${this.attr(title)}"${aria}><button type="button" class="fx-grid__sort fabric-sort" data-action="fabric-x-sort" data-ds="${this.ds}" data-sort="${this.attr(sort.name)}" data-focus-key="sort-${this.attr(name)}" title="Sort by ${this.attr(sort.fields.filter((k) => k !== "_id").join(", ") || sort.name)}">${label}${mark}${then}</button></th>`;
  }
  tableHtml(d, busy = false) {
    const cols = this.columns.filter((n) => this.info.byName.has(n)), ds = this.ds;
    // Per column, worked out once: the type, the numeric class and the friendly label (escaped). The label is the cell's one
    // data attribute: the phone card shows it (CSS ::before attr(data-label)); the header's title still names the field.
    const meta = cols.map((name) => { const f = this.info.byName.get(name); return { name, type: f?.type, num: this.isNumeric(f?.type) ? "fx-grid__num fabric-num" : "", label: this.attr(this.fieldLabel(name)) }; });
    const rows = d.items.map((item) => {
      const values = item && typeof item.values === "object" && item.values ? item.values : {}, id = typeof item?.id === "string" && FabricExplorer.ID.test(item.id) ? item.id : "";
      const on = Boolean(id) && id === this.selectedId;
      return `<tr${id ? ` data-action="fabric-x-select" data-ds="${ds}" data-id="${id}"` : ""}${on ? ' class="is-selected" aria-selected="true"' : ""}>${meta.map((c, i) => {
        const v = Object.hasOwn(values, c.name) ? values[c.name] : null, empty = v === null || v === undefined || v === "", shown = this.gridCell(v, c.type, c.name);
        const inner = i === 0 && id ? `<a class="fx-link fabric-link" href="${this.attr(this.recordHref(id))}" data-action="fabric-x-open" data-ds="${ds}" data-id="${id}" title="Open the record">${empty ? "Open" : shown.html}</a>` : shown.html;
        const cls = [i === 0 ? "fx-grid__frozen" : "", c.num, shown.cls].filter(Boolean).join(" "), title = shown.title ? ` title="${this.attr(shown.title)}"` : "";
        return i === 0 ? `<th scope="row" class="${this.attr(cls)}" data-label="${c.label}"${title}>${inner}</th>` : `<td data-label="${c.label}"${cls ? ` class="${this.attr(cls)}"` : ""}${title}>${inner}</td>`;
      }).join("")}</tr>`;
    }).join("");
    return `<div class="fx-grid fabric-explorer-scroll${busy ? " is-busy" : ""}" tabindex="0" data-focus-key="results" data-grid="${ds}" role="region" aria-label="${this.attr(this.label)} rows"${busy ? ' aria-busy="true"' : ""}><table class="fx-grid__table fabric-explorer-table"><thead><tr>${cols.map((n, i) => this.headerHtml(n, i)).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  // Footer: the page and its rows, the date window and a short filter summary. Never a total: the server doesn't count.
  pagerHtml(d, busy = false) {
    const items = d.items || [], n = this.page.stack.length + 1, start = this.page.stack.length * this.query.limit + 1, end = start + items.length - 1;
    const more = Boolean(d.pagination?.hasMore && d.pagination?.nextCursor);
    const chips = this.activeFilters(), summary = chips.length ? chips.slice(0, 2).map((c) => `${c.label}: ${c.text.length > 32 ? `${c.text.slice(0, 31)}…` : c.text}`).join(" · ") + (chips.length > 2 ? ` · +${chips.length - 2}` : "") : "No filters";
    const range = busy ? "Loading…" : `Page ${n.toLocaleString()} · Rows ${start.toLocaleString()}–${end.toLocaleString()}${more ? " · more available" : ""}`;
    return `<div class="fx-gridfoot fabric-pager"><span class="fx-gridfoot__range" role="status">${range}</span><span class="fx-gridfoot__ctx"><span class="fabric-window">${this.windowText()}</span><span class="fx-gridfoot__filters">${this.esc(summary)}</span></span><span class="fx-gridfoot__page fabric-pager-buttons"><button type="button" class="fx-btn" data-action="fabric-x-page" data-ds="${this.ds}" data-dir="prev" data-focus-key="prev" ${this.page.stack.length && !busy ? "" : "disabled"}>${icon("left")}<span>Previous</span></button><button type="button" class="fx-btn" data-action="fabric-x-page" data-ds="${this.ds}" data-dir="next" data-focus-key="next" ${more && !busy ? "" : "disabled"}><span>Next</span>${icon("right")}</button></span></div>`;
  }
  recordHtml() {
    const ds = this.ds, crumb = `<nav class="fabric-breadcrumb" aria-label="Breadcrumb"><a href="${this.attr(this.listHref())}" data-action="fabric-x-back" data-ds="${ds}">${icon("left")} ${this.esc(this.label)}</a><span aria-hidden="true">/</span><span aria-current="page">Record</span></nav>`;
    const s = this.record;
    if (s.error) return crumb + this.p.errorHtml(s.error, "fabric-x-retry", "", `data-ds="${ds}"`);
    const r = s.data?.record;
    if (!r) return crumb + this.p.skeleton(3, 8);
    const key = r.key && typeof r.key === "object" ? Object.entries(r.key) : [];
    const keyHtml = key.length ? `<dl class="fabric-record-key">${key.map(([k, v]) => `<div><dt><code>${this.esc(k)}</code></dt><dd>${this.cell(v, this.info.byName.get(k)?.type)}</dd></div>`).join("")}</dl>` : "";
    const fields = Array.isArray(r.fields) ? r.fields.filter((f) => f && typeof f.name === "string") : [];
    const term = this.fieldFilter.trim().toLowerCase();
    const rows = fields.map((f) => {
      const plain = this.plain(f.value), empty = f.value === null || f.value === undefined || f.value === "", hidden = (this.hideEmpty && empty) || (term && !`${f.name} ${plain}`.toLowerCase().includes(term));
      const sensitive = this.info.byName.get(f.name)?.sensitive ? ` <span class="account-badge is-warn fabric-sensitive">Sensitive</span>` : "";
      return `<tr data-field="${this.attr(`${f.name} ${plain}`.toLowerCase())}" data-empty="${empty}" ${hidden ? "hidden" : ""}><td data-label="Field"><code>${this.esc(f.name)}</code>${sensitive}</td><td data-label="Value">${this.cell(f.value, f.type)}</td><td data-label="Type"><small class="muted">${this.esc(f.type || "")}</small></td></tr>`;
    }).join("");
    const tools = `<div class="fabric-field-tools"><label class="fabric-search">Filter fields<input id="fabric-${ds}-field-filter" type="search" data-action="fabric-x-field-filter" data-ds="${ds}" value="${this.attr(this.fieldFilter)}" maxlength="100" placeholder="Field name or value" autocomplete="off"></label><label class="fabric-check"><input id="fabric-${ds}-hide-empty" type="checkbox" data-action="fabric-x-hide-empty" data-ds="${ds}" ${this.hideEmpty ? "checked" : ""}> Hide empty fields</label></div>`;
    return `${crumb}<div class="fabric-invoice-head"><h2>${this.esc(this.label)} record</h2></div>${keyHtml}${tools}<p class="fabric-help" id="fabric-${ds}-field-count">${fields.length} fields</p><div class="fabric-scroll" tabindex="0" role="region" aria-label="All fields"><table class="fabric-table fabric-fields"><thead><tr><th scope="col">Field</th><th scope="col">Value</th><th scope="col">Type</th></tr></thead><tbody id="fabric-${ds}-field-rows">${rows}</tbody></table></div><p class="integration-note">Record links aren't permanent: when the Fabric data is refreshed upstream, a saved link may no longer find its record.</p>`;
  }
  // Field and column filters work on what is drawn: typing never redraws the table or moves focus.
  filterRows() {
    if (typeof document === "undefined") return;
    const term = this.fieldFilter.trim().toLowerCase(); let shown = 0, all = 0;
    document.querySelectorAll(`#fabric-${this.ds}-field-rows tr`).forEach((tr) => { all += 1; const hide = (this.hideEmpty && tr.dataset.empty === "true") || (term && !tr.dataset.field.includes(term)); tr.hidden = Boolean(hide); if (!hide) shown += 1; });
    const count = document.querySelector(`#fabric-${this.ds}-field-count`); if (count) count.textContent = shown === all ? `${all} fields` : `${shown} of ${all} fields`;
  }
  filterColumns() {
    if (typeof document === "undefined") return;
    const term = this.columnFilter.trim().toLowerCase();
    document.querySelectorAll(`#fabric-${this.ds}-col-list [data-col]`).forEach((el) => { el.hidden = Boolean(term && !el.dataset.col.includes(term)); });
  }

  // ---- Events (FabricDataPanel passes every "fabric-x-…" event for this dataset here)
  // The selected row is marked in place (no redraw, so the grid keeps its scroll position); it is kept for the next render.
  selectRow(id) {
    if (!FabricExplorer.ID.test(id || "")) return;
    this.selectedId = id;
    if (typeof document === "undefined") return;
    document.querySelectorAll(`[data-grid="${this.ds}"] tbody tr`).forEach((tr) => { const on = tr.dataset?.id === id; tr.classList?.toggle("is-selected", on); if (on) tr.setAttribute?.("aria-selected", "true"); else tr.removeAttribute?.("aria-selected"); });
  }
  // The start of a load with the page kept on screen: dim it, aria-busy, "Loading…" and paging off, in place (no rebuild).
  markBusy() {
    if (typeof document === "undefined" || this.recordId || this.problem || this.records.error) return false;
    const s = this.records, d = s.data && Array.isArray(s.data.items) && s.data.items.length ? s.data : this.stalePage();
    if (!d || !Array.isArray(d.items) || !d.items.length) return false;
    const grid = document.querySelector(`#fabric-root [data-grid="${this.ds}"]`), main = grid?.closest?.(".fabric-results");
    if (!grid || !main) return false;
    grid.classList?.add("is-busy"); grid.setAttribute?.("aria-busy", "true"); main.setAttribute?.("aria-busy", "true");
    const range = main.querySelector(".fx-gridfoot__range"); if (range) range.textContent = "Loading…";
    const active = document.activeElement;
    main.querySelectorAll('[data-action="fabric-x-page"]').forEach((b) => { b.disabled = true; });
    if (active && active.disabled && main.contains(active)) grid.focus?.({ preventScroll: true }); // as a full redraw would
    return true;
  }
  // Replaces one region's HTML, keeping focus (by id, else data-focus-key, else the fallback) and the caret, as the panel does.
  swap(el, html, outer = false, fallback = "") {
    const active = document.activeElement, inside = Boolean(active && el.contains(active));
    const id = inside ? active.id : "", key = inside ? active.dataset?.focusKey : "", own = el.id;
    let sel = null; if (inside) { try { sel = [active.selectionStart, active.selectionEnd]; } catch { sel = null; } }
    if (outer) el.outerHTML = html; else el.innerHTML = html;
    if (!inside) return;
    const esc = (v) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v), scope = outer ? document.querySelector(`#${esc(own)}`) : el;
    const next = (id && document.querySelector(`#${esc(id)}`)) || (key && scope?.querySelector(`[data-focus-key="${esc(key)}"]`)) || (fallback && document.querySelector(`#fabric-root ${fallback}`)) || null;
    if (!next || next.disabled) return;
    next.focus?.({ preventScroll: true });
    if (sel && sel[0] !== null && sel[0] !== undefined && typeof next.setSelectionRange === "function") { try { next.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ } }
  }
  // The list's chrome without the grid: toolbar + filter bar + chooser (#fabric-{ds}-head), the navigation and its collapsed
  // state. False when the list isn't on screen as expected (or the notice line would change): the caller redraws in full.
  redrawChrome(fallback = "") {
    if (typeof document === "undefined" || this.recordId) return false;
    const ds = this.ds, head = document.querySelector(`#fabric-root #fabric-${ds}-head`), nav = document.querySelector(`#fabric-root #fabric-${ds}-nav`), split = document.querySelector(`#fabric-root #fabric-${ds}-split`);
    if (!head || !nav || !split) return false;
    const note = document.querySelector("#fabric-root .fabric-notice");
    if (Boolean(note) !== Boolean(this.notice)) return false;
    if (note && note.textContent !== this.notice) note.textContent = this.notice;
    this.swap(head, this.headHtml(), false, fallback);
    this.swap(nav, this.navHtml(), true);
    split.classList?.toggle("is-nav-collapsed", !this.navOpen);
    return true;
  }
  // A redraw for a view-only change (filter bar, navigation, chooser): no request and no grid rebuild; without the regions on
  // screen, a full redraw that keeps where the grid was scrolled to.
  redrawInPlace(fallback = "") {
    if (this.redrawChrome(fallback)) return;
    const find = () => (typeof document !== "undefined" ? document.querySelector(`[data-grid="${this.ds}"]`) : null);
    const before = find(), top = before?.scrollTop || 0, left = before?.scrollLeft || 0;
    this.p.redraw();
    const after = find(); if (after && before) { after.scrollTop = top; after.scrollLeft = left; }
  }
  focus(selector) { if (typeof document !== "undefined") document.querySelector(`#fabric-root ${selector}`)?.focus?.({ preventScroll: true }); }
  onAction(action, target, event) {
    if (action.startsWith("fabric-r-")) { const view = FabricExplorer.global("FabricRecordView"); if (view && typeof view.onAction === "function") view.onAction(this, action, target, event); return; }
    if (action === "fabric-x-open") { const id = target.dataset.id; if (FabricExplorer.ID.test(id || "")) { this.selectedId = id; this.openRecord(id); this.p.c.update(); if (typeof document !== "undefined") document.querySelector(".fabric-breadcrumb a")?.focus?.(); } return; }
    if (action === "fabric-x-select") { this.selectRow(target.dataset.id); return; }
    if (action === "fabric-x-filters") { this.filtersOpen = !(this.filtersOpen || Boolean(this.problem)); this.redrawInPlace(); return; }
    if (action === "fabric-x-nav") { this.navOpen = !this.navOpen; this.redrawInPlace(); return; }
    if (action === "fabric-x-nav-company") { const c = this.companyFilter(); if (c) this.setQuery({ filters: { [c.name]: FabricExplorer.clean(target.dataset.company || "", 100) } }); return; }
    if (action === "fabric-x-chip") { if (this.removeFilter(target.dataset.key)) this.focus(`[data-action="fabric-x-filters"][data-ds="${this.ds}"]`); return; }
    if (action === "fabric-x-search-clear") { clearTimeout(this.searchTimer); this.draft = null; this.setQuery({ q: "" }); this.focus(`#fabric-${this.ds}-q`); return; }
    if (action === "fabric-x-dir-toggle") { if (this.info?.sorts.length) this.setQuery({ dir: this.query.dir === "asc" ? "desc" : "asc" }); return; }
    if (action === "fabric-x-back") { this.openRecord(""); this.p.c.update(); return; }
    if (action === "fabric-x-sort") { this.sortBy(target.dataset.sort); return; }
    if (action === "fabric-x-page") { this.movePage(target.dataset.dir); return; }
    if (action === "fabric-x-columns") {
      // Closing the chooser (Done or the Columns button) applies a pending column change at once; focus returns to Columns.
      const closing = this.chooser, back = `[data-action="fabric-x-columns"][data-ds="${this.ds}"][data-focus-key="cols"]`;
      this.chooser = !this.chooser;
      if (closing && this.applyColumns()) { if (target?.dataset?.focusKey === "cols-done") this.focus(back); return; }
      this.redrawInPlace(closing ? back : ""); return;
    }
    if (action === "fabric-x-columns-reset") { this.resetColumns(); this.page = { cursor: null, stack: [] }; this.redrawAfter(); return; }
    if (action === "fabric-x-retry") { this.retry(); return; }
    if (action === "fabric-x-clear") { this.clearFilters(); return; }
    if (action === "fabric-x-reload") { this.openRecord(""); this.records.key = null; this.p.c.update(); }
  }
  onInput(target) {
    const action = target.dataset.action;
    if (action?.startsWith("fabric-r-")) { const view = FabricExplorer.global("FabricRecordView"); if (view && typeof view.onInput === "function") view.onInput(this, target); return; }
    if (action === "fabric-x-search") { this.draft = target.value; clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.commitSearch(), 350); return; }
    if (action === "fabric-x-field-filter") { this.fieldFilter = target.value; this.filterRows(); return; }
    if (action === "fabric-x-col-filter") { this.columnFilter = target.value; this.filterColumns(); }
  }
  onChange(target) {
    const action = target.dataset.action;
    if (action?.startsWith("fabric-r-")) { const view = FabricExplorer.global("FabricRecordView"); if (view && typeof view.onChange === "function") view.onChange(this, target); return; }
    if (action === "fabric-x-filter") { const name = target.dataset.filter; if (this.info?.filters.some((f) => f.name === name)) this.setQuery({ filters: { [name]: FabricExplorer.clean(target.value, 100) } }); return; }
    if (action === "fabric-x-date") { this.setDate(target.dataset.edge === "to" ? "to" : "from", target.value); return; }
    if (action === "fabric-x-limit") { const n = Number(target.value); if (FabricExplorer.PAGE_SIZES.includes(n)) this.setQuery({ limit: n }); return; }
    if (action === "fabric-x-sort-select") { if (this.info?.sorts.some((s) => s.name === target.value)) this.setQuery({ sort: target.value }); return; }
    if (action === "fabric-x-dir") { this.setQuery({ dir: target.value === "asc" ? "asc" : "desc" }); return; }
    if (action === "fabric-x-col") { if (this.toggleColumn(target.dataset.name, Boolean(target.checked))) this.queueColumns(); else target.checked = this.columns?.includes(target.dataset.name) ?? false; return; }
    if (action === "fabric-x-hide-empty") { this.hideEmpty = Boolean(target.checked); this.filterRows(); }
  }
  onSubmit() { if (this.draft !== null) this.commitSearch(); }
  // Optional: the panel may pass keydown events here. Escape inside the column chooser closes it (like Done); the record view
  // uses the rest.
  onKeydown(event) {
    if (!this.recordId && this.chooser && event?.key === "Escape" && event.target?.closest?.(`#fabric-${this.ds}-chooser, [data-action="fabric-x-columns"][data-focus-key="cols"]`)) {
      event.preventDefault?.(); this.onAction("fabric-x-columns", { dataset: { action: "fabric-x-columns", ds: this.ds, focusKey: "cols-done" } }); return;
    }
    if (!this.recordId) return; const view = FabricExplorer.global("FabricRecordView"); if (view && typeof view.onKeydown === "function") view.onKeydown(this, event); }
}
if (typeof window !== "undefined") window.FabricExplorer = FabricExplorer;
