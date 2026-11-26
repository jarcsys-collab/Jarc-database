// People directory P3 frontend (Access Administration): the profile's Manage access tab (EmployeeManage.js, EmployeeProfile.js,
// EmployeesPanel.js), its /manage address, who sees it, the account actions and their confirmations, memberships, history,
// error and conflict handling, and the P2 display of the new statuses. The unchanged browser files run in a vm with a stubbed
// adapter answering per contract P3 §5: no server, no network. Synthetic data only (example.com, "Synthetic …").
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
const ID1 = "SyntheticProfileId0001", ID2 = "SyntheticProfileId0002";
const BASE = "/admin/employees";
const HOSTILE = `<script>alert(1)</script>"><img src=x onerror="alert(2)">`;
const REF_A = "SyntheticWsRefAAAAAAAA", REF_B = "SyntheticWsRefBBBBBBBB", REF_C = "SyntheticWsRefCCCCCCCC";

function fakeStorage() {
  const m = new Map();
  return { map: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear() };
}
function load({ manage = true } = {}) {
  const location = { pathname: "/", search: "", origin: "https://jarc.example.test", href: "https://jarc.example.test/" };
  const localStorage = fakeStorage(), sessionStorage = fakeStorage(), forbidden = [];
  const window = { location, history: { state: null, pushState() {}, replaceState() {} }, localStorage, sessionStorage, addEventListener() {}, dispatchEvent() {} };
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } } };
  const context = vm.createContext({ window, document, console, Intl, Date, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, CSS: { escape: (v) => v },
    indexedDB: { open() { forbidden.push("indexedDB"); throw new Error("indexedDB is not allowed"); } } });
  const files = ["AppView.js", "AppModules.js", "FabricFieldMeta.js", "FabricRecordView.js", "FabricFilterModel.js", "FabricValuePicker.js", "FabricFilterBuilder.js", "FabricColumnMenu.js", "FabricSavedFilters.js", "FabricExplorer.js", "FabricObjects.js", "FabricDataPanel.js", "EmployeeProfile.js", "EmployeeAccess.js", ...(manage ? ["EmployeeManage.js"] : []), "EmployeesObjects.js", "EmployeesPanel.js"];
  for (const f of files) vm.runInContext(read(f), context, { filename: f });
  const get = (name) => vm.runInContext(name, context);
  return { context, window, localStorage, sessionStorage, forbidden, get, P: get("EmployeesPanel"), M: manage ? get("EmployeeManage") : null, A: get("EmployeeAccess"), Profile: get("EmployeeProfile"), AppView: get("AppView") };
}

// ---- Synthetic answers (contract P3 §5 shapes)
const SNAP = { ingestedAt: "2026-11-24T06:00:00.000Z", checkedAt: "2026-11-25T08:00:00.000Z", stale: false };
const TEXT_OPS = [{ op: "eq", class: "fast" }, { op: "blank", class: "fast" }];
const schema = (ds = "active") => ({ dataset: ds, label: ds, advanced: true, fields: [["displayName", "Name"], ["mail", "Email"]].map(([name, label]) => ({ name, label, type: "string", kind: "text", filterable: true, sortable: name === "displayName", searchable: true, orderable: false, operators: TEXT_OPS, valueSource: "distinct" })),
  filterModel: { version: 1, limits: { maxDepth: 3, maxConditions: 20, maxGroups: 5, maxListValues: 100, maxText: 200, maxEncoded: 8192, maxN: 3660 } }, defaultColumns: ["displayName", "mail"], searchFields: [{ field: "displayName", match: "contains" }], sorts: [{ name: "name", fields: ["displayName"], default: true }], orderBy: { maxKeys: 3 }, access: { jarcAccess: true } });
const person = (n) => ({ displayName: `Synthetic Person ${n}`, givenName: "Synthetic", surname: `Person ${n}`, mail: `person${n}@example.com`, jobTitle: "Analyst", department: "Dept A" });
const records = (ds = "active") => ({ dataset: ds, fields: ["displayName", "mail"], items: [{ id: ID1, values: person(1) }, { id: ID2, values: person(2) }], pagination: { limit: 100, hasMore: false, nextCursor: null }, snapshot: SNAP });
const ACTIONS = (over = {}) => ["grant", "suspend", "restore", "revoke"].map((action) => ({ action, allowed: false, ...(over[action] || {}) }));
function manage(over = {}) {
  return {
    id: ID1, version: 3,
    account: { state: "active", provisioned: false, signedInNow: true, isSelf: false, isEmployeeAdmin: false, entraEnabled: true, ...(over.account || {}) },
    actions: over.actions || ACTIONS({ suspend: { allowed: true, reasonRequired: true }, revoke: { allowed: true, reasonRequired: true, confirm: "REVOKE" }, grant: { code: "INVALID_TRANSITION", reason: "This change isn't possible from the person's current JARC access. Reload and try again." }, restore: { code: "INVALID_TRANSITION" } }),
    tokens: { jarcActive: 2, fabricActive: 1 },
    workspaces: over.workspaces || [
      { workspaceRef: REF_A, name: "Synthetic Workspace A", membership: { role: "MEMBER", status: "active" }, sharedRole: "WORKSPACE_ADMIN", effectiveRole: "WORKSPACE_ADMIN", canManage: true, lastAdmin: false },
      { workspaceRef: REF_B, name: "Synthetic Workspace B", membership: null, sharedRole: "WORKSPACE_ADMIN", effectiveRole: "WORKSPACE_ADMIN", canManage: true, lastAdmin: false },
      { workspaceRef: REF_C, name: "Synthetic Workspace C", membership: { role: "WORKSPACE_ADMIN", status: "active" }, sharedRole: "WORKSPACE_ADMIN", effectiveRole: "WORKSPACE_ADMIN", canManage: true, lastAdmin: true }
    ],
    sharedAccess: { on: true, note: "Shared access gives every active JARC user Workspace admin in every workspace." },
    warnings: over.warnings || [],
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !["account", "actions", "workspaces", "warnings"].includes(k)))
  };
}
const HISTORY = { items: [
  { at: "2026-11-26T02:00:00.000Z", action: "employee.access.rejected", result: "rejected", actor: "Synthetic Owner", changes: [], code: "SELF_LOCKOUT", attempted: "suspend" },
  { at: "2026-11-26T01:00:00.000Z", action: "employee.access.suspended", result: "ok", actor: "Synthetic Owner", changes: [{ field: "status", from: "active", to: "suspended" }], reason: "Synthetic reason" },
  { at: "2026-11-25T01:00:00.000Z", action: "employee.membership.role_changed", result: "ok", actor: "Synthetic Owner", changes: [{ field: "role", from: "VIEWER", to: "MEMBER" }], workspace: "Synthetic Workspace A" }
], nextBefore: "cursor-synthetic-1" };

const VIEWER = { view: true, admin: false, datasets: ["active"] };
const ADMIN_P2 = { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"], jarcAccess: true };
const ADMIN = { ...ADMIN_P2, accessAdmin: true };
const err = (status, serverCode) => Object.assign(new Error("x"), { code: { 400: "VALIDATION_ERROR", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 429: "RATE_LIMITED", 503: "SERVICE_UNAVAILABLE" }[status], cause: { status, serverCode } });
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const mPath = (id = ID1) => `${BASE}/active/records/${id}/manage-access`;
const hPath = (id = ID1) => `${BASE}/active/records/${id}/access-history`;

function panelWith(env, { employees = ADMIN, answers = {}, status: statusOver = null } = {}) {
  const calls = [], overlays = [], toasts = [];
  const status = statusOver || { snapshot: SNAP, access: { datasets: employees.datasets, admin: employees.admin, ...(employees.jarcAccess ? { jarcAccess: true } : {}) }, counts: { active: 2 } };
  const all = { [`${BASE}/status`]: status, [`${BASE}/active/schema`]: schema(), [`${BASE}/active/records`]: records(), [`${BASE}/active/records/${ID1}`]: { id: ID1, values: person(1), snapshot: SNAP },
    [`${BASE}/active/records/${ID1}/jarc-access`]: { account: { registered: true, status: "active" }, workspaces: [], boards: { items: [] }, policy: {} },
    [mPath()]: manage(), [hPath()]: HISTORY, [`${BASE}/saved-filters/active`]: { items: [] }, ...answers };
  const adapter = { mode: "resource", async request(method, p, body) {
    calls.push([method, p, body]);
    const key = `${method} ${p.split("?")[0]}`;
    const hit = Object.hasOwn(all, key) ? [key, all[key]] : method === "GET" ? Object.entries(all).find(([k]) => p === k || p.startsWith(`${k}?`)) : null;
    if (!hit) throw Object.assign(new Error("no answer"), { code: "NOT_FOUND", cause: { status: 404 } });
    let v = hit[1]; if (typeof v === "function") v = v(p, body, method);
    if (v instanceof Error) throw v;
    return v;
  } };
  const view = new env.AppView({ innerHTML: "" });
  view.overlay = (html) => overlays.push(html); view.closeOverlay = () => overlays.push("(closed)"); view.toast = (m) => toasts.push(m);
  const controller = { model: { features: { employees }, storage: { adapter }, screen: "employees", me: "user:00000000-0000-4000-8000-000000000001", openScreen(s) { this.screen = s; } }, view, updates: 0, update() { this.updates += 1; }, syncBoardUrl() {} };
  const panel = new env.P(controller);
  view.employeesPanel = panel; controller.employees = panel;
  return { panel, controller, calls, all, overlays, toasts };
}
async function open(panel, rounds = 6) { for (let i = 0; i < rounds; i += 1) { panel.html(); panel.ensure(); await settle(); } return panel.html(); }
const paths = (calls) => calls.map(([m, p]) => `${m} ${p}`);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const btn = (dataset) => ({ tagName: "BUTTON", dataset, closest: () => null });
const form = (fields = {}) => ({ elements: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v }])) });
async function openManage(env, opts = {}) {
  const ctx = panelWith(env, opts);
  ctx.panel.applyRoute({ view: "list", ds: "active", recordId: ID1, query: null, tab: "manage" });
  ctx.html = await open(ctx.panel);
  return ctx;
}
const lastDialog = (ctx) => [...ctx.overlays].reverse().find((h) => h !== "(closed)") || "";

describe("P3 address: /admin/employees/{ds}/records/{id}/manage", () => {
  const env = load();
  test("parsePath / formatPath / samePath handle manage next to access; P1 and P2 shapes are unchanged", () => {
    const r = env.P.parsePath(`${BASE}/all/records/${ID1}/manage`);
    assert.equal(r.ds, "all"); assert.equal(r.recordId, ID1); assert.equal(r.tab, "manage");
    assert.equal(env.P.parsePath(`${BASE}/all/records/${ID1}/access`).tab, "access");
    assert.equal("tab" in env.P.parsePath(`${BASE}/all/records/${ID1}`), false);
    assert.equal(env.P.parsePath(`${BASE}/active/manage`).unknown, true, "manage needs a record");
    assert.equal(env.P.formatPath({ view: "list", ds: "all", recordId: ID1, tab: "manage" }).path, `${BASE}/all/records/${ID1}/manage`);
    assert.equal(env.P.formatPath({ view: "list", ds: "all", recordId: ID1, tab: "bogus" }).path, `${BASE}/all/records/${ID1}`);
    assert.equal(env.P.samePath(`${BASE}/all/records/${ID1}/access`, `${BASE}/all/records/${ID1}/manage`), false);
  });
});

describe("P3 who sees Manage access", () => {
  for (const [label, employees] of [["a viewer", VIEWER], ["the administrator without accessAdmin (switch off)", ADMIN_P2], ["accessAdmin false", { ...ADMIN_P2, accessAdmin: false }], ["accessAdmin 'true' (not boolean)", { ...ADMIN_P2, accessAdmin: "true" }]]) {
    test(`${label}: no Manage access tab, no hint, no request; a /manage address shows the profile`, async () => {
      const env = load(), { panel, calls } = panelWith(env, { employees });
      panel.applyRoute({ view: "list", ds: "active", recordId: ID1, query: null, tab: "manage" });
      const html = await open(panel);
      assert.doesNotMatch(html, /Manage access|emp-m-|emp-manage/);
      assert.equal(paths(calls).some((p) => /manage-access|access-history|memberships/.test(p)), false);
      assert.equal(panel.urlFor().path, `${BASE}/active/records/${ID1}`);
    });
  }
  test("EmployeeManage.js not loaded: no tab even with accessAdmin", async () => {
    const env = load({ manage: false }), { panel, calls } = panelWith(env);
    panel.applyRoute({ view: "list", ds: "active", recordId: ID1, query: null, tab: "manage" });
    const html = await open(panel);
    assert.doesNotMatch(html, /Manage access/); assert.equal(paths(calls).some((p) => p.includes("manage-access")), false);
  });
  test("a status answer with accessAdmin false wins over /features", async () => {
    const env = load(), { panel } = panelWith(env, { status: { snapshot: SNAP, access: { datasets: ADMIN.datasets, admin: true, jarcAccess: true, accessAdmin: false } } });
    panel.applyRoute({ view: "list", ds: "active", recordId: ID1, query: null });
    const html = await open(panel);
    assert.doesNotMatch(html, /Manage access/);
  });
  test("accessAdmin: three tabs (APG pattern), the manage tab loads …/manage-access and the history; keys move between all three", async () => {
    const env = load(), ctx = await openManage(env), { panel, calls, html } = ctx;
    assert.deepEqual([...html.matchAll(/role="tab"[^>]*data-tab="([a-z]+)"[^>]*aria-selected="(true|false)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2], m[3]]), [["profile", "false", "Profile"], ["access", "false", "JARC access"], ["manage", "true", "Manage access"]]);
    assert.match(html, /role="tabpanel"[^>]*aria-labelledby="emp-p-tab-manage-active"/);
    assert.ok(paths(calls).includes(`GET ${mPath()}`));
    assert.ok(paths(calls).some((p) => p.startsWith(`GET ${hPath()}?limit=20`)));
    assert.equal(panel.urlFor().path, `${BASE}/active/records/${ID1}/manage`);
    const x = panel.explorers.active, key = (k, tab) => ({ key: k, target: { getAttribute: () => "tab", closest: () => true, dataset: { tab } }, preventDefault() {} });
    env.Profile.onKeydown(x, key("ArrowRight", "manage")); assert.equal(panel.profileTabFor(x), "profile", "wraps to Profile");
    env.Profile.onKeydown(x, key("End", "profile")); assert.equal(panel.profileTabFor(x), "manage");
    env.Profile.onKeydown(x, key("ArrowLeft", "manage")); assert.equal(panel.profileTabFor(x), "access");
  });
  test("an administrator with accessAdmin but no jarcAccess gets Profile | Manage access", async () => {
    const env = load(), { panel, html } = await openManage(env, { employees: { ...ADMIN_P2, jarcAccess: false, accessAdmin: true } });
    assert.deepEqual([...html.matchAll(/role="tab"[^>]*data-tab="([a-z]+)"/g)].map((m) => m[1]), ["profile", "manage"]);
    assert.equal(panel.profileTabFor(panel.explorers.active), "manage");
  });
});

describe("P3 Manage access: what the tab shows", () => {
  test("account state, tokens, allowed / refused / hidden actions with the server's reason", async () => {
    const env = load(), { html } = await openManage(env);
    const t = text(html);
    assert.match(t, /JARC account Active/); assert.match(t, /JARC API: 2 active tokens · Fabric API: 1 active token/);
    assert.match(html, /data-act="suspend"[^>]*>Suspend…</); assert.match(html, /data-act="revoke"[^>]*>Revoke…</);
    assert.match(html, /data-act="grant"[^>]*aria-describedby="emp-m-why-grant-active"[^>]* disabled>Grant access…</, "refused with a reason: disabled and explained");
    assert.match(t, /Grant access: This change isn't possible from the person's current JARC access\./);
    assert.match(html, /data-act="restore"[^>]* disabled/, "refused with only a code: disabled, the code in words");
    const hidden = await openManage(load(), { answers: { [mPath()]: manage({ actions: ACTIONS({ suspend: { allowed: true } }) }) } });
    assert.doesNotMatch(hidden.html, /data-act="restore"/, "refused without code or reason: hidden");
  });
  test("self-lockout and last employee administrator reasons; free-text reasons escaped; ID-looking text withheld", async () => {
    const env = load();
    const { html } = await openManage(env, { answers: { [mPath()]: manage({ account: { isSelf: true, isEmployeeAdmin: true }, actions: ACTIONS({ suspend: { reason: "SELF_LOCKOUT" }, revoke: { reason: HOSTILE }, grant: { reason: "507f1f77bcf86cd799439011" } }) }) } });
    const t = text(html);
    assert.match(t, /Suspend: You can't suspend or revoke your own account\./);
    assert.match(t, /Yes, this is you/);
    assert.doesNotMatch(html, /<script>|<img/); assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /507f1f77bcf86cd799439011/); assert.doesNotMatch(html, /data-act="grant"/);
  });
  test("workspaces: three roles only, shared role, effective role; the shared-access note on every membership control; last admin; never 'access revoked'; no workspaceRef in the page", async () => {
    const env = load(), { html } = await openManage(env);
    assert.match(text(html), /Shared access still gives Workspace admin in every workspace; removing this membership only removes member management and comment moderation\./);
    const controls = [...html.matchAll(/<(select|button)[^>]*data-action="emp-m-(role|change|remove)"[^>]*>/g)].map((m) => m[0]);
    assert.ok(controls.length >= 6);
    for (const c of controls) assert.match(c, /aria-describedby="[^"]*emp-m-shared-active/, c);
    const options = [...html.matchAll(/<select[^>]*id="emp-m-role-0-active"[^>]*>(.*?)<\/select>/g)][0][1];
    assert.deepEqual([...options.matchAll(/value="([A-Z_]+)"/g)].map((m) => m[1]), ["WORKSPACE_ADMIN", "MEMBER", "VIEWER"]);
    assert.match(html, /Last Workspace admin of this workspace/);
    assert.match(html, /data-action="emp-m-remove" data-ws="2"[^>]*disabled/, "last admin: Remove disabled");
    assert.match(html, /data-action="emp-m-change" data-ws="0"[^>]*disabled/, "Change role waits for a different role");
    assert.doesNotMatch(text(html).toLowerCase(), /workspaces.*access revoked/);
    for (const ref of [REF_A, REF_B, REF_C]) assert.doesNotMatch(html, new RegExp(ref));
    assert.match(html, /<option value="1">Synthetic Workspace B<\/option>/, "Add membership offers only the workspace without a membership");
  });
  test("canManage false: membership controls and Add are disabled and explained", async () => {
    const env = load(), ws = manage().workspaces.map((w) => ({ ...w, canManage: false }));
    const { html } = await openManage(env, { answers: { [mPath()]: manage({ workspaces: ws }) } });
    for (const m of html.matchAll(/<(select|button)[^>]*data-action="emp-m-(role|remove)"[^>]*>/g)) assert.match(m[0], / disabled/);
    assert.match(text(html), /needs your own Workspace admin membership there, or the JARC administrator role/);
    assert.doesNotMatch(html, /emp-m-add-form/);
  });
  test("a status written outside P3 ('disabled'): Disabled in JARC, Restore or Revoke only; stale snapshot warning; warning objects", async () => {
    const env = load(), { html } = await openManage(env, { answers: { [mPath()]: manage({ account: { state: "disabled", signedInNow: false }, actions: ACTIONS({ restore: { allowed: true }, revoke: { allowed: true, reasonRequired: true, confirm: "REVOKE" } }), snapshot: { stale: true, ingestedAt: "2026-11-24T06:00:00.000Z" }, warnings: [{ code: "SNAPSHOT_STALE", message: "The directory snapshot may be out of date." }, { code: "INDEX_TRUNCATED", message: HOSTILE }] }) } });
    const t = text(html);
    assert.match(t, /JARC account Disabled in JARC/); assert.match(t, /set outside Employee Management/);
    assert.match(html, /data-act="restore"[^>]*>Restore…/); assert.doesNotMatch(html, /data-act="suspend"/);
    assert.match(t, /The directory snapshot may be out of date \(loaded/);
    assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
  });
  test("disabled in Entra and still active: the prominent suggestion pre-fills the server's suggested reason", async () => {
    const env = load(), ctx = await openManage(env, { answers: { [mPath()]: manage({ account: { entraEnabled: false, suggestedSuspendReason: "Disabled in Microsoft Entra ID" } }) } });
    assert.match(ctx.html, /emp-m__entra[^>]*role="alert"/);
    assert.match(ctx.html, /data-prefill="entra"[^>]*>Suspend: Disabled in Microsoft Entra ID</);
    ctx.panel.onAction("emp-m-open", btn({ act: "suspend", prefill: "entra", focusKey: "emp-m-entra-suspend" }));
    assert.match(lastDialog(ctx), /name="reason"[^>]*value="Disabled in Microsoft Entra ID"/);
  });
  test("not registered: Grant explains pre-provisioning, Microsoft sign-in and shared Workspace admin; no membership add", async () => {
    const env = load(), ctx = await openManage(env, { answers: { [mPath()]: manage({ account: { state: "not_registered", signedInNow: false }, actions: ACTIONS({ grant: { allowed: true }, revoke: { allowed: true } }), workspaces: manage().workspaces.map((w) => ({ ...w, membership: null, effectiveRole: null })) }) } });
    assert.match(text(ctx.html), /JARC account Not registered/);
    assert.match(text(ctx.html), /Grant access first: memberships need a JARC account\./);
    assert.match(ctx.html, />Revoke \(block sign-in\)…</);
    ctx.panel.onAction("emp-m-open", btn({ act: "grant" }));
    const d = text(lastDialog(ctx));
    assert.match(d, /pre-provisions a JARC account/); assert.match(d, /still sign in with Microsoft/); assert.match(d, /Workspace admin in every workspace/);
  });
  test("suspended and provisioned states, and the P2 tab's new statuses", async () => {
    const env = load();
    const a = await openManage(env, { answers: { [mPath()]: manage({ account: { state: "suspended" }, actions: ACTIONS({ restore: { allowed: true }, revoke: { allowed: true } }) }) } });
    assert.match(text(a.html), /JARC account Suspended/); assert.match(text(a.html), /memberships are kept but give nothing/);
    const b = await openManage(env, { answers: { [mPath()]: manage({ account: { provisioned: true, signedInNow: false } }) } });
    assert.match(text(b.html), /Provisioned \(not signed in yet\)/);
    const x = { esc: (v) => env.A.escape(v), attr: (v) => env.A.escape(v), ds: "active", p: {} };
    const p2 = (account) => text(env.A.html(x, { data: { account: { registered: true, ...account }, workspaces: [], boards: { items: [] }, policy: {} } }));
    assert.match(p2({ status: "suspended" }), /JARC account status Suspended/);
    assert.match(p2({ status: "revoked" }), /JARC account status Revoked/);
    assert.match(p2({ status: "blocked" }), /JARC account status Disabled in JARC/);
    assert.match(p2({ status: "active", provisioned: true, registeredAt: null }), /JARC account Provisioned \(not signed in yet\).*First JARC sign-in Not signed in yet/);
    assert.match(p2({ status: "active" }), /Read-only: JARC access isn't changed here/, "without accessAdmin: P2 wording");
    assert.match(text(env.A.html({ ...x, p: { accessAdmin: true } }, { data: { account: { registered: true, status: "active", entraDisabledWithAccess: true }, workspaces: [], boards: { items: [] }, policy: {} } })), /Open Manage access/);
  });
  test("history: newest first, rejected shown distinctly, actor / from → to / reason / workspace / time; Load more sends the cursor", async () => {
    const env = load(), ctx = await openManage(env);
    const t = text(ctx.html);
    assert.match(ctx.html, /class="emp-m__hist is-rejected"/);
    assert.match(t, /Change refused · Suspend Refused/); assert.match(t, /Refused: You can't suspend or revoke your own account\./);
    assert.match(t, /JARC account: Active → to Suspended/); assert.match(t, /Reason: “Synthetic reason”/);
    assert.match(t, /Membership role: Viewer → to Member/); assert.match(t, /Workspace: Synthetic Workspace A/); assert.match(t, /By Synthetic Owner/);
    assert.match(ctx.html, /<time datetime="2026-11-26T02:00:00.000Z">/);
    ctx.all[`GET ${hPath()}`] = (p) => (p.includes("before=cursor-synthetic-1") ? { items: [{ at: "2026-11-01T00:00:00.000Z", action: "employee.access.granted", result: "ok", actor: "Synthetic Owner", changes: [] }], nextBefore: null } : HISTORY);
    ctx.panel.onAction("emp-m-history-more", btn({}));
    await settle();
    assert.ok(paths(ctx.calls).some((p) => p.includes("access-history?limit=20&before=cursor-synthetic-1")));
    const after = ctx.panel.html();
    assert.match(text(after), /Access granted/); assert.doesNotMatch(after, /emp-m-history-more/, "no more pages");
  });
  test("GET errors: 403 no access (no retry), 404 not available, 429 / 503 with Try again", async () => {
    for (const [status, re, retry] of [[403, /No access.*permission to manage JARC access/, false], [404, /Not available.*isn't available for this person/, true], [429, /Too many requests/, true], [503, /temporarily unavailable/, true]]) {
      const env = load(), { html } = await openManage(env, { answers: { [mPath()]: err(status) } });
      assert.match(text(html), re, String(status));
      assert.equal(/emp-m-retry/.test(html), retry, `${status} retry`);
    }
  });
});

describe("P3 Manage access: writes", () => {
  test("Suspend: reason required; then POST …/access with expectedVersion; busy disables everything; the response replaces the body; toast; history and P2 data reload", async () => {
    const env = load(), ctx = await openManage(env);
    let release;
    ctx.all[`POST ${BASE}/active/records/${ID1}/access`] = () => new Promise((r) => { release = () => r({ manageAccess: manage({ version: 4, account: { state: "suspended" }, actions: ACTIONS({ restore: { allowed: true }, revoke: { allowed: true } }) }) }); });
    ctx.panel.onAction("emp-m-open", btn({ act: "suspend", focusKey: "emp-m-act-suspend" }));
    const d = lastDialog(ctx);
    assert.match(d, /role="dialog" aria-modal="true"/); assert.match(text(d), /sessions end now/); assert.match(text(d), /refused while suspended/); assert.match(d, /data-return-focus-key="emp-m-act-suspend"/);
    await env.M.submit(ctx.panel, form({ reason: "no" }));
    assert.match(text(lastDialog(ctx)), /Give a reason of 3 to 500 characters/);
    assert.equal(paths(ctx.calls).some((p) => p.startsWith("POST")), false, "nothing sent");
    const pending = env.M.submit(ctx.panel, form({ reason: "Synthetic leave of absence" }));
    await settle(1);
    assert.match(lastDialog(ctx), /data-keep-open="1"/); assert.match(lastDialog(ctx), /Working…/);
    const busy = ctx.panel.html();
    for (const m of busy.matchAll(/<button[^>]*data-action="emp-m-[a-z-]+"[^>]*>/g)) assert.match(m[0], / disabled/, m[0]);
    await env.M.submit(ctx.panel, form({ reason: "Synthetic leave of absence" })); // a second submit while busy
    assert.equal(ctx.calls.filter(([m]) => m === "POST").length, 1, "no double submit");
    release(); await pending; await settle();
    const [, , body] = ctx.calls.find(([m]) => m === "POST");
    assert.deepEqual(JSON.parse(JSON.stringify(body)), { action: "suspend", expectedVersion: 3, expectedState: "active", reason: "Synthetic leave of absence" });
    assert.deepEqual(ctx.toasts, ["Account suspended"]);
    const after = ctx.panel.html();
    assert.match(text(after), /JARC account Suspended/); assert.match(after, /data-act="restore"/);
    assert.ok(ctx.calls.filter(([, p]) => p.startsWith(hPath())).length >= 2, "history reloaded");
    assert.equal(ctx.panel.access.key, null, "the JARC access tab reloads");
  });
  test("Revoke: reason and typed REVOKE; the dialog explains sessions, tokens, inert memberships and Grant; the answer's token outcome is shown", async () => {
    const env = load(), ctx = await openManage(env);
    ctx.all[`POST ${BASE}/active/records/${ID1}/access`] = { manageAccess: manage({ account: { state: "revoked" }, actions: ACTIONS({ grant: { allowed: true } }), warnings: [{ code: "MEMBERSHIPS_INERT", message: "Memberships are kept but give nothing while the account is revoked." }] }), result: { action: "revoke", from: "active", to: "revoked", sessionsEnded: 1, tokensRevoked: { jarc: 2, fabric: 1 } } };
    ctx.panel.onAction("emp-m-open", btn({ act: "revoke" }));
    const d = text(lastDialog(ctx));
    for (const re of [/sessions end now/, /tokens are revoked/, /doesn't bring them back/, /Memberships are kept but give nothing/, /they need Grant/, /Type REVOKE to confirm/]) assert.match(d, re);
    await env.M.submit(ctx.panel, form({ reason: "Synthetic offboarding", confirm: "revoke" }));
    assert.match(text(lastDialog(ctx)), /Type REVOKE in capital letters/);
    await env.M.submit(ctx.panel, form({ reason: "Synthetic offboarding", confirm: "REVOKE" }));
    await settle();
    const body = JSON.parse(JSON.stringify(ctx.calls.find(([m]) => m === "POST")[2]));
    assert.deepEqual(body, { action: "revoke", expectedVersion: 3, expectedState: "active", reason: "Synthetic offboarding", confirm: "REVOKE" });
    const t = text(ctx.panel.html());
    assert.match(t, /Access revoked/); assert.match(t, /JARC API: 2 tokens revoked; Fabric API: 1 token revoked\./); assert.match(t, /Check before changing access.*Memberships are kept but give nothing while the account is revoked\./);
  });
  test("suspend / revoke confirmations show the action's warnings and the account's target warnings; unknown codes by their message", async () => {
    const env = load(), acts = ACTIONS({ suspend: { allowed: true, reasonRequired: true, warnings: [{ code: "LAST_WORKSPACE_ADMIN_OF", message: "Last Workspace admin of Synthetic Workspace C." }, { code: "SOMETHING_NEW", message: "A synthetic new warning." }] }, revoke: { allowed: true, reasonRequired: true, confirm: "REVOKE" } });
    const ctx = await openManage(env, { answers: { [mPath()]: manage({ actions: acts, warnings: [{ code: "TARGET_JARC_ADMIN", message: "This person is a JARC administrator." }, { code: "TARGET_GUEST", message: HOSTILE }] }) } });
    assert.match(text(ctx.html), /This person is a JARC administrator\./, "account warnings shown on the tab");
    ctx.panel.onAction("emp-m-open", btn({ act: "suspend" }));
    const d = lastDialog(ctx), t = text(d);
    for (const re of [/Last Workspace admin of Synthetic Workspace C\./, /A synthetic new warning\./, /This person is a JARC administrator\./]) assert.match(t, re);
    assert.doesNotMatch(d, /<script>/); assert.match(d, /&lt;script&gt;/);
    ctx.panel.manage.dialog = null;
    ctx.panel.onAction("emp-m-open", btn({ act: "revoke" }));
    assert.match(text(lastDialog(ctx)), /This person is a JARC administrator\./);
    assert.doesNotMatch(text(lastDialog(ctx)), /Last Workspace admin of Synthetic/, "the suspend action's own warning stays with suspend");
  });
  test("Restore says the existing tokens become usable again", async () => {
    const env = load(), ctx = await openManage(env, { answers: { [mPath()]: manage({ account: { state: "suspended" }, actions: ACTIONS({ restore: { allowed: true } }) }) } });
    ctx.panel.onAction("emp-m-open", btn({ act: "restore" }));
    assert.match(text(lastDialog(ctx)), /existing API tokens become usable again/);
  });
  test("409 conflict: 'Changed by someone else, reloaded', the dialog closes and the body is fetched again", async () => {
    const env = load(), ctx = await openManage(env);
    ctx.all[`POST ${BASE}/active/records/${ID1}/access`] = err(409, "CONFLICT");
    const gets = () => ctx.calls.filter(([m, p]) => m === "GET" && p === mPath()).length, before = gets();
    ctx.panel.onAction("emp-m-open", btn({ act: "suspend" }));
    await env.M.submit(ctx.panel, form({ reason: "Synthetic reason" }));
    await settle();
    assert.deepEqual(ctx.toasts, ["Changed by someone else, reloaded"]);
    assert.equal(ctx.panel.manage.dialog, null, "the dialog is closed (the browser test checks the overlay)");
    assert.ok(gets() > before, "refetched");
    assert.match(text(ctx.panel.html()), /Changed by someone else\. Reloaded/);
  });
  test("400 / 403 / 429 / 503 keep the dialog open with the message", async () => {
    for (const [status, code, re] of [[400, "VALIDATION_ERROR", /wasn't accepted/], [403, "EMPLOYEES_FORBIDDEN", /permission to manage JARC access/], [429, "RATE_LIMITED", /Too many requests/], [503, "EMPLOYEES_UNAVAILABLE", /temporarily unavailable/]]) {
      const env = load(), ctx = await openManage(env);
      ctx.all[`POST ${BASE}/active/records/${ID1}/access`] = err(status, code);
      ctx.panel.onAction("emp-m-open", btn({ act: "suspend" }));
      await env.M.submit(ctx.panel, form({ reason: "Synthetic reason" }));
      assert.match(text(lastDialog(ctx)), re, String(status));
      assert.equal(ctx.toasts.length, 0);
      assert.doesNotMatch(lastDialog(ctx), /data-keep-open/, "not busy any more");
    }
  });
  test("memberships: add (POST workspaceRef + role), change role (PATCH), remove (DELETE, confirm with the shared-access note)", async () => {
    const env = load(), ctx = await openManage(env);
    const fresh = { manageAccess: manage({ version: 5 }) };
    ctx.all[`POST ${BASE}/active/records/${ID1}/memberships`] = fresh;
    ctx.all[`PATCH ${BASE}/active/records/${ID1}/memberships/${REF_A}`] = fresh;
    ctx.all[`DELETE ${BASE}/active/records/${ID1}/memberships/${REF_A}`] = fresh;
    ctx.panel.onSubmit("emp-m-add-form", { elements: { ws: { value: "1" }, role: { value: "MEMBER" } } });
    assert.match(text(lastDialog(ctx)), /Add a membership in Synthetic Workspace B/);
    await env.M.submit(ctx.panel, form({})); await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls.find(([m, p]) => m === "POST" && p.endsWith("/memberships")).slice(1))), [`${BASE}/active/records/${ID1}/memberships`, { workspaceRef: REF_B, role: "MEMBER" }]);
    assert.ok(ctx.toasts.includes("Membership added"));
    ctx.panel.onChange({ dataset: { action: "emp-m-role", ws: "0" }, value: "VIEWER" });
    assert.doesNotMatch(ctx.panel.html().match(/<button[^>]*data-action="emp-m-change" data-ws="0"[^>]*>/)[0], / disabled/, "Change role enabled after picking another role");
    ctx.panel.onAction("emp-m-change", btn({ ws: "0" }));
    const d = text(lastDialog(ctx));
    assert.match(d, /Member → Viewer/); assert.match(d, /Shared access still gives Workspace admin in every workspace/);
    await env.M.submit(ctx.panel, form({})); await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls.find(([m]) => m === "PATCH")[2])), { role: "VIEWER" });
    ctx.panel.onAction("emp-m-remove", btn({ ws: "0" }));
    const r = text(lastDialog(ctx));
    assert.match(r, /Remove the membership in Synthetic Workspace A/); assert.match(r, /only removes member management and comment moderation/); assert.doesNotMatch(r, /access revoked/i);
    await env.M.submit(ctx.panel, form({})); await settle();
    assert.ok(ctx.calls.some(([m, p]) => m === "DELETE" && p.endsWith(`/memberships/${REF_A}`)));
    ctx.panel.onAction("emp-m-remove", btn({ ws: "2" }));
    assert.equal(ctx.calls.filter(([m]) => m === "DELETE").length, 1, "the last admin can't be removed from the UI");
  });
  test("409 last admin and duplicate on memberships reload with their own message", async () => {
    for (const [code, re] of [["LAST_WORKSPACE_ADMIN", /last admin membership/], ["DUPLICATE_MEMBERSHIP", /already has a membership/]]) {
      const env = load(), ctx = await openManage(env);
      ctx.all[`POST ${BASE}/active/records/${ID1}/memberships`] = err(409, code);
      ctx.panel.onSubmit("emp-m-add-form", { elements: { ws: { value: "1" }, role: { value: "VIEWER" } } });
      await env.M.submit(ctx.panel, form({})); await settle();
      assert.match(text(ctx.panel.html()), re, code);
    }
  });
  test("nothing is stored in the browser", async () => {
    const env = load(), ctx = await openManage(env);
    ctx.all[`POST ${BASE}/active/records/${ID1}/access`] = { manageAccess: manage() };
    ctx.panel.onAction("emp-m-open", btn({ act: "suspend" }));
    await env.M.submit(ctx.panel, form({ reason: "Synthetic reason" })); await settle();
    const stored = JSON.stringify([...env.localStorage.map.entries(), ...env.sessionStorage.map.entries()]);
    assert.doesNotMatch(stored, /Synthetic|SyntheticWsRef|manage/i);
    assert.deepEqual(env.forbidden, []);
  });
});
