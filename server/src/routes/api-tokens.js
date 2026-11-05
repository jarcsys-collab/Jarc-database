// Managing API tokens from JARC itself (Settings → API Tokens). Mounted after the session check, so every route needs a signed-in
// session and every change needs the CSRF token (auth/session.js). Each person sees and changes only their own tokens.
//
//   GET    /me/api-tokens                what this person has issued (never the digest or the token)
//   GET    /me/api-tokens/options        the workspaces and boards they could issue a token for
//   POST   /me/api-tokens                { name, workspaceId, boardIds, scopes: ["read"], expiresAt } → the token, this once
//   POST   /me/api-tokens/:tokenId/rotate  { expiresAt?, graceHours? } → the replacement, this once
//   POST   /me/api-tokens/:tokenId/revoke
//   GET    /me/api-explorer/boards/:boardId?columns=a,b  a board's column IDs and an example response, with the caller's own access
const express = require("express");
const { allowOnly, parseId } = require("../validation/common");
const { sendError } = require("../middleware/errors");
const { searchLimiter } = require("./search");
const { columnsOf, parseColumns, projectionFor, recordToExternal, QUERY_TIME_MS } = require("./external-api");

const EXAMPLE_RECORDS = 3;

function apiTokenRoutes({ tokens, access, repos, limiter = searchLimiter({ perWindow: 20, windowMs: 60 * 60 * 1000 }), explorerLimiter = searchLimiter({ perWindow: 60, windowMs: 60 * 1000 }) }) {
  const router = express.Router();
  const send = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);
  const noQuery = (req) => allowOnly(req.query, [], "the query");
  const tokenId = (req) => parseId(req.params.tokenId, "tokenId");
  const tooMany = (res) => sendError(res, 429, "RATE_LIMITED", "Too many new tokens in the last hour. Try again later.");

  router.get("/me/api-tokens", async (req, res) => { noQuery(req); send(res, 200, { items: await tokens.list(req.actor) }); });
  router.get("/me/api-tokens/options", async (req, res) => { noQuery(req); send(res, 200, await tokens.options(req.actor)); });
  router.post("/me/api-tokens", async (req, res) => {
    noQuery(req);
    if (!limiter(req.actor.userId.toHexString())) return tooMany(res);
    send(res, 201, await tokens.create(req.actor, req.body));
  });
  router.post("/me/api-tokens/:tokenId/rotate", async (req, res) => {
    noQuery(req);
    const id = tokenId(req);
    if (!limiter(req.actor.userId.toHexString())) return tooMany(res);
    send(res, 201, await tokens.rotate(req.actor, id, req.body));
  });
  router.post("/me/api-tokens/:tokenId/revoke", async (req, res) => { noQuery(req); send(res, 200, await tokens.revoke(req.actor, tokenId(req))); });

  // API Explorer: a board's IDs and a small example, in the token API's format, under the caller's OWN session and role.
  router.get("/me/api-explorer/boards/:boardId", async (req, res) => {
    const id = parseId(req.params.boardId, "boardId");
    const { board } = await access.board(req.actor, id, "VIEWER");
    allowOnly(req.query, ["columns"], "the query");
    const selected = parseColumns(req.query.columns, board) || board.columns;
    if (!explorerLimiter(req.actor.userId.toHexString())) return sendError(res, 429, "RATE_LIMITED", "Too many requests. Wait a moment and try again.");
    const page = await repos.records.listForExternalApi(board._id, { limit: EXAMPLE_RECORDS, byUpdated: false, updatedSince: null, after: null, filter: { archived: false }, projection: projectionFor(selected), maxTimeMS: QUERY_TIME_MS });
    send(res, 200, { board: { id: board._id.toHexString(), name: board.name }, columns: columnsOf(board), example: { items: page.items.map((r) => recordToExternal(r, board, selected)), pagination: { limit: EXAMPLE_RECORDS, hasMore: page.hasMore } } });
  });
  return router;
}

module.exports = { apiTokenRoutes };
