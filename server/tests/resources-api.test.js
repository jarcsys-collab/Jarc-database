// Stage 10 resource API over HTTP: the real Express app, validation, services and MongoDB repositories, on the
// in-memory fake MongoDB client. Covers CRUD, relationships, version conflicts, pagination, sorting/filtering,
// validation and injection protection, ID/date representation, cascading deletes, MongoDB error mapping and the
// pre-auth production protection.
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoServerError, MongoNetworkError } = require("mongodb");
const { startMongoApp, startApp, api } = require("./helpers");
const { createApp } = require("../src/app");

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX = /^[0-9a-f]{24}$/;
const noMongoKeys = (value) => JSON.stringify(value).match(/"_id"|"\$|ObjectId|importId|devKey/) === null;

let app, base;
const call = (method, path, body, options) => api(base, method, path, body, options);
async function workspace(name = "Operations") { const res = await call("POST", "/api/v1/workspaces", { name }); assert.equal(res.status, 201, JSON.stringify(res.body)); return res.body.workspace; }
async function board(workspaceId, body = {}) { const res = await call("POST", `/api/v1/workspaces/${workspaceId}/boards`, { name: "Intake", ...body }); assert.equal(res.status, 201, JSON.stringify(res.body)); return res.body.board; }
async function record(boardId, values = { serial: "SN-1" }, extra = {}) { const res = await call("POST", `/api/v1/boards/${boardId}/records`, { values, ...extra }); assert.equal(res.status, 201, JSON.stringify(res.body)); return res.body.record; }
const flexibleColumns = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "group", label: "Group", type: "group" },
  { key: "status", label: "Status", type: "status", options: ["New", "In Progress", "Done"] },
  { key: "custom_cost", label: "Cost", type: "number" },
  { key: "custom_done", label: "Done", type: "checkbox" },
  { key: "dueDate", label: "Due", type: "date" }
];

before(async () => { app = await startMongoApp(); base = app.url; });
after(async () => { await app.close(); });

describe("Workspaces", () => {
  test("create → 201 with id, version 1, ISO dates, and the creator as WORKSPACE_ADMIN", async () => {
    const ws = await workspace("Engineering");
    assert.match(ws.id, HEX);
    assert.equal(ws.version, 1);
    assert.match(ws.createdAt, ISO);
    assert.equal(ws.createdBy, app.devActor._id.toHexString());
    assert.ok(noMongoKeys(ws));
    const stored = await app.db.collection("workspaceMembers").find({}).toArray();
    const mine = stored.find((m) => m.workspaceId.toHexString() === ws.id);
    assert.equal(mine.role, "WORKSPACE_ADMIN");
    assert.ok(mine.userId.equals(app.devActor._id));
    const doc = await app.db.collection("workspaces").findOne({ name: "Engineering" });
    assert.ok(doc.createdAt instanceof Date, "stored as a real Date");
  });

  test("list, get, patch (versioned) and 404s", async () => {
    const ws = await workspace("Logistics");
    const list = await call("GET", "/api/v1/workspaces");
    assert.ok(list.body.items.some((w) => w.id === ws.id));
    assert.equal((await call("GET", `/api/v1/workspaces/${ws.id}`)).body.workspace.name, "Logistics");
    const patched = await call("PATCH", `/api/v1/workspaces/${ws.id}`, { expectedVersion: 1, name: "Logistics PH", color: "#18b8aa" });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.workspace.version, 2);
    assert.equal(patched.body.workspace.name, "Logistics PH");
    assert.equal((await call("PATCH", `/api/v1/workspaces/${ws.id}`, { expectedVersion: 1, name: "Stale" })).status, 409);
    assert.equal((await call("GET", "/api/v1/workspaces/aaaaaaaaaaaaaaaaaaaaaaaa")).status, 404);
    assert.equal((await call("GET", "/api/v1/workspaces/not-an-id")).body.error.code, "VALIDATION_ERROR");
  });

  test("validation: name required, unknown fields and invalid colours rejected", async () => {
    for (const body of [{}, { name: "  " }, { name: "x".repeat(201) }, { name: "A", owner: "me" }, { name: "A", color: "red" }, { name: "A", archived: "yes" }]) {
      const res = await call("POST", "/api/v1/workspaces", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    }
  });
});

describe("Boards", () => {
  test("a board belongs to an existing workspace; a missing workspace → 404 and nothing stored", async () => {
    const ws = await workspace();
    const b = await board(ws.id);
    assert.equal(b.workspaceId, ws.id);
    assert.deepEqual(b.columns.map((c) => c.key), ["serial"]);
    assert.deepEqual(b.groups.map((g) => g.name), ["New", "Working", "Done"]);
    assert.ok(b.groups.every((g) => /^grp_[A-Za-z0-9]{10}$/.test(g.id)));
    const before = await app.db.collection("boards").countDocuments({});
    const missing = await call("POST", "/api/v1/workspaces/bbbbbbbbbbbbbbbbbbbbbbbb/boards", { name: "Orphan" });
    assert.equal(missing.status, 404);
    assert.equal(await app.db.collection("boards").countDocuments({}), before);
    assert.equal((await call("GET", `/api/v1/workspaces/${ws.id}/boards`)).body.items.length, 1);
  });

  test("flexible columns: renaming a label keeps the key, and record values keep using the key", async () => {
    const ws = await workspace();
    const b = await board(ws.id, { columns: flexibleColumns });
    const r = await record(b.id, { serial: "SN-9", custom_cost: "120" });
    const columns = b.columns.map((c) => (c.key === "custom_cost" ? { ...c, label: "Cost (PHP)" } : c));
    const patched = await call("PATCH", `/api/v1/boards/${b.id}`, { expectedVersion: 1, columns });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const cost = patched.body.board.columns.find((c) => c.key === "custom_cost");
    assert.equal(cost.label, "Cost (PHP)");
    assert.equal((await call("GET", `/api/v1/records/${r.id}`)).body.record.values.custom_cost, "120");
  });

  test("column changes that would rewrite values are refused (remove column, change type, change key)", async () => {
    const ws = await workspace();
    const b = await board(ws.id, { columns: flexibleColumns });
    const removed = await call("PATCH", `/api/v1/boards/${b.id}`, { expectedVersion: 1, columns: b.columns.filter((c) => c.key !== "custom_cost") });
    assert.equal(removed.status, 400);
    const retyped = await call("PATCH", `/api/v1/boards/${b.id}`, { expectedVersion: 1, columns: b.columns.map((c) => (c.key === "custom_cost" ? { ...c, type: "text" } : c)) });
    assert.equal(retyped.status, 400);
    const noPrimary = await call("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "X", columns: [{ key: "notes", label: "Notes", type: "text" }] });
    assert.equal(noPrimary.status, 400);
    const badType = await call("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "X", columns: [{ key: "serial", label: "Item", type: "formula" }] });
    assert.equal(badType.status, 400);
    const dupKey = await call("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "X", columns: [{ key: "serial", label: "Item", type: "text" }, { key: "serial", label: "Again", type: "text" }] });
    assert.equal(dupKey.status, 400);
    assert.equal((await call("GET", `/api/v1/boards/${b.id}`)).body.board.version, 1, "nothing changed");
  });

  test("groups have stable IDs; a group with records can't be removed; renaming doesn't touch records", async () => {
    const ws = await workspace();
    const b = await board(ws.id, { columns: flexibleColumns });
    const working = b.groups.find((g) => g.name === "Working");
    const r = await record(b.id, { serial: "G-1" }, { groupId: working.id });
    const renamed = await call("PATCH", `/api/v1/boards/${b.id}`, { expectedVersion: 1, groups: b.groups.map((g) => (g.id === working.id ? { id: g.id, name: "In work" } : { id: g.id, name: g.name })) });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal((await call("GET", `/api/v1/records/${r.id}`)).body.record.groupId, working.id);
    const removeUsed = await call("PATCH", `/api/v1/boards/${b.id}`, { expectedVersion: 2, groups: b.groups.filter((g) => g.id !== working.id).map(({ id, name }) => ({ id, name })) });
    assert.equal(removeUsed.status, 400);
    assert.match(removeUsed.body.error.message, /still in a group/);
    const added = await call("PATCH", `/api/v1/boards/${b.id}`, { expectedVersion: 2, groups: [...renamed.body.board.groups.map(({ id, name }) => ({ id, name })), { name: "Escalated", color: "#e5534b" }] });
    assert.equal(added.status, 200);
    assert.match(added.body.board.groups.at(-1).id, /^grp_/);
    assert.equal((await call("POST", `/api/v1/boards/${b.id}/records`, { values: { serial: "X" }, groupId: "grp_doesnotexist" })).status, 400);
  });

  test("saved views get server IDs and the creator", async () => {
    const ws = await workspace();
    const b = await board(ws.id, { columns: flexibleColumns, savedViews: [{ name: "Open items", state: { view: "table", status: "In Progress", visibleColumns: ["serial", "status"], columnWidths: { serial: 220 } } }] });
    assert.match(b.savedViews[0].id, /^view_/);
    assert.equal(b.savedViews[0].createdBy, app.devActor._id.toHexString());
    const nested = await call("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "X", savedViews: [{ name: "Deep", state: { nested: { deeper: { x: 1 } } } }] });
    assert.equal(nested.status, 400);
  });
});

describe("Records", () => {
  let ws, b;
  beforeEach(async () => { ws = await workspace(); b = await board(ws.id, { columns: flexibleColumns }); });

  test("create: workspaceId comes from the board, defaults filled, version 1, values keyed by column key", async () => {
    const r = await record(b.id, { serial: "SN-1", status: "New", custom_cost: 120, custom_done: true, dueDate: "2026-10-09" });
    assert.equal(r.workspaceId, ws.id);
    assert.equal(r.boardId, b.id);
    assert.equal(r.version, 1);
    assert.equal(r.values.custom_cost, 120);
    assert.equal(r.values.custom_done, true);
    const minimal = await record(b.id, { serial: "SN-2" });
    assert.equal(minimal.values.custom_done, false);
    assert.equal(minimal.values.status, "");
    assert.equal(minimal.groupId, null);
    assert.ok(minimal.position < r.position, "new records go first, like the app");
  });

  test("relationships: a client can't choose workspaceId/boardId; a missing board → 404", async () => {
    const other = await workspace("Other");
    const forged = await call("POST", `/api/v1/boards/${b.id}/records`, { values: { serial: "X" }, workspaceId: other.id });
    assert.equal(forged.status, 400);
    assert.match(forged.body.error.message, /Unknown field "workspaceId"/);
    assert.equal((await call("POST", `/api/v1/boards/${b.id}/records`, { values: { serial: "X" }, boardId: b.id })).status, 400);
    assert.equal((await call("POST", "/api/v1/boards/cccccccccccccccccccccccc/records", { values: { serial: "X" } })).status, 404);
    const all = await app.db.collection("records").find({}).toArray();
    const boards = await app.db.collection("boards").find({}).toArray();
    for (const doc of all) {
      const parent = boards.find((x) => x._id.equals(doc.boardId));
      assert.ok(parent, "every record has its board");
      assert.ok(parent.workspaceId.equals(doc.workspaceId), "record.workspaceId matches its board");
    }
  });

  test("validation of values: unknown columns, wrong types, required Item, invalid dates", async () => {
    const bad = [
      { values: {} }, { values: { serial: "" } }, { values: { serial: "A", nope: 1 } }, { values: { serial: "A", custom_done: "yes" } },
      { values: { serial: "A", custom_cost: "12abc" } }, { values: { serial: "A", dueDate: "2026-02-30" } }, { values: { serial: "A", dueDate: "09/10/2026" } },
      { values: { serial: "A", group: "Working" } }, { values: { serial: "x".repeat(10001) } }, { values: "serial" }, {},
      { values: { serial: "A" }, position: "first" }, { values: { serial: "A" }, archived: 1 }
    ];
    for (const body of bad) {
      const res = await call("POST", `/api/v1/boards/${b.id}/records`, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 100));
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    }
  });

  test("operator injection and prototype pollution are rejected before reaching MongoDB", async () => {
    const r = await record(b.id, { serial: "Safe" });
    const attempts = [
      ["POST", `/api/v1/boards/${b.id}/records`, '{"values":{"serial":"A","__proto__":{"polluted":true}}}'],
      ["POST", `/api/v1/boards/${b.id}/records`, '{"values":{"serial":{"$gt":""}}}'],
      ["POST", `/api/v1/boards/${b.id}/records`, '{"values":{"serial":"A"},"$set":{"workspaceId":"x"}}'],
      ["PATCH", `/api/v1/records/${r.id}`, '{"expectedVersion":1,"values":{"values.serial":"A"}}'],
      ["PATCH", `/api/v1/records/${r.id}`, '{"expectedVersion":{"$gt":0},"values":{"serial":"B"}}'],
      ["PATCH", `/api/v1/records/${r.id}`, '{"expectedVersion":1,"values":{"constructor":{"prototype":{"x":1}}}}'],
      ["PATCH", `/api/v1/boards/${b.id}`, '{"expectedVersion":1,"columns":[{"key":"serial","label":"Item","type":"text"},{"key":"__proto__","label":"P","type":"text"}]}'],
      ["POST", "/api/v1/workspaces", '{"name":"A","constructor":{"prototype":{"admin":true}}}']
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(method, path, body, { raw: true });
      assert.equal(res.status, 400, `${method} ${body}`);
    }
    assert.equal({}.polluted, undefined);
    assert.equal((await call("GET", `/api/v1/records/${r.id}`)).body.record.values.serial, "Safe");
    assert.equal((await call("GET", `/api/v1/boards/${b.id}/records?sort[$where]=1`)).status, 400);
    assert.equal((await call("GET", `/api/v1/boards/${b.id}/records?groupId[$ne]=x`)).status, 400);
  });

  test("PATCH changes only the values sent ($set on values.<key>, $inc version, matched on id AND version)", async () => {
    const r = await record(b.id, { serial: "P-1", status: "New", custom_cost: "5" });
    const calls = app.db.collection("records").calls;
    const res = await call("PATCH", `/api/v1/records/${r.id}`, { expectedVersion: 1, values: { status: "Done" }, pinned: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.record.values, { serial: "P-1", status: "Done", custom_cost: "5", custom_done: false, dueDate: "" });
    assert.equal(res.body.record.version, 2);
    const update = calls.filter((c) => c.op === "findOneAndUpdate").at(-1);
    assert.deepEqual(Object.keys(update.filter).sort(), ["_id", "version"]);
    assert.equal(update.filter.version, 1);
    assert.deepEqual(update.update.$inc, { version: 1 });
    assert.deepEqual(Object.keys(update.update.$set).sort(), ["pinned", "updatedAt", "updatedBy", "values.status"]);
    const activity = await app.db.collection("activities").findOne({ action: "record.updated", entityId: update.filter._id });
    assert.deepEqual(activity.changes.map((c) => c.field).sort(), ["pinned", "values.status"]);
  });

  test("CONCURRENCY: client A (v1) succeeds → v2; client B (v1) → 409 CONFLICT; A's data is kept", async () => {
    const r = await record(b.id, { serial: "Shared", status: "New" });
    assert.equal(r.version, 1);
    const clientA = await call("PATCH", `/api/v1/records/${r.id}`, { expectedVersion: 1, values: { status: "In Progress" } });
    assert.equal(clientA.status, 200);
    assert.equal(clientA.body.record.version, 2);
    const clientB = await call("PATCH", `/api/v1/records/${r.id}`, { expectedVersion: 1, values: { status: "Done" } });
    assert.equal(clientB.status, 409);
    assert.equal(clientB.body.error.code, "CONFLICT");
    assert.equal(clientB.body.error.details.currentVersion, 2);
    const stored = (await call("GET", `/api/v1/records/${r.id}`)).body.record;
    assert.equal(stored.values.status, "In Progress");
    assert.equal(stored.version, 2);
    // Simultaneous requests with the same version: exactly one wins.
    const race = await Promise.all([1, 2, 3].map((n) => call("PATCH", `/api/v1/records/${r.id}`, { expectedVersion: 2, values: { serial: `Race ${n}` } })));
    assert.deepEqual(race.map((x) => x.status).sort(), [200, 409, 409]);
    assert.equal((await call("GET", `/api/v1/records/${r.id}`)).body.record.version, 3);
  });

  test("delete is versioned: stale → 409, missing → 404, then the record is gone", async () => {
    const r = await record(b.id, { serial: "Del" });
    await call("PATCH", `/api/v1/records/${r.id}`, { expectedVersion: 1, values: { serial: "Del 2" } });
    assert.equal((await call("DELETE", `/api/v1/records/${r.id}?expectedVersion=1`)).status, 409);
    assert.equal((await call("DELETE", `/api/v1/records/${r.id}`)).status, 400, "expectedVersion is required");
    assert.equal((await call("DELETE", `/api/v1/records/${r.id}?expectedVersion=2`)).status, 200);
    assert.equal((await call("GET", `/api/v1/records/${r.id}`)).status, 404);
    assert.equal((await call("DELETE", `/api/v1/records/${r.id}?expectedVersion=2`)).status, 404);
  });
});

describe("Record pagination, sorting and filtering", () => {
  let b, ids;
  before(async () => {
    const ws = await workspace("Paging");
    b = await board(ws.id, { columns: flexibleColumns });
    ids = [];
    // 125 records with explicit positions; some share a position to prove the _id tie-break.
    for (let i = 0; i < 125; i += 1) ids.push((await record(b.id, { serial: `R-${String(i).padStart(3, "0")}`, status: i % 5 === 0 ? "Done" : "New" }, { position: Math.floor(i / 2) * 10, groupId: i % 2 ? b.groups[1].id : b.groups[0].id })).id);
  });
  const page = (query) => call("GET", `/api/v1/boards/${b.id}/records${query}`);

  test("cursor pages: 50 + 50 + 25, no duplicates, nothing missing, stable order, nextCursor null at the end", async () => {
    const seen = [];
    let cursor = null, pages = 0;
    do {
      const res = await page(`?limit=50${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(res.status, 200);
      seen.push(...res.body.items);
      cursor = res.body.nextCursor;
      pages += 1;
      if (pages === 1) { assert.equal(res.body.items.length, 50); assert.equal(typeof cursor, "string"); }
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.equal(seen.length, 125);
    assert.equal(new Set(seen.map((r) => r.id)).size, 125, "no duplicates");
    assert.deepEqual(new Set(seen.map((r) => r.id)), new Set(ids), "nothing missing");
    for (let i = 1; i < seen.length; i += 1) {
      const [a, z] = [seen[i - 1], seen[i]];
      assert.ok(a.position < z.position || (a.position === z.position && a.id < z.id), "ordered by position, then id");
    }
    const again = await page("?limit=50");
    assert.deepEqual(again.body.items.map((r) => r.id), seen.slice(0, 50).map((r) => r.id), "repeatable");
  });

  test("default limit 50; limit over 200 is rejected (documented contract), as are 0 and non-numbers", async () => {
    const res = await page("");
    assert.equal(res.body.items.length, 50);
    assert.equal(res.body.limit, 50);
    assert.equal((await page("?limit=200")).body.items.length, 125);
    for (const q of ["?limit=201", "?limit=100000", "?limit=0", "?limit=-1", "?limit=abc", "?limit=10&limit=20"]) assert.equal((await page(q)).status, 400, q);
  });

  test("invalid or mismatched cursors → safe 400 VALIDATION_ERROR", async () => {
    const first = await page("?limit=10");
    const cursor = first.body.nextCursor;
    const forged = Buffer.from(JSON.stringify({ s: "position", d: "asc", v: { $gt: 0 }, id: "aaaaaaaaaaaaaaaaaaaaaaaa" })).toString("base64url");
    for (const bad of ["garbage!", "eyJub3QiOiJqc29uIn0", forged, `${cursor}x`]) {
      const res = await page(`?limit=10&cursor=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, bad);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.doesNotMatch(res.body.error.message, /Unexpected|JSON|at /);
    }
    assert.equal((await page(`?limit=10&cursor=${cursor}&sort=updatedAt`)).status, 400, "a cursor is bound to its sort");
  });

  test("sorting: allowlisted fields and directions only", async () => {
    const desc = await page("?sort=createdAt&dir=desc&limit=200");
    assert.equal(desc.status, 200);
    const created = desc.body.items.map((r) => r.createdAt);
    assert.deepEqual(created, [...created].sort().reverse());
    let cursor = null; const seen = new Set();
    do { const res = await page(`?sort=updatedAt&dir=desc&limit=40${cursor ? `&cursor=${cursor}` : ""}`); res.body.items.forEach((r) => seen.add(r.id)); cursor = res.body.nextCursor; } while (cursor);
    assert.equal(seen.size, 125);
    for (const q of ["?sort=values.status", "?sort=_id", "?sort=name", "?dir=up", "?sort=%7B%22position%22%3A1%7D"]) assert.equal((await page(q)).status, 400, q);
    const sortCalls = app.db.collection("records").calls.filter((c) => c.op === "find" && c.options?.sort);
    for (const c of sortCalls) for (const key of Object.keys(c.options.sort)) assert.ok(["position", "createdAt", "updatedAt", "_id"].includes(key), key);
  });

  test("filters: groupId and exact status (the board's status column); unknown params rejected", async () => {
    const grouped = await page(`?groupId=${b.groups[1].id}&limit=200`);
    assert.equal(grouped.body.items.length, 62);
    assert.ok(grouped.body.items.every((r) => r.groupId === b.groups[1].id));
    const done = await page("?status=Done&limit=200");
    assert.equal(done.body.items.length, 25);
    assert.ok(done.body.items.every((r) => r.values.status === "Done"));
    assert.equal((await page("?groupId=grp_unknown123")).status, 400);
    assert.equal((await page("?owner=me")).status, 400);
    assert.equal((await page("?archived=maybe")).status, 400);
    assert.equal((await page("?archived=false&limit=200")).body.items.length, 125);
  });
});

describe("Deletes and cascades", () => {
  test("CASCADE: deleting a workspace removes its boards, records and memberships — and nothing else", async () => {
    const keep = await workspace("Keep");
    const keepBoard = await board(keep.id);
    await record(keepBoard.id, { serial: "Keep me" });
    const doomed = await workspace("Doomed");
    const b1 = await board(doomed.id), b2 = await board(doomed.id, { name: "Second" });
    for (const target of [b1, b2]) for (let i = 0; i < 3; i += 1) await record(target.id, { serial: `D-${i}` });
    const id = doomed.id;
    const count = async (collection, field) => (await app.db.collection(collection).find({}).toArray()).filter((d) => d[field]?.toHexString?.() === id).length;
    assert.equal(await count("boards", "workspaceId"), 2);
    assert.equal(await count("records", "workspaceId"), 6);

    assert.equal((await call("DELETE", `/api/v1/workspaces/${id}?expectedVersion=7`)).status, 409, "stale version rejected");
    assert.equal(await count("records", "workspaceId"), 6, "nothing removed on conflict");
    const transactionsBefore = app.fake.transactionsRun;
    const res = await call("DELETE", `/api/v1/workspaces/${id}?expectedVersion=1`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.removed, { boards: 2, records: 6, memberships: 1 });
    assert.ok(app.fake.transactionsRun > transactionsBefore, "cascade ran in a transaction");
    for (const [collection, field] of [["boards", "workspaceId"], ["records", "workspaceId"], ["workspaceMembers", "workspaceId"]]) assert.equal(await count(collection, field), 0, collection);
    assert.equal((await call("GET", `/api/v1/workspaces/${id}`)).status, 404);
    assert.equal((await call("GET", `/api/v1/boards/${b1.id}`)).status, 404);
    // Untouched neighbours, and the audit trail keeps a deletion entry.
    assert.equal((await call("GET", `/api/v1/boards/${keepBoard.id}/records`)).body.items.length, 1);
    assert.ok(await app.db.collection("activities").findOne({ action: "workspace.deleted" }));
    // Every bulk delete was scoped to that one workspace ObjectId.
    for (const c of ["records", "boards", "workspaceMembers"].flatMap((n) => app.db.collection(n).calls.filter((x) => x.op === "deleteMany"))) {
      assert.deepEqual(Object.keys(c.filter), [c.filter.workspaceId ? "workspaceId" : "boardId"]);
    }
  });

  test("CASCADE: deleting a board removes only its records", async () => {
    const ws = await workspace();
    const b1 = await board(ws.id), b2 = await board(ws.id, { name: "Neighbour" });
    for (let i = 0; i < 4; i += 1) await record(b1.id, { serial: `B1-${i}` });
    await record(b2.id, { serial: "B2" });
    const res = await call("DELETE", `/api/v1/boards/${b1.id}?expectedVersion=1`);
    assert.deepEqual(res.body.removed, { records: 4 });
    assert.equal((await app.db.collection("records").find({}).toArray()).filter((r) => r.boardId.toHexString() === b1.id).length, 0);
    assert.equal((await call("GET", `/api/v1/boards/${b2.id}/records`)).body.items.length, 1);
    assert.equal((await call("GET", `/api/v1/workspaces/${ws.id}`)).status, 200);
  });

  test("the transaction itself removes the children: even if the post-commit sweep fails, no orphans remain", async () => {
    const ws = await workspace("Sweep");
    const b = await board(ws.id);
    for (let i = 0; i < 3; i += 1) await record(b.id, { serial: `S-${i}` });
    // First records deleteMany (inside the transaction) succeeds; the second (the sweep) fails.
    app.fake.failNext({ collection: "records", op: "deleteMany", skip: 1, error: new MongoNetworkError("connection reset (fake)") });
    const res = await call("DELETE", `/api/v1/workspaces/${ws.id}?expectedVersion=1`);
    assert.equal(res.status, 200, "the committed delete is reported as successful");
    assert.equal(res.body.removed.records, 3);
    assert.equal((await app.db.collection("records").find({}).toArray()).filter((r) => r.workspaceId.toHexString() === ws.id).length, 0);
    assert.equal((await app.db.collection("boards").find({}).toArray()).filter((x) => x.workspaceId.toHexString() === ws.id).length, 0);
    assert.ok(app.logger.errors.some((line) => /post-commit sweep/.test(line) && !/fake.invalid/.test(line)));
    const inTransaction = app.db.collection("records").calls.filter((c) => c.op === "deleteMany" && c.options?.session);
    assert.ok(inTransaction.length > 0, "record deletes ran inside the transaction");
  });

  test("a failure inside the cascade rolls everything back", async () => {
    const ws = await workspace("Rollback");
    const b = await board(ws.id);
    await record(b.id, { serial: "Survivor" });
    app.fake.failNext({ collection: "workspaces", op: "deleteOne", error: new MongoNetworkError("connection reset (fake)") });
    const res = await call("DELETE", `/api/v1/workspaces/${ws.id}?expectedVersion=1`);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "SERVICE_UNAVAILABLE");
    assert.equal((await call("GET", `/api/v1/boards/${b.id}/records`)).body.items.length, 1, "records restored");
    assert.equal((await call("GET", `/api/v1/boards/${b.id}`)).status, 200, "board restored");
  });
});

describe("Representation, errors and protection", () => {
  test("responses use id (never _id), string references and ISO 8601 dates", async () => {
    const ws = await workspace();
    const b = await board(ws.id, { columns: flexibleColumns });
    const r = await record(b.id, { serial: "Repr" });
    for (const path of ["/api/v1/workspaces", `/api/v1/workspaces/${ws.id}`, `/api/v1/workspaces/${ws.id}/boards`, `/api/v1/boards/${b.id}`, `/api/v1/boards/${b.id}/records`, `/api/v1/records/${r.id}`]) {
      const res = await call("GET", path);
      assert.equal(res.status, 200, path);
      assert.ok(noMongoKeys(res.body), `${path} has no Mongo-specific keys`);
    }
    for (const value of [ws.createdAt, ws.updatedAt, b.createdAt, r.createdAt, r.updatedAt, b.savedViews.length ? b.savedViews[0].createdAt : ws.createdAt]) assert.match(value, ISO);
    for (const value of [ws.id, b.id, b.workspaceId, r.id, r.boardId, r.workspaceId, r.createdBy]) assert.match(value, HEX);
    const stored = await app.db.collection("records").findOne({ "values.serial": "Repr" });
    assert.ok(stored.createdAt instanceof Date && stored.updatedAt instanceof Date);
  });

  test("MongoDB errors map to the API contract and never leak driver text", async () => {
    const ws = await workspace();
    const cases = [
      [new MongoServerError({ message: "E11000 duplicate key error collection: jarc_database.records index: uniq_board_legacy_id", code: 11000 }), 409, "CONFLICT"],
      [new MongoNetworkError("connect ECONNREFUSED cluster0-shard.mongodb.net"), 503, "SERVICE_UNAVAILABLE"],
      [new MongoServerError({ message: "Unrecognized pipeline stage at jarc_database.boards", code: 40324 }), 500, "INTERNAL_ERROR"]
    ];
    for (const [error, status, code] of cases) {
      app.fake.failNext({ collection: "boards", op: "insertOne", error });
      const res = await call("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Fails" });
      assert.equal(res.status, status);
      assert.equal(res.body.error.code, code);
      assert.doesNotMatch(JSON.stringify(res.body), /E11000|jarc_database|mongodb\.net|ECONNREFUSED|index|pipeline/);
    }
    assert.ok(app.logger.errors.some((line) => /database error/.test(line)), "the server-side log keeps the details");
  });

  test("health reports database connected/unavailable; ready answers 503 when the database is down", async () => {
    const health = await call("GET", "/api/v1/health");
    assert.equal(health.body.database, "connected");
    assert.equal(health.body.status, "ok");
    assert.doesNotMatch(JSON.stringify(health.body), /mongodb|cluster|jarc_database|uri|user/i);
    assert.equal((await call("GET", "/api/v1/health/ready")).status, 200);
    app.fake.down = true;
    try {
      const degraded = await call("GET", "/api/v1/health");
      assert.equal(degraded.status, 200);
      assert.deepEqual([degraded.body.status, degraded.body.database], ["degraded", "unavailable"]);
      const ready = await call("GET", "/api/v1/health/ready");
      assert.equal(ready.status, 503);
      assert.equal(ready.body.error.code, "SERVICE_UNAVAILABLE");
      const list = await call("GET", "/api/v1/workspaces");
      assert.equal(list.status, 503);
      assert.equal(list.body.error.code, "SERVICE_UNAVAILABLE");
    } finally { app.fake.down = false; }
  });

  test("responses are labelled pre-auth development", async () => {
    const res = await fetch(`${base}/api/v1/workspaces`);
    assert.equal(res.headers.get("x-jarc-auth"), "development-pre-auth");
  });

  test("PRE-AUTH PROTECTION: production never serves the resource API", async () => {
    // createApp refuses to build a production app with pre-auth APIs, even if asked directly.
    assert.throws(() => createApp({ environment: "production", enableDevStateApi: false, dataLayer: app.dataLayer, devActor: app.devActor, enableDevResourceApi: true }), /can't be enabled in production/);
    // A production app with MongoDB connected: health works, every resource path is a JSON 404.
    const prod = await startApp({ environment: "production", enableDevStateApi: false, repository: null, dataLayer: app.dataLayer, enableDevResourceApi: false });
    try {
      for (const [method, path] of [["GET", "/api/v1/workspaces"], ["POST", "/api/v1/workspaces"], ["GET", "/api/v1/boards/aaaaaaaaaaaaaaaaaaaaaaaa/records"], ["PATCH", "/api/v1/records/aaaaaaaaaaaaaaaaaaaaaaaa"], ["POST", "/api/v1/imports"], ["GET", "/api/v1/state"]]) {
        const res = await api(prod.url, method, path, method === "GET" ? undefined : {});
        assert.equal(res.status, 404, `${method} ${path}`);
        assert.equal(res.body.error.code, "NOT_FOUND");
      }
      assert.equal((await api(prod.url, "GET", "/api/v1/health")).body.database, "connected");
    } finally { await prod.close(); }
    // The development actor itself refuses production.
    const { ensureDevelopmentActor, devActorMiddleware } = require("../src/context/dev-actor");
    await assert.rejects(ensureDevelopmentActor(app.dataLayer.repos.users, { environment: "production" }), /never available in production/);
    assert.throws(() => devActorMiddleware(app.devActor, { environment: "production" }), /never available in production/);
  });

  test("the development actor is created once and is not an Entra identity", async () => {
    const { ensureDevelopmentActor } = require("../src/context/dev-actor");
    const again = await ensureDevelopmentActor(app.dataLayer.repos.users, { environment: "test" });
    assert.ok(again._id.equals(app.devActor._id));
    const users = await app.db.collection("users").find({}).toArray();
    assert.equal(users.length, 1);
    assert.deepEqual([users[0].source, users[0].entraObjectId, users[0].tenantId, users[0].email], ["development", null, null, null]);
  });
});
