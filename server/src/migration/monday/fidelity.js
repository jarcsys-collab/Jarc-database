// Read-back fidelity check after an import (Phase M3): every stored record and comment is compared field by field with
// the plan, and the decisions of Phase M2 are re-checked on the stored data (not on the plan): Engineer labels, mirror
// snapshots, same-board links, sub-item parents, threads, deleted-label raw values and attachment references.
// Read-only. Reports IDs and counts only.
const { ObjectId } = require("mongodb");
const { COLLECTIONS } = require("../../db/bootstrap");

const canon = (v) => {
  if (v instanceof ObjectId) return { $oid: v.toHexString() };
  if (v instanceof Date) return { $date: v.toISOString() };
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
};
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

async function verifyFidelity(db, plan, validation, workspaceId) {
  const col = (n) => db.collection(COLLECTIONS[n]);
  const problems = [], add = (m) => { if (problems.length < 100) problems.push(m); };
  const stored = new Map((await col("records").find({ boardId: { $in: [plan.board._id, plan.subBoard._id] } }).toArray()).map((d) => [d._id.toHexString(), d]));
  const storedComments = new Map((await col("comments").find({ boardId: { $in: [plan.board._id, plan.subBoard._id] } }).toArray()).map((d) => [d._id.toHexString(), d]));
  let recordsIdentical = 0, commentsIdentical = 0;
  for (const r of [...plan.records, ...plan.subRecords]) {
    const s = stored.get(r._id.toHexString());
    if (!s) { add(`record ${r.migration.sourceItemId} missing`); continue; }
    if (same({ ...r, workspaceId }, s)) recordsIdentical += 1; else add(`record ${r.migration.sourceItemId} differs from the plan`);
  }
  for (const c of plan.comments) {
    const s = storedComments.get(c._id.toHexString());
    if (!s) { add(`comment ${c.imported.sourceReplyId || c.imported.sourceUpdateId} missing`); continue; }
    if (same({ ...c, workspaceId }, s)) commentsIdentical += 1; else add(`comment ${c.imported.sourceReplyId || c.imported.sourceUpdateId} differs from the plan`);
  }
  const board = await col("boards").findOne({ _id: plan.board._id }), subBoard = await col("boards").findOne({ _id: plan.subBoard._id });
  for (const [b, p] of [[board, plan.board], [subBoard, plan.subBoard]]) {
    if (!b) { add(`board ${p.legacyId} missing`); continue; }
    for (const f of ["name", "columns", "groups", "migration", "legacyId", "savedViews", "manualOrder", "importId"]) if (!same(b[f], p[f])) add(`board ${p.legacyId}: ${f} differs`);
    if (b.source !== undefined) add(`board ${p.legacyId} is marked read-only/synchronized`);
    if (!b.workspaceId.equals(workspaceId)) add(`board ${p.legacyId} is in another workspace`);
  }
  const main = [...stored.values()].filter((d) => d.boardId.equals(plan.board._id));
  const subs = [...stored.values()].filter((d) => d.boardId.equals(plan.subBoard._id));
  const groupIds = new Set((board?.groups || []).map((g) => g.id));
  const perGroup = {};
  for (const d of main) { if (!groupIds.has(d.groupId)) add(`record ${d.migration.sourceItemId} has an unknown group`); perGroup[d.groupId] = (perGroup[d.groupId] || 0) + 1; }
  // Same-board links, resolved against what is actually stored.
  let links = 0, linksResolved = 0;
  for (const d of main) for (const rel of d.migration.relations || []) for (const t of rel.recordIds) { links += 1; if (stored.has(t.toHexString()) && stored.get(t.toHexString()).boardId.equals(plan.board._id)) linksResolved += 1; }
  // Sub-item parents.
  let parentsResolved = 0;
  for (const s of subs) { const p = s.migration.parent?.recordId && stored.get(s.migration.parent.recordId.toHexString()); if (p && p.boardId.equals(plan.board._id) && p.migration.subitemSourceIds.includes(s.migration.sourceItemId)) parentsResolved += 1; else add(`sub-item ${s.migration.sourceItemId} parent unresolved`); }
  // Threads.
  let repliesThreaded = 0;
  for (const c of storedComments.values()) if (c.parentId) { const p = storedComments.get(c.parentId.toHexString()); if (p && !p.parentId && p.recordId.equals(c.recordId)) repliesThreaded += 1; else add(`reply ${c.imported.sourceReplyId} is not under its update`); }
  // Deleted-label status values: raw value recoverable from stored metadata.
  const deleted = validation.info.filter((i) => i.code === "status-label-deleted-in-source");
  const byItem = new Map(main.map((d) => [d.migration.sourceItemId, d]).concat(subs.map((d) => [d.migration.sourceItemId, d])));
  let deletedRecoverable = 0;
  for (const i of deleted) { const raw = byItem.get(i.sourceId)?.migration.preserved?.[i.column]?.value; try { if (raw && JSON.parse(raw).index !== undefined) deletedRecoverable += 1; else add(`deleted-label value ${i.sourceId}/${i.column} not recoverable`); } catch { add(`deleted-label value ${i.sourceId}/${i.column} unreadable`); } }
  // Engineer labels and mirror snapshots, against the plan's column decisions.
  const engineerKeys = plan.columnPlan.main.filter((p) => p.handling === "status-labels-as-text").map((p) => p.targetKey);
  const mirrorKeys = plan.columnPlan.main.filter((p) => p.handling === "mirror-snapshot").map((p) => p.targetKey);
  const planned = new Map(plan.records.map((r) => [r._id.toHexString(), r]));
  let engineerExact = 0, mirrorExact = 0, engineerCells = 0, mirrorCells = 0;
  for (const d of main) {
    const p = planned.get(d._id.toHexString());
    for (const k of engineerKeys) { engineerCells += 1; if (d.values[k] === p.values[k] && typeof d.values[k] === "string") engineerExact += 1; }
    for (const k of mirrorKeys) { mirrorCells += 1; if (d.values[k] === p.values[k]) mirrorExact += 1; }
  }
  const engineerColumnTypes = engineerKeys.map((k) => board?.columns.find((c) => c.key === k)?.type);
  if (engineerColumnTypes.some((t) => t !== "text")) add("an Engineer column is not a text column");
  // Attachment references remain traceable from stored metadata.
  let attachmentRefs = 0;
  for (const d of stored.values()) attachmentRefs += (d.migration.attachments || []).length;
  for (const c of storedComments.values()) attachmentRefs += (c.imported.attachments || []).length;
  const notMigrated = [...stored.values()].every((d) => (d.migration.attachments || []).every((a) => a.status === "not-migrated")) && [...storedComments.values()].every((c) => (c.imported.attachments || []).every((a) => a.status === "not-migrated"));
  if (!notMigrated) add("an attachment reference claims to be migrated");
  // Attribution grants nothing: no users or memberships were created, and no comment is linked to an unverified user.
  const unverifiedAuthors = [...storedComments.values()].filter((c) => c.authorId && !c.imported.author.jarcUserId).length;
  if (unverifiedAuthors) add(`${unverifiedAuthors} comment(s) linked to a user without a verified mapping`);
  return {
    ok: problems.length === 0, problems,
    counts: { records: main.length, subitems: subs.length, comments: storedComments.size, recordsIdenticalToPlan: recordsIdentical, commentsIdenticalToPlan: commentsIdentical, groups: board?.groups.length ?? 0, recordsPerGroup: Object.values(perGroup).sort((a, b) => b - a), columns: board?.columns.length ?? 0, subitemColumns: subBoard?.columns.length ?? 0, sameBoardLinks: links, sameBoardLinksResolved: linksResolved, subitemParentsResolved: parentsResolved, repliesThreaded, deletedLabelValues: deleted.length, deletedLabelValuesRecoverable: deletedRecoverable, engineerCells, engineerExact, mirrorCells, mirrorExact, attachmentReferences: attachmentRefs, unverifiedAuthorLinks: unverifiedAuthors, systemGeneratedComments: [...storedComments.values()].filter((c) => c.imported.systemGenerated).length }
  };
}

module.exports = { verifyFidelity };
