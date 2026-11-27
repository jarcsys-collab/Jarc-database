// Resource API. Every route authorizes against the STORED resource before doing anything else: boards and records
// are loaded and their workspace is read from the database (never taken from the request), then the caller's role in
// that workspace is checked (see auth/access.js). Non-members get 404; members without the role get 403.
//
//   AUTH_MODE=entra  the caller is the Microsoft Entra user of the server session (auth/session.js).
//   AUTH_MODE=dev    DEVELOPMENT / PRE-AUTH only: the fixed development actor (never in production).
//
// Responses use `id` (string), never `_id`, and ISO 8601 dates. Single resources are wrapped ({ workspace },
// { board }, { record }); lists are { items } (records add nextCursor and limit).
const express = require("express");
const { ObjectId } = require("mongodb");
const { parseId, versionParam, allowOnly, queryString, fail, isSafeKey, requireBody, isObject } = require("../validation/common");
const { GROUP_ID, optionsPlan } = require("../domain/board-schema");
const validate = require("../validation/resources");
const { Access, forbidden } = require("../auth/access");
const { workspaceToApi, boardToApi } = require("../api/serialize");
const { ApiError } = require("../middleware/errors");
const { RelatedService } = require("../services/related-service");
const { authzFor, recordsOut, activityOut, connectsOf, restrictedFor } = require("../services/relation-guard");

// Boards synchronized from monday.com are read-only here: their records and schema change only through the sync.
const readOnly = () => new ApiError(403, "READ_ONLY_BOARD", "This board is synchronized from monday.com and is read-only in JARC.");
const writable = (board) => { if (board?.source?.readOnly) throw readOnly(); };

// features: { personalViews, connectBoards } (config JARC_FEATURE_PERSONAL_VIEWS / JARC_FEATURE_CONNECT_BOARDS). While a switch is off,
// nothing new of that kind can be made; what already exists keeps working and stays private (see the deployment notes).
// relations: the record link index status (relations/record-links.js; null = not checked). When it isn't ready, Connect and Mirror
// fail CLOSED (read-only, not resolved, with a clear status) and every other board function keeps working.
function resourceRoutes({ services, access, features = { personalViews: true, connectBoards: true }, relations = null }) {
  const router = express.Router();
  const send = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);
  const deleteQuery = (req) => { allowOnly(req.query, ["expectedVersion"], "the query"); return versionParam(req.query.expectedVersion); };
  const noQuery = (req) => allowOnly(req.query, [], "the query");
  const workspaceId = (req) => parseId(req.params.workspaceId, "workspaceId");
  const boardId = (req) => parseId(req.params.boardId, "boardId");
  const recordId = (req) => parseId(req.params.recordId, "recordId");
  // Who may be named in a People cell: everyone active under development_shared (and for the local developer),
  // otherwise the record's workspace's active members — the same people GET /workspaces/:id/people offers.
  // Files of deleted records, boards, workspaces and columns are removed after the delete (never fails the request;
  // the file sweep catches anything missed).
  const purgeFiles = (filter) => services.files?.purge(filter);
  // A deleted record, board or workspace takes its discussion with it (column changes never touch comments).
  const purgeComments = (filter) => services.comments?.repos.comments.purge(filter);
  const peopleRule = (req) => ({ everyone: access.shared || req.actor.kind === "development" });
  // Who is reading, for "@me" filter conditions: only the authenticated actor set by the session middleware (never anything
  // in the request). No valid user → null, and such conditions match no record.
  // A board as the signed-in person receives it: shared views plus their own personal views (stored apart; serialize.js).
  const personalRepo = services?.records?.repos?.personalViews;
  const boardOut = async (req, doc) => boardToApi(doc, { personal: personalRepo && req.actor?.userId ? await personalRepo.get(doc._id, req.actor.userId) : null });
  // Connect / Mirror columns: cross-board checks and lookups, always for the person asking (services/related-service.js).
  const related = new RelatedService({ repos: services?.records?.repos, access, relations }); // services is absent only in start-up checks that fail later
  // S0-B: one authorization context per request (auth/authz-context.js); records leave through recordsOut (restricted Connect
  // cells left out), activity through activityOut (restricted Connect changes redacted).
  const ctxOf = (req) => authzFor(req, access);
  const out = (req, board, docs) => recordsOut(ctxOf(req), board, docs);
  const withDropped = (body, dropped) => (Object.keys(dropped).length ? { ...body, droppedLinks: dropped } : body);
  // The writes of a body for checkLinks: create paths carry no stored values; update paths the stored values of each record.
  const createWrites = (body) => valuesIn(body).map((values) => ({ values, current: null }));
  const bulkWrites = async (board, body) => {
    const items = isObject(body) && Array.isArray(body.items) ? body.items.filter((i) => isObject(i) && isObject(i.values)) : [];
    const touches = connectsOf(board).some((c) => items.some((i) => Object.prototype.hasOwnProperty.call(i.values, c.key)));
    const ids = [...new Set(items.map((i) => String(i.id)).filter((id) => /^[0-9a-f]{24}$/.test(id)))].map((id) => new ObjectId(id));
    const docs = touches && ids.length ? await services.records.repos.records.findByIds(board._id, ids, { projection: Object.fromEntries(connectsOf(board).map((c) => [`values.${c.key}`, 1])) }) : [];
    const stored = new Map(docs.map((d) => [d._id.toHexString(), d.values || {}]));
    return items.map((i) => ({ values: i.values, current: stored.get(String(i.id)) || null }));
  };
  // Every values object a write carries: one record (values), a batch create (records[].values), a bulk update (items[].values).
  const valuesIn = (body) => (isObject(body) ? [body.values, ...(Array.isArray(body.records) ? body.records.map((r) => r?.values) : []), ...(Array.isArray(body.items) ? body.items.map((i) => i?.values) : [])].filter(isObject) : []);
  const columnsIn = (body) => (isObject(body) ? [...(Array.isArray(body.columns) ? body.columns : []), ...(isObject(body.column) ? [body.column] : []), ...(body.type === "connect" ? [body] : [])].filter(isObject) : []);
  const reading = (req) => { const id = req.actor?.userId, hex = typeof id?.toHexString === "function" ? id.toHexString() : typeof id === "string" ? id : ""; return { me: /^[0-9a-f]{24}$/.test(hex) ? `user:${hex}` : null }; };

  // ---- Workspaces
  // Only the workspaces the caller belongs to (system admins, and everyone under development_shared: all), each with
  // the caller's role.
  router.get("/workspaces", async (req, res) => {
    noQuery(req);
    const roles = await access.visibleRoles(req.actor);
    const items = (await services.workspaces.list())
      .filter((w) => !roles || roles.has(w._id.toHexString()))
      .map((w) => ({ ...workspaceToApi(w), role: roles ? roles.get(w._id.toHexString()) : access.globalRole(req.actor) }));
    send(res, 200, { items });
  });
  router.post("/workspaces", async (req, res) => {
    access.requireWorkspaceManager(req.actor);
    noQuery(req);
    send(res, 201, { workspace: { ...workspaceToApi(await services.workspaces.create(req.body, req.actor)), role: "WORKSPACE_ADMIN" } });
  });
  router.get("/workspaces/:workspaceId", async (req, res) => {
    const { workspace, role } = await access.workspace(req.actor, workspaceId(req), "VIEWER");
    noQuery(req);
    send(res, 200, { workspace: { ...workspaceToApi(workspace), role } });
  });
  router.patch("/workspaces/:workspaceId", async (req, res) => {
    const { workspace, role } = await access.workspace(req.actor, workspaceId(req), "WORKSPACE_ADMIN");
    noQuery(req);
    send(res, 200, { workspace: { ...workspaceToApi(await services.workspaces.update(workspace._id, req.body, req.actor)), role } });
  });
  router.delete("/workspaces/:workspaceId", async (req, res) => {
    const { workspace } = await access.deletableWorkspace(req.actor, workspaceId(req));
    // Files are purged by the workspace's boards (read before deleting), never by a stored workspace ID that could
    // be out of date after a board move.
    const boardIds = (await services.boards.listByWorkspace(workspace._id)).map((b) => b._id);
    const removed = await services.workspaces.delete(workspace._id, deleteQuery(req), req.actor);
    if (boardIds.length) { await purgeFiles({ boardId: { $in: boardIds } }); await purgeComments({ boardId: { $in: boardIds } }); await personalRepo?.deleteByBoards(boardIds); }
    send(res, 200, { deleted: true, removed });
  });

  // ---- Boards
  router.get("/workspaces/:workspaceId/boards", async (req, res) => {
    const { workspace } = await access.workspace(req.actor, workspaceId(req), "VIEWER");
    noQuery(req);
    const list = await services.boards.listByWorkspace(workspace._id), mine = personalRepo && req.actor?.userId ? await personalRepo.forBoards(list.map((b) => b._id), req.actor.userId) : new Map();
    send(res, 200, { items: list.map((b) => boardToApi(b, { personal: mine.get(String(b._id)) || null })) });
  });
  router.post("/workspaces/:workspaceId/boards", async (req, res) => {
    const { workspace } = await access.workspace(req.actor, workspaceId(req), "MEMBER");
    noQuery(req);
    await related.checkColumns(ctxOf(req), columnsIn(req.body), [], { allowNew: features.connectBoards });
    send(res, 201, { board: await boardOut(req, await services.boards.create(workspace._id, req.body, req.actor)) });
  });
  router.get("/boards/:boardId", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "VIEWER");
    noQuery(req);
    send(res, 200, { board: await boardOut(req, { ...board, recordCount: await services.boards.recordCount(board._id) }) });
  });
  // Members edit names, descriptions, columns, groups and views; archiving a board is for workspace admins.
  router.patch("/boards/:boardId", async (req, res) => {
    // Viewers may change only their own personal saved views (nothing else on the board; board-schema checks the views).
    const viewsOnly = features.personalViews && isObject(req.body) && Object.keys(req.body).every((k) => k === "expectedVersion" || k === "savedViews");
    const { board, role } = await access.board(req.actor, boardId(req), viewsOnly ? "VIEWER" : "MEMBER");
    if (board.source?.readOnly && isObject(req.body) && Object.keys(req.body).some((k) => !["expectedVersion", "archived", "savedViews", "position"].includes(k))) throw readOnly(); // only archiving, views and order
    noQuery(req);
    await related.checkColumns(ctxOf(req), columnsIn(req.body), board.columns, { allowNew: features.connectBoards });
    if (isObject(req.body) && req.body.archived !== undefined && !Access.atLeast(role, "WORKSPACE_ADMIN")) throw forbidden("Only workspace admins can archive or restore boards.");
    send(res, 200, { board: await boardOut(req, await services.boards.update(board._id, req.body, req.actor, { canEditShared: Access.atLeast(role, "MEMBER"), allowPersonal: features.personalViews })) });
  });
  router.delete("/boards/:boardId", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "WORKSPACE_ADMIN");
    const removed = await services.boards.delete(board._id, deleteQuery(req), req.actor);
    await purgeFiles({ boardId: board._id });
    await purgeComments({ boardId: board._id });
    await personalRepo?.deleteByBoards([board._id]); // everyone's personal views of it
    if (board.source) await services.integration?.forgetBoard(board._id);
    send(res, 200, { deleted: true, removed });
  });

  // ---- Records (a board's records belong to the board's workspace; batches can only touch that board's records)
  router.get("/boards/:boardId/records", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "VIEWER");
    const restricted = await restrictedFor(ctxOf(req), board);
    const page = await services.records.list(board._id, req.query, { ...reading(req), restricted });
    // S0-B: the board's Connect / Mirror columns this reader can't open (only when there are any), so the browser applies the same
    // refusal to saved-view conditions on boards it filters itself. Column keys only: the board already lists those columns.
    send(res, 200, { items: await out(req, board, page.items), nextCursor: page.nextCursor, limit: page.limit, ...(restricted.size ? { restrictedColumns: [...restricted] } : {}) });
  });
  router.get("/boards/:boardId/records/count", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "VIEWER");
    send(res, 200, await services.records.count(board._id, req.query, { ...reading(req), restricted: await restrictedFor(ctxOf(req), board) }));
  });
  router.post("/boards/:boardId/records", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "MEMBER");
    writable(board);
    noQuery(req);
    const { dropped } = await related.checkLinks(ctxOf(req), board, createWrites(req.body), { allowWrite: features.connectBoards, mode: "create" });
    const [record] = await out(req, board, [await services.records.create(board._id, req.body, req.actor, peopleRule(req))]);
    send(res, 201, withDropped({ record }, dropped));
  });
  router.post("/boards/:boardId/records/batch", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "MEMBER");
    writable(board);
    noQuery(req);
    const { dropped } = await related.checkLinks(ctxOf(req), board, createWrites(req.body), { allowWrite: features.connectBoards, mode: "create" });
    send(res, 201, withDropped({ items: await out(req, board, await services.records.createMany(board._id, req.body, req.actor, peopleRule(req))) }, dropped));
  });
  router.patch("/boards/:boardId/records", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "MEMBER");
    writable(board);
    noQuery(req);
    const { dropped } = await related.checkLinks(ctxOf(req), board, await bulkWrites(board, req.body), { allowWrite: features.connectBoards, mode: "update" });
    send(res, 200, withDropped({ items: await out(req, board, await services.records.updateMany(board._id, req.body, req.actor, peopleRule(req))) }, dropped));
  });
  router.post("/boards/:boardId/records/delete", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "MEMBER");
    writable(board);
    noQuery(req);
    const result = await services.records.deleteMany(board._id, req.body, req.actor);
    const ids = validate.recordBatchDelete(req.body).map((i) => i.id);
    const gone = (await Promise.all(ids.map(async (id) => (await services.records.exists(id)) ? null : id))).filter(Boolean);
    if (gone.length) { await purgeFiles({ boardId: board._id, recordId: { $in: gone } }); await purgeComments({ boardId: board._id, recordId: { $in: gone } }); }
    send(res, 200, result);
  });

  // ---- Board schema changes (each one transaction; ?dryRun=true → { affected })
  const columnKey = (req) => { if (!isSafeKey(req.params.key)) fail("The column key is not valid."); return req.params.key; };
  const schemaResult = async (res, result) => send(res, 200, result.dryRun ? result : { board: await boardOut(res.req, result.board), affected: result.affected, recordsChanged: result.recordsChanged });
  router.post("/boards/:boardId/columns", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "MEMBER");
    writable(board);
    noQuery(req);
    await related.checkColumns(ctxOf(req), columnsIn(req.body), board.columns, { allowNew: features.connectBoards });
    const result = await services.schema.addColumn(board._id, req.body, req.actor);
    send(res, 201, { board: await boardOut(req, result.board), recordsChanged: result.recordsChanged });
  });
  // Deleting a column or changing its type can lose data: workspace admins only.
  router.delete("/boards/:boardId/columns/:key", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "WORKSPACE_ADMIN");
    writable(board);
    const key = columnKey(req);
    const result = await services.schema.deleteColumn(board._id, key, req.query, req.actor);
    if (!result.dryRun) await purgeFiles({ boardId: board._id, columnKey: key });
    await schemaResult(res, result);
  });
  router.post("/boards/:boardId/columns/:key/type", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "WORKSPACE_ADMIN");
    writable(board);
    await schemaResult(res, await services.schema.changeType(board._id, columnKey(req), req.body, req.query, req.actor));
  });
  // Adding and renaming options: members. Removing an option (which clears values that use it): admins.
  router.put("/boards/:boardId/columns/:key/options", async (req, res) => {
    const { board, role } = await access.board(req.actor, boardId(req), "MEMBER");
    writable(board);
    const key = columnKey(req);
    if (!Access.atLeast(role, "WORKSPACE_ADMIN")) {
      const { items } = validate.columnOptions(req.body);
      const column = board.columns.find((c) => c.key === key);
      if (column && optionsPlan(column, items).removed.size) throw forbidden("Only workspace admins can remove options.");
    }
    await schemaResult(res, await services.schema.editOptions(board._id, key, req.body, req.query, req.actor));
  });
  router.delete("/boards/:boardId/groups/:groupId", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "MEMBER");
    writable(board);
    if (!GROUP_ID.test(req.params.groupId)) fail("The group ID is not valid.");
    await schemaResult(res, await services.schema.deleteGroup(board._id, req.params.groupId, req.query, req.actor));
  });
  // Moving a board needs admin rights in BOTH workspaces; the target is checked like any other workspace.
  router.post("/boards/:boardId/move", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "WORKSPACE_ADMIN");
    noQuery(req);
    const { workspaceId: target } = validate.boardMove(requireBody(req.body));
    await access.workspace(req.actor, target, "WORKSPACE_ADMIN");
    // The move also aligns the workspace copies on the board's records, attachments and comments (bounded batches, P4-0).
    const result = await services.schema.moveBoard(board._id, req.body, req.actor);
    send(res, 200, { board: await boardOut(req, result.board), recordsMoved: result.records });
  });
  router.get("/boards/:boardId/activity", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "VIEWER");
    send(res, 200, { items: await activityOut(ctxOf(req), await services.boards.activity(board._id, req.query)) });
  });

  router.get("/records/:recordId", async (req, res) => {
    const { record } = await access.record(req.actor, recordId(req), "VIEWER");
    noQuery(req);
    const recordBoard = await services.records.board(record.boardId);
    send(res, 200, { record: (await out(req, recordBoard, [record]))[0] });
  });
  router.patch("/records/:recordId", async (req, res) => {
    const { record } = await access.record(req.actor, recordId(req), "MEMBER");
    const recordBoard = await services.records.board(record.boardId);
    writable(recordBoard);
    const { dropped } = await related.checkLinks(ctxOf(req), recordBoard, valuesIn(req.body).map((values) => ({ values, current: record.values || {} })), { allowWrite: features.connectBoards, mode: "update" });
    noQuery(req);
    const [updated] = await out(req, recordBoard, [await services.records.update(record._id, req.body, req.actor, peopleRule(req))]);
    send(res, 200, withDropped({ record: updated }, dropped));
  });
  // Connect / Mirror: for up to 200 records of this board (those on screen), the names of their linked records and their
  // mirror values, from linked boards this person may see. ?ids=<recordId>,<recordId>,…
  router.get("/boards/:boardId/related", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "VIEWER");
    allowOnly(req.query, ["ids"], "the query");
    const ids = String(queryString(req.query.ids, "ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length > 200 || ids.some((id) => !/^[0-9a-f]{24}$/.test(id))) fail("ids must be up to 200 record IDs, separated by commas.");
    send(res, 200, await related.resolve(ctxOf(req), board, ids));
  });
  router.delete("/records/:recordId", async (req, res) => {
    const { record } = await access.record(req.actor, recordId(req), "MEMBER");
    writable(await services.records.board(record.boardId));
    await services.records.delete(record._id, deleteQuery(req), req.actor);
    await purgeFiles({ recordId: record._id });
    await purgeComments({ recordId: record._id });
    send(res, 200, { deleted: true });
  });

  // ---- Migration of a legacy state document or browser backup (creates workspaces): JARC administrators only.
  router.post("/imports", async (req, res) => {
    access.requireSystemAdmin(req.actor);
    allowOnly(req.query, ["dryRun"], "the query");
    const dryRun = queryString(req.query.dryRun, "dryRun") ?? "false";
    if (!["true", "false"].includes(dryRun)) fail("dryRun must be true or false.");
    const result = await services.imports.run(req.body, { dryRun: dryRun === "true", actor: req.actor });
    send(res, result.dryRun ? 200 : 201, result);
  });

  // ---- Notification feed: the activity log of every workspace the caller can see, newest first. Each entry names
  // its actor with the ID and the display-name snapshot stored when the change was made (null for older entries).
  router.get("/activity", async (req, res) => {
    allowOnly(req.query, ["limit", "before"], "the query");
    const limitText = queryString(req.query.limit, "limit"), beforeText = queryString(req.query.before, "before");
    if (limitText !== undefined && (!/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 100)) fail("limit must be a whole number from 1 to 100.");
    const before = beforeText === undefined ? null : new Date(beforeText);
    if (before && Number.isNaN(before.getTime())) fail("before must be a date and time.");
    const roles = await access.visibleRoles(req.actor);
    const workspaceIds = roles ? [...roles.keys()].map((id) => new ObjectId(id)) : null;
    const items = workspaceIds && !workspaceIds.length ? [] : await services.activity.recent({ workspaceIds, limit: limitText === undefined ? 50 : Number(limitText), before });
    send(res, 200, { items: await activityOut(ctxOf(req), items) });
  });

  // ---- People who can be assigned in a workspace (People columns). development_shared, and the local developer:
  // every active JARC user (all from the configured Microsoft tenant); role_based: the workspace's members.
  router.get("/workspaces/:workspaceId/people", async (req, res) => {
    const { workspace } = await access.workspace(req.actor, workspaceId(req), "VIEWER");
    allowOnly(req.query, ["q"], "the query");
    const q = (queryString(req.query.q, "q") ?? "").trim().toLowerCase().slice(0, 100);
    const everyone = access.shared || req.actor.kind === "development";
    const users = everyone ? await services.people.active() : await services.people.members(workspace._id);
    const items = users
      .filter((u) => u.status === "active" && (!q || `${u.displayName || ""} ${u.email || ""}`.toLowerCase().includes(q)))
      .map((u) => ({ id: `user:${u._id.toHexString()}`, displayName: u.displayName || u.email || "Unnamed user", email: u.email || null, isYou: u._id.equals(req.actor.userId) }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    send(res, 200, { items });
  });

  return router;
}

module.exports = { resourceRoutes };
