// Google Drive attachment storage, entirely offline: the fake database and a mock Google (tests/support/mock-google-drive)
// passed in as `fetch`, which refuses every other URL. No Google account, no production database.
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { startEntraApp, SessionClient, entraEnv } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { mockGoogle, ENV, ACCOUNT, REDIRECT, SCOPE, CLIENT } = require("./support/mock-google-drive");
const { mockMonday, ENV: MONDAY_ENV } = require("./support/mock-monday");
const { loadConfig, loadGoogleDriveConfig, loadMondayConfig, loadAttachmentConfig } = require("../src/config");
const { AttachmentImporter } = require("../src/migration/monday/attachments");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body-".repeat(50))]);
const CHUNK = 256 * 1024;
const big = (size) => Buffer.concat([PNG, crypto.randomBytes(size - PNG.length)]);
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "docs", label: "Documents", type: "files" }];
const config = (extra = {}) => loadGoogleDriveConfig({ ...ENV, ...extra }, "production", "entra");
const OPTIONS = { sleep: async () => {}, chunkBytes: CHUNK };
const entraOf = (issuer) => ({ ...issuer.config, redirectUri: REDIRECT.replace(/api.*/, ""), appOrigin: new URL(REDIRECT).origin });

async function start({ provider = "gridfs", googleDrive = config(), google = mockGoogle(), monday = null, fetch = null, accounts = null } = {}) {
  const issuer = await createTokenIssuer();
  const app = await startEntraApp({ issuer, entra: entraOf(issuer), googleDrive, googleDriveOptions: OPTIONS, attachments: { defaultProvider: provider, s3: null }, monday, accounts, fetch: fetch || google.fetch });
  const admin = new SessionClient(app.url, app.entra.appOrigin), member = new SessionClient(app.url, app.entra.appOrigin);
  await admin.signIn(issuer.person("Ada Admin", { admin: true }));
  await member.signIn(issuer.person("Mia Member"));
  return { app, issuer, admin, member, google, drive: app.dataLayer.services.googleDrive };
}
const cookieHeader = (client) => [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
// The browser's return from Google: the Strict session cookie isn't sent; only the Lax browser cookie is.
async function callback(app, client, params, { withBrowserCookie = true } = {}) {
  const browser = client.cookies.get("__Host-jarc_gdrive_oauth");
  const headers = withBrowserCookie && browser ? { Cookie: `__Host-jarc_gdrive_oauth=${browser}` } : {};
  const res = await fetch(`${app.url}/api/v1/integrations/google-drive/callback?${new URLSearchParams(params)}`, { redirect: "manual", headers });
  return { status: res.status, location: res.headers.get("location"), headers: res.headers };
}
async function connect(ctx, client = ctx.admin) {
  const res = await client.request("POST", "/api/v1/integrations/google-drive/connect");
  assert.equal(res.status, 200);
  const { code, state } = ctx.google.approve(res.body.authorizeUrl);
  return callback(ctx.app, client, { code, state });
}
async function workspace(ctx) {
  const ws = (await ctx.admin.request("POST", "/api/v1/workspaces", { name: "Files" })).body.workspace;
  const board = (await ctx.admin.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Docs", columns: COLUMNS })).body.board;
  const record = (await ctx.admin.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "R1" } })).body.record;
  return { ws, board, record };
}
async function upload(ctx, recordId, file = PNG, { name = "Quarterly report.png", client = ctx.admin } = {}) {
  const res = await fetch(`${ctx.app.url}/api/v1/records/${recordId}/attachments?column=docs`, { method: "POST", body: file, headers: { "Content-Type": "image/png", "X-File-Name": encodeURIComponent(name), Cookie: cookieHeader(client), Origin: client.origin, "X-CSRF-Token": client.csrf } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function download(ctx, id, client = ctx.admin) {
  const res = await fetch(`${ctx.app.url}/api/v1/attachments/${id}/content`, { headers: { Cookie: cookieHeader(client) } });
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}
const docs = (ctx) => ctx.app.db.collection("attachments").docs;
const stored = (ctx) => ctx.app.db.collection("integrations").findOne({ _id: "google-drive" });

describe("configuration", () => {
  test("off by default: nothing is required or read, and an unset store stays where it was", () => {
    const off = loadGoogleDriveConfig({}, "production", "entra");
    assert.equal(off.enabled, false); assert.equal(off.clientSecret, null);
    assert.equal(loadGoogleDriveConfig({ GOOGLE_DRIVE_ENABLED: "false", GOOGLE_DRIVE_TOKEN_KEY: "short" }, "production", "entra").enabled, false);
    const whole = loadConfig(entraEnv({ NODE_ENV: "production" }));
    assert.equal(whole.googleDrive.enabled, false); assert.equal(whole.attachments.defaultProvider, "gridfs");
  });
  test("on: every value is required and checked; secrets aren't serialised", () => {
    const on = config();
    assert.equal(on.enabled, true); assert.equal(on.redirectUri, REDIRECT); assert.equal(on.accountEmail, ACCOUNT); assert.equal(on.maxTotalBytes, 100 * 1024 * 1024);
    assert.equal(on.clientSecret, CLIENT.secret); assert.equal(on.tokenKey.length, 32);
    assert.doesNotMatch(JSON.stringify(on), new RegExp(CLIENT.secret));
    for (const name of Object.keys(ENV).filter((k) => k !== "GOOGLE_DRIVE_ENABLED")) assert.throws(() => config({ [name]: "" }), new RegExp(name));
    assert.throws(() => loadGoogleDriveConfig({ GOOGLE_DRIVE_ENABLED: "yes" }, "production", "entra"), /true or false/);
    assert.throws(() => config({ GOOGLE_DRIVE_TOKEN_KEY: "c2hvcnQ=" }), /32 random bytes/);
    assert.throws(() => config({ GOOGLE_DRIVE_REDIRECT_URI: "http://jarc.example.invalid/api/v1/integrations/google-drive/callback" }), /https/);
    assert.throws(() => config({ GOOGLE_DRIVE_REDIRECT_URI: "http://localhost:3000/api/v1/integrations/google-drive/callback" }), /https/);
    assert.throws(() => config({ GOOGLE_DRIVE_REDIRECT_URI: "https://jarc.example.invalid/other" }), /must end in/);
    assert.throws(() => config({ GOOGLE_DRIVE_REDIRECT_URI: `${REDIRECT}?x=1` }), /must end in/);
    assert.throws(() => config({ GOOGLE_DRIVE_ACCOUNT_EMAIL: "nobody" }), /email/);
    assert.throws(() => config({ ATTACHMENTS_GDRIVE_MAX_TOTAL_MB: "0" }), /megabytes/);
    assert.throws(() => loadGoogleDriveConfig(ENV, "development", "dev"), /AUTH_MODE=entra/);
  });
  test("new uploads can only go to Drive when Drive is on; the old setting's shape is unchanged", () => {
    assert.throws(() => loadAttachmentConfig({ ATTACHMENTS_STORE: "gdrive" }, "production"), /GOOGLE_DRIVE_ENABLED=true/);
    assert.equal(loadAttachmentConfig({ ATTACHMENTS_STORE: "gdrive", GOOGLE_DRIVE_ENABLED: "true" }, "production").defaultProvider, "gdrive");
    assert.deepEqual(loadAttachmentConfig({}, "production"), { defaultProvider: "gridfs", s3: null, migrationMaxFileBytes: 20 * 1024 * 1024 });
  });
  test("the monday.com migration refuses Google Drive as a target", () => {
    assert.throws(() => new AttachmentImporter({ provider: "gdrive" }), (e) => e.code === "MIGRATION_PROVIDER_UNSUPPORTED");
  });
});

describe("switched off", () => {
  let ctx;
  before(async () => { ctx = await start({ googleDrive: loadGoogleDriveConfig({}, "production", "entra") }); });
  after(() => ctx.app.close());
  test("its routes don't exist, Google is never called, and attachments work as before", async () => {
    assert.equal(ctx.drive, undefined);
    assert.equal((await ctx.admin.request("GET", "/api/v1/integrations/google-drive")).status, 404);
    assert.equal((await ctx.admin.request("POST", "/api/v1/integrations/google-drive/connect")).status, 404);
    const cb = await fetch(`${ctx.app.url}/api/v1/integrations/google-drive/callback?code=x&state=${"a".repeat(40)}`, { redirect: "manual" });
    assert.equal(cb.status, 401, "like any unknown path, it needs a session");
    const { record } = await workspace(ctx);
    const up = await upload(ctx, record.id);
    assert.equal(up.status, 201);
    assert.ok((await download(ctx, up.body.attachment.id)).bytes.equals(PNG));
    assert.equal(docs(ctx)[0].storage, undefined);
    assert.equal(ctx.google.calls.length, 0);
  });
});

describe("connecting: only an administrator, only through a valid return", () => {
  let ctx;
  beforeEach(async () => { ctx = await start(); });
  const afterEachClose = () => ctx.app.close();

  test("administrators only; signed-out people and members are refused; changes need CSRF", async () => {
    assert.equal((await fetch(`${ctx.app.url}/api/v1/integrations/google-drive`)).status, 401);
    for (const [method, path] of [["GET", ""], ["POST", "/connect"], ["POST", "/test"], ["POST", "/disconnect"]]) {
      assert.equal((await ctx.member.request(method, `/api/v1/integrations/google-drive${path}`, method === "POST" ? {} : undefined)).status, 403, path);
    }
    assert.equal((await ctx.admin.request("POST", "/api/v1/integrations/google-drive/connect", undefined, { csrf: "wrong" })).status, 403);
    assert.equal(ctx.google.calls.length, 0);
    await afterEachClose();
  });

  test("the request asks only for drive.file with offline access and PKCE; the browser cookie is HttpOnly and Secure", async () => {
    const res = await ctx.admin.request("POST", "/api/v1/integrations/google-drive/connect");
    const url = new URL(res.body.authorizeUrl), p = url.searchParams;
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.deepEqual([p.get("scope"), p.get("access_type"), p.get("prompt"), p.get("redirect_uri"), p.get("client_id"), p.get("code_challenge_method"), p.get("login_hint")], [SCOPE, "offline", "consent", REDIRECT, CLIENT.id, "S256", ACCOUNT]);
    assert.equal(p.has("include_granted_scopes"), false);
    assert.doesNotMatch(res.body.authorizeUrl, new RegExp(CLIENT.secret));
    const cookie = ctx.admin.setCookies.find((c) => c.startsWith("__Host-jarc_gdrive_oauth="));
    assert.match(cookie, /Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    await afterEachClose();
  });

  test("success: folder created, connection checked with a test file, refresh token encrypted, nothing secret in status or the URL", async () => {
    const res = await connect(ctx);
    assert.equal(res.status, 303);
    assert.equal(res.location, "/?integration=google-drive&result=connected#integrations");
    assert.match(res.headers.get("set-cookie"), /__Host-jarc_gdrive_oauth=; .*Max-Age=0/);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    const folders = ctx.google.folders();
    assert.equal(folders.length, 1); assert.equal(folders[0].name, "JARC Attachments"); assert.deepEqual(folders[0].parents, []);
    assert.equal(ctx.google.active().length, 0, "the test file is gone, not in Trash");
    assert.ok(ctx.google.calls.some((c) => c.method === "DELETE"));
    const rec = await stored(ctx), [refresh] = ctx.google.refreshTokens;
    assert.equal(rec.status, "connected"); assert.equal(rec.folderId, folders[0].id); assert.equal(rec.accountEmail, ACCOUNT);
    assert.equal(JSON.stringify(rec).includes(refresh), false);
    assert.deepEqual(Object.keys(rec.refreshToken).sort(), ["data", "iv", "tag", "v"]);
    const status = await ctx.admin.request("GET", "/api/v1/integrations/google-drive");
    assert.equal(status.body.state, "connected"); assert.equal(status.body.account.email, ACCOUNT); assert.equal(status.body.account.connectedByName, "Ada Admin");
    assert.equal(status.body.activeForNewUploads, false);
    assert.match(status.body.folder.url, /^https:\/\/drive\.google\.com\/drive\/folders\//);
    assert.doesNotMatch(status.text, /refresh|access-|iv"|client-secret/);
    assert.equal((await ctx.admin.request("POST", "/api/v1/integrations/google-drive/test")).body.account, ACCOUNT);
    assert.equal(ctx.google.outside.length, 0);
    await afterEachClose();
  });

  test("a state works once, only with the browser that started it, and only for this provider", async () => {
    const start1 = await ctx.admin.request("POST", "/api/v1/integrations/google-drive/connect");
    const { code, state } = ctx.google.approve(start1.body.authorizeUrl);
    assert.match((await callback(ctx.app, ctx.admin, { code, state: "x".repeat(10) })).location, /code=OAUTH_STATE_INVALID/);
    assert.match((await callback(ctx.app, ctx.admin, { code, state: "y".repeat(43) })).location, /code=OAUTH_STATE_INVALID/);
    assert.match((await callback(ctx.app, ctx.admin, { code, state }, { withBrowserCookie: false })).location, /code=OAUTH_BROWSER_MISMATCH/);
    assert.match((await callback(ctx.app, ctx.admin, { code, state })).location, /code=OAUTH_STATE_INVALID/, "already used by the attempt above");
    assert.equal(await stored(ctx), null);
    await ctx.app.db.collection("integrationOAuthStates").insertOne({ _id: "m".repeat(43), provider: "monday", userId: crypto.randomBytes(12).toString("hex"), expiresAt: new Date(Date.now() + 60000) });
    assert.match((await callback(ctx.app, ctx.admin, { code, state: "m".repeat(43) })).location, /code=OAUTH_STATE_INVALID/);
    assert.ok(await ctx.app.db.collection("integrationOAuthStates").findOne({ _id: "m".repeat(43) }), "another provider's state isn't consumed");
    await afterEachClose();
  });

  test("an expired state is refused", async () => {
    const res = await ctx.admin.request("POST", "/api/v1/integrations/google-drive/connect");
    const { code, state } = ctx.google.approve(res.body.authorizeUrl);
    await ctx.app.db.collection("integrationOAuthStates").updateOne({ _id: state }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.match((await callback(ctx.app, ctx.admin, { code, state })).location, /code=OAUTH_STATE_INVALID/);
    await afterEachClose();
  });

  test("an administrator who lost the role or the session before returning can't finish", async () => {
    const res = await ctx.admin.request("POST", "/api/v1/integrations/google-drive/connect");
    const { code, state } = ctx.google.approve(res.body.authorizeUrl);
    const saved = await ctx.app.db.collection("integrationOAuthStates").findOne({ _id: state });
    await ctx.app.db.collection("sessions").updateOne({ _id: saved.sessionId }, { $set: { isSystemAdmin: false } });
    assert.match((await callback(ctx.app, ctx.admin, { code, state })).location, /code=FORBIDDEN/);
    assert.equal(await stored(ctx), null);
    await afterEachClose();
  });

  test("cancelling at Google saves nothing", async () => {
    const res = await ctx.admin.request("POST", "/api/v1/integrations/google-drive/connect");
    const { state } = ctx.google.approve(res.body.authorizeUrl);
    assert.match((await callback(ctx.app, ctx.admin, { error: "access_denied", state })).location, /result=cancelled/);
    assert.equal(await stored(ctx), null);
    await afterEachClose();
  });

  test("refused and revoked: the wrong Google account", async () => {
    ctx.google.email = "someone.else@example.invalid";
    const res = await connect(ctx);
    assert.match(res.location, /code=GDRIVE_WRONG_ACCOUNT/);
    assert.equal(await stored(ctx), null);
    assert.equal(ctx.google.revoked.length, 1);
    await afterEachClose();
  });

  test("refused, nothing saved: Drive access not granted; no refresh token; a failed exchange; a failed connection check", async () => {
    ctx.google.grant = { scope: "openid", refresh: true };
    assert.match((await connect(ctx)).location, /code=GDRIVE_SCOPE_DENIED/);
    assert.equal(ctx.google.revoked.length, 0, "this could be the working connection's own grant");
    ctx.google.grant = { scope: SCOPE, refresh: false };
    assert.match((await connect(ctx)).location, /code=GDRIVE_NO_REFRESH_TOKEN/);
    ctx.google.grant = { scope: SCOPE, refresh: true };
    ctx.google.fail.push({ match: /oauth2\.googleapis\.com\/token/, status: 400, body: { error: "invalid_grant" } });
    assert.match((await connect(ctx)).location, /code=OAUTH_EXCHANGE_FAILED/);
    ctx.google.fail.push({ match: /upload\/drive/, status: 403, reason: "forbidden" });
    assert.match((await connect(ctx)).location, /code=GDRIVE_CHECK_FAILED/);
    assert.equal(await stored(ctx), null);
    assert.equal(ctx.google.active().length, 0, "the check leaves nothing behind");
    assert.equal(ctx.google.folders().length, 1, "and the folder is reused next time");
    assert.match((await connect(ctx)).location, /result=connected/);
    assert.equal(ctx.google.folders().length, 1);
    await afterEachClose();
  });

  test("Google's error text and codes never reach the address bar or the logs", async () => {
    ctx.google.fail.push({ match: /token/, status: 400, body: { error: "invalid_grant", error_description: "SECRET-DETAIL" } });
    const res = await connect(ctx);
    assert.doesNotMatch(res.location, /SECRET-DETAIL/);
    assert.doesNotMatch(ctx.app.logger.errors.join(" "), /SECRET-DETAIL|code-\d|refresh-|access-/);
    await afterEachClose();
  });

  test("disconnect needs confirming, forgets and revokes the token, keeps the folder; reconnecting reuses it; another account is refused", async () => {
    await connect(ctx);
    const [refresh] = ctx.google.refreshTokens, folderId = (await stored(ctx)).folderId;
    assert.equal((await ctx.admin.request("POST", "/api/v1/integrations/google-drive/disconnect", {})).status, 400);
    assert.equal((await ctx.admin.request("POST", "/api/v1/integrations/google-drive/disconnect", { confirm: true })).body.connected, false);
    assert.deepEqual(ctx.google.revoked, [refresh]);
    const rec = await stored(ctx);
    assert.equal(rec.refreshToken, undefined); assert.equal(rec.folderId, folderId); assert.equal(rec.status, "disconnected");
    assert.equal((await ctx.admin.request("GET", "/api/v1/integrations/google-drive")).body.state, "not_connected");
    assert.equal((await ctx.admin.request("POST", "/api/v1/integrations/google-drive/test")).status, 503);
    assert.match((await connect(ctx)).location, /result=connected/);
    assert.equal((await stored(ctx)).folderId, folderId);
    assert.equal(ctx.google.folders().length, 1);
    await ctx.admin.request("POST", "/api/v1/integrations/google-drive/disconnect", { confirm: true });
    ctx.google.permissionId = "perm-2";
    assert.match((await connect(ctx)).location, /code=GDRIVE_ACCOUNT_CHANGED/);
    await afterEachClose();
  });

  test("a folder that was removed in Drive is replaced for new files, and the status test reports it", async () => {
    await connect(ctx);
    const first = (await stored(ctx)).folderId;
    ctx.google.files.get(first).trashed = true;
    const test1 = await ctx.admin.request("POST", "/api/v1/integrations/google-drive/test");
    assert.equal(test1.status, 409); assert.equal(test1.body.error.code, "GDRIVE_FOLDER_MISSING");
    assert.equal((await ctx.admin.request("GET", "/api/v1/integrations/google-drive")).body.lastError, "GDRIVE_FOLDER_MISSING");
    assert.match((await connect(ctx)).location, /result=connected/);
    assert.notEqual((await stored(ctx)).folderId, first);
    await afterEachClose();
  });
});

describe("attachments in Drive", () => {
  let ctx, record, board;
  before(async () => { ctx = await start({ provider: "gdrive" }); ({ record, board } = await workspace(ctx)); await connect(ctx); });
  after(() => ctx.app.close());

  test("upload: bytes go to Drive under an internal name in JARC's folder; MongoDB keeps the metadata; the API shows no Drive detail", async () => {
    const up = await upload(ctx, record.id);
    assert.equal(up.status, 201);
    const id = up.body.attachment.id, doc = docs(ctx).find((d) => d._id.toHexString() === id), file = ctx.google.files.get(doc.storage.key);
    assert.equal(doc.storage.provider, "gdrive");
    assert.deepEqual([doc.name, doc.type, doc.size, doc.status], ["Quarterly report.png", "image/png", PNG.length, "ready"]);
    assert.equal(doc.sha256, crypto.createHash("sha256").update(PNG).digest("hex"));
    assert.equal(doc.uploadedByName, "Ada Admin"); assert.equal(String(doc.recordId), record.id); assert.equal(String(doc.boardId), board.id);
    assert.equal(ctx.app.fileStore.files.size, 0, "no bytes went to the database's file store");
    assert.equal(JSON.stringify(doc).includes(PNG.toString("base64")), false);
    assert.equal(file.name, `${id}.png`); assert.doesNotMatch(file.name, /Quarterly/);
    assert.deepEqual(file.parents, [(await stored(ctx)).folderId]);
    assert.deepEqual(file.appProperties, { jarcKind: "att", jarcAttachmentId: id });
    assert.ok(file.bytes.equals(PNG));
    const listed = await ctx.admin.request("GET", `/api/v1/records/${record.id}/attachments`);
    assert.equal(listed.body.items[0].name, "Quarterly report.png");
    assert.doesNotMatch(listed.text, new RegExp(`${doc.storage.key}|googleapis|gdrive|storage`));
    assert.ok((await ctx.app.db.collection("activities").find({ action: "attachment.added" }).toArray()).some((a) => a.summary === "Quarterly report.png"));
  });

  test("download: the original bytes and file name through JARC, with no redirect to Google", async () => {
    const up = await upload(ctx, record.id, PNG, { name: "Résumé final.png" });
    const d = await download(ctx, up.body.attachment.id);
    assert.equal(d.status, 200); assert.ok(d.bytes.equals(PNG));
    assert.equal(d.headers.get("content-type"), "image/png");
    assert.match(d.headers.get("content-disposition"), /filename\*=UTF-8''R%C3%A9sum%C3%A9%20final\.png/);
    assert.match(d.headers.get("etag"), /[0-9a-f]{64}/);
  });

  test("access is still JARC's: an employee with no Google account and no membership gets 404; a viewer can read but not upload", async () => {
    const up = await upload(ctx, record.id);
    const id = up.body.attachment.id;
    assert.equal((await download(ctx, id, ctx.member)).status, 404);
    assert.equal((await upload(ctx, record.id, PNG, { client: ctx.member })).status, 404);
    const me = (await ctx.member.request("GET", "/api/v1/me")).body;
    const { ObjectId } = require("mongodb");
    const userId = new ObjectId(me.user?.id || me.id);
    await ctx.app.db.collection("workspaceMembers").insertOne({ workspaceId: docs(ctx)[0].workspaceId, userId, role: "VIEWER", status: "active", createdAt: new Date() });
    assert.equal((await download(ctx, id, ctx.member)).status, 200);
    assert.equal((await upload(ctx, record.id, PNG, { client: ctx.member })).status, 403);
    assert.equal((await ctx.member.request("DELETE", `/api/v1/attachments/${id}`)).status, 403);
    assert.ok(ctx.member.setCookies.every((c) => !/google/i.test(c)));
  });

  test("removing moves the file to Drive Trash, marked removed; JARC forgets it; the activity log says what it was", async () => {
    const up = await upload(ctx, record.id, PNG, { name: "to-remove.png" });
    const id = up.body.attachment.id, key = docs(ctx).find((d) => d._id.toHexString() === id).storage.key;
    const used = (await ctx.app.db.collection("storageUsage").findOne({ _id: "gdrive" })).usedBytes;
    assert.equal((await ctx.admin.request("DELETE", `/api/v1/attachments/${id}`)).status, 200);
    const file = ctx.google.files.get(key);
    assert.ok(file, "still recoverable in Drive"); assert.equal(file.trashed, true); assert.equal(file.appProperties.jarcKind, "removed");
    assert.equal((await download(ctx, id)).status, 404);
    assert.equal((await ctx.app.db.collection("storageUsage").findOne({ _id: "gdrive" })).usedBytes, used - PNG.length);
    const entry = (await ctx.app.db.collection("activities").find({ action: "attachment.removed" }).toArray()).find((a) => String(a.entityId) === id);
    assert.equal(entry.summary, "to-remove.png");
  });

  test("deleting a record moves its files to Trash too", async () => {
    const r = (await ctx.admin.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Temp" } })).body.record;
    const up = await upload(ctx, r.id);
    const key = docs(ctx).find((d) => d._id.toHexString() === up.body.attachment.id).storage.key;
    await ctx.app.dataLayer.services.files.purge({ recordId: docs(ctx).find((d) => d.storage?.key === key).recordId });
    assert.equal(ctx.google.files.get(key).trashed, true);
  });

  test("a large file goes in chunks and continues after an interruption from what Google confirmed", async () => {
    const file = big(CHUNK * 3 + 1234);
    ctx.google.interruptNextChunk = 0;
    const first = await upload(ctx, record.id, file, { name: "chunks.png" });
    assert.equal(first.status, 201);
    assert.ok((await download(ctx, first.body.attachment.id)).bytes.equals(file));
    assert.ok(ctx.google.calls.filter((c) => c.method === "PUT").length >= 4);
    const other = big(CHUNK * 2 + 77);
    ctx.google.interruptNextChunk = CHUNK / 2;
    ctx.google.fail.push({ match: /upload_id/, network: true });
    const second = await upload(ctx, record.id, other, { name: "chunks2.png" });
    assert.equal(second.status, 201);
    assert.ok((await download(ctx, second.body.attachment.id)).bytes.equals(other));
  });

  test("temporary Google failures are retried on every step of an upload and a download", async () => {
    ctx.google.fail.push({ match: /generateIds/, status: 503 }, { match: /uploadType=resumable$|uploadType=resumable&fields/, status: 429, reason: "rateLimitExceeded" }, { match: /upload\/drive/, network: true }, { match: /alt=media/, status: 500 }, { match: /alt=media/, status: 403, reason: "userRateLimitExceeded" });
    const up = await upload(ctx, record.id);
    assert.equal(up.status, 201);
    assert.ok((await download(ctx, up.body.attachment.id)).bytes.equals(PNG));
    assert.equal(ctx.google.fail.length, 0);
  });

  test("an expired access token is replaced once, without anyone noticing", async () => {
    const up = await upload(ctx, record.id);
    ctx.google.accessTokens.clear();
    const refreshes = ctx.google.refreshes;
    assert.ok((await download(ctx, up.body.attachment.id)).bytes.equals(PNG));
    assert.equal(ctx.google.refreshes, refreshes + 1);
  });

  test("a rotated refresh token replaces the stored one, encrypted", async () => {
    const before1 = JSON.stringify((await stored(ctx)).refreshToken);
    ctx.google.rotateTo = "refresh-rotated";
    ctx.google.accessTokens.clear();
    assert.equal((await ctx.admin.request("POST", "/api/v1/integrations/google-drive/test")).status, 200);
    ctx.google.rotateTo = null;
    const after1 = await stored(ctx);
    assert.notEqual(JSON.stringify(after1.refreshToken), before1);
    assert.equal(JSON.stringify(after1).includes("refresh-rotated"), false);
    ctx.google.accessTokens.clear();
    assert.equal((await ctx.admin.request("POST", "/api/v1/integrations/google-drive/test")).status, 200);
  });

  test("many requests at once share one token refresh", async () => {
    const up = await upload(ctx, record.id);
    ctx.drive.cached = null;
    const refreshes = ctx.google.refreshes;
    const all = await Promise.all(Array.from({ length: 6 }, () => download(ctx, up.body.attachment.id)));
    assert.ok(all.every((d) => d.status === 200));
    assert.equal(ctx.google.refreshes, refreshes + 1);
  });

  test("a failed upload leaves no document, no reservation and a clear answer", async () => {
    const usage = () => ctx.app.db.collection("storageUsage").findOne({ _id: "gdrive" });
    const count = docs(ctx).length, used = (await usage()).usedBytes;
    const outage = () => Array.from({ length: 4 }, () => ({ match: /upload_id/, status: 503 }));
    ctx.google.fail.push(...outage(), ...outage());
    const down = await upload(ctx, record.id);
    assert.equal(down.status, 503); assert.equal(down.body.error.code, "STORAGE_UNAVAILABLE");
    ctx.google.fail.length = 0;
    ctx.google.corruptNextUpload = true;
    const corrupt = await upload(ctx, record.id);
    assert.equal(corrupt.status, 502); assert.equal(corrupt.body.error.code, "STORE_VERIFY_FAILED");
    ctx.google.ignoreNextId = true;
    assert.equal((await upload(ctx, record.id)).status, 502, "a file stored under another ID isn't accepted");
    ctx.google.fail.push({ match: /upload\/drive/, status: 403, reason: "storageQuotaExceeded" });
    const full = await upload(ctx, record.id);
    assert.equal(full.status, 507); assert.equal(full.body.error.code, "STORAGE_FULL");
    assert.equal(docs(ctx).length, count);
    const after1 = await usage();
    assert.equal(after1.reservedBytes, 0); assert.equal(after1.usedBytes, used);
  });

  test("JARC's own limit and file checks still apply before Drive is touched", async () => {
    const calls = ctx.google.calls.length;
    const wrong = await upload(ctx, record.id, Buffer.from("not a png at all, not at all"));
    assert.equal(wrong.status, 415);
    const usage = ctx.app.dataLayer.services.files;
    const original = usage.limits.gdrive;
    usage.limits.gdrive = 1;
    assert.equal((await upload(ctx, record.id)).status, 507);
    usage.limits.gdrive = original;
    assert.equal(ctx.google.calls.slice(calls).filter((c) => /upload\/drive/.test(c.url)).length, 0, "no bytes were sent to Google");
    assert.equal(ctx.google.active().filter((f) => f.bytes?.toString().startsWith("not a png")).length, 0);
  });

  test("a download cut off part-way drops the connection, never a short file presented as complete", async () => {
    const up = await upload(ctx, record.id);
    ctx.google.fail.push({ match: /alt=media/, truncate: 10 });
    await assert.rejects(download(ctx, up.body.attachment.id));
    assert.ok((await download(ctx, up.body.attachment.id)).bytes.equals(PNG), "the next try works");
  });

  test("download failures: a temporary outage is 503, a file gone from Drive is 404, neither looks like the file", async () => {
    const up = await upload(ctx, record.id);
    const id = up.body.attachment.id, key = docs(ctx).find((d) => d._id.toHexString() === id).storage.key;
    ctx.google.fail.push(...Array.from({ length: 4 }, () => ({ match: /alt=media/, status: 503 })));
    const outage = await download(ctx, id);
    assert.equal(outage.status, 503);
    assert.match(outage.headers.get("content-type"), /json/);
    assert.equal(outage.headers.get("content-disposition"), null);
    assert.doesNotMatch(outage.headers.get("etag") || "", /[0-9a-f]{64}/, "the file's own ETag isn't used for an error");
    assert.equal(JSON.parse(outage.bytes).error.code, "STORAGE_UNAVAILABLE");
    ctx.google.files.delete(key);
    const gone = await download(ctx, id);
    assert.equal(gone.status, 404); assert.equal(gone.headers.get("content-disposition"), null);
  });

  test("the sweep trashes files with no attachment, and never touches files with one, test files, or removed files restored from Trash", async () => {
    const up = await upload(ctx, record.id);
    const key = docs(ctx).find((d) => d._id.toHexString() === up.body.attachment.id).storage.key;
    ctx.google.files.get(key).createdTime = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    ctx.google.add({ id: "orphan", name: "x", bytes: PNG, appProperties: { jarcKind: "att" } });
    ctx.google.add({ id: "fresh-orphan", name: "x", bytes: PNG, createdTime: new Date().toISOString(), appProperties: { jarcKind: "att" } });
    ctx.google.add({ id: "probe", name: "x", bytes: PNG, appProperties: { jarcKind: "probe" } });
    ctx.google.add({ id: "restored", name: "x", bytes: PNG, trashed: false, appProperties: { jarcKind: "removed" } });
    ctx.google.add({ id: "by-hand", name: "x", bytes: PNG });
    await ctx.app.dataLayer.services.files.sweep();
    assert.equal(ctx.google.files.get("orphan").trashed, true);
    for (const id of [key, "fresh-orphan", "probe", "restored", "by-hand"]) assert.equal(ctx.google.files.get(id).trashed, false, id);
    assert.ok(ctx.google.files.get("orphan"), "trashed, never deleted");
  });

  test("the sweep survives Drive being unreachable and cleans the other stores", async () => {
    ctx.google.fail.push(...Array.from({ length: 4 }, () => ({ match: /drive\/v3\/files\?q=/, status: 503 })));
    const orphan = new (require("mongodb").ObjectId)();
    const stale = new Date(Date.now() - 3 * 3600 * 1000);
    const store = ctx.app.fileStore;
    store.files.set(String(orphan), { id: orphan, data: PNG, uploadDate: stale });
    const errors = ctx.app.logger.errors.length;
    await ctx.app.dataLayer.services.files.sweep();
    assert.equal(store.files.has(String(orphan)), false);
    assert.ok(ctx.app.logger.errors.slice(errors).some((e) => /sweep of gdrive failed: STORAGE_UNAVAILABLE/.test(e)));
    ctx.google.fail.length = 0;
  });
});

describe("existing attachments stay where they are", () => {
  test("a file stored before keeps working after new uploads switch to Drive, and each is deleted where it lives", async () => {
    const ctx = await start();
    const { record } = await workspace(ctx);
    const old = await upload(ctx, record.id, PNG, { name: "old.png" });
    assert.equal(ctx.app.fileStore.files.size, 1);
    await connect(ctx);
    assert.equal(ctx.google.active().length, 0, "connecting moves nothing");
    const files = ctx.app.dataLayer.services.files;
    const stillOld = await upload(ctx, record.id, PNG, { name: "still-old.png" });
    assert.equal(docs(ctx).find((d) => d._id.toHexString() === stillOld.body.attachment.id).storage, undefined, "connected but not activated: uploads don't go to Drive");
    files.storage.defaultProvider = "gdrive"; // the configured switch (ATTACHMENTS_STORE=gdrive)
    const added = await upload(ctx, record.id, PNG, { name: "new.png" });
    assert.equal(ctx.app.fileStore.files.size, 2, "existing bytes weren't touched");
    assert.equal(ctx.google.active().length, 1);
    assert.ok((await download(ctx, old.body.attachment.id)).bytes.equals(PNG));
    assert.ok((await download(ctx, added.body.attachment.id)).bytes.equals(PNG));
    assert.equal((await ctx.admin.request("DELETE", `/api/v1/attachments/${old.body.attachment.id}`)).status, 200);
    assert.equal(ctx.app.fileStore.files.size, 1);
    assert.equal(ctx.google.active().length, 1, "deleting an old file leaves Drive alone");
    await ctx.app.close();
  });

  test("Drive switched off on the server later: its files answer 503 and can't be unlinked; the others keep working", async () => {
    const google = mockGoogle();
    const ctx = await start({ provider: "gdrive", google });
    const { record } = await workspace(ctx);
    await connect(ctx);
    const up = await upload(ctx, record.id);
    const id = up.body.attachment.id;
    const storage = ctx.app.dataLayer.services.files.storage;
    storage.stores.delete("gdrive"); storage.defaultProvider = "gridfs";
    const d = await download(ctx, id);
    assert.equal(d.status, 503); assert.equal(d.headers.get("content-disposition"), null);
    assert.equal((await ctx.admin.request("DELETE", `/api/v1/attachments/${id}`)).status, 503);
    assert.ok(docs(ctx).some((x) => x._id.toHexString() === id));
    assert.equal((await upload(ctx, record.id)).status, 201);
    await ctx.app.close();
  });
});

describe("when the connection is lost", () => {
  test("revoked access: needs reconnect, uploads refused before reading anything, downloads 503, reconnecting restores everything", async () => {
    const ctx = await start({ provider: "gdrive" });
    const { record } = await workspace(ctx);
    await connect(ctx);
    const up = await upload(ctx, record.id);
    const id = up.body.attachment.id;
    ctx.google.refreshTokens.clear(); ctx.google.accessTokens.clear();
    const d = await download(ctx, id);
    assert.equal(d.status, 503); assert.equal(JSON.parse(d.bytes).error.code, "STORAGE_NOT_CONNECTED");
    const status = (await ctx.admin.request("GET", "/api/v1/integrations/google-drive")).body;
    assert.equal(status.state, "needs_reconnect"); assert.equal(status.lastError, "GDRIVE_ACCESS_REVOKED");
    const refreshes = ctx.google.refreshes, calls = ctx.google.calls.length;
    const refused = await upload(ctx, record.id);
    assert.equal(refused.status, 503); assert.equal(refused.body.error.code, "STORAGE_NOT_CONNECTED");
    assert.equal((await download(ctx, id)).status, 503);
    assert.equal(ctx.google.refreshes, refreshes, "no retrying against a refused token"); assert.equal(ctx.google.calls.length, calls);
    await ctx.app.dataLayer.services.files.sweep();
    assert.equal(ctx.google.calls.length, calls, "the sweep waits too");
    assert.match((await connect(ctx)).location, /result=connected/);
    assert.ok((await download(ctx, id)).bytes.equals(PNG));
    assert.equal((await upload(ctx, record.id)).status, 201);
    assert.equal((await ctx.admin.request("GET", "/api/v1/integrations/google-drive")).body.lastError, null);
    await ctx.app.close();
  });

  test("a replaced encryption key: reconnect needed, no crash, and the key's failure is named for the administrator", async () => {
    const ctx = await start({ provider: "gdrive" });
    const { record } = await workspace(ctx);
    await connect(ctx);
    const up = await upload(ctx, record.id);
    ctx.drive.cached = null;
    ctx.drive.config = config({ GOOGLE_DRIVE_TOKEN_KEY: Buffer.alloc(32, 9).toString("base64") });
    assert.equal((await download(ctx, up.body.attachment.id)).status, 503);
    assert.equal((await ctx.admin.request("GET", "/api/v1/integrations/google-drive")).body.lastError, "GDRIVE_TOKEN_KEY_MISMATCH");
    await ctx.app.close();
  });

  test("Google's token service down, or JARC's client secret wrong: 503, and the connection is kept", async () => {
    const ctx = await start({ provider: "gdrive" });
    const { record } = await workspace(ctx);
    await connect(ctx);
    const up = await upload(ctx, record.id), id = up.body.attachment.id;
    ctx.drive.cached = null;
    ctx.google.fail.push(...Array.from({ length: 3 }, () => ({ match: /oauth2\.googleapis\.com\/token/, status: 503 })));
    assert.equal((await download(ctx, id)).status, 503);
    assert.equal((await stored(ctx)).status, "connected");
    ctx.google.fail.push({ match: /oauth2\.googleapis\.com\/token/, status: 401, body: { error: "invalid_client" } });
    assert.equal((await download(ctx, id)).status, 503);
    const rec = await stored(ctx);
    assert.equal(rec.status, "connected"); assert.equal(rec.lastError, "GDRIVE_REFRESH_INVALID_CLIENT");
    assert.ok((await download(ctx, id)).bytes.equals(PNG), "and it recovers by itself");
    assert.equal((await stored(ctx)).lastError, null);
    await ctx.app.close();
  });
});

describe("keeping access to files already in Drive", () => {
  test("disconnecting with attachments in Drive forgets the token but doesn't revoke the grant; reconnecting reaches the same files", async () => {
    const ctx = await start({ provider: "gdrive" });
    const { record } = await workspace(ctx);
    await connect(ctx);
    const up = await upload(ctx, record.id), [refresh] = ctx.google.refreshTokens;
    const res = await ctx.admin.request("POST", "/api/v1/integrations/google-drive/disconnect", { confirm: true });
    assert.deepEqual(res.body, { connected: false, revoked: false });
    assert.deepEqual(ctx.google.revoked, []);
    assert.ok(ctx.google.refreshTokens.has(refresh), "the grant is still alive at Google");
    assert.equal((await stored(ctx)).refreshToken, undefined, "and JARC holds no copy");
    assert.equal(JSON.stringify(await stored(ctx)).includes(refresh), false);
    assert.equal((await download(ctx, up.body.attachment.id)).status, 503);
    assert.match((await connect(ctx)).location, /result=connected/);
    assert.equal((await stored(ctx)).lastError, null);
    assert.ok((await download(ctx, up.body.attachment.id)).bytes.equals(PNG));
    await ctx.app.close();
  });

  test("lost access is noticed: reconnecting and Test connection warn when existing files can't be reached, and a new token doesn't clear it", async () => {
    const ctx = await start({ provider: "gdrive" });
    const { record } = await workspace(ctx);
    await connect(ctx);
    const up = await upload(ctx, record.id);
    ctx.google.files.delete(docs(ctx).find((d) => d._id.toHexString() === up.body.attachment.id).storage.key);
    const tested = await ctx.admin.request("POST", "/api/v1/integrations/google-drive/test");
    assert.equal(tested.status, 409); assert.equal(tested.body.error.code, "GDRIVE_FILES_UNREACHABLE");
    assert.match((await connect(ctx)).location, /result=connected/);
    const status = await ctx.admin.request("GET", "/api/v1/integrations/google-drive");
    assert.equal(status.body.state, "connected"); assert.equal(status.body.lastError, "GDRIVE_FILES_UNREACHABLE");
    ctx.drive.cached = null;
    await upload(ctx, record.id);
    assert.equal((await stored(ctx)).lastError, "GDRIVE_FILES_UNREACHABLE");
    await ctx.app.close();
  });

  test("an unreachable earlier folder is reported when a new one replaces it", async () => {
    const ctx = await start({ provider: "gdrive" });
    await connect(ctx);
    ctx.google.files.delete((await stored(ctx)).folderId);
    assert.match((await connect(ctx)).location, /result=connected/);
    assert.equal((await stored(ctx)).lastError, "GDRIVE_FOLDER_REPLACED");
    await ctx.app.close();
  });

  test("the sweep reaches every file over several passes, however many there are, and starts again", async () => {
    const ctx = await start({ provider: "gdrive" });
    await connect(ctx);
    for (let i = 0; i < 5; i += 1) ctx.google.add({ id: `orphan-${i}`, name: "x", bytes: PNG, appProperties: { jarcKind: "att" } });
    const store = ctx.drive.store, cutoff = new Date();
    const pass1 = await store.listIds({ before: cutoff, limit: 2 }), pass2 = await store.listIds({ before: new Date(), limit: 2 }), pass3 = await store.listIds({ before: new Date(), limit: 2 }), pass4 = await store.listIds({ before: new Date(), limit: 2 });
    assert.deepEqual([pass1.length, pass2.length, pass3.length], [2, 2, 1]);
    assert.equal(new Set([...pass1, ...pass2, ...pass3]).size, 5);
    assert.deepEqual(pass4, pass1, "back to the start");
    await ctx.app.close();
  });

  test("a removed folder gives an upload a clear 503, not 'the upload didn't finish'", async () => {
    const ctx = await start({ provider: "gdrive" });
    const { record } = await workspace(ctx);
    await connect(ctx);
    ctx.google.fail.push({ match: /upload\/drive/, status: 404, reason: "notFound" });
    const res = await upload(ctx, record.id);
    assert.equal(res.status, 503); assert.equal(res.body.error.code, "STORAGE_UNAVAILABLE");
    await ctx.app.close();
  });
});

describe("over real HTTP (Node's own fetch, a local server in front of the mock)", () => {
  // The in-process mock skips the HTTP layer, where a 308 could be treated as a redirect and bodies and aborts really happen.
  let server, base;
  let target = null;
  const realFetch = (url, init = {}) => globalThis.fetch(`${base}/`, { ...init, headers: { ...init.headers, "x-original-url": String(url) } });
  before(async () => {
    const http = require("http");
    server = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const headers = {};
      for (const [from, to] of [["authorization", "Authorization"], ["content-range", "Content-Range"], ["content-type", "Content-Type"]]) if (req.headers[from]) headers[to] = req.headers[from];
      const out = await target.fetch(req.headers["x-original-url"], { method: req.method, headers, ...(body.length ? { body: req.method === "PUT" ? body : body.toString() } : {}) }).catch(() => new Response("refused", { status: 599 }));
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  test("connect, chunked upload with a 308 after each chunk, an interruption, download and Trash all work through real fetch", async () => {
    const google = mockGoogle();
    target = google;
    const ctx = await start({ provider: "gdrive", google, fetch: realFetch });
    const { record } = await workspace(ctx);
    assert.match((await connect(ctx)).location, /result=connected/);
    assert.equal(ctx.google.active().length, 0);
    const file = big(CHUNK * 3 + 999);
    google.interruptNextChunk = CHUNK;
    const up = await upload(ctx, record.id, file, { name: "real-http.png" });
    assert.equal(up.status, 201);
    const d = await download(ctx, up.body.attachment.id);
    assert.equal(d.status, 200); assert.ok(d.bytes.equals(file));
    assert.equal((await ctx.admin.request("DELETE", `/api/v1/attachments/${up.body.attachment.id}`)).status, 200);
    assert.equal(ctx.google.active().length, 0); assert.equal(ctx.google.outside.length, 0);
    await ctx.app.close();
  });

  test("a 308 is never followed as a redirect, even with a Location; a cancelled session sends DELETE without error", async () => {
    const http = require("http"), { DriveClient } = require("../src/integrations/google-drive/client");
    const hits = [];
    const local = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`); req.resume();
      req.on("end", () => { if (req.url === "/evil") { res.writeHead(200); return res.end("{}"); } res.writeHead(req.method === "DELETE" ? 499 : 308, { Location: "/evil", Range: "bytes=0-262143" }); return res.end(); });
    });
    await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
    const session = `http://127.0.0.1:${local.address().port}/session`;
    const client = new DriveClient({ getToken: async () => "t", sleep: async () => {} });
    assert.equal(await client.sendChunk(session, Buffer.alloc(CHUNK), 0, CHUNK * 2), null, "Google wants the next chunk");
    await client.cancelUpload(session);
    assert.deepEqual(hits, ["PUT /session", "DELETE /session"]);
    await new Promise((resolve) => local.close(resolve));
  });

  test("a download abandoned by the person also stops the transfer from Drive", async () => {
    const { GoogleDriveFileStore } = require("../src/integrations/google-drive/file-store");
    let signal;
    const store = new GoogleDriveFileStore({ open: async () => ({ client: { download: async (_id, o) => { signal = o.signal; return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })); } } }) });
    const out = store.openDownload("id");
    out.on("error", () => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    out.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(signal.aborted, true);
  });
});

describe("re-checking the administrator on the return from Google", () => {
  const { stillSystemAdmin } = require("../src/auth/session");
  const userId = "u1", later = new Date(Date.now() + 60000), now = () => new Date();
  const check = (session, user, accountMode) => stillSystemAdmin({ accountMode, now, sessions: { findById: async () => session }, users: { findById: async () => user } })({ sessionId: "s", userId });
  const session = { userId, isSystemAdmin: true, expiresAt: later, idleExpiresAt: later };
  const user = { status: "active" };
  test("needs a live session of the same person, still active and still an administrator", async () => {
    assert.equal(await check(session, user, "off"), true);
    assert.equal(await check(null, user, "off"), false);
    assert.equal(await check({ ...session, userId: "other" }, user, "off"), false);
    assert.equal(await check({ ...session, expiresAt: new Date(0) }, user, "off"), false);
    assert.equal(await check({ ...session, idleExpiresAt: new Date(0) }, user, "off"), false);
    assert.equal(await check({ ...session, isSystemAdmin: false }, user, "off"), false);
    assert.equal(await check(session, { status: "disabled" }, "off"), false);
    assert.equal(await stillSystemAdmin({ sessions: {}, users: {} })({ sessionId: null, userId }), false);
  });
  test("account management: a blocked account is refused; enforced means an active Super Admin", async () => {
    assert.equal(await check(session, { status: "active", account: { role: "MEMBER", status: "blocked" } }, "staged"), false);
    assert.equal(await check(session, { status: "active", account: { role: "SUPER_ADMIN", status: "active" } }, "enforced"), true);
    assert.equal(await check(session, { status: "active", account: { role: "MEMBER", status: "active" } }, "enforced"), false);
  });
});

describe("the monday.com integration is unaffected", () => {
  test("its OAuth still completes, and a Google state can't be used on its callback", async () => {
    const monday = mockMonday(), google = mockGoogle();
    const both = async (url, init) => (/google|accounts\.google/.test(String(url)) ? google.fetch(url, init) : monday.fetch(url, init));
    const ctx = await start({ google, monday: loadMondayConfig(MONDAY_ENV), fetch: both });
    const started = await ctx.admin.request("POST", "/api/v1/integrations/google-drive/connect");
    const googleState = google.approve(started.body.authorizeUrl).state;
    const cross = await fetch(`${ctx.app.url}/api/v1/integrations/monday/callback?code=x&state=${googleState}`, { redirect: "manual" });
    assert.match(cross.headers.get("location"), /code=OAUTH_STATE_INVALID/);
    assert.ok(await ctx.app.db.collection("integrationOAuthStates").findOne({ _id: googleState }));
    const m = await ctx.admin.request("POST", "/api/v1/integrations/monday/connect");
    const state = new URL(m.body.authorizeUrl).searchParams.get("state");
    const done = await fetch(`${ctx.app.url}/api/v1/integrations/monday/callback?code=mock-code&state=${state}`, { redirect: "manual" });
    assert.match(done.headers.get("location"), /result=connected/);
    await ctx.app.close();
  });
});
