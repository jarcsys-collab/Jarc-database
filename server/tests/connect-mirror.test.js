// Connect boards and Mirror columns: links hold record IDs (nothing copied); only boards and records a person can see can be
// linked; mirror values are worked out per reader and never reach someone who can't see the linked board; numbers are
// summed / averaged; chains are not followed; existing column types, filters and the API stay as they were.
// The real app with Entra sign-in on the fake MongoDB (role_based), synthetic people and data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { RelatedService } = require("../src/services/related-service");

describe("Connect boards and Mirror columns", () => {
  let app, issuer, people, wsA, wsB, clients, projects, sales, link;
  const sessions = new Map();
  const as = async (p, method, url, body) => { if (!sessions.has(p.oid)) { const c = new SessionClient(app.url, app.entra.appOrigin); assert.equal((await c.signIn(p)).status, 201); sessions.set(p.oid, c); } return sessions.get(p.oid).request(method, url, body); };
  const board = async (p, id) => (await as(p, "GET", `/api/v1/boards/${id}`)).body.board;
  const addColumn = async (p, b, column) => as(p, "POST", `/api/v1/boards/${b.id}/columns`, { expectedVersion: (await board(p, b.id)).version, column });
  const related = async (p, b, ids) => as(p, "GET", `/api/v1/boards/${b.id}/related?ids=${ids.join(",")}`);

  before(async () => {
    issuer = await createTokenIssuer();
    people = { owner: issuer.person("Owner Person", { admin: true }), member: issuer.person("Member Person") };
    app = await startEntraApp({ issuer });
    wsA = (await as(people.owner, "POST", "/api/v1/workspaces", { name: "Projects space" })).body.workspace;
    wsB = (await as(people.owner, "POST", "/api/v1/workspaces", { name: "Clients space" })).body.workspace;
    const memberId = (await as(people.member, "GET", "/api/v1/me")).body.user.id;
    assert.equal((await as(people.owner, "POST", `/api/v1/workspaces/${wsA.id}/members`, { userId: memberId, role: "MEMBER" })).status, 201); // not in wsB
    clients = (await as(people.owner, "POST", `/api/v1/workspaces/${wsB.id}/boards`, { name: "Clients", groups: [{ name: "Key" }, { name: "Other" }], columns: [{ key: "serial", label: "Client", type: "text", required: true }, { key: "value", label: "Value", type: "number" }, { key: "since", label: "Since", type: "date" }, { key: "state", label: "State", type: "status", options: ["Active", "Paused"] }, { key: "grp", label: "Group", type: "group" }] })).body.board;
    const made = (await as(people.owner, "POST", `/api/v1/boards/${clients.id}/records/batch`, { records: [
      { values: { serial: "Acme", value: 100, since: "2026-01-10", state: "Active" }, groupId: clients.groups[0].id },
      { values: { serial: "Globex", value: "50.5", since: "2025-06-01", state: "Paused" }, groupId: clients.groups[1].id },
      { values: { serial: "Initech", value: "", since: "" } }
    ] })).body.items;
    link = Object.fromEntries(made.map((r) => [r.values.serial, r.id]));
    projects = (await as(people.owner, "POST", `/api/v1/workspaces/${wsA.id}/boards`, { name: "Projects", columns: [{ key: "serial", label: "Project", type: "text", required: true }] })).body.board;
    sales = (await as(people.owner, "POST", `/api/v1/workspaces/${wsA.id}/boards`, { name: "Sales", columns: [{ key: "serial", label: "Deal", type: "text", required: true }] })).body.board;
  });
  after(async () => { await app?.close(); });

  test("a Connect column needs a board the person can open; a Mirror needs a Connect column", async () => {
    assert.equal((await addColumn(people.member, projects, { key: "client", label: "Client", type: "connect", link: { boardId: clients.id }, multiple: true })).status, 403, "the member can't open Clients");
    assert.equal((await addColumn(people.owner, projects, { key: "client", label: "Client", type: "connect", link: { boardId: clients.id }, multiple: true })).status, 201);
    assert.equal((await addColumn(people.owner, projects, { key: "bad", label: "Bad", type: "mirror", mirror: { via: "serial", column: "value" } })).status, 400, "mirror must follow a Connect column");
    for (const [key, column, show] of [["total", "value", "sum"], ["avg", "value", "avg"], ["names", "state", "list"], ["first", "since", "earliest"], ["n", "value", "count"], ["grp", "grp", "list"]])
      assert.equal((await addColumn(people.owner, projects, { key, label: key, type: "mirror", mirror: { via: "client", column, show } })).status, 201, key);
    assert.equal((await addColumn(people.owner, projects, { key: "one", label: "One client", type: "connect", link: { boardId: clients.id } })).status, 201);
    assert.equal((await as(people.owner, "POST", `/api/v1/boards/${projects.id}/columns/one/type`, { expectedVersion: (await board(people.owner, projects.id)).version, type: "text" })).status, 400, "no converting a Connect column");
  });

  test("links hold record IDs: real records of the linked board only, each once, one unless the column allows several", async () => {
    const post = (values) => as(people.owner, "POST", `/api/v1/boards/${projects.id}/records`, { values: { serial: "P", ...values } });
    assert.equal((await post({ client: [link.Acme, link.Acme] })).status, 400, "no duplicates");
    assert.equal((await post({ client: ["0123456789abcdef01234567"] })).status, 400, "an ID that isn't on Clients");
    assert.equal((await post({ client: ["Acme"] })).status, 400, "names aren't IDs");
    assert.equal((await post({ one: [link.Acme, link.Globex] })).status, 400, "a single-link column");
    assert.equal((await post({ total: 5 })).status, 400, "mirror cells can't be written");
    const sameBoardRecord = (await as(people.owner, "GET", `/api/v1/boards/${projects.id}/records`)).body.items[0];
    if (sameBoardRecord) assert.equal((await post({ client: [sameBoardRecord.id] })).status, 400, "a record of another board isn't on Clients");
    const ok = await post({ serial: "Alpha", client: [link.Acme, link.Globex, link.Initech], one: [link.Acme] });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.record.values.client, [link.Acme, link.Globex, link.Initech]);
    assert.equal((await as(people.owner, "GET", `/api/v1/boards/${clients.id}/records/count`)).body.total, 3, "nothing copied to Clients");
  });

  test("mirror values are worked out from the linked records, for someone who can see them", async () => {
    const alpha = (await as(people.owner, "GET", `/api/v1/boards/${projects.id}/records`)).body.items.find((r) => r.values.serial === "Alpha");
    const empty = (await as(people.owner, "POST", `/api/v1/boards/${projects.id}/records`, { values: { serial: "Empty" } })).body.record;
    const res = await related(people.owner, projects, [alpha.id, empty.id]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.restricted, []);
    assert.equal(res.body.linked.client[link.Acme].name, "Acme");
    const v = res.body.values[alpha.id];
    assert.equal(v.total, 150.5); assert.equal(v.avg, 75.25); assert.equal(v.n, 2, "count: linked records with a value");
    assert.deepEqual(v.names, ["Active", "Paused"]); assert.equal(v.first, "2025-06-01"); assert.deepEqual(v.grp, ["Key", "Other"]);
    assert.deepEqual(res.body.values[empty.id], { total: null, avg: null, n: 0, names: [], first: null, grp: [] }, "no links: empty values");
    // A change on the linked board shows at the next read (nothing is stored on Projects).
    assert.equal((await as(people.owner, "PATCH", `/api/v1/records/${link.Acme}`, { expectedVersion: 1, values: { value: 200 } })).status, 200);
    assert.equal((await related(people.owner, projects, [alpha.id])).body.values[alpha.id].total, 250.5);
    // Archived linked records drop out of mirrors.
    assert.equal((await as(people.owner, "PATCH", `/api/v1/records/${link.Globex}`, { expectedVersion: 1, archived: true })).status, 200);
    assert.equal((await related(people.owner, projects, [alpha.id])).body.values[alpha.id].total, 200);
  });

  test("someone who can't open the linked board sees the IDs but no names and no mirrored values, and can't link", async () => {
    const alpha = (await as(people.member, "GET", `/api/v1/boards/${projects.id}/records`)).body.items.find((r) => r.values.serial === "Alpha");
    const res = await related(people.member, projects, [alpha.id]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.restricted.sort(), ["avg", "client", "first", "grp", "n", "names", "one", "total"].sort());
    assert.equal(res.body.linked.client, undefined, "no names");
    assert.deepEqual(res.body.values[alpha.id], {}, "no mirrored values");
    assert.ok(!JSON.stringify(res.body).includes("Acme"), "nothing from Clients in the response");
    const write = await as(people.member, "POST", `/api/v1/boards/${projects.id}/records`, { values: { serial: "Mine", client: [link.Initech] } });
    assert.equal(write.status, 403, "can't link to a board they can't open");
    assert.equal((await as(people.member, "POST", `/api/v1/boards/${projects.id}/records`, { values: { serial: "No links" } })).status, 201, "other edits still work");
    // Access granted later: the same request now shows everything.
    const memberId = (await as(people.member, "GET", "/api/v1/me")).body.user.id;
    await as(people.owner, "POST", `/api/v1/workspaces/${wsB.id}/members`, { userId: memberId, role: "VIEWER" });
    assert.equal((await related(people.member, projects, [alpha.id])).body.values[alpha.id].total, 200);
  });

  test("a mirror of a mirror (or of a Connect column) is not followed; requests are bounded", async () => {
    assert.equal((await addColumn(people.owner, sales, { key: "proj", label: "Project", type: "connect", link: { boardId: projects.id }, multiple: true })).status, 201);
    assert.equal((await addColumn(people.owner, sales, { key: "chain", label: "Chain", type: "mirror", mirror: { via: "proj", column: "total", show: "sum" } })).status, 201);
    assert.equal((await addColumn(people.owner, sales, { key: "via", label: "Via", type: "mirror", mirror: { via: "proj", column: "client", show: "list" } })).status, 201);
    const alpha = (await as(people.owner, "GET", `/api/v1/boards/${projects.id}/records`)).body.items.find((r) => r.values.serial === "Alpha");
    const deal = (await as(people.owner, "POST", `/api/v1/boards/${sales.id}/records`, { values: { serial: "Deal", proj: [alpha.id] } })).body.record;
    const res = (await related(people.owner, sales, [deal.id])).body;
    assert.deepEqual(res.unavailable.sort(), ["chain", "via"]);
    assert.deepEqual(res.values[deal.id], {});
    assert.equal(res.linked.proj[alpha.id].name, "Alpha");
    assert.equal((await related(people.owner, sales, Array(201).fill(deal.id))).status, 400, "at most 200 records");
    assert.equal((await as(people.owner, "GET", `/api/v1/boards/${sales.id}/related?ids=nope`)).status, 400);
  });

  test("filters: Connect columns by empty / has links; Mirror columns refused (values live elsewhere)", async () => {
    const q = (f) => as(people.owner, "GET", `/api/v1/boards/${projects.id}/records/count?filter=${encodeURIComponent(JSON.stringify(f))}`);
    assert.equal((await q({ op: "and", rules: [{ key: "client", cmp: "notEmpty" }] })).body.total, 1);
    assert.equal((await q({ op: "and", rules: [{ key: "client", cmp: "empty" }] })).body.total, 2);
    assert.equal((await q({ op: "and", rules: [{ key: "total", cmp: "gte", values: ["1"] }] })).status, 400);
  });

  test("summaries on their own", () => {
    const s = (values, show) => RelatedService.summarise(values, { type: "number" }, show);
    assert.equal(s(["1", 2, "x", "", null], "sum"), 3);
    assert.equal(s([], "avg"), null);
    assert.equal(s([3, "7"], "max"), 7);
    assert.deepEqual(s([true, false, ["a", "b"]], "list"), ["Yes", "a", "b"]);
  });
});
