// S0-B contract parity: for boards WITHOUT Connect / Mirror, and for Connect boards the caller CAN open, the session API, the
// external token API and the API Explorer answer exactly as the release before S0-B (the authz foundation, PARITY_REF) did.
//
// Cross-version: the SAME fake MongoDB is served first by this code, then by PARITY_REF (its files read from git into
// node_modules/.cache, or taken from JARC_PARITY_SOURCE, a checkout of that release). Reads must be deep-equal; writes are made
// with identical bodies on each release and compared after masking IDs, times and versions. Intended differences are listed in
// INTENDED and asserted on their own. Offline, synthetic values only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { startEntraApp, SessionClient } = require("./helpers");
const { FakeMongoClient } = require("./support/fake-mongo");
const { createTokenIssuer } = require("./support/entra-tokens");

const PARITY_REF = process.env.JARC_PARITY_REF || "f3c3ce4"; // authz foundation, the base of S0-B
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const NEEDED = ["server/src", "server/package.json", "server/tests/helpers.js", "server/tests/support", "site"];

function paritySource() {
  if (process.env.JARC_PARITY_SOURCE) return path.resolve(process.env.JARC_PARITY_SOURCE);
  const dir = path.join(REPO_ROOT, "server", "node_modules", ".cache", `jarc-parity-${PARITY_REF.replace(/[^0-9A-Za-z_-]/g, "")}`);
  if (fs.existsSync(path.join(dir, ".complete"))) return dir;
  const git = (args, input) => execFileSync("git", args, { cwd: REPO_ROOT, input, maxBuffer: 256 * 1024 * 1024 });
  const listing = git(["ls-tree", "-r", PARITY_REF, "--", ...NEEDED]).toString("utf8").split("\n").filter(Boolean)
    .map((line) => { const [meta, file] = line.split("\t"); const [, type, sha] = meta.split(" "); return { type, sha, file }; })
    .filter((e) => e.type === "blob");
  const out = git(["cat-file", "--batch"], listing.map((e) => e.sha).join("\n") + "\n");
  let at = 0;
  for (const entry of listing) {
    const eol = out.indexOf(10, at);
    const size = Number(out.subarray(at, eol).toString("utf8").split(" ")[2]);
    const target = path.join(dir, ...entry.file.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, out.subarray(eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  fs.writeFileSync(path.join(dir, ".complete"), PARITY_REF);
  return dir;
}

// Masks what legitimately differs between two writes made with the same body: generated IDs, times, versions, positions.
const HEXID = /^[0-9a-f]{24}$/;
const mask = (v, k = "") => {
  if (Array.isArray(v)) return v.map((x) => mask(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([key, x]) => [HEXID.test(key) ? "<id>" : key, mask(x, key)]));
  if (typeof v === "string" && HEXID.test(v)) return "<id>";
  if (typeof v === "string" && /^grp_/.test(v)) return "<group>";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return "<time>";
  if (["version", "position", "updatedAt", "createdAt", "at", "numericId", "publicId"].includes(k) && v !== null) return "<n>";
  return v;
};

// INTENDED differences (S0-B), applied to the older release's answers before comparing, and asserted on their own below:
//  I1  token API and API Explorer: a Mirror cell is always null (the older release returned the stored placeholder, e.g. "").
//  I2  /related: two new keys, unavailableReasons {} and partial {} (additive; restricted [] and unavailable [] unchanged).
//  (Only when something IS restricted or dropped, which this suite never has: restrictedColumns on record pages, droppedLinks on
//  writes, restricted lists on records / cells, connectStatus on /features. Asserted absent here.)
const MIRRORS = ["total"];
const isTokenOrExplorer = (name) => name.startsWith("token ") || name.includes("explorer");
function intendedOld(name, r) {
  if (!isTokenOrExplorer(name)) return r;
  return JSON.parse(JSON.stringify(r), function (k, x) {
    if (k === "values" && x && typeof x === "object" && !Array.isArray(x)) { const v = { ...x }; for (const m of MIRRORS) if (m in v) v[m] = null; return v; }
    if (x && typeof x === "object" && MIRRORS.includes(x.columnId) && "value" in x) return { ...x, value: null };
    return x;
  });
}
function intendedNew(name, r) {
  if (!/related/.test(name) || !r?.body) return r;
  const { unavailableReasons, partial, ...rest } = r.body;
  return { ...r, body: rest };
}

describe(`S0-B keeps the non-restricted contracts of ${PARITY_REF} (same database, both releases)`, () => {
  const fake = new FakeMongoClient();
  const key = crypto.randomBytes(32);
  const W = {};
  let source, issuer, P, secret;
  const snaps = {};

  const open = async (helpers) => {
    const app = await helpers.startEntraApp({ issuer, fake, apiTokens: { key, issuePerHour: 1000, maxActive: 1000, adminObjectIds: [P.owner.oid.toLowerCase(), P.both.oid.toLowerCase()] } });
    const sessions = new Map();
    const as = async (p, method, url, body) => {
      if (!sessions.has(p.oid)) { const c = new SessionClient(app.url, app.entra.appOrigin); assert.equal((await c.signIn(p)).status, 201); sessions.set(p.oid, c); }
      const r = await sessions.get(p.oid).request(method, url, body);
      return { status: r.status, body: r.body };
    };
    const token = async (p) => { const res = await fetch(`${app.url}/api/v1/external${p}`, { headers: { Authorization: `Bearer ${secret}` } }); return { status: res.status, body: await res.json() }; };
    return { app, as, token };
  };

  // Every read of the contract, for a full-access owner and for "both" (MEMBER of Hosts, VIEWER of Targets: can open Clients).
  const reads = async ({ as, token }) => {
    const out = {};
    for (const [who, p] of [["owner", P.owner], ["both", P.both]]) {
      const r = (name, url) => as(p, "GET", url).then((x) => { out[`${who} ${name}`] = x; });
      for (const b of ["plain", "projects"]) {
        const id = W[b].id;
        await r(`board ${b}`, `/api/v1/boards/${id}`);
        await r(`records ${b}`, `/api/v1/boards/${id}/records`);
        await r(`records ${b} limit 2`, `/api/v1/boards/${id}/records?limit=2`);
        await r(`count ${b}`, `/api/v1/boards/${id}/records/count`);
        await r(`activity ${b}`, `/api/v1/boards/${id}/activity`);
        await r(`explorer ${b}`, `/api/v1/me/api-explorer/boards/${id}?record=${W[`${b}Rec`].id}`);
      }
      await r("records plain filtered+sorted", `/api/v1/boards/${W.plain.id}/records?filter=${encodeURIComponent(JSON.stringify({ op: "and", rules: [{ key: "state", cmp: "in", values: ["Open"] }] }))}&orderBy=${encodeURIComponent(JSON.stringify([{ key: "qty", dir: "desc" }]))}`);
      await r("records projects filter on Connect (can open)", `/api/v1/boards/${W.projects.id}/records?filter=${encodeURIComponent(JSON.stringify({ op: "and", rules: [{ key: "client", cmp: "notEmpty" }] }))}`);
      await r("count projects filter on Connect (can open)", `/api/v1/boards/${W.projects.id}/records/count?filter=${encodeURIComponent(JSON.stringify({ op: "and", rules: [{ key: "client", cmp: "notEmpty" }] }))}`);
      await r("records projects sorted by text", `/api/v1/boards/${W.projects.id}/records?orderBy=${encodeURIComponent(JSON.stringify([{ key: "serial", dir: "asc" }]))}`);
      await r("record plain", `/api/v1/records/${W.plainRec.id}`);
      await r("record projects", `/api/v1/records/${W.projectsRec.id}`);
      await r("explorer plain one column", `/api/v1/me/api-explorer/boards/${W.plain.id}?columns=qty`);
      await r("explorer projects one Connect column", `/api/v1/me/api-explorer/boards/${W.projects.id}?columns=client`);
      await r("activity", "/api/v1/activity");
      await r("workspace boards", `/api/v1/workspaces/${W.wsA.id}/boards`);
      await r("search", "/api/v1/search?q=Alpha");
      await r("search global", "/api/v1/search/global?q=Alpha");
    }
    for (const b of ["plain", "projects"]) {
      const id = W[b].id, rec = W[`${b}Rec`].id;
      for (const p of [`/boards/${id}`, `/boards/${id}/columns`, `/boards/${id}/groups`, `/boards/${id}/records`, `/records/${rec}`, `/boards/${id}/records?limit=1`]) out[`token ${p.replace(id, b).replace(rec, "rec")}`] = await token(p);
      for (const c of (b === "plain" ? ["qty", "state", "due"] : ["client", "serial"])) {
        out[`token column ${b}.${c}`] = await token(`/boards/${id}/columns/${c}`);
        out[`token values ${b}.${c}`] = await token(`/boards/${id}/columns/${c}/values`);
        out[`token cell ${b}.${c}`] = await token(`/boards/${id}/records/${rec}/columns/${c}`);
      }
    }
    out["token me"] = await token("/me");
    out["token workspaces"] = await token("/workspaces");
    return out;
  };

  // The same writes on each release (masked afterwards): create, batch, bulk update, single update, Connect link by "both".
  const writes = async ({ as }, tag) => {
    const out = {};
    const one = await as(P.both, "POST", `/api/v1/boards/${W.plain.id}/records`, { values: { serial: `W-${tag}`, qty: 3, state: "Open", due: "2026-01-02" } });
    out["create plain"] = one;
    out["batch plain"] = await as(P.both, "POST", `/api/v1/boards/${W.plain.id}/records/batch`, { records: [{ values: { serial: `B1-${tag}` } }, { values: { serial: `B2-${tag}`, qty: 9 } }] });
    out["bulk plain"] = await as(P.both, "PATCH", `/api/v1/boards/${W.plain.id}/records`, { items: [{ id: one.body.record.id, expectedVersion: one.body.record.version, values: { qty: 4 } }] });
    const cur = (await as(P.both, "GET", `/api/v1/records/${one.body.record.id}`)).body.record;
    out["patch plain"] = await as(P.both, "PATCH", `/api/v1/records/${one.body.record.id}`, { expectedVersion: cur.version, values: { state: "Done" } });
    const pr = await as(P.both, "POST", `/api/v1/boards/${W.projects.id}/records`, { values: { serial: `P-${tag}`, client: [W.link.Acme] } });
    out["create projects with link"] = pr;
    out["patch projects link"] = await as(P.both, "PATCH", `/api/v1/records/${pr.body.record.id}`, { expectedVersion: pr.body.record.version, values: { client: [W.link.Acme, W.link.Globex] } });
    out["batch projects with link"] = await as(P.both, "POST", `/api/v1/boards/${W.projects.id}/records/batch`, { records: [{ values: { serial: `PB-${tag}`, client: [W.link.Globex] } }] });
    out["related projects"] = await as(P.both, "GET", `/api/v1/boards/${W.projects.id}/related?ids=${pr.body.record.id}`);
    // Column writes on a board of this release's own (so the other release's added column never shows in these rows).
    const own = (await as(P.owner, "POST", `/api/v1/workspaces/${W.wsA.id}/boards`, { name: "Columns", columns: [{ key: "serial", label: "Item", type: "text", required: true }] })).body.board;
    out["create board"] = { status: 201, body: own };
    out["add column"] = await as(P.owner, "POST", `/api/v1/boards/${own.id}/columns`, { expectedVersion: own.version, column: { key: "extra", label: "Extra", type: "number" } });
    const last = (await as(P.both, "GET", `/api/v1/records/${one.body.record.id}`)).body.record;
    out["delete record"] = await as(P.both, "POST", `/api/v1/boards/${W.plain.id}/records/delete`, { records: [{ id: last.id, expectedVersion: last.version }] });
    return mask(JSON.parse(JSON.stringify(out).split(`-${tag}`).join("-T")));
  };

  before(async () => {
    source = paritySource();
    issuer = await createTokenIssuer();
    P = { owner: issuer.person("Owner Person", { admin: true }), both: issuer.person("Both Reader") };
    const s = await open(require("./helpers"));
    try {
      const { as } = s;
      W.wsA = (await as(P.owner, "POST", "/api/v1/workspaces", { name: "Hosts" })).body.workspace;
      W.wsB = (await as(P.owner, "POST", "/api/v1/workspaces", { name: "Targets" })).body.workspace;
      const uid = (await as(P.both, "GET", "/api/v1/me")).body.user.id;
      assert.equal((await as(P.owner, "POST", `/api/v1/workspaces/${W.wsA.id}/members`, { userId: uid, role: "MEMBER" })).status, 201);
      assert.equal((await as(P.owner, "POST", `/api/v1/workspaces/${W.wsB.id}/members`, { userId: uid, role: "VIEWER" })).status, 201);
      W.plain = (await as(P.owner, "POST", `/api/v1/workspaces/${W.wsA.id}/boards`, { name: "Plain", columns: [{ key: "serial", label: "Item", type: "text", required: true }, { key: "qty", label: "Qty", type: "number" }, { key: "state", label: "State", type: "status", options: ["Open", "Done"] }, { key: "due", label: "Due", type: "date" }, { key: "ok", label: "OK", type: "checkbox" }] })).body.board;
      const recs = (await as(P.owner, "POST", `/api/v1/boards/${W.plain.id}/records/batch`, { records: [["Alpha one", 5, "Open", "2026-03-01"], ["Beta", 2, "Done", null], ["Gamma", 8, "Open", "2026-01-15"]].map(([serial, qty, state, due]) => ({ values: { serial, qty, state, ...(due ? { due } : {}) } })) })).body.items;
      W.plainRec = recs[0];
      W.clients = (await as(P.owner, "POST", `/api/v1/workspaces/${W.wsB.id}/boards`, { name: "Clients", columns: [{ key: "serial", label: "Client", type: "text", required: true }, { key: "value", label: "Value", type: "number" }] })).body.board;
      const made = (await as(P.owner, "POST", `/api/v1/boards/${W.clients.id}/records/batch`, { records: ["Acme", "Globex"].map((serial, i) => ({ values: { serial, value: (i + 1) * 10 } })) })).body.items;
      W.link = Object.fromEntries(made.map((r) => [r.values.serial, r.id]));
      W.projects = (await as(P.owner, "POST", `/api/v1/workspaces/${W.wsA.id}/boards`, { name: "Projects", columns: [{ key: "serial", label: "Project", type: "text", required: true }] })).body.board;
      const ver = async (b) => (await as(P.owner, "GET", `/api/v1/boards/${b.id}`)).body.board.version;
      assert.equal((await as(P.owner, "POST", `/api/v1/boards/${W.projects.id}/columns`, { expectedVersion: await ver(W.projects), column: { key: "client", label: "Client", type: "connect", link: { boardId: W.clients.id }, multiple: true } })).status, 201);
      assert.equal((await as(P.owner, "POST", `/api/v1/boards/${W.projects.id}/columns`, { expectedVersion: await ver(W.projects), column: { key: "total", label: "Total", type: "mirror", mirror: { via: "client", column: "value", show: "sum" } } })).status, 201);
      W.projectsRec = (await as(P.owner, "POST", `/api/v1/boards/${W.projects.id}/records`, { values: { serial: "Alpha project", client: [W.link.Acme, W.link.Globex] } })).body.record;
      await as(P.owner, "POST", `/api/v1/boards/${W.projects.id}/records`, { values: { serial: "Beta project" } });
      // Activity with a Connect change the reader may see.
      const cur = (await as(P.owner, "GET", `/api/v1/records/${W.projectsRec.id}`)).body.record;
      assert.equal((await as(P.owner, "PATCH", `/api/v1/records/${W.projectsRec.id}`, { expectedVersion: cur.version, values: { client: [W.link.Acme] } })).status, 200);
      const issued = await as(P.owner, "POST", "/api/v1/me/api-tokens", { name: "Parity", boardIds: [W.plain.id, W.projects.id, W.clients.id], scopes: ["read"], expiresAt: new Date(Date.now() + 86400000).toISOString() });
      assert.equal(issued.status, 201, JSON.stringify(issued.body));
      secret = issued.body.secret;
      snaps.newReads = await reads(s);
    } finally { await s.app.close(); }
    // The older release reads the very same data, then makes its writes; this release then makes the same writes (other names).
    const o = await open(require(path.join(source, "server", "tests", "helpers.js")));
    try { snaps.oldReads = await reads(o); snaps.oldWrites = await writes(o, "o"); } finally { await o.app.close(); }
    const s2 = await open(require("./helpers"));
    try { snaps.newWrites = await writes(s2, "n"); } finally { await s2.app.close(); }
  });

  test("every read answers 200 on both releases (the contract is exercised, not skipped)", () => {
    for (const [name, r] of Object.entries(snaps.oldReads)) assert.equal(r.status, 200, `${PARITY_REF} ${name}: ${JSON.stringify(r.body).slice(0, 300)}`);
    for (const [name, r] of Object.entries(snaps.newReads)) assert.equal(r.status, 200, `S0-B ${name}: ${JSON.stringify(r.body).slice(0, 300)}`);
    assert.ok(Object.keys(snaps.oldReads).length >= 70, `reads: ${Object.keys(snaps.oldReads).length}`);
  });

  test("reads: session API, token API and API Explorer are deep-equal on the same data", () => {
    const names = Object.keys(snaps.oldReads);
    assert.deepEqual(Object.keys(snaps.newReads).sort(), names.sort());
    const diffs = names.filter((n) => JSON.stringify(intendedNew(n, snaps.newReads[n])) !== JSON.stringify(intendedOld(n, snaps.oldReads[n])));
    assert.deepEqual(diffs, [], diffs.map((n) => `${n}\n  S0-B: ${JSON.stringify(snaps.newReads[n]).slice(0, 600)}\n  ${PARITY_REF}: ${JSON.stringify(snaps.oldReads[n]).slice(0, 600)}`).join("\n"));
  });

  test("writes: create, batch, bulk, PATCH, Connect links, /related, add column, delete: same shapes and values (IDs/times masked)", () => {
    const names = Object.keys(snaps.oldWrites);
    const diffs = names.filter((n) => JSON.stringify(intendedNew(n, snaps.newWrites[n])) !== JSON.stringify(intendedOld(n, snaps.oldWrites[n])));
    assert.deepEqual(diffs, [], diffs.map((n) => `${n}\n  S0-B: ${JSON.stringify(snaps.newWrites[n]).slice(0, 800)}\n  ${PARITY_REF}: ${JSON.stringify(snaps.oldWrites[n]).slice(0, 800)}`).join("\n"));
    for (const [n, r] of Object.entries(snaps.oldWrites)) assert.ok(r.status === 200 || r.status === 201, `${n} ${r.status}`);
  });

  test("intended: no restrictedColumns / droppedLinks / restricted lists appear where nothing is restricted or dropped", () => {
    const text = JSON.stringify([snaps.newReads, snaps.newWrites]);
    for (const word of ["restrictedColumns", "droppedLinks", "\"restricted\":[\"", "\"restricted\":true", "connectStatus"]) assert.equal(text.includes(word), false, word);
  });

  test("I1: Mirror cells are null in the token API and the API Explorer (never a stored placeholder); the session API is unchanged", () => {
    const mirrorValues = (snap) => Object.entries(snap).filter(([n]) => isTokenOrExplorer(n)).flatMap(([, r]) => JSON.stringify(r.body).match(/"total":("[^"]*"|null|\d+)/g) || []);
    const now = mirrorValues(snaps.newReads), was = mirrorValues(snaps.oldReads);
    assert.ok(now.length >= 6, `mirror cells seen: ${now.length}`);
    assert.ok(now.every((t) => t === '"total":null'), now.join(" "));
    assert.ok(was.some((t) => t !== '"total":null'), `the older release returned: ${[...new Set(was)].join(" ")}`);
    assert.equal(JSON.stringify(snaps.newReads["token values projects.serial"]).includes('"total"'), false);
  });
  test("I2: /related adds only unavailableReasons and partial (both empty here)", () => {
    const now = snaps.newWrites["related projects"].body, was = snaps.oldWrites["related projects"].body;
    assert.deepEqual(Object.keys(now).filter((k) => !(k in was)).sort(), ["partial", "unavailableReasons"]);
    assert.deepEqual(Object.keys(was).filter((k) => !(k in now)), []);
    assert.deepEqual(now.partial, {}); assert.deepEqual(now.unavailableReasons, {});
  });
});
