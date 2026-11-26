// People directory P3 (Access Administration) in the REAL app, in a headless Chrome/Edge: the JARC shell with the real employees
// backend (as employees-p2-ui-browser.test.js), and the P3 answers STUBBED in the page per contract P3 §5, so this test checks the
// frontend whatever state the backend is in. For the owner's pages (window.name "p3-owner") /features gets
// employees.jarcAccess + accessAdmin, …/manage-access and …/access-history answer synthetic data, and the writes (POST …/access,
// memberships) change that synthetic state; every write is recorded with whether it carried X-CSRF-Token. Viewers' answers are the
// real backend's. If index.html doesn't load EmployeeManage.js yet, the stub loads it (the shared shell file is owned elsewhere).
// Synthetic data only (example.com, "Synthetic …"); nothing leaves 127.0.0.1. Skipped without Chrome or Edge.
// JARC_EMP_SCREENSHOTS=<dir> saves screenshots (360 / 768 / 1440, light and dark).
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
const { createEmployees, profileId } = require("../src/employees");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const BROWSER = findBrowser();
const DESKTOP = { width: 1440, height: 900 };
const DOCS = syntheticPeople(3).map((d, i) => ({ ...d, display_name: `Synthetic Person ${i + 1}`, first_name: "Synthetic", last_name: `Person ${i + 1}`, job_title: "Analyst", department: "Dept A", office_location: null, account_enabled: i !== 2, user_type: "Member" }));
const ID = (n) => profileId(TEST_ID_KEY, DOCS[n - 1].user_id);
const REFS = ["SyntheticWsRefAAAAAAAA", "SyntheticWsRefBBBBBBBB", "SyntheticWsRefCCCCCCCC"];

const STUB = `(() => {
  window.__errors = []; window.__writes = [];
  const oe = console.error.bind(console);
  console.error = (...a) => { window.__errors.push(a.map((x) => (x && x.stack) || String(x)).join(" ")); oe(...a); };
  addEventListener("error", (e) => window.__errors.push("uncaught: " + (e.message || e.type)));
  addEventListener("unhandledrejection", (e) => window.__errors.push("rejection: " + ((e.reason && e.reason.message) || e.reason)));
  const owner = window.name === "p3-owner"; // "p3-real": the real backend answers everything (only the script is loaded)
  if (String(window.name).startsWith("p3-") && typeof window.EmployeeManage !== "function") {
    try { const x = new XMLHttpRequest(); x.open("GET", "/assets/EmployeeManage.js", false); x.send(); if (x.status === 200) new Function(x.responseText)(); } catch (e) { window.__errors.push("load: " + e.message); }
  }
  const REFS = ${JSON.stringify(REFS)}, ID3 = ${JSON.stringify(ID(3))};
  const S = { version: 3, state: "active", conflictNext: false, memberships: { 0: "MEMBER", 2: "WORKSPACE_ADMIN" }, history: [] };
  window.__p3 = S;
  const names = ["Synthetic Workspace A", "Synthetic Workspace With A Very Long Name That Must Wrap On Small Phones", "Synthetic Workspace C"];
  const actions = (st) => ["grant", "suspend", "restore", "revoke"].map((a) => { const allowed = (st === "active" && (a === "suspend" || a === "revoke")) || (st === "suspended" && (a === "restore" || a === "revoke")) || (st === "revoked" && a === "grant"); return allowed ? { action: a, allowed, ...(a === "suspend" || a === "revoke" ? { reasonRequired: true } : {}), ...(a === "revoke" ? { confirm: "REVOKE" } : {}) } : { action: a, allowed, code: "INVALID_TRANSITION", reason: "This change isn't possible from the person's current JARC access. Reload and try again." }; });
  const body = (id) => ({ id, version: S.version, account: { state: S.state, provisioned: false, signedInNow: S.state === "active", isSelf: false, isEmployeeAdmin: false, entraEnabled: id !== ID3, ...(id === ID3 ? { suggestedSuspendReason: "Disabled in Microsoft Entra ID" } : {}) },
    actions: actions(S.state), tokens: { jarcActive: 2, fabricActive: 1 }, snapshot: { stale: false, ingestedAt: "2026-11-24T06:00:00.000Z", checkedAt: "2026-11-25T06:00:00.000Z" },
    workspaces: names.map((name, i) => ({ workspaceRef: REFS[i], name, membership: S.memberships[i] ? { role: S.memberships[i], status: "active" } : null, sharedRole: "WORKSPACE_ADMIN", effectiveRole: S.state === "active" ? "WORKSPACE_ADMIN" : null, canManage: true, lastAdmin: i === 2 })),
    sharedAccess: { on: true, note: "Shared access gives every active JARC user Workspace admin in every workspace." }, warnings: [] });
  const hist = (at, action, extra = {}) => ({ at, action, result: action.endsWith("rejected") ? "rejected" : "ok", actor: "Synthetic Owner", changes: [], ...extra });
  S.history = [hist("2026-11-26T02:00:00.000Z", "employee.access.rejected", { code: "SELF_LOCKOUT", attempted: "suspend" }), hist("2026-11-25T02:00:00.000Z", "employee.membership.added", { workspace: names[0], changes: [{ field: "role", from: null, to: "MEMBER" }] })];
  const of = window.fetch.bind(window);
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
  const edit = async (input, init, fn) => { const r = await of(input, init); if (!r.ok) return r; let j; try { j = await r.clone().json(); } catch { return r; } fn(j); return json(j, r.status); };
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url, rel = url.replace(/^https?:\\/\\/[^/]+/, ""), p = rel.split("?")[0], method = (init.method || "GET").toUpperCase();
    if (!owner) return of(input, init);
    if (p === "/api/v1/features") return edit(input, init, (j) => { const e = j?.features?.employees || j?.employees; if (e) { e.jarcAccess = true; e.accessAdmin = true; } });
    if (p === "/api/v1/admin/employees/status") return edit(input, init, (j) => { if (j.access) j.access.jarcAccess = true; });
    let m = /^\\/api\\/v1\\/admin\\/employees\\/([a-z]+)\\/records\\/([A-Za-z0-9_-]{22})\\/(manage-access|access-history|access|memberships)(?:\\/([A-Za-z0-9_-]+))?$/.exec(p);
    if (!m) return of(input, init);
    const [, ds, id, what, ref] = m;
    if (method !== "GET") {
      const h = init.headers || {}, csrf = !!(h["X-CSRF-Token"] || (h.get && h.get("X-CSRF-Token")));
      let b = null; try { b = init.body ? JSON.parse(init.body) : null; } catch { b = null; }
      window.__writes.push({ method, what, ref: ref || null, body: b, csrf });
      await new Promise((r) => setTimeout(r, 150)); // in flight long enough to see the busy state
      if (S.conflictNext) { S.conflictNext = false; S.version += 1; return json({ error: { code: "CONFLICT", message: "x" } }, 409); }
      if (what === "access") {
        if (b.expectedVersion !== S.version || b.expectedState !== S.state) return json({ error: { code: "CONFLICT" } }, 409);
        S.state = { suspend: "suspended", restore: "active", revoke: "revoked", grant: "active" }[b.action]; S.version += 1;
        S.history.unshift(hist(new Date().toISOString(), "employee.access." + ({ suspend: "suspended", restore: "restored", revoke: "revoked", grant: "granted" }[b.action]), { reason: b.reason || null, changes: [{ field: "status", from: "active", to: S.state }] }));
        return json({ manageAccess: body(id), result: { action: b.action, from: "active", to: S.state, sessionsEnded: 1, tokensRevoked: b.action === "revoke" ? { jarc: 2, fabric: 1 } : { jarc: 0, fabric: 0 } } });
      }
      const i = REFS.indexOf(ref || (b && b.workspaceRef));
      if (method === "POST") S.memberships[i] = b.role; else if (method === "PATCH") S.memberships[i] = b.role; else delete S.memberships[i];
      S.history.unshift(hist(new Date().toISOString(), "employee.membership." + (method === "POST" ? "added" : method === "PATCH" ? "role_changed" : "removed"), { workspace: names[i] }));
      return json({ manageAccess: body(id) }, method === "POST" ? 201 : 200);
    }
    if (what === "manage-access") return json(body(id));
    if (what === "access-history") return json({ items: S.history, nextBefore: null });
    return of(input, init);
  };
})();`;

describe("People directory P3 Manage access in the real app (headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let issuer, persons, server, base, b, app, employees, realDb, signedInAs = null;
  before(async () => {
    issuer = await createTokenIssuer();
    persons = { viewer: issuer.person("Synthetic Viewer"), admin: issuer.person("Synthetic Owner") };
    const port = await freePort();
    base = `http://localhost:${port}`;
    const entra = { ...issuer.config, redirectUri: `${base}/`, appOrigin: base };
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => new FakeMongoClient() });
    await connection.connect();
    await ensureDatabase(connection.db);
    realDb = connection.db;
    const dataLayer = createDataLayer({ connection, logger: { error() {} }, fileStore: new MemoryFileStore(), environment: "test" });
    const config = Object.defineProperty({ enabled: true, accessAdmin: true, collection: COLLECTION, dbName: DB_NAME, tenantId: issuer.config.tenantId, viewerObjectIds: [persons.viewer.oid], adminObjectIds: [persons.admin.oid] }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
    employees = createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs: DOCS }), idKey: TEST_ID_KEY, logger: { info() {}, warn() {}, error() {} } });
    app = createApp({
      employees, repository: new MemoryStateRepository(), environment: "test", logger: { error() {}, warn() {} }, dataLayer,
      auth: { mode: "entra", entra, verify: createEntraVerifier({ ...entra, keySet: issuer.keySet }) },
      accessPolicy: "development_shared", betaOpenEditing: true,
      apiTokens: { key: crypto.randomBytes(32), adminObjectIds: [], issuePerHour: 1000, maxActive: 1000 }
    });
    server = await new Promise((resolve) => { const s = app.listen(port, "127.0.0.1", () => resolve(s)); });
    b = await launch(BROWSER);
    await b.motionPreference("reduce");
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
  });
  after(async () => { await b?.close(); app?.locals.realtime?.closeAll(); await new Promise((r) => (server ? server.close(r) : r())); await employees?.close(); });

  const wait = (expr, ms = 10000) => b.waitFor(expr, ms);
  const has = (sel) => b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const json = async (expr) => JSON.parse(await b.evaluate(`JSON.stringify(${expr})`));
  const noErrors = async (label) => assert.deepEqual(await json("window.__errors || []"), [], `${label}: console errors`);
  const sideways = () => b.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  const visibleText = () => b.evaluate(`document.querySelector("#employees-root")?.innerText || ""`);
  const type = (sel, value) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const submitDialog = () => click("#overlay-root .emp-m-dialog button[type=submit]");
  const setRole = async (role) => {
    if (signedInAs === role) return;
    await b.open(`${base}/api/v1/health`, DESKTOP);
    const nonce = await b.evaluate(`fetch("/api/v1/auth/sign-in/start", { method: "POST" }).then((r) => r.json()).then((s) => s.nonce)`);
    const idToken = await persons[role].idToken(nonce);
    assert.equal(await b.evaluate(`fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: ${JSON.stringify(idToken)} }) }).then((r) => r.status)`), 201, `sign-in as ${role}`);
    await b.evaluate(`window.name = ${JSON.stringify(role === "admin" ? "p3-owner" : "")}`);
    signedInAs = role;
  };
  const openPage = async (p, size = DESKTOP) => {
    await b.open(`${base}${p}`, size);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 20000), `${p}: app loaded`);
  };
  const shot = async (name) => {
    const dir = process.env.JARC_EMP_SCREENSHOTS; if (!dir) return;
    const r = await b.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    if (r.result?.data) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(r.result.data, "base64")); }
  };
  const manageUrl = (n = 1, ds = "active") => `/admin/employees/${ds}/records/${ID(n)}/manage`;
  // The page route for …/manage is the backend's (app.js EMPLOYEES_LINK_PATH). Until it serves it, the tab is opened from the
  // profile address by its tab button (the client then puts /manage in the address); once it does, the address is loaded directly.
  let served = null;
  const openManage = async (n = 1, ds = "active", size = DESKTOP) => {
    if (served === null) { await b.open(`${base}/api/v1/health`, size); served = await b.evaluate(`fetch(${JSON.stringify(manageUrl(n, ds))}).then((r) => r.status)`) === 200; }
    if (served) { await openPage(manageUrl(n, ds), size); return; }
    await openPage(`/admin/employees/${ds}/records/${ID(n)}`, size);
    if (!(await wait(`!!document.querySelector("#emp-p-tab-manage-${ds}")`, 15000))) return;
    await click(`#emp-p-tab-manage-${ds}`);
    await wait(`location.pathname.endsWith("/manage")`);
  };

  test("1. owner: three tabs, a fresh load of /manage, the sections, no workspaceRef in the page, nothing stored", async () => {
    await setRole("admin");
    await openManage();
    assert.ok(await wait(`!!document.querySelector(".emp-manage .emp-m__table")`, 15000), `the tab: ${await visibleText()}`);
    if (!served) console.log("# note: the server doesn't serve …/manage page addresses yet (backend app.js); opened through the tab");
    assert.deepEqual(await json(`[...document.querySelectorAll(".emp-p__tabs [role=tab]")].map((t) => [t.textContent, t.getAttribute("aria-selected")])`), [["Profile", "false"], ["JARC access", "false"], ["Manage access", "true"]]);
    const t = await visibleText();
    for (const re of [/JARC account\s+Active/, /Shared access still gives Workspace admin in every workspace; removing this membership only removes member management and comment moderation\./, /Last Workspace admin of this workspace/, /Change refused/, /Access history/i]) assert.match(t, re);
    assert.equal(await b.evaluate(`document.querySelector("#employees-root").innerHTML.includes("SyntheticWsRef")`), false, "no workspaceRef in the page");
    assert.ok(await wait(`!!document.querySelector(".emp-m__hist.is-rejected")`), "rejected history entry styled distinctly");
    // Keys: ← from Manage access goes to JARC access.
    await b.evaluate(`document.querySelector("#emp-p-tab-manage-active").focus()`);
    await b.key("ArrowLeft");
    assert.ok(await wait(`document.activeElement?.id === "emp-p-tab-access-active" && location.pathname.endsWith("/access")`), "ArrowLeft: JARC access");
    await b.key("ArrowRight");
    assert.ok(await wait(`document.activeElement?.id === "emp-p-tab-manage-active" && location.pathname.endsWith("/manage")`), "ArrowRight: Manage access");
    const stored = await b.evaluate(`JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])`);
    assert.doesNotMatch(stored, /Synthetic Workspace|SyntheticWsRef|manage-access/);
    assert.equal(await sideways(), 0);
    await noErrors("owner manage tab");
  });

  test("2. Suspend: dialog with focus inside, Escape returns focus; reason required; CSRF + expectedVersion; busy; toast and refreshed body; Restore", async () => {
    await setRole("admin");
    await openManage();
    assert.ok(await wait(`!!document.querySelector('[data-action="emp-m-open"][data-act="suspend"]')`, 15000));
    await b.evaluate(`document.querySelector('[data-action="emp-m-open"][data-act="suspend"]').focus()`);
    await click('[data-action="emp-m-open"][data-act="suspend"]');
    assert.ok(await wait(`!!document.querySelector("#overlay-root .emp-m-dialog[role=dialog][aria-modal=true]") && document.activeElement?.id === "emp-m-d-reason"`), "dialog open, focus on the reason");
    assert.match(await b.evaluate(`document.querySelector("#overlay-root .emp-m-dialog").innerText`), /sessions end now[\s\S]*refused while suspended/);
    await b.key("Escape");
    assert.ok(await wait(`!document.querySelector("#overlay-root .emp-m-dialog") && document.activeElement?.dataset.act === "suspend"`), "Escape: closed, focus back on Suspend");
    await click('[data-action="emp-m-open"][data-act="suspend"]');
    assert.ok(await wait(`!!document.querySelector("#emp-m-d-reason")`));
    await submitDialog();
    assert.ok(await wait(`/Give a reason of 3 to 500 characters/.test(document.querySelector("#emp-m-d-error")?.textContent || "")`), "reason required");
    assert.equal((await json("window.__writes")).length, 0);
    await type("#emp-m-d-reason", "Synthetic leave of absence");
    await submitDialog();
    assert.ok(await wait(`document.querySelector("#overlay-root .emp-m-dialog")?.getAttribute("aria-busy") === "true"`, 2000), "busy state shown");
    assert.ok(await wait(`!document.querySelector("#overlay-root .emp-m-dialog") && /Account suspended/.test(document.querySelector("#toast-region")?.innerText || "") && !!document.querySelector('[data-act="restore"]')`), `done: ${await visibleText()}`);
    const w = await json("window.__writes");
    assert.equal(w.length, 1);
    assert.deepEqual(w[0], { method: "POST", what: "access", ref: null, body: { action: "suspend", expectedVersion: 3, expectedState: "active", reason: "Synthetic leave of absence" }, csrf: true });
    assert.match(await visibleText(), /JARC account\s+Suspended/);
    assert.ok(await wait(`!!document.activeElement?.closest?.("#employees-body")`), "focus back in the tab");
    // Restore: says tokens become usable again.
    await click('[data-action="emp-m-open"][data-act="restore"]');
    assert.ok(await wait(`/existing API tokens become usable again/.test(document.querySelector("#overlay-root .emp-m-dialog")?.innerText || "")`));
    await submitDialog();
    assert.ok(await wait(`!document.querySelector("#overlay-root .emp-m-dialog") && !!document.querySelector('[data-act="suspend"]')`), "restored");
    await noErrors("suspend / restore");
  });

  test("3. 409: 'Changed by someone else, reloaded'; Revoke needs REVOKE", async () => {
    await setRole("admin");
    await openManage();
    assert.ok(await wait(`!!document.querySelector('[data-act="revoke"]')`, 15000));
    await b.evaluate("window.__p3.conflictNext = true");
    await click('[data-action="emp-m-open"][data-act="suspend"]');
    assert.ok(await wait(`!!document.querySelector("#emp-m-d-reason")`));
    await type("#emp-m-d-reason", "Synthetic reason");
    await submitDialog();
    assert.ok(await wait(`/Changed by someone else, reloaded/.test(document.querySelector("#toast-region")?.innerText || "") && !document.querySelector("#overlay-root .emp-m-dialog")`), "conflict toast");
    assert.ok(await wait(`/Changed by someone else\\. Reloaded/.test(document.querySelector("#employees-root")?.innerText || "")`), "notice");
    await click('[data-action="emp-m-open"][data-act="revoke"]');
    assert.ok(await wait(`!!document.querySelector("#emp-m-d-confirm")`));
    await type("#emp-m-d-reason", "Synthetic offboarding");
    await type("#emp-m-d-confirm", "revoke");
    await submitDialog();
    assert.ok(await wait(`/Type REVOKE in capital letters/.test(document.querySelector("#emp-m-d-error")?.textContent || "")`));
    await type("#emp-m-d-confirm", "REVOKE");
    await submitDialog();
    assert.ok(await wait(`!document.querySelector("#overlay-root .emp-m-dialog") && /JARC account\\s+Revoked/.test(document.querySelector("#employees-root").innerText)`), `revoked: ${await visibleText()}`);
    assert.match(await visibleText(), /JARC API: 2 tokens revoked; Fabric API: 1 token revoked/);
    const last = (await json("window.__writes")).at(-1);
    assert.deepEqual(last.body, { action: "revoke", expectedVersion: 4, expectedState: "active", reason: "Synthetic offboarding", confirm: "REVOKE" });
    await noErrors("conflict / revoke");
  });

  test("4. memberships: add, change role, remove with the shared-access note; never 'access revoked'", async () => {
    await setRole("admin");
    await openManage();
    assert.ok(await wait(`!!document.querySelector(".emp-m__add")`, 15000));
    await click('.emp-m__add button[type=submit]');
    assert.ok(await wait(`/Add a membership in Synthetic Workspace With A Very Long Name/.test(document.querySelector("#overlay-root .emp-m-dialog")?.innerText || "")`));
    await submitDialog();
    assert.ok(await wait(`/Membership added/.test(document.querySelector("#toast-region")?.innerText || "") && !document.querySelector(".emp-m__add")`), "added; nothing left to add");
    await b.evaluate(`(() => { const s = document.querySelector("#emp-m-role-0-active"); s.value = "VIEWER"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    assert.ok(await wait(`!document.querySelector('[data-action="emp-m-change"][data-ws="0"]').disabled`), "Change role enabled");
    await click('[data-action="emp-m-change"][data-ws="0"]');
    assert.ok(await wait(`/Member → Viewer[\\s\\S]*Shared access still gives Workspace admin/.test(document.querySelector("#overlay-root .emp-m-dialog")?.innerText || "")`));
    await submitDialog();
    assert.ok(await wait(`/Membership role changed/.test(document.querySelector("#toast-region")?.innerText || "")`));
    await click('[data-action="emp-m-remove"][data-ws="0"]');
    const d = await b.evaluate(`document.querySelector("#overlay-root .emp-m-dialog")?.innerText || ""`);
    assert.match(d, /only removes member management and comment moderation/); assert.doesNotMatch(d, /access revoked/i);
    await submitDialog();
    assert.ok(await wait(`/Membership removed/.test(document.querySelector("#toast-region")?.innerText || "")`));
    const w = (await json("window.__writes")).filter((x) => x.what === "memberships");
    assert.deepEqual(w.map((x) => [x.method, x.ref, x.body, x.csrf]), [["POST", null, { workspaceRef: "SyntheticWsRefBBBBBBBB", role: "VIEWER" }, true], ["PATCH", "SyntheticWsRefAAAAAAAA", { role: "VIEWER" }, true], ["DELETE", "SyntheticWsRefAAAAAAAA", null, true]]);
    assert.equal(await b.evaluate(`document.querySelector('[data-action="emp-m-remove"][data-ws="2"]').disabled`), true, "last admin: Remove disabled");
    await noErrors("memberships");
  });

  test("5. Entra-disabled suggestion pre-fills the reason", async () => {
    await setRole("admin");
    await openManage(3, "all");
    assert.ok(await wait(`!!document.querySelector(".emp-m__entra [data-prefill=entra]")`, 15000), `suggestion: ${await visibleText()}`);
    await click(".emp-m__entra [data-prefill=entra]");
    assert.ok(await wait(`document.querySelector("#emp-m-d-reason")?.value === "Disabled in Microsoft Entra ID"`));
    await b.key("Escape");
    await noErrors("entra");
  });

  test("6. viewer: no Manage access tab; a /manage address shows the profile", async () => {
    await setRole("viewer");
    await openManage();
    assert.ok(await wait(`!!document.querySelector("#employees-root .emp-profile") && /Identity/i.test(document.querySelector("#employees-root").innerText)`, 15000));
    assert.equal(await has(".emp-p__tabs"), false);
    assert.doesNotMatch(await visibleText(), /Manage access/);
    assert.ok(await wait(`location.pathname === "/admin/employees/active/records/${ID(1)}"`), "address without /manage");
    await noErrors("viewer");
  });

  test("8. REAL backend (no stubs): not registered → Grant (provisioned) → Suspend → Restore, with the history", async () => {
    await setRole("admin");
    await b.evaluate(`window.name = "p3-real"`); signedInAs = "admin-real";
    const dialogText = () => b.evaluate(`document.querySelector("#overlay-root .emp-m-dialog")?.innerText || ""`);
    const tab = () => b.evaluate(`document.querySelector("#employees-root")?.innerText || ""`);
    const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
    await openManage(2);
    assert.ok(await wait(`!!document.querySelector(".emp-manage, .emp-m__state[role=alert]")`, 15000), `the tab answered: ${await visibleText()}`);
    assert.match(await visibleText(), /JARC account\s+Not registered/, await visibleText());
    await click('[data-action="emp-m-open"][data-act="grant"]');
    assert.ok(await until(async () => /pre-provisions a JARC account[\s\S]*sign in with Microsoft/.test(await dialogText())), `Grant explains pre-provisioning: ${await dialogText()}`);
    await submitDialog();
    assert.ok(await until(async () => !(await dialogText()) && /JARC account\s+Active/.test(await tab())), `granted: ${await tab()} ${await dialogText()}`);
    assert.match(await visibleText(), /Provisioned \(not signed in yet\)/);
    // P4-0 (D-H2, fail closed): nobody has seen this person sign in, so whether they are a JARC administrator is unknown and Suspend
    // is refused with the reason; the row says "unknown".
    assert.match(await visibleText(), /JARC administrator\s+JARC administrator role unknown/, await visibleText());
    assert.match(await visibleText(), /sign in to JARC once/);
    // Their first sign-in (without the JARC.Admin role) records the observation (routes/auth.js recordAdminRole); simulated here.
    await realDb.collection("users").updateOne({ provisionedAt: { $exists: true }, adminRoleClearedAt: { $exists: false } }, { $set: { adminRoleClearedAt: new Date() } });
    await openManage(2);
    assert.ok(await until(async () => /JARC administrator role not seen at their last sign-in/.test(await tab())), `observed: ${await tab()}`);
    await click('[data-action="emp-m-open"][data-act="suspend"]');
    assert.ok(await wait(`!!document.querySelector("#emp-m-d-reason")`));
    await type("#emp-m-d-reason", "Synthetic leave of absence");
    await submitDialog();
    assert.ok(await until(async () => !(await dialogText()) && /JARC account\s+Suspended/.test(await tab())), `suspended: ${await tab()} ${await dialogText()}`);
    const history = () => b.evaluate(`document.querySelector(".emp-m__history")?.innerText || ""`);
    assert.ok(await until(async () => { const h = await history(); return /Account suspended[\s\S]*Synthetic leave of absence/.test(h) && /Access granted|Account pre-provisioned/.test(h); }, 10000), `history: ${await history()}`);
    await click('[data-action="emp-m-open"][data-act="restore"]');
    assert.ok(await until(async () => /usable again/.test(await dialogText())), `restore dialog: ${await dialogText()}`);
    await submitDialog();
    assert.ok(await until(async () => !(await dialogText()) && /JARC account\s+Active/.test(await tab())), `restored: ${await tab()} ${await dialogText()}`);
    // The JARC access tab reflects the change (P2 index invalidated).
    await click("#emp-p-tab-access-active");
    assert.ok(await wait(`!!document.querySelector(".emp-access")`, 15000));
    assert.match(await visibleText(), /Provisioned \(not signed in yet\)|JARC account status\s+Active/, await visibleText());
    await noErrors("real backend");
  });

test("7. responsive: 360 / 768 / 1440 in light and dark; cards on phones; the dialog full width at 360", async () => {
    await setRole("admin");
    const bgs = {};
    for (const [width, height] of [[360, 740], [768, 1024], [1440, 900]]) {
      for (const theme of ["light", "dark"]) {
        const label = `${width}px ${theme}`;
        await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
        await openManage(1, "active", { width, height });
        await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
        assert.ok(await wait(`!!document.querySelector(".emp-manage .emp-m__table") && !!document.querySelector(".emp-m__hist")`, 15000), `${label}: drawn`);
        assert.equal(await sideways(), 0, `${label}: sideways scroll`);
        const cards = await b.evaluate(`getComputedStyle(document.querySelector(".emp-m__table tr.emp-m__ws")).display`);
        if (width === 360) assert.equal(cards, "block", `${label}: rows are cards`);
        if (width === 1440) assert.equal(cards, "table-row", `${label}: a table`);
        bgs[label] = await b.evaluate(`getComputedStyle(document.querySelector(".emp-m__section")).backgroundColor`);
        await shot(`p3-manage-${width}-${theme}`);
        if (width !== 768) {
          await click('[data-action="emp-m-open"][data-act="revoke"]');
          assert.ok(await wait(`!!document.querySelector("#emp-m-d-confirm")`), `${label}: dialog`);
          const r = await json(`(() => { const r = document.querySelector("#overlay-root .emp-m-dialog").getBoundingClientRect(); return { left: r.left, right: r.right, vw: document.documentElement.clientWidth }; })()`);
          if (width === 360) assert.ok(r.left <= 1 && r.right >= r.vw - 1, `${label}: full width ${JSON.stringify(r)}`);
          else assert.ok(r.left > 0 && r.right < r.vw, `${label}: centred`);
          await shot(`p3-revoke-dialog-${width}-${theme}`);
          await b.key("Escape");
        }
      }
    }
    assert.notEqual(bgs["1440px light"], bgs["1440px dark"], "the dark theme applies");
    await noErrors("responsive");
  });
});
