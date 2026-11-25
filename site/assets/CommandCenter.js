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
  // Server search limits: q is sent only from 2 characters; successful answers are kept briefly in memory (never
  // errors, never in browser storage); a failed question isn't asked again on its own for FAILURE_MS; after a costly
  // failure (timeout, engine unavailable, too many searches) Try again waits 5 s, then 10 s, 20 s, 30 s.
  static MIN_QUERY = 2;
  static CACHE_SIZE = 20;
  static CACHE_MS = 60000;
  static FAILURE_MS = 30000;
  static BACKOFF_MS = Object.freeze([5000, 10000, 20000, 30000]);
  static isMac() { const p = (typeof navigator !== "undefined" && (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent)) || ""; return /mac|iphone|ipad/i.test(p); }
  static shortcutLabel() { return CommandCenter.isMac() ? "⌘ K" : "Ctrl K"; }

  constructor(controller) {
    this.c = controller;
    this.filters = this.emptyFilters();
    this.type = "all";
    this.panelOpen = false;
    this.server = null; // { key, status: "loading" | "done" | "error", groups, message }
    this.recents = null; // { status, items }
    this.seq = 0; // advanced whenever the question shown changes, so an older answer never replaces a newer state
    this.cache = new Map(); // key → { at, state }: the last CACHE_SIZE successful answers (oldest first)
    this.failures = new Map(); // key → { at, attempts, state }: recent failures, never sent again on their own
    this.inflight = new Map(); // key → Promise: one request per question at a time
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
  get query() { return (this.input?.value || "").replace(/\s+/g, " ").trim(); }
  // What the server is asked: nothing under 2 characters (it would answer 400).
  get serverQuery() { const q = this.query; return q.length >= CommandCenter.MIN_QUERY ? q : ""; }
  now() { return Date.now(); }
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
    clearTimeout(this.timer); clearTimeout(this.localTimer); clearTimeout(this.retryTimer);
    this.cache.clear(); this.failures.clear(); this.inflight.clear();
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
    const status = modal.querySelector(".command-status"); if (status) status.textContent = this.query || this.activeFilters.length ? this.countText(count) : "";
    this.input?.removeAttribute("aria-activedescendant");
    // Result rows are options of the listbox; the input announces the highlighted one (aria-activedescendant).
    modal.querySelectorAll(".command-results button").forEach((b, i) => { b.id = `cc-option-${i}`; b.setAttribute("role", "option"); b.setAttribute("aria-selected", "false"); b.tabIndex = -1; });
  }
  // The footer count never reads as complete when it isn't: "10+ results" when more exist, "from open boards" when
  // only this browser's boards could be searched.
  countText(count) {
    const live = this.serverState(), n = `${count} result${count === 1 ? "" : "s"}`;
    if (live?.status === "error") return `${n} from open boards`;
    if (live?.status === "done" && (live.partial || Object.values(live.groups).some((g) => g.next || g.more))) return `${count}+ results`;
    return n;
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

  // When all-board search failed, what this browser can still show: "text" (a plain search of open boards), "filters"
  // (status / priority / assignee checked on open boards) or "unavailable" (date filters can't be checked here).
  fallbackMode() {
    if (!this.narrowed) return "text";
    if (this.filters.from || this.filters.to || (this.filters.assignee === "me" && !this.myRef())) return "unavailable";
    return "filters";
  }
  myRef() { return [...(this.model.people || new Map())].find(([, p]) => p?.isYou)?.[0] || null; }

  recordHtml(item, spaces, inScope) {
    const v = this.view, m = this.model, f = this.filters;
    const live = this.serverState(), failed = this.remote && live?.status === "error", mode = failed ? this.fallbackMode() : null;
    // With record filters, the text is matched only as the server would (2 characters or more).
    const filtering = this.narrowed, q = filtering ? this.serverQuery : this.query, ql = q.toLowerCase(), has = (t) => String(t ?? "").toLowerCase().includes(ql);
    const hits = [], shown = new Set();
    // Records already in this browser (boards opened this session): for a plain text search, and as the fallback for
    // record filters when all-board search failed.
    if ((q && !filtering) || mode === "filters") {
      const who = f.assignee === "me" ? this.myRef() : f.assignee;
      for (const w of spaces) for (const b of w.boards) {
        if (b.archived || !inScope(w, b)) continue;
        const cols = (b.columns || []).filter((c) => c.type !== "files" && c.type !== "checkbox");
        const typed = (t) => (b.columns || []).filter((c) => c.type === t);
        const statusCols = typed("status"), priorityCols = typed("priority"), ownerCols = typed("owner");
        if (filtering && ((f.status && !statusCols.length) || (f.priority && !priorityCols.length) || (f.assignee && !ownerCols.length))) continue;
        for (const r of b.records || []) {
          if (r.archived || hits.length >= 20) continue;
          if (filtering) {
            if (f.status && !statusCols.some((c) => r[c.key] === f.status)) continue;
            if (f.priority && !priorityCols.some((c) => r[c.key] === f.priority)) continue;
            if (f.assignee && !ownerCols.some((c) => (Array.isArray(r[c.key]) ? r[c.key].includes(who) : r[c.key] === who))) continue;
          }
          let hit = null;
          if (!q) hit = { c: { key: "serial" }, text: "" };
          else for (const c of cols) { const val = r[c.key]; const text = Array.isArray(val) ? val.map((x) => (m.personName ? m.personName(x) : x)).join(", ") : val; if (text !== undefined && text !== null && text !== "" && has(text)) { hit = { c, text: String(text) }; break; } }
          if (!hit) continue;
          const name = r.serial || r[cols[0]?.key] || "Record";
          const context = hit.c.key === "serial" ? `${v.escape(b.name)} · ${v.escape(w.name)}` : `${v.escape(hit.c.label)}: ${v.mark(hit.text.length > 80 ? hit.text.slice(0, 80) + "…" : hit.text, q)} · ${v.escape(b.name)} · ${v.escape(w.name)}`;
          shown.add(String(m.serverId(r.id)));
          hits.push(item(`data-action="palette-record" data-id="${v.attr(r.id)}" data-board="${v.attr(b.id)}" data-workspace="${v.attr(w.id)}"`, "records", hit.c.key === "serial" && q ? v.mark(name, q) : v.escape(name), context));
        }
      }
    }
    const group = live?.status === "done" ? live.groups.record : null;
    if (group) for (const it of group.items) { if (shown.has(it.id)) continue; const html = this.resultButton(item, it); if (html) { shown.add(it.id); hits.push(html); } }
    // Never an answer that looks complete: open-board matches are labelled partial, even when there are none.
    const partial = failed && mode !== "unavailable" ? `<p class="search-status cc-partial" role="note">Partial results — only boards you have open.${hits.length ? "" : " No matches on those boards."}</p>` : "";
    return partial + hits.join("") + this.statusHtml(live, group, "record");
  }

  commentHtml(item) {
    const live = this.serverState(), group = live?.status === "done" ? live.groups.comment : null;
    const seen = new Set();
    const rows = (group?.items || []).filter((it) => !seen.has(it.id) && seen.add(it.id)).map((it) => this.resultButton(item, it)).join("");
    return rows + (this.type === "comment" || rows || group?.partial ? this.statusHtml(live, group, "comment") : "");
  }

  statusHtml(live, group, type) {
    if (!this.remote || !live) return "";
    if (live.status === "loading") return type === "record" || this.type === type ? `<p class="search-status" role="status"><span class="loading-spinner" aria-hidden="true"></span> Searching all boards…</p>` : "";
    if (live.status === "error") {
      if (type !== "record" && this.type !== type) return "";
      const mode = type === "record" ? this.fallbackMode() : null;
      const note = mode === "unavailable" ? " Filtered results are unavailable right now." : mode ? " Showing matches from open boards." : "";
      return `<p class="search-status is-error" role="alert">${this.view.escape(live.message || "Couldn't search all boards.")}${note} ${this.retryButton(live)}</p>`;
    }
    if (group?.loadingMore) return `<p class="search-status" role="status"><span class="loading-spinner" aria-hidden="true"></span> Loading more…</p>`;
    if (group?.moreError) return `<p class="search-status is-error" role="alert">More results couldn't load. <button type="button" class="button secondary small" data-action="cc-more" data-type="${type}">Try again</button></p>`;
    // Why an answer may be incomplete (partialReasons / a group's reason; an older server sends only partial).
    const reasons = Array.isArray(live.partialReasons) ? live.partialReasons : null;
    const notes = [];
    if (group?.partial && group.reason === "time_budget") notes.push("Some results may be missing — the search took too long.");
    if (group?.partial && group.reason === "candidate_cap") notes.push("Some matches weren't checked yet — Show more continues the search.");
    if (type === "record" && reasons?.includes("board_cap")) notes.push(`Searched the first ${Number(live.maxBoards) || 300} boards. Choose a workspace or board to search the rest.`);
    const note = notes.length ? `<p class="search-status">${this.view.escape(notes.join(" "))}</p>` : "";
    if (group?.next) return `${note}<button type="button" class="cc-more" data-action="cc-more" data-type="${type}">${icon("chevron")}<span>Show more ${type === "record" ? "records" : "updates"}</span></button>`;
    if (group?.more || (type === "record" && live.partial && !reasons)) return `${note}<p class="search-status">More matches exist. Type more to narrow the search.</p>`;
    return note;
  }

  // Try again: never for a question the server can't accept; disabled while a back-off runs (re-enabled by a render).
  retryButton(live) {
    if (live.retryable === false) return "";
    const wait = (live.retryAt || 0) > this.now();
    return `<button type="button" class="button secondary small" data-action="search-retry"${wait ? ` disabled aria-disabled="true" title="Available again in a few seconds"` : ""}>${wait ? "Try again shortly" : "Try again"}</button>`;
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
  // The signed-in user is part of the key (a second safeguard besides reset()): a cached answer never serves another user.
  key() { return JSON.stringify([this.c?.auth?.userId ?? null, this.serverQuery, this.type, this.filters]); }
  serverState() { const s = this.server; return s && s.key === this.key() ? s : null; }
  params({ type = null, cursor = null } = {}) {
    const m = this.model, f = this.filters, p = new URLSearchParams();
    if (this.serverQuery) p.set("q", this.serverQuery);
    p.set("type", type || (this.type === "record" || this.type === "comment" ? this.type : this.recordOnly ? "record" : "record,comment"));
    const serverOf = (id) => { const s = String(m.serverId(id)); return /^[0-9a-f]{24}$/.test(s) ? s : null; };
    if (f.workspaceId && serverOf(f.workspaceId)) p.set("workspaceId", serverOf(f.workspaceId));
    if (f.boardId && serverOf(f.boardId)) p.set("boardId", serverOf(f.boardId));
    for (const k of ["assignee", "status", "priority", "from", "to"]) if (f[k]) p.set(k, f[k]);
    if (cursor) p.set("cursor", cursor);
    return p;
  }
  // Debounced; only the latest question's answer is shown. Workspaces and boards alone are answered locally.
  // The same question (same text after trimming, type and filters) is never sent again on its own: an answer shown,
  // loading, cached or recently failed is reused; only Try again (force) asks again after a failure. ApiAdapter.send
  // takes no outside AbortSignal, so a superseded request finishes in the background: its answer is cached (or its
  // failure remembered) but never shown over a newer question (seq, advanced here rather than when the timer fires).
  scheduleServer(delay = 250, { force = false } = {}) {
    const q = this.serverQuery, key = this.key();
    const needed = this.remote && (this.type === "all" || this.type === "record" || this.type === "comment") && ((q.length >= CommandCenter.MIN_QUERY && q.length <= 100) || this.narrowed);
    if (!needed) { clearTimeout(this.timer); this.seq += 1; this.server = null; this.render(); return; }
    if (!force && this.server?.key === key && (this.server.status !== "error" || this.failure(key))) return;
    clearTimeout(this.timer);
    const seq = ++this.seq;
    const cached = force ? null : this.cached(key);
    if (cached) { this.server = cached; this.render(); return; }
    const failed = force ? null : this.failure(key);
    if (failed) { this.server = failed.state; this.render(); this.renderWhenRetryable(failed.state); return; }
    this.server = { key, status: "loading", groups: {} };
    this.render();
    const params = this.params();
    this.timer = setTimeout(async () => {
      if (seq !== this.seq) return;
      const next = await this.fetchServer(key, params);
      if (!next || seq !== this.seq) return; // signed out, or a newer question meanwhile
      this.server = next;
      if (this.isOpen && this.key() === key) this.render();
      if (next.status === "error") this.renderWhenRetryable(next);
    }, delay);
  }
  // One request per question at a time; its answer is recorded once (cache or failure list), whoever waits for it.
  fetchServer(key, params) {
    const running = this.inflight.get(key); if (running) return running;
    const epoch = this.epoch;
    const done = (res) => {
      if (epoch !== this.epoch) return null; // signed out meanwhile: keep nothing
      const state = { key, status: "done", groups: Object.fromEntries((res?.groups || []).map((g) => [g.type, { ...g, items: [...(g.items || [])] }])), partial: Boolean(res?.partial), partialReasons: Array.isArray(res?.partialReasons) ? res.partialReasons.map(String) : null, maxBoards: res?.maxBoards ?? null };
      this.failures.delete(key); this.cache.delete(key); this.cache.set(key, { at: this.now(), state });
      while (this.cache.size > CommandCenter.CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
      return state;
    };
    const failed = (error) => {
      if (epoch !== this.epoch) return null;
      const prev = this.failure(key), attempts = (prev?.attempts || 0) + 1, info = this.errorInfo(error), at = this.now(), B = CommandCenter.BACKOFF_MS;
      const state = { key, status: "error", groups: {}, message: info.message, kind: info.kind, retryable: info.retryable, retryAt: info.backoff ? at + B[Math.min(attempts, B.length) - 1] : 0 };
      this.failures.delete(key); this.failures.set(key, { at, attempts, state });
      while (this.failures.size > CommandCenter.CACHE_SIZE) this.failures.delete(this.failures.keys().next().value);
      return state;
    };
    let promise;
    try { promise = Promise.resolve(this.adapter.searchGlobal(params)).then(done, failed); } catch (error) { promise = Promise.resolve().then(() => failed(error)); }
    this.inflight.set(key, promise);
    promise.then(() => { if (this.inflight.get(key) === promise) this.inflight.delete(key); });
    return promise;
  }
  cached(key) {
    const hit = this.cache.get(key); if (!hit) return null;
    if (this.now() - hit.at >= CommandCenter.CACHE_MS) { this.cache.delete(key); return null; }
    this.cache.delete(key); this.cache.set(key, hit); // most recently used last
    return hit.state;
  }
  failure(key) {
    const f = this.failures.get(key); if (!f) return null;
    if (this.now() - f.at >= CommandCenter.FAILURE_MS) { this.failures.delete(key); return null; }
    return f;
  }
  // Re-renders once the back-off is over, so the disabled Try again becomes available.
  renderWhenRetryable(state) {
    clearTimeout(this.retryTimer);
    const wait = (state.retryAt || 0) - this.now(); if (wait <= 0) return;
    this.retryTimer = setTimeout(() => { if (this.isOpen && this.serverState() === state) this.render(); }, wait + 50);
  }
  // The server's own code (error.cause.serverCode) first: StorageService maps every 503 to SERVICE_UNAVAILABLE.
  // backoff: the server did costly work (or refused to), so Try again waits before asking again.
  errorInfo(error) {
    const code = error?.code, server = error?.cause?.serverCode || null, is = (c) => server === c || code === c;
    if (is("SEARCH_TIMEOUT")) return { kind: "timeout", message: "Search is taking too long across all boards.", retryable: true, backoff: true };
    if (is("SEARCH_UNAVAILABLE")) return { kind: "unavailable", message: "Search across all boards isn't available right now.", retryable: true, backoff: true };
    if (code === "VALIDATION_ERROR") return { kind: "validation", message: "Type at least 2 characters, or change the filters.", retryable: false, backoff: false };
    if (code === "RATE_LIMITED") return { kind: "rate", message: "Too many searches just now.", retryable: true, backoff: true };
    if (code === "OFFLINE") return { kind: "offline", message: "You're offline, so other boards can't be searched.", retryable: true, backoff: false };
    if (code === "SERVICE_UNAVAILABLE" && !server) return { kind: "slow", message: "The server took too long. Try again in a moment.", retryable: true, backoff: true };
    return { kind: "error", message: "Couldn't search all boards.", retryable: true, backoff: false };
  }
  errorText(error) { return this.errorInfo(error).message; }
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
  // Only an explicit Try again asks the same question again, and not while its back-off runs.
  retry() {
    const live = this.serverState();
    if (live?.status === "error" && (live.retryable === false || (live.retryAt || 0) > this.now())) return;
    this.scheduleServer(0, { force: true });
  }
}
