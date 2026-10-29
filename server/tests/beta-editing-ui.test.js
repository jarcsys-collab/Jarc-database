// Beta open editing in the REAL app (Entra test server, ACCESS_POLICY=role_based + JARC_BETA_OPEN_EDITING, fake
// MongoDB), two employees in two browsers: Vic is a workspace VIEWER, Nora has no membership. Both edit; records
// saved without a group are moved into a group only when someone chooses one (persisted, live for the other person);
// Settings shows the beta note. Skipped when no Chrome or Edge is installed.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const OIDS = { ada: "0e0e0e0e-0000-4000-8000-0000000000b1", vic: "0e0e0e0e-0000-4000-8000-0000000000b2", nora: "0e0e0e0e-0000-4000-8000-0000000000b3" };

describe("Beta open editing (real app, role_based + beta)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, vic, nora, board;
  const signIn = (b, who, name, admin = false) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${encodeURIComponent(name)}&email=${who}@example.invalid&admin=${admin ? 1 : 0}&nonce=" + encodeURIComponent(s.nonce))).json(); return (await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token, state: s.state }) })).status; })()`);
  const api = (b, method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json().catch(() => null) }; })()`);
  const click = (b, sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`);
  const saved = async (b) => { assert.ok(await b.waitFor("['live','saved'].includes(document.querySelector('.save-state')?.dataset.state)", 8000), "saved"); await sleep(300); };
  const records = async (b) => (await api(b, "GET", `/boards/${board.id}/records`)).body.items;
  const openBoard = async (b) => {
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "the board is visible to this person");
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Legacy jobs"))?.click()`);
    assert.ok(await b.waitFor("document.querySelectorAll('.board-group').length >= 3", 15000));
    assert.ok(await b.waitFor("document.querySelector('.save-state')?.dataset.state === 'live'", 8000));
    await sleep(300);
  };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore", env: { ...process.env, JARC_TEST_BETA: "1" } });
    await waitForServer(base, { child: server });
    vic = await launch(BROWSER); nora = await launch(BROWSER);
    for (const b of [vic, nora]) { await b.motionPreference("no-preference"); await b.open(`${base}/api/v1/health`, { width: 1440 }); }
    // Ada (JARC administrator, in Nora's browser first) sets up a workspace with Vic as a VIEWER and legacy records.
    await signIn(vic, "vic", "Vic Viewer");
    const vicId = (await api(vic, "GET", "/me")).body.user.id;
    await signIn(nora, "ada", "Ada Admin", true);
    const ws = (await api(nora, "POST", "/workspaces", { name: "Beta ops" })).body.workspace;
    assert.equal((await api(nora, "POST", `/workspaces/${ws.id}/members`, { userId: vicId, role: "VIEWER" })).status, 201);
    board = (await api(nora, "POST", `/workspaces/${ws.id}/boards`, { name: "Legacy jobs", columns: [{ key: "serial", label: "Item", type: "text", required: true }, { key: "notes", label: "Notes", type: "text" }] })).body.board;
    await api(nora, "POST", `/boards/${board.id}/records/batch`, { records: [{ values: { serial: "Old A", notes: "a" } }, { values: { serial: "Old B", notes: "b" } }, { values: { serial: "Old C", notes: "c" } }] });
    await nora.open(`${base}/api/v1/health`, { width: 1440 });
    await nora.evaluate(`fetch("/api/v1/auth/session", { method: "DELETE" })`).catch(() => {});
    assert.equal(await signIn(nora, "nora", "Nora Nobody"), 201);
  });
  after(async () => { await vic?.close(); await nora?.close(); server?.kill(); });

  test("records saved without a group show under No group and move only when someone chooses a group — live and persisted", async () => {
    await openBoard(nora); await openBoard(vic);
    assert.equal(await nora.evaluate("document.querySelectorAll('.board-group.is-loose tr[data-record-context]').length"), 3, "No group holds the legacy records");
    assert.ok((await records(nora)).every((r) => r.groupId === null), "nothing was moved automatically");
    assert.ok(await click(nora, ".board-group.is-loose [data-action=group-pick]"), "Move to a group… is offered");
    assert.ok(await nora.waitFor("!!document.querySelector('[data-action=group-move-records][data-group=Working]')", 3000));
    await click(nora, "[data-action=group-move-records][data-group=Working]");
    await saved(nora);
    const working = board.groups.find((g) => g.name === "Working").id;
    assert.ok((await records(nora)).every((r) => r.groupId === working), "all three persisted in Working");
    assert.ok(await vic.waitFor("!document.querySelector('.board-group.is-loose') && document.querySelectorAll('.board-group[data-group=Working] tr[data-record-context]').length === 3", 10000), "live for Vic");
    await openBoard(nora);
    assert.equal(await nora.evaluate("document.querySelectorAll('.board-group[data-group=Working] tr[data-record-context]').length"), 3, "after a refresh");
  });

  test("a VIEWER edits a cell and adds a group; the non-member sees it live", async () => {
    await vic.evaluate(`document.querySelector('tr:has([aria-label="Item: Old A"]) td[data-column-key="notes"] .cell-display').click()`);
    assert.ok(await vic.waitFor("!!document.querySelector('.cell-input')", 3000));
    await vic.evaluate(`(() => { const i = document.querySelector('.cell-input'); i.value = "edited by Vic"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
    await saved(vic);
    assert.equal((await records(vic)).find((r) => r.values.serial === "Old A").values.notes, "edited by Vic");
    assert.equal(await vic.evaluate("document.querySelector('.save-state')?.dataset.state"), "live", "no save error");
    assert.ok(await nora.waitFor(`/edited by Vic/.test(document.querySelector('tr:has([aria-label="Item: Old A"]) td[data-column-key="notes"]')?.textContent || '')`, 10000), "live for Nora");
    await click(vic, ".group-footer [data-action=group-new]");
    assert.ok(await vic.waitFor("!!document.querySelector('form.group-form')", 3000));
    await vic.evaluate(`(() => { const f = document.querySelector('form.group-form'); f.querySelector('input[name=name]').value = "Beta group"; f.requestSubmit(); })()`);
    await saved(vic);
    assert.ok(await nora.waitFor("[...document.querySelectorAll('.board-group')].some((g) => g.dataset.group === 'Beta group')", 10000));
  });

  test("Settings shows the beta collaboration note", async () => {
    await click(nora, "[data-action=settings]");
    assert.ok(await nora.waitFor("/Beta collaboration enabled/.test(document.querySelector('.settings-body')?.textContent || '')", 5000));
  });
});
