// Who may use Employee Management (a JARC administration feature). Only the Microsoft Entra object IDs in EMPLOYEE_VIEWER_OIDS
// (the `active` dataset: the directory and its profiles) and EMPLOYEE_ADMIN_OIDS (also the admin datasets all / disabled /
// guests; admin implies viewer), only within JARC's own tenant (ENTRA_TENANT_ID), and only with a JARC session.
// Nothing else grants it: not JARC.Admin, system or super administrators, workspace roles, ACCESS_POLICY=development_shared,
// JARC_BETA_OPEN_EDITING, account roles, or any other feature's lists. Empty lists mean nobody (fails closed).
const { ADMIN_DATASETS, VIEWER_DATASETS } = require("./fields");

const lower = (v) => (typeof v === "string" ? v.toLowerCase() : null);
const listed = (identity, list, tenantId) => {
  const tid = lower(identity?.tenantId), oid = lower(identity?.objectId);
  return Boolean(tenantId && tid && oid && tid === String(tenantId).toLowerCase() && Array.isArray(list) && list.includes(oid));
};
const identityOf = (actor) => (actor?.kind === "entra" ? { tenantId: actor.tenantId, objectId: actor.entraObjectId } : null);

// → { view, admin, datasets, jarcAccess } for a signed-in actor. config: config.employees ({ enabled, tenantId, viewerObjectIds,
// adminObjectIds }). Switched off → nothing. jarcAccess (P2, Employee Access Visibility: what each account can do in JARC) is
// exactly admin: EMPLOYEE_ADMIN_OIDS only, never a viewer. The key is present only when true, so viewers' and outsiders'
// answers (and /features) don't reveal that P2 exists.
function employeeAccessFor(actor, config) {
  if (!config?.enabled) return { view: false, admin: false, datasets: [] };
  const identity = identityOf(actor);
  const admin = listed(identity, config.adminObjectIds, config.tenantId);
  const view = admin || listed(identity, config.viewerObjectIds, config.tenantId);
  return { view, admin, datasets: admin ? [...VIEWER_DATASETS, ...ADMIN_DATASETS] : view ? [...VIEWER_DATASETS] : [], ...(admin ? { jarcAccess: true } : {}) };
}

module.exports = { employeeAccessFor };
