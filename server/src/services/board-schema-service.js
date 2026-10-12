// Board schema changes that also rewrite stored record values (Stage 11): add/duplicate column, delete column,
// change a column's type, edit options (rename/remove), delete a group (moving its records), and move a board to
// another workspace. Each runs in ONE transaction: the board's version is checked, the board is updated and the
// board's own records are rewritten with the same rules the browser uses. A dry run returns only the affected count.
//
// Non-destructive changes (labels, order, visibility, widths, adding groups, saved views) stay on PATCH /boards/:id.
const validate = require("../validation/resources");
const { versionParam, queryString } = require("../validation/common");
const { normalizeColumns, groupColumnOf, hasValue, valueFits, convertValue, optionsPlan, sameValue, valueList, isMultiColumn, OPTION_TYPES, PRIMARY_KEY, USER_REF } = require("../domain/board-schema");
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { notFound, conflict, activityEntry } = require("./shared");

const invalid = (message) => new ApiError(400, "VALIDATION_ERROR", message);

class BoardSchemaService {
  constructor({ repos, connection }) { Object.assign(this, { repos, connection }); }

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
    return dryRun ? run(undefined) : this.connection.withTransaction(run);
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
          boardSet: { columns: normalizeColumns(columns) },
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
          boardSet: { columns: board.columns.filter((c) => c.key !== key) },
          changes,
          affected: isPrimaryGroup ? changes.length : records.filter((r) => hasValue(r.values[key])).length,
          summary: `Deleted column ${column.label}`
        };
      }
    });
  }

  async changeType(boardId, key, raw, query, actor) {
    const dryRun = validate.dryRunParam(query);
    const { expectedVersion, type, multiple } = validate.columnType(raw);
    return this.change(boardId, expectedVersion, actor, {
      dryRun, action: "column.type_changed",
      build: async (board, records) => {
        const column = this.column(board, key);
        if (key === PRIMARY_KEY) throw invalid("The Item column's type can't be changed.");
        // A Dropdown can also switch between one value and several (same type, different "multiple").
        const modeChange = type === "dropdown" && column.type === "dropdown" && multiple !== Boolean(column.multiple);
        if (column.type === type && !modeChange) throw invalid("The column already has this type.");
        if (column.type === "group" || type === "group") throw invalid("Changing a column to or from the Group type isn't supported yet.");
        if (column.type === "files" || type === "files") throw invalid("Files columns can't be changed to or from another type. Add a new column instead.");
        if (multiple && type !== "dropdown") throw invalid("Only Dropdown columns can allow several values.");
        // People entries that become plain text keep the person's name, never their internal ID.
        const refs = [...new Set(records.flatMap((r) => valueList(r.values[key])).filter((v) => USER_REF.test(v)))];
        const people = refs.length ? await this.repos.users.findByIds(refs.map((r) => new ObjectId(r.slice(5)))) : [];
        const names = new Map(people.map((u) => [`user:${u._id.toHexString()}`, u.displayName || u.email || "Unknown user"]));
        const changes = [];
        let cleared = 0;
        const newValues = new Map();
        for (const record of records) {
          const value = record.values[key];
          if (hasValue(value) && !valueFits(value, type)) cleared += 1;
          const next = value === undefined && type !== "checkbox" ? undefined : convertValue(value, type, { multiple, names });
          newValues.set(record, next);
          if (next !== undefined && !sameValue(next, value)) changes.push({ record, set: { [`values.${key}`]: next } });
        }
        const updated = { ...column, type };
        delete updated.multiple;
        if (multiple) updated.multiple = true;
        if (!["status", "priority", "dropdown"].includes(type)) delete updated.colors;
        // A dropdown only offers its own options, so keep existing values selectable (BoardModel parity).
        if (type === "dropdown") updated.options = [...new Set([...(column.options || []), ...[...newValues.values()].flatMap(valueList)])];
        if (!valueFits(updated.defaultValue, type) || Array.isArray(updated.defaultValue)) updated.defaultValue = "";
        const describe = (t, m) => (t === "dropdown" && m ? "dropdown (several values)" : t);
        return { boardSet: { columns: board.columns.map((c) => (c.key === key ? updated : c)) }, changes, affected: cleared, summary: modeChange ? `Set ${column.label} to allow ${multiple ? "several values" : "one value"}` : `Changed ${column.label} from ${describe(column.type, column.multiple)} to ${describe(type, multiple)}` };
      }
    });
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
