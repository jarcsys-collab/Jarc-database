// Fabric Data → API Management (Fabric API administrators only): read-only API tokens for the Fabric data, their activity, and the
// documentation. It follows the Developer Center (ApiTokensPanel.js / ApiKeyWizard.js): the same token list, one-time secret,
// revoke confirmation and styles. The server enforces every rule (/api/v1/fabric/api-tokens); this only shows what it reports.
//
// A new token's secret exists only as text in the one dialog that reveals it: never in browser storage, the model, an address or
// an example, and it is forgotten when that dialog closes or the session ends.
class FabricApiPanel {
  static TABS = [["tokens", "Tokens"], ["activity", "Activity"], ["docs", "Documentation"]];
  static STATUS = { active: ["Active", "ok"], expired: ["Expired", "muted"], revoked: ["Revoked", "muted"], no_access: ["No access", "danger"] };
  static EVENTS = { "token.created": "Created", "token.revoked": "Revoked", "token.auth_failed": "Wrong secret", "token.use_refused": "Request refused", "token.rate_limited": "Rate limited", "token.access_revoked": "Owner lost access" };
  static FAILURES = new Set(["token.auth_failed", "token.use_refused", "token.rate_limited", "token.access_revoked"]);
  // Dataset scopes (at least one per token) and the sensitive-fields scope (only with a dataset scope, only from sensitive readers).
  static DATASET_SCOPES = [["sales", "fabric.sales.read", "Sales"], ["inventory", "fabric.inventory.read", "Inventory"]];
  static SENSITIVE_SCOPE = "fabric.sensitive.read";
  static SCOPES = { "fabric.sales.read": "Sales", "fabric.inventory.read": "Inventory", "fabric.sensitive.read": "Sensitive fields" };
  static CODES = {
    FABRIC_API_ADMIN_REQUIRED: "Only Fabric API administrators can manage Fabric API tokens.",
    FABRIC_DATA_FORBIDDEN: "You don't have access to Fabric Data.",
    TOKEN_LIMIT_REACHED: "You've reached the limit of active tokens. Revoke one you no longer need.",
    TOKEN_NOT_ACTIVE: "This token has already ended.",
    INSUFFICIENT_SCOPE: "You can't grant sensitive fields: only Fabric API administrators who may see them can.",
    VALIDATION_ERROR: "Check the name, the expiry date and the datasets (choose at least one), then try again.",
    RATE_LIMITED: "Too many requests in a short time. Wait a few seconds, then try again."
  };
  static MAX_YEARS = 5;

  constructor(fabric) { this.f = fabric; this.forget(); }
  forget() { this.tab = "tokens"; this.items = null; this.events = null; this.loading = false; this.error = ""; this.secret = null; this.pending = null; this.seq = (this.seq || 0) + 1; }
  get c() { return this.f.c; }
  get view() { return this.c.view; }
  get adapter() { return this.f.adapter; }
  // features.fabricData.sensitive (cost: its older name, kept by the server for one release).
  get canGrantSensitive() { const f = this.f.features; return Boolean(f && (f.sensitive === true || (f.sensitive === undefined && f.cost === true))); }
  // The datasets a token may be given: those /features lists (both when it lists none).
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

  ensure() { if (this.tab !== "docs" && !this.items && !this.loading && !this.error) this.load(); }
  refresh() { this.items = null; this.events = null; this.error = ""; this.load(); }
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

  html() {
    const tabs = FabricApiPanel.TABS.map(([id, label]) => { const on = id === this.tab; return `<button type="button" role="tab" id="fabric-atab-${id}" data-action="fabric-api-tab" data-tab="${id}" aria-selected="${on}" aria-controls="fabric-api-body" tabindex="${on ? 0 : -1}" class="${on ? "active" : ""}">${label}</button>`; }).join("");
    let body;
    if (this.tab === "docs") body = typeof FabricApiDocs === "object" ? FabricApiDocs.html((v) => this.esc(v), window.location.origin) : "";
    else if (this.error && !this.items) body = `<div class="integration-alert" role="alert"><strong>Fabric API tokens couldn't be loaded.</strong><span>${this.esc(this.error)}</span><div class="fabric-alert-actions"><button type="button" class="button secondary small" data-action="fabric-api-refresh" data-focus-key="retry">${icon("refresh")} Try again</button></div></div>`;
    else if (!this.items) body = this.f.skeleton(6, 3);
    else body = this.tab === "activity" ? this.activityHtml() : this.tokensHtml();
    return `<div class="account-alert is-ok fabric-api-intro" role="note"><strong>Fabric API tokens are read-only.</strong><span>They read the Sales and Inventory datasets they were given through <code>/api/v1/external/fabric/…</code>, never boards, and nothing they do can change data. Each token is limited to a set number of requests per minute, and stops working as soon as its owner loses Fabric Data access.</span></div>
      <div class="apitok-tabs fabric-tabs" role="tablist" aria-label="Fabric API sections">${tabs}</div><div id="fabric-api-body" role="tabpanel" aria-labelledby="fabric-atab-${this.tab}">${body}</div>`;
  }
  // Datasets first, then the sensitive badge (warning tone); an unknown scope shows as its (escaped) name.
  scopeBadges(scopes) {
    const list = Array.isArray(scopes) ? scopes.filter((s) => typeof s === "string") : [];
    const order = (s) => (s === FabricApiPanel.SENSITIVE_SCOPE ? 1 : 0);
    return [...list].sort((a, b) => order(a) - order(b)).map((s) => `<span class="account-badge ${s === FabricApiPanel.SENSITIVE_SCOPE ? "is-warn fabric-sensitive" : ""}">${this.esc(FabricApiPanel.SCOPES[s] || s)}</span>`).join(" ") || `<span class="muted">—</span>`;
  }
  tokensHtml() {
    const items = this.items || [];
    const intro = `<div class="apitok-intro fabric-api-head"><p>Every Fabric API token, whoever created it. Any Fabric API administrator can revoke any token.</p><button type="button" class="button primary" data-action="fabric-api-new">${icon("plus")}<span>New Fabric token</span></button></div>`;
    if (!items.length) return `${intro}<div class="quiet-empty">${icon("lock")}<span><strong>No Fabric API tokens yet</strong><small>Create one per integration (Power BI, Power Automate, n8n or a script).</small></span></div>`;
    const rows = items.map((t) => {
      const [label, tone] = FabricApiPanel.STATUS[t.status] || [t.status || "Unknown", "muted"];
      const revoked = t.status === "revoked" && t.revokedBy?.name ? `<small>by ${this.esc(t.revokedBy.name)}</small>` : "";
      return `<tr><td data-label="Token"><strong>${this.esc(t.name)}</strong>${t.description ? `<small>${this.esc(t.description)}</small>` : ""}<small><code>${this.esc(t.prefix)}…</code></small></td><td data-label="Datasets">${this.scopeBadges(t.scopes)}</td><td data-label="Status"><span class="account-badge is-${tone}">${this.esc(label)}</span>${revoked}</td><td data-label="Owner">${this.esc(t.owner?.name || "A former user")}</td><td data-label="Created">${this.date(t.createdAt)}</td><td data-label="Expires">${t.status === "revoked" ? "—" : this.date(t.expiresAt)}</td><td data-label="Last used">${this.dateTime(t.lastUsedAt)}</td><td data-label="Requests" class="fabric-num">${Number.isFinite(Number(t.requestCount)) ? Number(t.requestCount).toLocaleString() : "—"}</td><td data-label="">${t.status === "active" ? `<button type="button" class="button secondary small danger-text" data-action="fabric-api-revoke" data-id="${this.esc(t.id)}" data-focus-key="revoke-${this.esc(t.id)}">Revoke</button>` : ""}</td></tr>`;
    }).join("");
    return `${intro}<div class="fabric-scroll" tabindex="0" aria-label="Fabric API tokens"><table class="fabric-table fabric-api-tokens"><thead><tr><th>Token</th><th>Datasets</th><th>Status</th><th>Owner</th><th>Created</th><th>Expires</th><th>Last used</th><th class="fabric-num">Requests</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  activityHtml() {
    const events = this.events || [];
    if (!events.length) return `<p class="integration-note">No Fabric API token events yet.</p>`;
    const who = (p) => (p ? this.esc(p.name || "A former user") : `<span class="muted">—</span>`);
    const rows = events.map((e) => `<tr><td data-label="When">${this.dateTime(e.at, "—")}</td><td data-label="Event"><span class="account-badge is-${FabricApiPanel.FAILURES.has(e.action) ? "warn" : "ok"}">${this.esc(FabricApiPanel.EVENTS[e.action] || e.action)}</span>${e.reason ? ` <small class="muted">(${this.esc(e.reason)})</small>` : ""}</td><td data-label="Token">${e.token ? `<strong>${this.esc(e.token.name || "Unknown token")}</strong>${e.token.prefix ? `<small><code>${this.esc(e.token.prefix)}…</code></small>` : ""}` : "—"}</td><td data-label="By">${who(e.actor || (e.actorName ? { name: e.actorName } : null))}</td><td data-label="Owner">${who(e.owner)}</td></tr>`).join("");
    return `<p class="account-note">The latest entries of the Fabric token audit log: created, revoked, and refused or failed requests.</p><div class="fabric-scroll" tabindex="0" aria-label="Fabric API activity"><table class="fabric-table"><thead><tr><th>When</th><th>Event</th><th>Token</th><th>By</th><th>Owner</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ---- New token
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
    const datasets = this.datasetScopes.map(([ds, , label]) => `<label class="fabric-check"><input type="checkbox" name="ds-${ds}" value="${ds}" ${chosen.includes(ds) ? "checked" : ""}> ${label}</label>`).join("");
    const sensitive = this.canGrantSensitive ? `<label class="fabric-check"><input type="checkbox" name="sensitive" ${values.sensitive ? "checked" : ""}> Sensitive fields <small class="muted">Cost and price fields of the chosen datasets are added to the answers. Only for integrations that need them.</small></label>` : "";
    this.view.overlay(`<form class="modal apitok-modal" data-action="fabric-api-create-form" aria-labelledby="fabric-api-new-title"><div class="modal-head"><div><div class="eyebrow">API Management</div><h2 id="fabric-api-new-title">New Fabric token</h2></div>${this.view.closeButton()}</div>
      <p>The token reads the Fabric datasets you choose, read-only. It can't reach boards.</p>
      <div class="form-grid"><label class="full">Name<input name="name" required maxlength="100" autocomplete="off" value="${this.esc(values.name || "")}" placeholder="For example: Power BI sales report"></label>
      <label class="full">Description <small class="muted">(optional)</small><input name="description" maxlength="500" autocomplete="off" value="${this.esc(values.description || "")}"></label>
      <label class="full">Expires on<input type="date" name="expires" required min="${this.dateInput(1)}" max="${this.localDate(this.latestExpiry())}" value="${this.esc(values.expires || this.dateInput(90))}" aria-describedby="fabric-api-expiry-help"><small id="fabric-api-expiry-help" class="muted">Any date from tomorrow up to ${FabricApiPanel.MAX_YEARS} years from today.</small></label>
      <fieldset class="full fabric-scopes" aria-describedby="fabric-api-scope-help"><legend>Datasets (choose at least one)</legend>${datasets}${sensitive}<small id="fabric-api-scope-help" class="muted">Every token is read-only.</small></fieldset></div>
      <p class="account-empty apitok-error" role="alert">${this.esc(error)}</p>
      <div class="modal-actions"><button type="button" class="button secondary" data-action="close-overlay">Cancel</button><button class="button primary">Create token</button></div></form>`, "apitok-overlay");
    if (typeof document !== "undefined") document.querySelector('[data-action="fabric-api-create-form"] input[name="name"]')?.focus?.();
  }
  async submitCreate(form) {
    const el = form.elements, datasets = this.datasetScopes.filter(([ds]) => Boolean(el[`ds-${ds}`]?.checked));
    const values = { name: String(el.name?.value || "").trim(), description: String(el.description?.value || "").trim(), expires: el.expires?.value, sensitive: Boolean(this.canGrantSensitive && el.sensitive?.checked) };
    const say = (text) => { const out = form.querySelector(".apitok-error"); if (out) out.textContent = text; };
    if (!values.name) { say("Give the token a name."); return; }
    if (!datasets.length) { say("Choose at least one dataset: Sales or Inventory."); return; }
    const expiresAt = this.endOfDay(values.expires);
    if (!expiresAt) { say(`Choose an expiry date from tomorrow up to ${FabricApiPanel.MAX_YEARS} years from today.`); return; }
    const body = { name: values.name, scopes: [...datasets.map(([, scope]) => scope), ...(values.sensitive ? [FabricApiPanel.SENSITIVE_SCOPE] : [])], expiresAt };
    if (values.description) body.description = values.description;
    const button = form.querySelector("button.primary"); if (button) button.disabled = true;
    try { const result = await this.api("POST", "", body); this.reveal(result); }
    catch (error) { say(this.message(error)); if (button) button.disabled = false; }
  }
  // The one time a secret is shown. Escape and outside clicks don't close it (data-keep-open).
  reveal(result) {
    this.secret = typeof result?.secret === "string" ? result.secret : null;
    const t = result?.token || {};
    document.querySelector("#overlay-root").innerHTML = `<div class="overlay apitok-overlay" data-keep-open="1"><div class="modal apitok-modal" role="dialog" aria-modal="true" aria-labelledby="fabric-api-reveal-title"><div class="modal-head"><div><div class="eyebrow">${this.esc(t.name)}</div><h2 id="fabric-api-reveal-title">Fabric token created</h2></div></div>
      <div class="account-alert is-warn" role="status"><strong>Copy this token now. You won't see it again.</strong><span>Keep it in a secure backend or an approved secret store, never in public JavaScript, an address or a shared file. Closing this window forgets it.</span></div>
      <div class="apitok-secret"><input id="fabric-api-secret" type="text" readonly spellcheck="false" autocomplete="off" aria-label="Your Fabric API token" value="${this.esc(this.secret || "")}"><button type="button" class="button primary" data-action="fabric-api-copy">Copy token</button></div>
      <dl class="apikey-review"><div><dt>Name</dt><dd>${this.esc(t.name)}</dd></div><div><dt>Expires</dt><dd>${this.dateTime(t.expiresAt, "—")}</dd></div><div><dt>Datasets</dt><dd>Read-only ·${this.scopeBadges(t.scopes)}</dd></div><div><dt>Base URL</dt><dd><code>${this.esc(`${window.location.origin}/api/v1/external/fabric`)}</code></dd></div></dl>
      <div class="modal-actions"><button type="button" class="button primary" data-action="fabric-api-done">I've saved it</button></div></div></div>`;
    document.querySelector("#fabric-api-secret")?.select?.();
  }
  async copySecret(button) {
    const input = document.querySelector("#fabric-api-secret");
    if (!this.secret || !input) return;
    try { await navigator.clipboard.writeText(this.secret); }
    catch { input.select(); try { document.execCommand("copy"); } catch { this.view.toast("Select the token and copy it"); return; } }
    button.textContent = "Copied"; this.view.toast("Fabric token copied");
  }
  done() { this.secret = null; this.view.closeOverlay(); this.refresh(); }

  // ---- Revoke
  showRevoke(t) {
    this.pending = t;
    this.view.overlay(`<form class="modal confirm-modal" data-action="fabric-api-revoke-form"><div class="confirm-icon">!</div><h2>Revoke ${this.esc(t.name)}?</h2><p>Anything using this token stops reading Fabric Data immediately. This can't be undone.${t.owner?.name ? ` It belongs to <strong>${this.esc(t.owner.name)}</strong>.` : ""}</p><p class="account-empty apitok-error" role="alert"></p><div class="modal-actions"><button type="button" class="button secondary" data-action="close-overlay">Cancel</button><button class="button danger-button">Revoke token</button></div></form>`, "apitok-overlay");
  }
  async submitRevoke(form) {
    const t = this.pending;
    if (!t) return;
    const button = form.querySelector("button.danger-button"); if (button) button.disabled = true;
    try { await this.api("POST", `/${encodeURIComponent(t.id)}/revoke`, {}); this.pending = null; this.view.closeOverlay(); this.view.toast("Fabric token revoked"); this.refresh(); }
    catch (error) { const el = form.querySelector(".apitok-error"); if (el) el.textContent = this.message(error); if (button) button.disabled = false; }
  }

  // ---- Events (FabricDataPanel passes every "fabric-api-…" action here)
  onAction(action, target) {
    if (action === "fabric-api-tab") { this.tab = FabricApiPanel.TABS.some(([id]) => id === target.dataset.tab) ? target.dataset.tab : "tokens"; this.f.redraw(); this.ensure(); this.f.focusTab("fabric-atab", this.tab); return; }
    if (action === "fabric-api-refresh") { this.refresh(); return; }
    if (action === "fabric-api-new") { this.showCreate(); return; }
    if (action === "fabric-api-revoke") { const t = (this.items || []).find((x) => x.id === target.dataset.id); if (t) this.showRevoke(t); return; }
    if (action === "fabric-api-copy") { this.copySecret(target); return; }
    if (action === "fabric-api-done") { this.done(); return; }
    if (action === "fabric-api-copy-example") { const el = document.querySelector(`#fabric-api-example-${CSS.escape(target.dataset.example || "")}`); if (el) navigator.clipboard?.writeText(el.textContent).then(() => this.view.toast("Example copied"), () => this.view.toast("Select the example and copy it")); }
  }
  onSubmit(action, form) {
    if (action === "fabric-api-create-form") { this.submitCreate(form); return; }
    if (action === "fabric-api-revoke-form") this.submitRevoke(form);
  }
}
