// The read-only Fabric Data API for other systems, authenticated ONLY by a Fabric API token (product "fabric"):
//
//   Authorization: Bearer jarc_...
//   GET /external/fabric/status | /:dataset/schema | /:dataset/records | /:dataset/records/:id   (dataset: sales or inventory)
//
// Mounted on the `external` router BEFORE the board token API, so /external/fabric/* never reaches it, and ending in its own JSON
// 404. The paths and responses are the session Fabric routes' (the same injected fabricDataRouter); only the caller differs.
//
// Each request, reusing the board token API's pieces (routes/external-api.js): the method (GET/HEAD only), HTTPS in production,
// no token in the URL, the bearer token (tokens.verify: existence, secret, revocation, expiry; failed attempts limited per address),
// this token's request limit (X-RateLimit-* headers), then the Fabric authority (FabricTokenService.authorize: a Fabric token with
// at least one dataset scope, whose owner is still a Fabric reader right now), then recordUse. Board tokens get 403
// INSUFFICIENT_SCOPE here; the data router answers 403 INSUFFICIENT_SCOPE for a dataset that isn't in req.fabricAccess.datasets.
// Nothing here logs the token, the query string or any data.
const express = require("express");
const { apiNotFound } = require("../middleware/errors");
const { hex } = require("../api/serialize");
const { FabricTokenService } = require("../services/api-token-service");
const { readOnlyGuard, verifiedToken, withinTokenLimit, windowLimiter, FAILED_AUTH } = require("./external-api");

const FABRIC_RATE = Object.freeze({ perWindow: 60, windowMs: 60 * 1000 });

// tokens: the configured ApiTokenService. fabricPermissions: { isApiAdmin, isReader, isSensitiveReader } (isCostReader is accepted
// as the earlier name; see FabricTokenService). fabricDataRouter: the shared GET-only data router; it reads
// req.fabricAccess = { datasets: Set of "sales"/"inventory", sensitive, cost (= sensitive, for one release), via: "token", tokenId }.
// rate: { perWindow, windowMs } per token (FABRIC_API_RATE_PER_MINUTE). failures: optionally the board API's failed-attempt limiter.
function externalFabricRoutes({ tokens, fabricPermissions, fabricDataRouter, environment = "development", rate = FABRIC_RATE, failedAuth = FAILED_AUTH, failures = windowLimiter(failedAuth) }) {
  if (typeof fabricDataRouter !== "function") throw new Error("The Fabric token API needs the Fabric data router.");
  const fabric = new FabricTokenService({ tokens, permissions: fabricPermissions });
  const router = express.Router();
  const limiter = windowLimiter(rate);

  router.use(readOnlyGuard({ environment }));
  router.use(async (req, res, next) => {
    const doc = await verifiedToken(req, res, { tokens, failures });
    if (!doc) return undefined;
    if (!withinTokenLimit(res, { limiter, tokens, doc })) return undefined;
    const { datasets, sensitive } = await fabric.authorize(doc);
    await tokens.recordUse(doc);
    const allowed = sensitive === true;
    req.fabricAccess = Object.freeze({ datasets, sensitive: allowed, cost: allowed, via: "token", tokenId: hex(doc._id) });
    return next();
  });
  router.use(fabricDataRouter);
  router.use(apiNotFound);
  return router;
}

module.exports = { externalFabricRoutes, FABRIC_RATE };
