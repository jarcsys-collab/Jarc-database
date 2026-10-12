// One-off verification of the Files column (GridFS) on a real MongoDB Atlas cluster, inside ONE dedicated test
// database (jarc_gfsv_test), using a dedicated, temporary Atlas user that can only reach that database.
//
//   1. Put the TEST user's connection string in server/.env.gridfs-test (git- and Docker-ignored):
//        JARC_GRIDFS_TEST_URI=mongodb+srv://<test user>:<password>@<cluster host>/?appName=jarc-gridfs-verify
//   2. node scripts/verify-gridfs-atlas.js --expected-host=<cluster host> --confirm-database=jarc_gfsv_test
//      (add --clean-only to just empty jarc_gfsv_test, e.g. after an interrupted run)
//
// Safety (each enforced in code, before or during the run):
//   - Never reads server/.env or MONGODB_URI, and never writes any file. The URI is never printed (errors are redacted).
//   - Refuses unless --confirm-database names the test database exactly and the URI's host equals --expected-host.
//   - Asks Atlas which privileges the user has, and refuses before writing anything unless EVERY privilege is on
//     jarc_gfsv_test alone (so a production user, or one that can see jarc_database or ReceiptFlow, is refused).
//   - The client can only open jarc_gfsv_test; any attempt to open another database throws. On "admin" only the
//     read-only commands buildInfo, connectionStatus and listDatabases can be sent.
//   - Refuses if jarc_gfsv_test already holds collections (unless --clean-only).
//   - Clean-up drops jarc_gfsv_test's collections one by one (no dropDatabase, which a readWrite user can't run
//     anyway), also after a failure, then confirms the database is empty.
//   - Every command is recorded; the run fails if any write targets another database.
// It runs the real app code (bootstrap, data layer, file service, HTTP routes) with the development actor on
// 127.0.0.1 only, so no Microsoft sign-in is involved and nothing is reachable from outside this computer.
const path = require("path"), fs = require("fs"), crypto = require("crypto"), http = require("http");
const { MongoClient, ObjectId } = require("mongodb");

const TEST_DB = "jarc_gfsv_test";
const ENV_FILE = path.join(__dirname, "..", ".env.gridfs-test");
const ADMIN_COMMANDS = new Set(["buildInfo", "connectionStatus", "listDatabases"]);
const WRITES = new Set(["insert", "update", "delete", "findAndModify", "create", "createIndexes", "drop", "dropDatabase", "dropIndexes", "renameCollection", "collMod"]);
const redact = (text) => String(text || "").replace(/mongodb(\+srv)?:\/\/\S+/gi, "<connection string>");
const hostOf = (uri) => (String(uri).match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/) || [])[1] || null;

function readTestUri(file = ENV_FILE) {
  if (!fs.existsSync(file)) throw new Error(`Refusing to run: ${path.basename(file)} not found (it holds the TEST user's connection string).`);
  const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find((l) => /^\s*JARC_GRIDFS_TEST_URI\s*=/.test(l));
  const uri = line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : "";
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) throw new Error(`Refusing to run: ${path.basename(file)} has no JARC_GRIDFS_TEST_URI.`);
  return uri;
}

// Every privilege must be on the test database only (no cluster-wide, any-database or other-database privileges).
function privilegeProblems(authInfo) {
  const problems = [];
  for (const p of authInfo?.authenticatedUserPrivileges || []) {
    const r = p.resource || {};
    if (r.anyResource) problems.push("a privilege on any resource");
    else if (r.cluster) problems.push(`cluster-wide privileges (${(p.actions || []).slice(0, 4).join(", ")}…)`);
    else if (r.db !== TEST_DB) problems.push(`privileges on ${r.db === "" ? "every database" : `database "${r.db}"`}`);
  }
  if (!(authInfo?.authenticatedUsers || []).length) problems.push("no authenticated user");
  return [...new Set(problems)];
}

// Minimal stand-in for MongoConnection (which, by design, only ever opens jarc_database).
const connectionFor = (client, db) => ({
  db, isConnected: true, ping: async () => true, close: async () => {},
  async withTransaction(fn) { const session = client.startSession(); try { return await session.withTransaction(() => fn(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }); } finally { await session.endSession(); } }
});

async function run({ argv = process.argv.slice(2), uri = null, createClient = (u, o) => new MongoClient(u, o), log = console.log } = {}) {
  const flag = (name) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
  if (flag("confirm-database") !== TEST_DB) throw new Error(`Refusing to run: confirm the database with --confirm-database=${TEST_DB}.`);
  const expectedHost = flag("expected-host");
  if (!expectedHost) throw new Error("Refusing to run: give the cluster host with --expected-host=<host>.");
  const testUri = uri ?? readTestUri();
  if (hostOf(testUri) !== expectedHost) throw new Error(`Refusing to run: the test connection's host (${hostOf(testUri) || "none"}) is not ${expectedHost}.`);
  const cleanOnly = argv.includes("--clean-only");

  const results = [], commands = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
  const client = createClient(testUri, { serverSelectionTimeoutMS: 15000, appName: "jarc-gridfs-verify", monitorCommands: true });
  client.on("commandStarted", (e) => commands.push({ db: e.databaseName, name: e.commandName }));
  // Hard limit: only the test database can be opened; "admin" only for three read-only commands.
  const openDb = client.db.bind(client);
  const adminDb = openDb("admin");
  const admin = { command: (cmd) => { const name = Object.keys(cmd)[0]; if (!ADMIN_COMMANDS.has(name)) throw new Error(`Blocked admin command ${name}.`); return adminDb.command(cmd); } };
  client.db = (name) => { if (name !== TEST_DB) throw new Error(`Blocked: this script may only open ${TEST_DB} (asked for ${name}).`); return openDb(name); };

  // owns: this run found the test database empty and started writing to it, so only then may it clean up.
  let server = null, verified = false, owns = false;
  const db = client.db(TEST_DB);
  const collectionNames = async () => (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
  const cleanUp = async () => {
    for (const name of await collectionNames()) if (!name.startsWith("system.")) await db.collection(name).drop().catch((e) => { if (e?.codeName !== "NamespaceNotFound") throw e; });
    const left = await collectionNames();
    check(`${TEST_DB} emptied (collections dropped one by one)`, left.length === 0, left.length ? `left: ${left.join(", ")}` : "");
  };
  try {
    await client.connect();
    // 1. Who is this? Read-only checks before anything is written.
    const status = await admin.command({ connectionStatus: 1, showPrivileges: true });
    const problems = privilegeProblems(status.authInfo);
    const roles = (status.authInfo?.authenticatedUserRoles || []).map((r) => `${r.role}@${r.db}`).join(", ") || "none";
    if (problems.length) throw new Error(`Refusing to run: this user is not limited to ${TEST_DB} (has ${problems.join("; ")}; roles: ${roles}). Use the temporary test user.`);
    verified = true;
    const build = await admin.command({ buildInfo: 1 });
    const visible = (await admin.command({ listDatabases: 1, nameOnly: true, authorizedDatabases: true })).databases.map((d) => d.name).sort();
    log(`Cluster ${expectedHost}, MongoDB ${build.version}. User roles: ${roles}. Databases this user can see: ${visible.join(", ") || "(none yet)"}.`);
    check("the test user can reach no database except the test database", visible.every((n) => n === TEST_DB) && problems.length === 0, roles);

    if (cleanOnly) { await cleanUp(); return finish(); }
    const existing = await collectionNames();
    if (existing.length) throw new Error(`Refusing to run: ${TEST_DB} already holds ${existing.length} collection(s). Run again with --clean-only first.`);
    owns = true;

    // 2. The app's own bootstrap, data layer and HTTP routes, on the test database.
    const { ensureDatabase } = require("../src/db/bootstrap");
    const { createDataLayer } = require("../src/data-layer");
    const { createApp } = require("../src/app");
    const { ensureDevelopmentActor } = require("../src/context/dev-actor");
    const { createdCollections } = await ensureDatabase(db);
    check("bootstrap creates the Files collections", ["attachments", "attachmentFiles.files", "attachmentFiles.chunks"].every((c) => createdCollections.includes(c)));
    const indexNames = async (c) => (await db.collection(c).listIndexes().toArray()).map((i) => i.name).sort();
    const chunkIdx = (await db.collection("attachmentFiles.chunks").listIndexes().toArray()).find((i) => i.name === "files_id_1_n_1");
    check("GridFS chunk index { files_id: 1, n: 1 } is unique", Boolean(chunkIdx?.unique));
    check("GridFS files index present", (await indexNames("attachmentFiles.files")).includes("filename_1_uploadDate_1"));
    const attIdx = await indexNames("attachments");
    check("attachments has all five indexes", ["board_status", "record_column", "status_created", "uniq_upload_key", "workspace"].every((n) => attIdx.includes(n)), attIdx.join(", "));

    const logger = { error: (...a) => log(`  [server log] ${a.map(redact).join(" ")}`) };
    const dataLayer = createDataLayer({ connection: connectionFor(client, db), logger, maxFileStorageBytes: 300 * 1024 * 1024 });
    const devActor = await ensureDevelopmentActor(dataLayer.repos.users, { environment: "test" });
    const app = createApp({ environment: "test", enableDevStateApi: false, dataLayer, devActor, logger });
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const upload = async (recordId, data, type, name, key) => { const r = await fetch(`${base}/records/${recordId}/attachments?column=docs`, { method: "POST", headers: { "Content-Type": type, "X-File-Name": encodeURIComponent(name), ...(key ? { "X-Upload-Key": key } : {}) }, body: data }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

    const ws = (await call("POST", "/workspaces", { name: "GridFS verification" })).body.workspace;
    const board = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Verify", columns: [{ key: "serial", label: "Item", type: "text", required: true }, { key: "docs", label: "Docs", type: "files" }] })).body.board;
    const rec = async (s) => (await call("POST", `/boards/${board.id}/records`, { values: { serial: s } })).body.record;
    const r1 = await rec("V-1"), r2 = await rec("V-2");

    // Realistic sizes: a ~2.5 MB PDF (11 chunks) and a ~700 KB PNG (3 chunks); random bodies.
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), crypto.randomBytes(2.5 * 1024 * 1024)]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(700 * 1024)]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(50 * 1024)]);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), crypto.randomBytes(20 * 1024)]);
    const sent = [["report.pdf", pdf, "application/pdf"], ["photo.png", png, "image/png"], ["van.jpg", jpg, "image/jpeg"], ["scan.webp", webp, "image/webp"]];
    const up = {};
    for (const [n, data, type] of sent) {
      const r = await upload(r1.id, data, type, n);
      up[n] = r.body?.attachment;
      check(`upload ${n} (${Math.round(data.length / 1024)} KB)`, r.status === 201, `HTTP ${r.status}`);
    }
    if (!sent.every(([n]) => up[n])) throw new Error("Uploads failed; stopping before the download checks.");
    const chunks = db.collection("attachmentFiles.chunks"), files = db.collection("attachmentFiles.files"), atts = db.collection("attachments");
    check("PDF stored as ceil(size / 255 KB) chunks", await chunks.countDocuments({ files_id: new ObjectId(up["report.pdf"].id) }) === Math.ceil(pdf.length / (255 * 1024)));
    for (const [n, data] of sent) {
      const r = await fetch(`${base}/attachments/${up[n].id}/content`);
      const body = Buffer.from(await r.arrayBuffer());
      check(`download ${n} is byte-exact`, r.status === 200 && body.length === data.length && sha(body) === sha(data), `sha256 ${sha(body).slice(0, 12)}…`);
    }
    const hdr = await fetch(`${base}/attachments/${up["report.pdf"].id}/content?download=1`);
    await hdr.arrayBuffer();
    check("download headers (attachment, nosniff, CSP, private)", /^attachment;/.test(hdr.headers.get("content-disposition") || "") && hdr.headers.get("x-content-type-options") === "nosniff" && /default-src 'none'/.test(hdr.headers.get("content-security-policy") || "") && hdr.headers.get("cache-control") === "private, no-cache");

    const counts = async () => JSON.stringify([await chunks.countDocuments(), await files.countDocuments(), await atts.countDocuments()]);
    const beforeBad = await counts();
    check("disguised file (program declared as PDF) refused", (await upload(r1.id, Buffer.concat([Buffer.from("MZ"), crypto.randomBytes(300 * 1024)]), "application/pdf", "invoice.pdf")).status === 415);
    // Interrupted upload: announce 3 MB, send ~1 MB (several chunks reach Atlas), then drop the connection.
    await new Promise((resolve) => {
      const u = new URL(`${base}/records/${r1.id}/attachments?column=docs`);
      const req = http.request({ host: u.hostname, port: u.port, method: "POST", path: u.pathname + u.search, headers: { "Content-Type": "application/pdf", "X-File-Name": "cut.pdf", "Content-Length": String(3 * 1024 * 1024) } });
      req.on("error", () => resolve());
      req.write(Buffer.concat([Buffer.from("%PDF-1.7\n"), crypto.randomBytes(1024 * 1024)]));
      setTimeout(() => { req.destroy(); resolve(); }, 2500);
    });
    let clean = false;
    for (let i = 0; i < 40 && !clean; i += 1) { await new Promise((r) => setTimeout(r, 250)); clean = await counts() === beforeBad; }
    check("refused and interrupted uploads leave no chunks, files or metadata", clean);

    const key = crypto.randomBytes(8).toString("hex");
    const k1 = await upload(r2.id, jpg, "image/jpeg", "retry.jpg", key), k2 = await upload(r2.id, jpg, "image/jpeg", "retry.jpg", key);
    check("a retry with the same upload key stores one file", k1.status === 201 && k2.status === 200 && k2.body?.attachment?.id === k1.body?.attachment?.id && await atts.countDocuments({ recordId: new ObjectId(r2.id) }) === 1);

    const pdfId = new ObjectId(up["report.pdf"].id);
    check("deleting a file removes its metadata, GridFS file and chunks", (await call("DELETE", `/attachments/${up["report.pdf"].id}`)).status === 200 && await chunks.countDocuments({ files_id: pdfId }) === 0 && !(await files.findOne({ _id: pdfId })) && !(await atts.findOne({ _id: pdfId })));
    check("deleting a record removes its files", (await call("DELETE", `/records/${r2.id}?expectedVersion=${r2.version}`)).status === 200 && await atts.countDocuments({ recordId: new ObjectId(r2.id) }) === 0 && await files.countDocuments({ _id: new ObjectId(k1.body.attachment.id) }) === 0);
    // Orphan sweep: stored bytes with no metadata, made to look two hours old.
    const orphan = new ObjectId();
    await new Promise((resolve, reject) => { const w = dataLayer.services.files.store.openUpload(orphan, { filename: "orphan.png", contentType: "image/png" }); w.on("finish", resolve); w.on("error", reject); w.end(png); });
    await files.updateOne({ _id: orphan }, { $set: { uploadDate: new Date(Date.now() - 2 * 3600 * 1000) } });
    await dataLayer.services.files.sweep();
    check("the sweep removes stored bytes without metadata", !(await files.findOne({ _id: orphan })) && await chunks.countDocuments({ files_id: orphan }) === 0);
    const remaining = await atts.countDocuments({ status: "ready" }), stored = await files.countDocuments();
    check("files still attached are kept", remaining === 3 && stored === 3, `${remaining} attachments, ${stored} GridFS files`);
    const stats = await db.command({ dbStats: 1 });
    log(`Test database used ${Math.round(((stats.dataSize || 0) + (stats.indexSize || 0)) / 1024)} KB (data + indexes) before clean-up.`);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    try { if (verified && owns && !cleanOnly) await cleanUp(); }
    catch (error) { check(`${TEST_DB} emptied`, false, redact(error.message)); }
    finally { await client.close(); }
  }
  return finish();

  function finish() {
    const foreign = commands.filter((c) => WRITES.has(c.name) && c.db !== TEST_DB);
    check("no write, delete or index command targeted any database except the test database", foreign.length === 0, foreign.length ? JSON.stringify(foreign.slice(0, 5)) : `${commands.length} commands, databases: ${[...new Set(commands.map((c) => c.db))].sort().join(", ")}`);
    const failed = results.filter((r) => !r.ok);
    log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    return { results, commands, failed: failed.length };
  }
}

module.exports = { run, privilegeProblems, readTestUri, hostOf, TEST_DB };

if (require.main === module) {
  run().then((r) => { if (r.failed) process.exitCode = 1; }, (error) => { console.error(`Verification stopped: ${redact(error.message)}`); process.exitCode = 1; });
}
