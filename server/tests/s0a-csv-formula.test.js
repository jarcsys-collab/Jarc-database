// S0-A: the spreadsheet-import problems report (GET /imports/{id}/report) is a CSV a person opens in Excel. Column
// names and reasons come from the uploaded file, so text a spreadsheet would run as a formula gets a leading ' in the
// exported file (the same guard as the browser's CSV export). Nothing stored is changed. Synthetic data only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { ImportJobService, csvCell } = require("../src/services/import-job-service");

const report = (job) => ImportJobService.prototype.reportCsv.call(null, job);

describe("S0-A: CSV formula guard in the import problems report", () => {
  test("cells starting with = + - @, tab, CR, LF or the full-width forms get a leading '", () => {
    for (const start of ["=", "+", "-", "@", "\t", "\r", "\n", "＝", "＋", "－", "＠"]) {
      assert.equal(csvCell(`${start}1+1`), `"'${start}1+1"`, JSON.stringify(start));
    }
  });

  test("ordinary text and numbers are unchanged; quotes are doubled", () => {
    assert.equal(csvCell("Name"), '"Name"');
    assert.equal(csvCell(12), '"12"');
    assert.equal(csvCell(""), '""');
    assert.equal(csvCell(null), '""');
    assert.equal(csvCell("a=b"), '"a=b"', "only a leading character counts");
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('=HYPERLINK("https://example.invalid")'), '"\'=HYPERLINK(""https://example.invalid"")"');
  });

  test("the report guards column names and reasons from the file; the job itself is untouched", () => {
    const job = { status: "mapping", validation: { errorCount: 2, errors: [{ row: 3, column: "=cmd|' /C calc'!A0", reason: "has no name" }, { row: 4, column: "Code", reason: "@SUM(A1:A2)" }] } };
    const before = JSON.stringify(job);
    const csv = report(job);
    assert.match(csv, /^﻿?"Row","Column","Problem"\r\n/);
    assert.match(csv, /"3","'=cmd\|' \/C calc'!A0","has no name"/);
    assert.match(csv, /"4","Code","'@SUM\(A1:A2\)"/);
    assert.equal(JSON.stringify(job), before, "stored values unchanged");
  });
});
