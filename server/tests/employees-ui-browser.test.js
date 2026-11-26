// People directory in the REAL app, in a headless Chrome/Edge: the JARC shell (Microsoft Entra test keys, JARC on its fake
// MongoDB) with the People directory screen, its navigation, the explorer, grouping views, the profile, keyboard and the
// responsive / theme rules. The REAL employees backend is mounted: createApp({ employees }) with createEmployees over the
// read-only fake directory source (tests/support/employee-fake.js). Roles are real people in the employee lists: a viewer
// (EMPLOYEE_VIEWER_OIDS), an owner (EMPLOYEE_ADMIN_OIDS) and an outsider (JARC.Admin, not listed). The page only RECORDS the
// directory requests it makes (no stub). Synthetic data only; nothing leaves 127.0.0.1. Skipped without Chrome or Edge.
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
const { CHECK_MS } = require("../src/employees/snapshot");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./support/employee-fake");

const BROWSER = findBrowser();
const DESKTOP = { width: 1440, height: 900 };
const ROWS = ".fabric-explorer-table tbody tr";

// The synthetic directory (source documents for the fake source): 3 active members, 1 disabled member, 1 guest.
const DOCS = syntheticPeople(5).map((d, i) => {
  const [name, job, dept, office, enabled, type] = [
    ["Synthetic Person 1", "Analyst", "Dept A", "Office 1", true, "Member"], ["Synthetic Person 2", "Coordinator", null, null, true, "Member"],
    ["Synthetic Person 3", "Analyst", "Dept B", "Office 1", true, "Member"], ["Synthetic Person 4", "Analyst", "Dept A", null, false, "Member"],
    ["Synthetic Guest 5", null, null, null, true, "Guest"]
  ][i];
  return { ...d, display_name: name, first_name: "Synthetic", last_name: name.split(" ").slice(1).join(" "), job_title: job, department: dept, office_location: office, account_enabled: enabled, user_type: type, ...(type === "Guest" ? { user_principal_name: `person${i + 1}_example.com#EXT#@tenant.example.com` } : {}) };
});
const ID = (n) => profileId(TEST_ID_KEY, DOCS[n - 1].user_id);

// The page only records its directory requests and its console errors (no stub: every answer is the real backend's).
const RECORDER = `(() => {
  window.__errors = []; window.__emp = [];
  const oe = console.error.bind(console);
  console.error = (...a) => { window.__errors.push(a.map((x) => (x && x.stack) || String(x)).join(" ")); oe(...a); };
  addEventListener("error", (e) => window.__errors.push("uncaught: " + (e.message || e.type)));
  addEventListener("unhandledrejection", (e) => window.__errors.push("rejection: " + ((e.reason && e.reason.message) || e.reason)));
  const of = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url, rel = url.replace(/^https?:\\/\\/[^/]+/, "");
    if (rel.startsWith("/api/v1/admin/employees")) window.__emp.push(rel);
    return of(input, init);
  };
})();`;

describe("People directory in the real app (headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let issuer, persons, server, base, b, app, employees, fake, clockOffset = 0, signedInAs = null;

  before(async () => {
    issuer = await createTokenIssuer();
    // viewer2 takes over the long responsive test (per-person rate limits stay in force).
    persons = { viewer: issuer.person("Synthetic Viewer"), viewer2: issuer.person("Synthetic Viewer Two"), admin: issuer.person("Synthetic Owner"), none: issuer.person("Synthetic Outsider", { admin: true }) };
    const port = await freePort();
    base = `http://localhost:${port}`;
    const entra = { ...issuer.config, redirectUri: `${base}/`, appOrigin: base };
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => new FakeMongoClient() });
    await connection.connect();
    await ensureDatabase(connection.db);
    const dataLayer = createDataLayer({ connection, logger: { error() {} }, fileStore: new MemoryFileStore(), environment: "test" });
    const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: issuer.config.tenantId, viewerObjectIds: [persons.viewer.oid, persons.viewer2.oid], adminObjectIds: [persons.admin.oid] }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
    fake = new EmployeeFakeClient({ docs: DOCS });
    employees = createEmployees({ config, createClient: () => fake, idKey: TEST_ID_KEY, logger: { info() {}, warn() {}, error() {} }, now: () => Date.now() + clockOffset });
    app = createApp({
      employees,
      repository: new MemoryStateRepository(), environment: "test", logger: { error() {}, warn() {} }, dataLayer,
      auth: { mode: "entra", entra, verify: createEntraVerifier({ ...entra, keySet: issuer.keySet }) },
      accessPolicy: "development_shared", betaOpenEditing: true,
      apiTokens: { key: crypto.randomBytes(32), adminObjectIds: [], issuePerHour: 1000, maxActive: 1000 }
    });
    server = await new Promise((resolve) => { const s = app.listen(port, "127.0.0.1", () => resolve(s)); });
    b = await launch(BROWSER);
    await b.motionPreference("reduce");
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });
  });
  after(async () => { await b?.close(); app?.locals.realtime?.closeAll(); await new Promise((r) => (server ? server.close(r) : r())); await employees?.close(); });

  const wait = (expr, ms = 10000) => b.waitFor(expr, ms);
  const has = (sel) => b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const json = async (expr) => JSON.parse(await b.evaluate(`JSON.stringify(${expr})`));
  const noErrors = async (label) => assert.deepEqual(await json("window.__errors || []"), [], `${label}: console errors`);
  const sideways = () => b.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  const visibleText = () => b.evaluate(`document.querySelector("#employees-root")?.innerText || ""`);
  const box = (sel) => json(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = innerHeight; return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), inside: r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= vh + 1 }; })()`);
  // A real sign-in (the Microsoft flow's nonce → ID token → session) as the person for this role: "viewer" | "viewer2" |
  // "admin" | "none" (signed in, JARC.Admin, not in either employee list). The new session cookie replaces the old one.
  const setRole = async (role) => {
    if (signedInAs === role) return;
    await b.open(`${base}/api/v1/health`, DESKTOP);
    const nonce = await b.evaluate(`fetch("/api/v1/auth/sign-in/start", { method: "POST" }).then((r) => r.json()).then((s) => s.nonce)`);
    const idToken = await persons[role].idToken(nonce);
    assert.equal(await b.evaluate(`fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: ${JSON.stringify(idToken)} }) }).then((r) => r.status)`), 201, `sign-in as ${role}`);
    signedInAs = role;
  };
  // Directory states from the real snapshot: "stale" (a check failed after a good load) | "unavailable" (no snapshot) | "".
  const setMode = async (mode) => {
    const s = employees.snapshot;
    if (mode === "stale") { fake.down = true; clockOffset += CHECK_MS + 1000; await s.refresh(); assert.equal(s.meta().stale, true); }
    else if (mode === "unavailable") { fake.down = true; s.snap = null; s.attemptAt = Date.now() + clockOffset; } // test-only: drop the snapshot
    else {
      // A check started while the source was down may still be in flight: let it finish, then load again.
      fake.down = false;
      clockOffset += 11000; // past the connection's 10 s fail-fast window after a failed attempt (connection.js RETRY_AFTER_MS)
      for (let i = 0; i < 3 && (!s.snap || s.meta().stale); i += 1) { if (s.inFlight) await s.inFlight.catch(() => {}); s.attemptAt = null; await s.refresh(); }
      assert.ok(s.snap && !s.meta().stale, "directory restored");
    }
  };
  // Developer → Administration → People directory is offered (profile menu); leaves the menu or window closed.
  const developerOffers = async () => {
    await click('.topbar [data-action="profile-menu"]');
    if (!(await wait(`!!document.querySelector("#overlay-root .profile-popover")`, 5000))) return false;
    if (!(await has('#overlay-root [data-action="developer"]'))) { await click('.topbar [data-action="profile-menu"]'); return false; }
    await click('#overlay-root [data-action="developer"]');
    await wait(`!!document.querySelector(".developer-window")`, 5000);
    return Boolean(await has('.developer-window [data-action="apitok-admin"][data-target="employees"]'));
  };
  // Opens JARC at / and goes to the People directory from Developer → Administration (it isn't in the main sidebar).
  const openDirectory = async (size = DESKTOP) => {
    await b.open(`${base}/`, size);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 20000), "app loaded");
    assert.equal(await has('#sidebar [data-screen="employees"]'), false, "not in the main sidebar");
    assert.ok(await developerOffers(), "People directory in Developer → Administration");
    await click('.developer-window [data-action="apitok-admin"][data-target="employees"]');
    assert.ok(await wait(`location.pathname === "/admin/employees/active" && document.querySelectorAll(${JSON.stringify(ROWS)}).length > 0`, 15000), "the Active accounts list");
  };
  const go = async (path) => { await b.evaluate(`history.pushState({ jarcScreen: "home" }, "", ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent("popstate", { state: { jarcScreen: "home" } }))`); };

  test("1. viewer: nav item, heading, list, grouping, filtered list, profile and back; no Fabric wording; nothing stored", async () => {
    await setRole("viewer");
    await openDirectory();
    assert.equal(await b.evaluate(`document.querySelector(".app-shell")?.getAttribute("data-module")`), "employees", "opened in its module layout");
    assert.match(await b.evaluate(`document.querySelector("#employees-title").textContent`), /^People directory$/);
    assert.match(await b.evaluate(`document.querySelector("#employees-subtitle").textContent`), /^JARC administration · Source: Microsoft Entra ID snapshot · updated .*2026/);
    const text = await visibleText();
    assert.doesNotMatch(text, /Fabric/i, "no Fabric wording");
    assert.doesNotMatch(text, /Showing all dates|other dates/i, "no date-window wording (the directory has none)");
    assert.equal(await b.evaluate(`document.querySelectorAll('#employees-root [data-action="emp-refresh"], #employees-root [data-action="fabric-refresh"]').length`), 1, "one Refresh on the list");
    assert.match(text, /Synthetic Person 1/); assert.doesNotMatch(text, /Synthetic Person 4|Synthetic Guest 5/, "the active list only");
    for (const ds of ["all", "disabled", "guests"]) assert.equal(await has(`#emp-obj-${ds}`), false, `no ${ds} for a viewer`);
    assert.deepEqual(await json(`[...document.querySelectorAll(".fabric-explorer-table thead th")].map((th) => th.textContent.replace(/[▲▼▾]|2nd|3rd/g, "").trim().split(/\\s{2,}|,/)[0])`).then((a) => a.slice(0, 2)), ["Name", "Job title"]);
    const calls = await json("window.__emp");
    assert.ok(calls.some((c) => c.startsWith("/api/v1/admin/employees/active/records?")));
    assert.ok(!calls.some((c) => c.startsWith("/api/v1/fabric")));

    // Group by Department: counts, Unassigned; a value opens the filtered list.
    await click("#emp-obj-group-department");
    assert.ok(await wait(`location.pathname === "/admin/employees/groups/department" && !!document.querySelector(".emp-group__table")`), "grouping view");
    const groups = await json(`[...document.querySelectorAll(".emp-group__table tbody tr")].map((tr) => [tr.querySelector("th").textContent.trim(), tr.querySelector("td").textContent.trim()])`);
    assert.deepEqual(groups.sort(), [["Dept A", "1"], ["Dept B", "1"], ["Unassigned", "1"]]);
    await click('[data-action="emp-group-open"][data-value="Dept A"]');
    assert.ok(await wait(`location.pathname === "/admin/employees/active" && location.search.includes("filter=") && document.querySelectorAll(${JSON.stringify(ROWS)}).length === 1`), "filtered by Department = Dept A");
    assert.ok(await has(".fx-filterbar__clear"), "Clear filters shows with a filter applied");
    await click(".fx-filterbar__clear");
    assert.ok(await wait(`document.querySelectorAll(${JSON.stringify(ROWS)}).length === 3`), "cleared");

    // Profile, Escape back to the list with focus on the row's link.
    await click(`[data-action="fabric-x-open"][data-id="${ID(1)}"]`);
    assert.ok(await wait(`location.pathname === "/admin/employees/active/records/${ID(1)}" && !!document.querySelector("#employees-root .emp-profile")`), "profile shown");
    assert.doesNotMatch(await visibleText(), /\+00|Synthetic Company/, "no phones or company from the source");
    assert.match(await visibleText(), /Phone numbers are not available in this directory view/);
    assert.ok(await wait(`document.activeElement?.id === "emp-p-title-active"`), "focus on the profile heading");
    await b.key("Escape");
    assert.ok(await wait(`location.pathname === "/admin/employees/active" && document.querySelectorAll(${JSON.stringify(ROWS)}).length === 3`), "Escape: back to the list");
    assert.ok(await wait(`document.activeElement?.dataset?.id === "${ID(1)}"`), "focus back on the row");

    const stored = await b.evaluate(`JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])`);
    assert.doesNotMatch(stored, /Synthetic Person|example\.com|Dept A/, "no directory value in browser storage");
    for (let n = 1; n <= 5; n += 1) assert.ok(!stored.includes(ID(n)), "no profile ID in browser storage");
    const idb = await b.evaluate(`(indexedDB.databases ? indexedDB.databases() : Promise.resolve([])).then((d) => JSON.stringify(d.map((x) => x.name)))`);
    assert.doesNotMatch(idb, /employee/i);
    await noErrors("viewer");
  });

  test("2. viewer: a typed admin address (in-app and as a direct URL) shows 'administrators only' and asks nothing for it; admin: the admin lists open", async () => {
    await setRole("viewer");
    await openDirectory();
    const before = (await json("window.__emp")).length;
    await go("/admin/employees/disabled");
    assert.ok(await wait(`!!document.querySelector("#employees-root .emp-admin-only")`), "administrators-only state");
    assert.match(await visibleText(), /Administrators only\nThis list is only for directory administrators\./);
    assert.doesNotMatch(await visibleText(), /have access to the people directory|Synthetic/);
    assert.ok(!(await json("window.__emp")).slice(before).some((c) => c.includes("/disabled")), "nothing requested for it");
    // Its button opens Active accounts.
    await click('#employees-root [data-action="emp-open-active"]');
    assert.ok(await wait(`location.pathname === "/admin/employees/active" && document.querySelectorAll(${JSON.stringify(ROWS)}).length === 3`), "Open Active accounts");

    // The same as a direct URL (a fresh page load served by the server), and a disabled account's profile link.
    for (const path of ["/admin/employees/disabled", `/admin/employees/disabled/records/${ID(4)}`, `/admin/employees/active/records/${ID(4)}`]) {
      await b.open(`${base}${path}`, DESKTOP);
      assert.ok(await wait("!!document.querySelector('.app-shell')", 20000), `${path}: app loaded`);
      if (path.startsWith("/admin/employees/disabled")) {
        assert.ok(await wait(`!!document.querySelector("#employees-root .emp-admin-only")`, 15000), `${path}: administrators-only state`);
        assert.match(await visibleText(), /This list is only for directory administrators\./, path);
        assert.ok(!(await json("window.__emp")).some((c) => c.includes("/disabled")), `${path}: nothing requested for it`);
      } else {
        // An active-dataset link to an account outside it: the server answers 404, like an unknown ID.
        assert.ok(await wait(`/not found|isn't available|doesn't exist|no longer/i.test(document.querySelector("#employees-root")?.innerText || "") || !!document.querySelector("#employees-root .emp-denied, #employees-root .fx-error, #employees-root [role=alert]")`, 15000), `${path}: not-found state: ${await visibleText()}`);
      }
      assert.doesNotMatch(await visibleText(), /Synthetic Person 4|Synthetic Guest 5|Dept A/, `${path}: no data`);
    }

    await setRole("admin");
    await openDirectory();
    for (const ds of ["all", "disabled", "guests"]) assert.ok(await has(`#emp-obj-${ds}`), `${ds} listed for an admin`);
    await click("#emp-obj-disabled");
    assert.ok(await wait(`location.pathname === "/admin/employees/disabled" && document.querySelectorAll(${JSON.stringify(ROWS)}).length === 1`), "Disabled accounts");
    assert.match(await visibleText(), /Synthetic Person 4/);
    await noErrors("admin");
  });

  test("3. not listed: no nav item; the address shows only the no-access state", async () => {
    await setRole("none");
    await b.open(`${base}/`, DESKTOP);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 20000));
    assert.equal(await developerOffers(), false, "no People directory entry");
    await b.open(`${base}/`, DESKTOP); assert.ok(await wait("!!document.querySelector('.app-shell')", 20000));
    await go("/admin/employees/active");
    assert.ok(await wait(`!!document.querySelector("#employees-root .emp-denied")`), "no-access state");
    assert.match(await visibleText(), /No access\nYou don't have access to the people directory\./, "title and text apart");
    assert.equal((await json("window.__emp")).length, 0, "no directory request");
    assert.doesNotMatch(await visibleText(), /Synthetic/);
    // Direct URLs (fresh page loads): the nav item stays hidden and only the no-access state shows.
    for (const path of ["/admin/employees", "/admin/employees/active", `/admin/employees/active/records/${ID(1)}`, "/admin/employees/groups/department"]) {
      await b.open(`${base}${path}`, DESKTOP);
      assert.ok(await wait("!!document.querySelector('.app-shell')", 20000), `${path}: app loaded`);
      assert.ok(await wait(`!!document.querySelector("#employees-root .emp-denied")`, 15000), `${path}: no-access state`);
      assert.equal(await has('[data-screen="employees"], [data-action="apitok-admin"][data-target="employees"]'), false, `${path}: no entry`);
      assert.doesNotMatch(await visibleText(), /Synthetic Person|Dept A/, `${path}: no data`);
      const calls = await json("window.__emp");
      assert.equal(calls.length, 0, `${path}: no directory request (${calls.join(", ")})`);
    }
    // And the server refuses it anyway (a request made by hand from this signed-in page).
    assert.equal(await b.evaluate(`fetch("/api/v1/admin/employees/active/records/${ID(1)}").then((r) => r.status)`), 403);
    await noErrors("not listed");
  });

  test("3b. admin: a deep link to a profile works on a fresh load and after a reload", async () => {
    await setRole("admin");
    for (const [path, name] of [[`/admin/employees/disabled/records/${ID(4)}`, "Synthetic Person 4"], [`/admin/employees/guests/records/${ID(5)}`, "Synthetic Guest 5"], [`/admin/employees/active/records/${ID(3)}`, "Synthetic Person 3"]]) {
      for (const pass of ["load", "reload"]) {
        if (pass === "load") await b.open(`${base}${path}`, DESKTOP);
        else { await b.evaluate("location.reload()"); await wait("document.readyState === 'complete'", 10000); }
        assert.ok(await wait(`location.pathname === ${JSON.stringify(path)} && !!document.querySelector("#employees-root .emp-profile")`, 20000), `${path} (${pass}): profile shown`);
        assert.ok(await wait(`(document.querySelector("#employees-root")?.innerText || "").includes(${JSON.stringify(name)})`, 10000), `${path} (${pass}): ${name}`);
        assert.match(await visibleText(), /Phone numbers are not available in this directory view/);
      }
    }
    await noErrors("deep links");
  });

  test("3c. viewer: Back to list from a profile opened by its address puts focus on that row once the list loads", async () => {
    await setRole("viewer");
    await b.open(`${base}/admin/employees/active/records/${ID(3)}`, DESKTOP);
    assert.ok(await wait(`!!document.querySelector("#employees-root .emp-profile") && (document.querySelector("#employees-root")?.innerText || "").includes("Synthetic Person 3")`, 20000), "profile shown");
    assert.match(await visibleText(), /updated .+ UTC\. Read-only/, "the snapshot time in UTC");
    assert.equal(await has('#employees-root [data-action="emp-refresh"]'), true, "the heading's Refresh on a profile (it has no toolbar)");
    await click('#employees-root [data-action="emp-p-back"]');
    assert.ok(await wait(`location.pathname === "/admin/employees/active" && document.querySelectorAll(${JSON.stringify(ROWS)}).length === 3`, 15000), "the list");
    assert.ok(await wait(`document.activeElement?.dataset?.id === "${ID(3)}"`, 10000), `focus on the row (now ${await b.evaluate("document.activeElement?.tagName + '#' + document.activeElement?.id")})`);
    await noErrors("direct profile back");
  });

  test("4. stale snapshot banner; unavailable directory (real snapshot states)", async () => {
    await setRole("viewer");
    await setMode("stale");
    try {
      await openDirectory();
      assert.ok(await wait(`!!document.querySelector("#employees-status .emp-stale")`), "stale banner");
      await setMode("unavailable");
      await b.open(`${base}/admin/employees/active`, DESKTOP);
      assert.ok(await wait(`/The directory is temporarily unavailable\\./.test(document.querySelector("#employees-root")?.innerText || "")`), "unavailable state");
      assert.doesNotMatch(await visibleText(), /Synthetic Person/);
    } finally { await setMode(""); }
    await noErrors("states");
  });

  test("5. 320–1920 px in light and dark: no sideways scroll, navigation panel or drawer (Tab trap, Escape, focus back)", async () => {
    await setRole("viewer2");
    const out = [];
    for (const [width, height] of [[320, 640], [390, 844], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]]) {
      for (const theme of ["light", "dark"]) {
        const label = `${width}px ${theme}`;
        await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
        await openDirectory({ width, height });
        await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
        assert.equal(await sideways(), 0, `${label}: sideways scroll`);
        const bg = await b.evaluate(`getComputedStyle(document.querySelector("#employees-root")).backgroundColor`);
        // Optional review screenshots (JARC_EMP_SCREENSHOTS=<folder>): synthetic data only.
        if (process.env.JARC_EMP_SCREENSHOTS) { const shot = await b.send("Page.captureScreenshot", { format: "png" }); if (shot.result?.data) { require("fs").mkdirSync(process.env.JARC_EMP_SCREENSHOTS, { recursive: true }); require("fs").writeFileSync(require("path").join(process.env.JARC_EMP_SCREENSHOTS, `${width}-${theme}.png`), Buffer.from(shot.result.data, "base64")); } }
        out.push({ label, bg });
        assert.ok((await box("#employees-objects-toggle"))?.inside, `${label}: navigation button on screen`);
        const narrow = await b.evaluate("matchMedia('(max-width: 1024px)').matches");
        if (narrow) {
          await click("#employees-objects-toggle");
          assert.ok(await wait(`document.querySelector("#employees-objects")?.getAttribute("aria-modal") === "true"`), `${label}: modal drawer`);
          const drawer = await box("#employees-objects");
          assert.ok(drawer?.inside, `${label}: drawer on screen ${JSON.stringify(drawer)}`);
          for (let i = 0; i < 10; i += 1) { await b.key("Tab"); assert.ok(await b.evaluate(`!!document.activeElement?.closest("#employees-objects")`), `${label}: Tab stays in the drawer (${i})`); }
          await b.key("Escape");
          assert.ok(await wait(`!document.querySelector("#employees-objects").classList.contains("is-drawer-open") && document.activeElement?.id === "employees-objects-toggle"`), `${label}: Escape closes, focus back`);
          await click("#employees-objects-toggle"); await wait(`document.querySelector("#employees-objects").classList.contains("is-drawer-open")`);
          await click("#emp-obj-group-officeLocation");
          assert.ok(await wait(`location.pathname === "/admin/employees/groups/officeLocation" && !document.querySelector("#employees-objects").classList.contains("is-drawer-open")`), `${label}: a choice closes the drawer`);
        } else {
          assert.ok((await box("#employees-objects"))?.inside, `${label}: navigation panel shown`);
        }
        assert.equal(await sideways(), 0, `${label}: still no sideways scroll`);
      }
    }
    const light = out.filter((o) => o.label.endsWith("light")).map((o) => o.bg), dark = out.filter((o) => o.label.endsWith("dark")).map((o) => o.bg);
    assert.notEqual(light[0], dark[0], "the dark theme applies");
    await noErrors("responsive");
  });
});
