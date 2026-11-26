// People directory frontend (site/assets/EmployeesPanel.js, EmployeesObjects.js, the FabricExplorer options it uses, and the
// AppView / AppController / EntraAuth integration). Drives the unchanged browser files in a vm with stubbed DOM pieces, a stubbed
// adapter and a fake localStorage: no server, no network. Synthetic data only ("Synthetic Person 1", @example.com, "Dept A").
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
const ID1 = "SyntheticProfileId0001", ID2 = "SyntheticProfileId0002";
const BASE = "/admin/employees";

function fakeStorage() {
  const m = new Map();
  return { map: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear() };
}

function load({ pathname = "/", search = "", profile = true } = {}) {
  const listeners = {};
  const history = { state: null, calls: [], pushState(s, _t, url) { this.calls.push(["push", url]); this.state = s; apply(url); }, replaceState(s, _t, url) { this.calls.push(["replace", url]); this.state = s; apply(url); } };
  const location = { pathname, search, origin: "https://jarc.example.test", protocol: "https:", href: `https://jarc.example.test${pathname}${search}` };
  function apply(url) { const u = new URL(url, location.origin); location.pathname = u.pathname; location.search = u.search; location.href = u.href; }
  const localStorage = fakeStorage(), sessionStorage = fakeStorage(), forbidden = [];
  const window = { location, history, localStorage, sessionStorage, addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); }, dispatchEvent() {} };
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } } };
  const context = vm.createContext({ window, document, console, Intl, Date, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, CSS: { escape: (v) => v },
    indexedDB: { open() { forbidden.push("indexedDB"); throw new Error("indexedDB is not allowed"); } } });
  const files = ["AppView.js", "EntraAuth.js", "AppModules.js", "FabricFieldMeta.js", "FabricRecordView.js", "FabricFilterModel.js", "FabricValuePicker.js", "FabricFilterBuilder.js", "FabricColumnMenu.js", "FabricSavedFilters.js", "FabricExplorer.js", "FabricObjects.js", "FabricDataPanel.js", ...(profile ? ["EmployeeProfile.js"] : []), "EmployeesObjects.js", "EmployeesPanel.js"].filter((f) => fs.existsSync(path.join(ASSETS, f)));
  for (const f of files) vm.runInContext(read(f), context, { filename: f });
  const source = read("AppController.js"), bootstrap = 'try { new AppController(document.querySelector("#app")); }';
  assert.ok(source.includes(bootstrap), "AppController.js still ends with its bootstrap line");
  vm.runInContext(source.slice(0, source.indexOf(bootstrap)), context, { filename: "AppController.js" });
  const get = (name) => vm.runInContext(name, context);
  return { context, window, document, history, location, listeners, localStorage, sessionStorage, forbidden, get, P: get("EmployeesPanel"), O: get("EmployeesObjects"), X: get("FabricExplorer"), AppView: get("AppView"), AppController: get("AppController"), EntraAuth: get("EntraAuth"), FabricDataPanel: get("FabricDataPanel") };
}

// ---- Synthetic answers (the backend contract's shapes)
const SNAP = { ingestedAt: "2026-11-24T06:00:00.000Z", loadedAt: "2026-11-24T06:05:00.000Z", checkedAt: "2026-11-25T08:00:00.000Z", stale: false };
const TEXT_OPS = [{ op: "eq", class: "fast" }, { op: "in", class: "fast" }, { op: "contains", class: "bounded" }, { op: "blank", class: "fast" }];
const FIELDS = [["displayName", "Name"], ["givenName", "First name"], ["surname", "Last name"], ["mail", "Email"], ["userPrincipalName", "Sign-in name"], ["jobTitle", "Job title"], ["department", "Department"], ["officeLocation", "Office"], ["emailDomain", "Email domain"]];
function schema(ds = "active") {
  return { dataset: ds, label: { active: "Active accounts", all: "All accounts", disabled: "Disabled accounts", guests: "Guest accounts" }[ds], advanced: true,
    fields: [...FIELDS.map(([name, label]) => ({ name, label, type: "string", kind: "text", filterable: true, sortable: true, searchable: true, orderable: true, operators: TEXT_OPS, valueSource: "distinct" })),
      { name: "accountCreated", label: "Directory account created", type: "date", kind: "date", filterable: true, sortable: true, orderable: true, operators: [{ op: "between", class: "fast" }], valueSource: "none" }],
    filterModel: { version: 1, limits: { maxDepth: 3, maxConditions: 20, maxGroups: 5, maxListValues: 100, maxText: 200, maxEncoded: 8192, maxN: 3660 } },
    defaultColumns: ["displayName", "jobTitle", "department", "officeLocation", "mail"], searchFields: [{ field: "displayName", match: "contains" }], sorts: [{ name: "name", fields: ["displayName"], default: true }], orderBy: { maxKeys: 3 } };
}
const person = (n, over = {}) => ({ displayName: `Synthetic Person ${n}`, givenName: "Synthetic", surname: `Person ${n}`, mail: `person${n}@example.com`, userPrincipalName: `person${n}@example.com`, jobTitle: "Analyst", department: "Dept A", officeLocation: null, emailDomain: "example.com", ...over });
const records = (snapshot = SNAP) => ({ dataset: "active", fields: ["displayName", "jobTitle", "department", "officeLocation", "mail"], items: [{ id: ID1, values: person(1) }, { id: ID2, values: person(2, { department: null }) }], pagination: { limit: 100, hasMore: false, nextCursor: null }, snapshot });
const STATUS_VIEWER = { snapshot: SNAP, access: { datasets: ["active"], admin: false }, counts: { active: 2 } };
const STATUS_ADMIN = { snapshot: SNAP, access: { datasets: ["active", "all", "disabled", "guests"], admin: true }, counts: { active: 2 } };
const VALUES = { dataset: "active", field: "department", values: [{ value: "Dept A", count: 1 }, { value: null, count: 1, blank: true }], complete: true, snapshot: SNAP };
const VIEWER = { view: true, admin: false, datasets: ["active"] }, ADMIN = { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"] };
const err = (status, serverCode) => Object.assign(new Error("x"), { code: status === 403 ? "FORBIDDEN" : status === 503 ? "SERVICE_UNAVAILABLE" : "VALIDATION_ERROR", cause: { status, serverCode } });
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function panelWith(env, { employees = VIEWER, answers = {}, screen = "employees", me = "user:00000000-0000-4000-8000-000000000001" } = {}) {
  const calls = [];
  const all = { [`${BASE}/status`]: employees?.admin ? STATUS_ADMIN : STATUS_VIEWER, [`${BASE}/active/schema`]: schema("active"), [`${BASE}/all/schema`]: schema("all"), [`${BASE}/active/records`]: records(), [`${BASE}/active/records/${ID1}`]: { id: ID1, values: person(1), snapshot: SNAP }, [`${BASE}/active/values`]: VALUES, [`${BASE}/saved-filters/active`]: { items: [] }, ...answers };
  const adapter = { mode: "resource", async request(method, p, body) { calls.push([method, p, body]); const hit = Object.entries(all).find(([k]) => p === k || p.startsWith(`${k}?`)); if (!hit) throw Object.assign(new Error("no answer"), { code: "NOT_FOUND", cause: { status: 404 } }); if (hit[1] instanceof Error) throw hit[1]; return typeof hit[1] === "function" ? hit[1](p) : hit[1]; } };
  const view = new env.AppView({ innerHTML: "" });
  const controller = { model: { features: employees === null ? {} : { employees }, storage: { adapter }, screen, me, openScreen(s) { this.screen = s; this.boardLinkProblem = null; } }, view, updates: 0, update() { this.updates += 1; }, syncBoardUrl() {} };
  const panel = new env.P(controller);
  view.employeesPanel = panel; controller.employees = panel;
  return { panel, controller, calls, view };
}
// Draws and lets the queued loads answer (status, schema, then records), as the app's render → ensure does.
async function open(panel, rounds = 4) { for (let i = 0; i < rounds; i += 1) { panel.html(); panel.ensure(); await settle(); } return panel.html(); }
const paths = (calls) => calls.map(([, p]) => p);

describe("People directory: addresses", () => {
  const env = load();
  test("parsePath: /admin/employees → active; datasets, records (22-character IDs) and grouping views; anything else is not ours", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(env.P.parsePath("/admin/employees"))), { view: "list", ds: "active", recordId: "", query: JSON.parse(JSON.stringify(env.X.parseQuery(""))) });
    assert.equal(env.P.parsePath("/admin/employees/all").ds, "all");
    assert.equal(env.P.parsePath(`/admin/employees/active/records/${ID1}`).recordId, ID1);
    assert.deepEqual({ ...env.P.parsePath("/admin/employees/groups/department") }, { view: "group", group: "department" });
    assert.equal(env.P.parsePath("/admin/employees/active/records/short").unknown, true, "a malformed record ID opens the default list");
    assert.equal(env.P.parsePath("/fabric/sales"), undefined);
    assert.equal(env.P.parsePath("/admin/system-health"), undefined);
    assert.equal(env.P.parsePath("/admin/employeesX"), undefined);
  });
  test("formatPath and samePath; EntraAuth keeps People directory addresses through sign-in and nothing broader", () => {
    assert.deepEqual({ ...env.P.formatPath({ view: "list", ds: "disabled" }) }, { path: "/admin/employees/disabled", search: "" });
    assert.equal(env.P.formatPath({ view: "list", ds: "active", recordId: ID1 }).path, `/admin/employees/active/records/${ID1}`);
    assert.equal(env.P.formatPath({ view: "group", group: "emailDomain" }).path, "/admin/employees/groups/emailDomain");
    assert.equal(env.P.formatPath({ view: "list", ds: "nope" }).path, "/admin/employees/active");
    assert.ok(env.P.samePath("/admin/employees/active/", "/admin/employees/active"));
    for (const p of ["/admin/employees", "/admin/employees/active", "/admin/employees/guests", `/admin/employees/all/records/${ID1}`, "/admin/employees/groups/jobTitle"]) assert.ok(env.EntraAuth.isAppPath(p), p);
    for (const p of ["/admin/employees/x", "/admin/employees/active/records/1", "/admin/employees/groups/mobilePhone", "/admin/other"]) assert.equal(env.EntraAuth.isAppPath(p), false, p);
    assert.ok(env.EntraAuth.isAppPath("/fabric/sales"), "Fabric addresses unchanged");
  });
});

describe("People directory: gating (viewer, admin, not listed)", () => {
  test("the entry shows only with features.employees.view, in Developer → Administration after System Health (not in the sidebar)", () => {
    const env = load();
    const src = read("AppView.js"), dev = read("ApiTokensPanel.js");
    assert.equal(src.includes('data-screen="employees"'), false, "not in the main sidebar");
    assert.ok(dev.indexOf('["employees", "People directory"') > dev.indexOf('["system-health", "System Health"'), "after System Health");
    for (const employees of [null, { view: false, admin: true }]) {
      const { panel } = panelWith(env, { employees });
      assert.equal(panel.visible, false);
    }
    const { panel } = panelWith(env, { employees: VIEWER });
    assert.equal(panel.visible, true); assert.equal(panel.admin, false);
    assert.match(dev, /\["employees", "People directory", "people"/, "its label and icon");
    assert.match(dev, /id === "system-health" \? Boolean\(this\.c\.health\?\.visible\) : Boolean\(this\.c\.employees\?\.visible\)/, "shown with employees.view only");
  });
  test("not listed: the no-access state, no request, no data; a direct address still shows only that", async () => {
    const env = load({ pathname: `/admin/employees/all/records/${ID1}` });
    const { panel, controller, calls } = panelWith(env, { employees: null, screen: "home" });
    const ctrl = { boardLinksEnabled: true, model: controller.model, employees: panel, ready: true, signedIn: true, boardUrlStart: false };
    assert.equal(env.AppController.prototype.applyBoardUrl.call(ctrl, {}), true);
    assert.equal(controller.model.screen, "employees");
    const html = await open(panel);
    assert.match(html, /You don&#39;t have access to the people directory\.|You don't have access to the people directory\./);
    assert.doesNotMatch(html, /Synthetic|example\.com|employees-objects/);
    assert.equal(calls.length, 0, "nothing is asked of the server");
    env.AppController.prototype.syncBoardUrl.call(ctrl);
    assert.equal(env.location.pathname, "/admin/employees/active", "the address names no record or admin list");
  });
  test("viewer: Active accounts, Group by and My saved filters; no admin lists; a direct admin address shows no access", async () => {
    const env = load();
    const { panel, calls } = panelWith(env, { employees: VIEWER });
    const html = await open(panel);
    assert.match(html, /<h1 class="fx-appbar__title" id="employees-title" tabindex="-1">People directory<\/h1>/);
    assert.match(html, /JARC administration · Source: Microsoft Entra ID snapshot · updated <time/);
    assert.match(html, /id="emp-obj-active"[^>]*aria-current="page"/);
    for (const g of ["department", "jobTitle", "officeLocation", "emailDomain"]) assert.match(html, new RegExp(`id="emp-obj-group-${g}"`));
    assert.match(html, /My saved filters/);
    for (const ds of ["all", "disabled", "guests"]) assert.doesNotMatch(html, new RegExp(`emp-obj-${ds}"|/admin/employees/${ds}`));
    assert.doesNotMatch(html, /Administrators only/);
    const visible = html.replace(/<[^>]+>/g, " ");
    assert.doesNotMatch(visible, /Fabric/i, "no Fabric wording visible");
    assert.doesNotMatch(html, /(title|aria-label|placeholder)="[^"]*Fabric/i, "nor in titles and labels");
    // A typed admin address (a list or one of its profiles): "only for directory administrators" (not the no-access text), a way
    // to Active accounts, and nothing requested for it.
    for (const address of ["/admin/employees/disabled", "/admin/employees/all", "/admin/employees/guests", `/admin/employees/all/records/${ID1}`]) {
      assert.equal(panel.applyRoute(env.P.parsePath(address)), true, address);
      const denied = await open(panel), body = denied.slice(denied.indexOf('id="employees-body"'));
      assert.match(body, /class="fx-status fx-status--warn fx-status--block emp-admin-only" role="alert"/, address);
      assert.match(body, /<strong class="emp-state__title">Administrators only<\/strong> <span class="emp-state__msg">This list is only for directory administrators\.<\/span>/, address);
      assert.doesNotMatch(body, /have access to the people directory/, address);
      assert.match(body, /<a class="fx-btn" href="\/admin\/employees\/active" data-action="emp-open-active"[^>]*>Open Active accounts<\/a>/, address);
      assert.doesNotMatch(body, /Synthetic/, address);
      panel.openDataset("active", { focus: false });
    }
    assert.ok(!paths(calls).some((p) => /^\/admin\/employees\/(all|disabled|guests)\//.test(p)), "no admin data requested");
    // The button opens Active accounts.
    panel.applyRoute(env.P.parsePath("/admin/employees/guests"));
    panel.onAction("emp-open-active", { tagName: "A", dataset: { action: "emp-open-active" }, closest: () => null }, { preventDefault() {} });
    assert.equal(panel.forbiddenView, false); assert.equal(panel.route.ds, "active"); assert.equal(panel.urlFor().path, "/admin/employees/active");
    assert.match(await open(panel), /Synthetic Person 1/);
  });
  test("no-access: title and text are separate pieces (not run together)", async () => {
    const env = load();
    const { panel } = panelWith(env, { employees: null });
    const html = panel.html();
    assert.match(html, /<span class="fx-status__text"><strong class="emp-state__title">No access<\/strong> <span class="emp-state__msg">You don&#39;t have access to the people directory\. Ask a JARC administrator if you need it\.<\/span><\/span>/);
    const css = read("employees.css");
    assert.match(css, /\.emp-state__title \{ display: block;/);
    const un = panelWith(env, { answers: { [`${BASE}/status`]: err(503, "EMPLOYEES_UNAVAILABLE") } });
    assert.match(await open(un.panel), /<strong class="emp-state__title">Directory unavailable<\/strong> <span class="emp-state__msg">/);
  });
  test("one Refresh: the list's toolbar has it, so the heading has none; group views and profiles keep the heading's", async () => {
    const env = load();
    const { panel } = panelWith(env);
    const list = await open(panel);
    assert.doesNotMatch(list, /data-action="emp-refresh"/);
    assert.equal((list.match(/data-action="fabric-refresh"/g) || []).length, 1, "the toolbar's Refresh");
    panel.openGroup("department", { focus: false });
    assert.match(await open(panel), /data-action="emp-refresh"[^>]*aria-label="Refresh"/);
    panel.openDataset("active", { focus: false });
    panel.explorers.active.openRecord(ID1);
    const profile = await open(panel);
    assert.match(profile, /data-action="emp-refresh"/); assert.doesNotMatch(profile, /data-action="fabric-refresh"/);
  });
  test("the navigation toggle uses the list icon, not the shell's menu icon; its label is unchanged", async () => {
    const env = load();
    const { panel } = panelWith(env);
    const html = await open(panel), icon = env.get("icon");
    const toggle = html.match(/<button type="button" id="employees-objects-toggle"[\s\S]*?<\/button>/)[0];
    assert.ok(toggle.includes(icon("list"))); assert.ok(!toggle.includes(icon("menu")));
    assert.match(toggle, /aria-label="Directory navigation"/);
  });
  test("admin: the admin lists are drawn and open", async () => {
    const env = load();
    const { panel, calls } = panelWith(env, { employees: ADMIN, answers: { [`${BASE}/all/records`]: { ...records(), dataset: "all" } } });
    const html = await open(panel);
    for (const ds of ["all", "disabled", "guests"]) assert.match(html, new RegExp(`id="emp-obj-${ds}"[^>]*>|href="/admin/employees/${ds}"`));
    assert.match(html, /Administrators only/);
    panel.applyRoute(env.P.parsePath("/admin/employees/all"));
    await open(panel);
    assert.ok(paths(calls).some((p) => p.startsWith(`${BASE}/all/records?`)));
  });
});

describe("People directory: list, profile and grouping", () => {
  test("the default dataset is Active accounts; requests use /admin/employees; record links use the people addresses", async () => {
    const env = load();
    const { panel, calls } = panelWith(env);
    const html = await open(panel);
    const p = paths(calls);
    assert.ok(p.includes(`${BASE}/status`)); assert.ok(p.includes(`${BASE}/active/schema`));
    const rec = p.find((x) => x.startsWith(`${BASE}/active/records?`));
    assert.ok(rec, "records requested");
    assert.equal(new URLSearchParams(rec.split("?")[1]).get("fields"), "displayName,jobTitle,department,officeLocation,mail");
    assert.ok(!p.some((x) => x.startsWith("/fabric")), "never a Fabric path");
    assert.match(html, new RegExp(`href="/admin/employees/active/records/${ID1}" data-action="fabric-x-open" data-ds="active" data-id="${ID1}"`));
    assert.match(html, /<th scope="col"[^>]*>(<button[^>]*>)?Name/, "column labels from the schema");
    assert.match(html, /Synthetic Person 1/);
  });
  test("a profile opens with EmployeeProfile, its back action goes through the explorer", async () => {
    const env = load();
    const { panel, calls, controller } = panelWith(env);
    await open(panel);
    panel.onAction("fabric-x-open", { tagName: "A", dataset: { ds: "active", id: ID1 }, closest: () => null }, { preventDefault() {} });
    assert.equal(panel.explorers.active.recordId, ID1);
    const html = await open(panel);
    assert.ok(paths(calls).includes(`${BASE}/active/records/${ID1}`));
    if (typeof env.get("EmployeeProfile") === "function") assert.match(html, /class="emp-profile"/);
    assert.equal(panel.urlFor().path, `/admin/employees/active/records/${ID1}`);
    const before = controller.updates;
    panel.onAction("emp-p-back", { tagName: "A", dataset: { ds: "active" }, closest: () => null }, { preventDefault() {} });
    assert.equal(panel.explorers.active.recordId, "");
    assert.ok(controller.updates > before);
  });
  test("without EmployeeProfile.js the record view is the basic allow-listed list", async () => {
    const env = load({ profile: false });
    const { panel } = panelWith(env);
    await open(panel);
    panel.explorers.active.openRecord(ID1);
    const html = await open(panel);
    assert.match(html, /emp-basic-record/); assert.match(html, /Directory account/); assert.match(html, /<dt>Name<\/dt>/);
  });
  test("grouping view: values with counts and Unassigned; a value opens the list filtered eq, Unassigned filters blank", async () => {
    const env = load();
    const { panel, calls } = panelWith(env);
    panel.applyRoute(env.P.parsePath("/admin/employees/groups/department"));
    const html = await open(panel);
    const v = paths(calls).find((p) => p.startsWith(`${BASE}/active/values?`));
    assert.ok(v); const q = new URLSearchParams(v.split("?")[1]);
    assert.equal(q.get("field"), "department"); assert.equal(q.get("limit"), "500");
    assert.match(html, /<table class="fx-grid__table emp-group__table"><caption class="sr-only">/);
    assert.match(html, /data-action="emp-group-open" data-group="department" data-blank="false" data-value="Dept A"[^>]*>Dept A</);
    assert.match(html, /data-blank="true"[^>]*><span class="emp-group__unassigned">Unassigned<\/span>/);
    assert.match(html, /<td class="fx-grid__num fabric-num">1<\/td>/);
    assert.equal(panel.urlFor().path, "/admin/employees/groups/department");
    panel.onAction("emp-group-open", { tagName: "A", dataset: { group: "department", blank: "false", value: "Dept A" }, closest: () => null }, { preventDefault() {} });
    assert.equal(panel.route.view, "list"); assert.equal(panel.route.ds, "active");
    assert.deepEqual(JSON.parse(JSON.stringify(panel.explorers.active.query.filter.items)), [{ field: "department", op: "eq", value: "Dept A" }]);
    await open(panel);
    const rec = paths(calls).filter((p) => p.startsWith(`${BASE}/active/records?`)).at(-1);
    assert.ok(new URLSearchParams(rec.split("?")[1]).get("filter"), "the filter is sent");
    panel.openGroup("department"); await open(panel);
    panel.onAction("emp-group-open", { tagName: "A", dataset: { group: "department", blank: "true", value: "" }, closest: () => null }, { preventDefault() {} });
    assert.deepEqual(JSON.parse(JSON.stringify(panel.explorers.active.query.filter.items)), [{ field: "department", op: "blank" }]);
  });
});

describe("People directory: snapshot and failure states", () => {
  test("a stale snapshot shows the warning banner", async () => {
    const env = load();
    const stale = { ...SNAP, stale: true, staleReason: "refresh failed" };
    const { panel } = panelWith(env, { answers: { [`${BASE}/status`]: { ...STATUS_VIEWER, snapshot: stale }, [`${BASE}/active/records`]: records(stale) } });
    const html = await open(panel);
    assert.match(html, /class="fx-status fx-status--warn emp-stale" role="status"/);
    assert.match(html, /The directory snapshot may be out of date/);
    assert.doesNotMatch(html, /refresh failed/, "the server's reason text isn't shown");
  });
  test("403 from the server: the no-access state, everything loaded is dropped", async () => {
    const env = load();
    const { panel } = panelWith(env, { answers: { [`${BASE}/active/records`]: err(403, "EMPLOYEES_FORBIDDEN") } });
    const html = await open(panel);
    assert.equal(panel.denied, true);
    assert.match(html, /have access to the people directory/);
    assert.equal(panel.explorers.active.info, null);
    assert.doesNotMatch(html, /Synthetic/);
  });
  test("503: the directory is temporarily unavailable (status and list)", async () => {
    const env = load();
    const { panel } = panelWith(env, { answers: { [`${BASE}/status`]: err(503, "EMPLOYEES_UNAVAILABLE") } });
    const html = await open(panel);
    assert.match(html, /The directory is temporarily unavailable\./);
    const other = panelWith(env, { answers: { [`${BASE}/active/records`]: err(503, "EMPLOYEES_UNAVAILABLE") } });
    const h2 = await open(other.panel);
    assert.match(h2, /Directory unavailable/); assert.match(h2, /temporarily unavailable/);
    assert.equal(env.P.errorInfo(err(404)).code, "NOT_FOUND");
  });
  test("loading state: a skeleton while the schema loads", () => {
    const env = load();
    const { panel } = panelWith(env, { answers: { [`${BASE}/active/schema`]: () => new Promise(() => {}) } });
    panel.html(); panel.ensure();
    assert.match(panel.html(), /fabric-loading/);
  });
});

describe("People directory: action routing and storage", () => {
  const target = (root, action, over = {}) => ({ tagName: "BUTTON", dataset: { action, ds: "active", ...over }, closest: (sel) => (sel.split(",").some((s) => s.trim() === root || s.trim().startsWith(`${root} `) || s.trim() === "[data-action]") ? target(root, action, over) : null) });
  test("fabric-* actions from #employees-root go to the People directory, from #fabric-root to Fabric Data", () => {
    const env = load();
    const seen = [];
    const ctrl = Object.create(env.AppController.prototype);
    Object.assign(ctrl, { auth: {}, shellOnly: false, integrations: null, health: null, model: { screen: "employees" }, employees: { onAction: (a) => seen.push(["employees", a]) }, fabric: { onAction: (a) => seen.push(["fabric", a]) } });
    const click = (t) => env.AppController.prototype.onClick.call(ctrl, { target: { closest: () => t } });
    click(target("#employees-root", "fabric-x-page"));
    click(target("#fabric-root", "fabric-x-page"));
    click(target("#employees-root", "emp-o-ds"));
    assert.deepEqual(seen, [["employees", "fabric-x-page"], ["fabric", "fabric-x-page"], ["employees", "emp-o-ds"]]);
    assert.equal(ctrl.peopleAction("fabric-x-page", target("#fabric-root", "fabric-x-page")), false);
    assert.equal(ctrl.peopleAction("fabric-s-rename", target("#overlay-root .fx-sf-dialog", "fabric-s-rename")), true, "its saved-filter dialog");
    ctrl.model.screen = "fabric";
    assert.equal(ctrl.peopleAction("fabric-s-rename", target("#overlay-root .fx-sf-dialog", "fabric-s-rename")), false, "Fabric's own dialog");
  });
  test("the explorer actions reach only the People directory's explorers (allowed datasets only)", async () => {
    const env = load();
    const { panel } = panelWith(env);
    await open(panel);
    assert.equal(panel.explorerFor({ dataset: { ds: "active" } }), panel.explorers.active);
    assert.equal(panel.explorerFor({ dataset: { ds: "all" } }), null, "a viewer's admin list");
    assert.equal(panel.explorerFor({ dataset: { ds: "sales" } }), null);
  });
  test("no directory value in localStorage, sessionStorage or IndexedDB: column names and node IDs only", async () => {
    const env = load();
    const { panel } = panelWith(env);
    await open(panel);
    panel.explorers.active.toggleColumn("surname", true);
    panel.onAction("emp-o-toggle", { tagName: "SPAN", dataset: { oId: "saved" }, closest: () => null }, { preventDefault() {}, stopPropagation() {} });
    panel.openGroup("department"); await open(panel);
    panel.explorers.active.openRecord(ID1); panel.route = { view: "list", ds: "active", group: "" }; await open(panel);
    const dump = JSON.stringify([...env.localStorage.map.entries(), ...env.sessionStorage.map.entries()]);
    assert.doesNotMatch(dump, /Synthetic|example\.com|Dept A|SyntheticProfileId/);
    for (const [k, v] of env.localStorage.map) {
      assert.match(k, /^jarc\.employees\.objects\.|^jarc\.fabric\.columns\.[^.]+\.(active|all|disabled|guests)$/, k);
      if (k.startsWith("jarc.fabric.columns.")) assert.ok(JSON.parse(v).every((n) => FIELDS.some(([f]) => f === n) || n === "accountCreated"));
    }
    assert.deepEqual(env.forbidden, []);
  });
  test("sign-out forgets everything", async () => {
    const env = load();
    const { panel } = panelWith(env);
    await open(panel);
    assert.ok(panel.explorers.active.records.data);
    for (const fn of env.listeners["jarc-session-expired"] || []) fn();
    assert.equal(panel.explorers.active.records.data, null); assert.equal(panel.status, null);
  });
});

describe("FabricExplorer options: Fabric defaults unchanged", () => {
  test("a Fabric explorer keeps every /fabric path; an Employees one uses its own", () => {
    const env = load();
    const panel = { c: { model: {}, auth: {} }, esc: (v) => String(v), attr: (v) => String(v) };
    const f = new env.X(panel, "sales"), e = new env.X(panel, "active", { apiBase: BASE, routeBase: BASE, idPattern: /^[A-Za-z0-9_-]{22}$/, savedFiltersBase: `${BASE}/saved-filters` });
    assert.equal(f.schemaPath(), "/fabric/sales/schema"); assert.equal(f.listHref(), "/fabric/sales"); assert.equal(f.recordApiPath("a".repeat(24)), `/fabric/sales/records/${"a".repeat(24)}`);
    assert.equal(f.recordHref("a".repeat(24)), `/fabric/sales/records/${"a".repeat(24)}`);
    assert.equal(f.rootSelector, "#fabric-root"); assert.equal(f.recordRenderer, null); assert.equal(f.storageKey, "");
    assert.equal(f.validId("a".repeat(24)), true); assert.equal(f.validId(ID1), false);
    assert.equal(e.schemaPath(), `${BASE}/active/schema`); assert.equal(e.listHref(), `${BASE}/active`);
    assert.equal(e.validId(ID1), true); assert.equal(e.validId("a".repeat(24)), false);
    const S = env.get("FabricSavedFilters"), V = env.get("FabricValuePicker");
    assert.equal(S.path(f), "/fabric/saved-filters/sales"); assert.equal(S.path(e, "x1"), `${BASE}/saved-filters/active/x1`);
    assert.equal(S.path({ ds: "inventory" }), "/fabric/saved-filters/inventory", "a plain object: Fabric's base");
    const vp = (x) => { const p = Object.create(V.prototype); p.x = x; p.ds = x.ds; p.field = "Company"; p.q = ""; p.limit = 50; return p.path(null); };
    assert.match(vp(f), /^\/fabric\/sales\/values\?field=Company/); assert.match(vp(e), /^\/admin\/employees\/active\/values\?field=Company/);
  });
  test("dateWindow: Fabric keeps its date wording by default; the directory (dateWindow false) has none", async () => {
    const env = load();
    assert.equal(env.X.defaultOptions().dateWindow, true);
    const panel = { c: { model: {}, auth: {} }, esc: (v) => String(v), attr: (v) => String(v) };
    const f = new env.X(panel, "sales");
    f.records.data = { items: [] };
    assert.equal(f.hasDateWindow, true); assert.equal(f.windowText(), "Showing all dates");
    // The directory: no footer date text, an empty state without dates.
    const { panel: people } = panelWith(env, { answers: { [`${BASE}/active/records`]: { ...records(), items: [] } } });
    const x = people.explorers.active;
    assert.equal(x.opts.dateWindow, false); assert.equal(x.hasDateWindow, false);
    const empty = await open(people);
    assert.match(empty, /<strong>No rows match<\/strong><small>Try another filter or different search text\.<\/small>/);
    assert.doesNotMatch(empty, /dates/i);
    const other = panelWith(env);
    const list = await open(other.panel);
    assert.match(list, /fx-gridfoot/); assert.doesNotMatch(list, /Showing all dates|fabric-window|dates/i);
    assert.equal(other.panel.explorers.active.windowText(), "");
  });
});
