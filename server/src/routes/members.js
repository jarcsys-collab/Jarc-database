// Workspace membership management. Viewing members: any member. Adding, changing roles and removing: WORKSPACE_ADMIN
// (or SYSTEM_ADMIN). A workspace always keeps at least one admin (services/membership-service.js).
const express = require("express");
const { parseId, allowOnly } = require("../validation/common");
const { memberToApi } = require("../api/serialize");

function memberRoutes({ services, access }) {
  const router = express.Router();
  const send = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);
  const workspaceId = (req) => parseId(req.params.workspaceId, "workspaceId");
  const noQuery = (req) => allowOnly(req.query, [], "the query");

  router.get("/workspaces/:workspaceId/members", async (req, res) => {
    const { workspace } = await access.workspace(req.actor, workspaceId(req), "VIEWER");
    noQuery(req);
    send(res, 200, { items: (await services.members.list(workspace._id)).map(memberToApi) });
  });
  router.post("/workspaces/:workspaceId/members", async (req, res) => {
    const { workspace } = await access.workspace(req.actor, workspaceId(req), "WORKSPACE_ADMIN");
    noQuery(req);
    send(res, 201, { member: memberToApi(await services.members.add(workspace._id, req.body, req.actor)) });
  });
  router.patch("/workspaces/:workspaceId/members/:memberId", async (req, res) => {
    const { workspace } = await access.workspace(req.actor, workspaceId(req), "WORKSPACE_ADMIN");
    noQuery(req);
    const member = await services.members.changeRole(workspace._id, parseId(req.params.memberId, "memberId"), req.body, req.actor);
    send(res, 200, { member: memberToApi(member) });
  });
  router.delete("/workspaces/:workspaceId/members/:memberId", async (req, res) => {
    const { workspace } = await access.workspace(req.actor, workspaceId(req), "WORKSPACE_ADMIN");
    noQuery(req);
    send(res, 200, await services.members.remove(workspace._id, parseId(req.params.memberId, "memberId"), req.actor));
  });
  return router;
}

module.exports = { memberRoutes };
