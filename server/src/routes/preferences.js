// Personal preferences of the signed-in person (Phase 9C), stored on their own user document (users.preferences),
// keyed by the stable Microsoft Entra identity behind the session — never by an ID from the request. They follow the
// person to every browser and device. Mounted after the session check (PUT needs CSRF like every change).
//   GET /me/preferences                      → { appearance: { theme?, palette?, accent?, density?, recentIcons? } }
//   PUT /me/preferences { appearance }       replaces the appearance preferences (validated; unknown fields refused)
const express = require("express");
const { allowOnly, requireBody } = require("../validation/common");
const { appearance } = require("../validation/appearance");
const { sendError } = require("../middleware/errors");

function preferenceRoutes({ repos, perMinute = 60 }) {
  const router = express.Router();
  const hits = new Map();
  const limited = (key) => { const now = Date.now(), list = (hits.get(key) || []).filter((t) => now - t < 60000); list.push(now); hits.set(key, list); if (hits.size > 10000) hits.clear(); return list.length > perMinute; };
  const send = (res, body) => res.status(200).set("Cache-Control", "no-store").json(body);
  router.get("/me/preferences", async (req, res) => {
    allowOnly(req.query, [], "the query");
    const user = await repos.users.findById(req.actor.userId);
    send(res, { appearance: user?.preferences?.appearance || {} });
  });
  router.put("/me/preferences", async (req, res) => {
    allowOnly(req.query, [], "the query");
    const body = requireBody(req.body); allowOnly(body, ["appearance"], "the preferences");
    const value = appearance(body.appearance);
    if (limited(req.actor.userId.toHexString())) return sendError(res, 429, "RATE_LIMITED", "Too many changes. Wait a moment and try again.");
    await repos.users.setPreferences(req.actor.userId, { appearance: value, updatedAt: new Date() });
    send(res, { appearance: value });
  });
  return router;
}

module.exports = { preferenceRoutes };
