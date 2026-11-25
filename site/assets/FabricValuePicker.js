// Fabric Data → searchable value picker (Power BI style multi-select) for one field of one dataset. Read-only.
//
// Values come only from the server: GET /fabric/{dataset}/values?field&q&after&limit&filter&dateFrom&dateTo (session mount),
// answering {values:[{value, count}], complete, limited, next|nextAfter}. Nothing is ever derived from the rows on screen.
// - Search as you type: 250 ms debounce, the previous request aborted (AbortController, when the explorer's get() takes a
//   signal) and every answer checked against a sequence number, so a slow earlier answer never replaces a newer one.
// - "Load more" asks again with after=<next>. When the server says the list is not complete, a note says so ("may be
//   incomplete") and the text typed can still be chosen as an exact value.
// - Cache: memory only, per explorer epoch + user + dataset + field + context (filter and dates) + search + page, 60 s, at most
//   200 answers. It is emptied when the dataset changes, on sign-out / session expiry, and by FabricValuePicker.forget().
// - Keyboard: in the search box ↓ moves to the list, Enter applies, Esc cancels; in the list ↑/↓/Home/End move, Space toggles,
//   Enter applies, Esc cancels, Ctrl+A selects everything shown. ARIA: role=listbox (multi-selectable) with role=option.
// Every value is escaped here; values never become attribute names, selectors or markup.
//
// Use: const p = new FabricValuePicker(explorer, "Company", { selected: ["A"], onApply(values) {…}, onCancel() {…} });
//      p.mount(element); … p.destroy();      (values: strings, null = blank)
class FabricValuePicker {
  static DEBOUNCE = 250;
  static LIMIT = 200;
  static MAX_SELECTED = 200;   // the filter model's maxListValues
  static MAX_TEXT = 100;
  static TTL = 60000;
  static MAX_CACHE = 200;
  static BLANK = "\u0000blank";
  static cache = new Map();
  static cacheDataset = "";
  static epochs = new WeakMap();
  static nextEpoch = 1;
  static ids = 0;
  static listening = false;

  // ---- Shared helpers (FabricColumnMenu uses them too)
  static esc(v) { return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
  static clean(v) { const t = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "") : ""; return t.slice(0, FabricValuePicker.MAX_TEXT); }
  static key(v) { return v === null || v === undefined ? FabricValuePicker.BLANK : `s:${String(v)}`; }
  static global(name) { try { const g = typeof window !== "undefined" && window ? window[name] : undefined; return g && (typeof g === "object" || typeof g === "function") ? g : null; } catch { return null; } }
  static day(v) { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ""; }
  // The field as the advanced schema describes it (schemaInfo() when the explorer offers it, else the raw schema answer).
  static fieldMeta(x, name) {
    let list = null;
    try { const s = typeof x?.schemaInfo === "function" ? x.schemaInfo() : null; list = Array.isArray(s?.fields) ? s.fields : Array.isArray(s) ? s : null; } catch { list = null; }
    if (!list) list = Array.isArray(x?.schema?.data?.fields) ? x.schema.data.fields : [];
    const f = list.find((d) => d && d.name === name);
    if (!f) return null;
    const ops = Array.isArray(f.operators) ? f.operators.map((o) => (typeof o === "string" ? o : o?.op)).filter((o) => typeof o === "string") : [];
    let label = name;
    try { if (typeof x?.fieldLabel === "function") label = String(x.fieldLabel(name) || name); } catch { label = name; }
    return { name, label, kind: typeof f.kind === "string" ? f.kind : "", type: typeof f.type === "string" ? f.type.toLowerCase() : "", operators: new Set(ops), valueSource: f.valueSource === "distinct" || f.valueSource === "search" ? f.valueSource : "none", orderable: f.orderable === true, sensitive: f.sensitive === true };
  }
  // The explorer's applied state: getState() when F2 offers it, else its query.
  static state(x) {
    let s = null;
    try { s = typeof x?.getState === "function" ? x.getState() : null; } catch { s = null; }
    return s && typeof s === "object" ? s : (x?.query && typeof x.query === "object" ? x.query : {});
  }
  static context(x) {
    const s = FabricValuePicker.state(x);
    return { filter: s.filter && typeof s.filter === "object" && Array.isArray(s.filter.items) && s.filter.items.length ? s.filter : null, dateFrom: FabricValuePicker.day(s.dateFrom), dateTo: FabricValuePicker.day(s.dateTo) };
  }
  // base64url of the UTF-8 JSON (FabricFilterModel's encoder when loaded, so both spell it the same way).
  static encodeFilter(model) {
    const M = FabricValuePicker.global("FabricFilterModel");
    for (const n of ["encode", "toParam", "encodeParam"]) if (M && typeof M[n] === "function") { try { const s = M[n](model); if (typeof s === "string") return s; } catch { /* fall through */ } }
    const json = JSON.stringify(model), bytes = [];
    for (const ch of unescape(encodeURIComponent(json))) bytes.push(ch.charCodeAt(0));
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : "") + (i + 2 < bytes.length ? A[n & 63] : "");
    }
    return out;
  }
  // A server answer reduced to what the picker shows (unexpected shapes become an empty, incomplete list).
  static sanitize(data) {
    const d = data && typeof data === "object" ? data : {};
    const values = [];
    for (const v of Array.isArray(d.values) ? d.values.slice(0, 1000) : []) {
      // The server's blank bucket (null, missing, "" and " ") is one option: value null.
      const raw = v && typeof v === "object" ? (v.blank === true ? null : Object.hasOwn(v, "value") ? v.value : undefined) : v;
      const value = raw === null || raw === undefined ? null : typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : undefined;
      if (value === undefined) continue;
      const count = v && typeof v === "object" && Number.isFinite(v.count) && v.count >= 0 ? Math.floor(v.count) : null;
      if (!values.some((x) => x.value === value)) values.push({ value, count });
    }
    const complete = d.complete === true;
    const l = d.limited && typeof d.limited === "object" ? d.limited : null;
    const limited = l ? { reason: l.reason === "rowCap" || l.reason === "valueLimit" ? l.reason : "", rowsScanned: Number.isFinite(l.rowsScanned) ? l.rowsScanned : null, rowCap: Number.isFinite(l.rowCap) ? l.rowCap : null } : null;
    const nx = typeof d.next === "string" ? d.next : typeof d.nextAfter === "string" ? d.nextAfter : null;
    return { values, complete, limited: complete ? null : limited, next: nx !== null && nx.length <= 2048 ? nx : null }; // after="" (past the blank bucket) is a real cursor
  }
  static forget() { FabricValuePicker.cache.clear(); FabricValuePicker.cacheDataset = ""; }
  static listen() {
    if (FabricValuePicker.listening || typeof window === "undefined" || typeof window?.addEventListener !== "function") return;
    FabricValuePicker.listening = true;
    for (const name of ["jarc-session-expired", "jarc-access-denied", "jarc-account-pending", "jarc-signed-out", "jarc-sign-out"]) window.addEventListener(name, () => FabricValuePicker.forget());
  }
  static epochOf(x) {
    const slot = x?.schema && typeof x.schema === "object" ? x.schema : x;
    if (!slot || typeof slot !== "object") return 0;
    let e = FabricValuePicker.epochs.get(slot);
    if (!e) { e = FabricValuePicker.nextEpoch++; FabricValuePicker.epochs.set(slot, e); }
    return e;
  }
  static cacheGet(key, ds) {
    if (FabricValuePicker.cacheDataset !== ds) { FabricValuePicker.cache.clear(); FabricValuePicker.cacheDataset = ds; return null; }
    const hit = FabricValuePicker.cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > FabricValuePicker.TTL) { FabricValuePicker.cache.delete(key); return null; }
    return hit.data;
  }
  static cachePut(key, ds, data) {
    if (FabricValuePicker.cacheDataset !== ds) { FabricValuePicker.cache.clear(); FabricValuePicker.cacheDataset = ds; }
    FabricValuePicker.cache.set(key, { at: Date.now(), data });
    while (FabricValuePicker.cache.size > FabricValuePicker.MAX_CACHE) FabricValuePicker.cache.delete(FabricValuePicker.cache.keys().next().value);
  }

  constructor(x, field, opts = {}) {
    FabricValuePicker.listen();
    this.x = x; this.field = field; this.ds = String(x?.ds || "");
    this.meta = FabricValuePicker.fieldMeta(x, field);
    this.multi = opts.multi !== false;
    this.limit = Number.isInteger(opts.limit) && opts.limit >= 1 && opts.limit <= 1000 ? opts.limit : FabricValuePicker.LIMIT;
    this.onApply = typeof opts.onApply === "function" ? opts.onApply : () => {};
    this.onCancel = typeof opts.onCancel === "function" ? opts.onCancel : () => {};
    this.id = `fvp-${++FabricValuePicker.ids}`;
    this.showFoot = opts.buttons !== false;
    this.blankSupported = Boolean(this.meta?.operators.has("blank") || opts.blank === true);
    this.selected = new Map();
    for (const v of Array.isArray(opts.selected) ? opts.selected : []) if (v === null || typeof v === "string") this.selected.set(FabricValuePicker.key(v), v);
    this.q = ""; this.items = []; this.next = null; this.complete = false; this.limited = null;
    this.loading = false; this.loadingMore = false; this.error = ""; this.note = ""; this.active = -1;
    this.seq = 0; this.timer = null; this.ctrl = null; this.destroyed = false; this.root = null; this.refs = {}; this.handlers = null;
  }

  // ---- Requests
  path(after) {
    const p = new URLSearchParams(), c = FabricValuePicker.context(this.x);
    p.set("field", this.field);
    if (this.q) p.set("q", this.q);
    if (after !== null && after !== undefined) p.set("after", after);
    p.set("limit", String(this.limit));
    if (c.filter) p.set("filter", FabricValuePicker.encodeFilter(c.filter));
    if (c.dateFrom && c.dateTo) { p.set("dateFrom", c.dateFrom); p.set("dateTo", c.dateTo); }
    // The explorer's API base (FabricExplorer options.apiBase; Fabric Data's "/fabric" by default).
    const base = typeof this.x?.apiBase === "string" && /^\/[a-z][a-z/-]{0,63}$/.test(this.x.apiBase) ? this.x.apiBase : "/fabric";
    return `${base}/${encodeURIComponent(this.ds)}/values?${p.toString()}`;
  }
  cacheKey(path) {
    let user = "";
    try { user = String(this.x?.p?.c?.model?.me || this.x?.p?.c?.auth?.userId || ""); } catch { user = ""; }
    return `${FabricValuePicker.epochOf(this.x)}|${user}|${path}`;
  }
  request(path, signal) {
    const x = this.x;
    if (typeof x?.get === "function") return x.get(path, { signal });
    const adapter = x?.p?.adapter;
    if (adapter && typeof adapter.request === "function") return adapter.request("GET", path);
    return Promise.reject(Object.assign(new Error("No connection"), { code: "NO_ADAPTER" }));
  }
  // Search: the box changes → one request 250 ms after the last key.
  setQuery(text) {
    const q = FabricValuePicker.clean(text).trim();
    if (q === this.q && !this.timer) return;
    this.q = q; clearTimeout(this.timer);
    this.loading = true; this.error = ""; this.render();
    this.timer = setTimeout(() => { this.timer = null; this.fetch(false); }, FabricValuePicker.DEBOUNCE);
  }
  async fetch(more) {
    if (this.destroyed) return;
    const after = more ? this.next : null;
    if (more && (after === null || this.loading)) return;
    clearTimeout(this.timer); this.timer = null;
    const seq = ++this.seq;
    try { this.ctrl?.abort?.(); } catch { /* already done */ }
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    this.ctrl = ctrl;
    const path = this.path(after), key = this.cacheKey(path);
    const hit = FabricValuePicker.cacheGet(key, this.ds);
    this.loading = true; this.loadingMore = more; this.error = ""; this.note = "";
    if (!hit) this.render();
    let data;
    try { data = hit || FabricValuePicker.sanitize(await this.request(path, ctrl?.signal)); }
    catch (e) {
      if (seq !== this.seq || this.destroyed || e?.name === "AbortError") return;
      this.loading = false; this.loadingMore = false;
      const status = e?.cause?.status ?? e?.status;
      this.error = status === 429 || e?.code === "RATE_LIMITED" ? "Too many requests. Try again in a moment." : "Values couldn't be loaded.";
      this.render(); return;
    }
    if (seq !== this.seq || this.destroyed) return; // a newer search (or close) replaced this one
    if (!hit) FabricValuePicker.cachePut(key, this.ds, data);
    if (this.ctrl === ctrl) this.ctrl = null;
    const start = this.items.length;
    if (more) { for (const v of data.values) if (!this.items.some((i) => i.value === v.value)) this.items.push(v); }
    else this.items = data.values.slice();
    this.next = data.next; this.complete = data.complete; this.limited = data.limited;
    this.loading = false; this.loadingMore = false;
    const n = this.options().length;
    this.active = more ? Math.min(Math.max(this.active, 0), n - 1) : n ? 0 : -1;
    if (more && start < this.items.length) this.active = Math.min(this.optionIndexOfItem(start), n - 1);
    this.render();
  }
  loadMore() { return this.fetch(true); }

  // ---- Options and selection
  options() {
    const out = [];
    if (this.blankSupported && !this.q && !this.items.some((i) => i.value === null)) out.push({ value: null, count: null, synthetic: true });
    for (const i of this.items) out.push(i);
    if (this.q && !this.items.some((i) => i.value === this.q)) out.push({ value: this.q, count: null, typed: true });
    return out;
  }
  optionIndexOfItem(i) { return i + (this.blankSupported && !this.q && !this.items.some((v) => v.value === null) ? 1 : 0); }
  isSelected(v) { return this.selected.has(FabricValuePicker.key(v)); }
  values() { return [...this.selected.values()]; }
  toggle(i) {
    const o = this.options()[i];
    if (!o) return;
    const k = FabricValuePicker.key(o.value);
    if (this.selected.has(k)) this.selected.delete(k);
    else if (!this.multi) { this.selected.clear(); this.selected.set(k, o.value); }
    else if (this.selected.size >= FabricValuePicker.MAX_SELECTED) { this.note = `At most ${FabricValuePicker.MAX_SELECTED} values can be chosen.`; this.render(); return; }
    else this.selected.set(k, o.value);
    this.active = i; this.note = ""; this.render();
  }
  // "Select all" covers what the server returned (and is shown), never values that weren't loaded.
  allShownSelected() { const o = this.options().filter((v) => !v.typed); return o.length > 0 && o.every((v) => this.isSelected(v.value)); }
  selectAll() {
    if (!this.multi) return;
    const shown = this.options().filter((v) => !v.typed);
    if (this.allShownSelected()) { for (const v of shown) this.selected.delete(FabricValuePicker.key(v.value)); this.note = ""; this.render(); return; }
    let capped = false;
    for (const v of shown) {
      if (this.isSelected(v.value)) continue;
      if (this.selected.size >= FabricValuePicker.MAX_SELECTED) { capped = true; break; }
      this.selected.set(FabricValuePicker.key(v.value), v.value);
    }
    this.note = capped ? `Only the first ${FabricValuePicker.MAX_SELECTED} values were chosen.` : "";
    this.render();
  }
  clear() { this.selected.clear(); this.note = ""; this.render(); }
  apply() { this.onApply(this.values()); }
  cancel() { this.onCancel(); }
  move(to) {
    const n = this.options().length;
    if (!n) { this.active = -1; return; }
    this.active = Math.max(0, Math.min(n - 1, to));
    this.render();
    const el = this.refs.list?.querySelector?.(`#${this.id}-opt-${this.active}`);
    try { el?.scrollIntoView?.({ block: "nearest" }); } catch { /* not in a layout */ }
  }

  // ---- Markup
  labelHtml(o) {
    if (o.typed) return `Use <q>${FabricValuePicker.esc(o.value)}</q> exactly`;
    if (o.value === null) return `<em>(Blank)</em>`;
    if (o.value === "") return `<em>(Empty text)</em>`;
    if (!o.value.trim()) return `<em>(Spaces only)</em>`;
    return FabricValuePicker.esc(o.value);
  }
  optionsHtml() {
    return this.options().map((o, i) => {
      const on = this.isSelected(o.value), count = this.complete && o.count !== null && !o.typed ? `<span class="fx-vpick__count">${o.count.toLocaleString()}</span>` : "";
      return `<li role="option" id="${this.id}-opt-${i}" class="fx-vpick__opt${i === this.active ? " is-active" : ""}${o.typed ? " is-typed" : ""}" aria-selected="${on}" data-fvp="opt" data-i="${i}"><span class="fx-vpick__box" aria-hidden="true"></span><span class="fx-vpick__label">${this.labelHtml(o)}</span>${count}</li>`;
    }).join("");
  }
  statusText() {
    if (this.error) return this.error;
    if (this.loading) return this.loadingMore ? "Loading more values…" : this.q ? "Searching…" : "Loading values…";
    const parts = [];
    if (!this.items.length) parts.push(this.q ? "No values match." : "No values.");
    if (!this.complete) {
      let t = "This list may be incomplete.";
      if (this.limited?.reason === "rowCap" && this.limited.rowCap) t += ` Only the first ${this.limited.rowCap.toLocaleString()} matching rows were read.`;
      t += this.next !== null ? " Load more, or search to narrow it." : " Search to narrow it.";
      if (this.items.length || this.q) parts.push(t);
    }
    if (this.note) parts.push(this.note);
    return parts.join(" ");
  }
  html() {
    const id = this.id, label = FabricValuePicker.esc(this.meta?.label || this.field), multi = this.multi;
    const tools = multi ? `<div class="fx-vpick__tools"><button type="button" class="fx-btn fx-vpick__all" data-fvp="all" aria-pressed="false">Select all shown</button><button type="button" class="fx-btn" data-fvp="clear">Clear</button><span class="fx-vpick__selcount" data-fvp-part="count" aria-live="polite"></span></div>` : "";
    const foot = this.showFoot ? `<div class="fx-vpick__foot"><button type="button" class="fx-btn fx-btn--primary" data-fvp="apply">Apply</button><button type="button" class="fx-btn" data-fvp="cancel">Cancel</button></div>` : "";
    return `<div class="fx-vpick" data-fvp-root="${id}"><label class="fx-vpick__searchlabel sr-only" for="${id}-q">Search values of ${label}</label><span class="fx-search fx-vpick__search"><input id="${id}-q" class="fx-search__input fx-vpick__input" type="search" data-fvp="q" maxlength="${FabricValuePicker.MAX_TEXT}" autocomplete="off" spellcheck="false" placeholder="Search values" aria-controls="${id}-list" aria-describedby="${id}-status"></span>${tools}<ul class="fx-vpick__list" id="${id}-list" role="listbox" tabindex="0" aria-label="Values of ${label}"${multi ? ' aria-multiselectable="true"' : ""} data-fvp="list"></ul><p class="fx-vpick__status" id="${id}-status" role="status" aria-live="polite" data-fvp-part="status"></p><button type="button" class="fx-btn fx-vpick__more" data-fvp="more" hidden>Load more</button>${foot}</div>`;
  }
  render() {
    const r = this.refs;
    if (!this.root || this.destroyed) return;
    if (r.list) {
      r.list.innerHTML = this.optionsHtml();
      if (this.active >= 0) r.list.setAttribute?.("aria-activedescendant", `${this.id}-opt-${this.active}`); else r.list.removeAttribute?.("aria-activedescendant");
      r.list.setAttribute?.("aria-busy", this.loading ? "true" : "false");
    }
    if (r.status) r.status.textContent = this.statusText();
    if (r.more) { r.more.hidden = this.next === null || (this.loading && !this.loadingMore); r.more.disabled = this.loading; r.more.textContent = this.loadingMore ? "Loading…" : "Load more"; }
    if (r.count) r.count.textContent = this.selected.size ? `${this.selected.size.toLocaleString()} selected` : "";
    if (r.all) r.all.setAttribute?.("aria-pressed", this.allShownSelected() ? "true" : "false");
  }

  // ---- DOM
  mount(root) {
    this.root = root;
    root.innerHTML = this.html();
    const q = (s) => root.querySelector?.(s) || null;
    this.refs = { q: q('[data-fvp="q"]'), list: q('[data-fvp="list"]'), status: q('[data-fvp-part="status"]'), more: q('[data-fvp="more"]'), count: q('[data-fvp-part="count"]'), all: q('[data-fvp="all"]') };
    this.handlers = { click: (e) => this.onClick(e), keydown: (e) => this.onKeydown(e), input: (e) => this.onInput(e) };
    for (const [k, h] of Object.entries(this.handlers)) root.addEventListener?.(k, h);
    this.render();
    this.fetch(false);
    return this;
  }
  focus() { try { this.refs.q?.focus?.({ preventScroll: true }); } catch { /* not focusable */ } }
  destroy() {
    this.destroyed = true; clearTimeout(this.timer); this.timer = null;
    try { this.ctrl?.abort?.(); } catch { /* done */ }
    if (this.root && this.handlers) for (const [k, h] of Object.entries(this.handlers)) this.root.removeEventListener?.(k, h);
    this.handlers = null;
  }
  onInput(e) { if (e?.target?.dataset?.fvp === "q") this.setQuery(e.target.value); }
  onClick(e) {
    const t = e?.target?.closest?.("[data-fvp]");
    if (!t) return;
    const what = t.dataset.fvp;
    if (what === "opt") { this.toggle(Number(t.dataset.i)); return; }
    if (what === "all") { this.selectAll(); return; }
    if (what === "clear") { this.clear(); return; }
    if (what === "more") { this.loadMore(); return; }
    if (what === "apply") { this.apply(); return; }
    if (what === "cancel") this.cancel();
  }
  onKeydown(e) {
    const where = e?.target?.dataset?.fvp, key = e?.key, stop = () => { e.preventDefault?.(); e.stopPropagation?.(); };
    if (key === "Escape") { stop(); this.cancel(); return; }
    if (where === "q") {
      if (key === "ArrowDown") { stop(); this.move(Math.max(this.active, 0)); try { this.refs.list?.focus?.({ preventScroll: true }); } catch { /* no focus */ } return; }
      if (key === "Enter") { stop(); this.apply(); }
      return;
    }
    if (where !== "list") return;
    const n = this.options().length;
    if (key === "ArrowDown") { stop(); this.move(this.active + 1); return; }
    if (key === "ArrowUp") { stop(); if (this.active <= 0) { this.focus(); return; } this.move(this.active - 1); return; }
    if (key === "Home") { stop(); this.move(0); return; }
    if (key === "End") { stop(); this.move(n - 1); return; }
    if (key === " " || key === "Spacebar") { stop(); if (this.active >= 0) this.toggle(this.active); return; }
    if (key === "Enter") { stop(); this.apply(); return; }
    if ((key === "a" || key === "A") && (e.ctrlKey || e.metaKey)) { stop(); this.selectAll(); }
  }
}
if (typeof window !== "undefined") window.FabricValuePicker = FabricValuePicker;
