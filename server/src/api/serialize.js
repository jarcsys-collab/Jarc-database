// API representation of stored documents. One rule everywhere: responses carry `id` (a string), never `_id`;
// references are ID strings; dates are ISO 8601 strings. Internal fields (importId, devKey) are not returned.
const hex = (id) => (id ? id.toHexString() : null);
const iso = (date) => (date instanceof Date ? date.toISOString() : null);
const withLegacy = (doc, result) => (doc.legacyId === undefined ? result : { ...result, legacyId: doc.legacyId });

function workspaceToApi(doc) {
  return withLegacy(doc, {
    id: hex(doc._id), name: doc.name, description: doc.description, icon: doc.icon, color: doc.color, archived: doc.archived,
    position: doc.position, createdBy: hex(doc.createdBy), createdAt: iso(doc.createdAt), updatedAt: iso(doc.updatedAt), version: doc.version
  });
}

function boardToApi(doc) {
  return withLegacy(doc, {
    id: hex(doc._id), workspaceId: hex(doc.workspaceId), name: doc.name, description: doc.description, icon: doc.icon,
    archived: doc.archived, position: doc.position, manualOrder: doc.manualOrder,
    columns: doc.columns.map((c) => ({ ...c, options: [...c.options] })),
    groups: doc.groups.map(({ id, name, color, position }) => ({ id, name, color, position })),
    savedViews: doc.savedViews.map((v) => ({ id: v.id, ...(v.legacyId === undefined ? {} : { legacyId: v.legacyId }), name: v.name, state: v.state, createdBy: hex(v.createdBy), createdAt: iso(v.createdAt) })),
    ...(doc.nextItemNumber === undefined ? {} : { nextItemNumber: doc.nextItemNumber }),
    ...(doc.recordCount === undefined ? {} : { recordCount: doc.recordCount }),
    createdBy: hex(doc.createdBy), createdAt: iso(doc.createdAt), updatedAt: iso(doc.updatedAt), version: doc.version
  });
}

function recordToApi(doc) {
  return withLegacy(doc, {
    id: hex(doc._id), workspaceId: hex(doc.workspaceId), boardId: hex(doc.boardId), values: { ...doc.values }, groupId: doc.groupId ?? null,
    position: doc.position, archived: doc.archived, pinned: doc.pinned, createdBy: hex(doc.createdBy), updatedBy: hex(doc.updatedBy),
    createdAt: iso(doc.createdAt), updatedAt: iso(doc.updatedAt), version: doc.version
  });
}

// Activity entries (read-only). ObjectIds inside changes become strings; imported entries keep the old author text.
const plain = (value) => (value && typeof value.toHexString === "function" ? value.toHexString() : value ?? null);
function activityToApi(doc) {
  return {
    id: hex(doc._id), action: doc.action, entityType: doc.entityType, entityId: plain(doc.entityId),
    workspaceId: hex(doc.workspaceId), boardId: hex(doc.boardId), recordId: hex(doc.recordId), actorUserId: hex(doc.actorUserId),
    actorName: doc.legacyActor ?? null, summary: doc.summary || "",
    changes: (doc.changes || []).map((c) => ({ field: c.field, from: plain(c.from), to: plain(c.to) })),
    createdAt: iso(doc.createdAt)
  };
}

module.exports = { workspaceToApi, boardToApi, recordToApi, activityToApi, hex, iso };
