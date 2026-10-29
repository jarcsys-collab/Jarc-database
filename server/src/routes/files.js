// Files columns (see services/file-service.js). Every route authorises against the STORED record or board, like the
// rest of the resource API: viewers may list, preview and download; members may upload and remove.
//
//   GET    /boards/:boardId/attachments                 metadata of every file on a board
//   GET    /records/:recordId/attachments               metadata of one record's files (live updates)
//   POST   /records/:recordId/attachments?column=<key>  raw file body; Content-Type = the file's type, Content-Length,
//                                                       X-File-Name (URI-encoded), optional X-Upload-Key (retries)
//   GET    /attachments/:attachmentId/content           the file (?download=1 → save instead of preview)
//   DELETE /attachments/:attachmentId
//
// There are no public links: files are only served to a signed-in person who can see the record, from this origin.
const express = require("express");
const { parseId, allowOnly, queryString, fail, isSafeKey } = require("../validation/common");
const { sendError } = require("../middleware/errors");
const { attachmentToApi } = require("../api/serialize");
const { MAX_FILE_BYTES, TYPES } = require("../files/file-types");

const INLINE_TYPES = new Set(Object.keys(TYPES)); // PDF, JPEG, PNG, WebP: the types normal uploads accept

const UPLOADS_PER_WINDOW = 60;
const WINDOW_MS = 10 * 60 * 1000;
const CONCURRENT_PER_USER = 4;
const CONCURRENT_TOTAL = 16;

// In-memory upload limits (one server instance): per person, uploads per 10 minutes and at once; and at once overall.
function uploadLimiter({ perWindow = UPLOADS_PER_WINDOW, windowMs = WINDOW_MS, perUser = CONCURRENT_PER_USER, total = CONCURRENT_TOTAL } = {}) {
  const recent = new Map(), active = new Map();
  let running = 0;
  return {
    acquire(userKey) {
      const now = Date.now();
      const times = (recent.get(userKey) || []).filter((t) => now - t < windowMs);
      if (times.length >= perWindow) return "Too many uploads. Wait a few minutes and try again.";
      if ((active.get(userKey) || 0) >= perUser || running >= total) return "Too many uploads are running. Wait for them to finish and try again.";
      times.push(now); recent.set(userKey, times);
      active.set(userKey, (active.get(userKey) || 0) + 1); running += 1;
      let released = false;
      return () => { if (released) return; released = true; running -= 1; const n = (active.get(userKey) || 1) - 1; if (n) active.set(userKey, n); else active.delete(userKey); };
    }
  };
}

// Content-Disposition with a plain-ASCII fallback and the exact name (RFC 6266 / 5987).
const disposition = (kind, name) => `${kind}; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

function fileRoutes({ services, access, limiter = uploadLimiter() }) {
  const router = express.Router();
  const send = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);
  const files = services.files;

  router.get("/boards/:boardId/attachments", async (req, res) => {
    const { board } = await access.board(req.actor, parseId(req.params.boardId, "boardId"), "VIEWER");
    allowOnly(req.query, [], "the query");
    send(res, 200, { items: (await files.listByBoard(board._id)).map(attachmentToApi) });
  });
  router.get("/records/:recordId/attachments", async (req, res) => {
    const { record } = await access.record(req.actor, parseId(req.params.recordId, "recordId"), "VIEWER");
    allowOnly(req.query, [], "the query");
    send(res, 200, { items: (await files.listByRecord(record._id)).map(attachmentToApi) });
  });

  router.post("/records/:recordId/attachments", async (req, res) => {
    const { record } = await access.record(req.actor, parseId(req.params.recordId, "recordId"), "MEMBER");
    allowOnly(req.query, ["column"], "the query");
    const columnKey = queryString(req.query.column, "column");
    if (!columnKey || !isSafeKey(columnKey)) fail("column must name a Files column.");
    // Anything refused before or during reading: answer straight away and don't read the rest of the file.
    // Up to 10 MB is read and discarded so the browser reliably gets the answer; anything larger closes the connection.
    const length = req.get("content-length") === undefined ? NaN : Number(req.get("content-length"));
    const refuse = () => { if (!req.complete) { if (!(length <= MAX_FILE_BYTES)) res.set("Connection", "close"); req.resume(); } };
    const board = await services.records.board(record.boardId);
    if (board.source?.readOnly) { refuse(); return sendError(res, 403, "READ_ONLY_BOARD", "This board is synchronized from monday.com and is read-only in JARC."); }
    const plan = await files.prepare({ record, board, columnKey, type: String(req.get("content-type") || "").split(";")[0].trim().toLowerCase(), name: req.get("x-file-name"), length, uploadKey: req.get("x-upload-key") ?? null }).catch((error) => { refuse(); throw error; });
    if (plan.existing) { req.resume(); return send(res, 200, { attachment: attachmentToApi(plan.existing), repeated: true }); }
    const release = limiter.acquire(req.actor.userId.toHexString());
    if (typeof release === "string") { refuse(); return sendError(res, 429, "RATE_LIMITED", release); }
    try {
      const attachment = await files.upload({ record, board, columnKey, plan, source: req, actor: req.actor });
      send(res, 201, { attachment: attachmentToApi(attachment) });
    } catch (error) {
      refuse();
      throw error;
    } finally { release(); }
  });

  router.get("/attachments/:attachmentId/content", async (req, res) => {
    allowOnly(req.query, ["download"], "the query");
    const download = queryString(req.query.download, "download");
    if (download !== undefined && download !== "1") fail("download must be 1.");
    const attachment = await files.get(parseId(req.params.attachmentId, "attachmentId"));
    await access.record(req.actor, attachment.recordId, "VIEWER");
    const etag = `"${attachment.sha256}"`;
    // Types that may be shown in the page; anything else (e.g. migrated CSV/HEIC) is always a download.
    const inline = !download && INLINE_TYPES.has(attachment.type);
    res.set({
      "Content-Type": INLINE_TYPES.has(attachment.type) ? attachment.type : "application/octet-stream",
      "Content-Disposition": disposition(inline ? "inline" : "attachment", attachment.name),
      "Cache-Control": "private, no-cache", ETag: etag,
      "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin", "X-Frame-Options": "SAMEORIGIN",
      // Nothing in a served file may load or run anything. PDFs need object-src for the browser's built-in viewer.
      "Content-Security-Policy": attachment.type === "application/pdf" ? "default-src 'none'; object-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'" : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox"
    });
    if (req.get("if-none-match") === etag) return res.status(304).end();
    const stream = services.files.openDownload(attachment);
    stream.on("error", () => { if (!res.headersSent) sendError(res, 404, "NOT_FOUND", "This file's contents are missing."); else res.destroy(); });
    res.status(200).set("Content-Length", String(attachment.size));
    stream.pipe(res);
    res.on("close", () => stream.destroy());
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    allowOnly(req.query, [], "the query");
    const attachment = await files.get(parseId(req.params.attachmentId, "attachmentId"));
    await access.record(req.actor, attachment.recordId, "MEMBER");
    if ((await services.records.board(attachment.boardId)).source?.readOnly) return sendError(res, 403, "READ_ONLY_BOARD", "This board is synchronized from monday.com and is read-only in JARC.");
    await files.remove(attachment, req.actor);
    send(res, 200, { deleted: true });
  });
  return router;
}

module.exports = { fileRoutes, uploadLimiter };
