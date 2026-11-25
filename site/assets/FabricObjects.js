// Fabric Data: the Objects panel, the app's primary navigation (left of #fabric-root; it replaces the old app-bar tabs).
//
//   Inventory              → the Inventory list as it was last left (its filters kept)
//     All records          → /fabric/inventory with no filter or search
//     My saved filters     → the person's saved filters (FabricSavedFilters, below)
//   Sales                  → the same
//   Invoices               → only while features.fabricData.invoiceViews (v1 views)
//   API Management         → only for API administrators with API tokens on (panel.apiVisible); never drawn for anyone else
//
// A navigation tree (WAI-ARIA APG "navigation treeview"): links with role="treeitem" (real hrefs: Ctrl/middle click opens a new
// tab), one tab stop (roving tabindex), ↑ ↓ Home End move, → expands / enters, ← collapses / goes to the parent, Enter opens,
// the open page is aria-current="page". On desktops the panel collapses to a 32 px rail (its button reopens it); at 1024 px or
// less it is a drawer (the app bar's Objects button): a modal dialog with a focus trap, closed by Escape, the backdrop or a
// choice, which gives focus back to the button that opened it.
//
// Browser storage: only which nodes are expanded and whether the panel is collapsed, as fixed node IDs, under a key per person
// (jarc.fabric.objects.<user id>); nothing at all without a known person. Never data, names or filter values.
//
// Saved filters hook (F4, FabricSavedFilters.js), all optional, behind typeof checks:
//   FabricSavedFilters.navItems(explorer) → null | undefined (not loaded yet: shows "Loading…"; F4 starts its own request and
//     calls panel.redrawObjects() when it has answered) | [{ id, name, current?, invalid?, problem?, href? }]
//     (id: 1–64 of [A-Za-z0-9_-]; current: this filter is the one applied; href: a /fabric/… link for the filter, optional).
//     Called only while that dataset's "My saved filters" node is expanded, so nothing is requested until the person opens it.
//   Each item is drawn as <a role="treeitem" data-action="fabric-s-open" data-ds="<dataset>" data-id="<id>">; the panel first
//     shows that dataset (route only), then routes fabric-s-* actions to FabricSavedFilters.onAction(explorer, action, target,
//     event) when it exists, else to the explorer's onAction.
//   FabricSavedFilters.clearCurrent(explorer): called when "All records" is chosen (no saved filter is applied any more).
class FabricObjects {
  static STORAGE_PREFIX = "jarc.fabric.objects.";
  static NARROW = "(max-width: 1024px)";
  static PARENTS = ["inventory", "sales", "inventory-saved", "sales-saved"]; // the expandable nodes (the only IDs ever stored)
  static DATASET_ICONS = { inventory: "database", sales: "records" };
  static ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;

  // ---- State (panel.objects): { collapsed, open: Set of expanded node IDs, drawer, focusId }
  static defaults() { return { collapsed: false, open: new Set(["inventory", "sales"]), drawer: false, focusId: "", loadedKey: null }; }
  static userId(panel) {
    const c = panel.c || {}, raw = c.auth?.userId || String(c.model?.me || "").replace(/^user:/, "");
    return typeof raw === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(raw) ? raw : "";
  }
  static storageKey(panel) { const id = FabricObjects.userId(panel); return id ? `${FabricObjects.STORAGE_PREFIX}${id}` : ""; }
  // The state for the person signed in now (read once per person; a different person starts from the defaults).
  static state(panel) {
    const key = FabricObjects.storageKey(panel);
    if (!panel.objects || panel.objects.loadedKey !== key) {
      const s = FabricObjects.defaults();
      s.loadedKey = key;
      if (key) {
        try {
          const v = JSON.parse(window.localStorage?.getItem(key) || "null");
          if (v && typeof v === "object" && v.v === 1) {
            s.collapsed = v.collapsed === true;
            if (Array.isArray(v.open)) s.open = new Set(v.open.filter((id) => FabricObjects.PARENTS.includes(id)));
          }
        } catch { /* storage blocked or unreadable: the defaults */ }
      }
      panel.objects = s;
    }
    return panel.objects;
  }
  static save(panel) {
    const s = FabricObjects.state(panel), key = s.loadedKey;
    if (!key) return;
    try { window.localStorage?.setItem(key, JSON.stringify({ v: 1, collapsed: s.collapsed, open: [...s.open].filter((id) => FabricObjects.PARENTS.includes(id)) })); } catch { /* a convenience only */ }
  }
  // Drawer mode (tablets and phones): the media query, when the browser has one.
  static narrow() { try { return Boolean(typeof window !== "undefined" && window.matchMedia?.(FabricObjects.NARROW)?.matches); } catch { return false; } }

  // ---- The tree: [{ id, label, icon, href, action, section?, ds?, children?, items? }]
  static savedApi() { return typeof FabricSavedFilters !== "undefined" && FabricSavedFilters && typeof FabricSavedFilters.navItems === "function" ? FabricSavedFilters : null; }
  static nodes(panel) {
    const out = [], s = FabricObjects.state(panel), saved = FabricObjects.savedApi();
    for (const ds of FabricDataPanel.DATASET_VIEWS) {
      if (!panel.datasetAllowed(ds)) continue;
      const x = panel.explorers[ds], label = FabricExplorer.DATASETS?.[ds] || (ds === "sales" ? "Sales" : "Inventory");
      const children = [{ id: `${ds}-all`, label: "All records", icon: "list", href: `/fabric/${ds}`, action: "fabric-o-all", ds }];
      if (saved) {
        let items = null;
        if (s.open.has(`${ds}-saved`)) { try { items = saved.navItems(x); } catch { items = []; } }
        children.push({ id: `${ds}-saved`, label: "My saved filters", icon: "filter", ds, saved: true, items: Array.isArray(items) ? items.filter((i) => i && FabricObjects.ITEM_ID.test(String(i.id || ""))) : null });
      }
      out.push({ id: ds, label, icon: FabricObjects.DATASET_ICONS[ds], href: x ? x.listHref() : `/fabric/${ds}`, action: "fabric-section", section: ds, children });
    }
    if (panel.invoiceViews) out.push({ id: "invoices", label: "Invoices", icon: "columns", href: "/fabric/invoices", action: "fabric-section", section: "invoices" });
    if (panel.apiVisible) out.push({ id: "api", label: "API Management", icon: "lock", href: "/fabric/api", action: "fabric-section", section: "api" });
    return out;
  }
  // The ID of the page open now (aria-current="page").
  static currentId(panel, nodes = FabricObjects.nodes(panel)) {
    const v = panel.route?.view;
    if (v === "api") return "api";
    if (v === "invoices" || v === "invoice") return "invoices";
    if (!panel.isDataset(v)) return "";
    const saved = nodes.find((n) => n.id === v)?.children?.find((c) => c.saved)?.items?.find((i) => i.current);
    return saved ? `${v}-saved-${saved.id}` : `${v}-all`;
  }

  // ---- Drawing
  static esc(panel, v) { return panel.esc(v); }
  static attr(panel, v) { return panel.attr(v); }
  // The app bar's Objects button (reopens a collapsed panel on desktops, opens the drawer on tablets and phones).
  static toggleHtml(panel) {
    const s = FabricObjects.state(panel), open = FabricObjects.narrow() ? s.drawer : !s.collapsed;
    return `<button type="button" id="fabric-objects-toggle" class="fx-btn fx-btn--icon fx-appbar__objects" data-action="fabric-o-panel" data-focus-key="objects-toggle" aria-controls="fabric-objects" aria-expanded="${open}" aria-label="Objects" title="Objects">${icon("menu")}</button>`;
  }
  static html(panel) {
    const s = FabricObjects.state(panel), nodes = FabricObjects.nodes(panel), current = FabricObjects.currentId(panel, nodes);
    const narrow = FabricObjects.narrow(), drawer = narrow && s.drawer;
    const ids = FabricObjects.visibleIds(nodes, s);
    const stop = ids.includes(s.focusId) ? s.focusId : ids.includes(current) ? current : ids.includes(panel.route?.view) ? panel.route.view : ids[0];
    const ctx = { panel, s, current, stop };
    const tree = nodes.map((n) => FabricObjects.nodeHtml(ctx, n, 1)).join("");
    const cls = `fx-objects${s.collapsed ? " is-collapsed" : ""}${drawer ? " is-drawer-open" : ""}`;
    const dialog = drawer ? ' role="dialog" aria-modal="true" aria-labelledby="fabric-objects-title"' : ' aria-labelledby="fabric-objects-title"';
    const collapse = `<button type="button" class="fx-btn fx-btn--icon fx-objects__collapse" data-action="fabric-o-collapse" data-focus-key="objects-collapse" aria-controls="fabric-objects-tree" aria-expanded="${!s.collapsed}" aria-label="${s.collapsed ? "Show" : "Hide"} the Objects panel" title="${s.collapsed ? "Show" : "Hide"} the Objects panel">${icon(s.collapsed ? "right" : "left")}</button>`;
    const close = `<button type="button" class="fx-btn fx-btn--icon fx-objects__close" data-action="fabric-o-close" data-focus-key="objects-close" aria-label="Close Objects" title="Close">${icon("close")}</button>`;
    return `<aside id="fabric-objects" class="${cls}"${dialog}><div class="fx-objects__caption"><span class="fx-objects__title" id="fabric-objects-title">Objects</span>${collapse}${close}</div><ul id="fabric-objects-tree" class="fx-objects__tree" role="tree" aria-labelledby="fabric-objects-title">${tree}</ul></aside><div class="fx-objects__backdrop" data-action="fabric-o-close" aria-hidden="true"${drawer ? "" : " hidden"}></div>`;
  }
  // The treeitems shown now (expanded parents' children included), in order: for the roving tab stop and the arrow keys.
  static visibleIds(nodes, s) {
    const out = [];
    const walk = (n) => {
      out.push(n.id);
      if (n.children && s.open.has(n.id)) for (const c of n.children) walk(c);
      if (n.saved && s.open.has(n.id)) { if (Array.isArray(n.items) && n.items.length) for (const i of n.items) out.push(`${n.id}-${i.id}`); else out.push(`${n.id}-none`); }
    };
    for (const n of nodes) walk(n);
    return out;
  }
  static itemAttrs(ctx, id, level, { expanded = null, owns = "" } = {}) {
    const on = id === ctx.current;
    return ` id="fabric-obj-${id}" role="treeitem" data-o-id="${id}" aria-level="${level}" tabindex="${id === ctx.stop ? 0 : -1}"${expanded === null ? "" : ` aria-expanded="${expanded}"`}${owns ? ` aria-owns="${owns}"` : ""}${on ? ' aria-current="page"' : ""}`;
  }
  static twisty(id, open) { return `<span class="fx-objects__twisty${open ? " is-open" : ""}" data-action="fabric-o-toggle" data-o-id="${id}" aria-hidden="true">${icon("chevron")}</span>`; }
  static nodeHtml(ctx, n, level) {
    const { panel, s, current } = ctx, esc = (v) => panel.esc(v), attr = (v) => panel.attr(v);
    const open = s.open.has(n.id), parent = Boolean(n.children || n.saved), group = `fabric-obj-${n.id}-group`;
    const active = current === n.id || (current && current.startsWith(`${n.id}-`)) ? " is-active" : "";
    const label = `${icon(n.icon)}<span class="fx-objects__label">${esc(n.label)}</span>`;
    let row;
    if (n.saved) {
      row = `<span class="fx-objects__row fx-objects__row--l${level}${active}" data-action="fabric-o-toggle"${FabricObjects.itemAttrs(ctx, n.id, level, { expanded: open, owns: group })}>${FabricObjects.twisty(n.id, open)}${label}</span>`;
    } else {
      const extra = `${n.section ? ` data-section="${attr(n.section)}"` : ""}${n.ds ? ` data-ds="${attr(n.ds)}"` : ""}`;
      row = `<a class="fx-objects__row fx-objects__row--l${level}${active}" href="${attr(n.href)}" data-action="${n.action}"${extra}${FabricObjects.itemAttrs(ctx, n.id, level, parent ? { expanded: open, owns: group } : {})}>${parent ? FabricObjects.twisty(n.id, open) : '<span class="fx-objects__twisty" aria-hidden="true"></span>'}${label}</a>`;
    }
    if (!parent) return `<li class="fx-objects__node" role="none">${row}</li>`;
    let kids = "";
    if (n.children) kids = n.children.map((c) => FabricObjects.nodeHtml(ctx, c, level + 1)).join("");
    else if (n.saved) kids = FabricObjects.savedHtml(ctx, n, level + 1);
    return `<li class="fx-objects__node" role="none">${row}<ul class="fx-objects__group" role="group" id="${group}" aria-label="${attr(n.label)}"${open ? "" : " hidden"}>${open ? kids : ""}</ul></li>`;
  }
  static savedHtml(ctx, n, level) {
    const { panel } = ctx, esc = (v) => panel.esc(v), attr = (v) => panel.attr(v);
    if (!Array.isArray(n.items)) return `<li class="fx-objects__node" role="none"><span class="fx-objects__row fx-objects__row--l${level} fx-objects__row--note" aria-disabled="true"${FabricObjects.itemAttrs(ctx, `${n.id}-none`, level)}><span class="fx-objects__twisty" aria-hidden="true"></span><span class="fx-objects__label">Loading…</span></span></li>`;
    if (!n.items.length) return `<li class="fx-objects__node" role="none"><span class="fx-objects__row fx-objects__row--l${level} fx-objects__row--note" aria-disabled="true"${FabricObjects.itemAttrs(ctx, `${n.id}-none`, level)}><span class="fx-objects__twisty" aria-hidden="true"></span><span class="fx-objects__label">No saved filters yet</span></span></li>`;
    return n.items.map((i) => {
      const id = `${n.id}-${i.id}`, href = typeof i.href === "string" && /^\/fabric\/(inventory|sales)(\/|\?|$)/.test(i.href) ? i.href : `/fabric/${n.ds}`;
      const warn = i.invalid ? `<span class="fx-objects__warn" title="${attr(i.problem || "This filter needs checking")}">!<span class="sr-only"> ${esc(i.problem || "This filter needs checking")}</span></span>` : "";
      return `<li class="fx-objects__node" role="none"><a class="fx-objects__row fx-objects__row--l${level}${i.invalid ? " is-invalid" : ""}" href="${attr(href)}" data-action="fabric-s-open" data-ds="${attr(n.ds)}" data-id="${attr(i.id)}"${FabricObjects.itemAttrs(ctx, id, level)} title="${attr(i.name)}"><span class="fx-objects__twisty" aria-hidden="true"></span><span class="fx-objects__label">${esc(i.name)}</span>${warn}</a></li>`;
    }).join("");
  }

  // ---- Redrawing only the panel (and the app bar's button), keeping focus on the same treeitem or button.
  static redraw(panel, { focus = "" } = {}) {
    if (typeof document === "undefined") return;
    const aside = document.querySelector("#fabric-objects");
    if (!aside) return;
    const active = document.activeElement, inside = active && aside.contains(active);
    const keep = focus || (inside ? (active.dataset?.oId ? `#fabric-obj-${active.dataset.oId}` : active.dataset?.focusKey ? `[data-focus-key="${active.dataset.focusKey}"]` : "") : "");
    const holder = document.createElement("div");
    holder.innerHTML = FabricObjects.html(panel);
    const [nextAside, nextBackdrop] = holder.children;
    const backdrop = aside.nextElementSibling?.classList?.contains("fx-objects__backdrop") ? aside.nextElementSibling : null;
    aside.replaceWith(nextAside);
    if (backdrop && nextBackdrop) backdrop.replaceWith(nextBackdrop);
    const toggle = document.querySelector("#fabric-objects-toggle");
    if (toggle) { const s = FabricObjects.state(panel); toggle.setAttribute("aria-expanded", String(FabricObjects.narrow() ? s.drawer : !s.collapsed)); }
    if (keep) (document.querySelector(keep) || nextAside.querySelector('[role="treeitem"][tabindex="0"]'))?.focus?.({ preventScroll: true });
  }

  // ---- Actions (fabric-o-*, routed here by FabricDataPanel.onAction)
  static onAction(panel, action, target, event) {
    const s = FabricObjects.state(panel);
    if (action === "fabric-o-toggle") {
      event?.preventDefault?.(); event?.stopPropagation?.();
      const id = target.dataset.oId;
      FabricObjects.setOpen(panel, id, !s.open.has(id));
      return;
    }
    if (action === "fabric-o-collapse") {
      if (FabricObjects.narrow()) { FabricObjects.closeDrawer(panel); return; }
      s.collapsed = !s.collapsed; FabricObjects.save(panel);
      FabricObjects.redraw(panel, { focus: '[data-focus-key="objects-collapse"]' });
      return;
    }
    if (action === "fabric-o-panel") {
      if (FabricObjects.narrow()) { if (s.drawer) FabricObjects.closeDrawer(panel); else FabricObjects.openDrawer(panel); return; }
      s.collapsed = !s.collapsed; FabricObjects.save(panel);
      FabricObjects.redraw(panel, { focus: s.collapsed ? "#fabric-objects-toggle" : '#fabric-objects [role="treeitem"][tabindex="0"]' });
      return;
    }
    if (action === "fabric-o-close") { FabricObjects.closeDrawer(panel); return; }
    if (action === "fabric-o-all") {
      const ds = target.dataset.ds, x = panel.explorers[ds];
      if (!x || !panel.datasetAllowed(ds)) return;
      const saved = FabricObjects.savedApi();
      try { saved?.clearCurrent?.(x); } catch { /* the saved-filters module's own concern */ }
      x.applyQuery({ ...FabricExplorer.emptyQuery() });
      FabricObjects.afterChoice(panel, `${ds}-all`);
      panel.openSection(ds, { focus: false });
      FabricObjects.focusAfterChoice(panel, `${ds}-all`);
    }
  }
  // After a choice: remembered as the tab stop; the drawer closes (focus goes back to its button).
  static afterChoice(panel, id) { const s = FabricObjects.state(panel); s.focusId = id; if (s.drawer) { s.drawer = false; s.restore = true; } }
  static focusAfterChoice(panel, id) {
    if (typeof document === "undefined") return;
    const s = FabricObjects.state(panel);
    if (s.restore) { s.restore = false; document.querySelector("#fabric-objects-toggle")?.focus?.(); return; }
    document.querySelector(`#fabric-obj-${id}`)?.focus?.({ preventScroll: true });
  }
  static setOpen(panel, id, open) {
    const s = FabricObjects.state(panel);
    if (!FabricObjects.PARENTS.includes(id) || s.open.has(id) === open) return;
    if (open) s.open.add(id); else s.open.delete(id);
    s.focusId = id; FabricObjects.save(panel);
    FabricObjects.redraw(panel, { focus: `#fabric-obj-${id}` });
  }
  static openDrawer(panel) {
    const s = FabricObjects.state(panel);
    s.drawer = true;
    FabricObjects.redraw(panel, { focus: '#fabric-objects [role="treeitem"][tabindex="0"]' });
  }
  static closeDrawer(panel) {
    const s = FabricObjects.state(panel);
    if (!s.drawer) return;
    s.drawer = false;
    FabricObjects.redraw(panel, { focus: "#fabric-objects-toggle" });
  }

  // ---- Keys (FabricDataPanel.onKeydown sends every key whose target is inside the panel). Returns whether it handled it.
  static onKeydown(panel, event) {
    const aside = event.target?.closest?.("#fabric-objects");
    if (!aside) return false;
    const s = FabricObjects.state(panel), drawer = s.drawer && FabricObjects.narrow();
    if (event.key === "Escape" && drawer) { event.preventDefault(); FabricObjects.closeDrawer(panel); return true; }
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
        if (expanded === "false") FabricObjects.setOpen(panel, id, true);
        else if (expanded === "true") move(items[i + 1]);
        return true;
      case "ArrowLeft": {
        event.preventDefault();
        if (expanded === "true") { FabricObjects.setOpen(panel, id, false); return true; }
        const level = Number(item.getAttribute("aria-level")) || 1;
        for (let j = i - 1; j >= 0; j -= 1) if ((Number(items[j].getAttribute("aria-level")) || 1) < level) { move(items[j]); break; }
        return true;
      }
      case "Enter": case " ":
        if (event.key === " " && item.tagName === "A") return false; // Space on a link keeps its usual meaning; on "My saved filters" it toggles
        event.preventDefault();
        if (item.getAttribute("aria-disabled") === "true") return true;
        item.click();
        return true;
      default: return false;
    }
  }
}
if (typeof window !== "undefined") window.FabricObjects = FabricObjects;
