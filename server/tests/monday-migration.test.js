// monday.com → JARC one-time migration engine (Phase M2), entirely offline. Synthetic extractions are written to a
// temporary folder with a valid manifest; the real private extraction (monday-extraction/) is used only if present,
// and only counts are asserted. Covers: source verification (checksums, completeness, shapes), every column rule
// (mirror snapshots, Engineer labels, status labels, dates, people, relations, files, cleared/deleted values),
// sub-items, updates/replies (HTML, automation, unknown authors, duplicates, orphans), verified-only user mapping,
// attachments, determinism, the locked write path (authorization, resume, conflicts, verification), imported comments
// in the comment service, and that a dry run makes no database, network or file-system writes outside its output.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { ObjectId, MongoClient } = require("mongodb");
const { dryRun } = require("../src/migration/monday");
const { loadExtraction, SourceError } = require("../src/migration/monday/source");
const { buildPlan } = require("../src/migration/monday/transform");
const { validatePlan, planDigest } = require("../src/migration/monday/validate");
const { htmlToText, mentionIds } = require("../src/migration/monday/html");
const { writeReports } = require("../src/migration/monday/report");
const executor = require("../src/migration/monday/executor");
const { CommentService } = require("../src/services/comment-service");

const { fixture, columns, BOARD } = require("./support/monday-migration-fixture");

const cleanups = [];
const tmp = (dir) => { cleanups.push(dir); return dir; };
after(() => { for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true }); });

describe("source verification", () => {
  test("rejects tampered files, incomplete extractions and unsafe input", () => {
    const dir = tmp(fixture());
    fs.appendFileSync(path.join(dir, "items.json"), " ");
    assert.throws(() => loadExtraction(dir), (e) => e instanceof SourceError && /checksum/.test(e.message));
    const inc = tmp(fixture());
    const m = JSON.parse(fs.readFileSync(path.join(inc, "extraction-manifest.json"))); m.completeness = "INCOMPLETE"; fs.writeFileSync(path.join(inc, "extraction-manifest.json"), JSON.stringify(m));
    assert.throws(() => loadExtraction(inc), /INCOMPLETE/);
    const bad = tmp(fixture((d) => { d["items.json"][0].id = "1000; drop"; }));
    assert.throws(() => loadExtraction(bad), /invalid ID/);
    const proto = tmp(fixture((d) => { d["items.json"][0].column_values[0] = JSON.parse('{"id":"subitems","type":"subtasks","__proto__":{"x":1}}'); }));
    assert.throws(() => loadExtraction(proto), SourceError);
    const foreign = tmp(fixture((d) => { d["items.json"][0].board = { id: "381293194" }; }));
    assert.throws(() => loadExtraction(foreign), /another board/);
  });
});

describe("dry run on a synthetic extraction", () => {
  let r, dir;
  before(() => { dir = tmp(fixture()); r = dryRun(dir); });
  const rec = (n) => r.plan.records.find((x) => x.migration.sourceItemId === String(1000 + n));
  const key = (id) => `m_${id}`;

  test("passes, accounts for every object and keeps the board native and editable", () => {
    assert.equal(r.validation.ok, true, JSON.stringify(r.validation.errors.slice(0, 3)));
    assert.deepEqual(r.validation.counts, { items: 14, subitems: 2, updates: 3, replies: 1 });
    assert.equal(r.plan.board.source, undefined);
    assert.equal(r.plan.board.legacyId, "monday-board-5176133833");
    assert.equal(r.plan.board.migration.sourceBoardId, BOARD);
    assert.deepEqual(r.plan.board.groups.map((g) => g.name), ["Warehouse", "Installed"]); // monday group order (position)
    assert.equal(rec(1).groupId, r.plan.board.migration.groups.find((g) => g.sourceGroupId === "topics").groupId);
    assert.equal(rec(0).legacyId, "monday-item-1000");
    assert.equal(rec(0).createdAt.toISOString(), "2024-01-01T00:00:00.000Z");
    assert.ok(rec(1).position > rec(0).position);
  });

  test("is deterministic: same IDs and the same digest on every run", () => {
    const again = dryRun(dir);
    assert.equal(again.digest, r.digest);
    assert.deepEqual(again.plan.records.map((x) => x._id.toHexString()), r.plan.records.map((x) => x._id.toHexString()));
  });

  test("every source column has an explicit decision", () => {
    const planned = new Map(r.plan.columnPlan.main.map((p) => [p.sourceColumnId, p.handling]));
    for (const c of columns) assert.ok(planned.has(c.id), c.id);
    assert.equal(planned.get("subitems"), "companion-board");
    assert.equal(planned.get("mirror46"), "mirror-snapshot");
    assert.equal(planned.get("board_relation_self"), "same-board-relation");
    assert.equal(planned.get("connect_boards9"), "connected-board-snapshot");
  });

  test("Engineer labels stay verbatim text and are never people", () => {
    const col = r.plan.board.columns.find((c) => c.key === key("status9__1"));
    assert.equal(col.type, "text");
    assert.equal(rec(0).values[key("status9__1")], "Pat Fictional");
    assert.equal(rec(1).values[key("status9__1")], "VACANT - NL");
    assert.equal(rec(2).values[key("status9__1")], "pat fictional"); // capitalisation kept
    assert.ok(!JSON.stringify(rec(0).values).includes("user:"));
    // a label deleted in monday.com: blank (as monday shows it), raw index preserved and reported
    assert.equal(rec(3).values[key("status9__1")], "");
    assert.equal(JSON.parse(rec(3).migration.preserved.status9__1.value).index, 7);
    assert.ok(r.validation.info.some((i) => i.code === "status-label-deleted-in-source" && i.sourceId === "1003"));
  });

  test("status labels: exact duplicates listed once, spelling variants kept, raw index preserved", () => {
    const col = r.plan.board.columns.find((c) => c.key === key("fal_group3"));
    assert.deepEqual(col.options, ["FOR REPAIR", "For Repair", "WAREHOUSE"]);
    assert.deepEqual(col.colors, ["#e2445c", "#fdab3d", ""]);
    assert.equal(rec(4).values[key("fal_group3")], "WAREHOUSE");
    assert.deepEqual(rec(4).migration.preserved.fal_group3, { type: "status", index: 3 });
  });

  test("mirror and connected-board snapshots; same-board links resolve to JARC records", () => {
    assert.equal(rec(0).values[key("mirror46")], "C-001");
    assert.equal(rec(7).values[key("mirror46")], "");
    assert.ok(r.validation.info.some((i) => i.code === "mirror-linked-value-empty" && i.sourceId === "1007"));
    assert.equal(rec(0).values[key("connect_boards9")], "Clinic A");
    assert.deepEqual(rec(0).migration.preserved.connect_boards9.linkedItemIds, ["900"]);
    const rel = rec(8).migration.relations[0];
    assert.deepEqual(rel.sourceItemIds, ["1001"]);
    assert.ok(rel.recordIds[0].equals(rec(1)._id));
    assert.match(r.plan.board.columns.find((c) => c.key === key("mirror46")).description, /Snapshot/);
  });

  test("dates, files, people, item ID, creation log and long text", () => {
    assert.equal(rec(5).values[key("date27")], "2024-03-05");
    assert.deepEqual(rec(5).migration.preserved.date27, { type: "date", date: "2024-03-05", time: "10:00:00" });
    assert.equal(rec(9).values[key("files1")], "a.jpg");
    assert.match(r.plan.board.columns.find((c) => c.key === key("files1")).label, /not migrated/);
    assert.equal(rec(9).migration.preserved.files1.files[0].assetId, "555");
    assert.ok(r.validation.info.some((i) => i.code === "source-value-cleared" && i.sourceId === "1010"));
    assert.deepEqual(rec(11).values[key("person")], ["Ana"]); // name text only, no user reference
    assert.equal(rec(0).values[key("item_id")], "1000");
    assert.equal(rec(12).values[key("long_text__1")], "Line 1\nLine 2");
    assert.ok(r.validation.info.some((i) => i.code === "source-value-cleared" && i.sourceId === "1013" && i.column === "long_text__1"));
  });

  test("sub-items: companion board with a resolvable parent reference", () => {
    assert.equal(r.plan.subRecords.length, 2);
    for (const s of r.plan.subRecords) {
      assert.ok(s.boardId.equals(r.plan.subBoard._id));
      assert.ok(s.migration.parent.recordId.equals(rec(2)._id));
      assert.equal(s.values.parent_monday_id, "1002");
      assert.equal(s.values.parent_item, "Unit 2");
    }
    assert.equal(r.plan.subBoard.source, undefined);
  });

  test("updates: safe plain text, automation as system identity, unknown authors not invented, replies threaded", () => {
    const c = (id) => r.plan.comments.find((x) => (x.imported.sourceReplyId || x.imported.sourceUpdateId) === id && (id === "3101" ? x.parentId : !x.parentId));
    const u1 = c("3001");
    assert.equal(u1.body, "Hello team & @Ana");
    assert.doesNotMatch(u1.body, /<|alert/);
    assert.equal(u1.imported.bodySource, "html-converted");
    assert.deepEqual(u1.imported.mentionedSourceUserIds, ["12"]);
    assert.deepEqual(u1.mentions, []);
    assert.equal(u1.imported.attachments[0].status, "not-migrated");
    assert.equal(u1.authorId, null); assert.equal(u1.authorName, "Ana");
    const auto = c("3002");
    assert.equal(auto.imported.systemGenerated, true); assert.equal(auto.authorName, "monday.com automation");
    const unknown = c("3003");
    assert.equal(unknown.authorName, null); assert.equal(unknown.imported.author.kind, "unknown");
    assert.ok(unknown.recordId.equals(r.plan.subRecords[0]._id));
    assert.equal(unknown.body, "[This monday.com update had no text]");
    const reply = c("3101");
    assert.ok(reply.parentId.equals(u1._id)); assert.ok(reply.recordId.equals(u1.recordId));
    assert.equal(u1.createdAt.toISOString(), "2024-05-01T00:00:00.000Z");
  });

  test("attachments are traceable references only; limits and unsupported types reported", () => {
    const a = r.validation.attachments;
    assert.equal(a.untraceable, 0); assert.equal(a.storedInJarc, 0);
    assert.equal(a.overLimit.count, 1); assert.equal(a.unsupported.heic, 1);
    assert.equal(a.duplicateReferences, 1);
    assert.ok(a.references.every((x) => x.status === "not-migrated"));
  });
});

describe("validation catches broken sources", () => {
  const run = (mutate) => dryRun(tmp(fixture(mutate)));
  const codes = (res) => res.validation.errors.map((e) => e.code);
  test("missing parent, orphan update, duplicates and count mismatches are errors", () => {
    assert.ok(codes(run((d) => { d["subitems.json"][0].parent_item.id = "1999"; })).includes("subitem-parent-missing"));
    assert.ok(codes(run((d) => { d["updates.json"].updates[1]._source_item_id = "1999"; d["updates.json"].updates[1].item_id = "1999"; })).includes("update-orphan"));
    assert.ok(codes(run((d) => { d["updates.json"].updates.push({ ...d["updates.json"].updates[1] }); })).includes("duplicate-source-update"));
    assert.ok(codes(run((d) => { d["items.json"].push(d["items.json"][0]); })).includes("duplicate-source-item"));
    assert.ok(codes(run((d, counts) => { counts.items = 15; })).includes("count-mismatch"));
    assert.ok(codes(run((d) => { d["items.json"][0].column_values = d["items.json"][0].column_values.filter((c) => c.id !== "text"); })).includes("column-value-missing"));
  });
  test("invalid values are errors, never coerced", () => {
    const res = run((d) => { d["items.json"][0].column_values.find((c) => c.id === "date27").value = JSON.stringify({ changed_at: "x" }); d["items.json"][0].column_values.find((c) => c.id === "date27").text = "sometime"; });
    assert.ok(codes(res).includes("date-unparseable"));
    const res2 = run((d) => { d["columns.json"].item_columns.find((c) => c.id === "status9__1").title = "Region"; });
    assert.ok(codes(res2).includes("column-plan"));
  });
});

describe("verified user mapping only", () => {
  const dir = () => tmp(fixture());
  const oid = new ObjectId().toHexString();
  test("a confirmed mapping links authors; names and emails are never used to match", () => {
    const plain = dryRun(dir());
    assert.equal(plain.plan.comments.filter((c) => c.authorId).length, 0);
    const mapped = dryRun(dir(), { confirmedUsers: { version: 1, entries: [{ sourceUserId: "12", jarcUserId: oid, method: "entra-object-id", verifiedBy: "Admin", verifiedAt: "2026-10-28T00:00:00Z" }] } });
    const u1 = mapped.plan.comments.find((c) => c.imported.sourceUpdateId === "3001" && !c.parentId);
    assert.equal(u1.authorId.toHexString(), oid);
    assert.deepEqual(mapped.plan.records.find((x) => x.migration.sourceItemId === "1011").values.m_person, [`user:${oid}`]);
    assert.equal(mapped.plan.identity.template().candidates.length, 2);
  });
  test("invalid mapping files are refused as a whole", () => {
    const bad = (entries) => dryRun(dir(), { confirmedUsers: { version: 1, entries } }).validation.errors.map((e) => e.code);
    const e = { jarcUserId: oid, method: "admin-verified", verifiedBy: "Admin", verifiedAt: "2026-10-28T00:00:00Z" };
    assert.ok(bad([{ ...e, sourceUserId: "-4" }]).includes("user-mapping-file-invalid"));
    assert.ok(bad([{ ...e, sourceUserId: "11" }, { ...e, sourceUserId: "12" }]).includes("user-mapping-file-invalid"));
    assert.ok(bad([{ ...e, sourceUserId: "12", method: "display-name" }]).includes("user-mapping-file-invalid"));
    assert.ok(bad([{ ...e, sourceUserId: "12", verifiedBy: "" }]).includes("user-mapping-file-invalid"));
  });
});

describe("HTML to plain text", () => {
  test("never keeps markup or script contents; decodes entities; keeps mentions as text", () => {
    assert.equal(htmlToText("<div>a<br>b</div><style>x{}</style><script>bad()</script><img src=x onerror=y>"), "a\nb\n[image]");
    assert.equal(htmlToText("&lt;script&gt; &#65;&#x42; &unknown; &nbsp;x"), "<script> AB &unknown; x");
    assert.equal(htmlToText("<ul><li>one</li><li>two</li></ul>"), "• one\n• two");
    assert.equal(htmlToText("<p>open <b"), "open");
    assert.equal(htmlToText("a‮b\u0000c"), "abc");
    assert.deepEqual(mentionIds('<a data-mention-id="5">@A</a><a data-mention-id=\'5\'>@A</a>'), ["5"]);
  });
});

describe("write planning (pure)", () => {
  let r;
  before(() => { r = dryRun(tmp(fixture())); });
  test("production execution is disabled and an unverified target is refused before any call", async () => {
    assert.equal(executor.PRODUCTION_EXECUTION_ENABLED, false);
    const client = new Proxy({}, { get: () => assert.fail("the client must not be used") });
    await assert.rejects(() => executor.runImport({ client, target: { scope: "local-test", dbName: "jarc_migration_test", instanceId: "x".repeat(20) }, plan: r.plan, planDigest: r.digest, approval: {} }), (e) => e.code === "MIGRATION_TARGET_UNVERIFIED");
  });
  test("resume after an interrupted run skips completed work; disagreeing mappings stop the run", () => {
    const all = executor.remainingBatches(r.plan, [], { batchSize: 5 });
    assert.equal(all[0].step, "boards");
    assert.equal(all.filter((b) => b.step === "records").reduce((s, b) => s + b.records.length, 0), 14);
    // simulate: boards and the first records batch (with its comments) committed, then the process died
    const doneBatch = all[1];
    const existing = [...r.plan.mappings.filter((m) => m.kind === "board" || m.kind === "subitems-board"), ...doneBatch.records.map((x) => r.plan.mappings.find((m) => m.targetId.equals(x._id))), ...doneBatch.comments.map((c) => r.plan.mappings.find((m) => m.targetId.equals(c._id)))].map((m) => ({ kind: m.kind, sourceId: m.sourceId, targetId: m.targetId.toHexString() }));
    const rest = executor.remainingBatches(r.plan, existing, { batchSize: 5 });
    assert.equal(rest.some((b) => b.step === "boards"), false);
    const restIds = new Set(rest.filter((b) => b.step === "records").flatMap((b) => b.records.map((x) => x._id.toHexString())));
    assert.equal(rest.filter((b) => b.step === "subitems").reduce((s, b) => s + b.records.length, 0), 2);
    for (const x of doneBatch.records) assert.equal(restIds.has(x._id.toHexString()), false);
    assert.equal(restIds.size + doneBatch.records.length, 14);
    const conflict = [{ ...existing[2], targetId: new ObjectId().toHexString() }];
    assert.throws(() => executor.remainingBatches(r.plan, conflict), (e) => e.code === "MIGRATION_MAPPING_CONFLICT");
  });
  test("batch verification detects missing and unexpected documents", () => {
    const b = executor.remainingBatches(r.plan, [])[1];
    assert.deepEqual(executor.verifyBatch(b, { records: b.records, comments: b.comments }), []);
    assert.equal(executor.verifyBatch(b, { records: b.records.slice(1), comments: [...b.comments, { _id: new ObjectId() }] }).length, 2);
  });
  test("the CLI refuses a production-scope approval (exit 3, nothing written)", () => {
    const file = path.join(tmp(fs.mkdtempSync(path.join(os.tmpdir(), "jarc-mm-appr-"))), "approval.json");
    fs.writeFileSync(file, JSON.stringify({ kind: "monday-migration-approval", version: 2, scope: "production", planDigest: r.digest, targetDatabase: "jarc_database" }));
    const res = spawnSync(process.execPath, [path.join(__dirname, "../scripts/monday-migrate.js"), "execute", "--approval", file], { encoding: "utf8", timeout: 120000 });
    assert.equal(res.status, 3, res.stdout + res.stderr); assert.match(res.stdout, /REFUSED|production execution is disabled/);
    const usage = spawnSync(process.execPath, [path.join(__dirname, "../scripts/monday-migrate.js"), "execute"], { encoding: "utf8" });
    assert.equal(usage.status, 2);
  });
});

describe("a dry run writes nothing and calls nothing", () => {
  test("no database connection, no network, extraction unchanged, no secrets in reports", async () => {
    const dir = tmp(fixture());
    const hash = () => fs.readdirSync(dir).map((f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex")).join();
    const before = hash();
    const calls = [];
    const saved = { connect: MongoClient.prototype.connect, fetch: globalThis.fetch, sock: net.Socket.prototype.connect };
    MongoClient.prototype.connect = function () { calls.push("mongo"); throw new Error("no db"); };
    globalThis.fetch = () => { calls.push("fetch"); throw new Error("no network"); };
    net.Socket.prototype.connect = function () { calls.push("socket"); throw new Error("no network"); };
    process.env.MONDAY_API_TOKEN_TEST_CANARY = "canary-token-0123456789";
    let result;
    try { result = dryRun(dir); } finally { MongoClient.prototype.connect = saved.connect; globalThis.fetch = saved.fetch; net.Socket.prototype.connect = saved.sock; }
    assert.deepEqual(calls, []);
    assert.equal(hash(), before);
    const out = tmp(fs.mkdtempSync(path.join(os.tmpdir(), "jarc-mm-out-")));
    writeReports(out, result);
    for (const f of fs.readdirSync(out)) assert.doesNotMatch(fs.readFileSync(path.join(out, f), "utf8"), /canary-token|mongodb(\+srv)?:\/\//, f);
    delete process.env.MONDAY_API_TOKEN_TEST_CANARY;
    const cli = spawnSync(process.execPath, [path.join(__dirname, "../scripts/monday-migrate.js"), "dry-run", "--source", dir, "--out", path.join(dir, "inside")], { encoding: "utf8" });
    assert.equal(cli.status, 2); // output inside the extraction is refused
  });
  test("the CLI dry run completes offline", () => {
    const dir = tmp(fixture()), out = tmp(fs.mkdtempSync(path.join(os.tmpdir(), "jarc-mm-cli-")));
    const res = spawnSync(process.execPath, [path.join(__dirname, "../scripts/monday-migrate.js"), "dry-run", "--source", dir, "--out", out], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /database writes 0, network requests 0/);
    for (const f of ["dry-run-report.json", "migration-report.md", "errors.json", "warnings.json", "column-mapping.json", "user-mapping-report.json", "attachments-plan.json", "views.json"]) assert.ok(fs.existsSync(path.join(out, f)), f);
  });
});

describe("imported comments in the comment service", () => {
  const actor = { userId: new ObjectId(), displayName: "Me", isSystemAdmin: false };
  const recordId = new ObjectId(), workspaceId = new ObjectId();
  const imported = { _id: new ObjectId(), workspaceId, boardId: new ObjectId(), recordId, parentId: null, authorId: null, authorName: "monday.com automation", body: "Status changed", mentions: [], createdAt: new Date("2024-05-01"), updatedAt: new Date("2024-05-01"), editedAt: null, deletedAt: null, deletedBy: null, version: 1, imported: { provider: "monday.com", systemGenerated: true } };
  const attributedToMe = { ...imported, _id: new ObjectId(), authorId: actor.userId, imported: { provider: "monday.com", systemGenerated: false } };
  const service = (role = null) => new CommentService({ repos: { comments: { findById: async (id) => [imported, attributedToMe].find((c) => c._id.equals(id)) || null, insert: async (d) => d }, activities: { append: async () => {} } }, connection: { withTransaction: async (fn) => fn({}) }, access: { roleIn: async () => role, shared: false } });
  test("lists safely with no JARC author, and never as editable", () => {
    const api = service().toApi(imported, actor, false);
    assert.equal(api.author.id, null); assert.equal(api.author.name, "monday.com automation");
    assert.equal(api.canEdit, false); assert.equal(api.canDelete, false);
    assert.deepEqual(api.imported, { provider: "monday.com", systemGenerated: true });
    const mine = service().toApi(attributedToMe, actor, false);
    assert.equal(mine.author.isYou, false); assert.equal(mine.canEdit, false); assert.equal(mine.canDelete, false); // attribution grants nothing
  });
  test("cannot be edited; only a moderator deletes; replies to them work", async () => {
    await assert.rejects(() => service().update(actor, { comment: attributedToMe, record: { _id: recordId }, board: {} }, { body: "x", expectedVersion: 1 }), /historical/);
    await assert.rejects(() => service().remove(actor, { comment: imported, record: { _id: recordId, workspaceId }, board: {} }), /workspace admin/);
    const reply = await service().create(actor, { record: { _id: recordId, workspaceId, boardId: imported.boardId }, board: {} }, { body: "Thanks", parentId: imported._id.toHexString() });
    assert.equal(reply.parentId, imported._id.toHexString());
  });
});

// The real private extraction, when present on this machine (never in CI). Counts only; nothing is printed.
const REAL = path.join(__dirname, "../../monday-extraction");
describe("the private Phase M1 extraction", { skip: !fs.existsSync(path.join(REAL, "extraction-manifest.json")) && "monday-extraction/ is not present" }, () => {
  test("all 4,688 items, 26 sub-items, 1,471 updates and 5 replies map with no blocking errors", () => {
    const r = dryRun(REAL);
    assert.equal(r.validation.ok, true, JSON.stringify(r.validation.summary));
    assert.deepEqual(r.validation.counts, { items: 4688, subitems: 26, updates: 1471, replies: 5 });
    assert.equal(r.validation.attachments.untraceable, 0);
    assert.equal(r.validation.attachments.plannedReferences, 6083);
    assert.equal(r.validation.relationUnresolved, 0);
    assert.equal(r.plan.subRecords.filter((s) => s.migration.parent.recordId).length, 26);
    assert.equal(r.plan.comments.filter((c) => c.imported.systemGenerated).length, 1171);
    assert.equal(r.plan.board.columns.length, 84); // 81 from the source + 3 native Files columns (Phase M4.1)
    assert.equal(r.plan.board.columns.filter((c) => c.type === "files").length, 3);
    assert.equal(r.plan.attachments.length, 6031);
    assert.equal(planDigest(r.plan), r.digest);
  });
});
