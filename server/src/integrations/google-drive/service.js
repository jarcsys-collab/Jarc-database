// The one Google Drive connection that holds JARC's attachment files. Employees never need a Google account: they sign in
// with Microsoft, JARC checks their workspace role, and only this server talks to Google.
//
//   connect     a JARC administrator only. The OAuth state is random, stored server-side, single use, valid for 10 minutes
//               and bound to the provider, to the administrator's session and to the browser that started it (an HttpOnly
//               cookie, because Google's redirect can't carry the Strict session cookie). PKCE is used as well. The Google
//               account must be the one configured in GOOGLE_DRIVE_ACCOUNT_EMAIL.
//   check       before anything is saved: drive.file was granted, a refresh token came back, JARC's own folder exists, and a
//               small test file can be written, read back byte for byte, and removed.
//   folder      JARC creates its own folder. drive.file can't reach folders it didn't create, including any made by hand.
//   tokens      the refresh token is encrypted with AES-256-GCM (GOOGLE_DRIVE_TOKEN_KEY) in the integrations collection. The
//               access token stays in this process's memory. Neither is ever sent to a browser or written to a log.
//   refresh     one at a time. invalid_grant (revoked or expired) marks the connection "needs_reconnect" and stops: uploads
//               and downloads answer 503 until an administrator reconnects. Temporary failures retry with backoff.
//   disconnect  JARC forgets the token. It only revokes at Google while no attachment is stored in Drive: Google says revoking
//               removes everything granted to the project, and nothing Google publishes says drive.file access to existing files
//               returns afterwards. With attachments there, an administrator can still revoke in the Google account, knowingly.
//   reconnect   checks a sample of existing files and warns if any can't be reached, so lost access can't go unnoticed.
const crypto = require("crypto");
const { ApiError } = require("../../middleware/errors");
const { randomToken, encrypt, decrypt, sameText } = require("../monday/secrets");
const { DriveClient } = require("./client");
const { GoogleDriveFileStore, KIND } = require("./file-store");

const PROVIDER = "google-drive";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const FOLDER_NAME = "JARC Attachments";
const STATE_TTL_MS = 10 * 60 * 1000;
const EXPIRY_MARGIN_MS = 60 * 1000;
const TOKEN_RETRIES = 3;

const fail = (status, code, message) => new ApiError(status, code, message);
const notConnected = () => fail(503, "STORAGE_NOT_CONNECTED", "JARC's Google Drive storage isn't connected. Ask a JARC administrator to reconnect it.");
const sha256 = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");
const iso = (date) => date?.toISOString?.() || null;

class GoogleDriveService {
  constructor({ repos, config, fetch = globalThis.fetch, logger = console, now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), activeForUploads = false, chunkBytes }) {
    Object.assign(this, { repos, config, fetchImpl: fetch, logger, now, sleep, activeForUploads, cached: null, refreshing: null, generation: 0 });
    this.client = this.newClient({ getToken: () => this.accessToken(), invalidateToken: () => { this.cached = null; } });
    this.store = new GoogleDriveFileStore({ open: () => this.open(), isConnected: () => this.isConnected(), ...(chunkBytes ? { chunkBytes } : {}) });
    this.chunkBytes = chunkBytes;
  }
  newClient(auth) { return new DriveClient({ ...auth, fetch: this.fetchImpl, sleep: this.sleep }); }
  record() { return this.repos.integrations.get(PROVIDER); }
  usable(rec) { return Boolean(rec?.refreshToken && rec.folderId && rec.status === "connected"); }
  async isConnected() { return this.usable(await this.record()); }
  async open() {
    const rec = await this.record();
    if (!this.usable(rec)) throw notConnected();
    return { client: this.client, folderId: rec.folderId };
  }

  // Administrators only (routes/google-drive.js). No secrets.
  async status() {
    const rec = await this.record(), connected = Boolean(rec?.refreshToken);
    return {
      provider: PROVIDER, enabled: true, connected, state: !connected ? "not_connected" : rec.status === "needs_reconnect" ? "needs_reconnect" : "connected",
      activeForNewUploads: this.activeForUploads, configuredAccount: this.config.accountEmail,
      account: connected ? { email: rec.accountEmail || null, connectedAt: iso(rec.connectedAt), connectedByName: rec.connectedByName || null } : null,
      folder: rec?.folderId ? { name: rec.folderName || FOLDER_NAME, url: `https://drive.google.com/drive/folders/${encodeURIComponent(rec.folderId)}` } : null,
      lastCheckedAt: iso(rec?.lastCheckedAt), lastError: rec?.lastError || null, lastErrorAt: iso(rec?.lastErrorAt)
    };
  }

  // ---- Connecting
  async startConnect(actor) {
    const id = randomToken(32), browserSecret = randomToken(32), verifier = randomToken(48), now = this.now();
    await this.repos.integrations.saveState({ _id: id, provider: PROVIDER, userId: actor.userId, sessionId: actor.sessionId ?? null, browserHash: sha256(browserSecret), verifier: encrypt(verifier, this.config.tokenKey), createdAt: now, expiresAt: new Date(now.getTime() + STATE_TTL_MS) });
    const url = new URL(AUTHORIZE_URL);
    const params = { client_id: this.config.clientId, redirect_uri: this.config.redirectUri, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state: id, login_hint: this.config.accountEmail, code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return { authorizeUrl: url.toString(), browserSecret };
  }

  // The return from Google. stillAdmin(saved) re-checks that the person who started this may still manage integrations.
  async completeConnect({ code, state, error, browserSecret, stillAdmin }) {
    if (typeof state !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(state)) throw fail(400, "OAUTH_STATE_INVALID", "This sign-in link is invalid. Start again from JARC.");
    const saved = await this.repos.integrations.takeState(state, this.now(), PROVIDER);
    if (!saved) throw fail(400, "OAUTH_STATE_INVALID", "This sign-in link has expired or was already used. Start again from JARC.");
    if (typeof browserSecret !== "string" || !sameText(sha256(browserSecret), saved.browserHash)) throw fail(403, "OAUTH_BROWSER_MISMATCH", "Finish connecting in the browser that started it.");
    if (!await stillAdmin(saved)) throw fail(403, "FORBIDDEN", "The administrator who started this connection can't complete it.");
    if (error !== undefined) return { cancelled: true };
    if (typeof code !== "string" || !code || code.length > 2000) throw fail(400, "OAUTH_CODE_MISSING", "Google didn't send an authorization code.");

    const tokens = await this.exchange(code, decrypt(saved.verifier, this.config.tokenKey));
    // Not revoked: this may be the same account as a working connection, whose grant a revocation would also end.
    if (!String(tokens.scope || "").split(/\s+/).includes(SCOPE)) throw fail(400, "GDRIVE_SCOPE_DENIED", "Google Drive access wasn't granted. Connect again and allow it.");
    if (!tokens.refresh_token) throw fail(502, "GDRIVE_NO_REFRESH_TOKEN", "Google didn't provide long-term access. Connect again.");
    const client = this.newClient({ getToken: async () => tokens.access_token });
    let about;
    try { about = await client.about(); } catch { throw fail(502, "GDRIVE_CHECK_FAILED", "Google Drive didn't answer. Try again."); }
    const email = String(about?.user?.emailAddress || "").toLowerCase(), previous = await this.record();
    // A different account has its own grant, so revoking it can't affect the configured one.
    if (email !== this.config.accountEmail) { await this.revoke(tokens.refresh_token); throw fail(403, "GDRIVE_WRONG_ACCOUNT", "That isn't the Google account configured for JARC's attachments."); }
    if (previous?.accountPermissionId && about.user.permissionId !== previous.accountPermissionId) { await this.revoke(tokens.refresh_token); throw fail(409, "GDRIVE_ACCOUNT_CHANGED", "JARC's existing files belong to a different Google account, which this one couldn't reach."); }

    let folder;
    try { folder = await this.ensureFolder(client, previous?.folderId); await this.probe(client, folder.id); }
    catch (cause) { this.logger.error(`[google-drive] connection check failed: ${cause?.code || cause?.name || "Error"}`); throw fail(502, "GDRIVE_CHECK_FAILED", "Google Drive didn't pass the connection check. Nothing was saved. Try again."); }

    const warning = await this.reachability(client) ? "GDRIVE_FILES_UNREACHABLE" : previous?.folderId && previous.folderId !== folder.id ? "GDRIVE_FOLDER_REPLACED" : null;
    if (warning) this.logger.error(`[google-drive] ${warning}`);
    const user = await this.repos.users.findById(saved.userId), now = this.now();
    await this.repos.integrations.set(PROVIDER, {
      refreshToken: encrypt(tokens.refresh_token, this.config.tokenKey), status: "connected", scope: SCOPE, accountEmail: email, accountPermissionId: about.user.permissionId || null,
      folderId: folder.id, folderName: folder.name || FOLDER_NAME, connectedBy: saved.userId, connectedByName: user?.displayName || user?.email || null, connectedAt: now, lastCheckedAt: now, lastError: warning, lastErrorAt: warning ? now : null
    });
    this.generation += 1;
    this.cached = tokens.expires_in ? { token: tokens.access_token, expiresAt: now.getTime() + Number(tokens.expires_in) * 1000, generation: this.generation } : null;
    this.logger.log?.(`[google-drive] connected by user ${String(saved.userId)}`);
    return { connected: true };
  }

  async exchange(code, verifier) {
    const body = new URLSearchParams({ grant_type: "authorization_code", client_id: this.config.clientId, client_secret: this.config.clientSecret, code, code_verifier: verifier, redirect_uri: this.config.redirectUri });
    for (let attempt = 0; ; attempt += 1) {
      let res = null;
      try { res = await this.fetchImpl(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: body.toString(), signal: AbortSignal.timeout(30000) }); } catch { /* retried below */ }
      if (res?.ok) { const tokens = await res.json().catch(() => null); if (tokens?.access_token) return tokens; }
      // A refused code is final: it can only be used once.
      if ((res && res.status < 500 && res.status !== 429) || attempt >= TOKEN_RETRIES - 1) throw fail(502, "OAUTH_EXCHANGE_FAILED", "Google didn't complete the connection. Try again.");
      await this.sleep(250 * 2 ** attempt);
    }
  }

  // The folder JARC already has (kept across reconnects), or the one it created earlier, or a new one.
  async ensureFolder(client, folderId) {
    if (folderId) {
      try { const f = await client.getFile(folderId, "id,name,trashed"); if (!f.trashed) return f; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return (await client.findFolder()) || client.createFolder(FOLDER_NAME);
  }
  // Writes, reads back and removes a small file, through the same code as real attachments.
  async probe(client, folderId) {
    const store = new GoogleDriveFileStore({ open: async () => ({ client, folderId }), ...(this.chunkBytes ? { chunkBytes: this.chunkBytes } : {}) });
    const content = Buffer.from(`JARC connection check ${randomToken(16)}`), key = await client.generateId();
    try {
      await new Promise((resolve, reject) => {
        const upload = store.openUpload(key, { contentType: "text/plain", length: content.length, kind: KIND.probe });
        upload.on("error", reject); upload.on("finish", resolve); upload.end(content);
      });
      const chunks = [];
      for await (const chunk of store.openDownload(key)) chunks.push(chunk);
      if (!Buffer.concat(chunks).equals(content)) throw Object.assign(new Error("The test file came back different."), { code: "GDRIVE_PROBE_MISMATCH" });
    } finally { await client.deleteForever(key).catch(() => {}); }
  }

  // How many of a sample of stored attachments Google says don't exist. A failure to check counts as nothing found.
  async reachability(client) {
    try {
      let unreachable = 0;
      for (const doc of await this.repos.attachments.sampleInProvider("gdrive")) await client.getFile(doc.storage.key, "id").catch((error) => { if (error.code === "ENOENT") unreachable += 1; else throw error; });
      return unreachable;
    } catch (error) { this.logger.error(`[google-drive] files couldn't be checked: ${error?.code || error?.name || "Error"}`); return 0; }
  }
  async disconnect() {
    const rec = await this.record();
    let token = null;
    try { token = rec?.refreshToken ? decrypt(rec.refreshToken, this.config.tokenKey) : null; } catch { /* a replaced key: nothing can be revoked */ }
    const keepsGrant = await this.repos.attachments.countInProvider("gdrive") > 0;
    this.generation += 1; this.cached = null;
    await this.repos.integrations.set(PROVIDER, { status: "disconnected", disconnectedAt: this.now(), lastError: null, lastErrorAt: null });
    await this.repos.integrations.unset(PROVIDER, ["refreshToken"]);
    if (token && !keepsGrant) await this.revoke(token);
    return { connected: false, revoked: Boolean(token && !keepsGrant) };
  }
  async revoke(token) {
    try { await this.fetchImpl(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString(), signal: AbortSignal.timeout(15000) }); }
    catch { this.logger.error("[google-drive] the token couldn't be revoked at Google; JARC has forgotten it"); }
  }
  // Reads the account and the folder through the stored connection, which refreshes the token if needed.
  async test() {
    const { client, folderId } = await this.open();
    const about = await client.about();
    const folder = await client.getFile(folderId, "id,trashed").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!folder || folder.trashed) { await this.noteError("GDRIVE_FOLDER_MISSING"); throw fail(409, "GDRIVE_FOLDER_MISSING", "JARC's Google Drive folder is missing or in Trash. Restore it, or reconnect to create a new one for new files."); }
    if (await this.reachability(client)) { await this.noteError("GDRIVE_FILES_UNREACHABLE", { lastCheckedAt: this.now() }); throw fail(409, "GDRIVE_FILES_UNREACHABLE", "Google Drive answers, but some of JARC's existing files can't be reached."); }
    await this.repos.integrations.set(PROVIDER, { lastCheckedAt: this.now(), lastError: null, lastErrorAt: null });
    return { ok: true, account: about?.user?.emailAddress || null };
  }
  async noteError(code, extra = {}) { await this.repos.integrations.set(PROVIDER, { lastError: code, lastErrorAt: this.now(), ...extra }).catch(() => {}); this.logger.error(`[google-drive] ${code}`); }

  // ---- Access tokens
  async accessToken() {
    if (this.cached && this.cached.generation === this.generation && this.cached.expiresAt - EXPIRY_MARGIN_MS > this.now().getTime()) return this.cached.token;
    this.refreshing ||= this.refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async refresh() {
    const generation = this.generation, rec = await this.record();
    if (!this.usable(rec)) throw notConnected();
    let refreshToken;
    try { refreshToken = decrypt(rec.refreshToken, this.config.tokenKey); }
    catch { await this.noteError("GDRIVE_TOKEN_KEY_MISMATCH", { status: "needs_reconnect" }); throw notConnected(); }
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: this.config.clientId, client_secret: this.config.clientSecret, refresh_token: refreshToken }).toString();
    for (let attempt = 0; ; attempt += 1) {
      let res = null, data = null;
      try { res = await this.fetchImpl(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body, signal: AbortSignal.timeout(30000) }); data = await res.json().catch(() => null); } catch { res = null; }
      if (res?.ok && data?.access_token) {
        if (generation !== this.generation) throw notConnected(); // disconnected or reconnected while this was running
        const set = { ...(data.refresh_token && data.refresh_token !== refreshToken ? { refreshToken: encrypt(data.refresh_token, this.config.tokenKey) } : {}), ...(String(rec.lastError || "").startsWith("GDRIVE_REFRESH_") ? { lastError: null, lastErrorAt: null } : {}) }; // only a token problem is cleared by a working token
        if (Object.keys(set).length) await this.repos.integrations.set(PROVIDER, set);
        this.cached = { token: data.access_token, expiresAt: this.now().getTime() + Number(data.expires_in || 3600) * 1000, generation };
        return data.access_token;
      }
      if (data?.error === "invalid_grant") { await this.noteError("GDRIVE_ACCESS_REVOKED", { status: "needs_reconnect" }); throw notConnected(); }
      // A problem with JARC's own client settings won't fix itself; temporary ones are tried again.
      if (res && res.status < 500 && res.status !== 429) { await this.noteError(`GDRIVE_REFRESH_${String(data?.error || res.status).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 30).toUpperCase()}`); throw fail(503, "STORAGE_UNAVAILABLE", "Google Drive isn't available right now. Ask a JARC administrator to check the connection."); }
      if (attempt >= TOKEN_RETRIES - 1) throw fail(503, "STORAGE_UNAVAILABLE", "Google Drive isn't available right now. Try again in a moment.");
      await this.sleep(250 * 2 ** attempt);
    }
  }
}

module.exports = { GoogleDriveService, PROVIDER, SCOPE, FOLDER_NAME };
