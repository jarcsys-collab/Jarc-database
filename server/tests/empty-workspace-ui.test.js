// Empty shared database: the full application layout stays visible with an invitation to create the first workspace.
// Drives the unchanged browser files (BoardModel + StorageService + ResourceApiAdapter + AppView + AppController) in
// Node against the real resource API on a fake MongoDB. AppView renders into a stub root (HTML text); AppController's
// action guard is tested on its prototype (its last line, which starts the real app, is not run here).
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { startMongoApp, api } = require("./helpers");
const { loadBrowser } = require("./support/browser-model");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");

// AppView in its own context with the few DOM pieces it touches; render() writes HTML text into `root`.
function loadView() {
  const overlay = { innerHTML: "", dataset: {}, querySelector: () => null, children: [] };
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: (sel) => (sel === "#overlay-root" ? overlay : null), body: { classList: { add() {}, remove() {}, contains: () => false } } };
  const window = {};
  const context = vm.createContext({ window, document, console, Intl, Date, URL, encodeURIComponent });
  vm.runInContext(fs.readFileSync(path.join(ASSETS, "AppView.js"), "utf8"), context, { filename: "AppView.js" });
  const root = { innerHTML: "" };
  return { view: new window.AppView(root), root, overlay };
}
// AppController's class without starting the app.
function loadControllerClass() {
  const source = fs.readFileSync(path.join(ASSETS, "AppController.js"), "utf8");
  const bootstrap = 'try { new AppController(document.querySelector("#app")); }';
  assert.ok(source.includes(bootstrap), "AppController.js still ends with its bootstrap line");
  const window = {};
  const context = vm.createContext({ window, console, StorageError: class {} });
  vm.runInContext(source.slice(0, source.indexOf(bootstrap)) + "\nglobalThis.AppController = AppController;", context, { filename: "AppController.js" });
  return context.AppController;
}

let app;
const call = (method, p, body) => api(app.url, method, p, body);
async function tab(fetchImpl) {
  const browser = loadBrowser();
  const model = browser.newResourceModel({ baseUrl: `${app.url}/api/v1`, ...(fetchImpl ? { fetchImpl } : {}) });
  await model.init();
  return model;
}

before(async () => { app = await startMongoApp(); });
after(async () => { await app.close(); });
beforeEach(async () => {
  app.fake.down = false;
  for (const w of (await call("GET", "/api/v1/workspaces")).body.items) await call("DELETE", `/api/v1/workspaces/${w.id}?expectedVersion=${w.version}`);
});

describe("Empty database: layout persists", () => {
  test("zero workspaces → the full app layout with the empty-state panel in the main area (not a full-screen message)", async () => {
    const model = await tab();
    assert.equal(model.workspaces.length, 0);
    const { view, root } = loadView();
    view.render(model);
    const html = root.innerHTML;
    for (const part of ['class="app-shell"', 'class="sidebar"', 'class="topbar"', 'data-action="profile-menu"', 'data-action="settings"', 'data-screen="home"', 'data-action="command-palette"', '<main class="workspace">']) assert.ok(html.includes(part), `layout keeps ${part}`);
    assert.ok(!html.includes("first-run"), "the old full-screen replacement is gone");
    assert.match(html, /<main class="workspace">[\s\S]*class="no-workspace"[\s\S]*Create your first workspace/);
    assert.match(html, /class="button primary no-workspace-create" data-action="create-workspace"/, "prominent button in the panel");
    assert.match(html, /class="nav-empty-workspaces"[\s\S]*data-action="create-workspace"/, "creation action in the sidebar");
    assert.match(html, /aria-label="Create workspace"/, "the sidebar + button keeps its accessible name");
    assert.match(html, /Get started/);
    assert.ok(html.includes("saved to the shared database"), "resource mode explains where it is saved");
    assert.equal((await call("GET", "/api/v1/workspaces")).body.items.length, 0, "rendering creates nothing (no demo data)");
  });

  test("every screen and the Workspace settings section render without a workspace", async () => {
    const model = await tab();
    const { view, root, overlay } = loadView();
    for (const screen of ["home", "mywork", "board"]) {
      model.screen = screen;
      view.render(model);
      assert.ok(root.innerHTML.includes('class="no-workspace"'), screen);
    }
    view.overlay = (html) => { overlay.innerHTML = html; };
    view.showSettings(model, "workspace");
    assert.match(overlay.innerHTML, /No workspace yet[\s\S]*data-action="create-workspace"/);
  });
});

describe("Creating the first workspace", () => {
  test("Create workspace saves through the API; sidebar and main content switch to it at once; nothing else is created", async () => {
    const model = await tab();
    const { view, root } = loadView();
    view.render(model);
    const outcome = await model.applyAfterSave(() => model.createWorkspace({ name: "Operations" }));
    assert.ok(outcome.ok, outcome.code);
    view.render(model);
    const html = root.innerHTML;
    assert.ok(!html.includes('class="no-workspace"'));
    assert.match(html, /class="workspace-switch"[\s\S]*<strong>Operations<\/strong>/, "sidebar shows the new workspace");
    assert.match(html, /<div class="eyebrow">Operations<\/div>/, "main content is the workspace home");
    assert.match(html, /No boards yet/);
    const server = (await call("GET", "/api/v1/workspaces")).body.items;
    assert.deepEqual(server.map((w) => w.name), ["Operations"]);
    assert.equal(server[0].id, model.workspace.id, "the browser uses the server's ID");
    const boards = (await call("GET", `/api/v1/workspaces/${server[0].id}/boards`)).body.items;
    assert.equal(boards.length, 0, "no demo boards or records");
  });

  test("another browser loading afterwards sees the workspace from the shared database", async () => {
    const a = await tab();
    assert.ok((await a.applyAfterSave(() => a.createWorkspace({ name: "Shared from A" }))).ok);
    const b = await tab();
    const { view, root } = loadView();
    view.render(b);
    assert.match(root.innerHTML, /<strong>Shared from A<\/strong>/);
  });

  test("a rejected creation (server error) leaves the empty state, with no phantom workspace", async () => {
    const model = await tab();
    app.fake.down = true;
    const outcome = await model.applyAfterSave(() => model.createWorkspace({ name: "Never saved" }));
    app.fake.down = false;
    assert.equal(outcome.ok, false);
    assert.equal(model.workspaces.length, 0);
    const { view, root } = loadView();
    view.render(model);
    assert.ok(root.innerHTML.includes('class="no-workspace"'));
    assert.equal((await call("GET", "/api/v1/workspaces")).body.items.length, 0);
  });
});

describe("Loading failures are not an empty database", () => {
  test("the workspace list failing at startup rejects init (the controller shows the recovery screen), never an empty app", async () => {
    for (const failure of [
      () => Promise.resolve(new Response(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "Database unavailable." } }), { status: 503, headers: { "Content-Type": "application/json" } })),
      () => Promise.reject(new TypeError("Failed to fetch"))
    ]) {
      const browser = loadBrowser();
      const model = browser.newResourceModel({ baseUrl: `${app.url}/api/v1`, fetchImpl: failure, timeoutMs: 2000 });
      await assert.rejects(model.init(), (error) => error?.name === "StorageError" && ["SERVICE_UNAVAILABLE", "NETWORK_ERROR", "OFFLINE"].includes(error.code));
    }
    const recovered = await tab();
    assert.equal(recovered.workspaces.length, 0, "a later retry loads normally");
  });

  test("the controller's start() sends a load failure to the recovery screen before anything renders", () => {
    const source = fs.readFileSync(path.join(ASSETS, "AppController.js"), "utf8");
    const start = source.slice(source.indexOf("  async start() {"), source.indexOf("  update() {"));
    assert.match(start, /catch \(error\) \{[\s\S]*renderStartupRecovery\(this\.root, error/);
    assert.ok(start.indexOf("renderStartupRecovery(this.root, error") < start.indexOf("this.update()"), "recovery comes before the first render");
  });
});

describe("Actions with no workspace", () => {
  const Controller = loadControllerClass();
  const controller = (workspaces = []) => {
    const calls = [];
    const c = Object.create(Controller.prototype);
    c.model = { workspaces };
    c.view = { closeOverlay: () => calls.push("closeOverlay"), showWorkspaceForm: () => calls.push("showWorkspaceForm") };
    return { c, calls };
  };
  const click = (c, action) => c.onClick({ target: { closest: () => ({ dataset: { action } }) } });

  test("actions that need a workspace open Create workspace instead (no crash, nothing else runs)", () => {
    for (const action of ["new-board", "home-create-record", "home-import", "import", "workspace-menu", "workspace-manage", "open-form", "board-menu", "export-backup"]) {
      const { c, calls } = controller();
      click(c, action);
      assert.deepEqual(calls, ["closeOverlay", "showWorkspaceForm"], action);
    }
    for (const command of ["new-board", "new-record", "import"]) {
      const { c, calls } = controller();
      c.runCommand(command);
      assert.deepEqual(calls, ["closeOverlay", "showWorkspaceForm"], command);
    }
    const { c, calls } = controller();
    c.chooseBoardAction("record"); // the "n" shortcut
    assert.deepEqual(calls, ["closeOverlay", "showWorkspaceForm"]);
  });

  test("layout, profile, settings, theme and sign-out actions stay available; with a workspace nothing is intercepted", () => {
    for (const action of ["create-workspace", "nav", "settings", "settings-section", "profile-menu", "notifications", "theme", "toggle-nav", "collapse-nav", "command-palette", "request-logout", "confirm-logout", "shortcuts"]) {
      const { c } = controller();
      assert.equal(c.needsWorkspace(Controller.NO_WORKSPACE_ACTIONS.has(action)), false, action);
    }
    const { c, calls } = controller([{ id: "w1" }]);
    assert.equal(c.needsWorkspace(false), false);
    assert.deepEqual(calls, []);
  });
});

describe("Browser-only local mode", () => {
  test("local mode still starts with its own workspace and the normal home screen", async () => {
    const browser = loadBrowser();
    const model = new browser.window.BoardModel(new browser.window.StorageService(new browser.window.LocalAsyncAdapter()));
    await model.init();
    assert.ok(model.workspaces.length >= 1);
    const { view, root } = loadView();
    view.render(model);
    assert.ok(root.innerHTML.includes('class="app-shell"'));
    assert.ok(!root.innerHTML.includes('class="no-workspace"'));
    assert.ok(root.innerHTML.includes('class="workspace-switch"'));
  });
});
