// Shared, framework-free validation helpers for the resource API. Every failure throws a 400 VALIDATION_ERROR with a
// short reason that is safe to show.
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// Column keys and every other client-chosen field name: letters, digits, "_" and "-" only. This rules out "." and
// "$", so a key can never become a MongoDB operator or a nested field path.
const SAFE_KEY = /^[A-Za-z0-9_-]{1,100}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const COLOR = /^#[0-9a-f]{3,8}$/i;

const fail = (message) => { throw new ApiError(400, "VALIDATION_ERROR", message); };
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isPrimitive = (value) => value === null || ["string", "number", "boolean"].includes(typeof value) && (typeof value !== "number" || Number.isFinite(value));
const isSafeKey = (key) => typeof key === "string" && SAFE_KEY.test(key) && !FORBIDDEN_KEYS.has(key);

// Rejects prototype-pollution keys, operator-like keys ("$..."), dotted keys and excessive nesting anywhere in a body.
function assertSafeJson(value, { maxDepth = 10, label = "The request" } = {}) {
  const walk = (node, depth) => {
    if (node === null || typeof node !== "object") return;
    if (depth > maxDepth) fail(`${label} is nested too deeply.`);
    for (const key of Object.keys(node)) {
      if (FORBIDDEN_KEYS.has(key) || key.startsWith("$") || key.includes(".") || key.includes("\0")) fail(`${label} contains a field name that is not allowed.`);
      walk(node[key], depth + 1);
    }
  };
  walk(value, 0);
}

function requireBody(body) {
  if (!isObject(body)) fail("Send a JSON object.");
  assertSafeJson(body);
  return body;
}

// Only the listed fields may appear.
function allowOnly(body, allowed, label = "the request") {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) fail(`Unknown field "${key.slice(0, 40)}" in ${label}.`);
}

function parseId(value, label = "id") {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) fail(`${label} is not a valid ID.`);
  return ObjectId.createFromHexString(value.toLowerCase());
}

function text(value, label, { max = 200, required = false, trim = true } = {}) {
  if (typeof value !== "string") fail(`${label} must be text.`);
  const result = trim ? value.trim() : value;
  if (required && !result) fail(`${label} is required.`);
  if (result.length > max) fail(`${label} must be at most ${max} characters.`);
  return result;
}

function color(value, label = "color") {
  if (value === "" || value === null) return "";
  if (typeof value !== "string" || !COLOR.test(value)) fail(`${label} must be a colour such as #0f9489.`);
  return value;
}

function bool(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be true or false.`);
  return value;
}

function finiteNumber(value, label, { min = -1e15, max = 1e15 } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be a number.`);
  return value;
}

function version(value, label = "expectedVersion") {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a whole number of at least 1.`);
  return value;
}

// Query-string values arrive as strings; repeated parameters arrive as arrays and are rejected.
function queryString(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(`${label} must be given once.`);
  return value;
}

function versionParam(value) {
  const raw = queryString(value, "expectedVersion");
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) fail("expectedVersion is required, as a whole number.");
  return version(Number(raw));
}

module.exports = { fail, isObject, isPrimitive, isSafeKey, assertSafeJson, requireBody, allowOnly, parseId, text, color, bool, finiteNumber, version, versionParam, queryString, FORBIDDEN_KEYS, SAFE_KEY, OBJECT_ID };
