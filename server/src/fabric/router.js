// The Fabric Data routes, shared by the session API (/api/v1/fabric, access.js requireFabricDataRead) and the Fabric API tokens
// (/api/v1/external/fabric). Who is asking is decided before this router: it only reads req.fabricAccess
//   { datasets: Set (or array) of "sales" / "inventory", sensitive: boolean, via: "session" | "token", actorId | tokenId }
// (`cost` is accepted as the earlier name of `sensitive` when `sensitive` is absent) and never looks at sessions or tokens
// itself. GET and HEAD only; nothing is cached.
//   GET /status
//   GET /:dataset/schema | /:dataset/records | /:dataset/records/:id    dataset ∈ datasets.js; unknown → 404, not granted → 403
//   GET /invoices…                                                      only with invoiceViews (FABRIC_INVOICE_VIEWS), session only
const express = require("express");
const { sendError, ApiError } = require("../middleware/errors");
const { isFabricError, describe, MESSAGES } = require("./errors");
const { DATASET_NAMES, datasetNamed } = require("./datasets");
const v = require("./validation");

const PER_WINDOW = 30, WINDOW_MS = 10 * 1000;

// A per-caller sliding window: (key) => 0 when allowed, otherwise the seconds to wait.
function fabricLimiter({ perWindow = PER_WINDOW, windowMs = WINDOW_MS, now = Date.now } = {}) {
  const recent = new Map();
  return (key) => {
    const t = now(), times = (recent.get(key) || []).filter((s) => t - s < windowMs);
    if (times.length >= perWindow) { recent.set(key, times); return Math.max(1, Math.ceil((times[0] + windowMs - t) / 1000)); }
    times.push(t); recent.set(key, times);
    if (recent.size > 5000) for (const [k, list] of recent) if (!list.some((s) => t - s < windowMs)) recent.delete(k);
    return 0;
  };
}

// Requests one caller may have running at once (on top of the rate): one caller can't hold every Fabric connection, whatever
// the process-wide limit in repository.js lets through.
const PER_CALLER_IN_FLIGHT = 3;
const BUSY_RETRY_AFTER_S = 2;

// The datasets an access object grants (only known names) and whether it sees sensitive fields.
function accessOf(raw) {
  const list = raw?.datasets instanceof Set ? [...raw.datasets] : Array.isArray(raw?.datasets) ? raw.datasets : [];
  const sensitive = typeof raw?.sensitive === "boolean" ? raw.sensitive === true : raw?.cost === true;
  return { datasets: new Set(DATASET_NAMES.filter((n) => list.includes(n))), sensitive, cost: sensitive };
}

// invoiceViews: mount the v1 invoice endpoints (the session API only, and only with FABRIC_INVOICE_VIEWS=true).
function fabricDataRouter({ service, limiter = fabricLimiter(), perCallerInFlight = PER_CALLER_IN_FLIGHT, logger = console, now = () => new Date(), invoiceViews = false }) {
  if (!service) throw new Error("fabricDataRouter needs the Fabric service.");
  const router = express.Router();
  const send = (res, body) => res.status(200).json(body);
  const running = new Map(); // caller key → requests in flight

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "HEAD") { res.set("Allow", "GET, HEAD"); return sendError(res, 405, "METHOD_NOT_ALLOWED", "Fabric Data is read-only."); }
    const access = req.fabricAccess;
    if (!access || !["session", "token"].includes(access.via)) return sendError(res, 401, "UNAUTHENTICATED", "Sign in to JARC to use Fabric Data.");
    const key = `${access.via}:${access.via === "token" ? access.tokenId : access.actorId}`;
    const wait = limiter(key);
    if (wait) { res.set("Retry-After", String(wait)); return sendError(res, 429, "RATE_LIMITED", "Too many Fabric Data requests. Wait a few seconds and try again."); }
    const count = running.get(key) || 0;
    if (count >= perCallerInFlight) { res.set("Retry-After", String(BUSY_RETRY_AFTER_S)); return sendError(res, 503, "FABRIC_BUSY", MESSAGES.FABRIC_BUSY); }
    running.set(key, count + 1);
    let done = false;
    res.on("close", () => {
      if (done) return;
      done = true;
      const left = (running.get(key) || 1) - 1;
      if (left > 0) running.set(key, left); else running.delete(key);
    });
    return next();
  });
  const access = (req) => accessOf(req.fabricAccess);
  // The dataset of the path, or 404 NOT_FOUND (the same answer for every unknown name, never echoing it); 403 when this caller
  // (a token's dataset scopes) may not read it.
  const datasetOf = (req) => {
    const ds = datasetNamed(req.params.dataset);
    if (!ds) throw new ApiError(404, "NOT_FOUND", "Not found.");
    if (!access(req).datasets.has(ds.name)) throw new ApiError(403, "INSUFFICIENT_SCOPE", "This access doesn't include this Fabric dataset.");
    return ds.name;
  };

  router.get("/status", async (req, res) => { v.noParams(req.query); send(res, await service.status(access(req))); });
  if (invoiceViews) {
    // v1 invoice views over FactSales: need the sales dataset; cost = sensitive.
    const invoiceAccess = (req) => {
      const a = access(req);
      if (!a.datasets.has("sales")) throw new ApiError(403, "INSUFFICIENT_SCOPE", "This access doesn't include this Fabric dataset.");
      return { cost: a.sensitive };
    };
    router.get("/invoices", async (req, res) => { const a = invoiceAccess(req); send(res, await service.listInvoices(v.invoiceListQuery(req.query, now()), a)); });
    router.get("/invoices/:company/:invoiceNo", async (req, res) => {
      const a = invoiceAccess(req);
      v.noParams(req.query);
      const key = v.invoicePath(req.params);
      send(res, await service.getInvoice(key.company, key.invoiceNo, a));
    });
    router.get("/invoices/:company/:invoiceNo/lines", async (req, res) => {
      const a = invoiceAccess(req);
      const key = v.invoicePath(req.params);
      send(res, await service.listInvoiceLines(key.company, key.invoiceNo, v.invoiceLinesQuery(req.query, key), a));
    });
    router.get("/invoices/:company/:invoiceNo/lines/:lineId", async (req, res) => {
      const a = invoiceAccess(req);
      v.noParams(req.query);
      const key = v.invoicePath(req.params);
      send(res, await service.getLine(key.company, key.invoiceNo, v.lineId(req.params.lineId), a));
    });
  }
  router.get("/:dataset/schema", async (req, res) => { const name = datasetOf(req); v.noParams(req.query); send(res, service.schema(name, access(req))); });
  router.get("/:dataset/records", async (req, res) => { const name = datasetOf(req); send(res, await service.listRecords(name, req.query, access(req))); });
  router.get("/:dataset/records/:id", async (req, res) => {
    const name = datasetOf(req);
    v.noParams(req.query);
    send(res, await service.getRecord(name, v.recordId(req.params.id), access(req)));
  });

  // Errors here never reach the general handler's log line: Fabric paths and queries hold invoice numbers and company names.
  // eslint-disable-next-line no-unused-vars -- Express identifies error middleware by its four arguments.
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.code === "FABRIC_BUSY") res.set("Retry-After", String(BUSY_RETRY_AFTER_S));
    if (error?.status && error?.code && (isFabricError(error) || error.status < 500)) return sendError(res, error.status, error.code, error.message, error.details);
    logger.error?.(`[fabric]${req.requestId ? ` [req ${req.requestId}]` : ""} ${req.method} ${req.baseUrl} failed: ${describe(error)}${typeof error?.stack === "string" ? ` ${(error.stack.split("\n")[1] || "").trim()}` : ""}`); // where, never the message
    return sendError(res, 500, "INTERNAL_ERROR");
  });
  return router;
}

module.exports = { fabricDataRouter, fabricLimiter, accessOf };
