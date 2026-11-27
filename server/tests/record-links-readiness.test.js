// Activation readiness for Connect (doc 25 §14, owner decision: no JARC_FEATURE_RECORD_LINKS): recordLinks is prepared and
// verified BEFORE the switch, by explicit scripts, against the local test MongoDB (127.0.0.1:27027 only; throwaway databases;
// skipped when not running; never server/.env). Proves: verify fails closed before setup; the collection script dry-run →
// apply → verify; reconcile report → apply (backfill from the cells) → verify 0; drift makes verify fail again; the startup
// check stays check-only; reconcile never changes a cell.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto"), fs = require("fs"), net = require("net"), path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
const { checkRecordLinks, COLLECTION } = require("../src/relations/record-links");
const collectionScript = require("../scripts/record-links-collection");
const reconcileScript = require("../scripts/record-links-reconcile");

const ENV_FILE = path.resolve(__dirname, "..", "..", ".env.migration-test");
const uriOf = () => { if (!fs.existsSync(ENV_FILE)) return null; const m = /^\s*JARC_MIGRATION_TEST_MONGODB_URI\s*=\s*(\S+)/m.exec(fs.readFileSync(ENV_FILE, "utf8")); return m ? m[1] : null; };
const portOpen = () => new Promise((resolve) => { const s = net.connect({ host: "127.0.0.1", port: 27027 }); s.once("connect", () => { s.end(); resolve(true); }); s.once("error", () => resolve(false)); setTimeout(() => { s.destroy(); resolve(false); }, 1000); });

describe("recordLinks preparation and verification before activation (local test MongoDB)", { concurrency: false }, async () => {
  const uri = uriOf();
  if (!uri || !(await portOpen())) { test("local test instance not running: SKIPPED, nothing proven here", { skip: true }, () => {}); return; }
  assert.match(uri, /^mongodb:\/\/[^@]+@127\.0\.0\.1:27027\//);
  let client;
  const dbName = `jarc_migration_test_r${crypto.randomBytes(6).toString("hex")}`;
  before(async () => { client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }); await client.connect(); });
  after(async () => { await client.db(dbName).dropDatabase().catch(() => {}); await client?.close(); });
  const call = async (script, argv) => { const lines = []; const code = await script.main(argv, (s) => lines.push(s)); return { code, out: JSON.parse(lines.join("\n")) }; };
  const local = ["--local", "--db", dbName];

  test("dry-run → apply → verify; reconcile report → apply → verify 0; drift fails verify; cells never change", async () => {
    const db = client.db(dbName);
    const target = { _id: new ObjectId(), name: "T", columns: [{ key: "serial", type: "text" }] };
    const host = { _id: new ObjectId(), name: "H", columns: [{ key: "serial", type: "text" }, { key: "client", type: "connect", multiple: true, link: { boardId: target._id.toHexString() } }] };
    await db.collection("boards").insertMany([target, host]);
    const ts = Array.from({ length: 5 }, () => ({ _id: new ObjectId(), boardId: target._id, values: { serial: "t" }, version: 1 }));
    const hs = Array.from({ length: 450 }, (_, i) => ({ _id: new ObjectId(), boardId: host._id, values: { serial: "h", client: ts.slice(0, i % 4).map((t) => t._id.toHexString()) }, version: 1 }));
    await db.collection("records").insertMany([...ts, ...hs]);
    const cells = JSON.stringify(await db.collection("records").find({}, { projection: { values: 1, version: 1 } }).sort({ _id: 1 }).toArray());
    const expected = hs.reduce((n, _, i) => n + (i % 4), 0);

    // Before setup: verify and apply fail closed and write nothing.
    let r = await call(reconcileScript, ["--verify", "--all", ...local]);
    assert.equal(r.code, 1); assert.equal(r.out.ready, false); assert.equal(r.out.reason, "missing");
    r = await call(reconcileScript, ["--apply", "--all", "--pause-ms", "0", ...local]);
    assert.equal(r.code, 1); assert.equal(r.out.ready, false);
    assert.deepEqual(await db.listCollections({ name: COLLECTION }).toArray(), [], "nothing created by reconcile");
    // Setup by the explicit collection script.
    r = await call(collectionScript, ["--dry-run", ...local]);
    assert.equal(r.out.plan.createCollection, true);
    r = await call(collectionScript, ["--apply", ...local]);
    assert.equal(r.code, 0); assert.equal(r.out.verify.ok, true);
    assert.equal((await call(collectionScript, ["--verify", ...local])).code, 0);
    // Index ready but empty: report shows the backfill, verify fails, apply backfills from the cells, verify passes.
    r = await call(reconcileScript, ["--report", "--all", ...local]);
    assert.deepEqual(r.out.total, { missing: expected, extra: 0 });
    assert.deepEqual(r.out.boards.map((b) => b.boardId), [host._id.toHexString()], "only boards with Connect columns");
    assert.equal((await call(reconcileScript, ["--verify", "--all", ...local])).code, 1);
    r = await call(reconcileScript, ["--apply", "--all", "--pause-ms", "0", ...local]);
    assert.equal(r.code, 0); assert.deepEqual(r.out.total, { missing: 0, extra: 0 });
    assert.equal(await db.collection(COLLECTION).countDocuments(), expected);
    r = await call(reconcileScript, ["--verify", "--board", host._id.toHexString(), ...local]);
    assert.equal(r.code, 0); assert.equal(r.out.ok, true);
    // Re-running apply is a no-op (idempotent).
    await call(reconcileScript, ["--apply", "--all", "--pause-ms", "0", ...local]);
    assert.equal(await db.collection(COLLECTION).countDocuments(), expected);
    // Drift (a lost row, a foreign row) → verify fails → apply → verify passes.
    await db.collection(COLLECTION).deleteOne({ fromBoardId: host._id });
    await db.collection(COLLECTION).insertOne({ v: 1, fromBoardId: host._id, fromRecordId: new ObjectId(), columnKey: "client", toBoardId: target._id, toRecordId: new ObjectId(), origin: "cell", createdAt: new Date() });
    r = await call(reconcileScript, ["--verify", "--all", ...local]);
    assert.equal(r.code, 1); assert.deepEqual(r.out.total, { missing: 1, extra: 1 });
    await call(reconcileScript, ["--apply", "--all", "--pause-ms", "0", ...local]);
    assert.equal((await call(reconcileScript, ["--verify", "--all", ...local])).code, 0);
    // A drifted index definition: the readiness check fails closed and verify / apply stop.
    await db.collection(COLLECTION).dropIndex("to_board");
    assert.equal((await checkRecordLinks(db)).ok, false);
    r = await call(reconcileScript, ["--apply", "--all", "--pause-ms", "0", ...local]);
    assert.equal(r.code, 1); assert.equal(r.out.reason, "index-missing:to_board");
    // Cells were never changed by any of this (only linkGuard counters on drifted records, never values or version).
    const now = JSON.stringify(await db.collection("records").find({}, { projection: { values: 1, version: 1 } }).sort({ _id: 1 }).toArray());
    assert.equal(now, cells, "reconcile never writes a cell");
    // Output never carries values or link IDs.
    assert.doesNotMatch(JSON.stringify(r.out), new RegExp(ts[0]._id.toHexString()));
  });

  test("argument checks: one board or all, a connection, a database", () => {
    assert.throws(() => reconcileScript.parseArgs(["--verify", "--local", "--db", "x"]), /--board <id> or --all/);
    assert.throws(() => reconcileScript.parseArgs(["--verify", "--all", "--db", "x"]), /--local or --uri-env/);
    assert.throws(() => reconcileScript.parseArgs(["--verify", "--all", "--local"]), /--db/);
    assert.throws(() => reconcileScript.parseArgs(["--apply", "--board", "ABC", "--local", "--db", "x"]), /board ID/);
    assert.equal(reconcileScript.parseArgs(["--all", "--local", "--db", "x"]).mode, "report", "read-only by default");
  });
});
