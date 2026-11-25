// Command Center server search, Phase 1 quick fixes (B1–B9 in JARC-Search-Plan/05-frontend-experience.md).
// site/assets/CommandCenter.js is loaded unchanged into an isolated context with a minimal fake DOM, a fake adapter
// whose answers the test controls, and fake timers and clock — no server, no browser, no network.
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

const SOURCE = fs.readFileSync(path.resolve(__dirname, "..", "..", "site", "assets", "CommandCenter.js"), "utf8");
const hex = (n) => String(n).padStart(24, "a");
const ME = `user:${hex(9)}`;
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A StorageError as ApiAdapter.send produces it: the HTTP status's code, the server's own code only in cause.
const httpError = (code, serverCode = null, status = 503) => Object.assign(new Error("generic"), { name: "StorageError", code, cause: serverCode === undefined ? undefined : { status, serverCode } });
const SAVE_WORDING = /wasn't saved|isn't valid and/;

function setup() {
  // Fake timers.
  let clock = 1_000_000, nextId = 1; const timers = new Map();
  const setTimeoutFake = (fn, ms = 0) => { const id = nextId++; timers.set(id, { at: clock + Math.max(0, ms), fn }); return id; };
  const clearTimeoutFake = (id) => { timers.delete(id); };
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (ms) => {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); clock = Math.max(clock, due[1].at); due[1].fn(); await flush();
    }
    clock = until; await flush();
  };

  // Fake DOM: just what CommandCenter touches.
  let open = false;
  const node = () => ({ innerHTML: "", textContent: "", value: "", attrs: {}, dataset: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, focus() {}, querySelector: () => null, querySelectorAll: () => [] });
  const input = node(), results = node(), status = node(), filters = node();
  const modal = node();
  modal.querySelector = (sel) => (sel === "[data-region=filters]" ? filters : sel === ".command-results" ? results : sel === ".command-status" ? status : null);
  const document = {
    get activeElement() { return input; }, body: {},
    querySelector: (sel) => (!open ? null : sel === "#overlay-root .command-modal" ? modal : sel === ".command-modal [data-action=command-search]" ? input : null),
    querySelectorAll: () => []
  };

  // Fake adapter: every search is recorded and answered by the test.
  const calls = [];
  const adapter = {
    searchGlobal(params) { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); calls.push({ params: Object.fromEntries(params), resolve, reject }); return p; },
    request: () => Promise.resolve({ items: [] })
  };
  const columns = [{ key: "serial", label: "Item", type: "text" }, { key: "status", label: "Status", type: "status", options: ["To do", "Done"] }, { key: "owner", label: "Owner", type: "owner" }, { key: "notes", label: "Notes", type: "text" }];
  const model = {
    storage: { adapter },
    workspaces: [{ id: "w1", name: "Field operations", boards: [{ id: "b1", name: "Service jobs", columns, records: [
      { id: "r1", serial: "JOB-1", status: "To do", owner: [ME], notes: "Replace kestrel guard" },
      { id: "r2", serial: "JOB-2", status: "Done", owner: [], notes: "Inspect boiler" }
    ] }] }],
    serverId: (id) => ({ w1: hex(1), b1: hex(2), r1: hex(3), r2: hex(4) })[id] || id,
    people: new Map([[ME, { displayName: "Mia", isYou: true }]]),
    personName: (x) => x, favoriteBoards: [], recentBoardItems: [], recentRecords: [], allRecords: [], recentCommands: [],
    screen: "home", workspace: { role: "MEMBER" }, idOf: (x) => x,
    openBoard() {}, switchWorkspace() {}, rememberRecord() {}
  };
  const view = { escape, attr: escape, mark: (t, q) => escape(t), overlay() { open = true; }, closeOverlay() { open = false; }, toast() {} };
  const controller = { model, view, signedIn: true, focusedControl: () => null, root: null };

  const context = vm.createContext({ document, CSS: { escape: (s) => s }, icon: () => "", columnTypeIcons: {}, navigator: { platform: "Win32" }, setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake, URLSearchParams, Promise, console });
  const CommandCenter = vm.runInContext(`${SOURCE}\n;CommandCenter`, context);
  const cc = new CommandCenter(controller);
  cc.now = () => clock;
  const typeText = (q) => { input.value = q; cc.onInput(q); };
  const text = () => results.innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return { cc, calls, advance, flush, typeText, text, results, status, input, model, get open() { return open; } };
}

const answer = (items = [], extra = {}) => ({ groups: [{ type: "record", items, more: false, next: null, ...extra }, { type: "comment", items: [], more: false, next: null }], partial: false });
const serverRecord = (n, title) => ({ id: hex(100 + n), type: "record", title, snippet: title, target: { recordId: hex(100 + n), boardId: hex(2), workspaceId: hex(1) }, meta: {} });

describe("Command Center search quick fixes (B1–B9)", () => {
  let t;
  beforeEach(() => { t = setup(); t.cc.open(); });

  test("B1: a 503 SEARCH_TIMEOUT (code only in cause.serverCode) shows the timeout message and keeps open-board matches, labelled partial", async () => {
    t.typeText("kestrel"); await t.advance(250);
    t.calls[0].reject(httpError("SERVICE_UNAVAILABLE", "SEARCH_TIMEOUT")); await t.flush();
    const shown = t.text();
    assert.match(shown, /Search is taking too long across all boards\. Showing matches from open boards\./);
    assert.match(shown, /Partial results — only boards you have open\./);
    assert.match(t.results.innerHTML, /data-id="r1"/, "the local hit stays");
    assert.doesNotMatch(shown, /No matches for/);
    assert.match(t.status.textContent, /from open boards/, "the count isn't presented as complete");
  });

  test("SEARCH_UNAVAILABLE (Atlas engine down) is handled like a timeout: fallback, partial label, back-off", async () => {
    t.typeText("kestrel"); await t.advance(250);
    t.calls[0].reject(httpError("SERVICE_UNAVAILABLE", "SEARCH_UNAVAILABLE")); await t.flush();
    assert.match(t.text(), /isn(?:'|&#39;)t available right now\. Showing matches from open boards\./);
    assert.match(t.text(), /Partial results/);
    assert.match(t.results.innerHTML, /data-action="search-retry" disabled/);
  });

  test("B2: a 400 never shows the saving wording; it shows a search message and no Try again", async () => {
    t.typeText("kestrel"); await t.advance(250);
    t.calls[0].reject(httpError("VALIDATION_ERROR", "VALIDATION_ERROR", 400)); await t.flush();
    assert.doesNotMatch(t.results.innerHTML, SAVE_WORDING);
    assert.match(t.text(), /Type at least 2 characters, or change the filters\./);
    assert.doesNotMatch(t.results.innerHTML, /search-retry/);
  });

  test("B3: a client timeout or a 502/504 (no server code) shows the took-too-long message", async () => {
    for (const [i, error] of [httpError("SERVICE_UNAVAILABLE", undefined), httpError("SERVICE_UNAVAILABLE", null, 502), httpError("SERVICE_UNAVAILABLE", null, 504)].entries()) {
      t.typeText(`boiler ${i}`); await t.advance(250);
      t.calls.at(-1).reject(error); await t.flush();
      assert.match(t.text(), /The server took too long\. Try again in a moment\./, `case ${i}`);
      assert.doesNotMatch(t.results.innerHTML, SAVE_WORDING);
    }
  });

  test("B4: a 1-character q with filters sends the filters without q; without filters nothing is sent", async () => {
    t.typeText("k"); await t.advance(300);
    assert.equal(t.calls.length, 0, "1 character, no filters: no server call");
    t.cc.setFilter("status", "To do"); await t.advance(300);
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0].params.q, undefined, "no q under 2 characters");
    assert.equal(t.calls[0].params.status, "To do");
    t.typeText("ke"); await t.advance(300);
    assert.equal(t.calls.at(-1).params.q, "ke");
  });

  test("B5: an errored question isn't sent again by a trailing space, reopening, or re-choosing the same type", async () => {
    t.typeText("kestrel"); await t.advance(250);
    t.calls[0].reject(httpError("SERVICE_UNAVAILABLE", "SEARCH_TIMEOUT")); await t.flush();
    t.typeText("kestrel "); await t.advance(300);
    t.typeText("  kestrel"); await t.advance(300);
    t.cc.close(); t.cc.open("kestrel"); await t.advance(300);
    t.cc.onAction("cc-type", { dataset: { type: "all" } }); await t.advance(300);
    assert.equal(t.calls.length, 1, "no automatic repeat");
    assert.match(t.text(), /taking too long/, "the failure is still shown, not a fake empty result");
    // After the failure window a fresh visit may search again.
    await t.advance(30_000);
    t.typeText("kestrel x"); await t.advance(300); t.typeText("kestrel"); await t.advance(300);
    assert.equal(t.calls.filter((c) => c.params.q === "kestrel").length, 2);
  });

  test("B6: Try again is explicit and backs off after a timeout (5 s, then 10 s)", async () => {
    t.typeText("kestrel"); await t.advance(250);
    t.calls[0].reject(httpError("SERVICE_UNAVAILABLE", "SEARCH_TIMEOUT")); await t.flush();
    assert.match(t.results.innerHTML, /data-action="search-retry" disabled/);
    t.cc.retry(); await t.advance(0);
    assert.equal(t.calls.length, 1, "Try again does nothing during the back-off");
    await t.advance(5_100);
    assert.match(t.results.innerHTML, /data-action="search-retry">Try again</, "re-enabled after 5 s by a render");
    t.cc.retry(); await t.advance(0);
    assert.equal(t.calls.length, 2, "explicit retry sends");
    t.calls[1].reject(httpError("SERVICE_UNAVAILABLE", "SEARCH_TIMEOUT")); await t.flush();
    await t.advance(5_100); t.cc.retry(); await t.advance(0);
    assert.equal(t.calls.length, 2, "second back-off is longer than 5 s");
    await t.advance(5_000); t.cc.retry(); await t.advance(0);
    assert.equal(t.calls.length, 3, "available after 10 s");
  });

  test("offline errors keep an immediate Try again (no server cost) but still no automatic repeat", async () => {
    t.typeText("kestrel"); await t.advance(250);
    t.calls[0].reject(httpError("OFFLINE", undefined)); await t.flush();
    t.typeText("kestrel "); await t.advance(300);
    assert.equal(t.calls.length, 1);
    t.cc.retry(); await t.advance(0);
    assert.equal(t.calls.length, 2);
  });

  test("B7/B8: a superseded answer never replaces the newer loading state, and 'No matches' never flashes", async () => {
    t.typeText("boiler"); await t.advance(250);
    t.typeText("zebra"); // newer question: loading at once, even before its debounce fires
    assert.match(t.text(), /Searching all boards/);
    t.calls[0].resolve(answer([])); await t.flush(); // the old (empty) answer arrives
    assert.doesNotMatch(t.text(), /No matches/, "no flash of an empty result");
    assert.match(t.text(), /Searching all boards/);
    await t.advance(250);
    t.calls[1].resolve(answer([serverRecord(1, "Zebra crossing")])); await t.flush();
    assert.match(t.text(), /Zebra crossing/);
    // The superseded answer was still kept: going back to it needs no new request.
    t.typeText("boiler"); await t.advance(300);
    assert.equal(t.calls.length, 2);
  });

  test("B7: an old answer that fails after a newer question started shows no error", async () => {
    t.typeText("boiler"); await t.advance(250);
    t.typeText("zebra"); await t.advance(250);
    t.calls[0].reject(httpError("SERVICE_UNAVAILABLE", "SEARCH_TIMEOUT")); await t.flush();
    assert.doesNotMatch(t.text(), /taking too long/);
    t.calls[1].resolve(answer([])); await t.flush();
    assert.doesNotMatch(t.text(), /taking too long/);
  });

  test("B9: successful answers are cached (bounded), errors never are, and reset() clears everything", async () => {
    t.typeText("kestrel"); await t.advance(250); t.calls[0].resolve(answer([serverRecord(1, "Kestrel nest")])); await t.flush();
    t.typeText("kestre"); await t.advance(250); t.calls[1].resolve(answer([])); await t.flush();
    t.typeText("kestrel"); await t.advance(300);
    assert.equal(t.calls.length, 2, "backspace and retype uses the cache");
    assert.match(t.text(), /Kestrel nest/);
    for (let i = 0; i < 25; i++) { t.typeText(`word${i}`); await t.advance(250); t.calls.at(-1).resolve(answer([])); await t.flush(); }
    assert.ok(t.cc.cache.size <= 20, "bounded");
    t.typeText("kestrel"); await t.advance(300);
    assert.equal(t.calls.at(-1).params.q, "kestrel", "the oldest entry was evicted");
    t.calls.at(-1).reject(httpError("SERVICE_UNAVAILABLE", "SEARCH_TIMEOUT")); await t.flush();
    assert.ok(![...t.cc.cache.values()].some((e) => e.state.status === "error"), "errors are never cached as answers");
    t.cc.reset();
    assert.equal(t.cc.cache.size, 0); assert.equal(t.cc.failures.size, 0);
    t.cc.open(); t.typeText("word3"); await t.advance(300);
    assert.equal(t.calls.at(-1).params.q, "word3", "after reset nothing is reused");
  });

  test("answers that arrive after a sign-out are never kept", async () => {
    t.typeText("kestrel"); await t.advance(250);
    t.cc.reset();
    t.calls[0].resolve(answer([serverRecord(1, "Kestrel nest")])); await t.flush();
    assert.equal(t.cc.cache.size, 0);
  });

  test("L1: a cached answer is never shown to another signed-in user (the user is part of the cache key)", async () => {
    t.cc.c.auth = { userId: "user-a" };
    t.typeText("kestrel"); await t.advance(250); t.calls[0].resolve(answer([serverRecord(1, "Kestrel nest")])); await t.flush();
    t.typeText("kestre"); await t.advance(250); t.calls[1].resolve(answer([])); await t.flush();
    t.typeText("kestrel"); await t.advance(300);
    assert.equal(t.calls.length, 2, "same user: the cache answers");
    t.cc.c.auth = { userId: "user-b" };
    t.typeText("kestre"); await t.advance(250); t.calls.at(-1).resolve(answer([])); await t.flush();
    t.typeText("kestrel"); await t.advance(300);
    assert.equal(t.calls.length, 4, "another user: asked again");
    assert.equal(t.calls.at(-1).params.q, "kestrel");
  });

  test("L1: Entra sign-out clears the Command Center and quick-search results before navigating away", () => {
    const app = fs.readFileSync(path.resolve(__dirname, "..", "..", "site", "assets", "AppController.js"), "utf8");
    const line = app.split("\n").find((l) => l.includes('action === "entra-sign-out"'));
    assert.ok(line, "the entra-sign-out handler exists");
    const reset = line.indexOf("this.command?.reset()"), quick = line.indexOf("this.quickSearch.items = []"), out = line.indexOf("this.entra.signOut()");
    assert.ok(reset > 0 && quick > 0 && out > reset && out > quick, line.trim());
  });

  test("typing quickly sends one search per pause (debounce 250 ms)", async () => {
    for (const q of ["ke", "kes", "kest", "kestr", "kestre", "kestrel"]) { t.typeText(q); await t.advance(100); }
    await t.advance(300);
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0].params.q, "kestrel");
  });

  test("fallback with filters: status and assignee are applied on open boards and labelled partial; date filters say results are unavailable", async () => {
    t.cc.setFilter("status", "To do"); t.cc.setFilter("assignee", "me"); await t.advance(300);
    t.calls.at(-1).reject(httpError("SERVICE_UNAVAILABLE", "SEARCH_TIMEOUT")); await t.flush();
    assert.match(t.results.innerHTML, /data-id="r1"/);
    assert.doesNotMatch(t.results.innerHTML, /data-id="r2"/, "the Done record is filtered out locally");
    assert.match(t.text(), /Partial results — only boards you have open/);
    t.cc.setFilter("from", "2026-01-01"); await t.advance(300);
    t.calls.at(-1).reject(httpError("SERVICE_UNAVAILABLE", "SEARCH_TIMEOUT")); await t.flush();
    assert.match(t.text(), /Filtered results are unavailable right now/);
    assert.doesNotMatch(t.text(), /Nothing matches these filters|No matches for/, "never an empty result that looks complete");
    assert.doesNotMatch(t.results.innerHTML, /data-id="r1"/);
  });

  test("a fallback with no local hits says so instead of an empty 'No matches'", async () => {
    t.typeText("zzzz"); await t.advance(250);
    t.calls[0].reject(httpError("SERVICE_UNAVAILABLE", "SEARCH_TIMEOUT")); await t.flush();
    assert.match(t.text(), /Partial results — only boards you have open\. No matches on those boards\./);
    assert.doesNotMatch(t.text(), /No matches for/);
  });

  test("partial answers say why: board cap, time budget (records or comments); an older server's partial keeps the old wording", async () => {
    t.typeText("pump"); await t.advance(250);
    t.calls[0].resolve({ groups: [{ type: "record", items: [serverRecord(1, "Pump 1")], more: false, next: null }, { type: "comment", items: [], more: false, next: null, partial: true, reason: "time_budget" }], partial: true, partialReasons: ["board_cap", "time_budget"], maxBoards: 300 }); await t.flush();
    assert.match(t.text(), /Searched the first 300 boards\./);
    assert.match(t.text(), /Some results may be missing — the search took too long\./, "a cut comment group is reported even with no rows");
    assert.doesNotMatch(t.text(), /More matches exist/);
    assert.match(t.status.textContent, /\+ results$/);
    t.typeText("pumps"); await t.advance(250);
    t.calls[1].resolve({ groups: [{ type: "record", items: [], more: false, next: null }], partial: true }); await t.flush();
    assert.match(t.text(), /More matches exist/);
  });

  test("counts: '10+ results' when the server has more", async () => {
    t.typeText("pump"); await t.advance(250);
    t.calls[0].resolve(answer(Array.from({ length: 10 }, (_, i) => serverRecord(i, `Pump ${i}`)), { next: "cursor" })); await t.flush();
    t.cc.render();
    assert.match(t.status.textContent, /^\d+\+ results$/);
  });
});
