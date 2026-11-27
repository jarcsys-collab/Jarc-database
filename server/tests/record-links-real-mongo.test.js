// recordLinks prototype (Column System plan 17 §4) against a REAL MongoDB: the isolated local test instance (loopback
// 127.0.0.1:27027 only, single-node replica set; node scripts/migration-test-db.js start), in throwaway databases removed
// afterwards. Skipped when that instance isn't running. Never reads server/.env; synthetic data only.
// Covers: startup check (create, verify, fail closed on drift, recovery), validator, two-document pairs, two-way updates,
// rebuild from cells (reconcile), transactions (and without), index usage (explain), record / board / column deletion,
// storage per link, rollback (the rest of the app never touches the collection).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto"), fs = require("fs"), net = require("net"), path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { checkRecordLinks, RecordLinkService, COLLECTION, INDEXES } = require("../src/relations/record-links");

const ENV_FILE = path.resolve(__dirname, "..", "..", ".env.migration-test");
function localUri() {
  if (process.env.JARC_MIGRATION_TEST_MONGODB_URI) return process.env.JARC_MIGRATION_TEST_MONGODB_URI;
  if (!fs.existsSync(ENV_FILE)) return null;
  const match = /^\s*JARC_MIGRATION_TEST_MONGODB_URI\s*=\s*(\S+)/m.exec(fs.readFileSync(ENV_FILE, "utf8"));
  return match ? match[1] : null;
}
const portOpen = () => new Promise((resolve) => { const s = net.connect({ host: "127.0.0.1", port: 27027 }); s.once("connect", () => { s.end(); resolve(true); }); s.once("error", () => resolve(false)); setTimeout(() => { s.destroy(); resolve(false); }, 1000); });
const stages = (plan) => { const out = []; const walk = (p) => { if (!p || typeof p !== "object") return; if (p.stage) out.push(p.stage + (p.indexName ? `:${p.indexName}` : "")); for (const k of ["inputStage", "queryPlan"]) walk(p[k]); for (const s of p.inputStages || []) walk(s); }; walk(plan); return out; };

describe("recordLinks prototype on the local test MongoDB", { concurrency: false }, async () => {
  const uri = localUri();
  if (!uri || !(await portOpen())) { test("local test instance not running: SKIPPED, nothing proven here", { skip: true }, () => {}); return; }
  assert.match(uri, /^mongodb:\/\/[^@]+@127\.0\.0\.1:27027\//, "never anything but this machine");
  let client;
  const dbNames = [];
  before(async () => { client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }); await client.connect(); });
  after(async () => { for (const n of dbNames) await client.db(n).dropDatabase().catch(() => {}); await client?.close(); });
  const fresh = async () => {
    const dbName = `jarc_migration_test_t${crypto.randomBytes(6).toString("hex")}`;
    dbNames.push(dbName);
    const connection = new MongoConnection({ uri: "mongodb://127.0.0.1:27027", dbName: "jarc_database", monitor: null, createClient: () => ({ connect: async () => {}, close: async () => {}, db: () => client.db(dbName), startSession: (...a) => client.startSession(...a) }) });
    await connection.connect();
    return { db: client.db(dbName), connection };
  };
  // Boards (plain objects: the service only reads _id and columns) and records stored directly.
  const world = async (db) => {
    const target = { _id: new ObjectId(), columns: [{ key: "serial", type: "text" }, { key: "back", type: "connect", link: { boardId: null } }] };
    const host = { _id: new ObjectId(), columns: [{ key: "serial", type: "text" }, { key: "client", type: "connect", link: { boardId: target._id.toHexString() } }] };
    target.columns[1].link.boardId = host._id.toHexString();
    const targets = Array.from({ length: 5 }, (_, i) => ({ _id: new ObjectId(), boardId: target._id, values: { serial: `T${i}`, back: [] }, version: 1 }));
    const hosts = Array.from({ length: 4 }, (_, i) => ({ _id: new ObjectId(), boardId: host._id, values: { serial: `H${i}`, client: targets.slice(0, i + 1).map((t) => t._id.toHexString()) }, version: 1 }));
    await db.collection("records").insertMany([...targets, ...hosts]);
    return { host, target, hosts, targets };
  };

  test("startup check: creates the collection with the validator and the 4 indexes, then is idempotent", async () => {
    const { db } = await fresh();
    const first = await checkRecordLinks(db);
    assert.deepEqual(first, { ok: true, reason: null, created: [COLLECTION, ...INDEXES.map((i) => i.name)] });
    assert.deepEqual(await checkRecordLinks(db), { ok: true, reason: null, created: [] });
    const names = (await db.collection(COLLECTION).listIndexes().toArray()).map((i) => i.name).sort();
    assert.deepEqual(names, ["_id_", "from_board_column", "to_board", "to_record", "uniq_link"]);
  });

  test("validator: a well-formed link (v as int32) passes; extra fields, other versions, self-links and unsafe keys are refused", async () => {
    const { db } = await fresh();
    await checkRecordLinks(db);
    const ok = { v: 1, fromBoardId: new ObjectId(), fromRecordId: new ObjectId(), columnKey: "client_link", toBoardId: new ObjectId(), toRecordId: new ObjectId(), origin: "cell", createdAt: new Date() };
    await db.collection(COLLECTION).insertOne({ ...ok });
    for (const [label, bad] of [["extra field", { ...ok, workspaceId: new ObjectId() }], ["v 2", { ...ok, v: 2 }], ["self link", { ...ok, toRecordId: ok.fromRecordId }], ["unsafe key", { ...ok, columnKey: "a.b" }], ["no origin", (({ origin, ...r }) => r)(ok)], ["string id", { ...ok, toRecordId: "x" }], ["bad origin", { ...ok, origin: "other" }]])
      await assert.rejects(() => db.collection(COLLECTION).insertOne({ ...bad, _id: new ObjectId() }), (e) => e.code === 121, label);
    await assert.rejects(() => db.collection(COLLECTION).insertOne({ ...ok, _id: new ObjectId() }), (e) => e.code === 11000, "unique per (fromRecordId, columnKey, toRecordId)");
  });

  test("fails closed on drift and never changes what exists; recovery once fixed", async () => {
    const { db } = await fresh();
    assert.equal((await checkRecordLinks(db, { create: false })).reason, "missing");
    assert.deepEqual(await db.listCollections({ name: COLLECTION }).toArray(), [], "create:false creates nothing");
    await db.createCollection(COLLECTION); // no validator
    assert.deepEqual(await checkRecordLinks(db), { ok: false, reason: "validator-differs", created: [] });
    assert.equal((await db.listCollections({ name: COLLECTION }).toArray())[0].options.validator, undefined, "not collMod-ed");
    const { db: db2 } = await fresh();
    await checkRecordLinks(db2);
    await db2.collection(COLLECTION).dropIndex("to_board");
    await db2.collection(COLLECTION).createIndex({ toBoardId: 1 }, { name: "to_board" });
    assert.equal((await checkRecordLinks(db2)).reason, "index-differs:to_board");
    await db2.collection(COLLECTION).dropIndex("to_board");
    assert.equal((await checkRecordLinks(db2, { create: false })).reason, "index-missing:to_board", "a dropped index: fail closed");
    assert.deepEqual(await checkRecordLinks(db2), { ok: true, reason: null, created: ["to_board"] }, "recovery: recreated at the next start");
  });

  test("two-document pairs and two-way updates: one transaction; any failure writes nothing", async () => {
    const { db, connection } = await fresh();
    await checkRecordLinks(db);
    const { host, target, hosts, targets } = await world(db);
    const links = new RecordLinkService({ db, connection });
    const pairId = await links.linkPair({ board: host, recordId: hosts[0]._id, columnKey: "client" }, { board: target, recordId: targets[4]._id, columnKey: "back" });
    const rows = await db.collection(COLLECTION).find({ pairId }).toArray();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.origin).sort(), ["cell", "reciprocal"]);
    assert.ok(rows.some((r) => r.fromRecordId.equals(hosts[0]._id) && r.toRecordId.equals(targets[4]._id)));
    assert.ok(rows.some((r) => r.fromRecordId.equals(targets[4]._id) && r.toRecordId.equals(hosts[0]._id)));
    assert.ok((await db.collection("records").findOne({ _id: targets[4]._id })).values.back.includes(hosts[0]._id.toHexString()), "reciprocal cell");
    // The far record doesn't exist: nothing at all is written (never silently one-way).
    const before = await db.collection("records").findOne({ _id: hosts[1]._id });
    await assert.rejects(() => links.linkPair({ board: host, recordId: hosts[1]._id, columnKey: "client" }, { board: target, recordId: new ObjectId(), columnKey: "back" }));
    assert.deepEqual(await db.collection("records").findOne({ _id: hosts[1]._id }), before);
    assert.equal(await db.collection(COLLECTION).countDocuments({ fromRecordId: hosts[1]._id }), 0);
    assert.equal(await links.unpair(pairId), 2);
    assert.equal(await db.collection(COLLECTION).countDocuments({ pairId }), 0);
    assert.equal((await db.collection("records").findOne({ _id: targets[4]._id })).values.back.length, 0);
  });

  test("single writer: cell + rows in one transaction; a stale version or a failure after the cell write leaves both unchanged", async () => {
    const { db, connection } = await fresh();
    await checkRecordLinks(db);
    const { host, hosts, targets } = await world(db);
    const links = new RecordLinkService({ db, connection });
    const t = targets.map((x) => x._id.toHexString());
    await links.setLinks(host, hosts[0]._id, "client", [t[1], t[2]], 1);
    assert.deepEqual((await db.collection(COLLECTION).find({ fromRecordId: hosts[0]._id }).toArray()).map((r) => r.toRecordId.toHexString()).sort(), [t[1], t[2]].sort());
    await assert.rejects(() => links.setLinks(host, hosts[0]._id, "client", [t[3]], 1), (e) => e.status === 409);
    // Failure injected after the cell write, inside the transaction: the cell is rolled back too.
    const broken = new RecordLinkService({ db, connection });
    broken.syncRecord = async () => { throw new Error("injected"); };
    await assert.rejects(() => broken.setLinks(host, hosts[0]._id, "client", [t[4]], 2), /injected/);
    assert.deepEqual((await db.collection("records").findOne({ _id: hosts[0]._id })).values.client, [t[1], t[2]], "transaction rolled the cell back");
    // WITHOUT transactions (connection null): the cell is written, the rows aren't: reconcile finds and repairs it.
    const plain = new RecordLinkService({ db, connection: null });
    plain.syncRecord = async () => { throw new Error("injected"); };
    await assert.rejects(() => plain.setLinks(host, hosts[0]._id, "client", [t[4]], 2), /injected/);
    assert.deepEqual((await db.collection("records").findOne({ _id: hosts[0]._id })).values.client, [t[4]], "no transaction: the cell write stays");
    const repair = new RecordLinkService({ db, connection: null });
    const report = await repair.reconcile(host);
    assert.ok(report.missing >= 1 && report.extra >= 2, JSON.stringify(report));
    await repair.reconcile(host, { apply: true });
    assert.deepEqual(await repair.reconcile(host), { scanned: 4, missing: 0, extra: 0, applied: false });
  });

  test("rebuild from cells: an empty or damaged index is rebuilt by reconcile; random edits converge to diff 0", async () => {
    const { db } = await fresh();
    await checkRecordLinks(db);
    const { host, hosts, targets } = await world(db);
    const links = new RecordLinkService({ db });
    assert.deepEqual(await links.reconcile(host), { scanned: 4, missing: 10, extra: 0, applied: false }, "1+2+3+4 links, none indexed");
    await links.reconcile(host, { apply: true });
    assert.equal(await db.collection(COLLECTION).countDocuments({ fromBoardId: host._id, origin: "rebuild" }), 10);
    let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 30; i++) {
      const h = hosts[rnd(hosts.length)];
      const ids = [...new Set(Array.from({ length: rnd(5) }, () => targets[rnd(targets.length)]._id.toHexString()))];
      await db.collection("records").updateOne({ _id: h._id }, { $set: { "values.client": ids } });
      if (rnd(2)) await links.syncRecord(host, await db.collection("records").findOne({ _id: h._id }));
    }
    await db.collection(COLLECTION).insertOne({ v: 1, fromBoardId: host._id, fromRecordId: new ObjectId(), columnKey: "client", toBoardId: new ObjectId(), toRecordId: new ObjectId(), origin: "cell", createdAt: new Date() }); // a row whose source is gone
    const drift = await links.reconcile(host);
    assert.ok(drift.extra >= 1);
    await links.reconcile(host, { apply: true });
    assert.deepEqual(await links.reconcile(host), { scanned: 4, missing: 0, extra: 0, applied: false });
  });

  test("index usage (explain): every access path uses its index, never a collection scan", async () => {
    const { db } = await fresh();
    await checkRecordLinks(db);
    const { host, hosts } = await world(db);
    const links = new RecordLinkService({ db });
    await links.reconcile(host, { apply: true });
    const c = db.collection(COLLECTION);
    const plans = {
      uniq_link: await c.find({ fromRecordId: hosts[0]._id, columnKey: "client" }).explain("queryPlanner"),
      to_record: await c.find({ toRecordId: hosts[0].values.client.length ? new ObjectId(hosts[0].values.client[0]) : new ObjectId() }).explain("queryPlanner"),
      to_board: await c.find({ toBoardId: new ObjectId() }).sort({ toBoardId: 1, _id: 1 }).limit(500).explain("queryPlanner"),
      from_board_column: await c.find({ fromBoardId: host._id, columnKey: "client" }).sort({ fromBoardId: 1, columnKey: 1, _id: 1 }).limit(500).explain("queryPlanner")
    };
    for (const [name, plan] of Object.entries(plans)) {
      const s = stages(plan.queryPlanner.winningPlan);
      assert.ok(s.includes(`IXSCAN:${name}`), `${name}: ${s.join(" > ")}`);
      assert.ok(!s.includes("COLLSCAN"), name);
      assert.ok(!s.includes("SORT"), `${name}: no in-memory sort`);
    }
  });

  test("deletions: source record, target record (cascade pulls the ID from cells), board (paced sweep), column", async () => {
    const { db, connection } = await fresh();
    await checkRecordLinks(db);
    const { host, target, hosts, targets } = await world(db);
    const links = new RecordLinkService({ db, connection });
    await links.reconcile(host, { apply: true });
    const t0 = targets[0]._id;
    // Target record deleted: every link to it goes, and its ID is pulled from the 4 source cells.
    await db.collection("records").deleteOne({ _id: t0 });
    assert.deepEqual(await links.onRecordDeleted(t0), { own: 0, pulled: 4, more: false });
    assert.equal(await db.collection(COLLECTION).countDocuments({ toRecordId: t0 }), 0);
    for (const h of hosts) assert.equal((await db.collection("records").findOne({ _id: h._id })).values.client.includes(t0.toHexString()), false);
    assert.deepEqual(await links.reconcile(host), { scanned: 4, missing: 0, extra: 0, applied: false }, "consistent after the cascade");
    // Source record deleted: its own rows go.
    await db.collection("records").deleteOne({ _id: hosts[3]._id });
    assert.equal((await links.onRecordDeleted(hosts[3]._id)).own, 3);
    // Column deleted: its rows go (paced by from_board_column).
    assert.equal(await links.onColumnDeleted(host._id, "client"), 3);
    await links.reconcile(host, { apply: true });
    assert.ok(await db.collection(COLLECTION).countDocuments({ fromBoardId: host._id }) > 0);
    // Board deleted: from- and to- rows swept.
    const swept = await links.onBoardDeleted(target._id);
    assert.equal(swept.from, 0);
    assert.ok(swept.to > 0);
    assert.equal(await db.collection(COLLECTION).countDocuments({ $or: [{ toBoardId: target._id }, { fromBoardId: target._id }] }), 0);
  });

  test("storage per link (measured) and rollback: the rest of JARC never creates or touches recordLinks", async (t) => {
    const { db } = await fresh();
    await checkRecordLinks(db);
    const n = 1000, fromBoardId = new ObjectId(), toBoardId = new ObjectId();
    const docs = Array.from({ length: n }, () => ({ v: 1, fromBoardId, fromRecordId: new ObjectId(), columnKey: "client_link", toBoardId, toRecordId: new ObjectId(), origin: "cell", createdAt: new Date() }));
    await db.collection(COLLECTION).insertMany(docs);
    // On-disk sizes are only meaningful after a checkpoint (fsync needs a privilege the test user may lack: then data size only).
    const checkpointed = await client.db("admin").command({ fsync: 1 }).then(() => true, () => false);
    t.diagnostic(`checkpointed: ${checkpointed}`);
    const stats = (await db.command({ collStats: COLLECTION }));
    const perLink = { avgObjSize: stats.avgObjSize, dataPer1000KB: +(stats.size / 1024).toFixed(1), indexesPer1000KB: +(stats.totalIndexSize / 1024).toFixed(1), storagePer1000KB: +(stats.storageSize / 1024).toFixed(1), indexSizes: Object.fromEntries(Object.entries(stats.indexSizes).map(([k, v]) => [k, +(v / 1024).toFixed(1)])) };
    t.diagnostic(`recordLinks storage for ${n} links: ${JSON.stringify(perLink)}`);
    assert.ok(stats.avgObjSize > 120 && stats.avgObjSize < 260, `≈190 B per document (plan 17 §4.4): ${stats.avgObjSize}`);
    // Rollback: the bootstrap of any release (Connect off, or code without the prototype) leaves recordLinks alone.
    const { db: plain } = await fresh();
    await ensureDatabase(plain);
    assert.deepEqual(await plain.listCollections({ name: COLLECTION }).toArray(), [], "the bootstrap never creates it");
    await ensureDatabase(db);
    assert.equal(await db.collection(COLLECTION).countDocuments(), n, "an existing collection is left as it is (inert)");
    const src = fs.readdirSync(path.join(__dirname, "../src"), { recursive: true }).filter((f) => String(f).endsWith(".js")).filter((f) => fs.readFileSync(path.join(__dirname, "../src", String(f)), "utf8").includes("recordLinks"));
    assert.deepEqual(src.map((f) => String(f).split(path.sep).join("/")).sort(), ["relations/record-links.js"], "only the prototype module names the collection");
  });
});
