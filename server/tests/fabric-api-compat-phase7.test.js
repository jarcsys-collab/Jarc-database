// Phase 7 API compatibility: a differential harness. Two complete JARC apps run in this one process — the BASELINE (production
// efbfdf4, a separate clean worktree; set FABRIC_COMPAT_BASELINE to its server/ folder) and the CANDIDATE (this worktree) —
// each with its own modules, its own fake JARC MongoDB and its own Fabric fake (tests/support/fabric-fake.js) holding the SAME
// synthetic rows (same _ids). The same request corpus is replayed against both, in the same order, and every response is
// compared: status, error code, the headers that matter (content-type, cache-control, allow, www-authenticate, X-RateLimit-*,
// retry-after; and the set of header names) and the JSON body. Only time-dependent values are normalized: nextCursor strings
// (opaque; each app's cursors are paged within that same app instead), JARC ids/timestamps on the JARC board API sample, and
// X-RateLimit-Reset (±2 s).
//
// Every difference is classified. Expected differences are the documented phase 7 changes (B1-backend-report.md):
//   - session mount only: the advanced schema keys, appliedFilter/orderBy/searchField on records, GET /:dataset/values and
//     /fabric/saved-filters;
//   - SESSION cursors are bound to the caller and the access level (a session cursor replayed by another person, or carried
//     between the session and the token API, is 400).
// The external token API's cursors are exactly as on efbfdf4 (12-api-compatibility.md E1–E3, fixed after 10-security-review I1):
// the same binding (a cursor replayed by another key or access level still pages), the 512-character limit (long keys stop
// after the page) and no pagination.cursorTooLong. Those cases are compared like any other and must not differ.
// Anything else fails the test. Synthetic identities and data only; nothing connects to a real database, server/.env is never read.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { SessionClient } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

// FABRIC_COMPAT_BASELINE: the server folder of a worktree at the baseline commit (for example efbfdf4). Skipped without it.
const ROOTS = { base: process.env.FABRIC_COMPAT_BASELINE || "", cand: path.resolve(__dirname, "..") };
const SKIP = ROOTS.base && fs.existsSync(path.join(ROOTS.base, "src", "app.js")) ? false
  : `set FABRIC_COMPAT_BASELINE to a baseline worktree's server folder${ROOTS.base ? ` (not found: ${ROOTS.base})` : ""}`;
const REPORT = process.env.FABRIC_COMPAT_REPORT || null; // optional: write the full comparison as JSON here

const KEY = crypto.randomBytes(32);
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();
const SALES = "fabric.sales.read", INVENTORY = "fabric.inventory.read", SENSITIVE = "fabric.sensitive.read";
const SCOPE_SETS = { S: [SALES], I: [INVENTORY], SI: [SALES, INVENTORY], SX: [SALES, SENSITIVE], IX: [INVENTORY, SENSITIVE], SIX: [SALES, INVENTORY, SENSITIVE], SIX2: [SALES, INVENTORY, SENSITIVE], REV: [SALES, INVENTORY], EXP: [SALES, INVENTORY] };
// The external data router allows 30 requests per 10 s per key (fabricLimiter defaults; not configurable on that mount), so each
// scope combination has a pool of keys and every key serves at most PER_KEY requests in this run. Both apps use the same key index
// for the same request, so the X-RateLimit-* headers stay comparable.
// Issuing is limited to 20 Fabric keys an hour per administrator (not configurable on createApp), so four extra synthetic
// administrators (keyIssuers) share the issuing.
const POOLS = { S: 4, I: 4, SI: 5, SX: 4, IX: 4, SIX: 14, SIX2: 2 }, POOLED = Object.keys(POOLS), PER_KEY = 25;
const usage = {};
const KEY_ISSUERS = ["owner", "admin", "k1", "k2", "k3", "k4"];
function alloc(label, n = 1) {
  if (!POOLED.includes(label)) return 0;
  const u = (usage[label] ||= { idx: 0, used: 0 });
  if (u.used + n > PER_KEY) { u.idx += 1; u.used = 0; }
  assert.ok(u.idx < POOLS[label], `key pool ${label} exhausted`);
  u.used += n;
  return u.idx;
}
const HEADERS_EXACT = ["content-type", "cache-control", "allow", "www-authenticate", "x-ratelimit-limit", "x-ratelimit-remaining", "retry-after", "strict-transport-security", "x-content-type-options", "x-frame-options", "referrer-policy", "content-security-policy", "vary"];
const HEADERS_IGNORED = new Set(["date", "etag", "content-length", "connection", "keep-alive", "set-cookie", "x-ratelimit-reset", "x-response-time", "server-timing", "transfer-encoding"]);

// ---- One app per root, each with its own modules ----
function load(root) {
  const r = (p) => require(path.join(root, p));
  return {
    createApp: r("src/app").createApp, fabric: r("src/fabric"), loadConfig: r("src/config").loadConfig,
    MemoryStateRepository: r("src/repositories/memory-state-repository").MemoryStateRepository, MongoConnection: r("src/db/connection").MongoConnection,
    bootstrap: r("src/db/bootstrap"), createDataLayer: r("src/data-layer").createDataLayer, MemoryFileStore: r("src/files/file-store").MemoryFileStore,
    createEntraVerifier: r("src/auth/entra-token").createEntraVerifier, FakeMongoClient: r("tests/support/fake-mongo").FakeMongoClient,
    ff: r("tests/support/fabric-fake"), entraEnv: r("tests/helpers").entraEnv, ObjectId: r("node_modules/mongodb").ObjectId
  };
}

// The synthetic FactSales rows (deterministic; built with each root's own row(), whose ids follow the same sequence). Plus rows
// whose sort keys are long: 350-character invoice ids (their cursor is over 512 but under 2,048 characters) on 2026-02-02 and
// 450-character ones (over the 400-character key limit) on 2026-02-03, both outside the default window.
function salesDocs(ff) {
  const out = [];
  const cos = ["ALPHA", "BETA", "GAMMA"], sources = ["Source One", "Source Two"];
  for (let i = 0; i < 260; i += 1) {
    out.push(ff.row({
      Company: cos[i % 3], invoice_id: `INV-${String(1000 + Math.floor(i / 2)).padStart(5, "0")}`, Line_No: 10000 * (1 + (i % 2)),
      invoice_date: new Date(Date.UTC(2026, 2, 1) + (i % 75) * 86400000 + 8 * 3600000),
      customer_id: `C-${String(i % 17).padStart(3, "0")}`, customer_name: `Example Customer ${i % 17}`, invoice_item_id: `ITEM-${i % 23}`,
      invoice_item_name: `Synthetic item ${i % 23}`, external_document_no: i % 5 ? "" : `EXT-${i}`, sales_data_source: sources[i % 2],
      sales_type: i % 7 === 0 ? "Credit Memo" : "Invoice", invoice_item_quantity: 1 + (i % 4), invoice_item_amount: 10 + i,
      Unit_Price: ff.dec((5 + (i % 3)).toFixed(2)), landed_cost: String(1 + (i % 9)), Text: `synthetic text ${i}`, Custom: "c", custom_1: "c1"
    }));
  }
  for (let i = 0; i < 3; i += 1) out.push(ff.row({ Company: "ALPHA", invoice_id: "L".repeat(349) + i, invoice_date: new Date("2026-02-02T08:00:00Z") }));
  for (let i = 0; i < 3; i += 1) out.push(ff.row({ Company: "ALPHA", invoice_id: "M".repeat(449) + i, invoice_date: new Date("2026-02-03T08:00:00Z") }));
  return out;
}

async function boot(root, issuer, people) {
  const m = load(root);
  const oids = (...ps) => ps.map((p) => p.oid).join(",");
  const keyIssuers = [people.k1, people.k2, people.k3, people.k4];
  const env = m.entraEnv({
    JARC_FEATURE_FABRIC_DATA: "true", FABRIC_MONGODB_URI: "mongodb://fabric.invalid", FABRIC_MONGODB_DB_NAME: "FabricTestDb", FABRIC_API_RATE_PER_MINUTE: "600",
    FABRIC_DATA_READER_OIDS: oids(people.owner, people.admin, people.readerCost, people.readerPlain, ...keyIssuers),
    FABRIC_DATA_COST_READER_OIDS: oids(people.owner, people.admin, people.readerCost, ...keyIssuers),
    FABRIC_API_ADMIN_OIDS: oids(people.owner, people.admin, ...keyIssuers), FABRIC_API_OVERSIGHT_OIDS: oids(people.owner)
  });
  const fake = new m.FakeMongoClient();
  const connection = new m.MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await m.bootstrap.ensureDatabase(connection.db);
  const logger = { errors: [], warnings: [], error(...a) { this.errors.push(a.map(String).join(" ")); }, warn(...a) { this.warnings.push(a.map(String).join(" ")); } };
  const dataLayer = m.createDataLayer({ connection, logger, fileStore: new m.MemoryFileStore(), environment: "test" });
  const verify = m.createEntraVerifier({ ...issuer.config, keySet: issuer.keySet });
  const config = m.loadConfig(env).fabricData;
  const docs = salesDocs(m.ff), inventory = m.ff.inventoryRows(400);
  const fabricClient = new m.ff.FabricFakeClient({ docs, inventory: { docs: inventory } });
  const stack = m.fabric.createFabricData({ config, logger: { warn() {}, error() {} }, createClient: () => fabricClient });
  const app = m.createApp({
    repository: new m.MemoryStateRepository(), environment: "test", logger, dataLayer, auth: { mode: "entra", entra: issuer.config, verify },
    accessPolicy: "development_shared", betaOpenEditing: true,
    apiTokens: { key: KEY, adminObjectIds: [people.boardAdmin.oid.toLowerCase()], issuePerHour: 1000, maxActive: 1000 },
    fabricData: { ...stack, limiter: m.fabric.fabricLimiter({ perWindow: 100000 }) }
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  server.keepAliveTimeout = 30000; server.headersTimeout = 31000;
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = {};
  for (const [name, person] of Object.entries(people)) {
    const c = new SessionClient(url, issuer.config.appOrigin);
    assert.equal((await c.signIn(person)).status, 201, `${root} sign-in ${name}`);
    clients[name] = c;
  }
  return {
    root, m, url, db: connection.db, logger, clients, secrets: {}, ids: {}, docIds: docs.map((d) => d._id.toHexString()), invIds: inventory.map((d) => d._id.toHexString()),
    close: async () => { app.locals.realtime?.closeAll(); await new Promise((resolve) => server.close(resolve)); await stack.close(); }
  };
}

// ---- Requests ----
// spec: { via: "ext" | "session" | "jarc-session", who (token label or person), method, path, headers, tag }
async function send(app, spec) {
  const method = spec.method || "GET";
  let res;
  if (spec.via === "ext") {
    const secret = Array.isArray(app.secrets[spec.who]) ? app.secrets[spec.who][spec.idx ?? 0] : app.secrets[spec.who];
    const auth = spec.auth !== undefined ? spec.auth : spec.who ? `Bearer ${secret}` : null;
    const r = await fetch(`${app.url}/api/v1/external${spec.path}`, { method, headers: { ...(auth ? { Authorization: auth } : {}), ...(spec.headers || {}) } });
    const text = await r.text();
    res = { status: r.status, headers: r.headers, text };
  } else {
    res = await app.clients[spec.who].request(method, `/api/v1${spec.path}`, spec.body, { headers: spec.headers || {} });
  }
  let body = null;
  try { body = res.text ? JSON.parse(res.text) : null; } catch { body = { __nonJson: res.text.slice(0, 200) }; }
  const headers = {};
  for (const [k, v] of res.headers) headers[k.toLowerCase()] = v;
  return { status: res.status, headers, body, text: res.text };
}

// The JARC ids and timestamps in a board API response (different in each app by nature); fabric record ids (0000000000000000f…)
// are the same synthetic ids in both apps and are kept.
function normalizeJarc(value, seen = new Map()) {
  if (Array.isArray(value)) return value.map((v) => normalizeJarc(v, seen));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeJarc(v, seen)]));
  if (typeof value === "string") {
    if (/^[0-9a-f]{24}$/.test(value) && !/^0{16}f/.test(value)) { if (!seen.has(value)) seen.set(value, `<id${seen.size}>`); return seen.get(value); }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && value.slice(0, 4) === String(new Date().getUTCFullYear())) return "<now>";
    if (/^jarc_[0-9a-f]{24}_/.test(value)) return "<secret>";
    if (/^jarc_[0-9a-f]{6,24}$/.test(value)) return "<prefix>";
    if (/^(grp|col|opt|view)_[A-Za-z0-9]{6,}$/.test(value)) { if (!seen.has(value)) seen.set(value, `<${value.split("_")[0]}${seen.size}>`); return seen.get(value); }
  }
  return value;
}
function normalize(body, spec) {
  let out = JSON.parse(JSON.stringify(body ?? null));
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "nextCursor" && typeof x === "string") v[k] = "<cursor>"; else if (k === "checkedAt" && typeof x === "string") v[k] = "<time>"; else walk(x); }
  };
  walk(out);
  if (spec.jarc || spec.via === "jarc-session") out = normalizeJarc(out);
  return out;
}

// Structural differences between two JSON values: [{ path, kind: "added" | "removed" | "changed", base, cand }].
function diff(a, b, p = "$", out = []) {
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push({ path: `${p}.length`, kind: "changed", base: a.length, cand: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) diff(a[i], b[i], `${p}[${i}]`, out);
    return out;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) if (!(k in b)) out.push({ path: `${p}.${k}`, kind: "removed", base: a[k] });
    for (const k of Object.keys(b)) if (!(k in a)) out.push({ path: `${p}.${k}`, kind: "added", cand: b[k] });
    for (const k of Object.keys(a)) if (k in b) diff(a[k], b[k], `${p}.${k}`, out);
    if (JSON.stringify(Object.keys(a).filter((k) => k in b)) !== JSON.stringify(Object.keys(b).filter((k) => k in a))) out.push({ path: `${p}{keyOrder}`, kind: "changed", base: Object.keys(a), cand: Object.keys(b) });
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: p, kind: "changed", base: a, cand: b });
  return out;
}

function headerDiffs(bh, ch) {
  const out = [];
  for (const h of HEADERS_EXACT) if ((bh[h] ?? null) !== (ch[h] ?? null)) out.push({ path: `header:${h}`, kind: "changed", base: bh[h] ?? null, cand: ch[h] ?? null });
  const names = (h) => Object.keys(h).filter((k) => !HEADERS_IGNORED.has(k)).sort();
  if (JSON.stringify(names(bh)) !== JSON.stringify(names(ch))) out.push({ path: "header:names", kind: "changed", base: names(bh), cand: names(ch) });
  const br = bh["x-ratelimit-reset"], cr = ch["x-ratelimit-reset"];
  if ((br === undefined) !== (cr === undefined) || (br !== undefined && Math.abs(Number(br) - Number(cr)) > 2)) out.push({ path: "header:x-ratelimit-reset", kind: "changed", base: br ?? null, cand: cr ?? null });
  return out;
}

// ---- Expected (documented) differences ----
const SCHEMA_PATH = /^\/fabric\/(sales|inventory)\/schema$/;
const RECORDS_PATH = /^\/fabric\/(sales|inventory)\/records(\?|$)/;
const schemaAdded = { top: new Set(), field: new Set() };
function expectedReason(spec, d, b, c) {
  const clean = spec.path.split("?")[0];
  if (spec.via === "session" && SCHEMA_PATH.test(clean) && b.status === 200 && c.status === 200 && d.kind === "added") {
    if (/^\$\.[A-Za-z]+$/.test(d.path)) { schemaAdded.top.add(d.path.slice(2)); return "session advanced schema: additive top-level key"; }
    const f = /^\$\.fields\[\d+\]\.([A-Za-z]+)$/.exec(d.path);
    if (f) { schemaAdded.field.add(f[1]); return "session advanced schema: additive per-field key"; }
  }
  if (spec.via === "session" && RECORDS_PATH.test(spec.path) && !/records\/[^?]/.test(spec.path) && b.status === 200 && c.status === 200 && d.kind === "added" && ["$.appliedFilter", "$.orderBy", "$.searchField"].includes(d.path) && d.cand === null) return "session records: additive null appliedFilter/orderBy/searchField";
  if (spec.tag === "new-route" && spec.via === "session") return "session-only new route (values / saved filters)";
  if (spec.tag === "session-cross-caller" && b.status === 200 && c.status === 400) return "session cursor now bound to the caller and access level (B1: binding a/who)";
  // A body that only differs by the additive keys has a different length/etag: those headers are ignored already.
  return null;
}

const results = [];
async function replay(apps, spec) {
  if (spec.via === "ext" && spec.who && spec.idx === undefined) spec = { ...spec, idx: alloc(spec.who) };
  const b = await send(apps.base, spec), c = await send(apps.cand, spec);
  const diffs = [];
  if (b.status !== c.status) diffs.push({ path: "status", kind: "changed", base: b.status, cand: c.status });
  if ((b.body?.error?.code ?? null) !== (c.body?.error?.code ?? null)) diffs.push({ path: "error.code", kind: "changed", base: b.body?.error?.code ?? null, cand: c.body?.error?.code ?? null });
  diffs.push(...headerDiffs(b.headers, c.headers));
  diffs.push(...diff(normalize(b.body, spec), normalize(c.body, spec)));
  const classified = diffs.map((d) => ({ ...d, expected: expectedReason(spec, d, b, c) }));
  // status/error.code/header diffs of an expected-status case (cross-caller, new route) are part of that same expectation.
  for (const d of classified) if (!d.expected && (d.path === "status" || d.path === "error.code" || d.path.startsWith("header:") || d.path.startsWith("$"))) {
    if (spec.tag === "session-cross-caller" && b.status === 200 && c.status === 400) d.expected = "session cursor now bound to the caller and access level (B1: binding a/who)";
    if (spec.tag === "new-route" && spec.via === "session") d.expected = "session-only new route (values / saved filters)";
  }
  const entry = { spec: { via: spec.via, who: spec.who, method: spec.method || "GET", path: spec.path.replace(/cursor=[A-Za-z0-9_-]{20,}/g, "cursor=<cursor>"), tag: spec.tag || null }, base: b.status, cand: c.status, code: [b.body?.error?.code ?? null, c.body?.error?.code ?? null], diffs: classified };
  results.push(entry);
  return { b, c, entry };
}

// Follows nextCursor within ONE app: the pages (normalized), and whether they overlap.
async function chain(app, spec, maxPages = 10) {
  const pages = [];
  let cursor = null, overlap = false;
  const seen = new Set();
  for (let i = 0; i < maxPages; i += 1) {
    const sep = spec.path.includes("?") ? "&" : "?";
    const r = await send(app, { ...spec, path: cursor ? `${spec.path}${sep}cursor=${cursor}` : spec.path });
    if (r.status !== 200) { pages.push({ status: r.status, code: r.body?.error?.code }); break; }
    for (const it of r.body.items) { if (seen.has(it.id)) overlap = true; seen.add(it.id); }
    pages.push({ status: 200, ids: r.body.items.map((i) => i.id), hasMore: r.body.pagination.hasMore, cursorTooLong: r.body.pagination.cursorTooLong ?? null, hasCursor: typeof r.body.pagination.nextCursor === "string" });
    cursor = r.body.pagination.nextCursor;
    if (!cursor) break;
  }
  return { pages, overlap, total: seen.size };
}

let issuer, people, apps;
const unexpected = () => results.flatMap((r) => r.diffs.filter((d) => !d.expected).map((d) => ({ ...r.spec, base: r.base, cand: r.cand, ...d })));

describe("Phase 7 differential API compatibility (baseline efbfdf4 vs candidate)", { skip: SKIP }, () => {
  before(async () => {
    issuer = await createTokenIssuer();
    people = {
      owner: issuer.person("Ona Owner"), admin: issuer.person("Abe AdminOne"), readerCost: issuer.person("Cy CostReader"),
      readerPlain: issuer.person("Pia PlainReader"), outsider: issuer.person("Olive Outsider"), boardAdmin: issuer.person("Jay Boards", { admin: true }),
      k1: issuer.person("Kai KeysOne"), k2: issuer.person("Kit KeysTwo"), k3: issuer.person("Kip KeysThree"), k4: issuer.person("Kaz KeysFour")
    };
    apps = { base: await boot(ROOTS.base, issuer, people), cand: await boot(ROOTS.cand, issuer, people) };
    assert.deepEqual(apps.base.docIds, apps.cand.docIds, "both apps hold the same synthetic sales _ids");
    assert.deepEqual(apps.base.invIds, apps.cand.invIds, "both apps hold the same synthetic inventory _ids");
    // Fabric API keys with each scope combination (issued through the real session route, same order in both apps).
    for (const app of Object.values(apps)) {
      let issued = 0;
      for (const [label, scopes] of Object.entries(SCOPE_SETS)) {
        for (let i = 0; i < (POOLS[label] || 1); i += 1) {
          const by = KEY_ISSUERS[Math.floor(issued++ / 18)];
          const res = await app.clients[by].request("POST", "/api/v1/fabric/api-tokens", { name: `Compat ${label} ${i}`, scopes, expiresAt: inDays(30) });
          assert.equal(res.status, 201, `${app.root} ${label} ${res.text}`);
          if (POOLED.includes(label)) (app.secrets[label] ||= []).push(res.body.secret); else app.secrets[label] = res.body.secret;
          if (i === 0) app.ids[label] = res.body.token.id;
        }
      }
      const sensOnly = await app.clients.k4.request("POST", "/api/v1/fabric/api-tokens", { name: "Compat X only", scopes: [SENSITIVE], expiresAt: inDays(30) });
      app.sensitiveOnlyIssue = [sensOnly.status, sensOnly.body?.error?.code ?? null];
      assert.equal((await app.clients.owner.request("POST", `/api/v1/fabric/api-tokens/${app.ids.REV}/revoke`)).status, 200);
      await app.db.collection(app.m.bootstrap.COLLECTIONS.apiTokens).updateOne({ _id: app.m.ObjectId.createFromHexString(app.ids.EXP) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      // A JARC board with one record and a board API key.
      const ws = await app.clients.boardAdmin.request("POST", "/api/v1/workspaces", { name: "Synthetic" });
      const board = await app.clients.boardAdmin.request("POST", `/api/v1/workspaces/${ws.body.workspace.id}/boards`, { name: "Alpha", columns: [{ key: "serial", label: "Item", type: "text" }] });
      const rec = await app.clients.boardAdmin.request("POST", `/api/v1/boards/${board.body.board.id}/records`, { values: { serial: "Synthetic serial" } });
      assert.ok([200, 201].includes(rec.status), rec.text);
      const bk = await app.clients.boardAdmin.request("POST", "/api/v1/me/api-tokens", { name: "Board BI", workspaceId: ws.body.workspace.id, boardIds: [board.body.board.id], scopes: ["read"], expiresAt: inDays(30) });
      assert.equal(bk.status, 201, bk.text);
      app.secrets.BOARD = bk.body.secret;
      app.board = { ws: ws.body.workspace.id, id: board.body.board.id, record: (rec.body.record || rec.body).id };
    }
    assert.deepEqual(apps.base.sensitiveOnlyIssue, apps.cand.sensitiveOnlyIssue, "a sensitive-only key is treated the same");
  });
  after(async () => {
    if (REPORT) fs.writeFileSync(REPORT, JSON.stringify({ baseline: ROOTS.base, results, schemaAdded: { top: [...schemaAdded.top].sort(), field: [...schemaAdded.field].sort() }, unexpected: unexpected() }, null, 1));
    await apps?.base?.close(); await apps?.cand?.close();
  });

  test("the baseline worktree is production efbfdf4 with no source changes", () => {
    const root = path.resolve(ROOTS.base, "..");
    assert.equal(execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"]).toString().trim(), "efbfdf4");
    assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain", "--", "server/src", "server/tests/support"]).toString().trim(), "");
  });

  test("external API: status, schema, records with every existing parameter, record by id (all scope combinations)", async () => {
    const id = { sales: apps.base.docIds[5], inventory: apps.base.invIds[3] };
    const salesQ = ["", "limit=1", "limit=200", "limit=50&dir=asc", "sort=date", "sort=date&dir=desc", "dateFrom=2026-03-01&dateTo=2026-03-31", "dateFrom=2026-04-01", "dateTo=2026-04-30",
      "dateFrom=2026-03-01&dateTo=2026-05-31", "q=INV-0101", "q=example%20customer%203", "q=EXT", "q=ITEM-1", "fields=invoice_id,Company", "fields=invoice_id,landed_cost", "fields=invoice_id,Text,Custom,custom_1",
      "company=ALPHA", "company=~", "company=alpha", "salesDataSource=Source%20Two", "salesType=Credit%20Memo", "customerId=C-003", "invoiceNo=INV-01010",
      "company=BETA&salesType=Invoice&q=Example&limit=5&fields=invoice_id,customer_name&dateFrom=2026-03-01&dateTo=2026-05-31&dir=asc",
      "dateFrom=2026-02-02&dateTo=2026-02-03", "dateFrom=2026-03-01&dateTo=2026-03-01"];
    const invQ = ["", "limit=1", "limit=200", "dir=asc", "sort=date", "sort=entryNo&company=Synthetic%20Co%20A", "sort=entryNo&company=Synthetic%20Co%20B&dir=asc&limit=7", "dateFrom=2026-01-01&dateTo=2026-01-31",
      "dateFrom=2026-01-01", "dateTo=2026-02-15", "dateFrom=2026-01-01&dateTo=2026-06-30", "q=ITEM-SYN-01", "q=synthetic%20item", "q=DOC-SYN-0001", "q=LOT", "q=SN-SYN",
      "fields=Item_No,Company", "fields=Item_No,Cost_Amount_Actual", "fields=Item_No,landed_cost,trade_price,distributors_price", "company=SYNCO-C", "company=~", "entryType=Sale", "documentType=Sales%20Shipment",
      "documentType=%20", "locationCode=WH-NORTH", "itemNo=ITEM-SYN-010", "open=true", "open=false", "company=Synthetic%20Co%20A&entryType=Purchase&locationCode=WH-EAST&q=ITEM&limit=3&fields=Item_No,Quantity"];
    for (const who of ["S", "I", "SI", "SX", "IX", "SIX"]) {
      await replay(apps, { via: "ext", who, path: "/fabric/status" });
      for (const ds of ["sales", "inventory"]) {
        await replay(apps, { via: "ext", who, path: `/fabric/${ds}/schema` });
        for (const q of ds === "sales" ? salesQ : invQ) await replay(apps, { via: "ext", who, path: `/fabric/${ds}/records${q ? `?${q}` : ""}` });
        await replay(apps, { via: "ext", who, path: `/fabric/${ds}/records/${id[ds]}` });
        await replay(apps, { via: "ext", who, method: "HEAD", path: `/fabric/${ds}/records?limit=2` });
      }
    }
  });

  test("external API: error cases are unchanged", async () => {
    const who = "SIX";
    const cases = [
      "/fabric/sales/records?foo=1", "/fabric/sales/records?cursor=", "/fabric/sales/records?cursor=bad!", "/fabric/sales/records?cursor=abc",
      `/fabric/sales/records?cursor=${"A".repeat(600)}`, `/fabric/sales/records?cursor=${"A".repeat(3000)}`, "/fabric/sales/records?limit=201", "/fabric/sales/records?limit=0",
      "/fabric/sales/records?limit=-1", "/fabric/sales/records?limit=abc", "/fabric/sales/records?limit=1.5", "/fabric/sales/records?dir=up", "/fabric/sales/records?sort=entryNo",
      "/fabric/sales/records?sort=landed_cost", "/fabric/sales/records?landed_cost=1", "/fabric/sales/records?fields=nope", "/fabric/sales/records?fields=", "/fabric/sales/records?fields=Custom.2",
      "/fabric/sales/records?dateFrom=2026-13-01", "/fabric/sales/records?dateFrom=2026-04-01&dateTo=2026-03-01", "/fabric/sales/records?dateFrom=2026-01-01&dateTo=2026-06-30",
      "/fabric/sales/records?q=a&q=b", "/fabric/sales/records?q[x]=1", `/fabric/sales/records?q=${"x".repeat(300)}`, "/fabric/sales/records?q=%01", "/fabric/sales/records?company=",
      "/fabric/inventory/records?sort=entryNo", "/fabric/inventory/records?sort=entryNo&company=SYNCO-C&dateFrom=2026-01-01", "/fabric/inventory/records?open=maybe",
      "/fabric/inventory/records?sort=Cost_Amount_Actual", "/fabric/sales/schema?x=1", "/fabric/status?x=1",
      "/fabric/sales/records/0000000000000000ffffffff", "/fabric/sales/records/not-an-id", `/fabric/sales/records/${apps.base.docIds[1]}?fields=invoice_id`,
      "/fabric/EntraUser/records", "/fabric/EntraUser/schema", "/fabric/entrauser/records", "/fabric/nothing/records", "/fabric/sales", "/fabric", "/fabric/", "/fabric/invoices", "/fabric/invoices/ALPHA/1001",
      "/fabric/sales/records/x/y", "/fabric/api-tokens", "/fabric/saved-filters",
      // the phase 7 parameters and routes must not exist on the external API
      `/fabric/sales/records?filter=${encodeURIComponent(JSON.stringify({ v: 1, op: "and", items: [{ field: "Company", op: "eq", value: "ALPHA" }] }))}`, "/fabric/sales/records?filter=x",
      "/fabric/sales/records?orderBy=invoice_date:desc", "/fabric/sales/records?orderBy=Company", "/fabric/sales/records?searchField=invoice_id&q=INV", "/fabric/sales/records?searchField=invoice_id",
      `/fabric/inventory/records?filter=${encodeURIComponent(JSON.stringify({ v: 1, op: "and", items: [{ field: "Entry_Type", op: "eq", value: "Sale" }] }))}`, "/fabric/inventory/records?orderBy=Item_No", "/fabric/inventory/records?searchField=Item_No",
      "/fabric/sales/values", "/fabric/sales/values?field=Company", "/fabric/inventory/values?field=Entry_Type", "/fabric/sales/schema?advanced=1"
    ];
    for (const p of cases) await replay(apps, { via: "ext", who, path: p });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await replay(apps, { via: "ext", who, method, path: "/fabric/sales/records" });
      await replay(apps, { via: "ext", who, method, path: `/fabric/inventory/records/${apps.base.invIds[0]}` });
    }
    // scope refusals
    await replay(apps, { via: "ext", who: "S", path: "/fabric/inventory/records" });
    await replay(apps, { via: "ext", who: "I", path: "/fabric/sales/schema" });
    await replay(apps, { via: "ext", who: "S", path: "/fabric/inventory/records?limit=201" });
    await replay(apps, { via: "ext", who: "S", path: "/fabric/sales/records?fields=invoice_id,landed_cost" });
    await replay(apps, { via: "ext", who: "I", path: "/fabric/inventory/records?fields=Item_No,Cost_Amount_Actual" });
    await replay(apps, { via: "ext", who: "SI", path: "/fabric/sales/values?field=Company" });
    // token problems (few, so the failed-attempt limit of 30 a minute is never reached)
    await replay(apps, { via: "ext", who: null, path: "/fabric/status" });
    await replay(apps, { via: "ext", auth: "Bearer jarc_000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", path: "/fabric/status" });
    await replay(apps, { via: "ext", auth: "Basic abc", path: "/fabric/status" });
    await replay(apps, { via: "ext", who: "REV", path: "/fabric/sales/records" });
    await replay(apps, { via: "ext", who: "EXP", path: "/fabric/sales/records" });
    await replay(apps, { via: "ext", who: "SIX", path: "/fabric/status?access_token=abc" });
    // a board key on Fabric, a Fabric key on the board API
    for (const p of ["/fabric/status", "/fabric/sales/records", "/fabric/inventory/schema"]) await replay(apps, { via: "ext", who: "BOARD", path: p });
    for (const p of ["/me", "/workspaces", "/boards/000000000000000000000000"]) await replay(apps, { via: "ext", who: "SIX", path: p });
  });

  test("external API: cursors page correctly within each app, and are refused on another list", async () => {
    const chains = [
      { via: "ext", who: "SIX", path: "/fabric/sales/records?limit=37&dateFrom=2026-03-01&dateTo=2026-05-31" },
      { via: "ext", who: "SX", path: "/fabric/sales/records?limit=20&dir=asc&company=BETA&dateFrom=2026-03-01&dateTo=2026-05-31&fields=invoice_id,landed_cost" },
      { via: "ext", who: "S", path: "/fabric/sales/records?limit=9&q=Example%20Customer%201" },
      { via: "ext", who: "SIX", path: "/fabric/inventory/records?limit=60" },
      { via: "ext", who: "I", path: "/fabric/inventory/records?limit=25&sort=entryNo&company=Synthetic%20Co%20A" },
      { via: "ext", who: "IX", path: "/fabric/inventory/records?limit=30&dir=asc&entryType=Sale&fields=Item_No,Cost_Amount_Actual" },
      { via: "ext", who: "SIX", path: "/fabric/sales/records?limit=1&dateFrom=2026-02-02&dateTo=2026-02-02" },
      { via: "ext", who: "SIX", path: "/fabric/sales/records?limit=1&dateFrom=2026-02-03&dateTo=2026-02-03" }
    ];
    const chainResults = [];
    for (const spec of chains) {
      const s = { ...spec, idx: alloc(spec.who, 12) };
      const b = await chain(apps.base, s), c = await chain(apps.cand, s);
      chainResults.push({ path: spec.path, who: spec.who, base: b, cand: c });
      assert.equal(b.overlap, false, `base overlap ${spec.path}`); assert.equal(c.overlap, false, `cand overlap ${spec.path}`);
      // Every chain, long keys included, pages exactly as on efbfdf4 (E2/E3).
      assert.deepEqual(c, b, `same pages ${spec.path}`);
    }
    results.push({ spec: { via: "ext", tag: "chains" }, chains: chainResults, diffs: [] });
    // Long keys: both stop after page 1 (no cursor fits in 512) and neither says cursorTooLong.
    const l350 = chainResults[6], l450 = chainResults[7];
    for (const k of ["base", "cand"]) {
      assert.deepEqual([l350[k].total, l350[k].pages[0].hasMore, l350[k].pages[0].hasCursor, l350[k].pages[0].cursorTooLong], [1, true, false, null], k);
      assert.deepEqual([l450[k].total, l450[k].pages[0].hasCursor, l450[k].pages[0].cursorTooLong], [1, false, null], k);
    }
    await replay(apps, { via: "ext", who: "SIX", path: "/fabric/sales/records?limit=1&dateFrom=2026-02-02&dateTo=2026-02-02", tag: "long-key-350" });
    await replay(apps, { via: "ext", who: "SIX", path: "/fabric/sales/records?limit=1&dateFrom=2026-02-03&dateTo=2026-02-03", tag: "long-key-450" });

    // Each app's own cursor, replayed on: the same list (200), another limit (200), another sort/dir/filter/q/dataset (400), and by
    // another caller with the same scopes / another access level / a session (the caller binding).
    const first = "/fabric/sales/records?limit=10&dateFrom=2026-03-01&dateTo=2026-05-31";
    const firstInv = "/fabric/inventory/records?limit=10";
    const cursors = {};
    const K = alloc("SIX", 16), J = alloc("SI", 4);
    for (const [k, app] of Object.entries(apps)) {
      cursors[k] = {
        six: (await send(app, { via: "ext", who: "SIX", idx: K, path: first })).body.pagination.nextCursor,
        si: (await send(app, { via: "ext", who: "SI", idx: J, path: first })).body.pagination.nextCursor,
        inv: (await send(app, { via: "ext", who: "SIX", idx: K, path: firstInv })).body.pagination.nextCursor,
        session: (await send(app, { via: "session", who: "admin", path: first })).body.pagination.nextCursor
      };
    }
    // Same-request replays per app with that app's own cursor (the spec path carries a per-app cursor).
    const perApp = async (spec, pick) => {
      const b = await send(apps.base, { ...spec, path: spec.path.replace("CURSOR", pick(cursors.base)) });
      const c = await send(apps.cand, { ...spec, path: spec.path.replace("CURSOR", pick(cursors.cand)) });
      const d = [];
      if (b.status !== c.status) d.push({ path: "status", kind: "changed", base: b.status, cand: c.status });
      if ((b.body?.error?.code ?? null) !== (c.body?.error?.code ?? null)) d.push({ path: "error.code", kind: "changed", base: b.body?.error?.code ?? null, cand: c.body?.error?.code ?? null });
      d.push(...headerDiffs(b.headers, c.headers), ...diff(normalize(b.body, spec), normalize(c.body, spec)));
      const reason = spec.tag === "session-cross-caller" && b.status === 200 && c.status === 400 ? "session cursor now bound to the caller and access level (B1: binding a/who)" : spec.tag === "new-route" ? "session-only" : null;
      results.push({ spec: { via: spec.via, who: spec.who, method: "GET", path: spec.path.replace("CURSOR", "<own cursor>"), tag: spec.tag || null }, base: b.status, cand: c.status, code: [b.body?.error?.code ?? null, c.body?.error?.code ?? null], diffs: d.map((x) => ({ ...x, expected: reason || expectedReason(spec, x, b, c) })) });
    };
    await perApp({ via: "ext", who: "SIX", idx: K, path: `${first}&cursor=CURSOR` }, (x) => x.six);
    await perApp({ via: "ext", who: "SIX", idx: K, path: "/fabric/sales/records?limit=25&dateFrom=2026-03-01&dateTo=2026-05-31&cursor=CURSOR" }, (x) => x.six);
    await perApp({ via: "ext", who: "SIX", idx: K, path: "/fabric/sales/records?limit=10&dir=asc&dateFrom=2026-03-01&dateTo=2026-05-31&cursor=CURSOR" }, (x) => x.six);
    await perApp({ via: "ext", who: "SIX", idx: K, path: "/fabric/sales/records?limit=10&company=ALPHA&dateFrom=2026-03-01&dateTo=2026-05-31&cursor=CURSOR" }, (x) => x.six);
    await perApp({ via: "ext", who: "SIX", idx: K, path: "/fabric/sales/records?limit=10&q=INV&dateFrom=2026-03-01&dateTo=2026-05-31&cursor=CURSOR" }, (x) => x.six);
    await perApp({ via: "ext", who: "SIX", idx: K, path: "/fabric/sales/records?limit=10&dateFrom=2026-03-02&dateTo=2026-05-31&cursor=CURSOR" }, (x) => x.six);
    await perApp({ via: "ext", who: "SIX", idx: K, path: "/fabric/inventory/records?limit=10&cursor=CURSOR" }, (x) => x.six);
    await perApp({ via: "ext", who: "SIX", idx: K, path: "/fabric/sales/records?limit=10&cursor=CURSOR" }, (x) => x.inv);
    await perApp({ via: "ext", who: "SIX", idx: K, path: "/fabric/sales/records?limit=10&fields=invoice_id&dateFrom=2026-03-01&dateTo=2026-05-31&cursor=CURSOR" }, (x) => x.six);
    // ext cross-caller (E1): another full key and keys with another access level page exactly as on efbfdf4 (no expected diff).
    await perApp({ via: "ext", who: "SIX2", idx: alloc("SIX2"), path: `${first}&cursor=CURSOR`, tag: "ext-cross-caller" }, (x) => x.six);
    await perApp({ via: "ext", who: "SIX", idx: K, path: `${first}&cursor=CURSOR`, tag: "ext-cross-caller" }, (x) => x.si);
    await perApp({ via: "ext", who: "SI", idx: J, path: `${first}&cursor=CURSOR`, tag: "ext-cross-caller" }, (x) => x.six);
    // session cross-caller: another person's session cursor; a session cursor on a key; a key's cursor on a session.
    await perApp({ via: "session", who: "readerCost", path: `${first}&cursor=CURSOR`, tag: "session-cross-caller" }, (x) => x.session);
    await perApp({ via: "session", who: "admin", path: `${first}&cursor=CURSOR` }, (x) => x.session);
    await perApp({ via: "ext", who: "SIX", idx: K, path: `${first}&cursor=CURSOR`, tag: "session-cross-caller" }, (x) => x.session);
    await perApp({ via: "session", who: "admin", path: `${first}&cursor=CURSOR`, tag: "session-cross-caller" }, (x) => x.six);
  });

  test("session routes without the new parameters: unchanged except the documented additive keys", async () => {
    const id = { sales: apps.base.docIds[5], inventory: apps.base.invIds[3] };
    const qs = { sales: ["", "limit=200", "dir=asc&limit=5", "dateFrom=2026-03-01&dateTo=2026-05-31", "q=INV-0101", "fields=invoice_id,landed_cost", "company=ALPHA", "company=~", "salesDataSource=Source%20Two", "salesType=Credit%20Memo", "customerId=C-003", "invoiceNo=INV-01010", "limit=201", "foo=1", "cursor=abc", "sort=landed_cost", "dateFrom=2026-01-01&dateTo=2026-06-30"],
      inventory: ["", "limit=200", "sort=entryNo&company=Synthetic%20Co%20A", "sort=entryNo", "q=ITEM-SYN-01", "fields=Item_No,Cost_Amount_Actual", "entryType=Sale", "documentType=Sales%20Shipment", "locationCode=WH-NORTH", "itemNo=ITEM-SYN-010", "open=true", "open=maybe", "limit=201"] };
    for (const who of ["owner", "admin", "readerCost", "readerPlain", "outsider"]) {
      await replay(apps, { via: "session", who, path: "/fabric/status" });
      for (const ds of ["sales", "inventory"]) {
        await replay(apps, { via: "session", who, path: `/fabric/${ds}/schema` });
        for (const q of qs[ds]) await replay(apps, { via: "session", who, path: `/fabric/${ds}/records${q ? `?${q}` : ""}` });
        await replay(apps, { via: "session", who, path: `/fabric/${ds}/records/${id[ds]}` });
      }
      await replay(apps, { via: "session", who, path: "/fabric/EntraUser/records" });
      await replay(apps, { via: "session", who, path: "/fabric/sales/records/not-an-id" });
      await replay(apps, { via: "session", who, path: "/features" });
    }
    await replay(apps, { via: "session", who: "owner", method: "DELETE", path: "/fabric/sales/records" });
    await replay(apps, { via: "session", who: "owner", path: "/fabric/status", headers: { Authorization: `Bearer ${"jarc_000000000000000000000000_" + "A".repeat(43)}` } });
    // The new session routes (expected: they exist only in the candidate).
    await replay(apps, { via: "session", who: "owner", path: "/fabric/sales/values?field=Company", tag: "new-route" });
    await replay(apps, { via: "session", who: "owner", path: "/fabric/saved-filters", tag: "new-route" });
    await replay(apps, { via: "session", who: "outsider", path: "/fabric/sales/values?field=Company", tag: "new-route" });
  });

  test("JARC board API keys and JARC API endpoints: unchanged (sample)", async () => {
    const b = apps.base.board, c = apps.cand.board;
    const pair = async (pathOf, opts = {}) => {
      const rb = await send(apps.base, { via: "ext", who: "BOARD", path: pathOf(b), ...opts }), rc = await send(apps.cand, { via: "ext", who: "BOARD", path: pathOf(c), ...opts });
      const spec = { via: "ext", jarc: true, path: pathOf({ ws: "<ws>", id: "<board>", record: "<record>" }) };
      const d = [];
      if (rb.status !== rc.status) d.push({ path: "status", kind: "changed", base: rb.status, cand: rc.status });
      d.push(...headerDiffs(rb.headers, rc.headers), ...diff(normalize(rb.body, spec), normalize(rc.body, spec)));
      results.push({ spec: { via: "ext-board", who: "BOARD", method: opts.method || "GET", path: spec.path, tag: null }, base: rb.status, cand: rc.status, code: [rb.body?.error?.code ?? null, rc.body?.error?.code ?? null], diffs: d.map((x) => ({ ...x, expected: null })) });
    };
    await pair(() => "/me");
    await pair(() => "/workspaces");
    await pair((x) => `/workspaces/${x.ws}/boards`);
    await pair((x) => `/boards/${x.id}`);
    await pair((x) => `/boards/${x.id}/columns`);
    await pair((x) => `/boards/${x.id}/records`);
    await pair((x) => `/boards/${x.id}/records?limit=1001`);
    await pair((x) => `/records/${x.record}`);
    await pair((x) => `/boards/${x.id}/records`, { method: "POST" });
    await pair(() => "/nothing");
    const sess = async (who, p) => {
      const rb = await send(apps.base, { via: "jarc-session", who, path: p }), rc = await send(apps.cand, { via: "jarc-session", who, path: p });
      const spec = { via: "jarc-session", path: p };
      const d = [];
      if (rb.status !== rc.status) d.push({ path: "status", kind: "changed", base: rb.status, cand: rc.status });
      d.push(...headerDiffs(rb.headers, rc.headers), ...diff(normalize(rb.body, spec), normalize(rc.body, spec)));
      results.push({ spec: { via: "jarc-session", who, method: "GET", path: p, tag: null }, base: rb.status, cand: rc.status, code: [null, null], diffs: d.map((x) => ({ ...x, expected: null })) });
    };
    await sess("boardAdmin", "/me");
    await sess("boardAdmin", "/workspaces");
    await sess("boardAdmin", "/me/api-tokens");
    await sess("owner", "/fabric/api-tokens");
    await sess("readerPlain", "/fabric/api-tokens");
  });

  test("every difference is one of the documented phase 7 changes", () => {
    const bad = unexpected();
    assert.ok(results.length > 400, `corpus size ${results.length}`);
    assert.deepEqual(bad.slice(0, 15), [], `${bad.length} unexpected differences`);
    // The additive session schema keys, exactly.
    assert.deepEqual([...schemaAdded.top].sort(), ["dateWindow", "filterModel", "orderBy", "searchFields"]);
    assert.deepEqual([...schemaAdded.field].sort(), ["kind", "label", "operators", "orderable", "requiresDateWindow", "valueSource"]);
    // The external schema and records bodies never gained a key.
    for (const r of results) if (r.spec.via === "ext") for (const d of r.diffs) assert.ok(d.expected, JSON.stringify({ ...r.spec, d }));
    // External API (I1, E1–E3): no difference at all, except a session cursor carried onto a key.
    for (const r of results) if (r.spec.via === "ext" && r.spec.tag !== "session-cross-caller") assert.deepEqual(r.diffs, [], JSON.stringify(r.spec));
  });
});
