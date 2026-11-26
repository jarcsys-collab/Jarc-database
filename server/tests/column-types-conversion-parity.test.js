// Column System R0: the registry's "Change type" offer (ColumnTypes.canConvert / conversionTargets) is exactly what the server
// performs under S0-A. Every source type (and the several-value Dropdown) × every target is asked of the real route
// POST /boards/:id/columns/:key/type?dryRun=true on an EMPTY board, where only the structural rules decide
// (services/board-schema-service.js assertConvertible): the registry offers a change if and only if the server accepts it.
// Value-level refusals (lossy values, People with values) stay with the server's dry run. In-memory fake MongoDB, synthetic data.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startMongoApp, api } = require("./helpers");
const CT = require("../../site/assets/ColumnTypes.js");

let app, ws;
const call = (method, path, body) => api(app.url, method, `/api/v1${path}`, body);

before(async () => {
  app = await startMongoApp({ app: { features: { connectBoards: true } } });
  ws = (await call("POST", "/workspaces", { name: "R0 conversions" })).body.workspace;
});
after(async () => { await app.close(); });

test("Change type: the registry offers a conversion exactly when the server performs it (all 16 × 16 pairs, Item column too)", async () => {
  const target = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Linked", columns: [{ key: "serial", label: "Item", type: "text", required: true }, { key: "n", label: "N", type: "number" }] })).body.board;
  const sources = [
    ...CT.ids().map((type) => ({ key: `c_${type}`, label: type, type, ...(type === "connect" ? { link: { boardId: target.id } } : {}), ...(type === "mirror" ? { mirror: { via: "c_connect", column: "n" } } : {}) })),
    { key: "c_dropdown_multi", label: "dropdown multi", type: "dropdown", multiple: true }
  ];
  const created = await call("POST", `/workspaces/${ws.id}/boards`, { name: "Every type", columns: [{ key: "serial", label: "Item", type: "text", required: true }, ...sources] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const board = created.body.board;
  const targets = [...CT.ids().map((type) => ({ type, multiple: false })), { type: "dropdown", multiple: true }];
  let offered = 0, checked = 0;
  for (const column of [{ key: "serial", type: "text" }, ...sources]) {
    const viaTargets = new Set(CT.conversionTargets(column, { relationsAvailable: true }));
    for (const to of targets) {
      const res = await call("POST", `/boards/${board.id}/columns/${column.key}/type?dryRun=true`, { expectedVersion: board.version, ...to });
      const server = res.status === 200 && res.body.allowed === true;
      if (!server) assert.equal(res.status, 400, `${column.key} → ${to.type}: ${JSON.stringify(res.body)}`);
      const mine = CT.canConvert(column, to);
      assert.equal(mine, server, `${column.key}${column.multiple ? " (several)" : ""} → ${to.type}${to.multiple ? " (several)" : ""}: registry ${mine}, server ${server}`);
      if (!to.multiple && to.type !== column.type) assert.equal(viaTargets.has(to.type), server, `conversionTargets(${column.key}) ${to.type}`);
      offered += mine ? 1 : 0; checked += 1;
    }
  }
  assert.equal(checked, 17 * 16);
  assert.ok(offered > 100, `${offered} conversions offered`);
  const after = (await call("GET", `/boards/${board.id}`)).body.board;
  assert.equal(after.version, board.version, "dry runs change nothing");
});
