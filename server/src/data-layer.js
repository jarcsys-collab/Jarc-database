// Builds the MongoDB repositories and services from one connected MongoConnection.
const { UserRepository } = require("./repositories/mongo/user-repository");
const { WorkspaceRepository } = require("./repositories/mongo/workspace-repository");
const { MembershipRepository } = require("./repositories/mongo/membership-repository");
const { BoardRepository } = require("./repositories/mongo/board-repository");
const { RecordRepository } = require("./repositories/mongo/record-repository");
const { ActivityRepository } = require("./repositories/mongo/activity-repository");
const { SessionRepository } = require("./repositories/mongo/session-repository");
const { AttachmentRepository } = require("./repositories/mongo/attachment-repository");
const { GridFsFileStore } = require("./files/file-store");
const { FileService } = require("./services/file-service");
const { WorkspaceService } = require("./services/workspace-service");
const { BoardService } = require("./services/board-service");
const { RecordService } = require("./services/record-service");
const { ImportService } = require("./services/import-service");
const { BoardSchemaService } = require("./services/board-schema-service");
const { MembershipService } = require("./services/membership-service");

// fileStore: where attachment bytes go (default GridFS in the same database; tests pass a MemoryFileStore).
// maxFileStorageBytes: the cap on all attachments together (see services/file-service.js).
function createDataLayer({ connection, logger = console, fileStore = new GridFsFileStore(connection.db), maxFileStorageBytes } = {}) {
  const db = connection.db;
  const repos = {
    users: new UserRepository(db),
    workspaces: new WorkspaceRepository(db),
    memberships: new MembershipRepository(db),
    boards: new BoardRepository(db),
    records: new RecordRepository(db),
    activities: new ActivityRepository(db),
    sessions: new SessionRepository(db),
    attachments: new AttachmentRepository(db)
  };
  const deps = { repos, connection, logger };
  return {
    connection,
    repos,
    services: { workspaces: new WorkspaceService(deps), boards: new BoardService(deps), records: new RecordService(deps), imports: new ImportService(deps), schema: new BoardSchemaService(deps), members: new MembershipService(deps),
      files: new FileService({ repos, store: fileStore, logger, ...(maxFileStorageBytes ? { maxTotalBytes: maxFileStorageBytes } : {}) }),
      // Read-only views used by the notification feed and People columns.
      activity: { recent: (options) => repos.activities.listRecent(options) },
      people: {
        active: () => repos.users.listActive(),
        members: async (workspaceId) => repos.users.findByIds((await repos.memberships.listByWorkspace(workspaceId)).filter((m) => m.status === "active").map((m) => m.userId))
      } }
  };
}

module.exports = { createDataLayer };
