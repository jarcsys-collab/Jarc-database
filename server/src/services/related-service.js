// Connect and Mirror columns across boards (domain/board-schema.js):
//   connect  a cell holds the IDs of records on one other board (column.link.boardId). Nothing is copied.
//   mirror   shows a column of the records linked through one of the board's connect columns, worked out on every read.
// Every cross-board step is authorised for the person asking, each time: someone who can't see the linked board gets no
// names and no mirrored values from it (the column is listed as restricted), and can't link to it. Lookups are batched: one
// query per linked board, by _id (the default index), with only the fields needed.
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");

const LIMITS = Object.freeze({ records: 200, linked: 5000, timeMS: 5000 });
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const asNumber = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && NUMERIC.test(v.trim()) ? Number(v) : null);
const present = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "" && v !== false);

class RelatedService {
  constructor({ repos, access }) { this.repos = repos; this.access = access; }

  // The linked board if this person may see it; null if not (or it no longer exists). Other errors are real errors.
  async readable(actor, boardId) {
    try { return (await this.access.board(actor, new ObjectId(String(boardId)), "VIEWER")).board; }
    catch (error) { if (error?.status === 403 || error?.status === 404) return null; throw error; }
  }

  // New or changed Connect columns may only link to a board the person can see.
  async checkColumns(actor, columns = [], before = [], { allowNew = true } = {}) {
    // Switched off (JARC_FEATURE_CONNECT_BOARDS=false): no new Connect/Mirror column, and existing ones keep their settings.
    if (!allowNew) {
      const prev = new Map(before.map((c) => [c.key, c]));
      const changed = (c) => { const p = prev.get(c.key); return !p ? true : JSON.stringify([p.type, p.link ?? null, p.mirror ?? null, Boolean(p.multiple)]) !== JSON.stringify([c.type, c.link ?? null, c.mirror ?? null, Boolean(c.multiple)]); };
      if (columns.some((c) => (c?.type === "connect" || c?.type === "mirror" || ["connect", "mirror"].includes(prev.get(c?.key)?.type)) && changed(c))) throw new ApiError(400, "VALIDATION_ERROR", "Connect and Mirror columns are switched off: they can't be added or changed.");
    }
    const was = new Map(before.filter((c) => c.type === "connect").map((c) => [c.key, c.link?.boardId]));
    for (const c of columns) {
      if (c?.type !== "connect" || !c.link?.boardId || was.get(c.key) === c.link.boardId) continue;
      if (!/^[0-9a-f]{24}$/.test(String(c.link.boardId)) || !(await this.readable(actor, c.link.boardId))) throw new ApiError(403, "FORBIDDEN", `"${String(c.label || c.key).slice(0, 60)}" can only link to a board you can open.`);
    }
  }

  // Before records are written: every linked record must exist on the linked board, and the person must be able to see that
  // board. valuesList: the `values` objects being written.
  // allowWrite false (switched off): links stay as they are; any Connect value in the request is refused.
  async checkLinks(actor, board, valuesList, { allowWrite = true } = {}) {
    if (!allowWrite && board.columns.some((c) => c.type === "connect" && valuesList.some((v) => v && Object.prototype.hasOwnProperty.call(v, c.key)))) throw new ApiError(400, "VALIDATION_ERROR", "Connect columns are switched off: links can't be changed.");
    for (const c of board.columns.filter((x) => x.type === "connect")) {
      const ids = [...new Set(valuesList.flatMap((v) => (v && Array.isArray(v[c.key]) ? v[c.key] : [])))];
      if (!ids.length) continue;
      if (ids.some((id) => !/^[0-9a-f]{24}$/.test(id))) continue; // checkValue refuses these with a clear message
      const target = await this.readable(actor, c.link.boardId);
      if (!target) throw new ApiError(403, "FORBIDDEN", `You can't link records on "${String(c.label || c.key).slice(0, 60)}": you can't open the board it links to.`);
      const found = new Set((await this.repos.records.findByIds(target._id, ids.map((id) => new ObjectId(id)), { projection: { _id: 1 }, maxTimeMS: LIMITS.timeMS })).map((d) => d._id.toHexString()));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length) throw new ApiError(400, "VALIDATION_ERROR", `"${String(c.label || c.key).slice(0, 60)}" links ${missing.length === 1 ? "a record that isn't" : `${missing.length} records that aren't`} on the linked board.`);
    }
  }

  // For some records of a board (those on screen): the names of their linked records and their mirror values.
  //   { linked: { [connectKey]: { [linkedId]: { name, archived } } }, values: { [recordId]: { [mirrorKey]: value } },
  //     restricted: [column keys whose linked board this person can't see], unavailable: [mirror keys that can't be shown] }
  async resolve(actor, board, recordIds) {
    const out = { linked: {}, values: {}, restricted: [], unavailable: [] };
    const connects = board.columns.filter((c) => c.type === "connect"), mirrors = board.columns.filter((c) => c.type === "mirror");
    if (!connects.length || !recordIds.length) return out;
    const ids = [...new Set(recordIds)].slice(0, LIMITS.records).map((id) => new ObjectId(id));
    const projection = Object.fromEntries(connects.map((c) => [`values.${c.key}`, 1]));
    const records = await this.repos.records.findByIds(board._id, ids, { projection, maxTimeMS: LIMITS.timeMS });
    for (const r of records) out.values[r._id.toHexString()] = {};
    for (const c of connects) {
      const via = mirrors.filter((m) => m.mirror.via === c.key);
      const target = await this.readable(actor, c.link.boardId);
      if (!target) { out.restricted.push(c.key, ...via.map((m) => m.key)); continue; }
      // A mirror shows a plain column: mirroring a Connect or Mirror column (a chain across boards) is not followed.
      const sources = new Map();
      for (const m of via) {
        const src = target.columns.find((x) => x.key === m.mirror.column);
        if (!src || src.type === "mirror" || src.type === "connect" || src.type === "files") out.unavailable.push(m.key); else sources.set(m.key, src);
      }
      const linkedIds = [...new Set(records.flatMap((r) => (Array.isArray(r.values?.[c.key]) ? r.values[c.key] : [])).filter((id) => /^[0-9a-f]{24}$/.test(id)))].slice(0, LIMITS.linked);
      const fields = { archived: 1, groupId: 1, "values.serial": 1, ...Object.fromEntries([...sources.values()].filter((s) => s.type !== "group").map((s) => [`values.${s.key}`, 1])) };
      const docs = await this.repos.records.findByIds(target._id, linkedIds.map((id) => new ObjectId(id)), { projection: fields, maxTimeMS: LIMITS.timeMS });
      const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
      out.linked[c.key] = Object.fromEntries(docs.map((d) => [d._id.toHexString(), { name: String(d.values?.serial ?? ""), archived: Boolean(d.archived) }]));
      const groupName = (d) => target.groups.find((g) => g.id === d.groupId)?.name ?? "";
      for (const r of records) {
        const linked = (Array.isArray(r.values?.[c.key]) ? r.values[c.key] : []).map((id) => byId.get(id)).filter((d) => d && !d.archived);
        for (const [key, src] of sources) out.values[r._id.toHexString()][key] = RelatedService.summarise(linked.map((d) => (src.type === "group" ? groupName(d) : d.values?.[src.key])), src, board.columns.find((m) => m.key === key).mirror.show);
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
