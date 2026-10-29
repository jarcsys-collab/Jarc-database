// monday.com Update bodies are HTML. JARC comments are plain text that browsers render escaped, so the migration only
// ever produces text: tags are removed (never interpreted), script/style contents are dropped, entities are decoded,
// and control characters are stripped. The result is then held to the same rules as a typed comment (cleanBody).
// @mentions stay readable as "@Name" text, and their monday user IDs are collected as references only.
const NAMED = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", deg: "°" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e.toLowerCase()) ? NAMED[e.toLowerCase()] : m;
  });
}

function htmlToText(html) {
  if (typeof html !== "string" || !html) return "";
  let s = html.slice(0, 200000);
  s = s.replace(/<(script|style|template|iframe|object|embed|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<(script|style|template|iframe|object|embed|svg|math)\b[^>]*>/gi, ""); // unclosed
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<li\b[^>]*>/gi, "\n• ").replace(/<\/li\s*>/gi, "").replace(/<\/(p|div|ul|ol|h[1-6]|tr|blockquote|pre)\s*>/gi, "\n").replace(/<\/t[dh]\s*>/gi, "\t");
  s = s.replace(/<img\b[^>]*>/gi, "[image]");
  s = s.replace(/<\/?[a-z][^>]*>/gi, "").replace(/<\/?[a-z]*\b[^>]*$/i, "");
  return normalizeText(decodeEntities(s));
}

function normalizeText(s) {
  return String(s).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/[ \t ]+\n/g, "\n").replace(/[  ]{2,}/g, " ").replace(/\n{4,}/g, "\n\n\n").trim();
}

// monday mention markup: <a ... data-mention-type="User" data-mention-id="123">@Name</a>
function mentionIds(html) {
  const ids = new Set();
  if (typeof html !== "string") return [];
  for (const m of html.matchAll(/data-mention-id\s*=\s*["']?(-?\d{1,20})["']?/gi)) ids.add(m[1]);
  return [...ids];
}

module.exports = { htmlToText, normalizeText, decodeEntities, mentionIds };
