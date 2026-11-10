// The Machine Installation Database files card on the Integrations page, in the REAL app in a headless browser. Mock Google,
// monday.com refused, a synthetic run. Visible only to Google Drive administrators while the import is switched on; the run's
// controls; starting asks for the backup; a rollback needs the typed confirmation. Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const OIDS = { ada: "0a7a7a7a-0000-4000-8000-000000000091", mia: "0b7b7b7b-0000-4000-8000-000000000092" };
const CARD = '[aria-labelledby="int-mid-title"]';

describe("Machine Installation Database files card (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let proc, base, b;
  const signIn = (who, name, admin) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${encodeURIComponent(name)}&email=${who}@example.invalid&admin=${admin ? 1 : 0}&nonce=" + encodeURIComponent(s.nonce))).json(); const r = await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token, state: s.state }) }); return r.status; })()`);
  const text = (sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent || ""`);
  const has = (sel) => b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const openIntegrations = async () => {
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("!!document.querySelector('[data-screen=\"integrations\"]')", 15000));
    await click('[data-screen="integrations"]');
    assert.ok(await b.waitFor("!!document.querySelector('.integration-card:not(.is-loading)')", 10000));
    await new Promise((r) => setTimeout(r, 500));
  };
  before(async () => {
    const port = await freePort(); base = `http://localhost:${port}`;
    proc = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore", env: { ...process.env, JARC_TEST_GDRIVE: "1", JARC_TEST_GDRIVE_ADMINS: OIDS.ada, JARC_TEST_MID: "1" } });
    await waitForServer(base, { child: proc });
    b = await launch(BROWSER);
  });
  after(async () => { await b?.close(); proc?.kill(); });

  test("an employee doesn't see the import at all", async () => {
    await b.open(`${base}/api/v1/health`, { width: 1440 });
    assert.equal(await signIn("mia", "Mia Member", false), 201);
    await openIntegrations();
    assert.equal(await has(CARD), false);
    assert.equal(await b.evaluate(`fetch("/api/v1/migrations/mid-attachments").then((r) => r.status)`), 403);
  });

  test("a Drive administrator sees the card, a prepared run and its controls; starting asks for the backup; rollback needs the typed confirmation", async () => {
    await b.open(`${base}/api/v1/health`, { width: 1440 });
    assert.equal(await signIn("ada", "Ada Admin", false), 201);
    assert.equal(await b.evaluate(`fetch("/__test/mid", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) => r.status)`), 200);
    await openIntegrations();
    assert.ok(await b.waitFor(`!!document.querySelector(${JSON.stringify(CARD)})`, 5000), "card");
    assert.equal(await has("#mid-plan-file"), true);
    assert.match(await text(CARD), /mid-0123456789abcdef/);
    assert.match(await text(CARD), /0 of 2/);
    assert.equal(await has(`${CARD} [data-action="integration-mid-start-pilot"]`), true);
    assert.equal(await has(`${CARD} [data-action="integration-mid-pause"]`), false, "no pause before it runs");
    await click(`${CARD} [data-action="integration-mid-start-pilot"]`);
    assert.ok(await b.waitFor("!!document.querySelector('#overlay-root form[data-action=\"integration-mid-start-form\"] input[name=\"reference\"]')", 5000), "backup form");
    assert.match(await text("#overlay-root"), /20-file pilot/);
    await click('#overlay-root [data-action="close-overlay"]');
    await click(`${CARD} [data-action="integration-mid-rollback"]`);
    assert.ok(await b.waitFor("/ROLLBACK mid-0123456789abcdef/.test(document.querySelector('#overlay-root')?.textContent || '')", 5000), "typed confirmation");
    await click('#overlay-root [data-action="close-overlay"]');
    await click(`${CARD} [data-action="integration-mid-dryrun"]`);
    assert.ok(await b.waitFor("/Choose the plan file first/.test(document.body.textContent)", 5000), "a dry run needs a plan file");
  });
});
