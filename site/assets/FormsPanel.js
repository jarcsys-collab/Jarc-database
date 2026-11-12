// Native forms: the Forms menu on a board, the form designer (workspace admins) and filling in a form (members). Internal
// only: every request is an ordinary signed-in API call, and the server decides who may do what.
class FormsPanel {
  constructor(controller) { this.c = controller; this.forms = []; this.draft = null; this.fillForm = null; this.attemptKey = null; }
  // A record a form just created, shown on the board at once WITHOUT clearing anyone's undo history: it is cached in the
  // adapter (so the live echo of this tab's own change is recognised and skipped) and merged into the board and into
  // every undo snapshot (mergeLoadedRecords), so undoing an earlier change can never remove it. → the board's row, or null.
  adoptCreatedRecord(record) {
    const a = this.adapter, m = this.model;
    try {
      if (!record?.id || typeof a?.recordFrom !== "function" || typeof a.modelRow !== "function" || typeof m.mergeLoadedRecords !== "function") return null;
      const board = a.boards?.get(record.boardId); if (!board || board.load?.state === "none") return null;
      const local = m.workspaces.flatMap((w) => w.boards).find((b) => String(m.serverId ? m.serverId(b.id) : b.id) === String(record.boardId));
      if (!local) return null;
      const cached = a.records.get(record.id);
      if (!cached || cached.version < record.version) a.records.set(record.id, a.recordFrom(record));
      // Count it too: the submission's board events reload the board, and a count that differs from the server's
      // would be taken for a colleague's change (which clears undo history).
      if (!cached && !record.archived) {
        if (typeof board.recordCount === "number") board.recordCount += 1;
        if (typeof local.recordCount === "number") local.recordCount += 1;
      }
      m.mergeLoadedRecords(local.id, { records: [a.modelRow(a.records.get(record.id), board)] });
      return m.rows?.find((r) => String(m.serverId ? m.serverId(r.id) : r.id) === String(record.id)) || null;
    } catch { return null; } // the live update shows it a moment later instead
  }
  // A condition the simple designer controls can't show (AND / OR groups, or comparisons beyond is / is not / has an answer).
  static advancedRule(w) { return Boolean(w) && (Array.isArray(w.all) || Array.isArray(w.any) || !["is", "isNot", "hasValue"].includes(w.cmp)); }
  get model() { return this.c.model; }
  get view() { return this.c.view; }
  get adapter() { return this.c.model.storage?.adapter; }
  get available() { return typeof this.adapter?.request === "function" && Boolean(this.model.board); }
  esc(v) { return this.view.escape(v ?? ""); }
  attr(v) { return this.view.attr(v ?? ""); }
  boardId() { return this.model.serverId ? this.model.serverId(this.model.board.id) : this.model.board.id; }
  canDesign() { const role = this.model.workspace?.role; return !this.model.board?.source?.readOnly && (role === "WORKSPACE_ADMIN" || role === "SYSTEM_ADMIN" || role === undefined); }
  column(key) { return this.model.board.columns.find((c) => c.key === key); }
  uuid() { return crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(c) / 4).toString(16)); }

  async onAction(action, target) {
    // Guided forms (FormWizard.js): their steps, pickers, previews, uploads and the "open the record" button.
    if (this.wizard && (action.startsWith("form-wizard-") || ["form-chip-remove", "form-choice-clear", "form-calc-use", "form-file-remove", "form-upload-retry", "form-open-record"].includes(action))) return this.wizard.onAction(action, target);
    if (action === "form-menu") return this.showMenu();
    if (action === "form-new") return this.design({ name: "", description: "", status: "draft", mode: "create", confirmation: "", uniqueKey: null, groupId: null, fields: [{ key: "serial", required: true }] });
    if (action === "form-edit") return this.design(JSON.parse(JSON.stringify(this.forms.find((f) => f.id === target.dataset.id))));
    if (action === "form-fill") return this.fill(this.forms.find((f) => f.id === target.dataset.id));
    if (action === "form-delete") return this.remove(this.forms.find((f) => f.id === target.dataset.id));
    if (action === "form-record-find") return this.findRecords();
    if (action === "form-field-add" || action === "form-field-remove" || action === "form-field-up" || action === "form-field-down") {
      this.readDesigner();
      const list = this.draft.fields, i = Number(target.dataset.index);
      if (action === "form-field-add") { const used = new Set(list.map((f) => f.key)), next = this.model.board.columns.find((c) => c.type !== "group" && !used.has(c.key)); if (next) list.push({ key: next.key }); }
      if (action === "form-field-remove") list.splice(i, 1);
      if (action === "form-field-up" && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
      if (action === "form-field-down" && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
      return this.renderDesigner();
    }
    return undefined;
  }
  // Changing an answer can show or hide fields that depend on it.
  onChange(target) {
    if (this.wizard && target.closest?.(".form-wizard")) return this.wizard.onChange(target);
    if (target.closest?.(".form-fill")) this.applyConditions();
    return undefined;
  }
  // Typing: a guided form's searches and live previews (other forms only react to changes).
  onInput(target) { if (this.wizard && target.closest?.(".form-wizard")) this.wizard.onInput(target); }

  async load() { const { items } = await this.adapter.request("GET", `/boards/${this.boardId()}/forms`); this.forms = items; return items; }
  async showMenu() {
    try { await this.load(); } catch { this.view.toast("Forms couldn't load."); return; }
    const design = this.canDesign(), row = (f) => `<div class="form-menu-row"><button role="menuitem" data-action="form-fill" data-id="${this.attr(f.id)}" ${f.status !== "published" ? "disabled" : ""}>${this.esc(f.name)}${f.status !== "published" ? " <small>Draft</small>" : ""}</button>${design ? `<button class="link-button" data-action="form-edit" data-id="${this.attr(f.id)}">Edit</button>` : ""}</div>`;
    document.querySelector("#overlay-root").innerHTML = `<div class="popover toolbar-menu-popover forms-menu" role="menu" aria-label="Forms"><div class="menu-section-label" role="presentation">Forms</div>${this.forms.map(row).join("") || '<p class="menu-note">No forms on this board yet.</p>'}${design ? `<div class="menu-divider" role="separator"></div><button role="menuitem" data-action="form-new">${icon("plus")} New form</button>` : ""}</div>`;
  }

  // ---- Designer
  design(form) { this.draft = form; this.renderDesigner(); }
  renderDesigner() {
    const d = this.draft, cols = this.model.board.columns.filter((c) => c.type !== "group"), others = (key) => d.fields.filter((f) => f.key !== key);
    const sections = d.sections || [];
    const row = (f, i) => {
      const c = this.column(f.key), advanced = FormsPanel.advancedRule(f.showWhen), w = advanced ? {} : f.showWhen || {};
      const kept = [advanced ? "a condition with AND / OR or newer comparisons" : "", f.requiredWhen ? "a required-when rule" : "", f.validation ? "validation limits" : ""].filter(Boolean);
      return `<fieldset class="form-design-field" data-index="${i}"><legend>${this.esc(f.label || c?.label || f.key)}</legend>
        <label class="field">Column<select name="key">${cols.map((x) => `<option value="${this.attr(x.key)}" ${x.key === f.key ? "selected" : ""}>${this.esc(x.label)}</option>`).join("")}</select></label>
        ${sections.length ? `<label class="field">Step<select name="section">${sections.map((s) => `<option value="${this.attr(s.id)}" ${s.id === (f.section || sections[0].id) ? "selected" : ""}>${this.esc(s.title)}</option>`).join("")}</select></label>` : ""}
        ${kept.length ? `<p class="field-note">This question also has ${kept.join(", ")}; saving here keeps ${kept.length === 1 ? "it" : "them"} unchanged.</p>` : ""}
        <label class="field">Question<input name="label" value="${this.attr(f.label || "")}" maxlength="200" placeholder="${this.attr(c?.label || "")}"></label>
        <label class="field">Help text<input name="help" value="${this.attr(f.help || "")}" maxlength="500"></label>
        <label class="field">Default value<input name="defaultValue" value="${this.attr(f.defaultValue || "")}" maxlength="200"></label>
        <label class="check-field"><input type="checkbox" name="required" ${f.required ? "checked" : ""}> Required</label>
        <label class="check-field"><input type="checkbox" name="hidden" ${f.hidden ? "checked" : ""}> Hidden (always uses the default)</label>
        <div class="form-design-condition" ${advanced ? "hidden" : ""}><label class="field">Only ask when<select name="whenKey"><option value="">Always ask</option>${others(f.key).map((o) => `<option value="${this.attr(o.key)}" ${w.key === o.key ? "selected" : ""}>${this.esc(o.label || this.column(o.key)?.label || o.key)}</option>`).join("")}</select></label>
        <label class="field"><span class="sr-only">Comparison</span><select name="whenCmp">${[["is", "is"], ["isNot", "is not"], ["hasValue", "has an answer"]].map(([v, t]) => `<option value="${v}" ${w.cmp === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="field"><span class="sr-only">Values</span><input name="whenValues" value="${this.attr((w.values || []).join(", "))}" placeholder="Values, separated by commas"></label></div>
        <div class="form-design-actions"><button type="button" class="link-button" data-action="form-field-up" data-index="${i}" ${i === 0 ? "disabled" : ""}>Move up</button><button type="button" class="link-button" data-action="form-field-down" data-index="${i}" ${i === d.fields.length - 1 ? "disabled" : ""}>Move down</button><button type="button" class="link-button" data-action="form-field-remove" data-index="${i}">Remove</button></div></fieldset>`;
    };
    this.view.overlay(`<form class="modal form-designer" data-action="form-design-form"><div class="modal-head"><div><div class="eyebrow">${this.esc(this.model.board.name)}</div><h2>${d.id ? "Edit form" : "New form"}</h2></div>${this.view.closeButton()}</div>
      <label class="field">Name<input name="name" value="${this.attr(d.name)}" maxlength="200" required></label>
      <label class="field">Description<textarea name="description" rows="2" maxlength="2000">${this.esc(d.description)}</textarea></label>
      <label class="field">Submitting a form<select name="mode"><option value="create" ${d.mode !== "update" ? "selected" : ""}>Creates a record</option><option value="update" ${d.mode === "update" ? "selected" : ""}>Updates an existing record</option></select></label>
      <label class="field">Add new records to<select name="groupId"><option value="">The board's first group</option>${(this.adapter.boards?.get?.(this.boardId())?.groups || []).map((g) => `<option value="${this.attr(g.id)}" ${d.groupId === g.id ? "selected" : ""}>${this.esc(g.name)}</option>`).join("")}</select></label>
      <label class="field">Refuse duplicates of<select name="uniqueKey"><option value="">No check</option>${d.fields.map((f) => `<option value="${this.attr(f.key)}" ${d.uniqueKey === f.key ? "selected" : ""}>${this.esc(f.label || this.column(f.key)?.label || f.key)}</option>`).join("")}</select></label>
      <label class="field">Confirmation message<input name="confirmation" value="${this.attr(d.confirmation)}" maxlength="500" placeholder="Thanks, your answers were saved."></label>
      <div class="form-design-fields">${d.fields.map(row).join("")}</div>
      <button type="button" class="button secondary" data-action="form-field-add">${icon("plus")} Add field</button>
      <label class="field">Status<select name="status"><option value="draft" ${d.status !== "published" ? "selected" : ""}>Draft (only admins see it)</option><option value="published" ${d.status === "published" ? "selected" : ""}>Published</option></select></label>
      <div class="modal-actions">${d.id ? `<button type="button" class="button secondary danger" data-action="form-delete" data-id="${this.attr(d.id)}">Delete</button>` : ""}<button type="button" class="button secondary" data-action="close-overlay">Cancel</button><button class="button primary" type="submit">Save form</button></div></form>`);
  }
  readDesigner() {
    const form = document.querySelector(".form-designer"); if (!form || !this.draft) return;
    const get = (el, name) => el.querySelector(`[name="${name}"]`);
    for (const k of ["name", "description", "mode", "status", "confirmation"]) this.draft[k] = get(form, k).value;
    this.draft.groupId = get(form, "groupId").value || null; this.draft.uniqueKey = get(form, "uniqueKey").value || null;
    const before = this.draft.fields || [];
    this.draft.fields = [...form.querySelectorAll(".form-design-field")].map((el, i) => {
      const field = { key: get(el, "key").value }, label = get(el, "label").value.trim(), help = get(el, "help").value.trim(), def = get(el, "defaultValue").value.trim(), whenKey = get(el, "whenKey").value, cmp = get(el, "whenCmp").value;
      if (label) field.label = label; if (help) field.help = help; if (def) field.defaultValue = def;
      if (get(el, "required").checked) field.required = true; if (get(el, "hidden").checked) field.hidden = true;
      // Settings this designer doesn't edit are kept as they are (guided forms: rules, limits, placeholders, suffixes).
      const prev = before[i] && before[i].key === field.key ? before[i] : null;
      if (prev) for (const k of ["placeholder", "suffix", "validation", "requiredWhen"]) if (prev[k] !== undefined) field[k] = prev[k];
      if (prev && FormsPanel.advancedRule(prev.showWhen)) field.showWhen = prev.showWhen;
      else if (whenKey) field.showWhen = { key: whenKey, cmp, ...(cmp === "hasValue" ? {} : { values: get(el, "whenValues").value.split(",").map((v) => v.trim()).filter(Boolean) }) };
      const section = el.querySelector('[name="section"]')?.value; if (section) field.section = section;
      return field;
    });
  }
  async saveDesigner() {
    this.readDesigner();
    const { id, version, name, description, status, mode, confirmation, groupId, uniqueKey, fields } = this.draft;
    const body = { name, description, status, mode, confirmation, groupId, uniqueKey, fields };
    // A guided form keeps its steps, review and calculation previews (edited in its definition, not on this screen).
    if (this.draft.schemaVersion === 2) for (const k of ["layout", "sections", "review", "calculations"]) if (this.draft[k] !== undefined) body[k] = this.draft[k];
    try {
      if (id) await this.adapter.request("PATCH", `/forms/${id}`, { ...body, expectedVersion: version }); else await this.adapter.request("POST", `/boards/${this.boardId()}/forms`, body);
      this.view.closeOverlay(); this.view.toast(id ? "Form saved" : "Form created"); this.draft = null;
    } catch (error) { this.view.toast(error?.message || "The form couldn't be saved."); }
  }
  async remove(form) {
    if (!form) return;
    try { await this.adapter.request("DELETE", `/forms/${form.id}?expectedVersion=${form.version}`); this.view.closeOverlay(); this.view.toast("Form deleted"); }
    catch (error) { this.view.toast(error?.message || "The form couldn't be deleted."); }
  }

  // ---- Filling in
  inputFor(field, column, value) {
    const name = `field:${field.key}`, attrs = `name="${this.attr(name)}" ${field.required ? "required" : ""}`, options = this.model.effectiveOptions?.(column) || column.options || [];
    const v = value ?? field.defaultValue ?? "";
    if (column.type === "files") return `<input type="file" ${attrs} multiple>`;
    if (column.type === "checkbox") return `<input type="checkbox" name="${this.attr(name)}" ${v === true || v === "true" ? "checked" : ""}>`;
    if (["status", "priority"].includes(column.type) || (column.type === "dropdown" && !column.multiple)) return `<select ${attrs}><option value=""></option>${options.map((o) => `<option value="${this.attr(o)}" ${o === v ? "selected" : ""}>${this.esc(o)}</option>`).join("")}</select>`;
    if (column.type === "owner") return `<select ${attrs} multiple size="${Math.min(6, this.people.length || 3)}">${this.people.map((p) => `<option value="user:${this.attr(p.id)}">${this.esc(p.displayName || p.email || "")}</option>`).join("")}</select>`;
    if (column.type === "dropdown") return `<select ${attrs} multiple size="${Math.min(6, options.length || 3)}">${options.map((o) => `<option value="${this.attr(o)}" ${[].concat(v).includes(o) ? "selected" : ""}>${this.esc(o)}</option>`).join("")}</select>`;
    const type = { date: "date", number: "number", email: "email", phone: "tel", link: "url" }[column.type] || "text";
    // Numbers: any precision (4.17, 16.67), as on the board itself; without step="any" the browser refuses decimals.
    return `<input type="${type}" ${attrs}${type === "number" ? ' step="any" inputmode="decimal"' : ""} value="${this.attr(v)}" autocomplete="off">`;
  }
  async findRecords() {
    const form = document.querySelector(".form-fill"), q = form.querySelector('[name="recordSearch"]').value.trim(), select = form.querySelector('[name="recordId"]');
    if (!q) return;
    try {
      const { items } = await this.adapter.request("GET", `/boards/${this.boardId()}/records?q=${encodeURIComponent(q)}&limit=25`);
      this.found = new Map(items.map((r) => [r.id, r]));
      select.innerHTML = `<option value=""></option>${items.map((r) => `<option value="${this.attr(r.id)}">${this.esc(r.values?.serial)}</option>`).join("")}`;
      form.querySelector(".form-record-count").textContent = items.length ? `${items.length}${items.length === 25 ? "+" : ""} found` : "None found";
    } catch { this.view.toast("That search couldn't run. Try again."); }
  }
  async fill(form) {
    if (!form) return;
    this.wizard = null;
    if (form.layout === "wizard" && typeof FormWizard === "function" && window.FormRules) { this.fillForm = form; this.wizard = new FormWizard(this, form); this.wizard.open(); return; }
    this.fillForm = form; this.attemptKey = this.uuid(); this.found = new Map(); this.people = [];
    if (form.fields.some((f) => this.column(f.key)?.type === "owner")) { try { this.people = await this.adapter.loadPeople(this.model.workspace?.id); } catch { /* the question shows no choices; the server still decides */ } }
    const fields = form.fields.filter((f) => !f.hidden && this.column(f.key));
    const recordPicker = form.mode === "update" ? `<label class="field">Find the record<input name="recordSearch" autocomplete="off"></label><button type="button" class="button secondary" data-action="form-record-find">Search</button> <small class="form-record-count" role="status"></small><label class="field">Record to update<select name="recordId" required><option value=""></option></select></label>` : "";
    this.view.overlay(`<form class="modal form-fill" data-action="form-fill-form"><div class="modal-head"><div><div class="eyebrow">${this.esc(this.model.board.name)}</div><h2>${this.esc(form.name)}</h2></div>${this.view.closeButton()}</div>
      ${form.description ? `<p>${this.esc(form.description)}</p>` : ""}${recordPicker}
      ${fields.map((f) => { const c = this.column(f.key); return `<label class="field form-fill-field" data-field="${this.attr(f.key)}">${this.esc(f.label || c.label)}${f.required ? ' <span aria-hidden="true">*</span>' : ""}${this.inputFor(f, c)}${f.help ? `<small>${this.esc(f.help)}</small>` : ""}</label>`; }).join("")}
      <p class="form-fill-error" role="alert" hidden></p>
      <div class="modal-actions"><button type="button" class="button secondary" data-action="close-overlay">Cancel</button><button class="button primary" type="submit">Submit</button></div></form>`);
    this.applyConditions();
  }
  // The same rule as the server's domain/form.js; the server decides in the end.
  answers() {
    const form = document.querySelector(".form-fill"), out = {};
    for (const f of this.fillForm.fields) {
      const el = form.querySelector(`[name="field:${CSS.escape(f.key)}"]`); if (!el) continue;
      const c = this.column(f.key);
      if (c?.type === "files") continue;
      if (el.type === "checkbox") { out[f.key] = el.checked; continue; }
      if (el.multiple) { out[f.key] = [...el.selectedOptions].map((o) => o.value); continue; }
      out[f.key] = el.value;
    }
    return out;
  }
  applies(field, values, seen = new Set()) {
    if (!field.showWhen) return true;
    if (seen.has(field.key)) return false;
    seen.add(field.key);
    const other = this.fillForm.fields.find((f) => f.key === field.showWhen.key);
    if (!other || !this.applies(other, values, seen)) return false;
    const raw = values[other.key] ?? other.defaultValue, given = Array.isArray(raw) ? raw.map(String) : raw === undefined || raw === null || raw === "" || raw === false ? [] : [String(raw)];
    if (field.showWhen.cmp === "hasValue") return given.length > 0;
    const hit = field.showWhen.values.some((v) => given.includes(v));
    return field.showWhen.cmp === "is" ? hit : !hit;
  }
  applyConditions() {
    if (!this.fillForm) return;
    const form = document.querySelector(".form-fill"); if (!form) return;
    const values = this.answers();
    for (const f of this.fillForm.fields) {
      const box = form.querySelector(`[data-field="${CSS.escape(f.key)}"]`); if (!box) continue;
      const on = this.applies(f, values), input = box.querySelector("input,select,textarea");
      box.hidden = !on;
      if (input) { input.disabled = !on; if (f.required && input.type !== "checkbox") input.required = on; }
    }
  }
  async submitFill() {
    if (this.wizard && document.querySelector(".form-wizard")) return this.wizard.submit();
    const form = document.querySelector(".form-fill"), error = form.querySelector(".form-fill-error"), f = this.fillForm, button = form.querySelector('button[type="submit"]');
    const all = this.answers(), values = {};
    for (const field of f.fields) { if (field.hidden || !this.applies(field, all) || all[field.key] === undefined) continue; const v = all[field.key], empty = v === "" || (Array.isArray(v) && !v.length) || (v === false && !field.required); if (!empty) values[field.key] = v; }
    const files = f.fields.filter((x) => this.column(x.key)?.type === "files" && this.applies(x, all)).map((x) => ({ field: x, input: form.querySelector(`[name="field:${CSS.escape(x.key)}"]`) })).filter((x) => x.input?.files?.length);
    const missingFiles = f.fields.filter((x) => x.required && this.column(x.key)?.type === "files" && this.applies(x, all) && !files.some((y) => y.field.key === x.key));
    if (missingFiles.length) { error.textContent = `Please add: ${missingFiles.map((x) => x.label || this.column(x.key).label).join(", ")}.`; error.hidden = false; return; }
    const body = { submissionKey: this.attemptKey, values };
    // The documents about to be uploaded, per question: the server applies its rules to them, then verifies the uploads.
    if (files.length) body.files = Object.fromEntries(files.map(({ field, input }) => [field.key, Math.min(input.files.length, 20)]));
    if (f.mode === "update") {
      const id = form.querySelector('[name="recordId"]').value;
      body.recordId = id; body.expectedVersion = this.found.get(id)?.version;
    }
    button.disabled = true; error.hidden = true;
    try {
      const { record, confirmation, submission } = await this.adapter.request("POST", `/forms/${f.id}/submit`, body);
      if (f.mode !== "update") this.adoptCreatedRecord(record);
      // The record is saved from here on: a failed upload is reported as that, never as "nothing was saved".
      let failedFiles = 0;
      for (const { field, input } of files) for (const file of input.files) { try { await this.adapter.uploadAttachment?.(record.id, field.key, file, { name: file.name, key: this.uuid() }); } catch { failedFiles += 1; } }
      // Only the server's own check of what is attached may call the documents complete.
      let docs = null;
      if (submission?.status === "awaiting-files" || submission?.status === "incomplete") { try { docs = await this.adapter.request("POST", `/forms/${f.id}/submissions/${submission.key}/complete`); } catch { docs = { status: "unknown" }; } }
      const incomplete = docs && docs.status !== "done";
      this.fillForm = null; this.attemptKey = null;
      const note = incomplete ? `<p class="form-fill-error" role="alert">Your answers were saved, but the documents are incomplete${docs.missing?.length ? ` (${this.esc(docs.missing.join(", "))})` : ""}${failedFiles ? `: ${failedFiles} file${failedFiles === 1 ? "" : "s"} couldn't be uploaded` : ""}. Open the record to add ${failedFiles === 1 ? "it" : "them"}.</p>` : "";
      this.view.overlay(`<div class="modal small-modal form-done" role="status"><div class="modal-head"><h2>${incomplete ? "Saved — documents incomplete" : "Submitted"}</h2>${this.view.closeButton()}</div><p>${this.esc(confirmation || "Thanks, your answers were saved.")}</p>${note}<div class="modal-actions"><button type="button" class="button primary" data-action="close-overlay">Done</button></div></div>`);
    } catch (e) { error.textContent = e?.message || "This couldn't be submitted. Nothing was saved."; error.hidden = false; button.disabled = false; }
  }
}
