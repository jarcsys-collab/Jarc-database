// sessions and loginAttempts collections (AUTH_MODE=entra).
//
// A session's cookie value is a 256-bit random secret held only by the browser (HttpOnly cookie). The database stores
// its SHA-256 hash, so a copy of the database can't be turned back into working cookies. Expired sessions and sign-in
// attempts are removed automatically by TTL indexes (and are refused before that by explicit expiry checks).
const crypto = require("crypto");
const { COLLECTIONS } = require("../../db/bootstrap");

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

class SessionRepository {
  constructor(db) {
    this.sessions = db.collection(COLLECTIONS.sessions);
    this.attempts = db.collection(COLLECTIONS.loginAttempts);
  }

  // ---- Sign-in attempts: one single-use nonce per browser sign-in, bound to an HttpOnly attempt cookie.
  async createAttempt({ attemptSecret, nonce, now, ttlMs }) {
    await this.attempts.insertOne({ _id: hash(attemptSecret), nonce, createdAt: now, expiresAt: new Date(now.getTime() + ttlMs) });
  }

  // Removes the attempt and returns its nonce if it existed and hadn't expired (so a nonce can be used only once).
  async consumeAttempt(attemptSecret, now) {
    const attempt = await this.attempts.findOneAndDelete({ _id: hash(attemptSecret) });
    return attempt && attempt.expiresAt > now ? attempt.nonce : null;
  }

  // ---- Sessions
  async create({ sessionSecret, userId, tenantId, objectId, isSystemAdmin, now, idleMs, maxMs }) {
    const doc = { _id: hash(sessionSecret), userId, tenantId, objectId, isSystemAdmin, createdAt: now, lastSeenAt: now, idleExpiresAt: new Date(now.getTime() + idleMs), expiresAt: new Date(now.getTime() + maxMs) };
    await this.sessions.insertOne(doc);
    return doc;
  }

  findBySecret(sessionSecret) { return this.sessions.findOne({ _id: hash(sessionSecret) }); }
  findById(id) { return this.sessions.findOne({ _id: id }); }
  // Employee Management P2 (employees/jarc-access.js, read-only): sessions that haven't reached their absolute expiry, only
  // what the access index needs to mirror auth/session.js (user, identity, JARC.Admin at sign-in, idle expiry, last activity).
  // _id (the secret's hash) is never read. JARC.Admin sessions first, then the most recently active, so if the cap is ever
  // reached the sessions dropped are ordinary, old ones (the index marks the answer truncated).
  listLiveForAccessIndex(now) {
    return this.sessions.find({ expiresAt: { $gt: now } }, { sort: { isSystemAdmin: -1, lastSeenAt: -1 }, limit: 5000, projection: { _id: 0, userId: 1, tenantId: 1, objectId: 1, isSystemAdmin: 1, expiresAt: 1, idleExpiresAt: 1, lastSeenAt: 1 } }).toArray();
  }
  // Employee Management P3 (read-only): how many live sessions one person has, bound to their identity as auth/session.js checks
  // (indexed on userId; _id is never read).
  countLiveForUser(userId, { tenantId, objectId }, now) {
    return this.sessions.countDocuments({ userId, tenantId, objectId, expiresAt: { $gt: now }, idleExpiresAt: { $gt: now } });
  }

  async touch(id, now, idleMs) { await this.sessions.updateOne({ _id: id }, { $set: { lastSeenAt: now, idleExpiresAt: new Date(now.getTime() + idleMs) } }); }

  async remove(id) { await this.sessions.deleteOne({ _id: id }); }

  async removeBySecret(sessionSecret) { await this.sessions.deleteOne({ _id: hash(sessionSecret) }); }

  // Ends every session of one person (an account was blocked). Returns how many ended.
  async removeForUser(userId) { const { deletedCount } = await this.sessions.deleteMany({ userId }); return deletedCount; }
}

module.exports = { SessionRepository, hashSecret: hash };
