// Record search on Atlas Search (RECORD_SEARCH_ENGINE, config/index.js):
//   regex   (default) not used at all: search-service.js runs the regular query exactly as before.
//   shadow  the regular query answers; on a sample of cheap searches (exactly one board in scope, a complete first page)
//           this runs too, with its own small budget, and logs only counts, timings and difference counts.
//   atlas   this answers record search for Command Center (GET /search/global).
//
// How a page is found (recordPage):
//   1. candidates  $search on recordSearch (atlas-query.js) with boardId IN the caller's boards and archived:false inside the
//                  query, sorted updatedAt/_id desc, at most what the page still needs (+2).
//   2. live check  the candidates' records are re-read from `records` and kept only if the record exists, is not archived, is
//                  still on the candidate's board, that board is one of the caller's boards, and the query really matches the
//                  live record's searchable cells (plain lower-cased "contains"; the name query: the live item name)
//                  (also the status / priority / assignee / date filters). This guards stale index documents and analyzer
//                  edge cases; a stale entry can cost a missed hit, never an exposure.
//   3. bounded     at most maxCandidates (50) records are re-read per page, in at most maxRounds (3) $search + re-read round
//                  trips; when either runs out before the page is full the page says capped (the group reports partial: true,
//                  reason candidate_cap, and continues from the last candidate examined).
//                  Counts and `more` come only from verified records.
// Availability: before use the index must be queryable ($listSearchIndexes, cached briefly). An index-unavailable error (index
// missing or not queryable, the status check failing, Atlas Search not enabled, index not found, the cluster unreachable) makes
// the engine unavailable for everyone (cached for a few seconds, so callers get a fast answer); any other $search error other
// than a timeout fails only that request. Either way the search service answers 503 SEARCH_UNAVAILABLE, or uses the regular query only when exactly
// one board is in scope. Never the all-board scan.
// Logs: never the query text (it is user input), only its length, board counts, reasons, counts and timings.
//
// Board-level access hook (10-security-review.md §3): the engine searches exactly the boards it is given — scope.boards after the
// request's workspace / board filters — as the boardId `in` filter, and a live record must be on one of them. It never reads
// employeeAccess, never calls Access and never takes board IDs from the client or the index. When board access ships, the routes
// pass access.visibility() → { roles, granted } to SearchService.scope(), which adds granted boards / removes NONE boards; this
// file needs no change. Until then `granted` is empty (fails closed: grants only add access).
const { ApiError } = require("../../middleware/errors");
const { searchableKeys } = require("../record-search-index");
const { recordSearchPipeline, MIN_BIGRAM } = require("./atlas-query");

const MODES = Object.freeze(["regex", "shadow", "atlas"]);
const MAX_CANDIDATES = 50;
const MAX_ROUNDS = 3; // $search + re-read round trips per page (as search-service.js MAX_READS)
const STATUS_TTL_MS = 30000, FAILED_TTL_MS = 5000, LOG_EVERY_MS = 10000;
const hex = (id) => id.toHexString();
const strings = (value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
const timedOut = (error) => error?.code === 50 || error?.codeName === "MaxTimeMSExpired";
// Errors that mean the index itself can't answer anyone right now; only these are remembered for every caller (failedTtlMs).
// HostUnreachable, HostNotFound, IndexNotFound, SearchNotEnabled, unrecognized stage, Atlas-only stage
const INDEX_UNAVAILABLE_CODES = new Set([6, 7, 27, 31082, 40324, 6047401]);
const INDEX_UNAVAILABLE_NAMES = new Set(["HostUnreachable", "HostNotFound", "IndexNotFound", "SearchNotEnabled", "MongoNetworkError", "MongoServerSelectionError", "MongoTopologyClosedError"]);
const indexUnavailable = (error) => error instanceof SearchEngineUnavailable || INDEX_UNAVAILABLE_CODES.has(error?.code) || INDEX_UNAVAILABLE_NAMES.has(error?.codeName) || INDEX_UNAVAILABLE_NAMES.has(error?.name);
const budgetSpent = () => Object.assign(new Error("record search time budget spent"), { code: 50, codeName: "MaxTimeMSExpired" });

class SearchEngineUnavailable extends Error {
  constructor(reason) { super(`Atlas Search is unavailable: ${reason}`); this.name = "SearchEngineUnavailable"; this.reason = reason; }
}

// What each board contributes to the live check: the same columns the regular search and the index use.
function boardPlan(board) {
  const keysOf = (type) => (board.columns || []).filter((c) => c.type === type).map((c) => c.key);
  return { board, textKeys: searchableKeys(board), statusKeys: keysOf("status"), priorityKeys: keysOf("priority"), ownerKeys: keysOf("owner") };
}

// Does the live record still match? Same rules as the regular query in search-service.js recordGroup.
// The text check is a plain lower-cased "contains" of the needle (no pattern is built from user input at all).
function liveMatch(record, plan, { needle = null, field = "text", status, priority, owner, from, to }) {
  const has = (keys, value) => keys.some((k) => strings(record.values?.[k]).includes(value));
  if (needle && !(field === "name" ? ["serial"] : plan.textKeys).some((k) => strings(record.values?.[k]).some((v) => v.toLowerCase().includes(needle)))) return false;
  if (status && !has(plan.statusKeys, status)) return false;
  if (priority && !has(plan.priorityKeys, priority)) return false;
  if (owner && !has(plan.ownerKeys, owner)) return false;
  const at = record.updatedAt instanceof Date ? record.updatedAt.getTime() : null;
  if (from && (at === null || at < from.getTime())) return false;
  if (to && (at === null || at >= to.getTime())) return false;
  return true;
}

class AtlasRecordSearch {
  constructor({ repos, logger = console, mode = "regex", indexName = "jarc_text", shadowSample = 0.1, maxCandidates = MAX_CANDIDATES, maxRounds = MAX_ROUNDS, shadowBudgetMs = 1000, statusTtlMs = STATUS_TTL_MS, failedTtlMs = FAILED_TTL_MS, random = Math.random, now = Date.now }) {
    if (!MODES.includes(mode)) throw new Error(`Unknown record search engine: ${mode}`);
    Object.assign(this, { repos, logger, mode, indexName, shadowSample, maxCandidates, maxRounds, shadowBudgetMs, statusTtlMs, failedTtlMs, random, now, status: null, checking: null, lastLog: 0, quiet: 0 });
  }

  get atlas() { return this.mode === "atlas"; }
  get shadowing() { return this.mode === "shadow"; }
  get collection() { return this.repos.recordSearch.collection; }

  warn(message) {
    const t = this.now();
    if (t - this.lastLog < LOG_EVERY_MS) { this.quiet += 1; return; }
    this.logger.warn?.(`[search-engine] ${message}${this.quiet ? ` (${this.quiet} similar not logged)` : ""}`);
    this.lastLog = t; this.quiet = 0;
  }
  // → the SearchEngineUnavailable to throw. Only an index-unavailable error is remembered (for everyone, failedTtlMs); any
  // other error fails just this request (the caller still gets 503 SEARCH_UNAVAILABLE or the one-board fallback).
  unavailable(error) {
    const reason = error instanceof SearchEngineUnavailable ? error.reason : String(error?.codeName || error?.code || error?.name || "error").slice(0, 60);
    if (indexUnavailable(error)) this.status = { ok: false, at: this.now(), reason };
    return error instanceof SearchEngineUnavailable ? error : new SearchEngineUnavailable(reason);
  }

  // The index exists and is queryable. A short cache keeps this to one cheap command per TTL; a failure is remembered briefly.
  async ensureQueryable(maxTimeMS) {
    const t = this.now();
    if (this.status && t - this.status.at < (this.status.ok ? this.statusTtlMs : this.failedTtlMs)) {
      if (!this.status.ok) throw new SearchEngineUnavailable(this.status.reason);
      return;
    }
    this.checking ??= (async () => {
      let indexes;
      try { indexes = await this.collection.aggregate([{ $listSearchIndexes: { name: this.indexName } }], { maxTimeMS }).toArray(); }
      // The status check itself failing (e.g. a server without Atlas Search) means the index can't be confirmed queryable.
      catch (error) { if (timedOut(error)) throw error; throw this.unavailable(new SearchEngineUnavailable(`status check: ${String(error?.codeName || error?.code || error?.name || "error").slice(0, 40)}`)); }
      const found = indexes.find((i) => i.name === this.indexName);
      if (!found || found.queryable !== true) throw this.unavailable(new SearchEngineUnavailable(!found ? "index missing" : `not queryable (${String(found.status || "unknown").slice(0, 20)})`));
      this.status = { ok: true, at: this.now() };
    })().finally(() => { this.checking = null; });
    await this.checking;
  }

  async candidates(args, maxTimeMS) {
    try { return await this.collection.aggregate(recordSearchPipeline({ index: this.indexName, ...args }), { maxTimeMS }).toArray(); }
    catch (error) { if (timedOut(error)) throw error; throw this.unavailable(error); }
  }

  // Verified records of one field ("text" or "name"), in index order, each with cursorAt (its index time). Never more than cap
  // records re-read and never more than maxRounds round trips. → array with found (verified count), lastHit (last candidate
  // examined), capped (the candidate or round cap was reached before the page was full).
  async page(ctx, field, { limit, cap = this.maxCandidates, deadline }) {
    const plans = new Map(ctx.boards.map((b) => [hex(b._id), boardPlan(b)]));
    const boardIds = ctx.boards.map((b) => b._id);
    const facets = { ...(ctx.status ? { status: ctx.status } : {}), ...(ctx.priority ? { priority: ctx.priority } : {}), ...(ctx.assignee ? { owner: `user:${hex(ctx.assignee)}` } : {}) };
    const check = { needle: ctx.q ? ctx.q.toLowerCase() : null, field, status: ctx.status, priority: ctx.priority, owner: facets.owner, from: ctx.from, to: ctx.to };
    const exclude = new Set((ctx.cursor?.exclude || []).map(hex));
    const projected = { ...(ctx.projection || {}), _id: 1, boardId: 1, archived: 1, updatedAt: 1, "values.serial": 1 };
    for (const p of plans.values()) for (const k of [...p.textKeys, ...p.statusKeys, ...p.priorityKeys, ...p.ownerKeys]) projected[`values.${k}`] = 1;
    const remaining = () => { const ms = deadline - this.now(); if (ms <= 0) throw budgetSpent(); return ms; };
    const out = [];
    let after = ctx.cursor ? { time: ctx.cursor.time, id: ctx.cursor.id } : null, examined = 0, rounds = 0, exhausted = false, lastHit = null;
    await this.ensureQueryable(remaining());
    while (out.length < limit && examined < cap && rounds < this.maxRounds) {
      rounds += 1;
      const want = Math.min(cap - examined, limit - out.length + 2);
      const hits = await this.candidates({ boardIds, field, q: ctx.q || "", facets, from: ctx.from, to: ctx.to, after, limit: want }, remaining());
      if (!hits.length) { exhausted = true; break; }
      examined += hits.length; lastHit = hits.at(-1);
      after = { time: lastHit.updatedAt instanceof Date ? lastHit.updatedAt : null, id: lastHit._id };
      const live = new Map((await this.repos.records.byIds(hits.map((h) => h._id), { projection: projected, maxTimeMS: remaining() })).map((d) => [hex(d._id), d]));
      for (const hit of hits) {
        const d = live.get(hex(hit._id)), plan = hit.boardId && plans.get(hex(hit.boardId));
        if (!d || !plan || d.archived || !d.boardId?.equals(hit.boardId) || exclude.has(hex(d._id)) || !liveMatch(d, plan, check)) continue;
        d.cursorAt = hit.updatedAt ?? null;
        out.push(d);
        if (out.length >= limit) break;
      }
      if (hits.length < want) { exhausted = true; break; }
    }
    out.found = out.length; out.lastHit = lastHit; out.capped = !exhausted && out.length < limit;
    return out;
  }

  // Command Center record group. ctx: { boards (the caller's, already scoped), q, status, priority, assignee, from, to, cursor,
  // projection }. Text and name run in parallel under one overall budget. → { docs, named }.
  async recordPage(ctx, { limit, nameLimit = 0, budgetMs }) {
    if (ctx.q && ctx.q.length < MIN_BIGRAM) throw new Error("record search: a query must have at least 2 characters");
    const deadline = this.now() + budgetMs;
    const [docs, named] = await Promise.all([
      this.page(ctx, "text", { limit: limit + 1, deadline }),
      ctx.q && nameLimit && !ctx.cursor ? this.page(ctx, "name", { limit: nameLimit, cap: Math.min(this.maxCandidates, nameLimit * 3), deadline }) : Promise.resolve([])
    ]);
    return { docs, named };
  }

  // After recordPage failed: null = answer with the regular query (allowed only for exactly one board), otherwise throws.
  fallback(error, boards, { q } = {}) {
    if (!(error instanceof SearchEngineUnavailable)) throw error;
    const single = boards.length === 1;
    this.warn(`atlas unavailable (${error.reason}); query length ${String(q || "").length}, ${boards.length} board(s); ${single ? "regular search on the one board" : "503 SEARCH_UNAVAILABLE"}.`);
    if (single) return null;
    throw new ApiError(503, "SEARCH_UNAVAILABLE", "Search is briefly unavailable. Try again in a moment, or search within one board.");
  }

  // Shadow mode, after a regular search answered: sampled, and only when that search was cheap (one board) and complete.
  // Returns the comparison promise (tests); never throws, never delays the response.
  shadowCompare(regularIds, ctx, { limit }) {
    if (!this.shadowing || ctx.boards.length !== 1 || ctx.cursor || !(this.random() < this.shadowSample)) return null;
    const started = this.now();
    return this.page(ctx, "text", { limit: limit + 1, deadline: started + this.shadowBudgetMs }).then((docs) => {
      const a = new Set(regularIds.map(hex)), b = new Set(docs.map((d) => hex(d._id)));
      const onlyRegex = [...a].filter((x) => !b.has(x)).length, onlyAtlas = [...b].filter((x) => !a.has(x)).length;
      this.logger.log?.(`[search-engine] shadow: regex ${a.size}, atlas ${b.size}, only regex ${onlyRegex}, only atlas ${onlyAtlas}${docs.capped ? ", capped" : ""}, ${this.now() - started} ms.`);
      return { regex: a.size, atlas: b.size, onlyRegex, onlyAtlas };
    }).catch((error) => {
      this.logger.warn?.(`[search-engine] shadow: atlas failed (${error instanceof SearchEngineUnavailable ? error.reason : timedOut(error) ? "time budget" : String(error?.codeName || error?.name || "error").slice(0, 60)}), ${this.now() - started} ms.`);
      return null;
    });
  }
}

module.exports = { AtlasRecordSearch, SearchEngineUnavailable, liveMatch, boardPlan, indexUnavailable, MODES, MAX_CANDIDATES, MAX_ROUNDS };
