// Column System C1: the column header menu (the header's ⋯ button). Only what this person may do is listed (the server
// still decides: routes/resources.js), grouped by who a change affects:
//   • "Everyone on this board": the board's schema — rename, description, settings, labels, type, add to the right,
//     duplicate, delete; and, on the Main Table, hide, move and width (those change the board's own column for everyone).
//   • The view group: sort, filter and group by are never stored on the board. On the Main Table they are this person's,
//     for now only (not saved); in a saved view they change that view and are kept only with "Save to this view" (a personal
//     view: only you; a shared view: everyone using it). In a saved view hide, move and width are view settings too.
// Roles, as the server checks them: VIEWER — view items only; MEMBER — schema edits except changing the type and
// deleting; WORKSPACE_ADMIN — everything. Synced (read-only) boards: view items only. Local (browser) storage has no
// roles: everything. "Change type" lists only ColumnTypes.conversionTargets and opens the existing S0-A check.
class ColumnMenu {
  // The server's ranks (server/src/auth/access.js RANK). A role this file doesn't know is not guessed down to "viewer":
  // the server stays the judge, so the item is shown and a refusal is reported as usual.
  static RANK = { VIEWER: 1, MEMBER: 2, WORKSPACE_ADMIN: 3, SYSTEM_ADMIN: 4 };
  constructor(view) { this.view = view; }

  // What this person may change on the open board (the server enforces the same; this only hides what would be refused).
  static permissions(model) {
    const role = model.workspace?.role || null, readOnly = Boolean(model.board?.source?.readOnly);
    const atLeast = (r) => !role || !(role in ColumnMenu.RANK) || ColumnMenu.RANK[role] >= ColumnMenu.RANK[r];
    return { role, readOnly, edit: !readOnly && atLeast("MEMBER"), admin: !readOnly && atLeast("WORKSPACE_ADMIN") };
  }
  // Who a view-level change (sort, filter, group; in a saved view also hide, move, width) affects, as worded in the menu.
  static viewScope(model) {
    const v = model.activeView;
    if (!v) return { kind: "session", label: "Only you", note: "Not saved · Views keep it" };
    if (v.personal) return { kind: "personal", label: "Only you · this view", note: "Kept when you save this view" };
    return { kind: "shared", label: "This view", note: "Everyone using it, once you save the view" };
  }
  static BOARD_SCOPE = "Everyone on this board";

  registry() { return window.ColumnTypes || null; }
  descriptor(type) { try { return this.registry()?.get?.(type) || null; } catch { return null; } }
  // The types this column can be converted to: the registry's list (never the column's own type), known to this board.
  conversionTargets(model, column) {
    const CT = this.registry();
    if (["serial"].includes(column.key) || ["files", "group", "connect", "mirror"].includes(column.type)) return [];
    let list;
    if (CT?.conversionTargets) { try { list = CT.conversionTargets(column, { relationsAvailable: Boolean(model.relationsAvailable), board: model.board }) || []; } catch { list = []; } }
    else list = model.columnTypes.filter((t) => !["files", "connect", "mirror", "group"].includes(t.type));
    const seen = new Set();
    return list.map((t) => (typeof t === "string" ? (CT?.get?.(t) || { id: t, label: model.columnType(t)?.label || t }) : t.type && !t.id ? { id: t.type, label: t.label, description: t.description } : t))
      .filter((d) => d && d.id !== column.type && model.columnType(d.id) && !seen.has(d.id) && seen.add(d.id));
  }
  // Whether an action applies to this column's type (the registry's flags; everything not flagged off is supported).
  can(column, action) {
    let actions = null;
    try { actions = this.registry()?.columnActions?.(column) || this.descriptor(column.type)?.actions || null; } catch { actions = null; }
    if (!actions) return true; // no registry: today's menu (group by is checked against groupByColumns)
    return actions[action] !== false;
  }

  html(model, key) {
    const v = this.view, c = model.board.columns.find((item) => item.key === key); if (!c) return "";
    const perm = ColumnMenu.permissions(model), scope = ColumnMenu.viewScope(model), inView = Boolean(model.activeView);
    const primary = c.key === "serial", optionable = ["status", "dropdown", "priority"].includes(c.type);
    const order = model.orderedColumns || model.board.columns, index = order.indexOf(c), firstMovable = index <= 1, lastColumn = index === order.length - 1;
    const sortedHere = model.sortKey === c.key && !model.manualSort, filteredHere = model.columnFilter?.key === c.key, groupedHere = model.groupBy === c.key;
    const groupable = (model.groupByColumns || []).some((g) => g.key === c.key) && this.can(c, "group");
    const reason = (text) => `<small class="menu-reason">${text}</small>`;
    const item = (action, ic, label, extra = "") => `<button role="menuitem" data-action="${action}" data-key="${v.attr(c.key)}" ${extra}>${v.iconHtml(ic)} <span class="menu-label">${label}</span></button>`;
    const section = (title, note = "", cls = "") => `<div class="menu-section-label column-scope ${cls}" role="presentation"><span>${v.escape(title)}</span>${note ? `<small>${v.escape(note)}</small>` : ""}</div>`;
    const targets = perm.admin && this.can(c, "changeType") ? this.conversionTargets(model, c) : [];
    const columns = model.board.columns.length, full = columns >= 200;
    // Hide, move and width: the board's column on the Main Table (everyone), the view's settings in a saved view.
    const arrange = [
      item("hide-column", "hide", `Hide column${primary ? reason("Always shown") : ""}`, primary ? "disabled" : ""),
      primary ? "" : item("move-column-menu", "left", "Move left", `data-direction="left" ${firstMovable ? "disabled" : ""}`),
      primary ? "" : item("move-column-menu", "right", "Move right", `data-direction="right" ${lastColumn ? "disabled" : ""}`),
      item("column-width", "columns", "Column width…")
    ].join("");
    const board = perm.edit ? [
      item("rename-column", "edit", "Rename"),
      item("edit-column-description", "info", c.description ? "Edit description" : "Add description"),
      item("column-settings", "settings", "Settings…"),
      optionable ? item("edit-column-options", "list", "Edit labels") : "",
      // One ↔ several values goes through POST …/columns/:key/type (WORKSPACE_ADMIN), so only admins are offered it.
      perm.admin && c.type === "dropdown" ? item("toggle-column-multiple", "list", c.multiple ? "Allow one value only" : "Allow several values") : "",
      c.type === "group" ? `<button role="menuitem" data-action="manage-groups">${v.iconHtml("group")} <span class="menu-label">Manage groups</span></button>` : "",
      // Its targets replace the menu's items in place (no second popup), so no aria-haspopup.
      targets.length ? item("change-column-type", "swap", "Change type") : "",
      item("add-column-right", "plus", `Add column to the right${full ? reason("200 columns at most") : ""}`, full ? "disabled" : ""),
      primary || !this.can(c, "duplicate") ? "" : item("duplicate-column", "copy", "Duplicate column"),
      inView ? "" : arrange
    ].join("") : "";
    const viewItems = [
      this.can(c, "sort") ? item("sort-column", "arrowUp", `Sort ascending${sortedHere && model.sortDirection === "asc" ? reason("Active") : ""}`, 'data-direction="asc"') + item("sort-column", "arrowDown", `Sort descending${sortedHere && model.sortDirection === "desc" ? reason("Active") : ""}`, 'data-direction="desc"') : "",
      sortedHere ? `<button role="menuitem" data-action="clear-sort">${v.iconHtml("close")} <span class="menu-label">Clear sort</span></button>` : "",
      c.type === "files" || !this.can(c, "filter") ? "" : item("filter-column", "filter", `Filter…${filteredHere ? reason("Active") : ""}`),
      filteredHere ? `<button role="menuitem" data-action="clear-column-filter">${v.iconHtml("close")} <span class="menu-label">Clear filter</span></button>` : "",
      groupable ? item("column-group-by", "group", groupedHere ? `Stop grouping by this column` : "Group by this column", groupedHere ? 'data-off="1"' : "") : "",
      inView ? arrange : "",
      // The only column that can stay in view while scrolling is the record name: a setting of this person's, on every board.
      primary ? `<button role="menuitemcheckbox" aria-checked="${model.settings?.stickyFirstColumn ? "true" : "false"}" data-action="toggle-sticky-name" data-key="serial">${v.iconHtml("lock")} <span class="menu-label">${model.settings?.stickyFirstColumn ? "Unfreeze record name" : "Freeze record name"}</span>${reason("Only you · every board")}</button>` : ""
    ].join("");
    const api = v.apiTokensPanel?.visible?.() ? `${section("API")}${item("apitok-copy-column", "copy", "Copy Column ID")}${item("apitok-column-info", "info", "API Information")}` : "";
    const danger = perm.admin && !primary ? `${section(ColumnMenu.BOARD_SCOPE, "Removes its values", "is-board is-danger")}<button role="menuitem" class="danger" data-action="request-delete-column" data-key="${v.attr(c.key)}">${v.iconHtml("trash")} <span class="menu-label">Delete column</span></button>` : "";
    const readOnly = perm.readOnly ? '<p class="menu-note">This board is synced and read-only: only your own view can change.</p>' : !perm.edit && perm.role ? '<p class="menu-note">You can view this board. Changes to its columns need an editor.</p>' : "";
    return `<div class="popover column-menu-popover" role="menu" aria-label="${v.attr(c.label)} column" data-key="${v.attr(c.key)}"><div class="popover-title"><strong>${v.escape(c.label)}</strong><small>${v.escape(model.columnType(c.type)?.label || c.type)}${primary ? " · Primary" : ""}</small></div>${readOnly}${board ? `${section(ColumnMenu.BOARD_SCOPE, "", "is-board")}${board}` : ""}${viewItems ? `${section(scope.label, scope.note, `is-view is-${scope.kind}`)}${viewItems}` : ""}${api}${danger}</div>`;
  }
  // The Change type page, drawn inside the same popover (‹ Back returns to the menu). Each target runs the existing
  // S0-A path (choose-new-type → AppController.changeColumnType: the server's dry run, refusal or confirm).
  typePage(model, key) {
    const v = this.view, c = model.board.columns.find((item) => item.key === key); if (!c) return "";
    const targets = this.conversionTargets(model, c);
    const option = (d) => `<button role="menuitem" class="column-type-target" data-action="choose-new-type" data-key="${v.attr(c.key)}" data-type="${v.attr(d.id)}">${typeof d.icon === "string" && d.icon.trim().startsWith("<svg") ? `<span class="column-picker-icon" aria-hidden="true">${d.icon}</span>` : v.columnTypeIcon(d.id)} <span class="menu-label">${v.escape(d.label || model.columnType(d.id)?.label || d.id)}</span></button>`;
    return `<div class="popover-title column-menu-page-title"><button type="button" role="menuitem" class="icon-button column-menu-back" data-action="column-menu-page" data-key="${v.attr(c.key)}" data-page="main" aria-label="Back to the column menu" title="Back">${v.iconHtml("left")}</button><strong>Change type</strong><small>${v.escape(model.columnType(c.type)?.label || c.type)} → …</small></div>${`<div class="menu-section-label column-scope is-board" role="presentation"><span>${ColumnMenu.BOARD_SCOPE}</span></div>`}${targets.map(option).join("") || '<p class="menu-note">This column can\'t be converted.</p>'}<p class="menu-note">Only types these values can move to are listed. JARC checks every record first; nothing changes until you confirm, and a change that would lose values is refused.</p>`;
  }
}
window.ColumnMenu = ColumnMenu;
