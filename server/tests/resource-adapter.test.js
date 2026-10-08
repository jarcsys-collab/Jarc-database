// Stage 11 frontend resource mode: the unchanged browser BoardModel + StorageService + ResourceApiAdapter, driven in
// Node against the real Express resource API (fake MongoDB). Each "tab" is a separate model with its own adapter;
// a "refresh" is a new model loading from the server.
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoNetworkError } = require("mongodb");
const { startMongoApp, api } = require("./helpers");
const { loadBrowser } = require("./support/browser-model");

let app, requests;
// Values created inside the browser context have that context's prototypes; compare plain JSON copies.
const plain = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const same = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);
const call = (method, path, body) => api(app.url, method, path, body);
// Every request the adapter sends, as "METHOD /path".
const counting = () => (url, init = {}) => { requests.push(`${init.method || "GET"} ${new URL(url).pathname}`); return fetch(url, init); };
async function tab({ fresh = true } = {}) {
  const browser = loadBrowser();
  const model = browser.newResourceModel({ baseUrl: `${app.url}/api/v1`, fetchImpl: counting() });
  await model.init();
  return Object.assign(model, { browser, fresh });
}
const settle = async (model) => { await model.whenSaved(); await model.storage.queue; };
const boardStatus = async (model, boardId = model.board.id) => { for (let i = 0; i < 100 && ["loading", "none"].includes(model.boardLoadState(boardId).state); i += 1) await new Promise((r) => setTimeout(r, 10)); return model.boardLoadState(boardId); };
async function newBoard(model, name = "Stage11 Test Board", template = "inventory") {
  if (!model.workspaces.length) assert.ok((await model.applyAfterSave(() => model.createWorkspace({ name: "Stage11 Test Workspace" }))).ok);
  const created = await model.applyAfterSave(() => model.createBoard(name, "", template));
  assert.ok(created.ok, created.code);
  return model.board;
}
const serverRecords = async (boardId) => (await call("GET", `/api/v1/boards/${boardId}/records?limit=200`)).body.items;
const rollbackEvents = (model) => model.browser.events.filter((e) => e.type === "jarc-rollback").map((e) => e.detail);

before(async () => { app = await startMongoApp(); });
after(async () => { await app.close(); });
beforeEach(async () => {
  requests = [];
  app.fake.down = false;
  for (const w of (await call("GET", "/api/v1/workspaces")).body.items) await call("DELETE", `/api/v1/workspaces/${w.id}?expectedVersion=${w.version}`);
});

describe("Initialization", () => {
  test("empty server: no workspaces, usable state, nothing written locally to local mode's data key", async () => {
    const model = await tab();
    assert.equal(model.workspaces.length, 0);
    assert.equal(model.board, undefined);
    assert.equal(model.browser.localStorage.getItem("jarc-database-data"), null);
    same(requests, ["GET /api/v1/workspaces"]);
  });

  test("startup loads workspace and board summaries, then records only for the open board", async () => {
    const a = await tab();
    const b1 = await newBoard(a, "Stage11 Board One");
    a.quickAdd(); await settle(a);
    const b2 = await newBoard(a, "Stage11 Board Two");
    a.quickAdd(); a.quickAdd(); await settle(a);
    const wsId = a.workspace.id;
    requests = [];
    const b = await tab();
    same(requests.slice(0, 2), ["GET /api/v1/workspaces", `GET /api/v1/workspaces/${wsId}/boards`]);
    await boardStatus(b, b1.id);
    // A new browser has no stored selection, so the first board opens and only its records load.
    same(requests.filter((r) => r.includes("/records")), [`GET /api/v1/boards/${b1.id}/records`]);
    const two = b.workspace.boards.find((x) => x.id === b2.id);
    same([two.records.length, b.boardLoadState(b2.id).state, b.boardRecordCount(two)], [0, "none", 2], "board two: not loaded, count from the server");
    b.openBoard(b2.id, wsId);
    assert.equal((await boardStatus(b, b2.id)).state, "full");
    assert.equal(b.rows.length, 2);
  });

  test("saves with no shared changes send nothing (opening boards, settings, favourites, filters)", async () => {
    const a = await tab();
    const board = await newBoard(a);
    a.quickAdd(); a.saveView("Stage11 view"); await settle(a);
    const b = await tab();
    b.openBoard(board.id, a.workspace.id); await boardStatus(b);
    requests = [];
    b.openBoard(board.id, a.workspace.id); b.updateSetting("density", "compact"); b.toggleFavorite(board.id); b.setView("list"); b.openScreen("home");
    await settle(b);
    same(requests.filter((r) => !r.startsWith("GET")), [], "only per-user state changed, and that stays in the browser");
    same((await call("GET", `/api/v1/boards/${board.id}`)).body.board.version, a.storage.adapter.boards.get(board.id).version, "the board version didn't move");
  });

  test("a new browser selects the first real workspace and board, and opens boards by ID alone (as the sidebar does)", async () => {
    const a = await tab();
    const first = await newBoard(a, "Stage11 First");
    const second = await newBoard(a, "Stage11 Second");
    a.quickAdd(); await settle(a);
    const b = await tab();
    same([b.currentWorkspaceId, b.currentBoardId], [a.workspace.id, first.id], "never the local-mode defaults");
    b.openBoard(second.id);
    assert.equal(b.board.id, second.id);
    assert.equal((await boardStatus(b, second.id)).state, "full");
    assert.equal(b.rows.length, 1);
  });

  test("the server being unavailable at startup gives a clear, retryable error", async () => {
    app.fake.down = true;
    const browser = loadBrowser();
    const model = browser.newResourceModel({ baseUrl: `${app.url}/api/v1` });
    await assert.rejects(model.init(), (e) => e.name === "StorageError" && e.code === "SERVICE_UNAVAILABLE" && /couldn't load your workspaces/.test(e.message));
  });
});

describe("Workspaces and boards", () => {
  test("workspace create, rename, delete use the resource endpoints with versions", async () => {
    const model = await tab();
    const created = await model.applyAfterSave(() => model.createWorkspace({ name: "Stage11 Test Workspace" }));
    assert.ok(created.ok);
    const id = model.workspace.id;
    assert.match(id, /^[0-9a-f]{24}$/, "the model uses the server ID");
    model.updateWorkspace(id, { name: "Stage11 Renamed", color: "#18b8aa" }); await settle(model);
    const server = (await call("GET", `/api/v1/workspaces/${id}`)).body.workspace;
    same([server.name, server.color, server.version], ["Stage11 Renamed", "#18b8aa", 2]);
    await model.applyAfterSave(() => model.createWorkspace({ name: "Stage11 Second" }));
    const removed = await model.applyAfterSave(() => model.deleteWorkspace(id));
    assert.ok(removed.ok, removed.code);
    assert.equal((await call("GET", `/api/v1/workspaces/${id}`)).status, 404);
    assert.ok(requests.includes(`DELETE /api/v1/workspaces/${id}`));
  });

  test("board create, rename, description, archive, reorder, move and delete", async () => {
    const model = await tab();
    const board = await newBoard(model);
    model.renameBoard(board.id, "Stage11 Renamed Board"); await settle(model);
    model.updateBoardDescription("Disposable test board"); await settle(model);
    let server = (await call("GET", `/api/v1/boards/${board.id}`)).body.board;
    same([server.name, server.description], ["Stage11 Renamed Board", "Disposable test board"]);
    const second = await newBoard(model, "Stage11 Second Board", "blank");
    model.archiveBoard(second.id); await settle(model);
    assert.equal((await call("GET", `/api/v1/boards/${second.id}`)).body.board.archived, true);
    await model.applyAfterSave(() => model.createWorkspace({ name: "Stage11 Target" }));
    const target = model.workspace.id;
    model.switchWorkspace(model.workspaces[0].id); model.openBoard(board.id); await settle(model);
    assert.ok(model.moveBoardToWorkspace(board.id, target)); await settle(model);
    server = (await call("GET", `/api/v1/boards/${board.id}`)).body.board;
    assert.equal(server.workspaceId, target);
    const deleted = await model.applyAfterSave(() => model.deleteBoard(board.id));
    assert.ok(deleted.ok, deleted.code);
    assert.equal((await call("GET", `/api/v1/boards/${board.id}`)).status, 404);
  });

  test("duplicating a board creates the board and its records (one batch request)", async () => {
    const model = await tab();
    const board = await newBoard(model);
    model.quickAdd(); model.quickAdd(); await settle(model);
    requests = [];
    model.duplicateBoard(board.id); await settle(model);
    const copy = model.board;
    assert.match(copy.id, /^[0-9a-f]{24}$/);
    assert.equal((await serverRecords(copy.id)).length, 2);
    assert.equal(requests.filter((r) => r.endsWith("/records/batch")).length, 1);
  });
});

describe("Records", () => {
  test("create replaces the temporary ID with the server ID; edits update the version", async () => {
    const model = await tab();
    const board = await newBoard(model);
    const temp = model.quickAdd();
    assert.equal(typeof temp, "number");
    await settle(model);
    const id = model.rows[0].id;
    assert.match(id, /^[0-9a-f]{24}$/, "no client-only ID remains");
    assert.equal(model.idOf(String(temp)), id, "the old ID still resolves");
    model.updateCell(id, "status", "In Progress"); await settle(model);
    model.updateCell(id, "notes", "Stage11 note"); await settle(model);
    const [server] = await serverRecords(board.id);
    assert.equal(server.version, 3);
    assert.equal(server.values.status, "In Progress");
    assert.equal(model.storage.adapter.records.get(id).version, 3, "the adapter tracks the server version");
  });

  test("checkbox, status, group, pin and archive persist; delete removes the server record", async () => {
    const model = await tab();
    const board = await newBoard(model, "Stage11 Board", "blank");
    const column = (await model.applyAfterSave(() => model.addColumn({ label: "Checked", type: "checkbox" }))).result;
    const id = model.upsert({ serial: "Stage11 Record" }).id; await settle(model);
    const serverId = model.rows[0].id;
    model.updateCell(serverId, column.key, true); model.togglePin(serverId); await settle(model);
    let [server] = await serverRecords(board.id);
    same([server.values[column.key], server.pinned], [true, true]);
    model.archiveItem(serverId); await settle(model);
    [server] = await serverRecords(board.id);
    assert.equal(server.archived, true);
    assert.ok(id);
    const removed = await model.applyAfterSave(() => model.remove([serverId]));
    assert.ok(removed.ok);
    assert.equal((await serverRecords(board.id)).length, 0);
    assert.ok(requests.includes(`DELETE /api/v1/records/${serverId}`));
  });

  test("REFRESH: everything created loads again from the server", async () => {
    const a = await tab();
    const board = await newBoard(a);
    const cost = (await a.applyAfterSave(() => a.addColumn({ label: "Cost", type: "number" }))).result;
    a.upsert({ serial: "Stage11 Record", status: "Done", group: "Working", [cost.key]: "99" }); await settle(a);
    a.saveView("Stage11 view"); await settle(a);
    const b = await tab();
    b.openBoard(board.id, a.workspace.id);
    await boardStatus(b);
    same(b.workspaces.map((w) => w.name), ["Stage11 Test Workspace"]);
    same(b.board.columns.map((c) => c.key), a.board.columns.map((c) => c.key));
    const row = b.rows.find((r) => r.serial === "Stage11 Record");
    same([row.status, row.group, row[cost.key]], ["Done", "Working", "99"]);
    assert.equal(b.board.savedViews[0].name, "Stage11 view");
    assert.match(b.board.savedViews[0].id, /^view_/);
  });

  test("bulk edit, bulk delete and CSV import each use one batch request", async () => {
    const model = await tab();
    const board = await newBoard(model);
    model.importRows(Array.from({ length: 300 }, (_, i) => ({ serial: `Stage11 Import ${i}`, status: "New" }))); await settle(model);
    assert.equal(requests.filter((r) => r === `POST /api/v1/boards/${board.id}/records/batch`).length, 1);
    assert.equal((await call("GET", `/api/v1/boards/${board.id}/records?limit=200`)).body.nextCursor !== null, true);
    const ids = model.rows.slice(0, 5).map((r) => r.id);
    requests = [];
    model.bulkUpdate(ids, "status", "Done"); await settle(model);
    same(requests.filter((r) => r.includes("/records")), [`PATCH /api/v1/boards/${board.id}/records`]);
    requests = [];
    assert.ok((await model.applyAfterSave(() => model.remove(ids))).ok);
    same(requests.filter((r) => r.includes("/records")), [`POST /api/v1/boards/${board.id}/records/delete`]);
    const counts = (await call("GET", `/api/v1/workspaces/${model.workspace.id}/boards`)).body.items[0].recordCount;
    assert.equal(counts, 295);
  });

  test("reordering sends new positions only for moved records; order survives a refresh", async () => {
    const model = await tab();
    const board = await newBoard(model, "Stage11 Board", "blank");
    for (const n of [1, 2, 3, 4]) model.upsert({ serial: `R${n}` });
    await settle(model);
    model.manualSort = true;
    const before = model.rows.map((r) => r.serial);
    requests = [];
    assert.ok(model.reorderRecord(model.rows[3].id, model.rows[0].id, "before")); await settle(model);
    const after = model.rows.map((r) => r.serial);
    assert.notDeepEqual(after, before);
    same(requests.filter((r) => r.includes("/records")), [`PATCH /api/v1/records/${model.rows[0].id}`], "only the moved record");
    const b = await tab(); b.openBoard(board.id, model.workspace.id); await boardStatus(b);
    same(b.rows.map((r) => r.serial), after);
  });

  test("undo of a delete re-creates the record on the server", async () => {
    const model = await tab();
    const board = await newBoard(model);
    model.upsert({ serial: "Stage11 Undo" }); await settle(model);
    assert.ok((await model.applyAfterSave(() => model.remove([model.rows[0].id]))).ok);
    assert.equal((await serverRecords(board.id)).length, 0);
    model.undo(); await settle(model);
    const server = await serverRecords(board.id);
    same(server.map((r) => r.values.serial), ["Stage11 Undo"]);
    assert.equal(model.rows[0].id, server[0].id, "the model adopts the new server ID");
  });

  test("moving a record to another board creates it there and removes it here", async () => {
    const model = await tab();
    const first = await newBoard(model, "Stage11 From");
    model.upsert({ serial: "Stage11 Mover" }); await settle(model);
    const second = await newBoard(model, "Stage11 To");
    model.openBoard(first.id); await settle(model);
    assert.ok(model.moveRecordToBoard(model.rows[0].id, second.id)); await settle(model);
    assert.equal((await serverRecords(first.id)).length, 0);
    same((await serverRecords(second.id)).map((r) => r.values.serial), ["Stage11 Mover"]);
  });
});

describe("Columns, groups and saved views", () => {
  test("add, rename (key unchanged), reorder, hide, resize: no record rewrites except filling the new column", async () => {
    const model = await tab();
    const board = await newBoard(model);
    model.upsert({ serial: "A" }); await settle(model);
    const column = (await model.applyAfterSave(() => model.addColumn({ label: "Region", type: "text", defaultValue: "PH" }))).result;
    assert.equal((await serverRecords(board.id))[0].values[column.key], "PH", "server filled the default");
    model.renameColumn(column.key, "Area"); model.moveColumn(column.key, "left"); model.setColumnVisible(column.key, false); model.resizeColumn(column.key, 240);
    await settle(model);
    const server = (await call("GET", `/api/v1/boards/${board.id}`)).body.board;
    const saved = server.columns.find((c) => c.key === column.key);
    same([saved.label, saved.visible, saved.width], ["Area", false, 240]);
    same(server.columns.map((c) => c.key), model.board.columns.map((c) => c.key));
    assert.equal((await serverRecords(board.id))[0].version, 2, "renames and layout changes never touched the record");
  });

  test("type change, option rename/remove, duplicate and delete column go through the schema endpoints", async () => {
    const model = await tab();
    const board = await newBoard(model);
    model.upsert({ serial: "A", status: "New", notes: "12" }); model.upsert({ serial: "B", status: "Done", notes: "text" }); await settle(model);
    requests = [];
    same(model.changeColumnType("notes", "number"), { cleared: 1 }); await settle(model);
    model.editColumnOptions("status", [{ from: "New", to: "Open" }, { from: "In Progress", to: "In Progress" }]); await settle(model);
    const copy = model.duplicateColumn("status"); await settle(model);
    const gone = await model.applyAfterSave(() => model.deleteColumn("received"));
    assert.ok(gone.ok);
    assert.ok(requests.includes(`POST /api/v1/boards/${board.id}/columns/notes/type`));
    assert.ok(requests.includes(`PUT /api/v1/boards/${board.id}/columns/status/options`));
    assert.ok(requests.includes(`POST /api/v1/boards/${board.id}/columns`));
    assert.ok(requests.includes(`DELETE /api/v1/boards/${board.id}/columns/received`));
    const server = Object.fromEntries((await serverRecords(board.id)).map((r) => [r.values.serial, r.values]));
    const local = Object.fromEntries(model.rows.map((r) => [r.serial, r]));
    for (const serial of ["A", "B"]) for (const key of ["notes", "status", copy.key]) assert.equal(server[serial][key], local[serial][key], `${serial}.${key} same on server and in the app`);
    // "Done" isn't one of the app's built-in status options, so the option edit leaves it alone (same as the app).
    same([server.A.status, server.B.status, server.B.notes], ["Open", "Done", ""]);
    assert.ok(!("received" in server.A));
  });

  test("groups: rename keeps the stable ID, delete moves records, new groups get IDs", async () => {
    const model = await tab();
    const board = await newBoard(model);
    model.upsert({ serial: "A", group: "Working" }); await settle(model);
    const before = (await call("GET", `/api/v1/boards/${board.id}`)).body.board.groups;
    const working = before.find((g) => g.name === "Working");
    model.renameGroup("Working", "Doing"); await settle(model);
    let server = (await call("GET", `/api/v1/boards/${board.id}`)).body.board.groups;
    assert.equal(server.find((g) => g.name === "Doing").id, working.id);
    assert.equal((await serverRecords(board.id))[0].version, 1, "a rename doesn't rewrite records");
    model.addGroup("Stage11 Escalated"); await settle(model);
    server = (await call("GET", `/api/v1/boards/${board.id}`)).body.board.groups;
    assert.match(server.find((g) => g.name === "Stage11 Escalated").id, /^grp_/);
    model.deleteGroup("Doing", "Done"); await settle(model);
    server = (await call("GET", `/api/v1/boards/${board.id}`)).body.board.groups;
    assert.ok(!server.some((g) => g.id === working.id));
    assert.equal((await serverRecords(board.id))[0].groupId, server.find((g) => g.name === "Done").id);
    assert.ok(requests.includes(`DELETE /api/v1/boards/${board.id}/groups/${working.id}`));
  });

  test("saved views: created with a server ID, applied and deleted", async () => {
    const model = await tab();
    const board = await newBoard(model);
    model.status = "Done"; model.saveView("Stage11 Done view"); await settle(model);
    const view = model.board.savedViews[0];
    assert.match(String(view.id), /^view_/);
    assert.equal(model.activeSavedViewId, view.id);
    model.resetMainView(); model.applyView(view.id); await settle(model);
    assert.equal(model.status, "Done");
    model.deleteView(view.id); await settle(model);
    same((await call("GET", `/api/v1/boards/${board.id}`)).body.board.savedViews, []);
  });
});

describe("Pagination and loading", () => {
  const seed = async (boardId, count) => {
    for (let i = 0; i < count; i += 1000) {
      const records = Array.from({ length: Math.min(1000, count - i) }, (_, n) => ({ values: { serial: `Stage11 ${String(i + n).padStart(5, "0")}` }, position: (i + n + 1) * 10 }));
      assert.equal((await call("POST", `/api/v1/boards/${boardId}/records/batch`, { records })).status, 201);
    }
  };

  test("a board under the threshold loads completely, page by page (200 per request)", async () => {
    const a = await tab();
    const board = await newBoard(a, "Stage11 Paged", "blank");
    await seed(board.id, 450);
    requests = [];
    const b = await tab(); // the only board, so it opens and loads at startup
    b.openBoard(board.id, a.workspace.id);
    assert.equal((await boardStatus(b, board.id)).state, "full");
    assert.equal(b.rows.length, 450);
    assert.equal(new Set(b.rows.map((r) => r.id)).size, 450, "no duplicates");
    same(b.rows.slice(0, 3).map((r) => r.serial), ["Stage11 00000", "Stage11 00001", "Stage11 00002"], "server order");
    assert.equal(requests.filter((r) => r === `GET /api/v1/boards/${board.id}/records`).length, 3);
  });

  test("a board over 2,000 records loads the first 2,000, then Load more; unloaded records are never deleted", async () => {
    const a = await tab();
    const board = await newBoard(a, "Stage11 Large", "blank");
    await seed(board.id, 2150);
    const b = await tab();
    b.openBoard(board.id, a.workspace.id);
    const first = await boardStatus(b, board.id);
    same([first.state, first.loaded, first.total], ["partial", 2000, 2150]);
    assert.equal(b.rows.length, 2000);
    b.updateCell(b.rows[0].id, "serial", "Stage11 edited"); await settle(b);
    assert.equal((await call("GET", `/api/v1/workspaces/${a.workspace.id}/boards`)).body.items[0].recordCount, 2150, "editing a partly loaded board deleted nothing");
    await b.ensureBoardRecords(board.id, { more: true });
    assert.equal(b.boardLoadState(board.id).state, "full");
    assert.equal(b.rows.length, 2150);
    assert.equal(new Set(b.rows.map((r) => r.id)).size, 2150);
  });

  test("a save that would delete records unexpectedly is refused", async () => {
    const model = await tab();
    const board = await newBoard(model);
    model.upsert({ serial: "Keep me" }); await settle(model);
    const state = model.toStorageState();
    state.data.workspaces[0].boards[0].records = [];
    const result = await model.storage.commit({ op: "updateUserState" }, state);
    assert.equal(result.ok, false);
    assert.match(result.message, /removed shared data unexpectedly/);
    assert.equal((await serverRecords(board.id)).length, 1);
  });
});

describe("Conflicts, failures and Retry", () => {
  test("CONFLICT: two tabs load v1; A saves v2; B's stale edit gets 409, B shows A's value and doesn't overwrite", async () => {
    const a = await tab();
    const board = await newBoard(a);
    a.upsert({ serial: "Stage11 Shared", status: "New" }); await settle(a);
    const id = a.rows[0].id;
    const b = await tab(); b.openBoard(board.id, a.workspace.id); await boardStatus(b);
    assert.equal(b.storage.adapter.records.get(id).version, 1);
    a.updateCell(id, "status", "In Progress"); await settle(a);
    b.updateCell(id, "status", "Done"); await settle(b);
    const [server] = await serverRecords(board.id);
    same([server.values.status, server.version], ["In Progress", 2]);
    assert.equal(b.rows.find((r) => r.id === id).status, "In Progress", "B now shows A's saved value");
    assert.equal(b.failure, null, "nothing left for Retry to re-send");
    assert.equal(b.saveState, "saved");
    same(rollbackEvents(b).at(-1), { code: "CONFLICT", op: "updateRecord", refreshed: true });
    assert.equal(b.browser.window.StorageError.describeRefreshed("CONFLICT").message, "This item was changed by another user. The latest version has been loaded.");
    b.updateCell(id, "notes", "B again"); await settle(b);
    assert.equal((await serverRecords(board.id))[0].values.notes, "B again", "B can keep working on the latest version");
  });

  test("a record deleted in another tab disappears when this tab tries to edit it", async () => {
    const a = await tab();
    const board = await newBoard(a);
    a.upsert({ serial: "Stage11 Gone" }); await settle(a);
    const id = a.rows[0].id;
    const b = await tab(); b.openBoard(board.id, a.workspace.id); await boardStatus(b);
    assert.ok((await a.applyAfterSave(() => a.remove([id]))).ok);
    b.updateCell(id, "notes", "too late"); await settle(b);
    assert.equal(b.rows.some((r) => r.id === id), false);
    assert.equal(rollbackEvents(b).at(-1).code, "NOT_FOUND");
    assert.equal((await serverRecords(board.id)).length, 0, "nothing was re-created");
  });

  test("board settings changed in another tab: 409 loads the latest board", async () => {
    const a = await tab();
    const board = await newBoard(a);
    const b = await tab(); b.openBoard(board.id, a.workspace.id); await boardStatus(b);
    a.renameBoard(board.id, "Stage11 From A"); await settle(a);
    b.renameColumn("notes", "Notes from B"); await settle(b);
    assert.equal(rollbackEvents(b).at(-1).code, "CONFLICT");
    assert.equal(b.board.name, "Stage11 From A");
    assert.equal((await call("GET", `/api/v1/boards/${board.id}`)).body.board.columns.find((c) => c.key === "notes").label, "Updates / Notes");
  });

  test("validation failure from the server: rolled back with a safe message", async () => {
    const model = await tab();
    const board = await newBoard(model);
    model.upsert({ serial: "A" }); await settle(model);
    model.updateCell(model.rows[0].id, "dueDate", "2026-02-30"); await settle(model);
    assert.equal(model.saveError, "VALIDATION_ERROR");
    assert.equal(model.rows[0].dueDate, "");
    assert.equal((await serverRecords(board.id))[0].values.dueDate, "");
  });

  test("MongoDB unavailable: change rolled back and kept for Retry; Retry saves once it's back", async () => {
    const model = await tab();
    const board = await newBoard(model);
    model.upsert({ serial: "A" }); await settle(model);
    app.fake.down = true;
    model.updateCell(model.rows[0].id, "notes", "Stage11 retry"); await settle(model);
    same([model.saveState, model.saveError, model.rows[0].notes], ["error", "SERVICE_UNAVAILABLE", ""]);
    assert.equal(model.storage.connection, "offline");
    app.fake.down = false;
    model.retryFailedSave(); await settle(model);
    assert.equal(model.saveState, "saved");
    assert.equal((await serverRecords(board.id))[0].values.notes, "Stage11 retry");
  });

  test("a failed create isn't duplicated by Retry", async () => {
    const model = await tab();
    const board = await newBoard(model);
    app.fake.failNext({ collection: "records", op: "insertOne", error: new MongoNetworkError("reset (fake)") });
    model.quickAdd(); await settle(model);
    assert.equal(model.saveState, "error");
    model.retryFailedSave(); await settle(model);
    assert.equal((await serverRecords(board.id)).length, 1);
  });
});

describe("Per-user state and safety", () => {
  test("favourites, last view and selection stay in this browser, never on the shared board", async () => {
    const a = await tab();
    const board = await newBoard(a);
    a.toggleFavorite(board.id); a.setView("kanban"); await settle(a);
    const server = (await call("GET", `/api/v1/boards/${board.id}`)).body.board;
    assert.ok(!("favorite" in server) && !("lastView" in server) && !("openCount" in server));
    const stored = JSON.parse(a.browser.localStorage.getItem("jarc-resource-user"));
    assert.equal(stored.boardPrefs[board.id].favorite, true);
    assert.equal(stored.currentBoardId, board.id);
    const other = await tab();
    assert.equal(other.workspace.boards[0].favorite, false, "another browser has its own favourites");
  });

  test("restoring a backup is refused in resource mode; export still works", async () => {
    const model = await tab();
    await newBoard(model);
    const backup = model.createBackup();
    assert.equal(backup.version, 11);
    assert.throws(() => model.restoreBackup(backup), /isn't available while you're working on shared server data/);
  });

  test("TWO CLIENTS share data: A creates and edits, B refreshes and sees it", async () => {
    const a = await tab();
    const board = await newBoard(a, "Stage11 Shared Board");
    a.upsert({ serial: "Stage11 Record", status: "In Progress" }); await settle(a);
    const b = await tab();
    b.openBoard(board.id, a.workspace.id); await boardStatus(b);
    same(b.rows.map((r) => [r.serial, r.status]), [["Stage11 Record", "In Progress"]]);
    b.updateCell(b.rows[0].id, "status", "Done"); await settle(b);
    const a2 = await tab(); a2.openBoard(board.id, a.workspace.id); await boardStatus(a2);
    assert.equal(a2.rows[0].status, "Done");
  });
});
