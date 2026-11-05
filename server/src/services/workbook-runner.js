// Starts the workbook worker thread and talks to it (workers/workbook-worker.js). Each file gets its own thread, which ends with the work.
// Rows travel in small pieces, each sent only after the last was handled, so moving them never holds up the app.
const path = require("path");
const { Worker } = require("worker_threads");
const { ApiError } = require("../middleware/errors");

const WORKER = path.join(__dirname, "..", "workers", "workbook-worker.js");
const LIMIT_MS = 5 * 60 * 1000, MEMORY_MB = 1024;
const unreadable = () => new ApiError(422, "IMPORT_UNREADABLE", "This file couldn't be read. Save a smaller copy and try again.");

function talk(start) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { resourceLimits: { maxOldGenerationSizeMb: MEMORY_MB } });
    let settled = false;
    const end = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); worker.terminate().catch(() => {}); fn(value); };
    const timer = setTimeout(() => end(reject, new ApiError(422, "IMPORT_UNREADABLE", "This file took too long to read. Save a smaller copy and try again.")), LIMIT_MS);
    timer.unref?.();
    worker.on("error", () => end(reject, unreadable()));
    worker.on("exit", () => end(reject, unreadable()));
    start(worker, (value) => end(resolve, value), (error) => end(reject, error));
  });
}
const failure = (m) => (m.status ? new ApiError(m.status, m.code, m.message) : unreadable());

// Reads a file: answers with what's in it, after every row has been handed to onRows.
function readWorkbook({ buffer, name, sheet, choices, settings, onRows }) {
  return talk((worker, done, fail) => {
    let result = null;
    worker.on("message", (m) => {
      if (m.type === "failed") return fail(failure(m));
      if (m.type === "result") { result = m; return undefined; }
      if (m.type === "end") return done(result);
      if (m.type === "rows") return Promise.resolve(onRows(m.rows)).then(() => worker.postMessage({ op: "more" })).catch(fail);
      return undefined;
    });
    const bytes = new Uint8Array(buffer).buffer; // its own copy, handed over rather than copied again
    worker.postMessage({ op: "read", buffer: bytes, name, sheet, choices, settings }, [bytes]);
  });
}

// Checks rows already stored. rows: a cursor over the job's stored pieces, read one at a time.
function checkWorkbook({ rows, choices, settings, notes }) {
  return talk((worker, done, fail) => {
    const next = async () => {
      const piece = await rows.next();
      worker.postMessage(piece ? { rows: piece.rows } : { done: true });
    };
    worker.on("message", (m) => {
      if (m.type === "failed") return fail(failure(m));
      if (m.type === "result") return done(m);
      if (m.type === "ack") return next().catch(fail);
      return undefined;
    });
    worker.postMessage({ op: "check", choices, settings, notes });
    next().catch(fail);
  });
}

module.exports = { readWorkbook, checkWorkbook };
