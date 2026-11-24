// Fabric Data configuration (config.fabricData): off by default, strict switch, required variables and guards when on, and the
// reader lists. Placeholder values only (reserved .invalid hosts, made-up GUIDs).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, ConfigError } = require("../src/config");
const { entraEnv } = require("./helpers");

const A = "00000000-0000-4000-8000-0000000fa001", B = "00000000-0000-4000-8000-0000000fa002", C = "00000000-0000-4000-8000-0000000fa003";
const on = (overrides = {}) => entraEnv({ JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb+srv://reader:pw@fabric-cluster.example.invalid/?retryWrites=false", FABRIC_MONGODB_DB_NAME: "FabricTestDb", ...overrides });
const fabric = (env) => loadConfig(env).fabricData;
const refuses = (env, pattern) => assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError && pattern.test(e.message) && !e.message.includes("pw@") && !e.message.includes("example.invalid"));

describe("Fabric Data configuration", () => {
  test("off by default in every environment, and FABRIC_* variables aren't looked at while off", () => {
    assert.equal(fabric({}).enabled, false);
    assert.equal(fabric(entraEnv({ NODE_ENV: "production" })).enabled, false);
    assert.equal(fabric(entraEnv({ JARC_FEATURE_FABRIC_DATA: "" })).enabled, false);
    // Production holds the URI and name with the switch false: nothing about them is validated.
    const off = fabric(entraEnv({ JARC_FEATURE_FABRIC_DATA: "false", FABRIC_MONGODB_URI: "not a uri", FABRIC_MONGODB_DB_NAME: "jarc_database", FABRIC_DATA_READER_OIDS: "nonsense", FABRIC_POOL_SIZE: "99" }));
    assert.equal(off.enabled, false);
    assert.equal(off.uri, null);
    assert.deepEqual(off.readerObjectIds, []);
  });

  test("the switch is exactly true or false", () => {
    for (const value of ["TRUE", "1", "yes", "on", " true"]) refuses(entraEnv({ JARC_FEATURE_FABRIC_DATA: value }), /JARC_FEATURE_FABRIC_DATA must be true or false/);
  });

  test("on needs Microsoft Entra sign-in, the URI and the database name", () => {
    refuses({ JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb" }, /needs AUTH_MODE=entra/);
    refuses(on({ FABRIC_MONGODB_URI: "" }), /needs FABRIC_MONGODB_URI/);
    refuses(on({ FABRIC_MONGODB_DB_NAME: undefined }), /needs FABRIC_MONGODB_DB_NAME/);
  });

  test("URI guards: a MongoDB scheme, a different cluster from JARC's, no other database in its path; the URI is never enumerable", () => {
    refuses(on({ FABRIC_MONGODB_URI: "https://fabric.invalid" }), /mongodb:\/\/ or mongodb\+srv:\/\//);
    refuses(on({ FABRIC_MONGODB_URI: "mongodb://db.invalid" }), /must not be JARC's MONGODB_URI/);
    refuses(on({ MONGODB_URI: "mongodb://user:pw@shared.example.invalid:27017", FABRIC_MONGODB_URI: "mongodb://other:pw@SHARED.example.invalid:27018/" }), /different cluster/);
    refuses(on({ MONGODB_URI: "mongodb://a.invalid,b.invalid", FABRIC_MONGODB_URI: "mongodb://c.invalid,b.invalid" }), /different cluster/);
    refuses(on({ FABRIC_MONGODB_URI: "mongodb://fabric.invalid/jarc_database" }), /different database in its path/);
    assert.equal(fabric(on({ FABRIC_MONGODB_URI: "mongodb://fabric.invalid/FabricTestDb?authSource=admin" })).enabled, true);
    const cfg = fabric(on());
    assert.equal(cfg.uri.startsWith("mongodb+srv://"), true);
    assert.equal(Object.keys(cfg).includes("uri"), false);
    assert.equal(JSON.stringify(cfg).includes("example.invalid"), false);
    assert.equal(require("util").inspect(cfg).includes("example.invalid"), false);
  });

  test("database name guards", () => {
    for (const name of ["jarc_database", "JARC_DATABASE", "bad name", "a.b", "x".repeat(65), "$db"]) refuses(on({ FABRIC_MONGODB_DB_NAME: name }), /FABRIC_MONGODB_DB_NAME/);
    assert.equal(fabric(on({ FABRIC_MONGODB_DB_NAME: "Fabric-Db_2" })).dbName, "Fabric-Db_2");
  });

  test("reader lists: GUIDs, any separator, lowercased, de-duplicated, bounded; cost readers and API admins must be readers", () => {
    const cfg = fabric(on({ FABRIC_DATA_READER_OIDS: `${A.toUpperCase()}; ${B}\n${C},${A}`, FABRIC_DATA_COST_READER_OIDS: B, FABRIC_API_ADMIN_OIDS: C }));
    assert.deepEqual(cfg.readerObjectIds, [A, B, C]);
    assert.deepEqual(cfg.costReaderObjectIds, [B]);
    assert.deepEqual(cfg.apiAdminObjectIds, [C]);
    assert.deepEqual(fabric(on()).readerObjectIds, [], "empty means nobody");
    refuses(on({ FABRIC_DATA_READER_OIDS: "not-a-guid" }), /FABRIC_DATA_READER_OIDS must list/);
    refuses(on({ FABRIC_DATA_READER_OIDS: A, FABRIC_DATA_COST_READER_OIDS: B }), /COST_READER_OIDS must also be in FABRIC_DATA_READER_OIDS/);
    refuses(on({ FABRIC_DATA_READER_OIDS: A, FABRIC_API_ADMIN_OIDS: B }), /FABRIC_API_ADMIN_OIDS must also be in FABRIC_DATA_READER_OIDS/);
    const many = (n) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",");
    assert.equal(fabric(on({ FABRIC_DATA_READER_OIDS: many(50) })).readerObjectIds.length, 50);
    refuses(on({ FABRIC_DATA_READER_OIDS: many(51) }), /at most 50/);
    refuses(on({ FABRIC_DATA_READER_OIDS: many(21), FABRIC_API_ADMIN_OIDS: many(21) }), /at most 20/);
  });

  test("numeric settings: defaults and bounds", () => {
    const cfg = fabric(on());
    assert.deepEqual([cfg.apiRatePerMinute, cfg.queryTimeMs, cfg.poolSize, cfg.maxWindowRows, cfg.unindexedScanMax], [60, 8000, 5, 50000, 20000]);
    const bounds = { FABRIC_API_RATE_PER_MINUTE: [1, 600], FABRIC_QUERY_TIME_MS: [1000, 30000], FABRIC_POOL_SIZE: [1, 10], FABRIC_MAX_WINDOW_ROWS: [1000, 200000], FABRIC_UNINDEXED_SCAN_MAX: [0, 50000] };
    for (const [name, [min, max]] of Object.entries(bounds)) {
      assert.doesNotThrow(() => loadConfig(on({ [name]: String(min) })));
      assert.doesNotThrow(() => loadConfig(on({ [name]: String(max) })));
      refuses(on({ [name]: String(min - 1) }), new RegExp(name));
      refuses(on({ [name]: String(max + 1) }), new RegExp(name));
      refuses(on({ [name]: "1.5" }), new RegExp(name));
    }
    assert.equal(fabric(on({ FABRIC_UNINDEXED_SCAN_MAX: "0" })).unindexedScanMax, 0);
  });

  test("FABRIC_INVOICE_VIEWS: strictly true or false, default false; not looked at while Fabric Data is off", () => {
    assert.equal(fabric(on()).invoiceViews, false);
    assert.equal(fabric(on({ FABRIC_INVOICE_VIEWS: "" })).invoiceViews, false);
    assert.equal(fabric(on({ FABRIC_INVOICE_VIEWS: "false" })).invoiceViews, false);
    assert.equal(fabric(on({ FABRIC_INVOICE_VIEWS: "true" })).invoiceViews, true);
    for (const value of ["TRUE", "1", "yes", "on", " true"]) refuses(on({ FABRIC_INVOICE_VIEWS: value }), /FABRIC_INVOICE_VIEWS must be true or false/);
    const off = fabric(entraEnv({ JARC_FEATURE_FABRIC_DATA: "false", FABRIC_INVOICE_VIEWS: "maybe", FABRIC_UNINDEXED_SCAN_MAX: "999999" }));
    assert.deepEqual([off.enabled, off.invoiceViews, off.unindexedScanMax], [false, false, 20000]);
  });
});
