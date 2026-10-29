// Settings → Account Management (Phase M4.3): the Super Admin sees who has signed in, approves accounts, assigns a
// global role and workspace access, blocks and reactivates — and sees each account's history. Shows only what the
// server reports (GET /api/v1/accounts); the server alone enforces every rule (self-changes, the last Super Admin,
// role caps, versions). Never shows tenant or object IDs, sessions or tokens. High-impact changes ask for confirmation;
// blocking and granting Super Admin need a typed phrase.
class AccountsPanel {
  static ROLES = [["SUPER_ADMIN", "Super Admin"], ["ADMIN", "Admin"], ["EDITOR", "Editor"], ["VIEWER", "Viewer"]];
  static WORKSPACE_ROLES = [["VIEWER", "Viewer"], ["MEMBER", "Editor"], ["WORKSPACE_ADMIN", "Workspace admin"]];
  // The highest workspace role each global role can hold (the server enforces the same).
  static CAP = { SUPER_ADMIN: 3, ADMIN: 3, EDITOR: 2, VIEWER: 1 };
  static RANK = { VIEWER: 1, MEMBER: 2, WORKSPACE_ADMIN: 3 };
  static STATUS = { pending: ["Pending approval", "warn"], active: ["Active", "ok"], blocked: ["Blocked", "danger"], legacy: ["Not reviewed", "muted"] };
  static CONFIRM = { block: "BLOCK", superAdmin: "GRANT SUPER ADMIN", bootstrap: "I AM THE SUPER ADMIN" };

  constructor(controller) { this.c = controller; this.items = null; this.loading = false; this.error = ""; this.filters = { q: "", role: "", status: "" }; this.detail = null; this.pending = null; this.searchTimer = null; }
  get view() { return this.c.view; }
  get adapter() { return this.c.model.storage?.adapter; }
  get perms() { return this.c.model.permissions?.accountManagement || null; }
  visible() { const p = this.perms; return Boolean(p && (p.canManage || p.canClaimSuperAdmin)); }
  esc(v) { return this.view.escape(v ?? ""); }
  api(method, path, body) { return this.adapter.request(method, `/accounts${path}`, body); }
  roleLabel(role) { return (AccountsPanel.ROLES.find(([r]) => r === role) || [null, "No role"])[1]; }
  wsRoleLabel(role) { return (AccountsPanel.WORKSPACE_ROLES.find(([r]) => r === role) || [null, role || "—"])[1]; }
  date(iso) { if (!iso) return "Never"; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : this.esc(d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })); }
  badge(a) {
    const [label, tone] = a.disabled ? ["Disabled", "danger"] : AccountsPanel.STATUS[a.status] || ["Unknown", "muted"];
    return `<span class="account-badge is-${tone}">${label}</span>`;
  }

  // ---- Settings section
  sectionHtml() {
    if (this.perms?.canManage && !this.items && !this.loading) setTimeout(() => this.load(), 0);
    return `<div id="accounts-root" class="accounts">${this.body()}</div>`;
  }
  redraw() { const root = document.querySelector("#accounts-root"); if (root) root.innerHTML = this.body(); }
  async load() {
    this.loading = true;
    try { this.items = (await this.api("GET", "")).items; this.error = ""; }
    catch (error) { this.error = this.message(error); }
    finally { this.loading = false; this.redraw(); }
  }

  // Never claims that Viewer or Editor limits apply while they don't.
  notice() {
    const p = this.perms, perm = this.c.model.permissions || {};
    if (!p.enforced) {
      const open = perm.betaOpenEditing || perm.accessPolicy === "development_shared";
      return `<div class="account-alert is-warn" role="status"><strong>Observation mode — roles are not enforced yet.</strong><span>You can review people and record their roles and workspaces, but ${open ? `${perm.betaOpenEditing ? "<strong>beta editing remains enabled</strong>" : "shared development access remains enabled"}, so <strong>every signed-in employee can still view and edit every workspace</strong> — Viewer, Editor and Pending limits do not apply yet.` : "access is still decided by workspace memberships alone; global roles and pending approval do not apply yet."} Blocking an account takes effect immediately.</span></div>`;
    }
    const ignored = (p.overridden || []).map((o) => `<code>${this.esc(o)}</code>`).join(" and ");
    return `<div class="account-alert is-ok" role="status"><strong>Roles are enforced.</strong><span>Pending accounts can't open anything, and each person can only use the workspaces assigned to them, within their role.${ignored ? ` ${ignored} ${p.overridden.length > 1 ? "are" : "is"} set on the server but ignored.` : ""}</span></div>`;
  }

  body() {
    const p = this.perms;
    if (!p) return "";
    if (!p.canManage) {
      return `<div class="account-claim"><h3>Set up the Super Admin</h3><p>Your Microsoft account is the administrator configured for this JARC server. Becoming Super Admin lets you approve accounts and assign roles. It can only be done once, and only with your verified Microsoft sign-in and the JARC administrator role.</p><button class="button primary" data-action="acct-claim">Become Super Admin</button></div>`;
    }
    if (this.error && !this.items) return `${this.notice()}<p class="account-empty" role="alert">${this.esc(this.error)}</p><button class="button secondary" data-action="acct-refresh">Try again</button>`;
    if (!this.items) return `${this.notice()}<p class="account-empty" aria-busy="true">Loading accounts…</p>`;
    const counts = Object.fromEntries(Object.keys(AccountsPanel.STATUS).map((s) => [s, this.items.filter((a) => a.status === s).length]));
    const f = this.filters, q = f.q.trim().toLowerCase();
    const rows = this.items.filter((a) => (!q || `${a.displayName} ${a.email || ""}`.toLowerCase().includes(q)) && (!f.role || (f.role === "none" ? !a.role : a.role === f.role)) && (!f.status || a.status === f.status));
    const option = (value, label, current) => `<option value="${this.esc(value)}" ${value === current ? "selected" : ""}>${this.esc(label)}</option>`;
    return `${this.notice()}
      <div class="account-stats">${Object.entries(AccountsPanel.STATUS).map(([s, [label]]) => `<button type="button" class="account-stat ${f.status === s ? "is-active" : ""}" data-action="acct-status-chip" data-status="${s}" aria-pressed="${f.status === s}"><span>${label}</span><strong>${counts[s]}</strong></button>`).join("")}</div>
      <div class="account-filters" role="search"><label class="account-search">${icon("search")}<input type="search" data-action="acct-search" value="${this.esc(f.q)}" placeholder="Search name or email" aria-label="Search accounts"></label>
        <select data-action="acct-filter" data-key="role" aria-label="Filter by role">${option("", "All roles", f.role)}${AccountsPanel.ROLES.map(([r, l]) => option(r, l, f.role)).join("")}${option("none", "No role yet", f.role)}</select>
        <select data-action="acct-filter" data-key="status" aria-label="Filter by status">${option("", "All statuses", f.status)}${Object.entries(AccountsPanel.STATUS).map(([s, [l]]) => option(s, l, f.status)).join("")}</select>
        <button type="button" class="button secondary" data-action="acct-refresh">${icon("refresh")}<span>Refresh</span></button></div>
      ${rows.length ? `<table class="account-table"><thead><tr><th>Employee</th><th>Status</th><th>Role</th><th>First login</th><th>Last login</th><th>Workspaces</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows.map((a) => `<tr>
        <td data-label="Employee"><strong>${this.esc(a.displayName)}</strong>${a.id === this.c.auth?.userId ? ` <small class="account-you">You</small>` : ""}<small>${this.esc(a.email || "No email")}</small></td>
        <td data-label="Status">${this.badge(a)}</td><td data-label="Role">${this.esc(this.roleLabel(a.role))}</td>
        <td data-label="First login">${this.date(a.firstLoginAt)}</td><td data-label="Last login">${this.date(a.lastLoginAt)}</td>
        <td data-label="Workspaces">${a.role === "SUPER_ADMIN" ? "All workspaces" : a.workspaces.length ? this.esc(a.workspaces.map((w) => w.name || "Workspace").join(", ")) : `<span class="muted">None</span>`}</td>
        <td><button type="button" class="button secondary" data-action="acct-open" data-id="${this.esc(a.id)}">${a.status === "pending" || a.status === "legacy" ? "Review" : "Manage"}</button></td></tr>`).join("")}</tbody></table>` : `<p class="account-empty">No accounts match.</p>`}`;
  }

  // ---- One account
  async open(id) {
    try { this.detail = await this.api("GET", `/${encodeURIComponent(id)}`); this.showDetail(); }
    catch (error) { this.view.showMessage("Account Management", this.message(error)); }
  }
  roleOptions(current, max = 4) { return AccountsPanel.ROLES.slice(4 - max).map(([r, l]) => `<option value="${r}" ${r === current ? "selected" : ""}>${l}</option>`).join(""); }
  wsRoleOptions(account, current) {
    const cap = account.status === "legacy" ? 3 : AccountsPanel.CAP[account.role] || 0;
    return AccountsPanel.WORKSPACE_ROLES.filter(([r]) => AccountsPanel.RANK[r] <= cap).map(([r, l]) => `<option value="${r}" ${r === current ? "selected" : ""}>${l}</option>`).join("");
  }
  describe(h) {
    const ch = (h.changes || []).map((c) => `${this.esc(c.field === "workspaceRole" ? "workspace role" : c.field)}: ${this.esc(c.from ?? "—")} → ${this.esc(c.to ?? "—")}`).join(", ");
    const what = { "account.created": "First signed in (pending approval)", "account.approved": "Approved", "account.role_changed": "Role changed", "account.blocked": "Blocked", "account.reactivated": "Reactivated", "account.workspace_assigned": "Workspace access added", "account.workspace_role_changed": "Workspace role changed", "account.workspace_removed": "Workspace access removed", "account.super_admin_bootstrapped": "Became the first Super Admin" }[h.action] || h.action;
    return `<li><time datetime="${this.esc(h.at)}">${this.date(h.at)}</time><div><strong>${this.esc(what)}</strong>${h.workspaceName ? ` · ${this.esc(h.workspaceName)}` : ""}<small>${ch}${h.actorName ? `${ch ? " · " : ""}by ${this.esc(h.actorName)}` : ""}</small></div></li>`;
  }
  showDetail() {
    const { account: a, history } = this.detail, self = a.id === this.c.auth?.userId;
    let actions = "";
    if (self) actions = `<p class="account-note">You can't change your own account. Another Super Admin has to do it.</p>`;
    else if (a.disabled) actions = `<p class="account-note">This user is disabled on the server.</p>`;
    else if (a.status === "pending" || a.status === "legacy") actions = `<form class="account-action" data-action="acct-approve-form"><label>Role<select name="role" required><option value="" selected disabled>Choose a role…</option>${this.roleOptions(null)}</select></label><button class="button primary">Approve account</button></form>${a.status === "legacy" ? `<p class="account-note">This person signed in before Account Management. Approving keeps their current workspace access, limited by the role you choose.</p>` : ""}<button type="button" class="button danger-button" data-action="acct-block">Block</button>`;
    else if (a.status === "active") actions = `<form class="account-action" data-action="acct-role-form"><label>Role<select name="role">${this.roleOptions(a.role)}</select></label><button class="button secondary">Change role</button></form><button type="button" class="button danger-button" data-action="acct-block">Block account</button>`;
    else if (a.status === "blocked") actions = `<form class="account-action" data-action="acct-reactivate-form"><label>Role<select name="role" required>${a.role ? "" : `<option value="" selected disabled>Choose a role…</option>`}${this.roleOptions(a.role)}</select></label><button class="button primary">Reactivate</button></form>`;
    const canAssign = !self && !a.disabled && (a.status === "active" || a.status === "legacy");
    const assigned = new Set(a.workspaces.map((w) => w.workspaceId));
    const spaces = (this.c.model.workspaces || []).filter((w) => /^[0-9a-f]{24}$/.test(String(w.id)) && !assigned.has(String(w.id)));
    const workspaces = a.role === "SUPER_ADMIN" ? `<p class="account-note">A Super Admin can open every workspace.</p>` : "";
    const list = a.workspaces.length ? `<ul class="account-workspaces">${a.workspaces.map((w) => `<li><span><strong>${this.esc(w.name || "Workspace")}</strong>${w.effectiveRole !== w.role ? `<small>Limited to ${this.esc(this.wsRoleLabel(w.effectiveRole))} by the account role</small>` : ""}</span>${canAssign ? `<select data-action="acct-ws-role" data-ws="${this.esc(w.workspaceId)}" aria-label="Role in ${this.esc(w.name || "workspace")}">${this.wsRoleOptions(a, w.role)}${AccountsPanel.RANK[w.role] > (a.status === "legacy" ? 3 : AccountsPanel.CAP[a.role] || 0) ? `<option value="${this.esc(w.role)}" selected disabled>${this.esc(this.wsRoleLabel(w.role))}</option>` : ""}</select><button type="button" class="button secondary" data-action="acct-ws-remove" data-ws="${this.esc(w.workspaceId)}" data-name="${this.esc(w.name || "this workspace")}">Remove</button>` : `<em>${this.esc(this.wsRoleLabel(w.role))}</em>`}</li>`).join("")}</ul>` : `<p class="account-note">No workspace access yet.</p>`;
    const add = canAssign && spaces.length ? `<form class="account-action" data-action="acct-ws-add-form"><label>Workspace<select name="workspaceId" required>${spaces.map((w) => `<option value="${this.esc(w.id)}">${this.esc(w.name)}</option>`).join("")}</select></label><label>Access<select name="role">${this.wsRoleOptions(a, "VIEWER")}</select></label><button class="button secondary">Give access</button></form>` : !canAssign && a.status === "pending" ? `<p class="account-note">Approve the account before giving it workspace access.</p>` : "";
    const facts = [["Role", this.roleLabel(a.role)], ["First login", this.date(a.firstLoginAt)], ["Last login", this.date(a.lastLoginAt)], ["Approved", a.approvedAt ? `${this.date(a.approvedAt)}${a.approvedBy?.name ? ` by ${this.esc(a.approvedBy.name)}` : ""}` : "Not yet"]];
    this.view.overlay(`<div class="modal account-modal" role="dialog" aria-labelledby="account-title"><div class="modal-head"><div><div class="eyebrow">Account Management</div><h2 id="account-title">${this.esc(a.displayName)}</h2><p>${this.esc(a.email || "No email")} ${this.badge(a)}</p></div>${this.view.closeButton()}</div>
      <dl class="account-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
      <section aria-label="Account"><h3>Access</h3><div class="account-actions">${actions}</div></section>
      <section aria-label="Workspaces"><h3>Workspaces</h3>${workspaces}${list}${add}</section>
      <section aria-label="History"><h3>Role change history</h3>${history.length ? `<ol class="account-history">${history.map((h) => this.describe(h)).join("")}</ol>` : `<p class="account-note">No changes yet.</p>`}</section>
      <div class="modal-actions"><button type="button" class="button secondary" data-action="acct-back">Back to all accounts</button></div></div>`, "account-overlay");
  }

  // ---- Confirmations (typed phrase for blocking and Super Admin)
  confirm({ title, text, label, phrase = null, run }) {
    this.pending = run;
    this.view.overlay(`<form class="modal confirm-modal account-confirm" data-action="acct-confirm-form"><div class="confirm-icon">!</div><h2>${this.esc(title)}</h2><p>${this.esc(text)}</p>${phrase ? `<label class="account-phrase">Type <strong>${this.esc(phrase)}</strong> to confirm<input name="phrase" required autocomplete="off" spellcheck="false" autofocus></label>` : ""}<div class="modal-actions"><button type="button" class="button secondary" data-action="acct-cancel">Cancel</button><button class="button danger-button">${this.esc(label)}</button></div></form>`);
  }
  async change(path, body, toast) {
    const a = this.detail?.account;
    try {
      const res = await this.api(path.method || "POST", path.url, body);
      this.view.toast(toast);
      this.items = null; this.load();
      if (res?.account && res.history) this.detail = res;
      else if (a) this.detail = await this.api("GET", `/${encodeURIComponent(a.id)}`);
      if (this.detail) this.showDetail();
    } catch (error) {
      this.view.showMessage("Not changed", this.message(error));
      if (a && error?.code === "CONFLICT") { this.items = null; this.load(); }
    }
  }
  message(error) {
    const code = error?.code;
    if (code === "CONFLICT") return "Someone else changed this account meanwhile. Reload it and try again.";
    if (code === "VALIDATION_ERROR") return "That change isn't allowed. For example: a workspace role above what the account role allows, removing a workspace's last admin, a missing confirmation, or a change to the last Super Admin.";
    if (code === "FORBIDDEN") return "You don't have permission to make this change.";
    return (typeof StorageError !== "undefined" ? StorageError.describe(error) : error)?.message || "That didn't work.";
  }

  // ---- Events (data-action="acct-…")
  onSearch(input) { clearTimeout(this.searchTimer); this.filters.q = input.value; this.searchTimer = setTimeout(() => { const pos = input.selectionStart; this.redraw(); const next = document.querySelector('[data-action="acct-search"]'); next?.focus(); next?.setSelectionRange(pos, pos); }, 150); }
  onFilter(select) { this.filters[select.dataset.key] = select.value; this.redraw(); }
  onAction(action, target) {
    const a = this.detail?.account;
    if (action === "acct-refresh") { this.items = null; this.load(); return; }
    if (action === "acct-status-chip") { this.filters.status = this.filters.status === target.dataset.status ? "" : target.dataset.status; this.redraw(); return; }
    if (action === "acct-open") { this.open(target.dataset.id); return; }
    if (action === "acct-back") { this.detail = null; this.view.showSettings(this.c.model, "accounts"); return; }
    if (action === "acct-cancel") { this.pending = null; if (this.detail) this.showDetail(); else this.view.showSettings(this.c.model, "accounts"); return; }
    if (action === "acct-claim") {
      this.confirm({ title: "Become Super Admin?", text: "You will be the only person who can approve accounts, assign roles and block access. This is recorded in the audit trail.", label: "Become Super Admin", phrase: AccountsPanel.CONFIRM.bootstrap, run: async () => {
        try { await this.api("POST", "/bootstrap", { confirm: AccountsPanel.CONFIRM.bootstrap }); this.view.closeOverlay(); this.view.toast("You are now the Super Admin"); window.location.reload(); } // a fresh start with the new role
        catch (error) { this.view.showMessage("Not changed", this.message(error)); }
      } });
      return;
    }
    if (action === "acct-block" && a) {
      this.confirm({ title: `Block ${a.displayName}?`, text: "They are signed out everywhere at once and can't sign in to JARC until a Super Admin reactivates them.", label: "Block account", phrase: AccountsPanel.CONFIRM.block, run: (phrase) => this.change({ url: `/${a.id}/block` }, { expectedVersion: a.version, confirm: phrase }, "Account blocked") });
      return;
    }
    if (action === "acct-ws-remove" && a) {
      const ws = target.dataset.ws;
      this.confirm({ title: "Remove workspace access?", text: `${a.displayName} will no longer see ${target.dataset.name}.`, label: "Remove access", run: () => this.change({ method: "DELETE", url: `/${a.id}/workspaces/${ws}` }, undefined, "Workspace access removed") });
    }
  }
  onChange(select) {
    const a = this.detail?.account;
    if (select.dataset.action !== "acct-ws-role" || !a) return;
    const ws = select.dataset.ws, role = select.value;
    this.confirm({ title: "Change workspace access?", text: `${a.displayName} becomes ${this.wsRoleLabel(role)} in this workspace.`, label: "Change access", run: () => this.change({ method: "PUT", url: `/${a.id}/workspaces/${ws}` }, { role }, "Workspace access changed") });
  }
  onSubmit(action, data) {
    const a = this.detail?.account;
    if (action === "acct-confirm-form") { const run = this.pending; this.pending = null; run?.(data.phrase || undefined); return; }
    if (!a) return;
    const superAdmin = data.role === "SUPER_ADMIN";
    const ask = (title, text, label, url, toast) => this.confirm({ title, text: superAdmin ? `${text} A Super Admin can manage every account and workspace.` : text, label, phrase: superAdmin ? AccountsPanel.CONFIRM.superAdmin : null, run: (phrase) => this.change({ url }, { role: data.role, expectedVersion: a.version, ...(phrase ? { confirm: phrase } : {}) }, toast) });
    if (action === "acct-approve-form") ask(`Approve ${a.displayName}?`, `They become ${this.roleLabel(data.role)}. ${data.role === "SUPER_ADMIN" ? "" : "Give them workspace access next; a role alone opens no workspace."}`, "Approve", `/${a.id}/approve`, "Account approved");
    if (action === "acct-role-form") { if (data.role === a.role) { this.view.toast("That is already the role"); return; } ask(`Change ${a.displayName}'s role?`, `${this.roleLabel(a.role)} → ${this.roleLabel(data.role)}. Their open sessions use the new role from their next action.`, "Change role", `/${a.id}/role`, "Role changed"); }
    if (action === "acct-reactivate-form") ask(`Reactivate ${a.displayName}?`, `They can sign in again as ${this.roleLabel(data.role)}.`, "Reactivate", `/${a.id}/reactivate`, "Account reactivated");
    if (action === "acct-ws-add-form") this.change({ method: "PUT", url: `/${a.id}/workspaces/${data.workspaceId}` }, { role: data.role }, "Workspace access added");
  }
}

window.AccountsPanel = AccountsPanel;
