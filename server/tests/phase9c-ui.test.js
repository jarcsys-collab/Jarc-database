// Phase 9C in the REAL app (headless browser, Entra test server, fake MongoDB): JARC Default — Light for a new person
// (never the device's dark mode), the teal sidebar in both themes, the Light/Dark switch (instant, saved per person,
// on every device, the app's first frame already in their theme), accent validation and contrast, density, shared workspace/board icons
// and group colours (saved, delivered live to a colleague), focus visibility and reduced motion.
// Skipped when no Chrome or Edge is installed. Also: the appearance migration of older saved settings (model only).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort } = require("./support/headless-browser");
const { loadBrowser } = require("./support/browser-model");

const BROWSER = findBrowser();
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["Medium", "Critical", "Done"] }, { key: "notes", label: "Notes", type: "text" }];
const ANA = "0f9f9f9f-0000-4000-8000-0000000009c1", BEN = "0f9f9f9f-0000-4000-8000-0000000009c2", NEW = "0f9f9f9f-0000-4000-8000-0000000009c3";

// WCAG relative luminance / contrast of computed rgb() colours.
const lum = (rgb) => { const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, c) => { const [x, y] = [lum(a), lum(c)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
// A teal: green and blue clearly above red.
const isTeal = (rgb) => { const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number); return g - r > 60 && b - r > 60 && Math.abs(g - b) < 40; };

describe("Phase 9C: appearance migration (model)", () => {
  test("older saved settings keep their theme; the old built-in accent becomes JARC Teal; new settings get the JARC defaults", () => {
    const { window } = loadBrowser();
    const M = window.BoardModel;
    assert.deepEqual({ ...M.migrateAppearance({ theme: "dark", accentColor: "#0f9489", density: "compact" }) }, { theme: "dark", accentColor: "#00a5a8", density: "compact", palette: "default", appearanceVersion: 2 }, "a chosen theme is never reset");
    assert.equal(M.migrateAppearance({ theme: "light", accentColor: "#8b5cf6" }).accentColor, "#8b5cf6", "a personal accent stays");
    assert.equal(M.migrateAppearance({ theme: "system" }).theme, "system");
    const later = { theme: "dark", accentColor: "#0f9489", appearanceVersion: 2 };
    assert.equal(M.migrateAppearance(later), later, "already migrated: unchanged");
    const fresh = new (loadBrowser().window.BoardModel)({ load: () => ({}), save() {} });
    fresh.applyState({});
    assert.equal(fresh.settings.theme, "light"); assert.equal(fresh.settings.palette, "default"); assert.equal(fresh.settings.accentColor, "#00a5a8"); assert.equal(fresh.settings.density, "comfortable");
  });
});

describe("Phase 9C: JARC Default theme and personalization (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, a, b2, board, ws;
  const browsers = [];
  const signIn = (br, oid, name) => br.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${oid}&name=${encodeURIComponent(name)}&email=${oid.slice(-4)}@example.invalid&nonce=" + encodeURIComponent(s.nonce))).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token, state: s.state }) }); })()`);
  const api = (br, method, p, body) => br.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json().catch(() => null) }; })()`);
  const click = (br, sel) => br.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const css = (br, sel, prop, pseudo = null) => br.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? getComputedStyle(el${pseudo ? `, ${JSON.stringify(pseudo)}` : ""})[${JSON.stringify(prop)}] : null; })()`);
  const theme = (br) => br.evaluate("document.documentElement.dataset.theme");
  const newBrowser = async (oid, name) => { const br = await launch(BROWSER); browsers.push(br); await br.motionPreference("reduce"); await br.open(`${base}/api/v1/health`, { width: 1440 }); await signIn(br, oid, name); return br; };
  const openApp = async (br, width = 1440) => { await br.open(`${base}/`, { width, height: 900 }); assert.ok(await br.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "app shown"); await sleep(400); };
  const openBoard = async (br, width = 1440) => {
    await openApp(br, width);
    await br.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Theme board"))?.click()`);
    assert.ok(await br.waitFor("document.querySelectorAll('.board-group').length >= 2 && ['live','saved'].includes(document.querySelector('.save-state')?.dataset.state)", 15000), "board shown");
    await sleep(300);
  };
  const openAppearance = async (br) => {
    await click(br, "[data-action=settings]"); await br.waitFor("!!document.querySelector('.settings-window')", 3000);
    await click(br, "[data-action=settings-section][data-section=appearance]");
    if (!(await br.waitFor("!!document.querySelector('.appearance-settings [data-action=appearance-mode]')", 3000))) { const shot = await br.send("Page.captureScreenshot", { format: "png" }); require("fs").writeFileSync(require("path").join(require("os").tmpdir(), "phase9c-appearance-fail.png"), Buffer.from(shot.result.data, "base64")); assert.fail("Appearance shown"); }
  };
  // A real Escape key press (as a keyboard sends it to the focused element), then the closing animation.
  const closeOverlay = async (br) => { await br.key("Escape"); await br.waitFor("!document.querySelector('#overlay-root')?.dataset.open", 2000); await sleep(200); };
  const savedPrefs = async (br) => (await api(br, "GET", "/me/preferences")).body.appearance;

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    for (let i = 0; i < 100; i += 1) { try { await fetch(`${base}/api/v1/health`); break; } catch { await sleep(100); } }
    a = await newBrowser(ANA, "Ana Reyes");
    ws = (await api(a, "POST", "/workspaces", { name: "Studio" })).body.workspace;
    board = (await api(a, "POST", `/workspaces/${ws.id}/boards`, { name: "Theme board", columns: COLUMNS, groups: [{ name: "Planning" }, { name: "Doing" }] })).body.board;
    await api(a, "POST", `/boards/${board.id}/records/batch`, { records: [{ values: { serial: "Task 1", status: "Medium" }, groupId: board.groups[0].id }, { values: { serial: "Task 2", status: "Critical" }, groupId: board.groups[0].id }, { values: { serial: "Task 3", status: "Done" }, groupId: board.groups[1].id }] });
  });
  after(async () => { for (const br of browsers) await br.close(); server?.kill(); });

  test("a new person sees JARC Default — Light: teal sidebar, white workspace, Poppins — and nothing is saved for them", async () => {
    const n = await newBrowser(NEW, "Nia New");
    await n.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }] });
    await openApp(n);
    assert.equal(await theme(n), "light", "light even when the device prefers dark");
    assert.equal(await n.evaluate("document.documentElement.dataset.palette"), "default");
    assert.equal(await n.evaluate("document.documentElement.dataset.density"), "comfortable");
    assert.ok(isTeal(await css(n, ".sidebar", "backgroundColor")), "teal sidebar");
    assert.match(await css(n, ".sidebar", "backgroundImage"), /linear-gradient/, "subtle teal gradient");
    assert.equal(await css(n, ".workspace", "backgroundColor"), "rgb(255, 255, 255)", "white workspace");
    assert.ok(parseFloat(await css(n, ".workspace", "borderTopLeftRadius")) >= 24, "rounded sidebar-to-content corner");
    assert.match(await css(n, "body", "fontFamily"), /^Poppins/);
    assert.ok(await n.waitFor("document.fonts.check('600 16px Poppins') && document.fonts.check('400 16px Poppins')", 5000), "Poppins loaded (self-hosted)");
    assert.equal(await n.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()"), "#00a5a8", "JARC Teal accent");
    assert.deepEqual(await savedPrefs(n), {}, "defaults aren't written to the server");
    await n.close(); browsers.splice(browsers.indexOf(n), 1);
  });

  test("selected board: a pill in the workspace colour that joins the content (inverted curves), no sideways scrolling", async () => {
    await openBoard(a);
    const s = await a.evaluate(`(() => { const sel = document.querySelector('.sidebar .board-nav.selected'), side = document.querySelector('.sidebar').getBoundingClientRect(), r = sel.getBoundingClientRect(), nav = document.querySelector('.sidebar nav');
      return { right: Math.round(r.right), sideRight: Math.round(side.right), bg: getComputedStyle(sel).backgroundColor, ws: getComputedStyle(document.querySelector('.workspace')).backgroundColor, before: getComputedStyle(sel, '::before').content, after: getComputedStyle(sel, '::after').content, navOverflow: nav.scrollWidth > nav.clientWidth + 12 && getComputedStyle(nav).overflowX !== 'hidden', page: document.documentElement.scrollWidth <= innerWidth }; })()`);
    assert.equal(s.right, s.sideRight, "reaches the sidebar edge"); assert.equal(s.bg, s.ws, "same colour as the workspace");
    assert.notEqual(s.before, "none"); assert.notEqual(s.after, "none");
    assert.equal(s.navOverflow, false, "no sideways scrollbar in the sidebar"); assert.equal(s.page, true);
    assert.equal(await css(a, ".board-surface", "backgroundColor") !== await css(a, ".workspace", "backgroundColor"), true, "soft-grey board panel");
    const row = await a.evaluate("(() => { const td = document.querySelector('tr[data-record-context] > td:first-child'); return { radius: parseFloat(getComputedStyle(td).borderTopLeftRadius), spacing: getComputedStyle(td.closest('table')).borderSpacing }; })()");
    assert.ok(row.radius >= 8, "rounded rows"); assert.match(row.spacing, /^0px [1-9]/, "rows are separated");
    assert.notEqual(await css(a, "tbody.board-group tr[data-record-context] > td:first-child", "content", "::before"), "none", "group accent bar");
  });

  test("Light/Dark switch: instant (no reload), teal sidebar kept, saved for the person, on their other device, no flash on the next load", async () => {
    await openBoard(a);
    const before = await a.evaluate("performance.getEntriesByType('navigation')[0].startTime + ':' + document.querySelector('.app-shell') .isConnected");
    await openAppearance(a);
    assert.equal(await a.evaluate("document.querySelector('[data-action=appearance-mode][data-mode=light]').getAttribute('aria-pressed')"), "true");
    await click(a, "[data-action=appearance-mode][data-mode=dark]");
    assert.ok(await a.waitFor("document.documentElement.dataset.theme === 'dark'", 3000), "applied at once");
    assert.equal(await a.evaluate("performance.getEntriesByType('navigation')[0].startTime + ':' + document.querySelector('.app-shell').isConnected"), before, "no page reload");
    assert.ok(await a.waitFor("document.querySelector('[data-action=appearance-mode][data-mode=dark]')?.getAttribute('aria-pressed') === 'true'", 3000));
    assert.equal(await a.evaluate("document.activeElement?.dataset.mode"), "dark", "focus stays on the choice");
    await closeOverlay(a);
    const side = await css(a, ".sidebar", "backgroundColor"), wsBg = await css(a, ".workspace", "backgroundColor");
    assert.ok(isTeal(side), `the sidebar stays teal in dark mode (${side})`);
    assert.ok(lum(wsBg) < 0.03 && wsBg !== "rgb(0, 0, 0)", `charcoal workspace, never pure black (${wsBg})`);
    assert.notEqual(await css(a, ".editable-table td.cell", "color"), "rgb(255, 255, 255)", "off-white text, not pure white");
    assert.ok(await a.waitFor(`fetch("/api/v1/me/preferences").then((r) => r.json()).then((p) => p.appearance.theme === "dark" && p.appearance.palette === "default")`, 5000), "saved on the server");
    // Next load: neutral until the server confirms the session (Phase 9 RC), then Ana's own appearance before the app
    // appears — the first frame of the app is already dark (no light → dark switch inside the app).
    await a.send("Page.addScriptToEvaluateOnNewDocument", { source: "new MutationObserver((l, o) => { if (document.querySelector('.app-shell')) { window.__appTheme = document.documentElement.dataset.theme; o.disconnect(); } }).observe(document, { childList: true, subtree: true });" });
    await openApp(a);
    assert.equal(await theme(a), "dark", "kept after a reload");
    assert.equal(await a.evaluate("window.__appTheme"), "dark", "the app's first frame is already dark");
    // The same person on another device (empty browser profile): the server preference wins after sign-in.
    const laptop = await newBrowser(ANA, "Ana Reyes");
    await openApp(laptop);
    assert.ok(await laptop.waitFor("document.documentElement.dataset.theme === 'dark'", 5000), "follows Ana to her other device");
    // A colleague is unaffected.
    b2 = await newBrowser(BEN, "Ben Ortiz");
    await openApp(b2);
    assert.equal(await theme(b2), "light", "Ben keeps JARC Light");
    // Restore my appearance defaults → JARC Default — Light everywhere.
    await openAppearance(a);
    await click(a, "[data-action=appearance-reset]");
    assert.ok(await a.waitFor("document.documentElement.dataset.theme === 'light'", 3000));
    assert.ok(await a.waitFor(`fetch("/api/v1/me/preferences").then((r) => r.json()).then((p) => p.appearance.theme === "light" && p.appearance.accent === "#00a5a8" && p.appearance.density === "comfortable")`, 5000));
    await closeOverlay(a);
    await laptop.close(); browsers.splice(browsers.indexOf(laptop), 1);
  });

  test("optional presets keep the JARC sidebar and token system; Light/Dark returns to JARC Default", async () => {
    await openBoard(a);
    await openAppearance(a);
    await a.evaluate("document.querySelector('.more-themes').open = true");
    for (const [id, mode] of [["midnight", "dark"], ["slate", "dark"], ["warm", "light"]]) {
      await click(a, `[data-action=appearance-preset][data-preset=${id}]`);
      assert.ok(await a.waitFor(`document.documentElement.dataset.palette === "${id}" && document.documentElement.dataset.theme === "${mode}"`, 3000), id);
      assert.ok(isTeal(await css(a, ".sidebar", "backgroundColor")), `${id}: teal sidebar`);
    }
    await click(a, "[data-action=appearance-mode][data-mode=light]");
    assert.ok(await a.waitFor("document.documentElement.dataset.palette === 'default' && document.documentElement.dataset.theme === 'light'", 3000));
    await closeOverlay(a);
  });

  test("accent colour: presets, custom HEX (invalid refused), readable buttons and text, reset to JARC Teal", async () => {
    await openBoard(a);
    await openAppearance(a);
    const typeHex = (v) => a.evaluate(`(() => { const i = document.querySelector('[data-action=appearance-accent-hex]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const accent = () => a.evaluate("document.documentElement.style.getPropertyValue('--accent')");
    await typeHex("#12345g"); await sleep(150);
    assert.equal(await a.evaluate("document.querySelector('[data-action=appearance-accent-hex]').getAttribute('aria-invalid')"), "true");
    assert.equal(await accent(), "#00a5a8", "an invalid colour changes nothing");
    await typeHex("#ffe066"); await sleep(250); // very light: buttons deepen it
    assert.equal(await accent(), "#ffe066");
    await closeOverlay(a);
    const btn = await a.evaluate("(() => { const c = getComputedStyle(document.querySelector('.board-tools .compact-primary')); return [c.color, c.backgroundColor]; })()");
    assert.ok(ratio(btn[0], btn[1]) >= 4.5, `button text contrast ${ratio(btn[0], btn[1]).toFixed(2)}`);
    const head = await a.evaluate("(() => { const th = document.querySelector('.editable-table thead th.is-primary'); return [getComputedStyle(th.querySelector('.column-label')).color, getComputedStyle(th).backgroundColor, getComputedStyle(document.querySelector('.board-surface')).backgroundColor]; })()");
    assert.ok(ratio(head[0], head[1]) >= 4.5 && ratio(head[0], head[2]) >= 4.5, "accent-coloured text stays readable");
    assert.ok(await a.waitFor(`fetch("/api/v1/me/preferences").then((r) => r.json()).then((p) => p.appearance.accent === "#ffe066")`, 5000), "saved");
    const refused = await api(a, "PUT", "/me/preferences", { appearance: { accent: "url(javascript:alert(1))" } });
    assert.equal(refused.status, 400, "the server refuses invalid colours too");
    await openAppearance(a);
    await click(a, "[data-action=appearance-accent-reset]");
    assert.ok(await a.waitFor("document.documentElement.style.getPropertyValue('--accent') === '#00a5a8'", 3000), "Reset to JARC Teal");
    await closeOverlay(a);
  });

  test("density: compact, comfortable and spacious change row height only (records unchanged)", async () => {
    await openBoard(a);
    const rowH = () => a.evaluate("Math.round(document.querySelector('tr[data-record-context]').getBoundingClientRect().height)");
    const heights = {};
    for (const d of ["compact", "spacious", "comfortable"]) {
      await openAppearance(a); await click(a, `[data-action=appearance-density][data-value=${d}]`);
      assert.ok(await a.waitFor(`document.documentElement.dataset.density === "${d}"`, 3000)); await closeOverlay(a); heights[d] = await rowH();
    }
    assert.ok(heights.compact < heights.comfortable && heights.comfortable < heights.spacious, JSON.stringify(heights));
    const recs = (await api(a, "GET", `/boards/${board.id}/records`)).body.items.map((r) => r.values.serial).sort();
    assert.deepEqual(recs, ["Task 1", "Task 2", "Task 3"]);
    assert.equal((await savedPrefs(a)).density, "comfortable");
  });

  test("board icon from the picker (Lucide icon, then emoji): saved on the board and shown live to a colleague", async () => {
    await openBoard(a); await openBoard(b2);
    await click(a, ".board-head [data-action=icon-picker][data-kind=board]");
    assert.ok(await a.waitFor("!!document.querySelector('.icon-picker [data-action=icon-search]')", 3000));
    await a.evaluate(`(() => { const i = document.querySelector('.icon-picker [data-action=icon-search]'); i.value = "rocket"; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.ok(await a.waitFor("document.querySelectorAll('.icon-picker .icon-grid:not(.is-recent) [data-action=icon-choose]').length === 1", 2000), "search narrows the icons");
    await click(a, ".icon-picker .icon-grid:not(.is-recent) [data-action=icon-choose]");
    assert.ok(await a.waitFor(`fetch("/api/v1/boards/${board.id}").then((r) => r.json()).then((x) => x.board.icon === "icon:rocket")`, 6000), "saved as an icon name");
    assert.ok(await b2.waitFor(`!!document.querySelector('.sidebar .board-nav [data-id="${board.id}"] .entity-icon.is-glyph svg path')`, 12000), "Ben sees it without reloading");
    await click(a, ".board-head [data-action=icon-picker][data-kind=board]"); await a.waitFor("!!document.querySelector('.icon-picker')", 3000);
    await click(a, ".icon-picker [data-action=icon-tab][data-tab=emoji]"); await sleep(150);
    await click(a, '.icon-picker [data-action=icon-choose][data-value="📦"]');
    assert.ok(await b2.waitFor(`document.querySelector('.sidebar .board-nav [data-id="${board.id}"] .entity-icon.is-emoji')?.textContent === "📦"`, 12000), "emoji, live");
    await click(a, ".board-head [data-action=icon-picker][data-kind=board]"); await a.waitFor("!!document.querySelector('.icon-picker')", 3000);
    await click(a, '.icon-picker [data-action=icon-choose][data-value=""]');
    assert.ok(await a.waitFor(`fetch("/api/v1/boards/${board.id}").then((r) => r.json()).then((x) => x.board.icon === "")`, 6000), "Reset to default");
    assert.equal(await a.evaluate("[...document.querySelectorAll('.icon-picker .icon-choice')].some((b) => /<script|onerror/i.test(b.innerHTML))"), false);
  });

  test("workspace icon from Settings → Workspace: saved and shown live to a colleague", async () => {
    await openApp(a); await openApp(b2);
    await click(a, "[data-action=settings]"); await a.waitFor("!!document.querySelector('.settings-window')", 3000);
    await click(a, "[data-action=settings-section][data-section=workspace]");
    assert.ok(await a.waitFor("!!document.querySelector('[data-action=icon-picker][data-kind=workspace]')", 3000));
    await click(a, "[data-action=icon-picker][data-kind=workspace]");
    assert.ok(await a.waitFor("!!document.querySelector('.icon-picker [data-value=\"icon:briefcase\"]')", 3000));
    await click(a, '.icon-picker [data-value="icon:briefcase"]');
    assert.ok(await a.waitFor(`fetch("/api/v1/workspaces/${ws.id}").then((r) => r.json()).then((x) => x.workspace.icon === "icon:briefcase")`, 6000), "saved");
    assert.ok(await b2.waitFor("!!document.querySelector('.sidebar .workspace-switch .entity-icon.is-glyph svg')", 12000), "Ben sees the workspace icon live");
    await closeOverlay(a);
  });

  test("group colour: custom HEX with live preview, saved on the board (IDs and order unchanged), seen live; reset to default", async () => {
    await openBoard(a); await openBoard(b2);
    const ids = (await api(a, "GET", `/boards/${board.id}`)).body.board.groups.map((g) => g.id);
    await click(a, '.board-group[data-group="Doing"] [data-action=group-menu]');
    assert.ok(await a.waitFor("!!document.querySelector('.group-menu-popover [aria-label=\"Official JARC colours\"]')", 3000), "official JARC colours");
    assert.ok(await a.evaluate("!!document.querySelector('.group-menu-popover [aria-label=\"Muted colours\"]')"), "muted presets");
    await click(a, '.group-menu-popover [data-action=group-rename]');
    assert.ok(await a.waitFor("!!document.querySelector('form.group-form [name=custom]')", 3000));
    await a.evaluate(`(() => { const i = document.querySelector('form.group-form [name=custom]'); i.value = "#c2410c"; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.equal(await a.evaluate(`document.querySelector('.board-group[data-group="Doing"]').style.getPropertyValue('--group-color')`), "#c2410c", "live preview on the board");
    await a.evaluate("document.querySelector('form.group-form').requestSubmit()");
    assert.ok(await a.waitFor(`fetch("/api/v1/boards/${board.id}").then((r) => r.json()).then((x) => x.board.groups.find((g) => g.name === "Doing")?.color === "#c2410c")`, 6000), "saved");
    const after = (await api(a, "GET", `/boards/${board.id}`)).body.board.groups.map((g) => g.id);
    assert.deepEqual(after, ids, "same group IDs, same order");
    assert.ok(await b2.waitFor(`document.querySelector('.board-group[data-group="Doing"]')?.style.getPropertyValue('--group-color') === "#c2410c"`, 12000), "Ben sees the colour live");
    await click(a, '.board-group[data-group="Doing"] [data-action=group-menu]'); await a.waitFor("!!document.querySelector('.group-menu-popover')", 3000);
    await click(a, '.group-menu-popover [data-action=group-color-reset]');
    assert.ok(await a.waitFor(`fetch("/api/v1/boards/${board.id}").then((r) => r.json()).then((x) => x.board.groups.find((g) => g.name === "Doing")?.color === "")`, 6000), "back to the default");
    assert.equal(await a.evaluate(`document.querySelector('.board-group[data-group="Doing"]').style.getPropertyValue('--group-color')`), "#08ab4b", "the official JARC colour for its position (green)");
  });

  test("contrast and focus in both themes: sidebar text, primary buttons, header labels, keyboard focus ring", async () => {
    for (const mode of ["light", "dark"]) {
      await openBoard(a); await openAppearance(a); await click(a, `[data-action=appearance-mode][data-mode=${mode}]`);
      assert.ok(await a.waitFor(`document.documentElement.dataset.theme === "${mode}"`, 3000)); await closeOverlay(a);
      const c = await a.evaluate(`(() => { const g = (s, p) => getComputedStyle(document.querySelector(s))[p];
        return { side: g('.sidebar', 'backgroundColor'), nav: g('.sidebar .nav-item .nav-text', 'color'), label: g('.sidebar .nav-label', 'color'), sel: g('.sidebar .board-nav.selected .tree-item', 'color'), selBg: g('.sidebar .board-nav.selected', 'backgroundColor'),
          btn: g('.board-tools .compact-primary', 'color'), btnBg: g('.board-tools .compact-primary', 'backgroundColor'), head: g('.editable-table thead th .column-label', 'color'), headBg: g('.editable-table thead th', 'backgroundColor'), cell: g('.editable-table td.cell', 'color'), row: g('tr[data-record-context] > td.cell', 'backgroundColor') }; })()`);
      for (const [fg, bg, label] of [["nav", "side", "sidebar text"], ["label", "side", "sidebar section label"], ["sel", "selBg", "selected board"], ["btn", "btnBg", "primary button"], ["head", "headBg", "header label"], ["cell", "row", "record text"]]) {
        assert.ok(ratio(c[fg], c[bg]) >= 4.5, `${mode}: ${label} contrast ${ratio(c[fg], c[bg]).toFixed(2)} (${c[fg]} on ${c[bg]})`);
      }
      await a.evaluate("document.querySelector('.board-tools .tool-button').focus({ focusVisible: true })");
      await a.key("Tab"); await sleep(100);
      const ring = await a.evaluate("(() => { const el = document.activeElement; const c = getComputedStyle(el); return { style: c.outlineStyle, width: parseFloat(c.outlineWidth), color: c.outlineColor, bg: getComputedStyle(document.querySelector('.board-surface')).backgroundColor }; })()");
      assert.equal(ring.style, "solid", `${mode}: visible keyboard focus`); assert.ok(ring.width >= 2);
      assert.ok(ratio(ring.color, ring.bg) >= 3, `${mode}: focus ring contrast ${ratio(ring.color, ring.bg).toFixed(2)}`);
    }
    await openAppearance(a); await click(a, "[data-action=appearance-reset]"); await a.waitFor("document.documentElement.dataset.theme === 'light'", 3000); await closeOverlay(a);
  });

  test("reduced motion: transitions off; with motion allowed, hover transitions stay short (≤ 150 ms)", async () => {
    await a.motionPreference("reduce"); await openBoard(a);
    assert.equal(await css(a, ".sidebar .nav-item", "transitionDuration").then((v) => v.split(",").every((d) => parseFloat(d) === 0)), true);
    await a.motionPreference("no-preference"); await openBoard(a);
    const d = (await css(a, ".board-tools .tool-button", "transitionDuration")).split(",").map((v) => parseFloat(v) * 1000);
    assert.ok(d.some((v) => v > 0) && d.every((v) => v <= 150), JSON.stringify(d));
    await a.motionPreference("reduce");
  });
});
