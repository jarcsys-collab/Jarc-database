// Files columns (server): uploads streamed into the file store with signature, type and size checks; listing,
// preview and download with safe headers; removal; per-cell, storage and rate limits; retries without duplicates;
// clean-up after failed or interrupted uploads and after deletions; the orphan sweep; authorisation (Entra sessions,
// role_based); and live updates. Offline: fake MongoDB and the in-memory file store (never real storage).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { ObjectId } = require("mongodb");
const { startMongoApp, startEntraApp, SessionClient, api } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { openStream } = require("./support/sse-client");
const { uploadLimiter } = require("../src/routes/files");
const { cleanFileName } = require("../src/files/file-types");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body-".repeat(50))]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-body")]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBPVP8 body")]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200, 1)]);
const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "docs", label: "Documents", type: "files" },
  { key: "notes", label: "Notes", type: "text" }
];

// Raw upload / download helpers (the JSON helpers can't carry files).
async function upload(base, recordId, file, { column = "docs", type = "image/png", name = "photo.png", key, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1/records/${recordId}/attachments?column=${column}`, { method: "POST", body: file, headers: { "Content-Type": type, "X-File-Name": encodeURIComponent(name), ...(key ? { "X-Upload-Key": key } : {}), ...headers } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
async function download(base, path, headers = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}
const until = async (check, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

describe("Files column (development API)", () => {
  let app, ws, board;
  const call = (method, path, body) => api(app.url, method, `/api/v1${path}`, body);
  const newRecord = async (serial = "R") => (await call("POST", `/boards/${board.id}/records`, { values: { serial } })).body.record;
  const stored = () => app.fileStore.files.size;
  const docs = () => app.db.collection("attachments").docs;
  before(async () => {
    app = await startMongoApp();
    ws = (await call("POST", "/workspaces", { name: "Files" })).body.workspace;
    board = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Docs", columns: COLUMNS })).body.board;
  });
  after(async () => { await app.close(); });

  test("Files is a column type; its cells hold nothing in the record and can't be written directly", async () => {
    assert.equal(board.columns.find((c) => c.key === "docs").type, "files");
    const record = await newRecord();
    assert.equal(record.values.docs, "");
    const patch = await call("PATCH", `/records/${record.id}`, { expectedVersion: record.version, values: { docs: "invoice.pdf" } });
    assert.equal(patch.status, 400);
    const retype = await call("POST", `/boards/${board.id}/columns/docs/type`, { expectedVersion: board.version, type: "text" });
    assert.equal(retype.status, 400, "a Files column can't become another type");
    const toFiles = await call("POST", `/boards/${board.id}/columns/notes/type`, { expectedVersion: board.version, type: "files" });
    assert.equal(toFiles.status, 400, "nor can another column become Files");
  });

  test("PDF, JPEG, PNG and WebP upload; metadata is listed; the file is served back exactly with safe headers", async () => {
    const record = await newRecord();
    for (const [file, type, name] of [[PNG, "image/png", "site photo.png"], [JPEG, "image/jpeg", "van.JPG"], [WEBP, "image/webp", "scan.webp"], [PDF, "application/pdf", "Invoice #42 (final).pdf"]]) {
      const res = await upload(app.url, record.id, file, { type, name });
      assert.equal(res.status, 201, `${name}: ${JSON.stringify(res.body)}`);
      assert.deepEqual(Object.keys(res.body.attachment).sort(), ["boardId", "columnKey", "createdAt", "id", "name", "recordId", "size", "type", "uploadedBy", "uploadedByName"]);
      assert.equal(res.body.attachment.size, file.length);
      assert.equal(res.body.attachment.type, type);
    }
    const list = (await call("GET", `/records/${record.id}/attachments`)).body.items;
    assert.deepEqual(list.map((a) => a.name), ["site photo.png", "van.JPG", "scan.webp", "Invoice #42 (final).pdf"]);
    assert.ok((await call("GET", `/boards/${board.id}/attachments`)).body.items.length >= 4);

    const pdf = list[3];
    const inline = await download(app.url, `/api/v1/attachments/${pdf.id}/content`);
    assert.equal(inline.status, 200);
    assert.ok(inline.bytes.equals(PDF), "the same bytes come back");
    assert.equal(inline.headers.get("content-type"), "application/pdf");
    assert.match(inline.headers.get("content-disposition"), /^inline; filename="Invoice #42 \(final\)\.pdf"; filename\*=UTF-8''Invoice%20%2342%20\(final\)\.pdf$/);
    assert.equal(inline.headers.get("x-content-type-options"), "nosniff");
    assert.equal(inline.headers.get("cache-control"), "private, no-cache");
    assert.match(inline.headers.get("content-security-policy"), /default-src 'none'/);
    const image = await download(app.url, `/api/v1/attachments/${list[0].id}/content?download=1`);
    assert.match(image.headers.get("content-disposition"), /^attachment;/);
    assert.match(image.headers.get("content-security-policy"), /sandbox/, "images can't run anything even if opened directly");
    const again = await download(app.url, `/api/v1/attachments/${list[0].id}/content`, { "If-None-Match": image.headers.get("etag") });
    assert.equal(again.status, 304);
    assert.equal((await download(app.url, `/api/v1/attachments/${list[0].id}/content?download=yes`)).status, 400);
  });

  test("REFUSED: wrong or disguised types, missing names, oversize files, wrong columns — and nothing is left behind", async () => {
    const record = await newRecord();
    const before = [stored(), docs().length];
    for (const [file, opts, status, why] of [
      [EXE, { type: "application/pdf", name: "invoice.pdf" }, 415, "a program renamed to .pdf"],
      [PDF, { type: "image/png", name: "x.png" }, 415, "a PDF declared as PNG"],
      [Buffer.from("<svg onload=alert(1)>"), { type: "image/svg+xml", name: "x.svg" }, 415, "SVG"],
      [Buffer.from("<html><script>alert(1)</script>"), { type: "text/html", name: "x.html" }, 415, "HTML"],
      [Buffer.from("%PD"), { type: "application/pdf", name: "short.pdf" }, 415, "too short to be a PDF"],
      [PNG, { name: "" }, 400, "no file name"],
      [PNG, { column: "notes" }, 404, "not a Files column"],
      [PNG, { column: "nope" }, 404, "unknown column"],
      [PNG, { key: "bad key!" }, 400, "invalid upload key"]
    ]) assert.equal((await upload(app.url, record.id, file, opts)).status, status, why);
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0); PNG.copy(big);
    // Over 10 MB: 413 straight away, and the connection is closed (the client may see that instead of the answer).
    assert.equal(await upload(app.url, record.id, big).then((r) => r.status, () => 413), 413, "over 10 MB");
    assert.equal((await upload(app.url, new ObjectId().toHexString(), PNG)).status, 404, "unknown record");
    assert.deepEqual([stored(), docs().length], before, "no stored bytes and no metadata from refused uploads");
    assert.equal((await call("GET", `/records/${record.id}/attachments`)).body.items.length, 0);
  });

  test("an upload without a declared size, or shorter than declared, is refused and cleaned up", async () => {
    const record = await newRecord();
    const before = [stored(), docs().length];
    const port = new URL(app.url).port;
    const chunked = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: `/api/v1/records/${record.id}/attachments?column=docs`, headers: { "Content-Type": "image/png", "X-File-Name": "a.png", "Transfer-Encoding": "chunked" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", () => resolve("error"));
      req.end(PNG);
    });
    assert.equal(chunked, 411);
    // The browser announces more bytes than it sends, then disconnects (lost connection mid-upload).
    await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: `/api/v1/records/${record.id}/attachments?column=docs`, headers: { "Content-Type": "image/png", "X-File-Name": "cut.png", "Content-Length": String(PNG.length * 4) } });
      req.on("error", () => resolve());
      req.write(PNG);
      setTimeout(() => { req.destroy(); resolve(); }, 150);
    });
    assert.ok(await until(() => stored() === before[0] && docs().length === before[1]), "the interrupted upload was removed (bytes and pending metadata)");
  });

  test("retrying with the same upload key returns the first upload instead of storing a duplicate", async () => {
    const record = await newRecord();
    const first = await upload(app.url, record.id, PNG, { key: "retry-key-0001" });
    const second = await upload(app.url, record.id, PNG, { key: "retry-key-0001" });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.repeated, true);
    assert.equal(second.body.attachment.id, first.body.attachment.id);
    assert.equal((await call("GET", `/records/${record.id}/attachments`)).body.items.length, 1);
  });

  test("a cell holds at most 20 files; uploads never change the record (no version bump, no lost edits)", async () => {
    const record = await newRecord();
    for (let i = 0; i < 20; i += 1) assert.equal((await upload(app.url, record.id, JPEG, { type: "image/jpeg", name: `p${i}.jpg` })).status, 201);
    const extra = await upload(app.url, record.id, JPEG, { type: "image/jpeg", name: "p21.jpg" });
    assert.equal(extra.status, 409);
    assert.equal(extra.body.error.code, "TOO_MANY_FILES");
    const now = (await call("GET", `/records/${record.id}`)).body.record;
    assert.equal(now.version, record.version, "the record's version is untouched, so a colleague's open edit still saves");
    const edit = await call("PATCH", `/records/${record.id}`, { expectedVersion: record.version, values: { notes: "kept" } });
    assert.equal(edit.status, 200);
  });

  test("removing a file deletes its metadata and bytes and is logged; it can't be removed twice", async () => {
    const record = await newRecord();
    const a = (await upload(app.url, record.id, PDF, { type: "application/pdf", name: "old.pdf" })).body.attachment;
    const count = stored();
    assert.equal((await call("DELETE", `/attachments/${a.id}`)).status, 200);
    assert.equal(stored(), count - 1);
    assert.equal((await download(app.url, `/api/v1/attachments/${a.id}/content`)).status, 404);
    assert.equal((await call("DELETE", `/attachments/${a.id}`)).status, 404);
    const log = app.db.collection("activities").docs.filter((d) => String(d.entityId) === a.id).map((d) => [d.action, String(d.recordId), d.summary]);
    assert.deepEqual(log, [["attachment.added", record.id, "old.pdf"], ["attachment.removed", record.id, "old.pdf"]]);
  });

  test("deleting a record, a column, or a board removes their files", async () => {
    const b = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Cascade", columns: COLUMNS })).body.board;
    const rec = async () => (await call("POST", `/boards/${b.id}/records`, { values: { serial: "C" } })).body.record;
    const [r1, r2, r3] = [await rec(), await rec(), await rec()];
    for (const r of [r1, r2, r3]) await upload(app.url, r.id, PNG);
    const onBoard = () => docs().filter((d) => String(d.boardId) === b.id).length;
    assert.equal(onBoard(), 3);
    await call("DELETE", `/records/${r1.id}?expectedVersion=${r1.version}`);
    assert.equal(onBoard(), 2);
    await call("POST", `/boards/${b.id}/records/delete`, { records: [{ id: r2.id, expectedVersion: r2.version }] });
    assert.equal(onBoard(), 1);
    const current = (await call("GET", `/boards/${b.id}`)).body.board;
    assert.equal((await call("DELETE", `/boards/${b.id}/columns/docs?expectedVersion=${current.version}`)).status, 200);
    assert.equal(onBoard(), 0);
    // And a whole board:
    const b2 = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Gone", columns: COLUMNS })).body.board;
    const r = (await call("POST", `/boards/${b2.id}/records`, { values: { serial: "G" } })).body.record;
    const a = (await upload(app.url, r.id, PNG)).body.attachment;
    await call("DELETE", `/boards/${b2.id}?expectedVersion=${b2.version}`);
    assert.equal(docs().some((d) => String(d._id) === a.id), false);
    assert.equal(app.fileStore.files.has(a.id), false);
  });

  test("deleting a workspace removes its boards' files — never the files of a board moved out of it", async () => {
    const oldWs = (await call("POST", "/workspaces", { name: "Old" })).body.workspace;
    const newWs = (await call("POST", "/workspaces", { name: "New" })).body.workspace;
    const stays = (await call("POST", `/workspaces/${oldWs.id}/boards`, { name: "Stays", columns: COLUMNS })).body.board;
    const moves = (await call("POST", `/workspaces/${oldWs.id}/boards`, { name: "Moves", columns: COLUMNS })).body.board;
    const r1 = (await call("POST", `/boards/${stays.id}/records`, { values: { serial: "S" } })).body.record;
    const r2 = (await call("POST", `/boards/${moves.id}/records`, { values: { serial: "M" } })).body.record;
    const gone = (await upload(app.url, r1.id, PNG)).body.attachment, kept = (await upload(app.url, r2.id, PNG)).body.attachment;
    assert.equal((await call("POST", `/boards/${moves.id}/move`, { expectedVersion: moves.version, workspaceId: newWs.id })).status, 200);
    // Even if the attachments still named the old workspace (e.g. their update failed), they must survive.
    await app.db.collection("attachments").updateMany({ boardId: new ObjectId(moves.id) }, { $set: { workspaceId: new ObjectId(oldWs.id) } });
    const current = (await call("GET", `/workspaces/${oldWs.id}`)).body.workspace;
    assert.equal((await call("DELETE", `/workspaces/${oldWs.id}?expectedVersion=${current.version}`)).status, 200);
    const ids = docs().map((d) => String(d._id));
    assert.equal(ids.includes(gone.id), false, "the deleted workspace's files are removed");
    assert.equal(ids.includes(kept.id), true, "the moved board's file is kept");
    assert.equal((await download(app.url, `/api/v1/attachments/${kept.id}/content`)).status, 200);
  });

  test("the sweep removes interrupted uploads, bytes without metadata and files of vanished records", async () => {
    const files = app.dataLayer.services.files;
    const record = await newRecord();
    const kept = (await upload(app.url, record.id, PNG)).body.attachment;
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const pending = new ObjectId(), stray = new ObjectId(), orphan = new ObjectId();
    await app.db.collection("attachments").insertOne({ _id: pending, boardId: new ObjectId(board.id), recordId: new ObjectId(record.id), columnKey: "docs", status: "pending", size: 5, createdAt: old });
    await app.db.collection("attachments").insertOne({ _id: orphan, boardId: new ObjectId(board.id), recordId: new ObjectId(), columnKey: "docs", status: "ready", size: 5, createdAt: old });
    app.fileStore.files.set(String(stray), { id: stray, data: PNG, uploadDate: old });
    app.fileStore.files.set(String(pending), { id: pending, data: PNG, uploadDate: old });
    assert.ok(await files.sweep() >= 3);
    const ids = docs().map((d) => String(d._id));
    assert.equal(ids.includes(String(pending)), false);
    assert.equal(ids.includes(String(orphan)), false);
    assert.equal(app.fileStore.files.has(String(stray)), false);
    assert.equal(app.fileStore.files.has(String(pending)), false);
    assert.equal(ids.includes(kept.id), true, "a ready file of an existing record stays");
    assert.equal(app.fileStore.files.has(kept.id), true);
  });

  test("file names are cleaned: no folders, control characters or wrong extensions", () => {
    assert.equal(cleanFileName("../../etc/passwd", "application/pdf"), "passwd.pdf");
    assert.equal(cleanFileName("C:\\Users\\me\\scan.PNG", "image/png"), "scan.PNG");
    assert.equal(cleanFileName("evil.html", "image/jpeg"), "evil.html.jpg");
    assert.equal(cleanFileName('a<b>"c"\u0000.pdf', "application/pdf"), "abc.pdf");
    assert.equal(cleanFileName("...", "image/png"), null);
    assert.equal(cleanFileName("report‮fdp.exe", "application/pdf"), "reportfdp.exe.pdf", "no right-to-left override disguising the extension");
    assert.equal(cleanFileName("a​b﻿.png", "image/png"), "ab.png");
    assert.ok(cleanFileName(`${"x".repeat(400)}.pdf`, "application/pdf").length <= 200);
  });

  test("upload rate limits: per person per window, per person at once, and overall", () => {
    const limiter = uploadLimiter({ perWindow: 3, windowMs: 60000, perUser: 2, total: 3 });
    const a1 = limiter.acquire("a"), a2 = limiter.acquire("a");
    assert.equal(typeof limiter.acquire("a"), "string", "a third at once is refused");
    a1(); a2();
    assert.equal(typeof limiter.acquire("a"), "function");
    assert.equal(typeof limiter.acquire("a"), "string", "3 per window");
    const b1 = limiter.acquire("b"), b2 = limiter.acquire("b");
    assert.equal(typeof limiter.acquire("c"), "string", "overall cap reached");
    b1(); b2();
  });
});

describe("Files column: storage cap", () => {
  test("uploads that would exceed ATTACHMENTS_MAX_TOTAL_MB are refused before anything is stored", async () => {
    const app = await startMongoApp({ maxFileStorageBytes: PNG.length + 10 });
    try {
      const call = (method, path, body) => api(app.url, method, `/api/v1${path}`, body);
      const ws = (await call("POST", "/workspaces", { name: "Cap" })).body.workspace;
      const board = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Cap", columns: COLUMNS })).body.board;
      const record = (await call("POST", `/boards/${board.id}/records`, { values: { serial: "1" } })).body.record;
      assert.equal((await upload(app.url, record.id, PNG)).status, 201);
      const full = await upload(app.url, record.id, PNG);
      assert.equal(full.status, 507);
      assert.equal(full.body.error.code, "STORAGE_FULL");
      assert.equal(app.fileStore.files.size, 1);
    } finally { await app.close(); }
  });
});

describe("Files column: authorisation and live updates (Microsoft sign-in, role_based)", () => {
  let app, issuer, admin, member, viewer, outsider, board, record;
  const client = () => new SessionClient(app.url, app.entra.appOrigin);
  const cookie = (c) => [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const as = (c, extra = {}) => ({ Cookie: cookie(c), Origin: app.entra.appOrigin, ...(c.csrf ? { "X-CSRF-Token": c.csrf } : {}), ...extra });
  before(async () => {
    issuer = await createTokenIssuer();
    app = await startEntraApp({ issuer, live: { pollMs: 50, overlapMs: 2000, timings: { session: 150, access: 150, heartbeat: 1000 } } });
    admin = client(); member = client(); viewer = client(); outsider = client();
    await admin.signIn(issuer.person("Admin", { admin: true })); await member.signIn(issuer.person("Mia Member")); await viewer.signIn(issuer.person("Vic Viewer")); await outsider.signIn(issuer.person("Otto Outsider"));
    const ws = (await admin.request("POST", "/api/v1/workspaces", { name: "Team" })).body.workspace;
    for (const [c, role] of [[member, "MEMBER"], [viewer, "VIEWER"]]) await admin.request("POST", `/api/v1/workspaces/${ws.id}/members`, { userId: (await c.request("GET", "/api/v1/me")).body.user.id, role });
    board = (await admin.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Docs", columns: COLUMNS })).body.board;
    record = (await admin.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "A" } })).body.record;
  });
  after(async () => { app.app?.locals?.realtime?.closeAll(); await app.close(); });

  test("members upload; viewers preview and download but can't upload or remove; others see nothing", async () => {
    assert.equal((await upload(app.url, record.id, PNG)).status, 401, "no session");
    assert.equal((await upload(app.url, record.id, PNG, { headers: { Cookie: cookie(member), Origin: app.entra.appOrigin } })).status, 403, "no CSRF token");
    assert.equal((await upload(app.url, record.id, PNG, { headers: as(member, { Origin: "https://evil.example" }) })).status, 403, "another site");
    const made = await upload(app.url, record.id, PNG, { headers: as(member) });
    assert.equal(made.status, 201);
    assert.equal(made.body.attachment.uploadedByName, "Mia Member");
    const id = made.body.attachment.id;
    assert.equal((await upload(app.url, record.id, PNG, { headers: as(viewer) })).status, 403, "viewer can't upload");
    assert.equal((await download(app.url, `/api/v1/attachments/${id}/content`, { Cookie: cookie(viewer) })).status, 200, "viewer can preview");
    assert.equal((await viewer.request("DELETE", `/api/v1/attachments/${id}`)).status, 403, "viewer can't remove");
    for (const path of [`/api/v1/attachments/${id}/content`, `/api/v1/records/${record.id}/attachments`, `/api/v1/boards/${board.id}/attachments`]) {
      assert.equal((await download(app.url, path, { Cookie: cookie(outsider) })).status, 404, `outsider: ${path}`);
      assert.equal((await download(app.url, path)).status, 401, `anonymous: ${path}`);
    }
    assert.equal((await upload(app.url, record.id, PNG, { headers: as(outsider) })).status, 404);
    assert.equal((await outsider.request("DELETE", `/api/v1/attachments/${id}`)).status, 404);
    assert.equal(app.fileStore.files.size, 1, "refused uploads stored nothing");
  });

  test("colleagues are told live (IDs only) when a file is added or removed", async () => {
    const stream = await openStream(`${app.url}/api/v1/events`, { headers: { Cookie: cookie(viewer) } });
    try {
      await stream.waitFor((m) => m.event === "ready");
      const added = await upload(app.url, record.id, PDF, { type: "application/pdf", name: "Secret plan.pdf", headers: as(member) });
      const event = await stream.waitFor((m) => m.event === "change" && m.data.action === "attachment.added");
      assert.equal(event.data.recordId, record.id);
      assert.doesNotMatch(JSON.stringify(event.data), /Secret/, "no file names in the event");
      await member.request("DELETE", `/api/v1/attachments/${added.body.attachment.id}`);
      assert.ok(await stream.waitFor((m) => m.event === "change" && m.data.action === "attachment.removed"));
    } finally { await stream.close(); }
  });
});

// The production store: the MongoDB driver's own GridFS code (GridFSBucket), here running on the fake database.
describe("Files column through GridFS (the MongoDB driver's GridFSBucket on the fake database)", () => {
  test("upload in 255 KB chunks, download byte for byte, remove; refused uploads leave no chunks", async () => {
    const { GridFsFileStore } = require("../src/files/file-store");
    const store = new GridFsFileStore(null);
    const app = await startMongoApp({ fileStore: store });
    store.db = app.db;
    try {
      const call = (method, path, body) => api(app.url, method, `/api/v1${path}`, body);
      const ws = (await call("POST", "/workspaces", { name: "GridFS" })).body.workspace;
      const board = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "G", columns: COLUMNS })).body.board;
      const record = (await call("POST", `/boards/${board.id}/records`, { values: { serial: "1" } })).body.record;
      const big = Buffer.concat([PDF, Buffer.alloc(700 * 1024, 65)]);
      const made = await upload(app.url, record.id, big, { type: "application/pdf", name: "manual.pdf" });
      assert.equal(made.status, 201);
      const chunks = () => app.db.collection("attachmentFiles.chunks").docs;
      assert.equal(chunks().length, 3, "700 KB → three 255 KB chunks");
      assert.equal(app.db.collection("attachmentFiles.files").docs[0]._id.toHexString(), made.body.attachment.id, "the GridFS file shares the attachment's ID");
      const back = await download(app.url, `/api/v1/attachments/${made.body.attachment.id}/content`);
      assert.ok(back.bytes.equals(big));
      assert.equal((await upload(app.url, record.id, EXE, { type: "application/pdf", name: "x.pdf" })).status, 415);
      assert.equal(chunks().length, 3, "the refused upload's chunks were removed");
      assert.equal((await call("DELETE", `/attachments/${made.body.attachment.id}`)).status, 200);
      assert.equal(chunks().length, 0);
      assert.equal(app.db.collection("attachmentFiles.files").docs.length, 0);
    } finally { await app.close(); }
  });
});

describe("Files storage stays inside jarc_database", () => {
  test("the server's default store is GridFS on the connection's database (jarc_database); no other database is ever opened", async () => {
    const { FakeMongoClient } = require("./support/fake-mongo");
    const { MongoConnection } = require("../src/db/connection");
    const { ensureDatabase } = require("../src/db/bootstrap");
    const { createDataLayer } = require("../src/data-layer");
    const { GridFsFileStore } = require("../src/files/file-store");
    const fake = new FakeMongoClient();
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
    await connection.connect();
    await ensureDatabase(connection.db);
    const dataLayer = createDataLayer({ connection, logger: { error() {} } }); // as server.js builds it: no store passed
    const store = dataLayer.services.files.store;
    assert.ok(store instanceof GridFsFileStore);
    assert.equal(store.db, connection.db);
    assert.equal(store.bucketName, "attachmentFiles");
    const id = new ObjectId();
    await new Promise((resolve, reject) => { const w = store.openUpload(id, { filename: "a.png", contentType: "image/png" }); w.on("finish", resolve); w.on("error", reject); w.end(PNG); });
    await store.delete(id);
    assert.deepEqual([...new Set(fake.requestedDbNames)], ["jarc_database"], "only jarc_database was opened");
    const created = [...fake.dbs.get("jarc_database").created];
    for (const name of ["attachments", "attachmentFiles.files", "attachmentFiles.chunks"]) assert.ok(created.includes(name), name);
    assert.throws(() => new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "receiptflow", createClient: () => fake }), /jarc_database/, "no other database can be configured");
  });
});
