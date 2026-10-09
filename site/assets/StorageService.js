// Storage boundary (Stage 6) with an asynchronous contract (Stage 8).
//
//   AppView → AppController → BoardModel / AuthModel → StorageService → LocalAsyncAdapter → browser storage (default)
//                                                                       → ApiAdapter → fetch → /api/v1/state (Stage 9, transitional)
//                                                                       → ResourceApiAdapter → fetch → /api/v1 resources → MongoDB
//                                                                         (Stage 11, ResourceApiAdapter.js, opt-in ?storage=resource)
//
// Application state is loaded and saved through Promises, so either adapter works without UI changes.
// LocalAsyncAdapter is the only code that touches localStorage/sessionStorage. StorageService owns the stored
// schema version, the split between shared application data and per-user state, and the list of named data
// operations.

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
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED", // Entra sign-in: the JARC account is disabled
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
    [C.ACCOUNT_DISABLED]: ["Your JARC account doesn't have access. Contact a JARC administrator.", false],
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
// After resource mode has reloaded the server's latest copy (conflict or deleted elsewhere). Nothing to retry.
StorageError.describeRefreshed = (code) => ({
  code,
  message: code === StorageError.CODES.NOT_FOUND ? "This item was deleted by another user. The latest data has been loaded." : "This item was changed by another user. The latest version has been loaded.",
  retryable: false, offline: false
});
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
    this.mode = "local";
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

// Application state over HTTP (Stage 9): the same async contract as LocalAsyncAdapter, against the Express API on
// the same origin. Uses the TRANSITIONAL development endpoints GET/PUT /api/v1/state, which the resource API
// (/api/v1/workspaces, /boards, /records) replaces later. Preferences and temporary sign-in values are per-device,
// so they stay in browser storage through a LocalAsyncAdapter. No credentials or secrets are used or stored here.
class ApiAdapter {
  constructor({ baseUrl = "/api/v1", timeoutMs = ApiAdapter.TIMEOUT_MS, fetch: fetchImpl, device = new LocalAsyncAdapter() } = {}) {
    this.mode = "api";
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl || ((...args) => window.fetch(...args));
    this.device = device;
    this.keys = device.keys;
  }
  static TIMEOUT_MS = 15000;
  // HTTP status → StorageError code. Unlisted 4xx/5xx statuses become INTERNAL_ERROR.
  static STATUS_CODES = Object.freeze({
    400: "VALIDATION_ERROR", 422: "VALIDATION_ERROR", 401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND",
    409: "CONFLICT", 413: "PAYLOAD_TOO_LARGE", 429: "RATE_LIMITED", 500: "INTERNAL_ERROR",
    502: "SERVICE_UNAVAILABLE", 503: "SERVICE_UNAVAILABLE", 504: "SERVICE_UNAVAILABLE"
  });
  static codeForStatus(status) { return ApiAdapter.STATUS_CODES[status] || StorageError.CODES.INTERNAL_ERROR; }

  // Entra sign-in (resource mode, AUTH_MODE=entra): the HttpOnly session cookie travels automatically with same-origin
  // requests; requests that change data also carry the session's CSRF token — only ever to this origin, never logged.
  useCsrfToken(token) { this.csrfToken = token || null; }
  isSameOrigin(url) {
    try { return new URL(url, window.location.origin).origin === window.location.origin; } catch { return false; }
  }

  // Per-device values stay local in API mode.
  read(areaName, key) { return this.device.read(areaName, key); }
  write(areaName, key, value) { this.device.write(areaName, key, value); }
  remove(areaName, key) { this.device.remove(areaName, key); }
  keyFor(group, name) { return this.device.keyFor(group, name); }

  async readAppState() {
    let body;
    try { body = await this.request("GET", "/state"); }
    catch (error) {
      // Loading has its own wording; connection and timeout messages already fit.
      if (error.code === StorageError.CODES.OFFLINE || /took too long/.test(error.message)) throw error;
      throw new StorageError(error.code, "The JARC server couldn't load your workspace. Try again in a moment.", error.cause);
    }
    if (!body || typeof body !== "object" || !("state" in body)) throw new StorageError(StorageError.CODES.INTERNAL_ERROR, "The JARC server sent a response JARC can't use. Try again in a moment.");
    return body.state === null ? { raw: null, source: "none" } : { raw: JSON.stringify(body.state), source: "api" };
  }
  async writeAppState(text) { await this.request("PUT", "/state", text); }
  // The recovery screen's download/clear actions apply to browser storage only; server data is never cleared here.
  readRawAppState() { return null; }
  clearAppState() { throw new StorageError(StorageError.CODES.FORBIDDEN, "Server data can't be cleared from this screen."); }

  // One request with a timeout. Resolves with the parsed JSON body; rejects only with StorageError (safe messages,
  // the raw failure kept in `cause`). Nothing is ever retried automatically.
  async request(method, path, body) {
    const url = this.baseUrl + path;
    const csrf = this.csrfToken && !(method === "GET" || method === "HEAD") && this.isSameOrigin(url) ? this.csrfToken : null;
    return this.send(method, url, body, csrf);
  }

  async send(method, url, body, csrf) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const fail = (code, message, cause) => new StorageError(code, message || StorageError.describe(code).message, cause);
    try {
      let response;
      try {
        const headers = body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" };
        if (csrf) headers["X-CSRF-Token"] = csrf;
        response = await this.fetch(url, { method, body, signal: controller.signal, credentials: "same-origin", cache: "no-store", headers });
      } catch (error) {
        if (controller.signal.aborted) throw fail(StorageError.CODES.SERVICE_UNAVAILABLE, "The JARC server took too long to respond. Try again in a moment.", error);
        throw fail(StorageError.CODES.OFFLINE, "Can't reach the JARC server. Check your connection, then try again.", error);
      }
      if (!response.ok) {
        // Only the error code is read from the body (never its text): it tells a disabled account from other 403s.
        let serverCode = null;
        try { serverCode = (await response.json())?.error?.code ?? null; } catch { /* not JSON */ }
        let error;
        if (serverCode === StorageError.CODES.ACCOUNT_DISABLED) {
          error = fail(StorageError.CODES.ACCOUNT_DISABLED, null, { status: response.status });
          window.dispatchEvent?.(new CustomEvent("jarc-access-denied"));
        } else if (this.csrfToken && (response.status === 401 || serverCode === "CSRF_INVALID")) {
          // The signed-in session ended (expired, signed out elsewhere, or no longer valid): nothing is retried.
          error = fail(StorageError.CODES.UNAUTHENTICATED, null, { status: response.status });
          window.dispatchEvent?.(new CustomEvent("jarc-session-expired"));
        } else error = fail(ApiAdapter.codeForStatus(response.status), null, { status: response.status });
        throw error;
      }
      let parsed;
      try { parsed = await response.json(); }
      catch (error) {
        if (controller.signal.aborted) throw fail(StorageError.CODES.SERVICE_UNAVAILABLE, "The JARC server took too long to respond. Try again in a moment.", error);
        throw fail(StorageError.CODES.INTERNAL_ERROR, "The JARC server sent a response JARC can't use. Try again in a moment.", error);
      }
      return parsed;
    } finally { clearTimeout(timer); }
  }
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
    // Resource mode loads workspaces, boards and records from separate endpoints and returns them already split.
    if (this.adapter.loadResourceState) { const { data, user } = await this.adapter.loadResourceState(); return { data, user, source: "resource", migrated: false }; }
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
    // Resource mode sends only what changed (per workspace, board and record). It gets its own copy of the state,
    // and may return a reconcile (server IDs for new items, latest server data after a conflict) for the model.
    const resource = Boolean(this.adapter.commitState), snapshot = resource ? JSON.parse(JSON.stringify({ data, user })) : null;
    const run = async () => {
      if (generation !== this.generation) return { ok: false, code: StorageError.CODES.CANCELLED, message: "" };
      try {
        const outcome = resource ? await this.adapter.commitState(this.lastChangeFor(change), snapshot) : await this.adapter.writeAppState(text);
        this.setConnection("online");
        return { ok: true, reconcile: outcome?.reconcile || null };
      } catch (error) {
        this.generation += 1;
        const failure = StorageError.from(error);
        if (StorageError.describe(failure.code).offline) this.setConnection("offline");
        return { ok: false, code: failure.code, message: failure.message, reconcile: error?.reconcile || null };
      }
    };
    const result = this.queue.then(run);
    this.queue = result;
    return result;
  }

  lastChangeFor(change) { return JSON.parse(JSON.stringify(change)); }

  // Resource mode only: fetch a board's records (in order with saves). Other modes already hold every record.
  loadBoard(boardId, options) {
    const result = this.queue.then(() => this.adapter.loadBoardRecords(boardId, options));
    this.queue = result.catch(() => {});
    return result.then((value) => { this.setConnection("online"); return value; }, (error) => {
      const failure = StorageError.from(error);
      if (StorageError.describe(failure.code).offline) this.setConnection("offline");
      throw failure;
    });
  }
  boardLoadState(boardId) { return this.adapter.boardLoadState?.(boardId) || null; }

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

// Adapter selection. The server modes only work when the page is served by the JARC Express server (same origin,
// /api/v1):
//   ?storage=local     browser storage (always available when asked for explicitly)
//   ?storage=api       transitional whole-state API (GET/PUT /api/v1/state)
//   ?storage=resource  resource API backed by MongoDB (ResourceApiAdapter.js)
// Without ?storage=: the mode a Microsoft sign-in or sign-out redirect came from (EntraAuth), else the page's
// <meta name="jarc-storage-default">. That is "local" in site/index.html; the JARC server serves "resource" when
// Microsoft sign-in is configured (AUTH_MODE=entra, always so in production), so the deployed app opens in resource
// mode with Microsoft sign-in while local development keeps browser storage unless it opts in.
StorageService.defaultMode = (doc = typeof document !== "undefined" ? document : null) => {
  const value = doc?.querySelector?.('meta[name="jarc-storage-default"]')?.getAttribute("content");
  return value === "resource" ? "resource" : "local";
};
StorageService.createAdapter = (search = window.location.search, defaultMode = StorageService.defaultMode()) => {
  const mode = new URLSearchParams(search).get("storage") || (typeof EntraAuth !== "undefined" ? EntraAuth.pendingReturnMode() : null) || defaultMode;
  if (mode === "resource") {
    if (typeof ResourceApiAdapter === "undefined") throw new Error("Resource mode needs assets/ResourceApiAdapter.js.");
    return new ResourceApiAdapter();
  }
  return mode === "api" ? new ApiAdapter() : new LocalAsyncAdapter();
};

window.StorageError = StorageError;
window.LocalAsyncAdapter = LocalAsyncAdapter;
window.ApiAdapter = ApiAdapter;
window.StorageService = StorageService;
window.jarcStorage = new StorageService(StorageService.createAdapter());
