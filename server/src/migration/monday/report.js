// Report stage: private, local files describing a dry run. Issue lists carry codes and source IDs only, never record
// contents. The user-mapping template is the one file with names and emails (needed to verify people) and stays local.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { BATCH_SIZE, PRODUCTION_EXECUTION_ENABLED, SCOPE } = require("./executor");
const approvalTemplate = (planDigest) => ({ kind: "monday-migration-approval", version: 2, scope: "local-test", planDigest, targetDatabase: "<jarc_migration_test…>", targetInstanceId: "<local test instance ID>", targetWorkspaceId: "<24-hex workspace ID>", approvedBy: "<name>", operator: "<OS user running the import>", approvedAt: "<ISO date>", expiresAt: "<ISO date, at most 24 h later>", include: [...SCOPE], expectedCounts: "<from the dry-run report>", nonce: crypto.randomUUID() });
const WRITES_LOCKED = !PRODUCTION_EXECUTION_ENABLED;

const MB = 1048576;
const bytesOf = (docs) => docs.reduce((s, d) => s + Buffer.byteLength(JSON.stringify(d)), 0);

function columnMatrix(plan, records, columns, columnPlan) {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  return columnPlan.map((p) => {
    const filled = p.targetKey ? records.filter((r) => { const v = r.values[p.targetKey]; return Array.isArray(v) ? v.length : v !== "" && v != null && v !== false; }).length : null;
    const col = p.targetKey ? byKey.get(p.targetKey) : null;
    const classification = p.handling === "companion-board" ? "requires transformation (companion board)" : p.lossless === false ? (["mirror-snapshot", "connected-board-snapshot", "files-pending"].includes(p.handling) ? "cannot be preserved exactly (snapshot + raw references)" : "requires transformation (raw value preserved)") : p.handling === "direct" || p.handling === "primary" || p.handling === "status" ? "directly supported" : "requires transformation";
    return { sourceColumnId: p.sourceColumnId, title: p.title, sourceType: p.sourceType, handling: p.handling, targetKey: p.targetKey, targetType: p.targetType, ...(col?.options ? { options: col.options.length } : {}), filled, classification, ...(p.note ? { note: p.note } : {}) };
  });
}

function viewCategories(views) {
  const cat = (v) => v.type === "TableBoardView" ? (v.name === "Table" ? "default table (likely duplicate)" : "named table view") : v.type === "FeatureBoardView" ? "form / app view" : v.type === "MapBoardView" ? "map" : v.type === "SppBoardView" ? "app view" : "dashboard / report / gallery";
  const rows = views.map((v) => ({ sourceViewId: v.sourceViewId, name: v.name, type: v.type, category: cat(v), settingsAvailable: Boolean(v.settings && v.settings !== "{}") }));
  const recreate = rows.filter((r) => r.category === "named table view").map((r) => r.name);
  return { total: rows.length, byCategory: rows.reduce((m, r) => ((m[r.category] = (m[r.category] || 0) + 1), m), {}), recommendedForManualRecreation: recreate, rows };
}

function writeReports(outDir, { source, plan, validation, digest }) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = {};
  const write = (name, data) => {
    const text = typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`;
    const file = path.join(outDir, name), tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, "utf8"); fs.renameSync(tmp, file);
    written[name] = { bytes: Buffer.byteLength(text), sha256: crypto.createHash("sha256").update(text).digest("hex") };
  };
  const identity = plan.identity.report();
  const mainMatrix = columnMatrix(plan, plan.records, plan.board.columns, plan.columnPlan.main);
  const subMatrix = columnMatrix(plan, plan.subRecords, plan.subBoard.columns, plan.columnPlan.subitems);
  const { references, ...attach } = validation.attachments;
  const views = viewCategories(plan.board.migration.views);
  const comments = plan.comments;
  const replies = comments.filter((c) => c.parentId);
  const mirrorCols = mainMatrix.filter((m) => m.handling === "mirror-snapshot");
  const engineer = mainMatrix.filter((m) => m.handling === "status-labels-as-text");
  const byCode = (level) => validation[level].reduce((m, i) => ((m[i.code] = (m[i.code] || 0) + 1), m), {});
  const estimate = { boards: 2, records: plan.records.length + plan.subRecords.length, comments: comments.length, mappings: plan.mappings.length, approxDocumentMB: +((bytesOf(plan.records) + bytesOf(plan.subRecords) + bytesOf(comments) + bytesOf(plan.mappings)) / MB).toFixed(1), attachmentMBIfMigrated: attach.totalMB, batchesAtExecution: Math.ceil(plan.records.length / BATCH_SIZE) + Math.ceil(plan.subRecords.length / BATCH_SIZE) + 1 };

  const report = {
    kind: "monday-migration-dry-run", status: validation.ok ? "PASSED (no blocking errors)" : "FAILED (blocking errors)", databaseWrites: 0, networkRequests: 0, productionExecutionLocked: WRITES_LOCKED,
    planDigest: digest, runId: plan.runId,
    source: { account: plan.board.migration.account, boardId: plan.board.migration.sourceBoardId, boardName: plan.board.migration.sourceBoardName, extractedAt: plan.board.migration.extractedAt, apiVersion: plan.board.migration.apiVersion, manifestSha256: source.manifestSha256, completeness: source.manifest.completeness, checksums: Object.fromEntries(Object.entries(source.checksums).map(([k, v]) => [k, v.ok ? "verified" : "MISMATCH"])) },
    expectedVsPlanned: { expected: { items: source.manifest.counts.items, subitems: source.manifest.counts.subitems, updates: source.manifest.counts.updates, replies: source.manifest.counts.replies }, planned: validation.counts },
    destination: {
      board: { name: plan.board.name, legacyId: plan.board.legacyId, id: plan.board._id.toHexString(), columns: plan.board.columns.length, groups: plan.board.groups.length, editable: plan.board.source === undefined },
      subitemsBoard: { name: plan.subBoard.name, legacyId: plan.subBoard.legacyId, id: plan.subBoard._id.toHexString(), columns: plan.subBoard.columns.length },
      groups: plan.board.migration.groups.map((g, i) => ({ order: i + 1, sourceGroupId: g.sourceGroupId, groupId: g.groupId, title: g.title, records: plan.records.filter((r) => r.groupId === g.groupId).length })),
      workspace: "chosen at execution (approval file)"
    },
    items: { planned: plan.records.length, withSubitems: plan.records.filter((r) => r.migration.subitemSourceIds.length).length, withPreservedRawValues: plan.records.filter((r) => Object.keys(r.migration.preserved).length).length, withSameBoardLinks: plan.records.filter((r) => r.migration.relations.length).length, sameBoardLinks: validation.relationLinks, sameBoardLinksUnresolved: validation.relationUnresolved },
    subitems: { planned: plan.subRecords.length, parents: new Set(plan.subRecords.map((s) => s.migration.parent.sourceItemId)).size, parentsResolved: plan.subRecords.filter((s) => s.migration.parent.recordId).length },
    comments: { updates: comments.length - replies.length, replies: replies.length, systemGenerated: comments.filter((c) => c.imported.systemGenerated).length, attributedToVerifiedJarcUsers: comments.filter((c) => c.authorId).length, historicalAttributionOnly: comments.filter((c) => !c.authorId).length, bodySource: comments.reduce((m, c) => ((m[c.imported.bodySource] = (m[c.imported.bodySource] || 0) + 1), m), {}), withMentions: comments.filter((c) => c.imported.mentionedSourceUserIds.length).length, withAttachmentReferences: comments.filter((c) => c.imported.attachments.length).length, edited: comments.filter((c) => c.editedAt).length },
    columns: { main: mainMatrix, subitems: subMatrix },
    mirrorSnapshots: { columns: mirrorCols.length, filledCells: mirrorCols.reduce((s, m) => s + m.filled, 0), linkedButEmptyInSource: byCode("info")["mirror-linked-value-empty"] || 0, missingFromExtraction: byCode("warnings")["mirror-display-value-missing"] || 0, provenance: plan.board.migration.snapshotProvenance },
    engineerField: { columns: engineer.map((e) => ({ sourceColumnId: e.sourceColumnId, title: e.title, targetKey: e.targetKey, targetType: e.targetType, filled: e.filled })), handling: "Original status labels copied verbatim into a text column: names, duplicates, spelling, capitalisation and VACANT entries unchanged; not linked to any user." },
    identity: identity.totals, identityProblems: identity.problems,
    attachments: { ...attach, note: "References only. No files are stored in JARC by this migration; every reference keeps status not-migrated." },
    views: { total: views.total, byCategory: views.byCategory, recommendedForManualRecreation: views.recommendedForManualRecreation, settingsExposedByApi: views.rows.filter((r) => r.settingsAvailable).length, jarcLimit: 50, note: "monday.com's API did not return filters or layouts for these views, so none can be recreated automatically. View names and types are preserved in the board's migration metadata." },
    estimate,
    issues: { errors: validation.errors.length, warnings: validation.warnings.length, info: validation.info.length, byCode: validation.summary },
    dataLossRisks: [
      "Mirror columns become editable text snapshots and no longer update from the Product, Account and Dealer boards.",
      "Links to the three external boards are kept as monday.com item IDs only; those boards are not in JARC.",
      `Attachments (${attach.uniqueAssets} files, ~${attach.totalMB} MB) are NOT migrated; file columns show file names only until the attachment stage runs.`,
      "Views (53): names and types only; filters and layouts aren't available from the API.",
      "Item order within groups follows the API's order (monday's manual order isn't exposed).",
      "Archived or deleted monday.com items were not extracted.",
      `Status columns with exact duplicate labels show each label once (raw index preserved); ${(byCode("warnings")["date-time-preserved-in-metadata"] || 0)} date time-of-day value(s) kept in metadata only.`,
      "Update HTML formatting (bold, lists, inline images) is reduced to plain text; inline images become “[image]”. Original HTML is not stored in JARC (its SHA-256 is, for traceability; the HTML stays in the private extraction).",
      "@mentions stay as text and never notify anyone; monday user IDs of mentioned people are kept in metadata.",
      "People without a verified JARC account keep a name only (historical attribution)."
    ],
    decisionsRequired: [
      "Confirm verified user mappings (user-mapping-template.json) — or accept historical attribution for everyone.",
      "Choose the target workspace and who gets access to the two new boards.",
      "Attachment stage: storage budget (~5.7 GB vs the 300 MB default cap and the Atlas tier), files over 10 MB, HEIC conversion, JFIF renaming, the CSV file, OneDrive links.",
      "Which named views to recreate by hand in JARC.",
      "Whether the 1,171 automation-generated updates should be visible by default or filtered in the UI."
    ],
    files: written
  };

  write("errors.json", validation.errors);
  write("warnings.json", validation.warnings);
  write("info.json", { counts: byCode("info"), entries: validation.info });
  write("column-mapping.json", { main: mainMatrix, subitems: subMatrix, decisions: plan.decisions });
  write("user-mapping-report.json", identity);
  write("user-mapping-template.json", plan.identity.template());
  write("attachments-plan.json", { feasibility: attach, futureStage: attachmentStageDesign(), references });
  write("views.json", views);
  write("approval-template.json", { note: "NOT an approval. Production execution is disabled; only local-test approvals bound to one verified local instance are accepted.", ...approvalTemplate(digest) });
  write("dry-run-report.json", report);
  write("migration-report.md", markdown(report));
  return { report, written };
}

function attachmentStageDesign() {
  return {
    status: "designed, not implemented, requires separate approval",
    steps: [
      "Inventory (done): every asset with owner record/comment, name, extension, size.",
      "Pre-flight: storage budget and Atlas tier check; raise ATTACHMENTS_MAX_TOTAL_MB only with approval; decide the >10 MB, HEIC, JFIF, CSV and OneDrive rules.",
      "Download (approval): one asset at a time through the monday.com API's authenticated asset URL, resumable by asset ID, SHA-256 recorded, into a private local folder.",
      "Convert/validate: content sniffing with files/file-types.js (PDF, JPEG, PNG, WebP); JFIF → .jpg name; HEIC → JPEG if approved.",
      "Store (approval): stream into GridFS via the file store, attachments document per file linked to the record and a Files column; idempotent by monday asset ID; never a metadata document without stored bytes.",
      "Verify: counts and checksums per record; the migration's file-name text columns are kept until verified."
    ]
  };
}

function markdown(r) {
  const t = (rows, cols) => [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.map((c) => String(c ?? "").replace(/\|/g, "\\|")).join(" | ")} |`)].join("\n");
  const m = r.columns.main;
  const byHandling = m.reduce((acc, c) => ((acc[c.handling] = (acc[c.handling] || 0) + 1), acc), {});
  return `# monday.com → JARC migration — dry-run report

Status: **${r.status}** · database writes: **${r.databaseWrites}** · network requests: **${r.networkRequests}** · production execution locked: **${r.productionExecutionLocked}**
Plan digest: \`${r.planDigest}\` · run ID: \`${r.runId}\`

Private local report (ignored by Git and Docker). It contains schema and counts, no record contents.

## Source verification

${t(Object.entries(r.source.checksums).map(([f, s]) => [f, s]), ["File", "Checksum"])}

Board **${r.source.boardName}** (${r.source.boardId}) on ${r.source.account}, extracted ${r.source.extractedAt}, API ${r.source.apiVersion}, manifest ${r.source.completeness}.

## Counts

${t(Object.keys(r.expectedVsPlanned.expected).map((k) => [k, r.expectedVsPlanned.expected[k], r.expectedVsPlanned.planned[k], r.expectedVsPlanned.expected[k] === r.expectedVsPlanned.planned[k] ? "✔" : "✘"]), ["Resource", "Source", "Planned", ""])}

## Destination

- Board **${r.destination.board.name}** (${r.destination.board.columns} columns, ${r.destination.board.groups} groups), native and editable: ${r.destination.board.editable}.
- Companion board **${r.destination.subitemsBoard.name}** (${r.destination.subitemsBoard.columns} columns): ${r.subitems.planned} sub-items, ${r.subitems.parentsResolved} with a resolved parent record (${r.subitems.parents} parents).
- Workspace: ${r.destination.workspace}.

${t(r.destination.groups.map((g) => [g.order, g.title, g.records, g.sourceGroupId]), ["#", "Group", "Records", "monday group ID"])}

## Columns (${m.length} source columns)

Handling: ${Object.entries(byHandling).map(([k, v]) => `${k} ${v}`).join(", ")}.

${t(m.map((c) => [c.title, c.sourceType, c.handling, c.targetType ?? "—", c.filled ?? "—", c.classification]), ["Column", "monday type", "Handling", "JARC type", "Filled", "Classification"])}

Sub-item board columns: ${r.columns.subitems.map((c) => `${c.title} (${c.sourceType} → ${c.targetType ?? c.handling})`).join(", ")}.

## Mirror snapshots

${r.mirrorSnapshots.columns} mirror columns → editable text; ${r.mirrorSnapshots.filledCells} filled cells. ${r.mirrorSnapshots.linkedButEmptyInSource} cells are linked but monday showed an empty value (blank field on the linked item — reported, not invented). Missing from extraction: ${r.mirrorSnapshots.missingFromExtraction}. ${r.mirrorSnapshots.provenance}

## Engineer field

${r.engineerField.columns.map((e) => `- ${e.title} (${e.sourceColumnId}) → \`${e.targetKey}\` (${e.targetType}), ${e.filled} filled.`).join("\n")}
- ${r.engineerField.handling}

## Updates and replies

${r.comments.updates} updates and ${r.comments.replies} replies; ${r.comments.systemGenerated} system-generated (monday.com automation); ${r.comments.attributedToVerifiedJarcUsers} linked to verified JARC users, ${r.comments.historicalAttributionOnly} historical attribution only. Body source: ${Object.entries(r.comments.bodySource).map(([k, v]) => `${k} ${v}`).join(", ")}. ${r.comments.withMentions} contain mentions (kept as text), ${r.comments.withAttachmentReferences} reference attachments, ${r.comments.edited} were edited. Imported updates can't be edited in JARC; moderators may delete them.

## Identity

${t(Object.entries(r.identity).map(([k, v]) => [k, v]), ["", "Count"])}

No name or email matching was used. Without a confirmed mapping file every person stays historical attribution (no JARC account, login or permission).

## Attachments (not migrated)

${r.attachments.sourceReferences} references (${r.attachments.plannedReferences} traceable, ${r.attachments.untraceable} untraceable), ${r.attachments.uniqueAssets} unique files, ${r.attachments.duplicateReferences} duplicate references, ~${r.attachments.totalMB} MB. Over 10 MB: ${r.attachments.overLimit.count} (${r.attachments.overLimit.mb} MB, largest ${r.attachments.overLimit.largestMB} MB). Unsupported: HEIC ${r.attachments.unsupported.heic}, JFIF ${r.attachments.unsupported.jfif}, CSV ${r.attachments.unsupported.csv}, other ${r.attachments.unsupported.other}. External links: ${r.attachments.externalLinks.count} (${Object.entries(r.attachments.externalLinks.types).map(([k, v]) => `${k} ${v}`).join(", ")}). Stored in JARC: **${r.attachments.storedInJarc}**. JARC's default storage cap is 300 MB, so this needs a capacity decision before any download.

## Views

${r.views.total} views (${Object.entries(r.views.byCategory).map(([k, v]) => `${k} ${v}`).join(", ")}). ${r.views.note} Recommended for manual recreation: ${r.views.recommendedForManualRecreation.join(", ")}.

## Issues

Errors ${r.issues.errors} · warnings ${r.issues.warnings} · info ${r.issues.info}

${t(Object.entries(r.issues.byCode).map(([k, v]) => [k, v]), ["Level:code", "Count"])}

## Data loss risks

${r.dataLossRisks.map((x) => `- ${x}`).join("\n")}

## Decisions required

${r.decisionsRequired.map((x) => `- ${x}`).join("\n")}

## Estimate

${r.estimate.boards} boards, ${r.estimate.records} records, ${r.estimate.comments} comments, ${r.estimate.mappings} mappings, ≈${r.estimate.approxDocumentMB} MB of documents, ${r.estimate.batchesAtExecution} batches. Attachments if migrated later: ≈${r.estimate.attachmentMBIfMigrated} MB.

## Recommended production procedure (each step needs explicit approval)

1. Resolve the decisions above; optionally complete \`user-mapping-template.json\` with verified Entra matches.
2. The executor (Phase M3) runs only against a verified local test instance: rehearse with \`migration-test-db.js\` + \`monday-migrate.js approve-local / execute / verify\` and compare the fidelity report with this one.
3. Production execution is disabled in code (\`PRODUCTION_EXECUTION_ENABLED = false\`, no production target type). Enabling it needs a separate reviewed change: a production target verifier (the Atlas cluster's identity, \`jarc_database\` only, never ReceiptFlow), a pre-import backup/restore point, and an operator check against the JARC administrator role.
4. Issue an approval naming this plan digest, the target database and workspace, approver, operator and expiry (at most 24 h).
5. Run the import; on interruption, re-run: completed batches are skipped by their mappings, and any disagreement stops the run.
6. Verify (counts per group, sub-item parents, comment threads, random record comparisons), then freeze the monday.com board (your action) and revoke the API token.
7. Attachments as a separate approved stage (see \`attachments-plan.json\`).

## Excel / CSV Import Center (future phase) — reuse of this engine

The engine's layers map directly onto a generic importer: **source** (here: monday JSON; there: XLSX/XLS/CSV parsed in a browser Web Worker into sheets → rows of cell text), **column planning** (\`planColumns\`-style explicit decisions: map to an existing column, create a typed column, or keep as text — the same choice list a mapping screen offers), **cell conversion** (\`mapCell\` rules plus \`board-schema.checkValue\` for numbers, dates (Excel serials → YYYY-MM-DD), status/dropdown options, People references), **validation** (\`validatePlan\`-style row-level errors and warnings with stable codes → the preview table and a downloadable error report), **duplicate detection** (deterministic IDs / legacy IDs from a chosen key column, the same unique-index protection), and **execution** (the same batched, resumable, verified write path once unlocked). Worksheet selection and header-row choice are source-stage options; nothing in the mapping or validation layers depends on monday.com.
`;
}

module.exports = { writeReports };
