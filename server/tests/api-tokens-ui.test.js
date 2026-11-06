// The Developer Center (profile menu → Developer: tokens, Explorer, Boards & Columns, docs, activity), the board and column API
// Information panels, and the profile menu in the REAL app, in a headless browser, against the test Entra server (local test keys,
// fake MongoDB, synthetic data), on desktop and mobile. Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const DESKTOP = { width: 1440, height: 900 }, MOBILE = { width: 390, height: 844 };
const OID = "0e7e7e7e-0000-4000-8000-000000000091", OTHER = "0e7e7e7e-0000-4000-8000-000000000092";

describe("API Tokens and the profile menu (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, boardId;
  const start = async (env) => {
    const port = await freePort(), url = `http://localhost:${port}`;
    const proc = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore", env: { ...process.env, ...env } });
    await waitForServer(url, { child: proc });
    return { proc, url };
  };
  const signIn = (oid, name, admin) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${oid}&name=${encodeURIComponent(name)}&email=${oid}@example.invalid&admin=${admin ? 1 : 0}&nonce=" + encodeURIComponent(s.nonce))).json(); const r = await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); return r.status; })()`);
  const has = (sel) => b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  const text = (sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent || ""`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const wait = (expr, ms = 10000) => b.waitFor(expr, ms);
  const noSidewaysScroll = () => b.evaluate("document.documentElement.scrollWidth <= window.innerWidth");
  // Profile menu → Developer, then one of its sections.
  const openDeveloper = async (section = "tokens") => {
    assert.ok(await wait("!!document.querySelector('.app-shell')", 15000), "app loaded");
    let open = false;
    for (let i = 0; i < 4 && !open; i++) {
      if (!(await has(".developer-window"))) { if (!(await has(".profile-popover"))) await click('[data-action="profile-menu"]'); await wait("!!document.querySelector('.profile-popover [data-action=\"developer\"]')", 2000); await click('.profile-popover [data-action="developer"]'); }
      open = await wait("!!document.querySelector('.developer-window #apitok-root')", 3000);
    }
    assert.ok(open, "Developer opens from the profile menu");
    await click(`.developer-window .settings-nav [data-action="apitok-tab"][data-tab="${section}"]`);
  };
  const openPanel = async () => { await openDeveloper("tokens"); assert.ok(await wait("!!document.querySelector('#apitok-root .apitok-intro')"), "tokens loaded"); };
  const reload = async (viewport, section = null) => { await b.open(`${base}/`, viewport); if (section) await openDeveloper(section); else await openPanel(); };
  const setValue = (sel, value, event = "change") => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; if (el.type === "checkbox") el.checked = ${JSON.stringify(Boolean(value))}; else el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); return true; })()`);
  let directoryIds = null;

  before(async () => {
    server = await start({ JARC_TEST_API_TOKENS: "1" });
    base = server.url;
    b = await launch(BROWSER);
    await b.motionPreference("reduce");
    await b.open(`${base}/api/v1/health`, DESKTOP);
    assert.equal(await signIn(OID, "Tess Token", true), 201);
    // A workspace this person created, so they hold a real admin membership.
    boardId = await b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const post = async (u, body) => (await fetch(u, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) })).json(); const { workspace } = await post("/api/v1/workspaces", { name: "Synthetic Ops" }); const { board } = await post("/api/v1/workspaces/" + workspace.id + "/boards", { name: "Synthetic Board", columns: [{ key: "serial", label: "Item", type: "text", required: true }, { key: "email", label: "Customer Email", type: "email" }, { key: "status", label: "Status", type: "status", options: ["New", "Done"] }] }); await post("/api/v1/workspaces/" + workspace.id + "/boards", { name: "Second Board" }); await post("/api/v1/boards/" + board.id + "/records", { values: { serial: "Row one" } }); return board.id; })()`);
  });
  after(async () => { await b?.close(); server?.proc?.kill(); });

  for (const [label, viewport] of [["desktop", DESKTOP], ["mobile", MOBILE]]) {
    test(`profile menu (${label}): no Status section; the rest is intact and fits`, async () => {
      await b.open(`${base}/`, viewport);
      assert.ok(await wait("!!document.querySelector('.app-shell')", 15000));
      let open = false;
      for (let i = 0; i < 4 && !open; i++) { await click('[data-action="profile-menu"]'); open = await wait("!!document.querySelector('.profile-popover')", 2000); }
      assert.ok(open, "profile menu opens");
      const menu = await text(".profile-popover");
      for (const gone of ["Status", "Available", "Busy", "Focus", "Offline"]) assert.ok(!menu.includes(gone), `no "${gone}"`);
      assert.equal(await has('.profile-popover [data-action="set-presence"], .profile-popover .presence-picker, .profile-popover .presence'), false);
      for (const action of ["profile-settings", "developer", "settings", "notifications", "workspace-menu", "workspace-manage", "request-logout"]) assert.ok(await has(`.profile-popover [data-action="${action}"]`), action);
      // Developer sits right under View profile.
      assert.deepEqual(JSON.parse(await b.evaluate(`JSON.stringify([...document.querySelectorAll(".profile-popover .profile-menu-section")[0].querySelectorAll("button")].map((x) => x.dataset.action))`)).slice(0, 2), ["profile-settings", "developer"]);
      assert.match(menu, /Tess Token/);
      // Three sections and no empty gap where Status was.
      const sections = await b.evaluate(`JSON.stringify([...document.querySelectorAll(".profile-popover .profile-menu-section")].map((s) => ({ buttons: s.querySelectorAll("button").length, height: s.getBoundingClientRect().height })))`);
      const parsed = JSON.parse(sections);
      assert.deepEqual(parsed.map((s) => s.buttons), [4, 2, 1]);
      assert.ok(parsed.every((s) => s.height > 20));
      assert.ok(await b.evaluate(`(() => { const r = document.querySelector(".profile-popover").getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight; })()`), "the menu fits on screen");
      assert.ok(await noSidewaysScroll());
      // Still works.
      await click('.profile-popover [data-action="workspace-menu"]');
      assert.ok(await wait("!!document.querySelector('.workspace-popover')", 3000), "workspace switching");
    });
  }

  test("nothing in the app reads a person's status any more, so one saved earlier has no effect", () => {
    const assets = path.resolve(__dirname, "..", "..", "site", "assets");
    for (const file of fs.readdirSync(assets).filter((f) => /\.(js|css)$/.test(f))) assert.doesNotMatch(fs.readFileSync(path.join(assets, file), "utf8"), /presence/i, file);
  });

  let revealed;
  test("creating a token: choose boards, see it once, Escape and outside clicks can't lose it", async () => {
    await reload(DESKTOP);
    await click('[data-action="apitok-new"]');
    assert.ok(await wait("!!document.querySelector('form.apitok-modal')"));
    assert.match(await text("form.apitok-modal"), /Synthetic Ops/);
    assert.match(await text(".apitok-boards"), /Synthetic Board/);
    assert.match(await text("form.apitok-modal"), /Read-only/);
    assert.equal(await b.evaluate("document.querySelector('form.apitok-modal select[name=scope]').disabled"), true, "read-only is the only choice");
    // Asks for what's missing.
    await b.evaluate("document.querySelector('form.apitok-modal').requestSubmit()");
    assert.match(await text(".apitok-error"), /name/);
    await b.evaluate(`(() => { const f = document.querySelector("form.apitok-modal"); f.elements.name.value = "Power BI Integration"; f.requestSubmit(); })()`);
    assert.match(await text(".apitok-error"), /board/);
    await b.evaluate(`(() => { const f = document.querySelector("form.apitok-modal"); const box = [...f.querySelectorAll("input[name=board]")].find((i) => i.value === ${JSON.stringify(boardId)}); box.checked = true; f.requestSubmit(); })()`);
    assert.ok(await wait("!!document.querySelector('#apitok-secret')"), "token revealed");
    revealed = await b.evaluate("document.querySelector('#apitok-secret').value");
    assert.match(revealed, /^jarc_[0-9a-f]{24}_[A-Za-z0-9_-]{43}$/);
    assert.match(await text(".apitok-modal"), /won't see it again/);
    await b.evaluate(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await b.evaluate(`document.querySelector(".apitok-overlay").click()`);
    assert.ok(await has("#apitok-secret"), "still showing");
    await click('[data-action="apitok-copy"]');
    assert.ok(await wait(`/Copied/.test(document.querySelector('[data-action="apitok-copy"]').textContent) || document.activeElement?.id === "apitok-secret"`, 3000));
    // It isn't kept anywhere in the browser.
    const stored = await b.evaluate(`JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie])`);
    assert.ok(!stored.includes(revealed));
    await click('[data-action="apitok-done"]');
    assert.ok(await wait("!!document.querySelector('#apitok-root .apitok-table')"), "back to the list");
    const page = await b.evaluate("document.documentElement.outerHTML");
    assert.ok(!page.includes(revealed), "gone from the page");
    assert.match(await text(".apitok-table"), /Power BI Integration/);
    assert.match(await text(".apitok-table"), /Synthetic Board/);
    assert.match(await text(".apitok-table"), /Active/);
  });

  test("the new token reads the board; the list then shows when it was last used", async () => {
    const res = JSON.parse(await b.evaluate(`fetch("/api/v1/external/boards/${boardId}/records", { credentials: "omit", headers: { Authorization: "Bearer ${revealed}" } }).then(async (r) => JSON.stringify({ status: r.status, body: await r.json() }))`));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((r) => r.values.serial), ["Row one"]);
    await reload(DESKTOP);
    assert.ok(await wait("!!document.querySelector('.apitok-table')"));
    assert.doesNotMatch(await b.evaluate(`[...document.querySelectorAll('.apitok-table td[data-label="Last used"]')][0].textContent`), /Never/);
  });

  for (const [label, viewport] of [["desktop", DESKTOP], ["mobile", MOBILE]]) {
    test(`Developer Center (${label}): every section opens, fits the screen and shows no token`, async () => {
      await reload(viewport, "overview");
      assert.ok(await wait("!!document.querySelector('.apitok-overview .apitok-stats')", 8000), "overview");
      const nav = JSON.parse(await b.evaluate(`JSON.stringify([...document.querySelectorAll('.developer-window .settings-nav [data-action="apitok-tab"]')].map((x) => x.title))`));
      assert.deepEqual(nav, ["Overview", "API Tokens", "API Explorer", "Boards & Columns", "Documentation", "API Activity"]);
      assert.match(await text(".apitok-overview"), /same for everyone/);
      assert.ok((await text(".apitok-overview")).includes(`${base}/api/v1/external`));
      const ids = ["overview", "tokens", "explorer", "directory", "docs", "activity"];
      for (const [section, selector] of [["overview", ".apitok-overview"], ["tokens", ".apitok-table"], ["explorer", ".apitok-ex-columns"], ["directory", ".apitok-dir-columns"], ["docs", ".apitok-docs"], ["activity", ".apitok-activity"]]) {
        await click(`.developer-window .settings-nav [data-action="apitok-tab"][data-tab="${section}"]`);
        assert.ok(await wait(`!!document.querySelector('#apitok-root ${selector}')`, 8000), section);
        assert.equal(await text("#apitok-title"), nav[ids.indexOf(section)]);
        assert.ok(await noSidewaysScroll(), `${section}: no sideways page scroll`);
        assert.ok(await b.evaluate(`(() => { const r = document.querySelector(".developer-window").getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1; })()`), `${section}: the window fits`);
        assert.doesNotMatch(await b.evaluate(`document.querySelector("#apitok-root").innerHTML`), /jarc_[0-9a-f]{24}_/, `${section}: no token`);
      }
      assert.match(await text(".apitok-activity"), /Power BI Integration/);
      assert.doesNotMatch(await b.evaluate(`document.querySelector('.apitok-activity td[data-label="Last used"]').textContent`), /Never/);
      await click('.developer-window [data-action="close-overlay"]');
      assert.ok(await wait("!document.querySelector('.developer-window')", 3000), "closes");
    });
  }

  test("Settings → API Tokens opens the Developer Center at its tokens", async () => {
    await b.open(`${base}/`, DESKTOP);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 15000));
    let listed = false;
    for (let i = 0; i < 4 && !listed; i++) { if (!(await has(".settings-window"))) await click('[data-action="settings"]'); listed = await wait("!!document.querySelector('.settings-window [data-section=\"api-tokens\"]')", 3000); }
    assert.ok(listed);
    await click('.settings-window [data-section="api-tokens"]');
    assert.ok(await wait("!!document.querySelector('.developer-window #apitok-root .apitok-table')", 8000));
    assert.equal(await text("#apitok-title"), "API Tokens");
  });

  test("the documentation opens from the section and uses this server's address, on desktop and mobile", async () => {
    for (const viewport of [DESKTOP, MOBILE]) {
      await reload(viewport);
      await click('[data-action="apitok-tab"][data-tab="docs"]');
      assert.ok(await wait("!!document.querySelector('.apitok-docs')"));
      const docs = await text(".apitok-docs");
      for (const part of ["Base URL", `${base}/api/v1/external`, "Pagination", "Rate limits", "Common errors", "Security recommendations", "Power Query M", "Power Automate", "n8n", "secure backend", "curl -H"]) assert.ok(docs.includes(part), part);
      assert.ok(!docs.includes(revealed));
      assert.ok(await noSidewaysScroll(), "no sideways page scroll");
      assert.ok(await b.evaluate(`[...document.querySelectorAll(".apitok-docs pre")].every((p) => p.getBoundingClientRect().right <= window.innerWidth + 1)`), "code stays on screen");
      await click('[data-action="apitok-tab"][data-tab="tokens"]');
      assert.ok(await has(".apitok-table"));
      assert.ok(await noSidewaysScroll());
    }
  });

  test("rotating and revoking, with confirmation (mobile)", async () => {
    await reload(MOBILE);
    assert.ok(await noSidewaysScroll());
    await click('[data-action="apitok-rotate"]');
    assert.ok(await wait("!!document.querySelector('form[data-action=\"apitok-rotate-form\"]')"));
    assert.ok(await noSidewaysScroll());
    await b.evaluate(`document.querySelector('form[data-action="apitok-rotate-form"]').requestSubmit()`);
    assert.ok(await wait("!!document.querySelector('#apitok-secret')"));
    const replacement = await b.evaluate("document.querySelector('#apitok-secret').value");
    assert.notEqual(replacement, revealed);
    assert.ok(await noSidewaysScroll(), "the token fits on a phone");
    assert.ok(!(await b.evaluate(`JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])`)).includes(replacement));
    await click('[data-action="apitok-done"]');
    assert.ok(await wait("!!document.querySelector('.apitok-table')"));
    assert.match(await text(".apitok-table"), /Being replaced/);
    await click('[data-action="apitok-revoke"]');
    assert.ok(await wait("!!document.querySelector('form[data-action=\"apitok-revoke-form\"]')"));
    assert.match(await text('form[data-action="apitok-revoke-form"]'), /can't be undone/);
    await b.evaluate(`document.querySelector('form[data-action="apitok-revoke-form"]').requestSubmit()`);
    assert.ok(await wait("/Revoked/.test(document.querySelector('.apitok-table')?.textContent || '')"), "marked revoked");
  });

  // Records what the app copies, whichever way the browser allows it.
  const captureClipboard = () => b.evaluate(`(() => { window.__copied = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } }); return true; })()`);
  const copied = () => b.evaluate("JSON.stringify(window.__copied)").then(JSON.parse);
  const openBoard = async (viewport) => {
    await b.open(`${base}/`, viewport);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 15000));
    await b.evaluate(`(() => { const el = [...document.querySelectorAll("button, a")].find((e) => /Synthetic Board/.test(e.textContent) && !e.closest(".popover")); el?.click(); })()`);
    return wait("!!document.querySelector('th [data-action=\"column-menu\"], [data-action=\"column-menu\"]')", 8000);
  };

  for (const [label, viewport] of [["desktop", DESKTOP], ["mobile", MOBILE]]) {
    test(`board and column menus (${label}): copy IDs and see API Information, with no token`, async () => {
      assert.ok(await openBoard(viewport), "the board opens");
      await captureClipboard();
      await click('[data-action="board-menu"]');
      assert.ok(await wait("!!document.querySelector('.board-popover [data-action=\"apitok-copy-board\"]')", 3000), "Copy Board ID offered");
      assert.match(await text('.board-popover [data-action="apitok-copy-board"]'), /Copy Board ID/);
      await click('.board-popover [data-action="apitok-copy-board"]');
      assert.ok(await wait("window.__copied.length === 1", 3000));
      assert.deepEqual(await copied(), [boardId]);

      // Board → API Information: its IDs and every endpoint, then straight into the API Explorer.
      await click('[data-action="board-menu"]');
      assert.ok(await wait("!!document.querySelector('.board-popover [data-action=\"apitok-board-info\"]')", 3000), "API Information offered");
      await click('.board-popover [data-action="apitok-board-info"]');
      assert.ok(await wait("!!document.querySelector('.apitok-board-info')", 3000), "board API Information opens");
      const boardInfo = await text(".apitok-board-info");
      for (const part of ["Board name", "Synthetic Board", "Workspace", "Synthetic Ops", "Board API ID", boardId, `/api/v1/external/boards/${boardId}`, `/boards/${boardId}/records`, `/boards/${boardId}/columns`, `/boards/${boardId}/groups`, "YOUR_JARC_API_TOKEN", "Copy Board ID", "Open in API Explorer"]) assert.ok(boardInfo.includes(part), part);
      assert.doesNotMatch(await b.evaluate(`document.querySelector(".apitok-board-info").innerHTML`), /jarc_[0-9a-f]{24}_/);
      assert.ok(await noSidewaysScroll());
      await click(`.apitok-board-info [data-copy="${base}/api/v1/external/boards/${boardId}/records"]`);
      assert.ok(await wait("window.__copied.length === 2", 3000));
      assert.equal((await copied())[1], `${base}/api/v1/external/boards/${boardId}/records`);
      await click('.apitok-board-info .modal-actions [data-action="apitok-copy-value"]');
      assert.ok(await wait("window.__copied.length === 3", 3000));
      assert.equal((await copied())[2], boardId, "Copy Board ID");
      await click('.apitok-board-info [data-action="apitok-open-explorer"]');
      assert.ok(await wait(`document.querySelector('[data-action="apitok-ex-board"]')?.value === ${JSON.stringify(boardId)} && !!document.querySelector('.apitok-ex-columns')`, 8000), "the Explorer opens on this board");
      assert.equal(await text("#apitok-title"), "API Explorer");
      await click('.developer-window [data-action="close-overlay"]');
      assert.ok(await wait("!document.querySelector('.developer-window')", 3000));
      await b.evaluate("window.__copied.length = 1");

      await click('[data-action="column-menu"][data-key="serial"]');
      assert.ok(await wait("!!document.querySelector('.column-menu-popover [data-action=\"apitok-copy-column\"]')", 3000), "Copy Column ID offered");
      assert.ok(await b.evaluate(`(() => { const r = document.querySelector(".column-menu-popover").getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; })()`), "the menu fits");
      await click('.column-menu-popover [data-action="apitok-copy-column"]');
      assert.ok(await wait("window.__copied.length === 2", 3000));
      assert.equal((await copied())[1], "serial");

      await click('[data-action="column-menu"][data-key="serial"]');
      assert.ok(await wait("!!document.querySelector('.column-menu-popover [data-action=\"apitok-column-info\"]')", 3000));
      await click('.column-menu-popover [data-action="apitok-column-info"]');
      assert.ok(await wait("!!document.querySelector('.apitok-info')", 3000), "API Information opens");
      const info = await text(".apitok-info");
      for (const part of ["Board name", "Synthetic Board", "Board API ID", boardId, "Column name", "Column API ID", "serial", "Column type", "Column endpoint", `/api/v1/external/boards/${boardId}/columns/serial`, `/api/v1/external/boards/${boardId}/columns/serial/values`, "Records with this column", `/boards/${boardId}/records?columns=serial`, "COLUMN_ID_1,COLUMN_ID_2", "YOUR_JARC_API_TOKEN", "Copy Column ID", "Open in API Explorer"]) assert.ok(info.includes(part), part);
      assert.doesNotMatch(await b.evaluate(`document.querySelector(".apitok-info").innerHTML`), /jarc_[0-9a-f]{24}_/);
      assert.ok(await noSidewaysScroll());
      await click('.apitok-info [data-label="Endpoint"]');
      assert.ok(await wait("window.__copied.length === 3", 3000));
      assert.equal((await copied())[2], `${base}/api/v1/external/boards/${boardId}/columns/serial/values`);
      await click('.apitok-info [data-action="apitok-open-explorer"]');
      assert.ok(await wait(`document.querySelector('[data-action="apitok-ex-op"]')?.value === "values" && document.querySelector("#apitok-root")?.textContent.includes(${JSON.stringify(`${base}/api/v1/external/boards/${boardId}/columns/serial/values`)})`, 8000), "the Explorer opens on this column's values");
      assert.equal(await b.evaluate(`document.querySelector('[data-action="apitok-ex-one"][value="serial"]').checked`), true);
      await click('.developer-window [data-action="close-overlay"]');
    });
  }

  for (const [label, viewport] of [["desktop", DESKTOP], ["mobile", MOBILE]]) {
    test(`API Explorer (${label}): choose a board, an operation and columns, copy the address and examples, see a preview`, async () => {
      await reload(viewport, "explorer");
      await captureClipboard();
      assert.ok(await wait("!!document.querySelector('.apitok-ex-columns')", 8000), "columns listed");
      const body = () => text("#apitok-root");
      await b.evaluate(`(() => { const s = document.querySelector('[data-action="apitok-ex-board"]'); s.value = ${JSON.stringify(boardId)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      assert.ok(await wait(`document.querySelector("#apitok-root").textContent.includes(${JSON.stringify(boardId)})`, 5000), "the board's ID");
      const address = `${base}/api/v1/external/boards/${boardId}/records`;
      assert.ok((await body()).includes(address));
      await b.evaluate(`document.querySelector('[data-action="apitok-ex-column"][value="serial"]').click()`);
      assert.ok(await wait(`document.querySelector("#apitok-root").textContent.includes(${JSON.stringify(`${address}?columns=serial`)})`, 3000), "the address follows the selection");
      assert.ok((await body()).includes(`/columns/serial/values`), "one column: its own address too");
      await click('#apitok-root [data-action="apitok-copy-value"][data-copy*="?columns=serial"]');
      assert.ok(await wait("window.__copied.length === 1", 3000));
      assert.equal((await copied())[0], `${address}?columns=serial`);
      await click('[data-action="apitok-ex-example"]');
      assert.ok(await wait("!!document.querySelector('#apitok-ex-example')", 5000), "example shown");
      const example = JSON.parse(await text("#apitok-ex-example"));
      assert.deepEqual(example.items.map((r) => r.values), [{ serial: "Row one" }]);
      assert.ok(await noSidewaysScroll());

      // Another operation, with paging options: the address, the examples and the preview follow.
      await setValue('[data-action="apitok-ex-op"]', "values");
      const values = `${base}/api/v1/external/boards/${boardId}/columns/serial/values`;
      assert.ok(await wait(`document.querySelector("#apitok-root").textContent.includes(${JSON.stringify(values)})`, 3000), "one column's values");
      await setValue('[data-action="apitok-ex-param"][data-param="limit"]', "50");
      await setValue('[data-action="apitok-ex-param"][data-param="includeArchived"]', true);
      const withOptions = `${values}?limit=50&includeArchived=true`;
      assert.ok(await wait(`[...document.querySelectorAll('[data-action="apitok-copy-value"]')].some((x) => x.dataset.copy === ${JSON.stringify(withOptions)})`, 3000), "options go into the address");
      const curl = await text("#apitok-example-ex-curl"), js = await text("#apitok-example-ex-js");
      assert.ok(curl.includes(withOptions) && curl.includes("Authorization: Bearer $JARC_API_TOKEN"), "cURL");
      assert.ok(js.includes(withOptions) && js.includes("process.env.JARC_API_TOKEN") && js.includes("nextCursor"), "JavaScript");
      await click('[data-action="apitok-copy-example"][data-example="ex-curl"]');
      assert.ok(await wait("window.__copied.length === 2", 3000));
      assert.equal((await copied())[1], curl);
      await setValue('[data-action="apitok-ex-param"][data-param="limit"]', "900");
      assert.ok(await wait(`/1 to 500/.test(document.querySelector("#apitok-root .apitok-error")?.textContent || "")`, 3000), "an out-of-range page size is explained…");
      assert.ok(!(await text("#apitok-example-ex-curl")).includes("limit=900"), "…and left out");
      await click('[data-action="apitok-ex-example"]');
      assert.ok(await wait("!!document.querySelector('#apitok-ex-example')", 5000));
      const valuesExample = JSON.parse(await text("#apitok-ex-example"));
      assert.deepEqual(valuesExample.items.map((v) => [v.columnId, v.value]), [["serial", "Row one"]]);
      await setValue('[data-action="apitok-ex-op"]', "groups");
      assert.ok(await wait(`document.querySelector("#apitok-root").textContent.includes(${JSON.stringify(`${base}/api/v1/external/boards/${boardId}/groups`)})`, 3000));
      await click('[data-action="apitok-ex-example"]');
      assert.ok(await wait("!!document.querySelector('#apitok-ex-example')", 5000));
      assert.ok(Array.isArray(JSON.parse(await text("#apitok-ex-example")).items));
      assert.ok(await noSidewaysScroll());
      assert.doesNotMatch(await b.evaluate(`document.querySelector("#apitok-root").innerHTML`), /jarc_[0-9a-f]{24}_/, "no token anywhere");
      assert.ok(await b.evaluate(`!/[?&](token|access_token|api_key)=/.test(document.querySelector("#apitok-root").textContent)`));
    });
  }

  test("a column added in the app has its API ID and endpoint at once; a token made before it reads it with no setup", async () => {
    await b.open(`${base}/`, DESKTOP);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 15000));
    // A token for this board, made BEFORE the column exists.
    const earlier = await b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const ws = (await (await fetch("/api/v1/workspaces")).json()).items.find((w) => w.name === "Synthetic Ops"); const r = await fetch("/api/v1/me/api-tokens", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ name: "Before the column", workspaceId: ws.id, boardIds: [${JSON.stringify(boardId)}], scopes: ["read"], expiresAt: new Date(Date.now() + 7 * 864e5).toISOString() }) }); return (await r.json()).secret; })()`);
    assert.match(earlier, /^jarc_/);
    // Add the column the way an employee does: Add column → type → name → save.
    assert.ok(await openBoard(DESKTOP), "the board opens");
    await click('th [data-action="add-column"]');
    assert.ok(await wait("!!document.querySelector('.chooser-option[data-type=\"text\"]')", 8000), "column chooser open");
    await click('.chooser-option[data-type="text"]');
    assert.ok(await wait("!!document.querySelector('[data-action=create-column-form]')", 8000), "name step open");
    await b.evaluate(`(() => { const f = document.querySelector("[data-action=create-column-form]"); f.elements.label.value = "Approval Note"; f.requestSubmit(); })()`);
    const serverKey = () => b.evaluate(`fetch("/api/v1/boards/${boardId}").then((r) => r.json()).then((x) => x.board.columns.find((c) => c.label === "Approval Note")?.key || "")`);
    assert.ok(await wait(`fetch("/api/v1/boards/${boardId}").then((r) => r.json()).then((x) => x.board.columns.some((c) => c.label === "Approval Note"))`, 10000), "saved on the server");
    const key = await serverKey();
    assert.match(key, /^custom_[A-Za-z0-9_]+$/, "a permanent ID was assigned automatically");
    // Column menu → API Information shows it, with its endpoints, at once.
    await captureClipboard();
    assert.ok(await wait(`!!document.querySelector('[data-action="column-menu"][data-key="${key}"]')`, 8000));
    await click(`[data-action="column-menu"][data-key="${key}"]`);
    assert.ok(await wait("!!document.querySelector('.column-menu-popover [data-action=\"apitok-column-info\"]')", 3000));
    await click('.column-menu-popover [data-action="apitok-column-info"]');
    assert.ok(await wait("!!document.querySelector('.apitok-info')", 3000));
    const values = `${base}/api/v1/external/boards/${boardId}/columns/${key}/values`;
    const info = await text(".apitok-info");
    for (const part of ["Approval Note", key, boardId, values, `${base}/api/v1/external/boards/${boardId}/columns/${key}`]) assert.ok(info.includes(part), part);
    await click('.apitok-info .modal-actions [data-action="apitok-copy-value"]');
    await click('.apitok-info [data-label="Endpoint"]');
    assert.ok(await wait("window.__copied.length === 2", 3000));
    assert.deepEqual(await copied(), [key, values], "Copy Column ID, then the endpoint");
    await click('.apitok-info [data-action="close-overlay"]');
    // The token made earlier reads the new column: no new token, no setup.
    const read = JSON.parse(await b.evaluate(`fetch(${JSON.stringify(values)}, { credentials: "omit", headers: { Authorization: "Bearer " + ${JSON.stringify(earlier)} } }).then(async (r) => JSON.stringify({ status: r.status, body: await r.json() }))`));
    assert.equal(read.status, 200);
    assert.ok(read.body.items.every((v) => v.columnId === key && v.columnName === "Approval Note"));
    // Permanent: the same after a reload, and after renaming it.
    await b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const { board } = await (await fetch("/api/v1/boards/${boardId}")).json(); await fetch("/api/v1/boards/${boardId}", { method: "PATCH", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ expectedVersion: board.version, columns: board.columns.map((c) => c.key === ${JSON.stringify(key)} ? { ...c, label: "Approval Note (renamed)" } : c) }) }); })()`);
    assert.ok(await openBoard(DESKTOP));
    assert.ok(await wait(`!!document.querySelector('[data-action="column-menu"][data-key="${key}"]')`, 8000), "same ID after reload and rename");
    assert.equal(await b.evaluate(`fetch("/api/v1/boards/${boardId}").then((r) => r.json()).then((x) => x.board.columns.find((c) => c.key === ${JSON.stringify(key)})?.label)`), "Approval Note (renamed)");
    assert.equal((await b.evaluate(`fetch(${JSON.stringify(values)}, { credentials: "omit", headers: { Authorization: "Bearer " + ${JSON.stringify(earlier)} } }).then((r) => r.status)`)), 200);
  });

  for (const [label, viewport] of [["desktop", DESKTOP], ["mobile", MOBILE]]) {
    test(`Boards & Columns (${label}): search boards and columns, copy IDs and addresses`, async () => {
      await reload(viewport, "directory");
      await captureClipboard();
      assert.ok(await wait("!!document.querySelector('.apitok-dir-columns')", 8000), "the directory loads");
      const boards = () => b.evaluate(`JSON.stringify([...document.querySelectorAll('[data-action="apitok-dir-board"]')].map((x) => x.querySelector("strong").textContent))`).then(JSON.parse);
      assert.deepEqual((await boards()).sort(), ["Second Board", "Synthetic Board"]);
      await setValue('[data-action="apitok-dir-board-search"]', "second", "input");
      assert.deepEqual(await boards(), ["Second Board"], "board search");
      await setValue('[data-action="apitok-dir-board-search"]', "", "input");
      await click(`[data-action="apitok-dir-board"][data-id="${boardId}"]`);
      assert.ok(await wait(`document.querySelector(".apitok-dir-detail h3")?.textContent === "Synthetic Board"`, 3000), `chosen board: ${await text(".apitok-dir-detail h3")}`);
      const detail = await text(".apitok-dir-detail");
      const values = `${base}/api/v1/external/boards/${boardId}/columns/serial/values`;
      for (const part of ["Board", "Column", "Column type", "Column API ID", "API endpoint", boardId, "serial", "…/columns/serial/values", `${base}/api/v1/external/boards/${boardId}/records`]) assert.ok(detail.includes(part), part);
      assert.ok(await has(`#apitok-dir-rows [data-copy="${values}"]`), "Copy URL copies the full address");
      directoryIds = JSON.parse(await b.evaluate(`JSON.stringify([...document.querySelectorAll('#apitok-dir-rows td[data-label="Column API ID"]')].map((x) => x.textContent))`));
      assert.deepEqual(directoryIds.slice(0, 3), ["serial", "email", "status"], "the stored column keys, in board order");
      assert.equal(directoryIds.length, 4);
      assert.match(directoryIds[3], /^custom_/, "including the column added in the app");
      await setValue('[data-action="apitok-dir-column-search"]', "customer", "input");
      assert.deepEqual(JSON.parse(await b.evaluate(`JSON.stringify([...document.querySelectorAll('#apitok-dir-rows td[data-label="Column API ID"]')].map((x) => x.textContent))`)), ["email"], "search by name");
      await setValue('[data-action="apitok-dir-column-search"]', "zzz-nothing", "input");
      assert.match(await text("#apitok-dir-rows"), /No columns match/);
      await setValue('[data-action="apitok-dir-column-search"]', "serial", "input");
      assert.equal(await b.evaluate("document.querySelectorAll('#apitok-dir-rows tr').length"), 1, "search by ID");
      await click('#apitok-dir-rows [data-label="Column ID"]');
      assert.ok(await wait("window.__copied.length === 1", 3000), `copy ID: ${JSON.stringify(await copied())}`);
      await click('#apitok-dir-rows [data-label="Endpoint"]');
      assert.ok(await wait("window.__copied.length === 2", 3000), `copy URL: ${JSON.stringify(await copied())}`);
      assert.deepEqual(await copied(), ["serial", values]);
      assert.ok(await noSidewaysScroll());
      await click('#apitok-dir-rows [data-action="apitok-open-explorer"]');
      assert.ok(await wait(`document.querySelector('[data-action="apitok-ex-op"]')?.value === "values" && document.querySelector('[data-action="apitok-ex-board"]')?.value === ${JSON.stringify(boardId)}`, 8000), "Explore opens the column in the Explorer");
    });
  }

  test("someone without a membership is told why and offered nothing to create", async () => {
    await b.open(`${base}/api/v1/health`, DESKTOP);
    assert.equal(await signIn(OTHER, "Nora Nonadmin", false), 201);
    await b.open(`${base}/`, DESKTOP);
    assert.ok(await wait("!!document.querySelector('.app-shell, .entra-login')", 15000));
    await b.evaluate(`document.querySelector('[data-action="settings"]')?.click()`);
    assert.ok(await wait("!!document.querySelector('.settings-window [data-section=\"api-tokens\"]')"));
    await click('.settings-window [data-section="api-tokens"]');
    assert.ok(await wait("!!document.querySelector('#apitok-root .account-alert')"));
    assert.match(await text("#apitok-root .account-alert"), /own membership/);
    assert.equal(await has('[data-action="apitok-new"]'), false);
  });

  test("a Viewer member creates their own token, and sees exactly the same board and column IDs", async () => {
    assert.ok(directoryIds, "the directory test ran first");
    await b.open(`${base}/api/v1/health`, DESKTOP);
    const noraId = await b.evaluate(`fetch("/api/v1/me").then((r) => r.json()).then((x) => x.user.id)`);
    // Tess (a Workspace admin) adds Nora as a Viewer of Synthetic Ops.
    assert.equal(await signIn(OID, "Tess Token", true), 201);
    const added = await b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const ws = (await (await fetch("/api/v1/workspaces")).json()).items.find((w) => w.name === "Synthetic Ops"); const r = await fetch("/api/v1/workspaces/" + ws.id + "/members", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ userId: ${JSON.stringify(noraId)}, role: "VIEWER" }) }); return r.status; })()`);
    assert.equal(added, 201);
    assert.equal(await signIn(OTHER, "Nora Nonadmin", false), 201);
    await reload(DESKTOP);
    assert.ok(await has('[data-action="apitok-new"]'), "a Viewer may create a read-only token");
    await click('[data-action="apitok-new"]');
    assert.ok(await wait("!!document.querySelector('form.apitok-modal')"));
    await setValue('form.apitok-modal [data-action="apitok-all-boards"]', true);
    assert.equal(await b.evaluate(`[...document.querySelectorAll('form.apitok-modal input[name="board"]')].every((x) => x.checked)`), true, "Select all boards");
    await b.evaluate(`(() => { const f = document.querySelector("form.apitok-modal"); f.elements.name.value = "Nora n8n"; f.requestSubmit(); })()`);
    assert.ok(await wait("!!document.querySelector('#apitok-secret')"), "token revealed");
    const noraToken = await b.evaluate("document.querySelector('#apitok-secret').value");
    await click('[data-action="apitok-done"]');
    assert.ok(await wait("!!document.querySelector('#apitok-root .apitok-table')"));
    assert.match(await text(".apitok-table"), /Nora n8n/);
    assert.match(await text(".apitok-table"), /Synthetic Board, Second Board|Second Board, Synthetic Board/);
    const read = await b.evaluate(`fetch("/api/v1/external/boards/${boardId}/records?columns=serial", { credentials: "omit", headers: { Authorization: "Bearer " + ${JSON.stringify(noraToken)} } }).then((r) => r.status)`);
    assert.equal(read, 200, "one token reads the board and chosen columns");
    // The same IDs as Tess saw.
    await click('.developer-window [data-action="apitok-tab"][data-tab="directory"]');
    assert.ok(await wait("!!document.querySelector('.apitok-dir-columns')", 8000));
    await click(`[data-action="apitok-dir-board"][data-id="${boardId}"]`);
    assert.ok(await wait(`document.querySelector(".apitok-dir-detail h3")?.textContent === "Synthetic Board"`, 3000));
    assert.deepEqual(JSON.parse(await b.evaluate(`JSON.stringify([...document.querySelectorAll('#apitok-dir-rows td[data-label="Column API ID"]')].map((x) => x.textContent))`)), directoryIds);
    assert.ok((await text(".apitok-dir-detail")).includes(boardId));
  });

  test("switched off: no section, and no paths", async () => {
    const off = await start({});
    try {
      await b.open(`${off.url}/api/v1/health`, DESKTOP);
      assert.equal(await signIn(OID, "Tess Token", true), 201);
      await b.open(`${off.url}/`, DESKTOP);
      assert.ok(await wait("!!document.querySelector('.app-shell')", 15000));
      let open = false;
      for (let i = 0; i < 4 && !open; i++) { if (!(await has(".settings-window"))) await click('[data-action="settings"]'); open = await wait("!!document.querySelector('.settings-window')", 3000); }
      assert.ok(open);
      assert.equal(await has('.settings-window [data-section="api-tokens"]'), false);
      await click('.settings-window [data-action="close-overlay"]');
      let menu = false;
      for (let i = 0; i < 4 && !menu; i++) { await click('[data-action="profile-menu"]'); menu = await wait("!!document.querySelector('.profile-popover')", 2000); }
      assert.ok(menu);
      assert.equal(await has('.profile-popover [data-action="developer"]'), false, "no Developer item");
      assert.equal(await b.evaluate(`fetch("/api/v1/me/api-tokens").then((r) => r.status)`), 404);
    } finally { off.proc.kill(); }
  });
});
