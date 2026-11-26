// Employee Management P3 (Access Administration): the Employee Management administrator (EMPLOYEE_ADMIN_OIDS) grants, suspends,
// restores and revokes a person's JARC access and manages their workspace memberships, from the directory profile. Only with
// JARC_FEATURE_EMPLOYEE_ACCESS_ADMIN=true (config.employees.accessAdmin); router.js mounts the paths and refuses everyone else.
//
// Layers (P3 contract §1). Microsoft Entra ID is never written: the directory snapshot is read-only. What changes:
//   users.status       active / suspended / revoked. Every server check is `=== "active"`, so suspended and revoked refuse
//                      sign-in, sessions, live updates and API / Fabric tokens with no other change.
//   users documents    created only for someone not registered: Grant pre-provisions an active document, Revoke writes a
//                      revoked one so the first sign-in is refused instead of auto-provisioned. Never deleted.
//   workspaceMembers   through the existing MembershipService (its transaction, duplicate and last-admin guards).
//
// State machine (§2): not_registered → grant → active | revoke → revoked; active → suspend → suspended | revoke → revoked;
// suspended → restore → active | revoke → revoked; revoked → grant → active. A users.status written outside P3 (any other value,
// shown "disabled") may be restored or revoked. Anything else is 409 INVALID_TRANSITION.
//
// Each account action is one transaction: the administrator is re-read (still active), the target is read by its identity
// (configured tenant + the directory object ID, both lower case: never from the request), its users.accessVersion must equal
// expectedVersion, the change is a conditional findOneAndUpdate on { _id, status, accessVersion }, revoking also revokes the
// person's active JARC API and Fabric API tokens (each recorded in the token audit, as an API administrator's revoke is), and the
// accountAudit entry is appended. Sessions end after the commit. The access index (jarc-access.js) is invalidated after every
// write.
//
// Guards (§3): self-lockout (nobody suspends or revokes their own account), the last Employee Management administrator (a listed
// administrator can't be suspended or revoked when no other listed administrator would stay active), the members-route
// authority for memberships (access.workspace(actor, ws, "WORKSPACE_ADMIN", { membershipOnly: true }); no new policy).
// Every refused write is recorded as employee.access.rejected with a code and the attempted action, never the request body.
//
// No raw IDs leave the server: the person is the opaque profile ID, a workspace is workspaceRef (HMAC of its _id with the profile
// ID key), history cursors are encrypted. Logs carry error classes only.
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { accountOf, isActiveSuperAdmin, WORKSPACE_CAP, WORKSPACE_RANK } = require("../auth/accounts");
const { ROLES } = require("../repositories/mongo/membership-repository");
const { FABRIC_PRODUCT } = require("../repositories/mongo/api-token-repository");
const { ID_PATTERN } = require("./ids");
const { employeeError, describe } = require("./errors");

const SOURCE = "employee_management";
const CONTROL = /[\u0000-\u001f\u007f]/;
const REF_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ACCOUNT_ACTIONS = Object.freeze(["grant", "suspend", "restore", "revoke"]);
const CONFIRM_REVOKE = "REVOKE";
const ENTRA_DISABLED_REASON = "Disabled in Microsoft Entra ID";
const TOKEN_REVOKE_REASON = "JARC access revoked in Employee Management";
const TOKEN_LIST_MAX = 5000; // active tokens per owner and product (the issue limit keeps the real number far lower)
const STATES = Object.freeze(["not_registered", "active", "suspended", "revoked", "disabled"]);
const HISTORY = Object.freeze({ defaultLimit: 50, maxLimit: 100, maxCursor: 200 });
// state → action → new users.status
const TRANSITIONS = Object.freeze({
  not_registered: Object.freeze({ grant: "active", revoke: "revoked" }),
  active: Object.freeze({ suspend: "suspended", revoke: "revoked" }),
  suspended: Object.freeze({ restore: "active", revoke: "revoked" }),
  revoked: Object.freeze({ grant: "active" }),
  disabled: Object.freeze({ restore: "active", revoke: "revoked" })
});
const AUDIT_ACTION = Object.freeze({ grant: "employee.access.granted", suspend: "employee.access.suspended", restore: "employee.access.restored", revoke: "employee.access.revoked" });
const MEMBERSHIP_ONLY = Object.freeze({ membershipOnly: true });

const MESSAGES = Object.freeze({
  INVALID_TRANSITION: "This change isn't possible from the person's current JARC access. Reload and try again.",
  CONFLICT: "Someone else changed this person's JARC access. Reload and try again.",
  SELF_LOCKOUT: "You can't suspend or revoke your own JARC access.",
  LAST_EMPLOYEE_ADMIN: "This person is an Employee Management administrator, and no other administrator would keep JARC access.",
  NOT_REGISTERED: "This person has no JARC account. Grant JARC access first.",
  ACCOUNT_NOT_ACTIVE: "This person's JARC access isn't active. Restore or grant it first.",
  ALREADY_MEMBER: "This person is already a member of that workspace.",
  NOT_MEMBER: "This person isn't a member of that workspace.",
  LAST_WORKSPACE_ADMIN: "A workspace needs at least one admin. Make someone else an admin of that workspace first.",
  WORKSPACE_ADMIN_REQUIRED: "Only that workspace's admins (or a JARC administrator) can manage its members.",
  WORKSPACE_NOT_FOUND: "That workspace doesn't exist.",
  ROLE_NOT_ALLOWED: "That role isn't allowed for this person's JARC account."
});
const STATUS = Object.freeze({ INVALID_TRANSITION: 409, CONFLICT: 409, SELF_LOCKOUT: 403, LAST_EMPLOYEE_ADMIN: 409, NOT_REGISTERED: 409, ACCOUNT_NOT_ACTIVE: 409, ALREADY_MEMBER: 409, NOT_MEMBER: 404, LAST_WORKSPACE_ADMIN: 409, WORKSPACE_ADMIN_REQUIRED: 403, WORKSPACE_NOT_FOUND: 404, ROLE_NOT_ALLOWED: 400 });
const p3Error = (code) => new ApiError(STATUS[code], code, MESSAGES[code]);
const invalid = (message, path) => new ApiError(400, "VALIDATION_ERROR", message, path ? { path } : undefined);

const hex = (id) => (id && typeof id.toHexString === "function" ? id.toHexString() : String(id));
const iso = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null);
const lower = (v) => (typeof v === "string" ? v.toLowerCase() : null);
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const stateOf = (user) => (!user ? "not_registered" : ["active", "suspended", "revoked"].includes(user.status) ? user.status : "disabled");
const versionOf = (user) => (user && Number.isSafeInteger(user.accessVersion) && user.accessVersion > 0 ? user.accessVersion : 0);
const byName = (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const isLastAdminError = (error) => error?.status === 400 && /needs at least one admin/i.test(String(error.message || ""));
const primitive = (v) => (v === null || ["string", "number", "boolean"].includes(typeof v) ? (typeof v === "string" ? v.slice(0, 200) : v) : null);

function body(raw, allowed) {
  if (!isPlain(raw)) throw invalid("Send a JSON object.");
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw invalid("Unknown field in the request.", "body");
  return raw;
}
// Reason: 3 to 500 characters after trimming, no control characters (line breaks included).
function reasonOf(value, required) {
  if (value === undefined || value === null) { if (required) throw invalid("A reason is required (3 to 500 characters).", "reason"); return null; }
  if (typeof value !== "string") throw invalid("reason must be text.", "reason");
  const t = value.trim();
  if (t.length < 3 || t.length > 500 || CONTROL.test(t)) throw invalid("The reason must be 3 to 500 characters, without line breaks or control characters.", "reason");
  return t;
}
function roleOf(value) { if (!ROLES.includes(value)) throw invalid(`role must be one of: ${ROLES.join(", ")}.`, "role"); return value; }
function refOf(value) { if (typeof value !== "string" || !REF_PATTERN.test(value)) throw p3Error("WORKSPACE_NOT_FOUND"); return value; }

class AccessAdminService {
  // employees: createEmployees(...) ({ service, snapshot, config }); jarcAccess: the JarcAccessIndex; repos / connection /
  // services: dataLayer (users, memberships, workspaces, sessions, accountAudit, apiTokens; services.members); access: the app's
  // Access; tenantId: ENTRA_TENANT_ID.
  constructor({ employees, jarcAccess, repos, connection, members, access, tenantId, idKey = employees?.snapshot?.idKey, logger = console, now = () => new Date() }) {
    if (!employees?.service || !employees?.snapshot) throw new Error("AccessAdminService needs createEmployees(...).");
    if (!jarcAccess || typeof jarcAccess.invalidate !== "function") throw new Error("AccessAdminService needs the JARC access index.");
    for (const r of ["users", "memberships", "workspaces", "sessions", "accountAudit", "apiTokens"]) if (!repos?.[r]) throw new Error("AccessAdminService needs the JARC repositories.");
    if (!connection || typeof connection.withTransaction !== "function") throw new Error("AccessAdminService needs the database connection.");
    if (!members) throw new Error("AccessAdminService needs the membership service.");
    if (!access || typeof access.shared !== "boolean") throw new Error("AccessAdminService needs the app's Access instance.");
    if (!tenantId) throw new Error("AccessAdminService needs the tenant ID.");
    if (!Buffer.isBuffer(idKey) || idKey.length < 16) throw new Error("AccessAdminService needs the profile ID key.");
    Object.assign(this, { employees, jarcAccess, repos, connection, members, access, logger, now });
    this.tenantId = lower(tenantId);
    Object.defineProperty(this, "keys", { enumerable: false, value: Object.freeze({
      workspace: crypto.createHmac("sha256", idKey).update("jarc-employee-workspace-ref:v1").digest(),
      cursor: crypto.createHmac("sha256", idKey).update("jarc-employee-history-cursor:v1").digest()
    }) });
  }

  // The listed Employee Management administrators (lower case, read each time: the list comes from configuration).
  adminOids() { return (this.employees.config.adminObjectIds || []).map(lower).filter(Boolean); }
  workspaceRef(id) { return crypto.createHmac("sha256", this.keys.workspace).update(hex(id)).digest("base64url").slice(0, 22); }

  // ---- Target: a directory record in the current snapshot, in a dataset this administrator may read.
  async target(dsName, id, access) {
    const ds = this.employees.service.dataset(dsName, access);
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw employeeError("NOT_FOUND");
    const snap = await this.employees.snapshot.current();
    const record = snap.byId.get(id);
    if (!record || !ds.base(record)) throw employeeError("NOT_FOUND");
    const oid = snap.oidById.get(id);
    if (!oid) throw employeeError("NOT_FOUND");
    return { ds, snap, record, oid };
  }
  findUser(oid, session) { return this.repos.users.findEntraIdentity(this.tenantId, oid, session ? { session } : {}); }
  async workspaces() { return (await this.repos.workspaces.listForAccessIndex()).map((w) => ({ _id: w._id, name: typeof w.name === "string" && w.name.trim() ? w.name.trim().slice(0, 200) : "Untitled workspace", archived: w.archived === true, ref: this.workspaceRef(w._id) })); }
  async workspaceByRef(ref) {
    const found = (await this.workspaces()).find((w) => w.ref === ref);
    if (!found) throw p3Error("WORKSPACE_NOT_FOUND");
    return found;
  }

  // ---- Guards (shared by the GET's actions list and the writes).
  // → null when allowed, else the refusal code. ctx: { state, isSelf, isEmployeeAdmin, othersActive }.
  refusal(action, ctx) {
    if (!TRANSITIONS[ctx.state]?.[action]) return "INVALID_TRANSITION";
    if (action === "suspend" || action === "revoke") {
      if (ctx.isSelf) return "SELF_LOCKOUT";
      if (ctx.isEmployeeAdmin && ctx.othersActive < 1) return "LAST_EMPLOYEE_ADMIN";
    }
    return null;
  }
  othersActive(oid, session) { return this.repos.users.countActiveIdentities(this.tenantId, this.adminOids().filter((x) => x !== oid), session ? { session } : {}); }

  // ---- GET /:ds/records/:id/manage-access
  async manageAccess(dsName, id, access, actor) {
    const { snap, record, oid } = await this.target(dsName, id, access);
    const now = this.now();
    const user = await this.findUser(oid);
    const state = stateOf(user);
    const isSelf = Boolean(user && user._id.equals(actor.userId)) || (lower(actor.entraObjectId) === oid && lower(actor.tenantId) === this.tenantId);
    const isEmployeeAdmin = this.adminOids().includes(oid);
    const othersActive = isEmployeeAdmin ? await this.othersActive(oid) : 1;
    const entraEnabled = typeof record.values.accountEnabled === "boolean" ? record.values.accountEnabled : null;
    // Effective roles and live sessions come from the access index (refreshed after every P3 write).
    let entry = null, index = null;
    try { index = await this.jarcAccess.current(); entry = this.jarcAccess.entryOf(snap, index, record); } catch (error) { if (error?.code !== "EMPLOYEES_UNAVAILABLE") throw error; }
    const [workspaces, memberships, mine, jarcActive, fabricActive, liveSessions] = await Promise.all([
      this.workspaces(),
      user ? this.repos.memberships.listForUser(user._id) : [],
      actor.isSystemAdmin ? [] : this.repos.memberships.listForUser(actor.userId),
      user ? this.repos.apiTokens.countActive(user._id, now) : 0,
      user ? this.repos.apiTokens.countActive(user._id, now, { product: FABRIC_PRODUCT }) : 0,
      // Read directly (not from the index, which may be up to a minute old): whether the person is signed in right now.
      user && state === "active" ? this.repos.sessions.countLiveForUser(user._id, { tenantId: user.tenantId, objectId: user.entraObjectId }, now) : 0
    ]);
    const memberOf = new Map(memberships.map((m) => [hex(m.workspaceId), m]));
    const myRole = new Map(mine.map((m) => [hex(m.workspaceId), this.access.effective(actor, m.role)]));
    const effective = new Map((entry?.workspaces || []).map((w) => [w.key, w.effectiveRole]));
    const usable = state === "active";
    const shared = this.access.shared;
    const rows = [];
    for (const w of workspaces) {
      const m = memberOf.get(hex(w._id)) || null;
      const lastAdmin = Boolean(m && m.role === "WORKSPACE_ADMIN" && await this.repos.memberships.countActiveAdmins(w._id) <= 1);
      rows.push({
        workspaceRef: w.ref, name: w.name, archived: w.archived,
        membership: m ? { role: m.role, status: m.status === "active" ? "active" : "invited" } : null,
        sharedRole: usable && shared ? "WORKSPACE_ADMIN" : null,
        effectiveRole: usable ? (effective.get(hex(w._id)) ?? (shared ? "WORKSPACE_ADMIN" : m?.role ?? null)) : null,
        canManage: Boolean(actor.isSystemAdmin) || myRole.get(hex(w._id)) === "WORKSPACE_ADMIN",
        lastAdmin
      });
    }
    rows.sort(byName);
    // Workspaces where this person is the only Workspace admin whose JARC account is active: suspending or revoking them
    // leaves the workspace with no usable admin (the last-admin guard counts memberships, not account status). A warning only.
    const soleAdminOf = [];
    for (const w of workspaces) {
      const m = memberOf.get(hex(w._id));
      if (!m || m.role !== "WORKSPACE_ADMIN" || m.status !== "active") continue;
      const others = (await this.repos.memberships.listByWorkspace(w._id)).filter((x) => x.role === "WORKSPACE_ADMIN" && x.status === "active" && !x.userId.equals(user._id));
      const activeOthers = others.length ? (await this.repos.users.findByIds(others.map((x) => x.userId))).filter((u) => u.status === "active").length : 0;
      if (!activeOthers) soleAdminOf.push(w.name);
    }
    soleAdminOf.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true }));
    const soleAdminWarning = soleAdminOf.length ? { code: "LAST_WORKSPACE_ADMIN_OF", message: `This person is the only active Workspace admin of: ${soleAdminOf.join(", ")}. Suspending or revoking them leaves ${soleAdminOf.length === 1 ? "that workspace" : "those workspaces"} without a usable admin; make someone else an admin first.`, workspaces: soleAdminOf } : null;
    const ctx = { state, isSelf, isEmployeeAdmin, othersActive };
    const actions = ACCOUNT_ACTIONS.map((action) => {
      const code = this.refusal(action, ctx);
      const ending = action === "suspend" || action === "revoke";
      return code ? { action, allowed: false, code, reason: MESSAGES[code] } : { action, allowed: true, ...(ending ? { reasonRequired: true } : {}), ...(action === "revoke" ? { confirm: CONFIRM_REVOKE } : {}), ...(ending && soleAdminWarning ? { warnings: [soleAdminWarning] } : {}) };
    });
    const snapshot = this.employees.snapshot.meta();
    const warnings = [];
    if (soleAdminWarning) warnings.push(soleAdminWarning);
    // JARC administrator: a live JARC.Admin session (the access index), or an active Super Admin account (Account Management).
    const superAdmin = Boolean(user && user.account && isActiveSuperAdmin(accountOf(user)));
    if (usable && (entry?.jarcAdmin === "yes" || superAdmin)) warnings.push({ code: "TARGET_JARC_ADMIN", message: "This person is a JARC administrator (a live JARC.Admin sign-in or an active Super Admin account). Suspending or revoking them removes that administrator's access." });
    if (record.values.accountType === "Guest") warnings.push({ code: "TARGET_GUEST", message: "This is a guest account from another organisation. Check before granting it JARC access." });
    if (snapshot.stale) warnings.push({ code: "SNAPSHOT_STALE", message: "The directory snapshot is out of date. Actions still work, but check the person's Microsoft account details before changing their access." });
    if (entraEnabled === false && usable) warnings.push({ code: "ENTRA_DISABLED_WITH_ACCESS", message: "This Microsoft account is disabled, but the JARC access is still active: an open JARC session and their API tokens keep working until JARC access is suspended. Nothing is changed automatically." });
    if (state === "not_registered" && shared) warnings.push({ code: "SHARED_FIRST_SIGN_IN", message: "Shared access is on: if Microsoft lets this person sign in to JARC, their first sign-in makes them a Workspace admin in every workspace. Revoke blocks that first sign-in." });
    if (state === "suspended") warnings.push({ code: "TOKENS_RETURN_ON_RESTORE", message: "While suspended, this person's API tokens are refused. Restoring access makes unexpired tokens usable again." });
    if (state === "revoked") warnings.push({ code: "MEMBERSHIPS_INERT", message: "Access is revoked. Workspace memberships are kept but grant nothing. Granting access again doesn't bring back revoked API tokens." });
    if (isEmployeeAdmin) warnings.push({ code: "EMPLOYEE_ADMIN", message: "This person is an Employee Management administrator. The last active administrator can't be suspended or revoked." });
    if (index?.truncated) warnings.push({ code: "INDEX_TRUNCATED", message: "JARC holds more records than this view reads at once, so the effective roles may be incomplete." });
    if (!index) warnings.push({ code: "INDEX_UNAVAILABLE", message: "Effective roles and live sessions can't be read right now." });
    return {
      id: record.id, version: versionOf(user),
      account: {
        state, provisioned: Boolean(user && user.provisionedAt instanceof Date && !(user.lastLoginAt instanceof Date)), signedInNow: liveSessions > 0,
        isSelf, isEmployeeAdmin, entraEnabled, statusChangedAt: user ? iso(user.statusChangedAt) : null, statusReason: user && typeof user.statusReason === "string" ? user.statusReason : null,
        ...(entraEnabled === false ? { suggestedSuspendReason: ENTRA_DISABLED_REASON } : {})
      },
      actions,
      tokens: { jarcActive, fabricActive },
      workspaces: rows,
      sharedAccess: { on: shared, note: shared ? "Shared access is on: every signed-in employee is a Workspace admin in every workspace. Removing or demoting a membership takes away only member management and comment moderation; only Suspend and Revoke remove access." : "Shared access is off: workspace memberships decide what this person can see and change." },
      warnings,
      snapshot: { stale: snapshot.stale, ...(snapshot.staleReason ? { staleReason: snapshot.staleReason } : {}), ingestedAt: snapshot.ingestedAt, checkedAt: snapshot.checkedAt }
    };
  }

  // ---- Rejections: recorded best-effort after the refusal (outside any rolled-back transaction).
  async rejected(error, ctx, actor, attempted) {
    if (!(error instanceof ApiError) || error.status >= 500 || error.status === 429) return;
    try {
      await this.repos.accountAudit.append({ action: "employee.access.rejected", targetUserId: ctx.targetUserId ?? null, actorUserId: actor.userId, actorName: actor.displayName ?? null, changes: [], workspaceId: ctx.workspaceId ?? null, result: "rejected", code: /^[A-Z_]{1,40}$/.test(error.code) ? error.code : "REJECTED", source: SOURCE, targetRef: ctx.targetRef ?? null, attempted, at: this.now() });
    } catch (e) {
      this.logger.error?.(`[employees] couldn't record a refused access change: ${describe(e)}`);
    }
  }
  async guard(attempted, actor, ctx, fn) {
    try { return await fn(); } catch (error) { await this.rejected(error, ctx, actor, attempted); throw error; }
  }

  // ---- POST /:ds/records/:id/access { action, expectedVersion, reason?, confirm? }
  async changeAccess(dsName, id, raw, access, actor) {
    const ctx = { targetRef: typeof id === "string" && ID_PATTERN.test(id) ? id : null };
    const attempted = isPlain(raw) && ACCOUNT_ACTIONS.includes(raw.action) ? raw.action : null;
    return this.guard(attempted, actor, ctx, async () => {
      const b = body(raw, ["action", "expectedState", "expectedVersion", "reason", "confirm"]);
      if (!ACCOUNT_ACTIONS.includes(b.action)) throw invalid(`action must be one of: ${ACCOUNT_ACTIONS.join(", ")}.`, "action");
      const action = b.action;
      if (!STATES.includes(b.expectedState)) throw invalid(`expectedState must be the state you loaded (${STATES.join(", ")}).`, "expectedState");
      if (!Number.isSafeInteger(b.expectedVersion) || b.expectedVersion < 0) throw invalid("expectedVersion must be the version you loaded (a whole number).", "expectedVersion");
      const reason = reasonOf(b.reason, action === "suspend" || action === "revoke");
      if (action === "revoke" ? b.confirm !== CONFIRM_REVOKE : b.confirm !== undefined) throw invalid(action === "revoke" ? `Type ${CONFIRM_REVOKE} to confirm.` : "confirm is only used to revoke.", "confirm");
      const { record, oid } = await this.target(dsName, id, access);
      const now = this.now();
      const isEmployeeAdmin = this.adminOids().includes(oid);
      const done = await this.connection.withTransaction(async (session) => {
        const me = await this.repos.users.findByIdIn(actor.userId, { session });
        if (!me || me.status !== "active") throw employeeError("EMPLOYEES_FORBIDDEN");
        const user = await this.findUser(oid, session);
        ctx.targetUserId = user?._id ?? null;
        const state = stateOf(user);
        const isSelf = Boolean(user && user._id.equals(actor.userId));
        if (state !== b.expectedState || versionOf(user) !== b.expectedVersion) throw p3Error("CONFLICT");
        const othersActive = isEmployeeAdmin && (action === "suspend" || action === "revoke") ? await this.othersActive(oid, session) : 1;
        const code = this.refusal(action, { state, isSelf, isEmployeeAdmin, othersActive });
        if (code) throw p3Error(code);
        // Two administrators acting on each other at once conflict on this write (one transaction is retried, then refused).
        if (isEmployeeAdmin) await this.repos.users.touchAccessActor(actor.userId, now, { session });
        const to = TRANSITIONS[state][action];
        let doc;
        if (!user) {
          // ACCOUNT_MANAGEMENT staged / enforced: a pending account with no role, exactly as a first sign-in creates one
          // (user-repository.js signInFromEntra trackAccounts), recorded as account.created. Off: no account (as today).
          const tracking = this.access.accountMode !== "off";
          try {
            doc = await this.repos.users.provisionEntra({ tenantId: this.tenantId, entraObjectId: oid, displayName: record.values.displayName || null, email: record.values.mail || null, status: to, reason, by: actor.userId, now, trackAccounts: tracking }, { session });
          } catch (error) { if (error?.code === 11000) throw p3Error("CONFLICT"); throw error; }
          if (tracking) await this.repos.accountAudit.append({ action: "account.created", targetUserId: doc._id, actorUserId: actor.userId, actorName: actor.displayName ?? null, changes: [{ field: "status", from: null, to: "pending" }], at: now }, { session });
        } else {
          doc = await this.repos.users.setAccessStatus(user._id, { fromStatus: user.status, expectedVersion: b.expectedVersion, status: to, reason, now }, { session });
          if (!doc) throw p3Error("CONFLICT");
        }
        ctx.targetUserId = doc._id;
        const tokens = action === "revoke" && user ? await this.revokeTokens(doc._id, actor, now, session) : { jarc: 0, fabric: 0 };
        const auditAction = !user && action === "grant" ? "employee.access.provisioned" : AUDIT_ACTION[action];
        await this.repos.accountAudit.append({ action: auditAction, targetUserId: doc._id, actorUserId: actor.userId, actorName: actor.displayName ?? null, changes: [{ field: "status", from: user ? user.status : null, to }], result: "ok", reason, source: SOURCE, targetRef: record.id, at: now }, { session });
        return { userId: doc._id, from: state, to, tokens };
      });
      // After the commit: every session ends at once (each request would refuse it anyway, auth/session.js).
      let sessionsEnded = 0;
      if (done.to !== "active") {
        try { sessionsEnded = await this.repos.sessions.removeForUser(done.userId); } catch (error) { this.logger.error?.(`[employees] couldn't end sessions after an access change: ${describe(error)}`); }
      }
      // A second sweep after the commit: a token issued while the transaction ran (the owner was still active then) is revoked
      // and audited the same way. Best-effort: the owner is revoked, so such a token is refused on use anyway.
      if (done.to === "revoked" && action === "revoke" && done.from !== "not_registered") {
        try {
          const late = await this.revokeTokens(done.userId, actor, this.now(), undefined);
          done.tokens.jarc += late.jarc; done.tokens.fabric += late.fabric;
        } catch (error) { this.logger.error?.(`[employees] couldn't finish revoking tokens after an access change: ${describe(error)}`); }
      }
      this.jarcAccess.invalidate();
      return { manageAccess: await this.manageAccess(dsName, id, access, actor), result: { action, from: done.from, to: done.to, sessionsEnded, tokensRevoked: done.tokens } };
    });
  }

  // The person's active JARC API and Fabric API tokens are revoked in the same transaction, through the token repository's own
  // revoke (revokedAt + revokedByUserId) and audit (token.revoked with a reason), exactly as an API administrator's revoke.
  // Only the active tokens are read (revokedAt null, not expired), each product on its own, in the transaction.
  async revokeTokens(ownerUserId, actor, now, session) {
    const counts = { jarc: 0, fabric: 0 };
    for (const product of [undefined, FABRIC_PRODUCT]) {
      const docs = await this.repos.apiTokens.listActiveForOwner(ownerUserId, now, { limit: TOKEN_LIST_MAX, ...(product ? { product } : {}), ...(session ? { session } : {}) });
      for (const d of docs) {
        if (d.revokedAt || !(d.expiresAt > now)) continue;
        const revoked = await this.repos.apiTokens.revokeAny(d._id, actor.userId, now, { session, ...(product ? { product } : {}) });
        if (!revoked) continue;
        await this.repos.apiTokens.appendAudit({ action: "token.revoked", tokenId: d._id, ownerUserId, actorUserId: actor.userId, actorName: actor.displayName ?? null, workspaceId: revoked.workspaceId ?? null, workspaceIds: revoked.workspaceIds ?? null, reason: TOKEN_REVOKE_REASON, product: product ?? null, at: now }, { session });
        counts[product ? "fabric" : "jarc"] += 1;
      }
    }
    return counts;
  }

  // ---- Memberships (MembershipService; the members route's authority check).
  async membershipTarget(dsName, id, access, ctx, { requireActive = false } = {}) {
    const t = await this.target(dsName, id, access);
    const user = await this.findUser(t.oid);
    ctx.targetUserId = user?._id ?? null;
    if (!user) throw p3Error("NOT_REGISTERED");
    if (requireActive && user.status !== "active") throw p3Error("ACCOUNT_NOT_ACTIVE");
    return { ...t, user };
  }
  async authority(actor, workspace, ctx) {
    ctx.workspaceId = workspace._id;
    const me = await this.repos.users.findById(actor.userId);
    if (!me || me.status !== "active") throw employeeError("EMPLOYEES_FORBIDDEN");
    try { await this.access.workspace(actor, workspace._id, "WORKSPACE_ADMIN", MEMBERSHIP_ONLY); } catch (error) {
      if (error?.status === 403 || error?.status === 404) throw p3Error(error.status === 404 ? "WORKSPACE_NOT_FOUND" : "WORKSPACE_ADMIN_REQUIRED");
      throw error;
    }
  }
  // ACCOUNT_MANAGEMENT=enforced only (as routes/members.js): approved accounts, and no role above the account's cap.
  assignable(user, role) {
    if (!this.access.enforced) return;
    const account = accountOf(user);
    if (account.legacy) return;
    if (account.status !== "active" || WORKSPACE_RANK[role] > WORKSPACE_RANK[WORKSPACE_CAP[account.role]]) throw p3Error("ROLE_NOT_ALLOWED");
  }
  // The MembershipService change and its accountAudit entry in ONE transaction (the service runs in the outer session), so an
  // audit failure rolls the membership change back.
  async membershipChange(action, actor, user, record, workspace, changes, apply) {
    await this.connection.withTransaction(async (session) => {
      await apply(session);
      await this.repos.accountAudit.append({ action, targetUserId: user._id, actorUserId: actor.userId, actorName: actor.displayName ?? null, changes, workspaceId: workspace._id, result: "ok", source: SOURCE, targetRef: record.id, at: this.now() }, { session });
    });
  }

  // POST /:ds/records/:id/memberships { workspaceRef, role }
  async addMembership(dsName, id, raw, access, actor) {
    const ctx = { targetRef: typeof id === "string" && ID_PATTERN.test(id) ? id : null };
    return this.guard("membership_add", actor, ctx, async () => {
      const b = body(raw, ["workspaceRef", "role"]);
      const role = roleOf(b.role);
      const ref = refOf(b.workspaceRef);
      const { record, user } = await this.membershipTarget(dsName, id, access, ctx, { requireActive: true });
      const workspace = await this.workspaceByRef(ref);
      await this.authority(actor, workspace, ctx);
      this.assignable(user, role);
      await this.membershipChange("employee.membership.added", actor, user, record, workspace, [{ field: "workspaceRole", from: null, to: role }], async (session) => {
        try { await this.members.add(workspace._id, { userId: hex(user._id), role }, actor, { session }); } catch (error) {
          if (error?.status === 409) throw p3Error("ALREADY_MEMBER");
          if (error?.status === 400) throw p3Error("ACCOUNT_NOT_ACTIVE");
          if (error?.status === 404) throw p3Error("NOT_REGISTERED");
          throw error;
        }
      });
      this.jarcAccess.invalidate();
      return { manageAccess: await this.manageAccess(dsName, id, access, actor) };
    });
  }

  // PATCH /:ds/records/:id/memberships/:workspaceRef { role }
  async changeMembership(dsName, id, refParam, raw, access, actor) {
    const ctx = { targetRef: typeof id === "string" && ID_PATTERN.test(id) ? id : null };
    return this.guard("membership_role", actor, ctx, async () => {
      const b = body(raw, ["role"]);
      const role = roleOf(b.role);
      const ref = refOf(refParam);
      const { record, user } = await this.membershipTarget(dsName, id, access, ctx);
      const workspace = await this.workspaceByRef(ref);
      await this.authority(actor, workspace, ctx);
      const current = await this.repos.memberships.findActive(workspace._id, user._id);
      if (!current) throw p3Error("NOT_MEMBER");
      if (current.role !== role) {
        this.assignable(user, role);
        await this.membershipChange("employee.membership.role_changed", actor, user, record, workspace, [{ field: "workspaceRole", from: current.role, to: role }], async (session) => {
          try { await this.members.changeRole(workspace._id, current._id, { role }, actor, { session }); } catch (error) {
            if (isLastAdminError(error)) throw p3Error("LAST_WORKSPACE_ADMIN");
            if (error?.status === 404) throw p3Error("NOT_MEMBER");
            throw error;
          }
        });
        this.jarcAccess.invalidate();
      }
      return { manageAccess: await this.manageAccess(dsName, id, access, actor) };
    });
  }

  // DELETE /:ds/records/:id/memberships/:workspaceRef
  async removeMembership(dsName, id, refParam, raw, access, actor) {
    const ctx = { targetRef: typeof id === "string" && ID_PATTERN.test(id) ? id : null };
    return this.guard("membership_remove", actor, ctx, async () => {
      if (raw !== undefined && !(isPlain(raw) && !Object.keys(raw).length)) throw invalid("This request takes no body.", "body");
      const ref = refOf(refParam);
      const { record, user } = await this.membershipTarget(dsName, id, access, ctx);
      const workspace = await this.workspaceByRef(ref);
      await this.authority(actor, workspace, ctx);
      const current = await this.repos.memberships.findActive(workspace._id, user._id);
      if (!current) throw p3Error("NOT_MEMBER");
      await this.membershipChange("employee.membership.removed", actor, user, record, workspace, [{ field: "workspaceRole", from: current.role, to: null }], async (session) => {
        try { await this.members.remove(workspace._id, current._id, actor, { session }); } catch (error) {
          if (isLastAdminError(error)) throw p3Error("LAST_WORKSPACE_ADMIN");
          if (error?.status === 404) throw p3Error("NOT_MEMBER");
          throw error;
        }
      });
      this.jarcAccess.invalidate();
      return { manageAccess: await this.manageAccess(dsName, id, access, actor) };
    });
  }

  // ---- GET /:ds/records/:id/access-history?limit=1..100&before=<cursor>
  // Cursor: AES-256-GCM over { at, id } of the page's last entry, bound to the profile ID (so it can't be replayed for another
  // person) and opaque (no entry ID is readable from it).
  encodeCursor(entry, ref) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.keys.cursor, iv);
    c.setAAD(Buffer.from(ref));
    const data = Buffer.concat([c.update(JSON.stringify({ t: entry.at.getTime(), i: hex(entry._id) })), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64url");
  }
  decodeCursor(text, ref) {
    const bad = () => invalid("before is not valid.", "before");
    if (typeof text !== "string" || !text.length || text.length > HISTORY.maxCursor || !/^[A-Za-z0-9_-]+$/.test(text)) throw bad();
    try {
      const raw = Buffer.from(text, "base64url");
      const d = crypto.createDecipheriv("aes-256-gcm", this.keys.cursor, raw.subarray(0, 12));
      d.setAAD(Buffer.from(ref));
      d.setAuthTag(raw.subarray(12, 28));
      const { t, i } = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
      if (!Number.isSafeInteger(t) || typeof i !== "string" || !/^[0-9a-f]{24}$/.test(i)) throw bad();
      return { at: new Date(t), id: ObjectId.createFromHexString(i) };
    } catch { throw bad(); }
  }
  async history(dsName, id, query, access) {
    const q = query || {};
    for (const key of Object.keys(q)) {
      if (key !== "limit" && key !== "before") throw invalid("Unknown parameter.", "query");
      if (typeof q[key] !== "string") throw invalid("Each parameter can be given once.", "query");
    }
    let limit = HISTORY.defaultLimit;
    if (q.limit !== undefined) {
      if (!/^\d{1,3}$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > HISTORY.maxLimit) throw invalid(`limit must be a whole number from 1 to ${HISTORY.maxLimit}.`, "limit");
      limit = Number(q.limit);
    }
    const { record, oid } = await this.target(dsName, id, access);
    const before = q.before !== undefined ? this.decodeCursor(q.before, record.id) : null;
    const user = await this.findUser(oid);
    const rows = await this.repos.accountAudit.listForTarget({ targetUserId: user?._id ?? null, targetRef: record.id, before, limit: limit + 1 });
    const more = rows.length > limit;
    const shown = rows.slice(0, limit);
    const names = shown.some((r) => r.workspaceId) ? new Map((await this.workspaces()).map((w) => [hex(w._id), w.name])) : new Map();
    const items = shown.map((r) => ({
      at: iso(r.at), action: r.action, result: r.result === "rejected" ? "rejected" : "ok",
      actor: typeof r.actorName === "string" ? r.actorName.slice(0, 200) : r.actorUserId ? null : "JARC",
      changes: Array.isArray(r.changes) ? r.changes.slice(0, 10).map((c) => ({ field: typeof c?.field === "string" ? c.field.slice(0, 60) : null, from: primitive(c?.from ?? null), to: primitive(c?.to ?? null) })) : [],
      ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
      ...(typeof r.code === "string" ? { code: r.code } : {}),
      ...(typeof r.attempted === "string" ? { attempted: r.attempted } : {}),
      ...(r.workspaceId ? { workspace: names.get(hex(r.workspaceId)) ?? "Deleted workspace" } : {})
    }));
    const last = shown.at(-1);
    return { id: record.id, items, nextBefore: more && last ? this.encodeCursor(last, record.id) : null };
  }
}

module.exports = { AccessAdminService, TRANSITIONS, CONFIRM_REVOKE, ENTRA_DISABLED_REASON, MESSAGES };
