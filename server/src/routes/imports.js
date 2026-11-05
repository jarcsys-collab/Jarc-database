// Excel and CSV imports into a NEW board (services/import-job-service.js). JARC's usual rules decide who may import: a signed-in session and the
// MEMBER role in the workspace, the same as creating a board. Only the person who uploaded a file, or a workspace admin, can see or control its
// import: others get 404. Importing into a board that already exists is refused until a safe undo exists.
//
//   GET  /workspaces/:workspaceId/imports          POST /workspaces/:workspaceId/imports?name=&sheet=   (the file as the body)
//   GET  /imports/:id                              PATCH /imports/:id    decisions and columns; answers with the check of every row
//   GET  /imports/:id/report                       the problems found, as a CSV
//   POST /imports/:id/start | pause | resume | cancel | remove-board
const express = require("express");
const { parseId, allowOnly, queryString } = require("../validation/common");
const { ApiError } = require("../middleware/errors");
const { Access } = require("../auth/access");
const { LIMITS } = require("../domain/spreadsheet");

const jobToApi = (j) => ({
  id: j._id.toHexString(), target: j.target || "existing-board", workspaceId: j.workspaceId?.toHexString() ?? null, boardId: j.boardId?.toHexString() ?? null, plannedBoardId: j.plannedBoardId?.toHexString() ?? null, boardName: j.boardName ?? null,
  status: j.status, fileName: j.fileName, kind: j.kind, sheet: j.sheet, sheets: j.sheets, rowCount: j.rowCount, structure: j.structure ?? null, structureConfirmed: Boolean(j.structureConfirmed), columns: j.columns ?? [], itemColumn: j.itemColumn ?? null, uniqueColumn: j.uniqueColumn ?? null, dateOrder: j.dateOrder,
  validation: j.validation ?? null, previousImport: j.previousImport, imported: j.imported, skippedDuplicates: j.skippedDuplicates, rejected: j.rejected, removedRecords: j.removedRecords ?? 0, processedBatches: j.nextBatch, batchCount: j.batchCount, errors: j.errors, lastError: j.lastError, createdAt: j.createdAt?.toISOString() ?? null, finishedAt: j.finishedAt?.toISOString() ?? null
});

function importRoutes({ services, access }) {
  const router = express.Router();
  const send = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);
  // Before a file is read, so someone without the role can't make the server read one.
  const member = async (req, res, next) => { try { await access.workspace(req.actor, parseId(req.params.workspaceId, "workspaceId"), "MEMBER"); next(); } catch (error) { next(error); } };
  const jobFor = async (req) => {
    const job = await services.importJobs.find(parseId(req.params.id, "id"));
    if (!job || job.target !== "new-board") throw new ApiError(404, "NOT_FOUND", "This import doesn't exist or has ended.");
    const { role } = await access.workspace(req.actor, job.workspaceId, "MEMBER");
    if (!job.createdBy.equals(req.actor.userId) && !Access.atLeast(role, "WORKSPACE_ADMIN")) throw new ApiError(404, "NOT_FOUND", "This import doesn't exist or has ended.");
    return job;
  };
  router.all(["/boards/:boardId/imports", "/boards/:boardId/imports/*rest"], () => { throw new ApiError(403, "IMPORT_NEW_BOARDS_ONLY", "Files can only be imported into a new board for now, so existing boards can't be affected."); });
  router.get("/workspaces/:workspaceId/imports", async (req, res) => {
    const { workspace, role } = await access.workspace(req.actor, parseId(req.params.workspaceId, "workspaceId"), "MEMBER");
    allowOnly(req.query, [], "the query");
    send(res, 200, { items: (await services.importJobs.listForWorkspace(workspace._id, Access.atLeast(role, "WORKSPACE_ADMIN") ? {} : { userId: req.actor.userId })).map(jobToApi) });
  });
  router.post("/workspaces/:workspaceId/imports", member, express.raw({ type: () => true, limit: LIMITS.fileBytes, inflate: false }), async (req, res) => {
    const { workspace } = await access.workspace(req.actor, parseId(req.params.workspaceId, "workspaceId"), "MEMBER");
    allowOnly(req.query, ["name", "sheet"], "the query");
    if (!Buffer.isBuffer(req.body)) throw new ApiError(400, "VALIDATION_ERROR", "Send the file as the request body.");
    const job = await services.importJobs.createFromFile(workspace, req.body, { name: queryString(req.query.name, "name") ?? "file", sheet: queryString(req.query.sheet, "sheet") ?? undefined }, req.actor);
    send(res, 201, { import: jobToApi(job) });
  });
  router.get("/imports/:id", async (req, res) => send(res, 200, { import: jobToApi(await jobFor(req)) }));
  router.patch("/imports/:id", async (req, res) => send(res, 200, { import: jobToApi(await services.importJobs.review(await jobFor(req), req.body)) }));
  router.get("/imports/:id/report", async (req, res) => {
    const job = await jobFor(req), name = `${job.fileName.replace(/[^\w.-]+/g, "_").replace(/\.[a-z0-9]+$/i, "")}-problems.csv`;
    res.status(200).set({ "Cache-Control": "no-store", "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` }).send(`﻿${services.importJobs.reportCsv(job)}`);
  });
  router.post("/imports/:id/start", async (req, res) => send(res, 200, { import: jobToApi(await services.importJobs.startNewBoard(await jobFor(req), req.body)) }));
  router.post("/imports/:id/pause", async (req, res) => send(res, 200, { import: jobToApi(await services.importJobs.pause(await jobFor(req))) }));
  router.post("/imports/:id/resume", async (req, res) => send(res, 200, { import: jobToApi(await services.importJobs.resume(await jobFor(req))) }));
  router.post("/imports/:id/cancel", async (req, res) => send(res, 200, { import: jobToApi(await services.importJobs.cancel(await jobFor(req))) }));
  router.post("/imports/:id/remove-board", async (req, res) => {
    const job = await jobFor(req);
    await access.workspace(req.actor, job.workspaceId, "MEMBER");
    const { job: started } = await services.importJobs.cleanUp(job, req.actor);
    send(res, 200, { import: jobToApi(started) });
  });
  return router;
}

module.exports = { importRoutes };
