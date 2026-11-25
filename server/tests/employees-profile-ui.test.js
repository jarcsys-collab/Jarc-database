// People directory profile page (site/assets/EmployeeProfile.js): sections, "Not recorded", the field allow-list (no phones or
// raw IDs even when a response carries them), escaping, admin-only fields, copy rules, stale snapshot, actions and focus hooks.
// The browser file runs unchanged in a vm with no DOM and no network. Synthetic data only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
const ID1 = "A".repeat(22), ID2 = "b".repeat(21) + "_";
const HOSTILE = `<script>alert(1)</script>"><img src=x onerror="alert(2)">`;

function load({ clipboard, nodes = {}, document: custom = null } = {}) {
  const requests = [], storage = [];
  const forbidden = (name) => () => { requests.push(name); throw new Error(`${name} is not allowed`); };
  const store = { getItem: () => null, setItem: (k) => storage.push(k), removeItem() {} };
  const focused = [];
  const node = (sel) => ({ sel, focus() { focused.push(sel); }, querySelector: (s) => nodes[s] === false ? null : node(s) });
  const document = custom || { querySelector: (s) => (nodes[s] === false ? null : node(s)) };
  const context = vm.createContext({ window: {}, document, navigator: { clipboard }, console, Intl, Date, Map, Set, WeakMap, JSON, Number, String, Array, Object, RegExp, Promise, setTimeout, clearTimeout,
    localStorage: store, sessionStorage: store, indexedDB: { open: forbidden("indexedDB") }, fetch: forbidden("fetch"), XMLHttpRequest: forbidden("XMLHttpRequest") });
  for (const f of ["AppView.js", "EmployeeProfile.js"]) vm.runInContext(read(f), context, { filename: f });
  const get = (n) => vm.runInContext(n, context);
  return { requests, storage, focused, AppView: get("AppView"), P: get("EmployeeProfile") };
}
function explorer(env, over = {}) {
  const view = new env.AppView({ innerHTML: "" }), calls = [], announced = [];
  return { ds: "active", recordId: ID1, calls, announced, record: { loading: false, error: null },
    p: { announce: (t) => announced.push(t) },
    esc: (v) => view.escape(v ?? ""), attr: (v) => view.attr(v),
    listHref() { return "/admin/employees/active"; }, recordHref(id) { return `/admin/employees/active/records/${id}`; },
    onAction(action) { calls.push(action); }, retry() { calls.push("retry"); }, ...over };
}
const values = (over = {}) => ({ displayName: "Synthetic Person 1", givenName: "Synthetic", surname: "Person", mail: "person1@example.com", userPrincipalName: "person1@example.com",
  jobTitle: "Analyst", department: "Dept A", officeLocation: "Office 1", emailDomain: "example.com", accountCreated: "2024-03-05T10:00:00.000Z", ...over });
const rec = (v = values(), snapshot = { ingestedAt: "2026-11-24T06:00:00.000Z", stale: false }) => ({ id: ID1, values: v, snapshot });
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("EmployeeProfile page", () => {
  test("draws the header, Back to list and all four sections with dl/dt/dd", () => {
    const env = load(), x = explorer(env), html = env.P.html(x, rec(), null);
    assert.match(html, /<h2 class="emp-p__title" id="emp-p-title-active" tabindex="-1">Synthetic Person 1<\/h2>/);
    assert.match(html, /<a class="fx-btn emp-p__back" href="\/admin\/employees\/active" data-action="emp-p-back"[^>]*>.*Back to list<\/a>/);
    assert.match(html, /class="emp-p__avatar" aria-hidden="true">SP</);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /Analyst <span aria-hidden="true">·<\/span> Dept A/);
    for (const t of ["Identity", "Contact", "Organization", "Directory account"]) assert.match(html, new RegExp(`<h3 class="emp-p__section-title"[^>]*>${t}</h3>`));
    assert.equal((html.match(/<dl /g) || []).length, 4);
    assert.equal((html.match(/<dt /g) || []).length, (html.match(/<dd /g) || []).length);
    for (const l of ["Name", "First name", "Last name", "Email", "Sign-in name", "Job title", "Department", "Office", "Email domain", "Directory account created"]) assert.match(html, new RegExp(`<dt class="emp-p__label">${l}</dt>`));
    assert.match(html, /<a class="fx-link emp-p__mail" href="mailto:person1@example.com">person1@example.com<\/a>/);
    assert.match(html, /data-action="emp-p-copy"[^>]*data-copy="person1@example.com"/);
    assert.match(html, /Phone numbers are not available in this directory view\./);
    assert.match(html, /<time class="emp-p__text" datetime="2024-03-05T10:00:00.000Z">[^<]*2024[^<]*<\/time>/);
    assert.match(text(html), /Source: Microsoft Entra ID directory snapshot · updated [^.]*2026/);
    assert.equal(env.requests.length, 0); assert.equal(env.storage.length, 0);
  });
  test("missing fields read Not recorded; nothing is invented", () => {
    const env = load(), html = env.P.html(explorer(env), rec({ displayName: "Synthetic Person 2", department: null, officeLocation: "", jobTitle: "   ", mail: null }), null);
    for (const f of ["department", "officeLocation", "jobTitle", "mail"]) {
      assert.match(html, new RegExp(`data-field="${f}"><dt[^>]*>[^<]*</dt><dd class="emp-p__value"><span class="emp-p__none">Not recorded</span></dd>`), f);
    }
    assert.doesNotMatch(html, /emp-p__subtitle/);
    assert.doesNotMatch(html, /mailto:|emp-p-copy/);
    const bare = env.P.html(explorer(env), { id: ID1, values: {}, snapshot: {} }, null);
    assert.match(bare, />Unnamed directory account</);
    assert.equal((bare.match(/Not recorded/g) || []).length, 10);
    assert.match(text(bare), /updated unknown/);
  });
  test("only allow-listed keys are read: phones, raw IDs and unknown keys never appear", () => {
    const env = load(), x = explorer(env);
    const v = values({ mobilePhone: "+00 111 222 333", businessPhones: ["+00 444 555"], user_id: "00000000-1111-2222-3333-444444444444", mobile_phone: "+00 999", company_name: "Hidden Co", secret: "S3CRET", __proto__: { jobTitle: "Inherited" } });
    const html = env.P.html(x, rec(v), { fields: [{ name: "mobilePhone", label: "Mobile" }, { name: "user_id", label: "Object ID" }] });
    for (const s of ["111 222", "444 555", "00000000-1111", "+00 999", "Hidden Co", "S3CRET", "Mobile", "Object ID", "mobilePhone", "businessPhones", "user_id"]) assert.ok(!html.includes(s), s);
    assert.ok(!html.includes("tel:"));
    const inherited = env.P.html(x, rec(Object.create({ jobTitle: "Inherited" })), null);
    assert.ok(!inherited.includes("Inherited"));
    // Objects and arrays in allow-listed keys are not drawn either.
    const odd = env.P.html(x, rec(values({ department: { toString: () => "Object Dept" }, jobTitle: ["Array Title"] })), null);
    assert.ok(!odd.includes("Object Dept") && !odd.includes("Array Title"));
  });
  test("hostile values are escaped everywhere", () => {
    const env = load(), x = explorer(env);
    const v = values({ displayName: HOSTILE, givenName: HOSTILE, jobTitle: HOSTILE, department: HOSTILE, mail: `a"b@example.com`, userPrincipalName: HOSTILE, accountType: HOSTILE, accountCreated: HOSTILE });
    const html = env.P.html(x, rec(v, { ingestedAt: HOSTILE, stale: false }), { fields: [{ name: "department", label: HOSTILE }] });
    assert.ok(!html.includes("<script>") && !html.includes("<img") && !/onerror="/.test(html));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;"));
    assert.ok(!html.includes("mailto:a\"b"), "an invalid address is not a link");
    assert.match(html, /data-copy="a&quot;b@example.com"/);
    assert.match(html, /data-field="accountCreated"><dt[^>]*>[^<]*<\/dt><dd class="emp-p__value"><span class="emp-p__none">Not recorded/);
  });
  test("admin-only fields appear only when the response has them; labels follow the copy rules", () => {
    const env = load(), x = explorer(env);
    const plain = env.P.html(x, rec(), null);
    assert.doesNotMatch(plain, /Sign-in enabled|Account type|emp-p__badge/);
    const admin = env.P.html(x, rec(values({ accountEnabled: false, accountType: "Member" })), null);
    assert.match(admin, /<dt class="emp-p__label">Sign-in enabled<\/dt><dd class="emp-p__value"><span class="emp-p__text">No<\/span>/);
    assert.match(admin, /<dt class="emp-p__label">Account type<\/dt><dd class="emp-p__value"><span class="emp-p__text">Member<\/span>/);
    assert.match(admin, /This account is disabled in Microsoft Entra ID\./);
    assert.match(admin, /emp-p__badge--off">Sign-in disabled</);
    const on = env.P.html(x, rec(values({ accountEnabled: true, accountType: "Guest" })), null);
    assert.match(on, />Yes</); assert.doesNotMatch(on, /is disabled/);
    for (const h of [plain, admin, on]) {
      const t = text(h);
      assert.doesNotMatch(t, /\bemploy(ed|ee|ees|ment)\b/i);
      assert.doesNotMatch(t, /hire date|hired|\bcompany\b|Fabric/i);
    }
    // Schema labels win when present (raw schema or normalised byName).
    assert.match(env.P.html(x, rec(), { fields: [{ name: "department", label: "Team" }] }), /<dt class="emp-p__label">Team<\/dt>/);
    assert.match(env.P.html(x, rec(), { byName: new Map([["officeLocation", { label: "Site" }]]) }), /<dt class="emp-p__label">Site<\/dt>/);
  });
  test("stale snapshot shows a warning", () => {
    const env = load(), x = explorer(env);
    assert.doesNotMatch(env.P.html(x, rec(), null), /may be out of date/);
    assert.match(env.P.html(x, rec(values(), { ingestedAt: "2026-11-24T06:00:00.000Z", stale: true, staleReason: "CHECK_FAILED" }), null), /role="status"><span class="fx-status__msg">This directory snapshot may be out of date/);
    assert.ok(!env.P.html(x, rec(values(), { stale: true, staleReason: "CHECK_FAILED" }), null).includes("CHECK_FAILED"));
  });
  test("loading, not found and error states", () => {
    const env = load();
    assert.match(env.P.html(explorer(env, { record: { loading: true } }), null, null), /aria-busy="true"[\s\S]*Loading the profile/);
    assert.match(env.P.html(explorer(env, { record: { error: { code: "NOT_FOUND" } } }), null, null), /no longer in the directory snapshot/);
    const err = env.P.html(explorer(env, { record: { error: { code: "EMPLOYEES_UNAVAILABLE", message: HOSTILE } } }), null, null);
    assert.ok(!err.includes("<script>")); assert.match(err, /data-action="emp-p-retry"/);
  });
});

describe("EmployeeProfile actions and focus", () => {
  test("back: plain click goes to the list and focus returns to the row; modified click is left to the browser", () => {
    const env = load(), x = explorer(env); let prevented = 0;
    const ev = { preventDefault() { prevented += 1; } };
    assert.equal(env.P.onAction(x, "emp-p-back", { tagName: "A", dataset: {} }, ev), true);
    assert.deepEqual(x.calls, ["fabric-x-back"]); assert.equal(prevented, 1);
    assert.deepEqual(env.focused, [`[data-action="fabric-x-open"][data-id="${ID1}"]`]);
    assert.equal(env.P.onAction(x, "emp-p-back", { tagName: "A", dataset: {} }, { ctrlKey: true, preventDefault() { prevented += 1; } }), true);
    assert.deepEqual(x.calls, ["fabric-x-back"]); assert.equal(prevented, 1);
    assert.equal(env.P.onAction(x, "fabric-x-open", {}, {}), false);
    assert.equal(env.P.onAction(x, "emp-p-unknown", {}, {}), false);
  });
  test("restoreFocus falls back to the first row; invalid IDs are never put in a selector", () => {
    const env = load({ nodes: { [`[data-action="fabric-x-open"][data-id="${ID2}"]`]: false } }), x = explorer(env);
    env.P.rememberRow(x, ID2); env.P.restoreFocus(x);
    assert.deepEqual(env.focused, [`[data-action="fabric-x-open"]`]);
    const y = explorer(env); env.P.rememberRow(y, `"]</x>`); env.P.restoreFocus(y);
    assert.equal(env.focused.at(-1), `[data-action="fabric-x-open"]`);
    assert.equal(env.P.focusHeading(x), true); assert.equal(env.focused.at(-1), "#emp-p-title-active");
    assert.equal(env.P.focusHeading(explorer(env, { ds: `x"]` })), true); assert.equal(env.focused.at(-1), "#emp-p-title-active");
  });
  test("Back after a direct address: focus waits for the rows, then lands on the row; with no rows, the results or heading", async () => {
    // A tiny DOM: rows appear only once "drawn"; activeElement is the body until something is focused.
    const make = () => {
      const state = { rows: [], results: false, focused: [] };
      const doc = { body: { tag: "BODY" }, documentElement: { tag: "HTML" }, activeElement: null };
      const el = (sel) => ({ sel, focus() { state.focused.push(sel); doc.activeElement = this; } });
      doc.activeElement = doc.body;
      const find = (s) => {
        if (s === "#employees-root") return null;
        const m = /^\[data-action="fabric-x-open"\](?:\[data-id="([^"]+)"\])?$/.exec(s);
        if (m) { const id = m[1] ? state.rows.find((r) => r === m[1]) : state.rows[0]; return id ? el(`row:${id}`) : null; }
        if (s === `[data-focus-key="results"]`) return state.results ? el("results") : null;
        if (s === "#employees-title") return el("heading");
        return null;
      };
      doc.querySelector = find;
      return { state, doc };
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    { // the list loads after Back, then its rows are drawn: focus goes to the profile's row
      const { state, doc } = make(), env = load({ document: doc }); env.P.FOCUS_DELAY = 5;
      const x = explorer(env, { recordId: "", records: { loading: false, data: null, error: null } });
      env.P.rememberRow(x, ID2);
      assert.equal(env.P.restoreFocus(x), false, "no rows yet");
      assert.deepEqual(state.focused, []);
      x.records.loading = true; await wait(20); assert.deepEqual(state.focused, [], "still loading");
      x.records = { loading: false, data: { items: [{}, {}] }, error: null }; state.rows = [ID1, ID2]; state.results = true;
      await wait(20);
      assert.deepEqual(state.focused, [`row:${ID2}`]);
    }
    { // the list loads with no rows: the heading (no results region)
      const { state, doc } = make(), env = load({ document: doc }); env.P.FOCUS_DELAY = 5;
      const x = explorer(env, { recordId: "", records: { loading: true, data: null, error: null } });
      env.P.restoreFocus(x);
      x.records = { loading: false, data: { items: [] }, error: null };
      await wait(20);
      assert.deepEqual(state.focused, ["heading"]);
    }
    { // bounded: it gives up after FOCUS_RETRIES and falls back
      const { state, doc } = make(), env = load({ document: doc }); env.P.FOCUS_DELAY = 1; env.P.FOCUS_RETRIES = 3;
      const x = explorer(env, { recordId: "", records: { loading: true, data: null, error: null } });
      env.P.restoreFocus(x); await wait(40);
      assert.deepEqual(state.focused, ["heading"]);
    }
    { // a profile opened again, or focus moved elsewhere meanwhile: it stops quietly
      const { state, doc } = make(), env = load({ document: doc }); env.P.FOCUS_DELAY = 5;
      const x = explorer(env, { recordId: "", records: { loading: true, data: null, error: null } });
      env.P.restoreFocus(x); x.recordId = ID1; x.records = { loading: false, data: { items: [{}] }, error: null }; state.rows = [ID1];
      await wait(20); assert.deepEqual(state.focused, []);
      const y = explorer(env, { recordId: "", records: { loading: true, data: null, error: null } });
      state.rows = []; env.P.restoreFocus(y); doc.activeElement = { tag: "INPUT" }; y.records = { loading: false, data: { items: [{}] }, error: null }; state.rows = [ID1];
      await wait(20); assert.deepEqual(state.focused, []);
    }
  });
  test("the snapshot time is shown in UTC with a UTC suffix", () => {
    const env = load(), x = explorer(env);
    const html = env.P.html(x, rec(values(), { ingestedAt: "2026-11-24T23:30:00.000Z", stale: false }), null);
    const expected = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date("2026-11-24T23:30:00.000Z"));
    assert.ok(html.includes(`updated <time datetime="2026-11-24T23:30:00.000Z">${x.esc(`${expected} UTC`)}</time>.`), html.slice(html.indexOf("emp-p__source")));
    assert.match(env.P.html(x, rec(values(), { stale: false }), null), /updated unknown\./);
  });
  test("Escape returns to the list, except in text fields", () => {
    const env = load(), x = explorer(env);
    assert.equal(env.P.onKeydown(x, { key: "Escape", target: { tagName: "INPUT" } }), false);
    assert.equal(env.P.onKeydown(x, { key: "Enter", target: { tagName: "BUTTON" } }), false);
    assert.equal(env.P.onKeydown(x, { key: "Escape", target: { tagName: "BUTTON" }, preventDefault() {} }), true);
    assert.deepEqual(x.calls, ["fabric-x-back"]);
  });
  test("copy email uses the clipboard and announces the result", async () => {
    const copied = [], env = load({ clipboard: { writeText: async (t) => { copied.push(t); } } }), x = explorer(env);
    assert.equal(env.P.onAction(x, "emp-p-copy", { dataset: { copy: "person1@example.com" } }, {}), true);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(copied, ["person1@example.com"]); assert.deepEqual(x.announced, ["Email copied."]);
    const failing = load({ clipboard: { writeText: async () => { throw new Error("denied"); } } }), y = explorer(failing);
    failing.P.onAction(y, "emp-p-copy", { dataset: { copy: "person1@example.com" } }, {});
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(y.announced, ["The email couldn't be copied."]);
    const none = load(), z = explorer(none);
    none.P.onAction(z, "emp-p-copy", { dataset: { copy: "person1@example.com" } }, {});
    assert.deepEqual(z.announced, ["Copying isn't available in this browser."]);
    assert.equal(env.storage.length + failing.storage.length + none.storage.length, 0);
  });
  test("the asset never touches browser storage or the network", () => {
    const src = read("EmployeeProfile.js");
    assert.doesNotMatch(src, /localStorage\.|sessionStorage\.|indexedDB\.|BoardCache|fetch\(|XMLHttpRequest/);
    assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ""), /Fabric/);
  });
});
