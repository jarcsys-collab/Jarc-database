// Storage boundary (Stage 6) with an asynchronous contract (Stage 8).
//
//   AppView → AppController → BoardModel / AuthModel → StorageService → LocalAsyncAdapter → browser storage
//
// Application state is loaded and saved through Promises, so a future ApiAdapter (fetch → Express → MongoDB) can
// replace LocalAsyncAdapter without UI changes. LocalAsyncAdapter is the only code that touches localStorage/sessionStorage. StorageService owns the stored
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
  NOT_FOUND: "NOT_FOUND",             // the item no longer exists
  // Future API adapter codes (Stage 7 error contract). The local adapter does not produce these yet.
  VALIDATION_ERROR: "VALIDATION_ERROR", UNAUTHENTICATED: "UNAUTHENTICATED", FORBIDDEN: "FORBIDDEN", CONFLICT: "CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE", RATE_LIMITED: "RATE_LIMITED", SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  OFFLINE: "OFFLINE", INTERNAL_ERROR: "INTERNAL_ERROR",
  CANCELLED: "CANCELLED"              // internal: a queued save skipped because an earlier save failed
});
// The one place that turns an error code into user-facing text. Never includes raw exceptions, stacks or tokens.
// retryable: a user-triggered Retry can help. offline: the connection to the data service is down.
StorageError.describe = (codeOrError) => {
  const code = typeof codeOrError === "string" ? codeOrError : codeOrError?.code;
  const C = StorageError.CODES;
  const messages = {
    [C.QUOTA]: ["Browser storage is full — your latest change wasn't saved. Export a backup from Settings → Data.", true],
    [C.UNAVAILABLE]: ["Changes couldn't be saved in this browser. Export a backup from Settings → Data, then use Retry.", true],
    [C.INVALID_DATA]: ["That change isn't valid and wasn't saved.", false],
    [C.VALIDATION_ERROR]: ["That change isn't valid and wasn't saved.", false],
    [C.NOT_FOUND]: ["This item no longer exists. Reload to see the latest data.", false],
    [C.UNAUTHENTICATED]: ["Your session has expired. Sign in again to keep working.", false],
    [C.FORBIDDEN]: ["You don't have permission to make this change.", false],
    [C.CONFLICT]: ["Someone else changed this item. Reload to see the latest version.", false],
    [C.PAYLOAD_TOO_LARGE]: ["This is too large to save.", false],
    [C.RATE_LIMITED]: ["Too many changes at once — wait a moment, then use Retry.", true],
    [C.SERVICE_UNAVAILABLE]: ["The service is unavailable — your change wasn't saved. Use Retry in a moment.", true],
    [C.OFFLINE]: ["Offline — changes can't be saved.", true],
    [C.INTERNAL_ERROR]: ["Something went wrong and your change wasn't saved.", true]
  };
  const [message, retryable] = messages[code] || messages[C.INTERNAL_ERROR];
  return { code: code || C.INTERNAL_ERROR, message, retryable, offline: code === C.OFFLINE || code === C.SERVICE_UNAVAILABLE };
};
StorageError.from = (error) => {
  if (error instanceof StorageError) return error;
  const quota = error?.name === "QuotaExceededError" || error?.name === "NS_ERROR_DOM_QUOTA_REACHED" || error?.code === 22 || error?.code === 1014 || /quota/i.test(String(error?.message));
  return quota
    ? new StorageError(StorageError.CODES.QUOTA, "Browser storage is full.", error)
    : new StorageError(StorageError.CODES.UNAVAILABLE, "Browser storage is unavailable (it may be blocked by private browsing or browser settings).", error);
};

// Browser persistence only: key names, legacy key lookup, raw reads/writes, and error translation.
// Application state uses the asynchronous contract (readAppState / writeAppState return Promises) that a future
// ApiAdapter will also implement. Preferences, temporary sign-in values and the recovery helpers stay synchronous:
// they are per-device browser state, not application data.
class LocalAsyncAdapter {
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
  async readAppState() {
    const current = this.read("local", this.keys.app);
    if (current !== null) return { raw: current, source: "current" };
    const legacy = this.read("local", this.keys.legacyApp);
    return legacy !== null ? { raw: legacy, source: "legacy" } : { raw: null, source: "none" };
  }
  async writeAppState(text) { this.write("local", this.keys.app, text); }
  readRawAppState() { return this.read("local", this.keys.app); }
  clearAppState() { this.remove("local", this.keys.app); } // explicit user action only (recovery screen)
}

class StorageService {
  constructor(adapter) {
    this.adapter = adapter;
    this.extraFields = {}; // unknown top-level fields found on load; written back untouched
    this.lastChange = null;
    this.queue = Promise.resolve(); // saves are written strictly in order
    this.generation = 0;            // bumped by a failed save; saves queued behind it are cancelled, not written
    this.connection = "online";     // "online" | "offline" — reported by adapters; the local adapter is always online
  }
  setConnection(state) {
    if (state === this.connection || !["online", "offline"].includes(state)) return;
    this.connection = state;
    window.dispatchEvent(new CustomEvent("jarc-connection", { detail: state }));
  }

  // ---- Application state -------------------------------------------------------------------------------------
  // Shared application data: future server/database resources. Everything else in the blob is per-user state
  // (selection, current screen, settings, profile, inbox, recents) that should not become shared company data.
  static SCHEMA_VERSION = 1;
  static SHARED_FIELDS = Object.freeze(["workspaces", "members"]);
  static USER_FIELDS = Object.freeze(["currentWorkspaceId", "currentBoardId", "currentView", "screen", "settings", "profile", "notifications", "recentBoards", "recentRecords", "recentCommands"]);

  // Returns { data, user, source, migrated }. data/user are null when nothing is stored yet.
  // Throws StorageError(INVALID_DATA | STORAGE_UNAVAILABLE). Never deletes or overwrites unreadable data.
  async loadState() {
    const { raw, source } = await this.adapter.readAppState();
    if (raw === null) return { data: null, user: null, source, migrated: false };
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) { throw new StorageError(StorageError.CODES.INVALID_DATA, "Your saved data could not be read. It has been left unchanged. Export the browser storage or restore a valid backup before continuing.", error); }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.workspaces) || !parsed.workspaces.length) throw new StorageError(StorageError.CODES.INVALID_DATA, "Your saved data could not be read. It has been left unchanged. Export the browser storage or restore a valid backup before continuing.");
    const { state, changed } = this.migrate(parsed);
    this.extraFields = Object.fromEntries(Object.entries(state).filter(([key]) => key !== "schemaVersion" && !StorageService.SHARED_FIELDS.includes(key) && !StorageService.USER_FIELDS.includes(key)));
    // Persist the normalized form once (legacy key copied forward, schemaVersion added). The legacy key is kept.
    if (source === "legacy" || changed) { try { await this.adapter.writeAppState(this.serialize(state)); } catch { /* still usable in memory; the next save reports the failure */ } }
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
  // Returns a Promise of { ok: true } or { ok: false, code, message }; it never rejects for storage failures.
  // Unknown operation names are programming errors and throw immediately. The state is captured now, so later
  // in-memory changes can't leak into this write. If a save fails, saves already queued behind it resolve as
  // CANCELLED without writing, so nothing newer than the last good state reaches storage until Retry.
  commit(change, { data, user }) {
    if (!StorageService.OPERATIONS.includes(change?.op)) throw new Error(`Unknown storage operation "${change?.op}"`);
    this.lastChange = { ...change, at: Date.now() };
    const text = this.serialize({ ...this.extraFields, ...user, ...data }), generation = this.generation;
    const run = async () => {
      if (generation !== this.generation) return { ok: false, code: StorageError.CODES.CANCELLED, message: "" };
      try {
        await this.adapter.writeAppState(text);
        this.setConnection("online");
        return { ok: true };
      } catch (error) {
        this.generation += 1;
        const failure = StorageError.from(error);
        if (StorageError.describe(failure.code).offline) this.setConnection("offline");
        return { ok: false, code: failure.code, message: failure.message };
      }
    };
    const result = this.queue.then(run);
    this.queue = result;
    return result;
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
window.LocalAsyncAdapter = LocalAsyncAdapter;
window.StorageService = StorageService;
window.jarcStorage = new StorageService(new LocalAsyncAdapter());
