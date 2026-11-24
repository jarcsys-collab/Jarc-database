// Fabric Data → API Management (Fabric API administrators only): read-only API keys for the Fabric data, their activity, and the
// documentation, in the compact Fabric app look (fabric-api.css: toolbar, tab strip, fx-grid tables, fx-dialog windows). The
// panel (FabricDataPanel.js) renders the app bar and tabs; this renders the body below them. The server enforces every rule
// (/api/v1/fabric/api-tokens); this only shows what it reports.
//
// A new key's secret exists only as text in the one dialog that reveals it: never in this object, browser storage, the model, an
// address or an example. It is gone when that dialog closes (its input is cleared first) or the session ends.
class FabricApiPanel {
  static TABS = [["tokens", "Keys"], ["activity", "Activity"], ["docs", "Documentation"]];
  static STATUS = { active: ["Active", "ok"], expired: ["Expired", "muted"], revoked: ["Revoked", "muted"], no_access: ["No access", "danger"] };
  static EVENTS = { "token.created": "Created", "token.revoked": "Revoked", "token.auth_failed": "Wrong secret", "token.use_refused": "Request refused", "token.rate_limited": "Rate limited", "token.access_revoked": "Owner lost access" };
  static FAILURES = new Set(["token.auth_failed", "token.use_refused", "token.rate_limited", "token.access_revoked"]);
  // Dataset scopes (at least one per key) and the sensitive-fields scope (only with a dataset scope, only from sensitive readers).
  static DATASET_SCOPES = [["sales", "fabric.sales.read", "Sales"], ["inventory", "fabric.inventory.read", "Inventory"]];
  static SENSITIVE_SCOPE = "fabric.sensitive.read";
  static SCOPES = { "fabric.sales.read": "Sales", "fabric.inventory.read": "Inventory", "fabric.sensitive.read": "Sensitive fields" };
  static CODES = {
    FABRIC_API_ADMIN_REQUIRED: "Only Fabric API administrators can manage Fabric API keys.",
    FABRIC_DATA_FORBIDDEN: "You don't have access to Fabric Data.",
    TOKEN_LIMIT_REACHED: "You've reached the limit of active keys. Revoke one you no longer need.",
    TOKEN_NOT_ACTIVE: "This key has already ended.",
    FABRIC_SENSITIVE_ACCESS_REQUIRED: "You can't grant sensitive fields: only Fabric API administrators who may see them can.",
    INSUFFICIENT_SCOPE: "You can't grant sensitive fields: only Fabric API administrators who may see them can.",
    VALIDATION_ERROR: "Check the name, the expiry date and the datasets (choose at least one), then try again.",
    RATE_LIMITED: "Too many requests in a short time. Wait a few seconds, then try again."
  };
  static MAX_YEARS = 5;

  constructor(fabric) { this.f = fabric; this.forget(); }
  // Also on sign-out / session end: an open one-time-key dialog loses its value. (`secret` stays null: kept for older callers.)
  forget() {
    this.tab = "tokens"; this.items = null; this.events = null; this.loading = false; this.error = ""; this.activityLoading = false; this.activityError = ""; this.pending = null; this.secret = null; this.seq = (this.seq || 0) + 1;
    const input = typeof document !== "undefined" ? document.querySelector?.("#fabric-api-secret") : null;
    if (input) { input.value = ""; input.setAttribute?.("value", ""); }
  }
  get c() { return this.f.c; }
  get view() { return this.c.view; }
  get adapter() { return this.f.adapter; }
  // features.fabricData.sensitive (cost: its older name, kept by the server for one release).
  get canGrantSensitive() { const f = this.f.features; return Boolean(f && (f.sensitive === true || (f.sensitive === undefined && f.cost === true))); }
  // The datasets a key may be given: those /features lists (both when it lists none).
  get datasetScopes() { return FabricApiPanel.DATASET_SCOPES.filter(([ds]) => this.f.datasetAllowed ? this.f.datasetAllowed(ds) : true); }
  esc(v) { return this.view.escape(v ?? ""); }
  api(method, path, body) { return this.adapter.request(method, `/fabric/api-tokens${path}`, body); }
  message(error) {
    const code = error?.cause?.serverCode || error?.code;
    const text = FabricApiPanel.CODES[code] || (typeof StorageError === "function" && StorageError.describe ? StorageError.describe(error)?.message : "") || "That didn't work.";
    return `${text}${error?.requestId ? ` (reference ${error.requestId})` : ""}`;
  }
  date(iso, fallback = "Never") { if (!iso) return fallback; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : this.esc(d.toLocaleDateString(undefined, { dateStyle: "medium" })); }
  dateTime(iso, fallback = "Never") { if (!iso) return fallback; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : this.esc(d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })); }
  overlayRoot() { return typeof document !== "undefined" ? document.querySelector("#overlay-root") : null; }
  focus(selector) { if (typeof document !== "undefined") document.querySelector(selector)?.focus?.(); }

  // ---- Loading: the list and the activity together (on entry and Refresh), or the activity alone (Activity → Refresh). No polling.
  ensure() { if (this.tab !== "docs" && !this.items && !this.loading && !this.error) this.load(); }
  refresh() { this.items = null; this.events = null; this.error = ""; this.activityError = ""; this.load(); }
  async load() {
    if (this.loading) return;
    const seq = this.seq; this.loading = true; this.f.redraw();
    try {
      const [list, activity] = await Promise.all([this.api("GET", ""), this.api("GET", "/activity")]);
      if (seq !== this.seq) return;
      this.items = Array.isArray(list?.tokens) ? list.tokens : []; this.events = Array.isArray(activity?.items) ? activity.items : []; this.error = "";
    } catch (error) { if (seq !== this.seq) return; this.error = this.message(error); }
    finally { if (seq === this.seq) this.loading = false; }
    this.f.redraw();
  }
  // One GET /activity: refused requests are logged after the list was loaded, so they only show after this (or a full Refresh).
  async refreshActivity() {
    if (this.activityLoading || this.loading) return;
    const seq = this.seq; this.activityLoading = true; this.activityError = ""; this.f.redraw();
    try {
      const activity = await this.api("GET", "/activity");
      if (seq !== this.seq) return;
      this.events = Array.isArray(activity?.items) ? activity.items : [];
    } catch (error) { if (seq !== this.seq) return; this.activityError = this.message(error); }
    finally { if (seq === this.seq) this.activityLoading = false; }
    this.f.redraw();
  }

  // ---- Body: toolbar, tab strip, then the chosen tab
  toolbarHtml() {
    // The same toolbar on every tab (nothing moves when switching): on Documentation, Refresh keeps its place but is hidden and
    // out of the tab order; the active-key count stays.
    const docs = this.tab === "docs", activity = this.tab === "activity", busy = this.loading || (activity && this.activityLoading);
    const refresh = docs ? `<button type="button" class="fx-btn fx-api__placeholder" disabled aria-hidden="true" tabindex="-1">${icon("refresh")}<span>Refresh</span></button>` : `<button type="button" class="fx-btn" data-action="${activity ? "fabric-api-activity-refresh" : "fabric-api-refresh"}" data-focus-key="api-refresh" ${busy ? 'disabled aria-busy="true"' : ""} title="${activity ? "Load the latest activity" : "Reload the keys and their activity"}">${icon("refresh")}<span>${busy ? "Refreshing…" : "Refresh"}</span></button>`;
    const count = Array.isArray(this.items) ? this.items.filter((t) => t.status === "active").length : null;
    const context = `<span class="fx-toolbar__context"${count === null ? ' aria-hidden="true"' : ""}><span class="fx-toolbar__label">Active keys</span> <strong>${count === null ? "–" : count.toLocaleString()}</strong></span>`;
    return `<div class="fx-toolbar fx-api__toolbar" role="toolbar" aria-label="API keys"><button type="button" class="fx-btn" data-action="fabric-api-new">${icon("plus")}<span>Create key</span></button>${refresh}<span class="fx-sep" aria-hidden="true"></span><span class="fx-api__note">${icon("lock")}<span>Read-only keys for Sales and Inventory</span></span><span class="fx-toolbar__spacer"></span>${context}</div>`;
  }
  tabsHtml() {
    return `<div class="fx-tabs fx-api__tabs apitok-tabs fabric-tabs" role="tablist" aria-label="API Management sections">${FabricApiPanel.TABS.map(([id, label]) => {
      const on = id === this.tab, n = id === "tokens" && Array.isArray(this.items) ? ` (${this.items.length})` : "";
      return `<button type="button" role="tab" id="fabric-atab-${id}" data-action="fabric-api-tab" data-tab="${id}" aria-selected="${on}" aria-controls="fabric-api-body" tabindex="${on ? 0 : -1}" class="fx-tab${on ? " is-active active" : ""}" data-text="${label}${n}">${label}${n}</button>`;
    }).join("")}</div>`;
  }
  html() {
    let body;
    if (this.tab === "docs") body = typeof FabricApiDocs === "object" ? FabricApiDocs.html((v) => this.esc(v), window.location.origin) : "";
    else if (this.error && !this.items) body = `<div class="fx-status fx-status--error" role="alert"><span class="fx-status__msg"><strong>Fabric API keys couldn't be loaded.</strong> ${this.esc(this.error)}</span><button type="button" class="fx-btn" data-action="fabric-api-refresh" data-focus-key="retry">${icon("refresh")}<span>Try again</span></button></div>`;
    else if (!this.items) body = this.f.skeleton(6, 3);
    else body = this.tab === "activity" ? this.activityHtml() : this.tokensHtml();
    return `<section class="fx-api fabric-api fx-api--${this.tab}" aria-label="API Management">${this.toolbarHtml()}${this.tabsHtml()}<div id="fabric-api-body" class="fx-api__panel" role="tabpanel" aria-labelledby="fabric-atab-${this.tab}">${body}</div></section>`;
  }
  // Datasets first, then the sensitive badge (warning tone); an unknown scope shows as its (escaped) name.
  scopeBadges(scopes) {
    const list = Array.isArray(scopes) ? scopes.filter((s) => typeof s === "string") : [];
    const order = (s) => (s === FabricApiPanel.SENSITIVE_SCOPE ? 1 : 0);
    return [...list].sort((a, b) => order(a) - order(b)).map((s) => `<span class="account-badge ${s === FabricApiPanel.SENSITIVE_SCOPE ? "is-warn fabric-sensitive" : ""}">${this.esc(FabricApiPanel.SCOPES[s] || s)}</span>`).join(" ") || `<span class="fx-null" title="No value" aria-label="No value">—</span>`;
  }
  tokensHtml() {
    const items = this.items || [];
    const note = `<p class="fx-status fx-status--info fx-api__intro" role="note"><span class="fx-status__msg">Every Fabric API key, whoever created it; any Fabric API administrator can revoke any key. Keys read only the datasets they were given through <code>/api/v1/external/fabric/…</code>, never boards, and stop working as soon as their owner loses Fabric Data access.</span></p>`;
    if (!items.length) return `${note}<div class="fx-grid__empty fx-api__empty"><strong>No Fabric API keys yet</strong><span>Create one per integration (Power BI, Power Automate, n8n or a script).</span></div>`;
    const rows = items.map((t) => {
      const [label, tone] = FabricApiPanel.STATUS[t.status] || [t.status || "Unknown", "muted"];
      const revoked = t.status === "revoked" && t.revokedBy?.name ? ` <small class="fx-api__sub">by ${this.esc(t.revokedBy.name)}</small>` : "";
      const requests = Number.isFinite(Number(t.requestCount)) ? Number(t.requestCount).toLocaleString() : "—";
      const action = t.status === "active" ? `<button type="button" class="fx-btn fx-btn--danger fx-btn--sm" data-action="fabric-api-revoke" data-id="${this.esc(t.id)}" data-focus-key="revoke-${this.esc(t.id)}" aria-label="Revoke ${this.esc(t.name)}">Revoke</button>` : "";
      return `<tr><th class="fx-grid__frozen" scope="row" data-label="Name"><strong>${this.esc(t.name)}</strong>${t.description ? `<small class="fx-api__sub" title="${this.esc(t.description)}">${this.esc(t.description)}</small>` : ""}</th><td data-label="Prefix" class="fx-api__mono"><code>${this.esc(t.prefix)}…</code></td><td data-label="Datasets">${this.scopeBadges(t.scopes)}</td><td data-label="Status"><span class="account-badge fx-api__status is-${tone}">${this.esc(label)}</span>${revoked}</td><td data-label="Owner">${this.esc(t.owner?.name || "A former user")}</td><td data-label="Created">${this.date(t.createdAt)}</td><td data-label="Expires">${t.status === "revoked" ? "—" : this.date(t.expiresAt)}</td><td data-label="Last used">${this.dateTime(t.lastUsedAt)}</td><td data-label="Requests" class="fx-grid__num fabric-num">${requests}</td><td data-label="" class="fx-api__actions">${action}</td></tr>`;
    }).join("");
    // With only a few keys the grid still fills the pane; a short hint sits in its empty area instead of a blank page.
    const hint = items.length < 6 ? `<div class="fx-api__gridhint"><span>${items.length === 1 ? "1 key" : `${items.length} keys`}. Create one key per integration (Power BI, Power Automate, n8n or a script), so each can be revoked on its own.</span><button type="button" class="fx-btn" data-action="fabric-api-new" data-focus-key="api-new-hint">${icon("plus")}<span>Create key</span></button></div>` : "";
    return `${note}<div class="fx-grid fx-api__grid${hint ? " has-hint" : ""}" role="region" aria-label="Fabric API keys" tabindex="0"><table class="fx-grid__table fabric-api-tokens"><thead><tr><th class="fx-grid__frozen">Name</th><th>Prefix</th><th>Datasets</th><th>Status</th><th>Owner</th><th>Created</th><th>Expires</th><th>Last used</th><th class="fx-grid__num">Requests</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table>${hint}</div>`;
  }
  activityHtml() {
    const events = this.events || [];
    const error = this.activityError ? `<div class="fx-status fx-status--error" role="alert"><span class="fx-status__msg"><strong>The activity couldn't be refreshed.</strong> ${this.esc(this.activityError)}</span></div>` : "";
    const note = `<p class="fx-status fx-status--info fx-api__intro" role="note"><span class="fx-status__msg">The latest entries of the Fabric key audit log: created, revoked, and refused or failed requests. It doesn't update by itself: use Refresh to see the newest entries.</span></p>`;
    if (!events.length) return `${note}${error}<div class="fx-grid__empty fx-api__empty"><span>No Fabric API key events yet.</span></div>`;
    const who = (p) => (p ? this.esc(p.name || "A former user") : `<span class="fx-null" title="No value" aria-label="No value">—</span>`);
    const rows = events.map((e) => `<tr><th class="fx-grid__frozen" scope="row" data-label="When">${this.dateTime(e.at, "—")}</th><td data-label="Event"><span class="account-badge is-${FabricApiPanel.FAILURES.has(e.action) ? "warn" : "ok"}">${this.esc(FabricApiPanel.EVENTS[e.action] || e.action)}</span>${e.reason ? ` <small class="fx-api__sub">(${this.esc(e.reason)})</small>` : ""}</td><td data-label="Key">${e.token ? `<strong>${this.esc(e.token.name || "Unknown key")}</strong>${e.token.prefix ? ` <code class="fx-api__mono">${this.esc(e.token.prefix)}…</code>` : ""}` : "—"}</td><td data-label="By">${who(e.actor || (e.actorName ? { name: e.actorName } : null))}</td><td data-label="Owner">${who(e.owner)}</td></tr>`).join("");
    return `${note}${error}<div class="fx-grid fx-api__grid" role="region" aria-label="Fabric API activity" tabindex="0" ${this.activityLoading ? 'aria-busy="true"' : ""}><table class="fx-grid__table fabric-api-activity"><thead><tr><th class="fx-grid__frozen">When</th><th>Event</th><th>Key</th><th>By</th><th>Owner</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ---- Dialogs (fx-dialog inside the app's overlay root, which handles Escape, outside clicks and the focus trap)
  dialogHead(id, title, { close = true } = {}) {
    return `<div class="fx-dialog__head"><h2 id="${id}" class="fx-dialog__title"><span class="fx-dialog__eyebrow">API Management</span>${this.esc(title)}</h2>${close ? `<button type="button" class="fx-btn fx-btn--icon" data-action="close-overlay" aria-label="Close">${icon("close")}</button>` : ""}</div>`;
  }

  // ---- Create key
  localDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  dateInput(days) { return this.localDate(new Date(Date.now() + days * 86400000)); }
  latestExpiry() {
    if (typeof ApiTokensPanel === "function" && ApiTokensPanel.latestExpiry) return ApiTokensPanel.latestExpiry();
    const now = new Date(), d = new Date(now); d.setUTCFullYear(now.getUTCFullYear() + FabricApiPanel.MAX_YEARS); return new Date(d.getTime() - 2 * 60 * 1000);
  }
  // The end of the chosen local day (clamped to the 5-year limit), or null for a date that isn't offered.
  endOfDay(value) {
    const text = String(value || ""), max = this.localDate(this.latestExpiry());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || text < this.dateInput(1) || text > max) return null;
    const [y, m, d] = text.split("-").map(Number), at = new Date(y, m - 1, d, 23, 59, 59);
    if (Number.isNaN(at.getTime()) || at.getDate() !== d) return null;
    const latest = this.latestExpiry();
    return (at > latest ? latest : at).toISOString();
  }
  showCreate(error = "", values = {}) {
    const chosen = Array.isArray(values.datasets) ? values.datasets : this.datasetScopes.map(([ds]) => ds);
    const datasets = this.datasetScopes.map(([ds, scope, label]) => `<label class="fx-api__check"><input type="checkbox" name="ds-${ds}" value="${ds}" ${chosen.includes(ds) ? "checked" : ""}> <span>${label}</span> <code class="fx-api__scope">${scope}</code></label>`).join("");
    const sensitive = this.canGrantSensitive ? `<label class="fx-api__check fx-api__check--sensitive"><input type="checkbox" name="sensitive" ${values.sensitive ? "checked" : ""}> <span>Sensitive fields</span> <code class="fx-api__scope">${FabricApiPanel.SENSITIVE_SCOPE}</code><small class="fx-api__hint">Adds the restricted cost and price fields of the chosen datasets (listed in Documentation). Only for integrations that need them.</small></label>` : "";
    this.view.overlay(`<form class="fx-dialog fx-api-dialog" role="dialog" aria-modal="true" data-action="fabric-api-create-form" aria-labelledby="fabric-api-new-title">${this.dialogHead("fabric-api-new-title", "Create API key")}
      <div class="fx-dialog__body"><p class="fx-api__lead">The key reads the Fabric datasets you choose, read-only. It can't reach boards.</p>
      <div class="fx-api__form">
      <label class="fx-api__field"><span class="fx-field__label">Name</span><input class="fx-input" name="name" required maxlength="100" autocomplete="off" value="${this.esc(values.name || "")}" placeholder="For example: Power BI sales report"></label>
      <label class="fx-api__field"><span class="fx-field__label">Description <small>(optional)</small></span><input class="fx-input" name="description" maxlength="500" autocomplete="off" value="${this.esc(values.description || "")}"></label>
      <label class="fx-api__field"><span class="fx-field__label">Expires on</span><input class="fx-input" type="date" name="expires" required min="${this.dateInput(1)}" max="${this.localDate(this.latestExpiry())}" value="${this.esc(values.expires || this.dateInput(90))}" aria-describedby="fabric-api-expiry-help"><small id="fabric-api-expiry-help" class="fx-api__hint">Any date from tomorrow up to ${FabricApiPanel.MAX_YEARS} years from today.</small></label>
      <fieldset class="fx-fieldgroup fx-api__scopes" aria-describedby="fabric-api-scope-help"><legend class="fx-fieldgroup__legend">Datasets (choose at least one)</legend>${datasets}${sensitive}<small id="fabric-api-scope-help" class="fx-api__hint">Every key is read-only.</small></fieldset>
      </div><p class="fx-api-dialog__error apitok-error" role="alert">${this.esc(error)}</p></div>
      <div class="fx-dialog__foot"><button type="button" class="fx-btn" data-action="close-overlay">Cancel</button><button type="submit" class="fx-btn fx-btn--primary">Create key</button></div></form>`, "apitok-overlay fx-api-overlay");
    this.focus('[data-action="fabric-api-create-form"] input[name="name"]');
  }
  async submitCreate(form) {
    const el = form.elements, datasets = this.datasetScopes.filter(([ds]) => Boolean(el[`ds-${ds}`]?.checked));
    const values = { name: String(el.name?.value || "").trim(), description: String(el.description?.value || "").trim(), expires: el.expires?.value, sensitive: Boolean(this.canGrantSensitive && el.sensitive?.checked) };
    const say = (text) => { const out = form.querySelector(".apitok-error"); if (out) out.textContent = text; };
    if (!values.name) { say("Give the key a name."); return; }
    if (!datasets.length) { say("Choose at least one dataset: Sales or Inventory."); return; }
    const expiresAt = this.endOfDay(values.expires);
    if (!expiresAt) { say(`Choose an expiry date from tomorrow up to ${FabricApiPanel.MAX_YEARS} years from today.`); return; }
    const body = { name: values.name, scopes: [...datasets.map(([, scope]) => scope), ...(values.sensitive ? [FabricApiPanel.SENSITIVE_SCOPE] : [])], expiresAt };
    if (values.description) body.description = values.description;
    const button = form.querySelector(".fx-btn--primary"); if (button) button.disabled = true;
    try { const result = await this.api("POST", "", body); this.reveal(result); }
    catch (error) { say(this.message(error)); if (button) button.disabled = false; }
  }
  // The one time a secret is shown: only as the value of #fabric-api-secret. Escape and outside clicks don't close it
  // (data-keep-open); "I've saved it" clears the input, then closes.
  reveal(result) {
    const secret = typeof result?.secret === "string" ? result.secret : "";
    const t = result?.token || {};
    const root = this.overlayRoot(); if (!root) return;
    root.innerHTML = `<div class="overlay apitok-overlay fx-api-overlay" data-keep-open="1"><div class="fx-dialog fx-api-dialog apitok-modal" role="dialog" aria-modal="true" aria-labelledby="fabric-api-reveal-title">${this.dialogHead("fabric-api-reveal-title", "API key created", { close: false })}
      <div class="fx-dialog__body"><div class="fx-status fx-status--warn" role="status"><span class="fx-status__msg"><strong>Copy this key now. It is shown once: you won't see it again.</strong> Keep it in a secure backend or an approved secret store, never in public JavaScript, an address or a shared file. Closing this window forgets it.</span></div>
      <div class="fx-api__secret apitok-secret"><input id="fabric-api-secret" class="fx-field__value fx-field__value--key" type="text" readonly spellcheck="false" autocomplete="off" aria-label="Your Fabric API key" value="${this.esc(secret)}"><button type="button" class="fx-btn" data-action="fabric-api-copy">${icon("copy")}<span>Copy key</span></button></div>
      <dl class="fx-api__review apikey-review"><div><dt>Name</dt><dd>${this.esc(t.name)}</dd></div><div><dt>Expires</dt><dd>${this.dateTime(t.expiresAt, "—")}</dd></div><div><dt>Datasets</dt><dd>Read-only · ${this.scopeBadges(t.scopes)}</dd></div><div><dt>Base URL</dt><dd><code>${this.esc(`${window.location.origin}/api/v1/external/fabric`)}</code></dd></div></dl></div>
      <div class="fx-dialog__foot"><button type="button" class="fx-btn fx-btn--primary" data-action="fabric-api-done">I've saved it</button></div></div></div>`;
    const input = typeof document !== "undefined" ? document.querySelector("#fabric-api-secret") : null;
    input?.focus?.(); input?.select?.();
  }
  async copySecret(button) {
    const input = typeof document !== "undefined" ? document.querySelector("#fabric-api-secret") : null;
    const secret = input?.value || "";
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret); }
    catch { input.select(); try { document.execCommand("copy"); } catch { this.view.toast("Select the key and copy it"); return; } }
    const label = button?.querySelector?.("span"); if (label) label.textContent = "Copied"; else if (button) button.textContent = "Copied";
    this.view.toast("Fabric API key copied");
  }
  done() {
    const input = typeof document !== "undefined" ? document.querySelector("#fabric-api-secret") : null;
    if (input) { input.value = ""; input.setAttribute?.("value", ""); }
    this.view.closeOverlay(); this.refresh();
  }

  // ---- Revoke (confirm first; focus starts on Cancel)
  showRevoke(t) {
    this.pending = t;
    this.view.overlay(`<form class="fx-dialog fx-api-dialog" role="dialog" aria-modal="true" data-action="fabric-api-revoke-form" aria-labelledby="fabric-api-revoke-title" aria-describedby="fabric-api-revoke-text">${this.dialogHead("fabric-api-revoke-title", `Revoke ${t.name || "this key"}?`)}
      <div class="fx-dialog__body"><div class="fx-status fx-status--warn"><span class="fx-status__msg" id="fabric-api-revoke-text">Anything using this key stops reading Fabric Data immediately. This can't be undone.${t.owner?.name ? ` It belongs to <strong>${this.esc(t.owner.name)}</strong>.` : ""}</span></div>
      <p class="fx-api-dialog__error apitok-error" role="alert"></p></div>
      <div class="fx-dialog__foot"><button type="button" class="fx-btn" data-action="close-overlay">Cancel</button><button type="submit" class="fx-btn fx-btn--danger">Revoke key</button></div></form>`, "apitok-overlay fx-api-overlay");
    this.focus('[data-action="fabric-api-revoke-form"] .fx-dialog__foot [data-action="close-overlay"]');
  }
  async submitRevoke(form) {
    const t = this.pending;
    if (!t) return;
    const button = form.querySelector(".fx-btn--danger"); if (button) button.disabled = true;
    try { await this.api("POST", `/${encodeURIComponent(t.id)}/revoke`, {}); this.pending = null; this.view.closeOverlay(); this.view.toast("Fabric API key revoked"); this.refresh(); }
    catch (error) { const el = form.querySelector(".apitok-error"); if (el) el.textContent = this.message(error); if (button) button.disabled = false; }
  }

  // ---- Events (FabricDataPanel passes every "fabric-api-…" action here)
  onAction(action, target) {
    if (action === "fabric-api-tab") { this.tab = FabricApiPanel.TABS.some(([id]) => id === target.dataset.tab) ? target.dataset.tab : "tokens"; this.f.redraw(); this.ensure(); this.f.focusTab("fabric-atab", this.tab); return; }
    if (action === "fabric-api-refresh") { this.refresh(); return; }
    if (action === "fabric-api-activity-refresh") { this.refreshActivity(); return; }
    if (action === "fabric-api-new") { this.showCreate(); return; }
    if (action === "fabric-api-revoke") { const t = (this.items || []).find((x) => x.id === target.dataset.id); if (t) this.showRevoke(t); return; }
    if (action === "fabric-api-copy") { this.copySecret(target); return; }
    if (action === "fabric-api-done") { this.done(); return; }
    if (action === "fabric-api-copy-example") { const el = document.querySelector(`#fabric-api-example-${CSS.escape(target.dataset.example || "")}`); if (el) navigator.clipboard?.writeText(el.textContent).then(() => this.view.toast("Example copied"), () => this.view.toast("Select the example and copy it")); }
  }
  // Arrow keys, Home and End on the tab strip: FabricDataPanel.onKeydown (".fabric-tabs [role=tab]", roving tabindex).
  onSubmit(action, form) {
    if (action === "fabric-api-create-form") { this.submitCreate(form); return; }
    if (action === "fabric-api-revoke-form") this.submitRevoke(form);
  }
}
