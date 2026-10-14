// Phase 9C API: personal appearance preferences (per signed-in person, on their own user document, shared by every
// device, isolated from colleagues, validated, CSRF-protected) and shared appearance data (workspace and board
// icons — only icon names, emoji or short legacy text; group colours, including "default").
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { startEntraApp, SessionClient, api } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

describe("Phase 9C: appearance preferences and shared icons/colours (role_based)", () => {
  let app, issuer, ada, ana, anaLaptop, vic, ws, board;
  const client = () => new SessionClient(app.url, app.entra.appOrigin);
  before(async () => {
    issuer = await createTokenIssuer();
    app = await startEntraApp({ issuer, accessPolicy: "role_based" });
    ada = client(); ana = client(); anaLaptop = client(); vic = client();
    await ada.signIn(issuer.person("Ada Admin", { admin: true }));
    const anaPerson = issuer.person("Ana Reyes");
    await ana.signIn(anaPerson); await anaLaptop.signIn(anaPerson); // the same person on a second device
    await vic.signIn(issuer.person("Vic Viewer"));
    ws = (await ada.request("POST", "/api/v1/workspaces", { name: "Ops" })).body.workspace;
    await ada.request("POST", `/api/v1/workspaces/${ws.id}/members`, { userId: (await ana.request("GET", "/api/v1/me")).body.user.id, role: "MEMBER" });
    await ada.request("POST", `/api/v1/workspaces/${ws.id}/members`, { userId: (await vic.request("GET", "/api/v1/me")).body.user.id, role: "VIEWER" });
    board = (await ada.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Launch", groups: [{ name: "Planning", color: "#3b82f6" }, { name: "Doing" }] })).body.board;
  });
  after(async () => { app.app?.locals?.realtime?.closeAll(); await app.close(); });

  test("preferences need a session and CSRF; a new person starts with none", async () => {
    assert.equal((await api(app.url, "GET", "/api/v1/me/preferences")).status, 401);
    assert.deepEqual((await ana.request("GET", "/api/v1/me/preferences")).body, { appearance: {} });
    assert.equal((await ana.request("PUT", "/api/v1/me/preferences", { appearance: { theme: "dark" } }, { csrf: "wrong" })).status, 403);
  });

  test("saved per person: the same person's other device sees them; colleagues don't; other user fields untouched", async () => {
    const prefs = { theme: "dark", palette: "midnight", accent: "#8B5CF6", density: "spacious", recentIcons: ["icon:rocket", "🚀", "icon:rocket"] };
    const res = await ana.request("PUT", "/api/v1/me/preferences", { appearance: prefs });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.appearance, { theme: "dark", palette: "midnight", accent: "#8b5cf6", density: "spacious", recentIcons: ["icon:rocket", "🚀"] });
    assert.deepEqual((await anaLaptop.request("GET", "/api/v1/me/preferences")).body.appearance, res.body.appearance, "cross-device");
    assert.deepEqual((await vic.request("GET", "/api/v1/me/preferences")).body.appearance, {}, "not shared with colleagues");
    const user = app.db.collection("users").docs.find((u) => u.displayName === "Ana Reyes");
    assert.equal(user.status, "active"); assert.equal(user.displayName, "Ana Reyes");
    assert.equal(app.db.collection("workspaces").docs.some((w) => JSON.stringify(w).includes("midnight")), false, "never stored as workspace data");
  });

  test("validation: only known themes, palettes, densities, 6-digit HEX accents and safe icons", async () => {
    for (const appearance of [{ theme: "neon" }, { palette: "matrix" }, { accent: "red" }, { accent: "#fff" }, { accent: "#12345g" }, { density: "huge" }, { font: "x" }, { recentIcons: ["<svg onload=alert(1)>"] }, { recentIcons: Array(17).fill("🚀") }, "dark", null]) {
      assert.equal((await ana.request("PUT", "/api/v1/me/preferences", { appearance })).status, 400, JSON.stringify(appearance));
    }
    assert.equal((await ana.request("PUT", "/api/v1/me/preferences", { appearance: {}, extra: 1 })).status, 400);
    assert.equal((await ana.request("GET", "/api/v1/me/preferences")).body.appearance.palette, "midnight", "refused changes changed nothing");
  });

  test("board and workspace icons: icon names, emoji and legacy text are accepted; markup and unknown formats are refused", async () => {
    let b = board;
    // Legacy short icons with punctuation ("&", quotes) were valid before Phase 9 and stay valid (always escaped on output).
    for (const icon of ["icon:rocket", "🚀", "👩🏽‍💻", "🇵🇭", "D", "&", "O'P", ""]) {
      const r = await ana.request("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, icon });
      assert.equal(r.status, 200, `${icon} → ${JSON.stringify(r.body).slice(0, 120)}`); assert.equal(r.body.board.icon, icon); b = r.body.board;
    }
    for (const icon of ["<img src=x onerror=alert(1)>", "javascript:alert(1)", "icon:../../x", "icon:Rocket", "<svg>", "🚀🚀🚀🚀🚀🚀🚀🚀🚀", "a b", 42]) {
      assert.equal((await ana.request("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, icon })).status, 400, String(icon));
    }
    const w = (await ada.request("PATCH", `/api/v1/workspaces/${ws.id}`, { expectedVersion: ws.version, icon: "💼" })).body.workspace;
    assert.equal(w.icon, "💼");
    assert.equal((await ada.request("PATCH", `/api/v1/workspaces/${ws.id}`, { expectedVersion: w.version, icon: "<b>" })).status, 400);
    const nb = await ada.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Emoji board", icon: "📦" });
    assert.equal(nb.status, 201); assert.equal(nb.body.board.icon, "📦");
    const legacy = await ada.request("POST", "/api/v1/workspaces", { name: "#Team" });
    assert.equal(legacy.status, 201, "names starting with punctuation still get their first character as icon"); assert.equal(legacy.body.workspace.icon, "#");
  });

  test("shared icon changes follow board permissions: viewers can't; read-only synced boards refuse", async () => {
    const b = (await ana.request("GET", `/api/v1/boards/${board.id}`)).body.board;
    assert.equal((await vic.request("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, icon: "🚀" })).status, 403);
    const ro = (await ada.request("POST", `/api/v1/workspaces/${ws.id}/boards`, { name: "Synced" })).body.board;
    await app.db.collection("boards").updateOne({ _id: new ObjectId(ro.id) }, { $set: { source: { provider: "monday", sourceBoardId: "5", readOnly: true } } });
    assert.equal((await ada.request("PATCH", `/api/v1/boards/${ro.id}`, { expectedVersion: ro.version, icon: "🚀" })).body.error.code, "READ_ONLY_BOARD");
    const entry = app.db.collection("activities").docs.filter((a) => a.action === "board.updated" && a.boardId?.toHexString() === board.id).at(-1);
    assert.ok(entry, "icon changes are board updates (live updates reach colleagues)");
  });

  test("group colours: custom HEX and default (\"\") persist with IDs and order unchanged; invalid colours refused", async () => {
    const b = (await ana.request("GET", `/api/v1/boards/${board.id}`)).body.board;
    const ids = b.groups.map((g) => g.id);
    const groups = b.groups.map(({ position, ...g }, i) => ({ ...g, color: i === 0 ? "#0d9488" : "" }));
    const r = await ana.request("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: b.version, groups });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.board.groups.map((g) => [g.id, g.color]), [[ids[0], "#0d9488"], [ids[1], ""]]);
    assert.equal((await ana.request("PATCH", `/api/v1/boards/${board.id}`, { expectedVersion: r.body.board.version, groups: [{ ...groups[0], color: "teal" }, groups[1]] })).status, 400);
  });
});
