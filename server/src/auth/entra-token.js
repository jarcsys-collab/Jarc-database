// Microsoft Entra ID sign-in verification (AUTH_MODE=entra): validates the OpenID Connect ID token that the browser
// received from Microsoft (authorization code + PKCE, scopes openid profile email) ONCE, when a JARC session is
// created. It is never accepted as an API credential afterwards; the session cookie is.
//
// Checks (OpenID Connect Core §3.1.3.7):
//   signature  RS256 only, against this tenant's published signing keys (fetched over HTTPS from Microsoft, cached,
//              refreshed when Entra rotates keys)
//   iss        https://login.microsoftonline.com/<tenant>/v2.0       aud   the JARC SPA's client ID
//   tid        the configured tenant                                 ver   2.0
//   exp / nbf  checked (60 s clock tolerance)                        iat   at most 10 minutes old (fresh sign-in)
//   nonce      equals the single-use nonce the server issued for this browser's sign-in attempt
//   oid        present (the user's immutable object ID in the tenant)
// Access tokens (scp / idtyp=app present), tokens for other apps or tenants, v1.0 tokens, unsigned or HS256 tokens
// are rejected. Token contents are never logged or returned.
const crypto = require("crypto");
const { jwtVerify, createRemoteJWKSet, errors } = require("jose");

const CLOCK_TOLERANCE_SECONDS = 60;
const MAX_SIGN_IN_AGE_SECONDS = 10 * 60;
const MAX_TOKEN_LENGTH = 16 * 1024;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The token isn't acceptable → 401. `reason` is for tests and server-side diagnostics only.
class InvalidTokenError extends Error {
  constructor(reason) { super("The Microsoft sign-in couldn't be verified."); this.name = "InvalidTokenError"; this.reason = reason; }
}
// Entra's signing keys couldn't be fetched → 503: never accept a token we couldn't verify.
class AuthUnavailableError extends Error {
  constructor() { super("Sign-in can't be verified right now."); this.name = "AuthUnavailableError"; }
}

const sameText = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// keySet: for tests, a local key set (jose createLocalJWKSet); production uses the tenant's remote key set.
function createEntraVerifier({ tenantId, clientId, adminRole = "JARC.Admin", keySet = null }) {
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const keys = keySet || createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`), { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 10 * 60 * 1000 });

  return async function verifyIdToken(token, { nonce }) {
    if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) throw new InvalidTokenError("malformed");
    if (typeof nonce !== "string" || !nonce) throw new InvalidTokenError("nonce");
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, { issuer, audience: clientId, algorithms: ["RS256"], clockTolerance: CLOCK_TOLERANCE_SECONDS, requiredClaims: ["exp", "iat", "nbf"], maxTokenAge: MAX_SIGN_IN_AGE_SECONDS }));
    } catch (error) {
      if (error instanceof errors.JWKSTimeout || (error instanceof TypeError && /fetch/i.test(error.message)) || ["ERR_JWKS_INVALID", "ERR_JOSE_GENERIC"].includes(error?.code)) throw new AuthUnavailableError();
      throw new InvalidTokenError(error?.code || "invalid");
    }
    if (payload.ver !== "2.0") throw new InvalidTokenError("version");
    if (typeof payload.tid !== "string" || payload.tid.toLowerCase() !== tenantId) throw new InvalidTokenError("tenant");
    if (typeof payload.oid !== "string" || !GUID.test(payload.oid)) throw new InvalidTokenError("oid");
    // ID tokens never carry scopes; access tokens (scp) and app-only tokens (idtyp=app) are not sign-in proof.
    if (payload.scp !== undefined || payload.idtyp === "app") throw new InvalidTokenError("not_id_token");
    if (!sameText(payload.nonce, nonce)) throw new InvalidTokenError("nonce");
    const roles = Array.isArray(payload.roles) ? payload.roles.filter((r) => typeof r === "string") : [];
    return Object.freeze({
      tenantId: payload.tid.toLowerCase(),
      objectId: payload.oid.toLowerCase(),
      // Display only (from the verified token, never from the browser): never used to identify the user.
      displayName: typeof payload.name === "string" ? payload.name.slice(0, 200) : "",
      email: [payload.email, payload.preferred_username, payload.upn].find((v) => typeof v === "string" && v.length <= 320) || null,
      isSystemAdmin: roles.includes(adminRole)
    });
  };
}

module.exports = { createEntraVerifier, InvalidTokenError, AuthUnavailableError, CLOCK_TOLERANCE_SECONDS, MAX_SIGN_IN_AGE_SECONDS };
