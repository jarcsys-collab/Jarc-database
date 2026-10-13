// Record drawer tabs (Fields · Updates · Files · Activity) and the Updates discussion (Phase 8). Loaded after
// AppView.js. Comments live on the server (resource mode); every name, time and word is rendered escaped — text is
// plain, with line breaks and @mentions of known people highlighted.
Object.assign(AppView.prototype, {
  // Called after the record drawer renders (editing an existing record).
  setupRecordTabs(model, row, tab = "fields") {
    const form = document.querySelector("#overlay-root form.record-drawer"); if (!form) return;
    const files = form.querySelector('[data-panel="files"]');
    const parts = [...form.querySelectorAll(".record-form-grid > .drawer-files")];
    parts.forEach((n) => files.appendChild(n));
    if (!parts.length) files.innerHTML = `<p class="field-note">This board has no Files column. Add one to attach files to records.</p>`;
    const count = parts.reduce((n, p) => n + p.querySelectorAll(".drawer-file").length, 0);
    const badge = form.querySelector('[data-tab="files"] .tab-count'); if (badge) { badge.textContent = count || ""; badge.hidden = !count; }
    this.selectDrawerTab(tab);
  },
  selectDrawerTab(tab) {
    const form = document.querySelector("#overlay-root form.record-drawer"); if (!form || !form.querySelector(`[data-panel="${tab}"]`)) return;
    form.dataset.tab = tab;
    form.querySelectorAll('[role="tab"][data-tab]').forEach((b) => { const on = b.dataset.tab === tab; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; b.classList.toggle("active", on); });
    form.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  },
  recordTabs(model, row) {
    const n = model.commentCount(row.id);
    return `<div class="drawer-tabs" role="tablist" aria-label="Record sections">${[["fields", "Fields"], ["updates", "Updates"], ["files", "Files"], ["activity", "Activity log"]].map(([t, label]) => `<button type="button" role="tab" id="drawer-tab-${t}" aria-controls="drawer-panel-${t}" data-action="drawer-tab" data-tab="${t}" aria-selected="${t === "fields"}">${label}${t === "updates" ? `<span class="tab-count" data-role="updates-count" ${n ? "" : "hidden"}>${n || ""}</span>` : t === "files" ? `<span class="tab-count" hidden></span>` : ""}</button>`).join("")}</div>`;
  },
  // The speech-bubble button beside a record's name, with its number of updates.
  commentButton(model, row) {
    const n = model.commentCount(row.id), name = this.escape(row.serial || "record");
    return `<button type="button" class="comment-indicator ${n ? "has-comments" : ""}" data-action="open-updates" data-id="${this.attr(row.id)}" aria-label="${n ? `${n} update${n === 1 ? "" : "s"} on ${name}` : `Add an update to ${name}`}" title="${n ? `${n} update${n === 1 ? "" : "s"}` : "Start an update"}">${icon("comment")}${n ? `<span class="comment-count">${n > 99 ? "99+" : n}</span>` : ""}</button>`;
  }
});

class CommentsPanel {
  constructor(controller) { this.c = controller; this.reset(); this.countTimer = null; this.reloadTimer = null; }
  reset() { this.expanded = new Set(); this.recordId = null; this.items = null; this.error = ""; this.loading = false; this.people = null; this.replyTo = null; this.editing = null; this.drafts = {}; }
  get model() { return this.c.model; }
  get view() { return this.c.view; }
  get adapter() { return this.c.model.storage?.adapter; }
  get available() { return typeof this.adapter?.listComments === "function"; }
  esc(v) { return this.view.escape(v ?? ""); }
  root() { return document.querySelector("#overlay-root .updates-panel"); }
  serverId(id) { return String(this.adapter?.resolve ? this.adapter.resolve(id) : id); }

  // ---- Opening, loading, live refresh
  open(recordId) { this.reset(); this.recordId = recordId; this.render(); if (this.available) { this.load(); this.loadPeople(); } }
  close() { this.reset(); }
  async load({ quiet = false } = {}) {
    if (!this.available || this.recordId === null) return;
    const id = this.recordId;
    if (!quiet) { this.loading = true; this.render(); }
    try { const items = await this.adapter.listComments(id); if (id !== this.recordId) return; this.items = items; this.error = ""; }
    catch (error) { if (id !== this.recordId) return; this.error = error?.message || "Updates couldn't load."; }
    finally { if (id === this.recordId) { this.loading = false; this.render(); } }
    this.setCount(id, (this.items || []).filter((c) => !c.deleted).length);
  }
  async loadPeople() { const id = this.recordId; try { const people = await this.adapter.mentionable(id); if (id !== this.recordId) return; this.people = people; if (this.items?.some((c) => c.mentions?.length)) this.render(); } catch { this.people = []; } }
  setCount(recordId, n) {
    const key = this.serverId(recordId); this.model.commentCounts[key] = n; this.model.commentCounts[String(recordId)] = n;
    const badge = document.querySelector('#overlay-root [data-role="updates-count"]'); if (badge) { badge.textContent = n || ""; badge.hidden = !n; }
    this.view.refreshCommentIndicator?.(this.model, recordId);
  }
  async loadCounts(boardId = this.model.board?.id) {
    if (!this.available || !boardId) return;
    try { const counts = await this.adapter.commentCounts(boardId); if (String(this.model.board?.id) !== String(boardId)) return; this.model.commentCounts = counts; for (const row of this.model.rows) if (counts[this.serverId(row.id)] !== undefined) this.model.commentCounts[String(row.id)] = counts[this.serverId(row.id)]; this.c.refreshCommentIndicators?.(); } catch { /* counts are a convenience */ }
  }
  // Live updates: comment.* events (IDs only) refresh the open discussion and the counts.
  onRemote(events) {
    if (this.recordId !== null && !this.root()) this.reset(); // the drawer was closed
    const open = this.recordId !== null ? this.serverId(this.recordId) : null;
    if (open && events.some((e) => e.recordId === open)) { clearTimeout(this.reloadTimer); this.reloadTimer = setTimeout(() => this.load({ quiet: true }), 150); }
    if (events.some((e) => String(e.boardId) === this.serverId(this.model.board?.id))) { clearTimeout(this.countTimer); this.countTimer = setTimeout(() => this.loadCounts(), 300); }
  }

  // ---- Rendering
  format(c) {
    // Escape first, then highlight "@Name" for the people this comment mentions (names from the directory).
    let html = this.esc(c.body);
    const names = (c.mentions || []).map((id) => (this.people || []).find((p) => p.id === id)?.displayName).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const name of names) { const safe = this.esc(`@${name}`); html = html.split(safe).join(`<span class="mention">${safe}</span>`); }
    return html.replace(/\n/g, "<br>");
  }
  // Long updates show their first lines with "See more" (expanded state lasts while the record is open).
  bodyHtml(c) {
    const long = c.body.length > 600 || c.body.split("\n").length > 10, open = this.expanded.has(c.id);
    return `<div class="update-body ${long && !open ? "is-clamped" : ""}" id="update-body-${this.esc(c.id)}">${this.format(c)}</div>${long ? `<button type="button" class="link-button see-more" data-action="comment-expand" data-comment="${this.esc(c.id)}" aria-expanded="${open}" aria-controls="update-body-${this.esc(c.id)}">${open ? "See less" : "See more"}</button>` : ""}`;
  }
  canPost() { const row = this.model.rows.find((r) => String(r.id) === String(this.recordId)); return this.available && !this.model.board?.source?.readOnly && !row?.archived; }
  composer(role, { parent = "", value = "", label = "Write an update and mention others with @" } = {}) {
    return `<div class="update-composer" data-role="${role}" ${parent ? `data-parent="${this.esc(parent)}"` : ""}><textarea data-action="comment-input" data-role="${role}" rows="${role === "new" ? 3 : 2}" maxlength="5000" placeholder="${this.esc(label)}" aria-label="${this.esc(label)}">${this.esc(value)}</textarea><div class="mention-suggestions" role="listbox" aria-label="People to mention" hidden></div><div class="composer-actions"><button type="button" class="icon-button composer-at" data-action="comment-at" aria-label="Mention someone" title="Mention someone">@</button><small class="composer-hint">Ctrl+Enter to post</small><span class="composer-status" role="status" aria-live="polite"></span>${role !== "new" ? `<button type="button" class="button secondary small" data-action="comment-cancel">Cancel</button>` : ""}<button type="button" class="button primary small" data-action="comment-submit">${role === "edit" ? "Save" : role === "reply" ? "Reply" : "Post"}</button></div></div>`;
  }
  card(c, { reply = false } = {}) {
    const when = new Date(c.createdAt), full = Number.isNaN(when.getTime()) ? "" : when.toLocaleString();
    const editing = this.editing === c.id;
    const actions = c.deleted ? "" : `<div class="update-actions">${reply ? "" : `<button type="button" class="link-button" data-action="comment-reply" data-comment="${this.esc(c.id)}">${icon("comment")} Reply</button>`}${c.canEdit ? `<button type="button" class="link-button" data-action="comment-edit" data-comment="${this.esc(c.id)}">${icon("edit")} Edit</button>` : ""}${c.canDelete ? `<button type="button" class="link-button danger-text" data-action="comment-delete" data-comment="${this.esc(c.id)}">${icon("trash")} Delete</button>` : ""}</div>`;
    return `<article class="update-card ${reply ? "is-reply" : ""} ${c.deleted ? "is-deleted" : ""}" data-comment="${this.esc(c.id)}" aria-label="Update by ${this.esc(c.author.name)}"><header><span class="person-avatar ${c.author.isYou ? "is-you" : ""}" aria-hidden="true">${this.esc(this.view.initials(c.author.name))}</span><span class="update-author"><strong>${this.esc(c.author.isYou ? `${c.author.name} (you)` : c.author.name)}</strong><time datetime="${this.esc(c.createdAt)}" title="${this.esc(full)}">${this.esc(this.view.relative(c.createdAt))}</time>${c.editedAt ? `<small class="edited" title="Edited ${this.esc(new Date(c.editedAt).toLocaleString())}">Edited</small>` : ""}</span></header>${c.deleted ? `<p class="update-body is-deleted">This update was deleted.</p>` : editing ? this.composer("edit", { value: c.body, label: "Edit your update" }) : this.bodyHtml(c)}${editing ? "" : actions}</article>`;
  }
  body() {
    if (!this.available) return `<div class="quiet-empty">${icon("comment")}<span><strong>Updates need the shared JARC server</strong><small>Sign in to JARC's server to discuss records with colleagues.</small></span></div>`;
    if (this.model.board?.source?.readOnly) return `<p class="field-note">This board is synced from monday.com and is read-only, so updates are turned off.</p>${this.list()}`;
    const archived = this.model.rows.find((r) => String(r.id) === String(this.recordId))?.archived;
    return `${archived ? `<p class="field-note">This record is archived. Restore it to post updates.</p>` : this.composer("new", { value: this.drafts.new || "" })}${this.list()}`;
  }
  list() {
    if (this.loading && !this.items) return `<div class="updates-loading" aria-busy="true"><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line"></span></div>`;
    if (this.error && !this.items) return `<div class="notice" role="alert">${this.esc(this.error)} <button type="button" class="link-button" data-action="comment-retry">Try again</button></div>`;
    const items = this.items || [], top = items.filter((c) => !c.parentId).reverse(); // newest thread first
    if (!top.length) return `<div class="quiet-empty">${icon("comment")}<span><strong>No updates yet</strong><small>Share progress, ask a question, or mention a colleague with @.</small></span></div>`;
    return `<div class="update-list">${top.map((c) => { const replies = items.filter((r) => r.parentId === c.id); const prompt = !c.deleted && this.canPost() ? (this.replyTo === c.id ? this.composer("reply", { parent: c.id, label: "Write a reply and mention others with @" }) : `<button type="button" class="reply-prompt" data-action="comment-reply" data-comment="${this.esc(c.id)}"><span class="person-avatar is-you" aria-hidden="true">${this.esc(this.model.profile?.initials || "")}</span><span>Write a reply and mention others with @</span></button>`) : "";
      return `<div class="update-thread">${this.card(c)}${replies.length || prompt ? `<div class="update-replies">${replies.map((r) => this.card(r, { reply: true })).join("")}${prompt}</div>` : ""}</div>`; }).join("")}</div>`;
  }
  render() {
    const root = this.root(); if (!root) return;
    const active = document.activeElement, role = active?.dataset?.action === "comment-input" ? active.dataset.role : null, caret = role ? [active.selectionStart, active.selectionEnd] : null;
    if (role === "new") this.drafts.new = active.value;
    root.innerHTML = this.body();
    if (role) { const again = root.querySelector(`textarea[data-role="${role}"]`); if (again) { if (role === "new") again.value = this.drafts.new || ""; again.focus(); again.setSelectionRange(...caret); } }
  }

  // ---- Actions
  async onAction(action, target) {
    const id = target.dataset.comment;
    if (action === "comment-retry") return this.load();
    if (action === "comment-reply") { this.replyTo = id; this.editing = null; this.render(); this.root()?.querySelector('textarea[data-role="reply"]')?.focus(); return; }
    if (action === "comment-edit") { this.editing = id; this.replyTo = null; this.render(); const t = this.root()?.querySelector('textarea[data-role="edit"]'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } return; }
    if (action === "comment-cancel") { this.editing = null; this.replyTo = null; return this.render(); }
    if (action === "comment-mention") return this.insertMention(target);
    if (action === "comment-expand") { if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id); return this.render(); }
    if (action === "comment-at") { const t = target.closest(".update-composer")?.querySelector("textarea"); if (!t) return; const at = t.selectionStart ?? t.value.length, before = t.value.slice(0, at); const insert = (before && !/\s$/.test(before) ? " " : "") + "@"; t.value = before + insert + t.value.slice(t.selectionEnd ?? at); const pos = at + insert.length; t.focus(); t.setSelectionRange(pos, pos); this.onInput(t); return; }
    if (action === "comment-delete") return this.confirmDelete(id, target);
    if (action === "comment-delete-yes") return this.remove(target.dataset.comment);
    if (action === "comment-submit") return this.submit(target.closest(".update-composer"));
  }
  confirmDelete(id, target) {
    const card = target.closest(".update-card"), bar = card?.querySelector(".update-actions"); if (!bar) return;
    bar.innerHTML = `<span class="danger-text">Delete this update?</span><button type="button" class="button danger small" data-action="comment-delete-yes" data-comment="${this.esc(id)}">Delete</button><button type="button" class="button secondary small" data-action="comment-cancel">Keep</button>`;
    bar.querySelector('[data-action="comment-delete-yes"]').focus();
  }
  async remove(id) {
    try { await this.adapter.deleteComment(id); this.view.toast("Update deleted"); await this.load({ quiet: true }); }
    catch (error) { this.view.toast(error?.message || "The update couldn't be deleted"); this.render(); }
  }
  async submit(box) {
    if (!box || box.dataset.busy) return;
    const textarea = box.querySelector("textarea"), role = box.dataset.role, text = textarea.value.trim(), status = box.querySelector(".composer-status");
    if (!text) { status.textContent = "Write something first."; textarea.focus(); return; }
    const mentions = this.mentionsIn(textarea);
    box.dataset.busy = "1"; box.querySelectorAll("button,textarea").forEach((el) => { el.disabled = true; }); status.textContent = role === "edit" ? "Saving…" : "Posting…";
    try {
      if (role === "edit") { const current = this.items.find((c) => c.id === this.editing); await this.adapter.editComment(this.editing, { body: text, mentions, expectedVersion: current.version }); this.editing = null; }
      else await this.adapter.postComment(this.recordId, { body: text, mentions, ...(role === "reply" ? { parentId: box.dataset.parent } : {}) });
      if (role === "new") this.drafts.new = "";
      if (role === "reply") this.replyTo = null;
      this.view.toast(role === "edit" ? "Update saved" : role === "reply" ? "Reply posted" : "Update posted");
      textarea.value = "";
      await this.load({ quiet: true });
    } catch (error) {
      delete box.dataset.busy; box.querySelectorAll("button,textarea").forEach((el) => { el.disabled = false; });
      status.textContent = error?.message || "That didn't work. Try again."; textarea.focus();
    }
  }

  // ---- @mentions: "@query" before the caret lists matching people; choosing one inserts "@Name " and remembers
  // the person's stable ID on the textarea. Only names still present when posting are sent.
  mentionQuery(textarea) { const before = textarea.value.slice(0, textarea.selectionStart); const m = /(^|\s)@([^\s@]{0,40})$/.exec(before); return m ? { query: m[2], start: before.length - m[2].length - 1 } : null; }
  onInput(textarea) {
    const box = textarea.closest(".update-composer"), list = box?.querySelector(".mention-suggestions"); if (!list) return;
    if (box.dataset.role === "new") this.drafts.new = textarea.value;
    const q = this.mentionQuery(textarea);
    const people = q ? (this.people || []).filter((p) => p.displayName.toLowerCase().includes(q.query.toLowerCase())).slice(0, 8) : [];
    if (!q || !people.length) { list.hidden = true; list.innerHTML = ""; return; }
    list.innerHTML = people.map((p, i) => `<button type="button" role="option" aria-selected="${i === 0}" class="${i === 0 ? "is-active" : ""}" data-action="comment-mention" data-id="${this.esc(p.id)}" data-name="${this.esc(p.displayName)}"><span class="person-avatar" aria-hidden="true">${this.esc(this.view.initials(p.displayName))}</span>${this.esc(p.displayName)}${p.isYou ? " <small>(you)</small>" : ""}</button>`).join("");
    list.hidden = false;
  }
  onKeydown(event) {
    const textarea = event.target, box = textarea.closest(".update-composer"), list = box?.querySelector(".mention-suggestions");
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); this.submit(box); return true; }
    if (!list || list.hidden) { if (event.key === "Escape" && box.dataset.role !== "new") { event.preventDefault(); this.onAction("comment-cancel", textarea); return true; } return false; }
    const options = [...list.querySelectorAll('[role="option"]')], index = options.findIndex((o) => o.classList.contains("is-active"));
    if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); const next = (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length; options.forEach((o, i) => { o.classList.toggle("is-active", i === next); o.setAttribute("aria-selected", String(i === next)); }); return true; }
    if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); this.insertMention(options[Math.max(0, index)]); return true; }
    if (event.key === "Escape") { event.preventDefault(); list.hidden = true; return true; }
    return false;
  }
  insertMention(option) {
    const box = option?.closest(".update-composer"), textarea = box?.querySelector("textarea"); if (!textarea) return;
    const q = this.mentionQuery(textarea); if (!q) return;
    const name = option.dataset.name, insert = `@${name} `;
    textarea.value = textarea.value.slice(0, q.start) + insert + textarea.value.slice(textarea.selectionStart);
    const at = q.start + insert.length; textarea.setSelectionRange(at, at); textarea.focus();
    const known = JSON.parse(textarea.dataset.mentions || "{}"); known[name] = option.dataset.id; textarea.dataset.mentions = JSON.stringify(known);
    const list = box.querySelector(".mention-suggestions"); list.hidden = true; list.innerHTML = "";
    if (box.dataset.role === "new") this.drafts.new = textarea.value;
  }
  mentionsIn(textarea) {
    const known = JSON.parse(textarea.dataset.mentions || "{}"), text = textarea.value;
    // Editing: people already mentioned stay mentioned while their @Name remains.
    if (textarea.dataset.role === "edit") { const current = this.items?.find((c) => c.id === this.editing); for (const id of current?.mentions || []) { const p = (this.people || []).find((x) => x.id === id); if (p) known[p.displayName] = id; } }
    return [...new Set(Object.entries(known).filter(([name]) => text.includes(`@${name}`)).map(([, id]) => id))];
  }
}
