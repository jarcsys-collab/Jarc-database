// Keyboard shortcuts: one registry for the whole app, the help list built from it, and Quick search (Ctrl/⌘ + B).
//
// Each shortcut: id, group, label, combo { key, mod, shift, alt, code }, when(ctx) and run(ctx).
//   mod   = Ctrl on Windows and Linux, ⌘ on a Mac (never both)
//   shift = true / false (default false for letter shortcuts) / "any" (keys whose character already needs Shift, such as ?)
//   code  = the physical key (KeyB…), used only when the layout types a non-Latin character on it
// Entries without run() are handled where they belong (the grid: AppController.cellKey; clipboard: copy/cut/paste events)
// and are listed here so that the help is complete and in one place. A shortcut that isn't available in the current context
// is left to the browser: preventDefault() only when JARC really did something.
class KeyboardShortcuts {
  static isMac() {
    try { const p = navigator.userAgentData?.platform || navigator.platform || ""; return /mac|iphone|ipad|ipod/i.test(p); } catch { return false; }
  }
  static GROUPS = ["System", "Board navigation", "Editing", "Selection", "Board actions"];

  constructor(controller) {
    this.c = controller;
    this.mac = KeyboardShortcuts.isMac();
    this.defs = this.definitions();
  }

  // ---- Matching --------------------------------------------------------------------------------------------------------
  static matches(combo, event, mac = KeyboardShortcuts.isMac()) {
    if (!combo || !event) return false;
    const mod = mac ? event.metaKey : event.ctrlKey, other = mac ? event.ctrlKey : event.metaKey;
    if (Boolean(combo.mod) !== mod || other) return false;
    if (Boolean(combo.alt) !== event.altKey) return false;
    const shift = combo.shift ?? false;
    if (shift !== "any" && Boolean(shift) !== event.shiftKey) return false;
    const key = String(event.key || "");
    if (key.toLowerCase() === String(combo.key).toLowerCase()) return true;
    // A layout without Latin letters (e.g. Cyrillic, Greek): the physical key decides, for shortcuts with Ctrl/⌘ only.
    return Boolean(combo.code && combo.mod && event.code === combo.code && key.length === 1 && !/[a-z0-9.]/i.test(key));
  }
  static KEY_NAMES = { Enter: ["Enter", "Return"], Escape: ["Esc", "Esc"], ArrowUp: ["↑", "↑"], ArrowDown: ["↓", "↓"], ArrowLeft: ["←", "←"], ArrowRight: ["→", "→"], Backspace: ["Backspace", "⌫"], Delete: ["Delete", "⌦"], Tab: ["Tab", "Tab"], " ": ["Space", "Space"] };
  // The keys to press, as the person's keyboard names them: ["Ctrl", "Shift", "G"] or ["⌘", "⇧", "G"].
  static keys(combo, mac = KeyboardShortcuts.isMac()) {
    if (combo.display) return combo.display.map((k) => (Array.isArray(k) ? k[mac ? 1 : 0] : k));
    const out = [];
    if (combo.mod) out.push(mac ? "⌘" : "Ctrl");
    if (combo.alt) out.push(mac ? "⌥" : "Alt");
    if (combo.shift === true) out.push(mac ? "⇧" : "Shift");
    const named = KeyboardShortcuts.KEY_NAMES[combo.key];
    out.push(named ? named[mac ? 1 : 0] : combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
    return out;
  }

  // ---- The registry ----------------------------------------------------------------------------------------------------
  definitions() {
    const c = this.c;
    const onBoard = (x) => x.m.screen === "board" && Boolean(x.m.board) && !x.m.boardLinkProblem;
    const typing = (x) => x.editing || Boolean(x.target?.isContentEditable);
    const free = (x) => !typing(x) && !x.overlay;
    const editable = (x) => onBoard(x) && !x.m.board.source?.readOnly && !x.m.board.archived;
    const inRow = (x) => Boolean(x.target?.closest?.(".editable-table tr[data-record-context]")) && !typing(x);
    // An existing control does the work (same dialogs, checks and permissions as clicking it); absent or disabled → not handled.
    const press = (selector) => { const el = c.root.querySelector(selector); if (!el || el.disabled || el.getAttribute("aria-disabled") === "true" || !el.getClientRects().length) return false; el.click(); return true; };
    const has = (selector) => { const el = c.root.querySelector(selector); return Boolean(el && !el.disabled && el.getClientRects().length); };
    const grid = (x) => onBoard(x);
    return [
      // System
      { id: "quick-search", group: "System", label: "Quick search: jump to a board", combo: { key: "b", mod: true, code: "KeyB" }, when: (x) => !x.overlay || c.quickSearch?.isOpen, run: () => c.quickSearch?.toggle() },
      { id: "command-center", group: "System", label: "Search records and commands", combo: { key: "k", mod: true, code: "KeyK" }, when: (x) => !x.target?.matches?.('textarea,[contenteditable="true"]') && !c.quickSearch?.isOpen, run: () => { if (c.command) c.command.toggle(); else c.view.showCommandPalette(c.model); } },
      { id: "toggle-sidebar", group: "System", label: "Show or hide the sidebar", combo: { key: ".", mod: true, code: "Period" }, when: free, run: () => c.toggleSidebar() },
      { id: "help", group: "System", label: "Keyboard shortcuts (this list)", combo: { key: "?", shift: "any", display: ["?"] }, when: free, run: () => this.showHelp() },
      { id: "close", group: "System", label: "Close a dialog, menu, search or panel", combo: { key: "Escape" }, available: () => true },
      { id: "find", group: "System", label: "Search this board (off a board: search everything)", combo: { key: "/", shift: "any", display: ["/"] }, when: free, run: (x) => { if (onBoard(x) && document.querySelector("#board-search")) document.querySelector("#board-search").focus(); else c.view.showCommandPalette(c.model); } },
      // Board navigation (AppController.cellKey)
      { id: "arrows", group: "Board navigation", label: "Move between cells (follows rows drawn on demand, into the next group)", combo: { display: ["↑", "↓", "←", "→"] }, available: grid },
      { id: "tab", group: "Board navigation", label: "Next / previous cell", combo: { display: ["Tab", "|", ["Shift", "⇧"], "Tab"] }, available: grid },
      { id: "edit", group: "Board navigation", label: "Edit the focused cell (or start typing; F2 also works)", combo: { key: "Enter" }, available: grid },
      { id: "open", group: "Board navigation", label: "Open the focused cell's picker or editor", combo: { key: " " }, available: grid },
      { id: "cancel", group: "Board navigation", label: "Cancel an edit without saving it", combo: { key: "Escape" }, available: grid },
      { id: "range", group: "Board navigation", label: "Select a range of cells", combo: { display: [["Shift", "⇧"], "↑ ↓ ← →"] }, available: grid },
      { id: "reorder", group: "Board navigation", label: "Move the focused row up or down (its drag handle)", combo: { display: [["Alt", "⌥"], "↑ / ↓"] }, available: grid },
      { id: "board-search", group: "Board navigation", label: "Search this board — every record (from the table, or on a long board; press again for the browser's Find)", combo: { key: "f", mod: true, code: "KeyF" }, when: (x) => onBoard(x) && free(x) && Boolean(document.querySelector("#board-search")) && (Boolean(x.target?.closest?.(".board-view-region")) || c.rowsOffPage()), run: () => { const input = document.querySelector("#board-search"); input.focus(); input.select(); if (c.rowsOffPage()) c.view.toast(`Board search covers every record. Press ${this.mac ? "⌘" : "Ctrl"}+F again for the browser's Find, which only sees the rows on screen.`); } },
      // Editing (cellKey; the browser's copy, cut and paste events; undo in AppController.onKeydown)
      { id: "clear", group: "Editing", label: "Clear the selected cells (never deletes a record)", combo: { display: [["Delete", "⌦"], "|", ["Backspace", "⌫"]] }, available: editable },
      { id: "copy", group: "Editing", label: "Copy the selected cells", combo: { key: "c", mod: true }, available: grid },
      { id: "cut", group: "Editing", label: "Cut: copy the selected cells, then clear them", combo: { key: "x", mod: true }, available: editable },
      { id: "paste", group: "Editing", label: "Paste into the selected cells (checked against each column)", combo: { key: "v", mod: true }, available: editable },
      { id: "undo", group: "Editing", label: "Undo the last board change", combo: { key: "z", mod: true }, available: grid },
      { id: "redo", group: "Editing", label: "Redo", combo: { display: this.mac ? ["⌘", "⇧", "Z"] : ["Ctrl", "Y"] }, available: grid },
      // Selection
      { id: "select", group: "Selection", label: "Select or unselect the focused record", combo: { key: "Enter", mod: true }, when: (x) => onBoard(x) && !x.overlay && inRow(x), run: (x) => c.selectFocusedRecord(x.target, { extend: false }) },
      { id: "extend", group: "Selection", label: "Select every record from the last one selected to the focused one (rows on screen only)", combo: { key: "Enter", shift: true }, when: (x) => onBoard(x) && !x.overlay && inRow(x), run: (x) => c.selectFocusedRecord(x.target, { extend: true }) },
      // Board actions
      { id: "new-record", group: "Board actions", label: "New record", combo: { key: "n", display: ["N"] }, when: free, run: () => c.chooseBoardAction("record") },
      { id: "toggle-groups", group: "Board actions", label: "Collapse all groups (expand them again when all are collapsed)", combo: { key: "g", mod: true, code: "KeyG" }, when: (x) => Boolean(x.event) && c.collapseShortcutActive(x.event, x.editing), run: () => c.toggleAllBoardGroups(), available: () => c.boardGroupsShown() },
      { id: "new-group", group: "Board actions", label: "New group", combo: { key: "g", mod: true, shift: true, code: "KeyG" }, when: (x) => editable(x) && free(x), run: () => press('[data-action="group-new"]'), available: (x) => editable(x) && has('[data-action="group-new"]') },
      { id: "new-column", group: "Board actions", label: "New column", combo: { key: "c", mod: true, shift: true, code: "KeyC" }, when: (x) => editable(x) && free(x), run: () => press('.editable-table [data-action="add-column"]'), available: (x) => editable(x) && has('.editable-table [data-action="add-column"]'), note: "Some browsers keep this key for their developer tools; the + at the end of the column headers does the same." },
      { id: "activity", group: "Board actions", label: "Activity: what changed in your workspaces", combo: { key: "l", mod: true, shift: true, code: "KeyL" }, when: free, run: () => press('[data-action="notifications"]'), available: () => has('[data-action="notifications"]') },
      { id: "export", group: "Board actions", label: "Export this board's records (CSV, as Export does)", combo: { key: "e", mod: true, shift: true, code: "KeyE" }, when: (x) => onBoard(x) && free(x), run: () => press('.board-actions [data-action="export"]'), available: (x) => onBoard(x) && has('.board-actions [data-action="export"]') },
      { id: "multi-sort", group: "Board actions", label: "Add a column to the sort (again: reverse it)", combo: { display: [["Ctrl", "⌘"], "click a column header"] }, available: grid }
    ];
  }

  // The first matching shortcut that applies here runs; anything else is left to the page and the browser.
  // ctx: { editing } from AppController.onKeydown.
  handle(event, { editing = false } = {}) {
    if (event.defaultPrevented || event.isComposing || event.key === "Process" || event.keyCode === 229) return false;
    const x = this.context(event, editing);
    for (const def of this.defs) {
      if (!def.run || !KeyboardShortcuts.matches(def.combo, event, this.mac) || !def.when(x)) continue;
      if (def.run(x) === false) return false; // not possible here (e.g. no such control): the browser keeps the key
      event.preventDefault();
      return true;
    }
    return false;
  }
  context(event = null, editing = false) {
    const root = document.querySelector("#overlay-root");
    return { c: this.c, m: this.c.model, event, editing, target: event?.target || document.activeElement, overlay: Boolean(root?.children.length) };
  }

  // ---- The help list (Shift + ? and Keyboard shortcuts in the sidebar) ------------------------------------------------
  showHelp() {
    const view = this.c.view, esc = (t) => view.escape(String(t)), x = this.context(null, false);
    const kbd = (combo) => KeyboardShortcuts.keys(combo, this.mac).map((k) => (k === "|" ? `<span class="shortcut-or">or</span>` : `<kbd>${esc(k)}</kbd>`)).join("");
    const usable = (d) => (d.available ? d.available(x) : d.when ? d.when({ ...x, overlay: false, editing: false }) : true);
    const sections = KeyboardShortcuts.GROUPS.map((group) => {
      const rows = this.defs.filter((d) => d.group === group).map((d) => {
        const ok = usable(d);
        return `<div class="shortcut-item ${ok ? "" : "is-unavailable"}"><dt>${esc(d.label)}${d.note ? `<small>${esc(d.note)}</small>` : ""}${ok ? "" : `<small>Not available here${group === "Board navigation" || group === "Editing" || group === "Selection" ? " — open a board" : ""}</small>`}</dt><dd>${kbd(d.combo)}</dd></div>`;
      }).join("");
      return `<section aria-labelledby="sc-${esc(group).replace(/\s+/g, "-")}"><h3 id="sc-${esc(group).replace(/\s+/g, "-")}">${esc(group)}</h3><dl class="shortcut-items">${rows}</dl></section>`;
    }).join("");
    this.c.overlayReturnFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    view.overlay(`<div class="modal shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title"><div class="modal-head"><div><div class="eyebrow">${this.mac ? "Mac" : "Windows and Linux"}</div><h2 id="shortcuts-title">Keyboard shortcuts</h2></div>${view.closeButton()}</div><div class="shortcuts-body">${sections}<p class="shortcuts-foot">Shortcuts are quiet while you type in a field or a cell; the browser's own copy, paste, undo and Find work there as usual.</p></div></div>`);
    document.querySelector("#overlay-root .shortcuts-modal [data-action=\"close-overlay\"]")?.focus();
  }
}

// ---- Quick search (Ctrl/⌘ + B): the boards this person may see (the list the server already sent), by name. --------------
// Nothing is fetched while typing; boards in archived workspaces and archived boards are left out, as in the sidebar.
class QuickSearch {
  constructor(controller) { this.c = controller; this.active = 0; this.items = []; }
  get isOpen() { return Boolean(document.querySelector("#overlay-root .quick-search")); }
  toggle() { if (this.isOpen) this.close(); else this.open(); }
  static norm(text) { return String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
  entries() {
    const m = this.c.model, recent = new Map((m.recentBoards || []).map((r, i) => [String(r.boardId), i]));
    const out = [];
    for (const w of m.workspaces || []) {
      if (w.archived) continue;
      for (const b of w.boards || []) if (!b.archived) out.push({ board: b, workspace: w, name: b.name || "Untitled board", norm: QuickSearch.norm(b.name), ws: QuickSearch.norm(w.name), favorite: Boolean(b.favorite), recent: recent.has(String(b.id)) ? recent.get(String(b.id)) : Infinity });
    }
    return out;
  }
  // Empty: favourites, then recently opened, then A–Z. Typed: every word in the board's (or its workspace's) name; names
  // starting with the text first. At most 50 shown.
  results(query) {
    const all = (this.all ||= this.entries()), text = QuickSearch.norm(query).trim();
    if (!text) return [...all].sort((a, b) => (b.favorite - a.favorite) || (a.recent - b.recent) || a.name.localeCompare(b.name)).slice(0, 50);
    const words = text.split(/\s+/);
    return all.map((e) => ({ e, rank: words.every((w) => e.norm.includes(w) || e.ws.includes(w)) ? (e.norm.startsWith(text) ? 0 : e.norm.includes(text) ? 1 : 2) : -1 }))
      .filter((r) => r.rank >= 0).sort((a, b) => a.rank - b.rank || (b.e.favorite - a.e.favorite) || a.e.name.localeCompare(b.e.name)).slice(0, 50).map((r) => r.e);
  }
  open() {
    const view = this.c.view;
    this.all = null; this.active = 0;
    this.c.overlayReturnFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    view.overlay(`<div class="modal quick-search" role="dialog" aria-modal="true" aria-labelledby="quick-search-title"><h2 id="quick-search-title" class="sr-only">Quick search: boards</h2><label class="quick-search-field">${icon("search")}<input id="quick-search-input" type="text" role="combobox" aria-expanded="true" aria-controls="quick-search-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Jump to a board…" aria-label="Board name"></label><ul id="quick-search-list" class="quick-search-list" role="listbox" aria-label="Boards"></ul><p class="quick-search-status" role="status" aria-live="polite"></p><p class="quick-search-hint" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>Enter</kbd> open <kbd>Esc</kbd> close</p></div>`, "quick-search-overlay");
    const input = document.querySelector("#quick-search-input");
    input.addEventListener("input", () => { cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(() => { this.active = 0; this.render(input.value); }); });
    this.render("");
    input.focus();
  }
  close() { if (this.isOpen) this.c.view.closeOverlay(); }
  render(query) {
    const list = document.querySelector("#quick-search-list"), status = document.querySelector(".quick-search-status"), view = this.c.view;
    if (!list) return;
    this.items = this.results(query);
    this.active = Math.min(this.active, Math.max(0, this.items.length - 1));
    const mark = (name) => { const t = QuickSearch.norm(query).trim(), i = t ? QuickSearch.norm(name).indexOf(t) : -1; return i < 0 ? view.escape(name) : `${view.escape(name.slice(0, i))}<mark>${view.escape(name.slice(i, i + t.length))}</mark>${view.escape(name.slice(i + t.length))}`; };
    const dupes = new Map(); for (const e of this.items) dupes.set(e.norm, (dupes.get(e.norm) || 0) + 1);
    list.innerHTML = this.items.map((e, i) => `<li id="quick-search-option-${i}" role="option" aria-selected="${i === this.active}" class="quick-search-item ${i === this.active ? "is-active" : ""}" data-action="quick-search-open" data-index="${i}"><span class="quick-search-icon" aria-hidden="true">${e.favorite ? icon("star") : icon("board")}</span><span class="quick-search-text"><strong>${mark(e.name)}</strong><small>${view.escape(e.workspace.name)}${dupes.get(e.norm) > 1 ? " · same name in another workspace" : ""}</small></span>${e.favorite ? `<span class="sr-only">, favourite</span>` : ""}</li>`).join("");
    document.querySelector("#quick-search-input")?.setAttribute("aria-activedescendant", this.items.length ? `quick-search-option-${this.active}` : "");
    status.textContent = this.items.length ? (query.trim() ? `${this.items.length} board${this.items.length === 1 ? "" : "s"}` : "") : query.trim() ? "No board with that name" : "No boards yet";
  }
  move(step) {
    if (!this.items.length) return;
    this.active = (this.active + step + this.items.length) % this.items.length;
    const list = document.querySelector("#quick-search-list");
    list?.querySelectorAll(".quick-search-item").forEach((li, i) => { li.classList.toggle("is-active", i === this.active); li.setAttribute("aria-selected", String(i === this.active)); });
    document.querySelector("#quick-search-input")?.setAttribute("aria-activedescendant", `quick-search-option-${this.active}`);
    document.querySelector(`#quick-search-option-${this.active}`)?.scrollIntoView({ block: "nearest" });
  }
  // Opens a result through the usual navigation (memory, saved copy or server; the address becomes the board's link).
  openAt(index) {
    const e = this.items[index ?? this.active];
    if (!e) return;
    this.c.overlayReturnFocus = null;
    this.c.view.closeOverlay();
    try { this.c.model.openBoard(e.board.id, e.workspace.id); } catch { this.c.view.toast("That board is no longer available."); return; }
    this.c.update();
  }
  // Keys inside the dialog. true: handled here.
  onKeydown(event) {
    if (!this.isOpen || event.target?.id !== "quick-search-input" || event.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); this.move(event.key === "ArrowDown" ? 1 : -1); return true; }
    if (event.key === "Enter") { event.preventDefault(); this.openAt(); return true; }
    if (event.key === "Escape") { event.preventDefault(); this.close(); return true; }
    if (event.key === "Tab") { event.preventDefault(); return true; } // one field: focus stays in the dialog
    return false;
  }
}
window.KeyboardShortcuts = KeyboardShortcuts;
window.QuickSearch = QuickSearch;
