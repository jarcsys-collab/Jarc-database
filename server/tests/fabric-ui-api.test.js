// Fabric Data → API Management, redesigned (site/assets/FabricApiPanel.js, FabricApiDocs.js): the compact toolbar, Keys · Activity
// · Documentation strip, fx-grid tables and fx-dialog windows. Drives the unchanged browser files in a vm with a stubbed overlay
// root, a stubbed adapter and a fake clipboard: no server, no network. Synthetic data only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const SRC = path.resolve(__dirname, "..", "src");
const read = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");
const HOSTILE = `<img src=x onerror="alert(1)">`;
const SECRET = "jarc_SYNTHETICsecretVALUEforTESTSonly0123456789";
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const viewEscape = (s) => String(s).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));

// The overlay root is a string; #fabric-api-secret is a fake input read from (and written back to) that string.
function load() {
  const root = { innerHTML: "", dataset: {} };
  let secretInput = null;
  const document = {
    documentElement: { dataset: {}, style: { setProperty() {} } }, querySelectorAll: () => [], addEventListener() {},
    body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    querySelector(sel) {
      if (sel === "#overlay-root") return root;
      if (sel === "#fabric-api-secret") {
        const m = /id="fabric-api-secret"[^>]*value="([^"]*)"/.exec(root.innerHTML);
        if (!m) return null;
        if (!secretInput || secretInput.html !== root.innerHTML) {
          secretInput = { html: root.innerHTML, value: unescape(m[1]), focus() {}, select() {},
            setAttribute(name, v) { if (name === "value") { root.innerHTML = root.innerHTML.replace(/(id="fabric-api-secret"[^>]*value=")[^"]*"/, `$1${v}"`); this.html = root.innerHTML; } } };
        }
        return secretInput;
      }
      return null;
    }
  };
  const copied = [];
  const navigator = { clipboard: { writeText: async (t) => { copied.push(t); } } };
  const window = { location: { origin: "https://jarc.example.test", pathname: "/fabric/api", search: "" }, addEventListener() {}, dispatchEvent() {} };
  const timers = [];
  const context = vm.createContext({ window, document, navigator, console, Intl, Date, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, setTimeout: (...a) => { timers.push(a); return setTimeout(...a); }, clearTimeout, setInterval: () => { throw new Error("no polling"); }, CSS: { escape: (v) => v } });
  for (const f of ["AppView.js", "FabricApiDocs.js", "FabricApiPanel.js", "FabricExplorer.js", "FabricDataPanel.js"]) vm.runInContext(read(f), context, { filename: f });
  const get = (name) => vm.runInContext(name, context);
  return { context, root, copied, get, FabricApiPanel: get("FabricApiPanel"), FabricApiDocs: get("FabricApiDocs"), FabricDataPanel: get("FabricDataPanel"), AppView: get("AppView") };
}

// A FabricApiPanel on a stub Fabric panel; adapter.request answers from `answers` (exact path → value, function or Error).
function apiPanel(env, { features = { read: true, apiAdmin: true, apiTokens: true }, answers = {} } = {}) {
  const calls = [], toasts = [];
  const adapter = { async request(method, p, body) { calls.push([method, p, body]); const a = answers[`${method} ${p}`] ?? answers[p]; if (a === undefined) throw Object.assign(new Error("no answer"), { code: "NOT_FOUND", cause: { status: 404 } }); if (a instanceof Error) throw a; return typeof a === "function" ? a(body) : a; } };
  const view = new env.AppView({ innerHTML: "" });
  view.closeOverlay = () => { env.root.innerHTML = ""; };
  view.toast = (t) => toasts.push(t);
  let redraws = 0;
  const fabric = { c: { view }, adapter, features, datasetAllowed: (ds) => !Array.isArray(features.datasets) || features.datasets.includes(ds), redraw() { redraws += 1; }, skeleton: () => `<div class="skeleton"></div>`, focusTab() {} };
  const panel = new env.FabricApiPanel(fabric);
  return { panel, calls, toasts, view, redraws: () => redraws };
}
const TOKENS = { tokens: [
  { id: "t1", name: HOSTILE, description: HOSTILE, prefix: "jarc_ab", status: "active", scopes: ["fabric.sensitive.read", "fabric.sales.read"], owner: { id: "u1", name: HOSTILE }, createdAt: "2026-03-01T00:00:00Z", expiresAt: "2027-03-01T00:00:00Z", lastUsedAt: null, requestCount: 1234 },
  { id: "t2", name: "Old BI", prefix: "jarc_cd", status: "revoked", scopes: ["fabric.inventory.read"], owner: { id: "u2", name: "Synthetic Owner" }, revokedBy: { name: "Synthetic Admin" }, createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z", lastUsedAt: "2026-02-01T00:00:00Z", requestCount: 3 }
] };
const ACTIVITY = { items: [{ action: "token.created", at: "2026-03-01T00:00:00Z", token: { id: "t1", name: HOSTILE, prefix: "jarc_ab" }, actor: { name: HOSTILE }, owner: { name: "Synthetic Owner" } }] };
const loaded = async (env, opts = {}) => { const p = apiPanel(env, { answers: { "GET /fabric/api-tokens": TOKENS, "GET /fabric/api-tokens/activity": ACTIVITY, ...(opts.answers || {}) }, ...(opts.features ? { features: opts.features } : {}) }); p.panel.ensure(); await settle(); return p; };

describe("Fabric API Management: layout and permissions", () => {
  test("only Fabric API administrators get the API Management section", () => {
    const env = load();
    const panelFor = (features) => { const view = new env.AppView({ innerHTML: "" }); const c = { model: { features: { fabricData: features }, storage: { adapter: { request: async () => ({}) } }, screen: "fabric" }, view, update() {}, syncBoardUrl() {} }; return new env.FabricDataPanel(c); };
    const ids = (p) => p.sections().map(([id]) => id);
    assert.ok(!ids(panelFor({ read: true })).includes("api"), "a reader has no API Management");
    assert.ok(!ids(panelFor({ read: true, apiAdmin: true })).includes("api"), "API tokens must be on as well");
    assert.ok(!ids(panelFor({ read: true, apiTokens: true })).includes("api"), "not without apiAdmin");
    assert.ok(ids(panelFor({ read: true, apiAdmin: true, apiTokens: true })).includes("api"));
  });

  test("compact toolbar (Create key, Refresh), Keys · Activity · Documentation tab strip, keys in an fx-grid", async () => {
    const env = load();
    const { panel } = await loaded(env);
    const html = panel.html();
    assert.match(html, /class="fx-toolbar fx-api__toolbar" role="toolbar"/);
    assert.match(html, /data-action="fabric-api-new">[\s\S]*?Create key/);
    assert.match(html, /data-action="fabric-api-refresh"[^>]*>[\s\S]*?Refresh/);
    assert.match(html, /role="tablist"/);
    const tabs = [...html.matchAll(/role="tab" id="fabric-atab-(\w+)"[^>]*aria-selected="(\w+)"[^>]*tabindex="(-?\d)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2], m[3], m[4]]);
    assert.deepEqual(tabs, [["tokens", "true", "0", "Keys (2)"], ["activity", "false", "-1", "Activity"], ["docs", "false", "-1", "Documentation"]]);
    assert.match(html, /<div class="fx-grid fx-api__grid( has-hint)?" role="region" aria-label="Fabric API keys" tabindex="0"><table class="fx-grid__table fabric-api-tokens">/);
    // A short list: a hint (with Create key) fills the grid's empty area.
    assert.match(html, /<\/table><div class="fx-api__gridhint"><span>2 keys\. Create one key per integration[^<]*<\/span><button type="button" class="fx-btn" data-action="fabric-api-new"/);
    // The toolbar is the same on every tab: on Documentation, Refresh keeps its place (hidden, inert) and the count stays.
    panel.onAction("fabric-api-tab", { dataset: { tab: "docs" } });
    const docsBar = panel.html().match(/<div class="fx-toolbar fx-api__toolbar"[\s\S]*?<\/div>/)[0];
    assert.match(docsBar, /<button type="button" class="fx-btn fx-api__placeholder" disabled aria-hidden="true" tabindex="-1">/);
    assert.doesNotMatch(docsBar, /data-action="fabric-api-refresh"/);
    assert.match(docsBar, /Active keys<\/span> <strong>1<\/strong>/);
    panel.onAction("fabric-api-tab", { dataset: { tab: "tokens" } });
    const heads = [...html.match(/<thead>([\s\S]*?)<\/thead>/)[1].matchAll(/<th[^>]*>([^<]*)/g)].map((m) => m[1]);
    assert.deepEqual(heads.slice(0, 9), ["Name", "Prefix", "Datasets", "Status", "Owner", "Created", "Expires", "Last used", "Requests"]);
    assert.match(html, /<code>jarc_ab…<\/code>/);
    assert.match(html, /<span class="account-badge ">Sales<\/span> <span class="account-badge is-warn fabric-sensitive">Sensitive fields<\/span>/, "datasets first, then the sensitive badge");
    assert.match(html, /1,234/);
    assert.equal((html.match(/data-action="fabric-api-revoke"/g) || []).length, 1, "Revoke only for the active key");
    assert.match(html, /data-action="fabric-api-revoke" data-id="t1"/);
    assert.match(html, /Revoked<\/span> <small class="fx-api__sub">by Synthetic Admin<\/small>/);
    assert.match(html, /Active keys<\/span> <strong>1<\/strong>/);
  });

  test("a load failure shows an fx-status error with Try again", async () => {
    const env = load();
    const failure = Object.assign(new Error("x"), { code: "FORBIDDEN", cause: { status: 403, serverCode: "FABRIC_API_ADMIN_REQUIRED" }, requestId: "req-1" });
    const p = apiPanel(env, { answers: { "GET /fabric/api-tokens": failure, "GET /fabric/api-tokens/activity": ACTIVITY } });
    p.panel.ensure(); await settle();
    const html = p.panel.html();
    assert.match(html, /fx-status fx-status--error" role="alert"/);
    assert.match(html, /Only Fabric API administrators can manage Fabric API keys\. \(reference req-1\)/);
    assert.match(html, /data-action="fabric-api-refresh" data-focus-key="retry"/);
  });
});

describe("Fabric API Management: ownership (oversight admin, regular admin, reader without admin rights)", () => {
  // Synthetic identities: u-own is the signed-in person; u-other is another administrator.
  const ADMIN = { read: true, apiAdmin: true, apiTokens: true, sensitive: true };
  const KEYS = { tokens: [
    { id: "k-mine", name: "My BI", prefix: "jarc_m1", status: "active", scopes: ["fabric.sales.read"], owner: { id: "u-own", name: "Synthetic Self" }, createdAt: "2026-03-01T00:00:00Z", expiresAt: "2027-03-01T00:00:00Z", requestCount: 1 },
    { id: "k-other", name: "Their BI", prefix: "jarc_o1", status: "active", scopes: ["fabric.inventory.read"], owner: { id: "u-other", name: HOSTILE }, createdAt: "2026-03-01T00:00:00Z", expiresAt: "2027-03-01T00:00:00Z", requestCount: 2 }
  ] };
  const revokeIds = (html) => [...html.matchAll(/data-action="fabric-api-revoke" data-id="([^"]+)"/g)].map((m) => m[1]);

  test("a reader without admin rights gets no API Management section, even as a sensitive reader", () => {
    const env = load();
    const panelFor = (features) => { const view = new env.AppView({ innerHTML: "" }); const c = { model: { features: { fabricData: features }, storage: { adapter: { request: async () => ({}) } }, screen: "fabric" }, view, update() {}, syncBoardUrl() {} }; return new env.FabricDataPanel(c); };
    const ids = (p) => p.sections().map(([id]) => id);
    assert.ok(!ids(panelFor({ read: true, sensitive: true, apiAdmin: false, apiOversight: false, apiTokens: true })).includes("api"));
    assert.ok(ids(panelFor({ ...ADMIN, apiOversight: false })).includes("api"), "a regular administrator has it");
    assert.ok(ids(panelFor({ ...ADMIN, apiOversight: true })).includes("api"), "the oversight administrator has it");
  });

  test("regular admin: own keys marked \"Created by you\", Revoke only on their own key, own-activity wording", async () => {
    const env = load();
    const keys = { ...KEYS, tokens: KEYS.tokens.map((t) => ({ ...t, mine: t.id === "k-mine" })) };
    const { panel } = await loaded(env, { features: { ...ADMIN, apiOversight: false }, answers: { "GET /fabric/api-tokens": keys } });
    const html = panel.html();
    assert.match(html, /Your Fabric API keys: you can revoke only the keys you created\./);
    assert.doesNotMatch(html, /any Fabric API administrator can revoke any key/);
    assert.deepEqual(revokeIds(html), ["k-mine"], "no Revoke on someone else's key");
    assert.match(html, /<td data-label="Owner"><span class="fx-api__you">Created by you<\/span><\/td>/);
    assert.doesNotMatch(html, /<img/);
    panel.onAction("fabric-api-revoke", { dataset: { id: "k-other" } });
    assert.equal(env.root.innerHTML, "", "a hidden Revoke can't be triggered either");
    panel.onAction("fabric-api-revoke", { dataset: { id: "k-mine" } });
    assert.match(env.root.innerHTML, /data-action="fabric-api-revoke-form"/);
    assert.doesNotMatch(env.root.innerHTML, /It belongs to/, "no \"belongs to\" for your own key");
    panel.onAction("fabric-api-tab", { dataset: { tab: "activity" } });
    assert.match(panel.html(), /The latest audit entries for your Fabric API keys/);
    panel.onAction("fabric-api-tab", { dataset: { tab: "docs" } });
    assert.match(panel.html(), /Power BI[\s\S]*Power Automate[\s\S]*n8n/, "docs and integration examples for every administrator");
  });

  test("oversight admin: every key with its creator, Revoke on all active keys, the owner named in the confirmation", async () => {
    const env = load();
    const keys = { tokens: KEYS.tokens.map((t) => ({ ...t, mine: t.id === "k-mine" })), scope: "all" };
    const { panel } = await loaded(env, { features: { ...ADMIN, apiOversight: true }, answers: { "GET /fabric/api-tokens": keys } });
    const html = panel.html();
    assert.match(html, /you oversee them all and can revoke any key/);
    assert.deepEqual(revokeIds(html), ["k-mine", "k-other"]);
    assert.equal((html.match(/Created by you/g) || []).length, 1, "only the own key");
    assert.match(html, /<td data-label="Owner">&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;<\/td>/, "other creator by (escaped) name");
    panel.onAction("fabric-api-revoke", { dataset: { id: "k-other" } });
    assert.match(env.root.innerHTML, /It belongs to <strong>&lt;img/);
    panel.onAction("fabric-api-tab", { dataset: { tab: "activity" } });
    assert.match(panel.html(), /The latest entries of the Fabric key audit log/);
  });

  test("the list's scope (\"own\" | \"all\") decides; revoked keys never offer Revoke; an older server keeps Revoke on every active key", async () => {
    const env = load();
    const own = { tokens: KEYS.tokens.map((t) => ({ ...t, mine: t.id === "k-mine" })), scope: "own" };
    let p = await loaded(env, { features: { ...ADMIN, apiOversight: true }, answers: { "GET /fabric/api-tokens": own } });
    assert.deepEqual(revokeIds(p.panel.html()), ["k-mine"], "scope \"own\" wins over features");
    assert.match(p.panel.html(), /Your Fabric API keys/);
    p = await loaded(env, { features: ADMIN, answers: { "GET /fabric/api-tokens": { ...own, scope: "all" } } });
    assert.deepEqual(revokeIds(p.panel.html()), ["k-mine", "k-other"]);
    p = await loaded(env, { features: { ...ADMIN, apiOversight: true }, answers: { "GET /fabric/api-tokens": { tokens: own.tokens.map((t) => ({ ...t, status: "revoked" })), scope: "all" } } });
    assert.deepEqual(revokeIds(p.panel.html()), []);
    p = await loaded(env, { features: ADMIN, answers: { "GET /fabric/api-tokens": KEYS } });
    assert.deepEqual(revokeIds(p.panel.html()), ["k-mine", "k-other"], "no ownership reported: unchanged behaviour");
    assert.match(p.panel.html(), /any Fabric API administrator can revoke any key/);
  });

  test("the sensitive scope is offered only when the server says this person may grant it", () => {
    const env = load();
    const offered = (features) => { apiPanel(env, { features }).panel.showCreate(); return /name="sensitive"/.test(env.root.innerHTML) && /fabric\.sensitive\.read/.test(env.root.innerHTML); };
    assert.equal(offered({ ...ADMIN, canGrantSensitive: true }), true);
    assert.equal(offered({ ...ADMIN, canGrantSensitive: false }), false, "canGrantSensitive: false wins over sensitive: true");
    assert.equal(offered({ read: true, apiAdmin: true, apiTokens: true, sensitive: false, canGrantSensitive: true }), true, "the server's capability decides");
    assert.equal(offered({ read: true, apiAdmin: true, apiTokens: true, sensitive: false }), false);
    assert.equal(offered(ADMIN), true, "no capability field: falls back to sensitive");
    for (const ds of ["sales", "inventory"]) { apiPanel(env, { features: { ...ADMIN, canGrantSensitive: false } }).panel.showCreate(); assert.match(env.root.innerHTML, new RegExp(`name="ds-${ds}"`)); }
  });
});

describe("Fabric API Management: create, the one-time key, revoke", () => {
  test("create dialog: an fx-dialog with Sales / Inventory scopes; Sensitive fields only with features.sensitive (or cost)", async () => {
    const env = load();
    const plain = apiPanel(env);
    plain.panel.showCreate();
    let html = env.root.innerHTML;
    assert.match(html, /<div class="overlay apitok-overlay fx-api-overlay" data-action="close-overlay"><form class="fx-dialog fx-api-dialog" role="dialog" aria-modal="true" data-action="fabric-api-create-form" aria-labelledby="fabric-api-new-title">/);
    assert.match(html, /class="fx-dialog__head"[\s\S]*class="fx-dialog__body"[\s\S]*class="fx-dialog__foot"/);
    assert.match(html, /name="ds-sales"[^>]*checked/); assert.match(html, /name="ds-inventory"[^>]*checked/);
    assert.match(html, /fabric\.sales\.read/); assert.match(html, /fabric\.inventory\.read/);
    assert.doesNotMatch(html, /name="sensitive"/); assert.doesNotMatch(html, /fabric\.sensitive\.read/);
    assert.match(html, /type="date" name="expires" required min="\d{4}-\d{2}-\d{2}" max="\d{4}-\d{2}-\d{2}"/);
    assert.match(html, /data-action="close-overlay">Cancel<\/button><button type="submit" class="fx-btn fx-btn--primary">Create key/);
    for (const features of [{ read: true, apiAdmin: true, apiTokens: true, sensitive: true }, { read: true, apiAdmin: true, apiTokens: true, cost: true }]) {
      apiPanel(env, { features }).panel.showCreate();
      assert.match(env.root.innerHTML, /name="sensitive"/); assert.match(env.root.innerHTML, /fabric\.sensitive\.read/);
    }
    apiPanel(env, { features: { read: true, apiAdmin: true, apiTokens: true, sensitive: false, cost: true } }).panel.showCreate();
    assert.doesNotMatch(env.root.innerHTML, /name="sensitive"/, "sensitive: false wins over the older name");
    apiPanel(env, { features: { read: true, apiAdmin: true, apiTokens: true, datasets: ["sales"] } }).panel.showCreate();
    assert.match(env.root.innerHTML, /name="ds-sales"/); assert.doesNotMatch(env.root.innerHTML, /name="ds-inventory"/);
  });

  test("submit: scopes as before, at least one dataset, expiry within 5 years, never sensitive without the right", async () => {
    const env = load();
    const s = apiPanel(env, { features: { read: true, apiAdmin: true, apiTokens: true, sensitive: true }, answers: { "POST /fabric/api-tokens": { token: { name: "N", scopes: ["fabric.sales.read"] }, secret: SECRET } } });
    s.panel.reveal = () => {};
    let said = "";
    const form = (sales, inventory, sensitive, expires = s.panel.dateInput(30)) => ({ elements: { name: { value: " Power BI " }, description: { value: "" }, expires: { value: expires }, "ds-sales": { checked: sales }, "ds-inventory": { checked: inventory }, sensitive: { checked: sensitive } }, querySelector: (q) => (q === ".apitok-error" ? { set textContent(t) { said = t; } } : null) });
    await s.panel.submitCreate(form(false, false, true));
    assert.equal(s.calls.length, 0); assert.match(said, /at least one dataset/);
    const tooLate = new Date(); tooLate.setFullYear(tooLate.getFullYear() + 5, tooLate.getMonth(), tooLate.getDate() + 2);
    await s.panel.submitCreate(form(true, false, false, s.panel.localDate(tooLate)));
    assert.equal(s.calls.length, 0); assert.match(said, /up to 5 years/);
    await s.panel.submitCreate(form(true, false, false));
    let [method, p, body] = s.calls.at(-1);
    assert.equal(method, "POST"); assert.equal(p, "/fabric/api-tokens"); assert.deepEqual(JSON.parse(JSON.stringify(body.scopes)), ["fabric.sales.read"]); assert.equal(body.name, "Power BI");
    assert.ok(new Date(body.expiresAt) > new Date());
    await s.panel.submitCreate(form(true, true, true));
    assert.deepEqual(JSON.parse(JSON.stringify(s.calls.at(-1)[2].scopes)), ["fabric.sales.read", "fabric.inventory.read", "fabric.sensitive.read"]);
    const n = apiPanel(env, { answers: { "POST /fabric/api-tokens": { token: {}, secret: SECRET } } }); n.panel.reveal = () => {};
    await n.panel.submitCreate(form(false, true, true));
    assert.deepEqual(JSON.parse(JSON.stringify(n.calls.at(-1)[2].scopes)), ["fabric.inventory.read"]);
    const refused = Object.assign(new Error("x"), { code: "FORBIDDEN", cause: { status: 403, serverCode: "FABRIC_SENSITIVE_ACCESS_REQUIRED" } });
    const r = apiPanel(env, { features: { read: true, apiAdmin: true, apiTokens: true, sensitive: true }, answers: { "POST /fabric/api-tokens": refused } });
    await r.panel.submitCreate(form(true, false, true));
    assert.match(said, /can't grant sensitive fields/);
  });

  test("the key is shown once, copied from the dialog only, and cleared when the dialog closes", async () => {
    const env = load();
    const s = await loaded(env, { answers: { "POST /fabric/api-tokens": { token: { name: HOSTILE, scopes: ["fabric.sales.read"], expiresAt: "2027-01-01T00:00:00Z" }, secret: SECRET } } });
    const before = s.calls.length;
    let said = "";
    await s.panel.submitCreate({ elements: { name: { value: "BI" }, description: { value: "" }, expires: { value: s.panel.dateInput(30) }, "ds-sales": { checked: true }, "ds-inventory": { checked: false } }, querySelector: (q) => (q === ".apitok-error" ? { set textContent(t) { said = t; } } : null) });
    assert.equal(said, "");
    assert.equal(s.calls.length, before + 1);
    const html = env.root.innerHTML;
    assert.match(html, /data-keep-open="1"/, "Escape and outside clicks don't close it");
    assert.match(html, /class="fx-dialog fx-api-dialog apitok-modal" role="dialog" aria-modal="true"/);
    assert.match(html, /fx-status fx-status--warn[\s\S]*shown once: you won't see it again/);
    assert.match(html, /id="fabric-api-secret" class="fx-field__value fx-field__value--key" type="text" readonly/);
    assert.equal((html.match(new RegExp(SECRET, "g")) || []).length, 1, "the key appears once, as the input's value");
    assert.doesNotMatch(html, /<img/); assert.doesNotMatch(html, /data-action="close-overlay"/, "no close button: only \"I've saved it\"");
    assert.match(html, /<dl class="fx-api__review apikey-review">[\s\S]*Sales/);
    for (const [k, v] of Object.entries(s.panel)) assert.ok(!JSON.stringify(v === s.panel.f ? null : v ?? null).includes(SECRET), `the panel keeps no copy (${k})`);
    assert.ok(!s.panel.html().includes(SECRET), "never in the page body");
    s.panel.onAction("fabric-api-copy", { querySelector: () => ({ textContent: "" }) });
    await settle();
    assert.deepEqual(env.copied, [SECRET]);
    assert.deepEqual(s.toasts, ["Fabric API key copied"]);
    s.panel.onAction("fabric-api-done", {});
    assert.equal(env.root.innerHTML, "", "closed");
    assert.ok(!env.root.innerHTML.includes(SECRET));
    await settle();
    assert.deepEqual(s.calls.slice(before + 1).map(([m, p]) => `${m} ${p}`).sort(), ["GET /fabric/api-tokens", "GET /fabric/api-tokens/activity"], "the list reloads after closing");
    assert.ok(!s.panel.html().includes(SECRET));
    s.panel.onAction("fabric-api-copy", {}); await settle();
    assert.equal(env.copied.length, 1, "nothing left to copy");
  });

  test("revoke asks first (focus on Cancel), then one POST and a reload; a refusal keeps the dialog with the reason", async () => {
    const env = load();
    const s = await loaded(env, { answers: { "POST /fabric/api-tokens/t1/revoke": { token: { id: "t1", status: "revoked" } } } });
    const before = s.calls.length;
    s.panel.onAction("fabric-api-revoke", { dataset: { id: "nope" } });
    assert.equal(env.root.innerHTML, "", "an unknown id opens nothing");
    s.panel.onAction("fabric-api-revoke", { dataset: { id: "t1" } });
    const html = env.root.innerHTML;
    assert.equal(s.calls.length, before, "nothing is revoked before confirming");
    assert.match(html, /<form class="fx-dialog fx-api-dialog" role="dialog" aria-modal="true" data-action="fabric-api-revoke-form"/);
    assert.match(html, /Revoke &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;\?/); assert.doesNotMatch(html, /<img/);
    assert.match(html, /stops reading Fabric Data immediately/);
    assert.match(html, /data-action="close-overlay">Cancel<\/button><button type="submit" class="fx-btn fx-btn--danger">Revoke key/);
    let disabled = null;
    const form = { querySelector: (q) => (q === ".fx-btn--danger" ? { set disabled(v) { disabled = v; } } : q === ".apitok-error" ? { set textContent(t) { form.said = t; } } : null) };
    await s.panel.submitRevoke(form);
    assert.deepEqual(s.calls[before].slice(0, 2), ["POST", "/fabric/api-tokens/t1/revoke"]);
    assert.equal(env.root.innerHTML, ""); assert.deepEqual(s.toasts, ["Fabric API key revoked"]);
    await settle();
    assert.equal(s.calls.length, before + 3, "then the list and the activity reload once");
    // A refusal
    const failing = await loaded(env, { answers: { "POST /fabric/api-tokens/t1/revoke": Object.assign(new Error("x"), { code: "CONFLICT", cause: { status: 409, serverCode: "TOKEN_NOT_ACTIVE" } }) } });
    failing.panel.showRevoke(TOKENS.tokens[0]);
    await failing.panel.submitRevoke(form);
    assert.equal(form.said, "This key has already ended."); assert.equal(disabled, false);
    assert.notEqual(env.root.innerHTML, "", "the dialog stays open");
  });
});

describe("Fabric API Management: activity", () => {
  test("Activity → Refresh issues exactly one GET /activity and shows refused requests; no polling", async () => {
    const env = load();
    let round = 0;
    const later = { items: [{ action: "token.use_refused", reason: "revoked", at: "2026-03-02T00:00:00Z", token: { id: "t1", name: "Synthetic BI", prefix: "jarc_ab" }, owner: { name: "Synthetic Owner" } }, ...ACTIVITY.items] };
    const s = await loaded(env, { answers: { "GET /fabric/api-tokens/activity": () => (round++ === 0 ? ACTIVITY : later) } });
    s.panel.onAction("fabric-api-tab", { dataset: { tab: "activity" } });
    let html = s.panel.html();
    assert.match(html, /data-action="fabric-api-activity-refresh"/); assert.doesNotMatch(html, /data-action="fabric-api-refresh"/);
    assert.match(html, /aria-label="Fabric API activity"/); assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /Request refused/);
    const before = s.calls.length;
    s.panel.onAction("fabric-api-activity-refresh", {});
    s.panel.onAction("fabric-api-activity-refresh", {}); // a second click while loading does nothing
    assert.match(s.panel.html(), /disabled aria-busy="true"[^>]*>[\s\S]*?Refreshing…/);
    await settle();
    assert.deepEqual(s.calls.slice(before).map(([m, p]) => `${m} ${p}`), ["GET /fabric/api-tokens/activity"], "exactly one request");
    html = s.panel.html();
    assert.match(html, /Request refused<\/span> <small class="fx-api__sub">\(revoked\)<\/small>/);
    assert.match(html, /Keys \(2\)/, "the key list is kept");
    await settle(30);
    assert.equal(s.calls.length, before + 1, "nothing polls");
  });

  test("an activity refresh failure keeps the rows and says why", async () => {
    const env = load();
    let round = 0;
    const s = await loaded(env, { answers: { "GET /fabric/api-tokens/activity": () => { if (round++ === 0) return ACTIVITY; throw Object.assign(new Error("x"), { code: "RATE_LIMITED", cause: { status: 429, serverCode: "RATE_LIMITED" } }); } } });
    s.panel.tab = "activity";
    await s.panel.refreshActivity();
    const html = s.panel.html();
    assert.match(html, /The activity couldn't be refreshed\.<\/strong> Too many requests/);
    assert.match(html, /Created/);
  });
});

describe("Fabric API Management: documentation", () => {
  const docs = (env, origin = "https://jarc.example.test") => env.FabricApiDocs.html((v) => viewEscape(v ?? ""), origin);
  test("the error table has the codes the server sends, each verified in the backend source", () => {
    const env = load();
    const html = docs(env);
    const rows = [...html.matchAll(/<tr><td class="fx-api-docs__nowrap">(\d{3})<\/td><td>(.*?)<\/td>/g)].map((m) => [m[1], [...m[2].matchAll(/<code>([A-Z_]+)<\/code>/g)].map((x) => x[1])]);
    const has = (status, code) => rows.some(([s, codes]) => s === status && codes.includes(code));
    for (const [status, code] of [["401", "INVALID_TOKEN"], ["401", "TOKEN_REVOKED"], ["401", "TOKEN_EXPIRED"], ["401", "UNAUTHENTICATED"], ["400", "TOKEN_IN_QUERY"], ["400", "VALIDATION_ERROR"], ["405", "METHOD_NOT_ALLOWED"], ["403", "INSUFFICIENT_SCOPE"], ["403", "TOKEN_ACCESS_REVOKED"], ["404", "NOT_FOUND"], ["404", "FABRIC_RECORD_NOT_FOUND"], ["422", "FABRIC_RANGE_TOO_LARGE"], ["429", "RATE_LIMITED"], ["503", "FABRIC_BUSY"], ["503", "FABRIC_UNAVAILABLE"]]) assert.ok(has(status, code), `${status} ${code}`);
    assert.ok(!has("429", "FABRIC_BUSY"), "FABRIC_BUSY is a 503");
    const unauth = html.match(/<td><code>UNAUTHENTICATED<\/code><\/td><td>([^<]*)/)[1];
    assert.match(unauth, /No Authorization header/); assert.doesNotMatch(unauth, /valid/, "an invalid key is INVALID_TOKEN, not UNAUTHENTICATED");
    assert.match(html, /Retry-After/);
    // Every documented [status, code] is one the backend really sends.
    const backend = ["routes/external-api.js", "routes/external-fabric.js", "services/api-token-service.js", "fabric/router.js", "fabric/errors.js", "fabric/validation.js", "middleware/errors.js"].map((f) => fs.readFileSync(path.join(SRC, f), "utf8")).join("\n");
    const { STATUS } = { STATUS: Object.fromEntries([...fs.readFileSync(path.join(SRC, "fabric/errors.js"), "utf8").match(/const STATUS = Object\.freeze\(\{([^}]*)\}/)[1].matchAll(/(\w+): (\d{3})/g)].map((m) => [m[1], m[2]])) };
    for (const [status, codes] of env.FabricApiDocs.ERRORS) for (const code of codes) {
      const sent = STATUS[code] === status || new RegExp(`(ApiError|sendError)\\((res, )?${status}, "${code}"`).test(backend);
      assert.ok(sent, `${status} ${code} is sent by the backend`);
    }
  });

  test("restricted fields per dataset match the server's lists, with the sensitive-scope AND owner-permission rule", () => {
    const env = load();
    const { datasetNamed } = require("../src/fabric/datasets");
    for (const ds of ["sales", "inventory"]) assert.deepEqual([...env.FabricApiDocs.RESTRICTED[ds]], [...datasetNamed(ds).sensitive], ds);
    assert.deepEqual([...env.FabricApiDocs.RESTRICTED.sales], ["landed_cost", "Text", "Custom", "custom_1", "Custom.2"]);
    assert.deepEqual([...env.FabricApiDocs.RESTRICTED.inventory], ["Cost_Amount_Expected", "Cost_Amount_Actual", "Cost_Amount_Non_Invtbl", "Cost_Amount_Expected_ACY", "Cost_Amount_Actual_ACY", "Cost_Amount_Non_Invtbl_ACY", "landed_cost", "distributors_price", "trade_price"]);
    const html = docs(env);
    assert.match(html, /<td class="fx-api-docs__nowrap"><code>sales<\/code><\/td><td><code>landed_cost<\/code>, <code>Text<\/code>, <code>Custom<\/code>, <code>custom_1<\/code>, <code>Custom\.2<\/code><\/td>/);
    assert.match(html, /<code>inventory<\/code><\/td><td><code>Cost_Amount_Expected<\/code>, [\s\S]*<code>trade_price<\/code><\/td>/);
    assert.match(html, /only<\/strong> when the key has <code>fabric\.sensitive\.read<\/code> <strong>and<\/strong> the key's owner still has the sensitive-fields permission/);
  });

  test("examples: Power Automate leaves cursor out of the first call; Power BI uses a parameter and MissingField.UseNull; shapes as observed", () => {
    const env = load();
    const html = docs(env);
    const block = (id) => unescape(html.match(new RegExp(`id="fabric-api-example-${id}" tabindex="0"><code>([\\s\\S]*?)</code>`))[1]);
    const automate = block("automate");
    assert.match(automate, /if\(empty\(variables\('cursor'\)\),'',concat\('&cursor=',encodeUriComponent\(variables\('cursor'\)\)\)\)/);
    assert.doesNotMatch(automate, /"cursor": "@\{variables\('cursor'\)\}"/, "no empty cursor on the first call");
    const m = block("m");
    assert.match(m, /Key {4}= FabricToken/); assert.match(m, /Manage Parameters/); assert.match(m, /MissingField\.UseNull/);
    assert.match(m, /if cursor = null then \[\] else \[cursor = cursor\]/); assert.match(m, /RelativePath = "api\/v1\/external\/fabric\/sales\/records"/);
    assert.match(block("n8n"), /\{\{ !\$response\.body\.pagination\.hasMore \}\}/);
    assert.match(block("curl"), /-H "Authorization: Bearer \$FABRIC_API_KEY"/);
    const page = JSON.parse(block("page"));
    assert.deepEqual(Object.keys(page.items[0]), ["id", "values"]);
    assert.deepEqual(Object.keys(page.pagination), ["limit", "hasMore", "nextCursor"]);
    assert.deepEqual(Object.keys(page.window), ["field", "dateFrom", "dateTo", "defaulted"]);
    assert.deepEqual(Object.keys(JSON.parse(block("record")).record), ["id", "key", "fields"]);
    for (const id of ["schema", "errors"]) JSON.parse(block(id));
  });

  test("placeholders only: no real-looking key, no other collection or people wording, every value escaped", () => {
    const env = load();
    const html = docs(env, `https://x.test/${HOSTILE}`);
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /jarc_[A-Za-z0-9]{20,}/);
    // [A-Z][a-z]+User also covers the directory source collection's name, without writing it here (public repository).
    assert.doesNotMatch(html, /\b[A-Z][a-z]+User\b|employee|Employee/);
    assert.doesNotMatch(html, /\/invoices|sales-lines/);
    for (const f of ["FabricApiDocs.js", "FabricApiPanel.js"]) assert.doesNotMatch(read(f), /\b[A-Z][a-z]+User\b|employee/i, f);
    for (const f of ["FabricApiDocs.js", "FabricApiPanel.js"]) assert.doesNotMatch(read(f).replace(/^\s*\/\/.*$/gm, ""), /localStorage|sessionStorage|indexedDB|setInterval/, f);
  });
});

describe("Fabric API Management: connection details (per-dataset endpoints, Copy connection details)", () => {
  const BASE = "https://jarc.example.test/api/v1/external/fabric";
  const copyOf = (html) => unescape(html.match(/data-action="fabric-api-copy-conn" data-copy="([^"]*)"/)[1]);
  const endpointsIn = (html) => [...html.matchAll(/data-action="fabric-api-copy-value" data-copy="([^"]*)"/g)].map((m) => unescape(m[1]));

  test("a new key: the one-time secret unchanged, then each authorized dataset's ID, schema and records URLs with Copy; the base URL is a prefix", async () => {
    const env = load();
    const s = await loaded(env, { answers: { "POST /fabric/api-tokens": { token: { name: "BI", prefix: "jarc_ab", scopes: ["fabric.sales.read", "fabric.inventory.read"], expiresAt: "2027-01-01T00:00:00Z" }, secret: SECRET } } });
    await s.panel.submitCreate({ elements: { name: { value: "BI" }, description: { value: "" }, expires: { value: s.panel.dateInput(30) }, "ds-sales": { checked: true }, "ds-inventory": { checked: true } }, querySelector: () => null });
    const html = env.root.innerHTML;
    assert.equal((html.match(new RegExp(SECRET, "g")) || []).length, 1, "the secret is still only the input's value");
    assert.match(html, /class="fx-dialog fx-api-dialog apitok-modal" role="dialog"/);
    assert.match(html, /Base URL <small>\(prefix\)<\/small>/);
    assert.match(html, /not callable by itself/);
    const urls = endpointsIn(html);
    for (const u of [BASE, "sales", "inventory", `${BASE}/sales/schema`, `${BASE}/sales/records`, `${BASE}/inventory/schema`, `${BASE}/inventory/records`, "Authorization: Bearer <your API key>"]) assert.ok(urls.includes(u), u);
    assert.match(html, /<span class="fx-api-conn__verb">GET<\/span> https:\/\/jarc\.example\.test\/api\/v1\/external\/fabric\/sales\/records<\/code>/);
    s.panel.onAction("fabric-api-copy-value", { dataset: { copy: `${BASE}/inventory/records`, label: "Inventory records endpoint" } });
    await settle();
    assert.deepEqual(env.copied, [`${BASE}/inventory/records`]);
    assert.ok(s.toasts.includes("Inventory records endpoint copied"));
    s.panel.onAction("fabric-api-copy-conn", { dataset: { copy: copyOf(html) } });
    await settle();
    const text = env.copied[1];
    assert.ok(!text.includes(SECRET) && !/jarc_[A-Za-z0-9]{20,}/.test(text), "never the secret");
    for (const part of [`Base URL (a prefix, not callable by itself`, `  ${BASE}`, "Method: GET", "Authorization: Bearer <your API key>", "400 TOKEN_IN_QUERY",
      `Schema:  GET ${BASE}/sales/schema`, `Records: GET ${BASE}/sales/records`, `Schema:  GET ${BASE}/inventory/schema`, `Records: GET ${BASE}/inventory/records`,
      "dataset ID: sales", "dataset ID: inventory", "pagination.hasMore", "cursor=<pagination.nextCursor>", "1 to 200 rows per page (100 by default)", "limit=200",
      "dateFrom and dateTo: YYYY-MM-DD, UTC days, both inclusive, at most 92 days", "Sales is always windowed", "30 days", "60 requests per minute",
      "30 requests in 10 seconds", "3 requests at the same time", "429 RATE_LIMITED", "503 FABRIC_BUSY", "Retry-After"]) assert.ok(text.includes(part), part);
    assert.ok(s.toasts.includes("Connection details copied"));
    s.panel.onAction("fabric-api-done", {});
    assert.equal(env.root.innerHTML, "");
  });

  test("the copied numbers are the server's (validation.js LIMITS, datasets.js windows, the token rate and the per-caller limits)", () => {
    const env = load();
    const { LIMITS } = require("../src/fabric/validation");
    const { FABRIC_RATE } = require("../src/routes/external-fabric");
    const { datasetNamed } = require("../src/fabric/datasets");
    const L = env.FabricApiPanel.LIMITS;
    assert.equal(L.pageMax, LIMITS.recordPageMax); assert.equal(L.pageDefault, LIMITS.recordPageDefault);
    assert.equal(L.maxDays, LIMITS.maxDays); assert.equal(L.defaultDays, LIMITS.defaultDays);
    assert.equal(L.perMinute, FABRIC_RATE.perWindow); assert.equal(FABRIC_RATE.windowMs, 60000);
    assert.equal(datasetNamed("sales").windowOptionalWhenSmall, false, "Sales is always windowed");
    assert.equal(datasetNamed("inventory").windowOptionalWhenSmall, true);
    assert.equal(datasetNamed("inventory").sorts.entryNo.requiresCompany, true);
    const router = fs.readFileSync(path.join(SRC, "fabric/router.js"), "utf8");
    assert.match(router, new RegExp(`const PER_WINDOW = ${L.burst}, WINDOW_MS = ${L.burstSeconds} \\* 1000;`));
    assert.match(router, new RegExp(`const PER_CALLER_IN_FLIGHT = ${L.inFlight};`));
  });

  test("an existing key: Connection details on every row opens its datasets' endpoints, never a secret; a revoked key says it no longer works", async () => {
    const env = load();
    const s = await loaded(env);
    const html = s.panel.html();
    assert.deepEqual([...html.matchAll(/data-action="fabric-api-details" data-id="(\w+)"/g)].map((m) => m[1]), ["t1", "t2"], "on active and ended keys");
    s.panel.onAction("fabric-api-details", { dataset: { id: "nope" } });
    assert.equal(env.root.innerHTML, "", "an unknown id opens nothing");
    s.panel.onAction("fabric-api-details", { dataset: { id: "t1" } });
    let dialog = env.root.innerHTML;
    assert.match(dialog, /role="dialog" aria-modal="true" aria-labelledby="fabric-api-details-title"/);
    assert.doesNotMatch(dialog, /<img/, "escaped");
    assert.match(dialog, /The secret isn't shown again/);
    assert.doesNotMatch(dialog, /id="fabric-api-secret"/);
    const urls = endpointsIn(dialog);
    assert.ok(urls.includes(`${BASE}/sales/schema`) && urls.includes(`${BASE}/sales/records`));
    assert.ok(!urls.some((u) => u.includes("/inventory/")), "only the key's datasets (t1: Sales + sensitive)");
    assert.ok(!urls.some((u) => u.includes("sensitive")), "the sensitive scope is not a dataset");
    const text = copyOf(dialog);
    assert.match(text, /Sensitive fields: included \(fabric\.sensitive\.read\)/);
    assert.doesNotMatch(text, /inventory\/records/);
    assert.match(dialog, /data-action="close-overlay">Done<\/button>/);
    s.panel.onAction("fabric-api-details", { dataset: { id: "t2" } });
    dialog = env.root.innerHTML;
    assert.match(dialog, /This key no longer works \(Revoked\)/);
    assert.ok(endpointsIn(dialog).includes(`${BASE}/inventory/records`));
    assert.ok(!endpointsIn(dialog).some((u) => u.includes("/sales/")));
    assert.equal(s.calls.filter(([m]) => m !== "GET").length, 0, "details never call the server");
    for (const [k, v] of Object.entries(s.panel)) assert.ok(!JSON.stringify(v === s.panel.f ? null : v ?? null).includes(SECRET), k);
  });

  test("documentation: the base URL is a prefix; the Google Apps Script example keeps the key in Script Properties, pages with limit=200 and retries 429/503", () => {
    const env = load();
    const html = env.FabricApiDocs.html((v) => viewEscape(v ?? ""), "https://jarc.example.test");
    assert.match(html, /<dt>Base URL \(prefix\)<\/dt><dd><code>https:\/\/jarc\.example\.test\/api\/v1\/external\/fabric<\/code>: not callable by itself/);
    const apps = unescape(html.match(/id="fabric-api-example-apps" tabindex="0"><code>([\s\S]*?)<\/code>/)[1]);
    assert.doesNotThrow(() => new Function(apps), "valid JavaScript");
    assert.match(apps, /PropertiesService\.getScriptProperties\(\)/);
    assert.match(apps, /getProperty\("FABRIC_API_KEY"\)/); assert.match(apps, /getProperty\("FABRIC_BASE_URL"\)/);
    assert.match(apps, /FABRIC_BASE_URL = https:\/\/jarc\.example\.test\/api\/v1\/external\/fabric/);
    assert.match(apps, /headers: \{ Authorization: "Bearer " \+ key \}/);
    assert.match(apps, /fabricGet_\("\/sales\/schema"\)/);
    assert.match(apps, /dateFrom: "2026-06-01", dateTo: "2026-06-30", limit: "200"/);
    assert.match(apps, /params\.cursor = page\.pagination\.nextCursor/); assert.match(apps, /while \(page\.pagination\.hasMore\)/);
    assert.match(apps, /status === 429 \|\| status === 503/); assert.match(apps, /Retry-After/);
    assert.match(apps, /muteHttpExceptions: true/);
    // The key never goes into the query: only the dataset parameters are encoded into it.
    const queryParts = apps.match(/const query = [\s\S]*?;\n/)[0];
    assert.doesNotMatch(queryParts, /key\b(?!s)/);
    for (const name of ["token", "api_key", "apikey", "access_token"]) assert.doesNotMatch(apps, new RegExp(`[?&]${name}=`));
  });
});

describe("Fabric API Management: stylesheet and page", () => {
  test("fabric-api.css is scoped (.fx-app / the API overlay) and uses --fx- tokens; index.html links it after jarc-theme.css", () => {
    const css = read("fabric-api.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...css.matchAll(/(^|[{}])\s*([^{}@]+)\{/g)].map((m) => m[2].trim()).filter((s) => s && !/^(from|to|\d+%)$/.test(s));
    for (const group of selectors) for (const sel of group.split(",").map((x) => x.trim())) assert.match(sel, /^(:root\[data-theme=dark\] )?(\.fx-app|:where\(\.fx-app \.fx-api\)|\.fx-api|\.fx-api-overlay)(?![\w-])/, sel);
    assert.match(css, /var\(--fx-surface/); assert.match(css, /var\(--fx-border-strong/);
    const html = fs.readFileSync(path.resolve(ASSETS, "..", "index.html"), "utf8");
    assert.ok(html.indexOf("assets/fabric-api.css") > html.indexOf("assets/jarc-theme.css"));
    assert.equal((html.match(/assets\/fabric-api\.css/g) || []).length, 1);
  });
});
