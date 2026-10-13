// monday.com → JARC column and value mapping (one-way). Supported types map to the matching JARC type; types with a
// readable text form are imported as Text; the rest (files, subitems, buttons, docs, connections) are not imported.
// The item name becomes JARC's Item column; monday groups become the board's groups.
const DIRECT = Object.freeze({ text: "text", long_text: "text", numbers: "number", status: "status", dropdown: "dropdown", date: "date", email: "email", phone: "phone", link: "link", checkbox: "checkbox" });
const AS_TEXT = new Set(["people", "person", "multiple-person", "timeline", "tags", "country", "location", "hour", "week", "rating", "item_id", "auto_number", "creation_log", "last_updated", "formula", "mirror", "lookup", "world_clock", "color_picker", "progress", "vote", "time_tracking", "name"]);
const SKIPPED = new Set(["file", "subtasks", "subitems", "button", "doc", "direct_doc", "board_relation", "dependency", "integration"]);

const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const safeKey = (id) => `m_${String(id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}`;
const HEX = /^#[0-9a-f]{6}$/i;

// Status / dropdown labels from settings_str, in monday's order, with colours where given.
function labelsOf(column) {
  const s = parse(column.settings_str) || {};
  if (column.type === "status") {
    const entries = Object.entries(s.labels || {}).filter(([, name]) => typeof name === "string" && name.trim()).sort(([a], [b]) => Number(a) - Number(b));
    return entries.map(([index, name]) => ({ name: name.trim().slice(0, 200), color: HEX.test(s.labels_colors?.[index]?.color || "") ? s.labels_colors[index].color : "" }));
  }
  if (column.type === "dropdown") return (Array.isArray(s.labels) ? s.labels : []).map((l) => ({ name: String(l?.name || "").trim().slice(0, 200), color: "" })).filter((l) => l.name);
  return [];
}

// The JARC columns for a monday board, and how each monday column was handled (for the import preview).
function mapColumns(board) {
  const columns = [{ key: "serial", label: "Item", type: "text", required: true }];
  const plan = [{ sourceId: "name", title: "Name", sourceType: "name", targetKey: "serial", targetType: "text", handling: "imported" }];
  const used = new Set(["serial"]);
  for (const c of board.columns || []) {
    if (c.type === "name" || c.id === "name") continue;
    if (SKIPPED.has(c.type)) { plan.push({ sourceId: c.id, title: c.title, sourceType: c.type, targetKey: null, targetType: null, handling: "skipped" }); continue; }
    const type = DIRECT[c.type] || (AS_TEXT.has(c.type) ? "text" : "text");
    let key = safeKey(c.id); for (let i = 2; used.has(key); i += 1) key = `${safeKey(c.id).slice(0, 38)}_${i}`;
    used.add(key);
    const column = { key, label: String(c.title || c.id).slice(0, 200) || key, type };
    if (type === "status" || type === "dropdown") { const labels = labelsOf(c); column.options = labels.map((l) => l.name); if (labels.some((l) => l.color)) column.colors = labels.map((l) => l.color); }
    if (type === "dropdown") column.multiple = true;
    columns.push(column);
    plan.push({ sourceId: c.id, title: c.title, sourceType: c.type, targetKey: key, targetType: type, handling: DIRECT[c.type] ? "imported" : "imported as text" });
  }
  if ((board.groups || []).length) columns.push({ key: "group", label: "Group", type: "group" });
  return { columns, plan };
}

// One monday column value → a JARC value for the mapped column (or undefined to leave it empty).
function mapValue(targetType, cv, column) {
  const text = typeof cv?.text === "string" ? cv.text.trim() : "";
  const value = parse(cv?.value);
  switch (targetType) {
    case "number": { const n = Number(String(text).replace(/,/g, "")); return text !== "" && Number.isFinite(n) ? String(n) : ""; }
    case "date": { const d = value?.date || text.slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d : ""; }
    case "checkbox": return value?.checked === true || value?.checked === "true";
    case "email": { const e = value?.email || text; return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || "") ? e.slice(0, 320) : ""; }
    case "phone": return String(value?.phone || text).slice(0, 100);
    case "link": { const u = value?.url || text; return /^https?:\/\/\S+$/i.test(u || "") ? u.slice(0, 2000) : ""; }
    case "status": return text.slice(0, 200);
    case "dropdown": { const list = text ? [...new Set(text.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 100) : []; return column?.multiple ? list : list[0] || ""; }
    default: return text.slice(0, 10000);
  }
}

// A monday item → JARC record values, using the column plan of its board.
function mapItem(item, plan, columns) {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const values = { serial: String(item.name || "Untitled").slice(0, 10000) };
  for (const p of plan) {
    if (!p.targetKey || p.targetKey === "serial") continue;
    const cv = (item.column_values || []).find((v) => v.id === p.sourceId);
    values[p.targetKey] = mapValue(p.targetType, cv, byKey.get(p.targetKey));
  }
  return values;
}

module.exports = { mapColumns, mapItem, mapValue, labelsOf, DIRECT, AS_TEXT, SKIPPED };
