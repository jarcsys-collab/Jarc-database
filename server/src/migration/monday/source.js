// Source stage: loads a Phase M1 extraction folder and checks it before anything is mapped. Read-only (files are only
// read, never changed) and offline. The extraction is treated as untrusted input: checksums must match the manifest,
// the manifest must say COMPLETE, every object must have the expected shape and IDs, and unsafe JSON keys are refused.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { assertSafeJson } = require("../../validation/common");

const FILES = ["board-metadata.json", "groups.json", "columns.json", "items.json", "subitems.json", "updates.json", "users.json", "attachments-manifest.json", "relationships.json"];
const MONDAY_ID = /^\d{1,20}$/;
const USER_ID = /^-?\d{1,20}$/; // negative IDs are monday.com's automation/integration actor
const COLUMN_ID = /^[A-Za-z0-9_]{1,100}$/;
const GROUP_ID = /^[A-Za-z0-9_]{1,100}$/;
const ISO = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

class SourceError extends Error { constructor(problems) { super(`The extraction can't be used: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}`); this.name = "SourceError"; this.problems = problems; } }

function loadExtraction(dir) {
  const problems = [];
  const read = (name) => fs.readFileSync(path.join(dir, name));
  if (!fs.existsSync(path.join(dir, "extraction-manifest.json"))) throw new SourceError(["extraction-manifest.json is missing"]);
  const manifestBytes = read("extraction-manifest.json");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.completeness !== "COMPLETE") problems.push(`the extraction is marked ${manifest.completeness || "unknown"}, not COMPLETE`);
  if ((manifest.problems || []).length || (manifest.errors || []).length) problems.push("the extraction manifest lists errors or problems");

  const data = {}, checksums = {};
  for (const name of FILES) {
    const expected = manifest.files?.[name];
    if (!expected || !fs.existsSync(path.join(dir, name))) { problems.push(`${name} is missing or not listed in the manifest`); continue; }
    const bytes = read(name), sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    checksums[name] = { expected: expected.sha256, actual: sha256, ok: sha256 === expected.sha256, bytes: bytes.length };
    if (sha256 !== expected.sha256) { problems.push(`${name} does not match its checksum (changed since extraction)`); continue; }
    const value = JSON.parse(bytes.toString("utf8"));
    try { assertSafeJson(value, { maxDepth: 40, label: name }); } catch (error) { problems.push(`${name}: ${error.message}`); continue; }
    data[name] = value;
  }
  if (problems.length) throw new SourceError(problems);

  const source = {
    manifest, manifestSha256: crypto.createHash("sha256").update(manifestBytes).digest("hex"), checksums,
    board: data["board-metadata.json"], groups: data["groups.json"], columns: data["columns.json"].item_columns, subitemColumns: data["columns.json"].subitem_columns,
    items: data["items.json"], subitems: data["subitems.json"], updates: data["updates.json"].updates, users: data["users.json"].users || [],
    teams: data["users.json"].teams || [], missingUserIds: data["users.json"].missing_user_ids || [], attachments: data["attachments-manifest.json"], relationships: data["relationships.json"]
  };
  checkShapes(source, problems);
  if (problems.length) throw new SourceError(problems.slice(0, 50));
  return source;
}

// Structural validation of every object the mapper will read. Problems here stop the migration (nothing is guessed).
function checkShapes(s, problems) {
  const add = (m) => { if (problems.length < 200) problems.push(m); };
  const boardId = String(s.manifest.source?.board_id || "");
  if (!MONDAY_ID.test(boardId) || String(s.board?.id) !== boardId) add("board ID in the metadata does not match the manifest");
  if (typeof s.board?.name !== "string" || !s.board.name.trim()) add("the board has no name");
  for (const [label, list] of [["groups", s.groups], ["columns", s.columns], ["subitem columns", s.subitemColumns], ["items", s.items], ["subitems", s.subitems], ["updates", s.updates], ["users", s.users]]) if (!Array.isArray(list)) add(`${label} is not a list`);
  if (problems.length) return;
  s.groups.forEach((g, i) => { if (!GROUP_ID.test(String(g?.id)) || typeof g.title !== "string") add(`group ${i + 1} has an invalid ID or title`); });
  for (const [label, cols] of [["column", s.columns], ["subitem column", s.subitemColumns]]) cols.forEach((c, i) => { if (!COLUMN_ID.test(String(c?.id)) || typeof c.type !== "string" || typeof c.title !== "string") add(`${label} ${i + 1} has an invalid ID, type or title`); });
  const checkItem = (it, label) => {
    if (!it || !MONDAY_ID.test(String(it.id))) return add(`${label} has an invalid ID`);
    if (typeof it.name !== "string") add(`${label} ${it.id} has no name`);
    if (!ISO(it.created_at) || !ISO(it.updated_at)) add(`${label} ${it.id} has invalid timestamps`);
    if (it.creator_id != null && !USER_ID.test(String(it.creator_id))) add(`${label} ${it.id} has an invalid creator ID`);
    if (!Array.isArray(it.column_values)) return add(`${label} ${it.id} has no column values`);
    for (const cv of it.column_values) {
      if (!COLUMN_ID.test(String(cv?.id)) || typeof cv.type !== "string") add(`${label} ${it.id} has an invalid column value`);
      for (const f of ["text", "value", "display_value"]) if (cv[f] != null && typeof cv[f] !== "string") add(`${label} ${it.id} column ${cv.id}: ${f} is not text`);
      if (cv.linked_item_ids != null && (!Array.isArray(cv.linked_item_ids) || !cv.linked_item_ids.every((x) => MONDAY_ID.test(String(x))))) add(`${label} ${it.id} column ${cv.id}: invalid linked item IDs`);
    }
  };
  s.items.forEach((it, i) => { checkItem(it, `item ${i + 1}`); if (it && !GROUP_ID.test(String(it.group?.id))) add(`item ${it?.id} has no valid group`); if (it?.board && String(it.board.id) !== boardId) add(`item ${it.id} belongs to another board`); });
  s.subitems.forEach((it, i) => { checkItem(it, `subitem ${i + 1}`); if (!MONDAY_ID.test(String(it?.parent_item?.id))) add(`subitem ${it?.id} has no valid parent`); });
  s.updates.forEach((u, i) => {
    if (!u || !MONDAY_ID.test(String(u.id))) return add(`update ${i + 1} has an invalid ID`);
    if (!MONDAY_ID.test(String(u._source_item_id))) add(`update ${u.id} has no source item`);
    if (!ISO(u.created_at)) add(`update ${u.id} has an invalid timestamp`);
    if (u.creator_id != null && !USER_ID.test(String(u.creator_id))) add(`update ${u.id} has an invalid author ID`);
    for (const f of ["body", "text_body"]) if (u[f] != null && typeof u[f] !== "string") add(`update ${u.id}: ${f} is not text`);
    for (const r of u.replies || []) if (!MONDAY_ID.test(String(r?.id)) || !ISO(r.created_at)) add(`a reply of update ${u.id} is invalid`);
  });
  s.users.forEach((u, i) => { if (!USER_ID.test(String(u?.id))) add(`user ${i + 1} has an invalid ID`); });
}

module.exports = { loadExtraction, SourceError, FILES, MONDAY_ID, USER_ID };
