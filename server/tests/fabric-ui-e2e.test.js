// Fabric Data end to end: the REAL app (createApp with Fabric on, API tokens on, development_shared + beta open editing,
// Microsoft Entra sign-in with local test keys, JARC on its fake MongoDB) in a headless Chrome/Edge, against the REAL Fabric
// backend (src/fabric) over tests/support/fabric-fake.js. Checks that the frontend (FabricDataPanel / FabricExplorer /
// FabricApiPanel) and the backend agree on the contract-v2 shapes: /status, /:dataset/schema, /:dataset/records,
// /records/:id and /fabric/api-tokens. Sales starts in index-required mode (more rows than FABRIC_UNINDEXED_SCAN_MAX, only
// _id), then gets its index; inventory is in small-collection mode. Synthetic data only. Skipped without Chrome or Edge.
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
const { FabricFakeClient, row, inventoryRows, DEFAULT_INDEXES, ID_ONLY } = require("./support/fabric-fake");
const { findBrowser, launch, freePort } = require("./support/headless-browser");

const BROWSER = findBrowser();
const DESKTOP = { width: 1440, height: 900 };
const SENSITIVE_INV = ["Cost_Amount_Expected", "Cost_Amount_Actual", "Cost_Amount_Non_Invtbl", "Cost_Amount_Expected_ACY", "Cost_Amount_Actual_ACY", "Cost_Amount_Non_Invtbl_ACY", "landed_cost", "distributors_price", "trade_price"];
const INV_DEFAULTS = ["Posting_Date", "Company", "Entry_No", "Entry_Type", "Document_No", "Item_No", "Item_Description", "Location_Code", "Quantity", "Remaining_Quantity", "Unit_of_Measure_Code"];

// 400 synthetic FactSales lines over 90 days ending 2026-03-31 (more than the scan cap below: no index → index required).
function salesRows() {
  const out = [];
  for (let i = 0; i < 400; i += 1) {
    const d = new Date(Date.UTC(2026, 2, 31) - (i % 90) * 86400000);
    out.push(row({ Company: i % 3 ? "Synthetic Co A" : "Synthetic Co B", invoice_id: `SYN-${String(5000 + Math.floor(i / 2)).padStart(5, "0")}`, Line_No: (1 + (i % 2)) * 10000, invoice_date: d, customer_name: `Example Customer ${i % 7}`, invoice_item_name: `Synthetic product ${i % 11}`, invoice_item_quantity: 1 + (i % 5), invoice_item_amount: 10 * (1 + (i % 5)), sales_data_source: "Source One", landed_cost: "1.25" }));
  }
  return out;
}

// Records page script: console errors, uncaught errors and every /api/v1/fabric request (URL, status, and for record lists the
// window and row count the server answered).
const PROBE = `(() => {
  window.__errors = []; window.__calls = [];
  const oe = console.error.bind(console);
  console.error = (...a) => { window.__errors.push(a.map((x) => (x && x.stack) || String(x)).join(" ")); oe(...a); };
  addEventListener("error", (e) => window.__errors.push("uncaught: " + (e.message || e.type)));
  addEventListener("unhandledrejection", (e) => window.__errors.push("rejection: " + ((e.reason && e.reason.message) || e.reason)));
  const of = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    let url = typeof input === "string" ? input : input.url;
    // window.__staleCursor: the next cursor sent is one this server never signed (what a restart or deploy leaves behind).
    if (window.__staleCursor && /[?&]cursor=/.test(url)) { window.__staleCursor = false; url = url.replace(/([?&]cursor=)[^&]*/, "$1eyJiIjoic3RhbGUiLCJ2IjpbXX0"); input = url; }
    const res = await of(input, init);
    if (url.includes("/api/v1/fabric")) {
      const entry = { url: url.replace(/^https?:\\/\\/[^/]+/, ""), status: res.status };
      window.__calls.push(entry);
      if (/\\/records(\\?|$)/.test(url)) res.clone().json().then((j) => { entry.window = j.window; entry.count = Array.isArray(j.items) ? j.items.length : null; entry.hasMore = j.pagination && j.pagination.hasMore; }).catch(() => {});
    }
    return res;
  };
})();`;

describe("Fabric Data in the real app (headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let issuer, people, server, base, b, fabricClient, stack, app;

  before(async () => {
    issuer = await createTokenIssuer();
    people = {
      admin: issuer.person("Ada FabricAdmin"), reader: issuer.person("Rhea Reader"), sensitive: issuer.person("Sid Sensitive"), outsider: issuer.person("Olive Outsider")
    };
    const oids = (...ps) => ps.map((p) => p.oid).join(",");
    const port = await freePort();
    base = `http://localhost:${port}`;
    const entra = { ...issuer.config, redirectUri: `${base}/`, appOrigin: base };
    const env = entraEnv({
      JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb", FABRIC_UNINDEXED_SCAN_MAX: "300",
      FABRIC_DATA_READER_OIDS: oids(people.admin, people.reader, people.sensitive), FABRIC_DATA_COST_READER_OIDS: oids(people.admin, people.sensitive), FABRIC_API_ADMIN_OIDS: oids(people.admin)
    });
    const config = loadConfig(env).fabricData;
    fabricClient = new FabricFakeClient({ docs: salesRows(), indexes: ID_ONLY, inventory: { docs: inventoryRows(250) } });
    stack = createFabricData({ config, logger: { warn() {}, error() {} }, createClient: () => fabricClient });
    const fake = new FakeMongoClient();
    const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
    await connection.connect();
    await ensureDatabase(connection.db);
    const dataLayer = createDataLayer({ connection, logger: { error() {} }, fileStore: new MemoryFileStore(), environment: "test" });
    app = createApp({
      repository: new MemoryStateRepository(), environment: "test", logger: { error() {}, warn() {} }, dataLayer,
      auth: { mode: "entra", entra, verify: createEntraVerifier({ ...entra, keySet: issuer.keySet }) },
      accessPolicy: "development_shared", betaOpenEditing: true,
      apiTokens: { key: crypto.randomBytes(32), adminObjectIds: [], issuePerHour: 1000, maxActive: 1000 },
      fabricData: { config, service: stack.service, limiter: fabricLimiter({ perWindow: 100000 }) }
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
  const setValue = (sel, value, event = "change") => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; if (el.type === "checkbox") el.checked = ${JSON.stringify(Boolean(value))}; else el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); return true; })()`);
  const calls = () => json("window.__calls || []");
  const lastRecords = async (ds) => (await calls()).filter((c) => c.url.startsWith(`/api/v1/fabric/${ds}/records?`)).at(-1);
  const headers = () => json(`[...document.querySelectorAll(".fabric-explorer-table thead th")].map((th) => th.querySelector(".fabric-sort") ? th.querySelector(".fabric-sort").childNodes[0].textContent.trim() : th.textContent.replace(/\\s*S$/, "").trim())`);
  const rowCount = () => b.evaluate(`document.querySelectorAll(".fabric-explorer-table tbody tr").length`);
  const noErrors = async (label) => { const errors = await json("window.__errors || []"); assert.deepEqual(errors, [], `${label}: console errors`); };
  let current = null;
  const signIn = async (person) => {
    if (current === person) return;
    await b.open(`${base}/api/v1/health`, DESKTOP);
    const nonce = await b.evaluate(`fetch("/api/v1/auth/sign-in/start", { method: "POST" }).then((r) => r.json()).then((s) => s.nonce)`);
    const idToken = await person.idToken(nonce);
    assert.equal(await b.evaluate(`fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: ${JSON.stringify(idToken)} }) }).then((r) => r.status)`), 201, `sign-in ${person.name}`);
    current = person;
  };
  const openApp = async (path = "/") => {
    await b.open(`${base}${path}`, DESKTOP);
    assert.ok(await wait("!!document.querySelector('.app-shell')", 20000), "app loaded");
  };
  const openInventoryList = async (path = "/fabric/inventory") => {
    await openApp(path);
    assert.ok(await wait("document.querySelectorAll('.fabric-explorer-table tbody tr').length > 0", 15000), "inventory rows");
  };
  const ascii = (s) => s.replace(/[–—]/g, "-").replace(/\s+/g, " ");

  test("1. the sidebar shows Fabric Data above Settings for readers only; a non-reader's /fabric/sales shows no data", async () => {
    await signIn(people.reader);
    await openApp("/");
    assert.ok(await wait("!!document.querySelector('.sidebar-footer .nav-fabric')"), "Fabric Data in the sidebar");
    const order = await json(`[...document.querySelector(".sidebar-footer").children].map((el) => el.classList.contains("nav-fabric") ? "fabric" : el.dataset.action)`);
    assert.equal(order.indexOf("fabric") + 1, order.indexOf("settings"), `directly above Settings: ${order}`);
    assert.match(await text(".sidebar-footer .nav-fabric"), /Fabric Data/);
    await noErrors("reader home");

    await signIn(people.outsider);
    await openApp("/");
    await b.waitFor("false", 800);
    assert.equal(await has(".nav-fabric"), false, "no Fabric Data for a non-reader");
    await openApp("/fabric/sales");
    await b.waitFor("false", 1500);
    assert.equal(await has(".fabric-explorer-table"), false);
    assert.equal(await has("#fabric-root"), false);
    assert.doesNotMatch(await b.evaluate("document.body.innerText"), /Synthetic Co|SYN-0|Example Customer/);
    assert.equal((await calls()).filter((c) => c.status === 200).length, 0, "no Fabric data answered");
    await noErrors("outsider");
  });

  test("2. Inventory: default columns and rows, search, filter, sort, next page, Refresh, column chooser, record page", async () => {
    await signIn(people.reader);
    await openInventoryList();
    assert.deepEqual(await headers(), INV_DEFAULTS, "the schema's default columns, in order");
    assert.equal(await rowCount(), 100, "a page of 100 (default limit)");
    let last = await lastRecords("inventory");
    assert.equal(new URLSearchParams(last.url.split("?")[1]).get("fields"), INV_DEFAULTS.join(","));
    assert.match(ascii(await text(".fabric-window")), /Showing all dates/, "small mode: no window");
    assert.deepEqual(last.window, { field: "Posting_Date", dateFrom: null, dateTo: null, defaulted: false, all: true });
    assert.doesNotMatch(await text("#fabric-inventory-range-help"), /Up to \d+ days/, "small mode: /status window.maxDays is null, so no day limit is claimed");
    // No sensitive column anywhere for a non-sensitive reader.
    await click('[data-action="fabric-x-columns"][data-focus-key="cols"]');
    assert.ok(await wait("!!document.querySelector('#fabric-inventory-chooser')"));
    const chooser = await json(`[...document.querySelectorAll("#fabric-inventory-col-list input")].map((i) => i.dataset.name)`);
    assert.equal(chooser.length, 78);
    for (const f of SENSITIVE_INV) assert.ok(!chooser.includes(f), f);
    assert.doesNotMatch(await b.evaluate("document.body.innerHTML"), /Cost_Amount|distributors_price|trade_price|landed_cost/);
    // Hide a column → fields= without it; storage keeps names only.
    await setValue('#fabric-inventory-col-list input[data-name="Item_Description"]', false);
    assert.ok(await wait(`(window.__calls || []).some((c) => c.url.includes("/inventory/records?") && !c.url.includes("Item_Description"))`), "re-requested without the column");
    last = await lastRecords("inventory");
    assert.deepEqual(new URLSearchParams(last.url.split("?")[1]).get("fields").split(","), INV_DEFAULTS.filter((f) => f !== "Item_Description"));
    const stored = await b.evaluate(`localStorage.getItem("jarc.fabric.columns.inventory")`);
    assert.deepEqual(JSON.parse(stored), INV_DEFAULTS.filter((f) => f !== "Item_Description"), "names only");
    const all = await json("Object.entries(localStorage)");
    assert.doesNotMatch(JSON.stringify(all), /Synthetic Co|DOC-SYN|ITEM-SYN|WH-/, "no Fabric value in browser storage");
    assert.ok(await wait("document.querySelectorAll('.fabric-explorer-table tbody tr').length === 100"));
    assert.ok(!(await headers()).includes("Item_Description"));
    await click('[data-action="fabric-x-columns-reset"]');
    assert.ok(await wait(`document.querySelectorAll(".fabric-explorer-table thead th").length === ${INV_DEFAULTS.length}`));
    await click('[data-action="fabric-x-columns"][data-focus-key="cols-done"]');

    // Search (debounced).
    await setValue("#fabric-inventory-q", "ITEM-SYN-01", "input");
    assert.ok(await wait(`(window.__calls || []).some((c) => c.url.includes("/inventory/records?") && c.url.includes("q=ITEM-SYN-01"))`), "search sent");
    assert.ok(await wait(`[...document.querySelectorAll(".fabric-explorer-table tbody tr")].length > 0 && [...document.querySelectorAll(".fabric-explorer-table tbody tr")].every((tr) => /ITEM-SYN-01/.test(tr.textContent))`), "only matching rows");
    assert.match(await b.evaluate("location.search"), /q=ITEM-SYN-01/);
    await click('[data-action="fabric-x-clear"][data-focus-key="clear-top"]');
    assert.ok(await wait("document.querySelectorAll('.fabric-explorer-table tbody tr').length === 100"));

    // A filter from the schema (entryType).
    assert.ok(await has("#fabric-inventory-f-entryType"), "entryType filter rendered");
    await setValue("#fabric-inventory-f-entryType", "Sale");
    assert.ok(await wait(`(window.__calls || []).some((c) => c.url.includes("entryType=Sale"))`));
    assert.ok(await wait(`(() => { const rows = [...document.querySelectorAll(".fabric-explorer-table tbody tr")]; return rows.length > 0 && rows.every((tr) => tr.querySelector('td[data-label="Entry_Type"]').textContent === "Sale"); })()`), "only Sale rows");
    await click('[data-action="fabric-x-clear"][data-focus-key="clear-top"]');
    assert.ok(await wait("document.querySelectorAll('.fabric-explorer-table tbody tr').length === 100"));

    // Sort header (Entry_No → the entryNo sort).
    assert.ok(await has('[data-action="fabric-x-sort"][data-sort="entryNo"]'), "Entry_No is sortable");
    assert.ok(await has('[data-action="fabric-x-sort"][data-sort="date"]'), "Posting_Date is sortable");
    // entryNo is listed one company at a time (schema sorts[].requiresCompany, dateRange false): nothing is sent until a
    // company is chosen, and then never with dates.
    await click('[data-action="fabric-x-sort"][data-sort="entryNo"]');
    assert.ok(await wait(`/one company at a time/.test(document.querySelector("#fabric-inventory-range-help")?.textContent || "")`), "asks for a company");
    assert.equal((await calls()).filter((c) => c.url.includes("sort=entryNo")).length, 0, "no request the server would refuse");
    assert.equal(await b.evaluate(`document.querySelector("#fabric-inventory-from").disabled`), true, "dates don't apply");
    await setValue("#fabric-inventory-f-company", "Synthetic Co A");
    assert.ok(await wait(`(window.__calls || []).some((c) => c.url.includes("sort=entryNo") && c.url.includes("company=Synthetic+Co+A") && c.status === 200)`), "sorted request with the company");
    assert.ok((await calls()).filter((c) => c.url.includes("sort=entryNo")).every((c) => !c.url.includes("dateFrom")));
    assert.ok(await wait(`document.querySelector('[data-sort="entryNo"]')?.closest("th")?.getAttribute("aria-sort") === "descending"`));
    assert.ok(await wait("document.querySelectorAll('.fabric-explorer-table tbody tr').length > 0"));
    const entries = await json(`[...document.querySelectorAll(".fabric-explorer-table tbody tr")].map((tr) => [tr.querySelector('td[data-label="Company"]').textContent, Number(tr.querySelector('td[data-label="Entry_No"]').textContent.replace(/\\D/g, ""))])`);
    assert.ok(entries.every(([c]) => c === "Synthetic Co A"), "one company");
    assert.ok(entries.every(([, n], i) => i === 0 || entries[i - 1][1] > n), "entry numbers descending");
    await click('[data-action="fabric-x-sort"][data-sort="entryNo"]');
    assert.ok(await wait(`(window.__calls || []).some((c) => c.url.includes("sort=entryNo") && c.url.includes("dir=asc") && c.status === 200)`));
    assert.ok(await wait(`document.querySelector('[data-sort="entryNo"]')?.closest("th")?.getAttribute("aria-sort") === "ascending"`));
    assert.equal((await calls()).filter((c) => c.status === 400).length, 0, "the server refused nothing");
    await click('[data-action="fabric-x-clear"][data-focus-key="clear-top"]');
    assert.ok(await wait("document.querySelectorAll('.fabric-explorer-table tbody tr').length === 100"));

    // Next page (cursor), then Previous.
    const firstRow = await text(".fabric-explorer-table tbody tr");
    await click('[data-action="fabric-x-page"][data-dir="next"]');
    assert.ok(await wait(`(window.__calls || []).some((c) => c.url.includes("/inventory/records?") && c.url.includes("cursor="))`), "cursor sent");
    assert.ok(await wait(`/Rows 101/.test(document.querySelector(".fabric-pager")?.textContent || "")`), "rows 101–200");
    assert.notEqual(await text(".fabric-explorer-table tbody tr"), firstRow);
    await click('[data-action="fabric-x-page"][data-dir="prev"]');
    assert.ok(await wait(`/Rows 1–100/.test(document.querySelector(".fabric-pager")?.textContent || "")`));
    // A cursor the server no longer accepts (400): back to the first page with a note, not an error.
    await b.evaluate("window.__staleCursor = true");
    await click('[data-action="fabric-x-page"][data-dir="next"]');
    assert.ok(await wait(`(window.__calls || []).some((c) => c.url.includes("cursor=eyJiIjoic3RhbGUi") && c.status === 400)`), "the stale cursor is refused");
    assert.ok(await wait(`!!document.querySelector(".fabric-notice") && /Rows 1–100/.test(document.querySelector(".fabric-pager")?.textContent || "")`), "first page again, with a note");
    assert.equal(await has("#fabric-root .fabric-alert"), false, "no error panel");
    assert.equal(await rowCount(), 100);

    // Refresh: asks again (status and records).
    const before = (await calls()).length;
    await click('[data-action="fabric-refresh"]');
    assert.ok(await wait(`(() => { const c = (window.__calls || []).slice(${before}); return c.some((x) => x.url === "/api/v1/fabric/status") && c.some((x) => x.url.includes("/inventory/records?")); })()`), "Refresh re-requests");
    assert.ok(await wait("document.querySelectorAll('.fabric-explorer-table tbody tr').length === 100"));

    // Record page.
    const id = await b.evaluate(`document.querySelector(".fabric-explorer-table a.fabric-link").dataset.id`);
    await click(".fabric-explorer-table a.fabric-link");
    assert.ok(await wait(`document.querySelectorAll("#fabric-inventory-field-rows tr").length > 0`), "record fields");
    assert.equal(await b.evaluate("location.pathname"), `/fabric/inventory/records/${id}`);
    const fields = await json(`[...document.querySelectorAll("#fabric-inventory-field-rows tr td:first-child code")].map((c) => c.textContent)`);
    assert.equal(fields.length, 78);
    assert.equal(fields[0], "Entry_No");
    for (const f of SENSITIVE_INV) assert.ok(!fields.includes(f), f);
    assert.ok(!fields.includes("upstream_new_field"));
    assert.match(await text(".fabric-record-key"), /Company/);
    assert.match(await text(".fabric-record-key"), /Entry_No/);
    await noErrors("inventory");
  });

  test("2b. a sensitive reader can choose the sensitive inventory columns and sees them on the record page", async () => {
    await signIn(people.sensitive);
    await openInventoryList();
    await click('[data-action="fabric-x-columns"][data-focus-key="cols"]');
    assert.ok(await wait("!!document.querySelector('#fabric-inventory-chooser')"));
    const chooser = await json(`[...document.querySelectorAll("#fabric-inventory-col-list input")].map((i) => i.dataset.name)`);
    assert.equal(chooser.length, 87);
    for (const f of SENSITIVE_INV) assert.ok(chooser.includes(f), f);
    await setValue('#fabric-inventory-col-list input[data-name="Cost_Amount_Actual"]', true);
    assert.ok(await wait(`(window.__calls || []).some((c) => c.url.includes("/inventory/records?") && c.url.includes("Cost_Amount_Actual") && c.status === 200)`), "sensitive field requested and allowed");
    assert.ok(await wait(`[...document.querySelectorAll(".fabric-explorer-table thead th")].some((th) => /Cost_Amount_Actual/.test(th.textContent) && th.querySelector(".fabric-sensitive"))`), "column shown with its Sensitive badge");
    await click(".fabric-explorer-table a.fabric-link");
    assert.ok(await wait(`document.querySelectorAll("#fabric-inventory-field-rows tr").length === 87`), "every field incl. sensitive");
    assert.match(await text("#fabric-inventory-field-rows"), /Cost_Amount_Actual/);
    // Clean up the choice for the next person in this browser.
    await b.evaluate(`localStorage.removeItem("jarc.fabric.columns.inventory")`);
    await noErrors("sensitive inventory");
  });

  test("3. Sales: the index-required banner without the index; with it, rows and the server's default window", async () => {
    await signIn(people.reader);
    await openApp("/fabric/sales");
    assert.ok(await wait("!!document.querySelector('#fabric-root .fabric-alert.is-index')", 15000), "index-required alert");
    assert.match(await text("#fabric-root"), /Waiting for indexes/);
    assert.match(await text("#fabric-root"), /fabric_invoice_date/, "the recommended index is named");
    assert.equal(await has(".fabric-explorer-table"), false);
    assert.equal((await calls()).filter((c) => c.url.includes("/sales/records")).length, 0, "no records request is sent");
    await noErrors("sales index required");

    fabricClient.store.indexes = DEFAULT_INDEXES.map((i) => ({ ...i }));
    // The dataset's cached date bounds (60 s, src/fabric/source.js) were read while there was no index (both null), and a status
    // check refreshes only the index info, so for up to a minute the default window would end today instead of at the latest
    // date (reported to the backend). Dropped here so the test needn't wait a minute.
    stack.sources.sales.invalidate({ bounds: true });
    try {
      await openApp("/fabric/sales");
      assert.ok(await wait("document.querySelectorAll('.fabric-explorer-table tbody tr').length > 0", 15000), "sales rows");
      assert.equal(await has("#fabric-root .fabric-alert.is-index"), false);
      const last = await lastRecords("sales");
      assert.ok(await wait(`(window.__calls || []).some((c) => c.url.includes("/sales/records?") && c.window)`));
      const { window: w } = await lastRecords("sales");
      assert.deepEqual(w, { field: "invoice_date", dateFrom: "2026-03-02", dateTo: "2026-03-31", defaulted: true }, "30 days ending at the latest date");
      assert.ok(!new URLSearchParams(last.url.split("?")[1]).has("dateFrom"), "the browser leaves the window to the server");
      assert.equal(await b.evaluate(`document.querySelector("#fabric-sales-from").value`), w.dateFrom);
      assert.equal(await b.evaluate(`document.querySelector("#fabric-sales-to").value`), w.dateTo);
      assert.match(ascii(await text(".fabric-window")), /Mar 2, 2026 - Mar 31, 2026/);
      assert.deepEqual(await headers(), ["invoice_date", "Company", "invoice_id", "customer_name", "invoice_item_name", "invoice_item_quantity", "invoice_item_amount", "sales_data_source"]);
      assert.match(await text("#fabric-root .fabric-help"), /Up to 92 days/);
      await noErrors("sales indexed");
    } finally { /* the index stays for the deep-link test */ }
  });

  test("4. API Management: only for the Fabric API administrator; create Sales-only, see the secret once, list, revoke", async () => {
    await signIn(people.reader);
    await openApp("/fabric/inventory");
    assert.ok(await wait("!!document.querySelector('#fabric-tab-inventory')"));
    assert.equal(await has("#fabric-tab-api"), false, "no API Management tab for a reader");
    await openApp("/fabric/api");
    assert.ok(await wait("!!document.querySelector('#fabric-tab-inventory.active')"), "/fabric/api falls back to a dataset tab");
    assert.equal(await has("#fabric-api-body"), false);

    await signIn(people.admin);
    await openApp("/fabric/api");
    assert.ok(await wait("!!document.querySelector('#fabric-tab-api.active') && !!document.querySelector('[data-action=\"fabric-api-new\"]')", 15000), "API Management");
    await click('[data-action="fabric-api-new"]');
    assert.ok(await wait("!!document.querySelector('form[data-action=\"fabric-api-create-form\"]')"));
    await setValue('form[data-action="fabric-api-create-form"] input[name="name"]', "Synthetic BI", "input");
    await setValue('form[data-action="fabric-api-create-form"] input[name="ds-inventory"]', false);
    assert.equal(await b.evaluate(`document.querySelector('form[data-action="fabric-api-create-form"] input[name="ds-sales"]').checked`), true);
    assert.ok(await has('form[data-action="fabric-api-create-form"] input[name="sensitive"]'), "a sensitive admin may grant sensitive fields");
    await b.evaluate(`document.querySelector('form[data-action="fabric-api-create-form"]').requestSubmit()`);
    assert.ok(await wait("!!document.querySelector('#fabric-api-secret')?.value"), "secret shown");
    const secret = await b.evaluate(`document.querySelector('#fabric-api-secret').value`);
    assert.ok(secret.length > 20);
    assert.match(await text(".apitok-modal"), /won't see it again/);
    assert.match(await text(".apikey-review"), /Sales/);
    assert.doesNotMatch(await text(".apikey-review"), /Inventory/);
    // The token reads Sales, not Inventory (the external API, no cookie).
    const ext = JSON.parse(await b.evaluate(`(async () => JSON.stringify(await Promise.all(["/sales/schema", "/inventory/schema"].map(async (p) => { const r = await fetch("/api/v1/external/fabric" + p, { credentials: "omit", headers: { Authorization: "Bearer ${secret}" } }); return [r.status, (await r.json()).error?.code || null]; }))))()`));
    assert.deepEqual(ext, [[200, null], [403, "INSUFFICIENT_SCOPE"]]);
    assert.ok(!JSON.stringify(await json("[Object.entries(localStorage), Object.entries(sessionStorage)]")).includes(secret), "never stored");
    await click('[data-action="fabric-api-done"]');
    assert.ok(await wait("!!document.querySelector('.fabric-api-tokens tbody tr')"), "token listed");
    assert.ok(!(await b.evaluate("document.documentElement.outerHTML")).includes(secret), "gone from the page");
    const listed = await text(".fabric-api-tokens tbody tr");
    assert.match(listed, /Synthetic BI/);
    assert.match(listed, /Sales/);
    assert.doesNotMatch(listed, /Inventory/);
    assert.match(listed, /Active/);
    await click('.fabric-api-tokens [data-action="fabric-api-revoke"]');
    assert.ok(await wait("!!document.querySelector('form[data-action=\"fabric-api-revoke-form\"]')"));
    await b.evaluate(`document.querySelector('form[data-action="fabric-api-revoke-form"]').requestSubmit()`);
    assert.ok(await wait(`/Revoked/.test(document.querySelector(".fabric-api-tokens tbody tr")?.textContent || "")`), "revoked");
    assert.equal(await has('.fabric-api-tokens [data-action="fabric-api-revoke"]'), false);
    const after = await b.evaluate(`fetch("/api/v1/external/fabric/sales/schema", { credentials: "omit", headers: { Authorization: "Bearer ${secret}" } }).then((r) => r.status)`);
    assert.equal(after, 401, "a revoked token stops working");
    await noErrors("api management");
  });

  test("5. deep links load directly; Back and Forward move between list and record", async () => {
    await signIn(people.reader);
    await openInventoryList("/fabric/inventory");
    assert.match(await text(".fabric-head h1"), /Inventory/);
    // A sales record link, opened directly.
    await openApp("/fabric/sales");
    assert.ok(await wait("document.querySelectorAll('.fabric-explorer-table tbody tr').length > 0", 15000));
    const id = await b.evaluate(`document.querySelector(".fabric-explorer-table a.fabric-link").dataset.id`);
    await openApp(`/fabric/sales/records/${id}`);
    assert.ok(await wait(`document.querySelectorAll("#fabric-sales-field-rows tr").length > 0`, 15000), "sales record loads directly");
    const fields = await json(`[...document.querySelectorAll("#fabric-sales-field-rows tr td:first-child code")].map((c) => c.textContent)`);
    assert.equal(fields.length, 80, "85 sales fields minus the 5 restricted ones");
    for (const f of ["landed_cost", "Text", "Custom", "custom_1", "Custom.2"]) assert.ok(!fields.includes(f), f);
    assert.match(await text(".fabric-record-key"), /invoice_id/);
    assert.equal(await b.evaluate("location.pathname"), `/fabric/sales/records/${id}`);
    assert.ok((await calls()).some((c) => c.url === `/api/v1/fabric/sales/records/${id}` && c.status === 200));
    // Back from a record to the list, then Forward.
    await click('.fabric-breadcrumb a[data-action="fabric-x-back"]');
    assert.ok(await wait(`location.pathname === "/fabric/sales" && document.querySelectorAll('.fabric-explorer-table tbody tr').length > 0`), "back to the list");
    await click(".fabric-explorer-table a.fabric-link");
    assert.ok(await wait(`/^\\/fabric\\/sales\\/records\\//.test(location.pathname) && document.querySelectorAll("#fabric-sales-field-rows tr").length > 0`));
    await b.evaluate("history.back()");
    assert.ok(await wait(`location.pathname === "/fabric/sales" && document.querySelectorAll('.fabric-explorer-table tbody tr').length > 0 && !document.querySelector("#fabric-sales-field-rows")`), "Back shows the list");
    await b.evaluate("history.forward()");
    assert.ok(await wait(`/^\\/fabric\\/sales\\/records\\//.test(location.pathname) && document.querySelectorAll("#fabric-sales-field-rows tr").length > 0`), "Forward shows the record again");
    // Switching tabs, then Back.
    await click("#fabric-tab-inventory");
    assert.ok(await wait(`location.pathname === "/fabric/inventory" && document.querySelectorAll('.fabric-explorer-table tbody tr').length > 0`));
    await b.evaluate("history.back()");
    assert.ok(await wait(`/^\\/fabric\\/sales\\/records\\//.test(location.pathname) && document.querySelectorAll("#fabric-sales-field-rows tr").length > 0`), "Back returns to the sales record");
    await noErrors("deep links");
  });

  test("6. dark theme: the explorer renders with dark surfaces and light text; no console errors", async () => {
    await signIn(people.reader);
    await openInventoryList();
    await b.evaluate(`document.documentElement.dataset.theme = "dark"`);
    await b.waitFor("false", 200);
    const colors = await json(`(() => { const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; }; const td = document.querySelector(".fabric-explorer-table tbody td"); const s = getComputedStyle(td); let el = td, bg = "rgba(0, 0, 0, 0)"; while (el && /rgba\\(0, 0, 0, 0\\)|transparent/.test(bg)) { bg = getComputedStyle(el).backgroundColor; el = el.parentElement; } return { text: lum(s.color), bg: lum(bg), body: lum(getComputedStyle(document.body).backgroundColor) }; })()`);
    assert.ok(colors.text > 0.6, `light text (${colors.text})`);
    assert.ok(colors.bg < 0.4, `dark surface (${colors.bg})`);
    assert.ok(colors.body < 0.4, `dark page (${colors.body})`);
    assert.ok(colors.text - colors.bg > 0.4, "readable contrast");
    const widths = await json(`({ page: document.documentElement.scrollWidth, view: window.innerWidth, wide: [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest(".fabric-scroll")).slice(0, 5).map((el) => el.tagName + "." + el.className), chain: (() => { const out = []; let el = document.querySelector(".fabric-banner"); while (el && el !== document.body) { const r = el.getBoundingClientRect(); out.push(el.tagName + "." + String(el.className).slice(0, 30) + ":" + Math.round(r.left) + "-" + Math.round(r.right) + " sw" + el.scrollWidth); el = el.parentElement; } return out; })() })`);
    assert.ok(widths.page <= widths.view, `no sideways scroll: ${JSON.stringify(widths)}`);
    await noErrors("dark theme");
  });
});
