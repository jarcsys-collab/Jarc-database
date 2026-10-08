// Stage 10 migration: legacy state document / browser backup → MongoDB.
//
// The input is produced by the real, unchanged frontend: site/assets/BoardModel.js and StorageService.js run in an
// isolated context, build representative data through their normal methods (boards, flexible columns, groups,
// records, saved views, activity), and the test takes exactly what the browser would store (schemaVersion 1) and
// what "Export full backup" would download (backup version 11).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { MongoNetworkError } = require("mongodb");
const { startMongoApp, api } = require("./helpers");
const { buildImportPlan, validateLegacyInput } = require("../src/migration/legacy-import");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");

async function legacyDataFromFrontend() {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } };
  const window = { location: { search: "" }, localStorage: storage, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, dispatchEvent() {}, addEventListener() {} };
  const context = vm.createContext({ window, console, URLSearchParams, crypto: globalThis.crypto, CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }, setTimeout, clearTimeout, structuredClone });
  for (const file of ["StorageService.js", "BoardModel.js"]) vm.runInContext(fs.readFileSync(path.join(ASSETS, file), "utf8"), context, { filename: file });
  const model = new window.BoardModel(window.jarcStorage);
  await model.init();

  // Representative board, built with the app's own operations.
  model.createBoard("Repairs", "Field repairs", "inventory"); // columns incl. group, owner, status; groups New/Working/Done
  const cost = model.addColumn({ label: "Cost", type: "number" });
  const done = model.addColumn({ label: "Checked", type: "checkbox" });
  model.renameColumn(cost.key, "Cost (PHP)"); // label changes, key doesn't
  model.addGroup("Escalated");
  const a = model.upsert({ serial: "SN-1001", status: "In Progress", group: "Working", owner: "AV", dueDate: "2026-10-09", [cost.key]: "1250.50", [done.key]: true });
  const b = model.upsert({ serial: "SN-1002", status: "New", group: "Escalated", notes: "Needs parts" });
  model.upsert({ serial: "SN-1003", status: "Done", group: "" });
  model.updateCell(a.id, "status", "Done");
  model.updateCell(b.id, "group", "Ghost group"); // a name that isn't in the board's group list
  model.saveView("Open items");
  model.quickAdd();
  model.createBoard("Blank board");
  model.upsert({ serial: "Only item" });
  await model.whenSaved();

  const state = JSON.parse(store.get("jarc-database-data"));
  return { state, backup: model.createBackup(), model, ids: { cost: cost.key, done: done.key, a: a.id, b: b.id } };
}

let legacy, app;
before(async () => { legacy = await legacyDataFromFrontend(); app = await startMongoApp(); });
after(async () => { await app.close(); });
const importNow = (body, query = "") => api(app.url, "POST", `/api/v1/imports${query}`, body);
const all = (name) => app.db.collection(name).find({}).toArray();
const totals = (state) => ({ workspaces: state.workspaces.length, boards: state.workspaces.flatMap((w) => w.boards).length, records: state.workspaces.flatMap((w) => w.boards).flatMap((b) => b.records).length });

describe("Migration transform (pure)", () => {
  test("the frontend produced a schemaVersion 1 document and a version 11 backup", () => {
    assert.equal(legacy.state.schemaVersion, 1);
    assert.equal(legacy.backup.version, 11);
    assert.equal(validateLegacyInput(legacy.state), "state-v1");
    assert.equal(validateLegacyInput(legacy.backup), "backup-v11");
  });

  test("counts, legacy IDs, column keys, values and relationships", () => {
    const plan = buildImportPlan(legacy.state, { actorId: app.devActor._id });
    const expected = totals(legacy.state);
    assert.deepEqual([plan.report.counts.workspaces, plan.report.counts.boards, plan.report.counts.records], [expected.workspaces, expected.boards, expected.records]);
    assert.deepEqual(plan.workspaces.map((w) => w.legacyId), legacy.state.workspaces.map((w) => w.id));
    const repairsLegacy = legacy.state.workspaces.flatMap((w) => w.boards).find((b) => b.name === "Repairs");
    const repairs = plan.boards.find((b) => b.legacyId === repairsLegacy.id);
    assert.deepEqual(repairs.columns.map((c) => c.key), repairsLegacy.columns.map((c) => c.key), "column keys and order preserved");
    assert.equal(repairs.columns.find((c) => c.key === legacy.ids.cost).label, "Cost (PHP)");
    for (const legacyRecord of repairsLegacy.records) {
      const doc = plan.records.find((r) => r.boardId === repairs._id && r.legacyId === legacyRecord.id);
      assert.ok(doc, `record ${legacyRecord.id} migrated`);
      const { id, archived, pinned, createdAt, updatedAt, activity, group, ...values } = legacyRecord;
      assert.deepEqual(doc.values, values, "flexible values preserved exactly (group moves to groupId)");
      assert.equal(doc.workspaceId, repairs.workspaceId, "record.workspaceId = its board's workspaceId");
      assert.ok(doc.createdAt instanceof Date && doc.updatedAt instanceof Date);
    }
    for (const b of plan.boards) assert.ok(plan.workspaces.some((w) => w._id === b.workspaceId));
    assert.equal(plan.records.find((r) => r.legacyId === legacy.ids.a).values[legacy.ids.cost], "1250.50");
    assert.equal(plan.records.find((r) => r.legacyId === legacy.ids.a).values[legacy.ids.done], true);
  });

  test("groups: names become stable IDs, records map by name, unknown names are added and reported, empty → null", () => {
    const plan = buildImportPlan(legacy.state, { actorId: app.devActor._id });
    const repairs = plan.boards.find((b) => b.name === "Repairs");
    assert.deepEqual(repairs.groups.map((g) => g.name), ["New", "Working", "Done", "Escalated", "Ghost group"]);
    assert.ok(repairs.groups.every((g) => /^grp_[A-Za-z0-9]{10}$/.test(g.id)));
    const byName = Object.fromEntries(repairs.groups.map((g) => [g.name, g.id]));
    const recordFor = (serial) => plan.records.find((r) => r.boardId === repairs._id && r.values.serial === serial);
    assert.equal(recordFor("SN-1001").groupId, byName.Working);
    assert.equal(recordFor("SN-1002").groupId, byName["Ghost group"]);
    assert.equal(recordFor("SN-1003").groupId, null);
    assert.ok(plan.report.warnings.some((w) => /Ghost group/.test(w)));
  });

  test("saved views, activity, memberships and skipped per-user data", () => {
    const plan = buildImportPlan(legacy.state, { actorId: app.devActor._id });
    const repairs = plan.boards.find((b) => b.name === "Repairs");
    assert.equal(repairs.savedViews.length, 1);
    assert.equal(repairs.savedViews[0].name, "Open items");
    assert.equal(typeof repairs.savedViews[0].legacyId, "number");
    assert.ok(repairs.savedViews[0].state.visibleColumns.includes(legacy.ids.cost));
    assert.ok(plan.activities.some((a) => a.action === "legacy.board.activity" && a.boardId === repairs._id));
    assert.ok(plan.activities.some((a) => a.action === "legacy.record.activity" && a.entityType === "record"));
    assert.equal(plan.memberships.length, plan.workspaces.length);
    assert.ok(plan.memberships.every((m) => m.role === "WORKSPACE_ADMIN" && m.userId.equals(app.devActor._id)));
    assert.ok(plan.report.skipped.perUserFields.includes("settings"));
    assert.equal(plan.report.skipped.localContacts, legacy.state.members.length);
    assert.ok(plan.workspaces.every((w) => w.createdBy === null), "unknown legacy creators are not invented");
  });

  test("a backup file and the state document migrate to the same structure", () => {
    const fromState = buildImportPlan(legacy.state, { actorId: app.devActor._id }).report.counts;
    const fromBackup = buildImportPlan(legacy.backup, { actorId: app.devActor._id }).report.counts;
    assert.deepEqual(fromBackup, fromState);
  });

  test("validation: duplicate legacy IDs, malformed records and bad structure are rejected with every problem listed", () => {
    const clone = () => JSON.parse(JSON.stringify(legacy.state));
    const dupWorkspace = clone(); dupWorkspace.workspaces[1].id = dupWorkspace.workspaces[0].id;
    const dupBoard = clone(); dupBoard.workspaces[0].boards[1].id = dupBoard.workspaces[0].boards[0].id;
    const dupRecord = clone(); const recs = dupRecord.workspaces[0].boards.find((b) => b.records.length > 1).records; recs[1].id = recs[0].id;
    const nested = clone(); nested.workspaces[0].boards.find((b) => b.records.length).records[0].notes = { $gt: "" };
    const badKey = clone(); badKey.workspaces[0].boards.find((b) => b.records.length).records[0]["bad key"] = 1;
    const noRecords = clone(); delete noRecords.workspaces[0].boards[0].records;
    const badColumn = clone(); badColumn.workspaces[0].boards.find((b) => b.columns).columns.push({ key: "x", label: "X", type: "formula" });
    const cases = [[dupWorkspace, /duplicate legacy ID/], [dupBoard, /duplicate legacy ID/], [dupRecord, /duplicate legacy ID/], [nested, /not allowed|nested/], [badKey, /can't be stored/], [noRecords, /record list/], [badColumn, /unsupported type/], [{ schemaVersion: 2, workspaces: [] }, /schemaVersion 1/], [{ version: 99, workspaces: [] }, /unsupported version/], ["text", /not a JARC/], [{ workspaces: [] }, /no workspaces/]];
    for (const [input, pattern] of cases) {
      assert.throws(() => buildImportPlan(input, { actorId: app.devActor._id }), (e) => e.status === 400 && e.code === "VALIDATION_ERROR" && pattern.test(JSON.stringify(e.details?.errors ?? e.message)), String(pattern));
    }
    const many = clone(); many.workspaces[1].id = many.workspaces[0].id; many.workspaces[0].boards[1].id = many.workspaces[0].boards[0].id;
    assert.throws(() => buildImportPlan(many, { actorId: app.devActor._id }), (e) => e.details.errors.length >= 2);
  });
});

describe("Migration import into MongoDB", () => {
  test("dry run: report with counts before committing, nothing written", async () => {
    const res = await importNow(legacy.state, "?dryRun=true");
    assert.equal(res.status, 200);
    assert.equal(res.body.dryRun, true);
    assert.deepEqual([res.body.report.counts.workspaces, res.body.report.counts.boards, res.body.report.counts.records], Object.values(totals(legacy.state)));
    for (const name of ["workspaces", "boards", "records", "activities", "workspaceMembers"]) assert.equal((await all(name)).length, 0, name);
  });

  test("ROLLBACK: a failure part-way through leaves the database unchanged", async () => {
    app.fake.failNext({ collection: "records", op: "insertMany", error: new MongoNetworkError("connection reset (fake)") });
    const res = await importNow(legacy.state);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "SERVICE_UNAVAILABLE");
    for (const name of ["workspaces", "boards", "records", "activities", "workspaceMembers"]) assert.equal((await all(name)).length, 0, `${name} empty after rollback`);
  });

  test("commit: everything stored with relationships, legacy IDs, group mapping and real dates", async () => {
    const res = await importNow(legacy.state);
    assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 300));
    const expected = totals(legacy.state);
    const [workspaces, boards, records, members] = await Promise.all(["workspaces", "boards", "records", "workspaceMembers"].map(all));
    assert.deepEqual([workspaces.length, boards.length, records.length], [expected.workspaces, expected.boards, expected.records]);
    assert.equal(members.length, expected.workspaces);
    assert.deepEqual(workspaces.map((w) => w.legacyId).sort(), legacy.state.workspaces.map((w) => w.id).sort());
    for (const r of records) {
      const parent = boards.find((b) => b._id.equals(r.boardId));
      assert.ok(parent && parent.workspaceId.equals(r.workspaceId));
      if (r.groupId) assert.ok(parent.groups.some((g) => g.id === r.groupId), "groupId points at a group of its board");
    }
    // Readable through the resource API with the same IDs representation.
    const repairs = boards.find((b) => b.name === "Repairs");
    const page = await api(app.url, "GET", `/api/v1/boards/${repairs._id.toHexString()}/records?limit=200`);
    assert.equal(page.body.items.length, legacy.state.workspaces.flatMap((w) => w.boards).find((b) => b.name === "Repairs").records.length);
    assert.ok(page.body.items.some((r) => r.legacyId === legacy.ids.a));
  });

  test("IDEMPOTENT: importing the same data again → 409 already imported, no duplicates", async () => {
    const before = await Promise.all(["workspaces", "boards", "records", "activities"].map(async (n) => (await all(n)).length));
    for (const input of [legacy.state, legacy.backup]) {
      const res = await importNow(input);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "CONFLICT");
      assert.deepEqual(res.body.error.details.alreadyImported.sort(), legacy.state.workspaces.map((w) => w.id).sort());
      assert.equal((await importNow(input, "?dryRun=true")).status, 409, "a dry run reports it too");
    }
    const afterCounts = await Promise.all(["workspaces", "boards", "records", "activities"].map(async (n) => (await all(n)).length));
    assert.deepEqual(afterCounts, before);
  });

  test("a partly-imported set is refused as a whole (no partial import)", async () => {
    const mixed = JSON.parse(JSON.stringify(legacy.backup));
    mixed.workspaces.push({ id: "brand-new", name: "Brand new", boards: [] });
    const res = await importNow(mixed);
    assert.equal(res.status, 409);
    assert.equal(await app.db.collection("workspaces").countDocuments({ legacyId: "brand-new" }), 0);
  });

  test("the import endpoint validates its input and query", async () => {
    assert.equal((await importNow({ workspaces: "nope" })).status, 400);
    assert.equal((await importNow(legacy.state, "?dryRun=maybe")).status, 400);
    assert.equal((await importNow(legacy.state, "?force=true")).status, 400);
    const proto = await api(app.url, "POST", "/api/v1/imports", '{"schemaVersion":1,"workspaces":[{"id":"x","name":"X","boards":[]}],"__proto__":{"admin":true}}', { raw: true });
    assert.equal(proto.status, 400);
  });
});
