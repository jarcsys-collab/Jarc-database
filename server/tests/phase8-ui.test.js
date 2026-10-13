// Phase 8 in the REAL app, in a headless browser, with two signed-in employees (Entra test server,
// development_shared, fake MongoDB): board groups (create from the New record menu, colour, rename, collapse that
// persists, reorder, duplicate, archive/restore, delete moving records, add a record inside a group, live for a
// colleague), the toolbar's themed menus (dark and light, keyboard), view-level Group by (presentation only), and
// record Updates (open from the row indicator, @mention, live delivery, counts, Mentions notifications, replies,
// edit, delete, no stored markup). Skipped when no Chrome or Edge is installed.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort } = require("./support/headless-browser");

const BROWSER = findBrowser();
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["Open", "Done"] }, { key: "owner", label: "Agent", type: "owner" }];

describe("Phase 8: groups, toolbar menus and record updates (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, ana, ben, ws, board, rec;
  const OIDS = { ana: "0a8a8a8a-0000-4000-8000-000000000091", ben: "0b8b8b8b-0000-4000-8000-000000000092" };
  const signIn = (b, who, name) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${encodeURIComponent(name)}&email=${who}@example.invalid&nonce=" + encodeURIComponent(s.nonce))).json(); return (await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token, state: s.state }) })).status; })()`);
  const api = (b, method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json().catch(() => null) }; })()`);
  const serverBoard = async () => (await api(ana, "GET", `/boards/${board.id}`)).body.board;
  const records = async () => (await api(ana, "GET", `/boards/${board.id}/records?limit=200`)).body.items;
  const click = (b, sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`);
  const text = (b, sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent || ""`);
  const groupNames = (b) => b.evaluate("[...document.querySelectorAll('.board-group:not(.is-loose)')].map((g) => g.dataset.group)");
  const toast = (b) => b.evaluate("[...document.querySelectorAll('#toast-region .toast')].map((t) => t.textContent).join(' | ')");
  const saved = async (b) => { assert.ok(await b.waitFor("['live','saved'].includes(document.querySelector('.save-state')?.dataset.state)", 8000), "saved"); await sleep(300); };
  const groupMenu = async (b, name, action) => { assert.ok(await click(b, `.board-group[data-group="${name}"] [data-action="group-menu"]`), `menu of ${name}`); assert.ok(await b.waitFor(`!!document.querySelector('.group-menu-popover [data-action="${action}"]')`, 3000)); await click(b, `.group-menu-popover [data-action="${action}"]`); };
  const openBoard = async (b) => {
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000));
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Groups board"))?.click()`);
    assert.ok(await b.waitFor("document.querySelectorAll('.board-group').length >= 2", 15000));
    assert.ok(await b.waitFor("document.querySelector('.save-state')?.dataset.state === 'live'", 8000));
    await sleep(300);
  };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    for (let i = 0; i < 100; i += 1) { try { await fetch(`${base}/api/v1/health`); break; } catch { await sleep(100); } }
    ana = await launch(BROWSER); ben = await launch(BROWSER);
    for (const [b, who, name] of [[ana, "ana", "Ana Reyes"], [ben, "ben", "Ben Cruz"]]) { await b.motionPreference("no-preference"); await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn(b, who, name); }
    ws = (await api(ana, "POST", "/workspaces", { name: "Phase eight" })).body.workspace;
    board = (await api(ana, "POST", `/workspaces/${ws.id}/boards`, { name: "Groups board", columns: COLUMNS, groups: [{ name: "To do", color: "#3b82f6" }, { name: "Doing", color: "#f97316" }, { name: "Done", color: "#16a34a" }] })).body.board;
    const g = Object.fromEntries(board.groups.map((x) => [x.name, x.id]));
    await api(ana, "POST", `/boards/${board.id}/records/batch`, { records: [
      { values: { serial: "Alpha", status: "Open" }, groupId: g["To do"] }, { values: { serial: "Beta", status: "Open" }, groupId: g["To do"] },
      { values: { serial: "Gamma", status: "Done" }, groupId: g.Doing }, { values: { serial: "Delta", status: "Done" }, groupId: g.Done }
    ] });
    rec = (await records()).find((r) => r.values.serial === "Alpha");
  });
  after(async () => { await ana?.close(); await ben?.close(); server?.kill(); });

  test("groups render in order with their colours, counts and a menu; empty groups show; Add new group below", async () => {
    await openBoard(ana);
    assert.deepEqual(await groupNames(ana), ["To do", "Doing", "Done"]);
    assert.equal(await ana.evaluate(`getComputedStyle(document.querySelector('.board-group[data-group="Doing"]')).getPropertyValue('--group-color').trim()`), "#f97316");
    assert.match(await text(ana, '.board-group[data-group="To do"] .group-count'), /2 records/);
    assert.ok(await ana.evaluate("!!document.querySelector('.group-footer [data-action=\"group-new\"]')"));
    assert.ok(await ana.evaluate("!!document.querySelector('.board-group[data-group=\"Done\"] [aria-haspopup=\"menu\"][aria-label^=\"Actions for group\"]')"));
  });

  test("New record menu → New group: created with a colour, saved, and seen live by a colleague", async () => {
    await openBoard(ben);
    await click(ana, '[data-action="toolbar-menu"][data-menu="new"]');
    assert.ok(await ana.waitFor("!!document.querySelector('.toolbar-menu-popover [data-action=\"group-new\"]')", 3000));
    assert.ok(await ana.evaluate("!!document.querySelector('.toolbar-menu-popover [data-action=\"open-form\"]')"), "New record is offered too");
    await click(ana, '.toolbar-menu-popover [data-action="group-new"]');
    assert.ok(await ana.waitFor("!!document.querySelector('form.group-form input[name=name]')", 3000));
    await ana.evaluate(`(() => { const f = document.querySelector('form.group-form'); f.querySelector('input[name=name]').value = "Backlog"; f.querySelector('input[name=color][value="#ec4899"]').checked = true; f.requestSubmit(); })()`);
    assert.ok(await ana.waitFor("[...document.querySelectorAll('.board-group')].some((g) => g.dataset.group === 'Backlog')", 5000));
    await saved(ana);
    const s = await serverBoard();
    assert.deepEqual(s.groups.map((g) => [g.name, g.color]).at(-1), ["Backlog", "#ec4899"]);
    assert.ok(await ben.waitFor("[...document.querySelectorAll('.board-group')].some((g) => g.dataset.group === 'Backlog')", 10000), "live for Ben");
    assert.match(await text(ana, '.board-group[data-group="Backlog"] .group-count'), /0 records/, "an empty group shows");
  });

  test("a record added inside a group belongs to that group", async () => {
    await click(ana, '.board-group[data-group="Backlog"] [data-action="inline-add"]');
    assert.ok(await ana.waitFor("!!document.querySelector('.board-group[data-group=\"Backlog\"] .draft-row input')", 3000));
    await ana.evaluate(`(() => { const i = document.querySelector('.board-group[data-group="Backlog"] .draft-row input'); i.value = "Epsilon"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); })()`);
    await saved(ana);
    const s = await serverBoard(), backlog = s.groups.find((g) => g.name === "Backlog");
    assert.equal((await records()).find((r) => r.values.serial === "Epsilon")?.groupId, backlog.id);
  });

  test("rename, colour, move up, collapse (kept after reload) and duplicate from the group menu", async () => {
    await groupMenu(ana, "Backlog", "group-rename");
    assert.ok(await ana.waitFor("!!document.querySelector('form.group-form[data-mode=rename]')", 3000));
    await ana.evaluate(`(() => { const f = document.querySelector('form.group-form'); f.querySelector('input[name=name]').value = "Later"; f.requestSubmit(); })()`);
    assert.ok(await ana.waitFor("[...document.querySelectorAll('.board-group')].some((g) => g.dataset.group === 'Later')", 5000));
    await groupMenu(ana, "Later", "group-move-up");
    await saved(ana);
    assert.ok(await click(ana, '.board-group[data-group="Later"] [data-action="group-menu"]'));
    await ana.waitFor("!!document.querySelector('.group-menu-popover [data-color=\"#0d9488\"]')", 3000);
    await click(ana, '.group-menu-popover [data-color="#0d9488"]');
    await saved(ana);
    let s = await serverBoard();
    assert.deepEqual(s.groups.map((g) => g.name), ["To do", "Doing", "Later", "Done"]);
    assert.equal(s.groups.find((g) => g.name === "Later").color, "#0d9488");
    assert.equal((await records()).find((r) => r.values.serial === "Epsilon").groupId, s.groups.find((g) => g.name === "Later").id, "renaming kept the record's group");
    await click(ana, '.board-group[data-group="Done"] [data-action="group-toggle"]');
    assert.ok(await ana.waitFor("document.querySelector('.board-group[data-group=\"Done\"]').classList.contains('is-collapsed')", 3000));
    assert.equal(await ana.evaluate("document.querySelectorAll('.board-group[data-group=\"Done\"] tr:not(.group-header-row)').length"), 0, "collapsed groups render no rows");
    await saved(ana);
    await openBoard(ana);
    assert.ok(await ana.evaluate("document.querySelector('.board-group[data-group=\"Done\"]').classList.contains('is-collapsed')"), "still collapsed after reload");
    await click(ana, '.board-group[data-group="Done"] [data-action="group-toggle"]');
    await groupMenu(ana, "To do", "group-duplicate");
    assert.ok(await ana.waitFor("[...document.querySelectorAll('.board-group')].some((g) => g.dataset.group === 'To do copy')", 5000));
    await saved(ana);
    s = await serverBoard();
    assert.ok(s.groups.some((g) => g.name === "To do copy"));
    assert.equal((await records()).filter((r) => r.groupId === s.groups.find((g) => g.name === "To do copy").id).length, 0, "structure only by default");
  });

  test("archive hides a group (restorable); delete moves its records to the chosen group", async () => {
    await groupMenu(ana, "To do copy", "group-archive");
    assert.ok(await ana.waitFor("![...document.querySelectorAll('.board-group')].some((g) => g.dataset.group === 'To do copy')", 5000));
    assert.match(await text(ana, '[data-action="group-archived"]'), /1 archived group/);
    await saved(ana);
    assert.equal((await serverBoard()).groups.find((g) => g.name === "To do copy").archived, true);
    await click(ana, '[data-action="group-archived"]');
    await ana.waitFor("!!document.querySelector('[data-action=\"group-restore\"]')", 3000);
    await click(ana, '[data-action="group-restore"]');
    assert.ok(await ana.waitFor("[...document.querySelectorAll('.board-group')].some((g) => g.dataset.group === 'To do copy')", 5000));
    await groupMenu(ana, "Doing", "group-delete");
    assert.ok(await ana.waitFor("!!document.querySelector('form[data-action=\"group-delete-form\"]')", 3000));
    await ana.evaluate(`(() => { const f = document.querySelector('form[data-action="group-delete-form"]'); f.querySelector('select[name=moveTo]').value = "Done"; f.requestSubmit(); })()`);
    assert.ok(await ana.waitFor("![...document.querySelectorAll('.board-group')].some((g) => g.dataset.group === 'Doing')", 5000));
    await saved(ana);
    const s = await serverBoard();
    assert.equal(s.groups.some((g) => g.name === "Doing"), false);
    assert.equal((await records()).find((r) => r.values.serial === "Gamma").groupId, s.groups.find((g) => g.name === "Done").id);
  });

  test("duplicate with records copies values (not updates or files); deleting a group with its records removes only those", async () => {
    const before = (await records()).filter((r) => !r.archived);
    const done = (await serverBoard()).groups.find((g) => g.name === "Done");
    const originals = before.filter((r) => r.groupId === done.id).map((r) => r.values.serial).sort();
    assert.ok(originals.length >= 2);
    await groupMenu(ana, "Done", "group-duplicate-records");
    assert.ok(await ana.waitFor("[...document.querySelectorAll('.board-group')].some((g) => g.dataset.group === 'Done copy')", 5000));
    await saved(ana);
    let s = await serverBoard();
    const copyGroup = s.groups.find((g) => g.name === "Done copy");
    assert.equal(copyGroup.color, done.color, "same colour");
    assert.deepEqual(s.groups.map((g) => g.name).slice(s.groups.findIndex((g) => g.name === "Done"), s.groups.findIndex((g) => g.name === "Done") + 2), ["Done", "Done copy"], "placed after the original");
    const copies = (await records()).filter((r) => r.groupId === copyGroup.id);
    assert.deepEqual(copies.map((r) => r.values.serial).sort(), originals);
    const counts = (await api(ana, "GET", `/boards/${board.id}/comment-counts`)).body.counts;
    assert.ok(copies.every((r) => !counts[r.id]), "updates are not copied");
    await groupMenu(ana, "Done copy", "group-delete");
    assert.ok(await ana.waitFor("!!document.querySelector('form[data-action=\"group-delete-form\"] input[value=delete]')", 3000));
    await ana.evaluate(`(() => { const f = document.querySelector('form[data-action="group-delete-form"]'); f.querySelector('input[value=delete]').checked = true; f.requestSubmit(); })()`);
    assert.ok(await ana.waitFor("![...document.querySelectorAll('.board-group')].some((g) => g.dataset.group === 'Done copy')", 5000));
    await saved(ana);
    s = await serverBoard();
    assert.equal(s.groups.some((g) => g.name === "Done copy"), false);
    const after = (await records()).filter((r) => !r.archived);
    assert.deepEqual(after.map((r) => r.id).sort(), before.map((r) => r.id).sort(), "only the copies were deleted");
  });

  test("records move between groups from the bulk bar (saved; undo restores)", async () => {
    await click(ana, 'tr:has([aria-label="Item: Beta"]) input[data-action="select"]');
    assert.ok(await ana.waitFor("!!document.querySelector('.bulk-bar [data-action=group-pick]')", 3000));
    await click(ana, ".bulk-bar [data-action=group-pick]");
    assert.ok(await ana.waitFor("!!document.querySelector('[data-action=group-move-records][data-group=Later]')", 3000));
    await click(ana, "[data-action=group-move-records][data-group=Later]");
    await saved(ana);
    const later = (await serverBoard()).groups.find((g) => g.name === "Later");
    assert.equal((await records()).find((r) => r.values.serial === "Beta").groupId, later.id);
    assert.ok(await ana.evaluate(`!!document.querySelector('.board-group[data-group="Later"] [aria-label="Item: Beta"]')`), "shown in its new group");
  });

  test("toolbar menus are themed (dark and light), work from the keyboard, and Group by changes only the view", async () => {
    await ana.evaluate(`document.documentElement.dataset.theme = "dark"`);
    await click(ana, '[data-action="toolbar-menu"][data-menu="quick"]');
    assert.ok(await ana.waitFor("!!document.querySelector('.toolbar-menu-popover')", 3000));
    const dark = await ana.evaluate("getComputedStyle(document.querySelector('.toolbar-menu-popover')).backgroundColor");
    const lum = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    assert.ok(lum(dark) < 80, `dark menu (${dark})`);
    assert.ok(lum(await ana.evaluate("getComputedStyle(document.querySelector('.toolbar-menu-popover button')).color")) > 150, "light text on dark");
    assert.ok(await ana.waitFor("document.activeElement?.closest('.toolbar-menu-popover') !== null && !!document.activeElement.closest('.toolbar-menu-popover')", 3000), "focus moves into the menu");
    await ana.key("ArrowDown");
    assert.equal(await ana.evaluate("document.activeElement.textContent"), "My records");
    await ana.key("Enter");
    assert.ok(await ana.waitFor("/My records/.test(document.querySelector('[data-menu=\"quick\"]')?.textContent || '')", 3000), "keyboard choice applied");
    await click(ana, '[data-action="toolbar-menu"][data-menu="quick"]'); await ana.waitFor("!!document.querySelector('.toolbar-menu-popover')", 3000);
    await click(ana, '.toolbar-menu-popover [data-value="all"]');
    await ana.evaluate(`document.documentElement.dataset.theme = "light"`);
    await click(ana, '[data-action="toolbar-menu"][data-menu="status"]');
    assert.ok(await ana.waitFor("!!document.querySelector('.toolbar-menu-popover')", 3000));
    assert.ok(lum(await ana.evaluate("getComputedStyle(document.querySelector('.toolbar-menu-popover')).backgroundColor")) > 200, "light menu in light mode");
    await ana.key("Escape");
    await ana.evaluate(`document.documentElement.dataset.theme = "dark"`);
    const before = (await records()).map((r) => [r.id, r.version, r.groupId]);
    await click(ana, '[data-action="toolbar-menu"][data-menu="groupby"]');
    await ana.waitFor("!!document.querySelector('.toolbar-menu-popover [data-value=\"status\"]')", 3000);
    await click(ana, '.toolbar-menu-popover [data-value="status"]');
    assert.ok(await ana.waitFor("document.querySelectorAll('.view-group').length >= 2", 3000));
    assert.deepEqual(await ana.evaluate("[...document.querySelectorAll('.view-group .group-name')].map((n) => n.textContent.trim())"), ["Open", "Done", "(empty)"], "status order, then records without a status");
    assert.match(await text(ana, ".view-group .group-note"), /Grouped by Status/);
    assert.deepEqual((await records()).map((r) => [r.id, r.version, r.groupId]), before, "Group by changed no record");
    await click(ana, '[data-action="toolbar-menu"][data-menu="groupby"]'); await ana.waitFor("!!document.querySelector('.toolbar-menu-popover')", 3000);
    await click(ana, '.toolbar-menu-popover [data-value=""]');
    assert.ok(await ana.waitFor("document.querySelectorAll('.board-group:not(.view-group)').length >= 3", 3000));
  });

  test("updates: open from the row, @mention, live for a colleague with counts and a Mentions notification; reply, edit, delete; no markup runs", async () => {
    await openBoard(ana); await openBoard(ben);
    await click(ana, `[data-action="open-updates"][data-id="${rec.id}"]`);
    assert.ok(await ana.waitFor("document.querySelector('form.record-drawer')?.dataset.tab === 'updates' && !!document.querySelector('textarea[data-role=new]')", 5000));
    await click(ben, `[data-action="open-updates"][data-id="${rec.id}"]`);
    assert.ok(await ben.waitFor("!!document.querySelector('.updates-panel .quiet-empty, .updates-panel .update-list')", 5000));
    // Type "@Be", choose Ben from the suggestions, then post.
    await ana.evaluate(`(() => { const t = document.querySelector('textarea[data-role=new]'); t.focus(); t.value = "Can you check this @Be"; t.setSelectionRange(t.value.length, t.value.length); t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    assert.ok(await ana.waitFor("/Ben Cruz/.test(document.querySelector('.mention-suggestions:not([hidden])')?.textContent || '')", 5000), "suggestions");
    await ana.key("Enter");
    assert.match(await ana.evaluate("document.querySelector('textarea[data-role=new]').value"), /@Ben Cruz $/);
    await ana.evaluate(`(() => { const t = document.querySelector('textarea[data-role=new]'); t.value += "<img src=x onerror=\\"window.__xss=1\\">"; })()`);
    await click(ana, '.update-composer[data-role="new"] [data-action="comment-submit"]');
    assert.ok(await ana.waitFor("document.querySelectorAll('.update-card').length === 1", 5000));
    assert.equal(await ana.evaluate("document.querySelectorAll('.update-body img').length"), 0, "markup shows as text");
    assert.equal(await ana.evaluate("typeof window.__xss"), "undefined");
    assert.ok(await ana.waitFor("!!document.querySelector('.update-body .mention')", 5000), "the mention is highlighted");
    // Ben: live in the open drawer, and the row count.
    assert.ok(await ben.waitFor("document.querySelectorAll('.update-card').length === 1", 10000), "live for Ben");
    assert.equal(await ben.evaluate("typeof window.__xss"), "undefined");
    assert.ok(await ben.waitFor(`document.querySelector('[data-action="open-updates"][data-id="${rec.id}"] .comment-count')?.textContent === "1"`, 10000), "row count live");
    // Ben replies; Ana sees it.
    await click(ben, '[data-action="comment-reply"]');
    assert.ok(await ben.waitFor("!!document.querySelector('textarea[data-role=reply]')", 3000));
    await ben.evaluate(`document.querySelector('textarea[data-role=reply]').value = "On it"`);
    await click(ben, '.update-composer[data-role="reply"] [data-action="comment-submit"]');
    assert.ok(await ana.waitFor("document.querySelectorAll('.update-card.is-reply').length === 1", 10000), "reply live for Ana");
    assert.equal(await ben.evaluate("document.querySelectorAll('.update-card').length"), 2, "no duplicate after the live echo");
    // Ben's Mentions notifications.
    await ben.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sleep(300);
    await click(ben, '[data-action="notifications"]');
    assert.ok(await ben.waitFor("!!document.querySelector('[data-action=notification-filter][data-filter=mentions]')", 5000));
    await click(ben, '[data-action="notification-filter"][data-filter="mentions"]');
    assert.ok(await ben.waitFor("/Ana Reyes/.test(document.querySelector('.notification-list')?.textContent || '') && /update/i.test(document.querySelector('.notification-list')?.textContent || '')", 10000), "mention notification");
    // Ana edits and deletes her own update (the reply keeps the thread).
    await click(ana, '.update-card:not(.is-reply) [data-action="comment-edit"]');
    assert.ok(await ana.waitFor("!!document.querySelector('textarea[data-role=edit]')", 3000));
    await ana.evaluate(`document.querySelector('textarea[data-role=edit]').value = "Checked, thanks"`);
    await click(ana, '.update-composer[data-role="edit"] [data-action="comment-submit"]');
    assert.ok(await ana.waitFor("/Checked, thanks/.test(document.querySelector('.update-card .update-body')?.textContent || '') && !!document.querySelector('.update-card .edited')", 5000), "edited indicator");
    assert.equal(await ana.evaluate("!!document.querySelector('.update-card.is-reply [data-action=comment-edit]')"), false, "can't edit Ben's reply");
    await click(ana, '.update-card:not(.is-reply) [data-action="comment-delete"]');
    await ana.waitFor("!!document.querySelector('[data-action=comment-delete-yes]')", 3000);
    await click(ana, '[data-action="comment-delete-yes"]');
    assert.ok(await ana.waitFor("/was deleted/.test(document.querySelector('.update-card .update-body')?.textContent || '')", 5000));
    assert.equal(await ana.evaluate("document.querySelectorAll('.update-card.is-reply').length"), 1);
    // Long updates open clamped with See more; every thread offers a reply prompt.
    await api(ana, "POST", `/records/${rec.id}/comments`, { body: Array.from({ length: 14 }, (_, i) => `Line ${i + 1}`).join("\n") });
    assert.ok(await ana.waitFor("!!document.querySelector('.update-body.is-clamped') && !!document.querySelector('[data-action=comment-expand]')", 10000), "long update clamped");
    await click(ana, "[data-action=comment-expand]");
    assert.ok(await ana.waitFor("!document.querySelector('.update-body.is-clamped') && /See less/.test(document.querySelector('[data-action=comment-expand]').textContent)", 3000));
    assert.ok(await ana.evaluate("document.querySelectorAll('.reply-prompt').length >= 1"));
  });
});
