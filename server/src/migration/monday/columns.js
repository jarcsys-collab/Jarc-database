// Column stage: one explicit decision for every source column, and the conversion of each cell. Nothing is dropped:
// a value JARC can hold natively is converted; a value it can't hold exactly (connected boards, mirrors, files,
// people without a verified JARC account, dates with a time) becomes readable text AND its raw monday.com value is
// preserved in the record's migration metadata, so it can be recovered later.
const { DIRECT, mapValue: mapDirectValue } = require("../../integrations/monday/mapping");
const { LIMITS } = require("../../domain/board-schema");

const parse = (s) => { if (typeof s !== "string" || !s) return null; try { return JSON.parse(s); } catch { return null; } };
const HEX = /^#[0-9a-f]{6}$/i;
const keyFor = (id) => `m_${String(id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60)}`;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Decisions taken for this migration (Phase M2, chosen by the board owner).
const DEFAULT_DECISIONS = Object.freeze({
  statusAsText: Object.freeze({ status9__1: "Engineer" }), // column ID → expected title; labels kept verbatim as text
  mirrors: "text-snapshot",
  connectedBoards: "text-snapshot-with-references",
  files: "file-names-as-text; binaries pending a separate attachment stage",
  people: "verified-mapping-only; otherwise historical name text",
  automationUpdates: "import-as-system-generated"
});

// Status labels in monday's index order, with colours. Exact duplicates are listed once (the raw label index is kept
// per cell for such columns); different spellings or capitalisation stay separate labels — nothing is normalised.
function statusLabels(column) {
  const s = parse(column.settings_str) || {};
  const entries = Object.entries(s.labels || {}).filter(([, n]) => typeof n === "string" && n.trim()).sort(([a], [b]) => Number(a) - Number(b));
  const options = [], colors = [], duplicates = [];
  for (const [index, name] of entries) {
    if (options.includes(name)) { duplicates.push(name); continue; }
    options.push(name);
    const c = s.labels_colors?.[index]?.color;
    colors.push(HEX.test(c || "") ? c : "");
  }
  return { options, colors: colors.some(Boolean) ? colors : null, duplicates };
}

// The column plan for a list of source columns. extra: columns to add after the primary one (companion board).
function planColumns(sourceColumns, { decisions = DEFAULT_DECISIONS, extra = [], extraAfter = [], withGroup = false, relationColumnIds = new Set() } = {}) {
  const columns = [], plan = [], errors = [];
  const used = new Set();
  const add = (col) => { used.add(col.key); columns.push(col); };
  const primary = sourceColumns.find((c) => c.type === "name");
  add({ key: "serial", label: clip(primary?.title || "Name", 200), type: "text", required: true });
  plan.push({ sourceColumnId: primary?.id || "name", title: primary?.title || "Name", sourceType: "name", handling: "primary", targetKey: "serial", targetType: "text", lossless: true });
  for (const c of extra) add(c);
  for (const [id, title] of Object.entries(decisions.statusAsText || {})) {
    const c = sourceColumns.find((x) => x.id === id);
    if (c && (c.type !== "status" || c.title !== title)) errors.push(`decision "statusAsText" expects column ${id} to be the status column "${title}", but it is ${c.type} "${c.title}"`);
  }
  for (const c of sourceColumns) {
    if (c.type === "name") continue;
    const s = parse(c.settings_str) || {};
    const entry = { sourceColumnId: c.id, title: c.title, sourceType: c.type };
    if (c.type === "subtasks") { plan.push({ ...entry, handling: "companion-board", targetKey: null, targetType: null, lossless: true, note: "Sub-items become records of the companion sub-items board, linked to their parent record." }); continue; }
    let key = keyFor(c.id); for (let i = 2; used.has(key); i += 1) key = `${keyFor(c.id).slice(0, 56)}_${i}`;
    const base = { key, label: clip(c.title || c.id, 200) };
    let col, handling, lossless = true, note = null;
    if (c.type === "status" && decisions.statusAsText?.[c.id]) {
      col = { ...base, type: "text", description: clip(`Original monday.com status labels, kept verbatim as text (column ${c.id}).`, 500) };
      handling = "status-labels-as-text"; note = "Labels kept exactly (names, duplicates, spelling, capitalisation, VACANT entries). Not interpreted as people.";
    } else if (c.type === "status") {
      const { options, colors, duplicates } = statusLabels(c);
      col = { ...base, type: "status", options, ...(colors ? { colors } : {}) };
      handling = "status"; if (duplicates.length) { lossless = false; note = `${duplicates.length} exact duplicate label(s) shown once; each cell's raw label index is preserved.`; }
    } else if (DIRECT[c.type] && !["status", "dropdown"].includes(c.type)) {
      col = { ...base, type: DIRECT[c.type] }; handling = c.type === "date" ? "date" : "direct";
      if (c.type === "date") note = "YYYY-MM-DD; any time of day is preserved in migration metadata.";
    } else if (c.type === "people" || c.type === "multiple-person") {
      col = { ...base, type: "owner" }; handling = "people"; lossless = false;
      note = "Verified JARC users only (confirmed mapping file); everyone else as historical name text. Raw person IDs preserved.";
    } else if (c.type === "mirror" || c.type === "lookup") {
      entry.via = Object.keys(s.relation_column || {});
      const via = entry.via.join(", ");
      col = { ...base, type: "text", description: clip(`Snapshot of monday.com mirror column ${c.id}${via ? ` (via ${via})` : ""} at extraction time. Editable; not live.`, 500) };
      handling = "mirror-snapshot"; lossless = false; note = "Displayed values only; no live link to the source board.";
    } else if (c.type === "board_relation") {
      const boards = (s.boardIds || []).map(String);
      col = { ...base, type: "text", description: clip(`Snapshot of monday.com connected items (column ${c.id}, board${boards.length > 1 ? "s" : ""} ${boards.join(", ")}). Linked item IDs are preserved in migration metadata.`, 500) };
      handling = relationColumnIds.has(c.id) ? "same-board-relation" : "connected-board-snapshot"; lossless = false;
      note = relationColumnIds.has(c.id) ? "Links point to records of this same board; resolved to JARC record IDs in migration metadata." : `Links to external board(s) ${boards.join(", ")} kept as monday.com item IDs; those boards are not migrated.`;
    } else if (c.type === "file") {
      col = { ...base, label: clip(`${c.title} (monday.com files, not migrated yet)`, 200), type: "text", description: clip(`File names from monday.com column ${c.id}. The files themselves are NOT stored in JARC yet; they need the separate attachment migration.`, 500) };
      handling = "files-pending"; lossless = false; note = "File names as text (kept), plus a native Files column that the attachment stage fills; asset references preserved.";
    } else if (["text", "long_text", "item_id", "creation_log"].includes(c.type)) {
      col = { ...base, type: "text" }; handling = c.type === "text" || c.type === "long_text" ? "direct" : `${c.type}-as-text`;
      if (c.type === "creation_log") note = "Also used for the record's creation time and creator attribution.";
    } else {
      col = { ...base, type: "text", description: clip(`monday.com ${c.type} column ${c.id}, imported as its displayed text. Raw value preserved in migration metadata.`, 500) };
      handling = "unsupported-as-text"; lossless = false; note = `Type "${c.type}" has no JARC equivalent.`;
    }
    add(col);
    // monday file columns also get a genuine JARC Files column beside the text snapshot (Phase M4.1): migrated files
    // are attached there, so the orphan sweep recognises them. The snapshot column is kept unchanged.
    let filesKey = null;
    if (handling === "files-pending") {
      filesKey = `${key.slice(0, 54)}_files`;
      for (let i = 2; used.has(filesKey); i += 1) filesKey = `${key.slice(0, 50)}_files${i}`;
      add({ key: filesKey, label: clip(c.title || c.id, 200), type: "files", description: clip(`Files from monday.com column ${c.id}. They appear here once the attachment migration has stored them.`, 500) });
    }
    plan.push({ ...entry, handling, targetKey: key, targetType: col.type, ...(filesKey ? { filesKey } : {}), lossless, ...(note ? { note } : {}) });
  }
  for (const c of extraAfter) add(c);
  if (withGroup) add({ key: "group", label: "Group", type: "group" });
  if (columns.length > LIMITS.columns) errors.push(`${columns.length} columns exceed JARC's limit of ${LIMITS.columns}`);
  return { columns, plan, errors };
}

// One cell → { value, preserved (raw source data to keep, or undefined), issue codes, relation }.
function mapCell(entry, column, cv, ctx) {
  const text = typeof cv?.text === "string" ? cv.text : "";
  const raw = parse(cv?.value);
  const out = { value: column.type === "owner" ? [] : "", preserved: undefined, issues: [] };
  switch (entry.handling) {
    case "status-labels-as-text": out.value = text; break;
    case "status": {
      out.value = text;
      if (text && !column.options.includes(text)) out.issues.push("status-value-not-in-labels");
      if (entry.lossless === false && raw && raw.index !== undefined) out.preserved = { index: raw.index };
      break;
    }
    case "date": {
      const d = raw?.date || "";
      if (d) out.value = d; else if (text.trim()) out.issues.push("date-unparseable");
      if (raw?.time) { out.preserved = { date: raw.date, time: raw.time }; out.issues.push("date-time-preserved-in-metadata"); }
      if (!d && text.trim()) out.preserved = { text, value: cv.value };
      break;
    }
    case "direct": {
      if (column.type === "text") out.value = text || (typeof raw?.text === "string" ? raw.text : "");
      else out.value = mapDirectValue(column.type, cv, column) ?? "";
      if (column.type !== "text" && text && (out.value === "" || out.value === false)) { out.issues.push("value-not-convertible"); out.preserved = { text, value: cv.value }; out.value = column.type === "checkbox" ? false : ""; }
      break;
    }
    case "people": {
      const people = Array.isArray(raw?.personsAndTeams) ? raw.personsAndTeams : [];
      const list = [];
      for (const p of people) {
        if (p?.kind === "team") { list.push(`monday.com team #${p.id}`); continue; }
        const a = ctx.identity.attribution(p?.id, "peopleCell");
        const entryText = a.jarcUserId ? `user:${a.jarcUserId}` : a.name || `monday.com user #${a.sourceUserId}`;
        if (!list.includes(entryText)) list.push(entryText);
        if (!a.jarcUserId) out.issues.push("person-unmapped");
      }
      out.value = list;
      if (people.length) out.preserved = { personsAndTeams: people.map((p) => ({ id: String(p.id), kind: p.kind })) };
      break;
    }
    case "mirror-snapshot": {
      out.value = typeof cv?.display_value === "string" && cv.display_value ? cv.display_value : text;
      // Missing = the extraction has no displayed value at all; empty = monday showed nothing (the linked item's field
      // is blank). Only the first is a gap; the second is reported as information.
      if (cv?.display_value == null && !text && ctx.hasRelationLink?.(entry)) out.issues.push("mirror-display-value-missing");
      else if (!out.value && ctx.hasRelationLink?.(entry)) out.issues.push("info:mirror-linked-value-empty");
      break;
    }
    case "same-board-relation":
    case "connected-board-snapshot": {
      out.value = typeof cv?.display_value === "string" && cv.display_value ? cv.display_value : text;
      const ids = (cv?.linked_item_ids || (raw?.linkedPulseIds || []).map((x) => x.linkedPulseId) || []).map(String);
      if (ids.length) out.preserved = { linkedItemIds: ids };
      if (ids.length && !out.value) out.issues.push("relation-display-value-missing");
      break;
    }
    case "files-pending": {
      const files = Array.isArray(raw?.files) ? raw.files : [];
      out.value = files.map((f) => String(f?.name || "").trim()).filter(Boolean).join("; ");
      if (files.length) out.preserved = { files: files.map((f) => ({ assetId: f.assetId != null ? String(f.assetId) : null, name: f.name ?? null, fileType: f.fileType ?? null, isImage: f.isImage ?? null, ...(f.fileType && f.fileType !== "ASSET" && f.linkToFile ? { link: f.linkToFile } : {}) })) };
      break;
    }
    case "item_id-as-text": out.value = text || String(ctx.itemId); break;
    case "creation_log-as-text": out.value = text; if (cv?.value) out.preserved = { value: cv.value }; break;
    default: out.value = text; if (cv?.value) out.preserved = { value: cv.value };
  }
  if (typeof out.value === "string" && out.value.length > LIMITS.valueLength) out.issues.push("value-too-long");
  // Never drop a raw value silently: if the cell has raw data but maps to nothing, keep the raw value verbatim
  // (e.g. a status pointing to a label that was deleted in monday.com, which monday shows as blank) — unless the raw
  // value is provably a cleared cell (empty text/list, or only the time it was cleared).
  const empty = Array.isArray(out.value) ? !out.value.length : out.value === "" || out.value === false || out.value == null;
  if (cv?.value && empty && out.preserved === undefined) {
    if (isClearedValue(raw)) out.issues.push("info:source-value-cleared");
    else { out.preserved = { value: cv.value }; out.issues.push(raw && raw.index !== undefined && entry.sourceType === "status" ? "info:status-label-deleted-in-source" : "info:raw-value-without-display-text"); }
  }
  return out;
}

const isClearedValue = (raw) => raw === "" || raw === null || (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).every((k) => k === "changed_at" || (k === "text" && (raw.text == null || String(raw.text).trim() === "")) || (k === "files" && Array.isArray(raw.files) && raw.files.length === 0)));

module.exports = { planColumns, mapCell, statusLabels, DEFAULT_DECISIONS, keyFor };
