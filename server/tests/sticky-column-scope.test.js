// Column System R0 (02a §1): the sticky first column is scoped to the board table. styles.css pins th:nth-child(2) /
// td:nth-child(2) of every table while the setting is on; ui-foundation.css now keys the board's pinned column on the Item
// column (th.is-primary, td[data-column-key=serial]) and takes the left pin off every other table (its header row stays
// sticky at the top). .fabric-invoices keeps its own pinned second column. The real stylesheets on a synthetic page, in a
// headless browser, scrolled sideways; the full board behaviour (opaque hover, selection, themes) is tests/sticky-column.test.js.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { findBrowser, launch, sleep } = require("./support/headless-browser");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const url = (f) => "file:///" + path.join(ASSETS, f).split(path.sep).join("/");

test("ui-foundation.css: the scoped rules are present", () => {
  const css = fs.readFileSync(path.join(ASSETS, "ui-foundation.css"), "utf8");
  assert.match(css, /html\[data-sticky-column=on\] \.editable-table > :is\(thead, tbody\) > tr > :is\(th\.is-primary, td\[data-column-key="serial"\]\) \{ position: sticky; left: 0; \}/);
  assert.match(css, /table:not\(\.editable-table, \.fabric-invoices\) > :is\(thead, tbody, tfoot\) > tr > th:nth-child\(2\) \{ left: auto; \}/);
  assert.match(css, /table:not\(\.editable-table, \.fabric-invoices\) > :is\(thead, tbody, tfoot\) > tr > td:nth-child\(2\) \{ left: auto; z-index: auto; \}/);
});

const BROWSER = findBrowser();
describe("sticky first column, scoped (headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed", concurrency: false }, () => {
  let b, dir, page;
  const table = (cls, withPrimary) => {
    const cols = Array.from({ length: 14 }, (_, i) => i);
    const th = cols.map((i) => i === 1 && withPrimary ? `<th class="is-primary" data-column-key="serial">Item</th>` : i === 0 ? `<th class="check-col"></th>` : `<th data-column-key="c${i}">Column ${i}</th>`).join("");
    const row = (r) => `<tr data-record-context="${r}">${cols.map((i) => i === 1 && withPrimary ? `<td class="cell" data-column-key="serial">Name ${r}</td>` : `<td class="cell" data-column-key="c${i}">Value ${r}.${i}</td>`).join("")}</tr>`;
    return `<div class="table-wrap" style="overflow:auto;max-width:600px;max-height:300px"><table class="${cls}" style="width:2400px;min-width:2400px;max-width:none"><thead><tr>${th}</tr></thead><tbody class="board-group">${[1, 2, 3].map(row).join("")}</tbody></table></div>`;
  };
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarc-sticky-scope-"));
    page = path.join(dir, "sticky.html");
    fs.writeFileSync(page, `<!doctype html><html data-sticky-column="on" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      ${["styles.css", "table-clarity.css", "ui-foundation.css", "design-system.css", "jarc-theme.css", "fabric-data.css"].map((f) => `<link rel="stylesheet" href="${url(f)}">`).join("")}
      <style>td,th{min-width:120px;white-space:nowrap}</style></head><body>
      <section id="board">${table("editable-table", true)}</section><section id="accounts">${table("account-table", false)}</section><section id="invoices">${table("fabric-table fabric-invoices", false)}</section>
      </body></html>`);
    b = await launch(BROWSER);
  });
  after(async () => { await b?.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } });

  // Each table scrolled 300 px sideways: where its second column's cells are, relative to the scroll box.
  const measure = () => b.evaluate(`(() => {
    const out = {};
    for (const id of ['board', 'accounts', 'invoices']) {
      const wrap = document.querySelector('#' + id + ' .table-wrap'); wrap.scrollLeft = 300;
      const box = { left: wrap.getBoundingClientRect().left + wrap.clientLeft }, th = wrap.querySelector('thead th:nth-child(2)'), td = wrap.querySelector('tbody td:nth-child(2)');
      out[id] = { scrolled: wrap.scrollLeft, th: Math.round(th.getBoundingClientRect().left - box.left), td: Math.round(td.getBoundingClientRect().left - box.left), thLeft: getComputedStyle(th).left, tdLeft: getComputedStyle(td).left, thPos: getComputedStyle(th).position, tdPos: getComputedStyle(td).position, thTop: getComputedStyle(th).top, tdBg: getComputedStyle(td).backgroundColor };
    }
    return out;
  })()`);

  for (const width of [1280, 390]) test(`${width} px: the board's Item column stays pinned; other tables scroll their second column away; invoices keep theirs`, async () => {
    await b.open(page, { width });
    await sleep(100);
    const m = await measure();
    for (const id of ["board", "accounts", "invoices"]) assert.ok(m[id].scrolled >= 290, `${id} scrolls sideways`);
    assert.deepEqual([m.board.th, m.board.td, m.board.thPos, m.board.tdPos], [0, 0, "sticky", "sticky"], `board: ${JSON.stringify(m.board)}`);
    assert.notEqual(m.board.tdBg, "rgba(0, 0, 0, 0)", "board Item cells stay opaque");
    assert.deepEqual([m.accounts.thLeft, m.accounts.tdLeft], ["auto", "auto"], `accounts: no left pin (${JSON.stringify(m.accounts)})`);
    // (on a phone the account table's header is laid out by its own mobile rules, so only the body cell's place is compared)
    assert.ok(m.accounts.td < -100 && (width < 640 || m.accounts.th < -100), `accounts: second column scrolled away (${JSON.stringify(m.accounts)})`);
    assert.equal(m.accounts.thPos, "sticky", "accounts header row still sticky at the top");
    assert.equal(m.accounts.thTop, "0px");
    // Invoices: their own rule (fabric-data.css; on a phone its own mobile layout decides), untouched by the scoping.
    assert.equal(m.invoices.tdLeft, "0px");
    if (width >= 640) assert.equal(m.invoices.td, 0, `invoices keep their pinned second column (${JSON.stringify(m.invoices)})`);
  });

  test("setting off: nothing is pinned, in any table", async () => {
    await b.open(page, { width: 1280 });
    await b.evaluate("document.documentElement.dataset.stickyColumn = 'off'");
    await sleep(50);
    const m = await measure();
    assert.ok(m.board.td < -100, `board: ${JSON.stringify(m.board)}`);
    assert.ok(m.accounts.td < -100);
  });
});
