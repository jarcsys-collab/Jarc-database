// Employee Management (JARC administration, read-only people directory): the ONLY place the directory fields are named.
//
// Source fields: the projection loads exactly SOURCE_FIELDS (an inclusion projection, _id excluded). Phone numbers, the
// company name and anything added upstream later are never projected, so they never reach memory, a response or a log.
// API fields: the allow-list below is the only thing that ever leaves the server, built field by field from the normalised
// record (never by spreading a document). The source collection is never named in code: it comes from
// EMPLOYEE_DIRECTORY_COLLECTION only.
//
// Datasets: fixed base conditions the client can't change.
//   active   = sign-in enabled AND account type Member   (viewers and admins; the default)
//   all      = every account                             (admins only)
//   disabled = sign-in disabled                          (admins only)
//   guests   = account type Guest                        (admins only)
// The descriptors are shaped like the descriptors fabric/filter-model.js validates against (fields, types, sensitive,
// filtering, sorts, defaultSort, dateField), so its validator and operator catalog are reused unchanged.

const SOURCE_FIELDS = Object.freeze(["user_id", "display_name", "first_name", "last_name", "user_principal_name", "mail", "email_address", "job_title", "department", "office_location", "account_enabled", "user_type", "created_datetime", "ingestion_datetime"]);
// Never projected (checked at load and by the tests).
const NEVER_LOADED = Object.freeze(["mobile_phone", "business_phones", "company_name", "_id"]);
const PROJECTION = Object.freeze({ _id: 0, ...Object.fromEntries(SOURCE_FIELDS.map((f) => [f, 1])) });

// API name → definition. type: string | bool | date (filter-model kinds: text/category, bool, date).
//   admin: only in the admin datasets; search: part of q; category: few distinct values (value list "distinct");
//   valueSearch: a searchable value list.
const FIELDS = Object.freeze({
  displayName: Object.freeze({ label: "Name", type: "string", search: true }),
  givenName: Object.freeze({ label: "First name", type: "string", search: true }),
  surname: Object.freeze({ label: "Last name", type: "string", search: true }),
  mail: Object.freeze({ label: "Email", type: "string", search: true }),
  userPrincipalName: Object.freeze({ label: "Sign-in name", type: "string", search: true }),
  jobTitle: Object.freeze({ label: "Job title", type: "string", search: true, valueSearch: true }),
  department: Object.freeze({ label: "Department", type: "string", search: true, valueSearch: true }),
  officeLocation: Object.freeze({ label: "Office", type: "string", valueSearch: true }),
  emailDomain: Object.freeze({ label: "Email domain", type: "string", category: true }),
  accountEnabled: Object.freeze({ label: "Sign-in enabled", type: "bool", admin: true }),
  accountType: Object.freeze({ label: "Account type", type: "string", category: true, admin: true }),
  accountCreated: Object.freeze({ label: "Directory account created", type: "date" })
});
const FIELD_NAMES = Object.freeze(Object.keys(FIELDS));
const DEFAULT_COLUMNS = Object.freeze(["displayName", "jobTitle", "department", "officeLocation", "mail"]);

const isMember = (r) => typeof r.values.accountType === "string" && r.values.accountType.toLowerCase() === "member";
const isGuest = (r) => typeof r.values.accountType === "string" && r.values.accountType.toLowerCase() === "guest";
const DATASET_DEFS = Object.freeze({
  active: Object.freeze({ label: "Active accounts", admin: false, base: (r) => r.values.accountEnabled === true && isMember(r) }),
  all: Object.freeze({ label: "All accounts", admin: true, base: () => true }),
  disabled: Object.freeze({ label: "Disabled accounts", admin: true, base: (r) => r.values.accountEnabled === false }),
  guests: Object.freeze({ label: "Guest accounts", admin: true, base: (r) => isGuest(r) })
});
const DATASET_NAMES = Object.freeze(Object.keys(DATASET_DEFS));
const ADMIN_DATASETS = Object.freeze(DATASET_NAMES.filter((n) => DATASET_DEFS[n].admin));
const VIEWER_DATASETS = Object.freeze(DATASET_NAMES.filter((n) => !DATASET_DEFS[n].admin));

const freezeDeep = (v) => { if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(freezeDeep); } return v; };
function descriptor(name) {
  const def = DATASET_DEFS[name];
  const fields = FIELD_NAMES.filter((f) => def.admin || !FIELDS[f].admin);
  return freezeDeep({
    name, label: def.label, admin: def.admin, base: def.base,
    fields, types: Object.fromEntries(fields.filter((f) => FIELDS[f].type !== "string").map((f) => [f, FIELDS[f].type])),
    sensitive: [], blankDateFields: [],
    dateField: "accountCreated",
    filtering: { categories: fields.filter((f) => FIELDS[f].category), valueSearch: fields.filter((f) => FIELDS[f].valueSearch), disabled: [] },
    searchFields: fields.filter((f) => FIELDS[f].search).map((f) => [f, "contains"]),
    sorts: { name: { lead: "displayName", keys: [["displayName", 1], ["_id", 1]] } },
    defaultSort: "name",
    defaultColumns: [...DEFAULT_COLUMNS]
  });
}
const DATASETS = Object.freeze(Object.fromEntries(DATASET_NAMES.map((n) => [n, descriptor(n)])));
const datasetNamed = (name) => (typeof name === "string" && Object.hasOwn(DATASETS, name) ? DATASETS[name] : null);

// Self-check at load: nothing never-loadable is projected; every dataset names only allow-listed API fields.
for (const f of NEVER_LOADED) if (f !== "_id" && Object.hasOwn(PROJECTION, f)) throw new Error("employees/fields: a never-loaded source field is projected.");
if (PROJECTION._id !== 0) throw new Error("employees/fields: the projection must exclude _id.");
for (const ds of Object.values(DATASETS)) for (const f of [...ds.fields, ...ds.defaultColumns]) if (!FIELDS[f]) throw new Error("employees/fields: unknown API field.");

// ---- Normalising one projected source document ----
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/g;
// Text: trimmed, control characters removed, at most 400 characters; blank → null.
const text = (v) => {
  if (typeof v !== "string") return null;
  const t = v.replace(CONTROL, "").trim().slice(0, 400);
  return t.length ? t : null;
};
const bool = (v) => (typeof v === "boolean" ? v : null);
const date = (v) => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : new Date(v.getTime());
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? null : d;
};
// The lower-case part after "@" of the email (or sign-in name); guest sign-in names (#EXT#) carry an outside address: null.
function emailDomain(mail, upn) {
  if (typeof upn === "string" && upn.toUpperCase().includes("#EXT#")) return null;
  const source = mail || upn;
  if (typeof source !== "string") return null;
  const at = source.lastIndexOf("@");
  const domain = at >= 0 ? source.slice(at + 1).trim().toLowerCase() : "";
  return /^[a-z0-9.-]{1,253}$/.test(domain) ? domain : null;
}
// → { oid, values } or null when the document has no valid GUID user_id (acceptance rejects such snapshots).
function normalize(doc) {
  const oid = typeof doc?.user_id === "string" && GUID.test(doc.user_id.trim()) ? doc.user_id.trim().toLowerCase() : null;
  if (!oid) return null;
  const mail = text(doc.mail) ?? text(doc.email_address);
  const upn = text(doc.user_principal_name);
  return {
    oid,
    values: Object.freeze({
      displayName: text(doc.display_name), givenName: text(doc.first_name), surname: text(doc.last_name), mail, userPrincipalName: upn,
      jobTitle: text(doc.job_title), department: text(doc.department), officeLocation: text(doc.office_location),
      emailDomain: emailDomain(mail, upn), accountEnabled: bool(doc.account_enabled), accountType: text(doc.user_type), accountCreated: date(doc.created_datetime)
    })
  };
}
// A value as JSON carries it (dates as ISO strings).
const outValue = (v) => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);

module.exports = { SOURCE_FIELDS, NEVER_LOADED, PROJECTION, FIELDS, FIELD_NAMES, DEFAULT_COLUMNS, DATASETS, DATASET_NAMES, ADMIN_DATASETS, VIEWER_DATASETS, datasetNamed, normalize, outValue, emailDomain, GUID };
