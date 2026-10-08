// Shared test helpers. Tests use an ephemeral port on 127.0.0.1 and never need MongoDB or network access.
const { createApp } = require("../src/app");
const { MemoryStateRepository } = require("../src/repositories/memory-state-repository");

async function startApp(options = {}) {
  const logger = { errors: [], error(...args) { this.errors.push(args); } };
  const repository = options.repository || new MemoryStateRepository();
  const app = createApp({ repository, environment: "test", logger, ...options });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, repository, logger, close: () => new Promise((resolve) => server.close(resolve)) };
}

// The smallest document with the shape the frontend saves.
function validState(overrides = {}) {
  return {
    schemaVersion: 1,
    workspaces: [{ id: "operations", name: "Operations", boards: [{ id: "ops-intake", name: "Operations intake", columns: [{ key: "serial", label: "Item", type: "text" }], records: [{ id: 1, serial: "First record" }] }] }],
    members: [],
    currentWorkspaceId: "operations",
    currentBoardId: "ops-intake",
    settings: { density: "comfortable" },
    profile: { name: "Test" },
    notifications: [],
    recentBoards: [],
    ...overrides
  };
}

module.exports = { startApp, validState };
