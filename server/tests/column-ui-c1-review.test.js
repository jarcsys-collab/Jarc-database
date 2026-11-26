// Independent review checks for Column C1 (synthetic data only). Part 1 runs the browser files in a vm (no server); part 2
// runs the real app in a headless browser against the Entra test server (fake MongoDB), skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (file) => fs.readFileSync(path.join(ASSETS, file), "utf8");
function load() {
  const overlay = { innerHTML: "", querySelector: () => null };
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: (sel) => (sel === "#overlay-root" ? overlay : null), body: { classList: { add() {}, remove() {}, contains: () => false } } };
  const context = vm.createContext({ document, console, Intl, Date, URL, encodeURIComponent, JSON, Map, Set });
  context.window = context; context.localStorage = null;
  for (const file of ["ColumnTypes.js", "AppView.js", "IconLibrary.js", "ColumnPicker.js", "ColumnMenu.js", "ColumnSettings.js"]) vm.runInContext(read(file), context, { filename: file });
  return { context, view: new context.AppView({ innerHTML: "" }) };
}
const TYPES = ["text", "number", "status", "dropdown", "checkbox", "priority", "owner", "date", "email", "phone", "link", "group", "files", "connect", "mirror"];
function model({ role = "MEMBER", columns = COLS } = {}) {
  return {
    me: "user:0123456789abcdef01234567", profile: {}, settings: {}, workspace: { role },
    board: { columns, groups: ["New"], source: null, savedViews: [] }, activeView: null, rows: [], sortKey: "", manualSort: false, columnFilter: null, groupBy: "", relationsAvailable: false,
    columnTypes: TYPES.map((type) => ({ type, label: type })), columnType(t) { return this.columnTypes.find((x) => x.type === t); },
    get orderedColumns() { return this.board.columns; }, get groupByColumns() { return []; },
    filesAvailable: () => true, effectiveOptions: (c) => [...(c.options || [])], valueList: (v) => (Array.isArray(v) ? v : v ? [v] : []), optionColor: () => "",
    uniqueColumnLabel(b) { return b; }
  };
}
const COLS = [{ key: "serial", label: "Item", type: "text" }, { key: "tags", label: "Tags", type: "dropdown", multiple: false, options: ["A"] }];

describe("review: permissions and escaping (vm)", () => {
  // POST /boards/:id/columns/:key/type (which setColumnMultiple uses) needs WORKSPACE_ADMIN (routes/resources.js).
  test("a MEMBER is not offered the Dropdown one/several switch (server: WORKSPACE_ADMIN)", () => {
    const { view } = load();
    assert.doesNotMatch(view.columnMenu.html(model(), "tags"), /data-action="toggle-column-multiple"/, "header menu");
    assert.doesNotMatch(view.columnSettings.html(model(), "tags"), /data-action="toggle-column-multiple"/, "settings panel");
  });
  test("search text, column names and descriptions are escaped in every new template", () => {
    const { view } = load();
    const evil = `"><img src=x onerror=alert(1)><textarea>`;
    const cols = [{ key: "serial", label: evil, type: "text", description: `</textarea><script>x</script>` }, { key: "s", label: evil, type: "status", options: [evil] }];
    const m = model({ role: "WORKSPACE_ADMIN", columns: cols });
    const html = [view.columnPicker.html(m, { insertAfter: "s", query: evil }), view.columnPicker.body(m, evil), view.columnMenu.html(m, "serial"), view.columnMenu.html(m, "s"), view.columnMenu.typePage(m, "s"), view.columnSettings.html(m, "serial"), view.columnSettings.html(m, "s", { section: "labels" })].join("");
    assert.doesNotMatch(html, /<img|<script|<textarea>|<\/textarea><script/);
  });
});

const BROWSER = findBrowser();
const OID = "0a0a0a0a-0000-4000-8000-0000000000c2";
describe("review: Add column to the right is stored at that position (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, board;
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "nearest", inline: "nearest" }); el.click(); return true; })()`);
  const saved = () => b.waitFor("!document.querySelector('.save-state')?.textContent.includes('Saving')", 6000).then(() => sleep(600));
  before(async () => {
    let port; do { port = await freePort(); } while ([4527, 9361, 9362, 9339].includes(port));
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER);
    await b.open(`${base}/api/v1/health`, { width: 1440 });
    await b.evaluate(`(async () => { const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${OID}&name=Review%20User&email=review.c1@example.invalid&nonce=" + start.nonce)).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); })()`);
    const ws = (await api("POST", "/workspaces", { name: "Review" })).body.workspace;
    board = (await api("POST", `/workspaces/${ws.id}/boards`, { name: "Placement", columns: [{ key: "serial", label: "Item", type: "text", required: true }, { key: "status", label: "Status", type: "status", options: ["A", "B"] }, { key: "notes", label: "Notes", type: "text" }, { key: "qty", label: "Qty", type: "number" }] })).body.board;
    await api("POST", `/boards/${board.id}/records`, { values: { serial: "Part 1", status: "A" } });
  });
  after(async () => { await b?.close(); server?.kill(); });

  test("Escape keeps the default name: the new column is still stored right after Status", async () => {
    await b.open(`${base}/`, { width: 1440, height: 900 });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000));
    await b.evaluate("[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes('Placement'))?.click()");
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table tbody tr td.cell')", 15000));
    await sleep(300);
    assert.ok(await click('.editable-table thead th[data-column-key="status"] .column-menu-button'));
    assert.ok(await b.waitFor("!!document.querySelector('#overlay-root .column-menu-popover')", 4000));
    await click('.column-menu-popover [data-action="add-column-right"]');
    assert.ok(await b.waitFor("!!document.querySelector('.column-picker[data-insert-after=\"status\"]')", 4000));
    await click('.column-picker-option[data-type="date"]');
    assert.ok(await b.waitFor("document.activeElement?.classList.contains('column-rename-input')", 8000));
    await b.key("Escape"); await saved();
    const shown = await b.evaluate("[...document.querySelectorAll('.editable-table thead th[data-column-key] .column-label')].map((s) => s.textContent)");
    assert.equal(shown[shown.indexOf("Status") + 1], "Date", "shown right after Status");
    const stored = (await api("GET", `/boards/${board.id}`)).body.board.columns.map((c) => c.label);
    assert.equal(stored[stored.indexOf("Status") + 1], "Date", `stored right after Status (server order: ${stored.join(", ")})`);
  });
});
