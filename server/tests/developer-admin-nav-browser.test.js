// Developer → Administration (System Health, People directory) in the REAL app, in a headless Chrome/Edge: the JARC shell
// (Microsoft Entra test keys, JARC on its fake MongoDB, shared workspaces) with the REAL employees backend over the fake
// directory source, on two servers: API tokens ON (as in production) and OFF. System Health and the People directory are no
// longer in the main sidebar; Developer shows an Administration section with only the entries each person may open, and its
// API sections exactly as before. Personas: the owner (JARC.Admin + directory admin + API admin), a viewer (People directory +
// System Health viewer, no API admin), an API administrator only, a System-Health-only viewer, and someone with nothing.
//
// systemHealth in /features (SYSTEM_HEALTH_VIEWER_OIDS, contract: { view, admin, activity }, absent = no access) and the viewer
// scope of /admin/system-health are STUBBED in the page when the server doesn't answer them itself (window.name carries the
// persona), so this checks the front end whatever state the backend is in. Synthetic data only; nothing leaves 127.0.0.1.
// DEV_ADMIN_SHOTS=<folder>: also saves screenshots there. Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs"), path = require("path");
const { createApp } = require("../src/app");
const { MemoryStateRepository } = require("../src/repositories/memory-state-repository");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { createEntraVerifier } = require("../src/auth/entra-token");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FakeMongoClient } = require("./support/fake-mongo");
const { findBrowser, launch, freePort } = require("./support/headless-browser");
const { createEmployees } = require("../src/employees");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const BROWSER = findBrowser();
const DESKTOP = { width: 1440, height: 900 };
const SHOTS = process.env.DEV_ADMIN_SHOTS || "";
const COLUMNS = [{ key: "serial", label: "Name", type: "text", required: true }];
const DOCS = syntheticPeople(3).map((d, i) => ({ ...d, display_name: `Synthetic Person ${i + 1}`, first_name: "Synthetic", last_name: `Person ${i + 1}`, job_title: "Analyst", department: "Dept A", office_location: null, account_enabled: true, user_type: "Member" }));
// The redacted System Health report a viewer gets (scope "viewer"): no hosts, names, routes, raw errors or audit data.
const VIEWER_HEALTH = { scope: "viewer", generatedAt: "2026-11-26T01:00:00.000Z", server: { status: "ok", version: "synthetic", uptimeSeconds: 3600, memoryMb: { rss: 100, heapUsed: 50 }, monitoringSince: "2026-11-26T00:00:00.000Z" }, database: { status: "connected", pingMs: 4, commands: 10, failed: 0, slow: 1, slowThresholdMs: 500 }, api: { requests: 120, serverErrors: 1, clientErrors: 2, errorRate: 0.8, statuses: { 200: 117, 500: 1 }, samples: 120, avgMs: 12, p50Ms: 9, p95Ms: 40, p99Ms: 80, maxMs: 120 }, slowestEndpoints: [{ route: "GET /api/v1/features", count: 3, serverErrors: 0, clientErrors: 0, errorRate: 0, samples: 3, avgMs: 5, p50Ms: 5, p95Ms: 6, p99Ms: 6, maxMs: 6, lastAt: "2026-11-26T00:59:00.000Z" }], failingEndpoints: [], endpoints: [], trend: [{ at: "2026-11-26T00:59:00.000Z", requests: 4, errors: 0, avgMs: 10 }], errors: { recent: 1, byStatus: { 500: 1 }, byCode: { INTERNAL_ERROR: 1 } }, integrations: { monday: { enabled: true, configured: true, connected: true, state: "connected", syncEnabled: true, syncPaused: false, lastSyncAt: "2026-11-26T00:30:00.000Z", importedBoards: 2, failedJobs: 1, activity: null }, googleDrive: { enabled: true, connected: false, state: "not_connected", activeForNewUploads: false, hasError: true, lastErrorAt: "2026-11-26T00:10:00.000Z", activity: null } }, jobs: { integration: { monday: { running: 0, queued: 0, retry: 0, failed: 1 } }, imports: { active: 0, failed: 0 }, searchIndex: { mode: "off" }, recentFailures: { count: 1, byKind: { import: 1 } } } };
const ACCESS = { owner: { view: true, admin: true, activity: true }, viewer: { view: true, admin: false, activity: false }, health: { view: true, admin: false, activity: false } };

const STUB = `(() => {
  window.__errors = []; window.__api = [];
  const oe = console.error.bind(console);
  console.error = (...a) => { window.__errors.push(a.map((x) => (x && x.stack) || String(x)).join(" ")); oe(...a); };
  addEventListener("error", (e) => window.__errors.push("uncaught: " + (e.message || e.type)));
  addEventListener("unhandledrejection", (e) => window.__errors.push("rejection: " + ((e.reason && e.reason.message) || e.reason)));
  const role = window.name || "", ACCESS = ${JSON.stringify(ACCESS)}, VIEWER = ${JSON.stringify(VIEWER_HEALTH)};
  const of = window.fetch.bind(window);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url, p = url.replace(/^https?:\\/\\/[^/]+/, "").split("?")[0];
    window.__api.push(p);
    if (p === "/api/v1/features") {
      const r = await of(input, init); if (!r.ok) return r; const j = await r.clone().json().catch(() => null); if (!j?.features) return r;
      if (!("systemHealth" in j.features) && ACCESS[role]) j.features.systemHealth = ACCESS[role];
      return json(j, r.status);
    }
    if (p === "/api/v1/admin/system-health" && ACCESS[role] && !ACCESS[role].admin) { const r = await of(input, init); return r.status === 403 ? json(VIEWER) : r; }
    return of(input, init);
  };
})();`;

describe("Developer → Administration (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let issuer, persons, b, servers = {}, board = null, signedIn = null;
  const start = async (tokensOn) => {
    const port = await freePort(), base = `http://localhost:${port}`;
    const entra = { ...issuer.config, redirectUri: `${base}/`, appOrigin: base };
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => new FakeMongoClient() });
    await connection.connect(); await ensureDatabase(connection.db);
    const dataLayer = createDataLayer({ connection, logger: { error() {} }, fileStore: new MemoryFileStore(), environment: "test" });
    const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: issuer.config.tenantId, viewerObjectIds: [persons.viewer.oid], adminObjectIds: [persons.owner.oid] }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
    const employees = createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs: DOCS }), idKey: TEST_ID_KEY, logger: { info() {}, warn() {}, error() {} } });
    const app = createApp({
      employees, repository: new MemoryStateRepository(), environment: "test", logger: { error() {}, warn() {} }, dataLayer,
      auth: { mode: "entra", entra, verify: createEntraVerifier({ ...entra, keySet: issuer.keySet }) }, accessPolicy: "development_shared", betaOpenEditing: true,
      systemHealth: { viewerObjectIds: [persons.viewer.oid, persons.health.oid] }, // SYSTEM_HEALTH_VIEWER_OIDS (ignored by a server without it)
      ...(tokensOn ? { apiTokens: { key: crypto.randomBytes(32), adminObjectIds: [persons.owner.oid, persons.apiadmin.oid], issuePerHour: 1000, maxActive: 1000 } } : {})
    });
    const server = await new Promise((resolve) => { const s = app.listen(port, "127.0.0.1", () => resolve(s)); });
    return { base, app, server, employees };
  };
  const wait = (expr, ms = 15000) => b.waitFor(expr, ms);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const json = async (expr) => JSON.parse(await b.evaluate(`JSON.stringify(${expr})`));
  const noErrors = async (label) => assert.deepEqual(await json("window.__errors || []"), [], `${label}: console errors`);
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const r = await b.send("Page.captureScreenshot", { format: "png" }); if (r.result?.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64")); };
  const signIn = async (srv, role) => {
    const key = `${srv}:${role}`;
    if (signedIn === key) return;
    await b.open(`${servers[srv].base}/api/v1/health`, DESKTOP);
    const nonce = await b.evaluate(`fetch("/api/v1/auth/sign-in/start", { method: "POST" }).then((r) => r.json()).then((s) => s.nonce)`);
    const idToken = await persons[role].idToken(nonce);
    assert.equal(await b.evaluate(`fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: ${JSON.stringify(idToken)} }) }).then((r) => r.status)`), 201, `sign-in as ${role}`);
    await b.evaluate(`window.name = ${JSON.stringify(role)}`);
    signedIn = key;
  };
  const open = async (srv, p, size = DESKTOP) => { await b.open(`${servers[srv].base}${p}`, size); assert.ok(await wait("!!document.querySelector('.app-shell')", 20000), `${p}: app`); };
  const api = (method, url, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return JSON.stringify({ status: r.status, body: await r.json().catch(() => null) }); })()`).then(JSON.parse);
  // Opens the profile menu; returns whether Developer is offered. With open: true, opens Developer too.
  const developer = async ({ open: go = true } = {}) => {
    assert.ok(await click('.topbar [data-action="profile-menu"]'), "profile menu");
    assert.ok(await wait(`!!document.querySelector("#overlay-root .profile-popover")`), "profile menu open");
    const offered = await b.evaluate(`!!document.querySelector('#overlay-root [data-action="developer"]')`);
    if (offered && go) { await click('#overlay-root [data-action="developer"]'); assert.ok(await wait(`!!document.querySelector(".developer-window")`), "Developer open"); }
    return offered;
  };
  // What the Developer window offers.
  const devNav = () => json(`(() => { const n = document.querySelector(".developer-window .settings-nav"); return { tabs: [...n.querySelectorAll('[data-action="apitok-tab"]')].map((x) => x.dataset.tab), admin: [...n.querySelectorAll('[data-action="apitok-admin"]')].map((x) => x.dataset.target), sep: !!n.querySelector(".apitok-nav-sep"), caption: !!n.querySelector(".apitok-nav-caption"), title: document.querySelector("#apitok-title")?.textContent || "", current: n.querySelector('[aria-current="page"]')?.dataset.tab || "" }; })()`);
  const sidebarHasAdmin = () => b.evaluate(`!!document.querySelector('#sidebar [data-screen="system-health"], #sidebar [data-screen="employees"]')`);
  const ALL_API = ["overview", "tokens", "explorer", "directory", "docs", "activity"], EMPLOYEE_API = ["overview", "directory", "docs"];

  before(async () => {
    issuer = await createTokenIssuer();
    persons = { owner: issuer.person("Synthetic Owner", { admin: true }), viewer: issuer.person("Synthetic Viewer"), apiadmin: issuer.person("Synthetic Api Admin"), health: issuer.person("Synthetic Health Viewer"), nobody: issuer.person("Synthetic Nobody") };
    servers.on = await start(true); servers.off = await start(false);
    b = await launch(BROWSER);
    await b.motionPreference("reduce");
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
    await signIn("on", "owner");
    const w = await api("POST", "/api/v1/workspaces", { name: "Synthetic Space" }); assert.equal(w.status, 201);
    const bd = await api("POST", `/api/v1/workspaces/${w.body.workspace.id}/boards`, { name: "Synthetic Board", columns: COLUMNS }); assert.equal(bd.status, 201);
    board = { publicId: bd.body.board.publicId, name: "Synthetic Board" };
  });
  after(async () => { await b?.close(); for (const s of Object.values(servers)) { s.app.locals.realtime?.closeAll(); await new Promise((r) => s.server.close(r)); await s.employees.close(); } });

  test("1. owner (tokens on): API sections as before, then Administration; System Health and the People directory launch from it and close it; Back restores the board without reopening Developer", async () => {
    await signIn("on", "owner");
    await open("on", `/boards/${board.publicId}`);
    assert.ok(await wait(`document.querySelector(".board-title-input")?.value === ${JSON.stringify(board.name)}`), "board");
    assert.equal(await sidebarHasAdmin(), false, "not in the main sidebar");
    assert.ok(await b.evaluate(`["home", "mywork", "integrations"].every((s) => !!document.querySelector('#sidebar [data-action="nav"][data-screen="' + s + '"]')) && !!document.querySelector('#sidebar [data-action="settings"]') && !!document.querySelector('#sidebar [data-action="shortcuts"]') && !!document.querySelector("#sidebar .workspace-switch")`), "the other entries stay");
    await shot("dev-after-1-sidebar");
    assert.ok(await developer());
    const nav = await devNav();
    assert.deepEqual(nav.tabs, ALL_API, "API sections as before"); assert.deepEqual(nav.admin, ["system-health", "employees"]); assert.ok(nav.sep && nav.caption, "divider and caption");
    assert.equal(nav.current, "overview");
    await shot("dev-after-2-developer-owner");
    // The existing sections still work (API Keys lists, Boards & Columns, Documentation).
    for (const [tab, check] of [["tokens", `/API key|token/i.test(document.querySelector("#apitok-root")?.innerText || "")`], ["directory", `!!document.querySelector("#apitok-root")`], ["docs", `/Base URL|endpoint/i.test(document.querySelector("#apitok-root")?.innerText || "")`], ["explorer", `!!document.querySelector("#apitok-root")`], ["activity", `!!document.querySelector("#apitok-root")`]]) {
      await click(`.developer-window [data-action="apitok-tab"][data-tab="${tab}"]`);
      assert.ok(await wait(`(document.querySelector('.developer-window [aria-current="page"]')?.dataset.tab === "${tab}") && ${check}`), `${tab} works`);
    }
    await click('.developer-window [data-action="apitok-admin"][data-target="system-health"]');
    assert.ok(await wait(`!document.querySelector(".developer-window") && /System Health/.test(document.querySelector(".workspace .page-head h1")?.textContent || "")`), "System Health page, Developer closed");
    assert.ok(await wait(`window.__api.includes("/api/v1/admin/system-health") && !!document.querySelector("#health-root .health-tiles")`), "its report loads");
    assert.ok(await b.evaluate(`!!document.querySelector('[data-action="health-tab"][data-tab="activity"]')`), "admin: Activity History tab");
    assert.equal(await b.evaluate(`document.activeElement?.matches(".workspace .page-head h1")`), true, "focus on the page heading");
    await shot("dev-after-3-system-health-admin");
    // Back to the board, then the People directory from Developer.
    await b.evaluate("history.back()"); // System Health shares "/" with Home: open the board again instead
    await open("on", `/boards/${board.publicId}`);
    assert.ok(await wait(`document.querySelector(".board-title-input")?.value === ${JSON.stringify(board.name)}`), "board again");
    await developer();
    await click('.developer-window [data-action="apitok-admin"][data-target="employees"]');
    assert.ok(await wait(`!document.querySelector(".developer-window") && document.querySelector(".app-shell")?.getAttribute("data-module") === "employees" && location.pathname === "/admin/employees/active"`), "the module, not the modal");
    assert.equal(await b.evaluate(`document.querySelector(".module-exit")?.getAttribute("title")`), `Back to ${board.name}`);
    assert.ok(await wait(`document.activeElement?.id === "employees-title"`), "focus on the directory heading");
    await shot("dev-after-4-people-module");
    await click(".module-exit");
    assert.ok(await wait(`document.querySelector(".board-title-input")?.value === ${JSON.stringify(board.name)} && !document.querySelector(".app-shell[data-layout]")`), "the board is back");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await b.evaluate(`!!document.querySelector(".developer-window")`), false, "Developer is not reopened");
    await shot("dev-after-5-returned");
    await noErrors("owner");
  });

  test("2. viewer (tokens off): Developer shows only Administration (System Health, People directory), opened on that list; redacted System Health without Activity", async () => {
    await signIn("off", "viewer");
    await open("off", "/");
    assert.equal(await sidebarHasAdmin(), false);
    assert.ok(await developer(), "Developer is offered");
    const nav = await devNav();
    assert.deepEqual(nav.tabs, ["admin"], "no API section"); assert.deepEqual(nav.admin, ["system-health", "employees"]);
    assert.equal(nav.current, "admin"); assert.equal(nav.title, "Administration");
    assert.equal(await b.evaluate(`document.querySelectorAll('#apitok-root [data-action="apitok-admin"]').length`), 2, "the list offers both");
    assert.equal(await b.evaluate(`window.__api.some((p) => p.startsWith("/api/v1/me/api-tokens"))`), false, "nothing asked of the token routes");
    await shot("dev-after-6-developer-viewer");
    await click('#apitok-root [data-action="apitok-admin"][data-target="system-health"]');
    assert.ok(await wait(`!!document.querySelector("#health-root .health-tiles")`), "System Health (viewer scope)");
    const page = await json(`({ text: document.querySelector(".workspace")?.innerText || "", activityTab: !!document.querySelector('[data-action="health-tab"][data-tab="activity"]'), tabs: [...document.querySelectorAll('[data-action="health-tab"]')].map((t) => t.dataset.tab) })`);
    assert.deepEqual(page.tabs, ["overview", "integrations"], "no Activity History tab");
    assert.doesNotMatch(page.text, /undefined|NaN|\[object/, "no broken values");
    await click('[data-action="health-tab"][data-tab="integrations"]');
    assert.ok(await wait(`/Google Drive/.test(document.querySelector("#health-root")?.innerText || "")`), "integrations tab");
    assert.doesNotMatch(await b.evaluate(`document.querySelector("#health-root").innerText`), /undefined|NaN/, "integrations: no broken values");
    assert.equal(await b.evaluate(`window.__api.includes("/api/v1/admin/activity")`), false, "the audit trail is never requested");
    // The exact viewer contract (every field the viewer scope keeps; the removed ones absent) renders without gaps.
    const rendered = await json(`(() => { const view = { escape: (v) => String(v), relative: () => "a moment ago", time: () => "01:00" }; const p = new SystemHealthPanel({ view, model: { features: { systemHealth: { view: true, admin: false, activity: false } }, storage: { adapter: { mode: "resource" } } }, auth: {} }); p.health = ${JSON.stringify(VIEWER_HEALTH)}; return { overview: p.overviewHtml(), integrations: p.integrationsHtml(), tabs: p.tabs().map((t) => t[0]) }; })()`);
    for (const [k, html] of Object.entries({ overview: rendered.overview, integrations: rendered.integrations })) assert.doesNotMatch(html, /undefined|NaN|\[object/, `viewer contract, ${k}: no broken values`);
    assert.match(rendered.overview, /By status/); assert.match(rendered.integrations, /1 failed job/); assert.match(rendered.integrations, /sync on/); assert.match(rendered.integrations, /A problem was reported/);
    assert.deepEqual(rendered.tabs, ["overview", "integrations"]);
    await shot("dev-after-7-system-health-viewer");
    await developer();
    await click('.developer-window [data-action="apitok-admin"][data-target="employees"]');
    assert.ok(await wait(`document.querySelector(".app-shell")?.getAttribute("data-module") === "employees" && !document.querySelector(".developer-window")`), "People directory module");
    await noErrors("viewer");
  });

  test("3. viewer (tokens on): the employee API sections exactly as before (no API Keys, Explorer or Activity), plus Administration", async () => {
    await signIn("on", "viewer");
    await open("on", "/");
    await developer();
    const nav = await devNav();
    assert.deepEqual(nav.tabs, EMPLOYEE_API); assert.deepEqual(nav.admin, ["system-health", "employees"]); assert.equal(nav.current, "overview");
    await noErrors("viewer, tokens on");
  });

  test("4. API administrator only: the API sections as before, no Administration; System Health only: that one entry; nobody: no Developer", async () => {
    await signIn("on", "apiadmin");
    await open("on", "/");
    await developer();
    let nav = await devNav();
    assert.deepEqual(nav.tabs, ALL_API); assert.deepEqual(nav.admin, []); assert.equal(nav.sep || nav.caption, false, "no Administration");
    await signIn("off", "health");
    await open("off", "/");
    await developer();
    nav = await devNav();
    assert.deepEqual(nav.tabs, ["admin"]); assert.deepEqual(nav.admin, ["system-health"]);
    await signIn("off", "nobody");
    await open("off", "/");
    assert.equal(await developer({ open: false }), false, "no Developer for nobody (tokens off)");
    assert.equal(await sidebarHasAdmin(), false);
    await signIn("on", "nobody");
    await open("on", "/");
    await developer();
    nav = await devNav();
    assert.deepEqual(nav.tabs, EMPLOYEE_API, "tokens on: the employee API sections, as before"); assert.deepEqual(nav.admin, []);
    await noErrors("personas");
  });

  test("5. a direct People directory link and the System Health page still work; Back / Forward", async () => {
    await signIn("on", "owner");
    await open("on", "/admin/employees/active");
    assert.ok(await wait(`document.querySelector(".app-shell")?.getAttribute("data-module") === "employees"`), "direct link");
    await open("on", `/boards/${board.publicId}`);
    assert.ok(await wait(`document.querySelector(".board-title-input")?.value === ${JSON.stringify(board.name)}`));
    await developer();
    await click('.developer-window [data-action="apitok-admin"][data-target="employees"]');
    assert.ok(await wait(`location.pathname === "/admin/employees/active"`));
    await b.evaluate("history.back()");
    assert.ok(await wait(`document.querySelector(".board-title-input")?.value === ${JSON.stringify(board.name)} && !document.querySelector(".developer-window")`), "Back: the board, Developer closed");
    await b.evaluate("history.forward()");
    assert.ok(await wait(`document.querySelector(".app-shell")?.getAttribute("data-module") === "employees"`), "Forward: the module");
    await noErrors("routing");
  });

  test("6. the Developer window at 360 / 768 / 1440 px in light and dark: navigation fits (scrolls), Administration reachable, Escape closes it", async () => {
    await signIn("on", "owner");
    for (const [width, height] of [[360, 640], [768, 1024], [1440, 900]]) {
      for (const theme of ["light", "dark"]) {
        const label = `${width}px ${theme}`;
        await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
        await open("on", "/", { width, height });
        await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
        await developer();
        const m = await json(`(() => { const n = document.querySelector(".developer-window .settings-nav"), w = document.querySelector(".developer-window").getBoundingClientRect(), last = n.querySelector('[data-action="apitok-admin"]:last-of-type'); last.scrollIntoView({ block: "nearest" }); const r = last.getBoundingClientRect(), nr = n.getBoundingClientRect(); return { sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth, navX: n.scrollWidth - n.clientWidth, win: { left: w.left, right: w.right, vw: document.documentElement.clientWidth }, last: { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, nav: { top: nr.top, bottom: nr.bottom, left: nr.left, right: nr.right } }; })()`);
        assert.equal(m.sideways, 0, `${label}: no sideways page scroll`);
        assert.ok(m.navX <= 1, `${label}: the navigation doesn't overflow sideways ${JSON.stringify(m)}`);
        assert.ok(m.win.left >= -1 && m.win.right <= m.win.vw + 1, `${label}: the window fits`);
        assert.ok(m.last.top >= m.nav.top - 1 && m.last.bottom <= m.nav.bottom + 1 && m.last.left >= m.nav.left - 1 && m.last.right <= m.nav.right + 1, `${label}: People directory reachable inside the navigation ${JSON.stringify(m)}`);
        if (width !== 768) await shot(`dev-after-developer-${width}-${theme}`);
        await b.key("Escape");
        assert.ok(await wait(`!document.querySelector(".developer-window")`), `${label}: Escape closes Developer`);
      }
    }
    await noErrors("responsive");
  });
});
