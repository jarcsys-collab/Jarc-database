// Board capabilities (P4 shared authorization contract, Employee Management plan 27 + 30). PURE: no I/O, and it requires
// nothing (safe on worker threads, which must not load the MongoDB driver or the error middleware).
//
// Every permission question about a board is one capability. A person's capabilities on a board come from ONE board role:
//
//   VIEWER < CONTRIBUTOR < EDITOR < OWNER
//
// P4-0 (this release) derives the board role from today's workspace role, losslessly (mapToday / impliedBoardRole):
//   VIEWER → VIEWER, MEMBER → EDITOR, WORKSPACE_ADMIN → OWNER, SYSTEM_ADMIN → OWNER.
// CONTRIBUTOR is vocabulary only until P4-4: no workspace role maps to it, so a CONTRIBUTOR minimum is equivalent to EDITOR
// for every role that can occur today (the parity tests prove that).
//
// Three capabilities are REAL-ROW only (never granted by shared access: development_shared or beta open editing): managing
// workspace members, managing board permissions, moderating comments. They need SYSTEM_ADMIN or an active WORKSPACE_ADMIN
// membership (capped by the account role when ACCOUNT_MANAGEMENT=enforced), exactly as roleIn(..., { membershipOnly }).
//
// Read-only synchronized boards (source.readOnly) refuse content and schema writes whatever the role; READ_ONLY_KEEPS lists
// what still works there (as routes/resources.js, files.js, forms, comments do today).
//
// API tokens (mode "token") are read-only: only TOKEN_CAPS, and only what the token owner's role gives.
//
// NOT AUTHORITATIVE YET: in P4-0 the existing Access helpers decide every request. This module sits alongside them and is
// proven equal by tests/authz-parity.test.js before any call site moves to it (P4-4).

const CAP = Object.freeze({
  BOARD_VIEW: "board.view",
  RECORD_VIEW: "record.view",
  VIEWS_PERSONAL: "views.personal",
  RECORD_EDIT_VALUES: "record.editValues",
  RECORD_CREATE: "record.create",
  RECORD_DELETE: "record.delete",
  FORM_SUBMIT: "form.submit",
  BOARD_STRUCTURE: "board.structure", // name, description, groups (incl. delete)
  BOARD_ORGANIZE: "board.organize", // shared saved views and board order: still allowed on read-only boards (plan 30, D-C5)
  COLUMN_CREATE: "column.create",
  COLUMN_MODIFY: "column.modify", // rename, reorder, width, settings, add / rename options
  COLUMN_DESTRUCTIVE: "column.destructive", // delete a column, remove options
  COLUMN_CONVERT: "column.convertType",
  CONNECT_CONFIGURE: "connect.configure", // on the HOST board; the target needs board.view as well (cross-board rule)
  MIRROR_CONFIGURE: "mirror.configure", // on the HOST board; the via-Connect's target needs board.view as well
  FORM_DESIGN: "form.design",
  BOARD_ARCHIVE: "board.archive",
  BOARD_DELETE: "board.delete",
  BOARD_MOVE: "board.move", // on the board; the target workspace needs WORKSPACE_ADMIN as well (not a board capability)
  BOARD_PERMISSIONS: "board.managePermissions",
  WORKSPACE_MEMBERS: "workspace.manageMembers",
  COMMENT_MODERATE: "comment.moderate"
});
const ALL_CAPS = Object.freeze(Object.values(CAP));
const KNOWN = new Set(ALL_CAPS);

const BOARD_ROLES = Object.freeze(["VIEWER", "CONTRIBUTOR", "EDITOR", "OWNER"]);
const BOARD_RANK = Object.freeze({ VIEWER: 1, CONTRIBUTOR: 2, EDITOR: 3, OWNER: 4 });

// The lowest board role that holds each capability (the "P4 target" column of plan 27 §3).
const MIN_BOARD_ROLE = Object.freeze({
  [CAP.BOARD_VIEW]: "VIEWER",
  [CAP.RECORD_VIEW]: "VIEWER",
  [CAP.VIEWS_PERSONAL]: "VIEWER",
  [CAP.RECORD_EDIT_VALUES]: "CONTRIBUTOR",
  [CAP.RECORD_CREATE]: "CONTRIBUTOR",
  [CAP.RECORD_DELETE]: "CONTRIBUTOR",
  [CAP.FORM_SUBMIT]: "CONTRIBUTOR",
  [CAP.BOARD_STRUCTURE]: "EDITOR",
  [CAP.BOARD_ORGANIZE]: "EDITOR",
  [CAP.COLUMN_CREATE]: "EDITOR",
  [CAP.COLUMN_MODIFY]: "EDITOR",
  [CAP.CONNECT_CONFIGURE]: "EDITOR",
  [CAP.MIRROR_CONFIGURE]: "EDITOR",
  [CAP.COLUMN_DESTRUCTIVE]: "OWNER",
  [CAP.COLUMN_CONVERT]: "OWNER",
  [CAP.FORM_DESIGN]: "OWNER", // D-C3: OWNER keeps today's WORKSPACE_ADMIN minimum (EDITOR would widen it to MEMBER)
  [CAP.BOARD_ARCHIVE]: "OWNER",
  [CAP.BOARD_DELETE]: "OWNER",
  [CAP.BOARD_MOVE]: "OWNER",
  [CAP.BOARD_PERMISSIONS]: "OWNER",
  [CAP.WORKSPACE_MEMBERS]: "OWNER",
  [CAP.COMMENT_MODERATE]: "OWNER"
});

const REAL_ROW = Object.freeze(new Set([CAP.BOARD_PERMISSIONS, CAP.WORKSPACE_MEMBERS, CAP.COMMENT_MODERATE]));
// Still allowed on a read-only synchronized board. Not comment.moderate: comment-service refuses every comment write there,
// moderation included (plan 30 §9, divergence 2). Not form.design: creating a form there is refused (form-service).
const READ_ONLY_KEEPS = Object.freeze(new Set([CAP.BOARD_VIEW, CAP.RECORD_VIEW, CAP.VIEWS_PERSONAL, CAP.BOARD_ORGANIZE, CAP.BOARD_ARCHIVE, CAP.BOARD_DELETE, CAP.BOARD_MOVE, CAP.BOARD_PERMISSIONS, CAP.WORKSPACE_MEMBERS]));
// What an API token can ever hold (scope "read" only today). Future write scopes = scope ∩ the owner's capability.
const TOKEN_CAPS = Object.freeze(new Set([CAP.BOARD_VIEW, CAP.RECORD_VIEW]));

// Today's workspace roles → the board role they imply (P4-0 fixed ladder; D-C2).
const TODAY_TO_BOARD = Object.freeze({ VIEWER: "VIEWER", MEMBER: "EDITOR", WORKSPACE_ADMIN: "OWNER", SYSTEM_ADMIN: "OWNER" });
const mapToday = (role) => (role && Object.prototype.hasOwnProperty.call(TODAY_TO_BOARD, role) ? TODAY_TO_BOARD[role] : null);
// P4-0: the fixed ladder. P4-4 adds explicit board grants (max with this), P4-5 private boards and memberEdit.
const impliedBoardRole = (workspaceRole /* , board */) => mapToday(workspaceRole);

const atLeastBoard = (role, minimum) => Boolean(role) && BOARD_RANK[role] >= BOARD_RANK[minimum];
const isCap = (cap) => KNOWN.has(cap);

// The capabilities of one person on one board. Pure.
//   boardRole   the board role (null: the board is not visible: no capability at all)
//   realRole    today's workspace role through a REAL membership or SYSTEM_ADMIN (membershipOnly), or null
//   readOnly    the board is a read-only synchronized board
//   mode        "session" | "token"
function capabilitiesFor({ boardRole, realRole = null, readOnly = false, mode = "session" } = {}) {
  const caps = new Set();
  if (!boardRole || !BOARD_RANK[boardRole]) return Object.freeze(caps);
  const realBoardRole = mapToday(realRole);
  for (const cap of ALL_CAPS) {
    if (mode === "token" && !TOKEN_CAPS.has(cap)) continue;
    if (readOnly && !READ_ONLY_KEEPS.has(cap)) continue;
    const role = REAL_ROW.has(cap) ? realBoardRole : boardRole;
    if (atLeastBoard(role, MIN_BOARD_ROLE[cap])) caps.add(cap);
  }
  return Object.freeze(caps);
}

// Why a capability is missing (for require()'s error), given the same inputs. Pure.
//   "hidden"     not visible (404)        "read_only"  allowed by role but the board is read-only (403 READ_ONLY_BOARD)
//   "real_row"   needs a real membership  "role"       role too low (403 FORBIDDEN)       "scope"  token can't do it
function missingReason(cap, { boardRole, realRole = null, readOnly = false, mode = "session" } = {}) {
  if (!boardRole) return "hidden";
  if (mode === "token" && !TOKEN_CAPS.has(cap)) return "scope";
  const role = REAL_ROW.has(cap) ? mapToday(realRole) : boardRole;
  if (!atLeastBoard(role, MIN_BOARD_ROLE[cap])) return REAL_ROW.has(cap) ? "real_row" : "role";
  if (readOnly && !READ_ONLY_KEEPS.has(cap)) return "read_only";
  return null;
}

module.exports = { CAP, ALL_CAPS, BOARD_ROLES, BOARD_RANK, MIN_BOARD_ROLE, REAL_ROW, READ_ONLY_KEEPS, TOKEN_CAPS, TODAY_TO_BOARD, mapToday, impliedBoardRole, atLeastBoard, isCap, capabilitiesFor, missingReason };
