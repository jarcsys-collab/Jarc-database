// Resource API (Stage 10) — DEVELOPMENT / PRE-AUTH ONLY.
//
// These endpoints have no authentication or authorization yet. They are mounted only when NODE_ENV is not
// production and DATA_STORE=mongodb, and every request is attributed to the fixed development actor. Production
// access waits for Microsoft Entra sign-in and per-workspace permissions (later stage).
//
// Responses use `id` (string), never `_id`, and ISO 8601 dates. Single resources are wrapped ({ workspace },
// { board }, { record }); lists are { items } (records add nextCursor and limit).
const express = require("express");
const { parseId, versionParam, allowOnly, queryString, fail, isSafeKey } = require("../validation/common");
const { GROUP_ID } = require("../domain/board-schema");
const { workspaceToApi, boardToApi, recordToApi, activityToApi } = require("../api/serialize");

function resourceRoutes({ services }) {
  const router = express.Router();
  const send = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);
  const deleteQuery = (req) => { allowOnly(req.query, ["expectedVersion"], "the query"); return versionParam(req.query.expectedVersion); };
  const noQuery = (req) => allowOnly(req.query, [], "the query");

  // ---- Workspaces
  router.get("/workspaces", async (req, res) => { noQuery(req); send(res, 200, { items: (await services.workspaces.list()).map(workspaceToApi) }); });
  router.post("/workspaces", async (req, res) => { noQuery(req); send(res, 201, { workspace: workspaceToApi(await services.workspaces.create(req.body, req.actor)) }); });
  router.get("/workspaces/:workspaceId", async (req, res) => { noQuery(req); send(res, 200, { workspace: workspaceToApi(await services.workspaces.get(parseId(req.params.workspaceId, "workspaceId"))) }); });
  router.patch("/workspaces/:workspaceId", async (req, res) => { noQuery(req); send(res, 200, { workspace: workspaceToApi(await services.workspaces.update(parseId(req.params.workspaceId, "workspaceId"), req.body, req.actor)) }); });
  router.delete("/workspaces/:workspaceId", async (req, res) => {
    const id = parseId(req.params.workspaceId, "workspaceId");
    send(res, 200, { deleted: true, removed: await services.workspaces.delete(id, deleteQuery(req), req.actor) });
  });

  // ---- Boards
  router.get("/workspaces/:workspaceId/boards", async (req, res) => { noQuery(req); send(res, 200, { items: (await services.boards.listByWorkspace(parseId(req.params.workspaceId, "workspaceId"))).map(boardToApi) }); });
  router.post("/workspaces/:workspaceId/boards", async (req, res) => { noQuery(req); send(res, 201, { board: boardToApi(await services.boards.create(parseId(req.params.workspaceId, "workspaceId"), req.body, req.actor)) }); });
  router.get("/boards/:boardId", async (req, res) => { noQuery(req); send(res, 200, { board: boardToApi(await services.boards.get(parseId(req.params.boardId, "boardId"))) }); });
  router.patch("/boards/:boardId", async (req, res) => { noQuery(req); send(res, 200, { board: boardToApi(await services.boards.update(parseId(req.params.boardId, "boardId"), req.body, req.actor)) }); });
  router.delete("/boards/:boardId", async (req, res) => {
    const id = parseId(req.params.boardId, "boardId");
    send(res, 200, { deleted: true, removed: await services.boards.delete(id, deleteQuery(req), req.actor) });
  });

  // ---- Records
  router.get("/boards/:boardId/records", async (req, res) => {
    const page = await services.records.list(parseId(req.params.boardId, "boardId"), req.query);
    send(res, 200, { items: page.items.map(recordToApi), nextCursor: page.nextCursor, limit: page.limit });
  });
  router.post("/boards/:boardId/records", async (req, res) => { noQuery(req); send(res, 201, { record: recordToApi(await services.records.create(parseId(req.params.boardId, "boardId"), req.body, req.actor)) }); });
  // Batches (Stage 11), each one transaction: CSV import / multi-create, bulk edits and reorders, multi-delete.
  router.post("/boards/:boardId/records/batch", async (req, res) => { noQuery(req); send(res, 201, { items: (await services.records.createMany(parseId(req.params.boardId, "boardId"), req.body, req.actor)).map(recordToApi) }); });
  router.patch("/boards/:boardId/records", async (req, res) => { noQuery(req); send(res, 200, { items: (await services.records.updateMany(parseId(req.params.boardId, "boardId"), req.body, req.actor)).map(recordToApi) }); });
  router.post("/boards/:boardId/records/delete", async (req, res) => { noQuery(req); send(res, 200, await services.records.deleteMany(parseId(req.params.boardId, "boardId"), req.body, req.actor)); });

  // ---- Board schema changes that rewrite record values (Stage 11). Each is one transaction; ?dryRun=true → { affected }.
  const columnKey = (req) => { if (!isSafeKey(req.params.key)) fail("The column key is not valid."); return req.params.key; };
  const schemaResult = (res, result) => send(res, 200, result.dryRun ? result : { board: boardToApi(result.board), affected: result.affected, recordsChanged: result.recordsChanged });
  router.post("/boards/:boardId/columns", async (req, res) => { noQuery(req); const result = await services.schema.addColumn(parseId(req.params.boardId, "boardId"), req.body, req.actor); send(res, 201, { board: boardToApi(result.board), recordsChanged: result.recordsChanged }); });
  router.delete("/boards/:boardId/columns/:key", async (req, res) => schemaResult(res, await services.schema.deleteColumn(parseId(req.params.boardId, "boardId"), columnKey(req), req.query, req.actor)));
  router.post("/boards/:boardId/columns/:key/type", async (req, res) => schemaResult(res, await services.schema.changeType(parseId(req.params.boardId, "boardId"), columnKey(req), req.body, req.query, req.actor)));
  router.put("/boards/:boardId/columns/:key/options", async (req, res) => schemaResult(res, await services.schema.editOptions(parseId(req.params.boardId, "boardId"), columnKey(req), req.body, req.query, req.actor)));
  router.delete("/boards/:boardId/groups/:groupId", async (req, res) => {
    if (!GROUP_ID.test(req.params.groupId)) fail("The group ID is not valid.");
    schemaResult(res, await services.schema.deleteGroup(parseId(req.params.boardId, "boardId"), req.params.groupId, req.query, req.actor));
  });
  router.post("/boards/:boardId/move", async (req, res) => { noQuery(req); const result = await services.schema.moveBoard(parseId(req.params.boardId, "boardId"), req.body, req.actor); send(res, 200, { board: boardToApi(result.board), recordsMoved: result.records }); });
  router.get("/boards/:boardId/activity", async (req, res) => { send(res, 200, { items: (await services.boards.activity(parseId(req.params.boardId, "boardId"), req.query)).map(activityToApi) }); });

  router.get("/records/:recordId", async (req, res) => { noQuery(req); send(res, 200, { record: recordToApi(await services.records.get(parseId(req.params.recordId, "recordId"))) }); });
  router.patch("/records/:recordId", async (req, res) => { noQuery(req); send(res, 200, { record: recordToApi(await services.records.update(parseId(req.params.recordId, "recordId"), req.body, req.actor)) }); });
  router.delete("/records/:recordId", async (req, res) => {
    const id = parseId(req.params.recordId, "recordId");
    await services.records.delete(id, deleteQuery(req), req.actor);
    send(res, 200, { deleted: true });
  });

  // ---- Development migration: legacy state document or browser backup → MongoDB. ?dryRun=true reports only.
  router.post("/imports", async (req, res) => {
    allowOnly(req.query, ["dryRun"], "the query");
    const dryRun = queryString(req.query.dryRun, "dryRun") ?? "false";
    if (!["true", "false"].includes(dryRun)) fail("dryRun must be true or false.");
    const result = await services.imports.run(req.body, { dryRun: dryRun === "true", actor: req.actor });
    send(res, result.dryRun ? 200 : 201, result);
  });

  return router;
}

module.exports = { resourceRoutes };
