// Storage boundary (Stage 6).
//
//   AppView → AppController → BoardModel / AuthModel → StorageService → LocalStorageAdapter → browser storage
//
// LocalStorageAdapter is the only code that touches localStorage/sessionStorage. StorageService owns the stored
// schema version, the split between shared application data and per-user state, and the list of named data
// operations. A future ApiAdapter can implement the same contract against the backend without UI changes.

// Predictable errors between storage and the model/UI. Raw browser exceptions are kept in `cause` only.
class StorageError extends Error {
  constructor(code, message, cause) { super(message); this.name = "StorageError"; this.code = code; this.cause = cause; }
}
StorageError.CODES = Object.freeze({
  UNAVAILABLE: "STORAGE_UNAVAILABLE", // storage blocked, disabled or throwing (private mode, browser policy)
  QUOTA: "STORAGE_QUOTA",             // browser storage is full
  INVALID_DATA: "INVALID_DATA",       // stored data can't be parsed or has an unusable shape/version
  NOT_FOUND: "NOT_FOUND"              // reserved for API adapters (e.g. a record that no longer exists)
});
StorageError.from = (error) => {
  if (error instanceof StorageError) return error;
  const quota = error?.name === "QuotaExceededError" || error?.name === "NS_ERROR_DOM_QUOTA_REACHED" || error?.code === 22 || error?.code === 1014 || /quota/i.test(String(error?.message));
  return quota
    ? new StorageError(StorageError.CODES.QUOTA, "Browser storage is full.", error)
    : new StorageError(StorageError.CODES.UNAVAILABLE, "Browser storage is unavailable (it may be blocked by private browsing or browser settings).", error);
};

// Browser persistence only: key names, legacy key lookup, raw reads/writes, and error translation.
class LocalStorageAdapter {
  constructor() {
    this.keys = Object.freeze({
      app: "jarc-database-data",
      legacyApp: ["medtek", "database", "v9"].join("-"), // pre-JARC key; read-only, never deleted
      preferences: Object.freeze({
        navCollapsed: "jarc-nav-collapsed",
        workspaceSectionCollapsed: "jarc-workspace-collapsed",
        rememberedUsername: "medtek-remembered-username",
        lastLogin: "medtek-last-login",
        persistentSignIn: "medtek-auth-session"
      }),
      session: Object.freeze({
        signIn: "medtek-auth-session",
        failedAttempts: "medtek-failed-attempts",
        lockedUntil: "medtek-locked-until",
        screenLocked: "medtek-screen-locked",
        lastActivity: "medtek-last-activity"
      })
    });
  }
  area(name) {
    let store;
    try { store = name === "session" ? window.sessionStorage : window.localStorage; } catch (error) { throw StorageError.from(error); }
    if (!store) throw new StorageError(StorageError.CODES.UNAVAILABLE, "Browser storage is unavailable.");
    return store;
  }
  read(areaName, key) { try { return this.area(areaName).getItem(key); } catch (error) { throw StorageError.from(error); } }
  write(areaName, key, value) { try { this.area(areaName).setItem(key, String(value)); } catch (error) { throw StorageError.from(error); } }
  remove(areaName, key) { try { this.area(areaName).removeItem(key); } catch (error) { throw StorageError.from(error); } }
  keyFor(group, name) { const key = this.keys[group]?.[name]; if (!key) throw new Error(`Unknown ${group} key "${name}"`); return key; }

  // Application state: the current key, falling back to the legacy key. Returns raw text; parsing is the service's job.
  readAppState() {
    const current = this.read("local", this.keys.app);
    if (current !== null) return { raw: current, source: "current" };
    const legacy = this.read("local", this.keys.legacyApp);
    return legacy !== null ? { raw: legacy, source: "legacy" } : { raw: null, source: "none" };
  }
  writeAppState(text) { this.write("local", this.keys.app, text); }
  readRawAppState() { return this.read("local", this.keys.app); }
  clearAppState() { this.remove("local", this.keys.app); } // explicit user action only (recovery screen)
}

class StorageService {
  constructor(adapter) {
    this.adapter = adapter;
    this.extraFields = {}; // unknown top-level fields found on load; written back untouched
    this.lastChange = null;
  }

  // ---- Application state -------------------------------------------------------------------------------------
  // Shared application data: future server/database resources. Everything else in the blob is per-user state
  // (selection, current screen, settings, profile, inbox, recents) that should not become shared company data.
  static SCHEMA_VERSION = 1;
  static SHARED_FIELDS = Object.freeze(["workspaces", "members"]);
  static USER_FIELDS = Object.freeze(["currentWorkspaceId", "currentBoardId", "currentView", "screen", "settings", "profile", "notifications", "recentBoards", "recentRecords", "recentCommands"]);

  // Returns { data, user, source, migrated }. data/user are null when nothing is stored yet.
  // Throws StorageError(INVALID_DATA | STORAGE_UNAVAILABLE). Never deletes or overwrites unreadable data.
  loadState() {
    const { raw, source } = this.adapter.readAppState();
    if (raw === null) return { data: null, user: null, source, migrated: false };
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) { throw new StorageError(StorageError.CODES.INVALID_DATA, "Your saved data could not be read. It has been left unchanged. Export the browser storage or restore a valid backup before continuing.", error); }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.workspaces) || !parsed.workspaces.length) throw new StorageError(StorageError.CODES.INVALID_DATA, "Your saved data could not be read. It has been left unchanged. Export the browser storage or restore a valid backup before continuing.");
    const { state, changed } = this.migrate(parsed);
    this.extraFields = Object.fromEntries(Object.entries(state).filter(([key]) => key !== "schemaVersion" && !StorageService.SHARED_FIELDS.includes(key) && !StorageService.USER_FIELDS.includes(key)));
    // Persist the normalized form once (legacy key copied forward, schemaVersion added). The legacy key is kept.
    if (source === "legacy" || changed) { try { this.adapter.writeAppState(this.serialize(state)); } catch { /* still usable in memory; the next save reports the failure */ } }
    return { data: this.pick(state, StorageService.SHARED_FIELDS), user: this.pick(state, StorageService.USER_FIELDS), source, migrated: source === "legacy" || changed };
  }
  // Schema migrations: backward compatible, idempotent and non-destructive (only adds what is missing).
  migrate(stored) {
    const version = stored.schemaVersion;
    if (version !== undefined && !(Number.isInteger(version) && version >= 1)) throw new StorageError(StorageError.CODES.INVALID_DATA, "Your saved data has an unrecognised format. It has been left unchanged.");
    if (version > StorageService.SCHEMA_VERSION) throw new StorageError(StorageError.CODES.INVALID_DATA, "Your saved data was created by a newer version of JARC. It has been left unchanged; open it with the newer version or restore a backup.");
    if (version === StorageService.SCHEMA_VERSION) return { state: stored, changed: false };
    return { state: { schemaVersion: StorageService.SCHEMA_VERSION, ...stored }, changed: true }; // v0 (no version) → v1: same shape
  }
  pick(state, fields) { return Object.fromEntries(fields.filter((key) => state[key] !== undefined).map((key) => [key, state[key]])); }
  serialize(state) { return JSON.stringify({ ...state, schemaVersion: StorageService.SCHEMA_VERSION }); }

  // ---- Named data operations ----------------------------------------------------------------------------------
  // The model applies a change in memory, then commits it with a description of what changed. The local adapter
  // persists the whole state; an API adapter would map each operation to a request (see the Stage 6 report).
  static OPERATIONS = Object.freeze([
    "saveState", "replaceAll", "updateUserState", "updateMembers",
    "createWorkspace", "updateWorkspace", "deleteWorkspace",
    "createBoard", "updateBoard", "deleteBoard", "updateColumns", "updateGroups", "updateViews",
    "createRecord", "createRecords", "updateRecord", "updateRecords", "deleteRecords", "reorderRecords", "moveRecord"
  ]);
  // Returns { ok: true } or { ok: false, code, message }. Never throws for storage failures.
  commit(change, { data, user }) {
    if (!StorageService.OPERATIONS.includes(change?.op)) throw new Error(`Unknown storage operation "${change?.op}"`);
    this.lastChange = { ...change, at: Date.now() };
    try {
      this.adapter.writeAppState(this.serialize({ ...this.extraFields, ...user, ...data }));
      return { ok: true };
    } catch (error) {
      const failure = StorageError.from(error);
      return { ok: false, code: failure.code, message: failure.message };
    }
  }

  // ---- Recovery helpers (startup failure screen) ---------------------------------------------------------------
  readRawState() { return this.adapter.readRawAppState(); }
  clearState() { this.adapter.clearAppState(); }

  // ---- Per-device preferences and temporary sign-in/session state ---------------------------------------------
  // Not application data. Failures are non-fatal: reads fall back to null and writes report false.
  getPreference(name) { try { return this.adapter.read("local", this.adapter.keyFor("preferences", name)); } catch (error) { if (!(error instanceof StorageError)) throw error; return null; } }
  setPreference(name, value) { try { this.adapter.write("local", this.adapter.keyFor("preferences", name), value); return true; } catch (error) { if (!(error instanceof StorageError)) throw error; return false; } }
  removePreference(name) { try { this.adapter.remove("local", this.adapter.keyFor("preferences", name)); return true; } catch (error) { if (!(error instanceof StorageError)) throw error; return false; } }
  getSessionValue(name) { try { return this.adapter.read("session", this.adapter.keyFor("session", name)); } catch (error) { if (!(error instanceof StorageError)) throw error; return null; } }
  setSessionValue(name, value) { try { this.adapter.write("session", this.adapter.keyFor("session", name), value); return true; } catch (error) { if (!(error instanceof StorageError)) throw error; return false; } }
  removeSessionValue(name) { try { this.adapter.remove("session", this.adapter.keyFor("session", name)); return true; } catch (error) { if (!(error instanceof StorageError)) throw error; return false; } }
}

window.StorageError = StorageError;
window.LocalStorageAdapter = LocalStorageAdapter;
window.StorageService = StorageService;
window.jarcStorage = new StorageService(new LocalStorageAdapter());
