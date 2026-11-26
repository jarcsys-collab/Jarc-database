// P4-0 administrator protection tests: JARC's real data layer (users, memberships, sessions, Employee Management P3, Account
// Management) over a given MongoConnection: the in-memory FakeMongoClient, or the isolated local test MongoDB (p40-real-mongo-
// concurrency). The directory is the read-only fake (EmployeeFakeClient). Synthetic people only, invented IDs.
const { ObjectId } = require("mongodb");
const { ensureDatabase } = require("../../src/db/bootstrap");
const { createDataLayer } = require("../../src/data-layer");
const { MemoryFileStore } = require("../../src/files/file-store");
const { Access } = require("../../src/auth/access");
const { accountOf } = require("../../src/auth/accounts");
const { createEmployees, JarcAccessIndex, AccessAdminService, profileId } = require("../../src/employees");
const { EmployeeFakeClient, syntheticPeople, COLLECTION, DB_NAME, TEST_ID_KEY } = require("./employee-fake");

const TENANT = "00000000-0000-4000-8000-00000000a001";
const silent = { info() {}, warn() {}, error() {} };
const ADMIN = { view: true, admin: true, datasets: ["active", "all", "disabled", "guests"], who: "u-admin", jarcAccess: true };
const HOUR = 3600 * 1000;

// accountMode: ACCOUNT_MANAGEMENT; admins: indexes of the Employee Management administrators; superAdminIndex: the configured
// JARC_SUPER_ADMIN_* identity. serial: transactions run one at a time (the fake has no write-conflict detection; see the tests).
async function buildWorld(connection, { accountMode = "staged", admins = [0], superAdminIndex = null, serial = false, seed = "p40auth" } = {}) {
  await ensureDatabase(connection.db);
  if (serial) {
    const run = connection.withTransaction.bind(connection);
    let chain = Promise.resolve();
    connection.withTransaction = (fn) => { const p = chain.then(() => run(fn)); chain = p.catch(() => {}); return p; };
  }
  const dataLayer = createDataLayer({ connection, logger: silent, fileStore: new MemoryFileStore(), environment: "test" });
  const people = syntheticPeople(10, { seed });
  people.forEach((d) => { d.account_enabled = true; d.user_type = "Member"; d.user_id = d.user_id.toLowerCase(); });
  const config = Object.defineProperty({ enabled: true, collection: COLLECTION, dbName: DB_NAME, tenantId: TENANT, viewerObjectIds: [], adminObjectIds: admins.map((i) => people[i].user_id), accessAdmin: true }, "uri", { value: "mongodb://directory.invalid", enumerable: false });
  const employees = createEmployees({ config, createClient: () => new EmployeeFakeClient({ docs: people }), idKey: TEST_ID_KEY, logger: silent });
  const access = new Access(dataLayer.repos, { policy: "role_based", accountMode });
  const members = dataLayer.services.members.configure({ accountMode });
  const index = new JarcAccessIndex({ repos: dataLayer.repos, access, tenantId: TENANT, employeesConfig: config, logger: silent });
  const superAdmin = superAdminIndex === null ? null : { tenantId: TENANT, objectId: people[superAdminIndex].user_id };
  const service = new AccessAdminService({ employees, jarcAccess: index, repos: dataLayer.repos, connection: dataLayer.connection, members, access, tenantId: TENANT, superAdmin, logger: silent });
  const accounts = dataLayer.services.accounts.configure({ mode: accountMode === "off" ? "staged" : accountMode, superAdmin, entra: { tenantId: TENANT }, environment: "test" });
  const db = connection.db;
  const users = db.collection("users");
  // A registered person. By default they signed in after this change WITHOUT the JARC.Admin role (adminRoleClearedAt), so their
  // administrator status is known; pass { adminRoleClearedAt: undefined } for an unknown status.
  const register = async (i, extra = {}) => {
    const doc = { _id: new ObjectId(), tenantId: TENANT, entraObjectId: people[i].user_id, source: "entra", status: "active", displayName: `Synthetic Person ${i + 1}`, createdAt: new Date(), lastLoginAt: new Date(), adminRoleClearedAt: new Date(1), ...extra };
    for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
    await users.insertOne(doc);
    return doc;
  };
  const superAdminAccount = { status: "active", role: "SUPER_ADMIN", version: 1 };
  const actorOf = (doc, extra = {}) => ({ userId: doc._id, kind: "entra", isSystemAdmin: false, hasAdminAppRole: false, tenantId: TENANT, entraObjectId: doc.entraObjectId, displayName: doc.displayName, account: accountOf(doc), ...extra });
  const workspace = async (name) => { const _id = new ObjectId(), now = new Date(); await db.collection("workspaces").insertOne({ _id, name, archived: false, position: 1, createdAt: now, updatedAt: now, version: 1 }); return _id; };
  const admin = (ws, user, role = "WORKSPACE_ADMIN") => dataLayer.repos.memberships.add({ workspaceId: ws, userId: user._id, role, now: new Date() });
  const liveSession = async (user, isSystemAdmin, { ageMs = 0 } = {}) => {
    const t = Date.now();
    await db.collection("sessions").insertOne({ _id: `synthetic-${new ObjectId().toHexString()}`, userId: user._id, tenantId: TENANT, objectId: user.entraObjectId, isSystemAdmin, createdAt: new Date(t - ageMs), lastSeenAt: new Date(t), idleExpiresAt: new Date(t + HOUR), expiresAt: new Date(t + 2 * HOUR) });
    index.invalidate();
  };
  const idOf = (i) => profileId(TEST_ID_KEY, people[i].user_id);
  const fresh = async (i) => users.findOne({ entraObjectId: people[i].user_id });
  const versionOf = async (i) => (await fresh(i))?.accessVersion ?? 0;
  const suspend = async (i, actor, extra = {}) => service.changeAccess("all", idOf(i), { action: "suspend", expectedState: "active", expectedVersion: await versionOf(i), reason: "Synthetic reason", ...extra }, ADMIN, actor);
  const revoke = async (i, actor, extra = {}) => service.changeAccess("all", idOf(i), { action: "revoke", expectedState: "active", expectedVersion: await versionOf(i), reason: "Synthetic reason", confirm: "REVOKE", ...extra }, ADMIN, actor);
  const manage = (i, actor) => service.manageAccess("all", idOf(i), ADMIN, actor);
  const block = async (i, actor) => accounts.block(actor, (await fresh(i))._id, { expectedVersion: accountOf(await fresh(i)).version, confirm: "BLOCK" });
  const statusOf = async (i) => (await fresh(i)).status;
  const accountStatusOf = async (i) => accountOf(await fresh(i)).status;
  const usableAdmins = async (ws) => (await members.countUsableAdmins(ws)).usable;
  return { connection, db, dataLayer, repos: dataLayer.repos, members, service, accounts, index, people, register, superAdminAccount, actorOf, workspace, admin, liveSession, idOf, fresh, suspend, revoke, manage, block, statusOf, accountStatusOf, usableAdmins };
}

module.exports = { buildWorld, TENANT, ADMIN, HOUR };
