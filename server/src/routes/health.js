const express = require("express");

const SERVICE = "jarc-database-api";

// GET /api/v1, GET /api/v1/health (liveness) and GET /api/v1/health/ready (readiness).
// No configuration values, paths, hosts, cluster names, user names or connection strings are exposed.
//
// With MongoDB configured, /health also reports "database": "connected" | "unavailable" and keeps answering 200
// ("status": "degraded" when the database is down): the process is alive, and restarting it would not fix the
// database. /health/ready answers 503 SERVICE_UNAVAILABLE until the database responds, for load balancers and
// deploy checks. Without a database (Stage 9 memory mode) the responses are unchanged and always ready.
function healthRoutes({ environment, version, database = null }) {
  const router = express.Router();
  router.get("/", (req, res) => res.json({ service: SERVICE, apiVersion: "v1", version }));
  router.get("/health", async (req, res) => {
    const body = { status: "ok", service: SERVICE, environment, timestamp: new Date().toISOString() };
    if (database) {
      body.database = (await database.ping()) ? "connected" : "unavailable";
      if (body.database !== "connected") body.status = "degraded";
    }
    res.set("Cache-Control", "no-store").json(body);
  });
  router.get("/health/ready", async (req, res) => {
    const ready = database ? await database.ping() : true;
    res.status(ready ? 200 : 503).set("Cache-Control", "no-store").json(ready
      ? { status: "ready", ...(database ? { database: "connected" } : {}) }
      : { status: "unavailable", database: "unavailable", error: { code: "SERVICE_UNAVAILABLE", message: "The database is temporarily unavailable." } });
  });
  return router;
}

module.exports = { healthRoutes, SERVICE };
