// Application modules: full-screen apps inside JARC (Teams personal-app style), entered from the sidebar or a direct link.
// While a module is the open screen, AppView draws the module layout (AppView.render: data-layout="module"):
//   - the global header stays (menu, "Back to …", search, notifications, profile); primary navigation opens as a drawer;
//   - the workspace/board tree is not drawn; the module gets the whole remaining viewport (only its inner regions scroll);
//   - "Back to …" (data-action="module-exit") restores the screen, workspace, board and view open before (AppController.exitModule).
// No iframe and no new window: a module is a screen of this page with its own route parser and renderer.
//
// A module entry: { id, screen, label, icon, nav (false: no button above Settings), visible(c), isPath(pathname), parsePath(pathname, search), applyRoute(c, route),
// urlFor(c) → { path, search }, render(view, model) → HTML }. c is the AppController. Adding a module never needs shell code:
// register it here (or from its own file, after this one) and give it a nav button through AppView.moduleNav.
class AppModules {
  static #list = [];
  static register(entry) {
    if (!entry || typeof entry.id !== "string" || typeof entry.screen !== "string") throw new Error("An app module needs an id and a screen");
    if (AppModules.#list.some((m) => m.id === entry.id || m.screen === entry.screen)) throw new Error(`App module "${entry.id}" is already registered`);
    AppModules.#list.push(Object.freeze({ icon: "layout", exitLabel: null, nav: true, ...entry }));
    return entry;
  }
  static all() { return [...AppModules.#list]; }
  static byId(id) { return AppModules.#list.find((m) => m.id === id) || null; }
  // The module whose screen this is (registered, whether or not this person may open it).
  static forScreen(screen) { return AppModules.#list.find((m) => m.screen === screen) || null; }
  // The module this path belongs to (/fabric/… → Fabric), or null.
  static forPath(pathname) { return AppModules.#list.find((m) => { try { return Boolean(m.isPath(pathname)); } catch { return false; } }) || null; }
  static isVisible(m, c) { try { return Boolean(m && c && m.visible(c)); } catch { return false; } }
  // The module open now for this controller: its screen is the model's screen and this person may open it.
  static active(c) { const m = AppModules.forScreen(c?.model?.screen); return m && AppModules.isVisible(m, c) ? m : null; }
  static visibleFor(c) { return AppModules.#list.filter((m) => AppModules.isVisible(m, c)); }
}

// Fabric Data (FabricDataPanel.js): Inventory · Sales · API Management, read-only. References are resolved when called, so the
// load order of the Fabric files doesn't matter.
AppModules.register({
  id: "fabric", screen: "fabric", label: "Fabric Data", icon: "database",
  visible: (c) => Boolean(c.fabric?.visible),
  isPath: (pathname) => typeof FabricDataPanel === "function" && FabricDataPanel.parsePath(pathname || "") !== undefined,
  parsePath: (pathname, search) => (typeof FabricDataPanel === "function" ? FabricDataPanel.parsePath(pathname, search) : undefined),
  applyRoute: (c, route) => Boolean(c.fabric?.applyRoute(route)),
  urlFor: (c) => c.fabric.urlFor(),
  render: (view) => view.fabricPanel.html()
});
// People directory (EmployeesPanel.js, /admin/employees/…): the same module layout as Fabric Data, for the people /features
// names (employees.view). Its button stays in the primary navigation (AppView.sidebar, under Search), so it gets no second one
// above Settings (nav: false). Anyone else who opens its address keeps the existing no-access state in the normal JARC layout
// (AppView.content, AppController.applyBoardUrl): nothing is requested and no module layout is drawn.
AppModules.register({
  id: "employees", screen: "employees", label: "People directory", icon: "people", nav: false,
  visible: (c) => Boolean(c.employees?.visible),
  isPath: (pathname) => typeof EmployeesPanel === "function" && EmployeesPanel.parsePath(pathname || "") !== undefined,
  parsePath: (pathname, search) => (typeof EmployeesPanel === "function" ? EmployeesPanel.parsePath(pathname, search) : undefined),
  applyRoute: (c, route) => Boolean(c.employees?.applyRoute(route)),
  urlFor: (c) => c.employees.urlFor(),
  render: (view) => view.employeesPanel.html()
});
if (typeof window !== "undefined") window.AppModules = AppModules;
