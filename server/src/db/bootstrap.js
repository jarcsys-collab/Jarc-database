// Idempotent database initialisation for jarc_database: creates any missing collections and indexes.
//
// Safe to run on every start and any number of times. It never drops a collection or an index, never deletes or
// changes documents, and never touches another database. If an index with the same name exists with different
// options, startup stops with a clear message instead of replacing it.
//
// Flexible record values (values.<column key>) are deliberately not indexed one by one: columns are created by users
// at run time, so per-column indexes would grow without limit, slow every write and hit MongoDB's 64-indexes-per-
// collection cap. Queries are always scoped to one board through the boardId prefix of the indexes below.
const COLLECTIONS = Object.freeze({
  users: "users",
  workspaces: "workspaces",
  workspaceMembers: "workspaceMembers",
  boards: "boards",
  records: "records",
  activities: "activities",
  // AUTH_MODE=entra: server-side sign-in sessions and single-use sign-in nonces (TTL-cleaned).
  sessions: "sessions",
  loginAttempts: "loginAttempts",
  // Files columns: one metadata document per attachment, and the GridFS bucket "attachmentFiles" holding the bytes.
  attachments: "attachments",
  attachmentFiles: "attachmentFiles.files",
  attachmentChunks: "attachmentFiles.chunks",
  // monday.com integration (see repositories/mongo/integration-repository.js).
  integrations: "integrations",
  integrationOAuthStates: "integrationOAuthStates",
  integrationMappings: "integrationMappings",
  integrationJobs: "integrationJobs",
  integrationEvents: "integrationEvents",
  // Record discussions (see repositories/mongo/comment-repository.js).
  comments: "comments",
  // Attachment storage counters per provider (see repositories/mongo/storage-usage-repository.js).
  storageUsage: "storageUsage",
  // Derived search text, one document per record; rebuilt from records at any time (see services/record-search-index.js).
  recordSearch: "recordSearch",
  // Native forms and who submitted them (see services/form-service.js).
  forms: "forms",
  formSubmissions: "formSubmissions",
  // Excel and CSV imports (see services/import-job-service.js). importBatches holds a file's rows only until its job ends.
  importJobs: "importJobs",
  importBatches: "importBatches",
  // Account Management audit trail (Phase M4.3; see repositories/mongo/account-audit-repository.js). Append-only.
  accountAudit: "accountAudit",
  // API tokens for other systems (see repositories/mongo/api-token-repository.js). Digests only, never tokens.
  apiTokens: "apiTokens",
  apiTokenAudit: "apiTokenAudit"
});

// Collections that belong to one optional feature: left out while it's switched off, so a deployment with the feature off adds
// nothing to the database. Switching it on (which restarts the server) creates them.
const FEATURE_COLLECTIONS = Object.freeze({ nativeForms: Object.freeze([COLLECTIONS.forms, COLLECTIONS.formSubmissions]), spreadsheetImports: Object.freeze([COLLECTIONS.importJobs, COLLECTIONS.importBatches]), apiTokens: Object.freeze([COLLECTIONS.apiTokens, COLLECTIONS.apiTokenAudit]) });
// Indexes one optional feature adds to a collection that always exists. Also left out while the feature is off.
const FEATURE_INDEXES = Object.freeze({ apiTokens: Object.freeze({ records: Object.freeze([{ name: "board_id", key: { boardId: 1, _id: 1 } }]) }) });

const present = { $exists: true };
const INDEXES = Object.freeze({
  forms: [
    { name: "board_name", key: { boardId: 1, name: 1, _id: 1 } }
  ],
  importJobs: [
    { name: "worker", key: { status: 1, leaseUntil: 1 } },
    { name: "board_created", key: { boardId: 1, createdAt: -1 } },
    { name: "board_file", key: { boardId: 1, fileHash: 1, status: 1 } },
    { name: "workspace_file", key: { workspaceId: 1, fileHash: 1, status: 1 } },
    { name: "creator_status", key: { createdBy: 1, status: 1 } },
    // Abandoned uploads go; a job that ended has no expiresAt and stays as the record of what was imported.
    { name: "expires", key: { expiresAt: 1 }, expireAfterSeconds: 0 }
  ],
  importBatches: [
    { name: "uniq_job_batch", key: { jobId: 1, n: 1 }, unique: true },
    { name: "expires", key: { expiresAt: 1 }, expireAfterSeconds: 0 }
  ],
  formSubmissions: [
    // One attempt, one record: see FormService.submit.
    { name: "uniq_form_attempt", key: { formId: 1, submissionKey: 1 }, unique: true },
    { name: "board_created", key: { boardId: 1, createdAt: -1 } }
  ],
  recordSearch: [
    { name: "board_updated", key: { boardId: 1, updatedAt: -1, _id: -1 } }
  ],
  users: [
    // Future Microsoft Entra identity: tenant + object ID (immutable). Email is never the identity key.
    { name: "uniq_entra_identity", key: { tenantId: 1, entraObjectId: 1 }, unique: true, partialFilterExpression: { entraObjectId: { $type: "string" } } },
    // The single fixed DEVELOPMENT actor (pre-auth only; see context/dev-actor.js).
    { name: "uniq_dev_actor", key: { devKey: 1 }, unique: true, partialFilterExpression: { devKey: { $type: "string" } } },
    // Admins add members by email: an exact lookup on the stored lower-case copy (display data, not identity).
    { name: "email_lookup", key: { emailNormalized: 1 }, partialFilterExpression: { emailNormalized: { $type: "string" } } }
  ],
  workspaces: [
    { name: "position", key: { position: 1 } },
    // Migration identity: one imported workspace per legacy ID, so a repeated import cannot duplicate it.
    { name: "uniq_legacy_id", key: { legacyId: 1 }, unique: true, partialFilterExpression: { legacyId: present } }
  ],
  workspaceMembers: [
    { name: "uniq_workspace_user", key: { workspaceId: 1, userId: 1 }, unique: true },
    { name: "user_status", key: { userId: 1, status: 1 } }
  ],
  boards: [
    { name: "workspace_position", key: { workspaceId: 1, position: 1 } },
    { name: "uniq_workspace_legacy_id", key: { workspaceId: 1, legacyId: 1 }, unique: true, partialFilterExpression: { legacyId: present } }
  ],
  records: [
    { name: "board_position", key: { boardId: 1, position: 1, _id: 1 } },
    { name: "board_updated", key: { boardId: 1, updatedAt: -1, _id: -1 } },
    { name: "board_created", key: { boardId: 1, createdAt: -1, _id: -1 } },
    { name: "board_group", key: { boardId: 1, groupId: 1 } },
    { name: "board_active", key: { boardId: 1, archived: 1 } }, // active-record counts on every board list
    { name: "workspace_board", key: { workspaceId: 1, boardId: 1 } },
    { name: "uniq_board_legacy_id", key: { boardId: 1, legacyId: 1 }, unique: true, partialFilterExpression: { legacyId: present } }
  ],
  activities: [
    { name: "workspace_created", key: { workspaceId: 1, createdAt: -1 } },
    { name: "board_created", key: { boardId: 1, createdAt: -1 } },
    { name: "record_created", key: { recordId: 1, createdAt: -1 } },
    // Live updates and the notification feed read the log by time across workspaces.
    { name: "created", key: { createdAt: 1 } },
    { name: "logged", key: { loggedAt: 1 } }
  ],
  sessions: [
    { name: "expires", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    { name: "user", key: { userId: 1 } }
  ],
  loginAttempts: [
    { name: "expires", key: { expiresAt: 1 }, expireAfterSeconds: 0 }
  ],
  attachments: [
    { name: "record_column", key: { recordId: 1, columnKey: 1, createdAt: 1 } },
    { name: "board_status", key: { boardId: 1, status: 1, createdAt: 1 } },
    { name: "workspace", key: { workspaceId: 1 } },
    { name: "status_created", key: { status: 1, createdAt: 1 } },
    // A retried upload (same browser-generated key) never creates a second attachment.
    { name: "uniq_upload_key", key: { recordId: 1, uploadKey: 1 }, unique: true, partialFilterExpression: { uploadKey: { $type: "string" } } },
    // Object-storage files (documents without `storage` are GridFS, keyed by their _id): one document per stored object.
    { name: "uniq_storage_key", key: { "storage.provider": 1, "storage.key": 1 }, unique: true, partialFilterExpression: { "storage.key": { $type: "string" } } },
    // Migrated files: one attachment per source asset (a retried migration can't store a file twice).
    { name: "uniq_source_asset", key: { "imported.provider": 1, "imported.sourceAssetId": 1 }, unique: true, partialFilterExpression: { "imported.sourceAssetId": { $type: "string" } } }
  ],
  // The indexes the MongoDB driver itself expects on a GridFS bucket (same names, so it never creates duplicates).
  "attachmentFiles.files": [
    { name: "filename_1_uploadDate_1", key: { filename: 1, uploadDate: 1 } }
  ],
  comments: [
    { name: "record_time", key: { recordId: 1, createdAt: 1 } },
    { name: "board_live", key: { boardId: 1, deletedAt: 1 } },
    // Command Center search (Phase 14): a board's comments newest first, so a search across boards merges sorted
    // index walks and stops at the page size instead of sorting every matching comment in memory.
    { name: "board_created", key: { boardId: 1, createdAt: -1, _id: -1 } },
    { name: "workspace", key: { workspaceId: 1 } }
  ],
  integrationOAuthStates: [
    { name: "expires", key: { expiresAt: 1 }, expireAfterSeconds: 0 }
  ],
  integrationMappings: [
    { name: "uniq_source", key: { provider: 1, kind: 1, sourceId: 1 }, unique: true },
    { name: "target", key: { provider: 1, kind: 1, targetId: 1 } },
    { name: "board", key: { boardId: 1 } }
  ],
  integrationJobs: [
    { name: "due", key: { status: 1, runAfter: 1 } },
    { name: "lease", key: { status: 1, lockedUntil: 1 } },
    { name: "history", key: { provider: 1, type: 1, createdAt: -1 } }
  ],
  integrationEvents: [
    { name: "uniq_event", key: { provider: 1, eventId: 1 }, unique: true },
    { name: "expires", key: { receivedAt: 1 }, expireAfterSeconds: 30 * 24 * 3600 }
  ],
  accountAudit: [
    { name: "target_time", key: { targetUserId: 1, at: -1 } },
    { name: "time", key: { at: -1 } }
  ],
  apiTokens: [
    { name: "uniq_public_id", key: { publicId: 1 }, unique: true },
    { name: "owner_created", key: { ownerUserId: 1, createdAt: -1, _id: -1 } }
  ],
  apiTokenAudit: [
    { name: "token_time", key: { tokenId: 1, at: -1 } },
    // Failed and refused use expires; entries about creating, rotating and revoking have no expiresAt and stay.
    { name: "expires", key: { expiresAt: 1 }, expireAfterSeconds: 0 }
  ],
  "attachmentFiles.chunks": [
    { name: "files_id_1_n_1", key: { files_id: 1, n: 1 }, unique: true }
  ]
});

// features: which optional features are on (config/index.js). Without it, every collection is created.
async function ensureDatabase(db, { features = null } = {}) {
  const skipped = new Set(features ? Object.entries(FEATURE_COLLECTIONS).flatMap(([name, list]) => (features[name] ? [] : list)) : []);
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const createdCollections = [];
  for (const name of Object.values(COLLECTIONS)) {
    if (existing.has(name) || skipped.has(name)) continue;
    try {
      await db.createCollection(name);
      createdCollections.push(name);
    } catch (error) {
      if (error?.code !== 48) throw error; // 48 NamespaceExists: created concurrently, which is fine
    }
  }
  let indexes = 0;
  for (const [collection, specs] of Object.entries(INDEXES)) {
    if (skipped.has(collection)) continue;
    for (const { key, ...options } of specs) {
      await db.collection(collection).createIndex(key, options); // no-op when the identical index exists
      indexes += 1;
    }
  }
  for (const [feature, collections] of Object.entries(FEATURE_INDEXES)) {
    if (!features?.[feature]) continue; // only when asked for by name, so tools that don't state features never add one
    for (const [collection, specs] of Object.entries(collections)) {
      for (const { key, ...options } of specs) {
        await db.collection(collection).createIndex(key, options);
        indexes += 1;
      }
    }
  }
  return { createdCollections, indexes };
}

module.exports = { FEATURE_COLLECTIONS, FEATURE_INDEXES, ensureDatabase, COLLECTIONS, INDEXES };
