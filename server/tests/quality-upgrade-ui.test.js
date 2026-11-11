// Q1.2/Q1.3/Q1.4/Q1.5/Q1.6 and Ctrl + D in the REAL app (headless Chrome or Edge, TEST server on the fake MongoDB, local
// Entra test keys): collapse all groups by keyboard and from the group menu, the System Health page for administrators
// (and not for employees), Activity History filters, file type labels, download-only previews and the duplicate-upload
// guard, and the new pages at phone width. Skipped when no browser is installed.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const GROUPS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "Empty"];
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("Quality upgrade (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, ws, big, second;
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken } ${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const signIn = (oid, name, admin) => b.evaluate(`(async () => { await fetch("/api/v1/auth/session", { method: "DELETE", headers: { "X-CSRF-Token": (await (await fetch("/api/v1/auth/session")).json()).csrfToken || "" } }).catch(() => {}); const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${oid}&name=${name}&email=${name.toLowerCase()}@example.invalid&admin=${admin ? 1 : 0}&nonce=" + start.nonce)).json(); const r = await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); return r.status; })()`);
  const reload = async () => { await b.send("Page.navigate", { url: `${base}/` }); assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item, #sidebar .nav-item')", 20000), "app shown"); await sleep(300); };
  const open = async (name) => { await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes(${JSON.stringify(name)}))?.click()`); assert.ok(await b.waitFor("!!document.querySelector('tbody.board-group[data-group]')", 20000), `${name} shows groups`); await sleep(300); };
  const expanded = () => b.evaluate("[...document.querySelectorAll('tbody.board-group[data-group]:not(.is-loose)')].filter((g) => !g.classList.contains('is-collapsed')).map((g) => g.dataset.group)");
  const counts = () => b.evaluate("[...document.querySelectorAll('tbody.board-group[data-group]')].map((g) => g.dataset.group + ':' + (g.querySelector('.group-count')?.textContent.trim() || ''))");
  const order = () => b.evaluate("[...document.querySelectorAll('tbody.board-group[data-group]')].map((g) => g.dataset.group + '|' + getComputedStyle(g).getPropertyValue('--group-color').trim())");
  const stats = async () => JSON.parse(await b.evaluate("fetch('/__test/stats').then((r) => r.text())")).protected;
  // A key press as the browser sends it; → whether the page called preventDefault (the bookmark dialog stays shut).
  const press = (target, init) => b.evaluate(`(() => { const el = ${target}; const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...${JSON.stringify(init)} }); el.dispatchEvent(e); return e.defaultPrevented; })()`);
  const ctrlD = (target = "document.activeElement || document.body") => press(target, { key: "d", code: "KeyD", ctrlKey: true });
  const expandAll = async () => { await b.evaluate("document.querySelectorAll('[data-action=\"group-toggle\"][aria-expanded=\"false\"]').forEach((t) => t.click())"); await sleep(150); };
  const toastText = () => b.evaluate("document.querySelector('#toast-region')?.textContent || ''");

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    b = await launch();
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.equal(await signIn("0d0d0d0d-0000-4000-8000-0000000000c1", "Admin", true), 201);
    ws = (await api("POST", "/workspaces", { name: "Quality" })).body.workspace;
    const columns = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "notes", label: "Notes", type: "text" }, { key: "docs", label: "Documents", type: "files" }];
    big = (await api("POST", `/workspaces/${ws.id}/boards`, { name: "Big board", columns, groups: GROUPS.map((g, i) => ({ id: `grp_q${i}xxxx`, name: g })) })).body.board;
    second = (await api("POST", `/workspaces/${ws.id}/boards`, { name: "Second board", columns, groups: [{ id: "grp_s0xxxx", name: "Own one" }, { id: "grp_s1xxxx", name: "Own two" }] })).body.board;
    // 400 records over the first 8 groups (a large board: row window on); "Empty" has none.
    for (let start = 0; start < 400; start += 100) {
      const records = Array.from({ length: 100 }, (_, k) => { const i = start + k; return { values: { serial: `Q ${String(i).padStart(3, "0")}`, notes: i % 50 === 0 ? "findme" : "" }, groupId: big.groups[i % 8].id }; });
      assert.equal((await api("POST", `/boards/${big.id}/records/batch`, { records })).status, 201);
    }
    assert.equal((await api("POST", `/boards/${second.id}/records/batch`, { records: [{ values: { serial: "S 1" }, groupId: second.groups[0].id }, { values: { serial: "S 2" }, groupId: second.groups[1].id }] })).status, 201);
    await reload();
  });
  after(async () => { await b?.close(); server?.kill(); });

  describe("Ctrl + D collapses all groups", () => {
    test("every expanded group collapses at once; order, colours and record counts are unchanged; nothing is sent to the server", async () => {
      await open("Big board");
      await expandAll();
      const beforeCounts = await counts(), beforeOrder = await order();
      assert.ok((await expanded()).length >= 8, "groups start expanded");
      assert.ok(beforeCounts.includes("Alpha:50 records") && beforeCounts.includes("Empty:0 records"), JSON.stringify(beforeCounts));
      await b.evaluate("document.body.focus()");
      const records = async () => JSON.stringify((await api("GET", `/boards/${big.id}/records?limit=200`)).body.items.map((r) => [r.id, r.version, r.updatedAt, r.groupId, r.position]));
      const recordsBefore = await records();
      const requests = await stats();
      assert.equal(await ctrlD("document.body"), true, "the browser's own Ctrl + D (bookmark) is prevented");
      await sleep(400);
      assert.deepEqual(await expanded(), []);
      assert.deepEqual(await counts(), beforeCounts, "counts unchanged");
      assert.deepEqual(await order(), beforeOrder, "order and colours unchanged");
      assert.equal(await b.evaluate("document.querySelectorAll('tr[data-record-context]').length"), 0, "collapsed groups render no rows");
      assert.equal(await stats(), requests, "no API request at all (so no database write)");
      assert.match(await toastText(), /Collapsed \d+ groups?/);
      assert.equal(await records(), recordsBefore, "no record changed: versions, dates, groups and positions are identical");
    });
    test("the collapsed state is kept as this person's preference, in this browser, and survives a reload", async () => {
      await reload();
      await open("Big board");
      assert.deepEqual(await expanded(), [], "still collapsed after a reload");
      assert.ok(await b.evaluate("Object.keys(localStorage).some((k) => (localStorage.getItem(k) || '').includes('collapsedGroups'))"), "kept in this browser's storage");
    });
    test("already collapsed: stays collapsed, says so, and still sends nothing", async () => {
      const requests = await stats();
      assert.equal(await ctrlD("document.body"), true);
      await sleep(200);
      assert.deepEqual(await expanded(), []);
      assert.match(await toastText(), /already collapsed/);
      assert.equal(await stats(), requests);
    });
    test("one expanded group (opened with the mouse) collapses; the mouse toggle keeps working afterwards", async () => {
      await b.evaluate("document.querySelector('.board-group[data-group=\"Charlie\"] [data-action=\"group-toggle\"]').click()"); await sleep(200);
      assert.deepEqual(await expanded(), ["Charlie"]);
      assert.ok(await b.evaluate("document.querySelectorAll('.board-group[data-group=\"Charlie\"] tr[data-record-context]').length") > 0);
      await b.evaluate("document.body.focus()");
      await ctrlD("document.body"); await sleep(200);
      assert.deepEqual(await expanded(), []);
      await b.evaluate("document.querySelector('.board-group[data-group=\"Delta\"] [data-action=\"group-toggle\"]').click()"); await sleep(200);
      assert.deepEqual(await expanded(), ["Delta"], "mouse expand still works");
      await b.evaluate("document.querySelector('.board-group[data-group=\"Delta\"] [data-action=\"group-toggle\"]').click()"); await sleep(200);
      assert.deepEqual(await expanded(), [], "mouse collapse still works");
    });
    test("focus inside a group's rows moves to that group's toggle; ⌘ D works too", async () => {
      await expandAll();
      const focused = await b.evaluate("(() => { const c = document.querySelector('.board-group[data-group=\"Alpha\"] tr[data-record-context] .cell-display'); c?.focus(); return document.activeElement === c; })()");
      assert.ok(focused, "a cell has focus");
      assert.equal(await press("document.activeElement", { key: "d", code: "KeyD", metaKey: true }), true);
      await sleep(300);
      assert.deepEqual(await expanded(), []);
      assert.deepEqual(await b.evaluate("[document.activeElement?.dataset.action, document.activeElement?.closest('.board-group')?.dataset.group]"), ["group-toggle", "Alpha"]);
      assert.equal(await b.evaluate("document.activeElement.getAttribute('aria-expanded')"), "false");
    });
    test("not while typing: board search, then the Notes cell editor", async () => {
      await expandAll();
      const groups = (await expanded()).length;
      const prevented = await b.evaluate("(() => { const i = [...document.querySelectorAll('input')].find((x) => /search/i.test(x.placeholder || '') && !x.closest('#sidebar')); i.focus(); const e = new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true }); i.dispatchEvent(e); return e.defaultPrevented; })()");
      assert.equal(prevented, false, "left to the browser");
      await sleep(200);
      assert.equal((await expanded()).length, groups, "nothing collapsed");
      const area = await b.evaluate("(() => { const t = document.createElement('textarea'); t.id = 'probe-textarea'; document.querySelector('.board-groups').prepend(t); t.focus(); const e = new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true }); t.dispatchEvent(e); t.remove(); return e.defaultPrevented; })()");
      assert.equal(area, false);
      const editable = await b.evaluate("(() => { const d = document.createElement('div'); d.contentEditable = 'true'; document.querySelector('.board-groups').prepend(d); d.focus(); const e = new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true }); d.dispatchEvent(e); d.remove(); return e.defaultPrevented; })()");
      assert.equal(editable, false);
      assert.equal((await expanded()).length, groups);
    });
    test("not with a dialog or menu open", async () => {
      await b.evaluate("document.querySelector('[data-action=\"shortcuts\"]').click()"); await sleep(200);
      assert.ok(await b.evaluate("!!document.querySelector('#overlay-root .modal')"), "the shortcuts dialog is open");
      assert.ok(await b.evaluate("document.querySelector('#overlay-root').textContent.includes('Collapse all groups')"), "the shortcut is listed");
      const groups = (await expanded()).length;
      assert.equal(await ctrlD("document.querySelector('#overlay-root .modal') || document.body"), false);
      assert.equal(await ctrlD("document.body"), false);
      await sleep(150);
      assert.equal((await expanded()).length, groups, "nothing collapsed under a dialog");
      await press("document.activeElement || document.body", { key: "Escape" }); await sleep(150);
    });
    test("the group menu's Collapse all groups (the visible fallback) does the same, shows the shortcut, and keeps keyboard focus", async () => {
      await expandAll();
      const requests = await stats();
      await b.evaluate("document.querySelector('.board-group[data-group=\"Echo\"] [data-action=\"group-menu\"]').click()"); await sleep(200);
      const item = await b.evaluate("(() => { const el = document.querySelector('#overlay-root [data-action=\"group-collapse-all\"]'); return el ? { text: el.textContent.trim(), keys: el.getAttribute('aria-keyshortcuts') } : null; })()");
      assert.ok(item && /Collapse all groups/.test(item.text) && /Ctrl D|⌘ D/.test(item.text) && /Control\+D/.test(item.keys), JSON.stringify(item));
      await b.evaluate("document.querySelector('#overlay-root [data-action=\"group-collapse-all\"]').click()"); await sleep(300);
      assert.deepEqual(await expanded(), []);
      assert.equal(await b.evaluate("document.querySelector('#overlay-root').children.length"), 0, "the menu closed");
      assert.equal(await b.evaluate("document.activeElement?.dataset.action"), "group-toggle", "focus lands on a group toggle, not lost");
      assert.equal(await stats(), requests, "nothing sent to the server");
      // "Expand all groups" (existing) still works.
      await b.evaluate("document.querySelector('.board-group[data-group=\"Echo\"] [data-action=\"group-menu\"]').click()"); await sleep(200);
      await b.evaluate("document.querySelector('#overlay-root [data-action=\"group-expand-all\"]').click()"); await sleep(300);
      assert.ok((await expanded()).length >= 8);
    });
    test("a filtered board: the shortcut works, counts stay true, and clearing the filter keeps the groups collapsed", async () => {
      await b.evaluate("(() => { const i = [...document.querySelectorAll('input')].find((x) => /search/i.test(x.placeholder || '') && !x.closest('#sidebar')); i.value = 'findme'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await sleep(600);
      const filtered = await counts();
      assert.ok(filtered.length >= 1);
      await b.evaluate("document.activeElement?.blur(); document.body.focus()");
      assert.equal(await ctrlD("document.body"), true);
      await sleep(300);
      assert.deepEqual(await expanded(), []);
      assert.deepEqual(await counts(), filtered, "filtered counts unchanged");
      await b.evaluate("(() => { const i = [...document.querySelectorAll('input')].find((x) => /search/i.test(x.placeholder || '') && !x.closest('#sidebar')); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await sleep(600);
      assert.deepEqual(await expanded(), [], "still collapsed with the filter cleared");
    });
    test("another board's groups are untouched", async () => {
      await open("Second board");
      assert.deepEqual(await expanded(), ["Own one", "Own two"]);
      await open("Big board");
      assert.deepEqual(await expanded(), [], "the big board kept its collapsed groups");
      await expandAll();
    });
    test("not on another screen (Home): the key is left to the browser", async () => {
      await b.evaluate("document.querySelector('[data-action=\"nav\"][data-screen=\"home\"]').click()"); await sleep(300);
      assert.equal(await ctrlD("document.body"), false);
      await open("Big board");
    });
  });

  describe("System Health (administrators)", () => {
    test("the page shows backend, database, timings, endpoints and jobs; tabs switch; Activity History lists and filters", async () => {
      await b.evaluate("document.querySelector('[data-action=\"nav\"][data-screen=\"system-health\"]').click()");
      assert.ok(await b.waitFor("!!document.querySelector('.health-tiles')", 15000), "tiles shown");
      const tiles = await b.evaluate("document.querySelector('.health-tiles').textContent");
      assert.match(tiles, /Healthy/); assert.match(tiles, /Connected/); assert.match(tiles, /p95/);
      assert.ok(await b.evaluate("[...document.querySelectorAll('.health-table code')].some((c) => /boards\\/:boardId/.test(c.textContent))"), "endpoints by route pattern");
      assert.ok(await b.evaluate("!document.querySelector('#health-root').innerHTML.includes(" + JSON.stringify(big.id) + ")"), "no IDs from URLs in System Health");
      await b.evaluate("document.querySelector('[data-action=\"health-tab\"][data-tab=\"integrations\"]').click()"); await sleep(300);
      assert.match(await b.evaluate("document.querySelector('#health-root').textContent"), /monday\.com[\s\S]*Google Drive/);
      await b.evaluate("document.querySelector('[data-action=\"health-tab\"][data-tab=\"activity\"]').click()");
      assert.ok(await b.waitFor("!!document.querySelector('.health-activity-list tbody tr')", 15000), "activity listed");
      assert.match(await b.evaluate("document.querySelector('.health-activity-list').textContent"), /Admin (added records|created a board)/);
      await b.evaluate("(() => { const f = document.querySelector('.health-filters'); f.querySelector('[name=action]').value = 'board.'; f.requestSubmit(); })()");
      await sleep(600);
      const types = await b.evaluate("[...document.querySelectorAll('.health-activity-list tbody tr td[data-label=\"Type\"]')].map((td) => td.textContent.trim())");
      assert.ok(types.length >= 2 && types.every((t) => t.startsWith("board.")), JSON.stringify(types));
      await b.evaluate("(() => { const f = document.querySelector('.health-filters'); f.querySelector('[name=action]').value = ''; f.querySelector('[name=q]').value = 'nothing-matches-this'; f.requestSubmit(); })()");
      await sleep(600);
      assert.match(await b.evaluate("document.querySelector('#health-root').textContent"), /No activity matches/);
      await b.evaluate("document.querySelector('[data-action=\"health-activity-clear\"]').click()"); await sleep(600);
      assert.ok(await b.evaluate("document.querySelectorAll('.health-activity-list tbody tr').length") >= 2);
    });
    test("at phone width the page fits without sideways scrolling", async () => {
      await b.open(`${base}/`, { width: 390, height: 844 });
      await sleep(300);
      await b.evaluate("document.querySelector('[data-action=\"toggle-nav\"]')?.click()"); await sleep(200);
      await b.evaluate("document.querySelector('[data-action=\"nav\"][data-screen=\"system-health\"]')?.click()");
      assert.ok(await b.waitFor("!!document.querySelector('#health-root')", 15000));
      await b.evaluate("document.querySelector('[data-action=\"health-tab\"][data-tab=\"overview\"]').click()");
      assert.ok(await b.waitFor("!!document.querySelector('.health-tiles')", 15000));
      assert.ok(await b.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), `page width ${await b.evaluate("document.documentElement.scrollWidth")}`);
      await b.open(`${base}/`, { width: 1440, height: 900 }); await sleep(300);
    });
    test("an employee without JARC.Admin sees no System Health link, a notice if they get there, and the server refuses the data", async () => {
      assert.equal(await signIn("0d0d0d0d-0000-4000-8000-0000000000c2", "Worker", false), 201);
      await reload();
      assert.equal(await b.evaluate("!!document.querySelector('[data-action=\"nav\"][data-screen=\"system-health\"]')"), false);
      assert.equal((await api("GET", "/admin/system-health")).status, 403);
      assert.equal((await api("GET", "/admin/activity")).status, 403);
      assert.equal(await signIn("0d0d0d0d-0000-4000-8000-0000000000c1", "Admin", true), 201);
      await reload();
    });
  });

  describe("Files: type labels, download-only previews and the duplicate guard", () => {
    test("HEIC and CSV (from the monday.com import) are labelled correctly and are download-only; images and PDFs preview", async () => {
      const r = await b.evaluate(`(() => { const v = Object.create(AppView.prototype); return { heic: v.fileKind("image/heic", "a.heic"), csv: v.fileKind("text/csv", "a.csv"), jpg: v.fileKind("image/jpeg", "a.jpg"), unknown: v.fileKind("application/x-thing", "report.docx"), none: v.fileKind("", "noext"), pHeic: v.previewKind({ type: "image/heic" }), pCsv: v.previewKind({ type: "text/csv" }), pPng: v.previewKind({ type: "image/png" }), pPdf: v.previewKind({ type: "application/pdf" }) }; })()`);
      assert.deepEqual(r, { heic: "HEIC", csv: "CSV", jpg: "JPEG", unknown: "DOCX", none: "File", pHeic: null, pCsv: null, pPng: "image", pPdf: "pdf" });
      // The preview of a HEIC file says at once that it can't be shown, and offers the download (no broken image, no spinner).
      const preview = await b.evaluate(`(() => { const v = Object.create(AppView.prototype); v.root = document.querySelector('#app'); const model = { attachmentUrl: (id, o) => "/api/v1/attachments/" + id + (o?.download ? "?download=1" : "") }; v.showFilePreview(model, { id: "r1" }, { key: "docs", label: "Documents" }, { id: "a1", name: "photo.heic", type: "image/heic", size: 2048 }); const body = document.querySelector('#overlay-root .file-preview-body'); const out = { state: body.dataset.previewState, img: !!body.querySelector('img'), text: body.querySelector('.file-preview-failed').textContent, download: !!document.querySelector('#overlay-root [data-action="download-file"]'), newTab: [...document.querySelectorAll('#overlay-root a')].some((a) => /new tab/i.test(a.textContent)) }; document.querySelector('#overlay-root').innerHTML = ""; return out; })()`);
      assert.equal(preview.state, "error"); assert.equal(preview.img, false); assert.match(preview.text, /HEIC files can't be previewed/); assert.equal(preview.download, true); assert.equal(preview.newTab, false);
    });
    test("choosing the same file twice uploads it once; 'Upload anyway' is offered", async () => {
      await open("Big board");
      await expandAll();
      const sel = `.board-group[data-group="Alpha"] tr[data-record-context] td[data-column-key="docs"] .cell-display`;
      assert.ok(await b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el?.scrollIntoView({ block: "center" }); el?.click(); return !!el; })()`));
      assert.ok(await b.waitFor("!!document.querySelector('.files-popover input[type=file]')", 10000), "files panel open");
      const choose = () => b.evaluate(`(() => { const input = document.querySelector('.files-popover input[type=file]'); const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob("${PNG_B64}"), (c) => c.charCodeAt(0))], "dot.png", { type: "image/png" })); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await choose();
      assert.ok(await b.waitFor("document.querySelectorAll('.files-popover .file-row:not([data-upload])').length === 1", 15000), "uploaded once");
      await choose(); await sleep(300);
      const row = await b.evaluate("(() => { const r = document.querySelector('.files-popover .file-row.is-failed'); return r ? { text: r.textContent, again: r.querySelector('[data-action=\"retry-upload\"]')?.getAttribute('aria-label') } : null; })()");
      assert.ok(row && /already in this cell/.test(row.text) && /Upload dot\.png anyway/.test(row.again), JSON.stringify(row));
      await sleep(500);
      assert.equal(await b.evaluate("document.querySelectorAll('.files-popover .file-row:not([data-upload])').length"), 1, "still one file");
      await b.evaluate("document.querySelector('.files-popover [data-action=\"retry-upload\"]').click()");
      assert.ok(await b.waitFor("document.querySelectorAll('.files-popover .file-row:not([data-upload])').length === 2", 15000), "uploaded on request");
      await press("document.activeElement || document.body", { key: "Escape" }); await sleep(200);
    });
  });

  // Clicks the first element matching a selector (scrolled into view); → whether there was one.
  const clickSel = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`);
  const fits = () => b.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1");

  describe("Tablet width (820 × 1180)", () => {
    test("board groups, Ctrl + D, the group menu, the files panel and every System Health tab fit without sideways scrolling", async () => {
      await b.open(`${base}/`, { width: 820, height: 1180 }); await sleep(400);
      await open("Big board");
      await expandAll();
      assert.ok(await fits(), "board fits");
      await b.evaluate("document.activeElement?.blur(); document.body.focus()");
      assert.equal(await ctrlD("document.body"), true);
      await sleep(300);
      assert.deepEqual(await expanded(), []);
      assert.ok(await clickSel('.board-group[data-group="Alpha"] [data-action="group-menu"]')); await sleep(200);
      const menu = await b.evaluate("(() => { const m = document.querySelector('#overlay-root .group-menu-popover'); if (!m) return null; const r = m.getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth }; })()");
      assert.ok(menu && menu.left >= 0 && menu.right <= menu.width + 1, JSON.stringify(menu));
      assert.ok(await clickSel('#overlay-root [data-action="group-expand-all"]')); await sleep(300);
      assert.ok((await expanded()).length >= 8, "expand all works at tablet width");
      assert.ok(await clickSel('.board-group[data-group="Alpha"] tr[data-record-context] td[data-column-key="docs"] .cell-display'));
      assert.ok(await b.waitFor("!!document.querySelector('.files-popover')", 10000));
      assert.ok(await b.evaluate("(() => { const r = document.querySelector('.files-popover').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; })()"), "files panel on screen");
      await press("document.activeElement || document.body", { key: "Escape" }); await sleep(200);
      if (!(await clickSel('[data-action="nav"][data-screen="system-health"]'))) { await clickSel('[data-action="toggle-nav"]'); await sleep(200); assert.ok(await clickSel('[data-action="nav"][data-screen="system-health"]')); }
      assert.ok(await b.waitFor("!!document.querySelector('#health-root')", 15000));
      const ready = { overview: "!!document.querySelector('.health-tiles')", integrations: "!!document.querySelector('.health-card-head')", activity: "!!document.querySelector('.health-activity-list, .quiet-empty')" };
      for (const tab of Object.keys(ready)) {
        assert.ok(await clickSel(`[data-action="health-tab"][data-tab="${tab}"]`));
        assert.ok(await b.waitFor(ready[tab], 15000), `${tab} shown`);
        await sleep(200);
        assert.ok(await fits(), `${tab} tab fits (${await b.evaluate("document.documentElement.scrollWidth")} px)`);
      }
      await b.open(`${base}/`, { width: 1440, height: 900 }); await sleep(400);
    });
  });

  describe("Nothing sensitive reaches people without JARC.Admin", () => {
    test("employee: no link; the page shows only a notice and requests nothing; refusals carry only the error; signed out gets 401", async () => {
      assert.equal(await signIn("0d0d0d0d-0000-4000-8000-0000000000c2", "Worker", false), 201);
      await reload();
      assert.equal(await b.evaluate("!!document.querySelector('[data-action=\"nav\"][data-screen=\"system-health\"]')"), false);
      for (const p of ["/admin/system-health", "/admin/activity", "/admin/activity?q=a&limit=5"]) {
        const res = await api("GET", p);
        assert.equal(res.status, 403, p);
        assert.deepEqual(Object.keys(res.body), ["error"], p);
        assert.equal(res.body.error.code, "FORBIDDEN");
        assert.equal(res.body.error.details, undefined, p);
      }
      // Even opened directly, the screen shows only the notice and asks the server for nothing.
      await b.evaluate("performance.clearResourceTimings()");
      await b.evaluate("(() => { const x = document.createElement('button'); x.dataset.action = 'nav'; x.dataset.screen = 'system-health'; document.querySelector('#app').appendChild(x); x.click(); x.remove(); })()");
      await sleep(600);
      assert.match(await b.evaluate("document.querySelector('#app').textContent"), /available to JARC administrators/);
      assert.equal(await b.evaluate("!!document.querySelector('.health-tiles, .health-activity-list, #health-root')"), false);
      assert.equal(await b.evaluate("performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/v1/admin/')).length"), 0);
      const anon = await b.evaluate("(async () => { const r = await fetch('/api/v1/admin/system-health', { credentials: 'omit' }); return { status: r.status, keys: Object.keys(await r.json()) }; })()");
      assert.deepEqual(anon, { status: 401, keys: ["error"] });
      assert.equal(await signIn("0d0d0d0d-0000-4000-8000-0000000000c1", "Admin", true), 201);
      await reload();
    });
  });

  describe("Everything together", () => {
    test("an edit and an upload appear in Activity History with references; System Health times their routes; Ctrl + D then changes no record", async () => {
      const rec = (await api("GET", `/boards/${big.id}/records?limit=200`)).body.items[0];
      const edited = await b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1/records/${rec.id}", { method: "PATCH", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "X-Request-Id": "together-edit-01" }, body: JSON.stringify({ expectedVersion: ${rec.version}, values: { notes: "changed together" } }) }); return { status: r.status, id: r.headers.get("x-request-id") }; })()`);
      assert.deepEqual(edited, { status: 200, id: "together-edit-01" });
      const activity = (await api("GET", "/admin/activity?limit=100")).body.items;
      const edit = activity.find((i) => i.requestId === "together-edit-01");
      assert.ok(edit && edit.action === "record.updated" && edit.actorName === "Admin" && edit.boardName === "Big board", JSON.stringify(edit));
      assert.ok(activity.some((i) => i.action === "attachment.added" && i.boardName === "Big board" && i.requestId), "the earlier upload is in the trail, with its reference");
      const routes = (await api("GET", "/admin/system-health")).body.endpoints.map((e) => e.route);
      assert.ok(routes.some((r) => r.startsWith("PATCH") && r.endsWith("/records/:recordId")), JSON.stringify(routes));
      assert.ok(routes.some((r) => r.startsWith("POST") && /attachments|files/.test(r)), `upload timed: ${JSON.stringify(routes)}`);
      await reload(); await open("Big board"); await expandAll();
      const before = (await api("GET", `/records/${rec.id}`)).body.record;
      assert.equal(before.values.notes, "changed together");
      await b.evaluate("document.activeElement?.blur(); document.body.focus()");
      assert.equal(await ctrlD("document.body"), true); await sleep(300);
      assert.deepEqual(await expanded(), []);
      const after = (await api("GET", `/records/${rec.id}`)).body.record;
      assert.deepEqual([after.version, after.updatedAt, after.values.notes], [before.version, before.updatedAt, "changed together"]);
      await expandAll();
    });
  });
});
