// The Atlas GridFS verification script (scripts/verify-gridfs-atlas.js), run OFFLINE on the fake database: its
// refusals (no confirmation, wrong host, a user with access beyond the test database, a non-empty test database),
// its database fence, its clean-up, and that it never logs the connection string. The connection string points at
// 127.0.0.1:1 and the client is injected, so nothing here can reach a real cluster.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { EventEmitter } = require("events");
const { FakeMongoClient } = require("./support/fake-mongo");
const script = require("../scripts/verify-gridfs-atlas");

const HOST = "127.0.0.1:1";
const URI = `mongodb://offline_fake_user:s3cret-Passw0rd@${HOST}/?appName=jarc-gridfs-verify`;
const ARGS = [`--expected-host=${HOST}`, "--confirm-database=jarc_gfsv_test"];
const testUserAuth = { authenticatedUsers: [{ user: "offline_fake_user", db: "admin" }], authenticatedUserRoles: [{ role: "readWrite", db: "jarc_gfsv_test" }], authenticatedUserPrivileges: [{ resource: { db: "jarc_gfsv_test", collection: "" }, actions: ["find", "insert", "update", "remove", "createCollection", "createIndex", "dropCollection", "listCollections", "listIndexes", "dbStats"] }] };
const productionAuth = { authenticatedUsers: [{ user: "app", db: "admin" }], authenticatedUserRoles: [{ role: "readWrite", db: "jarc_database" }], authenticatedUserPrivileges: [{ resource: { db: "jarc_database", collection: "" }, actions: ["find", "insert"] }] };

// The fake database behind a MongoClient-like surface (command monitoring, admin commands, collection drop).
function offlineClient({ authInfo = testUserAuth, fake = new FakeMongoClient() } = {}) {
  const client = new EventEmitter();
  client.fake = fake; client.created = 0; client.closed = false;
  client.connect = async () => client;
  client.close = async () => { client.closed = true; };
  client.startSession = () => fake.startSession();
  client.db = (name) => {
    const db = fake.db(name);
    if (db.__offline) return db;
    db.__offline = true;
    const emit = (commandName) => client.emit("commandStarted", { databaseName: name, commandName });
    db.command = async (cmd) => {
      const op = Object.keys(cmd)[0];
      emit(op);
      if (op === "buildInfo") return { version: "offline" };
      if (op === "connectionStatus") return { authInfo };
      if (op === "listDatabases") return { databases: [...fake.dbs.entries()].filter(([, d]) => d.created.size).map(([n]) => ({ name: n })) };
      if (op === "dbStats") return { dataSize: 0, indexSize: 0 };
      throw new Error(`offline client: unsupported command ${op}`);
    };
    const collection = db.collection.bind(db);
    db.collection = (c) => {
      const col = collection(c);
      if (col.__offline) return col;
      col.__offline = true;
      for (const [method, op] of [["insertOne", "insert"], ["insertMany", "insert"], ["updateOne", "update"], ["updateMany", "update"], ["deleteOne", "delete"], ["deleteMany", "delete"], ["findOneAndUpdate", "findAndModify"], ["createIndex", "createIndexes"], ["bulkWrite", "update"]]) { const f = col[method].bind(col); col[method] = (...a) => { emit(op); return f(...a); }; }
      col.drop = async () => { emit("drop"); db.collections.delete(c); db.created.delete(c); return true; };
      return col;
    };
    return db;
  };
  return client;
}
const runWith = async (client, argv = ARGS) => { const lines = []; const result = await script.run({ argv, uri: URI, createClient: () => client, log: (l) => lines.push(l) }); return { ...result, lines }; };

describe("Atlas GridFS verification script (offline)", () => {
  test("refuses without the exact database confirmation or the matching host — before creating a client", async () => {
    let created = 0;
    const tryRun = (argv, uri = URI) => script.run({ argv, uri, createClient: () => { created += 1; return offlineClient(); }, log: () => {} });
    await assert.rejects(tryRun([`--expected-host=${HOST}`]), /--confirm-database=jarc_gfsv_test/);
    await assert.rejects(tryRun([`--expected-host=${HOST}`, "--confirm-database=jarc_database"]), /--confirm-database=jarc_gfsv_test/);
    await assert.rejects(tryRun(["--confirm-database=jarc_gfsv_test"]), /--expected-host/);
    await assert.rejects(tryRun(["--expected-host=receiptflow.example.mongodb.net", "--confirm-database=jarc_gfsv_test"]), /is not receiptflow\.example\.mongodb\.net/);
    assert.equal(created, 0, "no client was created");
  });

  test("reads only server/.env.gridfs-test (never server/.env or MONGODB_URI) and refuses when it is missing", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-gridfs-atlas.js"), "utf8");
    assert.doesNotMatch(source.replace(/\/\/.*$/gm, ""), /MONGODB_URI|["']\.env["']|writeFileSync|appendFileSync|dropDatabase\(/, "no production env, no file writes, no dropDatabase call");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarc-gfsv-"));
    assert.throws(() => script.readTestUri(path.join(dir, ".env.gridfs-test")), /not found/);
    fs.writeFileSync(path.join(dir, ".env.gridfs-test"), "MONGODB_URI=mongodb://prod.invalid/\n");
    assert.throws(() => script.readTestUri(path.join(dir, ".env.gridfs-test")), /no JARC_GRIDFS_TEST_URI/, "a production-style variable is not accepted");
    fs.writeFileSync(path.join(dir, ".env.gridfs-test"), `JARC_GRIDFS_TEST_URI=${URI}\n`);
    assert.equal(script.readTestUri(path.join(dir, ".env.gridfs-test")), URI);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("REFUSES a user with access to jarc_database (or any other database) before writing anything", async () => {
    const client = offlineClient({ authInfo: productionAuth });
    await assert.rejects(runWith(client), /not limited to jarc_gfsv_test.*database "jarc_database"/);
    assert.equal(client.closed, true);
    assert.deepEqual([...client.fake.dbs.values()].flatMap((d) => [...d.created]), [], "nothing was created anywhere");
    for (const auth of [
      { ...testUserAuth, authenticatedUserPrivileges: [...testUserAuth.authenticatedUserPrivileges, { resource: { db: "", collection: "" }, actions: ["find"] }] },
      { ...testUserAuth, authenticatedUserPrivileges: [...testUserAuth.authenticatedUserPrivileges, { resource: { cluster: true }, actions: ["dropDatabase"] }] },
      { ...testUserAuth, authenticatedUserPrivileges: [{ resource: { anyResource: true }, actions: ["anyAction"] }] }
    ]) assert.ok(script.privilegeProblems(auth).length, JSON.stringify(auth.authenticatedUserPrivileges.at(-1)));
    assert.deepEqual(script.privilegeProblems(testUserAuth), []);
  });

  test("a full run touches only jarc_gfsv_test (and read-only admin commands), passes every check, and leaves it empty", async () => {
    const client = offlineClient();
    const { failed, results, commands, lines } = await runWith(client);
    assert.equal(failed, 0, lines.filter((l) => l.startsWith("FAIL")).join("\n"));
    assert.ok(results.length >= 18, `${results.length} checks`);
    assert.deepEqual([...new Set(client.fake.requestedDbNames)].sort(), ["admin", "jarc_gfsv_test"], "no other database was ever opened");
    assert.deepEqual([...new Set(commands.filter((c) => c.db === "admin").map((c) => c.name))].sort(), ["buildInfo", "connectionStatus", "listDatabases"]);
    assert.deepEqual([...client.fake.db("jarc_gfsv_test").created], [], "the test database is empty afterwards");
    assert.equal(client.closed, true);
    const output = lines.join("\n");
    assert.doesNotMatch(output, /s3cret|offline_fake_user:|mongodb:\/\//, "never logs the connection string or credentials");
  });

  test("refuses to start on a non-empty test database; --clean-only empties it (and touches nothing else)", async () => {
    const client = offlineClient();
    await client.db("jarc_gfsv_test").collection("leftover").insertOne({ x: 1 });
    client.fake.db("jarc_gfsv_test").created.add("leftover");
    await assert.rejects(runWith(client), /already holds 1 collection/);
    assert.ok(client.fake.db("jarc_gfsv_test").created.has("leftover"), "nothing dropped by the refused run");
    const cleaned = await runWith(offlineClient({ fake: client.fake }), [...ARGS, "--clean-only"]); // a fresh run, same data
    assert.equal(cleaned.failed, 0, cleaned.lines.join("\n"));
    assert.deepEqual([...client.fake.db("jarc_gfsv_test").created], []);
    assert.deepEqual([...new Set(client.fake.requestedDbNames)].sort(), ["admin", "jarc_gfsv_test"]);
  });

  test("a failure mid-run still empties the test database and leaves other databases untouched", async () => {
    const client = offlineClient();
    const other = client.fake.db("jarc_database");
    await other.collection("records").insertOne({ keep: true });
    other.created.add("records");
    client.fake.failNext({ collection: "attachments", op: "insertOne" }); // the first upload's metadata write fails
    const lines = [];
    await assert.rejects(script.run({ argv: ARGS, uri: URI, createClient: () => client, log: (l) => lines.push(l) }), /Uploads failed/);
    assert.ok(lines.some((l) => l.startsWith("FAIL  upload report.pdf")), "the failure is reported");
    assert.ok(lines.some((l) => /^PASS {2}jarc_gfsv_test emptied/.test(l)), lines.join("\n"));
    assert.equal(client.closed, true);
    assert.deepEqual([...client.fake.db("jarc_gfsv_test").created], []);
    assert.deepEqual(other.collection("records").docs.map((d) => d.keep), [true], "jarc_database untouched");
  });
});
