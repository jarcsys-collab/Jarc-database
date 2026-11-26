// People directory: the in-page navigation (left of the body, inside #employees-root), drawn with FabricObjects' classes:
//
//   Active accounts            → /admin/employees/active with no filter or search (the default)
//   Group by                   → Department, Job title, Office, Email domain (/admin/employees/groups/{field})
//   My saved filters           → the person's saved filters for the list open now (FabricSavedFilters)
//   All / Disabled / Guest accounts → only with employees.admin; never drawn for anyone else
//
// A navigation tree as in FabricObjects (roving tabindex, ↑ ↓ Home End, → expands, ← collapses, Enter opens, aria-current="page").
// On desktops it collapses to a 32 px rail; at 1024 px or less it is a drawer (the heading's Objects button): a modal dialog with a
// focus trap, closed by Escape, the backdrop or a choice, which gives focus back to the button that opened it.
//
// Browser storage: only which nodes are expanded and whether the panel is collapsed, as fixed node IDs, per person
// (jarc.employees.objects.<user id>); nothing without a known person. Never names, values or filter contents.
class EmployeesObjects {
  static STORAGE_PREFIX = "jarc.employees.objects.";
  static NARROW = "(max-width: 1024px)";
  static PARENTS = ["groups", "saved"];
  static ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
  static ADMIN_ICONS = { all: "people", disabled: "lock", guests: "globe" };

  static defaults() { return { collapsed: false, open: new Set(["groups"]), drawer: false, focusId: "", loadedKey: null }; }
  static userId(panel) {
    const c = panel.c || {}, raw = c.auth?.userId || String(c.model?.me || "").replace(/^user:/, "");
    return typeof raw === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(raw) ? raw : "";
  }
  static storageKey(panel) { const id = EmployeesObjects.userId(panel); return id ? `${EmployeesObjects.STORAGE_PREFIX}${id}` : ""; }
  static state(panel) {
    const key = EmployeesObjects.storageKey(panel);
    if (!panel.objects || panel.objects.loadedKey !== key) {
      const s = EmployeesObjects.defaults();
      s.loadedKey = key;
      if (key) {
        try {
          const v = JSON.parse(window.localStorage?.getItem(key) || "null");
          if (v && typeof v === "object" && v.v === 1) {
            s.collapsed = v.collapsed === true;
            if (Array.isArray(v.open)) s.open = new Set(v.open.filter((id) => EmployeesObjects.PARENTS.includes(id)));
          }
        } catch { /* storage blocked or unreadable: the defaults */ }
      }
      panel.objects = s;
    }
    return panel.objects;
  }
  static save(panel) {
    const s = EmployeesObjects.state(panel), key = s.loadedKey;
    if (!key) return;
    try { window.localStorage?.setItem(key, JSON.stringify({ v: 1, collapsed: s.collapsed, open: [...s.open].filter((id) => EmployeesObjects.PARENTS.includes(id)) })); } catch { /* a convenience only */ }
  }
  static narrow() { try { return Boolean(typeof window !== "undefined" && window.matchMedia?.(EmployeesObjects.NARROW)?.matches); } catch { return false; } }
  static savedApi() { return typeof FabricSavedFilters !== "undefined" && FabricSavedFilters && typeof FabricSavedFilters.navItems === "function" ? FabricSavedFilters : null; }
  // The list whose saved filters are shown: the one open now (a grouping view: Active accounts).
  static savedDataset(panel) { const ds = panel.route?.view === "list" ? panel.route.ds : "active"; return panel.datasetAllowed(ds) ? ds : "active"; }

  // ---- The tree: [{ id, label, icon, href, action, ds?, group?, children?, saved?, items? }]
  static nodes(panel) {
    const out = [], s = EmployeesObjects.state(panel), saved = EmployeesObjects.savedApi(), base = EmployeesPanel.BASE;
    out.push({ id: "active", label: EmployeesPanel.DATASETS.active, icon: "people", href: `${base}/active`, action: "emp-o-ds", ds: "active" });
    out.push({ id: "groups", label: "Group by", icon: "layers", children: EmployeesPanel.GROUPS.map(([f, label]) => ({ id: `group-${f}`, label, icon: "folder", href: `${base}/groups/${f}`, action: "emp-o-group", group: f })) });
    if (saved) {
      const ds = EmployeesObjects.savedDataset(panel), x = panel.explorers[ds];
      let items = null;
      if (s.open.has("saved")) { try { items = saved.navItems(x); } catch { items = []; } }
      out.push({ id: "saved", label: "My saved filters", icon: "filter", ds, saved: true, items: Array.isArray(items) ? items.filter((i) => i && EmployeesObjects.ITEM_ID.test(String(i.id || ""))) : null });
    }
    if (panel.admin) for (const ds of EmployeesPanel.ADMIN_DATASETS) {
      if (!panel.datasetAllowed(ds)) continue;
      out.push({ id: ds, label: EmployeesPanel.DATASETS[ds], icon: EmployeesObjects.ADMIN_ICONS[ds], href: `${base}/${ds}`, action: "emp-o-ds", ds, admin: true });
      // P2, only with jarcAccess: Disabled accounts that still have JARC access (the Disabled list with one filter).
      if (ds === "disabled" && typeof panel.jarcDisabledAvailable === "function" && panel.jarcDisabledAvailable()) out.push({ id: "jarc-disabled", label: "Disabled with JARC access", icon: "flag", href: panel.jarcDisabledHref(), action: "emp-o-jarc-disabled", ds, admin: true });
    }
    return out;
  }
  static currentId(panel, nodes = EmployeesObjects.nodes(panel)) {
    const r = panel.route || {};
    if (r.view === "group") return `group-${r.group}`;
    const saved = nodes.find((n) => n.saved && n.ds === r.ds)?.items?.find((i) => i.current);
    if (saved) return `saved-${saved.id}`;
    if (typeof panel.isJarcDisabledView === "function" && panel.isJarcDisabledView()) return "jarc-disabled";
    return r.ds || "active";
  }

  // ---- Drawing (FabricObjects' classes: fabric-objects.css applies under .fx-app)
  static toggleHtml(panel) {
    const s = EmployeesObjects.state(panel), open = EmployeesObjects.narrow() ? s.drawer : !s.collapsed;
    return `<button type="button" id="employees-objects-toggle" class="fx-btn fx-btn--icon fx-appbar__objects" data-action="emp-o-panel" data-focus-key="emp-objects-toggle" aria-controls="employees-objects" aria-expanded="${open}" aria-label="Directory navigation" title="Directory navigation">${icon("list")}</button>`;
  }
  static html(panel) {
    const s = EmployeesObjects.state(panel), nodes = EmployeesObjects.nodes(panel), current = EmployeesObjects.currentId(panel, nodes);
    const narrow = EmployeesObjects.narrow(), drawer = narrow && s.drawer;
    const ids = EmployeesObjects.visibleIds(nodes, s);
    const stop = ids.includes(s.focusId) ? s.focusId : ids.includes(current) ? current : ids[0];
    const ctx = { panel, s, current, stop };
    const firstAdmin = nodes.findIndex((n) => n.admin);
    const tree = nodes.map((n, i) => (i === firstAdmin ? `<li class="fx-objects__node emp-objects__sep" role="none"><span class="emp-objects__caption" id="employees-objects-admin">Administrators only</span></li>` : "") + EmployeesObjects.nodeHtml(ctx, n, 1)).join("");
    const cls = `fx-objects emp-objects${s.collapsed ? " is-collapsed" : ""}${drawer ? " is-drawer-open" : ""}`;
    const dialog = drawer ? ' role="dialog" aria-modal="true" aria-labelledby="employees-objects-title"' : ' aria-labelledby="employees-objects-title"';
    const collapse = `<button type="button" class="fx-btn fx-btn--icon fx-objects__collapse" data-action="emp-o-collapse" data-focus-key="emp-objects-collapse" aria-controls="employees-objects-tree" aria-expanded="${!s.collapsed}" aria-label="${s.collapsed ? "Show" : "Hide"} the directory navigation" title="${s.collapsed ? "Show" : "Hide"} the directory navigation">${icon(s.collapsed ? "right" : "left")}</button>`;
    const close = `<button type="button" class="fx-btn fx-btn--icon fx-objects__close" data-action="emp-o-close" data-focus-key="emp-objects-close" aria-label="Close the directory navigation" title="Close">${icon("close")}</button>`;
    return `<aside id="employees-objects" class="${cls}"${dialog}><div class="fx-objects__caption"><span class="fx-objects__title" id="employees-objects-title">Directory</span>${collapse}${close}</div><ul id="employees-objects-tree" class="fx-objects__tree" role="tree" aria-labelledby="employees-objects-title">${tree}</ul></aside><div class="fx-objects__backdrop" data-action="emp-o-close" aria-hidden="true"${drawer ? "" : " hidden"}></div>`;
  }
  static visibleIds(nodes, s) {
    const out = [];
    const walk = (n) => {
      out.push(n.id);
      if (n.children && s.open.has(n.id)) for (const c of n.children) walk(c);
      if (n.saved && s.open.has(n.id)) { if (Array.isArray(n.items) && n.items.length) for (const i of n.items) out.push(`saved-${i.id}`); else out.push("saved-none"); }
    };
    for (const n of nodes) walk(n);
    return out;
  }
  static itemAttrs(ctx, id, level, { expanded = null, owns = "" } = {}) {
    const on = id === ctx.current;
    return ` id="emp-obj-${id}" role="treeitem" data-o-id="${id}" aria-level="${level}" tabindex="${id === ctx.stop ? 0 : -1}"${expanded === null ? "" : ` aria-expanded="${expanded}"`}${owns ? ` aria-owns="${owns}"` : ""}${on ? ' aria-current="page"' : ""}`;
  }
  static twisty(id, open) { return `<span class="fx-objects__twisty${open ? " is-open" : ""}" data-action="emp-o-toggle" data-o-id="${id}" aria-hidden="true">${icon("chevron")}</span>`; }
  static nodeHtml(ctx, n, level) {
    const { panel, s, current } = ctx, esc = (v) => panel.esc(v), attr = (v) => panel.attr(v);
    const open = s.open.has(n.id), parent = Boolean(n.children || n.saved), group = `emp-obj-${n.id}-group`;
    const active = current === n.id || (current && current.startsWith(`${n.id}-`)) ? " is-active" : "";
    const label = `${icon(n.icon)}<span class="fx-objects__label">${esc(n.label)}</span>`;
    let row;
    if (parent) row = `<span class="fx-objects__row fx-objects__row--l${level}${active}" data-action="emp-o-toggle"${EmployeesObjects.itemAttrs(ctx, n.id, level, { expanded: open, owns: group })}>${EmployeesObjects.twisty(n.id, open)}${label}</span>`;
    else {
      const extra = `${n.ds ? ` data-ds="${attr(n.ds)}"` : ""}${n.group ? ` data-group="${attr(n.group)}"` : ""}`;
      row = `<a class="fx-objects__row fx-objects__row--l${level}${active}" href="${attr(n.href)}" data-action="${n.action}"${extra}${EmployeesObjects.itemAttrs(ctx, n.id, level)}><span class="fx-objects__twisty" aria-hidden="true"></span>${label}</a>`;
    }
    if (!parent) return `<li class="fx-objects__node" role="none">${row}</li>`;
    const kids = n.children ? n.children.map((c) => EmployeesObjects.nodeHtml(ctx, c, level + 1)).join("") : EmployeesObjects.savedHtml(ctx, n, level + 1);
    return `<li class="fx-objects__node" role="none">${row}<ul class="fx-objects__group" role="group" id="${group}" aria-label="${attr(n.label)}"${open ? "" : " hidden"}>${open ? kids : ""}</ul></li>`;
  }
  static savedHtml(ctx, n, level) {
    const { panel } = ctx, esc = (v) => panel.esc(v), attr = (v) => panel.attr(v);
    const note = (text) => `<li class="fx-objects__node" role="none"><span class="fx-objects__row fx-objects__row--l${level} fx-objects__row--note" aria-disabled="true"${EmployeesObjects.itemAttrs(ctx, "saved-none", level)}><span class="fx-objects__twisty" aria-hidden="true"></span><span class="fx-objects__label">${text}</span></span></li>`;
    if (!Array.isArray(n.items)) return note("Loading…");
    if (!n.items.length) return note("No saved filters yet");
    return n.items.map((i) => {
      const id = `saved-${i.id}`, href = `${EmployeesPanel.BASE}/${n.ds}`;
      const warn = i.invalid ? `<span class="fx-objects__warn" title="${attr(i.problem || "This filter needs checking")}">!<span class="sr-only"> ${esc(i.problem || "This filter needs checking")}</span></span>` : "";
      return `<li class="fx-objects__node" role="none"><a class="fx-objects__row fx-objects__row--l${level}${i.invalid ? " is-invalid" : ""}" href="${attr(href)}" data-action="fabric-s-open" data-ds="${attr(n.ds)}" data-id="${attr(i.id)}"${EmployeesObjects.itemAttrs(ctx, id, level)} title="${attr(i.name)}"><span class="fx-objects__twisty" aria-hidden="true"></span><span class="fx-objects__label">${esc(i.name)}</span>${warn}</a></li>`;
    }).join("");
  }

  static redraw(panel, { focus = "" } = {}) {
    if (typeof document === "undefined") return;
    const aside = document.querySelector("#employees-objects");
    if (!aside) return;
    const active = document.activeElement, inside = active && aside.contains(active);
    const keep = focus || (inside ? (active.dataset?.oId ? `#emp-obj-${active.dataset.oId}` : active.dataset?.focusKey ? `[data-focus-key="${active.dataset.focusKey}"]` : "") : "");
    const holder = document.createElement("div");
    holder.innerHTML = EmployeesObjects.html(panel);
    const [nextAside, nextBackdrop] = holder.children;
    const backdrop = aside.nextElementSibling?.classList?.contains("fx-objects__backdrop") ? aside.nextElementSibling : null;
    aside.replaceWith(nextAside);
    if (backdrop && nextBackdrop) backdrop.replaceWith(nextBackdrop);
    const toggle = document.querySelector("#employees-objects-toggle");
    if (toggle) { const s = EmployeesObjects.state(panel); toggle.setAttribute("aria-expanded", String(EmployeesObjects.narrow() ? s.drawer : !s.collapsed)); }
    if (keep) (document.querySelector(keep) || nextAside.querySelector('[role="treeitem"][tabindex="0"]'))?.focus?.({ preventScroll: true });
  }

  // ---- Actions (emp-o-*, routed here by EmployeesPanel.onAction)
  static onAction(panel, action, target, event) {
    const s = EmployeesObjects.state(panel);
    if (action === "emp-o-toggle") { event?.preventDefault?.(); event?.stopPropagation?.(); const id = target.dataset.oId; EmployeesObjects.setOpen(panel, id, !s.open.has(id)); return; }
    if (action === "emp-o-collapse") {
      if (EmployeesObjects.narrow()) { EmployeesObjects.closeDrawer(panel); return; }
      s.collapsed = !s.collapsed; EmployeesObjects.save(panel);
      EmployeesObjects.redraw(panel, { focus: '[data-focus-key="emp-objects-collapse"]' });
      return;
    }
    if (action === "emp-o-panel") {
      if (EmployeesObjects.narrow()) { if (s.drawer) EmployeesObjects.closeDrawer(panel); else EmployeesObjects.openDrawer(panel); return; }
      s.collapsed = !s.collapsed; EmployeesObjects.save(panel);
      EmployeesObjects.redraw(panel, { focus: s.collapsed ? "#employees-objects-toggle" : '#employees-objects [role="treeitem"][tabindex="0"]' });
      return;
    }
    if (action === "emp-o-close") { EmployeesObjects.closeDrawer(panel); return; }
    if (action === "emp-o-ds") {
      const ds = target.dataset.ds;
      if (!panel.datasetAllowed(ds)) return;
      EmployeesObjects.afterChoice(panel, ds);
      panel.openDataset(ds, { clear: true, focus: false });
      EmployeesObjects.focusAfterChoice(panel, ds);
      return;
    }
    if (action === "emp-o-jarc-disabled") {
      if (typeof panel.jarcDisabledAvailable !== "function" || !panel.jarcDisabledAvailable()) return;
      EmployeesObjects.afterChoice(panel, "jarc-disabled");
      panel.openJarcDisabled({ focus: false });
      EmployeesObjects.focusAfterChoice(panel, "jarc-disabled");
      return;
    }
    if (action === "emp-o-group") {
      const f = target.dataset.group;
      if (!EmployeesPanel.groupLabel(f)) return;
      EmployeesObjects.afterChoice(panel, `group-${f}`);
      panel.openGroup(f, { focus: false });
      EmployeesObjects.focusAfterChoice(panel, `group-${f}`);
    }
  }
  static afterChoice(panel, id) { const s = EmployeesObjects.state(panel); s.focusId = id; if (s.drawer) { s.drawer = false; s.restore = true; } }
  static focusAfterChoice(panel, id) {
    if (typeof document === "undefined") return;
    const s = EmployeesObjects.state(panel);
    if (s.restore) { s.restore = false; document.querySelector("#employees-objects-toggle")?.focus?.(); return; }
    document.querySelector(`#emp-obj-${id}`)?.focus?.({ preventScroll: true });
  }
  static setOpen(panel, id, open) {
    const s = EmployeesObjects.state(panel);
    if (!EmployeesObjects.PARENTS.includes(id) || s.open.has(id) === open) return;
    if (open) s.open.add(id); else s.open.delete(id);
    s.focusId = id; EmployeesObjects.save(panel);
    EmployeesObjects.redraw(panel, { focus: `#emp-obj-${id}` });
  }
  static openDrawer(panel) { const s = EmployeesObjects.state(panel); s.drawer = true; EmployeesObjects.redraw(panel, { focus: '#employees-objects [role="treeitem"][tabindex="0"]' }); }
  static closeDrawer(panel) { const s = EmployeesObjects.state(panel); if (!s.drawer) return; s.drawer = false; EmployeesObjects.redraw(panel, { focus: "#employees-objects-toggle" }); }

  // ---- Keys (EmployeesPanel.onKeydown sends every key whose target is inside the panel). Returns whether it handled it.
  static onKeydown(panel, event) {
    const aside = event.target?.closest?.("#employees-objects");
    if (!aside) return false;
    const s = EmployeesObjects.state(panel), drawer = s.drawer && EmployeesObjects.narrow();
    if (event.key === "Escape" && drawer) { event.preventDefault(); EmployeesObjects.closeDrawer(panel); return true; }
    if (event.key === "Tab" && drawer) {
      const list = [...aside.querySelectorAll('button:not(:disabled), [role="treeitem"][tabindex="0"]')].filter((el) => !el.hidden && el.offsetParent !== null);
      if (!list.length) return false;
      const i = list.indexOf(document.activeElement), last = list.length - 1;
      if (event.shiftKey && i <= 0) { event.preventDefault(); list[last].focus(); return true; }
      if (!event.shiftKey && (i === last || i === -1)) { event.preventDefault(); list[0].focus(); return true; }
      return false;
    }
    const item = event.target.closest?.('[role="treeitem"]');
    if (!item || event.altKey || event.ctrlKey || event.metaKey) return false;
    const items = [...aside.querySelectorAll('[role="treeitem"]')].filter((el) => !el.closest("[hidden]"));
    const i = items.indexOf(item), id = item.dataset.oId, expanded = item.getAttribute("aria-expanded");
    const move = (el) => { if (!el) return; for (const x of items) x.tabIndex = x === el ? 0 : -1; s.focusId = el.dataset.oId; el.focus(); };
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); move(items[i + 1]); return true;
      case "ArrowUp": event.preventDefault(); move(items[i - 1]); return true;
      case "Home": event.preventDefault(); move(items[0]); return true;
      case "End": event.preventDefault(); move(items[items.length - 1]); return true;
      case "ArrowRight":
        event.preventDefault();
        if (expanded === "false") EmployeesObjects.setOpen(panel, id, true);
        else if (expanded === "true") move(items[i + 1]);
        return true;
      case "ArrowLeft": {
        event.preventDefault();
        if (expanded === "true") { EmployeesObjects.setOpen(panel, id, false); return true; }
        const level = Number(item.getAttribute("aria-level")) || 1;
        for (let j = i - 1; j >= 0; j -= 1) if ((Number(items[j].getAttribute("aria-level")) || 1) < level) { move(items[j]); break; }
        return true;
      }
      case "Enter": case " ":
        if (event.key === " " && item.tagName === "A") return false;
        event.preventDefault();
        if (item.getAttribute("aria-disabled") === "true") return true;
        item.click();
        return true;
      default: return false;
    }
  }
}
if (typeof window !== "undefined") window.EmployeesObjects = EmployeesObjects;
