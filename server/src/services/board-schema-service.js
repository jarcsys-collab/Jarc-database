// Board schema changes that also rewrite stored record values (Stage 11): add/duplicate column, delete column,
// change a column's type, edit options (rename/remove), delete a group (moving its records), and move a board to
// another workspace. Each runs in ONE transaction: the board's version is checked, the board is updated and the
// board's own records are rewritten with the same rules the browser uses. A dry run returns only the affected count.
// A type change is the exception (S0-A, changeType below): it is refused unless lossless on the whole board.
//
// Non-destructive changes (labels, order, visibility, widths, adding groups, saved views) stay on PATCH /boards/:id.
const validate = require("../validation/resources");
const { versionParam, queryString } = require("../validation/common");
const { normalizeColumn, normalizeColumns, groupColumnOf, hasValue, optionsPlan, sameValue, valueList, isMultiColumn, settingsForType, OPTION_TYPES, PRIMARY_KEY } = require("../domain/board-schema");
const { SYNC_LIMITS, MESSAGES, conversionPlanner, convertCell, describeType } = require("../domain/column-conversion");
const { ApiError } = require("../middleware/errors");
const { notFound, conflict, activityEntry } = require("./shared");

const invalid = (message) => new ApiError(400, "VALIDATION_ERROR", message);
const MAX_RETIRED_COLUMNS = 1000;

// A refused type change: 400 (or 409 for a stale preview) CONVERSION_REFUSED with the full-board counts. The examples are
// masked, and ApiError details are sent to the caller only (middleware/errors.js never logs them).
function refusal(status, details) {
  const { previewToken, ...rest } = details;
  return new ApiError(status, "CONVERSION_REFUSED", MESSAGES[details.reason] || MESSAGES.INCOMPATIBLE_VALUES, { ...rest, allowed: false });
}

// Conversions refused whatever the values (unchanged since Stage 11; Connect / Mirror keep their relationship settings).
function assertConvertible(column, { type, multiple }) {
  if (column.key === PRIMARY_KEY) throw invalid("The Item column's type can't be changed.");
  // Connect and Mirror columns need their own settings (which board, which column): add a new column instead.
  if (["connect", "mirror"].includes(type) || ["connect", "mirror"].includes(column.type)) throw invalid("Connect and Mirror columns can't be converted to or from another type. Add a new column instead.");
  // A Dropdown can also switch between one value and several (same type, different "multiple").
  const modeChange = type === "dropdown" && column.type === "dropdown" && multiple !== Boolean(column.multiple);
  if (column.type === type && !modeChange) throw invalid("The column already has this type.");
  if (column.type === "group" || type === "group") throw invalid("Changing a column to or from the Group type isn't supported yet.");
  if (column.type === "files" || type === "files") throw invalid("Files columns can't be changed to or from another type. Add a new column instead.");
  if (multiple && type !== "dropdown") throw invalid("Only Dropdown columns can allow several values.");
}

// The column after the change (options of a Dropdown are filled from the values when it is written).
function convertedColumn(column, to) {
  const updated = { ...column, type: to.type };
  delete updated.multiple;
  if (to.multiple) updated.multiple = true;
  if (!OPTION_TYPES.includes(to.type)) delete updated.colors;
  // Display settings follow the new type: keys it doesn't define are dropped (05 §4.2); nothing left → none.
  const settings = settingsForType(to.type, column.settings);
  if (settings) updated.settings = settings; else delete updated.settings;
  // The default is configuration, not data: kept only if it stays exactly valid, otherwise none.
  const d = updated.defaultValue;
  if (Array.isArray(d) || (hasValue(d) && !(() => { const cell = convertCell(d, column, to, updated); return cell.ok && cell.next === undefined; })())) updated.defaultValue = "";
  return updated;
}

const typeLabel = (t, m) => (t === "dropdown" && m ? "dropdown (several values)" : t);

class BoardSchemaService {
  constructor({ repos, connection, searchIndex = null }) { Object.assign(this, { repos, connection, searchIndex }); }

  // Shared executor. build(board, records) → { boardSet, changes: [{ record, set?, unset? }], affected, summary } (or a
  // promise of it).
  async change(boardId, expectedVersion, actor, { dryRun = false, action, build }) {
    const run = async (session) => {
      const board = await this.repos.boards.findById(boardId, { session });
      if (!board) throw notFound("board");
      if (board.version !== expectedVersion) throw conflict("board", board);
      const records = await this.repos.records.listAllForBoard(boardId, { session });
      const plan = await build(board, records);
      if (dryRun) return { dryRun: true, affected: plan.affected };
      const now = new Date();
      if (!await this.repos.boards.updateVersioned(boardId, expectedVersion, { ...plan.boardSet, updatedAt: now }, { session })) throw conflict("board", board);
      const updates = plan.changes.map(({ record, set = {}, unset = {} }) => ({
        filter: { _id: record._id, boardId },
        update: { $set: { ...set, updatedBy: actor.userId, updatedAt: now }, ...(Object.keys(unset).length ? { $unset: unset } : {}), $inc: { version: 1 } }
      }));
      await this.repos.records.bulkUpdate(updates, { session });
      await this.repos.activities.append(activityEntry({ workspaceId: board.workspaceId, boardId, actorUserId: actor.userId, actorName: actor.displayName, action, entityType: "board", entityId: boardId, summary: plan.summary, now }), { session });
      return { board: { ...board, ...plan.boardSet, updatedAt: now, version: board.version + 1 }, affected: plan.affected, recordsChanged: updates.length };
    };
    if (dryRun) return run(undefined);
    const result = await this.connection.withTransaction(run);
    this.searchIndex?.refreshBoard(boardId); // a change of columns can change what is searchable on every record
    return result;
  }

  column(board, key) {
    const column = board.columns.find((c) => c.key === key);
    if (!column) throw new ApiError(404, "NOT_FOUND", "This column doesn't exist on the board.");
    return column;
  }

  // Add a column (filled like the browser: checkbox → false, otherwise its default), or duplicate one (copyFrom).
  async addColumn(boardId, raw, actor) {
    const board = await this.repos.boards.findById(boardId);
    if (!board) throw notFound("board");
    const { expectedVersion, column, index, copyFrom } = validate.columnAdd(raw, board);
    // A duplicate copies values verbatim, so it must keep the original's type and mode: otherwise it would be a type
    // change that skips the conversion checks (the app's duplicate always keeps them).
    if (copyFrom && (copyFrom.type !== column.type || Boolean(copyFrom.multiple) !== Boolean(column.multiple))) throw invalid("A duplicated column keeps the original column's type. Duplicate it first, then change the copy's type.");
    // A duplicated Connect column copies the linked record IDs, so it must link to the same board; a duplicated Mirror
    // column must follow the same Connect column and show the same column (otherwise IDs would point at another board).
    if (copyFrom && (column.type === "connect" || column.type === "mirror")) {
      const config = (c) => JSON.stringify(c.type === "connect" ? { boardId: c.link?.boardId ?? null } : { via: c.mirror?.via ?? null, column: c.mirror?.column ?? null, show: c.mirror?.show ?? "list" });
      if (config(copyFrom) !== config(column)) throw invalid(column.type === "connect" ? "A duplicated Connect column links to the same board as the original." : "A duplicated Mirror column shows the same column through the same Connect column as the original.");
    }
    return this.change(boardId, expectedVersion, actor, {
      action: "column.added",
      build: (current, records) => {
        const columns = [...current.columns];
        columns.splice(index, 0, column);
        const primaryBefore = groupColumnOf(current.columns);
        const becomesPrimaryGroup = column.type === "group" && !primaryBefore;
        const groupName = (record) => current.groups.find((g) => g.id === record.groupId)?.name ?? "";
        const valueFor = (record) => {
          if (!copyFrom) return column.type === "checkbox" ? false : isMultiColumn(column) ? valueList(column.defaultValue) : column.defaultValue;
          if (copyFrom.key === primaryBefore?.key) return groupName(record) || column.defaultValue;
          return record.values[copyFrom.key] ?? column.defaultValue;
        };
        return {
          // A column restored by undo is no longer retired; its ID means the same column again.
          boardSet: { columns: normalizeColumns(columns), ...(current.retiredColumns?.some((r) => r.key === column.key) ? { retiredColumns: current.retiredColumns.filter((r) => r.key !== column.key) } : {}) },
          changes: becomesPrimaryGroup ? [] : records.map((record) => ({ record, set: { [`values.${column.key}`]: valueFor(record) } })),
          affected: 0,
          summary: `${copyFrom ? "Duplicated" : "Added"} column ${column.label}`
        };
      }
    });
  }

  async deleteColumn(boardId, key, query, actor) {
    const dryRun = validate.dryRunParam(query, ["expectedVersion"]);
    const expectedVersion = versionParam(query.expectedVersion);
    return this.change(boardId, expectedVersion, actor, {
      dryRun, action: "column.deleted",
      build: (board, records) => {
        const column = this.column(board, key);
        if (key === PRIMARY_KEY) throw invalid("The Item column can't be deleted.");
        const primary = groupColumnOf(board.columns);
        const isPrimaryGroup = primary?.key === key;
        if (isPrimaryGroup && board.columns.filter((c) => c.type === "group").length > 1) throw invalid("Delete the other group columns first; the board's main group column can't be removed while another exists.");
        const changes = isPrimaryGroup
          ? records.filter((r) => r.groupId !== null && r.groupId !== undefined).map((record) => ({ record, set: { groupId: null } }))
          : records.filter((r) => r.values[key] !== undefined).map((record) => ({ record, unset: { [`values.${key}`]: "" } }));
        return {
          // Its ID is retired, so no later column can take it (see validation/resources.js).
          boardSet: { columns: board.columns.filter((c) => c.key !== key), retiredColumns: [...(board.retiredColumns || []).filter((r) => r.key !== key), { key, type: column.type, at: new Date() }].slice(-MAX_RETIRED_COLUMNS) },
          changes,
          affected: isPrimaryGroup ? changes.length : records.filter((r) => hasValue(r.values[key])).length,
          summary: `Deleted column ${column.label}`
        };
      }
    });
  }

  // Column type change (Column System S0-A). Allowed only when it is lossless on EVERY record of the board
  // (domain/column-conversion.js); otherwise refused with 400 CONVERSION_REFUSED and full-board counts, and nothing changes.
  //   - The check reads one column of every record (projection), never loaded rows or a sample.
  //   - The commit re-checks inside the same transaction that writes, after the board version check (409 CONFLICT when
  //     stale); an optional previewToken from the dry run must still match (409 CONVERSION_REFUSED / PREVIEW_STALE).
  //   - Boards over SYNC_LIMITS are refused (BOARD_TOO_LARGE) until the resumable engine exists; their counts are taken
  //     outside any transaction.
  //   - Records whose stored value stays the same are not rewritten; if none change, only the column definition is written.
  // Response (unchanged contract): { board, affected: 0, recordsChanged }. Dry run: { dryRun, affected, ...details }.
  async changeType(boardId, key, raw, query, actor) {
    const dryRun = validate.dryRunParam(query);
    const { expectedVersion, type, multiple, previewToken } = validate.columnType(raw);
    const to = { type, multiple };
    const load = async (session) => {
      const board = await this.repos.boards.findById(boardId, { session });
      if (!board) throw notFound("board");
      if (board.version !== expectedVersion) throw conflict("board", board);
      const column = this.column(board, key);
      assertConvertible(column, to);
      return { board, column, toColumn: convertedColumn(column, to) };
    };
    const scan = async ({ board, column, toColumn }, session) => {
      const planner = conversionPlanner({ board, column, to, toColumn });
      const cursor = this.repos.records.columnValues(boardId, key, { session });
      try { for (let doc = await cursor.next(); doc; doc = await cursor.next()) planner.add(doc._id, doc.values?.[key]); }
      finally { await cursor.close?.(); }
      return planner.finish();
    };
    if (dryRun) {
      const { details } = await scan(await load(undefined), undefined);
      return { dryRun: true, affected: details.incompatible, ...details };
    }
    const TOO_LARGE = Symbol("too large");
    let result;
    try {
      result = await this.connection.withTransaction(async (session) => {
        const loaded = await load(session);
        // Too large for one transaction: leave it before reading any value (the counts are taken below, outside it).
        if (await this.repos.records.countAllForBoard(boardId, { session }) > SYNC_LIMITS.records) throw TOO_LARGE;
        const plan = await scan(loaded, session);
        if (previewToken !== undefined && plan.details.previewToken !== previewToken) throw refusal(409, { ...plan.details, reason: "PREVIEW_STALE" });
        if (!plan.details.allowed) throw refusal(400, plan.details);
        return this.writeConversion(loaded, plan, { expectedVersion, actor, session });
      });
    } catch (error) {
      if (error !== TOO_LARGE) throw error;
      const { details } = await scan(await load(undefined), undefined);
      throw refusal(400, { ...details, tooLarge: true, reason: details.reason && details.reason !== "BOARD_TOO_LARGE" ? details.reason : "BOARD_TOO_LARGE" });
    }
    this.searchIndex?.refreshBoard(boardId); // a change of type can change what is searchable on every record
    return result;
  }

  async writeConversion({ board, column, toColumn }, plan, { expectedVersion, actor, session }) {
    const key = column.key, now = new Date();
    // The converted column is validated like any column (option caps and lengths, D4); other columns are left as stored.
    const updated = normalizeColumn(plan.options ? { ...toColumn, options: plan.options } : toColumn, `Column "${key}"`);
    const columns = board.columns.map((c) => (c.key === key ? updated : c));
    if (!await this.repos.boards.updateVersioned(board._id, expectedVersion, { columns, updatedAt: now }, { session })) throw conflict("board", board);
    const updates = plan.changes.map(({ id, next }) => ({
      filter: { _id: id, boardId: board._id },
      update: { $set: { [`values.${key}`]: next, updatedBy: actor.userId, updatedAt: now }, $inc: { version: 1 } }
    }));
    if (updates.length) await this.repos.records.bulkUpdate(updates, { session });
    const summary = column.type === toColumn.type ? `Set ${column.label} to allow ${toColumn.multiple ? "several values" : "one value"}` : `Changed ${column.label} from ${typeLabel(column.type, column.multiple)} to ${typeLabel(toColumn.type, toColumn.multiple)}`;
    await this.repos.activities.append(activityEntry({ workspaceId: board.workspaceId, boardId: board._id, actorUserId: actor.userId, actorName: actor.displayName, action: "column.type_changed", entityType: "board", entityId: board._id, summary, changes: [{ field: `columns.${key}.type`, from: describeType(column.type, column.multiple), to: describeType(toColumn.type, toColumn.multiple) }], now }), { session });
    return { board: { ...board, columns, updatedAt: now, version: board.version + 1 }, affected: 0, recordsChanged: updates.length };
  }

  async editOptions(boardId, key, raw, query, actor) {
    const dryRun = validate.dryRunParam(query);
    const { expectedVersion, items } = validate.columnOptions(raw);
    return this.change(boardId, expectedVersion, actor, {
      dryRun, action: "column.options_changed",
      build: (board, records) => {
        const column = this.column(board, key);
        if (!OPTION_TYPES.includes(column.type)) throw invalid("Only status, dropdown and priority columns have options.");
        const plan = optionsPlan(column, items);
        if (!plan.options.length) throw invalid("Keep at least one option.");
        const changes = records.filter((r) => r.values[key] !== undefined && !sameValue(plan.mapValue(r.values[key]), r.values[key])).map((record) => ({ record, set: { [`values.${key}`]: plan.mapValue(record.values[key]) } }));
        const updated = { ...column, options: plan.options, defaultValue: plan.mapValue(column.defaultValue) };
        delete updated.colors;
        if (plan.colors) updated.colors = plan.colors;
        return {
          boardSet: { columns: board.columns.map((c) => (c.key === key ? updated : c)) },
          changes,
          affected: records.filter((r) => valueList(r.values[key]).some((v) => plan.removed.has(v))).length,
          summary: `Updated ${column.label} options`
        };
      }
    });
  }

  // Deleting a group moves its records to another group (moveTo) or to no group ("none"), then removes the group.
  async deleteGroup(boardId, groupId, query, actor) {
    const dryRun = validate.dryRunParam(query, ["expectedVersion", "moveTo"]);
    const expectedVersion = versionParam(query.expectedVersion);
    const moveToRaw = queryString(query.moveTo, "moveTo");
    return this.change(boardId, expectedVersion, actor, {
      dryRun, action: "group.deleted",
      build: (board, records) => {
        const group = board.groups.find((g) => g.id === groupId);
        if (!group) throw new ApiError(404, "NOT_FOUND", "This group doesn't exist on the board.");
        if (board.groups.length <= 1) throw invalid("A board keeps at least one group.");
        let moveTo = null;
        if (moveToRaw !== undefined && moveToRaw !== "none") {
          if (moveToRaw === groupId || !board.groups.some((g) => g.id === moveToRaw)) throw invalid("moveTo must be another group of this board, or none.");
          moveTo = moveToRaw;
        }
        const changes = records.filter((r) => r.groupId === groupId).map((record) => ({ record, set: { groupId: moveTo } }));
        const groups = board.groups.filter((g) => g.id !== groupId).map((g, i) => ({ ...g, position: (i + 1) * 1000 }));
        return { boardSet: { groups }, changes, affected: changes.length, summary: `Deleted group ${group.name}` };
      }
    });
  }

  // Moves a board (and its records' workspaceId) to another existing workspace.
  async moveBoard(boardId, raw, actor) {
    const { expectedVersion, workspaceId } = validate.boardMove(raw);
    return this.connection.withTransaction(async (session) => {
      const board = await this.repos.boards.findById(boardId, { session });
      if (!board) throw notFound("board");
      if (board.version !== expectedVersion) throw conflict("board", board);
      if (board.workspaceId.equals(workspaceId)) throw invalid("The board is already in that workspace.");
      if (!await this.repos.workspaces.findById(workspaceId, { session })) throw notFound("workspace");
      const now = new Date();
      const position = await this.repos.boards.nextPosition(workspaceId, { session });
      if (!await this.repos.boards.updateVersioned(boardId, expectedVersion, { workspaceId, position, updatedAt: now }, { session })) throw conflict("board", board);
      const records = await this.repos.records.setWorkspaceForBoard(boardId, workspaceId, { session });
      await this.repos.activities.append(activityEntry({ workspaceId, boardId, actorUserId: actor.userId, actorName: actor.displayName, action: "board.moved", entityType: "board", entityId: boardId, changes: [{ field: "workspaceId", from: board.workspaceId, to: workspaceId }], now }), { session });
      return { board: { ...board, workspaceId, position, updatedAt: now, version: board.version + 1 }, records };
    });
  }
}

module.exports = { BoardSchemaService };
