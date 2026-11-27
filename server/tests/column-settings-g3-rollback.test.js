// G3 / D12 rollback safety: column display settings are stored in the board's top-level `columnSettings`, never inside
// `columns`, so the release before G3 (which refuses unknown column fields and re-checks the stored columns when it adds a
// column or changes a type) keeps working on boards that have settings, and leaves them in place for the next G3 release.
//
// Cross-version: the SAME fake MongoDB is served first by this code, then by the rollback release (its files are read from
// git at ROLLBACK_REF into node_modules/.cache, or taken from JARC_ROLLBACK_SOURCE, a checkout of that release), then by this
// code again. Offline, synthetic values only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const { startMongoApp, startEntraApp, SessionClient, api } = require("./helpers");
const { FakeMongoClient } = require("./support/fake-mongo");
const { createTokenIssuer } = require("./support/entra-tokens");
const { loadBrowser } = require("./support/browser-model");

const ROLLBACK_REF = process.env.JARC_ROLLBACK_REF || "3f51351"; // production before G3 (Column C1)
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const NEEDED = ["server/src", "server/package.json", "server/tests/helpers.js", "server/tests/support", "site/assets"];

// The rollback release's files, read from git with plain git commands (no archive tool). Kept under server/node_modules so
// that its require("mongodb") etc. resolve to the installed packages, and outside anything git tracks.
function rollbackSource() {
  if (process.env.JARC_ROLLBACK_SOURCE) return path.resolve(process.env.JARC_ROLLBACK_SOURCE);
  const dir = path.join(REPO_ROOT, "server", "node_modules", ".cache", `jarc-rollback-${ROLLBACK_REF.replace(/[^0-9A-Za-z_-]/g, "")}`);
  if (fs.existsSync(path.join(dir, ".complete"))) return dir;
  const git = (args, input) => execFileSync("git", args, { cwd: REPO_ROOT, input, maxBuffer: 256 * 1024 * 1024 });
  const listing = git(["ls-tree", "-r", ROLLBACK_REF, "--", ...NEEDED]).toString("utf8").split("\n").filter(Boolean)
    .map((line) => { const [meta, file] = line.split("\t"); const [, type, sha] = meta.split(" "); return { type, sha, file }; })
    .filter((e) => e.type === "blob");
  const out = git(["cat-file", "--batch"], listing.map((e) => e.sha).join("\n") + "\n");
  let at = 0;
  for (const entry of listing) {
    const eol = out.indexOf(10, at);
    const size = Number(out.subarray(at, eol).toString("utf8").split(" ")[2]);
    const target = path.join(dir, ...entry.file.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, out.subarray(eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  fs.writeFileSync(path.join(dir, ".complete"), ROLLBACK_REF);
  return dir;
}

const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "qty", label: "Qty", type: "number" },
  { key: "due", label: "Due", type: "date" },
  { key: "notes", label: "Notes", type: "text" },
  { key: "site", label: "Site", type: "link" },
  { key: "status", label: "Status", type: "status", options: ["To do", "Done"] }
];
const SETTINGS = { qty: { precision: 1, prefix: "$" }, due: { displayFormat: "dmy" }, notes: { wrap: true }, site: { display: "text" } };
const plain = (v) => JSON.parse(JSON.stringify(v));
const col = (b, key) => b.columns.find((c) => c.key === key);
const noColumnSettings = (doc) => doc.columns.every((c) => !Object.hasOwn(c, "settings"));
// The real browser adapter of a page that read /features from a G3 server (columnSettings: true).
function staleAdapter(app) {
  const { window } = loadBrowser();
  const adapter = new window.ResourceApiAdapter({ baseUrl: `${app.url}/api/v1`, fetch: (...args) => fetch(...args), timeoutMs: 5000 });
  adapter.columnSettings = true;
  return adapter;
}

describe(`Rollback to ${ROLLBACK_REF} after column settings were saved (same database, both releases)`, () => {
  const fake = new FakeMongoClient();
  let source, boardId, original;
  const storedBoard = async (app) => app.db.collection("boards").findOne({ name: "Rollback" });
  const caller = (app) => (method, p, body) => api(app.url, method, `/api/v1${p}`, body);

  before(() => { source = rollbackSource(); });

  test("1. this release: settings are saved in board.columnSettings, never in columns; the session API shows them on the column", async () => {
    const app = await startMongoApp({ fake });
    try {
      const call = caller(app);
      const ws = (await call("POST", "/workspaces", { name: "Rollback" })).body.workspace;
      let b = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Rollback", columns: COLUMNS })).body.board;
      boardId = b.id;
      const made = await call("POST", `/boards/${b.id}/records/batch`, { records: [
        { values: { serial: "R1", qty: "1234.5", due: "2026-03-05", notes: "Some text", site: "https://example.com/a", status: "Done" } },
        { values: { serial: "R2", qty: "7", due: "2026-04-01", notes: "", site: "", status: "To do" } }
      ] });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const res = await call("PATCH", `/boards/${b.id}`, { expectedVersion: b.version, columns: b.columns.map((c) => ({ ...c, settings: SETTINGS[c.key] ?? null })) });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      b = res.body.board;
      for (const [key, s] of Object.entries(SETTINGS)) assert.deepEqual(plain(col(b, key).settings), s);
      assert.equal("columnSettings" in b, false, "the API has no top-level field");
      const stored = await storedBoard(app);
      assert.ok(noColumnSettings(stored), "no stored column has a settings field");
      assert.deepEqual(plain(stored.columnSettings), SETTINGS);
      original = plain((await call("GET", `/boards/${b.id}/records?limit=10`)).body.items);
    } finally { await app.close(); }
  });

  test("2. the rollback release on the same data: reads, column edits, add / duplicate / delete / type change all work; columnSettings is left as it was", async () => {
    const old = require(path.join(source, "server", "tests", "helpers.js"));
    const app = await old.startMongoApp({ fake });
    try {
      const call = caller(app);
      let res = await call("GET", `/boards/${boardId}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      let b = res.body.board;
      assert.ok(noColumnSettings(b), "the old release shows no settings (dormant)");
      res = await call("GET", `/boards/${boardId}/records?limit=10`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.items, original, "records read the same");

      // A tab that still sends settings is refused by the old release (and nothing is written). G3 pages retry without them.
      res = await call("PATCH", `/boards/${boardId}`, { expectedVersion: b.version, columns: b.columns.map((c) => ({ ...c, settings: null })) });
      assert.equal(res.status, 400);
      assert.equal((await call("GET", `/boards/${boardId}`)).body.board.version, b.version);
      // The G3 page's adapter (site/assets/ResourceApiAdapter.js) of a tab opened before the rollback: it asks /features
      // again, sees no columnSettings and sends the same write once more without settings.
      const adapter = staleAdapter(app);
      const sent = await adapter.columnsRequest("PATCH", `/boards/${boardId}`, { expectedVersion: b.version, columns: b.columns.map((c) => ({ ...c, label: c.key === "status" ? "State" : c.label, settings: null })) });
      assert.equal(sent.board.columns.find((c) => c.key === "status").label, "State");
      assert.equal(adapter.columnSettings, false, "the tab no longer sends settings");
      b = sent.board;

      // Ordinary board PATCH from the old page: rename, reorder, width, visibility.
      const cols = b.columns.map((c) => ({ ...c }));
      col({ columns: cols }, "qty").label = "Quantity";
      col({ columns: cols }, "due").width = 222;
      col({ columns: cols }, "site").visible = false;
      [cols[2], cols[3]] = [cols[3], cols[2]];
      res = await call("PATCH", `/boards/${boardId}`, { expectedVersion: b.version, columns: cols });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      b = res.body.board;
      assert.deepEqual(b.columns.map((c) => c.key), ["serial", "qty", "notes", "due", "site", "status"]);
      assert.deepEqual(plain((await storedBoard(app)).columnSettings), SETTINGS, "a PATCH from the old release keeps columnSettings");

      res = await call("POST", `/boards/${boardId}/columns`, { expectedVersion: b.version, column: { key: "extra", label: "Extra", type: "text" } });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      b = res.body.board;
      res = await call("POST", `/boards/${boardId}/columns`, { expectedVersion: b.version, column: { ...col(b, "qty"), key: "qty_copy", label: "Quantity copy" }, copyFrom: "qty" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      b = res.body.board;
      res = await api(app.url, "DELETE", `/api/v1/boards/${boardId}/columns/notes?expectedVersion=${b.version}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      b = res.body.board;
      res = await call("POST", `/boards/${boardId}/columns/due/type`, { expectedVersion: b.version, type: "text" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      b = res.body.board;
      assert.equal(col(b, "due").type, "text");

      const stored = await storedBoard(app);
      assert.ok(noColumnSettings(stored));
      assert.deepEqual(plain(stored.columnSettings), SETTINGS, "untouched by every old-release write (stale entries included)");
      const records = (await call("GET", `/boards/${boardId}/records?limit=10`)).body.items;
      for (const [i, r] of records.entries()) {
        for (const key of ["serial", "qty", "due", "site", "status"]) assert.deepEqual(r.values[key], original[i].values[key], `${r.values.serial}.${key}`);
        assert.equal(r.values.qty_copy, original[i].values.qty);
        assert.equal("notes" in r.values, false);
      }
    } finally { await app.close(); }
  });

  test("3. back on this release: settings show again; entries of a deleted column or of a column whose type changed are ignored, then dropped on the next write", async () => {
    const app = await startMongoApp({ fake });
    try {
      const call = caller(app);
      let b = (await call("GET", `/boards/${boardId}`)).body.board;
      assert.deepEqual(plain(col(b, "qty").settings), SETTINGS.qty, "shown again, on the renamed column");
      assert.deepEqual(plain(col(b, "site").settings), SETTINGS.site);
      assert.equal("settings" in col(b, "due"), false, "date settings don't apply to the text column it became");
      assert.equal(col(b, "notes"), undefined);
      assert.equal("settings" in col(b, "qty_copy"), false, "the old release's duplicate has none");
      assert.equal(col(b, "qty").label, "Quantity");
      // On a G3 server a refused write stays refused: the page never drops settings to get round a real validation error.
      const adapter = staleAdapter(app);
      await assert.rejects(adapter.columnsRequest("PATCH", `/boards/${boardId}`, { expectedVersion: b.version, columns: b.columns.map((c) => (c.key === "qty" ? { ...c, settings: { wrap: true } } : c)) }), (e) => e.code === "VALIDATION_ERROR");
      assert.equal(adapter.columnSettings, true);
      const res = await call("PATCH", `/boards/${boardId}`, { expectedVersion: b.version, columns: b.columns.map(({ settings, ...c }) => (c.key === "qty_copy" ? { ...c, settings: { precision: 0 } } : c)) });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      b = res.body.board;
      assert.deepEqual(plain(col(b, "qty").settings), SETTINGS.qty, "a column sent without settings keeps them");
      assert.deepEqual(plain((await storedBoard(app)).columnSettings), { qty: SETTINGS.qty, qty_copy: { precision: 0 }, site: SETTINGS.site }, "stale entries are gone");
    } finally { await app.close(); }
  });

  test("4. no stored column anywhere has the 5cb1a5e-era settings field", async () => {
    const boards = await fake.db("jarc_database").collection("boards").find({}).toArray();
    assert.ok(boards.length >= 1);
    for (const doc of boards) assert.ok(noColumnSettings(doc), doc.name);
  });
});

describe("columnSettings follows every column write (this release)", () => {
  let app, ws;
  const call = (method, p, body) => api(app.url, method, `/api/v1${p}`, body);
  const stored = (id) => app.db.collection("boards").findOne({ name: id });
  before(async () => { app = await startMongoApp(); ws = (await call("POST", "/workspaces", { name: "Writes" })).body.workspace; });
  after(async () => { await app.close(); });

  test("create, add, duplicate, type change, delete; the field is absent when no column has settings", async () => {
    let res = await call("POST", `/workspaces/${ws.id}/boards`, { name: "W1", columns: COLUMNS.map((c) => (c.key === "qty" ? { ...c, settings: { precision: 2 } } : c)) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    let b = res.body.board;
    assert.deepEqual(plain(col(b, "qty").settings), { precision: 2 });
    let doc = await stored("W1");
    assert.ok(noColumnSettings(doc));
    assert.deepEqual(plain(doc.columnSettings), { qty: { precision: 2 } });
    const blank = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "W0", columns: COLUMNS })).body.board;
    assert.equal("columnSettings" in await stored("W0"), false, "no settings → no field");
    assert.ok(blank.columns.every((c) => !("settings" in c)));

    res = await call("POST", `/boards/${b.id}/columns`, { expectedVersion: b.version, column: { key: "amt", label: "Amount", type: "number", settings: { suffix: " kg" } } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    b = res.body.board;
    res = await call("POST", `/boards/${b.id}/columns`, { expectedVersion: b.version, column: { ...col(b, "amt"), key: "amt2", label: "Amount copy" }, copyFrom: "amt" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    b = res.body.board;
    assert.deepEqual(plain(col(b, "amt2").settings), { suffix: " kg" });
    doc = await stored("W1");
    assert.ok(noColumnSettings(doc));
    assert.deepEqual(plain(doc.columnSettings), { qty: { precision: 2 }, amt: { suffix: " kg" }, amt2: { suffix: " kg" } });

    res = await call("POST", `/boards/${b.id}/columns/amt/type`, { expectedVersion: b.version, type: "text" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    b = res.body.board;
    assert.equal("settings" in col(b, "amt"), false);
    doc = await stored("W1");
    assert.ok(noColumnSettings(doc));
    assert.deepEqual(plain(doc.columnSettings), { qty: { precision: 2 }, amt2: { suffix: " kg" } }, "a type change keeps only keys the new type defines");

    for (const key of ["amt2", "qty"]) {
      res = await call("DELETE", `/boards/${b.id}/columns/${key}?expectedVersion=${b.version}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      b = res.body.board;
    }
    assert.equal("columnSettings" in await stored("W1"), false, "the last entry removed → the field is removed");

    // Undo of a delete re-adds the column with its settings (retired key, restoring).
    res = await call("POST", `/boards/${b.id}/columns`, { expectedVersion: b.version, column: { key: "qty", label: "Qty", type: "number", settings: { precision: 3 } } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(plain((await stored("W1")).columnSettings), { qty: { precision: 3 } });
    // PATCH clearing with null removes the field again.
    b = res.body.board;
    res = await call("PATCH", `/boards/${b.id}`, { expectedVersion: b.version, columns: b.columns.map((c) => ({ ...c, settings: null })) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal("columnSettings" in await stored("W1"), false);
  });

  test("bad settings are still refused with the same messages, and nothing is written", async () => {
    const b = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "W2", columns: COLUMNS })).body.board;
    let res = await call("PATCH", `/boards/${b.id}`, { expectedVersion: b.version, columns: b.columns.map((c) => (c.key === "qty" ? { ...c, settings: { wrap: true } } : c)) });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /display settings of column "qty" have an unknown setting "wrap"/);
    res = await call("POST", `/boards/${b.id}/columns`, { expectedVersion: b.version, column: { key: "amt", label: "Amount", type: "number", settings: { currency: "X" } } });
    assert.equal(res.status, 400);
    res = await call("POST", `/workspaces/${ws.id}/boards`, { name: "W3", columns: COLUMNS.map((c) => (c.key === "due" ? { ...c, settings: { displayFormat: "YYYY" } } : c)) });
    assert.equal(res.status, 400);
    const doc = await stored("W2");
    assert.equal(doc.version, b.version);
    assert.equal("columnSettings" in doc, false);
  });
});

describe("The external Board API never exposes column settings", () => {
  let app, issuer, admin;
  before(async () => {
    issuer = await createTokenIssuer();
    app = await startEntraApp({ issuer, apiTokens: { key: crypto.randomBytes(32), issuePerHour: 1000, maxActive: 1000 } });
    admin = issuer.person("Sys Admin", { admin: true });
    const service = app.dataLayer.services.apiTokens;
    service.adminObjectIds = Object.freeze([admin.oid.toLowerCase()]);
  });
  after(async () => { await app.close(); });

  test("board, columns, one column and records: no settings, no columnSettings", async () => {
    const browser = new SessionClient(app.url, app.entra.appOrigin);
    assert.equal((await browser.signIn(admin)).status, 201);
    const ws = (await browser.request("POST", "/api/v1/workspaces", { name: "External" })).body.workspace;
    const b = (await browser.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "External", columns: COLUMNS.map((c) => (SETTINGS[c.key] ? { ...c, settings: SETTINGS[c.key] } : c)) })).body.board;
    assert.deepEqual(plain(col(b, "qty").settings), SETTINGS.qty, "the session API shows them");
    await browser.request("POST", `/api/v1/boards/${b.id}/records/batch`, { records: [{ values: { serial: "E1", qty: "5" } }] });
    const issued = await browser.request("POST", "/api/v1/me/api-tokens", { name: "Reader", workspaceId: ws.id, boardIds: [b.id], scopes: ["read"], expiresAt: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    for (const p of [`/boards/${b.id}`, `/boards/${b.id}/columns`, `/boards/${b.id}/columns/qty`, `/boards/${b.id}/records`, `/boards/${b.id}/columns/qty/values`]) {
      const res = await fetch(`${app.url}/api/v1/external${p}`, { headers: { Authorization: `Bearer ${issued.body.secret}` } });
      const text = await res.text();
      assert.equal(res.status, 200, `${p} ${text}`);
      for (const word of ["settings", "columnSettings", "precision", "displayFormat"]) assert.equal(text.includes(word), false, `${p} contains ${word}`);
    }
  });
});
