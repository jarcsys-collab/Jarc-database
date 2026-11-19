// Developer → API Keys, the guided Create API key window, in the REAL app, in a headless browser, against the test Entra server
// (local test keys, fake MongoDB, synthetic data only). What is checked here, beyond api-tokens-*-ui.test.js:
//   - keyboard and screen readers: the dialog is labelled, the steps say which is current, workspaces are buttons that say whether
//     they are expanded and what they control, the boards are a labelled group of real checkboxes, and the count is announced;
//   - large workspaces (synthetic lists of thousands of boards): only a page of boards is drawn, searching stays quick, and the
//     choice survives searching and collapsing; the 100-board limit is explained and nothing beyond it is selected;
//   - a board the server refuses (it disappeared, or was never real) keeps the window open on the review with the server's reason.
// AK_PERF=1 prints timings; AK_SHOTS=<folder> saves screenshots of every screen (desktop and phone). Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, freePort, waitForServer } = require("./support/headless-browser");
const { wizard } = require("./support/api-key-wizard");

const BROWSER = findBrowser();
const DESKTOP = { width: 1440, height: 900 }, MOBILE = { width: 390, height: 844 };
const OID = "0e7e7e7e-0000-4000-8000-0000000000c1";
const PERF = process.env.AK_PERF === "1", SHOTS = process.env.AK_SHOTS || "";
const hexId = (n) => n.toString(16).padStart(24, "0");
// A synthetic options answer: workspaces of these sizes, with made-up board IDs (never sent to the server, except on purpose).
const bigOptions = (sizes) => ({ limits: { boardsPerToken: 100, maxLifetimeYears: 5 }, workspaces: sizes.map((n, w) => ({ id: hexId(0xa0000 + w), name: `Synthetic Workspace ${w + 1}`, archived: false, boards: Array.from({ length: n }, (_, i) => ({ id: hexId(0xb000000 + w * 100000 + i), name: `Board ${w + 1}-${String(i + 1).padStart(4, "0")}`, archived: false })) })) });

describe("Create API key: accessibility, large workspaces and limits (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed", concurrency: false }, () => {
  let server, base, b, wz; const ids = {};
  const q = JSON.stringify;
  const signIn = (oid, name) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${oid}&name=${encodeURIComponent(name)}&email=${oid}@example.invalid&admin=1&nonce=" + encodeURIComponent(s.nonce))).json(); return (await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) })).status; })()`);
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1" + ${q(p)}, { method: ${q(method)}, headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) }, ${body === undefined ? "" : `body: ${q(JSON.stringify(body))},`} }); let json = null; try { json = await r.json(); } catch {} return { status: r.status, body: json }; })()`);
  const has = (sel) => b.evaluate(`!!document.querySelector(${q(sel)})`);
  const text = (sel) => b.evaluate(`document.querySelector(${q(sel)})?.textContent || ""`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; el.click(); return true; })()`);
  const wait = (expr, ms = 10000) => b.waitFor(expr, ms);
  const focused = () => b.evaluate(`(() => { const a = document.activeElement; return a ? { tag: a.tagName, action: a.dataset?.action || "", value: a.value || "", ws: a.dataset?.ws || "" } : null; })()`);
  const steerOptions = (body) => b.evaluate(`(() => { const A = ResourceApiAdapter.prototype; A.__real = A.__real || A.request; const body = ${q(body)};
    A.request = function (m, p, ...rest) { if (body && m === "GET" && String(p).endsWith("/me/api-tokens/options")) return Promise.resolve(JSON.parse(JSON.stringify(body))); return A.__real.call(this, m, p, ...rest); }; })()`);
  // Milliseconds from running `action` in the page until `until` holds, plus the frame that paints it.
  // Gives up after 10 s (then the caller's assertion fails) instead of waiting forever.
  const timed = async (action, until) => {
    const ms = await b.evaluate(`(async () => { const t0 = performance.now(); ${action}; while (!(${until})) { if (performance.now() - t0 > 10000) return -1; await new Promise((r) => requestAnimationFrame(r)); } await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); return Math.round(performance.now() - t0); })()`);
    assert.ok(ms >= 0, `timed out waiting for: ${until}`);
    return ms;
  };
  const report = (label, ms) => { if (PERF) console.log(`[perf] ${label}: ${ms} ms`); };
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const full = await b.evaluate(`(() => { const m = document.querySelector("#overlay-root .modal, #overlay-root .settings-window"); return m ? Math.ceil(Math.max(window.innerHeight, m.scrollHeight + 40)) : window.innerHeight; })()`);
    const res = await b.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip: undefined, fromSurface: true });
    if (res.result?.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(res.result.data, "base64"));
    return full;
  };
  const openDeveloper = async (viewport = DESKTOP, section = "tokens") => {
    await b.open(`${base}/`, viewport);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 15000), "app loaded");
    let open = false;
    for (let i = 0; i < 4 && !open; i++) {
      if (!(await has(".developer-window"))) { if (!(await has(".profile-popover"))) await click('[data-action="profile-menu"]'); await wait("!!document.querySelector('.profile-popover [data-action=\"developer\"]')", 2000); await click('.profile-popover [data-action="developer"]'); }
      open = await wait("!!document.querySelector('.developer-window #apitok-root')", 3000);
    }
    assert.ok(open, "Developer opens");
    await click(`.developer-window .settings-nav [data-action="apitok-tab"][data-tab="${section}"]`);
    if (section === "tokens") assert.ok(await wait("!!document.querySelector('#apitok-root [data-action=apitok-new]')"), "the keys have loaded");
  };

  before(async () => {
    const port = await freePort(); base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore", env: { ...process.env, JARC_TEST_API_TOKENS: "1", JARC_TEST_API_ADMINS: OID } });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER); wz = wizard(b);
    await b.motionPreference("reduce");
    await b.open(`${base}/api/v1/health`, DESKTOP);
    assert.equal(await signIn(OID, "Ada Keys"), 201);
    const board = async (ws, name) => (await api("POST", `/workspaces/${ws}/boards`, { name, columns: [{ key: "serial", label: "Item", type: "text", required: true }] })).body.board.id;
    ids.core = (await api("POST", "/workspaces", { name: "Core Example" })).body.workspace.id;
    ids.sales = (await api("POST", "/workspaces", { name: "Sales Example" })).body.workspace.id;
    ids.products = await board(ids.core, "Products"); ids.customers = await board(ids.core, "Customers");
    ids.chem = await board(ids.sales, "Chemistry"); ids.urine = await board(ids.sales, "Urine");
    for (const id of [ids.products, ids.chem]) await api("POST", `/boards/${id}/records`, { values: { serial: "synthetic row" } });
  });
  after(async () => { await b?.close(); server?.kill(); });

  test("keyboard and screen readers: labelled dialog and steps, expandable workspaces, a labelled group of checkboxes, an announced count", async () => {
    await openDeveloper();
    await wz.open();
    const dialog = await b.evaluate(`(() => { const f = document.querySelector("form.apikey-wizard"); return { role: f.getAttribute("role"), modal: f.getAttribute("aria-modal"), label: document.getElementById(f.getAttribute("aria-labelledby"))?.textContent, current: f.querySelector('.apikey-steps [aria-current="step"]')?.textContent, focus: document.activeElement?.name }; })()`);
    assert.deepEqual(dialog, { role: "dialog", modal: "true", label: "Create API key", current: "1Details", focus: "name" }, "a labelled modal dialog, on step 1, with the name focused");
    // Typing the name and pressing Enter moves on.
    await b.evaluate(`document.querySelector("form.apikey-wizard").elements.name.value = "Keyboard key"`);
    await b.key("Enter");
    assert.ok(await wz.listed(), "Enter goes to the boards");
    assert.equal((await focused()).action, "apitok-wiz-search", "the search box has the focus");
    assert.equal(await b.evaluate(`document.querySelector('.apikey-steps [aria-current="step"]').textContent`), "2Boards");
    // Enter in the search applies it and stays on this step.
    await b.evaluate(`(() => { const i = document.activeElement; i.value = "chem"; })()`);
    await b.key("Enter");
    assert.equal(await wz.step(), "boards", "Enter in the search doesn't leave the step");
    assert.deepEqual(await wz.workspaceNames(), ["Sales Example"]);
    await b.evaluate(`(() => { const i = document.querySelector('[data-action="apitok-wiz-search"]'); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); })()`); await wz.settle();
    // A workspace is a button with aria-expanded and aria-controls; Space opens it from the keyboard.
    const toggle = `#apikey-workspaces [data-action="apitok-wiz-toggle"][data-ws="${ids.sales}"]`;
    assert.equal(await b.evaluate(`document.querySelector(${q(toggle)}).getAttribute("aria-expanded")`), "false");
    await b.evaluate(`document.querySelector(${q(toggle)}).focus()`);
    await b.key(" ");
    assert.equal(await b.evaluate(`document.querySelector(${q(toggle)}).getAttribute("aria-expanded")`), "true", "Space expands it");
    assert.deepEqual(await focused(), { tag: "BUTTON", action: "apitok-wiz-toggle", value: "", ws: ids.sales }, "focus stays on the workspace");
    const group = await b.evaluate(`(() => { const t = document.querySelector(${q(toggle)}); const g = document.getElementById(t.getAttribute("aria-controls")); return { role: g.getAttribute("role"), label: g.getAttribute("aria-label"), hidden: g.hidden, boxes: g.querySelectorAll('input[type="checkbox"]').length }; })()`);
    assert.deepEqual(group, { role: "group", label: "Boards in Sales Example", hidden: false, boxes: 2 });
    // Space on a board's checkbox selects it, and the count is in a live region.
    await b.evaluate(`document.querySelector('#apikey-workspaces input[value="${ids.chem}"]').focus()`);
    await b.key(" ");
    assert.equal(await b.evaluate(`document.querySelector('#apikey-workspaces input[value="${ids.chem}"]').checked`), true, "Space ticks it");
    assert.equal(await b.evaluate(`document.querySelector("#apikey-count").getAttribute("aria-live")`), "polite");
    assert.match(await wz.count(), /1 board · 1 workspace selected/);
    assert.match(await b.evaluate(`document.querySelector('#apikey-workspaces input[data-action="apitok-wiz-all"][value="${ids.sales}"]').getAttribute("aria-label")`), /Select all 2 boards in Sales Example/);
    assert.equal(await b.evaluate(`document.querySelector('#apikey-workspaces input[data-action="apitok-wiz-all"][value="${ids.sales}"]').indeterminate`), true, "Select all shows the partial choice");
    // Removing from the summary is a labelled button.
    assert.ok(await has(`#apikey-chosen [data-action="apitok-wiz-remove"][aria-label="Remove Chemistry"]`));
    await shot("desktop-03-select-boards");
    // Review: the confirmation is a real checkbox, focused; Space ticks it and Create becomes available.
    await wz.next();
    assert.ok(await wait("document.querySelector('form.apikey-wizard')?.dataset.step === 'review'"));
    assert.equal((await focused()).action, "apitok-wiz-confirm");
    await b.key(" ");
    assert.equal(await b.evaluate(`document.querySelector('form.apikey-wizard [data-role="create"]').disabled`), false);
    await shot("desktop-04-review");
    await wz.cancel();
  });

  test("a large workspace: only a page of boards is drawn; search, expand and select stay quick; the choice survives", async () => {
    const opts = bigOptions([2500, 600, 40]);
    await openDeveloper();
    await steerOptions(opts);
    const openMs = await timed(`document.querySelector('[data-action="apitok-new"]').click()`, `document.querySelector("form.apikey-wizard")`);
    report("Create API key opens (step 1)", openMs);
    await b.evaluate(`document.querySelector("form.apikey-wizard").elements.name.value = "Large"`);
    const listMs = await timed(`document.querySelector('form.apikey-wizard [data-role="next"]').click()`, `document.querySelector("#apikey-workspaces .apikey-ws")`);
    report("board step with 3 workspaces / 3,140 boards", listMs);
    assert.equal(await b.evaluate(`document.querySelectorAll('#apikey-workspaces input[data-action="apitok-wiz-board"]').length`), 0, "collapsed workspaces draw no boards");
    const ws1 = opts.workspaces[0].id;
    const expandMs = await timed(`document.querySelector('#apikey-workspaces [data-action="apitok-wiz-toggle"][data-ws="${ws1}"]').click()`, `document.querySelectorAll('#apikey-workspaces input[data-ws="${ws1}"]').length > 0`);
    report("expand a 2,500-board workspace", expandMs);
    assert.equal(await b.evaluate(`document.querySelectorAll('#apikey-workspaces input[data-action="apitok-wiz-board"][data-ws="${ws1}"]').length`), 200, "one page of 200 is drawn, not 2,500");
    assert.match(await text(`#apikey-workspaces [data-action="apitok-wiz-more"][data-ws="${ws1}"]`), /Show 200 more of 2300/);
    await click(`#apikey-workspaces [data-action="apitok-wiz-more"][data-ws="${ws1}"]`);
    assert.equal(await b.evaluate(`document.querySelectorAll('#apikey-workspaces input[data-ws="${ws1}"][data-action="apitok-wiz-board"]').length`), 400, "the next page");
    // Ticks before searching are kept, and a search finds boards that weren't drawn.
    const first = opts.workspaces[0].boards[0].id, deep = opts.workspaces[0].boards[2400];
    await wz.tick(first);
    const searchMs = await timed(`(() => { const i = document.querySelector('[data-action="apitok-wiz-search"]'); i.value = "Board 1-2401"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`, `document.querySelector('#apikey-workspaces input[value="${deep.id}"]')`);
    report("search 3,140 boards (incl. 120 ms typing pause)", searchMs);
    assert.deepEqual(await wz.boardValues(), [deep.id], "only the match is drawn");
    await wz.tick(deep.id);
    await wz.search(""); await wz.settle();
    assert.match(await wz.count(), /2 boards · 1 workspace selected/, "both kept");
    // Select all in a 40-board workspace is quick; in a 600-board workspace it would pass the 100-board limit, so it's refused.
    const ws3 = opts.workspaces[2].id, ws2 = opts.workspaces[1].id;
    await wz.expand(ws3);
    const allMs = await timed(`document.querySelector('#apikey-workspaces input[data-action="apitok-wiz-all"][value="${ws3}"]').click()`, `/42 boards/.test(document.querySelector("#apikey-count").textContent)`);
    report("select all 40 boards", allMs);
    await wz.selectAll(ws2);
    assert.match(await text("form.apikey-wizard .apitok-error"), /at most 100 boards/);
    assert.match(await wz.count(), /42 boards · 2 workspaces selected/, "nothing was added");
    assert.equal(await b.evaluate(`document.querySelector('#apikey-workspaces input[data-action="apitok-wiz-all"][value="${ws2}"]').checked`), false);
    // DOM stays small: at most the expanded pages.
    const nodes = await b.evaluate(`document.querySelectorAll("#apikey-workspaces *").length`);
    if (PERF) console.log(`[perf] elements in the board list after expanding 2 workspaces: ${nodes}`);
    assert.ok(nodes < 2500, `the list stays small: ${nodes} elements`);
    for (const [label, ms] of [["open", openMs], ["list", listMs], ["expand", expandMs], ["search", searchMs], ["select all", allMs]]) assert.ok(ms < 2000, `${label} took ${ms} ms`);
    await wz.cancel();
    await steerOptions(null);
  });

  test("boards the server refuses keep the window open on the review, with the reason, and nothing is created", async () => {
    await openDeveloper();
    const before_ = (await api("GET", "/me/api-tokens")).body.items.length;
    // The list offers a board that doesn't exist (as if it were deleted after the list was read).
    const opts = { workspaces: [{ id: ids.core, name: "Core Example", archived: false, boards: [{ id: ids.products, name: "Products", archived: false }, { id: hexId(0xdead), name: "Deleted meanwhile", archived: false }] }] };
    await steerOptions(opts);
    await wz.open(); await wz.details({ name: "Refused" }); assert.ok(await wz.listed());
    await wz.tick(ids.products, ids.core); await wz.tick(hexId(0xdead));
    await wz.next();
    await click('form.apikey-wizard input[data-action="apitok-wiz-confirm"]');
    await steerOptions(null); // from here on the list comes from the server, without the made-up board
    await click('form.apikey-wizard [data-role="create"]');
    assert.ok(await wait(`/A selected board is no longer available/.test(document.querySelector("form.apikey-wizard .apitok-error")?.textContent || "")`, 5000), "explained");
    assert.equal(await wz.step(), "review");
    assert.equal((await api("GET", "/me/api-tokens")).body.items.length, before_, "nothing created");
    // The real list no longer offers the made-up board: going back shows it was taken out, and the real board stays chosen.
    await b.waitFor("false", 400); // the refreshed list arrives
    await wz.back();
    assert.ok(await wz.listed());
    assert.match(await text("#apikey-workspaces"), /1 selected board is no longer available/);
    assert.match(await wz.count(), /1 board · 1 workspace selected/);
    await wz.cancel();
  });

  test("creating, the secret screen and connection details: timings and screenshots (desktop and phone)", async () => {
    for (const [label, viewport] of [["desktop", DESKTOP], ["phone", MOBILE]]) {
      const devMs = await (async () => { await b.open(`${base}/`, viewport); assert.ok(await wait("!!document.querySelector('.app-shell')", 15000)); await click('[data-action="profile-menu"]'); await wait("!!document.querySelector('.profile-popover [data-action=\"developer\"]')", 3000); return timed(`document.querySelector('.profile-popover [data-action="developer"]').click()`, `document.querySelector(".apikey-stats")`); })();
      report(`${label}: Developer Center opens with its overview stats`, devMs);
      await shot(`${label}-01-overview`);
      const listMs = await timed(`document.querySelector('.developer-window [data-action="apitok-tab"][data-tab="tokens"]').click()`, `document.querySelector("#apitok-root .apitok-intro")`);
      report(`${label}: API Keys list`, listMs);
      await shot(`${label}-02-api-keys`);
      await wz.open(); await wz.details({ name: `Company Reports ${label}`, description: "Power BI dashboards" }); assert.ok(await wz.listed());
      await wz.tick(ids.products, ids.core); await wz.tick(ids.customers, ids.core); await wz.tick(ids.chem, ids.sales); await wz.tick(ids.urine, ids.sales);
      if (label === "phone") await shot("phone-03-select-boards");
      await wz.next();
      if (label === "phone") await shot("phone-04-review");
      await click('form.apikey-wizard input[data-action="apitok-wiz-confirm"]');
      const createMs = await timed(`document.querySelector('form.apikey-wizard [data-role="create"]').click()`, `document.querySelector("#apitok-secret")`);
      report(`${label}: create a key for 4 boards in 2 workspaces`, createMs);
      assert.ok(await b.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), `${label}: no sideways scrolling on the secret screen`);
      // The screenshot shows a secret from the synthetic test server only; it is masked anyway.
      await b.evaluate(`document.querySelector("#apitok-secret").value = "jarc_••••••••••••••••••••••••_••••••••"`);
      await shot(`${label}-05-created`);
      await click('[data-action="apitok-done"]');
      assert.ok(await wait("!!document.querySelector('#apikey-list')"));
      assert.ok(await b.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), `${label}: the key cards fit`);
      await shot(`${label}-02b-api-keys-with-keys`);
      const id = await b.evaluate(`[...document.querySelectorAll("#apikey-list .apikey-card")].find((c) => c.textContent.includes(${q(`Company Reports ${label}`)})).dataset.id`);
      const detailsMs = await timed(`document.querySelector('#apikey-list [data-action="apitok-details"][data-id="${id}"]').click()`, `document.querySelector(".apikey-details")`);
      report(`${label}: open connection details`, detailsMs);
      assert.ok(await b.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), `${label}: details fit`);
      await shot(`${label}-06-connection-details`);
      await click('[data-action="apitok-key-explorer"]');
      assert.ok(await wait("!!document.querySelector('#apitok-root .apitok-ex-columns')", 8000));
      await shot(`${label}-07-explorer`);
      await click('.developer-window [data-action="apitok-tab"][data-tab="activity"]');
      assert.ok(await wait("!!document.querySelector('#apikey-events')", 8000));
      await shot(`${label}-08-activity`);
      await click('.developer-window [data-action="apitok-tab"][data-tab="docs"]');
      assert.ok(await wait("!!document.querySelector('.apitok-docs')", 8000));
      await shot(`${label}-09-docs`);
      for (const ms of [devMs, listMs, createMs, detailsMs]) assert.ok(ms < 3000, `${label}: ${ms} ms`);
    }
  });
});
