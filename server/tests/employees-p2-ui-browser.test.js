// People directory P2 (Employee Access Visibility) in the REAL app, in a headless Chrome/Edge: the JARC shell with the real
// employees backend (as employees-ui-browser.test.js), and the P2 answers STUBBED in the page per contract P2 §4 / §5 so this
// test checks the frontend whatever state the backend is in: /features and /status get employees.jarcAccess for the owner (the page knows the role from window.name, which the test sets), the
// owner's schemas get the JARC fields (group "jarc"), …/jarc-access answers synthetic access data, and a records request
// filtered on a JARC field answers one synthetic disabled account. Viewers' answers are left untouched (the real backend's).
// Synthetic data only (example.com, "Synthetic …"); nothing leaves 127.0.0.1. Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
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
const ROWS = ".fabric-explorer-table tbody tr";
const DOCS = syntheticPeople(4).map((d, i) => {
  const [name, enabled] = [["Synthetic Person 1", true], ["Synthetic Person 2", true], ["Synthetic Person 3", true], ["Synthetic Person 4", false]][i];
  return { ...d, display_name: name, first_name: "Synthetic", last_name: name.split(" ").slice(1).join(" "), job_title: "Analyst", department: "Dept A", office_location: null, account_enabled: enabled, user_type: "Member" };
});
const ID = (n) => profileId(TEST_ID_KEY, DOCS[n - 1].user_id);

const JARC_FIELDS = [
  { name: "jarcAccount", label: "JARC account", type: "string", kind: "category" },
  { name: "jarcStatus", label: "JARC account status", type: "string", kind: "category" },
  { name: "jarcDisabledWithAccess", label: "Disabled in Entra, still has JARC access", type: "bool", kind: "bool", operators: [{ op: "isTrue", class: "fast" }, { op: "isFalse", class: "fast" }] },
  { name: "jarcLastSignIn", label: "Last JARC sign-in", type: "date", kind: "date", operators: [{ op: "between", class: "fast" }, { op: "blank", class: "fast" }] }
].map((f) => ({ operators: [{ op: "eq", class: "fast" }, { op: "in", class: "fast" }, { op: "blank", class: "fast" }], valueSource: "none", sensitive: false, filterable: true, sortable: false, searchable: false, orderable: false, requiresDateWindow: false, ...f, group: "jarc" }));
const accessFor = (registered, disabled = false) => ({
  generatedAt: "2026-11-26T01:00:00.000Z", stale: false,
  policy: { shared: true, accessPolicy: "development_shared", betaOpenEditing: true, accountManagement: "off" },
  account: registered ? { registered: true, status: "active", registeredAt: "2026-10-01T08:00:00.000Z", lastSignInAt: "2026-11-25T09:15:00.000Z", lastSignInPrecisionMinutes: 15, signedInNow: false, lastSeenAt: null, jarcAdmin: "unknown", accountRole: null, entraEnabled: !disabled, entraDisabledWithAccess: disabled, matchedBy: "entra_object_id" }
    : { registered: false, status: null, registeredAt: null, lastSignInAt: null, lastSignInPrecisionMinutes: 15, signedInNow: false, lastSeenAt: null, jarcAdmin: null, accountRole: null, entraEnabled: true, entraDisabledWithAccess: false, matchedBy: null },
  appPermissions: registered ? [{ key: "manageWorkspaces", label: "Create and manage workspaces", granted: true, source: "shared" }, { key: "imports", label: "Imports", granted: false, source: null }] : [],
  workspaces: registered ? [
    { name: "Synthetic Workspace A", archived: false, membership: { role: "MEMBER", status: "active", since: "2026-10-02T00:00:00.000Z" }, sharedRole: "WORKSPACE_ADMIN", effectiveRole: "WORKSPACE_ADMIN", source: "membership_and_shared", permissions: { view: true, editContent: true, manageBoards: true, manageMembers: true, moderateComments: true }, boards: 1 },
    { name: "Synthetic Workspace With A Very Long Name That Must Wrap On Small Phones", archived: false, membership: null, sharedRole: "WORKSPACE_ADMIN", effectiveRole: "WORKSPACE_ADMIN", source: "shared", permissions: { view: true, editContent: true, manageBoards: true, manageMembers: false, moderateComments: false }, boards: 1 }
  ] : [],
  boards: registered ? { total: 2, shown: 2, truncated: false, items: [{ name: "Synthetic Board 1", workspace: "Synthetic Workspace A", publicId: 100001, effectiveRole: "WORKSPACE_ADMIN", source: "membership_and_shared" }, { name: "Synthetic Board 2", workspace: "Synthetic Workspace With A Very Long Name That Must Wrap On Small Phones", publicId: 100002, effectiveRole: "WORKSPACE_ADMIN", source: "shared", readOnly: true }] } : { total: 0, shown: 0, truncated: false, items: [] },
  notes: ["Shared access gives every active JARC user Workspace admin in every workspace.", "JARC has no board-level grants."]
});

// The page: records directory requests and console errors, and stubs the P2 answers (owner only, see the header).
const STUB = `(() => {
  window.__errors = []; window.__emp = [];
  const oe = console.error.bind(console);
  console.error = (...a) => { window.__errors.push(a.map((x) => (x && x.stack) || String(x)).join(" ")); oe(...a); };
  addEventListener("error", (e) => window.__errors.push("uncaught: " + (e.message || e.type)));
  addEventListener("unhandledrejection", (e) => window.__errors.push("rejection: " + ((e.reason && e.reason.message) || e.reason)));
  const FIELDS = ${JSON.stringify(JARC_FIELDS)}, REG = ${JSON.stringify(accessFor(true))}, DIS = ${JSON.stringify(accessFor(true, true))}, NOREG = ${JSON.stringify(accessFor(false))};
  const ID2 = ${JSON.stringify(ID(2))}, ID4 = ${JSON.stringify(ID(4))};
  const owner = window.name === "p2-owner"; // set by the test for the owner's pages (window.name survives navigation)
  const of = window.fetch.bind(window);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
  const edit = async (input, init, fn) => { const r = await of(input, init); if (!r.ok) return r; let j; try { j = await r.clone().json(); } catch { return r; } fn(j); return json(j, r.status); };
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url, rel = url.replace(/^https?:\\/\\/[^/]+/, ""), p = rel.split("?")[0];
    if (rel.startsWith("/api/v1/admin/employees")) window.__emp.push(rel);
    if (!owner) return of(input, init);
    if (p === "/api/v1/features") return edit(input, init, (j) => { if (j?.employees) j.employees.jarcAccess = true; });
    if (p === "/api/v1/admin/employees/status") return edit(input, init, (j) => { if (j.access) j.access.jarcAccess = true; });
    let m = /^\\/api\\/v1\\/admin\\/employees\\/([a-z]+)\\/schema$/.exec(p);
    if (m) return edit(input, init, (j) => { const have = new Set((j.fields || []).map((f) => f.name)); j.fields = [...(j.fields || []).filter((f) => !f.name.startsWith("jarc")), ...FIELDS]; j.access = { ...(j.access || {}), jarcAccess: true }; });
    m = /^\\/api\\/v1\\/admin\\/employees\\/([a-z]+)\\/records\\/([A-Za-z0-9_-]{22})\\/jarc-access$/.exec(p);
    if (m) return json({ dataset: m[1], id: m[2], ...(m[2] === ID2 ? NOREG : m[2] === ID4 ? DIS : REG) });
    m = /^\\/api\\/v1\\/admin\\/employees\\/([a-z]+)\\/records$/.exec(p);
    if (m) {
      const q = new URLSearchParams(rel.split("?")[1] || ""), f = q.get("filter") || "";
      let text = ""; try { text = atob(f.replace(/-/g, "+").replace(/_/g, "/")); } catch { text = ""; }
      if (text.includes("jarc")) return json({ dataset: m[1], fields: (q.get("fields") || "displayName").split(","), items: [{ id: ID4, values: { displayName: "Synthetic Person 4", jobTitle: "Analyst", department: "Dept A", officeLocation: null, mail: "person4@example.com" } }], pagination: { limit: 100, hasMore: false, nextCursor: null }, snapshot: { ingestedAt: "2026-11-24T06:00:00.000Z", stale: false } });
    }
    return of(input, init);
  };
})();`;

describe("People directory P2 in the real app (headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let issuer, persons, server, base, b, app, employees, signedInAs = null;
  before(async () => {
    issuer = await createTokenIssuer();
    persons = { viewer: issuer.person("Synthetic Viewer"), admin: issuer.person("Synthetic Owner") };
    // The owner is also a directory account, so test 6 can read the owner's own JARC access from the REAL backend.
    DOCS.push({ ...syntheticPeople(5)[4], user_id: persons.admin.oid.toLowerCase(), display_name: "Synthetic Owner", first_name: "Synthetic", last_name: "Owner", job_title: null, department: null, office_location: null, account_enabled: true, user_type: "Member" });
    const port = await freePort();
    base = `http://localhost:${port}`;
    const entra = { ...issuer.config, redirectUri: `${base}/`, appOrigin: base };
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => new FakeMongoClient() });
    await connection.connect();
    await ensureDatabase(connection.db);
    const dataLayer = createDataLayer({ connection, logger: { error() {} }, fileStore: new MemoryFileStore(), environment: "test" });
    const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: issuer.config.tenantId, viewerObjectIds: [persons.viewer.oid], adminObjectIds: [persons.admin.oid] }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
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
  const setRole = async (role) => {
    if (signedInAs === role) return;
    await b.open(`${base}/api/v1/health`, DESKTOP);
    const nonce = await b.evaluate(`fetch("/api/v1/auth/sign-in/start", { method: "POST" }).then((r) => r.json()).then((s) => s.nonce)`);
    const idToken = await persons[role].idToken(nonce);
    assert.equal(await b.evaluate(`fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: ${JSON.stringify(idToken)} }) }).then((r) => r.status)`), 201, `sign-in as ${role}`);
    await b.evaluate(`window.name = ${JSON.stringify(role === "admin" ? "p2-owner" : "")}`);
    signedInAs = role;
  };
  const openPage = async (path, size = DESKTOP) => {
    await b.open(`${base}${path}`, size);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 20000), `${path}: app loaded`);
  };

  test("1. owner: Profile | JARC access tabs; the tab, its address, Back / Forward, keys, Escape; nothing stored", async () => {
    await setRole("admin");
    await openPage(`/admin/employees/active/records/${ID(1)}`);
    assert.ok(await wait(`!!document.querySelector("#employees-root .emp-p__tabs [role=tab]")`, 15000), "tab bar shown");
    assert.deepEqual(await json(`[...document.querySelectorAll(".emp-p__tabs [role=tab]")].map((t) => [t.textContent, t.getAttribute("aria-selected")])`), [["Profile", "true"], ["JARC access", "false"]]);
    assert.match(await visibleText(), /Identity/i);
    await click("#emp-p-tab-access-active");
    assert.ok(await wait(`location.pathname === "/admin/employees/active/records/${ID(1)}/access" && !!document.querySelector(".emp-access")`), "the JARC access tab and its address");
    assert.equal(await b.evaluate(`document.activeElement?.id`), "emp-p-tab-access-active", "focus stays on the chosen tab");
    const t = await visibleText();
    for (const s of [/JARC account\s+Registered/, /Unknown \(not signed in\)/, /Application permissions/, /Synthetic Workspace A/, /Membership: Member/, /Shared access/, /Accessible boards/, /Read-only \(synced\)/, /Shared access is on\./, /JARC has no board-level grants\./]) assert.match(t, new RegExp(s.source, "i"));
    assert.equal(await b.evaluate(`document.querySelector('.emp-a__board-link')?.getAttribute("href")`), "/boards/100001");
    assert.equal(await b.evaluate(`document.querySelectorAll(".emp-access input, .emp-access select, .emp-access button, .emp-access form").length`), 0, "read-only");
    // Back / Forward between the tabs.
    await b.evaluate("history.back()");
    assert.ok(await wait(`location.pathname === "/admin/employees/active/records/${ID(1)}" && document.querySelector("#emp-p-tab-profile-active")?.getAttribute("aria-selected") === "true"`), "Back: Profile");
    await b.evaluate("history.forward()");
    assert.ok(await wait(`location.pathname.endsWith("/access") && !!document.querySelector(".emp-access")`), "Forward: JARC access");
    // ← on the tabs, then Escape back to the list with focus on the row.
    await b.evaluate(`document.querySelector("#emp-p-tab-access-active").focus()`);
    await b.key("ArrowLeft");
    assert.ok(await wait(`document.activeElement?.id === "emp-p-tab-profile-active" && !location.pathname.endsWith("/access")`), "ArrowLeft: Profile, focused");
    await b.key("Escape");
    assert.ok(await wait(`location.pathname === "/admin/employees/active" && document.querySelectorAll(${JSON.stringify(ROWS)}).length === 4`), "Escape: the list (3 synthetic people and the owner)");
    const stored = await b.evaluate(`JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])`);
    assert.doesNotMatch(stored, /Synthetic Workspace|Synthetic Board|100001|Synthetic Person/);
    await noErrors("owner tabs");
  });

  test("2. owner: a fresh load of /access; not registered; disabled in Entra with JARC access", async () => {
    await setRole("admin");
    await openPage(`/admin/employees/active/records/${ID(2)}/access`);
    assert.ok(await wait(`/No JARC account\\. This person has never signed in to JARC\\./.test(document.querySelector("#employees-root")?.innerText || "")`, 15000), "not-registered state");
    assert.equal(await has(".emp-a__ws"), false);
    await openPage(`/admin/employees/disabled/records/${ID(4)}/access`);
    assert.ok(await wait(`!!document.querySelector(".emp-a__alert[role=alert]")`, 15000), `the disabled-with-access warning: ${await visibleText()} ${JSON.stringify(await json("window.__emp"))}`);
    assert.match(await visibleText(), /Disabled in Microsoft Entra ID, still has JARC access/);
    await noErrors("owner states");
  });

  test("3. owner: 'Disabled with JARC access' in the navigation; JARC access columns and filter fields are grouped", async () => {
    await setRole("admin");
    await openPage("/admin/employees/active");
    assert.ok(await wait(`!!document.querySelector("#emp-obj-jarc-disabled")`, 15000), "the nav item");
    await click("#emp-obj-jarc-disabled");
    assert.ok(await wait(`location.pathname === "/admin/employees/disabled" && location.search.includes("filter=") && document.querySelectorAll(${JSON.stringify(ROWS)}).length === 1`), `the filtered Disabled list: ${await b.evaluate("location.href")} ${await visibleText()}`);
    assert.equal(await b.evaluate(`document.querySelector("#emp-obj-jarc-disabled").getAttribute("aria-current")`), "page");
    assert.match(await b.evaluate(`document.querySelector("#employees-section-title").textContent`), /Disabled with JARC access/);
    assert.ok(await has(".fx-filterbar__info"), "the filter shows as a chip");
    // Columns: the JARC access heading and its fields.
    await click('[data-action="fabric-x-columns"][data-ds="disabled"]');
    assert.ok(await wait(`!!document.querySelector("#fabric-disabled-chooser .fabric-chooser-group__title")`), "grouped Columns");
    assert.deepEqual(await json(`[...document.querySelectorAll("#fabric-disabled-chooser .fabric-chooser-group__title")].map((e) => e.textContent)`), ["Directory", "JARC access"]);
    assert.equal(await sideways(), 0);
    await noErrors("owner nav");
  });

  // Regression (shared Advanced Filters popover): at 1440 px with JARC's sidebar and the Directory panel open, the Filters button
  // sits far right and the 720 px popover used to run past the viewport (x 783→1503 of 1425, Cancel clipped). It must end at
  // least 8 px inside, also after the Directory panel is collapsed / reopened and the window resized while it is open.
  test("3b. Advanced Filters popover stays inside the viewport (sidebars open, toggled, resized)", async () => {
    await setRole("viewer"); // the same toolbar for viewers and the owner
    await b.open(`${base}/admin/employees/active`, DESKTOP);
    assert.ok(await wait(`document.querySelectorAll(${JSON.stringify(ROWS)}).length > 0`, 20000), "list");
    if (await b.evaluate(`(document.querySelector("#sidebar")?.getBoundingClientRect().width || 0) < 120`)) await click(".sidebar-collapse-top");
    if (await b.evaluate(`!!document.querySelector("#employees-objects")?.classList.contains("is-collapsed")`)) await click('[data-action="emp-o-collapse"]');
    await click('[data-action="fabric-x-filters"][data-ds="active"][data-focus-key="filters"]');
    assert.ok(await wait(`!!document.querySelector("#fabric-active-fb")`), "the popover opens");
    const inside = async (label) => {
      await new Promise((r) => setTimeout(r, 250));
      const m = await json(`(() => { const r = document.querySelector("#fabric-active-fb").getBoundingClientRect(), c = document.querySelector('#fabric-active-fb [data-action="fabric-f-cancel"]').getBoundingClientRect(), vw = document.documentElement.clientWidth; return { left: r.left, right: r.right, cancel: c.right, vw }; })()`);
      assert.ok(m.left >= 7.5 && m.right <= m.vw - 7.5 && m.cancel <= m.vw - 7.5, `${label}: popover inside the viewport with an 8 px margin ${JSON.stringify(m)}`);
    };
    await inside("1440 px, sidebars open");
    assert.ok(await b.evaluate(`!!document.activeElement?.closest("#fabric-active-fb")`), "focus is inside the popover");
    await click('[data-action="emp-o-collapse"]'); await inside("Directory panel collapsed while open");
    await click('[data-action="emp-o-collapse"]'); await inside("Directory panel reopened while open");
    await b.viewport({ width: 1100, height: 900 }); await inside("resized to 1100 px while open");
    await b.viewport(DESKTOP); await inside("back to 1440 px");
    await b.evaluate(`document.querySelector('#fabric-active-fb [data-focus-key="fb-add-root"]').focus()`); // the toggles took focus outside
    await b.key("Escape");
    assert.ok(await wait(`!document.querySelector("#fabric-active-fb") && document.activeElement?.dataset.action === "fabric-x-filters"`), "Escape closes it, focus back on Filters");
    await noErrors("popover placement");
  });

  test("4. viewer: no tab bar, no nav item; an /access address shows the profile and becomes the profile's address", async () => {
    await setRole("viewer");
    await openPage(`/admin/employees/active/records/${ID(1)}/access`);
    assert.ok(await wait(`!!document.querySelector("#employees-root .emp-profile") && /Identity/i.test(document.querySelector("#employees-root").innerText)`, 15000), "the P1 profile");
    assert.equal(await has(".emp-p__tabs"), false);
    assert.equal(await has("#emp-obj-jarc-disabled"), false);
    assert.doesNotMatch(await visibleText(), /JARC access/);
    assert.ok(await wait(`location.pathname === "/admin/employees/active/records/${ID(1)}"`), "address without /access");
    assert.ok(!(await json("window.__emp")).some((c) => c.includes("jarc-access")), "no access request");
    await noErrors("viewer");
  });

  test("5. owner: the JARC access tab at 320–1440 px in light and dark: no sideways scroll, tabs on screen", async () => {
    await setRole("admin");
    const bgs = {};
    for (const [width, height] of [[320, 640], [390, 844], [480, 900], [1024, 768], [1440, 900]]) {
      for (const theme of ["light", "dark"]) {
        const label = `${width}px ${theme}`;
        await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
        await openPage(`/admin/employees/active/records/${ID(1)}/access`, { width, height });
        await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
        assert.ok(await wait(`!!document.querySelector(".emp-access .emp-a__ws")`, 15000), `${label}: tab drawn: ${await b.evaluate("location.href")} ${await visibleText()}`);
        assert.equal(await sideways(), 0, `${label}: sideways scroll`);
        const tabs = await json(`(() => { const r = document.querySelector(".emp-p__tabs").getBoundingClientRect(); return { left: r.left, right: r.right, vw: document.documentElement.clientWidth }; })()`);
        assert.ok(tabs.left >= -1 && tabs.right <= tabs.vw + 1, `${label}: tabs on screen ${JSON.stringify(tabs)}`);
        bgs[label] = await b.evaluate(`getComputedStyle(document.querySelector(".emp-a__section")).backgroundColor`);
        if (process.env.JARC_EMP_SCREENSHOTS) { const shot = await b.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); if (shot.result?.data) { require("fs").mkdirSync(process.env.JARC_EMP_SCREENSHOTS, { recursive: true }); require("fs").writeFileSync(require("path").join(process.env.JARC_EMP_SCREENSHOTS, `p2-access-${width}-${theme}.png`), Buffer.from(shot.result.data, "base64")); } }
      }
    }
    assert.notEqual(bgs["1440px light"], bgs["1440px dark"], "the dark theme applies to the tab");
    await noErrors("responsive");
  });

  test("6. owner, REAL backend (no stubs): own JARC access, a not-registered person, grouped columns, the nav item", async () => {
    await setRole("admin");
    await b.evaluate(`window.name = ""`); signedInAs = "admin-real"; // the stub passes everything through
    await openPage(`/admin/employees/active/records/${ID(5)}/access`);
    assert.ok(await wait(`!!document.querySelector(".emp-access, .emp-a__state[role=alert]")`, 15000), "the tab answered");
    const t = await visibleText();
    assert.match(t, /JARC account\s+Registered/i, t);
    assert.match(t, /Signed in to JARC now\s+Yes/i);
    assert.match(t, /Application permissions/i);
    assert.equal(await b.evaluate(`document.querySelectorAll(".emp-access input, .emp-access select, .emp-access button, .emp-access form").length`), 0, "read-only");
    await openPage(`/admin/employees/active/records/${ID(1)}/access`);
    assert.ok(await wait(`/No JARC account\. This person has never signed in to JARC\./.test(document.querySelector("#employees-root")?.innerText || "")`, 15000), `not registered: ${await visibleText()}`);
    await openPage("/admin/employees/active");
    assert.ok(await wait(`document.querySelectorAll(${JSON.stringify(ROWS)}).length > 0 && !!document.querySelector("#emp-obj-jarc-disabled")`, 15000), "list and nav item");
    await click('[data-action="fabric-x-columns"][data-ds="active"]');
    assert.ok(await wait(`!!document.querySelector("#fabric-active-chooser .fabric-chooser-group__title")`), "grouped Columns from the real schema");
    assert.deepEqual(await json(`[...document.querySelectorAll("#fabric-active-chooser .fabric-chooser-group__title")].map((e) => e.textContent)`), ["Directory", "JARC access"]);
    await click("#emp-obj-jarc-disabled");
    assert.ok(await wait(`location.pathname === "/admin/employees/disabled" && location.search.includes("filter=") && !document.querySelector("#employees-root [aria-busy=true]") && (document.querySelectorAll(${JSON.stringify(ROWS)}).length > 0 || /no |nothing|0 /i.test(document.querySelector("#employees-body")?.innerText || ""))`, 15000), `the real filtered list: ${await visibleText()}`);
    assert.doesNotMatch(await visibleText(), /Some filters or columns aren't valid|couldn't be loaded/, "the real backend accepts the filter");
    await noErrors("real backend");
  });
});
