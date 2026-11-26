// Column System S0-A (D-S0-4): Link / Email / Phone value rules, unit level. Synthetic values only.
// Every scheme-bypass variant is refused; allowed links, schemeless text, email and phone forms pass; text columns are never
// checked; the 400 names the column and never echoes the value; the import paths (spreadsheet rows into an existing board and
// monday.com mapping / migration) use the same rules; serialisation flags stored unsafe values and hides restricted Connect cells.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { checkTyped, typedValue, isUnsafeValue, unsafeValueKeys, LINK_SCHEMES } = require("../src/validation/record-values");
const validate = require("../src/validation/resources");
const { mapValue } = require("../src/integrations/monday/mapping");
const { mapCell } = require("../src/migration/monday/columns");
const { recordToApi, connectRestrictions } = require("../src/api/serialize");

const BOARD = {
  _id: new ObjectId(), groups: [], columns: [
    { key: "serial", label: "Item", type: "text", required: true, options: [] },
    { key: "site", label: "Site", type: "link", options: [] },
    { key: "mail", label: "Mail", type: "email", options: [] },
    { key: "tel", label: "Phone", type: "phone", options: [] },
    { key: "notes", label: "Notes", type: "text", options: [] },
    { key: "must", label: "Must link", type: "link", required: true, options: [] }
  ]
};
const refused = (type, value) => checkTyped(type, value).reason;

const BYPASSES = [
  "javascript:alert(1)", "JaVaScRiPt:alert(1)", "JAVASCRIPT:alert(1)", " javascript:alert(1)", "   \tjavascript:alert(1)",
  "\u0000javascript:alert(1)", "\u0001javascript:alert(1)", "\u001fjavascript:alert(1)", "\u007fjavascript:alert(1)", "\u0085javascript:alert(1)",
  "java\tscript:alert(1)", "java\nscript:alert(1)", "java\rscript:alert(1)", "java\u0000script:alert(1)",
  "\u200bjavascript:alert(1)", "java\u200dscript:alert(1)", "\ufeffjavascript:alert(1)", "\u202ejavascript:alert(1)", "java\u00adscript:alert(1)",
  "&#106;avascript:alert(1)", "&#0000106;avascript:alert(1)", "&#x6A;avascript:alert(1)", "&#X6a;avascript:alert(1)", "&#106avascript:alert(1)",
  "javascript&colon;alert(1)", "javascript&#58;alert(1)", "javascript&#x3a;alert(1)", "java&Tab;script:alert(1)", "java&NewLine;script:alert(1)",
  "java&#9;script:alert(1)", "java&#10;script:alert(1)", "&amp;#106;avascript:alert(1)",
  "%6Aavascript:alert(1)", "javascript%3Aalert(1)", "java%09script:alert(1)", "java%0ascript:alert(1)", "%256Aavascript:alert(1)", "java%00script:alert(1)",
  "\uff4a\uff41\uff56\uff41\uff53\uff43\uff52\uff49\uff50\uff54:alert(1)", "javascript\uff1aalert(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", "DATA:text/html,x", " data:image/svg+xml,<svg onload=alert(1)>",
  "vbscript:msgbox(1)", "VBScript:msgbox(1)", "file:///etc/passwd", "file://server/share", "FILE:c:/x", "blob:https://example.com/0000",
  "about:blank", "ftp://example.com/x", "chrome://settings", "jar:file:x!/", "view-source:https://example.com", "intent://x#Intent;end",
  "ms-word:ofe|u|https://example.com/x.docx", "x-unknown:thing", "web+app:x", "foo://x", "javascript:8080", "javascript: alert(1)"
];
// host:port is text with no scheme (S0-A review fix 5; the browser's unsafeLink reads it the same way): "localhost:8080"
// moved from BYPASSES to the plain-text list below.

describe("Link rule", () => {
  test("every scheme bypass variant is refused", () => {
    for (const value of BYPASSES) assert.ok(refused("link", value), JSON.stringify(value));
  });
  test("http, https, mailto and tel links are allowed and stored as typed (trimmed)", () => {
    assert.deepEqual(LINK_SCHEMES, ["http", "https", "mailto", "tel"]);
    for (const value of ["https://example.com", "http://example.com/a?b=c#d", "HTTPS://EXAMPLE.COM/x", "https://example.com/?next=javascript:alert(1)", "mailto:someone@example.com", "tel:+15550100", "https://example.com/path%20with%20spaces"])
      assert.deepEqual(checkTyped("link", value), { value }, value);
    assert.deepEqual(checkTyped("link", "  https://example.com  "), { value: "https://example.com" });
    assert.deepEqual(checkTyped("link", "https://example.com\n"), { value: "https://example.com" }, "a trailing line break from a paste is trimmed");
  });
  test("text without a scheme is allowed, as typed (not clickable until it has https://)", () => {
    for (const value of ["www.example.com", "example.com/path", "//example.com/x", "Room 4: shared drive", "see the shared folder", "\\\\server\\share", "localhost:8080", "intranet:8080/x", "Note: see drive", "Ref:123"]) assert.deepEqual(checkTyped("link", value), { value }, value);
  });
  test("broken http(s) links, over-long links and non-text are refused", () => {
    assert.equal(refused("link", "https://"), "invalid-url");
    assert.equal(refused("link", "http://"), "invalid-url");
    assert.equal(refused("link", `https://example.com/${"a".repeat(2048)}`), "too-long");
    assert.equal(checkTyped("link", `https://example.com/${"a".repeat(2028)}`).value.length, 2048);
    assert.equal(refused("link", { url: "x" }), "type");
  });
  test("empty and null clear the cell", () => {
    for (const value of ["", null]) assert.deepEqual(checkTyped("link", value), { value });
    assert.deepEqual(checkTyped("link", "   "), { value: "" });
  });
});

describe("Email rule", () => {
  test("one address; a mailto: prefix is removed", () => {
    for (const value of ["a@example.com", "first.last+tag@mail.sub.example.com", "o'brien@example.com", "x_y-z@my-host.example.org", "jos\u00e9@ex\u00e4mple.test"]) assert.deepEqual(checkTyped("email", value), { value }, value);
    assert.deepEqual(checkTyped("email", "mailto:A@Example.com"), { value: "A@Example.com" });
    assert.deepEqual(checkTyped("email", " MAILTO: a@example.com "), { value: "a@example.com" });
  });
  test("anything else is refused, including URL schemes and mailto header tricks", () => {
    for (const value of ["a", "a@b", "@example.com", "a@", "a b@example.com", "a@exa mple.com", "a@@example.com", "a..b@example.com", ".a@example.com", "a.@example.com",
      "javascript:alert(1)", "javascript:alert(1)//@example.com", "https://example.com", "a@example.com?cc=b@example.com", "a@example.com#x", "a%40b@example.com",
      "\"a\"@example.com", "<a@example.com>", "a@example.com, b@example.com", "a@1.2.3.4", "a@[127.0.0.1]", "a@-example.com", "a@example-.com", "a@example.com\u0000", "a\u200b@example.com", `${"a".repeat(65)}@example.com`, `a@${"b".repeat(250)}.com`, 42])
      assert.ok(refused("email", value), JSON.stringify(value));
  });
});

describe("Phone rule", () => {
  test("digits, +, spaces, ( ) - . and an extension; a tel: prefix is removed; a number stays a number", () => {
    for (const value of ["+63 917 123 4567", "(02) 8123-4567", "555.0100", "5550100", "555 0100 x12", "555-0100 ext. 9", "555-0100 ext 9", "555-0100 #12", "+1 555 0100;ext=77"]) assert.deepEqual(checkTyped("phone", value), { value }, value);
    assert.deepEqual(checkTyped("phone", "tel:+15550100"), { value: "+15550100" });
    assert.deepEqual(checkTyped("phone", "TEL: 555 0100"), { value: "555 0100" });
    assert.deepEqual(checkTyped("phone", 5550100), { value: 5550100 });
  });
  test("anything else is refused", () => {
    for (const value of ["12", "N/A", "call reception", "javascript:alert(1)", "tel:javascript:alert(1)", "+1+2 555", "555 0100 / 555 0101", "555\u00000100", "1".repeat(21), `+${"1 ".repeat(30)}`, "555-0100 ext. 12345678901", "https://example.com"])
      assert.ok(refused("phone", value), JSON.stringify(value));
  });
});

describe("record writes (validation/resources.js recordValues: create, update, batches, forms, imports)", () => {
  test("a refused value is a 400 naming the column, with { field, reason }, never the value", () => {
    const secret = "javascript:alert('S0A-SECRET-PAYLOAD')";
    try { typedValue(BOARD.columns[1], secret); assert.fail("should refuse"); } catch (error) {
      assert.equal(error.status, 400); assert.equal(error.code, "VALIDATION_ERROR");
      assert.deepEqual(error.details, { field: "site", reason: "scheme" });
      assert.match(error.message, /"Site"/);
      assert.ok(!error.message.includes("S0A-SECRET") && !JSON.stringify(error.details).includes("S0A-SECRET"));
    }
  });
  test("create, patch and batches refuse unsafe values and store normalised safe ones", () => {
    assert.throws(() => validate.recordCreate({ values: { serial: "A", must: "https://x.example", site: "javascript:alert(1)" } }, BOARD), (e) => e.status === 400 && e.details?.field === "site");
    assert.throws(() => validate.recordPatch({ expectedVersion: 1, values: { mail: "javascript:alert(1)" } }, BOARD), (e) => e.details?.field === "mail");
    assert.throws(() => validate.recordBatchCreate({ records: [{ values: { serial: "A", must: "https://x.example" } }, { values: { serial: "B", must: "data:text/html,x" } }] }, BOARD), (e) => /^Record 2: /.test(e.message) && e.details?.field === "must");
    assert.throws(() => validate.recordBatchUpdate({ items: [{ id: "0".repeat(24), expectedVersion: 1, values: { tel: "javascript:alert(1)" } }] }, BOARD), (e) => /^Record 1: /.test(e.message) && e.details?.field === "tel");
    const ok = validate.recordCreate({ values: { serial: "A", must: " https://x.example ", mail: "mailto:a@example.com", tel: "tel:+15550100", site: "www.example.com" } }, BOARD);
    assert.deepEqual([ok.values.must, ok.values.mail, ok.values.tel, ok.values.site], ["https://x.example", "a@example.com", "+15550100", "www.example.com"]);
  });
  test("a required Link column is still required after trimming", () => {
    assert.throws(() => validate.recordCreate({ values: { serial: "A", must: "   " } }, BOARD), /Must link is required/);
  });
  test("text columns are never checked: any text is stored exactly as sent", () => {
    const values = { serial: "javascript:alert(1)", notes: " data:text/html,<script>x</script> \u0000 &#106;avascript:", must: "https://x.example" };
    const ok = validate.recordCreate({ values }, BOARD);
    assert.equal(ok.values.serial, values.serial); assert.equal(ok.values.notes, values.notes);
    assert.equal(validate.recordPatch({ expectedVersion: 1, values: { notes: "vbscript:x" } }, BOARD).change.values.notes, "vbscript:x");
    assert.equal(typedValue({ key: "n", type: "number" }, "12"), "12");
    assert.equal(typedValue({ key: "s", type: "status" }, "javascript:x"), "javascript:x");
  });
  test("spreadsheet rows into an existing board are refused per row (the import uses recordCreate), with the column and no value", () => {
    // services/import-job-service.js rowToInput: { error: message } for that row only; the rest of the file imports.
    const rows = [{ serial: "Row 1", must: "https://ok.example" }, { serial: "Row 2", must: "javascript:alert(1)" }, { serial: "Row 3", must: "https://ok.example", mail: "not an email" }];
    const results = rows.map((values) => { try { return { input: validate.recordCreate({ values }, BOARD) }; } catch (error) { return { error: error.message }; } });
    assert.ok(results[0].input);
    assert.match(results[1].error, /Must link/); assert.ok(!results[1].error.includes("javascript"));
    assert.match(results[2].error, /Mail/); assert.ok(!results[2].error.includes("not an email"));
  });
});

describe("monday.com imports (integrations/monday/mapping.js, migration/monday/columns.js)", () => {
  const cv = (text, value) => ({ text, value: value === undefined ? null : JSON.stringify(value) });
  test("links: http(s) only, as before, now with the same scheme and control-character rules", () => {
    assert.equal(mapValue("link", cv("Site", { url: "https://example.com/a", text: "Site" })), "https://example.com/a");
    for (const url of ["javascript:alert(1)", "data:text/html,x", "mailto:a@example.com", "https://exa\u0000mple.com", `https://example.com/${"a".repeat(2100)}`, "www.example.com"])
      assert.equal(mapValue("link", cv(url, { url, text: url })), "", JSON.stringify(url));
  });
  test("email and phone: invalid values are left empty, never stored", () => {
    assert.equal(mapValue("email", cv("a@example.com", { email: "a@example.com", text: "a@example.com" })), "a@example.com");
    assert.equal(mapValue("email", cv("javascript:alert(1)//@x.com", { email: "javascript:alert(1)//@x.com" })), "");
    assert.equal(mapValue("phone", cv("+63 917 123 4567", { phone: "+639171234567" })), "+639171234567");
    assert.equal(mapValue("phone", cv("javascript:alert(1)", { phone: "javascript:alert(1)" })), "");
  });
  test("the migration keeps a refused value in migration metadata only, flagged value-not-convertible", () => {
    const url = "javascript:alert(1)";
    const out = mapCell({ handling: "direct" }, { key: "m_link", type: "link", options: [] }, cv(url, { url, text: url }), {});
    assert.equal(out.value, "");
    assert.ok(out.issues.includes("value-not-convertible"));
    assert.equal(out.preserved.text, url, "the raw source value is preserved for audit, not in a cell");
  });
});

describe("reading stored values (api/serialize.js)", () => {
  const doc = (values) => ({ _id: new ObjectId(), workspaceId: new ObjectId(), boardId: BOARD._id, values, groupId: null, position: 1, archived: false, pinned: false, createdBy: null, updatedBy: null, createdAt: new Date(), updatedAt: new Date(), version: 1 });
  test("stored unsafe values are returned unchanged; with the board, their keys are listed in unsafeValues", () => {
    const values = { serial: "javascript:alert(1)", site: "javascript:alert(1)", mail: "a@example.com", tel: "N/A", notes: "data:x", must: "https://ok.example" };
    const plain = recordToApi(doc(values));
    assert.deepEqual(plain.values, values); assert.equal(plain.unsafeValues, undefined, "unchanged without options");
    const flagged = recordToApi(doc(values), { board: BOARD });
    assert.deepEqual(flagged.values, values, "never rewritten");
    assert.deepEqual(flagged.unsafeValues, ["site", "tel"], "text columns are never flagged");
    assert.equal(isUnsafeValue(BOARD.columns[1], "https://ok.example"), false);
    assert.deepEqual(unsafeValueKeys(BOARD, { site: "" }), []);
    assert.deepEqual([doc(values)].map(recordToApi)[0].values, values, ".map(recordToApi) passes an index: ignored");
  });
  test("restricted Connect cells are left out, with no IDs and no count; each linked board is asked once", async () => {
    const other = new ObjectId().toHexString(), mine = new ObjectId().toHexString();
    const board = { columns: [{ key: "serial", type: "text" }, { key: "a", type: "connect", link: { boardId: other } }, { key: "b", type: "connect", link: { boardId: other } }, { key: "c", type: "connect", link: { boardId: mine } }] };
    const asked = [];
    const restricted = await connectRestrictions(board, async (id) => { asked.push(id); return id === mine; });
    assert.deepEqual([...restricted], ["a", "b"]); assert.deepEqual(asked, [other, mine]);
    const ids = [new ObjectId().toHexString()];
    const out = recordToApi(doc({ serial: "P", a: ids, b: ids, c: ids }), { restricted });
    assert.deepEqual(out.values, { serial: "P", c: ids }); assert.deepEqual(out.restricted, ["a", "b"]);
    assert.ok(!JSON.stringify(out).includes(`"a":`) && JSON.stringify(out).split(ids[0]).length === 2, "the hidden IDs appear nowhere");
    assert.deepEqual([...await connectRestrictions(board, async () => { throw new Error("lookup failed"); })], ["a", "b", "c"], "a failed check hides (fails closed)");
  });
});
