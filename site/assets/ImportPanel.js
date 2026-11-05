// A new board from an Excel or CSV file, in guided steps: upload, what's in the file, the columns, the check of every row, confirm, progress.
// The work happens on the server, so closing this window or the browser doesn't stop an import; reopening Import shows it again.
// Existing boards are never touched. The server checks the person's session and workspace role on every request.
class ImportPanel {
  constructor(controller) { this.c = controller; this.job = null; this.step = null; this.timer = null; this.changeHeader = false; }
  get model() { return this.c.model; }
  get view() { return this.c.view; }
  get adapter() { return this.c.model.storage?.adapter; }
  get enabled() { return Boolean(this.model.features?.spreadsheetImports && this.adapter?.request); }
  esc(v) { return this.view.escape(v ?? ""); }
  attr(v) { return this.view.attr(v ?? ""); }
  workspaceId() { const id = this.model.workspace?.id; return this.model.serverId ? this.model.serverId(id) : id; }
  percent(j) { return j.batchCount ? Math.min(100, Math.round(j.processedBatches / j.batchCount * 100)) : 100; }
  isLive(j) { return ["queued", "running", "removing"].includes(j.status); }
  plural(n, one, many = `${one}s`) { return `${Number(n).toLocaleString()} ${n === 1 ? one : many}`; }

  async onAction(action, target) {
    if (!this.enabled) return undefined;
    switch (action) {
      case "xl-import-new": return this.showStart();
      case "xl-import-choose": return document.querySelector("#xl-import-file")?.click();
      case "xl-import-open": return this.open(target.dataset.id);
      case "xl-import-change-header": this.changeHeader = true; return this.render();
      case "xl-import-structure": return this.saveStructure();
      case "xl-import-columns": return this.saveColumns();
      case "xl-import-goto": this.step = target.dataset.step; return this.render();
      case "xl-import-report": return this.downloadReport();
      case "xl-import-confirm-check": return this.updateConfirm();
      case "xl-import-start": return this.start();
      case "xl-import-pause": case "xl-import-resume": case "xl-import-cancel": return this.control(action.slice("xl-import-".length));
      case "xl-import-remove": return this.removeBoard();
      case "xl-import-remove-go": return this.removeBoard(true);
      case "xl-import-open-board": return this.openBoard();
      default: return undefined;
    }
  }

  // ---- Start
  async showStart() {
    if (!this.model.workspace) { this.view.showMessage("Import not ready", "Open a workspace first."); return; }
    this.job = null; this.step = null;
    this.view.overlay(`<div class="modal xl-wizard"><div class="modal-head"><div><div class="eyebrow">${this.esc(this.model.workspace.name)}</div><h2>New board from a file</h2></div>${this.view.closeButton()}</div>${this.steps("upload")}
      <p>Choose an Excel (.xlsx) or CSV export, such as one from monday.com. You'll check what JARC found before anything is created. Your existing boards aren't touched.</p>
      <button type="button" class="import-upload" data-action="xl-import-choose">${icon("import")}<strong>Choose a file</strong><small>Up to 25 MB and 100,000 rows.</small></button>
      <input id="xl-import-file" type="file" data-action="xl-import-file" accept=".xlsx,.csv,.tsv,.txt" hidden><div class="xl-import-list"></div>
      <div class="modal-actions"><button type="button" class="button secondary" data-action="close-overlay">Close</button></div></div>`);
    await this.fillList();
  }
  async listHtml() {
    if (!this.enabled || !this.model.workspace) return "";
    try {
      const { items } = await this.adapter.request("GET", `/workspaces/${encodeURIComponent(this.workspaceId())}/imports`);
      const open = items.filter((j) => ["mapping", "ready", "queued", "running", "paused"].includes(j.status));
      return open.length ? `<div class="xl-import-open"><strong>Imports in progress</strong>${open.map((j) => `<button type="button" class="link-button" data-action="xl-import-open" data-id="${this.attr(j.id)}">${this.esc(j.fileName)} · ${this.esc(this.statusWord(j))}</button>`).join("")}</div>` : "";
    } catch { return ""; }
  }
  async fillList() { const box = document.querySelector(".xl-import-list"); if (box) box.innerHTML = await this.listHtml(); }
  statusWord(j) { return { mapping: "needs checking", ready: "ready to start", queued: "waiting to start", running: `${this.percent(j)}%`, paused: "paused", done: "finished", failed: "stopped", cancelled: "cancelled", removing: "removing the board", removed: "board removed" }[j.status] || j.status; }

  // XMLHttpRequest because fetch can't report upload progress (same as attachments).
  upload(file) {
    if (!this.enabled) return;
    if (file.size > 25 * 1024 * 1024) { this.view.showMessage("Import not ready", "Choose a file smaller than 25 MB."); return; }
    this.view.overlay(`<div class="modal small-modal xl-wizard"><div class="modal-head"><h2>Reading ${this.esc(file.name)}</h2></div><div class="xl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span style="width:0"></span></div><p role="status" class="xl-reading">Uploading…</p></div>`);
    const xhr = new XMLHttpRequest(), http = this.adapter.http;
    xhr.open("POST", `${http.baseUrl}/workspaces/${encodeURIComponent(this.workspaceId())}/imports?name=${encodeURIComponent(file.name)}`);
    xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (http.csrfToken) xhr.setRequestHeader("X-CSRF-Token", http.csrfToken);
    xhr.upload.onprogress = (e) => { const bar = document.querySelector(".xl-progress span"); if (bar && e.lengthComputable) bar.style.width = `${Math.round(e.loaded / e.total * 100)}%`; if (e.lengthComputable && e.loaded >= e.total) { const note = document.querySelector(".xl-reading"); if (note) note.textContent = "Checking every row…"; } };
    const failed = (message) => this.view.showMessage("Import not ready", message);
    xhr.onerror = xhr.ontimeout = () => failed("The connection was lost. Nothing was imported.");
    xhr.onload = () => {
      let body = null; try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status !== 201) {
        if (body?.error?.code === "IMPORT_ALREADY_OPEN" && body.error.details?.importId) return this.open(body.error.details.importId);
        return failed(body?.error?.message || (xhr.status === 413 ? "Choose a file smaller than 25 MB." : "That file couldn't be read."));
      }
      this.job = body.import; this.step = "structure"; this.changeHeader = false;
      return this.render();
    };
    xhr.send(file);
  }
  async open(id) {
    try { const { import: job } = await this.adapter.request("GET", `/imports/${encodeURIComponent(id)}`); this.job = job; }
    catch (e) { this.view.toast(e?.message || "That import couldn't be opened."); return; }
    this.step = ["mapping", "ready"].includes(this.job.status) ? "structure" : "run"; this.changeHeader = false;
    this.render();
  }

  // ---- Steps
  steps(current) {
    const list = [["upload", "Upload"], ["structure", "What's in the file"], ["columns", "Columns"], ["check", "Check"], ["confirm", "Confirm"], ["run", "Import"]], at = list.findIndex(([k]) => k === current);
    return `<ol class="xl-steps" aria-label="Import steps">${list.map(([k, label], i) => `<li class="${i < at ? "is-done" : i === at ? "is-current" : ""}" ${i === at ? 'aria-current="step"' : ""}><span>${i + 1}</span><em>${label}</em></li>`).join("")}</ol>`;
  }
  frame(step, title, body, actions) {
    const j = this.job;
    this.view.overlay(`<form class="modal xl-wizard xl-step-${step}" data-action="xl-import-form"><div class="modal-head"><div><div class="eyebrow">${this.esc(j.fileName)}${j.sheet ? ` · ${this.esc(j.sheet)}` : ""}</div><h2>${title}</h2></div>${this.view.closeButton()}</div>${this.steps(step)}${body}<div class="modal-actions">${actions}</div></form>`);
  }
  render() {
    if (this.step === "structure") return this.renderStructure();
    if (this.step === "columns") return this.renderColumns();
    if (this.step === "check") return this.renderCheck();
    if (this.step === "confirm") return this.renderConfirm();
    return this.renderProgress();
  }
  cancelButton() { return '<button type="button" class="button secondary" data-action="xl-import-cancel">Cancel import</button>'; }

  renderStructure() {
    const j = this.job, s = j.structure, v = j.validation, reasons = s.reasons || [], needHeader = this.changeHeader || s.headerLine === null || reasons.some((r) => /^(header-|no-records)/.test(r.code) && r.code !== "header-differs");
    const needSolo = reasons.some((r) => r.code === "solo-rows") || (s.soloLines?.length > 0);
    const found = v ? `<div class="xl-stats"><div><strong>${v.records.toLocaleString()}</strong><span>records</span></div><div><strong>${v.groups.length.toLocaleString()}</strong><span>${v.groups.length === 1 ? "group" : "groups"}</span></div><div><strong>${s.columns.length.toLocaleString()}</strong><span>columns</span></div></div>
      <p>Column names are on row <strong>${s.headerLine}</strong>${s.boardTitle ? `, and the board's title is “${this.esc(s.boardTitle)}”` : ""}.</p>
      ${v.groups.length ? `<details class="xl-groups" ${v.groups.length <= 8 ? "open" : ""}><summary>Groups</summary><ul>${v.groups.slice(0, 200).map((g) => `<li>${this.esc(g.name)} <small>${this.plural(g.records, "record")}</small></li>`).join("")}</ul></details>` : ""}
      <p class="xl-note">Not imported as records: ${[[s.counts.titles, "title row"], [s.counts.groupHeadings, "group heading"], [s.counts.headerRows + 1, "row of column names"], [s.counts.subitemRows, "sub-item row"], [s.counts.summaryRows, "total row"]].filter(([n]) => n).map(([n, w]) => this.plural(n, w, w === "row of column names" ? "rows of column names" : `${w}s`)).join(", ")}.</p>` : "";
    const problem = reasons.length ? `<div class="xl-alert" role="alert"><strong>Please check this before continuing</strong><ul>${reasons.map((r) => `<li>${this.esc(r.message)}</li>`).join("")}</ul></div>` : "";
    const headers = needHeader ? `<fieldset class="xl-choose-header"><legend>Which row holds the column names?</legend><div class="xl-table-wrap"><table>${s.candidates.map((c) => `<tr><td><label><input type="radio" name="headerLine" value="${c.line}" ${c.line === s.headerLine ? "checked" : ""}> Row ${c.line}</label></td>${c.cells.map((t) => `<td>${this.esc(t)}</td>`).join("")}</tr>`).join("")}</table></div></fieldset>` : (s.headerLine !== null ? '<button type="button" class="link-button" data-action="xl-import-change-header">That\'s the wrong row</button>' : "");
    const solo = needSolo ? `<label class="field">Rows with only a name after a blank row are<select name="soloRows"><option value="">Choose…</option><option value="groups">Group headings</option><option value="records">Records</option></select></label>` : "";
    const needTotals = reasons.some((r) => r.code === "total-rows");
    const totals = needTotals ? `<label class="field">Rows with only numbers and no name at the end of a group are<select name="totalRows"><option value="">Choose…</option><option value="skip">Totals, leave them out</option><option value="records">Records, I'll fix their names</option></select></label>` : "";
    const needItem = reasons.some((r) => /^item-column/.test(r.code));
    const item = needItem ? `<label class="field">Which column names each record?<select name="itemColumn">${s.columns.map((c) => `<option value="${c.index}" ${c.index === s.itemColumn ? "selected" : ""}>${this.esc(c.label)}</option>`).join("")}</select></label>` : "";
    this.frame("structure", "What's in the file", `${problem}${found}${headers}${solo}${totals}${item}`, `${this.cancelButton()}<button type="button" class="button primary" data-action="xl-import-structure">${reasons.length ? "Apply and continue" : "Looks right, continue"}</button>`);
  }
  // One step at a time. While the server works, the window says so and nothing in it can be pressed or changed, so a step can't be sent twice. If it fails,
  // the window comes back as it was, with what the person entered. The button pressed shows the app's usual busy state.
  // Closing the window (Escape) is still allowed: the server finishes the step, and `work` is told not to reopen the window afterwards.
  async whileWorking(message, work) {
    const box = document.querySelector("#overlay-root .modal");
    if (box?.getAttribute("aria-busy") === "true") return;
    const controls = box ? [...box.querySelectorAll("button, input, select")].filter((c) => !c.disabled) : [], pressed = box?.querySelector(".modal-actions .button.primary, .modal-actions .button.danger");
    if (box) {
      box.setAttribute("aria-busy", "true");
      controls.forEach((c) => { c.disabled = true; });
      pressed?.classList.add("is-busy");
      box.querySelector(".modal-actions")?.insertAdjacentHTML("afterbegin", `<p class="xl-working" role="status"><span class="loading-spinner" aria-hidden="true"></span>${this.esc(message)}</p>`);
    }
    try { await work(() => !box || box.isConnected); }
    finally {
      if (box?.isConnected) {
        box.removeAttribute("aria-busy");
        controls.forEach((c) => { c.disabled = false; });
        pressed?.classList.remove("is-busy");
        box.querySelector(".xl-working")?.remove();
      }
    }
  }
  async saveStructure() {
    const form = document.querySelector(".xl-wizard"), pick = (n) => form.querySelector(`[name="${n}"]:checked`)?.value ?? form.querySelector(`select[name="${n}"]`)?.value ?? "", body = {};
    if (pick("headerLine") !== "") body.headerLine = Number(pick("headerLine"));
    if (pick("soloRows")) body.soloRows = pick("soloRows");
    if (pick("totalRows")) body.totalRows = pick("totalRows");
    if (pick("itemColumn") !== "") body.itemColumn = Number(pick("itemColumn"));
    await this.whileWorking("Checking the file. A large file can take a little while…", async (stillOpen) => {
      if (!await this.patch(body, stillOpen) || !stillOpen()) return;
      this.changeHeader = false;
      this.step = this.job.structureConfirmed ? "columns" : "structure";
      this.render();
    });
  }
  async patch(body, stillOpen = () => true) {
    const id = this.job.id;
    try { const { import: job } = await this.adapter.request("PATCH", `/imports/${id}`, body); if (stillOpen()) this.job = job; return true; }
    catch (e) { if (stillOpen()) this.view.toast(e?.message || "Those settings couldn't be saved."); return false; }
  }

  renderColumns() {
    const j = this.job, first = j.validation?.preview?.[0], shown = j.validation?.previewColumns || [], sample = (label) => { const at = shown.indexOf(label); return at >= 0 && first ? first.cells[at] : ""; };
    const row = (c) => { const main = c.index === j.itemColumn; return `<tr class="${main ? "is-main" : ""}"><td data-label="From the file">${this.esc(c.source || `(no name) Column ${c.index + 1}`)}</td><td data-label="Example" class="xl-example">${this.esc(sample(c.label))}</td>
      <td data-label="In the new board"><input name="label:${c.index}" value="${this.attr(c.label)}" maxlength="200" aria-label="Name in the new board for ${this.attr(c.source || `column ${c.index + 1}`)}">${main ? '<small class="xl-main-note">The board\'s Item column</small>' : ""}</td>
      <td data-label="Type"><select name="type:${c.index}" ${main ? "disabled" : ""} aria-label="Type"><option value="text" ${(c.type || "text") === "text" ? "selected" : ""}>Text</option><option value="number" ${c.type === "number" ? "selected" : ""}>Number</option><option value="date" ${c.type === "date" ? "selected" : ""}>Date</option></select></td>
      <td data-label="Import"><input type="checkbox" name="include:${c.index}" ${c.include !== false ? "checked" : ""} ${main ? "disabled" : ""} aria-label="Import this column"></td></tr>`; };
    this.frame("columns", "Columns", `<label class="field">Name of the new board<input name="boardName" value="${this.attr(j.boardName)}" maxlength="200" required></label>
      <p class="xl-note">Each column of the file becomes a column of the new board, as text unless you choose otherwise. Text keeps IDs, leading zeros and dates exactly as written.</p>
      <div class="xl-table-wrap"><table class="xl-map"><thead><tr><th>From the file</th><th>Example</th><th>In the new board</th><th>Type</th><th>Import</th></tr></thead><tbody>${j.columns.map(row).join("")}</tbody></table></div>
      <div class="xl-options"><label class="field">Skip a row when this repeats<select name="uniqueColumn"><option value="">Don't skip any rows</option>${j.columns.map((c) => `<option value="${c.index}" ${j.uniqueColumn === c.index ? "selected" : ""}>${this.esc(c.label)}</option>`).join("")}</select></label>
      <label class="field">If a date column has dates like 03/04/2026, they mean<select name="dateOrder"><option value="mdy" ${j.dateOrder !== "dmy" ? "selected" : ""}>March 4</option><option value="dmy" ${j.dateOrder === "dmy" ? "selected" : ""}>3 April</option></select></label></div>`,
    `<button type="button" class="button secondary" data-action="xl-import-goto" data-step="structure">Back</button>${this.cancelButton()}<button type="button" class="button primary" data-action="xl-import-columns">Check every row</button>`);
  }
  async saveColumns() {
    const form = document.querySelector(".xl-wizard"), j = this.job;
    const columns = j.columns.map((c) => { const main = c.index === j.itemColumn; return { index: c.index, label: form.querySelector(`[name="label:${c.index}"]`).value.trim() || c.label, type: main ? "text" : form.querySelector(`[name="type:${c.index}"]`).value, include: main ? true : form.querySelector(`[name="include:${c.index}"]`).checked }; });
    const unique = form.querySelector('[name="uniqueColumn"]').value;
    const body = { columns, boardName: form.querySelector('[name="boardName"]').value, uniqueColumn: unique === "" ? null : Number(unique), dateOrder: form.querySelector('[name="dateOrder"]').value };
    await this.whileWorking("Checking every row. A large file can take a little while…", async (stillOpen) => {
      if (!await this.patch(body, stillOpen) || !stillOpen()) return;
      this.step = "check"; this.render();
    });
  }

  renderCheck() {
    const j = this.job, v = j.validation, blocked = v.errorCount > 0 || j.status !== "ready", d = v.duplicates;
    const errors = v.errorCount ? `<div class="xl-alert" role="alert"><strong>${this.plural(v.errorCount, "problem")} to fix before importing</strong><ul>${v.errors.slice(0, 15).map((e) => `<li>Row ${e.row}: ${this.esc(e.column)} ${this.esc(e.reason)}</li>`).join("")}</ul>${v.errorCount > 15 ? `<p>Showing the first 15.</p>` : ""}<button type="button" class="button secondary small" data-action="xl-import-report">Download the full list</button></div>` : '<p class="xl-good" role="status">Every row can be imported.</p>';
    const warnings = v.warnings.length ? `<details class="xl-warnings" open><summary>${this.plural(v.warnings.length, "thing")} to know</summary><ul>${v.warnings.map((w) => `<li>${this.esc(w.message)}</li>`).join("")}</ul></details>` : "";
    const preview = v.preview?.length ? `<details class="xl-preview" open><summary>Preview</summary><div class="xl-table-wrap"><table><thead><tr><th>Group</th>${v.previewColumns.slice(0, 8).map((c) => `<th>${this.esc(c)}</th>`).join("")}</tr></thead><tbody>${v.preview.map((r) => `<tr><td>${this.esc(r.group)}</td>${r.cells.slice(0, 8).map((t) => `<td>${this.esc(t)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>` : "";
    this.frame("check", "Check", `<div class="xl-stats"><div><strong>${v.records.toLocaleString()}</strong><span>records</span></div><div><strong>${v.groups.length.toLocaleString()}</strong><span>${v.groups.length === 1 ? "group" : "groups"}</span></div><div><strong>${v.columns.toLocaleString()}</strong><span>columns</span></div><div><strong>${d.sameRows.toLocaleString()}</strong><span>repeated rows</span></div><div class="${v.errorCount ? "is-bad" : ""}"><strong>${v.errorCount.toLocaleString()}</strong><span>problems</span></div><div><strong>${v.warnings.length.toLocaleString()}</strong><span>notes</span></div></div>
      ${d.sameUnique ? `<p class="xl-note">${this.plural(d.sameUnique, "row")} will be skipped because the chosen column repeats.</p>` : ""}${errors}${warnings}${preview}`,
    `<button type="button" class="button secondary" data-action="xl-import-goto" data-step="columns">Back</button>${this.cancelButton()}<button type="button" class="button primary" data-action="xl-import-goto" data-step="confirm" ${blocked ? "disabled" : ""}>Continue</button>`);
  }

  renderConfirm() {
    const j = this.job, v = j.validation;
    const repeat = j.previousImport ? `<div class="xl-alert" role="alert"><strong>This same file was already imported</strong><p>It made ${this.plural(j.previousImport.imported, "record")}${j.previousImport.boardName ? ` in “${this.esc(j.previousImport.boardName)}”` : ""}. Importing it again makes a second copy.</p><label class="xl-confirm"><input type="checkbox" name="repeat" data-action="xl-import-confirm-check"> Yes, import it again</label></div>` : "";
    this.frame("confirm", "Confirm", `<p>This creates a new board, <strong>${this.esc(j.boardName)}</strong>, in <strong>${this.esc(this.model.workspace?.name)}</strong>, with ${this.plural(v.columns, "column")}, ${this.plural(v.groups.length, "group")} and ${this.plural(v.records - (v.duplicates.sameUnique || 0), "record")}.</p>
      <p class="xl-note">No existing board changes. You can pause or stop the import, and remove the new board afterwards as long as nobody has changed it.</p>${repeat}
      <label class="xl-confirm"><input type="checkbox" name="confirmNewBoard" data-action="xl-import-confirm-check"> Yes, create this new board and import these records</label>`,
    `<button type="button" class="button secondary" data-action="xl-import-goto" data-step="check">Back</button>${this.cancelButton()}<button type="button" class="button primary" data-action="xl-import-start" disabled>Create board and import</button>`);
  }
  updateConfirm() {
    const form = document.querySelector(".xl-wizard"), start = form?.querySelector("[data-action=xl-import-start]");
    if (start) start.disabled = ![...form.querySelectorAll(".xl-confirm input")].every((box) => box.checked);
  }
  async start() {
    const form = document.querySelector(".xl-wizard"), repeat = form.querySelector('[name="repeat"]');
    if (!form.querySelector('[name="confirmNewBoard"]').checked || (repeat && !repeat.checked)) return;
    const body = { confirmNewBoard: true, ...(repeat ? { repeat: true } : {}) };
    await this.whileWorking("Starting the import…", async (stillOpen) => {
      try { const { import: job } = await this.adapter.request("POST", `/imports/${this.job.id}/start`, body); if (!stillOpen()) return; this.job = job; this.step = "run"; this.renderProgress(); }
      catch (e) { if (stillOpen()) this.view.toast(e?.message || "The import couldn't start."); }
    });
  }
  async control(what) {
    await this.whileWorking({ pause: "Pausing…", resume: "Resuming…", cancel: "Cancelling…" }[what], async (stillOpen) => {
      try {
        const { import: job } = await this.adapter.request("POST", `/imports/${this.job.id}/${what}`, {});
        if (!stillOpen()) return;
        this.job = job;
        if (what === "cancel" && !job.boardId) { this.view.closeOverlay(); this.view.toast("Import cancelled. Nothing was created."); return; }
        this.step = "run"; this.renderProgress();
      } catch (e) { if (stillOpen()) this.view.toast(e?.message || "That didn't work. Try again."); }
    });
  }

  renderProgress() {
    clearTimeout(this.timer);
    const j = this.job, ended = ["done", "failed", "cancelled", "removed"].includes(j.status), pct = this.percent(j), madeBoard = Boolean(j.boardId) && !["removed", "removing"].includes(j.status);
    const errors = j.errors?.length ? `<details class="xl-errors"><summary>${this.plural(j.rejected, "row")} couldn't be imported</summary><ul>${j.errors.map((e) => `<li>Row ${e.row}: ${this.esc(e.reason)}</li>`).join("")}</ul>${j.rejected > j.errors.length ? `<p>Showing the first ${j.errors.length}.</p>` : ""}<button type="button" class="button secondary small" data-action="xl-import-report">Download the list</button></details>` : "";
    const title = { done: "Import finished", failed: "Import stopped", cancelled: "Import cancelled", paused: "Import paused", removing: "Removing the board", removed: "Board removed" }[j.status] || "Importing";
    const removed = j.status === "removed" ? "<p role=\"status\">The new board and its records were removed. Nothing else changed.</p>" : j.status === "removing" ? `<p role="status">${this.plural(j.removedRecords || 0, "record")} removed so far. You can close this window.</p>` : "";
    const leftovers = madeBoard && ["failed", "cancelled"].includes(j.status) ? `<p class="xl-note">The new board holds the ${this.plural(j.imported, "record")} imported so far. You can keep it or remove it.</p>` : "";
    this.frame("run", title, `<div class="xl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${j.status === "removed" ? 0 : pct}%"></span></div>
      <p role="status"><strong>${j.imported.toLocaleString()}</strong> imported · ${j.skippedDuplicates.toLocaleString()} skipped as repeats · ${j.rejected.toLocaleString()} rejected, of ${this.plural(j.rowCount, "record")}</p>
      ${j.lastError ? `<p class="xl-warning" role="alert">${this.esc(j.lastError)}</p>` : ""}${errors}${removed}${leftovers}${ended || j.status === "removing" ? "" : "<p>You can close this window. The import keeps running on the server.</p>"}`,
    `${madeBoard && ended ? '<button type="button" class="button secondary" data-action="xl-import-remove">Remove the new board</button>' : ""}${["queued", "running"].includes(j.status) ? '<button type="button" class="button secondary" data-action="xl-import-pause">Pause</button>' : ""}${j.status === "paused" ? '<button type="button" class="button secondary" data-action="xl-import-resume">Resume</button>' : ""}${ended || j.status === "removing" ? "" : '<button type="button" class="button secondary" data-action="xl-import-cancel">Stop import</button>'}${madeBoard && ended ? '<button type="button" class="button primary" data-action="xl-import-open-board">Open the board</button>' : `<button type="button" class="button primary" data-action="close-overlay">${ended ? "Done" : "Close"}</button>`}`);
    if (this.isLive(j)) this.timer = setTimeout(() => this.poll(), 2000);
  }
  async poll() {
    if (!document.querySelector(".xl-step-run") || !this.job) return;
    try { const { import: job } = await this.adapter.request("GET", `/imports/${this.job.id}`); this.job = job; if (document.querySelector(".xl-step-run")) this.renderProgress(); }
    catch { this.timer = setTimeout(() => this.poll(), 5000); }
  }
  async removeBoard(confirmed = false) {
    if (!confirmed) { this.view.showMessage?.("Remove the new board?", ""); const box = document.querySelector("#overlay-root .modal"); if (box) { box.querySelector("p")?.remove(); box.querySelector(".modal-actions")?.remove(); box.insertAdjacentHTML("beforeend", `<p>This removes “${this.esc(this.job.boardName)}” and everything this import put in it. It's refused if anyone has changed the board since. Nothing else is touched.</p><div class="modal-actions"><button type="button" class="button secondary" data-action="close-overlay">Keep it</button><button type="button" class="button danger" data-action="xl-import-remove-go">Remove the board</button></div>`); } return; }
    await this.whileWorking("Starting the removal…", async (stillOpen) => {
      try { const { import: job } = await this.adapter.request("POST", `/imports/${this.job.id}/remove-board`, {}); if (!stillOpen()) return; this.job = job; this.step = "run"; this.renderProgress(); }
      catch (e) { if (!stillOpen()) return; this.view.closeOverlay(); this.view.showMessage("Board not removed", e?.message || "That didn't work."); }
    });
  }
  async downloadReport() {
    try {
      const http = this.adapter.http, res = await fetch(`${http.baseUrl}/imports/${encodeURIComponent(this.job.id)}/report`, { credentials: "same-origin" });
      if (!res.ok) throw new Error();
      this.c.download(await res.blob(), `${this.job.fileName.replace(/\.[a-z0-9]+$/i, "")}-problems.csv`);
    } catch { this.view.toast("The list couldn't be downloaded. Try again."); }
  }
  // The new board reaches this browser through the usual live update; if that's slow, the page is reloaded.
  async openBoard() {
    const find = () => this.model.workspaces.flatMap((w) => w.boards.map((b) => ({ w, b }))).find(({ b }) => String(this.model.serverId ? this.model.serverId(b.id) : b.id) === String(this.job.boardId));
    let hit = find();
    for (let i = 0; i < 30 && !hit; i += 1) { await new Promise((r) => setTimeout(r, 100)); hit = find(); }
    if (!hit) { location.reload(); return; }
    this.view.closeOverlay(); this.model.openBoard(hit.b.id, hit.w.id); this.c.update();
  }
}
