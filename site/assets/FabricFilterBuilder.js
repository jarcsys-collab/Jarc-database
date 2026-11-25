// Fabric Data → the advanced filter builder (Phase 7): an anchored popover under the Filters button (a full-screen drawer on
// phones), so the grid is never shrunk. It edits a DRAFT only (explorer.fb.draft and explorer.fb.dates); nothing is asked of the
// server until Apply. Cancel, Escape or the close button discard the draft and return focus to Filters.
//
// What it offers comes only from the schema the server sent (explorer.filterFields()): fields with operators (sensitive, dotted
// and disabled fields have none and are never listed), each field's own operator list (else the catalog for its kind, from
// FabricFilterModel), and value inputs by kind: text, number (text input, decimal text kept exactly), date, date range, relative
// date (N + unit), bool (no value), and lists (FabricValuePicker when the field has a value source and the picker is loaded; a
// tag input otherwise). Groups: AND/OR per group, one nested level (FabricFilterModel.LIMITS.maxDepth = 2).
// The Sales date window is its own control at the top: required, never removable (Clear all keeps it).
//
// Actions: fabric-f-* (FabricDataPanel routes them to the explorer named by data-ds, which calls onAction/onInput/onChange/
// onKeydown/onSubmit here). Every value is shown through the explorer's esc()/attr().
class FabricFilterBuilder {
  static M() { return FabricExplorer.global("FabricFilterModel"); }
  static Picker() { return FabricExplorer.global("FabricValuePicker"); }
  static pid(path) { return path === "" ? "root" : String(path).replace(/\./g, "-"); }
  static KIND_BADGE = { text: "Abc", number: "123", date: "Date", bool: "Yes/No", category: "List" };
  static KIND_NAME = { text: "text", number: "number", date: "date", bool: "yes/no", category: "category" };
  // Phones (fabric-filter.css ≤620): the builder covers the whole screen, so it is a modal dialog with a Tab trap (D4).
  static PHONE = "(max-width: 620px)";
  static phone() { try { return Boolean(typeof window !== "undefined" && window.matchMedia?.(FabricFilterBuilder.PHONE)?.matches); } catch { return false; } }
  // Tab / Shift+Tab inside the full-screen builder wrap from its last control to its first and back.
  static trapTab(form, event) {
    const list = [...form.querySelectorAll('button:not(:disabled), input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.hidden && !el.closest("[hidden]") && el.getClientRects().length > 0);
    if (!list.length) return false;
    const i = list.indexOf(document.activeElement), last = list.length - 1;
    if (event.shiftKey && i <= 0) { event.preventDefault(); list[last].focus(); return true; }
    if (!event.shiftKey && (i === last || i === -1)) { event.preventDefault(); list[0].focus(); return true; }
    return false;
  }

  // ---- State (lives on the explorer: x.fb)
  static fresh() { return { open: false, draft: null, dates: { dateFrom: "", dateTo: "" }, errors: [], picking: "", values: "", picker: null, tags: {}, notice: "" }; }
  static open(x, { field = "", preset = null } = {}) {
    const M = FabricFilterBuilder.M(); if (!M || !x.info) return false;
    const fb = x.fb;
    fb.draft = x.appliedModel() ? M.clone(x.appliedModel()) : M.empty();
    if (!M.isGroup(fb.draft)) fb.draft = M.empty();
    fb.dates = { dateFrom: x.query.dateFrom || "", dateTo: x.query.dateTo || "" };
    fb.errors = []; fb.picking = ""; fb.values = ""; fb.tags = {}; fb.notice = "";
    let focus = "fb-add-root";
    if (field) {
      const f = x.filterField(field);
      if (f) {
        const op = preset?.op && f.ops.includes(preset.op) ? preset.op : FabricFilterBuilder.defaultOp(f);
        const c = M.condition(f.name, op);
        if (preset && typeof preset === "object") { for (const k of ["value", "to", "values", "n", "unit"]) if (Object.hasOwn(preset, k)) c[k] = M.clone(preset[k]); }
        if (fb.draft.items.length < M.LIMITS.maxConditions) fb.draft.items.push(c);
        const path = String(fb.draft.items.length - 1);
        focus = M.arity(op) === "none" ? `fb-op-${path}` : M.arity(op) === "list" ? (FabricFilterBuilder.hasPicker(f) ? `fb-values-${path}` : `fb-tag-${path}`) : `fb-val-${path}`;
      } else fb.notice = "That column can't be used in filters.";
    }
    fb.open = true; x.chooser = false;
    x.redrawInPlace();
    x.focus(`[data-focus-key="${focus}"]`);
    return true;
  }
  static close(x, { focus = true } = {}) {
    const fb = x.fb; FabricFilterBuilder.destroyPicker(x);
    fb.open = false; fb.draft = null; fb.errors = []; fb.picking = ""; fb.values = ""; fb.tags = {}; fb.notice = "";
    x.redrawInPlace(`[data-focus-key="filters"]`);
    if (focus) x.focus(`[data-action="fabric-x-filters"][data-ds="${x.ds}"]`);
  }
  static defaultOp(f) { const prefer = { category: "in", text: "contains", number: "eq", date: "between", bool: "isTrue" }[f.kind]; return f.ops.includes(prefer) ? prefer : f.ops[0]; }
  static hasPicker(f) { return Boolean(f && (f.valueSource === "distinct" || f.valueSource === "search") && typeof FabricFilterBuilder.Picker() === "function"); }
  static dirty(x) {
    const M = FabricFilterBuilder.M(), fb = x.fb;
    if (!fb.open || !M) return false;
    return !M.same(fb.draft, x.appliedModel()) || (fb.dates.dateFrom || "") !== (x.query.dateFrom || "") || (fb.dates.dateTo || "") !== (x.query.dateTo || "") || Object.values(fb.tags).some((t) => String(t || "").trim());
  }

  // ---- Validation (before Apply): the model check (FabricFilterModel.validate against the schema's fields) plus the window.
  static windowErrors(x, dates) {
    const { dateFrom: from, dateTo: to } = dates, out = [];
    if (!x.datesApply() || (!from && !to)) return out;
    if (!FabricExplorer.isDay(from) || !FabricExplorer.isDay(to)) out.push({ path: "window", message: "Enter both dates as real days, or leave both empty for the default window." });
    else if (from > to) out.push({ path: "window", message: "The start date must be on or before the end date." });
    else { const max = x.maxDays, days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1; if (max && days > max) out.push({ path: "window", message: `The date window can be at most ${max} days (this one is ${days}).` }); }
    return out;
  }
  static validate(x) {
    const M = FabricFilterBuilder.M(), fb = x.fb;
    FabricFilterBuilder.flushTags(x);
    const fields = new Map(x.filterFields().map((f) => [f.name, { kind: f.kind, operators: f.ops }]));
    const errors = [...FabricFilterBuilder.windowErrors(x, fb.dates)];
    const r = M.validate(fb.draft, fields);
    errors.push(...r.errors);
    if (x.legacyFilters()) {
      const seen = new Set();
      M.conditions(fb.draft).forEach(({ path, condition }) => { if (seen.has(condition.field)) errors.push({ path, message: "Only one condition per field can be used here." }); seen.add(condition.field); });
    }
    return errors;
  }
  // Text typed in a tag input but not yet added (no Enter) counts when applying.
  static flushTags(x) {
    const M = FabricFilterBuilder.M(), fb = x.fb;
    for (const [path, text] of Object.entries(fb.tags)) {
      const c = M.at(fb.draft, path), t = String(text || "").trim();
      if (c && !M.isGroup(c) && M.arity(c.op) === "list" && t) FabricFilterBuilder.addTags(x, c, t);
    }
    fb.tags = {};
  }
  static addTags(x, c, text) {
    const L = FabricFilterBuilder.M().LIMITS, f = x.filterField(c.field);
    const parts = String(text).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    c.values = Array.isArray(c.values) ? c.values : [];
    for (const p of parts) { const v = f?.kind === "number" ? p : p.slice(0, L.maxText); if (!c.values.includes(v) && c.values.length < L.maxListValues) c.values.push(v); }
  }
  static apply(x) {
    const M = FabricFilterBuilder.M(), fb = x.fb;
    const errors = FabricFilterBuilder.validate(x);
    if (errors.length) {
      fb.errors = errors; x.redrawInPlace();
      const first = errors[0], key = first.path === "window" ? "fb-from" : first.path === "" ? "fb-apply" : FabricFilterBuilder.firstKey(x, first.path);
      x.focus(`[data-focus-key="${key}"]`);
      x.p.announce(`${errors.length === 1 ? "1 problem" : `${errors.length} problems`} to fix before applying: ${first.message}`);
      return false;
    }
    const model = M.canonical(fb.draft), dates = x.datesApply() ? { dateFrom: fb.dates.dateFrom || "", dateTo: fb.dates.dateTo || "" } : {};
    FabricFilterBuilder.destroyPicker(x);
    fb.open = false; fb.draft = null; fb.errors = []; fb.picking = ""; fb.values = ""; fb.tags = {};
    x.commitFilter(model, dates);
    x.focus(`[data-action="fabric-x-filters"][data-ds="${x.ds}"]`);
    const n = model ? M.count(model) : 0;
    x.p.announce(n ? `Filter applied: ${n} condition${n === 1 ? "" : "s"}.` : "Filter applied.");
    return true;
  }
  static firstKey(x, path) {
    const M = FabricFilterBuilder.M(), c = M.at(x.fb.draft, path);
    if (!c || M.isGroup(c)) return `fb-add-${FabricFilterBuilder.pid(path)}`;
    if (!c.field) return `fb-field-${path}`;
    const a = M.arity(c.op), f = x.filterField(c.field);
    return a === "none" ? `fb-op-${path}` : a === "list" ? (FabricFilterBuilder.hasPicker(f) ? `fb-values-${path}` : `fb-tag-${path}`) : a === "relative" ? `fb-n-${path}` : `fb-val-${path}`;
  }

  // ---- Markup
  static html(x) {
    const M = FabricFilterBuilder.M(), fb = x.fb, ds = x.ds;
    if (!fb.open || !M || !fb.draft) return "";
    const e = (v) => x.esc(v), a = (v) => x.attr(v);
    const dirty = FabricFilterBuilder.dirty(x), legacy = x.legacyFilters();
    const top = fb.errors.filter((er) => er.path === "");
    const state = dirty ? `<span class="fx-fb__state is-draft">Not applied yet</span>` : `<span class="fx-fb__state">Matches what is applied</span>`;
    const saved = FabricExplorer.global("FabricSavedFilters");
    const save = saved && typeof saved.onAction === "function" && !legacy ? `<button type="button" class="fx-btn" data-action="fabric-f-save" data-ds="${ds}" data-focus-key="fb-save" title="Apply these filters, then save them under a name"><span>Save filter</span></button>` : "";
    const summary = fb.errors.length ? `<p class="fx-fb__summary" id="fabric-${ds}-fb-summary" role="alert">${fb.errors.length === 1 ? "1 problem" : `${fb.errors.length} problems`} to fix before applying.${top.map((er) => ` ${e(er.message)}`).join("")}</p>` : "";
    const notice = fb.notice ? `<p class="fx-fb__notice" role="status">${e(fb.notice)}</p>` : "";
    const legacyNote = legacy ? `<p class="fx-fb__notice">This dataset offers exact-value filters only (equals), one per field.</p>` : "";
    return `<form class="fx-fb" id="fabric-${ds}-fb" role="dialog" aria-modal="${FabricFilterBuilder.phone() ? "true" : "false"}" aria-labelledby="fabric-${ds}-fb-title" data-action="fabric-f-form" data-ds="${ds}" novalidate>
      <header class="fx-fb__head"><h2 class="fx-fb__title" id="fabric-${ds}-fb-title">Filters</h2>${state}<button type="button" class="fx-btn fx-btn--icon fx-fb__close" data-action="fabric-f-cancel" data-ds="${ds}" data-focus-key="fb-close" aria-label="Close without applying" title="Close without applying">${typeof icon === "function" ? icon("close") : "×"}</button></header>
      <div class="fx-fb__body">${notice}${legacyNote}${FabricFilterBuilder.windowHtml(x)}${FabricFilterBuilder.groupHtml(x, fb.draft, "", 1)}</div>
      <footer class="fx-fb__foot">${summary}<button type="button" class="fx-btn" data-action="fabric-f-clear" data-ds="${ds}" data-focus-key="fb-clear"${M.count(fb.draft) ? "" : " disabled"}>Clear all</button>${save}<span class="fx-fb__spacer"></span><button type="button" class="fx-btn" data-action="fabric-f-cancel" data-ds="${ds}" data-focus-key="fb-cancel">Cancel</button><button type="submit" class="fx-btn fx-btn--primary" data-action="fabric-f-apply" data-ds="${ds}" data-focus-key="fb-apply">Apply</button></footer>
    </form>`;
  }
  // The date window: its own control, not a condition. Required (no remove, kept by Clear all) where the schema says so.
  static windowHtml(x) {
    const ds = x.ds, fb = x.fb, info = x.info, e = (v) => x.esc(v), a = (v) => x.attr(v);
    if (!info.dateField && !x.windowRequired()) return "";
    const required = x.windowRequired(), on = x.datesApply(), max = x.maxDays, err = fb.errors.filter((er) => er.path === "window");
    const shown = x.shownWindow(), def = x.defaultDays();
    const placeholderNote = !fb.dates.dateFrom && !fb.dates.dateTo && shown.dateFrom ? ` The default window is ${shown.dateFrom} – ${shown.dateTo}.` : "";
    const help = !on ? "This sort lists one company's rows by entry number; dates don't apply to it." : `${info.dateField ? `Dates filter ${x.fieldLabel(info.dateField)} (${info.dateField}), UTC days. ` : ""}${max ? `Up to ${max} days. ` : ""}${required ? `Leave both empty for the default window${def ? ` (the latest ${def} days)` : ""}.` : "Leave both empty for all dates."}${placeholderNote}`;
    const errId = `fabric-${ds}-fb-err-window`, inv = err.length ? ` aria-invalid="true" aria-describedby="${errId} fabric-${ds}-range-help"` : ` aria-describedby="fabric-${ds}-range-help"`, off = on ? "" : " disabled";
    return `<fieldset class="fx-fb__window${required ? " is-required" : ""}"><legend>Date window${required ? ` <span class="fx-fb__req">required</span>` : ""}</legend>
      <div class="fx-fb__row"><label class="fx-fb__lbl">From (UTC)<input id="fabric-${ds}-from" type="date" data-action="fabric-f-date" data-ds="${ds}" data-edge="from" data-focus-key="fb-from" value="${a(fb.dates.dateFrom || "")}"${inv}${off}></label>
      <label class="fx-fb__lbl">To (UTC)<input id="fabric-${ds}-to" type="date" data-action="fabric-f-date" data-ds="${ds}" data-edge="to" data-focus-key="fb-to" value="${a(fb.dates.dateTo || "")}"${inv}${off}></label>
      <button type="button" class="fx-btn" data-action="fabric-f-default-window" data-ds="${ds}" data-focus-key="fb-default-window"${(fb.dates.dateFrom || fb.dates.dateTo) && on ? "" : " disabled"}>${required ? "Use the default window" : "All dates"}</button></div>
      <p id="fabric-${ds}-range-help" class="fabric-help fx-fb__help">${e(help)}</p>${err.map((er) => `<p class="fx-fb__err" id="${errId}" role="alert">${e(er.message)}</p>`).join("")}</fieldset>`;
  }
  static groupHtml(x, g, path, depth) {
    const M = FabricFilterBuilder.M(), ds = x.ds, pid = FabricFilterBuilder.pid(path), legacy = x.legacyFilters();
    const items = g.items.map((it, i) => { const p = path === "" ? String(i) : `${path}.${i}`; return M.isGroup(it) ? `<li class="fx-fb__item">${FabricFilterBuilder.groupHtml(x, it, p, depth + 1)}</li>` : FabricFilterBuilder.conditionHtml(x, it, p); }).join("");
    const full = M.count(x.fb.draft) >= M.LIMITS.maxConditions, groupsFull = M.groupCount(x.fb.draft) >= M.LIMITS.maxGroups;
    const join = legacy ? `<span class="fx-fb__jointext">All of these (AND)</span>` : `<label class="fx-fb__join">Match<select data-action="fabric-f-join" data-ds="${ds}" data-path="${path}" data-focus-key="fb-join-${pid}" aria-label="${depth === 1 ? "Match" : "Match in this group"}"><option value="and"${g.op === "and" ? " selected" : ""}>all of these (AND)</option><option value="or"${g.op === "or" ? " selected" : ""}>any of these (OR)</option></select></label>`;
    const removeGroup = depth > 1 ? `<button type="button" class="fx-btn fx-btn--icon" data-action="fabric-f-remove" data-ds="${ds}" data-path="${path}" data-focus-key="fb-remove-${path}" aria-label="Remove this group" title="Remove this group">${typeof icon === "function" ? icon("trash") : "×"}</button>` : "";
    const empty = !g.items.length ? `<li class="fx-fb__empty">${depth === 1 ? "No conditions yet. Add one to narrow the rows." : "This group is empty."}</li>` : "";
    const err = x.fb.errors.filter((er) => er.path === path && path !== "").map((er) => `<p class="fx-fb__err" role="alert">${x.esc(er.message)}</p>`).join("");
    const addGroup = depth === 1 && !legacy ? `<button type="button" class="fx-btn" data-action="fabric-f-add-group" data-ds="${ds}" data-focus-key="fb-addgroup"${full || groupsFull ? " disabled" : ""} title="A nested group joins its conditions with its own AND / OR">+ Add group</button>` : "";
    return `<div class="fx-fb__group fx-fb__group--d${depth}" role="group" aria-label="${depth === 1 ? "Conditions" : "Nested group"}">
      <div class="fx-fb__grouphead">${join}${removeGroup}</div>${err}
      <ol class="fx-fb__items">${items}${empty}</ol>
      <div class="fx-fb__groupfoot"><button type="button" class="fx-btn" data-action="fabric-f-add" data-ds="${ds}" data-path="${path}" data-focus-key="fb-add-${pid}"${full ? " disabled" : ""}>+ Add condition</button>${addGroup}${full ? `<span class="fx-fb__limit">At most ${M.LIMITS.maxConditions} conditions.</span>` : ""}</div></div>`;
  }
  static fieldButton(x, c, path) {
    const ds = x.ds, f = c.field ? x.filterField(c.field) : null, open = x.fb.picking === path, kind = f?.kind || "";
    const text = f ? `<span class="fx-fb__fieldlabel">${x.esc(x.fieldLabel(f.name))}</span><code class="fx-fb__fieldid">${x.esc(f.name)}</code><span class="fx-fb__kind" title="${x.attr(FabricFilterBuilder.KIND_NAME[kind] || kind)}">${FabricFilterBuilder.KIND_BADGE[kind] || ""}</span>` : c.field ? `<span class="fx-fb__fieldlabel">${x.esc(c.field)}</span><span class="fx-fb__kind is-bad">unavailable</span>` : `<span class="fx-fb__fieldlabel is-empty">Choose a field</span>`;
    return `<button type="button" class="fx-fb__field" id="fabric-${ds}-fb-field-${FabricFilterBuilder.pid(path)}" data-action="fabric-f-pick" data-ds="${ds}" data-path="${path}" data-focus-key="fb-field-${path}" aria-haspopup="listbox" aria-expanded="${open}" aria-label="Field: ${x.attr(f ? `${x.fieldLabel(f.name)} (${f.name}, ${FabricFilterBuilder.KIND_NAME[kind] || kind})` : "none chosen")}">${text}<span class="fx-fb__caret" aria-hidden="true">▾</span></button>${open ? FabricFilterBuilder.pickerHtml(x, path) : ""}`;
  }
  // The searchable field list: friendly label, exact id and a type badge; only filterable fields. Typing filters in place.
  static pickerHtml(x, path) {
    const ds = x.ds, pid = FabricFilterBuilder.pid(path), current = FabricFilterBuilder.M().at(x.fb.draft, path)?.field || "";
    const rows = x.filterFields().map((f) => {
      const label = x.fieldLabel(f.name), key = `${label} ${f.name}`.toLowerCase();
      return `<li role="presentation" data-fb-key="${x.attr(key)}"><button type="button" role="option" class="fx-fb__opt${f.name === current ? " is-current" : ""}" aria-selected="${f.name === current}" data-action="fabric-f-field" data-ds="${ds}" data-path="${path}" data-field="${x.attr(f.name)}" data-focus-key="fb-opt-${x.attr(f.name)}"><span class="fx-fb__optlabel">${x.esc(label)}</span><code>${x.esc(f.name)}</code><span class="fx-fb__kind">${FabricFilterBuilder.KIND_BADGE[f.kind] || ""}</span></button></li>`;
    }).join("");
    return `<div class="fx-fb__picker" id="fabric-${ds}-fb-picker" role="group" aria-label="Choose a field"><span class="fx-search fx-fb__pickersearch"><span class="fx-search__icon" aria-hidden="true">${typeof icon === "function" ? icon("search") : ""}</span><input id="fabric-${ds}-fb-fieldq" class="fx-search__input" type="search" data-action="fabric-f-fieldq" data-ds="${ds}" data-path="${path}" data-focus-key="fb-fieldq" maxlength="64" autocomplete="off" placeholder="Find a field" aria-label="Find a field" aria-controls="fabric-${ds}-fb-fields-${pid}"></span><ul class="fx-fb__fields" id="fabric-${ds}-fb-fields-${pid}" role="listbox" aria-label="Fields">${rows || `<li class="fx-fb__empty">No fields can be filtered.</li>`}</ul><p class="fx-fb__none" data-fb-none hidden>No field matches.</p></div>`;
  }
  static conditionHtml(x, c, path) {
    const M = FabricFilterBuilder.M(), ds = x.ds, pid = FabricFilterBuilder.pid(path), f = c.field ? x.filterField(c.field) : null;
    const errs = x.fb.errors.filter((er) => er.path === path), errId = `fabric-${ds}-fb-err-${pid}`;
    const inv = errs.length ? ` aria-invalid="true" aria-describedby="${errId}"` : "";
    let op = "", value = "";
    if (f) {
      op = `<select class="fx-fb__op" id="fabric-${ds}-fb-op-${pid}" data-action="fabric-f-op" data-ds="${ds}" data-path="${path}" data-focus-key="fb-op-${path}" aria-label="Operator for ${x.attr(x.fieldLabel(f.name))}">${f.ops.map((o) => `<option value="${o}"${o === c.op ? " selected" : ""}>${x.esc(M.label(o))}</option>`).join("")}</select>`;
      value = FabricFilterBuilder.valueHtml(x, f, c, path, inv);
    }
    const tools = `<span class="fx-fb__tools"><button type="button" class="fx-btn fx-btn--icon" data-action="fabric-f-dup" data-ds="${ds}" data-path="${path}" data-focus-key="fb-dup-${path}" aria-label="Duplicate this condition" title="Duplicate"${M.count(x.fb.draft) >= M.LIMITS.maxConditions || x.legacyFilters() ? " disabled" : ""}>${typeof icon === "function" ? icon("copy") : "⧉"}</button><button type="button" class="fx-btn fx-btn--icon" data-action="fabric-f-remove" data-ds="${ds}" data-path="${path}" data-focus-key="fb-remove-${path}" aria-label="Remove this condition" title="Remove">${typeof icon === "function" ? icon("close") : "×"}</button></span>`;
    const err = errs.map((er) => `<p class="fx-fb__err" id="${errId}" role="alert">${x.esc(er.message)}</p>`).join("");
    return `<li class="fx-fb__item fx-fb__cond${errs.length ? " is-invalid" : ""}" data-path="${path}"><div class="fx-fb__condrow">${FabricFilterBuilder.fieldButton(x, c, path)}${op}${value}${tools}</div>${err}</li>`;
  }
  static valueHtml(x, f, c, path, inv) {
    const M = FabricFilterBuilder.M(), ds = x.ds, pid = FabricFilterBuilder.pid(path), a = M.arity(c.op), label = x.attr(x.fieldLabel(f.name));
    const common = (edge) => `data-ds="${ds}" data-path="${path}" data-edge="${edge}"${inv}`;
    const input = (edge, aria) => {
      const v = c[edge] === null ? "" : c[edge] ?? "", key = edge === "to" ? `fb-to-${path}` : `fb-val-${path}`, id = `fabric-${ds}-fb-${edge}-${pid}`;
      if (f.kind === "date") return `<input class="fx-fb__val" id="${id}" type="date" data-action="fabric-f-value" ${common(edge)} data-focus-key="${key}" value="${x.attr(v)}" aria-label="${aria}">`;
      if (f.kind === "number") return `<input class="fx-fb__val" id="${id}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="70" data-action="fabric-f-value" ${common(edge)} data-focus-key="${key}" value="${x.attr(v)}" placeholder="Number" aria-label="${aria}">`;
      const ph = c[edge] === null ? "(blank)" : "Value";
      return `<input class="fx-fb__val" id="${id}" type="text" autocomplete="off" spellcheck="false" maxlength="${M.LIMITS.maxText}" data-action="fabric-f-value" ${common(edge)} data-focus-key="${key}" value="${x.attr(v)}" placeholder="${ph}" aria-label="${aria}">`;
    };
    if (a === "none") return "";
    if (a === "value") {
      const choose = FabricFilterBuilder.hasPicker(f) ? `<button type="button" class="fx-btn" data-action="fabric-f-values" data-ds="${ds}" data-path="${path}" data-focus-key="fb-values-${path}" aria-expanded="${x.fb.values === path}">Choose…</button>` : "";
      return `<span class="fx-fb__vals">${input("value", `Value for ${label}`)}${choose}</span>${x.fb.values === path ? FabricFilterBuilder.pickerMountHtml(x, path) : ""}`;
    }
    if (a === "range") return `<span class="fx-fb__vals fx-fb__range">${input("value", `From value for ${label}`)}<span class="fx-fb__and">and</span>${input("to", `To value for ${label}`)}</span>`;
    if (a === "relative") {
      const n = c.n === undefined || c.n === null ? "" : String(c.n);
      return `<span class="fx-fb__vals fx-fb__rel"><input class="fx-fb__val fx-fb__n" id="fabric-${ds}-fb-n-${pid}" type="number" inputmode="numeric" min="1" max="${M.LIMITS.maxN}" step="1" data-action="fabric-f-value" ${common("n")} data-focus-key="fb-n-${path}" value="${x.attr(n)}" aria-label="How many, for ${label}"><select data-action="fabric-f-unit" data-ds="${ds}" data-path="${path}" data-focus-key="fb-unit-${path}" aria-label="Unit for ${label}">${M.UNITS.map((u) => `<option value="${u}"${u === c.unit ? " selected" : ""}>${u}</option>`).join("")}</select></span>`;
    }
    // list: chosen values as removable tags; the value picker (server values) when available, else type and press Enter.
    const vals = Array.isArray(c.values) ? c.values : [];
    const tags = vals.map((v, i) => `<span class="fx-fb__tag"><span class="fx-fb__tagtext">${v === null ? "<em>(blank)</em>" : v === "" ? "<em>(empty text)</em>" : x.esc(v)}</span><button type="button" class="fx-fb__tagx" data-action="fabric-f-tag-remove" data-ds="${ds}" data-path="${path}" data-i="${i}" data-focus-key="fb-tagx-${path}-${i}" aria-label="Remove ${x.attr(v === null ? "(blank)" : v)}">×</button></span>`).join("");
    if (FabricFilterBuilder.hasPicker(f)) {
      return `<span class="fx-fb__vals fx-fb__list"><span class="fx-fb__tags" role="list" aria-label="Chosen values">${tags || `<span class="fx-fb__placeholder">No values chosen</span>`}</span><button type="button" class="fx-btn" data-action="fabric-f-values" data-ds="${ds}" data-path="${path}" data-focus-key="fb-values-${path}" aria-expanded="${x.fb.values === path}"${inv}>${vals.length ? `${vals.length} chosen · Change…` : "Choose values…"}</button></span>${x.fb.values === path ? FabricFilterBuilder.pickerMountHtml(x, path) : ""}`;
    }
    const pending = x.fb.tags[path] || "";
    return `<span class="fx-fb__vals fx-fb__list"><span class="fx-fb__tags" role="list" aria-label="Chosen values">${tags}</span><input class="fx-fb__val fx-fb__taginput" id="fabric-${ds}-fb-tag-${pid}" type="text" autocomplete="off" spellcheck="false" maxlength="${M.LIMITS.maxText}" data-action="fabric-f-tag" data-ds="${ds}" data-path="${path}" data-focus-key="fb-tag-${path}" value="${x.attr(pending)}" placeholder="Type a value, press Enter" aria-label="Add a value for ${label} (Enter adds it)"${inv}></span>`;
  }
  // The value picker (FabricValuePicker, F3) is mounted into this element after it is drawn (syncPicker).
  static pickerMountHtml(x, path) { return `<div class="fx-fb__vpick" id="fabric-${x.ds}-fb-vp" data-path="${path}"></div>`; }
  static syncPicker(x) {
    const fb = x.fb, P = FabricFilterBuilder.Picker(), M = FabricFilterBuilder.M();
    if (typeof document === "undefined") return;
    const el = fb.open && fb.values ? document.querySelector(`#fabric-${x.ds}-fb-vp`) : null;
    if (!el || typeof P !== "function") { FabricFilterBuilder.destroyPicker(x); return; }
    if (fb.picker && fb.picker.el === el && fb.picker.path === fb.values) return;
    FabricFilterBuilder.destroyPicker(x);
    const path = fb.values, c = M.at(fb.draft, path);
    if (!c || M.isGroup(c)) return;
    const multi = M.arity(c.op) === "list";
    const back = () => x.focus(`[data-focus-key="fb-values-${path}"]`);
    let inst;
    try {
      inst = new P(x, c.field, {
        multi, selected: multi ? (c.values || []) : c.value === undefined || c.value === "" ? [] : [c.value],
        onApply(values) { const cur = M.at(x.fb.draft, path); if (cur && !M.isGroup(cur)) { if (multi) cur.values = values.slice(0, M.LIMITS.maxListValues); else cur.value = values.length ? values[0] : ""; } x.fb.values = ""; x.redrawInPlace(); back(); },
        onCancel() { x.fb.values = ""; x.redrawInPlace(); back(); }
      });
      inst.mount(el); inst.focus?.();
    } catch { inst = null; }
    fb.picker = inst ? { el, path, inst } : null;
  }
  static destroyPicker(x) { const p = x.fb.picker; if (p) { try { p.inst.destroy(); } catch { /* gone */ } } x.fb.picker = null; }

  // ---- Field list filter (in place: typing never redraws)
  static filterFieldList(x, term) {
    if (typeof document === "undefined") return;
    const t = String(term || "").trim().toLowerCase(); let shown = 0;
    document.querySelectorAll(`#fabric-${x.ds}-fb-picker [data-fb-key]`).forEach((li) => { const hide = Boolean(t && !li.dataset.fbKey.includes(t)); li.hidden = hide; if (!hide) shown += 1; });
    const none = document.querySelector(`#fabric-${x.ds}-fb-picker [data-fb-none]`); if (none) none.hidden = shown > 0;
  }
  static visibleOptions(x) { if (typeof document === "undefined") return []; return [...document.querySelectorAll(`#fabric-${x.ds}-fb-picker [data-fb-key]:not([hidden]) [role="option"]`)]; }

  // ---- Events
  static edit(x, fn, focusKey = "") {
    const M = FabricFilterBuilder.M(), fb = x.fb;
    const next = fn(M.clone(fb.draft));
    if (next) fb.draft = next;
    fb.errors = []; fb.notice = "";
    x.redrawInPlace();
    if (focusKey) x.focus(`[data-focus-key="${focusKey}"]`);
  }
  static onAction(x, action, target) {
    const M = FabricFilterBuilder.M(), fb = x.fb, path = target?.dataset?.path ?? "";
    if (!M || !fb.open) return false;
    if (action === "fabric-f-cancel") { FabricFilterBuilder.close(x); return true; }
    if (action === "fabric-f-apply") { FabricFilterBuilder.apply(x); return true; }
    if (action === "fabric-f-save") {
      const S = FabricExplorer.global("FabricSavedFilters");
      if (FabricFilterBuilder.dirty(x) && !FabricFilterBuilder.apply(x)) return true;
      if (fb.open) FabricFilterBuilder.close(x, { focus: false });
      if (S && typeof S.onAction === "function") S.onAction(x, "fabric-s-save", { dataset: { action: "fabric-s-save", ds: x.ds } });
      return true;
    }
    if (action === "fabric-f-clear") { FabricFilterBuilder.edit(x, (m) => ({ ...m, items: [] }), "fb-add-root"); x.p.announce("All conditions removed from the draft. Apply to use it."); return true; }
    if (action === "fabric-f-default-window") { fb.dates = { dateFrom: "", dateTo: "" }; fb.errors = fb.errors.filter((er) => er.path !== "window"); x.redrawInPlace(); x.focus(`[data-focus-key="fb-from"]`); return true; }
    if (action === "fabric-f-add") {
      const group = M.at(fb.draft, path);
      if (!M.isGroup(group) || M.count(fb.draft) >= M.LIMITS.maxConditions) return true;
      const newPath = path === "" ? String(group.items.length) : `${path}.${group.items.length}`;
      fb.picking = newPath;
      FabricFilterBuilder.edit(x, (m) => { M.at(m, path).items.push({ field: "", op: "" }); return m; }, "fb-fieldq");
      return true;
    }
    if (action === "fabric-f-add-group") {
      if (M.count(fb.draft) >= M.LIMITS.maxConditions || M.groupCount(fb.draft) >= M.LIMITS.maxGroups) return true;
      const i = fb.draft.items.length; fb.picking = `${i}.0`;
      FabricFilterBuilder.edit(x, (m) => { m.items.push({ op: m.op === "and" ? "or" : "and", items: [{ field: "", op: "" }] }); return m; }, "fb-fieldq");
      return true;
    }
    if (action === "fabric-f-remove") {
      const parts = M.parsePath(path); if (!parts || !parts.length) return true;
      FabricFilterBuilder.destroyPicker(x); fb.picking = ""; fb.values = "";
      const parent = parts.slice(0, -1).join(".");
      FabricFilterBuilder.edit(x, (m) => M.removeAt(m, path));
      // Focus: the next item's remove button, else the group's "Add condition".
      const still = M.at(fb.draft, path);
      x.focus(still && !M.isGroup(still) ? `[data-focus-key="fb-remove-${path}"]` : `[data-focus-key="fb-add-${parent === "" || !M.isGroup(M.at(fb.draft, parent)) ? "root" : FabricFilterBuilder.pid(parent)}"]`);
      x.p.announce("Condition removed from the draft.");
      return true;
    }
    if (action === "fabric-f-dup") {
      if (M.count(fb.draft) >= M.LIMITS.maxConditions) return true;
      const parts = M.parsePath(path); const dupPath = [...parts.slice(0, -1), parts.at(-1) + 1].join(".");
      const src = M.at(fb.draft, path), adds = M.isGroup(src) ? M.count(src) : 1;
      if (M.count(fb.draft) + adds > M.LIMITS.maxConditions) return true;
      FabricFilterBuilder.edit(x, (m) => M.duplicateAt(m, path), `fb-field-${dupPath}`);
      return true;
    }
    if (action === "fabric-f-pick") {
      fb.picking = fb.picking === path ? "" : path; fb.values = "";
      x.redrawInPlace();
      x.focus(fb.picking ? `[data-focus-key="fb-fieldq"]` : `[data-focus-key="fb-field-${path}"]`);
      return true;
    }
    if (action === "fabric-f-field") {
      const f = x.filterField(target.dataset.field); if (!f) return true;
      const cur = M.at(fb.draft, path); if (!cur || M.isGroup(cur)) return true;
      fb.picking = "";
      const op = cur.field === f.name && f.ops.includes(cur.op) ? cur.op : FabricFilterBuilder.defaultOp(f);
      const next = cur.field === f.name ? cur : M.condition(f.name, op);
      FabricFilterBuilder.edit(x, (m) => M.replaceAt(m, path, next), `fb-op-${path}`);
      return true;
    }
    if (action === "fabric-f-tag-remove") {
      const i = Number(target.dataset.i);
      FabricFilterBuilder.edit(x, (m) => { const c = M.at(m, path); if (c && Array.isArray(c.values)) c.values.splice(i, 1); return m; });
      x.focus(`[data-focus-key="fb-tagx-${path}-${i}"]`); if (typeof document !== "undefined" && !document.activeElement?.closest?.(`#fabric-${x.ds}-fb`)) x.focus(`[data-focus-key="${FabricFilterBuilder.firstKey(x, path)}"]`);
      return true;
    }
    if (action === "fabric-f-values") { fb.values = fb.values === path ? "" : path; fb.picking = ""; x.redrawInPlace(); if (!fb.values) x.focus(`[data-focus-key="fb-values-${path}"]`); return true; }
    return false;
  }
  static onInput(x, target) {
    const M = FabricFilterBuilder.M(), fb = x.fb, action = target.dataset.action, path = target.dataset.path ?? "";
    if (!M || !fb.open) return;
    if (action === "fabric-f-fieldq") { FabricFilterBuilder.filterFieldList(x, target.value); return; }
    if (action === "fabric-f-tag") { fb.tags[path] = target.value; if (/,/.test(target.value)) { const c = M.at(fb.draft, path); if (c && !M.isGroup(c)) { FabricFilterBuilder.addTags(x, c, target.value); fb.tags[path] = ""; x.redrawInPlace(); x.focus(`[data-focus-key="fb-tag-${path}"]`); } } return; }
    if (action === "fabric-f-value") {
      const c = M.at(fb.draft, path); if (!c || M.isGroup(c)) return;
      const f = x.filterField(c.field), edge = target.dataset.edge;
      let v = String(target.value ?? "");
      if (f?.kind === "number" || f?.kind === "date" || edge === "n") v = v.trim();
      if (edge === "n") c.n = v === "" ? "" : Number(v); else if (edge === "value" || edge === "to") c[edge] = v;
      return;
    }
    if (action === "fabric-f-date") { const edge = target.dataset.edge === "to" ? "dateTo" : "dateFrom"; fb.dates = { ...fb.dates, [edge]: String(target.value || "") }; }
  }
  static onChange(x, target) {
    const M = FabricFilterBuilder.M(), fb = x.fb, action = target.dataset.action, path = target.dataset.path ?? "";
    if (!M || !fb.open) return;
    if (action === "fabric-f-op") {
      const c = M.at(fb.draft, path), op = target.value, f = c ? x.filterField(c.field) : null;
      if (!c || M.isGroup(c) || !f || !f.ops.includes(op)) return;
      fb.values = "";
      FabricFilterBuilder.edit(x, (m) => M.replaceAt(m, path, M.withOp(c, op)), `fb-op-${path}`);
      return;
    }
    if (action === "fabric-f-join") { const op = target.value === "or" ? "or" : "and"; FabricFilterBuilder.edit(x, (m) => { const g = M.at(m, path); if (M.isGroup(g)) g.op = op; return m; }, `fb-join-${FabricFilterBuilder.pid(path)}`); return; }
    if (action === "fabric-f-unit") { const c = M.at(fb.draft, path); if (c && !M.isGroup(c) && M.UNITS.includes(target.value)) c.unit = target.value; return; }
    if (action === "fabric-f-value" || action === "fabric-f-date") FabricFilterBuilder.onInput(x, target);
  }
  // Escape: closes the field list (focus back to its button), else cancels the builder (focus back to Filters). Enter in a tag
  // input adds the value (and doesn't submit); Backspace in an empty one removes the last value; arrows move in the field list.
  static onKeydown(x, event) {
    const M = FabricFilterBuilder.M(), fb = x.fb, t = event?.target;
    if (!M || !fb.open || !t?.closest?.(`#fabric-${x.ds}-fb`)) return false;
    const stop = () => { event.preventDefault?.(); event.stopPropagation?.(); };
    // D4: on phones Tab and Shift+Tab stay inside the full-screen builder (the value picker inside it included).
    if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey && FabricFilterBuilder.phone()) return FabricFilterBuilder.trapTab(t.closest(`#fabric-${x.ds}-fb`), event);
    if (t.closest?.(".fx-fb__vpick")) return false; // the value picker handles its own keys
    if (event.key === "Escape") {
      stop();
      if (fb.picking) { const p = fb.picking; const c = M.at(fb.draft, p); fb.picking = ""; if (c && !M.isGroup(c) && !c.field) fb.draft = M.removeAt(fb.draft, p); x.redrawInPlace(); x.focus(c && c.field ? `[data-focus-key="fb-field-${p}"]` : `[data-focus-key="fb-add-root"]`); return true; }
      FabricFilterBuilder.close(x); return true;
    }
    const action = t.dataset?.action, path = t.dataset?.path ?? "";
    if (action === "fabric-f-tag" && event.key === "Enter") {
      stop(); const c = M.at(fb.draft, path);
      if (c && !M.isGroup(c) && String(t.value || "").trim()) { FabricFilterBuilder.addTags(x, c, t.value); fb.tags[path] = ""; fb.errors = []; x.redrawInPlace(); x.focus(`[data-focus-key="fb-tag-${path}"]`); }
      return true;
    }
    if (action === "fabric-f-tag" && event.key === "Backspace" && !t.value) {
      const c = M.at(fb.draft, path);
      if (c && Array.isArray(c.values) && c.values.length) { stop(); c.values.pop(); x.redrawInPlace(); x.focus(`[data-focus-key="fb-tag-${path}"]`); return true; }
      return false;
    }
    if (action === "fabric-f-fieldq" || action === "fabric-f-field") {
      const opts = FabricFilterBuilder.visibleOptions(x), i = opts.indexOf(t);
      if (event.key === "ArrowDown") { stop(); opts[Math.min(i + 1, opts.length - 1)]?.focus?.(); return true; }
      if (event.key === "ArrowUp") { stop(); if (i <= 0) x.focus(`[data-focus-key="fb-fieldq"]`); else opts[i - 1]?.focus?.(); return true; }
      if (event.key === "Home" && action === "fabric-f-field") { stop(); opts[0]?.focus?.(); return true; }
      if (event.key === "End" && action === "fabric-f-field") { stop(); opts.at(-1)?.focus?.(); return true; }
      if (event.key === "Enter" && action === "fabric-f-fieldq") { stop(); if (opts.length === 1 || (opts.length && t.value)) FabricFilterBuilder.onAction(x, "fabric-f-field", opts[0]); return true; }
    }
    return false;
  }
}
if (typeof window !== "undefined") window.FabricFilterBuilder = FabricFilterBuilder;
