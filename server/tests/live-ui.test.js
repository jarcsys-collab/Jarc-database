// Real-time collaboration in the REAL app, in headless browsers (Chrome/Edge): two employees (and a second tab) on the
// same board, through the Entra test server (ACCESS_POLICY=development_shared, fake MongoDB). Changes are made by one
// person (through the UI or the API) and must appear for the others without a reload, without disturbing what they
// are doing; conflicts are surfaced, never silently overwritten.
// Skipped when no Chrome or Edge is installed (set JARC_TEST_BROWSER to use a specific one).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const OIDS = { ana: "0a0a0a0a-0000-4000-8000-0000000000a1", ben: "0b0b0b0b-0000-4000-8000-0000000000b2" };
const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "status", label: "Status", type: "status", options: ["New", "Doing", "Done"] },
  { key: "qty", label: "Qty", type: "number" },
  { key: "notes", label: "Notes", type: "text" }
];

describe("Real-time collaboration (real app, headless browsers)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, ana, ben, benTab2, ws, board;
  // Signing in from a page that isn't the app (the health endpoint): no app request with an old cookie is in flight
  // whose 401 response would clear the new session cookie.
  const signIn = (b, who, name) => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${encodeURIComponent(name)}&email=${who}@example.invalid&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const api = (b, method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: r.status === 204 ? null : await r.json() }; })()`);
  const cellSel = (serial, key) => `tr:has([aria-label="Item: ${serial}"]) td[data-column-key="${key}"]`;
  const cellText = (b, serial, key) => b.evaluate(`document.querySelector(${JSON.stringify(cellSel(serial, key) + " .cell-display")})?.textContent.trim() ?? null`);
  const live = (b) => b.waitFor("document.querySelector('.save-state')?.dataset.state === 'live'", 8000);
  const openBoard = async (b) => {
    await b.open(`${base}/`, { width: 1280, height: 860 });
    await b.waitFor("!!document.querySelector('.app-shell')", 8000);
    await b.evaluate("[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes('Live board'))?.click()");
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table td.cell')", 8000), "board loaded");
    assert.ok(await live(b), "live updates connected");
  };
  const record = async (serial) => (await api(ana, "GET", `/boards/${board.id}/records?limit=200`)).body.items.find((r) => r.values.serial === serial);
  // Marks the page so a reload (which would wipe it) can be detected.
  const markPage = (b) => b.evaluate("window.__noReload = true");
  const notReloaded = (b) => b.evaluate("window.__noReload === true");

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    ana = await launch(BROWSER); ben = await launch(BROWSER);
    await ana.open(`${base}/api/v1/health`, { width: 1280 }); await signIn(ana, "ana", "Ana Reyes");
    await ben.open(`${base}/api/v1/health`, { width: 1280 }); await signIn(ben, "ben", "Ben Cruz");
    ws = (await api(ana, "POST", "/workspaces", { name: "Live" })).body.workspace;
    board = (await api(ana, "POST", `/workspaces/${ws.id}/boards`, { name: "Live board", columns: COLUMNS })).body.board;
    await api(ana, "POST", `/boards/${board.id}/records/batch`, { records: Array.from({ length: 30 }, (_, i) => ({ values: { serial: `R-${String(i).padStart(2, "0")}`, status: "New", qty: String(i) } })) });
  });
  after(async () => { await ana?.close(); await ben?.close(); await benTab2?.close(); server?.kill(); });

  test("LIVE UPDATE: Ana changes a status in the UI; Ben's cell changes by itself — no reload, his scroll kept", async () => {
    await openBoard(ana); await openBoard(ben); await markPage(ben);
    await ben.evaluate("document.querySelector('.table-wrap').scrollTop = 200; window.scrollTo(0, 120)");
    const scrollBefore = await ben.evaluate("[document.querySelector('.table-wrap').scrollTop, window.scrollY]");
    await ana.evaluate(`document.querySelector(${JSON.stringify(cellSel("R-03", "status") + " .cell-display")}).click()`); await sleep(200);
    await ana.evaluate(`document.querySelector('.cell-option[data-value="Done"]').click()`);
    assert.ok(await ben.waitFor(`document.querySelector(${JSON.stringify(cellSel("R-03", "status"))})?.textContent.trim() === "Done"`, 6000), "Ben sees Done");
    assert.equal(await notReloaded(ben), true, "no page reload");
    assert.deepEqual(await ben.evaluate("[document.querySelector('.table-wrap').scrollTop, window.scrollY]"), scrollBefore, "scroll position kept");
    assert.ok(await ben.evaluate(`document.querySelector(${JSON.stringify(cellSel("R-03", "status"))}).classList.contains('remote-flash')`), "the changed cell is highlighted briefly");
  });

  test("LIVE CREATE and DELETE appear for Ben; his own save isn't echoed back as a change", async () => {
    await openBoard(ben); await markPage(ben);
    const created = (await api(ana, "POST", `/boards/${board.id}/records`, { values: { serial: "From Ana", status: "Doing" } })).body.record;
    assert.ok(await ben.waitFor(`!!document.querySelector('[aria-label="Item: From Ana"]')`, 6000), "new record appears");
    await api(ana, "DELETE", `/records/${created.id}?expectedVersion=${created.version}`);
    assert.ok(await ben.waitFor(`!document.querySelector('[aria-label="Item: From Ana"]')`, 6000), "deleted record disappears");
    assert.equal(await notReloaded(ben), true);
    // Ben edits a cell himself: it saves once and nothing re-renders afterwards.
    await ben.evaluate(`document.querySelector(${JSON.stringify(cellSel("R-05", "qty") + " .cell-display")}).click()`); await sleep(150);
    await ben.evaluate("(() => { const i = document.querySelector('.cell-input'); i.value = '55'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()");
    await ben.waitFor("document.querySelector('.save-state')?.dataset.state === 'live'", 5000);
    await ben.evaluate(`window.__marker = document.querySelector(${JSON.stringify(cellSel("R-05", "qty"))})`);
    await sleep(1500); // the echo of his own change arrives meanwhile
    assert.equal(await ben.evaluate(`window.__marker === document.querySelector(${JSON.stringify(cellSel("R-05", "qty"))})`), true, "his cell wasn't re-rendered by his own echo");
    assert.equal((await record("R-05")).values.qty, "55");
  });

  test("LIVE COLUMNS: a column added, renamed and deleted by Ana updates Ben's table", async () => {
    await openBoard(ben); await markPage(ben);
    let b = (await api(ana, "GET", `/boards/${board.id}`)).body.board;
    const added = await api(ana, "POST", `/boards/${board.id}/columns`, { expectedVersion: b.version, column: { key: "owner_x", label: "Site", type: "text" } });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.ok(await ben.waitFor(`!!document.querySelector('th[data-column-key="owner_x"]')`, 6000), "new column appears");
    b = added.body.board;
    await api(ana, "PATCH", `/boards/${board.id}`, { expectedVersion: b.version, columns: b.columns.map((c) => (c.key === "owner_x" ? { ...c, label: "Location" } : c)) });
    assert.ok(await ben.waitFor(`document.querySelector('th[data-column-key="owner_x"] .column-label')?.textContent === 'Location'`, 6000), "rename appears");
    b = (await api(ana, "GET", `/boards/${board.id}`)).body.board;
    await api(ana, "DELETE", `/boards/${board.id}/columns/owner_x?expectedVersion=${b.version}`);
    assert.ok(await ben.waitFor(`!document.querySelector('th[data-column-key="owner_x"]')`, 6000), "deleted column disappears");
    assert.equal(await notReloaded(ben), true);
  });

  test("LIVE LISTS and NOTIFICATIONS: a new workspace appears in Ben's sidebar; his bell counts it", async () => {
    await openBoard(ben);
    await ben.evaluate("document.querySelector('[data-action=mark-notifications]')?.click()");
    await ben.evaluate("document.querySelector('[data-action=notifications]').click()"); await sleep(400);
    await ben.evaluate("document.querySelector('[data-action=mark-notifications]').click()"); await sleep(200);
    await ben.key("Escape");
    assert.equal(await ben.evaluate("document.querySelector('.notification-button b')"), null);
    await api(ana, "POST", "/workspaces", { name: "Brand new" });
    assert.ok(await ben.waitFor("[...document.querySelectorAll('#sidebar, .workspace-popover')].some(() => true) && (window.__wsCheck = true)", 1000));
    await ben.evaluate("document.querySelector('[data-action=workspace-menu]').click()"); await sleep(200);
    const appears = await ben.waitFor("[...document.querySelectorAll('.workspace-popover button')].some((b) => b.textContent.includes('Brand new'))", 6000)
      || (await ben.key("Escape"), await ben.evaluate("document.querySelector('[data-action=workspace-menu]').click()"), await sleep(300), await ben.waitFor("[...document.querySelectorAll('.workspace-popover button')].some((b) => b.textContent.includes('Brand new'))", 4000));
    assert.ok(appears, "the new workspace is in Ben's list");
    await ben.key("Escape");
    assert.ok(await ben.waitFor("Number(document.querySelector('.notification-button b')?.textContent || 0) >= 1", 6000), "unread badge without opening anything");
  });

  test("PRESERVED EDITOR: while Ben types in a cell, Ana's change to ANOTHER cell appears and Ben keeps typing", async () => {
    await openBoard(ben);
    await ben.evaluate(`document.querySelector(${JSON.stringify(cellSel("R-10", "notes") + " .cell-display")}).click()`); await sleep(150);
    await ben.evaluate("(() => { const i = document.querySelector('.cell-input'); i.value = 'Half-typed note'; i.setSelectionRange(4, 4); })()");
    const r12 = await record("R-12");
    await api(ana, "PATCH", `/records/${r12.id}`, { expectedVersion: r12.version, values: { status: "Doing" } });
    assert.ok(await ben.waitFor(`document.querySelector(${JSON.stringify(cellSel("R-12", "status"))})?.textContent.trim() === "Doing"`, 6000), "other cell updated");
    assert.deepEqual(await ben.evaluate("[document.activeElement?.classList.contains('cell-input'), document.activeElement?.value, document.activeElement?.selectionStart]"), [true, "Half-typed note", 4], "editor, text and caret untouched");
    await ben.key("Escape");
  });

  test("CONFLICT: Ana changes the cell Ben is editing — Ben is told, and nothing is overwritten unless he chooses", async () => {
    await openBoard(ben);
    await ben.evaluate(`document.querySelector(${JSON.stringify(cellSel("R-20", "qty") + " .cell-display")}).click()`); await sleep(150);
    await ben.evaluate("document.querySelector('.cell-input').value = '777'");
    const r20 = await record("R-20");
    await api(ana, "PATCH", `/records/${r20.id}`, { expectedVersion: r20.version, values: { qty: "999" } });
    assert.ok(await ben.waitFor(`document.querySelector(${JSON.stringify(cellSel("R-20", "qty") + " .remote-note")})?.textContent.includes("999")`, 6000), "Ben sees Ana's value while editing");
    await ben.evaluate("document.querySelector('.cell-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))"); await sleep(300);
    assert.match(await ben.evaluate("document.querySelector('#overlay-root h2')?.textContent || ''"), /Ana Reyes changed Qty/);
    assert.equal(await ben.evaluate("document.querySelector('.save-state').dataset.state"), "conflict");
    assert.equal((await record("R-20")).values.qty, "999", "nothing overwritten yet");
    await ben.evaluate("document.querySelector('[data-action=close-overlay]').click()"); await sleep(400);
    assert.equal((await record("R-20")).values.qty, "999", "cancel keeps Ana's value");
    assert.equal(await ben.evaluate(`document.querySelector(${JSON.stringify(cellSel("R-20", "qty"))}).textContent.trim()`), "999");
    // Again, and this time Ben keeps his value deliberately.
    await ben.evaluate(`document.querySelector(${JSON.stringify(cellSel("R-21", "qty") + " .cell-display")}).click()`); await sleep(150);
    await ben.evaluate("document.querySelector('.cell-input').value = '123'");
    const r21 = await record("R-21");
    await api(ana, "PATCH", `/records/${r21.id}`, { expectedVersion: r21.version, values: { qty: "456" } });
    await ben.waitFor(`!!document.querySelector(${JSON.stringify(cellSel("R-21", "qty") + " .remote-note")})`, 6000);
    await ben.evaluate("document.querySelector('.cell-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))"); await sleep(300);
    await ben.evaluate("document.querySelector('[data-action=conflict-keep-mine]').click()"); await sleep(600);
    assert.equal((await record("R-21")).values.qty, "123", "kept by an explicit choice");
  });

  test("RECORD FORM: Ana's change to another field flows in; saving sends only Ben's field; a clash needs a second Save", async () => {
    await openBoard(ben);
    await ben.evaluate(`document.querySelector(${JSON.stringify(`tr:has([aria-label="Item: R-15"]) [data-action="edit"]`)}).click()`); await sleep(300);
    await ben.evaluate("(() => { const f = document.querySelector('form.record-drawer'); f.querySelector('[name=notes]').value = 'Ben wrote this'; })()");
    let r15 = await record("R-15");
    await api(ana, "PATCH", `/records/${r15.id}`, { expectedVersion: r15.version, values: { status: "Done" } });
    assert.ok(await ben.waitFor("document.querySelector('form.record-drawer [name=status]')?.value === 'Done'", 6000), "untouched field updated in the open form");
    assert.match(await ben.evaluate("document.querySelector('.form-live-notice')?.textContent || ''"), /Ana Reyes updated this record/);
    await ben.evaluate("document.querySelector('form.record-drawer').requestSubmit()"); await sleep(800);
    r15 = await record("R-15");
    assert.deepEqual([r15.values.status, r15.values.notes], ["Done", "Ben wrote this"], "both changes kept");
    // Clash: both change Notes.
    await ben.evaluate(`document.querySelector(${JSON.stringify(`tr:has([aria-label="Item: R-16"]) [data-action="edit"]`)}).click()`); await sleep(300);
    await ben.evaluate("document.querySelector('form.record-drawer [name=notes]').value = 'Ben version'");
    const r16 = await record("R-16");
    await api(ana, "PATCH", `/records/${r16.id}`, { expectedVersion: r16.version, values: { notes: "Ana version" } });
    assert.ok(await ben.waitFor("(document.querySelector('.form-live-notice')?.textContent || '').includes('also changed Notes')", 6000));
    await ben.evaluate("document.querySelector('form.record-drawer').requestSubmit()"); await sleep(500);
    assert.equal((await record("R-16")).values.notes, "Ana version", "first Save only warns");
    await ben.evaluate("document.querySelector('form.record-drawer').requestSubmit()"); await sleep(800);
    assert.equal((await record("R-16")).values.notes, "Ben version", "second, informed Save keeps Ben's");
  });

  test("MULTIPLE TABS: Ben's second tab sees what his first tab saved", async () => {
    await openBoard(ben);
    benTab2 = await launch(BROWSER);
    await benTab2.open(`${base}/api/v1/health`, { width: 1280 }); await signIn(benTab2, "ben", "Ben Cruz");
    await openBoard(benTab2);
    await ben.evaluate(`document.querySelector(${JSON.stringify(cellSel("R-07", "status") + " .cell-display")}).click()`); await sleep(200);
    await ben.evaluate(`document.querySelector('.cell-option[data-value="Doing"]').click()`);
    assert.ok(await benTab2.waitFor(`document.querySelector(${JSON.stringify(cellSel("R-07", "status"))})?.textContent.trim() === "Doing"`, 6000));
  });

  test("NETWORK LOSS: offline is shown, changes made meanwhile arrive after reconnecting (missed-event replay)", async () => {
    await openBoard(ben); await markPage(ben);
    await ben.send("Network.enable");
    await ben.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await ben.evaluate("window.dispatchEvent(new Event('offline'))");
    assert.ok(await ben.waitFor("['offline', 'reconnecting'].includes(document.querySelector('.save-state').dataset.state)", 6000), "connection state shown");
    const r25 = await record("R-25");
    await api(ana, "PATCH", `/records/${r25.id}`, { expectedVersion: r25.version, values: { status: "Done" } });
    await sleep(500);
    await ben.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await ben.evaluate("window.dispatchEvent(new Event('online'))");
    assert.ok(await live(ben), "reconnected");
    assert.ok(await ben.waitFor(`document.querySelector(${JSON.stringify(cellSel("R-25", "status"))})?.textContent.trim() === "Done"`, 8000), "the change made while offline arrives");
    assert.equal(await notReloaded(ben), true);
  });

  test("SESSION EXPIRY while connected → the sign-in screen, not a broken page", async () => {
    await openBoard(ben);
    await ben.evaluate("fetch('/__test/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expireSessions: true }) })");
    await sleep(200);
    await ana.open(`${base}/api/v1/health`, { width: 1280 }); await signIn(ana, "ana", "Ana Reyes"); // every session ended; Ana signs in again
    const r1 = await record("R-01");
    await api(ana, "PATCH", `/records/${r1.id}`, { expectedVersion: r1.version, values: { status: "Doing" } });
    // Ben's tab fetches Ana's change, finds its session gone and shows the sign-in screen (or the stream's own check does).
    assert.ok(await ben.waitFor("!!document.querySelector('.entra-login')", 40000), "expired screen shown");
    await ben.open(`${base}/api/v1/health`, { width: 1280 }); await signIn(ben, "ben", "Ben Cruz");
  });

  test("REDUCED MOTION: animations and transitions are switched off", async () => {
    await ben.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await openBoard(ben);
    await ben.evaluate("document.querySelector('[data-action=notifications]').click()"); await sleep(150);
    const motion = await ben.evaluate("(() => { const d = document.querySelector('.notification-drawer'); const s = getComputedStyle(d); return [s.animationName, document.querySelector('.save-state i') ? getComputedStyle(document.querySelector('.save-state i')).transitionDuration : '0s']; })()");
    assert.equal(motion[0], "none");
    assert.match(motion[1], /^0s/);
    await ben.send("Emulation.setEmulatedMedia", { features: [] });
    await ben.key("Escape");
  });

  test("SAVE FAILURE: a refused save says so (not “Saved”) and nothing is applied", async () => {
    await openBoard(ben);
    const b = (await api(ana, "GET", `/boards/${board.id}`)).body.board;
    // The board changes under Ben (version moves on); his stale column rename is refused (409) and reported.
    await api(ana, "PATCH", `/boards/${board.id}`, { expectedVersion: b.version, description: "Changed by Ana" });
    await ben.evaluate("window.__fetch = window.fetch; window.fetch = (u, i) => /\\/boards\\/[0-9a-f]+$/.test(String(u)) && i?.method === 'PATCH' ? Promise.resolve(new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'x' } }), { status: 500, headers: { 'Content-Type': 'application/json' } })) : window.__fetch(u, i)");
    await ben.evaluate(`document.querySelector('th[data-column-key="notes"] .column-menu-button').click()`); await sleep(150);
    await ben.evaluate(`document.querySelector('.column-menu-popover [data-action="rename-column"]').click()`); await sleep(150);
    await ben.evaluate("(() => { const f = document.querySelector('[data-action=rename-column-form]'); f.querySelector('input[name=label]').value = 'Remarks'; f.requestSubmit(); })()");
    assert.ok(await ben.waitFor("['error'].includes(document.querySelector('.save-state').dataset.state) || !!document.querySelector('.dialog-error')", 6000), "failure shown");
    assert.notEqual(await ben.evaluate("document.querySelector('.save-state').textContent"), "Saved · Live");
    const notes = (await api(ana, "GET", `/boards/${board.id}`)).body.board.columns.find((c) => c.key === "notes");
    assert.equal(notes.label, "Notes", "nothing saved");
    await ben.evaluate("window.fetch = window.__fetch");
  });
});
