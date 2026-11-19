// Shared board access for every employee, API administration for the JARC API administrators only (JARC_API_ADMIN_OIDS), and
// API token lifetimes of up to 5 calendar years. The real app with Entra sign-in on the fake MongoDB, configured as in production
// (ACCESS_POLICY=development_shared with JARC_BETA_OPEN_EDITING), with synthetic people and data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { loadConfig } = require("../src/config");
const { COLLECTIONS } = require("../src/db/bootstrap");
const { ApiTokenService, addUtcYears, latestExpiry, LIMITS } = require("../src/services/api-token-service");

const KEY = crypto.randomBytes(32);
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "amount", label: "Amount", type: "number" }];
const DAY = 86400000;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString();

let app, issuer, admins, employees;
const clients = new Map();
async function browserOf(person) {
  if (!clients.has(person.oid)) { const c = new SessionClient(app.url, app.entra.appOrigin); assert.equal((await c.signIn(person)).status, 201); clients.set(person.oid, c); }
  return clients.get(person.oid);
}
const as = async (person, method, url, body) => (await browserOf(person)).request(method, url, body);
const code = (res) => res.body?.error?.code;
async function call(token, url) {
  const res = await fetch(`${app.url}/api/v1/external${url}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const issue = (person, { workspaceId, boardIds, expiresAt = inDays(30), name = "Integration" }) => as(person, "POST", "/api/v1/me/api-tokens", { name, workspaceId, boardIds, scopes: ["read"], expiresAt });
const stored = (id) => app.db.collection(COLLECTIONS.apiTokens).findOne({ _id: new ObjectId(id) });

// The shared workspaces, made by ordinary employees: a "sales" workspace with 17 boards (uploaded by two different people) and a
// "core" workspace with 4.
let sales, core;

before(async () => {
  issuer = await createTokenIssuer();
  // Five administrators, named after their roles only. Their object IDs reach the app through the real configuration parser, exactly
  // as JARC_API_ADMIN_OIDS does in production (mixed case and spacing included).
  admins = ["One", "Two", "Three", "Four", "Five"].map((n) => issuer.person(`Admin ${n}`));
  employees = { a: issuer.person("Employee Alpha"), b: issuer.person("Employee Beta"), c: issuer.person("Employee Gamma"), appRole: issuer.person("Entra Role Holder", { admin: true }) };
  const config = loadConfig({ JARC_API_ADMIN_OIDS: admins.map((p, i) => (i % 2 ? p.oid.toUpperCase() : ` ${p.oid}`)).join(", ") });
  assert.equal(config.apiTokens.adminObjectIds.length, 5);
  app = await startEntraApp({ issuer, accessPolicy: "development_shared", betaOpenEditing: true, apiTokens: { key: KEY, issuePerHour: 1000, maxActive: 1000, adminObjectIds: config.apiTokens.adminObjectIds } });
  const makeWorkspace = async (owner, name) => (await as(owner, "POST", "/api/v1/workspaces", { name })).body.workspace;
  const makeBoard = async (owner, ws, name) => { const board = (await as(owner, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name, columns: COLUMNS })).body.board; assert.ok(board, name); return board; };
  const s = await makeWorkspace(employees.a, "Sales Space");
  const salesBoards = [];
  for (let i = 1; i <= 17; i++) salesBoards.push(await makeBoard(i % 2 ? employees.a : employees.c, s, `Sales board ${i}`));
  const c = await makeWorkspace(employees.c, "Core Space");
  const coreBoards = [];
  for (let i = 1; i <= 4; i++) coreBoards.push(await makeBoard(employees.c, c, `Core board ${i}`));
  assert.equal((await as(employees.a, "POST", `/api/v1/boards/${salesBoards[0].id}/records`, { values: { serial: "S-1", amount: 5 } })).status, 201);
  sales = { ws: s, boards: salesBoards };
  core = { ws: c, boards: coreBoards };
});
after(async () => { await app?.close(); });

describe("Every employee sees and opens every shared board", () => {
  test("employee B sees A's workspace and board, opens it and reads its records; a new board appears at once", async () => {
    const b = employees.b;
    const spaces = (await as(b, "GET", "/api/v1/workspaces")).body.items.map((w) => w.name);
    assert.ok(spaces.includes("Sales Space") && spaces.includes("Core Space"), "both shared workspaces");
    const listed = (await as(b, "GET", `/api/v1/workspaces/${sales.ws.id}/boards`)).body.items;
    assert.equal(listed.length, 17, "every board, whoever uploaded it");
    assert.equal((await as(b, "GET", `/api/v1/boards/${sales.boards[0].id}`)).status, 200);
    const records = (await as(b, "GET", `/api/v1/boards/${sales.boards[0].id}/records`)).body.items;
    assert.deepEqual(records.map((r) => r.values.serial), ["S-1"]);
    // A board another employee creates now is listed on B's next read, with no membership or redeployment.
    const later = (await as(employees.a, "POST", `/api/v1/workspaces/${core.ws.id}/boards`, { name: "Uploaded later", columns: COLUMNS })).body.board;
    assert.ok((await as(b, "GET", `/api/v1/workspaces/${core.ws.id}/boards`)).body.items.some((x) => x.id === later.id));
    assert.equal((await as(b, "GET", `/api/v1/boards/${later.id}`)).status, 200);
    // Search finds it too.
    const found = await as(b, "GET", `/api/v1/search?q=${encodeURIComponent("Uploaded later")}`);
    assert.equal(found.status, 200, found.text);
    // The extra board is removed again (by its creator, as a user would) so the counts below stay as set up.
    const removed = await as(employees.a, "DELETE", `/api/v1/boards/${later.id}?expectedVersion=${later.version}`);
    assert.equal(removed.status, 200, removed.text);
  });

  test("API administrators see the same boards; ordinary employees keep board access but get no API administration", async () => {
    for (const p of [...admins, employees.a, employees.b, employees.appRole]) {
      assert.equal((await as(p, "GET", `/api/v1/workspaces/${sales.ws.id}/boards`)).body.items.length, 17, p.name);
    }
    for (const p of [employees.a, employees.b, employees.c, employees.appRole]) {
      assert.equal((await as(p, "GET", "/api/v1/features")).body.features.apiTokenAdmin, false, p.name);
      for (const [method, url, body] of [["GET", "/me/api-tokens"], ["GET", "/me/api-tokens/options"], ["GET", "/me/api-tokens/activity"], ["POST", "/me/api-tokens", { name: "x", workspaceId: sales.ws.id, boardIds: [sales.boards[0].id], scopes: ["read"], expiresAt: inDays(5 * 365) }], ["POST", `/me/api-tokens/${new ObjectId()}/revoke`, {}], ["POST", `/me/api-tokens/${new ObjectId()}/rotate`, {}], ["GET", `/me/api-explorer/boards/${sales.boards[0].id}`]]) {
        const res = await as(p, method, `/api/v1${url}`, body);
        assert.deepEqual([res.status, code(res)], [403, "API_ADMIN_REQUIRED"], `${p.name}: ${method} ${url}`);
      }
    }
    assert.equal((await app.db.collection(COLLECTIONS.apiTokens).countDocuments({})), 0, "nothing was created by a refused request");
  });
});

describe("The five API administrators", () => {
  test("each one is an administrator, sees every shared workspace with all its boards, and can issue a token for another employee's boards", async () => {
    for (const admin of admins) {
      assert.equal((await as(admin, "GET", "/api/v1/features")).body.features.apiTokenAdmin, true, admin.name);
      const options = (await as(admin, "GET", "/api/v1/me/api-tokens/options")).body.workspaces;
      const s = options.find((w) => w.id === sales.ws.id), c = options.find((w) => w.id === core.ws.id);
      assert.equal(s?.boards.length, 17, `${admin.name}: the sales workspace and its 17 boards`);
      assert.equal(c?.boards.length, 4, `${admin.name}: the core workspace's 4 boards`);
      const chosen = [sales.boards[0].id, sales.boards[1].id];
      const res = await issue(admin, { workspaceId: sales.ws.id, boardIds: chosen, name: `${admin.name} feed` });
      assert.equal(res.status, 201, res.text);
      assert.deepEqual(res.body.token.boards.map((b) => b.id), chosen);
      assert.equal((await call(res.body.secret, `/boards/${sales.boards[0].id}/records`)).status, 200);
      assert.equal((await call(res.body.secret, `/boards/${sales.boards[2].id}/records`)).status, 404, "only the boards chosen");
      assert.equal((await call(res.body.secret, `/boards/${core.boards[0].id}/records`)).status, 404, "never another workspace");
    }
  });

  test("forged or invalid workspace and board IDs are refused, and nothing is stored", async () => {
    const before = await app.db.collection(COLLECTIONS.apiTokens).countDocuments({});
    const [admin] = admins;
    assert.equal((await issue(admin, { workspaceId: sales.ws.id, boardIds: [core.boards[0].id] })).status, 400, "a board of another workspace");
    assert.equal((await issue(admin, { workspaceId: sales.ws.id, boardIds: [new ObjectId().toHexString()] })).status, 400, "a made-up board");
    assert.equal((await issue(admin, { workspaceId: sales.ws.id, boardIds: ["nope"] })).status, 400, "a malformed board ID");
    assert.equal((await issue(admin, { workspaceId: new ObjectId().toHexString(), boardIds: [sales.boards[0].id] })).status, 404, "a made-up workspace");
    assert.equal((await as(admin, "POST", "/api/v1/me/api-tokens", { name: "w", workspaceId: sales.ws.id, boardIds: [sales.boards[0].id], scopes: ["read", "write"], expiresAt: inDays(5) })).status, 400, "read-only only");
    assert.equal(await app.db.collection(COLLECTIONS.apiTokens).countDocuments({}), before);
  });

  test("any administrator lists every token and revokes one another administrator issued; it stops at once and the revoker is recorded", async () => {
    const [one, two, three] = admins;
    const { token, secret } = (await issue(one, { workspaceId: core.ws.id, boardIds: [core.boards[0].id], name: "Owned by one", expiresAt: inDays(5 * 365) })).body;
    assert.equal((await call(secret, `/boards/${core.boards[0].id}`)).status, 200);
    const seen = (await as(two, "GET", "/api/v1/me/api-tokens")).body;
    const row = seen.items.find((t) => t.id === token.id);
    assert.deepEqual([row.owner.name, row.mine, row.canRotate], ["Admin One", false, false]);
    assert.ok(!JSON.stringify(seen).includes(secret) && !JSON.stringify(seen).includes("digest"), "never a secret or a digest");
    // Rotating is only for the owner; revoking is for any administrator.
    assert.equal((await as(two, "POST", `/api/v1/me/api-tokens/${token.id}/rotate`, {})).status, 404);
    const revoked = await as(two, "POST", `/api/v1/me/api-tokens/${token.id}/revoke`, {});
    assert.deepEqual([revoked.status, revoked.body.token.status, revoked.body.token.revokedBy.name], [200, "revoked", "Admin Two"]);
    const next = await call(secret, `/boards/${core.boards[0].id}`);
    assert.deepEqual([next.status, code(next)], [401, "TOKEN_REVOKED"], "a five-year token stops on its very next request");
    const doc = await stored(token.id);
    assert.equal(doc.revokedByUserId.toHexString(), (await as(two, "GET", "/api/v1/me")).body.user.id);
    // API Activity: every administrator sees who created and who revoked it, with the token's safe label only.
    for (const admin of [one, two, three]) {
      const activity = await as(admin, "GET", "/api/v1/me/api-tokens/activity");
      assert.equal(activity.status, 200, activity.text);
      const all = activity.body.items.filter((e) => e.token?.id === token.id);
      // The refused request after revoking is recorded too, with its reason (no person: it came from an integration).
      assert.ok(all.some((e) => e.action === "token.use_refused" && e.reason === "revoked" && e.actor === null), admin.name);
      const entries = all.filter((e) => e.action !== "token.use_refused");
      assert.deepEqual(entries.map((e) => [e.action, e.actor?.name, e.owner?.name]), [["token.revoked", "Admin Two", "Admin One"], ["token.created", "Admin One", "Admin One"]], admin.name);
      assert.equal(entries[0].token.name, "Owned by one");
      assert.match(entries[0].token.prefix, /^jarc_[0-9a-f]{8}$/);
      assert.equal(entries[0].workspace.name, "Core Space");
      assert.ok(!activity.text.includes(secret) && !activity.text.includes(doc.digest), "no secret or digest in API Activity");
    }
    assert.ok(!app.logger.errors.join(" ").includes(secret), "never logged");
  });

  test("an existing token keeps its boards, scope and expiry: new boards are never added, and other administrators' actions change nothing", async () => {
    const [one, two] = admins;
    const { token, secret } = (await issue(one, { workspaceId: sales.ws.id, boardIds: [sales.boards[3].id], name: "Kept as issued", expiresAt: inDays(200) })).body;
    const before = await stored(token.id);
    const newBoard = (await as(employees.b, "POST", `/api/v1/workspaces/${sales.ws.id}/boards`, { name: "Imported after the token", columns: COLUMNS })).body.board;
    // Every administrator action on other tokens, and listing, leaves it exactly as it was.
    const other = (await issue(two, { workspaceId: sales.ws.id, boardIds: [newBoard.id], expiresAt: inDays(5 * 365) })).body;
    assert.equal((await as(two, "POST", `/api/v1/me/api-tokens/${other.token.id}/rotate`, { graceHours: 0 })).status, 201);
    await as(two, "GET", "/api/v1/me/api-tokens"); await as(one, "GET", "/api/v1/me/api-tokens/activity");
    assert.deepEqual(await stored(token.id), before, "boards, scope, expiry and status untouched");
    assert.equal((await call(secret, `/boards/${newBoard.id}`)).status, 404, "a board created later isn't added to an existing token");
    assert.equal((await call(secret, `/boards/${sales.boards[3].id}`)).status, 200);
    // Tidy the extra board away so other tests keep their counts.
    const removed = await as(employees.b, "DELETE", `/api/v1/boards/${newBoard.id}?expectedVersion=${newBoard.version}`);
    assert.equal(removed.status, 200, removed.text);
  });
});

describe("Token lifetimes of up to 5 calendar years", () => {
  const ok = async (expiresAt, label) => {
    const res = await issue(admins[0], { workspaceId: core.ws.id, boardIds: [core.boards[1].id], expiresAt, name: label });
    assert.equal(res.status, 201, `${label}: ${res.text}`);
    assert.equal((await stored(res.body.token.id)).expiresAt.toISOString(), new Date(expiresAt).toISOString(), `${label}: stored exactly as chosen, in UTC`);
    return res.body;
  };
  const refused = async (expiresAt, pattern, label) => {
    const res = await issue(admins[0], { workspaceId: core.ws.id, boardIds: [core.boards[1].id], expiresAt, name: label });
    assert.equal(res.status, 400, `${label}: ${res.text}`);
    assert.match(res.body.error.message, pattern, label);
  };

  test("30 days, 1 year, 3 years and the full 5 calendar years are accepted; a shorter choice stays shorter", async () => {
    const now = new Date();
    await ok(inDays(30), "30 days");
    await ok(addUtcYears(now, 1).toISOString(), "1 year");
    await ok(addUtcYears(now, 3).toISOString(), "3 years");
    // Five calendar years, less the moment it takes the request to arrive (the limit is measured from the server's own clock).
    const five = await ok(new Date(addUtcYears(now, 5).getTime() - 1000).toISOString(), "5 years");
    assert.ok(new Date(five.token.expiresAt) > addUtcYears(now, 5 - 1), "really about five years");
  });

  test("past, too-soon, invalid and beyond-5-year dates are refused; nothing never expires", async () => {
    await refused(inDays(-1), /future/, "yesterday");
    await refused(new Date(Date.now() + 10 * 1000).toISOString(), /future/, "ten seconds away");
    await refused("2031-02-30", /date and time/, "an impossible date");
    await refused("2031-02-30T10:00:00.000Z", /date and time/, "30 February, well formed (JavaScript alone would read 2 March)");
    await refused("2029-02-29T10:00:00.000Z", /date and time/, "29 February in a year that isn't a leap year");
    await refused("2031-13-01T10:00:00.000Z", /date and time/, "month 13");
    await refused("2030-06-01", /date and time/, "a date without a time and offset");
    await refused("2030-06-01T10:00:00", /date and time/, "a time without an offset (ambiguous)");
    await ok("2028-02-29T15:59:59.000Z", "29 February in a leap year is a real date");
    await refused("not a date", /date and time/, "text");
    await refused(new Date(addUtcYears(new Date(), 5).getTime() + 60 * 60 * 1000).toISOString(), /at most 5 years/, "5 years and an hour");
    await refused(inDays(6 * 365), /at most 5 years/, "six years");
    const res = await as(admins[0], "POST", "/api/v1/me/api-tokens", { name: "never", workspaceId: core.ws.id, boardIds: [core.boards[1].id], scopes: ["read"] });
    assert.equal(res.status, 400, "an expiry is required: there's no non-expiring token");
    assert.equal(LIMITS.maxLifetimeYears, 5);
  });

  test("calendar years in UTC, leap days included: the limit is exact to the millisecond", () => {
    const at = (s) => new Date(s);
    assert.equal(addUtcYears(at("2026-11-19T07:30:00.000Z"), 5).toISOString(), "2031-11-19T07:30:00.000Z");
    assert.equal(addUtcYears(at("2028-02-29T10:00:00.000Z"), 5).toISOString(), "2033-02-28T10:00:00.000Z", "29 February → 28 February, never 1 March");
    assert.equal(addUtcYears(at("2027-02-28T23:59:59.999Z"), 5).toISOString(), "2032-02-28T23:59:59.999Z", "into a leap year, the same date");
    assert.equal(addUtcYears(at("2027-03-01T00:00:00.000Z"), 5).toISOString(), "2032-03-01T00:00:00.000Z");
    assert.equal(addUtcYears(at("2026-12-31T23:59:59.999Z"), 5).toISOString(), "2031-12-31T23:59:59.999Z", "the year's last moment");
    // The service's own check, with a fixed creation time: the exact limit passes, one millisecond more is refused.
    const service = new ApiTokenService({ repos: {} });
    const created = at("2028-02-29T10:00:00.000Z");
    assert.equal(service.parseExpiry("2033-02-28T10:00:00.000Z", created).toISOString(), latestExpiry(created).toISOString());
    assert.throws(() => service.parseExpiry("2033-02-28T10:00:00.001Z", created), /at most 5 years/);
    assert.throws(() => service.parseExpiry("2033-03-01T00:00:00.000Z", created), /at most 5 years/);
    assert.equal(service.parseExpiry("2033-02-28T09:59:59.999Z", created).toISOString(), "2033-02-28T09:59:59.999Z");
    // Not UTC in the request: the instant is what counts. 2033-02-28T18:00+08:00 is 10:00 UTC.
    assert.equal(service.parseExpiry("2033-02-28T18:00:00+08:00", created).toISOString(), "2033-02-28T10:00:00.000Z");
    assert.throws(() => service.parseExpiry("2033-02-28T18:00:01+08:00", created), /at most 5 years/);
  });

  test("a five-year token is refused once expired, and when revoked, whatever its original expiry", async () => {
    const expiring = await ok(new Date(addUtcYears(new Date(), 5).getTime() - 5000).toISOString(), "expires later");
    assert.equal((await call(expiring.secret, "/me")).status, 200);
    await app.db.collection(COLLECTIONS.apiTokens).updateOne({ _id: new ObjectId(expiring.token.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await call(expiring.secret, "/me");
    assert.deepEqual([expired.status, code(expired)], [401, "TOKEN_EXPIRED"]);
    const revoking = await ok(new Date(addUtcYears(new Date(), 5).getTime() - 5000).toISOString(), "revoked at once");
    assert.equal((await call(revoking.secret, "/me")).status, 200);
    assert.equal((await as(admins[4], "POST", `/api/v1/me/api-tokens/${revoking.token.id}/revoke`, {})).status, 200);
    assert.equal(code(await call(revoking.secret, "/me")), "TOKEN_REVOKED");
  });

  test("rotating keeps the old lifetime but never more than 5 years from the rotation", async () => {
    const issued = await ok(new Date(addUtcYears(new Date(), 5).getTime() - 5000).toISOString(), "rotated");
    const rotated = await as(admins[0], "POST", `/api/v1/me/api-tokens/${issued.token.id}/rotate`, { graceHours: 0 });
    assert.equal(rotated.status, 201, rotated.text);
    assert.ok(new Date(rotated.body.token.expiresAt) <= addUtcYears(new Date(), 5));
    assert.ok(new Date(rotated.body.token.expiresAt) > addUtcYears(new Date(), 4));
    assert.equal(code(await call(issued.secret, "/me")), "TOKEN_REVOKED", "grace 0 ends the old one");
    // An employee can't make one of any length.
    assert.equal(code(await issue(employees.b, { workspaceId: core.ws.id, boardIds: [core.boards[1].id], expiresAt: inDays(4 * 365) })), "API_ADMIN_REQUIRED");
  });
});

describe("Fails closed", () => {
  test("with no administrators configured, nobody can manage tokens, existing tokens keep working, and boards stay shared", async () => {
    const service = app.dataLayer.services.apiTokens, saved = service.adminObjectIds;
    const { secret } = (await issue(admins[0], { workspaceId: core.ws.id, boardIds: [core.boards[2].id], name: "Before the list was emptied" })).body;
    try {
      service.adminObjectIds = Object.freeze([]);
      for (const p of [...admins, employees.a]) assert.equal(code(await as(p, "GET", "/api/v1/me/api-tokens")), "API_ADMIN_REQUIRED", p.name);
      assert.equal((await call(secret, `/boards/${core.boards[2].id}`)).status, 200, "an existing token keeps working");
      assert.equal((await as(employees.a, "GET", `/api/v1/workspaces/${core.ws.id}/boards`)).status, 200);
    } finally { service.adminObjectIds = saved; }
    // Another tenant's person with a listed object ID isn't an administrator: the tenant must match too.
    const other = new ApiTokenService({ repos: {} });
    other.tenantId = "tenant-a"; other.adminObjectIds = ["oid-1"];
    assert.equal(other.isAdmin({ kind: "entra", tenantId: "tenant-b", entraObjectId: "oid-1" }), false);
    assert.equal(other.isAdmin({ kind: "entra", tenantId: "TENANT-A", entraObjectId: "OID-1" }), true);
    assert.equal(other.isAdmin({ kind: "development", tenantId: "tenant-a", entraObjectId: "oid-1" }), false, "only a Microsoft sign-in");
    assert.equal(other.isAdmin(null), false);
  });
});
