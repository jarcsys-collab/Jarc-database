// Employee Management P2 (Employee Access Visibility): the JARC access index (src/employees/jarc-access.js) and the P2 parts of
// the service, without HTTP. JARC's data comes from counting stand-ins for the five bounded repository reads; the directory is
// the read-only fake source. Synthetic people only ("Synthetic Person N", @example.com), invented IDs.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { Access } = require("../src/auth/access");
const { createEmployees, JarcAccessIndex, profileId } = require("../src/employees");
const fm = require("../src/fabric/filter-model");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const TENANT = "00000000-0000-4000-8000-00000000a001";
const OTHER_TENANT = "00000000-0000-4000-8000-00000000b002";
const silent = { info() {}, warn() {}, error() {} };
const ADMIN = { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"], who: "u-admin", jarcAccess: true };
const ADMIN_P1 = { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"], who: "u-admin" };
const VIEWER = { view: true, admin: false, datasets: ["active"], who: "u-viewer" };
const and = (...items) => ({ v: 1, op: "and", items });
const enc = (model) => fm.encodeFilterParam(model);
const HOUR = 3600 * 1000;

// Twelve directory accounts, all enabled Members except p6 (disabled in Entra).
function directory() {
  const docs = syntheticPeople(12, { seed: "jarc" });
  docs.forEach((d, i) => { d.account_enabled = i !== 5; d.user_type = "Member"; d.office_location = "Office 1"; });
  return docs;
}

// The JARC side. people[i] = directory doc of p(i+1).
function jarcData(people, t0, { accounts = {} } = {}) {
  const W1 = new ObjectId(), W2 = new ObjectId(), W3 = new ObjectId();
  const u = Object.fromEntries(["A", "B", "C", "D1", "D2", "E", "F", "G", "Orphan", "Dev"].map((k) => [k, new ObjectId()]));
  const oid = (i) => people[i].user_id.toLowerCase();
  const user = (id, entraObjectId, extra = {}) => ({ _id: id, source: "entra", tenantId: TENANT, entraObjectId, status: "active", createdAt: new Date(t0 - 30 * 24 * HOUR), lastLoginAt: new Date(t0 - 2 * HOUR), ...extra });
  const users = [
    user(u.A, oid(0), accounts.A ? { account: accounts.A } : {}), // p1: memberships W1 admin + W2 member
    user(u.B, oid(1), accounts.B ? { account: accounts.B } : {}), // p2: JARC.Admin in a live session
    user(u.C, oid(2), { tenantId: OTHER_TENANT }), // p3: another tenant → never matches
    user(u.D1, oid(3)), user(u.D2, oid(3)), // p4: two JARC users with one object ID → ambiguous
    user(u.E, oid(4), { status: "disabled" }), // p5: disabled in JARC, with a membership
    user(u.F, oid(5), accounts.F ? { account: accounts.F } : {}), // p6: disabled in Entra, member of W3, no live session
    user(u.G, oid(6), accounts.G ? { account: accounts.G } : {}), // p7: an invited row only
    user(u.Orphan, "11111111-2222-4333-8444-555555555555"), // a JARC account with no directory record
    { _id: u.Dev, source: "development", tenantId: null, entraObjectId: null, status: "active", createdAt: new Date(t0) } // never matches
  ];
  const m = (w, who, role, status = "active") => ({ workspaceId: w, userId: who, role, status, createdAt: new Date(t0 - 10 * 24 * HOUR) });
  const memberships = [m(W1, u.A, "WORKSPACE_ADMIN"), m(W2, u.A, "MEMBER"), m(W1, u.E, "MEMBER"), m(W3, u.F, "VIEWER"), m(W1, u.G, "MEMBER", "invited")];
  const workspaces = [{ _id: W1, name: "Alpha WS" }, { _id: W2, name: "Beta WS", archived: false }, { _id: W3, name: "Gamma WS", archived: true }];
  const boards = [
    { _id: new ObjectId(), workspaceId: W1, name: "Alpha board 1", publicId: 100001, archived: false },
    { _id: new ObjectId(), workspaceId: W1, name: "Alpha board 2", publicId: 100002, archived: false, source: { readOnly: true } },
    { _id: new ObjectId(), workspaceId: W2, name: "Beta board", publicId: 100003, archived: true },
    { _id: new ObjectId(), workspaceId: W3, name: "Gamma board", publicId: 100004, archived: false }
  ];
  const s = (who, isSystemAdmin, extra = {}) => ({ userId: who, tenantId: TENANT, objectId: users.find((x) => x._id === who).entraObjectId, isSystemAdmin, expiresAt: new Date(t0 + 4 * HOUR), idleExpiresAt: new Date(t0 + 0.5 * HOUR), lastSeenAt: new Date(t0 - 60 * 1000), ...extra });
  const sessions = [
    s(u.A, false), s(u.A, false, { lastSeenAt: new Date(t0 - 5 * 60 * 1000) }),
    s(u.B, true), s(u.B, false),
    s(u.G, true, { idleExpiresAt: new Date(t0 - 1000) }), // idle-expired: not live (session.js:72)
    s(u.G, true, { tenantId: OTHER_TENANT }), // another tenant: not live (session.js:79)
    s(u.E, true) // a disabled user's session is refused (session.js:84-88)
  ];
  return { ids: { W1, W2, W3, ...u }, users, memberships, workspaces, boards, sessions };
}

function counting(data, { failUsers = () => false } = {}) {
  const calls = { users: 0, memberships: 0, workspaces: 0, boards: 0, sessions: 0, other: 0 };
  const deny = new Proxy({}, { get: () => () => { calls.other += 1; throw new Error("unexpected repository call"); } });
  const repo = (key, method, fn) => new Proxy({ [method]: async (...a) => { calls[key] += 1; if (key === "users" && failUsers()) throw Object.assign(new Error("synthetic outage"), { name: "MongoNetworkError" }); return fn(...a); } }, { get: (t, p) => (p in t ? t[p] : deny[p]) });
  return {
    calls,
    repos: {
      users: repo("users", "listEntraForAccessIndex", () => data.users.filter((x) => x.source === "entra")),
      memberships: repo("memberships", "listForAccessIndex", () => data.memberships.filter((x) => ["active", "invited"].includes(x.status))),
      workspaces: repo("workspaces", "listForAccessIndex", () => data.workspaces),
      boards: repo("boards", "listForAccessIndex", () => data.boards),
      sessions: repo("sessions", "listLiveForAccessIndex", (now) => data.sessions.filter((x) => x.expiresAt > now))
    }
  };
}

async function world({ policy = "role_based", betaOpenEditing = false, accountMode = "off", accounts, apiAdmins = null, employeesAdmins = [], failUsers, logger = silent, features } = {}) {
  let t = Date.UTC(2026, 10, 26, 9, 0, 0);
  const people = directory();
  const data = jarcData(people, t, { accounts });
  const { calls, repos } = counting(data, { failUsers });
  const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: TENANT, viewerObjectIds: [], adminObjectIds: employeesAdmins.map((i) => people[i].user_id.toLowerCase()) }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
  const employees = createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs: people }), idKey: TEST_ID_KEY, now: () => t, logger: silent });
  const access = new Access(repos, { policy, betaOpenEditing, accountMode });
  const index = new JarcAccessIndex({ repos, access, tenantId: TENANT.toUpperCase(), apiAdminObjectIds: apiAdmins === null ? null : apiAdmins.map((i) => people[i].user_id), employeesConfig: config, ...(features ? { features } : {}), now: () => t, logger });
  const snap = await employees.snapshot.current();
  const idOf = (i) => profileId(TEST_ID_KEY, people[i].user_id);
  const rowOf = async (i) => index.joined(snap, await index.current()).byId.get(idOf(i)).values;
  const detailOf = async (i) => index.detail(snap, await index.current(), snap.byId.get(idOf(i)));
  return { people, data, calls, index, service: employees.service, snap, idOf, rowOf, detailOf, tick: (ms) => { t += ms; } };
}
const wsOf = (d, name) => d.workspaces.find((w) => w.name === name);
const perm = (d, key) => d.appPermissions.find((p) => p.key === key);

describe("matching (contract §2)", () => {
  test("registered vs not registered; another tenant and a duplicate object ID never match", async () => {
    const w = await world();
    assert.equal((await w.rowOf(0)).jarcAccount, "Registered");
    for (const i of [2, 3, 7, 8, 9]) {
      const v = await w.rowOf(i);
      assert.deepEqual([v.jarcAccount, v.jarcStatus, v.jarcAdmin, v.jarcAccessSource, v.jarcMemberships, v.jarcWorkspaces, v.jarcSignedInNow, v.jarcDisabledWithAccess], ["Not registered", null, null, "None", null, null, false, false], `p${i + 1}`);
    }
    const summary = w.index.joined(w.snap, await w.index.current()).summary;
    // Registered: p1, p2, p5, p6, p7. Without a match: the other-tenant user, both duplicates and the orphan (the dev user isn't Entra).
    assert.deepEqual(summary, { registered: 5, notRegistered: 7, disabledWithAccess: 1, ambiguous: 1, jarcAccountsWithoutDirectoryMatch: 4, truncated: false });
    const d = await w.detailOf(2);
    assert.equal(d.account.registered, false);
    assert.equal(d.account.matchedBy, null);
    assert.deepEqual(d.workspaces, []);
    assert.deepEqual(d.boards, { total: 0, shown: 0, items: [], truncated: false });
    assert.ok(d.appPermissions.every((p) => p.granted === false));
    assert.ok(d.notes.some((n) => /never signed in/.test(n)));
    assert.equal((await w.detailOf(0)).account.matchedBy, "entra_object_id");
  });

  test("registeredAt / lastSignInAt come from the user; signedInNow and lastSeenAt from live sessions only", async () => {
    const w = await world();
    const v = await w.rowOf(0);
    assert.ok(v.jarcRegistered instanceof Date && v.jarcLastSignIn instanceof Date);
    assert.equal(v.jarcSignedInNow, true);
    const d = await w.detailOf(0);
    assert.equal(d.account.lastSignInPrecisionMinutes, 15);
    assert.equal(d.account.lastSeenAt, new Date(Date.UTC(2026, 10, 26, 9, 0, 0) - 60 * 1000).toISOString(), "the latest lastSeenAt");
    assert.equal((await w.rowOf(5)).jarcSignedInNow, false);
    assert.equal((await w.rowOf(6)).jarcSignedInNow, false, "idle-expired and other-tenant sessions aren't live");
    assert.equal((await w.rowOf(4)).jarcSignedInNow, false, "a disabled user's session is refused");
  });
});

describe("effective access mirrors auth/access.js", () => {
  test("role_based: explicit memberships only; invited rows grant nothing; JARC-disabled has no access", async () => {
    const w = await world();
    const a = await w.rowOf(0);
    assert.deepEqual([a.jarcAccessSource, a.jarcWorkspaceRole, a.jarcMemberships, a.jarcWorkspaces, a.jarcAdmin], ["Membership", "Workspace admin", 2, ["Alpha WS", "Beta WS"], "No"]);
    const d = await w.detailOf(0);
    assert.deepEqual(d.policy, { shared: false, accessPolicy: "role_based", betaOpenEditing: false, accountManagement: "off" });
    assert.deepEqual(d.workspaces.map((x) => x.name), ["Alpha WS", "Beta WS"], "no access and no membership → not listed");
    assert.deepEqual(wsOf(d, "Alpha WS"), { name: "Alpha WS", archived: false, membership: { role: "WORKSPACE_ADMIN", status: "active", since: wsOf(d, "Alpha WS").membership.since }, sharedRole: null, effectiveRole: "WORKSPACE_ADMIN", source: "membership", permissions: { view: true, editContent: true, importSpreadsheets: true, manageBoards: true, manageMembers: true, moderateComments: true }, boards: 2 });
    assert.deepEqual(wsOf(d, "Beta WS").permissions, { view: true, editContent: true, importSpreadsheets: true, manageBoards: false, manageMembers: false, moderateComments: false });
    assert.deepEqual(d.boards.items.map((b) => [b.name, b.workspace, b.publicId, b.readOnly, b.archived, b.effectiveRole, b.source]), [
      ["Alpha board 1", "Alpha WS", 100001, false, false, "WORKSPACE_ADMIN", "membership"], ["Alpha board 2", "Alpha WS", 100002, true, false, "WORKSPACE_ADMIN", "membership"], ["Beta board", "Beta WS", 100003, false, true, "MEMBER", "membership"]]);
    assert.equal(perm(d, "manageWorkspaces").granted, false);
    assert.equal(perm(d, "deleteWorkspace").granted, false);
    const g = await w.detailOf(6);
    assert.equal((await w.rowOf(6)).jarcAccessSource, "None");
    assert.equal((await w.rowOf(6)).jarcMemberships, 0);
    assert.deepEqual(g.workspaces.map((x) => [x.name, x.membership.status, x.effectiveRole]), [["Alpha WS", "invited", null]]);
    assert.equal(g.boards.total, 0);
    const e = await w.rowOf(4);
    assert.deepEqual([e.jarcStatus, e.jarcAccessSource, e.jarcAdmin], ["Disabled in JARC", "None", "No"], "an unusable account is never an administrator");
    assert.ok((await w.detailOf(4)).workspaces.every((x) => x.effectiveRole === null));
  });

  test("SYSTEM_ADMIN: yes from any live session with JARC.Admin, no when none has it, unknown without a live session", async () => {
    const w = await world();
    assert.equal((await w.rowOf(1)).jarcAdmin, "Yes");
    assert.equal((await w.rowOf(1)).jarcAccessSource, "JARC administrator");
    assert.equal((await w.rowOf(0)).jarcAdmin, "No");
    assert.equal((await w.rowOf(5)).jarcAdmin, "Unknown (not signed in)");
    assert.equal((await w.rowOf(6)).jarcAdmin, "Unknown (not signed in)", "idle-expired / other-tenant JARC.Admin sessions don't count");
    const b = await w.detailOf(1);
    assert.deepEqual(b.workspaces.map((x) => [x.name, x.effectiveRole, x.source]), [["Alpha WS", "SYSTEM_ADMIN", "system_admin"], ["Beta WS", "SYSTEM_ADMIN", "system_admin"], ["Gamma WS", "SYSTEM_ADMIN", "system_admin"]]);
    assert.ok(b.workspaces.every((x) => Object.values(x.permissions).every(Boolean)));
    for (const k of ["manageWorkspaces", "deleteWorkspace", "legacyImport", "mondayIntegration", "systemHealth"]) assert.deepEqual([perm(b, k).granted, perm(b, k).source], [true, "system_admin"], k);
    const f = await w.detailOf(5);
    assert.equal(f.account.jarcAdmin, "unknown");
    assert.ok(perm(f, "legacyImport").note, "unknown → a note, not a guess");
    assert.ok(f.notes.some((n) => /only known while the person has a live JARC session/.test(n)));
  });

  test("disabled in Entra with JARC access: flagged, with the session and API token notes", async () => {
    const w = await world();
    const f = await w.rowOf(5);
    assert.equal(f.jarcDisabledWithAccess, true);
    const d = await w.detailOf(5);
    assert.deepEqual([d.account.entraEnabled, d.account.entraDisabledWithAccess], [false, true]);
    assert.ok(d.notes.some((n) => /open JARC session keeps working/.test(n)));
    assert.ok(d.notes.some((n) => /API tokens this person owns keep working/.test(n)));
    assert.equal((await w.rowOf(0)).jarcDisabledWithAccess, false, "enabled in Entra");
  });

  for (const [label, options] of [["development_shared", { policy: "development_shared" }], ["beta open editing", { betaOpenEditing: true }]]) {
    test(`${label}: WORKSPACE_ADMIN everywhere for active users, never for members or moderation`, async () => {
      const w = await world(options);
      const a = await w.rowOf(0);
      assert.equal(a.jarcAccessSource, "Membership and shared access");
      const d = await w.detailOf(0);
      assert.equal(d.policy.shared, true);
      assert.deepEqual(d.workspaces.map((x) => [x.name, x.effectiveRole, x.source, x.sharedRole]), [["Alpha WS", "WORKSPACE_ADMIN", "membership_and_shared", "WORKSPACE_ADMIN"], ["Beta WS", "WORKSPACE_ADMIN", "membership_and_shared", "WORKSPACE_ADMIN"], ["Gamma WS", "WORKSPACE_ADMIN", "shared", "WORKSPACE_ADMIN"]]);
      assert.deepEqual(wsOf(d, "Alpha WS").permissions, { view: true, editContent: true, importSpreadsheets: true, manageBoards: true, manageMembers: true, moderateComments: true }, "a real admin membership");
      for (const name of ["Beta WS", "Gamma WS"]) assert.deepEqual([wsOf(d, name).permissions.manageBoards, wsOf(d, name).permissions.manageMembers, wsOf(d, name).permissions.moderateComments], [true, false, false], name);
      assert.deepEqual([perm(d, "manageWorkspaces").granted, perm(d, "manageWorkspaces").source, perm(d, "deleteWorkspace").granted, perm(d, "legacyImport").granted], [true, "shared", true, false]);
      assert.equal(d.boards.total, 4);
      assert.ok(d.notes.some((n) => /Shared access is on/.test(n)));
      assert.equal((await w.rowOf(6)).jarcAccessSource, "Shared access", "an invited row adds nothing; shared access does");
      assert.equal((await w.rowOf(4)).jarcAccessSource, "None", "disabled in JARC: no shared access");
      assert.ok((await w.detailOf(2)).notes.some((n) => /first sign-in immediately makes them a Workspace admin/.test(n)));
    });
  }

  test("staged: a blocked account has no access; pending still does (only enforced refuses pending)", async () => {
    const w = await world({ policy: "development_shared", accountMode: "staged", accounts: { A: { status: "blocked", role: "ADMIN", version: 2 }, G: { status: "pending", role: null, version: 1 } } });
    const a = await w.rowOf(0);
    assert.deepEqual([a.jarcStatus, a.jarcAccessSource, a.jarcSignedInNow], ["Active", "None", false]);
    assert.ok((await w.detailOf(0)).notes.some((n) => /blocked/.test(n)));
    assert.deepEqual((await w.detailOf(0)).account.accountRole, { status: "blocked", role: "ADMIN" });
    assert.equal((await w.rowOf(6)).jarcAccessSource, "Shared access");
    assert.deepEqual((await w.detailOf(1)).account.accountRole, { status: "legacy", role: null });
  });

  test("enforced: shared access off, roles capped, SYSTEM_ADMIN = active Super Admin, pending gets nothing", async () => {
    const w = await world({ policy: "development_shared", betaOpenEditing: true, accountMode: "enforced", accounts: { A: { status: "active", role: "EDITOR", version: 3 }, B: { status: "active", role: "VIEWER", version: 1 }, F: { status: "active", role: "SUPER_ADMIN", version: 1 }, G: { status: "pending", role: null, version: 1 } } });
    const d = await w.detailOf(0);
    assert.deepEqual(d.policy, { shared: false, accessPolicy: "role_based", betaOpenEditing: false, accountManagement: "enforced" });
    assert.deepEqual(d.workspaces.map((x) => [x.name, x.effectiveRole, x.source]), [["Alpha WS", "MEMBER", "membership"], ["Beta WS", "MEMBER", "membership"]], "EDITOR caps WORKSPACE_ADMIN to MEMBER");
    assert.deepEqual(wsOf(d, "Alpha WS").permissions, { view: true, editContent: true, importSpreadsheets: true, manageBoards: false, manageMembers: false, moderateComments: false });
    assert.equal((await w.rowOf(0)).jarcWorkspaceRole, "Member");
    assert.equal((await w.rowOf(1)).jarcAdmin, "No", "JARC.Admin alone grants nothing when enforced");
    const f = await w.rowOf(5);
    assert.deepEqual([f.jarcAdmin, f.jarcAccessSource], ["Yes", "JARC administrator"], "an active Super Admin, without a session");
    assert.equal((await w.rowOf(6)).jarcAccessSource, "None");
    assert.ok((await w.detailOf(6)).notes.some((n) => /waiting for approval/.test(n)));
    assert.ok(d.notes.some((n) => /enforced/.test(n)));
  });

  test("app permissions from configuration: API administrators and Employee Management", async () => {
    const off = await world();
    assert.match(perm(await off.detailOf(0), "apiTokenAdmin").note, /switched off/);
    const w = await world({ apiAdmins: [0], employeesAdmins: [1] });
    assert.deepEqual([perm(await w.detailOf(0), "apiTokenAdmin").granted, perm(await w.detailOf(0), "apiTokenAdmin").source], [true, "config"]);
    assert.equal(perm(await w.detailOf(1), "apiTokenAdmin").granted, false);
    assert.deepEqual([perm(await w.detailOf(1), "employeeDirectory").granted, perm(await w.detailOf(1), "employeeDirectory").level], [true, "admin"]);
    assert.equal(perm(await w.detailOf(0), "employeeDirectory").level, "none");
    assert.equal(perm(await w.detailOf(4), "apiTokenAdmin").granted, false, "a JARC-disabled user can't use it");
  });
});

describe("refresh: bounded, single-flight, cached, stale on failure", () => {
  test("one bounded read per repository per refresh, shared by concurrent callers; nothing per employee", async () => {
    const w = await world();
    await Promise.all([w.index.current(), w.index.current(), w.index.current()]);
    assert.deepEqual(w.calls, { users: 1, memberships: 1, workspaces: 1, boards: 1, sessions: 1, other: 0 });
    for (let i = 0; i < 12; i += 1) { await w.rowOf(i); await w.detailOf(i); }
    await w.service.listRecords("all", { fields: "jarcAccount,jarcWorkspaces", limit: "200" }, ADMIN, w.index);
    await w.service.values("all", { field: "jarcWorkspaces" }, ADMIN, w.index);
    assert.deepEqual(w.calls, { users: 1, memberships: 1, workspaces: 1, boards: 1, sessions: 1, other: 0 }, "within the TTL: no further reads");
    w.tick(61 * 1000);
    await w.index.current();
    assert.deepEqual(w.calls, { users: 2, memberships: 2, workspaces: 2, boards: 2, sessions: 2, other: 0 });
  });

  test("a failed refresh keeps the last good index (stale); with none, 503 EMPLOYEES_UNAVAILABLE; logs carry no ID", async () => {
    let fail = false;
    const logs = [];
    const w = await world({ failUsers: () => fail, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) } });
    const first = await w.index.current();
    fail = true; w.tick(61 * 1000);
    const again = await w.index.current();
    assert.equal(again, first);
    assert.equal(w.index.meta(again).stale, true);
    assert.equal((await w.detailOf(0)).stale, true);
    fail = false; w.tick(61 * 1000);
    assert.equal(w.index.meta(await w.index.current()).stale, false);
    const cold = await world({ failUsers: () => true });
    await assert.rejects(cold.index.current(), (e) => e.status === 503 && e.code === "EMPLOYEES_UNAVAILABLE");
    await assert.rejects(cold.service.jarcAccessOf("all", cold.idOf(0), {}, ADMIN, cold.index), (e) => e.status === 503);
    await assert.rejects(cold.service.listRecords("all", { fields: "jarcAccount" }, ADMIN, cold.index), (e) => e.status === 503);
    assert.equal((await cold.service.listRecords("all", {}, ADMIN, cold.index)).items.length, 12, "a request without JARC fields doesn't need the index");
    assert.equal((await cold.service.status({}, ADMIN, cold.index)).jarcAccess, null, "status stays available");
    const text = logs.join("\n");
    for (const id of [...Object.values(w.data.ids).map(String), ...w.people.map((p) => p.user_id.toLowerCase()), "synthetic outage"]) assert.ok(!text.includes(id), id);
  });
});

describe("no raw IDs", () => {
  test("no object ID, JARC user ID, workspace, board or membership _id in any P2 output; oidById is never serialised", async () => {
    const w = await world({ policy: "development_shared" });
    const out = [JSON.stringify(w.snap), JSON.stringify(Object.keys(w.snap))];
    for (let i = 0; i < 12; i += 1) out.push(JSON.stringify(await w.detailOf(i)));
    out.push(JSON.stringify(await w.service.listRecords("all", { fields: ["displayName", ...require("../src/employees/fields").JARC_FIELD_NAMES].join(","), limit: "200" }, ADMIN, w.index)));
    out.push(JSON.stringify(await w.service.getRecord("all", w.idOf(0), {}, ADMIN, w.index)));
    out.push(JSON.stringify(await w.service.status({}, ADMIN, w.index)));
    out.push(JSON.stringify(await w.service.jarcAccessOf("all", w.idOf(1), {}, ADMIN, w.index)));
    const text = out.join("\n");
    const ids = [...Object.values(w.data.ids).map(String), ...w.data.boards.map((b) => String(b._id)), ...w.people.map((p) => p.user_id.toLowerCase()), ...w.people.map((p) => p.user_id), TENANT, OTHER_TENANT];
    for (const id of ids) assert.ok(!text.toLowerCase().includes(id.toLowerCase()), id);
    assert.equal(Object.keys(w.snap).includes("oidById"), false);
  });
});

describe("the P2 fields in the service", () => {
  test("viewers and P1 callers get exactly the P1 descriptor; any JARC field is the existing \"Unknown field.\" 400, never named", async () => {
    const w = await world();
    const p1 = w.service.schema("active", {}, VIEWER);
    assert.ok(!p1.fields.some((f) => f.name.startsWith("jarc") || "group" in f));
    assert.deepEqual(w.service.schema("all", {}, ADMIN_P1).fields.map((f) => f.name), w.service.schema("all", {}, { ...ADMIN_P1, jarcAccess: false }).fields.map((f) => f.name));
    assert.ok(!("jarcAccess" in (await w.service.status({}, VIEWER, w.index))));
    assert.ok(!("jarcAccess" in (await w.service.status({}, VIEWER, w.index)).access));
    const bad = [
      () => w.service.listRecords("active", { fields: "displayName,jarcAccount" }, VIEWER, w.index),
      () => w.service.listRecords("active", { filter: enc(and({ field: "jarcAccount", op: "eq", value: "Registered" })) }, VIEWER, w.index),
      () => w.service.listRecords("active", { orderBy: "jarcMemberships:asc" }, VIEWER, w.index),
      () => w.service.values("active", { field: "jarcWorkspaces" }, VIEWER, w.index),
      () => w.service.values("active", { field: "department", filter: enc(and({ field: "jarcSignedInNow", op: "isTrue" })) }, VIEWER, w.index)
    ];
    for (const fn of bad) await assert.rejects(fn(), (e) => e.status === 400 && /Unknown field/.test(e.message) && !e.message.includes("jarc") && !JSON.stringify(e.details || {}).includes("jarc"));
    const profile = await w.service.getRecord("active", w.idOf(0), {}, VIEWER, w.index);
    assert.ok(!Object.keys(profile.values).some((k) => k.startsWith("jarc")));
    await assert.rejects(w.service.jarcAccessOf("active", w.idOf(0), {}, VIEWER, w.index), (e) => e.status === 403 && e.code === "EMPLOYEES_FORBIDDEN");
    await assert.rejects(w.service.jarcAccessOf("all", w.idOf(0), {}, ADMIN_P1, null), (e) => e.status === 403, "an admin on a mount without the index");
  });

  test("admins: schema groups, records and profile values, multi-valued and number filters, value counts", async () => {
    const w = await world();
    const schema = w.service.schema("all", {}, ADMIN);
    const ws = schema.fields.find((f) => f.name === "jarcWorkspaces");
    assert.deepEqual([ws.group, ws.multiValued, ws.kind, ws.valueSource], ["jarc", true, "category", "distinct"]);
    const mem = schema.fields.find((f) => f.name === "jarcMemberships");
    assert.deepEqual([mem.type, mem.kind, mem.operators.map((o) => o.op).filter((o) => ["gt", "gte", "lt", "lte", "between"].includes(o)).length], ["number", "number", 5]);
    assert.deepEqual(schema.defaultColumns, ["displayName", "jobTitle", "department", "officeLocation", "mail"]);
    assert.deepEqual(schema.access, { datasets: ADMIN.datasets, admin: true, jarcAccess: true });
    const names = (r) => r.items.map((x) => x.values.displayName).sort();
    const list = async (cond) => names(await w.service.listRecords("all", { fields: "displayName", filter: enc(and(cond)), limit: "200" }, ADMIN, w.index));
    const P = (i) => w.people[i].display_name;
    assert.deepEqual(await list({ field: "jarcWorkspaces", op: "eq", value: "Beta WS" }), [P(0)]);
    assert.deepEqual(await list({ field: "jarcWorkspaces", op: "in", values: ["Gamma WS", "Beta WS"] }), [P(0), P(5)].sort());
    // Alpha WS: p1 and p5 (a JARC-disabled user keeps the membership row; it grants nothing).
    assert.equal((await list({ field: "jarcWorkspaces", op: "ne", value: "Alpha WS" })).length, 10, "ne: no element matches (blanks included)");
    assert.equal((await list({ field: "jarcWorkspaces", op: "nin", values: ["Alpha WS", "Gamma WS"] })).length, 9);
    assert.deepEqual(await list({ field: "jarcWorkspaces", op: "notBlank" }), [P(0), P(4), P(5)].sort());
    assert.equal((await list({ field: "jarcWorkspaces", op: "blank" })).length, 9);
    assert.deepEqual(await list({ field: "jarcMemberships", op: "gt", value: "1" }), [P(0)]);
    assert.deepEqual(await list({ field: "jarcMemberships", op: "gte", value: "1" }), [P(0), P(4), P(5)].sort());
    assert.deepEqual(await list({ field: "jarcMemberships", op: "lt", value: "1" }), [P(1), P(6)].sort(), "blanks (not registered) never match a comparison");
    assert.deepEqual(await list({ field: "jarcMemberships", op: "lte", value: "0" }), [P(1), P(6)].sort());
    assert.deepEqual(await list({ field: "jarcMemberships", op: "between", value: "1", to: "1" }), [P(4), P(5)].sort());
    assert.deepEqual(await list({ field: "jarcMemberships", op: "eq", value: "2" }), [P(0)]);
    assert.deepEqual(await list({ field: "jarcDisabledWithAccess", op: "isTrue" }), [P(5)]);
    assert.deepEqual(await list({ field: "jarcAdmin", op: "eq", value: "Yes" }), [P(1)]);
    const rec = await w.service.listRecords("all", { fields: "displayName,jarcWorkspaces,jarcRegistered", filter: enc(and({ field: "jarcMemberships", op: "eq", value: "2" })) }, ADMIN, w.index);
    assert.equal(rec.items[0].values.jarcWorkspaces, "Alpha WS, Beta WS", "one sorted string in records");
    assert.match(rec.items[0].values.jarcRegistered, /^\d{4}-\d{2}-\d{2}T/);
    const profile = await w.service.getRecord("all", w.idOf(0), {}, ADMIN, w.index);
    assert.equal(profile.values.jarcAccount, "Registered");
    assert.equal(profile.record.fields.find((f) => f.name === "jarcWorkspaces").group, "jarc");
    assert.ok(!("group" in profile.record.fields.find((f) => f.name === "displayName")));
    const values = await w.service.values("all", { field: "jarcWorkspaces" }, ADMIN, w.index);
    assert.deepEqual(values.values, [{ value: null, count: 9, blank: true }, { value: "Alpha WS", count: 2 }, { value: "Beta WS", count: 1 }, { value: "Gamma WS", count: 1 }], "each element counted");
    const src = await w.service.values("all", { field: "jarcAccessSource" }, ADMIN, w.index);
    assert.deepEqual(src.values.map((x) => [x.value, x.count]), [["JARC administrator", 1], ["Membership", 2], ["None", 9]]);
    const status = await w.service.status({}, ADMIN, w.index);
    assert.deepEqual(Object.keys(status.jarcAccess).sort(), ["ambiguous", "disabledWithAccess", "generatedAt", "jarcAccountsWithoutDirectoryMatch", "notRegistered", "registered", "stale", "truncated"]);
    // orderBy on a JARC field pages correctly with signed cursors.
    const seen = []; let cursor;
    do { const page = await w.service.listRecords("all", { orderBy: "jarcMemberships:desc", limit: "5", ...(cursor ? { cursor } : {}) }, ADMIN, w.index); seen.push(...page.items.map((x) => x.id)); cursor = page.pagination.nextCursor; } while (cursor);
    assert.equal(new Set(seen).size, 12);
    // The access endpoint: no query parameters; the profile's dataset rules.
    await assert.rejects(w.service.jarcAccessOf("all", w.idOf(0), { x: "1" }, ADMIN, w.index), (e) => e.status === 400);
    await assert.rejects(w.service.jarcAccessOf("disabled", w.idOf(0), {}, ADMIN, w.index), (e) => e.status === 404, "outside the dataset");
    await assert.rejects(w.service.jarcAccessOf("all", "Q".repeat(22), {}, ADMIN, w.index), (e) => e.status === 404);
    await assert.rejects(w.service.jarcAccessOf("nope", w.idOf(0), {}, ADMIN, w.index), (e) => e.status === 404);
    const body = await w.service.jarcAccessOf("disabled", w.idOf(5), {}, ADMIN, w.index);
    assert.deepEqual(Object.keys(body), ["dataset", "id", "generatedAt", "stale", "truncated", "policy", "account", "appPermissions", "workspaces", "boards", "notes"]);
  });

  test("at most 200 board items, accessible workspaces first by name", async () => {
    const w = await world({ policy: "development_shared" });
    for (let i = 0; i < 250; i += 1) w.data.boards.push({ _id: new ObjectId(), workspaceId: w.data.ids.W2, name: `Bulk ${i}`, publicId: 200000 + i, archived: false });
    w.tick(61 * 1000);
    const d = await w.detailOf(1);
    assert.deepEqual([d.boards.total, d.boards.shown, d.boards.items.length, d.boards.truncated], [254, 200, 200, true]);
  });

  test("an admin's profile doesn't fail when JARC's database can't be read: P1 values, JARC fields null, jarcAccessUnavailable", async () => {
    const cold = await world({ failUsers: () => true });
    const profile = await cold.service.getRecord("all", cold.idOf(0), {}, ADMIN, cold.index);
    assert.equal(profile.jarcAccessUnavailable, true);
    assert.equal(profile.values.displayName, cold.people[0].display_name);
    for (const f of require("../src/employees/fields").JARC_FIELD_NAMES) assert.equal(profile.values[f], null, f);
    const warm = await world();
    assert.ok(!("jarcAccessUnavailable" in (await warm.service.getRecord("all", warm.idOf(0), {}, ADMIN, warm.index))));
    assert.ok(!("jarcAccessUnavailable" in (await warm.service.getRecord("active", warm.idOf(0), {}, VIEWER, warm.index))));
  });

  test("a read at its cap marks the answer truncated (status and the access endpoint), users: matching unreliable", async () => {
    const w = await world();
    for (let i = w.data.users.filter((u) => u.source === "entra").length; i < 5000; i += 1) w.data.users.push({ _id: new ObjectId(), source: "entra", tenantId: TENANT, entraObjectId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, status: "active", createdAt: new Date() });
    const status = await w.service.status({}, ADMIN, w.index);
    assert.equal(status.jarcAccess.truncated, true);
    const d = await w.detailOf(0);
    assert.equal(d.truncated, true);
    assert.ok(d.notes.some((n) => /matching is unreliable/.test(n)));
    const plain = await world();
    assert.equal((await plain.service.status({}, ADMIN, plain.index)).jarcAccess.truncated, false);
  });

  test("feature switches: spreadsheet imports and the monday.com integration off → not available", async () => {
    const w = await world({ policy: "development_shared", features: { spreadsheetImports: false, mondayIntegration: false } });
    const b = await w.detailOf(1); // a JARC administrator
    assert.ok(b.workspaces.every((x) => x.permissions.importSpreadsheets === false && x.permissions.editContent === true));
    assert.deepEqual([perm(b, "mondayIntegration").granted, perm(b, "mondayIntegration").source], [false, null]);
    assert.match(perm(b, "mondayIntegration").note, /Not available/);
    assert.equal(perm(b, "legacyImport").granted, true);
    assert.ok(b.notes.some((n) => /Spreadsheet imports are switched off/.test(n)));
  });
});

// ---- Over HTTP: the real app (createApp with Entra sign-in, a FakeMongoClient data layer and the read-only directory fake).
describe("HTTP: who may use the P2 parts", () => {
  const { before, after } = require("node:test");
  const { startApp, SessionClient } = require("./helpers");
  const { createTokenIssuer } = require("./support/entra-tokens");
  const { FakeMongoClient } = require("./support/fake-mongo");
  const { MongoConnection } = require("../src/db/connection");
  const { ensureDatabase } = require("../src/db/bootstrap");
  const { createDataLayer } = require("../src/data-layer");
  const { MemoryFileStore } = require("../src/files/file-store");
  const BASE = "/api/v1/admin/employees";
  let issuer, P, app, db, people, clients, idOf, secretTexts;
  const code = (res) => res.body?.error?.code;
  before(async () => {
    issuer = await createTokenIssuer();
    P = { owner: issuer.person("Synthetic Owner"), viewer: issuer.person("Synthetic Viewer"), outsider: issuer.person("Synthetic Outsider", { admin: true }) };
    people = syntheticPeople(6, { seed: "http" });
    people.forEach((d) => { d.account_enabled = true; d.user_type = "Member"; });
    // The owner, the viewer and the outsider have directory accounts too (registered once they sign in).
    for (const [i, p] of [P.owner, P.viewer, P.outsider].entries()) Object.assign(people[i], { user_id: p.oid, display_name: `Synthetic Person ${i + 1}` });
    people[2].account_enabled = false; // the outsider is disabled in Entra (the offline issuer still lets them sign in)
    const fake = new FakeMongoClient();
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
    await connection.connect();
    await ensureDatabase(connection.db);
    db = connection.db;
    const logger = { errors: [], error(...a) { this.errors.push(a.map(String).join(" ")); }, warn() {}, info() {} };
    const dataLayer = createDataLayer({ connection, logger, fileStore: new MemoryFileStore(), environment: "test" });
    const { createEntraVerifier } = require("../src/auth/entra-token");
    const verify = createEntraVerifier({ ...issuer.config, keySet: issuer.keySet });
    const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: issuer.config.tenantId, viewerObjectIds: [P.viewer.oid], adminObjectIds: [P.owner.oid] }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
    const employees = createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs: people }), idKey: TEST_ID_KEY, logger: silent });
    app = await startApp({ dataLayer, auth: { mode: "entra", entra: issuer.config, verify }, logger, employees, accessPolicy: "development_shared", betaOpenEditing: true });
    clients = {};
    for (const [k, p] of Object.entries(P)) { clients[k] = new SessionClient(app.url, issuer.config.appOrigin); assert.equal((await clients[k].signIn(p)).status, 201); }
    // JARC data: one workspace with a board; the outsider is a member of it.
    const W = new ObjectId(), outsider = await db.collection("users").findOne({ entraObjectId: P.outsider.oid });
    await db.collection("workspaces").insertOne({ _id: W, name: "Synthetic WS", position: 1000, archived: false, version: 1 });
    await db.collection("boards").insertOne({ _id: new ObjectId(), workspaceId: W, name: "Synthetic board", publicId: 100042, archived: false, position: 1000, columns: [{ key: "secretcolumn", label: "Secret column" }], version: 1 });
    await db.collection("workspaceMembers").insertOne({ workspaceId: W, userId: outsider._id, role: "MEMBER", status: "active", createdAt: new Date(), updatedAt: new Date() });
    idOf = (i) => profileId(TEST_ID_KEY, people[i].user_id);
    const users = await db.collection("users").find({}).toArray(), sessions = await db.collection("sessions").find({}).toArray(), boards = await db.collection("boards").find({}).toArray();
    secretTexts = [...people.map((d) => d.user_id.toLowerCase()), ...users.map((u) => String(u._id)), ...sessions.map((s) => String(s._id)), String(W), ...boards.map((b) => String(b._id)), issuer.config.tenantId, "secretcolumn", "+00", "Synthetic Company"];
  });
  after(async () => { await app?.close(); });
  const as = (who, method, path, body, options) => clients[who].request(method, path, body, options);
  const noRawIds = (res, label) => { for (const t of secretTexts) assert.ok(!res.text.toLowerCase().includes(t.toLowerCase()), `${label}: ${t}`); };

  test("every new or changed endpoint: admin, viewer, outsider, bearer token, signed out", async () => {
    const paths = ["/status", "/all/schema", "/active/schema", "/active/records?fields=displayName,jarcAccount", "/active/records", `/active/records/${idOf(0)}`, "/active/values?field=jarcAccessSource", `/active/records/${idOf(0)}/jarc-access`, `/all/records/${idOf(2)}/jarc-access`];
    for (const p of paths) {
      const signedOut = await fetch(`${app.url}${BASE}${p}`);
      assert.equal(signedOut.status, 401, `signed out ${p}`);
      const bearer = await as("owner", "GET", `${BASE}${p}`, undefined, { headers: { Authorization: `Bearer jarc_${"A".repeat(40)}` } });
      assert.equal(bearer.status, 401, `bearer ${p}`);
      const outsider = await as("outsider", "GET", `${BASE}${p}`);
      assert.deepEqual([outsider.status, code(outsider)], [403, "EMPLOYEES_FORBIDDEN"], `outsider ${p}`);
      const owner = await as("owner", "GET", `${BASE}${p}`);
      assert.equal(owner.status, 200, `owner ${p}: ${owner.text.slice(0, 200)}`);
      assert.equal(owner.headers.get("cache-control"), "no-store");
      noRawIds(owner, `owner ${p}`);
      const viewer = await as("viewer", "GET", `${BASE}${p}`);
      noRawIds(viewer, `viewer ${p}`);
      if (p.startsWith("/all/")) assert.equal(viewer.status, 403, `viewer ${p}`);
      else if (p.endsWith("/jarc-access")) assert.deepEqual([viewer.status, code(viewer)], [403, "EMPLOYEES_FORBIDDEN"], `viewer ${p}`);
      else if (p.includes("jarc")) { assert.equal(viewer.status, 400, `viewer ${p}`); assert.match(viewer.body.error.message, /Unknown field/); assert.ok(!viewer.text.includes("jarc")); }
      else assert.equal(viewer.status, 200, `viewer ${p}`);
    }
  });

  test("the admin's view: status counts, schema fields, the access body; viewers' responses stay P1", async () => {
    const status = (await as("owner", "GET", `${BASE}/status`)).body;
    assert.deepEqual(status.access, { datasets: ["active", "all", "disabled", "guests"], admin: true, jarcAccess: true });
    assert.deepEqual([status.jarcAccess.registered, status.jarcAccess.notRegistered, status.jarcAccess.disabledWithAccess, status.jarcAccess.ambiguous, status.jarcAccess.jarcAccountsWithoutDirectoryMatch, status.jarcAccess.stale], [3, 3, 1, 0, 0, false]);
    const vstatus = (await as("viewer", "GET", `${BASE}/status`)).body;
    assert.deepEqual(vstatus.access, { datasets: ["active"], admin: false });
    assert.ok(!("jarcAccess" in vstatus));
    const vschema = (await as("viewer", "GET", `${BASE}/active/schema`)).body;
    assert.ok(!vschema.fields.some((f) => f.name.startsWith("jarc")));
    const schema = (await as("owner", "GET", `${BASE}/active/schema`)).body;
    assert.equal(schema.fields.filter((f) => f.group === "jarc").length, 11);
    const body = (await as("owner", "GET", `${BASE}/all/records/${idOf(2)}/jarc-access`)).body;
    assert.equal(body.account.registered, true);
    assert.equal(body.account.jarcAdmin, "yes", "the outsider signed in with JARC.Admin");
    assert.equal(body.account.entraDisabledWithAccess, true);
    assert.deepEqual(body.policy, { shared: true, accessPolicy: "development_shared", betaOpenEditing: true, accountManagement: "off" });
    assert.deepEqual(body.boards.items, [{ name: "Synthetic board", workspace: "Synthetic WS", publicId: 100042, archived: false, readOnly: false, effectiveRole: "SYSTEM_ADMIN", source: "system_admin" }]);
    const rec = (await as("owner", "GET", `${BASE}/all/records?fields=displayName,jarcAccount,jarcWorkspaces&limit=200`)).body;
    assert.equal(rec.items.find((r) => r.id === idOf(2)).values.jarcWorkspaces, "Synthetic WS");
    assert.equal((await as("owner", "GET", `${BASE}/all/records/${idOf(0)}/jarc-access?x=1`)).status, 400);
  });

  test("saved filters validate against the caller's descriptor", async () => {
    const state = { filter: and({ field: "jarcAccount", op: "eq", value: "Registered" }), orderBy: [["jarcMemberships", "desc"]], columns: ["displayName", "jarcAccount"] };
    const v = await as("viewer", "POST", `${BASE}/saved-filters/active`, { name: "Registered", state });
    assert.equal(v.status, 400);
    assert.match(v.body.error.message, /Unknown field/);
    assert.ok(!v.text.includes("jarc"));
    assert.equal((await as("viewer", "POST", `${BASE}/saved-filters/active`, { name: "Order", state: { orderBy: [["jarcMemberships", "desc"]] } })).status, 400);
    const o = await as("owner", "POST", `${BASE}/saved-filters/active`, { name: "Registered", state });
    assert.equal(o.status, 201, o.text);
    assert.equal(o.body.valid, true);
    assert.deepEqual(o.body.state.columns, ["displayName", "jarcAccount"]);
    assert.equal((await as("owner", "GET", `${BASE}/saved-filters/active`)).body.items[0].valid, true);
  });

  test("bounded reads: one projected query per JARC collection per refresh; sessions never read _id", async () => {
    const coll = (name) => db.collection(name).calls.filter((c) => c.op === "find" && c.options?.projection && c.options.limit >= 1000);
    const counts = () => Object.fromEntries(["users", "workspaceMembers", "workspaces", "boards", "sessions"].map((n) => [n, coll(n).length]));
    const start = counts();
    for (let i = 0; i < 3; i += 1) { await as("owner", "GET", `${BASE}/all/records?fields=displayName,jarcAccount&limit=200`); await as("owner", "GET", `${BASE}/all/records/${idOf(i)}/jarc-access`); }
    const end = counts();
    for (const n of Object.keys(start)) assert.ok(end[n] - start[n] <= 1, `${n}: ${end[n] - start[n]} reads`);
    const s = coll("sessions").at(-1);
    assert.equal(s.options.projection._id, 0);
    assert.ok(s.filter.expiresAt.$gt instanceof Date);
    assert.equal(s.options.limit, 5000);
    const u = coll("users").at(-1);
    assert.equal(u.options.limit, 5000);
    assert.ok(!("displayName" in u.options.projection) && !("email" in u.options.projection));
    assert.ok(!("columns" in coll("boards").at(-1).options.projection));
  });

  test("the profile's JARC access tab is a page link", async () => {
    const res = await fetch(`${app.url}/admin/employees/all/records/${idOf(0)}/access`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.equal((await fetch(`${app.url}/admin/employees/all/records/${idOf(0)}/other`)).status, 404, "only …/access is a page");
  });
});
