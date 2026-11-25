// Fabric Data → compact column header menu and cell quick actions for the explorer grid. Read-only: nothing here edits data.
//
// Header menu (per column): Sort ascending / descending / Clear sort (only when the schema says the field is orderable; a
// column that leads a named sort keeps "Sort by this column"), Filter by this column… (opens F2's builder), a searchable value
// list (FabricValuePicker; Apply makes an `in` condition for this column), Clear filter on this column, Hide column, Choose
// columns…. Cell menu: Filter equals / does not equal this value (or is blank / is not blank, is on, is true/false by type),
// Copy value. Actions are offered only when the field's schema operators allow them and the explorer has the hook.
//
// The explorer (F2, FabricExplorer.js) is reached only through optional hooks, each checked with typeof:
//   applyFilter(model|null), openFilterFor(field), setOrderBy([[field, "asc"|"desc"], …]), getState() → {filter, dateFrom,
//   dateTo, orderBy}, hideColumn(name), schemaInfo() → {fields:[…advanced schema…]}, get(path, {signal}), fieldLabel(name).
// Without them the menu falls back to the explorer's current members (query, schema, toggleColumn/applyColumns, onAction) or
// leaves the item out. Routing: buttons carry data-action="fabric-c-menu" / "fabric-c-cell" with data-ds; the explorer passes
// fabric-c-* actions to FabricColumnMenu.onAction(explorer, action, target, event), and may pass the grid's contextmenu /
// Shift+F10 keydown to FabricColumnMenu.onContextMenu(explorer, event).
//
// The menu is drawn in one layer on <body> (so explorer redraws don't remove it), placed inside the viewport at every width
// (320–1920 px: a full-width sheet at ≤ 480 px), closed by Escape (focus goes back to the button or cell), a click outside or
// Tab out. Values come from the row data in memory (never from cell text) and are escaped wherever they are shown.
class FabricColumnMenu {
  static current = null;
  static MARGIN = 8;
  static SHEET_WIDTH = 480;
  static MAX_CONDITIONS = 20;
  static MAX_LIST = 200;
  static MAX_TEXT = 100;

  static esc(v) { return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
  static Picker() { try { return typeof FabricValuePicker !== "undefined" ? FabricValuePicker : (typeof window !== "undefined" ? window.FabricValuePicker : null); } catch { return typeof window !== "undefined" ? window.FabricValuePicker || null : null; } }
  static meta(x, field) { const P = FabricColumnMenu.Picker(); return P ? P.fieldMeta(x, field) : null; }
  static state(x) { const P = FabricColumnMenu.Picker(); return P ? P.state(x) : (x?.query || {}); }
  static hooks(x) {
    const fn = (n) => (x && typeof x[n] === "function" ? (...a) => x[n](...a) : null);
    const hide = fn("hideColumn") || (typeof x?.toggleColumn === "function" ? (name) => { if (!x.toggleColumn(name, false)) return false; x.columnsDirty = true; if (typeof x.applyColumns === "function") x.applyColumns(); return true; } : null);
    return { applyFilter: fn("applyFilter"), openFilterFor: fn("openFilterFor"), setOrderBy: fn("setOrderBy"), hideColumn: hide, announce: (t) => { try { x?.p?.announce?.(t); } catch { /* no live region */ } } };
  }
  static ops(meta) { return meta?.operators instanceof Set ? meta.operators : new Set(); }

  // ---- Filter model helpers (v1: {v, op:"and"|"or", items:[condition | group]}); pure, never mutate their input
  static isGroup(it) { return Boolean(it && typeof it === "object" && (it.op === "and" || it.op === "or") && Array.isArray(it.items) && !Object.hasOwn(it, "field")); }
  static onField(it, field) { return Boolean(it && (it.field === field || (FabricColumnMenu.isGroup(it) && it.items.length && it.items.every((c) => c && c.field === field)))); }
  static root(model) {
    if (!model || typeof model !== "object" || !Array.isArray(model.items)) return { v: 1, op: "and", items: [] };
    return JSON.parse(JSON.stringify({ v: model.v || 1, op: model.op === "or" ? "or" : "and", items: model.items }));
  }
  static countConditions(m) { let n = 0; for (const it of m.items) n += FabricColumnMenu.isGroup(it) ? it.items.length : 1; return n; }
  static hasField(model, field) {
    if (!model || !Array.isArray(model.items)) return false;
    return model.items.some((it) => it?.field === field || (FabricColumnMenu.isGroup(it) && it.items.some((c) => c?.field === field)));
  }
  // Every condition on the field removed (groups emptied by it go too; a one-item group becomes its item). null when empty.
  static withoutField(model, field) {
    const r = FabricColumnMenu.root(model);
    if (r.op === "or" && r.items.every((it) => FabricColumnMenu.onField(it, field))) return null;
    r.items = r.items.filter((it) => it?.field !== field).map((it) => {
      if (!FabricColumnMenu.isGroup(it)) return it;
      const items = it.items.filter((c) => c?.field !== field);
      return items.length === 1 ? items[0] : items.length ? { ...it, items } : null;
    }).filter(Boolean);
    return r.items.length ? r : null;
  }
  // The column's top-level condition replaced by `cond` (other columns and nested groups kept). undefined when it can't be done
  // without breaking the model's limits (depth 2, 20 conditions): the caller opens the builder instead.
  static setField(model, field, cond) {
    let r = FabricColumnMenu.root(model);
    if (r.op === "or" && r.items.length) {
      if (r.items.some((it) => FabricColumnMenu.isGroup(it))) return undefined;
      r = { v: r.v, op: "and", items: [{ op: "or", items: r.items }] };
    }
    r.items = r.items.filter((it) => !FabricColumnMenu.onField(it, field));
    if (cond) r.items.push(cond);
    if (FabricColumnMenu.countConditions(r) > FabricColumnMenu.MAX_CONDITIONS) return undefined;
    return r.items.length ? r : null;
  }
  // The values the column's quick filter already selects (for the picker), or [].
  static selectedValues(model, field) {
    if (!model || !Array.isArray(model.items)) return [];
    const out = [];
    const take = (c) => { if (c.op === "in" && Array.isArray(c.values)) out.push(...c.values); else if (c.op === "eq") out.push(c.value ?? null); else if (c.op === "blank") out.push(null); };
    for (const it of model.items) {
      if (it?.field === field) take(it);
      else if (FabricColumnMenu.isGroup(it) && it.op === "or" && FabricColumnMenu.onField(it, field)) it.items.forEach(take);
    }
    return out.filter((v) => v === null || typeof v === "string");
  }
  // The picker's choice → one condition (or an OR of `in` + `blank`). null = no filter on this column.
  static pickCondition(field, values, ops) {
    const list = (Array.isArray(values) ? values : []).filter((v) => v === null || typeof v === "string");
    if (!list.length) return null;
    const blank = list.includes(null), rest = [...new Set(list.filter((v) => v !== null))].slice(0, FabricColumnMenu.MAX_LIST);
    if (!rest.length) return ops.has("blank") ? { field, op: "blank" } : { field, op: "in", values: [null] };
    const inC = ops.has("in") || !ops.has("eq") || rest.length > 1 ? { field, op: "in", values: rest } : { field, op: "eq", value: rest[0] };
    if (!blank) return inC;
    return ops.has("blank") ? { op: "or", items: [inC, { field, op: "blank" }] } : { field, op: "in", values: [...rest.slice(0, FabricColumnMenu.MAX_LIST - 1), null] };
  }
  // "Does not equal": merged into an existing ne/nin on the column, or taken out of its `in` list.
  static excludeValue(model, field, value) {
    const r = FabricColumnMenu.root(model);
    const i = r.op === "and" ? r.items.findIndex((it) => it?.field === field && (it.op === "ne" || it.op === "nin" || it.op === "in")) : -1;
    if (i < 0) return FabricColumnMenu.addCondition(model, { field, op: "ne", value });
    const c = r.items[i];
    if (c.op === "in") { const values = c.values.filter((v) => v !== value); if (values.length) r.items[i] = { ...c, values }; else r.items.splice(i, 1); return r.items.length ? r : null; }
    const values = [...new Set([...(c.op === "nin" ? c.values : [c.value]), value])].slice(0, FabricColumnMenu.MAX_LIST);
    r.items[i] = values.length === 1 ? { field, op: "ne", value: values[0] } : { field, op: "nin", values };
    return r;
  }
  static addCondition(model, cond) {
    let r = FabricColumnMenu.root(model);
    if (r.op === "or" && r.items.length) { if (r.items.some((it) => FabricColumnMenu.isGroup(it))) return undefined; r = { v: r.v, op: "and", items: [{ op: "or", items: r.items }] }; }
    r.op = "and"; r.items.push(cond);
    return FabricColumnMenu.countConditions(r) > FabricColumnMenu.MAX_CONDITIONS ? undefined : r;
  }
  static orderOf(x, field) {
    const o = FabricColumnMenu.state(x).orderBy;
    if (!Array.isArray(o) || !o.length) return "";
    const first = o[0], f = Array.isArray(first) ? first[0] : first?.field, d = Array.isArray(first) ? first[1] : first?.dir;
    return f === field ? (d === "asc" ? "asc" : "desc") : "";
  }

  // ---- Cell values → conditions (the model's value forms: decimal text, YYYY-MM-DD dates, strings)
  static cellText(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v && typeof v === "object" && typeof v.$numberDecimal === "string") return v.$numberDecimal;
    try { return JSON.stringify(v); } catch { return ""; }
  }
  static cellFilters(meta, value) {
    const ops = FabricColumnMenu.ops(meta), field = meta?.name, out = [];
    if (!field || !ops.size) return out;
    const blank = value === null || value === undefined || (typeof value === "string" && !value.trim());
    if (blank) {
      if (ops.has("blank")) out.push({ id: "f-blank", label: "Filter: is blank", cond: { field, op: "blank" } });
      if (ops.has("notBlank")) out.push({ id: "f-notblank", label: "Filter: is not blank", cond: { field, op: "notBlank" } });
      return out;
    }
    const kind = meta.kind;
    if (kind === "bool" || typeof value === "boolean") {
      const t = value === true || value === "true";
      if (ops.has(t ? "isTrue" : "isFalse")) out.push({ id: "f-bool", label: `Filter: is ${t ? "true" : "false"}`, cond: { field, op: t ? "isTrue" : "isFalse" } });
      return out;
    }
    const text = FabricColumnMenu.cellText(value);
    if (!text || text.length > FabricColumnMenu.MAX_TEXT || /[\u0000-\u001f\u007f]/.test(text) || (value && typeof value === "object" && typeof value.$numberDecimal !== "string")) return out;
    const shown = text.length > 40 ? `${text.slice(0, 39)}…` : text;
    if (kind === "date") {
      const day = /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
      if (day && ops.has("on")) out.push({ id: "f-eq", label: `Filter: is on ${day}`, cond: { field, op: "on", value: day } });
      return out;
    }
    if (kind === "number" && !/^-?\d{1,34}(\.\d+)?$/.test(text)) return out; // the model's decimal text: no exponent
    if (ops.has("eq")) out.push({ id: "f-eq", label: `Filter: equals “${shown}”`, cond: { field, op: "eq", value: text } });
    if (ops.has("ne")) out.push({ id: "f-ne", label: `Filter: does not equal “${shown}” (blanks included)`, exclude: text });
    return out;
  }

  // ---- Items
  static headerItems(x, field) {
    const meta = FabricColumnMenu.meta(x, field), h = FabricColumnMenu.hooks(x), ops = FabricColumnMenu.ops(meta), items = [];
    const filter = FabricColumnMenu.state(x).filter;
    if (meta?.orderable && h.setOrderBy) {
      const cur = FabricColumnMenu.orderOf(x, field);
      items.push({ id: "sort-asc", label: "Sort ascending", radio: true, checked: cur === "asc" }, { id: "sort-desc", label: "Sort descending", radio: true, checked: cur === "desc" });
      if (cur) items.push({ id: "sort-clear", label: "Clear sort" });
    } else {
      let named = null;
      try { named = typeof x?.sortFor === "function" ? x.sortFor(field) : null; } catch { named = null; }
      if (named?.name) items.push({ id: "sort-named", label: "Sort by this column", sort: named.name });
    }
    if (items.length) items.push({ sep: true });
    if (h.openFilterFor && ops.size) items.push({ id: "filter", label: "Filter by this column…" });
    if (h.applyFilter && FabricColumnMenu.hasField(filter, field)) items.push({ id: "filter-clear", label: "Clear filter on this column" });
    if (items.length && !items.at(-1).sep) items.push({ sep: true });
    const cols = Array.isArray(x?.columns) ? x.columns : null;
    if (h.hideColumn && (!cols || cols.includes(field))) items.push({ id: "hide", label: "Hide column", disabled: Boolean(cols && cols.length <= 1) });
    if (typeof x?.onAction === "function") items.push({ id: "columns", label: "Choose columns…" });
    while (items.length && items.at(-1).sep) items.pop();
    return items;
  }
  static pickerAllowed(x, field) {
    const meta = FabricColumnMenu.meta(x, field), ops = FabricColumnMenu.ops(meta);
    return Boolean(FabricColumnMenu.Picker() && meta && !meta.sensitive && meta.valueSource !== "none" && (ops.has("in") || ops.has("eq")) && FabricColumnMenu.hooks(x).applyFilter);
  }
  static cellItems(x, field, value) {
    const meta = FabricColumnMenu.meta(x, field), h = FabricColumnMenu.hooks(x);
    const items = h.applyFilter && meta && !meta.sensitive ? FabricColumnMenu.cellFilters(meta, value) : [];
    if (items.length) items.push({ sep: true });
    items.push({ id: "copy", label: "Copy value", disabled: value === null || value === undefined || value === "" });
    return items;
  }
  static itemsHtml(items, id) {
    let n = 0;
    return items.map((it) => {
      if (it.sep) return `<li role="separator" class="fx-menu__sep"></li>`;
      const role = it.radio ? "menuitemradio" : "menuitem", first = n++ === 0;
      return `<li role="none"><button type="button" role="${role}" class="fx-menu__item" id="${id}-${it.id}" data-fcm="${it.id}" tabindex="${first ? 0 : -1}"${it.radio ? ` aria-checked="${it.checked ? "true" : "false"}"` : ""}${it.disabled ? ' aria-disabled="true"' : ""}><span class="fx-menu__check" aria-hidden="true">${it.checked ? "✓" : ""}</span><span class="fx-menu__label">${FabricColumnMenu.esc(it.label)}</span></button></li>`;
    }).join("");
  }

  // ---- Placement: inside the viewport with an 8 px margin; below the anchor, or above when there is more room there; a
  // full-width sheet on narrow screens. Pure (tests call it with 320 / 768 / 1440 px viewports).
  static place(anchor, size, viewport) {
    const m = FabricColumnMenu.MARGIN, vw = Math.max(0, viewport.width), vh = Math.max(0, viewport.height);
    const a = { left: anchor?.left ?? 0, right: anchor?.right ?? anchor?.left ?? 0, top: anchor?.top ?? 0, bottom: anchor?.bottom ?? anchor?.top ?? 0 };
    const sheet = vw <= FabricColumnMenu.SHEET_WIDTH;
    const width = sheet ? Math.max(0, vw - 2 * m) : Math.min(Math.max(0, size?.width || 0), vw - 2 * m);
    let left = sheet ? m : Math.min(Math.max(a.left, m), vw - m - width);
    if (!sheet && a.left + width > vw - m && a.right - width >= m) left = a.right - width; // right-align to the anchor near the edge
    left = Math.max(m, Math.min(left, vw - m - width));
    const below = vh - m - (a.bottom + 2), above = a.top - 2 - m, h = Math.max(0, size?.height || 0);
    const up = h > below && above > below;
    const maxHeight = Math.max(120, Math.floor(up ? above : below));
    let top = up ? a.top - 2 - Math.min(h, maxHeight) : a.bottom + 2;
    top = Math.max(m, Math.min(top, vh - m - Math.min(h, maxHeight)));
    return { left: Math.round(left), top: Math.round(top), width: Math.round(width), maxHeight: Math.min(maxHeight, Math.max(0, vh - 2 * m)), sheet };
  }
  static viewport() {
    const w = typeof window !== "undefined" ? window : {}, d = typeof document !== "undefined" ? document.documentElement : null;
    return { width: w.visualViewport?.width || w.innerWidth || d?.clientWidth || 1024, height: w.visualViewport?.height || w.innerHeight || d?.clientHeight || 768 };
  }

  // ---- Open / close
  static triggerHtml(x, field) {
    const ds = FabricColumnMenu.esc(x?.ds || ""), f = FabricColumnMenu.esc(field), meta = FabricColumnMenu.meta(x, field), label = FabricColumnMenu.esc(meta?.label || field);
    const filtered = FabricColumnMenu.hasField(FabricColumnMenu.state(x).filter, field);
    return `<button type="button" class="fx-colmenu__btn${filtered ? " is-filtered" : ""}" data-action="fabric-c-menu" data-ds="${ds}" data-field="${f}" data-focus-key="cmenu-${f}" aria-haspopup="dialog" aria-expanded="false" aria-label="Column options: ${label}${filtered ? " (filtered)" : ""}" title="Column options"><span aria-hidden="true">${filtered ? "⧩" : "▾"}</span></button>`;
  }
  // Names used by the explorer (02 §3 / FabricExplorer.js header): headerHtml = the trigger, cellMenu = open the cell menu.
  static headerHtml(x, field) { return FabricColumnMenu.triggerHtml(x, field); }
  static cellMenu(x, field, value, anchor = null) { return FabricColumnMenu.openCell(x, field, value, anchor); }
  static onAction(x, action, target) {
    const field = target?.dataset?.field;
    if (typeof field !== "string" || !field) return false;
    if (action === "fabric-c-menu") {
      const cur = FabricColumnMenu.current;
      if (cur && cur.kind === "header" && cur.field === field && cur.x === x) { FabricColumnMenu.close(true); return true; }
      FabricColumnMenu.openHeader(x, field, target); return true;
    }
    if (action === "fabric-c-cell") { const item = FabricColumnMenu.itemFor(x, target.dataset.id); if (!item) return false; FabricColumnMenu.openCell(x, field, item.values?.[field] ?? null, target, null, target.dataset.id); return true; }
    return false;
  }
  static itemFor(x, id) { const items = Array.isArray(x?.items) ? x.items : []; return typeof id === "string" && id ? items.find((i) => i && i.id === id) || null : null; }
  // A right-click (or Shift+F10 / the context-menu key) on a grid cell: the field from the column position, the value from the
  // row in memory.
  static onContextMenu(x, event) {
    const t = event?.target, cell = t?.closest?.("td, th[scope='row']"), tr = cell?.closest?.("tr");
    if (!cell || !tr || !t.closest?.(`[data-grid]`)) return false;
    const id = tr.dataset?.id, item = FabricColumnMenu.itemFor(x, id);
    const cols = (Array.isArray(x?.columns) ? x.columns : []).filter((n) => !x.info?.byName || x.info.byName.has(n));
    const field = cols[cell.cellIndex];
    if (!item || !field) return false;
    event.preventDefault?.();
    const point = Number.isFinite(event.clientX) && (event.clientX || event.clientY) ? { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY } : null;
    FabricColumnMenu.openCell(x, field, Object.hasOwn(item.values || {}, field) ? item.values[field] : null, cell, point, id);
    return true;
  }
  static openHeader(x, field, anchor) {
    const items = FabricColumnMenu.headerItems(x, field), picker = FabricColumnMenu.pickerAllowed(x, field);
    if (!items.length && !picker) return null;
    const meta = FabricColumnMenu.meta(x, field), label = meta?.label || field;
    return FabricColumnMenu.show({ x, kind: "header", field, anchor, items, picker, title: `${label}`, back: `[data-action="fabric-c-menu"][data-ds="${x?.ds}"][data-field="${FabricColumnMenu.cssEscape(field)}"]` });
  }
  static openCell(x, field, value, anchor, point = null, rowId = "") {
    const items = FabricColumnMenu.cellItems(x, field, value), meta = FabricColumnMenu.meta(x, field);
    return FabricColumnMenu.show({ x, kind: "cell", field, value, anchor, point, items, picker: false, title: `${meta?.label || field}`, back: rowId ? `[data-grid="${x?.ds}"] tr[data-id="${FabricColumnMenu.cssEscape(rowId)}"]` : `[data-grid="${x?.ds}"]` });
  }
  static cssEscape(v) { try { if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(v); } catch { /* fall through */ } return String(v).replace(/["\\\]]/g, "\\$&"); }
  static show(spec) {
    FabricColumnMenu.close(false);
    if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
    const id = `fcm-${Date.now().toString(36)}`, kindLabel = spec.kind === "header" ? "Column options" : "Cell actions";
    const layer = document.createElement("div");
    layer.className = "fx-menu-layer";
    const pickerHtml = spec.picker ? `<div class="fx-menu__section" role="group" aria-label="Filter by values"><p class="fx-menu__caption">Filter by values</p><div class="fx-menu__picker" data-fcm-picker></div></div>` : "";
    layer.innerHTML = `<div class="fx-menu${spec.picker ? " fx-menu--picker" : ""}" role="dialog" aria-label="${FabricColumnMenu.esc(`${kindLabel}: ${spec.title}`)}" id="${id}" data-fcm-root><p class="fx-menu__title">${FabricColumnMenu.esc(spec.title)}</p><ul class="fx-menu__list" role="menu" aria-label="${FabricColumnMenu.esc(kindLabel)}">${FabricColumnMenu.itemsHtml(spec.items, id)}</ul>${pickerHtml}</div>`;
    (document.body || document.documentElement)?.appendChild?.(layer);
    const box = layer.querySelector?.("[data-fcm-root]") || layer;
    const cur = { ...spec, id, layer, box, pickerObj: null, handlers: {} };
    FabricColumnMenu.current = cur;
    try { spec.anchor?.setAttribute?.("aria-expanded", "true"); } catch { /* not a button */ }
    if (spec.picker) {
      const P = FabricColumnMenu.Picker(), host = layer.querySelector?.("[data-fcm-picker]");
      if (P && host) {
        const ops = FabricColumnMenu.ops(FabricColumnMenu.meta(spec.x, spec.field));
        cur.pickerObj = new P(spec.x, spec.field, { selected: FabricColumnMenu.selectedValues(FabricColumnMenu.state(spec.x).filter, spec.field), onApply: (values) => FabricColumnMenu.applyPicked(spec.x, spec.field, values, ops), onCancel: () => FabricColumnMenu.close(true) });
        cur.pickerObj.mount(host);
      }
    }
    cur.handlers = {
      click: (e) => { const b = e?.target?.closest?.("[data-fcm]"); if (b && FabricColumnMenu.current === cur) { e.preventDefault?.(); FabricColumnMenu.run(b.dataset.fcm); } },
      keydown: (e) => FabricColumnMenu.onMenuKeydown(e),
      focusout: (e) => { const to = e?.relatedTarget; if (to && FabricColumnMenu.current === cur && !layer.contains?.(to)) FabricColumnMenu.close(false); }
    };
    for (const [k, h] of Object.entries(cur.handlers)) layer.addEventListener?.(k, h);
    cur.outside = (e) => { const t = e?.target; if (FabricColumnMenu.current !== cur || layer.contains?.(t) || (spec.anchor && spec.anchor.contains?.(t))) return; FabricColumnMenu.close(false); };
    cur.reflow = () => { if (FabricColumnMenu.current !== cur) return; if (spec.anchor && spec.anchor.isConnected === false && !spec.point) { FabricColumnMenu.close(false); return; } FabricColumnMenu.position(); };
    document.addEventListener?.("pointerdown", cur.outside, true);
    if (typeof window !== "undefined") { window.addEventListener?.("resize", cur.reflow); window.addEventListener?.("scroll", cur.reflow, true); }
    FabricColumnMenu.position();
    const first = layer.querySelector?.('[data-fcm]:not([aria-disabled="true"])');
    try { (first || cur.pickerObj?.refs?.q)?.focus?.({ preventScroll: true }); } catch { /* not focusable */ }
    return cur;
  }
  static position() {
    const cur = FabricColumnMenu.current;
    if (!cur) return null;
    const rect = cur.point || (typeof cur.anchor?.getBoundingClientRect === "function" ? cur.anchor.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0 });
    const r = typeof cur.box.getBoundingClientRect === "function" ? cur.box.getBoundingClientRect() : null;
    const size = { width: r?.width || (cur.picker ? 300 : 240), height: r?.height || (cur.picker ? 420 : 220) };
    const p = FabricColumnMenu.place(rect, size, FabricColumnMenu.viewport());
    const s = cur.box.style;
    if (s) { s.left = `${p.left}px`; s.top = `${p.top}px`; s.maxHeight = `${p.maxHeight}px`; if (p.sheet) s.width = `${p.width}px`; else s.width = ""; s.maxWidth = `${Math.max(0, FabricColumnMenu.viewport().width - 2 * FabricColumnMenu.MARGIN)}px`; }
    cur.box.classList?.toggle?.("is-sheet", p.sheet);
    cur.placed = p;
    return p;
  }
  static close(restore = true) {
    const cur = FabricColumnMenu.current;
    if (!cur) return;
    FabricColumnMenu.current = null;
    try { cur.pickerObj?.destroy(); } catch { /* gone */ }
    for (const [k, h] of Object.entries(cur.handlers || {})) cur.layer.removeEventListener?.(k, h);
    if (typeof document !== "undefined") document.removeEventListener?.("pointerdown", cur.outside, true);
    if (typeof window !== "undefined") { window.removeEventListener?.("resize", cur.reflow); window.removeEventListener?.("scroll", cur.reflow, true); }
    try { if (typeof cur.layer.remove === "function") cur.layer.remove(); else cur.layer.parentNode?.removeChild?.(cur.layer); } catch { /* detached */ }
    try { cur.anchor?.setAttribute?.("aria-expanded", "false"); } catch { /* not a button */ }
    if (!restore) return;
    let to = cur.anchor && cur.anchor.isConnected !== false ? cur.anchor : null;
    if (!to && typeof document !== "undefined") { try { to = document.querySelector?.(cur.back) || null; } catch { to = null; } }
    try { to?.focus?.({ preventScroll: true }); } catch { /* not focusable */ }
  }
  static onMenuKeydown(e) {
    const cur = FabricColumnMenu.current;
    if (!cur) return;
    if (e.key === "Escape") { e.preventDefault?.(); e.stopPropagation?.(); FabricColumnMenu.close(true); return; }
    const t = e.target;
    if (!t?.dataset?.fcm) return; // the picker handles its own keys
    const list = [...(cur.layer.querySelectorAll?.('[data-fcm]:not([aria-disabled="true"])') || [])];
    const i = list.indexOf(t);
    const go = (n) => { const el = list[(n + list.length) % list.length]; if (!el) return; for (const b of list) b.tabIndex = -1; el.tabIndex = 0; el.focus?.(); };
    if (e.key === "ArrowDown") { e.preventDefault?.(); go(i + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault?.(); go(i - 1); }
    else if (e.key === "Home") { e.preventDefault?.(); go(0); }
    else if (e.key === "End") { e.preventDefault?.(); go(list.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault?.(); FabricColumnMenu.run(t.dataset.fcm); }
  }

  // ---- Actions
  static apply(x, model, message) {
    const h = FabricColumnMenu.hooks(x);
    if (model === undefined) { h.announce("This filter is too complex for a quick change. Use Filters instead."); FabricColumnMenu.close(false); if (h.openFilterFor) h.openFilterFor(FabricColumnMenu.lastField); return false; }
    if (!h.applyFilter) return false;
    FabricColumnMenu.close(true);
    let res;
    try { res = h.applyFilter(model); } catch { res = { ok: false }; }
    if (res && res.ok === false) { h.announce("This filter couldn't be applied."); return false; }
    if (message) h.announce(message);
    return true;
  }
  static applyPicked(x, field, values, ops) {
    FabricColumnMenu.lastField = field;
    const cond = FabricColumnMenu.pickCondition(field, values, ops), filter = FabricColumnMenu.state(x).filter;
    const model = cond ? FabricColumnMenu.setField(filter, field, cond) : FabricColumnMenu.withoutField(filter, field);
    return FabricColumnMenu.apply(x, model, cond ? `Filter on ${FabricColumnMenu.meta(x, field)?.label || field} applied.` : `Filter on ${FabricColumnMenu.meta(x, field)?.label || field} cleared.`);
  }
  static run(id) {
    const cur = FabricColumnMenu.current;
    if (!cur) return;
    const { x, field } = cur, h = FabricColumnMenu.hooks(x), item = cur.items.find((it) => it.id === id);
    if (!item || item.disabled) return;
    FabricColumnMenu.lastField = field;
    const filter = FabricColumnMenu.state(x).filter;
    switch (id) {
      case "sort-asc": case "sort-desc": FabricColumnMenu.close(true); h.setOrderBy?.([[field, id === "sort-asc" ? "asc" : "desc"]]); return;
      case "sort-clear": FabricColumnMenu.close(true); h.setOrderBy?.([]); return;
      case "sort-named": FabricColumnMenu.close(true); x.onAction?.("fabric-x-sort", { dataset: { action: "fabric-x-sort", ds: x.ds, sort: item.sort } }); return;
      case "filter": FabricColumnMenu.close(false); h.openFilterFor?.(field); return;
      case "filter-clear": FabricColumnMenu.apply(x, FabricColumnMenu.withoutField(filter, field), `Filter on ${FabricColumnMenu.meta(x, field)?.label || field} cleared.`); return;
      case "hide": FabricColumnMenu.close(false); if (h.hideColumn?.(field) !== false) { try { (typeof document !== "undefined" ? document.querySelector?.(`[data-grid="${x.ds}"]`) : null)?.focus?.({ preventScroll: true }); } catch { /* none */ } } return;
      case "columns": FabricColumnMenu.close(false); x.onAction?.("fabric-x-columns", { dataset: { action: "fabric-x-columns", ds: x.ds, focusKey: "cols" } }); return;
      case "copy": FabricColumnMenu.copy(x, cur.value); return;
      default: break;
    }
    if (item.cond) { FabricColumnMenu.apply(x, FabricColumnMenu.setField(filter, field, item.cond), "Filter applied."); return; }
    if (item.exclude !== undefined) FabricColumnMenu.apply(x, FabricColumnMenu.excludeValue(filter, field, item.exclude), "Filter applied.");
  }
  static copy(x, value) {
    const text = FabricColumnMenu.cellText(value), h = FabricColumnMenu.hooks(x);
    FabricColumnMenu.close(true);
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
    if (!clip || typeof clip.writeText !== "function") { h.announce("Copying isn't available in this browser."); return Promise.resolve(false); }
    return Promise.resolve().then(() => clip.writeText(text)).then(() => { h.announce("Value copied."); return true; }, () => { h.announce("The value couldn't be copied."); return false; });
  }
}
if (typeof window !== "undefined") window.FabricColumnMenu = FabricColumnMenu;
