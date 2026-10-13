// Beta open editing (JARC_BETA_OPEN_EDITING=true) on top of ACCESS_POLICY=role_based, with Microsoft sign-in on the
// fake MongoDB. Employees with different workspace roles — a VIEWER member and someone with no membership at all —
// can create, edit, organise and delete content (workspaces, boards, records, groups, columns, files, views,
// comments). Still restricted: JARC administration (imports, integrations), membership changes, comment moderation
// and editing, read-only synchronized boards, version checks and CSRF. With the setting off, role_based returns.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { loadConfig } = require("../src/config");

const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["New", "Working", "Done"] }, { key: "docs", label: "Files", type: "files" }];
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body-".repeat(50))]);

async function setup({ beta }) {
  const issuer = await createTokenIssuer();
  const app = await startEntraApp({ issuer, accessPolicy: "role_based", betaOpenEditing: beta });
  const c = () => new SessionClient(app.url, app.entra.appOrigin);
  const people = { admin: c(), vic: c(), mo: c(), nora: c() }, ids = {};
  await people.admin.signIn(issuer.person("Ada Admin", { admin: true }));
  for (const [k, name] of [["vic", "Vic Viewer"], ["mo", "Mo Member"], ["nora", "Nora Nobody"]]) { await people[k].signIn(issuer.person(name)); ids[k] = (await people[k].request("GET", "/api/v1/me")).body.user.id; }
  const ws = (await people.admin.request("POST", "/api/v1/workspaces", { name: "Ops" })).body.workspace;
  await people.admin.request("POST", `/api/v1/workspaces/${ws.id}/members`, { userId: ids.vic, role: "VIEWER" });
  await people.admin.request("POST", `/api/v1/workspaces/${ws.id}/members`, { userId: ids.mo, role: "MEMBER" });
  const board = (await people.admin.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Legacy", columns: COLUMNS })).body.board;
  // Records saved before Phase 8 on a board without a Group column: no group.
  await people.admin.request("POST", `/api/v1/boards/${board.id}/records/batch`, { records: [{ values: { serial: "Old 1", status: "Working" } }, { values: { serial: "Old 2", status: "Done" } }] });
  const records = async () => (await people.admin.request("GET", `/api/v1/boards/${board.id}/records`)).body.items;
  return { app, issuer, people, ids, ws, board, records };
}
const upload = (client, recordId) => fetch(`${client.base}/api/v1/records/${recordId}/attachments?column=docs`, { method: "POST", body: PNG, headers: { Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "), Origin: client.origin, "X-CSRF-Token": client.csrf, "Content-Type": "image/png", "X-File-Name": "photo.png" } });

describe("JARC_BETA_OPEN_EDITING configuration", () => {
  test("off unless exactly \"true\"; the session tells the browser", () => {
    for (const value of [undefined, "", "false", "TRUE", "1", "yes", " true"]) assert.equal(loadConfig(value === undefined ? {} : { JARC_BETA_OPEN_EDITING: value }).betaOpenEditing, false, String(value));
    assert.equal(loadConfig({ JARC_BETA_OPEN_EDITING: "true" }).betaOpenEditing, true);
  });
});

describe("Beta open editing ON (role_based + JARC_BETA_OPEN_EDITING=true)", () => {
  let s;
  before(async () => { s = await setup({ beta: true }); });
  after(async () => { s.app.app?.locals?.realtime?.closeAll(); await s.app.close(); });

  test("the session reports beta mode; a viewer and a non-member see and edit records (including ones without a group)", async () => {
    for (const k of ["vic", "nora"]) {
      const me = (await s.people[k].request("GET", "/api/v1/auth/session")).body;
      assert.equal(me.betaOpenEditing, true); assert.equal(me.canCreateWorkspaces, true);
    }
    const [r1] = await s.records();
    assert.equal(r1.groupId, null, "a legacy record without a group");
    const edited = await s.people.vic.request("PATCH", `/api/v1/records/${r1.id}`, { expectedVersion: r1.version, values: { status: "Done" } });
    assert.equal(edited.status, 200, "a VIEWER member can edit");
    const working = s.board.groups.find((g) => g.name === "Working");
    const moved = await s.people.nora.request("PATCH", `/api/v1/records/${r1.id}`, { expectedVersion: edited.body.record.version, groupId: working.id });
    assert.equal(moved.status, 200, "a non-member moves it out of No group");
    assert.equal((await s.records()).find((r) => r.id === r1.id).groupId, working.id, "persisted");
    const created = await s.people.nora.request("POST", `/api/v1/boards/${s.board.id}/records`, { values: { serial: "New by Nora" }, groupId: working.id });
    assert.equal(created.status, 201);
    const batch = await s.people.vic.request("PATCH", `/api/v1/boards/${s.board.id}/records`, { items: (await s.records()).filter((r) => r.groupId === null).map((r) => ({ id: r.id, expectedVersion: r.version, groupId: working.id })) });
    assert.equal(batch.status, 200, "several records move at once");
    assert.equal((await s.records()).filter((r) => r.groupId === null).length, 0);
    assert.equal((await s.people.nora.request("DELETE", `/api/v1/records/${created.body.record.id}?expectedVersion=${created.body.record.version}`)).status, 200);
  });

  test("groups, columns, views and boards: both employees manage them", async () => {
    let b = (await s.people.vic.request("GET", `/api/v1/boards/${s.board.id}`)).body.board;
    const groups = [...b.groups.map(({ position, ...g }) => g), { name: "Backlog", color: "#ec4899" }];
    const g = await s.people.vic.request("PATCH", `/api/v1/boards/${s.board.id}`, { expectedVersion: b.version, groups, savedViews: [{ name: "Mine", state: { quickFilter: "mine" } }] });
    assert.equal(g.status, 200); b = g.body.board;
    assert.ok(b.groups.some((x) => x.name === "Backlog")); assert.equal(b.savedViews[0].name, "Mine");
    const col = await s.people.nora.request("POST", `/api/v1/boards/${s.board.id}/columns`, { expectedVersion: b.version, column: { key: "notes", label: "Notes", type: "text" } });
    assert.equal(col.status, 201, JSON.stringify(col.body).slice(0, 200)); b = col.body.board;
    const del = await s.people.vic.request("DELETE", `/api/v1/boards/${s.board.id}/columns/notes?expectedVersion=${b.version}`);
    assert.equal(del.status, 200, "column deletion (normally WORKSPACE_ADMIN)");
    const nb = (await s.people.nora.request("POST", `/api/v1/workspaces/${s.ws.id}/boards`, { name: "Nora's board" })).body.board;
    assert.ok(nb);
    assert.equal((await s.people.nora.request("PATCH", `/api/v1/boards/${nb.id}`, { expectedVersion: nb.version, name: "Renamed" })).status, 200);
    assert.equal((await s.people.vic.request("DELETE", `/api/v1/boards/${nb.id}?expectedVersion=${nb.version + 1}`)).status, 200, "board deletion (normally WORKSPACE_ADMIN)");
  });

  test("workspaces: create, rename, archive and delete", async () => {
    const w = (await s.people.nora.request("POST", "/api/v1/workspaces", { name: "Nora's space" })).body.workspace;
    assert.ok(w);
    const renamed = await s.people.vic.request("PATCH", `/api/v1/workspaces/${w.id}`, { expectedVersion: w.version, name: "Shared space", archived: true });
    assert.equal(renamed.status, 200);
    assert.equal((await s.people.vic.request("DELETE", `/api/v1/workspaces/${w.id}?expectedVersion=${renamed.body.workspace.version}`)).status, 200);
  });

  test("files upload within the normal limits", async () => {
    const [r] = await s.records();
    const res = await upload(s.people.vic, r.id);
    assert.equal(res.status, 201);
  });

  test("still enforced: version checks, CSRF, read-only synced boards", async () => {
    const [r] = await s.records();
    assert.equal((await s.people.vic.request("PATCH", `/api/v1/records/${r.id}`, { expectedVersion: r.version, values: { status: "New" } })).status, 200);
    assert.equal((await s.people.nora.request("PATCH", `/api/v1/records/${r.id}`, { expectedVersion: r.version, values: { status: "Done" } })).status, 409, "a colleague's newer change isn't overwritten");
    assert.equal((await s.people.nora.request("POST", `/api/v1/boards/${s.board.id}/records`, { values: { serial: "x" } }, { csrf: "wrong" })).status, 403, "CSRF");
    assert.equal((await s.people.nora.request("POST", `/api/v1/boards/${s.board.id}/records`, { values: { serial: "x" } }, { origin: "https://evil.example" })).status, 403, "foreign origin");
    const ro = (await s.people.admin.request("POST", `/api/v1/workspaces/${s.ws.id}/boards`, { name: "Synced" })).body.board;
    await s.app.db.collection("boards").updateOne({ _id: new ObjectId(ro.id) }, { $set: { source: { provider: "monday", sourceBoardId: "9", readOnly: true } } });
    assert.equal((await s.people.vic.request("POST", `/api/v1/boards/${ro.id}/records`, { values: { serial: "x" } })).body.error.code, "READ_ONLY_BOARD");
    assert.equal((await s.people.vic.request("PATCH", `/api/v1/boards/${ro.id}`, { expectedVersion: ro.version, groups: [{ name: "X" }] })).body.error.code, "READ_ONLY_BOARD");
  });

  test("still JARC administrators only: imports, integrations, membership changes", async () => {
    for (const [m, p, body] of [["POST", "/api/v1/integrations/monday/connect"], ["POST", "/api/v1/integrations/monday/sync", { syncEnabled: true }], ["POST", "/api/v1/integrations/monday/imports", { boardIds: ["1"], workspaceId: s.ws.id, confirm: true }], ["POST", "/api/v1/imports?dryRun=true", {}]]) {
      assert.equal((await s.people.nora.request(m, p, body)).status, 403, `${m} ${p}`);
    }
    assert.equal((await s.people.vic.request("POST", `/api/v1/workspaces/${s.ws.id}/members`, { userId: s.ids.nora, role: "WORKSPACE_ADMIN" })).status, 403, "no self-promotion through beta");
    assert.equal(await s.app.db.collection("workspaceMembers").countDocuments({ userId: new ObjectId(s.ids.nora) }), 0, "beta access is never stored");
  });

  test("comments: everyone posts; only authors edit; deleting another person's update needs a real moderator", async () => {
    const [r] = await s.records();
    const c = (await s.people.vic.request("POST", `/api/v1/records/${r.id}/comments`, { body: "Vic's update" })).body.comment;
    const reply = await s.people.nora.request("POST", `/api/v1/records/${r.id}/comments`, { body: "Nora replies", parentId: c.id });
    assert.equal(reply.status, 201);
    assert.equal((await s.people.nora.request("PATCH", `/api/v1/comments/${c.id}`, { body: "x", expectedVersion: 1 })).status, 403);
    assert.equal((await s.people.nora.request("DELETE", `/api/v1/comments/${c.id}`)).status, 403, "beta access is not moderation");
    assert.equal((await s.people.mo.request("DELETE", `/api/v1/comments/${c.id}`)).status, 403);
    assert.equal((await s.people.nora.request("DELETE", `/api/v1/comments/${reply.body.comment.id}`)).status, 200, "own update");
    assert.equal((await s.people.admin.request("DELETE", `/api/v1/comments/${c.id}`)).status, 200, "JARC administrator");
  });
});

describe("Beta open editing OFF: role_based permissions return", () => {
  let s;
  before(async () => { s = await setup({ beta: false }); });
  after(async () => { s.app.app?.locals?.realtime?.closeAll(); await s.app.close(); });

  test("viewers can't edit, non-members can't see, only administrators create workspaces", async () => {
    const [r] = await s.records();
    assert.equal((await s.people.vic.request("GET", "/api/v1/auth/session")).body.betaOpenEditing, false);
    assert.equal((await s.people.vic.request("PATCH", `/api/v1/records/${r.id}`, { expectedVersion: r.version, values: { status: "Done" } })).status, 403);
    assert.equal((await s.people.nora.request("PATCH", `/api/v1/records/${r.id}`, { expectedVersion: r.version, values: { status: "Done" } })).status, 404);
    assert.equal((await s.people.nora.request("GET", `/api/v1/boards/${s.board.id}`)).status, 404);
    assert.equal((await s.people.nora.request("POST", "/api/v1/workspaces", { name: "x" })).status, 403);
    assert.equal((await s.people.mo.request("PATCH", `/api/v1/records/${r.id}`, { expectedVersion: r.version, values: { status: "Done" } })).status, 200, "members still edit");
    assert.equal((await s.people.mo.request("DELETE", `/api/v1/boards/${s.board.id}/columns/status?expectedVersion=${s.board.version}`)).status, 403, "column deletion needs WORKSPACE_ADMIN");
  });
});
