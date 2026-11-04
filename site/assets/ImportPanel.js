// Excel and CSV imports: upload, choose columns, check, then a background job with progress. The job runs on the server, so
// closing this screen or the browser doesn't stop it; reopening Import shows it again. The existing JSON import is unchanged.
class ImportPanel {
  constructor(controller) { this.c = controller; this.job = null; this.check = null; this.sample = []; this.timer = null; }
  get model() { return this.c.model; }
  get view() { return this.c.view; }
  get adapter() { return this.c.model.storage?.adapter; }
  esc(v) { return this.view.escape(v ?? ""); }
  attr(v) { return this.view.attr(v ?? ""); }
  boardId() { return this.model.serverId(this.model.board.id); }
  percent(j) { return j.batchCount ? Math.min(100, Math.round(j.processedBatches / j.batchCount * 100)) : 100; }
  isLive(j) { return ["queued", "running"].includes(j.status); }

  async onAction(action, target) {
    if (action === "xl-import-choose") return document.querySelector("#xl-import-file")?.click();
    if (action === "xl-import-open") return this.open(target.dataset.id);
    if (action === "xl-import-check") return this.saveSettings();
    if (action === "xl-import-start") return this.start(target.dataset.repeat === "1");
    if (["xl-import-pause", "xl-import-resume", "xl-import-cancel"].includes(action)) return this.control(action.slice("xl-import-".length));
    return undefined;
  }
  // Open imports on this board, shown in the existing Import dialog.
  async listHtml() {
    if (!this.adapter?.request) return "";
    try {
      const { items } = await this.adapter.request("GET", `/boards/${this.boardId()}/imports`);
      const open = items.filter((j) => ["mapping", "ready", "queued", "running", "paused"].includes(j.status));
      return open.length ? `<div class="xl-import-open"><strong>Imports in progress</strong>${open.map((j) => `<button class="link-button" data-action="xl-import-open" data-id="${this.attr(j.id)}">${this.esc(j.fileName)} · ${this.esc(this.statusWord(j))}</button>`).join("")}</div>` : "";
    } catch { return ""; }
  }
  async fillList() { const box = document.querySelector(".xl-import-list"); if (box) box.innerHTML = await this.listHtml(); }
  statusWord(j) { return { mapping: "choose columns", ready: "ready to start", queued: "waiting to start", running: `${this.percent(j)}%`, paused: "paused", done: "finished", failed: "failed", cancelled: "cancelled" }[j.status] || j.status; }

  // XMLHttpRequest because fetch can't report upload progress (same as attachments).
  upload(file) {
    if (file.size > 25 * 1024 * 1024) { this.view.showMessage("Import not ready", "Choose a file smaller than 25 MB."); return; }
    this.view.overlay(`<div class="modal small-modal"><div class="modal-head"><h2>Reading ${this.esc(file.name)}</h2></div><div class="xl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span style="width:0"></span></div></div>`);
    const xhr = new XMLHttpRequest(), http = this.adapter.http;
    xhr.open("POST", `${http.baseUrl}/boards/${encodeURIComponent(this.boardId())}/imports?name=${encodeURIComponent(file.name)}`);
    xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (http.csrfToken) xhr.setRequestHeader("X-CSRF-Token", http.csrfToken);
    xhr.upload.onprogress = (e) => { const bar = document.querySelector(".xl-progress span"); if (bar && e.lengthComputable) bar.style.width = `${Math.round(e.loaded / e.total * 100)}%`; };
    const failed = (message) => this.view.showMessage("Import not ready", message);
    xhr.onerror = xhr.ontimeout = () => failed("The connection was lost. Nothing was imported.");
    xhr.onload = () => {
      let body = null; try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status !== 201) return failed(body?.error?.message || (xhr.status === 413 ? "Choose a file smaller than 25 MB." : "That file couldn't be read."));
      this.job = body.import; this.sample = body.sample || []; this.check = null;
      return this.renderMapping();
    };
    xhr.send(file);
  }
  async open(id) {
    try { const { import: job } = await this.adapter.request("GET", `/imports/${encodeURIComponent(id)}`); this.job = job; this.check = null; this.sample = []; }
    catch (e) { this.view.toast(e?.message || "That import couldn't be opened."); return; }
    if (["mapping", "ready"].includes(this.job.status)) this.renderMapping(); else this.renderProgress();
  }

  columns() { return this.model.board.columns.filter((c) => !["files", "group"].includes(c.type)); }
  renderMapping() {
    const j = this.job, headerOptions = (selected) => `<option value=""></option>${j.headers.map((h, i) => `<option value="${i}" ${selected === i ? "selected" : ""}>${this.esc(h)}</option>`).join("")}`;
    const sample = this.sample.length ? `<div class="xl-sample"><table><thead><tr>${j.headers.slice(0, 8).map((h) => `<th>${this.esc(h)}</th>`).join("")}</tr></thead><tbody>${this.sample.map((r) => `<tr>${j.headers.slice(0, 8).map((_, i) => `<td>${this.esc(r[i])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : "";
    const groups = this.adapter.boards?.get?.(this.boardId())?.groups || [];
    const problems = this.check ? `<div class="xl-check" role="status"><p>Checked the first ${this.check.checked.toLocaleString()} of ${this.check.rowCount.toLocaleString()} rows: <strong>${this.check.valid.toLocaleString()}</strong> ready.${this.check.duplicatesOnBoard || this.check.duplicatesInFile ? ` ${(this.check.duplicatesOnBoard + this.check.duplicatesInFile).toLocaleString()} would be skipped as duplicates.` : ""}</p>${this.check.problems.length ? `<ul>${this.check.problems.map((p) => `<li>Row ${p.row}: ${this.esc(p.reason)}</li>`).join("")}</ul>` : ""}</div>` : "";
    const repeat = j.previousImport ? `<p class="xl-warning" role="alert">This same file was already imported to this board. Starting it again can add its rows twice unless a duplicate rule below catches them.</p>` : "";
    this.view.overlay(`<form class="modal import-modal xl-mapping" data-action="xl-import-mapping"><div class="modal-head"><div><div class="eyebrow">${this.esc(j.fileName)} · ${j.rowCount.toLocaleString()} rows${j.sheet ? ` · ${this.esc(j.sheet)}` : ""}</div><h2>Choose the columns</h2></div>${this.view.closeButton()}</div>${repeat}${sample}
      <div class="xl-map-grid">${this.columns().map((c) => `<label class="field">${this.esc(c.label)}${c.key === "serial" ? " *" : ""}<select name="map:${this.attr(c.key)}">${headerOptions(j.mapping[c.key])}</select></label>`).join("")}</div>
      <label class="field">Add records to<select name="groupId"><option value="">The first group</option>${groups.map((g) => `<option value="${this.attr(g.id)}" ${j.groupId === g.id ? "selected" : ""}>${this.esc(g.name)}</option>`).join("")}</select></label>
      <label class="field">Or use the group named in<select name="groupFrom">${headerOptions(j.groupFrom)}</select></label>
      <label class="field">Skip a row when this already exists<select name="uniqueKey"><option value="">Don't check for duplicates</option>${this.columns().filter((c) => !(c.type === "owner" || c.type === "checkbox" || (c.type === "dropdown" && c.multiple))).map((c) => `<option value="${this.attr(c.key)}" ${j.uniqueKey === c.key ? "selected" : ""}>${this.esc(c.label)}</option>`).join("")}</select></label>
      <label class="field">Dates like 03/04/2026 mean<select name="dateOrder"><option value="mdy" ${j.dateOrder !== "dmy" ? "selected" : ""}>March 4</option><option value="dmy" ${j.dateOrder === "dmy" ? "selected" : ""}>3 April</option></select></label>
      ${problems}
      <div class="modal-actions"><button type="button" class="button secondary" data-action="xl-import-cancel">Cancel import</button><button type="button" class="button secondary" data-action="xl-import-check">Check rows</button><button type="button" class="button primary" data-action="xl-import-start" ${j.previousImport ? 'data-repeat="1"' : ""} ${this.check ? "" : "disabled"}>Start import</button></div></form>`);
  }
  readSettings() {
    const form = document.querySelector(".xl-mapping"), mapping = {};
    for (const c of this.columns()) { const v = form.querySelector(`[name="map:${CSS.escape(c.key)}"]`).value; if (v !== "") mapping[c.key] = Number(v); }
    const pick = (name) => form.querySelector(`[name="${name}"]`).value;
    return { mapping, groupId: pick("groupId") || null, groupFrom: pick("groupFrom") === "" ? null : Number(pick("groupFrom")), uniqueKey: pick("uniqueKey") || null, dateOrder: pick("dateOrder") };
  }
  async saveSettings() {
    try { const { import: job, check } = await this.adapter.request("PATCH", `/imports/${this.job.id}`, this.readSettings()); this.job = job; this.check = check; this.renderMapping(); }
    catch (e) { this.view.toast(e?.message || "Those settings couldn't be saved."); }
  }
  async start(repeat) {
    try { const { import: job } = await this.adapter.request("POST", `/imports/${this.job.id}/start`, repeat ? { repeat: true } : {}); this.job = job; this.renderProgress(); }
    catch (e) { this.view.toast(e?.message || "The import couldn't start."); }
  }
  async control(what) {
    try { const { import: job } = await this.adapter.request("POST", `/imports/${this.job.id}/${what}`, {}); this.job = job; if (what === "cancel") this.reloadBoard(); this.renderProgress(); }
    catch (e) { this.view.toast(e?.message || "That didn't work. Try again."); }
  }
  renderProgress() {
    clearTimeout(this.timer);
    const j = this.job, ended = ["done", "failed", "cancelled"].includes(j.status), pct = this.percent(j);
    const errors = j.errors?.length ? `<details class="xl-errors"><summary>${j.rejected.toLocaleString()} row${j.rejected === 1 ? "" : "s"} couldn't be imported</summary><ul>${j.errors.map((e) => `<li>Row ${e.row}: ${this.esc(e.reason)}</li>`).join("")}</ul>${j.rejected > j.errors.length ? `<p>Showing the first ${j.errors.length}.</p>` : ""}</details>` : "";
    this.view.overlay(`<div class="modal small-modal xl-run"><div class="modal-head"><div><div class="eyebrow">${this.esc(j.fileName)}</div><h2>${{ done: "Import finished", failed: "Import stopped", cancelled: "Import cancelled", paused: "Import paused" }[j.status] || "Importing"}</h2></div>${this.view.closeButton()}</div>
      <div class="xl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
      <p role="status"><strong>${j.imported.toLocaleString()}</strong> imported · ${j.skippedDuplicates.toLocaleString()} duplicates skipped · ${j.rejected.toLocaleString()} rejected, of ${j.rowCount.toLocaleString()} rows</p>
      ${j.lastError ? `<p class="xl-warning" role="alert">${this.esc(j.lastError)}</p>` : ""}${errors}
      ${ended ? "" : "<p>You can close this window. The import keeps running on the server.</p>"}
      <div class="modal-actions">${this.isLive(j) ? '<button type="button" class="button secondary" data-action="xl-import-pause">Pause</button>' : ""}${j.status === "paused" ? '<button type="button" class="button secondary" data-action="xl-import-resume">Resume</button>' : ""}${ended ? "" : '<button type="button" class="button secondary" data-action="xl-import-cancel">Stop import</button>'}<button type="button" class="button primary" data-action="close-overlay">${ended ? "Done" : "Close"}</button></div></div>`);
    if (this.isLive(j)) this.timer = setTimeout(() => this.poll(), 2000);
    if (j.status === "done") this.reloadBoard();
  }
  async poll() {
    if (!document.querySelector(".xl-run") || !this.job) return;
    try { const { import: job } = await this.adapter.request("GET", `/imports/${this.job.id}`); this.job = job; if (document.querySelector(".xl-run")) this.renderProgress(); }
    catch { this.timer = setTimeout(() => this.poll(), 5000); }
  }
  reloadBoard() { window.dispatchEvent(new CustomEvent("jarc-board-changed", { detail: { boardId: this.model.board?.id } })); }
}
