// Fabric Data Phase 7 (advanced filters) in the REAL app, in a headless Chrome/Edge: the Objects panel, the Filters builder, the
// value picker, column and cell menus, saved filters, sorting, requests, and the responsive / accessibility rules at 320–1920 px
// in light and dark. createApp with Fabric on (Microsoft Entra test keys, JARC on its fake MongoDB) over the real src/fabric
// backend and tests/support/fabric-fake.js. Synthetic data only; nothing leaves 127.0.0.1. Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createApp } = require("../src/app");
const { createFabricData, fabricLimiter } = require("../src/fabric");
const { loadConfig } = require("../src/config");
const { MemoryStateRepository } = require("../src/repositories/memory-state-repository");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { createEntraVerifier } = require("../src/auth/entra-token");
const { entraEnv } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FakeMongoClient } = require("./support/fake-mongo");
const { FabricFakeClient, row, inventoryRows, DEFAULT_INDEXES } = require("./support/fabric-fake");
const { findBrowser, launch, freePort } = require("./support/headless-browser");

const BROWSER = findBrowser();
const DESKTOP = { width: 1440, height: 900 };
const WIDTHS = [[320, 640], [360, 740], [390, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]];
const LIST = ".fabric-explorer-table tbody tr";

function salesRows() {
  const out = [];
  for (let i = 0; i < 400; i += 1) {
    const d = new Date(Date.UTC(2026, 2, 31) - (i % 90) * 86400000);
    out.push(row({ Company: i % 3 ? "Synthetic Co A" : "Synthetic Co B", invoice_id: `SYN-${String(5000 + Math.floor(i / 2)).padStart(5, "0")}`, Line_No: (1 + (i % 2)) * 10000, invoice_date: d, customer_name: `Example Customer ${i % 7}`, invoice_item_name: `Synthetic product ${i % 11}`, invoice_item_quantity: 1 + (i % 5), invoice_item_amount: 10 * (1 + (i % 5)), sales_data_source: "Source One", landed_cost: "1.25" }));
  }
  return out;
}

// Page probe: console errors, every /api/ request (window.__all) and every /api/v1/fabric answer (window.__calls). Two test-only
// switches: window.__delay = { match, ms } holds the next matching answer back (a slow, stale answer); window.__fakeValues =
// { field, pages: [...] } answers /values for that field with synthetic pages (a long, limited list) without asking the server.
const PROBE = `(() => {
  window.__errors = []; window.__calls = []; window.__all = [];
  const oe = console.error.bind(console);
  console.error = (...a) => { window.__errors.push(a.map((x) => (x && x.stack) || String(x)).join(" ")); oe(...a); };
  addEventListener("error", (e) => window.__errors.push("uncaught: " + (e.message || e.type)));
  addEventListener("unhandledrejection", (e) => window.__errors.push("rejection: " + ((e.reason && e.reason.message) || e.reason)));
  const ox = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function (m, u) { window.__all.push(String(u).replace(/^https?:\\/\\/[^/]+/, "")); return ox.apply(this, arguments); };
  const of = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url, rel = url.replace(/^https?:\\/\\/[^/]+/, "");
    if (url.includes("/api/")) window.__all.push(rel);
    const entry = { url: rel, method: String((init && init.method) || "GET").toUpperCase(), at: Date.now() };
    const fv = window.__fakeValues;
    if (fv && rel.includes("/values?") && rel.includes("field=" + fv.field)) {
      const after = new URLSearchParams(rel.split("?")[1]).get("after");
      const page = after ? fv.pages[1] : fv.pages[0];
      if (rel.includes("/api/v1/fabric")) window.__calls.push({ ...entry, status: 200, fake: true });
      return new Response(JSON.stringify(page), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const d = window.__delay;
    let res;
    if (d && rel.includes(d.match)) { window.__delay = null; res = await of(input, init); await new Promise((r) => setTimeout(r, d.ms)); entry.delayed = true; }
    else res = await of(input, init);
    if (rel.includes("/api/v1/fabric")) { entry.status = res.status; entry.doneAt = Date.now(); window.__calls.push(entry); }
    return res;
  };
})();`;

describe("Fabric Data Phase 7 in the real app (headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let issuer, people, server, base, b, stack, app, dataLayer;

  before(async () => {
    issuer = await createTokenIssuer();
    people = { admin: issuer.person("Ada FabricAdmin"), reader: issuer.person("Rhea Reader") };
    const port = await freePort();
    base = `http://localhost:${port}`;
    const entra = { ...issuer.config, redirectUri: `${base}/`, appOrigin: base };
    const env = entraEnv({
      JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb", FABRIC_UNINDEXED_SCAN_MAX: "300",
      FABRIC_DATA_READER_OIDS: [people.admin.oid, people.reader.oid].join(","), FABRIC_API_ADMIN_OIDS: people.admin.oid
    });
    const config = loadConfig(env).fabricData;
    const fabricClient = new FabricFakeClient({ docs: salesRows(), indexes: DEFAULT_INDEXES.map((i) => ({ ...i })), inventory: { docs: inventoryRows(250) } });
    stack = createFabricData({ config, logger: { warn() {}, error() {} }, createClient: () => fabricClient });
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => new FakeMongoClient() });
    await connection.connect();
    await ensureDatabase(connection.db);
    dataLayer = createDataLayer({ connection, logger: { error() {} }, fileStore: new MemoryFileStore(), environment: "test" });
    app = createApp({
      repository: new MemoryStateRepository(), environment: "test", logger: { error() {}, warn() {} }, dataLayer,
      auth: { mode: "entra", entra, verify: createEntraVerifier({ ...entra, keySet: issuer.keySet }) },
      accessPolicy: "development_shared", betaOpenEditing: true,
      apiTokens: { key: crypto.randomBytes(32), adminObjectIds: [], issuePerHour: 1000, maxActive: 1000 },
      fabricData: { config, service: stack.service, values: stack.values, limiter: fabricLimiter({ perWindow: 100000 }) }
    });
    server = await new Promise((resolve) => { const s = app.listen(port, "127.0.0.1", () => resolve(s)); });
    b = await launch(BROWSER);
    await b.motionPreference("reduce");
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
  });
  after(async () => { await b?.close(); app?.locals.realtime?.closeAll(); await new Promise((r) => (server ? server.close(r) : r())); await stack?.close(); });

  const wait = (expr, ms = 10000) => b.waitFor(expr, ms);
  const has = (sel) => b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  const text = (sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent || ""`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const json = async (expr) => JSON.parse(await b.evaluate(`JSON.stringify(${expr})`));
  const setValue = (sel, value, event = "change") => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); return true; })()`);
  const calls = () => json("window.__calls || []");
  const records = async (ds) => (await calls()).filter((c) => c.url.startsWith(`/api/v1/fabric/${ds}/records?`));
  const lastRecords = async (ds) => (await records(ds)).at(-1);
  const filterOf = (url) => { const f = new URLSearchParams(url.split("?")[1]).get("filter"); return f ? JSON.parse(Buffer.from(f, "base64url").toString("utf8")) : null; };
  const noErrors = async (label) => assert.deepEqual(await json("window.__errors || []"), [], `${label}: console errors`);
  const focused = () => json(`(() => { const a = document.activeElement; return a ? { id: a.id, action: a.dataset.action || "", key: a.dataset.focusKey || "", field: a.dataset.field || "", inObjects: !!a.closest("#fabric-objects") } : null; })()`);
  // An element's box against the viewport (inside: fully on screen, with a 1 px tolerance).
  const box = (sel) => json(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = innerHeight; return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height), inside: r.width > 0 && r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= vh + 1, insideX: r.width > 0 && r.left >= -1 && r.right <= vw + 1 }; })()`);
  const sideways = () => b.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  let current = null;
  const signIn = async (person) => {
    if (current === person) return;
    await b.open(`${base}/api/v1/health`, DESKTOP);
    const nonce = await b.evaluate(`fetch("/api/v1/auth/sign-in/start", { method: "POST" }).then((r) => r.json()).then((s) => s.nonce)`);
    const idToken = await person.idToken(nonce);
    assert.equal(await b.evaluate(`fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: ${JSON.stringify(idToken)} }) }).then((r) => r.status)`), 201, `sign-in ${person.name}`);
    current = person;
  };
  const openList = async (path = "/fabric/inventory", size = DESKTOP) => {
    await b.open(`${base}${path}`, size);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 20000), "app loaded");
    assert.ok(await wait(`document.querySelectorAll(${JSON.stringify(LIST)}).length > 0`, 15000), `rows for ${path}`);
  };
  const FILTERS = (ds = "inventory") => `[data-action="fabric-x-filters"][data-ds="${ds}"][data-focus-key="filters"]`;
  const openBuilder = async (ds = "inventory") => { await click(FILTERS(ds)); assert.ok(await wait(`!!document.querySelector("#fabric-${ds}-fb")`), "builder opens"); };
  // Adds a condition at a group path ("" = the top level) and chooses its field; returns the new condition's path.
  const addCondition = async (field, group = "", ds = "inventory") => {
    const n = await b.evaluate(`document.querySelectorAll('#fabric-${ds}-fb .fx-fb__cond').length`);
    await click(`[data-action="fabric-f-add"][data-ds="${ds}"][data-path="${group}"]`);
    assert.ok(await wait(`!!document.querySelector('[data-action="fabric-f-field"][data-field="${field}"]')`), `field list offers ${field}`);
    await click(`[data-action="fabric-f-field"][data-field="${field}"]`);
    assert.ok(await wait(`document.querySelectorAll('#fabric-${ds}-fb .fx-fb__cond').length === ${n + 1} && !document.querySelector("#fabric-${ds}-fb-picker")`), `${field} chosen`);
    return b.evaluate(`[...document.querySelectorAll('#fabric-${ds}-fb .fx-fb__cond')].map((li) => li.dataset.path).filter((p) => ${JSON.stringify(group)} === "" ? !p.includes(".") : p.startsWith(${JSON.stringify(group + ".")})).at(-1)`);
  };
  const apply = async (ds = "inventory") => {
    const n = (await records(ds)).length;
    await click(`[data-action="fabric-f-apply"][data-ds="${ds}"]`);
    assert.ok(await wait(`!document.querySelector("#fabric-${ds}-fb") && (window.__calls || []).filter((c) => c.url.startsWith("/api/v1/fabric/${ds}/records?")).length > ${n}`), "Apply closes the builder and asks again");
    assert.ok(await wait(`document.querySelectorAll(${JSON.stringify(LIST)}).length > 0 || !!document.querySelector(".fabric-empty")`));
  };
  const chips = () => json(`[...document.querySelectorAll(".fx-chip--filter")].map((c) => ({ text: c.querySelector(".fx-chip__text")?.textContent.trim(), remove: !!c.querySelector('[data-action="fabric-x-chip"]') }))`);

  test("1. every width (320–1920) in light and dark: no sideways page scroll, pager reachable, Objects drawer or rail, builder and menus inside the viewport, focus returns", async () => {
    await signIn(people.admin);
    const results = [];
    for (const [width, height] of WIDTHS) {
      for (const theme of ["light", "dark"]) {
        const label = `${width}px ${theme}`;
        await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
        await openList("/fabric/inventory", { width, height });
        await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
        const r = { width, theme };
        r.sideways = await sideways();
        assert.equal(r.sideways, 0, `${label}: the page scrolls sideways`);
        if (width > 620) assert.ok(await b.evaluate(`(() => { const g = document.querySelector('[data-grid="inventory"]'); return !!g && g.scrollWidth >= g.clientWidth; })()`), `${label}: the grid frame`);
        // Previous/Next: on screen horizontally at every width; on phones (cards) at the end of the list, reachable by scrolling.
        await b.evaluate(`document.querySelector('[data-action="fabric-x-page"][data-dir="next"]').scrollIntoView({ block: "nearest" })`);
        const prev = await box('[data-action="fabric-x-page"][data-dir="prev"]'), next = await box('[data-action="fabric-x-page"][data-dir="next"]');
        assert.ok(prev?.inside && next?.inside, `${label}: Previous/Next on screen ${JSON.stringify({ prev, next })}`);
        // Touch-sized on phones and tablets; the compact desktop density elsewhere (unchanged from efbfdf4).
        const minH = width <= 1024 ? 32 : 20;
        assert.ok(prev.height >= minH && next.height >= minH, `${label}: Previous/Next at least ${minH}px (${prev.height}/${next.height})`);
        assert.equal(await sideways(), 0, `${label}: still no sideways scroll`);
        await b.evaluate("window.scrollTo(0, 0); document.querySelector('.fx-app__body')?.scrollTo?.(0, 0)");
        // Dark/light surfaces differ (the dark theme really applies).
        r.bodyBg = await b.evaluate(`getComputedStyle(document.querySelector(".fx-app") || document.body).backgroundColor`);

        // Objects panel.
        assert.ok((await box("#fabric-objects-toggle"))?.inside, `${label}: Objects button on screen`);
        assert.ok(await has("#fabric-obj-api"), `${label}: API Management listed for the API administrator`);
        const narrow = await b.evaluate("matchMedia('(max-width: 1024px)').matches");
        r.objects = narrow ? "drawer" : "panel";
        if (narrow) {
          assert.equal((await box("#fabric-objects"))?.insideX && (await b.evaluate(`document.querySelector("#fabric-objects").classList.contains("is-drawer-open")`)), false, `${label}: drawer closed at first`);
          await click("#fabric-objects-toggle");
          assert.ok(await wait(`document.querySelector("#fabric-objects")?.getAttribute("role") === "dialog" && document.querySelector("#fabric-objects")?.getAttribute("aria-modal") === "true"`), `${label}: a modal drawer`);
          assert.ok((await box("#fabric-objects"))?.inside, `${label}: drawer on screen`);
          assert.equal(await b.evaluate(`document.querySelector("#fabric-objects-toggle").getAttribute("aria-expanded")`), "true");
          assert.ok((await focused())?.inObjects, `${label}: focus moves into the drawer`);
          for (let i = 0; i < 12; i += 1) { await b.key("Tab"); assert.ok((await focused())?.inObjects, `${label}: Tab stays in the drawer (${i})`); }
          await b.key("Escape");
          assert.ok(await wait(`!document.querySelector("#fabric-objects").classList.contains("is-drawer-open") && document.activeElement?.id === "fabric-objects-toggle"`), `${label}: Escape closes the drawer, focus back on Objects`);
          // A choice closes the drawer too.
          await click("#fabric-objects-toggle");
          assert.ok(await wait(`document.querySelector("#fabric-objects").classList.contains("is-drawer-open")`));
          await click("#fabric-obj-sales");
          assert.ok(await wait(`location.pathname === "/fabric/sales" && !document.querySelector("#fabric-objects").classList.contains("is-drawer-open")`), `${label}: choosing Sales closes the drawer`);
          assert.ok(await wait(`document.querySelectorAll(${JSON.stringify(LIST)}).length > 0 && /Sales/.test(document.querySelector("#fabric-section-title")?.textContent || "")`), `${label}: Sales shown`);
          await click("#fabric-objects-toggle"); await wait(`document.querySelector("#fabric-objects").classList.contains("is-drawer-open")`);
          await click("#fabric-obj-inventory");
          assert.ok(await wait(`location.pathname === "/fabric/inventory" && document.querySelectorAll(${JSON.stringify(LIST)}).length > 0`), `${label}: back to Inventory`);
        } else {
          const full = await box("#fabric-objects");
          await click('[data-action="fabric-o-collapse"]');
          assert.ok(await wait(`document.querySelector("#fabric-objects").classList.contains("is-collapsed")`), `${label}: collapses`);
          const rail = await box("#fabric-objects");
          assert.ok(rail.width <= 40 && full.width > 150, `${label}: a narrow rail (${full.width} → ${rail.width})`);
          await click("#fabric-objects-toggle");
          assert.ok(await wait(`!document.querySelector("#fabric-objects").classList.contains("is-collapsed")`), `${label}: reopens`);
          assert.ok((await focused())?.inObjects, `${label}: focus on the tree after reopening`);
          await b.key("ArrowDown");
          const f = await focused();
          assert.ok(f?.inObjects && f.id.startsWith("fabric-obj-"), `${label}: ↓ moves within the tree`);
          assert.notEqual(await b.evaluate(`getComputedStyle(document.activeElement).outlineStyle`), "none", `${label}: visible focus in the tree`);
          await click("#fabric-obj-sales");
          assert.ok(await wait(`location.pathname === "/fabric/sales" && document.querySelectorAll(${JSON.stringify(LIST)}).length > 0`), `${label}: Sales`);
          await click("#fabric-obj-inventory");
          assert.ok(await wait(`location.pathname === "/fabric/inventory" && document.querySelectorAll(${JSON.stringify(LIST)}).length > 0`), `${label}: Inventory`);
        }

        // The Filters builder, with a nested group: inside the viewport, Apply/Cancel reachable, 16px inputs on phones.
        await openBuilder();
        await addCondition("Entry_Type");
        await click('[data-action="fabric-f-add-group"]');
        assert.ok(await wait(`!!document.querySelector(".fx-fb__group--d2")`), `${label}: nested group`);
        await b.key("Escape"); // closes the group's field list first
        const fb = await box("#fabric-inventory-fb");
        assert.ok(fb?.inside, `${label}: builder inside the viewport ${JSON.stringify(fb)}`);
        if (width <= 620) assert.ok(fb.width >= width - 1, `${label}: full-width drawer`); else assert.ok(fb.width <= 722, `${label}: compact popover`);
        assert.ok((await box('[data-action="fabric-f-apply"][data-ds="inventory"]'))?.inside && (await box('[data-action="fabric-f-cancel"][data-focus-key="fb-cancel"]'))?.inside, `${label}: Apply and Cancel on screen`);
        // Nothing (the JARC top bar) covers the builder's title and × close.
        // Regression (popover placement): a popover (not the phone drawer) keeps an 8 px margin to the viewport's edges.
        if (width > 620) { const vw = await b.evaluate("document.documentElement.clientWidth"); assert.ok(fb.left >= 7 && fb.right <= vw - 7, `${label}: builder 8 px inside the viewport ${JSON.stringify({ ...fb, vw })}`); }
        const topmost = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && (hit === el || el.contains(hit)); })()`);
        assert.ok(await topmost("#fabric-inventory-fb .fx-fb__close"), `${label}: the builder's × is not covered`);
        assert.ok(await topmost("#fabric-inventory-fb-title"), `${label}: the builder's title is not covered`);
        assert.equal(await sideways(), 0, `${label}: builder causes no sideways scroll`);
        if (width < 768) {
          const sizes = await json(`[...document.querySelectorAll("#fabric-inventory-fb input, #fabric-inventory-fb select, #fabric-inventory-q")].map((el) => getComputedStyle(el).fontSize)`);
          assert.ok(sizes.length && sizes.every((s) => s === "16px"), `${label}: 16px touch inputs ${JSON.stringify(sizes)}`);
        }
        await b.key("Escape");
        assert.ok(await wait(`!document.querySelector("#fabric-inventory-fb") && document.activeElement?.matches(${JSON.stringify(FILTERS())})`), `${label}: Escape closes the builder, focus back on Filters`);
        assert.equal(await lastRecords("inventory").then((c) => filterOf(c.url)), null, `${label}: Cancel/Escape applies nothing`);

        // Column header menu with its value list.
        await b.evaluate(`document.querySelector('.fx-colmenu__btn[data-field="Entry_Type"]').scrollIntoView({ block: "nearest", inline: "center" })`);
        await click('.fx-colmenu__btn[data-field="Entry_Type"]');
        assert.ok(await wait(`document.querySelectorAll('.fx-menu [role="option"]').length > 1`), `${label}: column menu with values`);
        const menu = await box(".fx-menu");
        assert.ok(menu?.inside, `${label}: column menu inside the viewport ${JSON.stringify(menu)}`);
        assert.equal(await b.evaluate(`document.querySelector('.fx-colmenu__btn[data-field="Entry_Type"]').getAttribute("aria-expanded")`), "true");
        const search = await json(`(() => { const s = getComputedStyle(document.querySelector(".fx-menu .fx-vpick__input")); return { border: s.borderTopStyle, height: parseFloat(s.height), font: s.fontSize }; })()`);
        assert.ok(search.border !== "none" && search.height >= 24, `${label}: the value search box is drawn as a box ${JSON.stringify(search)}`);
        if (width < 768) assert.equal(search.font, "16px", `${label}: 16px value search on touch`);
        assert.equal(await sideways(), 0, `${label}: menu causes no sideways scroll`);
        await b.key("Escape");
        // On phones (≤620) the header row is hidden (D5: its buttons can't take focus; people there use the builder), so the
        // menu, opened here by script, closes without a visible button to return to.
        if (width <= 620) assert.ok(await wait(`!document.querySelector(".fx-menu") && getComputedStyle(document.querySelector('.fx-colmenu__btn[data-field="Entry_Type"]')).visibility === "hidden"`), `${label}: Escape closes the menu; the phone header stays out of the Tab order`);
        else assert.ok(await wait(`!document.querySelector(".fx-menu") && document.activeElement?.matches('.fx-colmenu__btn[data-field="Entry_Type"]')`), `${label}: Escape closes the menu, focus back on its button`);
        r.menu = `${menu.left}-${menu.right}×${menu.top}-${menu.bottom}`; r.builder = `${fb.width}px`;
        await noErrors(label);
        results.push(r);
      }
    }
    // Dark surfaces differ from light ones at the same width.
    for (const [width] of WIDTHS) { const [l, d] = results.filter((x) => x.width === width); assert.notEqual(l.bodyBg, d.bodyBg, `${width}px: dark theme applies`); }
    await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  });

  test("2. builder: add, duplicate, remove, nested OR group, type-specific inputs, Apply sends one filter=, chips with ×, badge, Cancel discards", async () => {
    await signIn(people.admin);
    await openList();
    await openBuilder();
    assert.equal(await b.evaluate(`document.querySelector("#fabric-inventory-fb").getAttribute("role")`), "dialog");
    assert.ok(await b.evaluate(`!!document.getElementById(document.querySelector("#fabric-inventory-fb").getAttribute("aria-labelledby"))`), "labelled dialog");
    // Type-specific inputs.
    const p0 = await addCondition("Entry_Type");
    assert.ok(await has(`[data-action="fabric-f-values"][data-path="${p0}"]`), "a list field picks values");
    const pDate = await addCondition("Posting_Date");
    assert.equal(await b.evaluate(`document.querySelector('[data-action="fabric-f-value"][data-path="${pDate}"]')?.type`), "date", "a date field has a date input");
    const pNum = await addCondition("Quantity");
    assert.equal(await b.evaluate(`document.querySelector('[data-action="fabric-f-value"][data-path="${pNum}"]')?.getAttribute("inputmode")`), "decimal", "a number field takes decimal text");
    const opsNum = await json(`[...document.querySelector('[data-action="fabric-f-op"][data-path="${pNum}"]').options].map((o) => o.value)`);
    assert.ok(opsNum.includes("gt") && opsNum.includes("between") && !opsNum.includes("contains"), `number operators ${opsNum}`);
    await setValue(`[data-action="fabric-f-op"][data-path="${pNum}"]`, "between");
    assert.ok(await wait(`document.querySelectorAll('[data-action="fabric-f-value"][data-path="${pNum}"]').length === 2`), "between has two inputs");
    await setValue(`[data-action="fabric-f-op"][data-path="${pDate}"]`, "lastN");
    assert.ok(await wait(`!!document.querySelector('[data-action="fabric-f-unit"][data-path="${pDate}"]')`), "last N has a unit");
    await setValue(`[data-action="fabric-f-op"][data-path="${pDate}"]`, "blank");
    assert.ok(await wait(`!document.querySelector('[data-action="fabric-f-value"][data-path="${pDate}"]')`), "is blank has no value");
    // Remove two, duplicate one.
    await click(`[data-action="fabric-f-remove"][data-path="${pNum}"]`);
    await click(`[data-action="fabric-f-remove"][data-path="${pDate}"]`);
    assert.ok(await wait(`document.querySelectorAll("#fabric-inventory-fb .fx-fb__cond").length === 1`), "removed");
    await click(`[data-action="fabric-f-values"][data-path="${p0}"]`);
    assert.ok(await wait(`[...document.querySelectorAll('#fabric-inventory-fb-vp [role="option"]')].some((o) => /^Sale/.test(o.textContent))`), "values listed");
    // One click at a time (each click redraws the list, so the options are looked up again).
    for (const v of ["Sale", "Purchase"]) await b.evaluate(`[...document.querySelectorAll('#fabric-inventory-fb-vp [role="option"]')].find((o) => o.textContent.startsWith(${JSON.stringify(v)})).click()`);
    assert.equal(await b.evaluate(`document.querySelectorAll('#fabric-inventory-fb-vp [role="option"][aria-selected="true"]').length`), 2, "two values selected");
    await click('#fabric-inventory-fb-vp [data-fvp="apply"]');
    assert.ok(await wait(`/Sale/.test(document.querySelector("#fabric-inventory-fb .fx-fb__tags")?.textContent || "")`));
    await click(`[data-action="fabric-f-dup"][data-path="${p0}"]`);
    assert.ok(await wait(`document.querySelectorAll("#fabric-inventory-fb .fx-fb__cond").length === 2`), "duplicated");
    await click(`[data-action="fabric-f-remove"][data-path="1"]`);
    assert.ok(await wait(`document.querySelectorAll("#fabric-inventory-fb .fx-fb__cond").length === 1`));
    // A nested OR group: Item no. starts with ITEM-SYN-01 OR Location code is blank.
    await click('[data-action="fabric-f-add-group"]');
    assert.ok(await wait(`!!document.querySelector(".fx-fb__group--d2") && !!document.querySelector("#fabric-inventory-fb-picker")`), "group with its field list open");
    await click('[data-action="fabric-f-field"][data-path="1.0"][data-field="Item_No"]');
    assert.ok(await wait(`!!document.querySelector('[data-action="fabric-f-op"][data-path="1.0"]')`));
    const textOps = await json(`[...document.querySelector('[data-action="fabric-f-op"][data-path="1.0"]').options].map((o) => o.value)`);
    const textOp = textOps.includes("startsWith") ? "startsWith" : "contains";
    await setValue('[data-action="fabric-f-op"][data-path="1.0"]', textOp);
    assert.ok(await wait(`!!document.querySelector('[data-action="fabric-f-value"][data-path="1.0"]')`));
    await setValue('[data-action="fabric-f-value"][data-path="1.0"]', "ITEM-SYN-01", "input");
    await addCondition("Location_Code", "1");
    await setValue('[data-action="fabric-f-op"][data-path="1.1"]', "blank");
    await setValue('[data-action="fabric-f-join"][data-path="1"]', "or");
    assert.ok(await wait(`document.querySelector('[data-action="fabric-f-join"][data-path="1"]').value === "or"`));
    assert.match(await text("#fabric-inventory-fb .fx-fb__state"), /Not applied yet/);
    await apply();
    const model = filterOf((await lastRecords("inventory")).url);
    assert.deepEqual([...model.items[0].values].sort(), ["Purchase", "Sale"]);
    assert.deepEqual(model, { v: 1, op: "and", items: [{ field: "Entry_Type", op: "in", values: model.items[0].values }, { op: "or", items: [{ field: "Item_No", op: textOp, value: "ITEM-SYN-01" }, { field: "Location_Code", op: "blank" }] }] });
    assert.equal((await lastRecords("inventory")).status, 200, "the server accepts the filter");
    // Chips: one per condition, each with ×; the badge counts conditions.
    let c = await chips();
    assert.equal(c.length, 3, JSON.stringify(c));
    assert.ok(c.every((x) => x.remove), "every chip has ×");
    assert.match(await text(`${FILTERS()} .fx-badge`), /3/);
    assert.ok(await b.evaluate(`[...document.querySelectorAll(".fx-chip__remove")].every((x) => /^Remove filter /.test(x.getAttribute("aria-label") || ""))`), "× buttons are labelled");
    assert.ok(await b.evaluate(`!!document.querySelector('.fabric-explorer-table thead th.is-filtered') || !!document.querySelector('.fx-colmenu__btn.is-filtered')`), "a filtered column is marked");
    // × on the Location chip: the nested group keeps Item no. only.
    const n = (await records("inventory")).length;
    await b.evaluate(`[...document.querySelectorAll(".fx-chip--filter")].find((x) => /Location/.test(x.textContent)).querySelector('[data-action="fabric-x-chip"]').click()`);
    assert.ok(await wait(`(window.__calls || []).filter((c) => c.url.startsWith("/api/v1/fabric/inventory/records?")).length > ${n}`), "× asks again");
    c = await chips();
    assert.equal(c.length, 2);
    assert.ok(!JSON.stringify(filterOf((await lastRecords("inventory")).url)).includes("Location_Code"));
    // Cancel discards the draft: nothing is sent.
    await openBuilder();
    await addCondition("Document_No");
    const sent = (await records("inventory")).length;
    await click('[data-action="fabric-f-cancel"][data-focus-key="fb-cancel"]');
    assert.ok(await wait(`!document.querySelector("#fabric-inventory-fb")`));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await records("inventory")).length, sent, "Cancel sends nothing");
    assert.equal((await chips()).length, 2, "the applied filter is unchanged");
    assert.equal(await b.evaluate("document.activeElement?.dataset.action"), "fabric-x-filters", "focus back on Filters");
    // Problems are shown on the condition and Apply refuses.
    await openBuilder();
    const bad = await addCondition("Quantity");
    await setValue(`[data-action="fabric-f-op"][data-path="${bad}"]`, "gt");
    await click('[data-action="fabric-f-apply"][data-ds="inventory"]');
    assert.ok(await wait(`!!document.querySelector('#fabric-inventory-fb [role="alert"]') && !!document.querySelector('#fabric-inventory-fb [aria-invalid="true"]')`), "an empty value is flagged");
    assert.ok(await b.evaluate(`!!document.activeElement?.closest("#fabric-inventory-fb")`), "focus stays in the builder");
    await click('[data-action="fabric-f-clear"]');
    await apply();
    assert.equal((await chips()).length, 0, "Clear all + Apply removes every condition");
    await noErrors("builder");
  });

  test("3. value picker: server values, search (debounced, q=), keyboard, Load more and the limited note", async () => {
    await signIn(people.admin);
    await openList();
    await click('.fx-colmenu__btn[data-field="Entry_Type"]');
    assert.ok(await wait(`document.querySelectorAll('.fx-menu [role="option"]').length > 1`));
    assert.equal(await b.evaluate(`document.querySelector('.fx-menu [role="listbox"]').getAttribute("aria-multiselectable")`), "true");
    const before = (await calls()).filter((c) => c.url.includes("/values?")).length;
    await setValue(".fx-menu .fx-vpick__input", "S", "input");
    await setValue(".fx-menu .fx-vpick__input", "Sa", "input");
    await setValue(".fx-menu .fx-vpick__input", "Sal", "input");
    assert.ok(await wait(`(window.__calls || []).some((c) => c.url.includes("/values?") && c.url.includes("q=Sal"))`), "search sent");
    await new Promise((r) => setTimeout(r, 400));
    const searches = (await calls()).filter((c) => c.url.includes("/values?")).slice(before);
    assert.equal(searches.length, 1, `debounced: one request for three keystrokes ${JSON.stringify(searches.map((s) => s.url))}`);
    assert.ok(await wait(`[...document.querySelectorAll('.fx-menu [role="option"]')].some((o) => /^Sale/.test(o.textContent))`));
    // Keyboard: ↓ into the list, Space selects, Enter applies.
    await b.evaluate(`document.querySelector(".fx-menu .fx-vpick__input").focus()`);
    await b.key("ArrowDown");
    assert.ok(await b.evaluate(`document.activeElement?.getAttribute("role") === "listbox" && !!document.activeElement.getAttribute("aria-activedescendant")`), "↓ moves into the listbox (aria-activedescendant)");
    const target = await b.evaluate(`document.getElementById(document.activeElement.getAttribute("aria-activedescendant")).textContent`);
    await b.key(" ");
    assert.ok(await wait(`document.getElementById(document.activeElement.getAttribute("aria-activedescendant"))?.getAttribute("aria-selected") === "true"`), "Space selects");
    const n = (await records("inventory")).length;
    await b.key("Enter");
    assert.ok(await wait(`!document.querySelector(".fx-menu") && (window.__calls || []).filter((c) => c.url.startsWith("/api/v1/fabric/inventory/records?")).length > ${n}`), "Enter applies");
    const model = filterOf((await lastRecords("inventory")).url);
    assert.equal(model.items.length, 1);
    assert.ok(JSON.stringify(model).includes("Entry_Type"), `${target}: ${JSON.stringify(model)}`);
    assert.equal((await chips()).length, 1);
    await click('[data-action="fabric-x-clear"][data-focus-key="clear-top"]');
    assert.ok(await wait(`!document.querySelector(".fx-chip--filter")`));

    // A long, limited list (synthetic answers in the page): Load more pages with after=, the note says it may be incomplete.
    const page = (from, n, next) => ({ dataset: "inventory", field: "Item_No", values: Array.from({ length: n }, (_, i) => ({ value: `ITEM-SYN-${String(from + i).padStart(4, "0")}` })), complete: false, limited: { reason: "rowCap", rowsScanned: 20000, rowCap: 20000 }, next, nextAfter: next });
    await b.evaluate(`window.__fakeValues = ${JSON.stringify({ field: "Item_No", pages: [page(1, 200, "ITEM-SYN-0200"), page(201, 50, null)] })}`);
    try {
      await click('.fx-colmenu__btn[data-field="Item_No"]');
      assert.ok(await wait(`document.querySelectorAll('.fx-menu [role="option"]').length >= 200`), "first page");
      assert.match(await text(".fx-menu .fx-vpick__status"), /incomplete/i, "limited note");
      assert.equal(await b.evaluate(`document.querySelector('.fx-menu [data-fvp="more"]').hidden`), false, "Load more shown");
      assert.ok((await box('.fx-menu')).inside, "menu inside the viewport with a long list");
      await click('.fx-menu [data-fvp="more"]');
      assert.ok(await wait(`document.querySelectorAll('.fx-menu [role="option"]').length >= 250`), "Load more appends the next page");
      assert.ok((await calls()).some((c) => c.fake && c.url.includes("field=Item_No") && c.url.includes("after=ITEM-SYN-0200")), "after= sent");
      assert.equal(await b.evaluate(`document.querySelector('.fx-menu [data-fvp="more"]').hidden`), true, "no more pages");
      await b.key("Escape");
      assert.ok(await wait(`!document.querySelector(".fx-menu")`));
    } finally { await b.evaluate("window.__fakeValues = null"); }
    await noErrors("value picker");
  });

  test("4. column menu sorting with priority markers, and the cell quick filter (right-click and Shift+F10)", async () => {
    await signIn(people.admin);
    await openList();
    // The default named sort: the primary key has the arrow and aria-sort; a later key shows its priority.
    const marks = await json(`[...document.querySelectorAll(".fabric-explorer-table thead th")].map((h) => ({ f: (h.getAttribute("title") || "").split(" ")[0], aria: h.getAttribute("aria-sort"), mark: h.querySelector(".fx-sort-mark")?.textContent || "", then: h.querySelector(".fx-sort-then")?.textContent || "" })).filter((x) => x.aria || x.mark || x.then)`);
    assert.equal(marks.filter((m) => m.aria).length, 1, `one primary sort ${JSON.stringify(marks)}`);
    // Sort ascending from the Item no. menu: orderBy= is sent, the header shows ▲ and aria-sort, no other header claims it.
    await click('.fx-colmenu__btn[data-field="Item_No"]');
    assert.ok(await wait(`!!document.querySelector('.fx-menu [data-fcm="sort-asc"]')`));
    assert.equal(await b.evaluate(`document.querySelector('.fx-menu [role="menu"]') !== null && document.querySelector('.fx-menu [data-fcm="sort-asc"]').getAttribute("role")`) !== null, true);
    await click('.fx-menu [data-fcm="sort-asc"]');
    assert.ok(await wait(`(window.__calls || []).some((c) => c.url.includes("/inventory/records?") && c.url.includes("orderBy=") && c.status === 200)`), "orderBy sent");
    assert.match(decodeURIComponent((await lastRecords("inventory")).url), /orderBy=Item_No/);
    const th = `[...document.querySelectorAll(".fabric-explorer-table thead th")].find((h) => (h.getAttribute("title") || "").split(" ")[0] === "Item_No")`;
    assert.ok(await wait(`${th}?.getAttribute("aria-sort") === "ascending" && ${th}.querySelector(".fx-sort-mark")?.textContent === "▲"`), "▲ and aria-sort on Item no.");
    assert.equal(await b.evaluate(`document.querySelectorAll(".fabric-explorer-table thead th[aria-sort]").length`), 1);
    const items = await json(`[...document.querySelectorAll(".fabric-explorer-table tbody tr")].map((tr) => tr.children[[...document.querySelectorAll(".fabric-explorer-table thead th")].findIndex((h) => (h.getAttribute("title") || "").split(" ")[0] === "Item_No")].textContent)`);
    assert.deepEqual(items, [...items].sort(), "rows ascending by Item no.");
    await click('.fx-colmenu__btn[data-field="Item_No"]');
    await wait(`!!document.querySelector('.fx-menu [data-fcm="sort-desc"]')`);
    await click('.fx-menu [data-fcm="sort-desc"]');
    assert.ok(await wait(`${th}?.getAttribute("aria-sort") === "descending"`), "descending");
    await click('.fx-colmenu__btn[data-field="Item_No"]');
    await wait(`!!document.querySelector('.fx-menu [data-fcm="sort-clear"]')`);
    await click('.fx-menu [data-fcm="sort-clear"]');
    assert.ok(await wait(`${th}?.getAttribute("aria-sort") === null`), "sort cleared");

    // Cell quick filter: right-click an Entry type cell → "Filter equals" → one condition with that value.
    const idx = await b.evaluate(`[...document.querySelectorAll(".fabric-explorer-table thead th")].findIndex((h) => (h.getAttribute("title") || "").split(" ")[0] === "Entry_Type")`);
    const value = await b.evaluate(`document.querySelector(".fabric-explorer-table tbody tr").children[${idx}].textContent`);
    await b.evaluate(`(() => { const td = document.querySelector(".fabric-explorer-table tbody tr").children[${idx}]; const r = td.getBoundingClientRect(); td.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 })); })()`);
    assert.ok(await wait(`!!document.querySelector('.fx-menu [data-fcm="f-eq"]')`), "cell menu");
    assert.ok((await box(".fx-menu")).inside, "cell menu inside the viewport");
    assert.equal(await has('.fx-menu [data-fcm*="edit"], .fx-menu [data-fcm*="delete"]'), false, "no editing actions");
    await click('.fx-menu [data-fcm="f-eq"]');
    assert.ok(await wait(`(window.__calls || []).some((c) => c.url.includes("/inventory/records?") && c.url.includes("filter="))`));
    assert.deepEqual(filterOf((await lastRecords("inventory")).url).items, [{ field: "Entry_Type", op: "eq", value }]);
    assert.ok(await wait(`[...document.querySelectorAll(${JSON.stringify(LIST)})].every((tr) => tr.children[${idx}].textContent === ${JSON.stringify(value)})`), "only that value");
    await click('[data-action="fabric-x-clear"][data-focus-key="clear-top"]');
    assert.ok(await wait(`!document.querySelector(".fx-chip--filter") && document.querySelectorAll(${JSON.stringify(LIST)}).length === 100`));
    // Keyboard: Shift+F10 on a focused cell opens the same menu; Escape returns focus to the grid.
    await b.evaluate(`(() => { const td = document.querySelector(".fabric-explorer-table tbody tr").children[${idx}]; td.tabIndex = -1; td.focus(); td.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })); })()`);
    assert.ok(await wait(`!!document.querySelector('.fx-menu [data-fcm="f-eq"]')`), "Shift+F10 opens the cell menu");
    assert.ok(await b.evaluate(`!!document.activeElement?.closest(".fx-menu")`), "focus in the menu");
    await b.key("Escape");
    assert.ok(await wait(`!document.querySelector(".fx-menu") && !!document.activeElement?.closest('[data-grid="inventory"]')`), "Escape returns to the grid");
    await noErrors("menus");
  });

  test("5. saved filters: save, list in Objects, All records, open, rename, delete; a broadened filter is held with a warning", async () => {
    await signIn(people.admin);
    await openList();
    // A filter to save: Entry type is one of Sale (from the cell menu, the quickest way).
    await openBuilder();
    const p = await addCondition("Entry_Type");
    await click(`[data-action="fabric-f-values"][data-path="${p}"]`);
    await wait(`[...document.querySelectorAll('#fabric-inventory-fb-vp [role="option"]')].some((o) => /^Sale/.test(o.textContent))`);
    await b.evaluate(`[...document.querySelectorAll('#fabric-inventory-fb-vp [role="option"]')].find((o) => /^Sale/.test(o.textContent)).click()`);
    await click('#fabric-inventory-fb-vp [data-fvp="apply"]');
    const q = await addCondition("Item_No");
    await setValue(`[data-action="fabric-f-value"][data-path="${q}"]`, "ITEM-SYN-0", "input");
    await apply();
    assert.equal((await chips()).length, 2);
    // Save filter… → a modal dialog in #overlay-root, focus in the name field.
    await click('[data-action="fabric-s-save"]');
    assert.ok(await wait(`!!document.querySelector('#overlay-root form[data-action="fabric-s-form"][data-mode="save"]')`), "save dialog");
    assert.equal(await b.evaluate(`document.querySelector('#overlay-root [role="dialog"]').getAttribute("aria-modal")`), "true");
    assert.equal(await b.evaluate(`document.activeElement?.name`), "name", "focus on Name");
    await setValue('#overlay-root input[name="name"]', "Synthetic sales items", "input");
    await b.evaluate(`document.querySelector('#overlay-root form[data-action="fabric-s-form"]').requestSubmit()`);
    assert.ok(await wait(`(window.__calls || []).some((c) => c.method === "POST" && c.url === "/api/v1/fabric/saved-filters/inventory" && c.status === 201)`), "saved");
    assert.ok(await wait(`!document.querySelector('#overlay-root form[data-action="fabric-s-form"]') && /Synthetic sales items/.test(document.querySelector(".fx-sf-bar")?.textContent || "")`), "the toolbar names the open filter");
    // Objects → My saved filters lists it.
    await click('#fabric-obj-inventory-saved');
    assert.ok(await wait(`[...document.querySelectorAll('#fabric-objects [data-action="fabric-s-open"]')].some((a) => /Synthetic sales items/.test(a.textContent))`), "listed in Objects");
    // All records clears the filter; opening the saved one restores it.
    await click("#fabric-obj-inventory-all");
    assert.ok(await wait(`!document.querySelector(".fx-chip--filter") && document.querySelectorAll(${JSON.stringify(LIST)}).length === 100`), "All records: no filter");
    assert.equal(filterOf((await lastRecords("inventory")).url), null);
    assert.equal(await has('[data-action="fabric-x-clear"][data-focus-key="clear-top"]'), false, "All records: no Clear filters");
    await b.evaluate(`[...document.querySelectorAll('#fabric-objects [data-action="fabric-s-open"]')].find((a) => /Synthetic sales items/.test(a.textContent)).click()`);
    assert.ok(await wait(`document.querySelectorAll(".fx-chip--filter").length === 2`), "opened: both conditions back");
    assert.ok(await wait(`!!document.querySelector('.fx-filterbar [data-action="fabric-x-clear"][data-focus-key="clear-top"]')`), "an opened saved filter shows Clear filters");
    assert.equal(filterOf((await lastRecords("inventory")).url).items.length, 2);
    // Manage → Rename.
    await click('[data-action="fabric-s-manage"]');
    assert.ok(await wait(`!!document.querySelector('#overlay-root .fx-sf-manage__row')`), "manage list");
    await click('#overlay-root [data-action="fabric-s-rename"]');
    assert.ok(await wait(`!!document.querySelector('#overlay-root form[data-mode="rename"] input[name="name"]')`));
    await setValue('#overlay-root input[name="name"]', "Synthetic items renamed", "input");
    await b.evaluate(`document.querySelector('#overlay-root form[data-mode="rename"]').requestSubmit()`);
    assert.ok(await wait(`(window.__calls || []).some((c) => c.method === "PUT" && c.url.startsWith("/api/v1/fabric/saved-filters/inventory/") && c.status === 200)`), "renamed");
    assert.ok(await wait(`/Synthetic items renamed/.test(document.querySelector("#fabric-objects")?.textContent || "") || /Synthetic items renamed/.test(document.querySelector("#overlay-root")?.textContent || "")`));
    await b.key("Escape");
    await wait(`!document.querySelector('#overlay-root form')`);

    // Broadened: one condition of the saved AND refers to a field that no longer exists (as after a schema change). Opening it
    // must not show more rows than it was saved for: the rows stay as they are, a warning is shown, the rest is only a draft.
    const doc = (await dataLayer.repos.fabricSavedFilters.collection.find({}).toArray()).find((d) => d.dataset === "inventory");
    assert.ok(doc, "the saved filter is in JARC's fabricSavedFilters");
    const filters = doc.filters.map((f) => ({ ...f, state: { ...f.state, filter: { ...f.state.filter, items: f.state.filter.items.map((it) => (it.field === "Item_No" ? { ...it, field: "Retired_Field" } : it)) } } }));
    await dataLayer.repos.fabricSavedFilters.collection.updateOne({ _id: doc._id }, { $set: { filters }, $inc: { rev: 1 } });
    await click("#fabric-obj-inventory-all");
    assert.ok(await wait(`!document.querySelector(".fx-chip--filter") && document.querySelectorAll(${JSON.stringify(LIST)}).length === 100`));
    const n = (await records("inventory")).length;
    await b.evaluate(`[...document.querySelectorAll('#fabric-objects [data-action="fabric-s-open"]')].find((a) => /Synthetic items renamed/.test(a.textContent))?.click()`);
    assert.ok(await wait(`!!document.querySelector(".fx-sf-notice")`, 10000), "a warning about the broadened filter");
    assert.match(await text(".fx-sf-notice"), /more rows|can.t be used|not applied/i);
    assert.doesNotMatch(await text(".fx-sf-notice"), /Retired_Field/, "the missing field is not named");
    await new Promise((r) => setTimeout(r, 500));
    const after = (await records("inventory")).slice(n);
    assert.ok(after.every((c) => !filterOf(c.url) || JSON.stringify(filterOf(c.url)).includes("Item_No")), `the narrower rest is not applied on its own ${JSON.stringify(after.map((c) => c.url))}`);
    assert.equal(await b.evaluate(`document.querySelectorAll(${JSON.stringify(LIST)}).length`), 100, "rows unchanged");
    assert.equal(await has(".fx-chip--filter"), false, "nothing applied");

    // Delete (Manage → Delete… → confirm).
    await click('[data-action="fabric-s-manage"]');
    assert.ok(await wait(`!!document.querySelector('#overlay-root [data-action="fabric-s-delete"]')`));
    await click('#overlay-root [data-action="fabric-s-delete"]');
    assert.ok(await wait(`!!document.querySelector('#overlay-root form[data-mode="delete"]')`), "confirm delete");
    await b.evaluate(`document.querySelector('#overlay-root form[data-mode="delete"]').requestSubmit()`);
    assert.ok(await wait(`(window.__calls || []).some((c) => c.method === "DELETE" && c.url.startsWith("/api/v1/fabric/saved-filters/inventory/"))`), "deleted");
    assert.ok(await wait(`!/Synthetic items renamed/.test(document.querySelector("#fabric-objects")?.textContent || "")`), "gone from Objects");
    await b.key("Escape");
    // Only JARC saved filters were written; nothing else in Fabric.
    const writes = (await calls()).filter((c) => c.method !== "GET");
    assert.ok(writes.every((c) => c.url.startsWith("/api/v1/fabric/saved-filters/")), JSON.stringify(writes));
    await noErrors("saved filters");
  });

  test("6. requests: one schema request per dataset, no board loads on a direct /fabric link, a stale answer never replaces a newer one", async () => {
    await signIn(people.admin);
    await openList("/fabric/inventory");
    assert.deepEqual((await json("window.__all || []")).filter((u) => /^\/api\/v1\/(workspaces|boards)\b/.test(u)), [], "no JARC board or workspace loads");
    for (let i = 0; i < 2; i += 1) {
      await click("#fabric-obj-sales");
      assert.ok(await wait(`location.pathname === "/fabric/sales" && document.querySelectorAll(${JSON.stringify(LIST)}).length > 0`));
      await click("#fabric-obj-inventory");
      assert.ok(await wait(`location.pathname === "/fabric/inventory" && document.querySelectorAll(${JSON.stringify(LIST)}).length > 0`));
    }
    const schema = (await calls()).filter((c) => /\/schema(\?|$)/.test(c.url));
    assert.equal(schema.filter((c) => c.url.includes("/inventory/")).length, 1, `inventory schema once ${JSON.stringify(schema.map((c) => c.url))}`);
    assert.equal(schema.filter((c) => c.url.includes("/sales/")).length, 1, "sales schema once");
    const status = (await calls()).filter((c) => c.url === "/api/v1/fabric/status");
    assert.ok(status.length <= 1, `status asked ${status.length} times`);
    // Stale: the answer for "ITEM-SYN-01" is held back 1.5 s; "ITEM-SYN-02" is typed after it. The rows must stay ITEM-SYN-02.
    await b.evaluate(`window.__delay = { match: "q=ITEM-SYN-01", ms: 1500 }`);
    await setValue("#fabric-inventory-q", "ITEM-SYN-01", "input");
    assert.ok(await wait(`(window.__all || []).some((u) => u.includes("q=ITEM-SYN-01"))`));
    await setValue("#fabric-inventory-q", "ITEM-SYN-02", "input");
    assert.ok(await wait(`(window.__calls || []).some((c) => c.url.includes("q=ITEM-SYN-02") && c.status === 200)`));
    assert.ok(await wait(`(window.__calls || []).some((c) => c.delayed)`, 5000), "the slow answer arrived");
    await new Promise((r) => setTimeout(r, 300));
    const ids = await json(`[...document.querySelectorAll(${JSON.stringify(LIST)})].map((tr) => tr.textContent)`);
    assert.ok(ids.length > 0 && ids.every((t) => t.includes("ITEM-SYN-02")), "the newer answer is the one shown");
    assert.equal(await b.evaluate(`document.querySelector("#fabric-inventory-q").value`), "ITEM-SYN-02");
    await noErrors("requests");
  });

  test("7. API Management only for API administrators; a reader sees neither the node nor the page", async () => {
    await signIn(people.reader);
    await openList("/fabric/inventory");
    assert.equal(await has("#fabric-obj-api"), false, "no API Management node");
    assert.ok(await b.evaluate(`[...document.querySelectorAll('#fabric-objects [role="treeitem"]')].every((t) => t.hasAttribute("aria-level"))`), "treeitems carry aria-level");
    assert.equal(await b.evaluate(`document.querySelectorAll('#fabric-objects [role="treeitem"][tabindex="0"]').length`), 1, "one roving tab stop");
    assert.equal(await b.evaluate(`document.querySelector('#fabric-objects [aria-current="page"]')?.id`), "fabric-obj-inventory-all");
    await b.open(`${base}/fabric/api`, DESKTOP);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 20000));
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(await has('[data-action="fabric-api-new"]'), false, "no API key controls");
    assert.equal((await calls()).filter((c) => c.url.startsWith("/api/v1/fabric/api-tokens")).length, 0, "no API token request");
    await noErrors("reader");
  });

  // 13-browser-responsive-review.md, D3–D7.
  const shiftTab = async () => {
    for (const type of ["keyDown", "keyUp"]) await b.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 });
    await new Promise((r) => setTimeout(r, 80));
  };
  const focusKey = () => b.evaluate(`document.activeElement?.dataset?.focusKey || document.activeElement?.tagName || ""`);
  // Focuses a control, then activates it (as a keyboard user does), so the dialog knows its opener.
  const press = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.focus(); el.click(); return true; })()`);

  test("8. D3 + D6 (1440): saved-filter dialogs give focus back to their opener on every close path; Manage is styled; the toolbar stays on one row", async () => {
    await signIn(people.admin);
    await openList();
    await openBuilder();
    const q = await addCondition("Item_No");
    await setValue(`[data-action="fabric-f-value"][data-path="${q}"]`, "ITEM-SYN-0", "input");
    await apply();
    await press('[data-action="fabric-s-save"]');
    assert.ok(await wait(`!!document.querySelector('#overlay-root form[data-mode="save"]')`), "save dialog");
    // D3: Cancel returns focus to Save filter… (not <body>).
    await click('#overlay-root [data-sf-cancel]');
    assert.ok(await wait(`!document.querySelector("#overlay-root form") && document.activeElement?.dataset.focusKey === "sf-bar-save"`), `Cancel → Save filter… (${await focusKey()})`);
    await press('[data-action="fabric-s-save"]');
    assert.ok(await wait(`document.activeElement?.name === "name"`));
    await b.key("Escape");
    assert.ok(await wait(`!document.querySelector("#overlay-root form") && document.activeElement?.dataset.focusKey === "sf-bar-save"`), `Escape → Save filter… (${await focusKey()})`);
    await press('[data-action="fabric-s-save"]');
    await wait(`document.activeElement?.name === "name"`);
    await setValue('#overlay-root input[name="name"]', "Synthetic focus check", "input");
    await b.evaluate(`document.querySelector('#overlay-root form[data-mode="save"]').requestSubmit()`);
    assert.ok(await wait(`!document.querySelector("#overlay-root form") && /Synthetic focus check/.test(document.querySelector(".fx-sf-bar")?.textContent || "") && document.activeElement?.dataset.focusKey === "sf-bar-save"`), `saved → Save as new… (${await focusKey()})`);

    // D6 (c): at 1440 with the 240 px Objects panel open and a saved filter open, the toolbar is one row.
    assert.equal(await b.evaluate(`document.querySelector("#fabric-objects").classList.contains("is-collapsed")`), false, "the Objects panel is open");
    const rows = await json(`(() => { const kids = [...document.querySelector(".fx-explorer__toolbar").children].filter((el) => el.getClientRects().length && getComputedStyle(el).display !== "none"); const mids = kids.map((el) => { const r = el.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }); return { spread: Math.max(...mids) - Math.min(...mids), height: Math.round(document.querySelector(".fx-explorer__toolbar").getBoundingClientRect().height), width: document.querySelector(".fx-explorer__toolbar").clientWidth, parts: kids.map((el) => (el.className || el.tagName).split(" ")[0] + ":" + Math.round(el.getBoundingClientRect().width)).join(" ") }; })()`);
    assert.ok(rows.spread <= 2 && rows.height <= 40, `toolbar on one row at 1440 ${JSON.stringify(rows)}`);
    // D6 (b): Save and Manage are the same kind of button: same height, same baseline, both with an icon.
    const pair = await json(`["sf-bar-save", "sf-bar-manage"].map((k) => { const el = document.querySelector('[data-focus-key="' + k + '"]'); const r = el.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height), icon: !!el.querySelector("svg"), name: (el.getAttribute("aria-label") || el.textContent).trim() }; })`);
    assert.deepEqual([pair[0].top, pair[0].height, pair[0].icon], [pair[1].top, pair[1].height, pair[1].icon], JSON.stringify(pair));
    assert.match(pair[1].name, /Manage saved filters/, "Manage keeps its full accessible name");

    // D3: Manage → Escape, × and Close all return to Manage; Manage → Rename… → Escape too (the first opener is kept).
    for (const close of ["escape", '#overlay-root [data-action="close-overlay"][aria-label="Close"]', "#overlay-root [data-sf-cancel]"]) {
      await press('[data-action="fabric-s-manage"]');
      assert.ok(await wait(`!!document.querySelector('#overlay-root .fx-sf-manage__row')`), "manage list");
      if (close === "escape") await b.key("Escape"); else await click(close);
      assert.ok(await wait(`!document.querySelector("#overlay-root form") && document.activeElement?.dataset.focusKey === "sf-bar-manage"`), `${close} → Manage (${await focusKey()})`);
    }
    await press('[data-action="fabric-s-manage"]');
    await wait(`!!document.querySelector('#overlay-root .fx-sf-manage__row')`);
    // D6 (a): the Manage list has no bullets, its row actions don't touch, and it uses the fx dialog.
    const manage = await json(`(() => { const ul = document.querySelector("#overlay-root .fx-sf-manage"), btns = [...ul.querySelectorAll(".fx-sf-manage__actions .fx-btn")].map((x) => x.getBoundingClientRect()); return { list: getComputedStyle(ul).listStyleType, pad: getComputedStyle(ul).paddingLeft, gaps: btns.slice(1).map((r, i) => Math.round(r.left - btns[i].right)), dialog: !!ul.closest(".fx-dialog .fx-dialog__body") }; })()`);
    assert.equal(manage.list, "none", "no list bullets");
    assert.equal(manage.pad, "0px");
    assert.ok(manage.dialog && manage.gaps.length === 3 && manage.gaps.every((g) => g >= 4), `row actions apart ${JSON.stringify(manage)}`);
    await click('#overlay-root [data-action="fabric-s-rename"]');
    assert.ok(await wait(`!!document.querySelector('#overlay-root form[data-mode="rename"]')`));
    await b.key("Escape");
    assert.ok(await wait(`!document.querySelector("#overlay-root form") && document.activeElement?.dataset.focusKey === "sf-bar-manage"`), `Rename (from Manage) → Escape → Manage (${await focusKey()})`);
    // Clean up: delete it (Manage → Delete… → confirm); with none left, focus falls back to Save filter….
    await press('[data-action="fabric-s-manage"]');
    await wait(`!!document.querySelector('#overlay-root [data-action="fabric-s-delete"]')`);
    await click('#overlay-root [data-action="fabric-s-delete"]');
    await wait(`!!document.querySelector('#overlay-root form[data-mode="delete"]')`);
    await b.evaluate(`document.querySelector('#overlay-root form[data-mode="delete"]').requestSubmit()`);
    assert.ok(await wait(`!document.querySelector("#overlay-root form") && document.activeElement?.dataset.focusKey === "sf-bar-save"`), `last one deleted → Save filter… (${await focusKey()})`);
    // D7: the desktop density is unchanged (fine pointer).
    const desk = await json(`({ coarse: matchMedia("(pointer: coarse)").matches, sort: Math.round(document.querySelector(".fx-grid__sort").getBoundingClientRect().height), link: Math.round(document.querySelector(".fabric-explorer-table .fabric-link").getBoundingClientRect().height) })`);
    assert.ok(!desk.coarse && desk.sort < 32 && desk.link < 32, `desktop density unchanged ${JSON.stringify(desk)}`);
    // The builder is not modal on the desktop (the page stays usable beside it).
    await openBuilder();
    assert.equal(await b.evaluate(`document.querySelector("#fabric-inventory-fb").getAttribute("aria-modal")`), "false");
    await b.key("Escape");
    await noErrors("D3 D6");
  });

  test("8b. D4 + D5 + D7 (390 phone): the full-screen builder traps Tab and Shift+Tab; hidden header controls leave the Tab order; 32 px touch targets", async () => {
    await signIn(people.admin);
    await openList("/fabric/inventory", { width: 390, height: 844 });
    assert.ok(await b.evaluate(`matchMedia("(pointer: coarse)").matches`), "a phone has a coarse pointer");
    // D7: record links and header sort buttons are at least 32 px tall on touch.
    const touch = await json(`({ link: Math.round(document.querySelector(".fabric-explorer-table .fabric-link").getBoundingClientRect().height), sort: Math.round(document.querySelector(".fx-grid__sort").getBoundingClientRect().height) })`);
    assert.ok(touch.link >= 32 && touch.sort >= 32, `32 px touch targets ${JSON.stringify(touch)}`);
    // D5: the clipped header row's controls can't take focus.
    assert.ok(await b.evaluate(`[...document.querySelectorAll(".fabric-explorer-table thead button")].every((el) => getComputedStyle(el).visibility === "hidden")`), "header controls hidden");
    await b.evaluate(`document.querySelector("#fabric-inventory-q").focus()`);
    const seen = [];
    for (let i = 0; i < 30; i += 1) {
      await b.key("Tab");
      seen.push(await json(`(() => { const a = document.activeElement; return { key: a?.dataset?.focusKey || a?.tagName, head: !!a?.closest?.("thead"), visible: !!a && a.getClientRects().length > 0 && getComputedStyle(a).visibility !== "hidden" }; })()`));
    }
    assert.ok(seen.every((s) => !s.head && s.visible), `Tab never lands on a hidden control ${JSON.stringify(seen.filter((s) => s.head || !s.visible))}`);
    // D4: the builder is a modal dialog; Tab and Shift+Tab stay inside it.
    await b.evaluate("window.scrollTo(0, 0)");
    await press(FILTERS());
    assert.ok(await wait(`!!document.querySelector("#fabric-inventory-fb")`));
    await addCondition("Entry_Type");
    assert.equal(await b.evaluate(`document.querySelector("#fabric-inventory-fb").getAttribute("aria-modal")`), "true");
    await b.evaluate(`document.querySelector('#fabric-inventory-fb [data-focus-key="fb-close"]').focus()`);
    const inside = () => b.evaluate(`!!document.activeElement?.closest("#fabric-inventory-fb")`);
    for (let i = 0; i < 25; i += 1) { await b.key("Tab"); assert.ok(await inside(), `Tab ${i} stays in the builder (${await focusKey()})`); }
    for (let i = 0; i < 25; i += 1) { await shiftTab(); assert.ok(await inside(), `Shift+Tab ${i} stays in the builder (${await focusKey()})`); }
    // From the first control, Shift+Tab wraps to the last (Apply), and Tab from there wraps back.
    await b.evaluate(`document.querySelector('#fabric-inventory-fb [data-focus-key="fb-close"]').focus()`);
    await shiftTab();
    assert.equal(await focusKey(), "fb-apply", "Shift+Tab from × wraps to Apply");
    await b.key("Tab");
    assert.equal(await focusKey(), "fb-close", "Tab from Apply wraps to ×");
    // Escape still cancels and gives focus back to Filters.
    await b.key("Escape");
    assert.ok(await wait(`!document.querySelector("#fabric-inventory-fb") && document.activeElement?.matches(${JSON.stringify(FILTERS())})`), "Escape closes the builder, focus back on Filters");
    assert.equal(await lastRecords("inventory").then((c) => filterOf(c.url)), null, "nothing applied");
    await noErrors("D4 D5 D7");
  });

  test("9. toolbar: Save filter before Columns (also by Tab); Clear filters only in the chips row, at its right, only while something applied is clearable", async () => {
    await signIn(people.admin);
    const CLEAR = '[data-action="fabric-x-clear"][data-focus-key="clear-top"]';
    const enc = (m) => Buffer.from(JSON.stringify(m), "utf8").toString("base64url");
    const two = enc({ v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "Synthetic Co A" }, { field: "customer_name", op: "contains", value: "Customer" }] });
    // Sales, default: the required window's chip (locked) only; no Clear filters anywhere, and none in the toolbar.
    await openList("/fabric/sales");
    assert.ok(await wait(`!!document.querySelector(".fx-chip--filter.is-locked")`), "the default Sales window chip");
    assert.equal(await has(CLEAR), false, "Sales default: no Clear filters (the default window isn't a filter)");
    assert.equal(await has('.fx-explorer__toolbar [data-action="fabric-x-clear"]'), false);
    // Order on screen (one row at 1440) and in the DOM: Refresh, Search, Filters, Save filter…, Columns, Sort, Rows per page.
    const SEQ = ['[data-action="fabric-refresh"]', "#fabric-sales-q", FILTERS("sales"), '[data-focus-key="sf-bar-save"]', '[data-focus-key="cols"]', '[data-action="fabric-x-dir-toggle"]', "#fabric-sales-limit"];
    const pos = await json(`${JSON.stringify(SEQ)}.map((s) => { const el = document.querySelector(".fx-explorer__toolbar " + s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top + r.height / 2) }; })`);
    assert.ok(pos.every(Boolean), `every control in the toolbar: ${JSON.stringify(pos)}`);
    assert.ok(pos.every((p, i) => i === 0 || p.x > pos[i - 1].x), `left to right: ${JSON.stringify(pos)}`);
    assert.ok(pos.every((p) => Math.abs(p.y - pos[0].y) <= 4), `one row at 1440: ${JSON.stringify(pos)}`);
    // Tab order follows it: from Filters, Tab → Save filter… → Columns.
    await b.evaluate(`document.querySelector(${JSON.stringify(FILTERS("sales"))}).focus()`);
    await b.key("Tab"); assert.equal(await focusKey(), "sf-bar-save", "Filters → Tab → Save filter…");
    await b.key("Tab"); assert.equal(await focusKey(), "cols", "Save filter… → Tab → Columns");
    // An unapplied draft in the builder shows nothing.
    await openBuilder("sales");
    await addCondition("customer_name", "", "sales");
    assert.equal(await has(CLEAR), false, "a draft condition isn't applied");
    await b.key("Escape");
    assert.ok(await wait(`!document.querySelector("#fabric-sales-fb")`));
    assert.equal(await has(CLEAR), false);

    // Two applied conditions: Clear filters at the far right of the chips row, beside the chips, at every width and theme.
    for (const [width, height] of [[320, 640], [390, 844], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]]) {
      for (const theme of ["light", "dark"]) {
        const label = `${width}px ${theme}`;
        await openList(`/fabric/sales?filter=${two}`, { width, height });
        await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
        assert.ok(await wait(`document.querySelectorAll(".fx-chip--filter:not(.is-locked)").length === 2 && !!document.querySelector(${JSON.stringify(CLEAR)})`), `${label}: chips and Clear filters`);
        const g = await json(`(() => { const bar = document.querySelector(".fx-filterbar").getBoundingClientRect(), btn = document.querySelector(${JSON.stringify(CLEAR)}), r = btn.getBoundingClientRect();
          const chips = [...document.querySelectorAll(".fx-filterbar .fx-chip--filter")].map((c) => c.getBoundingClientRect());
          const overlap = chips.some((c) => c.left < r.right && r.left < c.right && c.top < r.bottom && r.top < c.bottom);
          return { inBar: btn.closest(".fx-filterbar") !== null, right: Math.round(bar.right - r.right), barH: Math.round(bar.height), h: Math.round(r.height), overlap, rightOfChips: chips.every((c) => c.right <= r.left + 1 || c.bottom <= r.top + 1), vw: document.documentElement.clientWidth, btnRight: Math.round(r.right), text: btn.textContent.trim(), sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
        assert.equal(g.inBar, true, label); assert.equal(g.text, "Clear filters", label);
        assert.ok(g.right >= 0 && g.right <= 12, `${label}: at the row's right edge (${JSON.stringify(g)})`);
        assert.equal(g.overlap, false, `${label}: never over a chip`); assert.ok(g.rightOfChips, `${label}: chips to its left (or above)`);
        assert.ok(g.btnRight <= g.vw, `${label}: on screen`); assert.equal(g.sideways, 0, `${label}: no sideways scroll`);
        if (width > 1024) assert.ok(g.barH <= 32, `${label}: the chips row stays one compact row (${JSON.stringify(g)})`);
        else assert.ok(g.h >= 32, `${label}: touch-size button (${g.h}px)`);
      }
    }
    // Removing one condition keeps it; removing the last hides it; the window chip stays.
    await openList(`/fabric/sales?filter=${two}`);
    assert.ok(await wait(`!!document.querySelector(${JSON.stringify(CLEAR)})`));
    await click('.fx-chip--filter:not(.is-locked) [data-action="fabric-x-chip"]');
    assert.ok(await wait(`document.querySelectorAll(".fx-chip--filter:not(.is-locked)").length === 1 && !!document.querySelector(${JSON.stringify(CLEAR)})`), "one left: still shown");
    await click('.fx-chip--filter:not(.is-locked) [data-action="fabric-x-chip"]');
    assert.ok(await wait(`!document.querySelector(".fx-chip--filter:not(.is-locked)") && !document.querySelector(${JSON.stringify(CLEAR)})`), "last removed: hidden");
    assert.equal(await has(".fx-chip--filter.is-locked"), true, "the required window stays");
    // Clear filters: the same reset as before; the window protection stays, focus goes to Filters.
    await openList(`/fabric/sales?filter=${two}&q=SYN`);
    assert.ok(await wait(`!!document.querySelector(${JSON.stringify(CLEAR)})`));
    await press(CLEAR);
    assert.ok(await wait(`!document.querySelector(".fx-chip--filter:not(.is-locked)") && !document.querySelector(${JSON.stringify(CLEAR)})`), "cleared");
    const last = new URLSearchParams((await lastRecords("sales")).url.split("?")[1]);
    assert.deepEqual(["filter", "q", "dateFrom", "dateTo"].map((k) => last.get(k)), [null, null, null, null], "filters, search and custom dates cleared; the server's default window applies");
    assert.equal(await has(".fx-chip--filter.is-locked"), true, "the required window chip stays");
    assert.ok(await wait(`document.activeElement?.matches(${JSON.stringify(FILTERS("sales"))})`), `focus on Filters (${await focusKey()})`);
    // Sorting, columns and the page size are preferences, not filters: a column sort, a page size and the chosen columns survive.
    await openList(`/fabric/sales?filter=${two}&orderBy=invoice_date:asc&limit=50`);
    assert.ok(await wait(`!!document.querySelector(${JSON.stringify(CLEAR)})`));
    const colsBefore = await b.evaluate(`document.querySelector('[data-focus-key="cols"]').textContent.trim()`);
    // Header titles minus the " · filtered" marks (those go with the filters, as they should).
    const HEADS = `[...document.querySelectorAll(".fabric-explorer-table thead th")].map((t) => t.title.replace(/ · filtered/g, "")).join("|")`;
    const heads = await b.evaluate(HEADS);
    await press(CLEAR);
    assert.ok(await wait(`!document.querySelector(".fx-chip--filter:not(.is-locked)") && !document.querySelector(${JSON.stringify(CLEAR)})`), "cleared (with a column sort)");
    const kept = new URLSearchParams((await lastRecords("sales")).url.split("?")[1]);
    assert.deepEqual(["filter", "q", "dateFrom", "orderBy", "limit"].map((k) => kept.get(k)), [null, null, null, "invoice_date:asc", "50"], "sort and page size kept, filters gone");
    assert.match(await b.evaluate("location.search"), /orderBy=invoice_date(%3A|:)asc/, "the address keeps the sort");
    assert.equal(await b.evaluate(`document.querySelector('[data-focus-key="cols"]').textContent.trim()`), colsBefore, "columns kept");
    assert.equal(await b.evaluate(HEADS), heads, "same columns and sort marks");
    assert.equal(await has(".fx-chip--filter.is-locked"), true, "the Sales window protection stays");

    // Inventory: nothing applied → no row, no button, no space; applied → shown; same toolbar order.
    await openList("/fabric/inventory");
    assert.equal(await has(CLEAR), false, "Inventory without filters: no Clear filters");
    assert.equal(await b.evaluate(`document.querySelector(".fx-filterbar").getBoundingClientRect().height`), 0, "the empty row takes no space");
    const inv = await json(`["#fabric-inventory-q", ${JSON.stringify(FILTERS())}, '[data-focus-key="sf-bar-save"]', '[data-focus-key="cols"]', "#fabric-inventory-sort", "#fabric-inventory-limit"].map((s) => Math.round(document.querySelector(".fx-explorer__toolbar " + s).getBoundingClientRect().left))`);
    assert.ok(inv.every((x, i) => i === 0 || x > inv[i - 1]), `Inventory order: ${JSON.stringify(inv)}`);
    await openList(`/fabric/inventory?filter=${enc({ v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "Synthetic Co A" }] })}`);
    assert.ok(await wait(`!!document.querySelector(${JSON.stringify(CLEAR)})`), "Inventory with a filter: shown");
    await press(CLEAR);
    assert.ok(await wait(`!document.querySelector(".fx-chip--filter") && !document.querySelector(${JSON.stringify(CLEAR)})`));
    // Inventory's own sort, ascending, is kept. Entry no. (listed one company at a time) can't outlive the company filter it
    // needs: Clear filters puts the default sort back instead of leaving a "choose a company" message.
    await openList(`/fabric/inventory?filter=${enc({ v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "Synthetic Co A" }] })}&sort=date&dir=asc`);
    await press(CLEAR);
    assert.ok(await wait(`!document.querySelector(${JSON.stringify(CLEAR)})`));
    let iq = new URLSearchParams((await lastRecords("inventory")).url.split("?")[1]);
    assert.deepEqual([iq.get("filter"), iq.get("sort"), iq.get("dir")], [null, "date", "asc"], "Inventory: sort and direction kept");
    await openList(`/fabric/inventory?filter=${enc({ v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "Synthetic Co A" }] })}&sort=entryNo&dir=asc`);
    assert.equal(new URLSearchParams((await lastRecords("inventory")).url.split("?")[1]).get("sort"), "entryNo", "Entry no. with a company");
    await press(CLEAR);
    assert.ok(await wait(`!document.querySelector(${JSON.stringify(CLEAR)}) && document.querySelectorAll(${JSON.stringify(LIST)}).length > 0`), "rows, not a company prompt");
    iq = new URLSearchParams((await lastRecords("inventory")).url.split("?")[1]);
    assert.deepEqual([iq.get("filter"), iq.get("sort")], [null, null], "Entry no. needed the company: back to the default sort");
    await noErrors("toolbar refinement");
  });
});
