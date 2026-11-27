// Connect deletion paths (doc 25 finding 5, §6): EVERY code path that deletes records, boards, workspaces or Connect columns is
// listed here with what must happen to Connect cells / recordLinks rows. Today (Connect off in production, recordLinks not
// written by any route) nothing is cascaded: readers ignore dangling IDs, tolerant writes drop them and report droppedLinks.
// The cascades are C3.1-4 (required before Connect activation); their tests are prepared as todo below, and the real-Mongo
// building blocks (RecordLinkService.deleteRecord / cascade / onBoardDeleted / onColumnDeleted) are proven in
// record-links-real-mongo / record-links-concurrency. A NEW deletion call site anywhere in server/src fails this test until it is
// classified here. Static scan only (no database).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");

const SRC = path.resolve(__dirname, "..", "src");
const DELETES = /\brecords\.(deleteVersioned|bulkDelete|deleteByBoard|deleteByWorkspace|deleteMany|deleteOne)\(|collection\("records"\)\.(deleteMany|deleteOne|bulkWrite)\(|col\("records"\)\.(deleteMany|deleteOne)\(/g;
// file → number of record-deleting calls, and what each path must do once Connect is active (class b = before activation).
const INVENTORY = {
  "services/record-service.js": { calls: 4, paths: [
    "create(): board deleted meanwhile → the new record is removed (deleteVersioned, version 1): no links yet — nothing to do",
    "delete(): single record (DELETE /records/:id) → (b) deleteRecord in one transaction: pull its ID from source cells (≤ 2,000, else paced job) + its own rows",
    "createMany(): board deleted meanwhile → deleteByBoard: board gone — onBoardDeleted sweep covers it",
    "deleteMany(): bulkDelete in one transaction → (b) the same cascade for every deleted ID, in that transaction"] },
  "routes/resources.js": { calls: 1, paths: ["POST /boards/:id/records/delete → services.records.deleteMany (see ROUTE_PATHS)"] },
  "repositories/mongo/record-repository.js": { calls: 0, paths: ["bulkDelete / deleteByBoard / deleteByWorkspace definitions (called from the services listed)"] },
  "services/board-service.js": { calls: 2, paths: ["delete(): board + its records (transaction + sweep) → (b) onBoardDeleted (from_board_column + to_board, paced); source cells keep IDs → `broken` (C3.0-a)"] },
  "services/workspace-service.js": { calls: 2, paths: ["delete(): every board of the workspace → (b) onBoardDeleted per board (read the board IDs before deleting, as files/comments do)"] },
  "services/import-job-service.js": { calls: 2, paths: [
    "remove-board (POST /imports/:id/remove-board): an import's records in batches, then the board → (b) per batch cascade (inbound links from other boards) + onBoardDeleted",
    "board deleted while importing → leftovers removed: board gone — onBoardDeleted covers it"] },
  "migration/monday/rollback.js": { calls: 1, paths: ["monday migration rollback (version-1 imported records only): monday relations are text snapshots, never Connect — but a JARC Connect cell may point at a migrated record → (b) cascade per batch"] }
};
const ROUTE_PATHS = [
  "resources.js POST /boards/:id/records/delete → services.records.deleteMany (bulk; also the browser's group-delete-with-records and the originals of a record MOVE) → (b) cascade for every deleted ID in the same transaction",
  "resources.js DELETE /boards/:id/columns/:key → schema.deleteColumn (refused while Mirrors follow) → (b) onColumnDeleted (paced)",
  "resources.js PATCH /records/:id archived:true → archive: NO cascade (links stay; archived records can't be newly linked: link guard)",
  "external-api.js (token API) and external-fabric.js: READ-ONLY — no write route (asserted below)"
];

function scan(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

describe("Connect: every record / board / workspace / column deletion path is classified", () => {
  test("record-deleting call sites in server/src match the inventory (a new one must be classified here)", () => {
    const found = {};
    for (const file of scan(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (rel.startsWith("relations/")) continue; // the recordLinks single writer itself
      const n = (fs.readFileSync(file, "utf8").match(DELETES) || []).length;
      if (n) found[rel] = n;
    }
    const expected = Object.fromEntries(Object.entries(INVENTORY).filter(([, v]) => v.calls).map(([k, v]) => [k, v.calls]));
    assert.deepEqual(found, expected, `unclassified or changed deletion paths:\n${JSON.stringify(found, null, 2)}`);
  });

  test("the token API and the Fabric API have no write route (read-only: no deletion or link write through tokens)", () => {
    for (const f of ["routes/external-api.js", "routes/external-fabric.js"]) {
      const text = fs.readFileSync(path.join(SRC, f), "utf8");
      assert.doesNotMatch(text, /router\.(post|put|patch|delete)\(/, f);
    }
  });

  test("route deletion paths reach only the classified services", () => {
    const text = fs.readFileSync(path.join(SRC, "routes", "resources.js"), "utf8");
    for (const call of ["services.records.deleteMany(", "services.records.delete(", "services.boards.delete(", "services.workspaces.delete(", "services.schema.deleteColumn("]) assert.ok(text.includes(call), call);
    assert.equal(ROUTE_PATHS.length, 4);
  });

  // Prepared for C3.1-4 (required before Connect activation; wiring is gated on JARC_FEATURE_CONNECT_BOARDS + a ready index):
  test.todo("DELETE /records/:id: the deleted record's ID is pulled from every source cell and its rows go, in the delete transaction (activity IDs only, SSE per source board)");
  test.todo("POST /boards/:id/records/delete (bulk, group delete with records, move originals): the same cascade for every deleted ID; > 2,000 inbound → paced job, resumable");
  test.todo("DELETE /boards/:id and DELETE /workspaces/:id: onBoardDeleted for each board (from + to rows); source cells keep the IDs and /related reports `broken`");
  test.todo("DELETE /boards/:id/columns/:key on a Connect column: onColumnDeleted; the retired column's activity stays redacted");
  test.todo("POST /imports/:id/remove-board and the monday rollback: per-batch cascade for inbound links, then the board sweep");
  test.todo("reconcile --verify reports 0 after every path above under concurrent link saves (real Mongo)");
});
