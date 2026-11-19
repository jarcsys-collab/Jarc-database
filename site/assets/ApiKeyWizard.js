// Developer → API Keys: Create API key (four guided steps), the one time a secret is shown, and a key's Connection details.
// Added to ApiTokensPanel (loaded after it). The server decides everything (services/api-token-service.js): which workspaces and
// boards may be chosen, each board's workspace (read from the database, never from this page), duplicates, limits and expiry.
//
//   1 Details    name, optional description, read-only permission, expiry (up to 5 calendar years)
//   2 Boards     every shared workspace the administrator may issue keys for, read afresh each time the window opens; boards from
//                several workspaces can be chosen. Only the boards of expanded (or searched) workspaces are drawn, a page at a
//                time, and the choice is kept in memory, so searching or collapsing never loses it. Future boards are never added.
//   3 Review     everything that will be created, and an explicit confirmation
//   4 Created    the secret, ONCE (never stored in the browser, the model or an address), and every board's endpoints to copy
//
// Connection details show the same endpoints for an existing key, without its secret: the server never returns it again.
(() => {
  const P = window.ApiTokensPanel;
  if (!P) return;
  const STEPS = [["details", "Details"], ["boards", "Boards"], ["review", "Review"], ["created", "Created"]];
  const PAGE = 200; // boards drawn per workspace before "Show more"
  const EXAMPLES = [["powerbi", "Power BI / Power Query"], ["automate", "Power Automate HTTP"], ["n8n", "n8n HTTP Request"], ["apps", "Google Apps Script"], ["fetch", "JavaScript fetch"], ["postman", "Postman"], ["curl", "cURL"]];

  Object.assign(P.prototype, {
    boardLimit() { return this.limits?.boardsPerToken || 100; },

    // ---- Opening: a new choice every time, and the workspaces and boards read again (boards created or imported since appear).
    showCreate() {
      const gen = (this.wiz?.gen || 0) + 1;
      this.wiz = { gen, step: 0, name: "", description: "", expires: this.dateInput(90), selected: new Map(), expanded: new Set(), shown: new Map(), query: "", loadError: "", error: "", busy: false, confirmed: false, dropped: 0 };
      this.renderWizard();
      this.refreshWizard(gen);
    },
    async refreshWizard(gen) {
      let failed = "";
      try { await this.refreshOptions(); } catch (error) { failed = this.message(error); }
      const w = this.wiz;
      if (!w || w.gen !== gen || !this.wizardForm()) return; // closed, or opened again meanwhile: a late answer changes nothing
      w.loadError = failed;
      if (!failed) this.pruneSelection();
      if (w.step === 1) this.drawPicker(); else if (w.step === 0) this.updateNav();
    },
    // Boards that disappeared since they were chosen are dropped (the server would refuse them anyway), and the person is told.
    pruneSelection() {
      const w = this.wiz, listed = new Map((this.options || []).flatMap((s) => s.boards.map((b) => [b.id, s])));
      for (const id of [...w.selected.keys()]) if (!listed.has(id)) { w.selected.delete(id); w.dropped += 1; }
    },
    wizardForm() { const form = document.querySelector('#overlay-root form.apikey-wizard'); return form && this.wiz && form.dataset.gen === String(this.wiz.gen) ? form : null; },
    spaces() { return (this.options || []).filter((s) => s.boards.length); },
    workspaceOf(id) { return (this.options || []).find((s) => s.id === id) || null; },

    renderWizard() {
      const w = this.wiz, step = w.step;
      const steps = STEPS.slice(0, 3).map(([, label], i) => `<li class="${i < step ? "done" : ""}" ${i === step ? 'aria-current="step"' : ""}><span aria-hidden="true">${i < step ? "✓" : i + 1}</span>${label}</li>`).join("");
      const body = step === 0 ? this.detailsHtml() : step === 1 ? this.pickerHtml() : this.reviewHtml();
      const next = step === 2 ? `<button class="button primary" data-role="create" ${w.confirmed && !w.busy ? "" : "disabled"}>${w.busy ? "Creating…" : "Create API key"}</button>` : `<button class="button primary" data-role="next">Next</button>`;
      this.view.overlay(`<form class="modal apitok-modal apikey-wizard" data-action="apitok-create-form" data-gen="${w.gen}" data-step="${STEPS[step][0]}" novalidate role="dialog" aria-modal="true" aria-labelledby="apikey-wiz-title">
        <div class="modal-head"><div><div class="eyebrow">API Keys</div><h2 id="apikey-wiz-title">Create API key</h2></div>${this.view.closeButton()}</div>
        <ol class="apikey-steps" aria-label="Steps">${steps}</ol>
        <div class="apikey-step-body">${body}</div>
        <p class="account-empty apitok-error" role="alert">${this.esc(w.error)}</p>
        <div class="modal-actions">${step > 0 ? `<button type="button" class="button secondary" data-action="apitok-wiz-back">Back</button>` : ""}<span class="modal-spacer"></span><button type="button" class="button secondary" data-action="apitok-cancel">Cancel</button>${next}</div></form>`, "apitok-overlay apikey-overlay");
      if (step === 1) this.afterPicker();
      const focus = step === 0 ? '[name="name"]' : step === 1 ? '[data-action="apitok-wiz-search"]' : '[data-action="apitok-wiz-confirm"]';
      document.querySelector(`#overlay-root form.apikey-wizard ${focus}`)?.focus();
      this.updateNav();
    },
    // The Next button waits for the board list on step 2.
    updateNav() {
      const form = this.wizardForm(), next = form?.querySelector('[data-role="next"]');
      if (next && this.wiz.step === 1) next.disabled = !this.options || !this.spaces().length;
    },
    say(text) { if (this.wiz) this.wiz.error = text; const el = this.wizardForm()?.querySelector(".apitok-error"); if (el) el.textContent = text; },

    // ---- Step 1
    detailsHtml() {
      const w = this.wiz;
      return `<div class="form-grid"><label class="full">API key name<input name="name" required maxlength="100" placeholder="Power BI Company Reports" autocomplete="off" value="${this.esc(w.name)}"></label>
        <label class="full">Description <small class="field-note">optional</small><textarea name="description" rows="2" maxlength="500" placeholder="What this key is for, and who looks after the integration">${this.esc(w.description)}</textarea></label>
        <label>Permissions<select name="scope" disabled><option>Read-only</option></select><small class="muted">Keys can only read. Nothing can be changed through the API.</small></label>
        <label>Expires on<input type="date" name="expires" required min="${this.dateInput(1)}" max="${this.maxDateInput()}" value="${this.esc(w.expires)}" aria-describedby="apitok-expiry-help"><small id="apitok-expiry-help" class="muted">Tomorrow up to ${P.MAX_YEARS} years from today (${this.date(P.latestExpiry().toISOString())}).</small></label></div>`;
    },
    readDetails(form) {
      const w = this.wiz;
      w.name = form.elements.name.value.trim(); w.description = form.elements.description.value.trim(); w.expires = form.elements.expires.value;
      if (!w.name) return "Give the API key a name.";
      if (w.name.length > 100) return "The name can be at most 100 characters.";
      if (w.description.length > 500) return "The description can be at most 500 characters.";
      if (!this.endOfDay(w.expires)) return this.expiryProblem();
      return "";
    },

    // ---- Step 2: the board picker
    pickerHtml() {
      const w = this.wiz;
      return `<div class="apikey-picker"><div class="apikey-picker-bar"><label class="apikey-search">${icon("search")}<input type="search" data-action="apitok-wiz-search" value="${this.esc(w.query)}" placeholder="Search workspaces and boards" aria-label="Search workspaces and boards" aria-controls="apikey-workspaces" autocomplete="off"></label>
        <span class="apikey-count" id="apikey-count" role="status" aria-live="polite"></span><button type="button" class="button secondary small" data-action="apitok-wiz-clear">Clear selection</button></div>
        <div class="apikey-workspaces" id="apikey-workspaces" aria-busy="${this.options ? "false" : "true"}"></div>
        <div class="apikey-chosen" id="apikey-chosen"></div>
        <p class="account-note">The key reads only the boards you select, from as many workspaces as you need (up to ${this.boardLimit()}). Boards created later are never added: create a new key to include them.</p></div>`;
    },
    // Enter in the search box applies the search at once; it doesn't submit the form and move on to the review.
    afterPicker() {
      document.querySelector('#overlay-root form.apikey-wizard [data-action="apitok-wiz-search"]')?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); clearTimeout(this.searchTimer); if (this.wiz) this.wiz.query = event.target.value; this.drawPicker(); }
      });
      this.drawPicker();
    },
    // The workspaces and the visible boards (search, expanded sections and paging decide which), then the counts and the summary.
    drawPicker() {
      const w = this.wiz, area = document.querySelector("#apikey-workspaces");
      if (!area) return;
      const retry = `<button type="button" class="button secondary small" data-action="apitok-boards-retry">Try again</button>`;
      this.updateNav();
      if (!this.options) {
        area.setAttribute("aria-busy", w.loadError ? "false" : "true");
        area.innerHTML = w.loadError ? `<p class="account-empty" role="alert">Couldn't load the workspaces and boards. ${this.esc(w.loadError)}</p>${retry}` : `<p role="status"><span class="loading-spinner" aria-hidden="true"></span> Loading workspaces and boards…</p>`;
        this.drawCounts();
        return;
      }
      area.setAttribute("aria-busy", "false");
      const stale = w.loadError ? `<p class="account-empty" role="status">Couldn't refresh the list, so it may be out of date. ${retry}</p>` : "";
      const dropped = w.dropped ? `<p class="account-alert is-warn" role="status"><span>${w.dropped} selected board${w.dropped === 1 ? " is" : "s are"} no longer available and ${w.dropped === 1 ? "was" : "were"} removed from your selection.</span></p>` : "";
      const spaces = this.spaces();
      if (!spaces.length) { area.innerHTML = `${stale}<p class="account-empty" role="status">There are no boards you can create a key for yet. Boards appear here as soon as they're created or imported.</p>`; this.drawCounts(); return; }
      const q = w.query.trim().toLowerCase();
      const sections = spaces.map((s) => {
        const wsHit = !q || s.name.toLowerCase().includes(q);
        const boards = wsHit ? s.boards : s.boards.filter((b) => b.name.toLowerCase().includes(q) || b.id === q);
        if (!boards.length) return "";
        return this.workspaceSectionHtml(s, boards, Boolean(q) || w.expanded.has(s.id));
      }).join("");
      area.innerHTML = `${dropped}${stale}${sections || `<p class="account-empty" role="status">No workspaces or boards match “${this.esc(w.query)}”.</p>`}`;
      area.querySelectorAll('input[data-action="apitok-wiz-all"]').forEach((box) => { const s = this.workspaceOf(box.value), n = s ? s.boards.filter((b) => w.selected.has(b.id)).length : 0; box.indeterminate = n > 0 && n < (s?.boards.length || 0); });
      this.drawCounts();
    },
    workspaceSectionHtml(s, boards, open) {
      const w = this.wiz, id = this.esc(s.id), picked = s.boards.filter((b) => w.selected.has(b.id)).length;
      const limit = w.shown.get(s.id) || PAGE, list = open ? boards.slice(0, limit) : [];
      const rows = list.map((b) => `<label class="apitok-check apikey-board"><input type="checkbox" name="board" data-action="apitok-wiz-board" value="${this.esc(b.id)}" data-ws="${id}" ${w.selected.has(b.id) ? "checked" : ""}><span>${this.esc(this.withArchived(b))}</span></label>`).join("");
      const more = open && boards.length > limit ? `<button type="button" class="button secondary small" data-action="apitok-wiz-more" data-ws="${id}">Show ${Math.min(PAGE, boards.length - limit)} more of ${boards.length - limit}</button>` : "";
      const all = picked === s.boards.length;
      return `<section class="apikey-ws ${open ? "is-open" : ""}" data-ws="${id}"><div class="apikey-ws-head">
        <button type="button" class="apikey-ws-toggle" data-action="apitok-wiz-toggle" data-ws="${id}" aria-expanded="${open}" aria-controls="apikey-ws-${id}">${icon(open ? "chevron" : "right")}<strong>${this.esc(this.withArchived(s))}</strong><small>${s.boards.length} board${s.boards.length === 1 ? "" : "s"}</small></button>
        <span class="apikey-ws-picked" data-picked="${id}">${picked ? `${picked} selected` : ""}</span>
        <label class="apitok-check apikey-ws-all"><input type="checkbox" data-action="apitok-wiz-all" value="${id}" ${all ? "checked" : ""} aria-label="Select all ${s.boards.length} boards in ${this.esc(s.name)}"><span>Select all</span></label></div>
        <div class="apikey-board-list" id="apikey-ws-${id}" role="group" aria-label="Boards in ${this.esc(s.name)}" ${open ? "" : "hidden"}>${rows}${more}</div></section>`;
    },
    // Counts, the selected boards (grouped by workspace) and each section's "n selected", updated without redrawing the list.
    drawCounts() {
      const w = this.wiz, count = document.querySelector("#apikey-count"), chosen = document.querySelector("#apikey-chosen");
      const groups = this.selectedGroups(), n = w.selected.size;
      if (count) count.textContent = n ? `${n} board${n === 1 ? "" : "s"} · ${groups.length} workspace${groups.length === 1 ? "" : "s"} selected` : "No boards selected";
      if (chosen) chosen.innerHTML = n ? `<h3 class="sr-only">Selected boards</h3>${groups.map(({ workspace, boards }) => `<div class="apikey-chosen-ws"><strong>${this.esc(workspace.name)}</strong><ul>${boards.map((b) => `<li><span>${this.esc(b.name)}</span><button type="button" class="icon-button apikey-remove" data-action="apitok-wiz-remove" data-id="${this.esc(b.id)}" aria-label="Remove ${this.esc(b.name)}">${icon("close")}</button></li>`).join("")}</ul></div>`).join("")}` : "";
      for (const s of this.spaces()) {
        const picked = s.boards.filter((b) => w.selected.has(b.id)).length;
        const label = document.querySelector(`#apikey-workspaces [data-picked="${CSS.escape(s.id)}"]`); if (label) label.textContent = picked ? `${picked} selected` : "";
        const box = document.querySelector(`#apikey-workspaces input[data-action="apitok-wiz-all"][value="${CSS.escape(s.id)}"]`); if (box) { box.checked = picked === s.boards.length; box.indeterminate = picked > 0 && picked < s.boards.length; }
      }
    },
    // The selection as [{ workspace, boards }], in the order of the workspace list and of each workspace's boards.
    selectedGroups() {
      const w = this.wiz;
      return (this.options || []).map((s) => ({ workspace: s, boards: s.boards.filter((b) => w.selected.has(b.id)) })).filter((g) => g.boards.length);
    },
    select(ids, on, wsId) {
      const w = this.wiz;
      if (on) {
        const adding = ids.filter((id) => !w.selected.has(id));
        if (w.selected.size + adding.length > this.boardLimit()) { this.say(`One API key can cover at most ${this.boardLimit()} boards. Create another key for the rest.`); return false; }
        for (const id of adding) w.selected.set(id, wsId);
      } else for (const id of ids) w.selected.delete(id);
      this.say("");
      return true;
    },
    wizardSearch(value) {
      const w = this.wiz;
      if (!w) return;
      w.query = value;
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.drawPicker(), 120);
    },

    // ---- Step 3
    reviewHtml() {
      const w = this.wiz, groups = this.selectedGroups(), n = w.selected.size, expiresAt = this.endOfDay(w.expires);
      return `<dl class="apikey-review"><div><dt>API key name</dt><dd>${this.esc(w.name)}</dd></div>${w.description ? `<div><dt>Description</dt><dd>${this.esc(w.description)}</dd></div>` : ""}<div><dt>Permissions</dt><dd>Read-only</dd></div><div><dt>Expires</dt><dd>${expiresAt ? this.dateTime(expiresAt) : "—"}</dd></div><div><dt>Boards</dt><dd>${n} board${n === 1 ? "" : "s"} in ${groups.length} workspace${groups.length === 1 ? "" : "s"}</dd></div></dl>
        <div class="apikey-review-boards">${groups.map(({ workspace, boards }) => `<section><h3>${this.esc(workspace.name)} <small>${boards.length} board${boards.length === 1 ? "" : "s"}</small></h3><ul>${boards.map((b) => `<li>${this.esc(this.withArchived(b))}</li>`).join("")}</ul></section>`).join("")}</div>
        <label class="apitok-check apikey-confirm"><input type="checkbox" data-action="apitok-wiz-confirm" ${w.confirmed ? "checked" : ""}><span>I confirm this key may read these ${n} board${n === 1 ? "" : "s"}, and only these.</span></label>`;
    },
    async createKey(form) {
      const w = this.wiz;
      if (w.busy) return; // a second click while the first request runs does nothing
      if (!w.confirmed) { this.say("Tick the confirmation to create the key."); return; }
      const expiresAt = this.endOfDay(w.expires);
      if (!expiresAt) { this.say(this.expiryProblem()); return; }
      w.busy = true;
      const button = form.querySelector('[data-role="create"]'); if (button) { button.disabled = true; button.textContent = "Creating…"; }
      const gen = w.gen;
      try {
        // No workspace is sent: the server reads each board's workspace itself.
        const result = await this.api("POST", "", { name: w.name, ...(w.description ? { description: w.description } : {}), boardIds: [...w.selected.keys()], scopes: ["read"], expiresAt });
        if (this.wiz?.gen !== gen) return;
        this.reveal(result, "API key created");
      } catch (error) {
        if (this.wiz?.gen !== gen) return;
        w.busy = false;
        // The browser reads only the error's code, never the server's text (StorageService.js). Name, description and expiry were
        // checked here already, so a refusal means a selected board is no longer available: the list is read again, and boards that
        // disappeared are taken out of the selection (shown on the Boards step).
        if (error?.code === "VALIDATION_ERROR") {
          this.say("A selected board is no longer available, or you can no longer create keys for it. Go Back to Boards: the list has been refreshed.");
          this.refreshOptions().then(() => { if (this.wiz?.gen === gen) this.pruneSelection(); }).catch(() => {});
        } else this.say(this.message(error));
        if (button) { button.disabled = !w.confirmed; button.textContent = "Create API key"; }
      }
    },

    // ---- Moving between steps
    submitWizard(form) {
      const w = this.wiz;
      if (!w || form.dataset.gen !== String(w.gen)) return;
      if (w.step === 0) { const problem = this.readDetails(form); if (problem) { this.say(problem); return; } w.error = ""; w.step = 1; this.renderWizard(); return; }
      if (w.step === 1) { if (!this.options) return; if (!w.selected.size) { this.say("Select at least one board."); return; } w.error = ""; w.confirmed = false; w.step = 2; this.renderWizard(); return; }
      this.createKey(form);
    },
    onWizardAction(action, target) {
      const w = this.wiz;
      if (action === "apitok-copy-all") { this.copyText(target.dataset.copy || this.endpointsText(this.revealed || this.connected), "Endpoints"); return; }
      if (action === "apitok-conn-close") { this.connected = null; this.backToTab(this.tab); return; }
      if (!w) return;
      if (action === "apitok-boards-retry") { w.loadError = ""; this.drawPicker(); this.refreshWizard(w.gen); return; }
      if (action === "apitok-wiz-back") { if (w.busy) return; const form = this.wizardForm(); if (w.step === 0 || !form) return; w.error = ""; w.step -= 1; this.renderWizard(); return; }
      if (action === "apitok-wiz-toggle") { const id = target.dataset.ws; if (w.expanded.has(id)) w.expanded.delete(id); else w.expanded.add(id); this.drawPicker(); document.querySelector(`#apikey-workspaces [data-action="apitok-wiz-toggle"][data-ws="${CSS.escape(id)}"]`)?.focus(); return; }
      if (action === "apitok-wiz-more") { const id = target.dataset.ws; w.shown.set(id, (w.shown.get(id) || PAGE) + PAGE); this.drawPicker(); document.querySelector(`#apikey-workspaces [data-action="apitok-wiz-toggle"][data-ws="${CSS.escape(id)}"]`)?.focus(); return; }
      if (action === "apitok-wiz-clear") { w.selected.clear(); w.dropped = 0; this.say(""); this.drawPicker(); return; }
      if (action === "apitok-wiz-remove") { w.selected.delete(target.dataset.id); const box = document.querySelector(`#apikey-workspaces input[data-action="apitok-wiz-board"][value="${CSS.escape(target.dataset.id)}"]`); if (box) box.checked = false; this.drawCounts(); document.querySelector('#overlay-root [data-action="apitok-wiz-search"]')?.focus(); }
    },
    onWizardChange(input) {
      const w = this.wiz, change = input.dataset.action;
      if (change === "apitok-conn-example") { this.showExample(input.value); return; }
      if (!w) return;
      if (change === "apitok-wiz-board") { if (!this.select([input.value], input.checked, input.dataset.ws)) input.checked = false; this.drawCounts(); return; }
      if (change === "apitok-wiz-all") {
        const s = this.workspaceOf(input.value); if (!s) return;
        if (!this.select(s.boards.map((b) => b.id), input.checked, s.id)) input.checked = false;
        document.querySelectorAll(`#apikey-workspaces input[data-action="apitok-wiz-board"][data-ws="${CSS.escape(s.id)}"]`).forEach((box) => { box.checked = w.selected.has(box.value); });
        this.drawCounts(); return;
      }
      if (change === "apitok-wiz-confirm") { w.confirmed = input.checked; const button = this.wizardForm()?.querySelector('[data-role="create"]'); if (button) button.disabled = !w.confirmed || w.busy; }
    },

    // ---- Step 4, and rotation: the one time a secret is shown. Escape and outside clicks don't close it (data-keep-open).
    reveal(result, title) {
      this.secret = result.secret; this.revealed = result.token; this.wiz = null;
      const t = result.token, spaces = this.groupsOf(t);
      document.querySelector("#overlay-root").innerHTML = `<div class="overlay apitok-overlay apikey-overlay" data-keep-open="1"><div class="modal apitok-modal apikey-created" role="dialog" aria-modal="true" aria-labelledby="apitok-reveal-title"><div class="modal-head"><div><div class="eyebrow">${this.esc(t.name)}</div><h2 id="apitok-reveal-title">${this.esc(title)}</h2></div></div>
        <div class="account-alert is-warn" role="status"><strong>Copy this API key now. You won't see it again.</strong><span>Keep it in a secure backend or approved secret store, never in public JavaScript, an address or a shared file. Closing this window forgets it; after that, only a new or rotated key gives a secret.</span></div>
        <div class="apitok-secret"><input id="apitok-secret" type="text" readonly spellcheck="false" autocomplete="off" aria-label="Your API key" value="${this.esc(result.secret)}"><button type="button" class="button primary" data-action="apitok-copy">Copy API key</button></div>
        <dl class="apikey-review"><div><dt>API key name</dt><dd>${this.esc(t.name)}</dd></div><div><dt>Expires</dt><dd>${this.dateTime(t.expiresAt)}</dd></div><div><dt>Permissions</dt><dd>Read-only</dd></div><div><dt>Boards</dt><dd>${t.boards.length} board${t.boards.length === 1 ? "" : "s"} in ${spaces.length} workspace${spaces.length === 1 ? "" : "s"}</dd></div></dl>
        ${this.connectionHtml(t)}
        <div class="modal-actions"><button type="button" class="button primary" data-action="apitok-done">I've saved it</button></div></div></div>`;
      document.querySelector("#apitok-secret")?.select();
    },

    // ---- Connection details of an existing key: its boards and endpoints, never its secret.
    showConnection(t) {
      this.connected = t;
      const [label, tone] = P.STATUS[t.status] || ["Unknown", "muted"];
      const own = t.mine && t.canRotate ? "rotate it (Rotate on the key's card) or create a new key" : "create a new key (only its owner can rotate it)";
      this.view.overlay(`<div class="modal apitok-modal apikey-created apikey-details" role="dialog" aria-modal="true" aria-labelledby="apikey-details-title"><div class="modal-head"><div><div class="eyebrow">Connection details</div><h2 id="apikey-details-title">${this.esc(t.name)}</h2></div>${this.view.closeButton()}</div>
        <dl class="apikey-review"><div><dt>Key</dt><dd><code>${this.esc(t.prefix)}…</code> <span class="account-badge is-${tone}">${label}</span></dd></div><div><dt>Owner</dt><dd>${this.esc(this.ownerName(t))}</dd></div><div><dt>Expires</dt><dd>${t.status === "revoked" ? "Revoked" : this.dateTime(t.expiresAt)}</dd></div><div><dt>Permissions</dt><dd>Read-only</dd></div></dl>
        <div class="account-alert is-ok" role="note"><strong>The secret isn't shown again.</strong><span>It was shown once, when the key was created. Use the copy you stored then. If it's lost, ${own}.</span></div>
        ${this.connectionHtml(t)}
        <div class="modal-actions"><button type="button" class="button secondary" data-action="apitok-key-activity" data-id="${this.esc(t.id)}">View activity</button><button type="button" class="button secondary" data-action="apitok-key-explorer" data-id="${this.esc(t.id)}">Open in API Explorer</button><span class="modal-spacer"></span><button type="button" class="button primary" data-action="apitok-conn-close">Done</button></div></div>`, "apitok-overlay apikey-overlay");
    },

    // The key's boards grouped by workspace (boards it can't reach now are listed apart), for display and copying.
    groupsOf(t) {
      const spaces = t.workspaces || [t.workspace], groups = [];
      for (const s of spaces) { const boards = t.boards.filter((b) => b.available !== false && b.workspaceId === s.id); if (boards.length) groups.push({ workspace: s, boards }); }
      const gone = t.boards.filter((b) => b.available === false || !b.workspaceId || !spaces.some((s) => s.id === b.workspaceId));
      if (gone.length) groups.push({ workspace: { id: "", name: "Not available now" }, boards: gone, unavailable: true });
      return groups;
    },
    boardUrls(id) { return { board: this.endpoint(this.boardPath(id)), records: this.endpoint(this.boardPath(id, "/records")) }; },
    // Shown as "GET <url>"; Copy copies the address alone.
    endpointRow(label, url) { return `<div class="apitok-copy-row apikey-endpoint"><dt>${this.esc(label)}</dt><dd><code><span class="apikey-verb">GET</span> ${this.esc(url)}</code>${this.copyButton(url, label)}</dd></div>`; },
    // Plain text for "Copy all endpoints": names, IDs and addresses. Never the secret.
    endpointsText(t) {
      if (!t) return "";
      const lines = [`JARC API key: ${t.name} (${t.prefix}…, read-only)`, `Base URL: ${this.endpoint("")}`, "Header: Authorization: Bearer YOUR_JARC_API_TOKEN", ""];
      for (const g of this.groupsOf(t)) {
        if (g.unavailable) continue;
        lines.push(`${g.workspace.name}`);
        for (const b of g.boards) { const u = this.boardUrls(b.id); lines.push(`  ${b.name} (${b.id})`, `    Board:   GET ${u.board}`, `    Records: GET ${u.records}`); }
        lines.push("");
      }
      return lines.join("\n").trimEnd();
    },
    connectionHtml(t) {
      const groups = this.groupsOf(t), first = t.boards.find((b) => b.available !== false && b.workspaceId)?.id || "BOARD_ID";
      const board = (b, off) => { const u = this.boardUrls(b.id); return `<li class="apikey-conn-board"><div class="apikey-conn-name"><strong>${this.esc(b.name || "Board not available")}</strong><span><code>${this.esc(b.id)}</code>${this.copyButton(b.id, "Board ID", "Copy ID")}</span></div>${off ? `<p class="muted">Its owner can't read it now, or it was deleted or moved: requests answer 404.</p>` : `<dl class="apitok-copy-list">${this.endpointRow("Board endpoint", u.board)}${this.endpointRow("Records endpoint", u.records)}</dl>`}</li>`; };
      return `<section class="apikey-conn" aria-labelledby="apikey-conn-title"><div class="apikey-section-head"><h3 id="apikey-conn-title">Authorized boards and endpoints</h3><button type="button" class="button secondary small" data-action="apitok-copy-all" data-copy="${this.esc(this.endpointsText(t))}">Copy all endpoints</button></div>
        <dl class="apitok-copy-list">${this.copyRow("Base URL", this.endpoint(""), "Base URL")}${this.copyRow("Header", "Authorization: Bearer YOUR_JARC_API_TOKEN", "Header")}</dl>
        ${groups.map((g) => `<div class="apikey-conn-ws"><h4>${this.esc(g.workspace.name || "Workspace not available")} <small>${g.boards.length} board${g.boards.length === 1 ? "" : "s"}</small></h4><ul class="apikey-conn-list">${g.boards.map((b) => board(b, g.unavailable)).join("")}</ul></div>`).join("")}
        <p class="account-note">The <strong>board endpoint</strong> returns the board with its columns and groups; the <strong>records endpoint</strong> returns its records, 100 per page (up to 500 with <code>?limit=500</code>), with <code>pagination.nextCursor</code> for the next page. Each board is read separately: there is no single request for several boards.</p></section>
        <section class="apikey-connect" aria-labelledby="apikey-connect-title"><h3 id="apikey-connect-title">Connect an application</h3>
        <ol class="apikey-howto"><li>Store the API key in the application's secure credentials, never in the address or a shared file.</li><li>Send it with every request as <code>Authorization: Bearer YOUR_JARC_API_TOKEN</code>.</li><li>Call a board's records endpoint, and follow <code>nextCursor</code> until it is <code>null</code>.</li></ol>
        <label class="apikey-example-pick">Example<select data-action="apitok-conn-example" data-board="${this.esc(first)}">${EXAMPLES.map(([id, label]) => `<option value="${id}">${this.esc(label)}</option>`).join("")}</select></label>
        <div id="apikey-example">${this.exampleHtml("powerbi", first)}</div></section>`;
    },
    showExample(kind) {
      const pick = document.querySelector('#overlay-root [data-action="apitok-conn-example"]'), box = document.querySelector("#apikey-example");
      if (box) box.innerHTML = this.exampleHtml(kind, pick?.dataset.board || "BOARD_ID");
    },
    // Copy-ready examples with a placeholder in place of the secret.
    exampleHtml(kind, boardId) {
      const base = this.endpoint(""), url = this.endpoint(this.boardPath(boardId, "/records"));
      const label = EXAMPLES.find(([id]) => id === kind)?.[1] || "Example";
      const text = ({
        powerbi: `// Power BI or Excel: Get data → Blank query → Advanced editor.\n// Create a parameter named JarcToken holding the key; when asked for credentials choose Anonymous.\nlet\n    Url = "${url}",\n    GetPage = (cursor as nullable text) => Json.Document(Web.Contents(Url, [\n        Query = [limit = "500"] & (if cursor = null then [] else [cursor = cursor]),\n        Headers = [Authorization = "Bearer " & JarcToken]\n    ])),\n    Pages = List.Generate(() => GetPage(null), each _ <> null,\n        each if _[pagination][nextCursor] = null then null else GetPage(_[pagination][nextCursor])),\n    Records = List.Combine(List.Transform(Pages, each _[items])),\n    Table = Table.FromRecords(Records)\nin\n    Table`,
        automate: `HTTP action\n  Method:  GET\n  URI:     ${url}\n  Queries: limit = 500, cursor = @{variables('cursor')}\n  Headers: Authorization = Bearer @{parameters('JarcApiToken')}\n\nKeep the key in a secure environment variable or Azure Key Vault, and turn on Secure Inputs and Outputs.\nRepeat in a "Do until" loop until body('HTTP')?['pagination']?['nextCursor'] is null.`,
        n8n: `HTTP Request node\n  Method: GET\n  URL:    ${url}\n  Authentication: Generic Credential Type → Header Auth\n    Name:  Authorization\n    Value: Bearer YOUR_JARC_API_TOKEN   (saved in n8n's encrypted credentials)\n  Query parameter: limit = 500\n  Options → Pagination: Update a Parameter in Each Request\n    Query "cursor" = {{ $response.body.pagination.nextCursor }}\n    Complete when: {{ $response.body.pagination.nextCursor === null }}`,
        apps: `// Google Apps Script. Store the key once: Project Settings → Script properties → JARC_API_TOKEN.\nfunction readJarcBoard() {\n  const token = PropertiesService.getScriptProperties().getProperty("JARC_API_TOKEN");\n  const records = [];\n  let cursor = null;\n  do {\n    const url = "${url}?limit=500" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");\n    const response = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true });\n    const body = JSON.parse(response.getContentText());\n    if (response.getResponseCode() !== 200) throw new Error(body.error.code + ": " + body.error.message);\n    records.push(...body.items);\n    cursor = body.pagination.nextCursor;\n  } while (cursor);\n  return records;\n}`,
        fetch: `// Run on a server, never in a web page. Keep the key in an environment variable or secret store.\nconst response = await fetch("${url}?limit=500", {\n  headers: { Authorization: \`Bearer \${process.env.JARC_API_TOKEN}\` }\n});\nconst body = await response.json();\nif (!response.ok) throw new Error(\`\${body.error.code}: \${body.error.message}\`);\n// More pages: while body.pagination.nextCursor isn't null, request again with &cursor=<nextCursor>.`,
        postman: `Postman\n  1. Environments → add a secret variable JARC_API_TOKEN holding the key (type: secret).\n  2. New request: GET ${url}\n  3. Authorization tab → Type: Bearer Token → Token: {{JARC_API_TOKEN}}\n  4. Params: limit = 500. For the next page add cursor = the response's pagination.nextCursor.\n  Base URL for other requests: ${base}`,
        curl: `# Keep the key out of your scripts: export JARC_API_TOKEN="paste-your-key-here"\ncurl -H "Authorization: Bearer $JARC_API_TOKEN" \\\n  "${url}?limit=500"`
      })[kind] || "";
      return this.codeBlock("conn", label, text);
    }
  });
})();
