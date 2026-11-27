// System Health, Integration Reliability and Activity History (Q1.1, Q1.4, Q1.5). JARC administrators (the JARC.Admin app
// role, checked on the server for every request) see everything. The people in SYSTEM_HEALTH_VIEWER_OIDS (this tenant, a JARC
// session) may also read GET /admin/system-health, as a redacted view (viewerView, scope "viewer"); never Activity History.
// Anyone else signed in gets 403; a caller without a session never reaches these routes. GET only.
//
//   GET /admin/system-health   process, database, API timings, slow endpoints, recent errors, slow MongoDB commands,
//                              integration health (monday.com, Google Drive), background jobs
//   GET /admin/activity        the audit trail, newest first: ?q= &action= &actor= &boardId= &from= &to= &before= &limit=
//
// Nothing here carries a token, a connection string, a query text, a filter, a record's field values outside the
// audit trail's own change list, or another person's Entra identifiers. The Machine Installation Database import is listed
// only for Google Drive administrators (GOOGLE_DRIVE_ADMIN_OIDS), exactly as on the Integrations page.
const express = require("express");
const { ObjectId } = require("mongodb");
const { allowOnly, queryString, fail, OBJECT_ID } = require("../validation/common");
const { monitor: defaultMonitor } = require("../monitoring/monitor");
const { redact } = require("../db/connection");
const { hex, iso } = require("../api/serialize");
// Pure view builders only (no driver, no connection): safe to load whether Fabric Data is on or off.
const { detailedView, generalView } = require("../fabric/health");

const ACTION = /^[a-z][a-z_]*(\.[a-z_]+)*\.?$/; // "record.updated", or a prefix ending in "." ("record.")
const SENSITIVE_FIELD = /pass(word)?|secret|token|api[-_]?key|credential|authori[sz]ation|cookie|session/i;
const VALUE_LIMIT = 200;
const IMPORT_ACTIVE = ["queued", "running", "mapping", "ready", "paused", "removing"];

// A changed value as the audit list shows it: short, and never a value of a field whose name says it is a secret.
function safeValue(field, value) {
  if (value === null || value === undefined) return null;
  if (SENSITIVE_FIELD.test(String(field || ""))) return "[redacted]";
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT)}…` : text;
}

function activityToAdmin(doc, boards) {
  const boardId = hex(doc.boardId);
  return {
    id: hex(doc._id), at: iso(doc.createdAt), action: doc.action, result: "success", entityType: doc.entityType || null, entityId: doc.entityId instanceof ObjectId ? doc.entityId.toHexString() : doc.entityId ?? null,
    boardId, boardName: boardId ? boards.get(boardId) ?? null : null, recordId: hex(doc.recordId), workspaceId: hex(doc.workspaceId),
    actorUserId: hex(doc.actorUserId), actorName: doc.actorName ?? doc.legacyActor ?? null, summary: String(doc.summary || "").slice(0, 300),
    changes: (doc.changes || []).slice(0, 50).map((c) => ({ field: String(c.field || "").slice(0, 120), from: safeValue(c.field, c.from), to: safeValue(c.field, c.to) })),
    requestId: typeof doc.requestId === "string" ? doc.requestId : null
  };
}

const dateParam = (value, label) => {
  const raw = queryString(value, label);
  if (raw === undefined || raw === "") return null;
  const d = new Date(raw);
  if (raw.length > 40 || Number.isNaN(d.getTime())) fail(`${label} must be a date.`);
  return d;
};
const textParam = (value, label, max = 100) => {
  const raw = queryString(value, label);
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t.length > max) fail(`${label} can be at most ${max} characters.`);
  return t || null;
};

function activityQuery(query) {
  allowOnly(query, ["q", "action", "actor", "boardId", "from", "to", "before", "limit"], "the query");
  const action = textParam(query.action, "action", 60);
  if (action && !ACTION.test(action)) fail("action must be an activity type such as record.updated, or a prefix such as record.");
  const boardText = textParam(query.boardId, "boardId", 24);
  if (boardText && !OBJECT_ID.test(boardText)) fail("boardId must be a board ID.");
  const limitText = textParam(query.limit, "limit", 3);
  const limit = limitText === null ? 50 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("limit must be a whole number from 1 to 100.");
  const beforeText = textParam(query.before, "before", 80);
  let before = null;
  if (beforeText) {
    const [at, id] = beforeText.split("_");
    const d = new Date(at);
    if (Number.isNaN(d.getTime()) || !OBJECT_ID.test(id || "")) fail("before must be the cursor returned with the previous page.");
    before = { at: d, id: new ObjectId(id) };
  }
  const from = dateParam(query.from, "from"), to = dateParam(query.to, "to");
  if (from && to && from > to) fail("from must be before to.");
  return { text: textParam(query.q, "q"), actor: textParam(query.actor, "actor"), boardId: boardText ? new ObjectId(boardText) : null, from, to, before, limit, ...(action?.endsWith(".") ? { actionPrefix: action } : { action }) };
}

// Each part is read on its own: one that fails is reported as unavailable and never hides the rest of the page.
async function part(fn) {
  try { return await fn(); }
  catch (error) { return { unavailable: true, error: error?.code && /^[A-Z0-9_]{2,64}$/.test(error.code) ? error.code : "UNAVAILABLE" }; }
}

// ---- System Health viewers (SYSTEM_HEALTH_VIEWER_OIDS): a session actor of kind "entra" in this tenant whose object ID is listed.
const lower = (v) => (typeof v === "string" ? v.toLowerCase() : null);
function isSystemHealthViewer(actor, viewerObjectIds, tenantId) {
  if (actor?.kind !== "entra" || !tenantId || !Array.isArray(viewerObjectIds) || !viewerObjectIds.length) return false;
  const tid = lower(actor.tenantId), oid = lower(actor.entraObjectId);
  return Boolean(tid && oid && tid === lower(tenantId) && viewerObjectIds.includes(oid));
}

// The viewer's REDACTED view, built field by field from the administrator's (an allow-list: nothing is copied by spreading).
// Kept: overall health, server version and uptime, memory, database availability, latency and command counts, API request
// counts, error rates and timings (overall, per route pattern and per minute), errors as counts by status and code, integration
// and job state with counts and times. Left out: the environment name, the Node.js version, request IDs, the database's slow
// command list (collection names), the monday.com account name, failed job details and error text, the Google Drive error
// text and management flag, the Machine Installation Database runs, import job IDs, and anything else not named here.
// Text fields come from fixed vocabularies (anything else is "unknown"); the version must look like semver; an endpoint whose
// route isn't a plain route pattern is dropped. So no free text reaches a viewer even if a source changes later.
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const oneOf = (v, allowed) => (typeof v === "string" && allowed.includes(v) ? v : "unknown");
const SERVER_STATES = ["ok", "degraded"], DATABASE_STATES = ["connected", "unavailable"], SEARCH_MODES = ["off", "shadow", "on"];
const MONDAY_STATES = ["setup_required", "disabled", "needs_reconnect", "connected", "not_connected"];
const DRIVE_STATES = ["disabled", "not_connected", "needs_reconnect", "unavailable", "connected"], DRIVE_ERROR_STATES = ["needs_reconnect", "unavailable"];
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
const ROUTE = /^[A-Z]+ [/:A-Za-z0-9_.()*-]+$/;
const routeOk = (e) => typeof e?.route === "string" && e.route.length <= 160 && ROUTE.test(e.route);
const endpoints = (list) => (list || []).filter(routeOk).map(endpointView);
const stateOf = (p, allowed) => (p.unavailable || p.state === undefined ? null : oneOf(p.state, allowed));
const isoText = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
const CODE = /^[A-Z0-9_]{2,64}$/;
const timing = (s) => ({ samples: num(s?.samples), avgMs: num(s?.avgMs), p50Ms: num(s?.p50Ms), p95Ms: num(s?.p95Ms), p99Ms: num(s?.p99Ms), maxMs: num(s?.maxMs) });
const endpointView = (e) => ({ route: e.route, count: num(e?.count), serverErrors: num(e?.serverErrors), clientErrors: num(e?.clientErrors), errorRate: num(e?.errorRate), ...timing(e), lastAt: isoText(e?.lastAt) });
const countBy = (items, key) => { const out = {}; for (const i of items || []) { const k = key(i); if (k !== null) out[k] = (out[k] || 0) + 1; } return out; };
const partView = (p, fn) => (p === null || p === undefined ? null : p.unavailable ? { unavailable: true } : fn(p));
const activityView = (a) => (a ? { ok: num(a.ok), failed: num(a.failed), retries: num(a.retries), timeouts: num(a.timeouts), rateLimited: num(a.rateLimited), lastSuccessAt: isoText(a.lastSuccessAt), lastFailureAt: isoText(a.lastFailureAt), lastErrorCode: a.lastError && CODE.test(a.lastError.code || "") ? a.lastError.code : null, lastErrorStatus: num(a.lastError?.status) } : null);
function viewerView(full) {
  const { server: s, database: d, api: a } = full;
  const monday = full.integrations.monday, drive = full.integrations.googleDrive;
  return {
    scope: "viewer", generatedAt: isoText(full.generatedAt),
    server: { status: oneOf(s.status, SERVER_STATES), version: typeof s.version === "string" && VERSION.test(s.version) ? s.version : "unknown", uptimeSeconds: num(s.uptimeSeconds), memoryMb: { rss: num(s.memoryMb?.rss), heapUsed: num(s.memoryMb?.heapUsed) }, monitoringSince: isoText(s.monitoringSince) },
    database: { status: oneOf(d.status, DATABASE_STATES), pingMs: num(d.pingMs), commands: num(d.commands), failed: num(d.failed), slow: num(d.slow), slowThresholdMs: num(d.slowThresholdMs) },
    api: { requests: num(a.requests), serverErrors: num(a.serverErrors), clientErrors: num(a.clientErrors), errorRate: num(a.errorRate), statuses: Object.fromEntries(Object.entries(a.statuses || {}).filter(([k, v]) => /^\d{3}$/.test(k) && num(v) !== null)), ...timing(a) },
    slowestEndpoints: endpoints(full.slowestEndpoints),
    failingEndpoints: endpoints(full.failingEndpoints),
    endpoints: endpoints(full.endpoints),
    trend: (full.trend || []).map((t) => ({ at: isoText(t.at), requests: num(t.requests), errors: num(t.errors), avgMs: num(t.avgMs) })),
    errors: { recent: (full.recentErrors || []).length, byStatus: countBy(full.recentErrors, (e) => (Number.isInteger(e.status) ? String(e.status) : null)), byCode: countBy(full.recentErrors, (e) => (CODE.test(e.code || "") ? e.code : null)) },
    integrations: {
      monday: { enabled: bool(monday.enabled) ?? false, ...(monday.unavailable ? { unavailable: true } : {}), configured: bool(monday.configured), connected: bool(monday.connected), state: stateOf(monday, MONDAY_STATES), syncEnabled: bool(monday.sync?.enabled), syncPaused: bool(monday.sync?.paused), lastSyncAt: isoText(monday.sync?.lastSyncAt), importedBoards: num(monday.importedBoards), failedJobs: Array.isArray(monday.failedJobs) ? monday.failedJobs.length : null, activity: activityView(monday.activity) },
      googleDrive: { enabled: bool(drive.enabled) ?? false, ...(drive.unavailable ? { unavailable: true } : {}), connected: bool(drive.connected), state: stateOf(drive, DRIVE_STATES), activeForNewUploads: bool(drive.activeForNewUploads), hasError: Boolean(drive.unavailable) || DRIVE_ERROR_STATES.includes(drive.state), lastErrorAt: isoText(drive.lastErrorAt), activity: activityView(drive.activity) }
    },
    jobs: {
      integration: partView(full.jobs.integration, (j) => ({ monday: { queued: num(j.monday?.queued), running: num(j.monday?.running), retry: num(j.monday?.retry), failed: num(j.monday?.failed) } })),
      imports: partView(full.jobs.imports, (j) => ({ active: num(j.active), failed: num(j.failed) })),
      searchIndex: full.jobs.searchIndex ? { mode: oneOf(full.jobs.searchIndex.mode, SEARCH_MODES), ready: Boolean(full.jobs.searchIndex.ready) } : null,
      recentFailures: { count: (full.jobs.recentFailures || []).length, byKind: countBy(full.jobs.recentFailures, (f) => (/^[a-z0-9._-]{1,60}$/i.test(f.kind || "") ? f.kind : null)) }
    },
    // Fabric index health (only while Fabric Data is on): rebuilt again through the same allow-lists; never the admin extras.
    ...(full.fabric ? { fabric: full.fabric.detail === true ? detailedView(full.fabric, { admin: false }) : generalView(full.fabric) } : {})
  };
}

// viewerObjectIds: SYSTEM_HEALTH_VIEWER_OIDS; tenantId: ENTRA_TENANT_ID. A JARC administrator gets the full view (unchanged,
// plus scope: "admin"); a listed viewer gets viewerView (scope: "viewer"); Activity History stays JARC administrators only.
// fabricHealth: FabricIndexHealth (src/fabric/health.js) while Fabric Data is on, else null (no "fabric" part).
// canSeeFabricDetail(actor): a Fabric reader (detailedView); anyone else gets generalView (healthy | degraded | unavailable).
function systemHealthRoutes({ dataLayer, access, environment, version, monitor = defaultMonitor, canManageDrive = () => false, enabled = {}, viewerObjectIds = [], tenantId = null, fabricHealth = null, canSeeFabricDetail = () => false }) {
  const router = express.Router();
  const send = (res, body) => res.status(200).set("Cache-Control", "no-store").json(body);
  const admin = (req) => access.requireSystemAdmin(req.actor);
  const { repos, services, connection } = dataLayer;

  router.get("/admin/system-health", async (req, res) => {
    const viewer = !req.actor?.isSystemAdmin && isSystemHealthViewer(req.actor, viewerObjectIds, tenantId);
    if (!viewer) admin(req);
    allowOnly(req.query, [], "the query");
    const db = connection.db;
    const memory = process.memoryUsage();
    const [pingMs, monday, drive, mid, imports, integrationJobs, fabricRaw] = await Promise.all([
      connection.pingMs(),
      part(async () => (services.integration ? summariseMonday(await services.integration.status(req.actor)) : null)),
      part(async () => (services.googleDrive ? summariseDrive(await services.googleDrive.status({ canManage: viewer ? false : canManageDrive(req.actor) })) : null)),
      part(async () => (!viewer && services.midAttachments && canManageDrive(req.actor) ? midRuns(db) : null)),
      part(async () => (enabled.spreadsheetImports ? importSummary(db) : null)),
      part(async () => jobSummary(repos.integrations)),
      part(async () => (fabricHealth ? fabricHealth.snapshot() : null))
    ]);
    let fabric = null;
    if (fabricHealth) { let detail = false; try { detail = canSeeFabricDetail(req.actor) === true; } catch { detail = false; } fabric = detail ? detailedView(fabricRaw, { admin: !viewer }) : generalView(fabricRaw); }
    const snap = monitor.snapshot();
    const search = dataLayer.searchIndex;
    const full = {
      scope: "admin",
      generatedAt: new Date().toISOString(),
      server: { status: pingMs === null ? "degraded" : "ok", environment, version, uptimeSeconds: Math.round(process.uptime()), node: process.version, memoryMb: { rss: Math.round(memory.rss / 1048576), heapUsed: Math.round(memory.heapUsed / 1048576) }, monitoringSince: snap.since },
      database: { status: pingMs === null ? "unavailable" : "connected", pingMs, ...snap.database },
      api: snap.api, slowestEndpoints: snap.slowestEndpoints, failingEndpoints: snap.failingEndpoints, endpoints: snap.endpoints.slice(0, 60), trend: snap.trend, recentErrors: snap.recentErrors,
      integrations: {
        monday: { ...(monday || { enabled: false }), activity: snap.integrations.monday || null },
        googleDrive: { ...(drive || { enabled: false }), activity: snap.integrations["google-drive"] || null }
      },
      jobs: { integration: integrationJobs, imports, midAttachments: mid, searchIndex: search ? { mode: search.mode, ready: Boolean(search.ready) } : null, recentFailures: snap.jobFailures },
      fabric
    };
    send(res, viewer ? viewerView(full) : full);
  });

  router.get("/admin/activity", async (req, res) => {
    admin(req);
    const filter = activityQuery(req.query);
    let items;
    try { items = await repos.activities.search({ ...filter, limit: filter.limit + 1 }); }
    catch (error) {
      if (error?.code === 50 || error?.codeName === "MaxTimeMSExpired") fail("This search took too long. Narrow it with a date range or a board.");
      throw error;
    }
    const more = items.length > filter.limit;
    if (more) items = items.slice(0, filter.limit);
    const boardIds = [...new Set(items.map((i) => hex(i.boardId)).filter(Boolean))];
    const boards = new Map((boardIds.length ? await repos.boards.collection.find({ _id: { $in: boardIds.map((id) => new ObjectId(id)) } }, { projection: { name: 1 } }).toArray() : []).map((b) => [b._id.toHexString(), b.name]));
    const last = items.at(-1);
    send(res, { items: items.map((i) => activityToAdmin(i, boards)), next: more && last ? `${iso(last.createdAt)}_${last._id.toHexString()}` : null });
  });
  return router;
}

// monday.com, as System Health shows it: state and counts, no account details beyond the account's name.
function summariseMonday(s) {
  return { enabled: s.enabled, configured: s.configured, state: s.state, connected: s.connected, account: s.account?.name || null, sync: s.sync, importedBoards: s.importedBoards?.length ?? 0, failedJobs: (s.failed || []).map((j) => ({ id: j.id, type: j.type, status: j.status, attempts: j.attempts ?? null, error: j.error ? redact(String(j.error)).slice(0, 200) : null, finishedAt: j.finishedAt || null, createdAt: j.createdAt || null })), recentImports: (s.imports || []).slice(0, 5).map((j) => ({ id: j.id, status: j.status, progress: j.progress ?? null, createdAt: j.createdAt || null })) };
}
// Google Drive, as System Health shows it: state only. Never the account's email or the folder's link (those stay on the
// Integrations page, for Google Drive administrators).
function summariseDrive(s) {
  return { enabled: s.enabled, connected: s.connected, state: s.state, activeForNewUploads: s.activeForNewUploads, canManage: s.canManage, lastError: s.lastError ?? null, lastErrorAt: s.lastErrorAt ?? null };
}
async function jobSummary(integrations) {
  const by = async (status) => integrations.countJobs({ provider: "monday", status });
  const [queued, running, retry, failed] = await Promise.all(["queued", "running", "retry", "failed"].map(by));
  return { monday: { queued, running, retry, failed } };
}
// Recent runs from their run documents only (cheap: never a scan of their thousands of file entries).
async function midRuns(db) {
  const runs = await db.collection("integrationJobs").find({ type: "mid-attachments-run" }, { sort: { createdAt: -1 }, limit: 3, projection: { status: 1, mode: 1, remaining: 1, totals: 1, pausedReason: 1, lastError: 1, createdAt: 1, startedAt: 1, finishedAt: 1, pilotFinishedAt: 1 } }).toArray();
  return runs.map((r) => ({ runId: String(r._id), status: r.status, mode: r.mode || null, remaining: r.remaining ?? null, totalFiles: r.totals?.files ?? null, pausedReason: r.pausedReason || null, lastError: r.lastError ? redact(String(r.lastError)).slice(0, 200) : null, createdAt: iso(r.createdAt), startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt), pilotFinishedAt: iso(r.pilotFinishedAt) }));
}
async function importSummary(db) {
  const jobs = db.collection("importJobs");
  const [active, failed, recent] = await Promise.all([
    jobs.countDocuments({ status: { $in: IMPORT_ACTIVE } }),
    jobs.countDocuments({ status: "failed" }),
    jobs.find({}, { sort: { createdAt: -1 }, limit: 5, projection: { status: 1, createdAt: 1, finishedAt: 1, "progress.done": 1, "progress.total": 1, totalRows: 1 } }).toArray()
  ]);
  return { active, failed, recent: recent.map((j) => ({ id: String(j._id), status: j.status, createdAt: iso(j.createdAt), finishedAt: iso(j.finishedAt) })) };
}

module.exports = { systemHealthRoutes, activityQuery, safeValue, activityToAdmin, summariseDrive, isSystemHealthViewer, viewerView };
