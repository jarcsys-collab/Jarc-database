// JARC API tokens: the secret itself. Pure, with no database or application imports.
//
//   format   jarc_<publicId>_<secret>
//            publicId  24 hex characters (96 random bits): not secret, used to find the stored document and shown as a prefix
//            secret    43 base64url characters (256 random bits)
//   stored   only an HMAC-SHA256 digest of the whole token, keyed with JARC_API_TOKEN_KEY. A copy of the database alone can't
//            be turned back into working tokens, and without the key it can't be used to test guesses either.
// Nothing here logs anything.
const crypto = require("crypto");

const TOKEN_FORMAT = /^jarc_([0-9a-f]{24})_([A-Za-z0-9_-]{43})$/;
// Anything in a query string that looks like one of these tokens.
const LOOKS_LIKE_TOKEN = /jarc_[0-9a-f]{24}_/;

const digestOf = (key, token) => crypto.createHmac("sha256", key).update(`jarc-api-token:v1:${token}`).digest("hex");

function generateToken(key) {
  const publicId = crypto.randomBytes(12).toString("hex");
  const token = `jarc_${publicId}_${crypto.randomBytes(32).toString("base64url")}`;
  return { publicId, token, digest: digestOf(key, token) };
}

// The token's public ID, or null when the text isn't shaped like a token (no database lookup is needed for those).
function publicIdOf(token) {
  const match = typeof token === "string" && token.length < 200 ? TOKEN_FORMAT.exec(token) : null;
  return match ? match[1] : null;
}

function sameDigest(a, b) {
  const left = Buffer.from(String(a), "hex"), right = Buffer.from(String(b), "hex");
  return left.length === 32 && right.length === 32 && crypto.timingSafeEqual(left, right);
}

// The non-secret part shown in the interface.
const displayPrefix = (publicId) => `jarc_${String(publicId).slice(0, 8)}`;

module.exports = { generateToken, digestOf, publicIdOf, sameDigest, displayPrefix, LOOKS_LIKE_TOKEN };
