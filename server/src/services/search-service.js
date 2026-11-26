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
//
// Regular search (the record queries below) is TEMPORARY: the index is the intended implementation, and this stays only as the
// recovery path until production has been verified on the index. See server/README.md.
const { ApiError } = require("../middleware/errors");
const { RANK } = require("../auth/access");
const { encodeCursor } = require("../validation/search");
const { boardPlan, liveMatch, MAX_CANDIDATES } = require("./search-engines/atlas-engine");

const MAX_BOARDS = 300;
// One time budget per request, not per query: records, the item-name lookup and comments all share it, and each query's
// server time limit (maxTimeMS) is what is left of it. A query isn't started with less than MIN_QUERY_MS left.
const MAX_TIME_MS = 3000;
const MIN_QUERY_MS = 50;
// When the index or the comment query returns hits that the live check then drops, at most this many reads in total refill
// the page; after that the page says there may be more (the cursor continues after the last hit examined).
const MAX_READS = 3;
// Why a response (or one group) is incomplete. Additive fields: partialReasons on the response, partial + reason on a group.
// candidate_cap: the index / engine re-read MAX_CANDIDATES candidates without filling the page (stale or non-matching entries);
// the group's cursor continues after the last candidate examined.
const PARTIAL = Object.freeze({ BOARD_CAP: "board_cap", TIME_BUDGET: "time_budget", CANDIDATE_CAP: "candidate_cap" });
// Error codes the browser reads from { error: { code } }. SEARCH_UNAVAILABLE is raised by the search engine switch
// (search-engines/atlas-engine.js fallback, RECORD_SEARCH_ENGINE=atlas) with the same status and code.
const SEARCH_ERRORS = Object.freeze({
  SEARCH_TIMEOUT: { status: 503, message: "The search took too long. Try a longer search or add a filter." },
  SEARCH_UNAVAILABLE: { status: 503, message: "Search is unavailable right now. Try again in a moment." }
});
const searchError = (code, message) => new ApiError(SEARCH_ERRORS[code].status, code, message || SEARCH_ERRORS[code].message);
const SEARCHABLE_TYPES = new Set(["text", "status", "priority", "dropdown", "email", "phone", "link", "date"]);
const GROUP_LIMITS = Object.freeze({ workspace: 5, board: 8, record: 10, comment: 5 });
const MAX_RECENTS = 20;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const textOf = (v) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : String(v));
const safe = (text, max = 200) => String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
const hex = (id) => id.toHexString();
const timedOut = (error) => error?.code === 50 || error?.codeName === "MaxTimeMSExpired";
// After (time, _id) in newest-first order; records without a time sort last.
const afterClause = (time, id) => (time instanceof Date ? { $or: [{ updatedAt: { $lt: time } }, { updatedAt: time, _id: { $lt: id } }, { updatedAt: null }] } : { updatedAt: null, _id: { $lt: id } });
// The item-name test of a name query ({ "values.serial": { $regex, $options: "i" } }), on an already loaded record.
const nameMatches = (d, needle) => { const v = d.values?.serial; return (Array.isArray(v) ? v : [v]).some((x) => typeof x === "string" && x.toLowerCase().includes(needle)); };

// The request's shared time budget. ms(): the server time limit for the next query; spent(): too little left to start one.
function timeBudget(totalMs = MAX_TIME_MS, now = Date.now) {
  const end = now() + totalMs;
  const left = () => end - now();
  return { ms: () => Math.max(1, Math.floor(left())), spent: () => left() < MIN_QUERY_MS };
}

// Up to 40 characters before the match and 60 after, with ellipses where text was cut.
function snippetAround(text, needle) {
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return safe(text, 120) + (text.length > 120 ? "…" : "");
  const from = Math.max(0, at - 40), to = at + needle.length + 60;
  return `${from > 0 ? "…" : ""}${safe(text.slice(from, to), 200)}${to < text.length ? "…" : ""}`;
}

class SearchService {
  // index: services/record-search-index.js. Used only when switched on and caught up; otherwise records are searched directly.
  // engine: services/search-engines (RECORD_SEARCH_ENGINE); null = regex, the regular search below, unchanged.
  // now / budgetMs: the clock and the per-request budget (tests replace them; the budget is never raised above MAX_TIME_MS).
  constructor({ repos, index = null, engine = null }) { this.repos = repos; this.index = index; this.engine = engine; this.now = Date.now; this.budgetMs = MAX_TIME_MS; }

  budget() { return timeBudget(Math.min(this.budgetMs, MAX_TIME_MS), this.now); }

  // The index finds the matching IDs; the records are then read in that order, with the same projection as a direct search.
  // The record decides, not the index: one archived, deleted or on another board since its last index update is left out. Each
  // document keeps its place in the index's order (cursorAt), because that order is what the next page continues from.
  // The live record must also still match: the query text (plain lower-cased "contains" on its live cells / live name) and the
  // facet and date filters (search-engines/atlas-engine.js liveMatch), so a stale index entry is never shown (audit gap 9, F1).
  // Counts come from the live records only: left-out records don't use up the page, the next hits after the last one are read
  // (each read's maxTimeMS is what is left of the request's budget) until there are `limit` live records, the index has none
  // left, MAX_CANDIDATES hits in all were examined, MAX_READS index reads were made, or the budget is spent. The list says how it
  // ended:
  //   complete  every match is in the list (the index ran out);
  //   capped    the candidate or read cap ran out first (the group then says partial, reason candidate_cap);
  //   cut       the time budget ran out first (partial, reason time_budget);
  //   lastHit   the last index hit examined, where a next page continues when every hit was left out.
  async fromIndex(boards, { projection, limit, budget, needle = null, field = "text", extra = {}, and = [], ...options }) {
    const plans = new Map(boards.map((b) => [hex(b._id), boardPlan(b)]));
    const check = { needle, field, status: extra.status, priority: extra.priority, owner: extra.owner, from: extra.updatedAt?.$gte, to: extra.updatedAt?.$lt };
    const projected = { ...projection, boardId: 1, archived: 1, updatedAt: 1, "values.serial": 1 };
    for (const p of plans.values()) for (const k of [...p.textKeys, ...p.statusKeys, ...p.priorityKeys, ...p.ownerKeys]) projected[`values.${k}`] = 1;
    const cap = Math.max(MAX_CANDIDATES, limit), out = [];
    let examined = 0, reads = 0, lastHit = null, exhausted = false, cut = false;
    while (out.length < limit && examined < cap && reads < MAX_READS) {
      // The caller checked the budget before the first read; a refill isn't started without enough of it left.
      if (examined && budget.spent()) { cut = true; break; }
      reads += 1;
      const want = Math.min(cap - examined, limit - out.length + (examined ? 2 : 0));
      const after = lastHit ? [afterClause(lastHit.updatedAt ?? null, lastHit._id)] : [];
      const hits = await this.index.hits(boards, { ...options, field, extra, and: [...and, ...after], limit: want, maxTimeMS: budget.ms() });
      if (!hits.length) { exhausted = true; break; }
      examined += hits.length; lastHit = hits.at(-1);
      const byId = new Map((await this.repos.records.byIds(hits.map((h) => h._id), { projection: projected, maxTimeMS: budget.ms() })).map((d) => [hex(d._id), d]));
      for (const hit of hits) {
        const d = byId.get(hex(hit._id)), plan = plans.get(hex(hit.boardId));
        if (!d || d.archived || !d.boardId.equals(hit.boardId) || !plan || !liveMatch(d, plan, check)) continue;
        d.cursorAt = hit.updatedAt ?? null; out.push(d);
        if (out.length >= limit) break;
      }
      if (hits.length < want) { exhausted = true; break; }
    }
    out.found = out.length; out.lastHit = lastHit; out.complete = exhausted;
    out.capped = !exhausted && !cut && out.length < limit; out.cut = cut;
    return out;
  }

  // workspaceIds: ObjectIds the caller may see (null = all). Returns { items, more, partial }.
  async records(query, { workspaceIds, limit }) {
    const budget = this.budget();
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
      const projection = { _id: 1, boardId: 1, workspaceId: 1, ...Object.fromEntries([...projected].map((p) => [p, 1])) };
      // indexed.maxTimeMS is only for the background shadow comparison (its own limit); the reads below use the request budget.
      const indexed = { pattern: escapeRegex(query.toLowerCase()), needle: query.toLowerCase(), limit: limit + 1, maxTimeMS: MAX_TIME_MS }, boardsWithFields = searched.filter((b) => fieldsOf.has(hex(b._id)));
      if (budget.spent()) throw Object.assign(new Error("search budget spent"), { code: 50 });
      docs = this.index?.active ? await this.fromIndex(boardsWithFields, { ...indexed, projection, budget }) : await this.repos.records.searchText(clauses, { projection, limit: limit + 1, maxTimeMS: budget.ms() });
      // This query has no order, so with more matches than a page the two sides can't be expected to pick the same ones.
      if (this.index?.shadowing && docs.length <= limit) this.index.compare(docs.map((d) => d._id), boardsWithFields, indexed);
    } catch (error) {
      if (timedOut(error)) throw searchError("SEARCH_TIMEOUT", "The search took too long. Try a longer or more specific search.");
      throw error;
    }
    const needle = query.toLowerCase();
    // The workspace shown is the board's (a record's stored copy can lag a board move; P4-0).
    const workspaceOf = new Map(searched.map((b) => [b._id.toHexString(), b.workspaceId]));
    const items = docs.slice(0, limit).map((d) => {
      const fields = fieldsOf.get(d.boardId.toHexString()) || [];
      const title = textOf(d.values?.serial) || "Record";
      const hit = fields.find((f) => textOf(d.values?.[f.key]).toLowerCase().includes(needle));
      const matched = hit ? textOf(d.values[hit.key]) : "";
      const at = matched.toLowerCase().indexOf(needle), from = Math.max(0, at - 40);
      const snippet = !hit || hit.key === "serial" ? null : `${from > 0 ? "…" : ""}${matched.slice(from, at + needle.length + 60)}${at + needle.length + 60 < matched.length ? "…" : ""}`;
      return { recordId: d._id.toHexString(), boardId: d.boardId.toHexString(), workspaceId: (workspaceOf.get(d.boardId.toHexString()) ?? d.workspaceId).toHexString(), title: title.slice(0, 200), field: hit && hit.key !== "serial" ? { key: hit.key, label: hit.label } : null, snippet };
    });
    // Item-name matches first (names starting with the query before the rest); then cell matches.
    const rank = (i) => (i.field ? 2 : i.title.toLowerCase().startsWith(needle) ? 0 : 1);
    items.sort((a, b) => rank(a) - rank(b));
    // Only live records count; an index read that couldn't be completed may have more.
    return { items, more: docs.length > limit || docs.complete === false, partial };
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

  // params: validated by validation/search.js searchParams. Returns { groups: [{ type, items, more, next, partial?, reason? }],
  // partial, partialReasons, maxBoards? }. partial: the results may be incomplete; partialReasons says why: "board_cap" (more
  // than MAX_BOARDS boards are visible, only the first MAX_BOARDS were searched; maxBoards is then set) and/or "time_budget"
  // (a group was cut short or skipped to stay within the request's time budget) and/or "candidate_cap" (the index or engine
  // checked MAX_CANDIDATES candidates without filling the page). That group has partial: true and reason.
  async global(access, params) {
    const budget = this.budget();
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
    // Records first (a records time-out is a 503, as before); comments then get what is left of the budget. In a search for
    // more than one type, comments that don't fit in the budget are skipped or cut short and flagged, never silently dropped.
    if (types.includes("record")) groups.push(await this.recordGroup(scope, boards, params, limitFor("record"), budget));
    // Comments have no status, priority or assignee, so those filters leave them out (a date range still applies).
    if (types.includes("comment") && !params.status && !params.priority && !params.assignee) groups.push(await this.commentGroup(scope, boards, params, limitFor("comment"), budget, { degrade: !single }));
    const partialReasons = [...new Set([...(scope.partial ? [PARTIAL.BOARD_CAP] : []), ...groups.filter((g) => g.partial).map((g) => g.reason || PARTIAL.TIME_BUDGET)])];
    return { groups, partial: partialReasons.length > 0, partialReasons, ...(scope.partial ? { maxBoards: MAX_BOARDS } : {}) };
  }

  async recordGroup(scope, boards, { q, status, priority, assignee, from, to, cursor }, limit, budget = this.budget()) {
    const empty = { type: "record", items: [], more: false, next: null };
    const pattern = q ? escapeRegex(q) : null, needle = q.toLowerCase();
    const cursorClause = cursor ? afterClause(cursor.time, cursor.id) : null;
    // Name matches that led an earlier page, out of their turn: they aren't shown a second time when their turn comes.
    const alreadyShown = cursor?.exclude?.length ? { _id: { $nin: cursor.exclude } } : null;
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
      if (cursorClause) and.push(cursorClause);
      if (alreadyShown) and.push(alreadyShown);
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
    let docs, named = [], nameSkipped = false;
    // Status, priority and assignee filters use the same index: it holds those columns' values too.
    const searched = [...plans.values()].map((p) => p.board);
    const facets = { ...(status ? { status } : {}), ...(priority ? { priority } : {}), ...(assignee ? { owner: `user:${hex(assignee)}` } : {}) };
    const indexed = { pattern: pattern && escapeRegex(needle), needle: q ? needle : null, extra: { ...facets, ...(from || to ? { updatedAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) } } : {}) }, and: [cursorClause, alreadyShown].filter(Boolean) };
    // RECORD_SEARCH_ENGINE=atlas: Atlas Search finds candidates in exactly these boards (text and name in parallel, within what is
    // left of this request's budget); null = unavailable with exactly one board in scope → the regular path below answers.
    const ctx = { boards: searched, q, status, priority, assignee, from, to, cursor, projection };
    let viaEngine = null;
    try {
      if (budget.spent()) throw Object.assign(new Error("search budget spent"), { code: 50 });
      if (this.engine?.atlas) viaEngine = await this.engine.recordPage(ctx, { limit, nameLimit: nameClauses.length ? nameBudget : 0, budgetMs: budget.ms() }).catch((error) => this.engine.fallback(error, searched, { q }));
      if (viaEngine) ({ docs, named } = viaEngine);
      else if (budget.spent()) throw Object.assign(new Error("search budget spent"), { code: 50 });
      else if (this.index?.active) docs = await this.fromIndex(searched, { ...indexed, projection, limit: limit + 1, budget });
      else {
        docs = await this.repos.records.searchPage(clauses, { projection, limit: limit + 1, maxTimeMS: budget.ms() });
        // Background comparisons with their own time limits; they never delay or change this answer.
        if (pattern && !status && !priority && !assignee && this.index?.shadowing) this.index.compare(docs.map((d) => d._id), searched, { ...indexed, limit: limit + 1, maxTimeMS: MAX_TIME_MS });
        if (this.engine?.shadowing && docs.length <= limit) this.engine.shadowCompare(docs.map((d) => d._id), ctx, { limit });
      }
    } catch (error) {
      if (timedOut(error)) throw searchError("SEARCH_TIMEOUT");
      throw error;
    }
    // Every match is in hand: the main query found no more than a page (the expensive case — it read every record in scope).
    // An index or engine read that stopped early (candidate cap or time budget) is not complete, whatever its length.
    const complete = docs.length <= limit && docs.complete !== false && !docs.capped && !docs.cut;
    // The engine already found its name matches (in parallel, on the search index: not a scan).
    if (!viaEngine && nameClauses.length && nameBudget) {
      // The name query is the main query with only the item-name cell, so when the main query is complete its matches are
      // exactly the main results whose name matches, already newest first: no second read of the records. Otherwise it runs
      // after the main query (not alongside: both can be full scans) within what is left of the budget; when that runs out, the
      // page keeps its order without the name boost and says so.
      if (complete && searched.every((b) => plans.get(hex(b._id)).fields.some((f) => f.key === "serial"))) named = docs.filter((d) => nameMatches(d, needle)).slice(0, nameBudget);
      else if (budget.spent()) nameSkipped = true;
      else {
        try {
          named = this.index?.active ? await this.fromIndex(searched, { ...indexed, field: "name", projection, limit: nameBudget, budget }) : await this.repos.records.searchPage(nameClauses, { projection, limit: nameBudget, maxTimeMS: budget.ms() });
        } catch (error) {
          if (!timedOut(error)) throw error;
          named = []; nameSkipped = true;
        }
      }
    }
    const page = docs.slice(0, limit);
    // Name matches lead the first page (newest first); then the page in its own order. The cursor follows the last page document
    // that was shown, so page documents displaced by name matches come on the next page, never lost. The cursor also lists the name
    // matches its position hasn't reached, so they don't show again on a later page.
    const seen = new Set(), merged = [], passed = new Set();
    for (const d of named) { seen.add(hex(d._id)); merged.push(d); }
    let last = null;
    for (const d of page) {
      if (merged.length >= limit) break;
      last = d; passed.add(hex(d._id));
      if (!seen.has(hex(d._id))) { seen.add(hex(d._id)); merged.push(d); }
    }
    const notYetShown = page.slice(last ? page.indexOf(last) + 1 : 0).some((d) => !seen.has(hex(d._id)));
    // From live records only; an index or engine read that couldn't be completed (see fromIndex) may have more.
    const more = !complete || notYetShown;
    // Every record of a full page may have been left out (see fromIndex): the next page then continues from the last index match.
    // A page that stopped early (capped by candidates or cut by the budget) continues after the last candidate examined, so it
    // always moves on.
    const stopped = Boolean(docs.capped || docs.cut);
    const tail = (stopped && !notYetShown && docs.lastHit) || last || docs.lastHit;
    const exclude = [...(cursor?.exclude || []), ...named.filter((d) => !passed.has(hex(d._id))).map((d) => d._id)];
    const next = more && tail ? encodeCursor("record", tail.cursorAt !== undefined ? tail.cursorAt : tail.updatedAt, tail._id, exclude) : null;
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
    // One reason per group: a time cut first (the user can narrow the search), else the candidate cap (Show more continues).
    const reason = nameSkipped || docs.cut ? PARTIAL.TIME_BUDGET : docs.capped ? PARTIAL.CANDIDATE_CAP : null;
    return { type: "record", items, more, next, ...(reason ? { partial: true, reason } : {}) };
  }

  // degrade: when the budget runs out, return what was found with partial: true (and reason) instead of a 503 — used when the
  // search also asked for other types, so the records found aren't lost. A comments-only search keeps the 503 SEARCH_TIMEOUT.
  // more / next come from the comments that passed the live check (on a live, non-archived record of a searched board).
  async commentGroup(scope, boards, { q, from, to, cursor }, limit, budget = this.budget(), { degrade = false } = {}) {
    const empty = { type: "comment", items: [], more: false, next: null };
    if (!boards.length) return empty;
    const filter = { boardId: { $in: boards.map((b) => b._id) }, deletedAt: null };
    if (q) filter.body = { $regex: escapeRegex(q), $options: "i" };
    if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
    const after = (time, id) => [{ createdAt: { $lt: time } }, { createdAt: time, _id: { $lt: id } }];
    const boardOf = new Map(boards.map((b) => [hex(b._id), b]));
    // Live comments with their record, in order; lastRead: the last comment examined; exhausted: no more matching comments.
    const live = [];
    let lastRead = cursor ? { createdAt: cursor.time, _id: cursor.id } : null, exhausted = false, cut = false;
    for (let read = 0; read < MAX_READS && live.length <= limit && !exhausted; read += 1) {
      if (budget.spent()) { cut = true; break; }
      let docs, records;
      try {
        docs = await this.repos.comments.searchPage(lastRead ? { ...filter, $or: after(lastRead.createdAt, lastRead._id) } : filter, { limit: limit + 1, maxTimeMS: budget.ms() });
        records = docs.length ? await this.repos.records.titles([...new Map(docs.map((d) => [hex(d.recordId), d.recordId])).values()]) : [];
      } catch (error) {
        if (!timedOut(error)) throw error;
        cut = true; break;
      }
      if (docs.length <= limit) exhausted = true;
      const recordOf = new Map(records.map((r) => [hex(r._id), r]));
      for (const c of docs) {
        lastRead = c;
        const r = recordOf.get(hex(c.recordId)), b = boardOf.get(hex(c.boardId));
        // Comments on archived or deleted records stay out, like the records themselves.
        if (r && !r.archived && b && r.boardId.equals(b._id)) live.push({ c, r, b });
      }
    }
    if (cut && !degrade && !live.length) throw searchError("SEARCH_TIMEOUT");
    const page = live.slice(0, limit);
    // After the last shown comment when there are more live ones; otherwise after the last one examined (the rest were left out).
    // A group skipped before its first read has nowhere to continue from: more is false and partial says why.
    const at = live.length > limit ? page.at(-1).c : lastRead;
    const next = (live.length > limit || !exhausted) && at ? encodeCursor("comment", at.createdAt, at._id) : null;
    const more = next !== null;
    const items = [];
    for (const { c, r, b } of page) {
      const w = scope.workspaces.get(hex(b.workspaceId)), title = safe(textOf(r.values?.serial) || "Record");
      items.push({
        type: "comment", id: hex(c._id), title, snippet: snippetAround(String(c.body || ""), q.toLowerCase()), field: null,
        workspace: { id: hex(w._id), name: safe(w.name) }, board: { id: hex(b._id), name: safe(b.name) }, record: { id: hex(r._id), title },
        meta: { author: safe(c.authorName || "Unknown user", 100), createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : null, readOnly: Boolean(b.source?.readOnly) },
        target: { workspaceId: hex(w._id), boardId: hex(b._id), recordId: hex(r._id), commentId: hex(c._id) }, canEdit: this.canEdit(scope, b)
      });
    }
    return { type: "comment", items, more, next, ...(cut ? { partial: true, reason: PARTIAL.TIME_BUDGET } : {}) };
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

module.exports = { SearchService, MAX_BOARDS, MAX_TIME_MS, MIN_QUERY_MS, MAX_READS, PARTIAL, SEARCH_ERRORS, SEARCHABLE_TYPES, GROUP_LIMITS, MAX_RECENTS, escapeRegex, timeBudget };
