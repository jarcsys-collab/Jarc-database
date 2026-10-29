// Account Management API (Phase M4.3). Mounted after the session check, and only when ACCOUNT_MANAGEMENT is staged or
// enforced. Everything except the bootstrap claim needs an active Super Admin account (services/account-service.js);
// Admins, Editors, Viewers, pending and blocked accounts get 403. Changes need CSRF like every other change.
//
//   GET    /accounts?q&role&status                      people who have signed in, with status, role and workspaces
//   GET    /accounts/reconciliation                     what must be reviewed before ACCOUNT_MANAGEMENT=enforced
//   GET    /accounts/:userId                            one account and its history
//   POST   /accounts/:userId/approve     { role, expectedVersion, confirm? }
//   POST   /accounts/:userId/role        { role, expectedVersion, confirm? }   (confirm "GRANT SUPER ADMIN" for SUPER_ADMIN)
//   POST   /accounts/:userId/block       { expectedVersion, confirm: "BLOCK" }
//   POST   /accounts/:userId/reactivate  { role?, expectedVersion, confirm? }
//   PUT    /accounts/:userId/workspaces/:workspaceId   { role: VIEWER | MEMBER | WORKSPACE_ADMIN }
//   DELETE /accounts/:userId/workspaces/:workspaceId
//   POST   /accounts/bootstrap           { confirm: "I AM THE SUPER ADMIN" }  the configured administrator claims the
//                                        first Super Admin role (strict identity checks; refused in production)
const express = require("express");
const { parseId, allowOnly } = require("../validation/common");
const { reconciliationReport } = require("../auth/accounts");

function accountRoutes({ services, repos }) {
  const router = express.Router();
  const accounts = services.accounts;
  const send = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);
  const userId = (req) => parseId(req.params.userId, "userId");
  const noQuery = (req) => allowOnly(req.query, [], "the query");
  const admin = (req) => accounts.requireSuperAdmin(req.actor);

  router.post("/accounts/bootstrap", async (req, res) => {
    noQuery(req);
    const session = await repos.sessions.findBySecret(req.sessionSecret);
    send(res, 200, { account: await accounts.bootstrap(req.actor, session, req.body) });
  });
  router.get("/accounts", async (req, res) => {
    admin(req);
    send(res, 200, { items: await accounts.list(req.query), mode: accounts.mode });
  });
  router.get("/accounts/reconciliation", async (req, res) => {
    admin(req); noQuery(req);
    const users = await repos.users.listEntra();
    const memberships = (await Promise.all(users.map((u) => repos.memberships.listForUser(u._id)))).flat();
    const report = reconciliationReport(users, memberships);
    send(res, 200, { summary: report.summary, readyToEnforce: report.readyToEnforce, blockers: report.blockers });
  });
  router.get("/accounts/:userId", async (req, res) => {
    admin(req); noQuery(req);
    send(res, 200, await accounts.detail(userId(req)));
  });
  for (const [path, method] of [["approve", "approve"], ["role", "changeRole"], ["block", "block"], ["reactivate", "reactivate"]]) {
    router.post(`/accounts/:userId/${path}`, async (req, res) => {
      admin(req); noQuery(req);
      send(res, 200, { account: await accounts[method](req.actor, userId(req), req.body) });
    });
  }
  router.put("/accounts/:userId/workspaces/:workspaceId", async (req, res) => {
    admin(req); noQuery(req);
    send(res, 200, await accounts.assignWorkspace(req.actor, userId(req), parseId(req.params.workspaceId, "workspaceId"), req.body, services.members));
  });
  router.delete("/accounts/:userId/workspaces/:workspaceId", async (req, res) => {
    admin(req); noQuery(req);
    send(res, 200, await accounts.removeWorkspace(req.actor, userId(req), parseId(req.params.workspaceId, "workspaceId"), services.members));
  });
  return router;
}

module.exports = { accountRoutes };
