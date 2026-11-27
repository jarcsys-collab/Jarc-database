// B1 (refused save keeps the board) together with T0 (a column-header filter kept with a saved view as columnFilter): the
// unchanged browser model (resource mode) against the real API on the fake MongoDB, refusals injected at fetch.
// A refused save goes back to the last saved state: that state must carry the view's saved columnFilter, and the live
// column filter (view-only state) must stay, so the rows, the filter and "changed / unchanged" are what they were before.
// Synthetic data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startMongoApp, api } = require("./helpers");
const { loadBrowser } = require("./support/browser-model");

const COLUMNS = [{ key: "serial", label: "Name", type: "text", required: true }, { key: "note", label: "Note", type: "text" }];
let app, fault = null;
const call = (method, p, body) => api(app.url, method, p, body);
const fetchImpl = (u, init) => fault?.(String(u), init) || fetch(u, init);
const refuse = (status, code) => () => Promise.resolve(new Response(JSON.stringify({ error: { code, message: "refused" } }), { status, headers: { "Content-Type": "application/json" } }));
const isRecordPatch = (u, init) => init?.method === "PATCH" && u.includes("/records/");
const isBoardPatch = (u, init) => init?.method === "PATCH" && /\/boards\/[^/?]+(\?|$)/.test(u);
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };
const plain = (v) => JSON.parse(JSON.stringify(v));
const NORTH = { key: "note", op: "contains", value: "north" };

async function tab() {
  const browser = loadBrowser();
  const model = browser.newResourceModel({ baseUrl: `${app.url}/api/v1`, fetchImpl, timeoutMs: 5000 });
  await model.init();
  return { model, events: browser.events };
}
const settle = async (model) => { await model.lastSave; await model.storage.queue; };
const loaded = (model, id) => until(() => !["loading", "none"].includes(model.boardLoadState(id).state));
const visibleIds = (model) => model.visibleRows.map((r) => r.id);

before(async () => { app = await startMongoApp(); });
after(async () => { fault = null; await app.close(); });

describe("A refused save while a column-header filter is active in a saved view", () => {
  let ws, board, viewId;
  before(async () => {
    ws = (await call("POST", "/api/v1/workspaces", { name: "Refusals + column filter" })).body.workspace.id;
    board = (await call("POST", `/api/v1/workspaces/${ws}/boards`, { name: "Sites", columns: COLUMNS })).body.board;
    assert.equal((await call("POST", `/api/v1/boards/${board.id}/records/batch`, { records: Array.from({ length: 30 }, (_, i) => ({ values: { serial: `Site ${String(i).padStart(2, "0")}`, note: i % 3 ? "south yard" : "north yard" } })) })).status, 201);
    const saved = (await call("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: board.version, savedViews: [{ name: "North", state: { view: "table", columnFilter: JSON.stringify(NORTH) } }, { name: "Plain", state: { view: "table" } }] })).body.board;
    viewId = saved.savedViews.find((v) => v.name === "North").id;
  });

  async function openNorth() {
    const { model, events } = await tab();
    model.openBoard(board.id, ws); model.save({ op: "updateUserState" }); // a save started before the records arrive (B1's race)
    assert.ok(await loaded(model, board.id)); await settle(model);
    model.applyView(viewId); await settle(model);
    return { model, events };
  }

  test("saved filter, unchanged view: a refused edit keeps all rows, the filter and 'unchanged'; Undo keeps the view's filter", async () => {
    const { model, events } = await openNorth();
    assert.equal(model.rows.length, 30);
    assert.deepEqual(plain(model.columnFilter), NORTH, "the view opens with its column filter");
    const shown = visibleIds(model); assert.equal(shown.length, 10);
    assert.equal(model.viewChanged, false);
    const [row, other] = model.visibleRows;
    fault = (u, init) => isRecordPatch(u, init) ? refuse(400, "VALIDATION_ERROR")() : null;
    try { model.updateCell(row.id, "note", "north refused"); assert.equal(await model.lastSave, false); } finally { fault = null; }
    assert.equal(model.rows.length, 30, "every loaded row is still there");
    assert.equal(model.rows.find((r) => r.id === row.id).note, "north yard", "only the refused value went back");
    assert.deepEqual(plain(model.columnFilter), NORTH, "the column filter is still applied");
    assert.deepEqual(visibleIds(model), shown, "the same filtered rows");
    assert.equal(String(model.activeSavedViewId), String(viewId), "the same view is open");
    assert.equal(typeof model.activeView.columnFilter, "string", "the restored saved state still has the view's columnFilter");
    assert.equal(model.viewChanged, false, "still unchanged (no Save to this view offered)");
    assert.equal(events.filter((e) => e.type === "jarc-rollback").at(-1).detail.code, "VALIDATION_ERROR");
    // A saved edit then Undo: the history snapshot also keeps the view's filter.
    model.updateCell(other.id, "note", "north kept"); assert.equal(await model.lastSave, true);
    model.undo(); assert.equal(await model.lastSave, true);
    assert.equal(model.rows.length, 30);
    assert.equal(typeof model.activeView.columnFilter, "string");
    assert.deepEqual(plain(model.columnFilter), NORTH);
    assert.equal(model.viewChanged, false);
    const stored = (await call("GET", `/api/v1/boards/${board.id}`)).body.board.savedViews.find((v) => v.name === "North");
    assert.deepEqual(JSON.parse(stored.state.columnFilter), NORTH, "the server's view is untouched");
  });

  test("unsaved filter change (view changed): a refused edit keeps the new filter and 'changed'", async () => {
    const { model } = await openNorth();
    const SOUTH = { key: "note", op: "contains", value: "south" };
    model.columnFilter = SOUTH;
    assert.equal(model.viewChanged, true);
    const shown = visibleIds(model); assert.equal(shown.length, 20);
    fault = (u, init) => isRecordPatch(u, init) ? refuse(500, "INTERNAL_ERROR")() : null;
    try { model.updateCell(model.visibleRows[0].id, "note", "south refused"); assert.equal(await model.lastSave, false); } finally { fault = null; }
    assert.equal(model.rows.length, 30);
    assert.deepEqual(plain(model.columnFilter), SOUTH, "the unsaved column filter stays");
    assert.deepEqual(visibleIds(model), shown);
    assert.equal(model.viewChanged, true, "still changed (Save to this view still offered)");
    assert.deepEqual(JSON.parse(model.activeView.columnFilter), NORTH, "the saved view still has its own filter");
  });

  test("Save to this view saves the filter, then a refused edit: the newly saved filter is part of what is restored", async () => {
    const { model } = await openNorth();
    const DONE = { key: "note", op: "equals", value: "south yard" };
    model.columnFilter = DONE; assert.equal(model.saveActiveView(), true); assert.equal(await model.lastSave, true); await settle(model);
    assert.equal(model.viewChanged, false);
    fault = (u, init) => isRecordPatch(u, init) ? refuse(403, "FORBIDDEN")() : null;
    try { model.updateCell(model.visibleRows[0].id, "note", "x"); assert.equal(await model.lastSave, false); } finally { fault = null; }
    assert.equal(model.rows.length, 30);
    assert.deepEqual(JSON.parse(model.activeView.columnFilter), DONE, "persisted snapshot includes the saved columnFilter");
    assert.deepEqual(plain(model.columnFilter), DONE);
    assert.equal(model.viewChanged, false);
    // Put the view back for the other tests.
    model.columnFilter = NORTH; assert.equal(model.saveActiveView(), true); assert.equal(await model.lastSave, true);
  });

  test("a refused Save to this view: the view keeps its old filter, the live filter stays, and the view shows as changed", async () => {
    const { model } = await openNorth();
    const SOUTH = { key: "note", op: "contains", value: "south" };
    model.columnFilter = SOUTH;
    fault = (u, init) => isBoardPatch(u, init) ? refuse(500, "INTERNAL_ERROR")() : null;
    try { assert.equal(model.saveActiveView(), true); assert.equal(await model.lastSave, false); } finally { fault = null; }
    assert.equal(model.rows.length, 30);
    assert.deepEqual(JSON.parse(model.activeView.columnFilter), NORTH, "the view's saved filter went back");
    assert.deepEqual(plain(model.columnFilter), SOUTH, "what the person chose is still applied");
    assert.equal(model.viewChanged, true, "so Save to this view is offered again");
    assert.equal(model.visibleRows.length, 20);
    const stored = (await call("GET", `/api/v1/boards/${board.id}`)).body.board.savedViews.find((v) => v.name === "North");
    assert.deepEqual(JSON.parse(stored.state.columnFilter), NORTH);
  });
});
