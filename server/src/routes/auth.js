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
// request is still authorized by the server).
const express = require("express");
const { allowOnly, requireBody } = require("../validation/common");
const { userToApi } = require("../api/serialize");
const { InvalidTokenError, AuthUnavailableError } = require("../auth/entra-token");
const { readCookie, cookieHeader, clearCookie, csrfTokenFor, originAllowed, randomSecret, SESSION_COOKIE, SIGN_IN_COOKIE } = require("../auth/session");
const { sendError } = require("../middleware/errors");

const SIGN_IN_ATTEMPT_MS = 10 * 60 * 1000;
const SCOPES = Object.freeze(["openid", "profile", "email"]);
const permissionsOf = (access, actor) => ({ accessPolicy: access.policy, canCreateWorkspaces: access.canManageWorkspaces(actor) });

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
function signInRoutes({ entra, verify, repos, access }) {
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
    const user = await repos.users.upsertFromEntra(identity);
    if (user.status !== "active") return sendError(res, 403, "ACCOUNT_DISABLED", "Your JARC account is disabled. Contact a JARC administrator.");
    // A new session every time (never reuse an earlier cookie's session).
    const previous = readCookie(req, SESSION_COOKIE);
    if (previous) await repos.sessions.removeBySecret(previous);
    const sessionSecret = randomSecret(), now = new Date();
    const session = await repos.sessions.create({ sessionSecret, userId: user._id, tenantId: identity.tenantId, objectId: identity.objectId, isSystemAdmin: identity.isSystemAdmin, now, idleMs, maxMs: sessionLifetimeMs });
    res.append("Set-Cookie", cookieHeader(SESSION_COOKIE, sessionSecret, sessionLifetimeMs / 1000));
    res.status(201).set("Cache-Control", "no-store").json({ user: userToApi(user), isSystemAdmin: identity.isSystemAdmin, ...permissionsOf(access, identity), csrfToken: csrfTokenFor(sessionSecret), expiresAt: session.expiresAt.toISOString() });
  });
  return router;
}

// Mounted after session authentication.
function sessionRoutes({ repos, access }) {
  const router = express.Router();
  router.get("/auth/session", async (req, res) => {
    allowOnly(req.query, [], "the query");
    const [user, session] = await Promise.all([repos.users.findById(req.actor.userId), repos.sessions.findBySecret(req.sessionSecret)]);
    res.set("Cache-Control", "no-store").json({ user: userToApi(user), isSystemAdmin: req.actor.isSystemAdmin, ...permissionsOf(access, req.actor), csrfToken: csrfTokenFor(req.sessionSecret), expiresAt: session.expiresAt.toISOString(), idleExpiresAt: session.idleExpiresAt.toISOString() });
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
    const memberships = await repos.memberships.listForUser(req.actor.userId);
    res.set("Cache-Control", "no-store").json({
      user: userToApi(user), authMode: mode, isSystemAdmin: Boolean(req.actor.isSystemAdmin), ...permissionsOf(access, req.actor),
      memberships: memberships.map((m) => ({ workspaceId: m.workspaceId.toHexString(), role: m.role }))
    });
  });
  return router;
}

module.exports = { authConfigRoutes, signInRoutes, sessionRoutes, meRoutes, SCOPES };
