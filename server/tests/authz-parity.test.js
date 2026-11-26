// P4 shared authorization contract (plans 27 + 30): the capability layer (auth/capabilities.js, auth/authz-context.js,
// Access.context) gives EXACTLY today's decisions. Expected values are never re-encoded here: each one is obtained by calling the
// EXISTING paths a route uses today (Access.board / record / workspace / check / roleIn with membershipOnly, the read-only
// guards, CommentService.isModerator, ApiTokenService.roleOf, SearchService.canEdit, the /events visibility rule).
// No MongoDB, no network: in-memory repositories with read counters.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ObjectId } = require("mongodb");
const { Access } = require("../src/auth/access");
const { AuthzContext } = require("../src/auth/authz-context");
const caps = require("../src/auth/capabilities");
const { CommentService } = require("../src/services/comment-service");
const { ApiTokenService } = require("../src/services/api-token-service");
const { SearchService } = require("../src/services/search-service");

const { CAP } = caps;
const READ_ONLY = (board) => { if (board?.source?.readOnly) { const e = new Error("read-only"); e.status = 403; e.code = "READ_ONLY_BOARD"; throw e; } };

// ---- In-memory data: two workspaces; the person's memberships are only ever in W1.
const W1 = new ObjectId(), W2 = new ObjectId(), USER = new ObjectId();
const board = (ws, readOnly) => ({ _id: new ObjectId(), workspaceId: ws, name: "b", columns: [], groups: [], ...(readOnly ? { source: { provider: "monday", readOnly: true } } : {}) });
const BOARDS = { mine: board(W1, false), mineRO: board(W1, true), other: board(W2, false), otherRO: board(W2, true) };
const RECORDS = Object.fromEntries(Object.entries(BOARDS).map(([k, b]) => [k, { _id: new ObjectId(), boardId: b._id, workspaceId: b.workspaceId, values: {} }]));

function makeRepos(membershipRole) {
  const counts = { findActive: 0, listForUser: 0, boardFindById: 0, workspaceOf: 0, findManyByIds: 0, recordFindById: 0 };
  const boards = Object.values(BOARDS), records = Object.values(RECORDS);
  const members = membershipRole ? [{ workspaceId: W1, userId: USER, role: membershipRole, status: "active" }] : [];
  const eq = (a, b) => String(a) === String(b);
  const repos = {
    counts,
    memberships: {
      async findActive(ws, uid) { counts.findActive += 1; return members.find((m) => eq(m.workspaceId, ws) && eq(m.userId, uid)) || null; },
      async listForUser(uid) { counts.listForUser += 1; return members.filter((m) => eq(m.userId, uid)); }
    },
    boards: {
      async findById(id) { counts.boardFindById += 1; return boards.find((b) => eq(b._id, id)) || null; },
      async workspaceOf(id) { counts.workspaceOf += 1; const b = boards.find((x) => eq(x._id, id)); return b ? { _id: b._id, workspaceId: b.workspaceId } : null; },
      async findManyByIds(ids) { counts.findManyByIds += 1; return boards.filter((b) => ids.some((id) => eq(id, b._id))); }
    },
    records: { async findById(id) { counts.recordFindById += 1; return records.find((r) => eq(r._id, id)) || null; } },
    workspaces: { async findById(id) { return [W1, W2].find((w) => eq(w, id)) ? { _id: id } : null; } }
  };
  return repos;
}

// ---- Today's route recipes: one per capability, made only of the existing calls (route file cited).
// Each returns normally (allowed) or throws (status 403 / 404).
const comments = (access, repos) => Object.assign(new CommentService({ repos, access }), {});
const RECIPES = {
  [CAP.BOARD_VIEW]: ({ access, actor, b }) => access.board(actor, b._id, "VIEWER"), // resources GET /boards/:id
  [CAP.RECORD_VIEW]: ({ access, actor, r }) => access.record(actor, r._id, "VIEWER"), // resources GET /records/:id
  [CAP.VIEWS_PERSONAL]: ({ access, actor, b }) => access.board(actor, b._id, "VIEWER"), // PATCH board, viewsOnly (read-only allowed)
  [CAP.RECORD_EDIT_VALUES]: async ({ access, actor, r, b }) => { await access.record(actor, r._id, "MEMBER"); READ_ONLY(b); }, // PATCH /records/:id
  [CAP.RECORD_CREATE]: async ({ access, actor, b }) => { await access.board(actor, b._id, "MEMBER"); READ_ONLY(b); }, // POST records
  [CAP.RECORD_DELETE]: async ({ access, actor, r, b }) => { await access.record(actor, r._id, "MEMBER"); READ_ONLY(b); }, // DELETE /records/:id
  [CAP.FORM_SUBMIT]: async ({ access, actor, b }) => { await access.board(actor, b._id, "MEMBER"); READ_ONLY(b); }, // forms submit + form-service
  [CAP.BOARD_STRUCTURE]: async ({ access, actor, b }) => { await access.board(actor, b._id, "MEMBER"); READ_ONLY(b); }, // PATCH name / group delete
  [CAP.BOARD_ORGANIZE]: ({ access, actor, b }) => access.board(actor, b._id, "MEMBER"), // PATCH savedViews / position (read-only allowed)
  [CAP.COLUMN_CREATE]: async ({ access, actor, b }) => { await access.board(actor, b._id, "MEMBER"); READ_ONLY(b); }, // POST columns
  [CAP.COLUMN_MODIFY]: async ({ access, actor, b }) => { await access.board(actor, b._id, "MEMBER"); READ_ONLY(b); }, // PUT options (add)
  [CAP.COLUMN_DESTRUCTIVE]: async ({ access, actor, b }) => { await access.board(actor, b._id, "WORKSPACE_ADMIN"); READ_ONLY(b); }, // DELETE column
  [CAP.COLUMN_CONVERT]: async ({ access, actor, b }) => { await access.board(actor, b._id, "WORKSPACE_ADMIN"); READ_ONLY(b); }, // POST type
  [CAP.CONNECT_CONFIGURE]: async ({ access, actor, b }) => { await access.board(actor, b._id, "MEMBER"); READ_ONLY(b); }, // POST columns (host)
  [CAP.MIRROR_CONFIGURE]: async ({ access, actor, b }) => { await access.board(actor, b._id, "MEMBER"); READ_ONLY(b); },
  [CAP.FORM_DESIGN]: async ({ access, actor, b }) => { await access.board(actor, b._id, "WORKSPACE_ADMIN"); READ_ONLY(b); }, // POST forms + form-service.create
  [CAP.BOARD_ARCHIVE]: async ({ access, actor, b }) => { const { role } = await access.board(actor, b._id, "MEMBER"); if (!Access.atLeast(role, "WORKSPACE_ADMIN")) throw Object.assign(new Error("x"), { status: 403, code: "FORBIDDEN" }); },
  [CAP.BOARD_DELETE]: ({ access, actor, b }) => access.board(actor, b._id, "WORKSPACE_ADMIN"),
  [CAP.BOARD_MOVE]: ({ access, actor, b }) => access.board(actor, b._id, "WORKSPACE_ADMIN"),
  // No route yet: the wip definition (a real WORKSPACE_ADMIN row of the board's workspace, or SYSTEM_ADMIN), on a visible board.
  [CAP.BOARD_PERMISSIONS]: async ({ access, actor, b }) => { await access.board(actor, b._id, "VIEWER"); await access.check(actor, b.workspaceId, "WORKSPACE_ADMIN", "workspace", { membershipOnly: true }); },
  [CAP.WORKSPACE_MEMBERS]: ({ access, actor, b }) => access.workspace(actor, b.workspaceId, "WORKSPACE_ADMIN", { membershipOnly: true }), // routes/members.js
  // routes/comments.js DELETE (forComment VIEWER) → comment-service.remove: writable(board) then isModerator.
  [CAP.COMMENT_MODERATE]: async ({ access, actor, repos, r, b }) => { await access.record(actor, r._id, "VIEWER"); READ_ONLY(b); if (!await comments(access, repos).isModerator(actor, r.workspaceId)) throw Object.assign(new Error("x"), { status: 403, code: "FORBIDDEN" }); }
};
const outcome = async (fn) => { try { await fn(); return { status: 200 }; } catch (e) { if (!e.status) throw e; return { status: e.status, code: e.code }; } };

// ---- The matrix
const POLICIES = ["role_based", "development_shared"], BETA = [false, true], ACCOUNT_MODES = ["off", "staged", "enforced"];
const PERSONAS = ["none", "VIEWER", "MEMBER", "WORKSPACE_ADMIN", "SYSTEM_ADMIN"];
const ACCOUNTS = { off: [null], staged: ["legacy", "ADMIN", "EDITOR", "VIEWER", "pending"], enforced: ["legacy", "ADMIN", "EDITOR", "VIEWER", "pending"] };
const accountObject = (a) => (a === null ? undefined : a === "legacy" ? Object.freeze({ legacy: true, status: null, role: null }) : a === "pending" ? Object.freeze({ legacy: false, status: "pending", role: null }) : Object.freeze({ legacy: false, status: "active", role: a }));
function* settings() {
  for (const policy of POLICIES) for (const betaOpenEditing of BETA) for (const accountMode of ACCOUNT_MODES) for (const persona of PERSONAS) for (const account of ACCOUNTS[accountMode]) yield { policy, betaOpenEditing, accountMode, persona, account };
}
const label = (s, extra = "") => `${s.policy}/beta=${s.betaOpenEditing}/accounts=${s.accountMode}/${s.persona}/${s.account ?? "-"}${extra}`;
function world(s) {
  const repos = makeRepos(["VIEWER", "MEMBER", "WORKSPACE_ADMIN"].includes(s.persona) ? s.persona : null);
  const access = new Access(repos, { policy: s.policy, betaOpenEditing: s.betaOpenEditing, accountMode: s.accountMode });
  const actor = Object.freeze({ userId: USER, kind: "entra", isSystemAdmin: s.persona === "SYSTEM_ADMIN", account: accountObject(s.account) });
  return { repos, access, actor };
}

describe("capability definitions", () => {
  test("every capability has a minimum; real-row and token sets are capabilities; the ladder maps today's roles", () => {
    for (const cap of caps.ALL_CAPS) assert.ok(caps.BOARD_RANK[caps.MIN_BOARD_ROLE[cap]], cap);
    for (const cap of [...caps.REAL_ROW, ...caps.READ_ONLY_KEEPS, ...caps.TOKEN_CAPS]) assert.ok(caps.isCap(cap), cap);
    assert.deepEqual(caps.TODAY_TO_BOARD, { VIEWER: "VIEWER", MEMBER: "EDITOR", WORKSPACE_ADMIN: "OWNER", SYSTEM_ADMIN: "OWNER" });
    assert.equal(caps.mapToday(null), null);
    assert.equal(caps.mapToday("CONTRIBUTOR"), null);
    assert.ok(Object.isFrozen(caps.capabilitiesFor({ boardRole: "OWNER" })));
    assert.equal(caps.capabilitiesFor({ boardRole: null }).size, 0);
    assert.deepEqual(Object.keys(RECIPES).sort(), [...caps.ALL_CAPS].sort(), "every capability has a today recipe");
  });
  test("capabilities.js requires nothing (worker-thread safe)", () => {
    const text = fs.readFileSync(path.join(__dirname, "../src/auth/capabilities.js"), "utf8");
    assert.equal(/\brequire\(\s*["']/.test(text), false);
  });
});

describe("session parity: ctx.can / ctx.require equal today's route checks", () => {
  test("policy × beta × account mode × persona × account × board (own / other workspace, read-only or not) × capability", async () => {
    let cells = 0;
    const mismatches = [];
    for (const s of settings()) {
      for (const [bk, b] of Object.entries(BOARDS)) {
        const r = RECORDS[bk];
        const { repos, access, actor } = world(s);
        const ctx = access.context(actor);
        assert.ok(ctx instanceof AuthzContext);
        await ctx.visibility();
        // can() decides only boards the context loaded (plan 35 F1): the same stored board, through ctx.boards.
        const loadedB = (await ctx.boards([b._id])).get(b._id.toHexString());
        for (const cap of caps.ALL_CAPS) {
          cells += 1;
          const today = await outcome(() => RECIPES[cap]({ access, actor, repos, b, r }));
          const isRecordCap = [CAP.RECORD_VIEW, CAP.RECORD_EDIT_VALUES, CAP.RECORD_DELETE, CAP.COMMENT_MODERATE].includes(cap);
          const viaCtx = await outcome(() => (isRecordCap ? ctx.requireRecord(cap, r._id) : ctx.require(cap, b._id)));
          const allowed = ctx.can(cap, loadedB);
          // Status always; the error code too, except comment moderation, where today the read-only guard runs before the
          // moderator check (READ_ONLY_BOARD vs FORBIDDEN, both 403: plan 30 §9).
          const same = today.status === viaCtx.status && allowed === (today.status === 200) && (cap === CAP.COMMENT_MODERATE || today.code === viaCtx.code);
          if (!same) mismatches.push(`${label(s, `/${bk}`)} ${cap}: today ${JSON.stringify(today)} ctx ${JSON.stringify(viaCtx)} can=${allowed}`);
        }
      }
    }
    assert.deepEqual(mismatches.slice(0, 20), [], `${mismatches.length} mismatches`);
    assert.equal(cells, 2 * 2 * (5 + 25 + 25) * 4 * caps.ALL_CAPS.length);
  });

  test("404 / 403 messages are Access's own", async () => {
    const { access, actor } = world({ policy: "role_based", betaOpenEditing: false, accountMode: "off", persona: "VIEWER", account: null });
    const ctx = access.context(actor);
    const hidden = await outcome(() => access.board(actor, BOARDS.other._id, "VIEWER")).then(() => access.board(actor, BOARDS.other._id, "VIEWER").catch((e) => e));
    const viaCtx = await ctx.require(CAP.BOARD_VIEW, BOARDS.other._id).catch((e) => e);
    assert.equal(viaCtx.status, 404); assert.equal(viaCtx.code, "NOT_FOUND"); assert.equal(viaCtx.message, hidden.message);
    const low = await access.board(actor, BOARDS.mine._id, "MEMBER").catch((e) => e), lowCtx = await ctx.require(CAP.RECORD_CREATE, BOARDS.mine._id).catch((e) => e);
    assert.equal(lowCtx.status, 403); assert.equal(lowCtx.message, low.message);
    assert.equal((await ctx.require(CAP.BOARD_VIEW, "not-an-id").catch((e) => e)).status, 404);
    assert.equal((await ctx.require(CAP.BOARD_VIEW, new ObjectId()).catch((e) => e)).status, 404);
    assert.equal((await ctx.requireRecord(CAP.RECORD_VIEW, new ObjectId()).catch((e) => e)).message, "This record doesn't exist or was deleted.");
    assert.equal(ctx.can("no.such.cap", BOARDS.mine), false);
    await assert.rejects(() => ctx.require("no.such.cap", BOARDS.mine._id), /Unknown capability/);
    // Shared access, no real row: members management is 403 with Access.check's message.
    const shared = world({ policy: "development_shared", betaOpenEditing: false, accountMode: "off", persona: "none", account: null });
    const want = await shared.access.workspace(shared.actor, W1, "WORKSPACE_ADMIN", { membershipOnly: true }).catch((e) => e);
    const got = await shared.access.context(shared.actor).require(CAP.WORKSPACE_MEMBERS, BOARDS.mine._id).catch((e) => e);
    assert.equal(got.status, 403); assert.equal(got.message, want.message);
  });

  test("require() returns today's workspace role, so Access.atLeast callers keep working", async () => {
    for (const s of settings()) {
      const { access, actor } = world(s);
      const today = await access.board(actor, BOARDS.mine._id, "VIEWER").catch(() => null);
      const viaCtx = await access.context(actor).require(CAP.BOARD_VIEW, BOARDS.mine._id).catch(() => null);
      assert.equal(viaCtx?.role ?? null, today?.role ?? null, label(s));
    }
  });

  test("Access.can / Access.require facades agree with the context", async () => {
    const { access, actor } = world({ policy: "role_based", betaOpenEditing: false, accountMode: "off", persona: "MEMBER", account: null });
    assert.equal(await access.can(actor, CAP.COLUMN_CREATE, BOARDS.mine._id), true);
    assert.equal(await access.can(actor, CAP.COLUMN_CREATE, BOARDS.mine._id.toHexString()), true);
    assert.equal(await access.can(actor, CAP.COLUMN_DESTRUCTIVE, BOARDS.mine._id), false);
    assert.equal(await access.can(actor, CAP.BOARD_VIEW, "not-an-id"), false);
    await assert.rejects(() => access.can(actor, CAP.COLUMN_CREATE, BOARDS.mine), TypeError); // takes an ID (plan 35 F1)
    assert.equal((await access.require(actor, CAP.COLUMN_CREATE, BOARDS.mine._id)).board._id, BOARDS.mine._id);
  });

  test("a record whose board copy drifted is authorised (and returned) with its board's workspace, as Access.record", async () => {
    const { repos, access, actor } = world({ policy: "role_based", betaOpenEditing: false, accountMode: "off", persona: "MEMBER", account: null });
    // The STORED record's copy drifted (requireRecord reads the stored record; a passed object counts only for its _id).
    const drifted = { ...RECORDS.mine, workspaceId: W2 };
    repos.records.findById = async (id) => (String(id) === String(drifted._id) ? drifted : null);
    const { record } = await access.context(actor).requireRecord(CAP.RECORD_VIEW, { _id: drifted._id });
    assert.equal(String(record.workspaceId), String(W1));
    assert.equal(access.drift.count, 1);
  });

  test("search canEdit and /events visibility equal today's (SearchService.canEdit, events.js visible())", async () => {
    for (const s of settings()) {
      const { access, actor } = world(s);
      const roles = await access.visibleRoles(actor), globalRole = access.globalRole(actor);
      const roleOf = (id) => (roles ? roles.get(id.toHexString()) : globalRole);
      const ctx = access.context(actor);
      await ctx.visibility();
      const loaded = await ctx.boards(Object.values(BOARDS).map((b) => b._id), { name: 1 });
      for (const b of Object.values(BOARDS)) {
        // SearchService.scope only lists boards of visible workspaces; canEdit is asked of those.
        const listed = !roles || roles.has(b.workspaceId.toHexString());
        const lb = loaded.get(b._id.toHexString());
        assert.equal(ctx.can(CAP.BOARD_VIEW, lb), listed, label(s, " board.view vs search scope"));
        if (listed) assert.equal(ctx.can(CAP.RECORD_EDIT_VALUES, lb), SearchService.prototype.canEdit({ roleOf }, b), label(s, " canEdit"));
        const event = { workspaceId: b.workspaceId.toHexString(), action: "record.updated" };
        const visible = !event.workspaceId || roles === null || roles.has(event.workspaceId);
        assert.equal(await ctx.canSeeEvent(event), visible, label(s, " event"));
      }
      assert.equal(await ctx.canSeeEvent({ action: "x" }), true);
    }
  });
});

describe("token parity: mode token equals ApiTokenService.roleOf ∩ the token's boards and workspaces, read only", () => {
  const TOKEN_BOARDS = [[BOARDS.mine, BOARDS.other, BOARDS.mineRO, BOARDS.otherRO], [BOARDS.mine]];
  const TOKEN_WORKSPACES = [[W1, W2], [W1], [W2]];
  test("matrix", async () => {
    let cells = 0;
    const mismatches = [];
    for (const s of settings()) {
      for (const tb of TOKEN_BOARDS) for (const tw of TOKEN_WORKSPACES) {
        const { repos, access, actor } = world(s);
        const tokens = new ApiTokenService({ repos }).configure({ key: crypto.randomBytes(32), access, tenantId: "t" });
        // ApiTokenService.ownerActor: the stored person, never SYSTEM_ADMIN.
        const owner = Object.freeze({ userId: USER, kind: "api_token_owner", isSystemAdmin: false, account: actor.account });
        const ctx = access.context(owner, { mode: "token", boardIds: tb.map((b) => b._id), workspaceIds: tw });
        await ctx.visibility();
        const loaded = await ctx.boards(Object.values(BOARDS).map((b) => b._id));
        for (const b of Object.values(BOARDS)) {
          // routes/external-api.js scopedBoard: in doc.boardIds, and the board's workspace is one of the token's that the owner
          // can read now (authorize → roleOf).
          const reach = tb.includes(b) && tw.some((w) => w.equals(b.workspaceId)) && Boolean(await tokens.roleOf(owner, b.workspaceId));
          const lb = loaded.get(b._id.toHexString());
          for (const cap of caps.ALL_CAPS) {
            cells += 1;
            const want = reach && caps.TOKEN_CAPS.has(cap); // read scope only (readOnlyGuard refuses every write)
            if (ctx.can(cap, lb) !== want) mismatches.push(`${label(s)} token ${tb.length}b/${tw.length}w ${cap}: want ${want}`);
          }
        }
      }
    }
    assert.deepEqual(mismatches.slice(0, 20), [], `${mismatches.length} mismatches`);
    assert.equal(cells, 2 * 2 * (5 + 25 + 25) * TOKEN_BOARDS.length * TOKEN_WORKSPACES.length * 4 * caps.ALL_CAPS.length);
  });
  test("a token context never sees an event and needs its boards and workspaces", async () => {
    const { access, actor } = world({ policy: "development_shared", betaOpenEditing: false, accountMode: "off", persona: "WORKSPACE_ADMIN", account: null });
    assert.throws(() => access.context(actor, { mode: "token" }), /boardIds and workspaceIds/);
    const ctx = access.context({ ...actor, isSystemAdmin: true }, { mode: "token", boardIds: [], workspaceIds: [W1] });
    assert.equal(ctx.actor.isSystemAdmin, false);
    assert.equal(await ctx.canSeeEvent({ workspaceId: W1.toHexString() }), false);
  });
});

describe("batched evaluation (no N+1)", () => {
  test("20 Connect targets over 5 workspaces: 1 memberships read, 1 board $in read, then everything in memory", async () => {
    const wss = Array.from({ length: 5 }, () => new ObjectId());
    const targets = Array.from({ length: 20 }, (_, i) => ({ _id: new ObjectId(), workspaceId: wss[i % 5], columns: [], groups: [] }));
    for (const policy of POLICIES) for (const persona of ["none", "MEMBER", "SYSTEM_ADMIN"]) {
      const repos = makeRepos(persona === "MEMBER" ? "MEMBER" : null);
      const all = [...Object.values(BOARDS), ...targets];
      repos.boards.findManyByIds = async (ids, projection) => { repos.counts.findManyByIds += 1; repos.lastProjection = projection; return all.filter((b) => ids.some((id) => id.equals(b._id))); };
      const access = new Access(repos, { policy });
      const ctx = access.context({ userId: USER, kind: "entra", isSystemAdmin: persona === "SYSTEM_ADMIN" });
      await ctx.visibility(); await ctx.visibility();
      const loaded = await ctx.boards([...targets.map((t) => t._id), ...targets.map((t) => t._id.toHexString())], { columns: 1, groups: 1 });
      assert.equal(loaded.size, 20);
      assert.deepEqual(Object.keys(repos.lastProjection).sort(), ["_id", "columns", "groups", "source.readOnly", "workspaceId"]);
      for (const t of loaded.values()) for (const cap of caps.ALL_CAPS) ctx.can(cap, t);
      await ctx.boards(targets.slice(0, 7).map((t) => t._id), { columns: 1, groups: 1 }); // memoised
      await ctx.require(CAP.BOARD_VIEW, BOARDS.mine._id).catch(() => null); // one more board, one more read
      assert.equal(repos.counts.listForUser, persona === "SYSTEM_ADMIN" ? 0 : 1, `${policy}/${persona} memberships`);
      assert.equal(repos.counts.findActive, 0);
      assert.equal(repos.counts.boardFindById, 0);
      assert.equal(repos.counts.findManyByIds, 2, `${policy}/${persona} board reads`);
      assert.deepEqual(ctx.stats, { membershipReads: persona === "SYSTEM_ADMIN" ? 0 : 1, boardReads: 2, recordReads: 0 });
      // Today's per-column loop (RelatedService.readable → Access.board) for comparison: 20 board reads, and 20 membership reads
      // under role_based for a non-admin.
      const before = { ...repos.counts };
      for (const t of targets) await access.board({ userId: USER, kind: "entra", isSystemAdmin: persona === "SYSTEM_ADMIN" }, t._id, "VIEWER").catch(() => null);
      assert.equal(repos.counts.boardFindById - before.boardFindById, 20);
    }
  });
  test("a failed memberships read is not memoised (the next call retries; nothing is granted meanwhile)", async () => {
    const repos = makeRepos("MEMBER");
    let fail = true;
    const real = repos.memberships.listForUser;
    repos.memberships.listForUser = async (...a) => { if (fail) { fail = false; throw new Error("db down"); } return real(...a); };
    const ctx = new Access(repos, {}).context({ userId: USER, kind: "entra", isSystemAdmin: false });
    await assert.rejects(() => ctx.visibility(), /db down/);
    const mine = (await ctx.boards([BOARDS.mine._id])).get(BOARDS.mine._id.toHexString());
    assert.throws(() => ctx.can(CAP.BOARD_VIEW, mine), /await ctx.visibility/);
    await ctx.visibility();
    assert.equal(ctx.can(CAP.BOARD_VIEW, mine), true);
  });
});

describe("route-minimum inventory (a new access.board/record call needs a row here and a capability)", () => {
  // file → "kind minimum" → count. Kinds: board / record / workspace (Access), formFor / forComment (route helpers).
  const INVENTORY = {
    "routes/resources.js": { "workspace VIEWER": 3, "workspace WORKSPACE_ADMIN": 2, "workspace MEMBER": 1, "board VIEWER": 5, "board VIEWER|MEMBER": 1, "board MEMBER": 7, "board WORKSPACE_ADMIN": 4, "record VIEWER": 1, "record MEMBER": 2 },
    "routes/comments.js": { "record <var>": 1, "record VIEWER": 2, "record MEMBER": 2, "forComment MEMBER": 1, "forComment VIEWER": 1, "board VIEWER": 1 },
    "routes/files.js": { "board VIEWER": 1, "record VIEWER": 2, "record MEMBER": 2 },
    "routes/forms.js": { "board <var>": 1, "board VIEWER": 1, "board WORKSPACE_ADMIN": 1, "formFor VIEWER": 1, "formFor WORKSPACE_ADMIN": 2, "formFor MEMBER": 2 },
    "routes/members.js": { "workspace VIEWER": 1, "workspace WORKSPACE_ADMIN": 3 },
    "routes/imports.js": { "workspace MEMBER": 5 },
    "routes/api-tokens.js": { "board VIEWER": 1 },
    "services/related-service.js": { "board VIEWER": 1 },
    "employees/access-admin.js": { "workspace WORKSPACE_ADMIN": 1 }
  };
  test("the call sites and their minimums are exactly the inventoried ones", () => {
    const root = path.join(__dirname, "../src"), found = {};
    const walk = (dir) => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js")) scan(p); } };
    const scan = (p) => {
      const rel = path.relative(root, p).split(path.sep).join("/");
      if (rel.startsWith("auth/")) return;
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (/^\s*\/\//.test(line)) continue;
        const calls = [...line.matchAll(/\b(?:access\.(board|record|workspace)|(formFor|forComment))\(/g)];
        calls.forEach((m, i) => {
          // The call's text: up to the next call on the line, or the end of the statement.
          const rest = line.slice(m.index, i + 1 < calls.length ? calls[i + 1].index : undefined).split(";")[0];
          if (m[2] && /^\w+\(req, minimum\)/.test(rest)) return; // the helper's own definition
          const mins = [...rest.matchAll(/"(VIEWER|MEMBER|WORKSPACE_ADMIN)"/g)].map((x) => x[1]);
          const key = `${m[1] || m[2]} ${mins.join("|") || "<var>"}`;
          (found[rel] ||= {})[key] = (found[rel][key] || 0) + 1;
        });
      }
    };
    walk(root);
    assert.deepEqual(found, INVENTORY);
  });
});
