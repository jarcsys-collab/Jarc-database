// Connect and Mirror columns across boards (domain/board-schema.js):
//   connect  a cell holds the IDs of records on one other board (column.link.boardId). Nothing is copied.
//   mirror   shows a column of the records linked through one of the board's connect columns, worked out on every read and
//            NEVER stored (not in records, links, activity, search or caches; Column System plan 17 §3).
// Every cross-board step is authorised for the person asking, each time, through the request's authorization context
// (auth/authz-context.js, S0-B plan 17 §1): one ctx.boards($in) for every linked board, then ctx.can() in memory. Someone who
// can't see the linked board gets no IDs, names or mirrored values from it (the column is listed as restricted), can't link to
// it, and can't clear its links either.
// Lookups are batched: one query per distinct VISIBLE linked board (not per column), by _id, with only the fields needed.
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { CAP } = require("../auth/capabilities");
const { targetOf, connectsOf, columnVisible } = require("./relation-guard");

// Explicit bounds (plan 17 §2, D-REL-6). A bound that is hit is reported in `partial: { [key]: reason }`, never silently.
const LIMITS = Object.freeze({ records: 200, perCell: 100, targetBoards: 10, linked: 10000, mirrors: 30, budgetMS: 2000, timeMS: 5000, parallel: 4, writeIds: 10000 });
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const HEX = /^[0-9a-f]{24}$/;
const asNumber = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && NUMERIC.test(v.trim()) ? Number(v) : null);
const present = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "" && v !== false);
const has = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);
const label = (c) => String(c.label || c.key).slice(0, 60);
// Mirror shows that need a type of source column; another source type is flagged (source-type), never silently null.
const NUMERIC_SHOWS = new Set(["sum", "avg", "min", "max"]), DATE_SHOWS = new Set(["earliest", "latest"]);
const NUMERIC_SOURCES = new Set(["number", "text"]), DATE_SOURCES = new Set(["date", "text"]);
const NOT_MIRRORABLE = new Set(["mirror", "connect", "files"]);
const unavailableError = () => new ApiError(503, "RELATIONS_UNAVAILABLE", "Connect and Mirror columns are temporarily read-only: their link index isn't ready. Everything else works as usual.");

class RelatedService {
  // relations: { status() → { ok, reason } } from the record link index startup check (relations/record-links.js), or null when
  // that check isn't in use (Connect switched off, or a caller that doesn't run it). ok false → Connect / Mirror fail CLOSED.
  constructor({ repos, access, relations = null }) { this.repos = repos; this.access = access; this.relations = relations; }

  get frozen() { const s = this.relations?.status?.(); return Boolean(s) && s.ok === false; }

  // Linked boards by ID, through the context (one $in), with the fields asked for; → { loaded, viewable(hex) → board | null }.
  async targets(ctx, ids, projection) {
    await ctx.visibility();
    const wanted = [...new Set(ids.filter((id) => id && HEX.test(id)))];
    const loaded = wanted.length ? await ctx.boards(wanted, projection) : new Map();
    const viewable = (id) => { const b = id ? loaded.get(id) : null; return b && ctx.can(CAP.BOARD_VIEW, b) ? b : null; };
    return { loaded, viewable };
  }

  // New or changed Connect columns may only link to a board the person can see.
  async checkColumns(ctx, columns = [], before = [], { allowNew = true } = {}) {
    // Switched off (JARC_FEATURE_CONNECT_BOARDS=false), or the link index isn't ready: no new Connect/Mirror column, and existing
    // ones keep their settings.
    const prev = new Map(before.map((c) => [c.key, c]));
    const changed = (c) => { const p = prev.get(c.key); return !p ? true : JSON.stringify([p.type, p.link ?? null, p.mirror ?? null, Boolean(p.multiple)]) !== JSON.stringify([c.type, c.link ?? null, c.mirror ?? null, Boolean(c.multiple)]); };
    const touches = columns.some((c) => (c?.type === "connect" || c?.type === "mirror" || ["connect", "mirror"].includes(prev.get(c?.key)?.type)) && changed(c));
    if (!allowNew && touches) throw new ApiError(400, "VALIDATION_ERROR", "Connect and Mirror columns are switched off: they can't be added or changed.");
    if (this.frozen && touches) throw unavailableError();
    const was = new Map(before.filter((c) => c.type === "connect").map((c) => [c.key, c.link?.boardId]));
    const fresh = columns.filter((c) => c?.type === "connect" && c.link?.boardId && was.get(c.key) !== c.link.boardId);
    if (!fresh.length) return;
    const { viewable } = await this.targets(ctx, fresh.map((c) => String(c.link.boardId)), null);
    for (const c of fresh) if (!HEX.test(String(c.link.boardId)) || !viewable(String(c.link.boardId))) throw new ApiError(403, "FORBIDDEN", `"${label(c)}" can only link to a board you can open.`);
  }

  // Before records are written. writes: [{ values, current }] — the values object being written and, on update paths, the
  // record's STORED values (null on create). Rules (plan 17 §1.2 row 10, §2):
  //   - A Connect key that is PRESENT in a write (update paths: whatever the value, so [] / "" / null can't clear links on a
  //     board the writer can't open; create paths: only a non-empty value) needs board.view on the linked board. Authorization
  //     comes first, before any value is validated (no oracle for an unauthorized caller).
  //   - Tolerant writes: IDs already stored that no longer exist on the linked board (deleted, moved) are DROPPED from the value
  //     and reported in the result; only NEWLY ADDED IDs must exist, on that board, and not be archived.
  //   - Two-way (X3, C3.2, not built): host record.editValues + target board.view for added AND removed IDs + reciprocal
  //     record.editValues on the target, or the whole write is refused.
  // allowWrite false (switched off): links stay as they are; any Connect value in the request is refused.
  // → { dropped: { [connectKey]: count } }
  async checkLinks(ctx, board, writes, { allowWrite = true, mode = "update" } = {}) {
    const connects = connectsOf(board);
    const result = { dropped: {} };
    const touched = connects.filter((c) => writes.some((w) => has(w.values, c.key)));
    if (!touched.length) return result;
    if (!allowWrite) throw new ApiError(400, "VALIDATION_ERROR", "Connect columns are switched off: links can't be changed.");
    if (this.frozen) throw unavailableError();
    const needs = touched.filter((c) => mode === "update" || writes.some((w) => has(w.values, c.key) && present(w.values[c.key])));
    if (!needs.length) return result;
    const { viewable } = await this.targets(ctx, needs.map(targetOf), null);
    for (const c of needs) if (!viewable(targetOf(c))) throw new ApiError(403, "FORBIDDEN", `You can't change links in "${label(c)}": you can't open the board it links to.`);
    // Authorized. Malformed values are left to checkValue (400 with its own message).
    const wellFormed = (v) => Array.isArray(v) && v.every((id) => typeof id === "string" && HEX.test(id));
    const byTarget = new Map(); // target hex → Set(ids to look up)
    for (const c of needs) for (const w of writes) {
      const v = w.values?.[c.key];
      if (!wellFormed(v)) continue;
      const set = byTarget.get(targetOf(c)) || new Set();
      v.forEach((id) => set.add(id));
      byTarget.set(targetOf(c), set);
    }
    if ([...byTarget.values()].reduce((n, s) => n + s.size, 0) > LIMITS.writeIds) throw new ApiError(400, "VALIDATION_ERROR", `At most ${LIMITS.writeIds} linked records can be written at once.`);
    const found = new Map(); // target hex → Map(id → { archived })
    await Promise.all([...byTarget].map(async ([t, ids]) => {
      const docs = await this.repos.records.findByIds(new ObjectId(t), [...ids].map((id) => new ObjectId(id)), { projection: { _id: 1, archived: 1 }, maxTimeMS: LIMITS.timeMS });
      found.set(t, new Map(docs.map((d) => [d._id.toHexString(), { archived: Boolean(d.archived) }])));
    }));
    for (const c of needs) {
      const there = found.get(targetOf(c)) || new Map();
      for (const w of writes) {
        const v = w.values?.[c.key];
        if (!wellFormed(v)) continue;
        const stored = new Set(Array.isArray(w.current?.[c.key]) ? w.current[c.key] : []);
        const added = v.filter((id) => !stored.has(id));
        const missing = added.filter((id) => !there.has(id));
        if (missing.length) throw new ApiError(400, "VALIDATION_ERROR", `"${label(c)}" links ${missing.length === 1 ? "a record that isn't" : `${missing.length} records that aren't`} on the linked board.`);
        if (added.some((id) => there.get(id).archived)) throw new ApiError(400, "VALIDATION_ERROR", `"${label(c)}" can't link an archived record.`);
        const kept = v.filter((id) => there.has(id));
        if (kept.length !== v.length) { result.dropped[c.key] = (result.dropped[c.key] || 0) + (v.length - kept.length); w.values[c.key] = kept; }
      }
    }
    return result;
  }

  // For some records of a board (those on screen): the names of their linked records and their mirror values, for this reader.
  //   { linked: { [connectKey]: { [linkedId]: { name, archived } } }, values: { [recordId]: { [mirrorKey]: value } },
  //     restricted: [Connect keys whose linked board this reader can't see, and the Mirrors that follow them],
  //     unavailable: [mirror keys that can't be shown], unavailableReasons: { [key]: reason }, partial: { [key]: reason } }
  // Reasons: connect-missing (orphan Mirror: its Connect column is gone), source-missing, source-type, relations-unavailable.
  // Partial: rows, cell-limit, linked-limit, target-boards, mirror-limit, time-budget.
  // Reads: host records (Connect keys only), memberships (memo; 0 for SYSTEM_ADMIN), ONE boards $in (projected), then ONE
  // records findByIds per distinct visible linked board (≤ LIMITS.parallel at a time): 3 + B.
  async resolve(ctx, board, recordIds) {
    const started = Date.now();
    const out = { linked: {}, values: {}, restricted: [], unavailable: [], unavailableReasons: {}, partial: {} };
    const unavailable = (key, reason) => { if (!out.unavailable.includes(key)) out.unavailable.push(key); out.unavailableReasons[key] = reason; };
    const connects = connectsOf(board), connectKeys = new Set(connects.map((c) => c.key));
    const mirrors = board.columns.filter((c) => c.type === "mirror");
    for (const m of mirrors) if (!connectKeys.has(m.mirror?.via)) unavailable(m.key, "connect-missing"); // flagged, never deleted
    if (this.frozen) { for (const c of [...connects, ...mirrors]) unavailable(c.key, "relations-unavailable"); out.status = "unavailable"; return out; }
    if (!connects.length || !recordIds.length) return out;
    const unique = [...new Set(recordIds)];
    if (unique.length > LIMITS.records) out.partial._rows = "rows";
    const ids = unique.slice(0, LIMITS.records).map((id) => new ObjectId(id));
    const records = await this.repos.records.findByIds(board._id, ids, { projection: Object.fromEntries(connects.map((c) => [`values.${c.key}`, 1])), maxTimeMS: LIMITS.timeMS });
    for (const r of records) out.values[r._id.toHexString()] = {};
    // One boards $in for every linked board, with what the mirrors need (columns, groups) merged into the authorization fields.
    const { viewable } = await this.targets(ctx, connects.map(targetOf), { columns: 1, groups: 1 });
    const live = mirrors.filter((m) => connectKeys.has(m.mirror?.via));
    const computed = new Set(live.slice(0, LIMITS.mirrors).map((m) => m.key));
    for (const m of live.slice(LIMITS.mirrors)) out.partial[m.key] = "mirror-limit";
    // Per Connect column: restricted, or its target and its mirrors' sources.
    const plan = new Map(); // target hex → { board, columns: [{ c, sources: Map(mirrorKey → source column) }] }
    for (const c of connects) {
      const via = live.filter((m) => m.mirror.via === c.key);
      const t = targetOf(c), target = viewable(t);
      // Host record.view equals board.view until P4-5; the linked records' record.view equals the target's board.view.
      if (!target || !ctx.can(CAP.RECORD_VIEW, target) || !columnVisible(target, c)) { out.restricted.push(c.key, ...via.map((m) => m.key)); continue; }
      const sources = new Map();
      for (const m of via) {
        if (!computed.has(m.key)) continue;
        const src = (target.columns || []).find((x) => x.key === m.mirror.column);
        const show = m.mirror.show;
        if (!src) unavailable(m.key, "source-missing");
        else if (NOT_MIRRORABLE.has(src.type) || (NUMERIC_SHOWS.has(show) && !NUMERIC_SOURCES.has(src.type)) || (DATE_SHOWS.has(show) && !DATE_SOURCES.has(src.type))) unavailable(m.key, "source-type");
        else if (!columnVisible(target, src)) out.restricted.push(m.key);
        else sources.set(m.key, src);
      }
      const entry = plan.get(t) || { board: target, columns: [] };
      entry.columns.push({ c, sources });
      plan.set(t, entry);
    }
    // Linked IDs per visible target board, deduplicated across its Connect columns, bounded per cell and in all.
    // A bound hit on a Connect column is also reported on every Mirror computed through it (its count / sum / list is incomplete).
    const mirrorsOf = new Map();
    for (const [, entry] of plan) for (const { c, sources } of entry.columns) mirrorsOf.set(c.key, [...sources.keys()]);
    const flag = (c, reason) => { out.partial[c.key] = reason; for (const k of mirrorsOf.get(c.key) || []) out.partial[k] = reason; };
    let budget = LIMITS.linked;
    const targets = [...plan].slice(0, LIMITS.targetBoards);
    for (const [, entry] of [...plan].slice(LIMITS.targetBoards)) for (const { c } of entry.columns) flag(c, "target-boards");
    const cellIds = (r, c) => {
      const v = Array.isArray(r.values?.[c.key]) ? r.values[c.key].filter((id) => typeof id === "string" && HEX.test(id)) : [];
      if (v.length > LIMITS.perCell) { flag(c, "cell-limit"); return v.slice(0, LIMITS.perCell); }
      return v;
    };
    const work = targets.map(([t, entry]) => {
      const wanted = new Set();
      for (const { c } of entry.columns) for (const r of records) for (const id of cellIds(r, c)) {
        if (wanted.has(id)) continue;
        if (budget <= 0) { flag(c, "linked-limit"); continue; }
        wanted.add(id); budget -= 1;
      }
      const fields = { archived: 1, groupId: 1, "values.serial": 1 };
      for (const { sources } of entry.columns) for (const s of sources.values()) if (s.type !== "group") fields[`values.${s.key}`] = 1;
      return { t, entry, wanted, fields };
    });
    const docsByTarget = new Map();
    for (let i = 0; i < work.length; i += LIMITS.parallel) {
      const slice = work.slice(i, i + LIMITS.parallel);
      if (Date.now() - started > LIMITS.budgetMS) { for (const w of slice) for (const { c } of w.entry.columns) flag(c, "time-budget"); continue; }
      await Promise.all(slice.map(async (w) => {
        const docs = w.wanted.size ? await this.repos.records.findByIds(w.entry.board._id, [...w.wanted].map((id) => new ObjectId(id)), { projection: w.fields, maxTimeMS: LIMITS.timeMS }) : [];
        docsByTarget.set(w.t, new Map(docs.map((d) => [d._id.toHexString(), d])));
      }));
    }
    for (const w of work) {
      const byId = docsByTarget.get(w.t);
      if (!byId) continue; // skipped by the time budget (already reported as partial)
      const target = w.entry.board;
      const groupName = (d) => (target.groups || []).find((g) => g.id === d.groupId)?.name ?? "";
      for (const { c, sources } of w.entry.columns) {
        const linked = {};
        for (const r of records) for (const id of cellIds(r, c)) { const d = byId.get(id); if (d) linked[id] = { name: String(d.values?.serial ?? ""), archived: Boolean(d.archived) }; }
        out.linked[c.key] = linked;
        for (const r of records) {
          const docs = cellIds(r, c).map((id) => byId.get(id)).filter((d) => d && !d.archived);
          for (const [key, src] of sources) out.values[r._id.toHexString()][key] = RelatedService.summarise(docs.map((d) => (src.type === "group" ? groupName(d) : d.values?.[src.key])), src, board.columns.find((m) => m.key === key).mirror.show);
        }
      }
    }
    return out;
  }

  // The mirrored value: the linked records' values as a list, or one number / date worked out from them.
  static summarise(values, source, show) {
    const filled = values.filter(present);
    if (show === "count") return filled.length;
    if (["sum", "avg", "min", "max"].includes(show)) {
      const nums = filled.flatMap((v) => (Array.isArray(v) ? v : [v])).map(asNumber).filter((n) => n !== null);
      if (!nums.length) return null;
      if (show === "sum") return nums.reduce((a, b) => a + b, 0);
      if (show === "avg") return nums.reduce((a, b) => a + b, 0) / nums.length;
      return show === "min" ? Math.min(...nums) : Math.max(...nums);
    }
    if (show === "earliest" || show === "latest") {
      const days = filled.map(String).filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d)).sort();
      return days.length ? (show === "earliest" ? days[0] : days.at(-1)) : null;
    }
    // list: each linked record's value, in link order; lists (People, several labels) flattened; true/false as text.
    return filled.flatMap((v) => (Array.isArray(v) ? v : [v])).map((v) => (typeof v === "boolean" ? (v ? "Yes" : "No") : String(v)));
  }
}

module.exports = { RelatedService, LIMITS };
