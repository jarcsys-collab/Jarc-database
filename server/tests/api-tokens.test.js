// JARC API tokens: issuing and storing them, the read-only API they open, and every way they stop working. The real app with
// Entra sign-in on the fake MongoDB, with synthetic data only: it never connects to a real database.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const TOKEN_SECRET_PART = /^jarc_[0-9a-f]{24}_(.{43})$/;
const crypto = require("crypto");
const fs = require("fs"), path = require("path");
const { ObjectId } = require("mongodb");
const { startEntraApp, SessionClient, entraEnv } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { loadConfig, ConfigError } = require("../src/config");
const { generateToken, digestOf, publicIdOf } = require("../src/auth/api-token");
const { ensureDatabase, COLLECTIONS, FEATURE_COLLECTIONS } = require("../src/db/bootstrap");
const { MongoConnection } = require("../src/db/connection");
const { FakeMongoClient } = require("./support/fake-mongo");

const KEY = crypto.randomBytes(32);
const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true }, { key: "group", label: "Group", type: "group" },
  { key: "status", label: "Status", type: "status", options: ["New", "Done"] }, { key: "amount", label: "Amount", type: "number" },
  { key: "secretNote", label: "Hidden note", type: "text", visible: false }
];
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
// Requests from an integration: no cookie, no CSRF token, no Origin.
async function call(token, url, { method = "GET", target = app, headers = {} } = {}) {
  const res = await fetch(`${target.url}/api/v1/external${url}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, text };
}
const code = (res) => res.body?.error?.code;

// A workspace with a real admin, member, viewer, and two boards with synthetic records.
async function workspace(name, target = app) {
  const ws = (await as(people.sysadmin, "POST", "/api/v1/workspaces", { name }, target)).body.workspace;
  for (const [key, role] of [["admin", "WORKSPACE_ADMIN"], ["member", "MEMBER"], ["viewer", "VIEWER"]]) {
    assert.equal((await as(people.sysadmin, "POST", `/api/v1/workspaces/${ws.id}/members`, { userId: await userId(people[key], target), role }, target)).status, 201);
  }
  const makeBoard = async (boardName, rows) => {
    const board = (await as(people.sysadmin, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: boardName, columns: COLUMNS }, target)).body.board;
    const records = rows ? (await as(people.sysadmin, "POST", `/api/v1/boards/${board.id}/records/batch`, { records: rows }, target)).body.items : [];
    return { board, records };
  };
  const one = await makeBoard("Alpha", [{ values: { serial: "A1", status: "New", amount: 10, secretNote: "do not expose" } }, { values: { serial: "A2", status: "Done", amount: 20 } }]);
  const two = await makeBoard("Beta", [{ values: { serial: "B1", status: "New" } }]);
  return { ws, one, two };
}
const issue = (person, { ws, boards, name = "Power BI Integration", expiresAt = inDays(30), scopes = ["read"] }, target = app) => as(person, "POST", "/api/v1/me/api-tokens", { name, workspaceId: ws.id, boardIds: boards.map((b) => b.board.id), scopes, expiresAt }, target);

before(async () => {
  issuer = await createTokenIssuer();
  app = await startEntraApp({ issuer, apiTokens: { key: KEY, issuePerHour: 1000, maxActive: 1000 } });
  people = { sysadmin: issuer.person("Sys Admin", { admin: true }), admin: issuer.person("Wanda Admin"), member: issuer.person("Manny Member"), viewer: issuer.person("Vic Viewer"), outsider: issuer.person("Olive Outsider") };
  for (const p of Object.values(people)) await browserOf(p);
});
after(async () => { await app.close(); });

describe("Token generation and storage", () => {
  test("tokens are random, well formed, and only a keyed digest is stored", async () => {
    const a = generateToken(KEY), b = generateToken(KEY);
    assert.notEqual(a.token, b.token);
    assert.match(a.token, /^jarc_[0-9a-f]{24}_[A-Za-z0-9_-]{43}$/);
    assert.equal(publicIdOf(a.token), a.publicId);
    assert.notEqual(digestOf(KEY, a.token), digestOf(crypto.randomBytes(32), a.token), "the digest depends on the server key");
    for (const bad of ["", "jarc_", "abc", `${a.token}x`, a.token.replace("jarc_", "JARC_"), null, undefined, 5]) assert.equal(publicIdOf(bad), null);

    const f = await workspace("Storage");
    const res = await issue(people.admin, { ws: f.ws, boards: [f.one] });
    assert.equal(res.status, 201);
    const { secret, token } = res.body;
    assert.equal(res.headers.get("cache-control"), "no-store");
    const stored = await app.db.collection(COLLECTIONS.apiTokens).findOne({ _id: new ObjectId(token.id) });
    assert.equal(stored.digest, digestOf(KEY, secret));
    // The whole secret part: it may itself contain "_", so splitting and taking one piece could test a stray character.
    const secretPart = TOKEN_SECRET_PART.exec(secret)[1];
    assert.equal(secretPart.length, 43);
    assert.ok(!JSON.stringify(stored).includes(secretPart), "the secret isn't stored");
    for (let i = 0; i + 16 <= secretPart.length; i += 8) assert.ok(!JSON.stringify(stored).includes(secretPart.slice(i, i + 16)), "no part of the secret is stored");
    assert.equal(stored.publicId, publicIdOf(secret));
    assert.equal(token.digest, undefined);

    // Shown once: nothing afterwards contains it or its digest.
    const list = await as(people.admin, "GET", "/api/v1/me/api-tokens");
    assert.ok(list.body.items.some((t) => t.id === token.id && t.status === "active" && t.name === "Power BI Integration" && t.prefix === `jarc_${stored.publicId.slice(0, 8)}` && t.lastUsedAt === null));
    assert.ok(!list.text.includes(secret) && !list.text.includes(stored.digest));
    const audit = await app.db.collection(COLLECTIONS.apiTokenAudit).find({ tokenId: stored._id }).toArray();
    assert.deepEqual(audit.map((a2) => a2.action), ["token.created"]);
    assert.ok(!JSON.stringify(audit).includes(secret) && !JSON.stringify(audit).includes(stored.digest));
    assert.ok(!app.logger.errors.join(" ").includes(secret));
  });

  test("the request is validated: read-only only, a bounded expiry, this workspace's boards only", async () => {
    const f = await workspace("Validation"), other = await workspace("Validation other");
    const bad = async (body, pattern) => { const res = await as(people.admin, "POST", "/api/v1/me/api-tokens", { name: "T", workspaceId: f.ws.id, boardIds: [f.one.board.id], scopes: ["read"], expiresAt: inDays(5), ...body }); assert.equal(res.status, 400, res.text); assert.match(res.body.error.message, pattern); };
    await bad({ scopes: ["write"] }, /read-only/);
    await bad({ scopes: ["read", "write"] }, /read-only/);
    await bad({ expiresAt: inDays(-1) }, /future/);
    await bad({ expiresAt: inDays(400) }, /366/);
    await bad({ expiresAt: undefined }, /expiresAt/);
    await bad({ name: "  " }, /name/);
    await bad({ boardIds: [] }, /boardIds/);
    await bad({ boardIds: ["nope"] }, /boardIds/);
    await bad({ boardIds: [other.one.board.id] }, /board/);
    await bad({ isAdmin: true }, /Unknown field/);
  });
});

describe("Limits on issuing", () => {
  test("new tokens per hour, and active tokens per person, are limited", async () => {
    const limited = await startEntraApp({ issuer, apiTokens: { key: KEY, issuePerHour: 2 } });
    try {
      const f = await workspace("Hourly", limited);
      for (let i = 0; i < 2; i++) assert.equal((await issue(people.admin, { ws: f.ws, boards: [f.one] }, limited)).status, 201);
      const over = await issue(people.admin, { ws: f.ws, boards: [f.one] }, limited);
      assert.deepEqual([over.status, over.body.error.code], [429, "RATE_LIMITED"]);
    } finally { await limited.close(); }
    const capped = await startEntraApp({ issuer, apiTokens: { key: KEY, issuePerHour: 1000 } });
    try {
      const f = await workspace("Cap", capped);
      const made = [];
      for (let i = 0; i < 25; i++) { const res = await issue(people.admin, { ws: f.ws, boards: [f.one] }, capped); assert.equal(res.status, 201); made.push(res.body.token.id); }
      const over = await issue(people.admin, { ws: f.ws, boards: [f.one] }, capped);
      assert.deepEqual([over.status, over.body.error.code], [409, "TOKEN_LIMIT_REACHED"]);
      assert.equal((await as(people.admin, "POST", `/api/v1/me/api-tokens/${made[0]}/revoke`, {}, capped)).status, 200);
      assert.equal((await issue(people.admin, { ws: f.ws, boards: [f.one] }, capped)).status, 201, "revoking frees a place");
    } finally { await capped.close(); }
  });
});

describe("Who may issue a token", () => {
  test("any real member (admin, member or viewer) may issue a read-only token; outsiders can't; nobody can reach beyond their workspace", async () => {
    const f = await workspace("Issuers"), other = await workspace("Issuers elsewhere");
    for (const who of ["admin", "member", "viewer"]) {
      const res = await issue(people[who], { ws: f.ws, boards: [f.one, f.two], name: `${who} token` });
      assert.equal(res.status, 201, `${who}: ${res.text}`);
      assert.deepEqual(res.body.token.scopes, ["read"]);
      // One token, both boards and every column on them: no token per board or column.
      assert.equal((await call(res.body.secret, `/boards/${f.one.board.id}/columns/status/values`)).status, 200);
      assert.equal((await call(res.body.secret, `/boards/${f.two.board.id}/records?columns=serial,status`)).status, 200);
      assert.equal((await call(res.body.secret, `/boards/${other.one.board.id}/records`)).status, 404, `${who}: not another workspace`);
    }
    assert.equal((await issue(people.outsider, { ws: f.ws, boards: [f.one] })).status, 404, "an outsider can't tell the workspace exists");
    // A member can't name a board from a workspace they aren't in.
    assert.equal((await issue(people.viewer, { ws: f.ws, boards: [other.one] })).status, 400);
  });

  test("a token covers only the boards chosen: a board created afterwards is never added", async () => {
    const f = await workspace("No growth");
    const { token, secret } = (await issue(people.viewer, { ws: f.ws, boards: [f.one] })).body;
    const later = (await as(people.sysadmin, "POST", `/api/v1/workspaces/${f.ws.id}/boards`, { name: "Later", columns: COLUMNS })).body.board;
    assert.equal((await call(secret, `/boards/${later.id}`)).status, 404);
    assert.deepEqual((await call(secret, `/workspaces/${f.ws.id}/boards`)).body.items.map((b) => b.name), ["Alpha"]);
    assert.deepEqual((await as(people.viewer, "GET", "/api/v1/me/api-tokens")).body.items.find((t) => t.id === token.id).boards.map((b) => b.id), [f.one.board.id]);
  });

  test("the JARC.Admin app role alone isn't enough: it exists only in a session, which a token outlives", async () => {
    const f = await workspace("App role");
    await app.db.collection(COLLECTIONS.workspaceMembers).deleteOne({ workspaceId: new ObjectId(f.ws.id), userId: new ObjectId(await userId(people.sysadmin)) });
    const res = await issue(people.sysadmin, { ws: f.ws, boards: [f.one] });
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /your own workspace membership/);
  });

  test("the options list only the workspaces this person could issue a token for", async () => {
    const f = await workspace("Options");
    const names = async (p) => (await as(p, "GET", "/api/v1/me/api-tokens/options")).body.workspaces.map((w) => w.name);
    assert.ok((await names(people.admin)).includes("Options"));
    assert.ok((await names(people.member)).includes("Options"));
    assert.ok((await names(people.viewer)).includes("Options"));
    assert.ok(!(await names(people.outsider)).includes("Options"));
    const listed = (await as(people.admin, "GET", "/api/v1/me/api-tokens/options")).body.workspaces.find((w) => w.id === f.ws.id);
    assert.deepEqual(listed.boards.map((b) => b.name), ["Alpha", "Beta"]);
  });

  for (const [label, options] of [["ACCESS_POLICY=development_shared", { accessPolicy: "development_shared" }], ["JARC_BETA_OPEN_EDITING", { betaOpenEditing: true }]]) {
    test(`${label} grants nothing: open access can't issue or use a token`, async () => {
      const shared = await startEntraApp({ issuer, apiTokens: { key: KEY }, ...options });
      try {
        const owner = issuer.person("Open Owner"), other = issuer.person("Open Other");
        const ws = (await as(owner, "POST", "/api/v1/workspaces", { name: "Open" }, shared)).body.workspace;
        const board = (await as(owner, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "B", columns: COLUMNS }, shared)).body.board;
        // Under open access this person can read the board with their session…
        assert.equal((await as(other, "GET", `/api/v1/boards/${board.id}`, undefined, shared)).status, 200);
        // …but has no membership, so can't issue a token for it.
        const refused = await issue(other, { ws, boards: [{ board }] }, shared);
        assert.equal(refused.status, 403);
        assert.deepEqual((await as(other, "GET", "/api/v1/me/api-tokens/options", undefined, shared)).body.workspaces, []);
        // The creator holds a real membership, and removing it stops the token although open access still lets them in.
        const issued = await issue(owner, { ws, boards: [{ board }] }, shared);
        assert.equal(issued.status, 201);
        assert.equal((await call(issued.body.secret, "/workspaces", { target: shared })).status, 200);
        await shared.db.collection(COLLECTIONS.workspaceMembers).deleteMany({ workspaceId: new ObjectId(ws.id) });
        assert.equal(code(await call(issued.body.secret, "/workspaces", { target: shared })), "TOKEN_ACCESS_REVOKED");
      } finally { await shared.close(); }
    });
  }

  test("session authentication and CSRF protect every management route; a token can't manage tokens", async () => {
    const f = await workspace("Session");
    const { token, secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
    const anonymous = new SessionClient(app.url, app.entra.appOrigin);
    assert.equal((await anonymous.request("GET", "/api/v1/me/api-tokens")).status, 401);
    assert.equal((await anonymous.request("POST", "/api/v1/me/api-tokens", {})).status, 401);
    const browser = await browserOf(people.admin);
    const noCsrf = await browser.request("POST", "/api/v1/me/api-tokens", { name: "T" }, { csrf: "" });
    assert.equal(noCsrf.status, 403); assert.equal(noCsrf.body.error.code, "CSRF_INVALID");
    assert.equal((await browser.request("POST", `/api/v1/me/api-tokens/${token.id}/revoke`, {}, { csrf: "" })).status, 403);
    assert.equal((await browser.request("POST", `/api/v1/me/api-tokens/${token.id}/rotate`, {}, { origin: "https://evil.example" })).status, 403);
    // A token opens no session route, management included.
    for (const [method, url] of [["GET", "/me/api-tokens"], ["POST", "/me/api-tokens"], ["GET", "/workspaces"], ["GET", `/boards/${f.one.board.id}`], ["GET", "/me"]]) {
      const res = await fetch(`${app.url}/api/v1${url}`, { method, headers: { Authorization: `Bearer ${secret}` } });
      assert.equal(res.status, 401, `${method} ${url}`);
    }
    // Other people's tokens don't exist for you.
    assert.equal((await as(people.member, "POST", `/api/v1/me/api-tokens/${token.id}/revoke`, {})).status, 404);
    assert.equal((await as(people.member, "POST", `/api/v1/me/api-tokens/${token.id}/rotate`, {})).status, 404);
    assert.ok(!(await as(people.member, "GET", "/api/v1/me/api-tokens")).body.items.some((t) => t.id === token.id));
    assert.equal((await call(secret, "/workspaces")).status, 200, "still valid after all of that");
  });
});

describe("Using a token", () => {
  test("missing, malformed and wrong tokens are refused with consistent JSON; a session cookie means nothing here", async () => {
    const f = await workspace("Auth");
    const { secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
    const none = await call(null, "/me");
    assert.deepEqual([none.status, code(none), none.headers.get("www-authenticate")], [401, "UNAUTHENTICATED", "Bearer"]);
    const wrongSecret = `${secret.slice(0, -4)}${secret.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
    for (const bad of ["nonsense", "jarc_000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", wrongSecret]) {
      const res = await call(bad, "/me");
      assert.deepEqual([res.status, code(res)], [401, "INVALID_TOKEN"]);
      assert.deepEqual(Object.keys(res.body), ["error"]);
    }
    for (const header of [`Basic ${secret}`, `bearer ${secret}`, `Bearer  ${secret}`, secret]) assert.equal((await call(null, "/me", { headers: { Authorization: header } })).status, 401, header.slice(0, 8));
    const browser = await browserOf(people.admin);
    assert.equal((await browser.request("GET", "/api/v1/external/me")).status, 401, "the cookie isn't accepted");
    const audit = await app.db.collection(COLLECTIONS.apiTokenAudit).find({ action: "token.auth_failed" }).toArray();
    assert.ok(audit.length >= 1 && audit.every((a) => a.expiresAt instanceof Date) && !JSON.stringify(audit).includes(wrongSecret));
  });

  test("a token in the URL is refused even with a valid header, and never logged", async () => {
    const f = await workspace("Query token");
    const { secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
    for (const q of [`token=${secret}`, `access_token=${secret}`, `api_key=${secret}`, `limit=${secret}`, "API_KEY=x"]) {
      for (const auth of [null, secret]) {
        const res = await call(auth, `/boards/${f.one.board.id}/records?${q}`);
        assert.deepEqual([res.status, code(res)], [400, "TOKEN_IN_QUERY"], q.slice(0, 12));
        assert.ok(!res.text.includes(secret));
      }
    }
    assert.ok(!app.logger.errors.join(" ").includes(secret));
  });

  test("only GET and HEAD exist: nothing can write", async () => {
    const f = await workspace("Read only");
    const { secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
    const before = await app.db.collection(COLLECTIONS.records).find({ boardId: new ObjectId(f.one.board.id) }).toArray();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await call(secret, `/records/${f.one.records[0].id}`, { method });
      assert.deepEqual([res.status, code(res), res.headers.get("allow")], [405, "METHOD_NOT_ALLOWED", "GET, HEAD"], method);
    }
    assert.equal((await fetch(`${app.url}/api/v1/external/me`, { method: "HEAD", headers: { Authorization: `Bearer ${secret}` } })).status, 200);
    assert.equal(await fetch(`${app.url}/api/v1/external/me`, { headers: { Authorization: `Bearer ${secret}`, Origin: "https://elsewhere.example" } }).then((r) => r.headers.get("access-control-allow-origin")), null, "no CORS: public web pages can't call it");
    assert.deepEqual(await app.db.collection(COLLECTIONS.records).find({ boardId: new ObjectId(f.one.board.id) }).toArray(), before);
    const unknown = await call(secret, "/nothing/here");
    assert.deepEqual([unknown.status, code(unknown)], [404, "NOT_FOUND"]);
  });

  test("HTTPS is required in production; the forwarded scheme decides, and plain http is refused before any lookup", async () => {
    const prod = await startEntraApp({ issuer, apiTokens: { key: KEY }, environment: "production" });
    try {
      const refused = await call("jarc_x", "/me", { target: prod });
      assert.deepEqual([refused.status, code(refused)], [403, "HTTPS_REQUIRED"]);
      assert.equal(code(await call("jarc_x", "/me", { target: prod, headers: { "X-Forwarded-Proto": "http" } })), "HTTPS_REQUIRED");
      const over = await call("jarc_x", "/me", { target: prod, headers: { "X-Forwarded-Proto": "https" } });
      assert.equal(code(over), "INVALID_TOKEN");
      assert.match(over.headers.get("strict-transport-security"), /max-age/);
    } finally { await prod.close(); }
  });

  test("usage is recorded without slowing or changing anything", async () => {
    const f = await workspace("Usage");
    const { token, secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
    await call(secret, "/me");
    const row = (await as(people.admin, "GET", "/api/v1/me/api-tokens")).body.items.find((t) => t.id === token.id);
    assert.ok(row.lastUsedAt && Date.now() - new Date(row.lastUsedAt).getTime() < 60000);
    assert.equal(row.requestCount, 1);
  });
});

describe("Expiry, revocation and rotation", () => {
  test("an expired token stops; the error says so only to whoever holds the right secret", async () => {
    const f = await workspace("Expired");
    const { token, secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
    await app.db.collection(COLLECTIONS.apiTokens).updateOne({ _id: new ObjectId(token.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.deepEqual([(await call(secret, "/me")).status, code(await call(secret, "/me"))], [401, "TOKEN_EXPIRED"]);
    assert.equal(code(await call(`${secret.slice(0, -2)}${secret.endsWith("AA") ? "BB" : "AA"}`, "/me")), "INVALID_TOKEN");
    assert.equal((await as(people.admin, "GET", "/api/v1/me/api-tokens")).body.items.find((t) => t.id === token.id).status, "expired");
    assert.equal((await as(people.admin, "POST", `/api/v1/me/api-tokens/${token.id}/rotate`, {})).body.error.code, "TOKEN_NOT_ACTIVE");
  });

  test("revoking stops a token at once, is recorded, and repeating it changes nothing", async () => {
    const f = await workspace("Revoked");
    const a = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body, b = (await issue(people.admin, { ws: f.ws, boards: [f.one], name: "Other" })).body;
    assert.equal((await call(a.secret, "/me")).status, 200);
    const revoked = await as(people.admin, "POST", `/api/v1/me/api-tokens/${a.token.id}/revoke`, {});
    assert.deepEqual([revoked.status, revoked.body.token.status], [200, "revoked"]);
    assert.equal(code(await call(a.secret, "/me")), "TOKEN_REVOKED");
    const at = revoked.body.token.revokedAt;
    assert.equal((await as(people.admin, "POST", `/api/v1/me/api-tokens/${a.token.id}/revoke`, {})).body.token.revokedAt, at);
    assert.equal((await call(b.secret, "/me")).status, 200, "other tokens are unaffected");
    const audit = await app.db.collection(COLLECTIONS.apiTokenAudit).find({ tokenId: new ObjectId(a.token.id), action: "token.revoked" }).toArray();
    assert.equal(audit.length, 1);
  });

  test("rotating gives a new secret, keeps the old one for the overlap, and leaves other tokens alone", async () => {
    const f = await workspace("Rotation");
    const old = (await issue(people.admin, { ws: f.ws, boards: [f.one, f.two] })).body, other = (await issue(people.admin, { ws: f.ws, boards: [f.one], name: "Other" })).body;
    const rotated = await as(people.admin, "POST", `/api/v1/me/api-tokens/${old.token.id}/rotate`, { graceHours: 24 });
    assert.equal(rotated.status, 201, rotated.text);
    assert.notEqual(rotated.body.secret, old.secret);
    assert.equal(rotated.body.token.name, old.token.name);
    assert.deepEqual(rotated.body.token.boards.map((b) => b.id), old.token.boards.map((b) => b.id));
    assert.equal(rotated.body.token.rotatedFromId, old.token.id);
    assert.equal(rotated.body.previous.status, "rotating");
    assert.ok(new Date(rotated.body.previous.expiresAt).getTime() <= Date.now() + 24 * 3600000 + 1000);
    for (const secret of [old.secret, rotated.body.secret, other.secret]) assert.equal((await call(secret, "/me")).status, 200);
    const again = await as(people.admin, "POST", `/api/v1/me/api-tokens/${old.token.id}/rotate`, {});
    assert.deepEqual([again.status, again.body.error.code], [409, "TOKEN_ALREADY_ROTATED"]);
    // With no overlap the old one ends now.
    const next = await as(people.admin, "POST", `/api/v1/me/api-tokens/${rotated.body.token.id}/rotate`, { graceHours: 0 });
    assert.equal(next.status, 201);
    assert.equal(code(await call(rotated.body.secret, "/me")), "TOKEN_REVOKED");
    assert.equal((await call(next.body.secret, "/me")).status, 200);
    assert.equal((await as(people.admin, "POST", `/api/v1/me/api-tokens/${next.body.token.id}/rotate`, { graceHours: 9999 })).status, 400);
  });

  test("rotating needs a real membership; a demoted owner still can, a removed one can't create or rotate", async () => {
    const f = await workspace("Rotation rights"), members = app.db.collection(COLLECTIONS.workspaceMembers);
    const filter = { workspaceId: new ObjectId(f.ws.id), userId: new ObjectId(await userId(people.admin)) };
    const { token, secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
    const rotate = async () => as(people.admin, "POST", `/api/v1/me/api-tokens/${token.id}/rotate`, {});
    const row = async () => (await as(people.admin, "GET", "/api/v1/me/api-tokens")).body.items.find((t) => t.id === token.id);
    assert.equal((await row()).canRotate, true);
    await members.updateOne(filter, { $set: { role: "VIEWER" } });
    assert.equal((await row()).canRotate, true, "a viewer may still rotate");
    assert.equal((await call(secret, `/boards/${f.one.board.id}/records`)).status, 200, "still reads as a viewer");
    assert.equal((await issue(people.admin, { ws: f.ws, boards: [f.one] })).status, 201, "and create");
    const doc = await members.findOne(filter);
    await members.deleteOne(filter);
    assert.equal(code(await call(secret, "/me")), "TOKEN_ACCESS_REVOKED");
    assert.equal((await rotate()).status, 403);
    assert.equal((await issue(people.admin, { ws: f.ws, boards: [f.one] })).status, 404, "no membership: can't create");
    const gone = await row();
    assert.deepEqual([gone.status, gone.canRotate, gone.workspace.name, gone.boards[0].name], ["no_access", false, null, null], "names are hidden without access");
    await members.insertOne({ ...doc, role: "WORKSPACE_ADMIN" });
    assert.equal((await rotate()).status, 201, "an admin again: allowed");
  });

  describe("Revoking your own token", () => {
    const setup = async (name) => {
      const f = await workspace(name), filter = { workspaceId: new ObjectId(f.ws.id), userId: new ObjectId(await userId(people.admin)) };
      return { f, filter, members: app.db.collection(COLLECTIONS.workspaceMembers), ...(await issue(people.admin, { ws: f.ws, boards: [f.one] })).body };
    };
    const revoke = (id) => as(people.admin, "POST", `/api/v1/me/api-tokens/${id}/revoke`, {});
    const stored = (id) => app.db.collection(COLLECTIONS.apiTokens).findOne({ _id: new ObjectId(id) });
    const audits = (id) => app.db.collection(COLLECTIONS.apiTokenAudit).find({ tokenId: new ObjectId(id), action: "token.revoked" }).toArray();

    for (const role of ["MEMBER", "VIEWER"]) {
      test(`an owner demoted to ${role} can revoke it, and it stops at once`, async () => {
        const { f, filter, members, token, secret } = await setup(`Revoke as ${role}`);
        await members.updateOne(filter, { $set: { role } });
        assert.equal((await call(secret, `/boards/${f.one.board.id}`)).status, 200);
        const res = await revoke(token.id);
        assert.deepEqual([res.status, res.body.token.status], [200, "revoked"]);
        assert.equal(code(await call(secret, `/boards/${f.one.board.id}`)), "TOKEN_REVOKED");
        assert.equal((await audits(token.id)).length, 1);
      });
    }

    test("an owner with no membership left can still revoke it, and learns nothing about the workspace", async () => {
      const { filter, members, token, secret } = await setup("Revoke removed");
      await members.deleteOne(filter);
      assert.equal(code(await call(secret, "/me")), "TOKEN_ACCESS_REVOKED");
      const res = await revoke(token.id);
      assert.deepEqual([res.status, res.body.token.status, res.body.token.workspace.name, res.body.token.boards[0].name], [200, "revoked", null, null]);
      const [entry] = await audits(token.id);
      assert.equal(entry.actorUserId.toHexString(), await userId(people.admin));
      assert.equal(entry.ownerUserId.toHexString(), await userId(people.admin));
    });

    test("revoking grants nothing: no membership, role, scope or expiry changes, and regaining the role doesn't revive it", async () => {
      const { f, filter, members, token, secret } = await setup("Revoke grants nothing");
      await members.updateOne(filter, { $set: { role: "VIEWER" } });
      const [before, memberBefore] = [await stored(token.id), await members.findOne(filter)];
      const optionsBefore = (await as(people.admin, "GET", "/api/v1/me/api-tokens/options")).body;
      await revoke(token.id);
      const after = await stored(token.id);
      assert.ok(after.revokedAt instanceof Date);
      const { revokedAt: _a, ...kept } = after, { revokedAt: _b, ...was } = before;
      assert.deepEqual(kept, was, "only revokedAt changed");
      assert.deepEqual(await members.findOne(filter), memberBefore, "the membership is untouched");
      assert.deepEqual((await as(people.admin, "GET", "/api/v1/me/api-tokens/options")).body, optionsBefore, "the right to create tokens is exactly as it was");
      assert.equal((await as(people.admin, "POST", `/api/v1/me/api-tokens/${token.id}/rotate`, {})).status, 409, "and a revoked token can't be rotated back");
      await members.updateOne(filter, { $set: { role: "WORKSPACE_ADMIN" } });
      assert.equal(code(await call(secret, "/me")), "TOKEN_REVOKED", "an admin again: it stays revoked");
      assert.equal((await revoke(token.id)).body.token.revokedAt, after.revokedAt.toISOString(), "repeating changes nothing");
      assert.equal((await audits(token.id)).length, 1, "and records nothing more");
    });

    test("nobody can revoke another person's token, administrators included", async () => {
      const { filter, members, token, secret } = await setup("Revoke others");
      await members.updateOne(filter, { $set: { role: "VIEWER" } });
      for (const person of [people.member, people.outsider, people.sysadmin]) {
        const res = await as(person, "POST", `/api/v1/me/api-tokens/${token.id}/revoke`, {});
        assert.deepEqual([res.status, res.body.error.code], [404, "NOT_FOUND"], person.name);
      }
      assert.equal((await stored(token.id)).revokedAt, null);
      assert.equal((await call(secret, "/me")).status, 200);
      assert.deepEqual(await audits(token.id), []);
    });

    test("CSRF protection, the session and ownership all still apply", async () => {
      const { filter, members, token, secret } = await setup("Revoke CSRF");
      await members.deleteOne(filter);
      const browser = await browserOf(people.admin);
      assert.equal((await browser.request("POST", `/api/v1/me/api-tokens/${token.id}/revoke`, {}, { csrf: "" })).body.error.code, "CSRF_INVALID");
      assert.equal((await browser.request("POST", `/api/v1/me/api-tokens/${token.id}/revoke`, {}, { origin: "https://evil.example" })).body.error.code, "CSRF_INVALID");
      assert.equal((await new SessionClient(app.url, app.entra.appOrigin).request("POST", `/api/v1/me/api-tokens/${token.id}/revoke`, {})).status, 401);
      assert.equal((await fetch(`${app.url}/api/v1/me/api-tokens/${token.id}/revoke`, { method: "POST", headers: { Authorization: `Bearer ${secret}` } })).status, 401, "a token can't revoke itself");
      assert.equal((await stored(token.id)).revokedAt, null);
    });

    test("a disabled or deleted account can't sign in to revoke, and its tokens are refused anyway", async () => {
      for (const [how, change] of [["disabled", (users, id) => users.updateOne({ _id: id }, { $set: { status: "disabled" } })], ["deleted", (users, id) => users.deleteOne({ _id: id })]]) {
        const owner = issuer.person(`Gone ${how}`), target = await startEntraApp({ issuer, apiTokens: { key: KEY } });
        try {
          const f = await workspace(`Account ${how}`, target);
          assert.equal((await as(people.sysadmin, "POST", `/api/v1/workspaces/${f.ws.id}/members`, { userId: await userId(owner, target), role: "WORKSPACE_ADMIN" }, target)).status, 201);
          const { token, secret } = (await issue(owner, { ws: f.ws, boards: [f.one] }, target)).body;
          assert.equal((await call(secret, "/me", { target })).status, 200);
          await change(target.db.collection(COLLECTIONS.users), new ObjectId(await userId(owner, target)));
          assert.equal(code(await call(secret, "/me", { target })), "TOKEN_OWNER_DISABLED", how);
          assert.ok([401, 403].includes((await as(owner, "POST", `/api/v1/me/api-tokens/${token.id}/revoke`, {}, target)).status), `${how}: no session to revoke with`);
          assert.equal((await target.db.collection(COLLECTIONS.apiTokens).findOne({ _id: new ObjectId(token.id) })).revokedAt, null);
        } finally { await target.close(); }
      }
    });
  });

  test("an Entra administrator gets no standing through their role over someone else's token", async () => {
    const f = await workspace("No admin bypass");
    const { token, secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
    assert.equal((await as(people.sysadmin, "POST", `/api/v1/me/api-tokens/${token.id}/revoke`, {})).status, 404, "another person's token doesn't exist for them");
    assert.equal((await call(secret, "/me")).status, 200);
  });
});

describe("Scope and isolation", () => {
  let f, other, secret;
  before(async () => {
    f = await workspace("Scoped"); other = await workspace("Elsewhere");
    secret = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body.secret;
  });
  const unreachable = async (url) => { const res = await call(secret, url); assert.deepEqual([res.status, code(res)], [404, "NOT_FOUND"], url); };

  test("only the token's workspace and boards are listed", async () => {
    assert.deepEqual((await call(secret, "/workspaces")).body.items.map((w) => w.id), [f.ws.id]);
    assert.deepEqual((await call(secret, `/workspaces/${f.ws.id}/boards`)).body.items.map((b) => b.id), [f.one.board.id]);
    const me = (await call(secret, "/me")).body.token;
    assert.deepEqual([me.workspaceId, me.boardIds, me.scopes], [f.ws.id, [f.one.board.id], ["read"]]);
    assert.equal(me.digest, undefined);
  });

  test("another board in the same workspace, and everything in another workspace, answers like it doesn't exist", async () => {
    for (const url of [`/boards/${f.two.board.id}`, `/boards/${f.two.board.id}/columns`, `/boards/${f.two.board.id}/groups`, `/boards/${f.two.board.id}/records`, `/records/${f.two.records[0].id}`,
      `/workspaces/${other.ws.id}/boards`, `/boards/${other.one.board.id}`, `/boards/${other.one.board.id}/records`, `/records/${other.one.records[0].id}`, `/boards/${new ObjectId()}`, `/records/${new ObjectId()}`, `/workspaces/${new ObjectId()}/boards`]) await unreachable(url);
  });

  test("invalid IDs and unknown parameters get clear errors", async () => {
    for (const url of ["/boards/nope", "/records/nope", "/workspaces/nope/boards"]) assert.deepEqual([(await call(secret, url)).status, code(await call(secret, url))], [400, "VALIDATION_ERROR"]);
    for (const q of ["limit=0", "limit=501", "limit=x", "cursor=!!!", "cursor=abc", "groupId=missing", "includeArchived=maybe", "updatedSince=yesterday", "sort=position", "filter={}"]) {
      const res = await call(secret, `/boards/${f.one.board.id}/records?${q}`);
      assert.deepEqual([res.status, code(res)], [400, "VALIDATION_ERROR"], q);
    }
    assert.doesNotMatch((await call(secret, "/boards/nope")).text, /mongo|ObjectId|stack|\bat /i);
  });

  test("a board moved out of the workspace stops being reachable, even though the token still lists it", async () => {
    const m = await workspace("Moving"), target = await workspace("Moved to");
    const token = (await issue(people.admin, { ws: m.ws, boards: [m.one] })).body.secret;
    assert.equal((await call(token, `/boards/${m.one.board.id}`)).status, 200);
    await app.db.collection(COLLECTIONS.boards).updateOne({ _id: new ObjectId(m.one.board.id) }, { $set: { workspaceId: new ObjectId(target.ws.id) } });
    await app.db.collection(COLLECTIONS.records).updateMany({ boardId: new ObjectId(m.one.board.id) }, { $set: { workspaceId: new ObjectId(target.ws.id) } });
    assert.equal((await call(token, `/boards/${m.one.board.id}`)).status, 404);
    assert.equal((await call(token, `/records/${m.one.records[0].id}`)).status, 404);
    assert.deepEqual((await call(token, `/workspaces/${m.ws.id}/boards`)).body.items, []);
  });

  test("archived boards and workspaces are left out unless explicitly requested", async () => {
    const a = await workspace("Archiving"), id = a.two.board.id, record = a.two.records[0].id;
    const token = (await issue(people.admin, { ws: a.ws, boards: [a.one, a.two] })).body.secret;
    await app.db.collection(COLLECTIONS.boards).updateOne({ _id: new ObjectId(id) }, { $set: { archived: true } });
    const paths = [`/boards/${id}`, `/boards/${id}/columns`, `/boards/${id}/groups`, `/boards/${id}/columns/status`, `/boards/${id}/columns/status/values`, `/boards/${id}/records`, `/boards/${id}/records/${record}/columns/status`, `/records/${record}`];
    for (const url of paths) {
      assert.equal((await call(token, url)).status, 404, url);
      assert.equal((await call(token, `${url}?includeArchived=false`)).status, 404, url);
      assert.equal((await call(token, `${url}?includeArchived=true`)).status, 200, url);
      assert.equal((await call(token, `${url}?includeArchived=maybe`)).status, 400, url);
    }
    assert.equal((await call(token, `/boards/${id}?includeArchived=true`)).body.board.archived, true);
    assert.deepEqual((await call(token, `/workspaces/${a.ws.id}/boards`)).body.items.map((b) => b.id), [a.one.board.id]);
    assert.deepEqual((await call(token, `/workspaces/${a.ws.id}/boards?includeArchived=true`)).body.items.map((b) => b.id).sort(), [a.one.board.id, id].sort());
    await app.db.collection(COLLECTIONS.workspaces).updateOne({ _id: new ObjectId(a.ws.id) }, { $set: { archived: true } });
    assert.deepEqual((await call(token, "/workspaces")).body.items, []);
    assert.equal((await call(token, `/boards/${a.one.board.id}`)).status, 404);
    assert.deepEqual((await call(token, "/workspaces?includeArchived=true")).body.items.map((w) => [w.id, w.archived]), [[a.ws.id, true]]);
    assert.equal((await call(token, `/boards/${a.one.board.id}?includeArchived=true`)).status, 200);
  });

  test("includeArchived never widens access: not to another board, and not once the owner has lost the workspace", async () => {
    const a = await workspace("Archive scope"), other = await workspace("Archive other");
    await app.db.collection(COLLECTIONS.boards).updateMany({ _id: { $in: [a.two.board.id, other.one.board.id].map((i) => new ObjectId(i)) } }, { $set: { archived: true } });
    const token = (await issue(people.admin, { ws: a.ws, boards: [a.one] })).body.secret;
    assert.equal((await call(token, `/boards/${a.two.board.id}?includeArchived=true`)).status, 404, "archived, same workspace, not on the token");
    assert.equal((await call(token, `/boards/${other.one.board.id}?includeArchived=true`)).status, 404, "archived, another workspace");
    await app.db.collection(COLLECTIONS.workspaceMembers).deleteOne({ workspaceId: new ObjectId(a.ws.id), userId: new ObjectId(await userId(people.admin)) });
    assert.equal(code(await call(token, "/workspaces?includeArchived=true")), "TOKEN_ACCESS_REVOKED");
  });

  test("an archived record is reached only by asking; an archived board can be chosen for a token", async () => {
    const a = await workspace("Archived record"), record = a.one.records[0].id;
    await app.db.collection(COLLECTIONS.records).updateOne({ _id: new ObjectId(record) }, { $set: { archived: true } });
    const token = (await issue(people.admin, { ws: a.ws, boards: [a.one] })).body.secret;
    for (const url of [`/records/${record}`, `/boards/${a.one.board.id}/records/${record}/columns/status`]) {
      assert.equal((await call(token, url)).status, 404, url);
      assert.equal((await call(token, `${url}?includeArchived=true`)).status, 200, url);
    }
    await app.db.collection(COLLECTIONS.boards).updateOne({ _id: new ObjectId(a.two.board.id) }, { $set: { archived: true } });
    const listed = (await as(people.admin, "GET", "/api/v1/me/api-tokens/options")).body.workspaces.find((w) => w.id === a.ws.id);
    assert.equal(listed.boards.find((b) => b.id === a.two.board.id).archived, true);
    const made = await issue(people.admin, { ws: a.ws, boards: [a.two] });
    assert.equal(made.status, 201, made.text);
    const rotated = await as(people.admin, "POST", `/api/v1/me/api-tokens/${made.body.token.id}/rotate`, { graceHours: 0 });
    assert.equal(rotated.status, 201, "rotating keeps an archived board");
    assert.deepEqual(rotated.body.token.boards.map((b) => b.id), [a.two.board.id]);
  });
});

describe("Permission changes after a token is created", () => {
  const membership = async (f, person) => ({ workspaceId: new ObjectId(f.ws.id), userId: new ObjectId(await userId(person)) });

  test("removing the owner's membership stops the token on its next use; restoring it brings it back", async () => {
    const f = await workspace("Removed");
    const { secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
    assert.equal((await call(secret, "/workspaces")).status, 200);
    const filter = await membership(f, people.admin);
    const doc = await app.db.collection(COLLECTIONS.workspaceMembers).findOne(filter);
    await app.db.collection(COLLECTIONS.workspaceMembers).deleteOne(filter);
    const res = await call(secret, "/workspaces");
    assert.deepEqual([res.status, code(res)], [403, "TOKEN_ACCESS_REVOKED"]);
    await app.db.collection(COLLECTIONS.workspaceMembers).insertOne(doc);
    assert.equal((await call(secret, "/workspaces")).status, 200);
  });

  test("a lower role keeps reading, because read-only never exceeds a viewer", async () => {
    const f = await workspace("Demoted");
    const { secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
    await app.db.collection(COLLECTIONS.workspaceMembers).updateOne(await membership(f, people.admin), { $set: { role: "VIEWER" } });
    assert.equal((await call(secret, `/boards/${f.one.board.id}/records`)).status, 200);
  });

  test("a disabled owner's tokens stop at once", async () => {
    const owner = issuer.person("Dana Disabled");
    await browserOf(owner);
    const f = await workspace("Disabled");
    assert.equal((await as(people.sysadmin, "POST", `/api/v1/workspaces/${f.ws.id}/members`, { userId: await userId(owner), role: "WORKSPACE_ADMIN" })).status, 201);
    const { secret } = (await issue(owner, { ws: f.ws, boards: [f.one] })).body;
    assert.equal((await call(secret, "/me")).status, 200);
    await app.db.collection(COLLECTIONS.users).updateOne({ _id: new ObjectId(await userId(owner)) }, { $set: { status: "disabled" } });
    const res = await call(secret, "/me");
    assert.deepEqual([res.status, code(res)], [403, "TOKEN_OWNER_DISABLED"]);
  });

  test("Account Management: a blocked account's tokens stop; enforced roles cap access", async () => {
    const SUPER = "0c7c7c7c-0000-4000-8000-0000000000a1";
    const managed = await startEntraApp({ issuer, apiTokens: { key: KEY }, accounts: { mode: "enforced", superAdmin: { tenantId: issuer.config.tenantId, objectId: SUPER, email: null } } });
    try {
      const owner = issuer.person("Ann Enforced");
      await browserOf(owner, managed);
      const ownerId = new ObjectId(await (async () => { const u = await managed.db.collection(COLLECTIONS.users).findOne({ displayName: "Ann Enforced" }); return u._id.toHexString(); })());
      const users = managed.db.collection(COLLECTIONS.users);
      await users.updateOne({ _id: ownerId }, { $set: { account: { status: "active", role: "ADMIN", version: 1 } } });
      const wsId = new ObjectId(), boardId = new ObjectId(), now = new Date();
      await managed.db.collection(COLLECTIONS.workspaces).insertOne({ _id: wsId, name: "Managed", archived: false, position: 1, createdAt: now, updatedAt: now, version: 1 });
      await managed.db.collection(COLLECTIONS.boards).insertOne({ _id: boardId, workspaceId: wsId, name: "B", archived: false, position: 1, columns: [], groups: [], savedViews: [], createdAt: now, updatedAt: now, version: 1 });
      await managed.db.collection(COLLECTIONS.workspaceMembers).insertOne({ workspaceId: wsId, userId: ownerId, role: "WORKSPACE_ADMIN", status: "active", createdAt: now, updatedAt: now });
      const issued = await as(owner, "POST", "/api/v1/me/api-tokens", { name: "T", workspaceId: wsId.toHexString(), boardIds: [boardId.toHexString()], scopes: ["read"], expiresAt: inDays(3) }, managed);
      assert.equal(issued.status, 201, issued.text);
      assert.equal((await call(issued.body.secret, "/me", { target: managed })).status, 200);
      // Capped to a Viewer: still reads (and, below, may still issue: a read-only token needs only Viewer).
      await users.updateOne({ _id: ownerId }, { $set: { "account.role": "VIEWER" } });
      assert.equal((await call(issued.body.secret, "/me", { target: managed })).status, 200);
      // A Super Admin account without a membership can't issue one, and its role keeps no token alive.
      await users.updateOne({ _id: ownerId }, { $set: { "account.role": "SUPER_ADMIN" } });
      const membership = await managed.db.collection(COLLECTIONS.workspaceMembers).findOne({ userId: ownerId });
      await managed.db.collection(COLLECTIONS.workspaceMembers).deleteOne({ _id: membership._id });
      assert.equal((await as(owner, "POST", "/api/v1/me/api-tokens", { name: "SA", workspaceId: wsId.toHexString(), boardIds: [boardId.toHexString()], scopes: ["read"], expiresAt: inDays(3) }, managed)).status, 403);
      assert.equal(code(await call(issued.body.secret, "/me", { target: managed })), "TOKEN_ACCESS_REVOKED");
      assert.deepEqual((await as(owner, "GET", "/api/v1/me/api-tokens/options", undefined, managed)).body.workspaces, []);
      await managed.db.collection(COLLECTIONS.workspaceMembers).insertOne(membership);
      await users.updateOne({ _id: ownerId }, { $set: { "account.role": "VIEWER" } });
      const capped = await as(owner, "POST", "/api/v1/me/api-tokens", { name: "T2", workspaceId: wsId.toHexString(), boardIds: [boardId.toHexString()], scopes: ["read"], expiresAt: inDays(3) }, managed);
      assert.equal(capped.status, 201, "capped to Viewer: a read-only token is still within reach");
      // Not yet approved (pending): the cap removes the membership's effect, so nothing can be issued.
      await users.updateOne({ _id: ownerId }, { $set: { "account.status": "pending" } });
      const pending = await as(owner, "POST", "/api/v1/me/api-tokens", { name: "T3", workspaceId: wsId.toHexString(), boardIds: [boardId.toHexString()], scopes: ["read"], expiresAt: inDays(3) }, managed);
      assert.ok([401, 403, 404].includes(pending.status), `pending: ${pending.status}`);
      await users.updateOne({ _id: ownerId }, { $set: { "account.status": "active" } });
      // Blocked: stops.
      await users.updateOne({ _id: ownerId }, { $set: { "account.status": "blocked" } });
      assert.equal(code(await call(issued.body.secret, "/me", { target: managed })), "TOKEN_OWNER_DISABLED");
    } finally { await managed.close(); }
  });
});

describe("Data accuracy and metadata", () => {
  test("values match the session API exactly, hidden columns included", async () => {
    const f = await workspace("Accuracy");
    const { secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
    const fromSession = (await as(people.admin, "GET", `/api/v1/boards/${f.one.board.id}/records?limit=200`)).body.items;
    const fromToken = (await call(secret, `/boards/${f.one.board.id}/records`)).body.items;
    assert.equal(fromToken.length, fromSession.length);
    for (const session of fromSession) {
      const external = fromToken.find((r) => r.id === session.id);
      for (const [key, value] of Object.entries(session.values)) assert.deepEqual(external.values[key], value, key);
      assert.deepEqual(Object.keys(external.values).sort(), ["amount", "group", "secretNote", "serial", "status"], "every column is present");
      for (const k of ["workspaceId", "boardId", "groupId", "position", "archived", "createdAt", "updatedAt", "version"]) assert.deepEqual(external[k], session[k], k);
      assert.deepEqual((await call(secret, `/records/${session.id}`)).body.record, external);
    }
    assert.equal(typeof fromToken.find((r) => r.values.serial === "A1").values.amount, "number", "types are preserved");
    assert.equal(fromToken.find((r) => r.values.serial === "A1").values.secretNote, "do not expose", "hiding a column isn't a permission");
    assert.doesNotMatch(JSON.stringify(fromToken), /_id|createdBy|updatedBy|legacyId|importId/);
  });

  test("boards carry what's needed to rebuild the table, without internal fields; hidden columns are marked", async () => {
    const f = await workspace("Metadata");
    const { secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
    const board = (await call(secret, `/boards/${f.one.board.id}`)).body.board;
    assert.equal(board.recordCount, 2);
    assert.deepEqual(board.columns.map((c) => [c.id, c.name, c.type]), [["serial", "Item", "text"], ["group", "Group", "group"], ["status", "Status", "status"], ["amount", "Amount", "number"], ["secretNote", "Hidden note", "text"]]);
    assert.deepEqual(board.columns.filter((c) => !c.visible).map((c) => c.id), ["secretNote"]);
    assert.deepEqual(board.columns.find((c) => c.id === "status").options, ["New", "Done"]);
    assert.deepEqual((await call(secret, `/boards/${f.one.board.id}/columns`)).body.items, board.columns);
    assert.deepEqual((await call(secret, `/boards/${f.one.board.id}/groups`)).body.items, board.groups);
    assert.ok(board.groups.length && board.groups.every((g) => g.id && g.name !== undefined && typeof g.archived === "boolean"));
    assert.doesNotMatch(JSON.stringify(board), /savedViews|source|connection|createdBy/);
    const summary = (await call(secret, `/workspaces/${f.ws.id}/boards`)).body.items[0];
    assert.deepEqual([summary.name, summary.recordCount], ["Alpha", 2]);
  });
});

describe("Board and column IDs", () => {
  const boardOf = async (id) => (await as(people.sysadmin, "GET", `/api/v1/boards/${id}`)).body.board;
  const patch = async (id, change) => { const res = await as(people.sysadmin, "PATCH", `/api/v1/boards/${id}`, { expectedVersion: (await boardOf(id)).version, ...change }); assert.equal(res.status, 200, res.text); return res.body.board; };
  const removeColumn = async (id, key) => { const res = await as(people.sysadmin, "DELETE", `/api/v1/boards/${id}/columns/${key}?expectedVersion=${(await boardOf(id)).version}`); assert.equal(res.status, 200, res.text); };
  const addColumn = async (id, column) => as(people.sysadmin, "POST", `/api/v1/boards/${id}/columns`, { expectedVersion: (await boardOf(id)).version, column });

  test("renaming, reordering, hiding, resizing, changing type and moving keep every ID", async () => {
    const f = await workspace("Stable"), target = await workspace("Stable target"), id = f.one.board.id;
    const { secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
    const ids = async () => (await call(secret, `/boards/${id}/columns`)).body.items.map((c) => c.id).sort();
    const before = await ids();
    await patch(id, { name: "Alpha renamed" });
    const edit = (fn) => boardOf(id).then((b) => patch(id, { columns: fn(b.columns) }));
    await edit((columns) => columns.map((c) => (c.key === "status" ? { ...c, label: "State" } : c)));
    assert.deepEqual((await call(secret, `/boards/${id}/columns/status`)).body.column.name, "State", "the name changed");
    await edit((columns) => [columns[0], ...columns.slice(1).reverse()]);
    await edit((columns) => columns.map((c) => (c.key === "amount" ? { ...c, width: 333 } : c)));
    assert.deepEqual(await ids(), before);
    await edit((columns) => columns.map((c) => (c.key === "amount" ? { ...c, visible: false } : c)));
    assert.equal((await call(secret, `/boards/${id}/columns/amount`)).body.column.visible, false, "hidden: still there, and marked");
    await edit((columns) => columns.map((c) => (c.key === "amount" ? { ...c, visible: true } : c)));
    assert.deepEqual(await ids(), before, "the same ID when shown again");
    const changed = await as(people.sysadmin, "POST", `/api/v1/boards/${id}/columns/amount/type`, { expectedVersion: (await boardOf(id)).version, type: "text" });
    assert.equal(changed.status, 200, changed.text);
    assert.deepEqual(await ids(), before);
    const moved = await as(people.sysadmin, "POST", `/api/v1/boards/${id}/move`, { expectedVersion: (await boardOf(id)).version, workspaceId: target.ws.id });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(moved.body.board.id, id, "a moved board keeps its ID");
    assert.deepEqual((await boardOf(id)).columns.map((c) => c.key).sort(), before);
  });

  test("new boards and columns get IDs; a column ID is unique on its board and means nothing on another", async () => {
    const f = await workspace("New IDs");
    assert.notEqual(f.one.board.id, f.two.board.id);
    const added = await addColumn(f.one.board.id, { key: "custom_1", label: "Extra", type: "text" });
    assert.equal(added.status, 201, added.text);
    assert.equal((await addColumn(f.one.board.id, { key: "custom_1", label: "Twin", type: "text" })).status, 400, "unique within the board");
    assert.equal((await addColumn(f.two.board.id, { key: "custom_1", label: "Other board", type: "number" })).status, 201, "another board may hold the same ID");
    await as(people.sysadmin, "PATCH", `/api/v1/records/${f.one.records[0].id}`, { expectedVersion: f.one.records[0].version, values: { custom_1: "From Alpha" } });
    const secret = (await issue(people.admin, { ws: f.ws, boards: [f.one, f.two] })).body.secret;
    const one = await call(secret, `/boards/${f.one.board.id}/columns/custom_1`), two = await call(secret, `/boards/${f.two.board.id}/columns/custom_1`);
    assert.deepEqual([one.body.column.boardId, one.body.column.name, two.body.column.boardId, two.body.column.name], [f.one.board.id, "Extra", f.two.board.id, "Other board"], "board and column together are unambiguous");
    assert.ok(!JSON.stringify((await call(secret, `/boards/${f.two.board.id}/columns/custom_1/values`)).body).includes("From Alpha"));
  });

  test("a deleted column can't be read, and its ID can't go to another column; undo can restore the same one", async () => {
    const f = await workspace("Deleted column"), id = f.one.board.id;
    const { secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
    await removeColumn(id, "amount");
    assert.equal((await call(secret, `/boards/${id}/columns/amount`)).status, 404);
    assert.equal((await call(secret, `/boards/${id}/columns/amount/values`)).status, 404);
    assert.equal((await call(secret, `/boards/${id}/records/${f.one.records[0].id}/columns/amount`)).status, 404);
    assert.equal((await call(secret, `/boards/${id}/records?columns=amount`)).status, 400);
    const other = await addColumn(id, { key: "amount", label: "Different meaning", type: "text" });
    assert.equal(other.status, 400);
    assert.match(other.body.error.message, /can't be used again/);
    const board = await boardOf(id);
    assert.equal((await as(people.sysadmin, "PATCH", `/api/v1/boards/${id}`, { expectedVersion: board.version, columns: [...board.columns, { key: "amount", label: "Sneaked", type: "number" }] })).status, 400, "not through a board update either");
    assert.equal(board.retiredColumns, undefined, "the session API's shape is unchanged");
    // Undo: the same ID and type, soon after.
    assert.equal((await addColumn(id, { key: "amount", label: "Amount", type: "number" })).status, 201);
    assert.equal((await call(secret, `/boards/${id}/columns/amount`)).status, 200);
    // Too late for undo.
    await removeColumn(id, "amount");
    await app.db.collection(COLLECTIONS.boards).updateOne({ _id: new ObjectId(id) }, { $set: { "retiredColumns.0.at": new Date(Date.now() - 25 * 3600000) } });
    assert.equal((await addColumn(id, { key: "amount", label: "Amount", type: "number" })).status, 400);
  });

  test("a deleted board and its records can't be reached, and its ID isn't reused", async () => {
    const f = await workspace("Deleted board"), id = f.one.board.id, recordId = f.one.records[0].id;
    const { secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one, f.two] })).body;
    assert.equal((await as(people.sysadmin, "DELETE", `/api/v1/boards/${id}?expectedVersion=${(await boardOf(id)).version}`)).status, 200);
    for (const url of [`/boards/${id}`, `/boards/${id}/columns`, `/boards/${id}/columns/status`, `/boards/${id}/columns/status/values`, `/boards/${id}/records`, `/boards/${id}/records/${recordId}/columns/status`, `/records/${recordId}`]) assert.equal((await call(secret, url)).status, 404, url);
    const again = (await as(people.sysadmin, "POST", `/api/v1/workspaces/${f.ws.id}/boards`, { name: "Alpha", columns: COLUMNS })).body.board;
    assert.notEqual(again.id, id);
    assert.equal((await call(secret, `/boards/${again.id}`)).status, 404, "a token doesn't gain a new board with the same name");
  });
});

describe("Reading specific columns", () => {
  const ALL_TYPES = [
    { key: "serial", label: "Item", type: "text", required: true }, { key: "grp", label: "Group", type: "group" }, { key: "qty", label: "Qty", type: "number" }, { key: "state", label: "State", type: "status", options: ["New", "Done"] },
    { key: "one", label: "One", type: "dropdown", options: ["A", "B"] }, { key: "many", label: "Many", type: "dropdown", options: ["A", "B"], multiple: true }, { key: "ok", label: "OK", type: "checkbox" }, { key: "prio", label: "Priority", type: "priority" },
    { key: "who", label: "People", type: "owner" }, { key: "when", label: "When", type: "date" }, { key: "mail", label: "Email", type: "email" }, { key: "tel", label: "Phone", type: "phone" }, { key: "url", label: "Link", type: "link" }, { key: "docs", label: "Files", type: "files" },
    { key: "secret", label: "Hidden", type: "text", visible: false }
  ];
  const STORED = { serial: "Row", qty: 12.5, state: "Done", one: "A", many: ["A", "B"], ok: false, prio: "High", who: [`user:${"a".repeat(24)}`], when: "2026-03-04", mail: "a@example.invalid", tel: "+1 555 0100", url: "https://example.invalid/x", docs: "", secret: "visible only by choice" };
  let f, boardId, secret, full, sparse, groupId;
  before(async () => {
    f = await workspace("Types");
    const board = (await as(people.sysadmin, "POST", `/api/v1/workspaces/${f.ws.id}/boards`, { name: "All types", columns: ALL_TYPES })).body.board;
    boardId = board.id; groupId = board.groups[0].id;
    const now = new Date(), base = { workspaceId: new ObjectId(f.ws.id), boardId: new ObjectId(boardId), position: 1, archived: false, pinned: false, createdAt: now, updatedAt: now, version: 1 };
    full = new ObjectId(); sparse = new ObjectId();
    await app.db.collection(COLLECTIONS.records).insertMany([{ _id: full, ...base, groupId, values: STORED }, { _id: sparse, ...base, groupId: null, values: { serial: "Empty", one: "", qty: null } }]);
    secret = (await issue(people.admin, { ws: f.ws, boards: [f.one, { board }] })).body.secret;
  });

  test("selected columns: exactly those, in the usual record shape", async () => {
    const res = await call(secret, `/boards/${boardId}/records?columns=qty,state`);
    assert.equal(res.status, 200, res.text);
    const row = res.body.items.find((r) => r.id === full.toHexString());
    assert.deepEqual(row.values, { qty: 12.5, state: "Done" });
    assert.deepEqual(res.body.items.find((r) => r.id === sparse.toHexString()).values, { qty: null, state: null });
    assert.deepEqual(Object.keys(row).sort(), ["archived", "boardId", "createdAt", "groupId", "id", "position", "updatedAt", "values", "version", "workspaceId"].sort());
    assert.deepEqual((await call(secret, `/boards/${boardId}/records?columns=state,qty,state`)).body.items.find((r) => r.id === full.toHexString()).values, { qty: 12.5, state: "Done" }, "repeats and order don't matter");
  });

  test("only the requested fields are read from the database", async () => {
    const calls = app.db.collection(COLLECTIONS.records).calls;
    calls.length = 0;
    await call(secret, `/boards/${boardId}/columns/qty/values`);
    const { projection } = calls.find((c) => c.op === "find").options;
    assert.equal(projection["values.qty"], 1);
    assert.equal(Object.keys(projection).filter((k) => k.startsWith("values.")).length, 1);
  });

  test("every column type keeps its value and JSON type; never-set values are null, empty ones stay empty", async () => {
    for (const column of ALL_TYPES.filter((c) => c.visible !== false && c.type !== "group")) {
      const res = await call(secret, `/boards/${boardId}/records/${full}/columns/${column.key}`);
      assert.equal(res.status, 200, `${column.key}: ${res.text}`);
      const { updatedAt, ...cell } = res.body.value;
      assert.ok(updatedAt);
      assert.deepEqual(cell, { boardId, columnId: column.key, columnName: column.label, columnType: column.type, recordId: full.toHexString(), value: STORED[column.key] }, column.key);
    }
    const value = async (key) => (await call(secret, `/boards/${boardId}/records/${sparse}/columns/${key}`)).body.value.value;
    assert.deepEqual([await value("mail"), await value("one"), await value("qty"), await value("ok"), await value("many")], [null, "", null, null, null]);
  });

  test("the board's Group column gives the group's name, or null", async () => {
    const name = (await call(secret, `/boards/${boardId}/groups`)).body.items[0].name;
    assert.equal((await call(secret, `/boards/${boardId}/records/${full}/columns/grp`)).body.value.value, name);
    assert.equal((await call(secret, `/boards/${boardId}/records/${sparse}/columns/grp`)).body.value.value, null);
    assert.equal((await call(secret, `/boards/${boardId}/records?columns=grp`)).body.items.find((r) => r.id === full.toHexString()).values.grp, name);
  });

  test("column values are paged and filtered like records", async () => {
    const first = (await call(secret, `/boards/${boardId}/columns/serial/values?limit=1`)).body;
    assert.equal(first.items.length, 1);
    assert.deepEqual(Object.keys(first.items[0]).sort(), ["boardId", "columnId", "columnName", "columnType", "recordId", "updatedAt", "value"]);
    assert.ok(first.pagination.nextCursor);
    const second = (await call(secret, `/boards/${boardId}/columns/serial/values?limit=1&cursor=${first.pagination.nextCursor}`)).body;
    assert.deepEqual([first.items[0].value, second.items[0].value, second.pagination.nextCursor], ["Row", "Empty", null]);
    assert.deepEqual((await call(secret, `/boards/${boardId}/columns/serial/values?groupId=${groupId}`)).body.items.map((i) => i.value), ["Row"]);
    assert.equal((await call(secret, `/boards/${boardId}/columns/serial/values?updatedSince=2999-01-01T00:00:00Z`)).body.items.length, 0);
    assert.equal((await call(secret, `/boards/${boardId}/columns/serial/values?limit=501`)).status, 400);
    assert.equal((await call(secret, `/boards/${boardId}/columns/serial/values?columns=qty`)).status, 400);
  });

  test("a hidden column is available through every request, because hiding isn't a permission", async () => {
    assert.equal((await call(secret, `/boards/${boardId}/columns/secret`)).body.column.visible, false);
    assert.ok((await call(secret, `/boards/${boardId}/columns/secret/values`)).body.items.some((i) => i.value === "visible only by choice"));
    assert.equal((await call(secret, `/boards/${boardId}/records/${full}/columns/secret`)).body.value.value, "visible only by choice");
    assert.deepEqual((await call(secret, `/boards/${boardId}/records?columns=secret`)).body.items.find((r) => r.id === full.toHexString()).values, { secret: "visible only by choice" });
    assert.equal((await call(secret, `/records/${full}`)).body.record.values.secret, "visible only by choice");
    // Still only with access to the board.
    const other = await workspace("Hidden other");
    const outside = (await issue(people.admin, { ws: other.ws, boards: [other.one] })).body.secret;
    assert.equal((await call(outside, `/boards/${boardId}/columns/secret/values`)).status, 404);
    assert.equal((await call(null, `/boards/${boardId}/columns/secret/values`)).status, 401);
  });

  test("hostile column IDs never reach a query", async () => {
    const calls = app.db.collection(COLLECTIONS.records).calls;
    calls.length = 0;
    for (const bad of ["$where", "values.secret", "__proto__", "constructor", "a b", "qty,$gt", "", ",", "qty,", "%00"]) {
      assert.equal((await call(secret, `/boards/${boardId}/records?columns=${encodeURIComponent(bad)}`)).status, 400, `columns=${bad}`);
    }
    assert.equal((await call(secret, `/boards/${boardId}/records?columns=qty&columns=state`)).status, 400, "given twice");
    assert.equal((await call(secret, `/boards/${boardId}/records?columns[$ne]=x`)).status, 400, "an object");
    for (const bad of ["$where", "values.secret", "a%20b"]) assert.equal((await call(secret, `/boards/${boardId}/columns/${bad}/values`)).status, 400, bad);
    for (const bad of ["__proto__", "constructor", "toString"]) assert.ok([400, 404].includes((await call(secret, `/boards/${boardId}/columns/${bad}`)).status), bad);
    assert.equal(calls.filter((c) => c.op === "find").length, 0, "none of them ran a query on records");
  });

  test("knowing an ID grants nothing: no token, another board, another workspace, another board's record", async () => {
    const other = await workspace("Types other");
    const paths = [`/boards/${boardId}/columns/qty`, `/boards/${boardId}/columns/qty/values`, `/boards/${boardId}/records?columns=qty`, `/boards/${boardId}/records/${full}/columns/qty`];
    for (const url of paths) assert.equal((await call(null, url)).status, 401, url);
    const elsewhere = (await issue(people.admin, { ws: other.ws, boards: [other.one] })).body.secret;
    for (const url of paths) assert.equal((await call(elsewhere, url)).status, 404, url);
    const sameWorkspace = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body.secret;
    for (const url of paths) assert.equal((await call(sameWorkspace, url)).status, 404, url);
    assert.equal((await call(secret, `/boards/${f.one.board.id}/records/${full}/columns/status`)).status, 404, "a record of another board");
    assert.equal((await call(secret, `/boards/${boardId}/records/${other.one.records[0].id}/columns/qty`)).status, 404, "a record of another workspace");
    assert.equal((await call(secret, `/boards/${boardId}/records/nope/columns/qty`)).status, 400);
  });

  test("API Explorer: the caller's own session and access, the token API's format, no secrets", async () => {
    const url = `/api/v1/me/api-explorer/boards/${boardId}`;
    const res = await as(people.viewer, "GET", `${url}?columns=qty`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.columns, (await call(secret, `/boards/${boardId}/columns`)).body.items);
    assert.equal(res.body.columns.find((c) => c.id === "secret").visible, false);
    assert.deepEqual(res.body.example.items.find((r) => r.id === full.toHexString()).values, { qty: 12.5 });
    assert.ok(res.body.example.items.length <= 3 && res.body.example.pagination.limit === 3);
    assert.doesNotMatch(res.text, /jarc_[0-9a-f]{24}_|digest/);
    assert.equal((await as(people.outsider, "GET", url)).status, 404, "not a member");
    assert.equal((await new SessionClient(app.url, app.entra.appOrigin).request("GET", url)).status, 401);
    assert.equal((await fetch(`${app.url}${url}`, { headers: { Authorization: `Bearer ${secret}` } })).status, 401, "a token can't use it");
    assert.equal((await as(people.viewer, "GET", `${url}?columns=missing`)).status, 400);
    const browser = await browserOf(people.viewer);
    assert.equal((await browser.request("GET", url, undefined, { headers: { Authorization: "Bearer jarc_ignored" } })).status, 200, "it reads the session, never a bearer token");
    assert.equal((await as(people.viewer, "GET", `${url}?token=x`)).status, 400);
  });

  test("API Explorer previews match the token API exactly: the board with its groups, and one column's values", async () => {
    const url = `/api/v1/me/api-explorer/boards/${boardId}`;
    const plain = await as(people.viewer, "GET", url);
    assert.equal(plain.status, 200, plain.text);
    assert.deepEqual(plain.body.board, (await call(secret, `/boards/${boardId}`)).body.board, "the same board, columns and groups as GET /boards/:boardId");
    assert.equal(plain.body.values, undefined, "values only for exactly one chosen column");
    const one = await as(people.viewer, "GET", `${url}?columns=qty`);
    const viaToken = (await call(secret, `/boards/${boardId}/columns/qty/values`)).body.items;
    for (const entry of one.body.values.items) assert.deepEqual(entry, viaToken.find((v) => v.recordId === entry.recordId));
    assert.ok(one.body.values.items.length <= 3);
    assert.equal((await as(people.viewer, "GET", `${url}?columns=qty,state`)).body.values, undefined);
  });

  test("every employee sees the same board and column IDs, but only within their own access", async () => {
    const ids = async (person) => {
      const viaExplorer = await as(person, "GET", `/api/v1/me/api-explorer/boards/${boardId}`);
      const viaList = await as(person, "GET", `/api/v1/workspaces/${f.ws.id}/boards`);
      return { status: [viaExplorer.status, viaList.status], board: viaExplorer.body?.board?.id, columns: viaExplorer.body?.columns?.map((c) => c.id), listed: viaList.body?.items?.find((b) => b.id === boardId)?.columns.map((c) => c.key) };
    };
    const [admin, member, viewer] = [await ids(people.admin), await ids(people.member), await ids(people.viewer)];
    assert.deepEqual(admin.status, [200, 200]);
    assert.deepEqual(member, admin, "a member sees exactly what the admin sees");
    assert.deepEqual(viewer, admin, "and so does a viewer");
    assert.deepEqual(admin.columns, ALL_TYPES.map((c) => c.key), "the column IDs are the stored keys");
    assert.deepEqual(admin.listed, admin.columns);
    // Opening it again changes nothing: nothing is generated per person or per visit.
    assert.deepEqual(await ids(people.viewer), viewer);
    // Someone outside the workspace learns nothing, and an ID alone opens nothing.
    assert.deepEqual((await ids(people.outsider)).status, [404, 404]);
    assert.equal((await call(null, `/boards/${boardId}/records`)).status, 401);
    const outsiderWs = await as(people.sysadmin, "POST", "/api/v1/workspaces", { name: "Outsider's own" });
    await as(people.sysadmin, "POST", `/api/v1/workspaces/${outsiderWs.body.workspace.id}/members`, { userId: await userId(people.outsider), role: "VIEWER" });
    const ownBoard = (await as(people.sysadmin, "POST", `/api/v1/workspaces/${outsiderWs.body.workspace.id}/boards`, { name: "Own", columns: COLUMNS })).body.board;
    const theirs = (await issue(people.outsider, { ws: outsiderWs.body.workspace, boards: [{ board: ownBoard }] })).body.secret;
    assert.equal((await call(theirs, `/boards/${ownBoard.id}/records`)).status, 200, "their own token reads their own board");
    assert.equal((await call(theirs, `/boards/${boardId}/records`)).status, 404, "but not a board they only know the ID of");
    assert.equal((await call(theirs, `/boards/${boardId}/columns/qty/values`)).status, 404);
    assert.equal((await issue(people.outsider, { ws: f.ws, boards: [{ board: { id: boardId } }] })).status, 404, "nor can they issue one for it");
  });
});

describe("Pagination and incremental sync", () => {
  let f, secret, boardId, ids;
  before(async () => {
    f = await workspace("Pages");
    boardId = f.one.board.id;
    const now = Date.now();
    // Inserted directly: 1,050 synthetic records, all with the same timestamp for the hardest tie-break.
    const docs = Array.from({ length: 1050 }, (_, i) => ({ _id: new ObjectId(), workspaceId: new ObjectId(f.ws.id), boardId: new ObjectId(boardId), values: { serial: `R${i}` }, groupId: null, position: (i * 7919) % 1050, archived: i % 100 === 0, pinned: false, createdBy: null, updatedBy: null, createdAt: new Date(now), updatedAt: new Date(now), version: 1 }));
    await app.db.collection(COLLECTIONS.records).insertMany(docs);
    secret = (await issue(people.admin, { ws: f.ws, boards: [f.one, f.two] })).body.secret;
    ids = docs.map((d) => d._id.toHexString());
  });
  const readAll = async (q = "", limit = 137, change = null) => {
    const seen = []; let cursor = null, pages = 0;
    do {
      const res = await call(secret, `/boards/${boardId}/records?limit=${limit}${q}${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(res.status, 200, res.text);
      assert.ok(res.body.items.length <= limit);
      seen.push(...res.body.items);
      assert.equal(res.body.pagination.hasMore, res.body.pagination.nextCursor !== null);
      cursor = res.body.pagination.nextCursor;
      pages += 1;
      if (change && pages === 2) await change();
    } while (cursor);
    return seen;
  };

  test("the JavaScript example in the documentation really reads every record", async () => {
    const docs = fs.readFileSync(path.resolve(__dirname, "..", "..", "site", "assets", "ApiTokenDocs.js"), "utf8");
    const source = /const js = `([\s\S]*?)`;\r?\n/.exec(docs)[1].replaceAll("\\`", "`").replaceAll("\\$", "$").replaceAll("\\n", "\n").replace("${api}", `${app.url}/api/v1/external`);
    const allRecords = new Function("process", "fetch", "URL", "setTimeout", `${source}\nreturn allRecords;`)({ env: { JARC_API_TOKEN: secret } }, fetch, URL, setTimeout);
    const records = await allRecords(boardId);
    assert.equal(records.length, (await app.db.collection(COLLECTIONS.records).find({ boardId: new ObjectId(boardId), archived: false }).toArray()).length);
    assert.equal(new Set(records.map((r) => r.id)).size, records.length);
  });

  test("an empty cursor asks for the first page, for loops that always send one (Power Automate)", async () => {
    const first = (await call(secret, `/boards/${boardId}/records?limit=5`)).body, empty = (await call(secret, `/boards/${boardId}/records?limit=5&cursor=`)).body;
    assert.deepEqual(empty.items.map((r) => r.id), first.items.map((r) => r.id));
  });

  test("the default and maximum page sizes hold", async () => {
    const first = (await call(secret, `/boards/${boardId}/records`)).body;
    assert.deepEqual([first.items.length, first.pagination.limit], [100, 100]);
    assert.equal((await call(secret, `/boards/${boardId}/records?limit=500`)).body.items.length, 500);
  });

  test("every record comes exactly once, in the same order every time", async () => {
    const all = await readAll("&includeArchived=true", 137);
    const got = all.map((r) => r.id);
    assert.equal(got.length, 1052);
    assert.equal(new Set(got).size, 1052, "no duplicates");
    for (const id of ids) assert.ok(got.includes(id), "none missing");
    assert.deepEqual(got, [...got].sort(), "deterministic order");
    assert.deepEqual((await readAll("&includeArchived=true", 500)).map((r) => r.id), got, "the same whatever the page size");
  });

  test("archived records are left out unless asked for, and flagged when they are", async () => {
    const live = await readAll("", 500);
    assert.equal(live.length, 1052 - 11);
    assert.ok(live.every((r) => r.archived === false));
    assert.equal((await readAll("&includeArchived=true", 500)).filter((r) => r.archived).length, 11);
  });

  test("rows reordered, edited, added or removed during a read cause no duplicates or missing rows", async () => {
    const records = app.db.collection(COLLECTIONS.records);
    const firstIds = new Set();
    const added = new ObjectId();
    const all = await readAll("&includeArchived=true", 100, async () => {
      // Reorder everything, edit a row already read and one not yet read, delete one not yet read, add one.
      await records.updateMany({ boardId: new ObjectId(boardId) }, { $inc: { position: -5000 } });
      const sorted = [...ids].sort();
      await records.updateOne({ _id: new ObjectId(sorted[1]) }, { $set: { "values.serial": "edited", updatedAt: new Date() } });
      await records.updateOne({ _id: new ObjectId(sorted[900]) }, { $set: { "values.serial": "edited later", updatedAt: new Date() } });
      await records.deleteOne({ _id: new ObjectId(sorted[1000]) });
      firstIds.add(sorted[1000]);
      const now = new Date();
      await records.insertOne({ _id: added, workspaceId: new ObjectId(f.ws.id), boardId: new ObjectId(boardId), values: { serial: "new" }, groupId: null, position: 1, archived: false, pinned: false, createdAt: now, updatedAt: now, version: 1 });
    });
    const got = all.map((r) => r.id);
    assert.equal(new Set(got).size, got.length, "no duplicates");
    assert.ok(got.includes(added.toHexString()), "the new row is seen");
    assert.ok(!got.includes([...firstIds][0]), "the deleted row is gone");
    assert.equal(got.length, 1052, "1,052 − 1 removed + 1 added");
    assert.equal(all.find((r) => r.values.serial === "edited later")?.values.serial, "edited later");
  });

  test("updatedSince returns only later changes, in change order; a row edited mid-read comes again and nothing is lost", async () => {
    const records = app.db.collection(COLLECTIONS.records), board = new ObjectId(boardId);
    const since = new Date(Date.now() + 60000);
    const someRows = (await records.find({ boardId: board, archived: false }, { limit: 300 }).toArray()).map((r) => r._id);
    for (let i = 0; i < someRows.length; i++) await records.updateOne({ _id: someRows[i] }, { $set: { updatedAt: new Date(since.getTime() + (i % 5) * 1000) } });
    const later = new Date(since.getTime() + 100000);
    const all = await readAll(`&updatedSince=${encodeURIComponent(since.toISOString())}`, 40, async () => { await records.updateOne({ _id: someRows[0] }, { $set: { updatedAt: later } }); });
    const unique = new Set(all.map((r) => r.id));
    assert.equal(unique.size, someRows.length, "every changed row, none other");
    const times = all.map((r) => r.updatedAt);
    assert.deepEqual(times, [...times].sort(), "ordered by last change");
    assert.equal(all.filter((r) => r.id === someRows[0].toHexString()).length, 2, "the row edited during the read comes again, later");
    assert.deepEqual((await call(secret, `/boards/${boardId}/records?updatedSince=${encodeURIComponent(new Date(later.getTime() + 1000).toISOString())}`)).body.items, []);
  });

  test("groupId filters; cursors work only with the board and filters they came from", async () => {
    const records = app.db.collection(COLLECTIONS.records), board = new ObjectId(boardId);
    const group = (await call(secret, `/boards/${boardId}/groups`)).body.items[0].id;
    await records.updateOne({ boardId: board, archived: false }, { $set: { groupId: group } });
    const inGroup = (await call(secret, `/boards/${boardId}/records?groupId=${group}`)).body.items;
    assert.ok(inGroup.length >= 1 && inGroup.every((r) => r.groupId === group));
    assert.ok((await call(secret, `/boards/${boardId}/records?groupId=none&limit=500`)).body.items.every((r) => r.groupId === null));
    const { nextCursor } = (await call(secret, `/boards/${boardId}/records?limit=5`)).body.pagination;
    assert.equal((await call(secret, `/boards/${f.two.board.id}/records?cursor=${nextCursor}`)).status, 400, "another board");
    assert.equal((await call(secret, `/boards/${boardId}/records?cursor=${nextCursor}&updatedSince=2026-01-01T00:00:00Z`)).status, 400, "another order");
  });

  test("queries are bounded: every page has a limit, a time limit and is scoped to the board", async () => {
    const calls = app.db.collection(COLLECTIONS.records).calls;
    calls.length = 0;
    await call(secret, `/boards/${boardId}/records?limit=10`);
    const finds = calls.filter((c) => c.op === "find");
    assert.equal(finds.length, 1);
    assert.equal(finds[0].options.limit, 11);
    assert.ok(finds[0].options.maxTimeMS > 0);
    assert.equal(finds[0].filter.boardId.toHexString(), boardId);
  });
});

describe("Rate limits", () => {
  test("each token has its own limit, with headers and Retry-After; another token isn't affected", async () => {
    const limited = await startEntraApp({ issuer, apiTokens: { key: KEY, perMinute: 3 } });
    try {
      const f = await workspace("Limited", limited);
      const a = (await issue(people.admin, { ws: f.ws, boards: [f.one] }, limited)).body.secret, b = (await issue(people.admin, { ws: f.ws, boards: [f.one], name: "B" }, limited)).body.secret;
      for (const left of ["2", "1", "0"]) {
        const res = await call(a, "/me", { target: limited });
        assert.deepEqual([res.status, res.headers.get("x-ratelimit-limit"), res.headers.get("x-ratelimit-remaining")], [200, "3", left]);
      }
      const over = await call(a, "/me", { target: limited });
      assert.deepEqual([over.status, code(over)], [429, "RATE_LIMITED"]);
      assert.ok(Number(over.headers.get("retry-after")) >= 1);
      assert.equal((await call(b, "/me", { target: limited })).status, 200);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal((await limited.db.collection(COLLECTIONS.apiTokenAudit).find({ action: "token.rate_limited" }).toArray()).length, 1);
    } finally { await limited.close(); }
  });

  test("repeated failed attempts are slowed, without affecting a valid token", async () => {
    const guarded = await startEntraApp({ issuer, apiTokens: { key: KEY, failedAuth: { perWindow: 2, windowMs: 60000 } } });
    try {
      const f = await workspace("Guarded", guarded);
      const { secret } = (await issue(people.admin, { ws: f.ws, boards: [f.one] }, guarded)).body;
      assert.deepEqual([(await call("bad", "/me", { target: guarded })).status, (await call("bad", "/me", { target: guarded })).status, (await call("bad", "/me", { target: guarded })).status], [401, 401, 429]);
      assert.equal((await call(secret, "/me", { target: guarded })).status, 200);
    } finally { await guarded.close(); }
  });
});

describe("Off by default, and existing behaviour", () => {
  test("configuration: off unless asked for; needs Entra and a valid key; the key stays out of output", () => {
    const key = KEY.toString("base64");
    const off = loadConfig({});
    assert.deepEqual({ ...off.apiTokens }, { enabled: false, perMinute: 120 });
    const prod = (extra) => loadConfig(entraEnv({ NODE_ENV: "production", ...extra }));
    assert.equal(prod({}).apiTokens.enabled, false, "off in production unless switched on");
    assert.throws(() => prod({ JARC_FEATURE_API_TOKENS: "true" }), (e) => e instanceof ConfigError && /JARC_API_TOKEN_KEY/.test(e.message));
    assert.throws(() => loadConfig({ JARC_FEATURE_API_TOKENS: "true", JARC_API_TOKEN_KEY: key }), /AUTH_MODE=entra/);
    assert.throws(() => prod({ JARC_FEATURE_API_TOKENS: "yes", JARC_API_TOKEN_KEY: key }), /true or false/);
    assert.throws(() => prod({ JARC_FEATURE_API_TOKENS: "true", JARC_API_TOKEN_KEY: "short" }), /32 random bytes/);
    assert.throws(() => prod({ JARC_FEATURE_API_TOKENS: "true", JARC_API_TOKEN_KEY: key, JARC_API_TOKEN_RATE_PER_MINUTE: "1" }), /RATE_PER_MINUTE/);
    const on = prod({ JARC_FEATURE_API_TOKENS: "true", JARC_API_TOKEN_KEY: key, JARC_API_TOKEN_RATE_PER_MINUTE: "300" });
    assert.deepEqual([on.apiTokens.enabled, on.apiTokens.perMinute, on.apiTokens.key.equals(KEY)], [true, 300, true]);
    assert.ok(!JSON.stringify(on).includes(key), "the key isn't in the config's JSON");
  });

  test("switched off: the paths don't exist, the browser is told so, and sign-in works as before", async () => {
    const off = await startEntraApp({ issuer });
    try {
      const anonymous = await fetch(`${off.url}/api/v1/external/me`, { headers: { Authorization: "Bearer jarc_x" } });
      assert.equal(anonymous.status, 401, "like any unknown path without a session");
      const browser = await browserOf(people.admin, off);
      assert.equal((await browser.request("GET", "/api/v1/external/me")).status, 404);
      assert.equal((await browser.request("GET", "/api/v1/me/api-tokens")).status, 404);
      assert.equal((await browser.request("GET", "/api/v1/features")).body.features.apiTokens, undefined, "the response is exactly what it was before this feature");
      assert.equal((await browser.request("GET", "/api/v1/auth/session")).status, 200);
    } finally { await off.close(); }
    assert.equal((await as(people.admin, "GET", "/api/v1/features")).body.features.apiTokens, true);
  });

  test("switched off: nothing is added to the database, not even the index", async () => {
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => new FakeMongoClient() });
    await connection.connect();
    await ensureDatabase(connection.db, { features: { nativeForms: false, spreadsheetImports: false, apiTokens: false } });
    const names = (await connection.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    for (const name of FEATURE_COLLECTIONS.apiTokens) assert.ok(!names.includes(name), name);
    assert.ok(!(await connection.db.collection("records").listIndexes().toArray()).some((i) => i.name === "board_id"));
    await ensureDatabase(connection.db, { features: { nativeForms: false, spreadsheetImports: false, apiTokens: true } });
    assert.ok((await connection.db.collection("records").listIndexes().toArray()).some((i) => i.name === "board_id"));
    assert.ok((await connection.db.collection("apiTokens").listIndexes().toArray()).some((i) => i.name === "uniq_public_id" && i.unique));
  });

  test("session routes with the same names answer as they always did", async () => {
    const f = await workspace("Existing");
    const session = await as(people.admin, "GET", `/api/v1/boards/${f.one.board.id}`);
    assert.equal(session.status, 200);
    assert.ok(Array.isArray(session.body.board.savedViews), "the session API's shape is unchanged");
    assert.equal((await as(people.member, "POST", `/api/v1/boards/${f.one.board.id}/records`, { values: { serial: "Still works" } })).status, 201);
  });

  test("the documentation is accurate and holds no credentials", () => {
    const docs = fs.readFileSync(path.resolve(__dirname, "..", "..", "site", "assets", "ApiTokenDocs.js"), "utf8");
    const routes = fs.readFileSync(path.resolve(__dirname, "..", "src", "routes", "external-api.js"), "utf8");
    for (const route of ["/me", "/workspaces", "/workspaces/:workspaceId/boards", "/boards/:boardId", "/boards/:boardId/columns", "/boards/:boardId/columns/:columnId", "/boards/:boardId/columns/:columnId/values", "/boards/:boardId/groups", "/boards/:boardId/records", "/boards/:boardId/records/:recordId/columns/:columnId", "/records/:recordId"]) {
      assert.ok(docs.includes(`GET ${route}`), `documented: ${route}`);
      assert.ok(routes.includes(`router.get("${route}"`), `exists: ${route}`);
    }
    for (const phrase of ["Power Query M", "Do until", "HTTP Request node", "secure backend", "curl -H", "X-RateLimit-Remaining", "Retry-After", "TOKEN_EXPIRED", "TOKEN_REVOKED", "updatedSince", "nextCursor"]) assert.ok(docs.includes(phrase), phrase);
    assert.doesNotMatch(docs, /jarc_[0-9a-f]{24}_/, "no real-looking token");
    assert.doesNotMatch(docs, /railway\.app|mongodb(\+srv)?:\/\//i);
  });
});

describe("Token secrets are never kept or logged", () => {
  test("after creating, using, failing, rotating and revoking, no stored document and no log line holds a secret", async () => {
    const lines = [], methods = ["log", "info", "warn", "error", "debug"], real = Object.fromEntries(methods.map((m) => [m, console[m]]));
    const stdout = process.stdout.write, stderr = process.stderr.write;
    const capture = (original) => function write(chunk, ...rest) { lines.push(String(chunk)); return original.call(this, chunk, ...rest); };
    for (const m of methods) console[m] = (...args) => { lines.push(args.map(String).join(" ")); };
    process.stdout.write = capture(stdout); process.stderr.write = capture(stderr);
    const logged = app.logger.errors.length;
    let secrets = [];
    try {
      const f = await workspace("Plaintext");
      const a = (await issue(people.admin, { ws: f.ws, boards: [f.one] })).body;
      await call(a.secret, "/me");
      await call(`${a.secret.slice(0, -3)}zzz`, "/me");
      await call(a.secret, `/records/${f.one.records[0].id}?token=${a.secret}`);
      // An unexpected failure is logged with the request's path: its query must not be.
      app.fake.failNext({ collection: COLLECTIONS.boards, op: "find" });
      assert.ok((await call(a.secret, `/boards/${f.one.board.id}?includeArchived=true`)).status >= 500, "the failure happened");
      const b = (await as(people.admin, "POST", `/api/v1/me/api-tokens/${a.token.id}/rotate`, { graceHours: 0 })).body;
      await as(people.admin, "POST", `/api/v1/me/api-tokens/${b.token.id}/revoke`, {});
      await call(b.secret, "/me");
      secrets = [a.secret, b.secret];
      assert.equal((await as(people.admin, "GET", "/api/v1/me/api-tokens")).text.includes(a.secret), false);
    } finally {
      for (const m of methods) console[m] = real[m];
      process.stdout.write = stdout; process.stderr.write = stderr;
    }
    const stored = [...app.connection.db.collections.values()].map((c) => JSON.stringify(c.docs)).join("\n");
    const output = [...lines, ...app.logger.errors.slice(logged)].join("\n");
    for (const secret of secrets) {
      const part = secret.split("_").slice(2).join("_");
      for (const [where, text] of [["the database", stored], ["the logs", output]]) {
        assert.ok(!text.includes(secret), `the token in ${where}`);
        assert.ok(!text.includes(part), `the secret part in ${where}`);
      }
    }
    const doc = await app.db.collection(COLLECTIONS.apiTokens).findOne({ publicId: publicIdOf(secrets[0]) });
    assert.match(doc.digest, /^[0-9a-f]{64}$/, "a keyed digest is all that's stored");
    assert.notEqual(doc.digest, crypto.createHash("sha256").update(secrets[0]).digest("hex"), "not a plain hash");
  });
});

describe("Isolation of this test", () => {
  test("it ran on the in-memory fake database, never a real one", () => {
    assert.ok(app.fake instanceof FakeMongoClient);
    assert.equal(app.connection.uri, "mongodb://fake.invalid");
  });
});
