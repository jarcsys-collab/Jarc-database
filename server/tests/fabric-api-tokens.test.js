// Fabric Data API tokens: issued, listed and revoked by Fabric API administrators only, stored like board tokens (same collection,
// digest, prefix, expiry and audit) with product "fabric", and used only on /external/fabric with a stub data router. The real app
// with Entra sign-in on the fake MongoDB, synthetic data only: it never connects to a real database. The Fabric routers are
// composed in front of the app here exactly as app.js will mount them (the session router after `identify`, the token router
// before the board token API).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const { ObjectId } = require("mongodb");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { digestOf, publicIdOf } = require("../src/auth/api-token");
const { COLLECTIONS } = require("../src/db/bootstrap");
const { sessionAuthentication } = require("../src/auth/session");
const { errorHandler } = require("../src/middleware/errors");
const { fabricApiTokenRoutes } = require("../src/routes/fabric-api-tokens");
const { externalFabricRoutes } = require("../src/routes/external-fabric");
const { FabricTokenService } = require("../src/services/api-token-service");

const KEY = crypto.randomBytes(32);
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();
const code = (res) => res.body?.error?.code;
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

const SALES = "fabric.sales.read", INVENTORY = "fabric.inventory.read", SENSITIVE = "fabric.sensitive.read";

// The permission lists as config would hold them (FABRIC_DATA_READER_OIDS etc.), mutable so tests can change them.
function permissionsFor(tenantId) {
  const lists = { readers: new Set(), sensitiveReaders: new Set(), admins: new Set(), oversight: new Set() };
  const ok = (identity, ...sets) => Boolean(identity?.kind === "entra" && identity.tenantId === tenantId && typeof identity.entraObjectId === "string" && sets.every((s) => s.has(identity.entraObjectId.toLowerCase())));
  return { lists, permissions: { isApiAdmin: (id) => ok(id, lists.readers, lists.admins), isApiOversight: (id) => ok(id, lists.readers, lists.admins, lists.oversight), isReader: (id) => ok(id, lists.readers), isSensitiveReader: (id) => ok(id, lists.readers, lists.sensitiveReaders) } };
}

// A stub of the shared fabricDataRouter: it reads only req.fabricAccess and echoes it (datasets as an array). The dataset routes
// refuse a dataset the caller can't read, as the real router does.
const echo = (access) => ({ ...access, datasets: [...access.datasets] });
function stubDataRouter() {
  const router = express.Router();
  router.use((req, res, next) => (req.fabricAccess ? next() : res.status(401).json({ error: { code: "UNAUTHENTICATED" } })));
  router.get("/status", (req, res) => res.status(200).set("Cache-Control", "no-store").json({ available: true, access: echo(req.fabricAccess) }));
  router.get("/:dataset/records", (req, res) => (["sales", "inventory"].includes(req.params.dataset) && req.fabricAccess.datasets.has(req.params.dataset)
    ? res.status(200).json({ dataset: req.params.dataset, access: echo(req.fabricAccess) })
    : res.status(403).json({ error: { code: "INSUFFICIENT_SCOPE" } })));
  return router;
}

async function startFabric({ issuer, accessPolicy } = {}) {
  const started = await startEntraApp({ issuer, apiTokens: { key: KEY, issuePerHour: 1000, maxActive: 1000 }, ...(accessPolicy ? { accessPolicy } : {}) });
  const tokens = started.dataLayer.services.apiTokens; // configured by createApp
  const { lists, permissions } = permissionsFor(started.entra.tenantId);
  const identify = sessionAuthentication({ sessions: started.dataLayer.repos.sessions, users: started.dataLayer.repos.users, entra: started.entra, accountMode: "off" });
  const outer = express();
  // Issuing is limited per administrator (20 an hour by default); this file issues more than that, so the limit is lifted here.
  outer.use("/api/v1/fabric/api-tokens", express.json(), identify, fabricApiTokenRoutes({ tokens, fabricPermissions: permissions, limiter: () => true }));
  outer.use("/api/v1/external/fabric-limited", externalFabricRoutes({ tokens, fabricPermissions: permissions, fabricDataRouter: stubDataRouter(), rate: { perWindow: 3, windowMs: 60 * 1000 } }));
  outer.use("/api/v1/external/fabric", externalFabricRoutes({ tokens, fabricPermissions: permissions, fabricDataRouter: stubDataRouter(), rate: { perWindow: 1000, windowMs: 60 * 1000 } }));
  outer.use(started.app);
  outer.use(errorHandler(started.logger));
  const server = await new Promise((resolve) => { const s = outer.listen(0, "127.0.0.1", () => resolve(s)); });
  server.keepAliveTimeout = 30000;
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = new Map();
  const browserOf = async (person) => {
    if (!clients.has(person.name)) { const c = new SessionClient(url, started.entra.appOrigin); assert.equal((await c.signIn(person)).status, 201); clients.set(person.name, c); }
    return clients.get(person.name);
  };
  const as = async (person, method, path, body, options) => (await browserOf(person)).request(method, path, body, options);
  return { ...started, url, lists, permissions, tokens, as, browserOf, close: async () => { await new Promise((resolve) => server.close(resolve)); await started.close(); } };
}

// Requests from an integration: no cookie, no CSRF token, no Origin.
async function call(target, token, path, { method = "GET", headers = {} } = {}) {
  const res = await fetch(`${target.url}/api/v1/external${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, text };
}

let app, issuer, people;
const grant = (list, ...persons) => { for (const p of persons) app.lists[list].add(p.oid.toLowerCase()); };
const revokeFrom = (list, ...persons) => { for (const p of persons) app.lists[list].delete(p.oid.toLowerCase()); };
const issue = (person, { name = "Fabric BI", scopes = [SALES], expiresAt = inDays(30), ...rest } = {}) => app.as(person, "POST", "/api/v1/fabric/api-tokens", { name, scopes, expiresAt, ...rest });
const userIdOf = async (person) => (await app.as(person, "GET", "/api/v1/me")).body.user.id;

before(async () => {
  issuer = await createTokenIssuer();
  app = await startFabric({ issuer });
  people = {
    admin: issuer.person("Fay Admin"), adminPlain: issuer.person("Nico Admin"), reader: issuer.person("Rhea Reader"),
    jarcApiAdmin: issuer.person("Jay Boards", { admin: true }), outsider: issuer.person("Olive Outsider")
  };
  grant("readers", people.admin, people.adminPlain, people.reader);
  grant("sensitiveReaders", people.admin, people.reader);
  grant("admins", people.admin, people.adminPlain);
  // people.admin also has oversight of every Fabric token (FABRIC_API_OVERSIGHT_OIDS); adminPlain manages only its own.
  grant("oversight", people.admin);
  // jarcApiAdmin is a JARC API administrator (JARC_API_ADMIN_OIDS) and holds JARC.Admin, but is in no Fabric list.
  app.tokens.adminObjectIds = Object.freeze([people.jarcApiAdmin.oid.toLowerCase()]);
  for (const p of Object.values(people)) await app.browserOf(p);
});
after(async () => { await app.close(); });

describe("Fabric API token management (session)", () => {
  test("only Fabric API administrators may list, issue, revoke or read activity", async () => {
    const own = await issue(people.admin);
    assert.equal(own.status, 201, own.text);
    for (const person of [people.reader, people.jarcApiAdmin, people.outsider]) {
      for (const [method, path, body] of [["GET", "/api/v1/fabric/api-tokens"], ["GET", "/api/v1/fabric/api-tokens/activity"], ["POST", "/api/v1/fabric/api-tokens", { name: "x", scopes: [SALES], expiresAt: inDays(5) }], ["POST", `/api/v1/fabric/api-tokens/${own.body.token.id}/revoke`]]) {
        const res = await app.as(person, method, path, body);
        assert.equal(res.status, 403, `${person.name} ${method} ${path}`);
        assert.equal(code(res), "FABRIC_API_ADMIN_REQUIRED");
        assert.equal(res.headers.get("cache-control"), "no-store");
      }
    }
    // Not signed in at all, or presenting the token itself instead of a session.
    const anonymous = await fetch(`${app.url}/api/v1/fabric/api-tokens`);
    assert.equal(anonymous.status, 401);
    const withToken = await fetch(`${app.url}/api/v1/fabric/api-tokens`, { headers: { Authorization: `Bearer ${own.body.secret}` } });
    assert.equal(withToken.status, 401);
    // The token is untouched by the refused revokes.
    assert.equal((await app.db.collection(COLLECTIONS.apiTokens).findOne({ _id: new ObjectId(own.body.token.id) })).revokedAt, null);
  });

  test("issuing: the secret is shown once and only a keyed digest is stored, with product fabric and no workspace", async () => {
    const res = await issue(people.adminPlain, { name: "Power BI Fabric", description: "Nightly refresh" });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const { token, secret } = res.body;
    assert.match(secret, /^jarc_[0-9a-f]{24}_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(Object.keys(token).sort(), ["createdAt", "description", "expiresAt", "id", "lastUsedAt", "name", "owner", "prefix", "requestCount", "revokedAt", "revokedBy", "scopes", "sensitive", "status", "datasets", "mine"].sort());
    assert.equal(token.mine, true);
    assert.equal(token.status, "active");
    assert.deepEqual(token.scopes, [SALES]);
    assert.deepEqual(token.datasets, ["sales"]);
    assert.equal(token.sensitive, false);
    assert.equal(token.owner.id, await userIdOf(people.adminPlain));
    const stored = await app.db.collection(COLLECTIONS.apiTokens).findOne({ _id: new ObjectId(token.id) });
    assert.equal(stored.product, "fabric");
    assert.deepEqual(stored.boardIds, []);
    assert.deepEqual(stored.scopes, [SALES]);
    assert.equal(stored.workspaceId, undefined);
    assert.equal(stored.workspaceIds, undefined);
    assert.equal(stored.digest, digestOf(KEY, secret));
    assert.equal(stored.publicId, publicIdOf(secret));
    assert.equal(token.prefix, `jarc_${stored.publicId.slice(0, 8)}`);
    const secretPart = secret.slice(30);
    for (let i = 0; i + 16 <= secretPart.length; i += 8) assert.ok(!JSON.stringify(stored).includes(secretPart.slice(i, i + 16)), "no part of the secret is stored");

    const list = await app.as(people.admin, "GET", "/api/v1/fabric/api-tokens");
    assert.equal(list.status, 200);
    assert.ok(list.body.tokens.some((t) => t.id === token.id && t.name === "Power BI Fabric" && t.description === "Nightly refresh"));
    assert.ok(!list.text.includes(secret) && !list.text.includes(stored.digest));
    const audit = await app.db.collection(COLLECTIONS.apiTokenAudit).find({ tokenId: stored._id }).toArray();
    assert.deepEqual(audit.map((a) => [a.action, a.product]), [["token.created", "fabric"]]);
    assert.ok(!JSON.stringify(audit).includes(secret) && !JSON.stringify(audit).includes(stored.digest));
    const activity = await app.as(people.admin, "GET", "/api/v1/fabric/api-tokens/activity");
    assert.ok(activity.body.items.some((e) => e.action === "token.created" && e.token.id === token.id && e.token.prefix === token.prefix));
    assert.ok(!activity.text.includes(secret));
  });

  test("the request is validated: Fabric scopes only, a bounded expiry, no board or workspace fields", async () => {
    const bad = async (body, pattern) => { const res = await issue(people.admin, body); assert.equal(res.status, 400, res.text); assert.match(res.body.error.message, pattern); };
    const scopeMessage = /fabric\.sales\.read.*fabric\.inventory\.read/;
    // No dataset scope at all.
    await bad({ scopes: [] }, scopeMessage);
    await bad({ scopes: [SENSITIVE] }, scopeMessage);
    // Unknown scopes, the board scope and the earlier fabric_data.* names.
    await bad({ scopes: ["read"] }, scopeMessage);
    await bad({ scopes: [SALES, "read"] }, scopeMessage);
    await bad({ scopes: ["fabric_data.read"] }, scopeMessage);
    await bad({ scopes: ["fabric_data.read", "fabric_data.read_cost"] }, scopeMessage);
    await bad({ scopes: [SALES, "fabric_data.read_cost"] }, scopeMessage);
    await bad({ scopes: ["fabric.purchases.read"] }, scopeMessage);
    await bad({ scopes: ["FABRIC.SALES.READ"] }, scopeMessage);
    await bad({ scopes: [SALES, "fabric.sales.write"] }, scopeMessage);
    // Repeats, wrong types.
    await bad({ scopes: [SALES, SALES] }, scopeMessage);
    await bad({ scopes: [INVENTORY, SENSITIVE, SENSITIVE] }, scopeMessage);
    await bad({ scopes: SALES }, scopeMessage);
    await bad({ scopes: [SALES, 1] }, scopeMessage);
    await bad({ scopes: null }, scopeMessage);
    await bad({ expiresAt: inDays(-1) }, /future/);
    await bad({ expiresAt: inDays(5 * 366 + 2) }, /5 years/);
    await bad({ name: " " }, /name/);
    await bad({ boardIds: [] }, /boardIds/);
    await bad({ workspaceId: new ObjectId().toHexString() }, /workspaceId/);
    await bad({ product: "board" }, /product/);
  });

  test("dataset scopes: sales only, inventory only or both, stored in a fixed order", async () => {
    for (const [scopes, stored, datasets] of [[[SALES], [SALES], ["sales"]], [[INVENTORY], [INVENTORY], ["inventory"]], [[INVENTORY, SALES], [SALES, INVENTORY], ["sales", "inventory"]]]) {
      const res = await issue(people.adminPlain, { scopes });
      assert.equal(res.status, 201, res.text);
      assert.deepEqual(res.body.token.scopes, stored);
      assert.deepEqual(res.body.token.datasets, datasets);
      assert.equal(res.body.token.sensitive, false);
      assert.deepEqual((await app.db.collection(COLLECTIONS.apiTokens).findOne({ _id: new ObjectId(res.body.token.id) })).scopes, stored);
    }
  });

  test("sensitive access needs a dataset scope and an administrator who can read sensitive fields", async () => {
    for (const scopes of [[SALES, SENSITIVE], [SENSITIVE, INVENTORY], [SALES, INVENTORY, SENSITIVE]]) {
      const refused = await issue(people.adminPlain, { scopes });
      assert.equal(refused.status, 403, refused.text);
      assert.equal(code(refused), "FABRIC_SENSITIVE_ACCESS_REQUIRED");
    }
    // Without a dataset scope it is invalid whoever asks.
    assert.equal((await issue(people.admin, { scopes: [SENSITIVE] })).status, 400);
    const granted = await issue(people.admin, { scopes: [SENSITIVE, INVENTORY] });
    assert.equal(granted.status, 201, granted.text);
    assert.deepEqual(granted.body.token.scopes, [INVENTORY, SENSITIVE]);
    assert.deepEqual(granted.body.token.datasets, ["inventory"]);
    assert.equal(granted.body.token.sensitive, true);
    const both = await issue(people.admin, { scopes: [SENSITIVE, INVENTORY, SALES] });
    assert.equal(both.status, 201, both.text);
    assert.deepEqual(both.body.token.scopes, [SALES, INVENTORY, SENSITIVE]);
    assert.deepEqual(both.body.token.datasets, ["sales", "inventory"]);
    const listed = (await app.as(people.admin, "GET", "/api/v1/fabric/api-tokens")).body.tokens.find((t) => t.id === both.body.token.id);
    assert.deepEqual([listed.datasets, listed.sensitive], [["sales", "inventory"], true]);
  });

  test("changes need the session's CSRF token", async () => {
    const client = await app.browserOf(people.admin);
    const res = await client.request("POST", "/api/v1/fabric/api-tokens", { name: "x", scopes: [SALES], expiresAt: inDays(5) }, { csrf: null });
    assert.equal(res.status, 403);
    assert.equal(code(res), "CSRF_INVALID");
  });

  test("revoking any Fabric token is recorded; a board token's ID is not found here", async () => {
    const made = await issue(people.adminPlain);
    const res = await app.as(people.admin, "POST", `/api/v1/fabric/api-tokens/${made.body.token.id}/revoke`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.token.status, "revoked");
    assert.equal(res.body.token.revokedBy.id, await userIdOf(people.admin));
    const again = await app.as(people.admin, "POST", `/api/v1/fabric/api-tokens/${made.body.token.id}/revoke`);
    assert.equal(again.status, 200);
    const audit = await app.db.collection(COLLECTIONS.apiTokenAudit).find({ tokenId: new ObjectId(made.body.token.id), action: "token.revoked" }).toArray();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].product, "fabric");
    assert.equal(code(await call(app, made.body.secret, "/fabric/status")), "TOKEN_REVOKED");
    assert.equal((await app.as(people.admin, "POST", `/api/v1/fabric/api-tokens/${new ObjectId().toHexString()}/revoke`)).status, 404);
    assert.equal((await app.as(people.admin, "POST", "/api/v1/fabric/api-tokens/not-an-id/revoke")).status, 400);
    assert.equal((await app.as(people.admin, "DELETE", `/api/v1/fabric/api-tokens/${made.body.token.id}`)).status, 404);
  });
});

describe("The Fabric token API (/external/fabric)", () => {
  test("a Fabric token reaches the data router with the right access, and its use is recorded", async () => {
    const plain = (await issue(people.admin)).body, sensitive = (await issue(people.admin, { scopes: [SALES, INVENTORY, SENSITIVE] })).body;
    const res = await call(app, plain.secret, "/fabric/status");
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.access, { datasets: ["sales"], sensitive: false, cost: false, via: "token", tokenId: plain.token.id });
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(res.headers.get("x-ratelimit-limit") && res.headers.get("x-ratelimit-remaining") && res.headers.get("x-ratelimit-reset"));
    assert.equal(res.headers.get("www-authenticate"), null);
    const full = await call(app, sensitive.secret, "/fabric/status");
    assert.deepEqual(full.body.access, { datasets: ["sales", "inventory"], sensitive: true, cost: true, via: "token", tokenId: sensitive.token.id });
    const stored = await app.db.collection(COLLECTIONS.apiTokens).findOne({ _id: new ObjectId(plain.token.id) });
    assert.ok(stored.lastUsedAt instanceof Date && stored.requestCount >= 1);
    // Unknown Fabric paths answer a JSON 404 and never reach the board API.
    const unknown = await call(app, plain.secret, "/fabric/me");
    assert.equal(unknown.status, 404);
    assert.equal(code(unknown), "NOT_FOUND");
  });

  test("each token reads only its datasets; a stored token without a dataset scope is refused", async () => {
    const sales = (await issue(people.admin, { scopes: [SALES] })).body, inventory = (await issue(people.admin, { scopes: [INVENTORY, SENSITIVE] })).body;
    const salesRead = await call(app, sales.secret, "/fabric/sales/records");
    assert.equal(salesRead.status, 200, salesRead.text);
    assert.deepEqual(salesRead.body.access.datasets, ["sales"]);
    assert.equal(code(await call(app, sales.secret, "/fabric/inventory/records")), "INSUFFICIENT_SCOPE");
    const inventoryRead = await call(app, inventory.secret, "/fabric/inventory/records");
    assert.equal(inventoryRead.status, 200, inventoryRead.text);
    assert.deepEqual([inventoryRead.body.access.datasets, inventoryRead.body.access.sensitive], [["inventory"], true]);
    assert.equal(code(await call(app, inventory.secret, "/fabric/sales/records")), "INSUFFICIENT_SCOPE");

    // Documents that could only come from outside the API: no dataset scope, or the earlier names, are refused at use.
    const made = (await issue(people.admin, { scopes: [SALES] })).body;
    for (const scopes of [[SENSITIVE], ["fabric_data.read", "fabric_data.read_cost"], [], ["read"]]) {
      await app.db.collection(COLLECTIONS.apiTokens).updateOne({ _id: new ObjectId(made.token.id) }, { $set: { scopes } });
      const res = await call(app, made.secret, "/fabric/status");
      assert.equal(res.status, 403, JSON.stringify(scopes));
      assert.equal(code(res), "INSUFFICIENT_SCOPE");
    }
  });

  test("authorize() returns the datasets as a Set and sensitive only with the scope and the owner's access", async () => {
    const fabric = new FabricTokenService({ tokens: app.tokens, permissions: app.permissions });
    const ownerUserId = new ObjectId(await userIdOf(people.admin)), plainOwner = new ObjectId(await userIdOf(people.adminPlain));
    const doc = (scopes, owner = ownerUserId) => ({ _id: new ObjectId(), product: "fabric", ownerUserId: owner, scopes });
    const result = async (d) => { const r = await fabric.authorize(d); return { datasets: [...r.datasets], sensitive: r.sensitive, isSet: r.datasets instanceof Set }; };
    assert.deepEqual(await result(doc([SALES])), { datasets: ["sales"], sensitive: false, isSet: true });
    assert.deepEqual(await result(doc([INVENTORY])), { datasets: ["inventory"], sensitive: false, isSet: true });
    assert.deepEqual(await result(doc([SALES, INVENTORY, SENSITIVE])), { datasets: ["sales", "inventory"], sensitive: true, isSet: true });
    // The scope without the owner's sensitive access gives nothing sensitive.
    assert.deepEqual(await result(doc([SALES, SENSITIVE], plainOwner)), { datasets: ["sales"], sensitive: false, isSet: true });
    for (const bad of [doc([SENSITIVE]), doc(["fabric_data.read"]), doc(undefined), { ...doc([SALES]), product: undefined }]) {
      await assert.rejects(fabric.authorize(bad), (error) => error.status === 403 && error.code === "INSUFFICIENT_SCOPE");
    }
  });

  test("board tokens are refused on Fabric routes, and Fabric tokens on board routes", async () => {
    const ws = (await app.as(people.jarcApiAdmin, "POST", "/api/v1/workspaces", { name: "Synthetic" })).body.workspace;
    const board = (await app.as(people.jarcApiAdmin, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Alpha", columns: [{ key: "serial", label: "Item", type: "text" }] })).body.board;
    const boardToken = await app.as(people.jarcApiAdmin, "POST", "/api/v1/me/api-tokens", { name: "Board BI", workspaceId: ws.id, boardIds: [board.id], scopes: ["read"], expiresAt: inDays(30) });
    assert.equal(boardToken.status, 201, boardToken.text);
    const onFabric = await call(app, boardToken.body.secret, "/fabric/status");
    assert.equal(onFabric.status, 403);
    assert.equal(code(onFabric), "INSUFFICIENT_SCOPE");
    assert.equal((await call(app, boardToken.body.secret, "/me")).status, 200, "the board token still works on the board API");

    const fabric = (await issue(people.admin)).body;
    for (const path of ["/me", "/workspaces", `/boards/${board.id}`, `/workspaces/${ws.id}/boards`]) {
      const res = await call(app, fabric.secret, path);
      assert.equal(res.status, 403, path);
      assert.equal(code(res), "INSUFFICIENT_SCOPE");
    }

    // The board screens never see Fabric tokens or their activity, and can't revoke or rotate them.
    const list = await app.as(people.jarcApiAdmin, "GET", "/api/v1/me/api-tokens");
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((t) => t.id === boardToken.body.token.id));
    const fabricIds = new Set((await app.db.collection(COLLECTIONS.apiTokens).find({ product: "fabric" }).toArray()).map((d) => d._id.toHexString()));
    assert.ok(fabricIds.size >= 3);
    assert.ok(list.body.items.every((t) => !fabricIds.has(t.id)));
    const activity = await app.as(people.jarcApiAdmin, "GET", "/api/v1/me/api-tokens/activity");
    assert.ok(activity.body.items.length >= 1 && activity.body.items.every((e) => !e.token || !fabricIds.has(e.token.id)));
    assert.equal((await app.as(people.jarcApiAdmin, "POST", `/api/v1/me/api-tokens/${fabric.token.id}/revoke`)).status, 404);
    assert.equal((await app.db.collection(COLLECTIONS.apiTokens).findOne({ _id: new ObjectId(fabric.token.id) })).revokedAt, null);
    assert.equal((await app.as(people.jarcApiAdmin, "POST", `/api/v1/me/api-tokens/${fabric.token.id}/rotate`, {})).status, 404);
    // And the Fabric list holds only Fabric tokens.
    const fabricList = await app.as(people.admin, "GET", "/api/v1/fabric/api-tokens");
    assert.ok(fabricList.body.tokens.every((t) => fabricIds.has(t.id)));
    assert.ok(!fabricList.body.tokens.some((t) => t.id === boardToken.body.token.id));
    // The per-owner active count is per product.
    const owner = new ObjectId(await userIdOf(people.admin)), now = new Date();
    const fabricCount = await app.dataLayer.repos.apiTokens.countActive(owner, now, { product: "fabric" });
    assert.ok(fabricCount >= 3);
    assert.equal(await app.dataLayer.repos.apiTokens.countActive(owner, now), 0);
    const boardOwner = new ObjectId(await userIdOf(people.jarcApiAdmin));
    assert.equal(await app.dataLayer.repos.apiTokens.countActive(boardOwner, now), 1);
    assert.equal(await app.dataLayer.repos.apiTokens.countActive(boardOwner, now, { product: "fabric" }), 0);
  });

  test("revoked, expired and invalid Fabric tokens are refused with 401", async () => {
    const made = (await issue(people.admin)).body;
    await app.as(people.admin, "POST", `/api/v1/fabric/api-tokens/${made.token.id}/revoke`);
    const revoked = await call(app, made.secret, "/fabric/status");
    assert.equal(revoked.status, 401);
    assert.equal(code(revoked), "TOKEN_REVOKED");
    const later = (await issue(people.admin)).body;
    await app.db.collection(COLLECTIONS.apiTokens).updateOne({ _id: new ObjectId(later.token.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await call(app, later.secret, "/fabric/status");
    assert.equal(expired.status, 401);
    assert.equal(code(expired), "TOKEN_EXPIRED");
    const listed = (await app.as(people.admin, "GET", "/api/v1/fabric/api-tokens")).body.tokens;
    assert.equal(listed.find((t) => t.id === later.token.id).status, "expired");
    assert.equal((await call(app, null, "/fabric/status")).status, 401);
    assert.equal(code(await call(app, "jarc_nope", "/fabric/status")), "INVALID_TOKEN");
    assert.equal(code(await call(app, `${made.secret.slice(0, -2)}xx`, "/fabric/status")), "INVALID_TOKEN");
    await tick();
    const audit = await app.db.collection(COLLECTIONS.apiTokenAudit).find({ tokenId: new ObjectId(later.token.id), action: "token.use_refused" }).toArray();
    assert.deepEqual(audit.map((a) => [a.reason, a.product]), [["expired", "fabric"]]);
  });

  test("the owner's Fabric access is checked on every use: removed readers stop it, lost sensitive access drops the flag", async () => {
    const owner = issuer.person("Otis Owner");
    grant("readers", owner); grant("sensitiveReaders", owner); grant("admins", owner);
    await app.browserOf(owner);
    const made = (await issue(owner, { scopes: [SALES, SENSITIVE] })).body;
    const accessNow = async () => (await call(app, made.secret, "/fabric/status")).body.access;
    assert.deepEqual(await accessNow(), { datasets: ["sales"], sensitive: true, cost: true, via: "token", tokenId: made.token.id });

    revokeFrom("sensitiveReaders", owner);
    const noSensitive = await call(app, made.secret, "/fabric/status");
    assert.equal(noSensitive.status, 200);
    assert.deepEqual([noSensitive.body.access.datasets, noSensitive.body.access.sensitive, noSensitive.body.access.cost], [["sales"], false, false]);
    // The token itself still carries the scope; only its effect depends on the owner.
    assert.equal((await app.as(people.admin, "GET", "/api/v1/fabric/api-tokens")).body.tokens.find((t) => t.id === made.token.id).sensitive, true);

    // No longer an administrator: existing tokens keep working (like board tokens), only reading matters.
    revokeFrom("admins", owner);
    assert.equal((await call(app, made.secret, "/fabric/status")).status, 200);

    revokeFrom("readers", owner);
    const refused = await call(app, made.secret, "/fabric/status");
    assert.equal(refused.status, 403);
    assert.equal(code(refused), "TOKEN_ACCESS_REVOKED");
    assert.equal((await call(app, made.secret, "/fabric/status")).status, 403);
    await tick();
    const audit = await app.db.collection(COLLECTIONS.apiTokenAudit).find({ tokenId: new ObjectId(made.token.id), action: "token.use_refused" }).toArray();
    assert.deepEqual(audit.map((a) => [a.reason, a.product]), [["owner lost access", "fabric"]], "audited once");
    assert.equal((await app.as(people.admin, "GET", "/api/v1/fabric/api-tokens")).body.tokens.find((t) => t.id === made.token.id).status, "no_access");

    grant("readers", owner);
    assert.equal((await accessNow()).sensitive, false);
    grant("sensitiveReaders", owner);
    assert.equal((await accessNow()).sensitive, true);

    // A disabled owner stops it too.
    await app.db.collection(COLLECTIONS.users).updateOne({ _id: new ObjectId(made.token.owner.id) }, { $set: { status: "disabled" } });
    const disabled = await call(app, made.secret, "/fabric/status");
    assert.equal(disabled.status, 403);
    assert.equal(code(disabled), "TOKEN_OWNER_DISABLED");
  });

  test("read-only: other methods get 405, a token in the URL 400", async () => {
    const made = (await issue(people.admin)).body;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await call(app, made.secret, "/fabric/status", { method });
      assert.equal(res.status, 405, method);
      assert.equal(code(res), "METHOD_NOT_ALLOWED");
      assert.equal(res.headers.get("allow"), "GET, HEAD");
    }
    assert.equal((await call(app, made.secret, "/fabric/status", { method: "HEAD" })).status, 200);
    for (const query of [`?token=${made.secret}`, "?api_key=x", `?q=${made.secret}`]) {
      const res = await call(app, made.secret, `/fabric/status${query}`);
      assert.equal(res.status, 400);
      assert.equal(code(res), "TOKEN_IN_QUERY");
    }
  });

  test("each token has its own request limit, with X-RateLimit headers and Retry-After", async () => {
    const a = (await issue(people.admin)).body, b = (await issue(people.admin)).body;
    for (let i = 0; i < 3; i += 1) {
      const res = await call(app, a.secret, "/fabric-limited/status");
      assert.equal(res.status, 200, res.text);
      assert.equal(res.headers.get("x-ratelimit-limit"), "3");
      assert.equal(res.headers.get("x-ratelimit-remaining"), String(2 - i));
    }
    const limited = await call(app, a.secret, "/fabric-limited/status");
    assert.equal(limited.status, 429);
    assert.equal(code(limited), "RATE_LIMITED");
    assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    assert.equal((await call(app, b.secret, "/fabric-limited/status")).status, 200, "another token isn't affected");
    await tick();
    const audit = await app.db.collection(COLLECTIONS.apiTokenAudit).find({ tokenId: new ObjectId(a.token.id), action: "token.rate_limited" }).toArray();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].product, "fabric");
  });

  test("nothing about a token reaches the logs", () => {
    assert.ok(!app.logger.errors.join(" ").includes("jarc_"));
  });
});

describe("Fabric tokens don't depend on workspace roles or open access", () => {
  test("with development_shared every employee edits boards, but only Fabric API administrators manage Fabric tokens", async () => {
    const shared = await startFabric({ issuer, accessPolicy: "development_shared" });
    try {
      const employee = issuer.person("Eve Employee"), fabricAdmin = issuer.person("Ada Fabric");
      for (const list of ["readers", "admins"]) shared.lists[list].add(fabricAdmin.oid.toLowerCase());
      shared.tokens.adminObjectIds = Object.freeze([employee.oid.toLowerCase()]);
      const ws = await shared.as(employee, "POST", "/api/v1/workspaces", { name: "Shared synthetic" });
      assert.equal(ws.status, 201, "open access lets the employee work on boards");
      for (const [method, path, body] of [["GET", "/api/v1/fabric/api-tokens"], ["POST", "/api/v1/fabric/api-tokens", { name: "x", scopes: [SALES], expiresAt: inDays(5) }]]) {
        const res = await shared.as(employee, method, path, body);
        assert.equal(res.status, 403);
        assert.equal(code(res), "FABRIC_API_ADMIN_REQUIRED");
      }
      const made = await shared.as(fabricAdmin, "POST", "/api/v1/fabric/api-tokens", { name: "ok", scopes: [SALES], expiresAt: inDays(5) });
      assert.equal(made.status, 201, made.text);
      assert.equal((await call(shared, made.body.secret, "/fabric/status")).status, 200);
      // Open access gives the owner every workspace, but a Fabric token still reads no board.
      assert.equal(code(await call(shared, made.body.secret, "/workspaces")), "INSUFFICIENT_SCOPE");
    } finally { await shared.close(); }
  });

  test("the service needs every permission check", () => {
    assert.throws(() => new FabricTokenService({ tokens: app.tokens, permissions: { isApiAdmin: () => true, isReader: () => true } }), /isSensitiveReader/);
    assert.throws(() => new FabricTokenService({ tokens: {}, permissions: app.permissions }), /API token service/);
  });

  test("isCostReader is still accepted as the earlier name of isSensitiveReader", async () => {
    const { isApiAdmin, isReader, isSensitiveReader } = app.permissions;
    const fabric = new FabricTokenService({ tokens: app.tokens, permissions: { isApiAdmin, isReader, isCostReader: isSensitiveReader } });
    assert.equal(fabric.permissions.isSensitiveReader, isSensitiveReader);
    const ownerUserId = new ObjectId(await userIdOf(people.admin));
    const result = await fabric.authorize({ _id: new ObjectId(), product: "fabric", ownerUserId, scopes: [INVENTORY, SENSITIVE] });
    assert.deepEqual([[...result.datasets], result.sensitive], [["inventory"], true]);
    // The routes take the earlier name too.
    assert.doesNotThrow(() => externalFabricRoutes({ tokens: app.tokens, fabricPermissions: { isApiAdmin, isReader, isCostReader: isSensitiveReader }, fabricDataRouter: stubDataRouter() }));
    assert.doesNotThrow(() => fabricApiTokenRoutes({ tokens: app.tokens, fabricPermissions: { isApiAdmin, isReader, isCostReader: isSensitiveReader }, limiter: () => true }));
  });
});
