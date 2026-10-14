// Phase 9D in the REAL app (headless browser, Entra test server, fake MongoDB): the sign-in screen of a shared computer
// never shows the previous person's appearance (neutral JARC Light before authentication; the right person's appearance
// after), one-off motion only when something changed (board selection, group expansion) and none with reduced motion,
// menus and drawers kept inside the viewport (context menu at the screen corner, column menu at the right edge),
// keyboard focus in and out of menus, load-error and loading states, refused cell values, and no console errors.
// Skipped when no Chrome or Edge is installed.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort } = require("./support/headless-browser");

const BROWSER = findBrowser();
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["Medium", "Critical", "Done"] }, { key: "qty", label: "Qty", type: "number" }, { key: "notes", label: "Notes", type: "text" }];
const ANA = "0f9f9f9f-0000-4000-8000-0000000009d1", BEN = "0f9f9f9f-0000-4000-8000-0000000009d2";
// Collects page errors and console.error calls from the first script on (window.__errors).
const ERROR_TRAP = "window.__errors = []; addEventListener('error', (e) => window.__errors.push('error: ' + e.message)); addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + (e.reason && e.reason.message || e.reason))); { const ce = console.error; console.error = (...a) => { window.__errors.push('console: ' + a.map(String).join(' ')); ce.apply(console, a); }; }";

describe("Phase 9D: motion, menus, states and shared-computer sign-in (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, board, other;
  const pageErrors = []; // from every page this browser showed (collected before each navigation)
  const collect = async (br) => { try { pageErrors.push(...((await br.evaluate("window.__errors || []")) || [])); } catch { /* page gone */ } };
  const browsers = [];
  const signIn = (br, oid, name) => br.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${oid}&name=${encodeURIComponent(name)}&email=${oid.slice(-4)}@example.invalid&nonce=" + encodeURIComponent(s.nonce))).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token, state: s.state }) }); })()`);
  const signOut = (br) => br.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); await fetch("/api/v1/auth/sign-out", { method: "POST", headers: { "X-CSRF-Token": csrfToken || "" } }); })()`);
  const api = (br, method, p, body) => br.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json().catch(() => null) }; })()`);
  const click = (br, sel) => br.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const theme = (br) => br.evaluate("document.documentElement.dataset.theme");
  const openApp = async (br, width = 1440, height = 900) => { await collect(br); await br.open(`${base}/`, { width, height }); assert.ok(await br.waitFor("!!document.querySelector('#sidebar .tree-item') || !!document.querySelector('.entra-login')", 15000), "app or sign-in shown"); await sleep(300); };
  const openBoard = async (br, name = "Motion board", width = 1440, height = 900) => {
    await openApp(br, width, height);
    await br.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes(${JSON.stringify(name)}))?.click()`);
    assert.ok(await br.waitFor("document.querySelectorAll('tr[data-record-context]').length >= 3", 15000), "board shown"); await sleep(250);
  };
  const setDark = async (br) => {
    await click(br, "[data-action=settings]"); await br.waitFor("!!document.querySelector('.settings-window')", 3000);
    await click(br, "[data-action=settings-section][data-section=appearance]"); await br.waitFor("!!document.querySelector('[data-action=appearance-mode]')", 3000);
    await click(br, "[data-action=appearance-mode][data-mode=dark]"); await br.waitFor("document.documentElement.dataset.theme === 'dark'", 3000);
    await br.key("Escape"); await sleep(250);
    assert.ok(await br.waitFor(`fetch("/api/v1/me/preferences").then((r) => r.json()).then((p) => p.appearance.theme === "dark")`, 5000));
  };
  const inViewport = (br, sel) => br.evaluate(`(async () => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return "missing"; await Promise.race([Promise.all(el.getAnimations().map((a) => a.finished.catch(() => null))), new Promise((r) => setTimeout(r, 2000))]); const r = el.getBoundingClientRect(); return r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5 ? true : JSON.stringify([Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom), innerWidth, innerHeight]); })()`);

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    for (let i = 0; i < 100; i += 1) { try { await fetch(`${base}/api/v1/health`); break; } catch { await sleep(100); } }
    b = await launch(BROWSER); browsers.push(b);
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: ERROR_TRAP });
    await b.motionPreference("no-preference");
    await b.open(`${base}/api/v1/health`, { width: 1440 });
    await signIn(b, ANA, "Ana Reyes");
    const ws = (await api(b, "POST", "/workspaces", { name: "Motion" })).body.workspace;
    board = (await api(b, "POST", `/workspaces/${ws.id}/boards`, { name: "Motion board", columns: COLUMNS, groups: [{ name: "Planning" }, { name: "Doing" }] })).body.board;
    other = (await api(b, "POST", `/workspaces/${ws.id}/boards`, { name: "Second board", columns: COLUMNS })).body.board;
    await api(b, "POST", `/boards/${board.id}/records/batch`, { records: Array.from({ length: 6 }, (_, i) => ({ values: { serial: `Task ${i + 1}`, status: ["Medium", "Critical", "Done"][i % 3], qty: String(i + 1) }, groupId: board.groups[i < 3 ? 0 : 1].id })) });
    await api(b, "POST", `/boards/${other.id}/records/batch`, { records: Array.from({ length: 3 }, (_, i) => ({ values: { serial: `Item ${i + 1}` } })) });
  });
  after(async () => { for (const br of browsers) await br.close(); server?.kill(); });

  // Timeline of every appearance change from the first script of a page: theme, density, accent, text size, contrast,
  // and whether the app or the sign-in screen is shown; __authAt = when the server confirmed a signed-in session.
  const TIMELINE = "window.__tl = []; window.__authAt = null; const rec = () => { const r = document.documentElement; if (!r) return; window.__tl.push({ t: performance.now(), theme: r.dataset.theme, density: r.dataset.density, fontSize: r.dataset.fontSize || 'normal', contrast: r.dataset.contrast || 'normal', accent: r.style.getPropertyValue('--accent'), app: !!document.querySelector('.app-shell'), gate: !!document.querySelector('.entra-login') }); }; new MutationObserver(rec).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-theme', 'data-density', 'data-font-size', 'data-contrast', 'style'] }); { const f = window.fetch; window.fetch = async (...a) => { const res = await f(...a); try { if (String(a[0] && a[0].url || a[0]).endsWith('/auth/session') && (!a[1] || !a[1].method || a[1].method === 'GET') && res.ok) { const body = await res.clone().json(); if (body && body.user && window.__authAt === null) window.__authAt = performance.now(); } } catch (e) {} return res; }; }";
  const personal = (e) => e.theme !== "light" || e.density !== "comfortable" || e.fontSize !== "normal" || e.contrast !== "normal" || Boolean(e.accent);
  const timeline = (br) => br.evaluate("({ tl: window.__tl, authAt: window.__authAt, gate: !!document.querySelector('.entra-login'), app: !!document.querySelector('.app-shell') })");
  const config = (body) => fetch(base + "/__test/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const expectNeutral = async (br, label) => {
    const r = await timeline(br);
    assert.ok(r.gate, `${label}: sign-in screen shown`);
    assert.ok(r.tl.length > 2 && r.tl.some((e) => e.gate), `${label}: the timeline recorded the page (${r.tl.length} entries)`);
    assert.deepEqual(r.tl.filter(personal), [], `${label}: no personal appearance before authentication`);
    assert.equal(r.authAt, null, `${label}: no confirmed session`);
  };

  test("shared computer: nothing personal before the server confirms a session — expiry, same-tab reload, new tab, browser restart, sign-out, access denied; authenticated reload stays smooth", async () => {
    await openApp(b); await setDark(b);
    await click(b, "[data-action=settings]"); await b.waitFor("!!document.querySelector('.settings-window')", 3000);
    await click(b, "[data-action=settings-section][data-section=appearance]"); await b.waitFor("!!document.querySelector('[data-action=appearance-density]')", 3000);
    await click(b, "[data-action=appearance-density][data-value=compact]"); await click(b, '[data-action=appearance-accent][data-color="#e5484d"]'); await sleep(500); await b.key("Escape");
    assert.ok(await b.waitFor(`fetch("/api/v1/me/preferences").then((r) => r.json()).then((p) => p.appearance.density === "compact" && p.appearance.accent === "#e5484d")`, 5000));
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: TIMELINE });
    const isAna = (e) => `${e.theme}/${e.density}/${e.accent}` === "dark/compact/#e5484d";

    // 1. Authenticated reload: neutral until the server confirms Ana, then Ana's appearance, before the app appears.
    await openApp(b);
    let r = await timeline(b);
    assert.ok(r.app && r.authAt !== null, "signed in");
    assert.deepEqual(r.tl.filter((e) => personal(e) && e.t < r.authAt), [], "nothing personal before the session was confirmed");
    const firstApp = r.tl.find((e) => e.app);
    assert.ok(firstApp && isAna(firstApp), `the app's first frame is Ana's appearance (${JSON.stringify(firstApp)})`);
    assert.equal(r.tl.filter((e) => e.app && !isAna(e)).length, 0, "no neutral or other frame inside the app (smooth)");

    // 2. Server-side session expiry, then a reload of the same tab.
    await config({ expireSessions: true });
    await openApp(b); await expectNeutral(b, "expired + same-tab reload");
    // 3. New tab (fresh tab session) while signed out.
    await b.evaluate("sessionStorage.clear()"); await openApp(b); await expectNeutral(b, "new tab");
    // 4. Browser restart: the session cookie is gone; this browser's stored data remains.
    await signIn(b, ANA, "Ana Reyes"); await openApp(b); assert.ok((await timeline(b)).app);
    await b.send("Network.clearBrowserCookies"); await openApp(b); await expectNeutral(b, "browser restart");
    // 5. Sign-out from JARC (its own sign-out: ends the session, then Microsoft sign-out).
    await signIn(b, ANA, "Ana Reyes"); await openApp(b); assert.ok((await timeline(b)).app);
    // Read in the same script as the click: the "Signing you out…" screen renders at once, then the page leaves for
    // Microsoft's sign-out as soon as the server answers (a later poll could land on that navigation instead).
    assert.equal(await b.evaluate("(() => { const x = document.createElement('button'); x.dataset.action = 'entra-sign-out'; document.querySelector('#app').append(x); x.click(); return !!document.querySelector('.entra-login') && document.documentElement.dataset.theme === 'light' && document.documentElement.dataset.density === 'comfortable' && !document.documentElement.style.getPropertyValue('--accent'); })()"), true, "neutral while signing out");
    await sleep(400); await openApp(b); await expectNeutral(b, "signed out");
    // 6. Access denied (the account is disabled): nothing personal either.
    await signIn(b, ANA, "Ana Reyes");
    await config({ disableEmail: "09d1@example.invalid" });
    await openApp(b);
    r = await timeline(b);
    assert.equal(await b.evaluate("document.querySelector('.entra-login')?.dataset.state"), "denied", "access denied screen");
    assert.deepEqual(r.tl.filter(personal), [], "access denied: nothing personal");
    await config({ enableEmail: "09d1@example.invalid" });
    // 7. The next person on this computer: their own appearance, never Ana's.
    await signIn(b, BEN, "Ben Ortiz"); await openApp(b);
    r = await timeline(b);
    assert.ok(r.app, "Ben is signed in");
    assert.equal(r.tl.filter(isAna).length, 0, "Ben never sees Ana's appearance");
    assert.equal(await theme(b), "light");
    assert.equal(await b.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()"), "#00a5a8");
    // Ana returns: her saved appearance is intact (nothing was reset).
    await signIn(b, ANA, "Ana Reyes"); await openApp(b);
    assert.ok(await b.waitFor("document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.density === 'compact' && document.documentElement.style.getPropertyValue('--accent') === '#e5484d'", 6000), "Ana's appearance after sign-in");
    // A session that expires while the page is open: neutral at once.
    await b.evaluate("window.dispatchEvent(new CustomEvent('jarc-session-expired'))");
    assert.ok(await b.waitFor("!!document.querySelector('.entra-login') && document.documentElement.dataset.theme === 'light' && !document.documentElement.style.getPropertyValue('--accent')", 3000), "expired while open → neutral");
    await openApp(b);
    await api(b, "PUT", "/me/preferences", { appearance: { theme: "light", palette: "default", accent: "#00a5a8", density: "comfortable", recentIcons: [] } });
    await b.evaluate("localStorage.clear()");
  });

  test("motion: board selection and group expansion animate once (opacity/transform, ≤ 200 ms); nothing with reduced motion", async () => {
    await b.motionPreference("no-preference");
    await openBoard(b);
    const sel = await b.evaluate(`(async () => { [...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Second board")).click(); await new Promise((r) => requestAnimationFrame(r)); const el = document.querySelector('.sidebar .board-nav.selected'); const a = el?.getAnimations().map((x) => [x.animationName, x.effect.getTiming().duration]) || []; return { text: el?.textContent || '', a }; })()`);
    assert.match(sel.text, /Second board/);
    assert.ok(sel.a.some(([n, d]) => n === "jarc-nav-select" && d <= 200), `selected-board indicator animates (${JSON.stringify(sel.a)})`);
    await sleep(300);
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Motion board")).click()`);
    await b.waitFor("document.querySelectorAll('.board-group').length >= 2", 5000); await sleep(300);
    await click(b, '.board-group[data-group="Doing"] [data-action=group-toggle]');
    assert.ok(await b.waitFor("document.querySelector('.board-group[data-group=\"Doing\"]').classList.contains('is-collapsed')", 3000));
    await click(b, '.board-group[data-group="Doing"] [data-action=group-toggle]');
    const reveal = await b.evaluate("(() => { const g = document.querySelector('.board-group[data-group=\"Doing\"]'); return { cls: g.classList.contains('group-revealing'), a: [...g.querySelectorAll('td')].flatMap((td) => td.getAnimations().map((x) => [x.animationName, x.effect.getTiming().duration])).slice(0, 1) }; })()");
    assert.ok(reveal.cls && reveal.a[0]?.[0] === "jarc-fade-in" && reveal.a[0][1] >= 150 && reveal.a[0][1] <= 200, `expanded rows fade in (${JSON.stringify(reveal)})`);
    // A plain edit re-renders without replaying navigation or view animations.
    await sleep(400);
    await b.evaluate(`document.querySelector('tr:has([aria-label="Item: Task 1"]) td[data-column-key="notes"] .cell-display').click()`);
    await b.waitFor("!!document.querySelector('.cell-input')", 3000);
    await b.evaluate(`(() => { const i = document.querySelector('.cell-input'); i.value = "edited"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
    await sleep(60);
    assert.equal(await b.evaluate("[...document.querySelectorAll('.sidebar .board-nav, .board-view-region, .board-head')].some((el) => el.getAnimations().length)"), false, "no navigation/view animation on an edit");
    assert.ok(await b.waitFor("['live','saved'].includes(document.querySelector('.save-state')?.dataset.state)", 8000), "saved");
    // Reduced motion: the same actions run with no animations at all.
    await b.motionPreference("reduce");
    await openBoard(b);
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Second board")).click()`);
    assert.equal(await b.evaluate("document.querySelector('.sidebar .board-nav.selected').getAnimations().length"), 0);
    await b.motionPreference("no-preference");
  });

  test("menus and drawers stay inside the viewport: context menu at the screen corner, column menu at the right edge, record drawer, at 1280/1440/1920", async () => {
    for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080]]) {
      await openBoard(b, "Motion board", w, h);
      // Right-click the last visible row near the bottom-right corner.
      const pt = await b.evaluate("(() => { const rows = document.querySelectorAll('tr[data-record-context]'); const r = rows[rows.length - 1].querySelector('td[data-column-key=notes]').getBoundingClientRect(); return { x: Math.min(innerWidth - 4, r.right - 2), y: Math.min(innerHeight - 4, r.bottom - 2) }; })()");
      await b.evaluate(`(() => { const el = document.elementFromPoint(${pt.x}, ${pt.y}); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: ${pt.x}, clientY: ${pt.y}, button: 2 })); })()`);
      assert.ok(await b.waitFor("!!document.querySelector('#overlay-root .popover')", 3000), `${w}px context menu opens`);
      assert.equal(await inViewport(b, "#overlay-root .popover"), true, `${w}px context menu`);
      await b.key("Escape"); await sleep(150);
      const lastHeader = await b.evaluate("(() => { const ths = [...document.querySelectorAll('.editable-table thead th[data-column-key]')]; return ths.at(-1).dataset.columnKey; })()");
      await click(b, `.editable-table thead th[data-column-key="${lastHeader}"] [data-action=column-menu]`);
      assert.ok(await b.waitFor("!!document.querySelector('#overlay-root .popover')", 3000), `${w}px column menu opens`);
      assert.equal(await inViewport(b, "#overlay-root .popover"), true, `${w}px column menu`);
      await b.key("Escape"); await sleep(150);
      await click(b, "tr[data-record-context] [data-action=edit]");
      assert.ok(await b.waitFor("!!document.querySelector('#overlay-root .record-drawer')", 3000));
      assert.equal(await inViewport(b, "#overlay-root .record-drawer"), true, `${w}px record drawer`);
      assert.equal(await b.evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `${w}px no page overflow with the drawer open`);
      await b.key("Escape"); await sleep(250);
      assert.equal(await b.evaluate("document.querySelectorAll('#overlay-root > *').length"), 0, `${w}px nothing left stacked after closing`);
    }
  });

  test("keyboard: a menu opened from the keyboard takes focus; Escape closes it and returns focus to its button", async () => {
    await openBoard(b);
    await b.evaluate("document.querySelector('.board-group [data-action=group-menu]').focus()");
    await b.key("Enter");
    assert.ok(await b.waitFor("!!document.activeElement?.closest('.group-menu-popover')", 3000), "focus moves into the menu");
    await b.key("ArrowDown");
    assert.ok(await b.evaluate("!!document.activeElement?.closest('.group-menu-popover')"), "arrow keys stay in the menu");
    await b.key("Escape");
    assert.ok(await b.waitFor("document.activeElement?.dataset.action === 'group-menu'", 2000), "focus returns to the trigger");
    await b.evaluate("document.querySelector('[data-action=toolbar-menu][data-menu=filter]').focus()");
    await b.key("Enter");
    assert.ok(await b.waitFor("!!document.activeElement?.closest('.toolbar-menu-popover')", 3000));
    await b.key("Escape");
    assert.ok(await b.waitFor("document.activeElement?.dataset.menu === 'filter'", 2000));
  });

  test("states: a failed load explains itself (nothing changed) and retries; skeletons only appear after a delay; refused values are flagged at the cell", async () => {
    const fresh = (await api(b, "POST", `/workspaces/${board.workspaceId}/boards`, { name: "Unloaded board", columns: COLUMNS })).body.board;
    await api(b, "POST", `/boards/${fresh.id}/records/batch`, { records: Array.from({ length: 3 }, (_, i) => ({ values: { serial: `Row ${i + 1}` } })) });
    await openApp(b);
    await b.evaluate(`(() => { const f = window.fetch; window.__fail = true; window.fetch = (u, o) => window.__fail && /\\/records(\\?|$)/.test(String(u?.url || u)) && (!o || !o.method || o.method === "GET") ? Promise.resolve(new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "x" } }), { status: 500, headers: { "Content-Type": "application/json" } })) : f(u, o); })()`);
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Unloaded board")).click()`);
    assert.ok(await b.waitFor("!!document.querySelector('.board-view-region [role=alert]')", 8000), "error state");
    const msg = await b.evaluate("document.querySelector('.board-view-region [role=alert]').textContent");
    assert.match(msg, /couldn't load/i); assert.match(msg, /nothing was changed/i); assert.doesNotMatch(msg, /wasn't saved/i, "no save wording for a load");
    await b.evaluate("window.__fail = false");
    await click(b, "[data-action=retry-board-load]");
    assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length >= 3", 8000), "Try again loads the records");
    await openBoard(b);
    // Skeletons wait before showing (no flash on fast loads).
    assert.equal(await b.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--skeleton-delay').trim()"), "150ms");
    // Clearing the required Item column is refused, said in a toast, and flagged at the cell.
    await b.evaluate(`document.querySelector('tr:has([aria-label="Item: Task 2"]) td[data-column-key="serial"] .cell-display').click()`);
    await b.waitFor("!!document.querySelector('.cell-input')", 3000);
    await b.evaluate(`(() => { const i = document.querySelector('.cell-input'); i.value = ""; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
    assert.ok(await b.waitFor("[...document.querySelectorAll('#toast-region .toast')].some((t) => /can't be empty/.test(t.textContent))", 3000), "toast");
    assert.ok(await b.evaluate(`!!document.querySelector('tr:has([aria-label="Item: Task 2"]) td[data-column-key="serial"].cell-rejected')`), "the cell is flagged");
    assert.equal((await api(b, "GET", `/boards/${board.id}/records`)).body.items.some((r) => r.values.serial === "Task 2"), true, "nothing saved");
  });

  test("deleting right after opening a board still warns about its files (the file list arriving late is waited for)", async () => {
    const fb = (await api(b, "POST", `/workspaces/${board.workspaceId}/boards`, { name: "Files board", columns: [...COLUMNS, { key: "docs", label: "Docs", type: "files" }] })).body.board;
    const rec = (await api(b, "POST", `/boards/${fb.id}/records`, { values: { serial: "With file" } })).body.record;
    const up = await b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1/records/${rec.id}/attachments?column=docs", { method: "POST", headers: { "Content-Type": "application/pdf", "X-File-Name": "proof.pdf", "X-CSRF-Token": csrfToken }, body: "%PDF-1.4 proof" }); return r.status; })()`);
    assert.equal(up, 201);
    await openApp(b);
    // The board's file list takes 1.5 s to arrive; the person deletes the record at once.
    await b.evaluate(`(() => { const f = window.fetch; window.fetch = (u, o) => /\\/boards\\/[^/]+\\/attachments/.test(String(u?.url || u)) ? new Promise((r) => setTimeout(() => r(f(u, o)), 1500)) : f(u, o); })()`);
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Files board")).click()`);
    assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length === 1", 8000));
    await b.evaluate(`(() => { const x = document.createElement("button"); x.dataset.action = "delete"; x.dataset.id = ${JSON.stringify(rec.id)}; document.querySelector(".app-shell").append(x); x.click(); x.remove(); })()`);
    assert.ok(await b.waitFor("!!document.querySelector('[data-action=\"confirm-delete-records\"]')", 4000), "confirmation shown");
    assert.match(await b.evaluate("document.querySelector('#overlay-root').textContent"), /1 attached file will be permanently deleted/);
    await b.key("Escape");
  });

  test("no console errors or uncaught exceptions across these flows", async () => {
    await collect(b); const errors = pageErrors;
    // The deliberate 500 from the previous test is logged by nobody; anything else is a defect.
    assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), []);
  });
});
