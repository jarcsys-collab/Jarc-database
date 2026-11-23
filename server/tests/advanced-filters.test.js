// Advanced filters (domain/record-filter.js): relative dates, numeric comparisons, group filters, "@me", nesting and
// limits — the date arithmetic on its own, then against the real resource API on the fake MongoDB (synthetic data).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { startMongoApp, api } = require("./helpers");
const F = require("../src/domain/record-filter");

describe("Dates: today in Asia/Manila and periods counted from it", () => {
  test("today changes at midnight Manila time (UTC+8), not UTC; always YYYY-MM-DD", () => {
    assert.equal(F.dayIn(new Date("2026-11-20T15:59:59Z")), "2026-11-20");
    assert.equal(F.dayIn(new Date("2026-11-20T16:00:00Z")), "2026-11-21");
    assert.equal(F.dayIn(new Date("2026-12-31T16:00:00Z")), "2027-01-01", "year rollover");
    assert.equal(F.dayIn(new Date("2026-03-05T00:00:00Z")), "2026-03-05");
    assert.match(F.dayIn(), /^\d{4}-\d{2}-\d{2}$/);
  });
  test("weeks run Monday to Sunday, from any day of the week", () => {
    assert.deepEqual(F.presetRange("thisWeek", 0, "2026-11-16"), ["2026-11-16", "2026-11-22"], "a Monday");
    assert.deepEqual(F.presetRange("thisWeek", 0, "2026-11-22"), ["2026-11-16", "2026-11-22"], "a Sunday");
    assert.deepEqual(F.presetRange("lastWeek", 0, "2026-11-20"), ["2026-11-09", "2026-11-15"]);
    assert.deepEqual(F.presetRange("nextWeek", 0, "2026-11-20"), ["2026-11-23", "2026-11-29"]);
    assert.deepEqual(F.presetRange("thisWeek", 0, "2026-12-31"), ["2026-12-28", "2027-01-03"], "across a year end");
  });
  test("months: their real lengths, leap years, year ends", () => {
    assert.deepEqual(F.presetRange("thisMonth", 0, "2028-02-10"), ["2028-02-01", "2028-02-29"], "leap year");
    assert.deepEqual(F.presetRange("lastMonth", 0, "2026-03-31"), ["2026-02-01", "2026-02-28"]);
    assert.deepEqual(F.presetRange("lastMonth", 0, "2026-01-15"), ["2025-12-01", "2025-12-31"]);
    assert.deepEqual(F.presetRange("nextMonth", 0, "2026-12-15"), ["2027-01-01", "2027-01-31"]);
    assert.deepEqual(F.presetRange("nextMonth", 0, "2026-01-31"), ["2026-02-01", "2026-02-28"], "from the 31st");
  });
  test("days: yesterday, tomorrow, past N and next N days include today", () => {
    assert.deepEqual(F.presetRange("yesterday", 0, "2026-03-01"), ["2026-02-28", "2026-02-28"]);
    assert.deepEqual(F.presetRange("tomorrow", 0, "2026-02-28"), ["2026-03-01", "2026-03-01"]);
    assert.deepEqual(F.presetRange("pastDays", 7, "2026-11-20"), ["2026-11-13", "2026-11-20"]);
    assert.deepEqual(F.presetRange("nextDays", 30, "2026-11-20"), ["2026-11-20", "2026-12-20"]);
  });
  test("a saved period means the period when it is read, not when it was saved", () => {
    const filter = { op: "and", rules: [{ key: "due", cmp: "datePreset", values: ["nextDays", "7"] }] };
    const byKey = new Map([["due", { key: "due", type: "date" }]]);
    assert.deepEqual(F.resolveFilter(filter, { today: "2026-11-20" }, byKey).rules[0], { key: "due", cmp: "dateRange", values: ["2026-11-20", "2026-11-27"] });
    assert.deepEqual(F.resolveFilter(filter, { today: "2027-02-01" }, byKey).rules[0].values, ["2027-02-01", "2027-02-08"]);
  });
});

describe("Validation", () => {
  const board = { columns: [{ key: "serial", type: "text" }, { key: "qty", type: "number" }, { key: "due", type: "date" }, { key: "done", type: "checkbox" }, { key: "owner", type: "owner" }, { key: "grp", type: "group" }] };
  const ok = (rules, extra = {}) => F.filterForBoard({ op: "and", rules, ...extra }, board);
  const bad = (rules, re, extra = {}) => assert.throws(() => ok(rules, extra), re);
  test("the new comparisons check their values and the column's type", () => {
    bad([{ key: "qty", cmp: "eq", values: ["seven"] }], /needs a number/);
    bad([{ key: "qty", cmp: "between", values: ["1"] }], /from and a to/);
    bad([{ key: "due", cmp: "datePreset", values: ["fortnight"] }], /unknown period/);
    bad([{ key: "due", cmp: "datePreset", values: ["pastDays", "0"] }], /number of days/);
    bad([{ key: "due", cmp: "datePreset", values: ["pastDays", "99999"] }], /number of days/);
    bad([{ key: "due", cmp: "datePreset", values: ["today", "3"] }], /just the period/);
    bad([{ key: "serial", cmp: "datePreset", values: ["today"] }], /period of dates/);
    bad([{ key: "serial", cmp: "checked" }], /checked or unchecked/);
    bad([{ key: "due", cmp: "gte", values: ["5"] }], /as a number/);
    bad([{ key: "grp", cmp: "contains", values: ["A"] }], /except by is/);
    ok([{ key: "qty", cmp: "between", values: ["1", "9.5"] }, { key: "due", cmp: "datePreset", values: ["nextDays", "30"] }, { key: "done", cmp: "checked" }, { key: "owner", cmp: "in", values: ["@me"] }, { key: "grp", cmp: "notIn", values: ["A", ""] }]);
  });
  test("comparisons that existed before keep accepting what they accepted (saved views stay valid)", () => {
    ok([{ key: "qty", cmp: "gt", values: ["not a number"] }, { key: "due", cmp: "dateRange", values: ["2026", "anything"] }, { key: "serial", cmp: "contains", values: ["@me"] }, { key: "serial", cmp: "in", values: ["@me"] }]);
  });
  test("nesting up to three levels; limits on groups and conditions; nothing but known fields", () => {
    const leaf = { key: "serial", cmp: "contains", values: ["a"] };
    ok([leaf], { groups: [{ op: "or", rules: [leaf], groups: [{ op: "and", rules: [leaf], groups: [{ op: "or", rules: [leaf] }] }] }] });
    bad([leaf], /at most 3 levels/, { groups: [{ op: "or", rules: [leaf], groups: [{ op: "and", rules: [leaf], groups: [{ op: "or", rules: [leaf], groups: [{ op: "and", rules: [leaf] }] }] }] }] });
    bad(Array.from({ length: 26 }, () => leaf), /at most 25 conditions/);
    bad([leaf], /at most 10 groups/, { groups: Array.from({ length: 11 }, () => ({ op: "and", rules: [leaf] })) });
    // The limits count nested groups and their conditions too.
    bad([leaf], /at most 25 conditions/, { groups: [{ op: "or", rules: Array.from({ length: 12 }, () => leaf), groups: [{ op: "and", rules: Array.from({ length: 13 }, () => leaf) }] }] });
    bad([{ key: "$where", cmp: "in", values: ["x"] }], /invalid column/);
    bad([leaf], /unknown field/, { $where: "1" });
    bad([{ ...leaf, $regex: ".*" }], /unknown field/);
  });
});

describe("Against the API: every record of the board, whoever reads", () => {
  let app, ws, board, other;
  const call = (method, p, body) => api(app.url, method, p, body);
  const rows = async (filter, extra = "") => {
    const items = []; let cursor = "";
    do { const r = await call("GET", `/api/v1/boards/${board.id}/records?limit=50&filter=${encodeURIComponent(JSON.stringify(filter))}${extra}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); assert.equal(r.status, 200, JSON.stringify(r.body)); items.push(...r.body.items); cursor = r.body.nextCursor || ""; } while (cursor);
    return items.map((r) => r.values.serial).sort();
  };
  const count = async (filter) => (await call("GET", `/api/v1/boards/${board.id}/records/count?filter=${encodeURIComponent(JSON.stringify(filter))}`)).body.total;
  const where = (...rules) => ({ op: "and", rules });

  before(async () => {
    app = await startMongoApp();
    other = new ObjectId();
    await app.db.collection("users").insertOne({ _id: other, displayName: "Another Person", status: "active", email: "another@example.invalid", emailNormalized: "another@example.invalid", createdAt: new Date() });
    ws = (await call("POST", "/api/v1/workspaces", { name: "Filters" })).body.workspace.id;
    board = (await call("POST", `/api/v1/workspaces/${ws}/boards`, { name: "Filter Board", groups: [{ name: "Alpha" }, { name: "Beta" }], columns: [{ key: "serial", label: "Name", type: "text", required: true }, { key: "qty", label: "Qty", type: "number" }, { key: "qtyText", label: "Qty as text", type: "text" }, { key: "due", label: "Due", type: "date" }, { key: "done", label: "Done", type: "checkbox" }, { key: "owner", label: "Owner", type: "owner" }, { key: "grp", label: "Group", type: "group" }] })).body.board;
    const today = F.dayIn(), me = `user:${app.devActor._id.toHexString()}`, them = `user:${other.toHexString()}`;
    const g = (name) => board.groups.find((x) => x.name === name).id;
    const records = [
      { values: { serial: "n05", qty: 5, qtyText: "5" }, groupId: g("Alpha") },
      { values: { serial: "n07", qty: 7, qtyText: "7" }, groupId: g("Alpha") },
      { values: { serial: "n10", qty: 10, qtyText: "10.0" }, groupId: g("Beta") },
      { values: { serial: "nEmpty", qtyText: "" } },
      { values: { serial: "nWords", qtyText: "abc" } },
      { values: { serial: "dToday", due: today, done: true, owner: [me] }, groupId: g("Beta") },
      { values: { serial: "dYesterday", due: F.addDays(today, -1), done: false, owner: [them] } },
      { values: { serial: "dTomorrow", due: F.addDays(today, 1), owner: [me, them] } },
      { values: { serial: "dPlus8", due: F.addDays(today, 8) } },
      { values: { serial: "dMinus8", due: F.addDays(today, -8) } },
      // Far past the first page (limit 50): a match must still be found.
      ...Array.from({ length: 290 }, (_, i) => ({ values: { serial: `filler${String(i).padStart(3, "0")}`, qtyText: i === 289 ? "4242" : "" } }))
    ];
    for (let i = 0; i < records.length; i += 200) assert.equal((await call("POST", `/api/v1/boards/${board.id}/records/batch`, { records: records.slice(i, i + 200) })).status, 201);
  });
  after(async () => { await app.close(); });

  test("numbers: equal, not equal, at least, at most, between; numbers kept as text count; empty and words never match a number", async () => {
    assert.deepEqual(await rows(where({ key: "qty", cmp: "eq", values: ["7"] })), ["n07"]);
    assert.deepEqual(await rows(where({ key: "qtyText", cmp: "eq", values: ["10"] })), ["n10"], "\"10.0\" as text is 10");
    assert.deepEqual(await rows(where({ key: "qty", cmp: "gte", values: ["7"] })), ["n07", "n10"]);
    assert.deepEqual(await rows(where({ key: "qty", cmp: "lte", values: ["7"] })), ["n05", "n07"]);
    assert.deepEqual(await rows(where({ key: "qtyText", cmp: "between", values: ["5", "7"] })), ["n05", "n07"]);
    const ne = await rows(where({ key: "qtyText", cmp: "ne", values: ["7"] }));
    assert.ok(ne.includes("n05") && ne.includes("nEmpty") && ne.includes("nWords") && !ne.includes("n07"), "ne: everything that isn't 7, empty and words included");
    assert.deepEqual(await rows(where({ key: "qty", cmp: "gt", values: ["6"] })), ["n07", "n10"], "the older gt is unchanged");
    // Words and empty cells never count as a number (MongoDB orders null below every number: they must not be "less than").
    for (const [cmp, values] of [["lte", ["7"]], ["lt", ["6"]], ["eq", ["0"]], ["between", ["-1000", "1000"]]]) {
      const got = await rows(where({ key: "qtyText", cmp, values }));
      assert.ok(!got.includes("nWords") && !got.includes("nEmpty") && !got.includes("filler000"), `${cmp}: ${got.slice(0, 5)}`);
    }
  });

  test("a match beyond the first page is found, and counted", async () => {
    assert.deepEqual(await rows(where({ key: "qtyText", cmp: "eq", values: ["4242"] })), ["filler289"]);
    assert.equal(await count(where({ key: "serial", cmp: "startsWith", values: ["filler"] })), 290);
    assert.equal(await count(where({ key: "serial", cmp: "endsWith", values: ["289"] })), 1);
    assert.equal(await count(where({ key: "serial", cmp: "contains", values: [".*"] })), 0, "a pattern is plain text");
  });

  test("relative dates are counted from today when read; checkboxes", async () => {
    assert.deepEqual(await rows(where({ key: "due", cmp: "datePreset", values: ["today"] })), ["dToday"]);
    assert.deepEqual(await rows(where({ key: "due", cmp: "datePreset", values: ["pastDays", "7"] })), ["dToday", "dYesterday"]);
    assert.deepEqual(await rows(where({ key: "due", cmp: "datePreset", values: ["nextDays", "7"] })), ["dToday", "dTomorrow"]);
    assert.deepEqual(await rows(where({ key: "due", cmp: "datePreset", values: ["nextDays", "8"] })), ["dPlus8", "dToday", "dTomorrow"], "both ends included");
    const [from, to] = F.presetRange("thisWeek", 0, F.dayIn());
    const expected = ["dToday", "dYesterday", "dTomorrow", "dPlus8", "dMinus8"].filter((s) => { const d = { dToday: 0, dYesterday: -1, dTomorrow: 1, dPlus8: 8, dMinus8: -8 }[s]; const day = F.addDays(F.dayIn(), d); return day >= from && day <= to; }).sort();
    assert.deepEqual(await rows(where({ key: "due", cmp: "datePreset", values: ["thisWeek"] })), expected);
    assert.deepEqual(await rows(where({ key: "done", cmp: "checked" })), ["dToday"]);
    const unchecked = await rows(where({ key: "done", cmp: "unchecked" }));
    assert.ok(unchecked.includes("dYesterday") && unchecked.includes("n05") && !unchecked.includes("dToday"), "unchecked includes cells never ticked");
  });

  test("group: by the record's group (is / is not / no group)", async () => {
    assert.deepEqual(await rows(where({ key: "grp", cmp: "in", values: ["Alpha"] })), ["n05", "n07"]);
    assert.deepEqual(await rows(where({ key: "grp", cmp: "in", values: ["Beta"] })), ["dToday", "n10"]);
    const notAlpha = await rows(where({ key: "grp", cmp: "notIn", values: ["Alpha"] }));
    assert.ok(!notAlpha.includes("n05") && notAlpha.includes("n10") && notAlpha.includes("nEmpty"));
    assert.equal(await count(where({ key: "grp", cmp: "in", values: [""] })), 300 - 4, "no group: every record but the four in Alpha or Beta");
  });

  test("\"me\" is the reader from the session; another person's ID in the request changes nothing; no reader matches nothing", async () => {
    assert.deepEqual(await rows(where({ key: "owner", cmp: "in", values: ["@me"] })), ["dToday", "dTomorrow"]);
    const notMe = await rows(where({ key: "owner", cmp: "notIn", values: ["@me"] }));
    assert.ok(notMe.includes("dYesterday") && !notMe.includes("dToday"));
    // Naming someone explicitly is an ordinary condition, not an identity.
    assert.deepEqual(await rows(where({ key: "owner", cmp: "in", values: [`user:${other.toHexString()}`] })), ["dTomorrow", "dYesterday"]);
    // The service without a reader (an internal caller): rules using "me" match nothing — never everyone.
    const svc = app.dataLayer.services.records;
    for (const cmp of ["in", "notIn", "anyToken", "noToken"]) {
      const page = await svc.list(new ObjectId(board.id), { limit: "200", filter: JSON.stringify(where({ key: "owner", cmp, values: ["@me"] })) }, {});
      assert.equal(page.items.length, 0, cmp);
      const forged = await svc.list(new ObjectId(board.id), { limit: "200", filter: JSON.stringify(where({ key: "owner", cmp, values: ["@me"] })) }, { me: "user:not-an-id" });
      assert.equal(forged.items.length, 0, `${cmp}: a malformed reader is no reader`);
    }
  });

  test("nested AND/OR", async () => {
    const filter = { op: "and", rules: [{ key: "serial", cmp: "startsWith", values: ["n"] }], groups: [{ op: "or", rules: [{ key: "qty", cmp: "eq", values: ["5"] }], groups: [{ op: "and", rules: [{ key: "qty", cmp: "gte", values: ["7"] }, { key: "grp", cmp: "in", values: ["Beta"] }] }] }] };
    assert.deepEqual(await rows(filter), ["n05", "n10"], "n… AND (qty = 5 OR (qty ≥ 7 AND group Beta))");
    const or = { op: "or", rules: [{ key: "serial", cmp: "in", values: ["n05"] }], groups: [{ op: "and", rules: [{ key: "due", cmp: "datePreset", values: ["today"] }, { key: "owner", cmp: "in", values: ["@me"] }] }] };
    assert.deepEqual(await rows(or), ["dToday", "n05"]);
  });

  test("the browser (fully loaded board) and the server give exactly the same answers", async () => {
    const { loadBrowser } = require("./support/browser-model");
    const model = loadBrowser().newResourceModel({ baseUrl: `${app.url}/api/v1` });
    await model.init();
    model.openBoard(board.id, ws);
    for (let i = 0; i < 300 && model.boardLoadState(board.id).state !== "full"; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(model.boardLoadState(board.id).state, "full");
    model.me = `user:${app.devActor._id.toHexString()}`;
    const filters = [
      where({ key: "qty", cmp: "eq", values: ["7"] }), where({ key: "qtyText", cmp: "eq", values: ["10"] }), where({ key: "qtyText", cmp: "ne", values: ["7"] }),
      where({ key: "qtyText", cmp: "lte", values: ["7"] }), where({ key: "qtyText", cmp: "lt", values: ["6"] }), where({ key: "qtyText", cmp: "gt", values: ["6"] }),
      where({ key: "qtyText", cmp: "between", values: ["5", "7"] }), where({ key: "qty", cmp: "gte", values: ["7"] }),
      where({ key: "serial", cmp: "startsWith", values: ["D"] }), where({ key: "serial", cmp: "endsWith", values: ["289"] }), where({ key: "serial", cmp: "equalsText", values: [" N05 "] }), where({ key: "serial", cmp: "notEqualsText", values: ["n05"] }), where({ key: "qtyText", cmp: "notEqualsText", values: [""] }),
      where({ key: "due", cmp: "datePreset", values: ["today"] }), where({ key: "due", cmp: "datePreset", values: ["pastDays", "7"] }), where({ key: "due", cmp: "datePreset", values: ["thisMonth"] }),
      where({ key: "due", cmp: "before", values: [F.dayIn()] }), where({ key: "due", cmp: "after", values: [F.dayIn()] }), where({ key: "due", cmp: "onOrAfter", values: [F.dayIn()] }),
      where({ key: "done", cmp: "checked" }), where({ key: "done", cmp: "unchecked" }),
      where({ key: "grp", cmp: "in", values: ["Alpha"] }), where({ key: "grp", cmp: "notIn", values: ["Alpha", ""] }), where({ key: "grp", cmp: "in", values: [""] }),
      where({ key: "owner", cmp: "in", values: ["@me"] }), where({ key: "owner", cmp: "notIn", values: ["@me"] }), where({ key: "owner", cmp: "anyToken", values: ["@me"] }),
      { op: "and", rules: [{ key: "serial", cmp: "startsWith", values: ["n"] }], groups: [{ op: "or", rules: [{ key: "qty", cmp: "eq", values: ["5"] }], groups: [{ op: "and", rules: [{ key: "qty", cmp: "gte", values: ["7"] }, { key: "grp", cmp: "in", values: ["Beta"] }] }] }] }
    ];
    for (const filter of filters) {
      const here = [...model.rows.filter((r) => model.matchesFilterNode(r, model.resolveFilter(filter))).map((r) => r.serial)].sort();
      assert.deepEqual(here, await rows(filter), JSON.stringify(filter).slice(0, 120));
    }
    // No reader known in the browser: "me" matches nothing there either.
    model.me = null;
    for (const cmp of ["in", "notIn"]) assert.equal(model.rows.filter((r) => model.matchesFilterNode(r, model.resolveFilter(where({ key: "owner", cmp, values: ["@me"] })))).length, 0, cmp);
  });

  test("invalid filters are refused with 400 before any query", async () => {
    for (const filter of [where({ key: "qty", cmp: "eq", values: ["x"] }), where({ key: "missing", cmp: "in", values: ["a"] }), where({ key: "serial", cmp: "datePreset", values: ["today"] }), { op: "xor", rules: [] }])
      assert.equal((await call("GET", `/api/v1/boards/${board.id}/records?filter=${encodeURIComponent(JSON.stringify(filter))}`)).status, 400, JSON.stringify(filter));
  });
});

describe("Browser: the view's conditions are worked out once, not per row, and never go stale", () => {
  const { loadBrowser } = require("./support/browser-model");
  let model, BoardModel;
  before(async () => {
    const b = loadBrowser(); BoardModel = b.window.BoardModel;
    model = new BoardModel(new b.window.StorageService(new b.window.LocalAsyncAdapter()));
    await model.init();
    model.board.columns.push({ key: "due", label: "Due", type: "date", options: [] }, { key: "qty", label: "Qty", type: "number", options: [] });
  });
  const nested = () => ({ op: "and", rules: [{ key: "qty", cmp: "gte", values: ["1"] }], groups: [{ op: "or", rules: [{ key: "gone", cmp: "empty" }], groups: [{ op: "and", rules: [{ key: "due", cmp: "datePreset", values: ["today"] }] }] }] });

  test("nested groups survive (a deleted column drops out); the same object while nothing changes", () => {
    model.setViewFilter(nested());
    const a = model.liveViewFilter;
    assert.deepEqual(JSON.parse(JSON.stringify(a)), { op: "and", rules: [{ key: "qty", cmp: "gte", values: ["1"] }], groups: [{ op: "or", rules: [], groups: [{ op: "and", rules: [{ key: "due", cmp: "datePreset", values: ["today"] }] }] }] });
    assert.equal(model.liveViewFilter, a, "cached");
    model.board.columns.push({ key: "gone", label: "Gone", type: "text", options: [] });
    assert.notEqual(model.liveViewFilter, a, "a column added: worked out again");
    assert.equal(model.liveViewFilter.groups[0].rules.length, 1);
    model.board.columns.pop();
    model.setViewFilter(nested());
    assert.notEqual(model.liveViewFilter, a, "a new filter (edited, or another view): never the old answer");
  });

  test("resolved once per redraw, again only for a new day or another reader", () => {
    model.setViewFilter(nested());
    const real = model.resolveFilter; let calls = 0;
    model.resolveFilter = function (...args) { calls += 1; return real.apply(this, args); };
    try {
      const saved = [BoardModel.todayValue, BoardModel.todayAt];
      BoardModel.todayValue = "2026-11-20"; BoardModel.todayAt = Date.now() + 3600000; // "today" fixed for the test
      const rows = Array.from({ length: 2000 }, (_, i) => ({ qty: String(i % 3), due: i % 2 ? "2026-11-20" : "2026-11-21" }));
      const match = model.viewFilterMatcher();
      assert.equal(rows.filter(match).length, rows.filter((r, i) => i % 3 && i % 2).length);
      for (const r of rows.slice(0, 500)) model.matchesViewFilter(r);
      assert.equal(calls, 1, "2,500 rows, one resolution");
      BoardModel.todayValue = "2026-11-21";
      assert.equal(rows.filter(model.viewFilterMatcher()).length, rows.filter((r, i) => i % 3 && !(i % 2)).length, "the next day: \"today\" moved");
      assert.equal(calls, 2);
      model.me = "user:0123456789abcdef01234567"; model.viewFilterMatcher();
      assert.equal(calls, 3, "another reader");
      [BoardModel.todayValue, BoardModel.todayAt] = saved;
    } finally { model.resolveFilter = real; }
  });
});
