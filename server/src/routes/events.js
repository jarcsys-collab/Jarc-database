// GET /api/v1/events — live updates as Server-Sent Events (see realtime/activity-stream.js).
//
//   auth       mounted after the session check: the HttpOnly session cookie authenticates the stream (EventSource sends
//              it automatically on the same origin). No token ever appears in the URL.
//   access     each event is sent only if its workspace is visible to this person (the same rule as GET /workspaces).
//              Access is re-read every 15 s and straight after membership or workspace changes; a deletion or removal
//              that ends someone's access is still announced to them (IDs only), so their screen can drop it.
//   session    re-checked every 30 s: an expired or signed-out session, or a disabled account, ends the stream with a
//              "session-ended" event. The stream itself never extends the session's idle time.
//   resume     ?lastEventId=<activity ID> (or the Last-Event-ID header) replays what was missed; when that isn't
//              possible (too old, too many) a "resync" event tells the browser to reload its data. A first connection
//              may send ?since=<ISO time its data load began> (at most 10 minutes ago) to get changes saved meanwhile.
//              "ready" carries the newest event ID, so even a browser that has received nothing can resume.
//
// Messages: "ready" (connected), "change" (one activity: IDs only), "resync", "session-ended"; ": ping" comments keep
// proxies from closing an idle connection.
const express = require("express");
const { ObjectId } = require("mongodb");
const { allowOnly, queryString, fail } = require("../validation/common");
const { sendError } = require("../middleware/errors");

const HEARTBEAT_MS = 20000;
const ACCESS_REFRESH_MS = 15000;
const SESSION_CHECK_MS = 30000;
const MAX_STREAMS_PER_USER = 10;
const ACCESS_ACTIONS = /^(member\.|workspace\.(created|deleted)|board\.moved)/;
// Notices that end someone's access. They are still sent for a workspace the person could see until moments ago
// (access is re-read on its own schedule and may already exclude it); they carry IDs only.
const ENDING_ACTIONS = /^(member\.removed|member\.role_changed|workspace\.deleted|board\.moved)$/;
const LOST_ACCESS_GRACE_MS = 60000;

function eventRoutes({ stream, access, repos, sessionCheck = null, timings = {} }) {
  const router = express.Router();
  const t = { heartbeat: HEARTBEAT_MS, access: ACCESS_REFRESH_MS, session: SESSION_CHECK_MS, ...timings };
  const openByUser = new Map();

  router.get("/events", async (req, res) => {
    allowOnly(req.query, ["lastEventId", "since"], "the query");
    const sinceText = queryString(req.query.since, "since");
    const since = sinceText === undefined ? null : new Date(sinceText);
    if (since && (Number.isNaN(since.getTime()) || Date.now() - since.getTime() > 10 * 60 * 1000 || since.getTime() > Date.now() + 60000)) fail("since must be a time within the last 10 minutes.");
    const lastEventId = queryString(req.query.lastEventId, "lastEventId") ?? req.get("last-event-id") ?? null;
    if (lastEventId !== null && !/^[0-9a-f]{24}$/.test(lastEventId)) fail("lastEventId is not valid.");
    const userKey = req.actor.userId.toHexString();
    if ((openByUser.get(userKey) || 0) >= MAX_STREAMS_PER_USER) return sendError(res, 429, "RATE_LIMITED", "Too many live connections are open. Close some JARC tabs and try again.");

    let roles = await access.visibleRoles(req.actor); // null = every workspace
    const lost = new Map(); // workspace ID → when this person stopped seeing it
    // Grace only for notices of changes made no later than when access was lost (the one that ended it), never later.
    const graced = (event) => { const at = lost.get(event.workspaceId); return at !== undefined && ENDING_ACTIONS.test(event.action) && Date.now() - at < LOST_ACCESS_GRACE_MS && Date.parse(event.at) <= at + 5000; };
    const visible = (event) => !event.workspaceId || roles === null || roles.has(event.workspaceId) || graced(event);
    res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders?.();
    openByUser.set(userKey, (openByUser.get(userKey) || 0) + 1);

    let closed = false, unsubscribe = null;
    const write = (text) => { if (!closed) res.write(text); };
    const send = (event, data, id) => write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const timers = [];
    const close = (reason) => {
      if (closed) return;
      if (reason === "session") send("session-ended", { reason: "Your session has ended. Sign in again." });
      closed = true;
      timers.forEach(clearInterval);
      unsubscribe?.();
      openByUser.set(userKey, Math.max(0, (openByUser.get(userKey) || 1) - 1));
      if (!openByUser.get(userKey)) openByUser.delete(userKey);
      res.end();
    };
    const refreshAccess = async () => {
      try {
        const next = await access.visibleRoles(req.actor);
        if (roles && next) for (const id of roles.keys()) if (!next.has(id)) lost.set(id, Date.now());
        for (const [id, at] of lost) if (Date.now() - at > LOST_ACCESS_GRACE_MS) lost.delete(id);
        roles = next;
      } catch { /* keep the last known access */ }
    };

    // Deliver: filter with the access known when the change happened, then re-read access if it may have changed.
    // Each event goes out at most once per connection (replay and live delivery can overlap).
    const sent = new Set();
    const emit = (event) => { if (!sent.has(event.id) && visible(event)) { sent.add(event.id); if (sent.size > 2000) sent.delete(sent.values().next().value); send("change", event, event.id); } };
    let buffered = []; // live deliveries held back while the replay is being sent
    const subscriber = {
      deliver: async (events) => {
        if (buffered) { buffered.push(...events); return; }
        events.forEach(emit);
        if (events.some((e) => ACCESS_ACTIONS.test(e.action))) await refreshAccess();
      },
      close
    };

    req.on("close", () => close("client"));
    write(`retry: 3000\n\n`);
    // Subscribe first, then replay: nothing saved in between can slip through the gap.
    unsubscribe = stream.subscribe(subscriber);
    if (lastEventId || since) {
      let missed = null;
      try { missed = lastEventId ? await stream.replaySince(new ObjectId(lastEventId)) : await stream.replayFrom(since); } catch { missed = null; } // e.g. database briefly unavailable
      if (missed === null) send("resync", { reason: "Some changes couldn't be replayed." });
      else missed.forEach(emit);
    }
    const held = buffered; buffered = null;
    held.forEach(emit);
    if (closed) return;
    const latest = await stream.latestId().catch(() => null);
    if (closed) return; // the browser left while we were reading: start no timers for a closed connection
    send("ready", { at: new Date().toISOString(), lastEventId: latest });

    timers.push(setInterval(() => write(": ping\n\n"), t.heartbeat));
    timers.push(setInterval(refreshAccess, t.access));
    if (sessionCheck) timers.push(setInterval(async () => { if (!(await sessionCheck(req).catch(() => true))) close("session"); }, t.session));
    timers.forEach((timer) => timer.unref?.());
  });
  return router;
}

// The stored session behind this request is still valid (not expired, idle or signed out; the user is active).
function entraSessionCheck({ sessions, users }) {
  return async (req) => {
    const session = await sessions.findBySecret(req.sessionSecret);
    const now = new Date();
    if (!session || session.expiresAt <= now || session.idleExpiresAt <= now) return false;
    const user = await users.findById(session.userId);
    return Boolean(user && user.status === "active");
  };
}

module.exports = { eventRoutes, entraSessionCheck };
