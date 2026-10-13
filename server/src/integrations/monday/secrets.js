// Small security helpers for the monday.com integration: encrypting the access token at rest (AES-256-GCM with
// MONDAY_TOKEN_KEY, never stored or logged in clear), verifying webhook JWTs (HMAC with the app's Signing Secret, as
// monday.com documents for board webhooks; the algorithm isn't documented, so HS256/384/512 are accepted — never "none"
// or public-key algorithms) and random identifiers.
const crypto = require("crypto");

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

function encrypt(text, key) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}
function decrypt(box, key) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8");
}

// A webhook's JWT (Authorization header, optionally "Bearer …"): HMAC only, signature checked in constant time,
// expiry honoured. Returns the payload, or null.
function verifyJwt(header, secret, { now = Date.now() } = {}) {
  if (!secret || typeof header !== "string") return null;
  const token = header.replace(/^Bearer\s+/i, "").trim(), parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const hash = { HS256: "sha256", HS384: "sha384", HS512: "sha512" }[head.alg];
    if (!hash) return null;
    const expected = crypto.createHmac(hash, secret).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], "base64url");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload.exp && payload.exp * 1000 < now) return null;
    return payload;
  } catch { return null; }
}
// Test helper (and for documentation): an HS256 JWT.
function signJwt(payload, secret) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" }), body = enc(payload);
  return `${head}.${body}.${crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
const sameText = (a, b) => { const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? "")); return x.length === y.length && crypto.timingSafeEqual(x, y); };

module.exports = { randomToken, encrypt, decrypt, verifyJwt, signJwt, sameText };
