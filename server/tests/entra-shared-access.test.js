// ACCESS_POLICY=development_shared: every signed-in employee of the configured tenant works in every workspace.
// Also checks what does NOT change: sign-in, sessions, CSRF and tenant checks; imports and membership changes; and
// role_based (the default, also for unset or unknown values). Offline: local test keys, fake MongoDB.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { loadConfig } = require("../src/config");
const { createApp } = require("../src/app");
const { Access } = require("../src/auth/access");
const { ObjectId } = require("mongodb");

const ENTRA_ENV = {
  DATA_STORE: "mongodb", MONGODB_URI: "mongodb://fake.invalid", MONGODB_DB_NAME: "jarc_database", AUTH_MODE: "entra",
  ENTRA_TENANT_ID: "11111111-1111-1111-1111-111111111111", ENTRA_SPA_CLIENT_ID: "22222222-2222-2222-2222-222222222222", ENTRA_REDIRECT_URI: "https://jarc.example.invalid/"
};
const ok = (res, label) => assert.ok(res.status < 400, `${label}: expected success, got ${res.status} ${res.text?.slice(0, 160)}`);
const columns = [
  { key: "serial", label: "Item", type: "text", required: true }, { key: "group", label: "Group", type: "group" },
  { key: "status", label: "Status", type: "status", options: ["New", "Done"] }, { key: "qty", label: "Qty", type: "text" }
];

describe("ACCESS_POLICY configuration", () => {
  test("unset, empty, role_based or any unknown value → role_based (fails safe); only the exact value shares", () => {
    for (const value of [undefined, "", "role_based"]) {
      const config = loadConfig({ ...ENTRA_ENV, ACCESS_POLICY: value });
      assert.deepEqual([config.accessPolicy, config.accessPolicyIgnored], ["role_based", false], String(value));
    }
    for (const value of ["Development_Shared", "development-shared", "shared", "true", " development_shared"]) {
      const config = loadConfig({ ...ENTRA_ENV, ACCESS_POLICY: value });
      assert.deepEqual([config.accessPolicy, config.accessPolicyIgnored], ["role_based", true], value);
    }
    assert.equal(loadConfig({ ...ENTRA_ENV, ACCESS_POLICY: "development_shared" }).accessPolicy, "development_shared");
  });

  test("development_shared never turns off sign-in: production still requires AUTH_MODE=entra and every Entra setting", () => {
    assert.throws(() => loadConfig({ NODE_ENV: "production", ACCESS_POLICY: "development_shared" }), /Production requires AUTH_MODE=entra/);
    assert.throws(() => loadConfig({ ...ENTRA_ENV, NODE_ENV: "production", ACCESS_POLICY: "development_shared", ENTRA_TENANT_ID: "" }), /needs ENTRA_TENANT_ID/);
    const config = loadConfig({ ...ENTRA_ENV, NODE_ENV: "production", ACCESS_POLICY: "development_shared" });
    assert.deepEqual([config.authMode, config.accessPolicy, config.enableDevResourceApi, config.enableDevStateApi], ["entra", "development_shared", false, false]);
  });

  test("the app and the access checks refuse an unknown policy instead of guessing", () => {
    assert.throws(() => new Access({}, { policy: "open" }), /Unknown access policy/);
    assert.throws(() => createApp({ environment: "test", enableDevStateApi: false, dataLayer: { repos: {} }, devActor: {}, enableDevResourceApi: true, accessPolicy: "open" }), /Unknown access policy/);
  });
});

describe("development_shared", () => {
  let app, issuer, people;
  const clients = new Map();
  const browser = async (person) => {
    if (!clients.has(person)) {
      const c = new SessionClient(app.url, app.entra.appOrigin);
      ok(await c.signIn(person), `sign-in ${person.name}`);
      clients.set(person, c);
    }
    return clients.get(person);
  };
  const as = async (person, method, path, body) => (await browser(person)).request(method, path, body);

  before(async () => {
    issuer = await createTokenIssuer();
    app = await startEntraApp({ issuer, accessPolicy: "development_shared" });
    // Ordinary employees: no JARC.Admin app role and no workspace memberships.
    people = { ana: issuer.person("Ana Employee"), ben: issuer.person("Ben Employee"), cara: issuer.person("Cara Employee"), admin: issuer.person("Sys Admin", { admin: true }) };
  });
  after(async () => { await app.close(); });

  test("the session and /me report the policy; employees without JARC.Admin may create workspaces", async () => {
    const c = new SessionClient(app.url, app.entra.appOrigin);
    const signIn = await c.signIn(issuer.person("Policy Reader"));
    assert.deepEqual([signIn.body.isSystemAdmin, signIn.body.accessPolicy, signIn.body.canCreateWorkspaces], [false, "development_shared", true]);
    const session = (await c.request("GET", "/api/v1/auth/session")).body;
    assert.deepEqual([session.accessPolicy, session.canCreateWorkspaces], ["development_shared", true]);
    const me = (await c.request("GET", "/api/v1/me")).body;
    assert.deepEqual([me.isSystemAdmin, me.accessPolicy, me.canCreateWorkspaces], [false, "development_shared", true]);
  });

  test("CROSS-USER VISIBILITY: a workspace created by one employee is immediately visible to every other employee (other browsers)", async () => {
    const created = await as(people.ana, "POST", "/api/v1/workspaces", { name: "Ana's workspace" });
    assert.equal(created.status, 201, created.text);
    const id = created.body.workspace.id;
    for (const person of [people.ben, people.cara, people.admin]) {
      const list = await as(person, "GET", "/api/v1/workspaces");
      const item = list.body.items.find((w) => w.id === id);
      assert.ok(item, `${person.name} sees it`);
      assert.equal(item.role, person.admin ? "SYSTEM_ADMIN" : "WORKSPACE_ADMIN");
      assert.equal((await as(person, "GET", `/api/v1/workspaces/${id}`)).status, 200);
    }
    // A brand-new browser for the same person (another device) sees it too: it is in MongoDB, not in the browser.
    const device = new SessionClient(app.url, app.entra.appOrigin);
    ok(await device.signIn(people.ben), "second device");
    assert.ok((await device.request("GET", "/api/v1/workspaces")).body.items.some((w) => w.id === id));
  });

  test("CRUD: any employee manages boards, columns and records in a workspace someone else created", async () => {
    const ws = (await as(people.ana, "POST", "/api/v1/workspaces", { name: "Shared CRUD" })).body.workspace;
    const ben = (m, p, b) => as(people.ben, m, p, b);
    const board = (await ben("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Ben's board", columns })).body.board;
    assert.ok(board, "Ben creates a board");
    ok(await ben("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: 1, name: "Renamed" }), "rename board");
    ok(await ben("POST", `/api/v1/boards/${board.id}/columns`, { expectedVersion: 2, column: { key: "extra", label: "Extra", type: "text" } }), "add column");
    ok(await ben("POST", `/api/v1/boards/${board.id}/columns/qty/type`, { expectedVersion: 3, type: "number" }), "change column type");
    ok(await ben("PUT", `/api/v1/boards/${board.id}/columns/status/options`, { expectedVersion: 4, items: [{ from: "New", to: "New" }] }), "remove an option");
    ok(await ben("DELETE", `/api/v1/boards/${board.id}/columns/extra?expectedVersion=5`), "delete column");
    const records = (await ben("POST", `/api/v1/boards/${board.id}/records/batch`, { records: [{ values: { serial: "R1" } }, { values: { serial: "R2" } }, { values: { serial: "R3" } }] })).body.items;
    assert.equal(records.length, 3);
    // Cara edits and deletes rows Ben created.
    const cara = (m, p, b) => as(people.cara, m, p, b);
    ok(await cara("PATCH", `/api/v1/records/${records[0].id}`, { expectedVersion: 1, values: { serial: "R1 edited" } }), "edit record");
    ok(await cara("PATCH", `/api/v1/boards/${board.id}/records`, { items: [{ id: records[1].id, expectedVersion: 1, values: { serial: "R2 edited" } }] }), "batch update");
    ok(await cara("DELETE", `/api/v1/records/${records[2].id}?expectedVersion=1`), "delete record");
    const rows = (await as(people.ana, "GET", `/api/v1/boards/${board.id}/records`)).body.items.map((r) => r.values.serial).sort();
    assert.deepEqual(rows, ["R1 edited", "R2 edited"], "Ana sees the others' changes");
    // Move the board to another employee's workspace, archive it, delete it; then rename and delete the workspace.
    const other = (await cara("POST", "/api/v1/workspaces", { name: "Cara's workspace" })).body.workspace;
    ok(await ben("POST", `/api/v1/boards/${board.id}/move`, { workspaceId: other.id, expectedVersion: 6 }), "move board");
    ok(await cara("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: 7, archived: true }), "archive board");
    ok(await cara("DELETE", `/api/v1/boards/${board.id}?expectedVersion=8`), "delete board");
    ok(await ben("PATCH", `/api/v1/workspaces/${ws.id}`, { expectedVersion: ws.version, name: "Renamed by Ben" }), "update workspace");
    ok(await ben("DELETE", `/api/v1/workspaces/${ws.id}?expectedVersion=${ws.version + 1}`), "delete someone else's workspace");
    assert.equal((await as(people.ana, "GET", `/api/v1/workspaces/${ws.id}`)).status, 404, "gone for everyone");
    const benId = (await as(people.ben, "GET", "/api/v1/me")).body.user.id;
    const deleted = await app.db.collection("activities").findOne({ action: "workspace.deleted", entityId: new ObjectId(ws.id) });
    assert.equal(deleted.actorUserId.toHexString(), benId, "activity records the real employee");
  });

  test("unchanged: imports stay JARC.Admin only; membership changes need a real admin membership", async () => {
    const importBody = { schemaVersion: 1, workspaces: [{ id: "x", name: "X", boards: [] }] };
    assert.equal((await as(people.ben, "POST", "/api/v1/imports?dryRun=true", importBody)).status, 403);
    assert.equal((await as(people.admin, "POST", "/api/v1/imports?dryRun=true", importBody)).status, 200);

    const ws = (await as(people.ana, "POST", "/api/v1/workspaces", { name: "Members stay real" })).body.workspace;
    const benId = (await as(people.ben, "GET", "/api/v1/me")).body.user.id;
    const caraId = (await as(people.cara, "GET", "/api/v1/me")).body.user.id;
    assert.equal((await as(people.ben, "GET", `/api/v1/workspaces/${ws.id}/members`)).status, 200, "anyone can see the members");
    const selfGrant = await as(people.ben, "POST", `/api/v1/workspaces/${ws.id}/members`, { userId: benId, role: "WORKSPACE_ADMIN" });
    assert.deepEqual([selfGrant.status, selfGrant.body.error.code], [403, "FORBIDDEN"], "no self-granted membership that would outlive the policy");
    const benUser = await app.db.collection("users").findOne({ entraObjectId: people.ben.oid });
    assert.equal(await app.db.collection("workspaceMembers").countDocuments({ userId: benUser._id }), 0, "Ben holds no memberships at all");
    // The creator holds a real WORKSPACE_ADMIN membership, so they can manage members.
    const added = await as(people.ana, "POST", `/api/v1/workspaces/${ws.id}/members`, { userId: caraId, role: "MEMBER" });
    assert.equal(added.status, 201, added.text);
    assert.equal((await as(people.ben, "PATCH", `/api/v1/workspaces/${ws.id}/members/${added.body.member.id}`, { role: "WORKSPACE_ADMIN" })).status, 403);
    assert.equal((await as(people.ben, "DELETE", `/api/v1/workspaces/${ws.id}/members/${added.body.member.id}`)).status, 403);
  });

  test("still enforced: no session → 401; CSRF; a disabled employee is locked out", async () => {
    for (const [method, path] of [["GET", "/api/v1/workspaces"], ["POST", "/api/v1/workspaces"], ["GET", "/api/v1/me"]]) {
      assert.equal((await new SessionClient(app.url, app.entra.appOrigin).request(method, path, method === "POST" ? { name: "x" } : undefined)).status, 401, `${method} ${path}`);
    }
    const c = await browser(people.cara);
    const noCsrf = await c.request("POST", "/api/v1/workspaces", { name: "No CSRF" }, { csrf: null });
    assert.deepEqual([noCsrf.status, noCsrf.body.error.code], [403, "CSRF_INVALID"]);
    const foreign = await c.request("POST", "/api/v1/workspaces", { name: "Foreign" }, { origin: "https://evil.example.invalid" });
    assert.equal(foreign.status, 403);

    const leaver = issuer.person("Disabled Employee");
    const lc = new SessionClient(app.url, app.entra.appOrigin);
    ok(await lc.signIn(leaver), "sign-in");
    await app.db.collection("users").updateOne({ entraObjectId: leaver.oid }, { $set: { status: "disabled" } });
    assert.equal((await lc.request("GET", "/api/v1/workspaces")).status, 403);
    assert.equal((await new SessionClient(app.url, app.entra.appOrigin).signIn(leaver)).status, 403);
  });

  test("TENANT ISOLATION: a token from another tenant (or for another app) never gets a session, so it sees nothing", async () => {
    const other = "99999999-9999-9999-9999-999999999999";
    const stranger = issuer.person("Other Tenant");
    for (const claims of [{ tid: other, iss: `https://login.microsoftonline.com/${other}/v2.0` }, { tid: other }, { aud: "33333333-3333-3333-3333-333333333333" }]) {
      const c = new SessionClient(app.url, app.entra.appOrigin);
      const res = await c.signIn(stranger, { claims });
      assert.equal(res.status, 401, JSON.stringify(claims));
      assert.equal((await c.request("GET", "/api/v1/workspaces")).status, 401);
      assert.equal((await c.request("POST", "/api/v1/workspaces", { name: "Intruder" })).status, 401);
    }
    assert.equal(await app.db.collection("users").countDocuments({ entraObjectId: stranger.oid }), 0, "no user is created");
    assert.equal(await app.db.collection("workspaces").countDocuments({ name: "Intruder" }), 0);
  });
});

describe("role_based (default) keeps the restrictive rules", () => {
  let app, issuer;
  before(async () => { issuer = await createTokenIssuer(); app = await startEntraApp({ issuer }); });
  after(async () => { await app.close(); });

  test("without JARC.Admin: no workspace creation, other people's workspaces are invisible (404)", async () => {
    const admin = new SessionClient(app.url, app.entra.appOrigin), emp = new SessionClient(app.url, app.entra.appOrigin);
    ok(await admin.signIn(issuer.person("Real Admin", { admin: true })), "admin");
    const signIn = await emp.signIn(issuer.person("Plain Employee"));
    assert.deepEqual([signIn.body.accessPolicy, signIn.body.canCreateWorkspaces], ["role_based", false]);
    const ws = (await admin.request("POST", "/api/v1/workspaces", { name: "Admins only" })).body.workspace;
    const board = (await admin.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "B", columns })).body.board;
    assert.equal((await emp.request("POST", "/api/v1/workspaces", { name: "Nope" })).status, 403);
    assert.deepEqual((await emp.request("GET", "/api/v1/workspaces")).body.items, []);
    assert.equal((await emp.request("GET", `/api/v1/workspaces/${ws.id}`)).status, 404);
    assert.equal((await emp.request("GET", `/api/v1/boards/${board.id}`)).status, 404);
    assert.equal((await emp.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "X" } })).status, 404);
    assert.equal((await emp.request("DELETE", `/api/v1/workspaces/${ws.id}?expectedVersion=${ws.version}`)).status, 404);
  });
});
