// Employee Management HTTP routes (employees/router.js + routes/employee-saved-filters.js), mounted the way app.js will mount
// them: at /api/v1/admin/employees, after `identify` (a real JARC session from the offline Entra stand-in, CSRF on writes), in
// front of the real app. The directory source is the read-only fake; synthetic people only. Never a real database.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { sessionAuthentication } = require("../src/auth/session");
const { errorHandler } = require("../src/middleware/errors");
const { searchLimiter } = require("../src/routes/search");
const { createEmployees, employeeRoutes, profileId } = require("../src/employees");
const { employeeSavedFilterKey } = require("../src/repositories/mongo/employee-saved-filter-repository");
const fm = require("../src/fabric/filter-model");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const BASE = "/api/v1/admin/employees";
const LIMITED = "/api/v1/admin/employees-limited"; // the same router with small rate limits
const code = (res) => res.body?.error?.code;
const and = (...items) => ({ v: 1, op: "and", items });
const people = syntheticPeople(30);
const disabled = people.find((d) => !d.account_enabled), guest = people.find((d) => d.user_type === "Guest");
const activePerson = people.find((d) => d.account_enabled && d.user_type === "Member");
const FORBIDDEN_TEXT = ["+00", "Synthetic Company", "ingest-", "user_id", "mobile", "business_phones", "company", ...people.map((d) => d.user_id)];
const noLeak = (res, label) => { for (const t of FORBIDDEN_TEXT) assert.ok(!res.text.includes(t), `${label}: ${t}`); };

let app, issuer, persons, config, fake, logs;
before(async () => {
  issuer = await createTokenIssuer();
  const started = await startEntraApp({ issuer });
  persons = { owner: issuer.person("Synthetic Owner"), viewer: issuer.person("Synthetic Viewer"), viewer2: issuer.person("Synthetic Viewer Two"), outsider: issuer.person("Synthetic Outsider", { admin: true }) };
  config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: started.entra.tenantId, viewerObjectIds: [persons.viewer.oid, persons.viewer2.oid], adminObjectIds: [persons.owner.oid] }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
  fake = new EmployeeFakeClient({ docs: people });
  logs = [];
  const logger = { info: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  const employees = createEmployees({ config, createClient: () => fake, idKey: TEST_ID_KEY, logger });
  const identify = sessionAuthentication({ sessions: started.dataLayer.repos.sessions, users: started.dataLayer.repos.users, entra: started.entra, accountMode: "off" });
  const outer = express();
  outer.use(LIMITED, express.json(), identify, employeeRoutes({ employees, savedFilterRepo: started.dataLayer.repos.employeeSavedFilters, limiter: searchLimiter({ perWindow: 3, windowMs: 60000 }), savedFilters: { readLimiter: searchLimiter({ perWindow: 2, windowMs: 60000 }), writeLimiter: searchLimiter({ perWindow: 1, windowMs: 60000 }) }, logger }));
  outer.use(BASE, express.json(), identify, employeeRoutes({ employees, savedFilterRepo: started.dataLayer.repos.employeeSavedFilters, limiter: null, savedFilters: { readLimiter: null, writeLimiter: null, maxPerDataset: 3 }, logger }));
  outer.use(started.app);
  outer.use(errorHandler(started.logger));
  const server = await new Promise((resolve) => { const s = outer.listen(0, "127.0.0.1", () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = new Map();
  const browserOf = async (p) => {
    if (!clients.has(p.name)) { const c = new SessionClient(url, started.entra.appOrigin); assert.equal((await c.signIn(p)).status, 201); clients.set(p.name, c); }
    return clients.get(p.name);
  };
  app = { ...started, url, as: async (p, method, path, body, options) => (await browserOf(p)).request(method, path, body, options), close: async () => { await new Promise((r) => server.close(r)); await started.close(); } };
});
after(async () => { await app.close(); });

describe("who may use it", () => {
  test("signed out → 401; a bearer token → 401 even with a session", async () => {
    const res = await fetch(`${app.url}${BASE}/status`);
    assert.equal(res.status, 401);
    const withBearer = await app.as(persons.owner, "GET", `${BASE}/status`, undefined, { headers: { Authorization: "Bearer jarc_synthetic" } });
    assert.equal(withBearer.status, 401);
  });

  test("a signed-in person who isn't listed gets 403 EMPLOYEES_FORBIDDEN everywhere (JARC.Admin grants nothing)", async () => {
    const id = profileId(TEST_ID_KEY, activePerson.user_id);
    for (const [method, path, body] of [["GET", "/status"], ["GET", "/active/schema"], ["GET", "/active/records"], ["GET", `/active/records/${id}`], ["GET", "/active/values?field=department"], ["GET", "/all/records"], ["GET", "/nope/records"], ["GET", "/saved-filters/active"], ["POST", "/saved-filters/active", { name: "x", state: {} }], ["DELETE", "/saved-filters/active/0123456789abcdef"]]) {
      const res = await app.as(persons.outsider, method, `${BASE}${path}`, body);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(code(res), "EMPLOYEES_FORBIDDEN");
      noLeak(res, path);
    }
  });

  test("a viewer: the active dataset only; admin datasets 403; disabled and guest profile IDs 404", async () => {
    const s = await app.as(persons.viewer, "GET", `${BASE}/status`);
    assert.equal(s.status, 200);
    assert.equal(s.headers.get("cache-control"), "no-store");
    assert.deepEqual(s.body.access, { datasets: ["active"], admin: false });
    assert.deepEqual(Object.keys(s.body.counts), ["active"]);
    for (const ds of ["all", "disabled", "guests"]) for (const tail of ["schema", "records", "values?field=department"]) {
      const res = await app.as(persons.viewer, "GET", `${BASE}/${ds}/${tail}`);
      assert.equal(res.status, 403, `${ds}/${tail}`); assert.equal(code(res), "EMPLOYEES_FORBIDDEN");
    }
    for (const d of [disabled, guest]) {
      const id = profileId(TEST_ID_KEY, d.user_id);
      for (const ds of ["active", "all"]) { const res = await app.as(persons.viewer, "GET", `${BASE}/${ds}/records/${id}`); assert.ok([403, 404].includes(res.status)); }
      const res = await app.as(persons.viewer, "GET", `${BASE}/active/records/${id}`);
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, (await app.as(persons.viewer, "GET", `${BASE}/active/records/${"Q".repeat(22)}`)).body, "the same answer as an unknown ID");
    }
    const ok = await app.as(persons.viewer, "GET", `${BASE}/active/records/${profileId(TEST_ID_KEY, activePerson.user_id)}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.values.displayName, activePerson.display_name);
    assert.ok(!("accountEnabled" in ok.body.values) && !("accountType" in ok.body.values));
    noLeak(ok, "record");
  });

  test("an admin: every dataset", async () => {
    const s = await app.as(persons.owner, "GET", `${BASE}/status`);
    assert.deepEqual(s.body.access, { datasets: ["active", "all", "disabled", "guests"], admin: true });
    for (const ds of ["active", "all", "disabled", "guests"]) {
      const res = await app.as(persons.owner, "GET", `${BASE}/${ds}/records?limit=200`);
      assert.equal(res.status, 200, ds);
      assert.equal(res.body.items.length, s.body.counts[ds]);
    }
    const g = await app.as(persons.owner, "GET", `${BASE}/guests/records/${profileId(TEST_ID_KEY, guest.user_id)}`);
    assert.equal(g.status, 200);
    assert.equal(g.body.values.accountType, "Guest");
    assert.equal(g.body.values.emailDomain, null);
  });

  test("access follows the configured lists on every request", async () => {
    config.viewerObjectIds = [persons.viewer.oid];
    assert.equal((await app.as(persons.viewer2, "GET", `${BASE}/status`)).status, 403);
    config.viewerObjectIds = [persons.viewer.oid, persons.viewer2.oid];
    assert.equal((await app.as(persons.viewer2, "GET", `${BASE}/status`)).status, 200);
  });
});

describe("responses", () => {
  test("schema, records and values never carry phones, company, object IDs or the source _id; no logs of values", async () => {
    const schema = await app.as(persons.owner, "GET", `${BASE}/all/schema`);
    assert.equal(schema.status, 200);
    assert.equal(schema.body.dateWindow, undefined);
    assert.deepEqual(schema.body.defaultColumns, ["displayName", "jobTitle", "department", "officeLocation", "mail"]);
    assert.ok(schema.body.filterModel && schema.body.searchFields.length);
    noLeak(schema, "schema");
    const all = await app.as(persons.owner, "GET", `${BASE}/all/records?limit=200&fields=displayName,givenName,surname,mail,userPrincipalName,jobTitle,department,officeLocation,emailDomain,accountEnabled,accountType,accountCreated`);
    noLeak(all, "records");
    for (const item of all.body.items) assert.deepEqual(Object.keys(item), ["id", "values"]);
    for (const f of ["department", "jobTitle", "officeLocation", "emailDomain", "accountType"]) noLeak(await app.as(persons.owner, "GET", `${BASE}/all/values?field=${f}`), f);
    const search = await app.as(persons.owner, "GET", `${BASE}/all/records?q=${encodeURIComponent("Synthetic Person 1")}`);
    assert.equal(search.status, 200);
    assert.ok(!logs.some((l) => l.includes("Synthetic Person") || l.includes("example.com") || l.includes("Dept")), "no values in logs");
  });

  test("errors never name the refused field or echo values", async () => {
    for (const path of [`/active/records?fields=mobile_phone`, `/active/records?orderBy=company_name:asc`, `/active/values?field=business_phones`, `/active/records?filter=${fm.encodeFilterParam(and({ field: "mobile_phone", op: "blank" }))}`, `/active/records?filter=${fm.encodeFilterParam(and({ field: "accountEnabled", op: "isFalse" }))}`, `/active/records?secretparam=1`]) {
      const res = await app.as(persons.viewer, "GET", `${BASE}${path}`);
      assert.equal(res.status, 400, path);
      assert.equal(code(res), "VALIDATION_ERROR");
      for (const t of ["mobile", "company", "business", "accountEnabled", "secretparam"]) assert.ok(!res.text.includes(t), `${path}: ${t}`);
    }
  });

  test("read-only: other methods are refused on data paths; unknown datasets 404", async () => {
    assert.equal((await app.as(persons.owner, "POST", `${BASE}/active/records`, {})).status, 405);
    const unknown = await app.as(persons.owner, "GET", `${BASE}/people/records`);
    assert.equal(unknown.status, 404);
    assert.ok(!unknown.text.includes("people"));
  });

  test("paging with cursors over HTTP, bound to the caller", async () => {
    const first = await app.as(persons.owner, "GET", `${BASE}/active/records?limit=5`);
    const cursor = first.body.pagination.nextCursor;
    assert.ok(cursor);
    const second = await app.as(persons.owner, "GET", `${BASE}/active/records?limit=5&cursor=${cursor}`);
    assert.equal(second.status, 200);
    assert.ok(!second.body.items.some((i) => first.body.items.some((j) => j.id === i.id)));
    assert.equal((await app.as(persons.viewer, "GET", `${BASE}/active/records?limit=5&cursor=${cursor}`)).status, 400);
  });

  test("rate limits answer 429 RATE_LIMITED", async () => {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await app.as(persons.viewer2, "GET", `${LIMITED}/active/schema`)).status);
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    const sf = [];
    for (let i = 0; i < 3; i += 1) sf.push((await app.as(persons.viewer2, "GET", `${LIMITED}/saved-filters/active`)).status);
    assert.deepEqual(sf, [200, 200, 429]);
  });
});

describe("saved filters", () => {
  const SF = `${BASE}/saved-filters`;
  test("own filters: create, list, update, delete; validated state only; CSRF needed", async () => {
    const state = { filter: and({ field: "department", op: "eq", value: "Dept A" }), orderBy: [["displayName", "asc"]], columns: ["displayName", "department", "nope", "mobile_phone"], q: "person", searchField: "displayName", dateFrom: null };
    const made = await app.as(persons.viewer, "POST", `${SF}/active`, { name: "  Dept   A ", state });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.body.name, "Dept A");
    assert.equal(made.body.valid, true);
    assert.deepEqual(made.body.state.columns, ["displayName", "department"]);
    const stored = await app.db.collection("employeeSavedFilters").findOne({ _id: employeeSavedFilterKey((await app.as(persons.viewer, "GET", "/api/v1/me")).body.user.id, "active") });
    assert.deepEqual(Object.keys(stored.filters[0].state), ["filter", "orderBy", "columns", "q", "searchField"]);
    const noCsrf = await app.as(persons.viewer, "POST", `${SF}/active`, { name: "x", state: {} }, { csrf: "" });
    assert.equal(noCsrf.status, 403);
    assert.equal(code(noCsrf), "CSRF_INVALID");
    const upd = await app.as(persons.viewer, "PUT", `${SF}/active/${made.body.id}`, { name: "Renamed" });
    assert.equal(upd.status, 200); assert.equal(upd.body.name, "Renamed");
    const list = await app.as(persons.viewer, "GET", `${SF}/active`);
    assert.deepEqual(list.body.items.map((i) => i.name), ["Renamed"]);
    const del = await app.as(persons.viewer, "DELETE", `${SF}/active/${made.body.id}`);
    assert.deepEqual(del.body, { deleted: true, id: made.body.id });
  });

  test("another person's filter is 404, like an unknown one; viewers can't use admin datasets", async () => {
    const mine = await app.as(persons.viewer, "POST", `${SF}/active`, { name: "Mine", state: {} });
    assert.equal(mine.status, 201);
    for (const [method, body] of [["PUT", { name: "Hijack" }], ["DELETE", undefined]]) {
      const res = await app.as(persons.viewer2, method, `${SF}/active/${mine.body.id}`, body);
      assert.equal(res.status, 404, method);
    }
    assert.deepEqual((await app.as(persons.viewer2, "GET", `${SF}/active`)).body.items, []);
    assert.equal((await app.as(persons.viewer, "POST", `${SF}/all`, { name: "x", state: {} })).status, 403);
    assert.equal((await app.as(persons.viewer, "GET", `${SF}/disabled`)).status, 403);
  });

  test("writes refuse unknown or restricted fields without naming them; limits", async () => {
    for (const filter of [and({ field: "mobile_phone", op: "blank" }), and({ field: "accountEnabled", op: "isTrue" })]) {
      const res = await app.as(persons.viewer, "POST", `${SF}/active`, { name: "Bad", state: { filter } });
      assert.equal(res.status, 400); assert.ok(!res.text.includes("mobile") && !res.text.includes("accountEnabled"));
    }
    const bad = await app.as(persons.viewer, "POST", `${SF}/active`, { name: "Bad", state: { orderBy: [["company_name", "asc"]] } });
    assert.equal(bad.status, 400); assert.ok(!bad.text.includes("company"));
    assert.equal((await app.as(persons.viewer, "POST", `${SF}/active`, { name: "Dates", state: { dateFrom: "2026-01-01" } })).status, 400);
    const big = await app.as(persons.viewer, "POST", `${SF}/active`, { name: "Big", state: { q: "x".repeat(40 * 1024) } });
    assert.equal(big.status, 413);
    await app.as(persons.viewer, "POST", `${SF}/active`, { name: "Two", state: {} });
    await app.as(persons.viewer, "POST", `${SF}/active`, { name: "Three", state: {} });
    const over = await app.as(persons.viewer, "POST", `${SF}/active`, { name: "Four", state: {} });
    assert.equal(over.status, 409); assert.equal(code(over), "LIMIT_REACHED");
    assert.equal((await app.as(persons.viewer, "POST", `${SF}/active`, { name: "two", state: {} })).status, 409);
  });

  test("revalidated on every read: a stored condition that no longer validates is withheld, never named", async () => {
    const made = await app.as(persons.owner, "POST", `${SF}/all`, { name: "Stored", state: { filter: and({ field: "department", op: "eq", value: "Dept A" }, { field: "jobTitle", op: "eq", value: "Engineer" }) } });
    assert.equal(made.status, 201);
    const _id = employeeSavedFilterKey((await app.as(persons.owner, "GET", "/api/v1/me")).body.user.id, "all");
    const doc = await app.db.collection("employeeSavedFilters").findOne({ _id });
    doc.filters[0].state.filter.items[1] = { field: "mobile_phone", op: "eq", value: "x" };
    doc.filters[0].state.orderBy = [["company_name", "asc"]];
    await app.db.collection("employeeSavedFilters").updateOne({ _id }, { $set: { filters: doc.filters } });
    const list = await app.as(persons.owner, "GET", `${SF}/all`);
    const item = list.body.items[0];
    assert.equal(item.valid, false);
    assert.equal(item.broadens, true);
    assert.deepEqual(item.state.filter.items[1], { unavailable: true });
    assert.deepEqual(item.state.orderBy, []);
    assert.ok(!list.text.includes("mobile") && !list.text.includes("company"));
  });
});
