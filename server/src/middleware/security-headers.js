// Browser security headers for every response (security model finding I1).
//
//   Enforced now, on everything:   X-Frame-Options: DENY, Referrer-Policy: strict-origin-when-cross-origin, X-Content-Type-Options:
//                                  nosniff, Permissions-Policy (camera, microphone, geolocation off), Strict-Transport-Security
//                                  (production over HTTPS only; no includeSubDomains/preload: the host is a Railway domain).
//   Enforced CSP, pages:           frame-ancestors 'none'; base-uri 'self'; object-src 'none' (nothing the app does can break).
//   Enforced CSP, /api:            frame-ancestors 'none' only. Not default-src 'none': a page opened on a JSON URL (as the
//                                  browser tests do with /api/v1/health) could then no longer fetch, and JSON is never rendered.
//   Report-only CSP, pages:        the full policy below, derived from what site/ loads. Enforcement comes after review.
//
// A header a route has already set wins: the defaults are added just before the headers are written, and only where missing.
// So attachment content (routes/files.js: its own CSP and X-Frame-Options SAMEORIGIN for the PDF preview frame) and the Google
// Drive OAuth return (Referrer-Policy: no-referrer) keep their stricter, route-specific headers. A response with its own CSP also
// gets no report-only policy (the route's policy is the one that applies).
//
// What the page loads (checked against site/index.html, site/assets/*.js and *.css):
//   scripts     same origin only: <script src="assets/…">, MSAL from /vendor/msal-browser.min.js (EntraAuth.loadLibrary). No inline
//               <script>, no inline event-handler attributes, no eval/new Function.
//   styles      same-origin stylesheets, plus style="…" attributes written through innerHTML all over the app → 'unsafe-inline'.
//   images      same origin (attachment thumbnails/previews are /api/v1/attachments/{id}/content, proxied even for Google Drive),
//               data: (profile photos are data:image URLs; CSS select arrows are data:image/svg+xml), blob: (downloads).
//   fonts       same origin (assets/fonts/*.woff2).
//   connect     fetch/XHR and the live-updates EventSource (/api/v1/events) are same origin; MSAL's redirect-response handling posts
//               to the Microsoft token endpoint (login.microsoftonline.com).
//   frames      the PDF preview is an <iframe> of /api/v1/attachments/…; MSAL may use a hidden Microsoft iframe (not used today).
//   navigation  sign-in/out and Google/monday.com OAuth are top-level navigations (not limited by CSP); no <form> posts anywhere.
const MICROSOFT_LOGIN = "https://login.microsoftonline.com";
const REPORT_GROUP = "csp-endpoint";

// The full policy (report-only in P0). entra: Microsoft sign-in configured. reportUri: a same-origin path that accepts reports.
function contentSecurityPolicy({ entra = null, reportUri = null } = {}) {
  const microsoft = entra ? [MICROSOFT_LOGIN] : [];
  const directives = [
    ["default-src", "'self'"],
    ["script-src", "'self'"],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "blob:"],
    ["font-src", "'self'"],
    ["connect-src", "'self'", ...microsoft],
    ["frame-src", "'self'", ...microsoft],
    ["worker-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'", ...microsoft]
    // frame-ancestors is left out: browsers ignore it in a report-only policy (and warn). It is enforced below.
  ];
  if (reportUri) directives.push(["report-uri", reportUri], ["report-to", REPORT_GROUP]);
  return directives.map((d) => d.join(" ")).join("; ");
}

const ENFORCED_PAGE_CSP = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'";
const ENFORCED_API_CSP = "frame-ancestors 'none'";
const HSTS = "max-age=31536000";
const PERMISSIONS = "camera=(), microphone=(), geolocation=()";

// The app has no `trust proxy`, so behind Railway's edge req.secure is false: the edge's X-Forwarded-Proto says HTTPS (as
// routes/external-api.js reads it). A forged header can at most send HSTS over plain HTTP, which browsers ignore.
const overHttps = (req) => req.secure || String(req.get?.("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase() === "https";

// environment: "production" turns HSTS on (over HTTPS). hsts: true/false overrides that (tests). enforce: true sends the full
// policy as an ENFORCED Content-Security-Policy instead of report-only (tests now; production only after review).
// apiPrefix: paths that are the JSON API.
function securityHeaders({ environment = "development", entra = null, reportUri = null, hsts = null, enforce = false, apiPrefix = "/api" } = {}) {
  if (reportUri !== null && !/^\/[A-Za-z0-9/_-]{1,200}$/.test(reportUri)) throw new Error("securityHeaders reportUri must be a same-origin path.");
  const fullPolicy = contentSecurityPolicy({ entra, reportUri });
  const pagePolicy = enforce ? `${fullPolicy}; frame-ancestors 'none'` : ENFORCED_PAGE_CSP;
  const hstsOn = typeof hsts === "boolean" ? () => hsts : (req) => environment === "production" && overHttps(req);
  const isApi = (req) => req.path === apiPrefix || req.path.startsWith(`${apiPrefix}/`);

  return function securityHeadersMiddleware(req, res, next) {
    const api = isApi(req), https = hstsOn(req);
    const writeHead = res.writeHead;
    res.writeHead = function securedWriteHead(...args) {
      res.writeHead = writeHead;
      const add = (name, value) => { if (res.getHeader(name) === undefined) res.setHeader(name, value); };
      const ownPolicy = res.getHeader("Content-Security-Policy") !== undefined;
      add("X-Content-Type-Options", "nosniff");
      add("X-Frame-Options", "DENY");
      add("Referrer-Policy", "strict-origin-when-cross-origin");
      add("Permissions-Policy", PERMISSIONS);
      if (https) add("Strict-Transport-Security", HSTS);
      if (api) add("Content-Security-Policy", ENFORCED_API_CSP);
      else {
        add("Content-Security-Policy", pagePolicy);
        if (!enforce && !ownPolicy) {
          add("Content-Security-Policy-Report-Only", fullPolicy);
          if (reportUri) add("Reporting-Endpoints", `${REPORT_GROUP}="${reportUri}"`);
        }
      }
      return writeHead.apply(this, args);
    };
    next();
  };
}

// ---- CSP violation reports (POST, from browsers; no session, no CSRF). Mount it BEFORE the app-wide 10 MB JSON parser so its
// own 8 KB limit applies. Logs only the directive and the blocked resource's origin (or its scheme / CSP keyword): never paths,
// query strings, document URLs, samples or anything about the person. At most `perMinute` lines a minute; the rest are dropped.
const REPORT_TYPES = ["application/csp-report", "application/reports+json", "application/json"];
const REPORT_BYTES = 8 * 1024;
const KEYWORDS = new Set(["inline", "eval", "wasm-eval", "self", "trusted-types-policy", "trusted-types-sink"]);

function blockedOrigin(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "none";
  if (KEYWORDS.has(text)) return text;
  try {
    const url = new URL(text);
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return url.origin;
    return /^[a-z][a-z0-9+.-]{0,20}:$/.test(url.protocol) ? url.protocol : "other";
  } catch { return "other"; }
}
const directiveOf = (value) => { const first = String(value ?? "").trim().split(/\s+/)[0].toLowerCase(); return /^[a-z-]{1,40}$/.test(first) ? first : "unknown"; };

// Both formats: report-uri ({ "csp-report": { "effective-directive", "violated-directive", "blocked-uri" } }) and the Reporting
// API ([{ type: "csp-violation", body: { effectiveDirective, blockedURL } }]). Anything else yields nothing.
function violationsOf(body) {
  const list = Array.isArray(body) ? body : [body];
  const out = [];
  for (const item of list.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const legacy = item["csp-report"];
    if (legacy && typeof legacy === "object") out.push({ directive: directiveOf(legacy["effective-directive"] || legacy["violated-directive"]), blocked: blockedOrigin(legacy["blocked-uri"]) });
    else if (item.type === "csp-violation" && item.body && typeof item.body === "object") out.push({ directive: directiveOf(item.body.effectiveDirective), blocked: blockedOrigin(item.body.blockedURL) });
  }
  return out;
}

function cspReportHandler({ logger = console, perMinute = 60, now = () => Date.now() } = {}) {
  const express = require("express");
  const router = express.Router();
  let windowStart = 0, logged = 0;
  const parse = express.json({ type: REPORT_TYPES, limit: REPORT_BYTES, strict: true, inflate: false });
  router.post("/", parse, (req, res) => {
    res.set("Cache-Control", "no-store");
    // Parsed earlier by a bigger parser (mounted after it): the same 8 KB limit still applies.
    let size = 0; try { size = Buffer.byteLength(JSON.stringify(req.body ?? null)); } catch { size = Infinity; }
    if (size > REPORT_BYTES) return res.status(413).end();
    const t = now();
    if (t - windowStart >= 60000) { windowStart = t; logged = 0; }
    for (const v of violationsOf(req.body)) {
      if (logged >= perMinute) break;
      logged += 1;
      logger.warn?.(`[csp] report-only violation: ${v.directive} blocked ${v.blocked}`);
    }
    return res.status(204).end();
  });
  router.all("/", (req, res) => res.set("Allow", "POST").status(405).end());
  // Parser errors (too large, malformed, compressed): a bare status, nothing echoed.
  router.use((error, req, res, next) => { if (res.headersSent) return next(error); return res.status(error?.status === 413 ? 413 : error?.status === 415 ? 415 : 400).end(); });
  return router;
}

module.exports = { securityHeaders, cspReportHandler, contentSecurityPolicy, violationsOf, blockedOrigin, ENFORCED_PAGE_CSP, ENFORCED_API_CSP };
