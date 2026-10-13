// monday.com integration API (see integrations/monday/service.js).
//
// Public (no JARC session; each protected by its own check):
//   GET  /integrations/monday/callback?code&state   OAuth return: the single-use server-side state identifies the
//                                                   administrator who started it; then redirects into the app
//   POST /integrations/monday/webhook/:token        events from monday.com: unguessable per-connection URL token,
//                                                   the challenge handshake, then a verified JWT on every event
// Signed in (after the session check; changes also need CSRF like every API change):
//   GET  /integrations/monday                       status (no secrets) — any signed-in person
//   JARC administrators only:
//   POST /integrations/monday/connect               → { authorizeUrl } (the browser then goes to monday.com)
//   POST /integrations/monday/disconnect | /test
//   GET  /integrations/monday/workspaces | /boards?workspaceId= | /boards/:boardId/preview
//   POST /integrations/monday/imports               { boardIds, workspaceId, confirm: true }
//   POST /integrations/monday/sync                  { syncEnabled?, paused? }
//   POST /integrations/monday/sync-now | /jobs/:jobId/retry
const express = require("express");
const { ObjectId } = require("mongodb");
const { allowOnly, queryString, fail, requireBody, isObject } = require("../validation/common");
const { sendError } = require("../middleware/errors");

function rateLimit({ perWindow, windowMs }) {
  const hits = new Map();
  return (key) => { const now = Date.now(), list = (hits.get(key) || []).filter((t) => now - t < windowMs); if (list.length >= perWindow) { hits.set(key, list); return false; } list.push(now); hits.set(key, list); if (hits.size > 10000) hits.clear(); return true; };
}

function integrationPublicRoutes({ integration }) {
  const router = express.Router();
  const webhookLimit = rateLimit({ perWindow: 600, windowMs: 60000 });
  router.get("/integrations/monday/callback", async (req, res) => {
    const back = (params) => res.redirect(303, `/?${new URLSearchParams({ integration: "monday", ...params })}#integrations`);
    try {
      if (typeof req.query.error === "string") return back({ result: "cancelled" });
      await integration.completeConnect({ code: req.query.code, state: req.query.state });
      return back({ result: "connected" });
    } catch (error) { return back({ result: "error", code: String(error?.code || "ERROR").slice(0, 40) }); }
  });
  router.post("/integrations/monday/webhook/:token", async (req, res) => {
    if (!webhookLimit(req.ip || "ip")) return sendError(res, 429, "RATE_LIMITED", "Too many requests.");
    const result = await integration.receiveWebhook({ token: req.params.token, body: isObject(req.body) ? req.body : null, authorization: req.get("authorization") });
    res.status(200).set("Cache-Control", "no-store").json(result);
  });
  return router;
}

function integrationRoutes({ integration, access }) {
  const router = express.Router();
  const send = (res, body, status = 200) => res.status(status).set("Cache-Control", "no-store").json(body);
  const admin = (req) => access.requireSystemAdmin(req.actor);
  const noQuery = (req) => allowOnly(req.query, [], "the query");
  router.get("/integrations/monday", async (req, res) => { noQuery(req); send(res, await integration.status(req.actor)); });
  router.post("/integrations/monday/connect", async (req, res) => { admin(req); noQuery(req); send(res, await integration.startConnect(req.actor)); });
  router.post("/integrations/monday/disconnect", async (req, res) => { admin(req); noQuery(req); send(res, await integration.disconnect()); });
  router.post("/integrations/monday/test", async (req, res) => { admin(req); noQuery(req); send(res, await integration.test()); });
  router.get("/integrations/monday/workspaces", async (req, res) => { admin(req); noQuery(req); send(res, { items: await integration.workspaces() }); });
  router.get("/integrations/monday/boards", async (req, res) => {
    admin(req); allowOnly(req.query, ["workspaceId"], "the query");
    const ws = queryString(req.query.workspaceId, "workspaceId");
    if (ws !== undefined && !/^\d{1,20}$/.test(ws)) fail("workspaceId must be a monday.com workspace ID.");
    send(res, { items: await integration.boards(ws ?? null) });
  });
  router.get("/integrations/monday/boards/:boardId/preview", async (req, res) => { admin(req); noQuery(req); send(res, await integration.preview(req.params.boardId)); });
  router.post("/integrations/monday/imports", async (req, res) => {
    admin(req); noQuery(req);
    const body = requireBody(req.body); allowOnly(body, ["boardIds", "workspaceId", "confirm"], "the import");
    if (typeof body.workspaceId !== "string" || !ObjectId.isValid(body.workspaceId)) fail("workspaceId must be a JARC workspace ID.");
    send(res, await integration.startImport(req.actor, { boardIds: body.boardIds, workspaceId: new ObjectId(body.workspaceId), confirm: body.confirm }), 202);
  });
  router.post("/integrations/monday/sync", async (req, res) => {
    admin(req); noQuery(req);
    const body = requireBody(req.body); allowOnly(body, ["syncEnabled", "paused"], "the sync settings");
    const set = {};
    for (const k of ["syncEnabled", "paused"]) if (body[k] !== undefined) { if (typeof body[k] !== "boolean") fail(`${k} must be true or false.`); set[k] = body[k]; }
    if (!Object.keys(set).length) fail("Nothing to change.");
    send(res, await integration.setSync(set));
  });
  router.post("/integrations/monday/sync-now", async (req, res) => { admin(req); noQuery(req); send(res, await integration.syncNow(), 202); });
  router.post("/integrations/monday/jobs/:jobId/retry", async (req, res) => {
    admin(req); noQuery(req);
    if (!ObjectId.isValid(req.params.jobId)) fail("That isn't a job ID.");
    send(res, await integration.retryJob(new ObjectId(req.params.jobId)));
  });
  return router;
}

module.exports = { integrationRoutes, integrationPublicRoutes };
