// Guided ("wizard") forms — layout "wizard" in a form's definition (server/src/domain/form.js), opened from FormsPanel.
// One step per section, then an optional review step. Everything is driven by the stored definition: questions, sections,
// conditions, validation and calculation previews; nothing about a particular board is written here.
//
//   rules       FormRules.js, the SAME file the server uses: which questions apply, which are required, number and length
//               rules. A question that doesn't apply is hidden, disabled and never sent (no stale answers).
//   choices     status questions as choices in the board's own colours; multi-select dropdowns as a searchable picker with
//               removable chips. Only the column's own options can be chosen; nothing creates a new option.
//   numbers     typed text, sent exactly as typed (4.17 stays 4.17): no rounding, no conversion.
//   previews    enabled calculations show a suggestion beside their question. A suggestion is never filled in by itself;
//               "Use" copies it only when the person presses it.
//   files       checked here (type, size, count), uploaded after the record exists through the usual secured upload route,
//               each file with its own upload key: a retry never stores a file twice and never creates a second record.
//   submit      one attempt key per filled-in form: pressing Submit again, a double click or a retry after a time-out
//               creates one record. The server re-checks everything and decides.
//   drafts      unsent answers (never files) and the attempt key are kept in this tab's sessionStorage, so an ended session
//               or an accidental close loses nothing: reopening the form restores them, and submitting reuses the same
//               attempt key (if the first attempt did reach the server, it returns that record instead of a second one).
//               Removed after a successful submit, by Cancel, after 12 hours, or when the form's definition changes.
class FormWizard {
  constructor(panel, form) {
    Object.assign(this, { p: panel, form, step: 0, maxStep: 0, attemptKey: panel.uuid(), files: new Map(), record: null, busy: false });
  }
  static ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";
  static TYPES = Object.freeze({ pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" });
  static MAX_BYTES = 10 * 1024 * 1024;
  static MAX_FILES = 20;
  get rules() { return window.FormRules; }
  get root() { return document.querySelector(".form-wizard"); }
  esc(v) { return this.p.esc(v); }
  attr(v) { return this.p.attr(v); }
  column(key) { return this.p.column(key); }
  label(f) { return f.label || this.column(f.key)?.label || f.key; }
  isFiles(f) { return this.column(f.key)?.type === "files"; }
  isMulti(c) { return c?.type === "dropdown" && c.multiple === true; }
  isChoice(c) { return ["status", "priority"].includes(c?.type); }
  get visibleFields() { return this.form.fields.filter((f) => !f.hidden && this.column(f.key)); }
  get steps() {
    const sections = (this.form.sections || []).map((s) => ({ ...s, fields: this.visibleFields.filter((f) => f.section === s.id) }));
    return this.form.review ? [...sections, { id: "__review", title: "Review & submit", description: "Check your answers. Use Edit to change a section.", fields: [] }] : sections;
  }
  domId(prefix, key) { return `${prefix}-${String(key).replace(/[^A-Za-z0-9_-]/g, "_")}`; }
  formatSize(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }

  // ---- Rendering
  open() {
    const steps = this.steps;
    this.p.view.overlay(`<form class="modal form-fill form-wizard" data-action="form-fill-form" novalidate aria-labelledby="wizard-title">
      <div class="modal-head"><div><div class="eyebrow">${this.esc(this.p.model.board.name)}</div><h2 id="wizard-title">${this.esc(this.form.name)}</h2></div>${this.p.view.closeButton()}</div>
      ${this.form.description ? `<p class="wizard-intro">${this.esc(this.form.description)}</p>` : ""}
      <ol class="wizard-progress" aria-label="Steps">${steps.map((s, i) => `<li data-step-index="${i}"><button type="button" class="wizard-progress-step" data-action="form-wizard-goto" data-index="${i}"><span class="wizard-progress-number" aria-hidden="true">${i + 1}</span><span class="wizard-progress-title">${this.esc(s.title)}</span></button></li>`).join("")}</ol>
      <p class="sr-only wizard-announce" role="status" aria-live="polite"></p>
      ${steps.map((s, i) => `<section class="wizard-step" data-step="${i}" aria-labelledby="wizard-step-${i}" hidden>
        <h3 id="wizard-step-${i}" tabindex="-1"><span class="wizard-step-count">Step ${i + 1} of ${steps.length}</span> ${this.esc(s.title)}</h3>
        ${s.description ? `<p class="wizard-step-description">${this.esc(s.description)}</p>` : ""}
        ${s.id === "__review" ? '<div class="wizard-review"></div>' : s.fields.map((f) => this.fieldHtml(f)).join("")}
      </section>`).join("")}
      <p class="form-fill-error wizard-error" role="alert" hidden></p>
      <div class="modal-actions wizard-actions"><button type="button" class="button secondary" data-action="form-wizard-cancel">Cancel</button><span class="wizard-spacer"></span>
        <button type="button" class="button secondary" data-action="form-wizard-prev">Previous</button>
        <button type="button" class="button primary" data-action="form-wizard-next">Next</button>
        <button type="submit" class="button primary wizard-submit" hidden>Submit</button></div></form>`);
    const draft = this.readDraft();
    if (draft) {
      this.restore(draft.values); this.attemptKey = draft.attemptKey;
      this.root.querySelector(".wizard-progress").insertAdjacentHTML("afterend", '<p class="wizard-restored" role="status">Your unsent answers were restored. Files need to be added again. <button type="button" class="link-button" data-action="form-wizard-restart">Start over</button></p>');
    }
    this.refresh();
    this.show(0, { focus: false });
    this.root?.querySelector(".wizard-step:not([hidden]) input, .wizard-step:not([hidden]) select, .wizard-step:not([hidden]) textarea")?.focus();
  }

  // ---- Unsent answers in this tab (never files); see the header.
  draftKey() { return `jarc-form-draft:${this.form.id}`; }
  readDraft() {
    try {
      const d = JSON.parse(sessionStorage.getItem(this.draftKey()) || "null");
      if (!d || d.formVersion !== this.form.version || !(Date.now() - d.savedAt < 12 * 3600 * 1000) || typeof d.attemptKey !== "string" || !d.values || typeof d.values !== "object") return null;
      return d;
    } catch { return null; }
  }
  saveDraft() {
    try {
      const values = this.answers();
      if (!Object.values(values).some((v) => !this.empty(v))) return;
      sessionStorage.setItem(this.draftKey(), JSON.stringify({ attemptKey: this.attemptKey, formVersion: this.form.version, values, savedAt: Date.now() }));
    } catch { /* storage unavailable: nothing is kept, everything else works */ }
  }
  clearDraft() { try { sessionStorage.removeItem(this.draftKey()); } catch { /* nothing kept */ } }
  restore(values) {
    for (const f of this.visibleFields) {
      if (!(f.key in values) || this.isFiles(f)) continue;
      const v = values[f.key], els = this.inputs(f.key);
      if (!els.length) continue;
      if (els[0].type === "radio" || (els[0].type === "checkbox" && this.isMulti(this.column(f.key)))) for (const el of els) el.checked = [].concat(v).includes(el.value);
      else if (els[0].type === "checkbox") els[0].checked = v === true;
      else if (typeof v === "string") els[0].value = v;
    }
  }
  fieldHtml(f) {
    const c = this.column(f.key), id = this.domId("wf", f.key), help = f.help ? this.domId("wf-help", f.key) : "", err = this.domId("wf-err", f.key), lbl = this.domId("wf-label", f.key);
    const described = `aria-describedby="${[help, err].filter(Boolean).join(" ")}"`, name = `field:${this.attr(f.key)}`;
    const labelText = `${this.esc(this.label(f))}<span class="wizard-required" aria-hidden="true" hidden> *</span>`;
    const calcs = (this.form.calculations || []).filter((x) => x.enabled && x.target === f.key);
    const previews = calcs.map((x) => `<div class="calc-preview" data-calc="${this.attr(x.id)}" aria-live="polite" hidden></div>`).join("");
    let control;
    if (this.isFiles(f)) {
      control = `<div class="wizard-files"><label class="button secondary small file-pick" for="${id}">Add files</label><input id="${id}" type="file" multiple accept="${FormWizard.ACCEPT}" class="sr-only" data-files-input="${this.attr(f.key)}" ${described}><small>PDF, JPEG, PNG or WebP · up to 10 MB each</small><ul class="wizard-file-list" data-file-list="${this.attr(f.key)}"></ul></div>`;
      return `<div class="field form-fill-field wizard-field" data-field="${this.attr(f.key)}"><span class="wizard-label" id="${lbl}">${labelText}</span>${help ? `<small id="${help}" class="wizard-help">${this.esc(f.help)}</small>` : ""}${control}<p class="field-error" id="${err}" hidden></p></div>`;
    }
    const options = this.p.model.effectiveOptions?.(c) || c.options || [];
    if (this.isChoice(c)) {
      const colors = c.colors || [];
      control = `<div class="wizard-choices" role="radiogroup" aria-labelledby="${lbl}" ${described}>${options.map((o, i) => `<label class="choice-chip status-choice"><input type="radio" name="${name}" value="${this.attr(o)}"><span class="status-swatch" style="--choice-color:${this.attr(/^#[0-9a-f]{3,8}$/i.test(colors[i] || "") ? colors[i] : "var(--muted)")}" aria-hidden="true"></span><span>${this.esc(o)}</span></label>`).join("")}<button type="button" class="link-button wizard-clear" data-action="form-choice-clear" data-key="${this.attr(f.key)}">Clear</button></div>`;
      return `<div class="field form-fill-field wizard-field" data-field="${this.attr(f.key)}"><span class="wizard-label" id="${lbl}">${labelText}</span>${help ? `<small id="${help}" class="wizard-help">${this.esc(f.help)}</small>` : ""}${control}${previews}<p class="field-error" id="${err}" hidden></p></div>`;
    }
    if (this.isMulti(c)) {
      control = `<div class="choice-picker" data-picker="${this.attr(f.key)}" role="group" aria-labelledby="${lbl}" ${described}>
        <ul class="choice-picker-chips" aria-label="Selected: ${this.attr(this.label(f))}"></ul>
        <input type="search" class="choice-picker-search" data-picker-search="${this.attr(f.key)}" placeholder="Search ${this.attr(this.label(f))}" aria-label="Search ${this.attr(this.label(f))}" autocomplete="off">
        <div class="choice-picker-list">${options.map((o) => `<label class="choice-picker-option"><input type="checkbox" name="${name}" value="${this.attr(o)}"><span>${this.esc(o)}</span></label>`).join("")}<p class="choice-picker-empty" hidden>No matching choice.</p></div></div>`;
      return `<div class="field form-fill-field wizard-field" data-field="${this.attr(f.key)}"><span class="wizard-label" id="${lbl}">${labelText}</span>${help ? `<small id="${help}" class="wizard-help">${this.esc(f.help)}</small>` : ""}${control}<p class="field-error" id="${err}" hidden></p></div>`;
    }
    if (c.type === "dropdown") control = `<select id="${id}" name="${name}" ${described}><option value=""></option>${options.map((o) => `<option value="${this.attr(o)}">${this.esc(o)}</option>`).join("")}</select>`;
    else if (c.type === "number") control = `<span class="wizard-number"><input id="${id}" type="text" inputmode="decimal" name="${name}" autocomplete="off" spellcheck="false" ${f.placeholder ? `placeholder="${this.attr(f.placeholder)}"` : ""} ${described}>${f.suffix ? `<span class="wizard-suffix" aria-hidden="true">${this.esc(f.suffix)}</span>` : ""}</span>`;
    else if (c.type === "text") control = `<input id="${id}" type="text" name="${name}" autocomplete="off" ${f.validation?.maxLength ? `maxlength="${f.validation.maxLength}"` : ""} ${f.placeholder ? `placeholder="${this.attr(f.placeholder)}"` : ""} ${described}>`;
    else control = this.p.inputFor(f, c).replace("<input ", `<input id="${id}" ${described} `).replace("<select ", `<select id="${id}" ${described} `);
    return `<div class="field form-fill-field wizard-field" data-field="${this.attr(f.key)}"><label class="wizard-label" for="${id}" id="${lbl}">${labelText}</label>${help ? `<small id="${help}" class="wizard-help">${this.esc(f.help)}</small>` : ""}${control}${previews}<p class="field-error" id="${err}" hidden></p></div>`;
  }

  // ---- Answers and rules
  inputs(key) { return [...(this.root?.querySelectorAll(`[name="field:${CSS.escape(key)}"]`) || [])]; }
  answers() {
    const out = {};
    for (const f of this.visibleFields) {
      if (this.isFiles(f)) continue;
      const els = this.inputs(f.key), c = this.column(f.key);
      if (!els.length) continue;
      if (els[0].type === "radio") out[f.key] = els.find((e) => e.checked)?.value || "";
      else if (els[0].type === "checkbox" && this.isMulti(c)) out[f.key] = els.filter((e) => e.checked).map((e) => e.value);
      else if (els[0].type === "checkbox") out[f.key] = els[0].checked;
      else out[f.key] = c.type === "number" ? els[0].value.trim() : els[0].value;
    }
    return out;
  }
  applies(f, values) { return this.rules.fieldApplies(f, this.form, values); }
  empty(v) { return v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && !v.length); }
  // The same checks the server makes, for the given fields → Map(key → message).
  problems(fields, values) {
    const out = new Map();
    for (const f of fields) {
      if (!this.applies(f, values)) continue;
      const c = this.column(f.key), label = this.label(f);
      if (this.isFiles(f)) { if (this.rules.isRequired(f, this.form, values) && !(this.files.get(f.key) || []).length) out.set(f.key, `Add at least one file for "${label}".`); continue; }
      const v = values[f.key];
      if (this.empty(v)) { if (this.rules.isRequired(f, this.form, values)) out.set(f.key, `"${label}" is required.`); continue; }
      if (c.type === "number" && !this.rules.decimal.parse(v)) { out.set(f.key, `"${label}" must be a number, such as 4.17.`); continue; }
      const options = this.p.model.effectiveOptions?.(c) || c.options || [];
      if (["status", "priority", "dropdown"].includes(c.type) && options.length && [].concat(v).some((x) => !options.includes(x))) { out.set(f.key, `"${label}" must be one of its choices.`); continue; }
      const rule = this.rules.checkRules(f, c, v);
      if (rule) out.set(f.key, rule);
    }
    return out;
  }
  showProblems(fields, problems) {
    for (const f of fields) {
      const box = this.root?.querySelector(`[data-field="${CSS.escape(f.key)}"]`); if (!box) continue;
      const msg = problems.get(f.key), err = box.querySelector(".field-error");
      err.textContent = msg || ""; err.hidden = !msg;
      for (const el of box.querySelectorAll("input, select, textarea, [role=radiogroup], .choice-picker")) { if (msg) el.setAttribute("aria-invalid", "true"); else el.removeAttribute("aria-invalid"); }
    }
  }
  // Conditions, required markers, chips, file lists and previews, from the current answers.
  refresh() {
    const root = this.root; if (!root) return;
    const values = this.answers();
    for (const f of this.visibleFields) {
      const box = root.querySelector(`[data-field="${CSS.escape(f.key)}"]`); if (!box) continue;
      const on = this.applies(f, values);
      box.hidden = !on;
      for (const el of box.querySelectorAll("input, select, textarea, button")) el.disabled = !on;
      box.querySelector(".wizard-required").hidden = !(on && this.rules.isRequired(f, this.form, values));
      if (this.isMulti(this.column(f.key))) this.renderChips(f.key);
      if (this.isFiles(f)) this.renderFiles(f.key);
    }
    for (const calc of this.form.calculations || []) {
      const el = root.querySelector(`[data-calc="${CSS.escape(calc.id)}"]`); if (!el || !calc.enabled) continue;
      const r = this.rules.calculate(calc, this.form, values);
      el.hidden = !r;
      el.innerHTML = r ? `<span>Suggestion: <strong>${this.esc(r.value)}</strong>${r.rounded ? " (rounded)" : ""} · ${this.esc(calc.label)}</span> <button type="button" class="link-button" data-action="form-calc-use" data-key="${this.attr(calc.target)}" data-value="${this.attr(r.value)}">Use ${this.esc(r.value)}</button>${calc.note ? `<small>${this.esc(calc.note)}</small>` : ""}` : "";
    }
    // Errors already shown are re-checked as answers change: one that is now fine disappears at once. New errors only
    // appear when the person moves on (Next / Submit), not while typing.
    const shown = this.visibleFields.filter((f) => { const e = root.querySelector(`[data-field="${CSS.escape(f.key)}"] .field-error`); return e && !e.hidden; });
    if (shown.length) {
      const now = this.problems(shown, values);
      this.showProblems(shown, now);
      const err = root.querySelector(".wizard-error");
      if (err && !err.hidden && ![...now.keys()].length) err.hidden = true;
    }
    if (!this.record) this.saveDraft();
  }
  renderChips(key) {
    const list = this.root?.querySelector(`[data-picker="${CSS.escape(key)}"] .choice-picker-chips`); if (!list) return;
    const chosen = this.inputs(key).filter((e) => e.checked).map((e) => e.value);
    list.innerHTML = chosen.map((v) => `<li class="choice-picker-chip"><span>${this.esc(v)}</span><button type="button" class="choice-picker-remove" data-action="form-chip-remove" data-key="${this.attr(key)}" data-value="${this.attr(v)}" aria-label="Remove ${this.attr(v)}">×</button></li>`).join("") || '<li class="choice-picker-none">None selected</li>';
  }
  filterPicker(key, query) {
    const box = this.root?.querySelector(`[data-picker="${CSS.escape(key)}"]`); if (!box) return;
    const q = query.trim().toLowerCase(); let shown = 0;
    for (const opt of box.querySelectorAll(".choice-picker-option")) { const hit = !q || opt.textContent.toLowerCase().includes(q); opt.hidden = !hit; if (hit) shown += 1; }
    box.querySelector(".choice-picker-empty").hidden = shown > 0;
  }

  // ---- Files (checked here; the server checks them again on upload)
  addFiles(key, fileList) {
    const list = this.files.get(key) || [], rejected = [];
    for (const file of fileList) {
      const ext = String(file.name).split(".").pop().toLowerCase(), type = FormWizard.TYPES[ext];
      if (!type || (file.type && file.type !== type && !(ext === "jpg" && file.type === "image/jpeg"))) { rejected.push(`${file.name}: only PDF, JPEG, PNG or WebP files can be added`); continue; }
      if (file.size > FormWizard.MAX_BYTES) { rejected.push(`${file.name}: larger than 10 MB`); continue; }
      if (!file.size) { rejected.push(`${file.name}: the file is empty`); continue; }
      if (list.some((x) => x.file.name === file.name && x.file.size === file.size && x.file.lastModified === file.lastModified)) continue; // the same file twice
      if (list.length >= FormWizard.MAX_FILES) { rejected.push(`${file.name}: at most ${FormWizard.MAX_FILES} files per question`); continue; }
      list.push({ file, uploadKey: this.p.uuid(), state: "waiting", progress: 0, error: "" });
    }
    this.files.set(key, list);
    this.renderFiles(key);
    const f = this.form.fields.find((x) => x.key === key);
    this.showProblems([f], rejected.length ? new Map([[key, rejected.join(". ")]]) : new Map());
  }
  renderFiles(key) {
    const ul = this.root?.querySelector(`[data-file-list="${CSS.escape(key)}"]`); if (!ul) return;
    ul.innerHTML = (this.files.get(key) || []).map((x, i) => `<li><span class="wizard-file-name">${this.esc(x.file.name)}</span> <small>${this.formatSize(x.file.size)}</small> <button type="button" class="link-button" data-action="form-file-remove" data-key="${this.attr(key)}" data-index="${i}" aria-label="Remove ${this.attr(x.file.name)}">Remove</button></li>`).join("");
  }

  // ---- Steps
  show(index, { focus = true } = {}) {
    const root = this.root; if (!root) return;
    const steps = this.steps, last = steps.length - 1;
    this.step = Math.max(0, Math.min(index, last)); this.maxStep = Math.max(this.maxStep, this.step);
    root.querySelectorAll(".wizard-step").forEach((el, i) => { el.hidden = i !== this.step; });
    root.querySelectorAll(".wizard-progress li").forEach((li, i) => {
      li.classList.toggle("is-current", i === this.step); li.classList.toggle("is-done", i < this.step);
      const b = li.querySelector("button"); if (i === this.step) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
      b.disabled = i > this.maxStep;
    });
    root.querySelector('[data-action="form-wizard-prev"]').disabled = this.step === 0;
    root.querySelector('[data-action="form-wizard-next"]').hidden = this.step === last;
    root.querySelector(".wizard-submit").hidden = this.step !== last;
    if (steps[this.step].id === "__review") this.renderReview();
    root.querySelector(".wizard-announce").textContent = `Step ${this.step + 1} of ${steps.length}: ${steps[this.step].title}`;
    root.querySelector(".wizard-error").hidden = true;
    if (focus) root.querySelector(`#wizard-step-${this.step}`)?.focus();
  }
  checkStep(index) {
    const s = this.steps[index]; if (!s || s.id === "__review") return true;
    const values = this.answers(), problems = this.problems(s.fields, values);
    this.showProblems(s.fields, problems);
    if (problems.size) {
      const err = this.root.querySelector(".wizard-error");
      err.textContent = `Please check ${problems.size} answer${problems.size === 1 ? "" : "s"} in this step.`; err.hidden = false;
      const first = s.fields.find((f) => problems.has(f.key));
      this.root.querySelector(`[data-field="${CSS.escape(first.key)}"] input:not([type=hidden]), [data-field="${CSS.escape(first.key)}"] select`)?.focus();
    }
    return !problems.size;
  }
  next() { if (this.checkStep(this.step)) this.show(this.step + 1); }
  prev() { this.show(this.step - 1); }
  goto(index) { if (index <= this.maxStep) this.show(index); }
  renderReview() {
    const values = this.answers(), box = this.root.querySelector(".wizard-review");
    box.innerHTML = this.steps.filter((s) => s.id !== "__review").map((s, i) => {
      const rows = s.fields.filter((f) => this.applies(f, values)).map((f) => {
        const c = this.column(f.key);
        let shown;
        if (this.isFiles(f)) shown = (this.files.get(f.key) || []).map((x) => this.esc(x.file.name)).join("<br>");
        else { const v = values[f.key]; shown = this.empty(v) ? "" : this.esc(Array.isArray(v) ? v.join(", ") : `${v}${c.type === "number" && f.suffix ? ` ${f.suffix}` : ""}`); }
        return `<div class="wizard-review-row"><dt>${this.esc(this.label(f))}</dt><dd>${shown || '<span class="wizard-review-empty">—</span>'}</dd></div>`;
      }).join("");
      return `<section class="wizard-review-section"><div class="wizard-review-head"><h4>${this.esc(s.title)}</h4><button type="button" class="link-button" data-action="form-wizard-goto" data-index="${i}">Edit</button></div><dl>${rows}</dl></section>`;
    }).join("");
  }

  // ---- Submit, then files
  async submit() {
    if (this.busy) return;
    const steps = this.steps;
    if (this.step < steps.length - 1) { this.next(); return; }
    for (let i = 0; i < steps.length; i += 1) if (!this.checkStep(i)) { this.show(i); this.checkStep(i); return; }
    const all = this.answers(), values = {}, files = {};
    for (const f of this.visibleFields) {
      if (!this.applies(f, all)) continue; // never send an answer to a question that doesn't apply
      if (this.isFiles(f)) { const n = (this.files.get(f.key) || []).length; if (n) files[f.key] = n; continue; }
      if (!this.empty(all[f.key])) values[f.key] = all[f.key];
    }
    const root = this.root, button = root.querySelector(".wizard-submit"), error = root.querySelector(".wizard-error");
    this.busy = true; button.disabled = true; button.setAttribute("aria-busy", "true"); button.textContent = "Submitting…"; error.hidden = true;
    try {
      const { record, confirmation, submission } = await this.p.adapter.request("POST", `/forms/${this.form.id}/submit`, { submissionKey: this.attemptKey, values, ...(Object.keys(files).length ? { files } : {}) });
      this.record = record; this.submission = submission || null; this.clearDraft();
      this.p.adoptCreatedRecord(record); // on the board at once; undo history kept (see FormsPanel)
      // Files of questions that don't apply are dropped here: the server refused to expect them.
      for (const [key] of this.files) if (!files[key]) this.files.delete(key);
      this.done(confirmation);
      await this.uploadAll();
    } catch (e) {
      this.saveDraft(); // the answers survive an ended session (the sign-in screen replaces the page)
      error.textContent = this.failure(e); error.hidden = false;
      button.disabled = false; button.removeAttribute("aria-busy"); button.textContent = "Submit";
    } finally { this.busy = false; }
  }
  failure(e) {
    const code = e?.cause?.serverCode || e?.code;
    const again = " Your answers are still here; press Submit again. It can't create the record twice.";
    if (code === "UNAUTHENTICATED" || code === "CSRF_INVALID") return "Your session has ended. Sign in again, then open this form: your answers are kept in this tab and restored (files need to be added again). Nothing was saved twice.";
    if (code === "FORBIDDEN") return "You can't submit this form: it needs Member access to this workspace. Nothing was saved.";
    if (code === "FORM_NOT_PUBLISHED") return "This form isn't published any more. Nothing was saved.";
    if (code === "SUBMISSION_IN_PROGRESS") return `This submission is still being saved.${again}`;
    if (code === "DUPLICATE_RECORD") return "A record with this value already exists. Nothing was saved.";
    if (code === "RATE_LIMITED") return `Too many submissions in a short time. Wait a moment.${again}`;
    if (code === "VALIDATION_ERROR") return "The server refused an answer. Check the highlighted steps and try again. Nothing was saved.";
    if (["OFFLINE", "SERVICE_UNAVAILABLE", "INTERNAL_ERROR"].includes(code)) return `JARC couldn't be reached or didn't answer in time.${again}`;
    return `${e?.message || "This couldn't be submitted."}${again}`;
  }
  done(confirmation) {
    const r = this.record, list = [...this.files.entries()].flatMap(([key, items]) => items.map((x) => ({ key, x })));
    // With documents, "Submitted" is only shown once the server has confirmed them (verify()).
    this.p.view.overlay(`<div class="modal form-done wizard-done" role="status" aria-live="polite"><div class="modal-head"><h2 class="wizard-done-title">${list.length ? "Saved — attaching documents…" : "Submitted"}</h2>${this.p.view.closeButton()}</div>
      <p>${this.esc(confirmation || "Thanks, your answers were saved.")}</p>
      <p class="wizard-done-record"><strong>${this.esc(r.values?.serial || "")}</strong> · Record ID <code>${this.esc(r.id)}</code></p>
      ${list.length ? `<section class="wizard-uploads" aria-label="Supporting documents"><h3>Supporting documents</h3><ul>${list.map(({ key, x }, i) => `<li data-upload="${i}"><span class="wizard-file-name">${this.esc(x.file.name)}</span> <small>${this.esc(this.label(this.form.fields.find((f) => f.key === key)))}</small><progress max="1" value="0" aria-label="Uploading ${this.attr(x.file.name)}"></progress><span class="wizard-upload-state">Waiting</span></li>`).join("")}</ul></section>` : ""}
      <p class="form-fill-error wizard-upload-error" role="alert" hidden></p>
      <div class="modal-actions"><button type="button" class="button secondary" data-action="form-upload-retry" hidden>Retry failed uploads</button><button type="button" class="button secondary" data-action="form-open-record" data-id="${this.attr(r.id)}">Open the record</button><button type="button" class="button primary" data-action="close-overlay">Done</button></div></div>`);
    this.uploadList = list;
  }
  async uploadAll() {
    const list = this.uploadList || [], root = () => document.querySelector(".wizard-done");
    const item = (i) => root()?.querySelector(`[data-upload="${i}"]`);
    for (let i = 0; i < list.length; i += 1) {
      const { key, x } = list[i];
      if (x.state === "done") continue;
      x.state = "uploading"; x.error = "";
      const li = item(i); if (li) li.querySelector(".wizard-upload-state").textContent = "Uploading…";
      try {
        await this.p.adapter.uploadAttachment(this.record.id, key, x.file, { name: x.file.name, key: x.uploadKey, onProgress: (p) => { const el = item(i)?.querySelector("progress"); if (el) el.value = p; } });
        x.state = "done";
      } catch (e) { x.state = "failed"; x.error = e?.message || "The upload failed."; }
      const el = item(i);
      if (el) { el.querySelector("progress").value = x.state === "done" ? 1 : 0; el.querySelector(".wizard-upload-state").textContent = x.state === "done" ? "Uploaded" : `Not uploaded: ${x.error}`; el.classList.toggle("is-failed", x.state === "failed"); }
    }
    if (list.length) await this.verify(list.filter(({ x }) => x.state === "failed").length);
  }
  // The server's own check of what is attached; the only thing that may call the documents complete.
  async verify(failed) {
    const r = () => document.querySelector(".wizard-done");
    let result = null;
    if (this.submission?.key) { try { result = await this.p.adapter.request("POST", `/forms/${this.form.id}/submissions/${this.submission.key}/complete`); } catch { result = null; } }
    this.verified = result;
    const el = r(); if (!el) return;
    const done = result?.status === "done", err = el.querySelector(".wizard-upload-error"), title = el.querySelector(".wizard-done-title");
    title.textContent = done ? "Submitted" : "Saved — documents incomplete";
    if (done) { err.hidden = true; err.textContent = ""; }
    else {
      const missing = result?.missing?.length ? ` Missing: ${result.missing.join(", ")}.` : "";
      err.textContent = result
        ? `The record is saved, but its documents are incomplete.${missing}${failed ? ` ${failed} file${failed === 1 ? " wasn't" : "s weren't"} uploaded.` : ""} Retry now, or add ${failed === 1 ? "it" : "them"} to the record later.`
        : "The record is saved, but JARC couldn't confirm its documents. Retry to check them again.";
      err.hidden = false;
    }
    el.querySelector('[data-action="form-upload-retry"]').hidden = done;
  }
  async openRecord(id) {
    const m = this.p.model;
    this.p.view.closeOverlay();
    const find = () => m.rows?.find((row) => String(row.id) === String(m.idOf ? m.idOf(id) : id) || String(m.serverId?.(row.id)) === String(id));
    // Never through applyRemote (it clears undo history): the record was adopted at submit time; if the board was
    // reloaded since, it is fetched and adopted the same history-safe way.
    let row = find();
    if (!row) {
      try { const { record } = await this.p.adapter.request("GET", `/records/${encodeURIComponent(id)}`); row = this.p.adoptCreatedRecord(record) || find(); } catch { /* shown below */ }
    }
    if (row) this.p.c.update?.();
    if (row) this.p.view.showRecordForm(m, row); else this.p.view.toast("The record is saved. It appears on the board in a moment.");
  }

  // ---- Events from FormsPanel
  onAction(action, target) {
    if (action === "form-wizard-next") return this.next();
    if (action === "form-wizard-prev") return this.prev();
    if (action === "form-wizard-goto") return this.goto(Number(target.dataset.index));
    if (action === "form-wizard-cancel") { this.clearDraft(); this.p.view.closeOverlay(); return undefined; }
    if (action === "form-wizard-restart") { this.clearDraft(); this.attemptKey = this.p.uuid(); this.files = new Map(); this.maxStep = 0; this.open(); return undefined; }
    if (action === "form-chip-remove") { const el = this.inputs(target.dataset.key).find((e) => e.value === target.dataset.value); if (el) el.checked = false; this.refresh(); return undefined; }
    if (action === "form-choice-clear") { for (const el of this.inputs(target.dataset.key)) el.checked = false; this.refresh(); return undefined; }
    if (action === "form-calc-use") { const el = this.inputs(target.dataset.key)[0]; if (el) { el.value = target.dataset.value; el.focus(); } this.refresh(); return undefined; }
    if (action === "form-file-remove") { const list = this.files.get(target.dataset.key) || []; list.splice(Number(target.dataset.index), 1); this.renderFiles(target.dataset.key); return undefined; }
    if (action === "form-upload-retry") return this.uploadAll();
    if (action === "form-open-record") return this.openRecord(target.dataset.id);
    return undefined;
  }
  onChange(target) {
    if (target.dataset?.filesInput) { this.addFiles(target.dataset.filesInput, target.files); target.value = ""; return; }
    this.refresh();
  }
  onInput(target) {
    if (target.dataset?.pickerSearch) { this.filterPicker(target.dataset.pickerSearch, target.value); return; }
    this.refresh();
  }
}
