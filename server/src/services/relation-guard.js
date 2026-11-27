// S0-B relationship security (Column System plan 17 §1): what a reader may learn through Connect / Mirror columns.
//
// Built on the shared authorization foundation (auth/authz-context.js): ONE request-scoped context per request (authzFor), ONE
// ctx.boards($in) for every linked board, then ctx.can() in memory. A linked board that is missing (deleted), not visible, or
// whose ID isn't a lower-case 24-hex string is restricted (fails closed).
//
//   relatedAccess(ctx, boards)        → Map(hostBoardHex → Set(restricted Connect keys ∪ the keys of the Mirrors that follow them))
//   recordsOut(ctx, board, docs)      → the records as the API returns them, restricted cells left out and listed in `restricted`
//   activityOut(ctx, entries)         → activity entries with Connect changes redacted ({ field, from: null, to: null, restricted })
//
// Under shared access (development_shared / beta open editing) every board is visible, so nothing changes for anyone today.
const { CAP } = require("../auth/capabilities");
const { AUTHZ_FIELDS } = require("../auth/authz-context");
const { recordToApi, activityToApi } = require("../api/serialize");

const HEX = /^[0-9a-f]{24}$/;
const hexOf = (id) => (typeof id === "string" ? id : id && typeof id.toHexString === "function" ? id.toHexString() : null);
// Upper case is NOT lower-cased here: a Connect column whose stored target isn't canonical fails closed (plan 35 F10).
const targetOf = (column) => { const id = hexOf(column?.link?.boardId); return id && HEX.test(id) ? id : null; };
const connectsOf = (board) => (board?.columns || []).filter((c) => c?.type === "connect");
const mirrorsVia = (board, key) => (board?.columns || []).filter((c) => c?.type === "mirror" && c.mirror?.via === key);

// One context per request, created on first use (never shared across requests, never cached elsewhere: plan 35 F7).
const contexts = new WeakMap();
function authzFor(req, access) {
  let ctx = contexts.get(req);
  if (!ctx) { ctx = access.context(req.actor); contexts.set(req, ctx); }
  return ctx;
}

// The hook for column-level visibility (P4-5). Today every column a reader can reach is visible.
const columnVisible = () => true;

async function relatedAccess(ctx, boards) {
  const out = new Map();
  const targets = new Set();
  for (const b of boards) for (const c of connectsOf(b)) { const t = targetOf(c); if (t) targets.add(t); }
  let loaded = new Map();
  if (targets.size) { await ctx.visibility(); loaded = await ctx.boards([...targets], AUTHZ_FIELDS); }
  for (const b of boards) {
    const restricted = new Set();
    for (const c of connectsOf(b)) {
      const t = targetOf(c), target = t ? loaded.get(t) : null;
      if (!target || !ctx.can(CAP.BOARD_VIEW, target) || !columnVisible(target, c)) { restricted.add(c.key); for (const m of mirrorsVia(b, c.key)) restricted.add(m.key); }
    }
    out.set(hexOf(b._id), restricted);
  }
  return out;
}

const NONE = new Set();
async function restrictedFor(ctx, board) {
  if (!connectsOf(board).length) return NONE; // 0 extra reads for a board without Connect columns
  return (await relatedAccess(ctx, [board])).get(hexOf(board._id)) || NONE;
}

// A record as the API returns it: with its board's workspace (the stored copy can lag a board move; P4-0) and with the cells of
// restricted Connect columns left out. Mirror cells are left out for everyone (plan 17 §3): what is stored there is a placeholder,
// never the worked-out value, which the screens take from /related (restricted, partial and unavailable marks included).
async function recordsOut(ctx, board, docs) {
  const restricted = await restrictedFor(ctx, board);
  const mirrors = new Set((board?.columns || []).filter((c) => c?.type === "mirror").map((c) => c.key));
  const ws = board.workspaceId;
  return docs.map((doc) => recordToApi(!ws || doc.workspaceId?.equals?.(ws) ? doc : { ...doc, workspaceId: ws }, { restricted, mirrors }));
}

// Activity entries (plan 17 §1.2 row 7). Stored Connect changes keep their IDs (audit); on read, a change of a Connect column whose
// linked board the reader can't view, of a RETIRED Connect column (its target is unknown), or of an unknown key on a board that
// is gone or not loadable while the value looks like a list of record IDs, is returned as { field, from: null, to: null,
// restricted: true }. Reads: at most one board $in for the entries' boards, one for their linked boards (plus memberships).
const ID_LIST = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && HEX.test(x));
async function activityOut(ctx, entries) {
  const valueKey = (field) => (typeof field === "string" && field.startsWith("values.") ? field.slice(7) : null);
  const touched = entries.filter((e) => (e.changes || []).some((c) => valueKey(c.field) !== null));
  if (!touched.length) return entries.map(activityToApi);
  await ctx.visibility();
  const boardIds = [...new Set(touched.map((e) => hexOf(e.boardId)).filter((id) => id && HEX.test(id)))];
  const boards = boardIds.length ? await ctx.boards(boardIds, { columns: 1, retiredColumns: 1 }) : new Map();
  const present = [...boards.values()].filter(Boolean);
  const access = await relatedAccess(ctx, present);
  return entries.map((entry) => {
    const out = activityToApi(entry);
    if (!(entry.changes || []).some((c) => valueKey(c.field) !== null)) return out;
    const b = boards.get(hexOf(entry.boardId)) || null;
    const restricted = b ? access.get(hexOf(b._id)) : null;
    out.changes = out.changes.map((change, i) => {
      const key = valueKey(change.field);
      if (key === null) return change;
      const raw = entry.changes[i];
      const column = b?.columns?.find((c) => c.key === key);
      let hide;
      if (!b) hide = ID_LIST(raw.from) || ID_LIST(raw.to); // board gone or unreadable: fail closed on anything that looks like links
      else if (column) hide = column.type === "connect" && restricted.has(key);
      else hide = (b.retiredColumns || []).some((r) => r.key === key && r.type === "connect") || ID_LIST(raw.from) || ID_LIST(raw.to);
      return hide ? { field: change.field, from: null, to: null, restricted: true } : change;
    });
    return out;
  });
}

module.exports = { authzFor, relatedAccess, restrictedFor, recordsOut, activityOut, columnVisible, targetOf, connectsOf, mirrorsVia };
