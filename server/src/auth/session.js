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
    // account: null while ACCOUNT_MANAGEMENT=off. hasAdminAppRole: the JARC.Admin app role was in the sign-in token.
    req.actor = Object.freeze({ userId: user._id, kind: "entra", isSystemAdmin, hasAdminAppRole: Boolean(session.isSystemAdmin), account, sessionId: session._id, displayName: user.displayName || user.email || null });
    req.sessionSecret = secret;
    return next();
  };
}

module.exports = { PENDING_ALLOWED, sessionAuthentication, readCookie, cookieHeader, clearCookie, csrfTokenFor, originAllowed, randomSecret, SESSION_COOKIE, SIGN_IN_COOKIE, UNSAFE_METHODS };
