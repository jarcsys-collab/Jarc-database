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

// Saved views: the board document's shared views, plus — only when given — the reader's OWN personal views (personal: their
// document from repositories/mongo/personal-view-repository.js, read for the signed-in person by the route). Personal views
// are never in a board document, so a board served without that document (an API key, a colleague, an older release) can't
// contain any. personal.order keeps the reader's own order; views it doesn't know yet follow, in board order.
const viewOut = (v, extra = {}) => ({ id: v.id, ...(v.legacyId === undefined ? {} : { legacyId: v.legacyId }), name: v.name, state: v.state, ...extra, createdBy: hex(v.createdBy), createdAt: iso(v.createdAt) });
function savedViewsOut(doc, personal) {
  const shared = (doc.savedViews || []).filter((v) => v.personal !== true).map((v) => viewOut(v));
  if (!personal?.views?.length) return shared;
  const mine = personal.views.map((v) => viewOut({ ...v, createdBy: personal.userId }, { personal: true }));
  const rank = new Map((personal.order || []).map((id, i) => [id, i])), all = [...shared, ...mine];
  return all.map((v, i) => [v, rank.has(v.id) ? rank.get(v.id) : 100000 + i]).sort((a, b) => a[1] - b[1]).map(([v]) => v);
}
function boardToApi(doc, { personal = null } = {}) {
  return withLegacy(doc, {
    id: hex(doc._id), ...(doc.publicId === undefined ? {} : { publicId: doc.publicId }), workspaceId: hex(doc.workspaceId), name: doc.name, description: doc.description, icon: doc.icon,
    archived: doc.archived, position: doc.position, manualOrder: doc.manualOrder,
    columns: doc.columns.map((c) => ({ ...c, options: [...c.options] })),
    groups: doc.groups.map(({ id, name, color, archived, position }) => ({ id, name, color, archived: Boolean(archived), position })),
    savedViews: savedViewsOut(doc, personal),
    ...(doc.nextItemNumber === undefined ? {} : { nextItemNumber: doc.nextItemNumber }),
    ...(doc.recordCount === undefined ? {} : { recordCount: doc.recordCount }),
    ...(doc.source ? { source: { provider: doc.source.provider, sourceBoardId: doc.source.sourceBoardId, readOnly: Boolean(doc.source.readOnly) } } : {}),
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
    // The name snapshot taken when the change was made (older entries: the imported legacy name, or none).
    actorName: doc.actorName ?? doc.legacyActor ?? null, summary: doc.summary || "",
    changes: (doc.changes || []).map((c) => ({ field: c.field, from: plain(c.from), to: plain(c.to) })),
    createdAt: iso(doc.createdAt)
  };
}

// Workspace members, with the user's display details (never their Entra identifiers).
function memberToApi(doc) {
  return {
    id: hex(doc._id), workspaceId: hex(doc.workspaceId), userId: hex(doc.userId), role: doc.role, status: doc.status,
    displayName: doc.user?.displayName ?? null, email: doc.user?.email ?? null, createdAt: iso(doc.createdAt), updatedAt: iso(doc.updatedAt)
  };
}

// The signed-in user (GET /me): display details and account status; no tenant or object IDs.
function userToApi(doc) { return { id: hex(doc._id), displayName: doc.displayName || "", email: doc.email ?? null, status: doc.status }; }

// A Files column attachment (metadata only; the contents are at /attachments/:id/content). No storage details.
function attachmentToApi(doc) {
  return {
    id: hex(doc._id), recordId: hex(doc.recordId), boardId: hex(doc.boardId), columnKey: doc.columnKey, name: doc.name, type: doc.type, size: doc.size,
    uploadedBy: hex(doc.uploadedBy), uploadedByName: doc.uploadedByName ?? null, createdAt: iso(doc.createdAt)
  };
}

module.exports = { workspaceToApi, boardToApi, recordToApi, activityToApi, memberToApi, userToApi, attachmentToApi, hex, iso };
