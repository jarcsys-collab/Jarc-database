// Files columns: attachments on records (PDF, JPEG, PNG, WebP).
//
//   bytes      in the file store (production: GridFS in jarc_database, see files/file-store.js), streamed in and out —
//              never written to the server's disk and never held whole in memory.
//   metadata   one attachments document per file (name, type, size, SHA-256, uploader, column, record, board,
//              workspace). The record itself is never changed by an upload or removal, so attachments can't overwrite
//              other fields or collide with someone's edit (no record version is involved).
//   checks     the type is recognised from the file's first bytes (its signature) and must match the declared type;
//              size ≤ 10 MB (Content-Length required, and counted while streaming); ≤ 20 files per cell; a total
//              storage cap (ATTACHMENTS_MAX_TOTAL_MB) so the database can never be filled by uploads.
//   lifecycle  an upload is "pending" until its bytes are stored, then "ready"; only ready files are listed or served.
//              Failed or interrupted uploads are removed straight away, and the sweep removes anything left behind
//              (stale pending uploads, stored bytes without metadata, files of deleted records, boards or columns).
//   retries    the browser sends an upload key; repeating an upload with the same key returns the first result
//              instead of storing the file twice.
const crypto = require("crypto");
const { Transform } = require("stream");
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { redact } = require("../db/connection");
const { TYPES, MAX_FILE_BYTES, MAX_FILES_PER_CELL, SNIFF_BYTES, cleanFileName } = require("../files/file-types");
const { activityEntry, appendActivity } = require("./shared");

const PENDING_MAX_AGE_MS = 60 * 60 * 1000; // an upload still pending after an hour was interrupted
const DEFAULT_MAX_TOTAL_BYTES = 300 * 1024 * 1024;
const UPLOAD_KEY = /^[A-Za-z0-9_-]{8,64}$/;

const tooLarge = () => new ApiError(413, "PAYLOAD_TOO_LARGE", `Files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
const wrongType = () => new ApiError(415, "UNSUPPORTED_FILE_TYPE", "Only PDF, JPEG, PNG and WebP files can be uploaded, and the file's contents must match its type.");
const incomplete = () => new ApiError(400, "UPLOAD_INCOMPLETE", "The upload didn't finish. Try again.");

class FileService {
  constructor({ repos, store, logger = console, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES, now = () => new Date() }) {
    Object.assign(this, { repos, store, logger, maxTotalBytes, now });
  }

  column(board, key) {
    const column = board.columns.find((c) => c.key === key);
    if (!column || column.type !== "files") throw new ApiError(404, "NOT_FOUND", "This board has no such Files column.");
    return column;
  }

  listByBoard(boardId) { return this.repos.attachments.listByBoard(boardId); }
  listByRecord(recordId) { return this.repos.attachments.listByRecord(recordId); }

  // A ready attachment, or 404 (also for pending or removed ones).
  async get(id) {
    const attachment = await this.repos.attachments.findReady(id);
    if (!attachment) throw new ApiError(404, "NOT_FOUND", "This file doesn't exist or was removed.");
    return attachment;
  }

  // Checks that need no file contents; run before anything is read or stored. Returns the cleaned upload details,
  // or { existing } when this exact upload (same key) already succeeded.
  async prepare({ record, board, columnKey, type, name, length, uploadKey }) {
    this.column(board, columnKey);
    if (!TYPES[type]) throw wrongType();
    if (!Number.isSafeInteger(length) || length < 1) throw new ApiError(411, "LENGTH_REQUIRED", "The file's size must be sent with the upload.");
    if (length > MAX_FILE_BYTES) throw tooLarge();
    const fileName = cleanFileName(name, type);
    if (!fileName) throw new ApiError(400, "VALIDATION_ERROR", "The file needs a name.");
    if (uploadKey !== null && !UPLOAD_KEY.test(uploadKey)) throw new ApiError(400, "VALIDATION_ERROR", "The upload key is not valid.");
    if (uploadKey) {
      const existing = await this.repos.attachments.findByUploadKey(record._id, uploadKey);
      if (existing) return { existing };
    }
    if (await this.repos.attachments.countForCell(record._id, columnKey) >= MAX_FILES_PER_CELL) throw new ApiError(409, "TOO_MANY_FILES", `A cell can hold at most ${MAX_FILES_PER_CELL} files. Remove one first.`);
    if (await this.repos.attachments.totalBytes() + length > this.maxTotalBytes) throw new ApiError(507, "STORAGE_FULL", "JARC's file storage is full. Ask an administrator to free up space.");
    return { fileName, type, length, uploadKey };
  }

  // Streams one upload into the store. `source` is the request body. Every failure removes what was stored.
  async upload({ record, board, columnKey, plan, source, actor }) {
    const id = new ObjectId();
    const now = this.now();
    try {
      await this.repos.attachments.insertPending({
        _id: id, workspaceId: board.workspaceId, boardId: board._id, recordId: record._id, columnKey, name: plan.fileName, type: plan.type,
        size: plan.length, ...(plan.uploadKey ? { uploadKey: plan.uploadKey } : {}), uploadedBy: actor.userId, uploadedByName: actor.displayName || null, createdAt: now
      });
    } catch (error) {
      if (error?.code === 11000) throw new ApiError(409, "UPLOAD_IN_PROGRESS", "This file is already being uploaded.");
      throw error;
    }
    let sha256;
    try {
      ({ sha256 } = await this.receive(id, plan, source));
      // The record, or its column, may have gone while the file was arriving.
      const current = await this.repos.records.findById(record._id);
      const currentBoard = current && await this.repos.boards.findById(current.boardId);
      if (!current || !currentBoard?.columns.some((c) => c.key === columnKey && c.type === "files")) throw new ApiError(404, "NOT_FOUND", "This record or column was deleted while the file was uploading.");
    } catch (error) {
      await this.discard(id);
      throw error;
    }
    await this.repos.attachments.markReady(id, { sha256, size: plan.length, readyAt: this.now() });
    const attachment = await this.repos.attachments.findReady(id);
    if (!attachment) { await this.discard(id); throw new ApiError(404, "NOT_FOUND", "This record was deleted while the file was uploading."); }
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: board.workspaceId, boardId: board._id, recordId: record._id, actorUserId: actor.userId, actorName: actor.displayName, action: "attachment.added", entityType: "attachment", entityId: id, changes: [{ field: `values.${columnKey}`, from: null, to: plan.fileName }], summary: plan.fileName, now: this.now() }));
    return attachment;
  }

  // Pipes the body through the checks into the store: the signature is checked on the first bytes, the size is
  // counted throughout and must match what was announced.
  receive(id, plan, source) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      let bytes = 0, head = Buffer.alloc(0), checked = false, settled = false;
      const target = this.store.openUpload(id, { filename: plan.fileName, contentType: plan.type });
      const check = () => { checked = true; return TYPES[plan.type].matches(head); };
      const guard = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > plan.length || bytes > MAX_FILE_BYTES) return callback(tooLarge());
          if (!checked) { head = Buffer.concat([head, chunk]).subarray(0, SNIFF_BYTES); if (head.length >= SNIFF_BYTES && !check()) return callback(wrongType()); }
          hash.update(chunk);
          callback(null, chunk);
        },
        flush(callback) {
          if (!checked && !check()) return callback(wrongType());
          if (bytes !== plan.length) return callback(incomplete());
          callback();
        }
      });
      const fail = (error) => {
        if (settled) return;
        settled = true;
        source.unpipe?.(guard);
        guard.destroy();
        Promise.resolve(target.abort?.()).catch(() => {}).finally(() => reject(error instanceof ApiError ? error : incomplete()));
      };
      source.on("error", fail);
      source.on("close", () => { if (source.complete === false) fail(incomplete()); });
      guard.on("error", fail);
      target.on("error", fail);
      target.on("finish", () => { if (settled) return; settled = true; resolve({ sha256: hash.digest("hex") }); });
      source.pipe(guard).pipe(target);
    });
  }

  // Removes one attachment (metadata first, so it stops being served, then its bytes).
  async remove(attachment, actor) {
    if (!await this.repos.attachments.delete(attachment._id)) throw new ApiError(404, "NOT_FOUND", "This file doesn't exist or was removed.");
    await this.deleteBytes(attachment._id);
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: attachment.workspaceId, boardId: attachment.boardId, recordId: attachment.recordId, actorUserId: actor.userId, actorName: actor.displayName, action: "attachment.removed", entityType: "attachment", entityId: attachment._id, changes: [{ field: `values.${attachment.columnKey}`, from: attachment.name, to: null }], summary: attachment.name, now: this.now() }));
  }

  // After records, a board, a workspace or a column were deleted: remove their files. Never throws (the change itself
  // has already been saved); anything missed here is removed by the sweep.
  async purge(filter) {
    try {
      let removed = 0;
      for (;;) {
        const batch = await this.repos.attachments.find(filter, { limit: 500 });
        if (!batch.length) return removed;
        for (const a of batch) { await this.repos.attachments.delete(a._id); await this.deleteBytes(a._id); removed += 1; }
      }
    } catch (error) {
      this.logger.error(`[files] cleanup failed: ${error?.name || "Error"} ${redact(error?.message || "")}`);
      return 0;
    }
  }

  async discard(id) { await this.repos.attachments.delete(id).catch(() => {}); await this.deleteBytes(id); }
  async deleteBytes(id) {
    try { await this.store.delete(id); }
    catch (error) { this.logger.error(`[files] could not delete stored file ${id}: ${error?.name || "Error"}`); }
  }

  async moveBoard(boardId, workspaceId) {
    try { await this.repos.attachments.setWorkspace(boardId, workspaceId); }
    catch (error) { this.logger.error(`[files] could not move attachments of board ${boardId}: ${error?.name || "Error"}`); }
  }

  // Orphan sweep (every few minutes in the server): removes uploads pending for over an hour, attachments whose record
  // or Files column no longer exists, and stored bytes that have no attachment document.
  async sweep() {
    const cutoff = new Date(this.now().getTime() - PENDING_MAX_AGE_MS);
    let removed = 0, after = null;
    const boards = new Map();
    const columnExists = async (a) => {
      if (!boards.has(String(a.boardId))) boards.set(String(a.boardId), await this.repos.boards.findById(a.boardId));
      return Boolean(boards.get(String(a.boardId))?.columns.some((c) => c.key === a.columnKey && c.type === "files"));
    };
    try {
      for (;;) {
        const page = await this.repos.attachments.listAfter(after);
        if (!page.length) break;
        for (const a of page) {
          const stale = a.status === "pending" && a.createdAt < cutoff;
          const orphan = a.status === "ready" && (!await this.repos.records.findById(a.recordId) || !await columnExists(a));
          if (stale || orphan) { await this.discard(a._id); removed += 1; }
        }
        after = page.at(-1)._id;
      }
      for (const id of await this.store.listIds({ before: cutoff })) {
        if (!await this.repos.attachments.findById(id)) { await this.deleteBytes(id); removed += 1; }
      }
    } catch (error) {
      this.logger.error(`[files] sweep failed: ${error?.name || "Error"} ${redact(error?.message || "")}`);
    }
    return removed;
  }
}

module.exports = { FileService, DEFAULT_MAX_TOTAL_BYTES, PENDING_MAX_AGE_MS };
