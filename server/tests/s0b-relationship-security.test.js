// S0-B relationship security (Column System plan 17 §1-§3): Connect / Mirror never disclose another board's record IDs, names,
// mirrored values or history to someone who can't open it, on any surface (record lists, single records, write responses, forms,
// /related, activity, live updates, API Explorer), can't be used to clear links on such a board, and stay bounded and honest
// (partial flags, orphan reasons, no server sort by IDs). Under shared access everything stays visible (parity).
// The real app with Entra sign-in on the fake MongoDB; synthetic people and data only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ObjectId } = require("mongodb");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { Access } = require("../src/auth/access");
const { RelatedService, LIMITS } = require("../src/services/related-service");
const { activityOut } = require("../src/services/relation-guard");
const { ACCESS_ACTIONS } = require("../src/routes/events");
const { RecordLinkStatus } = require("../src/relations/record-links");

function world({ accessPolicy, relations = null } = {}) {
  const w = { sessions: new Map() };
  w.as = async (p, method, url, body) => {
    if (!w.sessions.has(p.oid)) { const c = new SessionClient(w.app.url, w.app.entra.appOrigin); assert.equal((await c.signIn(p)).status, 201); w.sessions.set(p.oid, c); }
    return w.sessions.get(p.oid).request(method, url, body);
  };
  w.board = async (p, id) => (await w.as(p, "GET", `/api/v1/boards/${id}`)).body.board;
  w.addColumn = async (p, b, column) => w.as(p, "POST", `/api/v1/boards/${b.id}/columns`, { expectedVersion: (await w.board(p, b.id)).version, column });
  w.setup = async () => {
    w.issuer = await createTokenIssuer();
    const P = w.people = { owner: w.issuer.person("Owner Person", { admin: true }), editor: w.issuer.person("Host Editor"), reader: w.issuer.person("Host Reader"), both: w.issuer.person("Both Reader") };
    w.app = await startEntraApp({ issuer: w.issuer, ...(accessPolicy ? { accessPolicy } : {}), ...(relations ? { relations } : {}), apiTokens: { key: crypto.randomBytes(32), issuePerHour: 1000, maxActive: 1000, adminObjectIds: [P.editor.oid.toLowerCase()] } });
    w.wsA = (await w.as(P.owner, "POST", "/api/v1/workspaces", { name: "Hosts" })).body.workspace;
    w.wsB = (await w.as(P.owner, "POST", "/api/v1/workspaces", { name: "Targets" })).body.workspace;
    const id = async (p) => (await w.as(p, "GET", "/api/v1/me")).body.user.id;
    const member = async (ws, p, role) => assert.equal((await w.as(P.owner, "POST", `/api/v1/workspaces/${ws.id}/members`, { userId: await id(p), role })).status, 201);
    await member(w.wsA, P.editor, "MEMBER"); await member(w.wsA, P.reader, "VIEWER"); await member(w.wsA, P.both, "MEMBER"); await member(w.wsB, P.both, "VIEWER");
    w.clients = (await w.as(P.owner, "POST", `/api/v1/workspaces/${w.wsB.id}/boards`, { name: "Clients", columns: [{ key: "serial", label: "Client", type: "text", required: true }, { key: "value", label: "Value", type: "number" }, { key: "state", label: "State", type: "status", options: ["Active", "Paused"] }] })).body.board;
    const made = (await w.as(P.owner, "POST", `/api/v1/boards/${w.clients.id}/records/batch`, { records: ["Acme", "Globex", "Initech", "Umbrella"].map((serial, i) => ({ values: { serial, value: (i + 1) * 10, state: "Active" } })) })).body.items;
    w.link = Object.fromEntries(made.map((r) => [r.values.serial, r.id]));
    w.projects = (await w.as(P.owner, "POST", `/api/v1/workspaces/${w.wsA.id}/boards`, { name: "Projects", columns: [{ key: "serial", label: "Project", type: "text", required: true }, { key: "note", label: "Note", type: "text" }] })).body.board;
    assert.equal((await w.addColumn(P.owner, w.projects, { key: "client", label: "Client", type: "connect", link: { boardId: w.clients.id }, multiple: true })).status, 201);
    assert.equal((await w.addColumn(P.owner, w.projects, { key: "total", label: "Total", type: "mirror", mirror: { via: "client", column: "value", show: "sum" } })).status, 201);
    assert.equal((await w.addColumn(P.owner, w.projects, { key: "n", label: "N", type: "mirror", mirror: { via: "client", column: "value", show: "count" } })).status, 201);
    w.alpha = (await w.as(P.owner, "POST", `/api/v1/boards/${w.projects.id}/records`, { values: { serial: "Alpha", client: [w.link.Acme, w.link.Globex] } })).body.record;
  };
  w.alphaNow = async (p = w.people.owner) => (await w.as(p, "GET", `/api/v1/records/${w.alpha.id}`)).body.record;
  return w;
}
const noTargetIds = (w, body) => { const text = JSON.stringify(body); for (const id of Object.values(w.link)) assert.ok(!text.includes(id), `no linked record ID in ${text.slice(0, 200)}`); };

describe("S0-B under role_based (the matrix)", () => {
  const w = world();
  before(() => w.setup());
  after(async () => { await w.app?.close(); });

  test("rows 1-2: record lists and single records leave restricted Connect cells out (no IDs, no count)", async () => {
    const P = w.people;
    for (const p of [P.reader, P.editor]) {
      const list = await w.as(p, "GET", `/api/v1/boards/${w.projects.id}/records`);
      assert.equal(list.status, 200);
      const row = list.body.items.find((r) => r.id === w.alpha.id);
      // The Mirrors that follow a restricted Connect column are restricted too (their stored cells are empty placeholders).
      assert.equal("client" in row.values, false); assert.deepEqual(row.restricted.sort(), ["client", "n", "total"]);
      noTargetIds(w, list.body);
      const one = await w.as(p, "GET", `/api/v1/records/${w.alpha.id}`);
      assert.equal(one.status, 200); assert.equal("client" in one.body.record.values, false); noTargetIds(w, one.body);
    }
    for (const p of [P.both, P.owner]) {
      const row = (await w.as(p, "GET", `/api/v1/boards/${w.projects.id}/records`)).body.items.find((r) => r.id === w.alpha.id);
      assert.deepEqual(row.values.client, [w.link.Acme, w.link.Globex]); assert.equal(row.restricted, undefined);
    }
    // A record ID used as a board ID is 404.
    assert.equal((await w.as(P.reader, "GET", `/api/v1/boards/${w.alpha.id}/records`)).status, 404);
  });

  test("row 3: write responses (create, batch, bulk, PATCH) carry no Connect IDs for a host-only editor", async () => {
    const P = w.people;
    const patch = await w.as(P.editor, "PATCH", `/api/v1/records/${w.alpha.id}`, { expectedVersion: (await w.alphaNow()).version, values: { note: "edited" } });
    assert.equal(patch.status, 200, JSON.stringify(patch.body)); assert.equal("client" in patch.body.record.values, false); noTargetIds(w, patch.body);
    const cur = await w.alphaNow();
    const bulk = await w.as(P.editor, "PATCH", `/api/v1/boards/${w.projects.id}/records`, { items: [{ id: w.alpha.id, expectedVersion: cur.version, values: { note: "bulk" } }] });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body)); noTargetIds(w, bulk.body); assert.ok(bulk.body.items[0].restricted.includes("client"));
    const made = await w.as(P.editor, "POST", `/api/v1/boards/${w.projects.id}/records`, { values: { serial: "Mine" } });
    assert.equal(made.status, 201); assert.equal("client" in made.body.record.values, false, "the empty placeholder is hidden too: no count either way");
    assert.equal((await w.as(P.editor, "POST", `/api/v1/boards/${w.projects.id}/records/batch`, { records: [{ values: { serial: "B1" } }] })).status, 201);
  });

  test("row 5/6: /related gives a host-only reader no names and no mirrored values (never a 0 count); the reader of both gets them", async () => {
    const P = w.people;
    const r = await w.as(P.reader, "GET", `/api/v1/boards/${w.projects.id}/related?ids=${w.alpha.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.restricted.sort(), ["client", "n", "total"]);
    assert.equal(r.body.linked.client, undefined); assert.deepEqual(r.body.values[w.alpha.id], {}, "no value, no count");
    noTargetIds(w, r.body); assert.ok(!JSON.stringify(r.body).includes("Acme"));
    const b = await w.as(P.both, "GET", `/api/v1/boards/${w.projects.id}/related?ids=${w.alpha.id}`);
    assert.equal(b.body.linked.client[w.link.Acme].name, "Acme"); assert.equal(b.body.values[w.alpha.id].total, 30); assert.equal(b.body.values[w.alpha.id].n, 2);
    assert.deepEqual(b.body.partial, {}); assert.deepEqual(b.body.unavailable, []);
  });

  test("X2: a host-only reader can't filter or count by a Connect column they can't open (no empty / not empty oracle)", async () => {
    const P = w.people;
    const enc = (f) => encodeURIComponent(JSON.stringify(f));
    const base = `/api/v1/boards/${w.projects.id}/records`;
    for (const cmp of ["empty", "notEmpty"]) {
      const f = enc({ op: "and", rules: [{ key: "client", cmp }] });
      for (const url of [`${base}?filter=${f}`, `${base}?also=${f}`, `${base}/count?filter=${f}`, `${base}/count?also=${f}`, `${base}/count?filter=${enc({ op: "or", rules: [{ key: "note", cmp: "notEmpty" }, { key: "client", cmp }] })}`]) {
        const r = await w.as(P.reader, "GET", url);
        assert.equal(r.status, 400, `${url}: ${JSON.stringify(r.body)}`); assert.equal(r.body.error.code, "VALIDATION_ERROR");
        assert.match(r.body.error.message, /"Client" can't be filtered: you can't open the board it links to/);
        noTargetIds(w, r.body); assert.equal("total" in r.body, false); assert.equal("groups" in r.body, false);
      }
      // Same answer whether the record has links or not (the refusal doesn't depend on any data).
      const ok = await w.as(P.both, "GET", `${base}/count?filter=${f}`);
      assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(typeof ok.body.total, "number");
      assert.equal((await w.as(P.both, "GET", `${base}?filter=${f}`)).status, 200);
    }
    // Filters on other columns keep working for the host-only reader; a filter naming no restricted column is untouched.
    assert.equal((await w.as(P.reader, "GET", `${base}/count?filter=${enc({ op: "and", rules: [{ key: "serial", cmp: "notEmpty" }] })}`)).status, 200);
  });

  test("row 6: a revoked reader is restricted on the very next call (no cache)", async () => {
    const P = w.people;
    const members = (await w.as(P.owner, "GET", `/api/v1/workspaces/${w.wsB.id}/members`)).body.items;
    const bothId = (await w.as(P.both, "GET", "/api/v1/me")).body.user.id;
    const m = members.find((x) => x.userId === bothId);
    assert.equal((await w.as(P.owner, "DELETE", `/api/v1/workspaces/${w.wsB.id}/members/${m.id}`)).status, 200);
    const r = await w.as(P.both, "GET", `/api/v1/boards/${w.projects.id}/related?ids=${w.alpha.id}`);
    assert.ok(r.body.restricted.includes("client")); noTargetIds(w, r.body);
    noTargetIds(w, (await w.as(P.both, "GET", `/api/v1/records/${w.alpha.id}`)).body);
    const back = await w.as(P.owner, "POST", `/api/v1/workspaces/${w.wsB.id}/members`, { userId: bothId, role: "VIEWER" });
    assert.ok(back.status < 300, JSON.stringify(back.body));
    assert.equal((await w.as(P.both, "GET", `/api/v1/boards/${w.projects.id}/related?ids=${w.alpha.id}`)).body.restricted.length, 0, "granted again: visible on the next call");
  });

  test("row 7: activity (board feed and /activity) redacts Connect changes the reader can't view, and retired Connect columns", async () => {
    const P = w.people;
    assert.equal((await w.as(P.owner, "PATCH", `/api/v1/records/${w.alpha.id}`, { expectedVersion: (await w.alphaNow()).version, values: { client: [w.link.Acme, w.link.Globex, w.link.Initech] } })).status, 200);
    for (const url of [`/api/v1/boards/${w.projects.id}/activity`, "/api/v1/activity"]) {
      const mine = await w.as(P.reader, "GET", url);
      assert.equal(mine.status, 200, url);
      const change = mine.body.items.flatMap((e) => e.changes).find((c) => c.field === "values.client");
      assert.deepEqual(change, { field: "values.client", from: null, to: null, restricted: true }, url);
      noTargetIds(w, mine.body);
      const full = (await w.as(P.both, "GET", url)).body.items.flatMap((e) => e.changes).find((c) => c.field === "values.client");
      assert.ok(full.to.includes(w.link.Initech), `${url}: the reader of both sees the IDs`);
    }
    // A retired Connect column: its target is unknown, so its changes are redacted for everyone.
    const tmp = await w.addColumn(P.owner, w.projects, { key: "old", label: "Old", type: "connect", link: { boardId: w.clients.id }, multiple: true });
    assert.equal(tmp.status, 201);
    assert.equal((await w.as(P.owner, "PATCH", `/api/v1/records/${w.alpha.id}`, { expectedVersion: (await w.alphaNow()).version, values: { old: [w.link.Umbrella] } })).status, 200);
    assert.equal((await w.as(P.owner, "DELETE", `/api/v1/boards/${w.projects.id}/columns/old?expectedVersion=${(await w.board(P.owner, w.projects.id)).version}`)).status, 200);
    const owner = (await w.as(P.owner, "GET", `/api/v1/boards/${w.projects.id}/activity`)).body.items.flatMap((e) => e.changes).find((c) => c.field === "values.old");
    assert.deepEqual(owner, { field: "values.old", from: null, to: null, restricted: true });
  });

  test("row 7: activity redaction costs at most memberships + 2 board reads for a page of 100 entries", async () => {
    const W1 = new ObjectId(), W2 = new ObjectId(), USER = new ObjectId();
    const target = { _id: new ObjectId(), workspaceId: W2, columns: [] };
    const hosts = Array.from({ length: 5 }, () => ({ _id: new ObjectId(), workspaceId: W1, columns: [{ key: "c", type: "connect", link: { boardId: target._id.toHexString() } }], retiredColumns: [] }));
    const counts = { boards: 0, memberships: 0 };
    const all = [target, ...hosts];
    const repos = { memberships: { listForUser: async () => { counts.memberships += 1; return [{ workspaceId: W1, role: "VIEWER" }]; } }, boards: { findManyByIds: async (ids) => { counts.boards += 1; return all.filter((b) => ids.some((i) => i.equals(b._id))).map((b) => ({ ...b })); } } };
    const ctx = new Access(repos, {}).context({ userId: USER, kind: "entra", isSystemAdmin: false });
    const entries = Array.from({ length: 100 }, (_, i) => ({ _id: new ObjectId(), action: "record.updated", workspaceId: W1, boardId: hosts[i % 5]._id, changes: [{ field: "values.c", from: [], to: [new ObjectId().toHexString()] }] }));
    const out = await activityOut(ctx, entries);
    assert.ok(out.every((e) => e.changes[0].restricted === true));
    assert.deepEqual(counts, { boards: 2, memberships: 1 });
  });

  test("row 8: column and board changes re-read live-update access; event payloads stay IDs only", () => {
    for (const a of ["column.added", "column.deleted", "column.type_changed", "board.updated", "board.moved", "member.removed"]) assert.ok(ACCESS_ACTIONS.test(a), a);
    assert.equal(ACCESS_ACTIONS.test("record.updated"), false);
    const text = fs.readFileSync(path.join(__dirname, "../src/realtime/activity-stream.js"), "utf8");
    assert.equal(/changes|values/.test(text.replace(/\/\/.*$/gm, "")), false, "the stream never carries changes or values");
  });

  test("row 9: the API Explorer gives an API admin without target view null + restricted, in all three shapes", async () => {
    const P = w.people;
    const r = await w.as(P.editor, "GET", `/api/v1/me/api-explorer/boards/${w.projects.id}?record=${w.alpha.id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ex = r.body.example.items.find((i) => i.id === w.alpha.id);
    assert.equal(ex.values.client, null); assert.ok(ex.restricted.includes("client"));
    assert.equal(r.body.record.values.client, null); assert.ok(r.body.record.restricted.includes("client"));
    noTargetIds(w, r.body);
    const one = await w.as(P.editor, "GET", `/api/v1/me/api-explorer/boards/${w.projects.id}?columns=client`);
    assert.equal(one.status, 200); assert.ok(one.body.values.items.every((v) => v.value === null && v.restricted === true)); noTargetIds(w, one.body);
  });

  test("row 10: a host-only editor can't clear links ([] / \"\" / null, single and bulk); authorization before validation", async () => {
    const P = w.people;
    for (const value of [[], "", null]) {
      const cur = await w.alphaNow();
      assert.equal((await w.as(P.editor, "PATCH", `/api/v1/records/${w.alpha.id}`, { expectedVersion: cur.version, values: { client: value } })).status, 403, JSON.stringify(value));
      assert.equal((await w.as(P.editor, "PATCH", `/api/v1/boards/${w.projects.id}/records`, { items: [{ id: w.alpha.id, expectedVersion: cur.version, values: { client: value } }] })).status, 403, `bulk ${JSON.stringify(value)}`);
    }
    assert.equal((await w.alphaNow()).values.client.length, 3, "nothing cleared");
    const cur = await w.alphaNow();
    assert.equal((await w.as(P.editor, "PATCH", `/api/v1/records/${w.alpha.id}`, { expectedVersion: cur.version, values: { client: [w.link.Acme, "not-an-id"] } })).status, 403, "mixed valid and invalid: 403, not 400");
    assert.equal((await w.as(P.editor, "POST", `/api/v1/boards/${w.projects.id}/records`, { values: { serial: "Empty link", client: [] } })).status, 201, "create with an empty value stores nothing");
    assert.equal((await w.as(P.editor, "POST", `/api/v1/boards/${w.projects.id}/records`, { values: { serial: "Link", client: [w.link.Acme] } })).status, 403);
    assert.equal((await w.as(P.editor, "PATCH", `/api/v1/records/${w.alpha.id}`, { expectedVersion: cur.version, values: { note: "text only" } })).status, 200);
    // The reader of both boards can clear (and an invalid ID is then a 400 from validation).
    const both = await w.as(P.both, "PATCH", `/api/v1/records/${w.alpha.id}`, { expectedVersion: (await w.alphaNow()).version, values: { client: [w.link.Acme, "nope"] } });
    assert.equal(both.status, 400);
  });

  test("tolerant writes: stored IDs of deleted records are dropped and reported; only NEW unknown or archived IDs are refused", async () => {
    const P = w.people;
    // Initech is deleted on the linked board: Alpha still holds its ID.
    const initech = (await w.as(P.owner, "GET", `/api/v1/records/${w.link.Initech}`)).body.record;
    assert.equal((await w.as(P.owner, "DELETE", `/api/v1/records/${w.link.Initech}?expectedVersion=${initech.version}`)).status, 200);
    const cur = await w.alphaNow();
    assert.ok(cur.values.client.includes(w.link.Initech));
    const saved = await w.as(P.owner, "PATCH", `/api/v1/records/${w.alpha.id}`, { expectedVersion: cur.version, values: { client: [...cur.values.client, w.link.Umbrella] } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.droppedLinks, { client: 1 });
    assert.deepEqual(saved.body.record.values.client, [w.link.Acme, w.link.Globex, w.link.Umbrella]);
    const again = await w.alphaNow();
    assert.equal((await w.as(P.owner, "PATCH", `/api/v1/records/${w.alpha.id}`, { expectedVersion: again.version, values: { client: [...again.values.client, w.link.Initech] } })).status, 400, "a NEW link to a deleted record");
    const umb = (await w.as(P.owner, "GET", `/api/v1/records/${w.link.Umbrella}`)).body.record;
    assert.equal((await w.as(P.owner, "PATCH", `/api/v1/records/${w.link.Umbrella}`, { expectedVersion: umb.version, archived: true })).status, 200);
    const beta = await w.as(P.owner, "POST", `/api/v1/boards/${w.projects.id}/records`, { values: { serial: "Beta", client: [w.link.Umbrella] } });
    assert.equal(beta.status, 400, "no new link to an archived record");
    const keep = await w.alphaNow(); // Alpha keeps its existing link to the now archived record
    assert.equal((await w.as(P.owner, "PATCH", `/api/v1/records/${w.alpha.id}`, { expectedVersion: keep.version, values: { client: keep.values.client } })).status, 200);
  });

  test("row 11 (two-way): contract only; enforced in C3.2", { todo: "C3.2: host record.editValues + target board.view for added AND removed IDs + reciprocal record.editValues on the target, else the whole write is refused" }, () => {});
  test("row 11 (two-way): reciprocal activity on the target board, IDs only", { todo: "C3.2 / X4" }, () => {});

  test("sort: the server never orders by a Connect or Mirror column (corrected, not by hex IDs)", async () => {
    const P = w.people;
    const q = (orderBy) => w.as(P.owner, "GET", `/api/v1/boards/${w.projects.id}/records?orderBy=${encodeURIComponent(JSON.stringify(orderBy))}`);
    const byConnect = await q([{ key: "client", dir: "asc" }]), byMirror = await q([{ key: "total", dir: "desc" }]), byPosition = await q([{ key: "position", dir: "asc" }]);
    assert.equal(byConnect.status, 200); assert.equal(byMirror.status, 200);
    assert.deepEqual(byConnect.body.items.map((r) => r.id), byPosition.body.items.map((r) => r.id));
    assert.deepEqual(byMirror.body.items.map((r) => r.id), byPosition.body.items.map((r) => r.id));
    const filtered = await w.as(P.owner, "GET", `/api/v1/boards/${w.projects.id}/records/count?filter=${encodeURIComponent(JSON.stringify({ op: "and", rules: [{ key: "total", cmp: "gte", values: ["1"] }] }))}`);
    assert.equal(filtered.status, 400, "Mirror filters stay refused");
  });

  test("orphans: a Connect column with Mirrors can't be deleted; orphan, missing and mistyped sources are flagged, not deleted", async () => {
    const P = w.people;
    const del = await w.as(P.owner, "DELETE", `/api/v1/boards/${w.projects.id}/columns/client?expectedVersion=${(await w.board(P.owner, w.projects.id)).version}`);
    assert.equal(del.status, 400); assert.match(del.body.error.message, /Mirror/);
    assert.equal((await w.addColumn(P.owner, w.projects, { key: "sumstate", label: "Sum of state", type: "mirror", mirror: { via: "client", column: "state", show: "sum" } })).status, 201);
    assert.equal((await w.addColumn(P.owner, w.projects, { key: "gone", label: "Gone", type: "mirror", mirror: { via: "client", column: "nope", show: "list" } })).status, 201);
    // An orphan Mirror stored by an older release (its Connect column was deleted without the refusal).
    await w.app.db.collection("boards").updateOne({ _id: new ObjectId(w.projects.id) }, { $push: { columns: { key: "orph", label: "Orphan", type: "mirror", mirror: { via: "deleted_connect", column: "value", show: "sum" }, options: [] } } });
    const r = (await w.as(P.owner, "GET", `/api/v1/boards/${w.projects.id}/related?ids=${w.alpha.id}`)).body;
    assert.deepEqual(r.unavailableReasons, { sumstate: "source-type", gone: "source-missing", orph: "connect-missing" });
    assert.equal((await w.board(P.owner, w.projects.id)).columns.some((c) => c.key === "orph"), true, "flagged, never deleted");
  });

  test("truncation: more than 100 links in a stored cell is reported as partial, never silently cut", async () => {
    const P = w.people;
    const many = [w.link.Acme, ...Array.from({ length: LIMITS.perCell }, () => new ObjectId().toHexString())];
    await w.app.db.collection("records").updateOne({ _id: new ObjectId(w.alpha.id) }, { $set: { "values.client": many } });
    const r = (await w.as(P.owner, "GET", `/api/v1/boards/${w.projects.id}/related?ids=${w.alpha.id}`)).body;
    assert.equal(r.partial.client, "cell-limit");
    // The Mirrors computed through it are incomplete too: flagged, never a truncated sum / count that looks complete.
    assert.equal(r.partial.total, "cell-limit"); assert.equal(r.partial.n, "cell-limit");
    assert.equal(r.linked.client[w.link.Acme].name, "Acme");
  });

  test("route inventory: every record or activity leaving routes/ goes through the S0-B helpers", () => {
    const dir = path.join(__dirname, "../src/routes");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      const text = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\/.*$/gm, "");
      assert.equal(/\brecordToApi\(|\bactivityToApi\(|\.map\(recordToApi\)|\.map\(activityToApi\)/.test(text), false, f);
    }
  });
});

describe("S0-B under development_shared (parity: everything stays visible)", () => {
  const w = world({ accessPolicy: "development_shared" });
  before(() => w.setup());
  after(async () => { await w.app?.close(); });
  test("the host-only member sees IDs, names, values and history exactly as before", async () => {
    const P = w.people;
    const row = (await w.as(P.reader, "GET", `/api/v1/boards/${w.projects.id}/records`)).body.items.find((r) => r.id === w.alpha.id);
    assert.deepEqual(row.values.client, [w.link.Acme, w.link.Globex]); assert.equal(row.restricted, undefined);
    const rel = (await w.as(P.reader, "GET", `/api/v1/boards/${w.projects.id}/related?ids=${w.alpha.id}`)).body;
    assert.deepEqual(rel.restricted, []); assert.equal(rel.values[w.alpha.id].total, 30);
    assert.equal((await w.as(P.editor, "PATCH", `/api/v1/records/${w.alpha.id}`, { expectedVersion: (await w.alphaNow()).version, values: { client: [] } })).status, 200, "under shared access the editor can open the target");
    const change = (await w.as(P.reader, "GET", `/api/v1/boards/${w.projects.id}/activity`)).body.items.flatMap((e) => e.changes).find((c) => c.field === "values.client");
    assert.deepEqual(change.from, [w.link.Acme, w.link.Globex]);
  });
});

describe("Connect / Mirror fail CLOSED when the record link index isn't ready", () => {
  // The data is set up while the index is ready; then the check result turns to "not ready" (as after a failed startup check).
  const status = new RecordLinkStatus({ ok: true });
  const w = world({ relations: status });
  before(async () => { await w.setup(); status.set({ ok: false, reason: "index-missing:to_record" }); });
  after(async () => { await w.app?.close(); });
  test("frozen: Connect writes 503, /related unresolved with a reason, /features says so; every other board function works", async () => {
    const P = w.people;
    const cur = await w.alphaNow();
    const write = await w.as(P.owner, "PATCH", `/api/v1/records/${w.alpha.id}`, { expectedVersion: cur.version, values: { client: [] } });
    assert.equal(write.status, 503); assert.equal(write.body.error.code, "RELATIONS_UNAVAILABLE");
    assert.equal((await w.addColumn(P.owner, w.projects, { key: "c2", label: "C2", type: "connect", link: { boardId: w.clients.id } })).status, 503);
    const rel = (await w.as(P.owner, "GET", `/api/v1/boards/${w.projects.id}/related?ids=${w.alpha.id}`)).body;
    assert.equal(rel.status, "unavailable"); assert.equal(rel.unavailableReasons.client, "relations-unavailable"); assert.deepEqual(rel.values[w.alpha.id] ?? {}, {});
    assert.equal((await w.as(P.owner, "GET", "/api/v1/features")).body.features.connectStatus, "unavailable");
    // Unrelated functions keep working: text edits, new records, new columns, lists, deletes.
    assert.equal((await w.as(P.owner, "PATCH", `/api/v1/records/${w.alpha.id}`, { expectedVersion: cur.version, values: { note: "still works" } })).status, 200);
    assert.equal((await w.as(P.owner, "POST", `/api/v1/boards/${w.projects.id}/records`, { values: { serial: "Plain" } })).status, 201);
    assert.equal((await w.addColumn(P.owner, w.projects, { key: "txt", label: "Txt", type: "text" })).status, 201);
    assert.equal((await w.as(P.owner, "GET", `/api/v1/boards/${w.projects.id}/records`)).status, 200);
    assert.equal((await w.as(P.owner, "GET", `/api/v1/boards/${w.clients.id}/records`)).status, 200);
  });
});

describe("partial flags reach the Mirrors that follow a truncated Connect column", () => {
  test("linked-limit: more than 10,000 linked IDs in one request flags the Connect column AND its Mirrors", async () => {
    const W1 = new ObjectId(), USER = new ObjectId();
    const t1 = { _id: new ObjectId(), workspaceId: W1, columns: [{ key: "serial", type: "text" }, { key: "v", type: "number" }], groups: [] };
    const host = { _id: new ObjectId(), workspaceId: W1, columns: [{ key: "a", type: "connect", link: { boardId: t1._id.toHexString() } }, { key: "m", type: "mirror", mirror: { via: "a", column: "v", show: "count" } }, { key: "s", type: "mirror", mirror: { via: "a", column: "v", show: "sum" } }] };
    const rows = Array.from({ length: LIMITS.records }, () => ({ _id: new ObjectId(), values: { a: Array.from({ length: LIMITS.perCell }, () => new ObjectId().toHexString()) } }));
    const repos = {
      memberships: { listForUser: async () => [{ workspaceId: W1, role: "VIEWER" }] },
      boards: { findManyByIds: async (ids) => [t1].filter((b) => ids.some((i) => i.equals(b._id))).map((b) => ({ ...b })) },
      records: { findByIds: async (boardId, ids) => (boardId.equals(host._id) ? rows.filter((d) => ids.some((i) => i.equals(d._id))) : ids.map((i) => ({ _id: i, values: { serial: "x", v: 1 } }))) }
    };
    const access = new Access(repos, { policy: "role_based" });
    const out = await new RelatedService({ repos, access }).resolve(access.context({ userId: USER, kind: "entra", isSystemAdmin: false }), host, rows.map((r) => r._id.toHexString()));
    assert.deepEqual(out.partial, { a: "linked-limit", m: "linked-limit", s: "linked-limit" });
  });
});

describe("query counts (no N+1): /related is 3 + B reads", () => {
  test("200 rows × 3 Connect columns into 2 boards = 5 reads (memberships, boards $in, host records, 2 × linked records)", async () => {
    const W1 = new ObjectId(), W2 = new ObjectId(), USER = new ObjectId();
    const t1 = { _id: new ObjectId(), workspaceId: W2, columns: [{ key: "serial", type: "text" }, { key: "v", type: "number" }], groups: [] };
    const t2 = { _id: new ObjectId(), workspaceId: W1, columns: [{ key: "serial", type: "text" }], groups: [] };
    const host = { _id: new ObjectId(), workspaceId: W1, columns: [{ key: "a", type: "connect", link: { boardId: t1._id.toHexString() } }, { key: "b", type: "connect", link: { boardId: t1._id.toHexString() } }, { key: "c", type: "connect", link: { boardId: t2._id.toHexString() } }, { key: "m", type: "mirror", mirror: { via: "a", column: "v", show: "sum" } }] };
    const linked = { [t1._id.toHexString()]: Array.from({ length: 5 }, () => ({ _id: new ObjectId(), values: { serial: "x", v: 1 } })), [t2._id.toHexString()]: [{ _id: new ObjectId(), values: { serial: "y" } }] };
    const rows = Array.from({ length: 200 }, () => ({ _id: new ObjectId(), values: { a: linked[t1._id.toHexString()].map((d) => d._id.toHexString()), b: [linked[t1._id.toHexString()][0]._id.toHexString()], c: [linked[t2._id.toHexString()][0]._id.toHexString()] } }));
    for (const shared of [false, true]) {
      const counts = { memberships: 0, boards: 0, records: 0 };
      const repos = {
        memberships: { listForUser: async () => { counts.memberships += 1; return [{ workspaceId: W1, role: "VIEWER" }, { workspaceId: W2, role: "VIEWER" }]; } },
        boards: { findManyByIds: async (ids) => { counts.boards += 1; return [t1, t2].filter((b) => ids.some((i) => i.equals(b._id))).map((b) => ({ ...b })); } },
        records: { findByIds: async (boardId, ids) => { counts.records += 1; const pool = boardId.equals(host._id) ? rows : linked[boardId.toHexString()] || []; return pool.filter((d) => ids.some((i) => i.equals(d._id))); } }
      };
      const access = new Access(repos, { policy: shared ? "development_shared" : "role_based" });
      const ctx = access.context({ userId: USER, kind: "entra", isSystemAdmin: false });
      const out = await new RelatedService({ repos, access }).resolve(ctx, host, rows.map((r) => r._id.toHexString()));
      assert.equal(out.values[rows[0]._id.toHexString()].m, 5);
      assert.deepEqual(out.restricted, []);
      assert.deepEqual(counts, { memberships: 1, boards: 1, records: 3 }); // 3 + B with B = 2, both policies
    }
  });
});
