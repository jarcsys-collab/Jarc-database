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
// Only boards this context loaded itself (ctx.boards / require) are ever decided (plan 35 F1): can() and capabilities() answer
// "nothing" for any other object, and require() / requireRecord() use a passed object only for its _id and reload it. The boards
// returned are frozen copies (F2: top level and `source`), so a caller can't change a later decision in the same request.
// ctx.boards takes inclusion projections only (F3) and at most MAX_BOARD_IDS distinct IDs per call (F4).
//
// P4-0: NOT AUTHORITATIVE. No route calls this yet; the existing Access helpers decide every request.
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { CAP, isCap, capabilitiesFor, missingReason, impliedBoardRole } = require("./capabilities");

const hex = (id) => (id === null || id === undefined ? null : typeof id === "string" ? id : typeof id.toHexString === "function" ? id.toHexString() : String(id));
const HEX = /^[0-9a-f]{24}$/;
const asId = (id) => (id instanceof ObjectId ? id : new ObjectId(String(id)));
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

// F3: → { proj, key } for an inclusion projection (values 1 or true), with AUTHZ_FIELDS merged in; null → the whole board.
// Refused (programming errors, never sent to the client): exclusions or operators, an empty projection, and path collisions
// (MongoDB refuses `a` together with `a.b`). An AUTHZ path already covered by a requested parent (`source` covers
// `source.readOnly`) is not added. The cache key is the full, sorted, normalised path list, so {columns:1} and {columns:0}
// can never share an entry.
function normaliseProjection(projection) {
  if (projection === null || projection === undefined) return { proj: null, key: "*" };
  if (typeof projection !== "object" || Array.isArray(projection)) throw new Error("AuthzContext.boards: the projection must be an object, or null for the whole board.");
  const keys = Object.keys(projection);
  if (!keys.length) throw new Error("AuthzContext.boards: an empty projection; pass null for the whole board.");
  for (const k of keys) {
    if (projection[k] !== 1 && projection[k] !== true) throw new Error(`AuthzContext.boards: inclusion projections only (${k}).`);
    if (k.startsWith("$") || k.split(".").some((part) => !part)) throw new Error(`AuthzContext.boards: invalid projection path (${k}).`);
  }
  const paths = new Set(keys);
  for (const p of AUTHZ_PATHS) if (!keys.some((k) => k === p || p.startsWith(`${k}.`))) paths.add(p);
  const list = [...paths].sort();
  for (const a of list) for (const b of list) if (b.startsWith(`${a}.`)) throw new Error(`AuthzContext.boards: projection path collision (${a} / ${b}).`);
  return { proj: Object.fromEntries(list.map((k) => [k, 1])), key: JSON.stringify(list) };
}

// F2: what the context hands out and decides on: a frozen shallow copy, with `source` frozen too (the read-only flag).
function seal(doc) {
  const copy = { ...doc };
  if (doc.source && typeof doc.source === "object") copy.source = Object.freeze({ ...doc.source });
  return Object.freeze(copy);
}

class AuthzContext {
  constructor(access, actor, { mode = "session", boardIds = null, workspaceIds = null } = {}) {
    if (!["session", "token"].includes(mode)) throw new Error(`Unknown authorization mode: ${mode}`);
    if (mode === "token" && (!boardIds || !workspaceIds)) throw new Error("A token context needs the token's boardIds and workspaceIds.");
    this.access = access;
    this.repos = access.repos;
    this.mode = mode;
    // The token owner is never SYSTEM_ADMIN (ApiTokenService.ownerActor).
    this.actor = mode === "token" ? Object.freeze({ ...actor, isSystemAdmin: false }) : actor;
    this.tokenBoards = mode === "token" ? new Set([...boardIds].map(hex)) : null;
    this.tokenWorkspaces = mode === "token" ? new Set([...workspaceIds].map(hex)) : null;
    this.stats = { membershipReads: 0, boardReads: 0, recordReads: 0 };
    this._visibility = null;
    this._loaded = null;
    this._boards = new Map(); // `${projectionKey}|${boardHex}` → board | null
    this._own = new WeakSet(); // the boards this context loaded (sealed); the only objects ever decided (F1)
    this._caps = new Map(); // `${boardHex}|${workspaceHex}|${readOnly}` → frozen Set
  }

  // ---- Visibility: one memberships read per request (memoised; a failed read is not memoised)
  visibility() {
    if (!this._visibility) this._visibility = this.loadVisibility().then((v) => { this._loaded = v; return v; }, (error) => { this._visibility = null; throw error; });
    return this._visibility;
  }

  async loadVisibility() {
    const { access, actor } = this;
    if (this.mode === "session" && actor.isSystemAdmin) return Object.freeze({ global: "SYSTEM_ADMIN", roles: null, real: null, systemAdmin: true });
    this.stats.membershipReads += 1;
    const memberships = await this.repos.memberships.listForUser(actor.userId);
    // Access.visibleRoles: the effective (account-capped) role of every active membership, nulls dropped.
    const real = new Map(memberships.map((m) => [hex(m.workspaceId), access.effective(actor, m.role)]).filter(([, role]) => role));
    if (this.mode === "token") return Object.freeze({ global: access.shared ? "VIEWER" : null, roles: real, real, systemAdmin: false });
    const global = access.shared ? "WORKSPACE_ADMIN" : null; // Access.globalRole for a non-SYSTEM_ADMIN
    return Object.freeze({ global, roles: global ? null : real, real, systemAdmin: false });
  }

  loaded() {
    if (!this._loaded) throw new Error("AuthzContext: await ctx.visibility() before the synchronous checks.");
    return this._loaded;
  }

  // ---- Roles (sync, after visibility())
  // Today's workspace role, as Access.roleIn (session) or ApiTokenService.roleOf (token) would answer it, or null.
  workspaceRole(workspaceId) {
    const v = this.loaded(), ws = hex(workspaceId);
    if (!ws) return null;
    if (this.mode === "token") return v.real.get(ws) || v.global;
    if (v.global) return v.global;
    return v.roles.get(ws) ?? null;
  }
  // The role through a real membership (Access.roleIn with membershipOnly), or null.
  realRole(workspaceId) {
    const v = this.loaded(), ws = hex(workspaceId);
    if (v.systemAdmin) return "SYSTEM_ADMIN";
    return ws ? v.real.get(ws) ?? null : null;
  }
  // Workspace IDs visible (null: every workspace), for list filters. Token mode: the token's readable workspaces.
  visibleWorkspaceIds() {
    const v = this.loaded();
    if (this.mode === "token") return new Set([...this.tokenWorkspaces].filter((ws) => this.workspaceRole(ws)));
    return v.global ? null : new Set(v.roles.keys());
  }
  inToken(board) {
    return this.mode !== "token" || (this.tokenBoards.has(hex(board._id)) && this.tokenWorkspaces.has(hex(board.workspaceId)));
  }
  // Whether this context loaded the object itself (F1). Anything else (a summary projection, a list row, an object built from
  // a request body, a record) is never decided.
  owns(board) { return this._own.has(board); }
  // The board role (P4-0: implied by the workspace role), or null when the board is not visible or not loaded by this context.
  boardRole(board) { return this.inputs(board).boardRole; }
  inputs(board) {
    this.loaded();
    const known = this.owns(board) && Boolean(board.workspaceId) && this.inToken(board);
    return {
      boardRole: known ? impliedBoardRole(this.workspaceRole(board.workspaceId), board) : null,
      realRole: known ? this.realRole(board.workspaceId) : null,
      readOnly: Boolean(board?.source?.readOnly),
      mode: this.mode
    };
  }

  // ---- Capabilities (sync, memoised per board for this request). Empty for a board this context didn't load.
  capabilities(board) {
    this.loaded();
    if (!this.owns(board) || !board.workspaceId) return capabilitiesFor({});
    const key = `${hex(board._id)}|${hex(board.workspaceId)}|${Boolean(board.source?.readOnly)}`;
    let caps = this._caps.get(key);
    if (!caps) { caps = capabilitiesFor(this.inputs(board)); this._caps.set(key, caps); }
    return caps;
  }
  can(cap, board) { this.loaded(); return isCap(cap) && this.owns(board) && this.capabilities(board).has(cap); }
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
  // Boards by ID: ONE repos.boards.findManyByIds ($in) read for the IDs not yet loaded with this projection.
  // → Map(boardHex → frozen board | null). projection null = the whole board (what Access.board returns); otherwise an
  // inclusion projection (F3). More than MAX_BOARD_IDS distinct valid IDs: 400 TOO_MANY_BOARDS, before any read (F4).
  async boards(ids, projection = null) {
    const { proj, key: pkey } = normaliseProjection(projection);
    const wanted = [...new Set([...ids].map(hex).filter((id) => id && HEX.test(id)))];
    if (wanted.length > MAX_BOARD_IDS) throw new ApiError(400, "TOO_MANY_BOARDS", `At most ${MAX_BOARD_IDS} boards can be checked at once.`);
    const todo = wanted.filter((id) => !this._boards.has(`${pkey}|${id}`));
    if (todo.length) {
      this.stats.boardReads += 1;
      const docs = await this.repos.boards.findManyByIds(todo.map(asId), proj);
      const byId = new Map(docs.map((d) => [hex(d._id), d]));
      for (const id of todo) {
        const doc = byId.get(id);
        const board = doc ? seal(doc) : null;
        if (board) this._own.add(board);
        this._boards.set(`${pkey}|${id}`, board);
      }
    }
    return new Map(wanted.map((id) => [id, this._boards.get(`${pkey}|${id}`)]));
  }

  // ---- Throwing checks
  // → { board, role, boardRole, caps }. 404 when not visible (never reveals existence), 403 when visible but not allowed.
  // A board this context loaded is decided as is; any other object counts only for its _id and is reloaded (F1).
  async require(cap, boardOrId, { what = "board" } = {}) {
    if (!isCap(cap)) throw new Error(`Unknown capability: ${cap}`);
    await this.visibility();
    if (this.owns(boardOrId)) return this.decide(cap, boardOrId, what);
    const isObject = boardOrId && typeof boardOrId === "object" && !(boardOrId instanceof ObjectId);
    const id = hex(isObject ? boardOrId._id : boardOrId);
    const board = id && HEX.test(id) ? (await this.boards([id])).get(id) : null;
    return this.decide(cap, board, what);
  }

  // A record's workspace is its BOARD's (P4-0, as Access.record): the board is loaded; a record whose board is gone is 404.
  // A record object counts only for its _id: the stored record is read, so its boardId can't be supplied by the caller (F1).
  async requireRecord(cap, recordOrId) {
    if (!isCap(cap)) throw new Error(`Unknown capability: ${cap}`);
    await this.visibility();
    const isObject = recordOrId && typeof recordOrId === "object" && !(recordOrId instanceof ObjectId);
    const id = hex(isObject ? recordOrId._id : recordOrId);
    let record = null;
    if (id && HEX.test(id)) { this.stats.recordReads += 1; record = await this.repos.records.findById(asId(id)); }
    if (!record) throw notFound("record");
    const board = record.boardId ? (await this.boards([record.boardId])).get(hex(record.boardId)) : null;
    if (!board?.workspaceId) throw notFound("record");
    const same = hex(record.workspaceId) === hex(board.workspaceId);
    if (!same) this.access.noteDrift?.(board);
    const out = this.decide(cap, board, "record");
    return { ...out, record: same ? record : { ...record, workspaceId: board.workspaceId } };
  }

  decide(cap, board, what) {
    const inputs = this.inputs(board);
    const reason = board?.workspaceId ? missingReason(cap, inputs) : "hidden";
    if (reason === "hidden") throw notFound(what);
    if (reason === "read_only") throw new ApiError(403, "READ_ONLY_BOARD", READ_ONLY);
    // Under shared access every workspace is visible, so a missing real membership is "not allowed", not "not found"
    // (Access.check with membershipOnly).
    if (reason === "real_row") throw new ApiError(403, "FORBIDDEN", this.access.shared && cap === CAP.WORKSPACE_MEMBERS ? MEMBERS_ONLY : FORBIDDEN);
    if (reason) throw new ApiError(403, "FORBIDDEN", FORBIDDEN);
    return { board, role: this.workspaceRole(board.workspaceId), boardRole: inputs.boardRole, caps: this.capabilities(board) };
  }

  // Live updates / activity: today's rule (routes/events.js visible()): no workspace, every workspace, or a visible one.
  async canSeeEvent(event) {
    await this.visibility();
    if (!event?.workspaceId) return true;
    if (this.mode === "token") return false;
    const ids = this.visibleWorkspaceIds();
    return ids === null || ids.has(hex(event.workspaceId));
  }
}

module.exports = { AuthzContext, AUTHZ_FIELDS, MAX_BOARD_IDS, normaliseProjection };
