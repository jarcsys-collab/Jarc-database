// Per-request authorization context (P4 shared authorization contract, Employee Management plan 27 §2/§4 and plan 30).
//
//   const ctx = access.context(req.actor);              // one per request; never shared or cached across requests
//   await ctx.visibility();                             // ONE memberships read (none for SYSTEM_ADMIN)
//   const boards = await ctx.boards(ids);               // ONE $in read for the IDs not seen yet in this request
//   ctx.can(CAP.BOARD_VIEW, board)                      // sync, in memory: lists, Mirror / Connect, search, events
//   await ctx.require(CAP.COLUMN_DESTRUCTIVE, boardId)  // → { board, role, boardRole, caps } or 404 / 403
//   await ctx.requireRecord(CAP.RECORD_EDIT_VALUES, recordId)
//
// Semantics are TODAY's, exactly (proven by tests/authz-parity.test.js against Access.board / record / check / roleIn):
//   - the workspace role is Access.roleIn's: SYSTEM_ADMIN; else WORKSPACE_ADMIN everywhere under shared access; else the
//     active membership, capped by Access.effective (ACCOUNT_MANAGEMENT=enforced);
//   - the real role (membershipOnly) ignores shared access;
//   - mode "token" is ApiTokenService.roleOf: the owner's real membership, else VIEWER under shared access; the owner is never
//     SYSTEM_ADMIN; only the token's boards (boardIds) in the token's workspaces (workspaceIds) are ever visible; read only.
// Errors: not visible → 404 NOT_FOUND ("This board doesn't exist or was deleted."), the same as Access.board; visible but not
// allowed → 403 FORBIDDEN (or READ_ONLY_BOARD when only the read-only rule refuses). can() never throws an authorization error.
//
// Integrity (plan 35 reviews 1 and 2):
//   - Only boards this context loaded itself are ever decided (F1). require() / requireRecord() use any other object only for
//     its _id and reload it.
//   - Decisions read only the FACTS recorded when the board was loaded ({ id, workspace, readOnly } in a private WeakMap,
//     R2-3), never the board object, so changing the returned board (even the internals of its ObjectIds) changes nothing.
//     The boards handed out are also frozen copies, `source` included (F2).
//   - All state is in #private fields and the instance is frozen (R2-4): mode, token scope, memberships (R2-2), the memo
//     tables. Capability sets are read-only views (R2-1).
//   - ctx.boards: inclusion projections only (F3); at most MAX_BOARD_IDS distinct IDs per call (F4) and MAX_CONTEXT_BOARDS
//     cached entries per context; concurrent calls share one in-flight read (R2-5).
//
// P4-0: NOT AUTHORITATIVE. No route calls this yet; the existing Access helpers decide every request.
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { CAP, isCap, capabilitiesFor, missingReason, impliedBoardRole } = require("./capabilities");

// IDs as lower-case hex (R2-6: parseId accepts upper case). An object whose toHexString throws is no ID.
const hex = (id) => {
  if (id === null || id === undefined) return null;
  if (typeof id === "string") return id.toLowerCase();
  try { return typeof id.toHexString === "function" ? String(id.toHexString()).toLowerCase() : null; } catch { return null; }
};
const HEX = /^[0-9a-f]{24}$/;
const asId = (id) => new ObjectId(id); // always from a validated hex string, never from the caller's object
const notFound = (what) => new ApiError(404, "NOT_FOUND", `This ${what} doesn't exist or was deleted.`);
const FORBIDDEN = "You don't have permission to do this in this workspace.";
const READ_ONLY = "This board is synchronized from monday.com and is read-only in JARC.";
const MEMBERS_ONLY = "Only this workspace's admins can manage its members.";
// What authorization itself needs from a board, merged into any projection the caller asks for.
const AUTHZ_FIELDS = Object.freeze({ _id: 1, workspaceId: 1, "source.readOnly": 1 });
const AUTHZ_PATHS = Object.keys(AUTHZ_FIELDS);
// F4: distinct board IDs per ctx.boards call (boards.findManyByIds has the same bound). Far above any real request: a token
// holds at most 100 boards, search reads at most 300, production has fewer than 100 boards in all.
const MAX_BOARD_IDS = 500;
// Cached (projection, board) entries per context: a request can't grow the memo without bound by calling ctx.boards repeatedly.
const MAX_CONTEXT_BOARDS = 2000;
const tooMany = (n) => new ApiError(400, "TOO_MANY_BOARDS", `At most ${n} boards can be checked at once.`);

// F3: → { proj, key } for an inclusion projection (values 1 or true), with AUTHZ_FIELDS merged in; null → the whole board.
// Refused (programming errors, never sent to the client): exclusions or operators, an empty projection, any path segment
// that is empty or starts with "$" (R2-7: `columns.$` too), and path collisions (MongoDB refuses `a` together with `a.b`).
// An AUTHZ path already covered by a requested parent (`source` covers `source.readOnly`) is not added. The cache key is the
// full, sorted, normalised path list, so {columns:1} and {columns:0} can never share an entry.
function normaliseProjection(projection) {
  if (projection === null || projection === undefined) return { proj: null, key: "*" };
  if (typeof projection !== "object" || Array.isArray(projection)) throw new Error("AuthzContext.boards: the projection must be an object, or null for the whole board.");
  const keys = Object.keys(projection);
  if (!keys.length) throw new Error("AuthzContext.boards: an empty projection; pass null for the whole board.");
  for (const k of keys) {
    const v = projection[k];
    if (v !== 1 && v !== true) throw new Error(`AuthzContext.boards: inclusion projections only (${k}).`);
    if (k.split(".").some((part) => !part || part.startsWith("$"))) throw new Error(`AuthzContext.boards: invalid projection path (${k}).`);
  }
  const paths = new Set(keys);
  for (const p of AUTHZ_PATHS) if (!keys.some((k) => k === p || p.startsWith(`${k}.`))) paths.add(p);
  const list = [...paths].sort();
  for (const a of list) for (const b of list) if (b.startsWith(`${a}.`)) throw new Error(`AuthzContext.boards: projection path collision (${a} / ${b}).`);
  return { proj: Object.fromEntries(list.map((k) => [k, 1])), key: JSON.stringify(list) };
}

// F2: what the context hands out: a frozen shallow copy, with `source` frozen too.
function seal(doc) {
  const copy = { ...doc };
  if (doc.source && typeof doc.source === "object") copy.source = Object.freeze({ ...doc.source });
  return Object.freeze(copy);
}

class AuthzContext {
  #access; #repos; #mode; #actor; #tokenBoards; #tokenWorkspaces;
  #visibility = null; // Promise of the private visibility record
  #vis = null; // { global, roles: Map | null, real: Map | null, systemAdmin } once loaded; never handed out
  #boards = new Map(); // `${projectionKey}|${boardHex}` → Promise<sealed board | null> (in flight or settled)
  #facts = new WeakMap(); // sealed board → frozen { id, ws, readOnly }: the only inputs of a decision (R2-3)
  #caps = new Map(); // `${id}|${ws}|${readOnly}` → read-only capability view
  #stats = { membershipReads: 0, boardReads: 0, recordReads: 0 };

  constructor(access, actor, { mode = "session", boardIds = null, workspaceIds = null } = {}) {
    if (!["session", "token"].includes(mode)) throw new Error(`Unknown authorization mode: ${mode}`);
    if (mode === "token" && (!boardIds || !workspaceIds)) throw new Error("A token context needs the token's boardIds and workspaceIds.");
    this.#access = access;
    this.#repos = access.repos;
    this.#mode = mode;
    // A frozen copy of the identity; the token owner is never SYSTEM_ADMIN (ApiTokenService.ownerActor).
    this.#actor = Object.freeze(mode === "token" ? { ...actor, isSystemAdmin: false } : { ...actor });
    this.#tokenBoards = mode === "token" ? new Set([...boardIds].map(hex).filter((id) => id && HEX.test(id))) : null;
    this.#tokenWorkspaces = mode === "token" ? new Set([...workspaceIds].map(hex).filter((id) => id && HEX.test(id))) : null;
    Object.freeze(this);
  }

  get mode() { return this.#mode; }
  get actor() { return this.#actor; }
  get stats() { return { ...this.#stats }; }

  // ---- Visibility: one memberships read per request (memoised; a failed read is not memoised).
  // Resolves to a frozen summary only; the role tables stay private (R2-2).
  visibility() {
    if (!this.#visibility) {
      this.#visibility = this.#loadVisibility().then((v) => { this.#vis = v; return Object.freeze({ global: v.global, systemAdmin: v.systemAdmin }); }, (error) => { this.#visibility = null; throw error; });
    }
    return this.#visibility;
  }

  async #loadVisibility() {
    const access = this.#access, actor = this.#actor;
    if (this.#mode === "session" && actor.isSystemAdmin) return { global: "SYSTEM_ADMIN", roles: null, real: null, systemAdmin: true };
    this.#stats.membershipReads += 1;
    const memberships = await this.#repos.memberships.listForUser(actor.userId);
    // Access.visibleRoles: the effective (account-capped) role of every active membership, nulls dropped.
    const real = new Map(memberships.map((m) => [hex(m.workspaceId), access.effective(actor, m.role)]).filter(([ws, role]) => ws && role));
    if (this.#mode === "token") return { global: access.shared ? "VIEWER" : null, roles: real, real, systemAdmin: false };
    const global = access.shared ? "WORKSPACE_ADMIN" : null; // Access.globalRole for a non-SYSTEM_ADMIN
    return { global, roles: global ? null : real, real, systemAdmin: false };
  }

  #loaded() {
    if (!this.#vis) throw new Error("AuthzContext: await ctx.visibility() before the synchronous checks.");
    return this.#vis;
  }

  // ---- Roles (sync, after visibility())
  // Today's workspace role, as Access.roleIn (session) or ApiTokenService.roleOf (token) would answer it, or null.
  workspaceRole(workspaceId) {
    const v = this.#loaded(), ws = hex(workspaceId);
    if (!ws) return null;
    if (this.#mode === "token") return v.real.get(ws) || v.global;
    if (v.global) return v.global;
    return v.roles.get(ws) ?? null;
  }
  // The role through a real membership (Access.roleIn with membershipOnly), or null.
  realRole(workspaceId) {
    const v = this.#loaded(), ws = hex(workspaceId);
    if (v.systemAdmin) return "SYSTEM_ADMIN";
    return ws ? v.real.get(ws) ?? null : null;
  }
  // Workspace IDs visible (null: every workspace), for list filters: a fresh Set each call. Token mode: the token's readable
  // workspaces.
  visibleWorkspaceIds() {
    const v = this.#loaded();
    if (this.#mode === "token") return new Set([...this.#tokenWorkspaces].filter((ws) => this.workspaceRole(ws)));
    return v.global ? null : new Set(v.roles.keys());
  }

  // Whether this context loaded the object itself (F1). Anything else (a summary projection, a list row, a copy, a Proxy, a
  // board from another context, an object built from a request body) is never decided.
  owns(board) { return this.#facts.has(board); }
  #inToken(f) { return this.#mode !== "token" || (this.#tokenBoards.has(f.id) && this.#tokenWorkspaces.has(f.ws)); }
  #inputs(board) {
    this.#loaded();
    const f = this.#facts.get(board);
    const known = Boolean(f && f.ws) && this.#inToken(f);
    return {
      boardRole: known ? impliedBoardRole(this.workspaceRole(f.ws), board) : null,
      realRole: known ? this.realRole(f.ws) : null,
      readOnly: Boolean(f?.readOnly),
      mode: this.#mode
    };
  }
  // The board role (P4-0: implied by the workspace role), or null when the board is not visible or not loaded by this context.
  boardRole(board) { return this.#inputs(board).boardRole; }

  // ---- Capabilities (sync, memoised per board for this request). Read-only views (R2-1); empty for a board this context
  // didn't load.
  capabilities(board) {
    this.#loaded();
    const f = this.#facts.get(board);
    if (!f || !f.ws) return capabilitiesFor({});
    const key = `${f.id}|${f.ws}|${f.readOnly}`;
    let caps = this.#caps.get(key);
    if (!caps) { caps = capabilitiesFor(this.#inputs(board)); this.#caps.set(key, caps); }
    return caps;
  }
  can(cap, board) { this.#loaded(); return isCap(cap) && this.owns(board) && this.capabilities(board).has(cap); }
  // By ID (the Access.can facade): loads only what authorization needs. An invalid or unknown ID is false.
  async canBoard(cap, boardId) {
    if (boardId && typeof boardId === "object" && !(boardId instanceof ObjectId)) throw new TypeError("canBoard takes a board ID, not a board object.");
    await this.visibility();
    const id = hex(boardId);
    if (!id || !HEX.test(id)) return false;
    const board = (await this.boards([id], AUTHZ_FIELDS)).get(id);
    return Boolean(board) && this.can(cap, board);
  }

  // ---- Batched loading
  // Boards by ID: ONE repos.boards.findManyByIds ($in) read for the IDs not yet loaded (or loading) with this projection.
  // → Map(boardHex → frozen board | null). projection null = the whole board (what Access.board returns); otherwise an
  // inclusion projection (F3). More than MAX_BOARD_IDS distinct valid IDs in one call, or more than MAX_CONTEXT_BOARDS cached
  // entries in this context: 400 TOO_MANY_BOARDS, before any read (F4). A failed read is not memoised.
  async boards(ids, projection = null) {
    const { proj, key: pkey } = normaliseProjection(projection);
    const wanted = [...new Set([...ids].map(hex).filter((id) => id && HEX.test(id)))];
    if (wanted.length > MAX_BOARD_IDS) throw tooMany(MAX_BOARD_IDS);
    const todo = wanted.filter((id) => !this.#boards.has(`${pkey}|${id}`));
    if (this.#boards.size + todo.length > MAX_CONTEXT_BOARDS) throw tooMany(MAX_CONTEXT_BOARDS);
    if (todo.length) {
      this.#stats.boardReads += 1;
      const read = Promise.resolve().then(() => this.#repos.boards.findManyByIds(todo.map(asId), proj)).then((docs) => {
        const byId = new Map();
        for (const doc of docs) {
          const id = hex(doc?._id);
          if (!id || !todo.includes(id) || byId.has(id)) continue; // only what was asked, once
          const board = seal(doc);
          this.#facts.set(board, Object.freeze({ id, ws: hex(doc.workspaceId), readOnly: Boolean(doc.source?.readOnly) }));
          byId.set(id, board);
        }
        return byId;
      });
      for (const id of todo) {
        const key = `${pkey}|${id}`;
        const entry = read.then((byId) => byId.get(id) || null);
        this.#boards.set(key, entry);
        entry.catch(() => { if (this.#boards.get(key) === entry) this.#boards.delete(key); });
      }
    }
    const got = await Promise.all(wanted.map((id) => this.#boards.get(`${pkey}|${id}`)));
    return new Map(wanted.map((id, i) => [id, got[i]]));
  }

  // ---- Throwing checks
  // → { board, role, boardRole, caps }. 404 when not visible (never reveals existence), 403 when visible but not allowed.
  // A board this context loaded is decided as is; any other object counts only for its _id and is reloaded (F1).
  async require(cap, boardOrId, { what = "board" } = {}) {
    if (!isCap(cap)) throw new Error(`Unknown capability: ${cap}`);
    await this.visibility();
    if (this.owns(boardOrId)) return this.#decide(cap, boardOrId, what);
    const isObject = boardOrId && typeof boardOrId === "object" && !(boardOrId instanceof ObjectId);
    const id = hex(isObject ? boardOrId._id : boardOrId);
    const board = id && HEX.test(id) ? (await this.boards([id])).get(id) : null;
    return this.#decide(cap, board, what);
  }

  // A record's workspace is its BOARD's (P4-0, as Access.record): the board is loaded; a record whose board is gone is 404.
  // A record object counts only for its _id: the stored record is read, so its boardId can't be supplied by the caller (F1).
  async requireRecord(cap, recordOrId) {
    if (!isCap(cap)) throw new Error(`Unknown capability: ${cap}`);
    await this.visibility();
    const isObject = recordOrId && typeof recordOrId === "object" && !(recordOrId instanceof ObjectId);
    const id = hex(isObject ? recordOrId._id : recordOrId);
    let record = null;
    if (id && HEX.test(id)) { this.#stats.recordReads += 1; record = await this.#repos.records.findById(asId(id)); }
    if (!record) throw notFound("record");
    const boardId = hex(record.boardId);
    const board = boardId && HEX.test(boardId) ? (await this.boards([boardId])).get(boardId) : null;
    const f = board ? this.#facts.get(board) : null;
    if (!f?.ws) throw notFound("record");
    const same = hex(record.workspaceId) === f.ws;
    if (!same) this.#access.noteDrift?.(board);
    const out = this.#decide(cap, board, "record");
    return { ...out, record: same ? record : { ...record, workspaceId: board.workspaceId } };
  }

  #decide(cap, board, what) {
    const inputs = this.#inputs(board);
    const f = board ? this.#facts.get(board) : null;
    const reason = f?.ws ? missingReason(cap, inputs) : "hidden";
    if (reason === "hidden") throw notFound(what);
    if (reason === "read_only") throw new ApiError(403, "READ_ONLY_BOARD", READ_ONLY);
    // Under shared access every workspace is visible, so a missing real membership is "not allowed", not "not found"
    // (Access.check with membershipOnly). Its members-only message is for NO real row; a real row that is too low gets the
    // ordinary message, as Access.check (R2-8).
    if (reason === "real_row") throw new ApiError(403, "FORBIDDEN", this.#access.shared && cap === CAP.WORKSPACE_MEMBERS && inputs.realRole === null ? MEMBERS_ONLY : FORBIDDEN);
    if (reason) throw new ApiError(403, "FORBIDDEN", FORBIDDEN);
    return { board, role: this.workspaceRole(f.ws), boardRole: inputs.boardRole, caps: this.capabilities(board) };
  }

  // Live updates / activity: today's rule (routes/events.js visible()): no workspace, every workspace, or a visible one.
  async canSeeEvent(event) {
    await this.visibility();
    if (!event?.workspaceId) return true;
    if (this.#mode === "token") return false;
    const ids = this.visibleWorkspaceIds();
    return ids === null || ids.has(hex(event.workspaceId));
  }
}

module.exports = { AuthzContext, AUTHZ_FIELDS, MAX_BOARD_IDS, MAX_CONTEXT_BOARDS, normaliseProjection };
