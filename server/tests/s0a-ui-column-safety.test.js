// Column System S0-A, browser side, in Node (no server, no network): the unchanged browser files run in a vm context.
//   1. Change type uses the server's dry run (whole board), never the loaded-rows count; a refusal (or "board too large")
//      opens a dialog with the counts by reason and masked examples and no convert button; a lossless change keeps a
//      simple confirm; CONVERSION_REFUSED keeps its sanitised details through ApiAdapter → StorageService → the model.
//   2. Links: only safeHref builds an href from a cell value; an unsafe stored link is text plus a non-clickable flag;
//      a refused link / email / phone value gets a type-specific message.
//   3. CSV export: the formula-injection guard on every cell (= + - @, tab, CR, LF, full-width ＝ ＋ － ＠), apostrophe in
//      the exported text only; a valid plain number in a Number column (e.g. -5) stays a number.
// Synthetic values only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { memoryStorage } = require("./support/browser-model");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (file) => fs.readFileSync(path.join(ASSETS, file), "utf8");

// StorageService + ResourceApiAdapter + BoardModel + AppController's class (its bootstrap line is not run).
function loadCore() {
  const window = { location: { search: "", origin: "http://jarc.invalid" }, localStorage: memoryStorage(), sessionStorage: memoryStorage(), dispatchEvent() {}, addEventListener() {} };
  const context = vm.createContext({
    window, console, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, Intl,
    document: { querySelectorAll: () => [], querySelector: () => null, body: { classList: { toggle() {}, add() {}, remove() {} } } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  });
  for (const file of ["ResourceApiAdapter.js", "StorageService.js", "BoardModel.js"]) vm.runInContext(read(file), context, { filename: file });
  const source = read("AppController.js"), bootstrap = 'try { new AppController(document.querySelector("#app")); }';
  assert.ok(source.includes(bootstrap), "AppController.js still ends with its bootstrap line");
  vm.runInContext(`${source.slice(0, source.indexOf(bootstrap))}\nglobalThis.AppController = AppController; globalThis.StorageError = window.StorageError;`, context, { filename: "AppController.js" });
  return { window, AppController: context.AppController, StorageError: window.StorageError, ResourceApiAdapter: window.ResourceApiAdapter, ApiAdapter: window.ApiAdapter };
}
// AppView in its own context; overlays are written into `overlay.innerHTML`.
function loadView() {
  const overlay = { innerHTML: "", querySelector: () => null };
  const document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: (sel) => (sel === "#overlay-root" ? overlay : null), body: { classList: { add() {}, remove() {}, contains: () => false } } };
  const context = vm.createContext({ window: {}, document, console, Intl, Date, URL, encodeURIComponent });
  for (const file of ["AppView.js", "IconLibrary.js", "Appearance.js", "BoardGroups.js", "CommentsPanel.js"]) vm.runInContext(read(file), context, { filename: file });
  return { view: new context.window.AppView({ innerHTML: "" }), overlay };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });

const core = loadCore();
const { AppController, StorageError, ResourceApiAdapter, ApiAdapter } = core;

describe("CONVERSION_REFUSED details: kept, sanitised, never raw server text", () => {
  test("conversionDetails keeps numbers, known lossy keys, ≤3 short masked examples and only known reasons", () => {
    const d = StorageError.conversionDetails({
      from: "text", to: "number", total: 4812, populated: "4410", convertible: 4301, incompatible: 87,
      lossy: { leadingZero: 7, longNumber: 0, truncatedMulti: -3, invalidDate: "x", secret: 99 },
      examples: ["1•••.50", "0•••7", "\u202ePHONE\u0007", "fourth", 5], reason: "<b>server text</b>", message: "Internal stack at line 4", raw: ["x"]
    });
    assert.deepEqual({ ...d, lossy: { ...d.lossy }, examples: [...d.examples] }, { from: "text", to: "number", total: 4812, populated: 4410, convertible: 4301, incompatible: 87, lossy: { leadingZero: 7 }, examples: ["1•••.50", "0•••7", "PHONE"], reason: null, tooLarge: false, lossyTotal: 7 });
    assert.equal(StorageError.conversionDetails({ reason: "board_too_large", total: 250000 }).reason, "board_too_large");
    // The server's own spelling (upper case) and its tooLarge flag; previewToken and limits are not kept.
    const server = StorageError.conversionDetails({ reason: "BOARD_TOO_LARGE", tooLarge: true, allowed: false, previewToken: "ab".repeat(16), limits: { records: 2000 }, from: "dropdown_multiple", to: "dropdown" });
    assert.equal(server.reason, "board_too_large"); assert.equal(server.tooLarge, true); assert.equal(server.from, "dropdown_multiple");
    assert.ok(!("previewToken" in server) && !("limits" in server));
    assert.equal(StorageError.conversionDetails({ reason: "INCOMPATIBLE_VALUES" }).reason, "incompatible_values");
    assert.equal(StorageError.conversionDetails({ examples: ["x".repeat(500)] }).examples[0].length, 60, "long examples are cut");
    const empty = StorageError.conversionDetails(null);
    assert.equal(empty.incompatible, 0); assert.equal(empty.total, null); assert.equal(empty.examples.length, 0);
  });

  test("ApiAdapter.send: a 409 CONVERSION_REFUSED keeps its details; the message is JARC's own, not the server's", async () => {
    const http = new ApiAdapter({ baseUrl: "/api/v1", fetch: async () => json(409, { error: { code: "CONVERSION_REFUSED", message: "RAW SERVER TEXT", details: { from: "text", to: "number", total: 10, populated: 4, convertible: 2, incompatible: 2, examples: ["a•••"] } } }) });
    const error = await http.request("POST", "/boards/b/columns/k/type", "{}").then(() => null, (e) => e);
    assert.equal(error.code, "CONVERSION_REFUSED");
    assert.equal(error.details.incompatible, 2);
    assert.doesNotMatch(error.message, /RAW SERVER TEXT/);
    assert.equal(error.message, StorageError.describe("CONVERSION_REFUSED").message);
    assert.match(error.message, /Your data has not been changed/);
  });

  test("ApiAdapter.send: other codes are unchanged (409 CONFLICT, 400 VALIDATION_ERROR) and carry no details", async () => {
    for (const [status, code, expected] of [[409, "CONFLICT", "CONFLICT"], [400, "VALIDATION_ERROR", "VALIDATION_ERROR"]]) {
      const http = new ApiAdapter({ baseUrl: "/api/v1", fetch: async () => json(status, { error: { code, message: "x", details: { total: 1 } } }) });
      const error = await http.request("PATCH", "/records/r", "{}").then(() => null, (e) => e);
      assert.equal(error.code, expected); assert.equal(error.details, undefined);
    }
  });

  test("StorageService.commit passes the details to the model's applyAfterSave outcome", async () => {
    const adapter = { mode: "resource", commitState: async () => { const e = new StorageError("CONVERSION_REFUSED", "m"); e.details = StorageError.conversionDetails({ incompatible: 3, total: 9 }); throw e; }, setConnection() {} };
    const service = new core.window.StorageService(adapter);
    const outcome = await service.commit({ op: "updateColumns" }, { data: {}, user: {} });
    assert.equal(outcome.ok, false); assert.equal(outcome.code, "CONVERSION_REFUSED"); assert.equal(outcome.details.incompatible, 3);
  });
});

describe("ResourceApiAdapter.previewColumnType: the server's dry run, one shape", () => {
  const adapterWith = (respond) => {
    const calls = [];
    const adapter = new ResourceApiAdapter({ baseUrl: "/api/v1", fetch: async (url, init) => { calls.push({ url, init }); return respond(url, init); } });
    adapter.boards.set("b1", { id: "b1", version: 7, columns: [] });
    return { adapter, calls };
  };
  test("POST …/columns/:key/type?dryRun=true with the board version; full lossless counts → not refused", async () => {
    const { adapter, calls } = adapterWith(() => json(200, { dryRun: true, from: "text", to: "number", total: 4812, populated: 402, convertible: 402, incompatible: 0, lossy: {} }));
    const r = await adapter.previewColumnType("b1", "amount col", "number");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/v1/boards/b1/columns/amount%20col/type?dryRun=true");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].init.body), { expectedVersion: 7, type: "number", multiple: false });
    assert.equal(r.refused, false); assert.equal(r.legacy, false); assert.equal(r.total, 4812); assert.equal(r.populated, 402);
  });
  test("incompatible or lossy counts → refused; board_too_large → refused with the reason; nested `impact` accepted", async () => {
    for (const body of [{ total: 9, populated: 9, convertible: 5, incompatible: 4 }, { total: 9, populated: 9, convertible: 9, incompatible: 0, lossy: { leadingZero: 2 } }, { impact: { total: 3, populated: 3, convertible: 2, incompatible: 1 } }]) {
      const r = await adapterWith(() => json(200, body)).adapter.previewColumnType("b1", "k", "number");
      assert.equal(r.refused, true, JSON.stringify(body));
    }
    const big = await adapterWith(() => json(200, { refused: true, reason: "board_too_large", total: 300000 })).adapter.previewColumnType("b1", "k", "date");
    assert.equal(big.refused, true); assert.equal(big.reason, "board_too_large");
  });
  test("the dry run answered with CONVERSION_REFUSED (400) → refused, with its counts", async () => {
    const r = await adapterWith(() => json(400, { error: { code: "CONVERSION_REFUSED", details: { reason: "board_too_large", total: 120000 } } })).adapter.previewColumnType("b1", "k", "number");
    assert.equal(r.refused, true); assert.equal(r.reason, "board_too_large"); assert.equal(r.total, 120000);
  });
  test("an older server's { dryRun, affected } → legacy, with that whole-board count", async () => {
    const r = await adapterWith(() => json(200, { dryRun: true, affected: 12 })).adapter.previewColumnType("b1", "k", "number");
    assert.equal(r.legacy, true); assert.equal(r.refused, false); assert.equal(r.affected, 12);
  });
  test("the server's own dry-run answer (allowed / reason / previewToken): refused or not; the token goes with the real change once", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const ok = adapterWith(() => json(200, { dryRun: true, affected: 0, from: "text", to: "number", total: 3, populated: 2, convertible: 2, incompatible: 0, lossy: { leadingZero: 0 }, examples: [], reason: null, allowed: true, tooLarge: false, rewrites: 2, previewToken: token }));
    const r = await ok.adapter.previewColumnType("b1", "k", "number");
    assert.equal(r.refused, false); assert.equal(r.legacy, false);
    assert.equal(ok.adapter.takePreviewToken("b1", "k", "number", false), token);
    assert.equal(ok.adapter.takePreviewToken("b1", "k", "number", false), null, "used once");
    const big = await adapterWith(() => json(200, { dryRun: true, affected: 0, total: 2500, populated: 2500, convertible: 2500, incompatible: 0, lossy: {}, examples: [], reason: "BOARD_TOO_LARGE", allowed: false, tooLarge: true })).adapter.previewColumnType("b1", "k", "number");
    assert.equal(big.refused, true); assert.equal(big.reason, "board_too_large");
    const bad = await adapterWith(() => json(200, { dryRun: true, affected: 3, total: 9, populated: 5, convertible: 2, incompatible: 3, lossy: { leadingZero: 1 }, examples: ["9999"], reason: "INCOMPATIBLE_VALUES", allowed: false })).adapter.previewColumnType("b1", "k", "number");
    assert.equal(bad.refused, true); assert.equal(bad.legacy, false);
    const noToken = adapterWith(() => json(200, { dryRun: true, affected: 0 }));
    await noToken.adapter.previewColumnType("b1", "k", "number");
    assert.equal(noToken.adapter.takePreviewToken("b1", "k", "number", false), null, "an older server gives none, so none is sent");
  });
  test("a stale version (409 CONFLICT) rejects (the controller offers Try again)", async () => {
    const error = await adapterWith(() => json(409, { error: { code: "CONFLICT" } })).adapter.previewColumnType("b1", "k", "number").then(() => null, (e) => e);
    assert.equal(error.code, "CONFLICT");
  });
});

// A controller stand-in: the real prototype methods with a recording view and a model whose loaded rows must NOT be counted.
function controller({ preview, typeChangeImpact } = {}) {
  const calls = { view: [], convert: [], preview: [] };
  const column = { key: "amount", label: "Amount", type: "text" };
  const ctrl = Object.create(AppController.prototype);
  ctrl.model = {
    board: { id: "b1", columns: [{ key: "serial", label: "Item", type: "text" }, column] },
    columnType: (t) => ({ number: { label: "Numbers" }, date: { label: "Date" }, text: { label: "Text" } })[t],
    typeChangeImpact: typeChangeImpact || (() => { throw new Error("the loaded-rows count must not be used with the server"); }),
    whenSaved: async () => true,
    storage: { adapter: preview ? { previewColumnType: async (...args) => { calls.preview.push(args); return preview(...args); } } : { mode: "local" } }
  };
  const record = (name) => (...args) => { calls.view.push([name, ...args]); };
  ctrl.view = { setBusy: record("setBusy"), clearDialogError: record("clearDialogError"), showConfirm: record("showConfirm"), showMessage: record("showMessage"), showConversionRefused: record("showConversionRefused"), showConversionCheckFailed: record("showConversionCheckFailed"), showDialogError: record("showDialogError"), safeHref: () => "" };
  ctrl.convertColumnType = (col, type) => { calls.convert.push([col.key, type]); };
  const shown = (name) => calls.view.filter((c) => c[0] === name);
  return { ctrl, calls, shown, column };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Change type: the dry run decides, never the loaded rows", () => {
  test("a refusal → the refusal dialog with the server's counts; nothing converted", async () => {
    const { ctrl, calls, shown } = controller({ preview: async () => ({ refused: true, legacy: false, total: 4812, populated: 4410, convertible: 4301, incompatible: 87, lossy: { leadingZero: 7 }, lossyTotal: 7, examples: ["0•••7"], reason: null }) });
    ctrl.changeColumnType("amount", "number", false, { id: "button" });
    await settle(); await settle();
    assert.equal(JSON.stringify(calls.preview[0]), JSON.stringify(["b1", "amount", "number", { multiple: false }]));
    const [, arg] = shown("showConversionRefused")[0];
    assert.equal(arg.column, "Amount"); assert.equal(arg.target, "Numbers"); assert.equal(arg.details.incompatible, 87);
    assert.equal(calls.convert.length, 0); assert.equal(shown("showConfirm").length, 0);
  });
  test("board too large → the refusal dialog with that reason", async () => {
    const { ctrl, shown, calls } = controller({ preview: async () => ({ refused: true, reason: "board_too_large", total: 250000, lossy: {}, examples: [] }) });
    ctrl.changeColumnType("amount", "date");
    await settle(); await settle();
    assert.equal(shown("showConversionRefused")[0][1].details.reason, "board_too_large"); assert.equal(calls.convert.length, 0);
  });
  test("lossless with values → a simple confirm with the whole-board count; confirming converts without a second check", async () => {
    const { ctrl, shown, calls } = controller({ preview: async () => ({ refused: false, legacy: false, total: 4812, populated: 402, convertible: 402, incompatible: 0, lossy: {}, lossyTotal: 0, examples: [] }) });
    ctrl.changeColumnType("amount", "number");
    await settle(); await settle();
    const [, title, text, action, payload] = shown("showConfirm")[0];
    assert.equal(title, 'Change "Amount" to Numbers?');
    assert.match(text, /Checked all 4,812 records on this board\. All 402 values can be stored as Numbers, so nothing will be lost\. You can undo this right afterwards\./);
    assert.equal(action, "confirm-change-type"); assert.equal(payload, "amount|number");
    assert.equal(calls.convert.length, 0);
    ctrl.changeColumnType("amount", "number", true);
    assert.equal(calls.preview.length, 1, "no second dry run"); assert.deepEqual(calls.convert, [["amount", "number"]]);
  });
  test("lossless with no values → converted straight away (as today)", async () => {
    const { ctrl, shown, calls } = controller({ preview: async () => ({ refused: false, legacy: false, total: 30, populated: 0, convertible: 0, incompatible: 0, lossy: {}, lossyTotal: 0, examples: [] }) });
    ctrl.changeColumnType("amount", "number"); await settle(); await settle();
    assert.equal(shown("showConfirm").length, 0); assert.deepEqual(calls.convert, [["amount", "number"]]);
  });
  test("an older server's whole-board `affected` keeps today's clear-values confirm, with that count", async () => {
    const { ctrl, shown } = controller({ preview: async () => ({ refused: false, legacy: true, affected: 1234, lossy: {}, examples: [] }) });
    ctrl.changeColumnType("amount", "number"); await settle(); await settle();
    assert.match(shown("showConfirm")[0][2], /^1,234 records on this board have values that can't be stored as Numbers\. They will be cleared\./);
  });
  test("the check failed (stale board, offline) → nothing changed, Try again offered", async () => {
    const { ctrl, shown, calls } = controller({ preview: async () => { throw new StorageError("CONFLICT", "x"); } });
    const events = []; core.window.dispatchEvent = (e) => events.push(e);
    ctrl.changeColumnType("amount", "number"); await settle(); await settle();
    const [, arg] = shown("showConversionCheckFailed")[0];
    assert.equal(arg.retry, true); assert.match(arg.text, /just changed by someone else/); assert.equal(calls.convert.length, 0);
  });
  test("browser storage (no server dry run): today's local count and confirm are unchanged", () => {
    const { ctrl, shown } = controller({ typeChangeImpact: () => 3 });
    ctrl.changeColumnType("amount", "number");
    assert.match(shown("showConfirm")[0][2], /^3 records have values that can't be stored as Numbers\. They will be cleared\./);
  });
});

describe("A refusal from the conversion itself, the PATCH path and Undo", () => {
  const busyController = (outcome) => {
    const { ctrl, shown } = controller();
    ctrl.model.applyAfterSave = async () => outcome; ctrl.saveFeedback = () => {};
    return { ctrl, shown };
  };
  test("runBusy: CONVERSION_REFUSED → the refusal dialog with the labels given by the caller, not a dialog error", async () => {
    const { ctrl, shown } = busyController({ ok: false, code: "CONVERSION_REFUSED", details: StorageError.conversionDetails({ incompatible: 5, total: 20 }) });
    ctrl.conversionContext = { column: "Amount", target: "Numbers" };
    assert.equal(await ctrl.runBusy(null, () => {}, () => { throw new Error("not a success"); }), false);
    const [, arg] = shown("showConversionRefused")[0];
    assert.equal(arg.column, "Amount"); assert.equal(arg.details.incompatible, 5);
    assert.equal(shown("showDialogError").length, 0); assert.equal(ctrl.conversionContext, null);
  });
  test("runBusy: PREVIEW_STALE (values changed after the check) → nothing changed, Try again runs a fresh check", async () => {
    const { ctrl, shown } = busyController({ ok: false, code: "CONVERSION_REFUSED", details: StorageError.conversionDetails({ reason: "PREVIEW_STALE" }) });
    ctrl.conversionContext = { column: "Amount", target: "Numbers", key: "amount", type: "number" };
    await ctrl.runBusy(null, () => {}, () => {});
    const [, arg] = shown("showConversionCheckFailed")[0];
    assert.equal(arg.key, "amount"); assert.equal(arg.type, "number"); assert.match(arg.text, /^The column changed since you checked\. Review again\.$/);
    assert.equal(shown("showConversionRefused").length, 0);
  });
  test("runBusy: VALIDATION_ERROR with a record-form hint → the type-specific message", async () => {
    const { ctrl, shown } = busyController({ ok: false, code: "VALIDATION_ERROR" });
    ctrl.validationHint = "Website not saved: Links must start with http://, https://, mailto: or tel: (for example https://example.com).";
    await ctrl.runBusy(null, () => {}, () => {});
    assert.equal(shown("showDialogError")[0][1], "Website not saved: Links must start with http://, https://, mailto: or tel: (for example https://example.com). Nothing was changed.");
  });
  test("onRollback (PATCH columns / Undo): CONVERSION_REFUSED → the failed save is dropped and the refusal dialog shown", () => {
    const { ctrl, shown } = controller(); let discarded = 0;
    ctrl.ready = true; ctrl.update = () => {}; ctrl.saveFeedback = () => {}; ctrl.model.discardFailedSave = () => { discarded += 1; };
    ctrl.onRollback({ code: "CONVERSION_REFUSED", op: "updateColumns", columnKey: "amount", details: StorageError.conversionDetails({ to: "number", incompatible: 2 }) });
    assert.equal(discarded, 1);
    const [, arg] = shown("showConversionRefused")[0];
    assert.equal(arg.column, "Amount"); assert.equal(arg.target, "Numbers");
  });
  test("onRollback: a refused value from a link cell just edited → a link-specific toast", () => {
    const { ctrl } = controller(); const toasts = [];
    ctrl.ready = true; ctrl.update = () => {}; ctrl.root = { querySelectorAll: () => [] }; ctrl.view.toast = (m) => { toasts.push(m); return null; };
    ctrl.lastTypedEdit = { type: "link", label: "Website", at: Date.now() };
    ctrl.onRollback({ code: "VALIDATION_ERROR", op: "updateRecord" });
    assert.deepEqual(toasts, ["Website not saved: Links must start with http://, https://, mailto: or tel: (for example https://example.com)."]);
  });
  test("typed messages for link, email and phone; the record-form hint names the field", () => {
    const { ctrl } = controller();
    assert.equal(ctrl.typedValidationMessage("link"), "Links must start with http://, https://, mailto: or tel: (for example https://example.com).");
    assert.match(ctrl.typedValidationMessage("email"), /valid email address/);
    assert.match(ctrl.typedValidationMessage("phone"), /valid phone number/);
    ctrl.model.board.columns.push({ key: "site", label: "Website", type: "link" });
    ctrl.view.safeHref = (v) => (/^https?:/.test(v) ? v : "");
    assert.equal(ctrl.typedValidationHint({ site: "javascript:alert(1)" }), "Website not saved: Links must start with http://, https://, mailto: or tel: (for example https://example.com).");
    assert.equal(ctrl.typedValidationHint({ serial: "x" }), "");
  });
});

describe("Refusal dialog (AppView): wording, counts, masked examples, no convert button, everything escaped", () => {
  test("incompatible and lossy values: the lead sentence, the scope, reasons, ≤3 examples, Close and Learn more only", () => {
    const { view, overlay } = loadView();
    view.showConversionRefused({ column: "Amount <b>", target: "Numbers", details: { total: 4812, populated: 4410, convertible: 4301, incompatible: 87, lossy: { leadingZero: 7, longNumber: 1 }, examples: ["<img src=x onerror=alert(1)>", "0•••7", "1•••5", "extra"], reason: null } });
    const html = overlay.innerHTML;
    assert.match(html, /This column can&#39;t be converted to Numbers because some existing values are incompatible or could lose information\. Your data has not been changed\./);
    assert.match(html, /Checked all 4,812 records on this board · 4,410 have a value · 4,301 would convert/);
    assert.match(html, /79 other values can&#39;t be stored as Numbers/, "87 refused, 8 of them with a listed cause");
    assert.match(html, /7 values start with 0 and would lose their leading zero/);
    assert.match(html, /1 value has more than 15 digits and would lose precision/);
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;") && !html.includes("<img"), "examples are escaped");
    assert.ok(!html.includes("extra"), "at most three examples");
    assert.ok(html.includes("Amount &lt;b&gt;"), "the column name is escaped");
    assert.match(html, /<summary>Learn more<\/summary>/);
    const actions = [...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(actions)], ["close-overlay"], "no convert (or any other) action");
    assert.match(html, /role="alertdialog"/);
  });
  test("board too large: its own sentence, no reasons or examples", () => {
    const { view, overlay } = loadView();
    view.showConversionRefused({ column: "Amount", target: "Date", details: { reason: "board_too_large", total: 250000, lossy: {}, examples: ["x•••"] } });
    assert.match(overlay.innerHTML, /This board is too large to convert safely with the current converter\. Your data has not been changed\./);
    assert.ok(!overlay.innerHTML.includes("conversion-reasons") && !overlay.innerHTML.includes("x•••"));
  });
  test("the check failed: Close and Try again (the same choose-new-type action)", () => {
    const { view, overlay } = loadView();
    view.showConversionCheckFailed({ column: "Amount", target: "Numbers", text: "JARC couldn't check this column's values just now.", key: "amount", type: "number" });
    assert.match(overlay.innerHTML, /data-action="choose-new-type" data-key="amount" data-type="number">Try again/);
    assert.match(overlay.innerHTML, /Your data has not been changed\./);
  });
});

describe("Links: safeHref is the only href builder for cell values", () => {
  const model = { hasValue: (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length), isMultiColumn: () => false, valueList: (v) => (Array.isArray(v) ? v : v ? [v] : []) };
  const cellHtml = (type, value) => { const { view } = loadView(); return view.cell({ id: "r1", f: value }, { key: "f", label: "Field", type }, model); };
  test("safe links, emails and phones: a link icon with the safe href (external links open with noopener noreferrer)", () => {
    assert.match(cellHtml("link", "https://example.com/a?b=1"), /<a class="cell-link" href="https:\/\/example\.com\/a\?b=1" target="_blank" rel="noopener noreferrer"/);
    assert.match(cellHtml("email", "ana@example.com"), /href="mailto:ana@example\.com"/);
    assert.match(cellHtml("phone", "+63 (2) 555-0100"), /href="tel:\+6325550100"/);
  });
  test("unsafe stored links: plain escaped text, no <a>, and the non-clickable 'Unsafe link' flag", () => {
    for (const value of ["javascript:alert(1)", "JavaScript:alert(1)", " data:text/html,<script>x</script>", "vbscript:msgbox", "file:///C:/x", "java\tscript:alert(1)"]) {
      const html = cellHtml("link", value);
      assert.ok(!html.includes("<a "), `no link for ${JSON.stringify(value)}`);
      assert.match(html, /<span class="cell-link-unsafe" title="Not opened: only http, https, mailto and tel links can be opened">Unsafe link<\/span>/, value);
      assert.ok(!html.includes("<script>"), "escaped");
    }
  });
  test("text that is not a URL (no scheme, host:port) is just text: no link and no flag; email/phone never flagged", () => {
    for (const value of ["www.example.com", "intranet:8080/page", "see notes"]) { const html = cellHtml("link", value); assert.ok(!html.includes("<a ") && !html.includes("cell-link-unsafe"), value); }
    assert.ok(!cellHtml("email", "javascript:alert(1)").includes("<a "));
    assert.ok(!cellHtml("phone", "javascript:alert(1)").includes("<a "));
    assert.ok(!cellHtml("text", "javascript:alert(1)").includes("<a "), "a text column never links");
  });
  test("source check: in the board UI files the only interpolated hrefs are safeHref's, attachment URLs and the file preview", () => {
    const allowed = { "AppView.js": ["this.attr(href)", "this.attr(model.attachmentUrl(a.id,{download:true}))", "this.attr(url)"] };
    for (const file of ["AppView.js", "AppController.js", "BoardGroups.js", "CommentsPanel.js", "CommandCenter.js", "FormsPanel.js", "FormWizard.js", "LiveUpdates.js", "KeyboardShortcuts.js", "ApiTokenDocs.js"]) {
      const found = [...read(file).matchAll(/href="\$\{([^"]*)\}"/g)].map((m) => m[1]);
      for (const expr of found) assert.ok((allowed[file] || []).includes(expr), `${file}: unexpected href expression ${expr}`);
      assert.ok(!/\.href\s*=\s*(?!url\b)/.test(read(file).replace(/link\.href=url/g, "")), `${file}: no element .href assignment from data`);
    }
    const view = read("AppView.js");
    assert.match(view, /href=\["link","email","phone"\]\.includes\(column\.type\)\?this\.safeHref\(value,column\.type\):""/, "the cell's href comes from safeHref");
    assert.equal((view.match(/href="\$\{this\.attr\(href\)\}"/g) || []).length, 1, "one cell href");
  });
});

describe("CSV export: formula-injection guard on every exported cell", () => {
  const ctrl = Object.create(AppController.prototype);
  const cell = (value, column = null) => ctrl.csvCell(value, column);
  const number = { key: "qty", type: "number" }, text = { key: "notes", type: "text" };
  test("= + - @, tab, CR, LF and full-width ＝ ＋ － ＠ get a leading apostrophe; quotes are doubled", () => {
    for (const v of ["=HYPERLINK(\"http://x\",\"y\")", "+1+2", "-1+2", "@SUM(A1)", "\t=1", "\r=1", "\n=1+1", "＝1+1", "＋1", "－1", "＠A1"]) assert.equal(cell(v, text), `"'${v.replaceAll('"', '""')}"`, JSON.stringify(v));
    assert.equal(cell('say "hi"', text), '"say ""hi"""');
    assert.equal(cell("plain text", text), '"plain text"');
    assert.equal(cell(" =1", text), '" =1"', "a leading space is not a formula");
    assert.equal(cell(null), '""'); assert.equal(cell(true), '"true"');
  });
  test("Number columns: a valid plain number (-5, -0.25, 12) stays a number; anything else there is guarded", () => {
    assert.equal(cell("-5", number), '"-5"'); assert.equal(cell(-5, number), '"-5"'); assert.equal(cell("-0.25", number), '"-0.25"'); assert.equal(cell(12, number), '"12"');
    assert.equal(cell("-5 kg", number), `"'-5 kg"`); assert.equal(cell("-1+2", number), `"'-1+2"`); assert.equal(cell("=1", number), `"'=1"`); assert.equal(cell("+5", number), `"'+5"`);
    assert.equal(cell("-5", text), `"'-5"`, "the exemption is for Number columns only");
  });
  test("headers, People names and Connect names are guarded too; stored values are untouched", () => {
    const row = { id: "r", serial: "=cmd", qty: -3, owner: ["u1"], link: ["x1"] };
    const columns = [{ key: "serial", label: "@Name", type: "text" }, { key: "qty", label: "Qty", type: "number" }, { key: "owner", label: "People", type: "owner" }, { key: "link", label: "Linked", type: "connect" }];
    const c = Object.create(AppController.prototype);
    c.model = { board: { columns }, isMultiColumn: (col) => ["owner", "connect"].includes(col.type), valueText: (col, v) => (col.type === "owner" ? "+Ana" : "＝Linked") };
    assert.equal(c.csvHeader(), `"'@Name","Qty","People","Linked"`);
    assert.equal(c.csvLine(row), `"'=cmd","-3","'+Ana","'＝Linked"`);
    assert.equal(row.serial, "=cmd", "the stored value is unchanged");
  });
});

describe("Refused link / email / phone values: the server's reason decides the message (never its text or the value)", () => {
  test("ApiAdapter.send keeps { field, reason } for a 400 VALIDATION_ERROR with a known reason; unknown reasons are dropped", async () => {
    const send = (details) => new ApiAdapter({ baseUrl: "/api/v1", fetch: async () => json(400, { error: { code: "VALIDATION_ERROR", message: "RAW javascript:alert(1)", details } }) }).request("PATCH", "/records/r", "{}").then(() => null, (e) => e);
    const known = await send({ field: "site", reason: "scheme", value: "javascript:alert(1)" });
    assert.equal(known.code, "VALIDATION_ERROR"); assert.equal(JSON.stringify(known.details), JSON.stringify({ field: "site", reason: "scheme" }));
    assert.doesNotMatch(known.message, /RAW|javascript/);
    assert.equal((await send({ field: "site", reason: "<b>other</b>" })).details, undefined);
    assert.equal(StorageError.valueDetails({ field: "bad field<", reason: "too-long" }).field, null);
  });
  test("each reason → its message, named after the column (or the cell just edited)", () => {
    const { ctrl } = controller();
    ctrl.model.board.columns.push({ key: "site", label: "Website", type: "link" }, { key: "mail", label: "Email", type: "email" }, { key: "tel", label: "Phone", type: "phone" });
    const m = (field, reason, fallback) => ctrl.valueRefusalMessage({ field, reason }, fallback);
    assert.equal(m("site", "scheme"), "Website not saved: Links must start with http://, https://, mailto: or tel: (for example https://example.com).");
    assert.equal(m("site", "invalid-url"), m("site", "scheme"));
    assert.equal(m("mail", "invalid-email"), "Email not saved: Enter a valid email address.");
    assert.equal(m("tel", "invalid-phone"), "Phone not saved: Enter a valid phone number.");
    assert.equal(m("tel", "type"), "Phone not saved: Enter a valid phone number.");
    assert.equal(m("site", "control-characters"), "Website not saved: Remove tabs, line breaks and other control characters.");
    assert.equal(m("site", "too-long"), "Website not saved: This value is too long.");
    assert.equal(m(null, "invalid-email", { type: "email", label: "Work email" }), "Work email not saved: Enter a valid email address.");
    assert.equal(ctrl.valueRefusalMessage(null), "");
  });
  test("onRollback uses the server's reason for the toast", () => {
    const { ctrl } = controller(); const toasts = [];
    ctrl.model.board.columns.push({ key: "mail", label: "Email", type: "email" });
    ctrl.ready = true; ctrl.update = () => {}; ctrl.view.toast = (msg) => { toasts.push(msg); return null; };
    ctrl.onRollback({ code: "VALIDATION_ERROR", op: "updateRecord", details: { field: "mail", reason: "invalid-email" } });
    assert.deepEqual(toasts, ["Email not saved: Enter a valid email address."]);
  });
});

describe("Dropdown several values → one: the server's dry run, not the loaded rows", () => {
  test("refused (truncatedMulti) → the refusal dialog; lossless → changed at once; the dry run asks for dropdown / one value", async () => {
    const run = async (impact) => {
      const { ctrl, calls, shown } = controller({ preview: async () => impact });
      const column = { key: "tags", label: "Tags", type: "dropdown", multiple: true };
      ctrl.model.board.columns.push(column); ctrl.model.rows = [{ tags: ["a", "b"] }];
      let busy = 0; ctrl.runBusy = async () => { busy += 1; };
      await ctrl.checkSingleValue(column, null);
      return { calls, shown, busy };
    };
    const refused = await run({ refused: true, legacy: false, total: 5000, populated: 40, convertible: 28, incompatible: 12, lossy: { truncatedMulti: 12 }, examples: [] });
    assert.equal(JSON.stringify(refused.calls.preview[0].slice(1)), JSON.stringify(["tags", "dropdown", { multiple: false }]));
    assert.equal(refused.shown("showConversionRefused")[0][1].details.lossy.truncatedMulti, 12); assert.equal(refused.busy, 0);
    const fine = await run({ refused: false, legacy: false, total: 5000, populated: 40, convertible: 40, incompatible: 0, lossy: {}, examples: [] });
    assert.equal(fine.busy, 1); assert.equal(fine.shown("showConfirm").length, 0);
  });
});
