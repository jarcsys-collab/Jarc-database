// storageUsage collection: one counter document per storage provider, { _id: provider, usedBytes, reservedBytes }.
// Replaces reading every attachment document on every upload. Concurrency-safe without transactions:
//
//   reserve   atomically adds the file's size to reservedBytes, then checks the total the update returned; over the
//             limit → the reservation is taken back and the upload refused. Concurrent uploads near the limit may both
//             be refused, but the stored total can never exceed it.
//   commit    a finished upload moves its size from reserved to used; release gives a failed one back; free removes a
//             deleted file's size.
//   ensure    the first use on an installation counts what is already stored (ready + pending attachments of that
//             provider) — existing GridFS files are included, nothing is lost or reset.
//   reconcile recounts from the attachment documents (an administrator's maintenance step; run when uploads are quiet).
// One stored object = one attachment document (duplicate references share it), so nothing is counted twice.
const { COLLECTIONS } = require("../../db/bootstrap");

class StorageUsageRepository {
  constructor(db) { this.collection = db.collection(COLLECTIONS.storageUsage); this.attachments = db.collection(COLLECTIONS.attachments); }

  async count(provider) {
    const used = { status: "ready" }, pending = { status: "pending" };
    const scope = provider === "gridfs" ? { $or: [{ "storage.provider": "gridfs" }, { storage: { $exists: false } }] } : { "storage.provider": provider };
    let usedBytes = 0, reservedBytes = 0;
    for (const d of await this.attachments.find({ ...scope, ...used }, { projection: { size: 1 }, limit: 10000000 }).toArray()) usedBytes += Number(d.size) || 0;
    for (const d of await this.attachments.find({ ...scope, ...pending }, { projection: { size: 1 }, limit: 10000000 }).toArray()) reservedBytes += Number(d.size) || 0;
    return { usedBytes, reservedBytes };
  }
  async ensure(provider) {
    const doc = await this.collection.findOne({ _id: provider });
    if (doc) return doc;
    const counted = await this.count(provider);
    await this.collection.updateOne({ _id: provider }, { $setOnInsert: { ...counted, createdAt: new Date() } }, { upsert: true }).catch((e) => { if (e?.code !== 11000) throw e; });
    return this.collection.findOne({ _id: provider });
  }
  async total(provider) { const d = await this.ensure(provider); return d.usedBytes + d.reservedBytes; }
  async reserve(provider, bytes, limit) {
    await this.ensure(provider);
    const after = await this.collection.findOneAndUpdate({ _id: provider }, { $inc: { reservedBytes: bytes } }, { returnDocument: "after" });
    if (after.usedBytes + after.reservedBytes > limit) { await this.release(provider, bytes); return false; }
    return true;
  }
  async commit(provider, bytes) { await this.collection.updateOne({ _id: provider }, { $inc: { reservedBytes: -bytes, usedBytes: bytes } }); }
  async release(provider, bytes) { await this.collection.updateOne({ _id: provider }, { $inc: { reservedBytes: -bytes } }); }
  async free(provider, bytes) { await this.collection.updateOne({ _id: provider }, { $inc: { usedBytes: -bytes } }); }
  async reconcile(provider) {
    const counted = await this.count(provider);
    const before = await this.collection.findOne({ _id: provider });
    await this.collection.updateOne({ _id: provider }, { $set: { ...counted, reconciledAt: new Date() } }, { upsert: true });
    return { before: before ? { usedBytes: before.usedBytes, reservedBytes: before.reservedBytes } : null, after: counted };
  }
}

module.exports = { StorageUsageRepository };
