// GET /api/v1/search?q=<2–100 characters>&limit=<1–50, default 20>  (see services/search-service.js)
// Mounted after the session check like every resource route: no session → 401. Only workspaces the caller can see
// are searched (the same rule as GET /workspaces). Limited to 20 searches per person per 10 seconds.
//
// Command Center (Phase 14), same session check and the same per-person search limit:
//   GET    /search/global?q&type&workspaceId&boardId&status&priority&assignee&from&to&cursor&limit
//            grouped results (workspaces, boards, records, comments); see validation/search.js for every parameter
//   GET    /me/recents       the caller's recently opened destinations they can still open (others are left out)
//   POST   /me/recents       { ref: "workspace|board|record:<id>" } remember a visit (only to something visible)
//   DELETE /me/recents       forget the caller's history
// Recents are IDs on the caller's own user document (users.preferences.navigation), keyed by their identity — never
// search text, never in this browser's storage, never readable by anyone else.
const express = require("express");
const { ObjectId } = require("mongodb");
const { allowOnly, queryString, fail, requireBody } = require("../validation/common");
const { searchParams, destinationRef } = require("../validation/search");
const { MAX_RECENTS } = require("../services/search-service");
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

function searchRoutes({ services, access, repos, limiter = searchLimiter(), recentLimiter = searchLimiter({ perWindow: 30, windowMs: 60000 }) }) {
  const router = express.Router();
  const send = (res, body) => res.status(200).set("Cache-Control", "no-store").json(body);
  const tooMany = (res) => sendError(res, 429, "RATE_LIMITED", "Too many searches. Wait a few seconds and try again.");
  const scopeOf = async (actor) => ({ roles: await access.visibleRoles(actor), globalRole: access.globalRole(actor) });

  router.get("/search", async (req, res) => {
    allowOnly(req.query, ["q", "limit"], "the query");
    const q = (queryString(req.query.q, "q") ?? "").trim();
    if (q.length < 2 || q.length > 100) fail("q must be 2 to 100 characters.");
    const limitText = queryString(req.query.limit, "limit");
    if (limitText !== undefined && (!/^\d{1,2}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 50)) fail("limit must be a whole number from 1 to 50.");
    if (!limiter(req.actor.userId.toHexString())) return tooMany(res);
    const roles = await access.visibleRoles(req.actor); // null = every workspace
    const workspaceIds = roles ? [...roles.keys()].map((id) => new ObjectId(id)) : null;
    const result = workspaceIds && !workspaceIds.length ? { items: [], more: false, partial: false } : await services.search.records(q, { workspaceIds, limit: limitText === undefined ? 20 : Number(limitText) });
    send(res, result);
  });

  router.get("/search/global", async (req, res) => {
    const params = searchParams(req.query, req.actor.userId);
    if (!limiter(req.actor.userId.toHexString())) return tooMany(res);
    send(res, await services.search.global(await scopeOf(req.actor), params));
  });

  const recentsOf = async (userId) => {
    const list = (await repos.users.findById(userId))?.preferences?.navigation?.recents;
    return Array.isArray(list) ? list.filter((r) => r && typeof r.ref === "string").slice(0, MAX_RECENTS) : [];
  };
  router.get("/me/recents", async (req, res) => {
    allowOnly(req.query, [], "the query");
    const stored = await recentsOf(req.actor.userId);
    const refs = stored.map((r) => { try { return destinationRef(r.ref); } catch { return null; } }).filter(Boolean);
    const at = new Map(stored.map((r) => [r.ref, r.at]));
    const items = await services.search.destinations(await scopeOf(req.actor), refs);
    send(res, { items: items.map((i) => ({ ...i, visitedAt: at.get(`${i.type}:${i.id}`) instanceof Date ? at.get(`${i.type}:${i.id}`).toISOString() : null })) });
  });
  router.post("/me/recents", async (req, res) => {
    allowOnly(req.query, [], "the query");
    const body = requireBody(req.body); allowOnly(body, ["ref"], "the visit");
    const ref = destinationRef(body.ref);
    if (!recentLimiter(req.actor.userId.toHexString())) return sendError(res, 429, "RATE_LIMITED", "Too many changes. Wait a moment and try again.");
    // Only something the caller can open now is remembered (an ID from elsewhere is ignored, without saying why).
    const [visible] = await services.search.destinations(await scopeOf(req.actor), [ref]);
    if (!visible) return send(res, { remembered: false });
    const key = `${ref.type}:${ref.id.toHexString()}`;
    const recents = [{ ref: key, at: new Date() }, ...(await recentsOf(req.actor.userId)).filter((r) => r.ref !== key)].slice(0, MAX_RECENTS);
    await repos.users.setPreferences(req.actor.userId, { navigation: { recents } });
    send(res, { remembered: true });
  });
  router.delete("/me/recents", async (req, res) => {
    allowOnly(req.query, [], "the query");
    await repos.users.setPreferences(req.actor.userId, { navigation: { recents: [] } });
    send(res, { cleared: true });
  });
  return router;
}

module.exports = { searchRoutes, searchLimiter };
