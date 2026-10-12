// Column system (server): label colours, multi-value cells (multi-select Dropdown, People), switching a Dropdown
// between one and several values, option edits with colours/order, People references to real users, and the
// notification feed with each change's actor (ID + display-name snapshot from the session). Offline: fake MongoDB.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { startMongoApp, startEntraApp, SessionClient, api } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "status", label: "Status", type: "status", options: ["To do", "Doing", "Done"], colors: ["#64748b", "#3b82f6", "#1f9d61"] },
  { key: "tags", label: "Tags", type: "dropdown", multiple: true, options: ["North", "South", "East"] },
  { key: "region", label: "Region", type: "dropdown", options: ["North", "South"] },
  { key: "owner", label: "People", type: "owner" },
  { key: "qty", label: "Qty", type: "number" },
  { key: "due", label: "Due", type: "date" },
  { key: "done", label: "Done?", type: "checkbox" }
];

describe("Columns and values (development API)", () => {
  let app, ws, devRef;
  const call = (method, path, body) => api(app.url, method, `/api/v1${path}`, body);
  const newBoard = async (columns = COLUMNS) => (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Column test", columns })).body.board;
  const newRecord = async (board, values) => (await call("POST", `/boards/${board.id}/records`, { values: { serial: "R", ...values } }));
  before(async () => {
    app = await startMongoApp();
    ws = (await call("POST", "/workspaces", { name: "Columns" })).body.workspace;
    devRef = `user:${app.devActor._id.toHexString()}`;
  });
  after(async () => { await app.close(); });

  test("a board stores label colours and multi-select with its columns; plain columns keep their old shape", async () => {
    const board = await newBoard();
    const byKey = Object.fromEntries(board.columns.map((c) => [c.key, c]));
    assert.deepEqual(byKey.status.colors, ["#64748b", "#3b82f6", "#1f9d61"]);
    assert.equal(byKey.tags.multiple, true);
    assert.equal("multiple" in byKey.region, false);
    assert.equal("colors" in byKey.qty, false);
  });

  test("invalid column settings are refused", async () => {
    for (const [column, why] of [
      [{ key: "s", label: "S", type: "status", colors: ["red"] }, "not a colour"],
      [{ key: "t", label: "T", type: "text", colors: ["#111111"] }, "colours on a text column"],
      [{ key: "s2", label: "S", type: "status", multiple: true }, "multiple on a status column"],
      [{ key: "d", label: "D", type: "dropdown", multiple: "yes" }, "multiple not true/false"]
    ]) {
      const res = await call("POST", `/workspaces/${ws.id}/boards`, { name: "Bad", columns: [COLUMNS[0], column] });
      assert.equal(res.status, 400, why);
    }
  });

  test("multi-value cells take lists; single-value cells, duplicates, bad entries and bad people references are refused", async () => {
    const board = await newBoard();
    const ok = await newRecord(board, { tags: ["North", "East"], owner: [devRef, "Contractor (text)"], status: "Doing", qty: "12.5", due: "2026-10-05", done: true });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.record.values.tags, ok.body.record.values.owner], [["North", "East"], [devRef, "Contractor (text)"]]);
    for (const [values, why] of [
      [{ region: ["North"] }, "list in a single-value dropdown"],
      [{ status: ["Done"] }, "list in a status"],
      [{ tags: ["North", "North"] }, "duplicate entries"],
      [{ tags: ["North", 5] }, "non-text entry"],
      [{ tags: Array.from({ length: 101 }, (_, i) => `t${i}`) }, "too many entries"],
      [{ owner: ["user:not-an-id"] }, "malformed person reference"],
      [{ owner: [`user:${new ObjectId().toHexString()}`] }, "someone who isn't a JARC user"],
      [{ qty: "twelve" }, "not a number"],
      [{ due: "2026-02-30" }, "not a real date"],
      [{ done: "yes" }, "checkbox not true/false"]
    ]) {
      const res = await newRecord(board, values);
      assert.equal(res.status, 400, `${why}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    }
  });

  test("updating a list to the same list records no change in the activity log", async () => {
    const board = await newBoard();
    const record = (await newRecord(board, { tags: ["North"] })).body.record;
    const same = await call("PATCH", `/records/${record.id}`, { expectedVersion: record.version, values: { tags: ["North"] } });
    assert.equal(same.status, 200);
    const updates = (await call("GET", `/boards/${board.id}/activity`)).body.items.filter((e) => e.action === "record.updated");
    assert.deepEqual(updates[0].changes, [], "no field reported as changed");
  });

  test("one value ↔ several values: not through a board update, only through the type endpoint, which rewrites values", async () => {
    const board = await newBoard();
    const a = (await newRecord(board, { tags: ["South", "East"] })).body.record;
    const b = (await newRecord(board, { region: "North" })).body.record;
    const patched = board.columns.map((c) => (c.key === "tags" ? { ...c, multiple: false } : c));
    const refused = await call("PATCH", `/boards/${board.id}`, { expectedVersion: board.version, columns: patched });
    assert.equal(refused.status, 400);
    const toSingle = await call("POST", `/boards/${board.id}/columns/tags/type`, { expectedVersion: board.version, type: "dropdown", multiple: false });
    assert.equal(toSingle.status, 200, JSON.stringify(toSingle.body));
    assert.equal(toSingle.body.board.columns.find((c) => c.key === "tags").multiple, undefined);
    assert.equal((await call("GET", `/records/${a.id}`)).body.record.values.tags, "South", "several → one keeps the first");
    const toMulti = await call("POST", `/boards/${board.id}/columns/region/type`, { expectedVersion: toSingle.body.board.version, type: "dropdown", multiple: true });
    assert.equal(toMulti.status, 200);
    assert.deepEqual((await call("GET", `/records/${b.id}`)).body.record.values.region, ["North"], "one → several wraps the value");
    const activity = (await call("GET", `/boards/${board.id}/activity`)).body.items;
    assert.ok(activity.some((e) => e.summary === "Set Tags to allow one value"));
  });

  test("People → text keeps names, never internal IDs", async () => {
    const board = await newBoard();
    const record = (await newRecord(board, { owner: [devRef, "Contractor"] })).body.record;
    const res = await call("POST", `/boards/${board.id}/columns/owner/type`, { expectedVersion: board.version, type: "text" });
    assert.equal(res.status, 200);
    const value = (await call("GET", `/records/${record.id}`)).body.record.values.owner;
    assert.equal(value, `${app.devActor.displayName}, Contractor`);
    assert.doesNotMatch(value, /user:/);
  });

  test("editing labels: rename, recolour, reorder and remove — lists keep their other entries", async () => {
    const board = await newBoard();
    const record = (await newRecord(board, { status: "Doing", tags: ["North", "South", "East"] })).body.record;
    const status = await call("PUT", `/boards/${board.id}/columns/status/options`, { expectedVersion: board.version, items: [{ from: "Done", to: "Done", color: "#8e4ec6" }, { from: "Doing", to: "In progress" }, { from: "To do", to: "To do", color: "" }] });
    assert.equal(status.status, 200, JSON.stringify(status.body));
    const s = status.body.board.columns.find((c) => c.key === "status");
    assert.deepEqual([s.options, s.colors], [["Done", "In progress", "To do"], ["#8e4ec6", "#3b82f6", ""]], "order and colours follow the labels");
    const tags = await call("PUT", `/boards/${board.id}/columns/tags/options`, { expectedVersion: status.body.board.version, items: [{ from: "North", to: "N" }, { from: "East", to: "East" }] });
    assert.equal(tags.status, 200);
    const after = (await call("GET", `/records/${record.id}`)).body.record.values;
    assert.equal(after.status, "In progress");
    assert.deepEqual(after.tags, ["N", "East"], "renamed inside the list; the removed label dropped out");
    const badColour = await call("PUT", `/boards/${board.id}/columns/status/options`, { expectedVersion: tags.body.board.version, items: [{ from: "Done", to: "Done", color: "url(x)" }] });
    assert.equal(badColour.status, 400);
  });

  test("activity entries carry the actor's ID and display-name snapshot; the feed lists them newest first", async () => {
    const board = await newBoard();
    await newRecord(board, { status: "Done" });
    const feed = await call("GET", "/activity?limit=5");
    assert.equal(feed.status, 200);
    assert.ok(feed.body.items.length > 0 && feed.body.items.length <= 5);
    for (const e of feed.body.items) assert.deepEqual([e.actorUserId, e.actorName], [app.devActor._id.toHexString(), app.devActor.displayName]);
    const times = feed.body.items.map((e) => e.createdAt);
    assert.deepEqual(times, [...times].sort().reverse());
    const older = await call("GET", `/activity?limit=5&before=${encodeURIComponent(times.at(-1))}`);
    assert.ok(older.body.items.every((e) => e.createdAt < times.at(-1)), "paging with before");
    for (const bad of ["limit=0", "limit=101", "before=yesterday", "other=1"]) assert.equal((await call("GET", `/activity?${bad}`)).status, 400, bad);
  });

  test("older activity without an actor name is returned as null (shown as “Unknown user”), never guessed", async () => {
    await app.db.collection("activities").insertOne({ workspaceId: new ObjectId(ws.id), boardId: null, recordId: null, actorUserId: null, action: "legacy.board.activity", entityType: "board", entityId: null, changes: [], summary: "Imported history", createdAt: new Date(Date.now() + 60000) });
    const top = (await call("GET", "/activity?limit=1")).body.items[0];
    assert.deepEqual([top.summary, top.actorUserId, top.actorName], ["Imported history", null, null]);
  });
});

describe("People and the notification feed (Microsoft sign-in)", () => {
  for (const accessPolicy of ["role_based", "development_shared"]) {
    describe(accessPolicy, () => {
      let app, issuer, admin, ana, ben, cara, ws, board, anaPerson;
      const client = () => new SessionClient(app.url, app.entra.appOrigin);
      before(async () => {
        issuer = await createTokenIssuer();
        app = await startEntraApp({ issuer, accessPolicy });
        admin = client(); ana = client(); ben = client(); cara = client();
        await admin.signIn(issuer.person("Sys Admin", { admin: true }));
        anaPerson = issuer.person("Ana Reyes");
        await ana.signIn(anaPerson); await ben.signIn(issuer.person("Ben Cruz")); await cara.signIn(issuer.person("Cara Lim"));
        ws = (await admin.request("POST", "/api/v1/workspaces", { name: "Ops" })).body.workspace;
        for (const c of [ana, ben]) {
          const id = (await c.request("GET", "/api/v1/me")).body.user.id;
          if (accessPolicy === "role_based") assert.equal((await admin.request("POST", `/api/v1/workspaces/${ws.id}/members`, { userId: id, role: "MEMBER" })).status, 201);
        }
        board = (await ana.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Jobs", columns: COLUMNS })).body.board;
      });
      after(async () => { await app.close(); });

      test("the people list: who can be assigned, with “you”; search; disabled users left out", async () => {
        const res = await ana.request("GET", `/api/v1/workspaces/${ws.id}/people`);
        assert.equal(res.status, 200);
        const names = res.body.items.map((p) => p.displayName);
        if (accessPolicy === "role_based") assert.deepEqual(names, ["Ana Reyes", "Ben Cruz", "Sys Admin"], "members only (the creator is a member)");
        else assert.deepEqual(names, ["Ana Reyes", "Ben Cruz", "Cara Lim", "Sys Admin"], "every signed-in employee");
        assert.equal(res.body.items.find((p) => p.displayName === "Ana Reyes").isYou, true);
        assert.ok(res.body.items.every((p) => /^user:[0-9a-f]{24}$/.test(p.id)));
        assert.deepEqual((await ana.request("GET", `/api/v1/workspaces/${ws.id}/people?q=BEN`)).body.items.map((p) => p.displayName), ["Ben Cruz"]);
        await app.db.collection("users").updateOne({ displayName: "Ben Cruz" }, { $set: { status: "disabled" } });
        assert.ok(!(await ana.request("GET", `/api/v1/workspaces/${ws.id}/people`)).body.items.some((p) => p.displayName === "Ben Cruz"));
        await app.db.collection("users").updateOne({ displayName: "Ben Cruz" }, { $set: { status: "active" } });
        if (accessPolicy === "role_based") assert.equal((await cara.request("GET", `/api/v1/workspaces/${ws.id}/people`)).status, 404, "non-members see nothing");
        assert.equal((await client().request("GET", `/api/v1/workspaces/${ws.id}/people`)).status, 401);
      });

      test("assigning several people; a disabled user can't be assigned", async () => {
        const people = (await ana.request("GET", `/api/v1/workspaces/${ws.id}/people`)).body.items;
        const ids = people.filter((p) => ["Ana Reyes", "Ben Cruz"].includes(p.displayName)).map((p) => p.id);
        const created = await ana.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Assigned", owner: ids } });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.deepEqual(created.body.record.values.owner, ids);
        await app.db.collection("users").updateOne({ displayName: "Ben Cruz" }, { $set: { status: "disabled" } });
        const refused = await ana.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Nope", owner: ids } });
        assert.deepEqual([refused.status, refused.body.error.code], [400, "VALIDATION_ERROR"]);
        await app.db.collection("users").updateOne({ displayName: "Ben Cruz" }, { $set: { status: "active" } });
      });

      test("the server applies the same rule as the people list, whatever the browser sends", async () => {
        // Cara is an active employee but not a member under role_based; she is assignable under development_shared.
        const caraId = `user:${(await cara.request("GET", "/api/v1/me")).body.user.id}`;
        const create = await ana.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Cara?", owner: [caraId] } });
        const rec = (await ana.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Later" } })).body.record;
        const patch = await ana.request("PATCH", `/api/v1/records/${rec.id}`, { expectedVersion: rec.version, values: { owner: [caraId] } });
        const batch = await ana.request("POST", `/api/v1/boards/${board.id}/records/batch`, { records: [{ values: { serial: "B1", owner: [caraId] } }] });
        const expected = accessPolicy === "role_based" ? 400 : [201, 200, 201];
        if (accessPolicy === "role_based") for (const res of [create, patch, batch]) assert.deepEqual([res.status, res.body.error.code], [400, "VALIDATION_ERROR"]);
        else assert.deepEqual([create.status, patch.status, batch.status], expected);
      });

      test("the feed names the actor from the session; a browser-sent name is refused; another employee sees it too", async () => {
        const rec = (await ben.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "By Ben" } })).body.record;
        const spoof = await ben.request("PATCH", `/api/v1/records/${rec.id}`, { expectedVersion: rec.version, values: { status: "Done" }, actorName: "Someone else" });
        assert.equal(spoof.status, 400, "no actor fields from the browser");
        const feed = (await ana.request("GET", "/api/v1/activity?limit=20")).body.items;
        const entry = feed.find((e) => e.recordId === rec.id && e.action === "record.created");
        assert.equal(entry.actorName, "Ben Cruz");
        assert.equal(entry.actorUserId, (await ben.request("GET", "/api/v1/me")).body.user.id);
        assert.ok(feed.some((e) => e.actorName === "Ana Reyes"), "Ana's own changes are there too");
      });

      test("a renamed employee: earlier entries keep the old name, new ones use the new name", async () => {
        const renamed = client(); // the same person (same object ID), whose Microsoft display name changed
        await renamed.signIn({ ...anaPerson, idToken: (nonce) => anaPerson.idToken(nonce, { name: "Ana Reyes-Santos" }) });
        const fresh = (await renamed.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "After rename" } })).body.record;
        const feed = (await ben.request("GET", "/api/v1/activity?limit=50")).body.items;
        assert.equal(feed.find((e) => e.recordId === fresh.id).actorName, "Ana Reyes-Santos");
        const anaId = (await renamed.request("GET", "/api/v1/me")).body.user.id;
        assert.equal(anaId, (await ana.request("GET", "/api/v1/me")).body.user.id, "same JARC user");
        assert.ok(feed.some((e) => e.actorUserId === anaId && e.actorName === "Ana Reyes"), "history keeps the name at the time");
      });

      test("feed visibility follows workspace access", async () => {
        const other = (await admin.request("POST", "/api/v1/workspaces", { name: "Private" })).body.workspace;
        const feed = (await ben.request("GET", "/api/v1/activity?limit=100")).body.items;
        const sees = feed.some((e) => e.workspaceId === other.id);
        assert.equal(sees, accessPolicy === "development_shared", accessPolicy === "role_based" ? "role_based: only workspaces Ben belongs to" : "shared: every workspace");
        assert.equal((await client().request("GET", "/api/v1/activity")).status, 401);
      });
    });
  }
});
