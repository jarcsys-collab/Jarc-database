// People directory as a dedicated app module (AppModules "employees"), exactly like Fabric Data, in the REAL app in a headless
// Chrome/Edge: the JARC shell (Microsoft Entra test keys, JARC on its fake MongoDB, shared workspaces) with the REAL employees
// backend over the read-only fake directory source. Checks the module layout (no teal sidebar, workspace switch, board list or
// workspace name; global header kept; "Back to …" restores the workspace and board, else Home), direct links and reloads with
// no flash of the workspace layout and no workspace or board requests, Back / Forward, the profile / access / manage routes,
// viewer vs administrator, the outsider's denial, the normal workspace layout, the Directory panel (collapse, drawer, Escape,
// backdrop, focus), full-height content and 320–1920 px in light and dark. Synthetic data only; nothing leaves 127.0.0.1.
// EMP_LAYOUT_SHOTS=<folder>: also saves screenshots there; EMP_LAYOUT_SITE=<folder>: serves another copy of site/ (for a
// before / after comparison). Skipped without Chrome or Edge.
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
const ROWS = ".fabric-explorer-table tbody tr";
const SHOTS = process.env.EMP_LAYOUT_SHOTS || "";
const COLUMNS = [{ key: "serial", label: "Name", type: "text", required: true }, { key: "note", label: "Note", type: "text" }];
const DOCS = syntheticPeople(5).map((d, i) => {
  const [name, dept, enabled, type] = [["Synthetic Person 1", "Dept A", true, "Member"], ["Synthetic Person 2", null, true, "Member"], ["Synthetic Person 3", "Dept B", true, "Member"], ["Synthetic Person 4", "Dept A", false, "Member"], ["Synthetic Guest 5", null, true, "Guest"]][i];
  return { ...d, display_name: name, first_name: "Synthetic", last_name: name.split(" ").slice(1).join(" "), job_title: "Analyst", department: dept, office_location: null, account_enabled: enabled, user_type: type };
});
const ID = (n) => profileId(TEST_ID_KEY, DOCS[n - 1].user_id);

// The page records every API path it asks for, console errors, and the layout of each .app-shell drawn (from the first paint).
const RECORDER = `(() => {
  window.__errors = []; window.__api = []; window.__layouts = [];
  const oe = console.error.bind(console);
  console.error = (...a) => { window.__errors.push(a.map((x) => (x && x.stack) || String(x)).join(" ")); oe(...a); };
  addEventListener("error", (e) => window.__errors.push("uncaught: " + (e.message || e.type)));
  addEventListener("unhandledrejection", (e) => window.__errors.push("rejection: " + ((e.reason && e.reason.message) || e.reason)));
  const of = window.fetch.bind(window);
  window.fetch = (input, init) => { const url = typeof input === "string" ? input : input.url; window.__api.push(url.replace(/^https?:\\/\\/[^/]+/, "").split("?")[0]); return of(input, init); };
  let last = null;
  new MutationObserver(() => { const s = document.querySelector(".app-shell"); if (s && s !== last) { last = s; window.__layouts.push(s.getAttribute("data-layout") || "jarc"); } }).observe(document, { childList: true, subtree: true });
})();`;

describe("People directory module layout (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let issuer, persons, server, base, b, app, employees, signedInAs = null;
  const spaces = {}, boards = {};

  const wait = (expr, ms = 15000) => b.waitFor(expr, ms);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const json = async (expr) => JSON.parse(await b.evaluate(`JSON.stringify(${expr})`));
  const noErrors = async (label) => assert.deepEqual(await json("window.__errors || []"), [], `${label}: console errors`);
  const api = (method, url, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return JSON.stringify({ status: r.status, body: await r.json().catch(() => null) }); })()`).then(JSON.parse);
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const res = await b.send("Page.captureScreenshot", { format: "png" });
    if (res.result?.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(res.result.data, "base64"));
  };
  const setRole = async (role) => {
    if (signedInAs === role) return;
    await b.open(`${base}/api/v1/health`, DESKTOP);
    const nonce = await b.evaluate(`fetch("/api/v1/auth/sign-in/start", { method: "POST" }).then((r) => r.json()).then((s) => s.nonce)`);
    const idToken = await persons[role].idToken(nonce);
    assert.equal(await b.evaluate(`fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: ${JSON.stringify(idToken)} }) }).then((r) => r.status)`), 201, `sign-in as ${role}`);
    signedInAs = role;
  };
  const openPage = async (p, size = DESKTOP) => {
    await b.open(`${base}${p}`, size);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 20000), `${p}: app loaded`);
  };
  // What the shell shows now.
  const shell = () => json(`(() => {
    const s = document.querySelector(".app-shell"), side = document.querySelector("#sidebar"), r = side?.getBoundingClientRect(), ctx = document.querySelector(".top-context");
    return { layout: s?.getAttribute("data-layout") || "jarc", module: s?.getAttribute("data-module") || "", path: location.pathname,
      sidebarShown: Boolean(side && getComputedStyle(side).visibility !== "hidden" && r.right > 0 && r.width > 0),
      workspaceSwitch: !!document.querySelector(".workspace-switch"), boardTree: !!document.querySelector("#sidebar .nav-tree"),
      context: ctx?.innerText.replace(/\\s+/g, " ").trim() || "", exit: document.querySelector(".module-exit")?.getAttribute("title") || "",
      header: ["command-palette", "notifications", "profile-menu"].every((a) => !!document.querySelector('.topbar [data-action="' + a + '"]')),
      pageScrollY: document.documentElement.scrollHeight - document.documentElement.clientHeight, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      board: document.querySelector(".board-title-input")?.value ?? null };
  })()`);
  const inModule = async (label) => {
    assert.ok(await wait(`document.querySelector(".app-shell")?.getAttribute("data-module") === "employees"`), `${label}: module layout`);
    const s = await shell();
    assert.equal(s.layout, "module", label); assert.equal(s.sidebarShown, false, `${label}: teal sidebar hidden`);
    assert.equal(s.workspaceSwitch, false, `${label}: no workspace switch`); assert.equal(s.boardTree, false, `${label}: no board list`);
    assert.ok(s.header, `${label}: global header kept`);
    assert.doesNotMatch(s.context, /Synthetic (Alpha|Beta) Space/, `${label}: no workspace name in the breadcrumb`);
    assert.ok(s.pageScrollY <= 0, `${label}: no page scroll (${s.pageScrollY})`);
    return s;
  };
  // Profile menu → Developer → Administration → People directory (the window closes, the module opens).
  const openFromDeveloper = async () => {
    assert.ok(await click('.topbar [data-action="profile-menu"]'), "profile menu");
    assert.ok(await wait(`!!document.querySelector('#overlay-root [data-action="developer"]')`), "Developer in the profile menu");
    await click('#overlay-root [data-action="developer"]');
    assert.ok(await wait(`!!document.querySelector('.developer-window [data-action="apitok-admin"][data-target="employees"]')`), "Administration → People directory");
    await click('.developer-window [data-action="apitok-admin"][data-target="employees"]');
    assert.ok(await wait(`!document.querySelector(".developer-window")`), "Developer closed");
  };
  const jarcRequests = () => json(`window.__api.filter((p) => /^\\/api\\/v1\\/(workspaces|boards)(\\/|$)/.test(p))`);

  before(async () => {
    issuer = await createTokenIssuer();
    persons = { viewer: issuer.person("Synthetic Viewer"), admin: issuer.person("Synthetic Owner"), none: issuer.person("Synthetic Outsider", { admin: true }) };
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
      siteDir: process.env.EMP_LAYOUT_SITE || undefined,
      employees, repository: new MemoryStateRepository(), environment: "test", logger: { error() {}, warn() {} }, dataLayer,
      auth: { mode: "entra", entra, verify: createEntraVerifier({ ...entra, keySet: issuer.keySet }) },
      accessPolicy: "development_shared", betaOpenEditing: true,
      apiTokens: { key: crypto.randomBytes(32), adminObjectIds: [], issuePerHour: 1000, maxActive: 1000 }
    });
    server = await new Promise((resolve) => { const s = app.listen(port, "127.0.0.1", () => resolve(s)); });
    b = await launch(BROWSER);
    await b.motionPreference("reduce");
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });
    // Two shared workspaces with a board each (synthetic), made by the owner.
    await setRole("admin");
    for (const [key, name, board] of [["alpha", "Synthetic Alpha Space", "Synthetic Orders"], ["beta", "Synthetic Beta Space", "Synthetic Tickets"]]) {
      const w = await api("POST", "/api/v1/workspaces", { name });
      assert.equal(w.status, 201, `workspace ${name}`); spaces[key] = w.body.workspace.id;
      const bd = await api("POST", `/api/v1/workspaces/${spaces[key]}/boards`, { name: board, columns: COLUMNS });
      assert.equal(bd.status, 201, `board ${board}`); boards[key] = { id: bd.body.board.id, publicId: bd.body.board.publicId, name: board };
      assert.equal((await api("POST", `/api/v1/boards/${bd.body.board.id}/records/batch`, { records: [1, 2, 3].map((n) => ({ values: { serial: `${board} row ${n}`, note: `Note ${n}` } })) })).status, 201);
    }
  });
  after(async () => { await b?.close(); app?.locals.realtime?.closeAll(); await new Promise((r) => (server ? server.close(r) : r())); await employees?.close(); });

  test("1. owner: workspace layout unchanged; the People directory opens as a module; profile, /access and /manage keep it; Back restores the workspace and board", async () => {
    await setRole("admin");
    await openPage(`/boards/${boards.beta.publicId}`);
    assert.ok(await wait(`document.querySelector(".board-title-input")?.value === ${JSON.stringify(boards.beta.name)}`), "board open");
    const jarc = await shell();
    assert.equal(jarc.layout, "jarc"); assert.ok(jarc.sidebarShown, "workspace layout: sidebar shown"); assert.ok(jarc.workspaceSwitch && jarc.boardTree, "workspace switch and boards");
    assert.match(jarc.context, /Synthetic Beta Space/, "workspace layout: the breadcrumb names the workspace");
    await shot("after-1-workspace");
    assert.equal(await b.evaluate(`!!document.querySelector('#sidebar [data-screen="employees"]')`), false, "not in the main sidebar");
    await openFromDeveloper();
    let s = await inModule("entered");
    assert.equal(s.path, "/admin/employees/active");
    assert.equal(s.exit, `Back to ${boards.beta.name}`, "Back names the board");
    assert.match(s.context, /People directory/);
    assert.equal(await b.evaluate(`document.querySelectorAll('.sidebar-footer .nav-employees, .sidebar-footer [data-screen="employees"]').length`), 0, "no second People directory button above Settings");
    assert.ok(await wait(`document.querySelectorAll(${JSON.stringify(ROWS)}).length > 0`), "rows");
    // Full height: the app fills the module body; the grid scrolls inside it and its footer (pagination) is on screen.
    const fit = await json(`(() => { const a = document.querySelector("#employees-root").getBoundingClientRect(), t = document.querySelector(".topbar").getBoundingClientRect(), f = document.querySelector("#employees-root .fabric-pager")?.getBoundingClientRect(), g = document.querySelector("#employees-root .fabric-explorer-scroll"); return { top: Math.round(a.top), topbar: Math.round(t.bottom), bottom: Math.round(a.bottom), left: Math.round(a.left), right: Math.round(a.right), vw: document.documentElement.clientWidth, vh: innerHeight, pager: f ? Math.round(f.bottom) : null, gridOverflow: g ? getComputedStyle(g).overflowY : "", head: getComputedStyle(document.querySelector("#employees-root .fabric-explorer-table thead th")).position }; })()`);
    assert.ok(Math.abs(fit.bottom - fit.vh) <= 1 && fit.left <= 1 && Math.abs(fit.right - fit.vw) <= 1, `fills the viewport below the header ${JSON.stringify(fit)}`);
    assert.ok(fit.top >= fit.topbar - 1, "starts under the global header");
    assert.ok(fit.pager !== null && fit.pager <= fit.vh, "pagination on screen");
    assert.match(fit.gridOverflow, /auto|scroll/, "the grid scrolls inside"); assert.equal(fit.head, "sticky", "sticky table header");
    await shot("after-2-module");
    // Profile, then its /access and /manage addresses: the module layout stays.
    assert.ok(await click(`${ROWS} a[href*="/records/"]`), "a profile link");
    assert.ok(await wait(`/\\/records\\//.test(location.pathname)`), "profile route");
    await inModule("profile");
    await shot("after-3-profile");
    for (const tab of ["access", "manage"]) {
      await b.evaluate(`history.pushState(null, "", "/admin/employees/active/records/${ID(1)}/${tab}"); dispatchEvent(new PopStateEvent("popstate", { state: { jarcScreen: "employees" } }))`);
      await inModule(`/${tab}`);
      assert.equal((await shell()).exit, `Back to ${boards.beta.name}`, `/${tab}: the way back is kept`);
    }
    await shot("after-4-profile-access");
    assert.ok(await click(".module-exit"), "Back");
    assert.ok(await wait(`document.querySelector(".board-title-input")?.value === ${JSON.stringify(boards.beta.name)}`), "the board is back");
    s = await shell();
    assert.equal(await b.evaluate(`!!document.querySelector(".developer-window")`), false, "Developer is not reopened");
    assert.equal(s.layout, "jarc"); assert.ok(s.sidebarShown && s.workspaceSwitch, "workspace layout back");
    assert.match(s.context, /Synthetic Beta Space/, "its workspace is back"); assert.equal(s.path, `/boards/${boards.beta.publicId}`);
    await shot("after-5-returned");
    await noErrors("enter and exit");
  });

  test("2. Back / Forward between a board and the module; Back from a module entered by Back/Forward still returns to the board", async () => {
    await setRole("admin");
    await openPage(`/boards/${boards.alpha.publicId}`);
    assert.ok(await wait(`document.querySelector(".board-title-input")?.value === ${JSON.stringify(boards.alpha.name)}`), "board");
    await openFromDeveloper();
    await inModule("entered");
    await b.evaluate("history.back()");
    assert.ok(await wait(`document.querySelector(".board-title-input")?.value === ${JSON.stringify(boards.alpha.name)} && !document.querySelector(".app-shell[data-layout]")`), "Back: the board in the workspace layout");
    await b.evaluate("history.forward()");
    const s = await inModule("Forward");
    assert.equal(s.exit, `Back to ${boards.alpha.name}`, "Forward: the way back names the board");
    await click(".module-exit");
    assert.ok(await wait(`document.querySelector(".board-title-input")?.value === ${JSON.stringify(boards.alpha.name)}`), "Back to the board");
    await noErrors("history");
  });

  test("3. direct link and reload: the module from the first paint, no workspace or board requests; Back to JARC loads JARC; a missing board falls back to Home", async () => {
    await setRole("admin");
    await b.evaluate("sessionStorage.clear()");
    await openPage(`/admin/employees/active/records/${ID(2)}`);
    await inModule("direct link");
    assert.ok(await wait(`/\\/records\\//.test(location.pathname) && !!document.querySelector("#employees-root .emp-p, #employees-root [id^=emp-basic-title], #employees-root h2")`), "profile shown");
    assert.deepEqual([...new Set(await json("window.__layouts"))], ["module"], "never the workspace layout first");
    assert.deepEqual(await jarcRequests(), [], "no workspace or board requests");
    await b.send("Page.reload", {});
    assert.ok(await wait("!!document.querySelector('.app-shell')", 20000));
    await inModule("reload");
    assert.deepEqual([...new Set(await json("window.__layouts"))], ["module"], "reload: never the workspace layout first");
    assert.deepEqual(await jarcRequests(), [], "reload: no workspace or board requests");
    assert.equal((await shell()).exit, "Back to JARC");
    await click(".module-exit");
    assert.ok(await wait(`!document.querySelector(".app-shell[data-layout]") && !!document.querySelector(".workspace-switch")`), "Back to JARC: the workspace layout, with JARC loaded");
    assert.notEqual(await b.evaluate("location.pathname.startsWith('/admin/employees')"), true);
    // A remembered board that no longer exists (or isn't this person's any more): Home.
    await b.evaluate(`sessionStorage.setItem("jarc-module-return", JSON.stringify({ screen: "board", workspaceId: "nope", boardId: "000000000000000000000000", savedViewId: null }))`);
    await openPage("/admin/employees/active");
    await inModule("direct link with a stale way back");
    await click(".module-exit");
    assert.ok(await wait(`!document.querySelector(".app-shell[data-layout]") && location.pathname === "/" && !document.querySelector(".board-title-input")`), "fallback: Home");
    await noErrors("direct link");
  });

  test("4. viewer: the module without the administrators' lists; an admin address keeps the module with its 'administrators only' state", async () => {
    await setRole("viewer");
    await openPage("/admin/employees/active");
    await inModule("viewer");
    assert.ok(await wait(`document.querySelectorAll(${JSON.stringify(ROWS)}).length > 0`), "rows");
    assert.equal(await b.evaluate(`!!document.querySelector("#emp-obj-all, #emp-obj-disabled, #emp-obj-guests")`), false, "no admin lists");
    await openPage("/admin/employees/all");
    await inModule("viewer, admin list");
    assert.ok(await wait(`/administrators/i.test(document.querySelector("#employees-root")?.innerText || "")`), "administrators only");
    await noErrors("viewer");
  });

  test("5. outsider: the existing denial in the normal layout, no module, no directory request", async () => {
    await setRole("none");
    await openPage("/admin/employees/active");
    assert.ok(await wait(`/don't have access to the people directory/i.test(document.querySelector("#employees-root")?.innerText || "")`), "denied");
    assert.deepEqual([...new Set(await json("window.__layouts"))], ["jarc"], "never the module layout");
    assert.equal(await b.evaluate(`!!document.querySelector('[data-action="nav"][data-screen="employees"]')`), false, "no nav item");
    assert.deepEqual(await json(`window.__api.filter((p) => p.startsWith("/api/v1/admin/employees"))`), [], "nothing asked of the directory");
    await noErrors("outsider");
  });

  test("6. Directory panel like Fabric's Objects panel; 320–1920 px in light and dark: no overflow, controls on screen, drawer under the header", async () => {
    await setRole("viewer");
    for (const [width, height] of [[320, 640], [360, 740], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]]) {
      for (const theme of ["light", "dark"]) {
        const label = `${width}px ${theme}`;
        await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
        await openPage("/admin/employees/active", { width, height });
        await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
        assert.ok(await wait(`document.querySelectorAll(${JSON.stringify(ROWS)}).length > 0 || !!document.querySelector("#employees-root .fabric-card, #employees-root [data-record-card]")`), `${label}: rows`);
        const s = await inModule(label);
        assert.equal(s.sideways, 0, `${label}: no sideways page scroll`);
        const boxes = await json(`(() => { const vw = document.documentElement.clientWidth, vh = innerHeight, out = {}; for (const [k, sel] of Object.entries({ exit: ".module-exit", search: ".global-search-button", bell: ".notification-button", profile: ".profile-button", toggle: "#employees-objects-toggle", title: "#employees-title" })) { const el = document.querySelector(sel); const r = el?.getBoundingClientRect(); out[k] = r ? r.width > 0 && r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= vh + 1 : false; } return out; })()`);
        assert.deepEqual(Object.entries(boxes).filter(([, ok]) => !ok).map(([k]) => k), [], `${label}: controls clipped`);
        const narrow = await b.evaluate("matchMedia('(max-width: 1024px)').matches");
        if (narrow) {
          await click("#employees-objects-toggle");
          assert.ok(await wait(`document.querySelector("#employees-objects")?.getAttribute("aria-modal") === "true"`), `${label}: drawer`);
          const d = await json(`(() => { const r = document.querySelector("#employees-objects").getBoundingClientRect(), t = document.querySelector(".topbar").getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, header: t.bottom, vw: document.documentElement.clientWidth, vh: innerHeight }; })()`);
          assert.ok(d.top >= d.header - 1 && d.left >= -1 && d.right <= d.vw + 1 && d.bottom <= d.vh + 1, `${label}: drawer on screen under the header ${JSON.stringify(d)}`);
          assert.ok(await b.evaluate(`!!document.activeElement?.closest("#employees-objects")`), `${label}: focus moves into the drawer`);
          await b.key("Escape");
          assert.ok(await wait(`!document.querySelector("#employees-objects").classList.contains("is-drawer-open") && document.activeElement?.id === "employees-objects-toggle"`), `${label}: Escape closes, focus back`);
          await click("#employees-objects-toggle");
          assert.ok(await wait(`document.querySelector("#employees-objects").classList.contains("is-drawer-open")`));
          if (width === 360 || width === 768) await shot(`after-drawer-${width}-${theme}`);
          await click(".fx-objects__backdrop");
          assert.ok(await wait(`!document.querySelector("#employees-objects").classList.contains("is-drawer-open") && document.activeElement?.id === "employees-objects-toggle"`), `${label}: outside click closes, focus back`);
        } else {
          const open = await json(`document.querySelector("#employees-objects").getBoundingClientRect().width`);
          assert.ok(open > 120, `${label}: panel open`);
          await click('[data-action="emp-o-collapse"]');
          assert.ok(await wait(`document.querySelector("#employees-objects").classList.contains("is-collapsed") && Math.round(document.querySelector("#employees-objects").getBoundingClientRect().width) === 32`), `${label}: compact when collapsed`);
          await click('[data-action="emp-o-collapse"]');
          assert.ok(await wait(`!document.querySelector("#employees-objects").classList.contains("is-collapsed")`), `${label}: reopened`);
        }
        if (width === 360 || width === 1440) await shot(`after-module-${width}-${theme}`);
        const after = await shell();
        assert.equal(after.sideways, 0, `${label}: still no sideways scroll`); assert.ok(after.pageScrollY <= 0, `${label}: still no page scroll`);
      }
    }
    await noErrors("responsive");
  });

  test("7. Advanced Filters popover inside the viewport in the module (1440 px and 1024 px)", async () => {
    await setRole("viewer");
    for (const size of [DESKTOP, { width: 1024, height: 768 }]) {
      await openPage("/admin/employees/active", size);
      assert.ok(await wait(`document.querySelectorAll(${JSON.stringify(ROWS)}).length > 0`), "rows");
      await click('[data-action="fabric-x-filters"][data-ds="active"][data-focus-key="filters"]');
      assert.ok(await wait(`!!document.querySelector("#fabric-active-fb")`), "the popover opens");
      await new Promise((r) => setTimeout(r, 250));
      const m = await json(`(() => { const r = document.querySelector("#fabric-active-fb").getBoundingClientRect(), vw = document.documentElement.clientWidth; return { left: r.left, right: r.right, top: r.top, vw, vh: innerHeight }; })()`);
      assert.ok(m.left >= 0 && m.right <= m.vw && m.top >= 0, `${size.width}px: popover inside the viewport ${JSON.stringify(m)}`);
      await b.key("Escape");
    }
    await noErrors("popover");
  });
});
