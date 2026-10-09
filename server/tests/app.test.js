const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startApp, validState, entraEnv } = require("./helpers");
const { loadConfig } = require("../src/config");

const json = (body) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const assertErrorShape = (body, code) => {
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message"]);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  assert.doesNotMatch(JSON.stringify(body), /\bat \w|node_modules|[A-Z]:\\|\/src\/|stack/i, "no stack traces or paths");
};

describe("API: health and metadata", () => {
  let api; before(async () => { api = await startApp(); }); after(() => api.close());

  test("GET /api/v1/health → 200 with service status only", async () => {
    const res = await fetch(`${api.url}/api/v1/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["environment", "service", "status", "timestamp"]);
    assert.equal(body.status, "ok");
    assert.equal(body.service, "jarc-database-api");
    assert.equal(body.environment, "test");
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
  });

  test("GET /api/v1 → API metadata", async () => {
    const body = await (await fetch(`${api.url}/api/v1`)).json();
    assert.deepEqual(body, { service: "jarc-database-api", apiVersion: "v1", version: require("../package.json").version });
  });

  test("responses hide the framework and disable MIME sniffing", async () => {
    const res = await fetch(`${api.url}/api/v1/health`);
    assert.equal(res.headers.get("x-powered-by"), null);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });
});

describe("API: transitional development state endpoints", () => {
  let api; before(async () => { api = await startApp(); }); after(() => api.close());

  test("GET /api/v1/state → 200 with no state before the first save", async () => {
    const res = await fetch(`${api.url}/api/v1/state`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { state: null, revision: 0, updatedAt: null });
  });

  test("PUT a valid state → 200, then GET returns exactly what was saved", async () => {
    const state = validState({ extraUnknownField: { kept: true } });
    const put = await fetch(`${api.url}/api/v1/state`, json(state));
    assert.equal(put.status, 200);
    const saved = await put.json();
    assert.equal(saved.ok, true);
    assert.equal(saved.revision, 1);
    const got = await (await fetch(`${api.url}/api/v1/state`)).json();
    assert.deepEqual(got.state, state);
    assert.equal(got.revision, 1);
  });

  test("each save increases the revision", async () => {
    await fetch(`${api.url}/api/v1/state`, json(validState({ settings: { density: "compact" } })));
    const got = await (await fetch(`${api.url}/api/v1/state`)).json();
    assert.equal(got.revision, 2);
    assert.equal(got.state.settings.density, "compact");
  });

  const rejected = {
    "malformed JSON": "{\"schemaVersion\":1,",
    "a JSON array": [validState()],
    "a JSON string": "\"text\"",
    "missing schemaVersion": validState({ schemaVersion: undefined }),
    "unsupported schemaVersion": validState({ schemaVersion: 2 }),
    "no workspaces": validState({ workspaces: [] }),
    "workspace without an id": validState({ workspaces: [{ name: "x", boards: [] }] }),
    "board without records": validState({ workspaces: [{ id: "w", boards: [{ id: "b" }] }] }),
    "record that is not an object": validState({ workspaces: [{ id: "w", boards: [{ id: "b", records: ["text"] }] }] }),
    "invalid column list": validState({ workspaces: [{ id: "w", boards: [{ id: "b", records: [], columns: "serial" }] }] }),
    "members not a list": validState({ members: {} }),
    "settings not an object": validState({ settings: [] }),
    "prototype-pollution key": "{\"schemaVersion\":1,\"workspaces\":[{\"id\":\"w\",\"boards\":[],\"__proto__\":{\"admin\":true}}]}",
    "excessive nesting": validState({ settings: { deep: JSON.parse("[".repeat(40) + "]".repeat(40)) } })
  };
  for (const [name, body] of Object.entries(rejected)) {
    test(`PUT ${name} → 400 VALIDATION_ERROR and the stored state is unchanged`, async () => {
      const before = await (await fetch(`${api.url}/api/v1/state`)).json();
      const res = await fetch(`${api.url}/api/v1/state`, json(body));
      assert.equal(res.status, 400);
      assertErrorShape(await res.json(), "VALIDATION_ERROR");
      assert.deepEqual(await (await fetch(`${api.url}/api/v1/state`)).json(), before);
    });
  }

  test("PUT without a JSON content type → 400", async () => {
    const res = await fetch(`${api.url}/api/v1/state`, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(validState()) });
    assert.equal(res.status, 400);
    assertErrorShape(await res.json(), "VALIDATION_ERROR");
  });

  test("oversized payload (> 10 MB) → 413 PAYLOAD_TOO_LARGE", async () => {
    const big = validState({ settings: { padding: "x".repeat(11 * 1024 * 1024) } });
    const res = await fetch(`${api.url}/api/v1/state`, json(big));
    assert.equal(res.status, 413);
    assertErrorShape(await res.json(), "PAYLOAD_TOO_LARGE");
  });

  test("a large but allowed payload (≈ 6 MB) is accepted", async () => {
    const res = await fetch(`${api.url}/api/v1/state`, json(validState({ settings: { padding: "x".repeat(6 * 1024 * 1024) } })));
    assert.equal(res.status, 200);
  });
});

describe("API: unknown routes and failures", () => {
  let api; before(async () => { api = await startApp(); }); after(() => api.close());

  for (const [method, path] of [["GET", "/api/v1/unknown"], ["GET", "/api/v1/workspaces"], ["POST", "/api/v1/health"], ["DELETE", "/api/v1/state"], ["GET", "/api/unversioned"], ["GET", "/api/v1/state/extra"]]) {
    test(`${method} ${path} → JSON 404, never index.html`, async () => {
      const res = await fetch(`${api.url}${path}`, { method });
      assert.equal(res.status, 404);
      assert.match(res.headers.get("content-type"), /application\/json/);
      const text = await res.text();
      assert.doesNotMatch(text, /<html|<!doctype/i);
      assertErrorShape(JSON.parse(text), "NOT_FOUND");
    });
  }

  test("internal failure → safe 500 INTERNAL_ERROR (details only in the server log)", async () => {
    const failing = { loadState: async () => { throw new Error("Simulated failure at C:\\secret\\path with mongodb details"); }, saveState: async () => { throw new Error("boom"); } };
    const broken = await startApp({ repository: failing });
    try {
      for (const res of [await fetch(`${broken.url}/api/v1/state`), await fetch(`${broken.url}/api/v1/state`, json(validState()))]) {
        assert.equal(res.status, 500);
        const body = await res.json();
        assertErrorShape(body, "INTERNAL_ERROR");
        assert.doesNotMatch(JSON.stringify(body), /Simulated|secret|mongodb|boom/);
      }
      assert.equal(broken.logger.errors.length, 2, "the server log keeps the details");
    } finally { await broken.close(); }
  });
});

describe("Static frontend (same origin)", () => {
  let api; before(async () => { api = await startApp(); }); after(() => api.close());

  test("GET / → 200 index.html of the JARC frontend", async () => {
    const res = await fetch(`${api.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(await res.text(), /assets\/StorageService\.js/);
  });

  test("frontend assets are served", async () => {
    const res = await fetch(`${api.url}/assets/StorageService.js`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /class ApiAdapter/);
  });

  test("an unknown non-API path → 404, not index.html", async () => {
    const res = await fetch(`${api.url}/no-such-page`);
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /<html/i);
  });

  test("files outside site/ and dotfiles are not served", async () => {
    for (const path of ["/../server/package.json", "/%2e%2e/server/package.json", "/.env"]) {
      const res = await fetch(`${api.url}${path}`);
      assert.notEqual(res.status, 200, path);
    }
  });
});

describe("Configuration", () => {
  test("defaults: development on 127.0.0.1:3000 with the development state API", () => {
    // Stage 10 added dataStore/mongo/enableDevResourceApi; the defaults keep Stage 9 behaviour (memory, no MongoDB).
    assert.deepEqual({ ...loadConfig({}) }, { nodeEnv: "development", port: 3000, host: "127.0.0.1", dataStore: "memory", mongo: null, authMode: "dev", entra: null, accessPolicy: "role_based", accessPolicyIgnored: false, enableDevStateApi: true, enableDevResourceApi: false });
  });
  test("production disables the transitional state API", async () => {
    // Stage 12: production also requires Entra ID settings (see entra-config tests); placeholders here.
    assert.equal(loadConfig(entraEnv({ NODE_ENV: "production" })).enableDevStateApi, false);
    const prod = await startApp({ enableDevStateApi: false, environment: "production", repository: null });
    try {
      assert.equal((await fetch(`${prod.url}/api/v1/state`)).status, 404);
      assert.equal((await fetch(`${prod.url}/api/v1/health`)).status, 200);
    } finally { await prod.close(); }
  });
  test("an invalid PORT is rejected", () => {
    assert.throws(() => loadConfig({ PORT: "abc" }), /PORT/);
    assert.throws(() => loadConfig({ PORT: "70000" }), /PORT/);
  });
});
