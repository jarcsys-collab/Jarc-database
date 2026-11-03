// Logs API requests slower than a threshold (SLOW_REQUEST_MS; 0 turns it off): the method, the route's pattern, the status
// and the time. Never the URL as sent, query text, IDs, cookies, tokens or anything about the person. The live-update
// stream stays open by design, so it is left out.
function slowRequestLog({ logger = console, thresholdMs = 0 }) {
  if (!thresholdMs) return (req, res, next) => next();
  return (req, res, next) => {
    if (req.path === "/events") return next();
    const started = process.hrtime.bigint();
    res.once("finish", () => {
      const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
      if (ms < thresholdMs) return;
      logger.warn?.(`[slow] ${req.method} ${req.route?.path ?? "(no route)"} ${res.statusCode} ${ms}ms`);
    });
    return next();
  };
}

module.exports = { slowRequestLog };
