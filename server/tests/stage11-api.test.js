// Stage 11 backend: endpoints the frontend's resource mode needs — schema changes that rewrite records (add/duplicate,
// delete, change type, edit options), group delete with move, board move, batch create/update/delete, activity
// reading, record counts — on the in-memory fake MongoDB.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startMongoApp, startApp, api } = require("./helpers");

let app;
const call = (method, path, body, options) => api(app.url, method, path, body, options);
before(async () => { app = await startMongoApp(); });
after(async () => { await app.close(); });

const columns = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "group", label: "Group", type: "group" },
  { key: "status", label: "Status", type: "status", options: ["New", "In Progress", "Done"] },
  { key: "qty", label: "Qty", type: "text" },
  { key: "done", label: "Done", type: "checkbox" }
];
async function setup(name = "Schema") {
  const ws = (await call("POST", "/api/v1/workspaces", { name })).body.workspace;
  const board = (await call("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: `${name} board`, columns })).body.board;
  const [g1, g2] = board.groups;
  const created = await call("POST", `/api/v1/boards/${board.id}/records/batch`, { records: [
    { values: { serial: "A", status: "New", qty: "12" }, groupId: g1.id, position: 1000 },
    { values: { serial: "B", status: "Done", qty: "abc" }, groupId: g2.id, position: 2000 },
    { values: { serial: "C", status: "", qty: "" }, groupId: g1.id, position: 3000 }
  ] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { ws, board, records: created.body.items, g1, g2 };
}
const records = async (boardId) => (await call("GET", `/api/v1/boards/${boardId}/records?limit=200`)).body.items;
const bySerial = (items) => Object.fromEntries(items.map((r) => [r.values.serial, r]));

describe("Batch records", () => {
  test("batch create: one request, all validated, server IDs and versions, in order", async () => {
    const { board, records: created } = await setup("Batch");
    assert.deepEqual(created.map((r) => r.values.serial), ["A", "B", "C"]);
    assert.ok(created.every((r) => /^[0-9a-f]{24}$/.test(r.id) && r.version === 1));
    assert.equal(created[0].values.done, false, "defaults filled like the app");
    const bad = await call("POST", `/api/v1/boards/${board.id}/records/batch`, { records: [{ values: { serial: "ok" } }, { values: { serial: "" } }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /Record 2/);
    assert.equal((await records(board.id)).length, 3, "nothing written when one record is invalid");
    const tooMany = await call("POST", `/api/v1/boards/${board.id}/records/batch`, { records: Array.from({ length: 5001 }, (_, i) => ({ values: { serial: `x${i}` } })) });
    assert.equal(tooMany.status, 400);
  });

  test("batch update: versioned, all-or-nothing on a stale version", async () => {
    const { board, records: [a, b, c] } = await setup("Bulk");
    const ok = await call("PATCH", `/api/v1/boards/${board.id}/records`, { items: [{ id: a.id, expectedVersion: 1, values: { status: "Done" } }, { id: b.id, expectedVersion: 1, position: 500 }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.items.map((r) => r.version), [2, 2]);
    const stale = await call("PATCH", `/api/v1/boards/${board.id}/records`, { items: [{ id: c.id, expectedVersion: 1, values: { status: "Done" } }, { id: a.id, expectedVersion: 1, values: { status: "New" } }] });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.body.error.details.conflicts, [{ id: a.id, currentVersion: 2 }]);
    const now = bySerial(await records(board.id));
    assert.equal(now.C.values.status, "", "C untouched: the whole batch was refused");
    assert.equal(now.A.values.status, "Done");
    const dup = await call("PATCH", `/api/v1/boards/${board.id}/records`, { items: [{ id: c.id, expectedVersion: 1, pinned: true }, { id: c.id, expectedVersion: 1, pinned: false }] });
    assert.equal(dup.status, 400);
    const foreign = await setup("Other");
    const cross = await call("PATCH", `/api/v1/boards/${board.id}/records`, { items: [{ id: foreign.records[0].id, expectedVersion: 1, pinned: true }] });
    assert.equal(cross.status, 404, "records of another board can't be changed through this board");
  });

  test("batch delete: versioned, safe to repeat", async () => {
    const { board, records: [a, b, c] } = await setup("Delete");
    const res = await call("POST", `/api/v1/boards/${board.id}/records/delete`, { records: [{ id: a.id, expectedVersion: 1 }, { id: b.id, expectedVersion: 1 }] });
    assert.deepEqual(res.body, { deleted: 2, alreadyDeleted: 0 });
    const again = await call("POST", `/api/v1/boards/${board.id}/records/delete`, { records: [{ id: a.id, expectedVersion: 1 }] });
    assert.deepEqual(again.body, { deleted: 0, alreadyDeleted: 1 });
    await call("PATCH", `/api/v1/records/${c.id}`, { expectedVersion: 1, pinned: true });
    assert.equal((await call("POST", `/api/v1/boards/${board.id}/records/delete`, { records: [{ id: c.id, expectedVersion: 1 }] })).status, 409);
    assert.equal((await records(board.id)).length, 1);
  });
});

describe("Schema changes that rewrite records", () => {
  test("add column: inserted at the index, existing records filled with the default; duplicate copies values", async () => {
    const { board } = await setup("Add");
    const added = await call("POST", `/api/v1/boards/${board.id}/columns`, { expectedVersion: 1, column: { key: "custom_flag", label: "Flag", type: "checkbox" }, index: 2 });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.board.columns[2].key, "custom_flag");
    assert.ok((await records(board.id)).every((r) => r.values.custom_flag === false && r.version === 2));
    const dup = await call("POST", `/api/v1/boards/${board.id}/columns`, { expectedVersion: 2, column: { key: "qty_copy", label: "Qty copy", type: "text" }, copyFrom: "qty" });
    assert.equal(dup.status, 201);
    assert.deepEqual(Object.values(bySerial(await records(board.id))).map((r) => r.values.qty_copy), ["12", "abc", ""]);
    const groupCopy = await call("POST", `/api/v1/boards/${board.id}/columns`, { expectedVersion: 3, column: { key: "group_copy", label: "Group copy", type: "group" }, copyFrom: "group" });
    assert.equal(groupCopy.status, 201);
    assert.equal(bySerial(await records(board.id)).B.values.group_copy, board.groups[1].name, "a copied group column holds group names");
    assert.equal((await call("POST", `/api/v1/boards/${board.id}/columns`, { expectedVersion: 4, column: { key: "qty", label: "Again", type: "text" } })).status, 400, "duplicate key");
    assert.equal((await call("POST", `/api/v1/boards/${board.id}/columns`, { expectedVersion: 1, column: { key: "x", label: "X", type: "text" } })).status, 409, "stale board version");
  });

  test("delete column: values removed, Item protected, dry run counts only", async () => {
    const { board } = await setup("DelCol");
    const dry = await call("DELETE", `/api/v1/boards/${board.id}/columns/qty?expectedVersion=1&dryRun=true`);
    assert.deepEqual(dry.body, { dryRun: true, affected: 2 });
    assert.equal((await records(board.id))[0].version, 1, "dry run changed nothing");
    const res = await call("DELETE", `/api/v1/boards/${board.id}/columns/qty?expectedVersion=1`);
    assert.equal(res.status, 200);
    assert.ok(!res.body.board.columns.some((c) => c.key === "qty"));
    assert.ok((await records(board.id)).every((r) => !("qty" in r.values)));
    assert.equal((await call("DELETE", `/api/v1/boards/${board.id}/columns/serial?expectedVersion=2`)).status, 400);
    assert.equal((await call("DELETE", `/api/v1/boards/${board.id}/columns/nope?expectedVersion=2`)).status, 404);
    assert.equal((await call("DELETE", `/api/v1/boards/${board.id}/columns/__proto__?expectedVersion=2`)).status, 400);
    const groupGone = await call("DELETE", `/api/v1/boards/${board.id}/columns/group?expectedVersion=2`);
    assert.equal(groupGone.status, 200);
    assert.ok((await records(board.id)).every((r) => r.groupId === null), "deleting the group column clears record groups");
  });

  test("change type: the app's conversion rules; dry run reports values that would be cleared", async () => {
    const { board } = await setup("Type");
    const dry = await call("POST", `/api/v1/boards/${board.id}/columns/qty/type?dryRun=true`, { expectedVersion: 1, type: "number" });
    assert.deepEqual(dry.body, { dryRun: true, affected: 1 });
    const res = await call("POST", `/api/v1/boards/${board.id}/columns/qty/type`, { expectedVersion: 1, type: "number" });
    assert.equal(res.body.affected, 1);
    assert.deepEqual(Object.values(bySerial(await records(board.id))).map((r) => r.values.qty), ["12", "", ""]);
    await call("POST", `/api/v1/boards/${board.id}/columns/status/type`, { expectedVersion: 2, type: "dropdown" });
    const status = (await call("GET", `/api/v1/boards/${board.id}`)).body.board.columns.find((c) => c.key === "status");
    assert.deepEqual(status.options, ["New", "In Progress", "Done"], "a dropdown keeps existing values selectable");
    await call("POST", `/api/v1/boards/${board.id}/columns/done/type`, { expectedVersion: 3, type: "text" });
    assert.ok((await records(board.id)).every((r) => r.values.done === ""), "unticked checkboxes become empty text");
    assert.equal((await call("POST", `/api/v1/boards/${board.id}/columns/group/type`, { expectedVersion: 4, type: "text" })).status, 400, "group type changes are refused");
    assert.equal((await call("POST", `/api/v1/boards/${board.id}/columns/serial/type`, { expectedVersion: 4, type: "number" })).status, 400);
    assert.equal((await call("POST", `/api/v1/boards/${board.id}/columns/qty/type`, { expectedVersion: 4, type: "formula" })).status, 400);
  });

  test("edit options: renames rewrite values, removals clear them; dry run counts removals", async () => {
    const { board } = await setup("Options");
    const items = [{ from: "New", to: "Open" }, { from: "In Progress", to: "In Progress" }, { from: null, to: "Blocked" }];
    assert.deepEqual((await call("PUT", `/api/v1/boards/${board.id}/columns/status/options?dryRun=true`, { expectedVersion: 1, items })).body, { dryRun: true, affected: 1 });
    const res = await call("PUT", `/api/v1/boards/${board.id}/columns/status/options`, { expectedVersion: 1, items });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.board.columns.find((c) => c.key === "status").options, ["Open", "In Progress", "Blocked"]);
    assert.deepEqual(Object.values(bySerial(await records(board.id))).map((r) => r.values.status), ["Open", "", ""]);
    assert.equal((await call("PUT", `/api/v1/boards/${board.id}/columns/qty/options`, { expectedVersion: 2, items })).status, 400, "text columns have no options");
    assert.equal((await call("PUT", `/api/v1/boards/${board.id}/columns/status/options`, { expectedVersion: 2, items: [{ from: "Open", to: " " }] })).status, 400, "keep at least one option");
    assert.equal((await call("PUT", `/api/v1/boards/${board.id}/columns/status/options`, { expectedVersion: 2, items: [{ from: { $ne: 1 }, to: "x" }] })).status, 400);
  });

  test("delete group: its records move to the chosen group in the same transaction", async () => {
    const { board, g1, g2 } = await setup("Groups");
    const res = await call("DELETE", `/api/v1/boards/${board.id}/groups/${g1.id}?expectedVersion=1&moveTo=${g2.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.affected, 2);
    assert.ok(!res.body.board.groups.some((g) => g.id === g1.id));
    assert.ok((await records(board.id)).every((r) => r.groupId === g2.id));
    assert.equal((await call("DELETE", `/api/v1/boards/${board.id}/groups/${g2.id}?expectedVersion=2&moveTo=${g2.id}`)).status, 400);
    assert.equal((await call("DELETE", `/api/v1/boards/${board.id}/groups/not-a-group?expectedVersion=2`)).status, 400);
  });

  test("a failure inside a schema change leaves the board and its records unchanged", async () => {
    const { MongoNetworkError } = require("mongodb");
    const { board } = await setup("Atomic");
    app.fake.failNext({ collection: "records", op: "bulkWrite", error: new MongoNetworkError("reset (fake)") });
    const res = await call("DELETE", `/api/v1/boards/${board.id}/columns/qty?expectedVersion=1`);
    assert.equal(res.status, 503);
    const current = (await call("GET", `/api/v1/boards/${board.id}`)).body.board;
    assert.equal(current.version, 1);
    assert.ok(current.columns.some((c) => c.key === "qty"));
    assert.equal(bySerial(await records(board.id)).A.values.qty, "12");
  });
});

describe("Boards: move, counts, activity, settings", () => {
  test("move board: the board and its records' workspaceId change together", async () => {
    const { board } = await setup("From");
    const target = (await call("POST", "/api/v1/workspaces", { name: "To" })).body.workspace;
    const res = await call("POST", `/api/v1/boards/${board.id}/move`, { expectedVersion: 1, workspaceId: target.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.recordsMoved, 3);
    assert.ok((await records(board.id)).every((r) => r.workspaceId === target.id));
    assert.equal((await call("POST", `/api/v1/boards/${board.id}/move`, { expectedVersion: 2, workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaa" })).status, 404);
  });

  test("board lists include active record counts; nextItemNumber is a board setting", async () => {
    const { ws, board, records: [a] } = await setup("Counts");
    await call("PATCH", `/api/v1/records/${a.id}`, { expectedVersion: 1, archived: true });
    assert.equal((await call("GET", `/api/v1/workspaces/${ws.id}/boards`)).body.items[0].recordCount, 2);
    const patched = await call("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: 1, nextItemNumber: 4 });
    assert.equal(patched.body.board.nextItemNumber, 4);
    assert.equal((await call("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: 2, nextItemNumber: 0 })).status, 400);
  });

  test("activity is readable per board, newest first, and can't be written", async () => {
    const { board, records: [a] } = await setup("History");
    await call("PATCH", `/api/v1/records/${a.id}`, { expectedVersion: 1, values: { status: "Done" } });
    const res = await call("GET", `/api/v1/boards/${board.id}/activity?limit=5`);
    assert.equal(res.status, 200);
    assert.equal(res.body.items[0].action, "record.updated");
    assert.deepEqual(res.body.items[0].changes, [{ field: "values.status", from: "New", to: "Done" }]);
    assert.ok(res.body.items.every((e) => /^[0-9a-f]{24}$/.test(e.id) && !("_id" in e)));
    assert.equal((await call("GET", `/api/v1/boards/${board.id}/activity?limit=500`)).status, 400);
    assert.equal((await call("POST", `/api/v1/boards/${board.id}/activity`, {})).status, 404);
  });

  test("the new endpoints don't exist in production", async () => {
    const prod = await startApp({ environment: "production", enableDevStateApi: false, repository: null, dataLayer: app.dataLayer, enableDevResourceApi: false });
    try {
      for (const [method, path] of [["POST", "/api/v1/boards/aaaaaaaaaaaaaaaaaaaaaaaa/records/batch"], ["PATCH", "/api/v1/boards/aaaaaaaaaaaaaaaaaaaaaaaa/records"], ["POST", "/api/v1/boards/aaaaaaaaaaaaaaaaaaaaaaaa/columns"], ["GET", "/api/v1/boards/aaaaaaaaaaaaaaaaaaaaaaaa/activity"]]) {
        assert.equal((await api(prod.url, method, path, method === "GET" ? undefined : {})).status, 404, `${method} ${path}`);
      }
    } finally { await prod.close(); }
  });
});
