// Personal and shared saved views: a personal view reaches only the person who made it (never colleagues, never an API key);
// saving a board keeps everyone else's personal views; Viewers may keep personal views but not change shared ones; views
// never touch records. The real app with Entra sign-in on the fake MongoDB (role_based), synthetic people and data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "qty", label: "Qty", type: "number" }];
const FILTER = { op: "and", rules: [{ key: "qty", cmp: "gte", values: ["2"] }] };

describe("Personal and shared saved views", () => {
  let app, issuer, people, board, ws;
  const clients = new Map();
  const browserOf = async (p) => { if (!clients.has(p.oid)) { const c = new SessionClient(app.url, app.entra.appOrigin); assert.equal((await c.signIn(p)).status, 201); clients.set(p.oid, c); } return clients.get(p.oid); };
  const as = async (p, method, url, body) => (await browserOf(p)).request(method, url, body);
  const get = async (p) => (await as(p, "GET", `/api/v1/boards/${board.id}`)).body.board;
  const put = async (p, views) => { const b = await get(p); return as(p, "PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, savedViews: views }); };
  const mine = (b) => b.savedViews.map(({ id, name, state, personal }) => ({ id, name, state, personal: personal === true }));
  const names = (b) => b.savedViews.map((v) => v.name).sort();

  before(async () => {
    issuer = await createTokenIssuer();
    people = { owner: issuer.person("Owner Person", { admin: true }), editor: issuer.person("Editor Person"), viewer: issuer.person("Viewer Person") };
    app = await startEntraApp({ issuer });
    ws = (await as(people.owner, "POST", "/api/v1/workspaces", { name: "Views" })).body.workspace;
    for (const [p, role] of [[people.editor, "MEMBER"], [people.viewer, "VIEWER"]]) {
      const id = (await as(p, "GET", "/api/v1/me")).body.user.id;
      assert.equal((await as(people.owner, "POST", `/api/v1/workspaces/${ws.id}/members`, { userId: id, role })).status, 201);
    }
    board = (await as(people.owner, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Board", columns: COLUMNS })).body.board;
    assert.equal((await as(people.owner, "POST", `/api/v1/boards/${board.id}/records/batch`, { records: [1, 2, 3].map((n) => ({ values: { serial: `R${n}`, qty: n } })) })).status, 201);
  });
  after(async () => { await app?.close(); });

  test("a personal view is seen only by its creator; a shared one by everyone", async () => {
    const res = await put(people.editor, [{ name: "Team", state: { view: "table", filter: FILTER } }, { name: "Editor's own", personal: true, state: { view: "table" } }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(names(res.body.board), ["Editor's own", "Team"], "the creator sees both in the response");
    assert.equal(res.body.board.savedViews.find((v) => v.name === "Editor's own").personal, true);
    assert.deepEqual(names(await get(people.owner)), ["Team"], "not even a workspace admin sees someone else's personal view");
    assert.deepEqual(names(await get(people.viewer)), ["Team"]);
    const listed = (await as(people.owner, "GET", `/api/v1/workspaces/${ws.id}/boards`)).body.items.find((b) => b.id === board.id);
    assert.deepEqual(names(listed), ["Team"], "the board list hides it too");
  });

  test("saving the board keeps colleagues' personal views; their IDs can't be reused or reached", async () => {
    const owner = await get(people.owner);
    const res = await put(people.owner, [...mine(owner), { name: "Owner's own", personal: true, state: {} }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(names(await get(people.editor)), ["Editor's own", "Team"], "the editor's personal view survived the owner's save");
    // Stored apart: the board document holds only shared views; each person's personal views have their own document.
    const stored = await app.db.collection("boards").findOne({ name: "Board" });
    assert.deepEqual(stored.savedViews.map((v) => v.name), ["Team"]);
    assert.ok(!stored.savedViews.some((v) => "personal" in v));
    const privateDocs = await app.db.collection("personalViews").find({}).toArray();
    assert.deepEqual(privateDocs.map((d) => d.views.map((v) => v.name)).sort(), [["Editor's own"], ["Owner's own"]]);
    assert.ok(privateDocs.every((d) => d._id === `${d.boardId}:${d.userId}`), "one document per board and person, found by _id");
    const version = stored.version;
    assert.equal((await put(people.editor, mine(await get(people.editor)).map((v) => (v.personal ? { ...v, name: "Editor's own, renamed" } : v)))).status, 200);
    assert.equal((await app.db.collection("boards").findOne({ name: "Board" })).version, version, "a personal change doesn't touch the board");
    assert.equal((await put(people.editor, mine(await get(people.editor)).map((v) => (v.personal ? { ...v, name: "Editor's own" } : v)))).status, 200);
    // Deleting every view the owner sees still leaves the editor's personal view, and every record.
    assert.equal((await put(people.owner, [])).status, 200);
    assert.deepEqual(names(await get(people.editor)), ["Editor's own"]);
    assert.equal((await as(people.owner, "GET", `/api/v1/boards/${board.id}/records/count`)).body.total, 3, "views never touch records");
  });

  test("only the creator can make a view personal; sharing it back works", async () => {
    assert.equal((await put(people.owner, [{ name: "Owner shared", state: {} }])).status, 200);
    const editor = await get(people.editor), shared = mine(editor).find((v) => v.name === "Owner shared");
    const steal = await put(people.editor, mine(editor).map((v) => (v.id === shared.id ? { ...v, personal: true } : v)));
    assert.equal(steal.status, 400, "a colleague's shared view can't vanish into someone's personal list");
    const own = mine(editor).find((v) => v.name === "Editor's own");
    const back = await put(people.editor, mine(editor).map((v) => (v.id === own.id ? { ...v, personal: false } : v)));
    assert.equal(back.status, 200);
    assert.ok(names(await get(people.owner)).includes("Editor's own"), "shared with the board now");
    const again = await put(people.editor, mine(await get(people.editor)).map((v) => (v.id === own.id ? { ...v, personal: true } : v)));
    assert.equal(again.status, 200, "and personal again, by its creator");
    assert.ok(!names(await get(people.owner)).includes("Editor's own"));
  });

  test("a Viewer keeps personal views, but can't change shared ones or anything else on the board", async () => {
    const viewer = await get(people.viewer);
    const ok = await put(people.viewer, [...mine(viewer), { name: "Viewer's own", personal: true, state: { filter: FILTER } }]);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(names(await get(people.editor)), ["Editor's own", "Owner shared"], "nobody else sees it");
    const now = await get(people.viewer);
    assert.equal((await put(people.viewer, [...mine(now), { name: "Viewer shared", state: {} }])).status, 403, "no new shared view");
    assert.equal((await put(people.viewer, mine(now).map((v) => (v.personal ? v : { ...v, name: "Renamed" })))).status, 403, "no renaming a shared view");
    assert.equal((await put(people.viewer, mine(now).filter((v) => v.personal))).status, 403, "no deleting a shared view");
    assert.equal((await as(people.viewer, "PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: now.version, name: "Hijacked" })).status, 403, "other fields still need an editor");
  });

  test("an older page that doesn't send personal keeps the stored flag", async () => {
    const editor = await get(people.editor);
    const legacy = editor.savedViews.map(({ id, name, state }) => ({ id, name, state }));
    assert.equal((await put(people.editor, legacy)).status, 200);
    assert.equal((await get(people.editor)).savedViews.find((v) => v.name === "Editor's own").personal, true);
  });
});

describe("Switches off (JARC_FEATURE_PERSONAL_VIEWS / JARC_FEATURE_CONNECT_BOARDS = false): nothing new of either kind", () => {
  const { startMongoApp, api } = require("./helpers");
  let app, board;
  const call = (method, p, body) => api(app.url, method, p, body);
  before(async () => {
    app = await startMongoApp({ app: { features: { personalViews: false, connectBoards: false } } });
    const ws = (await call("POST", "/api/v1/workspaces", { name: "Off" })).body.workspace;
    board = (await call("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Off board", columns: [{ key: "serial", label: "Item", type: "text", required: true }] })).body.board;
  });
  after(async () => { await app?.close(); });
  test("the page is told both are off", async () => {
    const f = (await call("GET", "/api/v1/features")).body.features;
    assert.equal(f.personalViews, false); assert.equal(f.connectBoards, false);
  });
  test("shared views still save; a personal one is refused", async () => {
    assert.equal((await call("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: board.version, savedViews: [{ name: "Shared", state: {} }] })).status, 200);
    const b = (await call("GET", `/api/v1/boards/${board.id}`)).body.board;
    const res = await call("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, savedViews: [...b.savedViews.map(({ id, name, state }) => ({ id, name, state })), { name: "Mine", personal: true, state: {} }] });
    assert.equal(res.status, 400); assert.match(res.body.error.message, /switched on/);
    assert.equal(await app.db.collection("personalViews").countDocuments({}), 0, "nothing stored");
  });
  test("no new Connect or Mirror column, on a new board or an existing one", async () => {
    const b = (await call("GET", `/api/v1/boards/${board.id}`)).body.board;
    assert.equal((await call("POST", `/api/v1/boards/${board.id}/columns`, { expectedVersion: b.version, column: { key: "c", label: "C", type: "connect", link: { boardId: board.id } } })).status, 400);
    const ws = b.workspaceId;
    assert.equal((await call("POST", `/api/v1/workspaces/${ws}/boards`, { name: "X", columns: [{ key: "serial", label: "Item", type: "text", required: true }, { key: "c", label: "C", type: "connect", link: { boardId: board.id } }] })).status, 400);
    assert.equal((await call("POST", `/api/v1/boards/${board.id}/columns`, { expectedVersion: b.version, column: { key: "t", label: "T", type: "text" } })).status, 201, "other columns as before");
  });
});

describe("Switched off AFTER use (the same database): what exists keeps working and stays private; nothing new; links frozen", () => {
  const { startMongoApp, api } = require("./helpers");
  const { FakeMongoClient } = require("./support/fake-mongo");
  let on, off, board, target, rec;
  before(async () => {
    const fake = new FakeMongoClient();
    on = await startMongoApp({ fake, app: { features: { personalViews: true, connectBoards: true } } });
    off = await startMongoApp({ fake, app: { features: { personalViews: false, connectBoards: false } } });
    const ws = (await api(on.url, "POST", "/api/v1/workspaces", { name: "Used" })).body.workspace;
    target = (await api(on.url, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Target", columns: [{ key: "serial", label: "Item", type: "text", required: true }, { key: "n", label: "N", type: "number" }] })).body.board;
    const t = (await api(on.url, "POST", `/api/v1/boards/${target.id}/records/batch`, { records: [{ values: { serial: "T1", n: 4 } }, { values: { serial: "T2", n: 6 } }] })).body.items.map((r) => r.id);
    board = (await api(on.url, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Source", columns: [{ key: "serial", label: "Item", type: "text", required: true }, { key: "c", label: "C", type: "connect", link: { boardId: target.id }, multiple: true }, { key: "m", label: "M", type: "mirror", mirror: { via: "c", column: "n", show: "sum" } }] })).body.board;
    rec = (await api(on.url, "POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "S1", c: [t[0]] } })).body.record;
    rec.links = t;
    const b = (await api(on.url, "GET", `/api/v1/boards/${board.id}`)).body.board;
    assert.equal((await api(on.url, "PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, savedViews: [{ name: "Shared", state: {} }, { name: "Mine", personal: true, state: {} }] })).status, 200);
  });
  after(async () => { await off?.close(); await on?.close(); });
  test("personal views: still the owner's, still private; editing them works; no new ones", async () => {
    const b = (await api(off.url, "GET", `/api/v1/boards/${board.id}`)).body.board;
    assert.deepEqual(b.savedViews.map((v) => [v.name, Boolean(v.personal)]), [["Shared", false], ["Mine", true]]);
    const views = b.savedViews.map(({ id, name, state, personal }) => ({ id, name: personal ? "Mine (renamed)" : name, state, personal: Boolean(personal) }));
    assert.equal((await api(off.url, "PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, savedViews: views })).status, 200, "an existing personal view can still be renamed");
    assert.equal((await api(off.url, "PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, savedViews: [...views, { name: "New mine", personal: true, state: {} }] })).status, 400);
    const doc = await off.db.collection("boards").findOne({ name: "Source" });
    assert.deepEqual(doc.savedViews.map((v) => v.name), ["Shared"]);
  });
  test("Connect / Mirror: readable (names and sums), but links, settings and new columns are refused; other edits work", async () => {
    const rel = (await api(off.url, "GET", `/api/v1/boards/${board.id}/related?ids=${rec.id}`)).body;
    assert.equal(rel.values[rec.id].m, 4); assert.equal(rel.linked.c[rec.links[0]].name, "T1");
    assert.equal((await api(off.url, "PATCH", `/api/v1/records/${rec.id}`, { expectedVersion: rec.version, values: { c: rec.links } })).status, 400, "single record");
    const bulk = await api(off.url, "PATCH", `/api/v1/boards/${board.id}/records`, { items: [{ id: rec.id, expectedVersion: rec.version, values: { c: [] } }] });
    assert.equal(bulk.status, 400, "bulk edit (the batch shape the page sends)"); assert.match(bulk.body.error.message, /switched off/, "refused by the switch, not by the request shape");
    const bulkOk = await api(off.url, "PATCH", `/api/v1/boards/${board.id}/records`, { items: [{ id: rec.id, expectedVersion: rec.version, values: { serial: "S1 bulk" } }] });
    assert.equal(bulkOk.status, 200, "a bulk edit of other cells works"); rec.version = bulkOk.body.items[0].version;
    assert.equal((await api(off.url, "POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "S2", c: [rec.links[1]] } })).status, 400, "new record with links");
    const b = (await api(off.url, "GET", `/api/v1/boards/${board.id}`)).body.board;
    const retarget = b.columns.map((c) => (c.key === "c" ? { ...c, link: { boardId: board.id } } : c));
    assert.equal((await api(off.url, "PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, columns: retarget })).status, 400, "a Connect column's board can't change");
    const renamed = b.columns.map((c) => (c.key === "serial" ? { ...c, label: "Item name" } : c));
    assert.equal((await api(off.url, "PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, columns: renamed })).status, 200, "unrelated column edits work");
    assert.equal((await api(off.url, "PATCH", `/api/v1/records/${rec.id}`, { expectedVersion: rec.version, values: { serial: "S1 renamed" } })).status, 200, "other cells work");
    assert.deepEqual((await off.db.collection("records").findOne({ "values.serial": "S1 renamed" })).values.c, [rec.links[0]], "links kept");
  });
});

describe("Unchanged from 7e863f4 for existing saved views and filters (switches off)", () => {
  const { startMongoApp, api } = require("./helpers");
  let app, board;
  const call = (m, p, b) => api(app.url, m, p, b);
  before(async () => {
    app = await startMongoApp({ app: { features: { personalViews: false, connectBoards: false } } });
    const ws = (await call("POST", "/api/v1/workspaces", { name: "Same" })).body.workspace;
    board = (await call("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Same", columns: [{ key: "serial", label: "Item", type: "text", required: true }, { key: "amount", label: "Amount", type: "text" }] })).body.board;
    await call("POST", `/api/v1/boards/${board.id}/records/batch`, { records: [["A", "5"], ["B", "abc"], ["C", ""], ["D", "12"], ["E", null]].map(([serial, amount]) => ({ values: { serial, amount } })) });
  });
  after(async () => { await app?.close(); });
  test("gt / lt keep their earlier answers: words count as below every number, empty never matches", async () => {
    const names = async (filter) => { const r = await call("GET", `/api/v1/boards/${board.id}/records?filter=${encodeURIComponent(JSON.stringify(filter))}`); return r.body.items.map((x) => x.values.serial).sort(); };
    assert.deepEqual(await names({ op: "and", rules: [{ key: "amount", cmp: "lt", values: ["10"] }] }), ["A", "B"], "as on 7e863f4: \"abc\" is below 10");
    assert.deepEqual(await names({ op: "and", rules: [{ key: "amount", cmp: "gt", values: ["1"] }] }), ["A", "D"]);
  });
  test("saving views that didn't change still writes the board: version checked and bumped, as before", async () => {
    const b = (await call("GET", `/api/v1/boards/${board.id}`)).body.board;
    const views = [{ name: "V", state: {} }];
    const first = await call("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, savedViews: views });
    assert.equal(first.body.board.version, b.version + 1);
    const same = first.body.board.savedViews.map(({ id, name, state }) => ({ id, name, state }));
    assert.equal((await call("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, savedViews: same })).status, 409, "a stale version is refused");
    const again = await call("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: first.body.board.version, savedViews: same });
    assert.equal(again.status, 200); assert.equal(again.body.board.version, first.body.board.version + 1);
    assert.equal((await call("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: again.body.board.version, savedViews: [{ ...same[0], createdBy: "x" }] })).status, 400, "unknown fields refused, as before");
  });
});
