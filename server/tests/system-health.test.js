// Q1.1 / Q1.4 / Q1.5: monitoring (bounded metrics, percentiles, request IDs, slow MongoDB commands, integration attempts),
// the administrator-only System Health and Activity History API, and what they must never expose. Offline: fake MongoDB,
// local Entra test keys, mock monday.com and Google responses.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { Monitor, Ring, percentile, LIMITS } = require("../src/monitoring/monitor");
const { watchCommands } = require("../src/db/connection");
const { MondayClient } = require("../src/integrations/monday/client");
const { DriveClient } = require("../src/integrations/google-drive/client");
const { activityQuery, safeValue } = require("../src/routes/system-health");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

describe("Monitor: bounded and correct", () => {
  test("percentiles use the nearest rank", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(values, 50), 50);
    assert.equal(percentile(values, 95), 95);
    assert.equal(percentile(values, 99), 99);
    assert.equal(percentile([], 95), 0);
    assert.equal(percentile([7], 99), 7);
  });
  test("a ring keeps only its newest entries, oldest first", () => {
    const r = new Ring(3);
    for (let i = 1; i <= 5; i += 1) r.push(i);
    assert.deepEqual(r.values(), [3, 4, 5]);
  });
  test("per-route stats: counts, error rate, p50/p95/p99, and the slowest endpoints first", () => {
    const m = new Monitor();
    for (let i = 1; i <= 100; i += 1) m.recordRequest({ method: "GET", route: "/fast", status: 200, ms: i / 10 });
    for (let i = 1; i <= 20; i += 1) m.recordRequest({ method: "GET", route: "/slow", status: i <= 5 ? 500 : 200, ms: 1000 + i });
    const s = m.snapshot();
    assert.equal(s.api.requests, 120);
    assert.equal(s.api.serverErrors, 5);
    assert.equal(s.slowestEndpoints[0].route, "GET /slow");
    assert.equal(s.slowestEndpoints[0].errorRate, 25);
    assert.equal(s.failingEndpoints[0].route, "GET /slow");
    const fast = s.endpoints.find((e) => e.route === "GET /fast");
    assert.equal(fast.p50Ms, 5); assert.equal(fast.p95Ms, 9.5); assert.equal(fast.count, 100);
    assert.equal(s.recentErrors.length, 5);
    assert.equal(s.trend.at(-1).requests, 120);
  });
  test("memory stays bounded however many routes, requests and errors arrive", () => {
    const m = new Monitor();
    for (let i = 0; i < LIMITS.ROUTE_LIMIT + 500; i += 1) m.recordRequest({ method: "GET", route: `/r${i}`, status: 500, ms: 1 });
    for (let i = 0; i < 5000; i += 1) m.recordRequest({ method: "GET", route: "/r0", status: 200, ms: 1 });
    assert.ok(m.routes.size <= LIMITS.ROUTE_LIMIT + 1, `routes: ${m.routes.size}`);
    assert.ok(m.routes.has("(other)"));
    assert.equal(m.routes.get("GET /r0").samples.length, LIMITS.SAMPLES_PER_ROUTE);
    assert.equal(m.all.length, LIMITS.GLOBAL_SAMPLES);
    assert.equal(m.snapshot().recentErrors.length, LIMITS.RECENT_ERRORS);
  });
  test("free text never gets in through codes or names", () => {
    const m = new Monitor({ slowCommandMs: 10 });
    m.recordRequest({ method: "GET", route: "/x", status: 500, ms: 1, code: "person@example.invalid said hi" });
    m.recordCommand({ command: "find", collection: "records { name: 'secret' }", ms: 50 });
    m.recordIntegration("monday", { outcome: "failed", code: "token abc123 invalid!", status: 500 });
    const s = m.snapshot();
    assert.equal(s.recentErrors[0].code, "OTHER");
    assert.equal(s.database.slowCommands[0].collection, null);
    assert.equal(s.integrations.monday.lastError.code, "OTHER");
  });
  test("integrations: successes, failures, retries, timeouts and rate limits are counted", () => {
    const m = new Monitor();
    m.recordIntegration("monday", { outcome: "ok", status: 200 });
    m.recordIntegration("monday", { outcome: "retry", status: 429, code: "RATE_LIMITED", retryAfterMs: 2000 });
    m.recordIntegration("monday", { outcome: "timeout", code: "TIMEOUT" });
    const p = m.snapshot().integrations.monday;
    assert.deepEqual([p.ok, p.retries, p.failed, p.timeouts, p.rateLimited], [1, 1, 1, 1, 1]);
    assert.equal(p.lastRateLimit.retryAfterMs, 2000);
    assert.ok(p.lastSuccessAt && p.lastFailureAt);
    assert.equal(p.history.length, 2);
  });
});

describe("Slow MongoDB commands", () => {
  test("only the command and collection names are kept, never the filter; fast commands are only counted", () => {
    const m = new Monitor({ slowCommandMs: 100 });
    const client = new EventEmitter();
    watchCommands(client, m);
    client.emit("commandStarted", { requestId: 1, commandName: "find", command: { find: "records", filter: { "values.name": "Private Person" } } });
    client.emit("commandSucceeded", { requestId: 1, commandName: "find", duration: 250 });
    client.emit("commandStarted", { requestId: 2, commandName: "find", command: { find: "boards" } });
    client.emit("commandSucceeded", { requestId: 2, commandName: "find", duration: 3 });
    client.emit("commandStarted", { requestId: 3, commandName: "insert", command: { insert: "records" } });
    client.emit("commandFailed", { requestId: 3, commandName: "insert", duration: 5, failure: { codeName: "DuplicateKey" } });
    const db = m.snapshot().database;
    assert.equal(db.commands, 3); assert.equal(db.slow, 1); assert.equal(db.failed, 1);
    assert.deepEqual(db.slowCommands.map((c) => [c.command, c.collection, c.ok, c.code]), [["insert", "records", false, "DuplicateKey"], ["find", "records", true, null]]);
    assert.ok(!JSON.stringify(db).includes("Private Person"));
  });
});

describe("Integration clients report each attempt (behaviour unchanged)", () => {
  const response = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
  test("monday.com: a rate-limited attempt is retried once, then succeeds; the query and token are never reported", async () => {
    const events = [], replies = [response(429, { errors: [{ message: "rate limit" }] }, { "retry-after": "1" }), response(200, { data: { me: { id: "1" } } })];
    const c = new MondayClient({ token: "secret-token-value", fetch: async () => replies.shift(), sleep: async () => {}, observe: (e) => events.push(e) });
    assert.deepEqual(await c.query("query { me { id } }"), { me: { id: "1" } });
    assert.deepEqual(events.map((e) => e.outcome), ["retry", "ok"]);
    assert.equal(events[0].code, "RATE_LIMITED"); assert.equal(events[0].retryAfterMs, 1000);
    assert.ok(!JSON.stringify(events).includes("secret-token-value") && !JSON.stringify(events).includes("me { id }"));
  });
  test("monday.com: retries are bounded, and the final failure is reported", async () => {
    const events = [];
    const c = new MondayClient({ token: "t", maxRetries: 2, fetch: async () => { throw new Error("down"); }, sleep: async () => {}, observe: (e) => events.push(e) });
    await assert.rejects(c.query("query { me { id } }"), { code: "NETWORK_ERROR" });
    assert.deepEqual(events.map((e) => e.outcome), ["retry", "retry", "failed"]);
  });
  test("monday.com: a broken observer never breaks a call", async () => {
    const c = new MondayClient({ token: "t", fetch: async () => response(200, { data: { ok: true } }), sleep: async () => {}, observe: () => { throw new Error("boom"); } });
    assert.deepEqual(await c.query("query { ok }"), { ok: true });
  });
  test("Google Drive: a 503 is retried; a 404 is an answer, not a failure", async () => {
    const events = [], replies = [response(503, {}), response(200, { ok: 1 }), response(404, { error: { errors: [{ reason: "notFound" }] } })];
    const d = new DriveClient({ getToken: async () => "drive-token", fetch: async () => replies.shift(), sleep: async () => {}, observe: (e) => events.push(e) });
    assert.deepEqual(await d.json("https://example.invalid/a"), { ok: 1 });
    await assert.rejects(d.call("https://example.invalid/b"), { code: "ENOENT" });
    assert.deepEqual(events.map((e) => [e.outcome, e.status]), [["retry", 503], ["ok", 200], ["ok", 404]]);
    assert.ok(!JSON.stringify(events).includes("drive-token") && !JSON.stringify(events).includes("example.invalid"));
  });
});

describe("Activity History query validation", () => {
  test("accepts the documented filters", () => {
    const q = activityQuery({ q: " serial ", action: "record.", actor: "Ana", boardId: "a".repeat(24), from: "2026-01-01", to: "2026-12-31", limit: "25" });
    assert.equal(q.text, "serial"); assert.equal(q.actionPrefix, "record."); assert.equal(q.limit, 25); assert.ok(q.boardId && q.from && q.to);
    assert.equal(activityQuery({ action: "record.updated" }).action, "record.updated");
  });
  test("refuses anything else with 400", () => {
    for (const bad of [{ action: "$where" }, { action: "a.b;drop" }, { boardId: "x" }, { limit: "0" }, { limit: "101" }, { from: "nope" }, { from: "2026-02-01", to: "2026-01-01" }, { before: "garbage" }, { other: "1" }, { q: "x".repeat(101) }, { q: ["a", "b"] }]) {
      assert.throws(() => activityQuery(bad), { status: 400 }, JSON.stringify(bad));
    }
  });
  test("values of secret-looking fields are redacted, and long values are cut", () => {
    assert.equal(safeValue("apiToken", "abc"), "[redacted]");
    assert.equal(safeValue("password", "abc"), "[redacted]");
    assert.equal(safeValue("values.notes", "x".repeat(500)).length, 201);
    assert.equal(safeValue("values.status", "Done"), "Done");
  });
});

describe("System Health and Activity History API (Entra sign-in)", () => {
  let app, issuer, admin, employee, adminClient, employeeClient, board;
  before(async () => {
    issuer = await createTokenIssuer();
    app = await startEntraApp({ issuer, accessPolicy: "development_shared" });
    admin = issuer.person("Health Admin", { admin: true });
    employee = issuer.person("Plain Employee");
    adminClient = new SessionClient(app.url, app.entra.appOrigin);
    employeeClient = new SessionClient(app.url, app.entra.appOrigin);
    assert.equal((await adminClient.signIn(admin)).status, 201);
    assert.equal((await employeeClient.signIn(employee)).status, 201);
    const ws = (await adminClient.request("POST", "/api/v1/workspaces", { name: "Health" })).body.workspace;
    board = (await adminClient.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Audit board", columns: [{ key: "serial", label: "Item", type: "text", required: true }, { key: "notes", label: "Notes", type: "text" }], groups: [{ id: "grp_aaaaaa", name: "One" }] })).body.board;
  });
  after(async () => { await app?.close(); });

  test("every API response carries a request ID; a safe one sent by the caller is kept, anything else is replaced", async () => {
    const own = await adminClient.request("GET", "/api/v1/me", undefined, { headers: { "X-Request-Id": "trace-12345678" } });
    assert.equal(own.headers.get("x-request-id"), "trace-12345678");
    const unsafe = await adminClient.request("GET", "/api/v1/me", undefined, { headers: { "X-Request-Id": "bad id <script>" } });
    assert.match(unsafe.headers.get("x-request-id"), /^[A-Za-z0-9_-]{8,64}$/);
    assert.notEqual(unsafe.headers.get("x-request-id"), "bad id <script>");
    const missing = await new SessionClient(app.url).request("GET", "/api/v1/nowhere");
    assert.equal(missing.status, 401); assert.ok(missing.headers.get("x-request-id"));
  });

  test("an employee without JARC.Admin gets 403 from both; signed out gets 401", async () => {
    assert.equal((await employeeClient.request("GET", "/api/v1/admin/system-health")).status, 403);
    assert.equal((await employeeClient.request("GET", "/api/v1/admin/activity")).status, 403);
    assert.equal((await new SessionClient(app.url).request("GET", "/api/v1/admin/system-health")).status, 401);
    assert.equal((await new SessionClient(app.url).request("GET", "/api/v1/admin/activity")).status, 401);
  });

  test("an administrator sees server, database, API timings by route pattern, errors and jobs", async () => {
    for (let i = 0; i < 3; i += 1) await adminClient.request("GET", `/api/v1/boards/${board.id}/records`);
    await employeeClient.request("GET", "/api/v1/admin/system-health"); // a refused request is listed as an error
    const res = await adminClient.request("GET", "/api/v1/admin/system-health");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const h = res.body;
    assert.equal(h.server.status, "ok"); assert.equal(h.database.status, "connected"); assert.equal(typeof h.database.pingMs, "number");
    assert.ok(h.api.requests >= 3 && typeof h.api.p95Ms === "number");
    const route = h.endpoints.find((e) => e.route.endsWith("/boards/:boardId/records") && e.route.startsWith("GET"));
    assert.ok(route, JSON.stringify(h.endpoints.map((e) => e.route)));
    assert.ok(route.count >= 3);
    assert.ok(h.recentErrors.some((e) => e.status === 403 && e.code === "FORBIDDEN" && e.requestId));
    assert.ok(h.jobs.integration.monday);
    assert.equal(h.jobs.midAttachments, null, "the attachment import isn't listed for someone who isn't a Drive administrator");
    // Nothing from inside the request: no board ID, no cookie, no names of people.
    const text = JSON.stringify(h);
    assert.ok(!text.includes(board.id), "no IDs from URLs");
    assert.ok(!text.includes("Plain Employee") && !text.includes("example.invalid"));
    assert.ok(!/mongodb:\/\//.test(text));
  });

  test("Activity History: record changes with the trusted actor, the request ID, board name and safe values; filters and pages", async () => {
    const created = await adminClient.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "AUD-1", notes: "first" }, groupId: "grp_aaaaaa" }, { headers: { "X-Request-Id": "audit-create-0001" } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const rec = created.body.record;
    const updated = await adminClient.request("PATCH", `/api/v1/records/${rec.id}`, { expectedVersion: rec.version, values: { notes: "second" } }, { headers: { "X-Request-Id": "audit-update-0001" } });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const all = await adminClient.request("GET", "/api/v1/admin/activity?limit=100");
    assert.equal(all.status, 200);
    const update = all.body.items.find((i) => i.action === "record.updated" && i.recordId === rec.id);
    assert.ok(update, JSON.stringify(all.body.items.map((i) => i.action)));
    assert.equal(update.actorName, "Health Admin");
    assert.equal(update.requestId, "audit-update-0001");
    assert.equal(update.boardName, "Audit board");
    assert.equal(update.result, "success");
    assert.ok(update.changes.some((c) => c.field.includes("notes") && c.from === "first" && c.to === "second"), JSON.stringify(update.changes));
    // Filters.
    const onlyUpdates = (await adminClient.request("GET", "/api/v1/admin/activity?action=record.updated")).body.items;
    assert.ok(onlyUpdates.length && onlyUpdates.every((i) => i.action === "record.updated"));
    const prefix = (await adminClient.request("GET", "/api/v1/admin/activity?action=record.")).body.items;
    assert.ok(prefix.length >= 2 && prefix.every((i) => i.action.startsWith("record.")));
    assert.ok((await adminClient.request("GET", "/api/v1/admin/activity?actor=health")).body.items.length >= 2);
    assert.equal((await adminClient.request("GET", "/api/v1/admin/activity?actor=nobody-like-this")).body.items.length, 0);
    assert.ok((await adminClient.request("GET", `/api/v1/admin/activity?boardId=${board.id}`)).body.items.every((i) => i.boardId === board.id));
    assert.equal((await adminClient.request("GET", "/api/v1/admin/activity?to=2000-01-01")).body.items.length, 0);
    // A regex-looking search is matched literally.
    assert.equal((await adminClient.request("GET", `/api/v1/admin/activity?q=${encodeURIComponent(".*")}`)).body.items.length, 0);
    // Pages: no entry twice, none missing.
    const first = (await adminClient.request("GET", "/api/v1/admin/activity?limit=2")).body;
    assert.equal(first.items.length, 2); assert.ok(first.next);
    const second = (await adminClient.request("GET", `/api/v1/admin/activity?limit=2&before=${encodeURIComponent(first.next)}`)).body;
    const ids = [...first.items, ...second.items].map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, all.body.items.slice(0, ids.length).map((i) => i.id));
    // Bad input.
    assert.equal((await adminClient.request("GET", "/api/v1/admin/activity?action=%24where")).status, 400);
  });

  test("the identity in the trail is the session's, whatever the request body claims", async () => {
    const res = await employeeClient.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "AUD-2" }, groupId: "grp_aaaaaa", actorName: "Someone Else", createdBy: "x" });
    // Unknown fields are refused outright, or ignored; either way the trail names the signed-in person.
    if (res.status === 201) {
      const items = (await adminClient.request("GET", "/api/v1/admin/activity?action=record.created")).body.items;
      assert.equal(items.find((i) => i.recordId === res.body.record.id).actorName, "Plain Employee");
    } else assert.equal(res.status, 400);
  });
});

describe("MONGO_SLOW_COMMAND_MS", () => {
  const { loadConfig } = require("../src/config");
  test("default 500, a whole number of at least 1, anything else stops startup", () => {
    assert.equal(loadConfig({}).slowCommandMs, 500);
    assert.equal(loadConfig({ MONGO_SLOW_COMMAND_MS: "250" }).slowCommandMs, 250);
    for (const bad of ["0", "-1", "abc", "1.5", "9999999"]) assert.throws(() => loadConfig({ MONGO_SLOW_COMMAND_MS: bad }), /MONGO_SLOW_COMMAND_MS/, bad);
  });
});

describe("System Health never passes on Google Drive account details", () => {
  test("a Drive administrator's full status is cut down to state fields", () => {
    const { summariseDrive } = require("../src/routes/system-health");
    const full = { provider: "google-drive", enabled: true, connected: true, state: "connected", activeForNewUploads: true, canManage: true, adminsConfigured: true, configuredAccount: "owner@example.invalid", account: { email: "owner@example.invalid", connectedAt: "2026-01-01T00:00:00.000Z", connectedByName: "Owner Person" }, folder: { name: "JARC", url: "https://drive.google.com/drive/folders/FOLDER123" }, lastCheckedAt: null, lastError: "GDRIVE_FOLDER_MISSING", lastErrorAt: "2026-01-02T00:00:00.000Z" };
    const out = summariseDrive(full);
    assert.deepEqual(out, { enabled: true, connected: true, state: "connected", activeForNewUploads: true, canManage: true, lastError: "GDRIVE_FOLDER_MISSING", lastErrorAt: "2026-01-02T00:00:00.000Z" });
    assert.ok(!/example\.invalid|FOLDER123|Owner Person/.test(JSON.stringify(out)));
  });
});
