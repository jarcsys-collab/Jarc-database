// Column System S0-A: independent final review probes (synthetic data, in-memory fake MongoDB, no network).
// Each test records the CURRENT behaviour. Tests named "FIXED:" were review gaps ("GAP:") and now assert the fixed behaviour.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ObjectId } = require("mongodb");
const { checkTyped } = require("../src/validation/record-values");
const { numberProblem, convertCell, conversionPlanner, SYNC_LIMITS } = require("../src/domain/column-conversion");
const { LIMITS } = require("../src/domain/board-schema");
const { csvCell } = require("../src/services/import-job-service");
const { mapValue, mapColumns } = require("../src/integrations/monday/mapping");
const { MondayIntegration } = require("../src/integrations/monday/service");
const { startMongoApp, api } = require("./helpers");

const ok = (type, v) => !checkTyped(type, v).reason;
// AppView in its own context (the browser's safeHref / unsafeLink).
function loadView() {
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "site", "assets", f), "utf8");
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null, body: { classList: { add() {}, remove() {}, contains: () => false } } };
  const context = vm.createContext({ window: {}, document, console, Intl, Date, URL, encodeURIComponent });
  for (const file of ["AppView.js", "IconLibrary.js", "Appearance.js", "BoardGroups.js", "CommentsPanel.js"]) vm.runInContext(read(file), context, { filename: file });
  return new context.window.AppView({ innerHTML: "" });
}

test("numbers: 0, 0.5, -3, -0 allowed; hex, exponent, separators, +, unicode digits, spaces, NaN/Infinity, 1. and .5 refused", () => {
  for (const v of ["0", "0.5", "-3", "-0", "10", "999999999999999"]) assert.equal(numberProblem(v), null, v);
  for (const v of ["0x10", "0b1", "0o7", "1e3", "1E-3", "1,000", "1.000,5", "1_000", "+1", "١", "１", " 1", "1 ", "\t1", "NaN", "Infinity", "-Infinity", "1.", ".5", "--1", "-", "", "1234567890123456", "0.1234567890123456"])
    assert.notEqual(numberProblem(v), null, JSON.stringify(v));
  // stored JS numbers: unsafe representations are refused (exponent form / >15 digits)
  const num = (value) => convertCell(value, { key: "t", type: "text" }, { type: "number", multiple: false }, { key: "t", label: "T", type: "number" });
  assert.equal(num(1e21).ok, false); assert.equal(num(0.1 + 0.2).ok, false); assert.equal(num(42).ok, true); assert.equal(num(NaN).ok, false);
  // false positives that stay refused (safe direction): trailing zeros past 15 digits
  assert.equal(numberProblem("1.00000000000000000"), "longNumber");
});

test("email: plus-addressing, IDN and punycode accepted", () => {
  for (const v of ["a+tag@example.com", "first.last@sub.example.co.uk", "用户@例子.广告", "josé@bücher.de", "a@xn--bcher-kva.de", "O'Neil@example.ie"]) assert.ok(ok("email", v), v);
  for (const v of ["a@b", "a@@b.com", "a b@c.com", "a@b.123", "\"q\"@x.com", "a@b.com?x", "a@-b.com", "javascript:alert(1)//@x.com"]) assert.ok(!ok("email", v), v);
});

test("FIXED: email IDN with combining marks (Devanagari, Thai, Tamil) is accepted; a part can't start with a mark", () => {
  for (const v of ["info@उदाहरण.भारत", "user@สวัสดี.ไทย", "a@இந்தியா.இந்தியா", "सुरेश@उदाहरण.भारत", "สมชาย@สวัสดี.ไทย"]) assert.ok(ok("email", v), v);
  for (const v of ["́a@example.com", "a@́b.com", "a@b.ัth", "a.िb@example.com", "a@b", "a b@c.com", "a@b.123"]) assert.ok(!ok("email", v), JSON.stringify(v));
});

test("phone: E.164, spaces, dots, parentheses, extensions accepted", () => {
  for (const v of ["+639171234567", "+63 917 123 4567", "+1 (555) 123-4567", "555.123.4567", "+44 20 7946 0958 ext. 12", "555-1234 x12", "+1-555-123-4567;ext=9", "tel:+15551234567", "911", "+49 (0)30 123456"]) assert.ok(ok("phone", v), v);
  // refused (format choices to note): slash-separated, vanity letters, free-text labels
  for (const v of ["030/123456", "1-800-FLOWERS", "555-1234 (mobile)", "+1 555 1234 extension 5"]) assert.ok(!ok("phone", v), v);
});

test("link: unsafe schemes refused through encodings and unicode tricks", () => {
  for (const v of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "java\tscript:x", "java\nscript:x", "\u0001javascript:x", "jav&#x61;script:x", "jav&#97;script:x", "&#x6A;avascript:x", "javascript&colon;x",
    "jav&Tab;ascript:x", "%6Aavascript:x", "javascript%3Ax", "%256Aavascript:x", "ｊａｖａｓｃｒｉｐｔ:x", "javascript\uff1ax", "\u200bjavascript:x", "java\u00adscript:x", "data:text/html,x", "vbscript:x", "file:///c:/x", "blob:https://x/y", "about:blank", "\u202ejavascript:x"])
    assert.ok(!ok("link", v), JSON.stringify(v));
  for (const v of ["https://example.com", "http://例え.jp/パス", "https://xn--r8jz45g.jp", "mailto:a@b.com", "tel:+1555", "www.example.com", "see the shared drive", "https://example.com/a b", "https://x.com/?next=javascript:1"]) assert.ok(ok("link", v), v);
});

test("FIXED: link text with a 'word:' prefix and host:port is plain text (stored, not clickable, not flagged)", () => {
  const view = loadView();
  for (const v of ["Note: see drive", "Ref:123", "intranet:8080/x", "localhost:3000", "Todo:call back"]) {
    const out = checkTyped("link", v);
    assert.equal(out.reason, undefined, v); assert.equal(out.value, v, "stored exactly as typed");
    assert.equal(view.safeHref(v, "link"), "", `${v} is not clickable`);
    assert.equal(view.unsafeLink(v), false, `${v} is not flagged`);
  }
  // A real scheme token is still refused: "//" after an unknown scheme, or a dangerous scheme in any form (also host:port-like).
  for (const v of ["foo://x", "ftp://example.com", "javascript:1", "javascript:80/x", "JavaScript: alert(1)", "data:1", "vbscript:1", "jav&#x61;script:80", "%6Aavascript:1", "ｊａｖａｓｃｒｉｐｔ:1", "ms-settings:privacy", "livescript:x", "view-source:https://x", "x-unknown:thing", "web+app:x"]) {
    assert.ok(!ok("link", v), JSON.stringify(v));
  }
  for (const v of ["foo://x", "javascript:1", "javascript:80/x", "JavaScript: alert(1)", "data:1", "ms-settings:privacy", "file:///c:/x", "about:blank", "x-unknown:thing", "web+app:x"]) assert.equal(view.unsafeLink(v), true, v);
  for (const v of ["https://example.com", "mailto:a@b.com", "tel:+1555", "www.example.com"]) assert.equal(view.unsafeLink(v), false, v);
});

test("FIXED: email / phone hrefs drop a stored mailto: / tel: prefix (never mailto:mailto:)", () => {
  const view = loadView();
  assert.equal(view.safeHref("mailto:ana@example.com", "email"), "mailto:ana@example.com");
  assert.equal(view.safeHref("MAILTO: ana@example.com", "email"), "mailto:ana@example.com");
  assert.equal(view.safeHref("ana@example.com", "email"), "mailto:ana@example.com");
  assert.equal(view.safeHref("tel:+1 555 123 4567", "phone"), "tel:+15551234567");
  assert.equal(view.safeHref("+63 (2) 555-0100", "phone"), "tel:+6325550100");
  assert.equal(view.safeHref("mailto:javascript:alert(1)", "email"), "");
  // converting a Text column to Email / Phone keeps the stored value as it is (no rewrite of the prefix)
  const conv = (value, type) => convertCell(value, { key: "t", type: "text" }, { type, multiple: false }, { key: "t", label: "T", type });
  assert.deepEqual(conv("mailto:ana@example.com", "email"), { ok: true, next: undefined });
  assert.deepEqual(conv("tel:+15551234567", "phone"), { ok: true, next: undefined });
});

test("server import report CSV guards formulas; values are only prefixed in the file", () => {
  assert.equal(csvCell("=1+1"), "\"'=1+1\""); assert.equal(csvCell("+1"), "\"'+1\""); assert.equal(csvCell("@SUM(A1)"), "\"'@SUM(A1)\"");
  assert.equal(csvCell("\tx"), "\"'\tx\""); assert.equal(csvCell("＝1"), "\"'＝1\""); assert.equal(csvCell("a\"b"), "\"a\"\"b\""); assert.equal(csvCell(3), "\"3\"");
});

// The live sync's upsertItems on stub repositories (no database, no network), with a capturing logger.
function syncHarness() {
  const { columns, plan } = mapColumns({ columns: [{ id: "phone", title: "Phone", type: "phone" }, { id: "email", title: "Email", type: "email" }, { id: "link", title: "Link", type: "link" }] });
  const board = { _id: new ObjectId(), workspaceId: new ObjectId() };
  const boardMap = { sourceId: "900", plan, columns };
  const mappings = [], inserted = [], updates = [], logs = [];
  const repos = {
    integrations: {
      listMappings: async () => mappings.filter((m) => m.kind === "item"),
      insertMappings: async (list) => { mappings.push(...list); },
      updateMapping: async () => {}
    },
    records: { insertMany: async (docs) => { inserted.push(...docs); }, collection: { updateOne: async (filter, update) => { updates.push({ filter, update }); } } }
  };
  const capture = (...args) => logs.push(args.map(String).join(" "));
  const service = new MondayIntegration({ repos, connection: { withTransaction: async (fn) => fn(undefined) }, logger: { warn: capture, info: capture, log: capture, error: capture } });
  const item = (id, cells, updatedAt) => ({ id, name: `Item ${id}`, state: "active", updated_at: updatedAt, column_values: Object.entries(cells).map(([cid, text]) => ({ id: cid, text, value: null })) });
  return { service, board, boardMap, inserted, updates, logs, item };
}
const LABELLED = "555-1234 (mobile)", LONG_LINK = "https://x.com/" + "a".repeat(2100), ODD_EMAIL = "ops team@example.com";

test("FIXED: monday sync INSERT stores Link / Email / Phone values that fail the rules unchanged (never blanked)", async () => {
  assert.equal(mapValue("phone", { text: LABELLED, value: null }, {}), "", "mapValue (used by the migration engine) is unchanged");
  const h = syncHarness();
  await h.service.upsertItems(h.board, h.boardMap, [h.item("1", { phone: LABELLED, email: ODD_EMAIL, link: LONG_LINK }, "2026-01-01T00:00:00Z"), h.item("2", { phone: "+63 917 123 4567", email: "", link: "ftp://x" }, "2026-01-01T00:00:00Z")]);
  assert.equal(h.inserted.length, 2);
  const [bad, good] = h.inserted;
  assert.equal(bad.values.m_phone, LABELLED); assert.equal(bad.values.m_email, ODD_EMAIL); assert.equal(bad.values.m_link, LONG_LINK);
  assert.equal(good.values.m_phone, "+63 917 123 4567"); assert.equal(good.values.m_email, ""); assert.equal(good.values.m_link, "", "non-http(s) links from monday stay empty, as before S0-A");
  // the stored raw values are flagged on read (unsafeValues), so they are never linked
  const { unsafeValueKeys } = require("../src/validation/record-values");
  assert.deepEqual(unsafeValueKeys({ columns: h.boardMap.columns }, bad.values).sort(), ["m_email", "m_link", "m_phone"]);
  assert.equal(h.logs.length, 1); assert.match(h.logs[0], /0 stored .* kept and 3 new one\(s\) stored unchanged/);
  for (const v of [LABELLED, ODD_EMAIL, "x.com/aaaa", "mobile"]) assert.ok(!h.logs.join("\n").includes(v), "no value in the log");
});

test("FIXED: monday sync UPDATE keeps the stored JARC value when the new monday value fails the rules", async () => {
  const h = syncHarness();
  await h.service.upsertItems(h.board, h.boardMap, [h.item("1", { phone: "+1 555 123 4567", email: "ana@example.com", link: "https://example.com" }, "2026-01-01T00:00:00Z")]);
  assert.equal(h.logs.length, 0);
  await h.service.upsertItems(h.board, h.boardMap, [h.item("1", { phone: LABELLED, email: ODD_EMAIL, link: "https://example.com/new" }, "2026-02-01T00:00:00Z")]);
  assert.equal(h.updates.length, 1);
  const set = h.updates[0].update.$set;
  assert.ok(!Object.hasOwn(set, "values.m_phone"), "phone left out of $set: the stored value stays");
  assert.ok(!Object.hasOwn(set, "values.m_email"), "email left out of $set: the stored value stays");
  assert.equal(set["values.m_link"], "https://example.com/new", "valid values still sync");
  assert.equal(set["values.serial"], "Item 1");
  // monday clearing a value still clears it in JARC (an empty value is not a refused one)
  await h.service.upsertItems(h.board, h.boardMap, [h.item("1", { phone: "", email: "", link: "" }, "2026-03-01T00:00:00Z")]);
  assert.equal(h.updates[1].update.$set["values.m_phone"], ""); assert.equal(h.updates[1].update.$set["values.m_email"], "");
  assert.equal(h.logs.length, 1); assert.match(h.logs[0], /2 stored .* kept and 0 new/);
  for (const v of [LABELLED, ODD_EMAIL, "mobile", "ops team"]) assert.ok(!h.logs.join("\n").includes(v), "no value in the log");
});

test("FIXED: the planner keeps at most SYNC_LIMITS.cells rewrites and LIMITS.options + 1 options (10,000 records)", () => {
  const board = { _id: new ObjectId(), version: 1 };
  const column = { key: "t", type: "text" };
  const n = 10000;
  const planner = conversionPlanner({ board, column, to: { type: "checkbox", multiple: false }, toColumn: { key: "t", label: "T", type: "checkbox" } });
  for (let i = 0; i < n; i += 1) planner.add(new ObjectId(), undefined); // every empty cell becomes false
  const { details, changes } = planner.finish();
  assert.equal(details.reason, "BOARD_TOO_LARGE");
  assert.ok(changes.length <= SYNC_LIMITS.cells, `changes kept: ${changes.length}`);
  assert.equal(details.rewrites, n, "every rewrite is still counted");
  assert.equal(details.total, n);
  // dropdown: 10,000 distinct values → the option set never grows past LIMITS.options + 1
  const dd = conversionPlanner({ board, column, to: { type: "dropdown", multiple: false }, toColumn: { key: "t", label: "T", type: "dropdown", options: [] } });
  for (let i = 0; i < n; i += 1) dd.add(new ObjectId(), `Value ${i}`);
  const out = dd.finish();
  assert.equal(out.details.reason, "TOO_MANY_OPTIONS");
  assert.ok(out.options.length <= LIMITS.options + 1, `options kept: ${out.options.length}`);
  assert.ok(out.changes.length <= SYNC_LIMITS.cells);
  assert.equal(out.details.lossy.tooManyOptions, n - LIMITS.options, "distinct values counted per cell past the cap");
  // repeated values past the cap are not counted again when already an option
  const rep = conversionPlanner({ board, column, to: { type: "dropdown", multiple: false }, toColumn: { key: "t", label: "T", type: "dropdown", options: [] } });
  for (let i = 0; i < n; i += 1) rep.add(new ObjectId(), `Value ${i % 50}`);
  const repeated = rep.finish();
  assert.equal(repeated.details.lossy.tooManyOptions, 0); assert.equal(repeated.options.length, 50);
  assert.equal(repeated.details.reason, "BOARD_TOO_LARGE", "10,000 records is over SYNC_LIMITS.records");
});

test("FIXED: the conversion scan reads with maxTimeMS", async () => {
  const { RecordRepository } = require("../src/repositories/mongo/record-repository");
  const calls = [];
  const repo = Object.create(RecordRepository.prototype);
  repo.collection = { find: (filter, options) => { calls.push(options); return {}; } };
  repo.columnValues(new ObjectId(), "t");
  assert.equal(calls[0].maxTimeMS, 20000);
});

test("FIXED: a duplicated Connect / Mirror column must keep the original's link / mirror config (400 otherwise)", async () => {
  const app = await startMongoApp({ app: { features: { connectBoards: true } } });
  try {
    const call = (m, p, b) => api(app.url, m, `/api/v1${p}`, b);
    const ws = (await call("POST", "/workspaces", { name: "W" })).body.workspace;
    const mk = async (name) => (await call("POST", `/workspaces/${ws.id}/boards`, { name, columns: [{ key: "serial", label: "Item", type: "text", required: true }] })).body.board;
    const x = await mk("X"), y = await mk("Y"), a = await mk("A");
    const xr = (await call("POST", `/boards/${x.id}/records`, { values: { serial: "x1" } })).body.record;
    let board = (await call("POST", `/boards/${a.id}/columns`, { expectedVersion: a.version, column: { key: "lx", label: "LX", type: "connect", link: { boardId: x.id } } })).body.board;
    await call("POST", `/boards/${a.id}/records`, { values: { serial: "a1", lx: [xr.id] } });
    const dup = await call("POST", `/boards/${a.id}/columns`, { expectedVersion: board.version, copyFrom: "lx", column: { key: "ly", label: "LY", type: "connect", link: { boardId: y.id } } });
    assert.equal(dup.status, 400, JSON.stringify(dup.body));
    assert.equal(dup.body.error.code, "VALIDATION_ERROR");
    let after = (await call("GET", `/boards/${a.id}`)).body.board;
    assert.equal(after.version, board.version, "nothing written");
    assert.ok(!after.columns.some((c) => c.key === "ly"));
    // same board: allowed, the IDs are copied
    const same = await call("POST", `/boards/${a.id}/columns`, { expectedVersion: board.version, copyFrom: "lx", column: { key: "lx2", label: "LX 2", type: "connect", link: { boardId: x.id } } });
    assert.equal(same.status, 201, JSON.stringify(same.body));
    board = same.body.board;
    assert.deepEqual((await call("GET", `/boards/${a.id}/records`)).body.items[0].values.lx2, [xr.id]);
    // mirror: a copy must follow the same Connect column and show the same column the same way
    board = (await call("POST", `/boards/${a.id}/columns`, { expectedVersion: board.version, column: { key: "mx", label: "MX", type: "mirror", mirror: { via: "lx", column: "serial" } } })).body.board;
    for (const mirror of [{ via: "lx2", column: "serial" }, { via: "lx", column: "serial", show: "count" }]) {
      const bad = await call("POST", `/boards/${a.id}/columns`, { expectedVersion: board.version, copyFrom: "mx", column: { key: "my", label: "MY", type: "mirror", mirror } });
      assert.equal(bad.status, 400, JSON.stringify(mirror));
    }
    const mirrorCopy = await call("POST", `/boards/${a.id}/columns`, { expectedVersion: board.version, copyFrom: "mx", column: { key: "my", label: "MY", type: "mirror", mirror: { via: "lx", column: "serial", show: "list" } } });
    assert.equal(mirrorCopy.status, 201, JSON.stringify(mirrorCopy.body));
    after = (await call("GET", `/boards/${a.id}/records`)).body.items[0];
    assert.equal(after.values.ly, undefined);
  } finally { await app.close(); }
});
