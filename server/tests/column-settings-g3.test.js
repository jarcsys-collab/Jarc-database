// G3 / D12: the optional column `settings` object (display only), on the server. The shared rules (site/assets/ColumnTypes.js
// cleanSettings / settingsForType, required by domain/board-schema.js), the session API (accepted, validated, echoed,
// preserved when a PATCH leaves it out, cleared with null), POST /columns, a type change, record values that never change,
// the external Board API (not exposed), /features (columnSettings capability) and who may change it. Offline: fake MongoDB.
// Synthetic values only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../site/assets/ColumnTypes.js");
const schema = require("../src/domain/board-schema");
const { columnsOf } = require("../src/routes/external-api");
const { startMongoApp, startEntraApp, SessionClient, api } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "qty", label: "Qty", type: "number" },
  { key: "due", label: "Due", type: "date" },
  { key: "notes", label: "Notes", type: "text" },
  { key: "site", label: "Site", type: "link" },
  { key: "status", label: "Status", type: "status", options: ["To do", "Done"] }
];
const plain = (v) => JSON.parse(JSON.stringify(v));

describe("Shared settings rules (ColumnTypes.cleanSettings)", () => {
  test("allow-listed shapes per type; defaults are not stored; nothing left → null", () => {
    assert.deepEqual(T.cleanSettings("number", { precision: 2, thousands: false, prefix: "₱", suffix: " kg", align: "left" }), { ok: true, settings: { precision: 2, thousands: false, prefix: "₱", suffix: " kg", align: "left" } });
    assert.deepEqual(T.cleanSettings("number", { thousands: true, prefix: "", align: "right" }), { ok: true, settings: null });
    assert.deepEqual(T.cleanSettings("date", { displayFormat: "dmy", weekday: true }), { ok: true, settings: { displayFormat: "dmy", weekday: true } });
    assert.deepEqual(T.cleanSettings("date", { displayFormat: "medium" }), { ok: true, settings: null });
    assert.deepEqual(T.cleanSettings("text", { wrap: true }), { ok: true, settings: { wrap: true } });
    assert.deepEqual(T.cleanSettings("link", { display: "text" }), { ok: true, settings: { display: "text" } });
    for (const empty of [undefined, null, {}]) assert.deepEqual(T.cleanSettings("number", empty), { ok: true, settings: null });
  });
  test("refused: unknown keys (also __proto__ / constructor), wrong kinds, out of range, long or unsafe affixes, other types, non-objects, oversize", () => {
    const refused = [
      ["number", { decimals: 2 }], ["number", JSON.parse('{"__proto__":{"polluted":1}}')], ["number", { constructor: 1 }],
      ["number", { precision: 7 }], ["number", { precision: -1 }], ["number", { precision: 1.5 }], ["number", { precision: "2" }],
      ["number", { thousands: "yes" }], ["number", { align: "center" }], ["number", { prefix: "123456789" }], ["number", { suffix: "<b>" }],
      ["number", { prefix: "a\u0000" }], ["number", { prefix: "‮$" }], ["number", { prefix: 5 }],
      ["date", { displayFormat: "YYYY" }], ["date", { weekday: 1 }], ["text", { wrap: "true" }], ["link", { display: "html" }],
      ["text", { precision: 2 }], ["status", { wrap: true }], ["owner", { wrap: true }], ["nope", { wrap: true }],
      ["number", []], ["number", "x"], ["number", 5], ["number", new Date()], ["number", { precision: 2, pad: "x".repeat(5000) }]
    ];
    for (const [type, raw] of refused) assert.equal(T.cleanSettings(type, raw).ok, false, `${type} ${JSON.stringify(raw)?.slice(0, 60)}`);
    assert.equal({}.polluted, undefined);
  });
  test("a type change keeps only the keys the new type defines", () => {
    assert.equal(T.settingsForType("text", { precision: 2 }), null);
    assert.deepEqual(T.settingsForType("number", { precision: 2, wrap: true }), { precision: 2 });
    assert.equal(T.settingsForType("link", { wrap: true }), null);
    assert.equal(T.settingsForType("status", { precision: 2 }), null);
  });
  test("formatting is display text only: raw stays raw; unparseable values are shown as stored", () => {
    const col = (type, settings) => ({ type, settings });
    assert.equal(T.formatNumber("1234.567", col("number", { precision: 2, thousands: false })), "1234.57");
    assert.equal(T.formatNumber("-1234.5", col("number", { precision: 0, thousands: false, prefix: "$" })), "-$1235");
    assert.equal(T.formatNumber("-0.001", col("number", { precision: 0, suffix: "%" })), "0%");
    assert.equal(T.formatNumber("12abc", col("number", { precision: 2 })), "12abc");
    assert.equal(T.formatNumber("", col("number", { precision: 2 })), "");
    assert.equal(T.formatNumber("5", { type: "number" }), null, "no settings → today's rendering");
    assert.equal(T.formatDate("2026-03-05", col("date", { displayFormat: "iso", weekday: true })), "Thu, 2026-03-05");
    assert.equal(T.formatDate("2026-03-05", col("date", { displayFormat: "long", weekday: true })), "Thursday, March 5, 2026");
    assert.equal(T.formatDate("2026-03-05", col("date", { displayFormat: "dmy" })), "05/03/2026");
    assert.equal(T.formatDate("2026-03-05", col("date", { displayFormat: "mdy" })), "03/05/2026");
    assert.equal(T.formatDate("2026-02-30", col("date", { displayFormat: "dmy" })), "2026-02-30", "an impossible date is shown as stored");
    assert.equal(T.formatLink("https://www.example.com/page/", col("link", { display: "text" })), "example.com/page");
    assert.equal(T.formatLink("https://example.com", col("link", { display: "url" })), null);
    assert.equal(T.displayText({ type: "text", settings: { wrap: true } }, "x"), null);
    assert.deepEqual(T.cellLayout({ type: "number", settings: { align: "left" } }), { align: "left", wrap: false });
    assert.deepEqual(T.cellLayout({ type: "text", settings: { wrap: true } }), { align: null, wrap: true });
  });
  test("board-schema: normalizeColumn checks settings but never stores them on the column; columnSettingsFor canonicalises them", () => {
    assert.equal("settings" in schema.normalizeColumn({ key: "q", label: "Q", type: "number", settings: { precision: 1, thousands: true } }), false, "stored columns never hold settings (rollback safety)");
    assert.deepEqual(schema.incomingSettings({ key: "q", type: "number", settings: { precision: 1, thousands: true } }, "number"), { precision: 1 });
    const raw = [{ key: "serial", label: "Item", type: "text" }, { key: "q", label: "Q", type: "number", settings: { precision: 1, thousands: true } }];
    assert.deepEqual(schema.columnSettingsFor(raw, schema.normalizeColumns(raw)), { q: { precision: 1 } });
    assert.equal(schema.columnSettingsFor(raw.slice(0, 1), schema.normalizeColumns(raw.slice(0, 1))), null);
    assert.equal("settings" in schema.normalizeColumn({ key: "q", label: "Q", type: "number" }), false);
    assert.equal("settings" in schema.normalizeColumn({ key: "q", label: "Q", type: "number", settings: null }), false);
    assert.equal("settings" in schema.normalizeColumn({ key: "q", label: "Q", type: "number", settings: { align: "right" } }), false);
    assert.throws(() => schema.normalizeColumn({ key: "q", label: "Q", type: "number", settings: { wrap: true } }), /display settings of column "q" have an unknown setting "wrap"/);
  });
});

describe("Column settings through the session API (development API)", () => {
  let app, ws;
  const call = (method, path, body) => api(app.url, method, `/api/v1${path}`, body);
  const board = async (id) => (await call("GET", `/boards/${id}`)).body.board;
  const col = (b, key) => b.columns.find((c) => c.key === key);
  const patchColumns = (b, columns) => call("PATCH", `/boards/${b.id}`, { expectedVersion: b.version, columns });
  before(async () => {
    app = await startMongoApp();
    ws = (await call("POST", "/workspaces", { name: "G3" })).body.workspace;
  });
  after(async () => { await app.close(); });

  test("/features advertises the capability (no switch, no variable)", async () => {
    assert.equal((await call("GET", "/features")).body.features.columnSettings, true);
  });

  test("columns without settings keep their old shape (no backfill); settings are accepted, canonical and echoed", async () => {
    const plainBoard = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Plain", columns: COLUMNS })).body.board;
    assert.ok(plainBoard.columns.every((c) => !("settings" in c)), "no settings field on any column");
    const res = await call("POST", `/workspaces/${ws.id}/boards`, { name: "Formatted", columns: COLUMNS.map((c) => (c.key === "qty" ? { ...c, settings: { precision: 2, thousands: true, prefix: "₱" } } : c)) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(col(res.body.board, "qty").settings, { precision: 2, prefix: "₱" }, "the default thousands: true is not stored");
    assert.deepEqual(col(await board(res.body.board.id), "qty").settings, { precision: 2, prefix: "₱" });
  });

  test("PATCH: an object replaces, a column sent WITHOUT settings keeps them (older tab), null clears; record values never change", async () => {
    let b = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Patch", columns: COLUMNS })).body.board;
    const record = (await call("POST", `/boards/${b.id}/records`, { values: { serial: "R1", qty: "1234.5678", due: "2026-03-05", notes: "Long text", site: "https://example.com/a" } })).body.record;
    let res = await patchColumns(b, b.columns.map((c) => ({ ...c, settings: { qty: { precision: 1 }, due: { displayFormat: "dmy", weekday: true }, notes: { wrap: true }, site: { display: "text" } }[c.key] ?? null })));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    b = res.body.board;
    assert.deepEqual([col(b, "qty").settings, col(b, "due").settings, col(b, "notes").settings, col(b, "site").settings], [{ precision: 1 }, { displayFormat: "dmy", weekday: true }, { wrap: true }, { display: "text" }]);
    assert.equal("settings" in col(b, "status"), false);
    // An older browser tab: full column list, no settings field, one rename. Settings are kept; the rename applies.
    const old = b.columns.map(({ settings, ...rest }) => (rest.key === "qty" ? { ...rest, label: "Quantity" } : rest));
    res = await patchColumns(b, old);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    b = res.body.board;
    assert.equal(col(b, "qty").label, "Quantity");
    assert.deepEqual(col(b, "qty").settings, { precision: 1 }, "kept when omitted");
    assert.deepEqual(col(b, "due").settings, { displayFormat: "dmy", weekday: true });
    // null clears one column; the others are untouched.
    res = await patchColumns(b, b.columns.map((c) => (c.key === "qty" ? { ...c, settings: null } : c)));
    b = res.body.board;
    assert.equal("settings" in col(b, "qty"), false);
    assert.deepEqual(col(b, "notes").settings, { wrap: true });
    // Settings equal to the defaults are the same as none.
    res = await patchColumns(b, b.columns.map((c) => (c.key === "notes" ? { ...c, settings: { wrap: false } } : c)));
    assert.equal("settings" in col(res.body.board, "notes"), false);
    const after = (await call("GET", `/boards/${b.id}/records?limit=10`)).body.items[0];
    assert.deepEqual([after.values.qty, after.values.due, after.values.notes, after.values.site, after.version], [record.values.qty, record.values.due, record.values.notes, record.values.site, record.version], "no record was rewritten");
  });

  test("PATCH refuses unknown keys, bad values and settings on a type without them; nothing is written", async () => {
    const b = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Refuse", columns: COLUMNS })).body.board;
    for (const [key, settings] of [["qty", { decimals: 2 }], ["qty", { precision: 9 }], ["qty", { prefix: "toolongprefix" }], ["due", { displayFormat: "YYYY-MM" }], ["status", { wrap: true }], ["notes", "wrap"], ["qty", JSON.parse('{"__proto__":{"x":1}}')]]) {
      const res = await patchColumns(b, b.columns.map((c) => (c.key === key ? { ...c, settings } : c)));
      assert.equal(res.status, 400, `${key} ${JSON.stringify(settings)}`);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    }
    const now = await board(b.id);
    assert.equal(now.version, b.version, "unchanged");
    assert.ok(now.columns.every((c) => !("settings" in c)));
  });

  test("POST /columns accepts settings (and refuses bad ones); a duplicate keeps them; a type change keeps only what the new type defines", async () => {
    let b = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "Columns", columns: COLUMNS })).body.board;
    const bad = await call("POST", `/boards/${b.id}/columns`, { expectedVersion: b.version, column: { key: "amt", label: "Amount", type: "number", settings: { currency: "PHP" } } });
    assert.equal(bad.status, 400);
    let res = await call("POST", `/boards/${b.id}/columns`, { expectedVersion: b.version, column: { key: "amt", label: "Amount", type: "number", settings: { precision: 2, suffix: " kg" } } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    b = res.body.board;
    assert.deepEqual(col(b, "amt").settings, { precision: 2, suffix: " kg" });
    await call("POST", `/boards/${b.id}/records`, { values: { serial: "R", amt: "5" } });
    b = await board(b.id);
    res = await call("POST", `/boards/${b.id}/columns`, { expectedVersion: b.version, column: { ...col(b, "amt"), key: "amt2", label: "Amount copy" }, copyFrom: "amt" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(col(res.body.board, "amt2").settings, { precision: 2, suffix: " kg" });
    b = res.body.board;
    res = await call("POST", `/boards/${b.id}/columns/amt/type`, { expectedVersion: b.version, type: "text" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(col(res.body.board, "amt").type, "text");
    assert.equal("settings" in col(res.body.board, "amt"), false, "number settings don't apply to text");
    assert.deepEqual(col(res.body.board, "amt2").settings, { precision: 2, suffix: " kg" });
  });

  test("the external Board API column shape is unchanged (settings are not exposed); the session API echoes them", async () => {
    const b = (await call("POST", `/workspaces/${ws.id}/boards`, { name: "External", columns: COLUMNS.map((c) => (c.key === "due" ? { ...c, settings: { displayFormat: "iso" } } : c)) })).body.board;
    assert.deepEqual(col(b, "due").settings, { displayFormat: "iso" });
    const stored = await app.db.collection("boards").findOne({ name: "External" });
    const external = columnsOf(stored);
    assert.ok(external.every((c) => !("settings" in c)));
    assert.deepEqual(Object.keys(external.find((c) => c.id === "due")).sort(), ["id", "name", "options", "position", "required", "type", "visible"]);
  });
});

describe("Who may change column settings (Microsoft sign-in, role_based)", () => {
  let app, issuer, admin, member, viewer, ws, b;
  const client = () => new SessionClient(app.url, app.entra.appOrigin);
  before(async () => {
    issuer = await createTokenIssuer();
    app = await startEntraApp({ issuer, accessPolicy: "role_based" });
    admin = client(); member = client(); viewer = client();
    await admin.signIn(issuer.person("Sys Admin", { admin: true }));
    await member.signIn(issuer.person("Mia Member")); await viewer.signIn(issuer.person("Vic Viewer"));
    ws = (await admin.request("POST", "/api/v1/workspaces", { name: "Roles" })).body.workspace;
    for (const [c, role] of [[member, "MEMBER"], [viewer, "VIEWER"]]) {
      const id = (await c.request("GET", "/api/v1/me")).body.user.id;
      assert.equal((await admin.request("POST", `/api/v1/workspaces/${ws.id}/members`, { userId: id, role })).status, 201);
    }
    b = (await admin.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Roles board", columns: COLUMNS })).body.board;
  });
  after(async () => { await app.close(); });

  test("a viewer is refused (403); a member may (the rule for every other column edit)", async () => {
    const columns = (s) => b.columns.map((c) => (c.key === "qty" ? { ...c, settings: s } : c));
    const refused = await viewer.request("PATCH", `/api/v1/boards/${b.id}`, { expectedVersion: b.version, columns: columns({ precision: 3 }) });
    assert.equal(refused.status, 403);
    const ok = await member.request("PATCH", `/api/v1/boards/${b.id}`, { expectedVersion: b.version, columns: columns({ precision: 3 }) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(plain(ok.body.board.columns.find((c) => c.key === "qty").settings), { precision: 3 });
    assert.equal((await member.request("GET", "/api/v1/features")).body.features.columnSettings, true);
  });
});
