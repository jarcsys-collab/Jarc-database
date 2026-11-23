// Rolling back: the PREVIOUS production release (7e863f4, taken from git) runs against a database written by this release.
// Both apps share one fake MongoDB, as two Railway deployments would share the real one. Checks that personal views can't
// reach anyone through the old code, that nothing is lost, and records what old code does with Connect / Mirror columns.
// Skipped when git or that commit isn't available. Synthetic people and data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FakeMongoClient } = require("./support/fake-mongo");

const BASE = "7e863f4";
const OLD_DIR = path.join(__dirname, ".diagnostics", `rollback-${BASE}`); // git-ignored; under server/ so node_modules resolve
function extractOld() {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: __dirname, encoding: "utf8" }).trim();
    if (!fs.existsSync(path.join(OLD_DIR, "server", "package.json"))) {
      fs.mkdirSync(OLD_DIR, { recursive: true });
      const tar = execFileSync("git", ["archive", "--format=tar", BASE, "server/package.json", "server/src", "server/tests/helpers.js", "server/tests/support", "site"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
      execFileSync("tar", ["-x"], { cwd: OLD_DIR, input: tar }); // run inside the folder: a Windows drive path confuses tar
    }
    return require(path.join(OLD_DIR, "server", "tests", "helpers.js"));
  } catch { return null; }
}
const oldHelpers = extractOld();

describe(`Rollback to ${BASE} with data written by this release`, { skip: oldHelpers ? false : `git or ${BASE} not available` }, () => {
  let issuer, fake, now, old, people, ws, board, clients, links;
  const sessions = new Map();
  const on = (app) => async (p, method, url, body) => {
    const key = `${app.url}|${p.oid}`;
    if (!sessions.has(key)) { const c = new SessionClient(app.url, app.entra.appOrigin); assert.equal((await c.signIn(p)).status, 201); sessions.set(key, c); }
    return sessions.get(key).request(method, url, body);
  };
  let nowAs, oldAs;
  const names = (b) => b.savedViews.map((v) => v.name).sort();

  before(async () => {
    issuer = await createTokenIssuer();
    fake = new FakeMongoClient();
    now = await startEntraApp({ issuer, fake });
    old = await oldHelpers.startEntraApp({ issuer, fake });
    nowAs = on(now); oldAs = on(old);
    people = { owner: issuer.person("Owner Person", { admin: true }), editor: issuer.person("Editor Person"), other: issuer.person("Other Person") };
    ws = (await nowAs(people.owner, "POST", "/api/v1/workspaces", { name: "Rollback" })).body.workspace;
    for (const p of [people.editor, people.other]) await nowAs(people.owner, "POST", `/api/v1/workspaces/${ws.id}/members`, { userId: (await nowAs(p, "GET", "/api/v1/me")).body.user.id, role: "MEMBER" });
    clients = (await nowAs(people.owner, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Clients", columns: [{ key: "serial", label: "Client", type: "text", required: true }, { key: "value", label: "Value", type: "number" }] })).body.board;
    links = (await nowAs(people.owner, "POST", `/api/v1/boards/${clients.id}/records/batch`, { records: [{ values: { serial: "Acme", value: 5 } }, { values: { serial: "Globex", value: 7 } }] })).body.items.map((r) => r.id);
    board = (await nowAs(people.owner, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Projects", columns: [{ key: "serial", label: "Project", type: "text", required: true }, { key: "notes", label: "Notes", type: "text" }, { key: "client", label: "Client", type: "connect", link: { boardId: clients.id }, multiple: true }, { key: "total", label: "Total", type: "mirror", mirror: { via: "client", column: "value", show: "sum" } }] })).body.board;
    assert.ok(board, "a board with Connect and Mirror columns");
    assert.equal((await nowAs(people.owner, "POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Alpha", client: links } })).status, 201);
    const b = (await nowAs(people.editor, "GET", `/api/v1/boards/${board.id}`)).body.board;
    const saved = await nowAs(people.editor, "PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, savedViews: [{ name: "Team", state: {} }, { name: "Editor secret", personal: true, state: { filter: { op: "and", rules: [{ key: "notes", cmp: "contains", values: ["salary"] }] } } }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  });
  after(async () => { await old?.close(); await now?.close(); });

  test("this release: the personal view is never in the board document", async () => {
    const doc = await now.db.collection("boards").findOne({ name: "Projects" });
    assert.deepEqual(doc.savedViews.map((v) => v.name), ["Team"]);
    assert.ok(!JSON.stringify(doc).includes("Editor secret") && !JSON.stringify(doc).includes("salary"));
    assert.equal((await now.db.collection("personalViews").find({}).toArray()).length, 1);
    assert.deepEqual(names((await nowAs(people.editor, "GET", `/api/v1/boards/${board.id}`)).body.board), ["Editor secret", "Team"]);
    assert.deepEqual(names((await nowAs(people.owner, "GET", `/api/v1/boards/${board.id}`)).body.board), ["Team"], "not even an admin");
  });

  test(`after a rollback to ${BASE}: nobody can see the personal view, and saving views doesn't lose it`, async () => {
    for (const p of [people.owner, people.editor, people.other]) {
      const res = await oldAs(p, "GET", `/api/v1/boards/${board.id}`);
      assert.equal(res.status, 200);
      assert.deepEqual(names(res.body.board), ["Team"], `old code, ${p.name}`);
      assert.ok(!res.text.includes("Editor secret") && !res.text.includes("salary"));
      const list = await oldAs(p, "GET", `/api/v1/workspaces/${ws.id}/boards`);
      assert.ok(!list.text.includes("Editor secret"));
    }
    // Old code saves the views it sees (the shared ones): the personal view's own document is untouched.
    const b = (await oldAs(people.other, "GET", `/api/v1/boards/${board.id}`)).body.board;
    assert.equal((await oldAs(people.other, "PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, savedViews: [{ id: b.savedViews[0].id, name: "Team (renamed)", state: {} }, { name: "Old-release view", state: {} }] })).status, 200);
    // Rolled forward again: the editor still has the personal view, alongside the shared changes made meanwhile.
    assert.deepEqual(names((await nowAs(people.editor, "GET", `/api/v1/boards/${board.id}`)).body.board), ["Editor secret", "Old-release view", "Team (renamed)"]);
    assert.deepEqual(names((await nowAs(people.other, "GET", `/api/v1/boards/${board.id}`)).body.board), ["Old-release view", "Team (renamed)"]);
  });

  test(`after a rollback to ${BASE}: Connect / Mirror boards open and take unrelated edits; links are kept`, async () => {
    const res = await oldAs(people.owner, "GET", `/api/v1/boards/${board.id}`);
    assert.equal(res.status, 200, "the board opens");
    assert.deepEqual(res.body.board.columns.map((c) => c.type), ["text", "text", "connect", "mirror"], "column definitions come through unchanged");
    const rec = (await oldAs(people.owner, "GET", `/api/v1/boards/${board.id}/records`)).body.items[0];
    assert.deepEqual(rec.values.client, links, "links readable");
    const edit = await oldAs(people.owner, "PATCH", `/api/v1/records/${rec.id}`, { expectedVersion: rec.version, values: { notes: "edited on the old release" } });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    const stored = await now.db.collection("records").findOne({ "values.serial": "Alpha" });
    assert.deepEqual(stored.values.client, links, "an unrelated edit keeps the links");
    const renamed = await oldAs(people.owner, "PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: res.body.board.version, name: "Projects (old)" });
    assert.equal(renamed.status, 200, "board name changes work");
    const back = await now.db.collection("boards").findOne({ _id: stored.boardId });
    assert.deepEqual(back.columns.find((c) => c.key === "client").link, { boardId: clients.id }, "the Connect definition is kept");
    assert.deepEqual(back.columns.find((c) => c.key === "total").mirror, { via: "client", column: "value", show: "sum" });
  });

  test(`after a rollback to ${BASE}: what old code refuses or can damage (documented restrictions)`, async () => {
    const b = (await oldAs(people.owner, "GET", `/api/v1/boards/${board.id}`)).body.board;
    // Column changes go through the old schema, which doesn't know these types: refused, nothing written.
    const add = await oldAs(people.owner, "POST", `/api/v1/boards/${board.id}/columns`, { expectedVersion: b.version, column: { key: "extra", label: "Extra", type: "text" } });
    const columns = await oldAs(people.owner, "PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, columns: b.columns.map((c) => (c.key === "notes" ? { ...c, label: "Notes 2" } : c)) });
    assert.equal(columns.status, 400, "a column-list change is refused by old code");
    const doc = await now.db.collection("boards").findOne({ _id: (await now.db.collection("records").findOne({ "values.serial": "Alpha" })).boardId });
    assert.ok(doc.columns.some((c) => c.type === "connect"), "the Connect column survives");
    // A Connect cell written by old code as text: what happens is recorded for the deployment notes.
    const rec = (await oldAs(people.owner, "GET", `/api/v1/boards/${board.id}/records`)).body.items[0];
    const text = await oldAs(people.owner, "PATCH", `/api/v1/records/${rec.id}`, { expectedVersion: rec.version, values: { client: "Acme" } });
    const after = (await now.db.collection("records").findOne({ "values.serial": "Alpha" })).values.client;
    console.log(`[rollback-compat] old code: add column → ${add.status}; column list change → ${columns.status}; Connect cell written as text → ${text.status}, stored ${JSON.stringify(after)}`);
    if (text.status === 200) assert.equal(after, "Acme", "old code CAN overwrite links with text: a documented rollback restriction");
    else assert.deepEqual(after, links);
  });
});
