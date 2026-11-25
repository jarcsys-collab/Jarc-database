// Fabric Data advanced filters, model v1 (src/fabric/filter-model.js) and its compiler (filter-compile.js): the operator catalog
// per kind, value types (Decimal128 text, numeric-looking strings stay text, real UTC days), relative dates on a fixed clock
// (Monday weeks; lastN includes today, prevN excludes it), limits, injection attempts and the sensitive-field refusal. Pure: no
// database. Synthetic values only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fm = require("../src/fabric/filter-model");
const fc = require("../src/fabric/filter-compile");
const { DATASETS } = require("../src/fabric/datasets");

const S = DATASETS.sales, I = DATASETS.inventory;
const NOW = new Date("2026-11-25T10:00:00Z"); // a Wednesday
const root = (...items) => ({ v: 1, op: "and", items });
const ok = (ds, model, now = NOW) => fm.validateFilter(ds, model, { now });
const bad = (ds, model, reason) => assert.throws(() => ok(ds, model), (e) => { assert.equal(e.status, 400); assert.equal(e.code, "VALIDATION_ERROR"); if (reason) assert.equal(e.details.reason, reason); return true; });
const sample = { text: "abc", number: "12.5", date: "2026-11-01", category: "Synthetic Co A" };
const condFor = (field, op, kind) => {
  const shape = fm.OPERATORS[op].shape;
  if (shape === "one") return { field, op, value: sample[kind] };
  if (shape === "two") return { field, op, value: kind === "date" ? "2026-11-01" : "1", to: kind === "date" ? "2026-11-20" : "5" };
  if (shape === "list") return { field, op, values: [sample[kind], null] };
  if (shape === "n") return { field, op, n: 3, unit: "weeks" };
  return { field, op };
};
const FIELD_OF_KIND = { text: "Item_No", number: "Quantity", date: "Expiration_Date", bool: "Completely_Invoiced", category: "Entry_Type" };

describe("Catalog and kinds", () => {
  test("every operator of every kind validates and compiles; operators of other kinds are refused", () => {
    for (const [kind, field] of Object.entries(FIELD_OF_KIND)) {
      assert.equal(fm.fieldKind(I, field), kind);
      for (const op of Object.keys(fm.OPERATORS)) {
        const model = root(condFor(field, op, kind));
        if (fm.BY_KIND[kind].includes(op)) {
          const out = ok(I, model);
          const compiled = fc.compileFilter(I, out, { now: NOW });
          assert.ok(compiled && typeof compiled === "object", `${kind} ${op}`);
          assert.doesNotMatch(JSON.stringify(compiled), /\$where|\$function|\$accumulator|\$expr/, `${kind} ${op}`);
        } else bad(I, model, "operator");
      }
    }
  });

  test("numeric-looking strings are text (no number operators); number fields take decimal text only", () => {
    assert.equal(fm.fieldKind(S, "invoice_id"), "text");
    assert.equal(fm.fieldKind(S, "pulse_id_customer_db"), "text");
    bad(S, root({ field: "invoice_id", op: "gt", value: "100" }), "operator");
    ok(S, root({ field: "invoice_id", op: "startsWith", value: "10" }));
    for (const value of ["1e5", "abc", "", " 1", "1.", ".5", "0x10", "Infinity", "1".repeat(35), 12, true, ["1"], { $gt: "" }]) bad(S, root({ field: "Quantity", op: "eq", value }), "value");
    ok(S, root({ field: "Quantity", op: "between", value: "-1.25", to: "3" }));
    bad(S, root({ field: "Quantity", op: "between", value: "5", to: "3" }), "range");
  });

  test("Decimal128 fields compile to exact Decimal128 operands; other numbers to JS numbers", () => {
    const text = "12345678901234567890.12345678901234";
    const out = fc.compileFilter(S, ok(S, root({ field: "Unit_Price", op: "gte", value: text })), { now: NOW });
    assert.equal(out.Unit_Price.$gte._bsontype, "Decimal128");
    assert.equal(out.Unit_Price.$gte.toString(), text);
    const n = fc.compileFilter(S, ok(S, root({ field: "invoice_item_amount", op: "eq", value: "10.5" })), { now: NOW });
    assert.equal(n.invoice_item_amount, 10.5);
  });

  test("dates must be real UTC days; between needs from ≤ to", () => {
    for (const value of ["2026-02-30", "2026-1-01", "20261101", "2026-11-01T00:00:00Z", 20261101, null]) bad(I, root({ field: "Posting_Date", op: "on", value }), "date");
    bad(I, root({ field: "Posting_Date", op: "between", value: "2026-11-02", to: "2026-11-01" }), "range");
  });
});

describe("Relative dates (UTC, Monday weeks)", () => {
  const range = (cond, now = NOW) => ok(I, root({ field: "Posting_Date", ...cond }), now).items[0].range;
  test("fixed periods on Wednesday 2026-11-25", () => {
    assert.deepEqual(range({ op: "today" }), ["2026-11-25", "2026-11-26"]);
    assert.deepEqual(range({ op: "yesterday" }), ["2026-11-24", "2026-11-25"]);
    assert.deepEqual(range({ op: "thisWeek" }), ["2026-11-23", "2026-11-30"], "Monday to Sunday");
    assert.deepEqual(range({ op: "thisMonth" }), ["2026-11-01", "2026-12-01"]);
    assert.deepEqual(range({ op: "thisQuarter" }), ["2026-10-01", "2027-01-01"]);
    assert.deepEqual(range({ op: "thisYear" }), ["2026-01-01", "2027-01-01"]);
    assert.deepEqual(range({ op: "lastMonth" }), ["2026-10-01", "2026-11-01"]);
    assert.deepEqual(range({ op: "lastYear" }), ["2025-01-01", "2026-01-01"]);
    assert.deepEqual(range({ op: "on", value: "2026-11-03" }), ["2026-11-03", "2026-11-04"]);
    assert.deepEqual(range({ op: "before", value: "2026-11-03" }), [null, "2026-11-03"]);
    assert.deepEqual(range({ op: "onOrBefore", value: "2026-11-03" }), [null, "2026-11-04"]);
    assert.deepEqual(range({ op: "after", value: "2026-11-03" }), ["2026-11-04", null]);
    assert.deepEqual(range({ op: "onOrAfter", value: "2026-11-03" }), ["2026-11-03", null]);
    assert.deepEqual(range({ op: "between", value: "2026-11-01", to: "2026-11-03" }), ["2026-11-01", "2026-11-04"]);
  });
  test("lastN includes today; prevN excludes it; months clamp the day", () => {
    assert.deepEqual(range({ op: "lastN", n: 7, unit: "days" }), ["2026-11-19", "2026-11-26"]);
    assert.deepEqual(range({ op: "prevN", n: 7, unit: "days" }), ["2026-11-18", "2026-11-25"]);
    assert.deepEqual(range({ op: "lastN", n: 1, unit: "weeks" }), ["2026-11-19", "2026-11-26"]);
    assert.deepEqual(range({ op: "prevN", n: 2, unit: "weeks" }), ["2026-11-11", "2026-11-25"]);
    assert.deepEqual(range({ op: "lastN", n: 1, unit: "months" }), ["2026-10-26", "2026-11-26"]);
    assert.deepEqual(range({ op: "prevN", n: 1, unit: "months" }), ["2026-10-25", "2026-11-25"]);
    assert.deepEqual(range({ op: "prevN", n: 1, unit: "months" }, new Date("2026-03-31T23:59:59Z")), ["2026-02-28", "2026-03-31"]);
    assert.deepEqual(range({ op: "thisWeek" }, new Date("2026-11-29T23:00:00Z")), ["2026-11-23", "2026-11-30"], "Sunday is the week's last day");
    assert.deepEqual(range({ op: "thisWeek" }, new Date("2026-11-30T00:00:00Z")), ["2026-11-30", "2026-12-07"], "Monday starts a week");
    for (const [n, unit] of [[0, "days"], [367, "days"], [1.5, "days"], ["3", "days"], [3, "years"], [3, null]]) bad(I, root({ field: "Posting_Date", op: "lastN", n, unit }));
  });
  test("ranges on the pre-1900 sentinel field never match the sentinel; blank does", () => {
    const before = fc.compileFilter(I, ok(I, root({ field: "Expiration_Date", op: "before", value: "2027-01-01" })), { now: NOW });
    assert.deepEqual(before.Expiration_Date.$gte, new Date("1900-01-01T00:00:00Z"));
    const blank = fc.compileFilter(I, ok(I, root({ field: "Expiration_Date", op: "blank" })), { now: NOW });
    assert.deepEqual(blank, { $or: [{ Expiration_Date: null }, { Expiration_Date: { $lt: new Date("1900-01-01T00:00:00Z") } }] });
    assert.deepEqual(fc.compileFilter(I, ok(I, root({ field: "Expiration_Date", op: "notBlank" }))), { $nor: [blank] });
  });
});

describe("Structure, limits, injection", () => {
  test("version, groups, depth ≤ 2, ≤ 20 conditions, ≤ 10 groups", () => {
    bad(I, { op: "and", items: [] }, "version");
    bad(I, { v: 2, op: "and", items: [] }, "version");
    bad(I, { v: 1, op: "xor", items: [] }, "groupOp");
    bad(I, root({ op: "or", items: [] }), "empty");
    const c = { field: "Item_No", op: "eq", value: "x" };
    ok(I, root({ op: "or", items: [c, c] }));
    bad(I, root({ op: "or", items: [{ op: "and", items: [c] }] }), "tooDeep");
    ok(I, root(...Array(20).fill(c)));
    bad(I, root(...Array(21).fill(c)), "tooManyConditions");
    bad(I, root(...Array(10).fill({ op: "or", items: [c] })), "tooManyGroups");
    ok(I, root(...Array(9).fill({ op: "or", items: [c] })));
    assert.deepEqual(ok(I, root()), { v: 1, op: "and", items: [] });
    assert.equal(fc.compileFilter(I, ok(I, root())), null);
  });

  test("lists 1–200 (deduplicated), text ≤ 100 characters without control characters", () => {
    bad(I, root({ field: "Item_No", op: "in", values: [] }), "list");
    bad(I, root({ field: "Item_No", op: "in", values: Array.from({ length: 201 }, (_, i) => `v${i}`) }), "list");
    assert.deepEqual(ok(I, root({ field: "Item_No", op: "in", values: ["a", "a", null, null, ""] })).items[0].values, ["a", null, ""]);
    ok(I, root({ field: "Item_No", op: "eq", value: "x".repeat(100) }));
    bad(I, root({ field: "Item_No", op: "eq", value: "x".repeat(101) }), "value");
    bad(I, root({ field: "Item_No", op: "eq", value: "a\u0000b" }), "value");
    bad(I, root({ field: "Item_No", op: "contains", value: "" }), "value");
    bad(I, root({ field: "Item_No", op: "contains", value: null }), "value");
  });

  test("operator keys, prototype keys, expressions and unknown keys are refused; values never become operators", () => {
    const attempts = [
      root({ field: "$where", op: "eq", value: "1" }), root({ field: "Item_No", op: "$where", value: "1" }), root({ field: "Item_No", op: "regex", value: ".*" }),
      root({ field: "Item_No", op: "eq", value: { $ne: null } }), root({ field: "Item_No", op: "in", values: [{ $gt: "" }] }), root({ field: "Item_No", op: "eq", value: "x", $expr: { $eq: [1, 1] } }),
      root({ field: "constructor", op: "eq", value: "x" }), root({ field: "__proto__", op: "eq", value: "x" }), root({ field: "toString", op: "eq", value: "x" }),
      root({ field: "Item_No", op: "toString", value: "x" }), root({ field: "Item_No", op: "eq", value: "x", options: "i" }), root({ $where: "1" }),
      { v: 1, op: "and", items: [], $where: "sleep(1)" }, root({ op: "and", items: [], extra: 1 }), root("Item_No"), root(null), root([])
    ];
    for (const model of attempts) bad(I, model);
    // JSON-level __proto__ (JSON.parse makes it an own key): refused as an unknown key, never merged into a prototype.
    bad(I, JSON.parse('{"v":1,"op":"and","items":[{"field":"Item_No","op":"eq","value":"x","__proto__":{"op":"ne"}}]}'), "unknownKey");
    bad(I, JSON.parse('{"__proto__":{"v":1},"op":"and","items":[]}'), "unknownKey");
    assert.equal({}.op, undefined);
    // Regex metacharacters are escaped: they match literally.
    const out = fc.compileFilter(I, ok(I, root({ field: "Item_No", op: "contains", value: ".*(a|b)$^[" }, { field: "Item_No", op: "startsWith", value: "^x." })));
    assert.equal(out.$and[0].Item_No.$regex, "\\.\\*\\(a\\|b\\)\\$\\^\\[");
    assert.equal(out.$and[1].Item_No.$regex, "^\\^x\\.");
    assert.equal(out.$and[1].Item_No.$options, undefined, "startsWith is case-sensitive");
  });

  test("sensitive, dotted and disabled fields are refused exactly like an unknown field, without naming it", () => {
    const messages = new Set();
    for (const [ds, field] of [[S, "landed_cost"], [S, "Custom.2"], [S, "custom_1"], [S, "Text"], [S, "invoice_status"], [I, "Cost_Amount_Actual"], [I, "trade_price"], [I, "ETag"], [I, "Open"], [I, "RunningBalance"], [I, "NoSuchField"]]) {
      assert.throws(() => ok(ds, root({ field, op: "eq", value: "1" })), (e) => { assert.equal(e.details.reason, "unknownField"); assert.ok(!e.message.includes(field)); messages.add(e.message); return true; });
      assert.deepEqual(fm.fieldOperators(ds, field), []);
      assert.equal(fm.orderable(ds, field), false);
    }
    assert.equal(messages.size, 1);
  });

  test("filter= transport: base64url only, ≤ 6000 characters, ≤ 4096 bytes of JSON; canonical round trip", () => {
    const model = root({ op: "or", items: [{ value: "x", op: "eq", field: "Item_No" }] });
    const text = fm.encodeFilterParam(model);
    assert.deepEqual(fm.parseFilterParam(text), { v: 1, op: "and", items: [{ op: "or", items: [{ field: "Item_No", op: "eq", value: "x" }] }] });
    for (const t of ["", "a b", "x".repeat(6001), "abc+/=", Buffer.from("not json").toString("base64url")]) assert.throws(() => fm.parseFilterParam(t), (e) => e.code === "VALIDATION_ERROR");
    const big = Buffer.from(JSON.stringify(root(...Array(28).fill({ field: "Item_Description", op: "eq", value: "y".repeat(100) })))).toString("base64url");
    assert.ok(big.length <= 6000);
    assert.throws(() => fm.parseFilterParam(big), (e) => e.details.reason === "tooLong");
    // validate (the B2/B3 adapter): canonical form, no ranges.
    assert.deepEqual(fm.validate(root({ field: "Posting_Date", op: "today" }), { dataset: I }), root({ field: "Posting_Date", op: "today" }));
    assert.equal(fm.checkFilter(I, root({ field: "trade_price", op: "eq", value: "1" })).problem, "uses a field you can't use now");
  });

  test("semantics in the compiled filter: ne/nin include blanks, blank covers null, missing, empty and whitespace", () => {
    const c = (cond) => fc.compileFilter(I, ok(I, root(cond)), { now: NOW });
    assert.deepEqual(c({ field: "Item_No", op: "ne", value: "x" }), { Item_No: { $ne: "x" } });
    assert.deepEqual(c({ field: "Item_No", op: "nin", values: ["x"] }), { Item_No: { $nin: ["x"] } });
    assert.deepEqual(c({ field: "Item_No", op: "blank" }), { $or: [{ Item_No: null }, { Item_No: { $regex: "^\\s*$" } }] });
    assert.deepEqual(c({ field: "Item_No", op: "isNull" }), { Item_No: { $type: "null" } });
    assert.deepEqual(c({ field: "Item_No", op: "missing" }), { Item_No: { $exists: false } });
    assert.deepEqual(c({ field: "Item_No", op: "notContains", value: "a" }), { Item_No: { $not: { $regex: "a", $options: "i" } } });
    assert.deepEqual(c({ field: "Completely_Invoiced", op: "isFalse" }), { Completely_Invoiced: false });
  });

  test("bounded rule (indexed mode): bounded conditions need the window or a top-level indexed equality", () => {
    const keys = ["invoice_date", "Company", "invoice_id"];
    const m = (...items) => ok(S, root(...items));
    const contains = { field: "customer_name", op: "contains", value: "a" };
    const company = { field: "Company", op: "eq", value: "ALPHA" };
    assert.equal(fc.boundedProblem(S, m(contains), { mode: "indexed", hasWindow: true, indexKeys: keys }), null);
    assert.equal(fc.boundedProblem(S, m(contains), { mode: "indexed", hasWindow: false, indexKeys: keys }), "bounded");
    assert.equal(fc.boundedProblem(S, m(contains), { mode: "small", hasWindow: false, indexKeys: keys }), null);
    assert.equal(fc.boundedProblem(S, m(contains, company), { mode: "indexed", hasWindow: false, indexKeys: keys }), null);
    assert.equal(fc.boundedProblem(S, m({ op: "or", items: [contains, company] }), { mode: "indexed", hasWindow: false, indexKeys: keys }), "bounded", "an OR with a bounded branch doesn't bound");
    assert.equal(fc.boundedProblem(S, m(contains, { field: "Company", op: "eq", value: null }), { mode: "indexed", hasWindow: false, indexKeys: keys }), "bounded", "null equality also matches missing");
    assert.equal(fm.operatorClass(S, "Company", "in"), "fast");
    assert.equal(fm.operatorClass(S, "invoice_date", "lastN"), "fast");
    assert.equal(fm.operatorClass(S, "customer_name", "eq"), "bounded");
  });

  test("non-decimal numbers: more than 15 significant digits are refused (no silent rounding); decimal fields keep 34 (I2)", () => {
    const gt = (field, value) => root({ field, op: "gt", value });
    assert.equal(S.types.Line_No, "number");
    assert.equal(S.types.Unit_Price, "decimal");
    for (const v of ["9".repeat(16), "9".repeat(34), "1234567890.123456", "-0.1234567890123456", "12345678901234567"]) bad(S, gt("Line_No", v), "precision");
    bad(S, root({ field: "Line_No", op: "between", value: "1", to: "9".repeat(20) }), "precision");
    for (const v of ["9".repeat(15), "123456789012.345", "0.000123456789012345", "1000000000000000000000", "-12.50000000000000000000", "0"]) assert.doesNotThrow(() => ok(S, gt("Line_No", v)), v);
    for (const v of ["9".repeat(34), "1.000000000000000000000000000000001"]) assert.doesNotThrow(() => ok(S, gt("Unit_Price", v)), v);
    // The message never echoes the value.
    try { ok(S, gt("Line_No", "98765432109876543")); assert.fail("refused"); } catch (e) { assert.ok(!e.message.includes("98765432109876543")); }
  });

  test("orderBy parsing: ≤ 3 distinct orderable fields", () => {
    assert.deepEqual(fm.parseOrderBy(I, "Posting_Date:desc,Item_No:asc"), [["Posting_Date", -1], ["Item_No", 1]]);
    for (const t of ["", "a:asc,b:asc,c:asc,d:asc", "Item_No", "Item_No:up", "Item_No:asc,Item_No:desc", "trade_price:asc", "_id:asc", "$natural:asc", "__proto__:asc"]) assert.throws(() => fm.parseOrderBy(I, t), (e) => e.code === "VALIDATION_ERROR", t);
  });
});
