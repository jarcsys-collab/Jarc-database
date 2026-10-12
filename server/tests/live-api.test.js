// Live updates (GET /api/v1/events, Server-Sent Events) at the API level: authentication by session cookie,
// per-workspace authorization, access changes, session expiry, replay after a reconnect, no duplicates, connection
// limits and shutdown. Offline: fake MongoDB, local test keys; the stream polls every 50 ms here.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startEntraApp, startMongoApp, SessionClient, api } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { openStream } = require("./support/sse-client");

const LIVE = { pollMs: 50, overlapMs: 2000, timings: { session: 150, access: 150, heartbeat: 1000 } };
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["New", "Done"] }];
const cookieOf = (client) => [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
const changes = (stream) => stream.messages.filter((m) => m.event === "change");

describe("Live updates: authentication and authorization", () => {
  let app, issuer, admin, ana, ben, shared, privateWs, board;
  const client = () => new SessionClient(app.url, app.entra.appOrigin);
  const listen = (c, query = "") => openStream(`${app.url}/api/v1/events${query}`, { headers: { Cookie: cookieOf(c) } });
  before(async () => {
    issuer = await createTokenIssuer();
    app = await startEntraApp({ issuer, live: LIVE }); // role_based
    admin = client(); ana = client(); ben = client();
    await admin.signIn(issuer.person("Sys Admin", { admin: true })); await ana.signIn(issuer.person("Ana Reyes")); await ben.signIn(issuer.person("Ben Cruz"));
    shared = (await admin.request("POST", "/api/v1/workspaces", { name: "Shared" })).body.workspace;
    privateWs = (await admin.request("POST", "/api/v1/workspaces", { name: "Private" })).body.workspace;
    for (const c of [ana, ben]) await admin.request("POST", `/api/v1/workspaces/${shared.id}/members`, { userId: (await c.request("GET", "/api/v1/me")).body.user.id, role: "MEMBER" });
    await admin.request("POST", `/api/v1/workspaces/${privateWs.id}/members`, { userId: (await ana.request("GET", "/api/v1/me")).body.user.id, role: "MEMBER" });
    board = (await admin.request("POST", `/api/v1/workspaces/${shared.id}/boards`, { name: "Jobs", columns: COLUMNS })).body.board;
  });
  after(async () => { app.app?.locals?.realtime?.closeAll(); await app.close(); });

  test("no session → 401 (JSON, not a stream); a session cookie authenticates; nothing goes in the URL", async () => {
    const anon = await openStream(`${app.url}/api/v1/events`);
    assert.equal(anon.res.status, 401);
    assert.match(anon.res.headers.get("content-type"), /application\/json/);
    const s = await listen(ben);
    assert.equal(s.res.status, 200);
    assert.match(s.res.headers.get("content-type"), /text\/event-stream/);
    assert.equal(s.res.headers.get("cache-control"), "no-store, no-transform");
    assert.ok(await s.waitFor((m) => m.event === "ready"));
    await s.close();
    assert.equal((await openStream(`${app.url}/api/v1/events?token=x`, { headers: { Cookie: cookieOf(ben) } })).res.status, 400, "unknown query parameters are refused");
  });

  test("a saved change reaches every connected colleague who can see it — IDs only, after the save", async () => {
    const s = await listen(ben);
    await s.waitFor((m) => m.event === "ready");
    const created = (await ana.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Live-1", status: "New" } })).body.record;
    const event = await s.waitFor((m) => m.event === "change" && m.data.recordId === created.id);
    assert.ok(event, "Ben is told about Ana's new record");
    assert.deepEqual(Object.keys(event.data).sort(), ["action", "actorId", "at", "boardId", "id", "recordId", "workspaceId"]);
    assert.equal(event.data.action, "record.created");
    assert.equal(event.id, event.data.id, "the SSE id is the activity id (used to resume)");
    assert.doesNotMatch(JSON.stringify(event.data), /Live-1|New/, "no record values in the event");
    assert.equal((await ben.request("GET", `/api/v1/records/${event.data.recordId}`)).status, 200, "already saved when announced");
    await s.close();
  });

  test("UNAUTHORIZED ISOLATION: changes in a workspace someone can't see are never sent to them", async () => {
    const bens = await listen(ben), anas = await listen(ana);
    await bens.waitFor((m) => m.event === "ready"); await anas.waitFor((m) => m.event === "ready");
    const secret = (await admin.request("POST", `/api/v1/workspaces/${privateWs.id}/boards`, { name: "Secret plans" })).body.board;
    await admin.request("POST", `/api/v1/boards/${secret.id}/records`, { values: { serial: "Hidden" } });
    await admin.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Visible" } });
    assert.ok(await anas.waitFor((m) => m.event === "change" && m.data.boardId === secret.id), "Ana is a member of Private");
    assert.ok(await bens.waitFor((m) => m.event === "change" && m.data.boardId === board.id), "Ben still gets Shared changes");
    assert.ok(!changes(bens).some((m) => m.data.workspaceId === privateWs.id), "nothing from Private reaches Ben");
    await bens.close(); await anas.close();
  });

  test("revoked access: Ben hears that he was removed, then nothing more from that workspace", async () => {
    const benId = (await ben.request("GET", "/api/v1/me")).body.user.id;
    const s = await listen(ben); await s.waitFor((m) => m.event === "ready");
    const members = (await admin.request("GET", `/api/v1/workspaces/${shared.id}/members`)).body.items;
    await admin.request("DELETE", `/api/v1/workspaces/${shared.id}/members/${members.find((m) => m.userId === benId).id}`);
    assert.ok(await s.waitFor((m) => m.event === "change" && m.data.action === "member.removed"), "the removal itself is announced (IDs only)");
    await new Promise((r) => setTimeout(r, 300));
    await admin.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "After removal" } });
    await new Promise((r) => setTimeout(r, 400));
    const after = changes(s).filter((m) => m.data.action === "record.created");
    assert.ok(!after.some((m) => m.data.workspaceId === shared.id && m.data.at > new Date(Date.now() - 600).toISOString()), "no more Shared changes");
    await admin.request("POST", `/api/v1/workspaces/${shared.id}/members`, { userId: benId, role: "MEMBER" });
    await s.close();
  });

  test("session expiry, sign-out and a disabled account end the stream with session-ended", async () => {
    for (const end of ["sign-out", "expire", "disable"]) {
      const c = client(); const person = issuer.person(`Leaver ${end}`);
      await c.signIn(person);
      const s = await listen(c); await s.waitFor((m) => m.event === "ready");
      if (end === "sign-out") await c.request("POST", "/api/v1/auth/sign-out");
      if (end === "expire") { const user = await app.db.collection("users").findOne({ entraObjectId: person.oid }); await app.db.collection("sessions").updateOne({ userId: user._id }, { $set: { idleExpiresAt: new Date(0) } }); }
      if (end === "disable") await app.db.collection("users").updateOne({ entraObjectId: person.oid }, { $set: { status: "disabled" } });
      assert.ok(await s.waitFor((m) => m.event === "session-ended", 3000), end);
      await s.done;
      assert.equal(s.ended, true, `${end}: the server closed the stream`);
    }
  });

  test("RESUME: reconnecting with the last event ID replays what was missed; unknown or invalid IDs → resync or 400", async () => {
    const s = await listen(ana); await s.waitFor((m) => m.event === "ready");
    const first = (await admin.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Before gap" } })).body.record;
    const seen = await s.waitFor((m) => m.event === "change" && m.data.recordId === first.id);
    await s.close();
    const missed = [];
    for (const n of [1, 2, 3]) missed.push((await admin.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: `Missed ${n}` } })).body.record.id);
    const again = await listen(ana, `?lastEventId=${seen.id}`);
    await again.waitFor((m) => m.event === "ready");
    for (const id of missed) assert.ok(changes(again).some((m) => m.data.recordId === id), `replayed ${id}`);
    assert.ok(!changes(again).some((m) => m.data.recordId === first.id && m.data.action === "record.created" && m.id === seen.id), "not the one already seen");
    await again.close();
    const headerResume = await openStream(`${app.url}/api/v1/events`, { headers: { Cookie: cookieOf(ana), "Last-Event-ID": seen.id } });
    await headerResume.waitFor((m) => m.event === "ready");
    assert.ok(missed.every((id) => changes(headerResume).some((m) => m.data.recordId === id)), "the standard Last-Event-ID header works too");
    await headerResume.close();
    const unknown = await listen(ana, "?lastEventId=0123456789abcdef01234567");
    assert.ok(await unknown.waitFor((m) => m.event === "resync"), "unknown ID → resync");
    await unknown.close();
    assert.equal((await openStream(`${app.url}/api/v1/events?lastEventId=nope`, { headers: { Cookie: cookieOf(ana) } })).res.status, 400);
  });

  test("NO DUPLICATES: each change is delivered once, even across overlapping reads", async () => {
    const s = await listen(ana); await s.waitFor((m) => m.event === "ready");
    for (let i = 0; i < 5; i += 1) await admin.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: `Dup ${i}` } });
    await new Promise((r) => setTimeout(r, 600)); // many polls over the same overlap window
    const ids = changes(s).map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.length >= 5);
    await s.close();
  });

  test("MULTIPLE TABS: every open tab gets the change; more than 10 streams per person → 429", async () => {
    const tabs = [];
    for (let i = 0; i < 10; i += 1) tabs.push(await listen(ben));
    await Promise.all(tabs.map((t) => t.waitFor((m) => m.event === "ready")));
    assert.equal((await listen(ben)).res.status, 429);
    const rec = (await admin.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "All tabs" } })).body.record;
    for (const t of tabs) assert.ok(await t.waitFor((m) => m.event === "change" && m.data.recordId === rec.id));
    await Promise.all(tabs.map((t) => t.close()));
    await new Promise((r) => setTimeout(r, 100));
    const reopened = await listen(ben);
    assert.equal(reopened.res.status, 200, "closed tabs free their slots");
    await reopened.close();
  });

  test("IDLE TIMEOUT: the stream and background refreshes don't count as activity; real requests still do", async () => {
    const c = client(); const person = issuer.person("Idle Watcher");
    await c.signIn(person);
    const user = await app.db.collection("users").findOne({ entraObjectId: person.oid });
    const idleOf = async () => (await app.db.collection("sessions").findOne({ userId: user._id })).idleExpiresAt.getTime();
    const age = async () => app.db.collection("sessions").updateOne({ userId: user._id }, { $set: { lastSeenAt: new Date(Date.now() - 5 * 60 * 1000), idleExpiresAt: new Date(Date.now() + 60 * 1000) } });
    await age(); const before = await idleOf();
    const s = await listen(c); await s.waitFor((m) => m.event === "ready"); await s.close();
    await c.request("GET", "/api/v1/activity?limit=5", undefined, { headers: { "X-JARC-Background": "1" } });
    await c.request("GET", `/api/v1/workspaces/${shared.id}/people`, undefined, { headers: { "X-JARC-Background": "1" } });
    assert.equal(await idleOf(), before, "connecting the stream and background requests left the idle timeout alone");
    await c.request("GET", "/api/v1/workspaces");
    assert.ok(await idleOf() > before + 25 * 60 * 1000, "a request made by the person extends it");
  });

  test("CLEANUP: a browser that leaves straight away leaves no timers or connection slots behind", async () => {
    const stream = app.app.locals.realtime;
    const timersBefore = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    for (let i = 0; i < 12; i += 1) { const s = await listen(ben); await s.close(); } // more than the per-person limit
    await new Promise((r) => setTimeout(r, 300));
    const ok = await listen(ben);
    assert.equal(ok.res.status, 200, "every slot was freed");
    await ok.waitFor((m) => m.event === "ready"); await ok.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(stream.subscribers.size, 0, "no subscriber left");
    const timersAfter = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    assert.ok(timersAfter <= timersBefore + 1, `no leaked intervals (${timersBefore} → ${timersAfter})`);
  });

  test("shutdown closes every stream (so a redeploy isn't held up)", async () => {
    const s = await listen(ana); await s.waitFor((m) => m.event === "ready");
    assert.ok(app.app.locals.realtime, "the stream is reachable for shutdown");
    app.app.locals.realtime.closeAll();
    await s.done;
    assert.equal(s.ended, true);
  });
});

describe("Live updates: shared access and development mode", () => {
  test("development_shared: every employee hears every workspace", async () => {
    const issuer = await createTokenIssuer();
    const app = await startEntraApp({ issuer, accessPolicy: "development_shared", live: LIVE });
    const ana = new SessionClient(app.url, app.entra.appOrigin), ben = new SessionClient(app.url, app.entra.appOrigin);
    await ana.signIn(issuer.person("Ana")); await ben.signIn(issuer.person("Ben"));
    const s = await openStream(`${app.url}/api/v1/events`, { headers: { Cookie: cookieOf(ben) } });
    await s.waitFor((m) => m.event === "ready");
    const ws = (await ana.request("POST", "/api/v1/workspaces", { name: "Anyone" })).body.workspace;
    assert.ok(await s.waitFor((m) => m.event === "change" && m.data.action === "workspace.created" && m.data.workspaceId === ws.id));
    await s.close(); app.app.locals.realtime.closeAll(); await app.close();
  });

  test("development mode (no Microsoft sign-in) streams too", async () => {
    const app = await startMongoApp({ app: { live: LIVE } });
    const s = await openStream(`${app.url}/api/v1/events`);
    assert.ok(await s.waitFor((m) => m.event === "ready"));
    const ws = (await api(app.url, "POST", "/api/v1/workspaces", { name: "Dev" })).body.workspace;
    assert.ok(await s.waitFor((m) => m.event === "change" && m.data.workspaceId === ws.id));
    await s.close(); app.app.locals.realtime.closeAll(); await app.close();
  });
});
