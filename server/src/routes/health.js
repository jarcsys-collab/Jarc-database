const express = require("express");

const SERVICE = "jarc-database-api";

// GET /api/v1 and GET /api/v1/health. No configuration values, paths or versions of dependencies are exposed.
function healthRoutes({ environment, version }) {
  const router = express.Router();
  router.get("/", (req, res) => res.json({ service: SERVICE, apiVersion: "v1", version }));
  router.get("/health", (req, res) => res.set("Cache-Control", "no-store").json({ status: "ok", service: SERVICE, environment, timestamp: new Date().toISOString() }));
  return router;
}

module.exports = { healthRoutes, SERVICE };
