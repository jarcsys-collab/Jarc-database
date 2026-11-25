// Fabric Data saved filters (routes/fabric-saved-filters.js): each reader's own named filters per dataset in JARC's database
// (fabricSavedFilters). The real app with Entra sign-in on the fake MongoDB, synthetic people and data only: it never connects
// to a real database. The router is composed in front of the app exactly as app.js mounts it (after `identify` and
// requireFabricDataRead, before the Fabric data router).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { sessionAuthentication } = require("../src/auth/session");
const { errorHandler } = require("../src/middleware/errors");
const { requireFabricDataRead } = require("../src/fabric/access");
const { fabricSavedFilterRoutes } = require("../src/routes/fabric-saved-filters");
const { fabricSavedFilterKey } = require("../src/repositories/mongo/fabric-saved-filter-repository");

const BASE = "/api/v1/fabric/saved-filters";
const LIMITED = "/api/v1/fabric/saved-filters-limited"; // the same router with small rate limits
const { searchLimiter } = require("../src/routes/search");
const { _internal: { broadensOf, present } } = require("../src/routes/fabric-saved-filters");
const { datasetNamed } = require("../src/fabric/datasets");
const MAX = 8; // a small per-dataset cap for the limit test (production: 50)
const code = (res) => res.body?.error?.code;
const filterOf = (...items) => ({ v: 1, op: "and", items });
const companyIs = (value) => ({ field: "Company", op: "eq", value });

let app, issuer, people, config;
const grant = (list, ...persons) => { for (const p of persons) config[list].push(p.oid.toLowerCase()); };
const revoke = (list, person) => { config[list] = config[list].filter((o) => o !== person.oid.toLowerCase()); };

before(async () => {
  issuer = await createTokenIssuer();
  const started = await startEntraApp({ issuer });
  config = { enabled: true, readerObjectIds: [], costReaderObjectIds: [] };
  const identify = sessionAuthentication({ sessions: started.dataLayer.repos.sessions, users: started.dataLayer.repos.users, entra: started.entra, accountMode: "off" });
  const outer = express();
  const readGate = requireFabricDataRead({ config: new Proxy({}, { get: (_, k) => config[k] }), tenantId: started.entra.tenantId });
  // The per-person rate limits are off here (null) so the other tests can send many requests; LIMITED has small ones (L3).
  outer.use(LIMITED, express.json(), identify, readGate, fabricSavedFilterRoutes({ repo: started.dataLayer.repos.fabricSavedFilters, maxPerDataset: MAX, readLimiter: searchLimiter({ perWindow: 3, windowMs: 60000 }), writeLimiter: searchLimiter({ perWindow: 2, windowMs: 60000 }) }));
  outer.use(BASE, express.json(), identify, readGate, fabricSavedFilterRoutes({ repo: started.dataLayer.repos.fabricSavedFilters, maxPerDataset: MAX, readLimiter: null, writeLimiter: null }));
  outer.use(started.app);
  outer.use(errorHandler(started.logger));
  const server = await new Promise((resolve) => { const s = outer.listen(0, "127.0.0.1", () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = new Map();
  const browserOf = async (person) => {
    if (!clients.has(person.name)) { const c = new SessionClient(url, started.entra.appOrigin); assert.equal((await c.signIn(person)).status, 201); clients.set(person.name, c); }
    return clients.get(person.name);
  };
  app = { ...started, url, browserOf, as: async (person, method, path, body, options) => (await browserOf(person)).request(method, path, body, options), close: async () => { await new Promise((r) => server.close(r)); await started.close(); } };
  people = { ana: issuer.person("Ana Sensitive"), ben: issuer.person("Ben Reader"), cy: issuer.person("Cy Outsider") };
  grant("readerObjectIds", people.ana, people.ben);
  grant("costReaderObjectIds", people.ana);
  for (const p of Object.values(people)) await app.browserOf(p);
});
after(async () => { await app.close(); });

const create = (person, dataset, name, state = {}) => app.as(person, "POST", `${BASE}/${dataset}`, { name, state });
const list = (person, dataset) => app.as(person, "GET", `${BASE}/${dataset}`);
const userIdOf = async (person) => (await app.as(person, "GET", "/api/v1/me")).body.user.id;

describe("Fabric saved filters", () => {
  test("create, list, rename, update and delete own filters", async () => {
    const state = { filter: filterOf(companyIs("Company A"), { op: "or", items: [{ field: "invoice_item_name", op: "contains", value: "valve" }, { field: "Quantity", op: "between", value: "10", to: "100" }] }), orderBy: [["invoice_date", "desc"]], columns: ["invoice_date", "Company", "Company", "nope"], dateFrom: "2026-11-01", dateTo: "2026-11-20", q: "abc", searchField: "customer_name" };
    const made = await create(people.ben, "sales", "  Last   7 days ", state);
    assert.equal(made.status, 201, made.text);
    assert.equal(made.headers.get("cache-control"), "no-store");
    assert.match(made.body.id, /^[0-9a-f]{16}$/);
    assert.equal(made.body.name, "Last 7 days");
    assert.equal(made.body.version, 1);
    assert.equal(made.body.valid, true);
    assert.deepEqual(made.body.state.columns, ["invoice_date", "Company"]);
    assert.deepEqual(made.body.state.orderBy, [["invoice_date", "desc"]]);
    assert.deepEqual(made.body.state.filter, state.filter);

    const listed = await list(people.ben, "sales");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.items.map((i) => i.name), ["Last 7 days"]);

    const renamed = await app.as(people.ben, "PUT", `${BASE}/sales/${made.body.id}`, { name: "Week" });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.body.name, "Week");
    assert.deepEqual(renamed.body.state.filter, state.filter);

    const updated = await app.as(people.ben, "PUT", `${BASE}/sales/${made.body.id}`, { state: { filter: filterOf(companyIs("Company B")), orderBy: [], columns: ["Company"] } });
    assert.equal(updated.status, 200, updated.text);
    assert.equal(updated.body.name, "Week");
    assert.deepEqual(updated.body.state.filter, filterOf(companyIs("Company B")));
    assert.deepEqual(updated.body.state.columns, ["Company"]);

    assert.equal((await app.as(people.ben, "PUT", `${BASE}/sales/${made.body.id}`, {})).status, 400);
    const gone = await app.as(people.ben, "DELETE", `${BASE}/sales/${made.body.id}`);
    assert.equal(gone.status, 200);
    assert.equal(gone.body.deleted, true);
    assert.deepEqual((await list(people.ben, "sales")).body.items, []);
    assert.equal((await app.as(people.ben, "DELETE", `${BASE}/sales/${made.body.id}`)).status, 404);
  });

  test("stored in JARC's fabricSavedFilters, one document per person and dataset", async () => {
    const made = await create(people.ben, "inventory", "Open lots", { filter: filterOf({ field: "Item_No", op: "startsWith", value: "LOT" }) });
    assert.equal(made.status, 201, made.text);
    const doc = await app.db.collection("fabricSavedFilters").findOne({ _id: fabricSavedFilterKey(await userIdOf(people.ben), "inventory") });
    assert.equal(doc.dataset, "inventory");
    assert.equal(doc.filters.length, 1);
    assert.equal(doc.filters[0].version, 1);
    assert.ok(doc.filters[0].createdAt instanceof Date && doc.filters[0].updatedAt instanceof Date);
    assert.equal(doc.filters[0].nameKey, "open lots");
  });

  test("ownership: another person's filter is 404 and never listed", async () => {
    const mine = await create(people.ana, "sales", "Ana's");
    assert.equal(mine.status, 201, mine.text);
    assert.ok(!(await list(people.ben, "sales")).body.items.some((i) => i.id === mine.body.id));
    for (const [method, body] of [["PUT", { name: "Taken over" }], ["DELETE"]]) {
      const res = await app.as(people.ben, method, `${BASE}/sales/${mine.body.id}`, body);
      assert.equal(res.status, 404, method);
      assert.equal(code(res), "NOT_FOUND");
    }
    assert.deepEqual((await list(people.ana, "sales")).body.items.map((i) => i.name), ["Ana's"]);
    // The same name is fine for someone else.
    assert.equal((await create(people.ben, "sales", "ana's")).status, 201);
  });

  test("dataset mismatch: a sales filter isn't reachable under inventory; unknown datasets are 404", async () => {
    const made = await create(people.ben, "sales", "Sales only");
    assert.equal((await app.as(people.ben, "PUT", `${BASE}/inventory/${made.body.id}`, { name: "x" })).status, 404);
    assert.equal((await app.as(people.ben, "DELETE", `${BASE}/inventory/${made.body.id}`)).status, 404);
    assert.ok(!(await list(people.ben, "inventory")).body.items.some((i) => i.id === made.body.id));
    for (const ds of ["FactSales", "Sales", "users", "__proto__"]) assert.equal((await list(people.ben, ds)).status, 404, ds);
    // A sales field is unknown in inventory.
    const wrong = await create(people.ben, "inventory", "Wrong", { filter: filterOf({ field: "invoice_id", op: "eq", value: "1" }) });
    assert.equal(wrong.status, 400);
    assert.deepEqual(wrong.body.error.details, { path: "filter.items.0", reason: "field" });
  });

  test("CSRF is required for every change; API tokens and non-readers are refused", async () => {
    const browser = await app.browserOf(people.ben);
    assert.equal((await browser.request("POST", `${BASE}/sales`, { name: "No CSRF" }, { csrf: null })).status, 403);
    assert.equal((await browser.request("POST", `${BASE}/sales`, { name: "Wrong CSRF" }, { csrf: "x" })).status, 403);
    assert.equal((await browser.request("POST", `${BASE}/sales`, { name: "Foreign" }, { origin: "https://evil.example" })).status, 403);
    assert.ok(!(await list(people.ben, "sales")).body.items.some((i) => ["No CSRF", "Wrong CSRF", "Foreign"].includes(i.name)));
    // A bearer token, even next to a valid session cookie.
    const withToken = await browser.request("GET", `${BASE}/sales`, undefined, { headers: { Authorization: "Bearer jarc_000000000000000000000000_x" } });
    assert.equal(withToken.status, 401);
    assert.equal((await fetch(`${app.url}${BASE}/sales`, { headers: { Authorization: "Bearer jarc_x" } })).status, 401);
    assert.equal((await fetch(`${app.url}${BASE}/sales`)).status, 401);
    const outsider = await list(people.cy, "sales");
    assert.equal(outsider.status, 403);
    assert.equal(code(outsider), "FABRIC_DATA_FORBIDDEN");
  });

  test("limits: names, uniqueness, per-dataset cap, filter size and shape", async () => {
    const p = people.ana;
    assert.equal((await create(p, "inventory", "")).status, 400);
    assert.equal((await create(p, "inventory", "   ")).status, 400);
    assert.equal((await create(p, "inventory", "x".repeat(81))).status, 400);
    assert.equal((await create(p, "inventory", "x".repeat(80))).status, 201);
    const dup = await create(p, "inventory", "X".repeat(80));
    assert.equal(dup.status, 409);
    assert.equal(code(dup), "NAME_TAKEN");
    const second = await create(p, "inventory", "Second");
    assert.equal((await app.as(p, "PUT", `${BASE}/inventory/${second.body.id}`, { name: "x".repeat(80) })).status, 409);
    assert.equal((await app.as(p, "PUT", `${BASE}/inventory/${second.body.id}`, { name: "second" })).status, 200);
    for (let i = 0; i < MAX - 2; i += 1) assert.equal((await create(p, "inventory", `F${i}`)).status, 201);
    const over = await create(p, "inventory", "One too many");
    assert.equal(over.status, 409);
    assert.equal(code(over), "LIMIT_REACHED");
    assert.equal((await list(p, "inventory")).body.items.length, MAX);
    // Filter limits (sales, under the cap).
    const many = filterOf(...Array.from({ length: 21 }, (_, i) => companyIs(`C${i}`)));
    assert.equal((await create(p, "sales", "Too many", { filter: many })).body.error.details.reason, "limit");
    const deep = filterOf({ op: "or", items: [{ op: "and", items: [companyIs("A")] }] });
    assert.equal((await create(p, "sales", "Too deep", { filter: deep })).body.error.details.reason, "depth");
    const bad = [
      { v: 2, op: "and", items: [] },
      filterOf({ field: "Company", op: "regex", value: ".*" }),
      filterOf({ field: "Company", op: "eq", value: "x".repeat(101) }),
      filterOf({ field: "Company", op: "in", values: [] }),
      filterOf({ field: "Quantity", op: "gt", value: "ten" }),
      filterOf({ field: "invoice_date", op: "on", value: "2026-02-30" }),
      filterOf({ field: "invoice_date", op: "lastN", n: 0, unit: "days" }),
      filterOf({ field: "Company", op: "eq", value: "a", extra: 1 }),
      filterOf({ field: "Custom.2", op: "eq", value: "a" })
    ];
    for (const filter of bad) assert.equal((await create(p, "sales", "Bad", { filter })).status, 400, JSON.stringify(filter));
    assert.equal((await create(p, "sales", "Bad order", { orderBy: [["Company", "asc"], ["Company", "desc"]] })).status, 400);
    assert.equal((await create(p, "sales", "Bad order", { orderBy: [["a", "asc"], ["b", "asc"], ["c", "asc"], ["d", "asc"]] })).status, 400);
    assert.equal((await create(p, "sales", "Bad state", { unknown: 1 })).status, 400);
    assert.equal((await create(p, "sales", "Bad dates", { dateFrom: "2026-11-20", dateTo: "2026-11-01" })).status, 400);
  });

  test("injection: names and values are stored as plain text; operator keys and non-text names are refused", async () => {
    const p = people.ben;
    const names = ["<script>alert(1)</script>", "$where", "'; DROP TABLE x; --", "{\"$gt\":\"\"}", "Ünïcödé ✓"];
    for (const name of names) {
      const res = await create(p, "inventory", name, { q: "$ne", filter: filterOf({ field: "Item_No", op: "eq", value: "{\"$gt\":\"\"}" }) });
      assert.equal(res.status, 201, name);
      assert.equal(res.body.name, name);
      assert.equal(res.body.state.q, "$ne");
    }
    assert.equal((await create(p, "inventory", { $gt: "" })).status, 400);
    assert.equal((await create(p, "inventory", ["a"])).status, 400);
    assert.equal((await create(p, "inventory", "bad\u0000name")).status, 400);
    assert.equal((await create(p, "inventory", "rtl‮evil")).status, 400);
    assert.equal((await app.as(p, "POST", `${BASE}/inventory`, { name: "Op key", state: { filter: { $where: "1" } } })).status, 400);
    assert.equal((await app.as(p, "POST", `${BASE}/inventory`, { name: "Proto", state: JSON.parse("{\"__proto__\":{\"x\":1}}") })).status, 400);
    assert.equal((await app.as(p, "POST", `${BASE}/inventory`, { name: "x", state: {}, owner: "someone" })).status, 400);
    // A malformed ID is the same 404 as an unknown one.
    assert.equal((await app.as(p, "DELETE", `${BASE}/inventory/${encodeURIComponent("{$ne:1}")}`)).status, 404);
  });

  test("sensitive fields: never filterable or orderable, never named in errors; columns dropped for non-sensitive callers", async () => {
    const ben = people.ben;
    for (const state of [{ filter: filterOf({ field: "landed_cost", op: "eq", value: "1" }) }, { orderBy: [["landed_cost", "asc"]] }]) {
      const res = await create(ben, "inventory", "Cost", state);
      assert.equal(res.status, 400);
      assert.ok(!res.text.includes("landed_cost"));
    }
    // Ana (sensitive) is refused too: sensitive fields aren't filterable for anyone.
    assert.equal((await create(people.ana, "sales", "Cost", { filter: filterOf({ field: "landed_cost", op: "eq", value: "1" }) })).status, 400);
    const cols = await create(ben, "sales", "Cost columns", { columns: ["Company", "landed_cost", "Custom"] });
    assert.equal(cols.status, 201);
    assert.deepEqual(cols.body.state.columns, ["Company"]);
    const stored = await app.db.collection("fabricSavedFilters").findOne({ _id: fabricSavedFilterKey(await userIdOf(ben), "sales") });
    assert.ok(!JSON.stringify(stored).includes("landed_cost") && !JSON.stringify(stored).includes("\"Custom\""));
  });

  test("revalidation on GET: a removed field and a newly restricted field are unavailable, never named", async () => {
    const dana = issuer.person("Dana Former Sensitive");
    grant("readerObjectIds", dana);
    grant("costReaderObjectIds", dana);
    const made = await create(dana, "sales", "Mixed", { columns: ["Company", "landed_cost"], orderBy: [["invoice_date", "desc"]], filter: filterOf(companyIs("A")) });
    assert.equal(made.status, 201, made.text);
    assert.deepEqual(made.body.state.columns, ["Company", "landed_cost"]);
    // Simulate schema drift in the stored document: a field removed upstream (Old_Field), and a condition on a field that has
    // since become restricted (Text), plus a restricted order key.
    const _id = fabricSavedFilterKey(await userIdOf(dana), "sales");
    const doc = await app.db.collection("fabricSavedFilters").findOne({ _id });
    doc.filters[0].state.filter = filterOf(companyIs("A"), { field: "Old_Field", op: "eq", value: "1" }, { op: "or", items: [{ field: "Text", op: "contains", value: "secret" }, companyIs("B")] });
    doc.filters[0].state.orderBy = [["Text", "asc"], ["invoice_date", "desc"]];
    await app.db.collection("fabricSavedFilters").updateOne({ _id }, { $set: { filters: doc.filters } });

    revoke("costReaderObjectIds", dana);
    const res = await list(dana, "sales");
    assert.equal(res.status, 200);
    const [item] = res.body.items;
    assert.equal(item.valid, false);
    assert.ok(item.problem);
    assert.deepEqual(item.unavailable.sort(), ["filter.items.1", "filter.items.2.items.0", "orderBy.0"].sort());
    assert.deepEqual(item.state.filter, filterOf(companyIs("A"), { unavailable: true }, { op: "or", items: [{ unavailable: true }, companyIs("B")] }));
    assert.deepEqual(item.state.orderBy, [["invoice_date", "desc"]]);
    assert.deepEqual(item.state.columns, ["Company"]);
    assert.equal(item.broadens, true, "a condition skipped from the root AND makes the rest broader (M1)");
    for (const secret of ["landed_cost", "\"Text\"", "Old_Field", "secret"]) assert.ok(!res.text.includes(secret), secret);

    // Saving it again stores only what is valid now.
    const fixed = await app.as(dana, "PUT", `${BASE}/sales/${item.id}`, { state: { ...item.state, filter: filterOf(companyIs("A")) } });
    assert.equal(fixed.status, 200, fixed.text);
    assert.equal(fixed.body.valid, true);
    assert.ok(!JSON.stringify(await app.db.collection("fabricSavedFilters").findOne({ _id })).includes("landed_cost"));

    // A reader removed from Fabric Data can't reach their filters at all.
    revoke("readerObjectIds", dana);
    assert.equal((await list(dana, "sales")).status, 403);
  });

  test("structurally broken stored filters are withheld as a whole", async () => {
    const eve = issuer.person("Eve Reader");
    grant("readerObjectIds", eve);
    const made = await create(eve, "inventory", "Will break");
    const _id = fabricSavedFilterKey(await userIdOf(eve), "inventory");
    const doc = await app.db.collection("fabricSavedFilters").findOne({ _id });
    doc.filters[0].state.filter = { v: 9, op: "xor", items: [{ field: "landed_cost", op: "eq", value: "1" }] };
    await app.db.collection("fabricSavedFilters").updateOne({ _id }, { $set: { filters: doc.filters } });
    const res = await list(eve, "inventory");
    const item = res.body.items.find((i) => i.id === made.body.id);
    assert.equal(item.valid, false);
    assert.equal(item.state.filter, null);
    assert.deepEqual(item.unavailable, ["filter"]);
    assert.equal(item.broadens, true, "the whole filter withheld is broader (M1)");
    assert.ok(!res.text.includes("landed_cost"));
  });

  test("broadens (M1): AND skips broaden, OR skips only narrow, an emptied OR broadens its AND parent; computed on GET", async () => {
    const U = { unavailable: true }, c = (v) => companyIs(v);
    const and = (...items) => ({ op: "and", items }), or = (...items) => ({ op: "or", items });
    assert.equal(broadensOf({ v: 1, ...and(c("A"), U) }), true, "root AND");
    assert.equal(broadensOf({ v: 1, ...or(c("A"), U) }), false, "root OR: narrower");
    assert.equal(broadensOf({ v: 1, ...or(c("A"), and(c("B"), U)) }), true, "AND group inside an OR: that branch matches more");
    assert.equal(broadensOf({ v: 1, ...and(c("A"), or(c("B"), U)) }), false, "OR group inside an AND: narrower");
    assert.equal(broadensOf({ v: 1, ...and(c("A"), or(U, U)) }), true, "an OR left empty is dropped from its AND parent");
    assert.equal(broadensOf({ v: 1, ...or(c("A"), or(U, U)) }), false, "an OR left empty inside an OR: narrower");
    assert.equal(broadensOf({ v: 1, ...or(U, U) }), true, "nothing left: no filter at all");
    assert.equal(broadensOf({ v: 1, ...and(c("A"), c("B")) }), false, "nothing skipped");
    // present(): an OR-only skip is not broader; a sort key alone isn't either; a search that loses its field is.
    const ds = datasetNamed("sales"), opts = { sensitive: false, validateFilter: null };
    const at = new Date("2026-11-25T00:00:00Z");
    const stored = (state) => ({ id: "0123456789abcdef", name: "x", version: 1, state, createdAt: at, updatedAt: at });
    const narrow = present(ds, stored({ filter: { v: 1, ...or(c("A"), { field: "landed_cost", op: "eq", value: "1" }) } }), opts);
    assert.deepEqual([narrow.valid, narrow.broadens], [false, false]);
    const sortOnly = present(ds, stored({ filter: { v: 1, ...and(c("A")) }, orderBy: [["landed_cost", "asc"]] }), opts);
    assert.deepEqual([sortOnly.valid, sortOnly.broadens], [false, false]);
    const wide = present(ds, stored({ filter: { v: 1, ...and(c("A"), { field: "landed_cost", op: "eq", value: "1" }) } }), opts);
    assert.deepEqual([wide.valid, wide.broadens], [false, true]);
    assert.ok(!JSON.stringify(wide).includes("landed_cost"), "never named");
    const search = present(ds, stored({ q: "abc", searchField: "nope" }), opts);
    assert.deepEqual([search.valid, search.broadens], [false, true]);
    assert.equal(present(ds, stored({ filter: { v: 1, ...and(c("A")) } }), opts).broadens, undefined, "valid filters carry no broadens");
  });

  test("rate limits per person (L3): reads and changes each have a window; 429 RATE_LIMITED before any database call", async () => {
    const fay = issuer.person("Fay Busy"), gus = issuer.person("Gus Other");
    grant("readerObjectIds", fay, gus);
    for (let i = 0; i < 3; i += 1) assert.equal((await app.as(fay, "GET", `${LIMITED}/sales`)).status, 200);
    const limited = await app.as(fay, "GET", `${LIMITED}/sales`);
    assert.equal(limited.status, 429);
    assert.equal(code(limited), "RATE_LIMITED");
    assert.equal((await app.as(gus, "GET", `${LIMITED}/sales`)).status, 200, "another person has their own window");
    assert.equal((await app.as(fay, "POST", `${LIMITED}/sales`, { name: "One", state: {} })).status, 201);
    assert.equal((await app.as(fay, "POST", `${LIMITED}/sales`, { name: "Two", state: {} })).status, 201);
    const third = await app.as(fay, "POST", `${LIMITED}/sales`, { name: "Three", state: {} });
    assert.equal(third.status, 429);
    const names = (await list(fay, "sales")).body.items.map((i) => i.name);
    assert.ok(!names.includes("Three"), "the refused write wasn't stored");
  });

  test("bodies over 32 KB are refused with 413 (L3)", async () => {
    const big = await app.as(people.ben, "POST", `${BASE}/sales`, { name: "Big", state: { q: "x".repeat(40 * 1024) } });
    assert.equal(big.status, 413);
    assert.equal(code(big), "PAYLOAD_TOO_LARGE");
  });
});
