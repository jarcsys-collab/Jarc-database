// Column System R0: the ColumnTypes registry (site/assets/ColumnTypes.js) describes exactly today's 15 column types and
// changes no behaviour. Parity with the server (COLUMN_TYPES, OPTION_TYPES, fallback labels, isMultiColumn, checkValue,
// both SEARCHABLE_TYPES sets, the Link / Email / Phone rules of S0-A), with the browser (BoardModel.columnTypes with and
// without the registry loaded, newColumnOptions, effectiveOptions, uniqueColumnLabel, AppView's icons) and the contract the
// Add column picker codes against. Pure and synthetic: no network, no database.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const CT = require("../../site/assets/ColumnTypes.js");
const schema = require("../src/domain/board-schema");
const { checkTyped } = require("../src/validation/record-values");
const { SEARCHABLE_TYPES: SEARCH_A } = require("../src/services/search-service");
const { SEARCHABLE_TYPES: SEARCH_B } = require("../src/services/record-search-index");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
// Values from the vm context have that realm's prototypes, so they are compared as JSON.
const same = (a, b, message) => assert.equal(JSON.stringify(a), JSON.stringify(b), message);

// The browser model in an isolated context, with or without the registry script loaded before it.
function browserModel({ withRegistry }) {
  const window = { location: { search: "" }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, dispatchEvent() {}, addEventListener() {} };
  const context = vm.createContext({ window, console, URLSearchParams, setTimeout, clearTimeout, structuredClone, CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i?.detail; } } });
  const files = [...(withRegistry ? ["ColumnTypes.js"] : []), "StorageService.js", "BoardModel.js"];
  for (const file of files) vm.runInContext(read(file), context, { filename: file });
  if (withRegistry) assert.ok(vm.runInContext("typeof ColumnTypes", context) === "object", "registry loaded as a classic script");
  const storage = new window.StorageService({ load: async () => ({}), save: async () => true });
  return { model: new window.BoardModel(storage), context };
}

describe("registry ↔ server: the same 15 types, nothing gained or lost", () => {
  test("ids() equals COLUMN_TYPES in order; get() knows exactly those", () => {
    assert.deepEqual(CT.ids(), [...schema.COLUMN_TYPES]);
    for (const id of schema.COLUMN_TYPES) assert.equal(CT.get(id)?.id, id);
    for (const id of ["long_text", "tags", "rating", "timeline", "formula", "", "constructor", "__proto__", null, undefined, 3]) assert.equal(CT.get(id), null, `unknown ${String(id)}`);
    assert.equal(CT.PICKER_ORDER.length, 15);
    assert.deepEqual([...CT.PICKER_ORDER].sort(), [...schema.COLUMN_TYPES].sort());
  });

  test("option types, fallback labels and multi-value rule match board-schema", () => {
    assert.deepEqual([...CT.OPTION_TYPES], [...schema.OPTION_TYPES]);
    assert.deepEqual(CT.ids().filter((id) => CT.get(id).options), [...schema.OPTION_TYPES]);
    for (const id of CT.ids()) assert.deepEqual(CT.fallbackOptions(id), schema.effectiveOptions({ type: id }), id);
    for (const column of [{ type: "owner" }, { type: "connect" }, { type: "dropdown", multiple: true }, { type: "dropdown" }, { type: "dropdown", multiple: false }, { type: "text", multiple: true }, { type: "status" }, { type: "mirror" }])
      assert.equal(CT.isMultiColumn(column), schema.isMultiColumn(column), JSON.stringify(column));
    assert.equal(CT.get("owner").multi, "always"); assert.equal(CT.get("connect").multi, "always"); assert.equal(CT.get("dropdown").multi, "optional");
  });

  test("searchable types equal both server SEARCHABLE_TYPES sets", () => {
    const mine = CT.ids().filter((id) => CT.get(id).searchable).sort();
    assert.deepEqual(mine, [...SEARCH_A].sort());
    assert.deepEqual(mine, [...SEARCH_B].sort());
  });

  // Each value is checked the way a write is: checkValue (throws on refusal) and then, for Link / Email / Phone, checkTyped.
  const serverAccepts = (column, value) => {
    try { schema.checkValue(column, value); } catch { return false; }
    if (["link", "email", "phone"].includes(column.type) && typeof value === "string") return !checkTyped(column.type, value).reason;
    return true;
  };
  const REF = "0123456789abcdef01234567", REF2 = "89abcdef0123456789abcdef";
  const VALUES = [
    null, "", " ", "x", "Hello", 0, 5, -1.5, NaN, Infinity, true, false, {}, [], ["a"], ["a", "a"], ["a", ""], [" "], ["a", 1], ["user:" + REF], ["user:nope"], [REF], [REF, REF2], [REF, REF], ["x".repeat(201)],
    Array.from({ length: 101 }, (_, i) => `v${i}`), "x".repeat(10001), "12", "1,234", "1e3", "0x1A", " 12 ", "abc", "2026-02-28", "2026-02-30", "2024-02-29", "2023-02-29", "03/04/2026", "2026-1-5",
    "https://example.com/a?b=1", "http://intranet:8080/x", "www.example.com", "localhost:3000", "Note: see drive", "Ref:123", "javascript:alert(1)", " JaVaScRiPt:alert(1)", "java\tscript:x", "&#106;avascript:x",
    "%6Aavascript:x", "ｊａｖａｓｃｒｉｐｔ:x", "data:text/html,x", "file:///c:/x", "mailto:a@example.com", "tel:+6321234567", "x-unknown:thing", "web+app:x", "https://", "http://[::1", "a\u200bb",
    "name@example.com", "mailto:name@example.com", "first.last+tag@sub.example.co", "info@उदाहरण.भारत", "a@b", "a@b.1", "@example.com", "a b@example.com", "a@exa_mple.com", "\"q\"@example.com", "a@example.com?x",
    "+63 2 1234 5678", "(02) 123-4567 ext. 12", "123", "12", "1".repeat(21), "+1-800-FLOWERS", "555 1234 #12", "tel:555-1234;ext=9", "x".repeat(51), "x".repeat(2049)
  ];
  const COLUMNS = [
    ...schema.COLUMN_TYPES.map((type) => ({ key: "k", label: "K", type })),
    { key: "k", label: "K", type: "dropdown", multiple: true }, { key: "k", label: "K", type: "connect", multiple: true }
  ];

  test("validate(value) agrees with the server's write rules for every type and a synthetic corpus", () => {
    let checked = 0;
    for (const column of COLUMNS) for (const value of VALUES) {
      const mine = CT.get(column.type).validate(value, column);
      assert.equal(typeof mine.ok, "boolean");
      assert.equal(mine.ok, serverAccepts(column, value), `${column.type}${column.multiple ? " (multiple)" : ""} ← ${JSON.stringify(value)?.slice(0, 60)}`);
      assert.equal(mine.ok ? mine.code : typeof mine.code, mine.ok ? null : "string");
      checked += 1;
    }
    assert.ok(checked > 1300, `${checked} checks`);
  });

  test("Link / Email / Phone: the registry's copy gives exactly the server's answer and reason (S0-A, D-S0-4)", () => {
    for (const type of ["link", "email", "phone"]) for (const value of VALUES) {
      if (typeof value !== "string" && typeof value !== "number" && value !== null) continue;
      const server = checkTyped(type, value), mine = CT.checkTyped(type, value);
      assert.equal(mine.reason ?? null, server.reason ?? null, `${type} ← ${JSON.stringify(value).slice(0, 60)}`);
      if (!server.reason) assert.deepEqual(mine.value, server.value);
      if (server.reason && typeof value === "string") assert.equal(CT.get(type).validate(value).code, server.reason);
    }
  });

  test("validate on an unknown type refuses", () => {
    assert.deepEqual(CT.validate("long_text", "x"), { ok: false, code: "unsupported" });
    assert.deepEqual(CT.validate("text", "x"), { ok: true, code: null });
  });
});

describe("registry ↔ browser: BoardModel and AppView keep today's output", () => {
  test("BoardModel.columnTypes is identical with and without the registry (and equals chooserEntries)", () => {
    const plain = browserModel({ withRegistry: false }).model, shared = browserModel({ withRegistry: true }).model;
    const json = (x) => JSON.stringify(x);
    assert.equal(json(shared.columnTypes), json(plain.columnTypes));
    assert.equal(json(CT.chooserEntries()), json(plain.columnTypes));
    same(plain.columnTypes.map((t) => t.type), [...schema.COLUMN_TYPES]);
    for (const t of plain.columnTypes) {
      const d = CT.get(t.type);
      assert.equal(d.label, t.label); assert.equal(d.description, t.description); assert.equal(d.legacyCategory, t.category);
    }
  });

  test("newColumnOptions, effectiveOptions fallbacks and uniqueColumnLabel are unchanged", () => {
    const plain = browserModel({ withRegistry: false }).model, shared = browserModel({ withRegistry: true }).model;
    for (const id of CT.ids()) {
      same(shared.newColumnOptions(id), plain.newColumnOptions(id), `new ${id}`);
      same(CT.newOptions(id), plain.newColumnOptions(id), `registry new ${id}`);
      if (id === "group") continue; // the board's own groups
      same(shared.effectiveOptions({ type: id }), plain.effectiveOptions({ type: id }), `fallback ${id}`);
      same(CT.fallbackOptions(id), plain.effectiveOptions({ type: id }), `registry fallback ${id}`);
      same(shared.effectiveOptions({ type: id, options: ["A"] }), ["A"]);
    }
    const names = ["Status", "status 2", "Number"];
    const onBoard = { board: { columns: names.map((label, i) => ({ key: `c${i}`, label, type: "text" })) } }; // `board` is a getter on the model
    for (const id of CT.ids()) assert.equal(CT.defaultName(id, names), plain.uniqueColumnLabel.call(onBoard, CT.get(id).label), id);
    assert.equal(CT.defaultName("status", names), "Status 3");
    assert.equal(CT.defaultName("date", []), "Date");
  });

  test("createPayload is what the Add column form passes to BoardModel.addColumn, and creates the same column", () => {
    for (const id of CT.ids()) {
      const p = CT.get(id).createPayload("  My column ");
      assert.equal(p.label, "My column"); assert.equal(p.type, id); assert.equal(p.options, "");
    }
    const plain = browserModel({ withRegistry: false }).model, shared = browserModel({ withRegistry: true }).model;
    const strip = (c) => { const { key, ...rest } = c; return rest; };
    for (const id of ["text", "number", "status", "dropdown", "checkbox", "priority", "owner", "date", "email", "phone", "link"]) {
      const a = plain.addColumn({ label: "Col", type: id, options: "", multiple: false }), b = shared.addColumn(CT.get(id).createPayload("Col"));
      assert.ok(a && b, id);
      same(strip(b), strip(a), id);
    }
    assert.equal(CT.get("dropdown").createPayload("x", { multiple: true }).multiple, true);
    assert.deepEqual(CT.get("connect").createPayload("x", { link: { boardId: "0123456789abcdef01234567" } }), { label: "x", type: "connect", options: "", multiple: true, link: { boardId: "0123456789abcdef01234567" } });
    assert.equal(CT.get("connect").createPayload("x").link, null, "Connect needs its board (needsSetup)");
    assert.deepEqual(CT.get("mirror").createPayload("x", { mirror: { via: "c", column: "s" } }).mirror, { via: "c", column: "s", show: "list" });
    assert.ok(CT.get("connect").needsSetup && CT.get("mirror").needsSetup && !CT.get("status").needsSetup);
  });

  test("icons: AppView's glyph per type, as a 16 px currentColor SVG", () => {
    const src = read("AppView.js");
    const map = Function(`return (${/const columnTypeIcons = (\{[^}]*\});/.exec(src)[1]})`)();
    for (const id of CT.ids()) {
      const d = CT.get(id);
      assert.equal(d.iconName, map[id], id);
      assert.match(d.icon, /^<svg [^>]*width="16" height="16"[^>]*stroke="currentColor"/);
      const path = new RegExp(`\\b${d.iconName}:'([^']*)'`).exec(src)[1];
      assert.ok(d.icon.includes(path), `${id}: same drawing as AppView`);
      assert.doesNotMatch(d.icon, /<script|on\w+=/i);
    }
  });

  test("renderer / editor name AppView methods that exist today", () => {
    const src = read("AppView.js");
    for (const id of CT.ids()) {
      const d = CT.get(id);
      for (const name of [d.renderer, d.editor].filter((n) => n && n !== "toggle")) assert.match(src, new RegExp(`\\n  ${name}\\(`), `${id}: AppView.${name}`);
    }
    const inputTypes = { date: "date", number: "number", email: "email", phone: "tel", link: "url" };
    for (const id of ["text", "number", "date", "email", "phone", "link"]) assert.equal(CT.get(id).inputType, inputTypes[id] || "text");
  });
});

describe("the picker contract", () => {
  const ids = (list) => list.map((d) => d.id);
  test("list(ctx): supported types only, picker order; relations only when available", () => {
    assert.deepEqual(ids(CT.list({ relationsAvailable: false })), ["status", "owner", "date", "number", "text", "checkbox", "dropdown", "priority", "email", "phone", "link", "files", "group"]);
    assert.deepEqual(ids(CT.list({ relationsAvailable: true })), [...CT.PICKER_ORDER]);
    assert.deepEqual(ids(CT.list()), ids(CT.list({ relationsAvailable: false })), "no ctx = no relations");
    assert.ok(!ids(CT.list({ relationsAvailable: true, hasConnectColumn: false })).includes("mirror"));
    assert.ok(!ids(CT.list({ relationsAvailable: true, filesAvailable: false })).includes("files"));
    for (const d of CT.list({ relationsAvailable: true })) {
      for (const k of ["id", "label", "icon", "category", "keywords", "description", "createPayload", "defaultValue", "settings", "actions", "renderer", "editor", "validate"]) assert.ok(k in d, `${d.id}.${k}`);
      assert.ok(Object.isFrozen(d) && Object.isFrozen(d.actions) && Object.isFrozen(d.keywords));
      for (const s of d.settings) assert.ok(["labels", "options", "default", "numberFormat", "textFormat"].includes(s));
      assert.deepEqual(Object.keys(d.actions).sort(), ["changeType", "duplicate", "filter", "group", "settings", "sort"]);
      assert.ok(["essentials", "more", "relations"].includes(d.category));
    }
  });

  test("today's Add column chooser filter is reproduced by the optional ctx flags", () => {
    // AppView.showColumnChooser (mode add): files when filesAvailable(); connect when relations; mirror also needs a Connect column.
    for (const relationsAvailable of [true, false]) for (const filesAvailable of [true, false]) for (const hasConnectColumn of [true, false]) {
      const today = CT.chooserEntries().filter((t) => t.type === "files" ? filesAvailable : ["connect", "mirror"].includes(t.type) ? relationsAvailable && (t.type === "connect" || hasConnectColumn) : true).map((t) => t.type).sort();
      assert.deepEqual(ids(CT.list({ relationsAvailable, filesAvailable, hasConnectColumn })).sort(), today);
    }
  });

  test("categories(): essentials, more, and relations only when available", () => {
    assert.deepEqual(CT.categories({ relationsAvailable: false }), [{ id: "essentials", label: "Essentials" }, { id: "more", label: "More" }]);
    assert.deepEqual(CT.categories({ relationsAvailable: true }).map((c) => c.id), ["essentials", "more", "relations"]);
    const used = new Set(CT.list({ relationsAvailable: true }).map((d) => d.category));
    assert.deepEqual([...used].sort(), ["essentials", "more", "relations"]);
  });

  test("search: label prefix > synonym > category; synonyms from the contract", () => {
    const first = (q, ctx = { relationsAvailable: true }) => CT.search(q, ctx)[0]?.id;
    const SYN = { status: ["state", "stage", "progress"], date: ["deadline", "due", "calendar"], owner: ["person", "owner", "assignee"], number: ["amount", "price", "qty", "count"], dropdown: ["select", "tags", "options", "category"], text: ["notes", "description"], checkbox: ["done", "tick", "boolean"], link: ["url", "website"], email: ["mail"], phone: ["tel", "mobile"], files: ["attachment", "upload", "document"] };
    for (const [id, words] of Object.entries(SYN)) for (const w of words) assert.equal(first(w), id, `"${w}" → ${id}`);
    assert.equal(first("Stat"), "status"); assert.equal(first("peo"), "owner"); assert.equal(first("DATE"), "date"); assert.equal(first("connect"), "connect");
    // label prefix beats a keyword: "link" is the Link type, even though Connect links boards.
    assert.equal(first("link"), "link");
    // category last: "more" finds the More types, ranked after nothing better.
    assert.deepEqual(CT.search("essentials").map((d) => d.id), ["status", "owner", "date", "number", "text"]);
    assert.equal(first("due date"), "date");
    assert.deepEqual(CT.search("zzzz"), []);
    assert.deepEqual(ids(CT.search("")), ids(CT.list()));
    assert.ok(!ids(CT.search("lookup", { relationsAvailable: false })).includes("connect"), "hidden types never match");
    assert.deepEqual(CT.search("<img src=x>"), []);
  });
});

describe("conversion targets (S0-A rules; the API matrix is in column-types-conversion-parity.test.js)", () => {
  test("never Connect / Mirror / Files / Group, never the Item column, never the same type", () => {
    const relationsCtx = { relationsAvailable: true };
    for (const type of CT.ids()) {
      const targets = CT.conversionTargets({ key: "k", type }, relationsCtx);
      for (const banned of ["connect", "mirror", "files", "group", type]) assert.ok(!targets.includes(banned), `${type} → ${banned}`);
      if (["connect", "mirror", "files", "group"].includes(type)) assert.deepEqual(targets, [], type);
      assert.deepEqual(CT.conversionTargets({ key: "serial", type }), [], "Item column");
      assert.equal(CT.get(type).actions.changeType, targets.length > 0, `${type} actions.changeType`);
    }
    assert.deepEqual(CT.conversionTargets({ key: "k", type: "text" }), ["status", "owner", "date", "number", "checkbox", "dropdown", "priority", "email", "phone", "link"]);
    assert.equal(CT.canConvert({ key: "k", type: "dropdown" }, { type: "dropdown", multiple: true }), true, "one → several values");
    assert.equal(CT.canConvert({ key: "k", type: "dropdown", multiple: true }, { type: "dropdown", multiple: false }), true);
    assert.equal(CT.canConvert({ key: "k", type: "dropdown" }, { type: "dropdown" }), false);
    assert.equal(CT.canConvert({ key: "k", type: "text" }, { type: "status", multiple: true }), false);
    assert.deepEqual(CT.conversionTargets({ key: "k", type: "nope" }), []);
    assert.deepEqual(CT.conversionTargets(null), []);
  });

  test("columnActions: column-level rules on top of the type's", () => {
    assert.equal(CT.columnActions({ key: "serial", type: "text" }).changeType, false);
    assert.equal(CT.columnActions({ key: "serial", type: "text" }).duplicate, false);
    assert.equal(CT.columnActions({ key: "k", type: "dropdown", multiple: true }).group, false);
    assert.equal(CT.columnActions({ key: "k", type: "dropdown" }).group, true);
    assert.equal(CT.columnActions({ key: "k", type: "files" }).filter, false);
    assert.equal(CT.columnActions({ key: "k", type: "nope" }), null);
    // group-by types: BoardModel.groupByColumns (status, priority, owner, checkbox, one-value dropdown).
    const plain = browserModel({ withRegistry: false }).model;
    const columns = [...CT.ids().map((type, i) => ({ key: `c${i}`, label: type, type })), { key: "dm", label: "dm", type: "dropdown", multiple: true }];
    const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(plain), "groupByColumns").get;
    same(getter.call({ board: { columns } }).map((c) => c.key), columns.filter((c) => CT.columnActions(c).group).map((c) => c.key));
  });
});
