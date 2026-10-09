// Resource API storage adapter (Stage 11) — DEVELOPMENT / PRE-AUTH, opt-in with ?storage=resource.
//
//   BoardModel → StorageService → ResourceApiAdapter → fetch → Express /api/v1 resources → MongoDB (jarc_database)
//
// The model keeps working on its familiar in-memory shape (workspaces → boards → records). This adapter translates:
//   - on load: workspace list, then board summaries per workspace, then records page by page for the open board only
//     (other boards load when opened). Server IDs are used as-is; MongoDB never reaches the browser.
//   - on save: it compares the model's state with what it last loaded from or saved to the server, and sends only
//     the differences as resource requests (create/update/delete workspace, board, records; schema changes through
//     the dedicated column and group endpoints; batches for many records). Every update carries the expected
//     version; a 409 loads the latest server copy instead of overwriting someone else's change.
//   - after a save it returns a "reconcile" to the model: the server IDs that replaced temporary ones, and after a
//     conflict the latest server data.
// Per-user state (selection, settings, profile, inbox, recents, favourites, last view, local contacts) stays in this
// browser under its own key, separate from local mode's data. Nothing is copied from local mode to the server.
// Requires ApiAdapter, LocalAsyncAdapter and StorageError (StorageService.js), used only at run time.

// What the server reported back, applied by the model to its visible state, last saved state and undo history.
class ResourceReconcile {
  constructor() { this.ids = new Map(); this.ops = []; }
  get empty() { return !this.ids.size && !this.ops.length; }
  mapId(from, to) { if (String(from) !== String(to)) this.ids.set(String(from), to); }
  id(value) { return value === null || value === undefined ? value : this.ids.has(String(value)) ? this.ids.get(String(value)) : value; }
  // state: { data: { workspaces }, user } in the model's storage shape, changed in place.
  applyTo(state, { idsOnly = false } = {}) {
    const workspaces = state.data?.workspaces || [];
    for (const workspace of workspaces) {
      workspace.id = this.id(workspace.id);
      for (const board of workspace.boards || []) {
        board.id = this.id(board.id);
        for (const record of board.records || []) record.id = this.id(record.id);
        for (const view of board.savedViews || []) view.id = this.id(view.id);
      }
    }
    const user = state.user;
    if (user) {
      user.currentWorkspaceId = this.id(user.currentWorkspaceId);
      user.currentBoardId = this.id(user.currentBoardId);
      for (const item of [...(user.recentBoards || []), ...(user.notifications || [])]) { item.boardId = this.id(item.boardId); item.workspaceId = this.id(item.workspaceId); }
      for (const item of user.recentRecords || []) { item.id = this.id(item.id); item.boardId = this.id(item.boardId); item.workspaceId = this.id(item.workspaceId); }
    }
    if (!idsOnly) for (const op of this.ops) op(workspaces);
  }
  static board(workspaces, id) { return workspaces.flatMap((w) => w.boards || []).find((b) => String(b.id) === String(id)); }
  replaceRecord(boardId, row) { this.ops.push((ws) => { const b = ResourceReconcile.board(ws, boardId); const i = b ? b.records.findIndex((r) => String(r.id) === String(row.id)) : -1; if (i >= 0) b.records[i] = resourceClone(row); else if (b) b.records.unshift(resourceClone(row)); }); }
  removeRecord(boardId, id) { this.ops.push((ws) => { const b = ResourceReconcile.board(ws, boardId); if (b) b.records = b.records.filter((r) => String(r.id) !== String(id)); }); }
  replaceBoardRecords(boardId, rows) { this.ops.push((ws) => { const b = ResourceReconcile.board(ws, boardId); if (b) b.records = resourceClone(rows); }); }
  replaceBoard(boardId, fields) { this.ops.push((ws) => { const b = ResourceReconcile.board(ws, boardId); if (b) Object.assign(b, resourceClone(fields)); }); }
  removeBoard(boardId) { this.ops.push((ws) => { for (const w of ws) w.boards = (w.boards || []).filter((b) => String(b.id) !== String(boardId)); }); }
  replaceWorkspace(id, fields) { this.ops.push((ws) => { const w = ws.find((x) => String(x.id) === String(id)); if (w) Object.assign(w, resourceClone(fields)); }); }
  removeWorkspace(id) { this.ops.push((ws) => { const i = ws.findIndex((x) => String(x.id) === String(id)); if (i >= 0) ws.splice(i, 1); }); }
  addGroup(boardId, name) { this.ops.push((ws) => { const b = ResourceReconcile.board(ws, boardId); if (b && !b.groups.includes(name)) b.groups.push(name); }); }
}

const resourceClone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const resourceSorted = (value) => (Array.isArray(value) ? value.map(resourceSorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, resourceSorted(value[k])])) : value);
const resourceSame = (a, b) => JSON.stringify(resourceSorted(a)) === JSON.stringify(resourceSorted(b));
const byPosition = (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// New positions for items whose order changed: the longest run already in order keeps its positions; the others
// get positions between their neighbours (or everything is renumbered when there is no room left).
function resourcePositions(ids, positionOf) {
  const known = ids.map(positionOf);
  const tails = [], tailIndex = [], previous = new Array(ids.length).fill(-1);
  known.forEach((p, i) => {
    if (typeof p !== "number") return;
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < p) lo = mid + 1; else hi = mid; }
    tails[lo] = p; tailIndex[lo] = i; previous[i] = lo > 0 ? tailIndex[lo - 1] : -1;
  });
  const keep = new Set();
  for (let k = tailIndex[tails.length - 1]; k !== undefined && k >= 0; k = previous[k]) keep.add(k);
  const result = new Map();
  for (let i = 0; i < ids.length; i += 1) {
    if (keep.has(i)) continue;
    const before = i > 0 ? (result.has(ids[i - 1]) ? result.get(ids[i - 1]) : known[i - 1]) : undefined;
    let after;
    for (let j = i + 1; j < ids.length; j += 1) if (keep.has(j)) { after = known[j]; break; }
    if (before !== undefined && after !== undefined && !(after - before > 1e-6)) return new Map(ids.map((id, n) => [id, (n + 1) * 1000]));
    result.set(ids[i], before === undefined ? (after === undefined ? 1000 : after - 1000) : after === undefined ? before + 1000 : (before + after) / 2);
  }
  return result;
}

class ResourceApiAdapter {
  static PAGE_SIZE = 200;          // records per request
  static FULL_LOAD_LIMIT = 2000;   // a board up to this size is loaded completely; larger boards load in steps
  static BATCH_LIMIT = 5000;       // records per batch request (the server's limit)
  static USER_KEY = "jarc-resource-user";
  static USER_FIELDS = Object.freeze(["currentWorkspaceId", "currentBoardId", "currentView", "screen", "settings", "profile", "notifications", "recentBoards", "recentRecords", "recentCommands"]);
  static COLUMN_FIELDS = Object.freeze(["key", "label", "type", "required", "visible", "defaultValue", "options", "width", "connection"]);
  static OPTION_TYPES = Object.freeze(["status", "dropdown", "priority"]);
  static FALLBACK_OPTIONS = Object.freeze({ status: ["New", "In Progress", "Waiting", "Completed", "Cancelled", "Review", "Defective", "Clear"], priority: ["Low", "Medium", "High", "Critical"] });
  // Deleting shared data is only expected from these operations. Anything else that would delete server data (for
  // example a stale or partly loaded copy) is refused instead of sent.
  // Changes that only touch this person's own state (screen, views, settings, profile, favourites, recents, local
  // contacts). They are kept in this browser (saveUserState) and never write shared data.
  static USER_ONLY_OPS = Object.freeze(["updateUserState", "updateMembers"]);
  static DELETE_OPS = Object.freeze({ records: ["deleteRecords", "moveRecord", "replaceAll"], boards: ["deleteBoard", "replaceAll"], workspaces: ["deleteWorkspace", "replaceAll"] });

  constructor({ baseUrl = "/api/v1", timeoutMs, fetch, device } = {}) {
    this.mode = "resource";
    this.http = new ApiAdapter({ baseUrl, timeoutMs, fetch, device });
    this.device = this.http.device;
    this.keys = this.device.keys;
    this.reset();
  }
  // Entra sign-in: the session's CSRF token for changes (see ApiAdapter.useCsrfToken), and per-account keys so
  // people sharing a computer never see each other's JARC preferences or selection.
  useCsrfToken(token) { this.http.useCsrfToken(token); }
  setAccount(userId) { this.accountKey = userId ? String(userId) : null; }
  get userKey() { return this.accountKey ? `${ResourceApiAdapter.USER_KEY}:${this.accountKey}` : ResourceApiAdapter.USER_KEY; }

  get timeoutMs() { return this.http.timeoutMs; }
  set timeoutMs(value) { this.http.timeoutMs = value; }
  reset() { this.workspaces = new Map(); this.boards = new Map(); this.records = new Map(); this.aliases = new Map(); }

  // Per-device values stay in this browser.
  read(areaName, key) { return this.device.read(areaName, key); }
  write(areaName, key, value) { this.device.write(areaName, key, value); }
  remove(areaName, key) { this.device.remove(areaName, key); }
  keyFor(group, name) {
    const key = this.device.keyFor(group, name);
    return this.accountKey && group === "preferences" ? `${key}:${this.accountKey}` : key;
  }
  // The recovery screen's download/clear actions apply to browser storage only; server data is never cleared here.
  readRawAppState() { return null; }
  clearAppState() { throw new StorageError(StorageError.CODES.FORBIDDEN, "Server data can't be cleared from this screen."); }
  async readAppState() { throw new Error("ResourceApiAdapter loads through loadResourceState()."); }
  async writeAppState() { throw new Error("ResourceApiAdapter saves through commitState()."); }

  // One request. Failures are StorageErrors (safe messages); `context` tells conflict recovery what to reload.
  async request(method, path, body, context = null) {
    try { return await this.http.request(method, path, body === undefined ? undefined : JSON.stringify(body)); }
    catch (error) { if (context && error && typeof error === "object") error.context = context; throw error; }
  }
  resolve(id) { return id === null || id === undefined ? id : this.aliases.has(String(id)) ? this.aliases.get(String(id)) : id; }
  alias(from, to, reconcile) { if (String(from) === String(to)) return; this.aliases.set(String(from), to); reconcile.mapId(from, to); }

  // ---- Server documents → adapter copy ------------------------------------------------------------------------
  workspaceFrom(w) { return { id: w.id, name: w.name, description: w.description, icon: w.icon, color: w.color, archived: w.archived, position: w.position, version: w.version, createdAt: w.createdAt }; }
  boardFrom(b, previous = this.boards.get(b.id)) {
    return {
      id: b.id, workspaceId: b.workspaceId, name: b.name, description: b.description, icon: b.icon, archived: b.archived, position: b.position,
      manualOrder: b.manualOrder, nextItemNumber: b.nextItemNumber, columns: resourceClone(b.columns), groups: resourceClone(b.groups),
      savedViews: resourceClone(b.savedViews), version: b.version, createdAt: b.createdAt, updatedAt: b.updatedAt,
      recordCount: b.recordCount ?? previous?.recordCount ?? 0,
      load: previous?.load || { state: "none", cursor: null, activity: [], recordActivity: {} }
    };
  }
  recordFrom(r) { return { id: r.id, boardId: r.boardId, values: resourceClone(r.values), groupId: r.groupId ?? null, position: r.position, archived: r.archived, pinned: r.pinned, version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt }; }
  boardRecords(boardId) { return [...this.records.values()].filter((r) => r.boardId === boardId).sort(byPosition); }

  // ---- Adapter copy → the model's in-memory shape --------------------------------------------------------------
  static groupKey(columns) { return columns.find((c) => c.type === "group")?.key; }
  modelRow(record, board) {
    const row = { id: record.id, ...resourceClone(record.values) };
    const groupKey = ResourceApiAdapter.groupKey(board.columns);
    if (groupKey) row[groupKey] = board.groups.find((g) => g.id === record.groupId)?.name ?? "";
    return { ...row, archived: record.archived, pinned: record.pinned, createdAt: record.createdAt, updatedAt: record.updatedAt, activity: resourceClone(board.load.recordActivity[record.id] || []) };
  }
  modelBoardFields(b) {
    // nextItemNumber is not shared: the model derives it from the board's "New item N" names when it loads.
    return { name: b.name, description: b.description, icon: b.icon, archived: b.archived, manualOrder: b.manualOrder, columns: resourceClone(b.columns), groups: b.groups.map((g) => g.name), savedViews: b.savedViews.map((v) => ({ ...resourceClone(v.state), id: v.id, name: v.name })), createdAt: b.createdAt, updatedAt: b.updatedAt, recordCount: b.recordCount };
  }
  modelBoard(b, pref = {}) {
    return { id: b.id, ...this.modelBoardFields(b), records: this.boardRecords(b.id).map((r) => this.modelRow(r, b)), activity: resourceClone(b.load.activity), favorite: Boolean(pref.favorite), ...(pref.lastView ? { lastView: pref.lastView } : {}), openCount: pref.openCount || 0 };
  }
  modelWorkspaces(prefs = {}) {
    return [...this.workspaces.values()].sort(byPosition).map((w) => ({
      id: w.id, name: w.name, description: w.description, icon: w.icon, color: w.color, archived: w.archived, createdAt: w.createdAt,
      boards: [...this.boards.values()].filter((b) => b.workspaceId === w.id).sort(byPosition).map((b) => this.modelBoard(b, prefs[b.id]))
    }));
  }

  // ---- Per-user state (this browser only) ----------------------------------------------------------------------
  readUserState() {
    try { const raw = this.device.read("local", this.userKey); const value = raw ? JSON.parse(raw) : {}; return value && typeof value === "object" ? value : {}; }
    catch { return {}; }
  }
  saveUserState(user, data) {
    const r = (id) => this.resolve(id);
    const boardPrefs = {};
    for (const w of data.workspaces || []) for (const b of w.boards || []) {
      if (b.favorite || b.lastView || b.openCount) boardPrefs[r(b.id)] = { favorite: Boolean(b.favorite), lastView: b.lastView, openCount: b.openCount || 0 };
    }
    const state = { ...user, currentWorkspaceId: r(user.currentWorkspaceId), currentBoardId: r(user.currentBoardId), members: data.members, boardPrefs };
    state.recentBoards = (user.recentBoards || []).map((x) => ({ ...x, boardId: r(x.boardId), workspaceId: r(x.workspaceId) }));
    state.recentRecords = (user.recentRecords || []).map((x) => ({ ...x, id: r(x.id), boardId: r(x.boardId), workspaceId: r(x.workspaceId) }));
    try { this.device.write("local", this.userKey, JSON.stringify(state)); } catch { /* per-user only; never blocks a shared save */ }
  }

  // ---- Load ----------------------------------------------------------------------------------------------------
  // Workspaces, then each workspace's board summaries (with record counts), then the open board's records.
  async loadResourceState() {
    this.reset();
    const stored = this.readUserState();
    try {
      const { items: workspaces } = await this.request("GET", "/workspaces");
      const lists = await Promise.all(workspaces.map((w) => this.request("GET", `/workspaces/${w.id}/boards`)));
      workspaces.forEach((w, i) => { this.workspaces.set(w.id, this.workspaceFrom(w)); for (const b of lists[i].items) this.boards.set(b.id, this.boardFrom(b)); });
      if (this.boards.has(stored.currentBoardId)) await this.loadBoardRecords(stored.currentBoardId);
    } catch (error) {
      if (!(error instanceof StorageError)) throw error;
      if (error.code === StorageError.CODES.OFFLINE || /took too long/.test(error.message)) throw error;
      throw new StorageError(error.code, "The JARC server couldn't load your workspaces. Try again in a moment.", error.cause);
    }
    const user = Object.fromEntries(ResourceApiAdapter.USER_FIELDS.filter((k) => stored[k] !== undefined).map((k) => [k, stored[k]]));
    const data = { workspaces: this.modelWorkspaces(stored.boardPrefs || {}) };
    // A new browser (or a selection deleted elsewhere) points at the first real workspace and board, never at the
    // local-mode defaults, which don't exist on the server.
    const workspace = data.workspaces.find((w) => w.id === user.currentWorkspaceId) || data.workspaces[0];
    if (workspace) {
      user.currentWorkspaceId = workspace.id;
      if (!workspace.boards.some((b) => b.id === user.currentBoardId)) user.currentBoardId = workspace.boards[0]?.id || "";
    }
    if (Array.isArray(stored.members)) data.members = stored.members;
    return { data, user };
  }

  // Records of one board, page by page (PAGE_SIZE), up to FULL_LOAD_LIMIT per call; `more` continues a large board.
  async fetchRecords(boardId, { more = false } = {}) {
    const board = this.boards.get(boardId);
    let cursor = more ? board.load.cursor : null;
    if (more && !cursor) return [];
    const ids = [];
    do {
      const query = `?limit=${ResourceApiAdapter.PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await this.request("GET", `/boards/${boardId}/records${query}`);
      for (const r of page.items) { this.records.set(r.id, this.recordFrom(r)); ids.push(r.id); }
      cursor = page.nextCursor;
    } while (cursor && ids.length < ResourceApiAdapter.FULL_LOAD_LIMIT);
    board.load.state = cursor ? "partial" : "full";
    board.load.cursor = cursor || null;
    return ids;
  }
  // Board history (read-only). Shown in the board's activity and the record drawer; failures are not fatal.
  async fetchActivity(boardId) {
    const board = this.boards.get(boardId);
    try {
      const { items } = await this.request("GET", `/boards/${boardId}/activity?limit=80`);
      const label = (field) => (field.startsWith("values.") ? board.columns.find((c) => c.key === field.slice(7))?.label || field.slice(7) : field === "groupId" ? "Group" : field.charAt(0).toUpperCase() + field.slice(1));
      const text = (e) => e.summary || ({ "record.created": "Record created", "record.deleted": "Record deleted", "record.updated": e.changes.length ? `Changed ${e.changes.map((c) => label(c.field)).join(", ")}` : "Record updated" })[e.action] || e.action.replace(/[._]/g, " ");
      board.load.activity = items.map((e) => ({ id: e.id, text: text(e), at: e.createdAt }));
      board.load.recordActivity = {};
      for (const e of [...items].reverse()) if (e.recordId) (board.load.recordActivity[e.recordId] ||= []).push({ at: e.createdAt, text: text(e), by: e.actorName || "" });
    } catch (error) { if (!(error instanceof StorageError)) throw error; }
  }
  async loadBoardRecords(boardId, { more = false } = {}) {
    const board = this.boards.get(this.resolve(boardId));
    if (!board) throw new StorageError(StorageError.CODES.NOT_FOUND, "This board no longer exists. Reload to see the latest data.");
    const ids = await this.fetchRecords(board.id, { more });
    if (!more) await this.fetchActivity(board.id);
    return { records: ids.map((id) => this.modelRow(this.records.get(id), board)), activity: more ? null : resourceClone(board.load.activity), state: board.load.state };
  }
  boardLoadState(boardId) {
    const board = this.boards.get(this.resolve(boardId));
    if (!board) return null;
    return { state: board.load.state, total: board.recordCount, loaded: board.load.state === "partial" ? this.boardRecords(board.id).length : undefined };
  }
  // Reloads the records already loaded for a board (after schema changes and conflicts) and returns model rows.
  async refreshBoardRecords(boardId) {
    const board = this.boards.get(boardId);
    const wanted = Math.max(this.boardRecords(boardId).length, 1);
    for (const r of this.boardRecords(boardId)) this.records.delete(r.id);
    if (board.load.state === "none") return [];
    let cursor = null, count = 0;
    do {
      const page = await this.request("GET", `/boards/${boardId}/records?limit=${ResourceApiAdapter.PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const r of page.items) { this.records.set(r.id, this.recordFrom(r)); count += 1; }
      cursor = page.nextCursor;
    } while (cursor && count < Math.max(wanted, ResourceApiAdapter.FULL_LOAD_LIMIT));
    board.load.state = cursor ? "partial" : "full";
    board.load.cursor = cursor || null;
    return this.boardRecords(boardId).map((r) => this.modelRow(r, board));
  }

  // ---- Save ----------------------------------------------------------------------------------------------------
  async commitState(change, { data, user }) {
    const reconcile = new ResourceReconcile();
    try {
      await this.sync(change, data, reconcile);
      return { reconcile };
    } catch (error) {
      const failure = error instanceof StorageError ? error : new StorageError(StorageError.CODES.INTERNAL_ERROR, "Something went wrong and your change wasn't saved.", error);
      if ([StorageError.CODES.CONFLICT, StorageError.CODES.NOT_FOUND].includes(failure.code) && error.context) await this.recover(error.context, reconcile);
      failure.reconcile = reconcile;
      throw failure;
    } finally {
      this.saveUserState(user || {}, data || {});
    }
  }

  // The model's state with temporary IDs already replaced by the server IDs this adapter knows.
  resolveTarget(workspaces) {
    const target = resourceClone(workspaces || []);
    for (const w of target) {
      w.id = this.resolve(w.id);
      for (const b of w.boards || []) {
        b.id = this.resolve(b.id);
        b.records = (b.records || []).map((r) => ({ ...r, id: this.resolve(r.id) }));
        for (const v of b.savedViews || []) v.id = this.resolve(v.id);
      }
    }
    return target;
  }
  blocked() { return new StorageError(StorageError.CODES.INTERNAL_ERROR, "This change would have removed shared data unexpectedly, so it wasn't saved. Reload to see the latest data."); }

  async sync(change, data, reconcile) {
    // A per-user change has nothing to send. Comparing its snapshot with the server copy anyway could only misfire:
    // a board's records may still be loading into the model (e.g. right after startup), which looks like deletions
    // and was refused with a false "wasn't saved" error.
    if ((change.ops || [change.op]).every((op) => ResourceApiAdapter.USER_ONLY_OPS.includes(op))) return;
    const target = this.resolveTarget(data.workspaces);
    const allowed = (kind) => ResourceApiAdapter.DELETE_OPS[kind].includes(change.op);
    const targetBoardIds = new Set(target.flatMap((w) => (w.boards || []).map((b) => String(b.id))));
    const goneWorkspaces = [...this.workspaces.keys()].filter((id) => !target.some((w) => String(w.id) === id));
    const goneBoards = [...this.boards.values()].filter((b) => !targetBoardIds.has(b.id) && !goneWorkspaces.includes(b.workspaceId)).map((b) => b.id);
    if ((goneWorkspaces.length && !allowed("workspaces")) || (goneBoards.length && !allowed("boards"))) throw this.blocked();

    for (const w of target) if (!this.workspaces.has(String(w.id))) await this.createWorkspace(w, reconcile);
    const created = new Set();
    for (const w of target) for (const b of w.boards || []) {
      if (!this.boards.has(String(b.id))) { await this.createBoard(w.id, b, reconcile); created.add(b.id); }
      else if (this.boards.get(b.id).workspaceId !== w.id) await this.moveBoard(b.id, w.id);
    }
    for (const w of target) await this.updateWorkspace(w);
    const deletions = [];
    for (const w of target) for (const b of w.boards || []) if (!created.has(b.id)) await this.syncBoard(b, change, reconcile, deletions);
    await this.syncOrder(target);
    const byBoard = new Map();
    for (const d of deletions) (byBoard.get(d.boardId) || byBoard.set(d.boardId, []).get(d.boardId)).push(d);
    for (const [boardId, list] of byBoard) await this.deleteRecords(boardId, list);
    for (const id of goneBoards) await this.deleteBoard(id);
    for (const id of goneWorkspaces) await this.deleteWorkspace(id);
  }

  // ---- Workspaces
  async createWorkspace(w, reconcile) {
    const body = { name: String(w.name || "").trim() || "Untitled workspace", description: w.description || "" };
    if (typeof w.icon === "string" && w.icon) body.icon = w.icon.slice(0, 4);
    if (typeof w.color === "string" && /^#[0-9a-f]{3,8}$/i.test(w.color)) body.color = w.color;
    const { workspace } = await this.request("POST", "/workspaces", body, { kind: "workspaces" });
    this.workspaces.set(workspace.id, this.workspaceFrom(workspace));
    this.alias(w.id, workspace.id, reconcile);
    w.id = workspace.id;
  }
  async updateWorkspace(w) {
    const s = this.workspaces.get(w.id), set = {};
    for (const field of ["name", "description", "icon", "color", "archived"]) {
      let value = w[field];
      if (value === undefined) continue;
      if (field === "archived") value = Boolean(value);
      if (field === "name") value = String(value).trim();
      if (field === "icon") value = String(value).slice(0, 4);
      if (field === "color" && !(value === "" || /^#[0-9a-f]{3,8}$/i.test(value))) continue;
      if (value !== s[field]) set[field] = value;
    }
    if (Object.keys(set).length) await this.patchWorkspace(w.id, set);
  }
  async patchWorkspace(id, set) {
    const s = this.workspaces.get(id);
    const { workspace } = await this.request("PATCH", `/workspaces/${id}`, { expectedVersion: s.version, ...set }, { kind: "workspace", id });
    this.workspaces.set(id, this.workspaceFrom(workspace));
  }
  async deleteWorkspace(id) {
    const s = this.workspaces.get(id);
    try { await this.request("DELETE", `/workspaces/${id}?expectedVersion=${s.version}`, undefined, { kind: "workspace", id }); }
    catch (error) { if (error.code !== StorageError.CODES.NOT_FOUND) throw error; } // already gone: nothing to do
    for (const b of [...this.boards.values()].filter((x) => x.workspaceId === id)) this.forgetBoard(b.id);
    this.workspaces.delete(id);
  }

  // ---- Boards
  columnsPayload(columns) {
    return (columns || []).map((c) => {
      const out = {};
      for (const field of ResourceApiAdapter.COLUMN_FIELDS) if (c[field] !== undefined) out[field] = c[field];
      out.label = String(out.label ?? "").trim();
      out.required = Boolean(out.required); out.visible = out.visible !== false;
      if (out.defaultValue === undefined || out.defaultValue === null || typeof out.defaultValue === "object") out.defaultValue = "";
      out.options = Array.isArray(out.options) ? out.options.map(String) : [];
      out.connection = typeof out.connection === "string" ? out.connection : "";
      if (!(typeof out.width === "number" && Number.isFinite(out.width) && out.width >= 0 && out.width <= 5000)) delete out.width;
      return out;
    });
  }
  static groupNames(groups) { return [...new Set((groups || []).map((g) => String(g).trim()).filter(Boolean))]; }
  static viewState(view) { const { id, name, ...state } = view; return resourceClone(state); }
  async createBoard(workspaceId, b, reconcile) {
    const body = {
      name: String(b.name || "").trim() || "Untitled board", description: b.description || "", icon: typeof b.icon === "string" && b.icon ? b.icon.slice(0, 4) : "D",
      archived: Boolean(b.archived), manualOrder: Boolean(b.manualOrder), columns: this.columnsPayload(b.columns),
      groups: ResourceApiAdapter.groupNames(b.groups).map((name) => ({ name })),
      savedViews: (b.savedViews || []).map((v) => ({ name: v.name, state: ResourceApiAdapter.viewState(v) }))
    };
    const { board } = await this.request("POST", `/workspaces/${workspaceId}/boards`, body, { kind: "boards" });
    this.boards.set(board.id, this.boardFrom(board, { load: { state: "full", cursor: null, activity: [], recordActivity: {} }, recordCount: 0 }));
    this.alias(b.id, board.id, reconcile);
    (b.savedViews || []).forEach((v, i) => this.alias(v.id, board.savedViews[i].id, reconcile));
    b.id = board.id;
    if ((b.records || []).length) {
      await this.ensureGroups(b, reconcile);
      const s = this.boards.get(board.id);
      const prep = this.recordPrep(s);
      await this.createRecords(board.id, b.records.map((row, i) => ({ row, ...this.recordFields(row, null, prep).full, position: (i + 1) * 1000 })), reconcile);
    }
  }
  async moveBoard(boardId, workspaceId) {
    const s = this.boards.get(boardId);
    const { board } = await this.request("POST", `/boards/${boardId}/move`, { expectedVersion: s.version, workspaceId }, { kind: "board", id: boardId });
    this.boards.set(boardId, this.boardFrom(board));
  }
  async patchBoard(boardId, set) {
    const s = this.boards.get(boardId);
    const { board } = await this.request("PATCH", `/boards/${boardId}`, { expectedVersion: s.version, ...set }, { kind: "board", id: boardId });
    this.boards.set(boardId, this.boardFrom(board));
    return this.boards.get(boardId);
  }
  // Column and group changes that rewrite records go to their own endpoints (one server transaction each).
  async schemaCall(method, boardId, path, body) {
    const s = this.boards.get(boardId);
    const sep = path.includes("?") ? "&" : "?";
    const url = method === "DELETE" ? `/boards/${boardId}${path}${sep}expectedVersion=${s.version}` : `/boards/${boardId}${path}`;
    const result = await this.request(method, url, method === "DELETE" ? undefined : { expectedVersion: s.version, ...body }, { kind: "board", id: boardId });
    this.boards.set(boardId, this.boardFrom(result.board));
    return result;
  }
  forgetBoard(boardId) { for (const r of this.boardRecords(boardId)) this.records.delete(r.id); this.boards.delete(boardId); }
  async deleteBoard(id) {
    const s = this.boards.get(id);
    try { await this.request("DELETE", `/boards/${id}?expectedVersion=${s.version}`, undefined, { kind: "board", id }); }
    catch (error) { if (error.code !== StorageError.CODES.NOT_FOUND) throw error; }
    this.forgetBoard(id);
  }
  static effectiveOptions(column) { return column.options?.length ? [...column.options] : [...(ResourceApiAdapter.FALLBACK_OPTIONS[column.type] || [])]; }

  async syncBoard(b, change, reconcile, deletions) {
    const id = b.id;
    const hinted = String(this.resolve(change.boardId)) === String(id);
    let s = this.boards.get(id);
    const targetColumns = this.columnsPayload(b.columns);
    const targetKeys = new Set(targetColumns.map((c) => c.key));
    let rewrote = false;
    // 1. Columns removed → DELETE column (server removes their values).
    for (const column of [...s.columns]) {
      if (targetKeys.has(column.key)) continue;
      const groupKey = ResourceApiAdapter.groupKey(this.boards.get(id).columns);
      await this.schemaCall("DELETE", id, `/columns/${encodeURIComponent(column.key)}`);
      for (const r of this.boardRecords(id)) { if (column.key === groupKey) r.groupId = null; else delete r.values[column.key]; }
    }
    // 2. Type changes → server converts values with the app's rules.
    for (const column of targetColumns) {
      const current = this.boards.get(id).columns.find((c) => c.key === column.key);
      if (current && current.type !== column.type) { await this.schemaCall("POST", id, `/columns/${encodeURIComponent(column.key)}/type`, { type: column.type }); rewrote = true; }
    }
    // 3. Options renamed or removed → server rewrites the values that used them.
    for (const column of targetColumns) {
      const current = this.boards.get(id).columns.find((c) => c.key === column.key);
      if (!current || current.type !== column.type || !ResourceApiAdapter.OPTION_TYPES.includes(column.type)) continue;
      const before = ResourceApiAdapter.effectiveOptions(current), after = column.options;
      if (!after.length || before.every((o) => after.includes(o))) continue;
      const items = hinted && change.columnKey === column.key && Array.isArray(change.optionItems)
        ? change.optionItems
        : after.map((o) => ({ from: before.includes(o) ? o : null, to: o }));
      await this.schemaCall("PUT", id, `/columns/${encodeURIComponent(column.key)}/options`, { items });
      rewrote = true;
    }
    // 4. New columns → server fills existing records (default value, or a copy when duplicating).
    for (const [index, column] of targetColumns.entries()) {
      const current = this.boards.get(id);
      if (current.columns.some((c) => c.key === column.key)) continue;
      const body = { column, index: Math.max(1, Math.min(index, current.columns.length)) };
      if (hinted && change.columnKey === column.key && change.copyFrom && current.columns.some((c) => c.key === change.copyFrom)) body.copyFrom = change.copyFrom;
      await this.schemaCall("POST", id, "/columns", body);
      rewrote = true;
    }
    if (rewrote) await this.refreshBoardRecords(id);
    s = this.boards.get(id);

    // 5. Groups. A deleted group moves its records server-side; renames keep the group ID.
    const hint = hinted ? change.group : null;
    if (hint?.remove) {
      const doomed = s.groups.find((g) => g.name === hint.remove);
      if (doomed && !ResourceApiAdapter.groupNames(b.groups).includes(hint.remove)) {
        const moveTo = s.groups.find((g) => g.name === hint.moveTo && g.id !== doomed.id);
        await this.schemaCall("DELETE", id, `/groups/${doomed.id}?moveTo=${moveTo ? moveTo.id : "none"}`);
        for (const r of this.boardRecords(id)) if (r.groupId === doomed.id) r.groupId = moveTo ? moveTo.id : null;
        s = this.boards.get(id);
      }
    }
    const names = await this.ensureGroups(b, reconcile, { dryRun: true });
    const desired = names.map((name) => {
      const same = s.groups.find((g) => g.name === name);
      if (same) return { ...same };
      if (hint?.to === name && hint.from && !names.includes(hint.from)) { const old = s.groups.find((g) => g.name === hint.from); if (old) return { ...old, name }; }
      return { name };
    });
    const removed = s.groups.filter((g) => !desired.some((d) => d.id === g.id));
    const phase1 = [...desired, ...removed]; // removed groups stay until their records have moved
    const groupsPayload = (list) => list.map((g) => (g.id ? { id: g.id, name: g.name, color: g.color ?? "" } : { name: g.name }));
    const comparable = (list) => list.map((g) => ({ id: g.id ?? null, name: g.name, color: g.color ?? "" }));

    // 6. Board fields, column settings, groups and saved views in one versioned PATCH.
    const set = {};
    const simple = { name: String(b.name ?? "").trim(), description: b.description ?? "", icon: typeof b.icon === "string" ? b.icon.slice(0, 4) : undefined, archived: Boolean(b.archived), manualOrder: Boolean(b.manualOrder) };
    for (const [field, value] of Object.entries(simple)) if (value !== undefined && value !== s[field]) set[field] = value;
    if (set.name === "") delete set.name; // the server requires a name; the model never saves an empty one
    const serverColumns = this.columnsPayload(s.columns);
    if (!resourceSame(targetColumns, serverColumns)) set.columns = targetColumns;
    if (!resourceSame(comparable(phase1), comparable(s.groups))) set.groups = groupsPayload(phase1);
    const knownViews = new Set(s.savedViews.map((v) => v.id));
    const views = (b.savedViews || []).map((v) => ({ id: knownViews.has(v.id) ? v.id : null, name: v.name, state: ResourceApiAdapter.viewState(v) }));
    if (!resourceSame(views, s.savedViews.map((v) => ({ id: v.id, name: v.name, state: v.state })))) set.savedViews = views.map((v) => (v.id ? v : { name: v.name, state: v.state }));
    if (Object.keys(set).length) {
      s = await this.patchBoard(id, set);
      if (set.savedViews) (b.savedViews || []).forEach((v, i) => { if (!knownViews.has(v.id) && s.savedViews[i]) this.alias(v.id, s.savedViews[i].id, reconcile); });
    }
    for (const name of names) if (!ResourceApiAdapter.groupNames(b.groups).includes(name)) reconcile.addGroup(id, name);

    // 7. Records.
    await this.syncRecords(b, change, reconcile, deletions);

    // 8. Remove groups that are no longer wanted, now that their records have moved.
    s = this.boards.get(id);
    if (removed.length) {
      const remaining = s.groups.filter((g) => !removed.some((r) => r.id === g.id));
      if (remaining.length !== s.groups.length) await this.patchBoard(id, { groups: groupsPayload(remaining) });
    }
  }

  // Group names the board needs: its own list plus any name a record uses that isn't listed yet.
  async ensureGroups(b, reconcile, { dryRun = false } = {}) {
    const s = this.boards.get(b.id);
    const names = ResourceApiAdapter.groupNames(b.groups);
    const groupKey = s ? ResourceApiAdapter.groupKey(s.columns) : ResourceApiAdapter.groupKey(b.columns || []);
    if (groupKey) for (const row of b.records || []) { const name = String(row[groupKey] ?? "").trim(); if (name && !names.includes(name)) names.push(name); }
    if (dryRun || !s) return names;
    const missing = names.filter((n) => !s.groups.some((g) => g.name === n));
    if (missing.length) {
      await this.patchBoard(b.id, { groups: [...s.groups.map((g) => ({ id: g.id, name: g.name, color: g.color ?? "" })), ...missing.map((name) => ({ name }))] });
      for (const name of missing) if (!ResourceApiAdapter.groupNames(b.groups).includes(name)) reconcile.addGroup(b.id, name);
    }
    return names;
  }

  // ---- Records
  recordPrep(s) {
    const groupKey = ResourceApiAdapter.groupKey(s.columns);
    return { groupKey, columns: s.columns.filter((c) => c.key !== groupKey), groupIds: new Map(s.groups.map((g) => [g.name, g.id])) };
  }
  static coerce(column, value) {
    if (value === null) return null;
    if (column.type === "checkbox") return typeof value === "boolean" ? value : ["true", "yes", "1"].includes(String(value).trim().toLowerCase());
    if (column.type === "number" && typeof value === "number") return value;
    return String(value);
  }
  // { full } is the complete payload for a new record; { diff } only what differs from the server copy.
  recordFields(row, current, { groupKey, columns, groupIds }) {
    const values = {}, changed = {};
    for (const column of columns) {
      if (row[column.key] === undefined) continue;
      const value = ResourceApiAdapter.coerce(column, row[column.key]);
      values[column.key] = value;
      if (!current || value !== current.values[column.key]) changed[column.key] = value;
    }
    const full = { values, archived: Boolean(row.archived), pinned: Boolean(row.pinned) };
    const diff = {};
    if (Object.keys(changed).length) diff.values = changed;
    if (groupKey) {
      const name = String(row[groupKey] ?? "").trim();
      full.groupId = name ? groupIds.get(name) ?? null : null;
      if (current && full.groupId !== (current.groupId ?? null)) diff.groupId = full.groupId;
    }
    if (current && full.archived !== current.archived) diff.archived = full.archived;
    if (current && full.pinned !== current.pinned) diff.pinned = full.pinned;
    return { full, diff };
  }
  async syncRecords(b, change, reconcile, deletions) {
    const s = this.boards.get(b.id);
    const existing = new Map(this.boardRecords(b.id).map((r) => [r.id, r]));
    if (!existing.size && !(b.records || []).length) return;
    const prep = this.recordPrep(s);
    const order = (b.records || []).map((r) => String(r.id)), present = new Set(order);
    const gone = [...existing.values()].filter((r) => !present.has(r.id));
    if (gone.length && !ResourceApiAdapter.DELETE_OPS.records.includes(change.op)) throw this.blocked();
    const positions = resourcePositions(order, (id) => existing.get(id)?.position);
    const creates = [], updates = [];
    for (const row of b.records || []) {
      const key = String(row.id), current = existing.get(key);
      const { full, diff } = this.recordFields(row, current, prep);
      if (!current) { creates.push({ row, ...full, position: positions.get(key) ?? 0 }); continue; }
      if (positions.has(key)) diff.position = positions.get(key);
      if (Object.keys(diff).length) updates.push({ id: key, expectedVersion: current.version, ...diff });
    }
    if (creates.length) await this.createRecords(b.id, creates, reconcile);
    if (updates.length) await this.updateRecords(b.id, updates);
    deletions.push(...gone.map((r) => ({ boardId: b.id, id: r.id, expectedVersion: r.version })));
  }
  async createRecords(boardId, items, reconcile) {
    const board = this.boards.get(boardId);
    for (let i = 0; i < items.length; i += ResourceApiAdapter.BATCH_LIMIT) {
      const chunk = items.slice(i, i + ResourceApiAdapter.BATCH_LIMIT);
      const body = chunk.map(({ values, groupId, archived, pinned, position }) => ({ values, ...(groupId !== undefined ? { groupId } : {}), archived, pinned, position }));
      const created = chunk.length === 1
        ? [(await this.request("POST", `/boards/${boardId}/records`, body[0], { kind: "boards" })).record]
        : (await this.request("POST", `/boards/${boardId}/records/batch`, { records: body }, { kind: "boards" })).items;
      created.forEach((record, n) => { this.records.set(record.id, this.recordFrom(record)); this.alias(chunk[n].row.id, record.id, reconcile); });
      board.recordCount += created.filter((r) => !r.archived).length;
    }
  }
  async updateRecords(boardId, updates) {
    if (updates.length === 1) {
      const { id, ...body } = updates[0];
      const { record } = await this.request("PATCH", `/records/${id}`, body, { kind: "record", id, boardId });
      this.records.set(record.id, this.recordFrom(record));
      return;
    }
    for (let i = 0; i < updates.length; i += ResourceApiAdapter.BATCH_LIMIT) {
      const { items } = await this.request("PATCH", `/boards/${boardId}/records`, { items: updates.slice(i, i + ResourceApiAdapter.BATCH_LIMIT) }, { kind: "records", boardId });
      for (const record of items) this.records.set(record.id, this.recordFrom(record));
    }
  }
  async deleteRecords(boardId, list) {
    const board = this.boards.get(boardId);
    if (list.length === 1) {
      const [{ id, expectedVersion }] = list;
      try { await this.request("DELETE", `/records/${id}?expectedVersion=${expectedVersion}`, undefined, { kind: "record", id, boardId }); }
      catch (error) { if (error.code !== StorageError.CODES.NOT_FOUND) throw error; } // already gone
    } else {
      for (let i = 0; i < list.length; i += ResourceApiAdapter.BATCH_LIMIT) {
        await this.request("POST", `/boards/${boardId}/records/delete`, { records: list.slice(i, i + ResourceApiAdapter.BATCH_LIMIT).map(({ id, expectedVersion }) => ({ id, expectedVersion })) }, { kind: "records", boardId });
      }
    }
    for (const { id } of list) { const r = this.records.get(id); if (r && !r.archived && board) board.recordCount = Math.max(0, board.recordCount - 1); this.records.delete(id); }
  }

  // ---- Order of workspaces and boards (positions), sent only for items whose place changed.
  async syncOrder(target) {
    const workspaceMoves = resourcePositions(target.map((w) => String(w.id)), (id) => this.workspaces.get(id)?.position);
    for (const [id, position] of workspaceMoves) await this.patchWorkspace(id, { position });
    for (const w of target) {
      const moves = resourcePositions((w.boards || []).map((b) => String(b.id)), (id) => this.boards.get(id)?.position);
      for (const [id, position] of moves) await this.patchBoard(id, { position });
    }
  }

  // ---- Conflicts: load the latest server copy of what failed, for the model to show.
  async recover(context, reconcile) {
    const gone = (error) => error instanceof StorageError && error.code === StorageError.CODES.NOT_FOUND;
    try {
      if (context.kind === "record") {
        try {
          const { record } = await this.request("GET", `/records/${context.id}`);
          this.records.set(record.id, this.recordFrom(record));
          const board = this.boards.get(record.boardId);
          if (board) reconcile.replaceRecord(record.boardId, this.modelRow(this.records.get(record.id), board));
        } catch (error) { if (!gone(error)) throw error; this.records.delete(context.id); reconcile.removeRecord(context.boardId, context.id); }
      } else if (context.kind === "records") {
        if (this.boards.has(context.boardId)) reconcile.replaceBoardRecords(context.boardId, await this.refreshBoardRecords(context.boardId));
      } else if (context.kind === "board") {
        try {
          const { board } = await this.request("GET", `/boards/${context.id}`);
          this.boards.set(board.id, this.boardFrom(board));
          reconcile.replaceBoard(board.id, this.modelBoardFields(this.boards.get(board.id)));
        } catch (error) { if (!gone(error)) throw error; this.forgetBoard(context.id); reconcile.removeBoard(context.id); }
      } else if (context.kind === "workspace") {
        try {
          const { workspace } = await this.request("GET", `/workspaces/${context.id}`);
          this.workspaces.set(workspace.id, this.workspaceFrom(workspace));
          const { boards, ...fields } = this.modelWorkspaces().find((w) => w.id === workspace.id) || {};
          reconcile.replaceWorkspace(workspace.id, fields);
        } catch (error) {
          if (!gone(error)) throw error;
          for (const b of [...this.boards.values()].filter((x) => x.workspaceId === context.id)) this.forgetBoard(b.id);
          this.workspaces.delete(context.id); reconcile.removeWorkspace(context.id);
        }
      }
    } catch { /* the latest copy couldn't be loaded; the model keeps its last saved state */ }
  }
}

window.ResourceApiAdapter = ResourceApiAdapter;
window.ResourceReconcile = ResourceReconcile;
