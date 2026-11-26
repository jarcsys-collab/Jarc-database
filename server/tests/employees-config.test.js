// Employee Management configuration (config/index.js loadEmployeeConfig): off by default, strict when on. Synthetic values only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, ConfigError } = require("../src/config");
const { entraEnv } = require("./helpers");

const KEY = Buffer.alloc(32, 3).toString("base64");
const OID_A = "00000000-0000-4000-8000-0000000000a1", OID_B = "00000000-0000-4000-8000-0000000000b2";
const on = (extra = {}) => entraEnv({ JARC_FEATURE_EMPLOYEES: "true", EMPLOYEE_DIRECTORY_COLLECTION: "DirectorySnapshot", FABRIC_MONGODB_URI: "mongodb://directory.invalid", FABRIC_MONGODB_DB_NAME: "SyntheticDirectoryDb", JARC_API_TOKEN_KEY: KEY, ...extra });
const fails = (env, pattern) => assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError && pattern.test(e.message));

test("off by default and while off none of its variables are read", () => {
  const c = loadConfig(entraEnv({ EMPLOYEE_DIRECTORY_COLLECTION: "not valid!", EMPLOYEE_VIEWER_OIDS: "nope" }));
  assert.equal(c.employees.enabled, false);
  assert.deepEqual(c.employees.viewerObjectIds, []);
  assert.equal(loadConfig(entraEnv({ JARC_FEATURE_EMPLOYEES: "false" })).employees.enabled, false);
  fails(entraEnv({ JARC_FEATURE_EMPLOYEES: "yes" }), /JARC_FEATURE_EMPLOYEES must be true or false/);
});

test("on: the collection, the source connection and the ID key are required", () => {
  const c = loadConfig(on({ EMPLOYEE_VIEWER_OIDS: `${OID_A.toUpperCase()}, ${OID_A}`, EMPLOYEE_ADMIN_OIDS: OID_B }));
  assert.equal(c.employees.enabled, true);
  assert.equal(c.employees.collection, "DirectorySnapshot");
  assert.deepEqual(c.employees.viewerObjectIds, [OID_A]);
  assert.deepEqual(c.employees.adminObjectIds, [OID_B]);
  assert.equal(c.employees.tenantId, entraEnv().ENTRA_TENANT_ID.toLowerCase());
  assert.equal(c.employees.idKey.length, 32);
  // Secrets are kept out of inspection and JSON.
  assert.ok(!Object.keys(c.employees).includes("uri") && !Object.keys(c.employees).includes("idKey"));
  assert.ok(!JSON.stringify(c.employees).includes("directory.invalid"));
  for (const name of ["EMPLOYEE_DIRECTORY_COLLECTION", "FABRIC_MONGODB_URI", "FABRIC_MONGODB_DB_NAME", "JARC_API_TOKEN_KEY"]) fails(on({ [name]: "" }), new RegExp(`needs .*${name}`));
});

test("on: empty viewer and admin lists mean nobody (fail closed)", () => {
  const c = loadConfig(on());
  assert.deepEqual(c.employees.viewerObjectIds, []);
  assert.deepEqual(c.employees.adminObjectIds, []);
});

test("on: bad values stop startup", () => {
  fails(on({ AUTH_MODE: "dev", DATA_STORE: "memory" }), /needs AUTH_MODE=entra/);
  fails(on({ EMPLOYEE_DIRECTORY_COLLECTION: "bad name" }), /EMPLOYEE_DIRECTORY_COLLECTION must be/);
  fails(on({ EMPLOYEE_DIRECTORY_COLLECTION: "x".repeat(65) }), /EMPLOYEE_DIRECTORY_COLLECTION must be/);
  fails(on({ EMPLOYEE_DIRECTORY_COLLECTION: "system.users" }), /EMPLOYEE_DIRECTORY_COLLECTION must be/);
  fails(on({ EMPLOYEE_DIRECTORY_COLLECTION: "FactSales" }), /must not be a Fabric Data collection/);
  fails(on({ EMPLOYEE_DIRECTORY_COLLECTION: "factinventory" }), /must not be a Fabric Data collection/);
  fails(on({ EMPLOYEE_VIEWER_OIDS: "not-a-guid" }), /EMPLOYEE_VIEWER_OIDS must list/);
  fails(on({ EMPLOYEE_ADMIN_OIDS: "not-a-guid" }), /EMPLOYEE_ADMIN_OIDS must list/);
  fails(on({ JARC_API_TOKEN_KEY: Buffer.alloc(8).toString("base64") }), /JARC_API_TOKEN_KEY must be 32/);
  fails(on({ FABRIC_MONGODB_URI: "http://x" }), /FABRIC_MONGODB_URI must be a mongodb/);
  fails(on({ FABRIC_MONGODB_URI: "mongodb://db.invalid" }), /must not be JARC's MONGODB_URI/);
  fails(on({ FABRIC_MONGODB_DB_NAME: "jarc_database" }), /must not be JARC's own database/);
});

test("the employee lists are their own: other features' lists are never read into them", () => {
  const c = loadConfig(on({ JARC_FEATURE_FABRIC_DATA: "true", FABRIC_DATA_READER_OIDS: OID_A, JARC_API_ADMIN_OIDS: OID_A }));
  assert.deepEqual(c.employees.viewerObjectIds, []);
  assert.deepEqual(c.employees.adminObjectIds, []);
});

test("P3: JARC_FEATURE_EMPLOYEE_ACCESS_ADMIN is on only for exactly \"true\", only with the directory on; anything else stops startup", () => {
  assert.equal(loadConfig(on()).employees.accessAdmin, false, "default off");
  assert.equal(loadConfig(on({ JARC_FEATURE_EMPLOYEE_ACCESS_ADMIN: "" })).employees.accessAdmin, false);
  assert.equal(loadConfig(on({ JARC_FEATURE_EMPLOYEE_ACCESS_ADMIN: "false" })).employees.accessAdmin, false);
  assert.equal(loadConfig(on({ JARC_FEATURE_EMPLOYEE_ACCESS_ADMIN: "true" })).employees.accessAdmin, true);
  assert.equal(loadConfig(entraEnv({ JARC_FEATURE_EMPLOYEE_ACCESS_ADMIN: "true" })).employees.accessAdmin, false, "meaningless while the directory is off");
  for (const v of ["TRUE", "1", "yes", "true "]) fails(on({ JARC_FEATURE_EMPLOYEE_ACCESS_ADMIN: v }), /JARC_FEATURE_EMPLOYEE_ACCESS_ADMIN must be true or false/);
});
