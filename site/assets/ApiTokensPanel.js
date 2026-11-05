// Settings → API Tokens: issue, rotate and revoke the tokens other systems use to read JARC, and read how to use them. The server
// enforces every rule (services/api-token-service.js); this only shows what it reports. A new token exists here only as text in the
// one dialog that reveals it: it is never put in browser storage or the model, and it is gone when that dialog closes.
class ApiTokensPanel {
  static STATUS = { active: ["Active", "ok"], rotating: ["Being replaced", "warn"], expired: ["Expired", "muted"], revoked: ["Revoked", "muted"], no_access: ["No access", "danger"] };
  static GRACE = [[0, "End it immediately"], [1, "Keep working for 1 hour"], [24, "Keep working for 24 hours"], [168, "Keep working for 7 days"]];
  static CODES = { FORBIDDEN: "You need your own Workspace admin membership of this workspace. Shared or beta access doesn't count.", TOKEN_LIMIT_REACHED: "You've reached the limit of 25 active tokens. Revoke one you no longer need.", TOKEN_ALREADY_ROTATED: "This token was already rotated. Rotate its replacement instead.", TOKEN_NOT_ACTIVE: "This token has ended. Create a new one instead.", TOKEN_NO_BOARDS: "None of this token's boards are available any more. Create a new token instead.", RATE_LIMITED: "Too many new tokens in the last hour. Try again later." };

  constructor(controller) { this.c = controller; this.items = null; this.options = null; this.loading = false; this.error = ""; this.tab = "tokens"; this.secret = null; this.pending = null; this.ex = { loaded: false, loading: false, error: "", workspaces: [], workspaceId: "", boards: [], boardId: "", data: null, selected: new Set(), example: null, exampleBusy: false, exampleError: "" }; }
  get view() { return this.c.view; }
  get adapter() { return this.c.model.storage?.adapter; }
  visible() { return Boolean(this.c.model.features?.apiTokens && this.adapter?.request); }
  esc(v) { return this.view.escape(v ?? ""); }
  api(method, path, body) { return this.adapter.request(method, `/me/api-tokens${path}`, body); }
  date(iso, fallback = "Never") { if (!iso) return fallback; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : this.esc(d.toLocaleDateString(undefined, { dateStyle: "medium" })); }
  dateTime(iso) { if (!iso) return "Never"; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : this.esc(d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })); }
  message(error) { return ApiTokensPanel.CODES[error?.code] || (typeof StorageError !== "undefined" ? StorageError.describe(error) : error)?.message || "That didn't work."; }

  // ---- Settings section
  sectionHtml() {
    if (!this.items && !this.loading) setTimeout(() => this.load(), 0);
    return `<div id="apitok-root" class="apitok">${this.body()}</div>`;
  }
  redraw() { const root = document.querySelector("#apitok-root"); if (root) root.innerHTML = this.body(); }
  async load() {
    this.loading = true;
    try { const [list, options] = await Promise.all([this.api("GET", ""), this.api("GET", "/options")]); this.items = list.items; this.options = options.workspaces; this.error = ""; }
    catch (error) { this.error = this.message(error); }
    finally { this.loading = false; this.redraw(); }
  }

  body() {
    const tabs = `<div class="apitok-tabs" role="tablist" aria-label="API Tokens"><button type="button" role="tab" data-action="apitok-tab" data-tab="tokens" aria-selected="${this.tab === "tokens"}" class="${this.tab === "tokens" ? "active" : ""}">Tokens</button><button type="button" role="tab" data-action="apitok-tab" data-tab="explorer" aria-selected="${this.tab === "explorer"}" class="${this.tab === "explorer" ? "active" : ""}">API Explorer</button><button type="button" role="tab" data-action="apitok-tab" data-tab="docs" aria-selected="${this.tab === "docs"}" class="${this.tab === "docs" ? "active" : ""}">Documentation</button></div>`;
    if (this.tab === "explorer") { if (!this.ex.loaded && !this.ex.loading) setTimeout(() => this.explorerStart(), 0); return `${tabs}${this.explorerHtml()}`; }
    if (this.tab === "docs") return `${tabs}${ApiTokenDocs.html((v) => this.esc(v), window.location.origin)}`;
    if (this.error && !this.items) return `${tabs}<p class="account-empty" role="alert">${this.esc(this.error)}</p><button type="button" class="button secondary" data-action="apitok-refresh">Try again</button>`;
    if (!this.items) return `${tabs}<p class="account-empty" aria-busy="true">Loading tokens…</p>`;
    const canCreate = Boolean(this.options?.some((w) => w.boards.length));
    this.withArchived = (item) => `${item.name}${item.archived ? " (archived)" : ""}`;
    const intro = `<div class="apitok-intro"><p>Tokens let other systems, such as Power BI, read the boards you choose. They are read-only and never see more than you can.</p>${canCreate ? `<button type="button" class="button primary" data-action="apitok-new">${icon("plus")}<span>New token</span></button>` : ""}</div>`;
    const blocked = canCreate ? "" : `<div class="account-alert is-warn" role="status"><strong>You can't create a token yet.</strong><span>You need your own Workspace admin membership of a workspace with at least one board. Shared or beta access doesn't count, even though it lets you edit. Ask an administrator to add you under the workspace's members.</span></div>`;
    if (!this.items.length) return `${tabs}${intro}${blocked}<p class="account-empty">No tokens yet.</p>`;
    return `${tabs}${intro}${blocked}<table class="account-table apitok-table"><thead><tr><th>Name</th><th>Status</th><th>Access</th><th>Created</th><th>Expires</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${this.items.map((t) => this.row(t)).join("")}</tbody></table>`;
  }
  row(t) {
    const [label, tone] = ApiTokensPanel.STATUS[t.status] || ["Unknown", "muted"];
    const boards = t.boards.filter((b) => b.name).map((b) => b.name);
    const access = t.workspace.name ? `<div class="apitok-access"><strong>${this.esc(t.workspace.name)}</strong><small>${boards.length ? this.esc(boards.join(", ")) : "No boards available"} · Read-only</small></div>` : `<span class="muted">Not available</span>`;
    const live = t.status === "active" || t.status === "rotating" || t.status === "no_access";
    const actions = `${t.status === "active" && t.canRotate ? `<button type="button" class="button secondary" data-action="apitok-rotate" data-id="${this.esc(t.id)}">Rotate</button>` : ""}${live ? `<button type="button" class="button secondary danger-text" data-action="apitok-revoke" data-id="${this.esc(t.id)}">Revoke</button>` : ""}`;
    return `<tr><td data-label="Name"><strong>${this.esc(t.name)}</strong><small><code>${this.esc(t.prefix)}…</code></small></td><td data-label="Status"><span class="account-badge is-${tone}">${label}</span></td><td data-label="Access">${access}</td><td data-label="Created">${this.date(t.createdAt)}</td><td data-label="Expires">${t.status === "revoked" ? "—" : this.dateTime(t.expiresAt)}</td><td data-label="Last used">${this.dateTime(t.lastUsedAt)}</td><td class="apitok-actions">${actions}</td></tr>`;
  }

  // ---- New token
  dateInput(days) { const d = new Date(Date.now() + days * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  showCreate(workspaceId = null, error = "") {
    const spaces = this.options.filter((w) => w.boards.length);
    const current = spaces.find((w) => w.id === workspaceId) || spaces[0];
    const boards = current.boards.map((b) => `<label class="apitok-check"><input type="checkbox" name="board" value="${this.esc(b.id)}"><span>${this.esc(this.withArchived(b))}</span></label>`).join("");
    this.view.overlay(`<form class="modal apitok-modal" data-action="apitok-create-form" novalidate><div class="modal-head"><div><div class="eyebrow">API Tokens</div><h2>New token</h2></div>${this.view.closeButton()}</div>
      <div class="form-grid"><label class="full">Name<input name="name" required maxlength="100" placeholder="Power BI Integration" autocomplete="off"></label>
      <label class="full">Workspace<select name="workspaceId" data-action="apitok-workspace">${spaces.map((w) => `<option value="${this.esc(w.id)}" ${w.id === current.id ? "selected" : ""}>${this.esc(this.withArchived(w))}</option>`).join("")}</select></label>
      <fieldset class="full apitok-boards"><legend>Boards this token can read</legend><div class="apitok-board-list">${boards}</div></fieldset>
      <label>Permissions<select name="scope" disabled><option>Read-only</option></select></label>
      <label>Expires on<input type="date" name="expires" required min="${this.dateInput(1)}" max="${this.dateInput(366)}" value="${this.dateInput(90)}"></label></div>
      <p class="account-empty apitok-error" role="alert">${this.esc(error)}</p>
      <div class="modal-actions"><button type="button" class="button secondary" data-action="close-overlay">Cancel</button><button class="button primary">Create token</button></div></form>`, "apitok-overlay");
  }
  // The end of the chosen day, where the person is.
  endOfDay(value) { const [y, m, d] = String(value || "").split("-").map(Number); const at = new Date(y, m - 1, d, 23, 59, 59); return Number.isNaN(at.getTime()) ? null : at.toISOString(); }
  async submitCreate(form) {
    const name = form.elements.name.value.trim(), workspaceId = form.elements.workspaceId.value;
    const boardIds = [...form.querySelectorAll('input[name="board"]:checked')].map((i) => i.value), expiresAt = this.endOfDay(form.elements.expires.value);
    const problem = !name ? "Give the token a name." : !boardIds.length ? "Choose at least one board." : !expiresAt ? "Choose an expiry date." : "";
    const say = (text) => { const el = form.querySelector(".apitok-error"); if (el) el.textContent = text; };
    if (problem) { say(problem); return; }
    const button = form.querySelector("button.primary"); button.disabled = true;
    try { const result = await this.api("POST", "", { name, workspaceId, boardIds, scopes: ["read"], expiresAt }); this.reveal(result, "Token created"); }
    catch (error) { say(this.message(error)); button.disabled = false; }
  }

  // ---- The one time a token is shown. Outside clicks and Escape don't close it (data-keep-open); only the button does.
  reveal(result, title) {
    this.secret = result.secret;
    document.querySelector("#overlay-root").innerHTML = `<div class="overlay apitok-overlay" data-keep-open="1"><div class="modal apitok-modal" role="dialog" aria-modal="true" aria-labelledby="apitok-reveal-title"><div class="modal-head"><div><div class="eyebrow">${this.esc(result.token.name)}</div><h2 id="apitok-reveal-title">${this.esc(title)}</h2></div></div>
      <div class="account-alert is-warn" role="status"><strong>Copy this token now. You won't see it again.</strong><span>Keep it in a secure backend or approved secret store, never in public JavaScript or a shared file.</span></div>
      <div class="apitok-secret"><input id="apitok-secret" type="text" readonly spellcheck="false" autocomplete="off" aria-label="Your API token" value="${this.esc(result.secret)}"><button type="button" class="button primary" data-action="apitok-copy">Copy</button></div>
      <p class="account-note">Expires ${this.dateTime(result.token.expiresAt)}. Read-only, for ${result.token.boards.length} board${result.token.boards.length === 1 ? "" : "s"}.</p>
      <div class="modal-actions"><button type="button" class="button secondary" data-action="apitok-done">I've saved it</button></div></div></div>`;
    document.querySelector("#apitok-secret")?.select();
  }
  async copySecret(button) {
    const input = document.querySelector("#apitok-secret");
    if (!this.secret || !input) return;
    try { await navigator.clipboard.writeText(this.secret); }
    catch { input.select(); try { document.execCommand("copy"); } catch { this.view.toast("Select the token and copy it"); return; } }
    button.textContent = "Copied";
    this.view.toast("Token copied");
  }
  done() {
    this.secret = null;
    this.view.closeOverlay();
    this.items = null;
    this.view.showSettings(this.c.model, "api-tokens");
    this.c.markPanel?.("settings");
  }

  // ---- Rotate and revoke
  showRotate(t, error = "") {
    this.pending = t;
    this.view.overlay(`<form class="modal apitok-modal" data-action="apitok-rotate-form"><div class="modal-head"><div><div class="eyebrow">Rotate token</div><h2>${this.esc(t.name)}</h2></div>${this.view.closeButton()}</div>
      <p>This creates a replacement with the same boards and shows it once. Your other tokens aren't affected.</p>
      <div class="form-grid"><label class="full">The current token<select name="graceHours">${ApiTokensPanel.GRACE.map(([h, l]) => `<option value="${h}" ${h === 24 ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="full">The replacement expires on<input type="date" name="expires" required min="${this.dateInput(1)}" max="${this.dateInput(366)}" value="${this.dateInput(90)}"></label></div>
      <p class="account-empty apitok-error" role="alert">${this.esc(error)}</p>
      <div class="modal-actions"><button type="button" class="button secondary" data-action="apitok-cancel">Cancel</button><button class="button primary">Rotate token</button></div></form>`, "apitok-overlay");
  }
  async submitRotate(form) {
    const t = this.pending, expiresAt = this.endOfDay(form.elements.expires.value);
    const say = (text) => { const el = form.querySelector(".apitok-error"); if (el) el.textContent = text; };
    if (!t) return;
    if (!expiresAt) { say("Choose an expiry date."); return; }
    const button = form.querySelector("button.primary"); button.disabled = true;
    try { const result = await this.api("POST", `/${encodeURIComponent(t.id)}/rotate`, { graceHours: Number(form.elements.graceHours.value), expiresAt }); this.pending = null; this.reveal(result, "Token rotated"); }
    catch (error) { say(this.message(error)); button.disabled = false; }
  }
  showRevoke(t) {
    this.pending = t;
    this.view.overlay(`<form class="modal confirm-modal" data-action="apitok-revoke-form"><div class="confirm-icon">!</div><h2>Revoke ${this.esc(t.name)}?</h2><p>Anything using this token stops working immediately. This can't be undone.</p><p class="account-empty apitok-error" role="alert"></p><div class="modal-actions"><button type="button" class="button secondary" data-action="apitok-cancel">Cancel</button><button class="button danger-button">Revoke token</button></div></form>`, "apitok-overlay");
  }
  async submitRevoke(form) {
    const t = this.pending;
    if (!t) return;
    const button = form.querySelector("button.danger-button"); button.disabled = true;
    try { await this.api("POST", `/${encodeURIComponent(t.id)}/revoke`, {}); this.pending = null; this.view.toast("Token revoked"); this.backToList(); }
    catch (error) { const el = form.querySelector(".apitok-error"); if (el) el.textContent = this.message(error); button.disabled = false; }
  }
  backToList(reload = true) { this.view.closeOverlay(); if (reload) this.items = null; this.view.showSettings(this.c.model, "api-tokens"); this.c.markPanel?.("settings"); }

  // ---- Copying IDs and endpoints (identifiers, never a token)
  async copyText(text, label) {
    try { await navigator.clipboard.writeText(text); this.view.toast(`${label} copied`); }
    catch { this.view.showMessage(label, text); }
  }
  endpoint(path) { return `${window.location.origin}/api/v1/external${path}`; }
  copyRow(label, value, copyLabel = label) { return `<div class="apitok-copy-row"><dt>${this.esc(label)}</dt><dd><code>${this.esc(value)}</code><button type="button" class="button secondary" data-action="apitok-copy-value" data-copy="${this.esc(value)}" data-label="${this.esc(copyLabel)}" aria-label="Copy ${this.esc(copyLabel)}">Copy</button></dd></div>`; }

  // ---- A column's API details (column header menu). No token here: the endpoint needs one the person holds elsewhere.
  showColumnInfo(key) {
    const model = this.c.model, board = model.board, column = board?.columns.find((c) => c.key === key);
    if (!column) return;
    const type = model.columnType(column.type)?.label || column.type;
    this.view.overlay(`<div class="modal apitok-modal apitok-info" role="dialog" aria-labelledby="apitok-info-title"><div class="modal-head"><div><div class="eyebrow">API Information</div><h2 id="apitok-info-title">${this.esc(column.label)}</h2></div>${this.view.closeButton()}</div>
      <dl class="apitok-copy-list"><div class="apitok-copy-row"><dt>Board name</dt><dd>${this.esc(board.name)}</dd></div>${this.copyRow("Board API ID", board.id)}<div class="apitok-copy-row"><dt>Column name</dt><dd>${this.esc(column.label)}</dd></div>${this.copyRow("Column API ID", column.key)}<div class="apitok-copy-row"><dt>Column type</dt><dd>${this.esc(type)}</dd></div>${this.copyRow("Example endpoint", this.endpoint(`/boards/${board.id}/columns/${column.key}/values`), "Endpoint")}</dl>
      <p class="account-note">IDs only say what to read. Requests also need an API token that covers this board: <code>Authorization: Bearer YOUR_JARC_API_TOKEN</code>.</p></div>`, "apitok-overlay");
  }

  // ---- API Explorer: uses this person's session, so it shows only what they can already see, and never a token.
  async explorerStart() {
    const ex = this.ex;
    ex.loading = true;
    try {
      ex.workspaces = (await this.adapter.request("GET", "/workspaces")).items.filter((w) => !w.archived);
      ex.loaded = true; ex.error = "";
      if (ex.workspaces[0]) await this.explorerWorkspace(ex.workspaces[0].id);
    } catch (error) { ex.error = this.message(error); }
    finally { ex.loading = false; this.redraw(); }
  }
  async explorerWorkspace(id) {
    const ex = this.ex;
    Object.assign(ex, { workspaceId: id, boards: [], boardId: "", data: null, example: null, exampleError: "" }); ex.selected = new Set();
    ex.boards = (await this.adapter.request("GET", `/workspaces/${encodeURIComponent(id)}/boards`)).items.filter((b) => !b.archived);
    if (ex.boards[0]) await this.explorerBoard(ex.boards[0].id);
  }
  async explorerBoard(id) {
    const ex = this.ex;
    Object.assign(ex, { boardId: id, data: null, example: null, exampleError: "" }); ex.selected = new Set();
    ex.data = await this.explorerFetch();
  }
  explorerFetch(columns = []) { return this.adapter.request("GET", `/me/api-explorer/boards/${encodeURIComponent(this.ex.boardId)}${columns.length ? `?columns=${columns.map(encodeURIComponent).join(",")}` : ""}`); }
  // In board order, so the address doesn't depend on the order they were ticked.
  explorerSelected() { return (this.ex.data?.columns || []).filter((c) => this.ex.selected.has(c.id)).map((c) => c.id); }
  explorerEndpoints() {
    const board = this.ex.boardId, picked = this.explorerSelected();
    const rows = [["Records", this.endpoint(`/boards/${board}/records${picked.length ? `?columns=${picked.join(",")}` : ""}`)]];
    if (picked.length === 1) rows.push(["One column's values", this.endpoint(`/boards/${board}/columns/${picked[0]}/values`)]);
    return rows;
  }
  explorerHtml() {
    const ex = this.ex, option = (o, current) => `<option value="${this.esc(o.id)}" ${o.id === current ? "selected" : ""}>${this.esc(o.name)}</option>`;
    if (ex.error) return `<p class="account-empty" role="alert">${this.esc(ex.error)}</p><button type="button" class="button secondary" data-action="apitok-ex-retry">Try again</button>`;
    if (!ex.loaded) return `<p class="account-empty" aria-busy="true">Loading workspaces…</p>`;
    if (!ex.workspaces.length) return `<p class="account-empty">You don't have a workspace to explore yet.</p>`;
    const pickers = `<div class="apitok-ex-pickers"><label>Workspace<select data-action="apitok-ex-workspace">${ex.workspaces.map((w) => option(w, ex.workspaceId)).join("")}</select></label><label>Board<select data-action="apitok-ex-board" ${ex.boards.length ? "" : "disabled"}>${ex.boards.map((b) => option(b, ex.boardId)).join("")}</select></label></div>`;
    if (!ex.boards.length) return `<p>See the IDs and addresses for your boards. This shows data you can already see, and your token must include the board.</p>${pickers}<p class="account-empty">This workspace has no boards yet.</p>`;
    if (!ex.data) return `${pickers}<p class="account-empty" aria-busy="true">Loading board…</p>`;
    const typeOf = (t) => this.c.model.columnType?.(t)?.label || t;
    const columns = `<div class="apitok-table-scroll" tabindex="0"><table class="apitok-doc-table apitok-ex-columns"><thead><tr><th><span class="sr-only">Select</span></th><th>Column</th><th>Column API ID</th><th>Type</th><th><span class="sr-only">Copy</span></th></tr></thead><tbody>${ex.data.columns.map((c) => `<tr><td><input type="checkbox" data-action="apitok-ex-column" value="${this.esc(c.id)}" aria-label="Select ${this.esc(c.name)}" ${ex.selected.has(c.id) ? "checked" : ""}></td><td>${this.esc(c.name)}${c.visible === false ? ' <small class="muted">Hidden</small>' : ""}</td><td><code>${this.esc(c.id)}</code></td><td>${this.esc(typeOf(c.type))}</td><td><button type="button" class="button secondary" data-action="apitok-copy-value" data-copy="${this.esc(c.id)}" data-label="Column ID" aria-label="Copy the ID of ${this.esc(c.name)}">Copy</button></td></tr>`).join("")}</tbody></table></div>`;
    const example = ex.example ? `<figure class="apitok-code"><figcaption><span>Example response, from your own access (first ${ex.example.pagination.limit} records at most)</span></figcaption><pre tabindex="0" id="apitok-ex-example"><code>${this.esc(JSON.stringify(ex.example, null, 2))}</code></pre></figure>` : ex.exampleError ? `<p class="account-empty" role="alert">${this.esc(ex.exampleError)}</p>` : "";
    return `<p>See the IDs and addresses for your boards. This shows data you can already see, and your token must include the board.</p>${pickers}
      <dl class="apitok-copy-list">${this.copyRow("Board API ID", ex.boardId)}</dl>
      <h3>Columns</h3><p class="account-note">Select columns to narrow the address. With none selected, it returns every column.</p>${columns}
      <h3>Address</h3><dl class="apitok-copy-list">${this.explorerEndpoints().map(([label, url]) => this.copyRow(label, url, "Endpoint")).join("")}</dl>
      <p class="account-note">Send your token in a header, never in the address: <code>Authorization: Bearer YOUR_JARC_API_TOKEN</code></p>
      <button type="button" class="button secondary" data-action="apitok-ex-example" ${ex.exampleBusy ? "disabled" : ""}>Show example response</button>${example}`;
  }
  async explorerExample() {
    const ex = this.ex;
    ex.exampleBusy = true; ex.exampleError = ""; this.redraw();
    try { ex.example = (await this.explorerFetch(this.explorerSelected())).example; }
    catch (error) { ex.example = null; ex.exampleError = this.message(error); }
    finally { ex.exampleBusy = false; this.redraw(); }
  }
  // Selections change the address without re-reading the board; a board or workspace change reads it, then redraws.
  explorerChange(load) { const ex = this.ex; Promise.resolve().then(load).catch((error) => { ex.error = this.message(error); }).finally(() => this.redraw()); this.redraw(); }

  // ---- Events (data-action="apitok-…")
  onAction(action, target) {
    if (action === "apitok-tab") { this.tab = target.dataset.tab; this.redraw(); return; }
    if (action === "apitok-refresh") { this.items = null; this.error = ""; this.redraw(); this.load(); return; }
    if (action === "apitok-new") { this.showCreate(); return; }
    if (action === "apitok-copy-value") { this.copyText(target.dataset.copy, target.dataset.label); return; }
    if (action === "apitok-copy-board") { this.view.closeOverlay(); this.copyText(target.dataset.id, "Board ID"); return; }
    if (action === "apitok-copy-column") { this.view.closeOverlay(); this.copyText(target.dataset.key, "Column ID"); return; }
    if (action === "apitok-column-info") { this.showColumnInfo(target.dataset.key); return; }
    if (action === "apitok-ex-retry") { this.ex.error = ""; this.ex.loaded = false; this.redraw(); return; }
    if (action === "apitok-ex-example") { this.explorerExample(); return; }
    if (action === "apitok-copy") { this.copySecret(target); return; }
    if (action === "apitok-done") { this.done(); return; }
    if (action === "apitok-cancel") { this.pending = null; this.backToList(false); return; }
    if (action === "apitok-copy-example") { const text = document.querySelector(`#apitok-example-${target.dataset.example}`)?.textContent; if (text) navigator.clipboard?.writeText(text).then(() => this.view.toast("Copied"), () => this.view.toast("Select the text and copy it")); return; }
    const token = this.items?.find((t) => t.id === target.dataset.id);
    if (action === "apitok-rotate" && token) this.showRotate(token);
    if (action === "apitok-revoke" && token) this.showRevoke(token);
  }
  onChange(select) {
    const change = select.dataset.action;
    if (change === "apitok-ex-workspace") { this.explorerChange(() => this.explorerWorkspace(select.value)); return; }
    if (change === "apitok-ex-board") { this.explorerChange(() => this.explorerBoard(select.value)); return; }
    if (change === "apitok-ex-column") { if (select.checked) this.ex.selected.add(select.value); else this.ex.selected.delete(select.value); this.ex.example = null; const list = document.querySelector("#apitok-root .apitok-ex-columns"), scroll = list?.parentElement?.scrollLeft; this.redraw(); const next = document.querySelector("#apitok-root .apitok-ex-columns"); if (next?.parentElement && scroll) next.parentElement.scrollLeft = scroll; document.querySelector(`#apitok-root [data-action="apitok-ex-column"][value="${CSS.escape(select.value)}"]`)?.focus(); return; }
    if (change === "apitok-workspace") { const form = select.closest("form"), name = form.elements.name.value, expires = form.elements.expires.value; this.showCreate(select.value); const next = document.querySelector(".apitok-modal form, form.apitok-modal"); next.elements.name.value = name; next.elements.expires.value = expires; } }
  onSubmit(action, form) {
    if (action === "apitok-create-form") this.submitCreate(form);
    if (action === "apitok-rotate-form") this.submitRotate(form);
    if (action === "apitok-revoke-form") this.submitRevoke(form);
  }
}

window.ApiTokensPanel = ApiTokensPanel;
