// Quick record creation (New record → a name → Enter): what the server does with a Name-only record. The real app with Entra
// sign-in on the fake MongoDB, configured as in production (ACCESS_POLICY=development_shared, JARC_BETA_OPEN_EDITING), on a
// synthetic board shaped like a large imported one: about a hundred text columns, only the Name required, business identifiers
// kept as plain text columns. Synthetic people, names and data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { COLLECTIONS } = require("../src/db/bootstrap");

const KEY = crypto.randomBytes(32);
// The Name column, business identifiers that are ordinary text (never generated), and 95 other optional text columns.
const IDENTIFIERS = [["col_1", "Unique ID"], ["col_5", "Legacy Product Code"], ["col_6", "ERP Item ID"], ["col_8", "Accounting ID"]];
const COLUMNS = [{ key: "serial", label: "Name", type: "text", required: true },
  ...IDENTIFIERS.map(([key, label]) => ({ key, label, type: "text" })),
  ...Array.from({ length: 95 }, (_, i) => ({ key: `col_${i + 10}`, label: `Field ${i + 10}`, type: "text" }))];

let app, issuer, people, board, ws;
const clients = new Map();
async function as(person, method, url, body) {
  if (!clients.has(person.oid)) { const c = new SessionClient(app.url, app.entra.appOrigin); assert.equal((await c.signIn(person)).status, 201); clients.set(person.oid, c); }
  return clients.get(person.oid).request(method, url, body);
}
const create = (person, body, boardId = board.id) => as(person, "POST", `/api/v1/boards/${boardId}/records`, body);
const code = (res) => res.body?.error?.code;

before(async () => {
  issuer = await createTokenIssuer();
  people = { owner: issuer.person("Board Owner"), employee: issuer.person("Plain Employee"), admin: issuer.person("Token Admin") };
  app = await startEntraApp({ issuer, accessPolicy: "development_shared", betaOpenEditing: true, apiTokens: { key: KEY, adminObjectIds: [people.admin.oid.toLowerCase()] } });
  ws = (await as(people.owner, "POST", "/api/v1/workspaces", { name: "Product Space" })).body.workspace;
  const res = await as(people.owner, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Products", columns: COLUMNS, groups: [{ name: "Incoming" }, { name: "Current" }, { name: "Retired" }] });
  assert.equal(res.status, 201, res.text);
  board = res.body.board;
  // Existing records with their business identifiers, as an import would have left them.
  const rows = Array.from({ length: 30 }, (_, i) => ({ values: { serial: `Existing ${i}`, col_1: `U-${1000 + i}`, col_5: `NP-${i}`, col_6: `ERP${i}`, col_8: `AC-${i}` }, groupId: board.groups[1].id }));
  assert.equal((await as(people.owner, "POST", `/api/v1/boards/${board.id}/records/batch`, { records: rows })).status, 201);
});
after(async () => { await app?.close(); });

describe("A record from its name alone", () => {
  test("any employee creates one with only the Name: the server assigns its ID, timestamps and creator, and leaves the rest empty", async () => {
    const before = Date.now();
    const res = await create(people.employee, { values: { serial: "New Product" }, groupId: board.groups[0].id });
    assert.equal(res.status, 201, res.text);
    const record = res.body.record;
    assert.match(record.id, /^[0-9a-f]{24}$/, "a Record ID made by the server");
    assert.equal(record.values.serial, "New Product");
    assert.equal(record.groupId, board.groups[0].id, "in the chosen group");
    for (const c of COLUMNS.filter((x) => x.key !== "serial")) assert.equal(record.values[c.key], "", `${c.label} starts empty`);
    for (const [key, label] of IDENTIFIERS) assert.equal(record.values[key], "", `${label} is never generated`);
    const stored = await app.db.collection(COLLECTIONS.records).findOne({ _id: new ObjectId(record.id) });
    assert.ok(stored.createdAt.getTime() >= before - 1000 && stored.createdAt.getTime() <= Date.now() + 1000, "server time");
    assert.equal(stored.createdAt.getTime(), stored.updatedAt.getTime());
    assert.equal(stored.createdBy.toHexString(), (await as(people.employee, "GET", "/api/v1/me")).body.user.id, "the signed-in creator");
    // Recorded in the board's Activity History.
    const activity = await app.db.collection(COLLECTIONS.activities).find({ entityId: stored._id, action: "record.created" }).toArray();
    assert.equal(activity.length, 1);
    assert.equal(activity[0].actorName, "Plain Employee");
  });

  test("an empty or whitespace-only Name is refused, and nothing is stored", async () => {
    const before = await app.db.collection(COLLECTIONS.records).countDocuments({});
    for (const serial of ["", "   ", "\t\n "]) {
      const res = await create(people.employee, { values: { serial } });
      assert.equal(res.status, 400, JSON.stringify(serial));
      assert.match(res.body.error.message, /Name is required/);
    }
    assert.equal((await create(people.employee, { values: {} })).status, 400, "no Name at all");
    assert.equal(await app.db.collection(COLLECTIONS.records).countDocuments({}), before);
  });

  test("two records with the same Name are two records with different IDs; meaningful Unicode is kept", async () => {
    const a = (await create(people.employee, { values: { serial: "Pipette 10 µL — Ø 3 mm 📦" } })).body.record;
    const b = (await create(people.owner, { values: { serial: "Pipette 10 µL — Ø 3 mm 📦" } })).body.record;
    assert.notEqual(a.id, b.id);
    assert.equal(a.values.serial, "Pipette 10 µL — Ø 3 mm 📦");
    assert.equal(b.values.serial, a.values.serial);
  });

  test("without a group the record goes where the API always put it (no group), and new records go to the top", async () => {
    const res = await create(people.employee, { values: { serial: "No group given" } });
    assert.equal(res.body.record.groupId, null);
    const top = await app.db.collection(COLLECTIONS.records).find({ boardId: new ObjectId(board.id) }).sort({ position: 1 }).limit(1).toArray();
    assert.equal(top[0]._id.toHexString(), res.body.record.id, "first position: a new record shows at the top");
    assert.equal((await create(people.employee, { values: { serial: "Bad group" }, groupId: "grp_nope" })).status, 400, "a group of another board is refused");
  });

  test("existing records, and their business identifiers, are left exactly as they were", async () => {
    const records = app.db.collection(COLLECTIONS.records);
    const imported = async () => (await records.find({ boardId: new ObjectId(board.id) }).sort({ _id: 1 }).toArray()).filter((r) => r.values.serial.startsWith("Existing "));
    const existing = await imported();
    assert.equal(existing.length, 30);
    for (let i = 0; i < 3; i++) assert.equal((await create(people.employee, { values: { serial: `Quick ${i}` }, groupId: board.groups[1].id })).status, 201);
    assert.deepEqual(await imported(), existing, "IDs, values, positions and versions unchanged");
    assert.ok(existing.every((r) => /^U-\d+$/.test(r.values.col_1) && /^AC-\d+$/.test(r.values.col_8)), "identifiers untouched");
  });
});

describe("Defaults and required columns", () => {
  let configured;
  before(async () => {
    const columns = [{ key: "serial", label: "Name", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["New", "Done"], defaultValue: "New" },
      { key: "region", label: "Region", type: "text", defaultValue: "North" }, { key: "done", label: "Checked", type: "checkbox" }, { key: "notes2", label: "Notes", type: "text" },
      { key: "owner", label: "Owner", type: "owner" }, { key: "sku", label: "Supplier code", type: "text", required: true }, { key: "kind", label: "Kind", type: "text", required: true, defaultValue: "Standard" }];
    configured = (await as(people.owner, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Configured", columns })).body.board;
  });

  test("configured defaults are applied and other optional columns start empty", async () => {
    const res = await create(people.employee, { values: { serial: "With defaults", sku: "S-1" } }, configured.id);
    assert.equal(res.status, 201, res.text);
    const v = res.body.record.values;
    assert.deepEqual([v.status, v.region, v.done, v.notes2, v.owner, v.kind], ["New", "North", false, "", [], "Standard"]);
  });

  test("a required column without a default is still required: the rule is kept, and naming it is enough", async () => {
    const refused = await create(people.employee, { values: { serial: "Missing code" } }, configured.id);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /Supplier code is required/);
    assert.equal(code(refused), "VALIDATION_ERROR");
    const blank = await create(people.employee, { values: { serial: "Blank code", sku: "  " } }, configured.id);
    assert.equal(blank.status, 400, "whitespace doesn't count");
    assert.equal((await create(people.employee, { values: { serial: "Has code", sku: "S-2" } }, configured.id)).status, 201);
  });
});

describe("After creating", () => {
  test("the new record can be edited at once, and appears in the board's reads and in an authorised API token read", async () => {
    const record = (await create(people.employee, { values: { serial: "Edit me later" }, groupId: board.groups[1].id })).body.record;
    const edited = await as(people.employee, "PATCH", `/api/v1/records/${record.id}`, { expectedVersion: record.version, values: { col_6: "ERP-NEW", col_20: "Box of 10" } });
    assert.equal(edited.status, 200, edited.text);
    assert.deepEqual([edited.body.record.values.col_6, edited.body.record.values.col_20, edited.body.record.values.serial], ["ERP-NEW", "Box of 10", "Edit me later"]);
    const listed = (await as(people.owner, "GET", `/api/v1/boards/${board.id}/records?limit=200`)).body.items;
    assert.ok(listed.some((r) => r.id === record.id), "listed for another employee");
    // A token issued by the API administrator for this board reads it, with no setup.
    const issued = await as(people.admin, "POST", "/api/v1/me/api-tokens", { name: "Reporting", workspaceId: ws.id, boardIds: [board.id], scopes: ["read"], expiresAt: new Date(Date.now() + 86400000 * 7).toISOString() });
    assert.equal(issued.status, 201, issued.text);
    const read = await fetch(`${app.url}/api/v1/external/records/${record.id}`, { headers: { Authorization: `Bearer ${issued.body.secret}` } });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).record.values.col_6, "ERP-NEW");
  });

  test("API administration stays with the API administrators: an employee who creates records still can't manage tokens", async () => {
    for (const p of [people.employee, people.owner]) assert.equal(code(await as(p, "GET", "/api/v1/me/api-tokens")), "API_ADMIN_REQUIRED", p.name);
    assert.equal((await as(people.admin, "GET", "/api/v1/me/api-tokens")).status, 200);
  });
});
