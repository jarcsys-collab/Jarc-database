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
const { workspaceToApi, boardToApi, recordToApi, activityToApi } = require("../api/serialize");

function resourceRoutes({ services, access }) {
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
  const peopleRule = (req) => ({ everyone: access.shared || req.actor.kind === "development" });

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
    if (boardIds.length) await purgeFiles({ boardId: { $in: boardIds } });
    send(res, 200, { deleted: true, removed });
  });

  // ---- Boards
  router.get("/workspaces/:workspaceId/boards", async (req, res) => {
    const { workspace } = await access.workspace(req.actor, workspaceId(req), "VIEWER");
    noQuery(req);
    send(res, 200, { items: (await services.boards.listByWorkspace(workspace._id)).map(boardToApi) });
  });
  router.post("/workspaces/:workspaceId/boards", async (req, res) => {
    const { workspace } = await access.workspace(req.actor, workspaceId(req), "MEMBER");
    noQuery(req);
    send(res, 201, { board: boardToApi(await services.boards.create(workspace._id, req.body, req.actor)) });
  });
  router.get("/boards/:boardId", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "VIEWER");
    noQuery(req);
    send(res, 200, { board: boardToApi(board) });
  });
  // Members edit names, descriptions, columns, groups and views; archiving a board is for workspace admins.
  router.patch("/boards/:boardId", async (req, res) => {
    const { board, role } = await access.board(req.actor, boardId(req), "MEMBER");
    noQuery(req);
    if (isObject(req.body) && req.body.archived !== undefined && !Access.atLeast(role, "WORKSPACE_ADMIN")) throw forbidden("Only workspace admins can archive or restore boards.");
    send(res, 200, { board: boardToApi(await services.boards.update(board._id, req.body, req.actor)) });
  });
  router.delete("/boards/:boardId", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "WORKSPACE_ADMIN");
    const removed = await services.boards.delete(board._id, deleteQuery(req), req.actor);
    await purgeFiles({ boardId: board._id });
    send(res, 200, { deleted: true, removed });
  });

  // ---- Records (a board's records belong to the board's workspace; batches can only touch that board's records)
  router.get("/boards/:boardId/records", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "VIEWER");
    const page = await services.records.list(board._id, req.query);
    send(res, 200, { items: page.items.map(recordToApi), nextCursor: page.nextCursor, limit: page.limit });
  });
  router.post("/boards/:boardId/records", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "MEMBER");
    noQuery(req);
    send(res, 201, { record: recordToApi(await services.records.create(board._id, req.body, req.actor, peopleRule(req))) });
  });
  router.post("/boards/:boardId/records/batch", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "MEMBER");
    noQuery(req);
    send(res, 201, { items: (await services.records.createMany(board._id, req.body, req.actor, peopleRule(req))).map(recordToApi) });
  });
  router.patch("/boards/:boardId/records", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "MEMBER");
    noQuery(req);
    send(res, 200, { items: (await services.records.updateMany(board._id, req.body, req.actor, peopleRule(req))).map(recordToApi) });
  });
  router.post("/boards/:boardId/records/delete", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "MEMBER");
    noQuery(req);
    const result = await services.records.deleteMany(board._id, req.body, req.actor);
    const ids = validate.recordBatchDelete(req.body).map((i) => i.id);
    const gone = (await Promise.all(ids.map(async (id) => (await services.records.exists(id)) ? null : id))).filter(Boolean);
    if (gone.length) await purgeFiles({ boardId: board._id, recordId: { $in: gone } });
    send(res, 200, result);
  });

  // ---- Board schema changes (each one transaction; ?dryRun=true → { affected })
  const columnKey = (req) => { if (!isSafeKey(req.params.key)) fail("The column key is not valid."); return req.params.key; };
  const schemaResult = (res, result) => send(res, 200, result.dryRun ? result : { board: boardToApi(result.board), affected: result.affected, recordsChanged: result.recordsChanged });
  router.post("/boards/:boardId/columns", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "MEMBER");
    noQuery(req);
    const result = await services.schema.addColumn(board._id, req.body, req.actor);
    send(res, 201, { board: boardToApi(result.board), recordsChanged: result.recordsChanged });
  });
  // Deleting a column or changing its type can lose data: workspace admins only.
  router.delete("/boards/:boardId/columns/:key", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "WORKSPACE_ADMIN");
    const key = columnKey(req);
    const result = await services.schema.deleteColumn(board._id, key, req.query, req.actor);
    if (!result.dryRun) await purgeFiles({ boardId: board._id, columnKey: key });
    schemaResult(res, result);
  });
  router.post("/boards/:boardId/columns/:key/type", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "WORKSPACE_ADMIN");
    schemaResult(res, await services.schema.changeType(board._id, columnKey(req), req.body, req.query, req.actor));
  });
  // Adding and renaming options: members. Removing an option (which clears values that use it): admins.
  router.put("/boards/:boardId/columns/:key/options", async (req, res) => {
    const { board, role } = await access.board(req.actor, boardId(req), "MEMBER");
    const key = columnKey(req);
    if (!Access.atLeast(role, "WORKSPACE_ADMIN")) {
      const { items } = validate.columnOptions(req.body);
      const column = board.columns.find((c) => c.key === key);
      if (column && optionsPlan(column, items).removed.size) throw forbidden("Only workspace admins can remove options.");
    }
    schemaResult(res, await services.schema.editOptions(board._id, key, req.body, req.query, req.actor));
  });
  router.delete("/boards/:boardId/groups/:groupId", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "MEMBER");
    if (!GROUP_ID.test(req.params.groupId)) fail("The group ID is not valid.");
    schemaResult(res, await services.schema.deleteGroup(board._id, req.params.groupId, req.query, req.actor));
  });
  // Moving a board needs admin rights in BOTH workspaces; the target is checked like any other workspace.
  router.post("/boards/:boardId/move", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "WORKSPACE_ADMIN");
    noQuery(req);
    const { workspaceId: target } = validate.boardMove(requireBody(req.body));
    await access.workspace(req.actor, target, "WORKSPACE_ADMIN");
    const result = await services.schema.moveBoard(board._id, req.body, req.actor);
    await services.files?.moveBoard(board._id, target);
    send(res, 200, { board: boardToApi(result.board), recordsMoved: result.records });
  });
  router.get("/boards/:boardId/activity", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "VIEWER");
    send(res, 200, { items: (await services.boards.activity(board._id, req.query)).map(activityToApi) });
  });

  router.get("/records/:recordId", async (req, res) => {
    const { record } = await access.record(req.actor, recordId(req), "VIEWER");
    noQuery(req);
    send(res, 200, { record: recordToApi(record) });
  });
  router.patch("/records/:recordId", async (req, res) => {
    const { record } = await access.record(req.actor, recordId(req), "MEMBER");
    noQuery(req);
    send(res, 200, { record: recordToApi(await services.records.update(record._id, req.body, req.actor, peopleRule(req))) });
  });
  router.delete("/records/:recordId", async (req, res) => {
    const { record } = await access.record(req.actor, recordId(req), "MEMBER");
    await services.records.delete(record._id, deleteQuery(req), req.actor);
    await purgeFiles({ recordId: record._id });
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
    send(res, 200, { items: items.map(activityToApi) });
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
