// Integrations page (monday.com, one-way into JARC): connection card, setup instructions, sync dashboard and the
// import wizard. Shows only what the server reports (GET /api/v1/integrations/monday) — never a pretend connection.
// Tokens never reach the browser: "Connect" asks the server for monday.com's authorization URL and goes there.
class IntegrationsPanel {
  constructor(controller) {
    this.c = controller; this.status = null; this.error = ""; this.loading = false; this.timer = null;
    this.wizard = null; // { step, workspaces, boards, selected:Set, preview, sourceWorkspace }
    const params = new URLSearchParams(window.location.search);
    if (["monday", "google-drive"].includes(params.get("integration"))) {
      this.returned = { provider: params.get("integration"), result: params.get("result"), code: params.get("code") };
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
    const { provider, result, code } = this.returned; this.returned = null;
    this.c.model.openScreen("integrations"); this.c.update();
    if (provider === "google-drive") { this.view.toast({ connected: "Google Drive connected", cancelled: "Google Drive connection cancelled" }[result] || this.driveProblem(code)); return; }
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
    try { this.status = await this.api("GET", ""); this.error = ""; await this.loadDrive(); }
    catch (error) { this.error = error?.message || "Integrations couldn't be loaded."; }
    finally { this.loading = false; }
    this.redraw(); this.schedule();
  }
  // Google Drive attachment storage: every signed-in employee sees its state; the server says whether this person may manage
  // it (canManage) and only then sends the details. While the server has it switched off the route doesn't exist and no card
  // is shown. Its own problems never hide the rest of the page.
  async loadDrive() {
    try { this.drive = await this.adapter.request("GET", "/integrations/google-drive"); this.driveError = ""; }
    catch (error) { this.drive = null; this.driveError = error?.code === StorageError.CODES.NOT_FOUND ? "" : error?.message || "Google Drive's status couldn't be loaded."; }
    // The Machine Installation Database attachment import: only for Drive administrators, only while the server has it on.
    this.mid = null;
    if (this.drive?.canManage) {
      try { this.mid = await this.adapter.request("GET", "/migrations/mid-attachments"); }
      catch (error) { this.mid = error?.code === StorageError.CODES.NOT_FOUND ? null : { error: error?.message || "The import's status couldn't be loaded." }; }
    }
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
    return `${this.card(this.status)}${this.status.connected ? this.dashboard(this.status) : ""}${this.driveCard()}${this.midCard()}`;
  }

  // ---- Machine Installation Database attachment import (Drive administrators; the server checks every action)
  midCard() {
    const m = this.mid;
    if (!m) return "";
    if (m.error) return `<div class="integration-alert" role="alert">${this.esc(m.error)}</div>`;
    const mb = (b) => `${(Number(b || 0) / 1048576).toFixed(1)} MB`;
    const dry = this.midDry ? (() => {
      const s = this.midDry.summary, cap = s.capacity || {};
      const capText = cap.error ? `couldn't be checked (${this.esc(cap.error)})` : `${cap.enough ? "enough" : `NOT enough (${this.esc((cap.problems || []).join(", "))})`} · Google Drive free ${cap.drive?.freeBytes === null ? "unlimited" : mb(cap.drive?.freeBytes)} · JARC limit free ${mb(cap.jarc?.freeBytes)}`;
      const src = s.sources ? `<div><dt>On monday.com</dt><dd>${s.sources.available} of ${s.sources.checked} available${s.sources.missing ? `, ${s.sources.missing} missing` : ""}${s.sources.sizeChanged ? `, ${s.sources.sizeChanged} changed` : ""}</dd></div>` : "";
      return `<h3>Dry run (nothing was written)</h3><dl class="integration-facts"><div><dt>Run</dt><dd><code>${this.esc(s.runId)}</code></dd></div><div><dt>Files</dt><dd>${s.entries}</dd></div><div><dt>Ready to import</dt><dd>${s.eligible + s.resumable}</dd></div><div><dt>Already imported</dt><dd>${s.alreadyImported}</dd></div><div><dt>Blocked</dt><dd>${s.blocked}${s.blocked ? ` (${this.esc(Object.entries(s.problems).map(([k, v]) => `${k}: ${v}`).join(", "))})` : ""}</dd></div><div><dt>Size</dt><dd>${mb(s.bytesToImport)} for ${s.recordsReceivingFiles} records</dd></div><div><dt>Storage</dt><dd>${capText}</dd></div>${src}</dl>`;
    })() : "";
    const runs = (m.runs || []).map((r) => {
      const c = (k) => r.counts?.[k]?.files || 0;
      const id = this.esc(r.runId), btn = (action, label, primary = false) => `<button class="button ${primary ? "primary" : "secondary"} small" data-action="integration-mid-${action}" data-run="${id}">${label}</button>`;
      const actions = [
        ...(["prepared", "paused", "stopped"].includes(r.status) ? [btn("start-pilot", "Start 20-file pilot", true), btn("start-full", "Start full import")] : []),
        ...(r.status === "running" ? [btn("pause", "Pause"), btn("stop", "Stop")] : []),
        ...(r.status === "paused" && r.remaining > 0 ? [btn("resume", "Resume")] : []),
        ...(r.status === "paused" ? [btn("stop", "Stop")] : []),
        btn("verify", "Verify"), btn("refresh", "Refresh"),
        ...(["prepared", "paused", "stopped", "completed"].includes(r.status) ? [btn("rollback", "Roll back this run")] : [])
      ].join("");
      const failures = (r.failures || []).slice(0, 10).map((f) => `<li><code>${this.esc(f.assetId)}</code> ${this.esc(f.name || "")} — ${this.esc(f.status)} ${this.esc(f.error?.code || "")} (${this.esc(f.attempts)} attempt${f.attempts === 1 ? "" : "s"})</li>`).join("");
      return `<div class="integration-dashboard"><dl class="integration-facts"><div><dt>Run</dt><dd><code>${id}</code></dd></div><div><dt>Status</dt><dd>${this.esc(r.status)}${r.pausedReason ? ` (${this.esc(r.pausedReason)})` : ""}</dd></div><div><dt>Imported</dt><dd>${c("done")} of ${r.totals?.files || 0}</dd></div><div><dt>Waiting</dt><dd>${c("queued") + c("retry") + c("running")}</dd></div><div><dt>Failed</dt><dd>${c("failed")}</dd></div><div><dt>Backup</dt><dd>${r.backups?.length ? this.esc(r.backups[r.backups.length - 1].reference) : "none recorded"}</dd></div></dl>
        ${failures ? `<ul class="integration-features">${failures}</ul>` : ""}${this.midVerify?.runId === r.runId ? `<p class="integration-note" role="status">Verification: ${this.midVerify.ok ? "everything matches" : `${this.midVerify.problemCount} problem(s), ${this.midVerify.strayDriveFiles} stray Drive file(s)`} · ${this.midVerify.readyAttachments} attachments, ${this.midVerify.assetMappings} mappings, ${this.midVerify.driveFiles} Drive files.</p>` : ""}
        <div class="integration-actions">${actions}</div></div>`;
    }).join("");
    return `<article class="integration-card" aria-labelledby="int-mid-title"><header class="integration-head"><span class="integration-logo" aria-hidden="true">M</span><div><h2 id="int-mid-title">Machine Installation Database files</h2><p>Imports the files left on monday.com into Google Drive, on the records they belong to. Every step is started here by a Google Drive administrator; nothing happens on its own.</p></div></header>
      <div class="integration-actions"><label class="field"><span>Plan file (from the local migration folder)</span><input type="file" id="mid-plan-file" accept="application/json,.json"></label></div>
      <div class="integration-actions"><button class="button secondary" data-action="integration-mid-dryrun">Dry run</button><button class="button secondary" data-action="integration-mid-dryrun-sources">Dry run + check monday.com</button><button class="button primary" data-action="integration-mid-prepare">Prepare run</button></div>
      ${dry}${runs ? `<h3>Runs</h3>${runs}` : ""}</article>`;
  }
  async midPlan() {
    const file = document.querySelector("#mid-plan-file")?.files?.[0];
    if (!file) throw new Error("Choose the plan file first.");
    try { return JSON.parse(await file.text()); } catch { throw new Error("That file isn't valid JSON."); }
  }
  async onMidAction(action, target) {
    const api = (method, path, body) => this.adapter.request(method, `/migrations/mid-attachments${path}`, body);
    const run = target?.dataset?.run;
    try {
      if (action === "integration-mid-dryrun" || action === "integration-mid-dryrun-sources") { this.midDry = await api("POST", "/dry-run", { plan: await this.midPlan(), checkSources: action === "integration-mid-dryrun-sources" }); return this.redraw(); }
      if (action === "integration-mid-prepare") return this.view.showConfirm("Prepare the import run?", "JARC records the run and its list of files. No file is downloaded or uploaded until you start a pilot.", "integration-mid-prepare-go", "", "Prepare run");
      if (action === "integration-mid-prepare-go") { this.view.closeOverlay(); await api("POST", "/prepare", { plan: await this.midPlan(), confirm: true }); this.view.toast("Run prepared"); return this.load(); }
      if (action === "integration-mid-start-pilot" || action === "integration-mid-start-full") {
        const pilot = action.endsWith("pilot");
        return this.view.overlay(`<form class="modal" data-action="integration-mid-start-form" data-run="${this.esc(run)}" data-mode="${pilot ? "pilot" : "full"}"><div class="modal-head"><div><div class="eyebrow">Machine Installation Database files</div><h2>${pilot ? "Start the 20-file pilot" : "Start the full import"}</h2></div>${this.view.closeButton()}</div>
          <p>Record the verified backup of <code>jarc_database</code> taken for this import (at most 24 hours old).</p>
          <label class="field"><span>Backup reference</span><input name="reference" required maxlength="200"></label>
          <label class="field"><span>Taken at</span><input name="takenAt" type="datetime-local" required></label>
          <label class="field"><span>Backup SHA-256 (optional)</span><input name="sha256" pattern="[0-9a-f]{64}"></label>
          <label class="integration-confirm"><input type="checkbox" name="confirm" value="yes" required> I approve this ${pilot ? "pilot" : "import"}.</label>
          <div class="integration-actions"><button class="button primary" type="submit">${pilot ? "Start pilot" : "Start import"}</button></div></form>`);
      }
      if (["integration-mid-pause", "integration-mid-resume", "integration-mid-stop"].includes(action)) { await api("POST", `/runs/${encodeURIComponent(run)}/${action.split("-").pop()}`); return this.load(); }
      if (action === "integration-mid-refresh") return this.load();
      if (action === "integration-mid-verify") { this.midVerify = await api("GET", `/runs/${encodeURIComponent(run)}/verify?sample=5`); return this.redraw(); }
      if (action === "integration-mid-rollback") {
        return this.view.overlay(`<form class="modal" data-action="integration-mid-rollback-form" data-run="${this.esc(run)}"><div class="modal-head"><div><div class="eyebrow">Machine Installation Database files</div><h2>Roll back this run</h2></div>${this.view.closeButton()}</div>
          <p>Moves this run's files to Google Drive Trash and removes only the attachments and mappings this run created. Records and every other attachment stay as they are.</p>
          <label class="field"><span>Type <code>ROLLBACK ${this.esc(run)}</code></span><input name="confirm" required autocomplete="off"></label>
          <div class="integration-actions"><button class="button primary" type="submit">Roll back</button></div></form>`);
      }
    } catch (error) { this.view.closeOverlay(); this.view.showMessage("Machine Installation Database files", error?.message || "That didn't work."); }
    return undefined;
  }
  async onMidSubmit(action, data, form) {
    const run = form.dataset.run, api = (path, body) => this.adapter.request("POST", `/migrations/mid-attachments/runs/${encodeURIComponent(run)}${path}`, body);
    try {
      if (action === "integration-mid-start-form") {
        const takenAt = data.takenAt ? new Date(data.takenAt).toISOString() : "";
        await api("/start", { mode: form.dataset.mode, confirm: data.confirm === "yes", backup: { reference: data.reference, takenAt, ...(data.sha256 ? { sha256: data.sha256 } : {}) } });
        this.view.closeOverlay(); this.view.toast(form.dataset.mode === "pilot" ? "Pilot started" : "Import started");
      }
      if (action === "integration-mid-rollback-form") { await api("/rollback", { confirm: data.confirm }); this.view.closeOverlay(); this.view.toast("Rollback started"); }
    } catch (error) { this.view.showMessage("Machine Installation Database files", error?.message || "That didn't work."); }
    return this.load();
  }

  driveProblem(code) {
    const known = { GDRIVE_ADMIN_REQUIRED: "Only JARC's Google Drive administrators can connect Google Drive", GDRIVE_WRONG_ACCOUNT: "That isn't the Google account configured for JARC's attachments", GDRIVE_ACCOUNT_CHANGED: "JARC's files belong to a different Google account", GDRIVE_SCOPE_DENIED: "Google Drive access wasn't allowed", GDRIVE_CHECK_FAILED: "Google Drive didn't pass the connection check, so nothing was saved", OAUTH_BROWSER_MISMATCH: "Finish connecting in the browser that started it", OAUTH_STATE_INVALID: "That connection link expired or was already used" };
    return known[code] || `Google Drive wasn't connected${code ? ` (${code})` : ""}`;
  }
  driveBadge(state) {
    const [label, tone] = { connected: ["Connected", "ok"], not_connected: ["Not connected", "muted"], needs_reconnect: ["Reconnect required", "warn"], unavailable: ["Unavailable", "warn"] }[state] || ["Unavailable", "warn"];
    return `<span class="integration-badge is-${tone}">${label}</span>`;
  }
  driveShell(badge, inner) {
    return `<article class="integration-card" aria-labelledby="int-gdrive-title"><header class="integration-head"><span class="integration-logo" aria-hidden="true">D</span><div><h2 id="int-gdrive-title">Google Drive attachments</h2><p>Keeps attachment files in one Google Drive account that only this server uses. Employees keep signing in with Microsoft and don't need a Google account.</p></div>${badge}</header>${inner}</article>`;
  }
  driveCard() {
    if (this.driveError) return this.driveShell(this.driveBadge("unavailable"), `<p class="integration-note" role="alert">${this.esc(this.driveError)}</p>`);
    const s = this.drive;
    if (!s) return "";
    const uploads = s.activeForNewUploads ? "Go to Google Drive" : "Not going to Google Drive yet";
    if (!s.canManage) {
      // Employees: the state only. Who connected it, the account and the folder are for Drive administrators.
      const note = { connected: "Google Drive is connected for the whole company.", not_connected: "Google Drive isn't connected yet.", needs_reconnect: "Google Drive needs to be reconnected by an administrator.", unavailable: "Google Drive is connected but can't be used right now." }[s.state] || "Google Drive can't be used right now.";
      const who = s.adminsConfigured ? "JARC's Google Drive administrators manage this connection." : "No Google Drive administrator is set up for JARC yet.";
      return this.driveShell(this.driveBadge(s.state), `<dl class="integration-facts"><div><dt>New attachments</dt><dd>${uploads}</dd></div></dl><p class="integration-note">${note} ${who}</p>`);
    }
    const actions = !s.connected ? `<button class="button primary" data-action="integration-gdrive-connect">Connect Google Drive</button>`
      : `<button class="button secondary" data-action="integration-gdrive-test">Test connection</button>${s.state === "needs_reconnect" ? `<button class="button primary" data-action="integration-gdrive-connect">Reconnect</button>` : ""}<button class="button secondary" data-action="integration-gdrive-disconnect">Disconnect</button>`;
    const fact = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    const facts = [fact("Google account", this.esc(s.account?.email || s.configuredAccount || "—")), ...(s.connected ? [fact("Connected by", this.esc(s.account?.connectedByName || "—")), fact("Since", this.date(s.account?.connectedAt)), fact("Last checked", this.date(s.lastCheckedAt))] : []), ...(s.folder ? [fact("Folder", `<a href="${this.esc(s.folder.url)}" target="_blank" rel="noopener noreferrer">${this.esc(s.folder.name)}</a>`)] : []), fact("New attachments", uploads)].join("");
    const warning = s.state === "needs_reconnect" ? `<div class="integration-alert" role="alert">Google no longer accepts JARC's access${s.activeForNewUploads ? ", so attachments stored in Google Drive can't be uploaded or opened" : ""}. Reconnect with ${this.esc(s.configuredAccount)}.</div>`
      : s.lastError ? `<div class="integration-alert" role="status">${this.esc({ GDRIVE_FILES_UNREACHABLE: "Google Drive is connected, but some of JARC's existing files can't be reached.", GDRIVE_FOLDER_REPLACED: "JARC's earlier Google Drive folder couldn't be reached, so new files go to a new one.", GDRIVE_FOLDER_MISSING: "JARC's Google Drive folder is missing or in Trash." }[s.lastError] || `Last problem: ${s.lastError}`)}</div>` : "";
    return this.driveShell(this.driveBadge(s.state), `
      <ul class="integration-features"><li>JARC creates its own private folder and can only reach files it created</li><li>Files are stored under internal IDs; people see the original names in JARC</li><li>Removing an attachment moves its file to Google Drive Trash</li><li>Attachments already stored elsewhere stay where they are</li></ul>
      <dl class="integration-facts">${facts}</dl>${warning}<div class="integration-actions">${actions}</div>`);
  }
  async onDriveAction(action) {
    const api = (method, path, body) => this.adapter.request(method, `/integrations/google-drive${path}`, body);
    try {
      if (action === "integration-gdrive-connect") return this.view.showConfirm("Connect Google Drive?", `You'll go to Google to sign in with ${this.drive?.configuredAccount || "the configured account"} and allow JARC to create and manage its own files. New attachments only go there once that is separately switched on.`, "integration-gdrive-connect-go", "", "Continue to Google");
      if (action === "integration-gdrive-connect-go") { this.view.closeOverlay(); const { authorizeUrl } = await api("POST", "/connect"); if (/^https:\/\/accounts\.google\.com\//.test(authorizeUrl)) window.location.assign(authorizeUrl); return undefined; }
      if (action === "integration-gdrive-disconnect") return this.view.showConfirm("Disconnect Google Drive?", "JARC forgets its access to the Google account. Files stay in Google Drive, but attachments stored there can't be uploaded or opened in JARC until it's connected again. To keep those files reachable, don't remove JARC's access in the Google account.", "integration-gdrive-disconnect-go", "", "Disconnect");
      if (action === "integration-gdrive-disconnect-go") { this.view.closeOverlay(); await api("POST", "/disconnect", { confirm: true }); this.view.toast("Google Drive disconnected"); return this.load(); }
      if (action === "integration-gdrive-test") { const r = await api("POST", "/test"); this.view.toast(`Connection works${r.account ? ` · ${r.account}` : ""}`); return this.load(); }
    } catch (error) { this.view.closeOverlay(); this.view.showMessage("Google Drive", error?.message || "That didn't work."); await this.load(); }
    return undefined;
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
    if (action.startsWith("integration-gdrive-")) return this.onDriveAction(action);
    if (action.startsWith("integration-mid-")) return this.onMidAction(action, target);
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
    if (action.startsWith("integration-mid-")) return this.onMidSubmit(action, data, form);
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
