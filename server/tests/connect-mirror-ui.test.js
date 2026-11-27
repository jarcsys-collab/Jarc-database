// Connect boards and Mirror columns in the REAL app in a headless browser, on the fake MongoDB (role_based): linked names and
// mirror values appear in the table; the picker searches the linked board, links and unlinks, and saves; a colleague who
// can't open the linked board sees a lock, never names or values. Skipped when no Chrome or Edge is installed.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const OIDS = { admin: "0d0d0d0d-0000-4000-8000-000000000071", mia: "0d0d0d0d-0000-4000-8000-000000000072" };

describe("Connect boards and Mirror columns (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, admin, mia, projects, clients, ids;
  const signIn = (b, who, isAdmin = false) => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${who}&email=${who}@example.invalid&admin=${isAdmin ? 1 : 0}&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const api = (b, method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken } ${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; })()`);
  const cellText = (b, key, row = "Alpha") => b.evaluate(`(() => { const tr = [...document.querySelectorAll('tr[data-record-context]')].find((t) => t.textContent.includes(${JSON.stringify(row)})); return (tr?.querySelector('td[data-column-key="${key}"] .cell-display')?.textContent || '').replace(/\\s+/g, ' ').trim(); })()`);
  const openBoard = async (b, name) => {
    await b.send("Page.navigate", { url: `${base}/` });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "app shown");
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes(${JSON.stringify(name)}))?.click()`);
    assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length > 0", 15000), "rows");
  };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    admin = await launch(BROWSER); mia = await launch(BROWSER);
    for (const [b, who, isAdmin] of [[admin, "admin", true], [mia, "mia", false]]) { await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn(b, who, isAdmin); }
    const wsA = (await api(admin, "POST", "/workspaces", { name: "Projects space" })).body.workspace, wsB = (await api(admin, "POST", "/workspaces", { name: "Clients space" })).body.workspace;
    await api(admin, "POST", `/workspaces/${wsA.id}/members`, { userId: (await api(mia, "GET", "/me")).body.user.id, role: "MEMBER" }); // not in Clients space
    clients = (await api(admin, "POST", `/workspaces/${wsB.id}/boards`, { name: "Clients", columns: [{ key: "serial", label: "Client", type: "text", required: true }, { key: "value", label: "Value", type: "number" }] })).body.board;
    const made = (await api(admin, "POST", `/boards/${clients.id}/records/batch`, { records: [["Acme", 100], ["Globex", 50], ["Initech", 7]].map(([serial, value]) => ({ values: { serial, value } })) })).body.items;
    ids = Object.fromEntries(made.map((r) => [r.values.serial, r.id]));
    projects = (await api(admin, "POST", `/workspaces/${wsA.id}/boards`, { name: "Projects", columns: [{ key: "serial", label: "Project", type: "text", required: true }, { key: "client", label: "Clients", type: "connect", link: { boardId: clients.id }, multiple: true }, { key: "total", label: "Total value", type: "mirror", mirror: { via: "client", column: "value", show: "sum" } }] })).body.board;
    assert.ok(projects, "board with Connect and Mirror columns");
    assert.equal((await api(admin, "POST", `/boards/${projects.id}/records`, { values: { serial: "Alpha", client: [ids.Acme, ids.Globex] } })).status, 201);
  });
  after(async () => { for (const b of [admin, mia]) await b?.close().catch(() => {}); server?.kill(); });

  test("linked names and the mirrored sum show in the table", async () => {
    await openBoard(admin, "Projects");
    assert.ok(await admin.waitFor(`(() => { const t = [...document.querySelectorAll('tr[data-record-context]')].find((x) => x.textContent.includes('Alpha')); return /150/.test(t?.querySelector('td[data-column-key=total]')?.textContent || ''); })()`, 8000), `mirror: ${await cellText(admin, "total")}`);
    assert.match(await cellText(admin, "client"), /Acme.*Globex/);
    assert.equal(await admin.evaluate("document.querySelectorAll('.relation-partial').length"), 0, "S0-B: complete cells carry no partial mark");
  });

  test("the picker searches the linked board, links and unlinks; the mirror follows; nothing is copied", async () => {
    await admin.evaluate(`(() => { const t = [...document.querySelectorAll('tr[data-record-context]')].find((x) => x.textContent.includes('Alpha')); t.querySelector('td[data-column-key=client] .cell-display').click(); })()`);
    assert.ok(await admin.waitFor("!!document.querySelector('.connect-picker .relation-results [data-action=connect-toggle]')", 8000), "results arrive");
    await admin.evaluate(`(() => { const i = document.querySelector('.connect-picker [data-action=connect-search]'); i.value = 'init'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.ok(await admin.waitFor(`[...document.querySelectorAll('.connect-picker .relation-results label')].map((l) => l.textContent.trim()).join('|') === 'Initech'`, 8000), "search narrows to Initech");
    await admin.evaluate(`(() => { const box = document.querySelector('.connect-picker .relation-results [data-link="${ids.Initech}"]'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(100);
    await admin.evaluate(`(() => { const box = document.querySelector('.connect-picker .is-chosen [data-link="${ids.Globex}"]'); box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(100);
    await admin.evaluate("document.querySelector('.connect-picker').requestSubmit()");
    assert.ok(await admin.waitFor(`(async () => { const r = await (await fetch("/api/v1/boards/${projects.id}/records")).json(); return JSON.stringify(r.items[0].values.client) === JSON.stringify(["${ids.Acme}", "${ids.Initech}"]); })()`, 8000), "saved as record IDs");
    assert.ok(await admin.waitFor(`/107/.test([...document.querySelectorAll('tr[data-record-context]')].find((x) => x.textContent.includes('Alpha'))?.querySelector('td[data-column-key=total]')?.textContent || '')`, 8000), `mirror follows: ${await cellText(admin, "total")}`);
    assert.equal((await api(admin, "GET", `/boards/${clients.id}/records/count`)).body.total, 3, "nothing copied to Clients");
  });

  test("a colleague who can't open the linked board sees a lock: no names, no values", async () => {
    await openBoard(mia, "Projects");
    assert.ok(await mia.waitFor("!!document.querySelector('td[data-column-key=client] .relation-locked')", 8000), "locked");
    assert.equal(await mia.evaluate("[...document.querySelectorAll('.relation-locked')].some((e) => /\\d/.test(e.textContent))"), false, "S0-B: a lock only, no count");
    const text = await mia.evaluate("document.querySelector('.board-view-region')?.textContent || document.body.textContent");
    assert.ok(!/Acme|Initech|107/.test(text), "nothing from Clients on screen");
    // The record drawer shows the same lock (never the stored IDs as choices).
    await mia.evaluate(`[...document.querySelectorAll('tr[data-record-context]')].find((t) => t.textContent.includes('Alpha'))?.querySelector('[data-action=edit]')?.click()`);
    assert.ok(await mia.waitFor("!!document.querySelector('.record-drawer .drawer-relation[data-column-key=client] .relation-locked')", 5000), "drawer: locked");
    const drawer = await mia.evaluate("document.querySelector('.record-drawer').innerHTML");
    for (const id of Object.values(ids)) assert.ok(!drawer.includes(id), "no linked record ID in the drawer");
    await mia.evaluate("document.querySelector('.record-drawer [data-action=close-overlay]')?.click()");
  });

  test("record drawer (admin): linked names and the mirrored value, read-only, no IDs", async () => {
    await openBoard(admin, "Projects");
    assert.ok(await admin.waitFor(`/Acme/.test([...document.querySelectorAll('tr[data-record-context]')].find((x) => x.textContent.includes('Alpha'))?.querySelector('td[data-column-key=client]')?.textContent || '')`, 8000), "names loaded");
    await admin.evaluate(`[...document.querySelectorAll('tr[data-record-context]')].find((t) => t.textContent.includes('Alpha'))?.querySelector('[data-action=edit]')?.click()`);
    assert.ok(await admin.waitFor("/Acme/.test(document.querySelector('.record-drawer .drawer-relation[data-column-key=client]')?.textContent || '')", 5000), "drawer: names");
    assert.ok(await admin.waitFor("/107/.test(document.querySelector('.record-drawer .drawer-relation[data-column-key=total]')?.textContent || '')", 5000), "drawer: mirrored sum");
    assert.equal(await admin.evaluate("document.querySelectorAll('.record-drawer [data-column-key=client] input, .record-drawer [data-column-key=total] input').length"), 0, "read-only: no inputs that could send IDs back");
    assert.equal(await admin.evaluate("document.querySelectorAll('.record-drawer .relation-partial').length"), 0, "complete: no partial mark");
    await admin.evaluate("document.querySelector('.record-drawer [data-action=close-overlay]')?.click()");
  });

  test("a shared view filtering on the Connect column fails safely for the colleague who can't open Clients", async () => {
    const b = (await api(admin, "GET", `/boards/${projects.id}`)).body.board;
    const filter = { op: "and", rules: [{ key: "client", cmp: "notEmpty" }] };
    const saved = await api(admin, "PATCH", `/boards/${projects.id}`, { expectedVersion: b.version, savedViews: [...(b.savedViews || []).filter((v) => !v.personal).map(({ id, name, state }) => ({ id, name, state })), { name: "Linked only", state: { view: "table", filter } }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const viewId = saved.body.board.savedViews.find((v) => v.name === "Linked only").id;
    // The admin (who can open Clients) sees the view's records.
    await openBoard(admin, "Projects");
    await admin.evaluate(`document.querySelector('[data-action=open-view][data-id="${viewId}"]')?.click()`);
    assert.ok(await admin.waitFor("[...document.querySelectorAll('tr[data-record-context]')].some((t) => t.textContent.includes('Alpha'))", 8000), "admin: Alpha matches");
    // Mia: the refusal, no rows, no count, nothing from Clients.
    await openBoard(mia, "Projects");
    await mia.evaluate(`document.querySelector('[data-action=open-view][data-id="${viewId}"]')?.click()`);
    assert.ok(await mia.waitFor("!!document.querySelector('.view-refused')", 8000), "refusal shown");
    const text = (await mia.evaluate("document.querySelector('.view-refused').textContent")).replace(/\s+/g, " ");
    assert.match(text, /This view filters on “Clients”, which links to a board you can't open, so it can't be shown to you\./);
    assert.equal(await mia.evaluate("document.querySelectorAll('tr[data-record-context]').length"), 0, "no records under the view's name");
    const page = await mia.evaluate("document.querySelector('.board-view-region')?.textContent || document.body.textContent");
    assert.ok(!/Acme|Globex|Initech|107|150/.test(page), "nothing from Clients");
    // Choose another view: the views menu opens. Go to Main Table: the records come back.
    await mia.evaluate("document.querySelector('.view-refused [data-action=views-menu]').click()");
    assert.ok(await mia.waitFor("!!document.querySelector('.views-menu')", 3000), "views menu");
    await mia.evaluate("document.querySelector('#overlay-root').innerHTML = ''");
    await mia.evaluate("document.querySelector('.view-refused [data-action=main-table]').click()");
    assert.ok(await mia.waitFor("[...document.querySelectorAll('tr[data-record-context]')].some((t) => t.textContent.includes('Alpha')) && !document.querySelector('.view-refused')", 8000), "Main Table shows the records");
    // The view keeps its condition (nothing stripped by opening it).
    assert.deepEqual((await api(admin, "GET", `/boards/${projects.id}`)).body.board.savedViews.find((v) => v.id === viewId).state.filter, filter);
  });
});
