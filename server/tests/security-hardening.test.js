// Phase M4.2A security hardening: compressed JSON request bodies are refused (express.json inflate: false), before
// authentication and without being decompressed, while normal uncompressed requests keep working — on the
// development state API, the resource API and the public Entra sign-in endpoints.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const { startApp, startMongoApp, startEntraApp, validState } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");

const send = (url, method, body, encoding) => fetch(url, { method, headers: { "Content-Type": "application/json", ...(encoding ? { "Content-Encoding": encoding } : {}) }, body });
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const compressors = { gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync };

describe("compressed request bodies are refused", () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await app.close(); });

  for (const [encoding, compress] of Object.entries(compressors)) {
    test(`${encoding}: 415 UNSUPPORTED_ENCODING, nothing stored`, async () => {
      const r = await json(await send(`${app.url}/api/v1/state`, "PUT", compress(Buffer.from(JSON.stringify(validState({ settings: { density: "compact" } })))), encoding));
      assert.equal(r.status, 415);
      assert.equal(r.body.error.code, "UNSUPPORTED_ENCODING");
      assert.doesNotMatch(JSON.stringify(r.body), /zlib|inflate|stack|body-parser/i, "no internals in the answer");
      const now = await json(await fetch(`${app.url}/api/v1/state`));
      assert.notEqual(now.body?.state?.settings?.density, "compact");
    });
  }

  test("a decompression bomb is refused without being decompressed", async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(200 * 1024 * 1024, 0x20)); // 200 MB of spaces → about 200 KB compressed
    const started = Date.now(), before = process.memoryUsage().rss;
    const r = await send(`${app.url}/api/v1/state`, "PUT", bomb, "gzip");
    assert.equal(r.status, 415);
    assert.ok(Date.now() - started < 5000, "answered quickly");
    assert.ok(process.memoryUsage().rss - before < 100 * 1024 * 1024, "no large allocation");
  });

  test("uncompressed and explicit identity bodies work as before", async () => {
    const body = JSON.stringify(validState({ settings: { density: "compact" } }));
    assert.equal((await send(`${app.url}/api/v1/state`, "PUT", body)).status, 200);
    assert.equal((await send(`${app.url}/api/v1/state`, "PUT", body, "identity")).status, 200);
    assert.equal((await json(await fetch(`${app.url}/api/v1/state`))).body.state.settings.density, "compact");
    assert.equal((await json(await send(`${app.url}/api/v1/state`, "PUT", "{not json"))).body.error.code, "VALIDATION_ERROR");
  });
});

describe("resource API and public sign-in endpoints", () => {
  test("resource API: gzip refused, plain JSON creates records", async () => {
    const app = await startMongoApp();
    try {
      const ws = await json(await send(`${app.url}/api/v1/workspaces`, "POST", JSON.stringify({ name: "Plain" })));
      assert.equal(ws.status, 201);
      const refused = await json(await send(`${app.url}/api/v1/workspaces`, "POST", zlib.gzipSync(JSON.stringify({ name: "Zipped" })), "gzip"));
      assert.equal(refused.status, 415);
      const list = await json(await fetch(`${app.url}/api/v1/workspaces`));
      assert.ok(!JSON.stringify(list.body).includes("Zipped"));
    } finally { await app.close(); }
  });
  test("Entra mode: an unauthenticated compressed body is refused before any sign-in logic runs", async () => {
    const app = await startEntraApp({ issuer: await createTokenIssuer() });
    try {
      const r = await json(await send(`${app.url}/api/v1/auth/session`, "POST", zlib.gzipSync(JSON.stringify({ idToken: "x", state: "y" })), "gzip"));
      assert.equal(r.status, 415); assert.equal(r.body.error.code, "UNSUPPORTED_ENCODING");
      const plain = await json(await send(`${app.url}/api/v1/auth/session`, "POST", JSON.stringify({ idToken: "x", state: "y" })));
      assert.notEqual(plain.status, 415, "plain sign-in requests are still processed (and refused for the bad token)");
    } finally { await app.close(); }
  });
});
