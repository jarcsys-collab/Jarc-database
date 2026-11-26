// G3 / D12 in the browser: the settings panel's Display section (shown only when the server says columnSettings), the
// AppView renderers (display text only; the cell's data-value, title and editor keep the stored value), the adapter (sends
// `settings` only to a server that keeps them) and Undo / Redo through the real model against the real resource API (fake
// MongoDB). The unchanged browser files run in a vm context. Synthetic values only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { startMongoApp, api } = require("./helpers");
const { loadBrowser } = require("./support/browser-model");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (file) => fs.readFileSync(path.join(ASSETS, file), "utf8");
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function load() {
  const overlay = { innerHTML: "", querySelector: () => null };
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: (sel) => (sel === "#overlay-root" ? overlay : null), body: { classList: { add() {}, remove() {}, contains: () => false } } };
  const context = vm.createContext({ document, console, Intl, Date, URL, encodeURIComponent, JSON, Map, Set });
  context.window = context;
  for (const file of ["ColumnTypes.js", "AppView.js", "IconLibrary.js", "ColumnPicker.js", "ColumnMenu.js", "ColumnSettings.js"]) vm.runInContext(read(file), context, { filename: file });
  return { context, view: new context.AppView({ innerHTML: "" }) };
}
const COLUMNS = () => [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "qty", label: "Qty", type: "number" },
  { key: "due", label: "Due", type: "date" },
  { key: "notes", label: "Notes", type: "text" },
  { key: "site", label: "Site", type: "link" },
  { key: "status", label: "Status", type: "status", options: ["To do", "Done"] }
];
function model({ role = "MEMBER", available = true, readOnly = false, columns = COLUMNS() } = {}) {
  return {
    me: "user:0123456789abcdef01234567", profile: {}, settings: {}, columnSettingsAvailable: available,
    workspace: role ? { role } : {}, board: { columns, groups: ["New"], source: readOnly ? { readOnly: true } : null, savedViews: [] },
    activeView: null, rows: [], columnTypes: ["text", "number", "date", "link", "status"].map((type) => ({ type, label: type })), columnType(t) { return this.columnTypes.find((x) => x.type === t); },
    effectiveOptions: (c) => [...(c.options || [])], valueList: (v) => (Array.isArray(v) ? v : v ? [v] : []), optionColor: () => "",
    hasValue: (v) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length), isMultiColumn: () => false
  };
}

describe("Settings panel: Display section", () => {
  test("shown for Number, Date, Text and Link when the server keeps settings; never for Status; never without the capability", () => {
    const { view } = load();
    const m = model();
    for (const key of ["qty", "due", "notes", "site"]) assert.match(view.columnSettings.html(m, key), /data-action="column-format-form"/, key);
    assert.doesNotMatch(view.columnSettings.html(m, "status"), /column-format-form/);
    for (const key of ["qty", "due", "notes", "site"]) assert.doesNotMatch(view.columnSettings.html(model({ available: false }), key), /column-format-form/, `${key} without the capability`);
  });
  test("the same permission as other column edits: a viewer and a read-only (synced) board see no Display section", () => {
    const { view } = load();
    assert.doesNotMatch(view.columnSettings.html(model({ role: "VIEWER" }), "qty"), /column-format-form/);
    assert.doesNotMatch(view.columnSettings.html(model({ readOnly: true }), "qty"), /column-format-form/);
    assert.match(view.columnSettings.html(model({ role: "WORKSPACE_ADMIN" }), "qty"), /column-format-form/);
  });
  test("fields per type show the stored settings; the date list is the fixed set with examples; escaping", () => {
    const { view } = load();
    const cols = COLUMNS();
    cols[1].settings = { precision: 2, prefix: "\"><b>", align: "left", thousands: false };
    cols[2].settings = { displayFormat: "dmy", weekday: true };
    cols[3].settings = { wrap: true };
    cols[4].settings = { display: "text" };
    const m = model({ columns: cols });
    const qty = view.columnSettings.html(m, "qty");
    assert.match(qty, /<option value="2" selected>2<\/option>/); assert.match(qty, /<option value="left" selected>Left/);
    assert.match(qty, /name="prefix" maxlength="8" value="&quot;&gt;&lt;b&gt;"/); assert.doesNotMatch(qty, /name="thousands" checked/);
    assert.doesNotMatch(qty, /"><b>/, "the prefix is escaped everywhere");
    const due = view.columnSettings.html(m, "due");
    assert.equal((due.match(/<option /g) || []).length, 5);
    assert.match(due, /<option value="dmy" selected>Day\/month\/year \(05\/03\/2026\)/); assert.match(due, /name="weekday" checked/);
    assert.match(view.columnSettings.html(m, "notes"), /name="wrap" checked/);
    assert.match(view.columnSettings.html(m, "site"), /<option value="text" selected>Short text/);
    assert.match(view.columnSettings.html(m, "qty", { section: "format" }).replace(/\s+/g, " "), /^.*column-format-form.*column-settings-form/, "opened at Display: that section first");
  });
  test("formatFromForm → the registry's shape (defaults dropped by cleanSettings)", () => {
    const { context } = load();
    const S = context.ColumnSettings, T = context.ColumnTypes;
    const clean = (type, data) => plain(T.cleanSettings(type, S.formatFromForm(type, data)));
    assert.deepEqual(clean("number", { precision: "3", thousands: "on", prefix: "$", suffix: "", align: "right" }), { ok: true, settings: { precision: 3, prefix: "$" } });
    assert.deepEqual(clean("number", { precision: "", align: "left" }), { ok: true, settings: { thousands: false, align: "left" } });
    assert.deepEqual(clean("date", { displayFormat: "medium" }), { ok: true, settings: null });
    assert.deepEqual(clean("text", { wrap: "on" }), { ok: true, settings: { wrap: true } });
    assert.deepEqual(clean("link", { display: "text" }), { ok: true, settings: { display: "text" } });
    assert.equal(T.cleanSettings("number", S.formatFromForm("number", { precision: "9" })).ok, false);
  });
});

describe("AppView renderers: display only", () => {
  const row = { id: "r1", qty: "1234.5678", due: "2026-03-05", notes: "A long note", site: "https://www.example.com/page/" };
  test("no settings → exactly today's cell", () => {
    const { view } = load();
    const m = model();
    for (const c of COLUMNS()) assert.equal(view.cell(row, c, m), view.cell(row, { ...c, settings: undefined }, m), c.key);
    for (const c of COLUMNS()) assert.equal(view.cell(row, c, m), view.cell(row, { ...c, settings: {} }, m), `${c.key} with {}`);
  });
  test("number: decimals, separator, prefix/suffix and alignment; data-value and title stay raw", () => {
    const { view } = load();
    const c = { key: "qty", label: "Qty", type: "number", settings: { precision: 1, thousands: false, prefix: "$", suffix: " kg", align: "left" } };
    const html = view.cell(row, c, model());
    assert.match(html, /<span class="cell-number" title="1234.5678">\$1234.6 kg<\/span>/);
    assert.match(html, /data-value="1234.5678"/);
    assert.match(html, /class="cell is-number  is-align-left"/);
  });
  test("date: the chosen format and weekday (also in the accessible name); the stored value is unchanged", () => {
    const { view } = load();
    const c = { key: "due", label: "Due", type: "date", settings: { displayFormat: "iso", weekday: true } };
    const html = view.cell(row, c, model());
    assert.match(html, /<span>Thu, 2026-03-05<\/span>/); assert.match(html, /aria-label="Due: Thu, 2026-03-05"/); assert.match(html, /data-value="2026-03-05"/);
  });
  test("text wrap is a class only; link as text keeps the real link target", () => {
    const { view } = load();
    assert.match(view.cell(row, { key: "notes", label: "Notes", type: "text", settings: { wrap: true } }, model()), /class="cell\s+is-wrap"/);
    const link = view.cell(row, { key: "site", label: "Site", type: "link", settings: { display: "text" } }, model());
    assert.match(link, /<span class="cell-text" title="https:\/\/www.example.com\/page\/">example.com\/page<\/span>/);
    assert.match(link, /href="https:\/\/www.example.com\/page\/"/);
  });
  test("an unsafe stored value is escaped in the formatted text too", () => {
    const { view } = load();
    const html = view.cell({ id: "r", site: "https://x.example/<img src=x>" }, { key: "site", label: "Site", type: "link", settings: { display: "text" } }, model());
    assert.doesNotMatch(html, /<img/);
  });
});

describe("Adapter and model: sent only to a server that keeps them; one Undo step; values never change", () => {
  let app;
  const call = (method, p, body) => api(app.url, method, `/api/v1${p}`, body);
  before(async () => { app = await startMongoApp(); });
  after(async () => { await app.close(); });
  const settle = async (m) => { await m.whenSaved(); await m.storage.queue; };
  async function tab() {
    const browser = loadBrowser();
    browser.window.ColumnTypes = require("../../site/assets/ColumnTypes.js");
    const m = browser.newResourceModel({ baseUrl: `${app.url}/api/v1` });
    await m.init(); await m.loadFeatures();
    return m;
  }

  test("columnsPayload: no settings field for an older server; null / the object for a server that keeps them", () => {
    const browser = loadBrowser();
    const adapter = new browser.window.ResourceApiAdapter({ baseUrl: "/api/v1", fetch: async () => { throw new Error("offline"); } });
    const cols = [{ key: "serial", label: "Item", type: "text" }, { key: "qty", label: "Qty", type: "number", settings: { precision: 2 } }];
    assert.ok(adapter.columnsPayload(cols).every((c) => !("settings" in c)), "unknown capability → never sent");
    adapter.columnSettings = true;
    assert.deepEqual(plain(adapter.columnsPayload(cols).map((c) => c.settings)), [null, { precision: 2 }]);
  });

  test("Display save → PATCH; Undo clears it on the server; Redo restores it; the record is never rewritten", async () => {
    const m = await tab();
    assert.equal(m.features.columnSettings, true);
    assert.equal(m.columnSettingsAvailable, true);
    assert.ok((await m.applyAfterSave(() => m.createWorkspace({ name: "G3 UI" }))).ok);
    assert.ok((await m.applyAfterSave(() => m.createBoard("G3 board", "", "blank"))).ok);
    const column = m.addColumn({ label: "Qty", type: "number" }); await settle(m);
    const created = await call("POST", `/boards/${m.board.id}/records`, { values: { serial: "R1", [column.key]: "1234.5" } });
    assert.equal(created.status, 201);
    const server = async () => (await call("GET", `/boards/${m.board.id}`)).body.board.columns.find((c) => c.key === column.key);
    assert.equal("settings" in await server(), false);
    assert.equal(plain(m.setColumnSettings(column.key, { precision: 7 })).error.includes("whole number"), true, "refused before sending");
    assert.equal(m.setColumnSettings(column.key, { precision: 2, prefix: "₱" }), true); await settle(m);
    assert.deepEqual(plain((await server()).settings), { precision: 2, prefix: "₱" });
    assert.equal(m.setColumnSettings(column.key, { precision: 2, prefix: "₱" }), false, "no change → nothing saved");
    assert.equal(m.undo(), "Column format undone"); await settle(m);
    assert.equal("settings" in await server(), false, "Undo cleared it on the server");
    m.redo(); await settle(m);
    assert.deepEqual(plain((await server()).settings), { precision: 2, prefix: "₱" });
    const record = (await call("GET", `/boards/${m.board.id}/records?limit=5`)).body.items[0];
    assert.deepEqual([record.values[column.key], record.version], ["1234.5", created.body.record.version], "the stored value and its version never changed");
  });

  test("a local type change drops what the new type doesn't define; Undo brings the settings back", async () => {
    // A fresh server, so this tab is the only writer (a second tab here would also have to load the first board's records).
    await app.close(); app = await startMongoApp();
    const m = await tab();
    assert.ok((await m.applyAfterSave(() => m.createWorkspace({ name: "G3 UI 2" }))).ok);
    const made = await m.applyAfterSave(() => m.createBoard("G3 board 2", "", "blank"));
    assert.ok(made.ok, JSON.stringify(plain(made)));
    const column = m.addColumn({ label: "Amount", type: "number" }); await settle(m);
    m.setColumnSettings(column.key, { precision: 1 }); await settle(m);
    m.changeColumnType(column.key, "text"); await settle(m);
    const server = async () => (await call("GET", `/boards/${m.board.id}`)).body.board.columns.find((c) => c.key === column.key);
    assert.equal((await server()).type, "text"); assert.equal("settings" in await server(), false);
    m.undo(); await settle(m);
    const back = await server();
    assert.deepEqual([back.type, plain(back.settings)], ["number", { precision: 1 }]);
  });
});
