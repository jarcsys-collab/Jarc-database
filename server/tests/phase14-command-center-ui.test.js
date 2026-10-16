// Phase 14 Command Center in the REAL app, in a headless browser (Chrome/Edge), on a role_based Entra test server
// (fake MongoDB): Ctrl K / Esc and focus return, accessible combobox + listbox, grouped server results (records and
// Updates), opening an Update on its record's Updates tab, filters with active chips and Clear filters, "Show more"
// pages, quick actions that respect editing rights, recents that are private per person and clearable, stale results
// reported plainly, light/dark themes and reduced motion, and no console errors. Screenshots go to
// JARC_SCREENSHOT_DIR when set (never committed). Skipped when no Chrome or Edge is installed.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort } = require("./support/headless-browser");

const BROWSER = findBrowser();
const SHOTS = process.env.JARC_SCREENSHOT_DIR || null;
const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "status", label: "Status", type: "status", options: ["To do", "Done"] },
  { key: "priority", label: "Priority", type: "priority", options: ["Low", "High"] },
  { key: "owner", label: "Owner", type: "owner" },
  { key: "notes", label: "Site notes", type: "text" }
];

describe("Phase 14: Command Center (real app, headless browser, role_based)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, admin, mia, vic, ws, secret, jobs, pumps, kestrel, temp;
  const OIDS = { admin: "0d0d0d0d-0000-4000-8000-000000001401", mia: "0d0d0d0d-0000-4000-8000-000000001402", vic: "0d0d0d0d-0000-4000-8000-000000001403" };
  const signIn = (b, who, name, isAdmin = false) => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${encodeURIComponent(name)}&email=${who}@example.invalid&admin=${isAdmin ? 1 : 0}&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const api = (b, method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const click = (b, sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`);
  const ctrlK = (b) => b.evaluate("(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))");
  const type = async (b, q) => {
    await b.evaluate(`(() => { const i = document.querySelector('[data-action=command-search]'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(150);
    assert.ok(await b.waitFor("!document.querySelector('.command-results .loading-spinner')", 8000), "search finished");
    await sleep(150);
  };
  const section = (b, name) => b.evaluate(`[...document.querySelectorAll('.command-results section[aria-label=${JSON.stringify(name)}] button[role=option][data-action^=palette], section[aria-label=${JSON.stringify(name)}] button[role=option][data-action=run-command]')].map((x) => [...x.querySelectorAll('strong, small')].map((e) => e.textContent.trim()).join(' '))`);
  const sections = (b) => b.evaluate("[...document.querySelectorAll('.command-results section')].map((s) => s.getAttribute('aria-label'))");
  const shot = async (b, name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const { result } = await b.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(result.data, "base64"));
  };
  // Console errors and uncaught exceptions on the page, collected from the moment the app opens.
  const watchErrors = (b) => b.evaluate("(() => { window.__errors = []; const e = console.error; console.error = (...a) => { window.__errors.push(a.map(String).join(' ')); e.apply(console, a); }; window.addEventListener('error', (ev) => window.__errors.push(String(ev.message))); window.addEventListener('unhandledrejection', (ev) => window.__errors.push(String(ev.reason))); })()");
  const openApp = async (b, { width = 1440, height = 900, motion = "no-preference" } = {}) => {
    await b.motionPreference(motion);
    await b.open(`${base}/`, { width, height });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "app shown");
    await watchErrors(b);
  };
  const openBoard = async (b, name) => {
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes(${JSON.stringify(name)}))?.click()`);
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table tbody tr td.cell')", 15000), `${name} loaded`);
    await sleep(300);
  };
  const palette = async (b) => { await ctrlK(b); assert.ok(await b.waitFor("document.activeElement?.dataset.action === 'command-search'", 3000), "palette open, input focused"); await sleep(200); };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore" });
    for (let i = 0; i < 100; i += 1) { try { await fetch(`${base}/api/v1/health`); break; } catch { await sleep(100); } }
    admin = await launch(BROWSER); mia = await launch(BROWSER); vic = await launch(BROWSER);
    for (const [b, who, name, isAdmin] of [[admin, "admin", "Ada Admin", true], [mia, "mia", "Mia Member"], [vic, "vic", "Vic Viewer"]]) { await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn(b, who, name, isAdmin); }
    ws = (await api(admin, "POST", "/workspaces", { name: "Field operations" })).body.workspace;
    secret = (await api(admin, "POST", "/workspaces", { name: "Board of directors" })).body.workspace;
    const miaId = (await api(mia, "GET", "/me")).body.user.id;
    await api(admin, "POST", `/workspaces/${ws.id}/members`, { userId: miaId, role: "MEMBER" });
    await api(admin, "POST", `/workspaces/${ws.id}/members`, { userId: (await api(vic, "GET", "/me")).body.user.id, role: "VIEWER" });
    jobs = (await api(admin, "POST", `/workspaces/${ws.id}/boards`, { name: "Service jobs", columns: COLUMNS })).body.board;
    pumps = (await api(admin, "POST", `/workspaces/${ws.id}/boards`, { name: "Pump register", columns: COLUMNS })).body.board;
    const hidden = (await api(admin, "POST", `/workspaces/${secret.id}/boards`, { name: "Salary review", columns: COLUMNS })).body.board;
    await api(admin, "POST", `/boards/${jobs.id}/records/batch`, { records: [
      { values: { serial: "JOB-1", status: "To do", priority: "High", owner: [`user:${miaId}`], notes: "Replace kestrel guard on roof" } },
      { values: { serial: "JOB-2", status: "Done", priority: "Low", notes: "Inspect boiler" } },
      { values: { serial: "Temporary job", status: "To do" } }] });
    await api(admin, "POST", `/boards/${pumps.id}/records/batch`, { records: Array.from({ length: 14 }, (_, i) => ({ values: { serial: `Pump unit ${String(i + 1).padStart(2, "0")}`, status: i % 2 ? "Done" : "To do" } })) });
    await api(admin, "POST", `/boards/${hidden.id}/records`, { values: { serial: "PAY-1", notes: "kestrel bonus confidential" } });
    const rows = (await api(admin, "GET", `/boards/${jobs.id}/records?limit=50`)).body.items;
    kestrel = rows.find((r) => r.values.serial === "JOB-2"); temp = rows.find((r) => r.values.serial === "Temporary job");
    await api(admin, "POST", `/records/${kestrel.id}/comments`, { body: "Crew saw a kestrel nest near the boiler flue" });
  });
  after(async () => { for (const b of [admin, mia, vic]) await b?.close(); server?.kill(); });

  test("Ctrl K opens an accessible dialog with focus in the search box; Esc closes it and focus returns; Ctrl K toggles", async () => {
    await openApp(mia);
    await mia.evaluate("document.querySelector('.global-search-button').focus()");
    await palette(mia);
    const a11y = await mia.evaluate("(() => { const i = document.querySelector('[data-action=command-search]'); return [document.querySelector('.command-modal').getAttribute('role'), document.querySelector('.command-modal').getAttribute('aria-modal'), i.getAttribute('role'), i.getAttribute('aria-controls'), document.querySelector('#command-results').getAttribute('role')]; })()");
    assert.deepEqual(a11y, ["dialog", "true", "combobox", "command-results", "listbox"]);
    assert.match(await mia.evaluate("document.querySelector('.global-search-button kbd').textContent"), /Ctrl K/);
    await shot(mia, "01-palette-empty-light");
    await mia.key("Escape");
    assert.ok(await mia.waitFor("!document.querySelector('.command-modal')", 2000), "Esc closes");
    assert.equal(await mia.evaluate("document.activeElement?.classList.contains('global-search-button')"), true, "focus returns to the search control");
    await palette(mia);
    await ctrlK(mia);
    assert.ok(await mia.waitFor("!document.querySelector('.command-modal')", 2000), "Ctrl K again closes it");
  });

  test("grouped server results with breadcrumbs; ↓ announces the highlighted option; an Update opens its record on the Updates tab", async () => {
    await openApp(mia);
    await palette(mia);
    await type(mia, "kestrel");
    const groups = await sections(mia);
    assert.ok(groups.includes("Records") && groups.includes("Updates"), JSON.stringify(groups));
    assert.match((await section(mia, "Records")).join("|"), /JOB-1 Site notes: Replace kestrel guard on roof · Service jobs · Field operations/);
    assert.match((await section(mia, "Updates")).join("|"), /Crew saw a kestrel nest.*Update by Ada Admin on JOB-2 · Service jobs · Field operations/);
    assert.doesNotMatch(await mia.evaluate("document.querySelector('.command-results').textContent"), /PAY-1|confidential|directors/, "AUTHORISATION");
    await shot(mia, "02-results-light");
    await mia.key("ArrowDown");
    const active = await mia.evaluate("(() => { const id = document.querySelector('[data-action=command-search]').getAttribute('aria-activedescendant'); const el = id && document.getElementById(id); return el ? [el.getAttribute('aria-selected'), el.classList.contains('keyboard-selected')] : null; })()");
    assert.deepEqual(active, ["true", true], "the highlighted result is announced");
    await click(mia, "section[aria-label=Updates] button[role=option]");
    assert.ok(await mia.waitFor("document.querySelector('.record-drawer')?.dataset.tab === 'updates'", 8000), "record drawer on Updates");
    assert.ok(await mia.waitFor("!!document.querySelector('.update-card.is-search-target')", 5000), "the update is highlighted");
    assert.equal(await mia.evaluate("[...document.querySelectorAll('.record-drawer input')].some((i) => i.value === 'JOB-2')"), true, "the right record");
    await mia.key("Escape");
  });

  test("filters: status and assignee from the board's own columns, active chips, Clear filters; Show more loads the next page", async () => {
    await openApp(mia);
    await palette(mia);
    await click(mia, "[data-action=cc-toggle-filters]");
    assert.ok(await mia.waitFor("!!document.querySelector('.cc-filter-panel')", 2000));
    const statusOptions = await mia.evaluate("[...document.querySelectorAll('[data-key=status] option')].map((o) => o.value).filter(Boolean)");
    assert.deepEqual(statusOptions, ["Done", "To do"]);
    await mia.evaluate("(() => { const s = document.querySelector('select[data-key=assignee]'); s.value = 'me'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await sleep(200); await mia.waitFor("!document.querySelector('.command-results .loading-spinner')", 8000); await sleep(150);
    assert.deepEqual((await section(mia, "Records")).map((t) => t.split(" ")[0]), ["JOB-1"], "assigned to me");
    assert.match(await mia.evaluate("document.querySelector('.cc-active').textContent"), /Assigned to me/);
    await shot(mia, "03-filters-light");
    await click(mia, "[data-action=cc-clear-filters]");
    await sleep(200);
    assert.equal(await mia.evaluate("!!document.querySelector('.cc-active')"), false, "Clear filters");
    await type(mia, "pump unit");
    assert.equal((await section(mia, "Records")).length, 10, "first page");
    assert.ok(await mia.evaluate("!!document.querySelector('[data-action=cc-more][data-type=record]')"), "Show more");
    await click(mia, "[data-action=cc-more][data-type=record]");
    assert.ok(await mia.waitFor("document.querySelectorAll('section[aria-label=Records] button[data-action=palette-record]').length === 14", 8000), "next page appended");
    const names = await section(mia, "Records");
    assert.equal(new Set(names).size, 14, "no duplicates");
    await mia.key("Escape");
  });

  test("quick actions: views and Create record only where they're available; viewers aren't offered editing", async () => {
    await openApp(mia); await openBoard(mia, "Service jobs");
    await palette(mia);
    await type(mia, "kanban");
    assert.ok(await mia.evaluate("!!document.querySelector('[data-command=\"view:kanban\"]')"));
    await click(mia, "[data-command='view:kanban']");
    assert.ok(await mia.waitFor("!!document.querySelector('.kanban, .kanban-board, [class*=kanban]')", 4000), "Kanban view shown");
    await palette(mia);
    await type(mia, "create record");
    assert.ok(await mia.evaluate("[...document.querySelectorAll('[data-command=new-record]')].some((b) => /Service jobs/.test(b.textContent))"), "Create record in the current editable board");
    await click(mia, "[data-command=new-record]");
    assert.ok(await mia.waitFor("!!document.querySelector('.record-drawer, form.record-form, [data-action=record-form]')", 4000), "opens the normal record form (nothing saved yet)");
    await mia.key("Escape");
    await openApp(vic); await openBoard(vic, "Service jobs");
    await palette(vic);
    await type(vic, "create");
    assert.equal(await vic.evaluate("!!document.querySelector('[data-command=new-record]')"), false, "a VIEWER isn't offered Create record");
    assert.equal(await vic.evaluate("!!document.querySelector('[data-command=new-board]')"), false);
    await type(vic, "appearance");
    await click(vic, "[data-command=appearance]");
    assert.ok(await vic.waitFor("!!document.querySelector('.settings-window') && /Appearance|Theme/.test(document.querySelector('#overlay-root').textContent)", 4000), "Appearance settings");
    await vic.key("Escape");
  });

  test("recents: private per person, resolved by the server, clearable; nothing kept in browser storage", async () => {
    await openApp(mia); await openBoard(mia, "Pump register");
    await sleep(500);
    await palette(mia);
    assert.ok(await mia.waitFor("/Pump register/.test(document.querySelector('section[aria-label=Recent]')?.textContent || '')", 5000), "the board just opened is listed");
    assert.equal(await mia.evaluate("JSON.stringify(Object.assign({}, localStorage)).includes('/me/recents') || /pump unit|kestrel/i.test(JSON.stringify(Object.assign({}, localStorage)))"), false, "no history or search text in browser storage");
    await openApp(vic); await palette(vic);
    await sleep(600);
    assert.doesNotMatch(await vic.evaluate("document.querySelector('.command-results').textContent"), /Pump register/, "another person's history is never shown");
    await vic.key("Escape");
    await click(mia, "[data-action=cc-clear-recents]");
    assert.ok(await mia.waitFor("!document.querySelector('section[aria-label=Recent]')", 4000), "history cleared");
    assert.deepEqual((await api(mia, "GET", "/me/recents")).body.items, []);
    await mia.key("Escape");
  });

  test("shared computer: when the session ends, open results close and Ctrl K can't reopen them over the sign-in gate", async () => {
    await openApp(mia); // no board opened here, so the next test starts from the same place as before
    await palette(mia);
    await type(mia, "kestrel");
    assert.ok((await section(mia, "Records")).some((t) => /JOB-1/.test(t)), "results shown while signed in");
    await mia.evaluate("window.dispatchEvent(new CustomEvent('jarc-session-expired'))");
    assert.ok(await mia.waitFor("!!document.querySelector('.entra-login') && !document.querySelector('.command-modal')", 4000), "gate shown, results gone");
    await ctrlK(mia); await sleep(300);
    assert.equal(await mia.evaluate("!!document.querySelector('.command-modal')"), false, "Ctrl K does nothing behind the gate");
    await mia.evaluate("document.querySelector('.entra-login')?.closest('body')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }))"); await sleep(200);
    assert.doesNotMatch(await mia.evaluate("document.body.textContent"), /kestrel|JOB-1|Service jobs|Pump register|Field operations/i, "nothing of the previous person is on screen");
  });

  test("stale results: a record deleted after it was found is reported, and no other record is opened", async () => {
    await openApp(mia);
    await palette(mia);
    await type(mia, "temporary");
    assert.ok((await section(mia, "Records")).some((t) => /Temporary job/.test(t)));
    const r = (await api(admin, "GET", `/records/${temp.id}`)).body.record;
    assert.equal((await api(admin, "DELETE", `/records/${temp.id}?expectedVersion=${r.version}`)).status, 200);
    await click(mia, "section[aria-label=Records] button[role=option]");
    assert.ok(await mia.waitFor("/deleted, or you no longer have access|no longer on this board/.test(document.querySelector('#toast-region').textContent)", 8000), "explained");
    assert.equal(await mia.evaluate("!!document.querySelector('.record-drawer')"), false, "no wrong record opened");
  });

  test("dark theme, custom accent and reduced motion keep the same design; no console errors", async () => {
    await openApp(mia, { motion: "reduce" });
    await mia.evaluate("(() => { document.documentElement.dataset.theme = 'dark'; })()");
    await palette(mia);
    await type(mia, "job");
    const styles = await mia.evaluate("(() => { const m = getComputedStyle(document.querySelector('.command-modal')); return [m.backgroundColor, m.borderTopLeftRadius, getComputedStyle(document.body).fontFamily, m.animationName, m.transitionDuration]; })()");
    assert.notEqual(styles[0], "rgb(255, 255, 255)", "dark surface");
    assert.ok(parseFloat(styles[1]) >= 12, "rounded dialog");
    assert.match(styles[2], /Poppins/);
    assert.ok(styles[3] === "none" && /^0s/.test(styles[4]), "no motion when reduced");
    await click(mia, "[data-action=cc-toggle-filters]");
    await shot(mia, "04-results-dark");
    await mia.key("Escape");
    await mia.evaluate("document.documentElement.dataset.theme = 'light'");
    for (const b of [mia, vic]) assert.deepEqual(await b.evaluate("window.__errors || []"), [], "no console errors");
  });
});
