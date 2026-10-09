// TEST-ONLY: offline stand-in for Microsoft Entra ID. Generates an RSA key pair at run time, exposes it as a local
// key set, and signs ID tokens shaped like Entra v2.0 sign-in ID tokens (plus deliberately bad ones). Nothing here
// contacts Microsoft, and no key or token is stored anywhere.
const crypto = require("crypto");
const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = require("jose");
const { TEST_ENTRA } = require("../helpers");

const KID = "jarc-test-key-1";
const config = Object.freeze({
  tenantId: TEST_ENTRA.ENTRA_TENANT_ID, clientId: TEST_ENTRA.ENTRA_SPA_CLIENT_ID, redirectUri: TEST_ENTRA.ENTRA_REDIRECT_URI,
  appOrigin: new URL(TEST_ENTRA.ENTRA_REDIRECT_URI).origin, adminRole: "JARC.Admin", sessionIdleMinutes: 30, sessionMaxHours: 8
});
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const newOid = () => crypto.randomUUID();

async function createTokenIssuer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const attacker = await generateKeyPair("RS256");
  const keySet = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" }] });

  // An Entra v2.0 ID token for the JARC SPA. claims override the defaults; `omit` removes claims.
  async function token(claims = {}, { omit = [], key = privateKey, kid = KID, alg = "RS256" } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: `https://login.microsoftonline.com/${config.tenantId}/v2.0`, aud: config.clientId, tid: config.tenantId,
      oid: newOid(), ver: "2.0", iat: now, nbf: now, exp: now + 3600, name: "Test User", preferred_username: "test.user@example.invalid", ...claims
    };
    for (const name of omit) delete payload[name];
    return new SignJWT(payload).setProtectedHeader({ alg, kid, typ: "JWT" }).sign(key);
  }
  // A signed-in person: the same oid on every sign-in (like Entra), optionally holding the JARC.Admin app role.
  const person = (name, { admin = false, email = `${name.toLowerCase().replace(/\s+/g, ".")}@example.invalid` } = {}) => {
    const oid = newOid();
    return { oid, name, email, admin, idToken: (nonce, claims = {}) => token({ oid, name, preferred_username: email, email, nonce, ...(admin ? { roles: ["JARC.Admin"] } : {}), ...claims }) };
  };
  const unsigned = (claims) => `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
  return { config, keySet, token, person, unsigned, attackerKey: attacker.privateKey, hmacKey: crypto.randomBytes(32), KID };
}

module.exports = { createTokenIssuer, entraConfig: config, newOid };
