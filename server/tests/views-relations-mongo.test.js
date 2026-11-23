// Personal views, Connect boards and Mirror columns on REAL MongoDB (the local, loopback-only test instance from
// scripts/migration-test-db.js; a throwaway database per run, dropped afterwards). The real app with Entra sign-in.
// Skipped when the instance isn't running. Synthetic people and data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

const settingFile = path.join(__dirname, "../../.env.migration-test");
const setting = (key) => { if (!fs.existsSync(settingFile)) return null; const m = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\r\\n]*)`, "m").exec(fs.readFileSync(settingFile, "utf8")); return m ? m[1].trim() : null; };

describe("Views and links on real MongoDB (local test instance)", () => {
  let client = null, skip = false, dbName, app, issuer, people, ws, wsB, projects, clients, links;
  const sessions = new Map();
  const as = async (p, method, url, body) => { if (!sessions.has(p.oid)) { const c = new SessionClient(app.url, app.entra.appOrigin); assert.equal((await c.signIn(p)).status, 201); sessions.set(p.oid, c); } return sessions.get(p.oid).request(method, url, body); };
  const board = async (p, id) => (await as(p, "GET", `/api/v1/boards/${id}`)).body.board;
  const guarded = (name, fn) => test(name, async (t) => { if (skip) return t.skip("the local test instance isn't running"); return fn(); });

  before(async () => {
    const uri = setting("JARC_MIGRATION_TEST_MONGODB_URI");
    if (!uri || !/@127\.0\.0\.1:27027\//.test(uri)) { skip = true; return; } // only the loopback test instance, never anything else
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
    try { await client.connect(); await client.db("admin").command({ ping: 1 }); } catch { skip = true; await client.close().catch(() => {}); client = null; return; }
    dbName = `jarc_migration_test_t${crypto.randomBytes(6).toString("hex")}`; // the throwaway naming that scripts/migration-test-db.js prune removes
    const raw = client, wrapper = { connect: async () => {}, close: async () => {}, startSession: (...a) => raw.startSession(...a), db: () => raw.db(dbName) };
    issuer = await createTokenIssuer();
    app = await startEntraApp({ issuer, fake: wrapper });
    people = { owner: issuer.person("Owner Person", { admin: true }), a: issuer.person("Employee Alpha"), b: issuer.person("Employee Beta"), outsider: issuer.person("Outsider Person") };
    ws = (await as(people.owner, "POST", "/api/v1/workspaces", { name: "Real" })).body.workspace;
    wsB = (await as(people.owner, "POST", "/api/v1/workspaces", { name: "Restricted" })).body.workspace;
    for (const p of [people.a, people.b, people.outsider]) await as(people.owner, "POST", `/api/v1/workspaces/${ws.id}/members`, { userId: (await as(p, "GET", "/api/v1/me")).body.user.id, role: "MEMBER" });
    for (const p of [people.a, people.b]) await as(people.owner, "POST", `/api/v1/workspaces/${wsB.id}/members`, { userId: (await as(p, "GET", "/api/v1/me")).body.user.id, role: "VIEWER" });
    clients = (await as(people.owner, "POST", `/api/v1/workspaces/${wsB.id}/boards`, { name: "Clients", columns: [{ key: "serial", label: "Client", type: "text", required: true }, { key: "value", label: "Value", type: "number" }] })).body.board;
    links = (await as(people.owner, "POST", `/api/v1/boards/${clients.id}/records/batch`, { records: Array.from({ length: 300 }, (_, i) => ({ values: { serial: `C${i}`, value: i } })) })).body.items.map((r) => r.id);
    projects = (await as(people.owner, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Projects", columns: [{ key: "serial", label: "Project", type: "text", required: true }, { key: "client", label: "Clients", type: "connect", link: { boardId: clients.id }, multiple: true }, { key: "total", label: "Total", type: "mirror", mirror: { via: "client", column: "value", show: "sum" } }] })).body.board;
  });
  after(async () => { await app?.close(); if (client) { await client.db(dbName).dropDatabase().catch(() => {}); await client.close(); } });

  guarded("personal views: stored apart, private, and concurrent saves by two people and a shared change don't collide", async () => {
    const start = await board(people.a, projects.id);
    assert.equal((await as(people.a, "PATCH", `/api/v1/boards/${projects.id}`, { expectedVersion: start.version, savedViews: [{ name: "Team", state: {} }] })).status, 200);
    const shared = await board(people.a, projects.id);
    const mine = (p, name) => as(p, "PATCH", `/api/v1/boards/${projects.id}`, { expectedVersion: shared.version, savedViews: [...shared.savedViews.map(({ id, name: n, state }) => ({ id, name: n, state })), { name, personal: true, state: {} }] });
    const [ra, rb] = await Promise.all([mine(people.a, "Alpha only"), mine(people.b, "Beta only")]);
    assert.equal(ra.status, 200, JSON.stringify(ra.body)); assert.equal(rb.status, 200, JSON.stringify(rb.body));
    // Neither personal save touched the board, so a shared change made from the same version still goes through.
    const rename = await as(people.owner, "PATCH", `/api/v1/boards/${projects.id}`, { expectedVersion: shared.version, savedViews: [{ id: shared.savedViews[0].id, name: "Team (renamed)", state: {} }] });
    assert.equal(rename.status, 200, JSON.stringify(rename.body));
    const names = async (p) => (await board(p, projects.id)).savedViews.map((v) => v.name).sort();
    assert.deepEqual(await names(people.a), ["Alpha only", "Team (renamed)"]);
    assert.deepEqual(await names(people.b), ["Beta only", "Team (renamed)"]);
    assert.deepEqual(await names(people.owner), ["Team (renamed)"]);
    const doc = await client.db(dbName).collection("boards").findOne({ name: "Projects" });
    assert.deepEqual(doc.savedViews.map((v) => v.name), ["Team (renamed)"], "the board document holds shared views only");
    assert.equal(await client.db(dbName).collection("personalViews").countDocuments({}), 2);
    // A stale shared save is still refused (versions work as before).
    assert.equal((await as(people.b, "PATCH", `/api/v1/boards/${projects.id}`, { expectedVersion: shared.version, name: "Stale" })).status, 409);
  });

  guarded("links and mirrors: 201 links (the 100-per-cell limit) resolved in one batch; access checked per reader; concurrent link writes keep every write whole", async () => {
    const make = (p, i, ids) => as(p, "POST", `/api/v1/boards/${projects.id}/records`, { values: { serial: `P${i}`, client: ids } });
    const results = await Promise.all([make(people.a, 1, links.slice(0, 100)), make(people.b, 2, links.slice(100, 200)), make(people.a, 3, [links[0]])]);
    assert.deepEqual(results.map((r) => r.status), [201, 201, 201]);
    const ids = results.map((r) => r.body.record.id);
    const t0 = Date.now(), res = await as(people.a, "GET", `/api/v1/boards/${projects.id}/related?ids=${ids.join(",")}`), ms = Date.now() - t0;
    assert.equal(res.status, 200);
    assert.equal(res.body.values[ids[0]].total, (99 * 100) / 2);
    assert.equal(res.body.values[ids[1]].total, ((100 + 199) * 100) / 2);
    assert.equal(Object.keys(res.body.linked.client).length, 200, "every linked name, once");
    console.log(`[views-relations-mongo] related: 3 records, 201 links, 200 distinct, real MongoDB: ${ms} ms`);
    const locked = await as(people.outsider, "GET", `/api/v1/boards/${projects.id}/related?ids=${ids.join(",")}`);
    assert.deepEqual(locked.body.restricted.sort(), ["client", "total"]); assert.ok(!locked.text.includes("C1"));
    assert.equal((await make(people.outsider, 4, [links[5]])).status, 403);
    assert.equal((await make(people.a, 5, ["0123456789abcdef01234567"])).status, 400, "an ID not on Clients");
    assert.equal((await make(people.a, 6, links.slice(0, 101))).status, 400, "more than 100 links in one cell");
    // Rows on the server hold exactly what each request sent (no merges, no duplicates).
    const stored = await client.db(dbName).collection("records").find({ "values.serial": { $in: ["P1", "P2", "P3"] } }).toArray();
    assert.deepEqual(stored.map((d) => d.values.client.length).sort((x, y) => x - y), [1, 100, 100]);
  });
});
