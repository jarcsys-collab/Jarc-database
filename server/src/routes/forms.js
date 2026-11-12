// Native forms. Mounted behind the session check like every resource route, and authorized against the stored board:
// no session → 401; not a member → 404; designing a form needs WORKSPACE_ADMIN; reading one VIEWER; submitting MEMBER,
// the same role that may create or edit a record directly. There is no unauthenticated route.
//
//   GET    /boards/:boardId/forms            GET /forms/:formId
//   POST   /boards/:boardId/forms            PATCH /forms/:formId     DELETE /forms/:formId?expectedVersion=
//   POST   /forms/:formId/submit             { submissionKey, values, recordId?, expectedVersion?, files? }
//   POST   /forms/:formId/submissions/:submissionKey/complete   the server verifies the uploaded documents
const express = require("express");
const { parseId, versionParam, allowOnly } = require("../validation/common");
const { recordToApi } = require("../api/serialize");
const { sendError, ApiError } = require("../middleware/errors");

const WINDOW_MS = 60000, PER_WINDOW = 60;
function submitLimiter({ perWindow = PER_WINDOW, windowMs = WINDOW_MS } = {}) {
  const hits = new Map();
  return (key) => {
    const now = Date.now(), list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= perWindow) { hits.set(key, list); return false; }
    list.push(now); hits.set(key, list); if (hits.size > 10000) hits.clear(); return true;
  };
}
const formToApi = (f) => ({ id: f._id.toHexString(), workspaceId: f.workspaceId.toHexString(), boardId: f.boardId.toHexString(), name: f.name, description: f.description, status: f.status, mode: f.mode, confirmation: f.confirmation, groupId: f.groupId, uniqueKey: f.uniqueKey, fields: f.fields, ...(f.schemaVersion === 2 ? { schemaVersion: 2, layout: f.layout, sections: f.sections, review: f.review, calculations: f.calculations } : {}), version: f.version, createdAt: f.createdAt.toISOString(), updatedAt: f.updatedAt.toISOString() });

function formRoutes({ services, access, limiter = submitLimiter() }) {
  const router = express.Router();
  const send = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);
  const boardId = (req) => parseId(req.params.boardId, "boardId");
  const formId = (req) => parseId(req.params.formId, "formId");
  const peopleRule = (req) => ({ everyone: access.shared || req.actor.kind === "development" });
  // The stored form's board decides access, never anything sent with the request.
  const formFor = async (req, minimum) => {
    const form = await services.forms.find(formId(req));
    if (!form) throw new ApiError(404, "NOT_FOUND", "This form doesn't exist or was deleted.");
    const { board, role } = await access.board(req.actor, form.boardId, minimum);
    return { form, board, role };
  };
  router.get("/boards/:boardId/forms", async (req, res) => {
    const { board, role } = await access.board(req.actor, boardId(req), "VIEWER");
    allowOnly(req.query, [], "the query");
    const items = await services.forms.list(board._id);
    send(res, 200, { items: items.filter((f) => f.status === "published" || access.constructor.atLeast(role, "WORKSPACE_ADMIN")).map(formToApi) });
  });
  router.post("/boards/:boardId/forms", async (req, res) => {
    const { board } = await access.board(req.actor, boardId(req), "WORKSPACE_ADMIN");
    allowOnly(req.query, [], "the query");
    send(res, 201, { form: formToApi(await services.forms.create(board, req.body, req.actor)) });
  });
  router.get("/forms/:formId", async (req, res) => {
    const { form, role } = await formFor(req, "VIEWER");
    if (form.status !== "published" && !access.constructor.atLeast(role, "WORKSPACE_ADMIN")) throw new ApiError(404, "NOT_FOUND", "This form doesn't exist or was deleted.");
    send(res, 200, { form: formToApi(form) });
  });
  router.patch("/forms/:formId", async (req, res) => {
    const { form, board } = await formFor(req, "WORKSPACE_ADMIN");
    send(res, 200, { form: formToApi(await services.forms.update(form, board, req.body, req.actor)) });
  });
  router.delete("/forms/:formId", async (req, res) => {
    const { form, board } = await formFor(req, "WORKSPACE_ADMIN");
    allowOnly(req.query, ["expectedVersion"], "the query");
    await services.forms.remove(form, board, versionParam(req.query.expectedVersion), req.actor);
    send(res, 200, { deleted: true });
  });
  router.post("/forms/:formId/submit", async (req, res) => {
    const { form, board } = await formFor(req, "MEMBER");
    allowOnly(req.query, [], "the query");
    if (!limiter(req.actor.userId.toHexString())) return sendError(res, 429, "RATE_LIMITED", "Too many submissions. Wait a moment and try again.");
    const { record, confirmation, repeated, submission } = await services.forms.submit(form, board, req.body, req.actor, peopleRule(req));
    return send(res, repeated ? 200 : 201, { record: recordToApi(record), confirmation, repeated, submission });
  });
  // After a submission's documents were uploaded (through the usual file route): the server checks what is really
  // attached and marks the submission done or incomplete. Same rights as submitting; only the submitter's own submission.
  router.post("/forms/:formId/submissions/:submissionKey/complete", async (req, res) => {
    const { form, board } = await formFor(req, "MEMBER");
    allowOnly(req.query, [], "the query");
    if (!limiter(req.actor.userId.toHexString())) return sendError(res, 429, "RATE_LIMITED", "Too many requests. Wait a moment and try again.");
    const r = await services.forms.completeFiles(form, board, req.params.submissionKey, req.actor);
    return send(res, 200, { status: r.status, files: r.files, missing: r.missing, recordId: r.recordId.toHexString() });
  });
  return router;
}

module.exports = { formRoutes, submitLimiter };
