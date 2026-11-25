// Fabric Data → "My saved filters" (Phase 7): a person's own named filters per dataset, kept by JARC (not Fabric) under
// /api/v1/fabric/saved-filters/{dataset} (server/src/routes/fabric-saved-filters.js: session + CSRF through the app's adapter;
// the server keeps one list per person and dataset and answers 404 for anyone else's ID, so nothing here decides ownership).
// Every GET revalidates each filter against the current schema and access: a condition that can't be used now comes back as
// { unavailable: true } (never naming its field), with valid:false, a problem sentence and unavailable: ["filter.items.1",
// "orderBy.0", "searchField", "filter"]. Opening a saved filter always reads the list again first. When the skips only narrow
// it (a condition inside an OR, a sort key) it applies what is still usable and says what was skipped. When the server marks it
// broadens: true (a skip in an AND, the whole filter withheld) it is NEVER applied on its own: the rest opens as a builder draft
// (setDraft), the rows shown don't change, and a warning that can't be dismissed offers "Open anyway (broader results)".
// Updating such a filter says in the dialog and on its button that it saves the broader version.
//
// Hooks (all optional, behind typeof checks on the other side):
//   FabricObjects (F1): navItems(explorer) → null (loading) | [{ id, name, current, dirty, invalid, problem }]; clearCurrent(x).
//   FabricExplorer (F2): getState()/setState(state) (applyFilter(model) as a fallback); draws toolbarHtml(x) in its toolbar and
//     noticeHtml(x) above the grid; forwards fabric-s-* actions here (onAction(x, action, target, event)).
//   FabricDataPanel: redraw() and redrawObjects() after each answer; the dialogs live in the app's #overlay-root.
// Memory only: the lists live in this module's Map, keyed by explorer, and are dropped when the signed-in user changes, when the
// session ends (jarc-session-expired / jarc-access-denied / jarc-account-pending) or on forget(). Never in browser storage.
// Every server value is shown through the panel's esc()/attr(); IDs go through encodeURIComponent.
class FabricSavedFilters {
  static BASE = "/fabric/saved-filters";
  static MAX_NAME = 80;
  static MAX_ITEMS = 50;
  static ID = /^[A-Za-z0-9_-]{1,64}$/;
  static RETRY_ID = "_retry"; // the Objects panel's "Try again" row after a failed load (server IDs are 16 hex digits)
  static CONTROL = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;
  static states = new Map();
  static listening = false;

  // ---- State, per explorer; a different signed-in user never sees the previous one's list
  static handles(action) { return typeof action === "string" && action.startsWith("fabric-s-"); }
  static userKey(x) { const c = x?.p?.c; return String(c?.auth?.userId || c?.model?.me || ""); }
  // broadens: the open saved filter lost a condition that narrowed it (10-security-review M1); held: its usable rest, NOT applied
  // until the person chooses Apply in the builder or "Open anyway (broader results)".
  static fresh(user) { return { user, items: null, loading: false, error: "", seq: 0, activeId: "", applied: null, notes: [], busy: false, notice: "", broadens: false, held: null }; }
  static st(x) {
    FabricSavedFilters.listen();
    const user = FabricSavedFilters.userKey(x);
    let s = FabricSavedFilters.states.get(x);
    if (!s || s.user !== user) { s = FabricSavedFilters.fresh(user); FabricSavedFilters.states.set(x, s); }
    return s;
  }
  static current(x, s) { return FabricSavedFilters.states.get(x) === s && s.user === FabricSavedFilters.userKey(x); }
  // Drops one explorer's list (or all of them) and closes a saved-filter dialog left open.
  static forget(x) {
    if (x) FabricSavedFilters.states.delete(x); else FabricSavedFilters.states.clear();
    const root = typeof document !== "undefined" ? document.querySelector?.("#overlay-root") : null;
    if (root?.querySelector?.(".fx-sf-dialog")) root.innerHTML = "";
  }
  static listen() {
    if (FabricSavedFilters.listening || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    FabricSavedFilters.listening = true;
    for (const name of ["jarc-session-expired", "jarc-access-denied", "jarc-account-pending"]) window.addEventListener(name, () => FabricSavedFilters.forget());
  }
  // "All records" was chosen: no saved filter is applied any more (the list stays).
  static clearCurrent(x) { const s = FabricSavedFilters.st(x); s.activeId = ""; s.applied = null; s.notes = []; s.notice = ""; s.broadens = false; s.held = null; }

  // ---- Small helpers
  static esc(x, v) { return typeof x?.p?.esc === "function" ? x.p.esc(v) : String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); }
  static attr(x, v) { return typeof x?.p?.attr === "function" ? x.p.attr(v) : FabricSavedFilters.esc(x, v); }
  static label(x) { return x?.label || (x?.datasets && typeof x.datasets === "object" ? x.datasets[x?.ds] : null) || (typeof FabricExplorer === "function" && FabricExplorer.DATASETS?.[x?.ds]) || x?.ds || "this dataset"; }
  // The explorer's saved-filters base (FabricExplorer options.savedFiltersBase), else Fabric Data's BASE.
  static base(x) { const b = x?.savedFiltersBase; return typeof b === "string" && /^\/[a-z][a-z/-]{0,63}$/.test(b) ? b : FabricSavedFilters.BASE; }
  static path(x, id) { return `${FabricSavedFilters.base(x)}/${encodeURIComponent(x.ds)}${id ? `/${encodeURIComponent(id)}` : ""}`; }
  static redraw(x) { x?.p?.redraw?.(); x?.p?.redrawObjects?.(); }
  static announce(x, text) { x?.p?.announce?.(text); }
  static focus(selector) {
    if (typeof document === "undefined" || typeof setTimeout !== "function") return;
    setTimeout(() => { document.querySelector?.(selector)?.focus?.({ preventScroll: true }); }, 0);
  }
  static icon(name, fallback = "") { try { return typeof icon === "function" ? icon(name) : fallback; } catch { return fallback; } }
  // Key-sorted JSON, so two equal states compare equal whatever order their keys were built in.
  static stable(v) {
    if (Array.isArray(v)) return `[${v.map((e) => FabricSavedFilters.stable(e)).join(",")}]`;
    if (v && typeof v === "object") return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${FabricSavedFilters.stable(v[k])}`).join(",")}}`;
    return JSON.stringify(v ?? null);
  }
  static clone(v) { try { return v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)); } catch { return null; } }
  static safe(v, max = 300) { const t = typeof v === "string" ? v.trim() : ""; return t && t.length <= max && !FabricSavedFilters.CONTROL.test(t) ? t : ""; }
  // The server's name rules: inner whitespace collapsed, trimmed; unique ignoring case and Unicode form.
  static cleanName(raw) { const t = typeof raw === "string" ? raw : ""; return (t.normalize ? t.normalize("NFC") : t).replace(/\s+/gu, " ").trim(); }
  static nameKey(name) { return (name.normalize ? name.normalize("NFKC") : name).toLowerCase(); }

  // ---- The saved state: what the explorer reports (getState), reduced to the stored shape
  static orderPairs(v) {
    if (!Array.isArray(v)) return [];
    return v.map((k) => (Array.isArray(k) ? [k[0], k[1]] : k && typeof k === "object" ? [k.field, k.dir] : typeof k === "string" ? k.split(":") : []))
      .filter(([f]) => typeof f === "string" && f).slice(0, 3).map(([f, d]) => [f, d === "asc" ? "asc" : "desc"]);
  }
  static normalizeState(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const opt = (v) => (typeof v === "string" && v ? v : null);
    const filter = r.filter && typeof r.filter === "object" && Array.isArray(r.filter.items) && r.filter.items.length ? FabricSavedFilters.clone(r.filter) : null;
    const columns = Array.isArray(r.columns) ? r.columns.filter((c) => typeof c === "string" && c) : [];
    return { filter, orderBy: FabricSavedFilters.orderPairs(r.orderBy), columns, dateFrom: opt(r.dateFrom), dateTo: opt(r.dateTo), datePreset: opt(r.datePreset), q: typeof r.q === "string" ? r.q : "", searchField: opt(r.searchField) };
  }
  static capture(x) {
    if (typeof x?.getState === "function") return FabricSavedFilters.normalizeState(x.getState());
    return FabricSavedFilters.normalizeState({ ...(x?.query || {}), columns: x?.columns });
  }
  static countConditions(node) {
    if (!node || typeof node !== "object") return 0;
    return Array.isArray(node.items) ? node.items.reduce((n, c) => n + FabricSavedFilters.countConditions(c), 0) : node.field ? 1 : 0;
  }

  // ---- Server answers
  static item(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = typeof raw.id === "string" && FabricSavedFilters.ID.test(raw.id) && raw.id !== FabricSavedFilters.RETRY_ID ? raw.id : "";
    const name = typeof raw.name === "string" ? raw.name : "";
    if (!id || !name) return null;
    const unavailable = (Array.isArray(raw.unavailable) ? raw.unavailable : []).filter((p) => typeof p === "string" && p.length <= 64);
    const state = raw.state && typeof raw.state === "object" ? raw.state : {}, valid = raw.valid !== false && !unavailable.length;
    // The server says whether the rest is broader (broadens); an older answer without it is judged here, failing safe.
    const broadens = !valid && (raw.broadens === true || (raw.broadens === undefined && FabricSavedFilters.broadensOf(state, unavailable)));
    return { id, name, version: raw.version ?? 1, state, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "", valid, problem: FabricSavedFilters.safe(raw.problem), unavailable, broadens };
  }
  // Would the usable rest match MORE rows? (The server's broadensOf: a skip in an AND, an OR left empty, the whole filter
  // withheld, or a search that loses its field.) Unknown shapes count as broader.
  static broadensOf(state, unavailable) {
    if (unavailable.includes("filter")) return true;
    if (unavailable.includes("searchField") && typeof state?.q === "string" && state.q.trim()) return true;
    if (!unavailable.some((p) => p.startsWith("filter."))) return false;
    const walk = (group) => {
      let broad = false, removed = 0, kept = 0;
      for (const item of Array.isArray(group?.items) ? group.items : []) {
        if (item && typeof item === "object" && Array.isArray(item.items)) { const r = walk(item); broad = broad || r.broad; if (r.empty) removed += 1; else kept += 1; }
        else if (item && item.unavailable === true) removed += 1;
        else kept += 1;
      }
      if (removed && group.op !== "or") broad = true;
      return { broad, empty: kept === 0 };
    };
    const f = state?.filter;
    if (!f || typeof f !== "object" || !Array.isArray(f.items)) return true;
    const r = walk(f);
    return r.broad || r.empty;
  }
  // A server path ("filter.items.1.items.0", "orderBy.0", "searchField", "filter") in words. Never a field name.
  static describePath(p) {
    if (p === "filter") return "All filter conditions: the filter no longer fits the current rules";
    if (p === "searchField") return "The search field: searching covers the usual fields instead";
    let m = /^orderBy\.(\d+)$/.exec(p);
    if (m) return `Sort key ${Number(m[1]) + 1}: its field can't be used now`;
    m = /^filter\.items\.(\d+)(?:\.items\.(\d+))?$/.exec(p);
    if (m) return m[2] === undefined ? `Condition ${Number(m[1]) + 1}: it uses a field or setting you can't use now` : `Condition ${Number(m[2]) + 1} in group ${Number(m[1]) + 1}: it uses a field or setting you can't use now`;
    return "A setting you can't use now";
  }
  static code(error) { return String(error?.cause?.serverCode || error?.code || ""); }
  static status(error) { return Number(error?.cause?.status || error?.status || 0); }
  static gone(error) { return FabricSavedFilters.status(error) === 404 || FabricSavedFilters.code(error) === "NOT_FOUND"; }
  // A specific sentence for a failed request. `what` names the operation ("save “Weekly”").
  static errorText(x, error, what) {
    const code = FabricSavedFilters.code(error), status = FabricSavedFilters.status(error), ds = FabricSavedFilters.label(x);
    let message;
    if (code === "NAME_TAKEN") message = "You already have a saved filter with that name (names ignore upper and lower case). Choose another name.";
    else if (code === "LIMIT_REACHED") message = `You have ${FabricSavedFilters.MAX_ITEMS} saved filters for ${ds}, the most allowed. Delete one you no longer need, then try again.`;
    else if (code === "CONFLICT" || status === 409) message = "Your saved filters changed at the same moment (perhaps in another window). Try again.";
    else if (FabricSavedFilters.gone(error)) message = "This saved filter no longer exists. It may have been deleted in another window; the list has been refreshed.";
    else if (code === "VALIDATION_ERROR" || status === 400) message = "The server didn't accept it: a condition, the sort or the dates use something that can't be saved now. Check the filter conditions, then try again.";
    else if (status === 413 || code === "PAYLOAD_TOO_LARGE") message = "This filter is too large to save. Remove some conditions or values, then try again.";
    else if (code === "UNAUTHENTICATED" || code === "CSRF_INVALID" || status === 401) message = "Your session has ended. Sign in again, then try again.";
    else if (code === "INSUFFICIENT_SCOPE" || code === "FABRIC_DATA_FORBIDDEN" || code === "FORBIDDEN" || status === 403) message = `You don't have access to saved filters for ${ds}.`;
    else if (code === "RATE_LIMITED" || status === 429) message = "Too many requests in a short time. Wait a few seconds, then try again.";
    else if (typeof FabricDataPanel === "function" && FabricDataPanel.errorInfo) message = FabricDataPanel.errorInfo(error).message;
    else message = "Saved filters can't be reached right now. Try again in a moment.";
    const ref = typeof error?.requestId === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(error.requestId) ? ` Reference: ${error.requestId}.` : "";
    return `${what ? `Couldn't ${what}. ` : ""}${message}${ref}`;
  }

  // ---- Loading (always from the server; a late answer, or one for a previous user, is dropped)
  static ensure(x) { const s = FabricSavedFilters.st(x); if (!s.items && !s.loading && !s.error) FabricSavedFilters.load(x).catch(() => {}); }
  static load(x) {
    const s = FabricSavedFilters.st(x), seq = ++s.seq;
    s.error = ""; s.loading = true;
    const run = (async () => {
      try {
        const res = await x.p.adapter.request("GET", FabricSavedFilters.path(x));
        if (!FabricSavedFilters.current(x, s) || seq !== s.seq) return s.items;
        s.items = (Array.isArray(res?.items) ? res.items : []).map((i) => FabricSavedFilters.item(i)).filter(Boolean);
        if (s.activeId && !s.items.some((i) => i.id === s.activeId)) FabricSavedFilters.clearCurrent(x);
        return s.items;
      } catch (error) {
        if (FabricSavedFilters.current(x, s) && seq === s.seq) s.error = FabricSavedFilters.errorText(x, error, "load your saved filters");
        throw error;
      } finally {
        if (FabricSavedFilters.current(x, s) && seq === s.seq) { s.loading = false; FabricSavedFilters.redraw(x); }
      }
    })();
    return run;
  }

  // ---- Opening: the stored state minus what the server marked unavailable (each skip is listed for the person)
  static strip(node) {
    if (!node || typeof node !== "object" || !Array.isArray(node.items)) return node;
    const items = node.items.filter((c) => !(c && c.unavailable === true)).map((c) => FabricSavedFilters.strip(c)).filter((c) => !Array.isArray(c?.items) || c.items.length);
    return { ...node, items };
  }
  static applicable(x, item) {
    const state = FabricSavedFilters.normalizeState(item.state), notes = item.unavailable.map((p) => FabricSavedFilters.describePath(p));
    if (state.filter) { const f = FabricSavedFilters.strip(state.filter); state.filter = f.items.length ? f : null; }
    if (!item.valid && !notes.length) notes.push(item.problem || "Part of this saved filter can't be used now and was skipped.");
    // Columns the server still lists may not be in this explorer's schema yet (e.g. a field just removed): left out, said once.
    const fields = Array.isArray(x?.info?.fields) && x.info.fields.length ? new Set(x.info.fields.map((f) => f.name)) : null;
    if (fields && state.columns.length) {
      const kept = state.columns.filter((c) => fields.has(c)), gone = state.columns.length - kept.length;
      if (gone) notes.push(`${gone} column${gone === 1 ? " isn't" : "s aren't"} available now and ${gone === 1 ? "was" : "were"} left out`);
      state.columns = kept;
    }
    return { state, notes };
  }
  static async applyState(x, state) {
    if (typeof x.setState === "function") { await x.setState(FabricSavedFilters.clone(state)); return; }
    if (typeof x.applyFilter === "function") await x.applyFilter(FabricSavedFilters.clone(state.filter));
  }
  static find(x, id) { return (FabricSavedFilters.st(x).items || []).find((i) => i.id === id) || null; }
  static active(x) { const s = FabricSavedFilters.st(x); return s.activeId ? FabricSavedFilters.find(x, s.activeId) : null; }
  // The current view differs from the saved filter that was opened (or last saved/updated).
  static isDirty(x) {
    const s = FabricSavedFilters.st(x);
    return Boolean(s.activeId && s.applied) && FabricSavedFilters.stable(FabricSavedFilters.capture(x)) !== FabricSavedFilters.stable(s.applied);
  }
  static async open(x, id) {
    const s = FabricSavedFilters.st(x);
    if (id === FabricSavedFilters.RETRY_ID) { FabricSavedFilters.load(x).catch(() => {}); return false; }
    if (s.busy) return false;
    s.busy = true; s.notice = ""; FabricSavedFilters.announce(x, "Opening the saved filter…");
    try {
      try { await FabricSavedFilters.load(x); } catch { if (FabricSavedFilters.current(x, s)) FabricSavedFilters.announce(x, s.error); return false; }
      if (!FabricSavedFilters.current(x, s)) return false;
      const item = FabricSavedFilters.find(x, id);
      if (!item) { s.notice = "This saved filter no longer exists. It may have been deleted in another window."; FabricSavedFilters.announce(x, s.notice); return false; }
      const { state, notes } = FabricSavedFilters.applicable(x, item);
      if (item.broadens) {
        // M1: what is left would show MORE rows than the saved filter: never applied on its own. The rows shown don't change;
        // the rest opens as a draft in the builder (F2's setDraft) and a warning stays until another filter is opened.
        s.activeId = item.id; s.notes = notes; s.applied = null; s.broadens = true; s.held = FabricSavedFilters.clone(state);
        if (state.filter && typeof x.setDraft === "function") { try { x.setDraft(FabricSavedFilters.clone(state.filter)); } catch { /* the notice still offers Open anyway */ } }
        FabricSavedFilters.announce(x, `Saved filter ${item.name} was not applied: some of its conditions can't be used now, and without them it would show more rows than it was saved for. Review it, then choose Apply or Open anyway.`);
        return false;
      }
      await FabricSavedFilters.applyState(x, state);
      if (!FabricSavedFilters.current(x, s)) return false;
      s.activeId = item.id; s.notes = notes; s.applied = FabricSavedFilters.capture(x); s.broadens = false; s.held = null;
      FabricSavedFilters.announce(x, `Opened saved filter ${item.name}.${notes.length ? ` Skipped because they can't be used now: ${notes.join("; ")}.` : ""}`);
      return true;
    } finally {
      if (FabricSavedFilters.current(x, s)) { s.busy = false; FabricSavedFilters.redraw(x); }
    }
  }

  // The explicit "Open anyway (broader results)": applies the held rest of a broadening saved filter. The warning stays.
  static async applyBroader(x) {
    const s = FabricSavedFilters.st(x), item = FabricSavedFilters.active(x);
    if (s.busy || !s.broadens || !s.held || !item) return false;
    s.busy = true;
    try {
      await FabricSavedFilters.applyState(x, s.held);
      if (!FabricSavedFilters.current(x, s)) return false;
      s.held = null; s.applied = FabricSavedFilters.capture(x);
      FabricSavedFilters.announce(x, `Opened ${item.name} without the conditions that can't be used now. It may show more rows than it was saved for.`);
      return true;
    } finally { if (FabricSavedFilters.current(x, s)) { s.busy = false; FabricSavedFilters.redraw(x); } }
  }

  // ---- Save, update, rename, delete. Each returns { ok, id? } or { error } ("" = ignored: already running, or the user changed).
  // "" when the name may be used; otherwise what to fix. The server checks again (its rules are authoritative).
  static nameProblem(x, raw, exceptId = "") {
    const name = FabricSavedFilters.cleanName(raw);
    if (!name) return "Give the saved filter a name.";
    if (FabricSavedFilters.CONTROL.test(name)) return "Remove control characters from the name.";
    const length = [...name].length;
    if (length > FabricSavedFilters.MAX_NAME) return `Use at most ${FabricSavedFilters.MAX_NAME} characters (this name has ${length}).`;
    const key = FabricSavedFilters.nameKey(name), clash = (FabricSavedFilters.st(x).items || []).find((i) => i.id !== exceptId && FabricSavedFilters.nameKey(FabricSavedFilters.cleanName(i.name)) === key);
    if (clash) return `You already have a saved filter named “${clash.name}” for ${FabricSavedFilters.label(x)}. Choose another name, or open it and choose Update to replace what it holds.`;
    return "";
  }
  static async write(x, method, id, body, what, after) {
    const s = FabricSavedFilters.st(x);
    if (s.busy) return { error: "" };
    s.busy = true; FabricSavedFilters.redraw(x);
    try {
      const res = await x.p.adapter.request(method, FabricSavedFilters.path(x, id), body);
      if (!FabricSavedFilters.current(x, s)) return { error: "" };
      return after(res);
    } catch (error) {
      if (!FabricSavedFilters.current(x, s)) return { error: "" };
      // DELETE answers 204 with no body, which the app's HTTP client can report as an unusable response even though the
      // delete happened: read the list again, and if the filter is gone the delete succeeded.
      if (method === "DELETE" && !FabricSavedFilters.gone(error) && FabricSavedFilters.code(error) === "INTERNAL_ERROR") {
        const items = await FabricSavedFilters.load(x).catch(() => null);
        if (!FabricSavedFilters.current(x, s)) return { error: "" };
        if (items && !items.some((i) => i.id === id)) return after(undefined);
      }
      if (FabricSavedFilters.gone(error) && id) { s.items = (s.items || []).filter((i) => i.id !== id); if (s.activeId === id) FabricSavedFilters.clearCurrent(x); FabricSavedFilters.load(x).catch(() => {}); }
      return { error: FabricSavedFilters.errorText(x, error, what) };
    } finally { if (FabricSavedFilters.current(x, s)) { s.busy = false; FabricSavedFilters.redraw(x); } }
  }
  static put(x, raw) { const s = FabricSavedFilters.st(x), item = FabricSavedFilters.item(raw); if (item) s.items = [...(s.items || []).filter((i) => i.id !== item.id), item]; return item; }
  static async save(x, rawName) {
    const s = FabricSavedFilters.st(x), name = FabricSavedFilters.cleanName(rawName), problem = FabricSavedFilters.nameProblem(x, name);
    if (problem) return { error: problem };
    if ((s.items || []).length >= FabricSavedFilters.MAX_ITEMS) return { error: FabricSavedFilters.errorText(x, { code: "LIMIT_REACHED" }) };
    const state = FabricSavedFilters.capture(x);
    return FabricSavedFilters.write(x, "POST", "", { name, state }, `save “${name}”`, (res) => {
      const item = FabricSavedFilters.put(x, res);
      if (!item) { FabricSavedFilters.load(x).catch(() => {}); return { ok: true, id: "" }; }
      s.activeId = item.id; s.applied = state; s.notes = []; s.notice = ""; s.broadens = false; s.held = null;
      FabricSavedFilters.announce(x, `Saved filter ${item.name} saved.`);
      return { ok: true, id: item.id };
    });
  }
  static async rename(x, id, rawName) {
    const item = FabricSavedFilters.find(x, id), name = FabricSavedFilters.cleanName(rawName);
    if (!item) return { error: "This saved filter no longer exists. It may have been deleted in another window." };
    if (name === item.name) return { ok: true, id };
    const problem = FabricSavedFilters.nameProblem(x, name, id);
    if (problem) return { error: problem };
    return FabricSavedFilters.write(x, "PUT", id, { name }, `rename “${item.name}”`, (res) => {
      if (!FabricSavedFilters.put(x, res)) FabricSavedFilters.st(x).items = (FabricSavedFilters.st(x).items || []).map((i) => (i.id === id ? { ...i, name } : i));
      FabricSavedFilters.announce(x, `Renamed to ${name}.`);
      return { ok: true, id };
    });
  }
  static async update(x, id) {
    const s = FabricSavedFilters.st(x), item = FabricSavedFilters.find(x, id);
    if (!item) return { error: "This saved filter no longer exists. It may have been deleted in another window." };
    const state = FabricSavedFilters.capture(x);
    return FabricSavedFilters.write(x, "PUT", id, { state }, `update “${item.name}”`, (res) => {
      if (!FabricSavedFilters.put(x, res)) s.items = (s.items || []).map((i) => (i.id === id ? { ...i, state, valid: true, problem: "", unavailable: [], broadens: false } : i));
      s.activeId = id; s.applied = state; s.notes = []; s.broadens = false; s.held = null;
      FabricSavedFilters.announce(x, `Saved filter ${item.name} now holds the current filter, sort and columns.`);
      return { ok: true, id };
    });
  }
  static async remove(x, id) {
    const s = FabricSavedFilters.st(x), item = FabricSavedFilters.find(x, id);
    if (!item) return { error: "This saved filter no longer exists. It may have been deleted in another window." };
    return FabricSavedFilters.write(x, "DELETE", id, undefined, `delete “${item.name}”`, () => {
      if (!FabricSavedFilters.current(x, s)) return { error: "" };
      s.items = (s.items || []).filter((i) => i.id !== id);
      if (s.activeId === id) FabricSavedFilters.clearCurrent(x);
      FabricSavedFilters.announce(x, `Saved filter ${item.name} deleted. The rows shown don't change.`);
      return { ok: true, id };
    });
  }

  // ---- Objects panel slot (F1 draws the tree items): null while loading, else plain items
  static navItems(x) {
    if (!x?.ds) return [];
    const s = FabricSavedFilters.st(x);
    if (s.error && !s.items) return [{ id: FabricSavedFilters.RETRY_ID, name: "Couldn't load saved filters. Try again", invalid: true, problem: s.error }];
    if (!s.items) { if (!s.loading) Promise.resolve().then(() => FabricSavedFilters.ensure(x)); return null; }
    const dirty = FabricSavedFilters.isDirty(x);
    return s.items.map((i) => ({ id: i.id, name: i.name, current: i.id === s.activeId, dirty: i.id === s.activeId && dirty, invalid: !i.valid, problem: i.valid ? "" : i.problem || "Part of this saved filter can't be used now" }));
  }

  // ---- Explorer toolbar (F2): which saved filter is open, whether the view changed since, Update, Save filter, Manage
  static toolbarHtml(x) {
    if (!x?.ds) return "";
    const s = FabricSavedFilters.st(x), ds = FabricSavedFilters.attr(x, x.ds), e = (v) => FabricSavedFilters.esc(x, v), a = (v) => FabricSavedFilters.attr(x, v);
    const item = FabricSavedFilters.active(x), dirty = Boolean(item) && FabricSavedFilters.isDirty(x), off = s.busy ? " disabled" : "";
    const held = Boolean(item) && s.broadens && FabricSavedFilters.heldPending(x, s);
    const current = item ? `<span class="fx-chip fx-sf-bar__current${dirty ? " is-dirty" : ""}" title="${a(`Saved filter: ${item.name}${held ? " (not applied)" : dirty ? " (changed since it was opened)" : ""}`)}"><span class="fx-chip__label">Saved filter:</span> <span class="fx-chip__text">${e(item.name)}</span>${held ? `<span class="fx-sf-bar__dirty"> · not applied</span>` : dirty ? `<span class="fx-sf-bar__dirty"> · <span aria-hidden="true">●</span> Unsaved changes</span>` : ""}</span>` : "";
    const update = item && dirty ? `<button type="button" class="fx-btn" data-action="fabric-s-update" data-ds="${ds}" data-id="${a(item.id)}" data-focus-key="sf-bar-update"${off}>Update “${e(item.name)}”…</button>` : "";
    const save = `<button type="button" class="fx-btn fx-sf-bar__save" data-action="fabric-s-save" data-ds="${ds}" data-focus-key="sf-bar-save"${off}>${FabricSavedFilters.icon("save")}<span>${item ? "Save as new…" : "Save filter…"}</span></button>`;
    // D6: the same icon + label structure as Save filter…; a short visible label (the toolbar fits one row at 1440 px) whose full
    // name stays in aria-label and the tooltip.
    const manage = s.items?.length ? `<button type="button" class="fx-btn fx-sf-bar__manage" data-action="fabric-s-manage" data-ds="${ds}" data-focus-key="sf-bar-manage" aria-label="Manage saved filters…" title="Manage saved filters"${off}>${FabricSavedFilters.icon("list")}<span>Manage…</span></button>` : "";
    return `<span class="fx-sf-bar" role="group" aria-label="Saved filters">${current}${update}${save}${manage}</span>`;
  }
  // A broadening saved filter's rest is still waiting: the applied filter isn't it (Apply in the builder or Open anyway makes it so).
  static heldPending(x, s) {
    if (!s.held) return false;
    const heldFilter = FabricSavedFilters.normalizeState(s.held).filter;
    if (!heldFilter) return true; // nothing for the builder: only Open anyway applies it
    if (FabricSavedFilters.stable(FabricSavedFilters.capture(x).filter) !== FabricSavedFilters.stable(heldFilter)) return true;
    // Applied from the builder: from now on only the broader-results warning, and changes are tracked from here.
    s.held = null; s.applied = FabricSavedFilters.capture(x);
    return false;
  }
  static saveButtonHtml(x) { return FabricSavedFilters.toolbarHtml(x); }
  // Above the grid: what was skipped when the open saved filter was applied, or that it no longer exists.
  static noticeHtml(x) {
    if (!x?.ds) return "";
    const s = FabricSavedFilters.st(x), item = FabricSavedFilters.active(x), ds = FabricSavedFilters.attr(x, x.ds), e = (v) => FabricSavedFilters.esc(x, v);
    const dismiss = `<span class="fx-status__actions"><button type="button" class="fx-btn" data-action="fabric-s-dismiss" data-ds="${ds}" data-focus-key="sf-dismiss">Dismiss</button></span>`;
    // M1: a broadening saved filter. No Dismiss: the warning stays while this saved filter is the open one. Skipped items are
    // described by position only (describePath), never by field name.
    if (item && s.broadens) {
      const skipped = s.notes.length ? ` Skipped: ${s.notes.map((n) => e(n)).join("; ")}.` : "";
      if (FabricSavedFilters.heldPending(x, s)) {
        const draft = s.held?.filter && typeof x.setDraft === "function" ? " The conditions that still work are open in the filter builder: review them and choose Apply." : "";
        return `<div class="fx-status fx-status--warn fx-status--block fx-sf-notice fx-sf-notice--broader" role="alert"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__text"><strong>“${e(item.name)}” was not applied.</strong> Some of its conditions can't be used now. Without them it would show more rows than it was saved for, so the rows shown haven't changed.${skipped}${draft}</span><span class="fx-status__actions"><button type="button" class="fx-btn" data-action="fabric-s-apply-broader" data-ds="${ds}" data-focus-key="sf-apply-broader"${s.busy ? " disabled" : ""}>Open anyway (broader results)</button></span></div>`;
      }
      return `<div class="fx-status fx-status--warn fx-status--block fx-sf-notice fx-sf-notice--broader" role="status"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__text"><strong>Broader results:</strong> “${e(item.name)}” is open without conditions that can't be used now, so these rows can include some it was saved to leave out.${skipped}</span></div>`;
    }
    if (item && s.notes.length) return `<div class="fx-status fx-status--warn fx-status--block fx-sf-notice" role="status"><span class="fx-status__icon" aria-hidden="true">!</span><span class="fx-status__text">Opened “${e(item.name)}” without what can't be used now: ${s.notes.map((n) => e(n)).join("; ")}. Choose Update to save it without them.</span>${dismiss}</div>`;
    if (s.notice) return `<div class="fx-status fx-status--info fx-status--block fx-sf-notice" role="status"><span class="fx-status__icon" aria-hidden="true">i</span><span class="fx-status__text">${e(s.notice)}</span>${dismiss}</div>`;
    return "";
  }

  // ---- Dialogs (fx-dialog in the app's #overlay-root, which handles Escape, outside clicks and the focus trap)
  static summary(state) {
    const n = FabricSavedFilters.countConditions(state.filter), parts = [n ? `${n} filter condition${n === 1 ? "" : "s"}` : "no filter conditions"];
    if (state.dateFrom || state.dateTo || state.datePreset) parts.push("the dates");
    if (state.q) parts.push("the search text");
    if (state.orderBy.length) parts.push("the sort");
    if (state.columns.length) parts.push(`${state.columns.length} chosen column${state.columns.length === 1 ? "" : "s"}`);
    return `${parts.slice(0, -1).join(", ")}${parts.length > 1 ? " and " : ""}${parts.at(-1)}`;
  }
  static dialog(x, mode, { id = "", error = "", name = null, back = false } = {}) {
    const view = x?.p?.c?.view;
    if (typeof view?.overlay !== "function") return false;
    const s = FabricSavedFilters.st(x), ds = FabricSavedFilters.attr(x, x.ds), e = (v) => FabricSavedFilters.esc(x, v), a = (v) => FabricSavedFilters.attr(x, v), label = FabricSavedFilters.label(x);
    const item = id ? FabricSavedFilters.find(x, id) : null;
    if (mode !== "save" && mode !== "manage" && !item) return false;
    const t = `fabric-${ds}-sf-title`, err = `fabric-${ds}-sf-error`, help = `fabric-${ds}-sf-help`;
    const head = (title) => `<div class="fx-dialog__head"><h2 id="${t}" class="fx-dialog__title"><span class="fx-dialog__eyebrow">${e(label)} · My saved filters</span>${e(title)}</h2><button type="button" class="fx-btn fx-btn--icon" data-action="close-overlay" aria-label="Close">${FabricSavedFilters.icon("close", "×")}</button></div>`;
    const errorLine = `<p class="fx-sf-dialog__error apitok-error" id="${err}" role="alert">${e(error)}</p>`;
    const what = FabricSavedFilters.summary(FabricSavedFilters.capture(x));
    let title, body, submit = "", danger = false, focus = "button[type='submit']";
    if (mode === "manage") {
      title = "Manage saved filters";
      const rows = (s.items || []).map((i) => `<li class="fx-sf-manage__row${i.id === s.activeId ? " is-current" : ""}"><span class="fx-sf-manage__name"><strong>${e(i.name)}</strong>${i.id === s.activeId ? ' <small>(open)</small>' : ""}${i.valid ? "" : `<small class="fx-sf-manage__warn"> · ${e(i.problem || "Part of it can't be used now")}</small>`}</span><span class="fx-sf-manage__actions"><button type="button" class="fx-btn" data-action="fabric-s-open" data-ds="${ds}" data-id="${a(i.id)}" data-focus-key="sf-m-open-${a(i.id)}" aria-label="Open ${a(i.name)}">Open</button><button type="button" class="fx-btn" data-action="fabric-s-rename" data-ds="${ds}" data-id="${a(i.id)}" data-back="manage" data-focus-key="sf-m-rename-${a(i.id)}" aria-label="Rename ${a(i.name)}">Rename…</button><button type="button" class="fx-btn" data-action="fabric-s-update" data-ds="${ds}" data-id="${a(i.id)}" data-back="manage" data-focus-key="sf-m-update-${a(i.id)}" aria-label="Update ${a(i.name)} with the current view">Update…</button><button type="button" class="fx-btn fx-btn--danger" data-action="fabric-s-delete" data-ds="${ds}" data-id="${a(i.id)}" data-back="manage" data-focus-key="sf-m-delete-${a(i.id)}" aria-label="Delete ${a(i.name)}">Delete…</button></span></li>`).join("");
      body = rows ? `<ul class="fx-sf-manage" aria-labelledby="${t}">${rows}</ul>` : `<p class="fabric-help">No saved filters yet.</p>`;
      focus = "[data-sf-cancel]";
    } else if (mode === "save" || mode === "rename") {
      title = mode === "save" ? "Save the current filter" : `Rename “${item.name}”`;
      const value = name ?? (mode === "rename" ? item.name : "");
      const full = mode === "save" && (s.items || []).length >= FabricSavedFilters.MAX_ITEMS ? `<p class="fx-status fx-status--warn">You already have ${FabricSavedFilters.MAX_ITEMS} saved filters for ${e(label)}, the most allowed. Delete one first.</p>` : "";
      body = `${full}<label class="fx-api__field"><span class="fx-field__label">Name</span><input class="fx-input" name="name" required maxlength="${FabricSavedFilters.MAX_NAME}" autocomplete="off" spellcheck="false" value="${a(value)}" aria-describedby="${help} ${err}"${error ? ' aria-invalid="true"' : ""}></label><small id="${help}" class="fx-api__hint">1 to ${FabricSavedFilters.MAX_NAME} characters, different from your other saved filters for ${e(label)}. Only you see them.</small>${mode === "save" ? `<p class="fabric-help">Saves ${e(what)}. The values you filter on are kept in JARC with the name.</p>` : ""}`;
      submit = mode === "save" ? "Save" : "Rename"; focus = "input[name='name']";
    } else if (mode === "update") {
      title = `Update “${item.name}”`;
      // M1: replacing a saved filter that lost narrowing conditions drops them for good: said plainly, and the button says so.
      const broader = item.broadens || (s.broadens && item.id === s.activeId);
      body = broader
        ? `<p class="fx-status fx-status--warn" role="note"><strong>Some conditions of “${e(item.name)}” can't be used now.</strong> Replacing it saves the current view without them, so “${e(item.name)}” will show more rows than it was saved for. The skipped conditions can't be brought back.</p><p>Replace what “${e(item.name)}” holds with the current view: ${e(what)}?</p><p class="fabric-help">The previous version isn't kept.</p>`
        : `<p>Replace what “${e(item.name)}” holds with the current view: ${e(what)}?</p><p class="fabric-help">The previous version isn't kept.</p>`;
      submit = broader ? "Replace with the broader filter" : "Replace";
    } else {
      title = `Delete “${item.name}”`;
      body = `<p>Delete the saved filter “${e(item.name)}”? The rows shown now don't change.</p><p class="fabric-help">This can't be undone.</p>`;
      submit = "Delete"; danger = true; focus = "[data-sf-cancel]";
    }
    const buttons = `<button type="button" class="fx-btn" data-action="close-overlay" data-sf-cancel>${mode === "manage" ? "Close" : "Cancel"}</button>${submit ? `<button type="submit" class="fx-btn ${danger ? "fx-btn--danger" : "fx-btn--primary"}">${submit}</button>` : ""}`;
    // D3 (13-browser-responsive-review.md): the control that opened the first dialog, by focus key (the toolbar is redrawn, so
    // never the element). Kept while one dialog leads to another (Manage → Rename → Manage); every close path returns there:
    // AppController's closeOverlay (Escape, Cancel, ×, the backdrop) and closeDialog here.
    const returnKey = FabricSavedFilters.returnKey();
    view.overlay(`<form class="fx-dialog fx-sf-dialog" role="dialog" aria-modal="true" data-action="fabric-s-form" data-ds="${ds}" data-mode="${mode}" data-id="${a(id)}" data-back="${back ? "manage" : ""}" data-return-focus-key="${a(returnKey)}" aria-labelledby="${t}" novalidate>${head(title)}<div class="fx-dialog__body">${body}${errorLine}</div><div class="fx-dialog__foot">${buttons}</div></form>`, "apitok-overlay fx-api-overlay fx-sf-overlay");
    FabricSavedFilters.bind(x);
    FabricSavedFilters.focus(`.fx-sf-dialog ${focus}`);
    return true;
  }
  // The dialog answers its own submit and typing (the overlay sits outside #fabric-root). A second delivery of the same submit
  // (the app also forwards fabric-s-form through the panel) is ignored while the first runs.
  static bind(x) {
    const form = typeof document !== "undefined" ? document.querySelector?.("#overlay-root .fx-sf-dialog") : null;
    if (!form?.addEventListener) return;
    form.addEventListener("submit", (event) => { event.preventDefault?.(); FabricSavedFilters.onSubmit(x, "fabric-s-form", form); });
    form.addEventListener("input", (event) => FabricSavedFilters.onInput(x, event.target));
  }
  // Where focus goes back when the saved-filter dialogs close: the opener of the first one (a dialog already open passes its key
  // on). From the builder's Save filter (the builder has closed) or with no keyed opener: Filters. Focus keys are our own words.
  static returnKey() {
    if (typeof document === "undefined") return "";
    const open = document.querySelector?.("#overlay-root .fx-sf-dialog");
    if (open) return open.dataset?.returnFocusKey || "";
    const key = document.activeElement?.closest?.("[data-focus-key]")?.dataset?.focusKey || "";
    return /^[A-Za-z0-9_-]{1,100}$/.test(key) && !key.startsWith("fb-") ? key : "filters";
  }
  // Closes the dialog, then focuses its opener (by key, after the redraw); when that control is gone (Update, or Manage after
  // the last delete) the fallback key.
  static closeDialog(x, fallbackKey) {
    const key = FabricSavedFilters.returnKey();
    x?.p?.c?.view?.closeOverlay?.();
    FabricSavedFilters.redraw(x);
    if (typeof document === "undefined" || typeof setTimeout !== "function") return;
    setTimeout(() => {
      const el = (key && document.querySelector?.(`[data-focus-key="${key}"]`)) || (fallbackKey && document.querySelector?.(`[data-focus-key="${fallbackKey}"]`));
      el?.focus?.({ preventScroll: true });
    }, 0);
  }
  static async onSubmit(x, action, form) {
    if (action !== "fabric-s-form" || !x || !form || form.sfPending) return;
    const mode = form.dataset?.mode, id = form.dataset?.id || "", back = form.dataset?.back === "manage", name = String(form.elements?.name?.value ?? "");
    const run = { save: () => FabricSavedFilters.save(x, name), rename: () => FabricSavedFilters.rename(x, id, name), update: () => FabricSavedFilters.update(x, id), delete: () => FabricSavedFilters.remove(x, id) }[mode];
    if (!run) return;
    form.sfPending = true;
    let r;
    try { r = await run(); } finally { form.sfPending = false; }
    if (r.ok) {
      if (back && (FabricSavedFilters.st(x).items || []).length) { FabricSavedFilters.dialog(x, "manage"); return; }
      FabricSavedFilters.closeDialog(x, "sf-bar-save");
      return;
    }
    if (!r.error) return;
    if (mode !== "save" && !FabricSavedFilters.find(x, id)) { // it was deleted elsewhere: say so outside the dialog
      const s = FabricSavedFilters.st(x); s.notice = r.error;
      if (back) FabricSavedFilters.dialog(x, "manage", { error: r.error }); else FabricSavedFilters.closeDialog(x, "sf-bar-save");
      FabricSavedFilters.announce(x, r.error); FabricSavedFilters.redraw(x);
      return;
    }
    FabricSavedFilters.dialog(x, mode, { id, error: r.error, name, back });
    FabricSavedFilters.announce(x, r.error);
  }

  // ---- Events forwarded by the explorer (fabric-s-* clicks) and the dialog
  static onAction(x, action, target) {
    if (!x || !FabricSavedFilters.handles(action)) return false;
    const s = FabricSavedFilters.st(x), id = target?.dataset?.id || "", back = target?.dataset?.back === "manage";
    if (action === "fabric-s-retry") { FabricSavedFilters.load(x).catch(() => {}); return true; }
    if (action === "fabric-s-open") {
      if (target?.closest?.(".fx-sf-dialog")) x?.p?.c?.view?.closeOverlay?.();
      FabricSavedFilters.open(x, id); return true;
    }
    if (action === "fabric-s-apply-broader") { FabricSavedFilters.applyBroader(x); return true; }
    // The broader-results warning can't be dismissed (M1): only the other notices go.
    if (action === "fabric-s-dismiss") { if (!s.broadens) s.notes = []; s.notice = ""; FabricSavedFilters.redraw(x); FabricSavedFilters.focus('[data-focus-key="sf-bar-save"]'); return true; }
    if (action === "fabric-s-save") { s.notice = ""; FabricSavedFilters.dialog(x, "save"); return true; }
    if (action === "fabric-s-manage") { FabricSavedFilters.dialog(x, "manage"); if (!s.items && !s.loading) FabricSavedFilters.load(x).then(() => FabricSavedFilters.dialog(x, "manage")).catch(() => {}); return true; }
    if (["fabric-s-rename", "fabric-s-update", "fabric-s-delete"].includes(action)) { FabricSavedFilters.dialog(x, action.slice("fabric-s-".length), { id, back }); return true; }
    return false;
  }
  // Typing a name clears the previous error (the name is checked again on Save).
  static onInput(x, target) {
    const form = target?.closest?.(".fx-sf-dialog"), out = form?.querySelector?.(".fx-sf-dialog__error");
    if (out?.textContent) { out.textContent = ""; target.removeAttribute?.("aria-invalid"); }
  }
}
if (typeof window !== "undefined") window.FabricSavedFilters = FabricSavedFilters;
