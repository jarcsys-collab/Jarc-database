// Board groups (Phase 8) and the board toolbar's menus. Loaded after AppView.js: adds view methods to AppView and
// defines BoardGroupActions, which AppController uses for every "group-…" and "toolbar-…" action.
//
// Permanent groups are the board's own data (BoardModel: groups, groupMeta, groupOf). The view's "Group by" is
// presentation only: it sections the current view by a column's values and never changes a record or a group.
Object.assign(AppView.prototype, {
  // ---- Table with the board's groups
  // One table, one header: each group is a <tbody> (its header row, then its records and an Add record row), so
  // column resizing, reordering and visibility work across the whole board.
  boardGroupsView(rows, model) {
    const filtering = Boolean(model.query || model.status !== "All" || model.quickFilter !== "all" || model.columnFilter || model.personFilter);
    const known = new Set(model.board.groups), archived = new Set(model.archivedGroupNames), editable = !model.board.source?.readOnly;
    const sections = model.activeGroups.map((name) => ({ name, rows: rows.filter((r) => model.groupOf(r) === name) }))
      .filter((s) => !filtering || s.rows.length);
    const loose = rows.filter((r) => !known.has(model.groupOf(r)));
    const shown = [...sections.flatMap((s) => (model.isGroupCollapsed(s.name) ? [] : s.rows)), ...loose];
    const bodies = sections.map((s) => this.groupSection(model, s.name, s.rows, { editable })).join("") + (loose.length ? this.groupSection(model, "", loose, { editable, loose: true }) : "");
    const hiddenCount = rows.filter((r) => archived.has(model.groupOf(r))).length;
    const footer = `<div class="group-footer">${editable ? `<button type="button" class="add-group-button" data-action="group-new">${icon("plus")}<span>Add new group</span></button>` : ""}${archived.size ? `<button type="button" class="link-button archived-groups-button" data-action="group-archived" aria-haspopup="menu">${archived.size} archived group${archived.size === 1 ? "" : "s"}${hiddenCount ? ` · ${hiddenCount} record${hiddenCount === 1 ? "" : "s"}` : ""}</button>` : ""}</div>`;
    const table = bodies ? this.table(shown, model, "", bodies) : `<div class="quiet-empty">${icon("records")}<span><strong>No records match</strong></span></div>`;
    return `<section class="data-region board-groups">${table}${footer}</section>`;
  },
  groupHeaderRow(model, { name, label, color, count, collapsed, loose = false, editable = true, note = "", toggle = true }) {
    const span = model.visibleColumns.length + 3;
    return `<tr class="group-header-row"><th colspan="${span}" scope="rowgroup"><div class="group-header">
      ${toggle ? `<button type="button" class="group-toggle" data-action="group-toggle" data-group="${this.attr(name)}" aria-expanded="${!collapsed}" aria-label="${collapsed ? "Expand" : "Collapse"} ${this.attr(label)}" ${loose ? "disabled" : ""}>${icon("chevron")}</button>` : `<span class="group-toggle is-static" aria-hidden="true">${icon("group")}</span>`}
      <h3 class="group-name">${!loose && editable && toggle ? `<button type="button" data-action="group-rename" data-group="${this.attr(name)}" title="Rename group">${this.escape(label)}</button>` : `<span>${this.escape(label)}</span>`}</h3>
      <span class="group-count">${count} record${count === 1 ? "" : "s"}</span>${note ? `<small class="group-note">${note}</small>` : ""}
      ${!loose && toggle ? `<button type="button" class="icon-button group-menu-button" data-action="group-menu" data-group="${this.attr(name)}" aria-haspopup="menu" aria-label="Actions for group ${this.attr(label)}" title="Group actions">${icon("more")}</button>` : ""}
    </div></th></tr>`;
  },
  groupSection(model, name, rows, { editable, loose = false }) {
    const collapsed = !loose && model.isGroupCollapsed(name), color = loose ? "#94a3b8" : model.groupColor(name), label = loose ? "No group" : name;
    const head = this.groupHeaderRow(model, { name, label, color, count: rows.length, collapsed, loose, editable });
    const body = collapsed ? "" : rows.map((row) => this.row(row, model)).join("") + (editable && !loose ? this.quickAddRow(model, name, !rows.length) : "");
    return `<tbody class="board-group ${collapsed ? "is-collapsed" : ""} ${loose ? "is-loose" : ""}" style="--group-color:${this.cssColor(color)}" data-group="${this.attr(name)}" aria-label="${this.attr(label)}, ${rows.length} record${rows.length === 1 ? "" : "s"}">${head}${body}</tbody>`;
  },
  // View Group by: sections by a column's values (presentation only; no group actions).
  columnGroupsView(rows, model) {
    const column = model.groupByColumn, buckets = new Map();
    const order = column.type === "owner" ? [] : column.type === "checkbox" ? ["Checked", "Unchecked"] : model.effectiveOptions(column);
    for (const value of order) buckets.set(value, []);
    for (const r of rows) { const v = model.groupValue(r, column); (buckets.get(v) || buckets.set(v, []).get(v)).push(r); }
    const list = [...buckets].filter(([, l]) => l.length);
    if (!list.length) return `<section class="data-region board-groups"><div class="quiet-empty">${icon("records")}<span><strong>No records match</strong></span></div></section>`;
    const bodies = list.map(([value, l]) => `<tbody class="board-group view-group" style="--group-color:${this.cssColor(model.optionColor?.(column, value), "#64748b")}" data-view-group="${this.attr(value)}">${this.groupHeaderRow(model, { name: value, label: value, count: l.length, toggle: false, note: `Grouped by ${this.escape(column.label)}` })}${l.map((row) => this.row(row, model)).join("")}</tbody>`).join("");
    return `<section class="data-region board-groups">${this.table(rows, model, "", bodies)}</section>`;
  },

  // ---- Group menus and dialogs
  showGroupMenu(model, name) {
    const editable = !model.board.source?.readOnly, collapsed = model.isGroupCollapsed(name), list = model.board.groups, i = list.indexOf(name);
    const item = (action, ic, label, extra = "") => `<button role="menuitem" data-action="${action}" data-group="${this.attr(name)}" ${extra}>${icon(ic)} ${label}</button>`;
    const swatches = BoardModel.GROUP_COLORS.map((c) => `<button type="button" role="menuitemradio" aria-checked="${model.groupColor(name) === c.value}" class="color-swatch" data-action="group-color" data-group="${this.attr(name)}" data-color="${c.value}" style="--swatch:${c.value}" aria-label="${c.name}" title="${c.name}"></button>`).join("");
    document.querySelector("#overlay-root").innerHTML = `<div class="popover group-menu-popover" role="menu" aria-label="Group ${this.attr(name)}"><div class="popover-title"><strong style="color:${this.cssColor(model.groupColor(name))}">${this.escape(name)}</strong><small>${(n=>`${n} record${n===1?"":"s"}`)(model.groupRows(name).length)}</small></div>
      ${item("group-toggle", "chevron", collapsed ? "Expand this group" : "Collapse this group")}${item("group-collapse-all", "layout", "Collapse all groups")}${item("group-expand-all", "layout", "Expand all groups")}
      ${editable ? `<div class="menu-divider" role="separator"></div>${item("group-add-record", "plus", "Add record")}${item("group-new-below", "plus", "Add group below")}${item("group-rename", "edit", "Rename group")}<div class="menu-section-label" role="presentation">Group colour</div><div class="swatch-row" role="group" aria-label="Group colour">${swatches}</div>
      <div class="menu-divider" role="separator"></div>${item("group-duplicate", "copy", "Duplicate group")}${item("group-duplicate-records", "copy", "Duplicate with records")}${item("group-move-up", "arrowUp", "Move group up", i <= 0 ? "disabled" : "")}${item("group-move-down", "arrowDown", "Move group down", i >= list.length - 1 ? "disabled" : "")}
      <div class="menu-divider" role="separator"></div>${item("group-archive", "archive", "Archive group", model.activeGroups.length <= 1 ? 'disabled title="A board keeps at least one visible group"' : "")}${item("group-delete", "trash", "Delete group", `class="danger" ${list.length <= 1 ? 'disabled title="A board keeps at least one group"' : ""}`)}` : `<p class="menu-note">This board is synced from monday.com and is read-only.</p>`}
    </div>`;
  },
  showGroupForm(model, { mode = "new", name = "", at = null } = {}) {
    const current = mode === "rename" ? name : model.uniqueGroupName("New group"), color = mode === "rename" ? model.groupColor(name) : model.nextGroupColor();
    const swatches = BoardModel.GROUP_COLORS.map((c) => `<label class="color-choice" title="${c.name}"><input type="radio" name="color" value="${c.value}" ${c.value === color ? "checked" : ""}><span style="--swatch:${c.value}" aria-hidden="true"></span><span class="sr-only">${c.name}</span></label>`).join("");
    this.overlay(`<form class="modal small-modal group-form" data-action="group-form" data-mode="${mode}" data-group="${this.attr(name)}" data-at="${at ?? ""}"><div class="modal-head"><div><div class="eyebrow">${this.escape(model.board.name)}</div><h2>${mode === "rename" ? "Rename group" : "New group"}</h2></div>${this.closeButton()}</div>
      <label class="field">Group name<input name="name" value="${this.attr(current)}" maxlength="200" required autofocus autocomplete="off"></label>
      <fieldset class="color-field"><legend>Colour</legend><div class="color-choices">${swatches}</div></fieldset>
      <div class="modal-actions"><button type="button" class="button secondary" data-action="close-overlay">Cancel</button><button class="button primary" type="submit">${mode === "rename" ? "Save" : "Create group"}</button></div></form>`);
  },
  showGroupDelete(model, name) {
    const count = model.groupRows(name).length, others = model.board.groups.filter((g) => g !== name);
    const choices = count ? `<fieldset class="delete-choice"><legend>${count} record${count === 1 ? "" : "s"} in this group</legend>
      <label class="radio-row"><input type="radio" name="mode" value="move" checked> Move them to <select name="moveTo" aria-label="Move records to">${others.map((g) => `<option value="${this.attr(g)}">${this.escape(g)}</option>`).join("")}</select></label>
      <label class="radio-row danger-text"><input type="radio" name="mode" value="delete"> Delete them permanently</label></fieldset>` : `<input type="hidden" name="mode" value="move"><input type="hidden" name="moveTo" value="${this.attr(others[0] || "")}">`;
    this.overlay(`<form class="modal small-modal" data-action="group-delete-form" data-group="${this.attr(name)}"><div class="modal-head"><div><div class="eyebrow">Delete group</div><h2>Delete “${this.escape(name)}”?</h2></div>${this.closeButton()}</div><p>${count ? "Choose what happens to its records." : "This group has no records."} Archive the group instead to hide it and keep it restorable.</p>${choices}<div class="modal-actions"><button type="button" class="button secondary" data-action="close-overlay">Cancel</button><button class="button danger" type="submit">Delete group</button></div></form>`);
  },
  showArchivedGroups(model) {
    const editable = !model.board.source?.readOnly;
    document.querySelector("#overlay-root").innerHTML = `<div class="popover group-menu-popover" role="menu" aria-label="Archived groups"><div class="popover-title"><strong>Archived groups</strong><small>Hidden from the table</small></div>${model.archivedGroupNames.map((g) => `<div class="archived-group-row"><span class="group-dot" style="background:${this.cssColor(model.groupColor(g))}"></span><span>${this.escape(g)} <small>${model.groupRows(g).length}</small></span>${editable ? `<button role="menuitem" class="button secondary small" data-action="group-restore" data-group="${this.attr(g)}">Restore</button>` : ""}</div>`).join("")}</div>`;
  },

  // Move records to a group: the record menu (one record) or the bulk bar (the selection).
  showGroupPicker(model, ids) {
    const current = ids.length === 1 ? model.groupOf(model.rows.find((r) => String(r.id) === String(ids[0]))) : null;
    document.querySelector("#overlay-root").innerHTML = `<div class="popover toolbar-menu-popover" role="menu" aria-label="Move to group"><div class="menu-section-label" role="presentation">Move ${ids.length === 1 ? "record" : `${ids.length} records`} to</div>${model.activeGroups.map((g) => `<button role="menuitemradio" aria-checked="${g === current}" class="${g === current ? "is-selected" : ""}" data-action="group-move-records" data-group="${this.attr(g)}" data-ids="${this.attr(ids.join(","))}"><span class="group-dot" style="background:${this.cssColor(model.groupColor(g))}"></span>${this.escape(g)}</button>`).join("")}</div>`;
  },
  // ---- Toolbar dropdowns (custom menus: themed in light and dark mode, unlike native select popups)
  toolbarMenuButton(kind, label, { active = false, iconName = "", title = "" } = {}) {
    return `<button type="button" class="tool-button menu-button ${active ? "active" : ""}" data-action="toolbar-menu" data-menu="${kind}" aria-haspopup="menu" aria-expanded="false" ${title ? `title="${this.attr(title)}"` : ""}>${iconName ? icon(iconName) : ""}<span>${label}</span>${icon("chevron")}</button>`;
  },
  showToolbarMenu(model, kind) {
    const radio = (value, label, on, extra = "") => `<button role="menuitemradio" aria-checked="${on}" class="${on ? "is-selected" : ""}" data-action="toolbar-choose" data-menu="${kind}" data-value="${this.attr(value)}" ${extra}>${label}</button>`;
    let title = "", body = "";
    if (kind === "new") { title = "Create"; body = `<button role="menuitem" data-action="open-form">${icon("plus")} New record</button><button role="menuitem" data-action="group-new">${icon("group")} New group</button>`; }
    if (kind === "quick") { title = "Show"; body = [["all", "All records"], ["mine", "My records"], ["due", "Due soon"], ["recent", "Recently updated"]].map(([v, t]) => radio(v, t, model.quickFilter === v)).join(""); }
    if (kind === "status") { const statuses = model.statusColumn?.options?.length ? model.statusColumn.options : [...new Set(model.rows.map((r) => r[model.statusColumn?.key]).filter(Boolean))]; title = model.statusColumn?.label || "Status"; body = radio("All", "All statuses", model.status === "All") + statuses.map((s) => radio(s, this.pill(s, model.optionColor?.(model.statusColumn, s)), model.status === s)).join(""); }
    if (kind === "person") { title = "Person"; const people = [...new Set(model.rows.flatMap((r) => model.valueList(r[model.ownerColumn?.key])))]; body = radio("", "Everyone", !model.personFilter) + (people.length ? people.map((p) => radio(p, `<span class="person-avatar" aria-hidden="true">${this.escape(this.initials(model.personLabel(p)))}</span> ${this.escape(model.personLabel(p))}`, model.personFilter === p)).join("") : `<p class="menu-note">No one is assigned yet.</p>`); }
    if (kind === "groupby") { title = "Group by"; body = radio("", "Board groups", !model.groupBy) + model.groupByColumns.map((c) => radio(c.key, this.escape(c.label), model.groupBy === c.key)).join("") + `<p class="menu-note">Group by changes only how this view is shown.</p>`; }
    document.querySelector("#overlay-root").innerHTML = `<div class="popover toolbar-menu-popover" role="menu" aria-label="${this.attr(title)}"><div class="menu-section-label" role="presentation">${this.escape(title)}</div>${body}</div>`;
  }
});

class BoardGroupActions {
  constructor(controller) { this.c = controller; }
  get model() { return this.c.model; }
  get view() { return this.c.view; }
  done(message, undo = true) { this.view.closeOverlay(); this.c.update(); if (message) this.view.toast(message, undo); }

  onAction(action, target) {
    const model = this.model, name = target.dataset.group ?? "";
    const readOnly = Boolean(model.board?.source?.readOnly);
    if (readOnly && !["group-menu", "group-toggle", "group-collapse-all", "group-expand-all", "group-archived", "toolbar-menu", "toolbar-choose"].includes(action)) { this.view.toast("This board is synced from monday.com and is read-only"); return; }
    switch (action) {
      case "group-menu": return this.c.togglePanel(`group-menu-${name}`, () => this.view.showGroupMenu(model, name));
      case "group-toggle": model.toggleGroupCollapsed(name); return this.done();
      case "group-collapse-all": model.collapseAllGroups(true); return this.done();
      case "group-expand-all": model.collapseAllGroups(false); return this.done();
      case "group-archived": return this.c.togglePanel("group-archived", () => this.view.showArchivedGroups(model));
      case "group-new": return this.view.showGroupForm(model, { mode: "new" });
      case "group-new-below": return this.view.showGroupForm(model, { mode: "new", at: model.board.groups.indexOf(name) + 1 });
      case "group-rename": return this.view.showGroupForm(model, { mode: "rename", name });
      case "group-color": if (model.setGroupColor(name, target.dataset.color)) this.done("Group colour changed"); else this.view.closeOverlay(); return;
      case "group-add-record": { this.view.closeOverlay(); if (model.isGroupCollapsed(name)) model.toggleGroupCollapsed(name, false); this.c.update(); const trigger = this.c.root.querySelector(`.board-group[data-group="${CSS.escape(name)}"] [data-action="inline-add"]`); if (trigger) this.c.startInlineAdd(trigger); return; }
      case "group-duplicate": case "group-duplicate-records": { const copy = model.duplicateGroup(name, { withRecords: action === "group-duplicate-records" }); return this.done(copy ? `Created ${copy}${action === "group-duplicate-records" ? " (records copied without files or updates)" : ""}` : ""); }
      case "group-move-up": case "group-move-down": if (model.moveGroup(name, action === "group-move-up" ? -1 : 1)) this.done("Group moved"); return;
      case "group-archive": if (model.archiveGroup(name, true)) this.done(`Archived ${name}`); else this.view.toast("A board keeps at least one visible group"); return;
      case "group-restore": if (model.archiveGroup(name, false)) this.done(`Restored ${name}`); return;
      case "group-delete": return this.view.showGroupDelete(model, name);
      case "group-pick": { const ids = target.dataset.id ? [target.dataset.id] : [...model.selected].map(String); if (ids.length) this.c.togglePanel("group-pick", () => this.view.showGroupPicker(model, ids)); return; }
      case "group-move-records": { const ids = String(target.dataset.ids || "").split(",").filter(Boolean); const n = model.moveToGroup(ids, name); if (n) model.selected.clear(); return this.done(n ? `Moved ${n} record${n === 1 ? "" : "s"} to ${name}` : ""); }
      case "toolbar-menu": return this.c.togglePanel(`toolbar-${target.dataset.menu}`, () => this.view.showToolbarMenu(model, target.dataset.menu));
      case "toolbar-choose": {
        const value = target.dataset.value ?? "", kind = target.dataset.menu;
        if (kind === "quick") model.quickFilter = value || "all";
        if (kind === "status") model.status = value || "All";
        if (kind === "person") model.personFilter = value;
        if (kind === "groupby") model.groupBy = value;
        model.selected.clear();
        return this.done();
      }
    }
  }
  onSubmit(action, data, form) {
    const model = this.model;
    if (action === "group-form") {
      const mode = form.dataset.mode, old = form.dataset.group, name = String(data.name || "").trim(), color = String(data.color || "");
      if (!name) { this.view.toast("Give the group a name"); return; }
      if (mode === "rename") {
        if (name !== old && !model.renameGroup(old, name)) { this.view.showMessage("Group not renamed", "Another group already has that name."); return; }
        if (color) model.setGroupColor(name, color);
        return this.done("Group updated");
      }
      if (!model.addGroup(name, { color, at: form.dataset.at === "" ? null : Number(form.dataset.at) })) { this.view.showMessage("Group not added", "Use a unique, non-empty group name."); return; }
      if (model.isGroupCollapsed(name)) model.toggleGroupCollapsed(name, false);
      return this.done(`Created ${name}`);
    }
    if (action === "group-delete-form") {
      const name = form.dataset.group, remove = data.mode === "delete";
      if (!model.deleteGroup(name, data.moveTo, { deleteRecords: remove })) { this.view.showMessage("Group not deleted", "A board keeps at least one group."); return; }
      return this.done(remove ? "Group and its records deleted" : `Group deleted · records moved to ${data.moveTo}`);
    }
  }
}
