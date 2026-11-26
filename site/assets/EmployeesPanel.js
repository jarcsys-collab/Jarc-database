// People directory (JARC administration, a screen of the normal JARC shell after System Health): the read-only directory
// accounts from the Microsoft Entra ID snapshot, browsed with the Fabric Data explorer (FabricExplorer.js, reused through its
// constructor options: API base /admin/employees, page addresses /admin/employees/…, 22-character profile IDs, its own saved
// filters and the EmployeeProfile record page). Shown only while /features reports employees.view; the server checks the
// viewer and admin lists on every request, so hiding the screen from others is convenience, not protection.
//
// Pages: /admin/employees → /admin/employees/active; /admin/employees/{active|all|disabled|guests}[/records/{id}];
// /admin/employees/groups/{department|jobTitle|officeLocation|emailDomain} (counts per value, "Unassigned" for blank).
// all / disabled / guests only with employees.admin; anyone else (and anyone without employees.view) gets the no-access state.
// P2 (employees.jarcAccess, the employee administrators): a profile's JARC access tab, /admin/employees/{ds}/records/{id}/access,
// loaded from …/records/{id}/jarc-access (EmployeeAccess.js draws it), and the "Disabled with JARC access" navigation item.
//
// Nothing read here is ever stored in the browser: no localStorage, IndexedDB or BoardCache. The only browser-storage entries are
// the explorer's column NAMES (FabricExplorer's "jarc.fabric.columns.<user>.<active|all|disabled|guests>") and the Objects panel's expanded node IDs
// (EmployeesObjects). Rows, profiles, counts and the snapshot live in memory and are dropped on sign-out, expiry or denial.
// Every value from the server is shown through AppView.escape()/attr(); path segments go through encodeURIComponent.
class EmployeesPanel {
  static BASE = "/admin/employees";
  static DATASETS = { active: "Active accounts", all: "All accounts", disabled: "Disabled accounts", guests: "Guest accounts" };
  static DATASET_VIEWS = ["active", "all", "disabled", "guests"];
  static ADMIN_DATASETS = ["all", "disabled", "guests"];
  static GROUPS = [["department", "Department"], ["jobTitle", "Job title"], ["officeLocation", "Office"], ["emailDomain", "Email domain"]];
  static GROUP_LIMIT = 500;
  static ID = /^[A-Za-z0-9_-]{22}$/;
  // A profile's JARC access tab (P2, employee administrators only) is /admin/employees/{ds}/records/{id}/access.
  static PATH = /^\/admin\/employees(?:\/(active|all|disabled|guests)(?:\/records\/([A-Za-z0-9_-]{22})(\/access)?)?|\/groups\/(department|jobTitle|officeLocation|emailDomain))?\/?$/;
  // The administrators' "Disabled with JARC access" list: the Disabled accounts list with this one condition.
  static JARC_DISABLED_FILTER = { v: 1, op: "and", items: [{ field: "jarcDisabledWithAccess", op: "isTrue" }] };
  static ROOT = "#employees-root";
  // Actions handed to the explorer named by data-ds: its list (x), filter builder (f), column menus (c), record page (r).
  static EXPLORER_PREFIXES = ["fabric-x-", "fabric-f-", "fabric-c-", "fabric-r-"];
  static DENIED = "You don't have access to the people directory.";
  static ADMIN_ONLY = "This list is only for directory administrators.";
  static UNAVAILABLE = "The directory is temporarily unavailable.";
  static MESSAGES = {
    EMPLOYEES_FORBIDDEN: ["denied", EmployeesPanel.DENIED],
    EMPLOYEES_UNAVAILABLE: ["unavailable", `${EmployeesPanel.UNAVAILABLE} Try again in a few minutes.`],
    NOT_FOUND: ["record", "This account isn't in the directory snapshot, or isn't in this list."],
    RATE_LIMITED: ["generic", "Too many requests in a short time. Wait a few seconds, then try again."],
    VALIDATION_ERROR: ["generic", "Some filters or columns aren't valid. Change them in Filters, or clear the filters."],
    UNAUTHENTICATED: ["generic", "Your session has ended. Sign in again to continue."]
  };

  // ---- Pure helpers (also used by AppController for the address bar, and by tests)
  // What a path asks for: undefined (not a People directory path), or { view: "list", ds, recordId, query } | { view: "group", group }.
  static parsePath(pathname, search = "") {
    if (!/^\/admin\/employees(?:\/|$)/.test(pathname || "")) return undefined;
    const m = EmployeesPanel.PATH.exec(pathname);
    const query = typeof FabricExplorer === "function" ? FabricExplorer.parseQuery(search) : null;
    if (!m) return { view: "list", ds: "active", recordId: "", query: null, unknown: true };
    if (m[4]) return { view: "group", group: m[4] };
    return { view: "list", ds: m[1] || "active", recordId: m[2] || "", query, ...(m[2] && m[3] ? { tab: "access" } : {}) };
  }
  static formatPath(route) {
    const r = route || { view: "list", ds: "active" };
    if (r.view === "group" && EmployeesPanel.GROUPS.some(([f]) => f === r.group)) return { path: `${EmployeesPanel.BASE}/groups/${r.group}`, search: "" };
    const ds = EmployeesPanel.DATASET_VIEWS.includes(r.ds) ? r.ds : "active";
    const rec = r.recordId && EmployeesPanel.ID.test(r.recordId) ? `/records/${encodeURIComponent(r.recordId)}${r.tab === "access" ? "/access" : ""}` : "";
    return { path: `${EmployeesPanel.BASE}/${ds}${rec}`, search: typeof FabricExplorer === "function" && r.query ? FabricExplorer.formatQuery(r.query) : "" };
  }
  static samePath(a, b) {
    const x = EmployeesPanel.parsePath(a), y = EmployeesPanel.parsePath(b);
    return Boolean(x && y) && x.view === y.view && (x.ds ?? "") === (y.ds ?? "") && (x.group ?? "") === (y.group ?? "") && (x.recordId ?? "") === (y.recordId ?? "") && (x.tab ?? "") === (y.tab ?? "");
  }
  static groupLabel(field) { return EmployeesPanel.GROUPS.find(([f]) => f === field)?.[1] || ""; }
  // A failed request → { kind, code, message, reference, status }. Never the server's own text (it could echo a value).
  static errorInfo(error) {
    const server = error?.cause?.serverCode || null, status = error?.cause?.status;
    let code = server || error?.code || "INTERNAL_ERROR";
    if (!server && (status === 403 || code === "FORBIDDEN")) code = "EMPLOYEES_FORBIDDEN";
    if (!server && (status === 503 || code === "SERVICE_UNAVAILABLE")) code = "EMPLOYEES_UNAVAILABLE";
    if (!server && status === 404) code = "NOT_FOUND";
    const known = EmployeesPanel.MESSAGES[code];
    const kind = known?.[0] || "generic", message = known?.[1] || "The people directory didn't answer. Try again in a moment.";
    const reference = typeof error?.requestId === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(error.requestId) ? error.requestId : "";
    return { kind, code, message, reference, status: Number.isInteger(status) ? status : null };
  }
  // The record page without EmployeeProfile.js: the allow-listed values only, labelled from the schema.
  static BASIC_RECORD = {
    html(x, record, schema) {
      const ds = x.ds, back = `<a class="fx-btn" href="${x.attr(x.listHref())}" data-action="fabric-x-back" data-ds="${x.attr(ds)}" data-focus-key="record-back">${icon("left")}<span>Back to list</span></a>`;
      const s = x.record || {};
      let body;
      if (s.error) body = x.p.errorHtml(s.error, "fabric-x-retry", "", `data-ds="${x.attr(ds)}"`);
      else if (!record || typeof record.values !== "object" || !record.values) body = x.p.skeleton(2, 6);
      else {
        const fields = (schema?.fields || []).filter((f) => Object.hasOwn(record.values, f.name));
        body = `<dl class="emp-basic">${fields.map((f) => { const v = record.values[f.name]; return `<div><dt>${x.esc(x.fieldLabel(f.name))}</dt><dd>${v === null || v === undefined || v === "" ? '<span class="muted">Not recorded</span>' : x.cell(v, f.type)}</dd></div>`; }).join("")}</dl>`;
      }
      return `<div class="emp-basic-record"><div class="emp-basic-record__bar">${back}</div><h2 tabindex="-1" id="emp-basic-title-${x.attr(ds)}">Directory account</h2>${body}</div>`;
    }
  };

  constructor(controller) {
    this.c = controller;
    const profile = EmployeesPanel.profile();
    this.explorers = Object.fromEntries(EmployeesPanel.DATASET_VIEWS.map((ds) => [ds, new FabricExplorer(this, ds, {
      apiBase: EmployeesPanel.BASE, routeBase: EmployeesPanel.BASE, datasets: EmployeesPanel.DATASETS, idPattern: EmployeesPanel.ID,
      savedFiltersBase: `${EmployeesPanel.BASE}/saved-filters`, recordRenderer: profile || EmployeesPanel.BASIC_RECORD, rootSelector: EmployeesPanel.ROOT,
      errorInfo: (e) => EmployeesPanel.errorInfo(e), schemaLabels: true, dateWindow: false, // the directory has no date window
      // P2: the JARC fields (schema group "jarc", only in administrators' schemas) get their own heading in Columns and Filters.
      fieldGroups: { "": "Directory", jarc: "JARC access" }
    })]));
    this.reset();
    for (const name of ["jarc-session-expired", "jarc-access-denied", "jarc-account-pending"]) window.addEventListener?.(name, () => this.forget());
    if (typeof document !== "undefined") document.addEventListener?.("keydown", (event) => this.onKeydown(event));
  }
  static profile() { try { return typeof EmployeeProfile === "function" && typeof EmployeeProfile.html === "function" ? EmployeeProfile : null; } catch { return null; } }
  reset() {
    this.route = { view: "list", ds: "active", group: "" };
    for (const x of Object.values(this.explorers || {})) x.forget();
    try { if (typeof FabricSavedFilters === "function") for (const x of Object.values(this.explorers || {})) FabricSavedFilters.forget(x); } catch { /* not loaded */ }
    this.status = null; this.statusLoading = false; this.statusError = null;
    this.groups = {}; this.denied = false; this.forbiddenView = false; this.announced = "";
    this.access = EmployeesPanel.slot(); this.profileTab = { ds: "", id: "", tab: "" };
  }
  forget() { this.reset(); }
  static slot() { return { key: null, data: null, loading: false, error: null, seq: 0 }; }
  get view() { return this.c.view; }
  get adapter() { return this.c.model.storage?.adapter; }
  get features() { const f = this.c.model.features?.employees; return f && typeof f === "object" ? f : null; }
  get visible() { return Boolean(this.features?.view === true && this.adapter?.request); }
  get admin() { return Boolean(this.visible && this.features?.admin === true); }
  // P2: JARC access visibility (employee administrators only). /features says so (employees.jarcAccess); a status answer that
  // says otherwise wins. The server refuses the access endpoint and the JARC fields to everyone else either way.
  get jarcAccess() { return Boolean(this.admin && this.features?.jarcAccess === true && this.status?.access?.jarcAccess !== false); }
  datasetAllowed(ds) {
    if (!this.visible || !EmployeesPanel.DATASET_VIEWS.includes(ds)) return false;
    if (ds === "active") return true;
    const list = this.features?.datasets;
    return this.admin && (!Array.isArray(list) || list.includes(ds));
  }
  isDataset(ds) { return EmployeesPanel.DATASET_VIEWS.includes(ds); }
  get explorer() { return this.route.view === "list" && this.datasetAllowed(this.route.ds) ? this.explorers[this.route.ds] : null; }
  esc(v) { return this.view.escape(v ?? ""); }
  attr(v) { return this.view.attr(v); }
  // FabricExplorer reads these: no per-dataset index status here, and the status line is this panel's (no explorer banners).
  statusFor() { return null; }

  // ---- Address bar (AppController.applyBoardUrl / syncBoardUrl)
  applyRoute(r) {
    if (!r) return false;
    const before = this.routeKey();
    this.forbiddenView = false;
    if (r.view === "group") this.route = { view: "group", ds: "active", group: r.group };
    else {
      const ds = this.isDataset(r.ds) ? r.ds : "active";
      // A dataset this person may not open (a typed or shared address): the no-access state, and nothing is requested.
      if (!this.datasetAllowed(ds)) { this.forbiddenView = true; this.route = { view: "list", ds, group: "" }; }
      else {
        const x = this.explorers[ds]; if (r.query) x.applyQuery(r.query); x.openRecord(r.recordId || ""); this.route = { view: "list", ds, group: "" };
        if (x.recordId) this.profileTab = { ds, id: x.recordId, tab: r.tab === "access" ? "access" : "profile" };
      }
    }
    return before !== this.routeKey();
  }
  routeKey() { return JSON.stringify([this.route, this.forbiddenView, this.profileTab, ...Object.values(this.explorers).map((x) => x.state())]); }
  routeForUrl() {
    if (!this.visible) return { view: "list", ds: "active" };
    if (this.route.view === "group") return { view: "group", group: this.route.group };
    const ds = this.route.ds;
    if (!this.datasetAllowed(ds)) return { view: "list", ds };
    const x = this.explorers[ds];
    return { view: "list", ds, recordId: x.recordId, query: x.query, ...(this.profileTabFor(x) === "access" ? { tab: "access" } : {}) };
  }

  // ---- The profile's tabs (P2): "profile" | "access", per open profile. Without jarcAccess it is always "profile" (no tab bar,
  // and an /access address shows the profile; the address bar then drops "/access").
  profileTabFor(x) {
    if (!x?.recordId || !this.jarcAccess) return "profile";
    const t = this.profileTab;
    return t.ds === x.ds && t.id === x.recordId && t.tab === "access" ? "access" : "profile";
  }
  setProfileTab(x, tab) {
    if (!x?.recordId || !this.jarcAccess || this.explorer !== x) return;
    const next = tab === "access" ? "access" : "profile";
    if (this.profileTabFor(x) === next) return;
    this.profileTab = { ds: x.ds, id: x.recordId, tab: next };
    this.c.update();
    this.ensure();
    this.announce(next === "access" ? "JARC access" : "Profile");
  }
  accessPath(x) { return `${EmployeesPanel.BASE}/${encodeURIComponent(x.ds)}/records/${encodeURIComponent(x.recordId)}/jarc-access`; }
  // What the JARC access tab draws: { data, loading, error } for the open profile, or an empty loading state.
  accessState(x) {
    const s = this.access;
    return x?.recordId && s.key === this.accessPath(x) ? s : { data: null, loading: true, error: null };
  }
  ensureAccess({ keep = false } = {}) {
    const x = this.explorer;
    if (!x?.recordId || this.profileTabFor(x) !== "access") return;
    const path = this.accessPath(x), slot = this.access;
    if (slot.key === path && !keep) return;
    this.loadAccess(slot, path, keep && slot.key === path);
  }
  // A failed access request never closes the directory (a 403 here means only this tab is refused); it is shown in the tab.
  async loadAccess(slot, path, keep) {
    const seq = ++slot.seq;
    if (!keep) slot.data = null;
    slot.key = path; slot.loading = true; slot.error = null; this.redraw();
    try { const data = await this.adapter.request("GET", path); if (slot.seq !== seq) return; slot.data = data && typeof data === "object" && !Array.isArray(data) ? data : null; if (!slot.data) slot.error = { kind: "generic", code: "INTERNAL_ERROR", message: "The JARC access details didn't load.", reference: "", status: null }; }
    catch (error) { if (slot.seq !== seq) return; slot.data = null; slot.error = EmployeesPanel.errorInfo(error); }
    finally { if (slot.seq === seq) slot.loading = false; }
    if (this.denied) return;
    this.redraw();
    this.announce(slot.error ? "JARC access couldn't be loaded." : "JARC access loaded.");
  }
  retryAccess() { this.access.key = null; this.ensureAccess(); }
  urlFor() { return EmployeesPanel.formatPath(this.routeForUrl()); }
  syncUrl() { this.c.syncBoardUrl?.(); }

  // ---- The page: heading, status line, then the split (Objects panel + body). #employees-root holds everything, so every
  // action from inside it is this screen's (AppController routes fabric-* actions from here to this panel, never to Fabric Data).
  snapshot() {
    const x = this.explorer, g = this.route.view === "group" ? this.groups[this.route.group]?.data : null;
    const pick = [x?.recordId ? x.record?.data?.snapshot : x?.records?.data?.snapshot, g?.snapshot, this.status?.snapshot].find((s) => s && typeof s === "object");
    return pick || null;
  }
  time(iso) {
    if (typeof iso !== "string" || !iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    let text; try { text = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(d); } catch { text = d.toISOString(); }
    return `<time datetime="${this.attr(d.toISOString())}">${this.esc(`${text} UTC`)}</time>`;
  }
  subtitleHtml() {
    const s = this.snapshot(), when = s ? this.time(s.ingestedAt) : "";
    return `JARC administration · Source: Microsoft Entra ID snapshot${when ? ` · updated ${when}` : ""}`;
  }
  sectionLabel() {
    if (this.route.view === "group") return `Group by ${EmployeesPanel.groupLabel(this.route.group).toLowerCase()}`;
    if (this.isJarcDisabledView()) return "Disabled with JARC access";
    return EmployeesPanel.DATASETS[this.route.ds] || "";
  }
  html() {
    const objects = typeof EmployeesObjects === "function" && this.visible && !this.denied;
    const head = `<header class="fx-appbar emp-appbar">${objects ? this.toggleHtml() : ""}<span class="fx-appbar__icon" aria-hidden="true">${icon("people")}</span><div class="emp-appbar__heading"><h1 class="fx-appbar__title" id="employees-title" tabindex="-1">People directory</h1><p class="emp-appbar__subtitle" id="employees-subtitle">${this.subtitleHtml()}</p></div>
      ${this.visible && !this.denied ? `<span class="fx-appbar__section"><span class="fx-appbar__sep" aria-hidden="true">/</span><span id="employees-section-title">${this.esc(this.sectionLabel())}</span></span>` : ""}
      <div class="fx-appbar__chips"><span class="fx-chip fx-chip--readonly" title="Directory data is changed by IT in Microsoft Entra ID">${icon("lock")}<span>Read-only</span></span>${this.headerRefresh() ? `<button type="button" class="fx-btn fx-btn--icon" data-action="emp-refresh" data-focus-key="emp-refresh" aria-label="Refresh" title="Refresh">${icon("refresh")}</button>` : ""}</div></header>`;
    if (!this.visible || this.denied) return `<div class="fx-app emp-app emp-app--closed" id="employees-root">${head}<div class="fx-app__body" id="employees-body">${this.deniedHtml()}</div></div>`;
    this.scheduleEnsure();
    return `<div class="fx-app emp-app" id="employees-root" data-emp-view="${this.attr(this.route.view)}">${head}<div id="employees-status" class="fx-app__status">${this.statusHtml()}</div><p id="employees-live" class="sr-only" role="status" aria-live="polite">${this.esc(this.announced)}</p><div class="fx-app__split">${objects ? EmployeesObjects.html(this) : ""}<div id="employees-body" class="fx-app__body fabric-root" role="region" aria-labelledby="employees-title" data-focus-key="employees-body">${this.body()}</div></div></div>`;
  }
  // The navigation toggle (EmployeesObjects) with a list icon, so on phones it doesn't look like the shell's ≡ menu button.
  toggleHtml() { const h = EmployeesObjects.toggleHtml(this); return typeof h === "string" ? h : ""; }
  // The heading's Refresh: only where the page has no Refresh of its own (a list has one in its toolbar), i.e. the grouping
  // views and a profile; never in the no-access states.
  headerRefresh() {
    if (!this.visible || this.denied || this.forbiddenView) return false;
    if (this.route.view === "group") return true;
    return Boolean(this.explorer?.recordId);
  }
  redrawObjects() { if (typeof EmployeesObjects === "function") EmployeesObjects.redraw(this); }
  // The status line under the heading: the stale-snapshot warning (or a failed status check), nothing when all is well.
  statusHtml() {
    if (!this.visible || this.denied) return "";
    const s = this.snapshot();
    if (s?.stale === true) return `<div class="fx-status fx-status--warn emp-stale" role="status"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__text"><strong>The directory snapshot may be out of date.</strong> It couldn't be refreshed${s.checkedAt ? `; last checked ${this.time(s.checkedAt)}` : ""}. What you see is the last good copy.</span></div>`;
    if (this.statusError && this.statusError.kind !== "denied" && this.statusError.kind !== "unavailable") return `<div class="fx-status fx-status--warn" role="status"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__text">The directory status couldn't be checked: ${this.esc(this.statusError.message)}</span></div>`;
    return "";
  }
  redrawHead() {
    if (typeof document === "undefined") return;
    const sub = document.querySelector("#employees-subtitle"), sec = document.querySelector("#employees-section-title"), line = document.querySelector("#employees-status");
    if (sub) sub.innerHTML = this.subtitleHtml();
    if (sec) sec.textContent = this.sectionLabel();
    if (line) line.innerHTML = this.statusHtml();
  }
  // Redraws the body (and the heading's snapshot time and status line), keeping focus and the caret where they were.
  redraw() {
    if (typeof document === "undefined") return;
    this.redrawHead();
    const root = document.querySelector("#employees-body");
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
  announce(text) { this.announced = text; const el = typeof document !== "undefined" ? document.querySelector("#employees-live") : null; if (el) el.textContent = text; }
  body() {
    if (this.denied) return this.deniedHtml();
    // A viewer on an administrators' list (a typed or shared address): say so, and offer Active accounts. Nothing is requested.
    if (this.forbiddenView) return this.visible ? this.adminOnlyHtml() : this.deniedHtml();
    if (this.statusError?.kind === "unavailable" && !this.status) return this.unavailableHtml();
    if (this.route.view === "group") return this.groupHtml();
    const x = this.explorer;
    return x ? x.html() : this.deniedHtml();
  }

  // ---- Loading
  scheduleEnsure() { if (this.ensureQueued) return; this.ensureQueued = true; setTimeout(() => { this.ensureQueued = false; this.ensure(); }, 0); }
  ensure() {
    if (!this.visible || this.denied || this.c.model.screen !== "employees") return;
    if (!this.status && !this.statusLoading && !this.statusError) this.loadStatus();
    if (this.forbiddenView) return;
    if (this.route.view === "group") { this.ensureGroup(this.route.group); return; }
    this.explorer?.ensure();
    // A profile closed (Back, another list): its tab choice is dropped, so the next profile opens on Profile.
    if (!this.explorer?.recordId && this.profileTab.id) this.profileTab = { ds: "", id: "", tab: "" };
    this.ensureAccess();
  }
  async loadStatus() {
    if (this.statusLoading) return;
    this.statusLoading = true;
    try { this.status = await this.adapter.request("GET", `${EmployeesPanel.BASE}/status`); this.statusError = null; }
    catch (error) { this.statusError = EmployeesPanel.errorInfo(error); if (this.statusError.kind === "denied") { this.statusLoading = false; this.deny(); return; } }
    finally { this.statusLoading = false; }
    if (this.denied) return;
    this.redraw(); this.redrawObjects();
  }
  deny() { this.forget(); this.denied = true; this.redraw(); this.redrawObjects(); this.announce(EmployeesPanel.DENIED); }
  groupPath(field) { const p = new URLSearchParams({ field, limit: String(EmployeesPanel.GROUP_LIMIT) }); return `${EmployeesPanel.BASE}/active/values?${p}`; }
  ensureGroup(field, { keep = false } = {}) {
    if (!EmployeesPanel.groupLabel(field)) return;
    const slot = (this.groups[field] ||= EmployeesPanel.slot()), path = this.groupPath(field);
    if (slot.key === path && !keep) return;
    this.loadGroup(slot, path, keep);
  }
  async loadGroup(slot, path, keep) {
    const seq = ++slot.seq;
    if (!keep) slot.data = null;
    slot.key = path; slot.loading = true; slot.error = null; this.redraw();
    try { const data = await this.adapter.request("GET", path); if (slot.seq !== seq) return; slot.data = data && typeof data === "object" ? data : { values: [] }; }
    catch (error) { if (slot.seq !== seq) return; slot.error = EmployeesPanel.errorInfo(error); if (slot.error.kind === "denied") { slot.loading = false; this.deny(); return; } }
    finally { if (slot.seq === seq) slot.loading = false; }
    if (this.denied) return;
    this.redraw();
    if (slot.error) this.announce(slot.error.message);
    else this.announce(`${(slot.data.values || []).length} values`);
  }

  // ---- States (the explorer calls errorHtml and skeleton)
  skeleton(cols, rows = 6) {
    const cells = Array.from({ length: Math.max(1, cols) }, () => `<td><span class="fabric-skeleton"></span></td>`).join("");
    return `<div class="fabric-loading fx-loading" role="status" aria-busy="true"><span class="sr-only">Loading…</span><table class="fabric-table fx-loading__table" aria-hidden="true"><tbody>${Array.from({ length: rows }, () => `<tr>${cells}</tr>`).join("")}</tbody></table></div>`;
  }
  errorHtml(info, retry = "emp-retry", extra = "", attrs = "") {
    const title = { denied: "No access", forbidden: "No access", unavailable: "Directory unavailable", record: "Not found", missing: "Not found" }[info.kind] || "The people directory couldn't be loaded";
    const action = retry === "fabric-refresh" || retry === "fabric-retry" ? "emp-retry" : retry;
    const button = info.kind === "forbidden" || info.kind === "denied" ? "" : `<button type="button" class="fx-btn" data-action="${this.attr(action)}" ${attrs} data-focus-key="retry">${icon("refresh")}<span>Try again</span></button>`;
    const tone = info.kind === "record" || info.kind === "missing" ? "warn" : "error";
    return `<div class="fx-status fx-status--${tone} fx-status--block fabric-alert is-${this.attr(info.kind)}" role="alert"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__text">${EmployeesPanel.titleHtml(title)}<span class="emp-state__msg">${this.esc(info.message)}</span>${info.reference ? ` <small class="fx-status__ref">Reference <code>${this.esc(info.reference)}</code></small>` : ""}</span><span class="fx-status__actions fabric-alert-actions">${button}${extra}</span></div>`;
  }
  deniedHtml() {
    return `<div class="fx-status fx-status--error fx-status--block emp-denied" role="alert"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__text">${EmployeesPanel.titleHtml("No access")}<span class="emp-state__msg">${this.esc(EmployeesPanel.DENIED)} Ask a JARC administrator if you need it.</span></span><span class="fx-status__actions fabric-alert-actions">${this.visible && this.denied ? `<button type="button" class="fx-btn" data-action="emp-check-again">Check again</button>` : ""}<button type="button" class="fx-btn" data-action="nav" data-screen="home">Go to Home</button></span></div>`;
  }
  // A state's title on its own line, apart from its text (screen readers and innerText read them as two pieces).
  static titleHtml(title) { return `<strong class="emp-state__title">${title}</strong> `; }
  adminOnlyHtml() {
    const href = EmployeesPanel.formatPath({ view: "list", ds: "active" }).path;
    return `<div class="fx-status fx-status--warn fx-status--block emp-admin-only" role="alert"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__text">${EmployeesPanel.titleHtml("Administrators only")}<span class="emp-state__msg">${this.esc(EmployeesPanel.ADMIN_ONLY)}</span></span><span class="fx-status__actions fabric-alert-actions"><a class="fx-btn" href="${this.attr(href)}" data-action="emp-open-active" data-focus-key="emp-open-active">Open Active accounts</a></span></div>`;
  }
  unavailableHtml() {
    return `<div class="fx-status fx-status--error fx-status--block emp-unavailable" role="alert"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__text">${EmployeesPanel.titleHtml("Directory unavailable")}<span class="emp-state__msg">${this.esc(EmployeesPanel.UNAVAILABLE)} Try again in a few minutes.</span></span><span class="fx-status__actions fabric-alert-actions"><button type="button" class="fx-btn" data-action="emp-retry" data-focus-key="retry">${icon("refresh")}<span>Try again</span></button></span></div>`;
  }

  // ---- Grouping views: one value list (GET …/active/values?field=…&limit=500) with counts; blank is "Unassigned".
  groupItems(data) {
    const list = Array.isArray(data?.values) ? data.values : [];
    return list.filter((v) => v && (v.value === null || v.blank === true || typeof v.value === "string")).map((v) => ({ blank: v.value === null || v.blank === true, value: v.value === null || v.blank === true ? null : String(v.value), count: Number.isFinite(Number(v.count)) ? Number(v.count) : null }));
  }
  groupHtml() {
    const field = this.route.group, label = EmployeesPanel.groupLabel(field), slot = this.groups[field] || EmployeesPanel.slot();
    const head = `<div class="emp-group__head"><h2 class="emp-group__title" id="emp-group-title" tabindex="-1">Active accounts by ${this.esc(label.toLowerCase())}</h2><p class="fabric-help">Choose a value to see those accounts. “Unassigned” means the directory has no ${this.esc(label.toLowerCase())} for them.</p></div>`;
    if (slot.error) return head + this.errorHtml(slot.error, "emp-group-retry", "", `data-group="${this.attr(field)}"`);
    if (!slot.data) return head + this.skeleton(2, 8);
    const items = this.groupItems(slot.data);
    if (!items.length) return `${head}<div class="quiet-empty fabric-empty">${icon("search")}<span><strong>No values</strong><small>No active accounts to group.</small></span></div>`;
    const total = items.reduce((n, i) => n + (i.count || 0), 0);
    const rows = items.map((i) => {
      const href = this.groupHref(field, i);
      const name = i.blank ? `<span class="emp-group__unassigned">Unassigned</span>` : this.esc(i.value);
      const aria = `${i.blank ? "Unassigned" : i.value}${i.count === null ? "" : `, ${i.count} accounts`}`;
      return `<tr><th scope="row"><a class="fx-link fabric-link" href="${this.attr(href)}" data-action="emp-group-open" data-group="${this.attr(field)}" data-blank="${i.blank}" data-value="${this.attr(i.value ?? "")}" aria-label="${this.attr(aria)}">${name}</a></th><td class="fx-grid__num fabric-num">${i.count === null ? "—" : this.esc(i.count.toLocaleString())}</td></tr>`;
    }).join("");
    const limited = slot.data.complete === false || items.length >= EmployeesPanel.GROUP_LIMIT ? `<p class="fabric-help">Showing the first ${EmployeesPanel.GROUP_LIMIT} values.</p>` : "";
    return `${head}<div class="fx-grid emp-group" tabindex="0" data-focus-key="results" role="region" aria-labelledby="emp-group-title"><table class="fx-grid__table emp-group__table"><caption class="sr-only">${this.esc(label)} values with the number of active accounts</caption><thead><tr><th scope="col">${this.esc(label)}</th><th scope="col" class="fx-grid__num fabric-num">Accounts</th></tr></thead><tbody>${rows}</tbody></table></div><p class="fabric-help emp-group__total">${this.esc(items.length.toLocaleString())} values · ${this.esc(total.toLocaleString())} accounts</p>${limited}`;
  }
  groupModel(field, blank, value) {
    const M = typeof FabricFilterModel === "function" ? FabricFilterModel : null;
    const model = { v: 1, op: "and", items: [blank ? { field, op: "blank" } : { field, op: "eq", value }] };
    return M ? M.canonical(model) : model;
  }
  groupHref(field, i) {
    const q = { ...FabricExplorer.emptyQuery(), filter: this.groupModel(field, i.blank, i.value) };
    const u = EmployeesPanel.formatPath({ view: "list", ds: "active", query: q });
    return `${u.path}${u.search}`;
  }
  openGroupValue(field, blank, value) {
    if (!EmployeesPanel.groupLabel(field) || (!blank && (typeof value !== "string" || !value || value.length > 200))) return;
    const x = this.explorers.active;
    try { if (typeof FabricSavedFilters === "function") FabricSavedFilters.clearCurrent(x); } catch { /* not loaded */ }
    x.applyQuery({ ...FabricExplorer.emptyQuery(), limit: x.query.limit, orderBy: x.query.orderBy, filter: this.groupModel(field, blank, value) });
    x.openRecord("");
    this.route = { view: "list", ds: "active", group: "" };
    this.c.update();
    this.focus("[data-focus-key='results'], h2");
  }

  // ---- Navigation
  openDataset(ds, { clear = false, focus = true } = {}) {
    if (!this.datasetAllowed(ds)) return;
    const x = this.explorers[ds];
    if (clear) { try { if (typeof FabricSavedFilters === "function") FabricSavedFilters.clearCurrent(x); } catch { /* not loaded */ } x.applyQuery({ ...FabricExplorer.emptyQuery() }); }
    x.openRecord("");
    this.forbiddenView = false; this.route = { view: "list", ds, group: "" };
    this.c.update();
    if (focus) this.focus("[data-focus-key='results'], h2");
  }
  // P2 (employee administrators with jarcAccess): "Disabled with JARC access" = the Disabled accounts list filtered on
  // jarcDisabledWithAccess is true, through the explorer's ordinary filter (so chips, Clear filters, saved filters and the
  // address work as for any filter). Its query, address and whether it is the list shown now:
  jarcDisabledQuery() {
    const M = typeof FabricFilterModel === "function" ? FabricFilterModel : null, model = JSON.parse(JSON.stringify(EmployeesPanel.JARC_DISABLED_FILTER));
    return { ...FabricExplorer.emptyQuery(), filter: M ? M.canonical(model) : model };
  }
  jarcDisabledAvailable() { return this.jarcAccess && this.datasetAllowed("disabled"); }
  jarcDisabledHref() { const u = EmployeesPanel.formatPath({ view: "list", ds: "disabled", query: this.jarcDisabledQuery() }); return `${u.path}${u.search}`; }
  isJarcDisabledView() {
    if (!this.jarcDisabledAvailable() || this.route.view !== "list" || this.route.ds !== "disabled" || this.forbiddenView) return false;
    const x = this.explorers.disabled, q = x.query, want = this.jarcDisabledQuery();
    return !q.q && FabricExplorer.formatQuery({ ...want, limit: q.limit, orderBy: q.orderBy, sort: q.sort, dir: q.dir }) === FabricExplorer.formatQuery(q);
  }
  openJarcDisabled({ focus = true } = {}) {
    if (!this.jarcDisabledAvailable()) return;
    const x = this.explorers.disabled;
    try { if (typeof FabricSavedFilters === "function") FabricSavedFilters.clearCurrent(x); } catch { /* not loaded */ }
    x.applyQuery({ ...this.jarcDisabledQuery(), limit: x.query.limit, orderBy: x.query.orderBy });
    x.openRecord("");
    this.forbiddenView = false; this.route = { view: "list", ds: "disabled", group: "" };
    this.c.update();
    if (focus) this.focus("[data-focus-key='results'], h2");
  }
  openGroup(field, { focus = true } = {}) {
    if (!EmployeesPanel.groupLabel(field)) return;
    this.forbiddenView = false; this.route = { view: "group", ds: "active", group: field };
    this.c.update();
    if (focus) this.focus("#emp-group-title");
  }
  // Focus the first match inside the body; when nothing matches yet (the list is still loading), the page heading.
  focus(selector) {
    if (typeof document === "undefined") return;
    const el = document.querySelector(`#employees-body ${selector.split(",").join(", #employees-body ")}`) || document.querySelector("#employees-title");
    el?.focus?.({ preventScroll: true });
  }
  refresh() {
    this.status = null; this.statusError = null;
    if (this.route.view === "group") { this.ensureGroup(this.route.group, { keep: true }); this.loadStatus(); return; }
    this.explorer?.refresh();
    this.ensureAccess({ keep: true });
    this.loadStatus().then(() => this.ensure());
  }
  retry() {
    if (this.statusError) { this.statusError = null; this.status = null; }
    for (const g of Object.values(this.groups)) if (g.error) g.key = null;
    if (this.access.error) this.access.key = null;
    this.explorer?.retry();
    this.c.update();
  }

  // ---- Events (AppController hands every emp-* action, and fabric-* actions from inside #employees-root, here)
  explorerFor(target) { const ds = target?.dataset?.ds; return this.isDataset(ds) && this.datasetAllowed(ds) ? this.explorers[ds] : null; }
  static owns(target) { return Boolean(target?.closest?.(EmployeesPanel.ROOT)); }
  onAction(action, target, event) {
    const plain = !event || (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && (event.button === undefined || event.button === 0));
    if (target.tagName === "A" && !plain) return;
    if (target.tagName === "A" && !action.startsWith("emp-p-")) event?.preventDefault?.();
    if (action.startsWith("emp-p-")) { const P = EmployeesPanel.profile(), x = this.explorer; if (P && x && typeof P.onAction === "function") P.onAction(x, action, target, event); return; }
    if (action.startsWith("emp-o-")) { if (typeof EmployeesObjects === "function") EmployeesObjects.onAction(this, action, target, event); return; }
    if (action.startsWith("fabric-s-")) { this.savedFilterAction(action, target, event); return; }
    if (EmployeesPanel.EXPLORER_PREFIXES.some((p) => action.startsWith(p))) { this.explorerFor(target)?.onAction(action, target, event); return; }
    if (action === "emp-refresh" || action === "fabric-refresh") { this.refresh(); return; }
    if (action === "emp-retry" || action === "fabric-retry") { this.retry(); return; }
    if (action === "emp-open-active") { this.openDataset("active"); return; }
    if (action === "emp-check-again") { this.denied = false; this.status = null; this.statusError = null; this.c.update(); return; }
    if (action === "emp-group-retry") { const g = this.groups[target.dataset.group]; if (g) g.key = null; this.ensure(); return; }
    if (action === "emp-group-open") { this.openGroupValue(target.dataset.group, target.dataset.blank === "true", target.dataset.value ?? ""); }
  }
  savedFilterAction(action, target, event) {
    const x = this.explorerFor(target);
    if (!x) return;
    const objects = typeof EmployeesObjects === "function" && Boolean(target.closest?.("#employees-objects"));
    if (objects) {
      EmployeesObjects.afterChoice(this, `saved-${target.dataset.id || ""}`);
      if (this.route.view !== "list" || this.route.ds !== x.ds || x.recordId) { this.route = { view: "list", ds: x.ds, group: "" }; x.openRecord(""); }
    }
    x.onAction(action, target, event);
    if (objects) { this.c.update(); EmployeesObjects.focusAfterChoice(this, `saved-${target.dataset.id || ""}`); }
  }
  explorerAction(action) { return typeof action === "string" && (EmployeesPanel.EXPLORER_PREFIXES.some((p) => action.startsWith(p)) || action.startsWith("fabric-s-")); }
  onInput(target, event) { if (this.explorerAction(target.dataset?.action)) this.explorerFor(target)?.onInput(target, event); }
  onChange(target) { if (this.explorerAction(target.dataset?.action)) this.explorerFor(target)?.onChange(target); }
  onSubmit(action, form) {
    if (action === "fabric-x-form") { this.explorerFor(form)?.onSubmit(); return; }
    if (this.explorerAction(action)) this.explorerFor(form)?.onSubmit(action, form);
  }
  // Keys inside the Objects panel go to it (tree keys, the drawer's Escape and focus trap); other keys inside the body go to the
  // open explorer (its builder, grid and the profile page: Escape goes back to the list).
  onKeydown(event) {
    if (this.c.model?.screen !== "employees" || !this.visible) return;
    const t = event.target;
    if (typeof EmployeesObjects === "function" && t?.closest?.("#employees-objects") && EmployeesObjects.onKeydown(this, event)) return;
    if (t?.closest?.("#employees-body")) this.explorer?.onKeydown?.(event);
  }
}
if (typeof window !== "undefined") window.EmployeesPanel = EmployeesPanel;
