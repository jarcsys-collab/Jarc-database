// The Google Drive card on the Integrations page, in the REAL app in a headless browser, against the MOCK Google only: the browser
// never navigates to Google. Hidden while the server has it off; a read-only card for every employee (JARC.Admin included) and the
// buttons only for Drive administrators (GOOGLE_DRIVE_ADMIN_OIDS); a confirmation before leaving JARC; connected, reconnect and
// disconnected states; and the message after returning from Google. Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
// ada: Drive administrator (allowlisted) and JARC.Admin; mia: an employee; jay: JARC.Admin but not allowlisted.
const OIDS = { ada: "0a7a7a7a-0000-4000-8000-000000000081", mia: "0b7b7b7b-0000-4000-8000-000000000082", jay: "0c7c7c7c-0000-4000-8000-000000000083" };
const CARD = '[aria-labelledby="int-gdrive-title"]';

describe("Google Drive card (real app, mock Google)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let off, on, offBase, onBase, b;
  const start = async (env) => {
    const port = await freePort(), base = `http://localhost:${port}`;
    const proc = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore", env: { ...process.env, ...env } });
    await waitForServer(base, { child: proc });
    return { proc, base };
  };
  const signIn = (who, name, admin) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${encodeURIComponent(name)}&email=${who}@example.invalid&admin=${admin ? 1 : 0}&nonce=" + encodeURIComponent(s.nonce))).json(); const r = await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token, state: s.state }) }); return r.status; })()`);
  const text = (sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent || ""`);
  const has = (sel) => b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const toast = () => b.evaluate("[...document.querySelectorAll('#toast-region .toast')].map((t) => t.textContent).join(' | ')");
  const control = (body) => b.evaluate(`fetch("/__test/google-drive", { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify(body))} }).then((r) => r.status)`);
  const openIntegrations = async (base, query = "") => {
    await b.open(`${base}/${query}`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("!!document.querySelector('[data-screen=\"integrations\"]')", 15000), "sidebar entry");
    await click('[data-screen="integrations"]');
    assert.ok(await b.waitFor("!!document.querySelector('.integration-card:not(.is-loading)')", 10000), "card loaded");
  };
  const refresh = async () => { await click('[data-action="integration-refresh"]'); await new Promise((r) => setTimeout(r, 400)); };

  before(async () => {
    ({ proc: off, base: offBase } = await start({ JARC_TEST_GDRIVE: "" }));
    ({ proc: on, base: onBase } = await start({ JARC_TEST_GDRIVE: "1", JARC_TEST_GDRIVE_ADMINS: OIDS.ada }));
    b = await launch(BROWSER);
  });
  after(async () => { await b?.close(); off?.kill(); on?.kill(); });

  test("switched off on the server: no card and no error, even for an administrator", async () => {
    await b.open(`${offBase}/api/v1/health`, { width: 1440 });
    assert.equal(await signIn("ada", "Ada Admin", true), 201);
    await openIntegrations(offBase);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await has(CARD), false);
    assert.doesNotMatch(await text("#integrations-root"), /couldn't|Google/);
  });

  test("an employee, and a JARC.Admin who isn't a Drive administrator, see a read-only card: the state, no buttons, no account", async () => {
    for (const [who, name, admin] of [["mia", "Mia Member", false], ["jay", "Jay Jarcadmin", true]]) {
      await b.open(`${onBase}/api/v1/health`, { width: 1440 });
      assert.equal(await signIn(who, name, admin), 201);
      await openIntegrations(onBase);
      assert.ok(await b.waitFor(`!!document.querySelector(${JSON.stringify(CARD)})`, 5000), `card for ${who}`);
      assert.match(await text(`${CARD} .integration-badge`), /Not connected/);
      assert.match(await text(CARD), /isn't connected yet/);
      assert.match(await text(CARD), /Google Drive administrators manage this connection/);
      assert.equal(await has(`${CARD} [data-action^="integration-gdrive-"]`), false, `no buttons for ${who}`);
      assert.doesNotMatch(await text(CARD), /attachments@example\.invalid/);
    }
  });

  test("an administrator: Not connected, a confirmation before leaving JARC, then connected, reconnect-needed and disconnected", async () => {
    await b.open(`${onBase}/api/v1/health`, { width: 1440 });
    assert.equal(await signIn("ada", "Ada Admin", true), 201);
    await openIntegrations(onBase);
    assert.ok(await b.waitFor(`!!document.querySelector(${JSON.stringify(CARD)})`, 5000), "card");
    assert.match(await text(`${CARD} .integration-badge`), /Not connected/);
    assert.match(await text(CARD), /attachments@example\.invalid/);
    assert.match(await text(CARD), /Not going to Google Drive yet/);
    assert.match(await text(CARD), /don't need a Google account/);
    await click('[data-action="integration-gdrive-connect"]');
    assert.ok(await b.waitFor("/Continue to Google/.test(document.querySelector('#overlay-root')?.textContent || '')", 5000));
    await click('#overlay-root [data-action="close-overlay"]');
    assert.equal(await b.evaluate("location.host"), new URL(onBase).host, "still in JARC");

    assert.equal(await control({ connect: true }), 200);
    await refresh();
    assert.match(await text(`${CARD} .integration-badge`), /Connected/);
    assert.match(await text(CARD), /JARC Attachments/);
    assert.match(await text(CARD), /Ada Admin/);
    assert.equal(await b.evaluate(`document.querySelector(${JSON.stringify(`${CARD} a`)}).rel`), "noopener noreferrer");
    assert.doesNotMatch(await b.evaluate("document.documentElement.outerHTML"), /refresh-ui-test/);
    await click('[data-action="integration-gdrive-test"]');
    assert.ok(await b.waitFor("/Connection works/.test([...document.querySelectorAll('#toast-region .toast')].map((t) => t.textContent).join(' '))", 5000), await toast());

    await control({ revoke: true });
    await click('[data-action="integration-gdrive-test"]');
    assert.ok(await b.waitFor(`/Reconnect required/.test(document.querySelector(${JSON.stringify(`${CARD} .integration-badge`)})?.textContent || "")`, 5000), "needs reconnect");
    await click('#overlay-root [data-action="close-overlay"]');
    assert.equal(await has(`${CARD} [data-action="integration-gdrive-connect"]`), true);
    assert.match(await text(CARD), /no longer accepts/);

    await click('[data-action="integration-gdrive-disconnect"]');
    assert.ok(await b.waitFor("/Files stay in Google Drive/.test(document.querySelector('#overlay-root')?.textContent || '')", 5000));
    await click('#overlay-root [data-action="integration-gdrive-disconnect-go"]');
    assert.ok(await b.waitFor(`/Not connected/.test(document.querySelector(${JSON.stringify(`${CARD} .integration-badge`)})?.textContent || "")`, 5000), "disconnected");
    assert.match(await text(CARD), /JARC Attachments/, "the folder is remembered");
  });

  test("once connected, an employee sees Connected and still no account, folder or buttons", async () => {
    await b.open(`${onBase}/api/v1/health`, { width: 1440 });
    assert.equal(await signIn("ada", "Ada Admin", true), 201);
    assert.equal(await control({ connect: true }), 200);
    assert.equal(await signIn("mia", "Mia Member", false), 201);
    await openIntegrations(onBase);
    assert.ok(await b.waitFor(`/Connected/.test(document.querySelector(${JSON.stringify(`${CARD} .integration-badge`)})?.textContent || "")`, 5000), "connected");
    assert.match(await text(CARD), /connected for the whole company/);
    assert.equal(await has(`${CARD} a`), false, "no folder link");
    assert.equal(await has(`${CARD} [data-action^="integration-gdrive-"]`), false);
    assert.doesNotMatch(await text(CARD), /attachments@example\.invalid|Ada Admin|JARC Attachments/);
  });

  test("returning from Google opens the page, explains what happened, and clears the address bar", async () => {
    await b.open(`${onBase}/?integration=google-drive&result=error&code=GDRIVE_WRONG_ACCOUNT`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("/isn't the Google account/.test([...document.querySelectorAll('#toast-region .toast')].map((t) => t.textContent).join(' '))", 15000), await toast());
    assert.equal(await b.evaluate("location.search"), "");
    assert.equal(await has("#integrations-root"), true);
  });
});
