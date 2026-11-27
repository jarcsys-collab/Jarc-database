// S0-B, browser side, in Node (no server, no browser): the unchanged BoardModel and AppView in a vm context with a synthetic
// /related answer. When the server hits one of its bounds (services/related-service.js LIMITS) the affected Connect and Mirror
// cells show a small "partial" mark, so a cut list / count / sum never looks complete; complete cells show none.
// Synthetic values only.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

const ASSETS = path.resolve(__dirname, "..", "..", "site", "assets");
const read = (file) => fs.readFileSync(path.join(ASSETS, file), "utf8");
const hex = (n) => n.toString(16).padStart(24, "0");

function load() {
  const window = { location: { search: "", origin: "http://jarc.invalid" }, dispatchEvent() {}, addEventListener() {} };
  const overlay = { innerHTML: "", querySelector: () => null };
  const context = vm.createContext({
    window, console, Intl, Date, URL, encodeURIComponent, JSON, Map, Set, setTimeout, clearTimeout,
    document: { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: (sel) => (sel === "#overlay-root" ? overlay : null), querySelectorAll: () => [], body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  });
  context.window = Object.assign(context, window);
  for (const file of ["ColumnTypes.js", "IconLibrary.js", "AppView.js", "BoardModel.js"]) vm.runInContext(read(file), context, { filename: file });
  return context;
}

describe("partial Connect / Mirror cells (S0-B finding 3)", () => {
  const ctx = load();
  const columns = [{ key: "serial", label: "Item", type: "text" }, { key: "client", label: "Clients", type: "connect", link: { boardId: hex(9) } }, { key: "n", label: "N", type: "mirror", mirror: { via: "client", column: "v", show: "count" } }, { key: "total", label: "Total", type: "mirror", mirror: { via: "client", column: "v", show: "sum" } }];
  const many = Array.from({ length: 101 }, (_, i) => hex(1000 + i));
  const rows = [{ id: hex(1), serial: "Big", client: many }, { id: hex(2), serial: "Small", client: [hex(1000)] }];
  const model = (answer) => {
    const m = Object.create(ctx.BoardModel.prototype);
    // The board on screen and its rows (own properties in place of the model's getters); the storage answers /related.
    Object.defineProperties(m, { board: { value: { id: hex(7), columns } }, rows: { value: rows }, storage: { value: { related: async () => answer } } });
    return m;
  };
  const view = new ctx.AppView({ innerHTML: "" });
  const col = (k) => columns.find((c) => c.key === k);

  test("cell-limit: only the row whose own cell holds more than 100 links is marked, on its Connect AND Mirror cells", async () => {
    const m = model({ linked: { client: { [hex(1000)]: { name: "Acme", archived: false } } }, values: { [hex(1)]: { n: 100, total: 1000 }, [hex(2)]: { n: 1, total: 10 } }, restricted: [], unavailable: [], partial: { client: "cell-limit", n: "cell-limit", total: "cell-limit" } });
    m.relatedState().wanted = new Set([hex(1), hex(2)]);
    await m.flushRelated();
    for (const key of ["client", "n", "total"]) {
      const big = view.relationDisplay(rows[0], col(key), m), small = view.relationDisplay(rows[1], col(key), m);
      assert.match(big, /class="relation-partial"[^>]*title="Only the first 100 linked records are included"[^>]*>partial</, `${key}: ${big}`);
      assert.doesNotMatch(small, /relation-partial/, `${key}: a complete cell has no mark`);
    }
  });

  test("linked-limit / time-budget / target-boards: every row of that answer is marked on the flagged keys; other keys are not", async () => {
    for (const reason of ["linked-limit", "time-budget", "target-boards"]) {
      const m = model({ linked: { client: {} }, values: { [hex(1)]: { n: 3 }, [hex(2)]: { n: 1 } }, restricted: [], unavailable: [], partial: { client: reason, n: reason } });
      m.relatedState().wanted = new Set([hex(1), hex(2)]);
      await m.flushRelated();
      for (const r of rows) {
        assert.match(view.relationDisplay(r, col("client"), m), /relation-partial/, reason);
        assert.match(view.relationDisplay(r, col("n"), m), /relation-partial/, reason);
        assert.doesNotMatch(view.relationDisplay(r, col("total"), m), /relation-partial/, `${reason}: total not flagged`);
      }
    }
  });

  test("no partial in the answer: no mark anywhere; a restricted column stays a lock with no mark and no count", async () => {
    const m = model({ linked: { client: {} }, values: { [hex(1)]: { n: 2 }, [hex(2)]: { n: 1 } }, restricted: [], unavailable: [], partial: {} });
    m.relatedState().wanted = new Set([hex(1), hex(2)]);
    await m.flushRelated();
    for (const r of rows) for (const k of ["client", "n", "total"]) assert.doesNotMatch(view.relationDisplay(r, col(k), m), /relation-partial/);
    const locked = model({ linked: {}, values: { [hex(1)]: {}, [hex(2)]: {} }, restricted: ["client", "n", "total"], unavailable: [], partial: {} });
    locked.relatedState().wanted = new Set([hex(1)]);
    await locked.flushRelated();
    const html = view.relationDisplay(rows[0], col("n"), locked);
    assert.match(html, /relation-locked/); assert.doesNotMatch(html, /partial/); assert.doesNotMatch(html.replace(/<svg[\s\S]*?<\/svg>/g, ""), /\d/, "no count");
  });
});
