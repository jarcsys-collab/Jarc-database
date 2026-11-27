// The browser's board loading, saved copies (BoardCache) and memory bounds, exactly: the unchanged browser files driven in
// Node against the real resource API on the fake MongoDB, with an in-memory stand-in for IndexedDB. Synthetic data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { startMongoApp, api } = require("./helpers");
const { loadBrowser } = require("./support/browser-model");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
let app;
const call = (method, p, body) => api(app.url, method, p, body);
const COLUMNS = [{ key: "serial", label: "Name", type: "text", required: true }, { key: "note", label: "Note", type: "text" }, { key: "qty", label: "Qty", type: "number" }, { key: "due", label: "Due", type: "date" }, { key: "status", label: "Status", type: "status", options: ["New", "Working", "Done"] }];
// A stand-in for BoardCache (same methods), recording what the adapter asks of it.
function fakeCache() {
  const entries = new Map(), log = [];
  return { entries, log,
    async read(id, { version }) { log.push(`read ${id}`); const e = entries.get(id); return e && e.boardVersion === version ? JSON.parse(JSON.stringify(e)) : null; },
    async write(id, { boardVersion, records }) { log.push(`write ${id} ${records.length}`); entries.set(id, JSON.parse(JSON.stringify({ boardId: id, boardVersion, savedAt: Date.now(), records }))); return true; },
    async remove(id) { log.push(`remove ${id}`); entries.delete(id); },
    async retainOnly(ids) { const keep = new Set(ids.map(String)); for (const id of [...entries.keys()]) if (!keep.has(id)) { log.push(`remove ${id}`); entries.delete(id); } } };
}
async function tab(cache = null) {
  const model = loadBrowser().newResourceModel({ baseUrl: `${app.url}/api/v1` });
  if (cache) model.storage.adapter.useCache(cache);
  await model.init();
  return model;
}
const loaded = async (model, boardId) => { for (let i = 0; i < 300 && ["loading", "none"].includes(model.boardLoadState(boardId).state); i += 1) await new Promise((r) => setTimeout(r, 10)); return model.boardLoadState(boardId).state; };
const open = async (model, board) => { model.openBoard(board.id, board.workspaceId); await loaded(model, board.id); await model.lastSave; await model.storage.queue; return model; };
const records = async (boardId) => { const all = []; let cursor = ""; do { const page = (await call("GET", `/api/v1/boards/${boardId}/records?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).body; all.push(...page.items); cursor = page.nextCursor || ""; } while (cursor); return all; };
async function makeBoard(ws, name, rows) {
  const board = (await call("POST", `/api/v1/workspaces/${ws}/boards`, { name, columns: COLUMNS })).body.board;
  if (rows.length) assert.equal((await call("POST", `/api/v1/boards/${board.id}/records/batch`, { records: rows.map((values) => ({ values })) })).status, 201);
  return board;
}

before(async () => { app = await startMongoApp(); });
after(async () => { await app.close(); });

describe("Sorting: the same order as before, with less work", () => {
  test("text, numbers, dates and status, both directions, pinned first: identical to comparing with localeCompare(…, { numeric: true })", async () => {
    const ws = (await call("POST", "/api/v1/workspaces", { name: "Sort Space" })).body.workspace.id;
    const tricky = ["item 10", "Item 9", "item 2", "Ítem 3", "", "ITEM 1", "item 10b", "10", "9", "a-2", "a-10", "Zeta", "zeta", "éclair", "eclair", "2026-02-01", "  spaced"];
    const rows = Array.from({ length: 240 }, (_, i) => ({ serial: (tricky[i % tricky.length] || "blank") + (i % 3 ? ` ${i % 7}` : ""), note: tricky[(i * 7) % tricky.length], ...(i % 5 ? { qty: (i * 37) % 101 } : {}), ...(i % 4 ? { due: `2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}` } : {}), ...(i % 4 ? { status: ["New", "Working", "Done"][i % 3] } : {}) }));
    const board = await makeBoard(ws, "Sort Board", rows);
    const list = await records(board.id);
    for (const r of list.filter((_, i) => i % 9 === 0)) await call("PATCH", `/api/v1/records/${r.id}`, { expectedVersion: r.version, pinned: true });
    const fresh = await open(await tab(), { id: board.id, workspaceId: ws });
    assert.equal(fresh.rows.length, 240);
    // The comparison as it was written before (one localeCompare per comparison).
    const reference = (m) => { const place = new Map(m.rows.map((r, i) => [r, i])); return [...m.rows].filter((r) => !r.archived).sort((a, b) => { if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1; if (m.manualSort) return place.get(a) - place.get(b); const key = m.sortKey || m.sortColumn?.key; if (!key) return place.get(a) - place.get(b); const column = m.board.columns.find((c) => c.key === key), x = m.sortText(column, m.cellOf(a, key)), y = m.sortText(column, m.cellOf(b, key)); return m.sortDirection === "desc" ? y.localeCompare(x, undefined, { numeric: true }) : x.localeCompare(y, undefined, { numeric: true }); }).map((r) => String(r.id)); };
    let compared = 0;
    for (const key of ["serial", "note", "qty", "due", "status", null]) for (const dir of ["asc", "desc"]) {
      fresh.sortKey = key; fresh.sortDirection = dir; fresh.manualSort = false;
      const got = [...fresh.visibleRows.map((r) => String(r.id))], want = reference(fresh), at = got.findIndex((id, i) => id !== want[i]), show = (id) => { const r = fresh.rows.find((x) => String(x.id) === id); return r && JSON.stringify([r[key || "serial"], Boolean(r.pinned)]); };
      assert.deepEqual(got, want, `${key} ${dir}: first difference at ${at}: got ${show(got[at])} want ${show(want[at])} (of ${got.length}/${want.length})`); compared += 1;
    }
    fresh.manualSort = true; fresh.sortKey = "serial";
    assert.deepEqual([...fresh.visibleRows.map((r) => String(r.id))], reference(fresh), "manual order");
    assert.equal(compared, 12);
  });
});

describe("Loading and saved copies (adapter)", () => {
  let ws, board, big;
  before(async () => {
    ws = (await call("POST", "/api/v1/workspaces", { name: "Cache Space" })).body.workspace.id;
    board = await makeBoard(ws, "Copy Board", Array.from({ length: 1200 }, (_, i) => ({ serial: `Row ${i + 1}`, note: `n${i}` })));
    big = await makeBoard(ws, "Big Board", Array.from({ length: 2100 }, (_, i) => ({ serial: `Big ${i + 1}` })));
  });

  test("a full board is read in pages of 1000; a large one starts with a page of 200 and stays partial", async () => {
    const seen = [];
    const model = loadBrowser().newResourceModel({ baseUrl: `${app.url}/api/v1`, fetchImpl: (u, init) => { seen.push(String(u)); return fetch(u, init); } });
    await model.init();
    await open(model, { id: board.id, workspaceId: ws });
    const reads = seen.filter((u) => u.includes(`/boards/${board.id}/records?`));
    assert.deepEqual(reads.map((u) => new URL(u).searchParams.get("limit")), ["1000", "1000"]);
    assert.equal(model.rows.length, 1200);
    await open(model, { id: big.id, workspaceId: ws });
    assert.equal(model.boardLoadState(big.id).state, "partial");
    assert.deepEqual(seen.filter((u) => u.includes(`/boards/${big.id}/records?`)).map((u) => new URL(u).searchParams.get("limit")), ["200"]);
  });

  test("only complete boards are saved, from the server's copy; a partial board's copy is removed; a board gone is removed", async () => {
    const cache = fakeCache(), model = await tab(cache), adapter = model.storage.adapter;
    await open(model, { id: board.id, workspaceId: ws });
    await open(model, { id: big.id, workspaceId: ws });
    await adapter.flushCache();
    assert.equal(cache.entries.get(board.id)?.records.length, 1200);
    assert.equal(cache.entries.get(board.id).boardVersion, adapter.boards.get(board.id).version);
    assert.ok(!cache.entries.has(big.id) && cache.log.includes(`remove ${big.id}`), "partial: never kept");
    assert.ok(Object.keys(cache.entries.get(board.id).records[0]).every((k) => ["id", "boardId", "values", "groupId", "position", "archived", "pinned", "version", "createdAt", "updatedAt"].includes(k)));
    adapter.boards.delete(board.id); await adapter.flushCache();
    assert.ok(!cache.entries.has(board.id), "a board no longer listed: its copy goes");
  });

  test("a saved copy is shown (state cached) only with the same board version; the server's copy then replaces it, deletions included", async () => {
    const cache = fakeCache(), first = await tab(cache);
    await open(first, { id: board.id, workspaceId: ws }); await first.storage.adapter.flushCache();
    const [gone] = await records(board.id);
    assert.equal((await call("DELETE", `/api/v1/records/${gone.id}?expectedVersion=${gone.version}`)).status, 200);
    const model = await tab(cache), adapter = model.storage.adapter;
    model.openBoard(board.id, ws); await loaded(model, board.id);
    assert.equal(model.boardLoadState(board.id).state, "cached");
    assert.ok(model.rows.some((r) => String(r.id) === gone.id), "the copy predates the deletion");
    const plan = await adapter.fetchRemote([{ action: "board.updated", boardId: board.id }]);
    const { reconcile, summary } = adapter.commitRemote(plan);
    model.applyRemote(reconcile);
    assert.ok(summary.refreshed.has(board.id));
    assert.equal(model.boardLoadState(board.id).state, "full");
    assert.ok(!model.rows.some((r) => String(r.id) === gone.id), "deleted on the server: gone here, not brought back");
    assert.equal(model.rows.length, 1199);
    // Another version (columns, name…): the copy isn't used.
    const doc = (await call("GET", `/api/v1/boards/${board.id}`)).body.board;
    assert.equal((await call("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: doc.version, name: "Copy Board 2" })).status, 200);
    const third = await tab(cache); third.openBoard(board.id, ws); await loaded(third, board.id);
    assert.equal(third.boardLoadState(board.id).state, "full", "loaded from the server instead");
  });

  test("an answer older than what's here leaves the copy (stale, asked again) instead of replacing newer records", async () => {
    const cache = fakeCache(), first = await tab(cache);
    await open(first, { id: board.id, workspaceId: ws }); await first.storage.adapter.flushCache();
    const entry = cache.entries.get(board.id); entry.records[0].version += 5; // as if saved here after the answer was fetched
    const model = await tab(cache), adapter = model.storage.adapter;
    model.openBoard(board.id, ws); await loaded(model, board.id);
    const { summary } = adapter.commitRemote(await adapter.fetchRemote([{ action: "board.updated", boardId: board.id }]));
    assert.ok(summary.stale.has(board.id));
    assert.equal(model.boardLoadState(board.id).state, "cached");
  });

  test("a board larger than a full load never uses a copy", async () => {
    const cache = fakeCache(); cache.entries.set(big.id, { boardId: big.id, boardVersion: 1, savedAt: Date.now(), records: [] });
    const model = await tab(cache);
    await open(model, { id: big.id, workspaceId: ws });
    assert.ok(!cache.log.includes(`read ${big.id}`));
    assert.equal(model.boardLoadState(big.id).state, "partial");
  });

  test("boards this person no longer sees lose their copies when the board list loads", async () => {
    const cache = fakeCache(); cache.entries.set("0123456789abcdef01234567", { boardId: "0123456789abcdef01234567", boardVersion: 1, savedAt: Date.now(), records: [] });
    await tab(cache); await new Promise((r) => setTimeout(r, 20));
    assert.ok(!cache.entries.has("0123456789abcdef01234567"));
  });
});

describe("Memory bounds", () => {
  test("least recently opened first, never the open board; the model forgets them everywhere and a later save creates nothing", async () => {
    const ws = (await call("POST", "/api/v1/workspaces", { name: "Memory Space" })).body.workspace.id;
    const a = await makeBoard(ws, "A", [{ serial: "a1" }, { serial: "a2" }]), b = await makeBoard(ws, "B", [{ serial: "b1" }]), c = await makeBoard(ws, "C", [{ serial: "c1" }, { serial: "c2" }, { serial: "c3" }]);
    const model = await tab(), adapter = model.storage.adapter, R = model.storage.adapter.constructor;
    for (const x of [a, b, c]) await open(model, { id: x.id, workspaceId: ws });
    // Loaded here: A, B, C and the board the app opened at start (never opened since: least recently used of all).
    const loaded = [...adapter.boards.values()].filter((x) => x.load.state !== "none").sort((x, y) => (x.load.usedAt || 0) - (y.load.usedAt || 0)).map((x) => x.id);
    assert.equal(loaded.at(-1), c.id); assert.ok(loaded.indexOf(a.id) < loaded.indexOf(b.id));
    R.MEMORY_BOARD_LIMIT = 2;
    const expected = loaded.slice(0, loaded.length - 2);
    assert.ok(expected.includes(a.id) && !expected.includes(b.id) && !expected.includes(c.id), "the least recently opened, never the open one");
    assert.deepEqual([...adapter.evictionCandidates(c.id)], expected);
    const evicted = model.evictLoadedBoards();
    assert.deepEqual([...evicted], expected);
    assert.equal(adapter.boardLoadState(a.id).state, "none");
    assert.equal(model.workspaces.flatMap((w) => w.boards).find((x) => x.id === a.id).records.length, 0);
    assert.ok(!JSON.parse(model.persisted.text).data.workspaces.flatMap((w) => w.boards).find((x) => x.id === a.id).records.length, "the last saved state forgets them too");
    assert.equal(model.history.length, 0, "no undo can bring them back");
    // An ordinary change afterwards: nothing is created, deleted or changed on the evicted board.
    model.updateCell(model.rows[0].id, "note", "after");
    await model.lastSave; await model.storage.queue;
    assert.equal((await records(c.id)).find((r) => r.values.note === "after")?.values.serial !== undefined, true, "the change on the open board was saved");
    assert.equal((await records(a.id)).length, 2);
    await open(model, { id: a.id, workspaceId: ws });
    assert.equal(model.rows.length, 2, "loads again when opened");
    R.MEMORY_BOARD_LIMIT = 20;
  });
  test("never while a save is running or has failed", async () => {
    const model = await tab();
    model.storage.adapter.constructor.MEMORY_BOARD_LIMIT = 0;
    model.pendingSaves = 1; assert.deepEqual([...model.evictLoadedBoards()], []);
    model.pendingSaves = 0; model.failure = { text: "{}" }; assert.deepEqual([...model.evictLoadedBoards()], []);
    model.failure = null; model.storage.adapter.constructor.MEMORY_BOARD_LIMIT = 20;
  });
});

describe("BoardCache and sign-out (no IndexedDB needed)", () => {
  const load = (file, window) => { const context = vm.createContext({ window, console, setTimeout, clearTimeout, Promise, JSON, Date, Symbol, URL }); vm.runInContext(fs.readFileSync(path.join(ASSETS, file), "utf8"), context, { filename: file }); return context; };
  test("a saved copy is only accepted whole and well-formed, for this person, this board, this schema", () => {
    const { window } = { window: {} }; load("BoardCache.js", window);
    const C = window.BoardCache, id = "0123456789abcdef01234567", rec = { id: "abcdefabcdefabcdefabcdef", boardId: id, values: { serial: "x" }, version: 1 };
    const good = { schema: 2, scope: "u1", boardId: id, savedAt: Date.now(), boardVersion: 3, records: [rec] }; // 2 since S0-B
    assert.equal(C.valid(good, "u1", id), true);
    for (const [label, bad] of [["other person", { ...good, scope: "u2" }], ["other board", { ...good, boardId: "f".repeat(24) }], ["schema", { ...good, schema: 1 }], ["future schema", { ...good, schema: 3 }], ["records not a list", { ...good, records: {} }], ["bad id", { ...good, records: [{ ...rec, id: "x" }] }], ["values text", { ...good, records: [{ ...rec, values: "<b>" }] }], ["values list", { ...good, records: [{ ...rec, values: [] }] }], ["other board's record", { ...good, records: [{ ...rec, boardId: "e".repeat(24) }] }], ["no version", { ...good, records: [{ ...rec, version: "1" }] }], ["too many", { ...good, records: Array(2001).fill(rec) }], ["no time", { ...good, savedAt: "x" }], ["null", null]]) assert.equal(C.valid(bad, "u1", id), false, label);
    assert.equal(C.forScope(null), null, "no person: no cache");
  });
  test("signing out deletes the saved copies first, then signs out of Microsoft", async () => {
    const calls = [], window = {};
    load("EntraAuth.js", window);
    window.BoardCache = class { static async clearAll() { await new Promise((r) => setTimeout(r, 5)); calls.push("clear"); } };
    const session = new window.EntraSession({ signOut: async () => { calls.push("signOut"); } }, { user: { id: "u1", displayName: "A" } });
    await session.logout();
    assert.deepEqual(calls, ["clear", "signOut"]);
    window.BoardCache = class { static async clearAll() { throw new Error("blocked"); } };
    calls.length = 0; await new window.EntraSession({ signOut: async () => { calls.push("signOut"); } }, { user: { id: "u1" } }).logout();
    assert.deepEqual(calls, ["signOut"], "a cache that can't be cleared never blocks signing out");
  });
});
