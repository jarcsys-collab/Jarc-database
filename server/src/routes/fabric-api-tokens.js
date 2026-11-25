// Managing Fabric Data API tokens from JARC (Fabric Data → Fabric API). Mounted at /fabric/api-tokens after the session check
// (`identify`) and BEFORE the GET-only Fabric data router, so every route needs a signed-in session and every change needs the
// CSRF token (auth/session.js), exactly like the board token routes (routes/api-tokens.js). Every route is for the Fabric API
// administrators only (fabricPermissions.isApiAdmin): anyone else gets 403 FABRIC_API_ADMIN_REQUIRED before anything is read.
// Workspace roles, open access (development_shared), JARC.Admin and JARC_API_ADMIN_OIDS never grant it. An administrator manages
// only THEIR OWN tokens; only Fabric API oversight (fabricPermissions.isApiOversight, FABRIC_API_OVERSIGHT_OIDS) covers everyone's.
// Another person's token is 404 NOT_FOUND without oversight, exactly like an unknown ID.
//
//   GET    /fabric/api-tokens                   { tokens, scope: "own" | "all" }: own tokens, or every owner's with oversight
//                                               (never the digest or the token; each token has mine: boolean)
//   GET    /fabric/api-tokens/activity          { items, scope }: audit entries about own tokens, or every Fabric token with oversight
//   POST   /fabric/api-tokens                   { name, description?, scopes, expiresAt } → the token, and its secret this once
//   POST   /fabric/api-tokens/:tokenId/revoke   an own Fabric token, or anyone's with oversight
// Unknown paths and methods here answer a JSON 404, so nothing falls through to the data router.
const express = require("express");
const { allowOnly, parseId } = require("../validation/common");
const { sendError, apiNotFound } = require("../middleware/errors");
const { searchLimiter } = require("./search");
const { FabricTokenService } = require("../services/api-token-service");

function fabricApiTokenRoutes({ tokens, fabricPermissions, limiter = searchLimiter({ perWindow: 20, windowMs: 60 * 60 * 1000 }) }) {
  const fabric = new FabricTokenService({ tokens, permissions: fabricPermissions });
  const router = express.Router();
  const send = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);
  const noQuery = (req) => allowOnly(req.query, [], "the query");
  const tokenId = (req) => parseId(req.params.tokenId, "tokenId");

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    // API tokens never work on session routes.
    if (req.get("authorization")) return sendError(res, 401, "UNAUTHENTICATED", "Sign in to JARC to manage Fabric API tokens.");
    if (!req.actor) return sendError(res, 401, "UNAUTHENTICATED", "Sign in to JARC to manage Fabric API tokens.");
    fabric.requireAdmin(req.actor);
    return next();
  });
  router.get("/", async (req, res) => { noQuery(req); send(res, 200, { tokens: await fabric.list(req.actor), scope: fabric.scopeOf(req.actor) }); });
  router.get("/activity", async (req, res) => { noQuery(req); send(res, 200, await fabric.activity(req.actor)); });
  router.post("/", async (req, res) => {
    noQuery(req);
    if (!limiter(req.actor.userId.toHexString())) return sendError(res, 429, "RATE_LIMITED", "Too many new tokens in the last hour. Try again later.");
    return send(res, 201, await fabric.create(req.actor, req.body));
  });
  router.post("/:tokenId/revoke", async (req, res) => { noQuery(req); send(res, 200, await fabric.revoke(req.actor, tokenId(req))); });
  router.use(apiNotFound);
  return router;
}

module.exports = { fabricApiTokenRoutes };
