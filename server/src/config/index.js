// Runtime configuration from environment variables. Only non-secret settings exist in Stage 9.
const ENVIRONMENTS = ["development", "test", "production"];

function loadConfig(env = process.env) {
  const nodeEnv = ENVIRONMENTS.includes(env.NODE_ENV) ? env.NODE_ENV : "development";
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be a whole number between 0 and 65535.");
  return Object.freeze({
    nodeEnv,
    port,
    host: env.HOST || "127.0.0.1",
    // GET/PUT /api/v1/state is a transitional development endpoint with no authentication. Never in production.
    enableDevStateApi: nodeEnv !== "production"
  });
}

module.exports = { loadConfig };
