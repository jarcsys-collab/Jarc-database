// Fabric Data column header menus, cell quick actions and the searchable value picker (site/assets/FabricColumnMenu.js,
// FabricValuePicker.js, fabric-menus.css). Runs the unchanged browser files in a vm with a tiny fake DOM and a fake explorer
// exposing F2's hooks: no server, no network, synthetic data only.
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const HOSTILE = `<img src=x onerror="alert(1)">`;
// Objects made inside the vm have other prototypes: compare their JSON form.
const same = (actual, expected, msg) => assert.deepEqual(actual === undefined ? actual : JSON.parse(JSON.stringify(actual)), expected, msg);

// ---- Fake DOM: enough for the modules (innerHTML strings, listeners, focus, attributes, data-fcm buttons).
function makeDom() {
  const doc = { activeElement: null, listeners: {}, body: null };
  function el(tag = "div", props = {}) {
    const e = {
      tagName: tag.toUpperCase(), _html: "", textContent: "", hidden: false, disabled: false, attrs: {}, style: {}, dataset: {}, listeners: {}, children: [], parentNode: null, isConnected: true, tabIndex: 0, rect: null, refs: new Map(), buttons: null,
      classList: { set: new Set(), toggle(c, on) { if (on === undefined ? !this.set.has(c) : on) this.set.add(c); else this.set.delete(c); }, add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); this.refs.clear(); this.buttons = null; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(t, h) { (this.listeners[t] ||= []).push(h); }, removeEventListener(t, h) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== h); },
      fire(t, ev) { for (const h of [...(this.listeners[t] || [])]) h(ev); },
      querySelector(sel) { if (!this.refs.has(sel)) { const c = el("div"); c.owner = this; c.sel = sel; this.refs.set(sel, c); } return this.refs.get(sel); },
      querySelectorAll(sel) {
        if (!/data-fcm/.test(sel)) return [];
        if (!this.buttons) this.buttons = [...this._html.matchAll(/data-fcm="([\w-]+)"[^>]*?(aria-disabled="true")?>/g)].filter((m) => !m[2]).map((m) => { const b = el("button"); b.dataset.fcm = m[1]; b.owner = this; return b; });
        return this.buttons;
      },
      contains(t) { let n = t; while (n) { if (n === this) return true; n = n.owner || n.parentNode; } return false; },
      focus() { doc.activeElement = this; }, appendChild(c) { this.children.push(c); c.parentNode = this; c.isConnected = true; return c; },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); this.parentNode = null; this.isConnected = false; },
      getBoundingClientRect() { return this.rect || { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; },
      closest() { return this; }, ...props
    };
    return e;
  }
  doc.el = el;
  doc.body = el("body");
  doc.documentElement = el("html");
  doc.createElement = (t) => el(t);
  doc.addEventListener = (t, h) => { (doc.listeners[t] ||= []).push(h); };
  doc.removeEventListener = (t, h) => { doc.listeners[t] = (doc.listeners[t] || []).filter((x) => x !== h); };
  doc.querySelector = () => null;
  return doc;
}

function load({ width = 1440, height = 900 } = {}) {
  const document = makeDom();
  const winListeners = {};
  const store = new Map(), writes = [];
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { writes.push(k); store.set(k, String(v)); }, removeItem: (k) => store.delete(k) };
  const clipboard = { written: [], async writeText(t) { this.written.push(t); } };
  const window = { innerWidth: width, innerHeight: height, localStorage, sessionStorage: localStorage, addEventListener: (t, h) => { (winListeners[t] ||= []).push(h); }, removeEventListener: (t, h) => { winListeners[t] = (winListeners[t] || []).filter((x) => x !== h); }, dispatch: (t) => (winListeners[t] || []).forEach((h) => h({ type: t })) };
  const context = vm.createContext({ window, document, navigator: { clipboard }, console, Date, URLSearchParams, encodeURIComponent, decodeURIComponent, unescape, setTimeout, clearTimeout, AbortController, Promise, CSS: { escape: (v) => String(v).replace(/["\\]/g, "\\$&") } });
  for (const f of ["FabricValuePicker.js", "FabricColumnMenu.js"]) vm.runInContext(read(f), context, { filename: f });
  const get = (n) => vm.runInContext(n, context);
  return { context, window, document, clipboard, writes, Picker: get("FabricValuePicker"), Menu: get("FabricColumnMenu") };
}

// Advanced schema fields (02 §2a), synthetic.
const OPS = (...ops) => ops.map((op) => ({ op, class: "bounded" }));
const FIELDS = [
  { name: "Company", type: "string", kind: "category", valueSource: "distinct", orderable: true, operators: OPS("eq", "ne", "in", "nin", "blank", "notBlank") },
  { name: "Item_No", type: "string", kind: "text", valueSource: "search", orderable: false, operators: OPS("eq", "ne", "contains", "in", "nin", "blank", "notBlank") },
  { name: "Posting_Date", type: "date", kind: "date", valueSource: "none", orderable: true, operators: OPS("on", "before", "between", "blank") },
  { name: "Quantity", type: "decimal", kind: "number", valueSource: "none", orderable: false, operators: OPS("eq", "ne", "gt", "between") },
  { name: "Open", type: "bool", kind: "bool", valueSource: "none", orderable: false, operators: OPS("isTrue", "isFalse") },
  { name: "Cost", type: "decimal", kind: "number", valueSource: "none", orderable: false, sensitive: true, operators: [] }
];
function explorer({ answer, user = "user:u1", ds = "inventory", filter = null, orderBy = [], hooks = true, columns } = {}) {
  const calls = [], log = [];
  const x = {
    ds, calls, log, schema: { data: { fields: FIELDS } }, columns: columns || ["Company", "Item_No", "Posting_Date", "Quantity"],
    items: [{ id: "a".repeat(24), values: { Company: "CO_A", Item_No: "ITEM-1", Posting_Date: "2026-03-01T00:00:00.000Z", Quantity: 5, Open: true } }, { id: "b".repeat(24), values: { Company: HOSTILE, Item_No: null, Quantity: -2 } }],
    query: { filter, dateFrom: "2026-02-01", dateTo: "2026-03-01", orderBy },
    p: { c: { model: { me: user } }, announce: (t) => log.push(["announce", t]) },
    fieldLabel: (n) => (n === "Company" ? "Company name" : n),
    get(p, opts) { calls.push({ path: p, signal: opts?.signal }); return typeof answer === "function" ? answer(p, opts, calls.length) : Promise.resolve(answer); },
    onAction(a, t) { log.push(["onAction", a, t.dataset]); }
  };
  if (hooks) Object.assign(x, {
    getState() { return { ...x.query }; },
    applyFilter(m) { log.push(["applyFilter", m]); x.query.filter = m; },
    openFilterFor(f) { log.push(["openFilterFor", f]); },
    setOrderBy(o) { log.push(["setOrderBy", o]); x.query.orderBy = o; },
    hideColumn(n) { log.push(["hideColumn", n]); return true; }
  });
  return x;
}
const vals = (list, over = {}) => ({ dataset: "inventory", field: "Company", values: list.map((v) => (Array.isArray(v) ? { value: v[0], count: v[1] } : { value: v, count: 1 })), complete: true, limited: null, next: null, ...over });
const qs = (p) => new URLSearchParams(p.split("?")[1]);
function mounted(env, x, field = "Company", opts = {}) {
  const root = env.document.el("div"), applied = [], cancelled = [];
  const p = new env.Picker(x, field, { onApply: (v) => applied.push(v), onCancel: () => cancelled.push(true), ...opts });
  p.mount(root);
  return { p, root, applied, cancelled, list: () => p.refs.list.innerHTML, status: () => p.refs.status.textContent };
}
const key = (k, target, extra = {}) => ({ key: k, target, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });
const tgt = (dataset) => ({ dataset, closest() { return this; } });

describe("FabricValuePicker", () => {
  let env;
  beforeEach(() => { env = load(); });

  test("asks the values endpoint (field, limit, context filter, dates) and shows the answer escaped, with counts when complete", async () => {
    const filter = { v: 1, op: "and", items: [{ field: "Item_No", op: "eq", value: "ITEM-1" }] };
    const x = explorer({ answer: Promise.resolve(vals([["CO_A", 12], [HOSTILE, 3]])), filter });
    const t = mounted(env, x); await settle();
    assert.equal(x.calls.length, 1);
    const p = x.calls[0].path, q = qs(p);
    assert.match(p, /^\/fabric\/inventory\/values\?/);
    assert.equal(q.get("field"), "Company"); assert.equal(q.get("limit"), "200"); assert.equal(q.get("dateFrom"), "2026-02-01"); assert.equal(q.get("dateTo"), "2026-03-01");
    const decoded = JSON.parse(Buffer.from(q.get("filter").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    same(decoded, filter);
    assert.match(q.get("filter"), /^[A-Za-z0-9_-]+$/, "base64url, no padding");
    assert.match(t.list(), /role="option"[^>]*aria-selected="false"/);
    assert.match(t.list(), /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.doesNotMatch(t.list(), /<img/);
    assert.match(t.list(), /fx-vpick__count">12</);
    assert.match(t.root.innerHTML, /role="listbox"[^>]*aria-multiselectable="true"/);
  });

  test("values come only from the server, never from the rows on the page", async () => {
    const x = explorer({ answer: Promise.resolve(vals(["FROM_SERVER"])) });
    const t = mounted(env, x); await settle();
    assert.match(t.list(), /FROM_SERVER/);
    assert.doesNotMatch(t.list(), /CO_A|ITEM-1/, "page rows are not used");
  });

  test("search as you type: one request 250 ms after the last key, with q", async () => {
    const x = explorer({ answer: (p) => Promise.resolve(vals([`hit-${qs(p).get("q") || ""}`])) });
    const t = mounted(env, x); await settle();
    for (const s of ["v", "va", "val"]) { t.p.refs.q.value = s; t.p.onInput({ target: { dataset: { fvp: "q" }, value: s } }); }
    assert.equal(t.status(), "Searching…");
    await settle(120); assert.equal(x.calls.length, 1, "nothing before the debounce ends");
    await settle(220);
    assert.equal(x.calls.length, 2); assert.equal(qs(x.calls[1].path).get("q"), "val");
    assert.match(t.list(), /hit-val/);
    assert.match(t.list(), /Use <q>val<\/q> exactly/, "the typed text stays choosable as an exact value");
  });

  test("stale guard: a slow earlier answer never replaces a newer one; the earlier request is aborted", async () => {
    let releaseOld;
    const x = explorer({ answer: (p, o, n) => (n === 2 ? new Promise((r) => { releaseOld = () => r(vals(["OLD"])); }) : Promise.resolve(vals([n === 1 ? "FIRST" : "NEW"]))) });
    const t = mounted(env, x); await settle();
    t.p.setQuery("o"); await settle(270);
    assert.equal(x.calls.length, 2);
    t.p.setQuery("ne"); await settle(270);
    assert.equal(x.calls.length, 3);
    assert.equal(x.calls[1].signal.aborted, true, "the older search was aborted");
    assert.match(t.list(), /NEW/);
    releaseOld(); await settle();
    assert.match(t.list(), /NEW/); assert.doesNotMatch(t.list(), /OLD/);
  });

  test("Load more pages with after=next (nextAfter accepted too) and appends without duplicates", async () => {
    const x = explorer({ answer: (p) => Promise.resolve(qs(p).get("after") === "B" ? vals(["B", "C", "D"], { complete: false }) : vals(["A", "B"], { complete: false, next: null, nextAfter: "B" })) });
    const t = mounted(env, x); await settle();
    assert.equal(t.p.refs.more.hidden, false);
    t.p.onClick({ target: tgt({ fvp: "more" }) }); await settle();
    assert.equal(qs(x.calls[1].path).get("after"), "B");
    same(t.p.items.map((i) => i.value), ["A", "B", "C", "D"]);
    assert.equal(t.p.refs.more.hidden, true, "no next: no Load more");
  });

  test("limited answers say the list may be incomplete (and why) and hide counts", async () => {
    const x = explorer({ answer: Promise.resolve(vals([["A", 5]], { complete: false, limited: { reason: "rowCap", rowsScanned: 20000, rowCap: 20000 }, next: "A" })) });
    const t = mounted(env, x); await settle();
    assert.match(t.status(), /may be incomplete/); assert.match(t.status(), /20,000/); assert.match(t.status(), /Load more/);
    assert.doesNotMatch(t.list(), /fx-vpick__count/, "counts only for complete lists");
  });

  test("select one, many, all shown (toggle), clear; blank option; cap of 200; Apply returns values (null = blank)", async () => {
    const x = explorer({ answer: Promise.resolve(vals(["A", "B", "C"])) });
    const t = mounted(env, x); await settle();
    const opts = t.p.options();
    assert.equal(opts[0].value, null, "blank first when the field supports blank");
    assert.match(t.list(), /<em>\(Blank\)<\/em>/);
    t.p.onClick({ target: tgt({ fvp: "opt", i: "2" }) });
    t.p.onClick({ target: tgt({ fvp: "opt", i: "0" }) });
    same(t.p.values(), ["B", null]);
    assert.equal(t.p.refs.count.textContent, "2 selected");
    t.p.onClick({ target: tgt({ fvp: "all" }) });
    same(t.p.values().sort(), [null, "A", "B", "C"].sort());
    assert.equal(t.p.refs.all.attrs["aria-pressed"], "true");
    t.p.onClick({ target: tgt({ fvp: "all" }) }); same(t.p.values(), []);
    t.p.onClick({ target: tgt({ fvp: "opt", i: "1" }) }); t.p.onClick({ target: tgt({ fvp: "clear" }) }); same(t.p.values(), []);
    t.p.onClick({ target: tgt({ fvp: "opt", i: "1" }) }); t.p.onClick({ target: tgt({ fvp: "apply" }) });
    same(t.applied, [["A"]]);
    // The server's blank bucket ({blank:true}) is the one blank option; after="" (past it) is a real cursor.
    const x3 = explorer({ answer: (p) => Promise.resolve(qs(p).has("after") ? vals(["Q"]) : { values: [{ value: "", blank: true }], complete: false, limited: null, nextAfter: "", next: "" }) });
    const t3 = mounted(env, x3); await settle();
    same(t3.p.options().map((o) => o.value), [null]);
    assert.equal(t3.p.refs.more.hidden, false);
    await t3.p.loadMore(); assert.equal(qs(x3.calls[1].path).get("after"), "");
    same(t3.p.options().map((o) => o.value), [null, "Q"]);
    // Cap
    const many = Array.from({ length: 250 }, (_, i) => `V${i}`);
    const x2 = explorer({ answer: Promise.resolve(vals(many)) }), t2 = mounted(env, x2, "Item_No"); await settle();
    t2.p.selectAll(); assert.equal(t2.p.values().length, 200); assert.match(t2.status(), /first 200/);
  });

  test("keyboard: ↓ from search into the list, ↑/↓/Home/End, Space toggles, Enter applies, Esc cancels, Ctrl+A", async () => {
    const x = explorer({ answer: Promise.resolve(vals(["A", "B", "C"])) });
    const t = mounted(env, x, "Item_No"); await settle(); // Item_No: blank supported too → 4 options
    const input = { dataset: { fvp: "q" } }, list = { dataset: { fvp: "list" } };
    t.p.onKeydown(key("ArrowDown", input));
    assert.equal(env.document.activeElement, t.p.refs.list);
    assert.equal(t.p.refs.list.attrs["aria-activedescendant"], `${t.p.id}-opt-0`);
    t.p.onKeydown(key("ArrowDown", list)); t.p.onKeydown(key("ArrowDown", list));
    assert.equal(t.p.active, 2);
    t.p.onKeydown(key("End", list)); assert.equal(t.p.active, 3);
    t.p.onKeydown(key("ArrowDown", list)); assert.equal(t.p.active, 3, "stays on the last option");
    t.p.onKeydown(key("Home", list)); assert.equal(t.p.active, 0);
    t.p.onKeydown(key("ArrowDown", list));
    const sp = key(" ", list); t.p.onKeydown(sp); assert.equal(sp.prevented, true);
    same(t.p.values(), ["A"]);
    assert.match(t.list(), new RegExp(`id="${t.p.id}-opt-1" class="fx-vpick__opt is-active" aria-selected="true"`));
    t.p.onKeydown(key("ArrowUp", list)); t.p.onKeydown(key("ArrowUp", list)); assert.equal(env.document.activeElement, t.p.refs.q, "↑ from the first option returns to search");
    t.p.onKeydown(key("a", list, { ctrlKey: true })); assert.equal(t.p.values().length, 4);
    t.p.onKeydown(key("Enter", list)); assert.equal(t.applied.length, 1);
    const esc = key("Escape", list); t.p.onKeydown(esc); assert.equal(t.cancelled.length, 1); assert.equal(esc.stopped, true);
  });

  test("cache: per user, dataset, field and context, memory only; cleared on dataset change, sign-out and forget()", async () => {
    const answer = () => Promise.resolve(vals(["A"]));
    const x = explorer({ answer }); mounted(env, x); await settle(); mounted(env, x); await settle();
    assert.equal(x.calls.length, 1, "the same question is answered from memory");
    const other = explorer({ answer, user: "user:u2" }); other.schema = x.schema; mounted(env, other); await settle();
    assert.equal(other.calls.length, 1, "another user never sees the first user's answer");
    x.query.filter = { v: 1, op: "and", items: [{ field: "Item_No", op: "eq", value: "Z" }] }; mounted(env, x); await settle();
    assert.equal(x.calls.length, 2, "another context asks again");
    const sales = explorer({ answer, ds: "sales" }); mounted(env, sales); await settle();
    assert.equal(env.Picker.cacheDataset, "sales"); assert.equal(env.Picker.cache.size, 1, "the dataset change emptied the cache");
    env.window.dispatch("jarc-session-expired"); assert.equal(env.Picker.cache.size, 0);
    mounted(env, sales); await settle(); assert.equal(sales.calls.length, 2);
    env.Picker.forget(); assert.equal(env.Picker.cache.size, 0);
    same(env.writes, [], "nothing is written to browser storage");
  });

  test("errors are generic; destroy() stops pending work", async () => {
    const x = explorer({ answer: () => Promise.reject(Object.assign(new Error("secret server detail"), { cause: { status: 500 } })) });
    const t = mounted(env, x); await settle();
    assert.equal(t.status(), "Values couldn't be loaded.");
    t.p.setQuery("x"); t.p.destroy(); await settle(300);
    assert.equal(x.calls.length, 1, "no request after destroy");
  });
});

describe("FabricColumnMenu", () => {
  let env;
  beforeEach(() => { env = load(); });
  const anchor = (rect) => { const a = env.document.el("button"); a.rect = rect; env.document.body.appendChild(a); return a; };
  const find = (cur, id) => cur.items.find((i) => i.id === id);
  const last = (x, kind) => x.log.filter((l) => l[0] === kind).at(-1);

  test("placement stays inside the viewport at 320, 768 and 1440 px", () => {
    const { Menu } = env;
    for (const [vw, vh] of [[320, 568], [768, 1024], [1440, 900], [1920, 1080]]) {
      for (const a of [{ left: 0, right: 20, top: 10, bottom: 30 }, { left: vw - 20, right: vw - 2, top: 40, bottom: 60 }, { left: vw / 2, right: vw / 2 + 20, top: vh - 30, bottom: vh - 10 }]) {
        for (const size of [{ width: 240, height: 220 }, { width: 300, height: 480 }, { width: 2400, height: 3000 }]) {
          const p = Menu.place(a, size, { width: vw, height: vh });
          assert.ok(p.left >= 8, `left ${vw}`); assert.ok(p.left + p.width <= vw - 8, `right edge ${vw}: ${JSON.stringify(p)}`);
          assert.ok(p.top >= 8, `top ${vw}`); assert.ok(p.top + Math.min(size.height, p.maxHeight) <= vh - 8, `bottom ${vw}x${vh}: ${JSON.stringify(p)}`);
        }
      }
    }
    const phone = Menu.place({ left: 200, right: 220, top: 10, bottom: 30 }, { width: 240, height: 200 }, { width: 320, height: 568 });
    assert.equal(phone.sheet, true); assert.equal(phone.left, 8); assert.equal(phone.width, 304);
    const up = Menu.place({ left: 100, right: 120, top: 800, bottom: 820 }, { width: 240, height: 300 }, { width: 1440, height: 900 });
    assert.ok(up.top + 300 <= 800, "opens upwards when there is more room above");
  });

  test("the menu element is placed within the viewport (fixed coordinates written to its style)", () => {
    for (const w of [320, 768, 1440]) {
      env = load({ width: w, height: 800 });
      const x = explorer({ answer: Promise.resolve(vals(["A"])) });
      const cur = env.Menu.openHeader(x, "Company", anchor({ left: w - 10, right: w, top: 5, bottom: 25 }));
      cur.box.rect = { width: 300, height: 420 }; const p = env.Menu.position();
      assert.ok(parseInt(cur.box.style.left, 10) >= 8 && p.left + p.width <= w - 8, `${w}: ${JSON.stringify(p)}`);
      assert.equal(cur.box.style.maxWidth, `${w - 16}px`);
      env.Menu.close(false);
    }
  });

  test("header trigger: escaped label, routed as fabric-c-menu with data-ds/data-field; filtered state shown in text", () => {
    const x = explorer({ filter: { v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "A" }] } });
    x.fieldLabel = () => HOSTILE;
    const html = env.Menu.triggerHtml(x, "Company");
    assert.equal(env.Menu.headerHtml(x, "Company"), html, "headerHtml is the name the explorer uses");
    assert.match(html, /data-action="fabric-c-menu" data-ds="inventory" data-field="Company"/);
    assert.match(html, /aria-haspopup="dialog" aria-expanded="false"/);
    assert.match(html, /aria-label="Column options: &lt;img[^"]*\(filtered\)"/);
    assert.doesNotMatch(html, /<img/);
  });

  test("header items: sort only when orderable; filter, clear filter, hide, choose columns; no edit actions", () => {
    const x = explorer({ filter: { v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "A" }] }, orderBy: [["Company", "asc"]] });
    const ids = (f) => env.Menu.headerItems(x, f).filter((i) => !i.sep).map((i) => i.id);
    same(ids("Company"), ["sort-asc", "sort-desc", "sort-clear", "filter", "filter-clear", "hide", "columns"]);
    assert.equal(env.Menu.headerItems(x, "Company")[0].checked, true, "the current direction is checked");
    same(ids("Quantity"), ["filter", "hide", "columns"], "not orderable: no sort items");
    x.sortFor = (f) => (f === "Quantity" ? { name: "qty" } : null);
    same(ids("Quantity"), ["sort-named", "filter", "hide", "columns"], "an existing named sort is kept");
    same(ids("Cost"), ["columns"], "no operators: nothing to filter (and not a shown column: nothing to hide)");
    const html = env.Menu.itemsHtml(env.Menu.headerItems(x, "Company"), "m");
    assert.match(html, /role="menuitemradio"[^>]*aria-checked="true"/);
    assert.doesNotMatch(html, /edit|delete|rename|export/i);
    assert.equal(env.Menu.pickerAllowed(x, "Company"), true);
    assert.equal(env.Menu.pickerAllowed(x, "Quantity"), false, "valueSource none: no value list");
    assert.equal(env.Menu.pickerAllowed(x, "Cost"), false);
    const bare = explorer({ hooks: false });
    same(env.Menu.headerItems(bare, "Company").filter((i) => !i.sep).map((i) => i.id), ["columns"], "without F2's hooks only safe items remain");
    assert.equal(env.Menu.pickerAllowed(bare, "Company"), false);
  });

  test("menu actions call the explorer hooks and close the menu", () => {
    const x = explorer({ filter: { v: 1, op: "and", items: [{ field: "Company", op: "in", values: ["A", "B"] }, { field: "Item_No", op: "contains", value: "z" }] } });
    const open = () => env.Menu.openHeader(x, "Company", anchor({ left: 10, right: 30, top: 10, bottom: 30 }));
    open(); env.Menu.run("sort-desc"); same(last(x, "setOrderBy")[1], [["Company", "desc"]]); assert.equal(env.Menu.current, null);
    open(); env.Menu.run("sort-clear"); same(last(x, "setOrderBy")[1], []);
    open(); env.Menu.run("filter"); same(last(x, "openFilterFor"), ["openFilterFor", "Company"]);
    open(); env.Menu.run("filter-clear"); same(last(x, "applyFilter")[1], { v: 1, op: "and", items: [{ field: "Item_No", op: "contains", value: "z" }] });
    open(); env.Menu.run("hide"); same(last(x, "hideColumn"), ["hideColumn", "Company"]);
    open(); env.Menu.run("columns"); assert.equal(last(x, "onAction")[1], "fabric-x-columns");
    // A refused filter (applyFilter → {ok:false}) is announced, not reported as applied.
    x.applyFilter = (m) => { x.log.push(["applyFilter", m]); return { ok: false, errors: [{}] }; };
    x.query.filter = { v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "A" }] };
    open(); env.Menu.run("filter-clear"); same(last(x, "announce"), ["announce", "This filter couldn't be applied."]);
    // Fallback hide without F2's hideColumn: the explorer's own toggleColumn + applyColumns.
    const y = explorer(); delete y.hideColumn; let applied = 0;
    y.toggleColumn = (n, on) => { y.log.push(["toggle", n, on]); return true; }; y.applyColumns = () => { applied++; };
    env.Menu.openHeader(y, "Company", anchor({})); env.Menu.run("hide");
    same(last(y, "toggle"), ["toggle", "Company", false]); assert.equal(applied, 1);
  });

  test("quick value select: the picker inside the header menu applies an `in` condition for this column", async () => {
    const x = explorer({ answer: Promise.resolve(vals(["A", "B", "C"])), filter: { v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "OLD" }, { field: "Item_No", op: "contains", value: "z" }] } });
    const cur = env.Menu.openHeader(x, "Company", anchor({ left: 10, right: 30, top: 10, bottom: 30 })); await settle();
    assert.ok(cur.pickerObj, "picker mounted"); assert.match(cur.layer.innerHTML, /role="dialog"[^>]*aria-label="Column options: Company name"/);
    same(cur.pickerObj.values(), ["OLD"], "the column's current values start selected");
    cur.pickerObj.clear(); cur.pickerObj.toggle(2); cur.pickerObj.toggle(3); cur.pickerObj.apply();
    same(last(x, "applyFilter")[1], { v: 1, op: "and", items: [{ field: "Item_No", op: "contains", value: "z" }, { field: "Company", op: "in", values: ["B", "C"] }] });
    assert.equal(env.Menu.current, null);
    // Blank + values → OR of in and blank; only blank → blank; nothing → the column's filter removed.
    const ops = env.Menu.ops(env.Menu.meta(x, "Company"));
    same(env.Menu.pickCondition("Company", ["A", null], ops), { op: "or", items: [{ field: "Company", op: "in", values: ["A"] }, { field: "Company", op: "blank" }] });
    same(env.Menu.pickCondition("Company", [null], ops), { field: "Company", op: "blank" });
    assert.equal(env.Menu.pickCondition("Company", [], ops), null);
    same(env.Menu.selectedValues({ v: 1, op: "and", items: [{ op: "or", items: [{ field: "Company", op: "in", values: ["A"] }, { field: "Company", op: "blank" }] }] }, "Company"), ["A", null]);
  });

  test("model helpers: replace only this column, wrap a top-level OR, remove nested conditions, respect the limits", () => {
    const { Menu } = env;
    const orRoot = { v: 1, op: "or", items: [{ field: "A", op: "eq", value: "1" }, { field: "B", op: "eq", value: "2" }] };
    same(Menu.setField(orRoot, "Company", { field: "Company", op: "eq", value: "X" }), { v: 1, op: "and", items: [{ op: "or", items: orRoot.items }, { field: "Company", op: "eq", value: "X" }] });
    assert.equal(Menu.setField({ v: 1, op: "or", items: [{ op: "and", items: [{ field: "A", op: "eq", value: "1" }] }] }, "Company", { field: "Company", op: "eq", value: "X" }), undefined, "would exceed depth 2");
    const nested = { v: 1, op: "and", items: [{ op: "or", items: [{ field: "Company", op: "eq", value: "1" }, { field: "B", op: "eq", value: "2" }] }] };
    same(Menu.withoutField(nested, "Company"), { v: 1, op: "and", items: [{ field: "B", op: "eq", value: "2" }] });
    assert.equal(Menu.withoutField({ v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "1" }] }, "Company"), null);
    const full = { v: 1, op: "and", items: Array.from({ length: 20 }, (_, i) => ({ field: `F${i}`, op: "eq", value: "1" })) };
    assert.equal(Menu.addCondition(full, { field: "Company", op: "eq", value: "x" }), undefined);
    same(full.items.length, 20, "inputs are never mutated");
  });

  test("cell quick actions: equals / does not equal (blanks included), by type; copy value; read-only", async () => {
    const x = explorer({ filter: { v: 1, op: "and", items: [{ field: "Company", op: "ne", value: "Z" }] } });
    const labels = (f, v) => env.Menu.cellItems(x, f, v).filter((i) => !i.sep).map((i) => i.label);
    same(labels("Company", "CO_A"), ["Filter: equals “CO_A”", "Filter: does not equal “CO_A” (blanks included)", "Copy value"]);
    same(labels("Item_No", null), ["Filter: is blank", "Filter: is not blank", "Copy value"]);
    same(labels("Posting_Date", "2026-03-01T00:00:00.000Z"), ["Filter: is on 2026-03-01", "Copy value"]);
    same(labels("Quantity", -2), ["Filter: equals “-2”", "Filter: does not equal “-2” (blanks included)", "Copy value"]);
    same(labels("Open", true), ["Filter: is true", "Copy value"]);
    same(labels("Cost", "12.5"), ["Copy value"], "sensitive: no filter actions");
    same(labels("Company", "x".repeat(101)), ["Copy value"], "longer than the model allows");
    const html = env.Menu.itemsHtml(env.Menu.cellItems(x, "Company", HOSTILE), "c");
    assert.doesNotMatch(html, /<img/); assert.doesNotMatch(html, /edit|delete|save/i);
    // equals replaces this column's condition; does not equal merges into nin
    env.Menu.openCell(x, "Company", "CO_A", anchor({})); env.Menu.run("f-ne");
    same(last(x, "applyFilter")[1], { v: 1, op: "and", items: [{ field: "Company", op: "nin", values: ["Z", "CO_A"] }] });
    env.Menu.openCell(x, "Company", "CO_A", anchor({})); env.Menu.run("f-eq");
    same(last(x, "applyFilter")[1], { v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "CO_A" }] });
    env.Menu.openCell(x, "Quantity", -2, anchor({})); await env.Menu.run("copy"); await settle();
    same(env.clipboard.written, ["-2"]); same(last(x, "announce"), ["announce", "Value copied."]);
  });

  test("context menu on a cell reads the value from the row in memory, not the cell text", () => {
    const x = explorer(); x.info = { byName: new Map(x.columns.map((n) => [n, {}])) };
    const tr = { dataset: { id: "b".repeat(24) } }, cell = { cellIndex: 0, textContent: "TAMPERED", closest: (s) => (s === "tr" ? tr : cell), getBoundingClientRect: () => ({ left: 5, right: 50, top: 5, bottom: 25 }) };
    const ev = { target: { closest: (s) => (s.startsWith("td") ? cell : s === "[data-grid]" ? {} : null) }, clientX: 40, clientY: 50, preventDefault() { this.prevented = true; } };
    assert.equal(env.Menu.onContextMenu(x, ev), true); assert.equal(ev.prevented, true);
    assert.equal(env.Menu.current.value, HOSTILE); assert.equal(env.Menu.current.field, "Company");
    same(env.Menu.current.point, { left: 40, right: 40, top: 50, bottom: 50 });
    assert.doesNotMatch(env.Menu.current.layer.innerHTML, /<img/);
  });

  test("Escape closes and gives focus back; arrows move between items; aria-expanded follows; click outside closes", () => {
    const x = explorer({ answer: Promise.resolve(vals([])) });
    const a = anchor({ left: 10, right: 30, top: 10, bottom: 30 });
    env.Menu.onAction(x, "fabric-c-menu", Object.assign(a, { dataset: { field: "Quantity", ds: "inventory" } }));
    const cur = env.Menu.current;
    assert.equal(a.attrs["aria-expanded"], "true"); assert.equal(env.document.body.children.includes(cur.layer), true);
    const buttons = cur.layer.querySelectorAll('[data-fcm]:not([aria-disabled="true"])');
    same(buttons.map((b) => b.dataset.fcm), ["filter", "hide", "columns"]);
    cur.handlers.keydown(key("ArrowDown", buttons[0])); assert.equal(env.document.activeElement, buttons[1]);
    cur.handlers.keydown(key("End", buttons[1])); assert.equal(env.document.activeElement, buttons[2]);
    cur.handlers.keydown(key("ArrowDown", buttons[2])); assert.equal(env.document.activeElement, buttons[0], "wraps");
    const esc = key("Escape", buttons[0]); cur.handlers.keydown(esc);
    assert.equal(env.Menu.current, null); assert.equal(env.document.activeElement, a, "focus restored to the trigger");
    assert.equal(a.attrs["aria-expanded"], "false"); assert.equal(env.document.body.children.includes(cur.layer), false);
    // Click outside
    env.Menu.openHeader(x, "Quantity", a); const outside = env.document.el("div");
    env.document.listeners.pointerdown.forEach((h) => h({ target: outside }));
    assert.equal(env.Menu.current, null);
    // Same trigger again toggles closed
    env.Menu.onAction(x, "fabric-c-menu", a); env.Menu.onAction(x, "fabric-c-menu", a); assert.equal(env.Menu.current, null);
  });

  test("stylesheet: dark and light tokens, viewport-bounded menu, 32 px+ touch targets", () => {
    const css = read("fabric-menus.css");
    assert.match(css, /:root\[data-theme="dark"\] \.fx-menu-layer/);
    assert.match(css, /max-width: calc\(100vw - 16px\)/); assert.match(css, /max-height: calc\(100vh - 16px\)/);
    assert.match(css, /@media \(pointer: coarse\)[^{]*\{[^}]*--fxm-row: 36px; --fxm-btn-h: 34px;/);
    assert.match(css, /@media \(pointer: coarse\) \{ \.fx-app \.fx-colmenu__btn \{ width: 32px; height: 32px;/);
    assert.match(css, /forced-colors: active/);
  });
});
