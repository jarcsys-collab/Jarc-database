// Employee Management (JARC administration): a read-only people directory over an in-memory snapshot of the directory source.
// Required only by app.js / server.js, never by src/domain/* or src/workers/* (worker threads stay light). Not part of Command
// Center search: nothing here feeds recordSearch or the search service.
//
//   const employees = createEmployees({ config: config.employees, logger });   // nothing connects until the first request
//   app: api.use("/admin/employees", identify, employeeRoutes({ employees, savedFilterRepo: dataLayer.repos.employeeSavedFilters }));
//   /features: employees: employees.accessFor(req.actor)   → { view, admin, datasets, jarcAccess }
//   P2: app.js also builds new JarcAccessIndex({ repos: dataLayer.repos, access, tenantId, ... }) (jarc-access.js) and passes it
//   to employeeRoutes as jarcAccess. It reads JARC's own database only, lazily (nothing runs until an admin asks).
const { EmployeeSourceConnection } = require("./connection");
const { JarcAccessIndex } = require("./jarc-access");
const { EmployeeSnapshot, directorySource } = require("./snapshot");
const { EmployeeService } = require("./service");
const { employeeRoutes } = require("./router");
const { employeeAccessFor } = require("./access");
const { profileId } = require("./ids");
const { DATASETS, DATASET_NAMES } = require("./fields");

// config: config.employees with the switch on ({ enabled, collection, dbName, tenantId, viewerObjectIds, adminObjectIds } and the
// non-enumerable uri and idKey). createClient (tests: a fake MongoClient factory), source (tests: { probe, loadAll } instead of a
// connection), idKey (overrides config.idKey), now: () => Date | ms.
function createEmployees({ config, logger = console, createClient, source, idKey, now } = {}) {
  if (!config?.enabled) throw new Error("createEmployees needs config.employees with the switch on.");
  const key = idKey || config.idKey;
  if (!Buffer.isBuffer(key)) throw new Error("createEmployees needs the profile ID key (the API-token key).");
  const nowMs = now ? () => { const v = now(); return v instanceof Date ? v.getTime() : v; } : Date.now;
  const connection = source ? null : new EmployeeSourceConnection({ uri: config.uri, dbName: config.dbName, collection: config.collection, poolSize: 2, queryTimeMs: config.queryTimeMs || 8000, logger, now: nowMs, ...(createClient ? { createClient } : {}) });
  const snapshot = new EmployeeSnapshot({ source: source || directorySource(connection, { queryTimeMs: config.queryTimeMs || 8000 }), idKey: key, now: nowMs, logger });
  const service = new EmployeeService({ snapshot, now: () => new Date(nowMs()) });
  const accessFor = (actor) => employeeAccessFor(actor, config);
  return { config, connection, snapshot, service, accessFor, access: { accessFor }, close: () => (connection ? connection.close() : Promise.resolve()) };
}

module.exports = { createEmployees, employeeRoutes, employeeAccessFor, profileId, DATASETS, DATASET_NAMES, JarcAccessIndex };
