// Column System S0-A: server-side conversion safety (D-S0-1 refuse with counts, D-S0-2 strict rules, D-S0-3 People).
// POST /boards/:id/columns/:key/type refuses every conversion that isn't lossless on the WHOLE board, with full counts
// (never loaded rows or a sample); lossless conversions keep the old response contract and don't rewrite unchanged
// records. Synthetic data only, on the in-memory fake MongoDB (no network, no production).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { startMongoApp, api } = require("./helpers");
const { COLLECTIONS } = require("../src/db/bootstrap");

const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "t", label: "Text", type: "text" },
  { key: "n", label: "Number", type: "number" },
  { key: "d", label: "Date", type: "date" },
  { key: "s", label: "Status", type: "status", options: ["New", "Done"] },
  { key: "dd", label: "Single", type: "dropdown", options: ["North", "South"] },
  { key: "dm", label: "Multi", type: "dropdown", multiple: true, options: ["North", "South", "East"] },
  { key: "o", label: "People", type: "owner" },
  { key: "c", label: "Tick", type: "checkbox" }
];

let app, ws;
const call = (method, path, body) => api(app.url, method, `/api/v1${path}`, body);
const getBoard = async (id) => (await call("GET", `/boards/${id}`)).body.board;
const recordsOf = async (id) => (await call("GET", `/boards/${id}/records?limit=200`)).body.items;
const convert = (board, key, body, { dryRun = false, version = board.version } = {}) => call("POST", `/boards/${board.id}/columns/${key}/type${dryRun ? "?dryRun=true" : ""}`, { expectedVersion: version, ...body });

// A board with one record per entry of `rows` (each a values object; serial filled in).
async function boardWith(rows, columns = COLUMNS) {
  const board = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Conversion", columns })).body.board;
  if (rows.length) {
    const created = await call("POST", `/boards/${board.id}/records/batch`, { records: rows.map((values, i) => ({ values: { serial: `R${i}`, ...values } })) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }
  return getBoard(board.id);
}

// Records straight into the fake database (large boards: the batch API would be slow for thousands of rows).
async function insertRaw(board, count, valueOf) {
  const boardDoc = await app.db.collection(COLLECTIONS.boards).findOne({ _id: new ObjectId(board.id) });
  const now = new Date();
  const docs = Array.from({ length: count }, (_, i) => ({ _id: new ObjectId(), boardId: boardDoc._id, workspaceId: boardDoc.workspaceId, groupId: boardDoc.groups[0].id, position: (i + 1) * 1000, archived: false, values: { serial: `L${i}`, ...valueOf(i) }, createdAt: now, updatedAt: now, version: 1 }));
  const collection = app.db.collection(COLLECTIONS.records);
  collection.docs.push(...docs);
  return docs;
}

// Snapshot of what's stored: every record's values and version, and the board's columns and version.
async function stored(boardId) {
  const _id = new ObjectId(boardId);
  const board = await app.db.collection(COLLECTIONS.boards).findOne({ _id });
  const records = await app.db.collection(COLLECTIONS.records).find({ boardId: _id }, { sort: { _id: 1 } }).toArray();
  return JSON.stringify({ columns: board.columns, version: board.version, records: records.map((r) => [String(r._id), r.values, r.version]) });
}

function assertRefused(res, { status = 400, reason, from, to } = {}) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.error.code, "CONVERSION_REFUSED");
  const d = res.body.error.details;
  for (const k of ["from", "to", "total", "populated", "convertible", "incompatible", "lossy", "examples", "reason"]) assert.ok(k in d, `details.${k}`);
  for (const k of ["truncatedMulti", "leadingZero", "longNumber", "invalidDate", "ambiguousDate", "tooManyOptions", "peopleReferences"]) assert.equal(typeof d.lossy[k], "number", `lossy.${k}`);
  assert.ok(d.examples.length <= 3 && d.examples.every((e) => typeof e === "string" && [...e].length <= 20 && !/[0-8b-zB-Z]/.test(e)), `masked examples: ${JSON.stringify(d.examples)}`);
  assert.equal(d.allowed, false);
  assert.match(res.body.error.message, /not been changed/);
  if (reason) assert.equal(d.reason, reason);
  if (from) assert.equal(d.from, from);
  if (to) assert.equal(d.to, to);
  return d;
}

before(async () => {
  app = await startMongoApp();
  ws = (await call("POST", "/workspaces", { name: "S0-A conversions" })).body.workspace;
});
after(async () => { await app.close(); });

describe("Refused: lossy conversions (nothing is written)", () => {
  test("text → number: leading zeros, long numbers, separators, hex, exponent, spaces, '+' are refused with counts", async () => {
    const board = await boardWith([{ t: "12" }, { t: "00123" }, { t: "1234567890123456" }, { t: "1,234" }, { t: "0x1A" }, { t: "1e3" }, { t: " 12 " }, { t: "+5" }, { t: "" }, {}]);
    const before = await stored(board.id);
    const d = assertRefused(await convert(board, "t", { type: "number" }), { reason: "INCOMPATIBLE_VALUES", from: "text", to: "number" });
    assert.deepEqual([d.total, d.populated, d.convertible, d.incompatible], [10, 8, 1, 7]);
    assert.equal(d.lossy.leadingZero, 1);
    assert.equal(d.lossy.longNumber, 1);
    assert.deepEqual(d.examples, ["99999", "9999999999999999", "9,999"], "masked: digits → 9, letters → a; never the values");
    assert.equal(await stored(board.id), before, "board and records unchanged");
    const body = JSON.stringify((await convert(board, "t", { type: "number" })).body);
    for (const raw of ["00123", "1234567890123456", "0x1A"]) assert.ok(!body.includes(raw), "no raw value in the response");
    assert.ok(!app.logger.errors.some((e) => /00123|9999/.test(e)), "nothing about the values is logged");
  });

  test("text → date: impossible dates and day/month forms are refused (no Date overflow)", async () => {
    const board = await boardWith([{ t: "2026-02-28" }, { t: "2026-02-30" }, { t: "2026-02-29" }, { t: "03/04/2026" }, { t: "15.01.2030" }, { t: "2030-01-15 08:30" }]);
    const before = await stored(board.id);
    const d = assertRefused(await convert(board, "t", { type: "date" }), { reason: "INCOMPATIBLE_VALUES" });
    assert.deepEqual([d.populated, d.convertible, d.incompatible, d.lossy.invalidDate, d.lossy.ambiguousDate], [6, 1, 5, 3, 2]);
    assert.equal(await stored(board.id), before);
  });

  test("several values → one value (status, text, number, single dropdown): truncation is refused", async () => {
    const board = await boardWith([{ dm: ["North", "South"] }, { dm: ["East"] }, { dm: [] }]);
    const before = await stored(board.id);
    for (const [type, multiple] of [["status"], ["text"], ["priority"], ["dropdown", false]]) {
      const d = assertRefused(await convert(board, "dm", { type, ...(multiple === false ? { multiple } : {}) }), { reason: "INCOMPATIBLE_VALUES", from: "dropdown_multiple" });
      assert.deepEqual([d.total, d.populated, d.convertible, d.incompatible, d.lossy.truncatedMulti], [3, 2, 1, 1, 1], type);
    }
    assert.equal(await stored(board.id), before);
  });

  test("People → anything is refused while any People value exists (D-S0-3), names and references alike", async () => {
    const devRef = `user:${app.devActor._id.toHexString()}`;
    const board = await boardWith([{ o: [devRef] }, { o: ["Contractor"] }, {}]);
    const before = await stored(board.id);
    for (const type of ["text", "status", "dropdown"]) {
      const d = assertRefused(await convert(board, "o", { type }), { reason: "PEOPLE_REFERENCES", from: "owner" });
      assert.equal(d.lossy.peopleReferences, 2);
      assert.equal(d.incompatible, 2);
    }
    assert.equal(await stored(board.id), before);
    assert.ok(!JSON.stringify((await convert(board, "o", { type: "text" })).body).includes(devRef.slice(5)), "no user ID in the refusal");
    // An empty People column converts.
    const empty = await boardWith([{}, { o: [] }]);
    assert.equal((await convert(empty, "o", { type: "text" })).status, 200);
  });

  test("text → dropdown that would need more than 200 options is refused (D4); long option text too", async () => {
    const board = await boardWith(Array.from({ length: 205 }, (_, i) => ({ t: `Value ${i}` })));
    const before = await stored(board.id);
    const d = assertRefused(await convert(board, "t", { type: "dropdown" }), { reason: "TOO_MANY_OPTIONS" });
    assert.equal(d.lossy.tooManyOptions, 5, "options over the cap");
    assert.equal(d.incompatible, 0);
    assert.equal(await stored(board.id), before);
    const long = await boardWith([{ t: "x".repeat(201) }]);
    assertRefused(await convert(long, "t", { type: "dropdown" }), { reason: "INCOMPATIBLE_VALUES" });
  });

  test("ticks are never cleared; text other than true / yes / 1 never becomes unticked", async () => {
    const ticked = await boardWith([{ c: true }, { c: false }]);
    for (const type of ["text", "status", "number"]) assertRefused(await convert(ticked, "c", { type }), { from: "checkbox" });
    const words = await boardWith([{ t: "Done" }, { t: "yes" }, { t: "no" }]);
    const d = assertRefused(await convert(words, "t", { type: "checkbox" }));
    assert.deepEqual([d.convertible, d.incompatible], [1, 2]);
  });

  test("number → date, date → number and invalid link / email / phone text are refused", async () => {
    const board = await boardWith([{ n: "20260101", d: "2026-01-01", t: "javascript:alert(1)" }, { t: "not an email" }]);
    assertRefused(await convert(board, "n", { type: "date" }));
    assertRefused(await convert(board, "d", { type: "number" }));
    assertRefused(await convert(board, "t", { type: "link" }));
    assertRefused(await convert(board, "t", { type: "email" }));
  });

  test("Connect / Mirror / Files / Group and the Item column stay refused before any value is read", async () => {
    const board = await boardWith([{ t: "a" }]);
    for (const [key, type] of [["t", "connect"], ["t", "mirror"], ["t", "files"], ["t", "group"], ["serial", "number"]]) {
      const res = await convert(board, key, { type });
      assert.equal(res.status, 400, `${key} → ${type}`);
    }
  });
});

describe("Allowed: lossless conversions (same response contract)", () => {
  test("status / number / date → text: definition only, no record rewritten", async () => {
    const board = await boardWith([{ s: "Done", n: "12.5", d: "2026-01-31" }, { s: "New", n: 7, d: "" }, {}]);
    const before = (await recordsOf(board.id)).map((r) => [r.id, r.version]);
    let current = board;
    for (const key of ["s", "n", "d"]) {
      const res = await convert(current, key, { type: "text" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(Object.keys(res.body).sort(), ["affected", "board", "recordsChanged"]);
      assert.equal(res.body.affected, 0);
      assert.equal(res.body.recordsChanged, 0, `${key}: no record rewritten`);
      assert.equal(res.body.board.columns.find((c) => c.key === key).type, "text");
      current = res.body.board;
    }
    assert.deepEqual((await recordsOf(board.id)).map((r) => [r.id, r.version]), before, "record versions untouched");
    const values = (await recordsOf(board.id)).map((r) => [r.values.s, r.values.n, r.values.d]);
    assert.deepEqual(values.slice(0, 2), [["Done", "12.5", "2026-01-31"], ["New", 7, ""]], "stored values kept exactly");
  });

  test("text → number when every value is a strict decimal; text → date when every value is a real ISO date", async () => {
    const board = await boardWith([{ t: "0", serial: "a" }, { t: "-12.50" }, { t: "0.75" }, { t: "" }, {}]);
    const res = await convert(board, "t", { type: "number" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.recordsChanged, 0, "values are kept verbatim: nothing rewritten");
    assert.deepEqual((await recordsOf(board.id)).map((r) => r.values.t), ["0", "-12.50", "0.75", "", ""]);
    const dates = await boardWith([{ t: "2024-02-29" }, { t: "2026-12-31" }]);
    const ok = await convert(dates, "t", { type: "date" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.recordsChanged, 0);
  });

  test("one ↔ several values, single-entry lists → one value, text → dropdown creates options", async () => {
    const board = await boardWith([{ dd: "North", dm: ["East"], t: "Alpha" }, { dd: "", dm: [], t: "Beta" }, {}]);
    const toMulti = await convert(board, "dd", { type: "dropdown", multiple: true });
    assert.equal(toMulti.status, 200, JSON.stringify(toMulti.body));
    assert.equal(toMulti.body.recordsChanged, 3, "'North' → ['North'], '' → [] (the same rule as before S0)");
    const toSingle = await convert(toMulti.body.board, "dm", { type: "dropdown", multiple: false });
    assert.equal(toSingle.status, 200, JSON.stringify(toSingle.body));
    const rows = await recordsOf(board.id);
    assert.deepEqual(rows.map((r) => r.values.dd), [["North"], [], []]);
    assert.deepEqual(rows.map((r) => r.values.dm), ["East", "", ""]);
    const dropdown = await convert(toSingle.body.board, "t", { type: "dropdown" });
    assert.equal(dropdown.status, 200);
    assert.deepEqual(dropdown.body.board.columns.find((c) => c.key === "t").options, ["Alpha", "Beta"]);
    assert.equal(dropdown.body.recordsChanged, 0);
    const activity = (await call("GET", `/boards/${board.id}/activity`)).body.items.find((e) => e.action === "column.type_changed");
    assert.ok(activity, "the change is in the activity log");
  });

  test("text → checkbox for true / yes / 1 ticks them (and unticks empties); several-value → People", async () => {
    const board = await boardWith([{ t: "Yes" }, { t: "1" }, { t: "" }, { dm: ["North", "South"] }]);
    const res = await convert(board, "t", { type: "checkbox" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((await recordsOf(board.id)).map((r) => r.values.t), [true, true, false, false]);
    const people = await convert(res.body.board, "dm", { type: "owner" });
    assert.equal(people.status, 200);
    assert.deepEqual((await recordsOf(board.id)).map((r) => r.values.dm)[3], ["North", "South"]);
  });

  test("other columns' stored values never change", async () => {
    const board = await boardWith([{ t: "5", n: "00", s: "Done", dm: ["North", "South"] }]);
    const [before] = await recordsOf(board.id);
    assert.equal((await convert(board, "t", { type: "number" })).status, 200);
    const [after] = await recordsOf(board.id);
    assert.deepEqual({ ...after.values, t: undefined }, { ...before.values, t: undefined });
  });
});

describe("Full-board counts, size limit and TOCTOU", () => {
  test("dry run on a 250-row board counts every row (not a page), and matches the refusal", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ t: i % 50 === 49 ? `0${i}` : String(i) }));
    const board = await boardWith(rows);
    const dry = await convert(board, "t", { type: "number" }, { dryRun: true });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.dryRun, true);
    assert.deepEqual([dry.body.total, dry.body.populated, dry.body.convertible, dry.body.incompatible, dry.body.lossy.leadingZero], [250, 250, 245, 5, 5]);
    assert.equal(dry.body.affected, 5);
    assert.equal(dry.body.allowed, false);
    const refused = assertRefused(await convert(board, "t", { type: "number" }));
    for (const k of ["total", "populated", "convertible", "incompatible"]) assert.equal(refused[k], dry.body[k], `${k}: dry run = commit`);
  });

  test("boards over 2,000 records are refused (BOARD_TOO_LARGE); the dry run still counts the whole board", async () => {
    const board = await boardWith([]);
    await insertRaw(board, 2001, (i) => ({ t: String(i) }));
    const before = await stored(board.id);
    const dry = await convert(board, "t", { type: "number" }, { dryRun: true });
    assert.deepEqual([dry.body.total, dry.body.convertible, dry.body.incompatible], [2001, 2001, 0]);
    assert.equal(dry.body.allowed, false);
    assert.equal(dry.body.tooLarge, true);
    assert.equal(dry.body.reason, "BOARD_TOO_LARGE");
    const d = assertRefused(await convert(board, "t", { type: "number" }), { reason: "BOARD_TOO_LARGE" });
    assert.equal(d.total, 2001);
    assert.equal(d.tooLarge, true);
    assert.equal(await stored(board.id), before, "nothing changed");
    // At the limit it runs.
    const small = await boardWith([]);
    await insertRaw(small, 2000, (i) => ({ t: String(i) }));
    assert.equal((await convert(small, "t", { type: "number" })).status, 200);
  });

  test("a stale board version is 409 CONFLICT; a stale preview token is 409 CONVERSION_REFUSED", async () => {
    const board = await boardWith([{ t: "1" }, { t: "2" }]);
    const stale = await convert(board, "t", { type: "number" }, { version: board.version + 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "CONFLICT");
    const dry = await convert(board, "t", { type: "number" }, { dryRun: true });
    assert.equal(dry.body.allowed, true);
    assert.match(dry.body.previewToken, /^[0-9a-f]{32}$/);
    // A value changes after the preview (record writes don't change the board version).
    const [first] = await recordsOf(board.id);
    assert.equal((await call("PATCH", `/records/${first.id}`, { expectedVersion: first.version, values: { t: "3" } })).status, 200);
    const before = await stored(board.id);
    const res = await convert(board, "t", { type: "number", previewToken: dry.body.previewToken });
    assertRefused(res, { status: 409, reason: "PREVIEW_STALE" });
    assert.equal(await stored(board.id), before);
    const fresh = await convert(board, "t", { type: "number" }, { dryRun: true });
    const ok = await convert(board, "t", { type: "number", previewToken: fresh.body.previewToken });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await convert(ok.body.board, "t", { type: "text", previewToken: "nope" })).status, 400, "a malformed token is a validation error");
  });

  test("a value that became lossy after the preview is refused inside the writing transaction", async () => {
    const board = await boardWith([{ t: "1" }]);
    const dry = await convert(board, "t", { type: "number" }, { dryRun: true });
    assert.equal(dry.body.allowed, true);
    const [r] = await recordsOf(board.id);
    await call("PATCH", `/records/${r.id}`, { expectedVersion: r.version, values: { t: "0042" } });
    const d = assertRefused(await convert(board, "t", { type: "number" }), { reason: "INCOMPATIBLE_VALUES" });
    assert.equal(d.lossy.leadingZero, 1);
  });
});

describe("Other paths can't bypass the checks", () => {
  test("PATCH /boards can't change a type or one ↔ several values", async () => {
    const board = await boardWith([{ t: "00123", dm: ["North", "South"] }]);
    const before = await stored(board.id);
    const retyped = board.columns.map((c) => (c.key === "t" ? { ...c, type: "number" } : c));
    assert.equal((await call("PATCH", `/boards/${board.id}`, { expectedVersion: board.version, columns: retyped })).status, 400);
    const single = board.columns.map((c) => (c.key === "dm" ? { ...c, multiple: false } : c));
    assert.equal((await call("PATCH", `/boards/${board.id}`, { expectedVersion: board.version, columns: single })).status, 400);
    assert.equal(await stored(board.id), before);
  });

  test("a duplicate (copyFrom) must keep the original's type, so values can't be copied into another type", async () => {
    const board = await boardWith([{ t: "00123" }]);
    const res = await call("POST", `/boards/${board.id}/columns`, { expectedVersion: board.version, column: { key: "t_copy", label: "Copy", type: "number" }, copyFrom: "t" });
    assert.equal(res.status, 400);
    const ok = await call("POST", `/boards/${board.id}/columns`, { expectedVersion: board.version, column: { key: "t_copy", label: "Copy", type: "text" }, copyFrom: "t" });
    assert.equal(ok.status, 201);
  });

  test("a Connect column's linked board can't be changed by a board update (validation)", () => {
    const { boardPatch } = require("../src/validation/resources");
    const link = (boardId) => ({ key: "c1", label: "Client", type: "connect", link: { boardId } });
    const board = { columns: [{ key: "serial", label: "Item", type: "text", required: true }, link("a".repeat(24))], groups: [], savedViews: [] };
    assert.throws(() => boardPatch({ expectedVersion: 1, columns: [board.columns[0], link("b".repeat(24))] }, board, { actorId: null, now: new Date() }), /links to can't be changed/);
    assert.doesNotThrow(() => boardPatch({ expectedVersion: 1, columns: [board.columns[0], { ...link("a".repeat(24)), label: "Renamed" }] }, board, { actorId: null, now: new Date() }));
  });
});
