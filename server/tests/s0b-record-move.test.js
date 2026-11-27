// Record move with Connect / Mirror (doc 25 finding 6). A move is a copy on the target board (create path) + a delete on the
// source board, so the server's create-path checks are what protect the copy: source MEMBER (delete) + destination MEMBER
// (create); every copied linked ID must exist on the destination column's linked board and not be archived, and the mover must
// be able to open that board (403 first); Connect / Mirror columns added to the destination need the linked board's view and a
// Connect column to follow; Mirror values are never written. The browser refuses moves that would silently lose links the mover
// can't see, or that would put one board's IDs into a column linking another board (BoardModel.relationMoveReason).
// Real app with Entra sign-in on the fake MongoDB (Connect switched on in this test app); synthetic data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

describe("record move with Connect / Mirror (server checks on the copy)", () => {
  const w = { sessions: new Map() };
  const as = async (p, method, url, body) => {
    if (!w.sessions.has(p.oid)) { const c = new SessionClient(w.app.url, w.app.entra.appOrigin); assert.equal((await c.signIn(p)).status, 201); w.sessions.set(p.oid, c); }
    return w.sessions.get(p.oid).request(method, url, body);
  };
  const board = async (p, id) => (await as(p, "GET", `/api/v1/boards/${id}`)).body.board;
  const addColumn = async (p, b, column) => as(p, "POST", `/api/v1/boards/${b.id}/columns`, { expectedVersion: (await board(p, b.id)).version, column });
  const count = async (b) => (await as(w.P.owner, "GET", `/api/v1/boards/${b.id}/records`)).body.items.length;
  before(async () => {
    w.issuer = await createTokenIssuer();
    const P = w.P = { owner: w.issuer.person("Owner Person", { admin: true }), editor: w.issuer.person("Host Editor"), both: w.issuer.person("Both Member") };
    w.app = await startEntraApp({ issuer: w.issuer });
    w.wsA = (await as(P.owner, "POST", "/api/v1/workspaces", { name: "Hosts" })).body.workspace;
    w.wsB = (await as(P.owner, "POST", "/api/v1/workspaces", { name: "Targets" })).body.workspace;
    const id = async (p) => (await as(p, "GET", "/api/v1/me")).body.user.id;
    const member = async (ws, p, role) => assert.equal((await as(P.owner, "POST", `/api/v1/workspaces/${ws.id}/members`, { userId: await id(p), role })).status, 201);
    await member(w.wsA, P.editor, "MEMBER"); await member(w.wsA, P.both, "MEMBER"); await member(w.wsB, P.both, "VIEWER");
    const cols = [{ key: "serial", label: "Name", type: "text", required: true }, { key: "value", label: "Value", type: "number" }];
    w.clients = (await as(P.owner, "POST", `/api/v1/workspaces/${w.wsB.id}/boards`, { name: "Clients", columns: cols })).body.board;
    w.vendors = (await as(P.owner, "POST", `/api/v1/workspaces/${w.wsB.id}/boards`, { name: "Vendors", columns: cols })).body.board;
    const made = (await as(P.owner, "POST", `/api/v1/boards/${w.clients.id}/records/batch`, { records: ["Acme", "Globex", "Old"].map((serial) => ({ values: { serial, value: 1 } })) })).body.items;
    w.link = Object.fromEntries(made.map((r) => [r.values.serial, r.id]));
    const projectCols = [{ key: "serial", label: "Project", type: "text", required: true }];
    w.projects = (await as(P.owner, "POST", `/api/v1/workspaces/${w.wsA.id}/boards`, { name: "Projects", columns: projectCols })).body.board;
    w.done = (await as(P.owner, "POST", `/api/v1/workspaces/${w.wsA.id}/boards`, { name: "Done projects", columns: projectCols })).body.board;
    w.wrong = (await as(P.owner, "POST", `/api/v1/workspaces/${w.wsA.id}/boards`, { name: "Vendor projects", columns: projectCols })).body.board;
    for (const b of [w.projects, w.done]) assert.equal((await addColumn(P.owner, b, { key: "client", label: "Client", type: "connect", link: { boardId: w.clients.id }, multiple: true })).status, 201);
    assert.equal((await addColumn(P.owner, w.wrong, { key: "client", label: "Client", type: "connect", link: { boardId: w.vendors.id }, multiple: true })).status, 201);
    assert.equal((await addColumn(P.owner, w.projects, { key: "total", label: "Total", type: "mirror", mirror: { via: "client", column: "value", show: "sum" } })).status, 201);
    w.alpha = (await as(P.owner, "POST", `/api/v1/boards/${w.projects.id}/records`, { values: { serial: "Alpha", client: [w.link.Acme, w.link.Globex] } })).body.record;
  });
  after(async () => { await w.app?.close(); });

  test("a mover who can't open the linked board never sees the IDs, and can't copy (forge) them onto the destination", async () => {
    const seen = (await as(w.P.editor, "GET", `/api/v1/records/${w.alpha.id}`)).body.record;
    assert.equal("client" in seen.values, false); assert.deepEqual(seen.restricted.sort(), ["client", "total"]);
    const before = await count(w.done);
    const forged = await as(w.P.editor, "POST", `/api/v1/boards/${w.done.id}/records`, { values: { serial: "Alpha", client: [w.link.Acme] } });
    assert.equal(forged.status, 403);
    assert.equal(await count(w.done), before, "nothing created");
    // Adding the missing Connect column to a destination is refused too (it links a board they can't open).
    const fresh = (await as(w.P.owner, "POST", `/api/v1/workspaces/${w.wsA.id}/boards`, { name: "Empty", columns: [{ key: "serial", label: "P", type: "text", required: true }] })).body.board;
    assert.equal((await addColumn(w.P.editor, fresh, { key: "client", label: "Client", type: "connect", link: { boardId: w.clients.id }, multiple: true })).status, 403);
  });

  test("column compatibility: IDs of one board never land in a Connect column linking another board", async () => {
    const before = await count(w.wrong);
    const r = await as(w.P.both, "POST", `/api/v1/boards/${w.wrong.id}/records`, { values: { serial: "Alpha", client: [w.link.Acme, w.link.Globex] } });
    assert.equal(r.status, 400); assert.match(r.body.error.message, /isn't on the linked board|aren't on the linked board/);
    assert.equal(await count(w.wrong), before);
  });

  test("Mirror: a copied Mirror value is refused (never stored); a Mirror column needs a Connect column to follow on the destination", async () => {
    const r = await as(w.P.both, "POST", `/api/v1/boards/${w.done.id}/records`, { values: { serial: "Alpha", client: [w.link.Acme], total: 5 } });
    assert.ok([400].includes(r.status), `mirror value: ${r.status}`);
    const fresh = (await as(w.P.owner, "POST", `/api/v1/workspaces/${w.wsA.id}/boards`, { name: "No connect", columns: [{ key: "serial", label: "P", type: "text", required: true }] })).body.board;
    assert.equal((await addColumn(w.P.both, fresh, { key: "total", label: "Total", type: "mirror", mirror: { via: "client", column: "value", show: "sum" } })).status, 400);
  });

  test("an authorized mover: copy keeps exactly the links, then the original is deleted; an archived linked record blocks the copy", async () => {
    const src = (await as(w.P.both, "GET", `/api/v1/records/${w.alpha.id}`)).body.record;
    assert.deepEqual(src.values.client, [w.link.Acme, w.link.Globex]);
    const copy = await as(w.P.both, "POST", `/api/v1/boards/${w.done.id}/records`, { values: { serial: src.values.serial, client: src.values.client } });
    assert.equal(copy.status, 201); assert.deepEqual(copy.body.record.values.client, [w.link.Acme, w.link.Globex]);
    assert.equal((await as(w.P.both, "DELETE", `/api/v1/records/${w.alpha.id}?expectedVersion=${src.version}`)).status, 200);
    // Today a linked record that is archived can't be newly linked, so a move of a record linked to it is refused (nothing written).
    const old = (await as(w.P.owner, "GET", `/api/v1/records/${w.link.Old}`)).body.record;
    assert.equal((await as(w.P.owner, "PATCH", `/api/v1/records/${w.link.Old}`, { expectedVersion: old.version, archived: true })).status, 200);
    const before = await count(w.done);
    const r = await as(w.P.both, "POST", `/api/v1/boards/${w.done.id}/records`, { values: { serial: "Beta", client: [w.link.Old] } });
    assert.equal(r.status, 400); assert.match(r.body.error.message, /archived/);
    assert.equal(await count(w.done), before);
  });
});

describe("record move in the browser model (BoardModel.relationMoveReason)", () => {
  const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
  const ctx = vm.createContext({ window: {}, console, Intl, Date, URL, JSON, Map, Set, setTimeout, clearTimeout, document: { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } } }, CustomEvent: class {} });
  ctx.window = ctx;
  for (const f of ["ColumnTypes.js", "BoardModel.js"]) vm.runInContext(fs.readFileSync(path.join(ASSETS, f), "utf8"), ctx, { filename: f });
  const C = (key, type, extra = {}) => ({ key, label: key, type, ...extra });
  const model = ({ columns, restricted = [] }) => {
    const m = Object.create(ctx.BoardModel.prototype);
    Object.defineProperties(m, { board: { value: { id: "b1", columns } }, storage: { value: { restrictedColumns: () => restricted } } });
    m.relatedAccess = (key) => (restricted.includes(key) ? "restricted" : null);
    return m;
  };
  const src = [C("serial", "text"), C("client", "connect", { link: { boardId: "c1" }, multiple: true }), C("total", "mirror", { mirror: { via: "client", column: "value", show: "sum" } })];

  test("refused: a restricted Connect column (links the mover can't see would be lost); a same-key column linking another board", () => {
    assert.match(model({ columns: src, restricted: ["client"] }).relationMoveReason({ columns: [] }), /can't open/);
    assert.match(model({ columns: src }).relationMoveReason({ columns: [C("client", "connect", { link: { boardId: "other" }, multiple: true })] }), /different board/);
    assert.match(model({ columns: src }).relationMoveReason({ columns: [C("client", "connect", { link: { boardId: "c1" } }), C("total", "mirror", { mirror: { via: "client", column: "value", show: "count" } })] }), /different board/);
  });
  test("allowed: matching columns, absent columns (the server checks the copy), boards without Connect / Mirror", () => {
    assert.equal(model({ columns: src }).relationMoveReason({ columns: src }), "");
    assert.equal(model({ columns: src }).relationMoveReason({ columns: [C("serial", "text")] }), "");
    assert.equal(model({ columns: [C("serial", "text")] }).relationMoveReason({ columns: [] }), "");
  });
});
