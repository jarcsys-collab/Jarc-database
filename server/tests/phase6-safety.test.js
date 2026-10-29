// Phase 6 safety: paste never writes protected or unsupported cells; bulk actions are refused server-side without
// permission; and — with a colleague's change made on the server while this browser hasn't received it yet (live
// updates switched off for Ana) — undo never overwrites it, a bulk change is refused as a whole, and a bulk move
// leaves nothing behind. Undo of a deleted record never brings back (or points to) deleted files. Row reordering is
// blocked while sorted. Offline: fake MongoDB, in-memory files; headless browser parts skip without Chrome/Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { loadBrowser } = require("./support/browser-model");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "status", label: "Status", type: "status", options: ["New", "Done"] },
  { key: "notes", label: "Notes", type: "text" },
  { key: "docs", label: "Files", type: "files" }
];

describe("Paste: protected and unsupported columns (model)", () => {
  test("People, Files and Group cells, unknown labels and malformed values are refused; Item can't be emptied by paste", () => {
    const b = loadBrowser();
    const model = new b.window.BoardModel(new b.window.StorageService(new b.window.LocalAsyncAdapter()));
    const INVALID = b.window.BoardModel.INVALID;
    for (const type of ["owner", "files", "group"]) assert.equal(model.pasteValue({ key: "x", type }, "Anything"), INVALID, type);
    assert.equal(model.pasteValue({ key: "s", type: "status", options: ["New", "Done"] }, "Made up"), INVALID, "labels are never created by paste");
    assert.equal(model.pasteValue({ key: "s", type: "status", options: ["New", "Done"] }, "done"), "Done");
    assert.equal(model.pasteValue({ key: "d", type: "dropdown", multiple: true, options: ["A", "B"] }, "a, C"), INVALID, "every listed label must exist");
    assert.equal(model.pasteValue({ key: "n", type: "number" }, "12abc"), INVALID);
    assert.equal(model.pasteValue({ key: "e", type: "email" }, "not an email"), INVALID);
    assert.equal(model.pasteValue({ key: "l", type: "link" }, "javascript:alert(1)"), INVALID, "only http(s) links");
    assert.equal(model.pasteValue({ key: "c", type: "checkbox" }, "maybe"), INVALID);
    assert.equal(model.pasteValue({ key: "t", type: "text" }, "x".repeat(20000)).length, 10000, "text is capped");
    // The controller skips a value that would empty a required column (Item): pasteValue gives "" for blank input.
    assert.equal(model.pasteValue({ key: "serial", type: "text", required: true }, "   "), "");
  });
});

describe("Bulk actions: permissions enforced by the server (role_based)", () => {
  let app, issuer, admin, viewer, mixed, wsA, wsB, boardA, boardB, rec;
  const client = () => new SessionClient(app.url, app.entra.appOrigin);
  before(async () => {
    issuer = await createTokenIssuer();
    app = await startEntraApp({ issuer });
    admin = client(); viewer = client(); mixed = client();
    await admin.signIn(issuer.person("Ada Admin", { admin: true })); await viewer.signIn(issuer.person("Vic Viewer")); await mixed.signIn(issuer.person("Mo Member"));
    wsA = (await admin.request("POST", "/api/v1/workspaces", { name: "A" })).body.workspace;
    wsB = (await admin.request("POST", "/api/v1/workspaces", { name: "B" })).body.workspace;
    const id = async (c) => (await c.request("GET", "/api/v1/me")).body.user.id;
    await admin.request("POST", `/api/v1/workspaces/${wsA.id}/members`, { userId: await id(viewer), role: "VIEWER" });
    await admin.request("POST", `/api/v1/workspaces/${wsA.id}/members`, { userId: await id(mixed), role: "MEMBER" });
    await admin.request("POST", `/api/v1/workspaces/${wsB.id}/members`, { userId: await id(mixed), role: "VIEWER" });
    boardA = (await admin.request("POST", `/api/v1/workspaces/${wsA.id}/boards`, { name: "A1", columns: COLUMNS })).body.board;
    boardB = (await admin.request("POST", `/api/v1/workspaces/${wsB.id}/boards`, { name: "B1", columns: COLUMNS })).body.board;
    rec = (await admin.request("POST", `/api/v1/boards/${boardA.id}/records`, { values: { serial: "R" } })).body.record;
  });
  after(async () => { app.app?.locals?.realtime?.closeAll(); await app.close(); });

  test("a viewer can't bulk duplicate, archive, edit or delete", async () => {
    assert.equal((await viewer.request("POST", `/api/v1/boards/${boardA.id}/records/batch`, { records: [{ values: { serial: "copy" } }] })).status, 403, "duplicate");
    assert.equal((await viewer.request("PATCH", `/api/v1/boards/${boardA.id}/records`, { items: [{ id: rec.id, expectedVersion: rec.version, archived: true }] })).status, 403, "archive / bulk edit");
    assert.equal((await viewer.request("POST", `/api/v1/boards/${boardA.id}/records/delete`, { records: [{ id: rec.id, expectedVersion: rec.version }] })).status, 403, "delete");
    assert.equal((await admin.request("GET", `/api/v1/records/${rec.id}`)).body.record.archived, false, "nothing changed");
  });

  test("a move into a board the person can only view is refused before anything is removed", async () => {
    assert.equal((await mixed.request("POST", `/api/v1/boards/${boardB.id}/records/batch`, { records: [{ values: { serial: "R" } }] })).status, 403, "the copy into the target is refused (creates come first)");
    assert.equal((await admin.request("GET", `/api/v1/records/${rec.id}`)).status, 200, "the original is still there");
    assert.equal((await admin.request("GET", `/api/v1/boards/${boardB.id}/records`)).body.items.length, 0);
  });
});

const BROWSER = findBrowser();
describe("Undo, bulk changes and moves when a colleague's change hasn't arrived yet (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, ana, ben, ws, board, target;
  const OIDS = { ana: "0a7a7a7a-0000-4000-8000-000000000071", ben: "0b7b7b7b-0000-4000-8000-000000000072" };
  const signIn = (b, who, name) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${encodeURIComponent(name)}&email=${who}@example.invalid&nonce=" + s.nonce)).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); })()`);
  const api = (b, method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const records = async (id = board.id) => (await api(ben, "GET", `/boards/${id}/records?limit=200`)).body.items;
  const byName = async (serial, id) => (await records(id)).find((r) => r.values.serial === serial);
  const click = (b, sel, opts = "") => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "center" }); el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true${opts} })); return true; })()`);
  const cell = (serial, key) => `tr:has([aria-label="Item: ${serial}"]) td[data-column-key="${key}"] .cell-display`;
  const settled = async (b) => { assert.ok(await b.waitFor("document.querySelector('.save-state')?.dataset.state !== 'saving'", 8000)); await sleep(500); };
  const ctrlZ = (b, shift = false) => b.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: ${shift}, bubbles: true }))`);
  const openBoard = async (b) => {
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000));
    await b.evaluate("[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes('Safety board'))?.click()");
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table tbody tr td.cell')", 15000));
    await sleep(400);
  };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    ana = await launch(BROWSER); ben = await launch(BROWSER);
    // Ana's browser never receives live updates (and doesn't poll): a colleague's change stays unknown to it.
    await ana.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.EventSource = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} close() {} };" });
    for (const [b, who, name] of [[ana, "ana", "Ana Reyes"], [ben, "ben", "Ben Cruz"]]) { await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn(b, who, name); }
    ws = (await api(ben, "POST", "/workspaces", { name: "Safety" })).body.workspace;
    board = (await api(ben, "POST", `/workspaces/${ws.id}/boards`, { name: "Safety board", columns: COLUMNS })).body.board;
    target = (await api(ben, "POST", `/workspaces/${ws.id}/boards`, { name: "Safety target", columns: COLUMNS })).body.board;
    await api(ben, "POST", `/boards/${board.id}/records/batch`, { records: ["U-1", "M-1", "A-1", "A-2", "D-1", "O-1", "O-2"].map((serial) => ({ values: { serial, status: "New", notes: `${serial} note` } })) });
  });
  after(async () => { await ana?.close(); await ben?.close(); server?.kill(); });

  test("undo never overwrites a colleague's newer change that this browser hasn't received", async () => {
    await openBoard(ana);
    await ana.evaluate(`document.querySelector(${JSON.stringify(cell("U-1", "notes"))}).focus()`);
    await ana.key("Delete");
    await settled(ana);
    assert.equal((await byName("U-1")).values.notes, "");
    const u1 = await byName("U-1");
    assert.equal((await api(ben, "PATCH", `/records/${u1.id}`, { expectedVersion: u1.version, values: { notes: "Ben's newer note" } })).status, 200);
    await ana.evaluate("document.activeElement?.blur()");
    await ctrlZ(ana);
    await settled(ana);
    assert.equal((await byName("U-1")).values.notes, "Ben's newer note", "the server refused the undo (version check)");
    assert.match(await ana.evaluate("document.querySelector('#toast-region').textContent"), /changed by another user. The latest version has been loaded/, "Ana is told, and her screen reloads the latest version");
    assert.ok(await ana.waitFor(`document.querySelector(${JSON.stringify(cell("U-1", "notes"))})?.textContent.includes("Ben's newer note")`, 5000), "Ana now sees Ben's value");
  });

  test("a bulk archive is refused as a whole when one record changed meanwhile", async () => {
    await openBoard(ana);
    for (const s of ["A-1", "A-2"]) await click(ana, `tr:has([aria-label="Item: ${s}"]) input[data-action="select"]`);
    const a2 = await byName("A-2");
    await api(ben, "PATCH", `/records/${a2.id}`, { expectedVersion: a2.version, values: { notes: "changed by Ben" } });
    await click(ana, '.bulk-bar [data-action="bulk-archive"]');
    await settled(ana);
    assert.deepEqual([(await byName("A-1")).archived, (await byName("A-2")).archived], [false, false], "all or nothing");
    assert.equal((await byName("A-2")).values.notes, "changed by Ben");
  });

  test("a bulk move that can't remove the originals removes its copies again: nothing duplicated, nothing lost", async () => {
    await openBoard(ana);
    await click(ana, `tr:has([aria-label="Item: M-1"]) input[data-action="select"]`);
    const m1 = await byName("M-1");
    await api(ben, "PATCH", `/records/${m1.id}`, { expectedVersion: m1.version, values: { notes: "Ben edited M-1" } });
    await click(ana, '.bulk-bar [data-action="bulk-move"]');
    assert.ok(await ana.waitFor("!!document.querySelector('.move-targets')", 2000));
    await click(ana, `.move-targets [data-action="apply-bulk-move"][data-board="${target.id}"]`);
    await settled(ana); await sleep(800);
    assert.equal((await records(target.id)).filter((r) => r.values.serial === "M-1").length, 0, "no copy left in the target board");
    const still = await byName("M-1");
    assert.equal(still?.id, m1.id, "the original stays, same record");
    assert.equal(still.values.notes, "Ben edited M-1", "with the colleague's change");
    assert.equal(await ana.evaluate(`!!document.querySelector('tr[data-record-context="${m1.id}"]')`), true, "Ana's table still shows the original under its own ID");
  });

  test("undoing a record deletion never brings back deleted files or leaves references to them", async () => {
    await openBoard(ben);
    const d1 = await byName("D-1");
    const up = await ben.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1/records/${d1.id}/attachments?column=docs", { method: "POST", headers: { "Content-Type": "application/pdf", "X-File-Name": "proof.pdf", "X-CSRF-Token": csrfToken }, body: "%PDF-1.4 proof" }); return (await r.json()).attachment.id; })()`);
    await openBoard(ben);
    await ben.evaluate(`(() => { const b = document.createElement("button"); b.dataset.action = "delete"; b.dataset.id = ${JSON.stringify(d1.id)}; document.querySelector(".app-shell").append(b); b.click(); b.remove(); })()`);
    assert.ok(await ben.waitFor("!!document.querySelector('[data-action=\"confirm-delete-records\"]')", 2000));
    assert.match(await ben.evaluate("document.querySelector('#overlay-root').textContent"), /permanently deleted\. Undo can restore the records but not the files/);
    await click(ben, '[data-action="confirm-delete-records"]');
    await settled(ben);
    assert.equal(await byName("D-1"), undefined);
    assert.equal((await ben.evaluate(`fetch("/api/v1/attachments/${up}/content").then((r) => r.status)`)), 404, "the file is gone with the record");
    await ctrlZ(ben);
    await settled(ben);
    const back = await byName("D-1");
    assert.ok(back, "the record is back");
    assert.notEqual(back.id, d1.id, "as a new record");
    assert.equal(back.values.docs, "", "no file reference in its values");
    assert.deepEqual((await api(ben, "GET", `/records/${back.id}/attachments`)).body.items, [], "no files attached");
    assert.equal((await api(ben, "GET", `/boards/${board.id}/attachments`)).body.items.some((a) => a.id === up), false, "the deleted file isn't listed anywhere");
  });

  test("row reordering is blocked while a sort is active (and allowed again after clearing it)", async () => {
    await openBoard(ben);
    const tryDrag = async () => { await ben.evaluate(`document.querySelector('#toast-region').innerHTML = ''; document.querySelector('tr:has([aria-label="Item: O-1"]) [data-action="row-drag"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 10, clientY: 10 }))`); await sleep(200); const t = await ben.evaluate("document.querySelector('#toast-region').textContent"); await ben.evaluate("document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))"); return t; };
    await click(ben, '.board-tools [data-action="sort"]');
    assert.ok(await ben.waitFor("!!document.querySelector('form[data-action=sort-form]')", 2000));
    await ben.evaluate("(() => { const f = document.querySelector('form[data-action=sort-form]'); f.querySelector('[name=key]').value = 'notes'; f.querySelector('[name=direction]').value = 'asc'; })()");
    await click(ben, 'form[data-action="sort-form"] .button.primary');
    await sleep(400);
    assert.match(await tryDrag(), /Clear the sort to reorder rows/);
    await ben.evaluate("document.querySelector('[data-action=clear-sort], [data-action=remove-filter][data-key=sortKey]')?.click()");
    await ben.evaluate("(() => { const b = document.createElement('button'); b.dataset.action = 'clear-sort'; document.querySelector('.app-shell').append(b); b.click(); b.remove(); })()");
    await sleep(300);
    assert.doesNotMatch(await tryDrag(), /Clear the sort/, "allowed without a sort");
  });
});
