// Saved view conditions in the REAL app in a headless browser, on the fake MongoDB (role_based): a filtered view on a partly
// loaded board reaches every matching record; totals, group counts, select all, export and bulk edits are complete; a live
// reload from a colleague doesn't lose rows; the condition editor saves; access still applies; Main Table is unchanged.
// Skipped when no Chrome or Edge is installed.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "eng", label: "Engineer", type: "text" }, { key: "state", label: "State", type: "status", options: ["Open", "Done"] }, { key: "notes", label: "Notes", type: "text" }];
const OIDS = { admin: "0d0d0d0d-0000-4000-8000-000000000061", mia: "0d0d0d0d-0000-4000-8000-000000000062", ben: "0d0d0d0d-0000-4000-8000-000000000063", cara: "0d0d0d0d-0000-4000-8000-000000000064" };

describe("Saved view conditions (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, admin, mia, ben, cara, board, viewId, ws;
  const signIn = (b, who, isAdmin = false) => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${who}&email=${who}@example.invalid&admin=${isAdmin ? 1 : 0}&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const api = (b, method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken } ${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const rows = (b) => b.evaluate("document.querySelectorAll('tr[data-record-context]').length");
  const notice = (b) => b.evaluate("(document.querySelector('.records-indicator')?.textContent || '').trim()");
  const toBottom = async (b, times = 14) => { for (let i = 0; i < times; i += 1) { await b.evaluate("(() => { const w = document.querySelector('.board-view-region .table-wrap'); w.scrollTop = w.scrollHeight; })()"); await sleep(150); } };
  const settled = (b) => b.waitFor("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))", 20000);
  const FILTER = { op: "and", rules: [{ key: "eng", cmp: "in", values: ["Zed"] }] };
  const qs = (f) => encodeURIComponent(JSON.stringify(f));
  // Page sizes small enough that the view spans several pages and the board stays partly loaded.
  const openApp = async (b) => {
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Opens first"))?.click()`).catch(() => {}); await sleep(100);
    await b.send("Page.navigate", { url: `${base}/` });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "app shown");
    await b.evaluate("ResourceApiAdapter.FULL_LOAD_LIMIT = 50; ResourceApiAdapter.PAGE_SIZE = 50");
    await sleep(200);
  };
  const openBoard = async (b) => { await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Filter board"))?.click()`); assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length > 0", 15000), "rows"); await sleep(200); };
  const openView = async (b, name = "Zed work") => { await b.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((x) => x.textContent.includes(${JSON.stringify(name)}))?.click()`); assert.ok(await b.waitFor("/\\d records?/.test(document.querySelector('.records-indicator')?.textContent || '')", 15000), "view found its records"); await settled(b); await sleep(150); };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    admin = await launch(BROWSER); mia = await launch(BROWSER); ben = await launch(BROWSER); cara = await launch(BROWSER);
    for (const [b, who, isAdmin] of [[admin, "admin", true], [mia, "mia", false], [ben, "ben", false], [cara, "cara", false]]) { await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn(b, who, isAdmin); }
    ws = (await api(admin, "POST", "/workspaces", { name: "Filters" })).body.workspace;
    await api(admin, "POST", `/workspaces/${ws.id}/members`, { userId: (await api(mia, "GET", "/me")).body.user.id, role: "MEMBER" });
    await api(admin, "POST", `/workspaces/${ws.id}/members`, { userId: (await api(cara, "GET", "/me")).body.user.id, role: "VIEWER" });
    await api(admin, "POST", `/workspaces/${ws.id}/boards`, { name: "Opens first", columns: COLUMNS });
    board = (await api(admin, "POST", `/workspaces/${ws.id}/boards`, { name: "Filter board", columns: COLUMNS, groups: [{ name: "North" }, { name: "South" }] })).body.board;
    // Zed's oldest records sit last in board order, so they are outside what a partly loaded board has loaded.
    const batch = (n, prefix, eng) => Array.from({ length: n }, (_, i) => ({ values: { serial: `${prefix} ${String(i).padStart(3, "0")}`, eng, state: i % 2 ? "Open" : "Done" }, groupId: board.groups[i % 2].id }));
    assert.equal((await api(admin, "POST", `/boards/${board.id}/records/batch`, { records: batch(120, "Zed", "Zed") })).status, 201);
    assert.equal((await api(admin, "POST", `/boards/${board.id}/records/batch`, { records: batch(90, "Other", "Other") })).status, 201);
    board = (await api(admin, "GET", `/boards/${board.id}`)).body.board;
    const patched = await api(admin, "PATCH", `/boards/${board.id}`, { expectedVersion: board.version, savedViews: [{ name: "Zed work", state: { view: "table", hiddenColumns: ["notes"], filter: FILTER, orderBy: [{ key: "serial", dir: "asc" }] } }] });
    assert.equal(patched.status, 200, JSON.stringify(patched.body).slice(0, 200));
    board = patched.body.board; viewId = board.savedViews[0].id;
  });
  after(async () => { for (const b of [admin, mia, ben, cara]) await b?.close(); server?.kill(); });

  test("access still applies: not a member → 404; a viewer can read; a bad filter is refused; a viewer can't change views", async () => {
    const f = `filter=${qs(FILTER)}`;
    assert.equal((await api(ben, "GET", `/boards/${board.id}/records?${f}`)).status, 404);
    assert.equal((await api(ben, "GET", `/boards/${board.id}/records/count?${f}`)).status, 404);
    assert.equal((await api(cara, "GET", `/boards/${board.id}/records/count?${f}`)).body.total, 120);
    for (const bad of ["{", qs({ op: "and", rules: [{ key: "$where", cmp: "in", values: ["1"] }] }), qs({ op: "and", rules: [{ key: "gone", cmp: "in", values: ["1"] }] })]) assert.equal((await api(cara, "GET", `/boards/${board.id}/records?filter=${bad}`)).status, 400);
    const now = (await api(admin, "GET", `/boards/${board.id}`)).body.board;
    assert.equal((await api(cara, "PATCH", `/boards/${board.id}`, { expectedVersion: now.version, savedViews: [] })).status, 403);
  });
  test("Main Table works as before: first page, the whole board's count, no conditions", async () => {
    await openApp(mia); await openBoard(mia);
    assert.ok(await mia.waitFor("/^210 records/.test(document.querySelector('.records-indicator')?.textContent || '')", 8000), await notice(mia));
    assert.equal(await mia.evaluate("!!document.querySelector('.partial-notice')"), false, "the old warning is gone");
    assert.equal(await mia.evaluate("!!document.querySelector('.view-filter-note')"), false);
    assert.equal(await mia.evaluate("document.querySelectorAll('.editable-table thead th[data-column-key]').length"), 4);
  });
  test("a view finds its records beyond what's loaded, with the true total and group counts, in order", async () => {
    await openView(mia);
    assert.match(await notice(mia), /^120 records/);
    assert.match(await mia.evaluate("document.querySelector('.view-filter-note span').textContent"), /Engineer is Zed/);
    assert.deepEqual(await mia.evaluate("[...document.querySelectorAll('.group-count')].map((x) => x.textContent.trim())"), ["60 records", "60 records"]);
    assert.equal(await mia.evaluate("document.querySelectorAll('.editable-table thead th[data-column-key]').length"), 3, "the view's hidden column stays hidden");
    assert.equal(await mia.evaluate("[...document.querySelectorAll('tr[data-record-context]')].every((r) => r.textContent.includes('Zed'))"), true);
    assert.equal(await mia.evaluate("document.querySelector('tr[data-record-context] td[data-column-key=serial]').textContent.trim()"), "Zed 000", "the view's sort");
    await toBottom(mia);
    assert.ok(await mia.waitFor("[...document.querySelectorAll('tr[data-record-context]')].some((r) => /Zed 11[0-9]/.test(r.textContent))", 8000), "scrolling reached the last records");
    assert.ok(await rows(mia) <= 90, `only rows near the viewport are in the page: ${await rows(mia)}`);
    assert.deepEqual(await mia.evaluate("[...document.querySelectorAll('.group-count')].map((x) => x.textContent.trim())"), ["60 records", "60 records"], "still the true totals");
  });
  test("sorting and filtering a partly loaded board use every record, and stay in place as more rows arrive", async () => {
    await openApp(mia); await openBoard(mia);
    const firstCell = () => mia.evaluate("(document.querySelector('tr[data-record-context] td[data-column-key=serial]')?.textContent || '').trim()");
    const sortBy = async (dir) => {
      await mia.evaluate("document.querySelector('th[data-column-key=serial] [data-action=column-menu]').click()"); await sleep(120);
      assert.equal(await mia.evaluate(`(() => { const el = document.querySelector('[data-action=sort-column][data-key=serial][data-direction=${dir}]'); el?.click(); return !!el; })()`), true);
      await sleep(500); await mia.waitFor("document.querySelectorAll('tr[data-record-context]').length > 0", 8000); await settled(mia); await sleep(200);
    };
    await sortBy("desc");
    assert.equal(await firstCell(), "Zed 118", "the true last record of the first group, which wasn't loaded");
    assert.equal(await mia.evaluate("document.querySelector('th[data-column-key=serial]').getAttribute('aria-sort')"), "descending");
    await toBottom(mia, 3);
    assert.equal(await mia.evaluate("document.querySelector('th[data-column-key=serial]').getAttribute('aria-sort')"), "descending", "the sort survives rows arriving");
    await mia.evaluate("document.querySelector('.board-view-region .table-wrap').scrollTop = 0"); await sleep(250);
    assert.equal(await firstCell(), "Zed 118");
    await sortBy("asc");
    assert.equal(await firstCell(), "Other 000");
    await mia.evaluate("document.querySelector('[data-action=toolbar-menu][data-menu=filter]').click()"); await sleep(150);
    assert.equal(await mia.evaluate("(() => { const el = document.querySelector('.toolbar-menu-popover [data-action=toolbar-choose][data-menu=status][data-value=Done]'); el?.click(); return !!el; })()"), true);
    assert.ok(await mia.waitFor("/^105 records/.test(document.querySelector('.records-indicator')?.textContent || '')", 8000), `every record counts: ${await notice(mia)}`);
  });
  test("select all takes every record in the view, and export contains them all", async () => {
    await openApp(mia); await openBoard(mia); await openView(mia);
    assert.match(await notice(mia), /^120 records/);
    await mia.evaluate("document.querySelector('input[data-action=select-all]').click()");
    assert.ok(await mia.waitFor("document.querySelector('.bulk-bar')?.getAttribute('aria-label') === '120 records selected'", 10000), "120 selected, not just those on the page");
    await mia.evaluate("document.querySelector('input[data-action=select-all]').click()"); await settled(mia);
    await mia.evaluate("(() => { const o = URL.createObjectURL; URL.createObjectURL = (blob) => { blob.text().then((t) => { window.__csv = t; }); return o.call(URL, blob); }; })()");
    await mia.evaluate("document.querySelector('[data-action=export]').click()");
    assert.ok(await mia.waitFor("window.__csv !== undefined", 8000));
    const lines = await mia.evaluate("window.__csv.split('\\n').length");
    assert.equal(lines, 121, "the header and all 120 records");
    assert.equal(await mia.evaluate("window.__csv.includes('Other 0')"), false);
  });
  test("Select all past its limit selects nothing and says so in a message that stays; Export isn't limited", async () => {
    await openApp(mia); await openBoard(mia); await openView(mia);
    await mia.evaluate("BoardModel.SELECT_ALL_LIMIT = 100");
    await mia.evaluate("document.querySelector('input[data-action=select-all]').click()");
    assert.ok(await mia.waitFor("/Nothing was selected/.test(document.querySelector('#overlay-root')?.textContent || '')", 8000), "told, not silently partial");
    const message = await mia.evaluate("document.querySelector('#overlay-root').textContent");
    assert.match(message, /120 records/); assert.match(message, /up to 100/); assert.match(message, /Export/);
    assert.equal(await mia.evaluate("!!document.querySelector('.bulk-bar')"), false, "nothing selected");
    await mia.evaluate("document.querySelector('[data-action=close-overlay]')?.click()"); await settled(mia);
    await mia.evaluate("(() => { const o = URL.createObjectURL; URL.createObjectURL = (blob) => { blob.text().then((t) => { window.__csv = t; }); return o.call(URL, blob); }; })()");
    await mia.evaluate("document.querySelector('[data-action=export]').click()");
    assert.ok(await mia.waitFor("window.__csv !== undefined", 8000));
    assert.equal(await mia.evaluate("window.__csv.split('\\n').length"), 121, "the header and all 120 records");
    assert.equal(await mia.evaluate("new Set(window.__csv.split('\\n')).size"), 121, "no line twice");
    assert.match(await mia.evaluate("document.querySelector('#toast-region').textContent"), /120 records exported/);
    await mia.evaluate("BoardModel.SELECT_ALL_LIMIT = 5000");
  });
  test("an export that fails partway downloads nothing and says so", async () => {
    await openApp(mia); await openBoard(mia); await openView(mia);
    await mia.evaluate(`(() => { window.__downloads = 0; const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__downloads += 1; return o.call(URL, b); }; const load = ResourceApiAdapter.prototype.loadFiltered; let calls = 0; ResourceApiAdapter.prototype.loadFiltered = function (...a) { calls += 1; if (calls === 2) { ResourceApiAdapter.prototype.loadFiltered = load; return Promise.reject(new Error("lost")); } return load.apply(this, a); }; })()`);
    await mia.evaluate("ResourceApiAdapter.PAGE_SIZE = 50");
    await mia.evaluate("BoardModel.prototype.eachMatchingPage = (function (o) { return function (fn) { const s = this.storage, l = s.loadFiltered.bind(s); s.loadFiltered = (b, q) => l(b, { ...q, limit: 50 }); return o.call(this, fn).finally(() => { s.loadFiltered = l; }); }; })(BoardModel.prototype.eachMatchingPage)");
    await mia.evaluate("document.querySelector('[data-action=export]').click()");
    assert.ok(await mia.waitFor("/Nothing was downloaded/.test(document.querySelector('#toast-region')?.textContent || '')", 8000));
    assert.equal(await mia.evaluate("window.__downloads"), 0);
  });
  test("the selection's export has every selected record, also those a later search hides", async () => {
    await openApp(mia); await openBoard(mia); await openView(mia);
    assert.ok(await mia.waitFor("document.querySelectorAll('tr[data-record-context] [data-action=select]').length >= 2", 8000));
    await mia.evaluate("document.querySelectorAll('tr[data-record-context] [data-action=select]')[0].click()"); await settled(mia);
    await mia.evaluate("document.querySelectorAll('tr[data-record-context] [data-action=select]')[1].click()"); await settled(mia);
    assert.equal(await mia.evaluate("document.querySelector('.bulk-bar')?.getAttribute('aria-label')"), "2 records selected");
    await mia.evaluate("(() => { const i = document.querySelector('#board-search'); i.value = 'zzqxzzq'; i.dispatchEvent(new Event('input', { bubbles: true })); })()"); await settled(mia);
    await mia.evaluate("(() => { const o = URL.createObjectURL; URL.createObjectURL = (blob) => { blob.text().then((t) => { window.__csv = t; }); return o.call(URL, blob); }; })()");
    await mia.evaluate("document.querySelector('[data-action=bulk-export]').click()");
    assert.ok(await mia.waitFor("window.__csv !== undefined", 8000));
    assert.equal(await mia.evaluate("window.__csv.split('\\n').length"), 3, "the header and both records");
    await mia.evaluate("(() => { const i = document.querySelector('#board-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await mia.evaluate("document.querySelector('[data-action=clear-selection]')?.click()"); await settled(mia);
  });
  test("while search runs in the browser, Export takes the searched records from the whole view, loaded or not, and nothing else", async () => {
    await openApp(mia); await openBoard(mia);
    // Small pages, so most of the view is still on the server when the export starts.
    await mia.evaluate("(() => { const o = BoardModel.prototype.loadServerPage; BoardModel.prototype.loadServerPage = function (g, opts) { return o.call(this, g, { ...opts, limit: 5 }); }; })()");
    await openView(mia);
    assert.equal(await mia.evaluate("document.querySelectorAll('tr[data-record-context]').length < 120"), true);
    await mia.evaluate("(() => { const i = document.querySelector('#board-search'); i.value = 'Zed 11'; i.dispatchEvent(new Event('input', { bubbles: true })); })()"); await settled(mia);
    await mia.evaluate("(() => { const o = URL.createObjectURL; URL.createObjectURL = (blob) => { blob.text().then((t) => { window.__csv = t; }); return o.call(URL, blob); }; })()");
    await mia.evaluate("document.querySelector('[data-action=export]').click()");
    assert.ok(await mia.waitFor("window.__csv !== undefined", 8000));
    const rows = (await mia.evaluate("window.__csv")).split("\n").slice(1);
    assert.equal(rows.length, 10, "Zed 110 to Zed 119");
    assert.ok(rows.every((r) => /Zed 11\d/.test(r)), "only what was searched for");
    assert.match(await mia.evaluate("document.querySelector('#toast-region').textContent"), /10 matching records exported/);
    await mia.evaluate("(() => { const i = document.querySelector('#board-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()"); await settled(mia);
  });
  test("scrolling keeps every row in its place: rows only enter and leave, none repeat, and nothing is missing", async () => {
    await openApp(mia); await openBoard(mia); await openView(mia);
    await mia.evaluate("window.__moved = 0; (() => { const o = AppView.prototype.moveGroupWindow; AppView.prototype.moveGroupWindow = function (...a) { const r = o.apply(this, a); if (r) window.__moved += 1; return r; }; })()");
    const seen = new Set();
    for (let i = 0; i < 90; i += 1) {
      await mia.evaluate("document.querySelector('.board-view-region .table-wrap').scrollTop += 120"); await settled(mia);
      const { ids, dup, gapless } = await mia.evaluate(`(() => {
        const ids = [...document.querySelectorAll('tr[data-record-context]')].map((tr) => tr.dataset.recordContext);
        // Each group's body: heading, optional spacer, consecutive rows, optional spacer: never a spacer between rows.
        const gapless = [...document.querySelectorAll('tbody[data-window-key]')].every((b) => { const kinds = [...b.children].map((tr) => tr.matches('[data-record-context]') ? 'r' : tr.matches('.row-spacer:not(.row-reserved)') ? 's' : 'o').join(''); return !/r[so]+r/.test(kinds); });
        return { ids, dup: ids.length - new Set(ids).size, gapless };
      })()`);
      assert.equal(dup, 0, "no row twice on the page"); assert.equal(gapless, true, "rows stay together");
      ids.forEach((id) => seen.add(id));
    }
    assert.equal(seen.size, 120, "every record of the view was reachable by scrolling");
    assert.ok(await mia.evaluate("window.__moved") > 0, "rows moved without redrawing the group");
    assert.match(await notice(mia), /^120 records/);
    await mia.evaluate("document.querySelector('.board-view-region .table-wrap').scrollTop = 0"); await settled(mia);
    assert.ok(await mia.waitFor("document.querySelectorAll('tr[data-record-context]').length > 5", 5000), "and back at the top");
    assert.equal(await mia.evaluate("document.querySelector('input[data-action=select-all]').disabled"), false, "Select all works");
  });
  test("a colleague's batch change while a view is open: nothing is lost, and the total follows", async () => {
    await openApp(mia); await openBoard(mia); await openView(mia);
    await toBottom(mia, 6);
    const added = await api(admin, "POST", `/boards/${board.id}/records/batch`, { records: Array.from({ length: 30 }, (_, i) => ({ values: { serial: `Zed new ${i}`, eng: "Zed" } })) });
    assert.equal(added.status, 201);
    assert.ok(await mia.waitFor("/^150 records/.test(document.querySelector('.records-indicator')?.textContent || '')", 15000), `the total follows: ${await notice(mia)}`);
    assert.equal(await mia.evaluate("[...document.querySelectorAll('tr[data-record-context]')].every((r) => r.textContent.includes('Zed'))"), true, "only this view's records");
    await mia.evaluate("document.querySelector('input[data-action=select-all]').click()");
    assert.ok(await mia.waitFor("document.querySelector('.bulk-bar')?.getAttribute('aria-label') === '150 records selected'", 10000), "select all still reaches every record after the reload");
    await mia.evaluate("document.querySelector('input[data-action=select-all]').click()"); await settled(mia);
    const main = await (async () => { await mia.evaluate("document.querySelector('[data-action=main-table]').click()"); await settled(mia); await mia.waitFor("/^\d/.test(document.querySelector('.records-indicator')?.textContent || '')", 8000); return notice(mia); })();
    assert.match(main, /^240 records/, "Main Table keeps the whole board's count after a partial reload");
  });
  test("a bulk edit reaches all the view's records; the total follows; records outside it are untouched", async () => {
    await openApp(mia); await openBoard(mia); await openView(mia);
    await mia.evaluate("document.querySelector('input[data-action=select-all]').click()");
    assert.ok(await mia.waitFor("/^150 records selected$/.test(document.querySelector('.bulk-bar')?.getAttribute('aria-label') || '')", 10000));
    await mia.evaluate("document.querySelector('[data-action=bulk-archive]').click()");
    await sleep(100);
    await mia.evaluate("document.querySelector('[data-action=confirm-bulk-archive], .modal [data-action=bulk-archive-go]')?.click()");
    assert.ok(await mia.waitFor(`(async () => { const r = await fetch("/api/v1/boards/${board.id}/records/count?filter=${qs(FILTER)}"); const j = await r.json(); return j.total === 0; })()`, 20000), "all 150 archived on the server");
    assert.equal((await api(admin, "GET", `/boards/${board.id}/records/count?filter=${qs({ op: "and", rules: [{ key: "eng", cmp: "in", values: ["Other"] }] })}`)).body.total, 90, "others untouched");
    assert.equal((await api(admin, "GET", `/boards/${board.id}/records/count?archived=true&filter=${qs(FILTER)}`)).body.total, 150);
  });
  test("the condition editor: add a condition, choose any/all, apply, save with the view, still there after a reload", async () => {
    await openApp(admin); await openBoard(admin); await openView(admin, "Zed work");
    await admin.evaluate("document.querySelector('.view-filter-note [data-action=view-filter]').click()"); await sleep(150);
    assert.equal(await admin.evaluate("document.querySelectorAll('.view-filter-rule').length"), 1);
    await admin.evaluate("document.querySelector('[data-action=view-filter-add]').click()"); await sleep(100);
    await admin.evaluate(`(() => { const row = document.querySelectorAll('.view-filter-rule')[1]; row.querySelector('[name=key]').value = 'eng'; row.querySelector('[name=values]').value = 'Other'; document.querySelector('.view-filter-form [name=op]').value = 'or'; document.querySelector('.view-filter-form').requestSubmit(); })()`);
    assert.ok(await admin.waitFor("/^90 records/.test(document.querySelector('.records-indicator')?.textContent || '')", 8000), `any-of: ${await notice(admin)}`);
    assert.match(await admin.evaluate("document.querySelector('.view-filter-note span').textContent"), /Engineer is Zed or Engineer is Other/);
    const before = (await api(admin, "GET", `/boards/${board.id}`)).body.board.savedViews[0].state.filter;
    assert.deepEqual(before, FILTER, "applying doesn't change the saved view by itself");
    await admin.evaluate("document.querySelector('[data-action=view-menu]').click()"); await sleep(120);
    await admin.evaluate(`[...document.querySelectorAll('.view-menu button')].find((x) => /save/i.test(x.textContent))?.click()`);
    assert.ok(await admin.waitFor(`(async () => { const r = await (await fetch("/api/v1/boards/${board.id}")).json(); return r.board.savedViews[0].state.filter?.op === "or"; })()`, 8000), "saved with the view");
    await openApp(admin); await openBoard(admin); await openView(admin, "Zed work");
    assert.match(await admin.evaluate("document.querySelector('.view-filter-note span').textContent"), /Zed or Engineer is Other/);
  });
  test("a column deleted later drops out of a view's conditions without breaking it", async () => {
    const now = (await api(admin, "GET", `/boards/${board.id}`)).body.board;
    const views = now.savedViews.map(({ id, name, state }) => ({ id, name, state })).concat({ name: "By notes", state: { view: "table", filter: { op: "and", rules: [{ key: "notes", cmp: "empty" }] } } });
    const saved = (await api(admin, "PATCH", `/boards/${board.id}`, { expectedVersion: now.version, savedViews: views })).body.board;
    const gone = await api(admin, "DELETE", `/boards/${board.id}/columns/notes?expectedVersion=${saved.version}`);
    assert.equal(gone.status, 200, JSON.stringify(gone.body).slice(0, 160));
    await openApp(admin); await openBoard(admin);
    await admin.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((x) => x.textContent.includes("By notes"))?.click()`);
    await sleep(500); await settled(admin);
    assert.equal(await admin.evaluate("!!document.querySelector('.view-filter-note')"), false);
    assert.ok(await rows(admin) > 0);
  });
});
