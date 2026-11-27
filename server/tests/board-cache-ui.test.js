// Board loading performance and the copy of boards saved in this browser (BoardCache, IndexedDB), in the REAL app in a
// headless browser against the test Entra server (fake MongoDB, synthetic data only):
//   - a board is read in pages of 1000; a board opened before shows its saved copy at once after a reload, marked as such,
//     then the server's copy (colleagues' edits, additions and deletions; nothing deleted ever comes back)
//   - a background check never overwrites a cell being edited, and a save made meanwhile wins
//   - a failed check says so, with Retry; a board whose columns changed doesn't use its saved copy
//   - memory bounds: boards let go of load again, with no duplicates
//   - security: another person signing in on this browser never sees the first one's copies; copies of boards no longer
//     shared are deleted (role-based server); no token or session value is ever stored; IndexedDB missing or broken changes nothing
// Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, freePort, waitForServer, sleep } = require("./support/headless-browser");

const BROWSER = findBrowser();
const VIEW = { width: 1440, height: 900 };
const OWNER = "0e7e7e7e-0000-4000-8000-0000000000c1", ANA = "0e7e7e7e-0000-4000-8000-0000000000c2", BEN = "0e7e7e7e-0000-4000-8000-0000000000c3";
const COLUMNS = [{ key: "serial", label: "Name", type: "text", required: true }, { key: "note", label: "Note", type: "text" }, { key: "qty", label: "Qty", type: "number" }];

async function startServer(shared) {
  const port = await freePort(), base = `http://localhost:${port}`;
  const server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), ...(shared ? ["shared"] : [])], { stdio: "ignore", env: { ...process.env, ...(shared ? { JARC_TEST_BETA: "1" } : {}) } }); // role-based: no open editing, so access really depends on membership
  await waitForServer(base, { child: server });
  return { base, server };
}
function tools(b, base) {
  const t = {
    signIn: (oid, name, admin = false) => b.evaluate(`(async () => { const s = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${oid}&name=${encodeURIComponent(name)}&email=${oid}@example.invalid&admin=${admin ? 1 : 0}&nonce=" + encodeURIComponent(s.nonce))).json(); return (await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) })).status; })()`),
    api: (method, url, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return JSON.stringify({ status: r.status, body: await r.json().catch(() => null) }); })()`).then(JSON.parse),
    wait: (expr, ms = 15000) => b.waitFor(expr, ms),
    async open(p) { await b.open(`${base}${p}`, VIEW); assert.ok(await t.wait("!!document.querySelector('.app-shell')", 20000), `app at ${p}`); },
    rows: () => b.evaluate(`JSON.stringify([...document.querySelectorAll("tr[data-record-context] td[data-column-key='serial'] [aria-label^='Name: ']")].map((e) => e.getAttribute("aria-label").slice(6)))`).then(JSON.parse),
    cell: (serial, key) => `tr:has([aria-label="Name: ${serial}"]) td[data-column-key="${key}"]`,
    loaded: (name) => t.wait(`document.querySelector(".board-title-input")?.value === ${JSON.stringify(name)} && !!document.querySelector("tr[data-record-context]") && !document.querySelector('.skeleton-region[aria-busy="true"]')`),
    current: () => t.wait(`document.querySelector(".board-surface")?.dataset.boardFreshness === "current"`),
    perf: () => b.evaluate("JSON.stringify(window.jarcPerf?.entries || [])").then(JSON.parse),
    // IndexedDB contents, read without ever creating the database (a test opening it first would give it no stores).
    idb: () => b.evaluate(`(async () => { const dbs = await indexedDB.databases(); if (!dbs.some((d) => d.name === "jarc-board-cache")) return "null"; return await new Promise((resolve) => { const req = indexedDB.open("jarc-board-cache"); req.onsuccess = () => { const db = req.result; if (!db.objectStoreNames.contains("snapshots")) { db.close(); resolve("null"); return; } const tx = db.transaction(["snapshots", "meta"]), s = tx.objectStore("snapshots").getAll(), m = tx.objectStore("meta").getAll(); tx.oncomplete = () => { db.close(); resolve(JSON.stringify({ snapshots: s.result, meta: m.result })); }; }; req.onerror = () => resolve("null"); }); })()`).then(JSON.parse),
    snapshot: async (boardId) => (await t.idb())?.snapshots.find((s) => s.boardId === boardId) || null,
    waitSnapshot: async (boardId, test = () => true, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const s = await t.snapshot(boardId); if (s && test(s)) return s; await sleep(200); } return null; },
    // Probe injected before a page loads: whether the saved copy was ever on screen, and requests for records held or refused
    // while sessionStorage "hold-records" is "hold" | "fail" (released with window.__release()).
    async probe() {
      const res = await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__sawCopy = false; new MutationObserver(() => { if (document.querySelector('[data-board-freshness="cached"] tr[data-record-context]')) window.__sawCopy = true; }).observe(document, { childList: true, subtree: true });
        (() => { const real = window.fetch.bind(window), held = []; window.__release = () => { sessionStorage.removeItem("hold-records"); held.splice(0).forEach((go) => go()); };
          window.fetch = (input, init) => { const mode = sessionStorage.getItem("hold-records"), u = String(input?.url || input); if (mode && /\\/boards\\/[0-9a-f]{24}\\/records\\?limit=/.test(u)) { if (mode === "fail") return Promise.reject(new TypeError("Failed to fetch")); return new Promise((resolve, reject) => held.push(() => real(input, init).then(resolve, reject))); } return real(input, init); }; })();` });
      return res.result?.identifier;
    }
  };
  return t;
}

describe("Board loading and saved copies (real app)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let srv, b, o, t, owner, ws;
  const boards = {};
  const make = async (name, count) => {
    const board = (await owner.api("POST", `/api/v1/workspaces/${ws}/boards`, { name, columns: COLUMNS })).body.board;
    for (let i = 0; i < count; i += 2000) assert.equal((await owner.api("POST", `/api/v1/boards/${board.id}/records/batch`, { records: Array.from({ length: Math.min(2000, count - i) }, (_, j) => ({ values: { serial: `${name} ${String(i + j + 1).padStart(4, "0")}`, note: `Note ${i + j + 1}`, qty: (i + j) % 50 } })) })).status, 201);
    return { id: board.id, name, version: board.version };
  };
  const records = async (boardId) => { const all = []; let cursor = ""; do { const page = await owner.api("GET", `/api/v1/boards/${boardId}/records?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); all.push(...page.body.items); cursor = page.body.nextCursor || ""; } while (cursor); return all; };

  before(async () => {
    srv = await startServer(true);
    o = await launch(BROWSER); owner = tools(o, srv.base);
    await o.open(`${srv.base}/api/v1/health`, VIEW);
    assert.equal(await owner.signIn(OWNER, "Olga Owner"), 201);
    ws = (await owner.api("POST", "/api/v1/workspaces", { name: "Cache Space" })).body.workspace.id;
    boards.small = await make("Small", 30);
    boards.mid = await make("Mid", 1500);
    boards.other = await make("Other", 20);
    boards.renamed = await make("Renamed", 10);
    b = await launch(BROWSER); t = tools(b, srv.base);
    await b.motionPreference("reduce");
    await b.open(`${srv.base}/api/v1/health`, VIEW);
    assert.equal(await t.signIn(ANA, "Ana Employee"), 201);
    await t.probe();
  });
  after(async () => { await b?.close(); await o?.close(); srv?.server.kill(); });

  test("a board is read in pages of 1000; after a reload its saved copy shows at once, marked, then the server's copy; timings recorded", async () => {
    await t.open(`/boards/${boards.mid.id}`);
    assert.ok(await t.loaded("Mid"));
    const reads = await b.evaluate(`JSON.stringify(performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes("/boards/${boards.mid.id}/records?")))`).then(JSON.parse);
    assert.equal(reads.length, 2, `1500 records in 2 requests: ${reads.join(" ")}`);
    assert.ok(reads.every((u) => u.includes("limit=1000")));
    assert.equal((await t.perf()).find((e) => e.name === "board-open")?.source, "server");
    const saved = await t.waitSnapshot(boards.mid.id, (s) => s.records.length === 1500);
    assert.ok(saved, "the board's copy is saved in this browser");
    await b.send("Page.reload", {});
    assert.ok(await t.loaded("Mid"));
    assert.ok(await t.current(), "then the server's copy");
    assert.equal(await b.evaluate("window.__sawCopy"), true, "the saved copy was on screen first, marked as such");
    const perf = await t.perf();
    assert.equal(perf.find((e) => e.name === "board-open")?.source, "saved copy");
    assert.ok(perf.some((e) => e.name === "board-refresh" && e.ms >= 0), "the check is timed");
    assert.equal((await t.rows()).length > 0, true);
    assert.doesNotMatch(await b.evaluate("document.querySelector('.board-surface').textContent"), /saved in this browser/, "the note goes once the board is current");
  });

  test("a colleague's edits, additions and deletions made meanwhile replace the saved copy; nothing deleted comes back", async () => {
    await t.open(`/boards/${boards.small.id}`);
    assert.ok(await t.loaded("Small"));
    await t.waitSnapshot(boards.small.id, (s) => s.records.length === 30);
    const [one, two] = await records(boards.small.id);
    assert.equal((await owner.api("PATCH", `/api/v1/records/${one.id}`, { expectedVersion: one.version, values: { note: "Changed by Olga" } })).status, 200);
    assert.equal((await owner.api("DELETE", `/api/v1/records/${two.id}?expectedVersion=${two.version}`)).status, 200);
    assert.equal((await owner.api("POST", `/api/v1/boards/${boards.small.id}/records`, { values: { serial: "Small new by Olga" } })).status, 201);
    await b.send("Page.reload", {});
    assert.ok(await t.loaded("Small")); assert.ok(await t.current());
    assert.ok(await t.wait(`document.querySelector(${JSON.stringify(t.cell("Small 0001", "note"))})?.textContent.includes("Changed by Olga")`), "edited");
    const shown = await t.rows();
    assert.ok(shown.includes("Small new by Olga"), "added");
    assert.ok(!shown.includes("Small 0002"), "deleted, and not brought back");
    const copy = await t.waitSnapshot(boards.small.id, (s) => !s.records.some((r) => r.id === two.id) && s.records.length === 30);
    assert.ok(copy, "the saved copy follows: the deleted record is gone from it too");
  });

  test("a background check never overwrites a cell being edited, and a save made while it runs wins", async () => {
    await t.open(`/boards/${boards.small.id}`); assert.ok(await t.loaded("Small")); assert.ok(await t.current());
    await t.waitSnapshot(boards.small.id);
    const list = await records(boards.small.id), r3 = list.find((r) => r.values.serial === "Small 0003"), r4 = list.find((r) => r.values.serial === "Small 0004");
    assert.equal((await owner.api("PATCH", `/api/v1/records/${r3.id}`, { expectedVersion: r3.version, values: { note: "Olga's note" } })).status, 200);
    await b.evaluate(`sessionStorage.setItem("hold-records", "hold")`);
    await b.send("Page.reload", {});
    assert.ok(await t.loaded("Small"));
    assert.equal(await b.evaluate(`document.querySelector(".board-surface").dataset.boardFreshness`), "cached", "the check is held: the saved copy shows");
    // A save while the check is held…
    await b.evaluate(`document.querySelector(${JSON.stringify(t.cell("Small 0004", "note") + " .cell-display")}).click()`); await sleep(150);
    await b.evaluate("(() => { const i = document.querySelector('.cell-input'); i.value = 'Ana saved this'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()");
    const deadline = Date.now() + 8000; let saved;
    while (Date.now() < deadline) { saved = (await records(boards.small.id)).find((r) => r.id === r4.id); if (saved.values.note === "Ana saved this") break; await sleep(150); }
    assert.equal(saved.values.note, "Ana saved this", "the save reached the server");
    // …and a cell being typed in when the check arrives.
    await b.evaluate(`document.querySelector(${JSON.stringify(t.cell("Small 0003", "note") + " .cell-display")}).click()`); await sleep(150);
    await b.evaluate("(() => { const i = document.querySelector('.cell-input'); i.value = 'Half typed'; i.setSelectionRange(4, 4); })()");
    await b.evaluate("window.__release()");
    assert.ok(await t.wait(`document.querySelector(".board-surface")?.dataset.boardFreshness === "current" || !!document.querySelector('.cell-input')`, 10000));
    await sleep(1500);
    assert.deepEqual(await b.evaluate("[document.activeElement?.classList.contains('cell-input'), document.activeElement?.value, document.activeElement?.selectionStart]"), [true, "Half typed", 4], "editor, text and caret untouched");
    await b.key("Escape");
    assert.ok(await t.current());
    assert.ok(await t.wait(`document.querySelector(${JSON.stringify(t.cell("Small 0004", "note"))})?.textContent.includes("Ana saved this")`), "the newer save is what shows");
    assert.ok(await t.wait(`document.querySelector(${JSON.stringify(t.cell("Small 0003", "note"))})?.textContent.includes("Olga's note")`), "the colleague's change arrives once the editor is closed");
    assert.equal((await records(boards.small.id)).find((r) => r.id === r4.id).values.note, "Ana saved this", "never overwritten by the older answer");
  });

  test("a check that fails says so with Retry, and recovers", async () => {
    await t.open(`/boards/${boards.other.id}`); assert.ok(await t.loaded("Other")); await t.waitSnapshot(boards.other.id);
    await b.evaluate(`sessionStorage.setItem("hold-records", "fail")`);
    await b.send("Page.reload", {});
    assert.ok(await t.loaded("Other"));
    assert.ok(await t.wait(`!!document.querySelector('.board-freshness.is-failed [data-action="retry-board-refresh"]')`, 8000), "Couldn't check for changes · Retry");
    assert.equal(await b.evaluate(`document.querySelector('.board-freshness').getAttribute("role")`), "status");
    assert.ok((await t.rows()).length > 0, "the saved copy stays usable");
    await b.evaluate(`sessionStorage.removeItem("hold-records")`);
    await b.evaluate(`document.querySelector('[data-action="retry-board-refresh"]')?.click()`);
    assert.ok(await t.current(), "Retry (or the automatic retry) brings the server's copy");
  });

  test("a board whose columns or name changed since doesn't use its saved copy", async () => {
    await t.open(`/boards/${boards.renamed.id}`); assert.ok(await t.loaded("Renamed")); await t.waitSnapshot(boards.renamed.id);
    const board = (await owner.api("GET", `/api/v1/boards/${boards.renamed.id}`)).body.board;
    assert.equal((await owner.api("PATCH", `/api/v1/boards/${boards.renamed.id}`, { expectedVersion: board.version, name: "Renamed Twice" })).status, 200);
    await b.send("Page.reload", {});
    assert.ok(await t.loaded("Renamed Twice"));
    assert.equal(await b.evaluate("window.__sawCopy"), false);
    assert.equal((await t.perf()).find((e) => e.name === "board-open")?.source, "server");
  });

  test("memory bounds: a board let go of loads again; editing it then creates no duplicates", async () => {
    await t.open(`/boards/${boards.small.id}`); assert.ok(await t.loaded("Small")); assert.ok(await t.current());
    await b.evaluate("ResourceApiAdapter.MEMORY_BOARD_LIMIT = 1");
    await b.evaluate(`[...document.querySelectorAll("#sidebar .tree-item[data-action='open-board']")].find((e) => e.textContent.trim().startsWith("Other")).click()`);
    assert.ok(await t.loaded("Other"));
    assert.ok(await t.wait(`window.jarcStorage.adapter.boardLoadState(${JSON.stringify(boards.small.id)})?.state === "none"`, 5000), "Small's records were let go of");
    const before = (await records(boards.small.id)).length;
    await b.evaluate(`[...document.querySelectorAll("#sidebar .tree-item[data-action='open-board']")].find((e) => e.textContent.trim().startsWith("Small")).click()`);
    assert.ok(await t.loaded("Small")); assert.ok(await t.current());
    await b.evaluate(`document.querySelector(${JSON.stringify(t.cell("Small 0005", "note") + " .cell-display")}).click()`); await sleep(150);
    await b.evaluate("(() => { const i = document.querySelector('.cell-input'); i.value = 'After reload'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()");
    const end = Date.now() + 8000; let list;
    while (Date.now() < end) { list = await records(boards.small.id); if (list.some((r) => r.values.note === "After reload")) break; await sleep(200); }
    assert.ok(list.some((r) => r.values.note === "After reload"), "saved");
    assert.equal(list.length, before, "no record created twice");
    assert.equal(new Set(list.map((r) => r.values.serial)).size, list.length, "no duplicate names");
    await b.evaluate("ResourceApiAdapter.MEMORY_BOARD_LIMIT = 20");
  });

  test("nothing secret is ever stored: no token, cookie or session value; only boards' records and when they were saved", async () => {
    const all = await t.idb();
    assert.ok(all && all.snapshots.length >= 2);
    const text = JSON.stringify(all);
    for (const forbidden of [/csrf/i, /eyJ[A-Za-z0-9_-]{10}/, /token/i, /cookie/i, /jarc_session/i, /idToken/i, /Bearer/]) assert.doesNotMatch(text, forbidden);
    for (const s of all.snapshots) assert.deepEqual(Object.keys(s).sort(), ["boardId", "boardVersion", "key", "records", "savedAt", "schema", "scope"]);
    for (const m of all.meta) assert.deepEqual(Object.keys(m).sort(), ["boardId", "bytes", "key", "savedAt", "schema", "scope", "usedAt"]);
  });

  test("a malformed saved copy is ignored and replaced; the board loads from the server", async () => {
    const good = await t.snapshot(boards.other.id);
    await b.evaluate(`new Promise((resolve) => { const req = indexedDB.open("jarc-board-cache"); req.onsuccess = () => { const db = req.result, tx = db.transaction("snapshots", "readwrite"); tx.objectStore("snapshots").put({ ...${JSON.stringify({ key: good.key, schema: 2, scope: good.scope, boardId: good.boardId, boardVersion: good.boardVersion, savedAt: Date.now() })}, records: [{ id: "not-an-id", values: "<script>alert(1)</script>" }] }); tx.oncomplete = () => { db.close(); resolve(true); }; }; })`);
    await t.open(`/boards/${boards.other.id}`);
    assert.ok(await t.loaded("Other")); assert.ok(await t.current());
    assert.equal(await b.evaluate("window.__sawCopy"), false);
    assert.equal((await t.perf()).find((e) => e.name === "board-open")?.source, "server");
    assert.ok(await t.waitSnapshot(boards.other.id, (s) => s.records.every((r) => /^[0-9a-f]{24}$/.test(r.id)) && s.records.length === 20), "replaced by a valid copy");
  });

  test("signed out (a session ended, copies still in this browser): nothing of them shows before signing in; sign-out's clearing leaves no database", async () => {
    const copy = await t.waitSnapshot(boards.small.id);
    assert.ok(copy, "a copy is in this browser");
    assert.equal((await t.api("POST", "/api/v1/auth/sign-out")).status, 200, "the session ends (as when it expires) — the copies stay");
    await b.open(`${srv.base}/boards/${boards.small.id}`, VIEW);
    assert.ok(await t.wait(`!!document.querySelector('[data-action="entra-sign-in"]')`, 20000), "the sign-in screen");
    await sleep(1500);
    const page = JSON.parse(await b.evaluate(`JSON.stringify({ rows: document.querySelectorAll("tr[data-record-context]").length, text: document.body.textContent, saw: window.__sawCopy, shell: !!document.querySelector(".app-shell") })`));
    assert.deepEqual([page.rows, page.saw, page.shell], [0, false, false], "no record, no board, no app before sign-in");
    for (const r of copy.records.slice(0, 5)) assert.ok(!page.text.includes(r.values.serial), `"${r.values.serial}" is not on the page`);
    assert.ok(await t.snapshot(boards.small.id), "copies are only deleted on sign-out, never read before sign-in");
    // What sign-out does before Microsoft's page (EntraSession.logout → BoardCache.clearAll): the whole database goes.
    await b.evaluate("window.BoardCache.clearAll()");
    assert.equal(await b.evaluate(`indexedDB.databases().then((d) => d.some((x) => x.name === "jarc-board-cache"))`), false, "no saved copy left in this browser");
    // Signed in again, with a copy saved again (the next test starts from there).
    assert.equal(await t.signIn(ANA, "Ana Employee"), 201);
    await t.open(`/boards/${boards.small.id}`); assert.ok(await t.loaded("Small"));
    assert.ok(await t.waitSnapshot(boards.small.id), "saved again after signing in");
  });

  test("another person signing in on this browser never sees the first person's copies: they're deleted first", async () => {
    const anaId = (await t.api("GET", "/api/v1/me")).body.user.id;
    assert.ok((await t.idb()).snapshots.some((s) => s.scope === anaId));
    assert.equal(await t.signIn(BEN, "Ben Employee"), 201);
    await t.open(`/boards/${boards.small.id}`);
    assert.ok(await t.loaded("Small")); assert.ok(await t.current());
    assert.equal(await b.evaluate("window.__sawCopy"), false, "Ben's first look is the server's copy, never Ana's");
    assert.equal((await t.perf()).find((e) => e.name === "board-open")?.source, "server");
    const all = await t.idb();
    assert.ok(!all.snapshots.some((s) => s.scope === anaId) && !all.meta.some((m) => m.scope === anaId), "Ana's copies are gone");
    assert.ok(await t.waitSnapshot(boards.small.id, (s) => s.scope !== anaId), "Ben gets his own");
  });
});

describe("Saved copies and access changes (role-based server)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let srv, b, o, t, owner, board, ws, memberId;
  before(async () => {
    srv = await startServer(false);
    o = await launch(BROWSER); owner = tools(o, srv.base);
    b = await launch(BROWSER); t = tools(b, srv.base);
    await o.open(`${srv.base}/api/v1/health`, VIEW); await b.open(`${srv.base}/api/v1/health`, VIEW);
    assert.equal(await owner.signIn(OWNER, "Olga Owner", true), 201);
    assert.equal(await t.signIn(ANA, "Ana Employee"), 201);
    ws = (await owner.api("POST", "/api/v1/workspaces", { name: "Private Space" })).body.workspace.id;
    board = (await owner.api("POST", `/api/v1/workspaces/${ws}/boards`, { name: "Private Board", columns: COLUMNS })).body.board;
    await owner.api("POST", `/api/v1/boards/${board.id}/records/batch`, { records: [{ values: { serial: "Confidential row" } }] });
    const anaId = (await t.api("GET", "/api/v1/me")).body.user.id;
    const added = await owner.api("POST", `/api/v1/workspaces/${ws}/members`, { userId: anaId, role: "VIEWER" });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    memberId = added.body.member.id;
    await t.probe();
  });
  after(async () => { await b?.close(); await o?.close(); srv?.server.kill(); });

  test("access taken away: the board can't be opened from its link, and its saved copy is deleted", async () => {
    await t.open(`/boards/${board.id}`);
    assert.ok(await t.loaded("Private Board"));
    assert.ok(await t.waitSnapshot(board.id), "saved while Ana had access");
    assert.equal((await owner.api("DELETE", `/api/v1/workspaces/${ws}/members/${memberId}`)).status, 200);
    await t.open(`/boards/${board.id}`);
    assert.ok(await t.wait(`document.querySelector(".board-link-problem h2")?.textContent === "This board could not be found."`));
    assert.equal(await b.evaluate(`document.body.textContent.includes("Confidential row") || window.__sawCopy`), false, "the saved copy was never shown");
    const end = Date.now() + 5000; let left = true;
    while (Date.now() < end) { left = Boolean(await t.snapshot(board.id)); if (!left) break; await sleep(200); }
    assert.equal(left, false, "its saved copy is deleted");
  });
});

describe("IndexedDB unavailable (private window, blocked storage)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let srv, b, o, t, owner, board;
  before(async () => {
    srv = await startServer(true);
    o = await launch(BROWSER); owner = tools(o, srv.base);
    await o.open(`${srv.base}/api/v1/health`, VIEW);
    assert.equal(await owner.signIn(OWNER, "Olga Owner"), 201);
    const ws = (await owner.api("POST", "/api/v1/workspaces", { name: "No Storage" })).body.workspace.id;
    board = (await owner.api("POST", `/api/v1/workspaces/${ws}/boards`, { name: "Plain Board", columns: COLUMNS })).body.board;
    await owner.api("POST", `/api/v1/boards/${board.id}/records/batch`, { records: Array.from({ length: 12 }, (_, i) => ({ values: { serial: `Plain ${i + 1}` } })) });
    b = await launch(BROWSER); t = tools(b, srv.base);
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() { throw new DOMException("denied", "SecurityError"); }, deleteDatabase() { throw new DOMException("denied", "SecurityError"); }, databases: async () => [] } }); window.__errors = []; window.addEventListener("error", (e) => window.__errors.push(String(e.message))); window.addEventListener("unhandledrejection", (e) => window.__errors.push(String(e.reason)));` });
    await b.open(`${srv.base}/api/v1/health`, VIEW);
    assert.equal(await t.signIn(ANA, "Ana Employee"), 201);
  });
  after(async () => { await b?.close(); await o?.close(); srv?.server.kill(); });

  test("boards load from the server as before, also after a reload; no errors", async () => {
    for (let i = 0; i < 2; i += 1) {
      await t.open(`/boards/${board.id}`);
      assert.ok(await t.loaded("Plain Board"));
      assert.equal((await t.rows()).length, 12);
      assert.equal((await t.perf()).find((e) => e.name === "board-open")?.source, "server");
      await sleep(2000); // past the moment a copy would be written
    }
    assert.deepEqual(await b.evaluate("window.__errors"), []);
  });
});
