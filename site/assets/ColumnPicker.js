// Column System C1: the Add Column picker. An anchored popover (a bottom sheet on phones) under the header's "+" button, or
// next to a column for "Add column to the right". It lists the column types from the registry (window.ColumnTypes):
// Recent (this person's last 5, in localStorage), then each category (Essentials first). Search is local only: the
// registry's labels, keywords and synonyms. Choosing a simple type creates it at once with today's create API
// (BoardModel.addColumn through AppController.createColumnFromPicker); Connect and Mirror open their existing setup step.
// Connect and Mirror are listed only while BoardModel.relationsAvailable is true. Rendered into #overlay-root like every
// other JARC popover, so Escape, outside clicks, the focus trap and the closing animation work as they do elsewhere.
class ColumnPicker {
  static RECENT_KEY = "jarc.recentColumnTypes";
  static RECENT_MAX = 5;
  constructor(view) { this.view = view; this.state = null; }

  // ---- What can be added on this board.
  registry() { return window.ColumnTypes || null; }
  // The column type a descriptor creates ("tags" creates a dropdown that allows several values).
  typeOf(d) { try { return d.createPayload?.("x")?.type || d.id; } catch { return d.id; } }
  allowed(model, d) {
    const type = this.typeOf(d);
    if (!model.columnType(type) || d.available === false) return false;
    if (type === "files" && !model.filesAvailable()) return false;
    if (type === "connect" || type === "mirror") {
      if (!model.relationsAvailable) return false;
      if (type === "mirror" && !model.board.columns.some((c) => c.type === "connect")) return false;
    }
    if (type === "group" && model.board.columns.some((c) => c.type === "group")) return false; // one Group column per board
    return true;
  }
  ctx(model) { return { relationsAvailable: Boolean(model.relationsAvailable), filesAvailable: Boolean(model.filesAvailable?.()), hasConnectColumn: model.board.columns.some((c) => c.type === "connect") }; }
  // Connect and Mirror need their setup step (the board to link, or the column to show) before anything is created.
  needsSetup(d) { return Boolean(d.needsSetup) || ["connect", "mirror"].includes(this.typeOf(d)); }
  descriptors(model) {
    const CT = this.registry();
    const list = CT ? CT.list(this.ctx(model)) : model.columnTypes.map((t) => ({ id: t.type, label: t.label, category: t.category, description: t.description, keywords: [] }));
    return (list || []).filter((d) => d && this.allowed(model, d));
  }
  categories(model, list) {
    const CT = this.registry();
    const order = (CT?.categories?.() || []).map((c) => (typeof c === "string" ? { id: c, label: c } : { id: c.id ?? c.label, label: c.label ?? c.id }));
    const seen = new Set(order.map((c) => c.id));
    for (const d of list) if (!seen.has(d.category)) { seen.add(d.category); order.push({ id: d.category, label: d.category }); }
    return order.filter((c) => list.some((d) => d.category === c.id));
  }
  // Ranked matches with an optional reason ("matched 'due'"). The registry's own search when there is one.
  search(model, q, list) {
    const CT = this.registry(), ids = new Set(list.map((d) => d.id));
    if (CT?.search) {
      const found = CT.search(q, this.ctx(model)) || [];
      return found.map((r) => (r && r.descriptor ? { d: r.descriptor, reason: r.reason || "" } : { d: r, reason: r?.reason || r?.match || "" })).filter((r) => r.d && ids.has(r.d.id));
    }
    const term = q.trim().toLowerCase();
    return list.filter((d) => `${d.label} ${(d.keywords || []).join(" ")} ${d.description || ""}`.toLowerCase().includes(term)).map((d) => ({ d, reason: "" }));
  }

  // ---- Recent: per person, at most 5, newest first. Storage can be missing or blocked: then there is no Recent row.
  recentKey(model) { return `${ColumnPicker.RECENT_KEY}:${String(model.me || model.profile?.email || "local").slice(0, 120)}`; }
  recent(model) {
    try { const raw = JSON.parse(window.localStorage.getItem(this.recentKey(model)) || "[]"); return Array.isArray(raw) ? raw.filter((x) => typeof x === "string").slice(0, ColumnPicker.RECENT_MAX) : []; }
    catch { return []; }
  }
  remember(model, id) {
    try { const next = [id, ...this.recent(model).filter((x) => x !== id)].slice(0, ColumnPicker.RECENT_MAX); window.localStorage.setItem(this.recentKey(model), JSON.stringify(next)); } catch { /* storage blocked: no Recent row */ }
  }

  // ---- Drawing.
  icon(d) { return typeof d.icon === "string" && d.icon.trim().startsWith("<svg") ? d.icon : this.view.columnTypeIcon(this.typeOf(d)); }
  option(d, { prefix = "", reason = "", best = false } = {}) {
    const v = this.view, id = `column-picker-${prefix}${String(d.id).replace(/[^a-z0-9_-]/gi, "")}`;
    const complex = this.needsSetup(d);
    return `<button type="button" role="option" id="${v.attr(id)}" class="column-picker-option" tabindex="-1" aria-selected="false" data-action="column-picker-choose" data-type="${v.attr(d.id)}" data-description="${v.attr(d.description || "")}"><span class="column-picker-icon" aria-hidden="true">${this.icon(d)}</span><span class="column-picker-text"><strong>${v.escape(d.label)}${complex ? "…" : ""}</strong>${best ? `<em class="column-picker-best">Best match${reason ? ` · ${v.escape(reason)}` : ""}</em>` : ""}<small>${v.escape(d.description || "")}</small></span></button>`;
  }
  body(model, query = "") {
    const v = this.view, list = this.descriptors(model), q = String(query || "").trim();
    if (q) {
      const found = this.search(model, q, list);
      if (!found.length) return `<p class="column-picker-empty" role="status">No column type matches “${v.escape(q)}”. Try words like date, amount, status or people.</p>`;
      return `<div class="column-picker-section" role="group" aria-label="Matches"><div class="column-picker-heading" aria-hidden="true">Matches</div>${found.map((r, i) => this.option(r.d, { prefix: "q-", reason: r.reason, best: i === 0 })).join("")}</div>`;
    }
    const byId = new Map(list.map((d) => [d.id, d])), recent = this.recent(model).map((id) => byId.get(id)).filter(Boolean);
    const recentHtml = recent.length ? `<div class="column-picker-section is-recent" role="group" aria-label="Recently used"><div class="column-picker-heading" aria-hidden="true">Recent</div>${recent.map((d) => this.option(d, { prefix: "r-" })).join("")}</div>` : "";
    return recentHtml + this.categories(model, list).map((c) => `<div class="column-picker-section" role="group" aria-label="${v.attr(c.label)}"><div class="column-picker-heading" aria-hidden="true">${v.escape(c.label)}</div>${list.filter((d) => d.category === c.id).map((d) => this.option(d)).join("")}</div>`).join("");
  }
  html(model, { insertAfter = "", query = "" } = {}) {
    const v = this.view, after = insertAfter ? model.board.columns.find((c) => c.key === insertAfter) : null;
    return `<div class="popover column-picker" role="dialog" aria-label="${after ? `Add a column to the right of ${v.attr(after.label)}` : "Add column"}" data-insert-after="${v.attr(after?.key || "")}"><div class="column-picker-head"><span class="sheet-handle" aria-hidden="true"></span><div class="column-picker-title"><strong>${after ? "Add column to the right" : "Add column"}</strong><small>${after ? `After ${v.escape(after.label)} · everyone on this board` : "Everyone on this board sees new columns"}</small></div><label class="column-picker-search">${v.iconHtml("search")}<input type="search" data-action="column-type-search" value="${v.attr(query)}" placeholder="Search or describe a column" aria-label="Search column types" aria-controls="column-picker-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" autofocus></label></div><div class="column-picker-list" id="column-picker-list" role="listbox" aria-label="Column types">${this.body(model, query)}</div><p class="column-picker-hint" aria-live="polite"></p></div>`;
  }

  // ---- Opening, searching, keyboard.
  // anchor: the element it opens from (the "+" button, or the column's header for "to the right").
  open(model, { anchor = null, insertAfter = "" } = {}) {
    const root = document.querySelector("#overlay-root"); if (!root) return null;
    root.innerHTML = this.html(model, { insertAfter });
    const panel = root.querySelector(".column-picker");
    this.state = { model, anchor, insertAfter, panel };
    panel.addEventListener("keydown", (e) => this.onKeydown(e));
    panel.addEventListener("pointermove", (e) => { const o = e.target.closest?.(".column-picker-option"); if (o) this.highlight(o, { scroll: false }); });
    this.highlight(panel.querySelector(".column-picker-option"), { scroll: false });
    // After AppController.enhanceOverlay (a MutationObserver microtask) has run: place it by the anchor.
    requestAnimationFrame(() => { this.place(); panel.querySelector("[data-action=column-type-search]")?.focus(); });
    this.onResize ??= () => this.place();
    window.addEventListener("resize", this.onResize);
    return panel;
  }
  isOpen() { return Boolean(this.state?.panel?.isConnected); }
  filter(query) {
    if (!this.isOpen()) return;
    const list = this.state.panel.querySelector(".column-picker-list");
    list.innerHTML = this.body(this.state.model, query);
    this.highlight(list.querySelector(".column-picker-option"), { scroll: false });
    list.scrollTop = 0;
    if (this.state.panel.classList.contains("is-above")) this.place(); // a picker above its anchor stays attached to it
  }
  options() { return this.isOpen() ? [...this.state.panel.querySelectorAll(".column-picker-option")] : []; }
  highlighted() { return this.state?.panel?.querySelector(".column-picker-option.is-active") || null; }
  highlight(option, { scroll = true } = {}) {
    if (!this.isOpen()) return;
    for (const o of this.options()) { const on = o === option; o.classList.toggle("is-active", on); o.setAttribute("aria-selected", String(on)); }
    const input = this.state.panel.querySelector("[data-action=column-type-search]"), hint = this.state.panel.querySelector(".column-picker-hint");
    if (option) { input?.setAttribute("aria-activedescendant", option.id); if (scroll) option.scrollIntoView({ block: "nearest" }); }
    else input?.removeAttribute("aria-activedescendant");
    if (hint) hint.textContent = option ? `${option.querySelector("strong")?.textContent || ""}: ${option.dataset.description || ""}` : "";
  }
  // Arrows move the highlight (focus stays in the search field, or on the option a Tab reached); Enter creates the
  // highlighted type; Escape closes; typing anywhere in the picker goes to the search field.
  onKeydown(event) {
    const options = this.options(), current = this.highlighted(), i = options.indexOf(current), input = this.state.panel.querySelector("[data-action=column-type-search]");
    const inInput = event.target === input, move = (to) => { event.preventDefault(); event.stopPropagation(); const next = options[(to + options.length) % options.length]; if (!next) return; this.highlight(next); if (!inInput) next.focus(); };
    if (event.key === "ArrowDown" || (!inInput && event.key === "ArrowRight")) return move(i + 1);
    if (event.key === "ArrowUp" || (!inInput && event.key === "ArrowLeft")) return move(i < 0 ? options.length - 1 : i - 1);
    if (event.key === "Home" && !inInput) return move(0);
    if (event.key === "End" && !inInput) return move(options.length - 1);
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); (inInput ? current : event.target.closest(".column-picker-option") || current)?.click(); return; }
    if (!inInput && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { input?.focus(); } // type-to-search: the key lands in the field
  }
  // Where the popover goes: below the anchor (above it when there is no room below), its right edge aligned to the anchor
  // when it would overflow, always inside the viewport. Phones (≤ 640 px): a bottom sheet (CSS), nothing to place.
  place() {
    if (!this.isOpen()) { window.removeEventListener("resize", this.onResize); return; }
    const panel = this.state.panel, anchor = this.state.anchor?.isConnected ? this.state.anchor : null;
    if (window.matchMedia?.("(max-width: 640px)").matches) { panel.classList.add("is-sheet"); panel.style.left = panel.style.top = panel.style.right = panel.style.maxHeight = ""; return; }
    panel.classList.remove("is-sheet");
    // The shared placement (Popover.js): flips above when there is more room there, aligns to the anchor's right edge near
    // the viewport's right edge, and stays 8 px inside it.
    // Its height is never raised past what the stylesheet allows (70 vh, 560 px), so a flipped picker ends right above the anchor.
    if (anchor && window.Popover?.place) {
      try {
        panel.style.maxHeight = "";
        const r = panel.getBoundingClientRect(), p = window.Popover.place(anchor, { width: r.width, height: r.height }, window.Popover.viewport(), "bottom-start", { sheetBelow: 0 });
        Object.assign(panel.style, { left: `${p.left}px`, top: `${p.top}px`, right: "auto", maxHeight: `${Math.min(p.maxHeight, Math.ceil(r.height))}px` });
        panel.classList.toggle("is-above", p.side === "top");
        return;
      } catch { /* fall back below */ }
    }
    const w = panel.offsetWidth, h = panel.offsetHeight, r = anchor ? anchor.getBoundingClientRect() : { left: (innerWidth - w) / 2, right: (innerWidth + w) / 2, top: 80, bottom: 80 };
    let left = r.left; if (left + w > innerWidth - 8) left = r.right - w;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    const below = innerHeight - r.bottom - 8, above = r.top - 8;
    let top = below >= Math.min(h, 320) || below >= above ? r.bottom + 6 : r.top - 6 - h;
    top = Math.max(8, Math.min(top, innerHeight - h - 8));
    panel.style.left = `${Math.round(left)}px`; panel.style.top = `${Math.round(top)}px`; panel.style.right = "auto";
    panel.classList.toggle("is-above", top + h <= r.top);
  }
  // The name a one-click column gets: what was typed when it isn't just a word for the type ("approval stage" → Status
  // column "Approval stage"), otherwise the registry's default ("Status", "Status 2"…).
  nameFor(model, d) {
    const used = model.board.columns.map((c) => c.label), q = String(this.state?.panel?.querySelector("[data-action=column-type-search]")?.value || "").trim().replace(/\s+/g, " ");
    const words = q.toLowerCase().split(" ").filter(Boolean), vocab = [d.label, d.id, ...(d.keywords || [])].map((w) => String(w).toLowerCase());
    const typeWord = (w) => vocab.some((k) => k.startsWith(w) || k.split(/[\s/-]+/).some((p) => p.startsWith(w)));
    const base = q && q.length <= 50 && !words.every(typeWord) ? q.charAt(0).toUpperCase() + q.slice(1) : "";
    if (base) return model.uniqueColumnLabel(base);
    const CT = this.registry();
    try { const name = CT?.defaultName?.(d.id, used); if (name) return String(name).slice(0, 50); } catch { /* fall through */ }
    return model.uniqueColumnLabel(d.label);
  }
  close() { window.removeEventListener("resize", this.onResize); this.state = null; }
}
window.ColumnPicker = ColumnPicker;
