// Fabric Data saved filters: each reader's own named filters per dataset, stored in JARC's database (fabricSavedFilters,
// repositories/mongo/fabric-saved-filter-repository.js), never in Fabric's. Mounted at /fabric/saved-filters after `identify`
// and requireFabricDataRead (fabric/access.js), BEFORE the GET-only Fabric data router, so every route needs a signed-in Fabric
// reader's session and every change needs the CSRF token (auth/session.js). API tokens are never accepted (they use
// /external/fabric, which never mounts this). Nothing is shared: a person sees and changes only their own filters, and another
// person's filter ID answers 404 NOT_FOUND exactly like an unknown one.
//
//   GET    /fabric/saved-filters/:dataset       { items: [{ id, name, version, state, createdAt, updatedAt, valid, problem?, unavailable? }] }
//   POST   /fabric/saved-filters/:dataset       { name, state } → 201 the item
//   PUT    /fabric/saved-filters/:dataset/:id   { name?, state? } (at least one) → the item
//   DELETE /fabric/saved-filters/:dataset/:id   → 200 { deleted: true, id }
//
// state: { filter (the v1 model or null), orderBy [[field, "asc"|"desc"]] (≤3), columns [field], dateFrom, dateTo (YYYY-MM-DD or
// null), datePreset, q, searchField }.
// Writes are validated against the dataset's current schema and the caller's current permissions. Sensitive fields are never
// filterable or orderable; a column the caller may not see is dropped. So nothing sensitive is ever stored for a caller who may
// not read it.
// Every GET revalidates each filter: a condition or order key whose field was removed, renamed or is now restricted is replaced
// by { unavailable: true } (never naming the field), valid becomes false and problem says why in words. Columns are filtered to
// the fields the caller may see now. Errors never echo a field name or a value.
const crypto = require("crypto");
const express = require("express");
const { ApiError, sendError, apiNotFound } = require("../middleware/errors");
const { allowOnly, requireBody } = require("../validation/common");
const { searchLimiter } = require("./search");
const { datasetNamed, permittedFields, typeOfField } = require("../fabric/datasets");
// B1: the operator catalog and validator (pure; no driver). Its validate is the default validateFilter, and its fieldKind
// decides which fields are usable at all (sensitive, dotted and disabled fields have none).
const filterModel = require("../fabric/filter-model");

const LIMITS = Object.freeze({ maxPerDataset: 50, nameMax: 80, maxDepth: 2, maxConditions: 20, maxGroups: 10, maxListValues: 200, maxText: 100, maxCanonicalBytes: 4096, maxOrderKeys: 3, nMin: 1, nMax: 366 });
const VERSION = 1;
const ID = /^[0-9a-f]{16}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DECIMAL = /^-?\d{1,20}(\.\d{1,20})?$/;
const PRESET = /^[A-Za-z0-9_-]{1,24}$/;
// Control characters and the bidirectional overrides (a name can't hide or reorder text in someone's screen).
const UNSAFE_TEXT = /[\p{Cc}‪-‮⁦-⁩]/u;
const UNSAFE_VALUE = /\p{Cc}/u;

// The v1 operator catalog by field type (Fabric-Data-Plan/phase7-advanced-filters/02, section b): a first, per-condition pass
// so a GET can mark single conditions unavailable. fabric/filter-model.js (B1) is the authority and runs after it.
const OPS = Object.freeze({
  text: new Set(["eq", "ne", "contains", "notContains", "startsWith", "endsWith", "in", "nin", "blank", "notBlank", "isNull", "missing"]),
  number: new Set(["eq", "ne", "gt", "gte", "lt", "lte", "between", "blank", "notBlank", "isNull", "missing"]),
  date: new Set(["on", "before", "onOrBefore", "after", "onOrAfter", "between", "today", "yesterday", "lastN", "prevN", "thisWeek", "thisMonth", "thisQuarter", "thisYear", "lastMonth", "lastYear", "blank", "notBlank"]),
  bool: new Set(["isTrue", "isFalse", "isNull", "missing"])
});
const LIST_OPS = new Set(["in", "nin"]);
const RANGE_OPS = new Set(["between"]);
const RELATIVE_OPS = new Set(["lastN", "prevN"]);
const NULLARY_OPS = new Set(["blank", "notBlank", "isNull", "missing", "isTrue", "isFalse", "today", "yesterday", "thisWeek", "thisMonth", "thisQuarter", "thisYear", "lastMonth", "lastYear"]);
const UNITS = new Set(["days", "weeks", "months"]);
const CONDITION_KEYS = ["field", "op", "value", "to", "values", "n", "unit"];
const kindOf = (ds, field) => { const t = typeOfField(ds, field); return t === "decimal" ? "number" : OPS[t] ? t : "text"; };

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = (path, reason, message = "This saved filter isn't valid.") => new ApiError(400, "VALIDATION_ERROR", message, { path, reason });

// May this field be used in a filter or an order key? Sensitive fields: never (owner decision, 00-COORDINATION). Dotted fields
// are never filtered or sorted (fields.js). Anything outside the current schema is unknown.
const usableField = (ds, field) => typeof field === "string" && ds.fields.includes(field) && !ds.sensitive.includes(field) && !field.includes(".") && filterModel.fieldKind(ds, field) !== null;

const validDay = (s) => {
  const m = typeof s === "string" && DAY.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const textValue = (v) => v === null || (typeof v === "string" && v.length <= LIMITS.maxText && !UNSAFE_VALUE.test(v));
const typedValue = (kind, v) => {
  if (!textValue(v)) return false;
  if (v === null || kind === "text") return true;
  if (kind === "number") return DECIMAL.test(v);
  if (kind === "date") return validDay(v);
  return false;
};

// One condition against the current schema: null when it is fine, else a reason code ("field": unknown or not usable now;
// "operator"; "value"). Never throws.
function conditionProblem(ds, cond) {
  if (!isObject(cond) || Object.keys(cond).some((k) => !CONDITION_KEYS.includes(k))) return "structure";
  if (!usableField(ds, cond.field)) return "field";
  const kind = kindOf(ds, cond.field);
  if (typeof cond.op !== "string" || !OPS[kind].has(cond.op)) return "operator";
  const has = (k) => cond[k] !== undefined;
  const op = cond.op;
  if (NULLARY_OPS.has(op)) return ["value", "to", "values", "n", "unit"].some(has) ? "value" : null;
  if (LIST_OPS.has(op)) {
    if (["value", "to", "n", "unit"].some(has) || !Array.isArray(cond.values) || cond.values.length < 1 || cond.values.length > LIMITS.maxListValues) return "value";
    return cond.values.every((v) => typedValue(kind, v)) ? null : "value";
  }
  if (RELATIVE_OPS.has(op)) {
    if (["value", "to", "values"].some(has) || !Number.isInteger(cond.n) || cond.n < LIMITS.nMin || cond.n > LIMITS.nMax || !UNITS.has(cond.unit)) return "value";
    return null;
  }
  if (["values", "n", "unit"].some(has)) return "value";
  if (RANGE_OPS.has(op)) return typedValue(kind, cond.value) && typedValue(kind, cond.to) && cond.value !== null && cond.to !== null ? null : "value";
  if (has("to") || !has("value")) return "value";
  // Text equality may compare with null; ordered comparisons need a value.
  if (cond.value === null && !["eq", "ne"].includes(op)) return "value";
  return typedValue(kind, cond.value) ? null : "value";
}

// Walks the v1 tree. Structural problems (shape, depth, limits) throw; per-condition problems are collected as
// { path, reason } so a GET can mark them unavailable and a write can refuse them.
function walkFilter(ds, filter) {
  if (filter === null || filter === undefined) return { tree: null, problems: [] };
  if (!isObject(filter)) throw invalid("filter", "structure");
  const problems = [];
  let conditions = 0, groups = 0;
  const group = (node, path, depth) => {
    const allowed = depth === 1 ? ["v", "op", "items"] : ["op", "items"];
    if (!isObject(node) || Object.keys(node).some((k) => !allowed.includes(k))) throw invalid(path, "structure");
    if (depth === 1 && node.v !== VERSION) throw invalid(path, "version");
    if (!["and", "or"].includes(node.op) || !Array.isArray(node.items)) throw invalid(path, "structure");
    if (depth > 1 && !node.items.length) throw invalid(path, "structure");
    groups += 1;
    if (groups > LIMITS.maxGroups) throw invalid(path, "limit", "This saved filter has too many groups.");
    node.items.forEach((item, i) => {
      const at = `${path}.items.${i}`;
      if (isObject(item) && Object.hasOwn(item, "items")) {
        if (depth >= LIMITS.maxDepth) throw invalid(at, "depth", "This saved filter is nested too deeply.");
        group(item, at, depth + 1);
        return;
      }
      conditions += 1;
      if (conditions > LIMITS.maxConditions) throw invalid(at, "limit", "This saved filter has too many conditions.");
      const reason = conditionProblem(ds, item);
      if (reason === "structure") throw invalid(at, "structure");
      if (reason) problems.push({ path: at, reason });
    });
  };
  group(filter, "filter", 1);
  if (Buffer.byteLength(JSON.stringify(filter)) > LIMITS.maxCanonicalBytes) throw invalid("filter", "limit", "This saved filter is too large.");
  return { tree: filter, problems };
}

// Only the known keys, in a fixed order (what is stored).
function canonicalFilter(node) {
  if (Object.hasOwn(node, "items")) return { ...(node.v !== undefined ? { v: node.v } : {}), op: node.op, items: node.items.map(canonicalFilter) };
  return Object.fromEntries(CONDITION_KEYS.filter((k) => node[k] !== undefined).map((k) => [k, k === "values" ? [...node[k]] : node[k]]));
}

// A copy for this caller: every condition with a problem becomes { unavailable: true }, which never names its field.
function redactFilter(node, paths, path = "filter") {
  if (Object.hasOwn(node, "items")) return { ...(node.v !== undefined ? { v: node.v } : {}), op: node.op, items: node.items.map((item, i) => redactFilter(item, paths, `${path}.items.${i}`)) };
  return paths.has(path) ? { unavailable: true } : canonicalFilter(node);
}

// Would applying what is left (unavailable conditions removed, groups left empty pruned) match MORE rows than the saved filter?
// Removing a term from an AND makes it broader; from an OR, narrower, unless the OR is left empty: a pruned group is itself a
// removed term of its parent, and an empty root means no filter at all. A broader child makes every ancestor broader (AND
// and OR are both monotonic), so one broadening anywhere is enough. Works on the redacted tree ({ unavailable: true } leaves).
function broadensOf(node) {
  const walk = (group) => {
    let broad = false, removed = 0, kept = 0;
    for (const item of Array.isArray(group?.items) ? group.items : []) {
      if (isObject(item) && Object.hasOwn(item, "items")) {
        const r = walk(item);
        broad = broad || r.broad;
        if (r.empty) removed += 1; else kept += 1;
      } else if (isObject(item) && item.unavailable === true) removed += 1;
      else kept += 1;
    }
    if (removed && group.op !== "or") broad = true;
    return { broad, empty: kept === 0 };
  };
  if (!isObject(node) || !Array.isArray(node.items) || !node.items.length) return false;
  const r = walk(node);
  return r.broad || r.empty;
}

const orderProblem = (ds, entry) => (!Array.isArray(entry) || entry.length !== 2 || !["asc", "desc"].includes(entry[1]) ? "structure" : usableField(ds, entry[0]) ? null : "field");

// The state from a request (write): refuses anything that isn't valid now for this caller. → the state to store.
function stateFromBody(ds, raw, { sensitive, validateFilter }) {
  if (!isObject(raw)) throw invalid("state", "structure", "state must be an object.");
  allowOnly(raw, ["filter", "orderBy", "columns", "dateFrom", "dateTo", "datePreset", "q", "searchField"], "state");
  // Field names are never echoed: a restricted field and an unknown one get the same answer.
  const { tree, problems } = walkFilter(ds, raw.filter ?? null);
  if (problems.length) {
    const [{ path, reason }] = problems;
    throw invalid(path, reason, reason === "field" ? "Unknown field." : "This saved filter isn't valid.");
  }
  let filter = tree && tree.items.length ? canonicalFilter(tree) : null;
  if (filter && validateFilter) {
    // B1's validator (fabric/filter-model.js): may return the canonical form; throws a 400 on anything it refuses.
    const out = validateFilter(filter, { dataset: ds, sensitive });
    if (isObject(out)) filter = out;
  }
  const orderBy = raw.orderBy ?? [];
  if (!Array.isArray(orderBy) || orderBy.length > LIMITS.maxOrderKeys) throw invalid("orderBy", "limit", `orderBy takes at most ${LIMITS.maxOrderKeys} keys.`);
  orderBy.forEach((entry, i) => { const reason = orderProblem(ds, entry); if (reason) throw invalid(`orderBy.${i}`, reason, reason === "field" ? "Unknown field." : "orderBy isn't valid."); });
  if (new Set(orderBy.map(([f]) => f)).size !== orderBy.length) throw invalid("orderBy", "duplicate", "orderBy names a field twice.");
  const columns = raw.columns ?? [];
  if (!Array.isArray(columns) || columns.length > ds.fields.length || !columns.every((c) => typeof c === "string" && c.length <= 100)) throw invalid("columns", "structure", "columns must be a list of field names.");
  const day = (key) => { const v = raw[key] ?? null; if (v !== null && !validDay(v)) throw invalid(key, "value", `${key} must be a date (YYYY-MM-DD).`); return v; };
  const dateFrom = day("dateFrom"), dateTo = day("dateTo");
  if (dateFrom && dateTo && dateFrom > dateTo) throw invalid("dateTo", "value", "dateTo must not be before dateFrom.");
  const datePreset = raw.datePreset ?? null;
  if (datePreset !== null && (typeof datePreset !== "string" || !PRESET.test(datePreset))) throw invalid("datePreset", "value", "datePreset isn't valid.");
  const q = raw.q ?? "";
  if (typeof q !== "string" || q.length > LIMITS.maxText || UNSAFE_VALUE.test(q)) throw invalid("q", "value", `q must be text of at most ${LIMITS.maxText} characters.`);
  const searchField = raw.searchField ?? null;
  if (searchField !== null && !ds.searchFields.some(([f]) => f === searchField)) throw invalid("searchField", "field", "Unknown search field.");
  return { filter, orderBy: orderBy.map(([f, d]) => [f, d]), columns: sanitizeColumns(ds, columns, sensitive), dateFrom, dateTo, datePreset, q, searchField };
}

// Only fields the caller may see now, each once, in the order given.
const sanitizeColumns = (ds, columns, sensitive) => { const ok = new Set(permittedFields(ds, sensitive)); return [...new Set((Array.isArray(columns) ? columns : []).filter((c) => typeof c === "string" && ok.has(c)))]; };

// A stored filter for this caller now (GET). Never throws.
function present(ds, item, { sensitive, validateFilter }) {
  const state = isObject(item.state) ? item.state : {};
  const unavailable = [];
  let filter = null, whole = false;
  if (state.filter) {
    try {
      const { problems } = walkFilter(ds, state.filter);
      if (problems.length) {
        problems.forEach((p) => unavailable.push(p.path));
        filter = redactFilter(state.filter, new Set(unavailable));
      } else {
        filter = canonicalFilter(state.filter);
        if (validateFilter) { try { validateFilter(filter, { dataset: ds, sensitive }); } catch { whole = true; } }
      }
    } catch {
      // The structure itself no longer validates (limits or the model changed): withheld as a whole.
      whole = true;
    }
    if (whole) { filter = null; unavailable.push("filter"); }
  }
  const orderBy = [];
  (Array.isArray(state.orderBy) ? state.orderBy : []).forEach((entry, i) => { if (orderProblem(ds, entry)) unavailable.push(`orderBy.${i}`); else orderBy.push([entry[0], entry[1]]); });
  let searchField = state.searchField ?? null;
  if (searchField !== null && !ds.searchFields.some(([f]) => f === searchField)) { unavailable.push("searchField"); searchField = null; }
  const valid = unavailable.length === 0;
  // broadens: applying the rest would show rows the saved filter excluded (M1, 10-security-review): a condition skipped in an
  // AND context, the whole filter withheld, or a search narrowed to one field now searching the usual fields. The client then
  // never applies it on its own. A skip only inside an OR (narrower) or a dropped sort key leaves broadens false.
  const broadens = !valid && (whole || (filter !== null && broadensOf(filter)) || (unavailable.includes("searchField") && typeof state.q === "string" && state.q.trim() !== ""));
  return {
    id: item.id, name: item.name, version: item.version ?? VERSION,
    state: { filter, orderBy, columns: sanitizeColumns(ds, state.columns, sensitive), dateFrom: state.dateFrom ?? null, dateTo: state.dateTo ?? null, datePreset: state.datePreset ?? null, q: typeof state.q === "string" ? state.q : "", searchField },
    createdAt: item.createdAt, updatedAt: item.updatedAt, valid,
    ...(valid ? {} : { problem: "This saved filter uses a field or setting you can't use now. Edit it and save again.", unavailable, broadens })
  };
}

// Names: trimmed, inner whitespace collapsed, 1–80 characters, no control characters; unique per person and dataset ignoring
// case and Unicode form.
function nameFrom(raw) {
  if (typeof raw !== "string") throw invalid("name", "structure", "name must be text.");
  const name = raw.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!name) throw invalid("name", "required", "name is required.");
  if ([...name].length > LIMITS.nameMax) throw invalid("name", "limit", `name must be at most ${LIMITS.nameMax} characters.`);
  if (UNSAFE_TEXT.test(name)) throw invalid("name", "value", "name contains characters that aren't allowed.");
  return name;
}
const keyOfName = (name) => name.normalize("NFKC").toLowerCase();

// repo: FabricSavedFilterRepository. validateFilter: (filter, { dataset, sensitive }) → canonical | throws a 400 (default: B1's
// filter-model validate; null skips it). maxPerDataset: the per-person, per-dataset cap. now: tests.
// readLimiter / writeLimiter: (userKey) → boolean, per signed-in person (routes/search.js searchLimiter: a sliding window);
// default 120 reads and 30 changes a minute (L3, 10-security-review). A refused request answers 429 RATE_LIMITED before any
// database call. Bodies over BODY_LIMIT_BYTES answer 413 (app.js also parses this mount with its own 32 KB JSON limit).
const BODY_LIMIT_BYTES = 32 * 1024;
function fabricSavedFilterRoutes({ repo, validateFilter = filterModel.validate, maxPerDataset = LIMITS.maxPerDataset, now = () => new Date(), readLimiter = searchLimiter({ perWindow: 120, windowMs: 60 * 1000 }), writeLimiter = searchLimiter({ perWindow: 30, windowMs: 60 * 1000 }) }) {
  if (!repo) throw new Error("fabricSavedFilterRoutes needs the saved filter repository.");
  const router = express.Router();
  const send = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);
  const opts = (req) => ({ sensitive: req.fabricAccess.sensitive === true, validateFilter });

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    // Never with an API token, and only after requireFabricDataRead (fails closed if mounted without it).
    if (req.get("authorization") !== undefined || !req.actor || req.fabricAccess?.via !== "session") return sendError(res, 401, "UNAUTHENTICATED", "Sign in to JARC to use saved Fabric filters.");
    if (Number(req.get("content-length") || 0) > BODY_LIMIT_BYTES) return sendError(res, 413, "PAYLOAD_TOO_LARGE", "The data is larger than the server accepts.");
    const limiter = req.method === "GET" || req.method === "HEAD" ? readLimiter : writeLimiter;
    if (limiter && !limiter(String(req.actor.userId))) return sendError(res, 429, "RATE_LIMITED", "Too many saved filter requests. Wait a few seconds and try again.");
    return next();
  });
  const datasetOf = (req) => {
    const ds = datasetNamed(req.params.dataset);
    if (!ds) throw new ApiError(404, "NOT_FOUND", "Not found.");
    if (!req.fabricAccess.datasets.has(ds.name)) throw new ApiError(403, "INSUFFICIENT_SCOPE", "This access doesn't include this Fabric dataset.");
    return ds;
  };
  const idOf = (req) => { if (!ID.test(req.params.id)) throw new ApiError(404, "NOT_FOUND", "Saved filter not found."); return req.params.id; };
  const noQuery = (req) => allowOnly(req.query, [], "the query");

  // Read, change, write; retried when another write landed in between (rev).
  const mutate = async (req, ds, change) => {
    const userId = req.actor.userId;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const doc = await repo.get(userId, ds.name);
      const filters = Array.isArray(doc?.filters) ? doc.filters.map((f) => ({ ...f })) : [];
      const result = change(filters);
      if (await repo.put(userId, ds.name, filters, doc ? doc.rev : null, now())) return result;
    }
    throw new ApiError(409, "CONFLICT", "Your saved filters changed at the same time. Try again.");
  };
  const nameTaken = (filters, key, exceptId) => filters.some((f) => f.nameKey === key && f.id !== exceptId);

  router.get("/:dataset", async (req, res) => {
    noQuery(req);
    const ds = datasetOf(req);
    const doc = await repo.get(req.actor.userId, ds.name);
    const items = (Array.isArray(doc?.filters) ? doc.filters : []).map((f) => present(ds, f, opts(req)));
    send(res, 200, { dataset: ds.name, items, limits: { maxPerDataset, nameMax: LIMITS.nameMax } });
  });

  router.post("/:dataset", async (req, res) => {
    noQuery(req);
    const ds = datasetOf(req);
    const body = requireBody(req.body);
    allowOnly(body, ["name", "state"]);
    const name = nameFrom(body.name), key = keyOfName(name);
    const state = stateFromBody(ds, body.state ?? {}, opts(req));
    const item = await mutate(req, ds, (filters) => {
      if (filters.length >= maxPerDataset) throw new ApiError(409, "LIMIT_REACHED", `You can keep at most ${maxPerDataset} saved filters per dataset. Delete one first.`);
      if (nameTaken(filters, key)) throw new ApiError(409, "NAME_TAKEN", "You already have a saved filter with this name.");
      const at = now();
      const created = { id: crypto.randomBytes(8).toString("hex"), name, nameKey: key, version: VERSION, state, createdAt: at, updatedAt: at };
      filters.push(created);
      return created;
    });
    send(res, 201, present(ds, item, opts(req)));
  });

  router.put("/:dataset/:id", async (req, res) => {
    noQuery(req);
    const ds = datasetOf(req);
    const id = idOf(req);
    const body = requireBody(req.body);
    allowOnly(body, ["name", "state"]);
    if (body.name === undefined && body.state === undefined) throw invalid("body", "required", "Send name, state or both.");
    const name = body.name === undefined ? null : nameFrom(body.name);
    const state = body.state === undefined ? null : stateFromBody(ds, body.state, opts(req));
    const item = await mutate(req, ds, (filters) => {
      const index = filters.findIndex((f) => f.id === id);
      if (index < 0) throw new ApiError(404, "NOT_FOUND", "Saved filter not found.");
      const next = { ...filters[index], updatedAt: now() };
      if (name !== null) {
        const key = keyOfName(name);
        if (nameTaken(filters, key, id)) throw new ApiError(409, "NAME_TAKEN", "You already have a saved filter with this name.");
        Object.assign(next, { name, nameKey: key });
      }
      if (state !== null) Object.assign(next, { state, version: VERSION });
      filters[index] = next;
      return next;
    });
    send(res, 200, present(ds, item, opts(req)));
  });

  router.delete("/:dataset/:id", async (req, res) => {
    noQuery(req);
    const ds = datasetOf(req);
    const id = idOf(req);
    await mutate(req, ds, (filters) => {
      const index = filters.findIndex((f) => f.id === id);
      if (index < 0) throw new ApiError(404, "NOT_FOUND", "Saved filter not found.");
      filters.splice(index, 1);
    });
    // 200 with a JSON body (not 204): the app's HTTP client always reads a JSON answer.
    res.status(200).set("Cache-Control", "no-store").json({ deleted: true, id });
  });

  router.use(apiNotFound);
  return router;
}

module.exports = { fabricSavedFilterRoutes, SAVED_FILTER_LIMITS: LIMITS, SAVED_FILTER_BODY_LIMIT: BODY_LIMIT_BYTES, _internal: { walkFilter, conditionProblem, present, broadensOf, stateFromBody, nameFrom, usableField } };
