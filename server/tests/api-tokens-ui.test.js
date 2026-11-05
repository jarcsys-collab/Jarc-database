// Settings → API Tokens and the profile menu in the REAL app, in a headless browser, against the test Entra server (local test keys,
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
  const openPanel = async () => {
    assert.ok(await wait("!!document.querySelector('.app-shell')", 15000), "app loaded");
    let listed = false;
    for (let i = 0; i < 4 && !listed; i++) { if (!(await has(".settings-window"))) await click('[data-action="settings"]'); listed = await wait("!!document.querySelector('.settings-window [data-section=\"api-tokens\"]')", 3000); }
    assert.ok(listed, "API Tokens section listed");
    await click('.settings-window [data-section="api-tokens"]');
    assert.ok(await wait("!!document.querySelector('#apitok-root .apitok-intro')"), "tokens loaded");
  };
  const reload = async (viewport) => { await b.open(`${base}/`, viewport); await openPanel(); };

  before(async () => {
    server = await start({ JARC_TEST_API_TOKENS: "1" });
    base = server.url;
    b = await launch(BROWSER);
    await b.motionPreference("reduce");
    await b.open(`${base}/api/v1/health`, DESKTOP);
    assert.equal(await signIn(OID, "Tess Token", true), 201);
    // A workspace this person created, so they hold a real admin membership.
    boardId = await b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const post = async (u, body) => (await fetch(u, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify(body) })).json(); const { workspace } = await post("/api/v1/workspaces", { name: "Synthetic Ops" }); const { board } = await post("/api/v1/workspaces/" + workspace.id + "/boards", { name: "Synthetic Board" }); await post("/api/v1/workspaces/" + workspace.id + "/boards", { name: "Second Board" }); await post("/api/v1/boards/" + board.id + "/records", { values: { serial: "Row one" } }); return board.id; })()`);
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
      for (const action of ["profile-settings", "settings", "notifications", "workspace-menu", "workspace-manage", "request-logout"]) assert.ok(await has(`.profile-popover [data-action="${action}"]`), action);
      assert.match(menu, /Tess Token/);
      // Three sections and no empty gap where Status was.
      const sections = await b.evaluate(`JSON.stringify([...document.querySelectorAll(".profile-popover .profile-menu-section")].map((s) => ({ buttons: s.querySelectorAll("button").length, height: s.getBoundingClientRect().height })))`);
      const parsed = JSON.parse(sections);
      assert.deepEqual(parsed.map((s) => s.buttons), [3, 2, 1]);
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
      for (const part of ["Board name", "Synthetic Board", "Board API ID", boardId, "Column name", "Column API ID", "serial", "Column type", `/api/v1/external/boards/${boardId}/columns/serial/values`, "YOUR_JARC_API_TOKEN"]) assert.ok(info.includes(part), part);
      assert.doesNotMatch(await b.evaluate(`document.querySelector(".apitok-info").innerHTML`), /jarc_[0-9a-f]{24}_/);
      assert.ok(await noSidewaysScroll());
      await click('.apitok-info [data-label="Endpoint"]');
      assert.ok(await wait("window.__copied.length === 3", 3000));
      assert.equal((await copied())[2], `${base}/api/v1/external/boards/${boardId}/columns/serial/values`);
      await click('.apitok-info [data-action="close-overlay"]');
    });
  }

  for (const [label, viewport] of [["desktop", DESKTOP], ["mobile", MOBILE]]) {
    test(`API Explorer (${label}): choose a board and columns, copy the address, see an example`, async () => {
      await reload(viewport);
      await captureClipboard();
      await click('[data-action="apitok-tab"][data-tab="explorer"]');
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
      assert.doesNotMatch(await b.evaluate(`document.querySelector("#apitok-root").innerHTML`), /jarc_[0-9a-f]{24}_/, "no token anywhere");
      assert.ok(await b.evaluate(`!/[?&](token|access_token|api_key)=/.test(document.querySelector("#apitok-root").textContent)`));
    });
  }

  test("someone without an admin membership is told why and offered nothing to create", async () => {
    await b.open(`${base}/api/v1/health`, DESKTOP);
    assert.equal(await signIn(OTHER, "Nora Nonadmin", false), 201);
    await b.open(`${base}/`, DESKTOP);
    assert.ok(await wait("!!document.querySelector('.app-shell, .entra-login')", 15000));
    await b.evaluate(`document.querySelector('[data-action="settings"]')?.click()`);
    assert.ok(await wait("!!document.querySelector('.settings-window [data-section=\"api-tokens\"]')"));
    await click('.settings-window [data-section="api-tokens"]');
    assert.ok(await wait("!!document.querySelector('#apitok-root .account-alert')"));
    assert.match(await text("#apitok-root .account-alert"), /Workspace admin membership/);
    assert.equal(await has('[data-action="apitok-new"]'), false);
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
      assert.equal(await b.evaluate(`fetch("/api/v1/me/api-tokens").then((r) => r.status)`), 404);
    } finally { off.proc.kill(); }
  });
});
