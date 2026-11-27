// API representation of stored documents. One rule everywhere: responses carry `id` (a string), never `_id`;
// references are ID strings; dates are ISO 8601 strings. Internal fields (importId, devKey) are not returned.
const { unsafeValueKeys } = require("../validation/record-values");
const { columnsWithSettings } = require("../domain/board-schema");
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
    // Column display settings (G3) are stored apart (board.columnSettings) and returned on their column, as `settings`; only
    // entries that apply to the column's current type (board-schema columnsWithSettings). No top-level columnSettings.
    columns: columnsWithSettings(doc).map((c) => ({ ...c, options: [...c.options] })),
    groups: doc.groups.map(({ id, name, color, archived, position }) => ({ id, name, color, archived: Boolean(archived), position })),
    savedViews: savedViewsOut(doc, personal),
    ...(doc.nextItemNumber === undefined ? {} : { nextItemNumber: doc.nextItemNumber }),
    ...(doc.recordCount === undefined ? {} : { recordCount: doc.recordCount }),
    ...(doc.source ? { source: { provider: doc.source.provider, sourceBoardId: doc.source.sourceBoardId, readOnly: Boolean(doc.source.readOnly) } } : {}),
    createdBy: hex(doc.createdBy), createdAt: iso(doc.createdAt), updatedAt: iso(doc.updatedAt), version: doc.version
  });
}

// options (optional, so `.map(recordToApi)` is unchanged; a number there is the array index and is ignored):
//   board       the record's board: Link / Email / Phone cells that new writes would refuse (validation/record-values.js) are
//               listed in `unsafeValues` (keys only). Their values are returned unchanged and are never rewritten.
//   restricted  a Set of Connect column keys whose linked board the reader can't view (connectRestrictions): those cells are
//               left out of `values` and listed in `restricted`, with no IDs and no count.
//   mirrors     a Set of the board's Mirror column keys: their stored placeholders (usually "") are left out of `values` (never
//               presented as a worked-out value; the stored cells are untouched). The values come from GET /boards/:id/related.
function recordToApi(doc, options) {
  const { board = null, restricted = null, mirrors = null } = options !== null && typeof options === "object" ? options : {};
  const values = { ...doc.values };
  const hidden = restricted?.size ? Object.keys(values).filter((k) => restricted.has(k)) : [];
  for (const key of hidden) delete values[key];
  if (mirrors?.size) for (const key of mirrors) delete values[key];
  const unsafe = board ? unsafeValueKeys(board, values) : [];
  return withLegacy(doc, {
    id: hex(doc._id), workspaceId: hex(doc.workspaceId), boardId: hex(doc.boardId), values, groupId: doc.groupId ?? null,
    position: doc.position, archived: doc.archived, pinned: doc.pinned, createdBy: hex(doc.createdBy), updatedBy: hex(doc.updatedBy),
    createdAt: iso(doc.createdAt), updatedAt: iso(doc.updatedAt), version: doc.version,
    ...(unsafe.length ? { unsafeValues: unsafe } : {}), ...(hidden.length ? { restricted: hidden } : {})
  });
}
// The Connect columns of `board` whose linked board fails canView(boardIdHex) → Promise<boolean>, each linked board asked once.
async function connectRestrictions(board, canView) {
  const answers = new Map(), restricted = new Set();
  for (const column of (board?.columns || []).filter((c) => c.type === "connect")) {
    const id = String(column.link?.boardId || "");
    if (!answers.has(id)) answers.set(id, id ? Promise.resolve(canView(id)).catch(() => false) : Promise.resolve(false));
    if (!await answers.get(id)) restricted.add(column.key);
  }
  return restricted;
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

module.exports = { workspaceToApi, boardToApi, recordToApi, connectRestrictions, activityToApi, memberToApi, userToApi, attachmentToApi, hex, iso };
