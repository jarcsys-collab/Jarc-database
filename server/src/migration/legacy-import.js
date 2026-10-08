// Legacy data → MongoDB documents. Pure: validates the whole input first, then builds every document in memory and
// a report. Nothing is written here (services/import-service.js commits the plan in one transaction).
//
// Accepted input, unchanged from what the browser produces today:
//   - the stored state document (schemaVersion 1), as sent to PUT /api/v1/state
//   - a browser backup file (version 1–11, or older files without a version)
//
// Mapping:
//   workspaces[]            → workspaces (legacyId = old ID)
//   workspace.boards[]      → boards (legacyId = old ID; columns kept by key; group names → groups with stable IDs)
//   board.records[]         → records (legacyId = old ID; flexible values kept as-is under values.<column key>;
//                             the group column's name → groupId)
//   board/record activity   → activities (action legacy.*), when they have a valid date
//   importer                → WORKSPACE_ADMIN membership of each imported workspace
// Not imported, and listed in the report: local contacts (members are not real accounts), per-user state
// (selection, settings, profile, notifications, recent items) and per-user board fields (favourite, last view).
// Nothing missing is invented: unknown creators stay null, and defaults are only the ones the frontend itself applies.
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { assertSafeJson, isObject, isPrimitive, isSafeKey } = require("../validation/common");
const { validateState, SCHEMA_VERSION } = require("../validation/state");
const { normalizeColumns, normalizeGroups, viewState, groupColumnOf, hasValue, newViewId, LEGACY_DEFAULT_COLUMNS, LEGACY_DEFAULT_GROUPS, LIMITS } = require("../domain/board-schema");

const IMPORT_LIMITS = Object.freeze({ workspaces: 1000, boardsPerWorkspace: 1000, records: 50000, errors: 50 });
const LEGACY_ID = /^[A-Za-z0-9_-]{1,100}$/;
const RECORD_SYSTEM_FIELDS = new Set(["id", "archived", "pinned", "createdAt", "updatedAt", "activity"]);
const WORKSPACE_FIELDS = new Set(["id", "name", "color", "icon", "description", "boards", "createdAt", "archived"]);
const BOARD_FIELDS = new Set(["id", "name", "icon", "records", "activity", "groups", "savedViews", "favorite", "description", "columns", "nextItemNumber", "lastView", "openCount", "archived", "manualOrder", "createdAt", "updatedAt", "columnConfig"]);
const COLUMN_FIELDS = ["key", "label", "type", "required", "visible", "defaultValue", "options", "width", "connection"];
const PER_USER_FIELDS = ["currentWorkspaceId", "currentBoardId", "currentView", "screen", "settings", "profile", "notifications", "recentBoards", "recentRecords", "recentCommands"];

const isLegacyId = (v) => typeof v === "string" && LEGACY_ID.test(v);
const isRecordId = (v) => (Number.isSafeInteger(v) && v > 0) || isLegacyId(v);
const isText = (v, max) => typeof v === "string" && v.length <= max;
const isColor = (v) => v === undefined || v === "" || (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v));
const flatList = (v) => Array.isArray(v) && v.every((item) => isObject(item) && Object.values(item).every(isPrimitive));
const legacyDate = (value) => { if (typeof value !== "string" && typeof value !== "number") return null; const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d; };
const label = (thing) => String(thing ?? "").slice(0, 60);

// Throws 400 VALIDATION_ERROR listing the problems found, or returns the detected format.
function validateLegacyInput(input) {
  if (!isObject(input)) throw invalid(["The file is not a JARC state document or backup."]);
  assertSafeJson(input, { maxDepth: 32, label: "The import" });
  let format;
  if (input.schemaVersion !== undefined) {
    if (input.schemaVersion !== SCHEMA_VERSION) throw invalid([`Only schemaVersion ${SCHEMA_VERSION} state documents can be imported.`]);
    const problem = validateState(input);
    if (problem) throw invalid([problem]);
    format = "state-v1";
  } else {
    if (input.version !== undefined && !(Number.isInteger(input.version) && input.version >= 1 && input.version <= 11)) throw invalid(["The backup was made by an unsupported version of JARC."]);
    format = `backup-v${input.version ?? 0}`;
  }

  const errors = [];
  const add = (message) => { if (errors.length < IMPORT_LIMITS.errors) errors.push(message); };
  if (!Array.isArray(input.workspaces) || !input.workspaces.length) throw invalid(["It contains no workspaces."]);
  if (input.workspaces.length > IMPORT_LIMITS.workspaces) add(`It has more than ${IMPORT_LIMITS.workspaces} workspaces.`);
  const workspaceIds = new Set();
  let records = 0;
  input.workspaces.forEach((w, wi) => {
    const where = `Workspace ${wi + 1}`;
    if (!isObject(w)) return add(`${where} is not a workspace.`);
    if (!isLegacyId(w.id)) add(`${where} has a missing or invalid ID.`);
    else if (workspaceIds.has(w.id)) add(`${where} repeats the workspace ID "${w.id}" (duplicate legacy ID).`);
    workspaceIds.add(w.id);
    if (!isText(w.name, 200) || !w.name.trim()) add(`${where} has no valid name.`);
    if (!isColor(w.color)) add(`${where} has an invalid colour.`);
    if ((w.icon !== undefined && !isText(w.icon, 4)) || (w.description !== undefined && !isText(w.description, 5000))) add(`${where} has an invalid icon or description.`);
    if (!Array.isArray(w.boards)) return add(`${where} has no board list.`);
    if (w.boards.length > IMPORT_LIMITS.boardsPerWorkspace) add(`${where} has too many boards.`);
    const boardIds = new Set();
    w.boards.forEach((b, bi) => {
      const bw = `Board ${bi + 1} in workspace "${label(w.name)}"`;
      if (!isObject(b)) return add(`${bw} is not a board.`);
      if (!isLegacyId(b.id)) add(`${bw} has a missing or invalid ID.`);
      else if (boardIds.has(b.id)) add(`${bw} repeats the board ID "${b.id}" (duplicate legacy ID).`);
      boardIds.add(b.id);
      if (!isText(b.name, 200) || !b.name.trim()) add(`${bw} has no valid name.`);
      if (b.description !== undefined && !isText(b.description, 5000)) add(`${bw} has an invalid description.`);
      if (b.columns !== undefined) collect(add, () => normalizeColumns(Array.isArray(b.columns) ? b.columns.map(pickColumn) : b.columns), `${bw}: `);
      if (b.groups !== undefined && (!Array.isArray(b.groups) || b.groups.some((g) => !isText(g, 200)))) add(`${bw} has invalid groups.`);
      if (b.activity !== undefined && !flatList(b.activity)) add(`${bw} has invalid activity history.`);
      if (b.savedViews !== undefined) {
        if (!Array.isArray(b.savedViews) || b.savedViews.length > LIMITS.savedViews) add(`${bw} has invalid saved views.`);
        else b.savedViews.forEach((v, vi) => {
          if (!isObject(v) || !isRecordId(v.id) || !isText(v.name, 200)) return add(`${bw}: saved view ${vi + 1} is invalid.`);
          collect(add, () => viewState(viewStateOf(v), vi), `${bw}: `);
        });
      }
      if (!Array.isArray(b.records)) return add(`${bw} has no record list.`);
      const recordIds = new Set();
      b.records.forEach((r, ri) => {
        records += 1;
        const rw = `Record ${ri + 1} in board "${label(b.name)}"`;
        if (!isObject(r)) return add(`${rw} is not a record.`);
        if (!isRecordId(r.id)) add(`${rw} has a missing or invalid ID.`);
        else if (recordIds.has(r.id)) add(`${rw} repeats the record ID ${JSON.stringify(r.id)} (duplicate legacy ID).`);
        recordIds.add(r.id);
        for (const [key, value] of Object.entries(r)) {
          if (key === "activity") { if (!flatList(value)) add(`${rw} has invalid history.`); continue; }
          if (!isSafeKey(key)) { add(`${rw} has a field name that can't be stored.`); continue; }
          if (!isPrimitive(value)) add(`${rw} has an unsupported (nested) value in "${key.slice(0, 40)}".`);
          else if (typeof value === "string" && value.length > LIMITS.legacyValueLength) add(`${rw} has a value that is too long.`);
        }
      });
    });
  });
  if (records > IMPORT_LIMITS.records) add(`It has ${records} records; at most ${IMPORT_LIMITS.records} can be imported at once.`);
  if (errors.length) throw invalid(errors);
  return format;
}

function invalid(errors) {
  return new ApiError(400, "VALIDATION_ERROR", `The data can't be imported: ${errors[0]}${errors.length > 1 ? ` (and ${errors.length - 1} more problem${errors.length > 2 ? "s" : ""})` : ""}`, { errors });
}
function collect(add, fn, prefix) { try { fn(); } catch (error) { if (error instanceof ApiError) add(prefix + error.message); else throw error; } }
const pickColumn = (c) => (isObject(c) ? Object.fromEntries(COLUMN_FIELDS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]])) : c);
const viewStateOf = (view) => Object.fromEntries(Object.entries(view).filter(([k, v]) => k !== "id" && k !== "name" && v !== undefined));

// Columns for a legacy board without its own column list: exactly what the frontend shows for it (normalizeBoards).
function legacyDefaultColumns(columnConfig) {
  return LEGACY_DEFAULT_COLUMNS.map((c) => ({ ...c, visible: columnConfig?.[c.key]?.visible !== false, connection: typeof columnConfig?.[c.key]?.connection === "string" ? columnConfig[c.key].connection : "", required: c.key === "serial", defaultValue: "", options: [] }));
}

// Builds every document for the import. Call validateLegacyInput first.
function buildImportPlan(input, { actorId, now = new Date(), importId = crypto.randomUUID() }) {
  const format = validateLegacyInput(input);
  const plan = { importId, format, workspaces: [], memberships: [], boards: [], records: [], activities: [] };
  const warnings = [];
  const counters = { defaultedDates: 0, unknownGroupsCreated: [], extraGroupColumns: 0, valuesWithoutColumn: 0, viewRefsToMissingColumns: 0, legacyActivitySkipped: 0, defaultColumnsApplied: 0, defaultGroupsApplied: 0, ignoredFields: new Set(), favorites: 0 };
  const dateOr = (value, fallback) => { const d = legacyDate(value); if (!d) counters.defaultedDates += 1; return d || fallback; };

  input.workspaces.forEach((w, wi) => {
    Object.keys(w).filter((k) => !WORKSPACE_FIELDS.has(k)).forEach((k) => counters.ignoredFields.add(`workspace.${k}`));
    const workspaceId = new ObjectId();
    const createdAt = dateOr(w.createdAt, now);
    plan.workspaces.push({ _id: workspaceId, legacyId: w.id, name: w.name.trim(), description: w.description ?? "", icon: w.icon ?? w.name.trim().slice(0, 1).toUpperCase(), color: w.color ?? "", archived: Boolean(w.archived), position: (wi + 1) * 1000, createdBy: null, createdAt, updatedAt: createdAt, version: 1, importId });
    plan.memberships.push({ workspaceId, userId: actorId, role: "WORKSPACE_ADMIN", status: "active", createdAt: now, updatedAt: now });

    w.boards.forEach((b, bi) => {
      Object.keys(b).filter((k) => !BOARD_FIELDS.has(k)).forEach((k) => counters.ignoredFields.add(`board.${k}`));
      if (b.favorite) counters.favorites += 1;
      const boardId = new ObjectId();
      if (b.columns === undefined) counters.defaultColumnsApplied += 1;
      const columns = normalizeColumns(b.columns === undefined ? legacyDefaultColumns(b.columnConfig) : b.columns.map(pickColumn));
      const keys = new Set(columns.map((c) => c.key));
      if (b.groups === undefined) counters.defaultGroupsApplied += 1;
      const groupNames = [...new Set((b.groups ?? LEGACY_DEFAULT_GROUPS).map((g) => g.trim()).filter(Boolean))];
      const groupKey = groupColumnOf(columns)?.key;
      counters.extraGroupColumns += Math.max(0, columns.filter((c) => c.type === "group").length - 1);
      // Every group name used by a record becomes a group; names not in the board's list are added and reported.
      for (const r of b.records) {
        const name = groupKey && hasValue(r[groupKey]) ? String(r[groupKey]).trim() : "";
        if (name && !groupNames.includes(name)) { groupNames.push(name); counters.unknownGroupsCreated.push(`${label(b.name)}: ${label(name)}`); }
      }
      const groups = normalizeGroups(groupNames.map((name) => ({ name })));
      const groupIdByName = new Map(groups.map((g) => [g.name, g.id]));
      const savedViews = (b.savedViews ?? []).map((v, vi) => {
        const state = viewState(viewStateOf(v), vi);
        for (const listKey of ["visibleColumns", "columnOrder"]) if (Array.isArray(state[listKey])) counters.viewRefsToMissingColumns += state[listKey].filter((k) => !keys.has(k)).length;
        return { id: newViewId(), legacyId: v.id, name: v.name, state, createdBy: null, createdAt: now };
      });
      const boardCreated = dateOr(b.createdAt, now);
      const board = {
        _id: boardId, legacyId: b.id, workspaceId, name: b.name.trim(), description: b.description ?? "", icon: typeof b.icon === "string" && b.icon.length <= 4 ? b.icon : "D",
        archived: Boolean(b.archived), position: (bi + 1) * 1000, manualOrder: Boolean(b.manualOrder), columns, groups, savedViews,
        createdBy: null, createdAt: boardCreated, updatedAt: legacyDate(b.updatedAt) || boardCreated, version: 1, importId
      };
      if (Number.isSafeInteger(b.nextItemNumber) && b.nextItemNumber > 0) board.nextItemNumber = b.nextItemNumber;
      plan.boards.push(board);

      for (const entry of b.activity ?? []) {
        const at = legacyDate(entry.at);
        if (!at) { counters.legacyActivitySkipped += 1; continue; }
        plan.activities.push({ workspaceId, boardId, recordId: null, actorUserId: null, action: "legacy.board.activity", entityType: "board", entityId: boardId, changes: [], summary: String(entry.text ?? "").slice(0, 500), createdAt: at, importId });
      }

      b.records.forEach((r, ri) => {
        const recordId = new ObjectId();
        const values = {};
        for (const [key, value] of Object.entries(r)) {
          if (RECORD_SYSTEM_FIELDS.has(key) || key === groupKey) continue;
          if (!keys.has(key)) counters.valuesWithoutColumn += 1; // kept as-is: never drop data silently
          values[key] = value;
        }
        const groupName = groupKey && hasValue(r[groupKey]) ? String(r[groupKey]).trim() : "";
        const createdAt = dateOr(r.createdAt, now);
        plan.records.push({
          _id: recordId, legacyId: r.id, workspaceId, boardId, values, groupId: groupName ? groupIdByName.get(groupName) : null,
          position: (ri + 1) * 1000, archived: Boolean(r.archived), pinned: Boolean(r.pinned), createdBy: null, updatedBy: null,
          createdAt, updatedAt: legacyDate(r.updatedAt) || createdAt, version: 1, importId
        });
        for (const entry of r.activity ?? []) {
          const at = legacyDate(entry.at);
          if (!at) { counters.legacyActivitySkipped += 1; continue; }
          plan.activities.push({ workspaceId, boardId, recordId, actorUserId: null, action: "legacy.record.activity", entityType: "record", entityId: recordId, changes: [], summary: String(entry.text ?? "").slice(0, 500), legacyActor: typeof entry.by === "string" ? entry.by.slice(0, 200) : null, createdAt: at, importId });
        }
      });
    });
  });

  // One entry per imported workspace, by the importer.
  for (const workspace of plan.workspaces) {
    const boards = plan.boards.filter((b) => b.workspaceId === workspace._id);
    const records = plan.records.filter((r) => r.workspaceId === workspace._id).length;
    plan.activities.push({ workspaceId: workspace._id, boardId: null, recordId: null, actorUserId: actorId, action: "workspace.imported", entityType: "workspace", entityId: workspace._id, changes: [], summary: `Imported ${boards.length} boards and ${records} records from ${format}`, createdAt: now, importId });
  }

  if (counters.unknownGroupsCreated.length) warnings.push(`${counters.unknownGroupsCreated.length} group name(s) used by records were not in their board's group list and were added: ${counters.unknownGroupsCreated.slice(0, 10).join("; ")}`);
  if (counters.extraGroupColumns) warnings.push(`${counters.extraGroupColumns} additional group column(s) keep their values as text; only each board's first group column maps to groupId.`);
  if (counters.valuesWithoutColumn) warnings.push(`${counters.valuesWithoutColumn} value(s) belong to no current column; they were kept unchanged.`);
  if (counters.viewRefsToMissingColumns) warnings.push(`Saved views refer to ${counters.viewRefsToMissingColumns} column key(s) that no longer exist (kept; the app ignores them).`);
  if (counters.defaultColumnsApplied) warnings.push(`${counters.defaultColumnsApplied} board(s) had no column list and received the app's default columns.`);
  if (counters.defaultGroupsApplied) warnings.push(`${counters.defaultGroupsApplied} board(s) had no group list and received the app's default groups.`);
  if (counters.defaultedDates) warnings.push(`${counters.defaultedDates} item(s) had no valid creation date; the import time was used.`);
  if (counters.legacyActivitySkipped) warnings.push(`${counters.legacyActivitySkipped} history entr(ies) without a valid date were not imported.`);
  if (counters.ignoredFields.size) warnings.push(`Ignored fields: ${[...counters.ignoredFields].sort().join(", ")}.`);

  plan.report = {
    format,
    counts: { workspaces: plan.workspaces.length, boards: plan.boards.length, records: plan.records.length, columns: plan.boards.reduce((n, b) => n + b.columns.length, 0), groups: plan.boards.reduce((n, b) => n + b.groups.length, 0), savedViews: plan.boards.reduce((n, b) => n + b.savedViews.length, 0), activities: plan.activities.length, memberships: plan.memberships.length },
    legacyIds: { workspaces: plan.workspaces.map((w) => w.legacyId) },
    skipped: {
      localContacts: Array.isArray(input.members) ? input.members.length : 0,
      perUserFields: PER_USER_FIELDS.filter((k) => input[k] !== undefined),
      boardFavorites: counters.favorites
    },
    warnings
  };
  return plan;
}

module.exports = { validateLegacyInput, buildImportPlan, IMPORT_LIMITS };
