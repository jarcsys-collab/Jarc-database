// Integrations page (monday.com, one-way into JARC): connection card, setup instructions, sync dashboard and the
// import wizard. Shows only what the server reports (GET /api/v1/integrations/monday) — never a pretend connection.
// Tokens never reach the browser: "Connect" asks the server for monday.com's authorization URL and goes there.
class IntegrationsPanel {
  constructor(controller) {
    this.c = controller; this.status = null; this.error = ""; this.loading = false; this.timer = null;
    this.wizard = null; // { step, workspaces, boards, selected:Set, preview, sourceWorkspace }
    const params = new URLSearchParams(window.location.search);
    if (params.get("integration") === "monday") {
      this.returned = { result: params.get("result"), code: params.get("code") };
      params.delete("integration"); params.delete("result"); params.delete("code");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }
  }
  get view() { return this.c.view; }
  get adapter() { return this.c.model.storage?.adapter; }
  get available() { return this.adapter?.mode === "resource"; }
  esc(v) { return this.view.escape(v ?? ""); }
  api(method, path, body) { return this.adapter.request(method, `/integrations/monday${path}`, body); }

  // Called after sign-in: an OAuth return opens the page and says how it went.
  afterStart() {
    if (!this.returned) return;
    const { result, code } = this.returned; this.returned = null;
    this.c.model.openScreen("integrations"); this.c.update();
    const messages = { connected: "monday.com connected", cancelled: "monday.com connection cancelled" };
    this.view.toast(messages[result] || `monday.com wasn't connected${code ? ` (${code})` : ""}`);
  }
  // Rendered into the main area; data arrives asynchronously, then only #integrations-root is redrawn.
  html() {
    if (!this.status && !this.loading && this.available) setTimeout(() => this.load(), 0);
    return `<section class="page-head"><div><div class="eyebrow">Settings</div><h1>Integrations</h1><p>Bring data from other tools into JARC. Imported boards are read-only copies that stay in sync.</p></div><div class="page-actions"><button class="button secondary" data-action="integration-refresh">${icon("refresh")}<span>Refresh</span></button></div></section><div id="integrations-root" class="integrations">${this.body()}</div>`;
  }
  redraw() { const root = document.querySelector("#integrations-root"); if (root) root.innerHTML = this.body(); }

  async load() {
    if (!this.available) return;
    this.loading = true;
    try { this.status = await this.api("GET", ""); this.error = ""; }
    catch (error) { this.error = error?.message || "Integrations couldn't be loaded."; }
    finally { this.loading = false; }
    this.redraw(); this.schedule();
  }
  // While imports or syncs are running, the dashboard refreshes itself (only while this page is open).
  schedule() {
    clearTimeout(this.timer);
    const busy = (this.status?.imports || []).some((j) => ["queued", "running", "retry"].includes(j.status));
    if (busy) this.timer = setTimeout(() => { if (this.c.model.screen === "integrations" && document.visibilityState === "visible") this.load(); }, 5000);
  }

  body() {
    if (!this.available) return this.view.blank("work", "Integrations need the JARC server", "Sign in to the shared JARC server to connect other tools. This copy is running on its own.");
    if (this.error && !this.status) return `<div class="integration-alert" role="alert">${this.esc(this.error)} <button class="link-button" data-action="integration-refresh">Try again</button></div>`;
    if (!this.status) return `<div class="integration-card is-loading" aria-busy="true"><p>Loading integrations…</p></div>`;
    return `${this.card(this.status)}${this.status.connected ? this.dashboard(this.status) : ""}`;
  }

  badge(s) {
    const map = { setup_required: ["Setup required", "warn"], disabled: ["Turned off", "muted"], not_connected: ["Not connected", "muted"], connected: ["Connected", "ok"], needs_reconnect: ["Reconnect needed", "warn"] };
    const [label, tone] = map[s.state] || ["Unknown", "muted"];
    return `<span class="integration-badge is-${tone}">${label}</span>`;
  }
  card(s) {
    const admin = s.canManage;
    let actions = "", note = "";
    if (s.state === "setup_required") note = admin ? this.setupHelp(s) : `<p class="integration-note">An administrator needs to set up monday.com on the JARC server first.</p>`;
    else if (s.state === "disabled") note = `<p class="integration-note">monday.com is configured but switched off on this server${admin ? " (MONDAY_INTEGRATION_ENABLED is not <code>true</code>)" : ""}.</p>`;
    else if (!admin) note = `<p class="integration-note">Only JARC administrators can connect or change integrations.</p>`;
    else if (!s.connected) actions = `<button class="button primary" data-action="integration-connect">Connect monday.com</button>`;
    else actions = `<button class="button secondary" data-action="integration-test">Test connection</button>${s.state === "needs_reconnect" ? `<button class="button primary" data-action="integration-connect">Reconnect</button>` : ""}<button class="button secondary" data-action="integration-disconnect">Disconnect</button>`;
    const account = s.connected && s.account ? `<dl class="integration-facts"><div><dt>Account</dt><dd>${this.esc(s.account.name || "—")}</dd></div><div><dt>Connected by</dt><dd>${this.esc(s.account.user || "—")}</dd></div><div><dt>Since</dt><dd>${this.date(s.account.connectedAt)}</dd></div></dl>` : "";
    return `<article class="integration-card" aria-labelledby="int-monday-title"><header class="integration-head"><span class="integration-logo" aria-hidden="true">m</span><div><h2 id="int-monday-title">monday.com</h2><p>Import monday.com boards into JARC and keep them updated. Data flows one way: JARC never changes anything in monday.com.</p></div>${this.badge(s)}</header>
      <ul class="integration-features"><li>Import boards with their groups, columns and items</li><li>Status, numbers, dates, email, phone, links and checkboxes keep their type; other columns arrive as text; files and sub-items aren't imported</li><li>Imported boards are read-only in JARC and update from monday.com</li><li>Sync stays off until an administrator turns it on</li></ul>
      ${account}${note}${actions ? `<div class="integration-actions">${actions}</div>` : ""}</article>`;
  }
  setupHelp(s) {
    const missing = (s.missing || []).map((k) => `<code>${this.esc(k)}</code>`).join(", ");
    return `<div class="integration-setup"><h3>Setup required</h3><p>monday.com can't be connected until the server has its OAuth app settings. Missing: ${missing || "—"}.</p><ol>
      <li>In monday.com's Developer Center, create an app and note its <strong>Client ID</strong>, <strong>Client secret</strong> and <strong>Signing secret</strong>.</li>
      <li>Add the redirect URL <code>https://&lt;your JARC address&gt;/api/v1/integrations/monday/callback</code> and the read scopes <code>me:read boards:read workspaces:read</code>.</li>
      <li>On the server set <code>MONDAY_CLIENT_ID</code>, <code>MONDAY_CLIENT_SECRET</code>, <code>MONDAY_SIGNING_SECRET</code>, <code>MONDAY_REDIRECT_URI</code> and <code>MONDAY_TOKEN_KEY</code> (32 random bytes, base64), then <code>MONDAY_INTEGRATION_ENABLED=true</code>, and restart.</li>
      <li>Return here and choose <strong>Connect monday.com</strong>.</li></ol></div>`;
  }
  dashboard(s) {
    const admin = s.canManage, sync = s.sync;
    const syncState = !sync.enabled ? "Off" : sync.paused ? "Paused" : "On";
    const syncButtons = !admin ? "" : !sync.enabled ? `<button class="button secondary" data-action="integration-sync" data-set="enable">Turn on sync</button>`
      : `${sync.paused ? `<button class="button secondary" data-action="integration-sync" data-set="resume">Resume</button>` : `<button class="button secondary" data-action="integration-sync" data-set="pause">Pause</button><button class="button secondary" data-action="integration-sync-now">Sync now</button>`}<button class="button secondary" data-action="integration-sync" data-set="disable">Turn off sync</button>`;
    const boards = s.importedBoards.length ? `<table class="integration-table"><thead><tr><th>JARC board</th><th>monday.com board</th><th>Last synced</th></tr></thead><tbody>${s.importedBoards.map((b) => `<tr><td>${b.missing ? `<span class="muted">Deleted</span>` : `<button class="link-button" data-action="integration-open-board" data-board="${this.esc(b.boardId)}">${this.esc(b.name)}</button>`}</td><td>${this.esc(b.sourceBoardId)}</td><td>${this.date(b.lastSyncedAt)}</td></tr>`).join("")}</tbody></table>` : `<p class="integration-empty">No boards imported yet.${admin ? " Choose <strong>Import boards</strong> to pick some." : ""}</p>`;
    const jobs = (list, empty) => list.length ? `<table class="integration-table"><thead><tr><th>Operation</th><th>Board</th><th>Status</th><th>When</th><th></th></tr></thead><tbody>${list.map((j) => `<tr><td>${this.esc({ import: "Import", reconcile: "Full sync", "sync-item": "Item update" }[j.type] || j.type)}${j.progress ? ` <small>${this.esc(j.progress.imported)} records</small>` : ""}</td><td>${this.esc(j.sourceBoardId || "—")}</td><td><span class="job-status is-${this.esc(j.status)}">${this.esc(j.status)}</span>${j.error ? `<small class="job-error">${this.esc(j.error)}</small>` : ""}</td><td>${this.date(j.finishedAt || j.createdAt)}</td><td>${admin && j.status === "failed" ? `<button class="button secondary small" data-action="integration-retry" data-id="${this.esc(j.id)}">Retry</button>` : ""}</td></tr>`).join("")}</tbody></table>` : `<p class="integration-empty">${empty}</p>`;
    return `<section class="integration-dashboard" aria-label="monday.com sync">
      <div class="integration-stats"><div><span>Sync</span><strong>${syncState}</strong></div><div><span>Last successful sync</span><strong>${this.date(sync.lastSyncAt)}</strong></div><div><span>Imported boards</span><strong>${s.importedBoards.length}</strong></div><div><span>Failed operations</span><strong>${s.failed.length}</strong></div></div>
      ${admin && sync.lastError ? `<div class="integration-alert" role="status">Last problem: ${this.esc(sync.lastError)}</div>` : ""}
      <div class="integration-actions">${admin ? `<button class="button primary" data-action="integration-import">Import boards</button>` : ""}${syncButtons}</div>
      <h3>Imported boards</h3>${boards}
      ${admin ? `<h3>Failed operations</h3>${jobs(s.failed, "Nothing has failed.")}<h3>Import history</h3>${jobs(s.imports, "No imports yet.")}` : ""}
    </section>`;
  }
  date(iso) { if (!iso) return "Never"; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : this.esc(d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })); }

  // ---- Actions (data-action="integration-…")
  async onAction(action, target) {
    try {
      if (action === "integration-refresh") return this.load();
      if (action === "integration-open-board") { const id = target.dataset.board, ws = this.c.model.workspaces.find((w) => w.boards.some((b) => String(b.id) === id)); if (ws) { this.c.model.openBoard(id, ws.id); this.c.update(); } return; }
      if (action === "integration-connect") return this.view.showConfirm("Connect monday.com?", "You'll go to monday.com to sign in and approve read-only access for JARC. Nothing is imported or synced until you choose to.", "integration-connect-go", "", "Continue to monday.com");
      if (action === "integration-connect-go") { this.view.closeOverlay(); const { authorizeUrl } = await this.api("POST", "/connect"); if (/^https:\/\//.test(authorizeUrl)) window.location.assign(authorizeUrl); return; }
      if (action === "integration-disconnect") return this.view.showConfirm("Disconnect monday.com?", "JARC forgets the monday.com access and stops syncing. Boards already imported stay in JARC, read-only.", "integration-disconnect-go", "", "Disconnect");
      if (action === "integration-disconnect-go") { this.view.closeOverlay(); await this.api("POST", "/disconnect"); this.view.toast("monday.com disconnected"); return this.load(); }
      if (action === "integration-test") { const r = await this.api("POST", "/test"); this.view.toast(`Connection works${r.account ? ` · ${r.account}` : ""}`); return this.load(); }
      if (action === "integration-sync") {
        const set = { enable: { syncEnabled: true }, disable: { syncEnabled: false }, pause: { paused: true }, resume: { paused: false } }[target.dataset.set];
        if (set) { await this.api("POST", "/sync", set); this.view.toast({ enable: "Sync turned on", disable: "Sync turned off", pause: "Sync paused", resume: "Sync resumed" }[target.dataset.set]); }
        return this.load();
      }
      if (action === "integration-sync-now") { const r = await this.api("POST", "/sync-now"); this.view.toast(r.jobs.length ? "Sync started" : "A sync is already running"); return this.load(); }
      if (action === "integration-retry") { await this.api("POST", `/jobs/${encodeURIComponent(target.dataset.id)}/retry`); this.view.toast("Retrying"); return this.load(); }
      if (action === "integration-import") { this.wizard = { step: "source", workspaces: null, boards: null, selected: new Set(), preview: null }; this.showWizard(); this.wizard.workspaces = await this.api("GET", "/workspaces").then((r) => r.items); return this.showWizard(); }
      if (action === "integration-wizard-workspace") { this.remember(target.closest("form")); this.wizard.selected = new Set(); this.wizard.sourceWorkspace = target.value || target.dataset.id; this.wizard.boards = null; this.showWizard(); this.wizard.boards = (await this.api("GET", `/boards?workspaceId=${encodeURIComponent(this.wizard.sourceWorkspace)}`)).items; return this.showWizard(); }
      if (action === "integration-wizard-preview") { this.remember(target.closest("form")); const id = target.dataset.id; this.wizard.step = "preview"; this.wizard.preview = null; this.showWizard(); this.wizard.preview = await this.api("GET", `/boards/${encodeURIComponent(id)}/preview`); return this.showWizard(); }
      if (action === "integration-wizard-back") { this.wizard.step = "source"; return this.showWizard(); }
    } catch (error) { this.view.closeOverlay(); this.view.showMessage("monday.com", error?.message || "That didn't work."); }
  }
  async onSubmit(action, data, form) {
    if (action !== "integration-import-form") return;
    const boardIds = [...form.querySelectorAll('input[name="board"]:checked')].map((i) => i.value);
    if (!boardIds.length) { this.view.toast("Choose at least one board"); return; }
    if (data.confirm !== "yes") { this.view.toast("Confirm the import first"); return; }
    try {
      await this.api("POST", "/imports", { boardIds, workspaceId: data.workspaceId, confirm: true });
      this.view.closeOverlay(); this.view.toast(`Import started for ${boardIds.length} board${boardIds.length === 1 ? "" : "s"}`); this.load();
    } catch (error) { this.view.showMessage("Import not started", error?.message || "That didn't work."); }
  }
  remember(form) { if (!form || !this.wizard) return; this.wizard.selected = new Set([...form.querySelectorAll('input[name="board"]:checked')].map((i) => i.value)); this.wizard.target = form.querySelector('select[name="workspaceId"]')?.value || this.wizard.target; }
  showWizard() {
    const w = this.wizard; if (!w) return;
    const loading = `<p class="integration-note" aria-busy="true">Loading from monday.com…</p>`;
    const imported = new Set((this.status?.importedBoards || []).map((b) => b.sourceBoardId));
    let body;
    if (w.step === "preview") {
      const p = w.preview;
      body = !p ? loading : `<p><strong>${this.esc(p.board.name)}</strong> · ${this.esc(p.board.itemsCount ?? "?")} items · groups: ${this.esc(p.board.groups.join(", ") || "—")}</p>
        <table class="integration-table"><thead><tr><th>monday.com column</th><th>Type</th><th>In JARC</th></tr></thead><tbody>${p.plan.map((c) => `<tr><td>${this.esc(c.title)}</td><td>${this.esc(c.sourceType)}</td><td>${c.targetType ? `${this.esc(c.targetType)}${c.handling === "imported as text" ? " <small>(as text)</small>" : ""}` : `<span class="muted">Not imported</span>`}</td></tr>`).join("")}</tbody></table>
        <h3>Sample records</h3>${p.sample.length ? `<table class="integration-table"><thead><tr>${p.columns.filter((c) => c.type !== "group").map((c) => `<th>${this.esc(c.label)}</th>`).join("")}</tr></thead><tbody>${p.sample.map((r) => `<tr>${p.columns.filter((c) => c.type !== "group").map((c) => `<td>${this.esc(Array.isArray(r[c.key]) ? r[c.key].join(", ") : typeof r[c.key] === "boolean" ? (r[c.key] ? "✓" : "") : r[c.key])}</td>`).join("")}</tr>`).join("")}</tbody></table>` : `<p class="integration-empty">This board has no items.</p>`}
        <div class="integration-actions"><button type="button" class="button secondary" data-action="integration-wizard-back">Back</button></div>`;
    } else {
      const spaces = w.workspaces, jarcSpaces = this.c.model.workspaces.filter((s) => !s.archived);
      body = !spaces ? loading : `<label class="field"><span>monday.com workspace</span><select data-action="integration-wizard-workspace"><option value="">Choose…</option>${spaces.map((s) => `<option value="${this.esc(s.id)}" ${s.id === w.sourceWorkspace ? "selected" : ""}>${this.esc(s.name)}</option>`).join("")}</select></label>
        ${!w.sourceWorkspace ? "" : !w.boards ? loading : w.boards.length ? `<fieldset class="integration-boards"><legend>Boards</legend>${w.boards.map((b) => `<div class="integration-board-row"><label><input type="checkbox" name="board" value="${this.esc(b.id)}" ${imported.has(String(b.id)) ? "disabled" : w.selected.has(String(b.id)) ? "checked" : ""}> ${this.esc(b.name)} <small>${this.esc(b.items_count ?? "?")} items${imported.has(String(b.id)) ? " · already imported" : ""}</small></label><button type="button" class="link-button" data-action="integration-wizard-preview" data-id="${this.esc(b.id)}">Preview</button></div>`).join("")}</fieldset>` : `<p class="integration-empty">No boards in this workspace.</p>`}
        <label class="field"><span>Create the new boards in</span><select name="workspaceId" required>${jarcSpaces.map((s) => `<option value="${this.esc(s.id)}" ${s.id === (w.target || this.c.model.currentWorkspaceId) ? "selected" : ""}>${this.esc(s.name)}</option>`).join("")}</select></label>
        <label class="integration-confirm"><input type="checkbox" name="confirm" value="yes"> I understand JARC will create new read-only boards and copy these monday.com items into them.</label>
        <div class="integration-actions"><button class="button primary" type="submit">Start import</button></div>`;
    }
    const html = `<form class="modal import-modal integration-wizard" data-action="integration-import-form"><div class="modal-head"><div><div class="eyebrow">monday.com</div><h2>${w.step === "preview" ? "Import preview" : "Import boards"}</h2></div>${this.view.closeButton()}</div>${body}</form>`;
    const open = document.querySelector("#overlay-root .integration-wizard");
    if (open) open.outerHTML = html; else this.view.overlay(html);
  }
}
