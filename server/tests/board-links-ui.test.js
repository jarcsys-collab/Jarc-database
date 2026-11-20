// Direct board links in the REAL app (/boards/{boardId}), in a headless browser against the test Entra server configured as in
// production (shared workspaces, beta open editing; fake MongoDB, synthetic data): the address follows the open board, a link
// opens its board (in any workspace) after sign-in, Back/Forward, Copy board link, and the boards a link can't open. Desktop and
// phone. A second server with role-based access checks that a link grants nothing. Skipped without Chrome or Edge.
// BOARD_LINKS_SHOTS=<folder>: also saves screenshots (light/dark, desktop/phone) there for a visual check.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const DESKTOP = { width: 1440, height: 900 }, TABLET = { width: 820, height: 1180 }, PHONE = { width: 390, height: 844 };
const OWNER = "0e7e7e7e-0000-4000-8000-0000000000b1", EMPLOYEE = "0e7e7e7e-0000-4000-8000-0000000000b2", NEWCOMER = "0e7e7e7e-0000-4000-8000-0000000000b3";
const COLUMNS = [{ key: "serial", label: "Name", type: "text", required: true }, { key: "note", label: "Note", type: "text" }];
const FAKE_MSAL = fs.readFileSync(path.join(__dirname, "support", "fake-msal.js"), "utf8");
const SHOTS = process.env.BOARD_LINKS_SHOTS || "";

async function startServer(shared, extraEnv = {}) {
  const port = await freePort(), base = `http://localhost:${port}`;
  const server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), ...(shared ? ["shared"] : [])], { stdio: "ignore", env: { ...process.env, ...extraEnv } });
  await waitForServer(base, { child: server });
  return { base, server };
}
// Page helpers for one browser.
function pageTools(b) {
  const tools = {
    signIn: (oid, name, admin = false) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${oid}&name=${encodeURIComponent(name)}&email=${oid}@example.invalid&admin=${admin ? 1 : 0}&nonce=" + encodeURIComponent(s.nonce))).json(); const r = await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); return r.status; })()`),
    api: (method, url, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return JSON.stringify({ status: r.status, body: await r.json().catch(() => null) }); })()`).then(JSON.parse),
    wait: (expr, ms = 15000) => b.waitFor(expr, ms),
    click: (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`),
    path: () => b.evaluate("location.pathname"),
    title: () => b.evaluate(`document.querySelector(".board-title-input")?.value ?? null`),
    workspaceName: () => b.evaluate(`document.querySelector(".top-context > span:not(.context-divider)")?.textContent ?? ""`),
    historyLength: () => b.evaluate("history.length"),
    noSidewaysScroll: () => b.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
    async openPath(p, viewport = DESKTOP) {
      await b.open(`${tools.base}${p}`, viewport);
      assert.ok(await tools.wait("!!document.querySelector('.app-shell')", 20000), `the app loads at ${p}`);
    },
    // The named board is on screen with its records, and the address is its link.
    async showsBoard(board, rows = true) {
      assert.ok(await tools.wait(`document.querySelector(".board-title-input")?.value === ${JSON.stringify(board.name)}`), `${board.name} is open (shown: ${await tools.title()})`);
      if (rows) assert.ok(await tools.wait(`[...document.querySelectorAll("tr[data-record-context]")].some((tr) => tr.textContent.includes(${JSON.stringify(`${board.name} row 1`)}))`), `${board.name}'s records are shown`);
      assert.equal(await tools.path(), `/boards/${board.id}`);
    },
    async sidebarBoard(name) {
      assert.ok(await b.evaluate(`(() => { const el = [...document.querySelectorAll("#sidebar .tree-item[data-action='open-board']")].find((e) => e.textContent.trim().startsWith(${JSON.stringify(name)})); if (!el) return false; el.click(); return true; })()`), `${name} is in the sidebar`);
    },
    async switchWorkspace(id) {
      assert.ok(await tools.click('[data-action="workspace-menu"]'));
      assert.ok(await tools.wait(`!!document.querySelector('[data-action="switch-workspace"][data-id="${id}"]')`, 5000));
      await tools.click(`[data-action="switch-workspace"][data-id="${id}"]`);
    },
    // Records requests for one board wait until release() (a slow network), or fail (offline), inside the page.
    holdRecords: (boardId, mode) => b.evaluate(`(() => { window.__realFetch ??= window.fetch; window.__held = []; window.fetch = (input, init) => { const u = String(input?.url || input); if (u.includes("/boards/${boardId}/records")) { if (${JSON.stringify(mode)} === "fail") return Promise.reject(new TypeError("Failed to fetch")); return new Promise((resolve, reject) => window.__held.push(() => window.__realFetch(input, init).then(resolve, reject))); } return window.__realFetch(input, init); }; return true; })()`),
    release: () => b.evaluate(`(() => { const held = window.__held || []; window.fetch = window.__realFetch; held.forEach((go) => go()); return held.length; })()`),
    stubClipboard: (fail) => b.evaluate(`(() => { window.__copied = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return ${fail ? 'Promise.reject(new Error("denied"))' : "Promise.resolve()"}; } } }); return true; })()`),
    async shot(name) {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      const res = await b.send("Page.captureScreenshot", { format: "png" });
      if (res.result?.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(res.result.data, "base64"));
    }
  };
  return tools;
}

describe("Direct board links (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let srv, b, t;
  const boards = {}, spaces = {};
  const makeBoard = async (workspaceId, name, rows = 3) => {
    const board = (await t.api("POST", `/api/v1/workspaces/${workspaceId}/boards`, { name, columns: COLUMNS })).body.board;
    if (rows) assert.equal((await t.api("POST", `/api/v1/boards/${board.id}/records/batch`, { records: Array.from({ length: rows }, (_, i) => ({ values: { serial: `${name} row ${i + 1}`, note: `Note ${i + 1}` } })) })).status, 201);
    return { id: board.id, name, version: board.version };
  };

  before(async () => {
    srv = await startServer(true, { JARC_TEST_BETA: "1" });
    b = await launch(BROWSER); t = pageTools(b); t.base = srv.base;
    await b.motionPreference("reduce");
    await b.open(`${srv.base}/api/v1/health`, DESKTOP);
    // Another employee owns both workspaces and every board; the person opening links is a member of nothing (shared access).
    assert.equal(await t.signIn(OWNER, "Olga Owner"), 201);
    spaces.alpha = (await t.api("POST", "/api/v1/workspaces", { name: "Alpha Space" })).body.workspace.id;
    spaces.beta = (await t.api("POST", "/api/v1/workspaces", { name: "Beta Space" })).body.workspace.id;
    boards.a = await makeBoard(spaces.alpha, "Alpha Orders");
    boards.b = await makeBoard(spaces.alpha, "Alpha Stock");
    boards.c = await makeBoard(spaces.beta, "Beta Tickets");
    boards.archived = await makeBoard(spaces.beta, "Beta Old Board");
    assert.equal((await t.api("PATCH", `/api/v1/boards/${boards.archived.id}`, { expectedVersion: boards.archived.version, archived: true })).status, 200);
    boards.deleted = await makeBoard(spaces.beta, "Beta Gone Board", 0);
    assert.equal((await t.api("DELETE", `/api/v1/boards/${boards.deleted.id}?expectedVersion=${boards.deleted.version}`)).status, 200);
    assert.equal(await t.signIn(EMPLOYEE, "Emil Employee"), 201);
  });
  after(async () => { await b?.close(); srv?.server.kill(); });

  test("opening a board puts /boards/{id} in the address bar; switching boards follows; opening the same board again adds no history entry", async () => {
    await t.openPath("/");
    await t.switchWorkspace(spaces.alpha);
    assert.ok(await t.wait(`location.pathname === "/"`), "a workspace's Home keeps /");
    await t.sidebarBoard("Alpha Orders");
    await t.showsBoard(boards.a);
    const length = await t.historyLength();
    await t.sidebarBoard("Alpha Orders");
    await t.showsBoard(boards.a);
    assert.equal(await t.historyLength(), length, "the same board again: no new entry");
    await t.sidebarBoard("Alpha Stock");
    await t.showsBoard(boards.b);
    assert.equal(await t.historyLength(), length + 1);
    assert.equal(await b.evaluate(`document.querySelector('#sidebar .board-nav.selected')?.textContent.includes("Alpha Stock") && !document.querySelector('#sidebar .board-nav.selected')?.textContent.includes("Alpha Orders")`), true, "only the new board is marked active");
    await t.click('[data-action="nav"][data-screen="home"]');
    assert.ok(await t.wait(`location.pathname === "/"`), "Home goes back to /");
  });

  test("a direct link opens its board in its own workspace, with its records, without showing another board first; reload keeps it", async () => {
    await t.openPath("/");
    await t.switchWorkspace(spaces.alpha); // the person's saved place is another workspace
    // Every board title rendered while the link loads is recorded from the very first paint.
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__titles = []; new MutationObserver(() => { const v = document.querySelector(".board-title-input")?.value; if (v && window.__titles.at(-1) !== v) window.__titles.push(v); }).observe(document, { childList: true, subtree: true });` }).then((r) => { t.titleWatcher = r.result?.identifier; });
    await t.openPath(`/boards/${boards.c.id}`);
    await t.showsBoard(boards.c);
    assert.deepEqual(await b.evaluate("window.__titles"), ["Beta Tickets"], "no other board was drawn first");
    assert.equal(await t.workspaceName(), "Beta Space", "the board's workspace is active");
    assert.equal(await b.evaluate(`[...document.querySelectorAll("#sidebar .tree-item[data-action='open-board']")].map((e) => e.textContent.trim()).some((n) => n.startsWith("Beta Tickets"))`), true, "the sidebar lists that workspace's boards");
    await b.send("Page.reload", {});
    assert.ok(await t.wait("!!document.querySelector('.app-shell')", 20000));
    await t.showsBoard(boards.c);
    assert.deepEqual(await b.evaluate("window.__titles"), ["Beta Tickets"], "reload: still no other board first");
    if (t.titleWatcher) await b.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: t.titleWatcher });
    // Upper case and a trailing slash open the same board, and the address settles on the canonical link (no extra entry).
    await t.openPath(`/boards/${boards.a.id.toUpperCase()}/`);
    await t.showsBoard(boards.a);
  });

  test("Back and Forward move between the boards opened (across workspaces), and back to Home", async () => {
    await t.openPath("/");
    await t.switchWorkspace(spaces.alpha);
    await t.sidebarBoard("Alpha Orders"); await t.showsBoard(boards.a);
    await t.sidebarBoard("Alpha Stock"); await t.showsBoard(boards.b);
    await t.switchWorkspace(spaces.beta);
    assert.ok(await t.wait(`location.pathname === "/"`));
    await t.sidebarBoard("Beta Tickets"); await t.showsBoard(boards.c);
    const length = await t.historyLength();
    await b.evaluate("history.back()");
    assert.ok(await t.wait(`location.pathname === "/" && !document.querySelector(".board-title-input")`), "Back: the Beta Space Home");
    await b.evaluate("history.back()"); await t.showsBoard(boards.b);
    assert.equal(await t.workspaceName(), "Alpha Space", "Back into another workspace: that workspace is active");
    await b.evaluate("history.back()"); await t.showsBoard(boards.a);
    await b.evaluate("history.forward()"); await t.showsBoard(boards.b);
    assert.equal(await t.historyLength(), length, "Back/Forward never add entries");
    // A fragment link (the skip link) is not a navigation: the board stays as it is.
    await b.evaluate(`(() => { const a = document.querySelector('a[href^="#"]'); a?.click(); return !!a; })()`);
    await t.showsBoard(boards.b);
  });

  test("a board that's still loading can't replace the board chosen after it", async () => {
    await t.openPath("/");
    await t.switchWorkspace(spaces.alpha);
    await t.holdRecords(boards.a.id, "hold");
    await t.sidebarBoard("Alpha Orders");
    assert.ok(await t.wait(`document.querySelector(".board-title-input")?.value === "Alpha Orders"`));
    await t.sidebarBoard("Alpha Stock");
    await t.showsBoard(boards.b);
    assert.ok(await t.release() >= 0);
    await new Promise((r) => setTimeout(r, 800));
    await t.showsBoard(boards.b);
    assert.equal(await b.evaluate(`[...document.querySelectorAll("tr[data-record-context]")].some((tr) => tr.textContent.includes("Alpha Orders row"))`), false, "none of the earlier board's records");
  });

  test("links that can't open explain why and offer Home: invalid, unknown, deleted; an archived board opens as from Home → Archived", async () => {
    for (const [link, heading] of [["/boards/not-a-valid-board-id", "This board link isn't valid."], ["/boards/ffffffffffffffffffffffff", "This board could not be found."], [`/boards/${boards.deleted.id}`, "This board could not be found."]]) {
      await t.openPath(link);
      assert.ok(await t.wait(`document.querySelector(".board-link-problem h2")?.textContent === ${JSON.stringify(heading)}`), `${link}: ${heading}`);
      assert.equal(await b.evaluate(`document.querySelector(".board-link-problem")?.getAttribute("role")`), "alert");
      assert.equal(await t.path(), link, "the address stays what was asked for");
      assert.equal(await b.evaluate(`!!document.querySelector(".loading-screen, [aria-busy='true'].app-loading")`), false, "not left loading");
    }
    assert.equal(await b.evaluate(`document.body.textContent.includes("Beta Gone Board")`), false, "nothing about the deleted board");
    await t.click('.board-link-problem [data-action="nav"][data-screen="home"]');
    assert.ok(await t.wait(`!document.querySelector(".board-link-problem") && location.pathname === "/"`), "Go to Home");
    await t.openPath(`/boards/${boards.archived.id}`);
    await t.showsBoard(boards.archived);
    assert.equal(await t.workspaceName(), "Beta Space");
  });

  test("records that fail to load (network) show Try again, which recovers in place", async () => {
    await t.openPath("/");
    await t.switchWorkspace(spaces.alpha);
    await t.holdRecords(boards.b.id, "fail");
    await t.sidebarBoard("Alpha Stock");
    assert.ok(await t.wait(`!!document.querySelector('[data-action="retry-board-load"]')`), "Try again");
    assert.equal(await t.path(), `/boards/${boards.b.id}`);
    await t.release();
    await t.click('[data-action="retry-board-load"]');
    await t.showsBoard(boards.b);
  });

  test("Copy board link (header and board menu): the absolute link of the right board, with feedback; a refused clipboard shows the link", async () => {
    await t.openPath(`/boards/${boards.c.id}`);
    await t.showsBoard(boards.c);
    const button = JSON.parse(await b.evaluate(`JSON.stringify((() => { const el = document.querySelector('.board-actions [data-action="copy-board-link"]'); return el && { label: el.getAttribute("aria-label"), tag: el.tagName, tabbable: el.tabIndex >= 0 }; })())`));
    assert.deepEqual(button, { label: "Copy board link", tag: "BUTTON", tabbable: true });
    await t.stubClipboard(false);
    // By keyboard: Tab from the Favorite button reaches it, with a visible focus ring, then Enter.
    await b.evaluate(`document.querySelector('.board-actions [data-action="toggle-favorite"]').focus()`);
    await b.key("Tab");
    assert.equal(await b.evaluate(`document.activeElement?.dataset.action`), "copy-board-link", "next in the tab order");
    assert.equal(await b.evaluate(`document.activeElement.matches(":focus-visible") && getComputedStyle(document.activeElement).outlineStyle !== "none"`), true, "a visible focus state");
    await b.key("Enter");
    assert.ok(await t.wait(`window.__copied.length === 1`, 3000));
    assert.equal(await b.evaluate("window.__copied[0]"), `${srv.base}/boards/${boards.c.id}`);
    assert.ok(await t.wait(`document.querySelector("#toast-region")?.textContent.includes("Board link copied")`, 3000));
    for (const forbidden of ["/api/", "token", "code=", "eyJ", "?", "#"]) assert.ok(!(await b.evaluate("window.__copied[0]")).includes(forbidden), forbidden);
    // The board menu of ANOTHER board (sidebar): that board's link, not the open one's.
    await t.switchWorkspace(spaces.alpha);
    await b.evaluate(`(() => { const row = [...document.querySelectorAll("#sidebar .board-nav")].find((r) => r.textContent.includes("Alpha Stock")); row.querySelector('[data-action="board-menu"]').click(); })()`);
    assert.ok(await t.wait(`!!document.querySelector('.board-popover [data-action="copy-board-link"]')`, 3000));
    await t.click('.board-popover [data-action="copy-board-link"]');
    assert.ok(await t.wait(`window.__copied.length === 2`, 3000));
    assert.equal(await b.evaluate("window.__copied[1]"), `${srv.base}/boards/${boards.b.id}`);
    // The clipboard refuses: the link is shown to copy by hand.
    await t.openPath(`/boards/${boards.a.id}`);
    await t.showsBoard(boards.a);
    await t.stubClipboard(true);
    await t.click('.board-actions [data-action="copy-board-link"]');
    assert.ok(await t.wait(`document.querySelector("#overlay-root .modal")?.textContent.includes(${JSON.stringify(`${srv.base}/boards/${boards.a.id}`)})`, 3000), "the link, to copy by hand");
    await t.click('#overlay-root [data-action="close-overlay"]');
  });

  test("phone and tablet: the board opens from its link, Copy board link is visible inside the header, no sideways scrolling", async () => {
    for (const [name, viewport] of [["phone", PHONE], ["tablet", TABLET]]) {
      await t.openPath(`/boards/${boards.c.id}`, viewport);
      await t.showsBoard(boards.c, false);
      const box = JSON.parse(await b.evaluate(`JSON.stringify((() => { const el = document.querySelector('.board-actions [data-action="copy-board-link"]'); if (!el) return null; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { visible: r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none", inside: r.left >= 0 && r.right <= innerWidth, w: r.width, h: r.height }; })())`));
      assert.ok(box?.visible && box.inside, `${name}: ${JSON.stringify(box)}`);
      assert.ok(box.w >= 32 && box.h >= 32, `${name}: a usable tap target (${box.w}×${box.h})`);
      assert.equal(await t.noSidewaysScroll(), true, name);
      await t.stubClipboard(false);
      assert.ok(await b.tapOn('.board-actions [data-action="copy-board-link"]'));
      assert.ok(await t.wait(`window.__copied[0] === ${JSON.stringify(`${srv.base}/boards/${boards.c.id}`)}`, 3000), `${name}: copied`);
      await t.openPath("/boards/not-a-valid-board-id", viewport);
      assert.ok(await t.wait(`!!document.querySelector(".board-link-problem")`));
      assert.equal(await t.noSidewaysScroll(), true, `${name}: problem screen`);
    }
  });

  test("visual check: light and dark, desktop and phone (screenshots only with BOARD_LINKS_SHOTS)", async () => {
    for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
      for (const theme of ["light", "dark"]) {
        await t.openPath(`/boards/${boards.c.id}`, viewport);
        await t.showsBoard(boards.c, false);
        await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
        await new Promise((r) => setTimeout(r, 150));
        const colors = JSON.parse(await b.evaluate(`JSON.stringify((() => { const el = document.querySelector('.board-actions [data-action="copy-board-link"]'), star = document.querySelector('.board-actions [data-action="toggle-favorite"]'); return { icon: getComputedStyle(el).color, star: getComputedStyle(star).color, bg: getComputedStyle(el).backgroundColor, starBg: getComputedStyle(star).backgroundColor }; })())`));
        assert.equal(colors.icon, colors.star, `${name} ${theme}: styled like its neighbour`);
        assert.equal(colors.bg, colors.starBg, `${name} ${theme}`);
        assert.equal(await t.noSidewaysScroll(), true, `${name} ${theme}`);
        await t.shot(`board-${name}-${theme}`);
        await t.openPath("/boards/ffffffffffffffffffffffff", viewport);
        assert.ok(await t.wait(`!!document.querySelector(".board-link-problem")`));
        await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
        await new Promise((r) => setTimeout(r, 150));
        await t.shot(`missing-${name}-${theme}`);
      }
    }
  });

  test("signed out: the link survives Microsoft sign-in and opens its board; no token or code is left in the address", async () => {
    const fresh = await launch(BROWSER), f = pageTools(fresh); f.base = srv.base;
    try {
      await fresh.motionPreference("reduce");
      // The simulated MSAL (never contacts Microsoft): "Microsoft" sends the person straight back to the redirect URI (/).
      await fresh.send("Page.addScriptToEvaluateOnNewDocument", { source: `${FAKE_MSAL}\nwindow.__fakeMsal.setNextLogin({ oid: ${JSON.stringify(NEWCOMER)}, name: "Nia Newcomer", email: "${NEWCOMER}@example.invalid" });` });
      await fresh.open(`${srv.base}/boards/${boards.b.id}`, DESKTOP);
      assert.ok(await f.wait(`!!document.querySelector('[data-action="entra-sign-in"]')`, 20000), "the sign-in screen");
      assert.equal(await f.path(), `/boards/${boards.b.id}`, "the link is still in the address bar");
      assert.equal(await fresh.evaluate(`document.body.textContent.includes("Alpha Stock")`), false, "nothing of the board before sign-in");
      await f.click('[data-action="entra-sign-in"]');
      assert.ok(await f.wait("!!document.querySelector('.app-shell')", 20000), "signed in");
      await f.showsBoard(boards.b);
      const href = await fresh.evaluate("location.href");
      assert.equal(href, `${srv.base}/boards/${boards.b.id}`);
      assert.doesNotMatch(href, /code=|state=|token|eyJ/);
      assert.equal(await fresh.evaluate(`sessionStorage.getItem("jarc-auth-return")`), null, "the kept link was used once");
      assert.equal(await f.workspaceName(), "Alpha Space");
    } finally { await fresh.close(); }
  });
});

describe("Direct board links grant nothing (role-based access)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let srv, b, t, board;
  before(async () => {
    srv = await startServer(false);
    b = await launch(BROWSER); t = pageTools(b); t.base = srv.base;
    await b.motionPreference("reduce");
    await b.open(`${srv.base}/api/v1/health`, DESKTOP);
    assert.equal(await t.signIn(OWNER, "Olga Owner", true), 201); // role-based: creating a workspace needs JARC.Admin
    const ws = (await t.api("POST", "/api/v1/workspaces", { name: "Private Space" })).body.workspace.id;
    board = (await t.api("POST", `/api/v1/workspaces/${ws}/boards`, { name: "Private Payroll Board", columns: COLUMNS })).body.board;
    await t.api("POST", `/api/v1/boards/${board.id}/records/batch`, { records: [{ values: { serial: "Secret row" } }] });
    assert.equal(await t.signIn(EMPLOYEE, "Emil Employee"), 201);
  });
  after(async () => { await b?.close(); srv?.server.kill(); });

  test("a board someone isn't allowed to see: the same 'could not be found' as a deleted board, and none of its data", async () => {
    await t.openPath(`/boards/${board.id}`);
    assert.ok(await t.wait(`document.querySelector(".board-link-problem h2")?.textContent === "This board could not be found."`), "not found");
    assert.equal(await b.evaluate(`document.body.textContent.includes("Private Payroll Board") || document.body.textContent.includes("Secret row")`), false);
    assert.notEqual((await t.api("GET", `/api/v1/boards/${board.id}`)).status, 200, "the API still refuses it");
    assert.notEqual((await t.api("GET", `/api/v1/boards/${board.id}/records`)).status, 200);
  });
});
