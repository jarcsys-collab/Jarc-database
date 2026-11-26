// People directory (JARC administration): the profile's "JARC access" tab (Employee Management P2, read-only).
// EmployeeProfile draws EmployeeAccess.html(explorer, state) inside the tab panel when the tab is open; the directory panel
// (EmployeesPanel) loads GET /admin/employees/{dataset}/records/{id}/jarc-access into state = { data, loading, error }.
// Only people with access.jarcAccess (the employee administrators) ever see the tab: the server refuses everyone else (403).
//
// What it shows (contract P2 §5): the JARC account (registered, status, JARC administrator yes / no / unknown, first and last
// sign-in, signed in now), the "disabled in Microsoft Entra ID, still has JARC access" warning, application permissions,
// workspaces (membership, shared access and JARC administrator badges, effective role, permissions, board count), the
// accessible boards (linked by their public board number, /boards/{publicId}) and the policy notes in plain language.
//
// Read-only: no grant, revoke or edit controls. Every value is escaped; only known enum values are turned into words, and
// nothing that looks like an internal ID is drawn (the response carries none: board numbers are the only identifiers, and
// only all-digit ones become links). Nothing is written to localStorage, sessionStorage or IndexedDB; no request is made here.
class EmployeeAccess {
  static ROLES = { SYSTEM_ADMIN: "JARC administrator", WORKSPACE_ADMIN: "Workspace admin", MEMBER: "Member", VIEWER: "Viewer" };
  static SOURCES = { system_admin: "JARC administrator", membership: "Membership", shared: "Shared access", membership_and_shared: "Membership and shared access", config: "Configuration" };
  static MEMBERSHIP_STATUS = { active: "Active", invited: "Invited", removed: "Removed" };
  // Workspace permission flags: these in this order, then any other boolean flag the server adds (e.g. importSpreadsheets),
  // named from its key ("importSpreadsheets" → "Import spreadsheets").
  static PERMISSIONS = [["view", "View"], ["editContent", "Edit content"], ["manageBoards", "Manage boards"], ["manageMembers", "Manage members"], ["moderateComments", "Moderate comments"], ["importSpreadsheets", "Import spreadsheets"]];
  static FLAG_KEY = /^[a-z][A-Za-z0-9]{0,47}$/;
  static keyLabel(key) { const s = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase(); return s[0].toUpperCase() + s.slice(1); }
  static permissionList(perms) {
    const known = EmployeeAccess.PERMISSIONS.filter(([k]) => typeof perms[k] === "boolean");
    const extra = Object.keys(perms).filter((k) => EmployeeAccess.FLAG_KEY.test(k) && typeof perms[k] === "boolean" && !EmployeeAccess.PERMISSIONS.some(([x]) => x === k)).slice(0, 20).map((k) => [k, EmployeeAccess.keyLabel(k)]);
    return [...known, ...extra];
  }
  static POLICIES = { development_shared: "Shared access (development_shared)", role_based: "Role based" };
  static MODES = { off: "Off", staged: "Staged (not enforced)", enforced: "Enforced" };
  static ADMIN_CAVEAT = "JARC administrator comes from the Microsoft Entra app role. Yes or No is the role at the person's current sign-in; Unknown means there is no live JARC session.";
  static NOT_REGISTERED = "No JARC account. This person has never signed in to JARC.";
  static PUBLIC_ID = /^[0-9]{1,12}$/;
  static MAX_ITEMS = 500;

  // ---- Helpers
  static escape(v) { return String(v ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
  static esc(explorer, v) { return typeof explorer?.esc === "function" ? explorer.esc(v ?? "") : EmployeeAccess.escape(v); }
  static attr(explorer, v) { return typeof explorer?.attr === "function" ? explorer.attr(v ?? "") : EmployeeAccess.escape(v); }
  static safeDs(explorer) { const ds = String(explorer?.ds ?? ""); return /^[a-z][a-z0-9-]{0,31}$/.test(ds) ? ds : "active"; }
  static obj(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : null; }
  static list(v) { return Array.isArray(v) ? v.slice(0, EmployeeAccess.MAX_ITEMS) : []; }
  static str(v, max = 200) { return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : ""; }
  static int(v) { return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null; }
  // An enum value as words: known values only; anything else reads "Unknown" (never echoed raw).
  static word(map, v, unknown = "Unknown") { return typeof v === "string" && Object.hasOwn(map, v) ? map[v] : unknown; }
  static when(value) {
    if (typeof value !== "string" || !value) return null;
    const d = new Date(value); if (Number.isNaN(d.getTime())) return null;
    let text; try { text = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(d); } catch { text = d.toISOString().slice(0, 16).replace("T", " "); }
    return { iso: d.toISOString(), text: `${text} UTC` };
  }
  static timeHtml(explorer, value) { const t = EmployeeAccess.when(value); return t ? `<time datetime="${EmployeeAccess.attr(explorer, t.iso)}">${EmployeeAccess.esc(explorer, t.text)}</time>` : ""; }
  static none(text = "Not recorded") { return `<span class="emp-p__none">${text}</span>`; }
  static badge(text, tone = "") { return `<span class="emp-p__badge emp-a__badge${tone ? ` emp-a__badge--${tone}` : ""}">${text}</span>`; }
  static row(explorer, label, inner, key = "") { return `<div class="emp-p__row"${key ? ` data-a="${key}"` : ""}><dt class="emp-p__label">${EmployeeAccess.esc(explorer, label)}</dt><dd class="emp-p__value">${inner}</dd></div>`; }
  static section(ds, id, title, body, wide = false) {
    return `<section class="emp-p__section emp-a__section${wide ? " emp-a__section--wide" : ""}" aria-labelledby="emp-a-${id}-${ds}"><h3 class="emp-p__section-title" id="emp-a-${id}-${ds}">${title}</h3>${body}</section>`;
  }
  static plural(n, one, many) { return `${n.toLocaleString()} ${n === 1 ? one : many}`; }

  // ---- States
  static stateHtml(explorer, s) {
    const e = (v) => EmployeeAccess.esc(explorer, v), a = (v) => EmployeeAccess.attr(explorer, v), ds = EmployeeAccess.safeDs(explorer);
    const err = s?.error;
    if (err) {
      const kind = err.kind || "";
      const [tone, title, msg, retry] = kind === "denied" || kind === "forbidden" ? ["error", "No access", "You don't have access to JARC access details.", false]
        : kind === "record" || kind === "missing" ? ["warn", "Not found", "This account isn't in the directory snapshot, or isn't in this list.", false]
        : kind === "unavailable" ? ["error", "JARC access unavailable", "JARC access details are temporarily unavailable. Try again in a few minutes.", true]
        : ["error", "JARC access couldn't be loaded", typeof err.message === "string" && err.message ? err.message : "The JARC access details didn't load.", true];
      const ref = typeof err.reference === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(err.reference) ? ` <small class="fx-status__ref">Reference <code>${e(err.reference)}</code></small>` : "";
      const button = retry ? `<button type="button" class="fx-btn" data-action="emp-p-access-retry" data-ds="${a(ds)}" data-focus-key="emp-a-retry">Try again</button>` : "";
      return `<div class="fx-status fx-status--${tone} fx-status--block emp-a__state" role="alert"><span class="fx-status__text"><strong class="emp-state__title">${title}</strong> <span class="emp-state__msg">${e(msg)}</span>${ref}</span>${button ? `<span class="fx-status__actions">${button}</span>` : ""}</div>`;
    }
    return `<div class="fx-status fx-status--info emp-a__state" role="status" aria-busy="true"><span class="fx-status__msg">Loading JARC access…</span></div>`;
  }

  // ---- The tab panel's content
  static html(explorer, state) {
    const s = state && typeof state === "object" ? state : {}, d = EmployeeAccess.obj(s.data);
    if (!d) return EmployeeAccess.stateHtml(explorer, s);
    const e = (v) => EmployeeAccess.esc(explorer, v), ds = EmployeeAccess.safeDs(explorer);
    const acc = EmployeeAccess.obj(d.account) || {}, policy = EmployeeAccess.obj(d.policy) || {};
    const parts = [];
    if (d.stale === true) {
      const t = EmployeeAccess.timeHtml(explorer, d.generatedAt);
      parts.push(`<div class="fx-status fx-status--warn emp-p__banner emp-a__stale" role="status"><span class="fx-status__msg">The JARC access details may be out of date: the latest check failed.${t ? ` What you see was checked ${t}.` : ""}</span></div>`);
    }
    if (acc.registered !== true) {
      parts.push(`<div class="emp-a__empty" role="status"><strong class="emp-a__empty-title">${EmployeeAccess.NOT_REGISTERED}</strong><span class="emp-a__empty-text">JARC access starts at the first JARC sign-in. An enabled Microsoft Entra account doesn't give JARC access by itself.</span></div>`);
      parts.push(`<div class="emp-p__sections emp-a__sections">${EmployeeAccess.section(ds, "policy", "How JARC access works", EmployeeAccess.policyHtml(explorer, policy, d.notes))}</div>`);
      parts.push(EmployeeAccess.footerHtml(explorer, d));
      return `<div class="emp-access" data-registered="false">${parts.join("")}</div>`;
    }
    const workspaces = EmployeeAccess.list(d.workspaces).map(EmployeeAccess.obj).filter(Boolean);
    const reach = workspaces.filter((w) => typeof w.effectiveRole === "string" && Object.hasOwn(EmployeeAccess.ROLES, w.effectiveRole)).length;
    if (acc.entraDisabledWithAccess === true) {
      parts.push(`<div class="fx-status fx-status--error fx-status--block emp-a__alert" role="alert"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__text"><strong class="emp-state__title">Disabled in Microsoft Entra ID, still has JARC access</strong> <span class="emp-state__msg">Sign-in is disabled in Microsoft Entra ID, but this person's JARC account is active${reach ? ` with access to ${e(EmployeeAccess.plural(reach, "workspace", "workspaces"))}` : acc.jarcAdmin === "yes" ? " as a JARC administrator" : ""}. JARC access isn't changed here: review it with a JARC administrator.</span></span></div>`);
    }
    const sections = [
      EmployeeAccess.section(ds, "account", "JARC account", EmployeeAccess.accountHtml(explorer, acc)),
      EmployeeAccess.section(ds, "app", "Application permissions", EmployeeAccess.appHtml(explorer, d.appPermissions)),
      EmployeeAccess.section(ds, "workspaces", "Workspaces", EmployeeAccess.workspacesHtml(explorer, workspaces), true),
      EmployeeAccess.section(ds, "boards", "Accessible boards", EmployeeAccess.boardsHtml(explorer, EmployeeAccess.obj(d.boards)), true),
      EmployeeAccess.section(ds, "policy", "How JARC access works", EmployeeAccess.policyHtml(explorer, policy, d.notes), true)
    ];
    parts.push(`<div class="emp-p__sections emp-a__sections">${sections.join("")}</div>`, EmployeeAccess.footerHtml(explorer, d));
    return `<div class="emp-access" data-registered="true">${parts.join("")}</div>`;
  }

  static accountHtml(explorer, acc) {
    const e = (v) => EmployeeAccess.esc(explorer, v), t = (v) => EmployeeAccess.timeHtml(explorer, v), row = (l, i, k) => EmployeeAccess.row(explorer, l, i, k);
    const status = acc.status === "active" ? EmployeeAccess.badge("Active", "on") : acc.status === "disabled" ? EmployeeAccess.badge("Disabled in JARC", "off") : EmployeeAccess.none("Unknown");
    const admin = { yes: "Yes", no: "No", unknown: "Unknown (not signed in)" }[acc.jarcAdmin] || "Unknown";
    const precision = EmployeeAccess.int(acc.lastSignInPrecisionMinutes) || 15;
    const seen = t(acc.lastSeenAt);
    const now = acc.signedInNow === true ? `<span class="emp-p__text">Yes</span>${seen ? ` <span class="emp-a__muted">· last seen ${seen}</span>` : ""}` : acc.signedInNow === false ? `<span class="emp-p__text">No</span>` : EmployeeAccess.none("Unknown");
    const role = EmployeeAccess.obj(acc.accountRole);
    const entra = acc.entraEnabled === true ? `<span class="emp-p__text">Enabled</span>` : acc.entraEnabled === false ? EmployeeAccess.badge("Disabled", "off") : EmployeeAccess.none("Unknown");
    const rows = [
      row("JARC account", `<span class="emp-p__text">Registered</span>`, "registered"),
      row("JARC account status", status, "status"),
      row("JARC administrator", `<span class="emp-p__text">${admin}</span>`, "admin"),
      role ? row("JARC account role", `<span class="emp-p__text">${e(EmployeeAccess.str(role.role, 60) ? EmployeeAccess.humanize(role.role) : "Unknown")}${EmployeeAccess.str(role.status, 40) ? ` · ${e(EmployeeAccess.humanize(role.status))}` : ""}</span>`, "role") : "",
      row("First JARC sign-in", t(acc.registeredAt) || EmployeeAccess.none(), "first"),
      row("Last JARC sign-in", t(acc.lastSignInAt) || EmployeeAccess.none(), "last"),
      row("Signed in to JARC now", now, "now"),
      row("Microsoft Entra sign-in", entra, "entra")
    ].join("");
    const disabled = acc.status === "disabled" ? `<p class="emp-p__note">A JARC account that is disabled in JARC gives no access at all.</p>` : "";
    return `<dl class="emp-p__grid">${rows}</dl>${disabled}<p class="emp-p__note">${EmployeeAccess.ADMIN_CAVEAT}</p><p class="emp-p__note">The last sign-in is recorded at most every ${e(String(precision))} minutes, so it is accurate to about ${e(String(precision))} minutes.</p>`;
  }
  static humanize(v) { const s = String(v ?? "").replace(/[_-]+/g, " ").trim().toLowerCase(); return s ? s[0].toUpperCase() + s.slice(1) : ""; }

  static appHtml(explorer, list) {
    const e = (v) => EmployeeAccess.esc(explorer, v);
    // Generic: every entry by its label (or, without one, its key in words), granted, source and note.
    const items = EmployeeAccess.list(list).map(EmployeeAccess.obj).filter(Boolean)
      .map((p) => ({ ...p, label: EmployeeAccess.str(p.label, 120) || (typeof p.key === "string" && EmployeeAccess.FLAG_KEY.test(p.key) ? EmployeeAccess.keyLabel(p.key) : "") }))
      .filter((p) => p.label);
    if (!items.length) return `<p class="emp-p__note">No application permissions were reported.</p>`;
    return `<ul class="emp-a__perms" role="list">${items.map((p) => {
      const src = typeof p.source === "string" && Object.hasOwn(EmployeeAccess.SOURCES, p.source) ? ` ${EmployeeAccess.badge(e(EmployeeAccess.SOURCES[p.source]), p.source === "shared" ? "shared" : p.source === "system_admin" ? "admin" : "")}` : "";
      const level = { viewer: "Viewer", admin: "Administrator" }[p.level];
      const state = p.granted === true ? EmployeeAccess.badge(level ? `Granted: ${level}` : "Granted", "on") : EmployeeAccess.badge("Not granted", "no");
      const note = EmployeeAccess.str(p.note, 400) ? `<span class="emp-a__note">${e(EmployeeAccess.str(p.note, 400))}</span>` : "";
      return `<li class="emp-a__perm"><span class="emp-a__perm-label">${e(EmployeeAccess.str(p.label, 120))}</span><span class="emp-a__badges">${state}${p.granted === true ? src : ""}</span>${note}</li>`;
    }).join("")}</ul>`;
  }

  static workspacesHtml(explorer, workspaces) {
    const e = (v) => EmployeeAccess.esc(explorer, v);
    if (!workspaces.length) return `<p class="emp-p__note">No workspaces. This person has no JARC workspace access.</p>`;
    const cards = workspaces.map((w) => {
      const name = EmployeeAccess.str(w.name, 200) || "Unnamed workspace";
      const m = EmployeeAccess.obj(w.membership), effective = typeof w.effectiveRole === "string" && Object.hasOwn(EmployeeAccess.ROLES, w.effectiveRole) ? w.effectiveRole : null;
      const badges = [];
      if (m) {
        const st = typeof m.status === "string" ? m.status : "";
        const role = EmployeeAccess.word(EmployeeAccess.ROLES, m.role, "Unknown role");
        badges.push(EmployeeAccess.badge(`Membership: ${e(role)}${st && st !== "active" ? ` · ${e(EmployeeAccess.word(EmployeeAccess.MEMBERSHIP_STATUS, st))}` : ""}`, st === "active" ? "member" : "no"));
      }
      if (w.sharedRole === "WORKSPACE_ADMIN") badges.push(EmployeeAccess.badge("Shared access", "shared"));
      if (w.source === "system_admin" || effective === "SYSTEM_ADMIN") badges.push(EmployeeAccess.badge("JARC administrator", "admin"));
      if (w.archived === true) badges.push(EmployeeAccess.badge("Archived", "no"));
      const inactive = m && m.status !== "active" ? `<p class="emp-a__note">An ${e(EmployeeAccess.word(EmployeeAccess.MEMBERSHIP_STATUS, m.status).toLowerCase())} membership grants nothing.</p>` : "";
      const since = m ? EmployeeAccess.timeHtml(explorer, m.since) : "";
      const perms = EmployeeAccess.obj(w.permissions) || {};
      const flags = EmployeeAccess.permissionList(perms);
      const can = flags.filter(([k]) => perms[k] === true).map(([, l]) => l), cannot = flags.filter(([k]) => perms[k] !== true).map(([, l]) => l);
      const boards = EmployeeAccess.int(w.boards);
      const source = typeof w.source === "string" && Object.hasOwn(EmployeeAccess.SOURCES, w.source) ? EmployeeAccess.SOURCES[w.source] : "";
      const rows = [
        EmployeeAccess.row(explorer, "Effective role", effective ? `<span class="emp-p__text">${e(EmployeeAccess.ROLES[effective])}</span>${source ? ` <span class="emp-a__muted">· from ${e(source.toLowerCase().replace("jarc", "JARC"))}</span>` : ""}` : EmployeeAccess.none("No access"), "effective"),
        EmployeeAccess.row(explorer, "Can", can.length ? `<span class="emp-p__text">${e(can.join(", "))}</span>` : EmployeeAccess.none("Nothing"), "can"),
        cannot.length && effective ? EmployeeAccess.row(explorer, "Can't", `<span class="emp-p__text">${e(cannot.join(", "))}</span>`, "cannot") : "",
        EmployeeAccess.row(explorer, "Boards", boards === null ? EmployeeAccess.none("Unknown") : `<span class="emp-p__text">${e(boards.toLocaleString())}</span>`, "boards"),
        since ? EmployeeAccess.row(explorer, "Member since", since, "since") : ""
      ].join("");
      return `<li class="emp-a__ws${effective ? "" : " is-none"}"><div class="emp-a__ws-head"><span class="emp-a__ws-name">${e(name)}</span><span class="emp-a__badges">${badges.join("")}</span></div><dl class="emp-p__grid emp-a__ws-grid">${rows}</dl>${inactive}</li>`;
    }).join("");
    const shared = workspaces.some((w) => w.sharedRole === "WORKSPACE_ADMIN" && !EmployeeAccess.obj(w.membership));
    const hint = shared ? `<p class="emp-p__note">Managing members and moderating comments need a real membership or JARC administrator, never shared access alone.</p>` : "";
    return `<ul class="emp-a__wslist" role="list">${cards}</ul>${hint}`;
  }

  static boardsHtml(explorer, b) {
    const e = (v) => EmployeeAccess.esc(explorer, v), a = (v) => EmployeeAccess.attr(explorer, v);
    const items = EmployeeAccess.list(b?.items).map(EmployeeAccess.obj).filter(Boolean);
    const total = EmployeeAccess.int(b?.total), shown = items.length;
    if (!shown) return `<p class="emp-p__note">${total ? `${e(EmployeeAccess.plural(total, "board", "boards"))}, none listed.` : "No accessible boards."}</p>`;
    const rows = items.map((it) => {
      const name = EmployeeAccess.str(it.name, 200) || "Unnamed board", ws = EmployeeAccess.str(it.workspace, 200);
      const id = typeof it.publicId === "number" ? String(it.publicId) : typeof it.publicId === "string" ? it.publicId : "";
      const link = EmployeeAccess.PUBLIC_ID.test(id) ? `<a class="fx-link emp-a__board-link" href="${a(`/boards/${id}`)}">${e(name)}</a> <span class="emp-a__muted">#${e(id)}</span>` : `<span class="emp-p__text">${e(name)}</span>`;
      const role = typeof it.effectiveRole === "string" && Object.hasOwn(EmployeeAccess.ROLES, it.effectiveRole) ? EmployeeAccess.ROLES[it.effectiveRole] : "";
      const source = typeof it.source === "string" && Object.hasOwn(EmployeeAccess.SOURCES, it.source) ? EmployeeAccess.SOURCES[it.source] : "";
      const ro = (it.readOnly === true ? EmployeeAccess.badge("Read-only (synced)", "no") : "") + (it.archived === true ? EmployeeAccess.badge("Archived", "no") : "");
      return `<li class="emp-a__board"><span class="emp-a__board-name">${link}</span><span class="emp-a__board-meta">${ws ? `<span>${e(ws)}</span>` : ""}${role ? `<span>${e(role)}</span>` : ""}${source ? EmployeeAccess.badge(e(source), it.source === "shared" ? "shared" : it.source === "system_admin" ? "admin" : it.source === "membership" ? "member" : "") : ""}${ro}</span></li>`;
    }).join("");
    const count = total !== null && total > shown ? `Showing the first ${e(shown.toLocaleString())} of ${e(total.toLocaleString())} boards.` : `${e(EmployeeAccess.plural(total ?? shown, "board", "boards"))}.`;
    const truncated = b?.truncated === true && !(total !== null && total > shown) ? " The list is cut short." : "";
    const synced = items.some((it) => it.readOnly === true) ? ` A read-only (synced) board refuses changes whatever the role.` : "";
    return `<p class="emp-p__note emp-a__count">${count}${truncated}</p><ul class="emp-a__boards" role="list">${rows}</ul><p class="emp-p__note">JARC has no board-level permissions: each board follows its workspace's access.${synced}</p>`;
  }

  static policyHtml(explorer, policy, notes) {
    const e = (v) => EmployeeAccess.esc(explorer, v);
    const lines = [];
    if (policy.shared === true) lines.push(`<p class="emp-a__policy-lead"><strong>Shared access is on.</strong> Every active JARC user is a workspace admin in every workspace. This access is granted each time they use JARC; it isn't stored as a membership, and it ends when shared access is turned off.</p>`);
    else if (policy.shared === false) lines.push(`<p class="emp-a__policy-lead"><strong>Shared access is off.</strong> Workspace access comes only from memberships and the JARC administrator role.</p>`);
    const rows = [
      typeof policy.accessPolicy === "string" ? EmployeeAccess.row(explorer, "Access policy", `<span class="emp-p__text">${e(EmployeeAccess.word(EmployeeAccess.POLICIES, policy.accessPolicy))}</span>`) : "",
      typeof policy.betaOpenEditing === "boolean" ? EmployeeAccess.row(explorer, "Open editing (beta)", `<span class="emp-p__text">${policy.betaOpenEditing ? "On" : "Off"}</span>`) : "",
      typeof policy.accountManagement === "string" ? EmployeeAccess.row(explorer, "Account management", `<span class="emp-p__text">${e(EmployeeAccess.word(EmployeeAccess.MODES, policy.accountManagement))}</span>`) : ""
    ].join("");
    if (rows) lines.push(`<dl class="emp-p__grid">${rows}</dl>`);
    const list = EmployeeAccess.list(notes).map((n) => EmployeeAccess.str(n, 600)).filter(Boolean).slice(0, 20);
    if (list.length) lines.push(`<ul class="emp-a__notes">${list.map((n) => `<li>${e(n)}</li>`).join("")}</ul>`);
    return lines.join("") || `<p class="emp-p__note">No policy details were reported.</p>`;
  }

  static footerHtml(explorer, d) {
    const t = EmployeeAccess.timeHtml(explorer, d.generatedAt);
    return `<p class="emp-p__source">Source: JARC${t ? ` · checked ${t}` : ""}. Read-only: JARC access isn't changed here.</p>`;
  }
}
if (typeof window !== "undefined") window.EmployeeAccess = EmployeeAccess;
if (typeof module !== "undefined" && module.exports) module.exports = EmployeeAccess;
