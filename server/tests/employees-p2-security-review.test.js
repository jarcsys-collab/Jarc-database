// Employee Management P2: independent security review probes (service level, no HTTP, no network). Synthetic people only
// ("Synthetic Person N", @example.com), invented IDs. Tests named FIXED reproduce a review finding that has been fixed.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { Access } = require("../src/auth/access");
const { createEmployees, JarcAccessIndex, profileId } = require("../src/employees");
const { phoneLike, JARC_FIELD_NAMES } = require("../src/employees/fields");
const fm = require("../src/fabric/filter-model");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const TENANT = "00000000-0000-4000-8000-00000000a001";
const silent = { info() {}, warn() {}, error() {} };
const ADMIN = { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"], who: "u-admin", jarcAccess: true };
const VIEWER = { view: true, admin: false, datasets: ["active"], who: "u-viewer" };
const and = (...items) => ({ v: 1, op: "and", items });
const enc = (model) => fm.encodeFilterParam(model);
const HOUR = 3600 * 1000;

async function world({ longNames = false } = {}) {
  const t = Date.UTC(2026, 10, 26, 9, 0, 0);
  const people = syntheticPeople(8, { seed: "review" });
  people.forEach((d) => { d.account_enabled = true; d.user_type = "Member"; d.office_location = "Office 1"; });
  const ws = Array.from({ length: 4 }, (_, i) => ({ _id: new ObjectId(), name: longNames ? `Synthetic workspace ${i} ${"x".repeat(150)}` : `WS ${i}` }));
  const users = people.slice(0, 6).map((p, i) => ({ _id: new ObjectId(), source: "entra", tenantId: TENANT, entraObjectId: p.user_id.toLowerCase(), status: i === 5 ? "disabled" : "active", createdAt: new Date(t - 10 * HOUR), lastLoginAt: new Date(t - HOUR) }));
  // u0: all four workspaces; u1: two; u2: one; u3: none; u4: one invited; u5 disabled with one membership.
  const m = (w, u, role = "MEMBER", status = "active") => ({ workspaceId: w._id, userId: u._id, role, status, createdAt: new Date(t - HOUR) });
  const memberships = [...ws.map((w) => m(w, users[0])), m(ws[0], users[1]), m(ws[1], users[1], "VIEWER"), m(ws[2], users[2], "WORKSPACE_ADMIN"), m(ws[3], users[4], "MEMBER", "invited"), m(ws[0], users[5])];
  const calls = { n: 0 };
  const read = (rows) => async () => { calls.n += 1; return rows; };
  const repos = { users: { listEntraForAccessIndex: read(users) }, memberships: { listForAccessIndex: read(memberships) }, workspaces: { listForAccessIndex: read(ws) }, boards: { listForAccessIndex: read([]) }, sessions: { listLiveForAccessIndex: read([]) } };
  const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: TENANT, viewerObjectIds: [], adminObjectIds: [] }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
  const employees = createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs: people }), idKey: TEST_ID_KEY, now: () => t, logger: silent });
  const index = new JarcAccessIndex({ repos, access: new Access(repos, {}), tenantId: TENANT, employeesConfig: config, now: () => t, logger: silent });
  const snap = await employees.snapshot.current();
  return { service: employees.service, index, calls, snap, idOf: (i) => profileId(TEST_ID_KEY, people[i].user_id) };
}

describe("viewer isolation", () => {
  test("viewer requests never touch the JARC access index (no timing or load side channel)", async () => {
    const w = await world();
    await w.service.status({}, VIEWER, w.index);
    await w.service.listRecords("active", { limit: "200" }, VIEWER, w.index);
    await w.service.getRecord("active", w.idOf(0), {}, VIEWER, w.index);
    await w.service.values("active", { field: "department" }, VIEWER, w.index);
    assert.equal(w.calls.n, 0);
  });

  test("an admin's cursor (default and JARC sorts) is refused for a viewer, without naming anything", async () => {
    const w = await world();
    const page = await w.service.listRecords("active", { limit: "2" }, ADMIN, w.index);
    assert.ok(page.pagination.nextCursor);
    await assert.rejects(w.service.listRecords("active", { limit: "2", cursor: page.pagination.nextCursor }, VIEWER, w.index), (e) => e.status === 400 && !/jarc/i.test(e.message));
    const jarcPage = await w.service.listRecords("active", { limit: "2", orderBy: "jarcMemberships:desc" }, ADMIN, w.index);
    await assert.rejects(w.service.listRecords("active", { limit: "2", orderBy: "jarcMemberships:desc", cursor: jarcPage.pagination.nextCursor }, VIEWER, w.index), (e) => e.status === 400 && !/jarc/i.test(e.message));
  });

  test("the access endpoint answers a viewer the same 403 for a real and an unknown ID (no existence oracle)", async () => {
    const w = await world();
    const codes = [];
    for (const id of [w.idOf(0), "Q".repeat(22), "bad"]) await w.service.jarcAccessOf("active", id, {}, VIEWER, w.index).catch((e) => codes.push(`${e.status} ${e.code}`));
    assert.deepEqual(codes, ["403 EMPLOYEES_FORBIDDEN", "403 EMPLOYEES_FORBIDDEN", "403 EMPLOYEES_FORBIDDEN"]);
  });

  test("every JARC field in fields / filter / orderBy / values is the same generic 400 for a viewer", async () => {
    const w = await world();
    for (const f of JARC_FIELD_NAMES) {
      const tries = [
        () => w.service.listRecords("active", { fields: `displayName,${f}` }, VIEWER, w.index),
        () => w.service.listRecords("active", { filter: enc(and({ field: f, op: "blank" })) }, VIEWER, w.index),
        () => w.service.listRecords("active", { orderBy: `${f}:asc` }, VIEWER, w.index),
        () => w.service.values("active", { field: f }, VIEWER, w.index)
      ];
      for (const fn of tries) await assert.rejects(fn(), (e) => e.status === 400 && !e.message.includes(f) && !JSON.stringify(e.details || {}).includes(f), f);
    }
  });
});

describe("admin P2 robustness", () => {
  test("number and bool JARC fields have no value list (400, never a 500)", async () => {
    const w = await world();
    for (const f of ["jarcMemberships", "jarcSignedInNow", "jarcDisabledWithAccess", "jarcRegistered"]) {
      await assert.rejects(w.service.values("all", { field: f }, ADMIN, w.index), (e) => e.status === 400, f);
    }
  });

  test("text operators on the multi-valued field are refused (category), so no array reaches toLowerCase", async () => {
    const w = await world();
    await assert.rejects(w.service.listRecords("all", { filter: enc(and({ field: "jarcWorkspaces", op: "contains", value: "WS" })) }, ADMIN, w.index), (e) => e.status === 400);
    const names = async (cond) => (await w.service.listRecords("all", { fields: "displayName", filter: enc(and(cond)), limit: "200" }, ADMIN, w.index)).items.length;
    assert.equal(await names({ field: "jarcWorkspaces", op: "eq", value: "WS 0" }), 3, "u0, u1 and disabled u5 (memberOf ignores usability)");
    assert.equal(await names({ field: "jarcWorkspaces", op: "nin", values: ["WS 0"] }), 5);
  });

  test("ordering by jarcWorkspaces pages through everyone with short names", async () => {
    const w = await world();
    const seen = [];
    let cursor = null;
    do { const p = await w.service.listRecords("all", { orderBy: "jarcWorkspaces:asc", limit: "2", ...(cursor ? { cursor } : {}) }, ADMIN, w.index); seen.push(...p.items.map((x) => x.id)); cursor = p.pagination.nextCursor; } while (cursor);
    assert.equal(new Set(seen).size, 8);
  });

  test("FIXED (finding 3): a joined jarcWorkspaces value over 400 characters still pages (list keys may be longer, within CURSOR_MAX)", async () => {
    const w = await world({ longNames: true });
    const p1 = await w.service.listRecords("all", { orderBy: "jarcWorkspaces:desc", limit: "2" }, ADMIN, w.index);
    assert.ok(p1.pagination.nextCursor, "a cursor was issued");
    const seen = new Set(p1.items.map((x) => x.id));
    let cursor = p1.pagination.nextCursor;
    while (cursor) { const p = await w.service.listRecords("all", { orderBy: "jarcWorkspaces:desc", limit: "2", cursor }, ADMIN, w.index); p.items.forEach((x) => seen.add(x.id)); cursor = p.pagination.nextCursor; }
    assert.equal(seen.size, 8);
  });

  test("FIXED (finding 5): a JARC-disabled user is JARC administrator 'No'", async () => {
    const w = await world();
    const row = w.index.joined(w.snap, await w.index.current()).byId.get(w.idOf(5)).values;
    assert.equal(row.jarcAdmin, "No");
  });

  test("detail bodies carry no ObjectId hex, object ID or tenant ID", async () => {
    const w = await world();
    for (let i = 0; i < 8; i += 1) {
      const text = JSON.stringify(await w.service.jarcAccessOf("all", w.idOf(i), {}, ADMIN, w.index));
      assert.ok(!/[0-9a-f]{24}/i.test(text), `p${i}: ObjectId-like hex`);
      assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text), `p${i}: GUID`);
    }
  });
});

describe("office privacy (phone-like office values)", () => {
  test("common phone formats are withheld", () => {
    for (const t of ["9999-9999", "9999 9999", "+852 9999 9999", "(852) 9999 9999", "9999.9999", "+85299999999"]) assert.equal(phoneLike(t), true, t);
    for (const t of ["Head Office", "B-204", "Room 3.14", "Level 12"]) assert.equal(phoneLike(t), false, t);
  });
  test("FIXED (finding 1): phones written with '/', '_', ',', an en dash or full-width digits are withheld", () => {
    for (const t of ["9999/9999", "9999_9999", "9999,9999", "9999–9999", "９９９９９９９９"]) assert.equal(phoneLike(t), true, t);
  });
});
