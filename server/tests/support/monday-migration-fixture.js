// Synthetic Phase M1 extraction for the migration tests: a small board exercising every column rule, written to a
// temporary folder with a valid manifest (checksums, counts, COMPLETE). mutate(data, counts) changes it before writing.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const BOARD = "5176133833", SUBBOARD = "5176134016";
const cvs = (pairs) => pairs.map(([id, type, text, value, extra = {}]) => ({ id, type, text, value, ...extra }));
const columns = [
  { id: "name", title: "Name", type: "name", settings_str: "{}" },
  { id: "subitems", title: "Subitems", type: "subtasks", settings_str: JSON.stringify({ boardIds: [Number(SUBBOARD)] }) },
  { id: "status9__1", title: "Engineer", type: "status", settings_str: JSON.stringify({ labels: { 0: "Pat Fictional", 1: "VACANT - NL", 2: "Pat Fictional", 3: "pat fictional" } }) },
  { id: "fal_group3", title: "Machine Status", type: "status", settings_str: JSON.stringify({ labels: { 0: "FOR REPAIR", 1: "For Repair", 2: "WAREHOUSE", 3: "WAREHOUSE" }, labels_colors: { 0: { color: "#e2445c" }, 1: { color: "#fdab3d" } } }) },
  { id: "text", title: "Serial number", type: "text", settings_str: "{}" },
  { id: "date27", title: "Installation Date", type: "date", settings_str: "{}" },
  { id: "connect_boards9", title: "Account Name", type: "board_relation", settings_str: JSON.stringify({ boardIds: [3237396373] }) },
  { id: "mirror46", title: "Customer ID Code", type: "mirror", settings_str: JSON.stringify({ relation_column: { connect_boards9: true } }) },
  { id: "board_relation_self", title: "MINDRAY MACHINE", type: "board_relation", settings_str: JSON.stringify({ boardIds: [Number(BOARD)] }) },
  { id: "files1", title: "Installed Sticker Photo", type: "file", settings_str: "{}" },
  { id: "person", title: "People", type: "people", settings_str: "{}" },
  { id: "item_id", title: "Item ID", type: "item_id", settings_str: "{}" },
  { id: "pulse_log", title: "Creation Log", type: "creation_log", settings_str: "{}" },
  { id: "long_text__1", title: "Remarks", type: "long_text", settings_str: "{}" }
];
const subColumns = [{ id: "person", title: "Owner", type: "people", settings_str: "{}" }, { id: "status", title: "Status", type: "status", settings_str: JSON.stringify({ labels: { 0: "Working on it", 1: "Done" } }) }, { id: "date0", title: "Date", type: "date", settings_str: "{}" }];

function item(n, extra = {}) {
  const id = String(1000 + n);
  return {
    id, name: `Unit ${n}`, state: "active", created_at: `2024-01-0${(n % 9) + 1}T00:00:00Z`, updated_at: "2024-02-01T00:00:00Z", creator_id: "11", url: "x", group: { id: n % 2 ? "topics" : "new_group" }, board: { id: BOARD }, parent_item: null, subitems: [],
    column_values: cvs([
      ["subitems", "subtasks", "", null],
      ["status9__1", "status", n === 1 ? "VACANT - NL" : n === 2 ? "pat fictional" : n === 3 ? "" : "Pat Fictional", n === 3 ? JSON.stringify({ index: 7, changed_at: "x", post_id: null }) : JSON.stringify({ index: 0 })],
      ["fal_group3", "status", n === 4 ? "WAREHOUSE" : "For Repair", JSON.stringify({ index: n === 4 ? 3 : 1 })],
      ["text", "text", `SN-${n}`, JSON.stringify(`SN-${n}`)],
      ["date27", "date", n === 5 ? "2024-03-05 10:00" : "2024-03-05", JSON.stringify(n === 5 ? { date: "2024-03-05", time: "10:00:00" } : { date: "2024-03-05" })],
      ["connect_boards9", "board_relation", "", null, { linked_item_ids: n === 6 ? [] : ["900"], display_value: n === 6 ? "" : "Clinic A" }],
      ["mirror46", "mirror", "", null, { display_value: n === 7 ? "" : "C-001" }],
      ["board_relation_self", "board_relation", "", null, { linked_item_ids: n === 8 ? ["1001"] : [], display_value: n === 8 ? "Unit 1" : "" }],
      ["files1", "file", n === 9 ? "https://x/a.jpg" : "", n === 9 ? JSON.stringify({ files: [{ assetId: 555, name: "a.jpg", fileType: "ASSET", isImage: "true" }] }) : n === 10 ? JSON.stringify({ files: [] }) : null],
      ["person", "people", n === 11 ? "Ana" : "", n === 11 ? JSON.stringify({ personsAndTeams: [{ id: 12, kind: "person" }] }) : null],
      ["item_id", "item_id", id, null],
      ["pulse_log", "creation_log", "2024-01-01 00:00:00 UTC", JSON.stringify({ created_at: "2024-01-01" })],
      ["long_text__1", "long_text", n === 12 ? "Line 1\nLine 2" : "", n === 12 ? JSON.stringify({ text: "Line 1\nLine 2" }) : n === 13 ? JSON.stringify({ text: null, changed_at: "x" }) : null]
    ]),
    ...extra
  };
}

function fixture(mutate = () => {}) {
  const items = Array.from({ length: 14 }, (_, n) => item(n));
  items[2].subitems = [{ id: "2001" }, { id: "2002" }];
  const subitems = ["2001", "2002"].map((id, i) => ({ id, name: `Sub ${i}`, state: "active", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-02T00:00:00Z", creator_id: "12", board: { id: SUBBOARD }, parent_item: { id: "1002" }, subitems: [], _expected_parent_id: "1002",
    column_values: cvs([["person", "people", "", null], ["status", "status", "Done", JSON.stringify({ index: 1 })], ["date0", "date", "2024-04-01", JSON.stringify({ date: "2024-04-01" })]]) }));
  const updates = [
    { id: "u1", item_id: "1000", _source_item_id: "1000", body: "<p>Hello <b>team</b> &amp; <a class=\"user_mention_editor\" data-mention-type=\"User\" data-mention-id=\"12\">@Ana</a><script>alert(1)</script></p>", text_body: "", created_at: "2024-05-01T00:00:00Z", updated_at: "2024-05-01T00:00:00Z", creator_id: "12", creator: { id: "12", name: "Ana" }, assets: [{ id: "777", name: "r.pdf", file_extension: ".pdf", file_size: 1000 }], replies: [{ id: "r1", body: "<p>ok</p>", text_body: "ok", created_at: "2024-05-02T00:00:00Z", creator_id: "11", creator: { id: "11", name: "Ben" } }] },
    { id: "u2", item_id: "1001", _source_item_id: "1001", body: "<p>Status changed</p>", text_body: "Status changed", created_at: "2024-05-03T00:00:00Z", updated_at: "2024-05-03T00:00:00Z", creator_id: "-4", creator: null, assets: [], replies: [] },
    { id: "u3", item_id: "2001", _source_item_id: "2001", body: "", text_body: "", created_at: "2024-05-04T00:00:00Z", updated_at: "2024-05-04T00:00:00Z", creator_id: "99", creator: null, assets: [], replies: [] }
  ].map((u) => ({ edited_at: u.created_at, ...u }));
  const data = {
    "board-metadata.json": { id: BOARD, name: "Fictional Asset Register", description: "", state: "active", board_kind: "share", items_count: items.length, views: [{ id: "1", name: "Table", type: "TableBoardView", settings_str: "{}" }, { id: "2", name: "QA view", type: "TableBoardView", settings_str: "{}" }], owners: [{ id: "11" }], subscribers: [{ id: "12" }] },
    "groups.json": [{ id: "topics", title: "Installed", color: "#037f4c", position: "65536", archived: false }, { id: "new_group", title: "Warehouse", color: "#579bfc", position: "32768", archived: false }],
    "columns.json": structuredClone({ item_columns: columns, subitem_columns: subColumns }),
    "items.json": items, "subitems.json": subitems,
    "updates.json": { note: "", updates },
    "users.json": { users: [{ id: "11", name: "Ben", email: "ben@jarc.example.invalid", enabled: true, is_guest: false }, { id: "12", name: "Ana", email: "ana@gmail.com", enabled: true, is_guest: true }], teams: [], missing_user_ids: ["-4", "99"] },
    "attachments-manifest.json": { references: [{ asset_id: "555", name: "a.jpg", file_extension: ".jpg", file_size_bytes: 11 * 1024 * 1024, source: "item", item_id: "1009" }, { asset_id: "777", name: "r.pdf", file_extension: ".pdf", file_size_bytes: 1000, source: "update", item_id: "1000", update_id: "u1" }, { asset_id: "777", name: "r.pdf", file_extension: ".pdf", file_size_bytes: 1000, source: "item", item_id: "1000" }, { asset_id: "888", name: "p.heic", file_extension: "heic", file_size_bytes: 500, source: "item", item_id: "1010" }], files_column_references: [{ asset_id: "555", column_id: "files1", item_id: "1009" }], external_or_unmatched_file_references: [] },
    "relationships.json": { connect_boards_columns: [] }
  };
  data["updates.json"].updates[0].id = "3001"; data["updates.json"].updates[1].id = "3002"; data["updates.json"].updates[2].id = "3003";
  data["updates.json"].updates[0].replies[0].id = "3101";
  data["attachments-manifest.json"].references[1].update_id = "3001";
  const counts = { items: items.length, board_items_count: items.length, subitems: subitems.length, updates: 3, replies: 1 };
  mutate(data, counts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarc-mm-"));
  const files = {};
  for (const [name, value] of Object.entries(data)) { const text = `${JSON.stringify(value, null, 2)}\n`; fs.writeFileSync(path.join(dir, name), text); files[name] = { bytes: text.length, sha256: crypto.createHash("sha256").update(text).digest("hex") }; }
  fs.writeFileSync(path.join(dir, "extraction-manifest.json"), JSON.stringify({ source: { account: "jarcgroup.monday.com", board_id: BOARD }, extraction: { finished_at: "2026-10-28T04:00:00Z", api_version: { value: "2026-07" } }, counts, completeness: "COMPLETE", problems: [], errors: [], files }));
  return dir;
}

module.exports = { fixture, columns, subColumns, BOARD, SUBBOARD };
