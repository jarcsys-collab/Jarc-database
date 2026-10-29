// Authentication routes.
//
// PUBLIC
//   GET  /api/v1/auth/config          what the browser needs to start Microsoft sign-in (tenant, the SPA's client ID,
//                                     authority, scopes, redirect URI). Public identifiers only; no secrets exist.
//   POST /api/v1/auth/sign-in/start   (AUTH_MODE=entra) a single-use nonce for one sign-in attempt, bound to a short-
//                                     lived HttpOnly cookie in this browser.
//   POST /api/v1/auth/session         (AUTH_MODE=entra) { idToken } from Microsoft → verified (incl. the nonce) →
//                                     a new JARC session cookie. Nothing else from the browser is trusted.
// SIGNED IN
//   GET  /api/v1/auth/session         the signed-in user, admin flag, session expiry and the CSRF token
//   POST /api/v1/auth/sign-out        ends the session (CSRF-protected like every other change)
//   GET  /api/v1/me                   the user's display details, admin flag and workspace roles
// Signed-in responses also carry the access policy and whether the caller may create workspaces (display only; every
// request is still authorized by the server). The policy and beta flag are the ones IN EFFECT (ACCOUNT_MANAGEMENT=
// enforced switches both open-access settings off). With Account Management on (staged/enforced) they add
// `account` { status, role, legacy } and `accountManagement` { mode, enforced, overridden, canManage, canClaimSuperAdmin }.
const express = require("express");
const { allowOnly, requireBody } = require("../validation/common");
const { userToApi } = require("../api/serialize");
const { InvalidTokenError, AuthUnavailableError } = require("../auth/entra-token");
const { readCookie, cookieHeader, clearCookie, csrfTokenFor, originAllowed, randomSecret, SESSION_COOKIE, SIGN_IN_COOKIE } = require("../auth/session");
const { sendError } = require("../middleware/errors");
const { accountOf, isActiveSuperAdmin } = require("../auth/accounts");

const SIGN_IN_ATTEMPT_MS = 10 * 60 * 1000;
const SCOPES = Object.freeze(["openid", "profile", "email"]);
const permissionsOf = (access, actor, { canClaimSuperAdmin = false } = {}) => ({
  accessPolicy: access.policy, betaOpenEditing: Boolean(access.betaOpenEditing), canCreateWorkspaces: access.canManageWorkspaces(actor),
  ...(access.accountMode === "off" ? {} : {
    account: actor.account ? { status: actor.account.legacy ? "legacy" : actor.account.status, role: actor.account.role, legacy: actor.account.legacy } : null,
    accountManagement: { mode: access.accountMode, enforced: access.enforced, overridden: access.overridden, canManage: isActiveSuperAdmin(actor.account), canClaimSuperAdmin }
  })
});
// Only the configured administrator's own session runs the (few) eligibility queries.
async function claimable(accounts, actor, session) {
  if (!accounts?.tracking || !accounts.superAdmin || !session || String(session.objectId).toLowerCase() !== accounts.superAdmin.objectId || isActiveSuperAdmin(actor.account)) return false;
  return (await accounts.eligibility(actor, session)).eligible;
}

function authConfigRoutes({ mode, entra }) {
  const router = express.Router();
  router.get("/auth/config", (req, res) => {
    allowOnly(req.query, [], "the query");
    const body = mode === "entra"
      ? { mode, tenantId: entra.tenantId, clientId: entra.clientId, authority: `https://login.microsoftonline.com/${entra.tenantId}`, scopes: [...SCOPES], redirectUri: entra.redirectUri }
      : { mode: "dev" };
    res.set("Cache-Control", "no-store").json(body);
  });
  return router;
}

// Sign-in: nonce, then ID token → session. Mounted before session authentication (no session exists yet).
function signInRoutes({ entra, verify, repos, access, accounts = null }) {
  const router = express.Router();
  const sessionLifetimeMs = entra.sessionMaxHours * 60 * 60 * 1000;
  const idleMs = entra.sessionIdleMinutes * 60 * 1000;

  router.post("/auth/sign-in/start", async (req, res) => {
    allowOnly(req.query, [], "the query");
    if (!originAllowed(req, entra.appOrigin)) return sendError(res, 403, "CSRF_INVALID", "This request didn't come from JARC.");
    const attemptSecret = randomSecret(), nonce = randomSecret();
    await repos.sessions.createAttempt({ attemptSecret, nonce, now: new Date(), ttlMs: SIGN_IN_ATTEMPT_MS });
    res.append("Set-Cookie", cookieHeader(SIGN_IN_COOKIE, attemptSecret, SIGN_IN_ATTEMPT_MS / 1000));
    res.set("Cache-Control", "no-store").json({ nonce });
  });

  router.post("/auth/session", async (req, res) => {
    allowOnly(req.query, [], "the query");
    if (!originAllowed(req, entra.appOrigin)) return sendError(res, 403, "CSRF_INVALID", "This request didn't come from JARC.");
    const body = requireBody(req.body);
    allowOnly(body, ["idToken"], "the sign-in"); // e.g. a browser-supplied email or name is refused, not ignored
    const attemptSecret = readCookie(req, SIGN_IN_COOKIE);
    res.append("Set-Cookie", clearCookie(SIGN_IN_COOKIE));
    const nonce = attemptSecret ? await repos.sessions.consumeAttempt(attemptSecret, new Date()) : null;
    if (!nonce) return sendError(res, 401, "UNAUTHENTICATED", "This sign-in has expired or was already used. Start again.");
    let identity;
    try { identity = await verify(body.idToken, { nonce }); }
    catch (error) {
      if (error instanceof InvalidTokenError) return sendError(res, 401, "UNAUTHENTICATED", "The Microsoft sign-in couldn't be verified. Start again.");
      if (error instanceof AuthUnavailableError) return sendError(res, 503, "SERVICE_UNAVAILABLE", "Sign-in can't be checked right now. Try again in a moment.");
      throw error;
    }
    const tracking = access.accountMode !== "off";
    const now = new Date();
    const { user, created } = await repos.users.signInFromEntra(identity, now, { trackAccounts: tracking });
    if (user.status !== "active") return sendError(res, 403, "ACCOUNT_DISABLED", "Your JARC account is disabled. Contact a JARC administrator.");
    const account = tracking ? accountOf(user) : null;
    if (account && !account.legacy && account.status === "blocked") return sendError(res, 403, "ACCOUNT_DISABLED", "Your JARC account is blocked. Contact a JARC administrator.");
    // A new session every time (never reuse an earlier cookie's session).
    const previous = readCookie(req, SESSION_COOKIE);
    if (previous) await repos.sessions.removeBySecret(previous);
    const sessionSecret = randomSecret();
    const session = await repos.sessions.create({ sessionSecret, userId: user._id, tenantId: identity.tenantId, objectId: identity.objectId, isSystemAdmin: identity.isSystemAdmin, now, idleMs, maxMs: sessionLifetimeMs });
    await accounts?.onSignIn(user, created, now);
    res.append("Set-Cookie", cookieHeader(SESSION_COOKIE, sessionSecret, sessionLifetimeMs / 1000));
    // The same rules the session check applies to every later request (auth/session.js).
    const actor = { userId: user._id, kind: "entra", account, hasAdminAppRole: identity.isSystemAdmin, isSystemAdmin: access.enforced ? isActiveSuperAdmin(account) : identity.isSystemAdmin };
    res.status(201).set("Cache-Control", "no-store").json({ user: userToApi(user), isSystemAdmin: actor.isSystemAdmin, ...permissionsOf(access, actor, { canClaimSuperAdmin: await claimable(accounts, actor, session) }), csrfToken: csrfTokenFor(sessionSecret), expiresAt: session.expiresAt.toISOString() });
  });
  return router;
}

// Mounted after session authentication.
function sessionRoutes({ repos, access, accounts = null }) {
  const router = express.Router();
  router.get("/auth/session", async (req, res) => {
    allowOnly(req.query, [], "the query");
    const [user, session] = await Promise.all([repos.users.findById(req.actor.userId), repos.sessions.findBySecret(req.sessionSecret)]);
    res.set("Cache-Control", "no-store").json({ user: userToApi(user), isSystemAdmin: req.actor.isSystemAdmin, ...permissionsOf(access, req.actor, { canClaimSuperAdmin: await claimable(accounts, req.actor, session) }), csrfToken: csrfTokenFor(req.sessionSecret), expiresAt: session.expiresAt.toISOString(), idleExpiresAt: session.idleExpiresAt.toISOString() });
  });
  router.post("/auth/sign-out", async (req, res) => {
    allowOnly(req.query, [], "the query");
    await repos.sessions.remove(req.actor.sessionId);
    res.append("Set-Cookie", clearCookie(SESSION_COOKIE));
    res.set("Cache-Control", "no-store").json({ signedOut: true });
  });
  return router;
}

function meRoutes({ repos, mode, access }) {
  const router = express.Router();
  router.get("/me", async (req, res) => {
    allowOnly(req.query, [], "the query");
    const user = await repos.users.findById(req.actor.userId);
    // A pending (enforced) account sees no workspace IDs; otherwise each role as it is in effect.
    const memberships = access.enforced && req.actor.account && !req.actor.account.legacy && req.actor.account.status !== "active" ? [] : await repos.memberships.listForUser(req.actor.userId);
    res.set("Cache-Control", "no-store").json({
      user: userToApi(user), authMode: mode, isSystemAdmin: Boolean(req.actor.isSystemAdmin), ...permissionsOf(access, req.actor),
      memberships: memberships.map((m) => ({ workspaceId: m.workspaceId.toHexString(), role: access.effective(req.actor, m.role) })).filter((m) => m.role)
    });
  });
  return router;
}

module.exports = { authConfigRoutes, signInRoutes, sessionRoutes, meRoutes, SCOPES };
