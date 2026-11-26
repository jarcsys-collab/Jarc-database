// Column System S0-A: the strict per-value rules of domain/column-conversion.js (no server, no database).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { numberProblem, dateProblem, isRealDate, maskValue, conversionPlanner, SYNC_LIMITS } = require("../src/domain/column-conversion");

test("strict numbers: plain decimals only, ≤ 15 significant digits, no leading zeros", () => {
  for (const ok of ["0", "-0", "0.5", "-12.50", "7", "123456789012345", "0.000001", "100000000000000"]) assert.equal(numberProblem(ok), null, ok);
  for (const [text, reason] of [["00123", "leadingZero"], ["007.5", "leadingZero"], ["-01", "leadingZero"], ["1234567890123456", "longNumber"], ["12345678901234.56", "longNumber"],
    ["1,234", "notNumber"], ["1 234", "notNumber"], ["0x1A", "notNumber"], ["1e3", "notNumber"], ["+5", "notNumber"], [" 12 ", "notNumber"], ["1.", "notNumber"], [".5", "notNumber"],
    ["1.2.3", "notNumber"], ["Infinity", "notNumber"], ["NaN", "notNumber"], ["₱ 50", "notNumber"], ["12 pcs", "notNumber"], ["١٢", "notNumber"]]) assert.equal(numberProblem(text), reason, text);
});

test("strict dates: YYYY-MM-DD and a real calendar date, worked out without Date overflow", () => {
  for (const ok of ["2026-02-28", "2024-02-29", "2000-02-29", "2026-12-31", "1999-01-01"]) { assert.equal(dateProblem(ok), null, ok); assert.ok(isRealDate(ok)); }
  for (const bad of ["2026-02-29", "1900-02-29", "2026-02-30", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00", "2030/01/15", "2030-1-5", "2030-01-15T00:00", "20260101", "Jan 5 2026"]) assert.equal(dateProblem(bad), "invalidDate", bad);
  for (const ambiguous of ["03/04/2026", "15/01/2030", "1.2.26", "12-31-2026"]) assert.equal(dateProblem(ambiguous), "ambiguousDate", ambiguous);
});

test("masked examples: digits → 9, letters → a, at most 20 characters, lists joined", () => {
  assert.equal(maskValue("INV-00123"), "aaa-99999");
  assert.equal(maskValue("Ñandú 2026"), "aaaaa 9999");
  assert.equal(maskValue("x".repeat(50)).length, 20);
  assert.equal(maskValue(["North", "S1"]), "aaaaa, a9");
});

test("Link / Email / Phone: unsafe defaults are refused and unsafe values don't fit (record-values rules)", () => {
  const { normalizeColumn } = require("../src/domain/board-schema");
  const { convertCell } = require("../src/domain/column-conversion");
  const fits = (value, type) => convertCell(value, { key: "t", type: "text" }, { type, multiple: false }, { key: "t", label: "T", type }).ok;
  assert.throws(() => normalizeColumn({ key: "web", label: "Web", type: "link", defaultValue: "javascript:alert(1)" }), /default for "web"/);
  assert.throws(() => normalizeColumn({ key: "mail", label: "Mail", type: "email", defaultValue: "not an email" }), /default for "mail"/);
  assert.equal(normalizeColumn({ key: "web", label: "Web", type: "link", defaultValue: "https://example.com" }).defaultValue, "https://example.com");
  assert.equal(normalizeColumn({ key: "t", label: "T", type: "text", defaultValue: "javascript:alert(1)" }).defaultValue, "javascript:alert(1)", "text columns are never checked");
  assert.equal(fits("JaVaScRiPt:alert(1)", "link"), false);
  assert.equal(fits("data:text/html,x", "link"), false);
  assert.equal(fits("https://example.com", "link"), true);
  assert.equal(fits("www.example.com", "link"), true);
  assert.equal(fits("name@example.com", "email"), true);
  assert.equal(fits("nope", "email"), false);
  assert.equal(fits("+63 912 345 6789", "phone"), true);
  const planner = conversionPlanner({ board: { _id: "b", version: 1 }, column: { key: "t", type: "text" }, to: { type: "link", multiple: false }, toColumn: { key: "t", label: "T", type: "link" } });
  ["https://example.com", "javascript:alert(1)", "vbscript:x", ""].forEach((v, i) => planner.add(i, v));
  const { details } = planner.finish();
  assert.deepEqual([details.populated, details.convertible, details.incompatible, details.allowed], [3, 1, 2, false], "a dangerous scheme counts as loss: the conversion is refused");
});

test("planner: counts every cell, lists only changed records, and its preview token follows the values", () => {
  const board = { _id: "b1", version: 3 };
  const column = { key: "t", type: "text" };
  const run = (values, to = { type: "number", multiple: false }) => {
    const p = conversionPlanner({ board, column, to, toColumn: { key: "t", label: "T", type: to.type } });
    values.forEach((v, i) => p.add(`r${i}`, v));
    return p.finish();
  };
  const a = run(["1", "2", "", undefined, "00"]);
  assert.deepEqual([a.details.total, a.details.populated, a.details.convertible, a.details.incompatible, a.details.lossy.leadingZero], [5, 3, 2, 1, 1]);
  assert.equal(a.details.allowed, false);
  assert.equal(a.changes.length, 0, "nothing would be rewritten");
  const ok = run(["1", "2"]);
  assert.equal(ok.details.allowed, true);
  assert.notEqual(run(["1", "3"]).details.previewToken, ok.details.previewToken);
  assert.equal(run(["1", "2"]).details.previewToken, ok.details.previewToken);
  const ticks = run(["yes", "", undefined], { type: "checkbox" });
  assert.deepEqual(ticks.changes.map((c) => c.next), [true, false, false]);
  assert.equal(SYNC_LIMITS.records, 2000);
});
