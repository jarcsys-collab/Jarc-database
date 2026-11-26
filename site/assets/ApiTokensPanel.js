// Developer Center (profile menu → Developer): API tokens, the API Explorer, a Boards & Columns directory, documentation and token
// activity, plus the API Information panels in the board and column menus. The server enforces every rule
// (services/api-token-service.js); this only shows what it reports.
//
// Board and column API IDs are the IDs JARC already stores (a board's ID, a column's key), so every employee sees the same ones and
// nothing is generated or stored here. They are identifiers, not credentials: every request also needs a token that covers the board.
// A new token exists here only as text in the one dialog that reveals it: it is never put in browser storage or the model, never in
// an address or an example, and it is gone when that dialog closes. Everything else is read with the person's own session.
class ApiTokensPanel {
  static STATUS = { active: ["Active", "ok"], rotating: ["Being replaced", "warn"], expired: ["Expired", "muted"], revoked: ["Revoked", "muted"], no_access: ["No access", "danger"] };
  static GRACE = [[0, "End it immediately"], [1, "Keep working for 1 hour"], [24, "Keep working for 24 hours"], [168, "Keep working for 7 days"]];
  static CODES = { API_ADMIN_REQUIRED: "Only JARC API administrators can manage API tokens.", FORBIDDEN: "You need access to this workspace to create its tokens. Ask a workspace admin to add you to its members.", TOKEN_LIMIT_REACHED: "You've reached the limit of 25 active tokens. Revoke one you no longer need.", TOKEN_ALREADY_ROTATED: "This token was already rotated. Rotate its replacement instead.", TOKEN_NOT_ACTIVE: "This token has ended. Create a new one instead.", TOKEN_NO_BOARDS: "None of this token's boards are available any more. Create a new token instead.", RATE_LIMITED: "Too many new tokens in the last hour. Try again later." };
  static SECTIONS = [["overview", "Overview", "home"], ["tokens", "API Keys", "lock"], ["explorer", "API Explorer", "search"], ["directory", "Boards & Columns", "board"], ["docs", "Documentation", "records"], ["activity", "API Activity", "refresh"]];
  // Events that are part of a key's normal life, and events about a request that was refused (the Activity outcome filter).
  static FAILURES = new Set(["token.auth_failed", "token.use_refused", "token.rate_limited"]);
  // Only for the JARC API administrators (the server enforces it; this only hides what would be refused).
  static ADMIN_SECTIONS = new Set(["tokens", "explorer", "activity"]);
  // Administration (P3): JARC administration pages launched from the Developer Center, each shown only to the people who may
  // open it today (no new permission): System Health with SystemHealthPanel.visible (resource mode and a JARC administrator,
  // auth.isSystemAdmin; the server's access.requireSystemAdmin decides), the People directory with /features employees.view
  // (EmployeesPanel.visible; the server's employee lists decide). They are links to the existing pages, not sections of this
  // window: choosing one closes it and opens the page (the People directory in its app-module layout, AppModules.js).
  static ADMIN_LINKS = [["system-health", "System Health", "refresh", "Server, database and integration status, and the audit history."], ["employees", "People directory", "people", "The employee directory from Microsoft Entra ID, read-only."]];
  // The longest a token may last, in calendar years from its creation (services/api-token-service.js, the same rule).
  static MAX_YEARS = 5;
  static EVENTS = { "token.created": "Created", "token.rotated": "Rotated", "token.revoked": "Revoked", "token.auth_failed": "Wrong secret", "token.use_refused": "Request refused", "token.rate_limited": "Rate limited" };
  // [id, label, path after /boards/:boardId, which columns it takes, whether it is paged]
  static OPERATIONS = [["records", "List records", "/records", "many", true], ["values", "One column's values", "/columns/{column}/values", "one", true], ["column", "One column", "/columns/{column}", "one", false], ["columns", "All columns", "/columns", "none", false], ["groups", "Groups", "/groups", "none", false], ["board", "Board, with columns and groups", "", "none", false], ["record", "One record, by Record ID", "", "record", false]];
  static PAGE_MAX = 500;
  static PAGE_DEFAULT = 100;

  constructor(controller) {
    this.c = controller; this.items = null; this.options = null; this.loading = false; this.error = ""; this.tab = "overview"; this.secret = null; this.pending = null;
    this.resetCatalog();
    this.ex = { workspaceId: "", boardId: "", data: null, error: "", selected: new Set(), column: "", op: "records", params: { limit: "", groupId: "", includeArchived: false, updatedSince: "" }, record: "", preview: null, previewBusy: false, previewError: "", preset: null };
    this.dir = { workspaceId: "", boardId: "", boardQuery: "", columnQuery: "" };
    // API Keys and API Activity filters (kept while the Developer Center is open, cleared when it opens again).
    this.resetFilters();
  }
  resetFilters() {
    this.filters = { q: "", owner: "", status: "", workspace: "", board: "" };
    this.actFilters = { token: "", owner: "", workspace: "", board: "", type: "", outcome: "", from: "", to: "" };
  }
  get view() { return this.c.view; }
  get adapter() { return this.c.model.storage?.adapter; }
  visible() { return Boolean(this.c.model.features?.apiTokens && this.adapter?.request); }
  // A JARC API administrator (the server says so in /features, for this signed-in person).
  admin() { return Boolean(this.visible() && this.c.model.features?.apiTokenAdmin); }
  // The API sections only when API tokens are on (visible), exactly as before; someone with only administration pages gets none.
  sections() { return this.visible() ? ApiTokensPanel.SECTIONS.filter(([id]) => this.admin() || !ApiTokensPanel.ADMIN_SECTIONS.has(id)) : []; }
  // The Administration entries this person may open (decided from the session and /features, which are known before anything
  // is drawn: never shown first and removed later).
  adminLinks() { return ApiTokensPanel.ADMIN_LINKS.filter(([id]) => (id === "system-health" ? Boolean(this.c.health?.visible) : Boolean(this.c.employees?.visible))); }
  // The Developer entry (profile menu): anyone with an API section or an Administration entry; hidden for everyone else.
  developerVisible() { return this.visible() || this.adminLinks().length > 0; }
  // Where the window opens when no section was asked for: Overview with API access, else the Administration list.
  homeTab() { return this.visible() ? "overview" : "admin"; }
  allowed(section) { return section === "admin" ? !this.visible() && this.adminLinks().length > 0 : this.sections().some(([id]) => id === section); }
  esc(v) { return this.view.escape(v ?? ""); }
  api(method, path, body) { return this.adapter.request(method, `/me/api-tokens${path}`, body); }
  date(iso, fallback = "Never") { if (!iso) return fallback; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : this.esc(d.toLocaleDateString(undefined, { dateStyle: "medium" })); }
  dateTime(iso) { if (!iso) return "Never"; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : this.esc(d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })); }
  message(error) { return ApiTokensPanel.CODES[error?.code] || (typeof StorageError !== "undefined" ? StorageError.describe(error) : error)?.message || "That didn't work."; }
  typeLabel(type) { return this.c.model.columnType?.(type)?.label || type; }
  withArchived(item) { return `${item.name}${item.archived ? " (archived)" : ""}`; }

  // ---- The Developer Center window. It reuses the Settings window's layout, so it behaves the same on desktop and mobile.
  // fresh: read tokens, workspaces and boards again (opening it from the app). Returning from one of its own dialogs keeps them.
  open(section = this.tab, { fresh = true } = {}) {
    if (fresh) { this.resetCatalog(); this.resetFilters(); this.items = null; this.events = null; this.error = ""; this.ex.data = null; this.ex.workspaceId = ""; this.ex.tokenId = ""; }
    this.tab = this.allowed(section) ? section : this.homeTab();
    const tab = ([id, label, ic]) => `<button type="button" data-action="apitok-tab" data-tab="${id}" class="${id === this.tab ? "active" : ""}" ${id === this.tab ? 'aria-current="page"' : ""} title="${label}">${icon(ic)}<span>${label}</span></button>`;
    const admin = this.adminLinks(), screen = this.c.model?.screen;
    // Without API access the Administration list is this window's only page: it is the first entry and opens selected.
    const adminNav = admin.length ? `${this.visible() ? '<div class="apitok-nav-sep" role="separator"></div>' : tab(["admin", "Administration", "settings"])}<p class="apitok-nav-caption" aria-hidden="true">Administration</p>${admin.map(([id, label, ic]) => `<button type="button" class="apitok-nav-admin${screen === id ? " is-current" : ""}" data-action="apitok-admin" data-target="${id}" title="${label}" aria-label="${label} (opens the page)">${icon(ic)}<span>${label}</span></button>`).join("")}` : "";
    const nav = this.sections().map(tab).join("") + adminNav;
    this.view.overlay(`<div class="settings-window developer-window" role="dialog" aria-modal="true" aria-labelledby="apitok-title"><nav class="settings-nav" aria-label="Developer sections"><div class="settings-brand"><span class="brand-mark">J</span><strong>Developer</strong></div>${nav}</nav><section class="settings-content"><div class="modal-head"><h2 id="apitok-title">${this.sectionTitle()}</h2>${this.view.closeButton()}</div><div class="settings-body"><div id="apitok-root" class="apitok">${this.body()}</div></div></section></div>`, "settings-overlay developer-overlay");
    this.c.markPanel?.("developer");
  }
  sectionTitle() { return this.tab === "admin" ? "Administration" : ApiTokensPanel.SECTIONS.find(([id]) => id === this.tab)?.[1] || "Developer"; }
  redraw() {
    const root = document.querySelector("#apitok-root");
    if (!root) return;
    root.innerHTML = this.body();
    const title = document.querySelector("#apitok-title"); if (title) title.textContent = this.sectionTitle();
    document.querySelectorAll('.developer-window .settings-nav [data-action="apitok-tab"]').forEach((b) => { const on = b.dataset.tab === this.tab; b.classList.toggle("active", on); if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  }
  body() {
    if (!this.allowed(this.tab)) this.tab = this.homeTab();
    if (this.tab === "admin") return this.adminHtml();
    // The Explorer can use a key as its scope reference, so administrators load the key list there too.
    if (this.tab === "explorer") { if (this.admin() && !this.items && !this.loading && !this.error) setTimeout(() => this.load(), 0); return this.explorerHtml(); }
    if (this.tab === "directory") return this.directoryHtml();
    if (this.tab === "docs") return ApiTokenDocs.html((v) => this.esc(v), window.location.origin);
    // Everyone else: the overview, with nothing to load (the token routes would refuse them).
    if (!this.admin()) return this.employeeOverviewHtml();
    if (!this.items && !this.loading && !this.error) setTimeout(() => this.load(), 0);
    if (this.tab === "activity") return this.activityHtml();
    if (this.tab === "tokens") return this.tokensHtml();
    return this.overviewHtml();
  }
  async load() {
    if (this.loading) return;
    this.loading = true;
    try { const [list, options, activity] = await Promise.all([this.api("GET", ""), this.api("GET", "/options"), this.api("GET", "/activity")]); this.items = list.items; this.options = ApiTokensPanel.unique(options.workspaces); this.limits = options.limits || this.limits; this.events = activity.items || []; this.error = ""; }
    catch (error) { this.error = this.message(error); }
    finally { this.loading = false; this.redraw(); }
  }
  loadState() {
    if (this.error && !this.items) return `<p class="account-empty" role="alert">${this.esc(this.error)}</p><button type="button" class="button secondary" data-action="apitok-refresh">Try again</button>`;
    if (!this.items) return `<p class="account-empty" aria-busy="true">Loading tokens…</p>`;
    return "";
  }
  canCreate() { return Boolean(this.options?.some((w) => w.boards.length)); }
  blockedHtml() { return this.canCreate() ? "" : `<div class="account-alert is-warn" role="status"><strong>You can't create a token yet.</strong><span>You need access to a workspace with at least one board: shared workspaces, or your own membership of a workspace. Ask a workspace admin to add you to its members.</span></div>`; }

  // ---- Overview
  // For everyone who isn't a JARC API administrator: what the API is, and where the IDs are. Tokens come from an administrator.
  // Administration, for someone without API access: the pages they may open (nothing to load).
  adminHtml() {
    const items = this.adminLinks().map(([id, label, ic, text]) => `<li class="apitok-step apitok-admin-item"><span class="apitok-admin-icon" aria-hidden="true">${icon(ic)}</span><div><strong>${label}</strong><p>${text}</p><button type="button" class="button secondary" data-action="apitok-admin" data-target="${id}">Open ${label}</button></div></li>`).join("");
    return `<div class="apitok-overview"><p class="apitok-lead">JARC administration pages you can open.</p><ul class="apitok-steps apitok-admin-list">${items}</ul></div>`;
  }
  // An Administration entry: the window closes, then the page opens as from the main navigation (the People directory as an app
  // module, which remembers the workspace and board open now for "Back to …"). Developer is not reopened on the way back.
  openAdmin(id) {
    if (!this.adminLinks().some(([x]) => x === id)) return;
    const c = this.c;
    this.view.closeOverlay();
    const mod = typeof AppModules === "function" ? AppModules.forScreen(id) : null;
    if (mod && typeof c.enterModule === "function") c.enterModule(mod.id); else c.model.openScreen(id);
    c.update();
    // Focus goes to the page's heading (the opener was in the closed window).
    requestAnimationFrame(() => { const h = document.querySelector(id === "employees" ? "#employees-title" : ".workspace .page-head h1"); if (!h) return; if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); });
  }
  employeeOverviewHtml() {
    const step = (n, title, text, tab, button) => `<li class="apitok-step"><span class="apitok-step-n" aria-hidden="true">${n}</span><div><strong>${title}</strong><p>${text}</p><button type="button" class="button secondary" data-action="apitok-tab" data-tab="${tab}">${button}</button></div></li>`;
    return `<div class="apitok-overview"><p class="apitok-lead">Other systems such as Power BI, Power Automate and n8n can read JARC boards through a read-only REST API.</p>
      <div class="account-alert is-ok" role="status"><strong>API tokens are issued by JARC API administrators.</strong><span>If an integration needs access to boards, ask one of them for a token. You keep your usual access to every shared board.</span></div>
      <ol class="apitok-steps">${step(1, "Find the board or column", "Every board and column already has a permanent API ID and address, the same for everyone in the company.", "directory", "Boards & Columns")}${step(2, "Read how it works", "Endpoints, filters, paging and error codes.", "docs", "Documentation")}</ol>
      <dl class="apitok-facts"><div><dt>Base URL</dt><dd><code>${this.esc(this.endpoint(""))}</code></dd></div><div><dt>Format</dt><dd>JSON over HTTPS, read-only</dd></div></dl></div>`;
  }
  // Live keys: active, or being replaced (the old one still works for its overlap).
  static live(t) { return t.status === "active" || t.status === "rotating"; }
  overviewHtml() {
    const items = this.items || [];
    const live = items.filter(ApiTokensPanel.live);
    const boards = new Set(live.flatMap((t) => t.boards.filter((b) => b.available !== false).map((b) => b.id)));
    const spaces = new Set(live.flatMap((t) => (t.workspaces || [t.workspace]).filter((w) => w.available !== false && w.name).map((w) => w.id)));
    const stat = (label, value, tone = "") => `<div class="${tone}"><span>${label}</span><strong>${value}</strong></div>`;
    const create = this.canCreate() ? `<button type="button" class="button primary apikey-cta" data-action="apitok-new">${icon("plus")}<span>Create API key</span></button>` : "";
    const status = !this.items ? this.loadState() : `<div class="apitok-stats apikey-stats">${stat("Active keys", live.length)}${stat("Expired keys", items.filter((t) => t.status === "expired").length)}${stat("Revoked keys", items.filter((t) => t.status === "revoked").length)}${stat("Authorized boards", boards.size)}${stat("Workspaces covered", spaces.size)}</div>${this.blockedHtml()}`;
    const step = (n, title, text) => `<li class="apitok-step"><span class="apitok-step-n" aria-hidden="true">${n}</span><div><strong>${title}</strong><p>${text}</p></div></li>`;
    const recent = (this.events || []).slice(0, 5);
    const recentHtml = !this.items ? "" : `<section class="apikey-recent" aria-labelledby="apikey-recent-title"><div class="apikey-section-head"><h3 id="apikey-recent-title">Recent API activity</h3><button type="button" class="button secondary small" data-action="apitok-tab" data-tab="activity">All activity</button></div>${recent.length ? `<ul class="apikey-recent-list">${recent.map((e) => `<li><span class="account-badge is-${ApiTokensPanel.FAILURES.has(e.action) ? "warn" : "ok"}">${this.esc(ApiTokensPanel.EVENTS[e.action] || e.action)}</span><strong>${this.esc(e.token?.name || "Unknown key")}</strong><small>${this.dateTime(e.at)}${e.actor?.name ? ` · ${this.esc(e.actor.name)}` : ""}</small></li>`).join("")}</ul>` : `<p class="account-empty">No API activity yet.</p>`}</section>`;
    return `<div class="apitok-overview"><div class="apikey-hero"><p class="apitok-lead">Read JARC boards from Power BI, Power Automate, n8n, Excel or your own scripts, through a read-only REST API. One API key can cover boards from several workspaces.</p>${create}</div>
      ${status}
      <h3>Getting started</h3>
      <ol class="apitok-steps apikey-start">${step(1, "Create an API key", "Give it a name and an expiry date. Keys are always read-only.")}${step(2, "Select boards", "Pick boards from any shared workspace. Only the boards you select are readable.")}${step(3, "Copy the secret and endpoints", "The secret is shown once. Every board's endpoints are listed with copy buttons.")}${step(4, "Connect the external application", "Send the key in the Authorization header from Power BI, Power Automate, n8n or a script.")}</ol>
      ${recentHtml}
      <dl class="apitok-facts"><div><dt>Base URL</dt><dd><code>${this.esc(this.endpoint(""))}</code></dd></div><div><dt>Authentication</dt><dd><code>Authorization: Bearer YOUR_JARC_API_TOKEN</code></dd></div><div><dt>Format</dt><dd>JSON over HTTPS, read-only</dd></div></dl>
      <p class="account-note">IDs aren't secrets and knowing one grants nothing. Each request is checked against the key's boards and its owner's current access.</p></div>`;
  }

  // ---- API Tokens
  // ---- API Keys: one card per key, with filters that redraw only the list (the filter controls keep focus).
  tokensHtml() {
    const state = this.loadState();
    if (state) return state;
    const canCreate = this.canCreate();
    const intro = `<div class="apitok-intro"><p>Every JARC API key, whoever created it. Keys are read-only, read only the boards chosen for them (from one or several workspaces) and never see more than their owner can. Any API administrator can revoke any key.</p>${canCreate ? `<button type="button" class="button primary" data-action="apitok-new">${icon("plus")}<span>Create API key</span></button>` : ""}</div>`;
    const auth = `<div class="apitok-auth"><strong>How to authenticate</strong><p>Send the key in a header with every request. Never put it in the address, a web page or a shared file.</p><code>Authorization: Bearer YOUR_JARC_API_TOKEN</code></div>`;
    if (!this.items.length) return `${intro}${this.blockedHtml()}<p class="account-empty">No API keys yet.</p>${auth}`;
    return `${intro}${this.blockedHtml()}${this.keyFiltersHtml()}<p class="apikey-results" id="apikey-results" role="status" aria-live="polite">${this.keyResultsText()}</p><div class="apikey-list" id="apikey-list">${this.keyCardsHtml()}</div>${auth}`;
  }
  ownerName(t) { return t.mine ? "You" : t.owner?.name || "A former user"; }
  keyWorkspaces(t) { return t.workspaces || [t.workspace]; }
  // Distinct values for the filter menus, from the keys themselves.
  static distinct(pairs) { const seen = new Map(); for (const [id, name] of pairs) if (id && !seen.has(id)) seen.set(id, name); return [...seen].sort((a, b) => String(a[1]).localeCompare(String(b[1]))); }
  filterSelect(kind, name, label, choices, current) { return `<label>${label}<select data-action="${kind}" data-filter="${name}"><option value="">All</option>${choices.map(([v, l]) => `<option value="${this.esc(v)}" ${v === current ? "selected" : ""}>${this.esc(l)}</option>`).join("")}</select></label>`; }
  keyFiltersHtml() {
    const f = this.filters, items = this.items;
    const owners = ApiTokensPanel.distinct(items.map((t) => [t.owner?.id, this.ownerName(t)]));
    const spaces = ApiTokensPanel.distinct(items.flatMap((t) => this.keyWorkspaces(t).filter((w) => w.name).map((w) => [w.id, w.name])));
    const statuses = [["active", "Active"], ["rotating", "Being replaced"], ["expired", "Expired"], ["revoked", "Revoked"], ["no_access", "No access"]];
    return `<div class="apikey-toolbar" role="search" aria-label="Filter API keys"><label class="apikey-grow">Search<input type="search" data-action="apitok-filter" data-filter="q" value="${this.esc(f.q)}" placeholder="Key name or prefix" autocomplete="off"></label>${this.filterSelect("apitok-filter", "owner", "Owner", owners, f.owner)}${this.filterSelect("apitok-filter", "status", "Status", statuses, f.status)}${this.filterSelect("apitok-filter", "workspace", "Workspace", spaces, f.workspace)}<label>Board<input type="search" data-action="apitok-filter" data-filter="board" value="${this.esc(f.board)}" placeholder="Board name or ID" autocomplete="off"></label></div>`;
  }
  filteredKeys() {
    const f = this.filters;
    return this.items.filter((t) => (!f.q || this.matches(t.name, f.q) || this.matches(t.prefix, f.q) || this.matches(t.description, f.q))
      && (!f.owner || t.owner?.id === f.owner) && (!f.status || t.status === f.status)
      && (!f.workspace || this.keyWorkspaces(t).some((w) => w.id === f.workspace))
      && (!f.board || t.boards.some((b) => this.matches(b.name, f.board) || b.id === f.board.trim().toLowerCase())));
  }
  keyResultsText() { const shown = this.filteredKeys().length, all = this.items.length; return shown === all ? `${all} key${all === 1 ? "" : "s"}` : `${shown} of ${all} keys`; }
  keyCardsHtml() {
    const keys = this.filteredKeys();
    return keys.length ? keys.map((t) => this.card(t)).join("") : `<p class="account-empty">No keys match these filters.</p>`;
  }
  redrawKeys() {
    const list = document.querySelector("#apikey-list"), count = document.querySelector("#apikey-results");
    if (list) list.innerHTML = this.keyCardsHtml();
    if (count) count.textContent = this.keyResultsText();
  }
  card(t) {
    const [label, tone] = ApiTokensPanel.STATUS[t.status] || ["Unknown", "muted"];
    const spaces = this.keyWorkspaces(t), named = spaces.filter((w) => w.name).map((w) => w.name);
    const live = t.status === "active" || t.status === "rotating" || t.status === "no_access";
    const id = this.esc(t.id), btn = (action, text, extra = "") => `<button type="button" class="button secondary small ${extra}" data-action="${action}" data-id="${id}">${text}</button>`;
    const actions = `${btn("apitok-details", "Connection details")}${btn("apitok-key-explorer", "API Explorer")}${btn("apitok-key-activity", "Activity")}${t.status === "active" && t.canRotate ? btn("apitok-rotate", "Rotate") : ""}${live ? btn("apitok-revoke", "Revoke", "danger-text") : ""}`;
    const revoked = t.status === "revoked" && t.revokedBy?.name ? ` <small>by ${this.esc(t.revokedBy.name)}</small>` : "";
    const meta = (term, value) => `<div data-meta="${term}"><dt>${term}</dt><dd>${value}</dd></div>`;
    return `<article class="apikey-card" data-id="${id}" aria-labelledby="apikey-name-${id}">
      <header class="apikey-card-head"><div class="apikey-card-title"><h3 id="apikey-name-${id}">${this.esc(t.name)}</h3><code>${this.esc(t.prefix)}…</code></div><span class="apikey-status"><span class="account-badge is-${tone}">${label}</span>${revoked}</span></header>
      ${t.description ? `<p class="apikey-desc">${this.esc(t.description)}</p>` : ""}
      <dl class="apikey-meta">${meta("Owner", this.esc(this.ownerName(t)))}${meta("Boards", `${t.boards.length}`)}${meta(`Workspace${spaces.length === 1 ? "" : "s"}`, `${spaces.length}${named.length ? ` <small>${this.esc(named.join(", "))}</small>` : ""}`)}${meta("Created", this.date(t.createdAt))}${meta("Expires", t.status === "revoked" ? "—" : this.date(t.expiresAt))}${meta("Last used", this.dateTime(t.lastUsedAt))}${meta("Requests", Number(t.requestCount || 0).toLocaleString())}${meta("Permissions", "Read-only")}</dl>
      <div class="apikey-card-actions">${actions}</div></article>`;
  }

  // ---- API Activity: what the server already records for each token (last use, a request count, status). No request log is shown.
  activityHtml() {
    const state = this.loadState();
    if (state) return state;
    if (!this.items.length) return `<p>Activity appears here once there is an API key.</p><button type="button" class="button secondary" data-action="apitok-tab" data-tab="tokens">API Keys</button>`;
    const time = (t) => (t.lastUsedAt ? new Date(t.lastUsedAt).getTime() : 0);
    const rows = [...this.items].sort((a, b) => time(b) - time(a)).map((t) => { const [label, tone] = ApiTokensPanel.STATUS[t.status] || ["Unknown", "muted"]; return `<tr><td data-label="Key"><strong>${this.esc(t.name)}</strong><small><code>${this.esc(t.prefix)}…</code></small></td><td data-label="Owner">${this.esc(this.ownerName(t))}</td><td data-label="Status"><span class="account-badge is-${tone}">${label}</span></td><td data-label="Last used">${this.dateTime(t.lastUsedAt)}</td><td data-label="Requests">${Number(t.requestCount || 0).toLocaleString()}</td><td data-label="Boards">${t.boards.length}</td></tr>`; }).join("");
    return `<h3>Key usage</h3><p>Every key's use, most recent first. Counts are saved about once a minute, so the latest requests can take a moment to appear.</p><table class="account-table apitok-table apitok-activity"><thead><tr><th>Key</th><th>Owner</th><th>Status</th><th>Last used</th><th>Requests</th><th>Boards</th></tr></thead><tbody>${rows}</tbody></table>
      ${this.eventsHtml()}`;
  }
  // The token audit: created, rotated, revoked (and by whom), and refused or failed requests. Labels and prefixes only, never a token.
  // The filters apply here, in the browser, to the entries the server sent (the newest 200).
  eventsHtml() {
    const events = this.events || [];
    if (!events.length) return `<h3>Recent events</h3><p class="account-empty">No key events yet.</p>`;
    const f = this.actFilters;
    const tokens = ApiTokensPanel.distinct(events.filter((e) => e.token).map((e) => [e.token.id, `${e.token.name || "Unknown key"}${e.token.prefix ? ` (${e.token.prefix}…)` : ""}`]));
    const owners = ApiTokensPanel.distinct(events.filter((e) => e.owner).map((e) => [e.owner.id, e.owner.name || "A former user"]));
    const spaces = ApiTokensPanel.distinct(events.flatMap((e) => (e.workspaces?.length ? e.workspaces : e.workspace ? [e.workspace] : []).map((w) => [w.id, w.name || "Unknown workspace"])));
    const boardNames = new Map((this.items || []).flatMap((t) => t.boards.filter((b) => b.name).map((b) => [b.id, b.name])));
    const boards = ApiTokensPanel.distinct(events.flatMap((e) => (e.token?.boardIds || []).map((id) => [id, boardNames.get(id) || id])));
    const types = Object.entries(ApiTokensPanel.EVENTS);
    const sel = (name, label, choices) => this.filterSelect("apitok-act-filter", name, label, choices, f[name]);
    const filters = `<div class="apikey-toolbar apikey-act-toolbar" role="search" aria-label="Filter API activity">${sel("token", "Key", tokens)}${sel("owner", "Owner", owners)}${sel("workspace", "Workspace", spaces)}${sel("board", "Board", boards)}${sel("type", "Event", types)}${sel("outcome", "Result", [["success", "Succeeded"], ["failure", "Refused or failed"]])}<label>From<input type="date" data-action="apitok-act-filter" data-filter="from" value="${this.esc(f.from)}"></label><label>To<input type="date" data-action="apitok-act-filter" data-filter="to" value="${this.esc(f.to)}"></label></div>`;
    return `<h3>Recent events</h3><p class="account-note">The latest ${events.length} entries of JARC's key audit log. Refused and failed requests are kept for 90 days. Requests aren't logged per board: the Board filter shows events of keys that cover the board.</p>${filters}<p class="apikey-results" id="apikey-events-count" role="status" aria-live="polite">${this.eventsCountText()}</p><div class="apitok-table-scroll" tabindex="0"><table class="account-table apitok-table apitok-events"><thead><tr><th>When</th><th>Event</th><th>Key</th><th>By</th><th>Owner</th><th>Workspace</th></tr></thead><tbody id="apikey-events">${this.eventRowsHtml()}</tbody></table></div>`;
  }
  filteredEvents() {
    const f = this.actFilters, from = f.from ? new Date(`${f.from}T00:00:00`).getTime() : null, to = f.to ? new Date(`${f.to}T23:59:59.999`).getTime() : null;
    return (this.events || []).filter((e) => {
      const at = new Date(e.at).getTime(), spaces = e.workspaces?.length ? e.workspaces : e.workspace ? [e.workspace] : [];
      return (!f.token || e.token?.id === f.token) && (!f.owner || e.owner?.id === f.owner) && (!f.workspace || spaces.some((w) => w.id === f.workspace))
        && (!f.board || (e.token?.boardIds || []).includes(f.board)) && (!f.type || e.action === f.type)
        && (!f.outcome || (f.outcome === "failure") === ApiTokensPanel.FAILURES.has(e.action))
        && (from === null || at >= from) && (to === null || at <= to);
    });
  }
  eventsCountText() { const shown = this.filteredEvents().length, all = (this.events || []).length; return shown === all ? `${all} event${all === 1 ? "" : "s"}` : `${shown} of ${all} events`; }
  eventRowsHtml() {
    const who = (p, fallback) => (p ? this.esc(p.name || "A former user") : fallback);
    const rows = this.filteredEvents().map((e) => { const spaces = e.workspaces?.length ? e.workspaces : e.workspace ? [e.workspace] : []; return `<tr><td data-label="When">${this.dateTime(e.at)}</td><td data-label="Event"><span class="account-badge is-${ApiTokensPanel.FAILURES.has(e.action) ? "warn" : "ok"}">${this.esc(ApiTokensPanel.EVENTS[e.action] || e.action)}</span>${e.reason ? ` <small class="muted">(${this.esc(e.reason)})</small>` : ""}</td><td data-label="Key">${e.token ? `<strong>${this.esc(e.token.name || "Unknown key")}</strong>${e.token.prefix ? `<small><code>${this.esc(e.token.prefix)}…</code></small>` : ""}` : "—"}</td><td data-label="By">${who(e.actor, '<span class="muted">An integration</span>')}</td><td data-label="Owner">${who(e.owner, "—")}</td><td data-label="Workspace">${this.esc(spaces.map((w) => w.name || "Unknown workspace").join(", ") || "—")}</td></tr>`; }).join("");
    return rows || `<tr><td colspan="6" class="muted">No events match these filters.</td></tr>`;
  }
  redrawEvents() {
    const body = document.querySelector("#apikey-events"), count = document.querySelector("#apikey-events-count");
    if (body) body.innerHTML = this.eventRowsHtml();
    if (count) count.textContent = this.eventsCountText();
  }

  // ---- New token
  dateInput(days) { return ApiTokensPanel.localDate(new Date(Date.now() + days * 86400000)); }
  static localDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  // The same moment `years` calendar years on, in UTC, with 29 February becoming 28 February: the server's own rule.
  static addUtcYears(date, years) {
    const y = date.getUTCFullYear() + years, m = date.getUTCMonth(), last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(date.getUTCDate(), last), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  }
  // The latest expiry the server accepts for a token created now, less two minutes for the request and a clock that's slightly off.
  static latestExpiry(now = new Date()) { return new Date(ApiTokensPanel.addUtcYears(now, ApiTokensPanel.MAX_YEARS).getTime() - 2 * 60 * 1000); }
  // The last date the picker offers: the calendar date of that moment, where the person is.
  maxDateInput() { return ApiTokensPanel.localDate(ApiTokensPanel.latestExpiry()); }
  expiryField(label) { return `<label class="full">${label}<input type="date" name="expires" required min="${this.dateInput(1)}" max="${this.maxDateInput()}" value="${this.dateInput(90)}" aria-describedby="apitok-expiry-help"><small id="apitok-expiry-help" class="muted">Any date from tomorrow up to ${ApiTokensPanel.MAX_YEARS} years from today (${this.date(ApiTokensPanel.latestExpiry().toISOString())}).</small></label>`; }
  // The workspaces and boards a new token can be issued for are read afresh every time New token opens (the server
  // decides; boards created or imported since the page loaded are included). One request at a time: opening again while
  // it runs shares it. The window opens at once, with the list known so far or a loading line, and the list is updated
  // in place when the answer arrives. Nothing is ever added to an EXISTING token: it keeps the boards it was issued for.
  static unique(workspaces) {
    const spaces = new Set();
    return (workspaces || []).filter((w) => w && !spaces.has(w.id) && spaces.add(w.id)).map((w) => { const ids = new Set(); return { ...w, boards: (w.boards || []).filter((b) => b && !ids.has(b.id) && ids.add(b.id)) }; });
  }
  refreshOptions() {
    if (this.optionsLoading) return this.optionsLoading;
    const request = this.api("GET", "/options").then((o) => { this.options = ApiTokensPanel.unique(o.workspaces); this.limits = o.limits || this.limits; return this.options; })
      .finally(() => { if (this.optionsLoading === request) this.optionsLoading = null; });
    this.optionsLoading = request;
    return request;
  }
  // Create API key (the guided steps), the one-time secret and Connection details: ApiKeyWizard.js.
  // The end of the chosen day, where the person is, or null for a date that isn't offered (in the past, today, more than 5 years
  // away, or not a real date). On the last day offered, the end of the day may lie beyond the exact limit: then the limit is sent.
  endOfDay(value) {
    const text = String(value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || text < this.dateInput(1) || text > this.maxDateInput()) return null;
    const [y, m, d] = text.split("-").map(Number), at = new Date(y, m - 1, d, 23, 59, 59);
    if (Number.isNaN(at.getTime()) || at.getDate() !== d) return null;
    const latest = ApiTokensPanel.latestExpiry();
    return (at > latest ? latest : at).toISOString();
  }
  expiryProblem() { return `Choose an expiry date from tomorrow up to ${ApiTokensPanel.MAX_YEARS} years from today (${this.date(ApiTokensPanel.latestExpiry().toISOString())}).`; }
  async copySecret(button) {
    const input = document.querySelector("#apitok-secret");
    if (!this.secret || !input) return;
    try { await navigator.clipboard.writeText(this.secret); }
    catch { input.select(); try { document.execCommand("copy"); } catch { this.view.toast("Select the token and copy it"); return; } }
    button.textContent = "Copied";
    this.view.toast("API key copied");
  }
  // Closing the one-time screen forgets the secret: from here on only a new key or a rotation gives one.
  done() { this.secret = null; this.wiz = null; this.items = null; this.open("tokens", { fresh: false }); }

  // ---- Rotate and revoke
  showRotate(t, error = "") {
    this.pending = t;
    this.view.overlay(`<form class="modal apitok-modal" data-action="apitok-rotate-form"><div class="modal-head"><div><div class="eyebrow">Rotate token</div><h2>${this.esc(t.name)}</h2></div>${this.view.closeButton()}</div>
      <p>This creates a replacement with the same boards and shows it once. Your other tokens aren't affected.</p>
      <div class="form-grid"><label class="full">The current token<select name="graceHours">${ApiTokensPanel.GRACE.map(([h, l]) => `<option value="${h}" ${h === 24 ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      ${this.expiryField("The replacement expires on")}</div>
      <p class="account-empty apitok-error" role="alert">${this.esc(error)}</p>
      <div class="modal-actions"><button type="button" class="button secondary" data-action="apitok-cancel">Cancel</button><button class="button primary">Rotate token</button></div></form>`, "apitok-overlay");
  }
  async submitRotate(form) {
    const t = this.pending, expiresAt = this.endOfDay(form.elements.expires.value);
    const say = (text) => { const el = form.querySelector(".apitok-error"); if (el) el.textContent = text; };
    if (!t) return;
    if (!expiresAt) { say(this.expiryProblem()); return; }
    const button = form.querySelector("button.primary"); button.disabled = true;
    try { const result = await this.api("POST", `/${encodeURIComponent(t.id)}/rotate`, { graceHours: Number(form.elements.graceHours.value), expiresAt }); this.pending = null; this.reveal(result, "Token rotated"); }
    catch (error) { say(this.message(error)); button.disabled = false; }
  }
  showRevoke(t) {
    this.pending = t;
    const whose = t.mine ? "" : ` It belongs to <strong>${this.esc(t.owner?.name || "a former user")}</strong>, and they'll see that you revoked it.`;
    this.view.overlay(`<form class="modal confirm-modal" data-action="apitok-revoke-form"><div class="confirm-icon">!</div><h2>Revoke ${this.esc(t.name)}?</h2><p>Anything using this token stops working immediately. This can't be undone.${whose}</p><p class="account-empty apitok-error" role="alert"></p><div class="modal-actions"><button type="button" class="button secondary" data-action="apitok-cancel">Cancel</button><button class="button danger-button">Revoke token</button></div></form>`, "apitok-overlay");
  }
  async submitRevoke(form) {
    const t = this.pending;
    if (!t) return;
    const button = form.querySelector("button.danger-button"); button.disabled = true;
    try { await this.api("POST", `/${encodeURIComponent(t.id)}/revoke`, {}); this.pending = null; this.view.toast("Token revoked"); this.backToList(); }
    catch (error) { const el = form.querySelector(".apitok-error"); if (el) el.textContent = this.message(error); button.disabled = false; }
  }
  backToList(reload = true) { if (reload) this.items = null; this.open("tokens", { fresh: false }); }

  // ---- Copying IDs and endpoints (identifiers, never a token)
  async copyText(text, label) {
    try { await navigator.clipboard.writeText(text); this.view.toast(`${label} copied`); }
    catch { this.view.showMessage(label, text); }
  }
  endpoint(path) { return `${window.location.origin}/api/v1/external${path}`; }
  boardPath(boardId, rest = "") { return `/boards/${encodeURIComponent(boardId)}${rest}`; }
  copyButton(value, label, text = "Copy") { return `<button type="button" class="button secondary" data-action="apitok-copy-value" data-copy="${this.esc(value)}" data-label="${this.esc(label)}" aria-label="Copy ${this.esc(label)}">${text}</button>`; }
  copyRow(label, value, copyLabel = label) { return `<div class="apitok-copy-row"><dt>${this.esc(label)}</dt><dd><code>${this.esc(value)}</code>${this.copyButton(value, copyLabel)}</dd></div>`; }
  plainRow(label, value) { return `<div class="apitok-copy-row"><dt>${this.esc(label)}</dt><dd>${this.esc(value)}</dd></div>`; }
  tokenNote() { return `<p class="account-note">IDs and addresses are the same for everyone, and aren't secrets. Requests also need an API token that covers this board, sent as <code>Authorization: Bearer YOUR_JARC_API_TOKEN</code>.</p>`; }
  // The workspace a board of the open app belongs to.
  locate(boardId) { for (const w of this.c.model.workspaces || []) { const board = w.boards?.find((b) => b.id === boardId); if (board) return { workspace: w, board }; } return null; }

  // ---- A board's API details (board menu)
  showBoardInfo(boardId) {
    const found = this.locate(boardId);
    if (!found) return;
    const { workspace, board } = found;
    const rows = [["Board", ""], ["Records", "/records"], ["Columns", "/columns"], ["Groups", "/groups"]].map(([label, rest]) => this.copyRow(`${label} endpoint`, this.endpoint(this.boardPath(board.id, rest)), "Endpoint")).join("");
    this.view.overlay(`<div class="modal apitok-modal apitok-info apitok-board-info" role="dialog" aria-modal="true" aria-labelledby="apitok-info-title"><div class="modal-head"><div><div class="eyebrow">API Information</div><h2 id="apitok-info-title">${this.esc(board.name)}</h2></div>${this.view.closeButton()}</div>
      <dl class="apitok-copy-list">${this.plainRow("Board name", board.name)}${this.plainRow("Workspace", workspace.name)}${this.copyRow("Board API ID", board.id, "Board ID")}${rows}</dl>
      ${this.tokenNote()}
      <div class="modal-actions">${this.copyButton(board.id, "Board ID", "Copy Board ID")}${this.admin() ? `<button type="button" class="button primary" data-action="apitok-open-explorer" data-workspace="${this.esc(workspace.id)}" data-board="${this.esc(board.id)}">Open in API Explorer</button>` : ""}</div></div>`, "apitok-overlay");
  }

  // ---- A column's API details (column header menu)
  showColumnInfo(key) {
    const model = this.c.model, board = model.board, column = board?.columns.find((c) => c.key === key);
    if (!column) return;
    const workspaceId = this.locate(board.id)?.workspace.id || model.workspace?.id || "";
    const column_ = encodeURIComponent(column.key);
    this.view.overlay(`<div class="modal apitok-modal apitok-info" role="dialog" aria-modal="true" aria-labelledby="apitok-info-title"><div class="modal-head"><div><div class="eyebrow">API Information</div><h2 id="apitok-info-title">${this.esc(column.label)}</h2></div>${this.view.closeButton()}</div>
      <dl class="apitok-copy-list">${this.plainRow("Column name", column.label)}${this.plainRow("Column type", this.typeLabel(column.type))}${this.copyRow("Column API ID", column.key, "Column ID")}${this.plainRow("Board name", board.name)}${this.copyRow("Board API ID", board.id, "Board ID")}
      ${this.copyRow("Column endpoint", this.endpoint(this.boardPath(board.id, `/columns/${column_}`)), "Column endpoint")}${this.copyRow("Values endpoint", this.endpoint(this.boardPath(board.id, `/columns/${column_}/values`)), "Endpoint")}${this.copyRow("Records with this column", this.endpoint(this.boardPath(board.id, `/records?columns=${column_}`)), "Records endpoint")}</dl>
      <p class="account-note">For several columns at once, list their IDs: <code>/records?columns=COLUMN_ID_1,COLUMN_ID_2</code>, or pick them in the API Explorer.</p>
      ${this.tokenNote()}
      <div class="modal-actions">${this.copyButton(column.key, "Column ID", "Copy Column ID")}${this.admin() ? `<button type="button" class="button primary" data-action="apitok-open-explorer" data-workspace="${this.esc(workspaceId)}" data-board="${this.esc(board.id)}" data-column="${this.esc(column.key)}">Open in API Explorer</button>` : ""}</div></div>`, "apitok-overlay");
  }

  // ---- A record's API details (row menu). The Record ID is the record's permanent ID; one token covering the board reads it.
  showRecordInfo(rowId) {
    const model = this.c.model, board = model.board, row = model.rows.find((r) => r.id === model.idOf(rowId)), id = model.recordIdOf?.(row);
    if (!board || !id) { this.view.toast("This record is still being saved"); return; }
    const workspace = this.locate(board.id)?.workspace, url = this.endpoint(`/records/${id}`);
    this.view.overlay(`<div class="modal apitok-modal apitok-info apitok-record-info" role="dialog" aria-modal="true" aria-labelledby="apitok-info-title"><div class="modal-head"><div><div class="eyebrow">API Information</div><h2 id="apitok-info-title">${this.esc(row.serial || "Record")}</h2></div>${this.view.closeButton()}</div>
      <dl class="apitok-copy-list">${this.copyRow("Record ID", id, "Record ID")}${this.plainRow("Board name", board.name)}${this.copyRow("Board API ID", board.id, "Board ID")}${this.plainRow("Workspace", workspace?.name || "")}${this.copyRow("Record endpoint", url, "Endpoint")}</dl>
      <p class="account-note">The Record ID never changes, and isn't the same as an imported Item ID or reference column. ${"Requests also need an API token that covers this board, sent as"} <code>Authorization: Bearer YOUR_JARC_API_TOKEN</code>. Knowing the ID alone opens nothing.</p>
      <div class="modal-actions">${this.copyButton(id, "Record ID", "Copy Record ID")}${this.copyButton(url, "Endpoint", "Copy Endpoint")}${this.admin() ? `<button type="button" class="button primary" data-action="apitok-open-explorer" data-workspace="${this.esc(workspace?.id || "")}" data-board="${this.esc(board.id)}" data-record="${this.esc(id)}">Open in API Explorer</button>` : ""}</div></div>`, "apitok-overlay");
  }

  // ---- Workspaces and boards, read with the person's own session (only what they can already see), shared by the Explorer and the
  // directory. Read again each time the Developer Center opens.
  resetCatalog() { this.catalog = { loaded: false, loading: false, error: "", workspaces: [], boards: new Map(), pending: new Map() }; }
  catalogHtml() {
    const cat = this.catalog;
    if (cat.error) return `<p class="account-empty" role="alert">${this.esc(cat.error)}</p><button type="button" class="button secondary" data-action="apitok-catalog-retry">Try again</button>`;
    if (!cat.loaded) { if (!cat.loading) setTimeout(() => this.catalogStart(), 0); return `<p class="account-empty" aria-busy="true">Loading workspaces…</p>`; }
    if (!cat.workspaces.length) return `<p class="account-empty">You don't have a workspace to explore yet.</p>`;
    return "";
  }
  async catalogStart() {
    const cat = this.catalog;
    if (cat.loading) return;
    cat.loading = true;
    try { cat.workspaces = (await this.adapter.request("GET", "/workspaces")).items.filter((w) => !w.archived); cat.loaded = true; cat.error = ""; }
    catch (error) { cat.error = this.message(error); }
    finally { cat.loading = false; }
    if (cat.loaded) await this.applyPreset();
    this.redraw();
  }
  // A workspace's boards, with their columns, or null while they load (redrawn when they arrive).
  boardsOf(workspaceId) {
    const cat = this.catalog;
    if (cat.boards.has(workspaceId)) return cat.boards.get(workspaceId);
    if (!cat.pending.has(workspaceId)) cat.pending.set(workspaceId, this.fetchBoards(workspaceId).then(() => this.redraw()));
    return null;
  }
  async fetchBoards(workspaceId) {
    const cat = this.catalog;
    if (cat.boards.has(workspaceId)) return cat.boards.get(workspaceId);
    try { const items = (await this.adapter.request("GET", `/workspaces/${encodeURIComponent(workspaceId)}/boards`)).items.filter((b) => !b.archived); cat.boards.set(workspaceId, items); return items; }
    catch (error) { cat.error = this.message(error); return []; }
    finally { cat.pending.delete(workspaceId); }
  }
  workspaceSelect(action, current, only = null) { return `<label>Workspace<select data-action="${action}">${this.catalog.workspaces.filter((w) => !only || only(w)).map((w) => `<option value="${this.esc(w.id)}" ${w.id === current ? "selected" : ""}>${this.esc(w.name)}</option>`).join("")}</select></label>`; }

  // ---- Boards & Columns directory
  directoryHtml() {
    const wait = this.catalogHtml();
    if (wait) return wait;
    const dir = this.dir;
    if (!this.catalog.workspaces.some((w) => w.id === dir.workspaceId)) { dir.workspaceId = this.catalog.workspaces[0].id; dir.boardId = ""; }
    const boards = this.boardsOf(dir.workspaceId);
    const head = `<p>Every board and column you can see, with its permanent API ID and address. They are the same for everyone in the company.</p><div class="apitok-ex-pickers">${this.workspaceSelect("apitok-dir-workspace", dir.workspaceId)}<label>Search boards<input type="search" data-action="apitok-dir-board-search" value="${this.esc(dir.boardQuery)}" placeholder="Board name" autocomplete="off"></label></div>`;
    if (!boards) return `${head}<p class="account-empty" aria-busy="true">Loading boards…</p>`;
    if (!boards.length) return `${head}<p class="account-empty">This workspace has no boards yet.</p>`;
    if (!boards.some((b) => b.id === dir.boardId)) dir.boardId = boards[0].id;
    return `${head}<div class="apitok-dir"><div class="apitok-dir-boards" role="list" aria-label="Boards" id="apitok-dir-boards">${this.directoryBoardsHtml(boards)}</div><div class="apitok-dir-detail" id="apitok-dir-detail">${this.directoryDetailHtml(boards.find((b) => b.id === dir.boardId))}</div></div>`;
  }
  matches(textValue, query) { return String(textValue || "").toLowerCase().includes(String(query || "").trim().toLowerCase()); }
  directoryBoardsHtml(boards) {
    const shown = boards.filter((b) => this.matches(b.name, this.dir.boardQuery));
    if (!shown.length) return `<p class="account-empty">No boards match.</p>`;
    return shown.map((b) => `<button type="button" role="listitem" data-action="apitok-dir-board" data-id="${this.esc(b.id)}" class="apitok-dir-board ${b.id === this.dir.boardId ? "active" : ""}" ${b.id === this.dir.boardId ? 'aria-current="true"' : ""}><strong>${this.esc(b.name)}</strong><small>${b.columns.length} column${b.columns.length === 1 ? "" : "s"} · <code>${this.esc(b.id)}</code></small></button>`).join("");
  }
  directoryDetailHtml(board) {
    if (!board) return "";
    const rows = this.directoryRowsHtml(board);
    return `<div class="apitok-dir-head"><div><h3>${this.esc(board.name)}</h3><dl class="apitok-copy-list">${this.copyRow("Board API ID", board.id, "Board ID")}${this.copyRow("Board endpoint", this.endpoint(this.boardPath(board.id)), "Endpoint")}${this.copyRow("Records endpoint", this.endpoint(this.boardPath(board.id, "/records")), "Endpoint")}</dl></div>${this.admin() ? `<button type="button" class="button secondary" data-action="apitok-open-explorer" data-workspace="${this.esc(this.dir.workspaceId)}" data-board="${this.esc(board.id)}">Open in API Explorer</button>` : ""}</div>
      <label class="apitok-dir-search">Search columns<input type="search" data-action="apitok-dir-column-search" value="${this.esc(this.dir.columnQuery)}" placeholder="Column name or ID" autocomplete="off"></label>
      <div class="apitok-table-scroll" tabindex="0"><table class="apitok-doc-table apitok-dir-columns"><thead><tr><th>Board</th><th>Column</th><th>Column type</th><th>Column API ID</th><th>API endpoint</th><th><span class="sr-only">Copy</span></th></tr></thead><tbody id="apitok-dir-rows">${rows}</tbody></table></div>`;
  }
  directoryRowsHtml(board) {
    const shown = board.columns.filter((c) => this.matches(c.label, this.dir.columnQuery) || this.matches(c.key, this.dir.columnQuery));
    if (!shown.length) return `<tr><td colspan="6" class="muted">No columns match.</td></tr>`;
    // The row shows the end of the address; the board's full address is above, and Copy URL copies the whole of it.
    return shown.map((c) => { const tail = `/columns/${encodeURIComponent(c.key)}/values`, url = this.endpoint(this.boardPath(board.id, tail)); return `<tr><td data-label="Board">${this.esc(board.name)}</td><td data-label="Column">${this.esc(c.label)}${c.visible === false ? ' <small class="muted">Hidden</small>' : ""}</td><td data-label="Type">${this.esc(this.typeLabel(c.type))}</td><td data-label="Column API ID"><code>${this.esc(c.key)}</code></td><td data-label="API endpoint" class="apitok-url"><code title="${this.esc(url)}">GET …${this.esc(tail)}</code></td><td class="apitok-dir-copy">${this.copyButton(c.key, "Column ID", "Copy ID")}${this.copyButton(url, "Endpoint", "Copy URL")}${this.admin() ? `<button type="button" class="button secondary" data-action="apitok-open-explorer" data-workspace="${this.esc(this.dir.workspaceId)}" data-board="${this.esc(board.id)}" data-column="${this.esc(c.key)}" aria-label="Open ${this.esc(c.label)} in the API Explorer">Explore</button>` : ""}</td></tr>`; }).join("");
  }
  // Typing filters the lists in place, so the search box keeps focus.
  directorySearch(input) {
    const dir = this.dir, boards = this.catalog.boards.get(dir.workspaceId) || [];
    if (input.dataset.action === "apitok-dir-board-search") { dir.boardQuery = input.value; const list = document.querySelector("#apitok-dir-boards"); if (list) list.innerHTML = this.directoryBoardsHtml(boards); return; }
    dir.columnQuery = input.value;
    const board = boards.find((b) => b.id === dir.boardId), body = document.querySelector("#apitok-dir-rows");
    if (board && body) body.innerHTML = this.directoryRowsHtml(board);
  }

  // ---- API Explorer: uses this person's session, so it shows only what they can already see, and never a token.
  operation() { return ApiTokensPanel.OPERATIONS.find(([id]) => id === this.ex.op) || ApiTokensPanel.OPERATIONS[0]; }
  // Opening from a board or column: start there.
  applyPreset() {
    if (!this.applying) this.applying = this.presetNow().finally(() => { this.applying = null; });
    return this.applying;
  }
  // The API key chosen as the Explorer's scope reference, or null. It only narrows what is offered: previews still use the
  // administrator's own session, and the key's secret is never used or needed here.
  exKey() { return this.ex.tokenId ? (this.items || []).find((t) => t.id === this.ex.tokenId) || null : null; }
  exKeyBoards() { const key = this.exKey(); return key ? new Set(key.boards.filter((b) => b.available !== false).map((b) => b.id)) : null; }
  exKeySpaces() { const key = this.exKey(); return key ? new Set(key.boards.filter((b) => b.available !== false && b.workspaceId).map((b) => b.workspaceId)) : null; }
  exBoards(list) { const only = this.exKeyBoards(); return only ? (list || []).filter((b) => only.has(b.id)) : (list || []); }
  async presetNow() {
    const ex = this.ex, preset = ex.preset;
    ex.preset = null;
    const spaces = this.exKeySpaces(), workspaces = this.catalog.workspaces.filter((w) => !spaces || spaces.has(w.id));
    const workspaceId = workspaces.some((w) => w.id === preset?.workspaceId) ? preset.workspaceId : workspaces.some((w) => w.id === ex.workspaceId) ? ex.workspaceId : workspaces[0]?.id;
    if (!workspaceId) { ex.workspaceId = ""; ex.boardId = ""; ex.data = null; return; }
    const boards = this.exBoards(await this.fetchBoards(workspaceId));
    const boardId = boards.some((b) => b.id === preset?.boardId) ? preset.boardId : workspaceId === ex.workspaceId && boards.some((b) => b.id === ex.boardId) ? ex.boardId : boards[0]?.id || "";
    if (workspaceId === ex.workspaceId && boardId === ex.boardId && ex.data && !preset) return;
    ex.workspaceId = workspaceId;
    await this.explorerBoard(boardId, preset?.column, preset?.record);
  }
  async explorerWorkspace(id) {
    const ex = this.ex;
    const boards = this.exBoards(await this.fetchBoards(id));
    ex.workspaceId = id;
    await this.explorerBoard(boards[0]?.id || "");
  }
  // Choosing a key (or none) as the scope reference: start on its first board you can see.
  async explorerKey(id) {
    const ex = this.ex;
    ex.tokenId = id || "";
    const key = this.exKey(), first = key?.boards.find((b) => b.available !== false && b.workspaceId);
    ex.preset = first ? { workspaceId: first.workspaceId, boardId: first.id } : null;
    await this.presetNow();
  }
  async explorerBoard(id, column = null, record = null) {
    const ex = this.ex;
    Object.assign(ex, { boardId: id, data: null, error: "", preview: null, previewError: "", column: "", record: record || "", params: { ...ex.params, groupId: "" } }); ex.selected = new Set();
    if (column) { ex.op = "values"; ex.column = column; }
    if (record) ex.op = "record";
    if (!id) return;
    try { ex.data = await this.explorerFetch(); }
    catch (error) { ex.error = this.message(error); return; }
    if (!ex.data.columns.some((c) => c.id === ex.column)) ex.column = ex.data.columns[0]?.id || "";
    if (!ex.record) ex.record = ex.data.example.items[0]?.id || "";
  }
  explorerFetch(columns = [], record = null) { const q = [...(columns.length ? [`columns=${columns.map(encodeURIComponent).join(",")}`] : []), ...(record ? [`record=${encodeURIComponent(record)}`] : [])]; return this.adapter.request("GET", `/me/api-explorer/boards/${encodeURIComponent(this.ex.boardId)}${q.length ? `?${q.join("&")}` : ""}`); }
  validRecord() { return /^[0-9a-f]{24}$/i.test(this.ex.record || ""); }
  // In board order, so the address doesn't depend on the order they were ticked.
  explorerSelected() { return (this.ex.data?.columns || []).filter((c) => this.ex.selected.has(c.id)).map((c) => c.id); }
  // The options, checked here as the server would; a value it would refuse is left out and explained.
  explorerQuery() {
    const ex = this.ex, [, , , takes, paged] = this.operation(), q = [], problems = [];
    if (takes === "many") { const picked = this.explorerSelected(); if (picked.length) q.push(`columns=${picked.map(encodeURIComponent).join(",")}`); }
    if (paged) {
      const limit = String(ex.params.limit || "").trim();
      if (limit) { if (/^\d{1,3}$/.test(limit) && Number(limit) >= 1 && Number(limit) <= ApiTokensPanel.PAGE_MAX) q.push(`limit=${Number(limit)}`); else problems.push(`Records per page must be 1 to ${ApiTokensPanel.PAGE_MAX}.`); }
      if (ex.params.groupId) q.push(`groupId=${encodeURIComponent(ex.params.groupId)}`);
      if (ex.params.updatedSince) { const at = new Date(ex.params.updatedSince); if (Number.isNaN(at.getTime())) problems.push("Choose a valid date and time."); else q.push(`updatedSince=${encodeURIComponent(at.toISOString())}`); }
    }
    if (takes === "record" && !this.validRecord()) problems.push("A Record ID has 24 characters, 0-9 and a-f. Copy it from the board's Record ID column.");
    if (ex.params.includeArchived) q.push("includeArchived=true");
    return { query: q.length ? `?${q.join("&")}` : "", problems };
  }
  explorerPath() { const [id, , path] = this.operation(); if (id === "record") return `/records/${encodeURIComponent(this.validRecord() ? this.ex.record.toLowerCase() : "RECORD_ID")}`; return this.boardPath(this.ex.boardId, path.replace("{column}", encodeURIComponent(this.ex.column))); }
  explorerUrl() { return `${this.endpoint(this.explorerPath())}${this.explorerQuery().query}`; }
  explorerCode(url) {
    const paged = this.operation()[4];
    const curl = `# Keep the token out of your scripts: export JARC_API_TOKEN="paste-your-token-here"\ncurl -H "Authorization: Bearer $JARC_API_TOKEN" \\\n  "${url}"`;
    const js = `// Run this on a server, never in a web page. Keep the token in an environment variable or secret store.\nconst response = await fetch("${url}", {\n  headers: { Authorization: \`Bearer \${process.env.JARC_API_TOKEN}\` }\n});\nconst body = await response.json();\nif (!response.ok) throw new Error(\`\${body.error.code}: \${body.error.message}\`);${paged ? "\n// More pages: while body.pagination.nextCursor isn't null, request again with &cursor=<nextCursor>." : ""}`;
    return { curl, js };
  }
  codeBlock(id, label, textValue) { return `<figure class="apitok-code"><figcaption><span>${this.esc(label)}</span><button type="button" class="button secondary" data-action="apitok-copy-example" data-example="${id}">Copy</button></figcaption><pre id="apitok-example-${id}" tabindex="0"><code>${this.esc(textValue)}</code></pre></figure>`; }
  explorerHtml() {
    const wait = this.catalogHtml();
    if (wait) return wait;
    const ex = this.ex, option = (o, current) => `<option value="${this.esc(o.id)}" ${o.id === current ? "selected" : ""}>${this.esc(o.name)}</option>`;
    const key = this.exKey(), spaces = this.exKeySpaces();
    // The scope reference: any board this administrator can see, or one API key's boards. The two ways of calling are labelled.
    const keys = (this.items || []).filter((t) => ApiTokensPanel.live(t) || t.id === ex.tokenId);
    const scope = `<div class="apikey-scope"><label>Scope reference<select data-action="apitok-ex-key"><option value="">Every board you can see (no API key)</option>${keys.map((t) => `<option value="${this.esc(t.id)}" ${t.id === ex.tokenId ? "selected" : ""}>${this.esc(t.name)} (${this.esc(t.prefix)}…, ${t.boards.length} board${t.boards.length === 1 ? "" : "s"})</option>`).join("")}</select></label>
      <div class="apikey-modes"><div class="apikey-mode"><span class="account-badge is-ok">Preview</span><span>Uses <strong>your signed-in administrator session</strong>. No API key or secret is used here.</span></div><div class="apikey-mode"><span class="account-badge is-warn">Integration</span><span>Calls the same URL with <code>Authorization: Bearer YOUR_JARC_API_TOKEN</code>. The server allows only the key's own boards.</span></div></div>
      ${key ? `<p class="account-note">Showing the ${key.boards.length} board${key.boards.length === 1 ? "" : "s"} of <strong>${this.esc(key.name)}</strong>${key.boards.some((b) => b.available === false) ? ", except those no longer available" : ""}.</p>` : ""}</div>`;
    if (key && !spaces.size) return `${scope}<p class="account-empty">None of this key's boards are available.</p>`;
    if (!ex.workspaceId) { setTimeout(() => this.explorerChange(() => this.applyPreset()), 0); return `${scope}<p class="account-empty" aria-busy="true">Loading boards…</p>`; }
    const boards = this.exBoards(this.catalog.boards.get(ex.workspaceId));
    const [opId, , , takes, paged] = this.operation();
    const pickers = `<div class="apitok-ex-pickers apitok-ex-pickers-3">${this.workspaceSelect("apitok-ex-workspace", ex.workspaceId, spaces ? (w) => spaces.has(w.id) : null)}<label>Board<select data-action="apitok-ex-board" ${boards.length ? "" : "disabled"}>${boards.map((b) => option(b, ex.boardId)).join("")}</select></label><label>Operation<select data-action="apitok-ex-op">${ApiTokensPanel.OPERATIONS.map(([id, label]) => `<option value="${id}" ${id === opId ? "selected" : ""}>${this.esc(label)}</option>`).join("")}</select></label></div>`;
    const intro = `${this.admin() ? scope : ""}<p>Build a request for ${key ? "this key's boards" : "any board you can see"}. Previews use your own sign-in; integrations need an API key that covers the board.</p>`;
    if (!boards.length) return `${intro}${pickers}<p class="account-empty">${key ? "This key has no boards in this workspace." : "This workspace has no boards yet."}</p>`;
    if (ex.error) return `${intro}${pickers}<p class="account-empty" role="alert">${this.esc(ex.error)}</p><button type="button" class="button secondary" data-action="apitok-ex-retry">Try again</button>`;
    if (!ex.data) return `${intro}${pickers}<p class="account-empty" aria-busy="true">Loading board…</p>`;
    const input = (c) => takes === "many" ? `<input type="checkbox" data-action="apitok-ex-column" value="${this.esc(c.id)}" aria-label="Include ${this.esc(c.name)}" ${ex.selected.has(c.id) ? "checked" : ""}>` : takes === "one" ? `<input type="radio" name="apitok-ex-one" data-action="apitok-ex-one" value="${this.esc(c.id)}" aria-label="Use ${this.esc(c.name)}" ${ex.column === c.id ? "checked" : ""}>` : "";
    const columns = `<div class="apitok-table-scroll" tabindex="0"><table class="apitok-doc-table apitok-ex-columns"><thead><tr><th><span class="sr-only">${takes === "none" ? "" : "Select"}</span></th><th>Column</th><th>Column API ID</th><th>Type</th><th><span class="sr-only">Copy</span></th></tr></thead><tbody>${ex.data.columns.map((c) => `<tr><td>${input(c)}</td><td>${this.esc(c.name)}${c.visible === false ? ' <small class="muted">Hidden</small>' : ""}</td><td><code>${this.esc(c.id)}</code></td><td>${this.esc(this.typeLabel(c.type))}</td><td>${this.copyButton(c.id, "Column ID")}</td></tr>`).join("")}</tbody></table></div>`;
    const recordField = takes === "record" ? `<div class="apitok-ex-options apitok-ex-record"><label>Record ID<input type="text" spellcheck="false" autocomplete="off" maxlength="24" data-action="apitok-ex-record" value="${this.esc(ex.record)}" placeholder="24 characters, from the Record ID column"></label></div>` : "";
    const columnHelp = takes === "many" ? "Select columns to narrow the response. With none selected, it returns every column." : takes === "one" ? "Choose the column." : "Every column's ID, for reference.";
    const groups = ex.data.board?.groups || [];
    const options = `<h3>Options</h3><div class="apitok-ex-options">${paged ? `<label>Records per page<input type="number" inputmode="numeric" min="1" max="${ApiTokensPanel.PAGE_MAX}" placeholder="${ApiTokensPanel.PAGE_DEFAULT}" data-action="apitok-ex-param" data-param="limit" value="${this.esc(ex.params.limit)}"></label><label>Group<select data-action="apitok-ex-param" data-param="groupId"><option value="">All groups</option>${groups.filter((g) => !g.archived).map((g) => `<option value="${this.esc(g.id)}" ${g.id === ex.params.groupId ? "selected" : ""}>${this.esc(g.name)}</option>`).join("")}<option value="none" ${ex.params.groupId === "none" ? "selected" : ""}>No group</option></select></label><label>Changed since<input type="datetime-local" data-action="apitok-ex-param" data-param="updatedSince" value="${this.esc(ex.params.updatedSince)}"></label>` : ""}<label class="apitok-check"><input type="checkbox" data-action="apitok-ex-param" data-param="includeArchived" ${ex.params.includeArchived ? "checked" : ""}><span>Include archived</span></label></div>
      ${paged ? `<p class="account-note">Pages hold ${ApiTokensPanel.PAGE_DEFAULT} records by default, ${ApiTokensPanel.PAGE_MAX} at most. While <code>pagination.nextCursor</code> isn't null, send it back as <code>cursor</code> with the same options.</p>` : ""}`;
    const { problems } = this.explorerQuery(), url = this.explorerUrl(), code = this.explorerCode(url);
    const related = opId === "records" && this.explorerSelected().length === 1 ? this.copyRow("One column's values", this.endpoint(this.boardPath(ex.boardId, `/columns/${encodeURIComponent(this.explorerSelected()[0])}/values`)), "Endpoint") : "";
    const preview = ex.preview ? `<figure class="apitok-code"><figcaption><span>${opId === "records" || opId === "values" ? `Example response, from your own access (first ${ex.data.example.pagination.limit} active records at most; options aren't applied)` : "Example response, from your own access"}</span></figcaption><pre tabindex="0" id="apitok-ex-example"><code>${this.esc(JSON.stringify(ex.preview, null, 2))}</code></pre></figure>` : ex.previewError ? `<p class="account-empty" role="alert">${this.esc(ex.previewError)}</p>` : "";
    return `${intro}${pickers}
      <dl class="apitok-copy-list">${this.copyRow("Board API ID", ex.boardId)}</dl>
      ${recordField}<h3>Columns</h3><p class="account-note">${columnHelp}</p>${columns}
      ${options}
      <h3>Endpoint</h3>${problems.length ? `<p class="apitok-error" role="alert">${this.esc(problems.join(" "))}</p>` : ""}<dl class="apitok-copy-list">${this.copyRow(`GET`, url, "Endpoint")}${related}</dl>
      <p class="account-note">Send your token in a header, never in the address: <code>Authorization: Bearer YOUR_JARC_API_TOKEN</code></p>
      ${this.codeBlock("ex-curl", "cURL", code.curl)}${this.codeBlock("ex-js", "JavaScript (server-side)", code.js)}
      <button type="button" class="button secondary" data-action="apitok-ex-example" ${ex.previewBusy ? "disabled" : ""}>Preview response</button>${preview}`;
  }
  // The response this operation would give, from the explorer's own (session) read in the token API's format.
  async explorerExample() {
    const ex = this.ex, [opId] = this.operation();
    ex.previewBusy = true; ex.previewError = ""; this.redraw();
    try {
      if (opId === "records") ex.preview = (await this.explorerFetch(this.explorerSelected())).example;
      else if (opId === "values") ex.preview = (await this.explorerFetch([ex.column])).values;
      else if (opId === "record") { if (!this.validRecord()) throw new Error("Enter a Record ID first."); ex.preview = { record: (await this.explorerFetch([], ex.record.toLowerCase())).record }; }
      else {
        const data = await this.explorerFetch();
        ex.data = { ...ex.data, board: data.board, columns: data.columns };
        const column = data.columns.find((c) => c.id === ex.column);
        ex.preview = opId === "board" ? { board: data.board } : opId === "columns" ? { items: data.columns } : opId === "groups" ? { items: data.board.groups } : { column: { boardId: data.board.id, ...column } };
      }
    } catch (error) { ex.preview = null; ex.previewError = this.message(error); }
    finally { ex.previewBusy = false; this.redraw(); }
  }
  // Selections change the address without re-reading the board; a board or workspace change reads it, then redraws.
  explorerChange(load) { Promise.resolve().then(load).catch((error) => { this.ex.error = this.message(error); }).finally(() => this.redraw()); this.redraw(); }
  // Redraw, keeping the columns table's scroll and the focus on the control just used.
  redrawKeeping(selector) {
    const scroll = document.querySelector("#apitok-root .apitok-ex-columns")?.parentElement?.scrollLeft;
    this.redraw();
    const next = document.querySelector("#apitok-root .apitok-ex-columns")?.parentElement;
    if (next && scroll) next.scrollLeft = scroll;
    document.querySelector(`#apitok-root ${selector}`)?.focus();
  }
  // Typing a Record ID: the address and examples follow, and the cursor stays where it was.
  refreshExplorerAddress() {
    const before = document.querySelector('#apitok-root [data-action="apitok-ex-record"]'), at = before?.selectionStart ?? null;
    this.redrawKeeping('[data-action="apitok-ex-record"]');
    const input = document.querySelector('#apitok-root [data-action="apitok-ex-record"]');
    if (input && at !== null) input.setSelectionRange(at, at);
  }
  openExplorer(target) {
    if (!this.admin()) { this.open("directory"); return; }
    this.ex.preset = { workspaceId: target.dataset.workspace, boardId: target.dataset.board, column: target.dataset.column || null, record: target.dataset.record || null };
    this.ex.preview = null; this.ex.previewError = "";
    if (!target.dataset.column && !target.dataset.record) this.ex.op = "records";
    // From the directory: the workspaces are already read. From a board or column menu: read them afresh, then start there.
    const inside = Boolean(document.querySelector("#apitok-root")) && this.catalog.loaded;
    this.open("explorer", { fresh: !inside });
    if (inside) this.explorerChange(() => this.applyPreset());
  }

  // ---- Events (data-action="apitok-…")
  onAction(action, target) {
    if (action === "apitok-tab") { this.tab = target.dataset.tab; this.redraw(); const pane = document.querySelector(".developer-window .settings-content"); if (pane) pane.scrollTop = 0; if (target.closest(".settings-nav")) document.querySelector(`.developer-window .settings-nav [data-action="apitok-tab"][data-tab="${CSS.escape(this.tab)}"]`)?.focus(); return; }
    if (action === "apitok-admin") { this.openAdmin(target.dataset.target); return; }
    if (action === "apitok-refresh") { this.items = null; this.error = ""; this.redraw(); return; }
    if (action === "apitok-new") { this.showCreate(); return; }
    if (action.startsWith("apitok-wiz-") || action === "apitok-boards-retry" || action === "apitok-copy-all" || action === "apitok-conn-close") { this.onWizardAction(action, target); return; }
    if (action === "apitok-copy-value") { this.copyText(target.dataset.copy, target.dataset.label); return; }
    if (action === "apitok-copy-board") { this.view.closeOverlay(); this.copyText(target.dataset.id, "Board ID"); return; }
    if (action === "apitok-copy-column") { this.view.closeOverlay(); this.copyText(target.dataset.key, "Column ID"); return; }
    if (action === "apitok-board-info") { this.showBoardInfo(target.dataset.id); return; }
    if (action === "apitok-column-info") { this.showColumnInfo(target.dataset.key); return; }
    if (action === "apitok-record-info") { this.showRecordInfo(target.dataset.id); return; }
    if (action === "apitok-open-explorer") { this.openExplorer(target); return; }
    if (action === "apitok-catalog-retry") { this.resetCatalog(); this.redraw(); return; }
    if (action === "apitok-dir-board") { this.dir.boardId = target.dataset.id; this.dir.columnQuery = ""; this.redraw(); document.querySelector(`#apitok-root [data-action="apitok-dir-board"][data-id="${CSS.escape(target.dataset.id)}"]`)?.focus(); return; }
    if (action === "apitok-ex-example") { this.explorerExample(); return; }
    if (action === "apitok-ex-retry") { const id = this.ex.boardId; this.ex.error = ""; this.explorerChange(() => (id ? this.explorerBoard(id) : this.applyPreset())); return; }
    if (action === "apitok-copy") { this.copySecret(target); return; }
    if (action === "apitok-done") { this.done(); return; }
    if (action === "apitok-cancel") { this.pending = null; this.backToList(false); return; }
    if (action === "apitok-copy-example") { const text = document.querySelector(`#apitok-example-${CSS.escape(target.dataset.example)}`)?.textContent; if (text) navigator.clipboard?.writeText(text).then(() => this.view.toast("Copied"), () => this.view.toast("Select the text and copy it")); return; }
    const token = this.items?.find((t) => t.id === target.dataset.id);
    if (action === "apitok-rotate" && token) this.showRotate(token);
    if (action === "apitok-revoke" && token) this.showRevoke(token);
    if (action === "apitok-details" && token) this.showConnection(token);
    if (action === "apitok-key-activity" && token) { this.view.closeOverlay?.(); this.resetFilters(); this.actFilters.token = token.id; this.backToTab("activity"); }
    if (action === "apitok-key-explorer" && token) { this.view.closeOverlay?.(); this.ex.preview = null; this.ex.previewError = ""; this.ex.op = "records"; this.backToTab("explorer"); this.explorerChange(() => this.explorerKey(token.id)); }
  }
  // Back in the Developer Center on this section, keeping what it has loaded (opened again if a dialog replaced it).
  backToTab(tab) {
    this.tab = tab;
    if (document.querySelector("#apitok-root")) this.redraw(); else this.open(tab, { fresh: false });
  }
  onInput(input) {
    if (input.dataset.action === "apitok-filter") { this.filters[input.dataset.filter] = input.value; this.redrawKeys(); return; }
    if (input.dataset.action === "apitok-wiz-search") { this.wizardSearch(input.value); return; }
    if (input.dataset.action === "apitok-ex-record") { this.ex.record = input.value.trim(); this.ex.preview = null; this.refreshExplorerAddress(); return; }
    if (input.dataset.action === "apitok-dir-board-search" || input.dataset.action === "apitok-dir-column-search") this.directorySearch(input);
  }
  onChange(select) {
    const change = select.dataset.action, ex = this.ex;
    if (change === "apitok-ex-workspace") { this.explorerChange(() => this.explorerWorkspace(select.value)); return; }
    if (change === "apitok-ex-board") { this.explorerChange(() => this.explorerBoard(select.value)); return; }
    if (change === "apitok-ex-op") { ex.op = select.value; ex.preview = null; ex.previewError = ""; if (this.operation()[3] === "one" && !ex.column) ex.column = ex.data?.columns[0]?.id || ""; if (this.operation()[3] === "record" && !ex.record) ex.record = ex.data?.example.items[0]?.id || ""; this.redrawKeeping('[data-action="apitok-ex-op"]'); return; }
    if (change === "apitok-ex-column") { if (select.checked) ex.selected.add(select.value); else ex.selected.delete(select.value); ex.preview = null; this.redrawKeeping(`[data-action="apitok-ex-column"][value="${CSS.escape(select.value)}"]`); return; }
    if (change === "apitok-ex-one") { ex.column = select.value; ex.preview = null; this.redrawKeeping(`[data-action="apitok-ex-one"][value="${CSS.escape(select.value)}"]`); return; }
    if (change === "apitok-ex-param") { const name = select.dataset.param; ex.params[name] = select.type === "checkbox" ? select.checked : select.value; ex.preview = null; this.redrawKeeping(`[data-action="apitok-ex-param"][data-param="${CSS.escape(name)}"]`); return; }
    if (change === "apitok-dir-workspace") { this.dir.workspaceId = select.value; this.dir.boardId = ""; this.dir.boardQuery = ""; this.dir.columnQuery = ""; this.redraw(); return; }
    if (change === "apitok-ex-key") { this.ex.preview = null; this.ex.previewError = ""; this.explorerChange(() => this.explorerKey(select.value)); return; }
    if (change === "apitok-filter") { this.filters[select.dataset.filter] = select.value; this.redrawKeys(); return; }
    if (change === "apitok-act-filter") { this.actFilters[select.dataset.filter] = select.value; this.redrawEvents(); return; }
    if (change.startsWith("apitok-wiz-") || change === "apitok-conn-example") this.onWizardChange(select);
  }
  onSubmit(action, form) {
    if (action === "apitok-create-form") this.submitWizard(form);
    if (action === "apitok-rotate-form") this.submitRotate(form);
    if (action === "apitok-revoke-form") this.submitRevoke(form);
  }
}

window.ApiTokensPanel = ApiTokensPanel;
