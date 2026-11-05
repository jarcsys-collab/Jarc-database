// The token API on a REAL MongoDB: the isolated local test instance (loopback only, node scripts/migration-test-db.js start), in a
// throwaway database (removed with `migration-test-db.js prune`). 3,952 synthetic records: complete paginated reads while the board
// changes, the query plans, the unique index and the TTL index. Skipped when that instance isn't running. Never reads server/.env.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto"), fs = require("fs"), net = require("net"), path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
const { startApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase, COLLECTIONS } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { createEntraVerifier } = require("../src/auth/entra-token");

const ENV_FILE = path.resolve(__dirname, "..", "..", ".env.migration-test");
function localUri() {
  if (!fs.existsSync(ENV_FILE)) return null;
  const match = /^\s*JARC_MIGRATION_TEST_MONGODB_URI\s*=\s*(\S+)/m.exec(fs.readFileSync(ENV_FILE, "utf8"));
  return match ? match[1] : null;
}
const portOpen = () => new Promise((resolve) => { const s = net.connect({ host: "127.0.0.1", port: 27027 }); s.once("connect", () => { s.end(); resolve(true); }); s.once("error", () => resolve(false)); setTimeout(() => { s.destroy(); resolve(false); }, 1000); });
const TOTAL = 3952;

describe("API tokens on the local test MongoDB", { concurrency: false }, async () => {
  const uri = localUri();
  if (!uri || !(await portOpen())) { test("local test instance not running (scripts/migration-test-db.js start)", { skip: true }, () => {}); return; }
  // Never anything but this machine.
  assert.match(uri, /^mongodb:\/\/[^@]+@127\.0\.0\.1:27027\//);
  const dbName = `jarc_migration_test_t${crypto.randomBytes(6).toString("hex")}`;
  let client, app, db, secret, boardId, boardOid, recordIds, workspaceOid, tokenOid, browser;

  const call = async (url) => {
    const res = await fetch(`${app.url}/api/v1/external${url}`, { headers: { Authorization: `Bearer ${secret}` } });
    return { status: res.status, body: await res.json() };
  };
  const readAll = async (query, limit, during) => {
    const items = []; let cursor = null, pages = 0;
    do {
      const res = await call(`/boards/${boardId}/records?limit=${limit}${query}${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(res.status, 200);
      items.push(...res.body.items);
      cursor = res.body.pagination.nextCursor;
      pages += 1;
      if (during && pages === 2) await during();
    } while (cursor);
    return { items, pages };
  };

  before(async () => {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    // The app's guard allows one database name; the client it gets opens the throwaway database under that name.
    const scoped = new Proxy(client, { get: (target, prop) => (prop === "db" ? () => target.db(dbName) : typeof target[prop] === "function" ? target[prop].bind(target) : target[prop]) });
    const connection = new MongoConnection({ uri: "mongodb://127.0.0.1:27027", dbName: "jarc_database", createClient: () => ({ connect: async () => {}, close: async () => {}, db: scoped.db, startSession: (...a) => client.startSession(...a), withSession: (...a) => client.withSession(...a) }) });
    await connection.connect();
    db = connection.db;
    assert.equal(db.databaseName, dbName);
    await ensureDatabase(db, { features: { nativeForms: false, spreadsheetImports: false, apiTokens: true } });
    const issuer = await createTokenIssuer();
    const logger = { errors: [], error(...a) { this.errors.push(a.map(String).join(" ")); } };
    const dataLayer = createDataLayer({ connection, logger, fileStore: new MemoryFileStore() });
    const entra = issuer.config;
    app = await startApp({ dataLayer, auth: { mode: "entra", entra, verify: createEntraVerifier({ ...entra, keySet: issuer.keySet }) }, logger, apiTokens: { key: crypto.randomBytes(32), perMinute: 6000 } });
    browser = new SessionClient(app.url, entra.appOrigin);
    assert.equal((await browser.signIn(issuer.person("Local Owner", { admin: true }))).status, 201);
    const ws = (await browser.request("POST", "/api/v1/workspaces", { name: "Synthetic" })).body.workspace;
    workspaceOid = new ObjectId(ws.id);
    const board = (await browser.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Large", columns: [{ key: "serial", label: "Item", type: "text", required: true }, { key: "qty", label: "Qty", type: "number" }] })).body.board;
    boardId = board.id; boardOid = new ObjectId(boardId);
    const at = new Date(Date.now() - 86400000);
    const docs = Array.from({ length: TOTAL }, (_, i) => ({ _id: new ObjectId(), workspaceId: workspaceOid, boardId: boardOid, values: { serial: `Synthetic ${i}`, qty: i }, groupId: board.groups[i % board.groups.length].id, position: (i * 7919) % TOTAL, archived: false, pinned: false, createdBy: null, updatedBy: null, createdAt: at, updatedAt: at, version: 1 }));
    await db.collection(COLLECTIONS.records).insertMany(docs);
    recordIds = docs.map((d) => d._id.toHexString());
    const issued = await browser.request("POST", "/api/v1/me/api-tokens", { name: "Local", workspaceId: ws.id, boardIds: [boardId], scopes: ["read"], expiresAt: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(issued.status, 201, issued.text);
    secret = issued.body.secret; tokenOid = new ObjectId(issued.body.token.id);
  });
  after(async () => { await app?.close(); await client?.close(); });

  test(`a complete read of ${TOTAL} records returns each exactly once, with exact values`, async () => {
    const { items, pages } = await readAll("", 500);
    assert.equal(items.length, TOTAL);
    assert.equal(pages, 8);
    const got = items.map((r) => r.id);
    assert.equal(new Set(got).size, TOTAL);
    assert.deepEqual([...got].sort(), [...recordIds].sort());
    const stored = await db.collection(COLLECTIONS.records).find({ boardId: boardOid }, { projection: { values: 1 } }).toArray();
    const byId = new Map(stored.map((r) => [r._id.toHexString(), r.values]));
    for (const r of items) assert.deepEqual(r.values, byId.get(r.id));
  });

  test("the same read while the board is reordered, edited, added to and deleted from", async () => {
    const records = db.collection(COLLECTIONS.records), sorted = [...recordIds].sort();
    const added = new ObjectId();
    const { items } = await readAll("", 250, async () => {
      await records.updateMany({ boardId: boardOid }, { $inc: { position: 100000 } });
      await records.updateOne({ _id: new ObjectId(sorted[3000]) }, { $set: { "values.serial": "Edited", updatedAt: new Date() }, $inc: { version: 1 } });
      await records.deleteOne({ _id: new ObjectId(sorted[3500]) });
      const now = new Date();
      await records.insertOne({ _id: added, workspaceId: workspaceOid, boardId: boardOid, values: { serial: "Added" }, groupId: null, position: 0, archived: false, pinned: false, createdAt: now, updatedAt: now, version: 1 });
    });
    const got = items.map((r) => r.id);
    assert.equal(new Set(got).size, got.length, "no duplicates");
    assert.equal(got.length, TOTAL, `${TOTAL} − 1 deleted + 1 added`);
    assert.ok(got.includes(added.toHexString()) && !got.includes(sorted[3500]));
    assert.equal(items.find((r) => r.id === sorted[3000]).values.serial, "Edited");
  });

  test("incremental sync returns exactly the rows changed since then", async () => {
    const records = db.collection(COLLECTIONS.records), since = new Date(Date.now() + 1000);
    const changed = (await records.find({ boardId: boardOid }, { limit: 620 }).toArray()).map((r) => r._id);
    await records.updateMany({ _id: { $in: changed } }, { $set: { updatedAt: new Date(since.getTime() + 5000) } });
    const { items } = await readAll(`&updatedSince=${encodeURIComponent(since.toISOString())}`, 200);
    assert.equal(new Set(items.map((r) => r.id)).size, 620);
    assert.equal(items.length, 620);
  });

  test("one column's values, across all pages, match the stored records; a projection returns only that column", async () => {
    const items = []; let cursor = null;
    do {
      const res = await call(`/boards/${boardId}/columns/qty/values?limit=500${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(res.status, 200);
      items.push(...res.body.items);
      cursor = res.body.pagination.nextCursor;
    } while (cursor);
    const stored = await db.collection(COLLECTIONS.records).find({ boardId: boardOid, archived: false }, { projection: { "values.qty": 1 } }).toArray();
    assert.equal(items.length, stored.length);
    const byId = new Map(stored.map((r) => [r._id.toHexString(), r.values.qty ?? null]));
    for (const cell of items) assert.equal(cell.value, byId.get(cell.recordId));
    const selected = (await call(`/boards/${boardId}/records?limit=2&columns=qty`)).body.items;
    assert.ok(selected.every((r) => Object.keys(r.values).join() === "qty"));
  });

  test("the planner uses the indexes, and doesn't sort in memory or scan other boards", async () => {
    const records = db.collection(COLLECTIONS.records);
    const stages = (plan) => { const names = []; const walk = (s) => { if (!s) return; names.push(s.stage, ...(s.indexName ? [s.indexName] : [])); walk(s.inputStage); (s.inputStages || []).forEach(walk); }; walk(plan.queryPlanner.winningPlan.queryPlan || plan.queryPlanner.winningPlan); return names; };
    const full = await records.find({ boardId: boardOid, archived: false, _id: { $gt: new ObjectId("000000000000000000000000") } }, { sort: { _id: 1 }, limit: 501 }).explain("executionStats");
    assert.ok(stages(full).includes("board_id"), stages(full).join(","));
    assert.ok(!stages(full).includes("SORT"));
    assert.ok(full.executionStats.totalDocsExamined <= 520, `examined ${full.executionStats.totalDocsExamined}`);
    const since = new Date(0);
    const incremental = await records.find({ boardId: boardOid, archived: false, updatedAt: { $gte: since } }, { sort: { updatedAt: 1, _id: 1 }, limit: 501 }).explain("executionStats");
    assert.ok(stages(incremental).includes("board_updated"), stages(incremental).join(","));
    assert.ok(!stages(incremental).includes("SORT"));
    const lookup = await db.collection(COLLECTIONS.apiTokens).find({ publicId: "000000000000000000000000" }).explain("queryPlanner");
    assert.ok(stages(lookup).includes("uniq_public_id"), stages(lookup).join(","));
  });

  test("rotation commits in one real transaction; the digest index is unique; refused use expires", async () => {
    const rotated = await browser.request("POST", `/api/v1/me/api-tokens/${tokenOid}/rotate`, { graceHours: 1 });
    assert.equal(rotated.status, 201, rotated.text);
    const [old, replacement] = await Promise.all([db.collection(COLLECTIONS.apiTokens).findOne({ _id: tokenOid }), db.collection(COLLECTIONS.apiTokens).findOne({ _id: new ObjectId(rotated.body.token.id) })]);
    assert.ok(old.rotatedToId.equals(replacement._id) && replacement.rotatedFromId.equals(old._id));
    assert.ok(!JSON.stringify(replacement).includes(rotated.body.secret));
    for (const name of [COLLECTIONS.apiTokens, COLLECTIONS.apiTokenAudit, COLLECTIONS.activities]) {
      const everything = JSON.stringify(await db.collection(name).find({}).toArray());
      assert.ok(!everything.includes(rotated.body.secret) && !everything.includes(secret), `no secret in ${name}`);
    }
    await assert.rejects(db.collection(COLLECTIONS.apiTokens).insertOne({ publicId: old.publicId }), /duplicate key/i);
    const indexes = await db.collection(COLLECTIONS.apiTokenAudit).indexes();
    assert.equal(indexes.find((i) => i.name === "expires").expireAfterSeconds, 0);
    // The record data wasn't touched by any of the API's reads above: only the token's usage changed.
    assert.ok(old.lastUsedAt instanceof Date && old.requestCount >= 1);
  });
});
