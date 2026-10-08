// users collection. Ready for Microsoft Entra ID: a person's identity will be { tenantId, entraObjectId } (immutable
// in Entra). Email is stored for display and invitations only and is never the identity key.
//
// Stage 10 creates no real users: Entra sign-in does not exist yet. The only user it creates is the fixed
// DEVELOPMENT actor (see context/dev-actor.js), which is refused in production.
const { COLLECTIONS } = require("../../db/bootstrap");

class UserRepository {
  constructor(db) { this.collection = db.collection(COLLECTIONS.users); }

  findById(id) { return this.collection.findOne({ _id: id }); }

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

module.exports = { UserRepository };
