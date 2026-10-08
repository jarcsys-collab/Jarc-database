const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MemoryStateRepository } = require("../src/repositories/memory-state-repository");
const { validState } = require("./helpers");

test("starts empty; a new instance (server restart) has no data", async () => {
  const first = new MemoryStateRepository();
  await first.saveState(validState());
  assert.notEqual((await first.loadState()).state, null);
  assert.deepEqual(await new MemoryStateRepository().loadState(), { state: null, revision: 0, updatedAt: null });
});

test("stored data is a copy: later changes to the input or the loaded object don't leak in", async () => {
  const repo = new MemoryStateRepository(), state = validState();
  await repo.saveState(state);
  state.workspaces[0].name = "changed after save";
  const loaded = (await repo.loadState()).state;
  loaded.workspaces[0].name = "changed after load";
  assert.equal((await repo.loadState()).state.workspaces[0].name, "Operations");
});

test("overlapping writes apply one at a time in arrival order", async () => {
  const repo = new MemoryStateRepository();
  const results = await Promise.all([1, 2, 3].map((n) => repo.saveState(validState({ settings: { n } }))));
  assert.deepEqual(results.map((r) => r.revision), [1, 2, 3]);
  assert.equal((await repo.loadState()).state.settings.n, 3);
});
