// Account Management (Phase M4.3): pending accounts, the verified first Super Admin, global roles capping workspace
// memberships, approval workflow, Super Admin protections, session refresh, beta-override handling, legacy users and
// the audit trail. Offline: local test keys, fake MongoDB. Fictional identifiers stand in for the real administrator in pure
// checks (configuration and eligibility); nothing contacts Microsoft, Atlas or Railway.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FakeMongoClient } = require("./support/fake-mongo");
const { loadConfig } = require("../src/config");
const { createApp } = require("../src/app");
const { superAdminEligibility, capWorkspaceRole, accountOf, reconciliationReport } = require("../src/auth/accounts");
const { entraSessionCheck } = require("../src/routes/events");
const { planAccessStage } = require("../src/migration/monday/access-stages");

// A fictional administrator identity (valid GUIDs; not a real tenant, account or address).
const ADMIN_IDENTITY = Object.freeze({ tenantId: "7c1e2d3a-4b5f-4a68-9c77-0a1b2c3d4e5f", objectId: "3f9a8b7c-6d5e-4f40-8a31-b2c4d6e8f0a1", email: "super.admin@jarc.example.invalid" });
const ENTRA_ENV = { DATA_STORE: "mongodb", MONGODB_URI: "mongodb://fake.invalid", MONGODB_DB_NAME: "jarc_database", AUTH_MODE: "entra", ENTRA_TENANT_ID: ADMIN_IDENTITY.tenantId, ENTRA_SPA_CLIENT_ID: "22222222-2222-2222-2222-222222222222", ENTRA_REDIRECT_URI: "https://jarc.example.invalid/" };
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "docs", label: "Documents", type: "files" }, { key: "notes", label: "Notes", type: "text" }];
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body-".repeat(50))]);
const ok = (res, label) => assert.ok(res.status < 400, `${label}: expected success, got ${res.status} ${res.text?.slice(0, 200)}`);

describe("ACCOUNT_MANAGEMENT configuration", () => {
  test("off by default; only off, staged or enforced; never guessed", () => {
    assert.equal(loadConfig(ENTRA_ENV).accounts.mode, "off");
    for (const mode of ["staged", "enforced"]) assert.equal(loadConfig({ ...ENTRA_ENV, ACCOUNT_MANAGEMENT: mode }).accounts.mode, mode);
    for (const bad of ["on", "Enforced", "true", "strict"]) assert.throws(() => loadConfig({ ...ENTRA_ENV, ACCOUNT_MANAGEMENT: bad }), /must be off, staged or enforced/);
  });
  test("production: off or staged (observation mode) only; enforced stays refused until separately approved; Entra sign-in is required", () => {
    assert.throws(() => loadConfig({ ...ENTRA_ENV, NODE_ENV: "production", ACCOUNT_MANAGEMENT: "enforced" }), /enforced is not approved for production/);
    for (const mode of ["off", "staged"]) assert.equal(loadConfig({ ...ENTRA_ENV, NODE_ENV: "production", ACCOUNT_MANAGEMENT: mode }).accounts.mode, mode);
    assert.throws(() => loadConfig({ ACCOUNT_MANAGEMENT: "staged" }), /needs AUTH_MODE=entra/);
    assert.throws(() => createApp({ environment: "production", enableDevStateApi: false, accounts: { mode: "enforced" }, auth: { mode: "entra", entra: {}, verify: () => {} }, dataLayer: { repos: {} } }), /enforced is not approved for production/);
  });
  test("the configured Super Admin identity is accepted for its own tenant; a tenant mismatch or half a setting is refused", () => {
    const config = loadConfig({ ...ENTRA_ENV, ACCOUNT_MANAGEMENT: "staged", JARC_SUPER_ADMIN_TENANT_ID: ADMIN_IDENTITY.tenantId.toUpperCase(), JARC_SUPER_ADMIN_OBJECT_ID: ADMIN_IDENTITY.objectId, JARC_SUPER_ADMIN_EMAIL: ADMIN_IDENTITY.email });
    assert.deepEqual({ ...config.accounts.superAdmin }, ADMIN_IDENTITY);
    assert.throws(() => loadConfig({ ...ENTRA_ENV, ENTRA_TENANT_ID: "11111111-1111-1111-1111-111111111111", JARC_SUPER_ADMIN_TENANT_ID: ADMIN_IDENTITY.tenantId, JARC_SUPER_ADMIN_OBJECT_ID: ADMIN_IDENTITY.objectId }), /same tenant as ENTRA_TENANT_ID/);
    assert.throws(() => loadConfig({ ...ENTRA_ENV, JARC_SUPER_ADMIN_OBJECT_ID: ADMIN_IDENTITY.objectId }), /both/);
    assert.throws(() => loadConfig({ ...ENTRA_ENV, JARC_SUPER_ADMIN_TENANT_ID: ADMIN_IDENTITY.tenantId, JARC_SUPER_ADMIN_OBJECT_ID: "not-a-guid" }), /GUID/);
  });
});

describe("Super Admin eligibility (pure; fictional identity)", () => {
  const id = new ObjectId();
  const base = () => ({
    superAdmin: ADMIN_IDENTITY, entra: { tenantId: ADMIN_IDENTITY.tenantId },
    session: { tenantId: ADMIN_IDENTITY.tenantId, objectId: ADMIN_IDENTITY.objectId, isSystemAdmin: true },
    user: { _id: id, tenantId: ADMIN_IDENTITY.tenantId, entraObjectId: ADMIN_IDENTITY.objectId, email: "Super.Admin@jarc.example.invalid", status: "active" },
    sameIdentityCount: 1, sameEmailOthers: 0, superAdmins: 0
  });
  const problems = (change) => superAdminEligibility({ ...base(), ...change(base()) }).problems;
  test("verified claims + matching JARC user + JARC.Admin authorization → eligible (email compared without case)", () => {
    assert.deepEqual(superAdminEligibility(base()), { eligible: true, problems: [] });
  });
  test("refused: another object ID, another tenant, cross-tenant config, no admin authorization, mismatched or ambiguous mapping, existing Super Admin, blocked or disabled", () => {
    assert.match(problems((b) => ({ session: { ...b.session, objectId: "3f9a8b7c-6d5e-4f40-8a31-b2c4d6e8f0a2" } })).join(), /not the configured administrator/);
    assert.match(problems((b) => ({ session: { ...b.session, tenantId: "00000000-0000-4000-8000-00000000a001" } })).join(), /tenant does not match/);
    assert.match(problems(() => ({ entra: { tenantId: "00000000-0000-4000-8000-00000000a001" } })).join(), /not this server's Microsoft tenant/);
    assert.match(problems((b) => ({ session: { ...b.session, isSystemAdmin: false } })).join(), /JARC\.Admin/);
    assert.match(problems((b) => ({ user: { ...b.user, entraObjectId: "0a7a7a7a-0000-4000-8000-000000000071" } })).join(), /JARC user does not match/);
    assert.match(problems((b) => ({ user: { ...b.user, email: "someone.else@jarc.example.invalid" } })).join(), /email does not match/);
    assert.match(problems(() => ({ sameEmailOthers: 1 })).join(), /ambiguous/);
    assert.match(problems(() => ({ sameIdentityCount: 2 })).join(), /more than one JARC user/);
    assert.match(problems(() => ({ superAdmins: 1 })).join(), /already exists/);
    assert.match(problems((b) => ({ user: { ...b.user, account: { status: "blocked", role: null, version: 3 } } })).join(), /blocked/);
    assert.match(problems((b) => ({ user: { ...b.user, status: "disabled" } })).join(), /disabled/);
    assert.equal(superAdminEligibility({ ...base(), superAdmin: null }).eligible, false);
  });
  test("global roles cap memberships; legacy accounts keep theirs; pending and blocked get nothing", () => {
    const acc = (role, status = "active") => accountOf({ account: { role, status, version: 1 } });
    assert.equal(capWorkspaceRole(acc("VIEWER"), "WORKSPACE_ADMIN"), "VIEWER");
    assert.equal(capWorkspaceRole(acc("EDITOR"), "WORKSPACE_ADMIN"), "MEMBER");
    assert.equal(capWorkspaceRole(acc("EDITOR"), "VIEWER"), "VIEWER");
    assert.equal(capWorkspaceRole(acc("ADMIN"), "WORKSPACE_ADMIN"), "WORKSPACE_ADMIN");
    assert.equal(capWorkspaceRole(acc(null, "pending"), "VIEWER"), null);
    assert.equal(capWorkspaceRole(acc("EDITOR", "blocked"), "MEMBER"), null);
    assert.equal(capWorkspaceRole(accountOf({}), "WORKSPACE_ADMIN"), "WORKSPACE_ADMIN");
  });
});

describe("Account Management (ACCOUNT_MANAGEMENT=enforced, with ACCESS_POLICY=development_shared and beta open editing configured)", () => {
  let app, issuer, P;
  const clients = new Map();
  const browser = async (person, opts) => {
    if (!clients.has(person)) { const c = new SessionClient(app.url, app.entra.appOrigin); ok(await c.signIn(person, opts), `sign-in ${person.name}`); clients.set(person, c); }
    return clients.get(person);
  };
  const as = async (person, method, path, body) => (await browser(person)).request(method, `/api/v1${path}`, body);
  const idOf = async (person) => (await as(person, "GET", "/me")).body.user.id;
  const account = async (person) => (await as(P.root, "GET", `/accounts/${await idOf(person)}`)).body.account;
  const cookie = (c) => [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const upload = async (person, recordId) => { const c = await browser(person); const r = await fetch(`${app.url}/api/v1/records/${recordId}/attachments?column=docs`, { method: "POST", body: PNG, headers: { Cookie: cookie(c), Origin: app.entra.appOrigin, "X-CSRF-Token": c.csrf, "Content-Type": "image/png", "X-File-Name": "a.png" } }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const download = async (person, id) => (await fetch(`${app.url}/api/v1/attachments/${id}/content`, { headers: { Cookie: cookie(await browser(person)) } })).status;
  let ws1, ws2, board, record;

  before(async () => {
    issuer = await createTokenIssuer();
    P = {
      root: issuer.person("Root Admin", { admin: true }), imposter: issuer.person("Other Admin", { admin: true }),
      viewer: issuer.person("Vera Viewer"), editor: issuer.person("Eddie Editor"), admin: issuer.person("Ada Admin"), newbie: issuer.person("Nina New"), blocked: issuer.person("Bob Blocked")
    };
    app = await startEntraApp({ issuer, accessPolicy: "development_shared", betaOpenEditing: true, accounts: { mode: "enforced", superAdmin: { tenantId: issuer.config.tenantId, objectId: P.root.oid, email: P.root.email } } });
  });
  after(async () => { await app.close(); });

  test("a new sign-in creates a PENDING account: its own session works, every protected route is refused", async () => {
    const signIn = await (async () => { const c = new SessionClient(app.url, app.entra.appOrigin); const r = await c.signIn(P.newbie); clients.set(P.newbie, c); return r; })();
    assert.equal(signIn.status, 201);
    assert.deepEqual(signIn.body.account, { status: "pending", role: null, legacy: false });
    assert.deepEqual([signIn.body.isSystemAdmin, signIn.body.canCreateWorkspaces, signIn.body.accessPolicy, signIn.body.betaOpenEditing], [false, false, "role_based", false]);
    assert.deepEqual(signIn.body.accountManagement.overridden, ["ACCESS_POLICY=development_shared", "JARC_BETA_OPEN_EDITING=true"]);
    ok(await as(P.newbie, "GET", "/auth/session"), "own session");
    assert.deepEqual((await as(P.newbie, "GET", "/me")).body.memberships, []);
    for (const [method, path, body] of [["GET", "/workspaces"], ["POST", "/workspaces", { name: "Mine" }], ["GET", "/search?q=anything"], ["GET", "/search/global?q=anything"], ["GET", "/activity"], ["GET", "/events"], ["GET", "/accounts"], ["GET", "/integrations/monday"], ["POST", "/imports?dryRun=true", {}]]) {
      const res = await as(P.newbie, method, path, body);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.body.error.code, "ACCOUNT_PENDING", `${method} ${path}`);
    }
    const user = await app.db.collection("users").findOne({ emailNormalized: P.newbie.email });
    assert.equal(user.account.status, "pending");
    assert.ok(user.firstLoginAt instanceof Date && user.lastLoginAt instanceof Date);
    const audit = app.db.collection("accountAudit").docs.filter((d) => d.targetUserId.equals(user._id)).map((d) => d.action);
    assert.deepEqual(audit, ["account.created", "account.signed_in"]);
  });

  test("the first Super Admin: only the configured identity, with JARC.Admin, after an explicit confirmation — once", async () => {
    // The configured object ID WITHOUT the JARC.Admin app role on this sign-in: not eligible.
    const noRole = new SessionClient(app.url, app.entra.appOrigin);
    const first = await noRole.signIn(P.root, { claims: { roles: [] } });
    assert.equal(first.body.accountManagement.canClaimSuperAdmin, false);
    assert.equal((await noRole.request("POST", "/api/v1/accounts/bootstrap", { confirm: "I AM THE SUPER ADMIN" })).status, 403);
    // Another tenant member WITH JARC.Admin: not the configured identity.
    assert.equal((await browser(P.imposter)).csrf !== null, true);
    const imposter = await as(P.imposter, "POST", "/accounts/bootstrap", { confirm: "I AM THE SUPER ADMIN" });
    assert.equal(imposter.status, 403);
    assert.match(imposter.body.error.message, /not the configured administrator/);
    // The administrator: eligible, confirmation required.
    const root = await browser(P.root);
    assert.equal((await root.request("GET", "/api/v1/auth/session")).body.accountManagement.canClaimSuperAdmin, true);
    assert.equal((await as(P.root, "POST", "/accounts/bootstrap", {})).status, 400);
    assert.equal((await as(P.root, "POST", "/accounts/bootstrap", { confirm: "yes" })).status, 400);
    const claimed = await as(P.root, "POST", "/accounts/bootstrap", { confirm: "I AM THE SUPER ADMIN" });
    ok(claimed, "bootstrap");
    assert.deepEqual([claimed.body.account.status, claimed.body.account.role], ["active", "SUPER_ADMIN"]);
    const session = (await as(P.root, "GET", "/auth/session")).body;
    assert.deepEqual([session.isSystemAdmin, session.accountManagement.canManage, session.accountManagement.canClaimSuperAdmin, session.canCreateWorkspaces], [true, true, false, true]);
    assert.equal((await as(P.root, "POST", "/accounts/bootstrap", { confirm: "I AM THE SUPER ADMIN" })).status, 403, "only once");
    // The imposter's JARC.Admin app role no longer makes them a system administrator.
    assert.equal((await as(P.imposter, "GET", "/accounts")).status, 403);
  });

  test("approval workflow: approve with a role, assign explicit workspaces; who approved and when is recorded", async () => {
    ws1 = (await as(P.root, "POST", "/workspaces", { name: "Operations" })).body.workspace;
    ws2 = (await as(P.root, "POST", "/workspaces", { name: "Finance" })).body.workspace;
    board = (await as(P.root, "POST", `/workspaces/${ws1.id}/boards`, { name: "Assets", columns: COLUMNS })).body.board;
    record = (await as(P.root, "POST", `/boards/${board.id}/records`, { values: { serial: "Laptop 42", notes: "findable" } })).body.record;
    await as(P.root, "POST", `/boards/${(await as(P.root, "POST", `/workspaces/${ws2.id}/boards`, { name: "Ledger", columns: COLUMNS })).body.board.id}/records`, { values: { serial: "Laptop secret ledger" } });
    for (const [person, role, wsRole] of [[P.viewer, "VIEWER", "VIEWER"], [P.editor, "EDITOR", "MEMBER"], [P.admin, "ADMIN", "WORKSPACE_ADMIN"], [P.blocked, "VIEWER", "VIEWER"]]) {
      await browser(person);
      const before = await account(person);
      assert.equal(before.status, "pending");
      const approved = await as(P.root, "POST", `/accounts/${before.id}/approve`, { role, expectedVersion: before.version });
      ok(approved, `approve ${person.name}`);
      assert.deepEqual([approved.body.account.status, approved.body.account.role, approved.body.account.approvedBy.name], ["active", role, "Root Admin"]);
      assert.ok(approved.body.account.approvedAt);
      ok(await as(P.root, "PUT", `/accounts/${before.id}/workspaces/${ws1.id}`, { role: wsRole }), `assign ${person.name}`);
    }
    const list = (await as(P.root, "GET", "/accounts?status=active&role=VIEWER")).body.items.map((a) => a.displayName).sort();
    assert.deepEqual(list, ["Bob Blocked", "Vera Viewer"]);
    assert.deepEqual((await as(P.root, "GET", "/accounts?q=eddie")).body.items.map((a) => a.workspaces), [[{ workspaceId: ws1.id, name: "Operations", role: "MEMBER", effectiveRole: "MEMBER" }]]);
    assert.equal((await as(P.root, "GET", "/accounts?status=nonsense")).status, 400);
    // Never tenant or object IDs, sessions or tokens.
    const text = JSON.stringify((await as(P.root, "GET", "/accounts")).body);
    for (const secret of [P.viewer.oid, issuer.config.tenantId, "csrf", "session", "token"]) assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), secret);
  });

  test("VIEWER: reads assigned workspaces (records, comments, attachments) but can't create, edit, delete, upload or change permissions", async () => {
    const att = await upload(P.editor, record.id);
    assert.equal(att.status, 201, "editor uploads");
    assert.deepEqual((await as(P.viewer, "GET", "/workspaces")).body.items.map((w) => [w.name, w.role]), [["Operations", "VIEWER"]]);
    ok(await as(P.viewer, "GET", `/boards/${board.id}/records`), "read records");
    ok(await as(P.viewer, "GET", `/records/${record.id}/comments`), "read comments");
    assert.equal(await download(P.viewer, att.body.attachment.id), 200, "download");
    for (const [method, path, body] of [["POST", `/boards/${board.id}/records`, { values: { serial: "x" } }], ["PATCH", `/records/${record.id}`, { values: { notes: "y" }, expectedVersion: record.version }], ["DELETE", `/records/${record.id}?expectedVersion=${record.version}`], ["POST", `/records/${record.id}/comments`, { body: "hi" }], ["POST", `/workspaces/${ws1.id}/boards`, { name: "B" }], ["PATCH", `/workspaces/${ws1.id}`, { name: "Renamed" }], ["POST", `/workspaces/${ws1.id}/members`, { userId: await idOf(P.newbie), role: "VIEWER" }], ["DELETE", `/attachments/${att.body.attachment.id}`], ["POST", "/workspaces", { name: "New" }]]) {
      assert.equal((await as(P.viewer, method, path, body)).status, 403, `${method} ${path}`);
    }
    assert.equal((await upload(P.viewer, record.id)).status, 403, "upload");
  });

  test("a stored membership above the global role is capped (e.g. a viewer's WORKSPACE_ADMIN row from older data)", async () => {
    const viewerId = new ObjectId(await idOf(P.viewer));
    await app.db.collection("workspaceMembers").updateOne({ userId: viewerId, workspaceId: new ObjectId(ws1.id) }, { $set: { role: "WORKSPACE_ADMIN" } });
    assert.equal((await as(P.viewer, "PATCH", `/workspaces/${ws1.id}`, { name: "Hijacked" })).status, 403);
    assert.equal((await as(P.viewer, "GET", `/workspaces/${ws1.id}`)).body.workspace.role, "VIEWER");
    await app.db.collection("workspaceMembers").updateOne({ userId: viewerId, workspaceId: new ObjectId(ws1.id) }, { $set: { role: "VIEWER" } });
  });

  test("EDITOR: edits records in assigned workspaces only; no admin-only changes; other workspaces don't exist for them", async () => {
    ok(await as(P.editor, "POST", `/boards/${board.id}/records`, { values: { serial: "Editor row" } }), "create");
    ok(await as(P.editor, "POST", `/records/${record.id}/comments`, { body: "Checked" }), "comment");
    assert.equal((await as(P.editor, "DELETE", `/boards/${board.id}/columns/notes`)).status, 403, "delete column needs workspace admin");
    assert.equal((await as(P.editor, "GET", `/workspaces/${ws2.id}`)).status, 404, "other workspace");
    assert.equal((await as(P.editor, "POST", `/workspaces/${ws1.id}/members`, { userId: await idOf(P.newbie), role: "VIEWER" })).status, 403);
    assert.equal((await as(P.editor, "POST", "/workspaces", { name: "Mine" })).status, 403);
  });

  test("ADMIN: manages assigned workspaces, but never accounts, Super Admin, imports, integrations or new workspaces", async () => {
    const current = (await as(P.admin, "GET", `/workspaces/${ws1.id}`)).body.workspace;
    ok(await as(P.admin, "PATCH", `/workspaces/${ws1.id}`, { name: "Operations", expectedVersion: current.version }), "manage workspace");
    const b = (await as(P.admin, "GET", `/boards/${board.id}`)).body.board;
    ok(await as(P.admin, "DELETE", `/boards/${board.id}/columns/notes?dryRun=true&expectedVersion=${b.version}`), "admin-only column change (dry run)");
    assert.equal((await as(P.admin, "GET", `/workspaces/${ws2.id}`)).status, 404);
    for (const [method, path, body] of [["GET", "/accounts"], ["POST", `/accounts/${await idOf(P.admin)}/role`, { role: "SUPER_ADMIN", expectedVersion: 2, confirm: "GRANT SUPER ADMIN" }], ["POST", `/accounts/${await idOf(P.newbie)}/approve`, { role: "EDITOR", expectedVersion: 1 }], ["POST", "/imports?dryRun=true", {}], ["POST", "/integrations/monday/connect"], ["POST", "/workspaces", { name: "X" }]]) {
      assert.equal((await as(P.admin, method, path, body)).status, 403, `${method} ${path}`);
    }
    // An admin can add members to their workspace, but not above what the person's global role allows.
    const viewerMember = (await as(P.admin, "GET", `/workspaces/${ws1.id}/members`)).body.items.find((m) => m.displayName === "Vera Viewer");
    const up = await as(P.admin, "PATCH", `/workspaces/${ws1.id}/members/${viewerMember.id}`, { role: "MEMBER" });
    assert.equal(up.status, 400);
    assert.match(up.body.error.message, /VIEWER account can be at most VIEWER/);
    assert.equal((await as(P.admin, "POST", `/workspaces/${ws1.id}/members`, { userId: await idOf(P.newbie), role: "VIEWER" })).status, 400, "pending person");
  });

  test("direct privilege-escalation attempts are refused", async () => {
    const editorId = await idOf(P.editor), rootId = await idOf(P.root);
    assert.equal((await as(P.editor, "POST", `/accounts/${editorId}/role`, { role: "SUPER_ADMIN", expectedVersion: 2 })).status, 403, "self-promotion");
    assert.equal((await as(P.editor, "POST", `/accounts/${rootId}/block`, { expectedVersion: 2, confirm: "BLOCK" })).status, 403);
    assert.equal((await as(P.editor, "PUT", `/accounts/${editorId}/workspaces/${ws2.id}`, { role: "MEMBER" })).status, 403);
    assert.equal((await as(P.editor, "POST", "/auth/session", { idToken: "x" })).status, 401, "no re-sign-in without Microsoft");
    // Forged fields: refused, not ignored.
    const before = await account(P.newbie);
    assert.equal((await as(P.root, "POST", `/accounts/${before.id}/approve`, { role: "EDITOR", expectedVersion: before.version, approvedBy: rootId })).status, 400);
    assert.equal((await as(P.root, "POST", `/accounts/${before.id}/approve`, { role: "OWNER", expectedVersion: before.version })).status, 400);
    // Workspace role above the global cap, even from the Super Admin.
    const editorWs2 = await as(P.root, "PUT", `/accounts/${editorId}/workspaces/${ws2.id}`, { role: "WORKSPACE_ADMIN" });
    assert.equal(editorWs2.status, 400);
    assert.equal((await as(P.root, "PUT", `/accounts/${before.id}/workspaces/${ws2.id}`, { role: "VIEWER" })).status, 400, "pending");
    // No CSRF token: refused before anything else.
    const c = await browser(P.root);
    assert.equal((await c.request("POST", `/api/v1/accounts/${before.id}/approve`, { role: "EDITOR", expectedVersion: before.version }, { csrf: "forged" })).status, 403);
  });

  test("Super Admin protection: no self-demotion or self-block, confirmations, stale versions, Super Admin grants", async () => {
    const me = await account(P.root);
    assert.equal((await as(P.root, "POST", `/accounts/${me.id}/role`, { role: "ADMIN", expectedVersion: me.version })).status, 403, "self-demotion");
    assert.equal((await as(P.root, "POST", `/accounts/${me.id}/block`, { expectedVersion: me.version, confirm: "BLOCK" })).status, 403, "self-block");
    const admin = await account(P.admin);
    assert.equal((await as(P.root, "POST", `/accounts/${admin.id}/role`, { role: "EDITOR", expectedVersion: admin.version - 1 })).status, 409, "stale version");
    assert.equal((await as(P.root, "POST", `/accounts/${admin.id}/role`, { role: "SUPER_ADMIN", expectedVersion: admin.version })).status, 400, "needs typed confirmation");
    // A Super Admin whose current sign-in lacks JARC.Admin can't grant Super Admin.
    const plain = new SessionClient(app.url, app.entra.appOrigin);
    ok(await plain.signIn(P.root, { claims: { roles: [] } }), "root without app role");
    assert.equal((await plain.request("POST", `/api/v1/accounts/${admin.id}/role`, { role: "SUPER_ADMIN", expectedVersion: admin.version, confirm: "GRANT SUPER ADMIN" })).status, 403);
    const granted = await as(P.root, "POST", `/accounts/${admin.id}/role`, { role: "SUPER_ADMIN", expectedVersion: admin.version, confirm: "GRANT SUPER ADMIN" });
    ok(granted, "grant");
    // Two Super Admins: one may demote the other (never themselves).
    const back = await as(P.root, "POST", `/accounts/${admin.id}/role`, { role: "ADMIN", expectedVersion: granted.body.account.version });
    ok(back, "demote the second Super Admin");
    assert.equal((await app.db.collection("users").countDocuments({ "account.role": "SUPER_ADMIN", "account.status": "active" })), 1);
  });

  test("the last Super Admin can't be demoted or blocked even if a concurrent change slipped past the self-check", async () => {
    // Simulate: another Super Admin's account (target) while the count already says only one remains.
    const svc = app.dataLayer.services.accounts, users = app.dataLayer.repos.users;
    const target = await users.collection.findOne({ emailNormalized: P.admin.email });
    await users.collection.updateOne({ _id: target._id }, { $set: { "account.role": "SUPER_ADMIN" } });
    const original = users.countSuperAdmins.bind(users);
    users.countSuperAdmins = async () => 1;
    try {
      const actor = { kind: "entra", userId: (await users.collection.findOne({ emailNormalized: P.root.email }))._id, account: { legacy: false, status: "active", role: "SUPER_ADMIN", version: 2 }, hasAdminAppRole: true, displayName: "Root Admin" };
      const fresh = accountOf(await users.collection.findOne({ _id: target._id }));
      await assert.rejects(svc.changeRole(actor, target._id, { role: "EDITOR", expectedVersion: fresh.version }), /at least one Super Admin/);
      await assert.rejects(svc.block(actor, target._id, { expectedVersion: fresh.version, confirm: "BLOCK" }), /at least one Super Admin/);
    } finally {
      users.countSuperAdmins = original;
      await users.collection.updateOne({ _id: target._id }, { $set: { "account.role": "ADMIN" } });
    }
  });

  test("session permissions refresh on the next request: role change, block (signed out everywhere), reactivate", async () => {
    // EDITOR → VIEWER: the open session can no longer write.
    let editor = await account(P.editor);
    ok(await as(P.editor, "POST", `/boards/${board.id}/records`, { values: { serial: "before" } }), "write as editor");
    editor = (await as(P.root, "POST", `/accounts/${editor.id}/role`, { role: "VIEWER", expectedVersion: editor.version })).body.account;
    assert.equal((await as(P.editor, "POST", `/boards/${board.id}/records`, { values: { serial: "after" } })).status, 403, "same session, new role");
    assert.equal(editor.workspaces[0].effectiveRole, "VIEWER", "membership kept, capped");
    editor = (await as(P.root, "POST", `/accounts/${editor.id}/role`, { role: "EDITOR", expectedVersion: editor.version })).body.account;
    ok(await as(P.editor, "POST", `/boards/${board.id}/records`, { values: { serial: "again" } }), "editor again");
    // Block: confirmation required; every session ends; sign-in refused.
    const target = await account(P.blocked);
    assert.equal((await as(P.root, "POST", `/accounts/${target.id}/block`, { expectedVersion: target.version })).status, 400);
    const blocked = await as(P.root, "POST", `/accounts/${target.id}/block`, { expectedVersion: target.version, confirm: "BLOCK" });
    ok(blocked, "block");
    assert.equal(blocked.body.account.status, "blocked");
    assert.equal(await app.db.collection("sessions").countDocuments({ userId: new ObjectId(target.id) }), 0);
    assert.equal((await as(P.blocked, "GET", `/boards/${board.id}/records`)).status, 401);
    const again = new SessionClient(app.url, app.entra.appOrigin);
    const refused = await again.signIn(P.blocked);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, "ACCOUNT_DISABLED");
    // Reactivate (role kept unless changed).
    const back = await as(P.root, "POST", `/accounts/${target.id}/reactivate`, { expectedVersion: blocked.body.account.version });
    ok(back, "reactivate");
    assert.deepEqual([back.body.account.status, back.body.account.role], ["active", "VIEWER"]);
    clients.delete(P.blocked);
    ok(await as(P.blocked, "GET", `/boards/${board.id}/records`), "signed in again");
  });

  test("search, global search and recents only cover assigned workspaces", async () => {
    const hits = (await as(P.viewer, "GET", "/search?q=Laptop")).body.items.map((i) => i.title);
    assert.deepEqual(hits, ["Laptop 42"]);
    const global = (await as(P.viewer, "GET", "/search/global?q=Laptop")).body;
    assert.ok(!JSON.stringify(global).includes("secret ledger"));
    assert.ok(JSON.stringify((await as(P.root, "GET", "/search/global?q=Laptop")).body).includes("secret ledger"), "Super Admin sees every workspace");
  });

  test("removing workspace access takes effect at once; the workspace's last admin can't be removed", async () => {
    const viewer = await account(P.viewer);
    ok(await as(P.root, "DELETE", `/accounts/${viewer.id}/workspaces/${ws1.id}`), "remove");
    assert.equal((await as(P.viewer, "GET", `/workspaces/${ws1.id}`)).status, 404);
    assert.deepEqual((await as(P.viewer, "GET", "/search?q=Laptop")).body.items, []);
    const adminAccount = await account(P.admin);
    const root = await account(P.root);
    // Operations has two admins (root as creator, Ada); Finance only root.
    assert.equal((await as(P.root, "DELETE", `/accounts/${root.id}/workspaces/${ws2.id}`)).status, 400, "last workspace admin");
    ok(await as(P.root, "PUT", `/accounts/${viewer.id}/workspaces/${ws1.id}`, { role: "VIEWER" }), "re-assign");
    assert.ok(adminAccount.workspaces.length >= 1);
  });

  test("audit trail: every change with administrator, time and previous/new values — and no tokens", async () => {
    const editorId = new ObjectId(await idOf(P.editor));
    const detail = (await as(P.root, "GET", `/accounts/${editorId.toHexString()}`)).body;
    const actions = detail.history.map((h) => h.action);
    for (const a of ["account.created", "account.approved", "account.workspace_assigned", "account.role_changed"]) assert.ok(actions.includes(a), a);
    assert.ok(!actions.includes("account.signed_in"), "sign-ins are kept out of the history view");
    const roleChange = detail.history.find((h) => h.action === "account.role_changed");
    assert.deepEqual([roleChange.actorName, roleChange.changes], ["Root Admin", [{ field: "role", from: "VIEWER", to: "EDITOR" }]]);
    const all = app.db.collection("accountAudit").docs;
    for (const a of ["account.blocked", "account.reactivated", "account.workspace_removed", "account.super_admin_bootstrapped", "account.signed_in"]) assert.ok(all.some((d) => d.action === a), a);
    const raw = JSON.stringify(all);
    for (const c of clients.values()) for (const v of c.cookies.values()) assert.ok(!raw.includes(v), "no cookie value");
    assert.ok(!/csrf|idToken|secret|password|"ip"|userAgent/i.test(raw));
  });

  test("live updates: an account change makes the stream reconnect; a block ends it", async () => {
    const id = new ObjectId();
    const user = { _id: id, status: "active", account: { status: "active", role: "EDITOR", version: 3 } };
    const sessions = { findBySecret: async () => ({ userId: id, expiresAt: new Date(Date.now() + 1e6), idleExpiresAt: new Date(Date.now() + 1e6) }) };
    const check = entraSessionCheck({ sessions, users: { findById: async () => user } });
    const req = { sessionSecret: "s", actor: { account: accountOf(user) } };
    assert.equal(await check(req), true);
    user.account = { ...user.account, role: "VIEWER", version: 4 };
    assert.equal(await check(req), "refresh");
    user.account = { ...user.account, status: "blocked", version: 5 };
    assert.equal(await check(req), false);
  });

  test("reconciliation: blockers are reported until every account is reviewed", async () => {
    const report = (await as(P.root, "GET", "/accounts/reconciliation")).body;
    assert.equal(report.summary.superAdmins, 1);
    assert.ok(report.summary.pending >= 1);
    assert.equal(report.readyToEnforce, true, "no legacy accounts in this database");
  });
});

describe("Existing users and the transition from beta access", () => {
  let issuer, fake;
  before(async () => { issuer = await createTokenIssuer(); fake = new FakeMongoClient(); });

  test("legacy users (signed in before Account Management) are neither promoted nor locked out; enforcement can't silently change them", async () => {
    const lea = issuer.person("Lea Legacy"), sys = issuer.person("Sys Admin", { admin: true }), root = issuer.person("Root", { admin: true });
    // Before: role_based, accounts off — the JARC.Admin creates a workspace and adds Lea as MEMBER.
    let app = await startEntraApp({ issuer, fake });
    const s = new SessionClient(app.url, app.entra.appOrigin); ok(await s.signIn(sys), "sys");
    const l = new SessionClient(app.url, app.entra.appOrigin); ok(await l.signIn(lea), "lea");
    assert.equal(l.setCookies.length > 0, true);
    const ws = (await s.request("POST", "/api/v1/workspaces", { name: "Legacy team" })).body.workspace;
    const other = (await s.request("POST", "/api/v1/workspaces", { name: "Not Lea's" })).body.workspace;
    ok(await s.request("POST", `/api/v1/workspaces/${ws.id}/members`, { userId: (await l.request("GET", "/api/v1/me")).body.user.id, role: "MEMBER" }), "add lea");
    const board = (await s.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "B", columns: COLUMNS })).body.board;
    const before = (await app.db.collection("users").findOne({ emailNormalized: lea.email }));
    assert.equal(before.account, undefined, "off: no account field is written");
    await app.close();

    // After: enforced on the same database.
    app = await startEntraApp({ issuer, fake, accessPolicy: "development_shared", betaOpenEditing: true, accounts: { mode: "enforced", superAdmin: { tenantId: issuer.config.tenantId, objectId: root.oid } } });
    try {
      const l2 = new SessionClient(app.url, app.entra.appOrigin);
      const signIn = await l2.signIn(lea);
      assert.equal(signIn.status, 201);
      assert.deepEqual(signIn.body.account, { status: "legacy", role: null, legacy: true });
      assert.equal((await app.db.collection("users").findOne({ emailNormalized: lea.email })).account, undefined, "sign-in doesn't create an account for an existing user");
      ok(await l2.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "still works" } }), "legacy MEMBER keeps editing");
      assert.equal((await l2.request("GET", `/api/v1/workspaces/${other.id}`)).status, 404, "no promotion: beta/shared access is off under enforced");
      // The former JARC.Admin is legacy too: memberships only, no global admin.
      const s2 = new SessionClient(app.url, app.entra.appOrigin); ok(await s2.signIn(sys), "sys again");
      assert.equal((await s2.request("GET", "/api/v1/auth/session")).body.isSystemAdmin, false);
      ok(await s2.request("GET", `/api/v1/workspaces/${ws.id}`), "keeps their own workspace (creator membership)");
      // Reconciliation lists them as not reviewed.
      const r = new SessionClient(app.url, app.entra.appOrigin); ok(await r.signIn(root), "root");
      ok(await r.request("POST", "/api/v1/accounts/bootstrap", { confirm: "I AM THE SUPER ADMIN" }), "bootstrap");
      const report = (await r.request("GET", "/api/v1/accounts/reconciliation")).body;
      assert.equal(report.readyToEnforce, false);
      assert.match(report.blockers.join(), /2 account\(s\) not reviewed/);
      const legacyRow = (await r.request("GET", "/api/v1/accounts?status=legacy")).body.items.map((a) => a.displayName).sort();
      assert.deepEqual(legacyRow, ["Lea Legacy", "Sys Admin"]);
      // Approving a legacy account (expectedVersion 0) keeps their memberships, now capped by the role chosen.
      const leaRow = (await r.request("GET", "/api/v1/accounts?q=lea")).body.items[0];
      const approved = await r.request("POST", `/api/v1/accounts/${leaRow.id}/approve`, { role: "VIEWER", expectedVersion: 0 });
      ok(approved, "approve legacy");
      assert.deepEqual(approved.body.account.workspaces.map((w) => [w.role, w.effectiveRole]), [["MEMBER", "VIEWER"]]);
      assert.equal((await l2.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "now read-only" } })).status, 403);
    } finally { await app.close(); }
  });

  test("staged: accounts are recorded and reviewable, but beta access still applies — and the session says roles aren't enforced", async () => {
    const root = issuer.person("Stage Root", { admin: true }), emp = issuer.person("Stage Employee");
    const app = await startEntraApp({ issuer, accessPolicy: "development_shared", betaOpenEditing: true, accounts: { mode: "staged", superAdmin: { tenantId: issuer.config.tenantId, objectId: root.oid } } });
    try {
      const e = new SessionClient(app.url, app.entra.appOrigin);
      const signIn = await e.signIn(emp);
      assert.deepEqual([signIn.body.account.status, signIn.body.accountManagement.enforced, signIn.body.betaOpenEditing, signIn.body.accessPolicy], ["pending", false, true, "development_shared"]);
      ok(await e.request("POST", "/api/v1/workspaces", { name: "Beta still open" }), "pending but not enforced");
      const r = new SessionClient(app.url, app.entra.appOrigin); ok(await r.signIn(root), "root");
      ok(await r.request("POST", "/api/v1/accounts/bootstrap", { confirm: "I AM THE SUPER ADMIN" }), "bootstrap in staged");
      const row = (await r.request("GET", "/api/v1/accounts?status=pending")).body.items.find((a) => a.displayName === "Stage Employee");
      const viewer = await r.request("POST", `/api/v1/accounts/${row.id}/approve`, { role: "VIEWER", expectedVersion: row.version });
      ok(viewer, "approve as viewer");
      // Not enforced: the beta override still lets them edit — exactly what the UI must say.
      ok(await e.request("POST", "/api/v1/workspaces", { name: "Viewer under beta" }), "staged does not restrict");
      assert.equal((await e.request("GET", "/api/v1/auth/session")).body.accountManagement.enforced, false);
      // Blocking is the one thing that applies in staged.
      ok(await r.request("POST", `/api/v1/accounts/${row.id}/block`, { expectedVersion: viewer.body.account.version, confirm: "BLOCK" }), "block");
      assert.equal((await e.request("GET", "/api/v1/workspaces")).status, 401);
    } finally { await app.close(); }
  });

  test("off: no Account Management routes and no account fields (existing behaviour unchanged)", async () => {
    const app = await startEntraApp({ issuer, betaOpenEditing: true });
    try {
      const c = new SessionClient(app.url, app.entra.appOrigin);
      const signIn = await c.signIn(issuer.person("Plain Employee"));
      assert.equal(signIn.body.account, undefined);
      assert.equal(signIn.body.accountManagement, undefined);
      assert.equal(signIn.body.betaOpenEditing, true);
      assert.equal((await c.request("GET", "/api/v1/accounts")).status, 404);
      assert.equal(app.db.collection("accountAudit").docs.length, 0);
    } finally { await app.close(); }
  });
});

describe("monday.com migration compatibility (access stages)", () => {
  const tenantId = ADMIN_IDENTITY.tenantId, admin = { tenantId, objectId: ADMIN_IDENTITY.objectId };
  const user = (role, status = "active", extra = {}) => ({ _id: new ObjectId(), source: "entra", status: "active", tenantId, entraObjectId: crypto.randomUUID(), ...(role !== undefined ? { account: { role, status, version: 2 } } : {}), ...extra });
  const crypto = require("crypto");
  test("with accounts on: stage 1 needs the active Super Admin; pending/blocked/unreviewed never get access; viewers can't become editors; source authors grant nothing", () => {
    const root = user("SUPER_ADMIN", "active", { entraObjectId: ADMIN_IDENTITY.objectId });
    const viewer = user("VIEWER"), editor = user("EDITOR"), pending = user(null, "pending"), legacy = user(undefined), blocked = user("EDITOR", "blocked");
    const users = new Map([root, viewer, editor, pending, legacy, blocked].map((u) => [u._id.toHexString(), u]));
    const ws = { _id: new ObjectId() };
    const cfg = { accountMode: "enforced" };
    const s1 = planAccessStage({ stage: 1, workspace: ws, members: [], users, administrator: admin, requested: [{ userId: root._id.toHexString(), role: "WORKSPACE_ADMIN" }], config: cfg });
    assert.deepEqual([s1.problems, s1.changes.length], [[], 1]);
    const notSuper = new Map(users); notSuper.set(root._id.toHexString(), { ...root, account: { role: "ADMIN", status: "active", version: 2 } });
    assert.match(planAccessStage({ stage: 1, workspace: ws, members: [], users: notSuper, administrator: admin, requested: [{ userId: root._id.toHexString(), role: "WORKSPACE_ADMIN" }], config: cfg }).problems.join(), /not the active Super Admin/);
    const s2 = planAccessStage({ stage: 2, workspace: ws, members: [], users, administrator: admin, requested: [viewer, editor, pending, legacy, blocked].map((u) => ({ userId: u._id.toHexString(), role: "VIEWER" })), config: cfg });
    assert.deepEqual(s2.changes.map((c) => c.userId).sort(), [viewer, editor].map((u) => u._id.toHexString()).sort());
    assert.equal(s2.problems.filter((p) => /no approved JARC account/.test(p)).length, 3);
    const members = [viewer, editor].map((u) => ({ userId: u._id, role: "VIEWER", status: "active" }));
    const s3 = planAccessStage({ stage: 3, workspace: ws, members, users, administrator: admin, requested: [viewer, editor].map((u) => ({ userId: u._id.toHexString(), role: "MEMBER" })), config: cfg });
    assert.deepEqual(s3.changes.map((c) => c.userId), [editor._id.toHexString()]);
    assert.match(s3.problems.join(), /VIEWER account; approve them as an Editor first/);
    assert.match(planAccessStage({ stage: 2, workspace: ws, members: [], users, administrator: admin, requested: [], config: { accountMode: "staged" } }).conflicts.join(), /not enforced/);
  });
  test("without accounts (current behaviour) the stage plans and their digests are unchanged", () => {
    const root = user(undefined, undefined, { entraObjectId: ADMIN_IDENTITY.objectId }), viewer = user(undefined);
    const users = new Map([root, viewer].map((u) => [u._id.toHexString(), u]));
    const ws = { _id: new ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa") };
    const plan = planAccessStage({ stage: 2, workspace: ws, members: [], users, administrator: admin, requested: [{ userId: viewer._id.toHexString(), role: "VIEWER" }] });
    assert.deepEqual(plan.problems, []);
    const expected = require("crypto").createHash("sha256").update(JSON.stringify({ stage: 2, workspaceId: ws._id.toHexString(), changes: plan.changes })).digest("hex");
    assert.equal(plan.digest, expected);
  });
  test("the reconciliation report flags memberships above the global role", () => {
    const u = { _id: new ObjectId(), source: "entra", status: "active", account: { status: "active", role: "VIEWER", version: 2 } };
    const report = reconciliationReport([u], [{ userId: u._id, workspaceId: new ObjectId(), role: "MEMBER" }]);
    assert.equal(report.summary.overCap, 1);
    assert.equal(report.readyToEnforce, false);
  });
});

describe("Production observation mode (Phase M4.4A: ACCOUNT_MANAGEMENT=staged with NODE_ENV=production)", () => {
  // The current production variable shape (placeholder IDs; nothing here reaches Railway, Atlas or Microsoft).
  const PROD = { ...ENTRA_ENV, NODE_ENV: "production", HOST: "0.0.0.0", PORT: "8080", MONGODB_URI: "mongodb+srv://user:pass@cluster.invalid/?retryWrites=true", ACCESS_POLICY: "development_shared", JARC_BETA_OPEN_EDITING: "true" };
  const SA = { JARC_SUPER_ADMIN_TENANT_ID: ADMIN_IDENTITY.tenantId, JARC_SUPER_ADMIN_OBJECT_ID: ADMIN_IDENTITY.objectId, JARC_SUPER_ADMIN_EMAIL: ADMIN_IDENTITY.email };

  test("startup: staged with a configured Super Admin identity, beta and shared access unchanged, GridFS without bucket credentials, monday.com off", () => {
    const c = loadConfig({ ...PROD, ACCOUNT_MANAGEMENT: "staged", ...SA });
    assert.deepEqual([c.accounts.mode, { ...c.accounts.superAdmin }], ["staged", ADMIN_IDENTITY]);
    assert.deepEqual([c.accessPolicy, c.betaOpenEditing, c.enableDevStateApi, c.enableDevResourceApi], ["development_shared", true, false, false]);
    assert.deepEqual([c.attachments.defaultProvider, c.attachments.s3, c.monday.enabled], ["gridfs", null, false]);
    assert.equal(loadConfig(PROD).accounts.mode, "off", "today's variables (no ACCOUNT_MANAGEMENT): off");
    assert.equal(require("../src/migration/monday/executor").PRODUCTION_EXECUTION_ENABLED, false, "production migration execution stays disabled");
  });

  test("fail-closed configuration: enforced, unknown modes, cross-tenant or half-set Super Admin, half-set bucket and missing Entra all stop startup", () => {
    for (const [env, pattern] of [
      [{ ACCOUNT_MANAGEMENT: "enforced", ...SA }, /enforced is not approved/],
      [{ ACCOUNT_MANAGEMENT: "Staged" }, /must be off, staged or enforced/],
      [{ ACCOUNT_MANAGEMENT: "observation" }, /must be off, staged or enforced/],
      [{ ACCOUNT_MANAGEMENT: "staged", ...SA, JARC_SUPER_ADMIN_TENANT_ID: "11111111-1111-1111-1111-111111111111" }, /same tenant/],
      [{ ACCOUNT_MANAGEMENT: "staged", JARC_SUPER_ADMIN_OBJECT_ID: ADMIN_IDENTITY.objectId }, /both/],
      [{ ACCOUNT_MANAGEMENT: "staged", ATTACHMENTS_S3_BUCKET: "jarc-files" }, /partly configured/],
      [{ ACCOUNT_MANAGEMENT: "staged", AUTH_MODE: "dev" }, /Production requires AUTH_MODE=entra/]
    ]) assert.throws(() => loadConfig({ ...PROD, ...env }), pattern, JSON.stringify(env));
  });

  describe("the real app with NODE_ENV=production on an existing database", () => {
    let issuer, fake, app, P;
    before(async () => {
      issuer = await createTokenIssuer(); fake = new FakeMongoClient();
      P = { legacy: issuer.person("Lena Existing"), owner: issuer.person("Omar Owner"), sysadmin: issuer.person("Sam JARC Admin", { admin: true }), root: issuer.person("Root Admin", { admin: true }), imposter: issuer.person("Ivy Imposter", { admin: true }), newcomer: issuer.person("Nico Newcomer") };
      // Before the deployment: production today (accounts off, shared + beta). People sign in and work.
      const today = await startEntraApp({ issuer, fake, environment: "production", accessPolicy: "development_shared", betaOpenEditing: true });
      for (const p of [P.legacy, P.sysadmin]) ok(await new SessionClient(today.url, today.entra.appOrigin).signIn(p), p.name);
      const owner = new SessionClient(today.url, today.entra.appOrigin); ok(await owner.signIn(P.owner), "owner");
      const ws = (await owner.request("POST", "/api/v1/workspaces", { name: "Owner workspace" })).body.workspace;
      ok(await owner.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Board", columns: COLUMNS }), "board");
      await today.close();
      // After the deployment: observation mode, production.
      app = await startEntraApp({ issuer, fake, environment: "production", accessPolicy: "development_shared", betaOpenEditing: true, accounts: { mode: "staged", superAdmin: { tenantId: issuer.config.tenantId, objectId: P.root.oid, email: P.root.email } } });
    });
    after(async () => { await app?.close(); });

    test("healthy, no development APIs, and existing employees keep exactly their current access", async () => {
      assert.equal((await fetch(`${app.url}/api/v1/health`)).status, 200);
      assert.equal((await fetch(`${app.url}/api/v1/state`)).status, 401, "development state API stays off (unknown paths need a session)");
      const lena = new SessionClient(app.url, app.entra.appOrigin);
      const signIn = await lena.signIn(P.legacy);
      assert.deepEqual(signIn.body.account, { status: "legacy", role: null, legacy: true });
      assert.deepEqual([signIn.body.accountManagement.mode, signIn.body.accountManagement.enforced, signIn.body.accountManagement.overridden, signIn.body.betaOpenEditing, signIn.body.accessPolicy, signIn.body.canCreateWorkspaces], ["staged", false, [], true, "development_shared", true]);
      const spaces = (await lena.request("GET", "/api/v1/workspaces")).body.items;
      assert.deepEqual(spaces.map((w) => [w.name, w.role]), [["Owner workspace", "WORKSPACE_ADMIN"]], "shared access as before");
      const board = (await lena.request("GET", `/api/v1/workspaces/${spaces[0].id}/boards`)).body.items[0];
      ok(await lena.request("POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "still editing" } }), "beta editing still on");
      const sam = new SessionClient(app.url, app.entra.appOrigin);
      assert.equal((await sam.signIn(P.sysadmin)).body.isSystemAdmin, true, "the JARC.Admin role still works as before");
      assert.equal((await sam.request("GET", "/api/v1/accounts")).status, 403, "but grants no account management");
      const nico = new SessionClient(app.url, app.entra.appOrigin);
      assert.equal((await nico.signIn(P.newcomer)).body.account.status, "pending");
      ok(await nico.request("POST", "/api/v1/workspaces", { name: "Newcomer works too" }), "pending is not enforced in observation mode");
      for (const p of [P.legacy, P.owner, P.sysadmin]) assert.equal((await app.db.collection("users").findOne({ emailNormalized: p.email })).account, undefined, `${p.name} untouched`);
    });

    test("Super Admin claim in production: only the configured identity, with JARC.Admin and the typed confirmation, once", async () => {
      const imposter = new SessionClient(app.url, app.entra.appOrigin); ok(await imposter.signIn(P.imposter), "imposter");
      assert.equal((await imposter.request("GET", "/api/v1/auth/session")).body.accountManagement.canClaimSuperAdmin, false);
      assert.equal((await imposter.request("POST", "/api/v1/accounts/bootstrap", { confirm: "I AM THE SUPER ADMIN" })).status, 403, "another tenant member with JARC.Admin");
      const noRole = new SessionClient(app.url, app.entra.appOrigin); ok(await noRole.signIn(P.root, { claims: { roles: [] } }), "root without role");
      assert.equal((await noRole.request("POST", "/api/v1/accounts/bootstrap", { confirm: "I AM THE SUPER ADMIN" })).status, 403, "the right person without JARC.Admin");
      const otherTenant = await new SessionClient(app.url, app.entra.appOrigin).signIn(P.root, { claims: { tid: "11111111-1111-1111-1111-111111111111", iss: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0" } });
      assert.equal(otherTenant.status, 401, "the same object ID from another tenant cannot even sign in");
      const root = new SessionClient(app.url, app.entra.appOrigin); ok(await root.signIn(P.root), "root");
      assert.equal((await root.request("GET", "/api/v1/auth/session")).body.accountManagement.canClaimSuperAdmin, true);
      assert.equal((await root.request("POST", "/api/v1/accounts/bootstrap", { confirm: "yes" })).status, 400);
      const claimed = await root.request("POST", "/api/v1/accounts/bootstrap", { confirm: "I AM THE SUPER ADMIN" });
      ok(claimed, "claim");
      assert.deepEqual([claimed.body.account.status, claimed.body.account.role], ["active", "SUPER_ADMIN"]);
      assert.equal((await root.request("POST", "/api/v1/accounts/bootstrap", { confirm: "I AM THE SUPER ADMIN" })).status, 403, "once only");
      assert.ok(app.db.collection("accountAudit").docs.some((d) => d.action === "account.super_admin_bootstrapped"));
      // Reviewing changes nothing yet: an approved Viewer still edits while beta editing is on (and the page says so).
      const lenaRow = (await root.request("GET", "/api/v1/accounts?status=legacy")).body.items.find((a) => a.displayName === "Lena Existing");
      ok(await root.request("POST", `/api/v1/accounts/${lenaRow.id}/approve`, { role: "VIEWER", expectedVersion: 0 }), "record Lena as Viewer");
      const lena = new SessionClient(app.url, app.entra.appOrigin); ok(await lena.signIn(P.legacy), "lena");
      ok(await lena.request("POST", "/api/v1/workspaces", { name: "Viewer under beta" }), "not enforced in observation mode");
    });
  });
});
