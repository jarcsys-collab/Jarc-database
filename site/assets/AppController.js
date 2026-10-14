class AppController {
  constructor(root) {
    this.root = root; this.auth = new AuthModel(); this.model = new BoardModel(); this.view = new AppView(root);this.view.onUndo=()=>{if(this.busy)return;const label=this.model.undo();this.update();this.view.toast(label);};
    this.integrations = typeof IntegrationsPanel === "function" ? new IntegrationsPanel(this) : null; this.view.integrations = this.integrations;
    this.groupActions = typeof BoardGroupActions === "function" ? new BoardGroupActions(this) : null;
    this.appearance = typeof AppearanceActions === "function" ? new AppearanceActions(this) : null;
    this.comments = typeof CommentsPanel === "function" ? new CommentsPanel(this) : null;
    this.view.onRecordDrawer = (row) => this.comments?.open(row.id);
    root.addEventListener("click", (event) => this.guard(()=>this.onClick(event)));
    root.addEventListener("input", (event) => this.onInput(event));
    root.addEventListener("change", (event) => this.guard(()=>this.onChange(event)));
    root.addEventListener("submit", (event) => { if(this.busy)event.preventDefault(); this.guard(()=>this.onSubmit(event)); }); // never a native submit, even while busy
    root.addEventListener("pointerdown", () => this.auth.touch());
    for (const type of ["dragover", "dragleave", "drop"]) root.addEventListener(type, (event) => this.onFileDrag(event));
    // A cell range ends when focus moves to a cell outside it (click, Tab, plain arrows).
    root.addEventListener("focusin", (event) => { if (this.cellRange && !this.extendingRange && event.target.classList?.contains("cell-display") && !event.target.closest("td")?.classList.contains("cell-in-range")) this.clearRange(); });
    document.addEventListener("copy", (event) => this.onCopy(event));
    document.addEventListener("paste", (event) => this.onPaste(event));
    window.addEventListener("resize", () => { cancelAnimationFrame(this.fitFrame); this.fitFrame = requestAnimationFrame(() => this.view.fitBoard()); });
    this.uploads = new Map(); this.filesConfirm = null; this.filesNotice = null; this.freshFiles = new Set(); this.fileSeq = new Map();
    root.addEventListener("keyup", (event) => { if (event.target.dataset?.action === "password-input") { const warning=document.querySelector("#caps-warning"); if(warning) warning.hidden=!event.getModifierState("CapsLock"); } });
    document.addEventListener("keydown", (event) => this.onKeydown(event));
    root.addEventListener("keydown",()=>this.auth.touch());
    setInterval(() => { if (this.ready && this.auth.checkTimeout()) this.update(); }, 30000);
    setInterval(()=>{if(this.auth.authenticated)return;const button=this.root.querySelector('.login-submit');if(!button)return;const seconds=this.auth.lockSeconds;button.disabled=seconds>0;const label=button.querySelector('span');if(label)label.textContent=seconds?'Try again in '+seconds+'s':this.auth.lockedScreen?'Unlock workspace':'Sign in';},1000);
    this.setupNavDrawer();
    this.start();
    root.addEventListener("focusin",e=>{if(e.target.matches('input,textarea,select'))e.target.dataset.beforeEdit=e.target.value;});
    root.addEventListener("contextmenu",e=>this.onContextMenu(e));
    root.addEventListener("pointerdown",e=>this.startResize(e));
    root.addEventListener("pointerdown",e=>this.startRowDrag(e));
    root.addEventListener("pointerdown",e=>this.startColumnDrag(e));
    // Leaving a cell editor saves it (Esc cancels first); leaving an empty draft row discards it.
    root.addEventListener("focusout",e=>{const a=e.target.dataset?.action;if(a==="cell-input")this.commitCell(e.target,"none");else if(a==="draft-input")this.commitDraft(e.target);});
    document.addEventListener("pointerdown",e=>{const overlay=this.root.querySelector('#overlay-root');if(overlay?.querySelector('.popover,.profile-popover')&&!overlay.contains(e.target)&&!e.target.closest('[data-action]'))this.view.closeOverlay();});
    window.addEventListener("jarc-save",()=>this.saveFeedback());window.addEventListener("jarc-session-expired",()=>{if(this.entra)this.showEntraGate("expired");});window.addEventListener("jarc-access-denied",()=>{if(this.entra)this.showEntraGate("denied");});window.addEventListener("jarc-board-status",()=>this.refreshWhenIdle());window.addEventListener("jarc-ids-changed",()=>this.refreshWhenIdle());window.addEventListener("jarc-rollback",(event)=>this.onRollback(event.detail));window.addEventListener("jarc-connection",()=>this.saveFeedback());window.addEventListener("online",()=>this.saveFeedback());window.addEventListener("offline",()=>this.saveFeedback());
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>this.view.applyDisplay(this.model));
    root.addEventListener("pointerover",e=>{
      const target=e.target.closest('button');if(!target)return;
      const label=target.getAttribute("aria-label")||target.dataset.tooltip||target.title;
      if(!label)return;clearTimeout(this.tooltipTimer);document.querySelector('.ui-tooltip')?.remove();
      this.tooltipTimer=setTimeout(()=>{if(!target.isConnected)return;const r=target.getBoundingClientRect();const tip=document.createElement('div');tip.className='ui-tooltip';tip.textContent=label;tip.setAttribute('role','tooltip');document.body.append(tip);tip.style.left=Math.max(8,Math.min(r.left,innerWidth-tip.offsetWidth-8))+'px';tip.style.top=Math.min(innerHeight-tip.offsetHeight-8,r.bottom+7)+'px';},450);
    });
    root.addEventListener("pointerout",()=>{clearTimeout(this.tooltipTimer);document.querySelector('.ui-tooltip')?.remove();});
    this.overlayObserver=new MutationObserver(()=>this.enhanceOverlay());this.overlayObserver.observe(root,{childList:true,subtree:true});
    const originalClose=this.view.closeOverlay.bind(this.view);this.view.closeOverlay=()=>{originalClose();if(this.pendingRefresh){this.pendingRefresh=false;Promise.resolve().then(()=>this.update());}this.boardMenuWorkspace=null;this.root.querySelector(".app-shell")?.removeAttribute("inert");this.overlayReturnFocus?.focus?.();this.overlayReturnFocus=null;};
    if (window.jarcStorage.getPreference("navCollapsed")==="1") document.body.classList.add("nav-collapsed");
    if (window.jarcStorage.getPreference("workspaceSectionCollapsed")==="1") document.body.classList.add("workspace-section-collapsed");
  }
  // Loads stored data before anything data-dependent renders. Loading screen first; failures show the recovery screen
  // with an in-place Retry (no page reload needed).
  async start() {
    // Until the server confirms a session again, nothing personal is shown (neutral JARC Light while loading).
    this.ready = false; this.view.preAuth = true; this.view.appearanceOwner = null; this.view.applyNeutralAppearance?.(); this.view.renderLoading();
    // Resource mode with Microsoft Entra ID (server AUTH_MODE=entra): a JARC server session (Microsoft sign-in) FIRST; no
    // protected data is requested before that. Other modes keep the temporary sign-in (AuthModel).
    if (this.model.storage.adapter.mode === "resource" && typeof EntraAuth !== "undefined") {
      let signIn;
      try { signIn = await EntraAuth.prepare(this.model.storage.adapter); }
      catch (error) { renderStartupRecovery(this.root, error, () => this.start()); return; }
      if (signIn.mode === "entra") {
        this.entra = signIn.entra;
        if (signIn.state !== "signed-in") { this.showEntraGate(signIn.state); return; }
        this.auth = new EntraSession(signIn.entra, signIn.me);
        // The server confirmed who this is: their own last appearance can show while their data loads (never before).
        this.view.appearanceOwner = this.auth.userId || null; this.view.applyOwnerAppearance?.(this.view.appearanceOwner);
        // From the server (shown in Settings); the server alone decides what is allowed.
        this.model.permissions = { accessPolicy: signIn.me?.accessPolicy, betaOpenEditing: Boolean(signIn.me?.betaOpenEditing), canCreateWorkspaces: Boolean(signIn.me?.canCreateWorkspaces) };
      }
    }
    this.loadStartedAt = new Date().toISOString(); // live updates replay anything saved while loading
    try { await this.model.init(); }
    catch (error) {
      if (this.entra && error?.code === StorageError.CODES.UNAUTHENTICATED) { this.showEntraGate("expired"); return; }
      if (this.entra && error?.code === StorageError.CODES.ACCOUNT_DISABLED) { this.showEntraGate("denied"); return; }
      renderStartupRecovery(this.root, error, () => this.start()); return;
    }
    // The profile shows the Microsoft account's name and email (kept in this browser, per account).
    if (this.entra) {
      const role = this.auth.isSystemAdmin ? "JARC administrator" : this.auth.sharedAccess ? "JARC employee · shared access" : "Microsoft work account";
      if (this.model.profile.name !== this.auth.username || this.model.profile.email !== this.auth.email || this.model.profile.role !== role) this.model.updateProfile({ name: this.auth.username, email: this.auth.email, role });
    }
    if (this.entra && this.auth.userId) this.model.me = `user:${this.auth.userId}`;
    this.root.onclick = null; this.ready = true; this.update(); this.integrations?.afterStart(); this.appearance?.afterStart();
    this.loadPeople(); this.loadFeed(); this.startLive();
    if (!this.feedTimer && this.model.storage.adapter.loadActivityFeed) this.feedTimer = setInterval(() => { if (this.ready && document.visibilityState === "visible") this.loadFeed(); }, 60000);
  }
  // ---- Live updates (resource mode): other people's saved changes appear without a reload --------------------------
  startLive() {
    const adapter = this.model.storage.adapter;
    if (this.live || !adapter.fetchRemote || typeof LiveUpdates === "undefined") return;
    this.remoteQueue = []; this.liveState = "connecting"; this.saveSeq = 0;
    window.addEventListener("jarc-save", (event) => { if (event.detail === "saving") this.saveSeq += 1; }); // any save started
    this.live = new LiveUpdates({
      baseUrl: adapter.http.baseUrl, since: this.loadStartedAt, request: (method, p) => adapter.http.request(method, p, undefined, { background: true }),
      onChanges: (events) => {
        // File changes never alter records: they refresh only the files of the records concerned.
        const comments = events.filter((e) => /^comment\./.test(e.action));
        if (comments.length) this.comments?.onRemote(comments);
        const files = events.filter((e) => /^attachment\./.test(e.action)), rest = events.filter((e) => !/^(attachment|comment)\./.test(e.action));
        if (files.length) this.applyRemoteFiles(files);
        if (rest.length) { this.remoteQueue.push(...rest); this.processRemote(); }
        this.scheduleFeed();
      },
      onResync: () => this.resync(),
      onSessionEnded: () => { this.stopLive(); window.dispatchEvent(new CustomEvent("jarc-session-expired")); },
      onState: (state) => { this.liveState = state; this.saveFeedback(); if (state === "live" && this.needsResync) { this.needsResync = false; this.resync(); } }
    }).start();
    window.addEventListener("pagehide", () => this.stopLive(), { once: true });
  }
  stopLive() { this.live?.stop(); this.live = null; this.liveState = null; clearTimeout(this.remoteTimer); }
  // Reload everything this tab shows (after a gap the server couldn't replay).
  resync() {
    this.model.attachmentBoards.clear(); this.ensureAttachments();
    const events = [{ action: "workspace.updated", workspaceId: null }];
    for (const w of this.model.workspaces) for (const b of w.boards) if (this.model.boardLoadState(b.id).state !== "none") events.push({ action: "board.updated", boardId: b.id, workspaceId: w.id });
    this.remoteQueue.push(...events); this.processRemote(); this.scheduleFeed();
  }
  scheduleFeed() { clearTimeout(this.feedTimerSoon); this.feedTimerSoon = setTimeout(() => this.loadFeed(), Math.max(0, 1500 - (Date.now() - (this.feedAt || 0)))); }
  // Applies queued changes when nothing of this tab's own is being saved: fetch first (network only), then — if a save
  // started meanwhile — fetch again later; otherwise update the cached server copy and the model in one step.
  async processRemote() {
    if (this.remoteBusy || !this.remoteQueue?.length) return;
    const saving = () => this.model.pendingSaves > 0 || this.busy;
    if (saving()) { clearTimeout(this.remoteTimer); this.remoteTimer = setTimeout(() => this.processRemote(), 300); return; }
    this.remoteBusy = true;
    const events = this.remoteQueue.splice(0), adapter = this.model.storage.adapter, seq = this.saveSeq;
    try {
      const plan = await adapter.fetchRemote(events);
      // A save started (and maybe even finished) while fetching: what was fetched may predate it. Fetch again.
      if (saving() || this.saveSeq !== seq) { this.remoteQueue.unshift(...events); return; }
      const { reconcile, summary } = adapter.commitRemote(plan);
      const before = this.remoteSnapshot(summary);
      if (this.model.applyRemote(reconcile)) this.renderRemote(summary, before, events);
    } catch { this.remoteQueue.unshift(...events); this.needsResync = true; } // e.g. offline: retried when live again
    finally {
      this.remoteBusy = false;
      if (this.remoteQueue.length) { clearTimeout(this.remoteTimer); this.remoteTimer = setTimeout(() => this.processRemote(), 300); }
    }
  }
  remoteSnapshot(summary) { const ids = new Set(summary.records.map((r) => String(r.id))); return new Map(this.model.rows.filter((r) => ids.has(String(r.id))).map((r) => [String(r.id), JSON.parse(JSON.stringify(r))])); }
  actorFor(events, recordId) { const e = [...events].reverse().find((x) => !recordId || x.recordId === recordId); const p = e?.actorId ? this.model.people.get(`user:${e.actorId}`) : null; return p ? p.displayName : "A colleague"; }
  // Smallest possible update: changed cells are patched in place (with a brief highlight); added, removed or reordered
  // records re-render just the board area; structure changes re-render the app once nothing is open or being typed.
  renderRemote(summary, before, events) {
    const board = this.model.board, onBoard = this.model.screen === "board" && board;
    if (this.model.undoClearedByRemote) { this.model.undoClearedByRemote = false; }
    if (onBoard && summary.removedBoards.has(String(board.id))) { this.view.toast("This board was deleted by a colleague."); this.model.openScreen("home"); this.update(); return; }
    this.reconcileOpenForm(summary, before, events);
    if (summary.structure || [...summary.boards].some((id) => String(id) !== String(board?.id)) || !onBoard) { this.refreshWhenIdle(); if (!onBoard || summary.structure) return; }
    // The open board's own settings changed (name, views, columns…): redraw the whole screen once nothing is being
    // edited. Record changes keep the in-place cell updates below.
    if (summary.boardConfig?.has(board.id) || summary.boardConfig?.has(String(board.id))) { this.refreshWhenIdle(); return; }
    const here = (r) => String(r.boardId) === String(board.id);
    const filtered = Boolean(this.model.query || this.model.status !== "All" || this.model.columnFilter || this.model.sortKey || this.model.grouped || this.model.quickFilter !== "all" || this.model.showArchived || this.model.currentView !== "table");
    let region = summary.boards.has(board.id) || summary.boards.has(String(board.id)) || summary.removed.some(here) || summary.records.some((r) => here(r) && (r.isNew || r.order));
    for (const r of summary.records.filter(here)) {
      if (r.isNew || r.order) continue;
      for (const field of r.fields) {
        const input = this.root.querySelector(`.cell-input[data-id="${CSS.escape(String(r.id))}"][data-field="${CSS.escape(field)}"]`);
        if (input) { this.markEditorRemote(input, r.id, field, this.actorFor(events, r.id)); continue; }
        if (filtered) { region = true; continue; }
        this.patchCell(r.id, field, false);
        this.flashCell(r.id, field);
      }
    }
    if (region) this.refreshBoardWhenIdle();
  }
  // Re-renders the board area unless the person is typing in it or a dialog is open (then once they finish).
  refreshBoardWhenIdle() {
    const active = document.activeElement, overlay = this.root.querySelector("#overlay-root");
    if (overlay?.children.length || this.tapping || (active && this.root.contains(active) && active.matches('input:not([type="checkbox"]),textarea,select'))) { this.pendingRefresh = true; return; }
    this.refreshBoard();
  }
  // A colleague changed the cell being edited: keep what's typed, show their value; Save then asks which to keep.
  markEditorRemote(input, id, field, actor) {
    const row = this.model.rows.find((r) => String(r.id) === String(id)), column = this.model.board.columns.find((c) => c.key === field);
    if (!row || !column) return;
    input.dataset.remoteValue = String(row[field] ?? ""); input.dataset.remoteBy = actor;
    const td = input.closest("td"); td.classList.add("has-remote-change");
    let note = td.querySelector(".remote-note"); if (!note) { note = document.createElement("span"); note.className = "remote-note"; note.setAttribute("role", "status"); td.append(note); }
    note.textContent = `${actor} changed this to “${this.model.valueText(column, row[field]) || "empty"}”`;
  }
  // The open record form follows colleagues' changes to fields not yet touched here; touched fields are flagged.
  reconcileOpenForm(summary, before, events) {
    const form = this.root.querySelector('form.record-drawer[data-action="record-form"]'); if (!form) return;
    const id = form.querySelector('[name="id"]')?.value; if (!id) return;
    if (summary.removed.some((r) => String(r.id) === String(id))) { this.view.formNotice(form, `<strong>${this.view.escape(this.actorFor(events, id))} deleted this record.</strong> Your changes can't be saved.`, "error"); form.querySelector('button.primary[type="submit"], .modal-actions .primary')?.setAttribute("disabled", ""); return; }
    const change = summary.records.find((r) => String(r.id) === String(id)); if (!change) return;
    const row = this.model.rows.find((r) => String(r.id) === String(id)); if (!row) return;
    const initial = JSON.parse(form.dataset.initial || "{}"), now = this.view.formValues(form), conflicts = [];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const key of change.fields) {
      if (!(key in initial)) continue;
      const theirs = this.model.isMultiColumn(this.model.board.columns.find((c) => c.key === key)) ? this.model.valueList(row[key]) : typeof row[key] === "boolean" ? row[key] : String(row[key] ?? "");
      if (same(now[key], initial[key])) { this.view.setFormValue(form, key, theirs); initial[key] = theirs; }
      else conflicts.push(key);
    }
    form.dataset.initial = JSON.stringify(initial);
    const actor = this.view.escape(this.actorFor(events, id));
    if (conflicts.length) { form.dataset.conflicts = JSON.stringify(conflicts); this.view.formNotice(form, `<strong>${actor} also changed ${conflicts.map((k) => this.view.escape(this.model.board.columns.find((c) => c.key === k)?.label || k)).join(", ")}.</strong> Saving will replace their value with yours.`, "warning"); }
    else this.view.formNotice(form, `<strong>${actor} updated this record.</strong> Fields you haven't changed now show their latest values.`);
  }

  // ---- People columns: the colleagues who can be assigned in the open workspace (server directory, resource mode).
  async loadPeople(force = false) {
    const adapter = this.model.storage.adapter, workspace = this.model.workspace;
    if (!adapter.loadPeople || !workspace) return;
    if (!force && this.peopleKey === workspace.id && Date.now() - (this.peopleAt || 0) < 60000) return;
    this.peopleKey = workspace.id; this.peopleAt = Date.now();
    try { this.model.setPeople(await adapter.loadPeople(workspace.id)); this.refreshWhenIdle(); }
    catch { this.peopleAt = 0; /* names stay as they are; the picker offers Retry by reopening */ }
  }
  // ---- Notifications: the shared activity feed (who changed what, where, when), resource mode.
  async loadFeed() {
    const adapter = this.model.storage.adapter;
    if (!adapter.loadActivityFeed || this.feedLoading) return;
    this.feedLoading = true;
    try {
      this.model.feed = await adapter.loadActivityFeed();
      if (this.root.querySelector(".notification-drawer")) { this.view.showNotifications(this.model, this.feedFilter || "all"); this.markPanel("notifications"); }
      const badge = this.root.querySelector(".notification-button"); if (badge) { const n = this.model.unreadCount; badge.querySelector("b")?.remove(); if (n) badge.insertAdjacentHTML("beforeend", `<b>${n}</b>`); }
    } catch { /* keep the last feed; the drawer still opens */ }
    finally { this.feedLoading = false; }
  }
  update() {
    this.pendingRefresh = false;
    this.view.commentsEnabled = Boolean(this.comments?.available);
    if (this.view.commentsEnabled && this.model.screen === "board" && this.model.board && this.countsBoardId !== this.model.board.id) { this.countsBoardId = this.model.board.id; this.model.commentCounts = {}; this.comments.loadCounts(this.model.board.id); }
    // The open view was deleted (here or by a colleague): back to Main Table.
    if (this.model.screen === "board" && this.model.board && this.model.activeSavedViewId !== null && this.model.activeSavedViewId !== undefined && !this.model.activeView) this.model.openMainTable();
    if (this.entra && (this.entraGate || !this.auth.authenticated)) { this.navOpen = false; this.applyNav(); this.view.renderEntraGate(this.entraGate || "signed-out", this.model); return; }
    if (!this.auth.authenticated) this.navOpen = false; // sign-in screens have no drawer
    const focus = this.focusedControl(), scroll = this.scrollState();
    this.auth.authenticated ? this.view.render(this.model) : this.view.renderLogin(this.auth,this.model); this.applyNav(); this.saveFeedback();
    // A different screen or board starts at the top; re-renders of the same one keep their scroll position.
    const place = `${this.model.screen}:${this.model.screen === "board" ? this.model.board?.id : ""}`;
    this.refocus(focus); if (place === this.lastPlace) this.restoreScroll(scroll); else if (this.lastPlace !== undefined) window.scrollTo(0, 0);
    this.lastPlace = place;
    if (this.ready && this.model.workspace && this.model.workspace.id !== this.peopleKey) this.loadPeople();
    this.ensureAttachments(); this.trackRows(); this.reapplyFlashes();
  }
  // Microsoft sign-in screens: "signed-out" | "expired" | "denied" | "error". Shown instead of the app.
  showEntraGate(state, options = {}) { this.entraGate = state; this.navOpen = false; this.applyNav(); this.view.renderEntraGate(state, this.model, options); }
  entraSignIn() {
    this.view.renderEntraGate(this.entraGate || "signed-out", this.model, { busy: true });
    this.entra.signIn().catch(() => this.showEntraGate("error", { message: "Microsoft sign-in couldn't start. Check your connection, then try again." }));
  }
  // Resource mode: re-render after records load or server IDs replace temporary ones, but never under an open
  // dialog (it re-renders when the dialog closes) or while a field is being edited (the next update shows it; old
  // temporary IDs on the page still resolve through the model, so nothing breaks in the meantime).
  refreshWhenIdle() {
    if (!this.ready || !this.auth.authenticated) return;
    const active = document.activeElement, overlay = this.root.querySelector("#overlay-root");
    if (this.navOpen || this.tapping || overlay?.children.length || (active && this.root.contains(active) && active.matches('input:not([type="checkbox"]),textarea,select'))) { this.pendingRefresh = true; return; }
    this.update();
  }
  togglePanel(name, opener) { const root=document.querySelector("#overlay-root"); if(root?.dataset.open===name){this.view.closeOverlay();return false;} opener(); const next=document.querySelector("#overlay-root"); if(next)next.dataset.open=name; return true; }
  markPanel(name) { const root=document.querySelector("#overlay-root"); if(root)root.dataset.open=name; }

  // ---- Navigation drawer (tablets and phones, ≤1024 px): the menu button opens and closes it (it stays above the
  // drawer and shows ✕ while open); a tap anywhere outside, Escape, choosing anything in it, or any dialog opening
  // also closes it. The state lives here, not
  // in the DOM, so re-renders keep it; the page behind doesn't scroll while it is open.
  static DRAWER_QUERY = "(max-width: 1024px)";
  setupNavDrawer() {
    this.navOpen = false; this.tapping = false;
    this.drawerMedia = window.matchMedia ? window.matchMedia(AppController.DRAWER_QUERY) : null;
    this.drawerMedia?.addEventListener?.("change", () => { if (!this.drawerMedia.matches) this.setNav(false, { restoreFocus: false }); });
    let release = null;
    const endTap = (delay) => { clearTimeout(release); release = setTimeout(() => { this.tapping = false; this.flushRefresh(); }, delay); };
    document.addEventListener("pointerdown", () => { clearTimeout(release); this.tapping = true; }, true);
    document.addEventListener("pointerup", () => endTap(400), true);       // fallback when no click follows (scroll)
    document.addEventListener("pointercancel", () => endTap(0), true);
    document.addEventListener("click", () => endTap(0));                   // after the app has handled the tap
    // A tap anywhere outside the drawer closes it (the backdrop, or a quiet part of the top bar).
    this.root.addEventListener("click", (event) => { if (this.navOpen && !event.target.closest('#sidebar,[data-action="toggle-nav"]')) this.setNav(false); });
  }
  setNav(open, { restoreFocus = true } = {}) {
    open = Boolean(open) && Boolean(this.drawerMedia ? this.drawerMedia.matches : true);
    const changed = open !== this.navOpen;
    this.navOpen = open; this.applyNav();
    if (!changed) return;
    if (open) this.root.querySelector("#sidebar nav button")?.focus({ preventScroll: true });
    else {
      const toggle = this.root.querySelector('[data-action="toggle-nav"]'), active = document.activeElement;
      if (restoreFocus && (!active || active === document.body || this.root.querySelector("#sidebar")?.contains(active) || active.matches?.(".nav-backdrop"))) toggle?.focus({ preventScroll: true });
      this.flushRefresh();
    }
  }
  applyNav() {
    const open = Boolean(this.navOpen);
    this.root.querySelector("#sidebar")?.classList.toggle("open", open);
    document.documentElement.classList.toggle("nav-drawer-open", open);
    const toggle = this.root.querySelector('[data-action="toggle-nav"]');
    if (toggle) { toggle.setAttribute("aria-expanded", String(open)); toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation"); }
  }
  // Scroll positions (page and the records table) survive a re-render.
  scrollState() { const wrap = this.root.querySelector(".table-wrap"); return { x: window.scrollX, y: window.scrollY, left: wrap?.scrollLeft || 0, top: wrap?.scrollTop || 0 }; }
  restoreScroll(s) { if (!s) return; const wrap = this.root.querySelector(".table-wrap"); if (wrap) { wrap.scrollLeft = s.left; wrap.scrollTop = s.top; } if (window.scrollX !== s.x || window.scrollY !== s.y) window.scrollTo(s.x, s.y); }
  // The focused button, described so the same control can be focused again after a re-render.
  focusedControl() {
    const active = document.activeElement;
    if (!active || !this.root.contains(active) || !active.dataset?.action || active.matches("input,textarea,select")) return null;
    return ["action", "id", "screen", "board", "workspace"].map((k) => active.dataset[k] === undefined ? "" : `[data-${k}="${CSS.escape(active.dataset[k])}"]`).join("");
  }
  refocus(selector) {
    if (!selector || (document.activeElement && document.activeElement !== document.body)) return;
    this.root.querySelector(selector)?.focus({ preventScroll: true });
  }
  flushRefresh() { if (this.pendingRefresh && !this.navOpen && !this.tapping) { this.pendingRefresh = false; this.refreshWhenIdle(); } }

  // With no workspaces (a new shared database) the full layout is shown, but most actions need a workspace. These work
  // without one; anything else opens "Create workspace" instead of acting on a workspace that doesn't exist.
  static READ_ONLY_BLOCKED = new Set(["add-column","add-group-column","add-group-form","cell-open","set-cell-option","inline-add","open-form","new-item","import","choose-import-file","duplicate-record","duplicate-column","delete","archive-item","pin-item","rename-column","edit-column-options","column-editor","edit-description","manage-groups","request-delete-column","request-delete-group","move-record-board","move-column","edit","files-input","request-remove-file","board-title-inline"]);
  static NO_WORKSPACE_ACTIONS = new Set(["create-workspace","close-overlay","nav","toggle-nav","collapse-nav","toggle-workspace-section","command-palette","run-command","retry-save","dismiss-hint","notifications","notification-filter","mark-notifications","profile-menu","profile-settings","choose-avatar","remove-avatar","set-presence","settings","settings-section","setting","theme","shortcuts","request-logout","confirm-logout","lock-session"]);
  static NO_WORKSPACE_COMMANDS = new Set(["home","mywork","theme","settings","notifications","shortcuts"]);
  needsWorkspace(allowed) {
    if (this.model.workspaces.length || allowed) return false;
    this.view.closeOverlay(); this.view.showWorkspaceForm(); return true;
  }

  onClick(event) {
    const target = event.target.closest("[data-action]"); if (!target) return;
    const action = target.dataset.action;
    if (action === "entra-sign-in" && this.entra) { this.entraSignIn(); return; }
    if (action === "entra-sign-out" && this.entra) { this.view.renderEntraGate(this.entraGate || "signed-out", this.model, { busy: true, signingOut: true }); this.entra.signOut(); return; }
    if (window.jarcStorage?.connection === "offline" && ["cell-open","set-cell-option","inline-add","open-form","new-item","new-board","add-column","create-workspace","import"].includes(action)) { this.view.toast(StorageError.describe(StorageError.CODES.OFFLINE).message); return; }
    if (action.startsWith("integration-") && this.integrations) { if (target.tagName !== "SELECT") this.integrations.onAction(action, target); return; }
    if ((action.startsWith("appearance-") || (["icon-picker", "icon-tab", "icon-choose"].includes(action))) && this.appearance) { if (target.tagName !== "INPUT") this.appearance.onAction(action, target); return; }
    if ((action.startsWith("group-") || action.startsWith("toolbar-")) && this.groupActions) { this.lastTrigger = target; this.groupActions.onAction(action, target); return; }
    if (action.startsWith("comment-") && this.comments && action !== "comment-input") { this.comments.onAction(action, target); return; }
    if (action === "drawer-tab") { this.view.selectDrawerTab(target.dataset.tab); if (target.dataset.tab === "updates") document.querySelector('#overlay-root textarea[data-role="new"]')?.focus(); return; }
    if (action === "open-updates") { const row = this.model.rows.find((r) => String(r.id) === String(this.model.idOf(target.dataset.id))); if (row) this.view.showRecordForm(this.model, row, { tab: "updates" }); return; }
    // Boards synchronized from monday.com are read-only (the server refuses changes too; this avoids starting them).
    if (this.model.screen === "board" && this.model.board?.source?.readOnly && AppController.READ_ONLY_BLOCKED.has(action)) { this.view.toast("This board is synced from monday.com and is read-only"); return; }
    if(action==="login-theme-choice"){this.model.updateSetting("theme",target.dataset.theme);this.view.applyDisplay(this.model);this.root.querySelectorAll('[data-action="login-theme-choice"]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.theme===target.dataset.theme)));return;}
    this.lastTrigger=target;
    if(action==="toggle-nav"){this.setNav(!this.navOpen);return;}
    // Choosing anything in the drawer (a screen, board, workspace, settings…) closes it first.
    if(this.navOpen&&target.closest("#sidebar")&&action!=="toggle-workspace-section")this.setNav(false,{restoreFocus:false});
    if(this.needsWorkspace(AppController.NO_WORKSPACE_ACTIONS.has(action)))return;
    if(action==="retry-save"){this.retrySave();return;}
    if(action==="retry-board-load"){this.model.ensureBoardRecords(this.model.board?.id);this.update();return;}
    if(action==="load-more-records"){this.model.ensureBoardRecords(this.model.board?.id,{more:true});return;}
    if(action==="dismiss-hint"){this.model.updateSetting("dismissedHint",true);this.update();return;}
    if(action==="toggle-home-archived"){this.model.updateSetting("homeArchived",!this.model.settings.homeArchived);this.update();return;}
    if(action==="home-create-record"||action==="home-import"){this.chooseBoardAction(action==="home-import"?"import":"record");return;}
    if(action==="choose-board-action"){this.model.openBoard(target.dataset.id,target.dataset.workspace);this.update();target.dataset.mode==="import"?this.view.showImport(this.model):this.view.showRecordForm(this.model);return;}
    if(action==="favorite-board"){this.view.closeOverlay();this.model.toggleFavorite(target.dataset.id);this.update();return;}
    if(action==="remove-filter"){this.model[target.dataset.key]=target.dataset.key==="status"?"All":target.dataset.key==="quickFilter"?"all":"";this.update();return;}
    if(action==="archive-workspace"){this.model.archiveWorkspace(target.dataset.id,target.dataset.archived==="1");this.update();this.view.showSettings(this.model,"workspace");return;}
    if(action==="restore-backup"){const backup=this.pendingBackup;this.runBusy(target,()=>{this.model.restoreBackup(backup);},()=>{this.pendingBackup=null;this.update();this.view.toast("Backup restored",true);});return;}
    if(action==="move-record-board"){this.view.overlay(`<div class="modal small-modal"><div class="modal-head"><h2>Move record to…</h2>${this.view.closeButton()}</div><p>Existing field values and missing columns will be preserved.</p><div class="choice-list">${this.model.workspaces.filter(w=>!w.archived).flatMap(w=>w.boards.filter(b=>!b.archived&&b.id!==this.model.board.id).map(b=>`<button data-action="confirm-move-record" data-id="${this.view.attr(target.dataset.id)}" data-board="${this.view.attr(b.id)}">${this.view.escape(w.name)} / ${this.view.escape(b.name)}</button>`)).join("")||"<p>Create another board first.</p>"}</div></div>`);return;}
    if(action==="confirm-move-record"){this.model.moveRecordToBoard(target.dataset.id,target.dataset.board);this.update();this.view.toast("Record moved");return;}
    if(action==="adjacent-record"){const list=this.model.visibleRows;const index=list.findIndex(r=>r.id===this.model.idOf(target.dataset.id));const row=list[(index+Number(target.dataset.direction)+list.length)%list.length];if(row)this.view.showRecordForm(this.model,row);return;}
    if(["rename-board","duplicate-board","delete-board","archive-board","move-board","favorite-board","open-board"].includes(action)&&this.boardMenuWorkspace){this.model.currentWorkspaceId=this.boardMenuWorkspace;this.boardMenuWorkspace=null;}
    if (action === "toggle-password") { const input=document.querySelector('[name="password"]'); const showing=input.type === "text"; input.type=showing?"password":"text"; target.textContent=showing?"Show":"Hide"; target.setAttribute("aria-label",showing?"Show password":"Hide password"); target.setAttribute("aria-pressed",String(!showing));input.focus(); }
    if (action === "nav") { this.model.openScreen(target.dataset.screen); this.update(); }
    if (action === "open-board") { this.view.closeOverlay();this.model.openBoard(target.dataset.id); this.update(); }
    if (action === "open-record-board") { this.model.openBoard(target.dataset.board,target.dataset.workspace); this.update(); }
    if (action === "collapse-nav") { document.body.classList.toggle("nav-collapsed"); window.jarcStorage.setPreference("navCollapsed",document.body.classList.contains("nav-collapsed")?"1":"0"); }
    if (action === "toggle-workspace-section") { document.body.classList.toggle("workspace-section-collapsed"); const collapsed=document.body.classList.contains("workspace-section-collapsed"); window.jarcStorage.setPreference("workspaceSectionCollapsed",collapsed?"1":"0"); if(!collapsed)this.view.play(this.root.querySelector(".sidebar .nav-tree"),"section-reveal"); }
    if (action === "workspace-menu") this.togglePanel("workspace",()=>this.view.showWorkspaceMenu(this.model));
    if (action === "create-workspace") this.view.showWorkspaceForm();
    if (action === "record-menu") this.togglePanel(`record-${target.dataset.id}`,()=>this.view.showRecordMenu(this.model.rows.find((row)=>row.id===this.model.idOf(target.dataset.id))));
    if (action === "switch-workspace") { this.model.switchWorkspace(target.dataset.id); this.view.closeOverlay(); this.update(); }
    if(action==="board-menu"){this.boardMenuWorkspace=target.dataset.workspace||this.model.currentWorkspaceId;const ws=this.model.workspaces.find(w=>w.id===this.boardMenuWorkspace);this.togglePanel(`board-${target.dataset.id}`,()=>this.view.showBoardMenu(ws.boards.find(b=>b.id===target.dataset.id),{current:target.dataset.current==="1",archivedCount:this.model.archivedCount}));}
    if (action === "new-board") this.view.showBoardForm(null);
    if (action === "rename-board") this.view.showBoardForm(this.model.workspace.boards.find((board) => board.id === target.dataset.id));
    if (action === "duplicate-board") { this.model.duplicateBoard(target.dataset.id); this.view.closeOverlay(); this.update(); this.view.toast("Board duplicated"); }
    if (action === "delete-board") { const board=this.model.workspaces.flatMap((w)=>w.boards).find((x)=>String(x.id)===String(target.dataset.id)), files=board?.columns?.some((c)=>c.type==="files"); this.view.showConfirm("Delete board?",files?"The board and its records will be removed, and files in its Files columns are deleted permanently. Undo can restore the board but not the files.":"The board and its records will be removed. You can still use Undo afterward.","confirm-delete-board",target.dataset.id); }
    if (action === "confirm-delete-board") this.deleteBoard(target.dataset.payload,target);
    if (action === "archived-view") { this.view.closeOverlay(); this.model.resetMainView(); this.model.currentView="table"; this.model.showArchived=true; this.model.selected.clear(); this.update(); }
    // ---- Views (Phase 5)
    if (action === "main-table") { this.view.closeOverlay(); this.model.openMainTable(); this.update(); return; }
    if (action === "open-view") { this.view.closeOverlay(); this.model.applyView(target.dataset.id); this.update(); return; }
    if (action === "views-menu") { this.togglePanel("views-menu",()=>this.view.showViewsMenu(this.model)); return; }
    if (action === "new-view") { this.view.showNewView(this.model,target.dataset.type); return; }
    if (action === "view-menu") { this.togglePanel(`view-${target.dataset.id}`,()=>this.view.showViewMenu(this.model,target.dataset.id)); return; }
    if (action === "duplicate-view") { this.view.closeOverlay(); const copy=target.dataset.id?this.model.duplicateView(target.dataset.id):this.model.createView(this.model.uniqueViewName("Main Table copy"),"table"); if(copy){this.update();this.view.toast(`View "${copy.name}" created`);} return; }
    if (action === "column-picker") { this.togglePanel("column-picker",()=>this.view.showColumnPicker(this.model)); return; }
    if (action === "rename-view") { this.view.showRenameView(this.model,target.dataset.id); return; }
    if (action === "request-delete-view") { const v=this.model.board.savedViews.find((x)=>String(x.id)===String(target.dataset.id)); if(v)this.view.showConfirm(`Delete the "${v.name}" view?`,"The view is removed for everyone on this board. Its records are not affected.","confirm-delete-view",String(v.id),"Delete view"); return; }
    if (action === "confirm-delete-view") { this.model.deleteView(target.dataset.payload); this.view.closeOverlay(); this.update(); this.view.toast("View deleted"); return; }
    if (action === "save-active-view") { if(this.model.saveActiveView()){this.view.closeOverlay();this.update();this.view.toast("View saved");} return; }
    if (["open-form","new-item"].includes(action)) this.view.showRecordForm(this.model);
    if (action === "edit") this.view.showRecordForm(this.model,this.model.rows.find((row)=>row.id===this.model.idOf(target.dataset.id)));
    if (action === "duplicate-record") { const id=this.model.duplicateRecord(target.dataset.id); this.update(); if(id)this.focusItem(id); this.view.toast("Item duplicated"); }
    if (action === "pin-item") { this.model.togglePin(target.dataset.id); this.update(); this.view.toast("Pin updated"); }
    if (action === "archive-item") { const row=this.model.rows.find((item)=>item.id===this.model.idOf(target.dataset.id)); const archive=!row.archived; this.model.archiveItem(target.dataset.id,archive); this.update(); this.view.toast(archive?"Record archived":"Record restored",true); }
    if (action === "delete") this.requestDeleteRecords([this.model.idOf(target.dataset.id)]);
    if (action === "delete-selected") { const ids=[...this.model.selected]; if(ids.length>=10){this.pendingBulkDelete=ids;this.deleteFileInfo(ids).then(({files,unknown})=>this.view.showBulkDeleteConfirm(ids.length,files||(unknown?-1:0)));} else this.requestDeleteRecords(ids); return; }
    // ---- Phase 6 bulk actions (Shift-click selects a range).
    if (action === "select") { const id=this.model.idOf(target.dataset.id); if(event.shiftKey&&this.lastSelected!==undefined&&this.lastSelected!==null&&this.model.visibleRows.some((r)=>r.id===this.lastSelected))this.model.selectRange(this.lastSelected,id,target.checked); else if(target.checked)this.model.selected.add(id); else this.model.selected.delete(id); this.lastSelected=id; this.update(); return; }
    if (action === "bulk-archive" || action === "bulk-restore") { const n=this.model.bulkArchive([...this.model.selected],action==="bulk-archive"); this.update(); if(n)this.view.toast(`${n} record${n===1?"":"s"} ${action==="bulk-archive"?"archived · restore them from Archived records":"restored"}`,true); return; }
    if (action === "bulk-duplicate") { const ids=this.model.bulkDuplicate([...this.model.selected]); this.update(); if(ids.length)this.view.toast(`${ids.length} record${ids.length===1?"":"s"} duplicated (files are not copied)`,true); return; }
    if (action === "bulk-export") { this.exportCsv(this.model.visibleRows.filter((r)=>this.model.selected.has(r.id))); return; }
    if (action === "bulk-move") { this.togglePanel("bulk-move",()=>this.view.showMoveTargets(this.model)); return; }
    if (action === "apply-bulk-move") { const board=this.model.workspaces.flatMap((w)=>w.boards).find((b)=>String(b.id)===target.dataset.board); const n=this.model.bulkMove([...this.model.selected],target.dataset.board); this.view.closeOverlay(); this.update(); if(n)this.view.toast(`${n} record${n===1?"":"s"} moved to ${board?.name||"the board"}`,true); return; }
    if (action === "confirm-paste") { this.view.closeOverlay(); this.applyPaste(); return; }
    if (action === "drawer-files") { this.view.closeOverlay(); this.lastTrigger=this.cellButton(target.dataset.id,target.dataset.field)||this.lastTrigger; this.openFiles(target.dataset.id,target.dataset.field); return; }
    if (action === "confirm-delete-records") this.deleteRecords(target.dataset.payload.split(",").map((id)=>this.model.idOf(id)),target);
    if (action === "clear-selection") { this.model.selected.clear(); this.update(); }
    if(action==="sort")this.view.showSort(this.model);
    if (action === "group") { if(!this.model.groupColumn){this.togglePanel("group-help",()=>this.view.showGroupHelp());return;} this.model.grouped = !this.model.grouped; this.update(); }
    if (action === "clear-filters") { this.model.resetMainView(); this.update(); }
    if (action === "toggle-favorite") { this.model.toggleFavorite(this.model.currentBoardId); this.update(); this.view.toast(this.model.board.favorite?"Board added to favorites":"Board removed from favorites"); }
    if (action === "edit-description") this.view.showDescription(this.model);
    if (action === "undo") { const label=this.model.undo(); this.update(); this.view.toast(label); }
    if (action === "manage-groups") this.view.showGroupManager(this.model);
    if (action === "save-group") { const input=target.closest(".manager-row").querySelector('[data-role="group-name"]'); if (input.value !== target.dataset.old) { this.model.renameGroup(target.dataset.old,input.value); this.view.showGroupManager(this.model); } }
    if (action === "request-delete-group") { const fallback=this.model.board.groups.find((group)=>group!==target.dataset.group); this.view.showConfirm("Delete group?",`Items in ${target.dataset.group} will move to ${fallback}.`,"confirm-delete-group",target.dataset.group); }
    if (action === "confirm-delete-group") { const name=target.dataset.payload, fallback=this.model.board.groups.find((group)=>group!==name); this.runBusy(target,()=>this.model.deleteGroup(name,fallback),()=>{this.view.closeOverlay();this.update();this.view.toast("Group deleted");}); }
    if (action === "manage-columns") this.togglePanel("columns",()=>this.view.showColumnManager(this.model));
    if (action === "add-column") this.view.showAddColumn(this.model);
    if (action === "column-editor") this.togglePanel(`column-${target.dataset.key}`,()=>this.view.showColumnEditor(this.model,target.dataset.key));
    if (action === "move-column") { const moved=this.model.moveColumn(target.dataset.key,target.dataset.direction); this.view.showColumnEditor(this.model,target.dataset.key); this.markPanel(`column-${target.dataset.key}`); this.view.toast(moved?"Column moved":"The primary record column stays first"); }
    if (action === "preview-file") { const row=this.model.rows.find((r)=>r.id===this.model.idOf(target.dataset.id)), column=this.model.board.columns.find((c)=>c.key===target.dataset.field), file=this.model.attachments.get(target.dataset.file); if(row&&column&&file){this.view.showFilePreview(this.model,row,column,file);this.markPanel(`preview-${file.id}`);this.watchPreview();} return; }
    if (action === "download-file") { this.view.toast(`Downloading ${target.dataset.name||"file"}…`); return; } // the browser takes over (no preventDefault)
    if (action === "retry-attachments") { const id=String(this.model.serverId(this.model.board?.id)); this.model.attachmentErrors.delete(id); this.model.attachmentBoards.delete(id); this.ensureAttachments(); this.refreshFilesCells(); return; }
    if (action === "back-to-files") { this.view.closeOverlay(); this.openFiles(target.dataset.id,target.dataset.field); return; }
    if (action === "request-remove-file") { this.filesConfirm={cell:this.filesCellKey(target.dataset.id,target.dataset.field),id:target.dataset.file}; this.refreshFiles(target.dataset.id,target.dataset.field); return; }
    if (action === "cancel-remove-file") { this.filesConfirm=null; this.refreshFiles(target.dataset.id,target.dataset.field); return; }
    if (action === "confirm-remove-file") { target.disabled=true; this.removeFile(target.dataset.id,target.dataset.field,target.dataset.file); return; }
    if (action === "retry-upload" || action === "dismiss-upload") { const cell=this.filesCellKey(target.dataset.id,target.dataset.field), u=(this.uploads.get(cell)||[]).find((x)=>x.id===target.dataset.upload); if(u){ if(action==="retry-upload")this.startUpload(target.dataset.id,target.dataset.field,u); else this.uploads.set(cell,this.uploads.get(cell).filter((x)=>x!==u)); this.refreshFiles(target.dataset.id,target.dataset.field); } return; }
    if (action === "column-info") { this.togglePanel(`info-${target.dataset.key}`,()=>this.view.showColumnInfo(this.model,target.dataset.key)); return; }
    if (action === "column-width") { const column=this.model.board.columns.find((c)=>c.key===target.dataset.key); if(column)this.view.overlay(`<form class="modal small-modal" data-action="column-width-form"><div class="modal-head"><div><div class="eyebrow">${this.view.escape(column.label)}</div><h2>Column width</h2></div>${this.view.closeButton()}</div><input type="hidden" name="key" value="${this.view.attr(column.key)}"><label>Width in pixels<input name="width" type="number" min="100" max="600" step="10" required value="${Math.round(this.view.colWidth(column))}"></label><p class="field-note">Between 100 and 600. You can also drag the edge of the column header.</p><div class="modal-actions"><button type="button" class="button secondary" data-action="close-overlay">Cancel</button><button class="button primary">Save width</button></div></form>`); return; }
    if (action === "toggle-column-multiple") {
      const column=this.model.board.columns.find((c)=>c.key===target.dataset.key); if(!column)return;
      const crowded=column.multiple?this.model.rows.filter((r)=>this.model.valueList(r[column.key]).length>1).length:0;
      if(crowded){this.view.showConfirm(`Allow one value in ${column.label}?`,`${crowded} record${crowded===1?" has":"s have"} several values. Each will keep only its first value.`,"confirm-column-single",column.key,"Keep first values");return;}
      this.runBusy(target,()=>this.model.setColumnMultiple(column.key,!column.multiple)?undefined:false,()=>{this.view.closeOverlay();this.update();this.view.toast(column.multiple?`${column.label} allows several values`:`${column.label} allows one value`);});
      return;
    }
    if (action === "confirm-column-single") { const key=target.dataset.payload; this.runBusy(target,()=>this.model.setColumnMultiple(key,false)?undefined:false,()=>{this.view.closeOverlay();this.update();this.view.toast("Each record kept its first value");}); return; }
    if (action === "move-option-row") { const row=target.closest(".option-row"), sibling=target.dataset.direction==="up"?row.previousElementSibling:row.nextElementSibling; if(sibling){ if(target.dataset.direction==="up")sibling.before(row); else sibling.after(row); target.focus(); } return; }
    if (action === "duplicate-column") { const copy=this.model.duplicateColumn(target.dataset.key); this.view.closeOverlay(); this.update(); if(copy)this.view.toast("Column duplicated"); }
    if (action === "request-delete-column") {
      // Empty columns delete straight away (with Undo); columns holding data ask first and say how much.
      const column=this.model.board.columns.find((item)=>item.key===target.dataset.key); if(!column||column.key==="serial")return;
      const used=this.model.columnUsage(column.key), files=column.type==="files"?this.model.boardFileCount(this.model.board,{columnKey:column.key}):0;
      // Files are deleted on the server for good: always ask, and say so (Undo can't restore them).
      if(files){this.view.showConfirm(`Delete "${column.label}"?`,`This column holds ${files} file${files===1?"":"s"}. Deleting it permanently deletes ${files===1?"it":"them"} for everyone — Undo can't bring files back.`,"confirm-delete-column",column.key,"Delete column and files");return;}
      if(!used){this.runBusy(target,()=>this.model.deleteColumn(column.key),()=>{this.view.closeOverlay();this.update();this.view.toast(`${column.label} column deleted`,true);});}
      else this.view.showConfirm(`Delete "${column.label}"?`,`This column contains data in ${used} record${used===1?"":"s"}. Deleting it will remove those values.`,"confirm-delete-column",column.key,"Delete column");
    }
    if (action === "confirm-delete-column") { const key=target.dataset.payload; this.runBusy(target,()=>this.model.deleteColumn(key),()=>{this.view.closeOverlay();this.update();this.view.toast("Column deleted",true);}); }
    // ---- Table interaction (Stage 4)
    if (action === "cell-open") { this.openCell(target); return; }
    if (action === "conflict-keep-mine") { const c=this.conflict; this.conflict=null; this.conflictState=false; this.view.closeOverlay(); if(c){this.model.updateCell(c.id,c.field,c.mine);this.patchCell(c.id,c.field,true);this.view.toast("Your value was saved");} this.saveFeedback(); return; }
    if (action === "close-overlay" && this.conflict) { this.conflict=null; this.conflictState=false; this.saveFeedback(); }
    if (action === "toggle-cell-option") {
      const id=this.model.idOf(target.dataset.id), field=target.dataset.field, row=this.model.rows.find((r)=>r.id===id), column=this.model.board.columns.find((c)=>c.key===field); if(!row||!column)return;
      const list=this.model.valueList(row[field]), value=target.dataset.value, next=list.includes(value)?list.filter((v)=>v!==value):[...list,value];
      const query=this.root.querySelector('[data-action="cell-option-search"]')?.value||"";
      this.model.updateCell(id,field,next); this.patchCell(id,field,false);
      this.view.showCellOptions(this.model,this.model.rows.find((r)=>r.id===id),column,{query}); this.markPanel(`cell-${id}-${field}`);
      const reopened=this.root.querySelector(".cell-options-popover"); if(reopened)reopened.style.animation="none"; // same picker, updated: no pop-in
      this.root.querySelector(`.cell-option[data-value="${CSS.escape(value)}"]`)?.focus({preventScroll:true});
      return;
    }
    if (action === "set-cell-option") { const id=this.model.idOf(target.dataset.id), field=target.dataset.field, column=this.model.board.columns.find((c)=>c.key===field); this.model.updateCell(id,field,target.dataset.value); this.view.closeOverlay(); if(column?.type==="group"&&this.model.grouped)this.refreshBoard(); else this.patchCell(id,field,true); return; }
    if (action === "inline-add") { this.startInlineAdd(target); return; }
    if (action === "sort-column") { this.applySort(target.dataset.key,target.dataset.direction); return; }
    if (action === "clear-sort") { this.applySort("","desc"); return; }
    if (action === "filter-column") { this.view.showColumnFilter(this.model,target.dataset.key); return; }
    if (action === "clear-column-filter") { this.model.columnFilter=null; this.view.closeOverlay(); this.update(); return; }
    if (action === "move-column-menu") { const moved=this.model.moveColumn(target.dataset.key,target.dataset.direction); this.view.closeOverlay(); this.update(); if(moved){this.view.toast("Column moved",true);this.root.querySelector(`[data-action="column-menu"][data-key="${CSS.escape(target.dataset.key)}"]`)?.focus();} return; }
    if (action === "show-column" || action === "show-all-columns") { const keys=action==="show-column"?[target.dataset.key]:this.model.board.columns.filter((c)=>!this.model.columnShown(c)).map((c)=>c.key); if(this.model.activeView)keys.forEach((key)=>this.model.setColumnVisible(key,true)); else this.model.updateColumnConfig(Object.fromEntries(keys.map((key)=>[key,{visible:true}]))); this.update(); this.view.showColumnManager(this.model); this.markPanel("columns"); this.view.toast(keys.length===1?"Column shown":`${keys.length} columns shown`,true); return; }
    if (action === "column-menu") this.togglePanel(`column-menu-${target.dataset.key}`,()=>this.view.showColumnMenu(this.model,target.dataset.key));
    if (action === "choose-column-type") { this.view.showColumnNameStep(this.model,target.dataset.type); this.selectOverlayInput('[name="label"]'); }
    if (action === "rename-column") { this.view.showRenameColumn(this.model,target.dataset.key); this.selectOverlayInput('[name="label"]'); }
    if (action === "change-column-type") this.view.showColumnChooser(this.model,{mode:"change",key:target.dataset.key});
    if (action === "choose-new-type") this.changeColumnType(target.dataset.key,target.dataset.type,false,target);
    if (action === "confirm-change-type") { const [key,type]=target.dataset.payload.split("|"); this.changeColumnType(key,type,true,target); }
    if (action === "edit-column-options") this.view.showOptionEditor(this.model,target.dataset.key);
    if (action === "add-option-row") { const list=target.closest("form").querySelector(".option-list"); list.insertAdjacentHTML("beforeend",this.view.optionRow()); list.lastElementChild.querySelector("input").focus(); }
    if (action === "remove-option-row") { const row=target.closest(".option-row"), next=row.nextElementSibling||row.previousElementSibling; row.remove(); (next?.querySelector("input")||this.root.querySelector('[data-action="add-option-row"]'))?.focus(); }
    if (action === "confirm-column-options") this.applyColumnOptions(true,target);
    if (action === "hide-column") { const column=this.model.board.columns.find((item)=>item.key===target.dataset.key); if(column&&this.model.setColumnVisible(column.key,false)){this.view.closeOverlay();this.update();this.view.toast(`${column.label} hidden · show it again from Columns`,true);} }
    if (action === "add-group-column") { const column=this.model.addColumn({label:this.model.uniqueColumnLabel("Group"),type:"group"}); if(column){this.model.grouped=true;this.view.closeOverlay();this.update();this.view.toast("Group column added",true);} }
    if (action === "saved-views") this.togglePanel("views",()=>this.view.showSavedViews(this.model));
    if (action === "set-view") { this.model.setView(target.dataset.view); this.model.showArchived=false; this.update(); }
    if (action === "density-menu") this.togglePanel("density",()=>this.view.showDensityMenu(this.model));
    if (action === "set-density") { this.model.updateSetting("density",target.dataset.value); this.view.closeOverlay(); this.update(); }
    if (action === "view-overflow") this.togglePanel("view-overflow",()=>this.view.showViewOverflow(this.model));
    if (action === "apply-saved-view") { this.model.applyView(target.dataset.id); this.view.closeOverlay(); this.update(); }
    if (action === "delete-saved-view") { this.model.deleteView(target.dataset.id); this.view.showSavedViews(this.model); }
    if (action === "bulk-status") this.view.showQuickChoice("Set selected status",this.model.statusColumn.options.length?this.model.statusColumn.options:["Review","Defective","Clear"],"apply-bulk-status","");
    if (action === "apply-bulk-status") { this.model.bulkUpdate([...this.model.selected],this.model.statusColumn.key,target.dataset.value); this.model.selected.clear(); this.view.closeOverlay(); this.update(); this.view.toast("Selected records updated"); }
    if (action === "bulk-owner") this.view.showQuickChoice("Assign selected records",[...new Set([this.model.profile.initials,...this.model.members.map(m=>m.name),"Unassigned"])],"apply-bulk-owner","");
    if (action === "apply-bulk-owner") { this.model.bulkUpdate([...this.model.selected],this.model.ownerColumn.key,target.dataset.value); this.model.selected.clear(); this.view.closeOverlay(); this.update(); this.view.toast("Owners updated"); }
    if (action === "bulk-priority") this.view.showQuickChoice("Set selected priority",["Low","Medium","High","Critical"],"apply-bulk-priority","");
    if (action === "apply-bulk-priority") { this.model.bulkUpdate([...this.model.selected],this.model.priorityColumn.key,target.dataset.value); this.model.selected.clear(); this.view.closeOverlay(); this.update(); this.view.toast("Priorities updated"); }
    if (action === "settings") this.togglePanel("settings",()=>this.view.showSettings(this.model));
    if (action === "settings-section") { this.model.updateSetting("settingsSection",target.dataset.section); this.view.showSettings(this.model,target.dataset.section); this.markPanel("settings"); }
    if (action === "workspace-manage") this.view.showSettings(this.model,"workspace");
    if (action === "request-delete-workspace") { const workspace=this.model.workspaces.find((w)=>String(w.id)===String(target.dataset.id)), files=workspace?.boards?.some((x)=>x.columns?.some((c)=>c.type==="files")); this.view.showConfirm("Delete workspace?",`All boards and records in this workspace will be deleted${this.model.filesAvailable()?"":" from this browser"}.${files?" Files in Files columns are deleted permanently.":""}`,"confirm-delete-workspace",target.dataset.id); }
    if (action === "confirm-delete-workspace") { const id=target.dataset.payload; this.runBusy(target,()=>this.model.deleteWorkspace(id),()=>{this.view.closeOverlay();this.update();this.view.toast("Workspace deleted",true);}); }
    if (action === "remove-member") { const id=target.dataset.id; this.runBusy(target,()=>this.model.removeMember(id),()=>{this.update();this.view.showSettings(this.model,"members");}); }
    if (action === "theme") { this.model.updateSetting("theme",target.dataset.theme); this.model.updateSetting("palette","default"); this.appearance?.save(); this.view.applyDisplay(this.model); this.view.showSettings(this.model); this.markPanel("settings"); }
    if (action === "invite") this.view.showInvite();
    if (action === "profile-menu") this.togglePanel("profile",()=>this.view.showProfileMenu(this.model,this.auth));
    if (action === "lock-session") { this.auth.lock(); this.update(); }
    if (action === "request-logout") this.view.showConfirm("Sign out of Jarc?","Your local board data will remain on this browser.","confirm-logout");
    if (action === "confirm-logout") { this.auth.logout(); this.update(); }
    if (action === "profile-settings") this.view.showProfileSettings(this.model);
    if (action === "choose-avatar") document.querySelector("#avatar-file").click();
    if (action === "remove-avatar") { this.model.setAvatar(""); this.view.showProfileSettings(this.model); }
    if (action === "set-presence") { this.model.updateProfile({presence:target.dataset.value}); this.view.showProfileMenu(this.model,this.auth); this.markPanel("profile"); this.view.toast(`Status set to ${target.dataset.value}`); }
    if (action === "notifications") { const feed=Boolean(this.model.storage.adapter.loadActivityFeed); this.feedFilter="all"; if(this.togglePanel("notifications",()=>this.view.showNotifications(this.model,"all",{loading:feed&&!this.model.feed}))&&feed)this.loadFeed(); }
    if (action === "notification-filter") { this.feedFilter=target.dataset.filter; this.view.showNotifications(this.model,target.dataset.filter); this.markPanel("notifications"); }
    if (action === "mark-notifications") { if(this.model.feed)this.model.markFeedRead(); else this.model.markAllNotificationsRead(); this.view.showNotifications(this.model,this.feedFilter||"all"); this.markPanel("notifications"); const b=this.root.querySelector(".notification-button b"); if(b&&!this.model.unreadCount)b.remove(); }
    if (action === "clear-notifications") this.view.showConfirm("Clear notifications?","This removes every notification from your local inbox.","confirm-clear-notifications");
    if (action === "confirm-clear-notifications") { this.model.clearNotifications(); this.view.closeOverlay(); this.update(); }
    if (action === "open-notification" && this.model.feed) { const board=target.dataset.board, workspace=target.dataset.workspace; this.view.closeOverlay(); if(board&&this.model.workspaces.some((w)=>w.id===workspace&&w.boards.some((b)=>b.id===board)))this.model.openBoard(board,workspace); else if(workspace&&this.model.workspaces.some((w)=>w.id===workspace))this.model.switchWorkspace(workspace); else this.view.toast("That item no longer exists."); this.update(); return; }
    if (action === "open-notification") { const item=this.model.notifications.find((note)=>note.boardId===target.dataset.board && note.workspaceId===target.dataset.workspace && !note.read); if(item)item.read=true; this.model.save({op:"updateUserState"}); this.model.openBoard(target.dataset.board,target.dataset.workspace); this.view.closeOverlay(); this.update(); }
    if (action === "command-palette") this.view.showCommandPalette(this.model);
    if (action === "palette-workspace") { this.model.switchWorkspace(target.dataset.id); this.view.closeOverlay(); this.update(); }
    if (action === "palette-board") { this.model.openBoard(target.dataset.id,target.dataset.workspace); this.view.closeOverlay(); this.update(); }
    if (action === "palette-record") { this.openSearchResult(target.dataset.board,target.dataset.workspace,target.dataset.id,target.dataset.title); return; }
    if (action === "search-retry") { const q=document.querySelector("[data-action=command-search]")?.value||""; this.serverSearch=null; this.scheduleServerSearch(q,0); return; }
    if (action === "run-command") this.runCommand(target.dataset.command);
    if (action === "global-search") this.view.showGlobalSearch();
    if(action==="move-board"){const choices=this.model.workspaces.filter(w=>w.id!==this.model.currentWorkspaceId&&!w.archived);this.view.overlay(`<div class="modal small-modal"><div class="modal-head"><h2>Move board to workspace</h2>${this.view.closeButton()}</div><div class="choice-list">${choices.map(w=>`<button data-action="apply-move-board" data-id="${this.view.attr(target.dataset.id)}" data-workspace="${this.view.attr(w.id)}">${this.view.escape(w.name)}</button>`).join("")||"<p>Create another workspace to move this board.</p>"}</div></div>`);}
    if (action === "apply-move-board") { const ws=this.model.workspaces.find(w=>w.id===target.dataset.workspace); if(ws){this.model.moveBoardToWorkspace(target.dataset.id,ws.id);this.view.closeOverlay();this.update();this.view.toast("Board moved");} }
    if (action === "archive-board") { this.model.archiveBoard(target.dataset.id,!this.model.workspace.boards.find(b=>b.id===target.dataset.id)?.archived); this.view.closeOverlay();this.update();this.view.toast("Board archive updated"); }
    if(action==="shortcuts")this.view.showShortcuts();
    if (action === "import") this.view.showImport(this.model);
    if (action === "choose-import-file") document.querySelector("#import-file").click();
    if (action === "export") this.exportCsv();
    if (action === "export-backup") this.exportBackup();
    if (action === "close-overlay" && (event.target === target || target.closest("button"))) this.view.closeOverlay();
  }

  onInput(event) {
    if (this.appearance?.onInput(event.target)) return;
    if (event.target.dataset?.action === "comment-input") { this.comments?.onInput(event.target); return; }
    if (event.target.dataset.action === "cell-option-search") { this.view.filterOptions(event.target.closest(".cell-options-popover"),event.target.value); return; }
    if (event.target.dataset.action === "workspace-search") { const term=event.target.value.toLowerCase(); document.querySelectorAll(".workspace-list > button").forEach((button)=>{button.hidden=!button.textContent.toLowerCase().includes(term);}); return; }
    if (event.target.dataset.action === "column-picker-search") { this.view.showColumnPicker(this.model,event.target.value); return; }
    if (event.target.dataset.action === "command-search") { clearTimeout(this.searchTimer); const value=event.target.value; this.searchTimer=setTimeout(()=>{ if(document.querySelector(".command-modal")) this.view.showCommandPalette(this.model,value,this.serverSearchFor(value)); },90); this.scheduleServerSearch(value); return; }
    if (event.target.dataset.action === "column-type-search") {
      const term=event.target.value.trim().toLowerCase(), modal=event.target.closest(".column-chooser"), options=[...modal.querySelectorAll(".chooser-option")];
      options.forEach((b)=>{b.hidden=Boolean(term)&&!b.dataset.search.includes(term);});
      modal.querySelectorAll(".chooser-group").forEach((g)=>{g.hidden=![...g.querySelectorAll(".chooser-option")].some((b)=>!b.hidden);});
      modal.querySelector(".chooser-empty").hidden=options.some((b)=>!b.hidden); return;
    }
    if (event.target.dataset.action !== "search") return;
    const cursor=event.target.selectionStart; this.model.query=event.target.value; this.update();
    const input=document.querySelector('[data-action="search"]'); input?.focus(); input?.setSelectionRange(cursor,cursor);
  }
  onChange(event) {
    if (event.target.dataset?.action === "comment-input") return;
    if (event.target.dataset?.action === "integration-wizard-workspace") { this.integrations?.onAction("integration-wizard-workspace", event.target); return; }
    // Display columns: show/hide one column, or all of them (Item always stays).
    if (event.target.dataset?.action === "column-toggle" || event.target.dataset?.action === "column-toggle-all") {
      const all=event.target.dataset.action==="column-toggle-all";
      const changed=all?this.model.setAllColumnsVisible(event.target.checked):this.model.setColumnVisible(event.target.dataset.key,event.target.checked);
      if(changed!==false)this.refreshViewChrome();
      return;
    }
    if (event.target.dataset?.action === "files-input") { const input=event.target, files=[...input.files]; input.value=""; this.addFiles(input.dataset.id,input.dataset.field,files); return; }
    const action=event.target.dataset.action;
    if(action==="login-theme"){this.model.updateSetting("theme",event.target.value);this.view.applyDisplay(this.model);return;}
    if(action==="home-sort"){this.model.updateSetting("homeSort",event.target.value);this.update();return;}
    if(action==="quick-view"){this.model.quickFilter=event.target.value;this.model.showArchived=false;this.update();return;}
    if(action==="import-mapping"){const data=Object.fromEntries(new FormData(event.target.form));this.view.showImportPreview(this.model,this.pendingImport,data);return;}
    if (action === "filter") { this.model.status=event.target.value; this.update(); }
    if (action === "select") return; // handled on click (Shift-click selects a range)
    if (action === "select-all") { this.model.visibleRows.forEach((row)=>event.target.checked?this.model.selected.add(row.id):this.model.selected.delete(row.id)); this.update(); }
    if (action === "density") { this.model.updateSetting("density",event.target.checked?"compact":"comfortable"); document.documentElement.dataset.density=this.model.settings.density; }
    if (action === "setting") { this.model.updateSetting(event.target.dataset.key,event.target.checked); this.update(); this.view.showSettings(this.model); }
    if (action === "setting-select") { const key=event.target.dataset.key; const value=["density","fontSize"].includes(key)?event.target.value.toLowerCase():event.target.value; this.model.updateSetting(key,value); this.update(); this.view.showSettings(this.model,this.model.settings.settingsSection); }
    if (action === "board-title-inline") { this.model.renameBoard(this.model.currentBoardId,event.target.value); this.update(); this.view.toast("Board name saved"); }
    if (action === "import-file") this.importData(event.target.files[0]);
    if (action === "avatar-file") this.loadAvatar(event.target.files[0]);
  }
  onSubmit(event) {
    event.preventDefault(); const action=event.target.dataset.action; const data=Object.fromEntries(new FormData(event.target));
    if (action?.startsWith("integration-")) { this.integrations?.onSubmit(action, data, event.target); return; }
    if ((action === "group-form" || action === "group-delete-form") && this.groupActions) { this.groupActions.onSubmit(action, data, event.target); return; }
    if (action === "workspace-form") { this.runBusy(event.submitter,()=>this.model.createWorkspace(data)?undefined:false,()=>{this.view.closeOverlay();this.update();this.view.toast("Workspace created");}); return; }
    if(action==="login-form"){
      data.username=String(data.username||"").trim();
      if(!data.username){const field=event.target.querySelector('[name="username"]');field.value="";field.reportValidity();return;}
      if(!event.target.reportValidity())return;
      this.auth.draftUsername=data.username;this.auth.draftRememberUsername=Boolean(data.rememberUsername);this.auth.draftRememberSession=Boolean(data.rememberSession);
      const signedIn=this.auth.login(data.username,data.password,Boolean(data.rememberSession),Boolean(data.rememberUsername));
      if(signedIn)this.model.syncUsername(data.username);this.update();return;
    }
    if(action==="sort-form"){this.model.sortKey=data.key;this.model.sortDirection=data.direction;this.model.manualSort=false;this.model.board.manualOrder=false;this.model.save({op:"updateBoard",boardId:this.model.board.id});this.update();return;}
    if(action==="confirm-import-form"){let result;this.runBusy(event.submitter,()=>{result=this.model.importRows(this.pendingImport,data);},()=>{this.pendingImport=null;this.view.closeOverlay();this.update();this.view.toast(result.valid.length+" records imported"+(result.issues.length?" · "+result.issues.length+" skipped":""),true);});return;}
    if (action === "record-form" && data.id && event.target.dataset.conflicts && !event.target.dataset.conflictsSeen) { event.target.dataset.conflictsSeen="1"; this.view.formNotice(event.target, event.target.querySelector(".form-live-notice")?.innerHTML.replace("Saving will replace", "Save again to replace")||"A colleague changed this record. Save again to keep your values.","warning"); return; }
    if (action === "record-form") { const edit=Boolean(data.id); const fd=new FormData(event.target); this.model.board.columns.filter((column)=>this.model.isMultiColumn(column)&&event.target.querySelector(`[name="${CSS.escape(column.key)}"]`)).forEach((column)=>{data[column.key]=fd.getAll(column.key);}); this.model.board.columns.filter((column)=>column.type==="checkbox").forEach((column)=>{data[column.key]=Boolean(data[column.key]);});
      // Editing: send only what changed in this form, so fields a colleague updated meanwhile aren't overwritten.
      if(edit&&event.target.dataset.initial){const initial=JSON.parse(event.target.dataset.initial),now=this.view.formValues(event.target);for(const key of Object.keys(initial))if(JSON.stringify(initial[key])===JSON.stringify(now[key]))delete data[key];} this.runBusy(event.submitter,()=>{this.model.upsert(data);},()=>{this.view.closeOverlay();this.update();this.view.toast(edit?"Record updated":"Record added");}); }
    if (action === "board-form") { this.runBusy(event.submitter,()=>{if(data.id){this.model.renameBoard(data.id,data.name);const b=this.model.workspace.boards.find(b=>b.id===data.id);b.description=data.description;this.model.save({op:"updateBoard",boardId:data.id});}else{this.model.currentWorkspaceId=data.workspace;this.model.createBoard(data.name,data.description,data.template);}},()=>{this.view.closeOverlay();this.update();this.view.toast(data.id?"Board renamed":"Board created");}); }
    if (action === "invite-form") { if(this.model.addMember(data)){this.view.closeOverlay();this.update();this.view.toast("Member added");}else this.view.showMessage("Member not added","Use a unique email address."); }
    if (action === "global-search-form") this.globalSearch(data.term);
    if (action === "add-group-form") { if (this.model.addGroup(data.name)) { this.view.showGroupManager(this.model); this.view.toast("Group added"); } else this.view.showMessage("Group not added","Use a unique, non-empty group name."); }
    if (action === "column-filter-form") {
      const form=event.target, key=data.key, op=data.op, noValue=["empty","not-empty","checked","unchecked"].includes(op);
      const value=op==="in"?new FormData(form).getAll("value"):String(data.value??"").trim();
      if(op==="in"&&!value.length)this.model.columnFilter=null;
      else if(!noValue&&value===""){form.querySelector('[name="value"]')?.focus();this.view.toast("Enter a value to filter by");return;}
      else this.model.columnFilter={key,op,value:noValue?"":value};
      this.view.closeOverlay(); this.update(); return;
    }
    if (action === "create-column-form") { let column; this.runBusy(event.submitter,()=>{column=this.model.addColumn({label:data.label,type:data.type,options:data.options||"",multiple:data.multiple==="on"});return column?undefined:false;},()=>{this.view.closeOverlay();this.update();this.root.querySelector(`th[data-column-key="${CSS.escape(column.key)}"]`)?.scrollIntoView({block:"nearest",inline:"nearest"});this.view.toast(`${column.label} column added`,true);}); }
    if (action === "rename-column-form") { this.runBusy(event.submitter,()=>this.model.editColumn(data.key,{label:data.label,description:data.description})?undefined:false,()=>{this.view.closeOverlay();this.update();this.view.toast("Column updated",true);}); }
    if (action === "column-options-form") { this.pendingOptions={key:data.key,items:[...event.target.querySelectorAll(".option-row")].map((row)=>{const input=row.querySelector(".option-name");return {from:input.dataset.from||null,to:input.value,color:row.querySelector(".option-color")?.value||""};})}; this.applyColumnOptions(false,event.submitter); }
    if (action === "column-width-form") { const width=Number(data.width); if(!Number.isFinite(width))return; this.runBusy(event.submitter,()=>{this.model.resizeColumn(data.key,width);},()=>{this.view.closeOverlay();this.update();this.view.toast(this.model.activeView?"Width changed in this view. Save to this view to keep it.":"Column width saved");}); }
    if (action === "edit-column-form") { const column=this.model.board.columns.find((c)=>c.key===data.key); const description=String(data.description||"").trim().slice(0,500); this.model.renameColumn(data.key,data.label); this.model.updateColumnConfig({[data.key]:{visible:data.key==="serial"?true:Boolean(data.visible),required:data.key==="serial"?true:Boolean(data.required),connection:data.connection||"",...("defaultValue" in data?{defaultValue:data.defaultValue||""}:{}),...(description?{description}:{})}}); if(column&&!description)delete column.description; this.view.closeOverlay(); this.update(); this.view.toast("Column updated"); }
    if (action === "confirm-bulk-delete") { if(String(data.confirm||"").trim().toUpperCase()!=="DELETE"){this.view.showDialogError("Type DELETE to confirm.");return;} const ids=this.pendingBulkDelete||[]; this.pendingBulkDelete=null; this.deleteRecords(ids,event.submitter); return; }
    if (action === "create-view-form") { const view=this.model.createView(data.name,data.type); if(view){this.view.closeOverlay();this.update();this.view.toast(`View "${view.name}" created`);} return; }
    if (action === "rename-view-form") { if(this.model.renameView(data.id,data.name)){this.view.closeOverlay();this.update();this.view.toast("View renamed");} return; }
    if (action === "save-view-form") { if (this.model.saveView(data.name)) { this.view.closeOverlay(); this.update(); this.view.toast("View saved"); } }
    if (action === "profile-form") { data.name=this.auth.username; this.model.updateProfile(data); this.view.closeOverlay(); this.update(); this.view.toast("Profile updated"); }
    if (action === "description-form") { this.model.updateBoardDescription(data.description); this.view.closeOverlay(); this.update(); this.view.toast("Description saved"); }
    if(action==="paste-import-form"){if(String(data.text||"").length>10*1024*1024){this.view.showMessage("Import not ready","Pasted text is larger than 10 MB. Split it into smaller imports.");return;}try{const rows=this.parseCsv(data.text);this.model.assertImportable(rows);this.pendingImport=rows;this.view.showImportPreview(this.model,rows);}catch(error){this.view.showMessage("Import not ready",error.message);}return;}
    if (action === "workspace-settings-form") { this.model.updateWorkspace(this.model.currentWorkspaceId,data); this.update();this.view.showSettings(this.model,"workspace"); this.view.toast("Workspace updated"); }
  }
  onKeydown(event) {
    if (this.appearance?.onKeydown(event)) return;
    if (event.target.dataset?.action === "comment-input" && this.comments?.onKeydown(event)) return;
    if(this.busy)return;
    if(event.target.dataset?.action==="row-drag"&&event.altKey&&["ArrowUp","ArrowDown"].includes(event.key)&&this.rowDragBlocked()){event.preventDefault();this.view.toast(this.rowDragBlocked());return;}
    if(event.target.dataset?.action==="row-drag"&&event.altKey&&["ArrowUp","ArrowDown"].includes(event.key)){
      event.preventDefault();const id=this.model.idOf(event.target.dataset.id),rows=this.model.visibleRows,index=rows.findIndex(r=>r.id===id),up=event.key==="ArrowUp",target=rows[index+(up?-1:1)];
      if(target&&this.model.reorderRecord(id,target.id,up?"before":"after")){this.update();this.root.querySelector('[data-action="row-drag"][data-id="'+id+'"]')?.focus();this.view.toast("Row moved",true);}return;
    }
    const editing=event.target.matches?.('input,textarea,select,[contenteditable="true"]');
    if(!this.auth.authenticated)return;
    if(event.target.dataset?.action==="cell-input"){this.cellInputKey(event);return;}
    if(event.target.dataset?.action==="draft-input"){this.draftKey(event);return;}
    if(event.target.classList?.contains("cell-display")&&!document.querySelector("#overlay-root")?.children.length&&this.cellKey(event))return;
    // Undo / redo for board changes — never inside text fields (their own undo stays native) or open dialogs.
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&["z","y"].includes(event.key.toLowerCase())&&!editing&&!document.querySelector("#overlay-root")?.children.length&&this.model.screen==="board"){event.preventDefault();this.undoRedo(event.key.toLowerCase()==="y"||event.shiftKey);return;}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){event.preventDefault();this.view.showCommandPalette(this.model);return;}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="b"&&!editing){event.preventDefault();this.toggleSidebar();return;}
    if(event.target.dataset?.action==="column-type-search"&&event.key==="Enter"){event.preventDefault();event.target.closest(".column-chooser")?.querySelector(".chooser-option:not([hidden]):not(:disabled)")?.click();return;}
    if(event.key==="Escape"){
      event.preventDefault();
      if(event.target.dataset.action==="board-title-inline"){event.target.value=event.target.dataset.beforeEdit??event.target.defaultValue;event.target.blur();return;}
      this.view.closeOverlay();this.setNav(false);return;
    }
    const root=document.querySelector("#overlay-root");
    if(root?.children.length){
      const palette=root.querySelector(".command-results"), menu=root.querySelector(".popover,.profile-popover");
      const list=palette||menu;
      if(list&&["ArrowDown","ArrowUp","Enter"].includes(event.key)&&!event.target.matches('select,textarea')){
        const buttons=[...list.querySelectorAll('button:not(:disabled)')].filter(b=>!b.hidden&&b.offsetParent!==null);if(!buttons.length)return;
        const index=buttons.findIndex(b=>b===document.activeElement||b.classList.contains("keyboard-selected"));
        event.preventDefault();if(event.key==="Enter"){buttons[Math.max(0,index)].click();return;}
        const next=(index+(event.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length;
        buttons.forEach(b=>b.classList.remove("keyboard-selected"));buttons[next].classList.add("keyboard-selected");
        if(!palette)buttons[next].focus();buttons[next].scrollIntoView({block:"nearest"});return;
      }
      if(event.key==="Tab"){
        const focusable=[...root.querySelectorAll('button:not(:disabled),input:not([type="hidden"]):not(:disabled),textarea,select,[tabindex="0"]')].filter(e=>!e.hidden&&e.offsetParent!==null);
        const first=focusable[0],last=focusable.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }return;
    }
    if(event.target.dataset.action==="resize-column"&&["ArrowLeft","ArrowRight"].includes(event.key)){event.preventDefault();const c=this.model.board.columns.find(c=>c.key===event.target.dataset.key);this.model.resizeColumn(c.key,(this.view.colWidth(c))+(event.key==="ArrowRight"?20:-20));this.update();return;}
    if(event.target.dataset.action==="board-title-inline"&&event.key==="Enter"){event.preventDefault();event.target.blur();return;}
    if(!editing&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
      if(event.key==="/"){event.preventDefault();if(this.model.screen==="board")document.querySelector("#board-search")?.focus();else this.view.showCommandPalette(this.model);}
      if(event.key==="?"){event.preventDefault();this.view.showShortcuts();}
      if(event.key.toLowerCase()==="n"){event.preventDefault();this.chooseBoardAction("record");}
    }
  }

  // The file warning must be right: if this board's file list is still arriving, wait for it (briefly) first; if it
  // couldn't load, say plainly that attached files would be deleted too.
  async deleteFileInfo(ids) {
    const board=this.model.board, id=board?String(this.model.serverId(board.id)):"", hasFiles=Boolean(board?.columns.some((col)=>col.type==="files"));
    const pending=hasFiles&&this.attachmentLoads?.get(id);
    if(pending)await Promise.race([pending,new Promise((r)=>setTimeout(r,5000))]);
    return { files: board?this.model.boardFileCount(board,{recordIds:ids}):0, unknown: hasFiles&&(this.model.attachmentErrors.has(id)||this.model.attachmentLoading.has(id)) };
  }
  async requestDeleteRecords(ids) {
    if (!ids.length) return;
    const { files, unknown } = await this.deleteFileInfo(ids);
    const n=ids.length, what=`Delete ${n} record${n===1?"":"s"}?`;
    const text=files?`The selected data will be removed from this board, and their ${files} attached file${files===1?"":"s"} will be permanently deleted. Undo can restore the records but not the files.`
      :unknown?"The selected data will be removed from this board. Any files attached to these records will be permanently deleted — Undo can restore the records but not the files."
      :"The selected data will be removed from this board. Undo remains available afterward.";
    this.view.showConfirm(what,text,"confirm-delete-records",ids.join(","));
  }
  // Rows leave with a short slide once the server has confirmed the deletion, then the table re-renders.
  deleteRecords(ids,button=null) { if (!ids.length) return; const rows=ids.map((id)=>this.root.querySelector(`tr[data-record-context="${CSS.escape(String(id))}"]`)); this.runBusy(button,()=>this.model.remove(ids),async()=>{this.view.closeOverlay();await this.animateOut(rows.filter((tr)=>tr?.isConnected));this.update();this.view.toast(`${ids.length===1?"Record":`${ids.length} records`} deleted`,true);}); }
  deleteBoard(id,button=null) { this.runBusy(button,()=>this.model.deleteBoard(id),()=>{this.view.closeOverlay();this.update();this.view.toast("Board deleted",true);}); }
  globalSearch(term) { if (!term) return; const match=this.model.allRecords.find((row)=>Object.values(row).some((value)=>String(value||"").toLowerCase().includes(term.toLowerCase()))); if (!match) { this.view.showMessage("No matching items",`No item matched “${term}”.`); return; } this.model.openBoard(match.boardId,match.workspaceId); this.model.query=term; this.view.closeOverlay(); this.update(); }
  runCommand(command) {
    if(this.needsWorkspace(AppController.NO_WORKSPACE_COMMANDS.has(command)))return;
    this.model.rememberCommand(command);this.view.closeOverlay();
    if(command==="home"||command==="mywork"){this.model.openScreen(command);this.update();}
    if(command==="new-record")this.chooseBoardAction("record");
    if(command==="new-board")this.view.showBoardForm(null);
    if(command==="import")this.chooseBoardAction("import");
    // Toggle light / dark: JARC Default for the other mode, saved for this person (Phase 9C).
    if(command==="theme"){const next=document.documentElement.dataset.theme==="dark"?"light":"dark";if(this.appearance)this.appearance.setMode(next);else this.model.updateSetting("theme",next);this.update();this.appearance?.save();}
    if(command==="shortcuts")this.view.showShortcuts();
    if(command==="notifications")this.view.showNotifications(this.model);
    if(command==="profile")this.view.showProfileSettings(this.model);
    if(command==="settings")this.view.showSettings(this.model);
  }

  focusItem(id) { requestAnimationFrame(()=>{ const cell=this.cellButton(id,"serial"); cell?.scrollIntoView({block:"nearest",inline:"nearest"}); cell?.focus(); }); }
  loadAvatar(file) { if(!file)return; if(file.size>1024*1024){this.view.showMessage("Photo is too large","Choose an image smaller than 1 MB.");return;} const reader=new FileReader(); reader.onload=()=>{this.model.setAvatar(reader.result);this.view.showProfileSettings(this.model);this.view.toast("Profile photo updated");}; reader.onerror=()=>this.view.showMessage("Photo not loaded","The selected image could not be read."); reader.readAsDataURL(file); }
  // A cell starting with = + - @ (or tab/carriage return) can run as a formula in Excel, Sheets or LibreOffice, so it is
  // exported with a leading apostrophe. Plain numbers in Number columns (e.g. -5) are left as numbers.
  csvCell(value,column=null){ let text=String(value??""); const plainNumber=column?.type==="number"&&/^-?\d+(\.\d+)?$/.test(text.trim()); if(!plainNumber&&/^[=+\-@\t\r]/.test(text))text="'"+text; return `"${text.replaceAll('"','""')}"`; }
  // Exports are async-shaped so a future server-generated export can replace them without changing callers.
  async exportCsv(rows=this.model.visibleRows) { const fields=this.model.board.columns; const csv=[fields.map((field)=>this.csvCell(field.label)).join(","),...rows.map((row)=>fields.map((field)=>this.csvCell(this.model.isMultiColumn(field)?this.model.valueText(field,row[field.key]):row[field.key],field)).join(","))].join("\n"); if(this.download(new Blob([csv],{type:"text/csv"}),`${this.model.board.name.toLowerCase().replace(/[^a-z0-9]+/g,"-")||"board"}.csv`))this.view.toast("Board exported"); }
  async exportBackup() { const backup=JSON.stringify(this.model.createBackup(),null,2); if(this.download(new Blob([backup],{type:"application/json"}),"jarc-database-backup.json"))this.view.toast("Full backup exported"); }
  async importData(file) {
    if(!file)return;
    try{
      if(file.size>10*1024*1024)throw Error("Choose a file smaller than 10 MB.");
      const text=await file.text(), isCsv=file.name.toLowerCase().endsWith(".csv");
      let data; if(isCsv)data=this.parseCsv(text); else { try{data=JSON.parse(text);}catch{throw Error("This file isn't valid JSON. Choose a JARC backup (.json), a JSON list of records, or a CSV file.");} }
      if(!isCsv&&data&&typeof data==="object"&&!Array.isArray(data)&&"workspaces" in data){
        const summary=this.model.validateBackup(data); // throws a readable reason before anything changes
        this.pendingBackup=data;this.view.showConfirm("Restore workspace backup?",`This replaces your current data with ${summary.workspaces} workspace${summary.workspaces===1?"":"s"}, ${summary.boards} board${summary.boards===1?"":"s"} and ${summary.records} record${summary.records===1?"":"s"}. Download a full backup from Settings → Data first. You can undo a restore during this session.`,"restore-backup","","Restore backup");return;
      }
      const rows=Array.isArray(data)?data:data?.rows;this.model.assertImportable(rows);
      this.pendingImport=rows;this.view.showImportPreview(this.model,rows);
    }catch(error){this.view.showMessage("Import not ready",error.message);}
  }

  parseCsv(text) {
    const rows=[];let row=[],cell="",quoted=false;const source=text.replace(/^\uFEFF/,"");
    for(let i=0;i<source.length;i++){
      const c=source[i];if(c==='"'&&quoted&&source[i+1]==='"'){cell+='"';i++;}
      else if(c==='"')quoted=!quoted;
      else if(c===','&&!quoted){row.push(cell);cell="";}
      else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&source[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v.trim()))rows.push(row);row=[];cell="";}
      else cell+=c;
    }
    if(quoted)throw Error("CSV has an unclosed quoted field.");row.push(cell);if(row.some(v=>v.trim()))rows.push(row);
    if(rows.length<2)throw Error("Include a header row and at least one record.");
    const headers=rows.shift().map(v=>v.trim());if(headers.some(h=>!h)||new Set(headers).size!==headers.length)throw Error("Each column needs a unique, non-empty header.");
    return rows.map((r,i)=>{if(r.length!==headers.length)throw Error("Row "+(i+2)+" has "+r.length+" values; expected "+headers.length+".");return Object.fromEntries(headers.map((h,j)=>[h,r[j]]));});
  }

  download(blob,filename) { try { const url=URL.createObjectURL(blob),link=document.createElement("a"); link.href=url; link.download=filename; link.click(); setTimeout(()=>URL.revokeObjectURL(url),500); return true; } catch(error) { this.view.showMessage("Export failed",`The file could not be created in this browser (${error.message}). Try again, or use a different browser.`); return false; } }
  chooseBoardAction(action) {
    if(this.needsWorkspace(false))return;
    if(this.model.screen==="board"&&this.model.board&&!this.model.board.archived){action==="import"?this.view.showImport(this.model):this.view.showRecordForm(this.model);return;}
    const boards=this.model.workspaces.filter(w=>!w.archived).flatMap(w=>w.boards.filter(b=>!b.archived).map(b=>({...b,workspaceId:w.id,workspaceName:w.name})));
    this.view.overlay(`<div class="modal small-modal"><div class="modal-head"><h2>${action==="import"?"Import into a board":"Create a record in…"}</h2>${this.view.closeButton()}</div><div class="choice-list">${boards.map(b=>`<button data-action="choose-board-action" data-mode="${this.view.attr(action)}" data-id="${this.view.attr(b.id)}" data-workspace="${this.view.attr(b.workspaceId)}">${icon("board")}<span><strong>${this.view.escape(b.name)}</strong><small>${this.view.escape(b.workspaceName)}</small></span></button>`).join("")||'<p>Create a board first to add records.</p><button data-action="new-board" class="button primary">Create board</button>'}</div></div>`);
  }
  toggleSidebar(){document.body.classList.toggle("nav-collapsed");window.jarcStorage.setPreference("navCollapsed",document.body.classList.contains("nav-collapsed")?"1":"0");}
  saveFeedback(){
    const button=this.root.querySelector(".save-state");if(!button)return;
    const state=this.model.saveState||"saved";button.classList.toggle("save-error",state==="error");
    const offline=window.jarcStorage?.connection==="offline"; document.body.classList.toggle("storage-offline",offline);
    const live=this.liveState, server=["api","resource"].includes(this.model.storage.adapter.mode);
    const uploading=this.activeUploads();
    const shown=offline||live==="offline"?"offline":this.conflictState?"conflict":state==="error"?"error":state==="saving"?"saving":uploading?"uploading":live==="reconnecting"||live==="connecting"?"reconnecting":live==="polling"?"polling":live==="live"?"live":"saved";
    const labels={offline:"Offline — changes can't be saved",conflict:"Conflict — review the change",error:"Couldn't save · Retry",saving:"Saving…",uploading:`<span class="save-spinner" aria-hidden="true"></span> Uploading ${uploading} file${uploading===1?"":"s"}…`,reconnecting:"<i></i> Saved · Reconnecting…",polling:"<i></i> Saved · Checking for updates",live:"<i></i> Saved · Live",saved:`<i></i> ${server?"Saved":navigator.onLine?"Saved locally":"Offline · saved locally"}`};
    const tips={offline:"No connection. Changes can't be saved until you're back online.",conflict:"Someone else changed what you were editing.",error:"The last change wasn't saved. Click to try again.",saving:"Saving to JARC…",reconnecting:"Everything is saved. Reconnecting to live updates…",polling:"Everything is saved. Live updates are unavailable, so JARC checks for changes every 20 seconds.",live:"Everything is saved. Colleagues' changes appear automatically.",saved:server?"Everything is saved.":"Saved in this browser."};
    tips.uploading=`Uploading ${uploading} file${uploading===1?"":"s"}. Files appear for everyone once each upload finishes.`;
    if(button.dataset.state===shown&&button.dataset.rendered===String(uploading))return; // unchanged: no flicker
    button.dataset.state=shown;
    const settled=["saving","uploading"].includes(this.lastSaveShown)&&["live","saved","polling","reconnecting"].includes(shown);
    button.innerHTML=labels[shown]; button.title=tips[shown]; button.setAttribute("aria-label",tips[shown]); button.dataset.rendered=String(uploading);
    if(settled)this.view.play(button,"just-saved");
    this.lastSaveShown=shown;


  }
  onContextMenu(event){
    const row=event.target.closest('[data-record-context]'),board=event.target.closest('[data-board-context]'),workspace=event.target.closest('[data-action="workspace-menu"]');
    if(!row&&!board&&!workspace)return;event.preventDefault();
    if(row)this.view.showRecordMenu(this.model.rows.find(r=>r.id===this.model.idOf(row.dataset.recordContext)));
    else if(board){this.boardMenuWorkspace=board.dataset.workspace||this.model.currentWorkspaceId;this.view.showBoardMenu(this.model.workspaces.find(w=>w.id===this.boardMenuWorkspace).boards.find(b=>b.id===board.dataset.boardContext));}
    else this.view.overlay(`<div class="modal small-modal"><div class="modal-head"><h2>${this.view.escape(this.model.workspace.name)}</h2>${this.view.closeButton()}</div><div class="choice-list"><button data-action="workspace-manage">Rename and customize</button><button data-action="settings-section" data-section="members">Manage local members</button><button data-action="archive-workspace" data-id="${this.view.attr(this.model.workspace.id)}" data-archived="1">Archive workspace</button><button class="danger" data-action="request-delete-workspace" data-id="${this.view.attr(this.model.workspace.id)}">Delete workspace</button></div></div>`);
    const pop=this.root.querySelector('.popover');if(pop){pop.style.left=Math.min(event.clientX,innerWidth-260)+"px";pop.style.top=Math.min(event.clientY,innerHeight-340)+"px";pop.style.right="auto";}
  }
  startRowDrag(event){
    const row=event.target.closest('.editable-table tr[data-record-context]');
    const handle=event.target.closest('[data-action="row-drag"]');
    if(!row||event.button!==0||(!handle&&event.target.closest('input,textarea,select,button,a,[contenteditable]')))return;
    if(!handle&&event.pointerType==='touch')return;
    const blocked=this.rowDragBlocked(); if(blocked){ if(handle){event.preventDefault();this.view.toast(blocked);} return; }
    event.preventDefault();
    const id=this.model.idOf(row.dataset.recordContext),board=this.model.board,startX=event.clientX,startY=event.clientY,wrap=row.closest('.table-wrap');
    let active=false,ghost=null,target=null,position='before',x=startX,y=startY,frame;
    const clearMarks=()=>this.root.querySelectorAll('.row-drop-before,.row-drop-after').forEach(r=>r.classList.remove('row-drop-before','row-drop-after'));
    const locate=()=>{
      clearMarks();target=null;
      const element=document.elementFromPoint(x,y)?.closest('tr[data-record-context]');
      if(!element||element===row||element.closest('.table-wrap')!==wrap)return;
      const source=this.model.rows.find(r=>r.id===id),other=this.model.rows.find(r=>r.id===this.model.idOf(element.dataset.recordContext));
      if(!source||!other||Boolean(source.pinned)!==Boolean(other.pinned))return;
      if(this.model.grouped&&this.model.groupColumn&&(source[this.model.groupColumn.key]||'')!==(other[this.model.groupColumn.key]||''))return;
      const bounds=element.getBoundingClientRect();position=y<bounds.top+bounds.height/2?'before':'after';target=other.id;element.classList.add('row-drop-'+position);
    };
    const tick=()=>{
      if(!active)return;
      const bounds=wrap.getBoundingClientRect();
      if(x>=bounds.left&&x<=bounds.right){
        if(y<bounds.top+45&&y>bounds.top-20)wrap.scrollTop-=9;
        else if(y>bounds.bottom-45&&y<bounds.bottom+20)wrap.scrollTop+=9;
        if(y<60)window.scrollBy(0,-9);else if(y>innerHeight-60)window.scrollBy(0,9);
      }
      locate();frame=requestAnimationFrame(tick);
    };
    const move=e=>{
      if(e.pointerId!==event.pointerId)return;x=e.clientX;y=e.clientY;
      if(!active&&Math.hypot(x-startX,y-startY)<6)return;
      e.preventDefault();
      if(!active){active=true;row.classList.add('row-dragging');document.body.classList.add('is-row-dragging');ghost=document.createElement('div');ghost.className='row-drag-preview';ghost.textContent=this.model.rows.find(r=>r.id===id)?.serial||'Move record';document.body.append(ghost);tick();}
      ghost.style.left=Math.max(8,Math.min(x+18,innerWidth-250))+'px';ghost.style.top=Math.max(8,Math.min(y+12,innerHeight-50))+'px';locate();
    };
    const cleanup=()=>{cancelAnimationFrame(frame);clearMarks();row.classList.remove('row-dragging');document.body.classList.remove('is-row-dragging');ghost?.remove();document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',cancel);document.removeEventListener('keydown',key);window.removeEventListener('blur',cancel);};
    const cancel=()=>{cleanup();handle?.focus();};
    const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();cancel();}};
    const up=e=>{if(e.pointerId!==event.pointerId)return;const moved=active&&target!==null&&board===this.model.board;cleanup();if(moved&&this.model.reorderRecord(id,target,position)){this.update();this.root.querySelector('[data-action="row-drag"][data-id="'+id+'"]')?.focus();this.view.toast('Row order saved',true);}};
    document.addEventListener('pointermove',move,{passive:false});document.addEventListener('pointerup',up);document.addEventListener('pointercancel',cancel);document.addEventListener('keydown',key);window.addEventListener('blur',cancel);
  }

  startResize(event){
    const handle=event.target.closest('[data-action="resize-column"]');if(!handle)return;event.preventDefault();
    const key=handle.dataset.key,th=handle.closest('th'),start=event.clientX,width=th.getBoundingClientRect().width;
    const move=e=>{const next=Math.max(100,Math.min(600,width+e.clientX-start));th.style.width=th.style.minWidth=next+"px";};
    const up=e=>{document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",up);this.model.resizeColumn(key,width+e.clientX-start);};
    document.addEventListener("pointermove",move);document.addEventListener("pointerup",up,{once:true});
  }
  enhanceOverlay(){
    const root=this.root.querySelector('#overlay-root');if(!root?.children.length){this.root.querySelector(".app-shell")?.removeAttribute("inert");return;}
    if(this.navOpen)this.setNav(false,{restoreFocus:false});
    const panel=root.querySelector('.modal,.record-drawer,.settings-window,.settings-drawer,.popover,.profile-popover');if(!panel)return;
    if(panel.dataset.enhanced)return;panel.dataset.enhanced="1";
    panel.setAttribute("role","dialog");panel.setAttribute("aria-modal","true");if(!panel.getAttribute("aria-label")||panel.querySelector('h2'))panel.setAttribute("aria-label",panel.querySelector('h2')?.textContent||panel.getAttribute("aria-label")||"Actions");
    if(!this.overlayReturnFocus?.isConnected)this.overlayReturnFocus=document.activeElement;
    panel.querySelectorAll('button.icon-button:not([aria-label])').forEach(b=>b.setAttribute('aria-label',b.title||'Close'));
    const pop=panel.matches('.popover,.profile-popover');
    if(!pop)this.root.querySelector(".app-shell")?.setAttribute("inert","");else this.root.querySelector(".app-shell")?.removeAttribute("inert");
    if(pop&&this.lastTrigger?.isConnected){const r=this.lastTrigger.getBoundingClientRect();panel.style.left=Math.max(8,Math.min(r.left,innerWidth-panel.offsetWidth-12))+"px";panel.style.top=Math.max(8,Math.min(r.bottom+6,innerHeight-panel.offsetHeight-12))+"px";panel.style.right="auto";}
    requestAnimationFrame(()=>{const focus=panel.querySelector('[autofocus]')||panel.querySelector('input:not([type="hidden"]),select,textarea')||panel.querySelector('button');focus?.focus();});
  }
  refreshCommentIndicators(){document.querySelectorAll('[data-action="open-updates"]').forEach((b)=>{const row=this.model.rows.find((r)=>String(r.id)===b.dataset.id);if(row)b.outerHTML=this.view.commentButton(this.model,row);});}
  guard(action){if(this.busy)return;try{action();}catch(error){this.view.showMessage("Action could not be completed",error.message);}}

  // ---- Async persistence (Stage 8)
  // An optimistic change failed to save: the model has already rolled back to the last saved state. Redraw, explain,
  // and offer a single user-triggered Retry when it can help. Busy (pessimistic) operations report in their dialog.
  onRollback(detail){
    if(this.busy||!this.ready)return;
    this.update();
    // Resource mode already loaded the server's latest copy after a conflict, so the message says so.
    const info=detail?.refreshed?StorageError.describeRefreshed(detail.code):StorageError.describe(detail?.code);
    // One save-error toast at a time: a newer failure replaces the previous message instead of stacking.
    document.querySelectorAll('.toast[data-kind="save-error"]').forEach((toast)=>toast.remove());
    const toast=this.view.toast(info.message,info.retryable?{label:"Retry",onClick:()=>this.retrySave()}:false);
    if(toast)toast.dataset.kind="save-error";
  }
  retrySave(){ if(this.busy)return; this.model.retryFailedSave(); this.update(); }
  // Pessimistic operation: the button shows progress and ignores repeat clicks; the screen updates only after the save
  // succeeds. On failure the model has rolled back, the dialog stays open with the reason, and clicking again retries.
  // perform() may return false for "nothing to do" and may throw a validation error.
  // Destructive/structural actions: the change is saved first and applied only after storage accepts it
  // (model.applyAfterSave), so a failure leaves the data and the open dialog exactly as they were.
  async runBusy(button,perform,onSuccess){
    if(this.busy)return false;
    this.busy=true; this.view.clearDialogError(); this.view.setBusy(button,true);
    let ok=false,skipped=false,message="";
    try{ const outcome=await this.model.applyAfterSave(perform); ok=outcome.ok; skipped=outcome.skipped&&!outcome.ok; if(!ok)message=StorageError.describe(outcome.code).message; }
    catch(error){ message=error?.message||StorageError.describe(StorageError.CODES.INTERNAL_ERROR).message; }
    this.busy=false; this.view.setBusy(button,false);
    if(ok){ onSuccess(); return true; }
    if(skipped)return false;
    this.view.showDialogError(`${message} Nothing was changed.`);
    this.saveFeedback(); return false;
  }

  // ---- Table interaction (Stage 4). Cell edits patch one cell; row inserts refresh only the board view.
  cellButton(id,field){return this.root.querySelector(`tr[data-record-context="${CSS.escape(String(id))}"] [data-action="cell-open"][data-field="${CSS.escape(field)}"]`);}
  patchCell(id,field,focus=false){
    const row=this.model.rows.find((r)=>r.id===this.model.idOf(id)), column=this.model.board.columns.find((c)=>c.key===field);
    const td=this.root.querySelector(`tr[data-record-context="${CSS.escape(String(id))}"] td[data-column-key="${CSS.escape(field)}"]`);
    if(!row||!column||!td)return;
    td.outerHTML=this.view.cell(row,column,this.model); this.saveFeedback();
    this.view.play(this.root.querySelector(`tr[data-record-context="${CSS.escape(String(id))}"] td[data-column-key="${CSS.escape(field)}"]`),"just-changed");
    this.reapplyFlashes();
    if(focus)this.cellButton(id,field)?.focus();
  }
  refreshBoard(){
    const region=this.root.querySelector(".board-view-region"); if(!region||this.model.screen!=="board"){this.update();return;}
    const focus=this.focusedControl(), scroll=this.scrollState();
    const wasBusy=Boolean(region.querySelector('[aria-busy="true"]'));
    region.innerHTML=this.view.boardView(this.model);
    const busy=Boolean(region.querySelector('[aria-busy="true"]'));
    if(wasBusy&&!busy)this.view.play(region,"content-ready"); // records finished loading: fade them in
    if(this.view.motionKeys)this.view.motionKeys.busy=busy;
    this.refocus(focus); this.restoreScroll(scroll); this.trackRows(); this.view.fitBoard(); this.reapplyFlashes();
    const active=this.model.rows.filter((r)=>!r.archived).length, count=this.root.querySelector(".board-nav.selected .nav-count");
    if(count)count.textContent=active;
    this.root.querySelector('.board-actions [data-action="export"]')?.toggleAttribute("disabled",!this.model.rows.length);
    this.saveFeedback();
  }
  // ---- Files columns. Uploads run one request per file (XMLHttpRequest, for progress) and never touch the record, so
  // they can't overwrite anyone's edits. Each upload carries a key: retrying after a lost connection returns the
  // first result instead of storing the file twice. Colleagues' uploads and removals arrive as live events.
  static FILE_TYPES = Object.freeze({ pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" });
  fileTypeOf(file){const byType=Object.values(AppController.FILE_TYPES).includes(file.type)?file.type:"";const ext=String(file.name||"").split(".").pop().toLowerCase();return byType||(file.type&&!/octet-stream/.test(file.type)?"":AppController.FILE_TYPES[ext]||"");}
  filesPanelName(id,field){return `files-${this.model.serverId(id)}-${field}`;}
  filesCellKey(id,field){return `${this.model.serverId(id)}:${field}`;}
  filesState(id,field){return {uploads:this.uploads.get(this.filesCellKey(id,field))||[],confirm:this.filesConfirm?.cell===this.filesCellKey(id,field)?this.filesConfirm.id:null,notice:this.filesNotice?.cell===this.filesCellKey(id,field)?this.filesNotice.text:"",fresh:this.freshFiles};}
  openFiles(id,field){
    const row=this.model.rows.find((r)=>r.id===this.model.idOf(id)), column=this.model.board.columns.find((c)=>c.key===field);
    if(!row||!column)return;
    this.filesConfirm=null; this.filesOpen={id,field};
    return this.togglePanel(this.filesPanelName(id,field),()=>this.view.showFilesPanel(this.model,row,column,this.filesState(id,field)));
  }
  // Re-draws the panel if it is open for this cell (keeps it open), and the cell itself.
  refreshFiles(id,field,{open=false,focus=null}={}){
    const row=this.model.rows.find((r)=>String(this.model.serverId(r.id))===String(this.model.serverId(id))), column=this.model.board?.columns.find((c)=>c.key===field);
    if(!row||!column)return;
    this.patchCell(row.id,field,false);
    const root=document.querySelector("#overlay-root"), name=this.filesPanelName(id,field);
    if(root?.dataset.open===name||open){
      // Re-drawn in place: keep the panel where it was (the button that was clicked no longer exists to anchor it).
      const previous=document.querySelector(".files-popover"), place=previous?{left:previous.style.left,top:previous.style.top,right:previous.style.right}:null;
      if(!place)this.lastTrigger=this.cellButton(row.id,field)||this.lastTrigger;
      this.view.showFilesPanel(this.model,row,column,this.filesState(id,field));this.markPanel(name);
      const panel=document.querySelector(".files-popover");if(place&&panel)Object.assign(panel.style,place);
      if(focus)document.querySelector(`.files-popover ${focus}`)?.focus();
    }
  }
  addFiles(id,field,files){
    const column=this.model.board?.columns.find((c)=>c.key===field);
    if(!column||column.type!=="files"||!files.length)return;
    if(!this.model.filesAvailable()){this.view.toast("Files are stored on the JARC server. Sign in with Microsoft to add them.");return;}
    if(!this.model.storage.adapter.isSavedRecord(id)){this.view.toast("This record is still being saved. Add files in a moment.");return;}
    const cell=this.filesCellKey(id,field), list=this.uploads.get(cell)||[];
    let count=this.model.attachmentsFor(id,field).length+list.filter((u)=>u.state==="uploading").length;
    for(const file of files){
      const type=this.fileTypeOf(file);
      let error="";
      if(!type)error="Only PDF, JPEG, PNG and WebP files can be added.";
      else if(file.size>10*1024*1024)error=`Larger than 10 MB (${this.view.fileSize(file.size)}).`;
      else if(!file.size)error="This file is empty.";
      else if(count>=20)error="A cell can hold at most 20 files.";
      const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(12)),(b)=>b.toString(16).padStart(2,"0")).join("");
      const u={id:`up_${random()}`,key:random(),file,type,name:file.name||"file",size:file.size,progress:0,state:error?"failed":"uploading",error,retryable:!error};
      list.unshift(u);
      if(!error){count+=1;this.startUpload(id,field,u);}
    }
    this.uploads.set(cell,list);
    this.refreshFiles(id,field,{open:true});
  }
  startUpload(id,field,u){
    const cell=this.filesCellKey(id,field), adapter=this.model.storage.adapter;
    u.state="uploading";u.progress=0;u.error="";
    const blob=u.file.type===u.type?u.file:new Blob([u.file],{type:u.type});
    adapter.uploadAttachment(id,field,blob,{name:u.name,key:u.key,onProgress:(p)=>{u.progress=p;this.view.updateUploadProgress(u);}}).then((attachment)=>{
      this.model.addAttachment(attachment);
      this.uploads.set(cell,(this.uploads.get(cell)||[]).filter((x)=>x!==u));
      // Confirmed by the server: marked "Uploaded" in the open panel; a toast only when the panel is closed.
      this.freshFiles.add(attachment.id); setTimeout(()=>this.freshFiles.delete(attachment.id),4000);
      const open=document.querySelector("#overlay-root")?.dataset.open===this.filesPanelName(id,field);
      this.refreshFiles(id,field); this.saveFeedback();
      if(!open)this.view.toast(`Added ${u.name}`);
    },(failure)=>{
      u.state="failed";u.error=failure?.message||"The upload failed. Try again.";
      u.retryable=![400,404,413,415,507].includes(failure?.status)&&failure?.code!=="TOO_MANY_FILES";
      this.refreshFiles(id,field); this.saveFeedback();
      if(document.querySelector("#overlay-root")?.dataset.open!==this.filesPanelName(id,field))this.view.toast(`${u.name} wasn't uploaded. Open the cell to try again.`);
    });
  }
  async removeFile(id,field,fileId){
    const cell=this.filesCellKey(id,field);
    this.filesConfirm=null;
    try{await this.model.storage.adapter.deleteAttachment(fileId);}
    catch(error){if(error?.code!==StorageError.CODES.NOT_FOUND){this.filesNotice={cell,text:StorageError.describe(error).message||"The file couldn't be removed. Try again."};this.refreshFiles(id,field);return;}}
    const name=this.model.attachments.get(fileId)?.name||"file";
    this.model.removeAttachment(fileId);
    this.filesNotice=null;
    this.refreshFiles(id,field,{focus:'.file-pick input, [data-action="preview-file"]'});
    this.view.toast(`Removed ${name}`);
  }
  // Loads the open board's attachments once (resource mode, boards with a Files column).
  ensureAttachments(){
    const board=this.model.board, adapter=this.model.storage.adapter;
    if(!this.ready||this.model.screen!=="board"||!board||!this.model.filesAvailable()||!board.columns.some((c)=>c.type==="files"))return;
    const id=String(this.model.serverId(board.id));
    if(this.model.attachmentBoards.has(id)||!adapter.isSavedBoard(id))return;
    // Loading → shown in the Files cells and panel; a failure is shown (with Try again) instead of retrying on every render.
    this.model.attachmentBoards.add(id); this.model.attachmentLoading.add(id); this.model.attachmentErrors.delete(id);
    const startedAt=Date.now();
    const load=adapter.loadAttachments(id).then((items)=>{this.model.replaceBoardAttachments(id,items,startedAt);},()=>{this.model.attachmentErrors.add(id);}).finally(()=>{this.model.attachmentLoading.delete(id);this.attachmentLoads?.delete(id);this.refreshFilesCells();});
    (this.attachmentLoads||=new Map()).set(id,load);
  }
  // Redraws every Files cell on the open board, and the Files panel if one is open.
  refreshFilesCells(){
    if(this.model.screen!=="board"||!this.model.board)return;
    const columns=this.model.board.columns.filter((c)=>c.type==="files");
    for(const tr of this.root.querySelectorAll("tr[data-record-context]"))for(const c of columns){const td=tr.querySelector(`td[data-column-key="${CSS.escape(c.key)}"]`);if(td){const row=this.model.rows.find((r)=>String(r.id)===tr.dataset.recordContext);if(row)td.outerHTML=this.view.cell(row,c,this.model);}}
    if(this.filesOpen)this.refreshFiles(this.filesOpen.id,this.filesOpen.field);
  }
  // Live: a colleague added or removed a file → re-read that record's files and redraw its cells (and an open panel).
  async applyRemoteFiles(events){
    const adapter=this.model.storage.adapter;
    const records=[...new Set(events.filter((e)=>e.recordId&&this.model.attachmentBoards.has(String(e.boardId))).map((e)=>e.recordId))];
    for(const recordId of records){
      let items;
      // Answers for the same record can arrive out of order: only the latest request's answer is applied.
      const seq=(this.fileSeq.get(String(recordId))||0)+1; this.fileSeq.set(String(recordId),seq);
      try{items=await adapter.loadRecordAttachments(recordId);}catch{this.model.attachmentBoards.clear();continue;} // reloaded when the connection is back
      if(this.fileSeq.get(String(recordId))!==seq)continue;
      this.model.replaceRecordAttachments(recordId,items);
      if(this.model.screen!=="board"||!this.model.board)continue;
      for(const column of this.model.board.columns.filter((c)=>c.type==="files")){
        this.refreshFiles(recordId,column.key);
        this.flashCell(recordId,column.key);
      }
    }
  }
  // Drag and drop: onto a Files cell or the panel's drop area. Files dropped anywhere else never open in the tab.
  fileDropZone(event){return event.dataTransfer?.types&&[...event.dataTransfer.types].includes("Files")?event.target.closest?.('td.cell[data-type="files"], .file-drop'):null;}
  onFileDrag(event){
    if(!event.dataTransfer?.types||![...event.dataTransfer.types].includes("Files"))return;
    const zone=this.fileDropZone(event);
    event.preventDefault();
    if(event.type==="dragover"){event.dataTransfer.dropEffect=zone?"copy":"none";this.root.querySelectorAll(".is-drop-target").forEach((el)=>el!==zone&&el.classList.remove("is-drop-target"));zone?.classList.add("is-drop-target");return;}
    if(event.type==="dragleave"){if(zone&&!zone.contains(event.relatedTarget))zone.classList.remove("is-drop-target");return;}
    this.root.querySelectorAll(".is-drop-target").forEach((el)=>el.classList.remove("is-drop-target"));
    if(!zone)return;
    const [id,field]=zone.matches(".file-drop")?zone.dataset.dropCell.split(":"):[zone.querySelector(".cell-display")?.dataset.id,zone.dataset.columnKey];
    if(id&&field)this.addFiles(id,field,[...event.dataTransfer.files]);
  }
  // ---- Motion (Phase 4). New rows (yours, a colleague's, an undo) slide in once; rows confirmed deleted by the server
  // slide out before the table re-renders. Nothing waits for an animation before saving.
  trackRows(){
    const board=this.model.screen==="board"?this.model.board:null;
    if(!board){this.rowMemory=null;return;}
    const key=String(this.model.serverId(board.id)), ids=this.model.rows.map((r)=>String(r.id));
    if(!this.rowMemory||this.rowMemory.key!==key||this.model.boardLoadState().state!=="full"&&this.model.boardLoadState().state!=="partial"){this.rowMemory={key,ids:new Set(ids)};return;}
    const known=new Set([...this.rowMemory.ids].map((id)=>this.model.serverId(id)));
    const fresh=ids.filter((id)=>!known.has(this.model.serverId(id)));
    if(fresh.length&&fresh.length<=10)for(const id of fresh)this.view.play(this.root.querySelector(`tr[data-record-context="${CSS.escape(id)}"]`),"row-enter");
    this.rowMemory={key,ids:new Set(ids)};
  }
  // Resolves when the elements have finished leaving (at most ~220 ms; at once with reduced motion).
  animateOut(elements,className="row-exit"){
    const list=elements.filter(Boolean);
    if(!list.length||this.view.reducedMotion())return Promise.resolve();
    return new Promise((resolve)=>{let left=list.length;const done=()=>{left-=1;if(left<=0)resolve();};for(const el of list){el.classList.add(className);el.addEventListener("animationend",done,{once:true});}setTimeout(resolve,240);});
  }
  // File previews: a loading state until the image or PDF has loaded, and a clear message if an image can't be shown.
  watchPreview(){
    const body=document.querySelector("#overlay-root .file-preview-body"), media=body?.querySelector(".file-preview-image, .file-preview-frame");
    if(!media)return;
    const settle=(state)=>{if(!body.isConnected)return;body.dataset.previewState=state;body.classList.remove("is-loading");};
    if(media.matches("img")&&media.complete&&media.naturalWidth)return settle("ready");
    media.addEventListener("load",()=>settle(media.matches("img")&&!media.naturalWidth?"error":"ready"),{once:true});
    media.addEventListener("error",()=>settle("error"),{once:true});
  }
  activeUploads(){let n=0;for(const list of this.uploads?.values()||[])n+=list.filter((u)=>u.state==="uploading").length;return n;}
  // After a column is shown or hidden from the Display columns popover: redraw the table, the views bar and the toolbar,
  // keep the popover open (with its search text) and its keyboard focus.
  refreshViewChrome(){
    const picker=document.querySelector("#overlay-root .column-picker"), query=picker?.querySelector("[data-action=column-picker-search]")?.value||"", focusKey=document.activeElement?.dataset?.key, focusAll=document.activeElement?.dataset?.action==="column-toggle-all";
    this.refreshBoard();
    const tabs=this.root.querySelector(".view-tabs"); if(tabs)tabs.outerHTML=this.view.tabs(this.model);
    const tools=this.root.querySelector(".board-tools"); if(tools)tools.outerHTML=this.view.toolbar(this.model);
    if(picker){this.view.showColumnPicker(this.model,query);const back=focusAll?document.querySelector('#overlay-root [data-action="column-toggle-all"]'):focusKey?document.querySelector(`#overlay-root [data-action="column-toggle"][data-key="${CSS.escape(focusKey)}"]`):null;back?.focus();}
    this.view.fitBoard();
  }
  // ---- Global search (server part): debounced, only the latest query's answer is shown, failures are reported.
  serverSearchFor(value){const q=String(value||"").trim();return this.serverSearch&&this.serverSearch.q===q?this.serverSearch:null;}
  scheduleServerSearch(value,delay=250){
    clearTimeout(this.serverSearchTimer);
    const q=String(value||"").trim(), adapter=this.model.storage.adapter;
    if(!adapter.searchRecords||q.length<2||q.length>100){this.serverSearch=null;return;}
    if(this.serverSearch?.q===q&&this.serverSearch.status!=="error")return;
    this.serverSearch={q,status:"loading",items:[]};
    this.serverSearchTimer=setTimeout(async()=>{
      const seq=(this.serverSearchSeq=(this.serverSearchSeq||0)+1);
      let next;
      try{const res=await adapter.searchRecords(q,{limit:20});next={q,status:"done",items:res.items||[],more:Boolean(res.more),partial:Boolean(res.partial)};}
      catch(error){next={q,status:"error",items:[],message:error?.code==="RATE_LIMITED"?"Too many searches just now.":error?.code==="OFFLINE"?"You're offline, so other boards can't be searched.":"Couldn't search all boards."};}
      if(seq!==this.serverSearchSeq)return; // a newer search started meanwhile
      this.serverSearch=next;
      const input=document.querySelector(".command-modal [data-action=command-search]");
      if(input&&input.value.trim()===q)this.view.showCommandPalette(this.model,q,next);
    },delay);
    if(document.querySelector(".command-modal"))this.view.showCommandPalette(this.model,q,this.serverSearch);
  }
  // Opens a record found by search, also on a board not opened yet (waits for its records, then opens the record).
  async openSearchResult(boardId,workspaceId,recordId,title=""){
    this.view.closeOverlay();
    try{this.model.openBoard(boardId,workspaceId);}catch{this.view.toast("That board is no longer available.");return;}
    this.update();
    const find=()=>this.model.rows.find((r)=>String(r.id)===String(recordId)||String(this.model.serverId(r.id))===String(recordId));
    for(let i=0;i<100&&!find()&&["loading","none"].includes(this.model.boardLoadState().state);i+=1)await new Promise((r)=>setTimeout(r,100));
    const row=find();
    if(row){this.update();this.view.showRecordForm(this.model,row);return;}
    // Not among the records loaded here (e.g. a very large board): show the board searched for it instead.
    if(title){this.model.query=title;this.update();this.view.toast(`Showing records matching “${title}”`);}
  }
  // A colleague's change highlights its cell for 1.6 s. The highlight is remembered, so a redraw of the table in that
  // time (e.g. other live changes arriving) keeps showing it instead of wiping it.
  flashCell(id,field){
    (this.flashes ||= new Map()).set(`${id}|${field}`,Date.now()+1600);
    this.reapplyFlashes();
    setTimeout(()=>this.reapplyFlashes(),1650);
  }
  reapplyFlashes(){
    if(!this.flashes?.size)return;
    const now=Date.now();
    for(const [key,until] of this.flashes){
      const [id,field]=key.split("|"), td=this.root.querySelector(`tr[data-record-context="${CSS.escape(id)}"] td[data-column-key="${CSS.escape(field)}"]`);
      if(until<=now){this.flashes.delete(key);td?.classList.remove("remote-flash");continue;}
      td?.classList.add("remote-flash");
    }
  }
  // ---- Phase 6: undo / redo (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y outside text fields), cell ranges, copy / paste / clear.
  undoRedo(redo=false){
    if(this.busy)return;
    const label=redo?this.model.redo():this.model.undo();
    this.update();
    this.view.toast(label);
  }
  coord(cell){return cell?{id:cell.dataset.id,field:cell.dataset.field}:null;}
  // Visible grid order: rows as shown, columns as shown.
  gridOrder(){
    const trs=[...this.root.querySelectorAll(".editable-table tbody tr[data-record-context]")];
    return {rows:trs.map((tr)=>tr.dataset.recordContext),cols:[...(trs[0]?.querySelectorAll(".cell-display")||[])].map((c)=>c.dataset.field)};
  }
  clearRange(){this.cellRange=null;this.root.querySelectorAll(".cell-in-range").forEach((td)=>td.classList.remove("cell-in-range"));}
  // The selected rectangle: { rows: [ids], cols: [fields] } (just the focused cell when there is no range).
  rangeCells(focused){
    const {rows,cols}=this.gridOrder(), a=this.cellRange?.anchor||this.coord(focused), b=this.cellRange?.focus||a;
    if(!a)return {rows:[],cols:[]};
    const r=[rows.indexOf(String(a.id)),rows.indexOf(String(b.id))].sort((x,y)=>x-y), c=[cols.indexOf(a.field),cols.indexOf(b.field)].sort((x,y)=>x-y);
    if(r[0]<0||c[0]<0)return {rows:[],cols:[]};
    return {rows:rows.slice(r[0],r[1]+1),cols:cols.slice(c[0],c[1]+1)};
  }
  paintRange(){
    this.root.querySelectorAll(".cell-in-range").forEach((td)=>td.classList.remove("cell-in-range"));
    if(!this.cellRange?.focus)return;
    const {rows,cols}=this.rangeCells(null);
    for(const id of rows)for(const field of cols)this.root.querySelector(`tr[data-record-context="${CSS.escape(String(id))}"] td[data-column-key="${CSS.escape(field)}"]`)?.classList.add("cell-in-range");
  }
  extendRange(cell,key){
    const next=this.adjacentCell(cell,key);if(!next)return;
    if(!this.cellRange)this.cellRange={anchor:this.coord(cell)};
    this.cellRange.focus=this.coord(next);this.paintRange();this.extendingRange=true;next.focus();this.extendingRange=false;
  }
  focusedCell(){const el=document.activeElement;return el?.classList?.contains("cell-display")&&this.root.contains(el)?el:null;}
  onCopy(event){
    const cell=this.focusedCell();if(!cell||window.getSelection()?.toString())return;
    const {rows,cols}=this.rangeCells(cell);if(!rows.length)return;
    const columns=cols.map((f)=>this.model.board.columns.find((c)=>c.key===f)), byId=new Map(this.model.rows.map((r)=>[String(r.id),r]));
    const tsv=rows.map((id)=>columns.map((c)=>c?this.model.copyValue(byId.get(String(id)),c):"").join("\t")).join("\n");
    event.clipboardData.setData("text/plain",tsv);event.preventDefault();
    const n=rows.length*cols.length;this.view.toast(n===1?"Copied":`Copied ${n} cells`);
  }
  // Pasting: tab-separated text from JARC or a spreadsheet, from the focused cell (a single value fills a selected
  // range). Each value is checked against its column; invalid ones are skipped and reported. Replacing more than one
  // filled cell asks first. One undo step.
  onPaste(event){
    const cell=this.focusedCell();if(!cell||this.model.screen!=="board")return;
    const text=event.clipboardData?.getData("text/plain");if(typeof text!=="string")return;
    event.preventDefault();
    const grid=text.replace(/\r/g,"").replace(/\n$/,"").split("\n").map((line)=>line.split("\t"));
    const {rows,cols}=this.gridOrder(), range=this.rangeCells(cell), single=grid.length===1&&grid[0].length===1;
    const startRow=rows.indexOf(range.rows[0]), startCol=cols.indexOf(range.cols[0]);
    const targets=[];
    if(single&&this.cellRange?.focus){for(const id of range.rows)for(const field of range.cols)targets.push({id,field,text:grid[0][0]});}
    else grid.forEach((line,ri)=>line.forEach((value,ci)=>{const id=rows[startRow+ri],field=cols[startCol+ci];if(id!==undefined&&field!==undefined)targets.push({id,field,text:value});}));
    const byId=new Map(this.model.rows.map((r)=>[String(r.id),r])), changes=[];
    let skipped=0, overwrites=0;
    for(const t of targets){
      const row=byId.get(String(t.id)), column=this.model.board.columns.find((c)=>c.key===t.field);
      if(!row||!column){skipped+=1;continue;}
      const value=this.model.pasteValue(column,t.text);
      if(value===BoardModel.INVALID||(column.required&&!this.model.hasValue(value))){skipped+=1;continue;}
      if(JSON.stringify(row[t.field]??"")===JSON.stringify(value))continue;
      if(this.model.hasValue(row[t.field]))overwrites+=1;
      changes.push({id:row.id,field:t.field,value});
    }
    if(!changes.length){this.view.toast(skipped?`Nothing pasted: ${skipped} value${skipped===1?" doesn't":"s don't"} fit ${skipped===1?"its column":"their columns"}`:"Nothing to change");return;}
    this.pendingPaste={changes,skipped};
    if(overwrites>1){this.view.showConfirm(`Replace ${overwrites} filled cells?`,`Pasting changes ${changes.length} cell${changes.length===1?"":"s"}, including ${overwrites} that already have values. Undo is available afterwards.`,"confirm-paste","","Replace");return;}
    this.applyPaste();
  }
  applyPaste(){
    const pending=this.pendingPaste;this.pendingPaste=null;if(!pending)return;
    const n=this.model.updateCells(pending.changes,"Paste undone");
    this.update();
    this.view.toast(`Pasted ${n} cell${n===1?"":"s"}${pending.skipped?` · ${pending.skipped} skipped (not valid for ${pending.skipped===1?"its column":"those columns"})`:""}`,true);
  }
  // Delete / Backspace on a focused cell or range: empties the cells that can be emptied (not required ones, not
  // People/Files/Group). Undo is available.
  clearCells(cell){
    const {rows,cols}=this.rangeCells(cell), byId=new Map(this.model.rows.map((r)=>[String(r.id),r])), changes=[];
    for(const id of rows)for(const field of cols){
      const row=byId.get(String(id)), column=this.model.board.columns.find((c)=>c.key===field);
      if(!row||!column||column.required||["owner","files","group"].includes(column.type)||!this.model.hasValue(row[field]))continue;
      changes.push({id:row.id,field,value:column.type==="checkbox"?false:this.model.isMultiColumn(column)?[]:""});
    }
    if(!changes.length)return;
    const n=this.model.updateCells(changes,"Clear undone");
    this.update();
    this.view.toast(`Cleared ${n} cell${n===1?"":"s"}`,true);
  }
  // Row order is shared by the whole board, so rows are reordered in Main Table without a sort (never from a view).
  rowDragBlocked(){ if(this.model.activeView)return "Rows can be reordered in Main Table (row order is shared by every view)."; if(this.model.showArchived)return "Archived records can't be reordered."; if(this.model.sortKey&&!this.model.manualSort)return "Clear the sort to reorder rows by hand."; return ""; }
  openCell(button){
    const id=this.model.idOf(button.dataset.id), field=button.dataset.field, row=this.model.rows.find((r)=>r.id===id), column=this.model.board.columns.find((c)=>c.key===field);
    if(!row||!column)return;
    if(column.type==="checkbox"){this.model.updateCell(id,field,!row[field]);this.patchCell(id,field,true);return;}
    if(column.type==="files"){button.scrollIntoView({block:"nearest",inline:"nearest"});this.openFiles(id,field);return;}
    if(this.view.isChoiceColumn(column)){
      button.scrollIntoView({block:"nearest",inline:"nearest"});
      const needPeople=column.type==="owner"&&this.model.storage.adapter.loadPeople&&!this.model.peopleLoaded;
      const opened=this.togglePanel(`cell-${id}-${field}`,()=>this.view.showCellOptions(this.model,row,column,{loading:needPeople}));
      if(opened&&needPeople)this.loadPeople(true).then(()=>{if(this.root.querySelector(`.cell-options-popover[data-cell="${CSS.escape(`${id}:${field}`)}"]`)){this.view.showCellOptions(this.model,this.model.rows.find((r)=>r.id===id)||row,column);this.markPanel(`cell-${id}-${field}`);}});
      return;
    }
    this.openCellEditor(button.closest("td"),row,column);
  }
  openCellEditor(td,row,column,seed=null){
    if(!td)return;
    td.classList.add("is-editing"); td.innerHTML=this.view.cellInput(row,column);
    const input=td.querySelector(".cell-input"); input.focus();
    if(seed!==null)input.value=seed; else try{input.select();}catch{}
  }
  commitCell(input,move="stay"){
    if(input.dataset.done)return; input.dataset.done="1";
    const id=this.model.idOf(input.dataset.id), field=input.dataset.field, column=this.model.board.columns.find((c)=>c.key===field), value=input.value;
    let note="";
    if(column&&value!==input.dataset.original&&input.dataset.remoteValue!==undefined&&value!==input.dataset.remoteValue&&input.checkValidity()){
      this.patchCell(id,field,false); this.conflict={id,field,mine:value};
      const theirs=this.model.valueText(column,this.model.rows.find((r)=>r.id===id)?.[field]);
      this.view.showConfirm(`${input.dataset.remoteBy} changed ${column.label}`,`While you were editing, ${input.dataset.remoteBy} changed it to “${theirs||"empty"}”. Keep your value “${value}” instead? Cancel keeps ${input.dataset.remoteBy}’s value.`,"conflict-keep-mine","",`Keep mine`);
      this.conflictState=true; this.saveFeedback();
      return;
    }
    if(column&&value!==input.dataset.original){
      if(column.required&&!value.trim())note=`${column.label} can't be empty`;
      else if(!input.checkValidity())note=`${column.label} not saved: ${input.validationMessage}`;
      else this.model.updateCell(id,field,value);
    }
    this.patchCell(id,field,move!=="none");
    if(!note&&column?.type==="link"&&value.trim()&&value!==input.dataset.original&&!this.view.safeHref(value,"link"))note="Saved as text — only http, https, mailto and tel links can be opened.";
    if(note)this.view.toast(note);
    // A refused value: the cell briefly shows the problem where it happened (the toast carries the message).
    if(note&&!(column?.type==="link"&&!column.required&&input.checkValidity()))this.view.play(this.root.querySelector(`tr[data-record-context="${CSS.escape(String(id))}"] td[data-column-key="${CSS.escape(field)}"]`),"cell-rejected");
    if(move==="next"||move==="prev"){const cell=this.cellButton(id,field);(this.adjacentCell(cell,move==="next"?1:-1)||cell)?.focus();}
  }
  cancelCell(input){input.dataset.done="1";this.patchCell(this.model.idOf(input.dataset.id),input.dataset.field,true);}
  cellInputKey(event){
    const input=event.target;
    if(event.key==="Escape"){event.preventDefault();this.cancelCell(input);}
    else if(event.key==="Enter"&&!(input.tagName==="TEXTAREA"&&event.shiftKey)){event.preventDefault();this.commitCell(input,"stay");}
    else if(event.key==="Tab"){event.preventDefault();this.commitCell(input,event.shiftKey?"prev":"next");}
  }
  // Spreadsheet-style movement between cell buttons within one table. dir: 1 / -1 (reading order) or an arrow key.
  adjacentCell(cell,dir){
    if(!cell)return null;
    const tr=cell.closest("tr"), rows=[...cell.closest("tbody").querySelectorAll("tr[data-record-context]")], inRow=(r)=>[...r.querySelectorAll(".cell-display")];
    if(dir===1||dir===-1){const all=rows.flatMap(inRow);return all[all.indexOf(cell)+dir]||null;}
    const ci=inRow(tr).indexOf(cell), ri=rows.indexOf(tr);
    if(dir==="ArrowLeft")return inRow(tr)[ci-1]||null;
    if(dir==="ArrowRight")return inRow(tr)[ci+1]||null;
    const other=rows[ri+(dir==="ArrowUp"?-1:1)]; return other?inRow(other)[ci]||null:null;
  }
  cellKey(event){
    const cell=event.target, key=event.key; if(event.ctrlKey||event.metaKey||event.altKey)return false;
    if(event.shiftKey&&key.startsWith("Arrow")){event.preventDefault();this.extendRange(cell,key);return true;}
    if(key==="Delete"||key==="Backspace"){event.preventDefault();this.clearCells(cell);this.clearRange();return true;}
    if(key==="Escape"&&this.cellRange){this.clearRange();return true;}
    if(key==="Tab"){this.clearRange();const next=this.adjacentCell(cell,event.shiftKey?-1:1);if(next){event.preventDefault();next.focus();}return true;}
    if(key.startsWith("Arrow")){this.clearRange();const next=this.adjacentCell(cell,key);if(next){event.preventDefault();next.focus();}return true;}
    if(key==="F2"){event.preventDefault();cell.click();return true;}
    if(key.length===1&&key!==" "){
      // Typing on a focused text-like cell starts editing with that character; letter shortcuts stay quiet here.
      event.preventDefault();
      const row=this.model.rows.find((r)=>r.id===this.model.idOf(cell.dataset.id)), column=this.model.board.columns.find((c)=>c.key===cell.dataset.field);
      if(row&&column&&column.type!=="checkbox"&&!this.view.isChoiceColumn(column))this.openCellEditor(cell.closest("td"),row,column,key);
      return true;
    }
    return false;
  }
  // Inline add: a temporary draft row. Nothing is stored until a non-empty name is entered.
  startInlineAdd(trigger){
    const blocking=this.model.board.columns.some((c)=>c.key!=="serial"&&c.required&&c.type!=="checkbox"&&!this.model.hasValue(c.defaultValue));
    if(blocking){this.view.showRecordForm(this.model);return;} // other required fields need the full form
    const quick=trigger.closest("tr"); quick.parentElement.querySelector(".draft-row")?.remove();
    quick.insertAdjacentHTML("beforebegin",this.view.draftRow(this.model,trigger.dataset.group||""));
    quick.previousElementSibling.querySelector("input").focus();
  }
  commitDraft(input,{again=false,next=false}={}){
    if(input.dataset.done)return; input.dataset.done="1";
    const tr=input.closest("tr"), name=input.value.trim(), group=tr?.dataset.group||"";
    if(!name){tr?.remove();return;}
    const record={serial:name}; if(group&&this.model.board.groups.includes(group))record[this.model.groupField]=group;
    const saved=this.model.upsert(record); this.refreshBoard();
    if(again){const trigger=this.root.querySelector(`.quick-add-row [data-action="inline-add"][data-group="${CSS.escape(group)}"]`);if(trigger)this.startInlineAdd(trigger);}
    else if(next){const first=this.cellButton(saved.id,"serial"),following=this.adjacentCell(first,"ArrowRight");(following||first)?.focus();}
  }
  draftKey(event){
    const input=event.target;
    if(event.key==="Escape"){event.preventDefault();input.dataset.done="1";const tr=input.closest("tr"),trigger=tr.nextElementSibling?.querySelector('[data-action="inline-add"]');tr.remove();trigger?.focus();}
    else if(event.key==="Enter"){event.preventDefault();this.commitDraft(input,{again:true});}
    else if(event.key==="Tab"&&!event.shiftKey){event.preventDefault();this.commitDraft(input,{next:true});}
  }
  // Sorting from the column menu reuses model.sortKey/sortDirection. It leaves the board's saved manual order intact.
  applySort(key,direction){
    this.model.sortKey=key; this.model.sortDirection=direction||"desc";
    this.model.manualSort=key?false:Boolean(this.model.board.manualOrder);
    this.view.closeOverlay(); this.update();
  }
  // Drag a column header to reorder (mouse/pen). Touch and keyboard use Move left / Move right in the column menu.
  startColumnDrag(event){
    const th=event.target.closest('.editable-table th.is-movable[data-column-key]');
    if(!th||event.button!==0||event.pointerType==="touch"||event.target.closest("button,input,a"))return;
    const key=th.dataset.columnKey, table=th.closest("table"), wrap=table.closest(".table-wrap"), startX=event.clientX, startY=event.clientY;
    let active=false,ghost=null,target=null,position="before";
    const clear=()=>table.querySelectorAll(".col-drop-before,.col-drop-after").forEach((h)=>h.classList.remove("col-drop-before","col-drop-after"));
    const move=(e)=>{
      if(e.pointerId!==event.pointerId)return;
      if(!active&&Math.hypot(e.clientX-startX,e.clientY-startY)<6)return;
      e.preventDefault();
      if(!active){active=true;th.classList.add("col-dragging");document.body.classList.add("is-col-dragging");ghost=document.createElement("div");ghost.className="row-drag-preview";ghost.textContent=th.querySelector(".column-label")?.textContent||"Column";document.body.append(ghost);}
      ghost.style.left=Math.max(8,Math.min(e.clientX+14,innerWidth-250))+"px";ghost.style.top=Math.max(8,Math.min(e.clientY+12,innerHeight-50))+"px";
      clear();target=null;
      const bounds=wrap.getBoundingClientRect(); if(e.clientX>bounds.right-40)wrap.scrollLeft+=14; else if(e.clientX<bounds.left+40)wrap.scrollLeft-=14;
      const over=document.elementFromPoint(e.clientX,e.clientY)?.closest("th[data-column-key]");
      if(!over||over.closest("table")!==table||over===th)return;
      const r=over.getBoundingClientRect(); position=over.dataset.columnKey==="serial"||e.clientX>=r.left+r.width/2?"after":"before";
      target=over.dataset.columnKey; over.classList.add("col-drop-"+position);
    };
    const cleanup=()=>{clear();th.classList.remove("col-dragging");document.body.classList.remove("is-col-dragging");ghost?.remove();document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",up);document.removeEventListener("pointercancel",cleanup);document.removeEventListener("keydown",onKey,true);};
    const onKey=(e)=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();cleanup();}};
    const up=(e)=>{if(e.pointerId!==event.pointerId)return;const go=active&&target;cleanup();if(go&&this.model.moveColumnTo(key,target,position)){this.update();this.view.toast("Column moved",true);}};
    document.addEventListener("pointermove",move,{passive:false});document.addEventListener("pointerup",up);document.addEventListener("pointercancel",cleanup);document.addEventListener("keydown",onKey,true);
  }
  selectOverlayInput(selector){requestAnimationFrame(()=>{const input=this.root.querySelector(`#overlay-root ${selector}`);input?.focus();input?.select();});}
  // Change a column's type. Values that can't be kept are only cleared after an explicit confirmation.
  changeColumnType(key,type,confirmed=false,button=null){
    const column=this.model.board.columns.find((c)=>c.key===key), meta=this.model.columnType(type); if(!column||!meta)return;
    if(column.key==="serial"){this.view.showMessage("Type not changed","The primary column always stays text.");return;}
    const impact=this.model.typeChangeImpact(key,type);
    if(impact&&!confirmed){this.view.showConfirm(`Change "${column.label}" to ${meta.label}?`,`${impact} record${impact===1?" has a value":"s have values"} that can't be stored as ${meta.label}. ${impact===1?"It":"They"} will be cleared. You can undo this right afterwards.`,"confirm-change-type",`${key}|${type}`,"Change type");return;}
    const label=column.label; let result; this.runBusy(button,()=>{result=this.model.changeColumnType(key,type);},()=>{this.view.closeOverlay();this.update();
    if(result)this.view.toast(`${label} is now ${meta.label}${result.cleared?` · ${result.cleared} value${result.cleared===1?"":"s"} cleared`:""}`,true);});
  }
  // Save edited options. Removing options that records still use needs confirmation; renames carry values along.
  applyColumnOptions(confirmed=false,button=null){
    const pending=this.pendingOptions; if(!pending)return;
    const plan=this.model.optionsEditPlan(pending.key,pending.items);
    if(!plan||!plan.options.length){this.view.showMessage("Options not saved","Keep at least one option.");return;}
    if(plan.affected&&!confirmed){const used=plan.removed.filter((o)=>this.model.rows.some((r)=>r[pending.key]===o));this.view.showConfirm("Remove options in use?",`${plan.affected} record${plan.affected===1?" uses":"s use"} ${used.length===1?`"${used[0]}"`:"the removed options"}. Those values will be cleared. You can undo this right afterwards.`,"confirm-column-options","","Remove options");return;}
    let result; this.runBusy(button,()=>{result=this.model.editColumnOptions(pending.key,pending.items);},()=>{this.pendingOptions=null;this.view.closeOverlay();this.update();
    if(result)this.view.toast(`Options updated${result.cleared?` · ${result.cleared} value${result.cleared===1?"":"s"} cleared`:""}`,true);});
  }
}
// Startup recovery screen: shown when stored data can't be loaded. Nothing is deleted automatically; "Try again"
// re-runs loading in place.
function renderStartupRecovery(root, error, onRetry) {

  let raw=null; try { raw=window.jarcStorage.readRawState(); } catch {}
  root.innerHTML='<main class="startup-error" role="alert"><h1>JARC couldn\'t open your saved data</h1><p class="startup-error-message"></p><p>Nothing has been deleted. Download a copy of the stored data before trying anything else.</p><div class="startup-error-actions"><button type="button" class="button primary" data-recover="download">Download stored data</button><button type="button" class="button secondary" data-recover="reload">Try again</button><button type="button" class="button danger" data-recover="reset">Clear stored data…</button></div></main>';
  root.querySelector(".startup-error-message").textContent=error instanceof StorageError?error.message:"Something went wrong while loading JARC.";
  if(!raw)root.querySelector('[data-recover="download"]').disabled=true;
  if(["api","resource"].includes(window.jarcStorage?.adapter?.mode)){ // server data: nothing to download or clear from this browser
    root.querySelector("h1").textContent="JARC couldn't load your workspace";
    root.querySelector(".startup-error-message+p").textContent="Your data on the server has not been changed.";
    root.querySelectorAll('[data-recover="download"],[data-recover="reset"]').forEach((button)=>button.remove());
  }
  root.onclick=(event)=>{
    const action=event.target.closest("[data-recover]")?.dataset.recover;
    if(action==="download"&&raw){const url=URL.createObjectURL(new Blob([raw],{type:"application/json"})),link=document.createElement("a");link.href=url;link.download="jarc-stored-data-"+new Date().toISOString().slice(0,10)+".json";link.click();setTimeout(()=>URL.revokeObjectURL(url),500);}
    if(action==="reload")onRetry();
    if(action==="reset"&&confirm("Permanently delete the stored JARC data in this browser? Download it first if you might need it."))try{window.jarcStorage.clearState();location.reload();}catch{}
  };
}
try { new AppController(document.querySelector("#app")); } catch(error) { renderStartupRecovery(document.querySelector("#app"), error, () => location.reload()); }
