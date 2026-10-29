// Account Management (Phase M4.3) in the REAL app, in a headless browser, against the test Entra server (local test
// keys, fake MongoDB): the pending sign-in gate, claiming the first Super Admin with a typed confirmation, Settings →
// Account Management (search, filters, status chips), approving an account with a confirmation, the mobile card
// layout, and the "roles are not enforced" warning while beta access is still on. Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const OIDS = { root: "0c7c7c7c-0000-4000-8000-000000000081", emp: "0d7d7d7d-0000-4000-8000-000000000082" };

describe("Phase M4.3: Account Management (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let enforced, staged, b;
  const start = async (env) => {
    const port = await freePort(), base = `http://localhost:${port}`;
    const proc = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore", env: { ...process.env, JARC_TEST_BETA: "1", JARC_TEST_SUPER_ADMIN_OID: OIDS.root, ...env } });
    await waitForServer(base, { child: proc });
    return { proc, base };
  };
  const signIn = (who, name, admin) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${encodeURIComponent(name)}&email=${who}@example.invalid&admin=${admin ? 1 : 0}&nonce=" + encodeURIComponent(s.nonce))).json(); const r = await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); return r.status; })()`);
  const text = (sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent || ""`);
  const has = (sel) => b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const wait = (expr, ms = 10000) => b.waitFor(expr, ms);
  const fill = (sel, value) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); return true; })()`);
  const submit = (sel) => b.evaluate(`(() => { const f = document.querySelector(${JSON.stringify(sel)}); if (!f) return false; f.requestSubmit(); return true; })()`);
  const openAccounts = async () => {
    assert.ok(await wait("!!document.querySelector('.app-shell')", 15000), "app loaded");
    // The first click can land while the app is still settling after sign-in: try again until Settings is open.
    let listed = false;
    for (let i = 0; i < 4 && !listed; i++) { if (!(await has(".settings-window"))) await click('[data-action="settings"]'); listed = await wait("!!document.querySelector('.settings-window [data-section=\"accounts\"]')", 3000); }
    assert.ok(listed, "Account Management section listed");
    await click('.settings-window [data-section="accounts"]');
    assert.ok(await wait("!!document.querySelector('#accounts-root .account-table, #accounts-root .account-claim')"), "accounts loaded");
  };

  before(async () => {
    enforced = await start({ JARC_TEST_ACCOUNTS: "enforced" });
    b = await launch(BROWSER);
    await b.motionPreference("reduce");
  });
  after(async () => { await b?.close(); enforced?.proc?.kill(); staged?.proc?.kill(); });

  test("enforced: a new employee waits for approval; the configured administrator claims Super Admin, then approves them", async () => {
    const base = enforced.base;
    await b.open(`${base}/api/v1/health`, { width: 1440, height: 900 });
    assert.equal(await signIn("emp", "Emma Employee", false), 201);
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.ok(await wait("document.querySelector('.entra-login')?.dataset.state === 'pending'", 15000), "pending gate");
    assert.match(await text(".entra-login h1"), /Waiting for approval/);
    assert.equal(await has('[data-action="acct-claim"]'), false, "an ordinary employee can't claim anything");
    const stats = JSON.parse(await b.evaluate("fetch('/__test/stats').then((r) => r.text())"));
    assert.deepEqual(stats.withoutSession, []);

    // The configured administrator (JARC.Admin): pending too (new account), with the explicit claim.
    assert.equal(await signIn("root", "Root Admin", true), 201);
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.ok(await wait("!!document.querySelector('[data-action=\"acct-claim\"]')", 15000), "claim offered");
    await click('[data-action="acct-claim"]');
    assert.ok(await wait("!!document.querySelector('.account-confirm input[name=phrase]')"), "typed confirmation");
    await fill(".account-confirm input[name=phrase]", "I AM THE SUPER ADMIN");
    await submit(".account-confirm");
    assert.ok(await wait("!!document.querySelector('.app-shell')", 15000), "app opens as Super Admin");

    await openAccounts();
    assert.match(await text("#accounts-root .account-alert"), /Roles are enforced/);
    assert.match(await text("#accounts-root .account-alert"), /JARC_BETA_OPEN_EDITING=true/);
    assert.match(await text("#accounts-root .account-table"), /Emma Employee/);
    assert.match(await text("#accounts-root .account-table"), /Pending approval/);
    // Search and filters.
    await fill('[data-action="acct-search"]', "zzz");
    assert.ok(await wait("/No accounts match/.test(document.querySelector('#accounts-root').textContent)"));
    await fill('[data-action="acct-search"]', "");
    await fill('select[data-key="status"]', "pending");
    assert.ok(await wait("document.querySelectorAll('#accounts-root tbody tr').length === 1"));
    assert.doesNotMatch(await text("#accounts-root"), /0c7c7c7c|0d7d7d7d|csrf/i, "no identity IDs or tokens on the page");

    // Review → approve as Viewer, confirmed.
    await click('[data-action="acct-open"]');
    assert.ok(await wait("!!document.querySelector('.account-modal [data-action=\"acct-approve-form\"]')"), "account dialog");
    await fill('.account-modal select[name="role"]', "VIEWER");
    await submit('.account-modal [data-action="acct-approve-form"]');
    assert.ok(await wait("!!document.querySelector('.account-confirm')"), "confirmation");
    assert.equal(await has(".account-confirm input[name=phrase]"), false, "no typed phrase for an ordinary approval");
    await submit(".account-confirm");
    assert.ok(await wait("/Active/.test(document.querySelector('.account-modal')?.textContent || '')"), "approved");
    assert.match(await text(".account-modal .account-history"), /Approved/);
    assert.match(await text(".account-modal .account-history"), /by Root Admin/);
    // Blocking needs the typed phrase.
    await click('.account-modal [data-action="acct-block"]');
    assert.ok(await wait("!!document.querySelector('.account-confirm input[name=phrase]')"), "block needs BLOCK");
    await click('[data-action="acct-cancel"]');
    assert.ok(await wait("!!document.querySelector('.account-modal')"), "back to the account");
  });

  test("mobile: the account list becomes cards without horizontal scrolling", async () => {
    await b.open(`${enforced.base}/`, { width: 390, height: 844 });
    await openAccounts();
    const layout = JSON.parse(await b.evaluate(`JSON.stringify({ head: getComputedStyle(document.querySelector('.account-table thead')).position, row: getComputedStyle(document.querySelector('.account-table tr')).display, overflow: document.querySelector('.settings-body, .settings-content')?.scrollWidth - document.querySelector('.settings-body, .settings-content')?.clientWidth })`));
    assert.equal(layout.head, "absolute");
    assert.equal(layout.row, "block");
    assert.ok(layout.overflow <= 1, `no horizontal overflow (${layout.overflow})`);
  });

  test("staged: the page says plainly that roles are not enforced while beta access lets everyone edit", async () => {
    staged = await start({ JARC_TEST_ACCOUNTS: "staged" });
    await b.open(`${staged.base}/api/v1/health`, { width: 1440, height: 900 });
    assert.equal(await signIn("root", "Root Admin", true), 201);
    await b.open(`${staged.base}/`, { width: 1440, height: 900 });
    await openAccounts();
    assert.ok(await has(".account-claim"), "claim offered in Settings");
    await click('[data-action="acct-claim"]');
    await wait("!!document.querySelector('.account-confirm input[name=phrase]')");
    await fill(".account-confirm input[name=phrase]", "I AM THE SUPER ADMIN");
    await submit(".account-confirm");
    assert.ok(await wait("!!document.querySelector('.app-shell')", 15000));
    await openAccounts();
    const notice = await text("#accounts-root .account-alert");
    assert.match(notice, /Observation mode — roles are not enforced yet/);
    assert.match(notice, /beta editing remains enabled/);
    assert.match(notice, /every signed-in employee can still view and edit every workspace/);
  });
});
