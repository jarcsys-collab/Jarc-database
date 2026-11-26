// Board → workspace consistency (P4-0, F10). Records, attachments and comments keep a COPY of their board's workspaceId
// (indexes, the notification feed and older clients use it). The board's own workspaceId is the truth:
//
//   * Authorization never reads the copy. Access.record (auth/access.js) takes the workspace from the record's board, so a
//     stale copy can't grant or keep access to anything. A leftover copy is only data drift.
//   * A board move commits the board alone in a small transaction, then aligns the copies here in bounded batches (no
//     unbounded transaction). Every batch is idempotent (it only touches documents whose copy differs from the board's
//     workspace) and the whole run is resumable: running it again, after a crash or at any time, finishes the job.
//   * Every writer that copies the workspace (record create, batch create, spreadsheet imports) reads the board again after
//     writing and corrects what it just wrote (settleRecords). Together with the move's alignment, which starts after the
//     move commits, a record written concurrently with a move ends up with the board's final workspace: either the writer
//     sees the new workspace when it reads again, or its record already existed when the alignment ran.
//
// Trade-off: between the move's commit and the end of the alignment, copies can briefly name the old workspace. That is
// harmless for access (see above); the activity feed may show the move's surrounding entries in the old workspace for that
// moment. A crash in between leaves drift that the read-only check (scripts/board-workspace-drift.js, spec only) reports.
const BATCH = 500;
const MAX_ROUNDS = 100000; // a safety stop only: 50 million documents per collection at the default batch size

const COPIES = ["records", "attachments", "comments"];

// One collection: up to `batch` IDs whose copy isn't `workspaceId`, then one conditional update of exactly those.
// from: a known stale value. Its filter { workspaceId: from, boardId } walks the index straight to the stale documents.
async function alignBatch(collection, boardId, workspaceId, { from = null, batch = BATCH } = {}) {
  const stale = from ? { workspaceId: from } : { workspaceId: { $ne: workspaceId } };
  const ids = (await collection.find({ boardId, ...stale }, { projection: { _id: 1 }, limit: batch }).toArray()).map((d) => d._id);
  if (!ids.length) return { found: 0, changed: 0 };
  const { modifiedCount } = await collection.updateMany({ _id: { $in: ids }, boardId, workspaceId: { $ne: workspaceId } }, { $set: { workspaceId } });
  return { found: ids.length, changed: modifiedCount };
}

// Aligns every copy of one board with the board's CURRENT workspace (read again each round, so a second move that lands
// meanwhile wins). from: the workspace the board just left (faster first passes); a final pass catches any other value.
// Returns { records, attachments, comments, rounds, boardGone }.
async function alignBoardWorkspace(repos, boardId, { from = null, batch = BATCH } = {}) {
  const targets = COPIES.map((name) => [name, repos[name]?.collection]).filter(([, c]) => c);
  const changed = Object.fromEntries(COPIES.map((n) => [n, 0]));
  let rounds = 0, hint = from;
  for (;;) {
    if (++rounds > MAX_ROUNDS) throw new Error("board workspace alignment did not finish");
    const board = await repos.boards.workspaceOf(boardId);
    if (!board) return { ...changed, rounds, boardGone: true };
    const workspaceId = board.workspaceId;
    if (hint && hint.equals(workspaceId)) hint = null;
    let more = false;
    for (const [name, collection] of targets) {
      const r = await alignBatch(collection, boardId, workspaceId, { from: hint, batch });
      changed[name] += r.changed;
      if (r.found >= batch) more = true;
    }
    if (more) continue;
    if (hint) { hint = null; continue; } // the known stale value is done: one sweep for anything else
    // Done once the board is still where this round put the copies; otherwise go round again for the new workspace.
    const after = await repos.boards.workspaceOf(boardId);
    if (!after) return { ...changed, rounds, boardGone: true };
    if (after.workspaceId.equals(workspaceId)) return { ...changed, rounds, boardGone: false };
  }
}

// After records were written with a copied workspaceId: read the board again and, if it moved meanwhile, correct exactly
// those records. Returns the board's { _id, workspaceId } now, or null when the board is gone.
async function settleRecords(repos, boardId, written, ids) {
  const now = await repos.boards.workspaceOf(boardId);
  if (now && ids.length && !now.workspaceId.equals(written)) await repos.records.alignWorkspace(boardId, ids, now.workspaceId);
  return now;
}

module.exports = { alignBoardWorkspace, alignBatch, settleRecords, BATCH };
