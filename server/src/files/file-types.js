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
function cleanFileName(raw, type) {
  let name = String(raw ?? "");
  try { name = decodeURIComponent(name); } catch { /* keep as sent */ }
  name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/[​-‏‪-‮⁦-⁩﻿]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (!name) return null;
  const ext = (name.includes(".") ? name.split(".").pop() : "").toLowerCase();
  const allowed = TYPES[type]?.extensions || [];
  if (!allowed.includes(ext)) name = `${name}.${allowed[0]}`;
  if (name.length > 200) { const suffix = name.slice(name.lastIndexOf(".")); name = name.slice(0, 200 - suffix.length) + suffix; }
  return name;
}

module.exports = { TYPES, MAX_FILE_BYTES, MAX_FILES_PER_CELL, SNIFF_BYTES, cleanFileName };
