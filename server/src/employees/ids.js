// Opaque, stable profile IDs: base64url(HMAC-SHA256(key, "jarc-employee-profile:v1:" + lowercase(user_id))), first 22
// characters. The key is the existing API-token key (config.apiTokens.key, JARC_API_TOKEN_KEY): no new secret. The same
// account keeps its ID across snapshots and restarts; the Entra object ID is never returned and can't be derived from it.
const crypto = require("crypto");

const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
function profileId(key, userId) {
  if (!Buffer.isBuffer(key) || key.length < 16) throw new Error("employees: profile IDs need a key of at least 16 bytes.");
  return crypto.createHmac("sha256", key).update(`jarc-employee-profile:v1:${String(userId).toLowerCase()}`).digest("base64url").slice(0, 22);
}

module.exports = { profileId, ID_PATTERN };
