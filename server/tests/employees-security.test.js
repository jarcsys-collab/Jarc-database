// Employee Management (People directory) security verification through the REAL app: createApp({ employees, fabricData,
// apiTokens, accounts }) with production-like settings (open access + beta open editing, JARC.Admin and a configured Super
// Admin), configuration loaded by loadConfig, Entra sign-in from the offline test issuer, JARC on its fake MongoDB and the
// read-only fake directory source. Synthetic data only; nothing leaves 127.0.0.1.
//
// Roles: owner (EMPLOYEE_ADMIN_OIDS), viewer (EMPLOYEE_VIEWER_OIDS), guestViewer (listed as a viewer, but their OWN directory
// account is a Guest: listed OIDs grant access whatever the directory says about the caller; the snapshot is never consulted
// for authorisation), fabricOnly (a Fabric Data reader, not listed here), outsider (signed in, JARC.Admin app role AND the
// configured Super Admin, not listed), signed-out, bearer token callers.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createApp } = require("../src/app");
const { loadConfig } = require("../src/config");
const { MemoryStateRepository } = require("../src/repositories/memory-state-repository");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { createEntraVerifier } = require("../src/auth/entra-token");
const { createEmployees, profileId } = require("../src/employees");
const { SOURCE_FIELDS } = require("../src/employees/fields");
const { CHECK_MS } = require("../src/employees/snapshot");
const { createFabricData } = require("../src/fabric");
const fm = require("../src/fabric/filter-model");
const { SessionClient, entraEnv } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FakeMongoClient } = require("./support/fake-mongo");
const { FabricFakeClient } = require("./support/fabric-fake");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME } = require("./support/employee-fake");

const BASE = "/api/v1/admin/employees";
const DATASETS = ["active", "all", "disabled", "guests"];
const ADMIN_DATASETS = ["all", "disabled", "guests"];
const code = (res) => res.body?.error?.code;
const and = (...items) => ({ v: 1, op: "and", items });
const enc = (model) => fm.encodeFilterParam(model);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Everything an API response must never contain (checked over every response body this file receives).
const people = syntheticPeople(30);
const SOURCE_NAMES = SOURCE_FIELDS.filter((f) => f !== "mail" && f !== "department").concat(["mobile_phone", "business_phones", "company_name"]);
const ALWAYS_FORBIDDEN = ["+00 0000", "+00 1111", "company_name", "Synthetic Company", "ingest-", COLLECTION, DB_NAME, ...SOURCE_NAMES];

function makeLogger() {
  const lines = [];
  const push = (level) => (...args) => lines.push(`${level} ${args.map((a) => (a instanceof Error ? `${a.name}: ${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`);
  return { lines, error: push("error"), warn: push("warn"), info: push("info"), log: push("log"), debug: push("debug") };
}

// One JARC app. employees: (config) → createEmployees result, or null (feature off).
async function boot({ issuer, env, employeesFor = null, accounts = null }) {
  const config = loadConfig(env);
  const fake = new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const logger = makeLogger();
  const dataLayer = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), environment: "test" });
  const fabricData = config.fabricData.enabled ? createFabricData({ config: config.fabricData, logger, createClient: () => new FabricFakeClient({ docs: [] }) }) : null;
  const employees = employeesFor ? employeesFor(config, logger) : null;
  const app = createApp({
    repository: new MemoryStateRepository(), environment: "test", logger, dataLayer, slowRequestMs: 1,
    auth: { mode: "entra", entra: issuer.config, verify: createEntraVerifier({ ...issuer.config, keySet: issuer.keySet }) },
    accessPolicy: "development_shared", betaOpenEditing: true,
    apiTokens: { key: config.apiTokens.key || crypto.randomBytes(32), adminObjectIds: [], issuePerHour: 1000, maxActive: 1000 },
    fabricData, ...(employees ? { employees } : {}), ...(accounts ? { accounts } : {})
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  server.keepAliveTimeout = 30000; server.headersTimeout = 31000;
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, app, config, logger, connection, employees, close: async () => { app.locals.realtime?.closeAll(); await new Promise((r) => server.close(r)); await employees?.close(); await fabricData?.close(); } };
}

describe("Employee Management security (real app)", () => {
  let issuer, P, env, main, offApp, fake, clockOffset = 0;
  const seen = []; // { who, method, path, status, text }
  const clients = new Map();

  // A signed-in browser per person (per app). Retries a RATE_LIMITED answer (never an expected status here) after its Retry-After.
  const clientOf = async (target, person) => {
    const key = `${target.url}|${person.oid}`;
    if (!clients.has(key)) { const c = new SessionClient(target.url, issuer.config.appOrigin); assert.equal((await c.signIn(person)).status, 201, `sign-in ${person.name}`); clients.set(key, c); }
    return clients.get(key);
  };
  const record = (who, method, path, res) => { seen.push({ who, method, path, status: res.status, text: res.text || "" }); return res; };
  const as = async (who, method, path, body, options, target = main) => {
    const client = who === "signedOut" ? new SessionClient(target.url, issuer.config.appOrigin) : await clientOf(target, P[who]);
    for (let attempt = 0; ; attempt += 1) {
      const res = await client.request(method, path, body, options);
      if (res.status === 429 && attempt < 3) { await delay(Math.min(11, Number(res.headers.get("retry-after") || 2)) * 1000 + 200); continue; }
      return record(who, method, path, res);
    }
  };
  // A caller with an API token: a bearer header, with and without a session cookie.
  const bearer = async (method, path, { withSession = false } = {}) => {
    const client = withSession ? await clientOf(main, P.viewer) : new SessionClient(main.url, issuer.config.appOrigin);
    const res = await client.request(method, path, method === "GET" ? undefined : { name: "x", state: {} }, { headers: { Authorization: `Bearer jarc_${"A".repeat(40)}` } });
    return record(withSession ? "bearer+session" : "bearer", method, path, res);
  };

  before(async () => {
    issuer = await createTokenIssuer();
    P = {
      owner: issuer.person("Synthetic Owner"), viewer: issuer.person("Synthetic Viewer"), guestViewer: issuer.person("Synthetic Guest Viewer"),
      fabricOnly: issuer.person("Synthetic Fabric Reader"), outsider: issuer.person("Synthetic Outsider", { admin: true }),
      // Extra listed people for the high-volume field probes (the per-person rate limits stay in force).
      ownerB: issuer.person("Synthetic Owner B"), ownerC: issuer.person("Synthetic Owner C"), viewerB: issuer.person("Synthetic Viewer B"), viewerC: issuer.person("Synthetic Viewer C")
    };
    // The guest viewer's own directory account: a Guest (enabled). It is in the snapshot, but not in the active dataset.
    people.push({ ...syntheticPeople(1, { seed: "gv" })[0], _id: "ingest-gv-own", user_id: P.guestViewer.oid, display_name: "Synthetic Person 99", user_type: "Guest", account_enabled: true, user_principal_name: "synthetic.person99_example.com#EXT#@tenant.example.com" });
    ALWAYS_FORBIDDEN.push(...people.map((d) => d.user_id.toLowerCase()));
    env = entraEnv({
      JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: DB_NAME,
      // Fabric readers: owner, viewer and fabricOnly (a separate list; the guest viewer is NOT a Fabric reader).
      FABRIC_DATA_READER_OIDS: [P.owner, P.viewer, P.fabricOnly].map((p) => p.oid).join(","), FABRIC_DATA_COST_READER_OIDS: P.owner.oid, FABRIC_API_ADMIN_OIDS: P.owner.oid,
      JARC_API_TOKEN_KEY: crypto.randomBytes(32).toString("base64"),
      JARC_FEATURE_EMPLOYEES: "true", EMPLOYEE_DIRECTORY_COLLECTION: COLLECTION,
      EMPLOYEE_VIEWER_OIDS: [P.viewer, P.guestViewer, P.viewerB, P.viewerC].map((p) => p.oid).join(","), EMPLOYEE_ADMIN_OIDS: [P.owner, P.ownerB, P.ownerC].map((p) => p.oid).join(",")
    });
    const accounts = { mode: "staged", superAdmin: { tenantId: issuer.config.tenantId, objectId: P.outsider.oid } };
    fake = new EmployeeFakeClient({ docs: people });
    main = await boot({ issuer, env, accounts, employeesFor: (config, logger) => createEmployees({ config: config.employees, createClient: () => fake, logger, now: () => Date.now() + clockOffset }) });
    // The same Fabric configuration with Employee Management off: Fabric flags must be identical.
    offApp = await boot({ issuer, env: { ...env, JARC_FEATURE_EMPLOYEES: "false" }, accounts });
  });
  after(async () => { await main?.close(); await offApp?.close(); });

  // Profile IDs (obtained as the owner) for one account of each kind.
  let ids;
  const idOfUser = (userId) => profileId(main.config.employees.idKey, userId);
  test("config: the employee lists are separate from Fabric's; profile IDs are keyed by the API-token key", () => {
    const e = main.config.employees;
    assert.equal(e.enabled, true);
    assert.deepEqual([...e.viewerObjectIds].sort(), [P.viewer, P.guestViewer, P.viewerB, P.viewerC].map((x) => x.oid.toLowerCase()).sort());
    assert.deepEqual([...e.adminObjectIds].sort(), [P.owner, P.ownerB, P.ownerC].map((x) => x.oid.toLowerCase()).sort());
    assert.ok(!e.viewerObjectIds.includes(P.fabricOnly.oid.toLowerCase()), "a Fabric reader isn't an employee viewer");
    assert.ok(Buffer.isBuffer(e.idKey) && e.idKey.equals(Buffer.from(env.JARC_API_TOKEN_KEY, "base64")));
    assert.ok(!Object.keys(e).includes("uri") && !Object.keys(e).includes("idKey"), "secrets not enumerable");
  });

  test("owner: every dataset; opaque IDs are 22 characters, never the object ID, and match the documented derivation", async () => {
    const all = await as("owner", "GET", `${BASE}/all/records?limit=200&fields=displayName,accountEnabled,accountType`);
    assert.equal(all.status, 200);
    assert.equal(all.body.items.length, people.length);
    for (const item of all.body.items) {
      assert.match(item.id, /^[A-Za-z0-9_-]{22}$/);
      assert.ok(!people.some((d) => d.user_id.toLowerCase().includes(item.id.toLowerCase()) || item.id.toLowerCase().includes(d.user_id.slice(0, 8))), "not derived visibly from the object ID");
    }
    const byName = new Map(all.body.items.map((i) => [i.values.displayName, i]));
    const disabled = people.find((d) => !d.account_enabled && d.user_type === "Member"), guest = people.find((d) => d.user_type === "Guest" && d.account_enabled && d.user_id !== P.guestViewer.oid);
    const active = people.find((d) => d.account_enabled && d.user_type === "Member");
    ids = { active: byName.get(active.display_name).id, disabled: byName.get(disabled.display_name).id, guest: byName.get(guest.display_name).id, guestViewerOwn: byName.get("Synthetic Person 99").id };
    for (const [k, d] of [["active", active], ["disabled", disabled], ["guest", guest]]) assert.equal(ids[k], idOfUser(d.user_id), `${k}: documented derivation`);
    assert.equal(new Set(all.body.items.map((i) => i.id)).size, people.length, "unique");
    for (const ds of DATASETS) assert.equal((await as("owner", "GET", `${BASE}/${ds}/records`)).status, 200, ds);
  });

  // ---- The endpoint × role matrix ----
  const endpoints = (ds, recordId, filterId) => [
    ["GET", `${BASE}/status`], ["GET", `${BASE}/${ds}/schema`], ["GET", `${BASE}/${ds}/records`], ["GET", `${BASE}/${ds}/records/${recordId}`],
    ["GET", `${BASE}/${ds}/values?field=department`], ["GET", `${BASE}/saved-filters/${ds}`], ["POST", `${BASE}/saved-filters/${ds}`, { name: `M ${crypto.randomBytes(3).toString("hex")}`, state: {} }],
    ["PUT", `${BASE}/saved-filters/${ds}/${filterId}`, { name: "Renamed" }], ["DELETE", `${BASE}/saved-filters/${ds}/${filterId}`]
  ];
  let viewerFilterId;

  test("signed out: 401 on every endpoint and dataset", async () => {
    for (const ds of DATASETS) for (const [m, p, b] of endpoints(ds, ids.active, "0123456789abcdef")) {
      const res = await as("signedOut", m, p, b);
      assert.equal(res.status, 401, `${m} ${p}`);
      assert.equal(code(res), "UNAUTHENTICATED");
    }
  });

  test("a viewer's saved filter exists (for the cross-user checks)", async () => {
    const res = await as("viewer", "POST", `${BASE}/saved-filters/active`, { name: "Viewer own", state: { filter: and({ field: "department", op: "eq", value: "Dept A" }), orderBy: [["displayName", "asc"]], columns: ["displayName", "department"], q: "", searchField: null } });
    assert.equal(res.status, 201);
    viewerFilterId = res.body.id;
    assert.match(viewerFilterId, /^[0-9a-f]{16}$/);
  });

  for (const who of ["outsider", "fabricOnly"]) {
    test(`${who} (signed in, not listed${who === "outsider" ? "; JARC.Admin + Super Admin + open access" : "; a Fabric Data reader"}): 403 EMPLOYEES_FORBIDDEN everywhere, incl. direct IDs and saved filters`, async () => {
      for (const ds of [...DATASETS, "nosuchds"]) for (const recordId of [ids.active, ids.disabled, ids.guest]) for (const [m, p, b] of endpoints(ds, recordId, viewerFilterId)) {
        const res = await as(who, m, p, b);
        assert.equal(res.status, 403, `${who} ${m} ${p}`);
        assert.equal(code(res), "EMPLOYEES_FORBIDDEN", `${who} ${m} ${p}`);
      }
      const unknown = await as(who, "GET", `${BASE}/whatever/else/here`);
      assert.equal(unknown.status, 403);
    });
  }

  test("bearer tokens are refused (401), with or without a session; no external employee paths", async () => {
    for (const ds of DATASETS) for (const [m, p] of endpoints(ds, ids.active, viewerFilterId)) {
      for (const withSession of [false, true]) {
        const res = await bearer(m, p, { withSession });
        assert.equal(res.status, 401, `${withSession ? "bearer+session" : "bearer"} ${m} ${p}`);
      }
    }
    for (const p of ["/api/v1/external/admin/employees/status", "/api/v1/external/employees/active/records", "/api/v1/external/admin/employees/active/records"]) {
      const res = await bearer("GET", p);
      assert.ok([401, 403, 404].includes(res.status), `${p}: ${res.status}`);
      assert.doesNotMatch(res.text, /Synthetic Person/);
    }
  });

  for (const who of ["viewer", "guestViewer"]) {
    test(`${who}: active dataset 200; admin datasets 403; disabled/guest IDs (from the owner) 404 like unknown IDs`, async () => {
      const ok = await as(who, "GET", `${BASE}/active/records?limit=200`);
      assert.equal(ok.status, 200);
      const shownIds = ok.body.items.map((i) => i.id);
      assert.ok(shownIds.includes(ids.active));
      for (const hidden of [ids.disabled, ids.guest, ids.guestViewerOwn]) assert.ok(!shownIds.includes(hidden), "not in the active list");
      assert.equal((await as(who, "GET", `${BASE}/active/records/${ids.active}`)).status, 200);
      for (const hidden of [ids.disabled, ids.guest, ids.guestViewerOwn, "AAAAAAAAAAAAAAAAAAAAAA"]) {
        const res = await as(who, "GET", `${BASE}/active/records/${hidden}`);
        assert.equal(res.status, 404, `hidden ${hidden}`);
        assert.equal(code(res), "NOT_FOUND");
        assert.deepEqual(res.body, (await as(who, "GET", `${BASE}/active/records/AAAAAAAAAAAAAAAAAAAAAB`)).body, "the same answer as an unknown ID");
      }
      for (const ds of ADMIN_DATASETS) for (const [m, p, b] of endpoints(ds, ids.disabled, viewerFilterId)) {
        if (p.endsWith("/status")) continue;
        const res = await as(who, m, p, b);
        assert.equal(res.status, 403, `${who} ${m} ${p}`);
        assert.equal(code(res), "EMPLOYEES_FORBIDDEN");
      }
      const status = await as(who, "GET", `${BASE}/status`);
      assert.equal(status.status, 200);
      assert.deepEqual(status.body.access, { datasets: ["active"], admin: false });
      assert.deepEqual(Object.keys(status.body.counts), ["active"], "no admin-dataset counts for a viewer");
      const schema = await as(who, "GET", `${BASE}/active/schema`);
      assert.ok(!schema.body.fields.some((f) => f.name === "accountEnabled" || f.name === "accountType"), "admin-only fields not offered");
      assert.equal((await as(who, "GET", `${BASE}/active/values?field=department`)).status, 200);
      assert.equal((await as(who, "GET", `${BASE}/saved-filters/active`)).status, 200);
    });
  }

  test("guest viewer: documented decision: the listed OID grants access even though their own directory account is a Guest", async () => {
    const f = (await as("guestViewer", "GET", "/api/v1/features")).body.features.employees;
    assert.deepEqual(f, { view: true, admin: false, datasets: ["active"] });
  });

  test("owner: the full matrix succeeds", async () => {
    for (const ds of DATASETS) {
      const created = await as("owner", "POST", `${BASE}/saved-filters/${ds}`, { name: `Owner ${ds}`, state: {} });
      assert.equal(created.status, 201, ds);
      const recordId = ds === "active" ? ids.active : ds === "disabled" ? ids.disabled : ids.guest;
      const expected = [200, 200, 200, 200, 200, 200, 201, 200, 200];
      const list = endpoints(ds, recordId, created.body.id);
      for (let i = 0; i < list.length; i += 1) {
        const [m, p, b] = list[i];
        const res = await as("owner", m, p, b);
        assert.equal(res.status, expected[i], `owner ${m} ${p}: ${res.text.slice(0, 120)}`);
      }
    }
    const status = (await as("owner", "GET", `${BASE}/status`)).body;
    // P2: the admin (only) gets jarcAccess; viewers' access objects are unchanged (line 230).
    assert.deepEqual(status.access, { datasets: DATASETS, admin: true, jarcAccess: true });
  });

  // ---- Saved filters ----
  test("saved filters: another person's ID is 404 (owner and guest viewer); the owner can't see it in their list", async () => {
    for (const who of ["owner", "guestViewer"]) {
      for (const [m, b] of [["PUT", { name: "Hijack" }], ["DELETE", undefined]]) {
        const res = await as(who, m, `${BASE}/saved-filters/active/${viewerFilterId}`, b);
        assert.equal(res.status, 404, `${who} ${m}`);
        assert.equal(code(res), "NOT_FOUND");
      }
      const list = await as(who, "GET", `${BASE}/saved-filters/active`);
      assert.ok(!list.body.items.some((i) => i.id === viewerFilterId));
    }
    const mine = await as("viewer", "GET", `${BASE}/saved-filters/active`);
    assert.ok(mine.body.items.some((i) => i.id === viewerFilterId && i.name === "Viewer own"), "untouched");
  });

  test("saved filters: the stored document holds only the allowed state (JARC's fake database)", async () => {
    const docs = await main.connection.db.collection("employeeSavedFilters").find({}).toArray();
    assert.ok(docs.length >= 2);
    for (const doc of docs) {
      assert.deepEqual(Object.keys(doc).sort(), ["_id", "dataset", "filters", "rev", "updatedAt", "userId"]);
      assert.equal(doc._id, `${doc.userId}:${doc.dataset}`);
      assert.ok(DATASETS.includes(doc.dataset));
      for (const f of doc.filters) {
        for (const k of Object.keys(f)) assert.ok(["id", "name", "nameKey", "version", "state", "createdAt", "updatedAt"].includes(k), `filter key ${k}`);
        assert.deepEqual(Object.keys(f.state).sort(), ["columns", "filter", "orderBy", "q", "searchField"]);
      }
      const text = JSON.stringify(doc);
      for (const t of [...ALWAYS_FORBIDDEN, "Synthetic Person", "synthetic.person", "accountCreated\":\"20"]) assert.ok(!text.includes(t), `stored doc contains ${t}`);
    }
  });

  test("CSRF: saved filter writes without the token (or from another origin) are refused and change nothing", async () => {
    const before = (await as("viewer", "GET", `${BASE}/saved-filters/active`)).body.items.length;
    for (const [m, p, b] of [["POST", `${BASE}/saved-filters/active`, { name: "No csrf", state: {} }], ["PUT", `${BASE}/saved-filters/active/${viewerFilterId}`, { name: "No csrf" }], ["DELETE", `${BASE}/saved-filters/active/${viewerFilterId}`]]) {
      const noToken = await as("viewer", m, p, b, { csrf: null });
      assert.equal(noToken.status, 403, `${m} without token`);
      assert.equal(code(noToken), "CSRF_INVALID");
      const wrongToken = await as("viewer", m, p, b, { csrf: "x".repeat(43) });
      assert.equal(wrongToken.status, 403, `${m} wrong token`);
      const otherOrigin = await as("viewer", m, p, b, { origin: "https://evil.example" });
      assert.equal(otherOrigin.status, 403, `${m} other origin`);
    }
    const after = (await as("viewer", "GET", `${BASE}/saved-filters/active`)).body;
    assert.equal(after.items.length, before);
    assert.equal(after.items.find((i) => i.id === viewerFilterId).name, "Viewer own");
  });

  // ---- Fields that must never be usable ----
  test("filters, sorts, fields, values, search field and saved filters can't reference phones, company or user_id (refused without naming it)", async () => {
    const bad = ["mobile_phone", "business_phones", "company_name", "user_id", "_id", "mobilePhone", "businessPhones", "companyName", "userId", "id"];
    for (const who of ["ownerB", "viewerB"]) {
      const ds = who === "ownerB" ? "all" : "active";
      const reader = (i) => (i % 2 ? who.replace("B", "C") : who); // two people per role: under 60 reads / 10 s each
      for (const [fi, f] of bad.entries()) {
        for (const [pi, p] of [
          `${BASE}/${ds}/records?filter=${enc(and({ field: f, op: "blank" }))}`, `${BASE}/${ds}/records?filter=${enc(and({ field: f, op: "eq", value: "+00 0000 1001" }))}`,
          `${BASE}/${ds}/records?orderBy=${f}:asc`, `${BASE}/${ds}/records?fields=displayName,${f}`, `${BASE}/${ds}/records?searchField=${f}&q=x`,
          `${BASE}/${ds}/values?field=${f}`, `${BASE}/${ds}/values?field=department&filter=${enc(and({ field: f, op: "blank" }))}`
        ].entries()) {
          const res = await as(reader(fi * 7 + pi), "GET", p);
          assert.equal(res.status, 400, `${who} ${p}`);
          assert.equal(code(res), "VALIDATION_ERROR");
          assert.ok(!res.text.includes(f === "id" ? "\"id\"" : f), `${who} ${p}: names ${f}: ${res.text}`);
          assert.ok(!res.text.includes("+00"), "no value echoed");
        }
        // Saved filter writes (30 a minute per person): the four restricted source fields only.
        if (fi < 4) for (const state of [{ filter: and({ field: f, op: "blank" }) }, { orderBy: [[f, "asc"]] }, { searchField: f }]) {
          const res = await as(who, "POST", `${BASE}/saved-filters/${ds}`, { name: `Bad ${f} ${Object.keys(state)[0]}`, state });
          assert.equal(res.status, 400, `${who} saved ${JSON.stringify(state)}`);
          assert.ok(!res.text.includes(f === "id" ? "\"id\"" : f), `saved filter error names ${f}`);
        }
      }
      // Restricted columns are dropped (never stored, never returned).
      const cols = await as(who, "POST", `${BASE}/saved-filters/${ds}`, { name: `Cols ${who}`, state: { columns: ["displayName", "mobile_phone", "company_name", "user_id"] } });
      assert.equal(cols.status, 201);
      assert.deepEqual(cols.body.state.columns, ["displayName"]);
    }
    // A viewer can't use the admin-only fields either (unnamed).
    for (const p of [`${BASE}/active/records?filter=${enc(and({ field: "accountEnabled", op: "isFalse" }))}`, `${BASE}/active/records?fields=accountType`, `${BASE}/active/values?field=accountType`, `${BASE}/active/records?orderBy=accountEnabled:asc`]) {
      const res = await as("viewerC", "GET", p);
      assert.equal(res.status, 400, p);
      assert.ok(!/accountEnabled|accountType/.test(res.text), `${p} names the field`);
    }
  });

  // ---- /features ----
  test("/features: employees flags only for the listed; Fabric flags identical with the feature off (separate lists)", async () => {
    const expect = { owner: { view: true, admin: true, datasets: DATASETS, jarcAccess: true }, viewer: { view: true, admin: false, datasets: ["active"] }, guestViewer: { view: true, admin: false, datasets: ["active"] }, fabricOnly: { view: false, admin: false, datasets: [] }, outsider: { view: false, admin: false, datasets: [] } };
    for (const [who, flags] of Object.entries(expect)) {
      const on = (await as(who, "GET", "/api/v1/features")).body.features;
      const off = (await as(who, "GET", "/api/v1/features", undefined, undefined, offApp)).body.features;
      assert.deepEqual(on.employees, flags, `${who} employees flags`);
      assert.ok(!Object.hasOwn(off, "employees"), "off: no flag");
      assert.deepEqual(on.fabricData, off.fabricData, `${who}: Fabric flags unchanged`);
      const { employees, ...restOn } = on;
      assert.deepEqual(restOn, off, `${who}: every other flag unchanged`);
    }
    const fab = async (who) => (await as(who, "GET", "/api/v1/features")).body.features.fabricData;
    assert.equal((await fab("fabricOnly")).read, true, "a Fabric reader keeps Fabric");
    assert.equal((await fab("guestViewer")).read, false, "an employee viewer gets no Fabric access");
    assert.equal((await fab("outsider")).read, false);
  });

  // ---- Command Center search ----
  test("Command Center search never returns directory accounts (they aren't indexed)", async () => {
    const ws = await as("owner", "POST", "/api/v1/workspaces", { name: "Directory Probe Workspace" });
    assert.equal(ws.status, 201, ws.text);
    const control = await as("owner", "GET", `/api/v1/search/global?q=${encodeURIComponent("Directory Probe")}`);
    assert.equal(control.status, 200);
    assert.match(control.text, /Directory Probe Workspace/, "positive control: search works");
    for (const who of ["owner", "viewer", "outsider"]) for (const q of ["Synthetic Person", "Synthetic Person 1", "synthetic.person1", "Dept A", "Engineer", "example.com"]) {
      for (const p of [`/api/v1/search/global?q=${encodeURIComponent(q)}`, `/api/v1/search?q=${encodeURIComponent(q)}`]) {
        const res = await as(who, "GET", p);
        assert.equal(res.status, 200, `${who} ${p}`);
        assert.doesNotMatch(res.text, /Synthetic Person|synthetic\.person|Dept A|Engineer|Analyst|Office 1/, `${who} ${p}`);
      }
    }
  });

  // ---- IDs stable across a snapshot reload ----
  test("profile IDs are stable across a snapshot reload", async () => {
    const before = (await as("owner", "GET", `${BASE}/all/records?limit=200&fields=displayName`)).body.items.map((i) => [i.values.displayName, i.id]).sort();
    const version = main.employees.snapshot.version, loadedAt = main.employees.snapshot.meta().loadedAt;
    for (const d of fake.docs) d.ingestion_datetime = "2026-11-25T01:18:00.000Z";
    clockOffset += CHECK_MS + 1000;
    await main.employees.snapshot.refresh();
    assert.equal(main.employees.snapshot.version, version + 1, "reloaded");
    const after = (await as("owner", "GET", `${BASE}/all/records?limit=200&fields=displayName`)).body;
    assert.notEqual(after.snapshot.loadedAt, loadedAt);
    assert.deepEqual(after.items.map((i) => [i.values.displayName, i.id]).sort(), before);
    assert.equal((await as("viewer", "GET", `${BASE}/active/records/${ids.active}`)).status, 200, "a profile link still works");
  });

  // ---- Headers ----
  test("P0 headers on the /admin/employees pages and on every API answer; pages carry no directory data", async () => {
    const pageHeaders = (h) => {
      assert.equal(h.get("x-content-type-options"), "nosniff");
      assert.equal(h.get("x-frame-options"), "DENY");
      assert.equal(h.get("referrer-policy"), "strict-origin-when-cross-origin");
      assert.match(h.get("permissions-policy") || "", /camera=\(\)/);
      assert.match(h.get("content-security-policy") || "", /frame-ancestors 'none'/);
      assert.match(h.get("content-security-policy") || "", /object-src 'none'/);
      assert.match(h.get("content-security-policy-report-only") || "", /default-src 'self'.*report-uri \/api\/v1\/csp-report/);
    };
    for (const p of ["/admin/employees", "/admin/employees/active", "/admin/employees/disabled", `/admin/employees/all/records/${ids.disabled}`, "/admin/employees/groups/department"]) {
      for (const who of ["signedOut", "outsider", "owner"]) {
        const client = who === "signedOut" ? new SessionClient(main.url, issuer.config.appOrigin) : await clientOf(main, P[who]);
        const raw = await fetch(main.url + p, { headers: client.cookies.size ? { Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {} });
        const res = { status: raw.status, headers: raw.headers, text: await raw.text() };
        assert.equal(res.status, 200, `${who} ${p}`);
        assert.match(res.headers.get("content-type"), /text\/html/);
        pageHeaders(res.headers);
        assert.doesNotMatch(res.text, /Synthetic Person|synthetic\.person|Dept A/, "the page itself holds no directory data");
      }
    }
    for (const [who, p] of [["owner", `${BASE}/status`], ["viewer", `${BASE}/all/records`], ["outsider", `${BASE}/active/records`], ["signedOut", `${BASE}/status`], ["owner", `${BASE}/active/records/AAAAAAAAAAAAAAAAAAAAAA`]]) {
      const res = await as(who, "GET", p);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${who} ${p}`);
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.equal(res.headers.get("content-security-policy"), "frame-ancestors 'none'");
      assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
      if (who !== "signedOut") assert.match(res.headers.get("cache-control") || "", /no-store/, `${who} ${p} no-store`);
    }
  });

  test("feature off: the API paths don't exist and /admin/employees links aren't served", async () => {
    const owner = await clientOf(offApp, P.owner);
    assert.equal((await owner.request("GET", `${BASE}/status`)).status, 404);
    assert.equal((await owner.request("GET", "/admin/employees/active")).status, 404);
  });

  test("CSP report endpoint: 204 for a report, 413 over 8 KB, 400 malformed, 405 other methods; logs directive + origin only", async () => {
    const post = (body, type = "application/csp-report") => fetch(`${main.url}/api/v1/csp-report`, { method: "POST", headers: { "Content-Type": type }, body });
    const report = JSON.stringify({ "csp-report": { "effective-directive": "script-src-elem", "blocked-uri": "https://cdn.example.net/x.js?who=Synthetic%20Person%201", "document-uri": `${main.url}/admin/employees/active/records/${ids.active}`, "script-sample": "Synthetic Person 1" } });
    assert.equal((await post(report)).status, 204);
    assert.equal((await post(JSON.stringify([{ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://img.example.net/a.png" } }]), "application/reports+json")).status, 204);
    const big = await post(JSON.stringify({ "csp-report": { "blocked-uri": "x".repeat(9000) } }));
    assert.equal(big.status, 413);
    assert.equal((await big.text()), "", "nothing echoed");
    const bad = await post("{not json");
    assert.equal(bad.status, 400);
    assert.equal((await bad.text()), "");
    assert.equal((await fetch(`${main.url}/api/v1/csp-report`)).status, 405);
    const lines = main.logger.lines.filter((l) => l.includes("[csp]"));
    assert.ok(lines.some((l) => l.includes("script-src-elem blocked https://cdn.example.net")));
    for (const l of lines) assert.doesNotMatch(l, /Synthetic|records|who=|x\.js/, l);
  });

  // ---- Logs ----
  test("logs: no directory names, emails, departments, IDs or query text (slow-request log on for every request)", async () => {
    for (const p of [`${BASE}/active/records?q=${encodeURIComponent("Synthetic Person 7")}`, `${BASE}/active/records?filter=${enc(and({ field: "department", op: "eq", value: "Dept A" }))}`, `${BASE}/active/values?field=department&q=Dept`, `${BASE}/active/records/${ids.active}`, `${BASE}/active/records?filter=${enc(and({ field: "mobile_phone", op: "eq", value: "Synthetic Person 7" }))}`]) {
      await as("viewer", "GET", p);
    }
    assert.ok(main.logger.lines.some((l) => l.includes("[slow]")), "the slow-request log ran");
    assert.ok(main.logger.lines.some((l) => l.includes("[employees] snapshot loaded")), "the employee logger is captured");
    const forbidden = [/Synthetic Person/, /synthetic\.person/, /example\.com/, /Dept [ABC]/, /Engineer|Analyst/, /\+00/, ...Object.values(ids).map((id) => new RegExp(id.replace(/[-]/g, "\\-"))), ...people.map((d) => new RegExp(d.user_id, "i"))];
    for (const line of main.logger.lines) for (const re of forbidden) assert.doesNotMatch(line, re, `log line: ${line.slice(0, 200)}`);
  });

  test("logs: a broken source document and a source outage both answer 503 and log neither values nor query text", async () => {
    const leak = "Synthetic Person 42 synthetic.person42@example.com Dept A";
    const broken = {
      probe: async () => ({ max: "2026-11-24T01:18:00.000Z", n: 1 }),
      loadAll: async () => [{ get user_id() { throw new TypeError(`bad document: ${leak}`); } }]
    };
    const down = { probe: async () => { throw Object.assign(new Error(`connect failed for ${leak}`), { name: "MongoNetworkError" }); }, loadAll: async () => [] };
    // A document that throws while the snapshot is built is a rejected load (snapshot.js run()), never a 500.
    for (const [label, source, status, errCode] of [["broken", broken, 503, "EMPLOYEES_UNAVAILABLE"], ["down", down, 503, "EMPLOYEES_UNAVAILABLE"]]) {
      const target = await boot({ issuer, env, employeesFor: (config, logger) => createEmployees({ config: config.employees, source, logger }) });
      try {
        const client = new SessionClient(target.url, issuer.config.appOrigin);
        assert.equal((await client.signIn(P.owner)).status, 201);
        // The broken source: the first request (which runs the load) is a 500; later ones within the cold-retry window are 503.
        for (const [i, p] of [`${BASE}/all/records?q=${encodeURIComponent("Synthetic Person 7")}`, `${BASE}/status`, `${BASE}/active/values?field=department&q=Dept`, `${BASE}/all/records/${ids.disabled}`].entries()) {
          const res = record(`owner(${label})`, "GET", p, await client.request("GET", p));
          const [want, wantCode] = i === 0 ? [status, errCode] : [503, "EMPLOYEES_UNAVAILABLE"];
          assert.equal(res.status, want, `${label} ${p}: ${res.text}`);
          assert.equal(code(res), wantCode);
          assert.doesNotMatch(res.text, /Synthetic|example\.com|Dept|bad document|connect failed|TypeError|Mongo/);
        }
        const lines = target.logger.lines;
        if (label === "broken") assert.ok(lines.some((l) => /\[employees\] snapshot rejected \(invalid_document\)/.test(l)), `logged as a rejected load: ${lines.join(" | ")}`);
        else assert.ok(lines.some((l) => /\[employees\] snapshot check failed: MongoNetworkError/.test(l)));
        for (const line of lines) assert.doesNotMatch(line, /Synthetic Person|synthetic\.person|example\.com|Dept [ABC]|bad document|connect failed/, `${label} log: ${line.slice(0, 200)}`);
      } finally { await target.close(); }
    }
  });

  // ---- Every response body this file received ----
  test("field privacy: no response body (any endpoint, role or error) carries phones, company, object IDs, source _ids, source field names or the source names", async () => {
    // Also the plain JSON endpoints the browser reads.
    for (const who of ["owner", "viewer", "guestViewer", "outsider", "fabricOnly", "signedOut"]) {
      await as(who, "GET", "/api/v1/features");
      await as(who, "GET", `${BASE}/status`);
    }
    assert.ok(seen.length > 500, `responses scanned: ${seen.length}`);
    const problems = [];
    for (const r of seen) {
      const lower = r.text.toLowerCase();
      for (const t of ALWAYS_FORBIDDEN) if (lower.includes(t.toLowerCase())) problems.push(`${r.who} ${r.method} ${r.path} → ${r.status}: contains ${t}`);
    }
    assert.deepEqual(problems.slice(0, 20), [], `${problems.length} leaks`);
    // Non-listed callers never received a directory value in any answer.
    for (const r of seen.filter((x) => ["outsider", "fabricOnly", "signedOut", "bearer", "bearer+session"].includes(x.who))) {
      assert.doesNotMatch(r.text, /Synthetic Person|synthetic\.person|Dept [ABC]/, `${r.who} ${r.method} ${r.path}`);
    }
  });
});
