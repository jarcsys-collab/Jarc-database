// Validation stage: checks a plan against JARC's own rules and against the source, without touching any database.
// Errors block execution; warnings are documented decisions or known losses (each listed, never hidden).
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { normalizeColumns, normalizeGroups, checkValue, LIMITS } = require("../../domain/board-schema");
const { cleanBody } = require("../../services/comment-service");
const { ApiError } = require("../../middleware/errors");
const { MAX_FILES_PER_CELL } = require("../../files/file-types");

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const JARC_TYPES = new Set(["pdf", "jpg", "jpeg", "png", "webp"]);
const tryRule = (fn) => { try { fn(); return null; } catch (error) { if (error instanceof ApiError) return error.message; throw error; } };

function validatePlan(plan, source) {
  const issues = [...plan.issues];
  const issue = (level, code, entity, sourceId, extra = {}) => issues.push({ level, code, entity, sourceId: sourceId == null ? null : String(sourceId), ...extra });

  // Boards: JARC's column/group rules, and never a read-only synced board.
  for (const b of [plan.board, plan.subBoard]) {
    const colErr = tryRule(() => normalizeColumns(b.columns));
    if (colErr) issue("error", "board-columns-invalid", "board", b.legacyId, { message: colErr });
    const grpErr = tryRule(() => normalizeGroups(b.groups.map(({ id, name, color, archived }) => ({ id, name, color, archived }))));
    if (grpErr) issue("error", "board-groups-invalid", "board", b.legacyId, { message: grpErr });
    if (b.source !== undefined) issue("error", "board-would-be-read-only", "board", b.legacyId);
    if (b.savedViews.length > LIMITS.savedViews) issue("error", "too-many-views", "board", b.legacyId);
  }

  // Records: every value checked with the same rules as the API; groups, IDs and parents must resolve.
  const ids = new Set(), legacy = new Set();
  const checkRecords = (records, board, kind) => {
    const cols = new Map(board.columns.map((c) => [c.key, c])), groups = new Set(board.groups.map((g) => g.id));
    for (const r of records) {
      const id = r._id.toHexString();
      if (ids.has(id)) issue("error", "duplicate-migration-id", kind, r.migration.sourceItemId); ids.add(id);
      if (legacy.has(`${board.legacyId}|${r.legacyId}`)) issue("error", "duplicate-legacy-id", kind, r.migration.sourceItemId); legacy.add(`${board.legacyId}|${r.legacyId}`);
      if (!r.groupId || !groups.has(r.groupId)) issue("error", "record-group-invalid", kind, r.migration.sourceItemId);
      if (!(r.createdAt instanceof Date) || Number.isNaN(r.createdAt.getTime())) issue("error", "record-timestamp-invalid", kind, r.migration.sourceItemId);
      if (Object.keys(r.values).length > LIMITS.recordFields) issue("error", "record-too-many-fields", kind, r.migration.sourceItemId);
      if (typeof r.values.serial !== "string" || !r.values.serial.trim()) issue("error", "record-name-empty", kind, r.migration.sourceItemId);
      for (const [key, value] of Object.entries(r.values)) {
        const col = cols.get(key);
        if (!col) { issue("error", "value-without-column", kind, r.migration.sourceItemId, { column: key }); continue; }
        if (col.type === "group") continue;
        const err = tryRule(() => checkValue(col, value));
        if (err) issue("error", "value-invalid", kind, r.migration.sourceItemId, { column: key, message: err.replace(/"[^"]*"/, `"${key}"`) });
      }
      for (const col of board.columns) if (col.type !== "group" && !(col.key in r.values)) issue("error", "value-missing", kind, r.migration.sourceItemId, { column: col.key });
    }
  };
  checkRecords(plan.records, plan.board, "item");
  checkRecords(plan.subRecords, plan.subBoard, "subitem");
  const recordIds = new Set(plan.records.map((r) => r._id.toHexString()));
  for (const s of plan.subRecords) if (!s.migration.parent.recordId || !recordIds.has(s.migration.parent.recordId.toHexString())) issue("error", "subitem-parent-unresolved", "subitem", s.migration.sourceItemId);
  let relationLinks = 0, relationUnresolved = 0;
  for (const r of plan.records) for (const rel of r.migration.relations) for (const t of rel.recordIds) { relationLinks += 1; if (!recordIds.has(t.toHexString())) relationUnresolved += 1; }
  if (relationUnresolved) issue("warning", "same-board-links-unresolved", "relation", null, { count: relationUnresolved, message: "linked items not present on the board (archived or deleted in monday.com); kept as monday item IDs" });

  // Comments: plain text within limits, on a planned record, replies one level under a top-level comment.
  const allRecords = new Set([...recordIds, ...plan.subRecords.map((r) => r._id.toHexString())]);
  const top = new Map();
  for (const c of plan.comments) if (!c.parentId) top.set(c._id.toHexString(), c);
  const commentIds = new Set();
  for (const c of plan.comments) {
    const sid = c.imported.sourceReplyId || c.imported.sourceUpdateId, kind = c.parentId ? "reply" : "update";
    if (commentIds.has(c._id.toHexString())) issue("error", "duplicate-migration-id", kind, sid); commentIds.add(c._id.toHexString());
    if (!allRecords.has(c.recordId.toHexString())) issue("error", "comment-record-unresolved", kind, sid);
    const err = tryRule(() => { if (cleanBody(c.body) !== c.body) throw new ApiError(400, "VALIDATION_ERROR", "body is not in canonical plain-text form"); });
    if (err) issue("error", "comment-body-invalid", kind, sid, { message: err });
    if (/<\s*\/?\s*(script|iframe|img|a|div|p|span|style)\b/i.test(c.body)) issue("error", "comment-contains-markup", kind, sid);
    if (!(c.createdAt instanceof Date) || Number.isNaN(c.createdAt.getTime())) issue("error", "comment-timestamp-invalid", kind, sid);
    if (c.authorId !== null && !(c.authorId instanceof ObjectId)) issue("error", "comment-author-invalid", kind, sid);
    if (c.parentId) { const p = top.get(c.parentId.toHexString()); if (!p || !p.recordId.equals(c.recordId)) issue("error", "reply-parent-unresolved", "reply", sid); }
  }

  // Mappings: one per (kind, source ID), and one per target.
  const mk = new Set(), mt = new Set();
  for (const m of plan.mappings) {
    const k = `${m.kind}|${m.sourceId}`, t = m.targetId.toHexString();
    if (mk.has(k)) issue("error", "duplicate-mapping", m.kind, m.sourceId); mk.add(k);
    if (mt.has(t)) issue("error", "duplicate-mapping-target", m.kind, m.sourceId); mt.add(t);
  }

  // Counts against the extraction manifest (the source of truth for what exists).
  const expected = source.manifest.counts || {};
  const replies = plan.comments.filter((c) => c.parentId).length, updates = plan.comments.length - replies;
  const counts = { items: plan.records.length, subitems: plan.subRecords.length, updates, replies };
  for (const [k, v] of Object.entries(counts)) if (expected[k] !== undefined && expected[k] !== v) issue("error", "count-mismatch", k, null, { expected: expected[k], actual: v });
  if (expected.board_items_count !== undefined && expected.board_items_count !== plan.records.length) issue("error", "count-mismatch", "board_items_count", null, { expected: expected.board_items_count, actual: plan.records.length });

  // Every source column has an explicit decision.
  const planned = new Set(plan.columnPlan.main.map((p) => p.sourceColumnId));
  for (const c of source.columns) if (!planned.has(c.id)) issue("error", "column-unmapped", "column", c.id);
  const plannedSub = new Set(plan.columnPlan.subitems.map((p) => p.sourceColumnId));
  for (const c of source.subitemColumns) if (!plannedSub.has(c.id)) issue("error", "column-unmapped", "subitem-column", c.id);

  // Attachments: every reference traceable to a planned record or comment.
  const attach = attachmentFeasibility(plan, source);
  if (attach.untraceable) issue("error", "attachment-untraceable", "attachment", null, { count: attach.untraceable });

  // Attachment plan (Phase M4.1): every file has a genuine Files column on its record's board, at most 20 per cell,
  // one plan entry per stored file, and Update links stay on the same record.
  const attachmentPlan = { planned: 0, byAction: {}, oversized: 0, linkedToUpdates: 0, perCellMax: 0 };
  if (plan.attachments) {
    const boardsById = new Map([[plan.board._id.toHexString(), plan.board], [plan.subBoard._id.toHexString(), plan.subBoard]]);
    const recordById = new Map([...plan.records, ...plan.subRecords].map((r) => [r._id.toHexString(), r]));
    const commentById = new Map(plan.comments.map((c) => [c._id.toHexString(), c]));
    const ids = new Set(), assets = new Set(), perCell = new Map();
    for (const a of plan.attachments) {
      if (ids.has(a._id.toHexString()) || assets.has(a.sourceAssetId)) issue("error", "duplicate-attachment-plan", "attachment", a.sourceAssetId);
      ids.add(a._id.toHexString()); assets.add(a.sourceAssetId);
      const rec = recordById.get(a.recordId.toHexString()), board = boardsById.get(a.boardId.toHexString());
      const col = board?.columns.find((c) => c.key === a.columnKey);
      if (!rec || !board || !rec.boardId.equals(a.boardId)) issue("error", "attachment-record-unresolved", "attachment", a.sourceAssetId);
      else if (!col || col.type !== "files") issue("error", "attachment-not-on-files-column", "attachment", a.sourceAssetId, { column: a.columnKey });
      const cell = `${a.recordId.toHexString()}|${a.columnKey}`; perCell.set(cell, (perCell.get(cell) || 0) + 1);
      for (const cid of a.linkedCommentIds) if (!commentById.get(cid.toHexString())?.recordId.equals(a.recordId)) issue("error", "attachment-update-link-unresolved", "attachment", a.sourceAssetId);
      attachmentPlan.byAction[a.action] = (attachmentPlan.byAction[a.action] || 0) + 1;
      if (a.oversized) attachmentPlan.oversized += 1;
      if (a.linkedCommentIds.length) attachmentPlan.linkedToUpdates += 1;
    }
    attachmentPlan.planned = plan.attachments.length;
    attachmentPlan.perCellMax = Math.max(0, ...perCell.values());
    if (attachmentPlan.perCellMax > MAX_FILES_PER_CELL) issue("error", "too-many-files-in-a-cell", "attachment", null, { max: attachmentPlan.perCellMax });
    if (attachmentPlan.planned !== attach.uniqueAssets) issue("error", "attachment-plan-incomplete", "attachment", null, { planned: attachmentPlan.planned, unique: attach.uniqueAssets });
    for (const c of plan.comments) for (const r of c.imported.attachments) if (!r.attachmentId || !ids.has(r.attachmentId.toHexString())) issue("error", "update-attachment-unlinked", "update", c.imported.sourceUpdateId);
  }

  const errors = issues.filter((i) => i.level === "error"), warnings = issues.filter((i) => i.level === "warning"), info = issues.filter((i) => i.level === "info");
  return { ok: errors.length === 0, counts, relationLinks, relationUnresolved, attachments: attach, attachmentPlan, errors, warnings, info, summary: summarize(issues) };
}

function attachmentFeasibility(plan, source) {
  const refs = [], seen = new Map();
  const add = (a, owner) => { refs.push({ ...a, ...owner }); seen.set(a.assetId, (seen.get(a.assetId) || 0) + 1); };
  for (const r of [...plan.records, ...plan.subRecords]) for (const a of r.migration.attachments) add(a, { ownerKind: r.boardId.equals(plan.board._id) ? "item" : "subitem", ownerSourceId: r.migration.sourceItemId, recordId: r._id.toHexString() });
  for (const c of plan.comments) for (const a of c.imported.attachments) add(a, { ownerKind: "update", ownerSourceId: c.imported.sourceUpdateId, recordId: c.recordId.toHexString(), commentId: c._id.toHexString() });
  const total = (source.attachments.references || []).length;
  const unique = new Map(); for (const a of refs) if (!unique.has(a.assetId)) unique.set(a.assetId, a);
  const ext = (a) => String(a.extension || "").replace(/^\./, "").toLowerCase() || "(none)";
  const u = [...unique.values()], bytes = u.reduce((s, a) => s + Number(a.sizeBytes || 0), 0);
  const MB = 1048576;
  const externalLinks = (source.attachments.external_or_unmatched_file_references || []);
  return {
    sourceReferences: total, plannedReferences: refs.length, untraceable: Math.max(0, total - refs.length), uniqueAssets: u.length,
    duplicateReferences: [...seen.values()].filter((n) => n > 1).reduce((s, n) => s + n - 1, 0),
    totalBytes: bytes, totalMB: +(bytes / MB).toFixed(1),
    overLimit: { count: u.filter((a) => Number(a.sizeBytes) > MAX_FILE_BYTES).length, mb: +(u.filter((a) => Number(a.sizeBytes) > MAX_FILE_BYTES).reduce((s, a) => s + Number(a.sizeBytes), 0) / MB).toFixed(1), largestMB: +(Math.max(0, ...u.map((a) => Number(a.sizeBytes || 0))) / MB).toFixed(1) },
    byExtension: Object.fromEntries(Object.entries(u.reduce((m, a) => ((m[ext(a)] = (m[ext(a)] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1])),
    unsupported: { heic: u.filter((a) => ext(a) === "heic").length, jfif: u.filter((a) => ext(a) === "jfif").length, csv: u.filter((a) => ext(a) === "csv").length, other: u.filter((a) => !JARC_TYPES.has(ext(a)) && !["heic", "jfif", "csv"].includes(ext(a))).length },
    externalLinks: { count: externalLinks.length, types: externalLinks.reduce((m, f) => ((m[f.file_type || "(none)"] = (m[f.file_type || "(none)"] || 0) + 1), m), {}) },
    storedInJarc: 0,
    references: refs
  };
}

function summarize(issues) {
  const by = {};
  for (const i of issues) { const k = `${i.level}:${i.code}`; by[k] = (by[k] || 0) + 1; }
  return Object.fromEntries(Object.entries(by).sort());
}

// Canonical digest of a plan (ObjectIds as hex, Dates as ISO). Two dry runs of the same input must give the same digest.
function planDigest(plan) {
  const canon = (v) => {
    if (v instanceof ObjectId) return { $oid: v.toHexString() };
    if (v instanceof Date) return { $date: v.toISOString() };
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().filter((k) => k !== "identity" && k !== "issues").map((k) => [k, canon(v[k])]));
    return v;
  };
  return crypto.createHash("sha256").update(JSON.stringify(canon(plan))).digest("hex");
}

module.exports = { validatePlan, planDigest, attachmentFeasibility };
