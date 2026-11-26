// Column System S0-A (D-S0-4, D-S0-5) through the real app with Entra sign-in on the fake MongoDB. Synthetic people and data.
//   - Link / Email / Phone rules on every session write path: create, PATCH, POST and PATCH batches, form submissions;
//   - values stored before the rule stay readable and unchanged, can't be saved again (even unchanged), and other edits work;
//   - the token API returns values exactly as stored, derives no URL, and returns Connect IDs only for boards the token reads.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { startEntraApp, SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

const KEY = crypto.randomBytes(32);
const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "site", label: "Site", type: "link" }, { key: "mail", label: "Mail", type: "email" }, { key: "tel", label: "Phone", type: "phone" }, { key: "notes", label: "Notes", type: "text" }];
const UNSAFE = "javascript:alert('s0a')";

let app, issuer, owner, ws, board, clients, projects;
const sessions = new Map();
const as = async (p, method, url, body) => { if (!sessions.has(p.oid)) { const c = new SessionClient(app.url, app.entra.appOrigin); assert.equal((await c.signIn(p)).status, 201); sessions.set(p.oid, c); } return sessions.get(p.oid).request(method, url, body); };
const records = () => app.db.collection("records");
const external = async (token, url) => { const res = await fetch(`${app.url}/api/v1/external${url}`, { headers: { Authorization: `Bearer ${token}` } }); const text = await res.text(); return { status: res.status, body: text ? JSON.parse(text) : null, text }; };
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();
const tokenFor = async (boardIds) => { const res = await as(owner, "POST", "/api/v1/me/api-tokens", { name: "S0A key", scopes: ["read"], expiresAt: inDays(30), boardIds }); assert.equal(res.status, 201, res.text); return res.body.secret; };
// A value that exists from before the rule: written straight into the database, as older releases could.
const legacy = async (values) => {
  const made = (await as(owner, "POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Legacy" } })).body.record;
  await records().updateOne({ _id: new ObjectId(made.id) }, { $set: Object.fromEntries(Object.entries(values).map(([k, v]) => [`values.${k}`, v])) });
  return made;
};

before(async () => {
  issuer = await createTokenIssuer();
  app = await startEntraApp({ issuer, apiTokens: { key: KEY, issuePerHour: 1000, maxActive: 1000 } });
  owner = issuer.person("Olive Owner", { admin: true });
  const service = app.dataLayer.services.apiTokens;
  service.adminObjectIds = Object.freeze([owner.oid.toLowerCase()]);
  ws = (await as(owner, "POST", "/api/v1/workspaces", { name: "S0A space" })).body.workspace;
  board = (await as(owner, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Contacts", columns: COLUMNS })).body.board;
  clients = (await as(owner, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Clients", columns: [{ key: "serial", label: "Client", type: "text", required: true }] })).body.board;
  projects = (await as(owner, "POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Projects", columns: [{ key: "serial", label: "Project", type: "text", required: true }] })).body.board;
});
after(async () => { await app?.close(); });

describe("new writes", () => {
  test("create, PATCH and both batches refuse unsafe values with 400 { field, reason }, never echoing the value", async () => {
    const create = await as(owner, "POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "A", site: UNSAFE } });
    assert.equal(create.status, 400); assert.equal(create.body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(create.body.error.details, { field: "site", reason: "scheme" });
    assert.ok(!create.text.includes("alert"), "the value is not echoed");
    for (const [values, field] of [[{ site: "JaVaScRiPt:alert(1)" }, "site"], [{ site: "&#106;avascript:alert(1)" }, "site"], [{ site: "java%0Ascript:alert(1)" }, "site"], [{ site: "data:text/html,x" }, "site"], [{ mail: "javascript:alert(1)//@x.com" }, "mail"], [{ tel: "javascript:alert(1)" }, "tel"]])
      assert.equal((await as(owner, "POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "A", ...values } })).body.error?.details?.field, field, JSON.stringify(values));
    const batch = await as(owner, "POST", `/api/v1/boards/${board.id}/records/batch`, { records: [{ values: { serial: "B1", site: "https://ok.example" } }, { values: { serial: "B2", site: "vbscript:x" } }] });
    assert.equal(batch.status, 400); assert.match(batch.body.error.message, /^Record 2: /);
    const made = (await as(owner, "POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "C" } })).body.record;
    assert.equal((await as(owner, "PATCH", `/api/v1/records/${made.id}`, { expectedVersion: 1, values: { site: "file:///etc/passwd" } })).status, 400);
    assert.equal((await as(owner, "PATCH", `/api/v1/boards/${board.id}/records`, { items: [{ id: made.id, expectedVersion: 1, values: { tel: "tel:javascript:x" } }] })).status, 400);
    assert.equal(await records().countDocuments({ boardId: new ObjectId(board.id), "values.serial": { $in: ["A", "B1", "B2"] } }), 0, "nothing written");
  });
  test("safe values are stored, normalised (trimmed; mailto: / tel: prefixes removed from Email / Phone)", async () => {
    const res = await as(owner, "POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Good", site: " https://example.com/a ", mail: "mailto:a@example.com", tel: "tel:+63 917 123 4567", notes: UNSAFE } });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.body.record.values, { serial: "Good", site: "https://example.com/a", mail: "a@example.com", tel: "+63 917 123 4567", notes: UNSAFE }, "text columns are untouched");
    assert.equal((await as(owner, "POST", `/api/v1/boards/${board.id}/records`, { values: { serial: "Schemeless", site: "www.example.com" } })).body.record.values.site, "www.example.com");
  });
  test("form submissions use the same rules", async () => {
    const form = await as(owner, "POST", `/api/v1/boards/${board.id}/forms`, { name: "Contact form", status: "published", fields: [{ key: "serial" }, { key: "site" }, { key: "mail" }], confirmation: "Thanks" });
    assert.equal(form.status, 201, form.text);
    const bad = await as(owner, "POST", `/api/v1/forms/${form.body.form.id}/submit`, { submissionKey: crypto.randomUUID(), values: { serial: "F1", site: UNSAFE } });
    assert.equal(bad.status, 400); assert.equal(bad.body.error.details?.field, "site");
    const good = await as(owner, "POST", `/api/v1/forms/${form.body.form.id}/submit`, { submissionKey: crypto.randomUUID(), values: { serial: "F2", site: "https://example.com", mail: "f@example.com" } });
    assert.equal(good.status, 201, good.text); assert.equal(good.body.record.values.site, "https://example.com");
  });
});

describe("values stored before the rule", () => {
  test("are readable unchanged, can't be saved again (even unchanged), and other edits still work", async () => {
    const made = await legacy({ site: UNSAFE, tel: "N/A" });
    const read = await as(owner, "GET", `/api/v1/records/${made.id}`);
    assert.equal(read.status, 200); assert.equal(read.body.record.values.site, UNSAFE, "never rewritten on read");
    let version = read.body.record.version;
    const same = await as(owner, "PATCH", `/api/v1/records/${made.id}`, { expectedVersion: version, values: { site: UNSAFE } });
    assert.equal(same.status, 400); assert.equal(same.body.error.details.field, "site");
    assert.equal((await as(owner, "PATCH", `/api/v1/boards/${board.id}/records`, { items: [{ id: made.id, expectedVersion: version, values: { site: UNSAFE, notes: "x" } }] })).status, 400, "batch too");
    const other = await as(owner, "PATCH", `/api/v1/records/${made.id}`, { expectedVersion: version, values: { notes: "edited", mail: "a@example.com" } });
    assert.equal(other.status, 200, other.text); assert.equal(other.body.record.values.site, UNSAFE, "untouched by an edit of other cells");
    version = other.body.record.version;
    const fixed = await as(owner, "PATCH", `/api/v1/records/${made.id}`, { expectedVersion: version, values: { site: "https://fixed.example" } });
    assert.equal(fixed.status, 200); assert.equal(fixed.body.record.values.site, "https://fixed.example");
    const cleared = await as(owner, "PATCH", `/api/v1/records/${made.id}`, { expectedVersion: version + 1, values: { tel: "" } });
    assert.equal(cleared.status, 200, "clearing is always allowed");
    assert.equal((await records().findOne({ _id: new ObjectId(made.id) })).values.site, "https://fixed.example");
  });
});

describe("token API", () => {
  test("values come back exactly as stored; no URL or href field is derived", async () => {
    const made = await legacy({ site: UNSAFE });
    const token = await tokenFor([board.id]);
    const rec = await external(token, `/records/${made.id}`);
    assert.equal(rec.status, 200, rec.text);
    assert.equal(rec.body.record.values.site, UNSAFE, "contract unchanged");
    assert.deepEqual(Object.keys(rec.body.record).sort(), ["archived", "boardId", "createdAt", "groupId", "id", "position", "updatedAt", "values", "version", "workspaceId"], "no derived or new fields for a board without restricted columns");
    const cell = await external(token, `/boards/${board.id}/records/${made.id}/columns/site`);
    assert.deepEqual(Object.keys(cell.body.value).sort(), ["boardId", "columnId", "columnName", "columnType", "recordId", "updatedAt", "value"]);
    const columns = await external(token, `/boards/${board.id}/columns`);
    assert.ok(!/"(url|href)"/i.test(columns.text) && !/"(url|href)"/i.test(rec.text));
    assert.equal((await fetch(`${app.url}/api/v1/external/records/${made.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}` } })).status, 405, "the token API is read-only");
  });

  test("D-S0-5: Connect IDs only for a linked board the token reads; otherwise null + restricted, with no IDs or count", async () => {
    const add = async (b, column) => as(owner, "POST", `/api/v1/boards/${b.id}/columns`, { expectedVersion: (await as(owner, "GET", `/api/v1/boards/${b.id}`)).body.board.version, column });
    assert.equal((await add(projects, { key: "client", label: "Client", type: "connect", link: { boardId: clients.id }, multiple: true })).status, 201);
    const acme = (await as(owner, "POST", `/api/v1/boards/${clients.id}/records`, { values: { serial: "Acme" } })).body.record;
    const p = (await as(owner, "POST", `/api/v1/boards/${projects.id}/records`, { values: { serial: "Alpha", client: [acme.id] } }));
    assert.equal(p.status, 201, p.text);
    const pid = p.body.record.id;

    const narrow = await tokenFor([projects.id]);
    const list = await external(narrow, `/boards/${projects.id}/records`);
    assert.equal(list.status, 200);
    assert.equal(list.body.items[0].values.client, null); assert.deepEqual(list.body.items[0].values.serial, "Alpha");
    assert.deepEqual(list.body.items[0].restricted, ["client"]);
    for (const url of [`/boards/${projects.id}/records`, `/records/${pid}`, `/boards/${projects.id}/columns/client/values`, `/boards/${projects.id}/records/${pid}/columns/client`, `/boards/${projects.id}/records?columns=client`])
      assert.ok(!(await external(narrow, url)).text.includes(acme.id), url);
    assert.equal((await external(narrow, `/boards/${projects.id}/records/${pid}/columns/client`)).body.value.restricted, true);
    assert.equal((await external(narrow, `/boards/${projects.id}/columns/client/values`)).body.items[0].value, null);
    assert.equal((await external(narrow, `/boards/${projects.id}/records?columns=serial`)).body.items[0].restricted, undefined, "only requested columns are named");

    const wide = await tokenFor([projects.id, clients.id]);
    const full = await external(wide, `/records/${pid}`);
    assert.deepEqual(full.body.record.values.client, [acme.id], "the linked board is readable: IDs as stored");
    assert.equal(full.body.record.restricted, undefined);
  });
});
