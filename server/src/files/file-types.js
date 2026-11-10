// Files column: what may be uploaded, recognised by content (file signature), not by name or declared type alone.
// PDF, JPEG, PNG and WebP only; at most 10 MB each and 20 per cell.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_CELL = 20;
const SNIFF_BYTES = 12;

const TYPES = Object.freeze({
  "application/pdf": { label: "PDF", extensions: ["pdf"], matches: (b) => b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-" },
  "image/jpeg": { label: "JPEG", extensions: ["jpg", "jpeg"], matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { label: "PNG", extensions: ["png"], matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/webp": { label: "WebP", extensions: ["webp"], matches: (b) => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" }
});

// A safe display/download name: no folders, no control or reserved characters, no invisible direction overrides
// (which can make "report<U+202E>fdp.exe" look like a PDF), at most 200 characters, and an
// extension that matches the file's type. Returns null when nothing usable is left.
// Migration only (never accepted by the upload API): files carried over from monday.com that JARC stores and offers
// as downloads but never shows in the page. CSV is checked to be text (no NUL bytes in its first bytes); HEIC by its
// ISO-BMFF "ftyp" brand. HEIC originals are preserved; a JPEG rendition can be added next to them later.
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
const MIGRATION_TYPES = Object.freeze({
  ...TYPES,
  "text/csv": { label: "CSV", extensions: ["csv"], downloadOnly: true, matches: (b) => b.length > 0 && !b.includes(0x00) },
  "image/heic": { label: "HEIC", extensions: ["heic", "heif"], downloadOnly: true, matches: (b) => b.length >= 12 && b.subarray(4, 8).toString("latin1") === "ftyp" && HEIC_BRANDS.has(b.subarray(8, 12).toString("latin1")) }
});

function cleanFileName(raw, type, types = TYPES) {
  let name = String(raw ?? "");
  try { name = decodeURIComponent(name); } catch { /* keep as sent */ }
  name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/[​-‏‪-‮⁦-⁩﻿]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (!name) return null;
  const ext = (name.includes(".") ? name.split(".").pop() : "").toLowerCase();
  const allowed = types[type]?.extensions || [];
  if (!allowed.includes(ext)) name = `${name}.${allowed[0]}`;
  if (name.length > 200) { const suffix = name.slice(name.lastIndexOf(".")); name = name.slice(0, 200 - suffix.length) + suffix; }
  return name;
}

// What the monday.com migration does with each file, from its inventory entry (see migration/monday/compat.js for the
// actions). Used by the migration tool and by the server's Machine Installation Database import.
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

module.exports = { TYPES, MIGRATION_TYPES, MAX_FILE_BYTES, MAX_FILES_PER_CELL, SNIFF_BYTES, cleanFileName, classifyAsset };
