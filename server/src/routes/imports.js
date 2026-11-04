// Excel and CSV imports (services/import-job-service.js). Same role as creating records directly: MEMBER. Only the person who
// uploaded a file, or a workspace admin, can see or control its import: others get 404.
//
//   GET  /boards/:boardId/imports                  POST /boards/:boardId/imports?name=&sheet=   (the file as the body)
//   GET  /imports/:id                              PATCH /imports/:id      settings; answers with a check that writes nothing
//   POST /imports/:id/start | pause | resume | cancel
const express = require("express");
const { parseId, allowOnly, queryString } = require("../validation/common");
const { ApiError } = require("../middleware/errors");
const { Access } = require("../auth/access");
const { LIMITS } = require("../domain/spreadsheet");

const SAMPLE_ROWS = 5;
const jobToApi = (j) => ({ id: j._id.toHexString(), boardId: j.boardId.toHexString(), status: j.status, fileName: j.fileName, kind: j.kind, sheet: j.sheet, sheets: j.sheets, headers: j.headers, rowCount: j.rowCount, mapping: j.mapping, groupId: j.groupId, groupFrom: j.groupFrom, uniqueKey: j.uniqueKey, dateOrder: j.dateOrder, previousImport: j.previousImport, imported: j.imported, skippedDuplicates: j.skippedDuplicates, rejected: j.rejected, processedBatches: j.nextBatch, batchCount: j.batchCount, errors: j.errors, lastError: j.lastError, createdAt: j.createdAt?.toISOString() ?? null, finishedAt: j.finishedAt?.toISOString() ?? null });

function importRoutes({ services, access }) {
  const router = express.Router();
  const send = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);
  const everyone = (req) => access.shared || req.actor.kind === "development";
  const jobFor = async (req) => {
    const job = await services.importJobs.find(parseId(req.params.id, "id"));
    if (!job) throw new ApiError(404, "NOT_FOUND", "This import doesn't exist or has ended.");
    const { board, role } = await access.board(req.actor, job.boardId, "MEMBER");
    if (!job.createdBy.equals(req.actor.userId) && !Access.atLeast(role, "WORKSPACE_ADMIN")) throw new ApiError(404, "NOT_FOUND", "This import doesn't exist or has ended.");
    return { job, board };
  };
  router.get("/boards/:boardId/imports", async (req, res) => {
    const { board, role } = await access.board(req.actor, parseId(req.params.boardId, "boardId"), "MEMBER");
    allowOnly(req.query, [], "the query");
    const items = await services.importJobs.list(board._id, Access.atLeast(role, "WORKSPACE_ADMIN") ? {} : { userId: req.actor.userId });
    send(res, 200, { items: items.map(jobToApi) });
  });
  router.post("/boards/:boardId/imports", express.raw({ type: () => true, limit: LIMITS.fileBytes, inflate: false }), async (req, res) => {
    const { board } = await access.board(req.actor, parseId(req.params.boardId, "boardId"), "MEMBER");
    allowOnly(req.query, ["name", "sheet"], "the query");
    if (!Buffer.isBuffer(req.body)) throw new ApiError(400, "VALIDATION_ERROR", "Send the file as the request body.");
    const job = await services.importJobs.upload(board, req.body, { name: queryString(req.query.name, "name") ?? "file", sheet: queryString(req.query.sheet, "sheet") ?? undefined }, req.actor);
    send(res, 201, { import: jobToApi(job), sample: (await services.importJobs.sample(job, SAMPLE_ROWS)) });
  });
  router.get("/imports/:id", async (req, res) => { const { job } = await jobFor(req); send(res, 200, { import: jobToApi(job) }); });
  router.patch("/imports/:id", async (req, res) => {
    const { job, board } = await jobFor(req);
    const updated = await services.importJobs.configure(job, board, req.body);
    send(res, 200, { import: jobToApi(updated), check: await services.importJobs.check(updated, board, everyone(req)) });
  });
  router.post("/imports/:id/start", async (req, res) => { const { job, board } = await jobFor(req); send(res, 200, { import: jobToApi(await services.importJobs.start(job, board, req.body, everyone(req))) }); });
  router.post("/imports/:id/pause", async (req, res) => { const { job } = await jobFor(req); send(res, 200, { import: jobToApi(await services.importJobs.pause(job)) }); });
  router.post("/imports/:id/resume", async (req, res) => { const { job } = await jobFor(req); send(res, 200, { import: jobToApi(await services.importJobs.resume(job)) }); });
  router.post("/imports/:id/cancel", async (req, res) => { const { job } = await jobFor(req); send(res, 200, { import: jobToApi(await services.importJobs.cancel(job)) }); });
  return router;
}

module.exports = { importRoutes };
