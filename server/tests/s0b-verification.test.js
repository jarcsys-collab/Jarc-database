// S0-B release verification (complements s0b-relationship-security / s0b-view-refusal-ui): the external token API on every
// record shape, search / Command Center, the same restricted set on every surface, and saved views with a restricted
// condition kept through every view action (open, save by owner / editor / viewer, duplicate, rename, make personal), on the
// server and in the browser's model. The real app with Entra sign-in on the fake MongoDB; synthetic people and data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { memoryStorage } = require("./support/browser-model");

const FILTER = { op: "and", rules: [{ key: "serial", cmp: "notEmpty" }, { key: "client", cmp: "notEmpty" }] };
const plain = (v) => JSON.parse(JSON.stringify(v));

describe("S0-B verification under role_based", () => {
  const w = { sessions: new Map() };
  const as = async (p, method, url, body) => {
    if (!w.sessions.has(p.oid)) { const c = new SessionClient(w.app.url, w.app.entra.appOrigin); assert.equal((await c.signIn(p)).status, 201); w.sessions.set(p.oid, c); }
    return w.sessions.get(p.oid).request(method, url, body);
  };
  const board = async (p, id = w.projects.id) => (await as(p, "GET", `/api/v1/boards/${id}`)).body.board;
  const external = async (secret, p) => { const res = await fetch(`${w.app.url}/api/v1/external${p}`, { headers: { Authorization: `Bearer ${secret}` } }); return { status: res.status, body: await res.json() }; };
  const noTargetIds = (body, where) => { const text = JSON.stringify(body); for (const id of Object.values(w.link)) assert.ok(!text.includes(id), `${where}: a linked record ID in ${text.slice(0, 300)}`); };
  const issue = async (p, boardIds) => { const r = await as(p, "POST", "/api/v1/me/api-tokens", { name: `T${crypto.randomBytes(3).toString("hex")}`, boardIds, scopes: ["read"], expiresAt: new Date(Date.now() + 86400000).toISOString() }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.secret; };
  let P;

  before(async () => {
    const issuer = await createTokenIssuer();
    P = { owner: issuer.person("Owner Person", { admin: true }), editor: issuer.person("Host Editor"), reader: issuer.person("Host Reader"), both: issuer.person("Both Reader") };
    w.app = await startEntraApp({ issuer, apiTokens: { key: crypto.randomBytes(32), issuePerHour: 1000, maxActive: 1000, adminObjectIds: [P.owner.oid.toLowerCase(), P.editor.oid.toLowerCase()] } });
    w.wsA = (await as(P.owner, "POST", "/api/v1/workspaces", { name: "Hosts" })).body.workspace;
    w.wsB = (await as(P.owner, "POST", "/api/v1/workspaces", { name: "Targets" })).body.workspace;
    const member = async (ws, p, role) => assert.equal((await as(P.owner, "POST", `/api/v1/workspaces/${ws.id}/members`, { userId: (await as(p, "GET", "/api/v1/me")).body.user.id, role })).status, 201);
    await member(w.wsA, P.editor, "MEMBER"); await member(w.wsA, P.reader, "VIEWER"); await member(w.wsA, P.both, "MEMBER"); await member(w.wsB, P.both, "VIEWER");
    w.clients = (await as(P.owner, "POST", `/api/v1/workspaces/${w.wsB.id}/boards`, { name: "Clients", columns: [{ key: "serial", label: "Client", type: "text", required: true }, { key: "value", label: "Value", type: "number" }] })).body.board;
    const made = (await as(P.owner, "POST", `/api/v1/boards/${w.clients.id}/records/batch`, { records: ["Acmezz", "Globexzz"].map((serial, i) => ({ values: { serial, value: (i + 1) * 10 } })) })).body.items;
    w.link = Object.fromEntries(made.map((r) => [r.values.serial, r.id]));
    w.projects = (await as(P.owner, "POST", `/api/v1/workspaces/${w.wsA.id}/boards`, { name: "Projects", columns: [{ key: "serial", label: "Project", type: "text", required: true }] })).body.board;
    for (const column of [{ key: "client", label: "Client", type: "connect", link: { boardId: w.clients.id }, multiple: true }, { key: "total", label: "Total", type: "mirror", mirror: { via: "client", column: "value", show: "sum" } }]) {
      assert.equal((await as(P.owner, "POST", `/api/v1/boards/${w.projects.id}/columns`, { expectedVersion: (await board(P.owner)).version, column })).status, 201);
    }
    w.alpha = (await as(P.owner, "POST", `/api/v1/boards/${w.projects.id}/records`, { values: { serial: "Alpha", client: [w.link.Acmezz, w.link.Globexzz] } })).body.record;
  });
  after(async () => { await w.app?.close(); });

  test("A2/A6 token API: a key without the linked board gets null + restricted on every shape; Mirror always null; with it, the IDs", async () => {
    const narrow = await issue(P.owner, [w.projects.id]), wide = await issue(P.owner, [w.projects.id, w.clients.id]);
    const b = w.projects.id, r = w.alpha.id;
    const list = await external(narrow, `/boards/${b}/records`), one = await external(narrow, `/records/${r}`);
    const cell = await external(narrow, `/boards/${b}/records/${r}/columns/client`), values = await external(narrow, `/boards/${b}/columns/client/values`);
    const mirrorCell = await external(narrow, `/boards/${b}/records/${r}/columns/total`), mirrorValues = await external(narrow, `/boards/${b}/columns/total/values`);
    for (const [n, x] of Object.entries({ list, one, cell, values, mirrorCell, mirrorValues })) { assert.equal(x.status, 200, `${n} ${JSON.stringify(x.body)}`); noTargetIds(x.body, n); }
    assert.equal(list.body.items[0].values.client, null); assert.deepEqual(list.body.items[0].restricted, ["client"]);
    assert.equal(one.body.record.values.client, null); assert.deepEqual(one.body.record.restricted, ["client"]);
    assert.equal(cell.body.value.value, null); assert.equal(cell.body.value.restricted, true);
    assert.ok(values.body.items.every((v) => v.value === null && v.restricted === true));
    assert.equal(list.body.items[0].values.total, null); assert.equal(mirrorCell.body.value.value, null); assert.ok(mirrorValues.body.items.every((v) => v.value === null));
    const full = await external(wide, `/records/${r}`);
    assert.deepEqual(full.body.record.values.client, [w.link.Acmezz, w.link.Globexzz]); assert.equal(full.body.record.values.total, null, "Mirror null even with both boards");
    assert.equal(full.body.record.restricted, undefined);
  });

  test("A2 search / Command Center: a host-only reader finds nothing from the linked board, and no Connect ID matches", async () => {
    for (const q of ["Acmezz", w.link.Acmezz.slice(0, 20)]) {
      for (const url of [`/api/v1/search?q=${q}`, `/api/v1/search/global?q=${q}`]) {
        const res = await as(P.reader, "GET", url);
        assert.equal(res.status, 200, `${url} ${JSON.stringify(res.body)}`);
        noTargetIds(res.body, url);
        assert.doesNotMatch(JSON.stringify(res.body), /Acmezz|Globexzz/, url);
      }
    }
    const hit = await as(P.reader, "GET", "/api/v1/search?q=Alpha");
    assert.ok(hit.body.items.some((i) => i.title === "Alpha")); noTargetIds(hit.body, "Alpha hit");
  });

  test("A3: the same restricted set on records, the record page, /related, the single record and the API Explorer", async () => {
    const sorted = (x) => [...x].sort();
    const page = (await as(P.editor, "GET", `/api/v1/boards/${w.projects.id}/records`)).body;
    const single = (await as(P.editor, "GET", `/api/v1/records/${w.alpha.id}`)).body.record;
    const rel = (await as(P.editor, "GET", `/api/v1/boards/${w.projects.id}/related?ids=${w.alpha.id}`)).body;
    const ex = (await as(P.editor, "GET", `/api/v1/me/api-explorer/boards/${w.projects.id}?record=${w.alpha.id}`)).body;
    const expected = ["client", "total"];
    assert.deepEqual(sorted(page.restrictedColumns), expected);
    assert.deepEqual(sorted(page.items[0].restricted), expected);
    assert.deepEqual(sorted(single.restricted), expected);
    assert.deepEqual(sorted(rel.restricted), expected);
    assert.deepEqual(rel.partial, {}, "restricted is never also partial");
    // The API Explorer previews the token API, which names only Connect columns in `restricted` (a Mirror is always null there).
    assert.deepEqual(sorted(ex.record.restricted), ["client"], "Explorer = token API shape");
    assert.deepEqual(sorted(ex.example.items[0].restricted), ["client"]);
    for (const x of [page, single, rel, ex]) noTargetIds(x, "A3");
  });

  test("A5 server: a restricted condition survives owner save, editor rename, viewer personal copy + rename, make personal / shared", async () => {
    const views = (list) => list.map(({ id, name, state, personal }) => ({ ...(id ? { id } : {}), name, state, personal: personal === true }));
    const patch = async (p, list) => { const b = await board(p); return as(p, "PATCH", `/api/v1/boards/${w.projects.id}`, { expectedVersion: b.version, savedViews: list(views(b.savedViews || [])) }); };
    const filterOf = async (p, name) => (await board(p)).savedViews.find((v) => v.name === name)?.state?.filter;
    // Owner (full access) saves a shared view.
    assert.equal((await patch(P.owner, (l) => [...l, { name: "Linked", state: { filter: FILTER }, personal: false }])).status, 200);
    // Opening it as the host-only reader: refused, never unfiltered records; the view itself is delivered as saved.
    assert.deepEqual(plain(await filterOf(P.reader, "Linked")), FILTER);
    const opened = await as(P.reader, "GET", `/api/v1/boards/${w.projects.id}/records?filter=${encodeURIComponent(JSON.stringify(FILTER))}`);
    assert.equal(opened.status, 400); assert.equal(opened.body.error.details?.reason, "restricted-filter"); assert.equal("items" in opened.body, false);
    // Editor (host only): renames and re-saves the shared view (sort changed): the condition stays.
    let r = await patch(P.editor, (l) => l.map((v) => (v.name === "Linked" ? { ...v, name: "Linked (ed)", state: { ...v.state, sortKey: "serial", sortDirection: "asc" } } : v)));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(plain(await filterOf(P.owner, "Linked (ed)")), FILTER);
    // Viewer: can't change the shared view (refused, unchanged) ...
    r = await patch(P.reader, (l) => l.map((v) => (v.name === "Linked (ed)" ? { ...v, name: "Viewer rename" } : v)));
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.deepEqual(plain(await filterOf(P.owner, "Linked (ed)")), FILTER);
    // ... but may duplicate it as a personal view and rename that.
    r = await patch(P.reader, (l) => [...l, { name: "Linked copy", state: plain(l.find((v) => v.name === "Linked (ed)").state), personal: true }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(plain(await filterOf(P.reader, "Linked copy")), FILTER);
    r = await patch(P.reader, (l) => l.map((v) => (v.name === "Linked copy" ? { ...v, name: "Mine" } : v)));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(plain(await filterOf(P.reader, "Mine")), FILTER);
    assert.equal(await filterOf(P.owner, "Mine"), undefined, "a personal view stays private");
    // Editor: duplicate the shared view, make the copy personal, then shared again.
    r = await patch(P.editor, (l) => [...l, { name: "Ed copy", state: plain(l.find((v) => v.name === "Linked (ed)").state), personal: false }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await patch(P.editor, (l) => l.map((v) => (v.name === "Ed copy" ? { ...v, personal: true } : v)));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(plain(await filterOf(P.editor, "Ed copy")), FILTER);
    r = await patch(P.editor, (l) => l.map((v) => (v.name === "Ed copy" ? { ...v, personal: false } : v)));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(plain(await filterOf(P.owner, "Ed copy")), FILTER);
    // The stored documents hold every condition as saved.
    const stored = await w.app.db.collection("boards").findOne({ name: "Projects" });
    for (const v of stored.savedViews.filter((x) => /Linked|Ed copy/.test(x.name))) assert.deepEqual(plain(v.state.filter), FILTER, v.name);
  });
});

describe("A5 browser model: every view action keeps a restricted condition (never silently removed)", () => {
  const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
  const read = (file) => fs.readFileSync(path.join(ASSETS, file), "utf8");
  const hex = (n) => n.toString(16).padStart(24, "0");
  const window = { location: { search: "", origin: "http://jarc.invalid" }, localStorage: memoryStorage(), sessionStorage: memoryStorage(), dispatchEvent() {}, addEventListener() {} };
  const ctx = vm.createContext({ window, console, Intl, Date, URL, URLSearchParams, AbortController, encodeURIComponent, JSON, Map, Set, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto,
    document: { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } } });
  ctx.window = Object.assign(ctx, window);
  for (const file of ["ColumnTypes.js", "IconLibrary.js", "ResourceApiAdapter.js", "StorageService.js", "BoardModel.js"]) vm.runInContext(read(file), ctx, { filename: file });
  const columns = [{ key: "serial", label: "Project", type: "text" }, { key: "client", label: "Clients", type: "connect", link: { boardId: hex(9) } }, { key: "total", label: "Total", type: "mirror", mirror: { via: "client", column: "v", show: "sum" } }];
  const make = (role) => {
    const m = Object.create(ctx.BoardModel.prototype);
    const board = { id: hex(7), name: "Projects", columns, groups: ["G"], savedViews: [{ id: "v1", name: "Linked", filter: plain(FILTER), createdBy: "me1" }] };
    const saves = [];
    Object.defineProperties(m, { board: { value: board }, rows: { value: [] }, storage: { value: { restrictedColumns: () => new Set(["client", "total"]), canFilterOnServer: false } }, workspace: { value: { role } }, serverBacked: { value: true }, features: { value: { personalViews: true } }, me: { value: "user:me1" } });
    Object.assign(m, { save: (op) => saves.push(op), saves, activeSavedViewId: null, viewFilter: null, query: "", status: "All", quickFilter: "all", personFilter: "", currentView: "table", sortDirection: "desc", sortKey: "", grouped: false, groupBy: "" });
    m.applyView = function (id) { const v = this.board.savedViews.find((x) => String(x.id) === String(id)); this.activeSavedViewId = v.id; this.viewFilter = v.filter ? plain(v.filter) : null; this.sortKey = v.sortKey || ""; };
    m.idOf = (id) => id;
    return m;
  };
  const filters = (m) => m.board.savedViews.map((v) => [v.name, plain(v.filter)]);

  for (const role of ["MEMBER", "VIEWER"]) {
    test(`${role}: open, save to this view (sort changed), duplicate, rename, make personal; the adapter payload keeps it`, () => {
      const m = make(role);
      m.applyView("v1");
      assert.equal(m.viewAccess().state, "refused", "opening is refused, never unfiltered");
      m.sortKey = "serial";
      assert.equal(m.saveActiveView(), role === "MEMBER", "only an editor saves a shared view");
      const copy = m.duplicateView("v1");
      assert.ok(copy, "duplicated");
      assert.equal(copy.personal === true, role === "VIEWER", "a viewer's copy is personal");
      assert.ok(m.renameView(copy.id, "Renamed copy"));
      assert.ok(m.setViewPersonal(copy.id, true));
      for (const [name, f] of filters(m)) assert.deepEqual(f, FILTER, name);
      for (const v of m.board.savedViews) assert.deepEqual(plain(ctx.ResourceApiAdapter.viewPayload(v).state.filter), FILTER, `payload ${v.name}`);
      assert.ok(m.saves.length >= (role === "MEMBER" ? 3 : 2), String(m.saves.length));
    });
  }
});

test("A6: Mirror is documented as always null in the API documentation, the API Explorer and the README", () => {
  const root = path.resolve(__dirname, "..", "..");
  assert.match(fs.readFileSync(path.join(root, "site", "assets", "ApiTokenDocs.js"), "utf8"), /A Mirror column's value is worked out in JARC when it is shown and is not returned by the API: it is always \$\{c\("null"\)\}/);
  assert.match(fs.readFileSync(path.join(root, "site", "assets", "ApiTokensPanel.js"), "utf8"), /data-note="mirror-null">Mirror columns are worked out in JARC[^<]*<code>null<\/code>/);
  assert.match(fs.readFileSync(path.join(root, "server", "README.md"), "utf8"), /A \*\*Mirror\*\* cell is worked out in JARC when it is shown and is never returned by the token API or the API Explorer: its value is always `null`/);
});
