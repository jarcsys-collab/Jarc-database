// Stage 12C: the resource API with Microsoft Entra ID sign-in and server sessions (AUTH_MODE=entra), offline: local
// test keys, fake MongoDB. Each person signs in once (nonce → ID token → session cookie) and then uses the API with the
// cookie + CSRF token, like the browser. Provisioning, workspace isolation, the full permission matrix, membership
// management (last-admin protection) and existing functionality under authentication.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

let app, issuer, people;
const clients = new Map();
// The person's signed-in browser (one session per person, created on first use).
async function browserOf(person) {
  if (!clients.has(person)) {
    const c = new SessionClient(app.url, app.entra.appOrigin);
    const res = await c.signIn(person);
    assert.ok(res.status === 201 || res.status === 403, `sign-in ${person.name}: ${res.status} ${res.text.slice(0, 120)}`);
    clients.set(person, c);
  }
  return clients.get(person);
}
const as = async (person, method, path, body) => (await browserOf(person)).request(method, path, body);
const ok = (res, label) => assert.ok(res.status < 400, `${label}: expected success, got ${res.status} ${res.text?.slice(0, 160)}`);

before(async () => {
  issuer = await createTokenIssuer();
  app = await startEntraApp({ issuer });
  people = {
    sysadmin: issuer.person("Sys Admin", { admin: true }),
    admin: issuer.person("Wanda Admin"),
    member: issuer.person("Manny Member"),
    viewer: issuer.person("Vic Viewer"),
    outsider: issuer.person("Olive Outsider")
  };
  for (const p of Object.values(people)) ok(await as(p, "GET", "/api/v1/me"), `provision ${p.name}`);
});
after(async () => { await app.close(); });

const userId = async (person) => (await as(person, "GET", "/api/v1/me")).body.user.id;
async function workspaceWithRoles(name = "Entra workspace") {
  const ws = (await as(people.sysadmin, "POST", "/api/v1/workspaces", { name })).body.workspace;
  for (const [key, role] of [["admin", "WORKSPACE_ADMIN"], ["member", "MEMBER"], ["viewer", "VIEWER"]]) {
    ok(await as(people.sysadmin, "POST", `/api/v1/workspaces/${ws.id}/members`, { userId: await userId(people[key]), role }), `add ${key}`);
  }
  return ws;
}
const columns = [
  { key: "serial", label: "Item", type: "text", required: true }, { key: "group", label: "Group", type: "group" },
  { key: "status", label: "Status", type: "status", options: ["New", "Done"] }, { key: "qty", label: "Qty", type: "text" }
];
async function fixture(wsId) {
  const board = (await as(people.sysadmin, "POST", `/api/v1/workspaces/${wsId}/boards`, { name: "Fixture", columns })).body.board;
  const records = (await as(people.sysadmin, "POST", `/api/v1/boards/${board.id}/records/batch`, { records: [{ values: { serial: "R1", status: "New" } }, { values: { serial: "R2", status: "Done" } }] })).body.items;
  return { board, records };
}

describe("Authentication", () => {
  test("no session → 401; health and auth config stay public; auth config has no secrets and no API scope", async () => {
    const anonymous = new SessionClient(app.url, app.entra.appOrigin);
    const res = await anonymous.request("GET", "/api/v1/workspaces");
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHENTICATED");
    assert.equal((await anonymous.request("GET", "/api/v1/health")).status, 200);
    const config = await anonymous.request("GET", "/api/v1/auth/config");
    assert.equal(config.status, 200);
    assert.deepEqual(Object.keys(config.body).sort(), ["authority", "clientId", "mode", "redirectUri", "scopes", "tenantId"]);
    assert.deepEqual(config.body.scopes, ["openid", "profile", "email"]);
    assert.equal(config.body.clientId, issuer.config.clientId);
    assert.doesNotMatch(config.text, /secret|password|mongodb|access_as_user|api:\/\//i);
  });

  test("invalid sign-in tokens never create a session, and are never echoed or logged", async () => {
    const bad = [
      (nonce) => issuer.token({ nonce, aud: "00000000-0000-4000-8000-00000000ffff" }),
      (nonce) => issuer.token({ nonce, scp: "User.Read" }),
      (nonce) => issuer.token({ nonce, idtyp: "app", roles: ["JARC.Admin"] }),
      (nonce) => issuer.token({ nonce, tid: "00000000-0000-4000-8000-0000000000bb" }),
      (nonce) => issuer.token({ nonce }, { key: issuer.attackerKey }),
      async (nonce) => `${(await issuer.token({ nonce })).slice(0, -4)}AAAA`
    ];
    for (const make of bad) {
      const c = new SessionClient(app.url, app.entra.appOrigin);
      const start = await c.request("POST", "/api/v1/auth/sign-in/start");
      const idToken = await make(start.body.nonce);
      const res = await c.request("POST", "/api/v1/auth/session", { idToken });
      assert.equal(res.status, 401);
      assert.ok(!c.cookies.has("__Host-jarc_session"));
      assert.ok(!res.text.includes(idToken.slice(0, 40)), "token not echoed");
      assert.ok(!app.logger.errors.join(" ").includes(idToken.slice(0, 40)), "token not logged");
    }
  });

  test("unknown API paths also require a session in Entra mode (fail closed)", async () => {
    assert.equal((await new SessionClient(app.url).request("GET", "/api/v1/not-a-route")).status, 401);
    assert.equal((await as(people.member, "GET", "/api/v1/not-a-route")).status, 404);
  });

  test("the development actor doesn't exist in Entra mode", async () => {
    assert.equal(await app.db.collection("users").countDocuments({ source: "development" }), 0);
    const res = await as(people.member, "GET", "/api/v1/me");
    assert.equal(res.headers.get("x-jarc-auth"), null);
    assert.equal(res.body.authMode, "entra");
  });
});

describe("User provisioning", () => {
  test("first sign-in creates the user keyed by tenant + object ID; email and name are display-only", async () => {
    const p = issuer.person("New Person");
    const first = await as(p, "GET", "/api/v1/me");
    assert.equal(first.status, 200);
    assert.deepEqual([first.body.user.displayName, first.body.user.email, first.body.user.status, first.body.isSystemAdmin], ["New Person", p.email, "active", false]);
    assert.ok(!("tenantId" in first.body.user) && !("entraObjectId" in first.body.user), "Entra identifiers aren't returned");
    const stored = await app.db.collection("users").findOne({ entraObjectId: p.oid });
    assert.equal(stored.tenantId, issuer.config.tenantId);
    // Email and display name change (rename / new address): still the same user after the next sign-in.
    const again = new SessionClient(app.url, app.entra.appOrigin);
    await again.signIn(p, { claims: { email: "renamed@example.invalid", preferred_username: "renamed@example.invalid", name: "Renamed Person" } });
    const changed = await again.request("GET", "/api/v1/me");
    assert.equal(changed.body.user.id, first.body.user.id);
    assert.equal(changed.body.user.email, "renamed@example.invalid");
    assert.equal(await app.db.collection("users").countDocuments({ entraObjectId: p.oid }), 1);
  });

  test("the same email with a different object ID is a different person (email is never the identity)", async () => {
    const a = issuer.person("Same Mail A", { email: "shared@example.invalid" });
    const b = issuer.person("Same Mail B", { email: "shared@example.invalid" });
    assert.notEqual((await as(a, "GET", "/api/v1/me")).body.user.id, (await as(b, "GET", "/api/v1/me")).body.user.id);
  });

  test("ten simultaneous first sign-ins (ten browsers) create exactly one user", async () => {
    const p = issuer.person("Concurrent Person");
    const results = await Promise.all(Array.from({ length: 10 }, async () => new SessionClient(app.url, app.entra.appOrigin).signIn(p)));
    assert.ok(results.every((r) => r.status === 201), results.map((r) => r.status).join(","));
    assert.equal(new Set(results.map((r) => r.body.user.id)).size, 1);
    assert.equal(await app.db.collection("users").countDocuments({ entraObjectId: p.oid }), 1);
  });

  test("a disabled user gets 403 ACCOUNT_DISABLED on the next request and can't sign in again; sign-in never re-enables", async () => {
    const p = issuer.person("Disabled Person");
    ok(await as(p, "GET", "/api/v1/me"), "before");
    await app.db.collection("users").updateOne({ entraObjectId: p.oid }, { $set: { status: "disabled" } });
    const res = await as(p, "GET", "/api/v1/workspaces");
    assert.deepEqual([res.status, res.body.error.code], [403, "ACCOUNT_DISABLED"]);
    const again = await new SessionClient(app.url, app.entra.appOrigin).signIn(p);
    assert.deepEqual([again.status, again.body.error.code], [403, "ACCOUNT_DISABLED"]);
    assert.equal((await app.db.collection("users").findOne({ entraObjectId: p.oid })).status, "disabled");
  });
});

describe("Workspace isolation", () => {
  test("lists show only the caller's workspaces, with their role; system admins see all", async () => {
    const mine = await workspaceWithRoles("Visible");
    const other = (await as(people.sysadmin, "POST", "/api/v1/workspaces", { name: "Hidden" })).body.workspace;
    const viewerList = (await as(people.viewer, "GET", "/api/v1/workspaces")).body.items;
    assert.ok(viewerList.some((w) => w.id === mine.id && w.role === "VIEWER"));
    assert.ok(!viewerList.some((w) => w.id === other.id));
    assert.equal((await as(people.outsider, "GET", "/api/v1/workspaces")).body.items.some((w) => w.id === mine.id), false);
    const all = (await as(people.sysadmin, "GET", "/api/v1/workspaces")).body.items;
    assert.ok(all.some((w) => w.id === other.id) && all.some((w) => w.id === mine.id));
    const me = (await as(people.member, "GET", "/api/v1/me")).body;
    assert.ok(me.memberships.some((m) => m.workspaceId === mine.id && m.role === "MEMBER"));
  });

  test("resources of another workspace are invisible by ID (404), including through batches on one's own board", async () => {
    const mine = await workspaceWithRoles("Mine");
    const theirs = (await as(people.sysadmin, "POST", "/api/v1/workspaces", { name: "Theirs" })).body.workspace;
    const own = await fixture(mine.id), foreign = await fixture(theirs.id);
    for (const path of [`/api/v1/workspaces/${theirs.id}`, `/api/v1/workspaces/${theirs.id}/boards`, `/api/v1/workspaces/${theirs.id}/members`, `/api/v1/boards/${foreign.board.id}`, `/api/v1/boards/${foreign.board.id}/records`, `/api/v1/boards/${foreign.board.id}/activity`, `/api/v1/records/${foreign.records[0].id}`]) {
      const res = await as(people.member, "GET", path);
      assert.equal(res.status, 404, path);
      assert.equal(res.body.error.code, "NOT_FOUND");
    }
    assert.equal((await as(people.member, "PATCH", `/api/v1/records/${foreign.records[0].id}`, { expectedVersion: 1, values: { serial: "x" } })).status, 404);
    // Through a board the member CAN edit: foreign record IDs are not on that board.
    assert.equal((await as(people.member, "PATCH", `/api/v1/boards/${own.board.id}/records`, { items: [{ id: foreign.records[0].id, expectedVersion: 1, values: { serial: "x" } }] })).status, 404);
    const del = await as(people.member, "POST", `/api/v1/boards/${own.board.id}/records/delete`, { records: [{ id: foreign.records[0].id, expectedVersion: 1 }] });
    assert.deepEqual(del.body, { deleted: 0, alreadyDeleted: 1 });
    assert.equal((await as(people.sysadmin, "GET", `/api/v1/records/${foreign.records[0].id}`)).status, 200, "the foreign record is untouched");
    // A workspace ID supplied in a body is never trusted.
    assert.equal((await as(people.member, "POST", `/api/v1/boards/${own.board.id}/records`, { values: { serial: "x" }, workspaceId: theirs.id })).status, 400);
  });

  test("moving a board needs admin rights in both workspaces", async () => {
    const source = await workspaceWithRoles("Source");
    const target = await workspaceWithRoles("Target");
    const hidden = (await as(people.sysadmin, "POST", "/api/v1/workspaces", { name: "No access" })).body.workspace;
    const { board } = await fixture(source.id);
    const adminId = await userId(people.admin);
    const membership = (await as(people.sysadmin, "GET", `/api/v1/workspaces/${target.id}/members`)).body.items.find((m) => m.userId === adminId);
    ok(await as(people.sysadmin, "PATCH", `/api/v1/workspaces/${target.id}/members/${membership.id}`, { role: "VIEWER" }), "demote in target");
    assert.equal((await as(people.admin, "POST", `/api/v1/boards/${board.id}/move`, { expectedVersion: 1, workspaceId: target.id })).status, 403);
    assert.equal((await as(people.admin, "POST", `/api/v1/boards/${board.id}/move`, { expectedVersion: 1, workspaceId: hidden.id })).status, 404);
    ok(await as(people.sysadmin, "PATCH", `/api/v1/workspaces/${target.id}/members/${membership.id}`, { role: "WORKSPACE_ADMIN" }), "promote in target");
    ok(await as(people.admin, "POST", `/api/v1/boards/${board.id}/move`, { expectedVersion: 1, workspaceId: target.id }), "move");
  });
});

describe("Permission matrix", () => {
  // Each operation gets a fresh fixture; `min` is the lowest role allowed.
  const ops = [
    ["read workspace", "VIEWER", (f) => ["GET", `/api/v1/workspaces/${f.ws.id}`]],
    ["list boards", "VIEWER", (f) => ["GET", `/api/v1/workspaces/${f.ws.id}/boards`]],
    ["read board", "VIEWER", (f) => ["GET", `/api/v1/boards/${f.board.id}`]],
    ["list records", "VIEWER", (f) => ["GET", `/api/v1/boards/${f.board.id}/records`]],
    ["read record", "VIEWER", (f) => ["GET", `/api/v1/records/${f.records[0].id}`]],
    ["read activity", "VIEWER", (f) => ["GET", `/api/v1/boards/${f.board.id}/activity`]],
    ["list members", "VIEWER", (f) => ["GET", `/api/v1/workspaces/${f.ws.id}/members`]],
    ["create board", "MEMBER", (f) => ["POST", `/api/v1/workspaces/${f.ws.id}/boards`, { name: "New" }]],
    ["rename board", "MEMBER", (f) => ["PATCH", `/api/v1/boards/${f.board.id}`, { expectedVersion: 1, name: "Renamed" }]],
    ["create record", "MEMBER", (f) => ["POST", `/api/v1/boards/${f.board.id}/records`, { values: { serial: "N" } }]],
    ["batch create", "MEMBER", (f) => ["POST", `/api/v1/boards/${f.board.id}/records/batch`, { records: [{ values: { serial: "A" } }, { values: { serial: "B" } }] }]],
    ["batch update", "MEMBER", (f) => ["PATCH", `/api/v1/boards/${f.board.id}/records`, { items: [{ id: f.records[0].id, expectedVersion: 1, values: { status: "Done" } }] }]],
    ["batch delete", "MEMBER", (f) => ["POST", `/api/v1/boards/${f.board.id}/records/delete`, { records: [{ id: f.records[0].id, expectedVersion: 1 }] }]],
    ["edit record", "MEMBER", (f) => ["PATCH", `/api/v1/records/${f.records[0].id}`, { expectedVersion: 1, values: { status: "Done" } }]],
    ["delete record", "MEMBER", (f) => ["DELETE", `/api/v1/records/${f.records[0].id}?expectedVersion=1`]],
    ["add column", "MEMBER", (f) => ["POST", `/api/v1/boards/${f.board.id}/columns`, { expectedVersion: 1, column: { key: "extra", label: "Extra", type: "text" } }]],
    ["rename/add options", "MEMBER", (f) => ["PUT", `/api/v1/boards/${f.board.id}/columns/status/options`, { expectedVersion: 1, items: [{ from: "New", to: "Open" }, { from: "Done", to: "Done" }, { from: null, to: "Blocked" }] }]],
    ["delete group (records moved)", "MEMBER", (f) => ["DELETE", `/api/v1/boards/${f.board.id}/groups/${f.board.groups[0].id}?expectedVersion=1&moveTo=${f.board.groups[1].id}`]],
    ["remove options", "WORKSPACE_ADMIN", (f) => ["PUT", `/api/v1/boards/${f.board.id}/columns/status/options`, { expectedVersion: 1, items: [{ from: "New", to: "New" }] }]],
    ["delete column", "WORKSPACE_ADMIN", (f) => ["DELETE", `/api/v1/boards/${f.board.id}/columns/qty?expectedVersion=1`]],
    ["change column type", "WORKSPACE_ADMIN", (f) => ["POST", `/api/v1/boards/${f.board.id}/columns/qty/type`, { expectedVersion: 1, type: "number" }]],
    ["archive board", "WORKSPACE_ADMIN", (f) => ["PATCH", `/api/v1/boards/${f.board.id}`, { expectedVersion: 1, archived: true }]],
    ["delete board", "WORKSPACE_ADMIN", (f) => ["DELETE", `/api/v1/boards/${f.board.id}?expectedVersion=1`]],
    ["update workspace", "WORKSPACE_ADMIN", (f) => ["PATCH", `/api/v1/workspaces/${f.ws.id}`, { expectedVersion: f.ws.version, name: "Renamed workspace" }]],
    ["add member", "WORKSPACE_ADMIN", (f) => ["POST", `/api/v1/workspaces/${f.ws.id}/members`, { userId: f.outsiderId, role: "VIEWER" }]],
    ["change member role", "WORKSPACE_ADMIN", (f) => ["PATCH", `/api/v1/workspaces/${f.ws.id}/members/${f.viewerMembership}`, { role: "MEMBER" }]],
    ["remove member", "WORKSPACE_ADMIN", (f) => ["DELETE", `/api/v1/workspaces/${f.ws.id}/members/${f.viewerMembership}`]],
    ["delete workspace", "SYSTEM_ADMIN", (f) => ["DELETE", `/api/v1/workspaces/${f.ws.id}?expectedVersion=${f.ws.version}`]]
  ];
  const RANK = { VIEWER: 1, MEMBER: 2, WORKSPACE_ADMIN: 3, SYSTEM_ADMIN: 4 };
  const roles = [["viewer", "VIEWER"], ["member", "MEMBER"], ["admin", "WORKSPACE_ADMIN"], ["sysadmin", "SYSTEM_ADMIN"], ["outsider", null]];

  for (const [name, min, build] of ops) {
    test(`${name}: ${min} and above allowed; lower roles 403; non-members 404`, async () => {
      for (const [key, role] of roles) {
        const ws = await workspaceWithRoles(`Matrix ${name}`);
        const fx = { ws: (await as(people.sysadmin, "GET", `/api/v1/workspaces/${ws.id}`)).body.workspace, ...(await fixture(ws.id)), outsiderId: await userId(people.outsider) };
        const viewerId = await userId(people.viewer);
        fx.viewerMembership = (await as(people.sysadmin, "GET", `/api/v1/workspaces/${ws.id}/members`)).body.items.find((m) => m.userId === viewerId).id;
        const [method, path, body] = build(fx);
        const res = await as(people[key], method, path, body);
        if (!role) assert.equal(res.status, 404, `${key} ${name}: ${res.text.slice(0, 120)}`);
        else if (RANK[role] >= RANK[min]) ok(res, `${key} ${name}`);
        else { assert.equal(res.status, 403, `${key} ${name}: ${res.text.slice(0, 120)}`); assert.equal(res.body.error.code, "FORBIDDEN"); }
      }
    });
  }

  test("creating workspaces and importing data: JARC administrators only (403 for everyone else)", async () => {
    for (const key of ["viewer", "member", "admin", "outsider"]) {
      assert.equal((await as(people[key], "POST", "/api/v1/workspaces", { name: "Nope" })).status, 403, key);
      assert.equal((await as(people[key], "POST", "/api/v1/imports?dryRun=true", { schemaVersion: 1, workspaces: [{ id: "x", name: "X", boards: [] }] })).status, 403, key);
    }
    const created = await as(people.sysadmin, "POST", "/api/v1/workspaces", { name: "By admin" });
    assert.equal(created.status, 201);
    assert.equal(created.body.workspace.role, "WORKSPACE_ADMIN", "the creator becomes the workspace admin");
    const imported = await as(people.sysadmin, "POST", "/api/v1/imports", { schemaVersion: 1, workspaces: [{ id: "entra-import", name: "Imported", boards: [{ id: "b1", name: "Board", records: [{ id: 1, serial: "A" }] }] }] });
    assert.equal(imported.status, 201, imported.text);
    const importer = await userId(people.sysadmin);
    const ws = (await app.db.collection("workspaces").findOne({ legacyId: "entra-import" }));
    const membership = await app.db.collection("workspaceMembers").findOne({ workspaceId: ws._id });
    assert.equal(membership.userId.toHexString(), importer);
  });

  test("activity entries record the signed-in Entra user as the actor", async () => {
    const ws = await workspaceWithRoles("Actor");
    const { board, records } = await fixture(ws.id);
    ok(await as(people.member, "PATCH", `/api/v1/records/${records[0].id}`, { expectedVersion: 1, values: { status: "Done" } }), "edit");
    const entry = (await as(people.viewer, "GET", `/api/v1/boards/${board.id}/activity`)).body.items[0];
    assert.equal(entry.actorUserId, await userId(people.member));
    assert.equal((await as(people.member, "GET", `/api/v1/records/${records[0].id}`)).body.record.updatedBy, await userId(people.member));
  });
});

describe("Membership management", () => {
  async function soloWorkspace() {
    const ws = (await as(people.sysadmin, "POST", "/api/v1/workspaces", { name: "Solo" })).body.workspace;
    const sysId = await userId(people.sysadmin);
    const adminId = await userId(people.admin);
    ok(await as(people.sysadmin, "POST", `/api/v1/workspaces/${ws.id}/members`, { userId: adminId, role: "WORKSPACE_ADMIN" }), "add admin");
    // Remove the creator (system admin) so Wanda is the only workspace admin.
    const sys = (await as(people.sysadmin, "GET", `/api/v1/workspaces/${ws.id}/members`)).body.items.find((m) => m.userId === sysId);
    ok(await as(people.sysadmin, "DELETE", `/api/v1/workspaces/${ws.id}/members/${sys.id}`), "remove creator");
    const members = (await as(people.admin, "GET", `/api/v1/workspaces/${ws.id}/members`)).body.items;
    return { ws, me: members.find((m) => m.userId === adminId) };
  }

  test("LAST ADMIN: the only admin can't demote or remove themselves; after adding another admin they can", async () => {
    const { ws, me } = await soloWorkspace();
    const demote = await as(people.admin, "PATCH", `/api/v1/workspaces/${ws.id}/members/${me.id}`, { role: "MEMBER" });
    assert.equal(demote.status, 400);
    assert.match(demote.body.error.message, /at least one admin/);
    assert.equal((await as(people.admin, "DELETE", `/api/v1/workspaces/${ws.id}/members/${me.id}`)).status, 400);
    const admins = (await as(people.admin, "GET", `/api/v1/workspaces/${ws.id}/members`)).body.items.filter((m) => m.role === "WORKSPACE_ADMIN");
    assert.deepEqual(admins.map((m) => m.id), [me.id], "still exactly one admin: Wanda");
    const added = await as(people.admin, "POST", `/api/v1/workspaces/${ws.id}/members`, { email: people.member.email.toUpperCase(), role: "WORKSPACE_ADMIN" });
    assert.equal(added.status, 201, "added by email (case-insensitive)");
    assert.equal(added.body.member.displayName, "Manny Member");
    ok(await as(people.admin, "PATCH", `/api/v1/workspaces/${ws.id}/members/${me.id}`, { role: "MEMBER" }), "demote now allowed");
    assert.equal((await as(people.admin, "POST", `/api/v1/workspaces/${ws.id}/members`, { userId: await userId(people.viewer), role: "VIEWER" })).status, 403, "no longer an admin");
  });

  test("validation: duplicates, unknown users, disabled users, members of other workspaces, bad roles", async () => {
    const ws = await workspaceWithRoles("Validation");
    const res = (body) => as(people.admin, "POST", `/api/v1/workspaces/${ws.id}/members`, body);
    assert.equal((await res({ userId: await userId(people.member), role: "VIEWER" })).status, 409, "already a member");
    assert.equal((await res({ email: "nobody@example.invalid", role: "VIEWER" })).status, 404, "never signed in");
    assert.equal((await res({ userId: await userId(people.outsider), role: "OWNER" })).status, 400);
    assert.equal((await res({ userId: await userId(people.outsider), email: people.outsider.email, role: "VIEWER" })).status, 400, "one of userId or email");
    assert.equal((await res({ userId: await userId(people.outsider), role: "VIEWER", isSystemAdmin: true })).status, 400, "unknown field");
    const disabled = issuer.person("Off User");
    await as(disabled, "GET", "/api/v1/me");
    await app.db.collection("users").updateOne({ entraObjectId: disabled.oid }, { $set: { status: "disabled" } });
    assert.equal((await res({ email: disabled.email, role: "VIEWER" })).status, 400);
    const other = await workspaceWithRoles("Other");
    const foreignMember = (await as(people.sysadmin, "GET", `/api/v1/workspaces/${other.id}/members`)).body.items[0];
    assert.equal((await as(people.admin, "PATCH", `/api/v1/workspaces/${ws.id}/members/${foreignMember.id}`, { role: "VIEWER" })).status, 404, "a membership of another workspace");
    assert.equal((await as(people.admin, "DELETE", `/api/v1/workspaces/${ws.id}/members/aaaaaaaaaaaaaaaaaaaaaaaa`)).status, 404);
  });

  test("a removed member loses access immediately", async () => {
    const ws = await workspaceWithRoles("Revoke");
    const { board } = await fixture(ws.id);
    assert.equal((await as(people.viewer, "GET", `/api/v1/boards/${board.id}`)).status, 200);
    const viewerId = await userId(people.viewer);
    const m = (await as(people.admin, "GET", `/api/v1/workspaces/${ws.id}/members`)).body.items.find((x) => x.userId === viewerId);
    ok(await as(people.admin, "DELETE", `/api/v1/workspaces/${ws.id}/members/${m.id}`), "remove");
    assert.equal((await as(people.viewer, "GET", `/api/v1/boards/${board.id}`)).status, 404);
  });
});

describe("Existing functionality under Entra authentication", () => {
  test("a member works through the Stage 10/11 API: boards, records, versions/409, batches, schema, pagination", async () => {
    const ws = await workspaceWithRoles("Works");
    const board = (await as(people.member, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Member board", columns })).body.board;
    assert.equal(board.createdBy, await userId(people.member));
    const batch = (await as(people.member, "POST", `/api/v1/boards/${board.id}/records/batch`, { records: Array.from({ length: 120 }, (_, i) => ({ values: { serial: `R${i}` } })) })).body.items;
    assert.equal(batch.length, 120);
    const page1 = (await as(people.viewer, "GET", `/api/v1/boards/${board.id}/records?limit=100`)).body;
    const page2 = (await as(people.viewer, "GET", `/api/v1/boards/${board.id}/records?limit=100&cursor=${page1.nextCursor}`)).body;
    assert.equal(page1.items.length + page2.items.length, 120);
    ok(await as(people.member, "PATCH", `/api/v1/records/${batch[0].id}`, { expectedVersion: 1, values: { status: "Done" } }), "edit v1");
    const stale = await as(people.admin, "PATCH", `/api/v1/records/${batch[0].id}`, { expectedVersion: 1, values: { status: "New" } });
    assert.equal(stale.status, 409);
    ok(await as(people.member, "POST", `/api/v1/boards/${board.id}/columns`, { expectedVersion: 1, column: { key: "extra", label: "Extra", type: "checkbox" } }), "add column");
    ok(await as(people.admin, "DELETE", `/api/v1/boards/${board.id}/columns/extra?expectedVersion=2`), "admin deletes column");
  });
});
