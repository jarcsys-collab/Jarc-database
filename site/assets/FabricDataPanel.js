// Fabric Data (sidebar → Fabric Data): the read-only Inventory and Sales explorers (FabricExplorer.js, driven by each dataset's
// schema), plus API Management for its administrators. The v1 invoice views stay here, shown only while the server reports
// features.fabricData.invoiceViews. Shows only what the server reports (GET /api/v1/fabric/*); the server checks the reader list
// on every request, so hiding the section from others is convenience, not protection.
//
// Nothing read here is ever stored in the browser: no IndexedDB, BoardCache or saved user state, and the only browser-storage
// entry (FabricExplorer) is the list of column NAMES chosen per dataset. The data lives in memory only and is dropped when the
// session ends (expired, denied, signed out) or the server refuses access.
// Every value from the server is shown through AppView.escape()/attr(); path segments always go through encodeURIComponent.
class FabricDataPanel {
  static SECTIONS = [["inventory", "Inventory", "database"], ["sales", "Sales", "records"], ["invoices", "Invoices", "columns"], ["api", "API Management", "lock"]];
  static DATASET_VIEWS = ["inventory", "sales"];
  // Actions the panel hands to the explorer named by data-ds: its list (x), filter builder (f), column menus (c) and record page (r).
  static EXPLORER_PREFIXES = ["fabric-x-", "fabric-f-", "fabric-c-", "fabric-r-"];
  static DETAIL_TABS = [["overview", "Overview"], ["lines", "Sales Lines"], ["fields", "All Fields"], ["keys", "Keys"]];
  static INVOICE_SORTS = ["invoiceDate", "invoiceNo", "customerName", "amount"];
  static DEFAULT_DAYS = 30;
  static MAX_DAYS = 92;
  static INVOICE_PAGE = 50;
  static LINE_PAGE = 100; // at most 200 (the server's limit)
  // /fabric/{inventory|sales}[/records/{id}] and /fabric/api; the v1 /fabric/invoices[/{company}/{invoiceNo}] (only with
  // invoiceViews, otherwise Sales) and /fabric/sales-lines (now Sales). The same pages as the server's HTML route and EntraAuth.
  static DATASET_PATH = /^\/fabric\/(inventory|sales)(?:\/records\/([A-Fa-f0-9]{24}))?\/?$/;
  static PATH = /^\/fabric\/(invoices|sales-lines|api)(?:\/([^/]{1,400})\/([^/]{1,400}))?\/?$/;
  static DAY = /^\d{4}-\d{2}-\d{2}$/;
  static CAPABILITY = { invoices: "invoiceList", invoice: "invoiceDetail" };
  static CAPABILITY_LABEL = { invoiceList: "Invoices list", salesLines: "Sales lines", invoiceDetail: "Invoice details" };
  static KEY_LABELS = [["join_key_Company_Invoice", "Company + invoice"], ["join_key_Invoice_CustLedger", "Invoice + customer ledger"], ["join_key_bc_company_item_uom", "Company + item + unit"], ["join_key_bc_valueEntries_Sales_Invoice", "Value entries + sales invoice"], ["join_key_company_salesperson_code", "Company + salesperson"], ["connect_to_rmr", "RMR"], ["connect_to_salescreditmemo", "Sales credit memo"], ["Ref", "Ref"]];
  // What each server answer means for the person, in plain words. Never the generic "permission to make this change".
  static MESSAGES = {
    FABRIC_DATA_FORBIDDEN: ["denied", "You don't have access to Fabric Data. It is open only to the people a JARC administrator has named. Ask a JARC administrator if you need it."],
    FABRIC_INDEX_REQUIRED: ["index", "This view is waiting for the data team to add indexes to the Fabric data. Try again later."],
    FABRIC_SOURCE_MISSING: ["source", "The Fabric data is being refreshed upstream. Try again in a few minutes."],
    FABRIC_UNAVAILABLE: ["unavailable", "Fabric Data can't be reached right now. Try again in a moment."],
    FABRIC_UNSAFE_CREDENTIALS: ["unavailable", "Fabric Data is switched off for safety until an administrator checks its connection settings."],
    FABRIC_TIMEOUT: ["range", "This took too long. Narrow the date range or add a company filter."],
    FABRIC_RANGE_TOO_LARGE: ["range", "There are too many rows in this date range. Narrow the date range or choose a company."],
    FABRIC_LINE_NOT_FOUND: ["line", "This line is no longer in the source (the data may have been refreshed). Reload the invoice."],
    FABRIC_INVOICE_NOT_FOUND: ["missing", "This invoice isn't in the Fabric data. The data may have been refreshed, or the link is wrong."],
    FABRIC_RECORD_NOT_FOUND: ["record", "This record is no longer in the source (the data may have been refreshed). Reload the list to see the current rows."],
    FABRIC_BUSY: ["busy", "Fabric Data is busy. Try again in a moment."],
    INSUFFICIENT_SCOPE: ["generic", "This dataset isn't included in your access."],
    RATE_LIMITED: ["generic", "Too many requests in a short time. Wait a few seconds, then try again."],
    VALIDATION_ERROR: ["generic", "Some filters or columns aren't valid. Check the dates and the search text, or choose Default columns."],
    METHOD_NOT_ALLOWED: ["generic", "Fabric Data is read-only."]
  };
  // How long a date stays valid in tests: FabricDataPanel.now is replaced there.
  static now() { return new Date(); }

  // ---- Pure helpers (also used by tests and by AppController for the address bar)
  static isDay(v) {
    if (typeof v !== "string" || !FabricDataPanel.DAY.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }
  static dayMs(v) { return Date.parse(`${v}T00:00:00Z`); }
  static addDays(day, n) { return new Date(FabricDataPanel.dayMs(day) + n * 86400000).toISOString().slice(0, 10); }
  static today(now = FabricDataPanel.now()) { return now.toISOString().slice(0, 10); } // UTC day, like the server
  // The last N UTC days ending today (inclusive).
  static defaultRange(now = FabricDataPanel.now(), days = FabricDataPanel.DEFAULT_DAYS) { const to = FabricDataPanel.today(now); return { dateFrom: FabricDataPanel.addDays(to, -(days - 1)), dateTo: to }; }
  static rangeDays(from, to) { return Math.round((FabricDataPanel.dayMs(to) - FabricDataPanel.dayMs(from)) / 86400000) + 1; }
  // "" when the range may be sent; otherwise what to fix. The server checks it again (it is authoritative).
  static rangeProblem(from, to, maxDays = FabricDataPanel.MAX_DAYS) {
    if (!FabricDataPanel.isDay(from) || !FabricDataPanel.isDay(to)) return "Enter both dates as real days.";
    if (from > to) return "The start date must be on or before the end date.";
    const days = FabricDataPanel.rangeDays(from, to);
    if (days > maxDays) return `Choose at most ${maxDays} days (this range has ${days}).`;
    return "";
  }
  static validSegment(v) { return typeof v === "string" && v.length >= 1 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v); }
  static cleanText(v, max) { const t = typeof v === "string" ? v.trim() : ""; return t.length <= max && !/[\u0000-\u001f\u007f]/.test(t) ? t : ""; }
  // Filters from a query string. Anything invalid falls back to its default (the address may have been typed or edited).
  static parseFilters(view, search, now = FabricDataPanel.now()) {
    const p = new URLSearchParams(search || ""), d = FabricDataPanel.defaultRange(now);
    const from = p.get("dateFrom"), to = p.get("dateTo");
    const dated = FabricDataPanel.isDay(from) && FabricDataPanel.isDay(to);
    const f = { dateFrom: dated ? from : d.dateFrom, dateTo: dated ? to : d.dateTo, company: FabricDataPanel.cleanText(p.get("company"), 64), q: FabricDataPanel.cleanText(p.get("q"), 100), dir: p.get("dir") === "asc" ? "asc" : "desc" };
    f.sort = FabricDataPanel.INVOICE_SORTS.includes(p.get("sort")) ? p.get("sort") : "invoiceDate";
    return f;
  }
  // What a path asks for: undefined (not a Fabric path), or { view, query?, recordId?, filters?, company?, invoiceNo?, legacy? }.
  // query: the explorer's filters (FabricExplorer.parseQuery). Invoice paths carry one too, for when they show Sales instead.
  static parsePath(pathname, search = "", now = FabricDataPanel.now()) {
    const d = FabricDataPanel.DATASET_PATH.exec(pathname || "");
    if (d) return { view: d[1], recordId: d[2] || "", query: FabricExplorer.parseQuery(search) };
    const m = FabricDataPanel.PATH.exec(pathname || "");
    if (!m || (m[2] !== undefined && m[1] !== "invoices")) return undefined;
    if (m[1] === "api") return { view: "api" };
    if (m[1] === "sales-lines") return { view: "sales", recordId: "", legacy: true, query: FabricExplorer.parseQuery(search) };
    const filters = FabricDataPanel.parseFilters("invoices", search, now), query = { ...FabricExplorer.parseQuery(search), sort: "", dir: "" };
    if (m[2] === undefined) return { view: "invoices", filters, query };
    let company, invoiceNo;
    try { company = decodeURIComponent(m[2]); invoiceNo = decodeURIComponent(m[3]); } catch { return { view: "invoices", filters, query }; }
    if (!FabricDataPanel.validSegment(company) || !FabricDataPanel.validSegment(invoiceNo)) return { view: "invoices", filters, query };
    return { view: "invoice", company: company === "~" ? null : company, invoiceNo, filters, query };
  }
  // The query string for filters: only what differs from the defaults (so /fabric/invoices means "the last 30 days").
  static filterQuery(view, f, now = FabricDataPanel.now()) {
    if (!f) return "";
    const d = FabricDataPanel.defaultRange(now), p = new URLSearchParams();
    if (f.dateFrom !== d.dateFrom || f.dateTo !== d.dateTo) { p.set("dateFrom", f.dateFrom); p.set("dateTo", f.dateTo); }
    if (f.company) p.set("company", f.company);
    if (f.q) p.set("q", f.q);
    if (f.sort && f.sort !== "invoiceDate") p.set("sort", f.sort);
    if (f.dir === "asc") p.set("dir", "asc");
    const s = p.toString();
    return s ? `?${s}` : "";
  }
  static invoicePath(company, invoiceNo) { return `/fabric/invoices/${encodeURIComponent(company ?? "~")}/${encodeURIComponent(invoiceNo)}`; }
  static formatPath(route, now = FabricDataPanel.now()) {
    const r = route || { view: "inventory" };
    if (r.view === "api") return { path: "/fabric/api", search: "" };
    if (FabricDataPanel.DATASET_VIEWS.includes(r.view)) return { path: `/fabric/${r.view}${r.recordId && FabricExplorer.ID.test(r.recordId) ? `/records/${encodeURIComponent(r.recordId)}` : ""}`, search: FabricExplorer.formatQuery(r.query) };
    if (r.view === "invoice") return { path: FabricDataPanel.invoicePath(r.company, r.invoiceNo), search: FabricDataPanel.filterQuery("invoices", r.filters, now) };
    if (r.view === "invoices") return { path: "/fabric/invoices", search: FabricDataPanel.filterQuery("invoices", r.filters, now) };
    return { path: "/fabric/inventory", search: "" };
  }
  // Two spellings of the same Fabric page (percent-encoding, a trailing slash, the old /fabric/sales-lines for /fabric/sales):
  // compared by what they ask for.
  static samePath(a, b) {
    const x = FabricDataPanel.parsePath(a), y = FabricDataPanel.parsePath(b);
    return Boolean(x && y) && x.view === y.view && (x.company ?? null) === (y.company ?? null) && (x.invoiceNo ?? null) === (y.invoiceNo ?? null) && (x.recordId ?? "") === (y.recordId ?? "");
  }
  // A failed request → { kind, code, message, reference }. kind: denied | index | source | unavailable | range | line | missing | generic.
  static errorInfo(error) {
    const server = error?.cause?.serverCode || null, status = error?.cause?.status;
    let code = server || error?.code || "INTERNAL_ERROR";
    if (!server && (status === 403 || code === "FORBIDDEN")) code = "FABRIC_DATA_FORBIDDEN";
    const known = FabricDataPanel.MESSAGES[code];
    let kind = known?.[0] || "generic", message = known?.[1];
    if (!message) {
      if (code === "UNAUTHENTICATED") message = "Your session has ended. Sign in again to continue.";
      else message = (typeof StorageError === "function" && StorageError.describe ? StorageError.describe(error)?.message : "") || "Fabric Data didn't answer. Try again in a moment.";
      if (code === "SERVICE_UNAVAILABLE") kind = "unavailable";
    }
    const reference = typeof error?.requestId === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(error.requestId) ? error.requestId : "";
    return { kind, code, message, reference };
  }

  constructor(controller) {
    this.c = controller;
    this.explorers = Object.fromEntries(FabricDataPanel.DATASET_VIEWS.map((ds) => [ds, new FabricExplorer(this, ds)]));
    this.reset();
    this.api = typeof FabricApiPanel === "function" ? new FabricApiPanel(this) : null;
    // The session ended: nothing read from Fabric stays in memory (the next person at this computer can't see it).
    for (const name of ["jarc-session-expired", "jarc-access-denied", "jarc-account-pending"]) window.addEventListener?.(name, () => this.forget());
    // Arrow keys inside this section's tab lists (not a global shortcut: only when focus is on one of its tabs).
    if (typeof document !== "undefined") document.addEventListener?.("keydown", (event) => this.onKeydown(event));
  }
  reset() {
    const now = FabricDataPanel.now();
    this.route = { view: "inventory", company: null, invoiceNo: "" };
    this.inv = FabricDataPanel.parseFilters("invoices", "", now);
    this.drafts = { invoices: null };
    this.invPage = { cursor: null, stack: [] }; this.linesPage = { cursor: null, stack: [] };
    for (const x of Object.values(this.explorers || {})) x.forget();
    this.list = FabricDataPanel.slot(); this.detail = FabricDataPanel.slot(); this.lines = FabricDataPanel.slot(); this.line = FabricDataPanel.slot();
    this.status = null; this.statusLoading = false; this.statusError = null;
    this.companies = []; this.detailTab = "overview"; this.selectedLine = ""; this.fieldFilter = ""; this.hideEmpty = false;
    this.denied = false; this.searchTimer = null; this.announced = ""; this.statusOpen = false;
  }
  static slot() { return { key: null, data: null, loading: false, error: null, seq: 0 }; }
  forget() { clearTimeout(this.searchTimer); this.reset(); this.api?.forget(); }
  get view() { return this.c.view; }
  get adapter() { return this.c.model.storage?.adapter; }
  get features() { return this.c.model.features?.fabricData || null; }
  get visible() { return Boolean(this.features?.read && this.adapter?.request); }
  get apiVisible() { return Boolean(this.visible && this.features?.apiAdmin && this.features?.apiTokens && this.api); }
  get invoiceViews() { return Boolean(this.visible && this.features?.invoiceViews === true); }
  // A dataset tab, unless /features lists the datasets this person may read and leaves it out.
  datasetAllowed(ds) { const list = this.features?.datasets; return FabricDataPanel.DATASET_VIEWS.includes(ds) && (!Array.isArray(list) || list.includes(ds)); }
  sections() { return FabricDataPanel.SECTIONS.filter(([id]) => (id === "api" ? this.apiVisible : id === "invoices" ? this.invoiceViews : this.datasetAllowed(id))); }
  defaultView() { return FabricDataPanel.DATASET_VIEWS.find((ds) => this.datasetAllowed(ds)) || (this.invoiceViews ? "invoices" : this.apiVisible ? "api" : "inventory"); }
  isDataset(view) { return FabricDataPanel.DATASET_VIEWS.includes(view); }
  get explorer() { return this.isDataset(this.route.view) ? this.explorers[this.route.view] : null; }
  esc(v) { return this.view.escape(v ?? ""); }
  attr(v) { return this.view.attr(v); }
  get maxDays() { const m = Number(this.status?.limits?.maxDays); return Number.isInteger(m) && m > 0 && m <= 366 ? m : FabricDataPanel.MAX_DAYS; }
  filtersFor() { return this.inv; }

  // ---- Address bar (AppController.applyBoardUrl / syncBoardUrl)
  // Shows what a parsed Fabric path asks for. Returns whether anything changed. The v1 invoice pages show Sales unless
  // invoiceViews is on; /fabric/sales-lines is Sales; a tab this person can't open shows the first one they can.
  applyRoute(r) {
    if (!r) return false;
    let view = r.view, query = r.query, recordId = r.recordId || "";
    if ((view === "invoices" || view === "invoice") && !this.invoiceViews) { view = "sales"; recordId = ""; }
    if ((view === "api" && !this.apiVisible) || (this.isDataset(view) && !this.datasetAllowed(view))) { view = this.defaultView(); query = null; recordId = ""; }
    const before = this.routeKey();
    if (this.isDataset(view)) { const x = this.explorers[view]; if (query) x.applyQuery(query); x.openRecord(recordId); this.route = { view, company: null, invoiceNo: "" }; }
    else {
      if (r.filters && (view === "invoices" || view === "invoice")) { if (JSON.stringify(r.filters) !== JSON.stringify(this.inv)) { this.inv = { ...r.filters }; this.invPage = { cursor: null, stack: [] }; this.drafts.invoices = null; } }
      if (view === "invoice") this.openInvoiceState(r.company ?? null, r.invoiceNo);
      else this.route = { view, company: null, invoiceNo: "" };
    }
    return before !== this.routeKey();
  }
  routeKey() { return JSON.stringify([this.route, this.inv, ...Object.values(this.explorers).map((x) => x.state())]); }
  openInvoiceState(company, invoiceNo) {
    const same = this.route.view === "invoice" && this.route.company === company && this.route.invoiceNo === invoiceNo;
    this.route = { view: "invoice", company, invoiceNo };
    if (!same) { this.detailTab = "overview"; this.selectedLine = ""; this.fieldFilter = ""; this.linesPage = { cursor: null, stack: [] }; }
  }
  routeForUrl() {
    const r = this.route, open = this.sections().some(([id]) => id === (r.view === "invoice" ? "invoices" : r.view));
    const view = open ? r.view : this.defaultView();
    if (this.isDataset(view)) { const x = this.explorers[view]; return { view, recordId: x.recordId, query: x.query }; }
    if (view === "invoice") return { view: "invoice", company: r.company, invoiceNo: r.invoiceNo, filters: this.inv };
    if (view === "api") return { view: "api" };
    return { view: "invoices", filters: this.inv };
  }
  urlFor() { return FabricDataPanel.formatPath(this.routeForUrl()); }
  hrefFor(route) { const u = FabricDataPanel.formatPath(route); return `${u.path}${u.search}`; }
  syncUrl() { this.c.syncBoardUrl?.(); }

  // ---- The page
  // The Fabric application (an app module, AppModules.js): a compact app bar (Objects button, icon, name, the open section,
  // Read-only, connection status, Refresh), then .fx-app__split: the Objects panel (FabricObjects.js, primary navigation) and
  // .fx-app__body (#fabric-root), which fill the rest of the viewport. The explorer, record page and API Management draw inside
  // the body; only their own inner regions scroll (fabric-ui.css).
  html() {
    if (!this.visible) return `<div class="fx-app fx-app--closed"><header class="fx-appbar"><span class="fx-appbar__icon" aria-hidden="true">${icon("database")}</span><h1 class="fx-appbar__title">Fabric Data</h1></header><div class="fx-app__body"><div class="fx-status fx-status--info fx-app__notice" role="status"><span class="fx-status__text">Fabric Data is available only to the people a JARC administrator has named.</span></div></div></div>`;
    if (!this.sections().some(([id]) => id === (this.route.view === "invoice" ? "invoices" : this.route.view))) this.route = { view: this.defaultView(), company: null, invoiceNo: "" };
    this.scheduleEnsure();
    const v = this.route.view, active = v === "invoice" ? "invoices" : v, section = this.sections().find(([id]) => id === active)?.[1] || "";
    // Primary navigation is the Objects panel (FabricObjects.js) left of the body; the app bar names the open section.
    const objects = typeof FabricObjects === "function";
    return `<div class="fx-app" data-fx-view="${this.attr(v)}"><header class="fx-appbar">${objects ? FabricObjects.toggleHtml(this) : ""}<span class="fx-appbar__icon" aria-hidden="true">${icon("database")}</span><h1 class="fx-appbar__title">Fabric Data</h1>
      <span class="fx-appbar__section"><span class="fx-appbar__sep" aria-hidden="true">/</span><span id="fabric-section-title">${this.esc(section)}</span></span>
      <div class="fx-appbar__chips"><span class="fx-chip fx-chip--readonly" title="Nothing here can be changed">${icon("lock")}<span>Read-only</span></span><span id="fabric-conn" class="fx-appbar__conn">${this.connectionHtml()}</span><button type="button" class="fx-btn fx-btn--icon" data-action="fabric-refresh" data-focus-key="refresh" aria-label="Refresh" title="Refresh">${icon("refresh")}</button></div></header>
      <div id="fabric-status" class="fx-app__status">${this.statusHtml()}</div><p id="fabric-live" class="sr-only" role="status" aria-live="polite">${this.esc(this.announced)}</p><div class="fx-app__split">${objects ? FabricObjects.html(this) : ""}<div id="fabric-root" class="fx-app__body fabric-root" role="region" aria-labelledby="fabric-section-title" data-module-scroll data-focus-key="fabric-body">${this.body()}</div></div></div>`;
  }
  // The Objects panel on its own (FabricSavedFilters calls this once its list has answered); the rest stays as it is.
  redrawObjects() { if (typeof FabricObjects === "function") FabricObjects.redraw(this); }

  // ---- Status (GET /fabric/status, once per section entry and on Refresh): the app bar's connection chip and, under the bar,
  // one compact fx-status line with its technical details collapsed. The explorers read statusFor(dataset).
  // { mode, available, reason, missingIndexes, window } for a dataset, or null before /status answered. mode: "indexed" | "small"
  // | "indexrequired" | "sourcemissing" | "unavailable" | "" (what the server said, lower case, without - or _).
  statusFor(dataset) {
    const s = this.status;
    if (!s || typeof s !== "object") return null;
    const d = s.datasets?.[dataset] && typeof s.datasets[dataset] === "object" ? s.datasets[dataset] : {};
    let mode = String(d.mode || "").toLowerCase().replace(/[-_]/g, "");
    const reason = typeof d.reason === "string" && d.reason ? d.reason : s.available === false ? (typeof s.reason === "string" && s.reason ? s.reason : "FABRIC_UNAVAILABLE") : null;
    if (mode === "unavailable" && reason === "FABRIC_INDEX_REQUIRED") mode = "indexrequired";
    if (mode === "unavailable" && reason === "FABRIC_SOURCE_MISSING") mode = "sourcemissing";
    if (s.available === false && !mode) mode = reason === "FABRIC_SOURCE_MISSING" ? "sourcemissing" : "unavailable";
    return { mode, available: s.available !== false && d.available !== false && !["indexrequired", "sourcemissing", "unavailable"].includes(mode), reason, missingIndexes: Array.isArray(d.missingIndexes) ? d.missingIndexes : [], window: d.window && typeof d.window === "object" ? d.window : null };
  }
  // The connection state shown in the app bar: { tone: ok|info|warn|error, label, text }.
  connection() {
    if (this.denied) return { tone: "error", label: "Access denied", text: FabricDataPanel.MESSAGES.FABRIC_DATA_FORBIDDEN[1] };
    if (this.statusError) return this.statusError.kind === "unavailable" ? { tone: "error", label: "Unavailable", text: this.statusError.message } : { tone: "warn", label: "Status unknown", text: `The Fabric Data status couldn't be checked: ${this.statusError.message}` };
    if (!this.status) return { tone: "info", label: "Checking…", text: "Checking the Fabric Data connection." };
    const ds = this.isDataset(this.route.view) ? this.route.view : null, st = ds ? this.statusFor(ds) : null;
    const mode = st ? st.mode : this.status.available === false ? (this.status.reason === "FABRIC_SOURCE_MISSING" ? "sourcemissing" : "unavailable") : "";
    if (mode === "sourcemissing") return { tone: "warn", label: "Refreshing upstream", text: FabricDataPanel.MESSAGES.FABRIC_SOURCE_MISSING[1] };
    if (mode === "indexrequired") return { tone: "warn", label: "Index required", text: FabricDataPanel.MESSAGES.FABRIC_INDEX_REQUIRED[1] };
    if (mode === "unavailable") return { tone: "error", label: "Unavailable", text: FabricDataPanel.MESSAGES[st?.reason || this.status.reason]?.[1] || FabricDataPanel.MESSAGES.FABRIC_UNAVAILABLE[1] };
    return { tone: "ok", label: "Connected", text: "Connected to the Fabric data." };
  }
  connectionHtml() {
    const c = this.connection(), glyph = { ok: "✓", info: "…", warn: "!", error: "×" }[c.tone];
    return `<span class="fx-chip fx-chip--conn is-${c.tone}" title="${this.attr(c.text)}"><span class="fx-chip__dot" aria-hidden="true">${glyph}</span><span class="sr-only">Connection: </span><span>${this.esc(c.label)}</span></span>`;
  }
  // The one status line under the app bar (nothing when all is well): a problem (warn / error), or the info that a dataset is
  // browsed without its recommended indexes. Technical details (mode, reason, index names, the check time) stay collapsed.
  statusHtml() {
    if (!this.visible) return "";
    const c = this.connection(), ds = this.isDataset(this.route.view) ? this.route.view : null, st = ds ? this.statusFor(ds) : null;
    const missing = st?.missingIndexes || [];
    let tone = null, text = "";
    if (c.tone === "warn" || c.tone === "error") { tone = c.tone; text = c.text; }
    else if (c.tone === "ok" && missing.length) { tone = "info"; text = st.mode === "small" ? "Indexes recommended: this dataset is small enough to browse without them; some searches and sorts may be slower." : "Indexes recommended: some searches or sorts wait for the data team to add them."; }
    if (!tone || this.denied) return "";
    const lines = [];
    if (st?.mode) lines.push(`Mode: ${st.mode}`);
    if (st?.reason || this.status?.reason) lines.push(`Reason: ${st?.reason || this.status.reason}`);
    if (this.statusError?.code) lines.push(`Code: ${this.statusError.code}`);
    if (this.statusError?.reference) lines.push(`Reference: ${this.statusError.reference}`);
    if (typeof this.status?.checkedAt === "string") lines.push(`Checked: ${this.status.checkedAt}`);
    for (const m of missing) { const name = typeof m === "string" ? m : m?.name; if (name) lines.push(`Index: ${name}`); }
    const open = Boolean(this.statusOpen), details = lines.length ? `<button type="button" class="fx-status__toggle" data-action="fabric-status-details" data-focus-key="status-details" aria-expanded="${open}" aria-controls="fabric-status-details">Details</button><pre id="fabric-status-details" class="fx-status__details" ${open ? "" : "hidden"}>${this.esc(lines.join("\n"))}</pre>` : "";
    return `<div class="fx-status fx-status--${tone}" role="status"><span class="fx-status__icon" aria-hidden="true">${tone === "info" ? "i" : "!"}</span><span class="fx-status__text">${this.esc(text)}</span>${details}</div>`;
  }
  // The app bar's chip and the status line, redrawn on their own (the rest of the page is untouched); focus stays on Details.
  redrawStatus() {
    if (typeof document === "undefined") return;
    const conn = document.querySelector("#fabric-conn"), line = document.querySelector("#fabric-status");
    if (conn) conn.innerHTML = this.connectionHtml();
    if (!line) return;
    const focused = document.activeElement && line.contains(document.activeElement);
    line.innerHTML = this.statusHtml();
    if (focused) line.querySelector("[data-focus-key='status-details']")?.focus?.({ preventScroll: true });
  }
  // Redraws only the section (#fabric-root) and the status, keeping focus and the caret where they were.
  redraw() {
    if (typeof document === "undefined") return;
    this.redrawStatus();
    const root = document.querySelector("#fabric-root");
    if (!root) return;
    const active = document.activeElement, inside = active && root.contains(active);
    const id = inside ? active.id : "", key = inside ? active.dataset?.focusKey : "";
    let sel = null; if (inside) { try { sel = [active.selectionStart, active.selectionEnd]; } catch { sel = null; } }
    root.innerHTML = this.body();
    if (!inside) return;
    const esc = (v) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v);
    const next = id ? root.querySelector(`#${esc(id)}`) : key ? root.querySelector(`[data-focus-key="${esc(key)}"]`) : null;
    if (next && !next.disabled) { next.focus({ preventScroll: true }); if (sel && sel[0] !== null && sel[0] !== undefined && typeof next.setSelectionRange === "function") { try { next.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ } } }
    else root.querySelector("[data-focus-key='results'], h2, table")?.focus?.({ preventScroll: true });
  }
  announce(text) { this.announced = text; const el = typeof document !== "undefined" ? document.querySelector("#fabric-live") : null; if (el) el.textContent = text; }
  body() {
    if (this.denied) return this.deniedHtml();
    const v = this.route.view;
    if (v === "api") return this.api ? this.api.html() : "";
    if (this.isDataset(v)) return this.explorers[v].html(); // a status problem shows once, under the app bar (statusHtml)
    const banners = this.bannersHtml(v);
    if (v === "invoice") return banners + this.invoiceHtml();
    return banners + this.invoicesHtml();
  }

  // ---- Loading
  scheduleEnsure() { if (this.ensureQueued) return; this.ensureQueued = true; setTimeout(() => { this.ensureQueued = false; this.ensure(); }, 0); }
  ensure() {
    if (!this.visible || this.denied || this.c.model.screen !== "fabric") return;
    if (!this.status && !this.statusLoading && !this.statusError) this.loadStatus();
    const v = this.route.view;
    if (v === "api") { this.api?.ensure(); return; }
    if (this.isDataset(v)) { this.explorers[v].ensure(); return; }
    if (this.blocked(v)) return;
    if (v === "invoices") { if (!this.rangeProblemFor(this.inv)) this.want(this.list, this.invoicesPath()); return; }
    if (v === "invoice") {
      this.want(this.detail, this.invoiceApiPath());
      if (this.detailTab !== "overview" || this.selectedLine) this.want(this.lines, this.linesPath());
      if ((this.detailTab === "fields" || this.detailTab === "keys") && !this.selectedLine && this.lines.data?.items?.length && this.lines.key === this.linesPath()) this.selectedLine = this.lines.data.items[0].id;
      if ((this.detailTab === "fields" || this.detailTab === "keys") && this.selectedLine) this.want(this.line, this.linePath(this.selectedLine));
    }
  }
  // Loads a slot unless it already holds (or is loading, or failed on) exactly this request.
  want(slot, path) { if (slot.key !== path) this.fetchInto(slot, path); }
  async fetchInto(slot, path, { keep = false } = {}) {
    const seq = ++slot.seq;
    if (!keep) slot.data = null;
    slot.key = path; slot.loading = true; slot.error = null; this.redraw();
    try {
      const data = await this.adapter.request("GET", path);
      if (slot.seq !== seq) return;
      slot.data = data;
      if (slot === this.list && Array.isArray(data?.companies)) this.companies = data.companies.filter((c) => c && (typeof c.company === "string" || c.company === null)).map((c) => c.company);
    } catch (error) {
      if (slot.seq !== seq) return;
      slot.error = FabricDataPanel.errorInfo(error);
      if (slot.error.kind === "denied") { this.deny(); return; }
    } finally { if (slot.seq === seq) slot.loading = false; }
    if (this.denied) return;
    this.redraw(); this.announceSlot(slot);
    // The lines arrived: All Fields and Keys show the first line until another is chosen.
    if (slot === this.lines) this.ensure();
  }
  announceSlot(slot) {
    if (slot.error) { this.announce(slot.error.message); return; }
    const d = slot.data;
    if (slot === this.list && d) this.announce(d.items?.length ? `${this.count(d.total?.invoices)} invoices · ${this.count(d.total?.rows)} rows` : "No invoices match");    else if (slot === this.lines && d) this.announce(`${d.items?.length || 0} lines shown`);
  }
  async loadStatus() {
    if (this.statusLoading) return;
    this.statusLoading = true;
    try { this.status = await this.adapter.request("GET", "/fabric/status"); this.statusError = null; }
    catch (error) { this.statusError = FabricDataPanel.errorInfo(error); if (this.statusError.kind === "denied") { this.statusLoading = false; this.deny(); return; } }
    finally { this.statusLoading = false; }
    if (this.denied) return;
    this.redraw();
  }
  deny() { const api = this.api; this.forget(); this.denied = true; this.api = api; this.redraw(); this.announce("You don't have access to Fabric Data."); }
  // What /status says about a view before anything is asked: unavailable, or waiting for an index.
  blocked(view) {
    const s = this.status;
    if (!s) return null;
    if (s.available === false) return FabricDataPanel.errorInfo({ cause: { serverCode: s.reason || "FABRIC_UNAVAILABLE" } });
    const cap = FabricDataPanel.CAPABILITY[view];
    if (cap && s.capabilities && s.capabilities[cap] === false) return FabricDataPanel.errorInfo({ cause: { serverCode: "FABRIC_INDEX_REQUIRED" } });
    return null;
  }
  rangeProblemFor(f) { return FabricDataPanel.rangeProblem(f.dateFrom, f.dateTo, this.maxDays); }
  query(f, extra) {
    const p = new URLSearchParams({ dateFrom: f.dateFrom, dateTo: f.dateTo });
    if (f.company) p.set("company", f.company);
    if (f.q) p.set("q", f.q);
    for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== "") p.set(k, String(v));
    return p.toString();
  }
  invoicesPath() { return `/fabric/invoices?${this.query(this.inv, { sort: this.inv.sort, dir: this.inv.dir, limit: FabricDataPanel.INVOICE_PAGE, cursor: this.invPage.cursor })}`; }  invoiceApiPath(company = this.route.company, invoiceNo = this.route.invoiceNo) { return `/fabric/invoices/${encodeURIComponent(company ?? "~")}/${encodeURIComponent(invoiceNo)}`; }
  linesPath() { const p = new URLSearchParams({ limit: String(FabricDataPanel.LINE_PAGE) }); if (this.linesPage.cursor) p.set("cursor", this.linesPage.cursor); return `${this.invoiceApiPath()}/lines?${p}`; }
  linePath(id) { return `${this.invoiceApiPath()}/lines/${encodeURIComponent(id)}`; }

  // ---- Formatting
  count(n) { return Number.isFinite(Number(n)) ? Number(n).toLocaleString() : "—"; }
  static num(v) { if (v === null || v === undefined || v === "") return null; const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? n : null; }
  money(v) { const n = FabricDataPanel.num(v); return n === null ? "—" : this.esc(n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })); }
  qty(v) { const n = FabricDataPanel.num(v); return n === null ? "—" : this.esc(n.toLocaleString(undefined, { maximumFractionDigits: 4 })); }
  pct(v) { const n = FabricDataPanel.num(v); return n === null ? "—" : `${this.esc(n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }))} %`; }
  day(iso) {
    if (!iso || typeof iso !== "string") return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    try { return this.esc(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(d)); } catch { return this.esc(d.toISOString().slice(0, 10)); }
  }
  text(v) { return v === null || v === undefined || v === "" ? `<span class="muted">—</span>` : this.esc(Array.isArray(v) ? v.join(", ") : v); }
  companyLabel(c) { return c === null || c === undefined || c === "~" ? "No company" : c; }

  // ---- States
  // Loading: light placeholder rows in the space the content will take (no overlay, no layout jump).
  skeleton(cols, rows = 6) {
    const cells = Array.from({ length: cols }, () => `<td><span class="fabric-skeleton"></span></td>`).join("");
    return `<div class="fabric-loading fx-loading" role="status" aria-busy="true"><span class="sr-only">Loading…</span><table class="fabric-table fx-loading__table" aria-hidden="true"><tbody>${Array.from({ length: rows }, () => `<tr>${cells}</tr>`).join("")}</tbody></table></div>`;
  }
  // attrs: extra attributes for the button (the explorer's data-ds="…", a fixed dataset name).
  errorHtml(info, retry = "fabric-retry", extra = "", attrs = "") {
    const title = { denied: "No access to Fabric Data", forbidden: "No access to this dataset", index: "Waiting for indexes", source: "Data is being refreshed", unavailable: "Fabric Data is unavailable", range: "Too much data for one request", line: "This line has changed", record: "This record has changed", busy: "Fabric Data is busy", missing: "Invoice not found" }[info.kind] || "Fabric Data couldn't be loaded";
    const button = info.kind === "line" ? `<button type="button" class="fx-btn" data-action="fabric-reload-invoice" data-focus-key="reload">${icon("refresh")}<span>Reload the invoice</span></button>` : info.kind === "record" ? `<button type="button" class="fx-btn" data-action="fabric-x-reload" ${attrs} data-focus-key="reload">${icon("refresh")}<span>Reload the list</span></button>` : info.kind === "range" || info.kind === "forbidden" ? "" : `<button type="button" class="fx-btn" data-action="${retry}" ${attrs} data-focus-key="retry">${icon("refresh")}<span>Try again</span></button>`;
    // Compact: one fx-status block in the content area (warn for waits, error for failures), the reference as small mono text.
    const tone = ["index", "source", "busy", "range", "line", "record"].includes(info.kind) ? "warn" : "error";
    return `<div class="fx-status fx-status--${tone} fx-status--block fabric-alert is-${this.attr(info.kind)}" role="alert"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__text"><strong>${title}</strong> ${this.esc(info.message)}${info.reference ? ` <small class="fx-status__ref">Reference <code>${this.esc(info.reference)}</code></small>` : ""}</span><span class="fx-status__actions fabric-alert-actions">${button}${extra}</span></div>`;
  }
  deniedHtml() {
    return `<div class="fx-status fx-status--error fx-status--block fabric-denied" role="alert"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__text"><strong>No access to Fabric Data</strong> ${this.esc(FabricDataPanel.MESSAGES.FABRIC_DATA_FORBIDDEN[1])}</span><span class="fx-status__actions fabric-alert-actions"><button type="button" class="fx-btn" data-action="fabric-check-again">Check again</button><button type="button" class="fx-btn" data-action="nav" data-screen="home">Go to Home</button></span></div>`;
  }
  emptyHtml(title, text) {
    return `<div class="quiet-empty fabric-empty">${icon("search")}<span><strong>${title}</strong><small>${text}</small></span><button type="button" class="button secondary small" data-action="fabric-clear-filters">Clear filters</button></div>`;
  }
  bannersHtml(view) {
    const s = this.status, out = [];
    if (this.statusError && this.statusError.kind !== "denied") out.push(`<p class="integration-note fabric-banner">The Fabric Data status couldn't be checked: ${this.esc(this.statusError.message)}</p>`);
    if (!s) return out.join("");
    if (s.available === false) { const info = this.blocked(view) || FabricDataPanel.errorInfo({ cause: { serverCode: s.reason || "FABRIC_UNAVAILABLE" } }); out.push(this.errorHtml(info, "fabric-refresh")); return out.join(""); }
    const missing = Array.isArray(s.missingIndexes) ? s.missingIndexes : [];
    if (missing.length) {
      const needed = [...new Set(missing.flatMap((m) => (Array.isArray(m?.neededFor) ? m.neededFor : [])))].map((c) => FabricDataPanel.CAPABILITY_LABEL[c] || c);
      out.push(`<div class="integration-alert fabric-banner is-index" role="status"><strong>Some views are waiting for the data team to add indexes.</strong><span>${needed.length ? `Not available yet: ${this.esc(needed.join(", "))}.` : ""} Other views keep working.</span><details><summary>Indexes needed</summary><ul>${missing.map((m) => `<li><code>${this.esc(m?.name || "")}</code></li>`).join("")}</ul></details></div>`);
    }
    return out.join("");
  }

  // ---- Filters (v1 Invoices)
  filtersHtml(view) {
    const f = this.filtersFor(view), draft = this.drafts[view], max = this.maxDays, problem = this.rangeProblemFor(f);
    const prefix = "fabric-inv";
    const known = [...new Set(this.companies)], current = f.company;
    const options = [`<option value="">All companies</option>`, ...known.map((c) => { const value = c === null ? "~" : c; return `<option value="${this.attr(value)}" ${value === current ? "selected" : ""}>${this.esc(this.companyLabel(c))}</option>`; })];
    if (current && !known.some((c) => (c === null ? "~" : c) === current)) options.push(`<option value="${this.attr(current)}" selected>${this.esc(this.companyLabel(current))}</option>`);
    const company = known.length || current ? `<label>Company<select id="${prefix}-company" data-action="fabric-filter" data-filter="company">${options.join("")}</select></label>` : `<label>Company<input id="${prefix}-company" type="search" data-action="fabric-filter" data-filter="company" value="${this.attr(current)}" maxlength="64" placeholder="Exact name" autocomplete="off"></label>`;
    const placeholder = "Invoice no., customer or document no.", dir = "";
    return `<form class="health-filters fabric-filters" role="search" aria-label="Filter invoices" data-action="fabric-filter-form" data-view="${view}">
      <label class="fabric-search">Search<input id="${prefix}-q" type="search" data-action="fabric-search" data-view="${view}" value="${this.attr(draft ?? f.q)}" maxlength="100" placeholder="${placeholder}" autocomplete="off"></label>
      <label>From (UTC)<input id="${prefix}-from" type="date" data-action="fabric-filter" data-filter="dateFrom" value="${this.attr(f.dateFrom)}" required aria-describedby="${prefix}-range-help"></label>
      <label>To (UTC)<input id="${prefix}-to" type="date" data-action="fabric-filter" data-filter="dateTo" value="${this.attr(f.dateTo)}" required aria-describedby="${prefix}-range-help"></label>
      ${company}${dir}
      <p id="${prefix}-range-help" class="fabric-help ${problem ? "is-error" : ""}" ${problem ? 'role="alert"' : ""}>${problem ? this.esc(problem) : `Up to ${max} days.`}</p></form>`;
  }
  pagerHtml(page, data, label, totalText = "") {
    const items = data?.items || [], limit = Number(data?.pagination?.limit) || items.length || 1, start = page.stack.length * limit + 1, end = start + items.length - 1;
    const range = items.length ? `${label} ${start.toLocaleString()}–${end.toLocaleString()}` : "";
    return `<div class="fabric-pager"><span>${range}${totalText ? ` of ${totalText}` : ""}</span><span class="fabric-pager-buttons"><button type="button" class="button secondary small" data-action="fabric-page" data-dir="prev" data-focus-key="prev" ${page.stack.length ? "" : "disabled"}>${icon("left")} Previous</button><button type="button" class="button secondary small" data-action="fabric-page" data-dir="next" data-focus-key="next" ${data?.pagination?.hasMore && data?.pagination?.nextCursor ? "" : "disabled"}>Next ${icon("right")}</button></span></div>`;
  }
  statusBadges(cancelled, closed) {
    const out = [];
    if (cancelled === true) out.push(`<span class="account-badge is-danger">Cancelled</span>`);
    if (closed === true) out.push(`<span class="account-badge">Closed</span>`);
    else if (closed === false && cancelled !== true) out.push(`<span class="account-badge is-ok">Open</span>`);
    return out.join(" ") || `<span class="muted">—</span>`;
  }

  // ---- Invoices list
  invoicesHtml() {
    const blocked = this.blocked("invoices");
    if (blocked) return this.filtersHtml("invoices") + this.errorHtml(blocked, "fabric-refresh");
    const s = this.list, f = this.inv, problem = this.rangeProblemFor(f);
    let results;
    if (problem) results = `<p class="integration-note">Fix the date range to see invoices.</p>`;
    else if (s.error) results = this.errorHtml(s.error);
    else if (!s.data) results = this.skeleton(7);
    else if (!s.data.items?.length) results = this.emptyHtml("No invoices match", "Try a wider date range, another company or different search text.");
    else results = this.invoiceTable(s.data);
    return `${this.filtersHtml("invoices")}<div class="fabric-results" ${s.loading ? 'aria-busy="true"' : ""}>${results}</div>`;
  }
  sortHeader(key, label, numeric = false) {
    const f = this.inv, on = f.sort === key, dir = on ? f.dir : "none";
    const aria = on ? (dir === "asc" ? "ascending" : "descending") : "none";
    return `<th aria-sort="${aria}" class="${numeric ? "fabric-num" : ""}"><button type="button" class="fabric-sort" data-action="fabric-sort" data-sort="${key}" data-focus-key="sort-${key}">${label}<span class="fabric-sort-mark" aria-hidden="true">${on ? (dir === "asc" ? "▲" : "▼") : ""}</span></button></th>`;
  }
  invoiceTable(d) {
    const items = d.items, withCost = items.some((i) => i && typeof i === "object" && "cost" in i && i.cost);
    const head = `<tr>${this.sortHeader("invoiceDate", "Invoice date")}${this.sortHeader("invoiceNo", "Invoice no.")}<th>Company</th>${this.sortHeader("customerName", "Customer")}<th class="fabric-num">Rows</th>${this.sortHeader("amount", "Amount", true)}<th class="fabric-num">Header total</th>${withCost ? `<th class="fabric-num">Margin</th>` : ""}<th>Status</th></tr>`;
    const rows = items.map((i) => {
      const href = this.hrefFor({ view: "invoice", company: i.company ?? null, invoiceNo: i.invoiceNo, filters: this.inv });
      const noDetail = Number(i.lineDetailRows) === 0 ? ` <span class="account-badge fabric-nodetail">No line detail</span>` : "";
      const margin = withCost ? `<td data-label="Margin" class="fabric-num">${i.cost ? `${this.pct(i.cost.marginPct)}<small>cost for ${this.count(i.cost.rowsWithCost)} of ${this.count(i.rows)} rows</small>` : "—"}</td>` : "";
      return `<tr><td data-label="Invoice date">${this.day(i.invoiceDate)}</td><td data-label="Invoice no."><a class="fabric-link" href="${this.attr(href)}" data-action="fabric-open-invoice" data-company="${this.attr(i.company === null || i.company === undefined ? "~" : i.company)}" data-invoice="${this.attr(i.invoiceNo)}">${this.esc(i.invoiceNo)}</a></td><td data-label="Company">${this.esc(this.companyLabel(i.company))}</td><td data-label="Customer">${this.text(i.customerName)}${i.customerId ? `<small>${this.esc(i.customerId)}</small>` : ""}</td><td data-label="Rows" class="fabric-num">${this.count(i.rows)}<small>${this.count(i.lineDetailRows)} with line detail</small>${noDetail}</td><td data-label="Amount" class="fabric-num">${this.money(i.amount)}</td><td data-label="Header total" class="fabric-num">${this.money(i.headerTotal)}</td>${margin}<td data-label="Status">${this.statusBadges(i.cancelled, i.closed)}</td></tr>`;
    }).join("");
    const totals = `${this.count(d.total?.invoices)} invoices · ${this.count(d.total?.rows)} rows`;
    return `<p class="fabric-totals"><strong>${totals}</strong> <small>${this.day(`${d.window?.dateFrom || this.inv.dateFrom}T00:00:00Z`)} – ${this.day(`${d.window?.dateTo || this.inv.dateTo}T00:00:00Z`)} (UTC)</small></p><div class="fabric-scroll" tabindex="0" data-focus-key="results" aria-label="Invoices"><table class="fabric-table fabric-invoices"><thead>${head}</thead><tbody>${rows}</tbody></table></div>${this.pagerHtml(this.invPage, d, "Invoices", this.count(d.total?.invoices))}`;
  }

  // An invoice's lines (v1; cross: with the invoice columns and links).
  linesTable(items, { cross = false, selectable = false } = {}) {
    const withCost = items.some((l) => l && typeof l === "object" && "cost" in l && l.cost);
    const head = `<tr>${cross ? "<th>Invoice date</th><th>Invoice</th><th>Customer</th>" : ""}<th>Line</th><th>Item</th><th class="fabric-num">Quantity</th><th class="fabric-num">Unit price</th><th class="fabric-num">Amount</th><th>Unit</th><th>Source</th>${withCost ? `<th class="fabric-num">Landed cost</th><th class="fabric-num">Profit</th><th class="fabric-num">Margin</th>` : ""}${selectable ? `<th><span class="sr-only">Fields</span></th>` : ""}</tr>`;
    const rows = items.map((l) => {
      const line = l.hasLineDetail === false || l.lineNo === null || l.lineNo === undefined ? `<span class="account-badge fabric-nodetail">No line detail</span>` : this.esc(l.lineNo);
      const invoice = cross ? `<td data-label="Invoice date">${this.day(l.invoiceDate)}</td><td data-label="Invoice"><a class="fabric-link" href="${this.attr(this.hrefFor({ view: "invoice", company: l.company ?? null, invoiceNo: l.invoiceNo, filters: this.inv }))}" data-action="fabric-open-invoice" data-company="${this.attr(l.company === null || l.company === undefined ? "~" : l.company)}" data-invoice="${this.attr(l.invoiceNo)}">${this.esc(l.invoiceNo)}</a><small>${this.esc(this.companyLabel(l.company))}</small></td><td data-label="Customer">${this.text(l.customerName)}</td>` : "";
      const cost = withCost ? `<td data-label="Landed cost" class="fabric-num">${this.money(l.cost?.landedCost)}</td><td data-label="Profit" class="fabric-num">${this.money(l.cost?.profit)}</td><td data-label="Margin" class="fabric-num">${this.pct(l.cost?.marginPct)}</td>` : "";
      const on = selectable && this.selectedLine === l.id;
      const pick = selectable ? `<td data-label=""><button type="button" class="button secondary small" data-action="fabric-select-line" data-line="${this.attr(l.id)}" data-focus-key="line-${this.attr(l.id)}" aria-pressed="${on}">${on ? "Selected" : "Fields"}</button></td>` : "";
      return `<tr class="${on ? "is-selected" : ""}">${invoice}<td data-label="Line">${line}</td><td data-label="Item">${this.text(l.itemName)}${l.itemId ? `<small>${this.esc(l.itemId)}</small>` : ""}${l.description2 ? `<small>${this.esc(l.description2)}</small>` : ""}</td><td data-label="Quantity" class="fabric-num">${this.qty(l.quantitySales ?? l.quantity)}</td><td data-label="Unit price" class="fabric-num">${this.money(l.unitPrice)}</td><td data-label="Amount" class="fabric-num">${this.money(l.amountSales ?? l.amount)}</td><td data-label="Unit">${this.text(l.uom)}</td><td data-label="Source">${this.text(l.salesDataSource)}${l.salesType ? `<small>${this.esc(l.salesType)}</small>` : ""}</td>${cost}${pick}</tr>`;
    }).join("");
    return `<div class="fabric-scroll" tabindex="0" data-focus-key="results" aria-label="Sales lines"><table class="fabric-table fabric-lines"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
  }

  // ---- Invoice detail
  invoiceHtml() {
    const back = this.hrefFor({ view: "invoices", filters: this.inv });
    const crumb = `<nav class="fabric-breadcrumb" aria-label="Breadcrumb"><a href="${this.attr(back)}" data-action="fabric-back">${icon("left")} Invoices</a><span aria-hidden="true">/</span><span aria-current="page">${this.esc(this.companyLabel(this.route.company))} · ${this.esc(this.route.invoiceNo)}</span></nav>`;
    const blocked = this.blocked("invoice");
    if (blocked) return crumb + this.errorHtml(blocked, "fabric-refresh");
    const s = this.detail;
    if (s.error) return crumb + this.errorHtml(s.error);
    if (!s.data?.invoice) return crumb + `<div class="health-tiles fabric-kpis" role="status" aria-busy="true">${Array.from({ length: 4 }, () => `<div class="health-tile"><span class="fabric-skeleton"></span><span class="fabric-skeleton is-wide"></span></div>`).join("")}<span class="sr-only">Loading the invoice…</span></div>`;
    const inv = s.data.invoice, sum = inv.summary || {};
    const tabs = FabricDataPanel.DETAIL_TABS.map(([id, label]) => { const on = id === this.detailTab; const n = id === "lines" && Number.isFinite(Number(sum.rows)) ? ` <small>(${this.count(sum.rows)})</small>` : ""; return `<button type="button" role="tab" id="fabric-dtab-${id}" data-action="fabric-detail-tab" data-tab="${id}" aria-selected="${on}" aria-controls="fabric-detail" tabindex="${on ? 0 : -1}" class="${on ? "active" : ""}">${label}${n}</button>`; }).join("");
    let panel;
    if (this.detailTab === "lines") panel = this.linesTabHtml();
    else if (this.detailTab === "fields") panel = this.fieldsTabHtml();
    else if (this.detailTab === "keys") panel = this.keysTabHtml();
    else panel = this.overviewHtml(inv);
    return `${crumb}<div class="fabric-invoice-head"><h2>${this.esc(inv.invoiceNo)}</h2><span>${this.esc(this.companyLabel(inv.company))}${inv.customerName ? ` · ${this.esc(inv.customerName)}` : ""} · ${this.day(inv.invoiceDate)}</span>${Number(sum.lineDetailRows) === 0 ? `<span class="account-badge fabric-nodetail">No line detail</span>` : ""}</div>${this.kpisHtml(inv)}<div class="apitok-tabs fabric-tabs fabric-detail-tabs" role="tablist" aria-label="Invoice sections">${tabs}</div><div id="fabric-detail" role="tabpanel" aria-labelledby="fabric-dtab-${this.detailTab}">${panel}</div>`;
  }
  kpisHtml(inv) {
    const sum = inv.summary || {}, tile = (label, value, note = "") => `<div class="health-tile"><span class="health-tile-label">${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ""}</div>`;
    const tiles = [tile("Amount", this.money(sum.amount), `Quantity ${this.qty(sum.quantity)}`), tile("Rows", this.count(sum.rows), `${this.count(sum.lineDetailRows)} with line detail`)];
    if (sum.headerTotal !== null && sum.headerTotal !== undefined) tiles.push(tile("Header total", this.money(sum.headerTotal), "From the invoice header"));
    let note = "";
    // Cost, profit and margin only when the server sent them (cost readers); otherwise nothing hints at them.
    if (inv.cost && typeof inv.cost === "object") {
      tiles.push(tile("Landed cost", this.money(inv.cost.landedCost)), tile("Profit", this.money(inv.cost.profit)), tile("Margin", this.pct(inv.cost.marginPct)));
      note = `<p class="integration-note fabric-cost-note">Cost available for ${this.count(inv.cost.rowsWithCost)} of ${this.count(sum.rows)} rows. Profit and margin cover those rows only.</p>`;
    }
    return `<div class="health-tiles fabric-kpis">${tiles.join("")}</div>${note}`;
  }
  overviewHtml(inv) {
    const h = inv.header || {}, sum = inv.summary || {};
    const group = (title, rows) => `<section class="integration-card fabric-group"><h3>${title}</h3><dl class="integration-facts fabric-facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl></section>`;
    const status = this.statusBadges(h.is_invoice_cancelled, h.is_invoice_closed);
    const selected = this.lines.data?.items?.find((l) => l.id === this.selectedLine);
    const lineGroup = selected ? group("Selected line", [["Line", selected.lineNo ?? `<span class="account-badge fabric-nodetail">No line detail</span>`], ["Item", this.text(selected.itemName)], ["Item no.", this.text(selected.itemId)], ["Quantity", this.qty(selected.quantitySales ?? selected.quantity)], ["Unit price", this.money(selected.unitPrice)], ["Amount", this.money(selected.amountSales ?? selected.amount)], ["Unit", this.text(selected.uom)]]) : "";
    return `<div class="fabric-groups">${group("Invoice", [["Invoice no.", this.esc(inv.invoiceNo)], ["Company", this.esc(this.companyLabel(inv.company))], ["Invoice date", this.day(inv.invoiceDate)], ["Due date", this.day(inv.dueDate)], ["Customer", this.text(inv.customerName)], ["Customer no.", this.text(inv.customerId)], ["Order no.", this.text(h.Order_No)], ["External document no.", this.text(h.external_document_no)], ["Terms", this.text(h.invoice_terms_description)], ["Status", status]])}
      ${group("Sales attribution", [["Salesperson", this.text(h.Salesperson_Code)], ["Territory (sales)", this.text(h.territory_sales)], ["Region", this.text(h.region)], ["Territory", this.text(h.territory)], ["Location", this.text(h.Location_Code)], ["Business unit 2026", this.text(h.business_unit_2026)]])}
      ${group("Customer group and shipping", [["Category", this.text(h.category)], ["Classification", this.text(h.classification)], ["Ship to", this.text(h.Ship_to_Name)], ["Ship-to city", this.text(h.Ship_to_City)]])}
      ${group("Source", [["Data source", this.text(h.sales_data_source ?? sum.sources)], ["Sales type", this.text(h.sales_type)], ["First row date", this.day(sum.firstDate)], ["Last row date", this.day(sum.lastDate)]])}${lineGroup}</div>`;
  }
  linesTabHtml() {
    const s = this.lines;
    if (s.error) return this.errorHtml(s.error);
    if (!s.data) return this.skeleton(7, 5);
    if (!s.data.items?.length) return `<p class="integration-note">This invoice has no lines on this page.</p>`;
    return `<p class="integration-note">Rows without line detail have no line number, unit price or unit. Choose <strong>Fields</strong> to see every field of a line.</p>${this.linesTable(s.data.items, { selectable: true })}${this.pagerHtml(this.linesPage, s.data, "Lines", this.count(this.detail.data?.invoice?.summary?.rows))}`;
  }
  linePicker() {
    const items = this.lines.data?.items || [];
    if (!items.length) return "";
    const label = (l, i) => `${l.lineNo !== null && l.lineNo !== undefined ? `Line ${l.lineNo}` : `Row ${this.linesPage.stack.length * FabricDataPanel.LINE_PAGE + i + 1} (no line detail)`}${l.itemName ? ` · ${l.itemName}` : ""}`;
    return `<label class="fabric-line-picker">Line<select id="fabric-line-pick" data-action="fabric-line-pick">${items.map((l, i) => `<option value="${this.attr(l.id)}" ${l.id === this.selectedLine ? "selected" : ""}>${this.esc(label(l, i))}</option>`).join("")}</select></label>`;
  }
  lineState() {
    if (this.lines.error) return this.errorHtml(this.lines.error);
    if (!this.lines.data) return this.skeleton(3, 6);
    if (!this.lines.data.items?.length) return `<p class="integration-note">This invoice has no lines.</p>`;
    if (this.line.error) return this.errorHtml(this.line.error);
    if (!this.line.data?.line) return this.skeleton(3, 8);
    return "";
  }
  fieldsTabHtml() {
    const state = this.lineState();
    const tools = `<div class="fabric-field-tools">${this.linePicker()}<label class="fabric-search">Filter fields<input id="fabric-field-filter" type="search" data-action="fabric-field-filter" value="${this.attr(this.fieldFilter)}" maxlength="100" placeholder="Field name or value" autocomplete="off"></label><label class="fabric-check"><input id="fabric-hide-empty" type="checkbox" data-action="fabric-hide-empty" ${this.hideEmpty ? "checked" : ""}> Hide empty fields</label></div>`;
    if (state) return tools + state;
    const fields = Array.isArray(this.line.data.line.fields) ? this.line.data.line.fields : [];
    const term = this.fieldFilter.trim().toLowerCase();
    const rows = fields.map((f) => {
      const shown = this.fieldValue(f), plain = this.fieldPlain(f), empty = f.value === null || f.value === undefined || f.value === "";
      const hidden = (this.hideEmpty && empty) || (term && !`${f.name} ${plain}`.toLowerCase().includes(term));
      return `<tr data-field="${this.attr(`${f.name} ${plain}`.toLowerCase())}" data-empty="${empty}" ${hidden ? "hidden" : ""}><td data-label="Field"><code>${this.esc(f.name)}</code></td><td data-label="Value">${shown}</td><td data-label="Type"><small class="muted">${this.esc(f.type || "")}</small></td></tr>`;
    }).join("");
    return `${tools}<p class="fabric-help" id="fabric-field-count">${fields.length} fields</p><div class="fabric-scroll" tabindex="0" aria-label="All fields"><table class="fabric-table fabric-fields"><thead><tr><th>Field</th><th>Value</th><th>Type</th></tr></thead><tbody id="fabric-field-rows">${rows}</tbody></table></div>`;
  }
  fieldPlain(f) { const v = f?.value; if (v === null || v === undefined) return ""; if (typeof v === "boolean") return v ? "Yes" : "No"; if (typeof v === "object") { try { return JSON.stringify(v); } catch { return ""; } } return String(v); }
  fieldValue(f) {
    const v = f?.value;
    if (v === null || v === undefined || v === "") return `<span class="muted">—</span>`;
    if (f.type === "date" && typeof v === "string") return `${this.day(v)} <small class="muted">${this.esc(v)}</small>`;
    if (typeof v === "boolean") return v ? "Yes" : "No";
    return this.esc(this.fieldPlain(f));
  }
  keysTabHtml() {
    const state = this.lineState(), tools = `<div class="fabric-field-tools">${this.linePicker()}</div>`;
    if (state) return tools + state;
    const keys = this.line.data.line.keys || {};
    return `${tools}<dl class="fabric-keys">${FabricDataPanel.KEY_LABELS.map(([k, label]) => `<div><dt>${this.esc(label)} <small><code>${this.esc(k)}</code></small></dt><dd><code>${keys[k] === null || keys[k] === undefined || keys[k] === "" ? "—" : this.esc(keys[k])}</code></dd></div>`).join("")}</dl><p class="integration-note">Line IDs aren't permanent: they change when the Fabric data is reloaded upstream, so they are never part of a saved link.</p>`;
  }

  // ---- Events (routed here by AppController for every "fabric-…" action)
  onAction(action, target, event) {
    if (action.startsWith("fabric-api-")) { this.api?.onAction(action, target, event); return; }
    // Links stay real links: Ctrl/⌘/Shift/middle click opens them in a new tab or window as usual.
    const plain = !event || (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && (event.button === undefined || event.button === 0));
    if (target.tagName === "A" && !plain) return;
    if (target.tagName === "A") event?.preventDefault?.();
    // fabric-o-…: the Objects panel (FabricObjects.js).
    if (action.startsWith("fabric-o-")) { if (typeof FabricObjects === "function") FabricObjects.onAction(this, action, target, event); return; }
    // fabric-s-…: saved filters (FabricSavedFilters.js). Chosen in the Objects panel, the dataset is shown first.
    if (action.startsWith("fabric-s-")) { this.savedFilterAction(action, target, event); return; }
    // fabric-x-… / fabric-f-… / fabric-c-…: the explorer (its filter builder and column menus); fabric-r-…: the record page
    // (FabricRecordView, through its explorer). All name data-ds.
    if (FabricDataPanel.EXPLORER_PREFIXES.some((p) => action.startsWith(p))) { this.explorerFor(target)?.onAction(action, target, event); return; }
    if (action === "fabric-status-details") { this.statusOpen = !this.statusOpen; this.redrawStatus(); return; }
    if (action === "fabric-section") {
      const id = target.dataset.section, fromObjects = Boolean(target.closest?.("#fabric-objects")) && typeof FabricObjects === "function";
      if (fromObjects) { FabricObjects.afterChoice(this, id); if (FabricObjects.PARENTS.includes(id)) { FabricObjects.state(this).open.add(id); FabricObjects.save(this); } }
      this.openSection(id, { focus: !fromObjects });
      if (fromObjects) FabricObjects.focusAfterChoice(this, id);
      return;
    }
    if (action === "fabric-open-invoice") { const c = target.dataset.company; this.openInvoice(c === "~" ? null : c, target.dataset.invoice); return; }
    if (action === "fabric-back") { this.openSection("invoices"); return; }
    if (action === "fabric-refresh") { this.refresh(); return; }
    if (action === "fabric-retry") { this.retry(); return; }
    if (action === "fabric-check-again") { this.denied = false; this.status = null; this.statusError = null; this.c.update(); return; }
    if (action === "fabric-reload-invoice") { this.selectedLine = ""; this.line = FabricDataPanel.slot(); this.lines = FabricDataPanel.slot(); this.detail.key = null; this.linesPage = { cursor: null, stack: [] }; this.ensure(); return; }
    if (action === "fabric-clear-filters") { this.clearFilters(); return; }
    if (action === "fabric-sort") { this.sortBy(target.dataset.sort); return; }
    if (action === "fabric-page") { this.page(target.dataset.dir); return; }
    if (action === "fabric-detail-tab") { this.detailTab = FabricDataPanel.DETAIL_TABS.some(([id]) => id === target.dataset.tab) ? target.dataset.tab : "overview"; this.redraw(); this.ensure(); this.focusTab("fabric-dtab", this.detailTab); return; }
    if (action === "fabric-select-line") { this.selectedLine = target.dataset.line || ""; this.detailTab = "fields"; this.redraw(); this.ensure(); this.focusTab("fabric-dtab", "fields"); }
  }
  // The explorer an event belongs to: its data-ds names one of the fixed datasets.
  explorerFor(target) { const ds = target?.dataset?.ds; return this.isDataset(ds) && this.datasetAllowed(ds) ? this.explorers[ds] : null; }
  focusTab(prefix, id) { if (typeof document !== "undefined") document.querySelector(`#${prefix}-${id}`)?.focus?.(); }
  // Opens a section (a dataset's list, Invoices or API Management). focus: false when the caller places focus itself.
  openSection(id, { focus = true } = {}) {
    if (!this.sections().some(([s]) => s === id)) return;
    this.route = { view: id, company: null, invoiceNo: "" };
    if (this.isDataset(id)) this.explorers[id].openRecord("");
    this.c.update();
    if (focus) this.focusTab("fabric-obj", id);
  }
  // fabric-s-… (saved filters, FabricSavedFilters.js). From the Objects panel, the filter's dataset list is shown first (route
  // only); the explorer then hands the action to the saved-filters module, which applies the filter. A full redraw follows a choice
  // made in the panel, so the panel, the app bar and the address bar all show it.
  savedFilterAction(action, target, event) {
    const x = this.explorerFor(target);
    if (!x) return;
    const objects = typeof FabricObjects === "function" && Boolean(target.closest?.("#fabric-objects"));
    if (objects) {
      FabricObjects.afterChoice(this, `${x.ds}-saved-${target.dataset.id || ""}`);
      if (this.route.view !== x.ds || x.recordId) { this.route = { view: x.ds, company: null, invoiceNo: "" }; x.openRecord(""); }
    }
    x.onAction?.(action, target, event); // the explorer hands fabric-s-… to FabricSavedFilters (02-audit-and-architecture §2g)
    if (objects) { this.c.update(); FabricObjects.focusAfterChoice(this, `${x.ds}-saved-${target.dataset.id || ""}`); }
  }
  openInvoice(company, invoiceNo) {
    if (!FabricDataPanel.validSegment(invoiceNo) || (company !== null && !FabricDataPanel.validSegment(company))) return;
    this.openInvoiceState(company, invoiceNo);
    this.c.update();
    if (typeof document !== "undefined") document.querySelector(".fabric-breadcrumb a")?.focus?.();
  }
  // Refresh: ask again for what is on screen (and the status), keeping it visible meanwhile.
  refresh() {
    this.status = null; this.statusError = null;
    if (this.route.view === "api") { this.api?.refresh(); this.loadStatus(); return; }
    if (this.explorer) { this.explorer.refresh(); this.loadStatus().then(() => this.ensure()); return; }
    const again = (slot) => { if (slot.key) this.fetchInto(slot, slot.key, { keep: true }); };
    if (this.route.view === "invoices") again(this.list);
    else { again(this.detail); if (this.lines.key) again(this.lines); if (this.line.key) again(this.line); }
    this.loadStatus().then(() => this.ensure());
  }
  retry() {
    for (const slot of [this.list, this.detail, this.lines, this.line]) if (slot.error) slot.key = null;
    this.ensure();
  }
  clearFilters() {
    this.inv = FabricDataPanel.parseFilters("invoices", ""); this.invPage = { cursor: null, stack: [] };
    this.drafts.invoices = null; this.afterFilter();
  }
  setFilter(view, changes) {
    const f = this.inv, next = { ...f, ...changes };
    if (JSON.stringify(next) === JSON.stringify(f)) return;
    this.inv = next; this.invPage = { cursor: null, stack: [] };
    this.afterFilter();
  }
  afterFilter() { this.redraw(); this.ensure(); this.syncUrl(); }
  sortBy(key) {
    if (!FabricDataPanel.INVOICE_SORTS.includes(key)) return;
    const f = this.inv, dir = f.sort === key ? (f.dir === "asc" ? "desc" : "asc") : (key === "invoiceNo" || key === "customerName" ? "asc" : "desc");
    this.setFilter("invoices", { sort: key, dir });
  }
  page(dir) {
    const view = this.route.view, slot = view === "invoice" ? this.lines : this.list;
    const page = view === "invoice" ? this.linesPage : this.invPage;
    if (dir === "next") { const next = slot.data?.pagination?.nextCursor; if (!slot.data?.pagination?.hasMore || !next) return; page.stack.push(page.cursor); page.cursor = next; }
    else { if (!page.stack.length) return; page.cursor = page.stack.pop(); }
    this.ensure();
    if (typeof document !== "undefined") document.querySelector("#fabric-root [data-focus-key='results']")?.scrollIntoView?.({ block: "nearest" });
  }
  onInput(target, event) {
    const action = target.dataset?.action;
    if (action?.startsWith("fabric-api-")) { this.api?.onInput?.(target); return; }
    if (this.explorerAction(action)) { this.explorerFor(target)?.onInput(target, event); return; }
    if (action === "fabric-search") {
      const view = "invoices";
      this.drafts[view] = target.value;
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.commitSearch(view), 300);
      return;
    }
    if (action === "fabric-field-filter") { this.fieldFilter = target.value; this.filterFieldRows(); }
  }
  commitSearch(view) {
    clearTimeout(this.searchTimer);
    const draft = this.drafts[view];
    if (draft === null || draft === undefined) return;
    const q = FabricDataPanel.cleanText(draft, 100);
    this.setFilter(view, { q });
  }
  // The All Fields filter works on the rows already drawn: typing never redraws the table or moves focus.
  filterFieldRows() {
    if (typeof document === "undefined") return;
    const term = this.fieldFilter.trim().toLowerCase(); let shown = 0, all = 0;
    document.querySelectorAll("#fabric-field-rows tr").forEach((tr) => { all += 1; const hide = (this.hideEmpty && tr.dataset.empty === "true") || (term && !tr.dataset.field.includes(term)); tr.hidden = Boolean(hide); if (!hide) shown += 1; });
    const count = document.querySelector("#fabric-field-count"); if (count) count.textContent = shown === all ? `${all} fields` : `${shown} of ${all} fields`;
  }
  onChange(target) {
    const action = target.dataset?.action;
    if (action?.startsWith("fabric-api-")) { this.api?.onChange?.(target); return; }
    if (this.explorerAction(action)) { this.explorerFor(target)?.onChange(target); return; }
    if (action === "fabric-filter") {
      const view = "invoices";
      const name = target.dataset.filter;
      if (name === "dateFrom" || name === "dateTo") { this.setFilter(view, { [name]: String(target.value || "") }); return; }
      if (name === "company") { this.setFilter(view, { company: FabricDataPanel.cleanText(target.value, 64) }); return; }
      if (name === "dir") { this.setFilter(view, { dir: target.value === "asc" ? "asc" : "desc" }); return; }
      return;
    }
    if (action === "fabric-hide-empty") { this.hideEmpty = Boolean(target.checked); this.filterFieldRows(); return; }
    if (action === "fabric-line-pick") { this.selectedLine = target.value; this.redraw(); this.ensure(); }
  }
  onSubmit(action, form) {
    if (action.startsWith("fabric-api-")) { this.api?.onSubmit(action, form); return; }
    if (action === "fabric-x-form") { this.explorerFor(form)?.onSubmit(); return; }
    if (this.explorerAction(action)) { this.explorerFor(form)?.onSubmit(action, form); return; }
    if (action === "fabric-filter-form") { this.commitSearch("invoices"); }
  }
  // Inputs, changes and forms of the explorer's parts (x, f, c, r) and of saved filters (s): the explorer named by data-ds.
  explorerAction(action) { return typeof action === "string" && (FabricDataPanel.EXPLORER_PREFIXES.some((p) => action.startsWith(p)) || action.startsWith("fabric-s-")); }
  // Keys inside the Objects panel go to it (tree keys, the drawer's Escape and focus trap). Arrow keys, Home and End move between
  // the tabs of the v1 invoice page (role="tablist"), and open the one reached. Other keys inside the section go to the open
  // explorer (its grid and record page keys), when it handles keys.
  onKeydown(event) {
    if (typeof FabricObjects === "function" && this.c.model?.screen === "fabric" && event.target?.closest?.("#fabric-objects") && FabricObjects.onKeydown(this, event)) return;
    const tab = event.target?.closest?.('.fabric-tabs [role="tab"]');
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      if (!tab && this.c.model?.screen === "fabric" && event.target?.closest?.("#fabric-root")) this.explorer?.onKeydown?.(event);
      return;
    }
    const tabs = [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')], i = tabs.indexOf(tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (i + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[next].focus(); tabs[next].click();
  }
}
if (typeof window !== "undefined") window.FabricDataPanel = FabricDataPanel;
