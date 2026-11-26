// Column System C1/D: one settings panel per column, in place of the overlapping screens it replaces (the "More settings"
// drawer, the separate label editor and the one-or-several values switch; the quick Rename dialog stays for the menu).
// Every section uses an API that exists today, and nothing here adds a stored field (D12, a column `settings` object, is
// not approved):
//   • Name, description, required, field identifier and default value → PATCH the board's columns (BoardModel.editColumn
//     and updateColumnConfig), as before. The default value is shown for the types whose registry entry lists "default".
//   • Labels (Status, Priority) and options (Dropdown) → the existing options call (PUT …/columns/:key/options) through
//     AppController.applyColumnOptions; removing labels that records use still asks first, with the count.
//   • Dropdown one ↔ several values → the existing toggle and its S0-A check (toggle-column-multiple).
// Number display formats and text presentation have no stored setting today, so there is nothing to show for them.
class ColumnSettings {
  constructor(view) { this.view = view; }
  descriptor(type) { try { return window.ColumnTypes?.get?.(type) || null; } catch { return null; } }
  settingsOf(column) {
    const d = this.descriptor(column.type);
    if (d) return d.settings || [];
    // No registry: today's rules (labels for the option types; a default value for the rest except People/Files/Checkbox).
    if (["status", "priority"].includes(column.type)) return ["labels"];
    if (column.type === "dropdown") return ["options"];
    return ["owner", "files", "checkbox", "connect", "mirror"].includes(column.type) ? [] : ["default"];
  }
  defaultField(model, column) {
    const v = this.view, d = this.descriptor(column.type), value = column.defaultValue ?? "";
    if (column.type === "group") return `<label class="full">Default group <small class="field-note">for records added without one</small><select name="defaultValue"><option value="">None</option>${model.board.groups.map((g) => `<option value="${v.attr(g)}" ${g === value ? "selected" : ""}>${v.escape(g)}</option>`).join("")}</select></label>`;
    const type = { date: "date", number: "number", email: "email", tel: "tel", url: "url" }[d?.inputType || column.type] || "text";
    return `<label class="full">Default value <small class="field-note">new records start with it</small><input name="defaultValue" type="${type}" ${type === "number" ? 'step="any"' : ""} value="${v.attr(String(value))}" maxlength="10000" autocomplete="off"></label>`;
  }
  html(model, key, { section = "general" } = {}) {
    const v = this.view, c = model.board.columns.find((item) => item.key === key); if (!c) return "";
    const settings = this.settingsOf(c), labels = settings.includes("labels") || settings.includes("options"), primary = c.key === "serial";
    const typeLabel = model.columnType(c.type)?.label || c.type, perm = window.ColumnMenu ? ColumnMenu.permissions(model) : { edit: true };
    const general = `<form class="column-settings-section" data-action="column-settings-form" aria-labelledby="column-settings-general"><h3 id="column-settings-general">Name and details</h3><input type="hidden" name="key" value="${v.attr(c.key)}"><div class="form-grid"><label class="full">Column name<input name="label" required maxlength="50" value="${v.attr(c.label)}" ${section === "general" ? "autofocus" : ""}></label><label class="full">Description <small class="field-note">shown from the column's ⓘ button</small><textarea name="description" rows="3" maxlength="500" placeholder="${v.attr(v.columnPlaceholder(c.type))}">${v.escape(c.description || "")}</textarea></label>${settings.includes("default") ? this.defaultField(model, c) : ""}<label class="full">Field identifier <small class="field-note">metadata only</small><input name="connection" maxlength="200" value="${v.attr(c.connection || "")}" placeholder="Optional field identifier"></label><label class="checkbox-label full"><input type="checkbox" name="required" ${c.required ? "checked" : ""} ${primary ? "disabled checked" : ""}> Required in forms and quick create</label></div><div class="column-settings-actions"><button class="button primary">Save details</button></div></form>`;
    const options = labels ? `<form class="column-settings-section option-editor" data-action="column-options-form" aria-labelledby="column-settings-labels"><h3 id="column-settings-labels">${c.type === "dropdown" ? "Options" : "Labels"}</h3><p class="field-note">Renaming updates every record that uses it. Removing one clears it from those records, after you confirm.</p><input type="hidden" name="key" value="${v.attr(c.key)}"><div class="option-list">${model.effectiveOptions(c).map((o) => v.optionRow(o, model.rows.filter((r) => model.valueList(r[key]).includes(o)).length, model.optionColor(c, o))).join("")}</div><button type="button" class="button ghost add-option-button" data-action="add-option-row">${v.iconHtml("plus")} Add ${c.type === "dropdown" ? "option" : "label"}</button><div class="column-settings-actions"><button class="button primary">Save ${c.type === "dropdown" ? "options" : "labels"}</button></div></form>` : "";
    const multiple = c.type === "dropdown" ? `<section class="column-settings-section" aria-labelledby="column-settings-values"><h3 id="column-settings-values">Values per record</h3><p class="field-note">${c.multiple ? "Each record can hold several options." : "Each record holds one option."} Going back to one value is checked on every record first; nothing is dropped.</p><button type="button" class="button secondary" data-action="toggle-column-multiple" data-key="${v.attr(c.key)}">${c.multiple ? "Allow one value only" : "Allow several values"}</button></section>` : "";
    const groups = c.type === "group" ? `<section class="column-settings-section"><h3>Groups</h3><p class="field-note">This column puts each record in one of the board's groups.</p><button type="button" class="button secondary" data-action="manage-groups">${v.iconHtml("group")} Manage groups</button></section>` : "";
    const body = perm.edit ? `${section === "labels" ? options + general : general + options}${multiple}${groups}` : '<p class="menu-note">You can view this board. Changing its columns needs an editor.</p>';
    return `<div class="overlay drawer-overlay" data-action="close-overlay"><div class="settings-drawer column-settings-drawer column-settings-panel" role="dialog" aria-label="${v.attr(c.label)} settings" data-key="${v.attr(c.key)}" data-section="${v.attr(section)}"><div class="modal-head"><div><div class="eyebrow">${v.columnTypeIcon(c.type)} ${v.escape(typeLabel)} column</div><h2>${v.escape(c.label)} settings</h2><p class="column-scope-note"><span class="column-scope-tag is-board">Everyone on this board</span> Changes here apply to the board itself.</p></div><button type="button" class="icon-button" data-action="close-overlay" aria-label="Close">${v.iconHtml("close")}</button></div><div class="column-settings-body">${body}</div></div></div>`;
  }
}
window.ColumnSettings = ColumnSettings;
