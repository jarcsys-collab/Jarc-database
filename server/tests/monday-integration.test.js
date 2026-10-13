// monday.com integration (Phase 7), entirely offline: a mock monday.com (OAuth token endpoint + GraphQL API) is
// passed in as `fetch`, and it refuses every other URL — tests can never reach the real monday.com. Covers setup
// states, OAuth state, credentials, connection errors, discovery, pagination, column mapping, import preview,
// imports (confirmation, duplicates, interrupted-import recovery), webhooks (verification, duplicates, out-of-order),
// sync retry, pause, read-only boards, administrator permissions and that JARC never sends mutations.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { startEntraApp, SessionClient, api } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { loadMondayConfig } = require("../src/config");
const { MondayClient, MondayApiError } = require("../src/integrations/monday/client");
const { mapColumns, mapItem } = require("../src/integrations/monday/mapping");
const { encrypt, decrypt, verifyJwt, signJwt } = require("../src/integrations/monday/secrets");
const { IntegrationWorker } = require("../src/integrations/monday/worker");

const { mockMonday, item, COLUMNS, ENV, SIGNING, ACCESS_TOKEN } = require("./support/mock-monday");

describe("monday.com client, mapping and secrets (unit)", () => {
  const client = (m, extra = {}) => new MondayClient({ token: ACCESS_TOKEN, fetch: m.fetch, sleep: async () => {}, ...extra });

  test("paginates items with items_page then next_items_page cursors", async () => {
    const m = mockMonday(), c = client(m), seen = [];
    let cursor = null;
    do { const p = await c.itemsPage("111", { cursor, limit: 100 }); seen.push(...p.items); cursor = p.cursor; } while (cursor);
    assert.equal(seen.length, 230);
    assert.equal(new Set(seen.map((i) => i.id)).size, 230);
    assert.equal(m.queries.filter((q) => /next_items_page/.test(q.query)).length, 2);
  });
  test("retries rate limits (429, complexity) and server errors, then succeeds; gives up with RATE_LIMITED", async () => {
    const m = mockMonday(), sleeps = [];
    m.fail.push(429, "complexity", 500, "network");
    const me = await client(m, { sleep: async (ms) => sleeps.push(ms) }).me();
    assert.equal(me.account.name, "Mock Account");
    assert.equal(sleeps[0], 1000, "Retry-After honoured"); assert.equal(sleeps[1], 2000, "retry_in_seconds honoured");
    m.fail.push(429, 429, 429);
    await assert.rejects(client(m, { maxRetries: 2 }).me(), (e) => e instanceof MondayApiError && e.code === "RATE_LIMITED");
  });
  test("connection errors: unauthorized token, unreachable API", async () => {
    const m = mockMonday(); m.fail.push(401);
    await assert.rejects(client(m).me(), (e) => e.code === "UNAUTHORIZED");
    m.fail.push("network", "network", "network");
    await assert.rejects(client(m, { maxRetries: 2 }).me(), (e) => e.code === "NETWORK_ERROR");
    assert.throws(() => new MondayClient({ token: "" }), (e) => e.code === "NOT_CONNECTED");
  });
  test("never sends mutations; API-Version only when configured; the token is not enumerable", async () => {
    const m = mockMonday();
    await assert.rejects(client(m).query("mutation { delete_board(board_id: 1) { id } }"), (e) => e.code === "MUTATION_BLOCKED");
    assert.equal(m.queries.length, 0);
    await client(m).me(); await client(m, { apiVersion: "2026-07" }).me();
    assert.deepEqual(m.queries.map((q) => q.version), [null, "2026-07"]);
    assert.equal(JSON.stringify(client(m)).includes(ACCESS_TOKEN), false);
  });
  test("column mapping: direct types, text fallbacks, skipped types, status labels and colours; values", () => {
    const { columns, plan } = mapColumns({ columns: COLUMNS, groups: [{ id: "g1" }] });
    assert.deepEqual(columns.map((c) => [c.key, c.type]), [["serial", "text"], ["m_status", "status"], ["m_numbers", "number"], ["m_date4", "date"], ["m_person", "text"], ["group", "group"]]);
    assert.deepEqual(columns[1].options, ["Working on it", "Done", "Stuck"]);
    assert.deepEqual(columns[1].colors, ["#fdab3d", "#00c875", "#e2445c"]);
    assert.deepEqual(plan.map((p) => p.handling), ["imported", "imported", "imported", "imported", "imported as text", "skipped"]);
    assert.deepEqual(mapItem(item(4), plan, columns), { serial: "Item 4", m_status: "Done", m_numbers: "40", m_date4: "2026-11-05", m_person: "Ada, Bo" });
  });
  test("secrets: token encryption round-trips; webhook JWTs need the right secret, HS256 and an unexpired token", () => {
    const key = crypto.randomBytes(32), box = encrypt(ACCESS_TOKEN, key);
    assert.equal(JSON.stringify(box).includes(ACCESS_TOKEN), false);
    assert.equal(decrypt(box, key), ACCESS_TOKEN);
    assert.throws(() => decrypt(box, crypto.randomBytes(32)));
    const now = Date.now(), good = signJwt({ exp: Math.floor(now / 1000) + 60 }, SIGNING);
    assert.ok(verifyJwt(good, SIGNING)); assert.ok(verifyJwt(`Bearer ${good}`, SIGNING));
    assert.equal(verifyJwt(good, "wrong"), null);
    assert.equal(verifyJwt(signJwt({ exp: Math.floor(now / 1000) - 60 }, SIGNING), SIGNING), null);
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from("{}").toString("base64url")}.`;
    assert.equal(verifyJwt(none, SIGNING), null);
  });
  test("configuration: off by default, setup lists what is missing, secrets are not serialised, bad values refused", () => {
    const off = loadMondayConfig({});
    assert.equal(off.enabled, false); assert.equal(off.configured, false);
    const on = loadMondayConfig(ENV);
    assert.equal(on.configured, true);
    assert.equal(JSON.stringify(on).includes("test-client-secret") || JSON.stringify(on).includes(SIGNING), false);
    assert.throws(() => loadMondayConfig({ MONDAY_TOKEN_KEY: "c2hvcnQ=" }), /32 random bytes/);
    assert.throws(() => loadMondayConfig({ MONDAY_REDIRECT_URI: "http://jarc.example/cb" }), /https/);
  });
});

describe("monday.com integration API: not set up", () => {
  let app, issuer, admin, member;
  before(async () => {
    issuer = await createTokenIssuer();
    app = await startEntraApp({ issuer, monday: loadMondayConfig({}), fetch: async (u) => { throw new Error(`refused ${u}`); } });
    admin = new SessionClient(app.url, app.entra.appOrigin); member = new SessionClient(app.url, app.entra.appOrigin);
    await admin.signIn(issuer.person("Ada Admin", { admin: true })); await member.signIn(issuer.person("Mia Member"));
  });
  after(async () => { app.app?.locals?.realtime?.closeAll(); await app.close(); });

  test("status says setup required (missing variables only for administrators); nothing can connect", async () => {
    assert.equal((await api(app.url, "GET", "/api/v1/integrations/monday")).status, 401);
    const a = (await admin.request("GET", "/api/v1/integrations/monday")).body;
    assert.equal(a.state, "setup_required"); assert.equal(a.connected, false); assert.ok(a.missing.includes("MONDAY_CLIENT_SECRET"));
    const m = (await member.request("GET", "/api/v1/integrations/monday")).body;
    assert.equal(m.state, "setup_required"); assert.equal(m.missing, undefined); assert.equal(m.canManage, false);
    assert.equal((await admin.request("POST", "/api/v1/integrations/monday/connect")).body.error.code, "SETUP_REQUIRED");
    assert.equal((await admin.request("GET", "/api/v1/integrations/monday/workspaces")).status, 503);
    const cb = await fetch(`${app.url}/api/v1/integrations/monday/callback?code=x&state=${"a".repeat(40)}`, { redirect: "manual" });
    assert.equal(cb.status, 303); assert.match(cb.headers.get("location"), /result=error&code=SETUP_REQUIRED/);
  });
  test("webhooks are refused while not connected", async () => {
    const res = await api(app.url, "POST", "/api/v1/integrations/monday/webhook/anything", { challenge: "x" });
    assert.equal(res.status, 404);
  });
});

describe("monday.com integration API: configured (mock monday.com)", () => {
  let app, issuer, admin, member, mock, workspace, worker, later;
  const tick = (w = worker) => w.tick({ max: 20 });
  const integrationDoc = () => app.db.collection("integrations").findOne({ _id: "monday" });
  const records = (boardId) => app.db.collection("records").docs.filter((r) => r.boardId.toHexString() === boardId);
  async function connect() {
    const start = await admin.request("POST", "/api/v1/integrations/monday/connect");
    const state = new URL(start.body.authorizeUrl).searchParams.get("state");
    return fetch(`${app.url}/api/v1/integrations/monday/callback?code=auth-code-1&state=${state}`, { redirect: "manual" });
  }
  before(async () => {
    issuer = await createTokenIssuer();
    mock = mockMonday();
    app = await startEntraApp({ issuer, monday: loadMondayConfig(ENV), fetch: mock.fetch, accessPolicy: "role_based" });
    admin = new SessionClient(app.url, app.entra.appOrigin); member = new SessionClient(app.url, app.entra.appOrigin);
    await admin.signIn(issuer.person("Ada Admin", { admin: true })); await member.signIn(issuer.person("Mia Member"));
    workspace = (await admin.request("POST", "/api/v1/workspaces", { name: "Imported" })).body.workspace;
    await admin.request("POST", `/api/v1/workspaces/${workspace.id}/members`, { userId: (await member.request("GET", "/api/v1/me")).body.user.id, role: "MEMBER" });
    const service = app.dataLayer.services.integration;
    service.logger = { error() {} };
    worker = new IntegrationWorker({ integration: service, repos: app.dataLayer.repos, logger: { error() {} } });
    later = new IntegrationWorker({ integration: service, repos: app.dataLayer.repos, logger: { error() {} }, now: () => new Date(Date.now() + 3 * 3600e3) });
  });
  after(async () => { app.app?.locals?.realtime?.closeAll(); await app.close(); });

  test("before connecting: Not connected, discovery refused, the worker does nothing", async () => {
    const s = (await admin.request("GET", "/api/v1/integrations/monday")).body;
    assert.equal(s.state, "not_connected"); assert.equal(s.account, null); assert.deepEqual(s.importedBoards, []);
    assert.equal((await admin.request("GET", "/api/v1/integrations/monday/boards")).body.error.code, "NOT_CONNECTED");
    assert.deepEqual(await tick(), { ran: 0 });
    assert.equal(mock.queries.length, 0);
  });
  test("only JARC administrators can manage the integration", async () => {
    for (const [method, path] of [["POST", "/connect"], ["POST", "/disconnect"], ["POST", "/test"], ["GET", "/workspaces"], ["GET", "/boards"], ["GET", "/boards/111/preview"], ["POST", "/sync-now"], ["POST", "/jobs/0123456789abcdef01234567/retry"]]) assert.equal((await member.request(method, `/api/v1/integrations/monday${path}`)).status, 403, path);
    assert.equal((await member.request("POST", "/api/v1/integrations/monday/imports", { boardIds: ["111"], workspaceId: workspace.id, confirm: true })).status, 403);
    assert.equal((await member.request("POST", "/api/v1/integrations/monday/sync", { syncEnabled: true })).status, 403);
    assert.equal((await admin.request("POST", "/api/v1/integrations/monday/connect", undefined, { csrf: "wrong" })).status, 403, "CSRF still required");
  });
  test("OAuth state: required, single use, expiring; a refused code connects nothing", async () => {
    const start = (await admin.request("POST", "/api/v1/integrations/monday/connect")).body;
    const url = new URL(start.authorizeUrl);
    assert.equal(url.origin + url.pathname, "https://auth.monday.com/oauth2/authorize");
    assert.equal(url.searchParams.get("client_id"), "test-client-id"); assert.equal(url.searchParams.has("client_secret"), false);
    const state = url.searchParams.get("state");
    const bad = await fetch(`${app.url}/api/v1/integrations/monday/callback?code=c&state=${"x".repeat(43)}`, { redirect: "manual" });
    assert.match(bad.headers.get("location"), /code=OAUTH_STATE_INVALID/);
    mock.tokenOk = false;
    const refused = await fetch(`${app.url}/api/v1/integrations/monday/callback?code=c&state=${state}`, { redirect: "manual" });
    assert.match(refused.headers.get("location"), /code=OAUTH_EXCHANGE_FAILED/);
    mock.tokenOk = true;
    const reused = await fetch(`${app.url}/api/v1/integrations/monday/callback?code=c&state=${state}`, { redirect: "manual" });
    assert.match(reused.headers.get("location"), /code=OAUTH_STATE_INVALID/, "a state works once");
    const s2 = (await admin.request("POST", "/api/v1/integrations/monday/connect")).body;
    const st2 = new URL(s2.authorizeUrl).searchParams.get("state");
    await app.db.collection("integrationOAuthStates").updateOne({ _id: st2 }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.match((await fetch(`${app.url}/api/v1/integrations/monday/callback?code=c&state=${st2}`, { redirect: "manual" })).headers.get("location"), /OAUTH_STATE_INVALID/);
    const cancelled = await fetch(`${app.url}/api/v1/integrations/monday/callback?error=access_denied&state=x`, { redirect: "manual" });
    assert.match(cancelled.headers.get("location"), /result=cancelled/);
    assert.equal((await admin.request("GET", "/api/v1/integrations/monday")).body.connected, false);
  });
  test("connecting stores the token encrypted and never returns it; sync stays off", async () => {
    const res = await connect();
    assert.equal(res.status, 303); assert.match(res.headers.get("location"), /result=connected/);
    assert.equal(mock.tokenCalls.at(-1).client_secret, "test-client-secret"); assert.equal(mock.tokenCalls.at(-1).code, "auth-code-1");
    const doc = await integrationDoc();
    assert.equal(JSON.stringify(doc).includes(ACCESS_TOKEN), false, "token encrypted at rest");
    const status = await admin.request("GET", "/api/v1/integrations/monday");
    assert.equal(status.body.state, "connected"); assert.equal(status.body.account.name, "Mock Account");
    assert.equal(status.body.sync.enabled, false);
    assert.equal(JSON.stringify(status.body).includes(ACCESS_TOKEN) || JSON.stringify(status.body).includes(doc.webhookSecret), false);
    assert.equal((await admin.request("POST", "/api/v1/integrations/monday/test")).body.ok, true);
  });
  test("discovery: workspaces, boards (sub-item boards hidden), preview with mapped sample records", async () => {
    assert.deepEqual((await admin.request("GET", "/api/v1/integrations/monday/workspaces")).body.items, [{ id: "5", name: "Operations", kind: "open" }]);
    assert.deepEqual((await admin.request("GET", "/api/v1/integrations/monday/boards?workspaceId=5")).body.items.map((b) => b.id), ["111"]);
    assert.equal((await admin.request("GET", "/api/v1/integrations/monday/boards?workspaceId=x")).status, 400);
    const p = (await admin.request("GET", "/api/v1/integrations/monday/boards/111/preview")).body;
    assert.equal(p.board.name, "Projects"); assert.equal(p.sample.length, 5); assert.equal(p.sample[0].serial, "Item 1");
    assert.equal(p.plan.find((x) => x.sourceId === "files").handling, "skipped"); assert.equal(p.alreadyImported, false);
    assert.equal((await admin.request("GET", "/api/v1/integrations/monday/boards/999/preview")).status, 404);
  });
  test("import needs confirmation and valid boards; an interrupted import resumes without duplicates", async () => {
    assert.equal((await admin.request("POST", "/api/v1/integrations/monday/imports", { boardIds: ["111"], workspaceId: workspace.id })).body.error.code, "CONFIRMATION_REQUIRED");
    assert.equal((await admin.request("POST", "/api/v1/integrations/monday/imports", { boardIds: ["x"], workspaceId: workspace.id, confirm: true })).status, 400);
    const res = await admin.request("POST", "/api/v1/integrations/monday/imports", { boardIds: ["111"], workspaceId: workspace.id, confirm: true });
    assert.equal(res.status, 202);
    assert.equal((await admin.request("POST", "/api/v1/integrations/monday/imports", { boardIds: ["111"], workspaceId: workspace.id, confirm: true })).body.error.code, "IMPORT_IN_PROGRESS");
    // Page 1 imports, then page 2 fails (5 network errors = the client's retries) → the job waits to retry.
    mock.fail.push(null, null, "network", "network", "network", "network", "network");
    await tick();
    let job = await app.db.collection("integrationJobs").findOne({ type: "import" });
    assert.equal(job.status, "retry"); assert.equal(job.progress.imported, 100); assert.match(job.error, /could not be reached/);
    const boardId = job.progress.boardId.toHexString();
    assert.equal(records(boardId).length, 100);
    // Simulate the worker having died mid-page after saving records but before saving progress: rewind the cursor.
    await app.db.collection("integrationJobs").updateOne({ _id: job._id }, { $set: { "progress.cursor": null, "progress.imported": 0 } });
    await later.tick();
    job = await app.db.collection("integrationJobs").findOne({ _id: job._id });
    assert.equal(job.status, "done");
    const rows = records(boardId);
    assert.equal(rows.length, 230, "no duplicates after resuming"); assert.equal(new Set(rows.map((r) => r.values.serial)).size, 230);
    const board = (await admin.request("GET", `/api/v1/boards/${boardId}`)).body.board;
    assert.deepEqual(board.source, { provider: "monday", sourceBoardId: "111", readOnly: true });
    assert.deepEqual(board.groups.map((g) => g.name), ["Active", "Done"]);
    assert.equal(rows.find((r) => r.values.serial === "Item 1").groupId, board.groups[0].id);
    assert.equal((await admin.request("POST", "/api/v1/integrations/monday/imports", { boardIds: ["111"], workspaceId: workspace.id, confirm: true })).body.error.code, "ALREADY_IMPORTED");
    const status = (await admin.request("GET", "/api/v1/integrations/monday")).body;
    assert.equal(status.importedBoards[0].boardId, boardId); assert.equal(status.imports[0].status, "done");
  });
  test("imported boards are read-only through the API; archiving and views are allowed; native boards stay editable", async () => {
    const board = (await admin.request("GET", "/api/v1/integrations/monday")).body.importedBoards[0];
    const b = (await admin.request("GET", `/api/v1/boards/${board.boardId}`)).body.board;
    const rec = records(board.boardId)[0], rid = rec._id.toHexString();
    const blocked = [
      ["POST", `/api/v1/boards/${b.id}/records`, { values: { serial: "x" } }],
      ["POST", `/api/v1/boards/${b.id}/records/batch`, { records: [{ values: { serial: "x" } }] }],
      ["PATCH", `/api/v1/boards/${b.id}/records`, { records: [{ id: rid, expectedVersion: rec.version, values: { serial: "x" } }] }],
      ["POST", `/api/v1/boards/${b.id}/records/delete`, { records: [{ id: rid, expectedVersion: rec.version }] }],
      ["PATCH", `/api/v1/records/${rid}`, { expectedVersion: rec.version, values: { serial: "x" } }],
      ["DELETE", `/api/v1/records/${rid}?expectedVersion=${rec.version}`],
      ["POST", `/api/v1/boards/${b.id}/columns`, { column: { key: "x", label: "X", type: "text" } }],
      ["DELETE", `/api/v1/boards/${b.id}/columns/m_status?expectedVersion=${b.version}`],
      ["PATCH", `/api/v1/boards/${b.id}`, { expectedVersion: b.version, name: "Renamed" }],
      ["PATCH", `/api/v1/boards/${b.id}`, { expectedVersion: b.version, columns: b.columns }]
    ];
    for (const [method, path, body] of blocked) { const r = await admin.request(method, path, body); assert.equal(r.status, 403, `${method} ${path}`); assert.equal(r.body.error.code, "READ_ONLY_BOARD"); }
    assert.equal((await member.request("POST", `/api/v1/boards/${b.id}/records`, { values: { serial: "x" } })).body.error.code, "READ_ONLY_BOARD");
    assert.equal((await admin.request("PATCH", `/api/v1/boards/${b.id}`, { expectedVersion: b.version, savedViews: [] })).status, 200);
    assert.equal(records(board.boardId).find((r) => r._id.equals(rec._id)).values.serial, rec.values.serial);
    const native = (await admin.request("POST", `/api/v1/workspaces/${workspace.id}/boards`, { name: "Native" })).body.board;
    assert.equal((await admin.request("POST", `/api/v1/boards/${native.id}/records`, { values: { serial: "ok" } })).status, 201);
  });
  test("sync is off by default: Sync now refuses nothing but runs nothing until enabled; enabling needs the signing secret", async () => {
    const before = mock.queries.length;
    await tick();
    assert.equal(mock.queries.length, before, "no background sync while sync is off");
    assert.equal((await admin.request("POST", "/api/v1/integrations/monday/sync", { syncEnabled: "yes" })).status, 400);
    const r = await admin.request("POST", "/api/v1/integrations/monday/sync", { syncEnabled: true });
    assert.deepEqual(r.body, { syncEnabled: true, paused: false });
  });
  test("webhooks: secret URL, challenge echo, JWT required, validation, duplicates ignored", async () => {
    const secret = (await integrationDoc()).webhookSecret, url = `/api/v1/integrations/monday/webhook/${secret}`;
    const post = (body, auth) => fetch(app.url + url, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal((await api(app.url, "POST", "/api/v1/integrations/monday/webhook/wrong-token", { challenge: "c" })).status, 404);
    assert.deepEqual((await post({ challenge: "abc123" })).body, { challenge: "abc123" });
    const event = (extra = {}) => ({ event: { type: "update_column_value", boardId: 111, pulseId: 9001, triggerUuid: "uuid-1", triggerTime: "2026-10-12T10:00:00Z", ...extra } });
    assert.equal((await post(event())).status, 401, "unsigned events are refused");
    assert.equal((await post(event(), signJwt({ exp: Math.floor(Date.now() / 1000) + 60 }, "forged"))).status, 401);
    const jwt = signJwt({ exp: Math.floor(Date.now() / 1000) + 60 }, SIGNING);
    assert.equal((await post({ event: { type: "x", boardId: "bad", pulseId: 1 } }, jwt)).status, 400);
    assert.deepEqual((await post(event({ boardId: 222 }), jwt)).body, { ignored: true }, "boards that weren't imported are ignored");
    mock.items[0] = { ...mock.items[0], name: "Item 1 renamed", updated_at: "2026-10-12T10:00:00Z" };
    assert.deepEqual((await post(event(), jwt)).body, { queued: true });
    assert.deepEqual((await post(event(), jwt)).body, { duplicate: true });
    await tick();
    const board = (await admin.request("GET", "/api/v1/integrations/monday")).body.importedBoards[0];
    assert.ok(records(board.boardId).some((r) => r.values.serial === "Item 1 renamed"));
    const acts = app.db.collection("activities").docs.filter((a) => a.action === "integration.synced");
    assert.ok(acts.length >= 1, "connected browsers are told (live updates)");
  });
  test("out-of-order events: an older item state never overwrites a newer one", async () => {
    const board = (await admin.request("GET", "/api/v1/integrations/monday")).body.importedBoards[0];
    const map = await app.db.collection("integrationMappings").findOne({ kind: "item", sourceId: "9002" });
    await app.db.collection("integrationMappings").updateOne({ _id: map._id }, { $set: { sourceUpdatedAt: new Date("2026-10-13T00:00:00Z") } });
    mock.items[1] = { ...mock.items[1], name: "Stale name", updated_at: "2026-10-12T00:00:00Z" };
    const jwt = signJwt({ exp: Math.floor(Date.now() / 1000) + 60 }, SIGNING), secret = (await integrationDoc()).webhookSecret;
    await api(app.url, "POST", `/api/v1/integrations/monday/webhook/${secret}`, undefined).catch(() => {});
    await fetch(`${app.url}/api/v1/integrations/monday/webhook/${secret}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: jwt }, body: JSON.stringify({ event: { type: "update_name", boardId: "111", pulseId: "9002", triggerUuid: "uuid-old" } }) });
    await tick();
    assert.equal(records(board.boardId).find((r) => r._id.equals(map.targetId)).values.serial, "Item 2");
  });
  test("sync retry: a failed item sync retries with backoff, then succeeds; failures stop as failed and can be retried", async () => {
    const jwt = signJwt({ exp: Math.floor(Date.now() / 1000) + 60 }, SIGNING), secret = (await integrationDoc()).webhookSecret;
    const send = (uuid, pulseId) => fetch(`${app.url}/api/v1/integrations/monday/webhook/${secret}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: jwt }, body: JSON.stringify({ event: { type: "update_name", boardId: "111", pulseId, triggerUuid: uuid } }) });
    mock.items[2] = { ...mock.items[2], name: "Item 3 v2", updated_at: "2026-10-13T01:00:00Z" };
    await send("uuid-retry", "9003");
    mock.fail.push(500, 500, 500, 500, 500);
    await tick();
    let job = await app.db.collection("integrationJobs").findOne({ "params.eventId": "uuid-retry" });
    assert.equal(job.status, "retry"); assert.ok(job.runAfter > new Date());
    await later.tick();
    job = await app.db.collection("integrationJobs").findOne({ _id: job._id });
    assert.equal(job.status, "done");
    await send("uuid-auth", "9004");
    mock.fail.push(401);
    await tick();
    job = await app.db.collection("integrationJobs").findOne({ "params.eventId": "uuid-auth" });
    assert.equal(job.status, "failed", "a refused token is not retried automatically");
    assert.equal((await admin.request("GET", "/api/v1/integrations/monday")).body.state, "needs_reconnect");
    assert.ok((await admin.request("GET", "/api/v1/integrations/monday")).body.failed.some((f) => f.id === job._id.toHexString()));
    assert.equal((await admin.request("POST", `/api/v1/integrations/monday/jobs/${job._id.toHexString()}/retry`)).status, 200);
    await tick();
    assert.equal((await app.db.collection("integrationJobs").findOne({ _id: job._id })).status, "done");
  });
  test("pause/resume and Sync now (reconciliation archives items gone from monday.com)", async () => {
    await admin.request("POST", "/api/v1/integrations/monday/sync", { paused: true });
    assert.equal((await admin.request("POST", "/api/v1/integrations/monday/sync-now")).body.error.code, "SYNC_PAUSED");
    const secret = (await integrationDoc()).webhookSecret, jwt = signJwt({ exp: Math.floor(Date.now() / 1000) + 60 }, SIGNING);
    const paused = await fetch(`${app.url}/api/v1/integrations/monday/webhook/${secret}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: jwt }, body: JSON.stringify({ event: { type: "update_name", boardId: "111", pulseId: "9005", triggerUuid: "uuid-paused" } }) }).then((r) => r.json());
    assert.deepEqual(paused, { ignored: true }, "events are not queued while paused");
    assert.equal(await app.db.collection("integrationEvents").countDocuments({ eventId: "uuid-paused" }), 0);
    await app.db.collection("integrations").updateOne({ _id: "monday" }, { $unset: { nextReconcileAt: "" } });
    const before = mock.queries.length;
    await tick();
    assert.equal(mock.queries.length, before, "nothing runs while paused");
    await admin.request("POST", "/api/v1/integrations/monday/sync", { paused: false });
    const removed = mock.items.pop();
    mock.items.push(item(500));
    assert.equal((await admin.request("POST", "/api/v1/integrations/monday/sync-now")).status, 202);
    await tick();
    const board = (await admin.request("GET", "/api/v1/integrations/monday")).body.importedBoards[0];
    const rows = records(board.boardId);
    assert.equal(rows.find((r) => r.values.serial === removed.name).archived, true);
    assert.ok(rows.some((r) => r.values.serial === "Item 500" && !r.archived));
    assert.ok((await admin.request("GET", "/api/v1/integrations/monday")).body.sync.lastSyncAt);
  });
  test("two workers never run the same job; JARC never sent a mutation or called anything but monday.com", async () => {
    await admin.request("POST", "/api/v1/integrations/monday/sync-now");
    const other = new IntegrationWorker({ integration: app.dataLayer.services.integration, repos: app.dataLayer.repos, logger: { error() {} } });
    const before = mock.queries.length;
    await Promise.all([worker.tick({ max: 1 }), other.tick({ max: 1 })]);
    const pages = mock.queries.slice(before).filter((q) => /items_page/.test(q.query) && !/next_items_page/.test(q.query)).length;
    assert.equal(pages, 1, "the one reconcile job ran once");
    assert.equal(mock.queries.some((q) => /^\s*mutation/i.test(q.query)), false);
    assert.deepEqual(mock.outside, []);
  });
  test("deleting an imported board forgets its mappings; disconnecting removes the token and cancels queued jobs", async () => {
    const board = (await admin.request("GET", "/api/v1/integrations/monday")).body.importedBoards[0];
    const b = (await admin.request("GET", `/api/v1/boards/${board.boardId}`)).body.board;
    assert.equal((await admin.request("DELETE", `/api/v1/boards/${b.id}?expectedVersion=${b.version}`)).status, 200);
    assert.equal(await app.db.collection("integrationMappings").countDocuments({}), 0);
    await app.db.collection("integrationJobs").insertOne({ provider: "monday", type: "reconcile", status: "queued", runAfter: new Date(), params: {} });
    assert.deepEqual((await admin.request("POST", "/api/v1/integrations/monday/disconnect")).body, { connected: false });
    const doc = await integrationDoc();
    assert.equal(doc.token, undefined); assert.equal(doc.webhookSecret, undefined); assert.equal(doc.syncEnabled, false);
    assert.equal(await app.db.collection("integrationJobs").countDocuments({ status: "queued" }), 0);
    assert.equal((await admin.request("GET", "/api/v1/integrations/monday")).body.state, "not_connected");
  });
});

// Pre-deployment review additions.
describe("monday.com integration: review checks", () => {
  test("webhook JWTs: the HMAC family with the Signing Secret is accepted; public-key algorithms are refused", () => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const make = (alg, hash, secret = SIGNING) => { const h = enc({ alg, typ: "JWT" }), p = enc({ exp: Math.floor(Date.now() / 1000) + 60 }); return `${h}.${p}.${crypto.createHmac(hash, secret).update(`${h}.${p}`).digest("base64url")}`; };
    assert.ok(verifyJwt(make("HS384", "sha384"), SIGNING)); assert.ok(verifyJwt(make("HS512", "sha512"), SIGNING));
    assert.equal(verifyJwt(make("HS512", "sha512", "other"), SIGNING), null);
    assert.equal(verifyJwt(make("RS256", "sha256"), SIGNING), null, "an RS256 header is never checked as HMAC");
  });
  test("OAuth uses only monday.com's documented endpoints (no PKCE / custom token URL options)", () => {
    const c = loadMondayConfig({ ...ENV, MONDAY_OAUTH_TOKEN_URL: "https://evil.example/token", MONDAY_OAUTH_PKCE: "true" });
    assert.deepEqual({ ...c.oauth }, { authorizeUrl: "https://auth.monday.com/oauth2/authorize", tokenUrl: "https://auth.monday.com/oauth2/token" });
  });
  test("duplicating an imported board in the browser makes an ordinary, editable copy", async () => {
    const { loadBrowser } = require("./support/browser-model");
    const b = loadBrowser();
    const model = new b.window.BoardModel(new b.window.StorageService(new b.window.LocalAsyncAdapter()));
    await model.init();
    const board = model.workspace.boards[0];
    board.source = { provider: "monday", sourceBoardId: "111", readOnly: true };
    model.duplicateBoard(board.id);
    const copy = model.workspace.boards.find((x) => x.name === `${board.name} copy`);
    assert.ok(copy); assert.equal(copy.source, undefined);
  });
});

describe("monday.com integration API: configured but switched off (MONDAY_INTEGRATION_ENABLED unset)", () => {
  let app, issuer, admin, calls = 0;
  before(async () => {
    issuer = await createTokenIssuer();
    const { MONDAY_INTEGRATION_ENABLED, ...env } = ENV;
    app = await startEntraApp({ issuer, monday: loadMondayConfig(env), fetch: async () => { calls += 1; throw new Error("no external calls allowed"); } });
    admin = new SessionClient(app.url, app.entra.appOrigin);
    await admin.signIn(issuer.person("Ada Admin", { admin: true }));
    // A connection left over from before it was switched off, with sync on and queued work.
    await app.db.collection("integrations").insertOne({ _id: "monday", token: encrypt(ACCESS_TOKEN, loadMondayConfig(env).tokenKey), status: "connected", syncEnabled: true, paused: false, webhookSecret: "left-over-secret-0123456789" });
    await app.db.collection("integrationJobs").insertOne({ provider: "monday", type: "import", status: "queued", attempts: 0, runAfter: new Date(0), params: { sourceBoardId: "111" } });
  });
  after(async () => { app.app?.locals?.realtime?.closeAll(); await app.close(); });

  test("nothing runs: no jobs, no webhooks, no discovery, no imports, no external requests", async () => {
    const worker = new IntegrationWorker({ integration: app.dataLayer.services.integration, repos: app.dataLayer.repos, logger: { error() {} } });
    assert.deepEqual(await worker.tick(), { ran: 0 });
    assert.equal((await app.db.collection("integrationJobs").findOne({ type: "import" })).status, "queued");
    assert.equal((await admin.request("GET", "/api/v1/integrations/monday")).body.state, "disabled");
    for (const [method, p, body] of [["POST", "/connect"], ["POST", "/test"], ["GET", "/workspaces"], ["GET", "/boards"], ["GET", "/boards/111/preview"], ["POST", "/imports", { boardIds: ["111"], workspaceId: "0123456789abcdef01234567", confirm: true }], ["POST", "/sync-now"], ["POST", "/sync", { paused: false }]]) {
      const r = await admin.request(method, `/api/v1/integrations/monday${p}`, body);
      assert.equal(r.status, 503, `${method} ${p}`); assert.equal(r.body.error.code, "INTEGRATION_DISABLED");
    }
    const jwt = signJwt({ exp: Math.floor(Date.now() / 1000) + 60 }, SIGNING);
    const hook = await fetch(`${app.url}/api/v1/integrations/monday/webhook/left-over-secret-0123456789`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: jwt }, body: JSON.stringify({ challenge: "x" }) });
    assert.equal(hook.status, 404);
    const cb = await fetch(`${app.url}/api/v1/integrations/monday/callback?code=c&state=${"a".repeat(43)}`, { redirect: "manual" });
    assert.match(cb.headers.get("location"), /INTEGRATION_DISABLED/);
    assert.equal(calls, 0);
  });
});
