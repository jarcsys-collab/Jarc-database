// Tests the browser ApiAdapter (site/assets/StorageService.js) against real HTTP responses from a local test server.
// The browser file is loaded unchanged into an isolated context with the few browser globals it uses.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm"), http = require("http");
const { startApp, validState } = require("./helpers");

function loadBrowserStorage(search = "") {
  const window = { location: { search } };
  const context = vm.createContext({ window, console, URLSearchParams, AbortController, setTimeout, clearTimeout, CustomEvent: class CustomEvent {} });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "..", "..", "site", "assets", "StorageService.js"), "utf8"), context);
  return window;
}
const { ApiAdapter, StorageError, StorageService, LocalAsyncAdapter } = loadBrowserStorage();

// Responds according to the requested path: /status/<code>, /slow, /invalid-json, /html.
function startStubServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const [, kind, value] = req.url.split("/");
      if (kind === "status") { res.writeHead(Number(value), { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { code: "X", message: "Raw server detail at /srv/app.js" } })); }
      if (kind === "slow") return; // never answers
      if (kind === "invalid-json") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end("{not json"); }
      if (kind === "html") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<!doctype html><html></html>"); }
      if (kind === "no-state") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end("{}"); }
      res.writeHead(500); res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) }));
  });
}

const adapterFor = (baseUrl, options = {}) => new ApiAdapter({ baseUrl, fetch: (...args) => fetch(...args), timeoutMs: 2000, ...options });
async function rejectsWith(promise, code) {
  try { await promise; } catch (error) {
    assert.ok(error instanceof StorageError, `expected StorageError, got ${error?.name}`);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /Raw server detail|\/srv\/|TypeError|fetch failed|ECONNREFUSED|AbortError/, "message is safe for users");
    return error;
  }
  assert.fail(`expected rejection with ${code}`);
}

describe("ApiAdapter against the real Express app", () => {
  let api; before(async () => { api = await startApp(); }); after(() => api.close());

  test("successful read with no data yet → { raw: null }", async () => {
    assert.deepEqual({ ...(await adapterFor(`${api.url}/api/v1`).readAppState()) }, { raw: null, source: "none" });
  });
  test("successful write, then read returns the same document text", async () => {
    const adapter = adapterFor(`${api.url}/api/v1`), text = JSON.stringify(validState());
    await adapter.writeAppState(text);
    const { raw, source } = await adapter.readAppState();
    assert.equal(source, "api");
    assert.deepEqual(JSON.parse(raw), JSON.parse(text));
  });
  test("StorageService.loadState works through the ApiAdapter", async () => {
    const service = new StorageService(adapterFor(`${api.url}/api/v1`));
    const { data, user, migrated } = await service.loadState();
    assert.equal(data.workspaces[0].id, "operations");
    assert.equal(user.currentBoardId, "ops-intake");
    assert.equal(migrated, false);
  });
  test("a server-side validation failure → VALIDATION_ERROR", async () => {
    await rejectsWith(adapterFor(`${api.url}/api/v1`).writeAppState(JSON.stringify({ schemaVersion: 1, workspaces: [] })), "VALIDATION_ERROR");
  });
  test("an oversized write → PAYLOAD_TOO_LARGE", async () => {
    await rejectsWith(adapterFor(`${api.url}/api/v1`).writeAppState(JSON.stringify(validState({ settings: { pad: "x".repeat(11 * 1024 * 1024) } }))), "PAYLOAD_TOO_LARGE");
  });
});

describe("ApiAdapter error mapping", () => {
  let stub; before(async () => { stub = await startStubServer(); }); after(() => stub.close());

  const cases = { 400: "VALIDATION_ERROR", 422: "VALIDATION_ERROR", 401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 413: "PAYLOAD_TOO_LARGE", 429: "RATE_LIMITED", 500: "INTERNAL_ERROR", 502: "SERVICE_UNAVAILABLE", 503: "SERVICE_UNAVAILABLE", 504: "SERVICE_UNAVAILABLE", 418: "INTERNAL_ERROR", 501: "INTERNAL_ERROR" };
  for (const [status, code] of Object.entries(cases)) {
    test(`HTTP ${status} → ${code} (read and write)`, async () => {
      const adapter = adapterFor(`${stub.url}/status/${status}`); // the stub answers every path under it
      const readError = await rejectsWith(adapter.readAppState(), code);
      await rejectsWith(adapter.writeAppState("{}"), code);
      assert.equal(readError.cause.status, Number(status));
    });
  }

  test("network unavailable → OFFLINE", async () => {
    const closed = await startStubServer(); const url = closed.url; await closed.close();
    await rejectsWith(adapterFor(`${url}/api/v1`).readAppState(), "OFFLINE");
    await rejectsWith(adapterFor(`${url}/api/v1`).writeAppState("{}"), "OFFLINE");
  });

  test("timeout → SERVICE_UNAVAILABLE (retryable), request aborted", async () => {
    const started = Date.now();
    const error = await rejectsWith(adapterFor(`${stub.url}/slow`, { timeoutMs: 150 }).readAppState(), "SERVICE_UNAVAILABLE");
    assert.ok(Date.now() - started < 2000, "did not hang");
    assert.match(error.message, /took too long/);
  });

  test("invalid JSON response → INTERNAL_ERROR", async () => {
    await rejectsWith(adapterFor(`${stub.url}/invalid-json`).readAppState(), "INTERNAL_ERROR");
  });
  test("an HTML page instead of JSON → INTERNAL_ERROR", async () => {
    await rejectsWith(adapterFor(`${stub.url}/html`).readAppState(), "INTERNAL_ERROR");
  });
  test("a JSON response without a state field → INTERNAL_ERROR on read", async () => {
    await rejectsWith(adapterFor(`${stub.url}/no-state`).readAppState(), "INTERNAL_ERROR");
  });

  test("retryable and offline flags used by the UI", () => {
    const d = (code) => StorageError.describe(code);
    assert.deepEqual([d("OFFLINE").retryable, d("OFFLINE").offline], [true, true]);
    assert.deepEqual([d("SERVICE_UNAVAILABLE").retryable, d("SERVICE_UNAVAILABLE").offline], [true, true]);
    assert.deepEqual([d("INTERNAL_ERROR").retryable, d("RATE_LIMITED").retryable], [true, true]);
    for (const code of ["VALIDATION_ERROR", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "PAYLOAD_TOO_LARGE"]) assert.equal(d(code).retryable, false, code);
  });
});

describe("Adapter selection and device storage", () => {
  test("LOCAL is the default; API only with ?storage=api", () => {
    assert.equal(loadBrowserStorage("").jarcStorage.adapter.mode, "local");
    assert.equal(loadBrowserStorage("?storage=local").jarcStorage.adapter.mode, "local");
    assert.equal(loadBrowserStorage("?storage=API").jarcStorage.adapter.mode, "local");
    assert.equal(loadBrowserStorage("?storage=api").jarcStorage.adapter.mode, "api");
  });
  test("ApiAdapter keeps preferences/session in browser storage and never clears server data", () => {
    const adapter = new ApiAdapter({ fetch: async () => { throw new Error("no network in this test"); } });
    assert.ok(adapter.device instanceof LocalAsyncAdapter);
    assert.equal(adapter.keyFor("preferences", "navCollapsed"), "jarc-nav-collapsed");
    assert.equal(adapter.readRawAppState(), null);
    assert.throws(() => adapter.clearAppState(), (error) => error.code === "FORBIDDEN");
  });
  test("requests go to the same origin under /api/v1 with JSON headers and no credentials in the URL", async () => {
    const calls = [];
    const adapter = new ApiAdapter({ fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ state: null }) }; } });
    await adapter.readAppState(); await adapter.writeAppState("{\"a\":1}");
    assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [["GET", "/api/v1/state"], ["PUT", "/api/v1/state"]]);
    assert.equal(calls[1].init.headers["Content-Type"], "application/json");
    assert.equal(calls[1].init.body, "{\"a\":1}");
    assert.equal(calls[0].init.credentials, "same-origin");
  });
});
