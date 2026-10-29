// File compatibility for the attachment stage (Phase M4.1). Decides, from the inventory only (nothing downloaded),
// what will happen to each monday.com file. The decision is confirmed against the real bytes at import time (content
// signatures in files/file-types.js MIGRATION_TYPES); a mismatch quarantines the file instead of storing it.
//
//   store                 PDF / JPEG / PNG / WebP up to 10 MB — like a normal upload
//   store-oversized       the same types over 10 MB and up to the migration limit (ATTACHMENTS_MIGRATION_MAX_FILE_MB):
//                         only through the authorized migration path, flagged on the attachment
//   rename-jfif           JFIF is JPEG: stored unchanged as image/jpeg with a .jpg name (the original name is kept)
//   preserve-heic         the HEIC original is stored as a download-only file; a JPEG rendition can be added next to
//                         it later (conversion is a separate, approved step) — the original is never replaced
//   download-only         CSV: stored as a download, never shown in the page or interpreted
//   hold-too-large        above the migration limit: not imported, listed for a decision
//   quarantine            unknown type: not imported, listed
// OneDrive (and other non-asset) links are not files here: they stay as links in the record's migration metadata.
const { MAX_FILE_BYTES } = require("../../files/file-types");

const DIRECT = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

function classifyAsset({ name, extension, sizeBytes }, { migrationMaxBytes = 20 * 1024 * 1024 } = {}) {
  const ext = String(extension || (String(name || "").includes(".") ? String(name).split(".").pop() : "")).replace(/^\./, "").toLowerCase();
  const size = Number(sizeBytes) || 0;
  const base = String(name || "file").replace(/\.[^.]*$/, "") || "file";
  let r;
  if (DIRECT[ext]) r = { action: size > MAX_FILE_BYTES ? "store-oversized" : "store", type: DIRECT[ext], plannedName: name };
  else if (ext === "jfif") r = { action: "rename-jfif", type: "image/jpeg", plannedName: `${base}.jpg` };
  else if (ext === "heic" || ext === "heif") r = { action: "preserve-heic", type: "image/heic", plannedName: name };
  else if (ext === "csv") r = { action: "download-only", type: "text/csv", plannedName: name };
  else return { action: "quarantine", type: null, plannedName: name, reason: `unsupported type "${ext || "none"}"` };
  if (size > migrationMaxBytes) return { action: "hold-too-large", type: r.type, plannedName: r.plannedName, reason: `larger than the migration limit (${Math.round(migrationMaxBytes / 1048576)} MB)` };
  if (size > MAX_FILE_BYTES && r.action !== "store-oversized") r.oversized = true;
  if (r.action === "store-oversized") r.oversized = true;
  return r;
}

module.exports = { classifyAsset };
