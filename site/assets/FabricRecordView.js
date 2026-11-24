// Fabric Data record detail: the object page drawn when FabricExplorer has a record open (explorer.recordId set).
// FabricExplorer.html() returns FabricRecordView.html(explorer); every "fabric-r-…" event is passed to onAction/onInput/onKeydown.
//
// Strictly read-only and request-free: it draws only what the explorer already holds.
//   explorer.record  slot { loading, error, data }, data = the unchanged GET /fabric/{dataset}/records/{id} response
//                    { record: { id, key: { name: value }, fields: [{ name, value, type }] } }
//   explorer.info    the normalised schema (label, byName → { type, sensitive }, recordKey)
//   explorer.ds, explorer.recordId, explorer.items (current page rows [{ id, values }]; falls back to explorer.records.data.items)
//   explorer.listHref(), explorer.recordHref(id), explorer.refresh(), explorer.esc(), explorer.attr()
// Previous/Next and the object list only move among rows already loaded on the current page: they never load more.
// The server leaves out every field the person may not see; nothing here hides or reveals a value with CSS.
// No totals, margins or computed values: each value shown is one value of this record, as received.
class FabricRecordView {
  static TABS = [["overview", "Overview"], ["fields", "All fields"], ["keys", "Keys"]];
  static ID = /^[A-Fa-f0-9]{24}$/;
  static DATASET_TITLES = { sales: "Sales record", inventory: "Inventory entry" };
  // Per-explorer view state (tab, field filter, object list open), kept outside the explorer object.
  static states = new WeakMap();
  static state(explorer) {
    let s = FabricRecordView.states.get(explorer);
    if (!s) { s = { tab: "overview", filter: "", nav: true, id: "" }; FabricRecordView.states.set(explorer, s); }
    if (s.id !== explorer.recordId) { s.id = explorer.recordId; s.filter = ""; }
    return s;
  }
  static meta() { return typeof FabricFieldMeta === "function" ? FabricFieldMeta : null; }
  static label(ds, name) { const m = FabricRecordView.meta(); return m ? m.label(ds, name) : String(name).replace(/_/g, " "); }
  static format(value, type, name) {
    const m = FabricRecordView.meta();
    if (m) return m.format(value, type, name);
    if (value === null || value === undefined || value === "") return { text: "—", cls: "fx-null", title: "No value" };
    const text = typeof value === "boolean" ? (value ? "Yes" : "No") : typeof value === "object" ? JSON.stringify(value) : String(value);
    return { text, cls: "", title: text };
  }
  static items(explorer) {
    const list = Array.isArray(explorer.items) ? explorer.items : explorer.records?.data?.items;
    return (Array.isArray(list) ? list : []).filter((i) => i && typeof i.id === "string" && FabricRecordView.ID.test(i.id));
  }
  static datasetTitle(explorer) {
    return FabricRecordView.DATASET_TITLES[explorer.ds] || `${explorer.info?.label || explorer.label || explorer.ds || "Fabric"} record`;
  }
  // The fields of the response, well-formed only.
  static fields(record) { return (Array.isArray(record?.fields) ? record.fields : []).filter((f) => f && typeof f.name === "string" && f.name); }
  static keyEntries(explorer, record, byName) {
    const key = record?.key && typeof record.key === "object" && !Array.isArray(record.key) ? Object.entries(record.key) : [];
    if (key.length) return key.map(([name, value]) => ({ name, value, type: byName.get(name)?.type ?? explorer.info?.byName?.get?.(name)?.type ?? "" }));
    const names = explorer.info?.recordKey?.length ? explorer.info.recordKey : FabricRecordView.meta()?.recordKey(explorer.ds) || [];
    return names.filter((n) => byName.has(n)).map((n) => byName.get(n));
  }
  // "Sales record · Company · invoice · line n" (null key parts are left out).
  static titleParts(explorer, keys) {
    return keys.filter((k) => k.value !== null && k.value !== undefined && k.value !== "").map((k) => {
      const text = FabricRecordView.format(k.value, k.type, k.name).text;
      if (k.name === "Line_No") return `line ${text}`;
      if (k.name === "Entry_No") return `entry ${text}`;
      return text;
    });
  }
  static isNotFound(error) { return Boolean(error) && (error.kind === "record" || error.code === "FABRIC_RECORD_NOT_FOUND" || error.code === "NOT_FOUND"); }

  // ---- The page
  static html(explorer) {
    const e = (v) => explorer.esc(v), a = (v) => explorer.attr(v), ds = a(explorer.ds), s = explorer.record || {}, st = FabricRecordView.state(explorer);
    const back = `<a class="fx-btn" href="${a(explorer.listHref())}" data-action="fabric-r-back" data-ds="${ds}" data-focus-key="record-back"><span aria-hidden="true">‹</span> Back to list</a>`;
    const shell = (title, body, busy = false) => `<section class="fx-object" data-ds="${ds}" aria-labelledby="fx-object-title-${ds}" ${busy ? 'aria-busy="true"' : ""}><div class="fx-object__head"><h2 class="fx-object__title" id="fx-object-title-${ds}" tabindex="-1">${title}</h2><div class="fx-object__actions">${back}</div></div>${body}</section>`;
    const dsTitle = e(FabricRecordView.datasetTitle(explorer));
    if (s.error && FabricRecordView.isNotFound(s.error)) return shell(dsTitle, FabricRecordView.notFoundHtml(explorer));
    if (s.error) return shell(dsTitle, `<div class="fx-status fx-status--error fx-object__state" role="alert"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__msg">${e(s.error.message || "The record couldn't be loaded.")}${s.error.reference ? ` <small>Reference <code>${e(s.error.reference)}</code></small>` : ""}</span><button type="button" class="fx-btn" data-action="fabric-r-retry" data-ds="${ds}" data-focus-key="record-retry">Try again</button></div>`);
    const record = s.data?.record;
    if (!record || typeof record !== "object") {
      if (s.loading || !s.data) return shell(dsTitle, `<div class="fx-status fx-status--info fx-object__state" role="status"><span class="fx-status__icon fx-object__spinner" aria-hidden="true"></span><span class="fx-status__msg">Loading the record…</span></div>`, true);
      return shell(dsTitle, FabricRecordView.notFoundHtml(explorer));
    }
    const fields = FabricRecordView.fields(record), byName = new Map(fields.map((f) => [f.name, f]));
    const keys = FabricRecordView.keyEntries(explorer, record, byName);
    const parts = [FabricRecordView.datasetTitle(explorer), ...FabricRecordView.titleParts(explorer, keys)];
    const title = parts.map(e).join(` <span class="fx-object__dot" aria-hidden="true">·</span> `), plainTitle = parts.join(" · ");
    const items = FabricRecordView.items(explorer), at = items.findIndex((i) => i.id === explorer.recordId);
    const step = (dir, label, glyph) => {
      const item = at < 0 ? null : items[at + (dir === "prev" ? -1 : 1)];
      const inner = dir === "prev" ? `<span aria-hidden="true">${glyph}</span> ${label}` : `${label} <span aria-hidden="true">${glyph}</span>`;
      return item ? `<a class="fx-btn" href="${a(explorer.recordHref(item.id))}" data-action="fabric-r-open" data-ds="${ds}" data-id="${a(item.id)}" data-focus-key="record-${dir}" title="${a(`${label} row on this page`)}">${inner}</a>` : `<button type="button" class="fx-btn" disabled data-focus-key="record-${dir}" title="${a(at < 0 ? "This record isn't on the loaded page" : `No ${label.toLowerCase()} row on this page`)}">${inner}</button>`;
    };
    const position = at < 0 ? "" : `<span class="fx-object__pos" aria-label="${a(`Row ${at + 1} of ${items.length} on this page`)}">${at + 1} / ${items.length}</span>`;
    const actions = `${back}<span class="fx-sep" aria-hidden="true"></span>${step("prev", "Previous", "‹")}${position}${step("next", "Next", "›")}<span class="fx-sep" aria-hidden="true"></span><button type="button" class="fx-btn" data-action="fabric-r-refresh" data-ds="${ds}" data-focus-key="record-refresh" ${s.loading ? 'aria-busy="true"' : ""}><span aria-hidden="true">↻</span> Refresh</button>`;
    const tabs = FabricRecordView.TABS.map(([id, label]) => {
      const on = st.tab === id, text = id === "fields" ? `${label} (${fields.length})` : label;
      return `<button type="button" class="fx-tab${on ? " is-active" : ""}" role="tab" id="fx-rtab-${ds}-${id}" aria-controls="fx-rpanel-${ds}-${id}" aria-selected="${on}" tabindex="${on ? "0" : "-1"}" data-action="fabric-r-tab" data-ds="${ds}" data-tab="${id}" data-text="${a(text)}">${e(text)}</button>`;
    }).join("");
    const panel = (id, body) => `<div class="fx-object__panel" role="tabpanel" id="fx-rpanel-${ds}-${id}" aria-labelledby="fx-rtab-${ds}-${id}" tabindex="0" ${st.tab === id ? "" : "hidden"}>${body}</div>`;
    const main = `<div class="fx-object__main"><div class="fx-tabs" role="tablist" aria-label="Record sections">${tabs}</div>${panel("overview", FabricRecordView.overviewHtml(explorer, fields))}${panel("fields", FabricRecordView.allFieldsHtml(explorer, fields, st.filter))}${panel("keys", FabricRecordView.keysHtml(explorer, record, keys, byName))}<p class="fx-object__note">Read-only. Record links aren't permanent: when the Fabric data is refreshed upstream, a saved link may no longer find its record.</p></div>`;
    const nav = items.length ? FabricRecordView.navHtml(explorer, items, st.nav) : "";
    return `<section class="fx-object${nav ? " fx-object--with-nav" : ""}" data-ds="${ds}" aria-labelledby="fx-object-title-${ds}" ${s.loading ? 'aria-busy="true"' : ""}><div class="fx-object__head"><h2 class="fx-object__title" id="fx-object-title-${ds}" tabindex="-1" title="${a(plainTitle)}">${title}</h2><div class="fx-object__actions" role="toolbar" aria-label="Record actions">${actions}</div></div><div class="fx-object__body">${nav}${main}</div></section>`;
  }
  static notFoundHtml(explorer) {
    const ds = explorer.attr(explorer.ds);
    return `<div class="fx-status fx-status--warn fx-object__state" role="alert"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__msg">This record wasn't found. It may have been refreshed upstream.</span><a class="fx-btn" href="${explorer.attr(explorer.listHref())}" data-action="fabric-r-reload" data-ds="${ds}" data-focus-key="record-reload">Back to list</a></div>`;
  }
  // One value cell: the formatted text, its full value as the title, "No value" for screen readers on the null marker.
  static valueHtml(explorer, f, extra = "") {
    const v = FabricRecordView.format(f.value, f.type, f.name), none = v.cls.split(" ").includes("fx-null");
    const inner = none ? `<span class="fx-null" aria-label="No value">—</span>` : `<span class="${explorer.attr(v.cls)}">${explorer.esc(v.text)}</span>`;
    return `<dd class="fx-field__value${extra}" title="${explorer.attr(v.title)}">${inner}</dd>`;
  }
  static fieldRowHtml(explorer, f, { key = false } = {}) {
    const meta = FabricRecordView.meta(), label = FabricRecordView.label(explorer.ds, f.name);
    const isKey = key || Boolean(meta?.isKey(explorer.ds, f.name)), mono = meta?.isMono(f.name);
    const cls = isKey ? " fx-field__value--key" : mono ? " fx-field__value--mono" : "";
    const restricted = explorer.info?.byName?.get?.(f.name)?.sensitive ? ` <span class="fx-chip fx-chip--restricted" title="Shown because you have the sensitive-data permission">Restricted</span>` : "";
    return `<dt class="fx-field__label" title="${explorer.attr(f.name)}">${explorer.esc(label)}${restricted}</dt>${FabricRecordView.valueHtml(explorer, f, cls)}`;
  }
  static overviewHtml(explorer, fields) {
    if (!fields.length) return `<p class="fx-object__empty">This record has no fields you can see.</p>`;
    const byName = new Map(fields.map((f) => [f.name, f])), meta = FabricRecordView.meta();
    const groups = meta ? meta.arrange(explorer.ds, fields.map((f) => f.name)) : [{ id: "all", title: "Fields", fields: fields.map((f) => f.name) }];
    return `<div class="fx-fieldgroups">${groups.map((g) => `<fieldset class="fx-fieldgroup" data-group="${explorer.attr(g.id)}"><legend class="fx-fieldgroup__legend">${explorer.esc(g.title)}</legend><dl class="fx-fieldgroup__grid">${g.fields.map((n) => FabricRecordView.fieldRowHtml(explorer, byName.get(n))).join("")}</dl></fieldset>`).join("")}</div>`;
  }
  static filterText(explorer, f) { const v = FabricRecordView.format(f.value, f.type, f.name); return `${f.name} ${FabricRecordView.label(explorer.ds, f.name)} ${v.cls.includes("fx-null") ? "" : `${v.text} ${v.title}`}`.toLowerCase(); }
  static allFieldsHtml(explorer, fields, filter) {
    const ds = explorer.attr(explorer.ds), term = String(filter || "").trim().toLowerCase(); let shown = 0;
    const rows = fields.map((f, i) => {
      const hay = FabricRecordView.filterText(explorer, f), hide = Boolean(term) && !hay.includes(term); if (!hide) shown += 1;
      const v = FabricRecordView.format(f.value, f.type, f.name), none = v.cls.includes("fx-null");
      const restricted = explorer.info?.byName?.get?.(f.name)?.sensitive ? ` <span class="fx-chip fx-chip--restricted">Restricted</span>` : "";
      return `<tr data-filter="${explorer.attr(hay)}" ${hide ? "hidden" : ""}><td class="fx-grid__num">${i + 1}</td><th scope="row" class="fx-grid__frozen"><span class="fx-allfields__label">${explorer.esc(FabricRecordView.label(explorer.ds, f.name))}</span>${restricted}<code class="fx-allfields__name">${explorer.esc(f.name)}</code></th><td class="${FabricRecordView.meta()?.isKey(explorer.ds, f.name) ? "fx-allfields__key " : ""}${v.cls.includes("fx-num") ? "fx-grid__num" : ""}" title="${explorer.attr(v.title)}">${none ? `<span class="fx-null" aria-label="No value">—</span>` : `<span class="${explorer.attr(v.cls)}">${explorer.esc(v.text)}</span>`}</td><td class="fx-allfields__type">${explorer.esc(f.type || "")}</td></tr>`;
    }).join("");
    const count = shown === fields.length ? `${fields.length} fields` : `${shown} of ${fields.length} fields`;
    return `<div class="fx-allfields__tools"><label class="fx-search"><span class="fx-sr">Filter fields</span><input id="fx-rfilter-${ds}" type="search" data-action="fabric-r-filter" data-ds="${ds}" value="${explorer.attr(filter || "")}" maxlength="100" placeholder="Filter by field, label or value" autocomplete="off" aria-controls="fx-rrows-${ds}" aria-describedby="fx-rcount-${ds}"></label><span class="fx-allfields__count" id="fx-rcount-${ds}" role="status">${count}</span></div><div class="fx-grid fx-allfields" role="region" aria-label="All fields" tabindex="0"><table class="fx-grid__table"><thead><tr><th scope="col" class="fx-grid__num">#</th><th scope="col" class="fx-grid__frozen">Field</th><th scope="col">Value</th><th scope="col">Type</th></tr></thead><tbody id="fx-rrows-${ds}">${rows}</tbody></table></div>`;
  }
  static keysHtml(explorer, record, keys, byName) {
    const meta = FabricRecordView.meta(), keyNames = new Set(keys.map((k) => k.name));
    const join = (meta ? meta.joinKeys(explorer.ds) : []).filter((n) => byName.has(n) && !keyNames.has(n)).map((n) => byName.get(n));
    const id = typeof record.id === "string" ? { name: "_id", value: record.id, type: "objectId" } : null;
    const idRow = id ? `<dt class="fx-field__label" title="_id">Record ID</dt>${FabricRecordView.valueHtml(explorer, id, " fx-field__value--key")}` : "";
    const keyRows = keys.map((k) => FabricRecordView.fieldRowHtml(explorer, k, { key: true })).join("");
    const joinRows = join.length ? `<fieldset class="fx-fieldgroup" data-group="join"><legend class="fx-fieldgroup__legend">Join and connect keys</legend><dl class="fx-fieldgroup__grid" data-keys="join">${join.map((f) => FabricRecordView.fieldRowHtml(explorer, f)).join("")}</dl></fieldset>` : "";
    if (!idRow && !keyRows && !joinRows) return `<p class="fx-object__empty">No key fields in this record.</p>`;
    // Record key and join keys side by side (stacked on narrow screens): the tab uses the full width.
    const recordRows = idRow || keyRows ? `<fieldset class="fx-fieldgroup" data-group="keys"><legend class="fx-fieldgroup__legend">Record key</legend><dl class="fx-fieldgroup__grid" data-keys="record">${idRow}${keyRows}</dl><p class="fx-object__note fx-keygroups__note">The record ID changes when the Fabric data is refreshed upstream; the record key and join keys come from the source.</p></fieldset>` : "";
    return `<div class="fx-keygroups">${recordRows}${joinRows}</div>`;
  }
  // The rows of the loaded page (never more): a short label from the key values the list row holds.
  static navHtml(explorer, items, open) {
    const ds = explorer.attr(explorer.ds), meta = FabricRecordView.meta();
    const keyNames = explorer.info?.recordKey?.length ? explorer.info.recordKey : meta?.recordKey(explorer.ds) || [];
    const rows = items.map((item, i) => {
      const values = item.values && typeof item.values === "object" ? item.values : {};
      const parts = keyNames.filter((n) => Object.hasOwn(values, n) && values[n] !== null && values[n] !== "").map((n) => FabricRecordView.format(values[n], explorer.info?.byName?.get?.(n)?.type, n).text);
      const text = parts.length ? parts.join(" · ") : `Row ${i + 1}`, current = item.id === explorer.recordId;
      return `<li class="fx-nav__node"><a class="fx-nav__row${current ? " is-current" : ""}" href="${explorer.attr(explorer.recordHref(item.id))}" data-action="fabric-r-open" data-ds="${ds}" data-id="${explorer.attr(item.id)}" ${current ? 'aria-current="true"' : ""} title="${explorer.attr(text)}"><span class="fx-nav__num">${i + 1}</span> ${explorer.esc(text)}</a></li>`;
    }).join("");
    return `<aside class="fx-nav fx-object__nav${open ? "" : " is-collapsed"}" aria-label="Rows on this page"><div class="fx-nav__caption"><span class="fx-nav__title">Rows on this page (${items.length})</span><button type="button" class="fx-btn--icon fx-nav__collapse" data-action="fabric-r-nav" data-ds="${ds}" aria-expanded="${open}" aria-controls="fx-rnav-${ds}" aria-label="${open ? "Hide the row list" : "Show the row list"}" data-focus-key="record-nav"><span aria-hidden="true">${open ? "«" : "»"}</span></button></div><ul class="fx-nav__tree" id="fx-rnav-${ds}" ${open ? "" : "hidden"}>${rows}</ul></aside>`;
  }

  // ---- Events (the explorer passes every "fabric-r-…" action here)
  static plainClick(event) { return !event || (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && (event.button === undefined || event.button === 0)); }
  static redraw(explorer) { explorer.p?.redraw?.(); }
  static focus(selector) { if (typeof document !== "undefined") document.querySelector(selector)?.focus?.(); }
  static onAction(explorer, action, target, event) {
    if (target?.tagName === "A" && !FabricRecordView.plainClick(event)) return; // Ctrl/⌘/Shift/middle click: the browser opens the link
    if (target?.tagName === "A") event?.preventDefault?.();
    const st = FabricRecordView.state(explorer), ds = explorer.ds;
    if (action === "fabric-r-open") {
      const id = target?.dataset?.id;
      if (!FabricRecordView.ID.test(id || "") || id === explorer.recordId) return;
      if (typeof explorer.onAction === "function") explorer.onAction("fabric-x-open", target, event); else explorer.openRecord(id);
      FabricRecordView.focus(`#fx-object-title-${ds}`);
      return;
    }
    if (action === "fabric-r-back") { if (typeof explorer.onAction === "function") explorer.onAction("fabric-x-back", target, event); else explorer.openRecord(""); return; }
    if (action === "fabric-r-reload") { if (typeof explorer.onAction === "function") explorer.onAction("fabric-x-reload", target, event); else explorer.openRecord(""); return; }
    if (action === "fabric-r-refresh") { explorer.refresh(); return; }
    if (action === "fabric-r-retry") { if (typeof explorer.retry === "function") explorer.retry(); else explorer.refresh(); return; }
    if (action === "fabric-r-tab") { FabricRecordView.selectTab(explorer, target?.dataset?.tab); return; }
    if (action === "fabric-r-nav") { st.nav = !st.nav; FabricRecordView.redraw(explorer); FabricRecordView.focus(`[data-action="fabric-r-nav"][data-ds="${ds}"]`); return; }
    if (action === "fabric-r-filter") FabricRecordView.onInput(explorer, target);
  }
  static selectTab(explorer, tab) {
    if (!FabricRecordView.TABS.some(([id]) => id === tab)) return;
    const st = FabricRecordView.state(explorer), ds = explorer.ds; st.tab = tab;
    // Switch in place when the page is drawn (no redraw: focus and scroll stay); otherwise redraw from the state.
    const doc = typeof document !== "undefined" ? document : null, tabs = doc?.querySelectorAll?.(`#fabric-root [data-action="fabric-r-tab"][data-ds="${ds}"]`) || [];
    if (!tabs.length) { FabricRecordView.redraw(explorer); FabricRecordView.focus(`#fx-rtab-${ds}-${tab}`); return; }
    tabs.forEach((b) => { const on = b.dataset.tab === tab; b.classList?.toggle?.("is-active", on); b.setAttribute?.("aria-selected", String(on)); b.setAttribute?.("tabindex", on ? "0" : "-1"); });
    for (const [id] of FabricRecordView.TABS) { const p = doc.querySelector(`#fx-rpanel-${ds}-${id}`); if (p) p.hidden = id !== tab; }
    FabricRecordView.focus(`#fx-rtab-${ds}-${tab}`);
  }
  // Typing in the All fields filter hides rows that are already drawn: no redraw, focus stays in the box.
  static onInput(explorer, target) {
    if (target?.dataset?.action !== "fabric-r-filter") return;
    const st = FabricRecordView.state(explorer), ds = explorer.ds; st.filter = String(target.value ?? "").slice(0, 100);
    if (typeof document === "undefined") return;
    const term = st.filter.trim().toLowerCase(); let shown = 0, all = 0;
    document.querySelectorAll(`#fx-rrows-${ds} tr`).forEach((tr) => { all += 1; const hide = Boolean(term) && !String(tr.dataset?.filter || "").includes(term); tr.hidden = hide; if (!hide) shown += 1; });
    const count = document.querySelector(`#fx-rcount-${ds}`); if (count) count.textContent = shown === all ? `${all} fields` : `${shown} of ${all} fields`;
  }
  // Tabs: roving tabindex with ←/→, Home and End (the explorer passes keydown events on fabric-r-tab buttons).
  static onKeydown(explorer, event) {
    const t = event?.target; if (t?.dataset?.action !== "fabric-r-tab") return false;
    const ids = FabricRecordView.TABS.map(([id]) => id), i = ids.indexOf(t.dataset.tab); if (i < 0) return false;
    const next = { ArrowRight: ids[(i + 1) % ids.length], ArrowLeft: ids[(i + ids.length - 1) % ids.length], Home: ids[0], End: ids[ids.length - 1] }[event.key];
    if (!next) return false;
    event.preventDefault?.(); FabricRecordView.selectTab(explorer, next); return true;
  }
}
if (typeof window !== "undefined") window.FabricRecordView = FabricRecordView;
