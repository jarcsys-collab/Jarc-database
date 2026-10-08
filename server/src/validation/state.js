// Server-side checks for the transitional state document. Deliberately small: it rejects anything that is not
// the shape the frontend saves (schemaVersion 1, workspaces → boards → records) and anything obviously malformed.
// Field-level rules arrive with the real workspaces/boards/records API.
const SCHEMA_VERSION = 1;
const LIMITS = Object.freeze({ depth: 32, workspaces: 1000, boardsPerWorkspace: 1000, recordsPerBoard: 100000, idLength: 100 });
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const USER_OBJECT_FIELDS = ["settings", "profile"];
const USER_ARRAY_FIELDS = ["notifications", "recentBoards", "recentRecords", "recentCommands"];
const USER_TEXT_FIELDS = ["currentWorkspaceId", "currentBoardId", "currentView", "screen"];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isId = (value) => typeof value === "string" && value.length > 0 && value.length <= LIMITS.idLength;

// Returns null when valid, otherwise a short reason that is safe to show.
function validateState(state) {
  if (!isObject(state)) return "The state must be a JSON object.";
  if (state.schemaVersion !== SCHEMA_VERSION) return `schemaVersion must be ${SCHEMA_VERSION}.`;
  const structure = checkStructure(state, 0);
  if (structure) return structure;

  if (!Array.isArray(state.workspaces) || state.workspaces.length === 0) return "workspaces must be a non-empty list.";
  if (state.workspaces.length > LIMITS.workspaces) return "There are too many workspaces.";
  for (const [wi, workspace] of state.workspaces.entries()) {
    if (!isObject(workspace) || !isId(workspace.id)) return `Workspace ${wi + 1} needs an id.`;
    if (!Array.isArray(workspace.boards) || workspace.boards.length > LIMITS.boardsPerWorkspace) return `Workspace ${wi + 1} needs a valid board list.`;
    for (const [bi, board] of workspace.boards.entries()) {
      const where = `Board ${bi + 1} in workspace ${wi + 1}`;
      if (!isObject(board) || !isId(board.id)) return `${where} needs an id.`;
      if (!Array.isArray(board.records) || board.records.length > LIMITS.recordsPerBoard) return `${where} needs a valid record list.`;
      if (!board.records.every(isObject)) return `${where} has a record that is not an object.`;
      if (board.columns !== undefined && !(Array.isArray(board.columns) && board.columns.every(isObject))) return `${where} has an invalid column list.`;
    }
  }
  if (state.members !== undefined && !(Array.isArray(state.members) && state.members.every(isObject))) return "members must be a list.";
  for (const key of USER_OBJECT_FIELDS) if (state[key] !== undefined && !isObject(state[key])) return `${key} must be an object.`;
  for (const key of USER_ARRAY_FIELDS) if (state[key] !== undefined && !Array.isArray(state[key])) return `${key} must be a list.`;
  for (const key of USER_TEXT_FIELDS) if (state[key] !== undefined && state[key] !== null && typeof state[key] !== "string") return `${key} must be text.`;
  return null;
}

// Depth limit and prototype-pollution keys anywhere in the document.
function checkStructure(value, depth) {
  if (value === null || typeof value !== "object") return null;
  if (depth > LIMITS.depth) return "The state is nested too deeply.";
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return "The state contains a reserved key.";
    const problem = checkStructure(value[key], depth + 1);
    if (problem) return problem;
  }
  return null;
}

module.exports = { validateState, SCHEMA_VERSION, LIMITS };
