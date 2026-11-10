// Machine Installation Database attachment import (services/mid-attachment-run.js). These routes exist only while
// MID_ATTACHMENTS_MIGRATION=true, and every one of them is for Google Drive administrators only (GOOGLE_DRIVE_ADMIN_OIDS,
// checked on the server for each request; JARC.Admin alone isn't enough). Changes also need the session's CSRF token.
//
//   GET  /migrations/mid-attachments                       recent runs
//   POST /migrations/mid-attachments/dry-run               { plan, checkSources? }      read-only report
//   POST /migrations/mid-attachments/prepare               { plan, confirm: true }      creates the run (no files)
//   GET  /migrations/mid-attachments/runs/:runId           status, counts, recent failures
//   GET  /migrations/mid-attachments/runs/:runId/verify    read-only reconciliation (?sample=N re-downloads N files)
//   POST /migrations/mid-attachments/runs/:runId/start     { mode: "pilot" | "full", count?, confirm: true, backup }
//   POST /migrations/mid-attachments/runs/:runId/pause | /resume | /stop
//   POST /migrations/mid-attachments/runs/:runId/rollback  { confirm: "ROLLBACK <runId>" }
// No response carries a token, a download link or a Google Drive file ID.
const express = require("express");
const { allowOnly, requireBody, queryString, fail } = require("../validation/common");
const { ApiError } = require("../middleware/errors");

function midAttachmentRoutes({ migration, canManage }) {
  const router = express.Router();
  const base = "/migrations/mid-attachments";
  const send = (res, body, status = 200) => res.status(status).set("Cache-Control", "no-store").json(body);
  const admin = (req, query = []) => {
    allowOnly(req.query, query, "the query");
    if (!canManage(req.actor)) throw new ApiError(403, "GDRIVE_ADMIN_REQUIRED", "Only the Google Drive administrators set up for JARC can manage this import.");
  };
  const body = (req, fields) => { const b = requireBody(req.body); allowOnly(b, fields, "the request"); return b; };

  router.get(base, async (req, res) => { admin(req); send(res, { runs: await migration.list() }); });
  router.post(`${base}/dry-run`, async (req, res) => {
    admin(req);
    const b = body(req, ["plan", "checkSources"]);
    if (b.checkSources !== undefined && typeof b.checkSources !== "boolean") fail("checkSources must be true or false.");
    const { summary, rows } = await migration.check(b.plan, { checkSources: b.checkSources === true });
    send(res, { summary, rows });
  });
  router.post(`${base}/prepare`, async (req, res) => {
    admin(req);
    const b = body(req, ["plan", "confirm"]);
    if (b.confirm !== true) throw new ApiError(400, "CONFIRMATION_REQUIRED", "Confirm preparing the run.");
    send(res, await migration.prepare(b.plan, req.actor), 201);
  });
  router.get(`${base}/runs/:runId`, async (req, res) => { admin(req); send(res, await migration.status(req.params.runId)); });
  router.get(`${base}/runs/:runId/verify`, async (req, res) => {
    admin(req, ["sample"]);
    const sample = queryString(req.query.sample, "sample");
    if (sample !== undefined && !/^\d{1,2}$/.test(sample)) fail("sample must be a number from 0 to 50.");
    send(res, await migration.verify(req.params.runId, { sample: sample ? Number(sample) : 0 }));
  });
  router.post(`${base}/runs/:runId/start`, async (req, res) => {
    admin(req);
    const b = body(req, ["mode", "count", "confirm", "backup"]);
    if (b.backup !== undefined && (typeof b.backup !== "object" || b.backup === null || Array.isArray(b.backup))) fail("backup must be an object.");
    if (b.backup) allowOnly(b.backup, ["reference", "takenAt", "sha256"], "the backup");
    send(res, await migration.start(req.params.runId, b));
  });
  for (const action of ["pause", "resume", "stop"]) router.post(`${base}/runs/:runId/${action}`, async (req, res) => { admin(req); send(res, await migration[action](req.params.runId)); });
  router.post(`${base}/runs/:runId/rollback`, async (req, res) => { admin(req); const b = body(req, ["confirm"]); send(res, await migration.rollback(req.params.runId, b)); });
  return router;
}

module.exports = { midAttachmentRoutes };
