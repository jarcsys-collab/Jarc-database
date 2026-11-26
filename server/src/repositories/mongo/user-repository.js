// users collection. A person's identity is { tenantId, entraObjectId } — immutable in Microsoft Entra ID and
// enforced unique by the uniq_entra_identity index. Display name and email are stored for display (and for an admin to
// find someone when adding members); they are never the identity key.
//
// AUTH_MODE=entra: users are created on their first valid sign-in (upsertFromEntra).
// AUTH_MODE=dev:   the only user is the fixed DEVELOPMENT actor (see context/dev-actor.js), refused in production.
const { COLLECTIONS } = require("../../db/bootstrap");

const PROFILE_REFRESH_MS = 15 * 60 * 1000; // lastLoginAt / profile are refreshed at most every 15 minutes

class UserRepository {
  constructor(db) { this.collection = db.collection(COLLECTIONS.users); }

  findById(id) { return this.collection.findOne({ _id: id }); }
  // Personal preferences (Phase 9C): only the preferences field of the person's own document changes.
  // Each part (appearance, navigation) is replaced on its own, so saving one never erases the other.
  async setPreferences(id, preferences) {
    const set = Object.fromEntries(Object.entries(preferences).map(([k, v]) => [`preferences.${k}`, v]));
    await this.collection.updateOne({ _id: id }, { $set: set });
  }

  findByIds(ids) { return ids.length ? this.collection.find({ _id: { $in: ids } }, { limit: 5000 }).toArray() : Promise.resolve([]); }

  // Active users (people who can be assigned), at most 2000.
  listActive() { return this.collection.find({ status: "active" }, { limit: 2000 }).toArray(); }

  // Exact, case-insensitive email lookup among signed-in Entra users (to add a member): an equality match on a
  // stored lower-case copy, never a pattern built from input.
  findByEmail(email) { return this.collection.findOne({ source: "entra", emailNormalized: String(email).toLowerCase() }); }

  // Returns the user for this Entra identity, creating it on first sign-in. Simultaneous first sign-ins can't create
  // two users: the unique index rejects the second insert, which then reads the user the first one created.
  async upsertFromEntra(identity, now = new Date()) { return (await this.signInFromEntra(identity, now)).user; }

  // { user, created }. trackAccounts (ACCOUNT_MANAGEMENT staged/enforced): a NEW user starts as a pending account with
  // no role (auth/accounts.js); existing users are never given an account here (no silent promotion or lock-out).
  async signInFromEntra({ tenantId, objectId, displayName, email }, now = new Date(), { trackAccounts = false } = {}) {
    const identity = { tenantId, entraObjectId: objectId };
    let user = await this.collection.findOne(identity);
    if (!user) {
      const doc = { ...identity, source: "entra", displayName, email, emailNormalized: email ? email.toLowerCase() : null, status: "active", createdAt: now, updatedAt: now, lastLoginAt: now,
        ...(trackAccounts ? { firstLoginAt: now, account: { status: "pending", role: null, version: 1, createdAt: now, updatedAt: now } } : {}) };
      try {
        await this.collection.insertOne(doc);
        return { user: doc, created: true };
      } catch (error) {
        if (error?.code !== 11000) throw error;
        user = await this.collection.findOne(identity);
        if (!user) throw error;
      }
    }
    const stale = !(user.lastLoginAt instanceof Date) || now - user.lastLoginAt > PROFILE_REFRESH_MS;
    if (stale || user.displayName !== displayName || user.email !== email) {
      // Only display fields and timestamps; status (e.g. disabled) is never changed by a sign-in.
      await this.collection.updateOne({ _id: user._id }, { $set: { displayName, email, emailNormalized: email ? email.toLowerCase() : null, lastLoginAt: now, updatedAt: now } });
      user = { ...user, displayName, email, lastLoginAt: now, updatedAt: now };
    }
    return { user, created: false };
  }

  // ---- Account Management (Phase M4.3)
  // Every successful sign-in (not only every 15 minutes) when accounts are tracked; firstLoginAt only once.
  async recordLogin(id, now) {
    await this.collection.updateOne({ _id: id }, { $set: { lastLoginAt: now } });
    await this.collection.updateOne({ _id: id, firstLoginAt: { $exists: false } }, { $set: { firstLoginAt: now } });
  }

  // Signed-in Entra people (the accounts Account Management lists), at most 5000.
  listEntra() { return this.collection.find({ source: "entra" }, { sort: { createdAt: 1 }, limit: 5000 }).toArray(); }
  // Employee Management P2 (employees/jarc-access.js, read-only): the same people, only the fields the access index uses
  // (identity, status, account, sign-in times; never the name, email or preferences), at most 5000.
  listEntraForAccessIndex() {
    return this.collection.find({ source: "entra" }, { sort: { _id: 1 }, limit: 5000, projection: { _id: 1, source: 1, tenantId: 1, entraObjectId: 1, status: 1, account: 1, createdAt: 1, lastLoginAt: 1, provisionedAt: 1 } }).toArray();
  }

  // ---- Employee Management P3 (Access Administration, employees/access-admin.js)
  // The Entra user with exactly this identity (both lower case, as the sign-in verifier stores them; the lookup sign-in uses).
  findEntraIdentity(tenantId, entraObjectId, { session } = {}) { return this.collection.findOne({ tenantId, entraObjectId }, { session }); }
  // A users document created by an administrator for someone who hasn't signed in yet: status "active" (Grant) or "revoked"
  // (blocked before the first sign-in). The first sign-in finds it by identity and reuses it (signInFromEntra); it never changes
  // its status. A duplicate identity is the unique index's E11000 (the caller answers 409).
  // trackAccounts (ACCOUNT_MANAGEMENT staged/enforced): the same pending account with no role a first sign-in would create.
  async provisionEntra({ tenantId, entraObjectId, displayName, email, status, reason = null, by, now, trackAccounts = false }, { session } = {}) {
    const doc = { tenantId, entraObjectId, source: "entra", displayName, email, emailNormalized: email ? email.toLowerCase() : null, status, createdAt: now, updatedAt: now, provisionedAt: now, provisionedBy: by, statusChangedAt: now, statusReason: reason, accessVersion: 1,
      ...(trackAccounts ? { account: { status: "pending", role: null, version: 1, createdAt: now, updatedAt: now } } : {}) };
    await this.collection.insertOne(doc, { session });
    return doc;
  }
  // Changes users.status only if it is still `fromStatus` at `expectedVersion` (users.accessVersion; missing = 0), and bumps the
  // version. Null when someone else changed it first (the caller answers 409).
  setAccessStatus(id, { fromStatus, expectedVersion, status, reason = null, now }, { session } = {}) {
    const filter = { _id: id, source: "entra", status: fromStatus, accessVersion: expectedVersion === 0 ? { $in: [null, 0] } : expectedVersion };
    return this.collection.findOneAndUpdate(filter, { $set: { status, statusChangedAt: now, statusReason: reason, updatedAt: now }, $inc: { accessVersion: 1 } }, { session, returnDocument: "after" });
  }
  // The listed Employee Management administrators (lower-case object IDs) whose JARC account is active, other than one user.
  countActiveIdentities(tenantId, entraObjectIds, { exceptId = null, session } = {}) {
    if (!entraObjectIds.length) return Promise.resolve(0);
    return this.collection.countDocuments({ tenantId, entraObjectId: { $in: entraObjectIds }, status: "active", ...(exceptId ? { _id: { $ne: exceptId } } : {}) }, { session });
  }
  // Marks the acting administrator's document inside a P3 transaction that touches another listed administrator, so two
  // administrators suspending each other at the same moment conflict (one is retried, then refused) instead of both succeeding.
  async touchAccessActor(id, now, { session } = {}) { await this.collection.updateOne({ _id: id }, { $set: { accessActionAt: now } }, { session }); }

  // ---- P4-0 (lockout protection)
  // Several users by _id inside the caller's transaction (status and account only: what decides a usable workspace admin).
  findByIdsIn(ids, { session } = {}) { return ids.length ? this.collection.find({ _id: { $in: ids } }, { session, limit: 5000, projection: { _id: 1, status: 1, account: 1 } }).toArray() : Promise.resolve([]); }
  // The JARC.Admin app role as seen at this sign-in (routes/auth.js, after the sign-in is accepted). Present: adminRoleSeenAt =
  // now. Absent: adminRoleClearedAt = now, written when the last record said "seen" or when nothing was recorded yet (D-H2: the
  // first sign-in after this change records the observation either way, so the person's status stops being "unknown"); a person
  // already recorded without the role gets no further write. Two additive timestamps, read by the P3 / Account Management JARC
  // administrator guards (auth/accounts.js jarcAdminStatus); they never grant anything. Each write is conditional on what was read,
  // so a concurrent sign-in with the other answer isn't overwritten by a stale one.
  async recordAdminRole(user, present, now) {
    if (!user?._id) return;
    if (present === true) { await this.collection.updateOne({ _id: user._id }, { $set: { adminRoleSeenAt: now } }); return; }
    const seen = user.adminRoleSeenAt instanceof Date, cleared = user.adminRoleClearedAt instanceof Date;
    // Same rule as accounts.adminRoleHeld (held unless cleared is strictly later), so equal timestamps can't lock the role in.
    if (seen && !(cleared && user.adminRoleClearedAt > user.adminRoleSeenAt)) {
      await this.collection.updateOne({ _id: user._id, adminRoleSeenAt: user.adminRoleSeenAt }, { $set: { adminRoleClearedAt: now } });
    } else if (!seen && !cleared) {
      await this.collection.updateOne({ _id: user._id, adminRoleSeenAt: { $exists: false }, adminRoleClearedAt: { $exists: false } }, { $set: { adminRoleClearedAt: now } });
    }
  }
  // Active Super Admin accounts whose users.status is also active (a P3-suspended or revoked Super Admin can't sign in, so it
  // doesn't count, D-H1), other than one user, inside the caller's transaction.
  countUsableSuperAdmins({ exceptId = null, session } = {}) { return this.collection.countDocuments({ "account.status": "active", "account.role": "SUPER_ADMIN", status: "active", ...(exceptId ? { _id: { $ne: exceptId } } : {}) }, { session }); }

  countIdentity(tenantId, entraObjectId) { return this.collection.countDocuments({ tenantId, entraObjectId }); }
  // Users with this email whose identity is NOT the given one (an ambiguous email → identity mapping).
  async countOthersWithEmail(email, userId) { return (await this.collection.find({ emailNormalized: String(email).toLowerCase() }, { limit: 50 }).toArray()).filter((u) => !u._id.equals(userId)).length; }
  countSuperAdmins({ session } = {}) { return this.collection.countDocuments({ "account.status": "active", "account.role": "SUPER_ADMIN" }, { session }); }
  findByIdIn(id, { session } = {}) { return this.collection.findOne({ _id: id }, { session }); }

  // Changes account fields only if the account is still at expectedVersion (0 = a legacy user without an account), and
  // bumps the version, so two administrators can't overwrite each other's change. Returns the updated user or null.
  async updateAccount(id, expectedVersion, fields, now, { session } = {}) {
    const filter = expectedVersion === 0 ? { _id: id, account: { $exists: false } } : { _id: id, "account.version": expectedVersion };
    const set = { "account.version": expectedVersion + 1, "account.updatedAt": now, updatedAt: now };
    for (const [k, v] of Object.entries(fields)) set[`account.${k}`] = v;
    if (expectedVersion === 0) set["account.createdAt"] = now;
    return this.collection.findOneAndUpdate(filter, { $set: set }, { session, returnDocument: "after" });
  }

  // Marks the administrator's own document inside an account-change transaction, so two administrators changing each
  // other at the same moment conflict (one is retried) instead of both succeeding (e.g. removing the last Super Admin).
  async touchAccountActor(id, now, { session } = {}) { await this.collection.updateOne({ _id: id }, { $set: { "account.lastActionAt": now } }, { session }); }

  // Creates the development actor once (upsert on its fixed devKey) and returns it.
  async ensureDevelopmentUser({ devKey, displayName, now }) {
    await this.collection.updateOne(
      { devKey },
      { $setOnInsert: { devKey, source: "development", tenantId: null, entraObjectId: null, displayName, email: null, status: "active", createdAt: now, updatedAt: now } },
      { upsert: true }
    );
    return this.collection.findOne({ devKey });
  }
}

module.exports = { UserRepository, PROFILE_REFRESH_MS };
