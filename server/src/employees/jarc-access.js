// Employee Management P2 (Employee Access Visibility): what each directory account can do in JARC, read-only. Built from JARC's
// own database (never the directory source) in ONE refresh of five bounded, projected reads, never one query per employee:
//   users       { source: "entra" }                       ≤ 5000   identity, status, account, createdAt, lastLoginAt
//   memberships { status: active | invited }              ≤ 5000   workspace, user, role, status, createdAt
//   workspaces  all                                       ≤ 1000   name, archived
//   boards      all                                       ≤ 5000   workspace, name, publicId, archived, source.readOnly
//   sessions    { expiresAt > now }                       ≤ 5000   user, identity, isSystemAdmin, expiry, lastSeenAt (_id never read)
// TTL 60 s, single-flight (concurrent requests share one refresh). A failed refresh keeps the last good index, marked stale; with
// no index at all the P2 parts answer 503 EMPLOYEES_UNAVAILABLE. Logs: counts and error class only, never a value or an ID.
//
// Matching (P2 contract §2): a JARC user matches a directory account only when source is "entra", its tenantId equals the
// configured ENTRA_TENANT_ID (case-insensitive), its entraObjectId is a GUID, and that GUID (lower case) equals the directory
// record's object ID. Two JARC users with the same object ID never match (counted as ambiguous). No email or name matching.
// The object ID stays here: the directory snapshot's non-enumerable oidById Map (snapshot.js) is read only by this module, and
// nothing built here carries an object ID, a JARC user ID or any database _id; boards are named by their public number only.
//
// Effective access mirrors auth/access.js and auth/session.js EXACTLY (lines cited from production 68b9440):
//   usable session      users.status === "active" (session.js:84-88); account mode staged/enforced: not blocked (session.js:89-94);
//                       enforced: not pending (session.js:103-105). Otherwise no access at all.
//   live session        expiresAt > now AND idleExpiresAt > now (session.js:72), session tenant = configured tenant and session
//                       tenant + object ID = the user's (session.js:79), user usable as above.
//   SYSTEM_ADMIN        off/staged: the live session's isSystemAdmin (JARC.Admin at that sign-in, session.js:106): "yes" if any
//                       live session has it, "no" if none does, "unknown" without a live session. enforced: an active Super
//                       Admin account (session.js:106, accounts.js isActiveSuperAdmin), so always yes / no.
//   shared              access.shared (development_shared or beta open editing; off when enforced, access.js:44-49) → WORKSPACE_ADMIN
//                       in every workspace for a usable user (access.js:62-65, 70-71), granted at check time, never stored.
//   explicit            an ACTIVE membership (membership-repository.js findActive), role capped by access.effective when enforced
//                       (access.js:59, 72-73; accounts.js capWorkspaceRole). Invited rows grant nothing; removed rows are never
//                       written (members are hard-deleted), so none are read.
//   effective role      SYSTEM_ADMIN when "yes", else the higher of shared and explicit. Boards: no board-level grants exist,
//                       every board inherits its workspace's role (access.js:98-102).
//
// Permission minimums, from the checks the routes and services actually make:
//   view               VIEWER           resources.js:71 (workspace), :104 (board), :231 (record)
//   editContent        MEMBER           resources.js:98 (new board), :112 (edit board), :140-:209 (records), :236, :253; comments.js:50
//   importSpreadsheets MEMBER           imports.js:30, :49 (Excel / CSV into a new board)
//   manageBoards       WORKSPACE_ADMIN  resources.js:76 (edit workspace), :116 (archive board), :120 (delete board), :184 (delete
//                                       column), :192 (change a column's type), :216 / :219 (move a board)
//   manageMembers      WORKSPACE_ADMIN through an active membership or SYSTEM_ADMIN only, never shared
//                                       members.js:11 (MEMBERSHIP_ONLY), :39, :45, :55; access.js:69-73, :79
//   moderateComments   SYSTEM_ADMIN, or exactly WORKSPACE_ADMIN through an active membership (membershipOnly)
//                                       comment-service.js:58-61
//   Read-only synchronized boards refuse content writes whatever the role (resources.js:21-22, :113): flagged on board items.
// App-level:
//   manageWorkspaces   SYSTEM_ADMIN or shared (access.js:92 canManageWorkspaces; resources.js:66)
//   deleteWorkspace    shared: WORKSPACE_ADMIN of the workspace (everyone usable, via shared); otherwise SYSTEM_ADMIN (access.js:96)
//   legacyImport       SYSTEM_ADMIN (resources.js:262-263 POST /imports)
//   mondayIntegration  SYSTEM_ADMIN (integrations.js:49, :52-56)
//   systemHealth       SYSTEM_ADMIN (system-health.js:91, :94-95, :122-123)
//   apiTokenAdmin      JARC_API_ADMIN_OIDS in this tenant (api-token-service.js:101-104)
//   employeeDirectory  EMPLOYEE_VIEWER_OIDS / EMPLOYEE_ADMIN_OIDS in this tenant (employees/access.js)
const { RANK } = require("../auth/access");
const { accountOf, isActiveSuperAdmin, capWorkspaceRole } = require("../auth/accounts");
const { employeeAccessFor } = require("./access");
const { GUID } = require("./fields");
const { employeeError, describe } = require("./errors");

const TTL_MS = 60 * 1000;
const READ_CAP = 5000; // the repositories' limits (users, memberships, boards, sessions)
const WORKSPACE_CAP = 1000; // workspace-repository.js MAX_WORKSPACES
const BOARD_ITEMS_MAX = 200;
const LAST_SIGN_IN_PRECISION_MINUTES = 15; // user-repository.js:9 PROFILE_REFRESH_MS
const ROLE_LABEL = Object.freeze({ WORKSPACE_ADMIN: "Workspace admin", MEMBER: "Member", VIEWER: "Viewer" });
const SOURCE_LABEL = Object.freeze({ system_admin: "JARC administrator", membership: "Membership", shared: "Shared access", membership_and_shared: "Membership and shared access" });
const ADMIN_LABEL = Object.freeze({ yes: "Yes", no: "No", unknown: "Unknown (not signed in)" });

const lower = (v) => (typeof v === "string" ? v.toLowerCase() : null);
const hex = (id) => (id === null || id === undefined ? null : typeof id.toHexString === "function" ? id.toHexString() : String(id));
const dateOf = (v) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v : null);
const isoOf = (v) => (dateOf(v) ? v.toISOString() : null);
const text = (v, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const higher = (a, b) => (!a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b);
const atLeast = (role, minimum) => Boolean(role) && RANK[role] >= RANK[minimum];
const byName = (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// repos: dataLayer.repos (users, memberships, workspaces, boards, sessions with the *ForAccessIndex reads). access: the app's
// Access instance (the same policy, betaOpenEditing and accountMode as every other check). tenantId: ENTRA_TENANT_ID.
// apiAdminObjectIds: config.apiTokens.adminObjectIds (null: API tokens are off). employeesConfig: config.employees.
// features: { spreadsheetImports, mondayIntegration }: false when that action doesn't exist on this server (app.js mounts
// importRoutes / integrationRoutes only when on); absent = available.
class JarcAccessIndex {
  constructor({ repos, access, tenantId, apiAdminObjectIds = null, employeesConfig = null, features = {}, now = Date.now, logger = console, ttlMs = TTL_MS }) {
    for (const r of ["users", "memberships", "workspaces", "boards", "sessions"]) if (!repos?.[r]) throw new Error("JarcAccessIndex needs the JARC repositories.");
    if (!access || typeof access.shared !== "boolean") throw new Error("JarcAccessIndex needs the app's Access instance.");
    if (!tenantId) throw new Error("JarcAccessIndex needs the tenant ID.");
    this.repos = repos; this.access = access; this.tenantId = lower(tenantId);
    this.apiAdmins = Array.isArray(apiAdminObjectIds) ? new Set(apiAdminObjectIds.map(lower)) : null;
    this.employeesConfig = employeesConfig;
    this.features = Object.freeze({ spreadsheetImports: features.spreadsheetImports !== false, mondayIntegration: features.mondayIntegration !== false });
    this.now = now; this.logger = logger; this.ttlMs = ttlMs;
    this.state = null; this.inFlight = null; this.failure = null; this.attemptAt = null;
  }

  // The current index: refreshed first when older than the TTL (single-flight). A failed refresh serves the last good one
  // (stale); with none, 503 EMPLOYEES_UNAVAILABLE.
  async current() {
    if (!this.state || this.attemptAt === null || this.now() - this.attemptAt >= this.ttlMs) await this.refresh();
    if (!this.state) throw employeeError("EMPLOYEES_UNAVAILABLE");
    return this.state;
  }
  refresh() {
    this.inFlight ??= this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async run() {
    this.attemptAt = this.now();
    try {
      const at = new Date(this.attemptAt);
      const [users, memberships, workspaces, boards, sessions] = await Promise.all([
        this.repos.users.listEntraForAccessIndex(), this.repos.memberships.listForAccessIndex(), this.repos.workspaces.listForAccessIndex(),
        this.repos.boards.listForAccessIndex(), this.repos.sessions.listLiveForAccessIndex(at)
      ]);
      this.state = this.build({ users, memberships, workspaces, boards, sessions, at });
      this.failure = null;
    } catch (error) {
      this.failure = "jarc_unavailable";
      this.logger.warn?.(`[employees] JARC access index refresh failed: ${describe(error)}${this.state ? "; serving the last good index" : ""}`);
    }
  }
  meta(state) { return { generatedAt: state.generatedAt, stale: Boolean(this.failure) }; }

  // ---- Build: everything grouped once, then one evaluation per JARC user.
  build({ users, memberships, workspaces, boards, sessions, at }) {
    const now = at.getTime();
    const policy = Object.freeze({ shared: this.access.shared, accessPolicy: this.access.policy, betaOpenEditing: Boolean(this.access.betaOpenEditing), accountManagement: this.access.accountMode });
    const workspaceById = new Map();
    for (const w of workspaces) workspaceById.set(hex(w._id), Object.freeze({ key: hex(w._id), name: text(w.name) || "Untitled workspace", archived: w.archived === true }));
    const boardsByWorkspace = new Map();
    for (const b of boards) {
      const k = hex(b.workspaceId);
      if (!workspaceById.has(k)) continue;
      const list = boardsByWorkspace.get(k) || [];
      list.push(Object.freeze({ name: text(b.name) || "Untitled board", publicId: Number.isInteger(b.publicId) ? b.publicId : null, archived: b.archived === true, readOnly: b.source?.readOnly === true }));
      boardsByWorkspace.set(k, list);
    }
    const membershipsByUser = new Map();
    for (const m of memberships) {
      const k = hex(m.userId);
      if (!k || !workspaceById.has(hex(m.workspaceId))) continue;
      (membershipsByUser.get(k) || membershipsByUser.set(k, []).get(k)).push(m);
    }
    const sessionsByUser = new Map();
    for (const s of sessions) {
      const k = hex(s.userId);
      if (k) (sessionsByUser.get(k) || sessionsByUser.set(k, []).get(k)).push(s);
    }
    // Matching: identity → user, duplicates removed (ambiguous).
    const byOid = new Map(), ambiguous = new Set();
    let entraUsers = 0;
    for (const u of users) {
      if (u.source !== "entra") continue;
      entraUsers += 1;
      if (lower(u.tenantId) !== this.tenantId || typeof u.entraObjectId !== "string" || !GUID.test(u.entraObjectId)) continue;
      const oid = u.entraObjectId.toLowerCase();
      if (ambiguous.has(oid)) continue;
      if (byOid.has(oid)) { byOid.delete(oid); ambiguous.add(oid); continue; }
      byOid.set(oid, u);
    }
    const evaluated = new Map();
    for (const [oid, u] of byOid) evaluated.set(oid, this.evaluate(u, { now, workspaceById, membershipsByUser, sessionsByUser }));
    const generatedAt = at.toISOString();
    // A read that reached its cap may have left people, memberships, boards or sessions out: every answer is then marked
    // truncated (status and the access endpoint), with a note that matching or access may be incomplete. Sessions are read
    // JARC.Admin sessions first (session-repository.js), so a cap drops ordinary sessions before administrators'.
    const capped = Object.freeze({ users: users.length >= READ_CAP, memberships: memberships.length >= READ_CAP, boards: boards.length >= READ_CAP, sessions: sessions.length >= READ_CAP, workspaces: workspaces.length >= WORKSPACE_CAP });
    const truncated = Object.values(capped).some(Boolean);
    this.logger.info?.(`[employees] JARC access index: ${byOid.size} matchable accounts, ${ambiguous.size} ambiguous${truncated ? "; a read reached its cap (truncated)" : ""}`);
    return { generatedAt, policy, workspaceById, boardsByWorkspace, byOid: evaluated, ambiguous: ambiguous.size, entraUsers, truncated, capped, joined: new WeakMap() };
  }

  // One JARC user's effective access (never holds the user's _id or object ID).
  evaluate(u, { now, workspaceById, membershipsByUser, sessionsByUser }) {
    const a = this.access, mode = a.accountMode, enforced = mode === "enforced";
    const account = mode === "off" ? null : accountOf(u);
    const blocked = Boolean(account && !account.legacy && account.status === "blocked");
    const pending = Boolean(enforced && account && !account.legacy && account.status === "pending");
    const usable = u.status === "active" && !blocked && !pending;
    const live = usable ? (sessionsByUser.get(hex(u._id)) || []).filter((s) => dateOf(s.expiresAt) && s.expiresAt.getTime() > now && dateOf(s.idleExpiresAt) && s.idleExpiresAt.getTime() > now
      && s.tenantId === u.tenantId && lower(s.tenantId) === this.tenantId && s.objectId === u.entraObjectId) : [];
    // An unusable account (JARC-disabled, blocked, or pending when enforced) can't act as an administrator at all: "no".
    const jarcAdmin = !usable ? "no" : enforced ? (isActiveSuperAdmin(account) ? "yes" : "no") : !live.length ? "unknown" : live.some((s) => s.isSystemAdmin === true) ? "yes" : "no";
    const sys = usable && jarcAdmin === "yes";
    const shared = usable && a.shared;
    const lastSeen = live.map((s) => dateOf(s.lastSeenAt)).filter(Boolean).sort((x, y) => y - x)[0] || null;
    // Memberships per workspace: the active row grants (capped when enforced); an invited row is listed only.
    const rows = new Map();
    for (const m of membershipsByUser.get(hex(u._id)) || []) {
      const k = hex(m.workspaceId), prev = rows.get(k);
      if (!prev || (prev.status !== "active" && m.status === "active")) rows.set(k, m);
    }
    const capped = (role) => (enforced && account ? capWorkspaceRole(account, role) : role); // access.js:59
    const workspaces = [];
    let membershipRole = null, anyExplicit = false, anyAccess = false;
    const memberOf = [];
    for (const w of workspaceById.values()) {
      const m = rows.get(w.key) || null;
      const active = m && m.status === "active" && ROLE_LABEL[m.role] ? m : null;
      const memberRole = active ? capped(active.role) : null;
      if (active) { memberOf.push(w.name); membershipRole = higher(membershipRole, memberRole); }
      const explicit = usable ? memberRole : null;
      const effectiveRole = sys ? "SYSTEM_ADMIN" : higher(shared ? "WORKSPACE_ADMIN" : null, explicit);
      const source = sys ? "system_admin" : explicit && shared ? "membership_and_shared" : explicit ? "membership" : shared ? "shared" : null;
      const membershipOnly = sys ? "SYSTEM_ADMIN" : explicit; // access.js:69-73 with membershipOnly
      if (explicit) anyExplicit = true;
      if (effectiveRole) anyAccess = true;
      if (!m && !effectiveRole) continue;
      workspaces.push(Object.freeze({
        key: w.key, name: w.name, archived: w.archived,
        membership: m ? Object.freeze({ role: ROLE_LABEL[m.role] ? m.role : null, status: m.status === "active" ? "active" : "invited", since: isoOf(m.createdAt) }) : null,
        sharedRole: shared ? "WORKSPACE_ADMIN" : null, effectiveRole, source,
        permissions: Object.freeze({
          view: atLeast(effectiveRole, "VIEWER"), editContent: atLeast(effectiveRole, "MEMBER"), importSpreadsheets: this.features.spreadsheetImports && atLeast(effectiveRole, "MEMBER"),
          manageBoards: atLeast(effectiveRole, "WORKSPACE_ADMIN"), manageMembers: atLeast(membershipOnly, "WORKSPACE_ADMIN"),
          moderateComments: sys || explicit === "WORKSPACE_ADMIN"
        })
      }));
    }
    memberOf.sort((x, y) => byName({ name: x }, { name: y }));
    const personSource = sys ? "system_admin" : anyExplicit && shared ? "membership_and_shared" : anyExplicit ? "membership" : shared ? "shared" : null;
    return Object.freeze({
      status: u.status === "active" ? "active" : "disabled", usable, blocked, pending, account, jarcAdmin, sys, shared,
      registeredAt: dateOf(u.createdAt), lastSignInAt: dateOf(u.lastLoginAt), signedInNow: live.length > 0, lastSeenAt: lastSeen,
      tenantId: u.tenantId, workspaces: Object.freeze(workspaces), membershipRole, memberships: memberOf.length, memberOf: Object.freeze(memberOf),
      personSource, hasAccess: anyAccess || sys
    });
  }

  // ---- Directory join (memoised per snapshot and index)
  // → { rows (directory records with the JARC access values added), byId, summary }.
  joined(snap, state) {
    const hit = state.joined.get(snap);
    if (hit) return hit;
    const rows = [], byId = new Map();
    let registered = 0, disabledWithAccess = 0;
    for (const r of snap.records) {
      const e = state.byOid.get(snap.oidById.get(r.id)) || null;
      const values = Object.freeze({ ...r.values, ...this.valuesOf(e, r.values.accountEnabled) });
      if (e) registered += 1;
      if (values.jarcDisabledWithAccess) disabledWithAccess += 1;
      const row = Object.freeze({ id: r.id, values });
      rows.push(row); byId.set(r.id, row);
    }
    const summary = Object.freeze({ registered, notRegistered: snap.records.length - registered, disabledWithAccess, ambiguous: state.ambiguous, jarcAccountsWithoutDirectoryMatch: state.entraUsers - registered, truncated: state.truncated });
    const out = Object.freeze({ rows: Object.freeze(rows), byId, summary });
    state.joined.set(snap, out);
    return out;
  }

  // The P2 directory fields (fields.js JARC_FIELDS) for one account.
  valuesOf(e, accountEnabled) {
    if (!e) return { jarcAccount: "Not registered", jarcStatus: null, jarcAdmin: null, jarcAccessSource: "None", jarcWorkspaceRole: null, jarcMemberships: null, jarcWorkspaces: null, jarcDisabledWithAccess: false, jarcSignedInNow: false, jarcRegistered: null, jarcLastSignIn: null };
    return {
      jarcAccount: "Registered", jarcStatus: e.status === "active" ? "Active" : "Disabled in JARC", jarcAdmin: ADMIN_LABEL[e.jarcAdmin],
      jarcAccessSource: e.personSource ? SOURCE_LABEL[e.personSource] : "None", jarcWorkspaceRole: e.membershipRole ? ROLE_LABEL[e.membershipRole] : null,
      jarcMemberships: e.memberships, jarcWorkspaces: e.memberOf.length ? e.memberOf : null,
      jarcDisabledWithAccess: this.disabledWithAccess(e, accountEnabled), jarcSignedInNow: e.signedInNow, jarcRegistered: e.registeredAt, jarcLastSignIn: e.lastSignInAt
    };
  }
  // Disabled in Entra AND registered AND usable in JARC AND access to a workspace (or SYSTEM_ADMIN yes).
  disabledWithAccess(e, accountEnabled) { return Boolean(e && accountEnabled === false && e.usable && e.hasAccess); }

  // ---- The access endpoint body for one directory record (service.js checks the dataset, the ID and jarcAccess first).
  detail(snap, state, record) {
    const oid = snap.oidById.get(record.id);
    const e = state.byOid.get(oid) || null;
    const accountEnabled = record.values.accountEnabled;
    const entraDisabledWithAccess = this.disabledWithAccess(e, accountEnabled);
    const notes = [];
    const account = {
      registered: Boolean(e), status: e ? e.status : null, registeredAt: e ? isoOf(e.registeredAt) : null, lastSignInAt: e ? isoOf(e.lastSignInAt) : null,
      lastSignInPrecisionMinutes: LAST_SIGN_IN_PRECISION_MINUTES, signedInNow: e ? e.signedInNow : false, lastSeenAt: e ? isoOf(e.lastSeenAt) : null,
      jarcAdmin: e ? e.jarcAdmin : null,
      accountRole: e && e.account ? { status: e.account.legacy ? "legacy" : e.account.status, role: e.account.role } : null,
      entraEnabled: typeof accountEnabled === "boolean" ? accountEnabled : null, entraDisabledWithAccess, matchedBy: e ? "entra_object_id" : null
    };
    const appPermissions = this.appPermissions(e, oid);
    const workspaces = e ? [...e.workspaces].sort((x, y) => (Boolean(y.effectiveRole) - Boolean(x.effectiveRole)) || byName(x, y)) : [];
    const items = [];
    let total = 0;
    for (const w of workspaces) {
      if (!w.effectiveRole) continue;
      const list = [...(state.boardsByWorkspace.get(w.key) || [])].sort(byName);
      total += list.length;
      for (const b of list) if (items.length < BOARD_ITEMS_MAX) items.push({ name: b.name, workspace: w.name, publicId: b.publicId, archived: b.archived, readOnly: b.readOnly, effectiveRole: w.effectiveRole, source: w.source });
    }
    // Notes: plain-language caveats.
    if (!e) {
      notes.push("This person has never signed in to JARC, so they have no JARC access. An enabled Microsoft account alone grants nothing.");
      if (state.policy.shared) notes.push("Shared access is on: if Microsoft lets this person sign in to JARC, their first sign-in immediately makes them a Workspace admin in every workspace.");
    } else {
      if (e.status !== "active") notes.push("This JARC account is disabled, so it has no access at all.");
      if (e.blocked) notes.push("This JARC account is blocked in Account Management, so it has no access at all.");
      if (e.pending) notes.push("This JARC account is waiting for approval in Account Management, so it has no workspace access yet.");
      if (e.shared) notes.push("Shared access is on (development shared access or beta open editing): every signed-in employee is a Workspace admin in every workspace. It is granted at each check and never stored, so switching it off removes it at once.");
      if (this.access.accountMode !== "enforced" && e.usable) notes.push(e.jarcAdmin === "unknown"
        ? "The JARC administrator role (JARC.Admin) comes from the Microsoft sign-in and is only known while the person has a live JARC session. It is shown as unknown."
        : "The JARC administrator role (JARC.Admin) shown is the one carried by the person's current sign-in; a change in Microsoft Entra takes effect at their next sign-in.");
      notes.push("Managing members and moderating comments need a real active Workspace admin membership or the JARC administrator role; shared access never grants them.");
      notes.push(`The last sign-in time is recorded at most every ${LAST_SIGN_IN_PRECISION_MINUTES} minutes.`);
      if (entraDisabledWithAccess) {
        notes.push("This Microsoft account is disabled, but the JARC account is still active: an open JARC session keeps working until it expires.");
        notes.push("API tokens this person owns keep working, because token owners are checked only against the JARC account status.");
      }
    }
    if (this.access.overridden.length) notes.push("Account Management is enforced, so shared access and beta open editing are switched off.");
    notes.push("JARC has no board-level permissions: every board follows its workspace's role. Synchronized monday.com boards are read-only whatever the role.");
    if (state.capped.users) notes.push("JARC has more accounts than this view reads at once, so matching is unreliable: a person shown as not registered may have a JARC account.");
    else if (state.truncated) notes.push("JARC holds more records than this view reads at once, so this view may be incomplete.");
    if (!this.features.spreadsheetImports) notes.push("Spreadsheet imports are switched off on this server, so nobody can import spreadsheets.");
    return {
      generatedAt: state.generatedAt, stale: Boolean(this.failure), truncated: state.truncated, policy: { ...state.policy }, account, appPermissions,
      workspaces: workspaces.map((w) => ({ name: w.name, archived: w.archived, membership: w.membership ? { ...w.membership } : null, sharedRole: w.sharedRole, effectiveRole: w.effectiveRole, source: w.source, permissions: { ...w.permissions }, boards: w.effectiveRole ? (state.boardsByWorkspace.get(w.key) || []).length : 0 })),
      boards: { total, shown: items.length, items, truncated: total > items.length },
      notes
    };
  }

  appPermissions(e, oid) {
    const sys = Boolean(e && e.sys), shared = Boolean(e && e.shared);
    const unknown = e && e.usable && e.jarcAdmin === "unknown" ? { note: "Depends on the JARC administrator role, unknown until the person signs in." } : {};
    const adminOnly = (key, label) => ({ key, label, granted: sys, source: sys ? "system_admin" : null, ...(sys ? {} : unknown) });
    const sameTenant = Boolean(e && lower(e.tenantId) === this.tenantId && oid);
    const apiAdmin = Boolean(this.apiAdmins && sameTenant && e.usable && this.apiAdmins.has(oid));
    const level = (() => {
      if (!this.employeesConfig || !sameTenant || !e.usable) return "none";
      const x = employeeAccessFor({ kind: "entra", tenantId: e.tenantId, entraObjectId: oid }, this.employeesConfig);
      return x.admin ? "admin" : x.view ? "viewer" : "none";
    })();
    return [
      { key: "manageWorkspaces", label: "Create workspaces", granted: sys || shared, source: sys ? "system_admin" : shared ? "shared" : null, ...(sys || shared ? {} : unknown) },
      { key: "deleteWorkspace", label: "Delete workspaces", granted: sys || shared, source: sys ? "system_admin" : shared ? "shared" : null, ...(sys || shared ? {} : unknown) },
      adminOnly("legacyImport", "Import a legacy JARC backup"),
      this.features.mondayIntegration ? adminOnly("mondayIntegration", "Manage the monday.com integration") : { key: "mondayIntegration", label: "Manage the monday.com integration", granted: false, source: null, note: "Not available: the monday.com integration is off on this server." },
      adminOnly("systemHealth", "View System Health and the activity log"),
      { key: "apiTokenAdmin", label: "Manage JARC API tokens", granted: apiAdmin, source: apiAdmin ? "config" : null, ...(this.apiAdmins ? {} : { note: "API tokens are switched off on this server." }) },
      { key: "employeeDirectory", label: "Employee Management", granted: level !== "none", source: level !== "none" ? "config" : null, level }
    ];
  }
}

module.exports = { JarcAccessIndex, TTL_MS, BOARD_ITEMS_MAX };
