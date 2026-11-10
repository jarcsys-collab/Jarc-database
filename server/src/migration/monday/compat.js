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
// The rules themselves live in files/file-types.js, so the JARC server can use them without loading the migration tool.
const { classifyAsset } = require("../../files/file-types");

module.exports = { classifyAsset };
