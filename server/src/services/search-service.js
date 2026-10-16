// Global search (GET /api/v1/search): records whose item name or text-like cells contain the query, across every
// board the caller may see — including boards they have never opened.
//
//   scope      workspaces from the caller's access (auth/access.js visibleRoles: their memberships; everything for
//              JARC admins and under development_shared), excluding archived workspaces; their non-archived boards
//              (at most MAX_BOARDS); non-archived records only.
//   matching   case-insensitive "contains", the query taken literally (regex characters escaped). Per board, only
//              these column types: the item name and text, status, priority, dropdown, email, phone, link and date
//              cells. Never People (user references), Files (attachments are their own documents and are never
//              read here), checkboxes or numbers.
//   cost       ONE query: { archived: false, $or: [{ boardId, $or: [cell regexes] } per board] }. Each branch uses the
//              records' boardId indexes, then filters that board's records; it stops after limit + 1 matches and the
//              server stops it after MAX_TIME_MS. Only the searchable cells are read (projection).
//   result     the minimum to show and open a result: IDs, the item name, which column matched and a short snippet.
//
// Command Center search (GET /api/v1/search/global, Phase 14) uses the same scope and matching rules and adds:
//   types      workspaces and boards (by name, from the bounded lists above — no extra reads), records, and
//              comments (Updates: body text, not deleted, on non-archived records of searchable boards).
//   filters    workspace, board, status / priority (equality on that board's own status- or priority-type columns;
//              boards without such a column are left out), assignee (People columns holding "user:<id>"), and an
//              updated (records) / posted (comments) date range. Boards never share column keys by assumption.
//   order      records newest-updated first, comments newest first, each with a stable (time, _id) cursor; per
//              board that order comes from the board_updated / board_created indexes. On a first page, item-name
//              matches are fetched first so an exact name isn't pushed out by many cell matches.
//   access     the caller's role in each workspace decides canEdit (MEMBER or above, and never on a read-only
//              synchronized board). Visibility and editing are separate: a VIEWER finds records but can't create.
const { ApiError } = require("../middleware/errors");
const { RANK } = require("../auth/access");
const { encodeCursor } = require("../validation/search");

const MAX_BOARDS = 300;
const MAX_TIME_MS = 3000;
const SEARCHABLE_TYPES = new Set(["text", "status", "priority", "dropdown", "email", "phone", "link", "date"]);
const GROUP_LIMITS = Object.freeze({ workspace: 5, board: 8, record: 10, comment: 5 });
const MAX_RECENTS = 20;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const textOf = (v) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : String(v));
const safe = (text, max = 200) => String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
const hex = (id) => id.toHexString();
const timedOut = (error) => error?.code === 50 || error?.codeName === "MaxTimeMSExpired";

// Up to 40 characters before the match and 60 after, with ellipses where text was cut.
function snippetAround(text, needle) {
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return safe(text, 120) + (text.length > 120 ? "…" : "");
  const from = Math.max(0, at - 40), to = at + needle.length + 60;
  return `${from > 0 ? "…" : ""}${safe(text.slice(from, to), 200)}${to < text.length ? "…" : ""}`;
}

class SearchService {
  constructor({ repos }) { this.repos = repos; }

  // workspaceIds: ObjectIds the caller may see (null = all). Returns { items, more, partial }.
  async records(query, { workspaceIds, limit }) {
    const workspaces = (await this.repos.workspaces.list()).filter((w) => !w.archived && (!workspaceIds || workspaceIds.some((id) => id.equals(w._id))));
    if (!workspaces.length) return { items: [], more: false, partial: false };
    const boards = await this.repos.boards.listForSearch(workspaces.map((w) => w._id), { limit: MAX_BOARDS + 1 });
    const partial = boards.length > MAX_BOARDS;
    const searched = boards.slice(0, MAX_BOARDS);
    const pattern = escapeRegex(query);
    const fieldsOf = new Map(), clauses = [], projected = new Set(["values.serial"]);
    for (const b of searched) {
      const fields = (b.columns || []).filter((c) => c.key === "serial" || SEARCHABLE_TYPES.has(c.type)).map((c) => ({ key: c.key, label: c.label }));
      if (!fields.length) continue;
      fieldsOf.set(b._id.toHexString(), fields);
      fields.forEach((f) => projected.add(`values.${f.key}`));
      clauses.push({ boardId: b._id, $or: fields.map((f) => ({ [`values.${f.key}`]: { $regex: pattern, $options: "i" } })) });
    }
    if (!clauses.length) return { items: [], more: false, partial };
    let docs;
    try {
      docs = await this.repos.records.searchText(clauses, { projection: { _id: 1, boardId: 1, workspaceId: 1, ...Object.fromEntries([...projected].map((p) => [p, 1])) }, limit: limit + 1, maxTimeMS: MAX_TIME_MS });
    } catch (error) {
      if (timedOut(error)) throw new ApiError(503, "SEARCH_TIMEOUT", "The search took too long. Try a longer or more specific search.");
      throw error;
    }
    const needle = query.toLowerCase();
    const items = docs.slice(0, limit).map((d) => {
      const fields = fieldsOf.get(d.boardId.toHexString()) || [];
      const title = textOf(d.values?.serial) || "Record";
      const hit = fields.find((f) => textOf(d.values?.[f.key]).toLowerCase().includes(needle));
      const matched = hit ? textOf(d.values[hit.key]) : "";
      const at = matched.toLowerCase().indexOf(needle), from = Math.max(0, at - 40);
      const snippet = !hit || hit.key === "serial" ? null : `${from > 0 ? "…" : ""}${matched.slice(from, at + needle.length + 60)}${at + needle.length + 60 < matched.length ? "…" : ""}`;
      return { recordId: d._id.toHexString(), boardId: d.boardId.toHexString(), workspaceId: d.workspaceId.toHexString(), title: title.slice(0, 200), field: hit && hit.key !== "serial" ? { key: hit.key, label: hit.label } : null, snippet };
    });
    // Item-name matches first (names starting with the query before the rest); then cell matches.
    const rank = (i) => (i.field ? 2 : i.title.toLowerCase().startsWith(needle) ? 0 : 1);
    items.sort((a, b) => rank(a) - rank(b));
    return { items, more: docs.length > limit, partial };
  }

  // ---- Command Center (Phase 14) ------------------------------------------------------------------------------

  // What the caller may see right now: non-archived visible workspaces with the caller's role, and their non-archived
  // boards. roles: Map(workspaceIdHex → role) or null with globalRole (every workspace).
  async scope({ roles, globalRole }) {
    const workspaces = (await this.repos.workspaces.list()).filter((w) => !w.archived && (!roles || roles.has(hex(w._id))));
    const roleOf = (id) => (roles ? roles.get(hex(id)) : globalRole);
    const boards = workspaces.length ? await this.repos.boards.listForSearch(workspaces.map((w) => w._id), { limit: MAX_BOARDS + 1, withNames: true }) : [];
    return { workspaces: new Map(workspaces.map((w) => [hex(w._id), w])), roleOf, boards: boards.slice(0, MAX_BOARDS), partial: boards.length > MAX_BOARDS };
  }

  canEdit(scope, board) { return !board.source?.readOnly && RANK[scope.roleOf(board.workspaceId)] >= RANK.MEMBER; }

  workspaceItem(scope, w) {
    return { type: "workspace", id: hex(w._id), title: safe(w.name), snippet: null, field: null, workspace: { id: hex(w._id), name: safe(w.name) }, board: null, record: null, meta: { icon: safe(w.icon || "", 40) }, target: { workspaceId: hex(w._id) }, canEdit: RANK[scope.roleOf(w._id)] >= RANK.MEMBER };
  }
  boardItem(scope, b) {
    const w = scope.workspaces.get(hex(b.workspaceId));
    return { type: "board", id: hex(b._id), title: safe(b.name), snippet: null, field: null, workspace: { id: hex(w._id), name: safe(w.name) }, board: { id: hex(b._id), name: safe(b.name) }, record: null, meta: { icon: safe(b.icon || "", 40), readOnly: Boolean(b.source?.readOnly) }, target: { workspaceId: hex(w._id), boardId: hex(b._id) }, canEdit: this.canEdit(scope, b) };
  }

  // params: validated by validation/search.js searchParams. Returns { groups: [{ type, items, more, next }], partial }.
  async global(access, params) {
    const scope = await this.scope(access);
    const { q, types, workspaceId, boardId, narrowed } = params;
    const single = types.length === 1;
    const limitFor = (type) => (single ? params.limit || 10 : Math.min(params.limit || GROUP_LIMITS[type], GROUP_LIMITS[type] * 2));
    // Workspace/board filters narrow the boards searched. One the caller can't see simply matches nothing.
    let boards = scope.boards;
    if (workspaceId) boards = boards.filter((b) => b.workspaceId.equals(workspaceId));
    if (boardId) boards = boards.filter((b) => b._id.equals(boardId));
    const needle = q.toLowerCase();
    const groups = [];
    const byName = (a, b) => Number(!a.title.toLowerCase().startsWith(needle)) - Number(!b.title.toLowerCase().startsWith(needle));
    // Workspaces and boards match by name only, so record filters (status, dates, …) leave them out.
    if (types.includes("workspace") && q && !narrowed && !boardId) {
      const all = [...scope.workspaces.values()].filter((w) => (!workspaceId || w._id.equals(workspaceId)) && String(w.name || "").toLowerCase().includes(needle)).map((w) => this.workspaceItem(scope, w)).sort(byName);
      groups.push({ type: "workspace", items: all.slice(0, limitFor("workspace")), more: all.length > limitFor("workspace"), next: null });
    }
    if (types.includes("board") && q && !narrowed) {
      const all = boards.filter((b) => String(b.name || "").toLowerCase().includes(needle)).map((b) => this.boardItem(scope, b)).sort(byName);
      groups.push({ type: "board", items: all.slice(0, limitFor("board")), more: all.length > limitFor("board"), next: null });
    }
    if (types.includes("record")) groups.push(await this.recordGroup(scope, boards, params, limitFor("record")));
    // Comments have no status, priority or assignee, so those filters leave them out (a date range still applies).
    if (types.includes("comment") && !params.status && !params.priority && !params.assignee) groups.push(await this.commentGroup(scope, boards, params, limitFor("comment")));
    return { groups, partial: scope.partial };
  }

  async recordGroup(scope, boards, { q, status, priority, assignee, from, to, cursor }, limit) {
    const empty = { type: "record", items: [], more: false, next: null };
    const pattern = q ? escapeRegex(q) : null, needle = q.toLowerCase();
    const plans = new Map(), clauses = [], nameClauses = [], projected = new Set(["values.serial"]);
    const keysOf = (b, type) => (b.columns || []).filter((c) => c.type === type).map((c) => c.key);
    const anyOf = (keys, value) => ({ $or: keys.map((k) => ({ [`values.${k}`]: value })) });
    for (const b of boards) {
      const fields = (b.columns || []).filter((c) => c.key === "serial" || SEARCHABLE_TYPES.has(c.type)).map((c) => ({ key: c.key, label: c.label }));
      const statusKeys = keysOf(b, "status"), priorityKeys = keysOf(b, "priority"), ownerKeys = keysOf(b, "owner");
      // A filter on a column type this board doesn't have: none of its records can match.
      if ((q && !fields.length) || (status && !statusKeys.length) || (priority && !priorityKeys.length) || (assignee && !ownerKeys.length)) continue;
      const and = [];
      if (pattern) and.push({ $or: fields.map((f) => ({ [`values.${f.key}`]: { $regex: pattern, $options: "i" } })) });
      if (status) and.push(anyOf(statusKeys, status));
      if (priority) and.push(anyOf(priorityKeys, priority));
      if (assignee) and.push(anyOf(ownerKeys, `user:${hex(assignee)}`));
      const clause = { boardId: b._id };
      if (from || to) clause.updatedAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
      if (cursor) and.push(cursor.time ? { $or: [{ updatedAt: { $lt: cursor.time } }, { updatedAt: cursor.time, _id: { $lt: cursor.id } }, { updatedAt: null }] } : { updatedAt: null, _id: { $lt: cursor.id } });
      if (and.length) clause.$and = and;
      clauses.push(clause);
      if (pattern && !cursor) nameClauses.push({ ...clause, $and: [{ "values.serial": { $regex: pattern, $options: "i" } }, ...and.slice(1)] });
      plans.set(hex(b._id), { board: b, fields, statusKey: statusKeys[0], priorityKey: priorityKeys[0] });
      fields.forEach((f) => projected.add(`values.${f.key}`));
      if (statusKeys[0]) projected.add(`values.${statusKeys[0]}`);
      if (priorityKeys[0]) projected.add(`values.${priorityKeys[0]}`);
    }
    if (!clauses.length) return empty;
    const projection = { _id: 1, boardId: 1, workspaceId: 1, updatedAt: 1, ...Object.fromEntries([...projected].map((p) => [p, 1])) };
    // Name matches may take at most half of a first page, so the page always moves the cursor forward.
    const nameBudget = Math.floor(limit / 2);
    let docs, named = [];
    try {
      docs = await this.repos.records.searchPage(clauses, { projection, limit: limit + 1, maxTimeMS: MAX_TIME_MS });
      if (nameClauses.length && nameBudget) named = await this.repos.records.searchPage(nameClauses, { projection, limit: nameBudget, maxTimeMS: MAX_TIME_MS });
    } catch (error) {
      if (timedOut(error)) throw new ApiError(503, "SEARCH_TIMEOUT", "The search took too long. Try a longer search or add a filter.");
      throw error;
    }
    const page = docs.slice(0, limit);
    // Name matches lead the first page (newest first); then the page in its own order. The cursor follows the last
    // page document that was shown, so page documents displaced by name matches come on the next page, never lost
    // (a name match may show again there; the client skips repeats).
    const seen = new Set(), merged = [];
    for (const d of named) { seen.add(hex(d._id)); merged.push(d); }
    let last = null;
    for (const d of page) {
      if (merged.length >= limit) break;
      last = d;
      if (!seen.has(hex(d._id))) { seen.add(hex(d._id)); merged.push(d); }
    }
    const more = docs.length > limit || (last !== null && last !== page.at(-1));
    const next = more ? encodeCursor("record", last.updatedAt, last._id) : null;
    const items = merged.map((d) => {
      const plan = plans.get(hex(d.boardId)), b = plan.board, w = scope.workspaces.get(hex(b.workspaceId));
      const title = safe(textOf(d.values?.serial) || "Record");
      const hit = q ? plan.fields.find((f) => textOf(d.values?.[f.key]).toLowerCase().includes(needle)) : null;
      const cell = hit && hit.key !== "serial";
      return {
        type: "record", id: hex(d._id), title, snippet: cell ? snippetAround(textOf(d.values[hit.key]), needle) : null, field: cell ? { key: hit.key, label: safe(hit.label, 100) } : null,
        workspace: { id: hex(w._id), name: safe(w.name) }, board: { id: hex(b._id), name: safe(b.name) }, record: { id: hex(d._id), title },
        meta: { status: plan.statusKey ? safe(textOf(d.values?.[plan.statusKey]), 100) || null : null, priority: plan.priorityKey ? safe(textOf(d.values?.[plan.priorityKey]), 100) || null : null, updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : null, readOnly: Boolean(b.source?.readOnly) },
        target: { workspaceId: hex(w._id), boardId: hex(b._id), recordId: hex(d._id) }, canEdit: this.canEdit(scope, b)
      };
    });
    return { type: "record", items, more, next };
  }

  async commentGroup(scope, boards, { q, from, to, cursor }, limit) {
    const empty = { type: "comment", items: [], more: false, next: null };
    if (!boards.length) return empty;
    const filter = { boardId: { $in: boards.map((b) => b._id) }, deletedAt: null };
    if (q) filter.body = { $regex: escapeRegex(q), $options: "i" };
    if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
    if (cursor) filter.$or = [{ createdAt: { $lt: cursor.time } }, { createdAt: cursor.time, _id: { $lt: cursor.id } }];
    let docs, records;
    try {
      docs = await this.repos.comments.searchPage(filter, { limit: limit + 1, maxTimeMS: MAX_TIME_MS });
      records = await this.repos.records.titles([...new Set(docs.slice(0, limit).map((d) => hex(d.recordId)))].map((id) => docs.find((d) => hex(d.recordId) === id).recordId));
    } catch (error) {
      if (timedOut(error)) throw new ApiError(503, "SEARCH_TIMEOUT", "The search took too long. Try a longer search or add a filter.");
      throw error;
    }
    const page = docs.slice(0, limit), more = docs.length > limit;
    const next = more ? encodeCursor("comment", page.at(-1).createdAt, page.at(-1)._id) : null;
    const boardOf = new Map(boards.map((b) => [hex(b._id), b])), recordOf = new Map(records.map((r) => [hex(r._id), r]));
    const items = [];
    for (const c of page) {
      const r = recordOf.get(hex(c.recordId)), b = boardOf.get(hex(c.boardId));
      // Comments on archived or deleted records stay out, like the records themselves.
      if (!r || r.archived || !b || !r.boardId.equals(b._id)) continue;
      const w = scope.workspaces.get(hex(b.workspaceId)), title = safe(textOf(r.values?.serial) || "Record");
      items.push({
        type: "comment", id: hex(c._id), title, snippet: snippetAround(String(c.body || ""), q.toLowerCase()), field: null,
        workspace: { id: hex(w._id), name: safe(w.name) }, board: { id: hex(b._id), name: safe(b.name) }, record: { id: hex(r._id), title },
        meta: { author: safe(c.authorName || "Unknown user", 100), createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : null, readOnly: Boolean(b.source?.readOnly) },
        target: { workspaceId: hex(w._id), boardId: hex(b._id), recordId: hex(r._id), commentId: hex(c._id) }, canEdit: this.canEdit(scope, b)
      });
    }
    return { type: "comment", items, more, next };
  }

  // Recently visited destinations (GET /me/recents): only those the caller can still open. refs: [{ type, id }].
  async destinations(access, refs) {
    const scope = await this.scope(access);
    const boardOf = new Map(scope.boards.map((b) => [hex(b._id), b]));
    const recordIds = refs.filter((r) => r.type === "record").map((r) => r.id);
    const records = recordIds.length ? await this.repos.records.titles(recordIds) : [];
    const recordOf = new Map(records.map((r) => [hex(r._id), r]));
    const items = [];
    for (const ref of refs) {
      const id = hex(ref.id);
      if (ref.type === "workspace" && scope.workspaces.has(id)) items.push(this.workspaceItem(scope, scope.workspaces.get(id)));
      if (ref.type === "board" && boardOf.has(id)) items.push(this.boardItem(scope, boardOf.get(id)));
      if (ref.type === "record") {
        const r = recordOf.get(id), b = r && boardOf.get(hex(r.boardId));
        if (!r || r.archived || !b) continue;
        const item = this.boardItem(scope, b), title = safe(textOf(r.values?.serial) || "Record");
        items.push({ ...item, type: "record", id, title, record: { id, title }, meta: { readOnly: item.meta.readOnly }, target: { ...item.target, recordId: id } });
      }
    }
    return items;
  }
}

module.exports = { SearchService, MAX_BOARDS, MAX_TIME_MS, SEARCHABLE_TYPES, GROUP_LIMITS, MAX_RECENTS, escapeRegex };
