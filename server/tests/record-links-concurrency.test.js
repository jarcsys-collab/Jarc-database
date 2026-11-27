// recordLinks single writer under CONCURRENCY, against a REAL MongoDB (the isolated local test instance on 127.0.0.1:27027,
// single-node replica set; throwaway databases removed afterwards; skipped when the instance isn't running; never server/.env).
// Doc 25 findings:
//   1  link save vs delete / archive of the linked record (TOCTOU): a plain find inside a transaction does NOT protect (shown);
//      the link guard (a conditional write on each newly linked record inside the write transaction) does — deterministic
//      interleavings plus many random races: never a committed link to a record whose delete / archive committed first.
//   2  reconcile --apply vs concurrent edits: re-read + compare-and-set per record; never stale rows, never a cell overwritten.
//   4  two-way prototype (linkPair / unpair): authz required (fail closed), caps, archived, board scope, activity, concurrent pairs.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto"), fs = require("fs"), net = require("net"), path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
const { MongoConnection } = require("../src/db/connection");
const { ensureRecordLinks, RecordLinkService, COLLECTION } = require("../src/relations/record-links");

const ENV_FILE = path.resolve(__dirname, "..", "..", ".env.migration-test");
function localUri() {
  if (process.env.JARC_MIGRATION_TEST_MONGODB_URI) return process.env.JARC_MIGRATION_TEST_MONGODB_URI;
  if (!fs.existsSync(ENV_FILE)) return null;
  const match = /^\s*JARC_MIGRATION_TEST_MONGODB_URI\s*=\s*(\S+)/m.exec(fs.readFileSync(ENV_FILE, "utf8"));
  return match ? match[1] : null;
}
const portOpen = () => new Promise((resolve) => { const s = net.connect({ host: "127.0.0.1", port: 27027 }); s.once("connect", () => { s.end(); resolve(true); }); s.once("error", () => resolve(false)); setTimeout(() => { s.destroy(); resolve(false); }, 1000); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ITERATIONS = Number(process.env.JARC_RACE_ITERATIONS || 150);

describe("recordLinks concurrency on the local test MongoDB", { concurrency: false }, async () => {
  const uri = localUri();
  if (!uri || !(await portOpen())) { test("local test instance not running: SKIPPED, nothing proven here", { skip: true }, () => {}); return; }
  assert.match(uri, /^mongodb:\/\/[^@]+@127\.0\.0\.1:27027\//, "never anything but this machine");
  let client;
  const dbNames = [];
  before(async () => { client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 20 }); await client.connect(); });
  after(async () => { for (const n of dbNames) await client.db(n).dropDatabase().catch(() => {}); await client?.close(); });
  const fresh = async () => {
    const dbName = `jarc_migration_test_c${crypto.randomBytes(6).toString("hex")}`;
    dbNames.push(dbName);
    const connection = new MongoConnection({ uri: "mongodb://127.0.0.1:27027", dbName: "jarc_database", monitor: null, createClient: () => ({ connect: async () => {}, close: async () => {}, db: () => client.db(dbName), startSession: (...a) => client.startSession(...a) }) });
    await connection.connect();
    const db = client.db(dbName);
    await ensureRecordLinks(db);
    await db.createCollection("activities");
    return { db, connection };
  };
  const boards = () => {
    const target = { _id: new ObjectId(), workspaceId: new ObjectId(), columns: [{ key: "serial", type: "text" }, { key: "back", type: "connect", link: { boardId: null } }] };
    const host = { _id: new ObjectId(), workspaceId: new ObjectId(), columns: [{ key: "serial", type: "text" }, { key: "client", type: "connect", multiple: true, link: { boardId: target._id.toHexString() } }] };
    target.columns[1].link.boardId = host._id.toHexString();
    return { host, target };
  };
  const rec = (board, values = {}) => ({ _id: new ObjectId(), boardId: board._id, workspaceId: board.workspaceId, values: { serial: "x", ...values }, archived: false, version: 1 });
  const cellOf = async (db, id, key = "client") => (await db.collection("records").findOne({ _id: id }))?.values?.[key];
  const rowsTo = (db, id) => db.collection(COLLECTION).countDocuments({ toRecordId: id });

  test("why a write is needed: a plain find inside a snapshot transaction does NOT stop a concurrent archive or delete", async () => {
    const { db, connection } = await fresh();
    const { host, target } = boards();
    const h = rec(host, { client: [] });
    const ta = rec(target), td = rec(target);
    await db.collection("records").insertMany([h, ta, td]);
    // The pattern finding 1 rejects: check inside the transaction with a read, then write. Another writer commits in between.
    for (const [t, act] of [[ta, () => db.collection("records").updateOne({ _id: ta._id }, { $set: { archived: true } })], [td, () => db.collection("records").deleteOne({ _id: td._id })]]) {
      await connection.withTransaction(async (session) => {
        const seen = await db.collection("records").findOne({ _id: t._id, archived: { $ne: true } }, { session });
        assert.ok(seen, "the read inside the transaction sees the record");
        await act(); // commits at once: a read takes no write lock, so nothing conflicts
        await db.collection("records").updateOne({ _id: h._id }, { $addToSet: { "values.client": t._id.toHexString() } }, { session });
      });
    }
    const cell = await cellOf(db, h._id);
    assert.ok(cell.includes(ta._id.toHexString()) && (await db.collection("records").findOne({ _id: ta._id })).archived === true, "committed a link to a record archived first");
    assert.ok(cell.includes(td._id.toHexString()) && !(await db.collection("records").findOne({ _id: td._id })), "committed a link to a record deleted first");
  });

  test("link guard, deterministic: delete / archive committed during the check window → refused, nothing written", async () => {
    const { db, connection } = await fresh();
    const { host, target } = boards();
    const h = rec(host, { client: [] }), ta = rec(target), td = rec(target);
    await db.collection("records").insertMany([h, ta, td]);
    for (const [t, act, reason] of [[ta, () => db.collection("records").updateOne({ _id: ta._id }, { $set: { archived: true }, $inc: { version: 1 } }), /archived/], [td, () => new RecordLinkService({ db, connection }).deleteRecord(target._id, td._id), /isn't on the linked board/]]) {
      let once = false;
      const links = new RecordLinkService({ db, connection, pause: async (step) => { if (step === "before-guard" && !once) { once = true; await act(); } } });
      await assert.rejects(() => links.setLinks(host, h._id, "client", [t._id.toHexString()], 1), (e) => e.status === 400 && reason.test(e.message));
      assert.deepEqual(await cellOf(db, h._id), [], "cell unchanged");
      assert.equal((await db.collection("records").findOne({ _id: h._id })).version, 1, "version unchanged");
      assert.equal(await rowsTo(db, t._id), 0, "no row");
    }
  });

  test("link guard, deterministic: delete / archive started AFTER the guard waits for the link, then the delete's cascade removes it", async () => {
    const { db, connection } = await fresh();
    const { host, target } = boards();
    const h = rec(host, { client: [] }), ta = rec(target), td = rec(target);
    await db.collection("records").insertMany([h, ta, td]);
    // Archive outside a transaction during the window: it waits for the link's commit, then applies (serial order link → archive).
    let archive, archivedAt = null, linkedAt = null;
    const a = new RecordLinkService({ db, connection, pause: async (step) => { if (step === "before-write" && !archive) { archive = db.collection("records").findOneAndUpdate({ _id: ta._id }, { $set: { archived: true } }, { returnDocument: "before" }).then((r) => { archivedAt = process.hrtime.bigint(); return r; }); await sleep(300); } } });
    await a.setLinks(host, h._id, "client", [ta._id.toHexString()], 1);
    linkedAt = process.hrtime.bigint();
    const pre = await archive;
    const preDoc = pre && pre.value !== undefined && !pre._id ? pre.value : pre;
    assert.equal(preDoc.linkGuard, 1, "the archive applied AFTER the link (its before-image holds the link's guard write)");
    assert.ok(archivedAt >= linkedAt - 50_000_000n, "the archive didn't finish before the link committed");
    // Delete (with its cascade, one transaction) during the window: WriteConflict → retried after the link commits → the cascade
    // sees the committed row and pulls the ID from the cell.
    let del;
    const d = new RecordLinkService({ db, connection, pause: async (step) => { if (step === "before-write" && !del) { del = new RecordLinkService({ db, connection }).deleteRecord(target._id, td._id); await sleep(300); } } });
    await d.setLinks(host, h._id, "client", [ta._id.toHexString(), td._id.toHexString()], 2);
    assert.deepEqual(await del, { own: 0, pulled: 1, more: false });
    assert.deepEqual(await cellOf(db, h._id), [ta._id.toHexString()], "deleted record pulled from the cell");
    assert.equal(await rowsTo(db, td._id), 0);
    assert.equal(await db.collection("records").countDocuments({ _id: td._id }), 0);
  });

  test(`link guard, random races (${ITERATIONS}× each): link save vs delete, vs archive (outside and inside a transaction) — never a link to a record removed first`, async () => {
    const { db, connection } = await fresh();
    const { host, target } = boards();
    const links = new RecordLinkService({ db, connection });
    const stats = { del: { linked: 0, refused: 0 }, archive: { linked: 0, refused: 0 }, archiveTx: { linked: 0, refused: 0 } };
    // The link save makes several round trips, the delete / archive fewer: the destructive side starts after a random delay
    // spread across the save's duration, so both orders (and true overlaps) happen; both outcomes are asserted below.
    let spread = 12;
    const jitter = (() => { let n = 0; return () => sleep((n++ % 2) ? Math.floor(Math.random() * spread) : 0); })();
    for (let i = 0; i < ITERATIONS; i++) {
      const h = rec(host, { client: [] }), t1 = rec(target), t2 = rec(target), t3 = rec(target);
      await db.collection("records").insertMany([h, t1, t2, t3]);
      // 1) delete (+ cascade) vs link
      let r = await Promise.allSettled([(async () => { await jitter(); return links.setLinks(host, h._id, "client", [t1._id.toHexString()], 1); })(), (async () => { await jitter(); return links.deleteRecord(target._id, t1._id); })()]);
      assert.equal(r[1].status, "fulfilled", String(r[1].reason));
      if (r[0].status === "fulfilled") stats.del.linked += 1; else { assert.equal(r[0].reason.status, 400, String(r[0].reason)); stats.del.refused += 1; }
      assert.ok(!(await cellOf(db, h._id)).includes(t1._id.toHexString()), `iteration ${i}: a cell holds a deleted record`);
      assert.equal(await rowsTo(db, t1._id), 0, `iteration ${i}: a row points at a deleted record`);
      // 2) archive outside a transaction vs link; witness: the archive's before-image shows whether the link came first.
      const v = (await db.collection("records").findOne({ _id: h._id })).version;
      r = await Promise.allSettled([(async () => { await jitter(); return links.setLinks(host, h._id, "client", [t2._id.toHexString()], v); })(), (async () => { await jitter(); return db.collection("records").findOneAndUpdate({ _id: t2._id }, { $set: { archived: true } }, { returnDocument: "before" }); })()]);
      const pre = r[1].value && r[1].value.value !== undefined && !r[1].value._id ? r[1].value.value : r[1].value;
      if (r[0].status === "fulfilled") { stats.archive.linked += 1; assert.equal(pre.linkGuard, 1, `iteration ${i}: a link committed although the archive came first`); }
      else { assert.equal(r[0].reason.status, 400, String(r[0].reason)); stats.archive.refused += 1; assert.equal(pre.linkGuard, undefined); assert.ok(!(await cellOf(db, h._id)).includes(t2._id.toHexString())); }
      // 3) archive inside a transaction (as a batch edit would) vs link.
      const v2 = (await db.collection("records").findOne({ _id: h._id })).version;
      let preTx = null;
      r = await Promise.allSettled([(async () => { await jitter(); return links.setLinks(host, h._id, "client", [...(await cellOf(db, h._id)), t3._id.toHexString()], v2); })(), (async () => { await jitter(); return connection.withTransaction(async (session) => { preTx = await db.collection("records").findOne({ _id: t3._id }, { session }); await db.collection("records").updateOne({ _id: t3._id, archived: false }, { $set: { archived: true } }, { session }); }); })()]);
      assert.equal(r[1].status, "fulfilled", String(r[1].reason));
      if (r[0].status === "fulfilled") { stats.archiveTx.linked += 1; assert.equal(preTx.linkGuard, 1, `iteration ${i}: transactional archive serialized before a committed link`); }
      else if (r[0].reason.status === 409) { /* the read of the cell raced its own previous write: not a link outcome */ }
      else { assert.equal(r[0].reason.status, 400, String(r[0].reason)); stats.archiveTx.refused += 1; assert.equal(preTx.linkGuard, undefined); }
      // Rows always equal cells.
      assert.deepEqual(await links.reconcile(host), { scanned: i + 1, missing: 0, extra: 0, applied: false }, `iteration ${i}: index drift`);
    }
    test.diagnostic?.(JSON.stringify(stats));
    process.stdout.write(`# race outcomes ${JSON.stringify(stats)}\n`);
    for (const k of ["del", "archive"]) assert.ok(stats[k].linked > 0 && stats[k].refused > 0, `${k}: both orders must occur for the race to prove anything ${JSON.stringify(stats)}`);
  });

  test("reconcile --apply: re-read + compare-and-set; a concurrent edit is never undone and the index converges (deterministic + random)", async () => {
    const { db, connection } = await fresh();
    const { host, target } = boards();
    const targets = Array.from({ length: 6 }, () => rec(target));
    const hosts = Array.from({ length: 40 }, (_, i) => rec(host, { client: targets.slice(0, (i % 5) + 1).map((t) => t._id.toHexString()) }));
    await db.collection("records").insertMany([...targets, ...hosts]);
    const t = targets.map((x) => x._id.toHexString());
    // Old behaviour, for contrast: rows synced from a page read BEFORE a concurrent edit are stale.
    const plain = new RecordLinkService({ db, connection });
    const stalePage = await db.collection("records").findOne({ _id: hosts[0]._id });
    await plain.setLinks(host, hosts[0]._id, "client", [t[5]], 1);
    await plain.syncRecord(host, stalePage);
    assert.ok((await plain.reconcile(host)).extra > 0, "syncing a stale page undoes the newer edit's rows (the old apply)");
    await plain.reconcile(host, { apply: true });
    // Deterministic: an edit commits between the repair's read and its compare-and-set → conflict → re-read → newer value wins.
    await db.collection(COLLECTION).deleteMany({ fromRecordId: hosts[1]._id });
    let edit;
    const racing = new RecordLinkService({ db, connection, pause: async (step) => { if (step === "repair-after-read" && !edit) { edit = plain.setLinks(host, hosts[1]._id, "client", [t[4]], 1); await edit; } } });
    await racing.reconcile(host, { apply: true });
    assert.deepEqual(await cellOf(db, hosts[1]._id), [t[4]], "the employee's edit stays");
    assert.deepEqual(await plain.reconcile(host), { scanned: 40, missing: 0, extra: 0, applied: false });
    // Random: wipe the index, then reconcile --apply while 4 writers edit cells through the single writer.
    await db.collection(COLLECTION).deleteMany({});
    const last = new Map();
    let stop = false;
    const writer = async (seed) => {
      let s = seed;
      const rnd = (n) => { s = (s * 1103515245 + 12345) % 2147483648; return s % n; };
      while (!stop) {
        const h = hosts[rnd(hosts.length)];
        const doc = await db.collection("records").findOne({ _id: h._id });
        const ids = [...new Set(Array.from({ length: rnd(4) }, () => t[rnd(t.length)]))];
        try { const { record } = await plain.setLinks(host, h._id, "client", ids, doc.version); last.set(h._id.toHexString(), { v: record.version, ids }); } catch (e) { if (e.status !== 409) throw e; }
      }
    };
    const writers = [1, 2, 3, 4].map((n) => writer(n * 7919));
    for (let round = 0; round < 3; round++) await new RecordLinkService({ db, connection }).reconcile(host, { apply: true });
    stop = true;
    await Promise.all(writers);
    for (const [id, { v, ids }] of last) {
      const doc = await db.collection("records").findOne({ _id: new ObjectId(id) });
      if (doc.version === v) assert.deepEqual(doc.values.client, ids, "reconcile never changes a cell");
    }
    await plain.reconcile(host, { apply: true }); // records nobody touched after the wipe and that a round missed
    assert.deepEqual(await plain.reconcile(host), { scanned: 40, missing: 0, extra: 0, applied: false }, "converged");
    // Wrong-board rows are integrity drift too: found and repaired.
    await db.collection(COLLECTION).updateOne({ fromRecordId: hosts[2]._id }, { $set: { toBoardId: new ObjectId() } });
    assert.ok((await plain.reconcile(host)).extra >= 1);
    await plain.reconcile(host, { apply: true });
    assert.deepEqual(await plain.reconcile(host), { scanned: 40, missing: 0, extra: 0, applied: false });
  });

  test("setLinks validates inside the transaction: caps, self link, wrong column, missing / archived ids; stored dangling ids dropped and reported", async () => {
    const { db, connection } = await fresh();
    const { host, target } = boards();
    const h = rec(host, { client: [] }), t1 = rec(target), t2 = rec(target), arch = { ...rec(target), archived: true }, other = rec(host);
    await db.collection("records").insertMany([h, t1, t2, arch, other]);
    const links = new RecordLinkService({ db, connection });
    const hex = (d) => d._id.toHexString();
    await assert.rejects(() => links.setLinks(host, h._id, "serial", [hex(t1)], 1), (e) => e.status === 400);
    await assert.rejects(() => links.setLinks(host, h._id, "client", [hex(h)], 1), (e) => e.status === 400 && /itself/.test(e.message));
    await assert.rejects(() => links.setLinks(host, h._id, "client", Array.from({ length: 101 }, () => new ObjectId().toHexString()), 1), (e) => e.status === 400);
    await assert.rejects(() => links.setLinks(host, h._id, "client", [hex(t1), hex(t1)], 1), (e) => e.status === 400);
    await assert.rejects(() => links.setLinks(host, h._id, "client", [hex(other)], 1), (e) => e.status === 400, "a record of another board");
    await assert.rejects(() => links.setLinks(host, h._id, "client", [hex(arch)], 1), (e) => e.status === 400 && /archived/.test(e.message));
    const single = { ...host, columns: host.columns.map((c) => (c.key === "client" ? { ...c, multiple: false } : c)) };
    await assert.rejects(() => links.setLinks(single, h._id, "client", [hex(t1), hex(t2)], 1), (e) => e.status === 400 && /only one/.test(e.message));
    assert.equal((await links.setLinks(host, h._id, "client", [hex(t1), hex(t2)], 1)).dropped, 0);
    await db.collection("records").deleteOne({ _id: t2._id }); // deleted without the cascade (today's delete paths)
    const { record, dropped } = await links.setLinks(host, h._id, "client", [hex(t1), hex(t2)], 2);
    assert.equal(dropped, 1);
    assert.deepEqual(record.values.client, [hex(t1)]);
    assert.equal((await db.collection("records").findOne({ _id: t1._id })).version, 1, "the guard never bumps the linked record's version");
  });

  test("two-way prototype: authz required on both boards, caps, archived, board scope, activity (IDs only), concurrent pairs", async () => {
    const { db, connection } = await fresh();
    const { host, target } = boards();
    const h1 = rec(host, { client: [] }), h2 = rec(host, { client: [] }), t1 = rec(target, { back: [] }), t2 = rec(target, { back: [] }), ta = { ...rec(target, { back: [] }), archived: true };
    await db.collection("records").insertMany([h1, h2, t1, t2, ta]);
    const links = new RecordLinkService({ db, connection });
    const A = (r) => ({ board: host, recordId: r._id, columnKey: "client" }), B = (r) => ({ board: target, recordId: r._id, columnKey: "back" });
    const yes = { canEditValues: () => true }, hostOnly = { canEditValues: (b) => String(b._id) === String(host._id) };
    const snapshot = async () => JSON.stringify(await db.collection("records").find({}).sort({ _id: 1 }).toArray()) + await db.collection(COLLECTION).countDocuments() + await db.collection("activities").countDocuments();
    const s0 = await snapshot();
    await assert.rejects(() => links.linkPair(A(h1), B(t1)), (e) => e.status === 403, "no authz → fail closed");
    await assert.rejects(() => links.linkPair(A(h1), B(t1), { authz: hostOnly }), (e) => e.status === 403, "edit on the target board is required");
    await assert.rejects(() => links.linkPair(A(h1), B(ta), { authz: yes }), (e) => e.status === 400 && /archived/.test(e.message));
    await assert.rejects(() => links.linkPair(A(h1), { board: target, recordId: t1._id, columnKey: "serial" }, { authz: yes }), (e) => e.status === 400);
    assert.equal(await snapshot(), s0, "refusals write nothing");
    const actor = { userId: new ObjectId(), displayName: "Synthetic" };
    const pairId = await links.linkPair(A(h1), B(t1), { authz: yes, actor });
    const acts = await db.collection("activities").find({}).toArray();
    assert.equal(acts.length, 2, "one entry per side");
    assert.ok(acts.every((e) => e.action === "record.updated" && e.changes.length === 1 && e.changes[0].to.every((x) => /^[0-9a-f]{24}$/.test(x))), "IDs only");
    // Single column on the far side already holds a link → refused; an existing pair → 409.
    await assert.rejects(() => links.linkPair(A(h2), B(t1), { authz: yes }), (e) => e.status === 400 && /only one/.test(e.message));
    await assert.rejects(() => links.linkPair(A(h1), B(t1), { authz: yes }), (e) => e.status === 409);
    // Board scope: a pairId asked from an unrelated board → 404, nothing changed.
    await assert.rejects(() => links.unpair(pairId, { boardId: new ObjectId(), authz: yes }), (e) => e.status === 404);
    await assert.rejects(() => links.unpair(pairId, { boardId: host._id, authz: hostOnly }), (e) => e.status === 403);
    assert.equal(await db.collection(COLLECTION).countDocuments({ pairId }), 2);
    assert.equal(await links.unpair(pairId, { boardId: target._id, authz: yes, actor }), 2);
    assert.deepEqual(await cellOf(db, h1._id), []);
    assert.deepEqual(await cellOf(db, t1._id, "back"), []);
    assert.equal(await db.collection("activities").countDocuments(), 4);
    // Concurrent pairs of the same two records: exactly one wins; the index matches the cells.
    for (let i = 0; i < 20; i++) {
      const x = rec(host, { client: [] }), y = rec(target, { back: [] });
      await db.collection("records").insertMany([x, y]);
      const r = await Promise.allSettled([links.linkPair(A(x), B(y), { authz: yes }), links.linkPair(A(x), B(y), { authz: yes })]);
      assert.equal(r.filter((o) => o.status === "fulfilled").length, 1, JSON.stringify(r.map((o) => o.reason?.status)));
      assert.ok(r.filter((o) => o.status === "rejected").every((o) => o.reason.status === 409));
      assert.deepEqual(await cellOf(db, x._id), [y._id.toHexString()]);
      assert.equal(await db.collection(COLLECTION).countDocuments({ $or: [{ fromRecordId: x._id }, { fromRecordId: y._id }] }), 2);
    }
  });
});
