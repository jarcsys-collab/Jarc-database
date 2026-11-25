// Employee Management saved filters: each person's own named filters per dataset, stored in JARC's database
// (employeeSavedFilters, repositories/mongo/employee-saved-filter-repository.js). Mounted by employees/router.js under
// /saved-filters, so it runs after `identify` (a JARC session; every change needs the CSRF token, auth/session.js) and after
// the Employee Management access check. API tokens are never accepted. Nothing is shared: a person sees and changes only
// their own filters, and another person's filter ID answers 404 NOT_FOUND exactly like an unknown one.
//
//   GET    /saved-filters/:ds       { dataset, items: [{ id, name, version, state, createdAt, updatedAt, valid, problem?, unavailable?, broadens? }], limits }
//   POST   /saved-filters/:ds       { name, state } → 201 the item
//   PUT    /saved-filters/:ds/:id   { name?, state? } (at least one) → the item
//   DELETE /saved-filters/:ds/:id   → 200 { deleted: true, id }
//
// state: { filter (v1 model or null), orderBy [[field, "asc"|"desc"]] (≤3), columns [field], q, searchField }. dateFrom, dateTo
// and datePreset are accepted only as null/absent (the directory has no date window) and are never stored.
// Writes are validated (fabric/filter-model.js validateFilter over the employee dataset descriptor). Every GET revalidates each
// filter: a condition or order key that no longer validates becomes { unavailable: true } (never naming its field), valid
// becomes false, and broadens says whether applying the rest would show MORE people than the saved filter did.
const crypto = require("crypto");
const express = require("express");
const { ApiError, sendError, apiNotFound } = require("../middleware/errors");
const { requireBody } = require("../validation/common");
const { searchLimiter } = require("./search");
const fm = require("../fabric/filter-model");

const LIMITS = Object.freeze({ maxPerDataset: 50, nameMax: 80, maxText: 100, maxOrderKeys: 3, maxCanonicalBytes: 4096 });
const VERSION = 1;
const ID = /^[0-9a-f]{16}$/;
const UNSAFE_TEXT = /[\p{Cc}‪-‮⁦-⁩]/u;
const UNSAFE_VALUE = /\p{Cc}/u;
const BODY_LIMIT_BYTES = 32 * 1024;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = (path, reason, message = "This saved filter isn't valid.") => new ApiError(400, "VALIDATION_ERROR", message, { path, reason });
// Only the listed keys may appear; an unknown key is never echoed.
const allowOnly = (body, allowed, label = "the request") => { for (const key of Object.keys(body || {})) if (!allowed.includes(key)) throw invalid(label, "unknownKey", `Unknown key in ${label}.`); };

// A whole-model check: → canonical model or throws a 400 (field names never echoed).
function validModel(ds, model) {
  try { return fm.canonical(fm.validateFilter(ds, model)); } catch (error) {
    if (error?.code !== "VALIDATION_ERROR") throw error;
    const reason = error.details?.reason;
    throw invalid(`filter${String(error.details?.path || "$").slice(1)}`, reason || "invalid", reason === "unknownField" ? "Unknown field." : "This saved filter isn't valid.");
  }
}
// Is this single condition valid against the dataset now?
const conditionOk = (ds, cond) => fm.checkFilter(ds, { v: 1, op: "and", items: [cond] }).valid;

// Revalidation of a stored tree: → { filter (redacted), unavailable: [paths], whole }.
function revalidate(ds, stored) {
  if (!isObject(stored) || stored.v !== VERSION || !Array.isArray(stored.items)) return { filter: null, unavailable: ["filter"], whole: true };
  const unavailable = [];
  const walk = (node, path, depth) => {
    if (!isObject(node) || !["and", "or"].includes(node.op) || !Array.isArray(node.items) || depth > fm.LIMITS.maxDepth) throw new Error("structure");
    return { ...(depth === 1 ? { v: VERSION } : {}), op: node.op, items: node.items.map((item, i) => {
      const at = `${path}.items.${i}`;
      if (isObject(item) && Object.hasOwn(item, "items")) return walk(item, at, depth + 1);
      if (conditionOk(ds, item)) return fm.canonical({ op: "and", items: [item] }).items[0];
      unavailable.push(at);
      return { unavailable: true };
    }) };
  };
  try {
    const filter = walk(stored, "filter", 1);
    if (!unavailable.length) { try { fm.validateFilter(ds, filter); } catch { return { filter: null, unavailable: ["filter"], whole: true }; } }
    return { filter, unavailable, whole: false };
  } catch { return { filter: null, unavailable: ["filter"], whole: true }; }
}
// Would applying what is left (unavailable conditions removed, empty groups pruned) match MORE rows than the saved filter?
function broadensOf(node) {
  const walk = (group) => {
    let broad = false, removed = 0, kept = 0;
    for (const item of Array.isArray(group?.items) ? group.items : []) {
      if (isObject(item) && Object.hasOwn(item, "items")) { const r = walk(item); broad = broad || r.broad; if (r.empty) removed += 1; else kept += 1; }
      else if (isObject(item) && item.unavailable === true) removed += 1;
      else kept += 1;
    }
    if (removed && group.op !== "or") broad = true;
    return { broad, empty: kept === 0 };
  };
  if (!isObject(node) || !Array.isArray(node.items) || !node.items.length) return false;
  const r = walk(node);
  return r.broad || r.empty;
}

const orderOk = (ds, entry) => Array.isArray(entry) && entry.length === 2 && ["asc", "desc"].includes(entry[1]) && typeof entry[0] === "string" && fm.orderable(ds, entry[0]);
const searchFieldOk = (ds, f) => f === null || ds.searchFields.some(([x]) => x === f);
const sanitizeColumns = (ds, columns) => [...new Set((Array.isArray(columns) ? columns : []).filter((c) => typeof c === "string" && ds.fields.includes(c)))];

// The state from a request (write): refuses anything that isn't valid now. → the state to store.
function stateFromBody(ds, raw) {
  if (!isObject(raw)) throw invalid("state", "structure", "state must be an object.");
  allowOnly(raw, ["filter", "orderBy", "columns", "q", "searchField", "dateFrom", "dateTo", "datePreset"], "state");
  for (const k of ["dateFrom", "dateTo", "datePreset"]) if (raw[k] !== undefined && raw[k] !== null && raw[k] !== "") throw invalid(k, "value", "The directory has no date window.");
  let filter = raw.filter ?? null;
  if (filter !== null) {
    if (!isObject(filter)) throw invalid("filter", "structure");
    if (Buffer.byteLength(JSON.stringify(filter)) > LIMITS.maxCanonicalBytes) throw invalid("filter", "limit", "This saved filter is too large.");
    filter = validModel(ds, filter);
    if (!filter.items.length) filter = null;
  }
  const orderBy = raw.orderBy ?? [];
  if (!Array.isArray(orderBy) || orderBy.length > LIMITS.maxOrderKeys) throw invalid("orderBy", "limit", `orderBy takes at most ${LIMITS.maxOrderKeys} keys.`);
  orderBy.forEach((entry, i) => { if (!orderOk(ds, entry)) throw invalid(`orderBy.${i}`, Array.isArray(entry) && entry.length === 2 ? "field" : "structure", Array.isArray(entry) && entry.length === 2 ? "Unknown field." : "orderBy isn't valid."); });
  if (new Set(orderBy.map(([f]) => f)).size !== orderBy.length) throw invalid("orderBy", "duplicate", "orderBy names a field twice.");
  const columns = raw.columns ?? [];
  if (!Array.isArray(columns) || columns.length > ds.fields.length || !columns.every((c) => typeof c === "string" && c.length <= 100)) throw invalid("columns", "structure", "columns must be a list of field names.");
  const q = raw.q ?? "";
  if (typeof q !== "string" || q.length > LIMITS.maxText || UNSAFE_VALUE.test(q)) throw invalid("q", "value", `q must be text of at most ${LIMITS.maxText} characters.`);
  const searchField = raw.searchField ?? null;
  if (!searchFieldOk(ds, searchField)) throw invalid("searchField", "field", "Unknown search field.");
  return { filter, orderBy: orderBy.map(([f, d]) => [f, d]), columns: sanitizeColumns(ds, columns), q, searchField };
}

// A stored filter for this caller now (GET). Never throws. Built field by field.
function present(ds, item) {
  const state = isObject(item.state) ? item.state : {};
  const unavailable = [];
  let filter = null, whole = false;
  if (state.filter) { const r = revalidate(ds, state.filter); filter = r.filter; whole = r.whole; unavailable.push(...r.unavailable); }
  const orderBy = [];
  (Array.isArray(state.orderBy) ? state.orderBy : []).forEach((entry, i) => { if (orderOk(ds, entry)) orderBy.push([entry[0], entry[1]]); else unavailable.push(`orderBy.${i}`); });
  let searchField = typeof state.searchField === "string" ? state.searchField : null;
  if (!searchFieldOk(ds, searchField)) { unavailable.push("searchField"); searchField = null; }
  const q = typeof state.q === "string" ? state.q : "";
  const valid = unavailable.length === 0;
  const broadens = !valid && (whole || (filter !== null && broadensOf(filter)) || (unavailable.includes("searchField") && q.trim() !== ""));
  return {
    id: String(item.id), name: String(item.name), version: VERSION,
    state: { filter, orderBy, columns: sanitizeColumns(ds, state.columns), dateFrom: null, dateTo: null, datePreset: null, q, searchField },
    createdAt: item.createdAt, updatedAt: item.updatedAt, valid,
    ...(valid ? {} : { problem: "This saved filter uses a field or setting you can't use now. Edit it and save again.", unavailable, broadens })
  };
}

function nameFrom(raw) {
  if (typeof raw !== "string") throw invalid("name", "structure", "name must be text.");
  const name = raw.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!name) throw invalid("name", "required", "name is required.");
  if ([...name].length > LIMITS.nameMax) throw invalid("name", "limit", `name must be at most ${LIMITS.nameMax} characters.`);
  if (UNSAFE_TEXT.test(name)) throw invalid("name", "value", "name contains characters that aren't allowed.");
  return name;
}
const keyOfName = (name) => name.normalize("NFKC").toLowerCase();

// repo: EmployeeSavedFilterRepository. datasetOf(req) → the dataset descriptor the caller may use (throws 403/404).
// readLimiter / writeLimiter: (userKey) → boolean (default 120 reads and 30 changes a minute per person).
function employeeSavedFilterRoutes({ repo, datasetOf, maxPerDataset = LIMITS.maxPerDataset, now = () => new Date(), readLimiter = searchLimiter({ perWindow: 120, windowMs: 60 * 1000 }), writeLimiter = searchLimiter({ perWindow: 30, windowMs: 60 * 1000 }) }) {
  if (!repo || typeof datasetOf !== "function") throw new Error("employeeSavedFilterRoutes needs the repository and datasetOf.");
  const router = express.Router();
  const send = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.get("authorization") !== undefined || !req.actor || !req.employeeAccess?.view) return sendError(res, 401, "UNAUTHENTICATED", "Sign in to JARC to use saved filters.");
    if (Number(req.get("content-length") || 0) > BODY_LIMIT_BYTES) return sendError(res, 413, "PAYLOAD_TOO_LARGE", "The data is larger than the server accepts.");
    const limiter = req.method === "GET" || req.method === "HEAD" ? readLimiter : writeLimiter;
    if (limiter && !limiter(String(req.actor.userId))) { res.set("Retry-After", "60"); return sendError(res, 429, "RATE_LIMITED", "Too many saved filter requests. Wait a few seconds and try again."); }
    return next();
  });
  router.use(express.json({ limit: "32kb", strict: true, inflate: false }));
  const idOf = (req) => { if (!ID.test(req.params.id)) throw new ApiError(404, "NOT_FOUND", "Saved filter not found."); return req.params.id; };
  const noQuery = (req) => allowOnly(req.query, [], "the query");

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

  router.get("/:ds", async (req, res) => {
    const ds = datasetOf(req); noQuery(req);
    const doc = await repo.get(req.actor.userId, ds.name);
    send(res, 200, { dataset: ds.name, items: (Array.isArray(doc?.filters) ? doc.filters : []).map((f) => present(ds, f)), limits: { maxPerDataset, nameMax: LIMITS.nameMax } });
  });
  router.post("/:ds", async (req, res) => {
    const ds = datasetOf(req); noQuery(req);
    const body = requireBody(req.body);
    allowOnly(body, ["name", "state"]);
    const name = nameFrom(body.name), key = keyOfName(name);
    const state = stateFromBody(ds, body.state ?? {});
    const item = await mutate(req, ds, (filters) => {
      if (filters.length >= maxPerDataset) throw new ApiError(409, "LIMIT_REACHED", `You can keep at most ${maxPerDataset} saved filters per view. Delete one first.`);
      if (nameTaken(filters, key)) throw new ApiError(409, "NAME_TAKEN", "You already have a saved filter with this name.");
      const at = now();
      const created = { id: crypto.randomBytes(8).toString("hex"), name, nameKey: key, version: VERSION, state, createdAt: at, updatedAt: at };
      filters.push(created);
      return created;
    });
    send(res, 201, present(ds, item));
  });
  router.put("/:ds/:id", async (req, res) => {
    const ds = datasetOf(req); noQuery(req);
    const id = idOf(req);
    const body = requireBody(req.body);
    allowOnly(body, ["name", "state"]);
    if (body.name === undefined && body.state === undefined) throw invalid("body", "required", "Send name, state or both.");
    const name = body.name === undefined ? null : nameFrom(body.name);
    const state = body.state === undefined ? null : stateFromBody(ds, body.state);
    const item = await mutate(req, ds, (filters) => {
      const index = filters.findIndex((f) => f.id === id);
      if (index < 0) throw new ApiError(404, "NOT_FOUND", "Saved filter not found.");
      const next = { ...filters[index], updatedAt: now() };
      if (name !== null) { const key = keyOfName(name); if (nameTaken(filters, key, id)) throw new ApiError(409, "NAME_TAKEN", "You already have a saved filter with this name."); Object.assign(next, { name, nameKey: key }); }
      if (state !== null) Object.assign(next, { state, version: VERSION });
      filters[index] = next;
      return next;
    });
    send(res, 200, present(ds, item));
  });
  router.delete("/:ds/:id", async (req, res) => {
    const ds = datasetOf(req); noQuery(req);
    const id = idOf(req);
    await mutate(req, ds, (filters) => {
      const index = filters.findIndex((f) => f.id === id);
      if (index < 0) throw new ApiError(404, "NOT_FOUND", "Saved filter not found.");
      filters.splice(index, 1);
    });
    send(res, 200, { deleted: true, id });
  });
  router.use(apiNotFound);
  return router;
}

module.exports = { employeeSavedFilterRoutes, EMPLOYEE_SAVED_FILTER_LIMITS: LIMITS, _internal: { present, stateFromBody, broadensOf, revalidate } };
