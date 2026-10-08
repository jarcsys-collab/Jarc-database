// TRANSITIONAL development endpoints (Stage 9):
//   GET /api/v1/state  → { state: <document or null>, revision, updatedAt }
//   PUT /api/v1/state  ← the whole state document (the same JSON the browser keeps in localStorage)
//
// They exist only to prove StorageService → ApiAdapter → Express. They are not the production data API, have no
// authentication, and are disabled when NODE_ENV=production. The final API is resource based
// (/api/v1/workspaces, /api/v1/boards, /api/v1/records) on MongoDB.
const express = require("express");
const { ApiError } = require("../middleware/errors");
const { validateState } = require("../validation/state");

function stateRoutes({ repository }) {
  const router = express.Router();

  router.get("/state", async (req, res) => {
    res.set("Cache-Control", "no-store").json(await repository.loadState());
  });

  router.put("/state", async (req, res) => {
    if (!req.is("application/json")) throw new ApiError(400, "VALIDATION_ERROR", "Send the state as application/json.");
    const problem = validateState(req.body);
    if (problem) throw new ApiError(400, "VALIDATION_ERROR", problem);
    const saved = await repository.saveState(req.body);
    res.set("Cache-Control", "no-store").json({ ok: true, ...saved });
  });

  return router;
}

module.exports = { stateRoutes };
