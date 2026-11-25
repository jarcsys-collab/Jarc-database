// Fabric Data Phase 7: the filter builder's layout in a real headless browser (Chrome/Edge) with the real stylesheets, at phone,
// tablet and desktop widths: it stays inside the viewport (a full-screen drawer on phones), Apply/Cancel stay reachable, the
// page never scrolls sideways, the grid is not shrunk while the builder is open, and inputs use 16px text on touch widths.
// The markup is the explorer's own (rendered in a vm with synthetic data). Skipped when no Chrome or Edge is installed.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const { findBrowser, launch } = require("./support/headless-browser");
const server = require("../src/fabric/filter-model");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
const BROWSER = findBrowser();
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function explorerMarkup(open) {
  const window = { location: { pathname: "/fabric/sales", search: "" }, history: { replaceState() {}, pushState() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, addEventListener() {}, dispatchEvent() {} };
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } } };
  const context = vm.createContext({ window, document, console, Intl, Date, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, CSS: { escape: (v) => v } });
  for (const f of ["AppView.js", "EntraAuth.js", "FabricFilterModel.js", "FabricFilterBuilder.js", "FabricExplorer.js", "FabricDataPanel.js"]) vm.runInContext(read(f), context, { filename: f });
  const ops = (k) => server.BY_KIND[k].map((op) => ({ op, class: "bounded" }));
  const fields = [["invoice_date", "date"], ["Company", "category"], ["invoice_id", "text"], ["customer_name", "text"], ["invoice_item_quantity", "number"], ["sales_type", "category"], ["Ship_to_Name", "text"], ["invoice_item_amount", "number"]].map(([name, kind]) => ({ name, type: kind === "number" ? "decimal" : kind === "date" ? "date" : "string", kind, operators: ops(kind), orderable: true }));
  const schema = { dataset: "sales", label: "Sales", fields, filters: [], sorts: [{ name: "date", field: "invoice_date", keys: ["invoice_date", "_id"], default: true }], defaultColumns: fields.map((f) => f.name), dateField: "invoice_date", filterModel: { version: 1 }, dateWindow: { field: "invoice_date", required: true, defaultDays: 30, maxDays: 92 } };
  const items = Array.from({ length: 30 }, (_, i) => ({ id: i.toString(16).padStart(24, "0"), values: { invoice_date: "2026-03-01T00:00:00.000Z", Company: `Synthetic Co ${i % 3}`, invoice_id: `INV-${1000 + i}`, customer_name: `Synthetic customer with a long name ${i}`, invoice_item_quantity: String(i), sales_type: "Item", Ship_to_Name: "Synthetic site", invoice_item_amount: "12.50" } }));
  const answers = { "/fabric/status": { available: true, datasets: { sales: { mode: "indexed" } }, access: { datasets: ["sales"] } }, "/fabric/sales/schema": schema, "/fabric/sales/records": { items, pagination: { hasMore: true, nextCursor: "c" }, window: { dateFrom: "2026-03-02", dateTo: "2026-03-31" } } };
  const adapter = { mode: "resource", async request(m, p) { const hit = Object.entries(answers).find(([k]) => p === k || p.startsWith(`${k}?`)); return hit[1]; } };
  const AppView = context.window.AppView || vm.runInContext("AppView", context), FabricDataPanel = vm.runInContext("FabricDataPanel", context);
  const view = new AppView({ innerHTML: "" });
  const controller = { model: { features: { fabricData: { read: true } }, storage: { adapter }, screen: "fabric" }, view, update() {}, syncBoardUrl() {} };
  const panel = new FabricDataPanel(controller); view.fabricPanel = panel;
  panel.applyRoute({ view: "sales", query: vm.runInContext("FabricExplorer", context).parseQuery("") });
  panel.ensure(); await settle(20);
  const x = panel.explorers.sales;
  if (open) {
    x.openFilterFor("Company", { op: "in", values: ["Synthetic Co 1", "Synthetic Co 2"] });
    x.fb.draft.items.push({ op: "or", items: [{ field: "customer_name", op: "contains", value: "synthetic" }, { field: "invoice_item_quantity", op: "between", value: "1", to: "10" }] });
    x.fb.draft.items.push({ field: "invoice_date", op: "lastN", n: 7, unit: "days" });
  }
  return x.html();
}

describe("Filter builder layout (headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let browser, dir;
  const pages = {};
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarc-fb-layout-"));
    const base = "file:///" + ASSETS.split(path.sep).join("/");
    const css = ["styles.css", "ui-foundation.css", "design-system.css", "fabric-ui.css", "fabric-explorer.css", "fabric-filter.css", "fabric-data.css"].map((f) => `<link rel="stylesheet" href="${base}/${f}">`).join("");
    for (const [name, open, theme] of [["closed", false, "light"], ["open", true, "light"], ["open-dark", true, "dark"]]) {
      const file = path.join(dir, `${name}.html`);
      fs.writeFileSync(file, `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css}<style>html,body{margin:0;height:100%}</style></head><body><div class="fx-app" style="height:100vh;display:flex;flex-direction:column"><div class="fx-app__body" id="fabric-root" style="flex:1 1 auto;min-height:0;display:flex;flex-direction:column">${await explorerMarkup(open)}</div></div></body></html>`);
      pages[name] = file;
    }
    browser = await launch(BROWSER);
  });
  after(async () => { await browser?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  const rect = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) }; })()`;
  const inView = async (sel, label) => {
    const r = JSON.parse(JSON.stringify(await browser.evaluate(rect(sel))));
    const vw = await browser.evaluate("document.documentElement.clientWidth"), vh = await browser.evaluate("window.innerHeight");
    assert.ok(r, `${label}: ${sel} drawn`);
    assert.ok(r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= vh + 1, `${label}: ${sel} inside the viewport ${JSON.stringify(r)} vs ${vw}×${vh}`);
    return r;
  };

  test("inside the viewport at 320–1920 px, Apply and Cancel reachable, no sideways page scroll (light and dark)", async () => {
    for (const name of ["open", "open-dark"]) {
      for (const [width, height] of [[320, 640], [375, 700], [768, 900], [1024, 768], [1440, 900], [1920, 1080]]) {
        await browser.open(pages[name], { width, height });
        const label = `${name} @ ${width}px`;
        assert.equal(await browser.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0, `${label}: page scrolls sideways`);
        const fb = await inView("#fabric-sales-fb", label);
        await inView('[data-action="fabric-f-apply"]', label); await inView('[data-action="fabric-f-cancel"][data-focus-key="fb-cancel"]', label);
        if (width <= 620) assert.ok(fb.width >= width - 1, `${label}: a full-width drawer on phones`);
        else assert.ok(fb.width <= 722, `${label}: a compact popover`);
      }
    }
  });

  test("the grid keeps its size while the builder is open (the popover overlays it)", async () => {
    for (const width of [768, 1440]) {
      await browser.open(pages.closed, { width, height: 900 });
      const closed = JSON.parse(JSON.stringify(await browser.evaluate(rect('[data-grid="sales"]'))));
      await browser.open(pages.open, { width, height: 900 });
      const open = JSON.parse(JSON.stringify(await browser.evaluate(rect('[data-grid="sales"]'))));
      assert.equal(open.width, closed.width, `@ ${width}px: same grid width`);
      assert.ok(Math.abs(open.top - closed.top) <= 1, `@ ${width}px: the grid doesn't move down (${closed.top} → ${open.top})`);
    }
  });

  test("touch widths: inputs and selects in the builder use 16px text; desktop stays compact", async () => {
    await browser.open(pages.open, { width: 375, height: 700 });
    const sizes = await browser.evaluate(`[...document.querySelectorAll("#fabric-sales-fb input, #fabric-sales-fb select")].map((el) => getComputedStyle(el).fontSize)`);
    assert.ok(sizes.length > 4 && sizes.every((s) => s === "16px"), JSON.stringify(sizes));
    await browser.open(pages.open, { width: 1440, height: 900 });
    const desk = await browser.evaluate(`getComputedStyle(document.querySelector("#fabric-sales-fb select")).fontSize`);
    assert.notEqual(desk, "16px");
  });
});
