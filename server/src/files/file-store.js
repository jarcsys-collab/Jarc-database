// Where attachment bytes live.
//
//   GridFsFileStore  production: MongoDB GridFS in the existing jarc_database (bucket "attachmentFiles": collections
//                    attachmentFiles.files and attachmentFiles.chunks, 255 KB chunks). Uploads and downloads stream;
//                    nothing is written to the server's own disk. The driver creates the bucket's indexes on first use.
//   MemoryFileStore  tests: the same interface in memory (never touches a real database or storage).
//
// Interface: openUpload(id, { filename, contentType }) → writable stream with abort(); openDownload(id) → readable
// stream; delete(id); listIds({ before }) → IDs of stored files written before a date (for the orphan sweep).
const { GridFSBucket } = require("mongodb");
const { Writable, Readable } = require("stream");

const isNotFound = (error) => /file ?not ?found|FileNotFound/i.test(error?.message || "") || error?.code === "ENOENT";

class GridFsFileStore {
  constructor(db, { bucketName = "attachmentFiles", Bucket = GridFSBucket } = {}) { Object.assign(this, { db, bucketName, Bucket }); }
  get bucket() { return (this._bucket ||= new this.Bucket(this.db, { bucketName: this.bucketName, chunkSizeBytes: 255 * 1024 })); }
  openUpload(id, { filename, contentType }) { return this.bucket.openUploadStreamWithId(id, filename, { metadata: { contentType } }); }
  openDownload(id) { return this.bucket.openDownloadStream(id); }
  async delete(id) { try { await this.bucket.delete(id); } catch (error) { if (!isNotFound(error)) throw error; } }
  async listIds({ before, limit = 500 } = {}) { return (await this.bucket.find({ uploadDate: { $lt: before } }, { limit, projection: { _id: 1 } }).toArray()).map((f) => f._id); }
}

class MemoryFileStore {
  constructor() { this.files = new Map(); }
  openUpload(id, { filename, contentType }) {
    const chunks = []; let aborted = false;
    const store = this;
    const stream = new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
      final(callback) { if (!aborted) store.files.set(String(id), { id, data: Buffer.concat(chunks), filename, contentType, uploadDate: new Date() }); callback(); }
    });
    stream.abort = async () => { aborted = true; store.files.delete(String(id)); stream.destroy(); };
    return stream;
  }
  openDownload(id) {
    const file = this.files.get(String(id));
    if (file) return Readable.from([file.data]);
    const missing = new Readable({ read() {} });
    process.nextTick(() => missing.destroy(Object.assign(new Error("FileNotFound"), { code: "ENOENT" })));
    return missing;
  }
  async delete(id) { this.files.delete(String(id)); }
  async listIds({ before, limit = 500 } = {}) { return [...this.files.values()].filter((f) => f.uploadDate < before).slice(0, limit).map((f) => f.id); }
}

module.exports = { GridFsFileStore, MemoryFileStore, isNotFound };
