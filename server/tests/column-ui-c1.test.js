// Column System C1 in Node (no browser, no server): the unchanged browser files (ColumnTypes, AppView, ColumnPicker,
// ColumnMenu, ColumnSettings) in a vm context with synthetic boards. Who sees what in the header menu (VIEWER, MEMBER,
// WORKSPACE_ADMIN, local storage, a synced read-only board), how each item's scope is labelled (Main Table, personal view,
// shared view), what the picker offers (Connect / Mirror, Files, Group), Recent with blocked storage, default names, the
// settings panel's sections, and escaping. Synthetic values only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (file) => fs.readFileSync(path.join(ASSETS, file), "utf8");

function load({ localStorage = null } = {}) {
  const overlay = { innerHTML: "", querySelector: () => null };
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: (sel) => (sel === "#overlay-root" ? overlay : null), body: { classList: { add() {}, remove() {}, contains: () => false } } };
  const context = vm.createContext({ document, console, Intl, Date, URL, encodeURIComponent, JSON, Map, Set });
  context.window = context;
  context.localStorage = localStorage;
  for (const file of ["ColumnTypes.js", "AppView.js", "IconLibrary.js", "ColumnPicker.js", "ColumnMenu.js", "ColumnSettings.js"]) vm.runInContext(read(file), context, { filename: file });
  const view = new context.AppView({ innerHTML: "" });
  return { context, view, overlay };
}
const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const TYPES = ["text", "number", "status", "dropdown", "checkbox", "priority", "owner", "date", "email", "phone", "link", "group", "files", "connect", "mirror"];
function model({ role = "WORKSPACE_ADMIN", view = null, readOnly = false, relations = false, files = true, columns = null } = {}) {
  const cols = columns || [
    { key: "serial", label: "Item", type: "text", required: true },
    { key: "status", label: "Status", type: "status", options: ["To do", "Done"] },
    { key: "amount", label: "Amount <b>", type: "text" },
    { key: "qty", label: "Qty", type: "number", defaultValue: "" },
    { key: "tags", label: "Tags", type: "dropdown", multiple: true, options: ["A", "B"] }
  ];
  return {
    me: "user:0123456789abcdef01234567", profile: {}, settings: { stickyFirstColumn: false },
    workspace: role ? { role } : {}, board: { columns: cols, groups: ["New", "Done"], source: readOnly ? { readOnly: true } : null, savedViews: view ? [view] : [] },
    activeView: view, rows: [], sortKey: "", manualSort: false, columnFilter: null, groupBy: "", relationsAvailable: relations,
    columnTypes: TYPES.map((type) => ({ type, label: type })), columnType(t) { return this.columnTypes.find((x) => x.type === t); },
    get orderedColumns() { return this.board.columns; },
    get groupByColumns() { return this.board.columns.filter((c) => ["status", "priority", "owner", "checkbox"].includes(c.type) || (c.type === "dropdown" && !c.multiple)); },
    filesAvailable: () => files, effectiveOptions: (c) => [...(c.options || [])], valueList: (v) => (Array.isArray(v) ? v : v ? [v] : []), optionColor: () => "",
    uniqueColumnLabel(base) { const used = new Set(this.board.columns.map((c) => c.label.toLowerCase())); let l = base, n = 2; while (used.has(l.toLowerCase())) l = `${base} ${n++}`; return l; }
  };
}
// The menu's data-actions, grouped by the scope label above them.
function menu(view, m, key) {
  const html = view.columnMenu.html(m, key), out = {};
  let scope = "(none)";
  for (const part of html.split(/(?=<div class="menu-section-label)|(?=<button )/)) {
    const label = part.match(/^<div class="menu-section-label[^"]*"[^>]*><span>([^<]*)<\/span>/);
    if (label) { scope = label[1]; continue; }
    const action = part.match(/^<button [^>]*data-action="([^"]+)"/);
    if (action) (out[scope] ||= []).push(action[1]);
  }
  return { html, out };
}

describe("Header menu: permissions follow the server's roles", () => {
  const BOARD = "Everyone on this board";
  test("workspace admin (and shared access): every board item, Change type and Delete", () => {
    const { view } = load();
    const { out } = menu(view, model(), "amount");
    for (const a of ["rename-column", "edit-column-description", "column-settings", "change-column-type", "add-column-right", "duplicate-column", "hide-column", "move-column-menu", "column-width", "request-delete-column"]) assert.ok(out[BOARD].includes(a), a);
    assert.deepEqual([...new Set(out["Only you"])], ["sort-column", "filter-column"]);
  });
  test("member: schema edits, but no Change type and no Delete (WORKSPACE_ADMIN routes)", () => {
    const { view } = load();
    const { out } = menu(view, model({ role: "MEMBER" }), "amount");
    assert.ok(out[BOARD].includes("rename-column") && out[BOARD].includes("column-settings") && out[BOARD].includes("add-column-right"));
    assert.ok(!out[BOARD].includes("change-column-type") && !out[BOARD].includes("request-delete-column"));
  });
  test("viewer: view items only, a note, and no + header button", () => {
    const { view } = load();
    const m = model({ role: "VIEWER" }), { out, html } = menu(view, m, "status");
    assert.equal(out[BOARD], undefined);
    assert.deepEqual([...new Set(out["Only you"])], ["sort-column", "filter-column", "column-group-by"]);
    assert.match(html, /Changes to its columns need an editor/);
    assert.equal(view.addColumnHeader(m), '<th class="add-column-col" aria-hidden="true"></th>');
  });
  test("a synced (read-only) board: view items only, said so; local storage (no role): everything", () => {
    const { view } = load();
    const { out, html } = menu(view, model({ readOnly: true }), "amount");
    assert.equal(out[BOARD], undefined); assert.match(html, /synced and read-only/);
    const local = menu(view, model({ role: null }), "amount").out;
    assert.ok(local[BOARD].includes("change-column-type") && local[BOARD].includes("request-delete-column"));
    const system = menu(view, model({ role: "SYSTEM_ADMIN" }), "amount").out;
    assert.ok(system[BOARD].includes("change-column-type") && system[BOARD].includes("request-delete-column"), "system admin (server rank 4)");
  });
  test("the primary column: no type change, duplicate or delete; it can be frozen (this person's setting)", () => {
    const { view } = load();
    const { out, html } = menu(view, model(), "serial");
    const all = Object.values(out).flat();
    for (const a of ["change-column-type", "duplicate-column", "request-delete-column"]) assert.ok(!all.includes(a), a);
    assert.ok(out["Only you"].includes("toggle-sticky-name")); assert.match(html, /Only you · every board/);
  });
  test("the + header is disabled at 200 columns, with the reason", () => {
    const { view } = load();
    const cols = Array.from({ length: 200 }, (_, i) => ({ key: i ? `c${i}` : "serial", label: `C${i}`, type: "text" }));
    assert.match(view.addColumnHeader(model({ columns: cols })), /disabled/);
    assert.match(view.addColumnHeader(model({ columns: cols })), /maximum 200 columns/);
  });
});

describe("Header menu: scope labels say who a change affects (verified against BoardModel)", () => {
  test("Main Table: sort / filter / group are only yours and not saved; hide, move and width change the board for everyone", () => {
    const { view } = load();
    const { out, html } = menu(view, model(), "status");
    assert.match(html, /<span>Only you<\/span><small>Not saved · Views keep it<\/small>/);
    for (const a of ["hide-column", "move-column-menu", "column-width"]) assert.ok(out["Everyone on this board"].includes(a), a);
  });
  test("a personal view: 'Only you · this view'; hide, move and width move to the view group", () => {
    const { view } = load();
    const { out, html } = menu(view, model({ view: { id: 1, name: "Mine", personal: true } }), "status");
    assert.match(html, /<span>Only you · this view<\/span><small>Kept when you save this view<\/small>/);
    for (const a of ["hide-column", "move-column-menu", "column-width", "sort-column", "column-group-by"]) assert.ok(out["Only you · this view"].includes(a), a);
    assert.ok(!out["Everyone on this board"].includes("hide-column"));
  });
  test("a shared view: 'This view', with who sees it once saved", () => {
    const { view } = load();
    const { out, html } = menu(view, model({ view: { id: 2, name: "Team" } }), "status");
    assert.match(html, /<span>This view<\/span><small>Everyone using it, once you save the view<\/small>/);
    assert.ok(out["This view"].includes("hide-column"));
  });
  test("Change type: only the registry's targets, never the column's own type, Files, Connect, Mirror or Group", () => {
    const { view, context } = load();
    const m = model(), page = view.columnMenu.typePage(m, "amount");
    const targets = [...page.matchAll(/data-action="choose-new-type" data-key="amount" data-type="([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(targets, [...context.ColumnTypes.conversionTargets({ key: "amount", type: "text" })]);
    assert.ok(!targets.some((t) => ["text", "files", "connect", "mirror", "group"].includes(t)));
    assert.match(page, /nothing changes until you confirm/);
    assert.equal(view.columnMenu.conversionTargets(m, { key: "f", type: "files" }).length, 0);
  });
  test("labels are escaped", () => {
    const { view } = load();
    const { html } = menu(view, model(), "amount");
    assert.ok(html.includes("Amount &lt;b&gt;") && !html.includes("Amount <b>"));
  });
});

describe("Add Column picker", () => {
  const types = (view, m) => [...view.columnPicker.html(m).matchAll(/data-type="([^"]+)"/g)].map((x) => x[1]);
  test("Connect / Mirror only with relationsAvailable (Mirror also needs a Connect column); Files only when available; one Group column", () => {
    const { view } = load({ localStorage: memory() });
    assert.ok(!types(view, model()).some((t) => t === "connect" || t === "mirror"));
    const on = types(view, model({ relations: true }));
    assert.ok(on.includes("connect") && !on.includes("mirror"));
    const withConnect = model({ relations: true }); withConnect.board.columns.push({ key: "link1", label: "Sites", type: "connect", link: { boardId: "b" } });
    assert.ok(types(view, withConnect).includes("mirror"));
    assert.ok(!types(view, model({ files: false })).includes("files"));
    const grouped = model(); grouped.board.columns.push({ key: "grp", label: "Group", type: "group" });
    assert.ok(!types(view, grouped).includes("group"));
  });
  test("search: synonyms rank the right type first, with Best match; nothing found is said plainly", () => {
    const { view } = load({ localStorage: memory() });
    const first = (q) => view.columnPicker.body(model(), q).match(/data-type="([^"]+)"/)?.[1];
    assert.equal(first("due"), "date"); assert.equal(first("price"), "number"); assert.equal(first("who"), "owner"); assert.equal(first("website"), "link");
    assert.match(view.columnPicker.body(model(), "deadline"), /Best match/);
    assert.match(view.columnPicker.body(model(), "qqqq"), /No column type matches/);
  });
  test("Recent: per person, newest first, at most 5; blocked storage hides the row and never throws", () => {
    const store = memory(), { view } = load({ localStorage: store }), m = model(), p = view.columnPicker;
    for (const id of ["text", "number", "status", "date", "email", "phone", "number"]) p.remember(m, id);
    assert.deepEqual([...p.recent(m)], ["number", "phone", "email", "date", "status"]);
    assert.deepEqual([...p.recent({ ...m, me: "user:ffffffffffffffffffffffff" })], [], "another person's list is separate");
    assert.match(p.body(m), /is-recent/);
    const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    const b = load({ localStorage: blocked }).view.columnPicker;
    assert.doesNotThrow(() => b.remember(m, "text")); assert.deepEqual([...b.recent(m)], []); assert.doesNotMatch(b.body(m), /is-recent/);
  });
  test("default names: the type's name (numbered when taken), or what was typed when it isn't a word for the type", () => {
    const { view, context } = load({ localStorage: memory() }), p = view.columnPicker, m = model();
    const name = (q, id) => { p.state = { panel: { querySelector: () => ({ value: q }) } }; return p.nameFor(m, context.ColumnTypes.get(id)); };
    assert.equal(name("", "date"), "Date");
    assert.equal(name("deadline", "date"), "Date", "a keyword for Date");
    assert.equal(name("approval stage", "status"), "Approval stage");
    assert.equal(name("", "status"), "Status 2", "Status is taken");
  });
});

describe("Settings panel", () => {
  test("a Number column: details and a numeric default value; no labels; no new stored settings (no number format)", () => {
    const { view } = load();
    const html = view.columnSettings.html(model(), "qty");
    assert.match(html, /data-action="column-settings-form"/); assert.match(html, /name="defaultValue" type="number"/);
    assert.doesNotMatch(html, /option-editor/); assert.doesNotMatch(html, /numberFormat|decimal|currency/i);
    assert.match(html, /Everyone on this board/);
  });
  test("Status: the existing labels editor (column-options-form) and no default value; Dropdown: the one/several switch", () => {
    const { view } = load();
    const status = view.columnSettings.html(model(), "status");
    assert.match(status, /class="column-settings-section option-editor" data-action="column-options-form"/);
    assert.doesNotMatch(status, /name="defaultValue"/);
    assert.ok(view.columnSettings.html(model(), "status", { section: "labels" }).indexOf("option-editor") < view.columnSettings.html(model(), "status", { section: "labels" }).indexOf("column-settings-form"), "labels first when opened from Edit labels");
    assert.match(view.columnSettings.html(model(), "tags"), /data-action="toggle-column-multiple" data-key="tags">Allow one value only/);
  });
  test("a viewer sees no forms", () => {
    const { view } = load();
    const html = view.columnSettings.html(model({ role: "VIEWER" }), "qty");
    assert.doesNotMatch(html, /<form/); assert.match(html, /needs an editor/);
  });
});
