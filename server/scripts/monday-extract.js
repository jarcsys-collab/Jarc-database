#!/usr/bin/env node
// Phase M1: read-only extraction of ONE monday.com board into a private local backup (monday-extraction/ at the
// repository root, ignored by Git and never copied into the Docker image). Nothing is written to monday.com, MongoDB or
// any other service: the script only sends GraphQL queries (every request is checked for "mutation" before it leaves),
// only to https://api.monday.com/v2, and only asks for board 5176133833, its items, their sub-items (by parent item),
// their updates/assets and the users referenced by them. Connected boards are recorded as IDs only, never followed.
//
//   node server/scripts/monday-extract.js --check     connection test only (Step 2); writes nothing
//   node server/scripts/monday-extract.js             full extraction (Steps 3-10, 12)
//     --overwrite        replace an earlier extraction in monday-extraction/
//     --max-calls N      stop (marked incomplete) after N API calls (default 2000; monday.com has daily call limits)
//
// The token comes from MONDAY_API_TOKEN in .env.monday at the repository root (ignored by Git and Docker) or from the
// environment. It is sent only in the Authorization header, never printed, and every output file is scanned for it.
// Terminal output is limited to counts and IDs: no names, emails or update contents.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MondayClient, API_URL } = require("../src/integrations/monday/client");

const BOARD_ID = "5176133833";
const ACCOUNT_SLUG = "jarcgroup";
const ROOT = path.resolve(__dirname, "../..");
const OUT = process.env.MONDAY_EXTRACTION_DIR ? path.resolve(process.env.MONDAY_EXTRACTION_DIR) : path.join(ROOT, "monday-extraction");
const ENV_FILE = path.join(ROOT, ".env.monday");
const ITEMS_PAGE = 100, SUBITEMS_BATCH = 100, DETAIL_BATCH = 25, UPDATES_PAGE = 100, USERS_BATCH = 100;

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check"), OVERWRITE = args.includes("--overwrite");
const maxCallsArg = args.includes("--max-calls") ? Number(args[args.indexOf("--max-calls") + 1]) : NaN;
const MAX_CALLS = maxCallsArg > 0 ? maxCallsArg : 2000;

// ---- credentials -------------------------------------------------------------------------------------------------
function readEnvFile() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(MONDAY_API_TOKEN|MONDAY_API_VERSION)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}
const fileEnv = readEnvFile();
const TOKEN = process.env.MONDAY_API_TOKEN || fileEnv.MONDAY_API_TOKEN || "";
const API_VERSION = process.env.MONDAY_API_VERSION || fileEnv.MONDAY_API_VERSION || null;
if (API_VERSION && !/^\d{4}-\d{2}$/.test(API_VERSION)) {
  // Never send a malformed value as a header: a token pasted on the wrong line would otherwise leave in API-Version.
  process.stdout.write("MONDAY_API_VERSION must look like 2026-07 (or be empty). Check that the token is on the MONDAY_API_TOKEN line. Nothing was requested.\n");
  process.exit(2);
}
const scrub = (s) => (TOKEN && typeof s === "string" ? s.split(TOKEN).join("[REDACTED]") : s);

// ---- transport: the existing client plus a guarded, observing fetch ------------------------------------------------
const stats = { calls: 0, minComplexityAfter: null, rateHeaders: {}, errors: [] };
const probe = { status: 0, errors: [] };
async function guardedFetch(url, opts) {
  if (url !== API_URL || !String(url).startsWith("https://")) throw new Error("Blocked request to an unexpected URL.");
  const { query } = JSON.parse(opts.body);
  if (/\bmutation\b/i.test(query) || !/^\s*query\b/.test(query)) throw new Error("Blocked: only read-only queries are allowed.");
  if (stats.calls >= MAX_CALLS) throw Object.assign(new Error("Call budget reached."), { budget: true });
  stats.calls += 1;
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  probe.status = res.status;
  probe.errors = (json?.errors || (json?.error_code ? [{ message: json.error_message, extensions: { code: json.error_code } }] : []))
    .map((e) => ({ code: e.extensions?.code || null, message: scrub(String(e.message || "")).slice(0, 300) }));
  for (const [k, v] of res.headers) if (/rate|limit|complexity|retry|api-version/i.test(k)) stats.rateHeaders[k] = scrub(v);
  return { ok: res.ok, status: res.status, headers: res.headers, json: async () => { if (json === null) throw new Error("not json"); return json; } };
}
const client = TOKEN ? new MondayClient({ token: TOKEN, apiVersion: API_VERSION, fetch: guardedFetch, timeoutMs: 60000 }) : null;

const COMPLEXITY = "complexity { before after reset_in_x_seconds }";
const SCHEMA_ERROR = /Cannot query field|Unknown argument|Unknown type|doesn't exist on type|is not defined|Field .* argument|undefinedField|argumentLiteralsIncompatible|GRAPHQL_VALIDATION_FAILED/i;
const chosen = {}; // name -> index of the query variant that worked, so later pages don't retry failing ones

async function run(query, variables) {
  try {
    const data = await client.query(query, variables);
    const c = data.complexity;
    if (c) {
      stats.minComplexityAfter = stats.minComplexityAfter === null ? c.after : Math.min(stats.minComplexityAfter, c.after);
      if (c.after < 500000 && c.reset_in_x_seconds > 0) { log(`  complexity budget low; pausing ${c.reset_in_x_seconds}s`); await sleep(c.reset_in_x_seconds * 1000 + 500); }
    }
    return data;
  } catch (error) {
    error.details = probe.errors.slice();
    throw error;
  }
}
// Try query variants in order (richest first) and fall back only on schema errors, i.e. fields the API version lacks.
async function runVariants(name, variants, variables, warnings) {
  for (let i = chosen[name] ?? 0; i < variants.length; i += 1) {
    try { const data = await run(variants[i], variables); if (chosen[name] !== i) { chosen[name] = i; if (i > 0) warnings.push(`${name}: used reduced field set #${i} (richer fields not available in this API version)`); } return data; }
    catch (error) {
      const schema = (error.details || []).some((e) => SCHEMA_ERROR.test(`${e.code} ${e.message}`));
      if (!schema || i === variants.length - 1) throw error;
      warnings.push(`${name}: variant #${i} rejected: ${(error.details || []).map((e) => e.message).join("; ").slice(0, 300)}`);
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stdout.write(`${msg}\n`);
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const parse = (s) => { if (typeof s !== "string" || !s) return null; try { return JSON.parse(s); } catch { return null; } };

// ---- field sets -----------------------------------------------------------------------------------------------------
const CV = [
  "id type text value ... on MirrorValue { display_value } ... on BoardRelationValue { linked_item_ids display_value } ... on DependencyValue { linked_item_ids display_value } ... on FormulaValue { display_value }",
  "id type text value ... on MirrorValue { display_value } ... on BoardRelationValue { linked_item_ids display_value } ... on DependencyValue { linked_item_ids display_value }",
  "id type text value"
];
const ITEM_BASE = ["id name state created_at updated_at creator_id url group { id } board { id } parent_item { id } subitems { id }", "id name state created_at updated_at creator_id group { id } board { id } parent_item { id } subitems { id }"];
const itemVariants = (cv) => ITEM_BASE.flatMap((base) => CV.map((c) => `${base} column_values { ${cv ? cv(c) : c} }`));
const ASSET = ["id name file_extension file_size url url_thumbnail created_at original_geometry uploaded_by { id }", "id name file_extension file_size url created_at uploaded_by { id }"];
const UPDATE = [
  (a) => `id item_id body text_body created_at updated_at edited_at creator_id creator { id name } assets { ${a} } replies { id body text_body created_at updated_at creator_id creator { id name } }`,
  (a) => `id item_id body text_body created_at updated_at creator_id creator { id name } assets { ${a} } replies { id body text_body created_at updated_at creator_id creator { id name } }`,
  () => "id item_id body text_body created_at updated_at creator_id replies { id body text_body created_at updated_at creator_id }"
];

// ---- steps ----------------------------------------------------------------------------------------------------------
async function connectionCheck() {
  const data = await run(`query ($ids: [ID!]) { ${COMPLEXITY} version { kind value } me { id account { id slug } } boards(ids: $ids) { id name state board_kind items_count } }`, { ids: [BOARD_ID] });
  const board = data.boards?.[0];
  const result = {
    apiVersion: data.version || null, accountId: data.me?.account?.id || null, accountSlug: data.me?.account?.slug || null, userId: data.me?.id || null,
    boardFound: Boolean(board), boardIdMatches: board?.id === BOARD_ID, boardName: board?.name || null, boardState: board?.state || null, boardKind: board?.board_kind || null,
    itemsCount: board?.items_count ?? null, complexity: data.complexity || null, rateHeaders: { ...stats.rateHeaders }
  };
  return result;
}

async function boardMetadata(warnings, errors) {
  const ids = { ids: [BOARD_ID] };
  const core = (await runVariants("board.core", [
    `query ($ids: [ID!]) { ${COMPLEXITY} boards(ids: $ids) { id name description state board_kind type permissions workspace_id workspace { id name kind } board_folder_id item_terminology items_count updated_at url communication top_group { id } tags { id name color } } }`,
    `query ($ids: [ID!]) { ${COMPLEXITY} boards(ids: $ids) { id name description state board_kind type permissions workspace_id board_folder_id items_count updated_at top_group { id } } }`
  ], ids, warnings)).boards?.[0];
  if (!core || core.id !== BOARD_ID) throw new Error("Board could not be identified.");
  const sections = {
    groups: ["groups { id title color position archived deleted }", "groups { id title color position }"],
    columns: ["columns { id title type description settings_str archived width }", "columns { id title type settings_str archived }"],
    views: ["views { id name type settings_str view_specific_data_str }", "views { id name type settings_str }"],
    owners: ["owners { id }"], subscribers: ["subscribers { id }"], team_owners: ["team_owners { id name }"], team_subscribers: ["team_subscribers { id name }"]
  };
  const meta = { ...core };
  for (const [key, variants] of Object.entries(sections)) {
    try { meta[key] = (await runVariants(`board.${key}`, variants.map((f) => `query ($ids: [ID!]) { ${COMPLEXITY} boards(ids: $ids) { ${f} } }`), ids, warnings)).boards?.[0]?.[key] ?? null; }
    catch (error) { meta[key] = null; (key === "groups" || key === "columns" ? errors : warnings).push(`board.${key} unavailable: ${error.code || error.message}${error.details?.length ? ` (${error.details.map((e) => e.message).join("; ")})` : ""}`); }
  }
  return meta;
}

async function allItems(warnings, errors) {
  const items = [], seen = new Set(), pages = [];
  let cursor = null, page = 0, complete = false;
  const first = itemVariants().map((f) => `query ($ids: [ID!], $limit: Int!) { ${COMPLEXITY} boards(ids: $ids) { items_page(limit: $limit) { cursor items { ${f} } } } }`);
  const next = itemVariants().map((f) => `query ($cursor: String!, $limit: Int!) { ${COMPLEXITY} next_items_page(cursor: $cursor, limit: $limit) { cursor items { ${f} } } }`);
  try {
    do {
      page += 1;
      const res = cursor ? (await runVariants("items.page", next, { cursor, limit: ITEMS_PAGE }, warnings)).next_items_page : (await runVariants("items.page", first, { ids: [BOARD_ID], limit: ITEMS_PAGE }, warnings)).boards?.[0]?.items_page;
      if (!res) throw new Error(`items page ${page} returned nothing`);
      let dup = 0;
      for (const it of res.items || []) { if (seen.has(it.id)) { dup += 1; continue; } seen.add(it.id); it._extraction_order = items.length; items.push(it); }
      pages.push({ page, count: (res.items || []).length, duplicates: dup, hasNext: Boolean(res.cursor) });
      if (dup) errors.push(`items page ${page}: ${dup} duplicate item(s) across pages`);
      log(`  items page ${page}: ${(res.items || []).length} (total ${items.length})`);
      cursor = res.cursor || null;
    } while (cursor);
    complete = true;
  } catch (error) { errors.push(`item pagination stopped at page ${page}: ${error.code || error.message}`); if (error.budget) errors.push("API call budget reached"); }
  return { items, pages, complete };
}

async function subitemsOf(items, warnings, errors) {
  const parentOf = new Map();
  for (const it of items) for (const s of it.subitems || []) parentOf.set(String(s.id), it.id);
  const ids = [...parentOf.keys()], out = [], columns = new Map(), failed = [];
  const variants = itemVariants((c) => `${c} column { id title type settings_str }`).map((f) => `query ($ids: [ID!], $limit: Int!) { ${COMPLEXITY} items(ids: $ids, limit: $limit) { ${f} } }`);
  for (const [i, batch] of chunk(ids, SUBITEMS_BATCH).entries()) {
    try {
      const list = (await runVariants("subitems", variants, { ids: batch, limit: SUBITEMS_BATCH }, warnings)).items || [];
      for (const s of list) {
        for (const cv of s.column_values || []) { if (cv.column && !columns.has(cv.id)) columns.set(cv.id, cv.column); delete cv.column; }
        s._expected_parent_id = parentOf.get(String(s.id));
        out.push(s);
      }
      const got = new Set(list.map((s) => s.id));
      for (const id of batch) if (!got.has(id)) failed.push(id);
      log(`  subitems batch ${i + 1}: ${list.length}/${batch.length}`);
    } catch (error) { failed.push(...batch); errors.push(`subitems batch ${i + 1} failed: ${error.code || error.message}`); }
  }
  if (failed.length) errors.push(`${failed.length} sub-item(s) referenced by parents could not be retrieved`);
  return { subitems: out, subitemColumns: [...columns.values()], missingSubitemIds: failed };
}

async function details(ids, warnings, errors) {
  const updates = [], assets = [], failed = [], more = [];
  const variants = [];
  for (const a of ASSET) for (const u of UPDATE) variants.push(`query ($ids: [ID!], $limit: Int!) { ${COMPLEXITY} items(ids: $ids, limit: $limit) { id assets(assets_source: all) { ${a} } updates(limit: ${UPDATES_PAGE}) { ${u(a)} } } }`);
  variants.push(`query ($ids: [ID!], $limit: Int!) { ${COMPLEXITY} items(ids: $ids, limit: $limit) { id assets { ${ASSET[1]} } updates(limit: ${UPDATES_PAGE}) { ${UPDATE[2]()} } } }`);
  const take = (itemId, list) => { for (const u of list || []) { u._source_item_id = itemId; updates.push(u); } };
  for (const [i, batch] of chunk(ids, DETAIL_BATCH).entries()) {
    try {
      const list = (await runVariants("details", variants, { ids: batch, limit: DETAIL_BATCH }, warnings)).items || [];
      const got = new Set();
      for (const it of list) {
        got.add(it.id);
        for (const a of it.assets || []) assets.push({ ...a, _source: "item", _item_id: it.id });
        take(it.id, it.updates);
        if ((it.updates || []).length === UPDATES_PAGE) more.push(it.id);
      }
      for (const id of batch) if (!got.has(id)) failed.push(id);
      if ((i + 1) % 10 === 0 || i === Math.ceil(ids.length / DETAIL_BATCH) - 1) log(`  details: ${Math.min((i + 1) * DETAIL_BATCH, ids.length)}/${ids.length} items, ${updates.length} updates so far`);
    } catch (error) { failed.push(...batch); errors.push(`details batch ${i + 1} failed: ${error.code || error.message}`); }
  }
  // Items with a full first page of updates: fetch further pages one item at a time.
  const pageVariants = variants.map((v) => v.replace(`updates(limit: ${UPDATES_PAGE})`, `updates(limit: ${UPDATES_PAGE}, page: $page)`).replace("$limit: Int!)", "$limit: Int!, $page: Int!)"));
  for (const id of more) {
    for (let page = 2; page < 1000; page += 1) {
      try {
        const it = (await runVariants("details.page", pageVariants, { ids: [id], limit: 1, page }, warnings)).items?.[0];
        take(id, it?.updates);
        if ((it?.updates || []).length < UPDATES_PAGE) break;
      } catch (error) { failed.push(id); errors.push(`updates page ${page} of item ${id} failed: ${error.code || error.message}`); break; }
    }
  }
  // Assets can appear on several items/pages; keep one row per (asset, owner).
  for (const u of updates) for (const a of u.assets || []) assets.push({ ...a, _source: "update", _update_id: u.id, _item_id: u._source_item_id });
  if (failed.length) errors.push(`${new Set(failed).size} item(s) whose updates/assets could not be fully retrieved`);
  return { updates, assets, failedDetailIds: [...new Set(failed)] };
}

async function usersAndTeams(userIds, teamIds, warnings, errors) {
  const users = [], teams = [];
  const fields = ["id name email title enabled is_guest is_admin is_view_only is_pending created_at", "id name email enabled is_guest is_admin"];
  for (const batch of chunk([...userIds], USERS_BATCH)) {
    try { users.push(...((await runVariants("users", fields.map((f) => `query ($ids: [ID!], $limit: Int!) { ${COMPLEXITY} users(ids: $ids, limit: $limit) { ${f} } }`), { ids: batch, limit: USERS_BATCH }, warnings)).users || [])); }
    catch (error) { errors.push(`users batch failed: ${error.code || error.message}`); }
  }
  const missing = [...userIds].filter((id) => !users.some((u) => String(u.id) === String(id)));
  for (const batch of chunk(missing, USERS_BATCH)) {
    try { users.push(...((await runVariants("users.inactive", fields.map((f) => `query ($ids: [ID!], $limit: Int!) { ${COMPLEXITY} users(ids: $ids, limit: $limit, non_active: true) { ${f} } }`), { ids: batch, limit: USERS_BATCH }, warnings)).users || [])); }
    catch (error) { warnings.push(`inactive users lookup failed: ${error.code || error.message}`); }
  }
  for (const batch of chunk([...teamIds], USERS_BATCH)) {
    try { teams.push(...((await run(`query ($ids: [ID!]) { ${COMPLEXITY} teams(ids: $ids) { id name } }`, { ids: batch })).teams || [])); }
    catch (error) { warnings.push(`teams lookup failed: ${error.code || error.message}`); }
  }
  const stillMissing = [...userIds].filter((id) => !users.some((u) => String(u.id) === String(id)));
  if (stillMissing.length) warnings.push(`${stillMissing.length} referenced user ID(s) not returned by the API (deleted or not visible)`);
  return { users, teams, missingUserIds: stillMissing };
}

// ---- analysis helpers -----------------------------------------------------------------------------------------------
const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", svg: "image/svg+xml", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", csv: "text/csv", txt: "text/plain", zip: "application/zip", mp4: "video/mp4", mov: "video/quicktime", msg: "application/vnd.ms-outlook", eml: "message/rfc822" };
const mimeOf = (ext) => MIME[String(ext || "").replace(/^\./, "").toLowerCase()] || null;

function peopleRefs(rows, userIds, teamIds) {
  for (const r of rows) {
    if (r.creator_id) userIds.add(String(r.creator_id));
    for (const cv of r.column_values || []) {
      if (cv.type !== "people" && cv.type !== "multiple-person") continue;
      for (const p of parse(cv.value)?.personsAndTeams || []) (p.kind === "team" ? teamIds : userIds).add(String(p.id));
    }
  }
}

function filesColumnRefs(rows, kind) {
  const out = [];
  for (const r of rows) for (const cv of r.column_values || []) {
    if (cv.type !== "file") continue;
    for (const f of parse(cv.value)?.files || []) out.push({ asset_id: f.assetId != null ? String(f.assetId) : null, name: f.name || null, file_type: f.fileType || null, is_image: f.isImage ?? null, link: f.fileType === "ASSET" ? null : (f.linkToFile || null), created_at: f.createdAt || null, created_by: f.createdBy || null, column_id: cv.id, owner_kind: kind, item_id: r.id });
  }
  return out;
}

function relationships(columns, subitemColumns, items, subitems) {
  const rel = { connect_boards_columns: [], mirror_columns: [], dependency_columns: [], subitems_columns: [], item_links: [] };
  for (const [scope, cols] of [["item", columns || []], ["subitem", subitemColumns || []]]) for (const c of cols) {
    const s = parse(c.settings_str) || {};
    const ref = { scope, column_id: c.id, title: c.title, type: c.type, linked_board_ids: (s.boardIds || (s.boardId ? [s.boardId] : [])).map(String) };
    if (c.type === "board_relation") rel.connect_boards_columns.push(ref);
    else if (c.type === "mirror" || c.type === "lookup") rel.mirror_columns.push({ ...ref, relation_column: s.relation_column || null, displayed_linked_columns: s.displayed_linked_columns || null });
    else if (c.type === "dependency") rel.dependency_columns.push(ref);
    else if (c.type === "subtasks") rel.subitems_columns.push(ref);
  }
  for (const [scope, rows] of [["item", items], ["subitem", subitems]]) for (const r of rows) for (const cv of r.column_values || []) {
    if ((cv.type === "board_relation" || cv.type === "dependency") && (cv.linked_item_ids || parse(cv.value)?.linkedPulseIds)) {
      const ids = cv.linked_item_ids || (parse(cv.value).linkedPulseIds || []).map((p) => p.linkedPulseId);
      if (ids.length) rel.item_links.push({ scope, item_id: r.id, column_id: cv.id, type: cv.type, linked_item_ids: ids.map(String) });
    }
  }
  return rel;
}

function columnProfile(columns, rows) {
  const prof = {};
  for (const c of columns || []) prof[c.id] = { title: c.title, type: c.type, filled: 0, empty: 0, has_raw_value: 0, has_text: 0, has_display_value: 0 };
  for (const r of rows) for (const cv of r.column_values || []) {
    const p = prof[cv.id] || (prof[cv.id] = { title: null, type: cv.type, filled: 0, empty: 0, has_raw_value: 0, has_text: 0, has_display_value: 0, not_in_board_columns: true });
    const filled = Boolean(cv.text || cv.value || cv.display_value || cv.linked_item_ids?.length);
    p[filled ? "filled" : "empty"] += 1; if (cv.value) p.has_raw_value += 1; if (cv.text) p.has_text += 1; if (cv.display_value) p.has_display_value += 1;
  }
  return prof;
}

// ---- output ---------------------------------------------------------------------------------------------------------
function writeJson(name, data, written) {
  const file = path.join(OUT, name), tmp = `${file}.tmp`;
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (TOKEN && text.includes(TOKEN)) throw new Error(`Refusing to write ${name}: it would contain the access token.`);
  fs.writeFileSync(tmp, text, "utf8"); fs.renameSync(tmp, file);
  written[name] = { bytes: Buffer.byteLength(text), sha256: crypto.createHash("sha256").update(text).digest("hex") };
}

// ---- main -----------------------------------------------------------------------------------------------------------
async function main() {
  if (!TOKEN) { log(`No MONDAY_API_TOKEN found (expected in ${path.relative(ROOT, ENV_FILE)} or the environment). Nothing was requested.`); process.exitCode = 2; return; }
  log(`Read-only connection test to ${API_URL} (board ${BOARD_ID})...`);
  const conn = await connectionCheck();
  log(`  API version: ${conn.apiVersion ? `${conn.apiVersion.value} (${conn.apiVersion.kind})` : "unknown"}${API_VERSION ? ` [requested ${API_VERSION}]` : ""}`);
  log(`  account: ${conn.accountSlug} (id ${conn.accountId}); token user id ${conn.userId}`);
  log(`  board found: ${conn.boardFound}; ID matches: ${conn.boardIdMatches}; name: ${conn.boardName ?? "-"}; state: ${conn.boardState ?? "-"}; kind: ${conn.boardKind ?? "-"}; items_count: ${conn.itemsCount ?? "-"}`);
  log(`  complexity: ${conn.complexity ? `before ${conn.complexity.before}, after ${conn.complexity.after}, resets in ${conn.complexity.reset_in_x_seconds}s` : "not reported"}`);
  if (Object.keys(conn.rateHeaders).length) log(`  rate/limit headers: ${JSON.stringify(conn.rateHeaders)}`);
  if (conn.accountSlug !== ACCOUNT_SLUG) { log(`STOP: token belongs to account "${conn.accountSlug}", expected "${ACCOUNT_SLUG}".`); process.exitCode = 3; return; }
  if (!conn.boardFound || !conn.boardIdMatches) { log("STOP: board 5176133833 is not accessible with this token."); process.exitCode = 3; return; }
  if (CHECK_ONLY) { log(`Connection test passed (${stats.calls} API call). Nothing was written.`); return; }

  if (fs.existsSync(path.join(OUT, "extraction-manifest.json")) && !OVERWRITE) { log("monday-extraction/ already holds an extraction; pass --overwrite to replace it."); process.exitCode = 4; return; }
  fs.mkdirSync(OUT, { recursive: true });
  const startedAt = new Date().toISOString(), warnings = [], errors = [], written = {};
  // Checkpoints: each stage is saved as soon as it finishes, under a manifest that stays INCOMPLETE until the end, so
  // an interrupted run keeps its finished data and can never be mistaken for a complete one.
  const checkpoint = (stage) => writeJson("extraction-manifest.json", { completeness: "INCOMPLETE", status: "in progress or interrupted", last_completed_stage: stage, started_at: startedAt, api_calls: stats.calls, warnings, errors, files: written }, {});
  checkpoint("none");

  log("Board structure..."); const meta = await boardMetadata(warnings, errors);
  log(`  groups ${meta.groups?.length ?? "?"}, columns ${meta.columns?.length ?? "?"}, views ${meta.views?.length ?? "?"}`);
  writeJson("board-metadata.json", { ...meta, groups: undefined, columns: undefined }, written); writeJson("groups.json", meta.groups || [], written); checkpoint("board");
  log("Items..."); const { items, pages, complete: itemsComplete } = await allItems(warnings, errors);
  writeJson("items.json", items, written); checkpoint(itemsComplete ? "items" : "items (partial)");
  const foreignItems = items.filter((it) => it.board && String(it.board.id) !== BOARD_ID).map((it) => it.id);
  log(`Sub-items (${items.reduce((n, it) => n + (it.subitems || []).length, 0)} referenced)...`); const { subitems, subitemColumns, missingSubitemIds } = await subitemsOf(items, warnings, errors);
  writeJson("subitems.json", subitems, written); writeJson("columns.json", { item_columns: meta.columns || [], subitem_columns: subitemColumns }, written); checkpoint("subitems");
  const subitemBoardIds = [...new Set(subitems.map((s) => s.board?.id).filter(Boolean).map(String))];
  log("Updates and assets..."); const { updates, assets, failedDetailIds } = await details([...items.map((i) => i.id), ...subitems.map((s) => s.id)], warnings, errors);
  writeJson("updates.json", { note: "partial checkpoint", updates }, written); checkpoint("updates");

  const userIds = new Set(), teamIds = new Set();
  peopleRefs(items, userIds, teamIds); peopleRefs(subitems, userIds, teamIds);
  for (const u of updates) { if (u.creator_id) userIds.add(String(u.creator_id)); for (const r of u.replies || []) if (r.creator_id) userIds.add(String(r.creator_id)); }
  for (const a of assets) if (a.uploaded_by?.id) userIds.add(String(a.uploaded_by.id));
  for (const k of ["owners", "subscribers"]) for (const u of meta[k] || []) userIds.add(String(u.id));
  log(`Users (${userIds.size}) and teams (${teamIds.size})...`); const { users, teams, missingUserIds } = await usersAndTeams(userIds, teamIds, warnings, errors);

  // Attachment inventory: assets (with sizes) merged with Files-column references.
  const fileRefs = [...filesColumnRefs(items, "item"), ...filesColumnRefs(subitems, "subitem")];
  const byKey = new Map();
  for (const a of assets) {
    const key = `${a.id}|${a._source}|${a._update_id || a._item_id}`;
    if (!byKey.has(key)) byKey.set(key, { asset_id: String(a.id), name: a.name, file_extension: a.file_extension, mime_type_inferred: mimeOf(a.file_extension), file_size_bytes: a.file_size ?? null, created_at: a.created_at || null, uploaded_by_id: a.uploaded_by?.id || null, original_geometry: a.original_geometry || null, source: a._source, item_id: a._item_id || null, update_id: a._update_id || null, has_url: Boolean(a.url) });
  }
  const assetIds = new Set(assets.map((a) => String(a.id)));
  const linkOnly = fileRefs.filter((f) => !f.asset_id || !assetIds.has(f.asset_id));
  const uniqueAssets = new Map(); for (const a of assets) if (!uniqueAssets.has(String(a.id))) uniqueAssets.set(String(a.id), a.file_size || 0);
  const attachments = { note: "Inventory only. No binaries were downloaded. Signed public URLs were deliberately not requested. MIME types are inferred from file extensions.", unique_asset_count: uniqueAssets.size, estimated_download_bytes: [...uniqueAssets.values()].reduce((s, n) => s + Number(n || 0), 0), references: [...byKey.values()], files_column_references: fileRefs, external_or_unmatched_file_references: linkOnly };

  // Verification (Step 12).
  const itemIds = new Set(items.map((i) => i.id)), subIds = new Set(subitems.map((s) => s.id));
  const replies = updates.flatMap((u) => (u.replies || []).map((r) => ({ ...r, _update_id: u.id })));
  const updateIds = updates.map((u) => u.id), replyIds = replies.map((r) => r.id);
  const colIds = new Set((meta.columns || []).map((c) => c.id));
  const checks = {
    items_pagination_complete: itemsComplete,
    items_count_matches_board: meta.items_count == null ? null : items.length === meta.items_count,
    item_ids_unique: itemIds.size === items.length,
    subitem_ids_unique: subIds.size === subitems.length,
    update_ids_unique: new Set(updateIds).size === updateIds.length,
    reply_ids_unique: new Set(replyIds).size === replyIds.length,
    items_missing_column_values: items.filter((i) => !Array.isArray(i.column_values) || [...colIds].some((id) => !i.column_values.some((cv) => cv.id === id) && !["name"].includes(id))).map((i) => i.id),
    subitems_wrong_parent: subitems.filter((s) => String(s.parent_item?.id) !== String(s._expected_parent_id) || !itemIds.has(String(s.parent_item?.id))).map((s) => s.id),
    subitems_missing: missingSubitemIds,
    updates_wrong_item: updates.filter((u) => u.item_id && String(u.item_id) !== String(u._source_item_id)).map((u) => u.id),
    updates_for_unknown_item: updates.filter((u) => !itemIds.has(u._source_item_id) && !subIds.has(u._source_item_id)).map((u) => u.id),
    details_failed_item_ids: failedDetailIds,
    items_from_other_boards: foreignItems,
    subitem_board_ids: subitemBoardIds,
    boards_touched: [BOARD_ID, ...subitemBoardIds]
  };
  const problems = [];
  if (!checks.items_pagination_complete) problems.push("item pagination incomplete");
  if (checks.items_count_matches_board === false) warnings.push(`items retrieved (${items.length}) differ from board items_count (${meta.items_count}); items_count may include archived/deleted items not returned by items_page`);
  for (const k of ["item_ids_unique", "subitem_ids_unique", "update_ids_unique", "reply_ids_unique"]) if (!checks[k]) problems.push(`${k} failed`);
  for (const k of ["items_missing_column_values", "subitems_wrong_parent", "subitems_missing", "updates_wrong_item", "updates_for_unknown_item", "details_failed_item_ids", "items_from_other_boards"]) if (checks[k].length) problems.push(`${k}: ${checks[k].length}`);

  const groups = meta.groups || [], columns = meta.columns || [];
  writeJson("board-metadata.json", { ...meta, groups: undefined, columns: undefined }, written);
  writeJson("groups.json", groups, written);
  writeJson("columns.json", { item_columns: columns, subitem_columns: subitemColumns }, written);
  writeJson("items.json", items, written);
  writeJson("subitems.json", subitems, written);
  writeJson("updates.json", { note: "body is monday.com's original HTML; text_body is monday.com's plain-text rendering. No sanitization applied.", updates }, written);
  writeJson("users.json", { users, teams, missing_user_ids: missingUserIds }, written);
  writeJson("attachments-manifest.json", attachments, written);
  writeJson("relationships.json", { note: "References only: linked boards and items were not queried.", ...relationships(columns, subitemColumns, items, subitems) }, written);

  const typeCounts = (cols) => cols.reduce((m, c) => ((m[c.type] = (m[c.type] || 0) + 1), m), {});
  const manifest = {
    source: { account: `${ACCOUNT_SLUG}.monday.com`, account_id: conn.accountId, board_id: BOARD_ID, board_name: meta.name, subitem_board_ids: subitemBoardIds },
    extraction: { started_at: startedAt, finished_at: new Date().toISOString(), script: "server/scripts/monday-extract.js", api_url: API_URL, api_version: conn.apiVersion, requested_api_version: API_VERSION, query_variants_used: chosen, api_calls: stats.calls, min_complexity_after: stats.minComplexityAfter, rate_limit_headers: stats.rateHeaders },
    counts: { groups: groups.length, columns: columns.length, subitem_columns: subitemColumns.length, views: meta.views?.length ?? null, items: items.length, board_items_count: meta.items_count ?? null, subitems: subitems.length, updates: updates.length, replies: replies.length, asset_references: attachments.references.length, unique_assets: attachments.unique_asset_count, files_column_references: fileRefs.length, users: users.length, teams: teams.length },
    column_types: { items: typeCounts(columns), subitems: typeCounts(subitemColumns) },
    column_profile: { items: columnProfile(columns, items), subitems: columnProfile(subitemColumns, subitems) },
    pagination: { items_complete: itemsComplete, items_pages: pages },
    verification: checks,
    not_extracted: ["Archived/deleted items (items_page returns active items only)", "Item position within groups (not exposed by the API; _extraction_order records API order)", "Attachment binaries (inventory only; awaiting approval)", "Linked items on connected boards (references only)", "Board activity log"],
    warnings, errors, problems,
    completeness: problems.length || errors.length ? "INCOMPLETE" : "COMPLETE",
    files: written
  };
  writeJson("extraction-manifest.json", manifest, {});
  // Final secret scan over every file in the output folder.
  for (const f of fs.readdirSync(OUT)) { const p = path.join(OUT, f); if (fs.statSync(p).isFile() && fs.readFileSync(p, "utf8").includes(TOKEN)) { log(`SECRET FOUND IN ${f} - deleting it.`); fs.rmSync(p); process.exitCode = 5; } }

  log(`\nDone in ${stats.calls} API calls. Completeness: ${manifest.completeness}`);
  log(`  groups ${groups.length} | columns ${columns.length} (+${subitemColumns.length} sub-item) | items ${items.length}/${meta.items_count ?? "?"} | subitems ${subitems.length} | updates ${updates.length} | replies ${replies.length} | asset refs ${attachments.references.length} (${attachments.unique_asset_count} unique, ~${(attachments.estimated_download_bytes / 1048576).toFixed(1)} MB) | users ${users.length}`);
  if (problems.length) log(`  problems: ${problems.join("; ")}`);
  if (errors.length) log(`  errors: ${errors.length} (see extraction-manifest.json)`);
  if (warnings.length) log(`  warnings: ${warnings.length} (see extraction-manifest.json)`);
}

main().catch((error) => {
  log(`FAILED: ${scrub(error.code ? `${error.code}: ${error.message}` : error.message)}`);
  for (const d of error.details || []) log(`  ${d.code || ""} ${d.message}`);
  process.exitCode = 1;
});
