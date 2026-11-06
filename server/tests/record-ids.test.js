// Record IDs: every record's permanent ID is its stored _id, shown as the boards' read-only "Record ID" system column and used by
// GET /api/v1/external/records/:id. The real app with Entra sign-in on the fake MongoDB, with synthetic data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { COLLECTIONS } = require("../src/db/bootstrap");
const { RECORD_ID_KEY } = require("../src/validation/common");
const { FakeMongoClient } = require("./support/fake-mongo");

const KEY = crypto.randomBytes(32);
const COLUMNS = [{ key: "serial", label: "Customer", type: "text", required: true }, { key: "ref", label: "Item ID", type: "text" }, { key: "status", label: "Status", type: "status", options: ["New", "Done"] }];
const HEX = /^[0-9a-f]{24}$/;
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

let app, issuer, people;
const clients = new Map();
async function browserOf(person) {
  if (!clients.has(person.name)) { const c = new SessionClient(app.url, app.entra.appOrigin); assert.equal((await c.signIn(person)).status, 201); clients.set(person.name, c); }
  return clients.get(person.name);
}
const as = async (person, method, url, body) => (await browserOf(person)).request(method, url, body);
const userId = async (person) => (await as(person, "GET", "/api/v1/me")).body.user.id;
async function call(token, url) {
  const res = await fetch(`${app.url}/api/v1/external${url}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const list = (person, boardId, params) => as(person, "GET", `/api/v1/boards/${boardId}/records?${new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])))}`);

// A workspace with a real admin and viewer, and a board of synthetic records with a business "Item ID" column (BH-… codes).
async function workspace(name, rows = 3) {
  const ws = (await as(people.sysadmin, "POST", "/api/v1/workspaces", { name })).body.workspace;
  for (const [key, role] of [["admin", "WORKSPACE_ADMIN"], ["viewer", "VIEWER"]]) assert.equal((await as(people.sysadmin, "POST", `/api/v1/workspaces/${ws.id}/members`, { userId: await userId(people[key]), role })).status, 201);
  const board = (await as(people.sysadmin, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: `${name} board`, columns: COLUMNS })).body.board;
  const records = rows ? (await as(people.sysadmin, "POST", `/api/v1/boards/${board.id}/records/batch`, { records: Array.from({ length: rows }, (_, i) => ({ values: { serial: `Customer ${i + 1}`, ref: `BH-11200${i + 1}`, status: "New" } })) })).body.items : [];
  return { ws, board, records };
}

before(async () => {
  issuer = await createTokenIssuer();
  app = await startEntraApp({ issuer, apiTokens: { key: KEY, issuePerHour: 1000, maxActive: 1000 } });
  people = { sysadmin: issuer.person("Sys Admin", { admin: true }), admin: issuer.person("Ada Admin"), viewer: issuer.person("Vik Viewer"), outsider: issuer.person("Oona Outsider") };
  for (const p of Object.values(people)) await browserOf(p);
});
after(async () => { await app.close(); });

describe("Every record has a permanent ID", () => {
  test("new records get unique IDs at once, and an imported-style Item ID column keeps its own values", async () => {
    const f = await workspace("New IDs", 5);
    const ids = f.records.map((r) => r.id);
    assert.ok(ids.every((id) => HEX.test(id)), "24-character IDs");
    assert.equal(new Set(ids).size, ids.length, "all different");
    const one = (await as(people.admin, "POST", `/api/v1/boards/${f.board.id}/records`, { values: { serial: "Single", ref: "BH-999" } })).body.record;
    assert.ok(HEX.test(one.id) && !ids.includes(one.id));
    assert.deepEqual(f.records.map((r) => r.values.ref), ["BH-112001", "BH-112002", "BH-112003", "BH-112004", "BH-112005"], "business IDs untouched");
    assert.ok(!f.board.columns.some((c) => c.key === RECORD_ID_KEY), "no column is added to the board");
  });

  test("renaming, editing, moving between groups, reordering, pinning and archiving keep the ID", async () => {
    const f = await workspace("Stable", 2);
    const [a] = f.records, group = f.board.groups[0].id;
    let v = a.version;
    const patch = async (change) => { const res = await as(people.admin, "PATCH", `/api/v1/records/${a.id}`, { expectedVersion: v, ...change }); assert.equal(res.status, 200, JSON.stringify(res.body)); v = res.body.record.version; assert.equal(res.body.record.id, a.id); return res.body.record; };
    await patch({ values: { serial: "Renamed", status: "Done" } });
    await patch({ groupId: group });
    await patch({ groupId: f.board.groups[1].id });
    await patch({ position: -1000 });
    await patch({ pinned: true });
    await patch({ archived: true });
    await patch({ archived: false });
    const now = (await as(people.viewer, "GET", `/api/v1/records/${a.id}`)).body.record;
    assert.deepEqual([now.id, now.values.serial, now.values.ref], [a.id, "Renamed", "BH-112001"]);
  });

  test("two employees see the same ID for the same record, every time", async () => {
    const f = await workspace("Shared", 3);
    const seen = async (p) => (await as(p, "GET", `/api/v1/boards/${f.board.id}/records`)).body.items.map((r) => [r.values.serial, r.id]).sort();
    const [admin, viewer] = [await seen(people.admin), await seen(people.viewer)];
    assert.deepEqual(viewer, admin);
    assert.deepEqual(await seen(people.viewer), viewer, "reading again changes nothing");
  });

  test("a deleted record's ID is never given to another record", async () => {
    const f = await workspace("No reuse", 2);
    const gone = f.records[0];
    assert.equal((await as(people.admin, "POST", `/api/v1/boards/${f.board.id}/records/delete`, { records: [{ id: gone.id, expectedVersion: gone.version }] })).status, 200);
    const fresh = (await as(people.admin, "POST", `/api/v1/boards/${f.board.id}/records/batch`, { records: Array.from({ length: 20 }, (_, i) => ({ values: { serial: `New ${i}` } })) })).body.items;
    assert.ok(!fresh.some((r) => r.id === gone.id));
    assert.equal((await as(people.admin, "GET", `/api/v1/records/${gone.id}`)).status, 404);
  });

  test("the system key can't be used by a real column", async () => {
    const f = await workspace("Reserved", 0);
    const board = (await as(people.sysadmin, "GET", `/api/v1/boards/${f.board.id}`)).body.board;
    const res = await as(people.sysadmin, "POST", `/api/v1/boards/${f.board.id}/columns`, { expectedVersion: board.version, column: { key: RECORD_ID_KEY, label: "Sneaky", type: "text" } });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /Record ID/);
    assert.equal((await as(people.sysadmin, "POST", `/api/v1/workspaces/${f.ws.id}/boards`, { name: "Also sneaky", columns: [...COLUMNS, { key: RECORD_ID_KEY, label: "x", type: "text" }] })).status, 400);
  });
});

describe("Searching and sorting by Record ID", () => {
  let f, ids;
  before(async () => {
    f = await workspace("Sorting", 0);
    // Inserted directly: 230 records with deliberately shuffled IDs, so ID order differs from position order.
    const now = new Date(), docs = Array.from({ length: 230 }, (_, i) => ({ _id: new ObjectId(), workspaceId: new ObjectId(f.ws.id), boardId: new ObjectId(f.board.id), values: { serial: `R${i}`, ref: `BH-${i}` }, groupId: null, position: (i * 7919) % 230, archived: false, pinned: i === 7, createdBy: null, updatedBy: null, createdAt: now, updatedAt: now, version: 1 }));
    await app.db.collection(COLLECTIONS.records).insertMany(docs);
    ids = docs.map((d) => d._id.toHexString());
  });

  for (const dir of ["asc", "desc"]) {
    test(`sorted by Record ID (${dir}), page by page: every record once, in ID order after pinned`, async () => {
      const seen = []; let cursor = null;
      do {
        const res = await list(people.viewer, f.board.id, { orderBy: [{ key: "pinned", dir: "desc" }, { key: RECORD_ID_KEY, dir }], limit: "37", ...(cursor ? { cursor } : {}) });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        seen.push(...res.body.items.map((r) => r.id));
        cursor = res.body.nextCursor;
      } while (cursor);
      const pinned = ids[7], rest = ids.filter((id) => id !== pinned).sort();
      assert.deepEqual(seen, [pinned, ...(dir === "asc" ? rest : rest.reverse())]);
    });
  }

  test("a sort key after the Record ID changes nothing and is dropped", async () => {
    const res = await list(people.viewer, f.board.id, { orderBy: [{ key: RECORD_ID_KEY, dir: "asc" }, { key: "serial", dir: "desc" }], limit: "5" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((r) => r.id), [...ids].sort().slice(0, 5));
  });

  test("searching for an exact Record ID finds that one record, and only on its own board", async () => {
    const target = ids[123];
    const res = await list(people.viewer, f.board.id, { also: { op: "and", rules: [{ key: RECORD_ID_KEY, cmp: "in", values: [target] }] } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.items.map((r) => [r.id, r.values.serial]), [[target, "R123"]]);
    assert.equal((await list(people.viewer, f.board.id, { also: { op: "and", rules: [{ key: RECORD_ID_KEY, cmp: "in", values: [target.toUpperCase()] }] } })).body.items[0]?.id, target, "case doesn't matter");
    const other = await workspace("Other board", 1);
    assert.deepEqual((await list(people.admin, other.board.id, { also: { op: "and", rules: [{ key: RECORD_ID_KEY, cmp: "in", values: [target] }] } })).body.items, [], "another board's record isn't found");
  });

  test("only exact IDs: anything else is refused before it reaches the database", async () => {
    for (const rule of [{ key: RECORD_ID_KEY, cmp: "contains", values: ["abc"] }, { key: RECORD_ID_KEY, cmp: "in", values: ["not-an-id"] }, { key: RECORD_ID_KEY, cmp: "in", values: [{ $gt: "" }] }]) {
      assert.equal((await list(people.viewer, f.board.id, { also: { op: "and", rules: [rule] } })).status, 400, JSON.stringify(rule));
    }
  });

  test("an outsider can't search the board, whatever ID they know", async () => {
    assert.equal((await list(people.outsider, f.board.id, { also: { op: "and", rules: [{ key: RECORD_ID_KEY, cmp: "in", values: [ids[0]] }] } })).status, 404);
  });
});

describe("Record API access", () => {
  let f, other, secret;
  before(async () => {
    f = await workspace("API", 2); other = await workspace("API elsewhere", 1);
    secret = (await as(people.viewer, "POST", "/api/v1/me/api-tokens", { name: "One token", workspaceId: f.ws.id, boardIds: [f.board.id], scopes: ["read"], expiresAt: inDays(7) })).body.secret;
    assert.match(secret, /^jarc_/);
  });

  test("one token reads any record on its boards by Record ID; business columns come back unchanged", async () => {
    for (const r of f.records) {
      const res = await call(secret, `/records/${r.id}`);
      assert.equal(res.status, 200);
      assert.deepEqual([res.body.record.id, res.body.record.boardId, res.body.record.values.ref], [r.id, f.board.id, r.values.ref]);
    }
  });

  test("knowing a Record ID opens nothing: no token, a bad token, or a record outside the token's boards", async () => {
    assert.equal((await call(null, `/records/${f.records[0].id}`)).status, 401);
    assert.equal((await call("jarc_000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", `/records/${f.records[0].id}`)).status, 401);
    assert.equal((await call(secret, `/records/${other.records[0].id}`)).status, 404);
    assert.equal((await call(secret, `/records/${new ObjectId().toHexString()}`)).status, 404);
  });

  test("the API Explorer previews one record exactly as the token API returns it, with the caller's own access", async () => {
    const id = f.records[1].id, url = `/api/v1/me/api-explorer/boards/${f.board.id}?record=${id}`;
    const res = await as(people.viewer, "GET", url);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.record, (await call(secret, `/records/${id}`)).body.record);
    assert.equal((await as(people.viewer, "GET", `/api/v1/me/api-explorer/boards/${f.board.id}?record=${other.records[0].id}`)).status, 404, "a record on another board");
    assert.equal((await as(people.outsider, "GET", url)).status, 404, "not a member");
    assert.equal((await as(people.viewer, "GET", `/api/v1/me/api-explorer/boards/${f.board.id}?record=nope`)).status, 400);
  });
});

describe("Isolation of this test", () => {
  test("it ran on the in-memory fake database, never a real one", () => {
    assert.ok(app.fake instanceof FakeMongoClient);
    assert.equal(app.connection.uri, "mongodb://fake.invalid");
  });
});
