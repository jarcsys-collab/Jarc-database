// Global search API (GET /api/v1/search): authentication, authorisation (only workspaces the caller can see),
// archived and restricted content excluded, what is and isn't searched (no People references, no file names),
// literal matching, minimal results, limits, rate limiting and failure handling. Offline: fake MongoDB.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startEntraApp, startMongoApp, SessionClient, api } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { searchLimiter } = require("../src/routes/search");

const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "status", label: "Status", type: "status", options: ["Open", "Closed"] },
  { key: "contact", label: "Contact", type: "email" },
  { key: "notes", label: "Notes", type: "text" },
  { key: "owner", label: "People", type: "owner" },
  { key: "qty", label: "Qty", type: "number" },
  { key: "docs", label: "Files", type: "files" }
];

describe("Global search API (Microsoft sign-in, role_based)", () => {
  let app, issuer, admin, mia, outsider, shared, secret, board, secretBoard, archivedBoard;
  const client = () => new SessionClient(app.url, app.entra.appOrigin);
  const search = (c, query) => c.request("GET", `/api/v1/search?${query}`);
  const titles = (res) => res.body.items.map((i) => i.title).sort();
  before(async () => {
    issuer = await createTokenIssuer();
    app = await startEntraApp({ issuer });
    admin = client(); mia = client(); outsider = client();
    await admin.signIn(issuer.person("Ada Admin", { admin: true })); await mia.signIn(issuer.person("Mia Member")); await outsider.signIn(issuer.person("Otto Outsider"));
    shared = (await admin.request("POST", "/api/v1/workspaces", { name: "Shared" })).body.workspace;
    secret = (await admin.request("POST", "/api/v1/workspaces", { name: "Secret" })).body.workspace;
    await admin.request("POST", `/api/v1/workspaces/${shared.id}/members`, { userId: (await mia.request("GET", "/api/v1/me")).body.user.id, role: "VIEWER" });
    board = (await admin.request("POST", `/api/v1/workspaces/${shared.id}/boards`, { name: "Jobs", columns: COLUMNS })).body.board;
    secretBoard = (await admin.request("POST", `/api/v1/workspaces/${secret.id}/boards`, { name: "Payroll", columns: COLUMNS })).body.board;
    archivedBoard = (await admin.request("POST", `/api/v1/workspaces/${shared.id}/boards`, { name: "Old jobs", columns: COLUMNS })).body.board;
    const miaRef = `user:${(await mia.request("GET", "/api/v1/me")).body.user.id}`;
    await admin.request("POST", `/api/v1/boards/${board.id}/records/batch`, { records: [
      { values: { serial: "Kestrel install", status: "Open", contact: "ops@kestrel.example", notes: "Roof unit" } },
      { values: { serial: "Boiler check", status: "Closed", notes: "Tenant mentioned the kestrel nest" } },
      { values: { serial: "Archived kestrel job", notes: "old" }, archived: true },
      { values: { serial: "Price a.b", notes: "literal dots" } },
      { values: { serial: "Assigned", owner: [miaRef], qty: "4242" } }
    ] });
    await admin.request("POST", `/api/v1/boards/${secretBoard.id}/records`, { values: { serial: "Kestrel salary", notes: "confidential" } });
    await admin.request("POST", `/api/v1/boards/${archivedBoard.id}/records`, { values: { serial: "Kestrel in an archived board" } });
    const ab = (await admin.request("GET", `/api/v1/boards/${archivedBoard.id}`)).body.board;
    await admin.request("PATCH", `/api/v1/boards/${archivedBoard.id}`, { expectedVersion: ab.version, archived: true });
  });
  after(async () => { app.app?.locals?.realtime?.closeAll(); await app.close(); });

  test("requires a signed-in session", async () => {
    const res = await api(app.url, "GET", "/api/v1/search?q=kestrel");
    assert.equal(res.status, 401);
  });

  test("finds item names and text-like cells, case-insensitively; archived records and archived boards are excluded", async () => {
    const res = await search(admin, "q=KESTREL");
    assert.equal(res.status, 200);
    assert.deepEqual(titles(res), ["Boiler check", "Kestrel install", "Kestrel salary"]);
    assert.equal(res.body.items[0].title.startsWith("Kestrel"), true, "item-name matches come first");
    const cell = res.body.items.find((i) => i.title === "Boiler check");
    assert.deepEqual(cell.field, { key: "notes", label: "Notes" });
    assert.equal(cell.snippet, "Tenant mentioned the kestrel nest");
    assert.deepEqual(titles(await search(admin, "q=kestrel.example")), ["Kestrel install"], "email cells are searched");
    assert.deepEqual(titles(await search(admin, "q=clos")), ["Boiler check"], "status labels are searched");
  });

  test("returns only the minimum needed: IDs, item name, matched column and snippet", async () => {
    const res = await search(admin, "q=boiler");
    assert.deepEqual(Object.keys(res.body).sort(), ["items", "more", "partial"]);
    assert.deepEqual(Object.keys(res.body.items[0]).sort(), ["boardId", "field", "recordId", "snippet", "title", "workspaceId"]);
    assert.equal(res.body.items[0].field, null, "matched on the item name");
    assert.doesNotMatch(JSON.stringify(res.body), /Tenant mentioned|Closed|ops@/, "no other cell values");
  });

  test("AUTHORISATION: members see only their workspaces; outsiders see nothing; admins see everything", async () => {
    const miaSees = await search(mia, "q=kestrel");
    assert.deepEqual(titles(miaSees), ["Boiler check", "Kestrel install"], "no Payroll (a workspace Mia isn't in)");
    assert.doesNotMatch(JSON.stringify(miaSees.body), /salary|Payroll|confidential/i);
    assert.equal(miaSees.body.items.every((i) => i.workspaceId === shared.id), true);
    assert.deepEqual((await search(outsider, "q=kestrel")).body.items, []);
    assert.equal((await search(admin, "q=salary")).body.items.length, 1);
    assert.equal((await search(mia, "q=salary")).body.items.length, 0);
  });

  test("never searches People references, numbers or file names; the query is literal", async () => {
    const miaId = (await mia.request("GET", "/api/v1/me")).body.user.id;
    assert.deepEqual((await search(admin, `q=${miaId.slice(0, 10)}`)).body.items, [], "user IDs in People cells are not searched");
    assert.deepEqual((await search(admin, "q=user:")).body.items, []);
    assert.deepEqual((await search(admin, "q=4242")).body.items, [], "number cells are not searched");
    const target = (await admin.request("GET", `/api/v1/boards/${board.id}/records?limit=50`)).body.items.find((r) => r.values.serial === "Assigned");
    const up = await fetch(`${app.url}/api/v1/records/${target.id}/attachments?column=docs`, { method: "POST", headers: { "Content-Type": "application/pdf", "X-File-Name": "zanzibar-contract.pdf", "X-CSRF-Token": admin.csrf, Cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join("; "), Origin: app.entra.appOrigin }, body: "%PDF-1.4 zanzibar" });
    assert.equal(up.status, 201);
    assert.deepEqual((await search(admin, "q=zanzibar")).body.items, [], "file names and contents are not searched");
    assert.deepEqual(titles(await search(admin, "q=a.b")), ["Price a.b"], "dots are literal");
    assert.deepEqual(titles(await search(admin, "q=a%2Bb")), [], "regex characters never act as patterns");
    assert.equal((await search(admin, "q=(%5B*")).status, 200, "unbalanced brackets are fine");
  });

  test("validates q and limit; reports when more results exist", async () => {
    for (const [query, why] of [["", "missing"], ["q=k", "one character"], [`q=${"x".repeat(101)}`, "too long"], ["q=%20%20k%20", "one character after trimming"], ["q=ke&limit=0", "limit 0"], ["q=ke&limit=51", "limit 51"], ["q=ke&limit=ten", "limit not a number"], ["q=ke&board=x", "unknown parameter"], ["q=ke&q=ab", "repeated q"]]) {
      assert.equal((await search(admin, query)).status, 400, why);
    }
    const one = await search(admin, "q=kestrel&limit=1");
    assert.equal(one.body.items.length, 1);
    assert.equal(one.body.more, true);
    assert.equal((await search(admin, "q=kestrel&limit=50")).body.more, false);
  });
});

describe("Global search API: rate limiting and failures", () => {
  test("rate limit: 20 searches per person per 10 seconds, then 429", async () => {
    const app = await startMongoApp();
    try {
      const ws = (await api(app.url, "POST", "/api/v1/workspaces", { name: "R" })).body.workspace;
      await api(app.url, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "B", columns: COLUMNS });
      const statuses = [];
      for (let i = 0; i < 21; i += 1) statuses.push((await api(app.url, "GET", "/api/v1/search?q=abc")).status);
      assert.deepEqual([statuses.slice(0, 20).every((s) => s === 200), statuses[20]], [true, 429]);
      const limiter = searchLimiter({ perWindow: 2, windowMs: 50 });
      assert.deepEqual([limiter("u"), limiter("u"), limiter("u"), limiter("v")], [true, true, false, true], "per person");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(limiter("u"), true, "the window passes");
    } finally { await app.close(); }
  });

  test("a database failure is a clean error (no internals); a time-out says to narrow the search", async () => {
    const app = await startMongoApp();
    try {
      const ws = (await api(app.url, "POST", "/api/v1/workspaces", { name: "F" })).body.workspace;
      await api(app.url, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "B", columns: COLUMNS });
      app.fake.failNext({ collection: "records", op: "find" });
      const failed = await api(app.url, "GET", "/api/v1/search?q=abc");
      assert.ok(failed.status >= 500, `status ${failed.status}`);
      assert.doesNotMatch(JSON.stringify(failed.body), /mongodb|stack|fake/i);
      const records = app.dataLayer.repos.records, original = records.searchText;
      records.searchText = async () => { throw Object.assign(new Error("operation exceeded time limit"), { code: 50, codeName: "MaxTimeMSExpired" }); };
      const slow = await api(app.url, "GET", "/api/v1/search?q=abc");
      records.searchText = original;
      assert.equal(slow.status, 503);
      assert.equal(slow.body.error.code, "SEARCH_TIMEOUT");
    } finally { await app.close(); }
  });

  test("the query is bounded: one records query, limit + 1 documents, a server time limit, only searchable fields", async () => {
    const app = await startMongoApp();
    try {
      const ws = (await api(app.url, "POST", "/api/v1/workspaces", { name: "P" })).body.workspace;
      const b = (await api(app.url, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "B", columns: COLUMNS })).body.board;
      await api(app.url, "POST", `/api/v1/boards/${b.id}/records`, { values: { serial: "abc" } });
      const records = app.db.collection("records");
      const before = records.calls.length;
      await api(app.url, "GET", "/api/v1/search?q=abc&limit=5");
      const finds = records.calls.slice(before).filter((c) => c.op === "find");
      assert.equal(finds.length, 1, "one query");
      const { filter, options } = finds[0];
      assert.equal(filter.archived, false);
      assert.equal(options.limit, 6);
      assert.equal(options.maxTimeMS, 3000);
      assert.deepEqual(Object.keys(options.projection).sort(), ["_id", "boardId", "values.contact", "values.notes", "values.serial", "values.status", "workspaceId"], "no People, number or Files cells read");
      assert.ok(filter.$or.every((clause) => clause.boardId), "every branch is scoped to one board (uses the boardId indexes)");
    } finally { await app.close(); }
  });
});
