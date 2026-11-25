// TEST-ONLY: an in-memory stand-in for the read-only directory source (one collection, synthetic people only: "Synthetic
// Person N", @example.com, "Dept A"). Supports exactly what src/employees uses: connect, close, db(name).command
// (connectionStatus, ping), and on the one configured collection find(filter, { projection, limit }).toArray() and
// aggregate([{ $group: { _id: null, max: { $max: "$ingestion_datetime" }, n: { $sum: 1 } } }]).toArray(). It has NO write
// methods: any write attempt throws a TypeError. Any other collection name throws.
// Switches: down (every call fails like an unreachable server), connectFails, authInfo (connectionStatus reply).
const crypto = require("crypto");

const COLLECTION = "DirectorySnapshot";
const DB_NAME = "SyntheticDirectoryDb";
const readOnlyAuth = (db) => ({ authenticatedUsers: [{ user: "reader", db: "admin" }], authenticatedUserRoles: [{ role: "read", db }], authenticatedUserPrivileges: [{ resource: { db, collection: "" }, actions: ["find", "listIndexes", "collStats", "changeStream", "killCursors"] }] });
const networkError = () => Object.assign(new Error("connect ECONNREFUSED synthetic"), { name: "MongoNetworkError" });

function project(doc, projection) {
  if (!projection) return { ...doc };
  const include = Object.entries(projection).filter(([, v]) => v === 1).map(([k]) => k);
  const out = {};
  if (projection._id !== 0 && doc._id !== undefined) out._id = doc._id;
  for (const k of include) if (Object.hasOwn(doc, k)) out[k] = doc[k];
  return out;
}

class EmployeeFakeClient {
  constructor({ docs = [], dbName = DB_NAME, collection = COLLECTION, authInfo = null } = {}) {
    this.docs = docs; this.dbName = dbName; this.collectionName = collection; this.authInfo = authInfo;
    this.down = false; this.connectFails = false;
    this.calls = []; // { op, projection?, pipeline? }
    this.connected = 0;
  }
  async connect() { if (this.down || this.connectFails) throw networkError(); this.connected += 1; return this; }
  async close() {}
  db(name) {
    const fake = this;
    return {
      async command(cmd) {
        if (fake.down) throw networkError();
        if (cmd.connectionStatus) return { ok: 1, authInfo: fake.authInfo || readOnlyAuth(name) };
        if (cmd.ping) return { ok: 1 };
        throw new Error("employee-fake: unsupported command");
      },
      collection(collectionName) {
        if (name !== fake.dbName || collectionName !== fake.collectionName) throw new Error("employee-fake: unknown collection");
        return {
          find(filter = {}, { projection, limit } = {}) {
            fake.calls.push({ op: "find", projection: projection ? { ...projection } : null, filter });
            return { toArray: async () => { if (fake.down) throw networkError(); const rows = fake.docs.map((d) => project(d, projection)); return limit ? rows.slice(0, limit) : rows; } };
          },
          aggregate(pipeline) {
            fake.calls.push({ op: "aggregate", pipeline });
            return { toArray: async () => {
              if (fake.down) throw networkError();
              const g = pipeline?.[0]?.$group;
              if (pipeline.length !== 1 || !g || g._id !== null || g.max?.$max !== "$ingestion_datetime" || g.n?.$sum !== 1) throw new Error("employee-fake: unsupported pipeline");
              if (!fake.docs.length) return [];
              return [{ _id: null, max: fake.docs.map((d) => d.ingestion_datetime).sort().at(-1), n: fake.docs.length }];
            } };
          }
        };
      }
    };
  }
}

// Synthetic people. Pattern per index i (1-based): every 5th is disabled, every 7th is a Guest (#EXT# UPN), department
// Dept A/B/C or none, job titles, offices, created dates spread over 2024–2026. Phones and company are present in the source
// documents so the tests can prove they are never projected or returned.
function syntheticPeople(n = 30, { ingestion = "2026-11-24T01:18:00.000Z", seed = "s" } = {}) {
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    const guest = i % 7 === 0, disabled = i % 5 === 0;
    const user = `synthetic.person${i}`;
    const oid = crypto.createHash("sha256").update(`${seed}:${i}`).digest("hex");
    out.push({
      _id: `ingest-${seed}-${i}`,
      user_id: `${oid.slice(0, 8)}-${oid.slice(8, 12)}-4${oid.slice(13, 16)}-8${oid.slice(17, 20)}-${oid.slice(20, 32)}`,
      display_name: `Synthetic Person ${i}`,
      first_name: i % 4 === 0 ? null : "Synthetic",
      last_name: i % 4 === 0 ? null : `Person ${i}`,
      user_principal_name: guest ? `${user}_example.com#EXT#@tenant.example.com` : `${user}@example.com`,
      mail: i % 6 === 0 ? null : `${user}@example.com`,
      email_address: `${user}@example.com`,
      job_title: i % 3 === 0 ? null : i % 2 ? "Engineer" : "Analyst",
      department: ["Dept A", "Dept B", "Dept C", null][i % 4],
      office_location: i % 2 ? "Office 1" : "",
      account_enabled: !disabled,
      user_type: guest ? "Guest" : "Member",
      created_datetime: new Date(Date.UTC(2024, 0, 1) + i * 25 * 86400000).toISOString(),
      ingestion_datetime: ingestion,
      mobile_phone: `+00 0000 ${String(1000 + i)}`,
      business_phones: [`+00 1111 ${String(1000 + i)}`],
      company_name: "Synthetic Company"
    });
  }
  return out;
}

const TEST_ID_KEY = Buffer.alloc(32, 7); // an explicit test key for the opaque profile IDs (never a real key)

module.exports = { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY, readOnlyAuth };
