// GET /api/v1/search?q=<2–100 characters>&limit=<1–50, default 20>  (see services/search-service.js)
// Mounted after the session check like every resource route: no session → 401. Only workspaces the caller can see
// are searched (the same rule as GET /workspaces). Limited to 20 searches per person per 10 seconds.
const express = require("express");
const { ObjectId } = require("mongodb");
const { allowOnly, queryString, fail } = require("../validation/common");
const { sendError } = require("../middleware/errors");

const WINDOW_MS = 10000;
const PER_WINDOW = 20;

function searchLimiter({ perWindow = PER_WINDOW, windowMs = WINDOW_MS } = {}) {
  const recent = new Map();
  return (userKey) => {
    const now = Date.now(), times = (recent.get(userKey) || []).filter((t) => now - t < windowMs);
    if (times.length >= perWindow) { recent.set(userKey, times); return false; }
    times.push(now); recent.set(userKey, times);
    if (recent.size > 5000) for (const [k, v] of recent) if (!v.some((t) => now - t < windowMs)) recent.delete(k);
    return true;
  };
}

function searchRoutes({ services, access, limiter = searchLimiter() }) {
  const router = express.Router();
  router.get("/search", async (req, res) => {
    allowOnly(req.query, ["q", "limit"], "the query");
    const q = (queryString(req.query.q, "q") ?? "").trim();
    if (q.length < 2 || q.length > 100) fail("q must be 2 to 100 characters.");
    const limitText = queryString(req.query.limit, "limit");
    if (limitText !== undefined && (!/^\d{1,2}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 50)) fail("limit must be a whole number from 1 to 50.");
    if (!limiter(req.actor.userId.toHexString())) return sendError(res, 429, "RATE_LIMITED", "Too many searches. Wait a few seconds and try again.");
    const roles = await access.visibleRoles(req.actor); // null = every workspace
    const workspaceIds = roles ? [...roles.keys()].map((id) => new ObjectId(id)) : null;
    const result = workspaceIds && !workspaceIds.length ? { items: [], more: false, partial: false } : await services.search.records(q, { workspaceIds, limit: limitText === undefined ? 20 : Number(limitText) });
    res.status(200).set("Cache-Control", "no-store").json(result);
  });
  return router;
}

module.exports = { searchRoutes, searchLimiter };
