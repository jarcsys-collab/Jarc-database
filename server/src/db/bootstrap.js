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
  loginAttempts: "loginAttempts"
});

const present = { $exists: true };
const INDEXES = Object.freeze({
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
    { name: "workspace_board", key: { workspaceId: 1, boardId: 1 } },
    { name: "uniq_board_legacy_id", key: { boardId: 1, legacyId: 1 }, unique: true, partialFilterExpression: { legacyId: present } }
  ],
  activities: [
    { name: "workspace_created", key: { workspaceId: 1, createdAt: -1 } },
    { name: "board_created", key: { boardId: 1, createdAt: -1 } },
    { name: "record_created", key: { recordId: 1, createdAt: -1 } }
  ],
  sessions: [
    { name: "expires", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    { name: "user", key: { userId: 1 } }
  ],
  loginAttempts: [
    { name: "expires", key: { expiresAt: 1 }, expireAfterSeconds: 0 }
  ]
});

async function ensureDatabase(db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const createdCollections = [];
  for (const name of Object.values(COLLECTIONS)) {
    if (existing.has(name)) continue;
    try {
      await db.createCollection(name);
      createdCollections.push(name);
    } catch (error) {
      if (error?.code !== 48) throw error; // 48 NamespaceExists: created concurrently, which is fine
    }
  }
  let indexes = 0;
  for (const [collection, specs] of Object.entries(INDEXES)) {
    for (const { key, ...options } of specs) {
      await db.collection(collection).createIndex(key, options); // no-op when the identical index exists
      indexes += 1;
    }
  }
  return { createdCollections, indexes };
}

module.exports = { ensureDatabase, COLLECTIONS, INDEXES };
