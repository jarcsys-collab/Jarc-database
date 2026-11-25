// Employee Management service and snapshot cache (src/employees), without HTTP: the read-only fake source, synthetic people only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { createEmployees, profileId } = require("../src/employees");
const { EmployeeSnapshot, CHECK_MS, STALE_MS } = require("../src/employees/snapshot");
const { PROJECTION } = require("../src/employees/fields");
const fm = require("../src/fabric/filter-model");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const TENANT = "00000000-0000-4000-8000-00000000a001";
const configOf = () => Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: TENANT, viewerObjectIds: [], adminObjectIds: [] }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
const ADMIN = { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"], who: "u-admin" };
const VIEWER = { view: true, admin: false, datasets: ["active"], who: "u-viewer" };
const enc = (model) => fm.encodeFilterParam(model);
const and = (...items) => ({ v: 1, op: "and", items });
const silent = { info() {}, warn() {}, error() {} };

function setup({ n = 30, docs } = {}) {
  let t = Date.UTC(2026, 10, 25, 9, 0, 0);
  const fake = new EmployeeFakeClient({ docs: docs || syntheticPeople(n) });
  const employees = createEmployees({ config: configOf(), createClient: () => fake, idKey: TEST_ID_KEY, now: () => t, logger: silent });
  return { fake, employees, service: employees.service, snapshot: employees.snapshot, tick: (ms) => { t += ms; }, now: () => t };
}
const allIds = async (service, ds, query = {}, access = ADMIN) => {
  const out = []; let cursor;
  do { const page = await service.listRecords(ds, { ...query, limit: "7", ...(cursor ? { cursor } : {}) }, access); out.push(...page.items); cursor = page.pagination.nextCursor; } while (cursor);
  return out;
};

describe("source reads", () => {
  test("only the allow-listed fields are projected; phones, company and _id never are", async () => {
    const { fake, service } = setup();
    await service.status({}, ADMIN);
    const find = fake.calls.find((c) => c.op === "find");
    assert.deepEqual(find.projection, { ...PROJECTION });
    for (const f of ["mobile_phone", "business_phones", "company_name"]) assert.ok(!Object.hasOwn(find.projection, f));
    assert.equal(find.projection._id, 0);
    const text = JSON.stringify(await service.listRecords("all", { fields: "displayName,givenName,surname,mail,userPrincipalName,jobTitle,department,officeLocation,emailDomain,accountEnabled,accountType,accountCreated", limit: "200" }, ADMIN));
    for (const bad of ["+00", "Synthetic Company", "ingest-", "user_id", "mobile", "phone"]) assert.ok(!text.includes(bad), bad);
  });

  test("a login that can do more than read is refused (503, nothing loaded)", async () => {
    const fake = new EmployeeFakeClient({ docs: syntheticPeople(5), authInfo: { authenticatedUserRoles: [{ role: "readWrite", db: DB_NAME }], authenticatedUserPrivileges: [{ actions: ["find", "insert"] }] } });
    const employees = createEmployees({ config: configOf(), createClient: () => fake, idKey: TEST_ID_KEY, logger: silent });
    await assert.rejects(employees.service.status({}, ADMIN), (e) => e.status === 503 && e.code === "EMPLOYEES_UNAVAILABLE");
    assert.equal(employees.connection.status().state, "unsafe");
    assert.equal(fake.calls.length, 0);
  });
});

describe("snapshot cache", () => {
  test("single flight: concurrent first requests share one probe and one load", async () => {
    const { fake, service } = setup();
    await Promise.all(Array.from({ length: 8 }, () => service.listRecords("active", {}, VIEWER)));
    assert.equal(fake.calls.filter((c) => c.op === "aggregate").length, 1);
    assert.equal(fake.calls.filter((c) => c.op === "find").length, 1);
  });

  test("checks at most every 5 minutes, reloads only when the ingestion changes", async () => {
    const { fake, service, snapshot, tick } = setup();
    await service.status({}, ADMIN);
    tick(CHECK_MS - 1000); await service.status({}, ADMIN); await snapshot.inFlight;
    assert.equal(fake.calls.filter((c) => c.op === "aggregate").length, 1);
    tick(2000); await service.status({}, ADMIN); await snapshot.inFlight;
    assert.equal(fake.calls.filter((c) => c.op === "aggregate").length, 2);
    assert.equal(fake.calls.filter((c) => c.op === "find").length, 1, "same ingestion: no reload");
    fake.docs = syntheticPeople(32, { ingestion: "2026-11-25T01:00:00.000Z" });
    tick(CHECK_MS); await service.status({}, ADMIN); await snapshot.inFlight;
    assert.equal(fake.calls.filter((c) => c.op === "find").length, 2);
    const s = await service.status({}, ADMIN);
    assert.equal(s.snapshot.ingestedAt, "2026-11-25T01:00:00.000Z");
    assert.equal(s.snapshot.stale, false);
    assert.equal(s.counts.all, 32);
  });

  test("a rejected snapshot keeps the last good one, marked stale", async () => {
    const { fake, service, snapshot, tick } = setup({ n: 30 });
    await service.status({}, ADMIN);
    const before = (await service.status({}, ADMIN)).counts.all;
    for (const [docs, why] of [
      [syntheticPeople(20, { ingestion: "2026-11-26T00:00:00.000Z" }), "count drop"],
      [syntheticPeople(30, { ingestion: "2026-11-26T00:00:00.000Z" }).map((d, i) => (i === 3 ? { ...d, user_id: "not-a-guid" } : d)), "invalid id"],
      [(() => { const d = syntheticPeople(30, { ingestion: "2026-11-26T00:00:00.000Z" }); d[4] = { ...d[4], user_id: d[5].user_id }; return d; })(), "duplicate id"]
    ]) {
      fake.docs = docs;
      tick(CHECK_MS); await snapshot.refresh();
      const s = await service.status({}, ADMIN);
      assert.equal(s.counts.all, before, why);
      assert.equal(s.snapshot.stale, true, why);
      assert.equal(s.snapshot.staleReason, "snapshot_rejected", why);
    }
    // A good one clears it.
    fake.docs = syntheticPeople(29, { ingestion: "2026-11-27T00:00:00.000Z" });
    tick(CHECK_MS); await snapshot.refresh();
    const s = await service.status({}, ADMIN);
    assert.equal(s.snapshot.stale, false);
    assert.equal(s.counts.all, 29);
  });

  test("source down: stale with a warm snapshot, 503 without one; stale also when checks are overdue", async () => {
    const { fake, service, snapshot, tick } = setup();
    fake.down = true;
    await assert.rejects(service.listRecords("active", {}, VIEWER), (e) => e.status === 503 && e.code === "EMPLOYEES_UNAVAILABLE");
    fake.down = false;
    tick(15000);
    await service.status({}, ADMIN);
    fake.down = true;
    tick(CHECK_MS); await snapshot.refresh();
    const page = await service.listRecords("active", {}, VIEWER);
    assert.ok(page.items.length > 0);
    assert.equal(page.snapshot.stale, true);
    assert.equal(page.snapshot.staleReason, "source_unavailable");
    // Overdue: no successful check for more than 30 minutes, even without a recorded failure.
    const snap = new EmployeeSnapshot({ source: { probe: async () => ({ max: "2026-11-24T01:18:00.000Z", n: 1 }), loadAll: async () => syntheticPeople(1) }, idKey: TEST_ID_KEY, now: () => clock, logger: silent });
    let clock = 0;
    await snap.current();
    assert.equal(snap.meta().stale, false);
    clock = STALE_MS + 1;
    assert.equal(snap.meta().stale, true);
    assert.equal(snap.meta().staleReason, "check_overdue");
  });
});

describe("datasets and IDs", () => {
  test("active = enabled members only; admin datasets have their own base; status counts", async () => {
    const { service } = setup({ n: 35 });
    const people = syntheticPeople(35);
    const expected = (pred) => people.filter(pred).length;
    const s = await service.status({}, ADMIN);
    assert.equal(s.counts.active, expected((d) => d.account_enabled && d.user_type === "Member"));
    assert.equal(s.counts.disabled, expected((d) => !d.account_enabled));
    assert.equal(s.counts.guests, expected((d) => d.user_type === "Guest"));
    assert.equal(s.counts.all, 35);
    assert.deepEqual(Object.keys((await service.status({}, VIEWER)).counts), ["active"]);
    const active = await allIds(service, "active", { fields: "displayName" }, VIEWER);
    assert.equal(active.length, s.counts.active);
    // Admin-only fields are not part of the active dataset at all.
    assert.ok(!service.schema("active", {}, VIEWER).fields.some((f) => ["accountEnabled", "accountType"].includes(f.name)));
    await assert.rejects(service.listRecords("active", { fields: "accountEnabled" }, VIEWER), (e) => e.status === 400 && !e.message.includes("accountEnabled"));
    assert.throws(() => service.schema("all", {}, VIEWER), (e) => e.status === 403 && e.code === "EMPLOYEES_FORBIDDEN");
    assert.throws(() => service.schema("nope", {}, ADMIN), (e) => e.status === 404 && !e.message.includes("nope"));
  });

  test("opaque IDs: the contract formula, stable across reloads, never the object ID; out of scope → 404", async () => {
    const { service, snapshot, fake, tick } = setup();
    const people = syntheticPeople(30);
    const first = await service.listRecords("all", { limit: "200" }, ADMIN);
    const oids = new Set(people.map((d) => d.user_id));
    for (const item of first.items) { assert.match(item.id, /^[A-Za-z0-9_-]{22}$/); assert.ok(!oids.has(item.id)); }
    const disabled = people.find((d) => !d.account_enabled), guest = people.find((d) => d.user_type === "Guest");
    assert.equal(profileId(TEST_ID_KEY, disabled.user_id.toUpperCase()), profileId(TEST_ID_KEY, disabled.user_id));
    const disabledId = profileId(TEST_ID_KEY, disabled.user_id), guestId = profileId(TEST_ID_KEY, guest.user_id);
    assert.ok(first.items.some((i) => i.id === disabledId));
    fake.docs = syntheticPeople(30, { ingestion: "2026-11-26T00:00:00.000Z" });
    tick(CHECK_MS); await snapshot.refresh();
    const second = await service.listRecords("all", { limit: "200" }, ADMIN);
    assert.deepEqual(second.items.map((i) => i.id).sort(), first.items.map((i) => i.id).sort());
    const one = await service.getRecord("all", disabledId, {}, ADMIN);
    assert.equal(one.id, disabledId);
    assert.equal(one.values.accountEnabled, false);
    for (const id of [disabledId, guestId, "A".repeat(22), "short", disabled.user_id]) await assert.rejects(service.getRecord("active", id, {}, VIEWER), (e) => e.status === 404, id);
  });
});

describe("filters, search, sort, cursors, values", () => {
  test("operators: text, category, bool, date (incl. relative), blank, lists, nested AND/OR", async () => {
    const { service } = setup({ n: 40 });
    const people = syntheticPeople(40);
    const count = async (model, ds = "all") => (await allIds(service, ds, { filter: enc(model), fields: "displayName" })).length;
    const n = (pred) => people.filter(pred).length;
    assert.equal(await count(and({ field: "department", op: "eq", value: "Dept A" })), n((d) => d.department === "Dept A"));
    assert.equal(await count(and({ field: "department", op: "ne", value: "Dept A" })), n((d) => d.department !== "Dept A"));
    assert.equal(await count(and({ field: "department", op: "blank" })), n((d) => !d.department));
    assert.equal(await count(and({ field: "officeLocation", op: "blank" })), n((d) => !d.office_location.trim()));
    assert.equal(await count(and({ field: "department", op: "in", values: ["Dept A", null] })), n((d) => d.department === "Dept A" || !d.department));
    assert.equal(await count(and({ field: "department", op: "nin", values: ["Dept A", "Dept B"] })), n((d) => !["Dept A", "Dept B"].includes(d.department)));
    assert.equal(await count(and({ field: "displayName", op: "contains", value: "person 1" })), n((d) => d.display_name.toLowerCase().includes("person 1")));
    assert.equal(await count(and({ field: "displayName", op: "startsWith", value: "Synthetic Person 3" })), n((d) => d.display_name.startsWith("Synthetic Person 3")));
    assert.equal(await count(and({ field: "displayName", op: "startsWith", value: "synthetic" })), 0, "startsWith is case-sensitive");
    assert.equal(await count(and({ field: "jobTitle", op: "notBlank" })), n((d) => d.job_title));
    assert.equal(await count(and({ field: "accountEnabled", op: "isFalse" })), n((d) => !d.account_enabled));
    assert.equal(await count(and({ field: "accountType", op: "eq", value: "Guest" })), n((d) => d.user_type === "Guest"));
    assert.equal(await count(and({ field: "emailDomain", op: "eq", value: "example.com" })), n((d) => d.user_type !== "Guest"));
    assert.equal(await count(and({ field: "accountCreated", op: "before", value: "2025-01-01" })), n((d) => d.created_datetime < "2025-01-01"));
    assert.equal(await count(and({ field: "accountCreated", op: "between", value: "2025-01-01", to: "2025-06-30" })), n((d) => d.created_datetime >= "2025-01-01" && d.created_datetime < "2025-07-01"));
    assert.equal(await count(and({ field: "accountCreated", op: "lastN", n: 6, unit: "months" })), n((d) => new Date(d.created_datetime) >= new Date(Date.UTC(2026, 4, 26)) && new Date(d.created_datetime) < new Date(Date.UTC(2026, 10, 26))));
    assert.equal(await count(and({ field: "department", op: "eq", value: "Dept A" }, { op: "or", items: [{ field: "jobTitle", op: "eq", value: "Engineer" }, { field: "accountEnabled", op: "isFalse" }] })),
      n((d) => d.department === "Dept A" && (d.job_title === "Engineer" || !d.account_enabled)));
    assert.equal(await count({ v: 1, op: "or", items: [{ field: "department", op: "eq", value: "Dept B" }, { field: "accountType", op: "eq", value: "Guest" }] }), n((d) => d.department === "Dept B" || d.user_type === "Guest"));
    // The filter can never widen the dataset's base condition.
    const activeN = n((d) => d.account_enabled && d.user_type === "Member");
    assert.equal(await count({ v: 1, op: "or", items: [{ field: "displayName", op: "notBlank" }] }, "active"), activeN);
  });

  test("restricted and unknown fields are refused without naming them", async () => {
    const { service } = setup();
    for (const field of ["mobile_phone", "company_name", "user_id", "_id", "accountEnabled"]) {
      await assert.rejects(service.listRecords("active", { filter: enc(and({ field, op: "blank" })) }, VIEWER), (e) => e.status === 400 && !JSON.stringify({ m: e.message, d: e.details }).includes(field), field);
      await assert.rejects(service.listRecords("active", { orderBy: `${field}:asc` }, VIEWER), (e) => e.status === 400 && !e.message.includes(field), field);
      await assert.rejects(service.values("active", { field }, VIEWER), (e) => e.status === 400 && !e.message.includes(field), field);
    }
    await assert.rejects(service.listRecords("active", { mobile_phone: "1" }, VIEWER), (e) => e.status === 400 && !e.message.includes("mobile"));
    await assert.rejects(service.listRecords("active", { q: ["a", "b"] }, VIEWER), (e) => e.status === 400);
  });

  test("search, sort and cursors", async () => {
    const { service } = setup({ n: 40 });
    const page = await service.listRecords("all", { q: "PERSON 1", fields: "displayName" }, ADMIN);
    assert.ok(page.items.length && page.items.every((i) => i.values.displayName.toLowerCase().includes("person 1")));
    const byDept = await service.listRecords("all", { q: "dept b", searchField: "department", fields: "department" }, ADMIN);
    assert.ok(byDept.items.length && byDept.items.every((i) => i.values.department === "Dept B"));
    await assert.rejects(service.listRecords("all", { q: "x", searchField: "officeLocation" }, ADMIN), (e) => e.status === 400);
    // orderBy with blanks last, ties by ID; paging through gives every row exactly once in order.
    const ordered = await allIds(service, "all", { orderBy: "department:desc,displayName:asc", fields: "department,displayName" });
    assert.equal(ordered.length, 40);
    assert.equal(new Set(ordered.map((i) => i.id)).size, 40);
    const depts = ordered.map((i) => i.values.department);
    assert.deepEqual(depts.filter(Boolean), [...depts.filter(Boolean)].sort().reverse());
    assert.ok(depts.indexOf(null) > depts.lastIndexOf("Dept A"), "blanks last");
    const natural = await allIds(service, "all", { fields: "displayName" });
    assert.equal(natural[0].values.displayName, "Synthetic Person 1");
    assert.equal(natural[1].values.displayName, "Synthetic Person 2", "numeric collation");
    // A cursor is bound to its list and caller.
    const first = await service.listRecords("all", { limit: "5" }, ADMIN);
    const cursor = first.pagination.nextCursor;
    await assert.rejects(service.listRecords("all", { limit: "5", cursor, q: "x" }, ADMIN), (e) => e.status === 400);
    await assert.rejects(service.listRecords("all", { limit: "5", cursor }, { ...ADMIN, who: "someone-else" }), (e) => e.status === 400);
    await assert.rejects(service.listRecords("disabled", { limit: "5", cursor }, ADMIN), (e) => e.status === 400);
    await assert.rejects(service.listRecords("all", { limit: "5", cursor: `${cursor.slice(0, -2)}AA` }, ADMIN), (e) => e.status === 400);
    await assert.rejects(service.listRecords("all", { limit: "201" }, ADMIN), (e) => e.status === 400);
  });

  test("values: counts over the caller's dataset, blank first, context without the field itself, paging", async () => {
    const { service } = setup({ n: 40 });
    const people = syntheticPeople(40).filter((d) => d.account_enabled && d.user_type === "Member");
    const v = await service.values("active", { field: "department" }, VIEWER);
    assert.equal(v.values[0].value, null);
    assert.equal(v.values[0].blank, true);
    assert.equal(v.values[0].count, people.filter((d) => !d.department).length);
    assert.deepEqual(v.values.slice(1).map((x) => x.value), ["Dept A", "Dept B", "Dept C"]);
    assert.equal(v.values.find((x) => x.value === "Dept A").count, people.filter((d) => d.department === "Dept A").length);
    assert.equal(v.complete, true);
    const ctx = await service.values("active", { field: "department", filter: enc(and({ field: "department", op: "eq", value: "Dept A" }, { field: "jobTitle", op: "eq", value: "Engineer" })) }, VIEWER);
    assert.equal(ctx.contextual, true);
    assert.equal(ctx.values.reduce((s, x) => s + x.count, 0), people.filter((d) => d.job_title === "Engineer").length);
    const p1 = await service.values("active", { field: "department", limit: "2" }, VIEWER);
    assert.equal(p1.values.length, 2); assert.equal(p1.complete, false);
    const p2 = await service.values("active", { field: "department", limit: "2", after: p1.nextAfter }, VIEWER);
    assert.deepEqual(p2.values.map((x) => x.value), ["Dept B", "Dept C"]);
    const q = await service.values("active", { field: "jobTitle", q: "engin" }, VIEWER);
    assert.deepEqual(q.values.map((x) => x.value), ["Engineer"]);
    await assert.rejects(service.values("active", { field: "displayName" }, VIEWER), (e) => e.status === 400 && e.details.reason === "noValueList");
    await assert.rejects(service.values("active", { field: "department", limit: "501" }, VIEWER), (e) => e.status === 400);
    // Values of the active dataset never include guests' or disabled accounts' domains.
    const domains = await service.values("active", { field: "emailDomain" }, VIEWER);
    assert.deepEqual(domains.values.map((x) => x.value), ["example.com"]);
  });
});
