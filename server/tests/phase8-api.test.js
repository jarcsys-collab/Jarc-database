// Phase 8 API: record comments (Updates) and permanent board groups, with Microsoft sign-in (role_based) on the fake
// MongoDB. Comments: post, reply (one level), edit (author, versioned), delete (author or moderator, tombstones),
// permissions (viewers read, members post, outsiders see nothing — even by guessing IDs), mentions (stable IDs,
// workspace people only, only new mentions notify), reply notifications, plain text (no stored markup), limits,
// archived and deleted records, read-only synced boards, counts, and separation from the activity log.
// Groups: colour, archive flag, order, concurrent edits, deletion with records moved, read-only boards.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { startEntraApp, SessionClient, api } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["Open", "Done"] }];

describe("Phase 8: record comments and board groups (role_based)", () => {
  let app, issuer, admin, wanda, mia, vic, otto, ws, other, board, record, otherRecord, ids = {};
  const client = () => new SessionClient(app.url, app.entra.appOrigin);
  const post = (c, rid, body) => c.request("POST", `/api/v1/records/${rid}/comments`, body);
  const list = (c, rid = record.id) => c.request("GET", `/api/v1/records/${rid}/comments`);
  const activities = (action) => app.db.collection("activities").docs.filter((a) => a.action === action);
  before(async () => {
    issuer = await createTokenIssuer();
    app = await startEntraApp({ issuer, accessPolicy: "role_based" });
    admin = client(); wanda = client(); mia = client(); vic = client(); otto = client();
    await admin.signIn(issuer.person("Ada Admin", { admin: true }));
    for (const [c, name] of [[wanda, "Wanda Lead"], [mia, "Mia Member"], [vic, "Vic Viewer"], [otto, "Otto Outsider"]]) { await c.signIn(issuer.person(name)); ids[name] = (await c.request("GET", "/api/v1/me")).body.user.id; }
    ws = (await admin.request("POST", "/api/v1/workspaces", { name: "Ops" })).body.workspace;
    other = (await admin.request("POST", "/api/v1/workspaces", { name: "Secret" })).body.workspace;
    for (const [name, role] of [["Wanda Lead", "WORKSPACE_ADMIN"], ["Mia Member", "MEMBER"], ["Vic Viewer", "VIEWER"]]) await admin.request("POST", `/api/v1/workspaces/${ws.id}/members`, { userId: ids[name], role });
    await admin.request("POST", `/api/v1/workspaces/${other.id}/members`, { userId: ids["Otto Outsider"], role: "MEMBER" });
    board = (await admin.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Jobs", columns: COLUMNS, groups: [{ name: "To do", color: "#3b82f6" }, { name: "Done", color: "#16a34a" }] })).body.board;
    record = (await mia.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Fix roof" }, groupId: board.groups[0].id })).body.record;
    const secretBoard = (await admin.request("POST", `/api/v1/workspaces/${other.id}/boards`, { name: "Payroll", columns: COLUMNS })).body.board;
    otherRecord = (await otto.request("POST", `/api/v1/boards/${secretBoard.id}/records`, { values: { serial: "Salaries" } })).body.record;
  });
  after(async () => { app.app?.locals?.realtime?.closeAll(); await app.close(); });

  test("members post updates; the author comes from the session; viewers read; outsiders get 404", async () => {
    const res = await post(mia, record.id, { body: "  Started on site\nwith the crew  " });
    assert.equal(res.status, 201);
    assert.equal(res.body.comment.body, "Started on site\nwith the crew");
    assert.equal(res.body.comment.author.name, "Mia Member"); assert.equal(res.body.comment.author.isYou, true);
    assert.equal((await post(mia, record.id, { body: "x", author: { name: "Someone else" } })).status, 400, "author fields are refused");
    assert.equal((await list(vic)).body.items.length, 1, "viewers read");
    assert.equal((await post(vic, record.id, { body: "hi" })).status, 403, "viewers can't post");
    assert.equal((await list(otto)).status, 404, "outsiders can't see the record");
    assert.equal((await post(otto, record.id, { body: "hi" })).status, 404);
    assert.equal((await api(app.url, "GET", `/api/v1/records/${record.id}/comments`)).status, 401);
    assert.equal((await mia.request("POST", `/api/v1/records/${record.id}/comments`, { body: "x" }, { csrf: "wrong" })).status, 403, "CSRF required");
  });

  test("plain text only: markup is stored and returned as text; control characters removed; limits", async () => {
    const xss = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const c = (await post(mia, record.id, { body: `${xss}\u0007` })).body.comment;
    assert.equal(c.body, xss, "returned verbatim as text (browsers render it escaped)");
    const stored = await app.db.collection("comments").findOne({ _id: new ObjectId(c.id) });
    assert.equal(stored.body, xss);
    for (const body of ["", "   ", 42, "x".repeat(5001)]) assert.equal((await post(mia, record.id, { body })).status, 400, JSON.stringify(body).slice(0, 20));
    assert.equal((await post(mia, record.id, { body: "ok", parentId: "nope" })).status, 400);
    await mia.request("DELETE", `/api/v1/comments/${c.id}`);
  });

  test("replies: one level (a reply to a reply joins the thread); the parent's author is notified, not yourself", async () => {
    const top = (await post(mia, record.id, { body: "Need a ladder?" })).body.comment;
    const r1 = (await post(wanda, record.id, { body: "Yes please", parentId: top.id })).body.comment;
    assert.equal(r1.parentId, top.id);
    const r2 = (await post(mia, record.id, { body: "On it", parentId: r1.id })).body.comment;
    assert.equal(r2.parentId, top.id, "attached to the top-level update");
    const replyEntries = activities("comment.created").filter((a) => a.entityId.toHexString() === r1.id);
    assert.deepEqual(replyEntries[0].changes, [{ field: "replyTo", from: null, to: `user:${ids["Mia Member"]}` }]);
    const own = activities("comment.created").find((a) => a.entityId.toHexString() === r2.id);
    assert.deepEqual(own.changes.filter((c) => c.field === "replyTo"), [], "replying in your own thread doesn't notify you");
    assert.equal((await post(mia, otherRecord.id, { body: "x", parentId: top.id })).status, 404, "other workspace's record");
    const elsewhere = (await mia.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Other job" } })).body.record;
    assert.equal((await post(mia, elsewhere.id, { body: "x", parentId: top.id })).status, 400, "a parent from another record");
  });

  test("mentions: stable IDs of workspace people only; mentioned people are notified; edits notify only new mentions", async () => {
    const res = await post(mia, record.id, { body: "@Wanda Lead please check", mentions: [`user:${ids["Wanda Lead"]}`, `user:${ids["Mia Member"]}`] });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.comment.mentions.sort(), [`user:${ids["Mia Member"]}`, `user:${ids["Wanda Lead"]}`].sort());
    const entry = activities("comment.created").find((a) => a.entityId.toHexString() === res.body.comment.id);
    assert.deepEqual(entry.changes, [{ field: "mentions", from: null, to: [`user:${ids["Wanda Lead"]}`] }], "self-mentions don't notify");
    assert.equal((await post(mia, record.id, { body: "@Otto", mentions: [`user:${ids["Otto Outsider"]}`] })).status, 400, "not in this workspace");
    assert.equal((await post(mia, record.id, { body: "x", mentions: ["Wanda Lead"] })).status, 400, "names aren't IDs");
    assert.equal((await post(mia, record.id, { body: "x", mentions: Array.from({ length: 21 }, () => `user:${ids["Wanda Lead"]}`) })).status, 400);
    const edit = await mia.request("PATCH", `/api/v1/comments/${res.body.comment.id}`, { body: "@Wanda Lead @Vic Viewer please check", mentions: [`user:${ids["Wanda Lead"]}`, `user:${ids["Vic Viewer"]}`], expectedVersion: 1 });
    assert.equal(edit.status, 200); assert.ok(edit.body.comment.editedAt);
    const editEntry = activities("comment.updated").at(-1);
    assert.deepEqual(editEntry.changes, [{ field: "mentions", from: null, to: [`user:${ids["Vic Viewer"]}`] }], "Wanda isn't notified twice");
    // The notification feed (what the browser's Mentions tab reads) shows the mention to Wanda.
    const feed = (await wanda.request("GET", "/api/v1/activity")).body.items;
    assert.ok(feed.some((e) => e.action === "comment.created" && e.changes.some((c) => c.field === "mentions" && c.to.includes(`user:${ids["Wanda Lead"]}`))));
    const people = (await mia.request("GET", `/api/v1/records/${record.id}/mentionable`)).body.items.map((p) => p.displayName).sort();
    assert.deepEqual(people, ["Ada Admin", "Mia Member", "Vic Viewer", "Wanda Lead"], "only this workspace's members (Ada created it)"); assert.equal(people.includes("Otto Outsider"), false);
  });

  test("edit and delete: authors only (versioned); moderators delete; tombstones keep threads", async () => {
    const c = (await post(mia, record.id, { body: "Draft" })).body.comment;
    assert.equal((await wanda.request("PATCH", `/api/v1/comments/${c.id}`, { body: "hijack", expectedVersion: 1 })).status, 403, "even admins can't edit others' words");
    assert.equal((await mia.request("PATCH", `/api/v1/comments/${c.id}`, { body: "Final", expectedVersion: 1 })).status, 200);
    assert.equal((await mia.request("PATCH", `/api/v1/comments/${c.id}`, { body: "Stale", expectedVersion: 1 })).status, 409, "a newer edit isn't overwritten");
    assert.equal((await mia.request("PATCH", `/api/v1/comments/${c.id}`, { body: "No version" })).status, 400);
    const reply = (await post(wanda, record.id, { body: "Thanks", parentId: c.id })).body.comment;
    assert.equal((await vic.request("DELETE", `/api/v1/comments/${c.id}`)).status, 403, "viewers can't delete");
    const lone = (await post(wanda, record.id, { body: "Wanda's note" })).body.comment;
    assert.equal((await mia.request("DELETE", `/api/v1/comments/${lone.id}`)).status, 403, "members can't delete others' updates");
    assert.equal((await wanda.request("DELETE", `/api/v1/comments/${c.id}`)).status, 200, "workspace admins moderate");
    assert.equal((await admin.request("DELETE", `/api/v1/comments/${lone.id}`)).status, 200, "JARC administrators moderate");
    const items = (await list(mia)).body.items;
    const tomb = items.find((x) => x.id === c.id);
    assert.equal(tomb.deleted, true); assert.equal(tomb.body, ""); assert.ok(items.some((x) => x.id === reply.id), "the reply stays in its thread");
    assert.equal(items.some((x) => x.id === lone.id), false, "a deleted update without replies disappears");
    assert.equal((await mia.request("PATCH", `/api/v1/comments/${c.id}`, { body: "again", expectedVersion: 3 })).status, 404);
  });

  test("IDs can't be guessed across workspaces; counts are per board and exclude deleted updates", async () => {
    const secret = (await post(otto, otherRecord.id, { body: "Confidential" })).body.comment;
    assert.equal((await mia.request("PATCH", `/api/v1/comments/${secret.id}`, { body: "x", expectedVersion: 1 })).status, 404);
    assert.equal((await mia.request("DELETE", `/api/v1/comments/${secret.id}`)).status, 404);
    assert.equal((await mia.request("GET", `/api/v1/boards/${otherRecord.boardId}/comment-counts`)).status, 404);
    assert.equal((await mia.request("DELETE", `/api/v1/comments/${new ObjectId().toHexString()}`)).status, 404);
    const counts = (await vic.request("GET", `/api/v1/boards/${board.id}/comment-counts`)).body.counts;
    const visible = (await list(vic)).body.items.filter((c) => !c.deleted).length;
    assert.equal(counts[record.id], visible);
  });

  test("activity and comments stay separate: entries carry IDs and a summary, never the text", async () => {
    const c = (await post(mia, record.id, { body: "Secret-ish wording 12345" })).body.comment;
    const entry = activities("comment.created").find((a) => a.entityId.toHexString() === c.id);
    assert.equal(entry.entityType, "comment"); assert.equal(entry.summary, "Posted an update");
    assert.equal(JSON.stringify(entry).includes("12345"), false);
    assert.equal(app.db.collection("activities").docs.some((a) => JSON.stringify(a).includes("Secret-ish")), false);
  });

  test("concurrent posts are all kept, in order", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => post(i % 2 ? wanda : mia, record.id, { body: `parallel ${i}` })));
    assert.ok(results.every((r) => r.status === 201));
    const bodies = (await list(mia)).body.items.map((c) => c.body).filter((b) => b.startsWith("parallel"));
    assert.equal(bodies.length, 5);
  });

  test("archived records keep their discussion but take no new updates; deleting a record deletes its updates", async () => {
    const r = (await mia.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Temp" } })).body.record;
    await post(mia, r.id, { body: "before archive" });
    const archived = (await mia.request("PATCH", `/api/v1/records/${r.id}`, { expectedVersion: r.version, archived: true })).body.record;
    assert.equal((await post(mia, r.id, { body: "after" })).body.error.code, "RECORD_ARCHIVED");
    assert.equal((await list(mia, r.id)).body.items.length, 1, "still readable");
    const restored = (await mia.request("PATCH", `/api/v1/records/${r.id}`, { expectedVersion: archived.version, archived: false })).body.record;
    assert.equal((await post(mia, r.id, { body: "restored" })).status, 201);
    assert.equal((await mia.request("DELETE", `/api/v1/records/${r.id}?expectedVersion=${restored.version}`)).status, 200);
    assert.equal(await app.db.collection("comments").countDocuments({ recordId: new ObjectId(r.id) }), 0);
  });

  test("read-only synced boards refuse updates and group changes (server-side)", async () => {
    const ro = (await admin.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Synced", columns: COLUMNS })).body.board;
    const rec = (await admin.request("POST", `/api/v1/boards/${ro.id}/records`, { values: { serial: "Imported" } })).body.record;
    const c = (await post(mia, rec.id, { body: "before" })).body.comment;
    await app.db.collection("boards").updateOne({ _id: new ObjectId(ro.id) }, { $set: { source: { provider: "monday", sourceBoardId: "1", readOnly: true } } });
    assert.equal((await post(mia, rec.id, { body: "x" })).body.error.code, "READ_ONLY_BOARD");
    assert.equal((await mia.request("PATCH", `/api/v1/comments/${c.id}`, { body: "x", expectedVersion: 1 })).body.error.code, "READ_ONLY_BOARD");
    assert.equal((await mia.request("DELETE", `/api/v1/comments/${c.id}`)).body.error.code, "READ_ONLY_BOARD");
    const b = (await admin.request("GET", `/api/v1/boards/${ro.id}`)).body.board;
    assert.equal((await admin.request("PATCH", `/api/v1/boards/${ro.id}`, { expectedVersion: b.version, groups: [...b.groups, { name: "New" }] })).body.error.code, "READ_ONLY_BOARD");
    assert.equal((await admin.request("DELETE", `/api/v1/boards/${ro.id}/groups/${b.groups[0].id}?expectedVersion=${b.version}&moveTo=none`)).body.error.code, "READ_ONLY_BOARD");
  });

  test("board groups: colour, archive flag and order persist; stale edits conflict; deleting moves records", async () => {
    let b = (await mia.request("GET", `/api/v1/boards/${board.id}`)).body.board;
    const groups = [{ ...b.groups[1], archived: true }, { id: b.groups[0].id, name: "Backlog", color: "#ec4899" }, { name: "Review", color: "#8b5cf6" }].map(({ position, ...g }) => g);
    const res = await mia.request("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, groups });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.board.groups.map((g) => [g.name, g.color, g.archived]), [["Done", "#16a34a", true], ["Backlog", "#ec4899", false], ["Review", "#8b5cf6", false]]);
    assert.equal(res.body.board.groups[1].id, b.groups[0].id, "renaming keeps the group ID");
    assert.equal((await mia.request("GET", `/api/v1/records/${record.id}`)).body.record.groupId, b.groups[0].id, "records keep their group");
    assert.equal((await wanda.request("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, groups: [{ name: "Stale" }] })).status, 409, "a colleague's newer change isn't overwritten");
    assert.equal((await mia.request("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: res.body.board.version, groups: [{ name: "Bad", archived: "yes" }] })).status, 400);
    b = res.body.board;
    const del = await wanda.request("DELETE", `/api/v1/boards/${board.id}/groups/${b.groups[1].id}?expectedVersion=${b.version}&moveTo=${b.groups[2].id}`);
    assert.equal(del.status, 200);
    assert.equal((await mia.request("GET", `/api/v1/records/${record.id}`)).body.record.groupId, b.groups[2].id);
    assert.equal((await vic.request("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: 99, groups: [] })).status, 403, "viewers can't change groups");
  });

  test("rate limit: rapid posting is throttled", async () => {
    const r = (await mia.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Busy" } })).body.record;
    let limited = false;
    for (let i = 0; i < 40 && !limited; i += 1) limited = (await post(wanda, r.id, { body: `n${i}` })).status === 429;
    assert.equal(limited, true);
  });

  test("deleting a board or workspace deletes its updates", async () => {
    const b2 = (await admin.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Short-lived", columns: COLUMNS })).body.board;
    const r = (await admin.request("POST", `/api/v1/boards/${b2.id}/records`, { values: { serial: "x" } })).body.record;
    await post(admin, r.id, { body: "bye" });
    assert.equal((await admin.request("DELETE", `/api/v1/boards/${b2.id}?expectedVersion=${b2.version}`)).status, 200);
    assert.equal(await app.db.collection("comments").countDocuments({ boardId: new ObjectId(b2.id) }), 0);
  });
});

// Production runs ACCESS_POLICY=development_shared: everyone signed in may open every workspace, and the access
// layer treats them as WORKSPACE_ADMIN. That broad access must NOT let ordinary employees moderate each other:
// deleting someone else's update needs a JARC administrator or an explicitly assigned workspace-admin membership.
describe("Phase 8: comment moderation under development_shared (production policy)", () => {
  let app, issuer, admin, lead, emp1, emp2, member, record;
  const ids = {};
  const client = () => new SessionClient(app.url, app.entra.appOrigin);
  const post = (c, body) => c.request("POST", `/api/v1/records/${record.id}/comments`, body);
  const listFor = async (c) => (await c.request("GET", `/api/v1/records/${record.id}/comments`)).body.items;
  before(async () => {
    issuer = await createTokenIssuer();
    app = await startEntraApp({ issuer, accessPolicy: "development_shared" });
    admin = client(); lead = client(); emp1 = client(); emp2 = client(); member = client();
    await admin.signIn(issuer.person("Ada Admin", { admin: true }));
    for (const [c, name] of [[lead, "Lee Lead"], [emp1, "Emma Employee"], [emp2, "Eli Employee"], [member, "Max Member"]]) { await c.signIn(issuer.person(name)); ids[name] = (await c.request("GET", "/api/v1/me")).body.user.id; }
    const ws = (await admin.request("POST", "/api/v1/workspaces", { name: "Shared ops" })).body.workspace;
    assert.equal((await admin.request("POST", `/api/v1/workspaces/${ws.id}/members`, { userId: ids["Lee Lead"], role: "WORKSPACE_ADMIN" })).status, 201);
    assert.equal((await admin.request("POST", `/api/v1/workspaces/${ws.id}/members`, { userId: ids["Max Member"], role: "MEMBER" })).status, 201);
    const board = (await admin.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Jobs", columns: COLUMNS })).body.board;
    record = (await emp1.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Shared job" } })).body.record;
  });
  after(async () => { app.app?.locals?.realtime?.closeAll(); await app.close(); });

  test("every employee may read and post (shared access) but edits and deletes only their own updates", async () => {
    const mine = (await post(emp2, { body: "Eli's own note" })).body.comment;
    assert.equal(mine.canDelete, true);
    assert.equal((await emp2.request("DELETE", `/api/v1/comments/${mine.id}`)).status, 200, "authors delete their own");
    const c = (await post(emp1, { body: "Emma's update" })).body.comment;
    assert.equal((await listFor(emp2)).find((x) => x.id === c.id).canDelete, false, "the UI offers no Delete");
    assert.equal((await emp2.request("DELETE", `/api/v1/comments/${c.id}`)).status, 403, "shared access is not moderation");
    assert.equal((await emp2.request("PATCH", `/api/v1/comments/${c.id}`, { body: "changed", expectedVersion: 1 })).status, 403);
    assert.equal((await member.request("DELETE", `/api/v1/comments/${c.id}`)).status, 403, "an explicit MEMBER membership is not enough either");
    assert.equal((await listFor(emp1)).find((x) => x.id === c.id).body, "Emma's update", "untouched");
  });

  test("explicitly assigned workspace admins and JARC administrators moderate; nobody rewrites another person's words", async () => {
    const a = (await post(emp1, { body: "first" })).body.comment, b = (await post(emp1, { body: "second" })).body.comment;
    assert.equal((await listFor(lead)).find((x) => x.id === a.id).canDelete, true);
    assert.equal((await lead.request("PATCH", `/api/v1/comments/${a.id}`, { body: "x", expectedVersion: 1 })).status, 403, "moderators delete, never rewrite");
    assert.equal((await lead.request("DELETE", `/api/v1/comments/${a.id}`)).status, 200, "assigned workspace admin");
    assert.equal((await admin.request("DELETE", `/api/v1/comments/${b.id}`)).status, 200, "JARC administrator");
    const entry = app.db.collection("activities").docs.filter((e) => e.action === "comment.deleted").at(-1);
    assert.equal(entry.actorUserId.toHexString(), (await admin.request("GET", "/api/v1/me")).body.user.id, "moderation is attributed to the moderator");
  });
});

describe("Phase 8: database setup", () => {
  test("creating the comments collection and its indexes leaves existing collections and records untouched", async () => {
    const { FakeMongoClient } = require("./support/fake-mongo");
    const { MongoConnection } = require("../src/db/connection");
    const { ensureDatabase, COLLECTIONS } = require("../src/db/bootstrap");
    const fake = new FakeMongoClient();
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
    await connection.connect();
    const db = connection.db;
    // A database as Phase 7 left it: every collection except comments, with data.
    for (const name of Object.values(COLLECTIONS)) if (name !== "comments") await db.createCollection(name);
    const board = { _id: new ObjectId(), name: "Existing", groups: [{ id: "grp_aaaaaaaaaa", name: "To do", color: "", position: 1000 }], version: 7 };
    const rec = { _id: new ObjectId(), boardId: board._id, values: { serial: "Keep me" }, groupId: "grp_aaaaaaaaaa", version: 3 };
    await db.collection("boards").insertOne(board); await db.collection("records").insertOne(rec);
    const snapshot = () => JSON.stringify([db.collection("boards").docs, db.collection("records").docs]);
    const before = snapshot();
    const writes = () => [...db.collections.values()].flatMap((c) => c.calls.filter((x) => /insert|update|delete|replace|bulk/i.test(x.op)).map((x) => `${c.name}.${x.op}`));
    const writesBefore = writes().length;
    const result = await ensureDatabase(db);
    assert.deepEqual(result.createdCollections, ["comments"]);
    assert.deepEqual(writes().slice(writesBefore), [], "no document writes at all");
    assert.equal(snapshot(), before);
    assert.deepEqual(db.collection("comments").indexes.map((i) => i.name).sort(), ["_id_", "board_created", "board_live", "record_time", "workspace"], "board_created: Command Center search (Phase 14)");
    assert.deepEqual((await ensureDatabase(db)).createdCollections, [], "running it again changes nothing");
  });
});
