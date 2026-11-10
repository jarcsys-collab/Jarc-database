// Google Drive v3 over HTTPS, with no Google library. Everything here is on the server: employees never talk to Google.
//
//   retries   network errors, timeouts, 429, 500/502/503/504 and rate-limit 403s, with backoff (Retry-After honoured, up
//             to 30 s). A 401 gets one new access token, then one more try.
//   errors    a caller only ever sees: ENOENT (Google says the file doesn't exist), 507 STORAGE_FULL, or 503
//             STORAGE_UNAVAILABLE. Google's own text, URLs and tokens never leave this file.
//   uploads   Google's resumable protocol in chunks. The current chunk stays in memory so an interrupted chunk can continue
//             from what Google confirms it received.
const { ApiError } = require("../../middleware/errors");

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "sharingRateLimitExceeded"]);
const QUOTA_REASONS = new Set(["storageQuotaExceeded", "quotaExceeded"]);
const MAX_RETRY_WAIT_MS = 30 * 1000;

const unavailable = (driveStatus = null, driveReason = null) => Object.assign(new ApiError(503, "STORAGE_UNAVAILABLE", "Google Drive isn't available right now. Try again in a moment."), { driveStatus, driveReason });
const storageFull = () => Object.assign(new ApiError(507, "STORAGE_FULL", "The Google Drive account that holds JARC's files is full. Ask an administrator to free up space."), { driveStatus: 403 });
const missing = () => Object.assign(new Error("FileNotFound"), { code: "ENOENT", driveStatus: 404 });

// Drive's error body names a reason ({ error: { errors: [{ reason }] } }); nothing else from it is used.
async function reasonOf(res) {
  try { const body = await res.json(); return body?.error?.errors?.[0]?.reason || body?.error?.status || null; } catch { return null; }
}
function failure(status, reason) {
  if (status === 404) return missing();
  if (QUOTA_REASONS.has(reason)) return storageFull();
  return unavailable(status, reason);
}
const retryAfterMs = (res) => { const seconds = Number(res?.headers?.get?.("retry-after")); return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_WAIT_MS) : null; };
const appKindQuery = (kind) => `appProperties has { key='jarcKind' and value='${kind}' }`;

class DriveClient {
  // getToken: () => a current access token (the service refreshes it); invalidateToken: forget it after a 401.
  constructor({ getToken, invalidateToken = () => {}, fetch = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxRetries = 3, timeoutMs = 30000, uploadTimeoutMs = 120000 }) {
    Object.assign(this, { getToken, invalidateToken, fetchImpl: fetch, sleep, maxRetries, timeoutMs, uploadTimeoutMs });
  }
  backoff(attempt, hint) { return this.sleep(hint ?? Math.min(250 * 2 ** attempt + Math.floor(Math.random() * 100), MAX_RETRY_WAIT_MS)); }
  // The timeout covers the time until Google starts answering; a long download isn't cut off by it.
  async send(url, init, { signal = null, timeoutMs = this.timeoutMs } = {}) {
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), timeoutMs);
    try { return await this.fetchImpl(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal }); } finally { clearTimeout(timer); }
  }

  // One authorised request. Returns the response when it succeeded, or throws (see the errors note above).
  async call(url, init = {}, { signal = null } = {}) {
    let renewed = false;
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.getToken(); // its own failure (not connected) is final
      let res;
      try { res = await this.send(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } }, { signal }); }
      catch {
        if (signal?.aborted || attempt >= this.maxRetries) throw unavailable();
        await this.backoff(attempt);
        continue;
      }
      if (res.ok) return res;
      if (res.status === 401 && !renewed) { renewed = true; this.invalidateToken(); await res.arrayBuffer().catch(() => {}); attempt -= 1; continue; }
      const reason = await reasonOf(res);
      const retry = RETRY_STATUS.has(res.status) || (res.status === 403 && RATE_REASONS.has(reason));
      if (!retry || attempt >= this.maxRetries) throw failure(res.status, reason);
      await this.backoff(attempt, retryAfterMs(res));
    }
  }
  async json(url, init, options) { return (await this.call(url, init, options)).json(); }
  jsonBody(method, body) { return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }

  about() { return this.json(`${API}/about?fields=${encodeURIComponent("user(emailAddress,permissionId)")}`); }
  async generateId() { const { ids } = await this.json(`${API}/files/generateIds?count=1&fields=ids`); if (!ids?.[0]) throw unavailable(); return ids[0]; }
  getFile(id, fields) { return this.json(`${API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`); }

  // The folder JARC created earlier for this account, if any. drive.file only ever lists what this app can access.
  async findFolder() {
    const q = `mimeType='${FOLDER_MIME}' and trashed=false and ${appKindQuery("folder")}`;
    const { files } = await this.json(`${API}/files?q=${encodeURIComponent(q)}&pageSize=1&orderBy=createdTime&fields=${encodeURIComponent("files(id,name)")}`);
    return files?.[0] || null;
  }
  // A pre-generated ID makes a retried create safe: if it already happened, Google answers 409.
  async createFolder(name) {
    const id = await this.generateId();
    try { return await this.json(`${API}/files?fields=id,name`, this.jsonBody("POST", { id, name, mimeType: FOLDER_MIME, appProperties: { jarcKind: "folder" } })); }
    catch (error) { if (error.driveStatus === 409) return this.getFile(id, "id,name"); throw error; }
  }
  // One page of "active" files of one kind, created before a date (the orphan sweep). Trashed and removed files never appear.
  // A page token only works with the same `before` it started with.
  async listKeys({ kind, before, limit = 500, pageToken = null }) {
    const q = `trashed=false and ${appKindQuery(kind)} and createdTime < '${before.toISOString()}'`;
    const page = await this.json(`${API}/files?q=${encodeURIComponent(q)}&pageSize=${Math.min(limit, 1000)}&fields=${encodeURIComponent("nextPageToken,files(id)")}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    return { keys: (page.files || []).map((f) => f.id), nextPageToken: page.nextPageToken || null };
  }
  // To Google Drive Trash, marked "removed" so that a file an administrator restores in Drive is left alone by the sweep.
  async trash(id) {
    try { await this.call(`${API}/files/${encodeURIComponent(id)}?fields=id`, this.jsonBody("PATCH", { trashed: true, appProperties: { jarcKind: "removed" } })); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  // Only for the connection check's own test file, which never held anyone's data.
  async deleteForever(id) {
    try { await this.call(`${API}/files/${encodeURIComponent(id)}`, { method: "DELETE" }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  download(id, { signal = null } = {}) { return this.call(`${API}/files/${encodeURIComponent(id)}?alt=media`, {}, { signal }); }

  // ---- Resumable upload
  async startUpload({ metadata, contentType, length }) {
    const res = await this.call(`${UPLOAD_API}/files?uploadType=resumable&fields=${encodeURIComponent("id,size,sha256Checksum")}`, {
      method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": contentType, "X-Upload-Content-Length": String(length) }, body: JSON.stringify(metadata)
    }).catch((error) => { throw error.code === "ENOENT" ? unavailable(404) : error; }); // here a 404 means JARC's folder, not the new file
    const session = res.headers.get("location");
    if (!session || !session.startsWith("https://")) throw unavailable();
    return session;
  }
  // What the session reports: { done: file } when finished, otherwise { next: the first byte Google still needs }.
  async readProgress(res) {
    if (res.status === 200 || res.status === 201) return { done: await res.json() };
    if (res.status === 308) { await res.arrayBuffer().catch(() => {}); const m = /^bytes=0-(\d+)$/.exec(res.headers.get("range") || ""); return { next: m ? Number(m[1]) + 1 : 0 }; }
    return null;
  }
  // Sends bytes [start, start + chunk.length) of a file of `total` bytes. Returns the finished file's metadata, or null
  // when Google wants more. An expired or refused session can't be continued: the upload fails and can be repeated.
  async sendChunk(session, chunk, start, total) {
    let offset = start, failures = 0, probing = false;
    const end = start + chunk.length;
    for (;;) {
      let res = null;
      try {
        res = probing
          ? await this.send(session, { method: "PUT", redirect: "manual", headers: { "Content-Range": `bytes */${total}` } }, { timeoutMs: this.timeoutMs })
          : await this.send(session, { method: "PUT", redirect: "manual", headers: { "Content-Range": `bytes ${offset}-${end - 1}/${total}` }, body: chunk.subarray(offset - start) }, { timeoutMs: this.uploadTimeoutMs }); // Drive's 308 means "resume incomplete"; it is never followed as a redirect
      } catch { res = null; }
      const progress = res ? await this.readProgress(res).catch(() => null) : null;
      if (progress?.done) return progress.done;
      if (progress) {
        // A session can't report less than the start of this chunk: the earlier chunks were already confirmed.
        if (progress.next < start) throw unavailable(res.status);
        if (progress.next >= end) return null;
        const moved = progress.next > offset, wasProbing = probing;
        offset = progress.next; probing = false;
        if (moved) failures = 0;
        // Bytes were sent and Google kept none of them: that counts as a failure, or this could go on forever.
        else if (!wasProbing && (failures += 1) > this.maxRetries) throw unavailable(res.status);
        continue;
      }
      if (res && !RETRY_STATUS.has(res.status)) throw failure(res.status === 404 ? 410 : res.status, await reasonOf(res));
      failures += 1;
      if (failures > this.maxRetries) throw unavailable(res?.status ?? null);
      await this.backoff(failures - 1, retryAfterMs(res));
      probing = true; // ask how much arrived before sending anything again
    }
  }
  async cancelUpload(session) { try { await this.send(session, { method: "DELETE", redirect: "manual" }); } catch { /* it expires by itself after a week */ } }
}

module.exports = { DriveClient, FOLDER_MIME, unavailable, storageFull, missing };
