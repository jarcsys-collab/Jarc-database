// Workspaces: create (creator becomes WORKSPACE_ADMIN), read, versioned update, and a controlled cascading delete.
const { ObjectId } = require("mongodb");
const validate = require("../validation/resources");
const { notFound, conflict, missingOrStale, activityEntry, appendActivity, fieldChanges, sweepAfterCommit } = require("./shared");

class WorkspaceService {
  constructor({ repos, connection, logger }) { Object.assign(this, { repos, connection, logger }); }

  list() { return this.repos.workspaces.list(); }

  async get(id) {
    const workspace = await this.repos.workspaces.findById(id);
    if (!workspace) throw notFound("workspace");
    return workspace;
  }

  // The workspace and its creator's membership are written together in one transaction, so a workspace never
  // exists without an admin.
  async create(raw, actor) {
    const input = validate.workspaceCreate(raw);
    const now = new Date();
    const position = input.position ?? await this.repos.workspaces.nextPosition();
    const doc = { _id: new ObjectId(), name: input.name, description: input.description, icon: input.icon, color: input.color, archived: false, position, createdBy: actor.userId, createdAt: now, updatedAt: now, version: 1 };
    await this.connection.withTransaction(async (session) => {
      await this.repos.workspaces.insert(doc, { session });
      await this.repos.memberships.add({ workspaceId: doc._id, userId: actor.userId, role: "WORKSPACE_ADMIN", now }, { session });
      await this.repos.activities.append(activityEntry({ workspaceId: doc._id, actorUserId: actor.userId, action: "workspace.created", entityType: "workspace", entityId: doc._id, summary: `Created workspace ${doc.name}`, now }), { session });
    });
    return doc;
  }

  async update(id, raw, actor) {
    const { expectedVersion, set } = validate.workspacePatch(raw);
    const now = new Date();
    const before = await this.repos.workspaces.updateVersioned(id, expectedVersion, { ...set, updatedAt: now });
    if (!before) throw await missingOrStale(this.repos.workspaces, id, "workspace");
    const after = { ...before, ...set, updatedAt: now, version: before.version + 1 };
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: id, actorUserId: actor.userId, action: "workspace.updated", entityType: "workspace", entityId: id, changes: fieldChanges(before, after, Object.keys(set)), now }));
    return after;
  }

  // DELETE policy: cascade. In one transaction, removes the workspace's records, boards and memberships (each
  // deleteMany is scoped to this workspace's ObjectId) and the workspace itself, if its version still matches.
  // Activity history is kept as the audit trail, plus one "workspace.deleted" entry. A final scoped sweep after the
  // commit removes any board or record created concurrently while the transaction ran, so no orphans remain.
  async delete(id, expectedVersion, actor) {
    const now = new Date();
    const removed = await this.connection.withTransaction(async (session) => {
      const workspace = await this.repos.workspaces.findById(id, { session });
      if (!workspace) throw notFound("workspace");
      if (workspace.version !== expectedVersion) throw conflict("workspace", workspace);
      const records = await this.repos.records.deleteByWorkspace(id, { session });
      const boards = await this.repos.boards.deleteByWorkspace(id, { session });
      const memberships = await this.repos.memberships.deleteByWorkspace(id, { session });
      if (!await this.repos.workspaces.deleteVersioned(id, expectedVersion, { session })) throw conflict("workspace", workspace);
      await this.repos.activities.append(activityEntry({ workspaceId: id, actorUserId: actor.userId, action: "workspace.deleted", entityType: "workspace", entityId: id, summary: `Deleted workspace ${workspace.name} with ${boards} boards and ${records} records`, now }), { session });
      return { boards, records, memberships };
    });
    removed.records += await sweepAfterCommit(this.logger, "workspace records", () => this.repos.records.deleteByWorkspace(id));
    removed.boards += await sweepAfterCommit(this.logger, "workspace boards", () => this.repos.boards.deleteByWorkspace(id));
    return removed;
  }
}

module.exports = { WorkspaceService };
