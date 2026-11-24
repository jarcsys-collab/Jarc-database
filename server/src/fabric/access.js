// Who may read Fabric Data. Only the Microsoft Entra object IDs in FABRIC_DATA_READER_OIDS (config.fabricData), only within
// JARC's own tenant, and only with a JARC session. Nothing else grants it: not JARC.Admin, isSystemAdmin, workspace roles,
// ACCESS_POLICY=development_shared, JARC_BETA_OPEN_EDITING or account roles. Empty lists mean nobody (fails closed).
// Readers read both datasets (sales, inventory).
//   sensitive FABRIC_DATA_COST_READER_OIDS as well (name kept for compatibility): the sensitive financial and inventory fields
//             (landed cost, cost amounts, prices) and, in the invoice views, cost, profit and margin. `cost` is its alias.
//   apiAdmin FABRIC_API_ADMIN_OIDS as well: issues and revokes Fabric API tokens
const { sendError } = require("../middleware/errors");
const { DATASET_NAMES } = require("./datasets");

// identity: { tenantId, objectId } as verified at Microsoft sign-in (a session, or a token owner's stored user).
const listed = (identity, list = [], tenantId) => {
  const tid = typeof identity?.tenantId === "string" ? identity.tenantId.toLowerCase() : null;
  const oid = typeof identity?.objectId === "string" ? identity.objectId.toLowerCase() : null;
  return Boolean(tenantId && tid && oid && tid === String(tenantId).toLowerCase() && Array.isArray(list) && list.includes(oid));
};
// { read, sensitive, cost (= sensitive), apiAdmin } for a verified identity: for token owners, re-checked on every use (the
// user record's tenantId and entraObjectId).
function fabricIdentityAccess(identity, cfg, tenantId) {
  const read = listed(identity, cfg?.readerObjectIds, tenantId);
  const sensitive = read && listed(identity, cfg?.costReaderObjectIds, tenantId);
  return { read, sensitive, cost: sensitive, apiAdmin: read && listed(identity, cfg?.apiAdminObjectIds, tenantId) };
}
const identityOf = (actor) => (actor?.kind === "entra" ? { tenantId: actor.tenantId, objectId: actor.entraObjectId } : null);
const canReadFabric = (actor, cfg, tenantId) => fabricIdentityAccess(identityOf(actor), cfg, tenantId).read;
const canReadFabricSensitive = (actor, cfg, tenantId) => fabricIdentityAccess(identityOf(actor), cfg, tenantId).sensitive;
const canReadFabricCost = canReadFabricSensitive; // the earlier name
const canManageFabricApi = (actor, cfg, tenantId) => fabricIdentityAccess(identityOf(actor), cfg, tenantId).apiAdmin;

// Session routes (/api/v1/fabric/*), after `identify`. A bearer token is never accepted here (tokens use /external/fabric).
function requireFabricDataRead({ config, tenantId }) {
  return (req, res, next) => {
    if (req.get("authorization") !== undefined) return sendError(res, 401, "UNAUTHENTICATED", "Sign in to JARC to use Fabric Data. API tokens are accepted only under /api/v1/external/fabric.");
    if (!req.actor) return sendError(res, 401, "UNAUTHENTICATED", "Sign in to JARC to use Fabric Data.");
    const access = fabricIdentityAccess(identityOf(req.actor), config, tenantId);
    if (!access.read) return sendError(res, 403, "FABRIC_DATA_FORBIDDEN", "You don't have access to Fabric Data. Ask a JARC administrator if you need it.");
    // Session readers read both datasets.
    req.fabricAccess = Object.freeze({ datasets: new Set(DATASET_NAMES), sensitive: access.sensitive, cost: access.sensitive, via: "session", actorId: String(req.actor.userId) });
    return next();
  };
}

module.exports = { canReadFabric, canReadFabricSensitive, canReadFabricCost, canManageFabricApi, fabricIdentityAccess, requireFabricDataRead };
