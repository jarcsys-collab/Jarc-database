// Security headers (middleware/security-headers.js, finding I1): the middleware alone, over express.static of the real site/, wrapped
// around the real createApp (Microsoft Entra test keys, fake MongoDB, Fabric Data on over tests/support/fabric-fake.js), and in a
// headless Chrome/Edge with the full policy ENFORCED (test only): sign in, open a board and the Fabric module, zero violations.
// Synthetic data only; nothing leaves 127.0.0.1. The browser part is skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { securityHeaders, cspReportHandler, contentSecurityPolicy, violationsOf, blockedOrigin, ENFORCED_PAGE_CSP, ENFORCED_API_CSP } = require("../src/middleware/security-headers");
const { findBrowser, launch, freePort } = require("./support/headless-browser");

const SITE = path.resolve(__dirname, "..", "..", "site");
const ENTRA = { tenantId: "00000000-0000-4000-8000-000000000001" };
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}` })); });
const close = (s) => new Promise((r) => (s ? s.close(r) : r()));
const directives = (policy) => Object.fromEntries(policy.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

describe("contentSecurityPolicy (the report-only policy)", () => {
  test("same origin by default; inline styles allowed for style= attributes; no inline or eval script; Microsoft only with Entra", () => {
    const p = directives(contentSecurityPolicy({ entra: ENTRA }));
    assert.deepEqual(p["default-src"], ["'self'"]);
    assert.deepEqual(p["script-src"], ["'self'"]);
    assert.deepEqual(p["style-src"], ["'self'", "'unsafe-inline'"]);
    assert.deepEqual(p["img-src"], ["'self'", "data:", "blob:"]);
    assert.deepEqual(p["font-src"], ["'self'"]);
    assert.deepEqual(p["connect-src"], ["'self'", "https://login.microsoftonline.com"]);
    assert.deepEqual(p["frame-src"], ["'self'", "https://login.microsoftonline.com"]);
    assert.deepEqual(p["form-action"], ["'self'", "https://login.microsoftonline.com"]);
    assert.deepEqual(p["object-src"], ["'none'"]);
    assert.deepEqual(p["base-uri"], ["'self'"]);
    assert.equal(p["frame-ancestors"], undefined, "ignored by browsers in report-only; enforced separately");
    assert.equal(p["report-uri"], undefined);
    const dev = directives(contentSecurityPolicy());
    assert.deepEqual(dev["connect-src"], ["'self'"]);
    assert.deepEqual(dev["form-action"], ["'self'"]);
  });
  test("reportUri adds report-uri and report-to", () => {
    const p = directives(contentSecurityPolicy({ reportUri: "/api/v1/csp-report" }));
    assert.deepEqual(p["report-uri"], ["/api/v1/csp-report"]);
    assert.deepEqual(p["report-to"], ["csp-endpoint"]);
    assert.throws(() => securityHeaders({ reportUri: "https://elsewhere.example/r" }), /same-origin path/);
  });
});

describe("securityHeaders over express.static(site/) and JSON routes", () => {
  let srv, prod;
  const build = (options) => {
    const app = express();
    app.use(securityHeaders(options));
    app.get("/api/v1/thing", (req, res) => res.json({ ok: true }));
    app.get("/api/v1/own", (req, res) => res.set({ "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'", "X-Frame-Options": "SAMEORIGIN" }).type("application/pdf").send(Buffer.from("%PDF-")));
    app.get("/api/v1/no-referrer", (req, res) => res.set("Referrer-Policy", "no-referrer").redirect(303, "/"));
    app.get("/api/v1/stream", (req, res) => { res.set("Content-Type", "text/event-stream"); res.flushHeaders(); res.end(": done\n\n"); });
    app.use(express.static(SITE, { index: "index.html", dotfiles: "ignore" }));
    return listen(app);
  };
  before(async () => { srv = await build({ environment: "test", entra: ENTRA }); prod = await build({ environment: "production", entra: ENTRA, reportUri: "/api/v1/csp-report" }); });
  after(async () => { await close(srv?.server); await close(prod?.server); });

  test("the app page: enforced frame-ancestors/base-uri/object-src, the full policy report-only, and the enforced headers", async () => {
    for (const p of ["/", "/index.html", "/assets/AppView.js", "/assets/styles.css"]) {
      const res = await fetch(`${srv.url}${p}`);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get("content-security-policy"), ENFORCED_PAGE_CSP, p);
      assert.equal(res.headers.get("content-security-policy-report-only"), contentSecurityPolicy({ entra: ENTRA }), p);
      assert.equal(res.headers.get("x-frame-options"), "DENY", p);
      assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin", p);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", p);
      assert.equal(res.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()", p);
      assert.equal(res.headers.get("strict-transport-security"), null, `${p}: no HSTS outside production`);
      assert.equal(res.headers.get("reporting-endpoints"), null, `${p}: no report endpoint unless configured`);
    }
  });

  test("JSON API: a strict enforced CSP, no report-only policy, the body unchanged", async () => {
    const res = await fetch(`${srv.url}/api/v1/thing`);
    assert.deepEqual(await res.json(), { ok: true });
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.headers.get("content-security-policy"), ENFORCED_API_CSP);
    assert.equal(res.headers.get("content-security-policy-report-only"), null);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    const stream = await fetch(`${srv.url}/api/v1/stream`);
    assert.match(stream.headers.get("content-type"), /^text\/event-stream/);
    assert.equal(stream.headers.get("x-frame-options"), "DENY", "flushHeaders also gets them");
  });

  test("headers a route set itself win (attachment content's own CSP and frame option, the Drive return's no-referrer)", async () => {
    const own = await fetch(`${srv.url}/api/v1/own`);
    assert.equal(own.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'self'");
    assert.equal(own.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(own.headers.get("content-security-policy-report-only"), null);
    const back = await fetch(`${srv.url}/api/v1/no-referrer`, { redirect: "manual" });
    assert.equal(back.status, 303);
    assert.equal(back.headers.get("referrer-policy"), "no-referrer");
  });

  test("HSTS: production over HTTPS only (X-Forwarded-Proto from the edge), never includeSubDomains or preload", async () => {
    const plain = await fetch(`${prod.url}/`);
    assert.equal(plain.headers.get("strict-transport-security"), null, "plain HTTP");
    for (const p of ["/", "/api/v1/thing"]) {
      const res = await fetch(`${prod.url}${p}`, { headers: { "X-Forwarded-Proto": "https" } });
      assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000", p);
    }
    const res = await fetch(`${prod.url}/`, { headers: { "X-Forwarded-Proto": "https" } });
    assert.match(res.headers.get("content-security-policy-report-only"), /report-uri \/api\/v1\/csp-report; report-to csp-endpoint$/);
    assert.equal(res.headers.get("reporting-endpoints"), 'csp-endpoint="/api/v1/csp-report"');
  });

  test("enforce: true sends the full policy (plus frame-ancestors) as the enforced CSP and no report-only copy", async () => {
    const s = await (async () => { const app = express(); app.use(securityHeaders({ entra: ENTRA, enforce: true })); app.use(express.static(SITE)); return listen(app); })();
    try {
      const res = await fetch(`${s.url}/`);
      assert.equal(res.headers.get("content-security-policy"), `${contentSecurityPolicy({ entra: ENTRA })}; frame-ancestors 'none'`);
      assert.equal(res.headers.get("content-security-policy-report-only"), null);
    } finally { await close(s.server); }
  });
});

describe("cspReportHandler", () => {
  let srv; const lines = [];
  before(async () => {
    const app = express();
    app.use("/api/v1/csp-report", cspReportHandler({ logger: { warn: (l) => lines.push(l) }, perMinute: 5 }));
    srv = await listen(app);
  });
  after(() => close(srv?.server));
  const post = (body, type = "application/csp-report") => fetch(`${srv.url}/api/v1/csp-report`, { method: "POST", headers: { "Content-Type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });

  test("logs only the directive and the blocked origin: no paths, query strings, document URL or sample", async () => {
    lines.length = 0;
    const res = await post({ "csp-report": { "document-uri": "https://app.example/boards/100001?q=secret", "effective-directive": "img-src", "violated-directive": "img-src 'self'", "blocked-uri": "https://cdn.example/a/b.png?token=abc", "script-sample": "Synthetic Person 1" } });
    assert.equal(res.status, 204);
    const reporting = await post([{ type: "csp-violation", url: "https://app.example/x?y", body: { effectiveDirective: "script-src-elem", blockedURL: "inline", sample: "x" } }], "application/reports+json");
    assert.equal(reporting.status, 204);
    assert.deepEqual(lines, ["[csp] report-only violation: img-src blocked https://cdn.example", "[csp] report-only violation: script-src-elem blocked inline"]);
    assert.doesNotMatch(lines.join("\n"), /secret|token|boards|Synthetic|app\.example/);
  });
  test("over 8 KB → 413; malformed → 400; not POST → 405; nothing echoed; at most perMinute lines", async () => {
    assert.equal((await post({ "csp-report": { "blocked-uri": "x".repeat(9000) } })).status, 413);
    const bad = await post("{not json");
    assert.equal(bad.status, 400); assert.equal(await bad.text(), "");
    assert.equal((await fetch(`${srv.url}/api/v1/csp-report`)).status, 405);
    lines.length = 0;
    for (let i = 0; i < 8; i += 1) await post({ "csp-report": { "effective-directive": "font-src", "blocked-uri": "data:font/woff2;base64,AAAA" } });
    assert.equal(lines.length, 3, "5 a minute in all (2 logged above)");
    assert.equal(lines[0], "[csp] report-only violation: font-src blocked data:");
  });
  test("violationsOf / blockedOrigin ignore junk", () => {
    assert.deepEqual(violationsOf({ nothing: 1 }), []);
    assert.deepEqual(violationsOf([null, 3, { type: "deprecation", body: {} }]), []);
    assert.deepEqual(violationsOf({ "csp-report": { "violated-directive": "<script>", "blocked-uri": "javascript:alert(1)" } }), [{ directive: "unknown", blocked: "javascript:" }]);
    assert.equal(blockedOrigin(""), "none");
    assert.equal(blockedOrigin("not a url"), "other");
    assert.equal(blockedOrigin("wss://live.example:8443/path?x"), "wss://live.example:8443");
  });
});

// ---- The real app (createApp is an express app, so it mounts as a sub-app under the middleware: no app.js change).
async function realApp({ enforce }) {
  const { createApp } = require("../src/app");
  const { createFabricData, fabricLimiter } = require("../src/fabric");
  const { loadConfig } = require("../src/config");
  const { MemoryStateRepository } = require("../src/repositories/memory-state-repository");
  const { MongoConnection } = require("../src/db/connection");
  const { ensureDatabase } = require("../src/db/bootstrap");
  const { createDataLayer } = require("../src/data-layer");
  const { MemoryFileStore } = require("../src/files/file-store");
  const { createEntraVerifier } = require("../src/auth/entra-token");
  const { entraEnv } = require("./helpers");
  const { createTokenIssuer } = require("./support/entra-tokens");
  const { FakeMongoClient } = require("./support/fake-mongo");
  const { FabricFakeClient, row, inventoryRows, DEFAULT_INDEXES } = require("./support/fabric-fake");
  const issuer = await createTokenIssuer();
  const person = issuer.person("Synthetic Person 1");
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const entra = { ...issuer.config, redirectUri: `${base}/`, appOrigin: base };
  const env = entraEnv({ JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb", FABRIC_UNINDEXED_SCAN_MAX: "300", FABRIC_DATA_READER_OIDS: person.oid, FABRIC_API_ADMIN_OIDS: person.oid });
  const config = loadConfig(env).fabricData;
  const sales = Array.from({ length: 40 }, (_, i) => row({ Company: "Synthetic Co A", invoice_id: `SYN-${5000 + i}`, Line_No: 10000, invoice_date: new Date(Date.UTC(2026, 2, 31) - i * 86400000), customer_name: `Example Customer ${i % 3}`, invoice_item_name: `Synthetic product ${i % 5}`, invoice_item_quantity: 1, invoice_item_amount: 10, sales_data_source: "Source One", landed_cost: "1.25" }));
  const fabricClient = new FabricFakeClient({ docs: sales, indexes: DEFAULT_INDEXES.map((i) => ({ ...i })), inventory: { docs: inventoryRows(60) } });
  const stack = createFabricData({ config, logger: { warn() {}, error() {} }, createClient: () => fabricClient });
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => new FakeMongoClient() });
  await connection.connect();
  await ensureDatabase(connection.db);
  const dataLayer = createDataLayer({ connection, logger: { error() {} }, fileStore: new MemoryFileStore(), environment: "test" });
  const inner = createApp({
    repository: new MemoryStateRepository(), environment: "test", logger: { error() {}, warn() {} }, dataLayer,
    auth: { mode: "entra", entra, verify: createEntraVerifier({ ...entra, keySet: issuer.keySet }) },
    accessPolicy: "development_shared", betaOpenEditing: true,
    apiTokens: { key: crypto.randomBytes(32), adminObjectIds: [], issuePerHour: 1000, maxActive: 1000 },
    fabricData: { config, service: stack.service, values: stack.values, limiter: fabricLimiter({ perWindow: 100000 }) },
    // createApp mounts the security headers itself (app.js); the test only switches the full policy to enforced.
    securityHeadersOptions: { enforce }
  });
  const app = inner;
  const server = await new Promise((resolve) => { const s = app.listen(port, "127.0.0.1", () => resolve(s)); });
  return { base, person, server, async close() { inner.locals.realtime?.closeAll(); await close(server); await stack.close(); } };
}

describe("wrapped around the real createApp", () => {
  let real;
  before(async () => { real = await realApp({ enforce: false }); });
  after(() => real?.close());
  test("app page, a direct board link, a Fabric link, the MSAL bundle and the JSON API all carry the headers", async () => {
    for (const p of ["/", "/boards/100001", "/fabric/inventory", "/vendor/msal-browser.min.js"]) {
      const res = await fetch(`${real.base}${p}`);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get("content-security-policy"), ENFORCED_PAGE_CSP, p);
      assert.match(res.headers.get("content-security-policy-report-only") || "", /^default-src 'self'; script-src 'self';/, p);
      assert.equal(res.headers.get("x-frame-options"), "DENY", p);
    }
    const health = await fetch(`${real.base}/api/v1/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
    assert.equal(health.headers.get("content-security-policy"), ENFORCED_API_CSP);
    assert.equal(health.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(health.headers.get("x-powered-by"), null);
    const unknown = await fetch(`${real.base}/api/v1/nothing-here`);
    assert.match(unknown.headers.get("content-type"), /application\/json/);
    assert.equal(unknown.headers.get("x-frame-options"), "DENY");
  });
});

// Every CSP violation (enforced or report-only) and every console error, from the very first script on each page.
const PROBE = `(() => {
  window.__csp = []; window.__errors = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push({ directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 120), source: String(e.sourceFile || "").replace(/^https?:\\/\\/[^/]+/, ""), line: e.lineNumber, disposition: e.disposition }));
  const oe = console.error.bind(console);
  console.error = (...a) => { window.__errors.push(a.map((x) => (x && x.stack) || String(x)).join(" ")); oe(...a); };
  addEventListener("error", (e) => window.__errors.push("uncaught: " + (e.message || e.type)));
})();`;

const BROWSER = findBrowser();
describe("the full policy ENFORCED in a real browser (test only)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let real, b;
  const DESKTOP = { width: 1440, height: 900 };
  const json = async (expr) => JSON.parse(await b.evaluate(`JSON.stringify(${expr})`));
  const api = (method, url, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return JSON.stringify({ status: r.status, body: await r.json().catch(() => null) }); })()`).then(JSON.parse);
  const noViolations = async (label) => {
    assert.deepEqual(await json("window.__csp || []"), [], `${label}: CSP violations`);
    assert.deepEqual(await json("window.__errors || []"), [], `${label}: console errors`);
  };

  before(async () => {
    real = await realApp({ enforce: true });
    b = await launch(BROWSER);
    await b.motionPreference("reduce");
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
    // As the other browser tests do: a page opened on a JSON URL can still fetch (the API's CSP is frame-ancestors only).
    await b.open(`${real.base}/api/v1/health`, DESKTOP);
    const nonce = await b.evaluate(`fetch("/api/v1/auth/sign-in/start", { method: "POST" }).then((r) => r.json()).then((s) => s.nonce)`);
    const idToken = await real.person.idToken(nonce);
    assert.equal(await b.evaluate(`fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: ${JSON.stringify(idToken)} }) }).then((r) => r.status)`), 201, "signed in");
  });
  after(async () => { await b?.close(); await real?.close(); });

  test("the page really is under the enforced policy", async () => {
    await b.open(`${real.base}/`, DESKTOP);
    assert.ok(await b.waitFor("!!document.querySelector('.app-shell')", 20000), "app loaded");
    // A probe that must be blocked: proves enforcement and that the listener works (then cleared).
    await b.evaluate(`(() => { const s = document.createElement("script"); s.textContent = "window.__inlineRan = true"; document.head.append(s); return true; })()`);
    assert.ok(await b.waitFor("(window.__csp || []).some((v) => v.directive.startsWith('script-src') && v.blocked === 'inline')", 3000), "the inline-script probe was reported");
    assert.equal(await b.evaluate("window.__inlineRan === true"), false, "and blocked");
    await b.evaluate("window.__csp.length = 0, true");
  });

  test("sign-in, a board with records, the Fabric module (inventory list, a record, sales, API page): no CSP violations", async () => {
    const ws = (await api("POST", "/api/v1/workspaces", { name: "Synthetic Space" })).body.workspace.id;
    const board = (await api("POST", `/api/v1/workspaces/${ws}/boards`, { name: "Synthetic Board", columns: [{ key: "serial", label: "Name", type: "text", required: true }, { key: "note", label: "Note", type: "text" }] })).body.board;
    assert.equal((await api("POST", `/api/v1/boards/${board.id}/records/batch`, { records: [1, 2, 3].map((i) => ({ values: { serial: `Synthetic row ${i}`, note: `Note ${i}` } })) })).status, 201);

    await b.open(`${real.base}/boards/${board.publicId}`, DESKTOP);
    assert.ok(await b.waitFor("!!document.querySelector('.app-shell')", 20000), "app loaded");
    assert.ok(await b.waitFor(`[...document.querySelectorAll("tr[data-record-context]")].some((tr) => tr.textContent.includes("Synthetic row 1"))`, 15000), "the board's records");
    assert.ok(await b.waitFor("[...document.styleSheets].length > 5 && getComputedStyle(document.body).fontFamily.includes('Poppins')"), "stylesheets and fonts applied");
    await noViolations("board");

    await b.open(`${real.base}/fabric/inventory`, DESKTOP);
    assert.ok(await b.waitFor("document.querySelectorAll('.fabric-explorer-table tbody tr').length > 0", 20000), "Fabric inventory rows");
    const listed = await api("GET", "/api/v1/fabric/inventory/records?limit=50");
    assert.equal(listed.status, 200);
    await b.open(`${real.base}/fabric/inventory/records/${listed.body.items[0].id}`, DESKTOP);
    assert.ok(await b.waitFor(`!!document.querySelector(".fx-object") && !document.querySelector('.fx-object[aria-busy="true"]')`, 20000), "a Fabric record");
    await b.open(`${real.base}/fabric/sales`, DESKTOP);
    assert.ok(await b.waitFor("document.querySelectorAll('.fabric-explorer-table tbody tr').length > 0", 20000), "Fabric sales rows");
    await b.open(`${real.base}/fabric/api`, DESKTOP);
    assert.ok(await b.waitFor("!!document.querySelector('.app-shell')", 20000), "Fabric API page");
    await noViolations("fabric");
  });
});
