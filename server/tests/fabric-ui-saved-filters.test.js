// Fabric Data "My saved filters" UI (site/assets/FabricSavedFilters.js, Phase 7 F4). Runs the unchanged browser file in a vm
// against a fake explorer and a fake saved-filters backend that behaves like server/src/routes/fabric-saved-filters.js (per-user
// lists, NAME_TAKEN / LIMIT_REACHED / NOT_FOUND, revalidation with { unavailable: true } placeholders). No server, no network,
// synthetic data only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const HOSTILE = `<img src=x onerror="alert(1)">`;
// vm values come from another realm (deepStrictEqual compares prototypes), and HTML text has its apostrophes escaped.
const plain = (v) => JSON.parse(JSON.stringify(v));
const un = (h) => String(h).replace(/&#39;/g, "'");
const deq = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);

function load() {
  const listeners = new Map();
  const window = { location: { pathname: "/fabric/inventory", search: "" }, addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); }, dispatchEvent() {} };
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } } };
  const context = vm.createContext({ window, document, console, Intl, Date, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, CSS: { escape: (v) => v } });
  for (const f of ["AppView.js", "FabricSavedFilters.js"]) vm.runInContext(read(f), context, { filename: f });
  const S = vm.runInContext("FabricSavedFilters", context);
  const fire = (name) => (listeners.get(name) || []).forEach((fn) => fn());
  return { S, fire, document };
}

const err = (status, serverCode) => Object.assign(new Error("Request failed"), { code: status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : status === 400 ? "VALIDATION_ERROR" : "INTERNAL_ERROR", cause: { status, serverCode } });

// The backend: lists per user and dataset. `usable` is the set of fields the caller may filter on now (revalidation).
function backend() {
  const lists = new Map(), calls = [];
  let n = 0;
  const b = { lists, calls, usable: new Set(["Company", "Item_No", "Quantity", "Posting_Date"]), fail: null, user: "u1", max: 50 };
  const list = (ds, user) => { const key = `${user}:${ds}`; if (!lists.has(key)) lists.set(key, []); return lists.get(key); };
  const present = (f) => {
    const bad = [];
    const walk = (node, p) => ({ ...node, items: node.items.map((c, i) => (Array.isArray(c.items) ? walk(c, `${p}.items.${i}`) : b.usable.has(c.field) ? c : (bad.push(`${p}.items.${i}`), { unavailable: true }))) });
    const filter = f.state.filter ? walk(f.state.filter, "filter") : null;
    return { id: f.id, name: f.name, version: 1, state: { ...f.state, filter }, updatedAt: "2026-11-25T00:00:00.000Z", valid: !bad.length, ...(bad.length ? { problem: "This saved filter uses a field or setting you can't use now. Edit it and save again.", unavailable: bad } : {}) };
  };
  b.adapter = {
    async request(method, p, body) {
      const user = b.user; // the session that sent the request
      calls.push([method, p, body === undefined ? undefined : JSON.parse(JSON.stringify(body))]);
      await settle(1);
      if (b.fail) { const f = b.fail; b.fail = null; throw f; }
      const m = /^\/fabric\/saved-filters\/(inventory|sales)(?:\/([^/]+))?$/.exec(p);
      if (!m) throw err(404, "NOT_FOUND");
      const items = list(m[1], user), id = m[2] && decodeURIComponent(m[2]);
      const idx = id ? items.findIndex((f) => f.id === id) : -1;
      const taken = (name, except) => items.some((f) => f.id !== except && f.name.toLowerCase() === name.toLowerCase());
      if (method === "GET" && !id) return { dataset: m[1], items: items.map(present) };
      if (method === "POST" && !id) {
        if (items.length >= b.max) throw err(409, "LIMIT_REACHED");
        if (taken(body.name)) throw err(409, "NAME_TAKEN");
        const f = { id: (++n).toString(16).padStart(16, "0"), name: body.name, state: body.state };
        items.push(f); return present(f);
      }
      if (idx < 0) throw err(404, "NOT_FOUND");
      if (method === "PUT") { if (body.name && taken(body.name, id)) throw err(409, "NAME_TAKEN"); if (body.name) items[idx].name = body.name; if (body.state) items[idx].state = body.state; return present(items[idx]); }
      if (method === "DELETE") {
        items.splice(idx, 1);
        // The real client parses JSON on every success, so a 204 can surface as an "unusable response" after the delete.
        if (b.emptyBody204) throw Object.assign(new Error("The JARC server sent a response JARC can't use."), { code: "INTERNAL_ERROR", cause: new SyntaxError("Unexpected end of JSON input") });
        return undefined;
      }
      throw err(405, "METHOD_NOT_ALLOWED");
    }
  };
  return b;
}

// A stand-in for F2's FabricExplorer: getState/setState over a plain object, the schema's fields, and the panel hooks.
function explorer(b, ds = "inventory") {
  const view = { html: "", cls: "", overlay(html, cls) { this.html = html; this.cls = cls; }, closeOverlay() { this.html = ""; } };
  const p = { adapter: b.adapter, c: { view, auth: { get userId() { return b.user; } }, model: {} }, redraws: 0, objectRedraws: 0, said: [], redraw() { this.redraws++; }, redrawObjects() { this.objectRedraws++; }, announce(t) { this.said.push(t); } };
  const x = { ds, label: ds === "sales" ? "Sales" : "Inventory", p, info: { fields: ["Company", "Item_No", "Quantity", "Posting_Date", "Entry_No"].map((name) => ({ name })) },
    state: { filter: null, orderBy: [], columns: ["Company", "Item_No"], dateFrom: null, dateTo: null, datePreset: null, q: "", searchField: null },
    applied: [], getState() { return JSON.parse(JSON.stringify(this.state)); }, setState(s) { this.applied.push(s); this.state = { ...this.state, ...JSON.parse(JSON.stringify(s)) }; } };
  return { x, p, view };
}
const cond = (field, op, value) => ({ field, op, value });
const model = (...items) => ({ v: 1, op: "and", items });
const form = (mode, { id = "", name = "", back = "" } = {}) => ({ dataset: { mode, id, back }, elements: { name: { value: name } } });

async function withList(S, b, ds = "inventory") { const t = explorer(b, ds); assert.equal(t.x && S.navItems(t.x), null); await settle(); await settle(); return t; }

describe("Fabric saved filters UI", () => {
  test("navItems: null while loading, then the person's items; one GET; the Objects panel is redrawn", async () => {
    const { S } = load(), b = backend();
    b.lists.set("u1:inventory", [{ id: "00000000000000aa", name: "Weekly", state: { filter: model(cond("Company", "eq", "CO_A")) } }]);
    const { x, p } = await withList(S, b);
    assert.equal(b.calls.filter(([m]) => m === "GET").length, 1);
    deq(b.calls[0].slice(0, 2), ["GET", "/fabric/saved-filters/inventory"]);
    const items = S.navItems(x);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "00000000000000aa"); assert.equal(items[0].name, "Weekly");
    assert.equal(items[0].current, false); assert.equal(items[0].invalid, false);
    assert.ok(p.objectRedraws >= 1, "the Objects panel is redrawn when the list answers");
    assert.equal(b.calls.length, 1, "drawing again doesn't ask again");
  });

  test("save current: name dialog, validation, duplicate name (client and server), then highlighted as current", async () => {
    const { S } = load(), b = backend();
    const { x, view } = await withList(S, b);
    x.state.filter = model(cond("Company", "in", undefined)); x.state.filter.items[0] = { field: "Company", op: "in", values: ["CO_A", "CO_B"] };
    x.state.orderBy = [["Posting_Date", "desc"]];
    S.onAction(x, "fabric-s-save", { dataset: { ds: "inventory" } });
    assert.match(un(view.html), /role="dialog" aria-modal="true" data-action="fabric-s-form"[^>]*data-mode="save"/);
    assert.match(un(view.html), /Saves 1 filter condition, the sort and 2 chosen columns/);
    assert.match(un(view.html), /maxlength="80"/);
    await S.onSubmit(x, "fabric-s-form", form("save", { name: "   " }));
    assert.match(un(view.html), /role="alert">Give the saved filter a name\./);
    assert.match(un(view.html), /aria-invalid="true"/);
    await S.onSubmit(x, "fabric-s-form", form("save", { name: "x".repeat(81) }));
    assert.match(un(view.html), /Use at most 80 characters \(this name has 81\)/);
    assert.equal(b.calls.filter(([m]) => m === "POST").length, 0, "invalid names never reach the server");
    await S.onSubmit(x, "fabric-s-form", form("save", { name: "  Two   companies " }));
    const post = b.calls.find(([m]) => m === "POST");
    assert.equal(post[1], "/fabric/saved-filters/inventory");
    assert.equal(post[2].name, "Two companies", "whitespace collapsed like the server");
    deq(post[2].state.orderBy, [["Posting_Date", "desc"]]);
    deq(post[2].state.columns, ["Company", "Item_No"]);
    assert.equal("userId" in post[2], false, "the client never says whose filter it is");
    assert.equal(view.html, "", "the dialog closes");
    const [item] = S.navItems(x);
    assert.equal(item.current, true); assert.equal(item.dirty, false);
    assert.match(S.toolbarHtml(x), /Saved filter:<\/span> <span class="fx-chip__text">Two companies/);
    // Duplicate (ignoring case): refused before the request.
    S.onAction(x, "fabric-s-save", { dataset: {} });
    await S.onSubmit(x, "fabric-s-form", form("save", { name: "two COMPANIES" }));
    assert.match(un(view.html), /You already have a saved filter named “Two companies” for Inventory/);
    // The server's NAME_TAKEN (a name saved in another window) gets the same kind of answer.
    b.lists.get("u1:inventory").push({ id: "00000000000000ff", name: "Other window", state: {} });
    await S.onSubmit(x, "fabric-s-form", form("save", { name: "Other window" }));
    assert.match(un(view.html), /Couldn't save “Other window”\. You already have a saved filter with that name/);
    assert.match(un(view.html), /value="Other window"/, "the typed name is kept");
  });

  test("open: revalidated on the server, unavailable conditions skipped and listed, the rest applied via setState", async () => {
    const { S } = load(), b = backend();
    b.lists.set("u1:inventory", [{ id: "00000000000000a1", name: "Mixed", state: { filter: model(cond("Company", "eq", "CO_A"), { op: "or", items: [cond("Gone_Field", "eq", "1"), cond("Item_No", "startsWith", "IT")] }), orderBy: [["Posting_Date", "asc"]], columns: ["Company", "Removed_Col"], dateFrom: "2026-01-01", dateTo: "2026-01-31", datePreset: null, q: "valve", searchField: null } }]);
    const { x, p } = await withList(S, b);
    b.usable.delete("Gone_Field");
    assert.equal(S.navItems(x)[0].invalid, true);
    const before = b.calls.length;
    assert.equal(await S.open(x, "00000000000000a1"), true);
    assert.equal(b.calls.length, before + 1, "the list is read again before applying");
    const applied = x.applied.at(-1);
    deq(applied.filter, model(cond("Company", "eq", "CO_A"), { op: "or", items: [cond("Item_No", "startsWith", "IT")] }));
    assert.equal(JSON.stringify(applied).includes("unavailable"), false, "placeholders never reach the explorer");
    deq(applied.orderBy, [["Posting_Date", "asc"]]);
    deq(applied.columns, ["Company"], "a column missing from the schema is left out");
    assert.equal(applied.q, "valve"); assert.equal(applied.dateFrom, "2026-01-01");
    const notice = un(S.noticeHtml(x));
    assert.match(notice, /role="status"/);
    assert.match(notice, /Condition 1 in group 2: it uses a field or setting you can't use now/);
    assert.match(notice, /1 column isn't available now and was left out/);
    assert.equal(notice.includes("Gone_Field"), false, "never names the unavailable field");
    assert.match(p.said.at(-1), /Opened saved filter Mixed\. Skipped because they can't be used now/);
    assert.equal(S.navItems(x)[0].current, true);
    S.onAction(x, "fabric-s-dismiss", { dataset: {} });
    assert.equal(S.noticeHtml(x), "");
  });

  test("M1: a skip in an AND is never applied on its own: builder draft, a warning that can't be dismissed, explicit Open anyway", async () => {
    const { S } = load(), b = backend();
    b.lists.set("u1:inventory", [{ id: "00000000000000c1", name: "Narrow", state: { filter: model(cond("Company", "eq", "CO_A"), cond("Gone_Field", "eq", "1")), orderBy: [], columns: [], dateFrom: "2026-01-01", dateTo: "2026-01-31", q: "" } }]);
    const { x, p, view } = await withList(S, b);
    const drafts = [];
    x.setDraft = (m) => { drafts.push(JSON.parse(JSON.stringify(m))); return true; };
    b.usable.delete("Gone_Field");
    x.state.filter = model(cond("Item_No", "eq", "BEFORE"));
    await S.open(x, "00000000000000c1");
    assert.equal(x.applied.length, 0, "nothing applied: the rows shown don't change");
    deq(x.state.filter, model(cond("Item_No", "eq", "BEFORE")));
    deq(drafts, [model(cond("Company", "eq", "CO_A"))], "the usable rest opens as a builder draft");
    let notice = un(S.noticeHtml(x));
    assert.match(notice, /role="alert"/);
    assert.match(notice, /“Narrow” was not applied/);
    assert.match(notice, /would show more rows than it was saved for/);
    assert.match(notice, /Condition 2: it uses a field or setting you can't use now/);
    assert.match(notice, /data-action="fabric-s-apply-broader"[^>]*>Open anyway \(broader results\)</);
    assert.equal(/fabric-s-dismiss/.test(notice), false, "no Dismiss");
    assert.equal(notice.includes("Gone_Field"), false, "never names the field");
    assert.match(S.toolbarHtml(x), /not applied/);
    assert.match(p.said.at(-1), /was not applied/);
    S.onAction(x, "fabric-s-dismiss", { dataset: {} });
    assert.match(un(S.noticeHtml(x)), /was not applied/, "still there after a dismiss attempt");
    // Explicit: Open anyway applies the rest (dates too); the warning stays, now about broader results.
    S.onAction(x, "fabric-s-apply-broader", { dataset: {} });
    await settle();
    assert.equal(x.applied.length, 1);
    deq(x.applied[0].filter, model(cond("Company", "eq", "CO_A")));
    assert.equal(x.applied[0].dateFrom, "2026-01-01");
    notice = un(S.noticeHtml(x));
    assert.match(notice, /Broader results:/);
    assert.equal(/fabric-s-dismiss|fabric-s-apply-broader/.test(notice), false);
    // Update says plainly that it saves the broader version.
    S.onAction(x, "fabric-s-update", { dataset: { id: "00000000000000c1" } });
    assert.match(un(view.html), /will show more rows than it was saved for/);
    assert.match(un(view.html), /type="submit"[^>]*>Replace with the broader filter</);
    await S.onSubmit(x, "fabric-s-form", form("update", { id: "00000000000000c1" }));
    assert.equal(S.noticeHtml(x), "", "once saved, the open filter is what it holds");
  });

  test("M1: Apply from the builder ends the 'not applied' state; an OR-only skip is applied with a note; the server's broadens wins", async () => {
    const { S } = load(), b = backend();
    b.lists.set("u1:inventory", [
      { id: "00000000000000d1", name: "And", state: { filter: model(cond("Company", "eq", "CO_A"), cond("Gone_Field", "eq", "1")), orderBy: [], columns: [] } },
      { id: "00000000000000d2", name: "Or", state: { filter: model({ op: "or", items: [cond("Company", "eq", "CO_A"), cond("Gone_Field", "eq", "1")] }), orderBy: [], columns: [] } }
    ]);
    const { x } = await withList(S, b);
    x.setDraft = () => true;
    b.usable.delete("Gone_Field");
    await S.open(x, "00000000000000d1");
    assert.match(un(S.noticeHtml(x)), /was not applied/);
    x.state.filter = model(cond("Company", "eq", "CO_A")); // the person chose Apply in the builder
    assert.match(un(S.noticeHtml(x)), /Broader results:/);
    assert.equal(/not applied/.test(S.toolbarHtml(x)), false);
    // OR-only skip: narrower, so applied at once with the (dismissable) note.
    await S.open(x, "00000000000000d2");
    deq(x.applied.at(-1).filter, model({ op: "or", items: [cond("Company", "eq", "CO_A")] }));
    const note = un(S.noticeHtml(x));
    assert.match(note, /fabric-s-dismiss/);
    assert.equal(/not applied|Broader results/.test(note), false);
    // The server's flag decides when it sends one.
    assert.equal(S.item({ id: "00000000000000d3", name: "Flag", state: { filter: model({ op: "or", items: [cond("Company", "eq", "CO_A"), { unavailable: true }] }) }, valid: false, unavailable: ["filter.items.0.items.1"], broadens: true }).broadens, true);
    assert.equal(S.item({ id: "00000000000000d4", name: "F", state: { filter: model(cond("Company", "eq", "A"), { unavailable: true }) }, valid: false, unavailable: ["filter.items.1"], broadens: false }).broadens, false);
    // Without the flag (an older server) the client judges it, failing safe.
    assert.equal(S.broadensOf({ filter: model({ op: "or", items: [{ unavailable: true }, { unavailable: true }] }) }, ["filter.items.0.items.0", "filter.items.0.items.1"]), true);
    assert.equal(S.broadensOf({ filter: null }, ["filter"]), true);
    assert.equal(S.broadensOf({ filter: model(cond("Company", "eq", "A")), q: "abc" }, ["searchField"]), true);
    assert.equal(S.broadensOf({ filter: model(cond("Company", "eq", "A")) }, ["orderBy.0"]), false);
  });

  test("M1 without setDraft: not applied, the notice alone offers Open anyway", async () => {
    const { S } = load(), b = backend();
    b.lists.set("u1:inventory", [{ id: "00000000000000e1", name: "Withheld", state: { filter: model(cond("Gone_Field", "eq", "1")), orderBy: [], columns: [] } }]);
    const { x } = await withList(S, b);
    b.usable.delete("Gone_Field");
    await S.open(x, "00000000000000e1");
    assert.equal(x.applied.length, 0);
    const notice = un(S.noticeHtml(x));
    assert.match(notice, /was not applied/);
    assert.equal(/filter builder/.test(notice), false, "no builder draft was opened");
    assert.match(notice, /Open anyway \(broader results\)/);
  });

  test("open: a whole filter withheld, a sort key dropped, an empty group pruned", async () => {
    const { S } = load(), b = backend();
    const { x } = await withList(S, b);
    S.st(x).items = [S.item({ id: "00000000000000b1", name: "Old", state: { filter: model({ op: "or", items: [{ unavailable: true }] }), orderBy: [], columns: [] }, valid: false, unavailable: ["filter.items.0.items.0", "orderBy.0", "searchField"] })];
    const { state, notes } = S.applicable(x, S.st(x).items[0]);
    assert.equal(state.filter, null, "a group left empty is removed, and an empty root means no filter");
    deq(notes, ["Condition 1 in group 1: it uses a field or setting you can't use now", "Sort key 1: its field can't be used now", "The search field: searching covers the usual fields instead"]);
    assert.match(S.describePath("filter"), /All filter conditions/);
  });

  test("unsaved-changes indicator, Update with confirmation (PUT state), then clean again", async () => {
    const { S } = load(), b = backend();
    b.lists.set("u1:inventory", [{ id: "00000000000000c1", name: "Mine", state: { filter: model(cond("Company", "eq", "CO_A")), orderBy: [], columns: ["Company"] } }]);
    const { x, view } = await withList(S, b);
    await S.open(x, "00000000000000c1");
    assert.equal(S.isDirty(x), false);
    assert.doesNotMatch(S.toolbarHtml(x), /Unsaved changes/);
    x.state.q = "pump";
    assert.equal(S.isDirty(x), true);
    assert.equal(S.navItems(x)[0].dirty, true);
    const bar = S.toolbarHtml(x);
    assert.match(bar, /Unsaved changes/);
    assert.match(bar, /data-action="fabric-s-update" data-ds="inventory" data-id="00000000000000c1"/);
    assert.match(bar, />Save as new…</);
    S.onAction(x, "fabric-s-update", { dataset: { id: "00000000000000c1" } });
    assert.match(un(view.html), /data-mode="update"/);
    assert.match(un(view.html), /Replace what “Mine” holds with the current view/);
    assert.equal(b.calls.filter(([m]) => m === "PUT").length, 0, "nothing changes before the confirmation");
    await S.onSubmit(x, "fabric-s-form", form("update", { id: "00000000000000c1" }));
    const put = b.calls.find(([m]) => m === "PUT");
    assert.equal(put[1], "/fabric/saved-filters/inventory/00000000000000c1");
    assert.equal(put[2].state.q, "pump"); assert.equal(put[2].name, undefined);
    assert.equal(S.isDirty(x), false);
    assert.equal(view.html, "");
  });

  test("rename (PUT name, duplicate refused) and delete (confirm, DELETE, current cleared)", async () => {
    const { S } = load(), b = backend();
    b.lists.set("u1:inventory", [{ id: "00000000000000d1", name: "Alpha", state: {} }, { id: "00000000000000d2", name: "Beta", state: {} }]);
    const { x, view, p } = await withList(S, b);
    S.onAction(x, "fabric-s-rename", { dataset: { id: "00000000000000d1" } });
    assert.match(un(view.html), /data-mode="rename"[^>]*data-id="00000000000000d1"/);
    assert.match(un(view.html), /value="Alpha"/);
    await S.onSubmit(x, "fabric-s-form", form("rename", { id: "00000000000000d1", name: "beta" }));
    assert.match(un(view.html), /You already have a saved filter named “Beta”/);
    await S.onSubmit(x, "fabric-s-form", form("rename", { id: "00000000000000d1", name: "Gamma" }));
    deq(b.calls.find(([m]) => m === "PUT").slice(1), ["/fabric/saved-filters/inventory/00000000000000d1", { name: "Gamma" }]);
    deq(S.navItems(x).map((i) => i.name).sort(), ["Beta", "Gamma"]);
    await S.open(x, "00000000000000d2");
    S.onAction(x, "fabric-s-delete", { dataset: { id: "00000000000000d2" } });
    assert.match(un(view.html), /data-mode="delete"/);
    assert.match(un(view.html), /class="fx-btn fx-btn--danger">Delete</);
    assert.match(un(view.html), /This can't be undone/);
    await S.onSubmit(x, "fabric-s-form", form("delete", { id: "00000000000000d2" }));
    deq(b.calls.find(([m]) => m === "DELETE").slice(0, 2), ["DELETE", "/fabric/saved-filters/inventory/00000000000000d2"]);
    deq(S.navItems(x).map((i) => i.name), ["Gamma"]);
    assert.equal(S.active(x), null);
    assert.match(p.said.at(-1), /deleted\. The rows shown don't change/);
  });

  test("manage dialog lists every saved filter with Open, Rename, Update and Delete; returns to it after a change", async () => {
    const { S } = load(), b = backend();
    b.lists.set("u1:inventory", [{ id: "00000000000000e1", name: HOSTILE, state: {} }]);
    const { x, view } = await withList(S, b);
    assert.match(S.toolbarHtml(x), /data-action="fabric-s-manage"/);
    S.onAction(x, "fabric-s-manage", { dataset: {} });
    for (const a of ["open", "rename", "update", "delete"]) assert.match(un(view.html), new RegExp(`data-action="fabric-s-${a}" data-ds="inventory" data-id="00000000000000e1"`));
    assert.equal(view.html.includes(HOSTILE), false, "names are escaped");
    S.onAction(x, "fabric-s-rename", { dataset: { id: "00000000000000e1", back: "manage" } });
    assert.match(un(view.html), /data-back="manage"/);
    await S.onSubmit(x, "fabric-s-form", form("rename", { id: "00000000000000e1", name: "Safe", back: "manage" }));
    assert.match(un(view.html), /data-mode="manage"/);
    assert.match(un(view.html), /<strong>Safe<\/strong>/);
  });

  test("specific errors: limit, deleted elsewhere (404, list refreshed), conflict, validation, session ended, load failure + retry", async () => {
    const { S } = load(), b = backend();
    b.lists.set("u1:inventory", [{ id: "00000000000000f1", name: "One", state: {} }]);
    const { x, view } = await withList(S, b);
    b.max = 1;
    S.onAction(x, "fabric-s-save", { dataset: {} });
    await S.onSubmit(x, "fabric-s-form", form("save", { name: "Two" }));
    assert.match(un(view.html), /Couldn't save “Two”\. You have 50 saved filters for Inventory, the most allowed/);
    // Deleted in another window: the rename answers 404; the list is refreshed and the dialog closes with a notice.
    b.lists.get("u1:inventory").length = 0;
    S.onAction(x, "fabric-s-rename", { dataset: { id: "00000000000000f1" } });
    await S.onSubmit(x, "fabric-s-form", form("rename", { id: "00000000000000f1", name: "Renamed" }));
    await settle();
    assert.equal(view.html, "");
    assert.match(un(S.noticeHtml(x)), /This saved filter no longer exists/);
    deq(S.navItems(x), []);
    const text = (status, code) => S.errorText(x, err(status, code), "save “A”");
    assert.match(text(409, "CONFLICT"), /changed at the same moment/);
    assert.match(text(400, "VALIDATION_ERROR"), /The server didn't accept it/);
    assert.match(S.errorText(x, Object.assign(new Error("x"), { code: "UNAUTHENTICATED", cause: { status: 401 } })), /Your session has ended/);
    assert.match(text(403, "INSUFFICIENT_SCOPE"), /You don't have access to saved filters for Inventory/);
    assert.match(text(429, "RATE_LIMITED"), /Too many requests/);
    assert.match(S.errorText(x, Object.assign(err(500, "INTERNAL_ERROR"), { requestId: "req-12345678" })), /Reference: req-12345678\./);
    // A failed load: the Objects panel gets a "Try again" row (opening it loads again).
    const t2 = explorer(b, "sales"); b.fail = err(503, "SERVICE_UNAVAILABLE");
    assert.equal(S.navItems(t2.x), null); await settle(); await settle();
    const [retry] = S.navItems(t2.x);
    assert.equal(retry.id, "_retry"); assert.equal(retry.invalid, true); assert.match(retry.problem, /Couldn't load your saved filters/);
    S.onAction(t2.x, "fabric-s-open", { dataset: { id: "_retry" } }); await settle(); await settle();
    deq(S.navItems(t2.x), []);
  });

  test("delete answered 204 with no body: confirmed by reading the list again, not reported as a failure", async () => {
    const { S } = load(), b = backend();
    b.lists.set("u1:inventory", [{ id: "0000000000000d04", name: "Temp", state: {} }]);
    const { x, view, p } = await withList(S, b);
    b.emptyBody204 = true;
    S.onAction(x, "fabric-s-delete", { dataset: { id: "0000000000000d04" } });
    await S.onSubmit(x, "fabric-s-form", form("delete", { id: "0000000000000d04" }));
    deq(S.navItems(x), []);
    assert.equal(view.html, "", "the dialog closes as for any delete");
    assert.match(p.said.at(-1), /Saved filter Temp deleted/);
    deq(b.calls.slice(-2).map(([m]) => m), ["DELETE", "GET"]);
  });

  test("a double submit sends one request", async () => {
    const { S } = load(), b = backend();
    const { x } = await withList(S, b);
    const f = form("save", { name: "Once" });
    await Promise.all([S.onSubmit(x, "fabric-s-form", f), S.onSubmit(x, "fabric-s-form", f)]);
    assert.equal(b.calls.filter(([m]) => m === "POST").length, 1);
  });

  test("ownership is the server's: the client shows what it is given and a foreign ID is just 'not found'", async () => {
    const { S } = load(), b = backend();
    b.lists.set("u2:inventory", [{ id: "0000000000000999", name: "Someone else's", state: {} }]);
    const { x, view } = await withList(S, b);
    deq(S.navItems(x), [], "u1's list is what u1's GET returned");
    S.st(x).items = [S.item({ id: "0000000000000999", name: "Forged", state: {} })];
    S.onAction(x, "fabric-s-delete", { dataset: { id: "0000000000000999" } });
    await S.onSubmit(x, "fabric-s-form", form("delete", { id: "0000000000000999" }));
    assert.equal(b.lists.get("u2:inventory").length, 1, "the backend refused it");
    assert.match(un(S.noticeHtml(x)), /no longer exists/);
    assert.equal(view.html, "");
    for (const [, , body] of b.calls) assert.ok(body === undefined || !("userId" in body) && !("owner" in body));
  });

  test("sign-out and user change clear the cache; late answers for the previous user are dropped", async () => {
    const { S, fire } = load(), b = backend();
    b.lists.set("u1:inventory", [{ id: "0000000000000001", name: "U1 filter", state: {} }]);
    b.lists.set("u2:inventory", [{ id: "0000000000000002", name: "U2 filter", state: {} }]);
    const { x } = await withList(S, b);
    deq(S.navItems(x).map((i) => i.name), ["U1 filter"]);
    await S.open(x, "0000000000000001");
    fire("jarc-session-expired");
    assert.equal(S.states.size, 0);
    assert.equal(S.navItems(x), null, "nothing from before; loads again");
    await settle(); await settle();
    // A request in flight when the user changes: its answer never lands for the next person.
    S.forget();
    S.ensure(x); // u1's request is on its way
    b.user = "u2";
    await settle(); await settle();
    assert.equal(S.navItems(x), null, "u1's late answer was dropped");
    await settle(); await settle();
    deq(S.navItems(x).map((i) => i.name), ["U2 filter"]);
    assert.equal(S.active(x), null);
    fire("jarc-access-denied"); assert.equal(S.states.size, 0);
  });

  test("toolbar and dialogs: keyboard and screen-reader friendly, no inline styles, escaped values", async () => {
    const { S } = load(), b = backend();
    b.lists.set("u1:inventory", [{ id: "00000000000000a9", name: HOSTILE, state: {} }]);
    const { x, view } = await withList(S, b);
    await S.open(x, "00000000000000a9");
    const bar = S.toolbarHtml(x);
    assert.match(bar, /role="group" aria-label="Saved filters"/);
    assert.equal(bar.includes(HOSTILE), false);
    assert.equal(/style=/.test(bar), false);
    assert.ok([...bar.matchAll(/<button /g)].every(Boolean));
    assert.match(bar, /type="button"/);
    S.onAction(x, "fabric-s-save", { dataset: {} });
    assert.match(un(view.html), /aria-labelledby="fabric-inventory-sf-title"/);
    assert.match(un(view.html), /<h2 id="fabric-inventory-sf-title"/);
    assert.match(un(view.html), /aria-describedby="fabric-inventory-sf-help fabric-inventory-sf-error"/);
    assert.match(un(view.html), /data-action="close-overlay"[^>]*>Cancel</);
    assert.match(view.cls, /fx-api-overlay/, "reuses the compact Fabric dialog styling (dark and light)");
    assert.equal(/style=/.test(view.html), false);
    S.onAction(x, "fabric-s-delete", { dataset: { id: "00000000000000a9" } });
    assert.equal(view.html.includes(HOSTILE), false);
  });

  // 13-browser-responsive-review.md D3: every close path gives focus back to the control that opened the first dialog.
  test("D3: the dialog names its opener by focus key, keeps it from Manage to Rename, and closeDialog focuses it (or the fallback)", async () => {
    const { S, document } = load(), b = backend();
    b.lists.set("u1:inventory", [{ id: "00000000000000d3", name: "Weekly", state: {} }]);
    const { x, view } = await withList(S, b);
    const keyed = (key) => ({ closest: (sel) => (sel === "[data-focus-key]" ? { dataset: { focusKey: key } } : null) });
    const focused = [], els = {};
    document.querySelector = (sel) => {
      if (sel === "#overlay-root .fx-sf-dialog") { const m = /data-return-focus-key="([^"]*)"/.exec(view.html); return m ? { dataset: { returnFocusKey: m[1] } } : null; }
      const m = /^\[data-focus-key="([^"]+)"\]$/.exec(sel);
      return m && els[m[1]] ? { focus: () => focused.push(m[1]) } : null;
    };
    document.activeElement = keyed("sf-bar-manage");
    S.onAction(x, "fabric-s-manage", { dataset: {} });
    assert.match(view.html, /data-return-focus-key="sf-bar-manage"/);
    document.activeElement = keyed("sf-m-rename-00000000000000d3"); // the Rename… button inside Manage
    S.onAction(x, "fabric-s-rename", { dataset: { id: "00000000000000d3", back: "manage" } });
    assert.match(view.html, /data-mode="rename"[^>]*data-return-focus-key="sf-bar-manage"/, "the first opener is kept");
    els["sf-bar-manage"] = true;
    S.closeDialog(x, "sf-bar-save");
    await settle(5);
    deq(focused, ["sf-bar-manage"], "focus back on Manage");
    // The opener is gone after the change (e.g. Manage after the last delete): the fallback.
    document.activeElement = keyed("sf-bar-manage");
    S.onAction(x, "fabric-s-manage", { dataset: {} });
    delete els["sf-bar-manage"]; els["sf-bar-save"] = true;
    S.closeDialog(x, "sf-bar-save");
    await settle(5);
    deq(focused, ["sf-bar-manage", "sf-bar-save"]);
    // From the builder's Save filter (the builder has closed) or a control without a key: back to Filters.
    view.html = "";
    document.activeElement = keyed("fb-save");
    S.onAction(x, "fabric-s-save", { dataset: {} });
    assert.match(view.html, /data-return-focus-key="filters"/);
    view.html = "";
    document.activeElement = { closest: () => null };
    S.onAction(x, "fabric-s-save", { dataset: {} });
    assert.match(view.html, /data-return-focus-key="filters"/);
  });

  test("D6: Manage uses the fx-btn icon + label structure with its full name; the Manage dialog has its own compact styles", async () => {
    const { S } = load(), b = backend();
    b.lists.set("u1:inventory", [{ id: "00000000000000d6", name: "Weekly", state: {} }]);
    const { x, view } = await withList(S, b);
    const bar = un(S.toolbarHtml(x));
    assert.match(bar, /<button type="button" class="fx-btn fx-sf-bar__manage" data-action="fabric-s-manage"[^>]*aria-label="Manage saved filters…"[^>]*title="Manage saved filters"[^>]*><svg[^>]*>.*?<\/svg><span>Manage…<\/span><\/button>/);
    assert.match(bar, /class="fx-btn fx-sf-bar__save"[^>]*><svg[^>]*>.*?<\/svg><span>Save filter…<\/span>/);
    S.onAction(x, "fabric-s-manage", { dataset: {} });
    assert.match(un(view.html), /<form class="fx-dialog fx-sf-dialog"[^>]*>.*<div class="fx-dialog__body"><ul class="fx-sf-manage"/);
    const css = read("fabric-filter.css");
    assert.match(css, /\.fx-sf-overlay \.fx-sf-manage \{ list-style: none; margin: 0; padding: 0;/);
    assert.match(css, /\.fx-sf-overlay \.fx-sf-manage__actions \{ display: inline-flex; flex-wrap: wrap; gap: 4px; \}/);
    assert.match(css, /\.fx-app \.fx-sf-bar \{ display: inline-flex; align-items: center; gap: 4px;/);
    // The compact toolbar is for wide screens only; touch keeps 34 px row actions.
    assert.match(css, /@media \(min-width: 1025px\) \{[^}]*\.fx-search \{ flex: 1 1 128px;/);
    assert.match(css, /@media \(pointer: coarse\), \(max-width: 1024px\) \{ \.fx-sf-overlay \.fx-sf-manage__actions \.fx-btn \{ height: 34px; \} \}/);
  });
});
