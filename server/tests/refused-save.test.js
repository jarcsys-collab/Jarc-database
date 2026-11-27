// A refused record save keeps the board: the unchanged browser model (resource mode) against the real API on the fake MongoDB,
// with refusals injected at fetch. Before the fix, a save that started before a board's records (or a page of a large board)
// arrived set the "last saved" state back to the board without them, so the next refused save rolled every loaded row away.
// Only the failed change goes back; earlier saved edits, filters, saved views and the server view stay. Synthetic data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startMongoApp, api } = require("./helpers");
const { loadBrowser } = require("./support/browser-model");

const COLUMNS = [{ key: "serial", label: "Name", type: "text", required: true }, { key: "note", label: "Note", type: "text" }];
let app, fault = null;
const call = (method, p, body) => api(app.url, method, p, body);
// Every request of the models passes here: `fault(url, init)` may answer instead of the server (null: the server answers).
const fetchImpl = (u, init) => fault?.(String(u), init) || fetch(u, init);
const refuse = (status, code) => () => Promise.resolve(new Response(JSON.stringify({ error: { code, message: "refused" } }), { status, headers: { "Content-Type": "application/json" } }));
const isPatch = (u, init, id) => init?.method === "PATCH" && u.includes(`/records/${id ?? ""}`);
const deferred = () => { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; };
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };

async function makeBoard(ws, name, count) {
  const board = (await call("POST", `/api/v1/workspaces/${ws}/boards`, { name, columns: COLUMNS })).body.board;
  for (let i = 0; i < count; i += 500) assert.equal((await call("POST", `/api/v1/boards/${board.id}/records/batch`, { records: Array.from({ length: Math.min(500, count - i) }, (_, j) => ({ values: { serial: `${name} ${String(i + j).padStart(4, "0")}`, note: "n" } })) })).status, 201);
  return board;
}
async function tab({ timeoutMs = 5000 } = {}) {
  const browser = loadBrowser();
  const model = browser.newResourceModel({ baseUrl: `${app.url}/api/v1`, fetchImpl, timeoutMs });
  await model.init();
  return { model, events: browser.events };
}
const settle = async (model) => { await model.lastSave; await model.storage.queue; };
const loaded = (model, id) => until(() => !["loading", "none"].includes(model.boardLoadState(id).state));
const rollbacks = (events) => events.filter((e) => e.type === "jarc-rollback").map((e) => e.detail);
const serverNote = async (id) => (await call("GET", `/api/v1/records/${id}`)).body.record.values.note;

before(async () => { app = await startMongoApp(); });
after(async () => { fault = null; await app.close(); });

describe("A refused save keeps the board's rows", () => {
  let ws, small, big;
  before(async () => {
    ws = (await call("POST", "/api/v1/workspaces", { name: "Refusals" })).body.workspace.id;
    small = await makeBoard(ws, "Small", 30);
    big = await makeBoard(ws, "Big", 2100);
  });

  test("small board: a save queued while the records load, then a refused edit → all 30 rows stay; only that cell goes back", async () => {
    const { model, events } = await tab();
    model.openBoard(small.id, ws); model.save({ op: "updateUserState" }); // a save that started before the board's records arrived
    assert.ok(await loaded(model, small.id)); await settle(model);
    assert.equal(model.rows.length, 30);
    const [row, other] = model.rows;
    fault = (u, init) => isPatch(u, init) ? refuse(400, "VALIDATION_ERROR")() : null;
    try { model.updateCell(row.id, "note", "refused value"); assert.equal(await model.lastSave, false); } finally { fault = null; }
    assert.equal(model.rows.length, 30, "every loaded row is still there");
    assert.equal(model.rows.find((r) => r.id === row.id).note, "n", "the refused value went back");
    assert.equal(model.rows.find((r) => r.id === other.id).note, "n");
    assert.equal(model.saveState, "error");
    assert.equal(rollbacks(events).at(-1).code, "VALIDATION_ERROR");
    assert.deepEqual(JSON.parse(JSON.stringify(model.refusedChange)), { boardId: small.id, recordId: row.id, fields: ["note"] }, "the cell that went back (marked in the app)");
    // Undo after the rollback still has the rows (the saved state's undo history got them too): nothing is deleted.
    model.updateCell(other.id, "note", "kept"); assert.equal(await model.lastSave, true);
    model.undo(); assert.equal(await model.lastSave, true);
    assert.equal(model.rows.length, 30);
    assert.equal((await call("GET", `/api/v1/boards/${small.id}/records?limit=100`)).body.items.length, 30, "nothing was deleted on the server");
  });

  test("large board (2,100, server paging): pages loaded while a save runs, a saved view with a filter, then a refused edit → rows, view and paging stay", async () => {
    const withView = (await call("PATCH", `/api/v1/boards/${big.id}`, { expectedVersion: big.version, savedViews: [{ name: "Big 1xxx", state: { view: "table", filter: { op: "and", rules: [{ key: "serial", cmp: "startsWith", values: ["Big 1"] }] } } }] })).body.board;
    const { model } = await tab();
    model.openBoard(big.id, ws); assert.ok(await loaded(model, big.id)); await settle(model);
    assert.equal(model.boardLoadState(big.id).state, "partial");
    model.applyView(withView.savedViews[0].id); model.syncServerQuery();
    assert.ok(await until(() => model.serverView && model.serverView.total !== null), "the server view counted");
    const view = model.serverView, viewId = model.activeSavedViewId, filter = JSON.stringify(model.viewFilter), currentView = model.currentView;
    assert.equal(view.total, 1000);
    // A save in flight while two more pages arrive.
    const gate = deferred(), first = model.rows.find((r) => r.serial.startsWith("Big 1"));
    fault = (u, init) => isPatch(u, init, first.id) ? gate.promise.then(() => fetch(u, init)) : null;
    model.updateCell(first.id, "note", "saved while paging");
    const group = model.serverViewFlat ? null : model.groupOf(first);
    assert.equal(await model.loadServerPage(group), true); assert.equal(await model.loadServerPage(group), true);
    const loadedRows = model.rows.length;
    assert.ok(loadedRows > 200, `pages were added (${loadedRows})`);
    gate.release(); assert.equal(await model.lastSave, true);
    // Now a refused edit on another row.
    const second = model.rows.filter((r) => r.serial.startsWith("Big 1")).at(-1);
    fault = (u, init) => isPatch(u, init) ? refuse(500, "INTERNAL_ERROR")() : null;
    try { model.updateCell(second.id, "note", "refused"); assert.equal(await model.lastSave, false); } finally { fault = null; }
    assert.equal(model.rows.length, loadedRows, "every loaded row (first load and pages) is still there");
    assert.equal(model.rows.find((r) => r.id === second.id).note, "n", "only the refused cell went back");
    assert.equal(model.rows.find((r) => r.id === first.id).note, "saved while paging", "the earlier saved edit stays");
    assert.equal(model.serverView, view, "the server view (its order and loaded pages) is the same");
    assert.equal(model.activeSavedViewId, viewId); assert.equal(JSON.stringify(model.viewFilter), filter); assert.equal(model.currentView, currentView);
    assert.equal(model.boardLoadState(big.id).state, "partial");
    assert.equal(await serverNote(first.id), "saved while paging");
  });

  test("every failure class: 400, 403, 404, 409 conflict, 409 COLUMN_CONVERTING, network, 5xx, timeout → rows kept, only the failed cell goes back", async () => {
    const { model, events } = await tab({ timeoutMs: 600 });
    model.openBoard(small.id, ws); model.save({ op: "updateUserState" }); assert.ok(await loaded(model, small.id)); await settle(model);
    const count = model.rows.length, saved = model.rows[0];
    model.updateCell(saved.id, "note", "saved first"); assert.equal(await model.lastSave, true);
    const hang = (u, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const cases = [
      ["validation (400)", refuse(400, "VALIDATION_ERROR"), "VALIDATION_ERROR"],
      ["forbidden (403)", refuse(403, "FORBIDDEN"), "FORBIDDEN"],
      ["not found (404)", refuse(404, "NOT_FOUND"), "NOT_FOUND"],
      ["stale version (409)", refuse(409, "CONFLICT"), "CONFLICT"],
      ["column converting (409)", refuse(409, "COLUMN_CONVERTING"), "CONFLICT"],
      ["network", () => Promise.reject(new TypeError("Failed to fetch")), "OFFLINE"],
      ["server error (503)", refuse(503, "SERVICE_UNAVAILABLE"), "SERVICE_UNAVAILABLE"],
      ["server error (500)", refuse(500, "INTERNAL_ERROR"), "INTERNAL_ERROR"],
      ["timeout", hang, "SERVICE_UNAVAILABLE"]
    ];
    for (const [i, [name, answer, code]] of cases.entries()) {
      const row = model.rows[i + 2], before = JSON.stringify(model.rows.filter((r) => r.id !== row.id));
      fault = (u, init) => isPatch(u, init) ? answer(u, init) : null;
      try { model.updateCell(row.id, "note", `refused ${i}`); assert.equal(await model.lastSave, false, name); } finally { fault = null; }
      await settle(model);
      assert.equal(model.rows.length, count, `${name}: every row is still there`);
      assert.equal(model.rows.find((r) => r.id === row.id).note, "n", `${name}: the refused value went back`);
      assert.equal(JSON.stringify(model.rows.filter((r) => r.id !== row.id)), before, `${name}: no other row changed`);
      assert.equal(model.rows.find((r) => r.id === saved.id).note, "saved first", `${name}: the earlier saved edit stays`);
      assert.equal(rollbacks(events).at(-1).code, code, name);
      assert.equal(await serverNote(row.id), "n", `${name}: nothing reached the server`);
      model.discardFailedSave();
    }
  });

  test("two edits in flight: the first saves, the second is refused → the first stays, the second goes back; a third queued behind it is kept for Retry", async () => {
    const { model } = await tab();
    model.openBoard(small.id, ws); assert.ok(await loaded(model, small.id)); await settle(model);
    const [a, b, c] = model.rows.slice(20, 23), gate = deferred();
    fault = (u, init) => isPatch(u, init, a.id) ? gate.promise.then(() => fetch(u, init)) : isPatch(u, init, b.id) ? refuse(500, "INTERNAL_ERROR")() : null;
    try {
      model.updateCell(a.id, "note", "A"); const first = model.lastSave;
      model.updateCell(b.id, "note", "B"); const second = model.lastSave;
      model.updateCell(c.id, "note", "C"); const third = model.lastSave;
      gate.release();
      assert.deepEqual([await first, await second, await third], [true, false, false]);
    } finally { fault = null; }
    assert.equal(model.rows.length, 30);
    const note = (r) => model.rows.find((x) => x.id === r.id).note;
    assert.deepEqual([note(a), note(b), note(c)], ["A", "n", "n"], "the saved edit stays; the refused one and the one queued behind it go back");
    assert.equal(model.saveState, "error");
    // Retry re-applies both (nothing was lost) and saves them.
    assert.equal(await model.retryFailedSave(), true);
    assert.deepEqual([note(a), note(b), note(c)], ["A", "B", "C"]);
    assert.deepEqual([await serverNote(a.id), await serverNote(b.id), await serverNote(c.id)], ["A", "B", "C"]);
    assert.equal(model.rows.length, 30);
  });
});
