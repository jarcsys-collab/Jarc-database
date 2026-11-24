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
      sorts.push({ name, fields: keys, label: typeof d?.label === "string" ? d.label : "", default: d?.default === true, requiresCompany: d?.requiresCompany === true, dateRange: d?.dateRange !== false });
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

  constructor(panel, dataset) { this.p = panel; this.ds = dataset; this.reset(); }
  reset() {
    clearTimeout(this.searchTimer);
    this.query = FabricExplorer.emptyQuery(); this.draft = null; this.page = { cursor: null, stack: [] };
    this.schema = FabricExplorer.slot(); this.records = FabricExplorer.slot(); this.record = FabricExplorer.slot();
    this.info = null; this.columns = null; this.recordId = ""; this.chooser = false; this.columnFilter = ""; this.fieldFilter = ""; this.hideEmpty = false; this.problem = ""; this.notice = "";
  }
  static slot() { return { key: null, data: null, loading: false, error: null, seq: 0 }; }
  forget() { this.reset(); }
  get label() { return this.info?.label || FabricExplorer.DATASETS[this.ds] || this.ds; }
  esc(v) { return this.p.esc(v); }
  attr(v) { return this.p.attr(v); }
  get storageKey() { return `${FabricExplorer.STORAGE_PREFIX}${this.ds}`; }
  get statusInfo() { const d = this.p.status?.datasets?.[this.ds]; return d && typeof d === "object" ? d : null; }

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
  resetColumns() { try { window.localStorage?.removeItem(this.storageKey); } catch { /* storage blocked */ } this.columns = this.defaultColumns(); }

  // ---- Loading
  blocked() {
    const s = this.p.status;
    if (!s) return null;
    if (s.available === false) return FabricDataPanel.errorInfo({ cause: { serverCode: s.reason || "FABRIC_UNAVAILABLE" } });
    if (Array.isArray(s.access?.datasets) && !s.access.datasets.includes(this.ds)) return { kind: "forbidden", code: "FABRIC_DATASET_FORBIDDEN", message: `You don't have access to ${FabricExplorer.DATASETS[this.ds] || "this dataset"}.`, reference: "" };
    const d = this.statusInfo;
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
    if (problem !== this.problem) { this.problem = problem; this.p.redraw(); }
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
    slot.key = path; slot.loading = true; slot.error = null; this.p.redraw();
    try {
      const data = await this.p.adapter.request("GET", path);
      if (slot.seq !== seq) return;
      slot.data = data;
      if (slot === this.schema) { this.info = FabricExplorer.normalize(data); this.chooseColumns(); }
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
  after() { this.p.redraw(); this.ensure(); this.p.syncUrl(); }
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
  sortFor(column) {
    const sorts = this.info?.sorts || [], skip = new Set([this.info?.companyField, "_id"]);
    return sorts.find((s) => s.fields[0] === column) || sorts.find((s) => s.fields.filter((k) => !skip.has(k))[0] === column) || null;
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

  // ---- The page
  html() {
    const blocked = this.blocked();
    if (blocked) return this.bannersHtml() + this.p.errorHtml(blocked, "fabric-refresh");
    if (this.schema.error) return this.p.errorHtml(this.schema.error, "fabric-x-retry", "", `data-ds="${this.ds}"`);
    if (!this.info) return `<div class="fabric-explorer">${this.p.skeleton(6, 6)}</div>`;
    return `<div class="fabric-explorer" data-ds="${this.ds}">${this.bannersHtml()}${this.recordId ? this.recordHtml() : this.listHtml()}</div>`;
  }
  bannersHtml() {
    const d = this.statusInfo;
    if (!d) return "";
    const missing = Array.isArray(d.missingIndexes) ? d.missingIndexes : [];
    const mode = String(d.mode || "").toLowerCase();
    if (!missing.length) return "";
    const list = `<details><summary>Indexes recommended</summary><ul>${missing.map((m) => `<li><code>${this.esc(typeof m === "string" ? m : m?.name || "")}</code></li>`).join("")}</ul></details>`;
    const text = mode.startsWith("small") ? "This dataset is small enough to browse without indexes. Searches and sorting may be slower until the data team adds them." : "Some searches or sorts are waiting for the data team to add indexes.";
    return `<div class="integration-alert fabric-banner is-index" role="status"><span>${text}</span>${list}</div>`;
  }
  filterControl(f) {
    const id = `fabric-${this.ds}-f-${f.name}`, value = this.query.filters[f.name] ?? "", label = this.esc(f.label || FabricExplorer.humanize(f.name));
    const common = `id="${this.attr(id)}" data-action="fabric-x-filter" data-ds="${this.ds}" data-filter="${this.attr(f.name)}" title="${this.attr(f.field)}"`;
    if (f.type === "bool" || f.type === "boolean") return `<label>${label}<select ${common}><option value="">Any</option><option value="true" ${value === "true" ? "selected" : ""}>Yes</option><option value="false" ${value === "false" ? "selected" : ""}>No</option></select></label>`;
    const company = f.name === "company" || (this.info.companyField && f.field === this.info.companyField);
    let options = f.options;
    if (!options && company && Array.isArray(this.statusInfo?.companies)) options = this.statusInfo.companies;
    if (options && options.length) {
      const opts = options.map((o) => { const raw = o !== null && typeof o === "object" ? o.value : o, v = raw === null ? "~" : String(raw), text = o !== null && typeof o === "object" && typeof o.label === "string" ? o.label : raw === null ? "No company" : String(raw); return `<option value="${this.attr(v)}" ${v === value ? "selected" : ""}>${this.esc(text)}</option>`; });
      if (value && !options.some((o) => { const raw = o !== null && typeof o === "object" ? o.value : o; return (raw === null ? "~" : String(raw)) === value; })) opts.push(`<option value="${this.attr(value)}" selected>${this.esc(value === "~" ? "No company" : value)}</option>`);
      return `<label>${label}<select ${common}><option value="">${company ? "All companies" : "Any"}</option>${opts.join("")}</select></label>`;
    }
    return `<label>${label}<input ${common} type="search" value="${this.attr(value)}" maxlength="100" autocomplete="off" placeholder="${company ? "Exact name; ~ = no company" : "Exact value"}"></label>`;
  }
  filtersHtml() {
    const info = this.info, q = this.query, w = this.shownWindow(), max = this.maxDays, ds = this.ds;
    const searchable = info.fields.filter((f) => f.searchable).map((f) => f.name);
    const placeholder = searchable.length ? `Search ${searchable.slice(0, 3).join(", ")}${searchable.length > 3 ? "…" : ""}` : "Search";
    const sorts = info.sorts.length > 1 ? `<label>Sort<select id="fabric-${ds}-sort" data-action="fabric-x-sort-select" data-ds="${ds}">${info.sorts.map((s) => `<option value="${this.attr(s.name)}" ${(q.sort || info.sorts[0].name) === s.name ? "selected" : ""}>${this.esc(s.label || FabricExplorer.humanize(s.name))}</option>`).join("")}</select></label>` : "";
    const order = info.sorts.length ? `<label>Order<select id="fabric-${ds}-dir" data-action="fabric-x-dir" data-ds="${ds}"><option value="desc" ${q.dir !== "asc" ? "selected" : ""}>Descending</option><option value="asc" ${q.dir === "asc" ? "selected" : ""}>Ascending</option></select></label>` : "";
    const dates = this.datesApply(), off = dates ? "" : "disabled";
    const help = this.problem ? `<p id="fabric-${ds}-range-help" class="fabric-help is-error" role="alert">${this.esc(this.problem)}</p>` : !dates ? `<p id="fabric-${ds}-range-help" class="fabric-help">This order lists one company's rows by entry number; dates don't apply to it.</p>` : `<p id="fabric-${ds}-range-help" class="fabric-help">${info.dateField ? `Dates filter <code>${this.esc(info.dateField)}</code> (UTC days). ` : ""}${max ? `Up to ${max} days. ` : ""}Leave them empty for the server's default window.</p>`;
    return `<form class="health-filters fabric-filters" role="search" aria-label="Filter ${this.attr(this.label)}" data-action="fabric-x-form" data-ds="${ds}">
      <label class="fabric-search">Search<input id="fabric-${ds}-q" type="search" data-action="fabric-x-search" data-ds="${ds}" value="${this.attr(this.draft ?? q.q)}" maxlength="100" placeholder="${this.attr(placeholder)}" autocomplete="off"></label>
      <label>From (UTC)<input id="fabric-${ds}-from" type="date" data-action="fabric-x-date" data-ds="${ds}" data-edge="from" value="${this.attr(w.dateFrom)}" aria-describedby="fabric-${ds}-range-help" ${off}></label>
      <label>To (UTC)<input id="fabric-${ds}-to" type="date" data-action="fabric-x-date" data-ds="${ds}" data-edge="to" value="${this.attr(w.dateTo)}" aria-describedby="fabric-${ds}-range-help" ${off}></label>
      ${info.filters.map((f) => this.filterControl(f)).join("")}${sorts}${order}
      <label>Rows per page<select id="fabric-${ds}-limit" data-action="fabric-x-limit" data-ds="${ds}">${FabricExplorer.PAGE_SIZES.map((n) => `<option value="${n}" ${q.limit === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      ${help}</form>`;
  }
  windowText() {
    const w = this.records.data?.window;
    if (!this.records.data) return "";
    const day = (v) => { const d = typeof v === "string" ? new Date(`${v.slice(0, 10)}T00:00:00Z`) : null; if (!d || Number.isNaN(d.getTime())) return ""; try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(d); } catch { return v.slice(0, 10); } };
    const from = day(w?.dateFrom), to = day(w?.dateTo);
    if (from && to) return `Showing ${this.esc(from)} – ${this.esc(to)} (UTC)`;
    return "Showing all dates";
  }
  chooserHtml() {
    const ds = this.ds, term = this.columnFilter.trim().toLowerCase();
    const rows = this.info.fields.map((f) => { const on = this.columns.includes(f.name), hide = term && !f.name.toLowerCase().includes(term); return `<label class="fabric-check" data-col="${this.attr(f.name.toLowerCase())}" ${hide ? "hidden" : ""}><input type="checkbox" data-action="fabric-x-col" data-ds="${ds}" data-name="${this.attr(f.name)}" ${on ? "checked" : ""}> <code>${this.esc(f.name)}</code> <small class="muted">${this.esc(f.type)}</small></label>`; }).join("");
    return `<div class="integration-card fabric-chooser" id="fabric-${ds}-chooser" role="group" aria-label="Columns"><div class="fabric-chooser-head"><label class="fabric-search">Find a column<input id="fabric-${ds}-col-filter" type="search" data-action="fabric-x-col-filter" data-ds="${ds}" value="${this.attr(this.columnFilter)}" maxlength="64" autocomplete="off"></label><button type="button" class="button secondary small" data-action="fabric-x-columns-reset" data-ds="${ds}" data-focus-key="cols-reset">Default columns</button><button type="button" class="button secondary small" data-action="fabric-x-columns" data-ds="${ds}" data-focus-key="cols-done">Done</button></div><p class="fabric-help">${this.columns.length} of ${this.info.fields.length} columns shown. Your choice is remembered in this browser (column names only).</p><div class="fabric-chooser-list" id="fabric-${ds}-col-list">${rows}</div></div>`;
  }
  listHtml() {
    const s = this.records, ds = this.ds;
    let results;
    if (this.problem) results = `<p class="integration-note">${this.rangeProblem() ? "Fix the dates to see rows." : "Choose a company to see rows in this order."}</p>`;
    else if (s.error) results = this.p.errorHtml(s.error, "fabric-x-retry", "", `data-ds="${ds}"`);
    else if (!s.data) results = this.p.skeleton(Math.min(this.columns.length, 8));
    else if (!Array.isArray(s.data.items) || !s.data.items.length) results = `<div class="quiet-empty fabric-empty">${icon("search")}<span><strong>No rows match</strong><small>Try other dates, another filter or different search text.</small></span><button type="button" class="button secondary small" data-action="fabric-x-clear" data-ds="${ds}" data-focus-key="clear">Clear filters</button></div>`;
    else results = this.tableHtml(s.data) + this.pagerHtml(s.data);
    const tools = `<div class="fabric-toolbar"><span class="fabric-window" aria-live="polite">${this.windowText()}</span><span class="fabric-toolbar-buttons"><button type="button" class="button secondary small" data-action="fabric-x-clear" data-ds="${ds}" data-focus-key="clear-top">Clear filters</button><button type="button" class="button secondary small" data-action="fabric-x-columns" data-ds="${ds}" data-focus-key="cols" aria-expanded="${this.chooser}" aria-controls="fabric-${ds}-chooser">${icon("columns")} Columns <small>(${this.columns.length})</small></button></span></div>`;
    return `${this.filtersHtml()}${tools}${this.chooser ? this.chooserHtml() : ""}${this.notice ? `<p class="integration-note fabric-notice" role="status">${this.esc(this.notice)}</p>` : ""}<div class="fabric-results" ${s.loading ? 'aria-busy="true"' : ""}>${results}</div>`;
  }
  headerHtml(name) {
    const f = this.info.byName.get(name), sort = this.sortFor(name), num = this.isNumeric(f?.type) ? "fabric-num" : "";
    const label = `${this.esc(name)}${f?.sensitive ? ` <span class="account-badge is-warn fabric-sensitive" title="Sensitive field">S</span>` : ""}`;
    if (!sort) return `<th scope="col" class="${num}" title="${this.attr(f?.type || "")}">${label}</th>`;
    const current = (this.query.sort || this.info.sorts[0]?.name) === sort.name, dir = this.query.dir || "desc";
    const aria = current ? (dir === "asc" ? "ascending" : "descending") : "none";
    return `<th scope="col" class="${num}" aria-sort="${aria}"><button type="button" class="fabric-sort" data-action="fabric-x-sort" data-ds="${this.ds}" data-sort="${this.attr(sort.name)}" data-focus-key="sort-${this.attr(name)}" title="Sort by ${this.attr(sort.fields.join(", ") || sort.name)}">${label}<span class="fabric-sort-mark" aria-hidden="true">${current ? (dir === "asc" ? "▲" : "▼") : ""}</span></button></th>`;
  }
  tableHtml(d) {
    const cols = this.columns.filter((n) => this.info.byName.has(n));
    const rows = d.items.map((item) => {
      const values = item && typeof item.values === "object" && item.values ? item.values : {}, id = typeof item?.id === "string" && FabricExplorer.ID.test(item.id) ? item.id : "";
      return `<tr>${cols.map((name, i) => {
        const f = this.info.byName.get(name), v = Object.hasOwn(values, name) ? values[name] : null, shown = this.cell(v, f?.type);
        const inner = i === 0 && id ? `<a class="fabric-link" href="${this.attr(this.recordHref(id))}" data-action="fabric-x-open" data-ds="${this.ds}" data-id="${id}" title="Open the record">${v === null || v === undefined || v === "" ? "Open" : shown}</a>` : shown;
        return `<td data-label="${this.attr(name)}" class="${this.isNumeric(f?.type) ? "fabric-num" : ""}">${inner}</td>`;
      }).join("")}</tr>`;
    }).join("");
    return `<div class="fabric-scroll fabric-explorer-scroll" tabindex="0" data-focus-key="results" role="region" aria-label="${this.attr(this.label)} rows"><table class="fabric-table fabric-explorer-table"><thead><tr>${cols.map((n) => this.headerHtml(n)).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  pagerHtml(d) {
    const items = d.items || [], start = this.page.stack.length * this.query.limit + 1, end = start + items.length - 1;
    const more = Boolean(d.pagination?.hasMore && d.pagination?.nextCursor);
    return `<div class="fabric-pager"><span>Rows ${start.toLocaleString()}–${end.toLocaleString()}${more ? " · more available" : ""}</span><span class="fabric-pager-buttons"><button type="button" class="button secondary small" data-action="fabric-x-page" data-ds="${this.ds}" data-dir="prev" data-focus-key="prev" ${this.page.stack.length ? "" : "disabled"}>${icon("left")} Previous</button><button type="button" class="button secondary small" data-action="fabric-x-page" data-ds="${this.ds}" data-dir="next" data-focus-key="next" ${more ? "" : "disabled"}>Next ${icon("right")}</button></span></div>`;
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
  onAction(action, target) {
    if (action === "fabric-x-open") { const id = target.dataset.id; if (FabricExplorer.ID.test(id || "")) { this.openRecord(id); this.p.c.update(); if (typeof document !== "undefined") document.querySelector(".fabric-breadcrumb a")?.focus?.(); } return; }
    if (action === "fabric-x-back") { this.openRecord(""); this.p.c.update(); return; }
    if (action === "fabric-x-sort") { this.sortBy(target.dataset.sort); return; }
    if (action === "fabric-x-page") { this.movePage(target.dataset.dir); return; }
    if (action === "fabric-x-columns") { this.chooser = !this.chooser; this.p.redraw(); return; }
    if (action === "fabric-x-columns-reset") { this.resetColumns(); this.page = { cursor: null, stack: [] }; this.p.redraw(); this.ensure(); return; }
    if (action === "fabric-x-retry") { this.retry(); return; }
    if (action === "fabric-x-clear") { this.clearFilters(); return; }
    if (action === "fabric-x-reload") { this.openRecord(""); this.records.key = null; this.p.c.update(); }
  }
  onInput(target) {
    const action = target.dataset.action;
    if (action === "fabric-x-search") { this.draft = target.value; clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.commitSearch(), 350); return; }
    if (action === "fabric-x-field-filter") { this.fieldFilter = target.value; this.filterRows(); return; }
    if (action === "fabric-x-col-filter") { this.columnFilter = target.value; this.filterColumns(); }
  }
  onChange(target) {
    const action = target.dataset.action;
    if (action === "fabric-x-filter") { const name = target.dataset.filter; if (this.info?.filters.some((f) => f.name === name)) this.setQuery({ filters: { [name]: FabricExplorer.clean(target.value, 100) } }); return; }
    if (action === "fabric-x-date") { this.setDate(target.dataset.edge === "to" ? "to" : "from", target.value); return; }
    if (action === "fabric-x-limit") { const n = Number(target.value); if (FabricExplorer.PAGE_SIZES.includes(n)) this.setQuery({ limit: n }); return; }
    if (action === "fabric-x-sort-select") { if (this.info?.sorts.some((s) => s.name === target.value)) this.setQuery({ sort: target.value }); return; }
    if (action === "fabric-x-dir") { this.setQuery({ dir: target.value === "asc" ? "asc" : "desc" }); return; }
    if (action === "fabric-x-col") { if (this.toggleColumn(target.dataset.name, Boolean(target.checked))) { this.page = { cursor: null, stack: [] }; this.p.redraw(); this.ensure(); } else target.checked = this.columns?.includes(target.dataset.name) ?? false; return; }
    if (action === "fabric-x-hide-empty") { this.hideEmpty = Boolean(target.checked); this.filterRows(); }
  }
  onSubmit() { if (this.draft !== null) this.commitSearch(); }
}
if (typeof window !== "undefined") window.FabricExplorer = FabricExplorer;
