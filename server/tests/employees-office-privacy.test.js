// Employee Management P2 §6, office privacy: a phone-like office value becomes null at snapshot build (fields.js normalize), so
// it never reaches records, profiles, q search, filters, groups or value lists, and only the count is logged. Synthetic values
// and people only (the read-only fake source).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { createEmployees, profileId } = require("../src/employees");
const { normalize, phoneLike } = require("../src/employees/fields");
const fm = require("../src/fabric/filter-model");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const TENANT = "00000000-0000-4000-8000-00000000a001";
const ADMIN = { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"], who: "u-admin" };
const HIDDEN = ["9999-9999", "+63 2 8888 1234", "(02) 8123-4567"];
const KEPT = ["Head Office", "B-204", "Room 3.14", "Level 12", "Warehouse 1", "Bldg 2, Floor 10", "Unit 12/14"];
// Every separator style (security review finding 1): any non-letter run, or a lone x / ext, between digit groups; full-width
// digits (NFKC).
const MORE_HIDDEN = ["9999/9999", "9999_9999", "9999,9999", "9999–9999", "9999—9999", "9999 x 9999", "9999 ext 9999", "9999 ext. 999", "9999x999", "９９９９９９９９", "９９９９－９９９９", "Tel: 9999 9999", "Office (9999 9999)", "+852 9999 9999", "9999.9999", "+85299999999", "99 99 99 9"];
const MORE_KEPT = ["Office 9999 Floor 999", "Room 12 x Level 3", "Tower 1234 Extension 567", "Next 123 to 4567", "Unit 1/2/3", "Gate 123456"];
// The documented false positives: hidden although they aren't phones.
const FALSE_POSITIVES = ["2024-0001", "1234567", "2024-01-15", "15/01/2024", "Unit 1200/345", "12-34-567", "Rooms 101, 102, 103"];
const and = (...items) => ({ v: 1, op: "and", items });

function setup() {
  const docs = syntheticPeople(HIDDEN.length + KEPT.length);
  [...HIDDEN, ...KEPT].forEach((office, i) => { docs[i].office_location = office; docs[i].account_enabled = true; docs[i].user_type = "Member"; });
  const logs = [];
  const logger = { info: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: TENANT, viewerObjectIds: [], adminObjectIds: [] }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
  const employees = createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs }), idKey: TEST_ID_KEY, logger });
  return { docs, logs, service: employees.service };
}

describe("phone-like office values", () => {
  test("hidden: phone numbers; kept: names and room codes", () => {
    for (const v of [...HIDDEN, ...MORE_HIDDEN, ...FALSE_POSITIVES]) assert.equal(phoneLike(v), true, v);
    for (const v of [...KEPT, ...MORE_KEPT]) assert.equal(phoneLike(v), false, v);
    const base = syntheticPeople(1)[0];
    for (const v of HIDDEN) { const n = normalize({ ...base, office_location: v }); assert.equal(n.values.officeLocation, null, v); assert.equal(n.officeWithheld, true); }
    for (const v of KEPT) { const n = normalize({ ...base, office_location: v }); assert.equal(n.values.officeLocation, v, v); assert.equal(n.officeWithheld, false); }
    assert.equal(normalize({ ...base, office_location: "" }).officeWithheld, false, "a blank office isn't counted as withheld");
  });

  test("the hidden value never appears in records, profiles, search, filters, values or groups; only the count is logged", async () => {
    const { docs, logs, service } = setup();
    const records = await service.listRecords("all", { fields: "displayName,officeLocation", limit: "200" }, ADMIN);
    const text = JSON.stringify(records);
    for (const v of HIDDEN) assert.ok(!text.includes(v), v);
    for (const v of KEPT) assert.ok(text.includes(JSON.stringify(v)), v);
    for (let i = 0; i < HIDDEN.length; i += 1) {
      const id = profileId(TEST_ID_KEY, docs[i].user_id);
      assert.equal(records.items.find((r) => r.id === id).values.officeLocation, null);
      const profile = await service.getRecord("all", id, {}, ADMIN);
      assert.equal(profile.values.officeLocation, null);
      assert.ok(!JSON.stringify(profile).includes(HIDDEN[i]));
    }
    for (const v of HIDDEN) {
      for (const q of [v, v.slice(-4)]) {
        const found = await service.listRecords("all", { q, fields: "officeLocation", limit: "200" }, ADMIN);
        assert.ok(!JSON.stringify(found).includes(v), `q ${q}`);
      }
      for (const cond of [{ field: "officeLocation", op: "eq", value: v }, { field: "officeLocation", op: "contains", value: v }, { field: "officeLocation", op: "contains", value: v.slice(-4) }]) {
        const r = await service.listRecords("all", { filter: fm.encodeFilterParam(and(cond)), limit: "200" }, ADMIN);
        assert.equal(r.items.length, 0, `${cond.op} ${cond.value}`);
      }
    }
    const values = await service.values("all", { field: "officeLocation", limit: "500" }, ADMIN);
    const vtext = JSON.stringify(values);
    for (const v of HIDDEN) assert.ok(!vtext.includes(v), v);
    const blank = values.values.find((x) => x.blank);
    const blanks = (await service.listRecords("all", { filter: fm.encodeFilterParam(and({ field: "officeLocation", op: "blank" })), limit: "200" }, ADMIN)).items.length;
    assert.equal(blank.count, blanks, "the withheld values are in the blank (Unassigned) bucket");
    assert.ok(blanks >= HIDDEN.length);
    // Groups (the directory's office grouping reads the same value list on the active dataset).
    const groups = await service.values("active", { field: "officeLocation", limit: "500" }, { ...ADMIN });
    for (const v of HIDDEN) assert.ok(!JSON.stringify(groups).includes(v));
    assert.ok(logs.includes(`[employees] office values withheld: ${HIDDEN.length}`), logs.join("\n"));
    for (const v of HIDDEN) assert.ok(!logs.join("\n").includes(v));
  });
});
