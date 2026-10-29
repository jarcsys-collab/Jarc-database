// Mapping stage: source model → destination documents (a plan). Pure and deterministic: no I/O, no clock, no random
// IDs. The same extraction and decisions always give the same plan (and the same plan digest).
//
//   board        → one native, editable JARC board (never `source.readOnly`); provenance under `migration`
//   groups       → board groups with stable IDs, in monday's group order
//   items        → records (legacyId monday-item-<id>), extraction order, original created/updated times
//   subitems     → records of a companion "Sub-items" board, each with a resolvable parent reference
//   updates      → comments; replies → one-level replies; authors as attribution (`imported`), never as fake users
//   attachments  → references only (status "not-migrated"); nothing claims a file is stored in JARC
// Every document carries the run ID and a mapping entry (provider "monday-migration") for duplicate-safe imports.
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { PROVIDER, MAPPING_PROVIDER, namespaceOf, objectIdFor, groupIdFor, legacyIdFor } = require("./ids");
const { planColumns, mapCell, DEFAULT_DECISIONS } = require("./columns");
const { IdentityResolver } = require("./identity");
const { htmlToText, normalizeText, mentionIds } = require("./html");
const { classifyAsset } = require("./compat");
const { normalizeColumns } = require("../../domain/board-schema");
const { ApiError } = require("../../middleware/errors");
// Boards store columns exactly as JARC's own column rules produce them (all fields with their defaults), so the app
// reads an imported board like any other. An invalid column list is reported by validation; the raw list is kept then.
const storedColumns = (columns) => { try { return normalizeColumns(columns); } catch (error) { if (error instanceof ApiError) return columns; throw error; } };

const parse = (s) => { if (typeof s !== "string" || !s) return null; try { return JSON.parse(s); } catch { return null; } };
const date = (v) => (v ? new Date(v) : null);
const EMPTY_BODY = "[This monday.com update had no text]";

function buildPlan(source, { decisions = DEFAULT_DECISIONS, confirmedUsers = null, workspaceId = null } = {}) {
  const account = String(source.manifest.source?.account || "").replace(/\.monday\.com$/, "");
  const sourceBoardId = String(source.board.id);
  const ns = namespaceOf(account, sourceBoardId);
  const runId = `monday-${sourceBoardId}-${source.manifestSha256.slice(0, 12)}`;
  const issues = [];
  const issue = (level, code, entity, sourceId, extra = {}) => issues.push({ level, code, entity, sourceId: sourceId == null ? null : String(sourceId), ...extra });
  const identity = new IdentityResolver(source, confirmedUsers);
  for (const p of identity.problems) issue("error", "user-mapping-file-invalid", "user-mapping", null, { message: p });
  const wsId = workspaceId || null;
  const oid = (kind, id) => objectIdFor(ns, kind, id);
  const userOid = (a) => (a.jarcUserId ? new ObjectId(a.jarcUserId) : null);

  // ---- main board ----
  const selfRelations = new Set(source.columns.filter((c) => c.type === "board_relation" && (parse(c.settings_str)?.boardIds || []).map(String).includes(sourceBoardId)).map((c) => c.id));
  const UPDATE_FILES = { key: "m_update_files", label: "Files from Updates", type: "files", description: "Files that were attached to this record's monday.com Updates. Each Update links to its file." };
  const main = planColumns(source.columns, { decisions, withGroup: true, relationColumnIds: selfRelations, extraAfter: [UPDATE_FILES] });
  for (const e of main.errors) issue("error", "column-plan", "column", null, { message: e });
  const groups = [...source.groups].sort((a, b) => Number(a.position) - Number(b.position) || String(a.id).localeCompare(String(b.id)));
  const groupMap = new Map(groups.map((g) => [String(g.id), groupIdFor(ns, g.id)]));
  const boardId = oid("board", sourceBoardId);
  for (const k of ["owners", "subscribers"]) for (const u of source.board[k] || []) identity.note(u.id, k === "owners" ? "boardOwner" : "boardSubscriber");
  const board = {
    _id: boardId, legacyId: legacyIdFor("board", sourceBoardId), workspaceId: wsId, name: source.board.name.trim().slice(0, 200),
    description: typeof source.board.description === "string" ? source.board.description.slice(0, 5000) : "", icon: "M", archived: false,
    position: null /* set at execution: after the workspace's existing boards */, manualOrder: true, columns: storedColumns(main.columns),
    groups: groups.map((g, i) => ({ id: groupMap.get(String(g.id)), name: String(g.title).trim().slice(0, 200) || `Group ${i + 1}`, color: /^#[0-9a-f]{3,8}$/i.test(g.color || "") ? g.color : "", archived: Boolean(g.archived), position: (i + 1) * 1000 })),
    savedViews: [], createdBy: null, createdAt: null /* import time */, updatedAt: null, version: 1, importId: runId,
    migration: {
      provider: PROVIDER, account, sourceBoardId, sourceBoardName: source.board.name, sourceBoardKind: source.board.board_kind ?? null, runId, manifestSha256: source.manifestSha256,
      extractedAt: source.manifest.extraction?.finished_at ?? null, apiVersion: source.manifest.extraction?.api_version?.value ?? null,
      groups: groups.map((g) => ({ sourceGroupId: String(g.id), groupId: groupMap.get(String(g.id)), title: g.title, color: g.color ?? null, sourcePosition: g.position ?? null })),
      columns: main.plan.map((p) => ({ sourceColumnId: p.sourceColumnId, sourceType: p.sourceType, targetKey: p.targetKey, handling: p.handling })),
      views: (source.board.views || []).map((v) => ({ sourceViewId: String(v.id), name: v.name, type: v.type ?? null, settings: v.settings_str ?? null })),
      owners: (source.board.owners || []).map((u) => String(u.id)), subscribers: (source.board.subscribers || []).map((u) => String(u.id)),
      snapshotProvenance: "Mirror and connected-board columns hold values as displayed in monday.com at extraction time; they are editable text, not live links."
    }
  };
  if (groups.some((g) => g.color && !/^#[0-9a-f]{3,8}$/i.test(g.color))) issue("warning", "group-color-not-hex", "group", null);

  // ---- companion sub-items board ----
  const subBoardId = oid("subitems-board", sourceBoardId);
  const subBoardSourceId = String(source.subitems[0]?.board?.id || (parse(source.columns.find((c) => c.type === "subtasks")?.settings_str)?.boardIds || [])[0] || "");
  const sub = planColumns(source.subitemColumns, { decisions: { ...decisions, statusAsText: {} }, extra: [
    { key: "parent_item", label: "Parent item", type: "text", description: "Name of the parent record on the main board (at migration time). The exact link is in the record's migration metadata." },
    { key: "parent_monday_id", label: "Parent monday.com item ID", type: "text" }
  ] });
  for (const e of sub.errors) issue("error", "column-plan", "subitem-column", null, { message: e });
  const subGroupId = groupIdFor(ns, "subitems");
  const subBoard = {
    _id: subBoardId, legacyId: legacyIdFor("subitems-board", sourceBoardId), workspaceId: wsId, name: `${board.name} — Sub-items`.slice(0, 200),
    description: `Sub-items of "${board.name}" migrated from monday.com. Each record links to its parent record.`, icon: "S", archived: false, position: null, manualOrder: true,
    columns: storedColumns(sub.columns), groups: [{ id: subGroupId, name: "Sub-items", color: "", archived: false, position: 1000 }], savedViews: [], createdBy: null, createdAt: null, updatedAt: null, version: 1, importId: runId,
    migration: { provider: PROVIDER, account, sourceBoardId: subBoardSourceId || null, parentSourceBoardId: sourceBoardId, parentBoardId: boardId, runId, manifestSha256: source.manifestSha256, columns: sub.plan.map((p) => ({ sourceColumnId: p.sourceColumnId, sourceType: p.sourceType, targetKey: p.targetKey, handling: p.handling })) }
  };

  // ---- attachments index (references only) ----
  const fileRefsByAsset = new Map();
  for (const f of source.attachments.files_column_references || []) if (f.asset_id) fileRefsByAsset.set(`${f.asset_id}|${f.item_id}`, f);
  const itemAssets = new Map();
  for (const r of source.attachments.references || []) {
    if (r.source !== "item") continue;
    const list = itemAssets.get(String(r.item_id)) || [];
    list.push({ assetId: String(r.asset_id), name: r.name ?? null, extension: r.file_extension ?? null, sizeBytes: r.file_size_bytes ?? null, mimeTypeInferred: r.mime_type_inferred ?? null, columnId: fileRefsByAsset.get(`${r.asset_id}|${r.item_id}`)?.column_id ?? null, createdAt: r.created_at ?? null, uploadedBySourceUserId: r.uploaded_by_id ?? null, status: "not-migrated" });
    itemAssets.set(String(r.item_id), list);
  }

  // ---- records ----
  const itemIds = new Set(), records = [], subRecords = [], mappings = [];
  const mapping = (kind, sourceId, targetId, onBoard) => mappings.push({ provider: MAPPING_PROVIDER, kind, sourceId: String(sourceId), targetId, boardId: onBoard, runId });
  mapping("board", sourceBoardId, boardId, boardId);
  mapping("subitems-board", sourceBoardId, subBoardId, subBoardId);
  const recordFor = (it, { onBoard, plan, columns, kind, order, groupId, extraValues = {}, extraMeta = {} }) => {
    const values = { ...extraValues }, preserved = {}, relations = [];
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const cvs = new Map(it.column_values.map((cv) => [cv.id, cv]));
    const linked = (colId) => (cvs.get(colId)?.linked_item_ids || []).length > 0;
    for (const p of plan) {
      if (p.handling === "primary") { values.serial = it.name; continue; }
      if (!p.targetKey) continue;
      const cv = cvs.get(p.sourceColumnId);
      if (!cv) issue("error", "column-value-missing", kind, it.id, { column: p.sourceColumnId });
      const cell = mapCell(p, byKey.get(p.targetKey), cv, { identity, itemId: it.id, hasRelationLink: (e) => (e.via || []).some(linked) });
      values[p.targetKey] = cell.value;
      if (cell.preserved !== undefined) preserved[p.sourceColumnId] = { type: p.sourceType, ...cell.preserved };
      for (const code of cell.issues) {
        if (code.startsWith("info:")) issue("info", code.slice(5), kind, it.id, { column: p.sourceColumnId });
        else issue(["date-unparseable", "value-too-long", "value-not-convertible"].includes(code) ? "error" : "warning", code, kind, it.id, { column: p.sourceColumnId });
      }
      if (p.handling === "same-board-relation" && cell.preserved?.linkedItemIds) relations.push({ sourceColumnId: p.sourceColumnId, targetKey: p.targetKey, sourceItemIds: cell.preserved.linkedItemIds, recordIds: cell.preserved.linkedItemIds.map((id) => oid("item", id)) });
    }
    // Files columns hold nothing in the record (attachments are their own documents); JARC requires "" there.
    for (const c of columns) if (c.type === "files") values[c.key] = "";
    const creator = identity.attribution(it.creator_id, kind === "item" ? "itemCreator" : "subitemCreator");
    const _id = oid(kind, it.id);
    return {
      _id, legacyId: legacyIdFor(kind, it.id), workspaceId: wsId, boardId: onBoard, values, groupId, position: (order + 1) * 1000, archived: false, pinned: false,
      createdBy: userOid(creator), updatedBy: null, createdAt: date(it.created_at), updatedAt: date(it.updated_at), version: 1, importId: runId,
      migration: { provider: PROVIDER, runId, sourceBoardId: String(it.board?.id ?? (kind === "item" ? sourceBoardId : subBoardSourceId)), sourceItemId: String(it.id), sourceState: it.state ?? null, sourceOrder: order, creator, preserved, relations, attachments: itemAssets.get(String(it.id)) || [], ...extraMeta }
    };
  };
  source.items.forEach((it, order) => {
    if (itemIds.has(String(it.id))) return issue("error", "duplicate-source-item", "item", it.id);
    itemIds.add(String(it.id));
    const groupId = groupMap.get(String(it.group?.id));
    if (!groupId) issue("error", "group-missing", "item", it.id, { group: String(it.group?.id) });
    if (it.state && it.state !== "active") issue("warning", "item-not-active", "item", it.id, { state: it.state });
    const rec = recordFor(it, { onBoard: boardId, plan: main.plan, columns: main.columns, kind: "item", order, groupId: groupId || null, extraMeta: { sourceGroupId: String(it.group?.id), subitemSourceIds: (it.subitems || []).map((s) => String(s.id)) } });
    records.push(rec); mapping("item", it.id, rec._id, boardId);
  });
  const itemById = new Map(source.items.map((it) => [String(it.id), it]));
  const subIds = new Set();
  source.subitems.forEach((s, order) => {
    if (subIds.has(String(s.id)) || itemIds.has(String(s.id))) return issue("error", "duplicate-source-subitem", "subitem", s.id);
    subIds.add(String(s.id));
    const parentId = String(s.parent_item?.id), parent = itemById.get(parentId);
    if (!parent) issue("error", "subitem-parent-missing", "subitem", s.id, { parent: parentId });
    else if (!(parent.subitems || []).some((x) => String(x.id) === String(s.id))) issue("error", "subitem-parent-mismatch", "subitem", s.id, { parent: parentId });
    const rec = recordFor(s, { onBoard: subBoardId, plan: sub.plan, columns: sub.columns, kind: "subitem", order, groupId: subGroupId,
      extraValues: { parent_item: parent ? parent.name : "", parent_monday_id: parentId },
      extraMeta: { parent: { sourceItemId: parentId, recordId: parent ? oid("item", parentId) : null, boardId: parent ? boardId : null } } });
    subRecords.push(rec); mapping("subitem", s.id, rec._id, subBoardId);
  });
  for (const it of source.items) for (const s of it.subitems || []) if (!subIds.has(String(s.id))) issue("error", "subitem-not-extracted", "item", it.id, { subitem: String(s.id) });

  // ---- comments ----
  const comments = [], updateIds = new Set(), replyIds = new Set();
  const target = (itemId) => (itemIds.has(itemId) ? { recordId: oid("item", itemId), boardId } : subIds.has(itemId) ? { recordId: oid("subitem", itemId), boardId: subBoardId } : null);
  const bodyOf = (u, kind, id) => {
    const fromText = typeof u.text_body === "string" ? normalizeText(u.text_body) : "";
    let body = fromText, bodySource = "text_body";
    if (!body) { body = htmlToText(u.body); bodySource = "html-converted"; }
    if (!body) { body = EMPTY_BODY; bodySource = "empty"; issue("warning", "update-empty-body", kind, id); }
    if (body.length > 5000) issue("error", "update-too-long", kind, id, { length: body.length });
    return { body, bodySource, htmlSha256: typeof u.body === "string" && u.body ? crypto.createHash("sha256").update(u.body).digest("hex") : null };
  };
  const assetsOf = (u) => (u.assets || []).map((a) => ({ assetId: String(a.id), name: a.name ?? null, extension: a.file_extension ?? null, sizeBytes: a.file_size ?? null, status: "not-migrated" }));
  for (const u of source.updates) {
    const id = String(u.id), itemId = String(u._source_item_id);
    if (updateIds.has(id)) { issue("error", "duplicate-source-update", "update", id); continue; }
    updateIds.add(id);
    if (u.item_id && String(u.item_id) !== itemId) issue("error", "update-item-mismatch", "update", id);
    const t = target(itemId);
    if (!t) { issue("error", "update-orphan", "update", id, { item: itemId }); continue; }
    const author = identity.attribution(u.creator_id, "updateAuthor", u.creator?.name);
    if (author.kind === "unknown" && !author.name) issue("warning", "author-unknown", "update", id);
    const { body, bodySource, htmlSha256 } = bodyOf(u, "update", id);
    const _id = oid("update", id);
    const edited = u.edited_at && u.edited_at !== u.created_at ? date(u.edited_at) : null;
    comments.push({
      _id, workspaceId: wsId, boardId: t.boardId, recordId: t.recordId, parentId: null, authorId: userOid(author), authorName: author.name,
      body, mentions: [], createdAt: date(u.created_at), updatedAt: date(u.updated_at || u.created_at), editedAt: edited, deletedAt: null, deletedBy: null, version: 1,
      imported: { provider: PROVIDER, runId, sourceUpdateId: id, sourceItemId: itemId, author, systemGenerated: author.kind === "automation", bodySource, htmlSha256, mentionedSourceUserIds: mentionIds(u.body), attachments: assetsOf(u) }
    });
    mapping("update", id, _id, t.boardId);
    for (const r of u.replies || []) {
      const rid = String(r.id);
      if (replyIds.has(rid) || updateIds.has(rid)) { issue("error", "duplicate-source-reply", "reply", rid); continue; }
      replyIds.add(rid);
      const ra = identity.attribution(r.creator_id, "replyAuthor", r.creator?.name);
      const rb = bodyOf(r, "reply", rid);
      const rOid = oid("reply", rid);
      comments.push({
        _id: rOid, workspaceId: wsId, boardId: t.boardId, recordId: t.recordId, parentId: _id, authorId: userOid(ra), authorName: ra.name,
        body: rb.body, mentions: [], createdAt: date(r.created_at), updatedAt: date(r.updated_at || r.created_at), editedAt: null, deletedAt: null, deletedBy: null, version: 1,
        imported: { provider: PROVIDER, runId, sourceReplyId: rid, sourceUpdateId: id, sourceItemId: itemId, author: ra, systemGenerated: ra.kind === "automation", bodySource: rb.bodySource, htmlSha256: rb.htmlSha256, mentionedSourceUserIds: mentionIds(r.body), attachments: [] }
      });
      mapping("reply", rid, rOid, t.boardId);
    }
  }
  for (const a of source.attachments.references || []) if (a.uploaded_by_id) identity.note(a.uploaded_by_id, "uploader");

  // ---- attachment plan (Phase M4.1): one JARC attachment per stored file, never per reference ----
  // A monday asset attached to a record AND one of its Updates is the same file: it is stored once on the record
  // (its source Files column, or "Files from Updates"), and every Update that referenced it links to that attachment.
  const filesKeyOf = new Map(main.plan.filter((p) => p.filesKey).map((p) => [p.sourceColumnId, p.filesKey]));
  const attachments = [], byAsset = new Map();
  const commentRefs = new Map(); // assetId|recordHex → [comment]
  for (const c of comments) for (const a of c.imported.attachments) { const k = `${a.assetId}|${c.recordId.toHexString()}`; (commentRefs.get(k) || commentRefs.set(k, []).get(k)).push(c); }
  for (const r of [...records, ...subRecords]) {
    for (const ref of r.migration.attachments) {
      const k = `${ref.assetId}|${r._id.toHexString()}`;
      if (byAsset.has(ref.assetId)) {
        const first = byAsset.get(ref.assetId);
        if (!first.recordId.equals(r._id)) issue("warning", "asset-on-several-records", "attachment", ref.assetId);
        continue;
      }
      const onSub = r.boardId.equals(subBoardId);
      const columnKey = ref.columnId && filesKeyOf.has(ref.columnId) ? filesKeyOf.get(ref.columnId) : onSub ? null : UPDATE_FILES.key;
      const cls = classifyAsset(ref, { migrationMaxBytes: decisions.migrationMaxFileBytes || 20 * 1024 * 1024 });
      const linked = (commentRefs.get(k) || []).map((c) => c._id);
      const entry = {
        _id: oid("asset", ref.assetId), sourceAssetId: String(ref.assetId), recordId: r._id, boardId: r.boardId, columnKey,
        originalName: ref.name, plannedName: cls.plannedName, sourceExtension: ref.extension ?? null, sizeBytes: Number(ref.sizeBytes) || 0,
        action: cls.action, plannedType: cls.type, oversized: Boolean(cls.oversized), ...(cls.reason ? { reason: cls.reason } : {}),
        linkedCommentIds: linked, sourceUploadedBy: ref.uploadedBySourceUserId ?? null, sourceCreatedAt: ref.createdAt ?? null
      };
      if (!columnKey) issue("error", "asset-without-files-column", "attachment", ref.assetId);
      attachments.push(entry); byAsset.set(ref.assetId, entry);
      ref.attachmentId = entry._id; ref.columnKey = columnKey;
    }
  }
  // Each Update's file reference names the JARC attachment that holds it.
  for (const c of comments) for (const a of c.imported.attachments) { const e = byAsset.get(a.assetId); if (e) a.attachmentId = e._id; else issue("error", "update-asset-without-record-copy", "update", c.imported.sourceUpdateId, { asset: a.assetId }); }

  return {
    runId, namespace: ns, workspaceId: wsId, decisions, board, subBoard, records, subRecords, comments, mappings, attachments,
    columnPlan: { main: main.plan, subitems: sub.plan }, identity, issues
  };
}

module.exports = { buildPlan, EMPTY_BODY };
