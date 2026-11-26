// Independent security review of the P4 authorization foundation (fb1b301; plan 35). In-memory only: no MongoDB, no network.
// Plain tests pin behaviour the review VERIFIED. Tests marked { todo } state the behaviour the review asks for before merge
// (findings F1–F5 in plan 35); they report as TODO, not as failures, and start passing when the finding is fixed.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { ObjectId } = require("mongodb");
const { Access } = require("../src/auth/access");
const { CAP, TOKEN_CAPS, ALL_CAPS } = require("../src/auth/capabilities");
const { ApiTokenService } = require("../src/services/api-token-service");

const W1 = new ObjectId(), W2 = new ObjectId(), USER = new ObjectId();
const mk = (ws, extra = {}) => ({ _id: new ObjectId(), workspaceId: ws, name: "b", columns: [], groups: [], ...extra });

function makeRepos({ role = null, boards = [], records = [], workspaces = [W1, W2] } = {}) {
  const calls = { findManyByIds: [] };
  const eq = (a, b) => String(a) === String(b);
  const members = role ? [{ workspaceId: W1, userId: USER, role, status: "active" }] : [];
  return {
    calls,
    memberships: {
      async findActive(ws, uid) { return members.find((m) => eq(m.workspaceId, ws) && eq(m.userId, uid)) || null; },
      async listForUser(uid) { return members.filter((m) => eq(m.userId, uid)); }
    },
    boards: {
      async findById(id) { return boards.find((b) => eq(b._id, id)) || null; },
      async workspaceOf(id) { const b = boards.find((x) => eq(x._id, id)); return b ? { _id: b._id, workspaceId: b.workspaceId } : null; },
      async findManyByIds(ids, projection) { calls.findManyByIds.push({ n: ids.length, projection }); return boards.filter((b) => ids.some((id) => eq(id, b._id))); }
    },
    records: { async findById(id) { return records.find((r) => eq(r._id, id)) || null; } },
    workspaces: { async findById(id) { return workspaces.find((w) => eq(w, id)) ? { _id: id } : null; } },
    users: { async findById(id) { return eq(id, USER) ? { _id: USER, status: "active", tenantId: "t" } : null; } },
    apiTokens: { async appendAudit() {} }
  };
}
const status = (p) => p.then(() => 200, (e) => { if (!e.status) throw e; return e.status; });
const actor = (isSystemAdmin = false) => Object.freeze({ userId: USER, kind: "entra", isSystemAdmin });

describe("verified: ID spoofing and board-workspace alignment", () => {
  test("a record ID given as a board ID, and a board ID given as a record ID, are 404 (never another object's access)", async () => {
    const b = mk(W1), r = { _id: new ObjectId(), boardId: b._id, workspaceId: W1 };
    const repos = makeRepos({ role: "WORKSPACE_ADMIN", boards: [b], records: [r] });
    const ctx = new Access(repos, { policy: "development_shared" }).context(actor());
    assert.equal(await status(ctx.require(CAP.BOARD_VIEW, r._id)), 404);
    assert.equal(await status(ctx.requireRecord(CAP.RECORD_VIEW, b._id)), 404);
  });
  test("a record whose stored workspace copy points at a workspace the caller can't see is decided by its board", async () => {
    const b = mk(W1), r = { _id: new ObjectId(), boardId: b._id, workspaceId: W2 };
    const repos = makeRepos({ role: "VIEWER", boards: [b], records: [r] });
    const ctx = new Access(repos, {}).context(actor());
    const { record } = await ctx.requireRecord(CAP.RECORD_VIEW, r._id);
    assert.equal(String(record.workspaceId), String(W1));
    // and the reverse: a record copy that claims a visible workspace on a board in a hidden one is 404
    const hidden = mk(W2), r2 = { _id: new ObjectId(), boardId: hidden._id, workspaceId: W1 };
    const ctx2 = new Access(makeRepos({ role: "WORKSPACE_ADMIN", boards: [hidden], records: [r2] }), {}).context(actor());
    assert.equal(await status(ctx2.requireRecord(CAP.RECORD_VIEW, r2._id)), 404);
  });
});

describe("verified: token identity and scope", () => {
  const settings = [{ policy: "role_based" }, { policy: "development_shared" }, { policy: "role_based", betaOpenEditing: true }];
  test("a token never holds more than board.view / record.view, even for a SYSTEM_ADMIN session actor or a real WORKSPACE_ADMIN owner", async () => {
    for (const s of settings) {
      const b = mk(W1);
      const access = new Access(makeRepos({ role: "WORKSPACE_ADMIN", boards: [b] }), s);
      const ctx = access.context(actor(true), { mode: "token", boardIds: [b._id], workspaceIds: [W1] });
      await ctx.visibility();
      assert.deepEqual([...ctx.capabilities(b)].sort(), [...TOKEN_CAPS].sort(), JSON.stringify(s));
      for (const cap of ALL_CAPS.filter((c) => !TOKEN_CAPS.has(c))) assert.equal(await status(ctx.require(cap, b._id)), 403, cap);
      assert.equal(await ctx.canSeeEvent({ workspaceId: W1.toHexString() }), false);
    }
  });
  test("a Fabric-shaped token (no boards, no workspaces) reaches nothing", async () => {
    const b = mk(W1);
    const access = new Access(makeRepos({ role: "WORKSPACE_ADMIN", boards: [b] }), { policy: "development_shared" });
    const ctx = access.context(actor(), { mode: "token", boardIds: [], workspaceIds: [] });
    await ctx.visibility();
    assert.equal(ctx.can(CAP.BOARD_VIEW, b), false);
    assert.equal(await status(ctx.require(CAP.BOARD_VIEW, b._id)), 404);
    assert.equal(ctx.visibleWorkspaceIds().size, 0);
  });
  test("S0-A restrictedFor (80defa9 external-api.js) is ctx.can(BOARD_VIEW, target) with workspaceIds = authorize().workspaceIds", async () => {
    for (const s of settings) for (const role of [null, "VIEWER"]) {
      const host = mk(W1), inBoth = mk(W1), notInToken = mk(W1), movedOut = mk(W2), archived = mk(W1, { archived: true });
      const repos = makeRepos({ role, boards: [host, inBoth, notInToken, movedOut, archived] });
      const access = new Access(repos, s);
      const tokens = new ApiTokenService({ repos }).configure({ key: crypto.randomBytes(32), access, tenantId: "t" });
      const doc = { ownerUserId: USER, scopes: ["read"], workspaceIds: [W1], boardIds: [host._id, inBoth._id, movedOut._id, archived._id] };
      let authorized;
      try { authorized = await tokens.authorize(doc); } catch (e) { assert.equal(e.status, 403, String(e.stack)); continue; } // owner can read nothing
      const tokenBoards = new Set(doc.boardIds.map(String)), tokenSpaces = new Set(authorized.workspaceIds.map(String));
      const restrictedFor = (target) => tokenBoards.has(String(target._id)) && tokenSpaces.has(String(target.workspaceId)); // 80defa9 :232-244
      const ctx = access.context(authorized.actor, { mode: "token", boardIds: doc.boardIds, workspaceIds: authorized.workspaceIds });
      await ctx.visibility();
      const loaded = await ctx.boards([inBoth, notInToken, movedOut, archived].map((b) => b._id), { columns: 1 });
      for (const t of loaded.values()) assert.equal(ctx.can(CAP.BOARD_VIEW, t), restrictedFor(t), `${JSON.stringify(s)} ${role}`);
      // As restrictedFor, the context ignores `archived`: scopedBoard's archived filter must stay in the route (plan 30 §8).
      assert.equal(ctx.can(CAP.BOARD_VIEW, archived), true);
    }
  });
});

describe("verified: performance (no N+1)", () => {
  test("Mirror-style batch: N records over a few boards is one board read whatever N is", async () => {
    const targets = [mk(W1), mk(W1), mk(W2)];
    const repos = makeRepos({ role: "MEMBER", boards: targets });
    const ctx = new Access(repos, {}).context(actor());
    await ctx.visibility();
    const linkedBoardIds = Array.from({ length: 500 }, (_, i) => targets[i % 3]._id);
    const loaded = await ctx.boards(linkedBoardIds, { columns: 1 });
    assert.equal(loaded.size, 3);
    assert.equal(repos.calls.findManyByIds.length, 1);
    assert.equal(repos.calls.findManyByIds[0].n, 3);
  });
});

describe("findings (todo until fixed; plan 35)", () => {
  test("F1: can() on a board object without `source` (e.g. findSummariesByIds) must not treat a read-only board as writable", { todo: "F1: only ctx-loaded boards (or boards carrying source) may be decided" }, async () => {
    const ro = mk(W1, { source: { provider: "monday", readOnly: true } });
    const summary = { _id: ro._id, workspaceId: ro.workspaceId, name: ro.name, archived: false, position: 1 }; // findSummariesByIds projection
    const ctx = new Access(makeRepos({ role: "MEMBER", boards: [ro] }), {}).context(actor());
    await ctx.visibility();
    assert.equal(ctx.can(CAP.RECORD_EDIT_VALUES, summary), false);
  });
  test("F1b: require() given a caller-built object must not trust its workspaceId", { todo: "F1: require(cap, object) skips the database" }, async () => {
    const hidden = mk(W2);
    const ctx = new Access(makeRepos({ role: "WORKSPACE_ADMIN", boards: [hidden] }), {}).context(actor());
    const spoofed = { _id: hidden._id, workspaceId: W1 }; // e.g. built from a request body
    assert.equal(await status(ctx.require(CAP.RECORD_CREATE, spoofed)), 404);
  });
  test("F2: memoised boards must not be shared mutable state (a mutated board must not change later decisions)", { todo: "F2: freeze or copy memoised boards" }, async () => {
    const b = mk(W1);
    const ctx = new Access(makeRepos({ role: "WORKSPACE_ADMIN", boards: [b] }), {}).context(actor());
    const { board } = await ctx.require(CAP.BOARD_MOVE, b._id);
    try { board.workspaceId = W2; } catch { /* frozen: fine */ }
    assert.equal(await status(ctx.require(CAP.BOARD_VIEW, b._id)), 200);
  });
  test("F3: the projection cache key must include values ({columns:0} is not {columns:1})", { todo: "F3: key by JSON of sorted entries; refuse exclusion projections" }, async () => {
    const b = mk(W1);
    const repos = makeRepos({ role: "VIEWER", boards: [b] });
    const ctx = new Access(repos, {}).context(actor());
    await ctx.boards([b._id], { columns: 1 });
    await ctx.boards([b._id], { columns: 0 });
    assert.equal(repos.calls.findManyByIds.length, 2);
  });
  test("F4: ctx.boards / findManyByIds must be bounded", { todo: "F4: refuse (or chunk) more than a fixed number of IDs" }, async () => {
    const repos = makeRepos({ role: "VIEWER" });
    const ctx = new Access(repos, {}).context(actor());
    await assert.rejects(() => ctx.boards(Array.from({ length: 5001 }, () => new ObjectId())));
  });
  test("F5: workspace.manageMembers on a board whose workspace is gone is 404 for SYSTEM_ADMIN, as access.workspace", { todo: "F5: workspace-level caps need the workspace (D-C7)" }, async () => {
    const orphan = mk(new ObjectId());
    const repos = makeRepos({ boards: [orphan] });
    const access = new Access(repos, {});
    const today = await status(access.workspace(actor(true), orphan.workspaceId, "WORKSPACE_ADMIN", { membershipOnly: true }));
    assert.equal(today, 404);
    assert.equal(await status(access.context(actor(true)).require(CAP.WORKSPACE_MEMBERS, orphan._id)), today);
  });
  test("D-C6 divergence: form.design on an existing read-only board form is refused by the context but allowed today", async () => {
    const ro = mk(W1, { source: { provider: "monday", readOnly: true } });
    const access = new Access(makeRepos({ role: "WORKSPACE_ADMIN", boards: [ro] }), {});
    assert.equal(await status(access.board(actor(), ro._id, "WORKSPACE_ADMIN")), 200); // forms.js formFor(W) update/delete: no read-only guard
    assert.equal(await status(access.context(actor()).require(CAP.FORM_DESIGN, ro._id)), 403); // must not be wired before D-C6
  });
});
