// Google Drive attachment storage: connection management (see integrations/google-drive/service.js). These routes exist
// only while GOOGLE_DRIVE_ENABLED=true.
//
// Public (no JARC session: the Strict session cookie isn't sent on a redirect from Google):
//   GET  /integrations/google-drive/callback?code&state   protected by the single-use state and a browser-bound cookie;
//                                                         re-checks the administrator; then redirects into the app
// JARC administrators only (session, plus CSRF on changes):
//   GET  /integrations/google-drive                       status, without secrets
//   POST /integrations/google-drive/connect               → { authorizeUrl } (the browser then goes to Google)
//   POST /integrations/google-drive/disconnect | /test
const express = require("express");
const { allowOnly, requireBody } = require("../validation/common");
const { ApiError } = require("../middleware/errors");
const { readCookie, clearCookie } = require("../auth/session");
const { rateLimit } = require("./integrations");

// Lax, unlike JARC's other cookies, so that it returns on the redirect from Google. It only proves which browser started
// the connection; it gives no access to anything by itself.
const OAUTH_COOKIE = "__Host-jarc_gdrive_oauth";
const OAUTH_COOKIE_SECONDS = 10 * 60;
const browserCookie = (value) => `${OAUTH_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_COOKIE_SECONDS}`;

function googleDrivePublicRoutes({ drive, stillAdmin, logger = console }) {
  const router = express.Router();
  const limit = rateLimit({ perWindow: 60, windowMs: 10 * 60 * 1000 });
  router.get("/integrations/google-drive/callback", async (req, res) => {
    const back = (params) => {
      // The code must not stay in the address bar, or be passed on in a Referer.
      res.append("Set-Cookie", clearCookie(OAUTH_COOKIE)).set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      return res.redirect(303, `/?${new URLSearchParams({ integration: "google-drive", ...params })}#integrations`);
    };
    if (!limit(req.ip || "ip")) return back({ result: "error", code: "RATE_LIMITED" });
    try {
      const done = await drive.completeConnect({ code: req.query.code, state: req.query.state, error: typeof req.query.error === "string" ? req.query.error : undefined, browserSecret: readCookie(req, OAUTH_COOKIE), stillAdmin });
      return back({ result: done.cancelled ? "cancelled" : "connected" });
    } catch (error) {
      const code = String(error?.code || "ERROR").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40);
      logger.error(`[google-drive] connection not completed: ${code}`);
      return back({ result: "error", code });
    }
  });
  return router;
}

function googleDriveRoutes({ drive, access }) {
  const router = express.Router();
  const send = (res, body, status = 200) => res.status(status).set("Cache-Control", "no-store").json(body);
  const admin = (req) => { access.requireSystemAdmin(req.actor); allowOnly(req.query, [], "the query"); };
  router.get("/integrations/google-drive", async (req, res) => { admin(req); send(res, await drive.status()); });
  router.post("/integrations/google-drive/connect", async (req, res) => {
    admin(req);
    const { authorizeUrl, browserSecret } = await drive.startConnect(req.actor);
    res.append("Set-Cookie", browserCookie(browserSecret));
    send(res, { authorizeUrl });
  });
  router.post("/integrations/google-drive/disconnect", async (req, res) => {
    admin(req);
    const body = requireBody(req.body); allowOnly(body, ["confirm"], "the request");
    if (body.confirm !== true) throw new ApiError(400, "CONFIRMATION_REQUIRED", "Confirm disconnecting first.");
    send(res, await drive.disconnect());
  });
  router.post("/integrations/google-drive/test", async (req, res) => { admin(req); send(res, await drive.test()); });
  return router;
}

module.exports = { googleDriveRoutes, googleDrivePublicRoutes, OAUTH_COOKIE };
