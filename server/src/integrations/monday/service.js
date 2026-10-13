// monday.com → JARC integration (one-way). Everything is off unless configured AND enabled AND connected by a JARC
// administrator; sync additionally needs to be switched on (and not paused). JARC never writes to monday.com.
//
//   connect     OAuth (state stored server-side, single use, 10 minutes); the access token is
//               encrypted (AES-256-GCM) in the integrations collection and never sent to a browser.
//   discovery   workspaces, boards, a board's columns and a preview of mapped sample records.
//   import      an admin-confirmed job per board: creates a NEW read-only JARC board, then imports items page by
//               page; the board, its records and their source-ID mappings are written in transactions, so a resumed
//               (interrupted) import skips what is already there and never creates duplicates.
//   sync        webhook events (verified, stored once by event ID) queue item syncs; each sync re-reads the item
//               from monday.com, so out-of-order or repeated events always end at monday's current state.
//               Reconciliation (Sync now, or periodically) brings whole boards in line. Failures retry with backoff.
//   boards      imported boards carry source { provider: "monday", readOnly: true }: the API refuses edits to them.
const { ObjectId } = require("mongodb");
const { ApiError } = require("../../middleware/errors");
const { normalizeColumns, normalizeGroups } = require("../../domain/board-schema");
const { activityEntry, appendActivity } = require("../../services/shared");
const { MondayClient, MondayApiError } = require("./client");
const { mapColumns, mapItem } = require("./mapping");
const { randomToken, encrypt, decrypt, verifyJwt, sameText } = require("./secrets");

const PROVIDER = "monday";
const STATE_TTL_MS = 10 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_IMPORT_BOARDS = 20;
const SYNC_TYPES = ["sync-item", "reconcile"];

const fail = (status, code, message) => new ApiError(status, code, message);

class MondayIntegration {
  constructor({ repos, connection, config, fetch = globalThis.fetch, logger = console, now = () => new Date() }) {
    Object.assign(this, { repos, connection, config: config || { enabled: false, configured: false, missing: [] }, fetchImpl: fetch, logger, now });
  }

  record() { return this.repos.integrations.get(PROVIDER); }
  // Usable only when configured and enabled on this server (MONDAY_INTEGRATION_ENABLED=true).
  requireSetup() {
    if (!this.config.configured) throw fail(503, "SETUP_REQUIRED", "monday.com isn't set up on this server yet.");
    if (!this.config.enabled) throw fail(503, "INTEGRATION_DISABLED", "The monday.com integration is turned off on this server.");
  }
  async requireConnected() {
    this.requireSetup();
    const rec = await this.record();
    if (!rec?.token) throw fail(409, "NOT_CONNECTED", "monday.com isn't connected.");
    return rec;
  }
  async client() {
    const rec = await this.requireConnected();
    return new MondayClient({ token: decrypt(rec.token, this.config.tokenKey), apiVersion: this.config.apiVersion, fetch: this.fetchImpl });
  }
  async call(fn) {
    try { return await fn(await this.client()); }
    catch (error) {
      if (!(error instanceof MondayApiError)) throw error;
      if (error.code === "UNAUTHORIZED") await this.repos.integrations.set(PROVIDER, { status: "needs_reconnect", lastError: error.message, lastErrorAt: this.now() });
      throw fail(error.code === "NOT_FOUND" ? 404 : error.code === "RATE_LIMITED" ? 429 : 502, `MONDAY_${error.code}`, error.message);
    }
  }

  // Status for the Integrations page. No secrets; setup details (missing variable names) only for administrators.
  async status(actor) {
    const rec = await this.record(), admin = Boolean(actor?.isSystemAdmin);
    const boards = rec?.token ? await this.repos.integrations.listMappings({ provider: PROVIDER, kind: "board" }) : [];
    const jarcBoards = boards.length ? await Promise.all(boards.map((m) => this.repos.boards.findById(m.targetId))) : [];
    const imports = admin ? await this.repos.integrations.listJobs({ provider: PROVIDER, type: "import" }, { limit: 20 }) : [];
    const failed = admin ? await this.repos.integrations.listJobs({ provider: PROVIDER, status: "failed" }, { limit: 20 }) : [];
    return {
      provider: PROVIDER, configured: Boolean(this.config.configured), enabled: Boolean(this.config.enabled), canManage: admin,
      ...(admin && !this.config.configured ? { missing: this.config.missing } : {}),
      connected: Boolean(rec?.token), state: !this.config.configured ? "setup_required" : !this.config.enabled ? "disabled" : rec?.token ? (rec.status === "needs_reconnect" ? "needs_reconnect" : "connected") : "not_connected",
      account: rec?.token ? { name: rec.accountName || null, user: rec.accountUser || null, connectedAt: rec.connectedAt?.toISOString?.() || null } : null,
      sync: { enabled: Boolean(rec?.syncEnabled), paused: Boolean(rec?.paused), lastSyncAt: rec?.lastSyncAt?.toISOString?.() || null, lastError: admin ? rec?.lastError || null : null },
      importedBoards: boards.map((m, i) => ({ boardId: m.targetId.toHexString(), name: jarcBoards[i]?.name || null, sourceBoardId: m.sourceId, lastSyncedAt: m.lastSyncedAt?.toISOString?.() || null, missing: !jarcBoards[i] })),
      imports: imports.map(jobToApi), failed: failed.map(jobToApi)
    };
  }

  // ---- Connection
  async startConnect(actor) {
    this.requireSetup();
    const id = randomToken(32), now = this.now();
    await this.repos.integrations.saveState({ _id: id, provider: PROVIDER, userId: actor.userId, createdAt: now, expiresAt: new Date(now.getTime() + STATE_TTL_MS) });
    const url = new URL(this.config.oauth.authorizeUrl);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("state", id);
    if (this.config.scopes) url.searchParams.set("scope", this.config.scopes);
    return { authorizeUrl: url.toString() };
  }
  // The OAuth redirect (no JARC session cookie arrives on a cross-site redirect): the single-use state proves which
  // administrator started it.
  async completeConnect({ code, state }) {
    this.requireSetup();
    if (typeof state !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(state)) throw fail(400, "OAUTH_STATE_INVALID", "This sign-in link is invalid. Start again from JARC.");
    const saved = await this.repos.integrations.takeState(state, this.now());
    if (!saved) throw fail(400, "OAUTH_STATE_INVALID", "This sign-in link has expired or was already used. Start again from JARC.");
    const user = await this.repos.users.findById(saved.userId);
    if (!user || user.status !== "active") throw fail(403, "FORBIDDEN", "The administrator who started this connection can't complete it.");
    if (typeof code !== "string" || !code || code.length > 2000) throw fail(400, "OAUTH_CODE_MISSING", "monday.com didn't send an authorization code.");
    const form = new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code, redirect_uri: this.config.redirectUri });
    let token;
    try {
      const res = await this.fetchImpl(this.config.oauth.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form.toString() });
      const body = await res.json().catch(() => null);
      token = res.ok ? body?.access_token : null;
    } catch { token = null; }
    if (!token) throw fail(502, "OAUTH_EXCHANGE_FAILED", "monday.com didn't complete the connection. Try again.");
    let me;
    try { me = await new MondayClient({ token, apiVersion: this.config.apiVersion, fetch: this.fetchImpl }).me(); }
    catch { throw fail(502, "MONDAY_TEST_FAILED", "Connected, but monday.com didn't answer a test request. Try again."); }
    await this.repos.integrations.set(PROVIDER, {
      token: encrypt(token, this.config.tokenKey), status: "connected", accountName: me?.account?.name || null, accountId: me?.account?.id || null,
      accountUser: me?.name || null, connectedBy: saved.userId, connectedAt: this.now(), syncEnabled: false, paused: false,
      webhookSecret: randomToken(32), lastError: null
    });
    return { connected: true };
  }
  async disconnect() {
    await this.repos.integrations.set(PROVIDER, { status: "disconnected", syncEnabled: false, paused: false, disconnectedAt: this.now() });
    await this.repos.integrations.unset(PROVIDER, ["token", "webhookSecret"]);
    await this.repos.integrations.cancelJobs({ provider: PROVIDER, status: { $in: ["queued", "retry"] } });
    return { connected: false };
  }
  async test() { const me = await this.call((c) => c.me()); return { ok: true, account: me?.account?.name || null, user: me?.name || null }; }

  // ---- Discovery and preview (read-only)
  workspaces() { return this.call((c) => c.workspaces()); }
  boards(workspaceId) { return this.call((c) => c.boards({ workspaceId })); }
  async preview(boardId) {
    if (!/^\d{1,20}$/.test(String(boardId))) throw fail(400, "VALIDATION_ERROR", "That isn't a monday.com board ID.");
    return this.call(async (c) => {
      const board = await c.boardSchema(boardId);
      const { columns, plan } = mapColumns(board);
      const { items } = await c.itemsPage(boardId, { limit: 5 });
      const imported = await this.repos.integrations.findMapping(PROVIDER, "board", boardId);
      return { board: { id: board.id, name: board.name, itemsCount: board.items_count ?? null, groups: (board.groups || []).map((g) => g.title) }, plan, columns: columns.map(({ key, label, type }) => ({ key, label, type })), sample: items.map((i) => mapItem(i, plan, columns)), alreadyImported: Boolean(imported) };
    });
  }

  // ---- Import (admin-confirmed; runs as durable jobs)
  async startImport(actor, { boardIds, workspaceId, confirm }) {
    await this.requireConnected();
    if (confirm !== true) throw fail(400, "CONFIRMATION_REQUIRED", "Confirm the import first.");
    if (!Array.isArray(boardIds) || !boardIds.length || boardIds.length > MAX_IMPORT_BOARDS || !boardIds.every((id) => /^\d{1,20}$/.test(String(id)))) throw fail(400, "VALIDATION_ERROR", `Choose 1 to ${MAX_IMPORT_BOARDS} monday.com boards.`);
    const workspace = await this.repos.workspaces.findById(workspaceId);
    if (!workspace || workspace.archived) throw fail(404, "NOT_FOUND", "That JARC workspace doesn't exist.");
    const jobs = [];
    for (const sourceBoardId of [...new Set(boardIds.map(String))]) {
      if (await this.repos.integrations.findMapping(PROVIDER, "board", sourceBoardId)) throw fail(409, "ALREADY_IMPORTED", `monday.com board ${sourceBoardId} has already been imported.`);
      if (await this.repos.integrations.countJobs({ provider: PROVIDER, type: "import", "params.sourceBoardId": sourceBoardId, status: { $in: ["queued", "running", "retry"] } })) throw fail(409, "IMPORT_IN_PROGRESS", `monday.com board ${sourceBoardId} is already being imported.`);
      const job = { _id: new ObjectId(), provider: PROVIDER, type: "import", status: "queued", attempts: 0, runAfter: this.now(), createdAt: this.now(), params: { sourceBoardId, workspaceId, actorId: actor.userId, actorName: actor.displayName || null }, progress: { phase: "queued", imported: 0, cursor: null } };
      await this.repos.integrations.enqueue(job);
      jobs.push(jobToApi(job));
    }
    return { jobs };
  }

  async runImport(job, client, { workerId }) {
    const { sourceBoardId, workspaceId, actorId, actorName } = job.params;
    const schema = await client.boardSchema(sourceBoardId);
    const { columns, plan } = mapColumns(schema);
    let boardMap = await this.repos.integrations.findMapping(PROVIDER, "board", sourceBoardId);
    if (!boardMap) {
      // The board and its mapping are created together, so a retried import finds (and resumes) the same board.
      const now = this.now(), groups = normalizeGroups((schema.groups || []).map((g) => ({ name: String(g.title || "Group").slice(0, 200) })));
      const board = { _id: new ObjectId(), workspaceId, name: String(schema.name || "monday.com board").slice(0, 200), description: String(schema.description || "").slice(0, 2000), icon: "", archived: false, position: await this.repos.boards.nextPosition(workspaceId), manualOrder: false, columns: normalizeColumns(columns), groups: groups.length ? groups : normalizeGroups([{ name: "Imported" }]), savedViews: [], source: { provider: PROVIDER, sourceBoardId, readOnly: true, importedAt: now }, createdBy: actorId, createdAt: now, updatedAt: now, version: 1 };
      const groupIds = Object.fromEntries((schema.groups || []).map((g, i) => [g.id, board.groups[i]?.id]).filter(([, v]) => v));
      boardMap = { _id: new ObjectId(), provider: PROVIDER, kind: "board", sourceId: sourceBoardId, targetId: board._id, workspaceId, plan, columns: board.columns.map((c) => ({ key: c.key, type: c.type, multiple: Boolean(c.multiple) })), groupIds, createdAt: now };
      await this.connection.withTransaction(async (session) => {
        await this.repos.boards.insert(board, { session });
        await this.repos.integrations.insertMappings([boardMap], { session });
        await this.repos.activities.append(activityEntry({ workspaceId, boardId: board._id, actorUserId: actorId, actorName, action: "board.created", entityType: "board", entityId: board._id, summary: `Imported ${board.name} from monday.com`, now }), { session });
      });
    }
    const target = await this.repos.boards.findById(boardMap.targetId);
    if (!target) throw new Error("The JARC board for this import was deleted.");
    let cursor = job.progress?.cursor || null, imported = job.progress?.imported || 0;
    do {
      const page = await client.itemsPage(sourceBoardId, { cursor, limit: PAGE_SIZE });
      imported += await this.upsertItems(target, boardMap, page.items, { actorId });
      cursor = page.cursor;
      await this.repos.integrations.updateJob(job._id, { progress: { phase: "importing", imported, cursor, boardId: target._id }, lockedUntil: new Date(this.now().getTime() + 120000) }, { workerId });
    } while (cursor);
    await this.repos.integrations.set(PROVIDER, { lastSyncAt: this.now() });
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId, boardId: target._id, actorUserId: actorId, actorName, action: "integration.imported", entityType: "board", entityId: target._id, summary: `Imported ${imported} records from monday.com`, now: this.now() }));
    return { boardId: target._id, imported };
  }

  // Creates or updates JARC records for monday items (system writes: synced boards are read-only to people, not to
  // the sync). Each batch commits records and mappings together. Returns how many were created.
  async upsertItems(board, boardMap, items, { actorId = null } = {}) {
    if (!items.length) return 0;
    const plan = boardMap.plan, columns = boardMap.columns, now = this.now();
    const existing = new Map((await this.repos.integrations.listMappings({ provider: PROVIDER, kind: "item", sourceId: { $in: items.map((i) => String(i.id)) } })).map((m) => [m.sourceId, m]));
    const creates = [], mappings = [], updates = [];
    let position = Date.now();
    for (const item of items) {
      const values = mapItem(item, plan, columns), groupId = boardMap.groupIds?.[item.group?.id] ?? null;
      const map = existing.get(String(item.id)), updatedAt = item.updated_at ? new Date(item.updated_at) : null;
      if (map) { if (!(map.sourceUpdatedAt && updatedAt && updatedAt < map.sourceUpdatedAt)) updates.push({ map, values, groupId, updatedAt, archived: item.state && item.state !== "active" }); continue; }
      if (item.state && item.state !== "active") continue;
      const _id = new ObjectId();
      creates.push({ _id, workspaceId: board.workspaceId, boardId: board._id, values, groupId, position: (position += 1000), archived: false, pinned: false, createdBy: actorId, updatedBy: actorId, createdAt: now, updatedAt: now, version: 1 });
      mappings.push({ _id: new ObjectId(), provider: PROVIDER, kind: "item", sourceId: String(item.id), targetId: _id, boardId: board._id, sourceBoardId: boardMap.sourceId, sourceUpdatedAt: updatedAt, lastSyncedAt: now });
    }
    if (creates.length) await this.connection.withTransaction(async (session) => { await this.repos.records.insertMany(creates, { session }); await this.repos.integrations.insertMappings(mappings, { session }); });
    for (const u of updates) {
      const set = { updatedAt: now, groupId: u.groupId, archived: Boolean(u.archived) };
      for (const [k, v] of Object.entries(u.values)) set[`values.${k}`] = v;
      await this.repos.records.collection.updateOne({ _id: u.map.targetId, boardId: board._id }, { $set: set, $inc: { version: 1 } });
      await this.repos.integrations.updateMapping(u.map._id, { sourceUpdatedAt: u.updatedAt, lastSyncedAt: now });
    }
    return creates.length;
  }

  // ---- Sync (only when switched on and not paused)
  async setSync(set) {
    const rec = await this.requireConnected();
    if (set.syncEnabled === true && !this.config.signingSecret) throw fail(409, "SIGNING_SECRET_REQUIRED", "Set MONDAY_SIGNING_SECRET before turning on sync.");
    await this.repos.integrations.set(PROVIDER, set);
    const nowOn = (set.syncEnabled ?? Boolean(rec.syncEnabled)) && !(set.paused ?? Boolean(rec.paused)), wasOn = Boolean(rec.syncEnabled) && !rec.paused;
    if (nowOn && !wasOn) await this.enqueueReconcile(); // catch up on anything missed while off or paused
    return { syncEnabled: set.syncEnabled ?? Boolean(rec.syncEnabled), paused: set.paused ?? Boolean(rec.paused) };
  }
  async syncNow() {
    const rec = await this.requireConnected();
    if (rec.paused) throw fail(409, "SYNC_PAUSED", "Sync is paused. Resume it first.");
    return { jobs: await this.enqueueReconcile() };
  }
  async enqueueReconcile() {
    const boards = await this.repos.integrations.listMappings({ provider: PROVIDER, kind: "board" }), jobs = [];
    for (const b of boards) {
      if (await this.repos.integrations.countJobs({ provider: PROVIDER, type: "reconcile", "params.sourceBoardId": b.sourceId, status: { $in: ["queued", "running", "retry"] } })) continue;
      const job = { _id: new ObjectId(), provider: PROVIDER, type: "reconcile", status: "queued", attempts: 0, runAfter: this.now(), createdAt: this.now(), params: { sourceBoardId: b.sourceId } };
      await this.repos.integrations.enqueue(job); jobs.push(jobToApi(job));
    }
    return jobs;
  }
  async runReconcile(job, client) {
    const boardMap = await this.repos.integrations.findMapping(PROVIDER, "board", job.params.sourceBoardId);
    const board = boardMap && await this.repos.boards.findById(boardMap.targetId);
    if (!board) return { skipped: true };
    const seen = new Set();
    let cursor = null, created = 0;
    do { const page = await client.itemsPage(boardMap.sourceId, { cursor, limit: PAGE_SIZE }); page.items.forEach((i) => seen.add(String(i.id))); created += await this.upsertItems(board, boardMap, page.items); cursor = page.cursor; } while (cursor);
    // Items gone from monday.com are archived in JARC (never deleted: their history and files stay).
    const gone = (await this.repos.integrations.listMappings({ provider: PROVIDER, kind: "item", boardId: board._id })).filter((m) => !seen.has(m.sourceId));
    for (const m of gone) await this.repos.records.collection.updateOne({ _id: m.targetId, boardId: board._id, archived: false }, { $set: { archived: true, updatedAt: this.now() }, $inc: { version: 1 } });
    await this.finishSync(board, `Synced from monday.com (${created} new, ${gone.length} archived)`);
    return { created, archived: gone.length };
  }
  async runSyncItem(job, client) {
    const { sourceBoardId, itemId } = job.params;
    const boardMap = await this.repos.integrations.findMapping(PROVIDER, "board", sourceBoardId);
    const board = boardMap && await this.repos.boards.findById(boardMap.targetId);
    if (!board) return { skipped: true };
    const item = await client.item(itemId);
    if (!item || String(item.board?.id || sourceBoardId) !== String(sourceBoardId) || (item.state && item.state !== "active")) {
      const map = await this.repos.integrations.findMapping(PROVIDER, "item", itemId);
      if (map) await this.repos.records.collection.updateOne({ _id: map.targetId, boardId: board._id }, { $set: { archived: true, updatedAt: this.now() }, $inc: { version: 1 } });
    } else await this.upsertItems(board, boardMap, [item]);
    await this.finishSync(board, "Updated from monday.com");
    return { itemId };
  }
  // Records the sync and tells connected browsers (live updates) that the board changed.
  async finishSync(board, summary) {
    const now = this.now();
    await this.repos.integrations.set(PROVIDER, { lastSyncAt: now, lastError: null });
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: board.workspaceId, boardId: board._id, actorUserId: null, actorName: "monday.com sync", action: "integration.synced", entityType: "board", entityId: board._id, summary, now }));
  }

  // ---- Webhooks (POST /integrations/monday/webhook/:token). Never registered by JARC itself.
  async receiveWebhook({ token, body, authorization }) {
    const rec = await this.record();
    if (!this.config.enabled || !rec?.token || !rec.webhookSecret || !sameText(token, rec.webhookSecret)) throw fail(404, "NOT_FOUND", "Not found.");
    if (body && typeof body.challenge === "string" && Object.keys(body).length === 1) return { challenge: body.challenge.slice(0, 500) };
    if (!this.config.signingSecret || !verifyJwt(authorization, this.config.signingSecret, { now: this.now().getTime() })) throw fail(401, "WEBHOOK_UNVERIFIED", "This webhook couldn't be verified.");
    const event = body?.event;
    const boardId = String(event?.boardId ?? ""), itemId = String(event?.pulseId ?? event?.itemId ?? "");
    if (!event || typeof event.type !== "string" || !/^\d{1,20}$/.test(boardId) || !/^\d{1,20}$/.test(itemId)) throw fail(400, "WEBHOOK_INVALID", "This webhook event isn't valid.");
    // Sync off or paused: acknowledged but not stored (turning sync on or resuming runs a full reconciliation instead).
    if (!rec.syncEnabled || rec.paused) return { ignored: true };
    if (!await this.repos.integrations.findMapping(PROVIDER, "board", boardId)) return { ignored: true }; // not an imported board
    const eventId = String(event.triggerUuid || `${event.type}:${boardId}:${itemId}:${event.triggerTime || ""}`).slice(0, 200);
    try { await this.repos.integrations.insertEvent({ _id: new ObjectId(), provider: PROVIDER, eventId, type: event.type.slice(0, 80), sourceBoardId: boardId, itemId, receivedAt: this.now() }); }
    catch (error) { if (error?.code === 11000) return { duplicate: true }; throw error; }
    await this.repos.integrations.enqueue({ _id: new ObjectId(), provider: PROVIDER, type: "sync-item", status: "queued", attempts: 0, runAfter: this.now(), createdAt: this.now(), params: { sourceBoardId: boardId, itemId, eventId } });
    return { queued: true };
  }

  async retryJob(id) {
    const job = await this.repos.integrations.findJob(id);
    if (!job || job.provider !== PROVIDER || job.status !== "failed") throw fail(404, "NOT_FOUND", "That failed operation doesn't exist.");
    await this.repos.integrations.updateJob(job._id, { status: "retry", runAfter: this.now(), attempts: 0, error: null });
    return { retried: true };
  }
  // A synced board deleted in JARC: forget its mappings (the monday board can be imported again later).
  async forgetBoard(boardId) {
    try {
      const map = (await this.repos.integrations.listMappings({ provider: PROVIDER, kind: "board", targetId: boardId }))[0];
      if (!map) return;
      await this.repos.integrations.deleteMappings({ provider: PROVIDER, kind: "item", boardId });
      await this.repos.integrations.deleteMappings({ provider: PROVIDER, kind: "board", targetId: boardId });
    } catch (error) { this.logger.error(`[monday] could not forget board ${boardId}: ${error?.name || "Error"}`); }
  }
}

function jobToApi(job) {
  return { id: job._id.toHexString(), type: job.type, status: job.status, attempts: job.attempts || 0, sourceBoardId: job.params?.sourceBoardId || null, progress: job.progress ? { phase: job.progress.phase, imported: job.progress.imported || 0, boardId: job.progress.boardId?.toHexString?.() || null } : null, error: job.error || null, createdAt: job.createdAt?.toISOString?.() || null, finishedAt: job.finishedAt?.toISOString?.() || null };
}

module.exports = { MondayIntegration, PROVIDER, SYNC_TYPES, jobToApi };
