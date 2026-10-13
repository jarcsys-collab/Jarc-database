// Runs integration jobs from the durable queue (integrationJobs). Safe across restarts and several server instances:
// a job is claimed atomically with a lease; a job whose worker died is taken over when its lease expires; progress
// (an import's cursor) is stored so it resumes. Nothing runs unless the integration is enabled and connected; item
// syncs and reconciliations additionally need sync switched on and not paused. Failures retry with backoff, then
// stop as "failed" (shown on the dashboard, retryable by an administrator).
const crypto = require("crypto");
const { redact } = require("../../db/connection");
const { PROVIDER, SYNC_TYPES } = require("./service");

const LEASE_MS = 120000;
const MAX_ATTEMPTS = 5;
const RECONCILE_EVERY_MS = 15 * 60 * 1000;

class IntegrationWorker {
  constructor({ integration, repos, logger = console, now = () => new Date(), workerId = crypto.randomBytes(6).toString("hex") }) {
    Object.assign(this, { integration, repos, logger, now, workerId, running: false });
  }

  // One pass: schedule the periodic reconciliation (one instance per period) and run due jobs (at most `max`).
  async tick({ max = 5 } = {}) {
    if (this.running) return { ran: 0 };
    this.running = true;
    try {
      if (!this.integration.config?.enabled || !this.integration.config?.configured) return { ran: 0 };
      const rec = await this.repos.integrations.get(PROVIDER);
      if (!rec?.token) return { ran: 0 };
      const syncOn = Boolean(rec.syncEnabled) && !rec.paused;
      if (syncOn) {
        const now = this.now();
        if (await this.repos.integrations.claimSchedule(PROVIDER, now, new Date(now.getTime() + RECONCILE_EVERY_MS))) await this.integration.enqueueReconcile();
      }
      const types = ["import", ...(syncOn ? SYNC_TYPES : [])];
      let ran = 0;
      for (; ran < max; ran += 1) {
        const job = await this.repos.integrations.claim({ types, now: this.now(), workerId: this.workerId, leaseMs: LEASE_MS });
        if (!job) break;
        await this.run(job);
      }
      return { ran };
    } finally { this.running = false; }
  }

  async run(job) {
    try {
      const client = await this.integration.client();
      const result = job.type === "import" ? await this.integration.runImport(job, client, { workerId: this.workerId })
        : job.type === "reconcile" ? await this.integration.runReconcile(job, client)
        : await this.integration.runSyncItem(job, client);
      await this.repos.integrations.updateJob(job._id, { status: "done", finishedAt: this.now(), lockedUntil: null, result: summary(result), error: null }, { workerId: this.workerId });
      await this.repos.integrations.markHealthy(PROVIDER);
    } catch (error) {
      const message = String(error?.message || "The operation failed.").replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>").slice(0, 300);
      const final = (job.attempts || 1) >= MAX_ATTEMPTS || ["UNAUTHORIZED", "MONDAY_UNAUTHORIZED", "NOT_CONNECTED"].includes(error?.code);
      const delay = Math.min(30 * 60000, 30000 * 2 ** ((job.attempts || 1) - 1));
      await this.repos.integrations.updateJob(job._id, final ? { status: "failed", finishedAt: this.now(), lockedUntil: null, error: message } : { status: "retry", runAfter: new Date(this.now().getTime() + delay), lockedUntil: null, error: message }, { workerId: this.workerId });
      const unauthorized = ["UNAUTHORIZED", "MONDAY_UNAUTHORIZED"].includes(error?.code);
      await this.repos.integrations.set(PROVIDER, { lastError: message, lastErrorAt: this.now(), ...(unauthorized ? { status: "needs_reconnect" } : {}) });
      this.logger.error(`[monday] ${job.type} job ${job._id} ${final ? "failed" : "will retry"}: ${redact(message)}`);
    }
  }

  start({ intervalMs = 15000 } = {}) {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => this.logger.error(`[monday] worker: ${error?.name || "Error"}`)), intervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}

const summary = (r) => (r && typeof r === "object" ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v?.toHexString ? v.toHexString() : v])) : null);

module.exports = { IntegrationWorker, LEASE_MS, MAX_ATTEMPTS };
