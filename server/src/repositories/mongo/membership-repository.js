// workspaceMembers collection: who belongs to which workspace, with a per-workspace role. Roles are never global.
// Enforcement (who may do what) arrives with authentication; Stage 10 only stores memberships.
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

  listByWorkspace(workspaceId) { return this.collection.find({ workspaceId }, { sort: { createdAt: 1 }, limit: 1000 }).toArray(); }

  async deleteByWorkspace(workspaceId, { session } = {}) {
    const { deletedCount } = await this.collection.deleteMany({ workspaceId: scopedId(workspaceId, "workspaceId") }, { session });
    return deletedCount;
  }
}

module.exports = { MembershipRepository, ROLES, STATUSES };
