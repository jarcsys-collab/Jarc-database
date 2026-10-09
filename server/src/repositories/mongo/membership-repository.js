// workspaceMembers collection: who belongs to which workspace, with a per-workspace role. Roles are never global
// (the application-wide SYSTEM_ADMIN comes from an Entra app role in the access token, not from this collection).
const { COLLECTIONS } = require("../../db/bootstrap");
const { scopedId } = require("./base-repository");

const ROLES = Object.freeze(["WORKSPACE_ADMIN", "MEMBER", "VIEWER"]);
const STATUSES = Object.freeze(["active", "invited", "removed"]);

class MembershipRepository {
  constructor(db) { this.collection = db.collection(COLLECTIONS.workspaceMembers); }

  async add({ workspaceId, userId, role, status = "active", now }, { session } = {}) {
    if (!ROLES.includes(role) || !STATUSES.includes(status)) throw new TypeError("Unknown membership role or status.");
    const doc = { workspaceId, userId, role, status, createdAt: now, updatedAt: now };
    await this.collection.insertOne(doc, { session });
    return doc;
  }

  async insertMany(docs, { session } = {}) { if (docs.length) await this.collection.insertMany(docs, { session }); return docs.length; }

  findById(id, { session } = {}) { return this.collection.findOne({ _id: id }, { session }); }

  // The caller's active membership of one workspace, or null.
  findActive(workspaceId, userId) { return this.collection.findOne({ workspaceId, userId, status: "active" }); }

  listForUser(userId) { return this.collection.find({ userId, status: "active" }, { limit: 5000 }).toArray(); }

  listByWorkspace(workspaceId) { return this.collection.find({ workspaceId }, { sort: { createdAt: 1 }, limit: 1000 }).toArray(); }

  countActiveAdmins(workspaceId, { session } = {}) { return this.collection.countDocuments({ workspaceId, role: "WORKSPACE_ADMIN", status: "active" }, { session }); }

  async updateRole(id, role, now, { session } = {}) {
    if (!ROLES.includes(role)) throw new TypeError("Unknown membership role.");
    await this.collection.updateOne({ _id: id }, { $set: { role, updatedAt: now } }, { session });
  }

  async remove(id, { session } = {}) { const { deletedCount } = await this.collection.deleteOne({ _id: id }, { session }); return deletedCount === 1; }

  async deleteByWorkspace(workspaceId, { session } = {}) {
    const { deletedCount } = await this.collection.deleteMany({ workspaceId: scopedId(workspaceId, "workspaceId") }, { session });
    return deletedCount;
  }
}

module.exports = { MembershipRepository, ROLES, STATUSES };
