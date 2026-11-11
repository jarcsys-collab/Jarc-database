// System Health (JARC administrators): backend and database health, API response times, slow and failing endpoints, recent
// errors, slow MongoDB commands, integration reliability (monday.com, Google Drive) and background jobs — plus the Activity
// History audit trail. Shows only what the server reports (GET /api/v1/admin/system-health and /admin/activity); the server
// checks the JARC.Admin role on every request, so hiding the page from others is convenience, not protection.
class SystemHealthPanel {
  static TABS = [["overview", "Overview", "home"], ["integrations", "Integrations", "link"], ["activity", "Activity History", "refresh"]];
  static ACTIONS = [["", "All actions"], ["record.", "Records (any)"], ["record.created", "Record created"], ["record.updated", "Record updated"], ["record.deleted", "Record deleted"], ["records.", "Records in bulk"], ["attachment.", "Attachments (any)"], ["attachment.added", "Attachment added"], ["attachment.removed", "Attachment removed"], ["board.", "Boards"], ["workspace.", "Workspaces"], ["member.", "Members"], ["comment.", "Comments"], ["integration.", "Integrations"]];
  constructor(controller) {
    this.c = controller; this.tab = "overview"; this.health = null; this.error = ""; this.loading = false; this.timer = null;
    this.activity = { items: [], next: null, loading: false, error: "", filters: {}, loaded: false };
  }
  get view() { return this.c.view; }
  get adapter() { return this.c.model.storage?.adapter; }
  // Only signed-in administrators in resource mode; the server enforces it regardless.
  get visible() { return this.adapter?.mode === "resource" && Boolean(this.c.auth?.isSystemAdmin); }
  esc(v) { return this.view.escape(v ?? ""); }

  html() {
    if (!this.visible) return `<section class="page-head"><div><div class="eyebrow">Settings</div><h1>System Health</h1></div></section><div class="integration-card"><p>System Health is available to JARC administrators who are signed in with Microsoft.</p></div>`;
    if (this.tab !== "activity" && !this.health && !this.loading) setTimeout(() => this.load(), 0);
    if (this.tab === "activity" && !this.activity.loaded && !this.activity.loading) setTimeout(() => this.loadActivity(), 0);
    const tabs = SystemHealthPanel.TABS.map(([id, label, ic]) => `<button type="button" role="tab" data-action="health-tab" data-tab="${id}" aria-selected="${id === this.tab}" class="${id === this.tab ? "active" : ""}">${icon(ic)} ${label}</button>`).join("");
    return `<section class="page-head"><div><div class="eyebrow">Administration</div><h1>System Health</h1><p>How JARC is running right now: response times, errors, integrations and background jobs. Figures cover the time since the server last started.</p></div><div class="page-actions"><button class="button secondary" data-action="health-refresh">${icon("refresh")}<span>Refresh</span></button></div></section><div class="apitok-tabs health-tabs" role="tablist" aria-label="System Health sections">${tabs}</div><div id="health-root" class="health-page" aria-live="polite">${this.body()}</div>`;
  }
  redraw() { const root = document.querySelector("#health-root"); if (root) root.innerHTML = this.body(); }
  body() {
    if (this.tab === "activity") return this.activityHtml();
    if (this.loading && !this.health) return `<div class="integration-card is-loading" role="status" aria-busy="true"><span class="loading-spinner" aria-hidden="true"></span> Loading System Health…</div>`;
    if (this.error && !this.health) return `<div class="integration-card"><div class="integration-alert" role="alert"><strong>System Health couldn't be loaded.</strong><span>${this.esc(this.error)}</span></div><div class="integration-actions"><button class="button secondary" data-action="health-refresh">${icon("refresh")} Try again</button></div></div>`;
    if (!this.health) return "";
    return (this.error ? `<p class="integration-alert" role="alert">Showing the last figures: ${this.esc(this.error)}</p>` : "") + (this.tab === "integrations" ? this.integrationsHtml() : this.overviewHtml());
  }

  async load() {
    if (!this.visible || this.loading) return;
    this.loading = true; if (!this.health) this.redraw();
    try { this.health = await this.adapter.request("GET", "/admin/system-health"); this.error = ""; }
    catch (error) { this.error = `${error?.message || "The server didn't answer."}${error?.requestId ? ` (reference ${error.requestId})` : ""}`; }
    finally { this.loading = false; }
    this.redraw(); this.schedule();
  }
  // While the page is open and visible it refreshes itself every 30 seconds.
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.c.model.screen === "system-health" && document.visibilityState === "visible" && this.tab !== "activity") this.load(); else if (this.c.model.screen === "system-health") this.schedule(); }, 30000);
  }

  // ---- Overview
  tile(label, value, note = "", tone = "") { return `<div class="health-tile ${tone ? `is-${tone}` : ""}"><span class="health-tile-label">${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ""}</div>`; }
  ms(v) { return v === null || v === undefined ? "—" : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`; }
  when(iso) { return iso ? this.view.relative(iso) : "—"; }
  overviewHtml() {
    const h = this.health, api = h.api, db = h.database;
    const tiles = [
      this.tile("Backend", h.server.status === "ok" ? "Healthy" : "Degraded", `Up ${this.duration(h.server.uptimeSeconds)} · ${this.esc(h.server.version)}`, h.server.status === "ok" ? "good" : "bad"),
      this.tile("MongoDB", db.status === "connected" ? "Connected" : "Unavailable", db.pingMs === null ? "No answer to ping" : `Ping ${this.ms(db.pingMs)}`, db.status === "connected" ? "good" : "bad"),
      this.tile("API requests", api.requests.toLocaleString(), `${api.serverErrors} server error${api.serverErrors === 1 ? "" : "s"} · ${api.errorRate}%`, api.errorRate >= 5 ? "bad" : api.errorRate > 0 ? "warn" : ""),
      this.tile("Average", this.ms(api.avgMs), `p50 ${this.ms(api.p50Ms)}`),
      this.tile("p95", this.ms(api.p95Ms), `p99 ${this.ms(api.p99Ms)}`, api.p95Ms >= 2000 ? "warn" : ""),
      this.tile("Slow database commands", db.slow.toLocaleString(), `≥ ${db.slowThresholdMs} ms · ${db.failed} failed`, db.slow ? "warn" : "")
    ].join("");
    const endpoint = (e) => `<tr><td><code>${this.esc(e.route)}</code></td><td data-label="Requests">${e.count.toLocaleString()}</td><td data-label="Average">${this.ms(e.avgMs)}</td><td data-label="p95">${this.ms(e.p95Ms)}</td><td data-label="p99">${this.ms(e.p99Ms)}</td><td data-label="Errors">${e.serverErrors ? `<span class="health-bad">${e.serverErrors} (${e.errorRate}%)</span>` : "0"}</td></tr>`;
    const table = (list, empty) => list.length ? `<table class="account-table health-table"><thead><tr><th>Endpoint</th><th>Requests</th><th>Average</th><th>p95</th><th>p99</th><th>Server errors</th></tr></thead><tbody>${list.map(endpoint).join("")}</tbody></table>` : `<p class="integration-note">${empty}</p>`;
    const errors = h.recentErrors.length ? `<table class="account-table health-table"><thead><tr><th>When</th><th>Request</th><th>Status</th><th>Code</th><th>Reference</th></tr></thead><tbody>${h.recentErrors.slice(0, 20).map((e) => `<tr><td>${this.when(e.at)}</td><td data-label="Request"><code>${this.esc(`${e.method} ${e.route}`)}</code></td><td data-label="Status">${e.status}</td><td data-label="Code">${this.esc(e.code || "—")}</td><td data-label="Reference"><code>${this.esc(e.requestId || "—")}</code></td></tr>`).join("")}</tbody></table>` : `<p class="integration-note">No errors since the server started.</p>`;
    const slow = db.slowCommands.length ? `<table class="account-table health-table"><thead><tr><th>When</th><th>Command</th><th>Collection</th><th>Time</th><th>Result</th></tr></thead><tbody>${db.slowCommands.slice(0, 15).map((c) => `<tr><td>${this.when(c.at)}</td><td data-label="Command">${this.esc(c.command)}</td><td data-label="Collection">${this.esc(c.collection || "—")}</td><td data-label="Time">${this.ms(c.ms)}</td><td data-label="Result">${c.ok ? "OK" : `<span class="health-bad">Failed ${this.esc(c.code || "")}</span>`}</td></tr>`).join("")}</tbody></table>` : `<p class="integration-note">No database command has taken ${db.slowThresholdMs} ms or more.</p>`;
    return `<div class="health-tiles">${tiles}</div>
      <section class="integration-card health-section"><h2>Requests per minute</h2>${this.trendHtml(h.trend)}</section>
      <section class="integration-card health-section"><h2>Slowest endpoints <small>by p95</small></h2>${table(h.slowestEndpoints, "No requests have been timed yet.")}</section>
      ${h.failingEndpoints.length ? `<section class="integration-card health-section"><h2>Failing endpoints</h2>${table(h.failingEndpoints, "")}</section>` : ""}
      <section class="integration-card health-section"><h2>Recent errors <small>server errors, refusals and rate limits</small></h2>${errors}</section>
      <section class="integration-card health-section"><h2>Slow database commands</h2>${slow}</section>
      <section class="integration-card health-section"><h2>Background jobs</h2>${this.jobsHtml()}</section>
      <p class="integration-note">Generated ${this.view.time(h.generatedAt)} · memory ${h.server.memoryMb.rss} MB · Node.js ${this.esc(h.server.node)}. Use a reference to find the matching line in the server log.</p>`;
  }
  // A small bar chart of the last hour's requests per minute, with errors marked; the numbers are in each bar's label.
  trendHtml(trend) {
    if (!trend.length) return `<p class="integration-note">No requests yet.</p>`;
    const max = Math.max(1, ...trend.map((t) => t.requests));
    return `<div class="health-trend" role="img" aria-label="Requests per minute over the last ${trend.length} minute${trend.length === 1 ? "" : "s"}, peak ${max}">${trend.map((t) => `<span class="health-bar ${t.errors ? "has-errors" : ""}" style="--h:${Math.max(4, Math.round((t.requests / max) * 100))}%" title="${this.esc(`${new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${t.requests} requests, ${t.errors} errors, average ${t.avgMs} ms`)}"></span>`).join("")}</div>`;
  }
  duration(s) { if (s < 120) return `${s} s`; if (s < 7200) return `${Math.round(s / 60)} min`; if (s < 172800) return `${Math.round(s / 3600)} h`; return `${Math.round(s / 86400)} days`; }
  jobsHtml() {
    const j = this.health.jobs, rows = [];
    const m = j.integration?.monday;
    if (m && !m.unavailable) rows.push(["monday.com jobs", `${m.running} running · ${m.queued} queued · ${m.retry} waiting to retry · ${m.failed} failed`, m.failed ? "bad" : ""]);
    if (j.imports && !j.imports.unavailable) rows.push(["Excel and CSV imports", `${j.imports.active} in progress · ${j.imports.failed} failed`, j.imports.failed ? "warn" : ""]);
    if (Array.isArray(j.midAttachments)) for (const r of j.midAttachments) rows.push([`Attachment import ${this.esc(r.runId)}`, `${this.esc(r.status)}${r.mode ? ` (${this.esc(r.mode)})` : ""} · ${r.remaining ?? "?"} of ${r.totalFiles ?? "?"} files left${r.pausedReason ? ` · paused: ${this.esc(r.pausedReason)}` : ""}${r.lastError ? ` · last error: ${this.esc(r.lastError)}` : ""}`, r.status === "failed" ? "bad" : r.status === "paused" ? "warn" : ""]);
    if (j.searchIndex) rows.push(["Search index", `${this.esc(j.searchIndex.mode)}${j.searchIndex.mode !== "off" ? (j.searchIndex.ready ? " · ready" : " · catching up") : ""}`, ""]);
    for (const f of j.recentFailures || []) rows.push([`Failed: ${this.esc(f.kind)}`, `${this.when(f.at)}${f.code ? ` · ${this.esc(f.code)}` : ""}`, "bad"]);
    return rows.length ? `<dl class="integration-facts health-facts">${rows.map(([k, v, tone]) => `<div class="${tone ? `is-${tone}` : ""}"><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>` : `<p class="integration-note">No background jobs on this server.</p>`;
  }

  // ---- Integration Reliability
  integrationsHtml() {
    const i = this.health.integrations;
    const card = (name, status, a, details, action) => {
      const state = status.unavailable ? "unknown" : status.enabled === false ? "off" : status.state || (status.connected ? "connected" : "not_connected");
      const label = { connected: "Connected", not_connected: "Not connected", needs_reconnect: "Needs reconnecting", unavailable: "Unavailable", setup_required: "Setup required", disabled: "Switched off", off: "Switched off on this server", unknown: "Status couldn't be read" }[state] || state;
      const tone = state === "connected" ? "good" : ["needs_reconnect", "unavailable", "unknown"].includes(state) ? "bad" : "";
      const act = a ? `<dl class="integration-facts health-facts"><div><dt>Last success</dt><dd>${this.when(a.lastSuccessAt)}</dd></div><div class="${a.lastFailureAt ? "is-warn" : ""}"><dt>Last failure</dt><dd>${a.lastFailureAt ? `${this.when(a.lastFailureAt)}${a.lastError ? ` · ${this.esc(a.lastError.op || "")} ${a.lastError.status ?? ""} ${this.esc(a.lastError.code || "")}` : ""}` : "None"}</dd></div><div><dt>Requests</dt><dd>${a.ok.toLocaleString()} succeeded · ${a.failed} failed · ${a.retries} retried · ${a.timeouts} timed out</dd></div><div class="${a.rateLimited ? "is-warn" : ""}"><dt>Rate limits</dt><dd>${a.rateLimited ? `${a.rateLimited} · last ${this.when(a.lastRateLimit?.at)}${a.lastRateLimit?.retryAfterMs ? `, asked to wait ${Math.round(a.lastRateLimit.retryAfterMs / 1000)} s` : ""}` : "None"}</dd></div></dl>${a.history.length ? `<details class="health-history"><summary>Recent retries and failures (${a.history.length})</summary><table class="account-table health-table"><thead><tr><th>When</th><th>Operation</th><th>Outcome</th><th>Status</th><th>Code</th></tr></thead><tbody>${a.history.slice(0, 25).map((e) => `<tr><td>${this.when(e.at)}</td><td data-label="Operation">${this.esc(e.op || "—")}</td><td data-label="Outcome">${this.esc(e.outcome)}</td><td data-label="Status">${e.status ?? "—"}</td><td data-label="Code">${this.esc(e.code || "—")}</td></tr>`).join("")}</tbody></table></details>` : ""}` : `<p class="integration-note">No requests to ${name} since the server started.</p>`;
      return `<section class="integration-card health-section"><div class="health-card-head"><h2>${name}</h2><span class="health-pill ${tone ? `is-${tone}` : ""}">${label}</span></div>${details}${act}${action}</section>`;
    };
    const m = i.monday, d = i.googleDrive;
    const mondayDetails = m.unavailable || m.enabled === false ? "" : `<p class="integration-note">${m.account ? `Account ${this.esc(m.account)} · ` : ""}${m.importedBoards} imported board${m.importedBoards === 1 ? "" : "s"} · sync ${m.sync?.enabled ? (m.sync.paused ? "paused" : "on") : "off"}${m.sync?.lastSyncAt ? ` · last sync ${this.when(m.sync.lastSyncAt)}` : ""}</p>${m.sync?.lastError ? `<p class="integration-alert" role="alert">Last sync error: ${this.esc(m.sync.lastError)}</p>` : ""}${m.failedJobs?.length ? `<p class="integration-alert" role="alert">${m.failedJobs.length} failed job${m.failedJobs.length === 1 ? "" : "s"}: ${m.failedJobs.slice(0, 3).map((f) => `${this.esc(f.type)} (${f.attempts} attempt${f.attempts === 1 ? "" : "s"}${f.error ? `: ${this.esc(f.error)}` : ""})`).join("; ")}. Retry them on the Integrations page.</p>` : ""}`;
    const driveDetails = d.unavailable || d.enabled === false ? "" : `<p class="integration-note">${d.activeForNewUploads ? "New uploads are stored in Google Drive." : "New uploads aren't stored in Google Drive."}${d.lastError ? ` Last problem: ${this.esc(d.lastError)}${d.lastErrorAt ? ` (${this.when(d.lastErrorAt)})` : ""}.` : ""}${d.canManage ? "" : " Only the Google Drive administrators set up for JARC can see its account details and manage it."}</p>`;
    const next = (state) => state === "needs_reconnect" ? "Reconnect it on the Integrations page." : state === "unavailable" ? "Check the connection on the Integrations page (Test connection)." : "";
    const goto = `<div class="integration-actions"><button class="button secondary" data-action="nav" data-screen="integrations">${icon("link")} Open Integrations</button></div>`;
    const tip = (s) => { const n = next(s.state); return n ? `<p class="integration-alert" role="alert">${n}</p>` : ""; };
    return card("monday.com", m, m.activity, mondayDetails + tip(m), goto) + card("Google Drive", d, d.activity, driveDetails + tip(d), goto)
      + `<p class="integration-note">Requests are retried automatically with increasing waits only when that is safe (reads, and uploads that can resume); changes are never repeated blindly. Counts cover the time since the server started.</p>`;
  }

  // ---- Activity History
  async loadActivity({ more = false } = {}) {
    if (!this.visible || this.activity.loading) return;
    const a = this.activity; a.loading = true; a.error = ""; this.redraw();
    // The date boxes hold days; what is sent are the exact start and end of those days (a.query, from onSubmit).
    const params = new URLSearchParams(Object.entries({ ...a.filters, from: a.query?.from || "", to: a.query?.to || "" }).filter(([, v]) => v));
    if (more && a.next) params.set("before", a.next);
    params.set("limit", "50");
    try { const res = await this.adapter.request("GET", `/admin/activity?${params}`); a.items = more ? [...a.items, ...res.items] : res.items; a.next = res.next; a.loaded = true; }
    catch (error) { a.error = error?.message || "The activity history couldn't be loaded."; if (!more) a.items = []; a.loaded = true; }
    finally { a.loading = false; }
    this.redraw();
    if (more) document.querySelector("#health-root .health-activity-list tr:last-child")?.scrollIntoView({ block: "nearest" });
  }
  describe(e) {
    const what = { "record.created": "created a record", "record.updated": "updated a record", "record.deleted": "deleted a record", "records.created": "added records", "attachment.added": "added a file", "attachment.removed": "removed a file", "board.created": "created a board", "board.updated": "changed a board", "board.deleted": "deleted a board", "board.moved": "moved a board", "workspace.created": "created a workspace", "workspace.deleted": "deleted a workspace", "member.role_changed": "changed a member's role", "member.removed": "removed a member", "comment.created": "commented", "comment.updated": "edited a comment", "comment.deleted": "deleted a comment", "integration.imported": "imported from monday.com", "integration.synced": "synced from monday.com" }[e.action] || e.action;
    return `${this.esc(e.actorName || "Someone")} ${this.esc(what)}`;
  }
  activityHtml() {
    const a = this.activity, f = a.filters;
    const form = `<form class="health-filters" data-action="health-activity-filter" role="search" aria-label="Filter activity"><label>Search<input type="search" name="q" value="${this.esc(f.q)}" maxlength="100" placeholder="Summary or field" autocomplete="off"></label><label>Action<select name="action">${SystemHealthPanel.ACTIONS.map(([v, l]) => `<option value="${v}" ${f.action === v ? "selected" : ""}>${l}</option>`).join("")}</select></label><label>Person<input type="search" name="actor" value="${this.esc(f.actor)}" maxlength="100" placeholder="Name" autocomplete="off"></label><label>From<input type="date" name="from" value="${this.esc(f.from)}"></label><label>To<input type="date" name="to" value="${this.esc(f.to)}"></label><div class="health-filter-actions"><button class="button primary" type="submit">Apply</button><button class="button secondary" type="button" data-action="health-activity-clear" ${Object.values(f).some(Boolean) ? "" : "disabled"}>Clear</button></div></form>`;
    if (a.loading && !a.items.length) return `${form}<div class="integration-card is-loading" role="status" aria-busy="true"><span class="loading-spinner" aria-hidden="true"></span> Loading activity…</div>`;
    const error = a.error ? `<div class="integration-alert" role="alert"><strong>Activity couldn't be loaded.</strong><span>${this.esc(a.error)}</span><button class="button secondary small" data-action="health-activity-retry">Try again</button></div>` : "";
    if (!a.items.length) return `${form}${error}${a.error ? "" : `<div class="quiet-empty">${icon("refresh")}<span><strong>No activity matches</strong><small>${Object.values(f).some(Boolean) ? "Try a wider date range or fewer filters." : "Changes to records, files, boards and members appear here."}</small></span></div>`}`;
    const change = (c) => `<li><code>${this.esc(c.field)}</code>${c.from !== null || c.to !== null ? `: ${c.from === null ? "<em>empty</em>" : this.esc(c.from)} → ${c.to === null ? "<em>empty</em>" : this.esc(c.to)}` : ""}</li>`;
    const rows = a.items.map((e) => `<tr><td><time datetime="${this.esc(e.at)}" title="${this.esc(this.view.time(e.at))}">${this.esc(this.view.relative(e.at))}</time></td><td data-label="Event"><strong>${this.describe(e)}</strong>${e.summary ? `<small>${this.esc(e.summary)}</small>` : ""}${e.changes.length ? `<details><summary>${e.changes.length} field${e.changes.length === 1 ? "" : "s"} changed</summary><ul class="health-changes">${e.changes.map(change).join("")}</ul></details>` : ""}</td><td data-label="Board">${this.esc(e.boardName || "—")}</td><td data-label="Type"><code>${this.esc(e.action)}</code></td><td data-label="Reference"><code>${this.esc(e.requestId || "—")}</code></td></tr>`).join("");
    return `${form}${error}<table class="account-table health-table health-activity-list"><thead><tr><th>When</th><th>Event</th><th>Board</th><th>Type</th><th>Reference</th></tr></thead><tbody>${rows}</tbody></table><div class="health-more">${a.next ? `<button class="button secondary" data-action="health-activity-more" ${a.loading ? "disabled aria-busy=\"true\"" : ""}>${a.loading ? "Loading…" : "Show older activity"}</button>` : `<small>${a.items.length} entr${a.items.length === 1 ? "y" : "ies"} · that's everything${Object.values(f).some(Boolean) ? " for these filters" : ""}.</small>`}</div>`;
  }

  // ---- Events (routed here by AppController for every "health-…" action)
  onAction(action, target) {
    if (action === "health-tab") { this.tab = target.dataset.tab; this.c.update(); document.querySelector(`[data-action="health-tab"][data-tab="${CSS.escape(this.tab)}"]`)?.focus(); return; }
    if (action === "health-refresh") { if (this.tab === "activity") this.loadActivity(); else this.load(); return; }
    if (action === "health-activity-more") { this.loadActivity({ more: true }); return; }
    if (action === "health-activity-retry") { this.loadActivity(); return; }
    if (action === "health-activity-clear") { this.activity.filters = {}; this.activity.query = {}; this.loadActivity(); }
  }
  onSubmit(action, data) {
    if (action !== "health-activity-filter") return;
    const clean = (v) => String(v || "").trim();
    // Dates are whole days in the browser's time zone: "to" includes the whole of that day.
    const day = (v, end) => { if (!v) return ""; const d = new Date(`${v}T${end ? "23:59:59.999" : "00:00:00"}`); return Number.isNaN(d.getTime()) ? "" : d.toISOString(); };
    this.activity.filters = { q: clean(data.q), action: clean(data.action), actor: clean(data.actor), from: clean(data.from), to: clean(data.to) };
    this.activity.query = { from: day(data.from, false), to: day(data.to, true) };
    this.loadActivity();
  }
}
