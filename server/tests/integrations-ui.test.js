// Integrations page (Phase 7) in the REAL app, in a headless browser, against the MOCK monday.com only
// (tests/support/mock-monday — every other URL is refused; the browser never navigates to monday.com):
// "Setup required" without configuration (admin and non-admin), "Not connected" with a Connect confirmation, the sync
// dashboard once connected, the import wizard (workspace → boards → preview → confirm), and the read-only
// imported board. Skipped when no Chrome or Edge is installed.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const OIDS = { ada: "0a7a7a7a-0000-4000-8000-000000000071", mia: "0b7b7b7b-0000-4000-8000-000000000072" };

describe("Phase 7: Integrations page (real app, mock monday.com)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let plain, mon, plainBase, monBase, b;
  const start = async (env) => {
    const port = await freePort(), base = `http://localhost:${port}`;
    const proc = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore", env: { ...process.env, ...env } });
    await waitForServer(base, { child: proc });
    return { proc, base };
  };
  const signIn = (base, who, name, admin) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${encodeURIComponent(name)}&email=${who}@example.invalid&admin=${admin ? 1 : 0}&nonce=" + encodeURIComponent(s.nonce))).json(); const r = await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token, state: s.state }) }); return r.status; })()`);
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json().catch(() => null) }; })()`);
  const text = (sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent || ""`);
  const has = (sel) => b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const toast = () => b.evaluate("[...document.querySelectorAll('#toast-region .toast')].map((t) => t.textContent).join(' | ')");
  const openIntegrations = async (base) => {
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("!!document.querySelector('[data-screen=\"integrations\"]')", 15000), "sidebar entry");
    await click('[data-screen="integrations"]');
    assert.ok(await b.waitFor("!!document.querySelector('.integration-card:not(.is-loading)')", 10000), "card loaded");
  };

  before(async () => {
    ({ proc: plain, base: plainBase } = await start({ JARC_TEST_MONDAY: "" }));
    ({ proc: mon, base: monBase } = await start({ JARC_TEST_MONDAY: "1" }));
    b = await launch(BROWSER);
    await b.motionPreference("no-preference");
  });
  after(async () => { await b?.close(); plain?.kill(); mon?.kill(); });

  test("not configured: administrators see Setup required with instructions; nobody gets a Connect button", async () => {
    await b.open(`${plainBase}/api/v1/health`, { width: 1440 });
    assert.equal(await signIn(plainBase, "ada", "Ada Admin", true), 201);
    await openIntegrations(plainBase);
    assert.match(await text(".integration-badge"), /Setup required/);
    assert.match(await text(".integration-setup"), /MONDAY_CLIENT_ID/);
    assert.equal(await has('[data-action="integration-connect"]'), false);
    assert.equal(await has(".integration-dashboard"), false, "no dashboard without a connection");
    assert.equal(await signIn(plainBase, "mia", "Mia Member", false), 201);
    await openIntegrations(plainBase);
    assert.match(await text(".integration-card"), /administrator needs to set up/);
    assert.doesNotMatch(await text(".integration-card"), /MONDAY_/);
    assert.equal(await has('[data-action="integration-connect"]'), false);
  });

  test("configured: Not connected with a confirmation before leaving JARC; the dashboard and import wizard once connected; the imported board is read-only", async () => {
    await b.open(`${monBase}/api/v1/health`, { width: 1440 });
    assert.equal(await signIn(monBase, "ada", "Ada Admin", true), 201);
    const ws = (await api("POST", "/workspaces", { name: "Destination" })).body.workspace;
    await openIntegrations(monBase);
    assert.match(await text(".integration-badge"), /Not connected/);
    await click('[data-action="integration-connect"]');
    assert.ok(await b.waitFor("/Continue to monday.com/.test(document.querySelector('#overlay-root')?.textContent || '')", 5000));
    await click('#overlay-root [data-action="close-overlay"]');
    assert.equal(await b.evaluate("location.host"), new URL(monBase).host, "still in JARC");

    await b.evaluate(`fetch("/__test/monday", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connect: true }) })`);
    await click('[data-action="integration-refresh"]');
    assert.ok(await b.waitFor("/Connected/.test(document.querySelector('.integration-badge')?.textContent || '')", 8000));
    assert.match(await text(".integration-facts"), /Mock Account/);
    assert.match(await text(".integration-stats"), /SyncOff/);
    assert.match(await text(".integration-dashboard"), /No boards imported yet/);

    await click('[data-action="integration-import"]');
    assert.ok(await b.waitFor("!!document.querySelector('[data-action=\"integration-wizard-workspace\"] option[value=\"5\"]')", 8000));
    await b.evaluate(`(() => { const s = document.querySelector('[data-action="integration-wizard-workspace"]'); s.value = "5"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    assert.ok(await b.waitFor("!!document.querySelector('.integration-boards input[value=\"111\"]')", 8000));
    assert.equal(await has('.integration-boards input[value="112"]'), false, "sub-item boards are not offered");
    await click('.integration-boards input[value="111"]');
    await click('[data-action="integration-wizard-preview"][data-id="111"]');
    assert.ok(await b.waitFor("/Item 1/.test(document.querySelector('.integration-wizard')?.textContent || '')", 8000));
    assert.match(await text(".integration-wizard"), /Not imported/);
    await click('[data-action="integration-wizard-back"]');
    assert.ok(await b.waitFor("document.querySelector('.integration-boards input[value=\"111\"]')?.checked === true", 8000), "selection kept");
    await b.evaluate(`document.querySelector('.integration-wizard select[name="workspaceId"]').value = ${JSON.stringify(ws.id)}`);
    await click('.integration-wizard button[type="submit"]');
    assert.match(await toast(), /Confirm the import first/);
    await click('.integration-wizard input[name="confirm"]');
    await click('.integration-wizard button[type="submit"]');
    assert.ok(await b.waitFor("/Import started/.test([...document.querySelectorAll('#toast-region .toast')].map((t) => t.textContent).join(' '))", 8000));
    const run = await b.evaluate(`fetch("/__test/monday", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run: true }) }).then((r) => r.json())`);
    assert.equal(run.ran, 1); assert.deepEqual(run.outside, []);

    await b.open(`${monBase}/`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("!!document.querySelector('[data-screen=\"integrations\"]')", 15000));
    await click('[data-screen="integrations"]');
    assert.ok(await b.waitFor("!!document.querySelector('[data-action=\"integration-open-board\"]')", 10000));
    assert.match(await text(".integration-dashboard"), /done/);
    await click('[data-action="integration-sync"][data-set="enable"]');
    assert.ok(await b.waitFor("/SyncOn/.test(document.querySelector('.integration-stats')?.textContent || '')", 8000));
    await click('[data-action="integration-sync"][data-set="pause"]');
    assert.ok(await b.waitFor("/SyncPaused/.test(document.querySelector('.integration-stats')?.textContent || '')", 8000));

    await click('[data-action="integration-open-board"]');
    assert.ok(await b.waitFor("!!document.querySelector('.readonly-banner')", 10000), "read-only banner");
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table tbody tr td.cell')", 10000));
    // Read-only boards offer no way to add records or groups (Phase 8 hides them; the server refuses anyway).
    assert.equal(await has('.board-tools [data-action="open-form"], [data-action="inline-add"], [data-action="group-new"]'), false);
    const boardId = (await api("GET", "/integrations/monday")).body.importedBoards[0].boardId;
    assert.equal((await api("POST", `/boards/${boardId}/records`, { values: { serial: "x" } })).body.error.code, "READ_ONLY_BOARD");
  });
});
