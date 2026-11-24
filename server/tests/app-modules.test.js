// App modules (site/assets/AppModules.js) and the module layout (AppView / AppController): the registry; the module layout
// (no workspace tree, primary navigation as a drawer, "Back to …" in the header); entering remembers the screen, workspace,
// board and view, and leaving restores them (fallbacks: a deleted board → Home; no snapshot → the current board, else Home);
// a direct /fabric/… link starts Fabric without loading any workspace's board list or a board, and JARC's data loads on the
// way back. Unit part: the unchanged browser files in a vm. Browser part: the REAL app (Entra sign-in with local test keys,
// fake MongoDB, the real Fabric backend over the fake client) in headless Chrome/Edge, skipped without one. Synthetic data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { findBrowser, launch, freePort } = require("./support/headless-browser");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");

function load() {
  const sessionStore = new Map();
  const sessionStorage = { getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null), setItem: (k, v) => sessionStore.set(k, String(v)), removeItem: (k) => sessionStore.delete(k) };
  const location = { pathname: "/", search: "", origin: "https://jarc.example.test", protocol: "https:" };
  const window = { location, sessionStorage, localStorage: sessionStorage, history: { pushState() {}, replaceState() {}, state: null }, addEventListener() {}, dispatchEvent() {} };
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } } };
  const context = vm.createContext({ window, document, console, Intl, Date, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, CSS: { escape: (v) => v } });
  for (const f of ["AppView.js", "AppModules.js", "FabricExplorer.js", "FabricDataPanel.js"]) vm.runInContext(read(f), context, { filename: f });
  const source = read("AppController.js"), bootstrap = 'try { new AppController(document.querySelector("#app")); }';
  vm.runInContext(source.slice(0, source.indexOf(bootstrap)), context, { filename: "AppController.js" });
  const get = (name) => vm.runInContext(name, context);
  return { window, sessionStore, get, AppModules: get("AppModules"), AppView: get("AppView"), AppController: get("AppController"), FabricDataPanel: get("FabricDataPanel") };
}

// A model with two workspaces and three boards (synthetic), enough for the view and the return logic.
function stubModel(over = {}) {
  const boards = { w1: [{ id: "b1", name: "Synthetic board one", savedViews: [{ id: "v1", name: "View" }] }, { id: "b2", name: "Synthetic board two", savedViews: [] }], w2: [{ id: "b3", name: "Synthetic board three", savedViews: [] }] };
  const m = {
    workspaces: [{ id: "w1", name: "Synthetic WS", boards: boards.w1 }, { id: "w2", name: "Other WS", boards: boards.w2 }],
    currentWorkspaceId: "w1", currentBoardId: "b1", screen: "board", activeSavedViewId: null, boardLinkProblem: null,
    myWork: [], favoriteBoards: [], settings: { showBoardCounts: false }, profile: { avatar: "", initials: "AR", color: "#0f9489" }, unreadCount: 0,
    features: { fabricData: { read: true } }, storage: { adapter: { mode: "resource", request: async () => ({}) } },
    serverId: (id) => id, opened: [], loaded: [], views: [],
    openScreen(s) { this.screen = s; this.boardLinkProblem = null; this.opened.push(s); },
    ensureBoardRecords(id) { this.loaded.push(id); },
    applyView(id) { this.activeSavedViewId = id; this.views.push(id); },
    boardRecordCount: () => 0, isCustomIcon: () => false, ...over
  };
  Object.defineProperty(m, "workspace", { get() { return this.workspaces.find((w) => w.id === this.currentWorkspaceId); } });
  Object.defineProperty(m, "board", { get() { return this.workspace?.boards.find((b) => b.id === this.currentBoardId); } });
  return m;
}
// A controller with the real AppController methods, the real view and Fabric panel, and the stub model.
function controllerWith(env, model = stubModel()) {
  const c = Object.create(env.AppController.prototype);
  Object.assign(c, { model, ready: true, auth: { authenticated: true } });
  c.view = new env.AppView({ innerHTML: "" }); c.view.moduleController = c;
  c.view.isCustomIcon = () => false; c.view.workspaceIcon = () => "W"; // IconLibrary.js (not loaded here)
  c.view.moduleExitLabel = () => c.moduleReturnLabel();
  c.fabric = new env.FabricDataPanel(c); c.view.fabricPanel = c.fabric;
  c.update = () => {}; c.syncBoardUrl = () => {};
  return c;
}

describe("App modules: the registry", () => {
  const env = load(), M = env.AppModules;
  test("Fabric is registered with its screen, label, icon and paths; ids and screens are unique", () => {
    const f = M.byId("fabric");
    assert.equal(f.screen, "fabric"); assert.equal(f.label, "Fabric Data"); assert.equal(f.icon, "database");
    assert.equal(M.forScreen("fabric"), f); assert.equal(M.forScreen("board"), null); assert.equal(M.forScreen("home"), null);
    for (const p of ["/fabric/inventory", "/fabric/sales/", "/fabric/api", "/fabric/sales-lines", `/fabric/inventory/records/${"a".repeat(24)}`]) assert.equal(M.forPath(p), f, p);
    for (const p of ["/", "/boards/100001", "/fabric", "/fabric/other", "/api/v1/fabric/sales"]) assert.equal(M.forPath(p), null, p);
    assert.throws(() => M.register({ id: "fabric", screen: "x" }), /already registered/);
    assert.throws(() => M.register({ id: "other", screen: "fabric" }), /already registered/);
    assert.throws(() => M.register({ label: "no id" }), /needs an id/);
  });
  test("visible/active follow the person's right (Fabric: features.fabricData.read); a broken visible() hides the module", () => {
    const c = controllerWith(env);
    assert.equal(M.active(c), null, "on a board");
    c.model.screen = "fabric"; assert.equal(M.active(c)?.id, "fabric");
    assert.equal(JSON.stringify(M.visibleFor(c).map((m) => m.id)), '["fabric"]');
    c.model.features = {}; assert.equal(M.active(c), null); assert.equal(M.visibleFor(c).length, 0);
    assert.equal(M.isVisible({ visible: () => { throw new Error("x"); } }, c), false);
  });
});

describe("App modules: the module layout", () => {
  const env = load();
  test("in a module: no workspace tree, primary navigation and the footer stay, the header shows Back to the board", () => {
    const c = controllerWith(env), m = c.model;
    c.enterModule("fabric");
    const mod = c.view.moduleFor(m);
    assert.equal(mod?.id, "fabric");
    const side = c.view.sidebar(m, { module: mod }), top = c.view.topbar(m, { module: mod }), body = c.view.content(m);
    assert.doesNotMatch(side, /nav-tree|workspace-switch|workspace-heading|favorite-nav/);
    for (const s of ['data-screen="home"', 'data-screen="mywork"', 'data-screen="integrations"', 'data-action="command-palette"', 'data-action="settings"', 'nav-fabric active']) assert.ok(side.includes(s), s);
    assert.match(side, /id="sidebar"/);
    assert.match(top, /<button type="button" class="module-exit" data-action="module-exit" data-module="fabric" title="Back to Synthetic board one">/);
    assert.match(top, /<strong class="module-title">Fabric Data<\/strong>/);
    for (const s of ['data-action="toggle-nav"', 'data-action="command-palette" data-place="topbar"', 'data-action="notifications"', 'data-action="profile-menu"']) assert.ok(top.includes(s), s);
    assert.match(body, /^<div class="module-body" data-module-body="fabric"><div class="fx-app"/);
  });
  test("outside a module (and for someone who may not open it) the layout is the usual one", () => {
    const c = controllerWith(env), m = c.model;
    assert.equal(c.view.moduleFor(m), null);
    assert.match(c.view.sidebar(m, { module: null }), /nav-tree/);
    m.features = {}; m.screen = "fabric";
    assert.equal(c.view.moduleFor(m), null, "no right: no module layout");
    assert.doesNotMatch(c.view.sidebar(m, {}), /nav-fabric/);
    assert.match(read("AppView.js"), /`<div class="app-shell"\$\{layout\}>/, "the shell keeps its class; the layout is a data attribute");
  });
  test("the drawer opens at desktop width while a module is open (and only then)", () => {
    const c = controllerWith(env);
    Object.assign(c, { navOpen: false, drawerMedia: { matches: false }, root: { querySelector: () => null } });
    c.applyNav = () => {}; c.flushRefresh = () => {};
    c.setNav(true); assert.equal(c.navOpen, false, "desktop board: no drawer (the sidebar is there)");
    c.enterModule("fabric"); c.setNav(true); assert.equal(c.navOpen, true, "desktop module: drawer");
  });
});

describe("App modules: Back to JARC restores where the person was", () => {
  const env = load();
  const key = "jarc-module-return";
  test("a board with its saved view: restored as it was (no openBoard, so the view isn't reset); the snapshot is cleared", () => {
    const c = controllerWith(env), m = c.model;
    m.activeSavedViewId = "v1";
    c.enterModule("fabric");
    assert.equal(m.screen, "fabric");
    assert.deepEqual(JSON.parse(env.sessionStore.get(key)), { screen: "board", workspaceId: "w1", boardId: "b1", savedViewId: "v1" }, "IDs only");
    m.currentWorkspaceId = "w2"; m.currentBoardId = "b3"; // anything that moved meanwhile
    c.exitModule();
    assert.equal(m.screen, "board"); assert.equal(m.currentWorkspaceId, "w1"); assert.equal(m.currentBoardId, "b1"); assert.equal(m.activeSavedViewId, "v1");
    assert.deepEqual(m.views, [], "the view was still open: not re-applied"); assert.deepEqual(m.loaded, ["b1"]);
    assert.equal(env.sessionStore.has(key), false); assert.equal(c.moduleReturn, null);
  });
  test("a saved view that isn't in memory any more (after a refresh) is opened again from the snapshot", () => {
    const c = controllerWith(env), m = c.model;
    env.sessionStore.set(key, JSON.stringify({ screen: "board", workspaceId: "w1", boardId: "b1", savedViewId: "v1" }));
    m.screen = "fabric"; m.currentBoardId = "b2";
    assert.equal(c.moduleReturnLabel(), "Back to Synthetic board one");
    c.exitModule();
    assert.equal(m.currentBoardId, "b1"); assert.deepEqual(m.views, ["v1"]);
  });
  test("Home, My work, Integrations return there; a deleted or archived board falls back to Home", () => {
    for (const screen of ["home", "mywork", "integrations"]) {
      const c = controllerWith(env), m = c.model; m.screen = screen;
      c.enterModule("fabric"); c.exitModule(); assert.equal(m.screen, screen);
    }
    const c = controllerWith(env), m = c.model;
    c.enterModule("fabric"); m.workspaces[0].boards.shift(); // the board was deleted while in Fabric
    assert.equal(c.moduleReturnLabel(), "Back to JARC");
    c.exitModule(); assert.equal(m.screen, "home");
    const d = controllerWith(env); d.enterModule("fabric"); d.model.workspaces[0].boards[0].archived = true; d.exitModule(); assert.equal(d.model.screen, "home");
  });
  test("no snapshot (a direct link): the current board if it still exists, otherwise Home", () => {
    const c = controllerWith(env), m = c.model; m.screen = "fabric"; m.currentBoardId = "b2";
    assert.equal(c.moduleReturnLabel(), "Back to Synthetic board two");
    c.exitModule(); assert.equal(m.screen, "board"); assert.equal(m.currentBoardId, "b2");
    const d = controllerWith(env); d.model.screen = "fabric"; d.model.currentBoardId = "gone"; d.exitModule(); assert.equal(d.model.screen, "home");
  });
  test("re-entering from inside the module keeps the first snapshot; the session ending forgets it", () => {
    const c = controllerWith(env), m = c.model;
    c.enterModule("fabric"); m.currentBoardId = "b2"; c.enterModule("fabric");
    assert.equal(JSON.parse(env.sessionStore.get(key)).boardId, "b1");
    c.command = null; c.fabric.forget = () => {}; c.applyNav = () => {}; c.view.renderEntraGate = () => {};
    c.showEntraGate("expired");
    assert.equal(env.sessionStore.has(key), false); assert.equal(c.moduleReturn, null);
  });
  test("module-exit works without a workspace (Fabric readers may have none)", () => {
    assert.ok(env.AppController.NO_WORKSPACE_ACTIONS.has("module-exit"));
  });
});

describe("App modules: a direct link starts without JARC's data", () => {
  const env = load();
  test("startShellOnly reads only this browser's appearance and profile; saves wait (no stored per-user state is overwritten)", () => {
    const c = controllerWith(env);
    const stored = { settings: { theme: "dark" }, profile: { name: "Synthetic Person" }, notifications: [], screen: "board", currentBoardId: "b9", recentBoards: [{ boardId: "b9" }] };
    let applied = null;
    c.model.storage.adapter.readUserState = () => stored;
    c.model.applyState = (s) => { applied = s; }; c.model.markPersisted = () => {};
    c.startShellOnly();
    assert.deepEqual(JSON.parse(JSON.stringify(applied)), { settings: { theme: "dark" }, profile: { name: "Synthetic Person" }, notifications: [], workspaces: [] });
    assert.equal(c.shellOnly, true); assert.equal(c.model.shellOnly, true);
    // Saves while shell-only stay in memory (never written), keeping the latest per-person values for loadJarc to restore.
    assert.match(read("BoardModel.js"), /if \(this\.shellOnly\) \{ this\.shellDirty = true; this\.shellKeep = JSON\.parse\(JSON\.stringify\(\{ settings: this\.settings, profile: this\.profile, notifications: this\.notifications, feedSeenAt: this\.feedSeenAt \}\)\); return Promise\.resolve\(true\); \}/);
    // loadJarc stays shell-only until init resolves (no save can write the empty workspace list meanwhile), then restores.
    const ctl = read("AppController.js");
    assert.ok(ctl.indexOf("await m.init({ prefetch })") < ctl.indexOf("m.shellOnly = false;"), "shell-only kept until JARC's data is in");
    assert.match(ctl, /const dirty = m\.shellDirty, keep = m\.shellKeep;/);
  });
  test("only header and Fabric actions run before JARC's data is loaded; everything else loads it first", () => {
    const c = controllerWith(env);
    for (const a of ["fabric-section", "fabric-refresh", "toggle-nav", "notifications", "profile-menu", "theme", "request-logout"]) assert.equal(c.shellAction(a, { dataset: {} }), true, a);
    assert.equal(c.shellAction("nav", { dataset: { screen: "fabric" } }), true);
    for (const [a, screen] of [["nav", "home"], ["module-exit"], ["settings"], ["command-palette"], ["open-board"]]) assert.equal(c.shellAction(a, { dataset: { screen } }), false, a);
  });
});

// ---- The real app in a headless browser
const BROWSER = findBrowser();
describe("App modules in the real app (headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let issuer, person, server, base, b, stack, app;
  const DESKTOP = { width: 1440, height: 900 };
  const PROBE = `(() => { window.__calls = []; window.__errors = [];
    const oe = console.error.bind(console); console.error = (...a) => { window.__errors.push(a.map(String).join(" ")); oe(...a); };
    addEventListener("error", (e) => window.__errors.push("uncaught: " + e.message));
    addEventListener("unhandledrejection", (e) => window.__errors.push("rejection: " + ((e.reason && e.reason.message) || e.reason)));
    const of = window.fetch.bind(window);
    window.fetch = async (input, init) => { const url = typeof input === "string" ? input : input.url; window.__calls.push(url.replace(/^https?:\\/\\/[^/]+/, "")); return of(input, init); };
    const ox = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function (m, u) { window.__calls.push(String(u).replace(/^https?:\\/\\/[^/]+/, "")); return ox.apply(this, arguments); };
  })();`;
  before(async () => {
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
    const { FabricFakeClient, inventoryRows, ID_ONLY } = require("./support/fabric-fake");
    issuer = await createTokenIssuer(); person = issuer.person("Mia ModuleTester");
    const port = await freePort(); base = `http://localhost:${port}`;
    const entra = { ...issuer.config, redirectUri: `${base}/`, appOrigin: base };
    const env = entraEnv({ JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb", FABRIC_DATA_READER_OIDS: person.oid });
    const config = loadConfig(env).fabricData;
    const fabricClient = new FabricFakeClient({ docs: [], indexes: ID_ONLY, inventory: { docs: inventoryRows(40) } });
    stack = createFabricData({ config, logger: { warn() {}, error() {} }, createClient: () => fabricClient });
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => new FakeMongoClient() });
    await connection.connect(); await ensureDatabase(connection.db);
    const dataLayer = createDataLayer({ connection, logger: { error() {} }, fileStore: new MemoryFileStore(), environment: "test" });
    app = createApp({ repository: new MemoryStateRepository(), environment: "test", logger: { error() {}, warn() {} }, dataLayer,
      auth: { mode: "entra", entra, verify: createEntraVerifier({ ...entra, keySet: issuer.keySet }) }, accessPolicy: "development_shared", betaOpenEditing: true,
      apiTokens: { key: crypto.randomBytes(32), adminObjectIds: [], issuePerHour: 1000, maxActive: 1000 }, fabricData: { config, service: stack.service, limiter: fabricLimiter({ perWindow: 100000 }) } });
    server = await new Promise((resolve) => { const s = app.listen(port, "127.0.0.1", () => resolve(s)); });
    b = await launch(BROWSER);
    await b.motionPreference?.("reduce");
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
    await b.open(`${base}/api/v1/health`, DESKTOP);
    const nonce = await b.evaluate(`fetch("/api/v1/auth/sign-in/start", { method: "POST" }).then((r) => r.json()).then((s) => s.nonce)`);
    const idToken = await person.idToken(nonce);
    assert.equal(await b.evaluate(`fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: ${JSON.stringify(idToken)} }) }).then((r) => r.status)`), 201);
    const api = (method, url, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: ${JSON.stringify(JSON.stringify(body))} }); return JSON.stringify(await r.json()); })()`).then(JSON.parse);
    for (let w = 0; w < 2; w += 1) { const ws = await api("POST", "/api/v1/workspaces", { name: `Synthetic WS ${w}` }); for (let k = 0; k < 2; k += 1) await api("POST", `/api/v1/workspaces/${ws.workspace.id}/boards`, { name: `Synthetic board ${w}.${k}` }); }
  });
  after(async () => { await b?.close(); app?.locals.realtime?.closeAll(); await new Promise((r) => (server ? server.close(r) : r())); await stack?.close(); });

  const json = async (expr) => JSON.parse(await b.evaluate(`JSON.stringify(${expr})`));
  const wait = (expr, ms = 15000) => b.waitFor(expr, ms);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const jarcCalls = async () => (await json("window.__calls")).filter((u) => /^\/api\/v1\/(workspaces|boards)\b/.test(u));

  test("a board, then Fabric from the sidebar: module layout without the tree; Back to the board restores it", async () => {
    await b.open(`${base}/`, DESKTOP);
    assert.ok(await wait("!!document.querySelector('.nav-tree [data-action=\"open-board\"]')"), "JARC loaded");
    await click('.nav-tree [data-action="open-board"]');
    assert.ok(await wait("/^\\/boards\\/\\d+$/.test(location.pathname)"), "a board is open");
    const boardPath = await b.evaluate("location.pathname");
    await click(".sidebar-footer .nav-fabric");
    assert.ok(await wait("document.querySelector('.app-shell')?.dataset.layout === 'module' && location.pathname === '/fabric/inventory'"), "Fabric opened");
    assert.equal(await b.evaluate("!!document.querySelector('.nav-tree, .workspace-switch')"), false, "no workspace tree");
    assert.match(await b.evaluate("document.querySelector('.module-exit').textContent"), /Back to Synthetic board/);
    await click(".module-exit");
    assert.ok(await wait(`location.pathname === ${JSON.stringify(boardPath)} && !document.querySelector('.app-shell').dataset.layout`), "back on the same board");
    assert.ok(await b.evaluate("!!document.querySelector('.nav-tree')"));
    assert.deepEqual(await json("window.__errors"), []);
  });

  test("a direct /fabric link loads no workspace, board list or board; the module fills the viewport; JARC loads on the way back", async () => {
    await b.open(`${base}/fabric/inventory`, DESKTOP);
    assert.ok(await wait("document.querySelectorAll('#fabric-root table tbody tr').length > 0 && !document.querySelector('#fabric-root [aria-busy=\"true\"]')"), "inventory rows");
    assert.deepEqual(await jarcCalls(), [], "no /workspaces, /workspaces/:id/boards or /boards/… request");
    assert.equal(await b.evaluate("document.querySelector('.app-shell').dataset.layout"), "module");
    const box = await json(`(() => { const a = document.querySelector('.fx-app').getBoundingClientRect(); return { bottom: Math.round(a.bottom), h: innerHeight, page: document.documentElement.scrollHeight - document.documentElement.clientHeight, side: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
    assert.equal(box.bottom, box.h, "the app reaches the bottom of the viewport"); assert.equal(box.page, 0, "the page doesn't scroll"); assert.equal(box.side, 0);
    // Primary navigation as a drawer at desktop width, without the tree.
    await click('.topbar [data-action="toggle-nav"]');
    assert.ok(await wait("getComputedStyle(document.querySelector('#sidebar')).visibility === 'visible'"), "drawer open");
    assert.equal(await b.evaluate("!!document.querySelector('#sidebar .nav-tree')"), false);
    await click('.topbar [data-action="toggle-nav"]');
    await click(".module-exit");
    assert.ok(await wait("!document.querySelector('.app-shell')?.dataset.layout && !!document.querySelector('.nav-tree')"), "JARC drawn");
    assert.ok((await jarcCalls()).includes("/api/v1/workspaces"), "the workspaces load now");
    assert.deepEqual(await json("window.__errors"), []);
  });

  test("Search from a direct link loads JARC's data first, then opens", async () => {
    await b.open(`${base}/fabric/sales`, DESKTOP);
    assert.ok(await wait("!!document.querySelector('.fx-appbar')"));
    await click('.topbar [data-action="command-palette"]');
    assert.ok(await wait("!!document.querySelector('#overlay-root .command-modal')"), `Command Center opened ${JSON.stringify(await json("window.__errors"))} ${JSON.stringify(await jarcCalls())}`);
    assert.ok((await jarcCalls()).includes("/api/v1/workspaces"));
    assert.equal(await b.evaluate("location.pathname"), "/fabric/sales", "still in Fabric");
    assert.deepEqual(await json("window.__errors"), []);
  });
});
