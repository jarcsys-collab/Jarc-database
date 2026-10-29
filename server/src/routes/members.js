// Workspace membership management. Viewing members: any member. Adding, changing roles and removing: WORKSPACE_ADMIN
// (or SYSTEM_ADMIN). A workspace always keeps at least one admin (services/membership-service.js).
// Changes need a real membership even under ACCESS_POLICY=development_shared (see auth/access.js).
// ACCOUNT_MANAGEMENT=enforced: only approved (or legacy) accounts can be added, and never with a role above what their
// global account role allows (an Admin can't make an Editor a workspace admin, or a Viewer an editor).
const express = require("express");
const { parseId, allowOnly, isObject, fail } = require("../validation/common");
const { memberToApi } = require("../api/serialize");
const { accountOf, WORKSPACE_CAP, WORKSPACE_RANK } = require("../auth/accounts");

const MEMBERSHIP_ONLY = Object.freeze({ membershipOnly: true });

function memberRoutes({ services, access, repos }) {
  const router = express.Router();
  // The person being given a role (enforced accounts only).
  const assignable = async (user, role) => {
    if (!access.enforced || !user || !Object.prototype.hasOwnProperty.call(WORKSPACE_RANK, role)) return;
    const account = accountOf(user);
    if (account.legacy) return;
    if (account.status !== "active") fail("This person's JARC account isn't approved yet.");
    if (WORKSPACE_RANK[role] > WORKSPACE_RANK[WORKSPACE_CAP[account.role]]) fail(`A ${account.role} account can be at most ${WORKSPACE_CAP[account.role]} in a workspace.`);
  };
  const targetOf = async (body) => {
    if (!access.enforced || !isObject(body)) return null;
    if (typeof body.userId === "string" && /^[0-9a-f]{24}$/.test(body.userId)) return repos.users.findById(parseId(body.userId, "userId"));
    if (typeof body.email === "string") return repos.users.findByEmail(body.email);
    return null;
  };
  const send = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);
  const workspaceId = (req) => parseId(req.params.workspaceId, "workspaceId");
  const noQuery = (req) => allowOnly(req.query, [], "the query");

  router.get("/workspaces/:workspaceId/members", async (req, res) => {
    const { workspace } = await access.workspace(req.actor, workspaceId(req), "VIEWER");
    noQuery(req);
    send(res, 200, { items: (await services.members.list(workspace._id)).map(memberToApi) });
  });
  router.post("/workspaces/:workspaceId/members", async (req, res) => {
    const { workspace } = await access.workspace(req.actor, workspaceId(req), "WORKSPACE_ADMIN", MEMBERSHIP_ONLY);
    noQuery(req);
    await assignable(await targetOf(req.body), isObject(req.body) ? req.body.role : undefined);
    send(res, 201, { member: memberToApi(await services.members.add(workspace._id, req.body, req.actor)) });
  });
  router.patch("/workspaces/:workspaceId/members/:memberId", async (req, res) => {
    const { workspace } = await access.workspace(req.actor, workspaceId(req), "WORKSPACE_ADMIN", MEMBERSHIP_ONLY);
    noQuery(req);
    if (access.enforced) {
      const current = await repos.memberships.findById(parseId(req.params.memberId, "memberId"));
      if (current && current.workspaceId.equals(workspace._id)) await assignable(await repos.users.findById(current.userId), isObject(req.body) ? req.body.role : undefined);
    }
    const member = await services.members.changeRole(workspace._id, parseId(req.params.memberId, "memberId"), req.body, req.actor);
    send(res, 200, { member: memberToApi(member) });
  });
  router.delete("/workspaces/:workspaceId/members/:memberId", async (req, res) => {
    const { workspace } = await access.workspace(req.actor, workspaceId(req), "WORKSPACE_ADMIN", MEMBERSHIP_ONLY);
    noQuery(req);
    send(res, 200, await services.members.remove(workspace._id, parseId(req.params.memberId, "memberId"), req.actor));
  });
  return router;
}

module.exports = { memberRoutes };
