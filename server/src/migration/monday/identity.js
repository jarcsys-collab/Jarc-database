// Identity stage: who wrote or created what. monday.com people are NEVER matched to JARC users by name, and never by
// email automatically. A monday user is linked to a JARC user only through a confirmed mapping file, in which an
// administrator records a JARC user ID they have verified (for example against the person's Microsoft Entra account).
// Everyone else stays historical attribution: a name and the monday user ID, with no JARC account, login or rights.
// No users are created and nobody is provisioned.
const OBJECT_ID = /^[0-9a-f]{24}$/;
const METHODS = new Set(["entra-object-id", "admin-verified"]);
const AUTOMATION_NAME = "monday.com automation";

// Validates a confirmed mapping file: { version: 1, entries: [{ sourceUserId, jarcUserId, method, verifiedBy, verifiedAt }] }.
function loadConfirmedMappings(input, knownSourceIds) {
  const map = new Map(), problems = [];
  if (input == null) return { map, problems };
  if (typeof input !== "object" || input.version !== 1 || !Array.isArray(input.entries)) return { map, problems: ["the user mapping file is not a version 1 mapping"] };
  const targets = new Set();
  input.entries.forEach((e, i) => {
    const where = `user mapping entry ${i + 1}`;
    if (!e || typeof e !== "object") return problems.push(`${where} is invalid`);
    const id = String(e.sourceUserId ?? "");
    if (!knownSourceIds.has(id)) return problems.push(`${where} refers to an unknown monday.com user`);
    if (id.startsWith("-")) return problems.push(`${where} maps the automation actor, which can't be a person`);
    if (typeof e.jarcUserId !== "string" || !OBJECT_ID.test(e.jarcUserId)) return problems.push(`${where} has an invalid JARC user ID`);
    if (!METHODS.has(e.method)) return problems.push(`${where} has no accepted verification method`);
    if (typeof e.verifiedBy !== "string" || !e.verifiedBy.trim() || Number.isNaN(Date.parse(e.verifiedAt))) return problems.push(`${where} must say who verified it and when`);
    if (map.has(id)) return problems.push(`${where} maps the same monday.com user twice`);
    if (targets.has(e.jarcUserId)) return problems.push(`${where} maps two monday.com users to one JARC user`);
    targets.add(e.jarcUserId);
    map.set(id, { jarcUserId: e.jarcUserId, method: e.method });
  });
  return { map: problems.length ? new Map() : map, problems };
}

class IdentityResolver {
  constructor(source, confirmed = null) {
    this.users = new Map(source.users.map((u) => [String(u.id), u]));
    this.missing = new Set((source.missingUserIds || []).map(String));
    const known = new Set([...this.users.keys(), ...this.missing]);
    const { map, problems } = loadConfirmedMappings(confirmed, known);
    this.confirmed = map; this.problems = problems;
    this.references = new Map(); // sourceUserId -> { itemCreator, subitemCreator, updateAuthor, replyAuthor, peopleCell, uploader, boardOwner, boardSubscriber }
  }
  note(id, role) {
    if (id == null) return;
    const key = String(id), r = this.references.get(key) || {};
    r[role] = (r[role] || 0) + 1; this.references.set(key, r);
  }
  // Attribution for a source user ID. fallbackName: the name monday returned on the object itself (update.creator.name).
  attribution(sourceUserId, role, fallbackName = null) {
    if (sourceUserId == null || sourceUserId === "") return { sourceUserId: null, name: null, kind: "none", jarcUserId: null };
    const id = String(sourceUserId);
    this.note(id, role);
    if (id.startsWith("-")) return { sourceUserId: id, name: AUTOMATION_NAME, kind: "automation", jarcUserId: null };
    const u = this.users.get(id), mapped = this.confirmed.get(id);
    const name = u?.name || (typeof fallbackName === "string" && fallbackName.trim() ? fallbackName.trim() : null);
    const kind = !u ? "unknown" : u.is_guest ? "guest" : u.enabled === false ? "inactive" : "member";
    return { sourceUserId: id, name: name ? name.slice(0, 200) : null, kind, jarcUserId: mapped ? mapped.jarcUserId : null };
  }
  report() {
    const ids = new Set([...this.users.keys(), ...this.references.keys()]);
    const rows = [...ids].sort((a, b) => Number(a) - Number(b)).map((id) => {
      const u = this.users.get(id), m = this.confirmed.get(id);
      return {
        sourceUserId: id, name: id.startsWith("-") ? AUTOMATION_NAME : u?.name ?? null,
        kind: id.startsWith("-") ? "automation" : !u ? "unknown" : u.is_guest ? "guest" : u.enabled === false ? "inactive" : "member",
        emailDomain: u?.email ? String(u.email).split("@")[1] || null : null,
        references: this.references.get(id) || {},
        mapping: m ? { status: "confirmed", jarcUserId: m.jarcUserId, method: m.method } : { status: id.startsWith("-") ? "system identity (never mapped)" : "unmapped: kept as historical attribution" }
      };
    });
    const count = (k) => rows.filter((r) => r.kind === k).length;
    return { totals: { users: rows.length, members: count("member"), guests: count("guest"), inactive: count("inactive"), unknown: count("unknown"), automation: count("automation"), confirmed: rows.filter((r) => r.mapping.status === "confirmed").length }, problems: this.problems, users: rows };
  }
  // A template for administrators: each person with their monday email, to verify against Entra before filling in jarcUserId.
  template() {
    return {
      version: 1,
      instructions: "Fill in jarcUserId ONLY for people you have verified are the same person in Microsoft Entra / JARC (method: entra-object-id or admin-verified, with verifiedBy and verifiedAt). Leave everyone else out: they stay as historical attribution. Never map by display name.",
      candidates: [...this.users.values()].filter((u) => !String(u.id).startsWith("-")).map((u) => ({ sourceUserId: String(u.id), name: u.name ?? null, email: u.email ?? null, guest: Boolean(u.is_guest), enabled: u.enabled !== false, references: this.references.get(String(u.id)) || {} })),
      entries: []
    };
  }
}

module.exports = { IdentityResolver, loadConfirmedMappings, AUTOMATION_NAME };
