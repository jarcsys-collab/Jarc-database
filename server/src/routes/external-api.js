// The read-only REST API for other systems (Power BI, Power Automate, n8n, Excel, scripts), authenticated ONLY by an API token:
//
//   Authorization: Bearer jarc_...
//
//   GET /external/me
//   GET /external/workspaces
//   GET /external/workspaces/:workspaceId/boards
//   GET /external/boards/:boardId                 with its columns and groups
//   GET /external/boards/:boardId/columns
//   GET /external/boards/:boardId/columns/:columnId
//   GET /external/boards/:boardId/columns/:columnId/values    ?limit&cursor&groupId&includeArchived&updatedSince
//   GET /external/boards/:boardId/groups
//   GET /external/boards/:boardId/records         the same, and &columns=a,b
//   GET /external/boards/:boardId/records/:recordId/columns/:columnId
//   GET /external/records/:recordId
// A board's ID and a column's ID are identifiers, not secrets: knowing one grants nothing without a token that covers the board.
//
// These paths are separate from the session API on purpose: a token can't reach any session route (those read only the cookie),
// and a cookie means nothing here, so CSRF doesn't apply and no browser session can be borrowed. No CORS headers are sent, so
// JavaScript on other sites can't call this API. Nothing here changes data except the token's own usage metadata.
//
// Each request: the method, HTTPS, no token in the URL, the token (existence, secret, revocation, expiry), the rate limit, then the
// owner's current access (services/api-token-service.js). Anything outside the token's workspace and boards answers 404, exactly
// like something that doesn't exist. Archived workspaces, boards and records are left out unless the request says includeArchived=true.
// A column hidden on the board is a display choice, not a permission: it is returned, marked visible: false. JARC has no column-level or
// board-level permissions, so the workspace role decides access to everything in a board.
const express = require("express");
const { allowOnly, parseId, queryString, fail, isSafeKey } = require("../validation/common");
const { groupColumnOf } = require("../domain/board-schema");
const { ApiError, sendError, apiNotFound } = require("../middleware/errors");
const { hex, iso } = require("../api/serialize");
const { LOOKS_LIKE_TOKEN } = require("../auth/api-token");

const PAGE = Object.freeze({ defaultLimit: 100, maxLimit: 500 });
const QUERY_TIME_MS = 15000;
const RATE = Object.freeze({ perWindow: 120, windowMs: 60 * 1000 });
const FAILED_AUTH = Object.freeze({ perWindow: 30, windowMs: 60 * 1000 });
const TOKEN_QUERY_NAMES = new Set(["token", "access_token", "accesstoken", "api_key", "apikey", "api_token", "apitoken", "key", "bearer", "authorization", "auth"]);

// A fixed window per key: { allowed, limit, remaining, resetSeconds }.
function windowLimiter({ perWindow, windowMs }) {
  const windows = new Map();
  return (key, now = Date.now()) => {
    let entry = windows.get(key);
    if (!entry || now >= entry.resetAt) {
      if (windows.size > 5000) for (const [k, v] of windows) if (now >= v.resetAt) windows.delete(k);
      entry = { count: 0, resetAt: now + windowMs };
      windows.set(key, entry);
    }
    entry.count += 1;
    return { allowed: entry.count <= perWindow, limit: perWindow, remaining: Math.max(0, perWindow - entry.count), resetSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  };
}

// ---- Responses: only what an integration needs, never internal fields.
function workspaceToExternal(doc) { return { id: hex(doc._id), name: doc.name, description: doc.description ?? "", archived: Boolean(doc.archived), createdAt: iso(doc.createdAt), updatedAt: iso(doc.updatedAt), version: doc.version }; }
// A column's API ID is its stored key: unique on its board, and unchanged by renaming, reordering, hiding or a change of type. Together
// with the board's ID it names one column anywhere in JARC.
const columnToExternal = (c) => ({ id: c.key, name: c.label, type: c.type, required: Boolean(c.required), visible: c.visible !== false, options: [...(c.options || [])], ...(c.multiple ? { multiple: true } : {}), ...(c.description ? { description: c.description } : {}) });
const columnsOf = (board) => board.columns.map((c, position) => ({ ...columnToExternal(c), position }));
const groupsOf = (board) => board.groups.map(({ id, name, color, archived, position }) => ({ id, name, color: color ?? "", archived: Boolean(archived), position }));
function boardSummary(board, recordCount) { return { id: hex(board._id), workspaceId: hex(board.workspaceId), name: board.name, description: board.description ?? "", archived: Boolean(board.archived), position: board.position, recordCount, createdAt: iso(board.createdAt), updatedAt: iso(board.updatedAt), version: board.version }; }
// A cell exactly as stored, with its type. Never set: null. The board's main group column is kept on the record as groupId, so
// its value is that group's name.
function cellValue(doc, column, board) {
  if (column.key === groupColumnOf(board.columns)?.key) return board.groups.find((g) => g.id === doc.groupId)?.name ?? null;
  return Object.hasOwn(doc.values || {}, column.key) ? doc.values[column.key] ?? null : null;
}
const cellToExternal = (doc, column, board) => ({ boardId: hex(board._id), columnId: column.key, columnName: column.label, columnType: column.type, recordId: hex(doc._id), value: cellValue(doc, column, board), updatedAt: iso(doc.updatedAt) });
// Every requested column is present, so each row of a table has the same shape.
function recordToExternal(doc, board, columns) {
  const values = {};
  for (const column of columns) values[column.key] = cellValue(doc, column, board);
  return { id: hex(doc._id), workspaceId: hex(doc.workspaceId), boardId: hex(doc.boardId), groupId: doc.groupId ?? null, position: doc.position, archived: Boolean(doc.archived), values, createdAt: iso(doc.createdAt), updatedAt: iso(doc.updatedAt), version: doc.version };
}

// ---- Record pages. Two fixed orders, neither of which changes when other rows are added, edited, moved or removed:
//   every record   by ID, oldest first: a complete read returns each record once
//   updatedSince   by last change, then ID: a row edited during the read comes again later (so keep the last copy of each ID)
function encodeCursor(boardId, record, byUpdated) {
  return Buffer.from(JSON.stringify({ b: hex(boardId), i: hex(record._id), ...(byUpdated ? { u: iso(record.updatedAt) } : {}) })).toString("base64url");
}
function decodeCursor(textValue, boardId, byUpdated) {
  const invalid = () => fail("cursor isn't valid for this request. Start again from the first page, with the same filters.");
  if (textValue.length > 300 || !/^[A-Za-z0-9_-]+$/.test(textValue)) invalid();
  let data;
  try { data = JSON.parse(Buffer.from(textValue, "base64url").toString("utf8")); } catch { invalid(); }
  if (data === null || typeof data !== "object" || data.b !== hex(boardId) || typeof data.i !== "string" || byUpdated !== (data.u !== undefined)) invalid();
  let id;
  try { id = parseId(data.i); } catch { invalid(); }
  if (!byUpdated) return { id };
  const updatedAt = typeof data.u === "string" ? new Date(data.u) : null;
  if (!updatedAt || Number.isNaN(updatedAt.getTime())) invalid();
  return { id, updatedAt };
}
// ?columns=a,b → those columns in board order. Each must be a column of this board, so nothing from the request ever reaches a query
// except a key the board itself holds.
function parseColumns(raw, board) {
  const text = queryString(raw, "columns");
  if (text === undefined) return null;
  if (text.length > 25000) fail("columns lists too many column IDs.");
  const wanted = new Set(text.split(","));
  for (const id of wanted) if (!isSafeKey(id) || !board.columns.some((c) => c.key === id)) fail(`"${String(id).slice(0, 60)}" isn't a column of this board.`);
  return board.columns.filter((c) => wanted.has(c.key));
}
// Only the fields a response uses, so a request for one column doesn't read whole records.
const projectionFor = (columns) => ({ workspaceId: 1, boardId: 1, groupId: 1, position: 1, archived: 1, createdAt: 1, updatedAt: 1, version: 1, ...Object.fromEntries(columns.map((c) => [`values.${c.key}`, 1])) });

function parseRecordQuery(query, board, extra = []) {
  allowOnly(query, ["limit", "cursor", "groupId", "includeArchived", "updatedSince", ...extra], "the query");
  const limitText = queryString(query.limit, "limit");
  if (limitText !== undefined && (!/^\d{1,4}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > PAGE.maxLimit)) fail(`limit must be a whole number from 1 to ${PAGE.maxLimit}.`);
  const groupId = queryString(query.groupId, "groupId");
  if (groupId !== undefined && groupId !== "none" && !board.groups.some((g) => g.id === groupId)) fail("groupId isn't a group of this board.");
  const includeArchived = queryString(query.includeArchived, "includeArchived");
  if (includeArchived !== undefined && !["true", "false"].includes(includeArchived)) fail("includeArchived must be true or false.");
  const sinceText = queryString(query.updatedSince, "updatedSince");
  const updatedSince = sinceText === undefined ? null : new Date(sinceText);
  if (updatedSince && (Number.isNaN(updatedSince.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(sinceText))) fail("updatedSince must be an ISO 8601 date and time, such as 2026-01-31T12:00:00Z.");
  const byUpdated = Boolean(updatedSince);
  const cursor = queryString(query.cursor, "cursor");
  return { limit: limitText === undefined ? PAGE.defaultLimit : Number(limitText), byUpdated, updatedSince, after: cursor === undefined || cursor === "" ? null : decodeCursor(cursor, board._id, byUpdated), filter: { ...(includeArchived === "true" ? {} : { archived: false }), ...(groupId === undefined ? {} : { groupId: groupId === "none" ? null : groupId }) } };
}

function bearerToken(req) {
  const header = req.get("authorization");
  if (!header) throw new ApiError(401, "UNAUTHENTICATED", "Send an API token: Authorization: Bearer <token>.");
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match) throw new ApiError(401, "INVALID_TOKEN", "This API token isn't valid.");
  return match[1];
}
// The address the client connected from: only for counting failed attempts, and never stored.
const clientKey = (req) => String(req.get("x-forwarded-for") || req.ip || "unknown").split(",")[0].trim().slice(0, 64);

function externalApiRoutes({ tokens, repos, environment = "development", rate = RATE, failedAuth = FAILED_AUTH }) {
  const router = express.Router();
  const limiter = windowLimiter(rate), failures = windowLimiter(failedAuth);
  const send = (res, body) => res.status(200).json(body);

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "HEAD") { res.set("Allow", "GET, HEAD"); return sendError(res, 405, "METHOD_NOT_ALLOWED", "This API is read-only."); }
    // Railway's edge ends TLS and forwards the original scheme; a direct connection to the app isn't encrypted at all.
    if (environment === "production") {
      if (String(req.get("x-forwarded-proto") || "").split(",")[0].trim() !== "https") return sendError(res, 403, "HTTPS_REQUIRED", "Use https:// for this API.");
      res.set("Strict-Transport-Security", "max-age=31536000");
    }
    // A token in a URL ends up in logs and browser history, so it isn't accepted even alongside a valid header.
    if (Object.entries(req.query).some(([name, value]) => TOKEN_QUERY_NAMES.has(name.toLowerCase()) || LOOKS_LIKE_TOKEN.test(String(value)))) return sendError(res, 400, "TOKEN_IN_QUERY", "Don't put API tokens in the URL. Send the Authorization header, and if this token has been shared, revoke it.");
    return next();
  });

  router.use(async (req, res, next) => {
    res.set("WWW-Authenticate", "Bearer");
    let doc;
    try { doc = await tokens.verify(bearerToken(req)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401 && !failures(clientKey(req)).allowed) return sendError(res, 429, "RATE_LIMITED", "Too many failed attempts. Wait a minute and try again.");
      throw error;
    }
    res.removeHeader("WWW-Authenticate");
    const usage = limiter(doc.publicId);
    res.set({ "X-RateLimit-Limit": String(usage.limit), "X-RateLimit-Remaining": String(usage.remaining), "X-RateLimit-Reset": String(usage.resetSeconds) });
    if (!usage.allowed) {
      tokens.auditOnce(doc, "token.rate_limited", "over the request limit");
      res.set("Retry-After", String(usage.resetSeconds));
      return sendError(res, 429, "RATE_LIMITED", `This API token is limited to ${usage.limit} requests per minute. Wait ${usage.resetSeconds} seconds and try again.`);
    }
    await tokens.authorize(doc); // refuses when the owner has lost access, whatever the token says
    await tokens.recordUse(doc);
    req.apiToken = { doc, boardIds: new Set(doc.boardIds.map(hex)) };
    return next();
  });

  const noQuery = (req) => allowOnly(req.query, [], "the query");
  const archivedOnly = (req) => allowOnly(req.query, ["includeArchived"], "the query");
  const wantsArchived = (req) => {
    const value = queryString(req.query.includeArchived, "includeArchived");
    if (value !== undefined && !["true", "false"].includes(value)) fail("includeArchived must be true or false.");
    return value === "true";
  };
  const missing = (what) => new ApiError(404, "NOT_FOUND", `This ${what} doesn't exist or this token can't reach it.`);
  const tokenWorkspace = async (req) => {
    const workspace = await repos.workspaces.findById(req.apiToken.doc.workspaceId);
    return workspace && (!workspace.archived || wantsArchived(req)) ? workspace : null;
  };
  // A board this token covers. Scope is checked before anything is loaded, and against where the board is NOW.
  const scopedBoard = async (req, boardId) => {
    const { doc, boardIds } = req.apiToken;
    if (!boardIds.has(hex(boardId))) throw missing("board");
    const [workspace, board] = await Promise.all([tokenWorkspace(req), repos.boards.findById(boardId)]);
    if (!workspace || !board || (board.archived && !wantsArchived(req)) || !board.workspaceId.equals(doc.workspaceId)) throw missing("board");
    return board;
  };
  const boardParam = (req) => parseId(req.params.boardId, "boardId");

  router.get("/me", async (req, res) => {
    noQuery(req);
    const { doc } = req.apiToken;
    send(res, { token: { id: hex(doc._id), name: doc.name, scopes: [...doc.scopes], workspaceId: hex(doc.workspaceId), boardIds: doc.boardIds.map(hex), createdAt: iso(doc.createdAt), expiresAt: iso(doc.expiresAt) } });
  });

  router.get("/workspaces", async (req, res) => {
    archivedOnly(req);
    const workspace = await tokenWorkspace(req);
    send(res, { items: workspace ? [workspaceToExternal(workspace)] : [] });
  });

  router.get("/workspaces/:workspaceId/boards", async (req, res) => {
    const workspaceId = parseId(req.params.workspaceId, "workspaceId");
    archivedOnly(req);
    const { doc } = req.apiToken;
    if (!workspaceId.equals(doc.workspaceId) || !await tokenWorkspace(req)) throw missing("workspace");
    const boards = (await repos.boards.findManyInWorkspace(workspaceId, doc.boardIds)).filter((b) => !b.archived || wantsArchived(req));
    send(res, { items: await Promise.all(boards.map(async (b) => boardSummary(b, await repos.records.countActive(b._id)))) });
  });

  router.get("/boards/:boardId", async (req, res) => {
    const id = boardParam(req);
    archivedOnly(req);
    const board = await scopedBoard(req, id);
    send(res, { board: { ...boardSummary(board, await repos.records.countActive(board._id)), columns: columnsOf(board), groups: groupsOf(board) } });
  });
  router.get("/boards/:boardId/columns", async (req, res) => {
    const id = boardParam(req);
    archivedOnly(req);
    send(res, { items: columnsOf(await scopedBoard(req, id)) });
  });
  router.get("/boards/:boardId/groups", async (req, res) => {
    const id = boardParam(req);
    archivedOnly(req);
    send(res, { items: groupsOf(await scopedBoard(req, id)) });
  });

  // A column of this board, or 404 (a deleted column included).
  const columnParam = (req, board) => {
    if (!isSafeKey(req.params.columnId)) fail("columnId is not a valid column ID.");
    const column = board.columns.find((c) => c.key === req.params.columnId);
    if (!column) throw missing("column");
    return column;
  };
  const pageOf = async (board, query, columns) => {
    const { limit, byUpdated, updatedSince, after, filter } = query;
    const page = await repos.records.listForExternalApi(board._id, { limit, byUpdated, updatedSince, after, filter, projection: projectionFor(columns), maxTimeMS: QUERY_TIME_MS });
    return { items: page.items, pagination: { limit, hasMore: page.hasMore, nextCursor: page.hasMore ? encodeCursor(board._id, page.items.at(-1), byUpdated) : null } };
  };

  router.get("/boards/:boardId/columns/:columnId", async (req, res) => {
    const board = await scopedBoard(req, boardParam(req));
    archivedOnly(req);
    const column = columnParam(req, board);
    send(res, { column: { boardId: hex(board._id), ...columnsOf(board).find((c) => c.id === column.key) } });
  });
  router.get("/boards/:boardId/columns/:columnId/values", async (req, res) => {
    const board = await scopedBoard(req, boardParam(req));
    const column = columnParam(req, board);
    const { items, pagination } = await pageOf(board, parseRecordQuery(req.query, board), [column]);
    send(res, { items: items.map((r) => cellToExternal(r, column, board)), pagination });
  });

  router.get("/boards/:boardId/records", async (req, res) => {
    const board = await scopedBoard(req, boardParam(req));
    const query = parseRecordQuery(req.query, board, ["columns"]);
    const columns = parseColumns(req.query.columns, board) || board.columns;
    const { items, pagination } = await pageOf(board, query, columns);
    send(res, { items: items.map((r) => recordToExternal(r, board, columns)), pagination });
  });
  router.get("/boards/:boardId/records/:recordId/columns/:columnId", async (req, res) => {
    const board = await scopedBoard(req, boardParam(req));
    const recordId = parseId(req.params.recordId, "recordId");
    archivedOnly(req);
    const column = columnParam(req, board);
    const record = await repos.records.findById(recordId);
    if (!record || !record.boardId.equals(board._id) || (record.archived && !wantsArchived(req))) throw missing("record");
    send(res, { value: cellToExternal(record, column, board) });
  });

  router.get("/records/:recordId", async (req, res) => {
    const id = parseId(req.params.recordId, "recordId");
    archivedOnly(req);
    const record = await repos.records.findById(id);
    if (!record || (record.archived && !wantsArchived(req)) || !req.apiToken.boardIds.has(hex(record.boardId)) || !record.workspaceId.equals(req.apiToken.doc.workspaceId)) throw missing("record");
    const board = await scopedBoard(req, record.boardId).catch((error) => { throw error instanceof ApiError && error.status === 404 ? missing("record") : error; });
    send(res, { record: recordToExternal(record, board, board.columns) });
  });

  router.use(apiNotFound);
  return router;
}

module.exports = { externalApiRoutes, windowLimiter, columnsOf, groupsOf, boardSummary, cellToExternal, parseColumns, projectionFor, recordToExternal, PAGE, RATE, QUERY_TIME_MS };
