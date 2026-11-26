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

// P2 (Employee Access Visibility): the JARC access fields, computed by jarc-access.js from JARC's own database (never from the
// directory source). Only in the descriptors of jarcAccess callers (EMPLOYEE_ADMIN_OIDS, access.js); a viewer's descriptor
// doesn't contain them, so naming one anywhere (fields, filter, orderBy, values, a saved filter) is the existing "Unknown
// field." 400, and the name is never echoed. group "jarc": the Columns picker and Advanced Filters group them.
// multi: a list of values (jarcWorkspaces): eq / in match when any element matches, ne / nin when none does, blank = no
// element (query.js); value lists count each element (service.js); a record carries one sorted string joined by ", "
// (outValue). Default columns and sorting are unchanged (P1).
const JARC_FIELDS = Object.freeze({
  jarcAccount: Object.freeze({ label: "JARC account", type: "string", category: true, group: "jarc" }),
  jarcStatus: Object.freeze({ label: "JARC account status", type: "string", category: true, group: "jarc" }),
  jarcAdmin: Object.freeze({ label: "JARC administrator", type: "string", category: true, group: "jarc" }),
  jarcAccessSource: Object.freeze({ label: "How JARC access is granted", type: "string", category: true, group: "jarc" }),
  jarcWorkspaceRole: Object.freeze({ label: "Highest workspace role (membership)", type: "string", category: true, group: "jarc" }),
  jarcMemberships: Object.freeze({ label: "Workspace memberships", type: "number", group: "jarc" }),
  jarcWorkspaces: Object.freeze({ label: "Member of workspaces", type: "string", category: true, multi: true, group: "jarc" }),
  jarcDisabledWithAccess: Object.freeze({ label: "Disabled in Entra, still has JARC access", type: "bool", group: "jarc" }),
  jarcSignedInNow: Object.freeze({ label: "Signed in to JARC now", type: "bool", group: "jarc" }),
  jarcRegistered: Object.freeze({ label: "First JARC sign-in", type: "date", group: "jarc" }),
  jarcLastSignIn: Object.freeze({ label: "Last JARC sign-in", type: "date", group: "jarc" })
});
const JARC_FIELD_NAMES = Object.freeze(Object.keys(JARC_FIELDS));
// Every API field (P1 and P2) by name: what the service reads labels and types from.
const ALL_FIELDS = Object.freeze({ ...FIELDS, ...JARC_FIELDS });

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
// jarc: the P2 descriptor (P1 fields, then the JARC access fields). Without it the descriptor is exactly P1's: same fields,
// same order, no multiValued entries, so viewers' schema, records, values and saved filters don't change.
function descriptor(name, { jarc = false } = {}) {
  const def = DATASET_DEFS[name];
  const fields = [...FIELD_NAMES.filter((f) => def.admin || !FIELDS[f].admin), ...(jarc ? JARC_FIELD_NAMES : [])];
  return freezeDeep({
    name, label: def.label, admin: def.admin, base: def.base,
    fields, types: Object.fromEntries(fields.filter((f) => ALL_FIELDS[f].type !== "string").map((f) => [f, ALL_FIELDS[f].type])),
    sensitive: [], blankDateFields: [],
    dateField: "accountCreated",
    filtering: { categories: fields.filter((f) => ALL_FIELDS[f].category), valueSearch: fields.filter((f) => ALL_FIELDS[f].valueSearch), disabled: [] },
    searchFields: fields.filter((f) => ALL_FIELDS[f].search).map((f) => [f, "contains"]),
    sorts: { name: { lead: "displayName", keys: [["displayName", 1], ["_id", 1]] } },
    defaultSort: "name",
    defaultColumns: [...DEFAULT_COLUMNS],
    ...(jarc ? { jarc: true, multiValued: fields.filter((f) => ALL_FIELDS[f].multi) } : {})
  });
}
const DATASETS = Object.freeze(Object.fromEntries(DATASET_NAMES.map((n) => [n, descriptor(n)])));
const JARC_DATASETS = Object.freeze(Object.fromEntries(DATASET_NAMES.map((n) => [n, descriptor(n, { jarc: true })])));
// opts.jarc: the caller's descriptor carries the JARC access fields (access.jarcAccess with the access index wired).
const datasetNamed = (name, { jarc = false } = {}) => (typeof name === "string" && Object.hasOwn(DATASETS, name) ? (jarc ? JARC_DATASETS : DATASETS)[name] : null);
const isJarcField = (f) => typeof f === "string" && Object.hasOwn(JARC_FIELDS, f);

// Self-check at load: nothing never-loadable is projected; every dataset names only allow-listed API fields; P1 descriptors
// never carry a JARC access field.
for (const f of NEVER_LOADED) if (f !== "_id" && Object.hasOwn(PROJECTION, f)) throw new Error("employees/fields: a never-loaded source field is projected.");
if (PROJECTION._id !== 0) throw new Error("employees/fields: the projection must exclude _id.");
for (const ds of Object.values(DATASETS)) for (const f of [...ds.fields, ...ds.defaultColumns]) if (!FIELDS[f]) throw new Error("employees/fields: unknown API field.");
for (const ds of Object.values(JARC_DATASETS)) for (const f of ds.fields) if (!ALL_FIELDS[f]) throw new Error("employees/fields: unknown API field.");

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
// Office privacy (P2 §6): some directory entries hold a phone number in the office field (for example "9999-9999"). Phones are
// never shown, so such an office becomes null (the Unassigned / blank bucket) when it holds a phone-like run. The text is
// NFKC-normalised first (full-width digits become ASCII); then digit groups are joined whenever what separates them holds no
// letter (any spaces or punctuation: - – / _ , . ( ) + and so on) or only a lone "x" / "ext" (an extension). One joined run
// with at least 7 digits hides the value. Names and room codes ("Head Office", "B-204", "Room 3.14", "Level 12", "Warehouse 1",
// "Bldg 2, Floor 10", "Unit 12/14") stay. Applied here, once per snapshot build, so records, profiles, q search, filters,
// groups and value lists never see the value.
// Known false positives (also hidden): all-numeric codes of 7+ digits ("2024-0001", "1234567"), date-like values ("2024-01-15",
// "15/01/2024"), and numbers only punctuation apart that total 7+ digits ("Unit 1200/345", "12-34-567", "Rooms 101, 102, 103").
const DIGIT_GROUP = /\p{Nd}+/gu;
const JOINING_GAP = /^[^\p{L}]*(?:(?:x|ext)[^\p{L}]*)?$/iu;
function phoneLike(value) {
  const t = String(value).normalize("NFKC");
  let run = 0, end = -1;
  for (const m of t.matchAll(DIGIT_GROUP)) {
    run = end >= 0 && JOINING_GAP.test(t.slice(end, m.index)) ? run + m[0].length : m[0].length;
    if (run >= 7) return true;
    end = m.index + m[0].length;
  }
  return false;
}
const office = (v) => { const t = text(v); return t !== null && phoneLike(t) ? { value: null, withheld: true } : { value: t, withheld: false }; };
// → { oid, values, officeWithheld } or null when the document has no valid GUID user_id (acceptance rejects such snapshots).
function normalize(doc) {
  const oid = typeof doc?.user_id === "string" && GUID.test(doc.user_id.trim()) ? doc.user_id.trim().toLowerCase() : null;
  if (!oid) return null;
  const mail = text(doc.mail) ?? text(doc.email_address);
  const upn = text(doc.user_principal_name);
  const officeLocation = office(doc.office_location);
  return {
    oid,
    values: Object.freeze({
      displayName: text(doc.display_name), givenName: text(doc.first_name), surname: text(doc.last_name), mail, userPrincipalName: upn,
      jobTitle: text(doc.job_title), department: text(doc.department), officeLocation: officeLocation.value,
      emailDomain: emailDomain(mail, upn), accountEnabled: bool(doc.account_enabled), accountType: text(doc.user_type), accountCreated: date(doc.created_datetime)
    }),
    officeWithheld: officeLocation.withheld
  };
}
// A value as JSON carries it (dates as ISO strings; a multi-valued field as one string, its sorted values joined by ", ").
const outValue = (v) => (v instanceof Date ? v.toISOString() : Array.isArray(v) ? (v.length ? v.join(", ") : null) : v === undefined ? null : v);

module.exports = { SOURCE_FIELDS, NEVER_LOADED, PROJECTION, FIELDS, FIELD_NAMES, DEFAULT_COLUMNS, DATASETS, DATASET_NAMES, ADMIN_DATASETS, VIEWER_DATASETS, datasetNamed, normalize, outValue, emailDomain, GUID, JARC_FIELDS, JARC_FIELD_NAMES, ALL_FIELDS, JARC_DATASETS, isJarcField, phoneLike };
