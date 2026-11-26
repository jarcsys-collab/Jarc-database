// People directory (JARC administration): the profile's "Manage access" tab (Employee Management P3, Access Administration).
// Shown only while /features reports employees.accessAdmin === true (the employee administrator with the switch
// JARC_FEATURE_EMPLOYEE_ACCESS_ADMIN on); everyone else gets no tab, no address and no hint. The server checks again on every
// request (contract P3 §3), so hiding the tab is convenience, not protection.
//
// Address /admin/employees/{ds}/records/{id}/manage. The directory panel (EmployeesPanel) keeps the state in panel.manage and
// calls EmployeeManage.ensure(panel) when the tab is open; EmployeeProfile draws EmployeeManage.html(explorer, state).
//
// API (contract P3 §5, under /api/v1/admin/employees, through the app's adapter, which adds X-CSRF-Token to writes):
//   GET    /:ds/records/:id/manage-access                     the tab's body ({ id, version, account, actions, tokens, workspaces, sharedAccess, warnings })
//   POST   /:ds/records/:id/access                            { action: grant|suspend|restore|revoke, expectedVersion, reason?, confirm? }
//   POST   /:ds/records/:id/memberships                       { workspaceRef, role }
//   PATCH  /:ds/records/:id/memberships/:workspaceRef         { role }
//   DELETE /:ds/records/:id/memberships/:workspaceRef
//   GET    /:ds/records/:id/access-history?limit=&before=     { items, nextBefore }
// Every write answers { manageAccess } (the fresh GET body), which replaces what is drawn; a 409 reloads it.
//
// Rules kept here:
// - Shared access (§6): every membership control says that shared access still gives Workspace admin everywhere, and that removing
//   or demoting a membership only takes away member management and comment moderation. Never "access revoked".
// - No raw IDs: workspaceRef is opaque and never put in the page; controls carry the row's position, and the dialog keeps the ref
//   it was opened with. Every value is escaped; enum values become words only from the lists below. No browser storage.
// - One request at a time: every control is disabled while a write runs (no double submit).
class EmployeeManage {
  static ROLES = { WORKSPACE_ADMIN: "Workspace admin", MEMBER: "Member", VIEWER: "Viewer" };
  static ALL_ROLES = { SYSTEM_ADMIN: "JARC administrator", WORKSPACE_ADMIN: "Workspace admin", MEMBER: "Member", VIEWER: "Viewer" };
  // "disabled": a users.status written outside P3 (shown "Disabled in JARC"); the server allows Restore or Revoke only.
  static STATES = { not_registered: ["Not registered", "no"], active: ["Active", "on"], suspended: ["Suspended", "warn"], revoked: ["Revoked", "off"], disabled: ["Disabled in JARC", "off"] };
  static ACTIONS = ["grant", "restore", "suspend", "revoke"];
  static ACTION_LABELS = { grant: "Grant access", restore: "Restore", suspend: "Suspend", revoke: "Revoke" };
  static MEMBERSHIP_STATUS = { active: "Active", invited: "Invited", removed: "Removed" };
  static ENTRA_REASON = "Disabled in Microsoft Entra ID";
  static SHARED_NOTE = "Shared access still gives Workspace admin in every workspace; removing this membership only removes member management and comment moderation.";
  static CONFIRM_WORD = "REVOKE";
  static HISTORY_LIMIT = 20;
  static DIALOG_WARNINGS = ["LAST_WORKSPACE_ADMIN_OF", "TARGET_JARC_ADMIN", "ADMIN_STATUS_UNKNOWN", "TARGET_GUEST", "EMPLOYEE_ADMIN", "ENTRA_DISABLED_WITH_ACCESS"];
  static MAX_ITEMS = 500;
  // Server reason / rejection codes → words. Any other code is turned into words from its own letters (it is a code, never a value).
  static CODES = {
    SELF_LOCKOUT: "You can't suspend or revoke your own account.",
    WORKSPACE_ADMIN_REQUIRED: "You need a Workspace admin membership in this workspace, or the JARC administrator role, to change its members.",
    ACCOUNT_NOT_ACTIVE: "The JARC account isn't active, so its memberships can't be changed now.",
    ALREADY_MEMBER: "This person already has a membership in this workspace.",
    NOT_MEMBER: "This person has no membership in this workspace any more.",
    WORKSPACE_NOT_FOUND: "This workspace isn't available any more.",
    SELF: "You can't suspend or revoke your own account.",
    LAST_EMPLOYEE_ADMIN: "This is the last active employee administrator.",
    LAST_ADMIN: "This is the workspace's last admin membership.",
    LAST_WORKSPACE_ADMIN: "This is the workspace's last admin membership.",
    LAST_USABLE_WORKSPACE_ADMIN: "This person is the only usable Workspace admin of a workspace. Make someone else an admin of it first.",
    // P4-0: what JARC saw (an active Super Admin, the configured Super Admin, or the role at the person's last sign-in), never a live
    // Microsoft Entra check. The server's own sentence (with the basis) is shown when it sends one.
    TARGET_JARC_ADMIN: "JARC recognises this person as a JARC administrator (a Super Admin, or the JARC administrator role seen at their last sign-in), so their access can't be suspended or revoked here.",
    ADMIN_STATUS_UNKNOWN: "JARC doesn't know whether this person is a JARC administrator: it hasn't recorded a sign-in from them since this check was introduced. They need to sign in to JARC once, or IT can disable them in Microsoft Entra ID (which blocks new sign-ins).",
    REAUTH_REQUIRED: "For security, sign in again to continue this administrator action.",
    INVALID_TRANSITION: "Not possible from the current account state.",
    NOT_REGISTERED: "This person has no JARC account yet.",
    ALREADY_ACTIVE: "The account is already active.",
    CONFLICT: "Changed by someone else.",
    DUPLICATE: "This person already has a membership in this workspace.",
    WORKSPACE_FORBIDDEN: "You need a Workspace admin membership in this workspace, or the JARC administrator role.",
    FORBIDDEN: "You don't have permission for this change.",
    EMPLOYEES_FORBIDDEN: "You don't have permission to manage JARC access.",
    VALIDATION_ERROR: "The request wasn't valid.",
    RATE_LIMITED: "Too many changes in a short time.",
    ENTRA_DISABLED: "Disabled in Microsoft Entra ID."
  };
  static HISTORY_ACTIONS = {
    "employee.access.granted": "Access granted", "employee.access.provisioned": "Account pre-provisioned",
    "employee.access.suspended": "Account suspended", "employee.access.restored": "Account restored", "employee.access.revoked": "Access revoked",
    "employee.membership.added": "Membership added", "employee.membership.role_changed": "Membership role changed", "employee.membership.removed": "Membership removed",
    "employee.access.rejected": "Change refused"
  };
  static ATTEMPTS = { grant: "Grant access", suspend: "Suspend", restore: "Restore", revoke: "Revoke", add: "Add membership", membership_add: "Add membership", role: "Change membership role", membership_role: "Change membership role", remove: "Remove membership", membership_remove: "Remove membership" };
  static FIELDS = { status: "JARC account", role: "Membership role", membership: "Membership", accessVersion: "Version", provisioned: "Provisioned" };
  static LOOKS_LIKE_ID = /\b[0-9a-f]{24}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?=[A-Za-z_-]{0,21}\d)[A-Za-z0-9_-]{22}\b/i;

  // ---- Helpers
  static escape(v) { return String(v ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
  static esc(explorer, v) { return typeof explorer?.esc === "function" ? explorer.esc(v ?? "") : EmployeeManage.escape(v); }
  static attr(explorer, v) { return typeof explorer?.attr === "function" ? explorer.attr(v ?? "") : EmployeeManage.escape(v); }
  static safeDs(explorer) { const ds = String(explorer?.ds ?? ""); return /^[a-z][a-z0-9-]{0,31}$/.test(ds) ? ds : "active"; }
  static obj(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : null; }
  static list(v) { return Array.isArray(v) ? v.slice(0, EmployeeManage.MAX_ITEMS) : []; }
  static str(v, max = 200) { return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : ""; }
  static int(v) { return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null; }
  static word(map, v, unknown = "Unknown") { return typeof v === "string" && Object.hasOwn(map, v) ? map[v] : unknown; }
  static humanize(v) { const s = String(v ?? "").replace(/[_.-]+/g, " ").trim().toLowerCase(); return s ? s[0].toUpperCase() + s.slice(1) : ""; }
  // A server explanation (a code, a sentence, or { code, message }) as safe words; never something that looks like an ID.
  static explain(v, fallback = "") {
    if (EmployeeManage.obj(v)) return EmployeeManage.explain(v.message, "") || EmployeeManage.explain(v.code, fallback);
    if (typeof v !== "string" || !v.trim()) return fallback;
    const t = v.trim();
    if (Object.hasOwn(EmployeeManage.CODES, t)) return EmployeeManage.CODES[t];
    if (/^[A-Z][A-Z0-9_]{1,63}$/.test(t)) return `${EmployeeManage.humanize(t)}.`;
    if (EmployeeManage.LOOKS_LIKE_ID.test(t)) return fallback;
    return t.slice(0, 300);
  }
  static when(value) {
    if (typeof value !== "string" || !value) return null;
    const d = new Date(value); if (Number.isNaN(d.getTime())) return null;
    let text; try { text = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(d); } catch { text = d.toISOString().slice(0, 16).replace("T", " "); }
    return { iso: d.toISOString(), text: `${text} UTC` };
  }
  static timeHtml(explorer, value) { const t = EmployeeManage.when(value); return t ? `<time datetime="${EmployeeManage.attr(explorer, t.iso)}">${EmployeeManage.esc(explorer, t.text)}</time>` : ""; }
  static none(text = "Not recorded") { return `<span class="emp-p__none">${text}</span>`; }
  static badge(text, tone = "") { return `<span class="emp-p__badge emp-a__badge emp-m__badge${tone ? ` emp-a__badge--${tone} emp-m__badge--${tone}` : ""}">${text}</span>`; }
  static row(explorer, label, inner, key = "") { return `<div class="emp-p__row"${key ? ` data-m="${key}"` : ""}><dt class="emp-p__label">${EmployeeManage.esc(explorer, label)}</dt><dd class="emp-p__value">${inner}</dd></div>`; }
  static section(ds, id, title, body, wide = false) {
    return `<section class="emp-p__section emp-a__section emp-m__section${wide ? " emp-a__section--wide" : ""}" aria-labelledby="emp-m-${id}-${ds}"><h3 class="emp-p__section-title" id="emp-m-${id}-${ds}">${title}</h3>${body}</section>`;
  }
  static plural(n, one, many) { return `${n.toLocaleString()} ${n === 1 ? one : many}`; }
  static dis(busy, extra = false) { return busy || extra ? " disabled" : ""; }

  // The parts of a GET body the tab uses, normalised (unknown values dropped).
  static model(d) {
    const acc = EmployeeManage.obj(d?.account) || {};
    const state = typeof acc.state === "string" && Object.hasOwn(EmployeeManage.STATES, acc.state) ? acc.state : null;
    const actions = new Map();
    for (const a of EmployeeManage.list(d?.actions).map(EmployeeManage.obj).filter(Boolean)) if (EmployeeManage.ACTIONS.includes(a.action) && !actions.has(a.action)) actions.set(a.action, { allowed: a.allowed === true, reason: EmployeeManage.explain(a.reason, "") || EmployeeManage.explain(a.code, ""), reasonRequired: a.reasonRequired === true, confirm: a.confirm === EmployeeManage.CONFIRM_WORD, warnings: EmployeeManage.list(a.warnings).map((w) => EmployeeManage.explain(w, "")).filter(Boolean).slice(0, 10) });
    const workspaces = EmployeeManage.list(d?.workspaces).map(EmployeeManage.obj).filter(Boolean).map((w, i) => ({
      index: i, ref: typeof w.workspaceRef === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(w.workspaceRef) ? w.workspaceRef : "",
      name: EmployeeManage.str(w.name, 200) || "Unnamed workspace", membership: EmployeeManage.obj(w.membership),
      sharedRole: typeof w.sharedRole === "string" && Object.hasOwn(EmployeeManage.ALL_ROLES, w.sharedRole) ? w.sharedRole : null,
      effectiveRole: typeof w.effectiveRole === "string" && Object.hasOwn(EmployeeManage.ALL_ROLES, w.effectiveRole) ? w.effectiveRole : null,
      canManage: w.canManage === true, lastAdmin: w.lastAdmin === true
    }));
    const tokens = EmployeeManage.obj(d?.tokens) || {};
    const shared = EmployeeManage.obj(d?.sharedAccess) || {};
    const raw = EmployeeManage.list(d?.warnings);
    const warnings = raw.map((w) => EmployeeManage.explain(w, "")).filter(Boolean).slice(0, 20);
    // Warnings about the person that a suspend / revoke confirmation repeats (codes from the server; any message is escaped).
    const targetWarnings = raw.filter((w) => EmployeeManage.obj(w) && EmployeeManage.DIALOG_WARNINGS.includes(w.code)).map((w) => EmployeeManage.explain(w, "")).filter(Boolean).slice(0, 10);
    const version = Number.isInteger(d?.version) && d.version >= 0 ? d.version : null;
    const snap = EmployeeManage.obj(d?.snapshot) || {};
    const suggested = EmployeeManage.str(acc.suggestedSuspendReason, 200);
    return { acc, state, actions, workspaces, targetWarnings, snapshot: { stale: snap.stale === true, ingestedAt: snap.ingestedAt }, suggested, tokens: { jarc: EmployeeManage.int(tokens.jarcActive), fabric: EmployeeManage.int(tokens.fabricActive) }, shared: { on: shared.on === true, note: EmployeeManage.explain(shared.note, "") }, warnings, version };
  }

  // ---- States
  static stateHtml(explorer, s) {
    const e = (v) => EmployeeManage.esc(explorer, v), a = (v) => EmployeeManage.attr(explorer, v), ds = EmployeeManage.safeDs(explorer);
    const err = s?.error;
    if (err) {
      const [tone, title, retry] = err.kind === "denied" ? ["error", "No access", false] : err.kind === "record" ? ["warn", "Not available", true] : err.kind === "unavailable" ? ["error", "Manage access unavailable", true] : ["error", "Manage access couldn't be loaded", true];
      const ref = typeof err.reference === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(err.reference) ? ` <small class="fx-status__ref">Reference <code>${e(err.reference)}</code></small>` : "";
      const button = retry ? `<span class="fx-status__actions"><button type="button" class="fx-btn" data-action="emp-m-retry" data-ds="${a(ds)}" data-focus-key="emp-m-retry">Try again</button></span>` : "";
      return `<div class="fx-status fx-status--${tone} fx-status--block emp-m__state" role="alert"><span class="fx-status__text"><strong class="emp-state__title">${title}</strong> <span class="emp-state__msg">${e(err.message || "Manage access didn't load.")}</span>${ref}</span>${button}</div>`;
    }
    return `<div class="fx-status fx-status--info emp-m__state" role="status" aria-busy="true"><span class="fx-status__msg">Loading Manage access…</span></div>`;
  }

  // ---- The tab panel's content
  static html(explorer, state) {
    const s = state && typeof state === "object" ? state : {}, d = EmployeeManage.obj(s.data);
    if (!d) return EmployeeManage.stateHtml(explorer, s);
    const e = (v) => EmployeeManage.esc(explorer, v), ds = EmployeeManage.safeDs(explorer), busy = s.busy === true;
    const m = EmployeeManage.model(d), parts = [];
    // The latest outcome (a write's toast is also announced; this stays until the next change), then warnings.
    const n = EmployeeManage.obj(s.notice);
    parts.push(`<div class="emp-m__notice-slot" id="emp-m-notice-${ds}" tabindex="-1">${n ? `<div class="fx-status fx-status--${n.tone === "warn" ? "warn" : n.tone === "error" ? "error" : "ok"} fx-status--block emp-m__notice" role="${n.tone === "error" ? "alert" : "status"}"><span class="fx-status__text"><strong class="emp-state__title">${e(n.title || "")}</strong> <span class="emp-state__msg">${e(n.text || "")}</span>${EmployeeManage.list(n.items).length ? `<ul class="emp-m__warnings">${EmployeeManage.list(n.items).map((t) => `<li>${e(t)}</li>`).join("")}</ul>` : ""}</span><span class="fx-status__actions"><button type="button" class="fx-btn" data-action="emp-m-dismiss" data-ds="${ds}" data-focus-key="emp-m-dismiss"${EmployeeManage.dis(busy)}>Dismiss</button></span></div>` : ""}</div>`);
    if (m.warnings.length) parts.push(`<div class="fx-status fx-status--warn fx-status--block emp-m__server-warnings" role="note"><span class="fx-status__text"><strong class="emp-state__title">Check before changing access</strong><ul class="emp-m__warnings">${m.warnings.map((w) => `<li>${e(w)}</li>`).join("")}</ul></span></div>`);
    // Disabled in Entra but still active in JARC: suggest the manual suspension (§7, no automatic action).
    const suspend = m.actions.get("suspend");
    if (m.snapshot.stale) parts.push(`<div class="fx-status fx-status--warn fx-status--block emp-m__stale" role="status"><span class="fx-status__text">The directory snapshot may be out of date${EmployeeManage.when(m.snapshot.ingestedAt) ? ` (loaded ${EmployeeManage.timeHtml(explorer, m.snapshot.ingestedAt)})` : ""}. Check the person's Microsoft Entra status before changing access.</span></div>`);
    if ((m.acc.entraEnabled === false || m.suggested) && m.state === "active") {
      const can = suspend?.allowed === true;
      parts.push(`<div class="fx-status fx-status--error fx-status--block emp-m__entra" role="alert"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__text"><strong class="emp-state__title">Disabled in Microsoft Entra ID, still active in JARC</strong> <span class="emp-state__msg">Microsoft Entra ID has this account disabled, but the JARC account is active. JARC doesn't suspend it automatically.${can ? "" : suspend?.reason ? ` Suspend isn't available: ${e(suspend.reason)}` : " Suspend isn't available now."}</span></span>${can ? `<span class="fx-status__actions"><button type="button" class="fx-btn fx-btn--danger emp-m__entra-btn" data-action="emp-m-open" data-act="suspend" data-prefill="entra" data-ds="${ds}" data-focus-key="emp-m-entra-suspend"${EmployeeManage.dis(busy)}>Suspend: ${e(m.suggested || EmployeeManage.ENTRA_REASON)}</button></span>` : ""}</div>`);
    }
    const sections = [
      EmployeeManage.section(ds, "account", "JARC account", EmployeeManage.accountHtml(explorer, m, busy)),
      EmployeeManage.section(ds, "workspaces", "Workspaces", EmployeeManage.workspacesHtml(explorer, m, s, busy), true),
      EmployeeManage.section(ds, "history", "Access history", EmployeeManage.historyHtml(explorer, s.history, busy), true)
    ];
    parts.push(`<div class="emp-p__sections emp-m__sections">${sections.join("")}</div>`);
    parts.push(`<p class="emp-p__source">Changes are recorded in the access history. Microsoft Entra ID isn't changed here: people always sign in with Microsoft.</p>`);
    return `<div class="emp-manage" data-state="${e(m.state || "unknown")}"${busy ? ' aria-busy="true"' : ""}>${parts.join("")}</div>`;
  }

  static STATE_NOTES = {
    not_registered: "No JARC account yet. Grant pre-provisions one from the directory record; Revoke blocks a future first sign-in.",
    active: "The person can sign in to JARC. Suspend or Revoke removes their JARC access.",
    suspended: "Suspended: JARC sign-in is refused, their sessions were ended and their API tokens are refused until the account is restored. Memberships are kept.",
    revoked: "Revoked: JARC sign-in is refused and their API tokens were revoked. Memberships are kept but give nothing. Only Grant brings the person back, without their old tokens.",
    disabled: "Disabled in JARC (set outside Employee Management): JARC sign-in is refused. Restore makes the account active; Revoke blocks it for good."
  };
  static accountHtml(explorer, m, busy) {
    const e = (v) => EmployeeManage.esc(explorer, v), ds = EmployeeManage.safeDs(explorer), acc = m.acc, row = (l, i, k) => EmployeeManage.row(explorer, l, i, k);
    const [label, tone] = m.state ? EmployeeManage.STATES[m.state] : ["Unknown", "no"];
    const provisioned = acc.provisioned === true && m.state !== "not_registered";
    const status = `${EmployeeManage.badge(e(label), tone)}${provisioned ? ` ${EmployeeManage.badge("Provisioned (not signed in yet)", "member")}` : ""}`;
    const yn = (v) => (v === true ? `<span class="emp-p__text">Yes</span>` : v === false ? `<span class="emp-p__text">No</span>` : EmployeeManage.none("Unknown"));
    const entra = acc.entraEnabled === true ? `<span class="emp-p__text">Enabled</span>` : acc.entraEnabled === false ? EmployeeManage.badge("Disabled", "off") : EmployeeManage.none("Unknown");
    const tok = (n) => (n === null ? "unknown" : EmployeeManage.plural(n, "active token", "active tokens"));
    const reason = EmployeeManage.str(acc.statusReason, 500), changed = EmployeeManage.timeHtml(explorer, acc.statusChangedAt);
    const rows = [
      row("JARC account", status, "state"),
      m.state === "suspended" || m.state === "revoked" || m.state === "disabled" ? (reason || changed ? row("Reason", `${reason ? `<span class="emp-p__text">${e(reason)}</span>` : ""}${changed ? ` <span class="emp-a__muted">· ${changed}</span>` : ""}`, "reason") : "") : "",
      row("Signed in to JARC now", m.state === "not_registered" ? `<span class="emp-p__text">No</span>` : yn(acc.signedInNow), "now"),
      row("Microsoft Entra sign-in", entra, "entra"),
      row("Employee administrator", yn(acc.isEmployeeAdmin), "admin"),
      // P4-0: the JARC administrator role as JARC last saw it (the server's wording: "seen at their last sign-in" or "unknown").
      EmployeeManage.str(acc.jarcAdministratorLabel) ? row("JARC administrator", `<span class="emp-p__text">${e(EmployeeManage.str(acc.jarcAdministratorLabel))}</span>`, "jarc-admin") : "",
      acc.isSelf === true ? row("Your account", `<span class="emp-p__text">Yes, this is you</span>`, "self") : "",
      m.state === "not_registered" ? "" : row("API tokens", `<span class="emp-p__text">JARC API: ${e(tok(m.tokens.jarc))} · Fabric API: ${e(tok(m.tokens.fabric))}</span>`, "tokens")
    ].join("");
    // The actions the server lists: allowed ones as buttons; refused ones disabled with the server's reason, or hidden without one.
    const buttons = [], whys = [];
    for (const act of EmployeeManage.ACTIONS) {
      const a = m.actions.get(act); if (!a) continue;
      if (!a.allowed && !a.reason) continue;
      const why = !a.allowed ? `emp-m-why-${act}-${ds}` : "";
      const tone = act === "suspend" || act === "revoke" ? " fx-btn--danger" : act === "grant" || act === "restore" ? " fx-btn--primary" : "";
      const text = act === "revoke" && m.state === "not_registered" ? "Revoke (block sign-in)" : EmployeeManage.ACTION_LABELS[act];
      buttons.push(`<button type="button" class="fx-btn${tone} emp-m__act" data-action="emp-m-open" data-act="${act}" data-ds="${ds}" data-focus-key="emp-m-act-${act}"${why ? ` aria-describedby="${why}"` : ""}${EmployeeManage.dis(busy, !a.allowed)}>${e(text)}…</button>`);
      if (why) whys.push(`<li id="${why}" class="emp-m__why"><strong>${e(EmployeeManage.ACTION_LABELS[act])}:</strong> ${e(a.reason)}</li>`);
    }
    const actions = buttons.length ? `<div class="emp-m__actions" role="group" aria-label="Account actions">${buttons.join("")}</div>${whys.length ? `<ul class="emp-m__whys">${whys.join("")}</ul>` : ""}` : `<p class="emp-p__note">No account action is available now.</p>`;
    const note = m.state ? `<p class="emp-p__note emp-m__state-note">${EmployeeManage.STATE_NOTES[m.state]}</p>` : "";
    return `<dl class="emp-p__grid">${rows}</dl>${note}${actions}`;
  }

  static roleOptions(current) {
    const known = Object.hasOwn(EmployeeManage.ROLES, current);
    return `${known ? "" : `<option value="" selected disabled>Other role</option>`}${Object.entries(EmployeeManage.ROLES).map(([v, l]) => `<option value="${v}"${v === current ? " selected" : ""}>${l}</option>`).join("")}`;
  }
  static workspacesHtml(explorer, m, s, busy) {
    const e = (v) => EmployeeManage.esc(explorer, v), ds = EmployeeManage.safeDs(explorer), drafts = EmployeeManage.obj(s.drafts) || {};
    const ws = m.workspaces, inert = m.state === "suspended" || m.state === "revoked" || m.state === "disabled", unregistered = m.state === "not_registered";
    const sharedId = `emp-m-shared-${ds}`, cantId = `emp-m-cant-${ds}`;
    const top = [];
    if (m.shared.on) top.push(`<p class="fx-status fx-status--warn emp-m__shared" id="${sharedId}" role="note"><span class="fx-status__text"><strong>Shared access is on.</strong> ${EmployeeManage.SHARED_NOTE}${m.shared.note && m.shared.note !== EmployeeManage.SHARED_NOTE ? ` <span class="emp-m__shared-extra">${e(m.shared.note)}</span>` : ""}</span></p>`);
    if (inert) top.push(`<p class="emp-p__note emp-m__inert">While the account is ${m.state === "disabled" ? "disabled in JARC" : m.state}, its memberships are kept but give nothing.</p>`);
    if (!ws.length) return `${top.join("")}<p class="emp-p__note">No workspaces were reported.</p>`;
    const anyCant = ws.some((w) => !w.canManage);
    const describe = (extra = "") => { const ids = [m.shared.on ? sharedId : "", extra].filter(Boolean).join(" "); return ids ? ` aria-describedby="${ids}"` : ""; };
    const rows = ws.map((w) => {
      const mem = w.membership, role = mem && typeof mem.role === "string" ? mem.role : "", st = mem && typeof mem.status === "string" ? mem.status : "";
      const lastId = w.lastAdmin ? `emp-m-last-${w.index}-${ds}` : "";
      const blocked = !w.canManage, why = [blocked ? cantId : "", lastId].filter(Boolean).join(" ");
      const draft = typeof drafts[w.index] === "string" && Object.hasOwn(EmployeeManage.ROLES, drafts[w.index]) ? drafts[w.index] : role;
      const name = e(w.name), cell = (label, inner, cls = "") => `<td data-label="${EmployeeManage.attr(explorer, label)}"${cls ? ` class="${cls}"` : ""}>${inner}</td>`;
      let membership, controls;
      if (mem) {
        const statusBadge = st && st !== "active" ? ` ${EmployeeManage.badge(e(EmployeeManage.word(EmployeeManage.MEMBERSHIP_STATUS, st)), "no")}` : "";
        membership = `<label class="emp-m__sr" for="emp-m-role-${w.index}-${ds}">Membership role in ${name}</label><select class="emp-m__select" id="emp-m-role-${w.index}-${ds}" data-action="emp-m-role" data-ws="${w.index}" data-ds="${ds}"${describe(why)}${EmployeeManage.dis(busy, blocked || w.lastAdmin || !w.ref)}>${EmployeeManage.roleOptions(draft)}</select>${statusBadge}`;
        const changed = Object.hasOwn(EmployeeManage.ROLES, draft) && draft !== role;
        controls = `<button type="button" class="fx-btn" data-action="emp-m-change" data-ws="${w.index}" data-ds="${ds}" data-focus-key="emp-m-change-${w.index}"${describe(why)} aria-label="${EmployeeManage.attr(explorer, `Change role in ${w.name}`)}"${EmployeeManage.dis(busy, blocked || w.lastAdmin || !changed || !w.ref)}>Change role…</button><button type="button" class="fx-btn fx-btn--danger" data-action="emp-m-remove" data-ws="${w.index}" data-ds="${ds}" data-focus-key="emp-m-remove-${w.index}"${describe(why)} aria-label="${EmployeeManage.attr(explorer, `Remove membership in ${w.name}`)}"${EmployeeManage.dis(busy, blocked || w.lastAdmin || !w.ref)}>Remove…</button>`;
      } else {
        membership = EmployeeManage.none("None");
        controls = `<span class="emp-a__muted">—</span>`;
      }
      const shared = w.sharedRole ? `<span class="emp-p__text">${e(EmployeeManage.ALL_ROLES[w.sharedRole])}</span>` : EmployeeManage.none("None");
      const effective = w.effectiveRole ? `<span class="emp-p__text">${e(EmployeeManage.ALL_ROLES[w.effectiveRole])}</span>` : EmployeeManage.none("No access");
      const last = w.lastAdmin ? `<p class="emp-m__last" id="${lastId}"><span aria-hidden="true">! </span>Last Workspace admin of this workspace: this membership can't be removed or changed to another role until someone else is Workspace admin. Suspended admins count too.</p>` : "";
      return `<tr class="emp-m__ws${w.lastAdmin ? " is-last" : ""}"><th scope="row" data-label="Workspace"><span class="emp-m__ws-name">${name}</span>${w.lastAdmin ? ` ${EmployeeManage.badge("Last admin", "shared")}` : ""}${last}</th>${cell("Membership", membership, "emp-m__mem")}${cell("Shared role", shared)}${cell("Effective role", effective)}${cell("Change", `<span class="emp-m__controls">${controls}</span>`, "emp-m__ctl")}</tr>`;
    }).join("");
    const table = `<div class="emp-m__table-wrap"><table class="emp-m__table"><caption class="emp-m__sr">Workspaces: explicit membership, shared role and effective role</caption><thead><tr><th scope="col">Workspace</th><th scope="col">Membership</th><th scope="col">Shared role</th><th scope="col">Effective role</th><th scope="col"><span class="emp-m__sr">Change</span></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    const cant = anyCant ? `<p class="emp-p__note" id="${cantId}">Changing a workspace's members needs your own Workspace admin membership there, or the JARC administrator role. Shared access isn't enough.</p>` : "";
    // Add membership: workspaces without a membership that the admin may manage.
    const addable = ws.filter((w) => !w.membership && w.canManage && w.ref);
    let add;
    if (unregistered) add = `<p class="emp-p__note">Grant access first: memberships need a JARC account.</p>`;
    else if (!addable.length) add = `<p class="emp-p__note">No other workspace to add: each one you can manage already has a membership for this person.</p>`;
    else add = `<form class="emp-m__add" data-action="emp-m-add-form" data-ds="${ds}" aria-labelledby="emp-m-add-title-${ds}" novalidate><h4 class="emp-m__add-title" id="emp-m-add-title-${ds}">Add membership</h4><label class="emp-m__field"><span>Workspace</span><select class="emp-m__select" name="ws" id="emp-m-add-ws-${ds}"${describe()}${EmployeeManage.dis(busy)}>${addable.map((w) => `<option value="${w.index}">${e(w.name)}</option>`).join("")}</select></label><label class="emp-m__field"><span>Role</span><select class="emp-m__select" name="role" id="emp-m-add-role-${ds}"${describe()}${EmployeeManage.dis(busy)}>${EmployeeManage.roleOptions("VIEWER")}</select></label><button type="submit" class="fx-btn" data-focus-key="emp-m-add"${describe()}${EmployeeManage.dis(busy)}>Add membership…</button></form>`;
    return `${top.join("")}${table}${cant}${add}`;
  }

  static historyHtml(explorer, h, busy) {
    const e = (v) => EmployeeManage.esc(explorer, v), ds = EmployeeManage.safeDs(explorer), s = EmployeeManage.obj(h) || {};
    const items = EmployeeManage.list(s.items).map(EmployeeManage.obj).filter(Boolean);
    if (!items.length) {
      if (s.error) return `<div class="fx-status fx-status--error emp-m__hist-state" role="alert"><span class="fx-status__text">${e(s.error.message || "The access history didn't load.")}</span><span class="fx-status__actions"><button type="button" class="fx-btn" data-action="emp-m-history-retry" data-ds="${ds}" data-focus-key="emp-m-history-retry">Try again</button></span></div>`;
      if (s.loading || !s.loaded) return `<p class="emp-p__note" role="status" aria-busy="true">Loading the access history…</p>`;
      return `<p class="emp-p__note">No access changes recorded yet.</p>`;
    }
    const rows = items.map((it) => {
      const rejected = it.result === "rejected" || it.action === "employee.access.rejected";
      const label = EmployeeManage.HISTORY_ACTIONS[it.action] || (typeof it.action === "string" && /^[a-z][a-z._]{1,80}$/.test(it.action) ? EmployeeManage.humanize(it.action.split(".").slice(-2).join(" ")) : "Change");
      const attempted = rejected && typeof it.attempted === "string" && Object.hasOwn(EmployeeManage.ATTEMPTS, it.attempted) ? ` · ${EmployeeManage.ATTEMPTS[it.attempted]}` : "";
      const result = rejected ? EmployeeManage.badge("Refused", "off") : EmployeeManage.badge("Done", "on");
      const actor = EmployeeManage.str(it.actor, 200) && !EmployeeManage.LOOKS_LIKE_ID.test(it.actor) ? it.actor.trim().slice(0, 200) : "Unknown";
      const changes = EmployeeManage.list(it.changes).map(EmployeeManage.obj).filter(Boolean).slice(0, 10).map((c) => {
        const field = typeof c.field === "string" && Object.hasOwn(EmployeeManage.FIELDS, c.field) ? EmployeeManage.FIELDS[c.field] : typeof c.field === "string" && /^[a-zA-Z][a-zA-Z_]{0,40}$/.test(c.field) ? EmployeeManage.humanize(c.field) : "Value";
        return `<li><span class="emp-m__hist-field">${e(field)}:</span> ${e(EmployeeManage.value(c.from))} <span aria-hidden="true">→</span><span class="emp-m__sr"> to </span> ${e(EmployeeManage.value(c.to))}</li>`;
      }).join("");
      const ws = EmployeeManage.str(it.workspace, 200), reason = EmployeeManage.str(it.reason, 500), code = rejected ? EmployeeManage.explain(it.code, "") : "";
      return `<li class="emp-m__hist${rejected ? " is-rejected" : ""}"><div class="emp-m__hist-head"><span class="emp-m__hist-action">${e(label + attempted)}</span>${result}<span class="emp-a__muted emp-m__hist-time">${EmployeeManage.timeHtml(explorer, it.at) || "Time not recorded"}</span></div><div class="emp-m__hist-meta"><span>By ${e(actor)}</span>${ws ? `<span>Workspace: ${e(ws)}</span>` : ""}</div>${changes ? `<ul class="emp-m__hist-changes">${changes}</ul>` : ""}${reason ? `<p class="emp-m__hist-reason">Reason: “${e(reason)}”</p>` : ""}${code ? `<p class="emp-m__hist-code">Refused: ${e(code)}</p>` : ""}</li>`;
    }).join("");
    const more = s.next ? `<button type="button" class="fx-btn emp-m__more" data-action="emp-m-history-more" data-ds="${ds}" data-focus-key="emp-m-history-more"${EmployeeManage.dis(busy || s.loading)}>${s.loading ? "Loading…" : "Load more"}</button>` : "";
    const err = s.error ? `<p class="emp-m__hist-error" role="alert">${e(s.error.message || "More history didn't load.")}</p>` : "";
    return `<p class="emp-p__note emp-m__hist-lead">Newest first.</p><ol class="emp-m__history">${rows}</ol>${err}${more}`;
  }
  // A from / to value: roles and states in words; anything that looks like an ID is withheld.
  static value(v) {
    if (v === null || v === undefined || v === "") return "none";
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v !== "string") return "—";
    if (Object.hasOwn(EmployeeManage.ALL_ROLES, v)) return EmployeeManage.ALL_ROLES[v];
    if (Object.hasOwn(EmployeeManage.STATES, v)) return EmployeeManage.STATES[v][0];
    if (v === "disabled") return "Disabled in JARC";
    if (EmployeeManage.LOOKS_LIKE_ID.test(v)) return "—";
    return v.slice(0, 120);
  }

  // =====================================================================================================================
  // ---- Controller (state in panel.manage; the panel is EmployeesPanel)
  static slot() { return { key: null, data: null, loading: false, error: null, seq: 0, busy: false, notice: null, drafts: {}, dialog: null, history: EmployeeManage.historySlot() }; }
  static historySlot() { return { key: null, items: [], next: null, loading: false, loaded: false, error: null, seq: 0 }; }
  static base(x) { return `/admin/employees/${encodeURIComponent(x.ds)}/records/${encodeURIComponent(x.recordId)}`; }
  static path(x) { return `${EmployeeManage.base(x)}/manage-access`; }
  static ensure(p, { keep = false } = {}) {
    const x = p.explorer;
    if (!x?.recordId || p.profileTabFor(x) !== "manage") return;
    const path = EmployeeManage.path(x);
    if (!p.manage || p.manage.key !== path) { p.manage = EmployeeManage.slot(); }
    const s = p.manage;
    if (s.key === path && !keep) return;
    EmployeeManage.load(p, x, s, path, keep && s.key === path);
  }
  static info(error, read = true) {
    const status = error?.cause?.status, server = error?.cause?.serverCode || null, code = server || error?.code || "INTERNAL_ERROR";
    const reference = typeof error?.requestId === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(error.requestId) ? error.requestId : "";
    const st = Number.isInteger(status) ? status : ({ FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, RATE_LIMITED: 429, SERVICE_UNAVAILABLE: 503, VALIDATION_ERROR: 400 }[error?.code] ?? null);
    const base = { status: st, code, reference };
    if (code === "UNAUTHENTICATED" || st === 401) return { ...base, kind: "generic", message: "Your session has ended. Sign in again to continue." };
    if (code === "OFFLINE") return { ...base, kind: "generic", message: "Can't reach the JARC server. Check your connection, then try again." };
    // P4-0: the administrator sign-in is too old for this write; the app's toast offers "Sign in again" (AppController).
    if (code === "REAUTH_REQUIRED") return { ...base, kind: "generic", message: EmployeeManage.CODES.REAUTH_REQUIRED };
    if (st === 403) return { ...base, kind: "denied", message: code === "EMPLOYEES_FORBIDDEN" || read ? "You don't have permission to manage JARC access." : (EmployeeManage.CODES[code] || "You don't have permission for this change.") };
    if (st === 413) return { ...base, kind: "generic", message: "The request was too large. Shorten the reason, then try again." };
    if (st === 404) return { ...base, kind: "record", message: read ? "Manage access isn't available for this person: they aren't in this list, or the feature was turned off." : `${code === "WORKSPACE_NOT_FOUND" || code === "NOT_MEMBER" ? EmployeeManage.CODES[code] : "This person or workspace isn't available any more, or Manage access was turned off."} Reloaded.` };
    if (st === 429) return { ...base, kind: "generic", message: "Too many requests in a short time. Wait a minute, then try again." };
    if (st === 503 || code === "SERVICE_UNAVAILABLE" || code === "EMPLOYEES_UNAVAILABLE") return { ...base, kind: "unavailable", message: "JARC access administration is temporarily unavailable. Try again in a few minutes." };
    if (st === 400) return { ...base, kind: "generic", message: "The change wasn't accepted. Check the reason (3 to 500 characters, no line breaks) and the confirmation, then try again." };
    if (st === 409) {
      const msg = code === "LAST_EMPLOYEE_ADMIN" ? "This is the last active employee administrator, so the account can't be suspended or revoked."
        : code === "LAST_WORKSPACE_ADMIN" || code === "LAST_ADMIN" ? "This is the workspace's last admin membership, so it can't be removed or demoted."
        : code === "ALREADY_MEMBER" || /DUPLICATE|EXISTS/.test(code) ? "This person already has a membership in this workspace."
        : code === "NOT_REGISTERED" ? "This person has no JARC account yet: grant access first."
        : code === "ACCOUNT_NOT_ACTIVE" ? "The JARC account isn't active, so its memberships can't be changed now."
        : code === "LAST_USABLE_WORKSPACE_ADMIN" || code === "TARGET_JARC_ADMIN" || code === "ADMIN_STATUS_UNKNOWN" ? EmployeeManage.CODES[code]
        : "Changed by someone else.";
      return { ...base, kind: "conflict", message: `${msg} Reloaded: check the current state, then try again.` };
    }
    return { ...base, kind: "generic", message: read ? "Manage access didn't load. Try again in a moment." : "The change didn't go through. Try again in a moment." };
  }
  static async load(p, x, s, path, keep) {
    const seq = ++s.seq;
    if (!keep) s.data = null;
    s.key = path; s.loading = true; s.error = null; p.redraw();
    try { const data = await p.adapter.request("GET", path); if (s.seq !== seq) return; s.data = EmployeeManage.obj(data); if (!s.data) s.error = { kind: "generic", code: "INTERNAL_ERROR", message: "Manage access didn't load. Try again in a moment.", reference: "", status: null }; }
    catch (error) { if (s.seq !== seq) return; s.data = null; s.error = EmployeeManage.info(error, true); }
    finally { if (s.seq === seq) s.loading = false; }
    if (p.denied || p.manage !== s) return;
    p.redraw();
    p.announce(s.error ? "Manage access couldn't be loaded." : "Manage access loaded.");
    if (s.data && !s.history.loaded && !s.history.loading) EmployeeManage.loadHistory(p, x, s, { reset: true });
  }
  static async loadHistory(p, x, s, { reset = false } = {}) {
    if (!x?.recordId) return;
    if (reset) s.history = EmployeeManage.historySlot();
    const h = s.history, seq = ++h.seq;
    const q = new URLSearchParams({ limit: String(EmployeeManage.HISTORY_LIMIT) });
    if (!reset && typeof h.next === "string" && h.next) q.set("before", h.next);
    h.loading = true; h.error = null; p.redraw();
    try {
      const res = await p.adapter.request("GET", `${EmployeeManage.base(x)}/access-history?${q}`);
      if (h.seq !== seq || s.history !== h) return;
      const items = EmployeeManage.list(res?.items).map(EmployeeManage.obj).filter(Boolean);
      h.items = [...h.items, ...items].slice(0, EmployeeManage.MAX_ITEMS);
      h.next = typeof res?.nextBefore === "string" && res.nextBefore && res.nextBefore.length <= 512 && h.items.length < EmployeeManage.MAX_ITEMS ? res.nextBefore : null;
      h.loaded = true;
    } catch (error) { if (h.seq !== seq || s.history !== h) return; h.error = EmployeeManage.info(error, true); h.loaded = true; }
    finally { if (h.seq === seq) h.loading = false; }
    if (p.denied || p.manage !== s) return;
    p.redraw();
  }

  // ---- Dialogs (fx-dialog in #overlay-root: AppController handles Escape, outside clicks, the focus trap and focus return)
  static view(p) { return p?.c?.view; }
  static openDialog(p, spec) {
    const s = p.manage, x = p.explorer, view = EmployeeManage.view(p);
    if (!s?.data || s.busy || !x?.recordId || typeof view?.overlay !== "function") return false;
    s.dialog = { ...spec, error: spec.error || "" };
    EmployeeManage.drawDialog(p);
    return true;
  }
  static dialogText(p, d) {
    const t = EmployeeManage.dialogBase(p, d); if (!t || d.kind !== "account") return t;
    // The server's per-action hints win: reasonRequired and confirm ("REVOKE").
    const m = EmployeeManage.model(p.manage.data), a = m.actions.get(d.act);
    if (a?.reasonRequired) t.reason = "required";
    if (a?.confirm) t.confirm = true;
    // Suspend / revoke: the action's own warnings (e.g. last Workspace admin of …, a JARC administrator, a guest) and the
    // matching account warnings, once each.
    if (d.act === "suspend" || d.act === "revoke") t.warnings = [...new Set([...(a?.warnings || []), ...m.targetWarnings])].slice(0, 10);
    else if (a?.warnings?.length) t.warnings = a.warnings;
    return t;
  }
  static dialogBase(p, d) {
    const m = EmployeeManage.model(p.manage.data), shared = m.shared.on;
    const name = EmployeeManage.str(p.explorer?.record?.data?.values?.displayName, 200) || "this person";
    const tok = (n) => (n === null ? "" : ` (${EmployeeManage.plural(n, "active token", "active tokens")})`);
    if (d.kind === "account") {
      if (d.act === "suspend") return { title: `Suspend ${name}?`, lead: ["Their JARC sessions end now, and JARC sign-in is refused until the account is restored.", `Their JARC API${tok(m.tokens.jarc)} and Fabric API${tok(m.tokens.fabric)} tokens are refused while suspended. They aren't revoked: Restore makes them usable again.`, "Memberships are kept."], reason: "required", submit: "Suspend account", danger: true };
      if (d.act === "restore" && m.state === "disabled") return { title: `Restore ${name}?`, lead: ["The JARC account was disabled outside Employee Management. Restore makes it active: the person can sign in to JARC again.", `Their existing API tokens become usable again: JARC API${tok(m.tokens.jarc)} and Fabric API${tok(m.tokens.fabric)}.`], reason: "optional", submit: "Restore account" };
      if (d.act === "restore") return { title: `Restore ${name}?`, lead: ["The person can sign in to JARC again.", `Their existing API tokens become usable again: JARC API${tok(m.tokens.jarc)} and Fabric API${tok(m.tokens.fabric)}.`, ...(shared ? ["With shared access on, they are Workspace admin in every workspace again."] : [])], reason: "optional", submit: "Restore account" };
      if (d.act === "revoke") {
        if (m.state === "not_registered") return { title: `Block ${name} from JARC?`, lead: ["This records a revoked JARC account before their first sign-in, so a later Microsoft sign-in is refused instead of creating an account.", "Only Grant lets them in later."], reason: "required", confirm: true, submit: "Revoke access", danger: true };
        return { title: `Revoke ${name}'s JARC access?`, lead: ["Their JARC sessions end now and JARC sign-in is refused.", `Their active API tokens are revoked: JARC API${tok(m.tokens.jarc)} and Fabric API${tok(m.tokens.fabric)}. A later Grant doesn't bring them back.`, "Memberships are kept but give nothing while revoked.", "To come back they need Grant; old tokens stay revoked."], reason: "required", confirm: true, submit: "Revoke access", danger: true };
      }
      if (d.act === "grant") {
        if (m.state === "revoked") return { title: `Grant ${name} JARC access again?`, lead: ["The JARC account becomes active again and they can sign in with Microsoft.", "Their old API tokens stay revoked. Their kept memberships apply again.", ...(shared ? ["With shared access on, they are Workspace admin in every workspace."] : [])], reason: "optional", submit: "Grant access" };
        return { title: `Grant ${name} JARC access?`, lead: ["This pre-provisions a JARC account from their directory record. Nothing is sent to them.", "They still sign in with Microsoft (Entra ID); their first sign-in uses this account.", ...(shared ? ["Shared access is on: from their first sign-in they will have Workspace admin in every workspace."] : [])], reason: "optional", submit: "Grant access" };
      }
    }
    const ws = d.name || "this workspace", note = shared ? [EmployeeManage.SHARED_NOTE] : [];
    if (d.kind === "add") return { title: `Add a membership in ${ws}?`, lead: [`${name} becomes ${EmployeeManage.ROLES[d.role]} in ${ws} through a membership.`, ...(shared ? ["Shared access already gives Workspace admin in every workspace; a Workspace admin membership also allows member management and comment moderation."] : [])], submit: "Add membership" };
    if (d.kind === "role") return { title: `Change the role in ${ws}?`, lead: [`Membership role: ${EmployeeManage.ROLES[d.from] || "Other role"} → ${EmployeeManage.ROLES[d.role]}.`, ...note], submit: "Change role" };
    if (d.kind === "remove") return { title: `Remove the membership in ${ws}?`, lead: [`${name}'s ${EmployeeManage.ROLES[d.from] || ""} membership in ${ws} is removed.`.replace("  ", " "), ...(shared ? note : ["Without shared access, they lose access to this workspace unless the JARC administrator role gives it."])], submit: "Remove membership", danger: true };
    return null;
  }
  static drawDialog(p) {
    const s = p.manage, d = s?.dialog, x = p.explorer, view = EmployeeManage.view(p);
    if (!d || !x || typeof view?.overlay !== "function") return;
    const t = EmployeeManage.dialogText(p, d); if (!t) return;
    const e = (v) => EmployeeManage.esc(x, v), a = (v) => EmployeeManage.attr(x, v), busy = s.busy === true;
    const reasonValue = typeof d.reason === "string" ? d.reason : d.prefill === "entra" ? (EmployeeManage.model(s.data).suggested || EmployeeManage.ENTRA_REASON) : "";
    const fields = [];
    if (t.reason) fields.push(`<label class="emp-m__dfield" for="emp-m-d-reason"><span class="fx-field__label">Reason${t.reason === "required" ? "" : " (optional)"}</span><input class="fx-input emp-m__input" id="emp-m-d-reason" name="reason" type="text" maxlength="500" autocomplete="off" value="${a(reasonValue)}"${t.reason === "required" ? ' required aria-required="true"' : ""} aria-describedby="emp-m-d-reason-hint emp-m-d-error"${d.invalid === "reason" ? ' aria-invalid="true"' : ""}${busy ? " readonly" : ""}></label><small class="fx-api__hint" id="emp-m-d-reason-hint">3 to 500 characters, kept in the access history.</small>`);
    if (t.confirm) fields.push(`<label class="emp-m__dfield" for="emp-m-d-confirm"><span class="fx-field__label">Type <strong>${EmployeeManage.CONFIRM_WORD}</strong> to confirm</span><input class="fx-input emp-m__input" id="emp-m-d-confirm" name="confirm" type="text" maxlength="20" autocomplete="off" spellcheck="false" autocapitalize="characters" value="${a(typeof d.confirm === "string" ? d.confirm : "")}" required aria-required="true" aria-describedby="emp-m-d-error"${d.invalid === "confirm" ? ' aria-invalid="true"' : ""}${busy ? " readonly" : ""}></label>`);
    const returnKey = d.returnKey && /^[A-Za-z0-9_-]{1,100}$/.test(d.returnKey) ? d.returnKey : "";
    const html = `<form class="fx-dialog emp-m-dialog" role="dialog" aria-modal="true" data-kind="${a(d.kind)}" aria-labelledby="emp-m-d-title" aria-describedby="emp-m-d-lead" data-return-focus-key="${a(returnKey)}"${busy ? ' aria-busy="true" data-keep-open="1"' : ""} novalidate>
      <div class="fx-dialog__head"><h2 class="fx-dialog__title" id="emp-m-d-title"><span class="fx-dialog__eyebrow">Manage access</span>${e(t.title)}</h2><button type="button" class="fx-btn fx-btn--icon" data-action="close-overlay" aria-label="Close"${busy ? " disabled" : ""}>×</button></div>
      <div class="fx-dialog__body"><div id="emp-m-d-lead" class="emp-m__dlead">${t.lead.map((l) => `<p>${e(l)}</p>`).join("")}</div>${t.warnings?.length ? `<div class="fx-status fx-status--warn emp-m__dwarn" role="note"><span class="fx-status__text"><strong>Check first</strong><ul class="emp-m__warnings">${t.warnings.map((w) => `<li>${e(w)}</li>`).join("")}</ul></span></div>` : ""}${fields.join("")}<p class="fx-api-dialog__error emp-m__derror" id="emp-m-d-error" role="alert">${e(d.error || "")}</p></div>
      <div class="fx-dialog__foot"><button type="button" class="fx-btn" data-action="close-overlay" data-m-cancel${busy ? " disabled" : ""}>Cancel</button><button type="submit" class="fx-btn ${t.danger ? "fx-btn--danger" : "fx-btn--primary"}"${busy ? ' disabled aria-busy="true"' : ""}>${busy ? "Working…" : e(t.submit)}</button></div></form>`;
    // The overlay root is replaced whole: keep the caret / typed text when redrawing an open dialog (busy, error).
    view.overlay(html, "apitok-overlay fx-api-overlay emp-m-overlay");
    if (typeof document === "undefined") return;
    EmployeeManage.bind(p);
    const focus = d.invalid === "confirm" ? "#emp-m-d-confirm" : d.invalid === "reason" || (t.reason === "required" && !reasonValue) ? "#emp-m-d-reason" : t.confirm ? "#emp-m-d-confirm" : busy ? "#emp-m-d-title" : t.danger ? "[data-m-cancel]" : "button[type='submit']";
    const el = document.querySelector(`#overlay-root .emp-m-dialog ${focus}`);
    if (el && focus === "#emp-m-d-title") el.setAttribute("tabindex", "-1");
    el?.focus?.();
  }
  // The dialog answers its own submit and typing (the overlay sits outside #employees-root, so the app's handlers don't route it
  // here: the app only prevents the default submit). A second submit while one runs is ignored (s.busy).
  static bind(p) {
    const form = document.querySelector?.("#overlay-root .emp-m-dialog");
    if (!form?.addEventListener) return;
    // Clicks and submits stop here: the app's own click handler would treat the dialog as an unknown action (with no workspace
    // it opens "Create workspace"). Cancel and × close through the view (AppController's closeOverlay returns focus).
    form.addEventListener("click", (event) => {
      event.stopPropagation?.();
      const close = event.target?.closest?.('[data-action="close-overlay"]');
      if (close && form.contains(close) && !p.manage?.busy) EmployeeManage.view(p)?.closeOverlay?.();
    });
    form.addEventListener("submit", (event) => { event.preventDefault?.(); event.stopPropagation?.(); EmployeeManage.submit(p, form); });
    form.addEventListener("input", (event) => EmployeeManage.onInput(p, event.target));
  }
  static closeDialog(p, focusKey = "") {
    const s = p.manage, d = s?.dialog;
    if (s) s.dialog = null;
    const view = EmployeeManage.view(p);
    if (typeof document !== "undefined" && document.querySelector?.("#overlay-root .emp-m-dialog")) view?.closeOverlay?.();
    p.redraw();
    if (typeof document === "undefined" || typeof setTimeout !== "function") return;
    const ds = EmployeeManage.safeDs(p.explorer);
    setTimeout(() => {
      const key = focusKey || d?.returnKey || "";
      const el = (key && document.querySelector?.(`#employees-body [data-focus-key="${key}"]:not(:disabled)`)) || document.querySelector?.(`#emp-m-notice-${ds}`) || document.querySelector?.(`#emp-p-tab-manage-${ds}`);
      el?.focus?.({ preventScroll: false });
    }, 0);
  }

  // Reads and checks the dialog's fields; returns the request or null (the dialog then shows why).
  static validate(p, form) {
    const s = p.manage, d = s.dialog, t = EmployeeManage.dialogText(p, d);
    const reason = String(form?.elements?.reason?.value ?? d.reason ?? "").trim(), confirm = String(form?.elements?.confirm?.value ?? d.confirm ?? "").trim();
    d.reason = form?.elements?.reason ? String(form.elements.reason.value) : d.reason; d.confirm = form?.elements?.confirm ? String(form.elements.confirm.value) : d.confirm; d.invalid = "";
    if (t.reason && (reason || t.reason === "required")) {
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(reason)) { d.invalid = "reason"; d.error = "The reason can't contain line breaks or control characters."; return null; }
      if (reason.length < 3 || reason.length > 500) { d.invalid = "reason"; d.error = t.reason === "required" ? "Give a reason of 3 to 500 characters." : "A reason needs 3 to 500 characters (or leave it empty)."; return null; }
    }
    if (t.confirm && confirm !== EmployeeManage.CONFIRM_WORD) { d.invalid = "confirm"; d.error = `Type ${EmployeeManage.CONFIRM_WORD} in capital letters to confirm.`; return null; }
    const x = p.explorer, base = EmployeeManage.base(x), m = EmployeeManage.model(s.data);
    if (d.kind === "account") {
      // expectedState and expectedVersion come from the last GET: a change by someone else meanwhile is a 409 (then reloaded).
      const body = { action: d.act, expectedVersion: m.version ?? 0, ...(m.state ? { expectedState: m.state } : {}) };
      if (t.reason && reason) body.reason = reason;
      if (t.confirm) body.confirm = confirm;
      return { method: "POST", path: `${base}/access`, body };
    }
    if (!d.ref) { d.error = "This workspace can't be changed here."; return null; }
    if (d.kind === "add") return { method: "POST", path: `${base}/memberships`, body: { workspaceRef: d.ref, role: d.role } };
    if (d.kind === "role") return { method: "PATCH", path: `${base}/memberships/${encodeURIComponent(d.ref)}`, body: { role: d.role } };
    if (d.kind === "remove") return { method: "DELETE", path: `${base}/memberships/${encodeURIComponent(d.ref)}` };
    return null;
  }
  static DONE = {
    grant: "Access granted", restore: "Account restored", suspend: "Account suspended", revoke: "Access revoked",
    add: "Membership added", role: "Membership role changed", remove: "Membership removed"
  };
  static async submit(p, form) {
    const s = p.manage, d = s?.dialog, x = p.explorer;
    if (!d || s.busy || !x?.recordId) return;
    const req = EmployeeManage.validate(p, form);
    if (!req) { EmployeeManage.drawDialog(p); p.announce(d.error); return; }
    const key = s.key, view = EmployeeManage.view(p);
    s.busy = true; d.error = ""; EmployeeManage.drawDialog(p); p.redraw();
    let res = null, failure = null;
    try { res = await p.adapter.request(req.method, req.path, req.body); }
    catch (error) { failure = EmployeeManage.info(error, false); }
    s.busy = false;
    if (p.manage !== s || s.key !== key) { if (typeof document !== "undefined" && document.querySelector?.("#overlay-root .emp-m-dialog")) view?.closeOverlay?.(); return; } // another profile opened meanwhile
    if (failure) {
      if (failure.kind === "conflict" || failure.status === 404) {
        s.notice = { tone: "warn", title: failure.kind === "conflict" ? "Not changed" : "Not available", text: failure.message };
        s.drafts = {};
        EmployeeManage.closeDialog(p);
        view?.toast?.(failure.kind === "conflict" ? "Changed by someone else, reloaded" : "Not available, reloaded");
        p.announce(failure.message);
        EmployeeManage.load(p, x, s, key, true);
        EmployeeManage.loadHistory(p, x, s, { reset: true });
        return;
      }
      d.error = failure.message + (failure.reference ? ` Reference ${failure.reference}.` : "");
      EmployeeManage.drawDialog(p); p.redraw(); p.announce(failure.message);
      return;
    }
    const fresh = EmployeeManage.obj(res?.manageAccess) || (EmployeeManage.obj(res) && Array.isArray(res.actions) ? res : null);
    const op = d.kind === "account" ? d.act : d.kind, done = EmployeeManage.DONE[op] || "Changed";
    const warnings = EmployeeManage.list(res?.warnings).map((w) => EmployeeManage.explain(w, "")).filter(Boolean).slice(0, 10);
    const tokenText = op === "revoke" ? EmployeeManage.revokedTokens(res) : "";
    s.notice = { tone: warnings.length ? "warn" : "ok", title: done, text: [EmployeeManage.noticeText(op, EmployeeManage.model(fresh || s.data).shared.on), tokenText].filter(Boolean).join(" "), items: warnings };
    s.drafts = {};
    if (fresh) { s.data = fresh; s.error = null; }
    EmployeeManage.closeDialog(p);
    view?.toast?.(done);
    p.announce(`${done}.`);
    EmployeeManage.afterWrite(p, x);
    if (!fresh) EmployeeManage.load(p, x, s, key, true);
    EmployeeManage.loadHistory(p, x, s, { reset: true });
  }
  static noticeText(op, shared = false) {
    return {
      grant: "The JARC account is active. They sign in with Microsoft.",
      restore: "They can sign in to JARC again, and their existing API tokens work again.",
      suspend: "Their sessions were ended; JARC sign-in and their API tokens are refused until restored.",
      revoke: "Their sessions were ended and JARC sign-in is refused. Memberships are kept but give nothing; Grant is needed to come back.",
      add: "The membership was added.", role: "The membership role was changed.",
      remove: shared ? "The membership was removed. Shared access is on, so they still have Workspace admin through shared access." : "The membership was removed."
    }[op] || "";
  }
  // What the revoke answer says about tokens: result.tokensRevoked { jarc, fabric } (counts); the older shape
  // tokens { jarcRevoked, fabricRevoked, jarcRefused, fabricRefused } is read too.
  static revokedTokens(res) {
    const r = EmployeeManage.obj(EmployeeManage.obj(res?.result)?.tokensRevoked);
    if (r) {
      const parts = [["jarc", "JARC API"], ["fabric", "Fabric API"]].map(([k, l]) => [EmployeeManage.int(r[k]), l]).filter(([n]) => n !== null).map(([n, l]) => `${l}: ${EmployeeManage.plural(n, "token", "tokens")} revoked`);
      return parts.length ? `${parts.join("; ")}.` : "";
    }
    const t = EmployeeManage.obj(res?.tokens); if (!t) return "";
    const n = (k) => EmployeeManage.int(t[k]);
    const parts = [];
    for (const [k, label] of [["jarc", "JARC API"], ["fabric", "Fabric API"]]) {
      const rev = n(`${k}Revoked`), ref = n(`${k}Refused`);
      if (rev) parts.push(`${label}: ${EmployeeManage.plural(rev, "token", "tokens")} revoked`);
      if (ref) parts.push(`${label}: ${EmployeeManage.plural(ref, "token", "tokens")} refused (not revoked)`);
    }
    return parts.length ? `${parts.join("; ")}.` : "";
  }
  // The P2 tab and the list's JARC columns read the refreshed access index: drop what they hold so they load again.
  static afterWrite(p, x) {
    if (p.access) p.access.key = null;
    try { if (x?.records) x.records.key = null; } catch { /* not an explorer */ }
  }

  // ---- Events (the panel forwards emp-m-* clicks, changes and submits, from the tab and from the dialog)
  static wsAt(p, target) {
    const i = Number(target?.dataset?.ws ?? target?.value);
    const m = p.manage?.data ? EmployeeManage.model(p.manage.data) : null;
    return m && Number.isInteger(i) && i >= 0 ? m.workspaces[i] || null : null;
  }
  static focusKeyOf(target) { const k = target?.dataset?.focusKey || ""; return /^[A-Za-z0-9_-]{1,100}$/.test(k) ? k : ""; }
  static onAction(p, action, target) {
    const s = p.manage;
    if (action === "emp-m-retry") { if (s) s.key = null; EmployeeManage.ensure(p); return true; }
    if (action === "emp-m-history-retry" || action === "emp-m-history-more") {
      if (!s?.data || s.history.loading) return true;
      EmployeeManage.loadHistory(p, p.explorer, s, { reset: action === "emp-m-history-retry" && !s.history.items.length });
      return true;
    }
    if (action === "emp-m-dismiss") { if (s) s.notice = null; p.redraw(); const el = typeof document !== "undefined" ? document.querySelector?.(`#emp-m-notice-${EmployeeManage.safeDs(p.explorer)}`) : null; el?.focus?.(); return true; }
    if (!s?.data || s.busy) return true;
    const m = EmployeeManage.model(s.data);
    if (action === "emp-m-open") {
      const act = String(target?.dataset?.act || "");
      if (!EmployeeManage.ACTIONS.includes(act) || m.actions.get(act)?.allowed !== true) return true;
      EmployeeManage.openDialog(p, { kind: "account", act, prefill: target?.dataset?.prefill === "entra" ? "entra" : "", returnKey: EmployeeManage.focusKeyOf(target) });
      return true;
    }
    if (action === "emp-m-change" || action === "emp-m-remove") {
      const w = EmployeeManage.wsAt(p, target);
      if (!w?.membership || !w.canManage || w.lastAdmin || !w.ref) return true;
      const from = typeof w.membership.role === "string" ? w.membership.role : "";
      if (action === "emp-m-remove") { EmployeeManage.openDialog(p, { kind: "remove", ref: w.ref, name: w.name, from, returnKey: EmployeeManage.focusKeyOf(target) }); return true; }
      const role = s.drafts?.[w.index];
      if (!Object.hasOwn(EmployeeManage.ROLES, role) || role === from) return true;
      EmployeeManage.openDialog(p, { kind: "role", ref: w.ref, name: w.name, from, role, returnKey: `emp-m-change-${w.index}` });
      return true;
    }
    return false;
  }
  static onChange(p, target) {
    const s = p.manage;
    if (target?.dataset?.action !== "emp-m-role" || !s?.data || s.busy) return false;
    const w = EmployeeManage.wsAt(p, target); if (!w) return true;
    const role = String(target.value || "");
    if (!Object.hasOwn(EmployeeManage.ROLES, role)) return true;
    s.drafts = { ...(s.drafts || {}), [w.index]: role };
    p.redraw();
    return true;
  }
  static onSubmit(p, action, form) {
    const s = p.manage;
    if (action === "emp-m-form") { EmployeeManage.submit(p, form); return true; }
    if (action === "emp-m-add-form") {
      if (!s?.data || s.busy) return true;
      const w = EmployeeManage.wsAt(p, { value: form?.elements?.ws?.value }), role = String(form?.elements?.role?.value || "");
      if (!w || w.membership || !w.canManage || !w.ref || !Object.hasOwn(EmployeeManage.ROLES, role)) return true;
      EmployeeManage.openDialog(p, { kind: "add", ref: w.ref, name: w.name, role, returnKey: "emp-m-add" });
      return true;
    }
    return false;
  }
  // The dialog's input: a new keystroke clears the last error.
  static onInput(p, target) {
    const d = p.manage?.dialog; if (!d) return false;
    const out = typeof document !== "undefined" ? document.querySelector?.("#overlay-root .emp-m-dialog #emp-m-d-error") : null;
    if (out?.textContent) { out.textContent = ""; target?.removeAttribute?.("aria-invalid"); d.error = ""; d.invalid = ""; }
    return true;
  }
}
if (typeof window !== "undefined") window.EmployeeManage = EmployeeManage;
if (typeof module !== "undefined" && module.exports) module.exports = EmployeeManage;
