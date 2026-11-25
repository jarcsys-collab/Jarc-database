// People directory (JARC administration): the profile page of one directory account.
// The explorer draws EmployeeProfile.html(explorer, record, schema) when a record is open, and passes every "emp-p-…" action to
// EmployeeProfile.onAction(explorer, action, target, event) and keydown events to EmployeeProfile.onKeydown(explorer, event).
//
//   record   the unchanged GET /admin/employees/{dataset}/records/{id} response: { id, values, snapshot }
//   schema   the dataset schema (raw { fields: [{ name, label }] } or the normalised info with byName); used for labels only
//   explorer esc(), attr(), listHref(), ds, recordId, onAction()/openRecord(), p.announce() (all optional except listHref)
//
// Read-only and request-free. Only the allow-listed fields below are ever read from record.values: anything else the response
// may hold (phones, IDs, unknown keys) is never drawn. A missing value reads "Not recorded"; nothing is inferred or invented.
// Nothing is written to localStorage, sessionStorage or IndexedDB.
class EmployeeProfile {
  static ID = /^[A-Za-z0-9_-]{22}$/;
  // The allow-list: API field name → default label (the schema's label wins when present).
  static LABELS = {
    displayName: "Name", givenName: "First name", surname: "Last name", mail: "Email", userPrincipalName: "Sign-in name",
    jobTitle: "Job title", department: "Department", officeLocation: "Office", emailDomain: "Email domain",
    accountType: "Account type", accountEnabled: "Sign-in enabled", accountCreated: "Directory account created"
  };
  static NOT_RECORDED = "Not recorded";
  static PHONE_NOTE = "Phone numbers are not available in this directory view.";
  static returns = new WeakMap(); // explorer → the profile ID whose list row gets focus back

  // ---- Helpers
  static escape(v) { return String(v ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
  static esc(explorer, v) { return typeof explorer?.esc === "function" ? explorer.esc(v ?? "") : EmployeeProfile.escape(v); }
  static attr(explorer, v) { return typeof explorer?.attr === "function" ? explorer.attr(v ?? "") : EmployeeProfile.escape(v); }
  static safeDs(explorer) { const ds = String(explorer?.ds ?? ""); return /^[a-z][a-z0-9-]{0,31}$/.test(ds) ? ds : "active"; }
  static label(schema, name) {
    let found = null;
    try {
      if (schema?.byName && typeof schema.byName.get === "function") found = schema.byName.get(name)?.label;
      if (!found && Array.isArray(schema?.fields)) found = schema.fields.find((f) => f && f.name === name)?.label;
    } catch { found = null; }
    return typeof found === "string" && found.trim() ? found : EmployeeProfile.LABELS[name];
  }
  // One allow-listed value: strings and finite numbers only (booleans only for accountEnabled). Anything else is "absent".
  static value(values, name) {
    if (!Object.hasOwn(EmployeeProfile.LABELS, name) || !values || typeof values !== "object" || !Object.hasOwn(values, name)) return null;
    const v = values[name];
    if (name === "accountEnabled") return typeof v === "boolean" ? v : null;
    if (typeof v === "string") return v.trim() ? v.trim().slice(0, 512) : null;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return null;
  }
  static has(values, name) { return Boolean(values) && typeof values === "object" && Object.hasOwn(values, name); }
  static date(value, withTime = false) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const d = new Date(value); if (Number.isNaN(d.getTime())) return null;
    try { return new Intl.DateTimeFormat(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(d); } catch { return d.toISOString().slice(0, withTime ? 16 : 10).replace("T", " "); }
  }
  // The snapshot time in UTC with a " UTC" suffix, as the directory heading shows it (EmployeesPanel.time).
  static utcTime(value) {
    if (typeof value !== "string" || !value) return null;
    const d = new Date(value); if (Number.isNaN(d.getTime())) return null;
    let text; try { text = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(d); } catch { text = d.toISOString().slice(0, 16).replace("T", " "); }
    return { iso: d.toISOString(), text: `${text} UTC` };
  }
  static mailHref(v) { const t = String(v ?? "").trim(); return t.length <= 320 && /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[^\s@<>"'()]+$/.test(t) ? `mailto:${t}` : ""; }
  static initials(name, given, surname) {
    const parts = given || surname ? [given, surname] : String(name || "").split(/\s+/);
    const letters = parts.filter(Boolean).map((p) => Array.from(String(p))[0] || "").filter((c) => /\p{L}|\p{N}/u.test(c));
    const text = (letters.length > 1 ? letters[0] + letters[letters.length - 1] : letters[0] || "").toUpperCase();
    return text || "?";
  }
  static notRecorded() { return `<span class="emp-p__none">${EmployeeProfile.NOT_RECORDED}</span>`; }
  static row(explorer, schema, name, inner) {
    return `<div class="emp-p__row" data-field="${name}"><dt class="emp-p__label">${EmployeeProfile.esc(explorer, EmployeeProfile.label(schema, name))}</dt><dd class="emp-p__value">${inner}</dd></div>`;
  }
  static textRow(explorer, schema, values, name) {
    const v = EmployeeProfile.value(values, name);
    return EmployeeProfile.row(explorer, schema, name, v === null ? EmployeeProfile.notRecorded() : `<span class="emp-p__text">${EmployeeProfile.esc(explorer, v)}</span>`);
  }
  static section(ds, id, title, body) {
    return `<section class="emp-p__section" aria-labelledby="emp-p-${id}-${ds}"><h3 class="emp-p__section-title" id="emp-p-${id}-${ds}">${title}</h3>${body}</section>`;
  }

  // ---- The page
  static html(explorer, record, schema) {
    const e = (v) => EmployeeProfile.esc(explorer, v), a = (v) => EmployeeProfile.attr(explorer, v), ds = EmployeeProfile.safeDs(explorer);
    const href = typeof explorer?.listHref === "function" ? explorer.listHref() : "";
    const back = `<a class="fx-btn emp-p__back" href="${a(href)}" data-action="emp-p-back" data-ds="${a(ds)}" data-focus-key="emp-p-back"><span aria-hidden="true">‹</span> Back to list</a>`;
    const shell = (title, body, busy = false) => `<article class="emp-profile" data-ds="${a(ds)}" aria-labelledby="emp-p-title-${ds}"${busy ? ' aria-busy="true"' : ""}><div class="emp-p__bar">${back}</div><h2 class="emp-p__title" id="emp-p-title-${ds}" tabindex="-1">${title}</h2>${body}</article>`;
    const values = record && typeof record === "object" && record.values && typeof record.values === "object" && !Array.isArray(record.values) ? record.values : null;
    if (!values) {
      const slot = explorer?.record || {}, err = slot.error;
      if (err && (err.code === "NOT_FOUND" || err.status === 404 || err.kind === "record")) return shell("Directory account", `<div class="fx-status fx-status--warn emp-p__state" role="alert"><span class="fx-status__msg">This person is no longer in the directory snapshot, or isn't in this list. The account may have been deleted.</span></div>`);
      if (err) return shell("Directory account", `<div class="fx-status fx-status--error emp-p__state" role="alert"><span class="fx-status__msg">${e(typeof err.message === "string" && err.message ? err.message : "This profile couldn't be loaded.")}</span><button type="button" class="fx-btn" data-action="emp-p-retry" data-ds="${a(ds)}">Try again</button></div>`);
      return shell("Directory account", `<div class="fx-status fx-status--info emp-p__state" role="status"><span class="fx-status__msg">Loading the profile…</span></div>`, true);
    }
    const v = (n) => EmployeeProfile.value(values, n);
    const given = v("givenName"), surname = v("surname");
    const name = v("displayName") || [given, surname].filter(Boolean).join(" ") || "Unnamed directory account";
    const sub = [v("jobTitle"), v("department")].filter(Boolean);
    const enabled = v("accountEnabled"), type = v("accountType");
    const badges = [
      type ? `<span class="emp-p__badge emp-p__badge--type">${e(type)}</span>` : "",
      enabled === null ? "" : `<span class="emp-p__badge ${enabled ? "emp-p__badge--on" : "emp-p__badge--off"}">${enabled ? "Sign-in enabled" : "Sign-in disabled"}</span>`
    ].join("");
    const head = `<div class="emp-p__head"><span class="emp-p__avatar" aria-hidden="true">${e(EmployeeProfile.initials(name, given, surname))}</span><div class="emp-p__who">${sub.length ? `<p class="emp-p__subtitle">${sub.map(e).join(` <span aria-hidden="true">·</span> `)}</p>` : ""}${badges ? `<p class="emp-p__badges">${badges}</p>` : ""}</div></div>`;
    const disabled = enabled === false ? `<div class="fx-status fx-status--warn emp-p__banner" role="status"><span class="fx-status__msg">This account is disabled in Microsoft Entra ID.</span></div>` : "";

    const row = (n) => EmployeeProfile.textRow(explorer, schema, values, n);
    const identity = `<dl class="emp-p__grid">${row("displayName")}${row("givenName")}${row("surname")}</dl>`;
    const mail = v("mail"), mailHref = mail ? EmployeeProfile.mailHref(mail) : "";
    const mailInner = mail === null ? EmployeeProfile.notRecorded() : `${mailHref ? `<a class="fx-link emp-p__mail" href="${a(mailHref)}">${e(mail)}</a>` : `<span class="emp-p__text">${e(mail)}</span>`} <button type="button" class="fx-btn emp-p__copy" data-action="emp-p-copy" data-ds="${a(ds)}" data-copy="${a(mail)}" aria-label="${a(`Copy email ${mail}`)}">Copy</button>`;
    const contact = `<dl class="emp-p__grid">${EmployeeProfile.row(explorer, schema, "mail", mailInner)}${row("userPrincipalName")}</dl><p class="emp-p__note">${EmployeeProfile.PHONE_NOTE}</p>`;
    const org = `<dl class="emp-p__grid">${row("jobTitle")}${row("department")}${row("officeLocation")}${row("emailDomain")}</dl>`;
    const createdRaw = EmployeeProfile.has(values, "accountCreated") ? values.accountCreated : null, created = EmployeeProfile.date(createdRaw);
    const accountRows = [
      EmployeeProfile.has(values, "accountType") ? row("accountType") : "",
      EmployeeProfile.has(values, "accountEnabled") ? EmployeeProfile.row(explorer, schema, "accountEnabled", enabled === null ? EmployeeProfile.notRecorded() : `<span class="emp-p__text">${enabled ? "Yes" : "No"}</span>`) : "",
      EmployeeProfile.row(explorer, schema, "accountCreated", created && typeof createdRaw === "string" ? `<time class="emp-p__text" datetime="${a(createdRaw)}">${e(created)}</time>` : EmployeeProfile.notRecorded())
    ].join("");
    const account = `<dl class="emp-p__grid">${accountRows}</dl><p class="emp-p__note">The account creation date is when the directory account was created. It isn't a start date.</p>`;

    const snap = record.snapshot && typeof record.snapshot === "object" ? record.snapshot : {};
    const ingested = EmployeeProfile.utcTime(snap.ingestedAt);
    const stale = snap.stale === true ? `<div class="fx-status fx-status--warn emp-p__banner" role="status"><span class="fx-status__msg">This directory snapshot may be out of date: the latest update couldn't be checked. The details shown are from the last snapshot loaded.</span></div>` : "";
    const footer = `<p class="emp-p__source">Source: Microsoft Entra ID directory snapshot · updated ${ingested ? `<time datetime="${a(ingested.iso)}">${e(ingested.text)}</time>` : "unknown"}. Read-only: changes are made in Microsoft Entra ID.</p>`;
    const body = `${disabled}${stale}${head}<div class="emp-p__sections">${EmployeeProfile.section(ds, "identity", "Identity", identity)}${EmployeeProfile.section(ds, "contact", "Contact", contact)}${EmployeeProfile.section(ds, "org", "Organization", org)}${EmployeeProfile.section(ds, "account", "Directory account", account)}</div>${footer}`;
    return shell(e(name), body);
  }

  // ---- Focus hooks (the directory panel calls these after drawing)
  static doc() { return typeof document !== "undefined" ? document : null; }
  static focusHeading(explorer) { const el = EmployeeProfile.doc()?.querySelector?.(`#emp-p-title-${EmployeeProfile.safeDs(explorer)}`); el?.focus?.(); return Boolean(el); }
  static rememberRow(explorer, id) { if (explorer && typeof id === "string" && EmployeeProfile.ID.test(id)) EmployeeProfile.returns.set(explorer, id); }
  // Puts focus back on the list row that opened the profile (inside rootSelector), else on the list's first record link.
  // A profile opened by its address has no list drawn yet: the list loads only after Back. Then this waits for it (every
  // FOCUS_DELAY ms, at most FOCUS_RETRIES times, while the list is loading), and stops if a profile opens again or focus moves
  // elsewhere meanwhile. With no rows (empty, failed, or still not there): the results region, else the page heading.
  static FOCUS_RETRIES = 50;
  static FOCUS_DELAY = 100;
  static pending = new WeakMap(); // explorer → the latest wait (an older one stops)
  static restoreFocus(explorer, rootSelector = "#employees-root", left = EmployeeProfile.FOCUS_RETRIES, token = null) {
    const doc = EmployeeProfile.doc(); if (!doc) return false;
    const key = explorer && typeof explorer === "object" ? explorer : null;
    if (!token) { token = {}; if (key) EmployeeProfile.pending.set(key, token); }
    const root = doc.querySelector?.(rootSelector) || doc, id = EmployeeProfile.returns.get(explorer);
    const el = (id && root.querySelector?.(`[data-action="fabric-x-open"][data-id="${id}"]`)) || root.querySelector?.(`[data-action="fabric-x-open"]`);
    if (el) { el.focus?.(); return true; }
    const slot = explorer?.records;
    const loading = Boolean(slot && typeof slot === "object" && (slot.loading || (!slot.data && !slot.error)));
    if (loading && left > 0 && typeof setTimeout === "function") {
      setTimeout(() => {
        if (key && EmployeeProfile.pending.get(key) !== token) return; // a newer Back took over
        if (explorer?.recordId) return; // a profile is open again
        const active = doc.activeElement;
        if (active && active !== doc.body && active !== doc.documentElement) return; // the person moved focus meanwhile
        EmployeeProfile.restoreFocus(explorer, rootSelector, left - 1, token);
      }, EmployeeProfile.FOCUS_DELAY);
      return false;
    }
    const fallback = root.querySelector?.(`[data-focus-key="results"]`) || doc.querySelector?.("#employees-title");
    fallback?.focus?.({ preventScroll: true }); return Boolean(fallback);
  }

  // ---- Events
  static plainClick(event) { return !event || (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && (event.button === undefined || event.button === 0)); }
  static announce(explorer, text) { try { explorer?.p?.announce?.(text); } catch { /* no live region */ } }
  static back(explorer, target, event) {
    if (explorer?.recordId) EmployeeProfile.rememberRow(explorer, explorer.recordId);
    if (typeof explorer?.onAction === "function") explorer.onAction("fabric-x-back", target, event); else explorer?.openRecord?.("");
    EmployeeProfile.restoreFocus(explorer);
  }
  static onAction(explorer, action, target, event) {
    if (typeof action !== "string" || !action.startsWith("emp-p-")) return false;
    if (action === "emp-p-back") {
      if (target?.tagName === "A" && !EmployeeProfile.plainClick(event)) return true; // Ctrl/⌘/middle click: the browser opens the link
      event?.preventDefault?.(); EmployeeProfile.back(explorer, target, event); return true;
    }
    if (action === "emp-p-copy") {
      const text = String(target?.dataset?.copy ?? "");
      const clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
      if (!text || !clip || typeof clip.writeText !== "function") { EmployeeProfile.announce(explorer, "Copying isn't available in this browser."); return true; }
      Promise.resolve().then(() => clip.writeText(text)).then(() => EmployeeProfile.announce(explorer, "Email copied."), () => EmployeeProfile.announce(explorer, "The email couldn't be copied."));
      return true;
    }
    if (action === "emp-p-retry") { if (typeof explorer?.retry === "function") explorer.retry(); else explorer?.refresh?.(); return true; }
    return false;
  }
  // Escape (outside text fields) goes back to the list. Returns true when handled.
  static onKeydown(explorer, event) {
    if (event?.key !== "Escape" || event.defaultPrevented) return false;
    const tag = String(event.target?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target?.isContentEditable) return false;
    event.preventDefault?.(); EmployeeProfile.back(explorer, null, event); return true;
  }
}
if (typeof window !== "undefined") window.EmployeeProfile = EmployeeProfile;
if (typeof module !== "undefined" && module.exports) module.exports = EmployeeProfile;
