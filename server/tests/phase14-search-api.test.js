// Phase 14 API: Command Center search (GET /search/global) and recently visited destinations (/me/recents).
// Authorisation before results (no titles, snippets, counts or IDs from elsewhere), visibility vs editing, read-only
// synchronized boards, beta open editing, every filter, cursor pagination, validation and injection resistance,
// limits, the per-person throttle, privacy of search text and history. Offline: fake MongoDB.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { startEntraApp, SessionClient, api } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { encodeCursor, decodeCursor } = require("../src/validation/search");
const { INDEXES } = require("../src/db/bootstrap");

const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "status", label: "Status", type: "status", options: ["Open", "In Progress", "Closed"] },
  { key: "priority", label: "Priority", type: "priority", options: ["Low", "High", "Critical"] },
  { key: "owner", label: "Owner", type: "owner" },
  { key: "site", label: "Site", type: "text" },
  { key: "contact", label: "Contact", type: "email" }
];
// A board with different columns: no status, no priority, no People column.
const PLAIN = [{ key: "serial", label: "Asset", type: "text", required: true }, { key: "notes", label: "Notes", type: "text" }];

async function seed(app, issuer) {
  const people = {};
  const client = () => new SessionClient(app.url, app.entra.appOrigin);
  for (const [k, name, admin] of [["admin", "Ada Admin", true], ["mia", "Mia Member", false], ["vic", "Vic Viewer", false], ["otto", "Otto Outsider", false]]) {
    people[k] = client(); await people[k].signIn(issuer.person(name, { admin }));
    people[k].id = (await people[k].request("GET", "/api/v1/me")).body.user.id;
  }
  const a = people.admin;
  const ops = (await a.request("POST", "/api/v1/workspaces", { name: "Field Operations" })).body.workspace;
  const hr = (await a.request("POST", "/api/v1/workspaces", { name: "HR Confidential" })).body.workspace;
  await a.request("POST", `/api/v1/workspaces/${ops.id}/members`, { userId: people.mia.id, role: "MEMBER" });
  await a.request("POST", `/api/v1/workspaces/${ops.id}/members`, { userId: people.vic.id, role: "VIEWER" });
  const jobs = (await a.request("POST", `/api/v1/workspaces/${ops.id}/boards`, { name: "Turbine Jobs", columns: COLUMNS })).body.board;
  const assets = (await a.request("POST", `/api/v1/workspaces/${ops.id}/boards`, { name: "Turbine Assets", columns: PLAIN })).body.board;
  const synced = (await a.request("POST", `/api/v1/workspaces/${ops.id}/boards`, { name: "Turbine Sync", columns: COLUMNS })).body.board;
  const payroll = (await a.request("POST", `/api/v1/workspaces/${hr.id}/boards`, { name: "Turbine Payroll", columns: COLUMNS })).body.board;
  const mia = `user:${people.mia.id}`;
  await a.request("POST", `/api/v1/boards/${jobs.id}/records/batch`, { records: [
    { values: { serial: "Turbine 7 gearbox", status: "Open", priority: "Critical", owner: [mia], site: "North ridge", contact: "ops@windco.example" } },
    { values: { serial: "Blade inspection", status: "In Progress", priority: "High", site: "Turbine 12 platform" } },
    { values: { serial: "Cable tray repair", status: "Closed", priority: "Low", owner: [mia], site: "Substation" } },
    { values: { serial: "Archived turbine job", status: "Open" }, archived: true }
  ] });
  await a.request("POST", `/api/v1/boards/${assets.id}/records`, { values: { serial: "Turbine 7 nacelle", notes: "Spare parts" } });
  await a.request("POST", `/api/v1/boards/${synced.id}/records`, { values: { serial: "Synced turbine order", status: "Open" } });
  await a.request("POST", `/api/v1/boards/${payroll.id}/records`, { values: { serial: "Turbine bonus salaries", status: "Open", site: "secret" } });
  await app.db.collection("boards").updateOne({ _id: new ObjectId(synced.id) }, { $set: { source: { provider: "monday", sourceBoardId: "42", readOnly: true } } });
  const rows = (await a.request("GET", `/api/v1/boards/${jobs.id}/records?limit=50`)).body.items;
  const gearbox = rows.find((r) => r.values.serial === "Turbine 7 gearbox"), blade = rows.find((r) => r.values.serial === "Blade inspection");
  await a.request("POST", `/api/v1/records/${gearbox.id}/comments`, { body: "Vibration sensor shows bearing wear on turbine 7" });
  await a.request("POST", `/api/v1/records/${blade.id}/comments`, { body: "Drone footage uploaded" });
  const payrollRow = (await a.request("GET", `/api/v1/boards/${payroll.id}/records?limit=5`)).body.items[0];
  await a.request("POST", `/api/v1/records/${payrollRow.id}/comments`, { body: "Turbine crew bonus approved" });
  return { people, ops, hr, jobs, assets, synced, payroll, gearbox, blade, payrollRow };
}

const group = (res, type) => res.body.groups.find((g) => g.type === type) || { items: [] };
const titles = (res, type) => group(res, type).items.map((i) => i.title).sort();

describe("Phase 14: Command Center search (role_based)", () => {
  let app, issuer, s;
  const find = (who, query) => s.people[who].request("GET", `/api/v1/search/global?${query}`);
  before(async () => { issuer = await createTokenIssuer(); app = await startEntraApp({ issuer, searchLimiter: () => true }); s = await seed(app, issuer); });
  after(async () => { app.app?.locals?.realtime?.closeAll(); await app.close(); });

  test("requires a session", async () => {
    assert.equal((await api(app.url, "GET", "/api/v1/search/global?q=turbine")).status, 401);
    assert.equal((await api(app.url, "GET", "/api/v1/me/recents")).status, 401);
  });

  test("grouped results: workspaces, boards, records and comments, each with context and a navigation target", async () => {
    const res = await find("admin", "q=turbine");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(res.body.groups.map((g) => g.type), ["workspace", "board", "record", "comment"]);
    assert.deepEqual(titles(res, "board"), ["Turbine Assets", "Turbine Jobs", "Turbine Payroll", "Turbine Sync"]);
    assert.deepEqual(titles(res, "record"), ["Blade inspection", "Synced turbine order", "Turbine 7 gearbox", "Turbine 7 nacelle", "Turbine bonus salaries"]);
    const rec = group(res, "record").items.find((i) => i.title === "Turbine 7 gearbox");
    assert.deepEqual(rec.target, { workspaceId: s.ops.id, boardId: s.jobs.id, recordId: s.gearbox.id });
    assert.deepEqual([rec.workspace.name, rec.board.name, rec.meta.status, rec.meta.priority], ["Field Operations", "Turbine Jobs", "Open", "Critical"]);
    const blade = group(res, "record").items.find((i) => i.title === "Blade inspection");
    assert.deepEqual([blade.field, blade.snippet], [{ key: "site", label: "Site" }, "Turbine 12 platform"]);
    const comment = group(res, "comment").items.find((i) => i.record.id === s.gearbox.id);
    assert.equal(comment.snippet, "Vibration sensor shows bearing wear on turbine 7");
    assert.deepEqual(Object.keys(comment.target).sort(), ["boardId", "commentId", "recordId", "workspaceId"]);
    assert.equal(comment.meta.author, "Ada Admin");
  });

  test("relevance: item-name matches lead; archived records and archived boards never appear", async () => {
    const res = await find("admin", "q=turbine&type=record");
    const items = group(res, "record").items;
    const firstCell = items.findIndex((i) => i.field), lastName = items.map((i) => !i.field).lastIndexOf(true);
    assert.ok(firstCell === -1 || lastName < firstCell, "name matches before cell matches");
    assert.doesNotMatch(JSON.stringify(res.body), /Archived turbine job/);
    const b = (await s.people.admin.request("GET", `/api/v1/boards/${s.assets.id}`)).body.board;
    await s.people.admin.request("PATCH", `/api/v1/boards/${s.assets.id}`, { expectedVersion: b.version, archived: true });
    try { assert.doesNotMatch(JSON.stringify((await find("admin", "q=nacelle")).body), /nacelle|Turbine Assets/); }
    finally { const b2 = (await s.people.admin.request("GET", `/api/v1/boards/${s.assets.id}`)).body.board; await s.people.admin.request("PATCH", `/api/v1/boards/${s.assets.id}`, { expectedVersion: b2.version, archived: false }); }
  });

  test("AUTHORISATION: no titles, snippets, counts or IDs from workspaces the caller can't see", async () => {
    for (const who of ["mia", "vic"]) {
      const res = await find(who, "q=turbine");
      const text = JSON.stringify(res.body);
      assert.doesNotMatch(text, /Payroll|HR Confidential|bonus|salar|crew/i, who);
      assert.ok(!text.includes(s.hr.id) && !text.includes(s.payroll.id) && !text.includes(s.payrollRow.id), `${who}: no IDs`);
      assert.equal(res.body.groups.flatMap((g) => g.items).every((i) => i.workspace.id === s.ops.id), true);
    }
    const otto = await find("otto", "q=turbine");
    assert.deepEqual(otto.body.groups.flatMap((g) => g.items), [], "an outsider sees nothing");
    assert.equal(otto.body.groups.some((g) => g.more), false, "not even that more exists");
    // Asking for a hidden workspace or board by ID answers exactly like one that doesn't exist.
    const hidden = await find("mia", `q=turbine&workspaceId=${s.hr.id}`), missing = await find("mia", `q=turbine&workspaceId=${new ObjectId()}`);
    assert.deepEqual(hidden.body, missing.body);
    assert.deepEqual((await find("mia", `q=turbine&boardId=${s.payroll.id}`)).body, (await find("mia", `q=turbine&boardId=${new ObjectId()}`)).body);
  });

  test("visibility is separate from editing: viewers find records but can't edit; synchronized boards are read-only", async () => {
    const asViewer = group(await find("vic", "q=turbine&type=record"), "record").items;
    assert.ok(asViewer.length > 0);
    assert.equal(asViewer.every((i) => i.canEdit === false), true, "VIEWER");
    const asMember = group(await find("mia", "q=turbine&type=record"), "record").items;
    assert.equal(asMember.find((i) => i.title === "Turbine 7 gearbox").canEdit, true, "MEMBER");
    const synced = asMember.find((i) => i.title === "Synced turbine order");
    assert.deepEqual([synced.canEdit, synced.meta.readOnly], [false, true], "monday.com boards stay read-only");
    const board = group(await find("admin", "q=sync&type=board"), "board").items[0];
    assert.deepEqual([board.title, board.canEdit, board.meta.readOnly], ["Turbine Sync", false, true]);
  });

  test("filters: status and priority use each board's own columns; boards without them are left out", async () => {
    assert.deepEqual(titles(await find("admin", "q=turbine&type=record&status=Open"), "record"), ["Synced turbine order", "Turbine 7 gearbox", "Turbine bonus salaries"]);
    assert.deepEqual(titles(await find("admin", "type=record&priority=Critical"), "record"), ["Turbine 7 gearbox"], "a filter alone is enough");
    assert.deepEqual(titles(await find("admin", "type=record&status=Closed&priority=Low"), "record"), ["Cable tray repair"]);
    assert.deepEqual(titles(await find("admin", "type=record&status=Open&priority=Low"), "record"), [], "filters combine");
    assert.doesNotMatch(JSON.stringify((await find("admin", "q=turbine&status=Open")).body), /nacelle/, "the Assets board has no status column");
    assert.deepEqual(titles(await find("admin", "type=record&status=open"), "record"), [], "status is an exact label");
  });

  test("filters: assignee (me or a person), workspace, board, type and date range", async () => {
    assert.deepEqual(titles(await find("mia", "type=record&assignee=me"), "record"), ["Cable tray repair", "Turbine 7 gearbox"]);
    assert.deepEqual(titles(await find("admin", `type=record&assignee=user:${s.people.mia.id}&status=Closed`), "record"), ["Cable tray repair"]);
    assert.deepEqual(titles(await find("admin", "type=record&assignee=me"), "record"), []);
    assert.deepEqual(titles(await find("admin", `q=turbine&type=record&boardId=${s.jobs.id}`), "record"), ["Blade inspection", "Turbine 7 gearbox"]);
    assert.deepEqual(titles(await find("admin", `q=turbine&workspaceId=${s.hr.id}`), "board"), ["Turbine Payroll"]);
    const types = await find("admin", "q=turbine&type=board,comment");
    assert.deepEqual(types.body.groups.map((g) => g.type), ["board", "comment"]);
    // Dates: records by last update, comments by when they were posted.
    await app.db.collection("records").updateOne({ _id: new ObjectId(s.blade.id) }, { $set: { updatedAt: new Date("2024-03-10T12:00:00Z") } });
    assert.deepEqual(titles(await find("admin", "type=record&from=2024-03-10&to=2024-03-10"), "record"), ["Blade inspection"]);
    assert.deepEqual(titles(await find("admin", "type=record&from=2024-03-11&to=2024-03-31"), "record"), []);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(group(await find("admin", `q=vibration&type=comment&from=${today}`), "comment").items.length === 1);
    assert.equal((await find("admin", "q=turbine&status=Open")).body.groups.some((g) => g.type === "comment"), false, "comments have no status");
  });

  test("cursor pagination: stable pages with no repeats and no gaps", async () => {
    const all = group(await find("admin", "q=turbine&type=record&limit=25"), "record").items.map((i) => i.id);
    const seen = [];
    let cursor = null, pages = 0;
    do {
      const res = await find("admin", `type=record&status=Open&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(res.status, 200);
      const g = group(res, "record");
      seen.push(...g.items.map((i) => i.id));
      cursor = g.next; pages += 1;
      assert.equal(Boolean(g.more), Boolean(g.next));
    } while (cursor && pages < 10);
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen).size, 3, "no repeats");
    assert.ok(all.length >= 5);
    const c1 = await find("admin", "q=e&type=comment&limit=1");
    assert.equal(c1.status, 400, "q is at least 2 characters");
    const cp = await find("admin", "q=re&type=comment&limit=1");
    const next = group(cp, "comment").next;
    if (next) assert.notDeepEqual(group(await find("admin", `q=re&type=comment&limit=1&cursor=${next}`), "comment").items, group(cp, "comment").items);
  });

  test("cursor pagination with text: name matches leading the first page never push other records out of later pages", async () => {
    // An older item-name match, then two newer cell matches: the first page shows the name match first, and the
    // cell match it displaced must arrive on the next page (it was skipped before this fix).
    const a = s.people.admin, ids = [];
    const board = (await a.request("POST", `/api/v1/workspaces/${s.ops.id}/boards`, { name: "Paging check", columns: PLAIN })).body.board;
    for (const values of [{ serial: "Zephyr unit", notes: "" }, { serial: "Alpha", notes: "zephyr ridge" }, { serial: "Beta", notes: "zephyr ridge" }]) {
      ids.push((await a.request("POST", `/api/v1/boards/${board.id}/records`, { values })).body.record.id);
      await new Promise((r) => setTimeout(r, 5)); // distinct updatedAt times
    }
    const seen = new Set();
    let cursor = null, pages = 0;
    do {
      const g = group(await find("admin", `q=zephyr&type=record&limit=2${cursor ? `&cursor=${cursor}` : ""}`), "record");
      if (!pages) assert.equal(g.items[0].title, "Zephyr unit", "the name match leads the first page");
      g.items.forEach((i) => seen.add(i.id));
      cursor = g.next; pages += 1;
      assert.equal(Boolean(g.more), Boolean(g.next));
    } while (cursor && pages < 5);
    assert.deepEqual([...seen].sort(), [...ids].sort(), "every match is reachable through Show more");
    const b = (await a.request("GET", `/api/v1/boards/${board.id}`)).body.board;
    await a.request("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, archived: true });
  });

  test("validation: query length, unknown/repeated parameters, bad IDs, dates, cursors and limits", async () => {
    for (const [query, why] of [["", "nothing to search for"], ["q=k", "one character"], [`q=${"x".repeat(101)}`, "too long"], ["q=%00%01k", "control characters only leave one character"], ["q=ab&type=people", "unknown type"], ["q=ab&type=", "empty type is all — fine"], ["q=ab&limit=26", "limit"], ["q=ab&limit=0", "limit 0"], ["q=ab&workspaceId=nope", "bad ID"], ["q=ab&boardId[$ne]=x", "operator injection"], ["q=ab&from=2024-02-30", "not a real date"], ["q=ab&from=2024-05-01&to=2024-04-01", "range backwards"], ["q=ab&assignee=Mia", "assignee must be a person ref"], ["q=ab&cursor=abc", "cursor needs one type"], ["q=ab&type=record&cursor=!!", "bad cursor"], ["q=ab&type=record&cursor=" + encodeCursor("comment", new Date(), new ObjectId()), "cursor of another type"], ["q=ab&evil=1", "unknown parameter"], ["q=ab&q=cd", "repeated"], ["q[$regex]=.*", "operator object"], [`status=${"x".repeat(101)}`, "filter too long"]]) {
      const res = await find("admin", query);
      if (why.endsWith("fine")) assert.equal(res.status, 200, why); else assert.equal(res.status, 400, why);
    }
    assert.throws(() => decodeCursor(Buffer.from(JSON.stringify({ k: "record", t: "x", i: "zz" })).toString("base64url"), "record"));
  });

  test("injection resistance: regex characters are literal and never expensive", async () => {
    for (const q of [".*", "(a+)+$", "[x", "a\\b", "$where", "^Turbine", "a|b"]) {
      const res = await find("admin", `q=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, q);
      assert.deepEqual(res.body.groups.flatMap((g) => g.items), [], `${q} matches literally (nothing here contains it)`);
    }
    const queries = app.fake.calls?.filter?.((c) => c.op === "find" && c.collection === "records") || [];
    for (const c of queries.slice(-3)) assert.ok(c.options?.maxTimeMS > 0 && c.options?.limit > 0);
  });

  test("bounded: grouped limits, single-type limits, server time limits; search never changes data", async () => {
    const before = JSON.stringify(await app.db.collection("records").find({}).toArray());
    const res = await find("admin", "q=turbine");
    assert.ok(group(res, "workspace").items.length <= 5 && group(res, "board").items.length <= 8 && group(res, "record").items.length <= 10 && group(res, "comment").items.length <= 5);
    assert.equal(group(await find("admin", "q=turbine&type=record&limit=2"), "record").items.length, 2);
    assert.equal(group(await find("admin", "q=turbine&type=record&limit=2"), "record").more, true);
    assert.equal(JSON.stringify(await app.db.collection("records").find({}).toArray()), before, "read-only");
    const records = app.dataLayer.repos.records, original = records.searchPage;
    let options;
    records.searchPage = async (clauses, o) => { options ??= o; return original.call(records, clauses, o); };
    await find("admin", "q=turbine&type=record&limit=3");
    records.searchPage = original;
    assert.deepEqual([options.limit, options.maxTimeMS > 0, Object.keys(options.projection).every((k) => k === "_id" || k === "boardId" || k === "workspaceId" || k === "updatedAt" || k.startsWith("values."))], [4, true, true]);
    records.searchPage = async () => { throw Object.assign(new Error("time limit"), { code: 50, codeName: "MaxTimeMSExpired" }); };
    const slow = await find("admin", "q=turbine");
    records.searchPage = original;
    assert.deepEqual([slow.status, slow.body.error.code], [503, "SEARCH_TIMEOUT"]);
  });

  test("privacy: a failing search never writes its text to the server log", async () => {
    const records = app.dataLayer.repos.records, original = records.searchPage;
    records.searchPage = async () => { throw new Error("boom"); };
    const res = await find("admin", "q=confidential-acquisition&type=record");
    records.searchPage = original;
    assert.equal(res.status, 500);
    assert.ok(app.logger.errors.length > 0);
    assert.doesNotMatch(app.logger.errors.join("\n"), /confidential-acquisition/);
    assert.match(app.logger.errors.join("\n"), /search\/global\?\[redacted\]/);
  });

  test("the comments index this search relies on is declared for JARC's own collection only", () => {
    assert.ok(INDEXES.comments.some((i) => i.name === "board_created" && JSON.stringify(i.key) === JSON.stringify({ boardId: 1, createdAt: -1, _id: -1 })));
    assert.equal(Object.keys(INDEXES).some((c) => /receipt/i.test(c)), false);
  });
});

describe("Phase 14: recently visited destinations", () => {
  let app, issuer, s;
  before(async () => { issuer = await createTokenIssuer(); app = await startEntraApp({ issuer, searchLimiter: () => true }); s = await seed(app, issuer); });
  after(async () => { app.app?.locals?.realtime?.closeAll(); await app.close(); });

  test("remembers visits newest first, deduplicated, IDs only, and resolves them to openable destinations", async () => {
    const mia = s.people.mia;
    for (const ref of [`board:${s.jobs.id}`, `record:${s.gearbox.id}`, `workspace:${s.ops.id}`, `board:${s.jobs.id}`]) assert.equal((await mia.request("POST", "/api/v1/me/recents", { ref })).body.remembered, true);
    const res = await mia.request("GET", "/api/v1/me/recents");
    assert.deepEqual(res.body.items.map((i) => `${i.type}:${i.title}`), ["board:Turbine Jobs", "workspace:Field Operations", "record:Turbine 7 gearbox"]);
    assert.deepEqual(res.body.items[2].target, { workspaceId: s.ops.id, boardId: s.jobs.id, recordId: s.gearbox.id });
    const stored = (await app.db.collection("users").findOne({ _id: new ObjectId(mia.id) })).preferences.navigation.recents;
    assert.deepEqual(stored.map((r) => r.ref), [`board:${s.jobs.id}`, `workspace:${s.ops.id}`, `record:${s.gearbox.id}`]);
    assert.doesNotMatch(JSON.stringify(stored), /Turbine|gearbox/, "no titles or search text stored");
  });

  test("never remembers something the caller can't see; validates refs; needs CSRF", async () => {
    const mia = s.people.mia;
    assert.equal((await mia.request("POST", "/api/v1/me/recents", { ref: `board:${s.payroll.id}` })).body.remembered, false);
    assert.equal((await mia.request("POST", "/api/v1/me/recents", { ref: `record:${s.payrollRow.id}` })).body.remembered, false);
    for (const ref of ["board:nope", "user:" + s.people.admin.id, `board:${s.jobs.id}x`, 42]) assert.equal((await mia.request("POST", "/api/v1/me/recents", { ref })).status, 400, String(ref));
    assert.equal((await mia.request("POST", "/api/v1/me/recents", { ref: `board:${s.jobs.id}`, extra: 1 })).status, 400);
    assert.equal((await mia.request("POST", "/api/v1/me/recents", { ref: `board:${s.jobs.id}` }, { csrf: "wrong" })).status, 403);
    assert.doesNotMatch(JSON.stringify((await mia.request("GET", "/api/v1/me/recents")).body), /Payroll|salar/);
  });

  test("private per person, and access revocations and deletions apply immediately", async () => {
    const { admin, vic, mia } = s.people;
    await admin.request("POST", "/api/v1/me/recents", { ref: `board:${s.payroll.id}` });
    assert.doesNotMatch(JSON.stringify((await vic.request("GET", "/api/v1/me/recents")).body), /Payroll/, "another person's history is never shown");
    assert.deepEqual((await vic.request("GET", "/api/v1/me/recents")).body.items, []);
    await vic.request("POST", "/api/v1/me/recents", { ref: `record:${s.blade.id}` });
    assert.equal((await vic.request("GET", "/api/v1/me/recents")).body.items.length, 1);
    // Vic's membership is removed: the remembered record disappears without being deleted from history.
    const members = (await admin.request("GET", `/api/v1/workspaces/${s.ops.id}/members`)).body.items;
    const membership = members.find((m) => m.userId === vic.id || m.user?.id === vic.id);
    assert.ok(membership, "membership found");
    assert.equal((await admin.request("DELETE", `/api/v1/workspaces/${s.ops.id}/members/${membership.id}`)).status < 300, true);
    assert.deepEqual((await vic.request("GET", "/api/v1/me/recents")).body.items, [], "revoked access");
    assert.deepEqual(group(await vic.request("GET", "/api/v1/search/global?q=turbine"), "record").items, []);
    // Archived records disappear from recents too.
    await mia.request("POST", "/api/v1/me/recents", { ref: `record:${s.blade.id}` });
    const r = (await admin.request("GET", `/api/v1/records/${s.blade.id}`)).body.record;
    await admin.request("PATCH", `/api/v1/records/${s.blade.id}`, { expectedVersion: r.version, archived: true });
    assert.doesNotMatch(JSON.stringify((await mia.request("GET", "/api/v1/me/recents")).body), /Blade inspection/);
  });

  test("history can be cleared; appearance preferences are kept when recents change", async () => {
    const mia = s.people.mia;
    assert.equal((await mia.request("PUT", "/api/v1/me/preferences", { appearance: { theme: "dark" } })).status, 200);
    await mia.request("POST", "/api/v1/me/recents", { ref: `board:${s.jobs.id}` });
    assert.equal((await mia.request("GET", "/api/v1/me/preferences")).body.appearance.theme, "dark");
    assert.equal((await mia.request("DELETE", "/api/v1/me/recents")).status, 200);
    assert.deepEqual((await mia.request("GET", "/api/v1/me/recents")).body.items, []);
    assert.equal((await mia.request("GET", "/api/v1/me/preferences")).body.appearance.theme, "dark");
  });
});

describe("Phase 14: search under open-access policies", () => {
  for (const [label, options] of [["JARC_BETA_OPEN_EDITING", { betaOpenEditing: true }], ["development_shared", { accessPolicy: "development_shared" }]]) {
    test(`${label}: every signed-in employee searches every workspace and may edit — except read-only synchronized boards`, async () => {
      const issuer = await createTokenIssuer();
      const app = await startEntraApp({ issuer, searchLimiter: () => true, ...options });
      try {
        const s = await seed(app, issuer);
        const res = await s.people.otto.request("GET", "/api/v1/search/global?q=turbine&type=record");
        const items = group(res, "record").items;
        assert.ok(items.some((i) => i.title === "Turbine bonus salaries"), "open access: all workspaces");
        assert.equal(items.find((i) => i.title === "Turbine 7 gearbox").canEdit, true);
        assert.equal(items.find((i) => i.title === "Synced turbine order").canEdit, false, "read-only stays read-only");
      } finally { app.app?.locals?.realtime?.closeAll(); await app.close(); }
    });
  }
});

describe("Phase 14: throttling", () => {
  test("the Command Center shares the per-person search limit: 20 per 10 seconds, then 429 (others unaffected)", async () => {
    const issuer = await createTokenIssuer();
    const app = await startEntraApp({ issuer });
    try {
      const a = new SessionClient(app.url, app.entra.appOrigin), b = new SessionClient(app.url, app.entra.appOrigin);
      await a.signIn(issuer.person("Ann A")); await b.signIn(issuer.person("Ben B"));
      const statuses = [];
      for (let i = 0; i < 21; i += 1) statuses.push((await a.request("GET", "/api/v1/search/global?q=abc")).status);
      assert.deepEqual([statuses.slice(0, 20).every((s) => s === 200), statuses[20]], [true, 429]);
      assert.equal((await a.request("GET", "/api/v1/search?q=abc")).status, 429, "one budget for both search endpoints");
      assert.equal((await b.request("GET", "/api/v1/search/global?q=abc")).status, 200, "per person");
      assert.equal((await a.request("GET", "/api/v1/search/global?q=a")).status, 400, "invalid queries are refused before counting");
    } finally { app.app?.locals?.realtime?.closeAll(); await app.close(); }
  });
});
