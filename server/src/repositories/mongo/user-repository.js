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

  findByIds(ids) { return ids.length ? this.collection.find({ _id: { $in: ids } }, { limit: 5000 }).toArray() : Promise.resolve([]); }

  // Exact, case-insensitive email lookup among signed-in Entra users (to add a member): an equality match on a
  // stored lower-case copy, never a pattern built from input.
  findByEmail(email) { return this.collection.findOne({ source: "entra", emailNormalized: String(email).toLowerCase() }); }

  // Returns the user for this Entra identity, creating it on first sign-in. Simultaneous first sign-ins can't create
  // two users: the unique index rejects the second insert, which then reads the user the first one created.
  async upsertFromEntra({ tenantId, objectId, displayName, email }, now = new Date()) {
    const identity = { tenantId, entraObjectId: objectId };
    let user = await this.collection.findOne(identity);
    if (!user) {
      const doc = { ...identity, source: "entra", displayName, email, emailNormalized: email ? email.toLowerCase() : null, status: "active", createdAt: now, updatedAt: now, lastLoginAt: now };
      try {
        await this.collection.insertOne(doc);
        return doc;
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
    return user;
  }

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
