// Machine Installation Database attachment import (services/mid-attachment-run.js), entirely offline: the fake
// database, a mock Google (tests/support/mock-google-drive) and a mock monday.com defined here. Every other URL is refused.
// Synthetic files and IDs only; no real business data.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { mockGoogle, ENV, REDIRECT } = require("./support/mock-google-drive");
const { loadGoogleDriveConfig, loadMidAttachmentsConfig } = require("../src/config");
const { normalizePlan } = require("../src/services/mid-attachment-run");
const { AttachmentImporter } = require("../src/migration/monday/attachments");

const SOURCE_RUN = "monday-1000000001-0000000000ab";
const MONDAY_TOKEN = "test-monday-token-do-not-print";
const MB = 1024 * 1024;
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "m_filesa_files", label: "Site photos", type: "files" }, { key: "m_photo_files", label: "Other photos", type: "files" }, { key: "m_update_files", label: "Files from Updates", type: "files" }];
const bytesOf = {
  pdf: (n = 3000) => Buffer.concat([Buffer.from("%PDF-1.4\n"), crypto.randomBytes(n)]),
  jpg: (n = 3000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n)]),
  png: (n = 3000) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(n)]),
  heic: (n = 3000) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), crypto.randomBytes(n)]),
  csv: () => Buffer.from("serial,site\nA1,North\nA2,South\n")
};
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// A mock monday.com: the assets query (metadata, with a signed-looking download link only when asked) and the file host.
function mockMonday() {
  const m = { assets: new Map(), apiCalls: 0, downloads: 0, fail: [], sizeOverride: new Map() };
  m.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin === "https://api.monday.com") {
      m.apiCalls += 1;
      if (init.headers?.Authorization !== MONDAY_TOKEN) return new Response(JSON.stringify({ errors: [{ message: "Not Authenticated" }] }), { status: 401 });
      const f = m.fail.findIndex((x) => x.api); if (f >= 0) { const [x] = m.fail.splice(f, 1); return new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: x.status || 500 }); }
      const { query, variables } = JSON.parse(init.body);
      const assets = (variables.ids || []).map((id) => m.assets.get(String(id))).filter(Boolean).map((a) => ({ id: a.id, file_size: m.sizeOverride.get(a.id) ?? a.bytes.length, ...(/public_url/.test(query) ? { public_url: `https://files.monday.invalid/${a.id}?signature=SECRET-SIGNATURE` } : {}) }));
      return new Response(JSON.stringify({ data: { assets } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.origin === "https://files.monday.invalid") {
      m.downloads += 1;
      const id = url.pathname.slice(1), a = m.assets.get(id);
      const f = m.fail.findIndex((x) => x.download && (!x.id || x.id === id)); if (f >= 0) { const [x] = m.fail.splice(f, 1); if (x.truncate) return new Response(a.bytes.subarray(0, x.truncate), { status: 200 }); return new Response("no", { status: x.status }); }
      return a ? new Response(a.bytes, { status: 200 }) : new Response("gone", { status: 404 });
    }
    return null;
  };
  return m;
}

const people = async (issuer) => ({ ada: issuer.person("Ada Admin", { admin: true }), mia: issuer.person("Mia Member"), jay: issuer.person("Jay Jarcadmin", { admin: true }) });

async function start({ files = 6, quota = { limit: 2048 * MB, usage: 1 * MB }, gdriveMaxMb = "100", faults = null, perPass } = {}) {
  const issuer = await createTokenIssuer(), p = await people(issuer);
  const google = mockGoogle(), monday = mockMonday();
  google.quota = quota;
  const outbound = async (url, init) => (await monday.fetch(url, init)) || google.fetch(url, init);
  const googleDrive = loadGoogleDriveConfig({ ...ENV, ATTACHMENTS_GDRIVE_MAX_TOTAL_MB: gdriveMaxMb, GOOGLE_DRIVE_ADMIN_OIDS: p.ada.oid }, "production", "entra");
  const midAttachments = loadMidAttachmentsConfig({ MID_ATTACHMENTS_MIGRATION: "true", GOOGLE_DRIVE_ENABLED: "true", MID_MIGRATION_MONDAY_TOKEN: MONDAY_TOKEN, MID_MIGRATION_CONCURRENCY: "2" });
  const app = await startEntraApp({ issuer, entra: { ...issuer.config, redirectUri: REDIRECT.replace(/api.*/, ""), appOrigin: new URL(REDIRECT).origin }, googleDrive, googleDriveOptions: { sleep: async () => {}, chunkBytes: 256 * 1024 }, attachments: { defaultProvider: "gdrive", s3: null, migrationMaxFileBytes: 20 * MB }, midAttachments, midAttachmentsOptions: { sleep: async () => {}, ...(faults ? { faults } : {}), ...(perPass ? { perPass } : {}) }, fetch: outbound });
  const client = async (person) => { const c = new SessionClient(app.url, app.entra.appOrigin); await c.signIn(person); return c; };
  const ctx = { app, issuer, google, monday, people: p, admin: await client(p.ada), member: await client(p.mia), jarcAdmin: await client(p.jay), mid: app.dataLayer.services.midAttachments };
  // Connect Google Drive the real way.
  const c = await ctx.admin.request("POST", "/api/v1/integrations/google-drive/connect");
  const { code, state } = google.approve(c.body.authorizeUrl);
  await fetch(`${app.url}/api/v1/integrations/google-drive/callback?${new URLSearchParams({ code, state })}`, { redirect: "manual", headers: { Cookie: `__Host-jarc_gdrive_oauth=${ctx.admin.cookies.get("__Host-jarc_gdrive_oauth")}` } });
  // The migrated board, its records and the records migration's mappings, as the M5 import left them.
  const ws = (await ctx.admin.request("POST", "/api/v1/workspaces", { name: "Official" })).body.workspace;
  ctx.board = (await ctx.admin.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Machine Installation Database — Migrated", columns: COLUMNS })).body.board;
  ctx.records = [];
  for (let i = 0; i < 3; i += 1) ctx.records.push((await ctx.admin.request("POST", `/api/v1/boards/${ctx.board.id}/records`, { values: { serial: `Machine ${i + 1}` } })).body.record);
  for (const [i, r] of ctx.records.entries()) await app.db.collection("integrationMappings").insertOne({ provider: "monday-migration", kind: "item", sourceId: String(1000 + i), targetId: new ObjectId(r.id), boardId: new ObjectId(ctx.board.id), runId: SOURCE_RUN, createdAt: new Date() });
  // Source files on monday.com and the plan that points them at records and Files columns.
  const kinds = [["pdf", ".pdf", "Installation report.pdf"], ["jpg", ".jpg", "Sticker.jpg"], ["png", ".png", "Screen.png"], ["heic", ".heic", "IMG_0042.HEIC"], ["jpg", ".jfif", "scan.jfif"], ["csv", ".csv", "readings.csv"]];
  ctx.entries = [];
  for (let i = 0; i < files; i += 1) {
    const [kind, ext, name] = kinds[i % kinds.length], bytes = bytesOf[kind](), id = String(9000 + i);
    monday.assets.set(id, { id, bytes });
    ctx.entries.push({ assetId: id, sourceItemId: String(1000 + (i % 3)), attachmentId: new ObjectId().toHexString(), recordId: ctx.records[i % 3].id, columnKey: ["m_filesa_files", "m_photo_files", "m_update_files"][i % 3], name: i < kinds.length ? name : `${i}-${name}`, extension: ext, sizeBytes: bytes.length, sourceCreatedAt: "2024-05-07T08:03:11Z", sourceUploadedBy: "77", linkedCommentIds: i === 2 ? ["555"] : [] });
  }
  ctx.plan = () => ({ kind: "jarc-mid-attachments-plan", version: 1, sourceRunId: SOURCE_RUN, boardId: ctx.board.id, entries: ctx.entries });
  ctx.api = (method, path, body, who = ctx.admin) => who.request(method, `/api/v1/migrations/mid-attachments${path}`, body);
  // The dry run runs in the background: start it, then wait for it the way the page does (by its check ID).
  ctx.dryRun = async (body = { plan: ctx.plan() }) => {
    const res = await ctx.api("POST", "/dry-run", body);
    if (res.status !== 202) return res;
    await ctx.mid.checks.get(res.body.checkId)?.done;
    return ctx.api("GET", `/dry-run/${res.body.checkId}`);
  };
  // Prepare from a completed dry run; its item list is written in the background.
  ctx.prepare = async () => {
    const check = await ctx.dryRun();
    const res = await ctx.api("POST", "/prepare", { checkId: check.body.checkId, confirm: true });
    await ctx.mid.preparing.get(ctx.runId);
    return res.status === 202 ? (await ctx.api("GET", `/runs/${ctx.runId}`)).body : res.body;
  };
  ctx.startRun = async (mode, extra = {}) => ctx.api("POST", `/runs/${ctx.runId}/start`, { mode, confirm: true, ...extra });
  // The mandatory pilot, for tests about the full run: a real pilot of `count` files, run to its end.
  ctx.pilot = async (count = 2) => { const r = await ctx.startRun("pilot", { count }); assert.equal(r.status, 200, JSON.stringify(r.body)); return ctx.drain(); };
  ctx.drain = async (passes = 30) => { for (let i = 0; i < passes; i += 1) { await ctx.mid.tick(); const s = (await ctx.api("GET", `/runs/${ctx.runId}`)).body; if (!["running", "rolling-back"].includes(s.status)) return s; } return (await ctx.api("GET", `/runs/${ctx.runId}`)).body; };
  ctx.migrated = () => ctx.app.db.collection("attachments").docs.filter((d) => d.imported);
  ctx.driveMig = () => ctx.google.active().filter((f) => f.appProperties?.jarcKind === "mig");
  ctx.runId = normalizePlan(ctx.plan(), { maxBytes: 20 * MB }).runId;
  return ctx;
}
const download = async (ctx, id, who = ctx.admin) => { const res = await fetch(`${ctx.app.url}/api/v1/attachments/${id}/content`, { headers: { Cookie: [...who.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } }); return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) }; };
const snapshot = (ctx, name) => JSON.stringify(ctx.app.db.collection(name).docs);

describe("configuration and the plan", () => {
  test("off by default; needs Google Drive and a monday.com token; the token never serialises", () => {
    assert.equal(loadMidAttachmentsConfig({}).enabled, false);
    assert.throws(() => loadMidAttachmentsConfig({ MID_ATTACHMENTS_MIGRATION: "yes" }), /true or false/);
    assert.throws(() => loadMidAttachmentsConfig({ MID_ATTACHMENTS_MIGRATION: "true" }), /GOOGLE_DRIVE_ENABLED/);
    assert.throws(() => loadMidAttachmentsConfig({ MID_ATTACHMENTS_MIGRATION: "true", GOOGLE_DRIVE_ENABLED: "true" }), /MID_MIGRATION_MONDAY_TOKEN/);
    assert.throws(() => loadMidAttachmentsConfig({ MID_ATTACHMENTS_MIGRATION: "true", GOOGLE_DRIVE_ENABLED: "true", MID_MIGRATION_MONDAY_TOKEN: "x", MID_MIGRATION_CONCURRENCY: "9" }), /1 to 3/);
    const on = loadMidAttachmentsConfig({ MID_ATTACHMENTS_MIGRATION: "true", GOOGLE_DRIVE_ENABLED: "true", MID_MIGRATION_MONDAY_TOKEN: MONDAY_TOKEN });
    assert.equal(on.mondayToken, MONDAY_TOKEN); assert.doesNotMatch(JSON.stringify(on), new RegExp(MONDAY_TOKEN));
  });
  test("the plan: types and names (HEIC kept, JFIF keeps its name as JPEG, CSV download-only), malformed plans refused, a stable run ID", () => {
    const base = { kind: "jarc-mid-attachments-plan", version: 1, sourceRunId: SOURCE_RUN, boardId: "a".repeat(24) };
    const e = (over) => ({ assetId: "1", sourceItemId: "2", attachmentId: "b".repeat(24), recordId: "c".repeat(24), columnKey: "m_filesa_files", name: "x.pdf", extension: ".pdf", sizeBytes: 100, ...over });
    const { plan, runId, issues } = normalizePlan({ ...base, entries: [e({ assetId: "3", attachmentId: "d".repeat(24), name: "scan.jfif", extension: ".jfif" }), e({ assetId: "4", attachmentId: "e".repeat(24), name: "IMG.HEIC", extension: ".heic" }), e({ assetId: "5", attachmentId: "f".repeat(24), name: "r.csv", extension: ".csv" }), e({ sizeBytes: 15 * MB })] }, { maxBytes: 20 * MB });
    const by = Object.fromEntries(plan.entries.map((x) => [x.assetId, x]));
    assert.deepEqual([by[3].type, by[3].plannedName, by[4].type, by[4].action, by[5].type, by[5].action, by[1].action, by[1].oversized], ["image/jpeg", "scan.jfif", "image/heic", "preserve-heic", "text/csv", "download-only", "store-oversized", true]);
    assert.equal(issues.length, 0); assert.match(runId, /^mid-[0-9a-f]{16}$/);
    assert.equal(normalizePlan({ ...base, entries: [...plan.entries].reverse().map((x) => ({ ...x, extension: `.${x.extension}` })) }, { maxBytes: 20 * MB }).runId, runId, "order doesn't change the run");
    assert.equal(normalizePlan({ ...base, entries: [e({ sizeBytes: 25 * MB })] }, { maxBytes: 20 * MB }).issues[0].problem, "larger-than-migration-limit");
    assert.equal(normalizePlan({ ...base, entries: [e({ name: "a.exe", extension: ".exe" })] }, { maxBytes: 20 * MB }).issues[0].problem, "unsupported-type");
    assert.equal(normalizePlan({ ...base, entries: [e(), e()] }, { maxBytes: 20 * MB }).issues[0].problem, "duplicate-asset-in-plan");
    for (const bad of [{}, { ...base, kind: "x" }, { ...base, entries: [] }, { ...base, entries: [e({ recordId: "nope" })] }, { ...base, sourceRunId: "x" }]) assert.throws(() => normalizePlan(bad, { maxBytes: 20 * MB }), (err) => err.code === "PLAN_INVALID");
  });
  test("the local migration tool still refuses Google Drive (Drive files are imported only by the server-side run)", () => {
    assert.throws(() => new AttachmentImporter({ provider: "gdrive" }), (err) => err.code === "MIGRATION_PROVIDER_UNSUPPORTED");
  });
  test("the shared file writer uses exactly the migration tool's names and rules, without loading the tool", () => {
    const writer = require("../src/files/migration-writer"), ids = require("../src/migration/monday/ids"), executor = require("../src/migration/monday/executor");
    assert.equal(writer.MAPPING_PROVIDER, ids.MAPPING_PROVIDER); assert.equal(writer.SOURCE_PROVIDER, ids.PROVIDER);
    assert.deepEqual([...writer.IMPORTABLE_ACTIONS].sort(), [...executor.IMPORTABLE_ACTIONS].sort());
    assert.equal(require("../src/migration/monday/compat").classifyAsset, require("../src/files/file-types").classifyAsset);
    const fs = require("fs"), path = require("path");
    for (const f of ["../src/files/migration-writer.js", "../src/services/mid-attachment-run.js", "../src/routes/mid-attachments.js"]) {
      const requires = fs.readFileSync(path.join(__dirname, f), "utf8").split(/\r?\n/).filter((l) => /require\(/.test(l)).join("\n");
      assert.doesNotMatch(requires, /migration\/monday|production-target|executor|operator-sign-in/, f);
    }
  });
});

describe("who may use it", () => {
  test("signed-out 401; employees and JARC.Admin alone 403 on every endpoint; switched off, the routes don't exist", async () => {
    const ctx = await start({ files: 2 });
    const check = (await ctx.dryRun()).body;
    const endpoints = [["GET", ""], ["POST", "/dry-run", { plan: ctx.plan() }], ["GET", `/dry-run/${check.checkId}`], ["POST", "/prepare", { checkId: check.checkId, confirm: true }], ["GET", `/runs/${ctx.runId}`], ["GET", `/runs/${ctx.runId}/verify`], ["POST", `/runs/${ctx.runId}/start`, { mode: "pilot", confirm: true }], ["POST", `/runs/${ctx.runId}/pause`], ["POST", `/runs/${ctx.runId}/resume`], ["POST", `/runs/${ctx.runId}/stop`], ["POST", `/runs/${ctx.runId}/rollback`, { confirm: `ROLLBACK ${ctx.runId}` }]];
    for (const [method, path] of endpoints) assert.equal((await fetch(`${ctx.app.url}/api/v1/migrations/mid-attachments${path}`, { method })).status, 401, `signed out ${method} ${path}`);
    for (const who of [ctx.member, ctx.jarcAdmin]) for (const [method, path, body] of endpoints) {
      const res = await ctx.api(method, path, body, who);
      assert.equal(res.status, 403, `${method} ${path}`); assert.equal(res.body.error.code, "GDRIVE_ADMIN_REQUIRED");
    }
    assert.equal(ctx.mid.checks.size, 1, "refused requests started no dry run");
    assert.equal(ctx.app.db.collection("integrationJobs").docs.length, 0, "refused requests created nothing");
    assert.equal((await ctx.api("POST", "/prepare", { checkId: check.checkId, confirm: true }, ctx.admin)).status, 202);
    await ctx.mid.preparing.get(ctx.runId);
    assert.equal(ctx.monday.downloads, 0); assert.equal(ctx.driveMig().length, 0);
    await ctx.app.close();
    const issuer = await createTokenIssuer(), p = await people(issuer);
    const off = await startEntraApp({ issuer, googleDrive: loadGoogleDriveConfig({ ...ENV, GOOGLE_DRIVE_ADMIN_OIDS: p.ada.oid }, "production", "entra"), fetch: mockGoogle().fetch });
    const admin = new SessionClient(off.url, off.entra.appOrigin); await admin.signIn(p.ada);
    assert.equal((await admin.request("GET", "/api/v1/migrations/mid-attachments")).status, 404);
    await off.app.close?.(); await off.close();
  });
});

describe("dry run (read-only)", () => {
  test("checks every file against production, Drive capacity and monday.com, and writes nothing anywhere", async () => {
    const ctx = await start();
    const before = ["attachments", "integrationJobs", "integrationMappings", "records", "storageUsage"].map((c) => snapshot(ctx, c));
    const driveCalls = ctx.google.calls.filter((c) => c.method !== "GET").length;
    const res = await ctx.dryRun({ plan: ctx.plan(), checkSources: true });
    assert.equal(res.status, 200); assert.equal(res.body.status, "completed");
    const s = res.body.result.summary;
    assert.deepEqual([s.entries, s.eligible, s.blocked, s.alreadyImported, s.recordsReceivingFiles], [6, 6, 0, 0, 3]);
    assert.equal(s.bytesToImport, ctx.entries.reduce((n, e) => n + e.sizeBytes, 0));
    assert.equal(s.capacity.enough, true); assert.equal(s.capacity.drive.freeBytes, 2047 * MB); assert.equal(s.capacity.marginBytes, 256 * MB); assert.equal(s.capacity.jarc.limitBytes, 100 * MB);
    assert.deepEqual([s.sources.available, s.sources.missing, s.sources.sizeChanged], [6, 0, 0]);
    assert.deepEqual(["attachments", "integrationJobs", "integrationMappings", "records", "storageUsage"].map((c) => snapshot(ctx, c)), before, "nothing written to the database");
    assert.equal(ctx.google.calls.filter((c) => c.method !== "GET").length, driveCalls, "nothing written to Drive");
    assert.equal(ctx.monday.downloads, 0, "no file downloaded");
    assert.doesNotMatch(JSON.stringify(res.body), /SECRET-SIGNATURE|test-monday-token|files\.monday\.invalid/);
    await ctx.app.close();
  });
  test("finds every mapping problem: unmapped item, mapping to another record, missing or archived record, wrong board, missing Files column, conflicting attachment", async () => {
    const ctx = await start();
    const other = (await ctx.admin.request("POST", `/api/v1/workspaces/${ctx.board.workspaceId}/boards`, { name: "Other", columns: COLUMNS })).body.board;
    const elsewhere = (await ctx.admin.request("POST", `/api/v1/boards/${other.id}/records`, { values: { serial: "x" } })).body.record;
    ctx.entries[0].sourceItemId = "4242";
    ctx.entries[1].recordId = ctx.records[2].id;
    ctx.entries[2].recordId = new ObjectId().toHexString();
    ctx.entries[3].columnKey = "serial";
    ctx.entries[4].recordId = elsewhere.id; ctx.entries[4].sourceItemId = "1999";
    await ctx.app.db.collection("integrationMappings").insertOne({ provider: "monday-migration", kind: "item", sourceId: "1999", targetId: new ObjectId(elsewhere.id), runId: SOURCE_RUN });
    await ctx.app.db.collection("attachments").insertOne({ _id: new ObjectId(ctx.entries[5].attachmentId), recordId: new ObjectId(ctx.records[2].id), status: "ready" });
    const check = (await ctx.dryRun()).body, { summary, problemRows: rows } = check.result;
    const problems = Object.fromEntries(rows.map((r) => [r.assetId, r.problems]));
    assert.ok(problems[9000].includes("no-record-mapping"));
    assert.ok(problems[9001].includes("mapping-differs-from-plan"));
    assert.ok(problems[9002].includes("record-missing"));
    assert.ok(problems[9003].includes("files-column-missing"));
    assert.ok(problems[9004].includes("record-on-another-board"));
    assert.ok(problems[9005].includes("conflicting-attachment-exists"));
    assert.equal(summary.blocked, 6);
    const prep = await ctx.api("POST", "/prepare", { checkId: check.checkId, confirm: true });
    assert.equal(prep.status, 409); assert.equal(prep.body.error.code, "PLAN_HAS_BLOCKED_FILES");
    assert.equal(ctx.app.db.collection("integrationJobs").docs.length, 0);
    await ctx.app.close();
  });
});

const COLLECTIONS_TOUCHED = ["attachments", "integrationJobs", "integrationMappings", "records", "storageUsage", "boards"];
const tick = () => new Promise((r) => setImmediate(r));

describe("dry run and prepare in the background (no request waits for them)", () => {
  test("the dry run answers at once, reports its progress, never runs twice, expires, and writes nothing anywhere", async () => {
    const ctx = await start();
    const real = ctx.monday.fetch; let release; const gate = new Promise((r) => { release = r; });
    ctx.monday.fetch = async (url, init) => { if (String(url).startsWith("https://api.monday.com")) await gate; return real(url, init); };
    const before = COLLECTIONS_TOUCHED.map((c) => snapshot(ctx, c)), driveCalls = ctx.google.calls.filter((c) => c.method !== "GET").length;
    const first = await ctx.api("POST", "/dry-run", { plan: ctx.plan(), checkSources: true });
    assert.equal(first.status, 202); assert.equal(first.body.status, "running"); assert.match(first.body.checkId, /^chk-[0-9a-f]{16}$/); assert.equal(first.body.runId, ctx.runId);
    const id = first.body.checkId;
    for (let i = 0; i < 200 && ctx.mid.checks.get(id).stage !== "monday.com"; i += 1) await tick();
    const progress = (await ctx.api("GET", `/dry-run/${id}`)).body;
    assert.deepEqual([progress.status, progress.stage, progress.progress, progress.result], ["running", "monday.com", { done: 0, total: 1 }, null]);
    assert.equal((await ctx.api("POST", "/dry-run", { plan: ctx.plan(), checkSources: true })).body.checkId, id, "asking again joins the running dry run");
    const other = await ctx.api("POST", "/dry-run", { plan: ctx.plan() });
    assert.equal(other.status, 409); assert.equal(other.body.error.code, "CHECK_IN_PROGRESS");
    assert.equal((await ctx.api("POST", "/prepare", { checkId: id, confirm: true })).body.error.code, "CHECK_NOT_COMPLETED");
    assert.equal(ctx.mid.checks.size, 1, "one dry run, however often it was asked for");
    release(); await ctx.mid.checks.get(id).done;
    const done = (await ctx.api("GET", `/dry-run/${id}`)).body;
    assert.equal(done.status, "completed"); assert.equal(done.result.summary.eligible, 6); assert.equal(done.result.summary.sources.available, 6); assert.deepEqual(done.result.problemRows, []);
    assert.equal(ctx.monday.apiCalls, 1, "monday.com asked once");
    assert.deepEqual(COLLECTIONS_TOUCHED.map((c) => snapshot(ctx, c)), before, "nothing written to the database");
    assert.equal(ctx.google.calls.filter((c) => c.method !== "GET").length, driveCalls, "nothing written to Drive"); assert.equal(ctx.monday.downloads, 0);
    assert.doesNotMatch(JSON.stringify([first.body, progress, done]), /SECRET-SIGNATURE|test-monday-token|files\.monday\.invalid|"entries":\[|"plan"/, "no token, link or plan in any answer");
    // A completed dry run is good for Prepare for an hour, and is kept (in memory only) for two.
    const realNow = ctx.mid.now;
    ctx.mid.now = () => new Date(Date.now() + 61 * 60 * 1000);
    assert.equal((await ctx.api("POST", "/prepare", { checkId: id, confirm: true })).body.error.code, "CHECK_TOO_OLD");
    ctx.mid.now = () => new Date(Date.now() + 121 * 60 * 1000);
    const gone = await ctx.api("GET", `/dry-run/${id}`);
    assert.equal(gone.status, 404); assert.equal(gone.body.error.code, "CHECK_NOT_FOUND"); assert.equal(ctx.mid.checks.size, 0);
    ctx.mid.now = realNow;
    assert.equal((await ctx.api("GET", "/dry-run/chk-0000000000000000")).status, 404);
    assert.equal((await ctx.api("POST", "/prepare", { confirm: true })).status, 400, "Prepare needs a dry run");
    assert.equal((await ctx.api("POST", "/dry-run", { plan: { kind: "nope" } })).body.error.code, "PLAN_INVALID", "a malformed plan is refused at once");
    assert.equal(ctx.app.db.collection("integrationJobs").docs.length, 0);
    await ctx.app.close();
  });

  test("a monday.com failure ends the dry run as failed, with a clear code and no token; nothing is written; another can start", async () => {
    const ctx = await start({ files: 2 });
    const { MondayClient } = require("../src/integrations/monday/client");
    const good = ctx.mid.monday;
    ctx.mid.monday = new MondayClient({ token: "wrong-token", fetch: ctx.mid.fetchImpl, sleep: async () => {} });
    const res = await ctx.dryRun({ plan: ctx.plan(), checkSources: true });
    assert.equal(res.body.status, "failed"); assert.equal(res.body.error.code, "MONDAY_UNAUTHORIZED"); assert.equal(res.body.result, null);
    assert.doesNotMatch(JSON.stringify(res.body), /wrong-token|test-monday-token/);
    assert.equal((await ctx.api("POST", "/prepare", { checkId: res.body.checkId, confirm: true })).body.error.code, "CHECK_NOT_COMPLETED");
    assert.equal(ctx.app.db.collection("integrationJobs").docs.length, 0);
    ctx.mid.monday = good;
    assert.equal((await ctx.dryRun({ plan: ctx.plan(), checkSources: true })).body.status, "completed", "a failed dry run doesn't block the next");
    await ctx.app.close();
  });

  test("prepare runs in the background; start waits for it; asking twice adds nothing; an interrupted prepare is finished without duplicates", async () => {
    const ctx = await start();
    const check = (await ctx.dryRun()).body;
    const jobs = ctx.app.db.collection("integrationJobs"), insertMany = jobs.insertMany.bind(jobs);
    let release; const gate = new Promise((r) => { release = r; });
    jobs.insertMany = async (...a) => { await gate; return insertMany(...a); };
    const res = await ctx.api("POST", "/prepare", { checkId: check.checkId, confirm: true });
    assert.equal(res.status, 202); assert.equal(res.body.status, "preparing"); assert.equal(res.body.prepareInterrupted, false);
    assert.equal((await ctx.startRun("pilot")).body.error.code, "RUN_NOT_STARTABLE", "no start while preparing");
    assert.equal((await ctx.api("POST", "/prepare", { checkId: check.checkId, confirm: true })).body.status, "preparing", "asking again joins it");
    release(); await ctx.mid.preparing.get(ctx.runId);
    jobs.insertMany = insertMany;
    let s = (await ctx.api("GET", `/runs/${ctx.runId}`)).body;
    assert.equal(s.status, "prepared"); assert.equal(s.counts.queued.files, 6); assert.ok(s.preparedAt);
    // A restart in the middle: the run is left "preparing" with only part of its list.
    const kept = jobs.docs.filter((j) => j.type === "mid-attachment").slice(0, 3).map((j) => JSON.stringify(j));
    await jobs.deleteMany({ type: "mid-attachment", "params.assetId": { $in: ["9003", "9004", "9005"] } });
    await jobs.updateOne({ _id: ctx.runId }, { $set: { status: "preparing" } });
    s = (await ctx.api("GET", `/runs/${ctx.runId}`)).body;
    assert.equal(s.prepareInterrupted, true);
    assert.equal((await ctx.startRun("pilot")).body.error.code, "RUN_NOT_STARTABLE");
    s = await ctx.prepare();
    assert.equal(s.status, "prepared"); assert.equal(s.counts.queued.files, 6);
    const items = jobs.docs.filter((j) => j.type === "mid-attachment");
    assert.equal(new Set(items.map((j) => j._id)).size, 6, "no duplicates");
    assert.deepEqual(items.filter((j) => kept.some((k) => JSON.parse(k)._id === j._id)).map((j) => JSON.stringify(j)), kept, "files already listed are left as they were");
    assert.equal(ctx.monday.downloads, 0); assert.equal(ctx.driveMig().length, 0);
    await ctx.app.close();
  });

  test("a file that became impossible between the dry run and prepare: the prepare fails clearly and lists nothing", async () => {
    const ctx = await start({ files: 3 });
    const check = (await ctx.dryRun()).body;
    await ctx.admin.request("DELETE", `/api/v1/records/${ctx.records[0].id}?expectedVersion=${ctx.records[0].version}`);
    assert.equal((await ctx.api("POST", "/prepare", { checkId: check.checkId, confirm: true })).status, 202);
    await ctx.mid.preparing.get(ctx.runId);
    const s = (await ctx.api("GET", `/runs/${ctx.runId}`)).body;
    assert.equal(s.status, "prepare-failed"); assert.equal(s.lastError.code, "PLAN_HAS_BLOCKED_FILES");
    assert.equal(ctx.app.db.collection("integrationJobs").docs.filter((j) => j.type === "mid-attachment").length, 0);
    assert.equal((await ctx.startRun("pilot")).body.error.code, "RUN_NOT_STARTABLE");
    await ctx.app.close();
  });

  test("a run prepared by the earlier version (backups: [], no snapshots) carries on unchanged: re-preparing adds nothing, the pilot is still required", async () => {
    const ctx = await start();
    await ctx.prepare();
    const jobs = ctx.app.db.collection("integrationJobs");
    await jobs.updateOne({ _id: ctx.runId }, { $set: { backups: [] }, $unset: { snapshots: "", preparedAt: "" } });
    const items = JSON.stringify(jobs.docs.filter((j) => j.type === "mid-attachment"));
    const again = await ctx.prepare();
    assert.equal(again.status, "prepared");
    assert.equal(JSON.stringify(jobs.docs.filter((j) => j.type === "mid-attachment")), items, "its files are left exactly as they were");
    assert.equal((await ctx.startRun("full")).body.error.code, "PILOT_REQUIRED");
    const pilot = await ctx.startRun("pilot", { count: 1 });
    assert.equal(pilot.status, 200); assert.equal(pilot.body.snapshots.length, 1);
    assert.equal((await ctx.drain()).counts.done.files, 1);
    await ctx.app.close();
  });

  test("the read-only check before starting refuses a run whose own records disagree, and starts nothing", async () => {
    const ctx = await start({ files: 2 });
    await ctx.prepare();
    await ctx.app.db.collection("integrationMappings").insertOne({ provider: "monday-migration", kind: "asset", sourceId: "9000", targetId: new ObjectId(), runId: ctx.runId, createdAt: new Date() });
    const r = await ctx.startRun("pilot");
    assert.equal(r.status, 409); assert.equal(r.body.error.code, "PRE_START_CHECK_FAILED"); assert.ok(r.body.error.details.problems.includes("asset-mappings-differ-from-imported-attachments"));
    const s = (await ctx.api("GET", `/runs/${ctx.runId}`)).body;
    assert.equal(s.status, "prepared"); assert.equal(s.snapshots.length, 0);
    await ctx.mid.tick();
    assert.equal(ctx.monday.downloads, 0); assert.equal(ctx.driveMig().length, 0);
    await ctx.app.close();
  });
});

describe("prepare, pilot and full run", () => {
  test("prepare is idempotent; no backup is asked for; the pilot is mandatory, records a read-only snapshot, imports exactly its number of files and pauses", async () => {
    const ctx = await start();
    await ctx.prepare(); await ctx.prepare();
    const jobs = ctx.app.db.collection("integrationJobs").docs;
    assert.equal(jobs.filter((j) => j.type === "mid-attachment").length, 6, "preparing twice adds nothing"); assert.equal(jobs.filter((j) => j.type === "mid-attachments-run").length, 1);
    assert.equal(jobs.find((j) => j.type === "mid-attachments-run").status, "prepared");
    assert.equal((await ctx.startRun("pilot", { confirm: false })).body.error.code, "CONFIRMATION_REQUIRED");
    assert.equal((await ctx.startRun("pilot", { backup: { reference: "x" } })).status, 400, "the old backup field isn't accepted any more");
    assert.equal((await ctx.startRun("full")).body.error.code, "PILOT_REQUIRED", "no full import before the pilot");
    assert.equal((await ctx.startRun("pilot", { count: 21 })).status, 400);
    const records = snapshot(ctx, "records"), itemMappings = JSON.stringify(ctx.app.db.collection("integrationMappings").docs);
    const started = await ctx.startRun("pilot", { count: 2 });
    assert.equal(started.status, 200);
    const snap = started.body.snapshots[0];
    assert.deepEqual([snap.mode, snap.recordsOnBoard, snap.itemMappings, snap.attachmentsTotal, snap.attachmentsOnBoard, snap.assetMappingsOfThisRun], ["pilot", 3, 3, 0, 0, 0], "read-only snapshot before starting");
    assert.equal(JSON.stringify(ctx.app.db.collection("integrationMappings").docs), itemMappings, "the snapshot wrote nothing");
    const s = await ctx.drain();
    assert.equal(s.status, "paused"); assert.equal(s.pausedReason, "pilot-finished"); assert.ok(s.pilotFinishedAt);
    assert.equal(s.counts.done.files, 2); assert.equal(s.counts.queued.files, 4);
    assert.equal(ctx.migrated().length, 2); assert.equal(ctx.driveMig().length, 2);
    const v = (await ctx.api("GET", `/runs/${ctx.runId}/verify`)).body;
    assert.equal(v.ok, true);
    assert.deepEqual([v.sinceSnapshot.recordIdsUnchanged, v.sinceSnapshot.itemMappingsUnchanged, v.sinceSnapshot.importedByThisRun.then, v.sinceSnapshot.importedByThisRun.now, v.sinceSnapshot.otherAttachments.now], [true, true, 0, 2, 0]);
    assert.equal(snapshot(ctx, "records"), records, "records untouched");
    assert.equal((await ctx.startRun("full")).status, 200, "after the pilot, the full import may start");
    const done = await ctx.drain();
    assert.equal(done.status, "completed"); assert.equal(done.snapshots.length, 2); assert.equal(done.snapshots[1].importedByThisRun.ready, 2);
    await ctx.app.close();
  });

  test("a pilot in which no file was imported doesn't open the full import", async () => {
    const ctx = await start({ files: 3 });
    await ctx.prepare();
    ctx.monday.assets.delete("9000");
    await ctx.pilot(1);
    assert.equal((await ctx.startRun("full")).body.error.code, "PILOT_REQUIRED");
    const again = await ctx.pilot(1);
    assert.equal(again.counts.done.files, 1);
    assert.equal((await ctx.startRun("full")).status, 200);
    await ctx.app.close();
  });

  test("the full run: every file on the planned record and Files column, original names and types, provenance, checksums, Drive tags; downloads through JARC; repeating adds nothing", async () => {
    const ctx = await start();
    await ctx.prepare();
    await ctx.pilot(2);
    await ctx.startRun("full");
    const s = await ctx.drain();
    assert.equal(s.status, "completed"); assert.equal(s.counts.done.files, 6);
    for (const e of ctx.entries) {
      const d = ctx.migrated().find((x) => x._id.toHexString() === e.attachmentId);
      assert.ok(d, e.name); assert.equal(d.status, "ready");
      assert.equal(d.recordId.toHexString(), e.recordId); assert.equal(d.columnKey, e.columnKey); assert.equal(d.boardId.toHexString(), ctx.board.id);
      assert.equal(d.name, e.name, "original file name kept"); assert.equal(d.size, e.sizeBytes);
      assert.equal(d.sha256, sha(ctx.monday.assets.get(e.assetId).bytes));
      assert.deepEqual([d.imported.provider, d.imported.runId, d.imported.sourceAssetId, d.imported.sourceUploadedBy, d.imported.sourceCreatedAt], ["monday.com", ctx.runId, e.assetId, "77", "2024-05-07T08:03:11Z"]);
      assert.equal(d.storage.provider, "gdrive");
      const file = ctx.google.files.get(d.storage.key);
      assert.deepEqual([file.appProperties.jarcKind, file.appProperties.jarcRun, file.appProperties.jarcAttachmentId], ["mig", ctx.runId, e.attachmentId]);
      assert.doesNotMatch(file.name, /Installation|Sticker|scan|IMG|readings/, "Drive names are internal IDs");
    }
    const byName = Object.fromEntries(ctx.migrated().map((d) => [d.name, d]));
    assert.equal(byName["scan.jfif"].type, "image/jpeg"); assert.equal(byName["IMG_0042.HEIC"].type, "image/heic"); assert.equal(byName["IMG_0042.HEIC"].imported.downloadOnly, true); assert.equal(byName["readings.csv"].type, "text/csv");
    assert.deepEqual(byName["Screen.png"].imported.linkedCommentIds, ["555"]);
    assert.equal(ctx.app.db.collection("integrationMappings").docs.filter((m) => m.kind === "asset" && m.runId === ctx.runId).length, 6);
    // Through JARC's own download endpoint: the exact bytes; HEIC and CSV as downloads, JPEG inline under its .jfif name.
    for (const name of ["Installation report.pdf", "scan.jfif", "IMG_0042.HEIC", "readings.csv"]) {
      const d = byName[name], res = await download(ctx, d._id.toHexString());
      assert.equal(res.status, 200); assert.equal(sha(res.bytes), d.sha256);
      if (name.endsWith(".HEIC") || name.endsWith(".csv")) assert.match(res.headers.get("content-disposition"), /^attachment/);
      if (name === "scan.jfif") { assert.equal(res.headers.get("content-type"), "image/jpeg"); assert.match(res.headers.get("content-disposition"), /scan\.jfif/); }
    }
    const listed = await ctx.admin.request("GET", `/api/v1/records/${ctx.records[0].id}/attachments`);
    assert.equal(listed.body.items.length, ctx.entries.filter((e) => e.recordId === ctx.records[0].id).length);
    // Repeating: preparing again is refused for a completed run, and starting finds nothing to do; no second file anywhere.
    const check = (await ctx.dryRun()).body;
    assert.equal(check.result.summary.alreadyImported, 6);
    assert.equal((await ctx.api("POST", "/prepare", { checkId: check.checkId, confirm: true })).body.error.code, "RUN_NOT_PREPARABLE");
    assert.equal((await ctx.startRun("full")).body.error.code, "RUN_NOT_STARTABLE", "a completed run can not be started again");
    assert.equal(ctx.migrated().length, 6); assert.equal(ctx.driveMig().length, 6);
    // Reconciliation, including re-downloading and re-hashing.
    const v = (await ctx.api("GET", `/runs/${ctx.runId}/verify?sample=6`)).body;
    assert.equal(v.ok, true); assert.deepEqual([v.readyAttachments, v.assetMappings, v.driveFiles, v.strayDriveFiles, v.problemCount], [6, 6, 6, 0, 0]);
    assert.ok(v.samples.every((x) => x.ok)); assert.equal(v.samples.length, 6);
    const status = await ctx.api("GET", `/runs/${ctx.runId}`);
    assert.doesNotMatch(status.text + JSON.stringify(v), new RegExp(`SECRET-SIGNATURE|${MONDAY_TOKEN}|files\\.monday\\.invalid|${[...ctx.google.files.keys()].join("|")}`), "no tokens, download links or Drive file IDs");
    await ctx.app.close();
  });

  test("pause stops new files; resume continues; stop ends the allowance; records are never changed", async () => {
    const ctx = await start({ perPass: 1 });
    const records = snapshot(ctx, "records");
    await ctx.prepare(); await ctx.startRun("pilot");
    assert.equal((await ctx.api("POST", `/runs/${ctx.runId}/pause`)).body.status, "paused");
    await ctx.mid.tick();
    assert.equal(ctx.migrated().length, 0, "nothing while paused");
    assert.equal((await ctx.api("POST", `/runs/${ctx.runId}/resume`)).body.status, "running");
    await ctx.mid.tick();
    const partial = ctx.migrated().length;
    assert.ok(partial > 0);
    assert.equal((await ctx.api("POST", `/runs/${ctx.runId}/stop`)).body.status, "stopped");
    await ctx.mid.tick();
    assert.equal(ctx.migrated().length, partial, "nothing after stopping");
    assert.equal((await ctx.api("POST", `/runs/${ctx.runId}/resume`)).body.error.code, "RUN_NOT_RESUMABLE", "a stopped run is started again, not resumed");
    await ctx.startRun("pilot");
    assert.equal((await ctx.drain()).status, "completed");
    assert.equal(snapshot(ctx, "records"), records, "no record was modified");
    await ctx.app.close();
  });
});

describe("failures, retries and recovery", () => {
  test("a crash after the file reached Drive: the lease expires, recovery removes the half-finished file and completes it once", async () => {
    const ctx = await start({ files: 3, faults: { crashAfterStore: "9001" } });
    await ctx.prepare(); await ctx.startRun("pilot");
    await assert.rejects(ctx.mid.tick(), (e) => e.simulatedCrash);
    ctx.mid.faults = null;
    const stuck = ctx.app.db.collection("integrationJobs").docs.find((j) => j._id === `${ctx.runId}:9001`);
    assert.equal(stuck.status, "running");
    await ctx.app.db.collection("integrationJobs").updateOne({ _id: stuck._id }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
    const s = await ctx.drain();
    assert.equal(s.status, "completed"); assert.equal(s.counts.done.files, 3);
    assert.equal(ctx.migrated().length, 3); assert.equal(ctx.driveMig().length, 3, "the half-finished copy went to Trash, not duplicated");
    assert.equal(ctx.google.files.size - ctx.google.folders().length - ctx.google.active().length, 1, "exactly one file in Trash");
    assert.equal((await ctx.api("GET", `/runs/${ctx.runId}/verify`)).body.ok, true);
    await ctx.app.close();
  });

  test("an interrupted Drive upload and a corrupted one are retried until stored intact", async () => {
    const ctx = await start({ files: 2 });
    await ctx.prepare(); await ctx.startRun("pilot");
    ctx.google.fail.push(...Array.from({ length: 8 }, () => ({ match: /upload_id/, status: 503 })));
    await ctx.mid.tick();
    let s = (await ctx.api("GET", `/runs/${ctx.runId}`)).body;
    assert.ok(s.counts.retry?.files >= 1, "retry scheduled"); assert.ok(s.failures.some((f) => f.error.code === "STORAGE_UNAVAILABLE"));
    ctx.google.fail.length = 0; ctx.google.corruptNextUpload = true;
    await ctx.app.db.collection("integrationJobs").updateMany({ type: "mid-attachment", status: "retry" }, { $set: { runAfter: new Date(0) } });
    for (let i = 0; i < 6; i += 1) { await ctx.app.db.collection("integrationJobs").updateMany({ type: "mid-attachment", status: "retry" }, { $set: { runAfter: new Date(0) } }); await ctx.mid.tick(); }
    s = (await ctx.api("GET", `/runs/${ctx.runId}`)).body;
    assert.equal(s.status, "completed"); assert.equal(s.counts.done.files, 2);
    for (const d of ctx.migrated()) assert.equal(sha(ctx.google.files.get(d.storage.key).bytes), d.sha256);
    assert.equal(ctx.driveMig().length, 2);
    await ctx.app.close();
  });

  test("a MongoDB write failure while finishing a file: retried, no duplicate attachment, mapping or Drive file", async () => {
    const ctx = await start({ files: 2 });
    await ctx.prepare(); await ctx.startRun("pilot");
    const mappings = ctx.app.db.collection("integrationMappings"), original = mappings.insertOne.bind(mappings);
    let failOnce = true;
    mappings.insertOne = async (...a) => { if (failOnce && a[0]?.kind === "asset") { failOnce = false; throw Object.assign(new Error("simulated write failure"), { name: "MongoServerError", code: 91 }); } return original(...a); };
    await ctx.mid.tick();
    mappings.insertOne = original;
    await ctx.app.db.collection("integrationJobs").updateMany({ type: "mid-attachment", status: "retry" }, { $set: { runAfter: new Date(0) } });
    const s = await ctx.drain();
    assert.equal(s.status, "completed"); assert.equal(s.counts.done.files, 2);
    assert.equal(ctx.migrated().length, 2); assert.equal(ctx.driveMig().length, 2);
    assert.equal(mappings.docs.filter((m) => m.kind === "asset").length, 2);
    await ctx.app.close();
  });

  test("Google Drive failing every time: the file fails after its attempts and leaves nothing behind", async () => {
    const ctx = await start({ files: 1 });
    await ctx.prepare(); await ctx.startRun("pilot");
    ctx.google.fail.push(...Array.from({ length: 200 }, () => ({ match: /upload\/drive/, status: 503 })));
    for (let i = 0; i < 8; i += 1) { await ctx.app.db.collection("integrationJobs").updateMany({ type: "mid-attachment", status: "retry" }, { $set: { runAfter: new Date(0) } }); await ctx.mid.tick(); }
    const s = (await ctx.api("GET", `/runs/${ctx.runId}`)).body;
    assert.equal(s.counts.failed.files, 1); assert.equal(s.failures[0].attempts, 5); assert.equal(s.status, "completed");
    assert.equal(ctx.migrated().filter((d) => d.status === "ready").length, 0); assert.equal(ctx.driveMig().length, 0);
    const usage = await ctx.app.db.collection("storageUsage").findOne({ _id: "gdrive" });
    assert.equal(usage.reservedBytes, 0, "no reservation left");
    await ctx.app.close();
  });

  test("source problems: a file gone from monday.com, a changed size, a cut-off download, a refused token", async () => {
    const ctx = await start({ files: 4 });
    ctx.monday.assets.delete("9000");
    ctx.monday.sizeOverride.set("9001", 1);
    ctx.monday.fail.push({ download: true, id: "9002", truncate: 10 });
    await ctx.prepare(); await ctx.startRun("pilot");
    await ctx.mid.tick();
    const items = Object.fromEntries(ctx.app.db.collection("integrationJobs").docs.filter((j) => j.type === "mid-attachment").map((j) => [j.params.assetId, j]));
    assert.deepEqual([items[9000].status, items[9000].error.code], ["failed", "MIGRATION_SOURCE_MISSING"]);
    assert.deepEqual([items[9001].status, items[9001].error.code], ["failed", "MIGRATION_SOURCE_CHANGED"]);
    assert.deepEqual([items[9002].status, items[9002].error.code], ["retry", "MIGRATION_SOURCE_INCOMPLETE"]);
    assert.equal(items[9003].status, "done");
    assert.doesNotMatch(JSON.stringify(ctx.mid.monday), new RegExp(MONDAY_TOKEN));
    const { MondayClient } = require("../src/integrations/monday/client");
    ctx.mid.monday = new MondayClient({ token: "wrong-token", fetch: ctx.mid.fetchImpl, sleep: async () => {} });
    await ctx.app.db.collection("integrationJobs").updateMany({ type: "mid-attachment", status: "retry" }, { $set: { runAfter: new Date(0) } });
    await ctx.mid.tick();
    const s = (await ctx.api("GET", `/runs/${ctx.runId}`)).body;
    assert.equal(s.status, "paused"); assert.equal(s.pausedReason, "MONDAY_UNAUTHORIZED");
    assert.doesNotMatch(JSON.stringify(s), /SECRET-SIGNATURE|files\.monday\.invalid/);
    await ctx.app.close();
  });

  test("a record deleted after preparing: its file fails (never imported elsewhere); a removed Files column too", async () => {
    const ctx = await start({ files: 3 });
    await ctx.prepare();
    await ctx.admin.request("DELETE", `/api/v1/records/${ctx.records[0].id}?expectedVersion=${ctx.records[0].version}`);
    await ctx.startRun("pilot");
    const s = await ctx.drain();
    const item = ctx.app.db.collection("integrationJobs").docs.find((j) => j._id === `${ctx.runId}:9000`);
    assert.deepEqual([item.status, item.error.code], ["failed", "MIGRATION_ATTACHMENT_RECORD_MISSING"]);
    assert.equal(s.counts.done.files, 2);
    assert.equal(ctx.migrated().filter((d) => d.recordId.toHexString() === ctx.records[0].id).length, 0);
    assert.equal(ctx.monday.downloads, 2, "no download for the deleted record");
    await ctx.app.close();
  });
});

describe("storage capacity", () => {
  test("not enough room in Google Drive, or under JARC's own limit: the run won't start", async () => {
    const tight = await start({ quota: { limit: 10 * MB, usage: 9.9 * MB } });
    await tight.prepare();
    const r = await tight.startRun("pilot");
    assert.equal(r.status, 409); assert.equal(r.body.error.code, "NOT_ENOUGH_STORAGE"); assert.ok(r.body.error.details.capacity.problems.includes("google-drive-too-full"));
    assert.equal(tight.monday.downloads, 0);
    await tight.app.close();
    const capped = await start({ files: 2, gdriveMaxMb: "1" });
    await capped.prepare();
    await capped.app.db.collection("storageUsage").updateOne({ _id: "gdrive" }, { $set: { usedBytes: 1024 * 1024 - 10, reservedBytes: 0 } }, { upsert: true });
    const c = await capped.startRun("pilot");
    assert.equal(c.body.error.code, "NOT_ENOUGH_STORAGE"); assert.ok(c.body.error.details.capacity.problems.includes("jarc-drive-limit-too-low"));
    await capped.app.close();
  });
  test("storage running out during the run pauses it and puts the file back in line", async () => {
    const ctx = await start({ files: 3 });
    await ctx.prepare(); await ctx.startRun("pilot");
    ctx.google.fail.push({ match: /upload\/drive/, status: 403, reason: "storageQuotaExceeded" });
    await ctx.mid.tick();
    const s = (await ctx.api("GET", `/runs/${ctx.runId}`)).body;
    assert.equal(s.status, "paused"); assert.equal(s.pausedReason, "STORAGE_FULL");
    assert.equal((s.counts.failed?.files || 0), 0, "nothing marked failed");
    assert.equal((await ctx.app.db.collection("storageUsage").findOne({ _id: "gdrive" })).reservedBytes, 0);
    assert.equal((await ctx.api("POST", `/runs/${ctx.runId}/resume`)).status, 200);
    assert.equal((await ctx.drain()).status, "completed");
    await ctx.app.close();
  });
});

describe("rollback and existing attachments", () => {
  test("rollback removes exactly this run: its Drive files to Trash, its attachments, mappings and counters; nothing else", async () => {
    const ctx = await start();
    const own = await fetch(`${ctx.app.url}/api/v1/records/${ctx.records[0].id}/attachments?column=m_filesa_files`, { method: "POST", body: bytesOf.png(), headers: { "Content-Type": "image/png", "X-File-Name": "employee.png", Cookie: [...ctx.admin.cookies].map(([k, v]) => `${k}=${v}`).join("; "), Origin: ctx.admin.origin, "X-CSRF-Token": ctx.admin.csrf } });
    assert.equal(own.status, 201);
    const employeeFile = (await own.json()).attachment.id;
    const records = snapshot(ctx, "records"), recordMappings = JSON.stringify(ctx.app.db.collection("integrationMappings").docs.filter((m) => m.kind !== "asset"));
    await ctx.prepare(); await ctx.startRun("pilot"); await ctx.drain();
    assert.equal(ctx.driveMig().length, 6);
    assert.equal((await ctx.api("POST", `/runs/${ctx.runId}/rollback`, { confirm: "ROLLBACK" })).body.error.code, "CONFIRMATION_REQUIRED");
    assert.equal((await ctx.api("POST", `/runs/${ctx.runId}/rollback`, { confirm: `ROLLBACK ${ctx.runId}` })).body.status, "rolling-back");
    const s = await ctx.drain();
    assert.equal(s.status, "rolled-back");
    assert.equal(ctx.migrated().length, 0); assert.equal(ctx.driveMig().length, 0);
    assert.equal(ctx.app.db.collection("integrationMappings").docs.filter((m) => m.kind === "asset").length, 0);
    assert.equal(JSON.stringify(ctx.app.db.collection("integrationMappings").docs.filter((m) => m.kind !== "asset")), recordMappings, "the records migration's mappings are untouched");
    assert.equal(snapshot(ctx, "records"), records);
    const trashed = [...ctx.google.files.values()].filter((f) => f.appProperties?.jarcRun === ctx.runId);
    assert.equal(trashed.length, 6); assert.ok(trashed.every((f) => f.trashed && f.appProperties.jarcKind === "removed"), "recoverable from Trash");
    assert.equal((await download(ctx, employeeFile)).status, 200, "the employee's own attachment is untouched");
    const usage = await ctx.app.db.collection("storageUsage").findOne({ _id: "gdrive" });
    assert.equal(usage.usedBytes, ctx.app.db.collection("attachments").docs.filter((d) => d.status === "ready").reduce((n, d) => n + d.size, 0));
    assert.equal(usage.reservedBytes, 0);
    await ctx.app.close();
  });

  test("normal uploads, downloads and the sweep are unaffected; the sweep never touches migrated files", async () => {
    const ctx = await start({ files: 2 });
    await ctx.prepare(); await ctx.startRun("pilot"); await ctx.drain();
    for (const f of ctx.driveMig()) f.createdTime = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    await ctx.app.dataLayer.services.files.sweep();
    assert.equal(ctx.driveMig().length, 2, "migrated files kept");
    assert.ok(ctx.migrated().every((d) => d.status === "ready"));
    const up = await fetch(`${ctx.app.url}/api/v1/records/${ctx.records[1].id}/attachments?column=m_photo_files`, { method: "POST", body: bytesOf.jpg(), headers: { "Content-Type": "image/jpeg", "X-File-Name": "new.jpg", Cookie: [...ctx.admin.cookies].map(([k, v]) => `${k}=${v}`).join("; "), Origin: ctx.admin.origin, "X-CSRF-Token": ctx.admin.csrf } });
    assert.equal(up.status, 201);
    const normal = ctx.google.active().filter((f) => f.appProperties?.jarcKind === "att");
    assert.equal(normal.length, 1); assert.equal(normal[0].appProperties.jarcRun, undefined, "normal uploads carry no run tag");
    const big = await fetch(`${ctx.app.url}/api/v1/records/${ctx.records[1].id}/attachments?column=m_photo_files`, { method: "POST", body: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), crypto.randomBytes(100)]), headers: { "Content-Type": "image/heic", "X-File-Name": "x.heic", Cookie: [...ctx.admin.cookies].map(([k, v]) => `${k}=${v}`).join("; "), Origin: ctx.admin.origin, "X-CSRF-Token": ctx.admin.csrf } });
    assert.equal(big.status, 415, "employees still can't upload HEIC: migration types stay migration-only");
    await ctx.app.close();
  });
});
