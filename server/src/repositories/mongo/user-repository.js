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
