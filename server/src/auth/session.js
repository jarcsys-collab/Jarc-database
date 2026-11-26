// AUTH_MODE=entra server-managed sessions.
//
//   cookie   __Host-jarc_session: 256-bit random secret; HttpOnly, Secure, SameSite=Strict, Path=/, no Domain
//            (the __Host- prefix makes the browser enforce those). Only its SHA-256 hash is stored server-side.
//   expiry   idle timeout (sliding) and an absolute maximum lifetime, both checked on every request.
//   CSRF     every state-changing request (POST/PUT/PATCH/DELETE) must send X-CSRF-Token = a value derived from the
//            session secret (the page gets it from GET /api/v1/auth/session, which other sites can't read), and, when
//            the browser sends an Origin, it must be JARC's own origin. SameSite=Strict is a further layer.
//   identity bound to the verified tenant ID + object ID at sign-in; re-checked against the configured tenant and the
//            session's user on every request (a mismatch ends the session).
//   user     re-checked on every request: a disabled user's session ends immediately (403 ACCOUNT_DISABLED).
//   idle     only requests made by the person extend the idle timeout. Background traffic — the live-update stream
//            (GET /events) and requests marked X-JARC-Background: 1 (notification feed, people list, live refreshes,
//            polling) — is authenticated the same way but doesn't count as activity, so an open but unused tab still
//            times out. (The header can only make a session end sooner.)
//   account  (ACCOUNT_MANAGEMENT staged/enforced, auth/accounts.js) read from the stored user on every request, so a
//            role or status change applies to the very next request: a blocked account's session ends (403
//            ACCOUNT_DISABLED); under enforced, a pending account can only read its own session and preferences (403
//            ACCOUNT_PENDING elsewhere) and SYSTEM_ADMIN means an active Super Admin account, not the JARC.Admin app role.
//   admin    (P4-0, F2) the JARC.Admin app role is read from the ID token at sign-in and kept on the session (isSystemAdmin)
//            for the session's life (SESSION_MAX_HOURS, 8 h by default): removing the role in Microsoft Entra ID applies at the
//            person's next sign-in, while the JARC account status above applies to the next request. For the few SENSITIVE
//            administrator writes (sensitiveAdminRequest), a session whose admin claim is older than the admin re-auth age
//            (entra.adminReauthMinutes, default ADMIN_REAUTH_MINUTES) answers 403 REAUTH_REQUIRED: signing in again re-reads the
//            role from Microsoft. No identity-provider call is made per request; ordinary requests, every read, and sessions
//            without the claim are never affected, and the session itself stays valid.
// Nothing here logs the cookie, the CSRF token or any token.
const crypto = require("crypto");
const { sendError } = require("../middleware/errors");
const { accountOf, isActiveSuperAdmin } = require("./accounts");

const SESSION_COOKIE = "__Host-jarc_session";
const SIGN_IN_COOKIE = "__Host-jarc_signin";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TOUCH_INTERVAL_MS = 60 * 1000;
// What a pending account may do while it waits for approval (ACCOUNT_MANAGEMENT=enforced). Nothing here returns
// workspace data. The bootstrap route checks its own strict rules (only the configured administrator).
const PENDING_ALLOWED = new Set(["GET /auth/session", "POST /auth/sign-out", "GET /me", "GET /me/preferences", "PUT /me/preferences", "POST /accounts/bootstrap"]);
const blocked = (account) => Boolean(account && !account.legacy && account.status === "blocked");

// P4-0 (F2): administrator writes that need a recent JARC.Admin claim. Matched on the full API path (mount-independent):
//   /accounts/…                         Account Management changes and the Super Admin bootstrap (they read the claim itself:
//                                       granting SUPER_ADMIN and the bootstrap need JARC.Admin), in every ACCOUNT_MANAGEMENT mode
//   /integrations/monday/…              connect, disconnect, test, imports, sync, retries (the public webhook / callback excluded)
//   /admin/employees/:ds/records/:id/access | memberships[/:ref]   Employee Management P3 writes
//   /workspaces/:id/members[/:memberId]  workspace member changes (see the note at the pattern)
//   /imports                            the legacy state / browser-backup import (exactly this path)
// All but /accounts only while ACCOUNT_MANAGEMENT isn't enforced: enforced, SYSTEM_ADMIN is the Super Admin account, read on every
// request. Only POST / PUT / PATCH / DELETE.
const ADMIN_REAUTH_MINUTES = 60;
const API_PREFIX = String.raw`^(?:/api/v\d+)?`;
const ACCOUNT_WRITES = new RegExp(`${API_PREFIX}/accounts(?:/|$)`, "i");
const SENSITIVE_ADMIN_WRITES = Object.freeze([
  new RegExp(`${API_PREFIX}/integrations/monday/(?!webhook(?:/|$)|callback(?:/|$))`, "i"),
  new RegExp(`${API_PREFIX}/admin/employees/[^/]+/records/[^/]+/(?:access|memberships(?:/[^/]+)?)/?$`, "i"),
  // Workspace member changes (routes/members.js): a JARC.Admin claim may manage any workspace's members. Known, accepted side
  // effect: a session that carries the claim is gated here even when it acts through a real WORKSPACE_ADMIN membership; it signs
  // in again. Sessions without the claim are never gated.
  new RegExp(`${API_PREFIX}/workspaces/[^/]+/members(?:/[^/]+)?/?$`, "i"),
  // The legacy state / browser-backup import (routes/resources.js POST /imports; JARC.Admin only, creates workspaces). Exactly
  // /imports: the spreadsheet import jobs (/imports/:id/…, /workspaces/:id/imports) aren't administrator writes.
  new RegExp(`${API_PREFIX}/imports/?$`, "i")
]);
function sensitiveAdminRequest(req, accountMode = "off") {
  if (!UNSAFE_METHODS.has(req.method)) return false;
  const path = `${req.baseUrl || ""}${req.path || ""}`;
  if (ACCOUNT_WRITES.test(path)) return true;
  if (accountMode === "enforced") return false;
  return SENSITIVE_ADMIN_WRITES.some((re) => re.test(path));
}
// The admin re-auth age in milliseconds: entra.adminReauthMinutes when it is a whole number from 5 to 480, else the default.
function adminReauthMs(entra) {
  const n = entra?.adminReauthMinutes;
  return (Number.isInteger(n) && n >= 5 && n <= 480 ? n : ADMIN_REAUTH_MINUTES) * 60 * 1000;
}
// When the session's admin claim stops counting for sensitive writes (null: the session carries no claim). The claim was read at
// the sign-in that created the session (createdAt); a session without a valid createdAt is treated as already stale.
function adminFreshUntil(session, maxAgeMs) {
  if (session?.isSystemAdmin !== true) return null;
  return session.createdAt instanceof Date && !Number.isNaN(session.createdAt.getTime()) ? new Date(session.createdAt.getTime() + maxAgeMs) : new Date(0);
}

const randomSecret = () => crypto.randomBytes(32).toString("base64url");
const csrfTokenFor = (sessionSecret) => crypto.createHash("sha256").update(`jarc-csrf:${sessionSecret}`).digest("base64url");
const sameText = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function readCookie(req, name) {
  const header = req.get("cookie");
  if (!header || header.length > 8192) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : null;
    }
  }
  return null;
}

function cookieHeader(name, value, maxAgeSeconds) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}
const clearCookie = (name) => cookieHeader(name, "", 0);

// When a browser says where a state-changing request comes from, it must be JARC itself.
function originAllowed(req, appOrigin) {
  const origin = req.get("origin");
  if (origin) return origin === appOrigin;
  const referer = req.get("referer");
  if (referer) { try { return new URL(referer).origin === appOrigin; } catch { return false; } }
  return true; // non-browser clients still need the CSRF token
}

function sessionAuthentication({ sessions, users, entra, accountMode = "off" }) {
  const idleMs = entra.sessionIdleMinutes * 60 * 1000;
  const reauthMs = adminReauthMs(entra);
  return async (req, res, next) => {
    const secret = readCookie(req, SESSION_COOKIE);
    if (!secret) return sendError(res, 401, "UNAUTHENTICATED", "Sign in to continue.");
    const session = await sessions.findBySecret(secret);
    const now = new Date();
    if (!session || session.expiresAt <= now || session.idleExpiresAt <= now) {
      if (session) await sessions.remove(session._id);
      res.append("Set-Cookie", clearCookie(SESSION_COOKIE));
      return sendError(res, 401, "UNAUTHENTICATED", "Your session has expired. Sign in again.");
    }
    const user = await users.findById(session.userId);
    // The session is bound to the verified Entra identity: this tenant, and the same tenant + object ID as its user.
    if (user && (session.tenantId !== entra.tenantId || user.tenantId !== session.tenantId || user.entraObjectId !== session.objectId)) {
      await sessions.remove(session._id);
      res.append("Set-Cookie", clearCookie(SESSION_COOKIE));
      return sendError(res, 401, "UNAUTHENTICATED", "Your session is no longer valid. Sign in again.");
    }
    if (!user || user.status !== "active") {
      await sessions.remove(session._id);
      res.append("Set-Cookie", clearCookie(SESSION_COOKIE));
      return sendError(res, 403, "ACCOUNT_DISABLED", "Your JARC account is disabled. Contact a JARC administrator.");
    }
    const account = accountMode === "off" ? null : accountOf(user);
    if (blocked(account)) {
      await sessions.remove(session._id);
      res.append("Set-Cookie", clearCookie(SESSION_COOKIE));
      return sendError(res, 403, "ACCOUNT_DISABLED", "Your JARC account is blocked. Contact a JARC administrator.");
    }
    if (UNSAFE_METHODS.has(req.method)) {
      if (!originAllowed(req, entra.appOrigin)) return sendError(res, 403, "CSRF_INVALID", "This request didn't come from JARC.");
      if (!sameText(req.get("x-csrf-token"), csrfTokenFor(secret))) return sendError(res, 403, "CSRF_INVALID", "This request couldn't be verified. Reload JARC and try again.");
    }
    const background = req.get("x-jarc-background") === "1" || (req.method === "GET" && req.path === "/events");
    if (!background && now - session.lastSeenAt > TOUCH_INTERVAL_MS) await sessions.touch(session._id, now, idleMs);
    // displayName comes from the stored user (refreshed from the verified Microsoft token at sign-in), never from the
    // request; it is snapshotted on activity entries.
    if (accountMode === "enforced" && account && !account.legacy && account.status === "pending" && !PENDING_ALLOWED.has(`${req.method} ${req.path}`)) {
      return sendError(res, 403, "ACCOUNT_PENDING", "Your JARC account is waiting for approval by a JARC administrator.");
    }
    const isSystemAdmin = accountMode === "enforced" ? isActiveSuperAdmin(account) : Boolean(session.isSystemAdmin);
    // P4-0 (F2): a sensitive administrator write on an old admin claim → sign in again (the session stays valid for the rest).
    const freshUntil = adminFreshUntil(session, reauthMs);
    if (freshUntil && freshUntil <= now && sensitiveAdminRequest(req, accountMode)) {
      return sendError(res, 403, "REAUTH_REQUIRED", "For this administrator action, sign in to JARC again. Your administrator sign-in is too old.");
    }
    req.adminFreshUntil = freshUntil;
    // account: null while ACCOUNT_MANAGEMENT=off. hasAdminAppRole: the JARC.Admin app role was in the sign-in token.
    // tenantId / entraObjectId: the identity verified at sign-in, checked against the stored user just above.
    req.actor = Object.freeze({ userId: user._id, kind: "entra", isSystemAdmin, hasAdminAppRole: Boolean(session.isSystemAdmin), account, sessionId: session._id, tenantId: session.tenantId, entraObjectId: session.objectId, displayName: user.displayName || user.email || null });
    req.sessionSecret = secret;
    return next();
  };
}

// For a return from another site, where the Strict session cookie doesn't arrive: the session that started an action,
// if it is still valid, belongs to the same still-active person (same verified tenant and object ID) and isn't blocked.
async function liveSession({ sessions, users, accountMode, now }, { sessionId, userId }) {
  if (!sessionId) return null;
  const session = await sessions.findById(sessionId), time = now();
  if (!session || session.expiresAt <= time || session.idleExpiresAt <= time || String(session.userId) !== String(userId)) return null;
  const user = await users.findById(session.userId);
  if (!user || user.status !== "active") return null;
  if (user.tenantId !== session.tenantId || user.entraObjectId !== session.objectId) return null;
  const account = accountMode === "off" ? null : accountOf(user);
  if (blocked(account)) return null;
  return { session, user, account };
}

// … and that person is still a JARC administrator.
function stillSystemAdmin({ sessions, users, accountMode = "off", now = () => new Date() }) {
  return async (saved) => {
    const live = await liveSession({ sessions, users, accountMode, now }, saved);
    if (!live) return false;
    return accountMode === "enforced" ? isActiveSuperAdmin(live.account) : Boolean(live.session.isSystemAdmin);
  };
}

// … and `allow({ tenantId, objectId })` still says yes for that person's verified identity (e.g. the Google Drive allowlist).
function stillAllowed({ sessions, users, accountMode = "off", now = () => new Date(), allow }) {
  return async (saved) => {
    const live = await liveSession({ sessions, users, accountMode, now }, saved);
    return Boolean(live && allow({ tenantId: live.session.tenantId, objectId: live.session.objectId }));
  };
}

module.exports = { stillSystemAdmin, stillAllowed, PENDING_ALLOWED, ADMIN_REAUTH_MINUTES, sensitiveAdminRequest, adminReauthMs, adminFreshUntil, sessionAuthentication, readCookie, cookieHeader, clearCookie, csrfTokenFor, originAllowed, randomSecret, SESSION_COOKIE, SIGN_IN_COOKIE, UNSAFE_METHODS };
