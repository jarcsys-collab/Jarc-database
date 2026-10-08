// Builds the MongoDB repositories and services from one connected MongoConnection.
const { UserRepository } = require("./repositories/mongo/user-repository");
const { WorkspaceRepository } = require("./repositories/mongo/workspace-repository");
const { MembershipRepository } = require("./repositories/mongo/membership-repository");
const { BoardRepository } = require("./repositories/mongo/board-repository");
const { RecordRepository } = require("./repositories/mongo/record-repository");
const { ActivityRepository } = require("./repositories/mongo/activity-repository");
const { WorkspaceService } = require("./services/workspace-service");
const { BoardService } = require("./services/board-service");
const { RecordService } = require("./services/record-service");
const { ImportService } = require("./services/import-service");

function createDataLayer({ connection, logger = console }) {
  const db = connection.db;
  const repos = {
    users: new UserRepository(db),
    workspaces: new WorkspaceRepository(db),
    memberships: new MembershipRepository(db),
    boards: new BoardRepository(db),
    records: new RecordRepository(db),
    activities: new ActivityRepository(db)
  };
  const deps = { repos, connection, logger };
  return {
    connection,
    repos,
    services: { workspaces: new WorkspaceService(deps), boards: new BoardService(deps), records: new RecordService(deps), imports: new ImportService(deps) }
  };
}

module.exports = { createDataLayer };
