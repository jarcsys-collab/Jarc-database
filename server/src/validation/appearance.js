// Appearance values (Phase 9C).
//
// Icons (workspaces, boards — shared data) are stored as plain identifiers, never markup or SVG:
//   ""                 the default icon
//   "icon:<name>"      a curated icon (lowercase letters, digits, hyphens; the browser draws only names it knows)
//   an emoji           1 emoji (incl. skin tones, ZWJ sequences, flags, keycaps), at most 16 UTF-16 units
//   1–4 characters     the original short icons (e.g. "D", "OP", "#"); no spaces, markup characters or backslashes
// Browsers render every icon as text or from their own icon set, so nothing stored here can run.
//
// Personal appearance (users.preferences.appearance): theme, palette, accent, density, recentIcons.
const { fail, allowOnly, isObject } = require("./common");

const ICON_NAME = /^icon:[a-z][a-z0-9-]{0,29}$/;
// Short legacy icons (a workspace's first character, "D", "&", …): any 1–4 visible characters except angle brackets,
// backticks and backslashes — the old rule accepted any 4 characters, and icons are always HTML-escaped when shown, so
// "&", quotes and other punctuation stay valid for existing data (a duplicated board keeps its icon).
const LEGACY = /^[^\s<>`\\\p{Cc}]{1,4}$/u;
// Emoji sequences only: pictographs, regional-indicator flags and keycaps, joined by ZWJ / variation selectors /
// skin tones / tag characters.
const EMOJI = /^(?:[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}#*0-9⃣‍️\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}])+$/u;
const HAS_PICTURE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}⃣]/u;

function iconValue(value, label = "icon") {
  if (value === null || value === "") return "";
  if (typeof value !== "string") fail(`${label} must be text.`);
  const v = value.trim();
  if (!v) return "";
  if (ICON_NAME.test(v)) return v;
  if (v.length <= 16 && EMOJI.test(v) && HAS_PICTURE.test(v)) return v;
  if (LEGACY.test(v)) return v;
  fail(`${label} must be an icon from the picker, a single emoji, or up to 4 letters.`);
}

const THEMES = ["dark", "light", "system"];
const PALETTES = ["default", "midnight", "slate", "warm"];
const DENSITIES = ["compact", "comfortable", "spacious"];
const HEX = /^#[0-9a-f]{6}$/i;

function appearance(raw) {
  if (!isObject(raw)) fail("appearance must be an object.");
  allowOnly(raw, ["theme", "palette", "accent", "density", "recentIcons"], "appearance");
  const out = {};
  if (raw.theme !== undefined) { if (!THEMES.includes(raw.theme)) fail(`theme must be one of ${THEMES.join(", ")}.`); out.theme = raw.theme; }
  if (raw.palette !== undefined) { if (!PALETTES.includes(raw.palette)) fail(`palette must be one of ${PALETTES.join(", ")}.`); out.palette = raw.palette; }
  if (raw.accent !== undefined) { if (typeof raw.accent !== "string" || !HEX.test(raw.accent)) fail("accent must be a colour such as #0f9489."); out.accent = raw.accent.toLowerCase(); }
  if (raw.density !== undefined) { if (!DENSITIES.includes(raw.density)) fail(`density must be one of ${DENSITIES.join(", ")}.`); out.density = raw.density; }
  if (raw.recentIcons !== undefined) {
    if (!Array.isArray(raw.recentIcons) || raw.recentIcons.length > 16) fail("recentIcons must be a list of at most 16 icons.");
    out.recentIcons = [...new Set(raw.recentIcons.map((v) => iconValue(v, "A recent icon")).filter(Boolean))];
  }
  return out;
}

module.exports = { iconValue, appearance, THEMES, PALETTES, DENSITIES };
