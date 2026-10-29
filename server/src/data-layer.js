// Builds the MongoDB repositories and services from one connected MongoConnection.
const { UserRepository } = require("./repositories/mongo/user-repository");
const { WorkspaceRepository } = require("./repositories/mongo/workspace-repository");
const { MembershipRepository } = require("./repositories/mongo/membership-repository");
const { BoardRepository } = require("./repositories/mongo/board-repository");
const { RecordRepository } = require("./repositories/mongo/record-repository");
const { ActivityRepository } = require("./repositories/mongo/activity-repository");
const { SessionRepository } = require("./repositories/mongo/session-repository");
const { AttachmentRepository } = require("./repositories/mongo/attachment-repository");
const { GridFsFileStore, AttachmentStorage, createS3FileStore } = require("./files/file-store");
const { StorageUsageRepository } = require("./repositories/mongo/storage-usage-repository");
const { FileService } = require("./services/file-service");
const { SearchService } = require("./services/search-service");
const { IntegrationRepository } = require("./repositories/mongo/integration-repository");
const { CommentRepository } = require("./repositories/mongo/comment-repository");
const { CommentService } = require("./services/comment-service");
const { MondayIntegration } = require("./integrations/monday/service");
const { WorkspaceService } = require("./services/workspace-service");
const { BoardService } = require("./services/board-service");
const { RecordService } = require("./services/record-service");
const { ImportService } = require("./services/import-service");
const { BoardSchemaService } = require("./services/board-schema-service");
const { MembershipService } = require("./services/membership-service");
const { AccountAuditRepository } = require("./repositories/mongo/account-audit-repository");
const { AccountService } = require("./services/account-service");

// fileStore: where attachment bytes go (default GridFS in the same database; tests pass a MemoryFileStore).
// maxFileStorageBytes: the cap on all attachments together (see services/file-service.js).
// monday: the monday.com integration settings (config.monday; off when absent); fetch: for the monday.com API (tests
// pass a mock — tests never reach monday.com).
// attachments: config.attachments (where new uploads go; the S3 bucket when configured). s3Store: tests pass a store
// pointed at a local mock instead of real settings. GridFS is always available, so existing files stay readable.
function createDataLayer({ connection, logger = console, fileStore = new GridFsFileStore(connection.db), maxFileStorageBytes, attachments = null, s3Store = null, monday = null, fetch = globalThis.fetch } = {}) {
  const db = connection.db;
  const s3 = s3Store || (attachments?.s3 ? createS3FileStore(attachments.s3) : null);
  const storage = new AttachmentStorage({ stores: { gridfs: fileStore, s3 }, defaultProvider: attachments?.defaultProvider || "gridfs" });
  const limits = { gridfs: maxFileStorageBytes || undefined, ...(s3 ? { s3: attachments?.s3?.maxTotalBytes ?? s3Store?.maxTotalBytes } : {}) };
  const repos = {
    users: new UserRepository(db),
    workspaces: new WorkspaceRepository(db),
    memberships: new MembershipRepository(db),
    boards: new BoardRepository(db),
    records: new RecordRepository(db),
    activities: new ActivityRepository(db),
    sessions: new SessionRepository(db),
    attachments: new AttachmentRepository(db),
    integrations: new IntegrationRepository(db),
    comments: new CommentRepository(db),
    storageUsage: new StorageUsageRepository(db),
    accountAudit: new AccountAuditRepository(db)
  };
  const deps = { repos, connection, logger };
  return {
    connection,
    repos,
    services: { workspaces: new WorkspaceService(deps), boards: new BoardService(deps), records: new RecordService(deps), imports: new ImportService(deps), schema: new BoardSchemaService(deps), members: new MembershipService(deps),
      // Account Management (Phase M4.3); unused while ACCOUNT_MANAGEMENT=off.
      accounts: new AccountService(deps),
      search: new SearchService({ repos }),
      // access is attached when the routes are mounted (it depends on the access policy).
      comments: new CommentService({ repos, connection, logger }),
      integration: new MondayIntegration({ repos, connection, config: monday, fetch, logger }),
      files: new FileService({ repos, storage, logger, ...(maxFileStorageBytes ? { maxTotalBytes: maxFileStorageBytes } : {}), limits: Object.fromEntries(Object.entries(limits).filter(([, v]) => v)) }),
      // Read-only views used by the notification feed and People columns.
      activity: { recent: (options) => repos.activities.listRecent(options) },
      people: {
        active: () => repos.users.listActive(),
        members: async (workspaceId) => repos.users.findByIds((await repos.memberships.listByWorkspace(workspaceId)).filter((m) => m.status === "active").map((m) => m.userId))
      } }
  };
}

module.exports = { createDataLayer };
