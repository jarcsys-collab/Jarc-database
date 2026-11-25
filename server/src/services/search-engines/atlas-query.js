// Atlas Search pipelines for record search (RECORD_SEARCH_ENGINE=atlas|shadow). Pure: no I/O, so the shape is unit-tested.
// Index: atlas-index-definition.json on recordSearch (one derived document per record, services/record-search-index.js).
//
//   matching   3+ characters: a phrase (slop 0) over the trigram analyzer = a literal, case-insensitive substring of one cell
//              (cells are joined by "\n", which a query never contains). 2 characters: the single bigram term on the
//              ".bi" sub-field. 1 character: never built (validation rejects it; this refuses it again).
//   scope      boardId IN the boards the caller may see right now and archived:false, inside $search as filter clauses.
//              The board IDs come only from the per-request scope (SearchService.scope), never from the client or the index.
//   facets     status / priority / owner equality and the updated-date range, also as filter clauses (no score effect).
//   order      updatedAt desc, _id desc, in the index. A cursor narrows with a range in $search and the exact tie-break in the
//              $match that follows (on the stored source only: _id, boardId, updatedAt).
//   bounded    $limit after $search; the caller passes maxTimeMS from the request's overall budget.
const MIN_TRIGRAM = 3, MIN_BIGRAM = 2;

function textClause(field, q) {
  const query = String(q).toLowerCase();
  if (query.length >= MIN_TRIGRAM) return { phrase: { path: field, query, slop: 0 } };
  if (query.length === MIN_BIGRAM) return { text: { path: { value: field, multi: "bi" }, query } };
  throw new Error("record search: a query must have at least 2 characters");
}

// → the aggregation pipeline. boardIds: ObjectIds (non-empty). field: "text" | "name". q: the cleaned query or "" (filters only).
// facets: { status?, priority?, owner? } strings. from / to: Dates ([from, to)). after: { time: Date | null, id } (a cursor).
function recordSearchPipeline({ index, boardIds, field = "text", q = "", facets = {}, from = null, to = null, after = null, limit }) {
  if (!Array.isArray(boardIds) || !boardIds.length) throw new Error("record search: no boards in scope");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("record search: limit must be a positive whole number");
  const filter = [{ in: { path: "boardId", value: boardIds } }, { equals: { path: "archived", value: false } }];
  for (const key of ["status", "priority", "owner"]) if (facets[key]) filter.push({ equals: { path: key, value: facets[key] } });
  if (from || to) filter.push({ range: { path: "updatedAt", ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } });
  let match = null;
  if (after) {
    if (after.time) {
      // Up to and including the cursor's time (records without a time sort last, so they all still follow).
      filter.push({ compound: { should: [{ range: { path: "updatedAt", lte: after.time } }, { compound: { mustNot: [{ exists: { path: "updatedAt" } }] } }], minimumShouldMatch: 1 } });
      match = { $or: [{ updatedAt: { $lt: after.time } }, { updatedAt: after.time, _id: { $lt: after.id } }, { updatedAt: null }] };
    } else {
      filter.push({ compound: { mustNot: [{ exists: { path: "updatedAt" } }] } });
      match = { updatedAt: null, _id: { $lt: after.id } };
    }
  }
  const compound = { filter };
  if (q) compound.must = [textClause(field, q)];
  const pipeline = [{ $search: { index, compound, sort: { updatedAt: -1, _id: -1 }, returnStoredSource: true } }];
  if (match) pipeline.push({ $match: match });
  pipeline.push({ $limit: limit }, { $project: { _id: 1, boardId: 1, updatedAt: 1 } });
  return pipeline;
}

module.exports = { recordSearchPipeline, textClause, MIN_TRIGRAM, MIN_BIGRAM };
