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
  // The board role (P4-0: implied by the workspace role), or null when the board is not visible.
  boardRole(board) {
    if (!board || !board.workspaceId || !this.inToken(board)) return null;
    return impliedBoardRole(this.workspaceRole(board.workspaceId), board);
  }
  inputs(board) {
    return { boardRole: this.boardRole(board), realRole: board?.workspaceId && this.inToken(board) ? this.realRole(board.workspaceId) : null, readOnly: Boolean(board?.source?.readOnly), mode: this.mode };
  }

  // ---- Capabilities (sync, memoised per board for this request)
  capabilities(board) {
    this.loaded();
    if (!board || !board.workspaceId) return capabilitiesFor({});
    const key = `${hex(board._id)}|${hex(board.workspaceId)}|${Boolean(board.source?.readOnly)}`;
    let caps = this._caps.get(key);
    if (!caps) { caps = capabilitiesFor(this.inputs(board)); this._caps.set(key, caps); }
    return caps;
  }
  can(cap, board) { return isCap(cap) && this.capabilities(board).has(cap); }

  // ---- Batched loading
  // Boards by ID: ONE repos.boards.findManyByIds ($in) read for the IDs not yet loaded with this projection.
  // → Map(boardHex → board | null). projection null = the whole board (what Access.board returns).
  async boards(ids, projection = null) {
    const wanted = [...new Set([...ids].map(hex).filter((id) => id && HEX.test(id)))];
    const pkey = projection ? JSON.stringify(Object.keys(projection).sort()) : "*";
    const todo = wanted.filter((id) => !this._boards.has(`${pkey}|${id}`));
    if (todo.length) {
      const proj = projection ? { ...projection, ...AUTHZ_FIELDS } : null;
      const repo = this.repos.boards;
      this.stats.boardReads += 1;
      const docs = typeof repo.findManyByIds === "function"
        ? await repo.findManyByIds(todo.map(asId), proj)
        : (await Promise.all(todo.map((id) => repo.findById(asId(id))))).filter(Boolean); // test doubles only
      const byId = new Map(docs.map((d) => [hex(d._id), d]));
      for (const id of todo) this._boards.set(`${pkey}|${id}`, byId.get(id) || null);
    }
    return new Map(wanted.map((id) => [id, this._boards.get(`${pkey}|${id}`)]));
  }

  // ---- Throwing checks
  // → { board, role, boardRole, caps }. 404 when not visible (never reveals existence), 403 when visible but not allowed.
  async require(cap, boardOrId, { what = "board" } = {}) {
    if (!isCap(cap)) throw new Error(`Unknown capability: ${cap}`);
    await this.visibility();
    let board = boardOrId;
    if (!board || typeof board !== "object" || board instanceof ObjectId) {
      const id = hex(boardOrId);
      board = id && HEX.test(id) ? (await this.boards([id])).get(id) : null;
    }
    return this.decide(cap, board, what);
  }

  // A record's workspace is its BOARD's (P4-0, as Access.record): the board is loaded; a record whose board is gone is 404.
  async requireRecord(cap, recordOrId) {
    if (!isCap(cap)) throw new Error(`Unknown capability: ${cap}`);
    await this.visibility();
    let record = recordOrId;
    if (!record || typeof record !== "object" || record instanceof ObjectId) {
      const id = hex(recordOrId);
      this.stats.recordReads += 1;
      record = id && HEX.test(id) ? await this.repos.records.findById(asId(id)) : null;
    }
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

module.exports = { AuthzContext, AUTHZ_FIELDS };
