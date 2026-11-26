// People directory P2 frontend (Employee Access Visibility): the profile's Profile | JARC access tabs (EmployeeProfile.js +
// EmployeeAccess.js), the /access address, loading / error / stale / not-registered states, the "Disabled with JARC access"
// navigation item, and the "JARC access" field group in Columns and Filters (FabricExplorer fieldGroups option; Fabric's
// defaults unchanged). The unchanged browser files run in a vm with a stubbed adapter answering per contract P2 §4/§5:
// no server, no network. Synthetic data only (example.com, "Synthetic …").
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
const ID1 = "SyntheticProfileId0001", ID2 = "SyntheticProfileId0002";
const BASE = "/admin/employees";
const HOSTILE = `<script>alert(1)</script>"><img src=x onerror="alert(2)">`;

function fakeStorage() {
  const m = new Map();
  return { map: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear() };
}
function load() {
  const location = { pathname: "/", search: "", origin: "https://jarc.example.test", href: "https://jarc.example.test/" };
  const localStorage = fakeStorage(), sessionStorage = fakeStorage(), forbidden = [];
  const window = { location, history: { state: null, pushState() {}, replaceState() {} }, localStorage, sessionStorage, addEventListener() {}, dispatchEvent() {} };
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } } };
  const context = vm.createContext({ window, document, console, Intl, Date, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, CSS: { escape: (v) => v },
    indexedDB: { open() { forbidden.push("indexedDB"); throw new Error("indexedDB is not allowed"); } } });
  const files = ["AppView.js", "AppModules.js", "FabricFieldMeta.js", "FabricRecordView.js", "FabricFilterModel.js", "FabricValuePicker.js", "FabricFilterBuilder.js", "FabricColumnMenu.js", "FabricSavedFilters.js", "FabricExplorer.js", "FabricObjects.js", "FabricDataPanel.js", "EmployeeProfile.js", "EmployeeAccess.js", "EmployeesObjects.js", "EmployeesPanel.js"].filter((f) => fs.existsSync(path.join(ASSETS, f)));
  for (const f of files) vm.runInContext(read(f), context, { filename: f });
  const get = (name) => vm.runInContext(name, context);
  return { context, window, localStorage, sessionStorage, forbidden, get, P: get("EmployeesPanel"), O: get("EmployeesObjects"), X: get("FabricExplorer"), A: get("EmployeeAccess"), Profile: get("EmployeeProfile"), B: get("FabricFilterBuilder"), AppView: get("AppView") };
}

// ---- Synthetic answers (contract P2 §4 / §5 shapes)
const SNAP = { ingestedAt: "2026-11-24T06:00:00.000Z", checkedAt: "2026-11-25T08:00:00.000Z", stale: false };
const TEXT_OPS = [{ op: "eq", class: "fast" }, { op: "in", class: "fast" }, { op: "contains", class: "bounded" }, { op: "blank", class: "fast" }];
const BOOL_OPS = [{ op: "isTrue", class: "fast" }, { op: "isFalse", class: "fast" }];
const P1_FIELDS = [["displayName", "Name"], ["mail", "Email"], ["jobTitle", "Job title"], ["department", "Department"], ["officeLocation", "Office"]];
const JARC_FIELDS = [
  { name: "jarcAccount", label: "JARC account", type: "string", kind: "category", operators: TEXT_OPS, valueSource: "distinct" },
  { name: "jarcStatus", label: "JARC account status", type: "string", kind: "category", operators: TEXT_OPS, valueSource: "distinct" },
  { name: "jarcMemberships", label: "Workspace memberships", type: "number", kind: "number", operators: [{ op: "eq" }, { op: "gt" }, { op: "between" }, { op: "blank" }], valueSource: "none" },
  { name: "jarcWorkspaces", label: "Member of workspaces", type: "string", kind: "category", operators: TEXT_OPS, valueSource: "distinct" },
  { name: "jarcDisabledWithAccess", label: "Disabled in Entra, still has JARC access", type: "bool", kind: "bool", operators: BOOL_OPS, valueSource: "none" },
  { name: "jarcLastSignIn", label: "Last JARC sign-in", type: "date", kind: "date", operators: [{ op: "between" }, { op: "blank" }], valueSource: "none" }
].map((f) => ({ ...f, group: "jarc", filterable: true, sortable: false, searchable: false, orderable: false }));
function schema(ds = "active", jarc = false) {
  return { dataset: ds, label: ds, advanced: true,
    fields: [...P1_FIELDS.map(([name, label]) => ({ name, label, type: "string", kind: "text", filterable: true, sortable: name === "displayName", searchable: true, orderable: false, operators: TEXT_OPS, valueSource: "distinct" })), ...(jarc ? JARC_FIELDS : [])],
    filterModel: { version: 1, limits: { maxDepth: 3, maxConditions: 20, maxGroups: 5, maxListValues: 100, maxText: 200, maxEncoded: 8192, maxN: 3660 } },
    defaultColumns: ["displayName", "jobTitle", "department", "officeLocation", "mail"], searchFields: [{ field: "displayName", match: "contains" }], sorts: [{ name: "name", fields: ["displayName"], default: true }], orderBy: { maxKeys: 3 },
    access: { jarcAccess: jarc } };
}
const person = (n, over = {}) => ({ displayName: `Synthetic Person ${n}`, givenName: "Synthetic", surname: `Person ${n}`, mail: `person${n}@example.com`, userPrincipalName: `person${n}@example.com`, jobTitle: "Analyst", department: "Dept A", officeLocation: null, emailDomain: "example.com", ...over });
const records = (ds = "active") => ({ dataset: ds, fields: ["displayName", "jobTitle", "department", "officeLocation", "mail"], items: [{ id: ID1, values: person(1) }, { id: ID2, values: person(2) }], pagination: { limit: 100, hasMore: false, nextCursor: null }, snapshot: SNAP });
function access(over = {}) {
  return {
    dataset: "active", id: ID1, generatedAt: "2026-11-26T01:00:00.000Z", stale: false,
    policy: { shared: true, accessPolicy: "development_shared", betaOpenEditing: true, accountManagement: "off" },
    account: { registered: true, status: "active", registeredAt: "2026-10-01T08:00:00.000Z", lastSignInAt: "2026-11-25T09:15:00.000Z", lastSignInPrecisionMinutes: 15, signedInNow: true, lastSeenAt: "2026-11-26T00:55:00.000Z", jarcAdmin: "unknown", accountRole: null, entraEnabled: true, entraDisabledWithAccess: false, matchedBy: "entra_object_id", ...(over.account || {}) },
    appPermissions: [
      { key: "manageWorkspaces", label: "Create and manage workspaces", granted: true, source: "shared" },
      { key: "imports", label: "Imports", granted: false, source: null, note: "Needs JARC administrator." },
      { key: "legacyImport", label: "Legacy import", granted: false, source: null },
      { key: "systemHealth", granted: true, source: "config" },
      { key: "employeeDirectory", label: "People directory", granted: true, source: "config", level: "admin" }
    ],
    workspaces: [
      { name: "Synthetic Workspace A", archived: false, membership: { role: "MEMBER", status: "active", since: "2026-10-02T00:00:00.000Z" }, sharedRole: "WORKSPACE_ADMIN", effectiveRole: "WORKSPACE_ADMIN", source: "membership_and_shared", permissions: { view: true, editContent: true, manageBoards: true, manageMembers: true, moderateComments: true, importSpreadsheets: true }, boards: 2 },
      { name: "Synthetic Workspace B", archived: false, membership: null, sharedRole: "WORKSPACE_ADMIN", effectiveRole: "WORKSPACE_ADMIN", source: "shared", permissions: { view: true, editContent: true, manageBoards: true, manageMembers: false, moderateComments: false }, boards: 1 },
      { name: "Synthetic Workspace C", archived: true, membership: { role: "VIEWER", status: "invited", since: null }, sharedRole: null, effectiveRole: null, source: null, permissions: { view: false, editContent: false, manageBoards: false, manageMembers: false, moderateComments: false }, boards: 0 }
    ],
    boards: { total: 3, shown: 3, truncated: false, items: [
      { name: "Synthetic Board 1", workspace: "Synthetic Workspace A", publicId: 100001, effectiveRole: "WORKSPACE_ADMIN", source: "membership_and_shared" },
      { name: "Synthetic Board 2", workspace: "Synthetic Workspace A", publicId: "100002", effectiveRole: "WORKSPACE_ADMIN", source: "membership_and_shared", readOnly: true, archived: true },
      { name: "Synthetic Board 3", workspace: "Synthetic Workspace B", publicId: "not-a-number", effectiveRole: "WORKSPACE_ADMIN", source: "shared" }
    ] },
    notes: ["Shared access gives every active JARC user Workspace admin in every workspace.", "JARC has no board-level grants."],
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "account"))
  };
}
const VIEWER = { view: true, admin: false, datasets: ["active"] };
const ADMIN_P1 = { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"] };
const ADMIN = { ...ADMIN_P1, jarcAccess: true };
const err = (status, serverCode) => Object.assign(new Error("x"), { code: status === 403 ? "FORBIDDEN" : status === 503 ? "SERVICE_UNAVAILABLE" : "NOT_FOUND", cause: { status, serverCode } });
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const accessPath = (ds = "active", id = ID1) => `${BASE}/${ds}/records/${id}/jarc-access`;

function panelWith(env, { employees = ADMIN, answers = {} } = {}) {
  const calls = [], jarc = employees?.jarcAccess === true;
  const status = { snapshot: SNAP, access: { datasets: employees.datasets, admin: employees.admin, ...(jarc ? { jarcAccess: true } : {}) }, counts: { active: 2 } };
  const all = { [`${BASE}/status`]: status, [`${BASE}/active/schema`]: schema("active", jarc), [`${BASE}/disabled/schema`]: schema("disabled", jarc), [`${BASE}/active/records`]: records(), [`${BASE}/disabled/records`]: records("disabled"),
    [`${BASE}/active/records/${ID1}`]: { id: ID1, values: person(1), snapshot: SNAP }, [accessPath()]: access(), [`${BASE}/saved-filters/active`]: { items: [] }, [`${BASE}/saved-filters/disabled`]: { items: [] }, ...answers };
  const adapter = { mode: "resource", async request(method, p, body) { calls.push([method, p, body]); const hit = Object.entries(all).find(([k]) => p === k || p.startsWith(`${k}?`)); if (!hit) throw Object.assign(new Error("no answer"), { code: "NOT_FOUND", cause: { status: 404 } }); if (hit[1] instanceof Error) throw hit[1]; return typeof hit[1] === "function" ? hit[1](p) : hit[1]; } };
  const view = new env.AppView({ innerHTML: "" });
  const controller = { model: { features: { employees }, storage: { adapter }, screen: "employees", me: "user:00000000-0000-4000-8000-000000000001", openScreen(s) { this.screen = s; } }, view, updates: 0, update() { this.updates += 1; }, syncBoardUrl() {} };
  const panel = new env.P(controller);
  view.employeesPanel = panel; controller.employees = panel;
  return { panel, controller, calls, all };
}
async function open(panel, rounds = 5) { for (let i = 0; i < rounds; i += 1) { panel.html(); panel.ensure(); await settle(); } return panel.html(); }
const paths = (calls) => calls.map(([, p]) => p);
const tabTarget = (tab) => ({ tagName: "BUTTON", dataset: { tab, ds: "active" }, closest: () => null, getAttribute: () => "tab" });
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
async function openAccess(env, opts = {}) {
  const ctx = panelWith(env, opts);
  ctx.panel.applyRoute({ view: "list", ds: "active", recordId: ID1, query: null, tab: "access" });
  ctx.html = await open(ctx.panel);
  return ctx;
}

describe("P2 addresses: /admin/employees/{ds}/records/{id}/access", () => {
  const env = load();
  test("parsePath reads the access tab; formatPath and samePath round-trip it; P1 shapes are unchanged", () => {
    const r = env.P.parsePath(`${BASE}/all/records/${ID1}/access`);
    assert.equal(r.ds, "all"); assert.equal(r.recordId, ID1); assert.equal(r.tab, "access");
    assert.equal("tab" in env.P.parsePath(`${BASE}/all/records/${ID1}`), false, "a profile address has no tab key (P1 shape)");
    assert.equal(env.P.parsePath(`${BASE}/active/access`).unknown, true, "access needs a record");
    assert.equal(env.P.parsePath(`${BASE}/groups/department`).group, "department");
    assert.equal(env.P.formatPath({ view: "list", ds: "all", recordId: ID1, tab: "access" }).path, `${BASE}/all/records/${ID1}/access`);
    assert.equal(env.P.formatPath({ view: "list", ds: "all", tab: "access" }).path, `${BASE}/all`, "no record, no tab");
    assert.equal(env.P.samePath(`${BASE}/all/records/${ID1}`, `${BASE}/all/records/${ID1}/access`), false, "switching tabs adds a history entry");
    assert.equal(env.P.samePath(`${BASE}/all/records/${ID1}/access/`, `${BASE}/all/records/${ID1}/access`), true);
  });
});

describe("P2 profile tabs: who sees them", () => {
  test("a viewer: no tab bar, no JARC wording, no access request, and an /access address shows the profile", async () => {
    const env = load(), { panel, calls } = panelWith(env, { employees: VIEWER });
    panel.applyRoute({ view: "list", ds: "active", recordId: ID1, query: null, tab: "access" });
    const html = await open(panel);
    assert.match(html, /emp-p__title[^>]*>Synthetic Person 1</);
    assert.doesNotMatch(html, /role="tablist"|emp-p__tab|JARC access|jarc-access|emp-a__|jarcDisabled/);
    assert.equal(paths(calls).some((p) => p.includes("jarc-access")), false);
    assert.equal(panel.urlFor().path, `${BASE}/active/records/${ID1}`, "the address drops /access");
    assert.doesNotMatch(env.O.html(panel), /JARC/);
  });
  test("an administrator without jarcAccess (P1 /features): no tabs, no nav item", async () => {
    const env = load(), { panel, calls } = panelWith(env, { employees: ADMIN_P1 });
    panel.applyRoute({ view: "list", ds: "active", recordId: ID1, query: null });
    const html = await open(panel);
    assert.doesNotMatch(html, /role="tablist"/);
    assert.doesNotMatch(env.O.html(panel), /Disabled with JARC access/);
    assert.equal(paths(calls).some((p) => p.includes("jarc-access")), false);
  });
  test("a status answer with jarcAccess false wins over /features", async () => {
    const env = load(), { panel } = panelWith(env, { answers: { [`${BASE}/status`]: { snapshot: SNAP, access: { datasets: ADMIN.datasets, admin: true, jarcAccess: false } } } });
    panel.applyRoute({ view: "list", ds: "active", recordId: ID1, query: null });
    assert.doesNotMatch(await open(panel), /role="tablist"/);
  });
});

describe("P2 profile tabs: the JARC access tab", () => {
  test("Profile is the default tab and draws the unchanged P1 sections; nothing is requested until the tab opens", async () => {
    const env = load(), { panel, calls } = panelWith(env);
    panel.applyRoute({ view: "list", ds: "active", recordId: ID1, query: null });
    const html = await open(panel);
    assert.match(html, /<div class="emp-p__tabs" role="tablist" aria-label="Profile sections">/);
    assert.match(html, /role="tab" class="emp-p__tab is-active" id="emp-p-tab-profile-active"[^>]*aria-selected="true" aria-controls="emp-p-panel-active" tabindex="0">Profile</);
    assert.match(html, /id="emp-p-tab-access-active"[^>]*aria-selected="false" tabindex="-1">JARC access</);
    assert.match(html, /role="tabpanel" id="emp-p-panel-active" aria-labelledby="emp-p-tab-profile-active"/);
    for (const t of ["Identity", "Contact", "Organization", "Directory account"]) assert.match(html, new RegExp(`>${t}</h3>`));
    assert.equal(paths(calls).some((p) => p.includes("jarc-access")), false);
  });
  test("choosing the tab loads the access endpoint once, updates the address and draws every part", async () => {
    const env = load(), { panel, controller, calls } = panelWith(env);
    panel.applyRoute({ view: "list", ds: "active", recordId: ID1, query: null });
    await open(panel);
    const before = controller.updates;
    panel.onAction("emp-p-tab", tabTarget("access"), { preventDefault() {} });
    assert.ok(controller.updates > before, "the app redraws (and syncs the address)");
    assert.equal(panel.urlFor().path, `${BASE}/active/records/${ID1}/access`);
    const html = await open(panel);
    assert.equal(paths(calls).filter((p) => p === accessPath()).length, 1);
    assert.match(html, /aria-labelledby="emp-p-tab-access-active" tabindex="-1" data-tab="access"/);
    const t = text(html);
    for (const s of ["JARC account", "Application permissions", "Workspaces", "Accessible boards", "How JARC access works"]) assert.match(html, new RegExp(`<h3 class="emp-p__section-title" id="emp-a-[a-z]+-active">${s}</h3>`));
    assert.match(t, /JARC account Registered/); assert.match(t, /JARC account status Active/);
    assert.match(t, /JARC administrator Unknown \(not signed in\)/);
    assert.match(t, /Yes or No is the role at the person's current sign-in/);
    assert.match(t, /accurate to about 15 minutes/);
    assert.match(t, /Signed in to JARC now Yes · last seen/);
    assert.match(html, /<time datetime="2026-10-01T08:00:00.000Z">/);
    // App permissions: generic, with source badges; a missing label falls back to the key in words.
    assert.match(t, /Create and manage workspaces Granted Shared access/);
    assert.match(t, /Imports Not granted Needs JARC administrator\./);
    assert.match(t, /Legacy import Not granted/); assert.match(t, /People directory Granted: Administrator Configuration/); assert.match(t, /System health Granted Configuration/);
    // Workspaces: membership vs shared badges, effective role, flags (also unknown extras), board count.
    assert.match(t, /Synthetic Workspace A Membership: Member Shared access Effective role Workspace admin · from membership and shared access/);
    assert.match(t, /Can View, Edit content, Manage boards, Manage members, Moderate comments, Import spreadsheets/);
    assert.match(t, /Synthetic Workspace B Shared access Effective role Workspace admin · from shared access Can View, Edit content, Manage boards Can't Manage members, Moderate comments Boards 1/);
    assert.match(t, /Synthetic Workspace C Membership: Viewer · Invited Archived Effective role No access/);
    assert.match(t, /An invited membership grants nothing\./);
    assert.match(t, /need a real membership or JARC administrator, never shared access alone/);
    // Boards: numeric public IDs link to /boards/{id}; anything else is plain text; synced boards are marked.
    assert.match(html, /<a class="fx-link emp-a__board-link" href="\/boards\/100001">Synthetic Board 1<\/a>/);
    assert.match(html, /href="\/boards\/100002">Synthetic Board 2<\/a> <span class="emp-a__muted">#100002<\/span>.*Read-only \(synced\).*Archived/);
    assert.doesNotMatch(html, /not-a-number/);
    assert.match(t, /3 boards\./);
    assert.match(t, /Shared access is on\./); assert.match(t, /Access policy Shared access \(development_shared\)/); assert.match(t, /Account management Off/);
    assert.match(html, /<ul class="emp-a__notes"><li>Shared access gives every active JARC user/);
    // Read-only: no grant / revoke / edit controls, no inputs.
    const tab = html.slice(html.indexOf('<div class="emp-access"'));
    assert.doesNotMatch(tab, /<input|<select|<form|<button|Grant|Revoke|Remove access|Manage access|contenteditable/);
    assert.doesNotMatch(html, /entra_object_id/, "matchedBy isn't drawn");
    assert.equal(env.forbidden.length, 0);
  });
  test("deep link /access loads the tab directly; Back to list drops the tab choice", async () => {
    const env = load(), { panel, calls, html } = await openAccess(env);
    assert.match(html, /data-tab="access"/);
    assert.ok(paths(calls).includes(accessPath()));
    assert.equal(panel.urlFor().path, `${BASE}/active/records/${ID1}/access`);
    panel.explorers.active.openRecord("");
    await open(panel, 2);
    panel.explorers.active.openRecord(ID1);
    assert.equal(panel.profileTabFor(panel.explorers.active), "profile", "the next profile opens on Profile");
  });
  test("← / → / Home / End move between the tabs (APG tabs); Escape still goes back", async () => {
    const env = load(), { panel } = panelWith(env);
    panel.applyRoute({ view: "list", ds: "active", recordId: ID1, query: null });
    await open(panel);
    const x = panel.explorers.active, key = (k, tab) => ({ key: k, target: { getAttribute: () => "tab", closest: () => ({}), dataset: { tab } }, preventDefault() { this.prevented = true; } });
    const ev = key("ArrowRight", "profile");
    assert.equal(env.Profile.onKeydown(x, ev), true); assert.equal(ev.prevented, true);
    assert.equal(panel.profileTabFor(x), "access");
    env.Profile.onKeydown(x, key("Home", "access")); assert.equal(panel.profileTabFor(x), "profile");
    env.Profile.onKeydown(x, key("End", "profile")); assert.equal(panel.profileTabFor(x), "access");
    env.Profile.onKeydown(x, key("ArrowLeft", "access")); assert.equal(panel.profileTabFor(x), "profile");
    assert.equal(env.Profile.onTabKey(x, { key: "Escape", target: { getAttribute: () => "tab", closest: () => ({}), dataset: { tab: "profile" } } }), false, "Escape is the page's (back to the list)");
  });
});

describe("P2 JARC access tab: states", () => {
  test("not registered: the clear empty state, no implied access, the policy notes", async () => {
    const env = load(), { html } = await openAccess(env, { answers: { [accessPath()]: access({ account: { registered: false, status: null, jarcAdmin: null, registeredAt: null, lastSignInAt: null, signedInNow: false, entraDisabledWithAccess: false }, workspaces: [], boards: { total: 0, shown: 0, items: [], truncated: false }, appPermissions: [] }) } });
    assert.match(html, /No JARC account\. This person has never signed in to JARC\./);
    assert.match(html, /An enabled Microsoft Entra account doesn't give JARC access by itself\./);
    assert.doesNotMatch(html, /Application permissions|Accessible boards|emp-a__ws|emp-a__perm/);
    assert.match(html, /How JARC access works/);
  });
  test("disabled in Entra with JARC access: a prominent alert naming the workspace count", async () => {
    const env = load(), { html } = await openAccess(env, { answers: { [accessPath()]: access({ account: { entraEnabled: false, entraDisabledWithAccess: true } }) } });
    assert.match(html, /class="fx-status fx-status--error fx-status--block emp-a__alert" role="alert"/);
    assert.match(text(html), /Disabled in Microsoft Entra ID, still has JARC access .*access to 2 workspaces/);
    assert.ok(html.indexOf("emp-a__alert") < html.indexOf("emp-a-account-"), "the warning comes before the sections");
  });
  test("disabled in JARC: its badge and the no-access note", async () => {
    const env = load(), { html } = await openAccess(env, { answers: { [accessPath()]: access({ account: { status: "disabled" } }) } });
    assert.match(html, /emp-a__badge--off">Disabled in JARC</);
    assert.match(html, /gives no access at all/);
  });
  test("stale index: a warning with the check time", async () => {
    const env = load(), { html } = await openAccess(env, { answers: { [accessPath()]: access({ stale: true }) } });
    assert.match(html, /emp-a__stale" role="status".*may be out of date.*<time datetime="2026-11-26T01:00:00.000Z">/);
  });
  test("loading: a busy status inside the tab", async () => {
    const env = load(), { panel } = panelWith(env, { answers: { [accessPath()]: () => new Promise(() => {}) } });
    panel.applyRoute({ view: "list", ds: "active", recordId: ID1, query: null, tab: "access" });
    assert.match(await open(panel), /role="status" aria-busy="true"><span class="fx-status__msg">Loading JARC access…/);
  });
  test("403 shows No access in the tab only (the directory stays open); 404 not found; 503 offers Try again", async () => {
    for (const [status, code, re, retry] of [[403, "EMPLOYEES_FORBIDDEN", /No access.*You don't have access to JARC access details\./, false], [404, "NOT_FOUND", /Not found.*isn't in the directory snapshot/, false], [503, "EMPLOYEES_UNAVAILABLE", /JARC access unavailable.*temporarily unavailable/, true]]) {
      const env = load(), { panel, html } = await openAccess(env, { answers: { [accessPath()]: err(status, code) } });
      assert.equal(panel.denied, false, `${status}: the directory isn't closed`);
      assert.match(text(html), re);
      assert.match(html, /emp-p__title[^>]*>Synthetic Person 1</, `${status}: the profile header stays`);
      assert.equal(/data-action="emp-p-access-retry"/.test(html), retry);
    }
  });
  test("Try again after a 503 requests again and draws the answer", async () => {
    const env = load(); let fail = true;
    const { panel, calls } = await openAccess(env, { answers: { [accessPath()]: () => { if (fail) throw err(503, "EMPLOYEES_UNAVAILABLE"); return access(); } } });
    fail = false;
    panel.onAction("emp-p-access-retry", { tagName: "BUTTON", dataset: { ds: "active" }, closest: () => null }, {});
    const html = await open(panel);
    assert.equal(paths(calls).filter((p) => p === accessPath()).length, 2);
    assert.match(html, /Accessible boards/);
  });
});

describe("P2 JARC access tab: escaping, no raw IDs, no storage", () => {
  test("hostile values are escaped; unknown enums and extra ID-like keys are never drawn", () => {
    const env = load();
    const d = access({ notes: [HOSTILE], account: { jarcAdmin: HOSTILE, status: HOSTILE, accountRole: { role: HOSTILE, status: "active" } } });
    d.workspaces[0].name = HOSTILE; d.workspaces[0].effectiveRole = HOSTILE; d.workspaces[0]._id = "0123456789abcdef01234567"; d.workspaces[0].oid = "00000000-0000-4000-8000-0000000000aa";
    d.boards.items[0].name = HOSTILE; d.boards.items[0].publicId = `1"><script>`; d.boards.items[0].boardId = "0123456789abcdef01234568";
    d.appPermissions[0].label = HOSTILE; d.appPermissions[0].source = HOSTILE; d.userId = "0123456789abcdef01234569";
    const html = env.A.html({ ds: "active" }, { data: d });
    assert.doesNotMatch(html, /<script|<img|onerror="/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /0123456789abcdef0123456|00000000-0000-4000-8000/);
    assert.match(text(html), /JARC administrator Unknown/);
    assert.doesNotMatch(html, /href="\/boards\/1(&quot;|")/, "a non-numeric public ID is never a link");
  });
  test("nothing from the access answer reaches localStorage, sessionStorage or IndexedDB", async () => {
    const env = load();
    await openAccess(env);
    const stored = [...env.localStorage.map.entries(), ...env.sessionStorage.map.entries()].map(([k, v]) => `${k}=${v}`).join("\n");
    assert.doesNotMatch(stored, /Synthetic Workspace|Synthetic Board|100001|Shared access|registered/i);
    assert.equal(env.forbidden.length, 0);
  });
});

describe("P2 navigation: Disabled with JARC access", () => {
  test("only for jarcAccess administrators, right after Disabled accounts, opening Disabled + jarcDisabledWithAccess is true", async () => {
    const env = load(), { panel, calls } = panelWith(env);
    await open(panel);
    const nav = env.O.html(panel);
    assert.match(nav, /Disabled accounts<\/span><\/a><\/li><li class="fx-objects__node" role="none"><a [^>]*data-action="emp-o-jarc-disabled"[^>]*>.*Disabled with JARC access/);
    const href = nav.match(/href="([^"]+)" data-action="emp-o-jarc-disabled"/)[1].replace(/&amp;/g, "&");
    const route = env.P.parsePath(href.split("?")[0], `?${href.split("?")[1] || ""}`);
    assert.equal(route.ds, "disabled");
    assert.deepEqual(JSON.parse(JSON.stringify(route.query.filter.items)), [{ field: "jarcDisabledWithAccess", op: "isTrue" }]);
    env.O.onAction(panel, "emp-o-jarc-disabled", { dataset: { ds: "disabled" } }, { preventDefault() {} });
    assert.equal(panel.route.ds, "disabled");
    assert.equal(panel.isJarcDisabledView(), true);
    assert.equal(env.O.currentId(panel), "jarc-disabled");
    assert.equal(panel.sectionLabel(), "Disabled with JARC access");
    await open(panel);
    const req = paths(calls).find((p) => p.startsWith(`${BASE}/disabled/records?`));
    assert.ok(req, "the Disabled list is requested");
    assert.match(Buffer.from(new URLSearchParams(req.split("?")[1]).get("filter"), "base64url").toString(), /"jarcDisabledWithAccess","op":"isTrue"/);
    // Disabled accounts (its own item) clears the filter again.
    env.O.onAction(panel, "emp-o-ds", { dataset: { ds: "disabled" } }, {});
    assert.equal(panel.isJarcDisabledView(), false);
    assert.equal(env.O.currentId(panel), "disabled");
  });
  test("viewers and P1 administrators never get it", async () => {
    for (const employees of [VIEWER, ADMIN_P1]) {
      const env = load(), { panel } = panelWith(env, { employees });
      await open(panel);
      assert.doesNotMatch(env.O.html(panel), /jarc-disabled|JARC/);
      assert.equal(panel.jarcDisabledAvailable(), false);
    }
  });
});

describe("P2 fields in Columns and Filters (fieldGroups)", () => {
  test("an administrator's schema: Directory and JARC access headings in Columns and the filter field list", async () => {
    const env = load(), { panel } = panelWith(env);
    await open(panel);
    const x = panel.explorers.active;
    const chooser = x.chooserHtml();
    assert.match(chooser, /<div class="fabric-chooser-group" role="group" aria-labelledby="fabric-active-colgroup-0" data-col-group><p class="fabric-chooser-group__title" id="fabric-active-colgroup-0">Directory<\/p>/);
    assert.match(chooser, /id="fabric-active-colgroup-1">JARC access<\/p>.*data-name="jarcAccount".*data-name="jarcWorkspaces".*data-name="jarcLastSignIn"/);
    assert.ok(chooser.indexOf("data-name=\"mail\"") < chooser.indexOf("JARC access</p>"), "directory fields first");
    x.fb.draft = { v: 1, op: "and", items: [{ field: "", op: "" }] };
    const picker = env.B.pickerHtml(x, "0");
    assert.match(picker, /<li role="group" class="fx-fb__optgroup" aria-labelledby="fabric-active-fb-g1-[^"]+" data-fb-group><span class="fx-fb__optgroup-title"[^>]*>JARC access<\/span>/);
    for (const [name, kind] of [["jarcDisabledWithAccess", "bool"], ["jarcMemberships", "number"], ["jarcLastSignIn", "date"], ["jarcStatus", "category"]]) assert.equal(x.filterField(name)?.kind, kind, `${name} is a ${kind} filter`);
    assert.deepEqual([...x.filterField("jarcDisabledWithAccess").ops], ["isTrue", "isFalse"]);
    assert.ok(x.filterField("jarcMemberships").ops.includes("gt"));
  });
  test("multi-valued jarcWorkspaces renders as plain escaped text in a cell", async () => {
    const env = load(), { panel } = panelWith(env);
    await open(panel);
    const x = panel.explorers.active;
    assert.equal(x.cell("Synthetic Workspace A, Synthetic Workspace B", "string"), "Synthetic Workspace A, Synthetic Workspace B");
    assert.equal(x.cell(true, "bool"), "Yes");
    assert.equal(x.cell(2, "number"), "2");
  });
  test("a viewer's schema (no jarc group): the lists stay flat, as in P1", async () => {
    const env = load(), { panel } = panelWith(env, { employees: VIEWER });
    await open(panel);
    const x = panel.explorers.active;
    assert.doesNotMatch(x.chooserHtml(), /fabric-chooser-group/);
    x.fb.draft = { v: 1, op: "and", items: [{ field: "", op: "" }] };
    assert.doesNotMatch(env.B.pickerHtml(x, "0"), /fx-fb__optgroup/);
  });
  test("Fabric Data explorers (default options) never group, even if a schema had groups", () => {
    const env = load();
    const fake = { c: { model: { storage: {} } }, esc: (v) => String(v), attr: (v) => String(v), redraw() {}, announce() {} };
    const x = new env.X(fake, "sales");
    assert.equal(x.opts.fieldGroups, null);
    x.schema.data = schema("active", true);
    assert.equal(x.fieldSections(env.X.normalize(x.schema.data).fields), null);
  });
});
