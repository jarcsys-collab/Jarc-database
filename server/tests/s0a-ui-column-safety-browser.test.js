// Column System S0-A in the REAL app, in a headless browser (Chrome/Edge), against the Entra test server (shared access,
// fake MongoDB, synthetic data). Change type → the server's dry run decides: a refusal (or "board too large") opens a
// dialog with the counts and masked examples and no convert button, and nothing changes on the server; a lossless change
// is converted. The server's S0-A answers (CONVERSION_REFUSED, VALIDATION_ERROR) are played by a fetch wrapper in the
// page, so this test doesn't depend on the server half; the lossless conversion is real. Also: an unsafe stored link is
// text with a flag, a refused link / email gets a type-specific message, and the CSV export guard.
// JARC_S0A_SHOTS=<dir> saves screenshots of the refusal dialog (light/dark, 390/1440 px). Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const SHOTS = process.env.JARC_S0A_SHOTS || "";
const OID = "0a0a0a0a-0000-4000-8000-0000000005a1";
const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "amount", label: "Amount", type: "text" },
  { key: "count", label: "Count", type: "text" },
  { key: "site", label: "Website", type: "link" },
  { key: "mail", label: "Email", type: "email" },
  { key: "qty", label: "Qty", type: "number" }
];
// In the page before the app loads: plays planned answers for the type-change endpoint and record PATCHes, records every
// type-change call, and gives one record a stored javascript: link (as an old value would be).
const FETCH_WRAPPER = `(() => {
  window.__s0a = { calls: [], dry: null, real: null, patch: null };
  const original = window.fetch.bind(window);
  const answer = (plan) => new Response(JSON.stringify(plan.body), { status: plan.status, headers: { "Content-Type": "application/json" } });
  window.fetch = async (url, init = {}) => {
    const u = String(url), method = (init.method || "GET").toUpperCase();
    if (method === "POST" && /\\/columns\\/[^/]+\\/type(\\?|$)/.test(u)) {
      const dry = /[?&]dryRun=true/.test(u); window.__s0a.calls.push({ dry, url: u, body: init.body ? JSON.parse(init.body) : null });
      const plan = dry ? window.__s0a.dry : window.__s0a.real; if (plan) return answer(plan);
    }
    if (method === "PATCH" && /\\/records\\/[^/?]+$/.test(u) && window.__s0a.patch) return answer(window.__s0a.patch);
    const res = await original(url, init);
    if (method === "GET" && /\\/boards\\/[^/]+\\/records(\\?|$)/.test(u) && res.ok) {
      const body = await res.clone().json();
      for (const r of body.items || []) if (r.values?.serial === "Unsafe row") r.values.site = "javascript:alert(document.domain)";
      return new Response(JSON.stringify(body), { status: res.status, headers: { "Content-Type": "application/json" } });
    }
    return res;
  };
})();`;

describe("S0-A column safety (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, board;
  const signIn = () => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OID}&name=Ana%20Reyes&email=ana@example.invalid&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const records = async () => (await api("GET", `/boards/${board.id}/records?limit=200`)).body.items;
  const record = async (serial) => (await records()).find((r) => r.values.serial === serial);
  const column = async (key) => (await api("GET", `/boards/${board.id}`)).body.board.columns.find((c) => c.key === key);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "center", inline: "center" }); el.click(); return true; })()`);
  const text = (sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? null`);
  const cellSel = (serial, key) => `tr:has(td[data-column-key="serial"] [aria-label="Item: ${serial}"]) td[data-column-key="${key}"]`;
  const plan = (p) => b.evaluate(`Object.assign(window.__s0a, ${JSON.stringify(p)})`);
  const calls = () => b.evaluate("JSON.parse(JSON.stringify(window.__s0a.calls))");
  const openBoard = async ({ width = 1440, height = 900, theme = "light" } = {}) => {
    await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
    await b.open(`${base}/`, { width, height });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item') || !!document.querySelector('.entra-login')", 15000), "app shown");
    assert.equal(await b.evaluate("!!document.querySelector('.entra-login')"), false, "signed in");
    await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await b.evaluate("[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes('Ledger'))?.click()");
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table tbody tr td.cell')", 15000), "board table loaded");
    await sleep(300);
  };
  const chooseType = async (key, type) => {
    assert.ok(await click(`th [data-action="column-menu"][data-key="${key}"]`), "column menu button");
    assert.ok(await b.waitFor(`!!document.querySelector('.column-menu-popover [data-action="change-column-type"]')`, 4000), "Change type item");
    await click('.column-menu-popover [data-action="change-column-type"]');
    assert.ok(await b.waitFor(`!!document.querySelector('[data-action="choose-new-type"][data-type="${type}"]')`, 4000), "type chooser");
    await click(`[data-action="choose-new-type"][data-type="${type}"]`);
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const r = await b.send("Page.captureScreenshot", { format: "png" });
    if (r.result?.data) fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64"));
  };
  const refusedPlan = { status: 200, body: { dryRun: true, from: "text", to: "number", total: 4812, populated: 4410, convertible: 4301, incompatible: 87, lossy: { leadingZero: 7, longNumber: 2 }, examples: ["1•••,50", "0•••7", "+6•••00"], reason: null } };

  before(async () => {
    let port; do { port = await freePort(); } while ([4527, 9361, 9362, 9339].includes(port));
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER);
    await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn();
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: FETCH_WRAPPER });
    const ws = (await api("POST", "/workspaces", { name: "Finance" })).body.workspace;
    board = (await api("POST", `/workspaces/${ws.id}/boards`, { name: "Ledger", columns: COLUMNS })).body.board;
    for (const values of [{ serial: "Row 1", amount: "0042", count: "12", site: "https://example.com/a", mail: "ana@example.com", qty: -5 }, { serial: "Row 2", amount: "1,250.50", count: "7", qty: 3 }, { serial: "Unsafe row" }, { serial: "=HYPERLINK(\"http://x.invalid\",\"y\")", qty: -0.25 }]) {
      const r = await api("POST", `/boards/${board.id}/records`, { values });
      assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 200));
    }
  });
  after(async () => { await b?.close(); server?.kill(); });

  test("refused by the dry run: the dialog shows the server's counts and masked examples, no convert button, nothing changed", async () => {
    await openBoard();
    await plan({ dry: refusedPlan, real: null, calls: [] });
    await chooseType("amount", "number");
    assert.ok(await b.waitFor("!!document.querySelector('.conversion-refused')", 6000), "refusal dialog");
    assert.equal(await text(".conversion-lead"), "This column can't be converted to Number because some existing values are incompatible or could lose information. Your data has not been changed.");
    assert.equal(await text(".conversion-scope"), "Checked all 4,812 records on this board · 4,410 have a value · 4,301 would convert", "the server's whole-board counts (the page holds 4 records)");
    assert.deepEqual(await b.evaluate("[...document.querySelectorAll('.conversion-reasons li')].map((li) => li.textContent)"), ["78 other values can't be stored as Number","7 values start with 0 and would lose their leading zero", "2 values have more than 15 digits and would lose precision"]);
    assert.deepEqual(await b.evaluate("[...document.querySelectorAll('.conversion-examples code')].map((c) => c.textContent)"), ["1•••,50", "0•••7", "+6•••00"]);
    assert.deepEqual(await b.evaluate("[...new Set([...document.querySelectorAll('#overlay-root [data-action]')].map((e) => e.dataset.action))]"), ["close-overlay"], "only Close");
    assert.ok(await b.waitFor("document.activeElement?.textContent === 'Close'", 2000), "focus on Close");
    const made = await calls();
    assert.equal(made.length, 1); assert.equal(made[0].dry, true); assert.equal(made[0].body.type, "number"); assert.ok(Number.isInteger(made[0].body.expectedVersion));
    assert.equal((await column("amount")).type, "text"); assert.equal((await record("Row 1")).values.amount, "0042");
    // Learn more opens in place (the dialog stays open); Escape / Close closes it.
    await click(".conversion-help summary");
    assert.equal(await b.evaluate("document.querySelector('.conversion-help').open && !!document.querySelector('.conversion-refused')"), true);
    await click('.conversion-refused .button.primary');
    assert.ok(await b.waitFor("!document.querySelector('.conversion-refused')", 3000), "closed");
  });

  test("screenshots of the refusal dialog: light and dark at 390 and 1440 px, no sideways scroll", async () => {
    const backgrounds = {};
    for (const [width, height] of [[390, 844], [1440, 900]]) {
      for (const theme of ["light", "dark"]) {
        await openBoard({ width, height, theme });
        await plan({ dry: refusedPlan, real: null, calls: [] });
        await chooseType("amount", "number");
        assert.ok(await b.waitFor("!!document.querySelector('.conversion-refused')", 6000), `${width} ${theme}: dialog`);
        await sleep(250);
        const box = await b.evaluate("(() => { const r = document.querySelector('.conversion-refused').getBoundingClientRect(); return { left: r.left, right: r.right, vw: document.documentElement.clientWidth, sideways: document.documentElement.scrollWidth - window.innerWidth }; })()");
        assert.ok(box.left >= -1 && box.right <= box.vw + 1, `${width} ${theme}: dialog on screen ${JSON.stringify(box)}`);
        assert.ok(box.sideways <= 0, `${width} ${theme}: no sideways scroll`);
        // The app draws its theme from the person's setting on every render: apply the one under test now.
        await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`); await sleep(200);
        const bg = await b.evaluate("getComputedStyle(document.querySelector('.conversion-refused')).backgroundColor");
        assert.ok(bg && bg !== "rgba(0, 0, 0, 0)", "the dialog has a background");
        backgrounds[theme] = bg;
        await shot(`refusal-${width}-${theme}`);
      }
      assert.notEqual(backgrounds.light, backgrounds.dark, `${width}: the dialog follows the theme`);
    }
  });

  test("refused by the conversion itself (board too large): its own wording; nothing changed", async () => {
    await openBoard();
    await plan({ dry: { status: 200, body: { dryRun: true, from: "text", to: "number", total: 4, populated: 2, convertible: 2, incompatible: 0, lossy: {} } }, real: { status: 409, body: { error: { code: "CONVERSION_REFUSED", message: "RAW SERVER TEXT", details: { reason: "board_too_large", total: 250000 } } } }, calls: [] });
    await chooseType("count", "number");
    assert.ok(await b.waitFor("!!document.querySelector('[data-action=\"confirm-change-type\"]')", 6000), "lossless confirm first");
    assert.match(await text("#overlay-root .confirm-modal p"), /^Checked all 4 records on this board\. All 2 values can be stored as Number, so nothing will be lost\./);
    await click('[data-action="confirm-change-type"]');
    assert.ok(await b.waitFor("!!document.querySelector('.conversion-refused')", 6000), "refusal dialog");
    assert.equal(await text(".conversion-lead"), "This board is too large to convert safely with the current converter. Your data has not been changed.");
    assert.equal(await b.evaluate("document.body.textContent.includes('RAW SERVER TEXT')"), false, "no raw server text");
    assert.deepEqual((await calls()).map((c) => c.dry), [true, false]);
    assert.equal((await column("count")).type, "text");
    assert.equal(await b.evaluate("document.querySelector('th[data-column-key=\"count\"]') ? getComputedStyle(document.querySelector('th[data-column-key=\"count\"]')).display !== 'none' : true"), true);
    assert.equal(await b.evaluate("!document.querySelector('.save-state')?.classList.contains('save-error')"), true, "no failed-save state left behind");
    await shot("too-large-1440-light");
    await click('.conversion-refused .button.primary');
  });

  test("lossless: the dry run is used, then the real server converts; the values are kept", async () => {
    await openBoard();
    await plan({ dry: null, real: null, calls: [] });
    await chooseType("count", "number");
    // A server with the full dry-run contract asks to confirm with its counts; an older one (no loss) converts at once.
    await b.waitFor("!!document.querySelector('[data-action=\"confirm-change-type\"]') || !document.querySelector('#overlay-root .modal, #overlay-root .chooser-option')", 6000);
    if (await b.evaluate("!!document.querySelector('[data-action=\"confirm-change-type\"]')")) {
      assert.match(await text("#overlay-root .confirm-modal p"), /^Checked all \d+ records? on this board\./);
      await click('[data-action="confirm-change-type"]');
    }
    assert.ok(await b.waitFor("[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Count is now Number'))", 8000), "converted");
    const made = await calls();
    assert.equal(made[0].dry, true, "the dry run came first"); assert.equal(made.filter((c) => !c.dry).length, 1);
    assert.equal((await column("count")).type, "number");
    assert.deepEqual([String((await record("Row 1")).values.count), String((await record("Row 2")).values.count)], ["12", "7"]);
  });

  test("links: a stored unsafe link is text with a non-clickable flag; a safe one has the link button", async () => {
    await openBoard();
    const unsafe = await b.evaluate(`(() => { const td = document.querySelector(${JSON.stringify(cellSel("Unsafe row", "site"))}); return td && { links: td.querySelectorAll("a").length, flag: td.querySelector(".cell-link-unsafe")?.textContent, text: td.querySelector(".cell-display")?.textContent }; })()`);
    assert.deepEqual(unsafe, { links: 0, flag: "Unsafe link", text: "javascript:alert(document.domain)" });
    const safe = await b.evaluate(`(() => { const a = document.querySelector(${JSON.stringify(cellSel("Row 1", "site"))} + " a.cell-link"); return a && { href: a.getAttribute("href"), rel: a.getAttribute("rel"), target: a.getAttribute("target") }; })()`);
    assert.deepEqual(safe, { href: "https://example.com/a", rel: "noopener noreferrer", target: "_blank" });
    assert.match(await b.evaluate(`document.querySelector(${JSON.stringify(cellSel("Row 1", "mail"))} + " a.cell-link")?.getAttribute("href")`), /^mailto:ana@example\.com$/);
  });

  test("validation: an unsafe link is refused with a link message; a server VALIDATION_ERROR on an email names the type", async () => {
    await openBoard();
    const edit = async (serial, key, value) => {
      await click(`${cellSel(serial, key)} .cell-display`);
      assert.ok(await b.waitFor(`!!document.querySelector(${JSON.stringify(cellSel(serial, key) + " .cell-input")})`, 3000), "cell editor");
      await b.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(cellSel(serial, key) + " .cell-input")}); i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
    };
    await edit("Row 2", "site", "javascript:alert(1)");
    assert.ok(await b.waitFor("[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Website not saved: Links must start with http://, https://, mailto: or tel: (for example https://example.com).'))", 4000), "link message");
    assert.equal((await record("Row 2")).values.site ?? "", "", "nothing saved");
    await plan({ patch: { status: 400, body: { error: { code: "VALIDATION_ERROR", message: "RAW", details: { field: "mail", reason: "invalid-email" } } } } });
    await edit("Row 2", "mail", "ben@example.com");
    assert.ok(await b.waitFor("[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Email not saved: Enter a valid email address.'))", 6000), "email message");
    await plan({ patch: null });
    assert.equal((await record("Row 2")).values.mail ?? "", "");
  });

  test("CSV export: formula-like cells get an apostrophe; negative numbers in a Number column stay numbers", async () => {
    await openBoard();
    await b.evaluate("(() => { const o = URL.createObjectURL; URL.createObjectURL = (blob) => { blob.text().then((t) => { window.__csv = t; }); return o.call(URL, blob); }; })()");
    await b.evaluate("document.querySelector('[data-action=export]').click()");
    assert.ok(await b.waitFor("window.__csv !== undefined", 8000), "exported");
    const csv = await b.evaluate("window.__csv");
    assert.ok(csv.includes(`"'=HYPERLINK(""http://x.invalid"",""y"")"`), "the formula is apostrophed in the file");
    assert.ok(csv.includes('"-5"') && csv.includes('"-0.25"'), "negative numbers kept");
    assert.ok(!csv.includes(`"'-5"`));
    assert.equal((await records()).find((r) => r.values.serial.startsWith("=HYPERLINK")).values.serial, "=HYPERLINK(\"http://x.invalid\",\"y\")", "the stored value is unchanged");
  });
});
