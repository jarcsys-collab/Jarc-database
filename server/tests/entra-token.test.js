// Stage 12C: verification of the Microsoft Entra sign-in ID token (OIDC), offline with a local RSA key set.
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { SignJWT } = require("jose");
const { createEntraVerifier, InvalidTokenError, AuthUnavailableError } = require("../src/auth/entra-token");
const { createTokenIssuer, newOid } = require("./support/entra-tokens");

let issuer, verify;
const NONCE = "server-issued-nonce-0123456789abcdef";
before(async () => { issuer = await createTokenIssuer(); verify = createEntraVerifier({ ...issuer.config, keySet: issuer.keySet }); });
const rejects = (promise, reason) => assert.rejects(promise, (e) => e instanceof InvalidTokenError && (!reason || e.reason === reason), reason);
const now = () => Math.floor(Date.now() / 1000);
const base = () => ({ iss: `https://login.microsoftonline.com/${issuer.config.tenantId}/v2.0`, aud: issuer.config.clientId, tid: issuer.config.tenantId, oid: newOid(), ver: "2.0", iat: now(), nbf: now(), exp: now() + 3600, nonce: NONCE });

describe("Valid sign-in ID tokens", () => {
  test("an ID token for the JARC SPA, this tenant and the issued nonce is accepted; identity is tid + oid", async () => {
    const oid = newOid();
    const identity = await verify(await issuer.token({ oid, name: "Ana Reyes", email: "ana@example.invalid", nonce: NONCE }), { nonce: NONCE });
    assert.equal(identity.tenantId, issuer.config.tenantId);
    assert.equal(identity.objectId, oid);
    assert.equal(identity.displayName, "Ana Reyes");
    assert.equal(identity.email, "ana@example.invalid");
    assert.equal(identity.isSystemAdmin, false);
  });
  test("preferred_username is used for display when there is no email claim", async () => {
    assert.equal((await verify(await issuer.token({ nonce: NONCE, preferred_username: "upn@example.invalid" }), { nonce: NONCE })).email, "upn@example.invalid");
  });
  test("the JARC.Admin app role marks a system admin; other roles don't", async () => {
    assert.equal((await verify(await issuer.token({ nonce: NONCE, roles: ["JARC.Admin"] }), { nonce: NONCE })).isSystemAdmin, true);
    assert.equal((await verify(await issuer.token({ nonce: NONCE, roles: ["Other"] }), { nonce: NONCE })).isSystemAdmin, false);
  });
  test("small clock skew is tolerated (expired 30 s ago)", async () => {
    assert.ok(await verify(await issuer.token({ nonce: NONCE, exp: now() - 30, iat: now() - 300, nbf: now() - 300 }), { nonce: NONCE }));
  });
});

describe("Rejected tokens", () => {
  test("wrong, missing or empty nonce (replay from another sign-in)", async () => {
    await rejects(verify(await issuer.token({ nonce: "another-sign-in-nonce-000000000000" }), { nonce: NONCE }), "nonce");
    await rejects(verify(await issuer.token({}), { nonce: NONCE }), "nonce");
    await rejects(verify(await issuer.token({ nonce: NONCE }), { nonce: "" }), "nonce");
  });
  test("not a fresh sign-in (issued more than 10 minutes + 60 s tolerance ago)", async () => rejects(verify(await issuer.token({ nonce: NONCE, iat: now() - 12 * 60, nbf: now() - 12 * 60 }), { nonce: NONCE }), "ERR_JWT_EXPIRED"));
  test("expired", async () => rejects(verify(await issuer.token({ nonce: NONCE, exp: now() - 120, iat: now() - 300, nbf: now() - 300 }), { nonce: NONCE }), "ERR_JWT_EXPIRED"));
  test("not yet valid", async () => rejects(verify(await issuer.token({ nonce: NONCE, nbf: now() + 600 }), { nonce: NONCE }), "ERR_JWT_CLAIM_VALIDATION_FAILED"));
  test("missing exp / nbf / iat", async () => { for (const claim of ["exp", "nbf", "iat"]) await rejects(verify(await issuer.token({ nonce: NONCE }, { omit: [claim] }), { nonce: NONCE })); });
  test("issued to another application (aud)", async () => rejects(verify(await issuer.token({ nonce: NONCE, aud: "00000000-0000-4000-8000-00000000ffff" }), { nonce: NONCE }), "ERR_JWT_CLAIM_VALIDATION_FAILED"));
  test("an ACCESS token (has scp) is not sign-in proof, even with the right audience", async () => rejects(verify(await issuer.token({ nonce: NONCE, scp: "User.Read" }), { nonce: NONCE }), "not_id_token"));
  test("an app-only token (idtyp=app)", async () => rejects(verify(await issuer.token({ nonce: NONCE, idtyp: "app", roles: ["JARC.Admin"] }), { nonce: NONCE }), "not_id_token"));
  test("another tenant's issuer", async () => rejects(verify(await issuer.token({ nonce: NONCE, iss: "https://login.microsoftonline.com/00000000-0000-4000-8000-0000000000bb/v2.0" }), { nonce: NONCE }), "ERR_JWT_CLAIM_VALIDATION_FAILED"));
  test("right issuer, different tid claim", async () => rejects(verify(await issuer.token({ nonce: NONCE, tid: "00000000-0000-4000-8000-0000000000bb" }), { nonce: NONCE }), "tenant"));
  test("v1.0 token", async () => { await rejects(verify(await issuer.token({ nonce: NONCE, iss: `https://sts.windows.net/${issuer.config.tenantId}/`, ver: "1.0" }), { nonce: NONCE })); await rejects(verify(await issuer.token({ nonce: NONCE, ver: "1.0" }), { nonce: NONCE }), "version"); });
  test("missing or malformed oid", async () => { await rejects(verify(await issuer.token({ nonce: NONCE }, { omit: ["oid"] }), { nonce: NONCE }), "oid"); await rejects(verify(await issuer.token({ nonce: NONCE, oid: "x" }), { nonce: NONCE }), "oid"); });
  test("alg none (unsigned)", async () => rejects(verify(issuer.unsigned(base()), { nonce: NONCE })));
  test("HS256 (symmetric) signature", async () => rejects(verify(await new SignJWT(base()).setProtectedHeader({ alg: "HS256", kid: issuer.KID }).sign(issuer.hmacKey), { nonce: NONCE })));
  test("signed by another key with the trusted kid", async () => rejects(verify(await issuer.token({ nonce: NONCE }, { key: issuer.attackerKey }), { nonce: NONCE }), "ERR_JWS_SIGNATURE_VERIFICATION_FAILED"));
  test("unknown kid", async () => rejects(verify(await issuer.token({ nonce: NONCE }, { key: issuer.attackerKey, kid: "unknown" }), { nonce: NONCE }), "ERR_JWKS_NO_MATCHING_KEY"));
  test("tampered payload (e.g. a forged admin role or email)", async () => {
    const [h, p, sig] = (await issuer.token({ nonce: NONCE, email: "me@example.invalid" })).split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.roles = ["JARC.Admin"]; claims.email = "ceo@example.invalid";
    await rejects(verify(`${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`, { nonce: NONCE }));
  });
  test("garbage, empty and oversized tokens", async () => { for (const v of ["", "abc", "a.b.c", "x".repeat(20000), null, undefined, 42]) await rejects(verify(v, { nonce: NONCE })); });
});

describe("Signing keys unavailable", () => {
  test("a key-set fetch failure is reported as unavailable (never accepted)", async () => {
    const down = createEntraVerifier({ ...issuer.config, keySet: async () => { throw new TypeError("fetch failed"); } });
    await assert.rejects(down(await issuer.token({ nonce: NONCE }), { nonce: NONCE }), (e) => e instanceof AuthUnavailableError);
  });
});
