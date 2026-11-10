// Attachment bytes in Google Drive (provider "gdrive"), behind the same interface as the other stores (files/file-store.js).
//
//   keys      the Drive file ID, generated before the upload, so the pending attachment document always knows its file.
//   names     in Drive a file is "<attachment ID>.<ext>", never its original name; people see the original name in JARC,
//             where it is kept on the attachment document.
//   kinds     appProperties.jarcKind says what a file is: att (a normal upload), mig (a migrated file, also tagged with its
//             run in jarcRun), probe (the connection check), removed (moved to Trash by JARC). The orphan sweep only ever
//             considers "att", so a file an administrator restores from Trash is never removed again, and migrated files
//             belong to their run's recovery and rollback alone.
//   delete    moves to Google Drive Trash, so it can be recovered there. Never a permanent delete.
//   checks    the size always, and the SHA-256 whenever Google reports one, are compared after the upload.
const crypto = require("crypto");
const { Writable, Readable, PassThrough } = require("stream");
const { MIGRATION_TYPES } = require("../../files/file-types");
const { unavailable } = require("./client");

const CHUNK_BYTES = 2 * 1024 * 1024; // Google requires multiples of 256 KB for every chunk but the last
const KIND = Object.freeze({ attachment: "att", migration: "mig", probe: "probe" });
// Extra appProperties a caller may add (e.g. jarcRun): JARC's own names and short plain values only.
const TAG_NAME = /^jarc[A-Z][A-Za-z]{1,20}$/, TAG_VALUE = /^[A-Za-z0-9._:-]{1,100}$/;
const safeTags = (tags) => Object.fromEntries(Object.entries(tags || {}).filter(([k, v]) => TAG_NAME.test(k) && !["jarcKind", "jarcAttachmentId"].includes(k) && TAG_VALUE.test(String(v))).map(([k, v]) => [k, String(v)]));
const verifyFailed = (message) => Object.assign(new Error(message), { code: "STORE_VERIFY_FAILED" });

class GoogleDriveFileStore {
  // open: async () => ({ client, folderId }), or throws when Drive isn't connected (503 STORAGE_NOT_CONNECTED).
  // isConnected: async () => boolean, for background work that should simply wait.
  constructor({ open, isConnected = async () => true, chunkBytes = CHUNK_BYTES }) {
    if (chunkBytes % (256 * 1024) !== 0) throw new Error("Google Drive upload chunks must be multiples of 256 KB.");
    Object.assign(this, { open, isConnected, chunkBytes });
  }
  get provider() { return "gdrive"; }
  async ready() { await this.open(); }
  async newKey() { const { client } = await this.open(); return client.generateId(); }

  openUpload(key, { contentType, length, sha256 = null, attachmentId = null, kind = KIND.attachment, tags = null }) {
    if (!Object.values(KIND).includes(kind)) throw new Error("Unknown Google Drive file kind.");
    const store = this, hash = crypto.createHash("sha256");
    let pending = [], pendingBytes = 0, sent = 0, session = null, client = null, finished = null;
    const begin = async () => {
      if (session) return;
      const drive = await store.open();
      client = drive.client;
      const extension = MIGRATION_TYPES[contentType]?.extensions[0];
      const metadata = { id: String(key), name: `${attachmentId ? String(attachmentId) : key}${extension ? `.${extension}` : ""}`, parents: [drive.folderId], mimeType: contentType, appProperties: { ...safeTags(tags), jarcKind: kind, ...(attachmentId ? { jarcAttachmentId: String(attachmentId) } : {}) } };
      session = await client.startUpload({ metadata, contentType, length });
    };
    const flush = async (last) => {
      const buffered = Buffer.concat(pending, pendingBytes);
      const size = last ? pendingBytes : Math.floor(pendingBytes / store.chunkBytes) * store.chunkBytes;
      if (!size) return;
      if (sent + size > length) throw verifyFailed("More bytes arrived than the file's announced size.");
      await begin();
      finished = await client.sendChunk(session, buffered.subarray(0, size), sent, length);
      sent += size;
      const rest = buffered.subarray(size);
      pending = rest.length ? [rest] : []; pendingBytes = rest.length;
    };
    const verify = () => {
      if (!finished) throw verifyFailed("Google Drive didn't confirm the finished file.");
      const digest = hash.digest("hex");
      if (finished.id !== String(key)) throw verifyFailed("Google Drive stored the file under a different ID.");
      if (Number(finished.size) !== length) throw verifyFailed("The stored file does not have the expected size.");
      if (finished.sha256Checksum && finished.sha256Checksum !== digest) throw verifyFailed("The stored file does not have the expected checksum.");
      if (sha256 && digest !== sha256) throw verifyFailed("The stored file does not have the expected checksum.");
    };
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        hash.update(chunk); pending.push(chunk); pendingBytes += chunk.length;
        if (pendingBytes < store.chunkBytes) return callback();
        return flush(false).then(() => callback(), callback);
      },
      final(callback) { flush(true).then(verify).then(() => callback(), callback); }
    });
    stream.abort = async () => { if (session && client && !finished) await client.cancelUpload(session); stream.destroy(); };
    return stream;
  }

  openDownload(key) {
    const out = new PassThrough(), stop = new AbortController();
    out.once("close", () => stop.abort());
    (async () => {
      const { client } = await this.open();
      const res = await client.download(String(key), { signal: stop.signal });
      const body = Readable.fromWeb(res.body);
      body.on("error", () => out.destroy(unavailable()));
      body.pipe(out);
    })().catch((error) => out.destroy(error));
    return out;
  }
  async stat(key) {
    const { client } = await this.open();
    try { const f = await client.getFile(String(key), "size,sha256Checksum"); return { size: Number(f.size), sha256: f.sha256Checksum || null }; }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async delete(key) { const { client } = await this.open(); await client.trash(String(key)); }
  // Nothing is listed (and so nothing is cleaned up) while Drive isn't connected. One page per sweep, continuing where the last
  // sweep stopped, so that with many files every one is reached in turn.
  async listIds({ before, limit = 500 } = {}) {
    if (!await this.isConnected()) return [];
    const { client } = await this.open();
    this.sweepCycle ||= { before, pageToken: null };
    const cycle = this.sweepCycle;
    try {
      const { keys, nextPageToken } = await client.listKeys({ kind: KIND.attachment, before: cycle.before, limit, pageToken: cycle.pageToken });
      this.sweepCycle = nextPageToken ? { before: cycle.before, pageToken: nextPageToken } : null;
      return keys;
    } catch (error) { this.sweepCycle = null; throw error; }
  }
  // For migration runs: the account's free space, and the files one run created (by their jarcRun tag).
  async quota() { const { client } = await this.open(); return client.quota(); }
  async runFiles(runId) { const { client } = await this.open(); return client.listTagged("jarcRun", runId); }
}

module.exports = { GoogleDriveFileStore, KIND, CHUNK_BYTES };
