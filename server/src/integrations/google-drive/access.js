// Who may manage the company Google Drive connection (connect, reconnect, test, disconnect): only the Microsoft Entra
// object IDs in GOOGLE_DRIVE_ADMIN_OIDS, and only within JARC's own tenant. Nothing else grants it: not the JARC.Admin app
// role, not workspace roles, not open-access settings. An empty or unset list means nobody (fails closed).
//
// identity: { tenantId, objectId } as verified at Microsoft sign-in and stored on the session, never from the browser.
function canManageDrive(identity, { adminObjectIds = [] } = {}, tenantId) {
  const tid = typeof identity?.tenantId === "string" ? identity.tenantId.toLowerCase() : null;
  const oid = typeof identity?.objectId === "string" ? identity.objectId.toLowerCase() : null;
  return Boolean(tenantId && tid && oid && tid === String(tenantId).toLowerCase() && adminObjectIds.includes(oid));
}
// The same rule for a request's actor (auth/session.js puts the verified tenant and object ID on it).
const actorCanManageDrive = (actor, config, tenantId) => actor?.kind === "entra" && canManageDrive({ tenantId: actor.tenantId, objectId: actor.entraObjectId }, config, tenantId);

module.exports = { canManageDrive, actorCanManageDrive };
