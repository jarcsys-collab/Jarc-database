// API keys across several workspaces: one read-only token for boards chosen from different workspaces. The real app with Entra
// sign-in on the fake MongoDB, with synthetic data only. What is checked:
//   - the server works out each board's workspace from the database (never from the request) and checks the issuer's access in
//     every one of them; made-up, unreachable and repeated board IDs refuse the whole request and store nothing;
//   - the token reads exactly the chosen boards, in every chosen workspace, and nothing else, re-checked on every request;
//   - tokens stored before this change (one workspaceId) keep working exactly as before, and a token issued for one workspace is
//     stored in that same shape;
//   - list, rotate, revoke and API Activity describe every workspace, and never return a secret or a digest.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { generateToken } = require("../src/auth/api-token");
const { COLLECTIONS } = require("../src/db/bootstrap");
const { addUtcYears } = require("../src/services/api-token-service");
const { FakeMongoClient } = require("./support/fake-mongo");

const KEY = crypto.randomBytes(32);
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "amount", label: "Amount", type: "number" }];
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

let app, issuer, people;
const clients = new Map();
async function browserOf(person, target = app) {
  const key = `${target.url}:${person.name}`;
  if (!clients.has(key)) { const c = new SessionClient(target.url, target.entra.appOrigin); assert.equal((await c.signIn(person)).status, 201); clients.set(key, c); }
  return clients.get(key);
}
const as = async (person, method, url, body, target = app) => (await browserOf(person, target)).request(method, url, body);
const userId = async (person, target = app) => (await as(person, "GET", "/api/v1/me", undefined, target)).body.user.id;
async function call(token, url, { target = app } = {}) {
  const res = await fetch(`${target.url}/api/v1/external${url}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const code = (res) => res.body?.error?.code;
function grantApiAdmin(target, ...persons) {
  const service = target.dataLayer.services.apiTokens;
  service.adminObjectIds = Object.freeze([...new Set([...(service.adminObjectIds || []), ...persons.map((p) => p.oid.toLowerCase())])]);
}
// A workspace with the admin as a real member, and boards with one synthetic record each.
async function workspace(name, boardNames, target = app) {
  const ws = (await as(people.sysadmin, "POST", "/api/v1/workspaces", { name }, target)).body.workspace;
  assert.equal((await as(people.sysadmin, "POST", `/api/v1/workspaces/${ws.id}/members`, { userId: await userId(people.admin, target), role: "VIEWER" }, target)).status, 201);
  const boards = [];
  for (const boardName of boardNames) {
    const board = (await as(people.sysadmin, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: boardName, columns: COLUMNS }, target)).body.board;
    const record = (await as(people.sysadmin, "POST", `/api/v1/boards/${board.id}/records`, { values: { serial: `${boardName} 1`, amount: 1 } }, target)).body.record;
    boards.push({ ...board, record });
  }
  return { ws, boards };
}
const create = (person, body, target = app) => as(person, "POST", "/api/v1/me/api-tokens", { name: "Power BI Company Reports", scopes: ["read"], expiresAt: inDays(30), ...body }, target);
const stored = (id) => app.db.collection(COLLECTIONS.apiTokens).findOne({ _id: new ObjectId(id) });
const tokenCount = () => app.db.collection(COLLECTIONS.apiTokens).countDocuments({});

let core, sales, mid;
before(async () => {
  issuer = await createTokenIssuer();
  app = await startEntraApp({ issuer, apiTokens: { key: KEY, issuePerHour: 1000, maxActive: 1000 } });
  people = { sysadmin: issuer.person("Sys Admin", { admin: true }), admin: issuer.person("Wanda Admin"), second: issuer.person("Sam Second"), employee: issuer.person("Erin Employee") };
  grantApiAdmin(app, people.sysadmin, people.admin, people.second);
  for (const p of Object.values(people)) await browserOf(p);
  core = await workspace("Core Example", ["Products", "Customers", "Terms"]);
  sales = await workspace("Sales Example", ["Chemistry", "Urine", "Haematology"]);
  mid = await workspace("Installations Example", ["Site A", "Site B"]);
  // The second administrator is a member everywhere too, so they can revoke and see every token.
  for (const w of [core, sales, mid]) assert.equal((await as(people.sysadmin, "POST", `/api/v1/workspaces/${w.ws.id}/members`, { userId: await userId(people.second), role: "VIEWER" })).status, 201);
});
after(async () => { await app.close(); });

describe("Creating a key for boards in several workspaces", () => {
  test("one key covers the chosen boards of three workspaces, and nothing else", async () => {
    const chosen = [core.boards[0], core.boards[1], core.boards[2], sales.boards[0], sales.boards[1], mid.boards[0]];
    const res = await create(people.admin, { description: "Company dashboards", boardIds: chosen.map((b) => b.id) });
    assert.equal(res.status, 201, res.text);
    const { token, secret } = res.body;
    assert.match(secret, /^jarc_[0-9a-f]{24}_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(token.workspaces.map((w) => [w.name, w.boardCount]), [["Core Example", 3], ["Sales Example", 2], ["Installations Example", 1]]);
    assert.deepEqual(token.boards.map((b) => b.id), chosen.map((b) => b.id));
    assert.ok(token.boards.every((b) => b.available && b.name && b.workspaceId));
    assert.equal(token.description, "Company dashboards");
    assert.deepEqual(token.scopes, ["read"]);
    assert.equal(token.digest, undefined); assert.equal(token.secret, undefined);
    // Stored: the boards, every workspace (from the database), the first as workspaceId; never the secret.
    const doc = await stored(token.id);
    assert.equal(doc.scopeVersion, 2);
    assert.deepEqual(doc.workspaceIds.map(String), [core.ws.id, sales.ws.id, mid.ws.id]);
    assert.equal(String(doc.workspaceId), core.ws.id, "an older deployment would reach only the first workspace: less, never more");
    // The 43-character secret part (it may itself contain "_"), taken by the token format, never split on "_".
    const secretPart = /^jarc_[0-9a-f]{24}_([A-Za-z0-9_-]{43})$/.exec(secret)[1];
    assert.ok(!JSON.stringify(doc).includes(secretPart) && !JSON.stringify(doc).includes(secret), "no secret stored");
    // Every chosen board is readable with the one key: the board, its records, and a record by ID.
    for (const b of chosen) {
      assert.equal((await call(secret, `/boards/${b.id}`)).status, 200, b.name);
      assert.deepEqual((await call(secret, `/boards/${b.id}/records`)).body.items.map((r) => r.values.serial), [`${b.name} 1`]);
      assert.equal((await call(secret, `/records/${b.record.id}`)).status, 200);
    }
    // The boards that weren't chosen, in the same workspaces, answer like they don't exist.
    for (const b of [sales.boards[2], mid.boards[1]]) {
      for (const url of [`/boards/${b.id}`, `/boards/${b.id}/records`, `/boards/${b.id}/columns`, `/records/${b.record.id}`]) assert.equal((await call(secret, url)).status, 404, url);
    }
    // Workspaces: the three, each listing only its chosen boards.
    assert.deepEqual((await call(secret, "/workspaces")).body.items.map((w) => w.id), [core.ws.id, sales.ws.id, mid.ws.id]);
    assert.deepEqual((await call(secret, `/workspaces/${sales.ws.id}/boards`)).body.items.map((b) => b.name), ["Chemistry", "Urine"]);
    assert.deepEqual((await call(secret, `/workspaces/${mid.ws.id}/boards`)).body.items.map((b) => b.name), ["Site A"]);
    const me = (await call(secret, "/me")).body.token;
    assert.deepEqual([me.workspaceId, me.workspaceIds, me.boardIds], [core.ws.id, [core.ws.id, sales.ws.id, mid.ws.id], chosen.map((b) => b.id)]);
    // A board created afterwards, even in a chosen workspace, is never added.
    const later = (await as(people.sysadmin, "POST", `/api/v1/workspaces/${sales.ws.id}/boards`, { name: "Later", columns: COLUMNS })).body.board;
    assert.equal((await call(secret, `/boards/${later.id}`)).status, 404);
    // Audit: created, naming every workspace.
    const created = (await as(people.admin, "GET", "/api/v1/me/api-tokens/activity")).body.items.find((e) => e.action === "token.created" && e.token?.id === token.id);
    assert.deepEqual(created.workspaces.map((w) => w.name), ["Core Example", "Sales Example", "Installations Example"]);
    assert.deepEqual(created.token.boardIds, chosen.map((b) => b.id));
  });

  test("several boards of one workspace, chosen without naming it, are stored exactly as before (one workspaceId)", async () => {
    const res = await create(people.admin, { boardIds: [sales.boards[0].id, sales.boards[2].id] });
    assert.equal(res.status, 201, res.text);
    const doc = await stored(res.body.token.id);
    assert.equal(String(doc.workspaceId), sales.ws.id);
    assert.equal(doc.workspaceIds, undefined); assert.equal(doc.scopeVersion, undefined); assert.equal(doc.description, undefined);
    assert.deepEqual(res.body.token.workspaces.map((w) => w.id), [sales.ws.id]);
    assert.equal((await call(res.body.secret, `/boards/${sales.boards[2].id}/records`)).status, 200);
    assert.equal((await call(res.body.secret, `/boards/${sales.boards[1].id}`)).status, 404);
  });

  test("the original request shape (with workspaceId) still works, and still keeps every board in that workspace", async () => {
    const ok = await create(people.admin, { workspaceId: core.ws.id, boardIds: [core.boards[0].id] });
    assert.equal(ok.status, 201, ok.text);
    const mixed = await create(people.admin, { workspaceId: core.ws.id, boardIds: [core.boards[0].id, sales.boards[0].id] });
    assert.equal(mixed.status, 400);
    assert.match(mixed.body.error.message, /isn't a board of this workspace/);
  });

  test("made-up, unreachable, repeated and malformed board IDs refuse the whole request, and nothing is stored", async () => {
    const before_ = await tokenCount();
    const refused = async (boardIds, pattern, person = people.admin) => { const res = await create(person, { boardIds }); assert.equal(res.status, 400, res.text); assert.match(res.body.error.message, pattern); };
    await refused([core.boards[0].id, new ObjectId().toHexString()], /doesn't exist or you can't create tokens for it/);
    await refused([core.boards[0].id, core.boards[0].id], /more than once/);
    await refused([core.boards[0].id, core.boards[0].id.toUpperCase()], /more than once/, people.admin);
    await refused([core.boards[0].id, "not-an-id"], /boardIds/);
    await refused([], /boardIds/);
    await refused(Array.from({ length: 101 }, () => new ObjectId().toHexString()), /1 to 100/);
    // A workspace this administrator isn't a member of (memberships decide here): the same answer as a board that doesn't exist.
    const hidden = (await as(people.sysadmin, "POST", "/api/v1/workspaces", { name: "Private Example" })).body.workspace;
    const hiddenBoard = (await as(people.sysadmin, "POST", `/api/v1/workspaces/${hidden.id}/boards`, { name: "Private", columns: COLUMNS })).body.board;
    await refused([core.boards[0].id, hiddenBoard.id], /doesn't exist or you can't create tokens for it/);
    // Fields that aren't part of a key, scopes other than read, and expiry beyond five calendar years.
    assert.equal((await create(people.admin, { boardIds: [core.boards[0].id], workspaceIds: [hidden.id] })).status, 400);
    assert.equal((await create(people.admin, { boardIds: [core.boards[0].id], scopes: ["read", "write"] })).status, 400);
    assert.equal((await create(people.admin, { boardIds: [core.boards[0].id], description: "x".repeat(501) })).status, 400);
    assert.equal((await create(people.admin, { boardIds: [core.boards[0].id, sales.boards[0].id], expiresAt: new Date(addUtcYears(new Date(), 5).getTime() + 86400000).toISOString() })).status, 400);
    assert.equal(await tokenCount(), before_, "nothing stored");
    // Five calendar years, less a minute for the request, is accepted for a key across workspaces too.
    const latest = await create(people.admin, { boardIds: [core.boards[0].id, sales.boards[0].id], expiresAt: new Date(addUtcYears(new Date(), 5).getTime() - 60000).toISOString() });
    assert.equal(latest.status, 201, latest.text);
  });

  test("only the JARC API administrators may create, list or see the options; every employee keeps reading the boards", async () => {
    const before_ = await tokenCount();
    assert.equal(code(await create(people.employee, { boardIds: [core.boards[0].id, sales.boards[0].id] })), "API_ADMIN_REQUIRED");
    assert.equal(code(await as(people.employee, "GET", "/api/v1/me/api-tokens")), "API_ADMIN_REQUIRED");
    assert.equal(code(await as(people.employee, "GET", "/api/v1/me/api-tokens/options")), "API_ADMIN_REQUIRED");
    assert.equal(code(await as(people.employee, "GET", "/api/v1/me/api-tokens/activity")), "API_ADMIN_REQUIRED");
    assert.equal(await tokenCount(), before_);
  });

  test("the options list every board of every workspace without each board's configuration, and the limits", async () => {
    const res = await as(people.admin, "GET", "/api/v1/me/api-tokens/options");
    assert.equal(res.status, 200);
    const names = res.body.workspaces.map((w) => w.name);
    for (const n of ["Core Example", "Sales Example", "Installations Example"]) assert.ok(names.includes(n), n);
    const s = res.body.workspaces.find((w) => w.id === sales.ws.id);
    assert.ok(s.boards.every((b) => Object.keys(b).sort().join() === "archived,id,name"), "only ID, name and archived");
    assert.deepEqual(res.body.limits, { boardsPerToken: 100, maxLifetimeYears: 5 });
  });
});

describe("Tokens stored before multi-workspace scopes", () => {
  test("an existing single-workspace token keeps working unchanged, and is listed with its one workspace", async () => {
    // Inserted exactly as the previous release stored it: no workspaceIds, no scopeVersion, no description.
    const ownerUserId = new ObjectId(await userId(people.admin));
    const { publicId, token, digest } = generateToken(KEY);
    const now = new Date();
    const legacy = { _id: new ObjectId(), publicId, digest, name: "Legacy integration", ownerUserId, workspaceId: new ObjectId(core.ws.id), boardIds: [new ObjectId(core.boards[1].id)], scopes: ["read"], createdAt: now, expiresAt: new Date(now.getTime() + 86400000), revokedAt: null, lastUsedAt: null, requestCount: 0, rotatedFromId: null, rotatedToId: null };
    await app.db.collection(COLLECTIONS.apiTokens).insertOne(legacy);
    assert.equal((await call(token, `/boards/${core.boards[1].id}/records`)).status, 200);
    assert.equal((await call(token, `/boards/${core.boards[0].id}`)).status, 404);
    assert.equal((await call(token, `/boards/${sales.boards[0].id}`)).status, 404);
    assert.deepEqual((await call(token, "/workspaces")).body.items.map((w) => w.id), [core.ws.id]);
    assert.deepEqual((await call(token, "/me")).body.token.workspaceIds, [core.ws.id]);
    const listed = (await as(people.admin, "GET", "/api/v1/me/api-tokens")).body.items.find((t) => t.id === String(legacy._id));
    assert.equal(listed.status, "active");
    assert.deepEqual(listed.workspaces.map((w) => [w.name, w.boardCount]), [["Core Example", 1]]);
    assert.equal(listed.workspace.name, "Core Example");
    assert.equal(listed.description, "");
    // The document wasn't rewritten by being used or listed (only its usage metadata may change).
    const after_ = await app.db.collection(COLLECTIONS.apiTokens).findOne({ _id: legacy._id });
    for (const k of ["publicId", "digest", "name", "workspaceId", "boardIds", "scopes", "expiresAt"]) assert.deepEqual(after_[k], legacy[k], k);
    assert.equal(after_.workspaceIds, undefined);
  });
});

describe("Access changes and the token's lifecycle", () => {
  test("losing one workspace stops only that workspace's boards; losing all of them stops the token", async () => {
    const a = await workspace("Access A", ["A1"]), b = await workspace("Access B", ["B1"]);
    const res = await create(people.admin, { boardIds: [a.boards[0].id, b.boards[0].id] });
    assert.equal(res.status, 201, res.text);
    const secret = res.body.secret;
    const leave = async (w) => app.db.collection(COLLECTIONS.workspaceMembers).deleteOne({ workspaceId: new ObjectId(w.ws.id), userId: new ObjectId(await userId(people.admin)) });
    await leave(a);
    assert.equal((await call(secret, `/boards/${a.boards[0].id}`)).status, 404, "the workspace the owner lost");
    assert.equal((await call(secret, `/records/${a.boards[0].record.id}`)).status, 404);
    assert.equal((await call(secret, `/workspaces/${a.ws.id}/boards`)).status, 404);
    assert.equal((await call(secret, `/boards/${b.boards[0].id}`)).status, 200, "the workspace they still have");
    assert.deepEqual((await call(secret, "/workspaces")).body.items.map((w) => w.id), [b.ws.id]);
    const listed = (await as(people.admin, "GET", "/api/v1/me/api-tokens")).body.items.find((t) => t.id === res.body.token.id);
    assert.equal(listed.status, "active");
    assert.deepEqual(listed.workspaces.map((w) => w.available), [false, true]);
    assert.equal(listed.boards.find((x) => x.id === a.boards[0].id).name, null, "no names from a workspace the owner can't read");
    assert.equal(listed.canRotate, false, "rotating needs every workspace");
    await leave(b);
    assert.equal(code(await call(secret, "/workspaces")), "TOKEN_ACCESS_REVOKED");
  });

  test("a board moved out of the token's workspaces stops being reachable", async () => {
    const a = await workspace("Move A", ["M1"]), b = await workspace("Move B", ["M2"]), elsewhere = await workspace("Move elsewhere", []);
    const res = await create(people.admin, { boardIds: [a.boards[0].id, b.boards[0].id] });
    const secret = res.body.secret, moved = a.boards[0];
    await app.db.collection(COLLECTIONS.boards).updateOne({ _id: new ObjectId(moved.id) }, { $set: { workspaceId: new ObjectId(elsewhere.ws.id) } });
    await app.db.collection(COLLECTIONS.records).updateMany({ boardId: new ObjectId(moved.id) }, { $set: { workspaceId: new ObjectId(elsewhere.ws.id) } });
    assert.equal((await call(secret, `/boards/${moved.id}`)).status, 404);
    assert.equal((await call(secret, `/records/${moved.record.id}`)).status, 404);
    assert.equal((await call(secret, `/boards/${b.boards[0].id}`)).status, 200);
  });

  test("rotating keeps every workspace and board; another administrator can revoke it; both are audited", async () => {
    const res = await create(people.second, { description: "Rotate me", boardIds: [core.boards[2].id, mid.boards[1].id] });
    assert.equal(res.status, 201, res.text);
    const rotated = await as(people.second, "POST", `/api/v1/me/api-tokens/${res.body.token.id}/rotate`, { graceHours: 0 });
    assert.equal(rotated.status, 201, rotated.text);
    assert.deepEqual(rotated.body.token.boards.map((b) => b.id), [core.boards[2].id, mid.boards[1].id]);
    assert.deepEqual(rotated.body.token.workspaces.map((w) => w.id), [core.ws.id, mid.ws.id]);
    assert.equal(rotated.body.token.description, "Rotate me");
    assert.equal(code(await call(res.body.secret, `/boards/${core.boards[2].id}`)), "TOKEN_REVOKED", "grace 0 ends the old one");
    const secret = rotated.body.secret;
    assert.equal((await call(secret, `/boards/${mid.boards[1].id}/records`)).status, 200);
    // Wanda (another administrator) can't rotate Sam's token, but may revoke it.
    assert.equal((await as(people.admin, "POST", `/api/v1/me/api-tokens/${rotated.body.token.id}/rotate`, {})).status, 404);
    const revoked = await as(people.admin, "POST", `/api/v1/me/api-tokens/${rotated.body.token.id}/revoke`, {});
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.token.revokedBy.name, "Wanda Admin");
    assert.equal(code(await call(secret, `/boards/${mid.boards[1].id}`)), "TOKEN_REVOKED");
    const events = (await as(people.second, "GET", "/api/v1/me/api-tokens/activity")).body.items.filter((e) => [res.body.token.id, rotated.body.token.id].includes(e.token?.id));
    assert.ok(events.some((e) => e.action === "token.rotated" && e.workspaces.length === 2));
    assert.ok(events.some((e) => e.action === "token.revoked" && e.actor.name === "Wanda Admin" && e.owner.name === "Sam Second" && e.workspaces.length === 2));
    assert.doesNotMatch(JSON.stringify(events), /jarc_[0-9a-f]{24}_|digest/);
  });

  test("the list never returns a secret or a digest, for any token", async () => {
    const list = await as(people.admin, "GET", "/api/v1/me/api-tokens");
    assert.equal(list.status, 200);
    assert.doesNotMatch(JSON.stringify(list.body), /jarc_[0-9a-f]{24}_|"digest"|"secret"/);
  });
});

describe("Isolation of this test", () => {
  test("it ran on the in-memory fake database, never a real one", () => {
    assert.ok(app.fake instanceof FakeMongoClient);
    assert.equal(app.connection.uri, "mongodb://fake.invalid");
  });
});
