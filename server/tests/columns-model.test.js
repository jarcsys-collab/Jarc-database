// Column rules in the browser model match the server's: type conversion (including lists and People), option edits
// with colours, value text for search/sort/export, "mine", and dates that never shift with the time zone.
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync } = require("child_process");
const schema = require("../src/domain/board-schema");
const { loadBrowser } = require("./support/browser-model");

const ME = "user:0123456789abcdef01234567", BEN = "user:89abcdef0123456789abcdef";

describe("Browser column rules", () => {
  let model;
  before(async () => {
    const b = loadBrowser();
    model = new b.window.BoardModel(new b.window.StorageService(new b.window.LocalAsyncAdapter()));
    await model.init();
    model.setPeople([{ id: ME, displayName: "Ana Reyes", isYou: true }, { id: BEN, displayName: "Ben Cruz" }]);
    model.me = ME;
  });
  const plain = (v) => JSON.parse(JSON.stringify(v));

  test("type conversion matches the server for single values, lists and People", () => {
    const names = new Map([[ME, "Ana Reyes"], [BEN, "Ben Cruz"]]);
    const values = ["", "North", "12.5", "2026-10-05", "yes", true, false, ["North", "East"], [ME, "Contractor"], ["2026-01-02"], [], null];
    const targets = [["text"], ["number"], ["date"], ["checkbox"], ["status"], ["priority"], ["dropdown"], ["dropdown", true], ["owner"], ["email"]];
    for (const value of values) for (const [type, multiple = false] of targets) {
      assert.deepEqual(plain(model.convertValue(value, type, { multiple })), schema.convertValue(value, type, { multiple, names }), `${JSON.stringify(value)} → ${type}${multiple ? " (several)" : ""}`);
      assert.equal(model.valueFits(value, type), schema.valueFits(value, type), `fits ${JSON.stringify(value)} → ${type}`);
    }
  });

  test("label edits match the server: order, colours, renames inside lists, removals", () => {
    const column = { key: "s", type: "status", options: ["To do", "Doing", "Done"], colors: ["#111111", "", "#222222"] };
    model.board.columns.push(column);
    const items = [{ from: "Done", to: "Done", color: "#8e4ec6" }, { from: "Doing", to: "In progress" }, { from: null, to: "Blocked", color: "#e5484d" }];
    const browser = model.optionsEditPlan("s", items), server = schema.optionsPlan(column, items);
    assert.deepEqual(plain(browser.options), server.options);
    assert.deepEqual(plain(browser.colors), server.colors);
    for (const v of ["To do", "Doing", "Done", ["Doing", "To do", "Done"], ""]) assert.deepEqual(plain(browser.mapValue(v)), server.mapValue(v), JSON.stringify(v));
    model.board.columns.pop();
  });

  test("text for search, sorting and export uses names; “mine” recognises my reference and older text", () => {
    const people = { key: "owner", type: "owner" };
    assert.equal(model.valueText(people, [ME, BEN, "Contractor"]), "Ana Reyes, Ben Cruz, Contractor");
    assert.equal(model.valueText({ type: "dropdown", multiple: true }, ["North", "East"]), "North, East");
    assert.equal(model.personLabel(ME), "Ana Reyes (you)");
    assert.equal(model.personLabel("user:ffffffffffffffffffffffff"), "Unknown user");
    assert.equal(model.isMine([BEN, ME]), true);
    assert.equal(model.isMine([BEN]), false);
    assert.equal(model.isMine(model.profile.initials), true, "older text values (initials) still count");
    assert.deepEqual(plain(model.valueList("Unassigned")), [], "the old “Unassigned” placeholder is empty");
  });

  test("CSV import: lists from text, names and emails matched to colleagues", () => {
    const board = model.board, columns = board.columns;
    board.columns = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "owner", label: "People", type: "owner" }, { key: "tags", label: "Tags", type: "dropdown", multiple: true, options: ["North", "East"] }];
    const result = model.validateImport([{ Item: "Imported", People: "ben cruz; Contractor", Tags: "North, East" }]);
    assert.deepEqual(plain(result.valid[0].owner), [BEN, "Contractor"]);
    assert.deepEqual(plain(result.valid[0].tags), ["North", "East"]);
    board.columns = columns;
  });

  test("a column settings save (details and default value together) is ONE Undo step that restores both; the same saves are sent", async () => {
    const column = { key: "remarks", label: "Notes", type: "text", defaultValue: "", required: false };
    model.board.columns.push(column);
    const sent = [], save = model.save;
    model.save = function (change) { sent.push(plain(change)); return save.call(this, change); };
    const settingsSave = () => { model.editColumn("remarks", { label: "Remarks", description: "Anything worth knowing" }); model.updateColumnConfig({ remarks: { defaultValue: "None yet", required: true } }); };
    try {
      const before = model.history.length;
      settingsSave();
      const ungrouped = sent.splice(0);
      assert.equal(model.history.length, before + 2, "without grouping: two Undo entries");
      model.undo(); model.undo();
      sent.splice(0);
      const start = model.history.length;
      model.groupHistory("Column settings undone", settingsSave);
      assert.deepEqual(sent.filter((c) => c.op === "updateColumns"), ungrouped, "the same requests, in the same order");
      assert.equal(model.history.length, start + 1, "one Undo entry");
      const now = () => plain(model.board.columns.find((c) => c.key === "remarks"));
      assert.deepEqual([now().label, now().description, now().defaultValue, now().required], ["Remarks", "Anything worth knowing", "None yet", true]);
      assert.equal(model.undo(), "Column settings undone");
      assert.deepEqual([now().label, now().description, now().defaultValue, now().required], ["Notes", undefined, "", false], "one Undo restores the name, description, default value and required together");
      assert.equal(model.history.length, start);
      model.redo();
      assert.deepEqual([now().label, now().defaultValue], ["Remarks", "None yet"], "and one Redo brings both back");
      model.undo();
      // Outside a group, snapshots are recorded as before; a nested group joins the outer one.
      model.groupHistory("Outer", () => model.groupHistory("Inner", settingsSave));
      assert.equal(model.history.length, start + 1); assert.equal(model.history.at(-1).label, "Outer");
      model.undo();
      model.renameColumn("remarks", "Again");
      assert.equal(model.history.at(-1).label, "Column rename undone");
      model.undo();
    } finally {
      model.save = save;
      model.board.columns = model.board.columns.filter((c) => c.key !== "remarks");
      await new Promise((r) => setTimeout(r, 20));
    }
  });
});

describe("Dates don't shift with the time zone", () => {
  for (const tz of ["America/Los_Angeles", "Pacific/Honolulu", "Asia/Manila", "Pacific/Kiritimati"]) {
    test(tz, () => {
      // TZ is set inside the child (the TZ environment variable isn't honoured at start-up on every platform).
      const script = `process.env.TZ=${JSON.stringify(tz)};const fs=require("fs"),vm=require("vm");const ctx=vm.createContext({window:{},document:{},console,Intl,Date,URL,encodeURIComponent});vm.runInContext(fs.readFileSync(${JSON.stringify(path.resolve(__dirname, "..", "..", "site", "assets", "AppView.js"))},"utf8"),ctx);const v=new ctx.window.AppView({});process.stdout.write(JSON.stringify({zone:Intl.DateTimeFormat().resolvedOptions().timeZone,utcDay:new Date("2026-10-05").getDate(),shown:["2026-10-05","2026-01-01","2026-12-31"].map(d=>v.date(d))}));`;
      const out = JSON.parse(execFileSync(process.execPath, ["-e", script]).toString());
      assert.equal(out.zone, tz, "the zone really changed");
      if (tz === "America/Los_Angeles") assert.equal(out.utcDay, 4, "sanity: a UTC-parsed date WOULD shift here");
      assert.deepEqual(out.shown, ["Oct 5, 2026", "Jan 1, 2026", "Dec 31, 2026"]);
    });
  }
});
