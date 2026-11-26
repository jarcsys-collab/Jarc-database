// Second independent security review of the P4 authorization foundation (d6971ca; F1-F4, F9 fixes). In-memory only.
// Plain tests pin behaviour VERIFIED to hold, and the fixes of findings R2-1…R2-8 (plan 35 §7, review 2).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { Access } = require("../src/auth/access");
const { CAP } = require("../src/auth/capabilities");
const { normaliseProjection } = require("../src/auth/authz-context");

const W1 = new ObjectId(), W2 = new ObjectId(), USER = new ObjectId();
const mk = (ws, extra = {}) => ({ _id: new ObjectId(), workspaceId: ws, name: "b", columns: [{ key: "c", type: "text" }], groups: [], ...extra });

function makeRepos({ role = null, boards = [], records = [], delay = 0 } = {}) {
  const calls = { findManyByIds: [] };
  const eq = (a, b) => String(a) === String(b);
  const members = role ? [{ workspaceId: W1, userId: USER, role, status: "active" }] : [];
  // Fresh objects per read (as the MongoDB driver returns), so identity tricks can't pass by sharing the fixture.
  const clone = (b) => ({ ...b, _id: new ObjectId(b._id.toHexString()), workspaceId: new ObjectId(b.workspaceId.toHexString()), ...(b.source ? { source: { ...b.source } } : {}), columns: b.columns.map((c) => ({ ...c })) });
  // The inclusion projection applied as MongoDB would (dotted paths), so decisions see only the projected fields.
  const project = (doc, projection) => {
    if (!projection) return doc;
    const out = {};
    for (const path of Object.keys(projection)) {
      const parts = path.split(".");
      let src = doc, dst = out;
      for (let i = 0; i < parts.length; i += 1) {
        if (src === null || typeof src !== "object" || !(parts[i] in src)) break;
        if (i === parts.length - 1) { dst[parts[i]] = src[parts[i]]; break; }
        src = src[parts[i]];
        dst = dst[parts[i]] = dst[parts[i]] && typeof dst[parts[i]] === "object" ? dst[parts[i]] : {};
      }
    }
    return out;
  };
  return {
    calls,
    memberships: {
      async findActive(ws, uid) { return members.find((m) => eq(m.workspaceId, ws) && eq(m.userId, uid)) || null; },
      async listForUser(uid) { return members.filter((m) => eq(m.userId, uid)); }
    },
    boards: {
      async findById(id) { const b = boards.find((x) => eq(x._id, id)); return b ? clone(b) : null; },
      async workspaceOf(id) { const b = boards.find((x) => eq(x._id, id)); return b ? { _id: b._id, workspaceId: b.workspaceId } : null; },
      async findManyByIds(ids, projection) {
        calls.findManyByIds.push({ n: ids.length, projection });
        if (delay) await new Promise((r) => setTimeout(r, delay));
        return boards.filter((b) => ids.some((id) => eq(id, b._id))).map((b) => project(clone(b), projection));
      }
    },
    records: { async findById(id) { return records.find((r) => eq(r._id, id)) || null; } },
    workspaces: { async findById(id) { return [W1, W2].find((w) => eq(w, id)) ? { _id: id } : null; } }
  };
}
const status = (p) => p.then(() => 200, (e) => { if (!e.status) throw e; return e.status; });
const actor = (isSystemAdmin = false) => Object.freeze({ userId: USER, kind: "entra", isSystemAdmin });

describe("verified: F1 identity (only context-loaded boards decide)", () => {
  test("Object.create, spread, structuredClone, Proxy and a board from another context are never decided", async () => {
    const b = mk(W1);
    const access = new Access(makeRepos({ role: "WORKSPACE_ADMIN", boards: [b] }), {});
    const ctx = access.context(actor()), other = access.context(actor());
    await ctx.visibility(); await other.visibility();
    const own = (await ctx.boards([b._id])).get(b._id.toHexString());
    const foreign = (await other.boards([b._id])).get(b._id.toHexString());
    assert.equal(ctx.can(CAP.BOARD_DELETE, own), true);
    const fakes = [Object.create(own), { ...own }, structuredClone(own), new Proxy(own, {}), new Proxy({}, { get: (_, k) => own[k], getPrototypeOf: () => Object.getPrototypeOf(own) }), foreign];
    for (const f of fakes) {
      assert.equal(ctx.can(CAP.BOARD_VIEW, f), false);
      assert.equal(ctx.capabilities(f).size, 0);
      assert.equal(ctx.boardRole(f), null);
    }
  });
  test("require() on a non-owned object reloads by _id: a Proxy whose _id/workspaceId lie, or an id-like object, decides nothing itself", async () => {
    const hidden = mk(W2), visible = mk(W1);
    const ctx = new Access(makeRepos({ role: "WORKSPACE_ADMIN", boards: [hidden, visible] }), {}).context(actor());
    let reads = 0;
    const liar = new Proxy({}, { get: (_, k) => { if (k === "_id") { reads += 1; return reads === 1 ? hidden._id : visible._id; } return k === "workspaceId" ? W1 : undefined; } });
    assert.equal(await status(ctx.require(CAP.BOARD_VIEW, liar)), 404); // the _id is read once, then the stored board decides
    const idLike = { toHexString: () => hidden._id.toHexString() };
    assert.equal(await status(ctx.require(CAP.BOARD_VIEW, idLike)), 404); // treated as an object: its _id (undefined) → 404
    const prototypeLie = Object.setPrototypeOf({ _id: hidden._id, workspaceId: W1 }, ObjectId.prototype); // instanceof ObjectId
    assert.equal(await status(ctx.require(CAP.BOARD_VIEW, prototypeLie)), 404);
  });
  test("string vs ObjectId ids share one cache entry and one read; invalid ids never read", async () => {
    const b = mk(W1);
    const repos = makeRepos({ role: "VIEWER", boards: [b] });
    const ctx = new Access(repos, {}).context(actor());
    const m = await ctx.boards([b._id, b._id.toHexString(), new ObjectId(b._id.toHexString()), "zz", "", null, undefined, 42, {}, "x".repeat(24)]);
    assert.equal(m.size, 1);
    assert.equal(repos.calls.findManyByIds.length, 1);
    assert.equal(repos.calls.findManyByIds[0].n, 1);
  });
  test("404 vs 403 never reveals existence: missing, hidden, outside a token and an invalid id are the same 404", async () => {
    const hidden = mk(W2), mine = mk(W1);
    const access = new Access(makeRepos({ role: "VIEWER", boards: [hidden, mine] }), {});
    const errs = await Promise.all([new ObjectId(), hidden._id, "nope"].map((id) => access.context(actor()).require(CAP.BOARD_DELETE, id).catch((e) => e)));
    for (const e of errs) { assert.equal(e.status, 404); assert.equal(e.message, errs[0].message); }
    assert.equal(await status(access.context(actor()).require(CAP.BOARD_DELETE, mine._id)), 403); // visible: 403 as today
    const tctx = access.context(actor(), { mode: "token", boardIds: [mine._id], workspaceIds: [W1, W2] });
    const terr = await tctx.require(CAP.BOARD_VIEW, hidden._id).catch((e) => e);
    assert.equal(terr.status, 404); assert.equal(terr.message, errs[0].message);
  });
});

describe("verified: F3 projections and F4 bound", () => {
  test("string '1', numbers other than 1, dotted / $ / empty segments and collisions are refused", () => {
    for (const bad of [{ a: "1" }, { a: 2 }, { a: 1.0000001 }, { a: false }, { "a..b": 1 }, { ".a": 1 }, { "a.": 1 }, { $a: 1 }, { a: 1, "a.b": 1 }, { _id: 1, "_id.x": 1 }, { "_id.x": 1 }, { "source.readOnly.x": 1 }]) {
      assert.throws(() => normaliseProjection(bad), /AuthzContext\.boards/, JSON.stringify(bad));
    }
    // A getter that changes its value is read once; the projection sent is rebuilt (always 1).
    let n = 0;
    const flip = Object.defineProperty({}, "columns", { enumerable: true, get: () => (n++ === 0 ? 1 : 0) });
    assert.deepEqual(normaliseProjection(flip).proj, { _id: 1, columns: 1, "source.readOnly": 1, workspaceId: 1 });
    // Inherited keys are ignored (Object.keys): a prototype can't add an exclusion.
    const inh = Object.create({ workspaceId: 0 }); inh.name = 1;
    assert.deepEqual(normaliseProjection(inh).proj, { _id: 1, name: 1, "source.readOnly": 1, workspaceId: 1 });
  });
  test("the bound counts distinct normalised ids (ObjectId + hex of one board = 1)", async () => {
    const ids = Array.from({ length: 500 }, () => new ObjectId());
    const ctx = new Access(makeRepos({ role: "VIEWER" }), {}).context(actor());
    assert.equal((await ctx.boards([...ids, ...ids.map((i) => i.toHexString())])).size, 500);
    await assert.rejects(() => ctx.boards([...ids, new ObjectId()]), (e) => e.code === "TOO_MANY_BOARDS");
  });
});

describe("verified: token context", () => {
  test("a token context's caps are read-only even if the owner is a real WORKSPACE_ADMIN, and a board moved out of the token's workspaces is hidden", async () => {
    const b = mk(W1), moved = mk(W2);
    const access = new Access(makeRepos({ role: "WORKSPACE_ADMIN", boards: [b, moved] }), { policy: "development_shared" });
    const ctx = access.context(actor(true), { mode: "token", boardIds: [b._id, moved._id], workspaceIds: [W1] });
    await ctx.visibility();
    const m = await ctx.boards([b._id, moved._id]);
    assert.deepEqual([...ctx.capabilities(m.get(b._id.toHexString()))].sort(), [CAP.BOARD_VIEW, CAP.RECORD_VIEW].sort());
    assert.equal(ctx.can(CAP.BOARD_VIEW, m.get(moved._id.toHexString())), false);
    assert.equal(ctx.realRole(W1), "WORKSPACE_ADMIN"); // never SYSTEM_ADMIN
  });
});

describe("findings R2-1…R2-8 (fixed)", () => {
  test("R2-1: the capability Set handed out can't be changed to grant a capability later in the request", async () => {
    const b = mk(W1);
    const ctx = new Access(makeRepos({ role: "VIEWER", boards: [b] }), {}).context(actor());
    const { caps, board } = await ctx.require(CAP.BOARD_VIEW, b._id);
    try { caps.add(CAP.BOARD_DELETE); } catch { /* immutable: fine */ }
    assert.equal(ctx.can(CAP.BOARD_DELETE, board), false);
    assert.equal(await status(ctx.require(CAP.BOARD_DELETE, b._id)), 403);
  });
  test("R2-2: the memberships Map behind visibility() can't be changed to raise a role", async () => {
    const hidden = mk(W2);
    const ctx = new Access(makeRepos({ role: "VIEWER", boards: [hidden] }), {}).context(actor());
    const v = await ctx.visibility();
    try { v.roles.set(W2.toHexString(), "WORKSPACE_ADMIN"); } catch { /* immutable: fine */ }
    assert.equal(await status(ctx.require(CAP.BOARD_DELETE, hidden._id)), 404);
  });
  test("R2-3: a sealed board's workspaceId (an ObjectId) can't be rewritten in place to move the decision", async () => {
    const hidden = mk(W2), mine = mk(W1);
    const ctx = new Access(makeRepos({ role: "WORKSPACE_ADMIN", boards: [hidden, mine] }), {}).context(actor());
    await ctx.visibility();
    const m = await ctx.boards([hidden._id, mine._id]);
    const hb = m.get(hidden._id.toHexString());
    assert.equal(ctx.can(CAP.BOARD_VIEW, hb), false);
    try { Object.assign(hb.workspaceId, { i0: W1.i0, i1: W1.i1, i2: W1.i2, i3: W1.i3 }); } catch { /* frozen: fine */ }
    assert.equal(ctx.can(CAP.BOARD_DELETE, hb), false);
  });
  test("R2-4: the context's mode and token sets can't be switched by a caller", async () => {
    const b = mk(W1);
    const ctx = new Access(makeRepos({ role: "WORKSPACE_ADMIN", boards: [b] }), {}).context(actor(), { mode: "token", boardIds: [], workspaceIds: [] });
    try { ctx.mode = "session"; } catch { /* fine */ }
    try { ctx.tokenBoards.add(b._id.toHexString()); ctx.tokenWorkspaces.add(W1.toHexString()); } catch { /* fine */ }
    await ctx.visibility();
    assert.equal(await status(ctx.require(CAP.BOARD_DELETE, b._id)), 404);
  });
  test("R2-5: concurrent ctx.boards calls for the same id share one read (and one sealed object)", async () => {
    const b = mk(W1);
    const repos = makeRepos({ role: "VIEWER", boards: [b], delay: 5 });
    const ctx = new Access(repos, {}).context(actor());
    const [m1, m2] = await Promise.all([ctx.boards([b._id]), ctx.boards([b._id])]);
    assert.equal(repos.calls.findManyByIds.length, 1);
    assert.equal(m1.get(b._id.toHexString()), m2.get(b._id.toHexString()));
  });
  test("R2-6: an uppercase hex id finds the board, as parseId (validation/common.js) does today", async () => {
    const b = mk(W1);
    const ctx = new Access(makeRepos({ role: "VIEWER", boards: [b] }), {}).context(actor());
    assert.equal(await status(ctx.require(CAP.BOARD_VIEW, b._id.toHexString().toUpperCase())), 200);
  });
  test("R2-7: a positional / operator path segment ('columns.$') is refused like a leading $", () => {
    for (const bad of [{ "columns.$": 1 }, { "columns.$[]": 1 }, { "a.$b.c": 1 }]) assert.throws(() => normaliseProjection(bad), /AuthzContext\.boards/, JSON.stringify(bad));
    assert.ok(normaliseProjection({ "a$b": 1 })); // a "$" inside a segment is a plain field name
  });
  test("R2-8: under shared access a real MEMBER asking workspace.manageMembers gets Access.check's message", async () => {
    const b = mk(W1);
    const access = new Access(makeRepos({ role: "MEMBER", boards: [b] }), { policy: "development_shared" });
    const want = await access.workspace(actor(), W1, "WORKSPACE_ADMIN", { membershipOnly: true }).catch((e) => e);
    const got = await access.context(actor()).require(CAP.WORKSPACE_MEMBERS, b._id).catch((e) => e);
    assert.equal(got.status, want.status);
    assert.equal(got.message, want.message);
    // With NO real row the members-only message stays (Access.check's, as before).
    const none = new Access(makeRepos({ boards: [b] }), { policy: "development_shared" });
    const want2 = await none.workspace(actor(), W1, "WORKSPACE_ADMIN", { membershipOnly: true }).catch((e) => e);
    const got2 = await none.context(actor()).require(CAP.WORKSPACE_MEMBERS, b._id).catch((e) => e);
    assert.equal(got2.status, want2.status);
    assert.equal(got2.message, want2.message);
  });
});

describe("review-2 follow-ups", () => {
  test("no public mutable state: the instance is frozen, internals are #private, stats and visibility are copies", async () => {
    const b = mk(W1);
    const ctx = new Access(makeRepos({ role: "VIEWER", boards: [b] }), {}).context(actor());
    assert.ok(Object.isFrozen(ctx));
    for (const k of ["access", "repos", "tokenBoards", "tokenWorkspaces", "_own", "_caps", "_loaded", "_boards", "_visibility"]) assert.equal(ctx[k], undefined, k);
    try { ctx.can = () => true; } catch { /* strict mode: TypeError */ }
    assert.equal(Object.prototype.hasOwnProperty.call(ctx, "can"), false); // a frozen instance can't shadow a method
    const v = await ctx.visibility();
    assert.ok(Object.isFrozen(v)); assert.deepEqual(Object.keys(v).sort(), ["global", "systemAdmin"]);
    const s = ctx.stats; s.boardReads = 99; assert.equal(ctx.stats.boardReads, 0);
    assert.ok(Object.isFrozen(ctx.actor));
  });
  test("a failed in-flight read is not memoised; the next call reads again", async () => {
    const b = mk(W1);
    const repos = makeRepos({ role: "VIEWER", boards: [b] });
    const real = repos.boards.findManyByIds;
    let fail = true;
    repos.boards.findManyByIds = async (...a) => { if (fail) { fail = false; throw new Error("db down"); } return real(...a); };
    const ctx = new Access(repos, {}).context(actor());
    await assert.rejects(() => ctx.boards([b._id]), /db down/);
    assert.equal((await ctx.boards([b._id])).size, 1);
    assert.ok((await ctx.boards([b._id])).get(b._id.toHexString()));
  });
  test("the per-context cache is bounded (MAX_CONTEXT_BOARDS entries)", async () => {
    const { MAX_CONTEXT_BOARDS, MAX_BOARD_IDS } = require("../src/auth/authz-context");
    assert.equal(MAX_CONTEXT_BOARDS, 2000);
    const repos = makeRepos({ role: "VIEWER" });
    const ctx = new Access(repos, {}).context(actor());
    for (let i = 0; i < MAX_CONTEXT_BOARDS / MAX_BOARD_IDS; i += 1) await ctx.boards(Array.from({ length: MAX_BOARD_IDS }, () => new ObjectId()));
    const reads = repos.calls.findManyByIds.length;
    await assert.rejects(() => ctx.boards([new ObjectId()]), (e) => e.status === 400 && e.code === "TOO_MANY_BOARDS");
    assert.equal(repos.calls.findManyByIds.length, reads);
  });
  test("a projected read keeps the authorization fields: a read-only board stays read-only through any projection", async () => {
    const ro = mk(W1, { source: { provider: "monday", readOnly: true } });
    const repos = makeRepos({ role: "WORKSPACE_ADMIN", boards: [ro] });
    const ctx = new Access(repos, {}).context(actor());
    await ctx.visibility();
    for (const p of [{ name: 1 }, { columns: 1 }, { source: 1 }, { "source.provider": 1 }]) {
      const fresh = new Access(repos, {}).context(actor());
      await fresh.visibility();
      const lb = (await fresh.boards([ro._id], p)).get(ro._id.toHexString());
      assert.equal(lb.source.readOnly, true, JSON.stringify(p));
      assert.equal(fresh.can(CAP.RECORD_CREATE, lb), false, JSON.stringify(p));
      assert.equal(fresh.can(CAP.BOARD_VIEW, lb), true, JSON.stringify(p));
    }
  });
});
