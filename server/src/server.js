// Starts the JARC Database server: the API under /api/v1 and the frontend from site/, on one origin.
const { loadConfig } = require("./config");
const { createApp } = require("./app");
const { MemoryStateRepository } = require("./repositories/memory-state-repository");

const config = loadConfig();
const repository = config.enableDevStateApi ? new MemoryStateRepository() : null;
const app = createApp({ repository, environment: config.nodeEnv, enableDevStateApi: config.enableDevStateApi });

const server = app.listen(config.port, config.host, () => {
  const { port } = server.address();
  console.log(`JARC Database server (${config.nodeEnv}) on http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${port}/`);
  if (config.enableDevStateApi) console.log("Development state API enabled: data is kept in memory only and is cleared when the server restarts.");
  else console.log("Development state API disabled (production). Only health endpoints and the frontend are served.");
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
