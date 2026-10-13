// External integrations (monday.com, one-way into JARC). Five collections:
//   integrations              one document per provider (_id "monday"): connection status, encrypted token, sync flags
//   integrationOAuthStates    single-use OAuth "state" values (TTL: expire after 10 minutes)
//   integrationMappings       source ID → JARC ID ({ provider, kind: "board" | "item", sourceId }, unique): duplicates
//                             are impossible and imports can resume
//   integrationJobs           durable job queue (imports, item syncs, reconciliations): claimed atomically with a lease,
//                             so restarts and several server instances never run a job twice at once
//   integrationEvents         received webhook events ({ provider, eventId } unique: each delivery handled once)
const { COLLECTIONS } = require("../../db/bootstrap");

class IntegrationRepository {
  constructor(db) {
    this.integrations = db.collection(COLLECTIONS.integrations);
    this.states = db.collection(COLLECTIONS.integrationOAuthStates);
    this.mappings = db.collection(COLLECTIONS.integrationMappings);
    this.jobs = db.collection(COLLECTIONS.integrationJobs);
    this.events = db.collection(COLLECTIONS.integrationEvents);
  }
  get(provider) { return this.integrations.findOne({ _id: provider }); }
  async set(provider, fields) { await this.integrations.updateOne({ _id: provider }, { $set: fields }, { upsert: true }); }
  async markHealthy(provider) { await this.integrations.updateOne({ _id: provider, status: "needs_reconnect" }, { $set: { status: "connected" } }); }
  async unset(provider, fields) { await this.integrations.updateOne({ _id: provider }, { $unset: Object.fromEntries(fields.map((f) => [f, ""])) }); }
  // Only one server instance gets to schedule the periodic reconciliation each period.
  async claimSchedule(provider, now, nextAt) { return Boolean(await this.integrations.findOneAndUpdate({ _id: provider, $or: [{ nextReconcileAt: { $lte: now } }, { nextReconcileAt: { $exists: false } }] }, { $set: { nextReconcileAt: nextAt } })); }

  saveState(doc) { return this.states.insertOne(doc); }
  takeState(id, now) { return this.states.findOneAndDelete({ _id: id, expiresAt: { $gt: now } }); }

  findMapping(provider, kind, sourceId, { session } = {}) { return this.mappings.findOne({ provider, kind, sourceId: String(sourceId) }, { session }); }
  listMappings(filter, { limit = 100000 } = {}) { return this.mappings.find(filter, { limit }).toArray(); }
  async insertMappings(docs, { session } = {}) { if (docs.length) await this.mappings.insertMany(docs, { session, ordered: true }); }
  async updateMapping(id, set, { session } = {}) { await this.mappings.updateOne({ _id: id }, { $set: set }, { session }); }
  async deleteMappings(filter) { if (Object.keys(filter).length) await this.mappings.deleteMany(filter); }

  enqueue(job) { return this.jobs.insertOne(job); }
  // Takes the next due job of the given types: queued/retry and due, or running with an expired lease (its worker
  // died). The lease and attempt count are set in the same atomic update.
  claim({ types, now, workerId, leaseMs }) {
    return this.jobs.findOneAndUpdate(
      { type: { $in: types }, $or: [{ status: { $in: ["queued", "retry"] }, runAfter: { $lte: now } }, { status: "running", lockedUntil: { $lt: now } }] },
      { $set: { status: "running", lockedBy: workerId, lockedUntil: new Date(now.getTime() + leaseMs), startedAt: now }, $inc: { attempts: 1 } },
      { returnDocument: "after", sort: { runAfter: 1 } }
    );
  }
  async updateJob(id, set, { workerId = null } = {}) { await this.jobs.updateOne(workerId ? { _id: id, lockedBy: workerId } : { _id: id }, { $set: set }); }
  findJob(id) { return this.jobs.findOne({ _id: id }); }
  listJobs(filter, { limit = 20 } = {}) { return this.jobs.find(filter, { sort: { createdAt: -1 }, limit }).toArray(); }
  countJobs(filter) { return this.jobs.countDocuments(filter); }
  async cancelJobs(filter) { await this.jobs.updateMany(filter, { $set: { status: "cancelled" } }); }

  insertEvent(doc) { return this.events.insertOne(doc); }
  async updateEvent(id, set) { await this.events.updateOne({ _id: id }, { $set: set }); }
}

module.exports = { IntegrationRepository };
