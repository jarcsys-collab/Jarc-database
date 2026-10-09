// Default storage mode and the GitHub Pages entry point.
//   - With Microsoft sign-in configured (AUTH_MODE=entra, always in production) the server's index.html opens the app
//     in resource mode (MongoDB + Microsoft sign-in) without ?storage=resource; ?storage=local still selects browser
//     storage. Without it (AUTH_MODE=dev, memory) the page keeps browser storage by default.
//   - GitHub Pages publishes only pages/index.html, which redirects to the Railway app (no loop, no asset paths).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const { startApp, startEntraApp } = require("./helpers");
const { createTokenIssuer } = require("./support/entra-tokens");
const { createApp } = require("../src/app");

const ROOT = path.resolve(__dirname, "..", "..");
const APP_URL = "https://jarc-database-production.up.railway.app/";
const metaOf = (html) => /<meta name="jarc-storage-default" content="([^"]*)">/.exec(html)?.[1];

describe("Server: default storage mode in index.html", () => {
  let entra, dev;
  before(async () => { entra = await startEntraApp({ issuer: await createTokenIssuer() }); dev = await startApp(); });
  after(async () => { await entra.close(); await dev.close(); });

  test("AUTH_MODE=entra: / and /index.html open in resource mode, revalidated on every load", async () => {
    for (const p of ["/", "/index.html", "/?storage=local"]) {
      const res = await fetch(entra.url + p);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get("content-type"), /text\/html/);
      assert.equal(res.headers.get("cache-control"), "no-cache");
      const html = await res.text();
      assert.equal(metaOf(html), "resource", p);
      assert.ok(html.includes('src="assets/StorageService.js"'), "the rest of the page is unchanged");
    }
    assert.equal((await fetch(`${entra.url}/assets/StorageService.js`)).status, 200, "assets still served");
  });

  test("without Microsoft sign-in (AUTH_MODE=dev / memory): browser storage stays the default", async () => {
    for (const p of ["/", "/index.html"]) assert.equal(metaOf(await (await fetch(dev.url + p)).text()), "local", p);
  });

  test("the checked-in page defaults to local, and the server refuses a page without the marker", () => {
    assert.equal(metaOf(fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8")), "local");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarc-site-"));
    try {
      fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>no marker</title>");
      assert.throws(() => createApp({ environment: "test", enableDevStateApi: false, siteDir: dir, dataLayer: { repos: {} }, auth: { mode: "entra", entra: {}, verify: () => {} } }), /jarc-storage-default/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("Frontend: StorageService.createAdapter", () => {
  const load = () => {
    const window = { location: { search: "" }, localStorage: null, sessionStorage: null, dispatchEvent() {}, addEventListener() {} };
    const context = vm.createContext({ window, console, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, CustomEvent: class {} });
    for (const file of ["ResourceApiAdapter.js", "StorageService.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, "site", "assets", file), "utf8"), context, { filename: file });
    return window.StorageService;
  };
  const docWith = (content) => ({ querySelector: (sel) => (sel === 'meta[name="jarc-storage-default"]' && content !== undefined ? { getAttribute: () => content } : null) });

  test("the page's default decides when the URL has no ?storage=", () => {
    const S = load();
    assert.equal(S.createAdapter("", "resource").mode, "resource");
    assert.equal(S.createAdapter("", "local").mode, "local");
    assert.equal(S.createAdapter("?other=1", "resource").mode, "resource");
  });

  test("an explicit ?storage= always wins: local stays available on the deployed app", () => {
    const S = load();
    assert.equal(S.createAdapter("?storage=local", "resource").mode, "local");
    assert.equal(S.createAdapter("?storage=resource", "local").mode, "resource");
    assert.equal(S.createAdapter("?storage=api", "resource").mode, "api");
  });

  test("defaultMode reads the meta tag; only the exact value resource switches modes", () => {
    const S = load();
    assert.equal(S.defaultMode(docWith("resource")), "resource");
    for (const value of ["local", "RESOURCE", "api", "", undefined]) assert.equal(S.defaultMode(docWith(value)), "local", String(value));
    assert.equal(S.defaultMode(null), "local", "no document (tests, workers)");
  });
});

describe("GitHub Pages entry page", () => {
  const html = fs.readFileSync(path.join(ROOT, "pages", "index.html"), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const run = (host) => {
    const replaced = [];
    vm.runInNewContext(script, { URL, location: { host, replace: (url) => replaced.push(url) } });
    return replaced;
  };

  test("redirects to the Railway app three ways: script, meta refresh and a visible link", () => {
    assert.ok(html.includes(`<meta http-equiv="refresh" content="0; url=${APP_URL}">`));
    assert.ok(html.includes(`href="${APP_URL}"`));
    assert.deepEqual(run("jarcsys-collab.github.io"), [APP_URL]);
  });

  test("no loop: the page never redirects to its own host", () => {
    assert.deepEqual(run("jarc-database-production.up.railway.app"), []);
  });

  test("self-contained: no assets, scripts or API calls that could break under /Jarc-database/", () => {
    assert.doesNotMatch(html, /(src|href)="(?!https:\/\/jarc-database-production\.up\.railway\.app\/")/);
    assert.doesNotMatch(html, /\/api\/|fetch\(|storage=/);
  });

  test("the Pages workflow publishes only the entry page (index.html and 404.html), never site/", () => {
    const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "pages.yml"), "utf8");
    assert.match(workflow, /cp pages\/index\.html _pages\/index\.html/);
    assert.match(workflow, /cp pages\/index\.html _pages\/404\.html/);
    assert.match(workflow, /path: _pages\b/);
    assert.ok(workflow.includes(`APP_URL: ${APP_URL}`));
    assert.doesNotMatch(workflow, /path: site\b/);
  });
});
