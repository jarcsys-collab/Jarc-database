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
const { ApiError } = require("../middleware/errors");

const MAX_BOARDS = 300;
const MAX_TIME_MS = 3000;
const SEARCHABLE_TYPES = new Set(["text", "status", "priority", "dropdown", "email", "phone", "link", "date"]);
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
      if (error?.code === 50 || error?.codeName === "MaxTimeMSExpired") throw new ApiError(503, "SEARCH_TIMEOUT", "The search took too long. Try a longer or more specific search.");
      throw error;
    }
    const needle = query.toLowerCase();
    const items = docs.slice(0, limit).map((d) => {
      const fields = fieldsOf.get(d.boardId.toHexString()) || [];
      const text = (v) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : String(v));
      const title = text(d.values?.serial) || "Record";
      const hit = fields.find((f) => text(d.values?.[f.key]).toLowerCase().includes(needle));
      const matched = hit ? text(d.values[hit.key]) : "";
      const at = matched.toLowerCase().indexOf(needle), from = Math.max(0, at - 40);
      const snippet = !hit || hit.key === "serial" ? null : `${from > 0 ? "…" : ""}${matched.slice(from, at + needle.length + 60)}${at + needle.length + 60 < matched.length ? "…" : ""}`;
      return { recordId: d._id.toHexString(), boardId: d.boardId.toHexString(), workspaceId: d.workspaceId.toHexString(), title: title.slice(0, 200), field: hit && hit.key !== "serial" ? { key: hit.key, label: hit.label } : null, snippet };
    });
    // Item-name matches first (names starting with the query before the rest); then cell matches.
    const rank = (i) => (i.field ? 2 : i.title.toLowerCase().startsWith(needle) ? 0 : 1);
    items.sort((a, b) => rank(a) - rank(b));
    return { items, more: docs.length > limit, partial };
  }
}

module.exports = { SearchService, MAX_BOARDS, MAX_TIME_MS, SEARCHABLE_TYPES };
