// Guided forms ("SuperForms") without a browser: the shared rules engine (site/assets/FormRules.js, used by both the
// browser and the server), the extended form definition (domain/form.js) and the server-side submission rules.
// App code only (no migration code); generic synthetic data only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../src/domain/form-rules");
const browserRules = require("../../site/assets/FormRules.js");
const { cleanForm, submittedValues } = require("../src/domain/form");
const F = require("./support/superform-fixture");

const form = (fields, extra = {}) => ({ fields, ...extra });
describe("one rules engine for browser and server", () => {
  test("the server's rules are the browser's file", () => { assert.equal(rules, browserRules); });
  const f = form([{ key: "kind" }, { key: "tags" }, { key: "a", showWhen: { all: [{ key: "kind", cmp: "equals", values: ["SELLER"] }, { any: [{ key: "tags", cmp: "contains", values: ["vip"] }, { key: "tags", cmp: "isEmpty" }] }] } }, { key: "b", showWhen: { key: "a", cmp: "isNotEmpty" } }, { key: "c", showWhen: { key: "kind", cmp: "notEquals", values: ["SELLER"] } }]);
  const applies = (key, values) => rules.fieldApplies(f.fields.find((x) => x.key === key), f, values);
  test("AND / OR groups with equals, not equals, contains, is empty, is not empty", () => {
    assert.equal(applies("a", { kind: "SELLER" }), true, "seller, no tags");
    assert.equal(applies("a", { kind: "SELLER", tags: ["Big VIP"] }), true, "contains, case-insensitive");
    assert.equal(applies("a", { kind: "SELLER", tags: ["other"] }), false);
    assert.equal(applies("a", { kind: "BUYER" }), false);
    assert.equal(applies("c", { kind: "BUYER" }), true); assert.equal(applies("c", { kind: "SELLER" }), false); assert.equal(applies("c", {}), true);
  });
  test("chains: a question depending on one that doesn't apply sees it as empty; loops never apply", () => {
    assert.equal(applies("b", { kind: "BUYER", a: "stale" }), false, "a doesn't apply, so its stale value doesn't count");
    assert.equal(applies("b", { kind: "SELLER", a: "x" }), true);
    const loop = form([{ key: "x", showWhen: { key: "y", cmp: "isNotEmpty" } }, { key: "y", showWhen: { key: "x", cmp: "isEmpty" } }]);
    assert.equal(rules.fieldApplies(loop.fields[0], loop, {}), false);
  });
  test("the original comparisons behave as before (a condition on a question that doesn't apply is false)", () => {
    const old = form([{ key: "s" }, { key: "w", showWhen: { key: "s", cmp: "is", values: ["Done"] } }, { key: "z", showWhen: { key: "w", cmp: "isNot", values: ["x"] } }]);
    assert.equal(rules.fieldApplies(old.fields[2], old, { s: "New" }), false);
    assert.equal(rules.fieldApplies(old.fields[2], old, { s: "Done", w: "y" }), true);
  });
  test("required and conditionally required, only when the question applies", () => {
    const r = form([{ key: "kind" }, { key: "doc", requiredWhen: { key: "kind", cmp: "equals", values: ["SELLER"] } }, { key: "x", required: true, showWhen: { key: "kind", cmp: "isNotEmpty" } }]);
    assert.equal(rules.isRequired(r.fields[1], r, { kind: "SELLER" }), true);
    assert.equal(rules.isRequired(r.fields[1], r, { kind: "BUYER" }), false);
    assert.equal(rules.isRequired(r.fields[2], r, {}), false, "doesn't apply, so not required");
  });
  test("exact decimals: no floating-point drift, no silent rounding", () => {
    const d = rules.decimal, run = (op, a, b) => rules.calculate({ enabled: true, op, args: [{ value: a }, { value: b }] }, form([]), {});
    assert.equal(run("add", "0.1", "0.2").value, "0.3");
    assert.equal(run("subtract", "100", "4.17").value, "95.83");
    assert.equal(run("percentOf", "1234.56", "4.17").value, "51.481152");
    assert.deepEqual(run("divide", "100", "3"), { value: "33.3333333333", rounded: true });
    assert.deepEqual(run("divide", "100", "4"), { value: "25", rounded: false });
    assert.equal(run("divide", "1", "0"), null);
    assert.equal(d.compare(d.parse("1.50"), d.parse("1.5")), 0);
    assert.equal(d.parse("1e3"), null); assert.equal(d.parse("1,5"), null);
  });
  test("a calculation that isn't enabled, or misses an input, shows nothing", () => {
    const f2 = form([{ key: "p" }, { key: "q" }]);
    assert.equal(rules.calculate({ enabled: false, op: "add", args: [{ key: "p" }, { value: "1" }] }, f2, { p: "1" }), null);
    assert.equal(rules.calculate({ enabled: true, op: "add", args: [{ key: "p" }, { key: "q" }] }, f2, { p: "1" }), null);
  });
  test("validation rules: bounds, decimal places (trailing zeros don't count), lengths", () => {
    const col = { type: "number", label: "% Down" }, field = { key: "p", validation: { min: "0", max: "100", maxDecimals: 2 } };
    assert.equal(rules.checkRules(field, col, "4.17"), null); assert.equal(rules.checkRules(field, col, "100"), null); assert.equal(rules.checkRules(field, col, "1.500"), null);
    assert.match(rules.checkRules(field, col, "100.01"), /at most 100/); assert.match(rules.checkRules(field, col, "-1"), /at least 0/); assert.match(rules.checkRules(field, col, "4.175"), /2 decimal places/);
    assert.match(rules.checkRules({ key: "t", validation: { maxLength: 3 } }, { type: "text", label: "T" }, "abcd"), /at most 3 characters/);
  });
});

const BOARD = { groups: [{ id: "grp_pending", name: "Pending" }], columns: [{ key: "serial", label: "Name", type: "text" }, { key: "kind", label: "Party Type", type: "status", options: ["BUYER", "SELLER"] }, { key: "pct", label: "% Down", type: "number" }, { key: "bal", label: "% Balance", type: "number" }, { key: "freq", label: "Frequency", type: "number" }, { key: "codes", label: "Code", type: "dropdown", multiple: true, options: ["T-01", "T-02"] }, { key: "who", label: "Party", type: "text" }, { key: "acc", label: "Accreditation", type: "files" }, { key: "credit", label: "Credit Form", type: "files" }] };
const WIZ = (over = {}) => ({ name: "Super", status: "published", mode: "create", groupId: "grp_pending", layout: "wizard", review: true, sections: [{ id: "one", title: "One" }, { id: "two", title: "Two" }],
  fields: [{ key: "serial", section: "one" }, { key: "kind", section: "one", required: true }, { key: "codes", section: "one" }, { key: "who", section: "one", validation: { maxLength: 20 } }, { key: "pct", section: "two", suffix: "%", validation: { min: "0", max: "100" } }, { key: "bal", section: "two", suffix: "%", validation: { min: "0", max: "100" } }, { key: "freq", section: "two", validation: { min: "0", maxDecimals: 0 } }, { key: "acc", section: "two", showWhen: { key: "kind", cmp: "equals", values: ["SELLER"] }, requiredWhen: { key: "kind", cmp: "equals", values: ["SELLER"] } }, { key: "credit", section: "two", showWhen: { key: "kind", cmp: "equals", values: ["BUYER"] } }],
  calculations: [{ id: "bal", label: "Suggested % Balance", op: "subtract", args: [{ value: "100" }, { key: "pct" }], target: "bal", enabled: true }], ...over });

describe("guided form definitions", () => {
  test("a guided definition is kept, marked schemaVersion 2, and cleaning it again changes nothing", () => {
    const a = cleanForm(WIZ(), BOARD);
    assert.equal(a.schemaVersion, 2); assert.equal(a.layout, "wizard"); assert.equal(a.review, true); assert.equal(a.sections.length, 2); assert.equal(a.calculations[0].enabled, true);
    assert.deepEqual(cleanForm({ ...a }, BOARD), a);
  });
  test("the shared fixture's guided form is exactly what JARC's own rules store", () => {
    const board = { groups: F.GROUPS, columns: F.COLUMNS };
    assert.deepEqual(cleanForm(F.definition(F.GUIDED), board), Object.fromEntries(Object.entries(F.GUIDED)));
  });
  test("an older definition keeps exactly its old shape (no new keys), and is stable too", () => {
    const old = cleanForm({ name: "F", status: "published", fields: [{ key: "serial" }, { key: "kind" }, { key: "who", showWhen: { key: "kind", cmp: "is", values: ["SELLER"] } }] }, BOARD);
    assert.equal("schemaVersion" in old, false); assert.equal("layout" in old, false);
    assert.deepEqual(cleanForm({ ...old }, BOARD), old);
  });
  test("bad guided definitions are refused", () => {
    const bad = [
      { sections: undefined }, { sections: [] }, { sections: [{ id: "Bad Id", title: "x" }] }, { sections: [{ id: "one", title: "x" }, { id: "one", title: "y" }] },
      { fields: [{ key: "serial" }] }, { fields: [{ key: "serial", section: "nowhere" }] },
      { fields: [{ key: "serial", section: "one" }, { key: "kind", section: "one", showWhen: { key: "kind", cmp: "equals", values: ["x"] } }] },
      { fields: [{ key: "serial", section: "one" }, { key: "kind", section: "one", showWhen: { key: "serial", cmp: "matches", values: ["x"] } }] },
      { fields: [{ key: "serial", section: "one" }, { key: "kind", section: "one", showWhen: { all: [] } }] },
      { fields: [{ key: "serial", section: "one" }, { key: "kind", section: "one", showWhen: { all: [{ any: [{ all: [{ any: [{ key: "serial", cmp: "isEmpty" }] }] }] }] } }] },
      { fields: [{ key: "serial", section: "one" }, { key: "kind", section: "one", required: true, requiredWhen: { key: "serial", cmp: "isEmpty" } }] },
      { fields: [{ key: "serial", section: "one", validation: { min: "1" } }] },
      { fields: [{ key: "serial", section: "one" }, { key: "pct", section: "one", validation: { min: "5", max: "1" } }] },
      { fields: [{ key: "serial", section: "one" }, { key: "pct", section: "one", validation: { max: 100 } }] },
      { calculations: [{ id: "x", label: "x", op: "subtract", args: [{ value: "100" }, { key: "who" }], enabled: true }] },
      { calculations: [{ id: "x", label: "x", op: "pow", args: [{ value: "1" }, { value: "2" }], enabled: true }] },
      { calculations: [{ id: "x", label: "x", op: "add", args: [{ value: "1" }, { value: "2" }] }] },
      { layout: "carousel" }, { public: true }
    ];
    for (const over of bad) assert.throws(() => cleanForm(WIZ(over), BOARD), undefined, JSON.stringify(over));
  });
  test("the designer's simple conditions are still accepted as before", () => {
    assert.ok(cleanForm({ name: "F", fields: [{ key: "serial" }, { key: "who", showWhen: { key: "serial", cmp: "hasValue" } }] }, BOARD));
  });
});

describe("guided form submissions (server rules)", () => {
  const f = cleanForm(WIZ(), BOARD);
  const base = { serial: "New agreement", kind: "SELLER" };
  test("values are kept exactly; empty numbers are left out, never stored as 0", () => {
    const { values, missing } = submittedValues(f, BOARD, { ...base, pct: "4.17", codes: ["T-01", "T-02"] }, { files: { acc: 1 } });
    assert.deepEqual(missing, []); assert.equal(values.pct, "4.17"); assert.deepEqual(values.codes, ["T-01", "T-02"]); assert.equal("bal" in values, false);
  });
  test("bounds, decimal places and lengths are enforced by the server", () => {
    for (const bad of [{ pct: "101" }, { pct: "-1" }, { freq: "1.5" }, { who: "x".repeat(21) }, { pct: "abc" }]) assert.throws(() => submittedValues(f, BOARD, { ...base, ...bad }, { files: { acc: 1 } }), undefined, JSON.stringify(bad));
  });
  test("conditionally required: a seller agreement needs its accreditation file; a buyer agreement doesn't", () => {
    assert.deepEqual(submittedValues(f, BOARD, base).missing, ["Accreditation"]);
    assert.deepEqual(submittedValues(f, BOARD, { ...base, kind: "BUYER" }).missing, []);
  });
  test("answers and files for questions that don't apply are refused (no stale values)", () => {
    assert.throws(() => submittedValues(f, BOARD, { ...base, kind: "BUYER" }, { files: { acc: 1 } }), /doesn't apply/);
    assert.throws(() => submittedValues(f, BOARD, base, { files: { acc: 1, credit: 1 } }), /doesn't apply/);
  });
  test("unknown file questions, bad counts and invented choices are refused; Party Type is required", () => {
    assert.throws(() => submittedValues(f, BOARD, base, { files: { nope: 1 } }), /no file question/);
    assert.throws(() => submittedValues(f, BOARD, base, { files: { acc: 21 } }), /0 to 20/);
    assert.throws(() => submittedValues(f, BOARD, { ...base, codes: ["T-99"] }, { files: { acc: 1 } }), /one of its choices/);
    assert.deepEqual(submittedValues(f, BOARD, { serial: "x" }).missing, ["Party Type"]);
  });
});
