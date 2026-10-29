// Where attachment bytes live.
//
//   GridFsFileStore  MongoDB GridFS in the existing jarc_database (bucket "attachmentFiles": collections
//                    attachmentFiles.files and attachmentFiles.chunks, 255 KB chunks). Uploads and downloads stream;
//                    nothing is written to the server's own disk. The driver creates the bucket's indexes on first use.
//                    Every attachment stored before object storage existed is here, and stays here.
//   S3FileStore      a PRIVATE S3-compatible bucket (Railway Buckets in production; a local mock in tests). Objects are
//                    never public: JARC checks access, then streams the bytes. Keys are opaque ("att/<attachment ID>",
//                    or "mig/<run>/<ID>" for migrated files) and never contain file names. Size (and SHA-256 when known
//                    in advance) is verified by reading the object's metadata back after the upload.
//   MemoryFileStore  tests: the same interface in memory (never touches a real database or storage).
//
// Interface: openUpload(key, { filename, contentType, length, sha256? }) → writable stream with abort(), "finish" only
// once the bytes are durably stored; openDownload(key) → readable stream; stat(key) → { size, sha256 } | null;
// delete(key); listIds({ before }) → keys of stored files written before a date (for the orphan sweep).
const { GridFSBucket } = require("mongodb");
const { Writable, Readable, PassThrough } = require("stream");

const isNotFound = (error) => /file ?not ?found|FileNotFound|NoSuchKey|NotFound/i.test(`${error?.name || ""} ${error?.message || ""}`) || error?.code === "ENOENT" || error?.$metadata?.httpStatusCode === 404;
const missing = (message = "FileNotFound") => Object.assign(new Error(message), { code: "ENOENT" });

class GridFsFileStore {
  constructor(db, { bucketName = "attachmentFiles", Bucket = GridFSBucket } = {}) { Object.assign(this, { db, bucketName, Bucket }); }
  get provider() { return "gridfs"; }
  get bucket() { return (this._bucket ||= new this.Bucket(this.db, { bucketName: this.bucketName, chunkSizeBytes: 255 * 1024 })); }
  openUpload(id, { filename, contentType }) { return this.bucket.openUploadStreamWithId(id, filename, { metadata: { contentType } }); }
  openDownload(id) { return this.bucket.openDownloadStream(id); }
  async stat(id) { const [f] = await this.bucket.find({ _id: id }, { limit: 1 }).toArray(); return f ? { size: f.length, sha256: null } : null; }
  async delete(id) { try { await this.bucket.delete(id); } catch (error) { if (!isNotFound(error)) throw error; } }
  async listIds({ before, limit = 500 } = {}) { return (await this.bucket.find({ uploadDate: { $lt: before } }, { limit, projection: { _id: 1 } }).toArray()).map((f) => f._id); }
}

class S3FileStore {
  // client: an @aws-sdk/client-s3 S3Client; Upload: @aws-sdk/lib-storage's Upload (streamed multipart for large bodies).
  constructor({ client, bucket, Upload, commands, partSize = 8 * 1024 * 1024, queueSize = 2, sweepPrefix = "att/" }) {
    if (!client || !bucket || !Upload || !commands) throw new Error("S3FileStore needs a client, a bucket, Upload and the S3 commands.");
    Object.assign(this, { client, bucket, Upload, commands, partSize, queueSize, sweepPrefix });
  }
  get provider() { return "s3"; }
  openUpload(key, { contentType, length, sha256 = null }) {
    const body = new PassThrough();
    const params = { Bucket: this.bucket, Key: String(key), Body: body, ContentType: contentType, ...(sha256 ? { Metadata: { sha256 } } : {}) };
    const upload = new this.Upload({ client: this.client, params, partSize: this.partSize, queueSize: this.queueSize, leavePartsOnError: false });
    const done = upload.done();
    const store = this;
    const stream = new Writable({
      write(chunk, _encoding, callback) { if (!body.write(chunk)) body.once("drain", callback); else callback(); },
      final(callback) {
        body.end();
        done.then(async () => {
          const st = await store.stat(key);
          if (!st || st.size !== length) throw Object.assign(new Error("The stored object does not have the expected size."), { code: "STORE_VERIFY_FAILED" });
          if (sha256 && st.sha256 !== sha256) throw Object.assign(new Error("The stored object does not have the expected checksum."), { code: "STORE_VERIFY_FAILED" });
        }).then(() => callback(), (error) => callback(error));
      }
    });
    // A failed upload must never leave a writer waiting for "drain" forever.
    done.catch((error) => { if (!stream.writableFinished && !stream.destroyed) stream.destroy(error); });
    stream.abort = async () => { body.destroy(); await upload.abort().catch(() => {}); await store.delete(key).catch(() => {}); stream.destroy(); };
    return stream;
  }
  openDownload(key) {
    const out = new PassThrough();
    this.client.send(new this.commands.GetObjectCommand({ Bucket: this.bucket, Key: String(key) })).then((res) => {
      res.Body.on("error", (e) => out.destroy(e));
      res.Body.pipe(out);
    }, (error) => out.destroy(isNotFound(error) ? missing() : error));
    return out;
  }
  async stat(key) {
    try {
      const h = await this.client.send(new this.commands.HeadObjectCommand({ Bucket: this.bucket, Key: String(key) }));
      return { size: Number(h.ContentLength), sha256: h.Metadata?.sha256 || null };
    } catch (error) { if (isNotFound(error)) return null; throw error; }
  }
  async delete(key) { try { await this.client.send(new this.commands.DeleteObjectCommand({ Bucket: this.bucket, Key: String(key) })); } catch (error) { if (!isNotFound(error)) throw error; } }
  // Only the normal-upload prefix: migrated objects ("mig/") are owned by the migration's own recovery and rollback.
  async listIds({ before, limit = 500 } = {}) {
    const out = [];
    let token;
    do {
      const page = await this.client.send(new this.commands.ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.sweepPrefix, ContinuationToken: token, MaxKeys: 1000 }));
      for (const o of page.Contents || []) if (new Date(o.LastModified) < before) { out.push(o.Key); if (out.length >= limit) return out; }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}

// Builds an S3FileStore from validated settings (config.attachments.s3). Credentials stay on the server.
function createS3FileStore(settings) {
  const sdk = require("@aws-sdk/client-s3");
  const { Upload } = require("@aws-sdk/lib-storage");
  const client = new sdk.S3Client({
    endpoint: settings.endpoint, region: settings.region, forcePathStyle: settings.forcePathStyle,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    // S3-compatible services don't all accept the SDK's default per-request checksums; integrity is verified by
    // size + SHA-256 read-back instead.
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", maxAttempts: 4
  });
  return new S3FileStore({ client, bucket: settings.bucket, Upload, commands: sdk });
}

class MemoryFileStore {
  constructor({ provider = "gridfs" } = {}) { this.files = new Map(); this._provider = provider; }
  get provider() { return this._provider; }
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
    const stream = new Readable({ read() {} });
    process.nextTick(() => stream.destroy(missing()));
    return stream;
  }
  async stat(id) { const f = this.files.get(String(id)); return f ? { size: f.data.length, sha256: null } : null; }
  async delete(id) { this.files.delete(String(id)); }
  async listIds({ before, limit = 500 } = {}) { return [...this.files.values()].filter((f) => f.uploadDate < before).slice(0, limit).map((f) => f.id); }
}

// The stores an installation can read from, and the one new uploads go to. A file is always read and deleted through
// the provider recorded on its attachment document; documents without one are GridFS (everything stored before).
class AttachmentStorage {
  constructor({ stores, defaultProvider = "gridfs" }) {
    this.stores = new Map(Object.entries(stores).filter(([, s]) => s));
    if (!this.stores.has(defaultProvider)) throw new Error(`Attachment storage "${defaultProvider}" is selected but not configured.`);
    this.defaultProvider = defaultProvider;
  }
  providerOf(attachment) { return attachment?.storage?.provider || "gridfs"; }
  keyOf(attachment) { return attachment?.storage?.key ?? attachment._id; }
  store(provider) {
    const s = this.stores.get(provider);
    if (!s) throw Object.assign(new Error(`Attachment storage "${provider}" is not configured on this server.`), { code: "STORAGE_UNAVAILABLE" });
    return s;
  }
  forAttachment(attachment) { return this.store(this.providerOf(attachment)); }
  // Storage details for a new upload. GridFS keeps using the attachment ID itself (unchanged behaviour).
  forNew(id, { prefix = "att/" } = {}) {
    const provider = this.defaultProvider;
    return provider === "gridfs" ? { provider, key: id, record: undefined } : { provider, key: `${prefix}${id.toHexString()}`, record: { provider, key: `${prefix}${id.toHexString()}` } };
  }
}

module.exports = { GridFsFileStore, S3FileStore, MemoryFileStore, AttachmentStorage, createS3FileStore, isNotFound };
