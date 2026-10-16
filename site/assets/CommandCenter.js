// Global Search & Command Center (Phase 14): Ctrl K (⌘ K on macOS) or the search control in the top bar. Loaded after
// AppView.js and before AppController.js.
//
//   local      workspaces, boards and column names this browser already lists (only what the server returned for
//              this person), and the records of boards loaded in this session — instant, nothing downloaded
//   server     records and Updates (comments) on every board this person may see: GET /api/v1/search/global, with
//              type / workspace / board / assignee / status / priority / date filters and "Show more" pages
//   actions    safe commands through the app's own controller (Home, My work, Settings, Appearance, views, Create
//              record in an editable board…); nothing here changes data without the normal form or confirmation
//   recents    recently visited destinations from the server (GET /me/recents): IDs on the person's own account,
//              resolved on every open so revoked or deleted items disappear. Never kept in browser storage, and no
//              search text is stored anywhere. Favorites are the existing starred boards.
// Every name, snippet and label is rendered escaped (AppView.escape / mark).
class CommandCenter {
  static TYPES = Object.freeze([["all", "All"], ["workspace", "Workspaces"], ["board", "Boards"], ["record", "Records"], ["comment", "Updates"]]);
  static FILTER_KEYS = Object.freeze(["workspaceId", "boardId", "assignee", "status", "priority", "from", "to"]);
  static VIEW_LABELS = Object.freeze({ table: "Table", list: "List", kanban: "Kanban board", calendar: "Calendar" });
  static isMac() { const p = (typeof navigator !== "undefined" && (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent)) || ""; return /mac|iphone|ipad/i.test(p); }
  static shortcutLabel() { return CommandCenter.isMac() ? "⌘ K" : "Ctrl K"; }

  constructor(controller) {
    this.c = controller;
    this.filters = this.emptyFilters();
    this.type = "all";
    this.panelOpen = false;
    this.server = null; // { key, status: "loading" | "done" | "error", groups, message }
    this.recents = null; // { status, items }
    this.seq = 0;
    this.epoch = 0; // advanced by reset(): answers that arrive after a sign-out are dropped
    this.lastVisit = "";
    this.returnFocus = null;
    controller.view.commandCenter = this;
    controller.view.showCommandPalette = (model, query = "") => this.open(query);
    this.trackVisits();
  }
  get model() { return this.c.model; }
  get view() { return this.c.view; }
  get adapter() { return this.model.storage?.adapter; }
  get remote() { return typeof this.adapter?.searchGlobal === "function"; }
  get isOpen() { return Boolean(document.querySelector("#overlay-root .command-modal")); }
  get input() { return document.querySelector(".command-modal [data-action=command-search]"); }
  get query() { return (this.input?.value || "").trim(); }
  emptyFilters() { return { workspaceId: "", boardId: "", assignee: "", status: "", priority: "", from: "", to: "" }; }
  get activeFilters() { return CommandCenter.FILTER_KEYS.filter((k) => this.filters[k]); }
  // Filters that only records have: with any of them, workspaces, boards and Updates are left out.
  get recordOnly() { return ["assignee", "status", "priority"].some((k) => this.filters[k]); }
  get narrowed() { return this.activeFilters.some((k) => !["workspaceId", "boardId"].includes(k)); }

  // ---- Opening and closing ----------------------------------------------------------------------------------
  open(query = "") {
    if (this.c.signedIn === false) return; // never over a sign-in screen or an expired-session gate
    if (!this.isOpen) {
      const active = document.activeElement;
      this.returnFocus = active && active !== document.body && !active.closest?.("#overlay-root") ? active : null;
      // The same control described, in case the page re-renders while the palette is open (e.g. data finished loading).
      this.returnSelector = this.returnFocus ? this.c.focusedControl?.() || null : null;
      this.view.overlay(this.shell(), "command-overlay");
      const input = this.input; if (input) { input.value = query; input.focus(); }
      if (this.remote) this.loadRecents();
    }
    this.render();
    if (this.query) this.scheduleServer(0);
  }
  toggle() { if (this.isOpen) this.close(); else this.open(); }
  // Sign-out, lock or an ended session: forget everything this person searched, saw or filtered, and ignore answers
  // still on their way (seq / epoch), so nothing of theirs reappears for whoever signs in next.
  reset() {
    clearTimeout(this.timer); clearTimeout(this.localTimer);
    this.seq += 1; this.epoch = (this.epoch || 0) + 1;
    this.server = null; this.recents = null; this.filters = this.emptyFilters(); this.type = "all"; this.panelOpen = false; this.lastVisit = ""; this.returnFocus = null; this.returnSelector = null;
    if (this.isOpen) this.view.closeOverlay();
  }
  close() { this.view.closeOverlay(); this.restoreFocus(); }
  // Back to where the person was (if it still exists), so keyboard users never lose their place.
  restoreFocus() {
    const el = this.returnFocus?.isConnected ? this.returnFocus : this.returnSelector ? this.c.root?.querySelector(this.returnSelector) : null;
    this.returnFocus = null; this.returnSelector = null;
    if (el && typeof el.focus === "function") el.focus({ preventScroll: true });
  }

  shell() {
    return `<div class="modal command-modal" role="dialog" aria-modal="true" aria-label="Search JARC"><div class="command-search">${icon("search")}<input data-action="command-search" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-label="Search JARC" placeholder="Search workspaces, boards, records and updates…" autocomplete="off" spellcheck="false" maxlength="100" autofocus aria-controls="command-results"><button class="icon-button" data-action="close-overlay" aria-label="Close search"><kbd>Esc</kbd></button></div>${this.remote ? `<div class="cc-filters" data-region="filters"></div>` : ""}<div class="command-results" id="command-results" role="listbox" aria-label="Results"></div><div class="command-hint"><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span><span class="command-status" role="status" aria-live="polite"></span><span class="command-scope">${this.remote ? "Searching all your boards" : "Records: boards opened this session"}</span></div></div>`;
  }

  // ---- Rendering --------------------------------------------------------------------------------------------
  render() {
    const modal = document.querySelector("#overlay-root .command-modal"); if (!modal) return;
    const filters = modal.querySelector("[data-region=filters]");
    if (filters) { const focused = document.activeElement?.closest?.("[data-region=filters]") ? document.activeElement.dataset.key || document.activeElement.dataset.type || document.activeElement.dataset.action : null; filters.innerHTML = this.filterBar(); if (focused) (filters.querySelector(`[data-key="${CSS.escape(focused)}"]`) || filters.querySelector(`[data-type="${CSS.escape(focused)}"]`) || filters.querySelector(`[data-action="${CSS.escape(focused)}"]`))?.focus(); }
    const { html, count } = this.results();
    modal.querySelector(".command-results").innerHTML = html;
    const status = modal.querySelector(".command-status"); if (status) status.textContent = this.query || this.activeFilters.length ? `${count} result${count === 1 ? "" : "s"}` : "";
    this.input?.removeAttribute("aria-activedescendant");
    // Result rows are options of the listbox; the input announces the highlighted one (aria-activedescendant).
    modal.querySelectorAll(".command-results button").forEach((b, i) => { b.id = `cc-option-${i}`; b.setAttribute("role", "option"); b.setAttribute("aria-selected", "false"); b.tabIndex = -1; });
  }
  // Called by the keyboard handler after ↑/↓ moved the highlight.
  highlight(button) {
    document.querySelectorAll(".command-results [role=option][aria-selected=true]").forEach((b) => b.setAttribute("aria-selected", "false"));
    button.setAttribute("aria-selected", "true");
    this.input?.setAttribute("aria-activedescendant", button.id);
  }

  filterBar() {
    const v = this.view, m = this.model, f = this.filters;
    const types = CommandCenter.TYPES.map(([t, label]) => `<button type="button" class="cc-chip ${this.type === t ? "is-on" : ""}" data-action="cc-type" data-type="${t}" aria-pressed="${this.type === t}">${label}</button>`).join("");
    const n = this.activeFilters.length;
    let html = `<div class="cc-filter-row" role="toolbar" aria-label="Result type and filters">${types}<button type="button" class="cc-chip cc-filter-toggle ${n ? "has-filters" : ""}" data-action="cc-toggle-filters" aria-expanded="${this.panelOpen}" aria-controls="cc-filter-panel">${icon("filter")} Filters${n ? ` <b>${n}</b>` : ""}</button></div>`;
    if (this.panelOpen) {
      const spaces = m.workspaces.filter((w) => !w.archived);
      const boards = spaces.filter((w) => !f.workspaceId || w.id === f.workspaceId).flatMap((w) => w.boards.filter((b) => !b.archived).map((b) => ({ b, w })));
      const scoped = boards.filter(({ b }) => !f.boardId || b.id === f.boardId).map(({ b }) => b);
      const labels = (type) => [...new Set(scoped.flatMap((b) => (b.columns || []).filter((c) => c.type === type).flatMap((c) => (m.effectiveOptions ? m.effectiveOptions(c) : c.options) || [])))].filter(Boolean).sort((a, b) => a.localeCompare(b));
      const hasPeople = scoped.some((b) => (b.columns || []).some((c) => c.type === "owner"));
      const select = (key, label, options, placeholder, disabled = false) => `<label class="cc-field"><span>${label}</span><select data-action="cc-filter" data-key="${key}" ${disabled ? "disabled" : ""}><option value="">${placeholder}</option>${options.map(([value, text]) => `<option value="${v.attr(value)}" ${f[key] === value ? "selected" : ""}>${v.escape(text)}</option>`).join("")}</select></label>`;
      const people = [...(m.people || new Map())].filter(([id]) => /^user:[0-9a-f]{24}$/.test(id)).map(([id, p]) => [id, p.isYou ? `${p.displayName} (you)` : p.displayName]).sort((a, b) => a[1].localeCompare(b[1]));
      const statuses = labels("status"), priorities = labels("priority");
      html += `<div class="cc-filter-panel" id="cc-filter-panel">${select("workspaceId", "Workspace", spaces.map((w) => [w.id, w.name]), "Any workspace")}${select("boardId", "Board", boards.map(({ b, w }) => [b.id, f.workspaceId ? b.name : `${b.name} · ${w.name}`]), "Any board")}${select("assignee", "Assignee", [["me", "Assigned to me"], ...people.filter(([, name]) => !/\(you\)$/.test(name))], "Anyone", !hasPeople)}${select("status", "Status", statuses.map((s) => [s, s]), "Any status", !statuses.length)}${select("priority", "Priority", priorities.map((s) => [s, s]), "Any priority", !priorities.length)}<label class="cc-field"><span>Updated from</span><input type="date" data-action="cc-filter" data-key="from" value="${v.attr(f.from)}" max="${v.attr(f.to || "")}"></label><label class="cc-field"><span>to</span><input type="date" data-action="cc-filter" data-key="to" value="${v.attr(f.to)}" min="${v.attr(f.from || "")}"></label></div>`;
    }
    if (n) {
      const name = (key) => {
        const value = f[key];
        if (key === "workspaceId") return `Workspace: ${m.workspaces.find((w) => w.id === value)?.name || "Unavailable"}`;
        if (key === "boardId") return `Board: ${m.workspaces.flatMap((w) => w.boards).find((b) => b.id === value)?.name || "Unavailable"}`;
        if (key === "assignee") return value === "me" ? "Assigned to me" : `Assignee: ${m.personName ? m.personName(value) : value}`;
        if (key === "from") return `From ${value}`;
        if (key === "to") return `To ${value}`;
        return `${key === "status" ? "Status" : "Priority"}: ${value}`;
      };
      html += `<div class="cc-active" aria-label="Active filters">${this.activeFilters.map((k) => `<button type="button" class="cc-active-chip" data-action="cc-remove-filter" data-key="${k}" aria-label="Remove filter ${v.attr(name(k))}">${v.escape(name(k))} ${icon("close")}</button>`).join("")}<button type="button" class="link-button cc-clear" data-action="cc-clear-filters">Clear filters</button></div>`;
    }
    return html;
  }

  results() {
    const v = this.view, m = this.model, q = this.query, ql = q.toLowerCase(), has = (t) => String(t ?? "").toLowerCase().includes(ql);
    const spaces = m.workspaces.filter((w) => !w.archived), groups = [];
    const item = (attrs, ic, title, context, extra = "") => `<button ${attrs}>${icon(ic)}<span><strong>${title}</strong>${context ? `<small>${context}</small>` : ""}</span>${extra}</button>`;
    const want = (t) => this.type === "all" || this.type === t;
    const searching = Boolean(q) || this.activeFilters.length > 0;
    const inScope = (w, b = null) => (!this.filters.workspaceId || w.id === this.filters.workspaceId) && (!b || !this.filters.boardId || b.id === this.filters.boardId);
    if (!searching) {
      groups.push(["Favorites", m.favoriteBoards ? m.favoriteBoards.slice(0, 6).map((b) => item(`data-action="palette-board" data-id="${v.attr(b.id)}" data-workspace="${v.attr(b.workspaceId)}"`, "star", v.escape(b.name), v.escape(b.workspaceName || ""))).join("") : ""]);
      groups.push(["Recent", this.recentHtml(item)]);
    } else {
      const nameOnly = !this.narrowed && Boolean(q);
      if (want("workspace") && nameOnly && !this.filters.boardId) groups.push(["Workspaces", spaces.filter((w) => inScope(w) && has(w.name)).slice(0, 6).map((w) => item(`data-action="palette-workspace" data-id="${v.attr(w.id)}"`, "layout", v.mark(w.name, q), `${w.boards.filter((b) => !b.archived).length} boards`)).join("")]);
      if (want("board") && nameOnly) groups.push(["Boards", spaces.flatMap((w) => w.boards.filter((b) => !b.archived && inScope(w, b) && has(b.name)).map((b) => item(`data-action="palette-board" data-id="${v.attr(b.id)}" data-workspace="${v.attr(w.id)}"`, "board", v.mark(b.name, q), v.escape(w.name), b.source?.readOnly ? `<span class="cc-badge">Read-only</span>` : ""))).slice(0, 10).join("")]);
      if (this.type === "all" && nameOnly) groups.push(["Columns", spaces.flatMap((w) => w.boards.filter((b) => !b.archived && inScope(w, b)).flatMap((b) => (b.columns || []).filter((c) => has(c.label)).map((c) => item(`data-action="palette-board" data-id="${v.attr(b.id)}" data-workspace="${v.attr(w.id)}"`, columnTypeIcons[c.type] || "text", v.mark(c.label, q), `Column · ${v.escape(b.name)} · ${v.escape(w.name)}`)))).slice(0, 8).join("")]);
      if (want("record")) groups.push(["Records", this.recordHtml(item, spaces, inScope)]);
      if (want("comment") && this.remote && !this.recordOnly) groups.push(["Updates", this.commentHtml(item)]);
    }
    const commands = (this.type === "all" && !this.activeFilters.length) ? this.commands().filter(([, t]) => !q || has(t)) : [];
    groups.push(["Actions", commands.map(([c, t, ic]) => `<button data-action="run-command" data-command="${v.attr(c)}">${icon(ic)}<span>${q ? v.mark(t, q) : v.escape(t)}</span></button>`).join("")]);
    const shown = groups.filter(([, html]) => html);
    const empty = this.serverState()?.status === "loading" ? "" : searching ? `<p class="quiet-empty search-empty">${q ? `No matches for “${v.escape(q)}”.` : "Nothing matches these filters."} ${this.activeFilters.length ? `<button type="button" class="link-button" data-action="cc-clear-filters">Clear filters</button>` : "Try a board, column or record name."}</p>` : "";
    const html = shown.map(([name, h]) => `<section role="group" aria-label="${name}"><h3>${name}${name === "Recent" && this.remote && this.recents?.items?.length ? `<button type="button" class="link-button cc-clear-history" data-action="cc-clear-recents">Clear history</button>` : ""}</h3>${h}</section>`).join("") || empty;
    return { html, count: shown.reduce((n, [, h]) => n + (h.match(/<button (?:data-action="palette|data-action="run-command)/g) || []).length, 0) };
  }

  recentHtml(item) {
    const v = this.view, m = this.model;
    if (this.remote) {
      if (!this.recents || this.recents.status === "loading") return `<p class="search-status" role="status"><span class="loading-spinner" aria-hidden="true"></span> Loading recent places…</p>`;
      if (this.recents.status === "error") return `<p class="search-status is-error">Recent places couldn't load. <button type="button" class="button secondary small" data-action="cc-retry-recents">Try again</button></p>`;
      return this.recents.items.map((it) => this.resultButton(item, it)).filter(Boolean).slice(0, 8).join("");
    }
    const boards = m.recentBoardItems.map((b) => item(`data-action="palette-board" data-id="${v.attr(b.id)}" data-workspace="${v.attr(b.workspaceId)}"`, "board", v.escape(b.name), v.escape(b.workspaceName)));
    const records = m.recentRecords.map((r) => m.allRecords.find((a) => a.id === r.id && a.boardId === r.boardId)).filter(Boolean).map((r) => item(`data-action="palette-record" data-id="${v.attr(r.id)}" data-board="${v.attr(r.boardId)}" data-workspace="${v.attr(r.workspaceId)}"`, "records", v.escape(r.serial), `${v.escape(r.boardName)} · ${v.escape(r.workspaceName || "")}`));
    return [...boards, ...records].join("");
  }

  // Where a server result lives in this browser's model (server IDs → the model's IDs). null: not listed here.
  place(serverBoardId, serverWorkspaceId) {
    const m = this.model;
    for (const w of m.workspaces) {
      if (w.archived) continue;
      if (!serverBoardId && String(m.serverId(w.id)) === String(serverWorkspaceId)) return { w, b: null };
      const b = serverBoardId && w.boards.find((x) => String(m.serverId(x.id)) === String(serverBoardId));
      if (b && !b.archived) return { w, b };
    }
    return null;
  }

  // A server result (record, comment, board or workspace) as a palette row. Context reads "Board · Workspace".
  resultButton(item, it) {
    const v = this.view, q = this.query;
    const place = this.place(it.target.boardId || null, it.target.workspaceId); if (!place) return "";
    const crumbs = place.b ? `${v.escape(place.b.name)} · ${v.escape(place.w.name)}` : "";
    const ro = it.meta?.readOnly ? `<span class="cc-badge">Read-only</span>` : "";
    if (it.type === "workspace") return item(`data-action="palette-workspace" data-id="${v.attr(place.w.id)}"`, "layout", v.mark(it.title, q), "Workspace");
    if (it.type === "board") return item(`data-action="palette-board" data-id="${v.attr(place.b.id)}" data-workspace="${v.attr(place.w.id)}"`, "board", v.mark(it.title, q), v.escape(place.w.name), ro);
    const badges = [it.meta?.status, it.meta?.priority].filter(Boolean).map((s) => `<span class="cc-badge">${v.escape(s)}</span>`).join("") + ro;
    if (it.type === "comment") return item(`data-action="palette-record" data-id="${v.attr(it.target.recordId)}" data-board="${v.attr(place.b.id)}" data-workspace="${v.attr(place.w.id)}" data-title="${v.attr(it.title)}" data-tab="updates" data-comment="${v.attr(it.target.commentId)}"`, "comment", v.mark(it.snippet || "", q), `Update by ${v.escape(it.meta?.author || "Unknown user")} on ${v.escape(it.title)} · ${crumbs}`);
    const context = `${it.field ? `${v.escape(it.field.label)}: ${v.mark(it.snippet || "", q)} · ` : ""}${crumbs}`;
    return item(`data-action="palette-record" data-id="${v.attr(it.target.recordId)}" data-board="${v.attr(place.b.id)}" data-workspace="${v.attr(place.w.id)}" data-title="${v.attr(it.title)}"`, "records", it.field ? v.escape(it.title) : v.mark(it.title, q), context, badges ? `<span class="cc-badges">${badges}</span>` : "");
  }

  recordHtml(item, spaces, inScope) {
    const v = this.view, m = this.model, q = this.query, ql = q.toLowerCase(), has = (t) => String(t ?? "").toLowerCase().includes(ql);
    const hits = [], shown = new Set();
    // Records already in this browser (boards opened this session): only for a plain text search.
    if (q && !this.narrowed) {
      for (const w of spaces) for (const b of w.boards) {
        if (b.archived || !inScope(w, b)) continue;
        const cols = (b.columns || []).filter((c) => c.type !== "files" && c.type !== "checkbox");
        for (const r of b.records || []) {
          if (r.archived || hits.length >= 20) continue;
          let hit = null;
          for (const c of cols) { const val = r[c.key]; const text = Array.isArray(val) ? val.map((x) => (m.personName ? m.personName(x) : x)).join(", ") : val; if (text !== undefined && text !== null && text !== "" && has(text)) { hit = { c, text: String(text) }; break; } }
          if (!hit) continue;
          const name = r.serial || r[cols[0]?.key] || "Record";
          const context = hit.c.key === "serial" ? `${v.escape(b.name)} · ${v.escape(w.name)}` : `${v.escape(hit.c.label)}: ${v.mark(hit.text.length > 80 ? hit.text.slice(0, 80) + "…" : hit.text, q)} · ${v.escape(b.name)} · ${v.escape(w.name)}`;
          shown.add(String(m.serverId(r.id)));
          hits.push(item(`data-action="palette-record" data-id="${v.attr(r.id)}" data-board="${v.attr(b.id)}" data-workspace="${v.attr(w.id)}"`, "records", hit.c.key === "serial" ? v.mark(name, q) : v.escape(name), context));
        }
      }
    }
    const live = this.serverState(), group = live?.status === "done" ? live.groups.record : null;
    if (group) for (const it of group.items) { if (shown.has(it.id)) continue; const html = this.resultButton(item, it); if (html) { shown.add(it.id); hits.push(html); } }
    return hits.join("") + this.statusHtml(live, group, "record");
  }

  commentHtml(item) {
    const live = this.serverState(), group = live?.status === "done" ? live.groups.comment : null;
    const seen = new Set();
    const rows = (group?.items || []).filter((it) => !seen.has(it.id) && seen.add(it.id)).map((it) => this.resultButton(item, it)).join("");
    return rows + (this.type === "comment" || rows ? this.statusHtml(live, group, "comment") : "");
  }

  statusHtml(live, group, type) {
    if (!this.remote || !live) return "";
    if (live.status === "loading") return type === "record" || this.type === type ? `<p class="search-status" role="status"><span class="loading-spinner" aria-hidden="true"></span> Searching all boards…</p>` : "";
    if (live.status === "error") return type === "record" || this.type === type ? `<p class="search-status is-error" role="alert">${this.view.escape(live.message || "Couldn't search all boards.")}${type === "record" && !this.narrowed ? " Showing matches from boards opened here." : ""} <button type="button" class="button secondary small" data-action="search-retry">Try again</button></p>` : "";
    if (group?.loadingMore) return `<p class="search-status" role="status"><span class="loading-spinner" aria-hidden="true"></span> Loading more…</p>`;
    if (group?.moreError) return `<p class="search-status is-error" role="alert">More results couldn't load. <button type="button" class="button secondary small" data-action="cc-more" data-type="${type}">Try again</button></p>`;
    if (group?.next) return `<button type="button" class="cc-more" data-action="cc-more" data-type="${type}">${icon("chevron")}<span>Show more ${type === "record" ? "records" : "updates"}</span></button>`;
    if (group?.more || (type === "record" && live.partial)) return `<p class="search-status">More matches exist. Type more to narrow the search.</p>`;
    return "";
  }

  // ---- Quick actions: only what can be done here, through the app's own commands ---------------------------------
  commands() {
    const m = this.model, board = m.screen === "board" ? m.board : null, list = [];
    const editable = (b) => Boolean(b) && !b.archived && !b.source?.readOnly && m.workspace?.role !== "VIEWER";
    list.push(["home", "Go to Home", "home"], ["mywork", "Open My work", "work"]);
    if (board && editable(board)) list.push(["new-record", `Create record in ${board.name}`, "plus"], ["import", `Import into ${board.name}`, "import"]);
    else if (!board) list.push(["new-record", "Create record", "plus"], ["import", "Import data", "import"]);
    if (m.workspace?.role !== "VIEWER") list.push(["new-board", "Create board", "board"]);
    if (board) {
      const active = m.activeView;
      for (const [t, label] of Object.entries(CommandCenter.VIEW_LABELS)) if (t !== m.currentView || active || m.showArchived) list.push([`view:${t}`, `Switch to ${label} view`, t === "kanban" ? "board" : t === "table" ? "layout" : t]);
      for (const sv of (board.savedViews || []).slice(0, 8)) if (!active || String(active.id) !== String(sv.id)) list.push([`saved-view:${sv.id}`, `Open view “${sv.name}”`, "layout"]);
    }
    list.push(["settings", "Open Settings", "settings"], ["appearance", "Open Appearance settings", "sun"], ["theme", "Toggle light / dark theme", "sun"], ["notifications", "Notifications", "bell"], ["shortcuts", "Keyboard shortcuts", "command"]);
    return list.sort((a, b) => { const ai = m.recentCommands.indexOf(a[0]), bi = m.recentCommands.indexOf(b[0]); return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi); });
  }

  // ---- Server search ------------------------------------------------------------------------------------------
  key() { return JSON.stringify([this.query, this.type, this.filters]); }
  serverState() { const s = this.server; return s && s.key === this.key() ? s : null; }
  params({ type = null, cursor = null } = {}) {
    const m = this.model, f = this.filters, p = new URLSearchParams();
    if (this.query) p.set("q", this.query);
    p.set("type", type || (this.type === "record" || this.type === "comment" ? this.type : this.recordOnly ? "record" : "record,comment"));
    const serverOf = (id) => { const s = String(m.serverId(id)); return /^[0-9a-f]{24}$/.test(s) ? s : null; };
    if (f.workspaceId && serverOf(f.workspaceId)) p.set("workspaceId", serverOf(f.workspaceId));
    if (f.boardId && serverOf(f.boardId)) p.set("boardId", serverOf(f.boardId));
    for (const k of ["assignee", "status", "priority", "from", "to"]) if (f[k]) p.set(k, f[k]);
    if (cursor) p.set("cursor", cursor);
    return p;
  }
  // Debounced; only the latest question's answer is shown. Workspaces and boards alone are answered locally.
  scheduleServer(delay = 250) {
    clearTimeout(this.timer);
    const q = this.query, key = this.key();
    const needed = this.remote && (this.type === "all" || this.type === "record" || this.type === "comment") && ((q.length >= 2 && q.length <= 100) || this.narrowed);
    if (!needed) { this.server = null; this.render(); return; }
    if (this.server?.key === key && this.server.status !== "error") return;
    this.server = { key, status: "loading", groups: {} };
    this.render();
    this.timer = setTimeout(async () => {
      const seq = ++this.seq;
      let next;
      try {
        const res = await this.adapter.searchGlobal(this.params());
        next = { key, status: "done", groups: Object.fromEntries((res.groups || []).map((g) => [g.type, { ...g, items: [...g.items] }])), partial: Boolean(res.partial) };
      } catch (error) { next = { key, status: "error", groups: {}, message: this.errorText(error) }; }
      if (seq !== this.seq) return; // a newer search started meanwhile
      this.server = next;
      if (this.isOpen && this.key() === key) this.render();
    }, delay);
  }
  errorText(error) { return error?.code === "RATE_LIMITED" ? "Too many searches just now." : error?.code === "OFFLINE" ? "You're offline, so other boards can't be searched." : error?.code === "SEARCH_TIMEOUT" ? "That search took too long. Add a word or a filter." : error?.code === "VALIDATION_ERROR" ? (error.message || "That search isn't valid.") : "Couldn't search all boards."; }
  async more(type) {
    const live = this.serverState(), group = live?.groups?.[type]; if (!group?.next || group.loadingMore) return;
    group.loadingMore = true; group.moreError = false; this.render();
    const epoch = this.epoch;
    try {
      const res = await this.adapter.searchGlobal(this.params({ type, cursor: group.next }));
      if (epoch !== this.epoch) return; // signed out meanwhile: this.server was dropped
      const page = (res.groups || []).find((g) => g.type === type) || { items: [], next: null, more: false };
      group.items.push(...page.items); group.next = page.next; group.more = page.more;
    } catch { if (epoch !== this.epoch) return; group.moreError = true; }
    group.loadingMore = false;
    if (this.isOpen) { this.render(); document.querySelector(".command-results .cc-more, .command-results [data-action=cc-more]")?.focus?.(); }
  }

  // ---- Recents ------------------------------------------------------------------------------------------------
  async loadRecents() {
    const epoch = this.epoch;
    this.recents = { status: "loading", items: [] };
    let next;
    try { const res = await this.adapter.request("GET", "/me/recents"); next = { status: "done", items: res.items || [] }; }
    catch { next = { status: "error", items: [] }; }
    if (epoch !== this.epoch) return; // signed out meanwhile
    this.recents = next;
    if (this.isOpen && !this.query && !this.activeFilters.length) this.render();
  }
  // Records a visit (resource mode): the server keeps only IDs the person can open. Failures are ignored.
  visit(type, id) {
    if (!this.remote) return;
    const sid = String(this.model.serverId(id)); if (!/^[0-9a-f]{24}$/.test(sid)) return;
    const ref = `${type}:${sid}`; if (ref === this.lastVisit) return;
    this.lastVisit = ref; this.recents = null;
    this.adapter.request("POST", "/me/recents", { ref }).catch(() => {});
  }
  trackVisits() {
    const m = this.model, cc = this;
    const openBoard = m.openBoard.bind(m), switchWorkspace = m.switchWorkspace.bind(m), rememberRecord = m.rememberRecord.bind(m);
    m.openBoard = function (boardId, workspaceId) { const r = openBoard(boardId, workspaceId); cc.visit("board", m.currentBoardId); return r; };
    m.switchWorkspace = function (id) { const r = switchWorkspace(id); if (m.currentWorkspaceId === m.idOf(id)) cc.visit("workspace", m.currentWorkspaceId); return r; };
    m.rememberRecord = function (row) { const r = rememberRecord(row); if (row?.id) cc.visit("record", row.id); return r; };
  }

  // ---- Events from AppController ----------------------------------------------------------------------------------
  onInput(value) {
    clearTimeout(this.localTimer);
    this.localTimer = setTimeout(() => { if (this.isOpen) this.render(); }, 90);
    this.scheduleServer();
  }
  onAction(action, target) {
    if (action === "cc-type") { this.type = target.dataset.type; this.server = null; this.render(); this.scheduleServer(0); return; }
    if (action === "cc-toggle-filters") { this.panelOpen = !this.panelOpen; this.render(); document.querySelector("[data-action=cc-toggle-filters]")?.focus(); return; }
    if (action === "cc-remove-filter") { this.setFilter(target.dataset.key, ""); this.input?.focus(); return; }
    if (action === "cc-clear-filters") { this.filters = this.emptyFilters(); this.type = "all"; this.server = null; this.render(); this.scheduleServer(0); this.input?.focus(); return; }
    if (action === "cc-more") { this.more(target.dataset.type); return; }
    if (action === "cc-retry-recents") { this.loadRecents(); this.render(); return; }
    if (action === "cc-clear-recents") { this.adapter.request("DELETE", "/me/recents").then(() => { this.recents = { status: "done", items: [] }; this.lastVisit = ""; this.render(); this.view.toast("Recent history cleared"); }, () => this.view.toast("History couldn't be cleared. Try again.")); return; }
  }
  onFilterChange(target) { this.setFilter(target.dataset.key, target.value); }
  setFilter(key, value) {
    if (!CommandCenter.FILTER_KEYS.includes(key)) return;
    this.filters[key] = String(value || "");
    if (key === "workspaceId" && this.filters.boardId) { const ok = this.model.workspaces.find((w) => w.id === value)?.boards.some((b) => b.id === this.filters.boardId); if (value && !ok) this.filters.boardId = ""; }
    if (key === "boardId" && value) { const w = this.model.workspaces.find((x) => x.boards.some((b) => b.id === value)); if (w) this.filters.workspaceId = w.id; }
    if (this.recordOnly && (this.type === "workspace" || this.type === "board" || this.type === "comment")) this.type = "all";
    this.server = null; this.render(); this.scheduleServer(0);
  }
  retry() { this.server = null; this.scheduleServer(0); }
}
