// T0 rollback with the ACTUAL older production code (server + its browser assets), not a simulation. For each rollback
// release (JARC_T0_ROLLBACK_REFS, default the current production 18df278 and fc9c58a): on ONE fake MongoDB,
//   1. this release (T0) saves a view with a column-header filter (the `columnFilter` view setting) through its real UI;
//   2. the older release, served from its own files on the same port, opens the view in a headless browser (the column filter
//      is NOT applied there: every record of the view's own filter shows), then renames the view, changes its sort, hides a
//      column, changes a filter condition and clicks "Save to this view";
//   3. the stored view still holds columnFilter, unchanged, next to the older release's edits;
//   4. this release again opens the view with the column filter applied on top of those edits.
// The older release's files are read from git (server/src, server/tests/helpers.js + support, site) into
// node_modules/.cache, or taken from JARC_T0_ROLLBACK_SOURCES (comma-separated checkouts, one per ref, same order).
// Offline, synthetic values only; one headless browser for the whole file. Skipped when no Chrome or Edge is installed.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const express = require("express");
const { FakeMongoClient } = require("./support/fake-mongo");
const { createTokenIssuer } = require("./support/entra-tokens");
const { findBrowser, launch, sleep, freePort } = require("./support/headless-browser");

const BROWSER = findBrowser();
const REFS = (process.env.JARC_T0_ROLLBACK_REFS || "18df278,fc9c58a").split(",").map((s) => s.trim()).filter(Boolean);
const SOURCES = (process.env.JARC_T0_ROLLBACK_SOURCES || "").split(",").map((s) => s.trim()).filter(Boolean);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const NEEDED = ["server/src", "server/package.json", "server/tests/helpers.js", "server/tests/support", "site"];
const THIS = path.join(REPO_ROOT, "server");

function sourceFor(ref, i) {
  if (SOURCES[i]) return path.resolve(SOURCES[i]);
  const dir = path.join(REPO_ROOT, "server", "node_modules", ".cache", `jarc-t0-rollback-${ref.replace(/[^0-9A-Za-z_-]/g, "")}`);
  if (fs.existsSync(path.join(dir, ".complete"))) return dir;
  const git = (args, input) => execFileSync("git", args, { cwd: REPO_ROOT, input, maxBuffer: 256 * 1024 * 1024 });
  const listing = git(["ls-tree", "-r", ref, "--", ...NEEDED]).toString("utf8").split("\n").filter(Boolean)
    .map((line) => { const [meta, file] = line.split("\t"); const [, type, sha] = meta.split(" "); return { type, sha, file }; }).filter((e) => e.type === "blob");
  const out = git(["cat-file", "--batch"], listing.map((e) => e.sha).join("\n") + "\n");
  let at = 0;
  for (const entry of listing) {
    const eol = out.indexOf(10, at), size = Number(out.subarray(at, eol).toString("utf8").split(" ")[2]);
    const target = path.join(dir, ...entry.file.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, out.subarray(eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  fs.writeFileSync(path.join(dir, ".complete"), ref);
  return dir;
}

// One release's real app (its own src/ and site/) on the shared fake MongoDB, at http://localhost:<port>, with the test
// sign-in route of tests/support/entra-server.js.
async function serve(serverDir, { fake, issuer, port }) {
  const need = (m) => require(path.join(serverDir, "src", m));
  const { MongoConnection } = need("db/connection"), { ensureDatabase } = need("db/bootstrap"), { createDataLayer } = need("data-layer");
  const { MemoryFileStore } = need("files/file-store"), { createApp } = need("app"), { createEntraVerifier } = need("auth/entra-token");
  const { MemoryStateRepository } = need("repositories/memory-state-repository");
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const dataLayer = createDataLayer({ connection, logger: { error() {} }, fileStore: new MemoryFileStore(), recordSearch: "off" });
  await dataLayer.searchIndex?.catchUp?.();
  const entra = { ...issuer.config, redirectUri: `http://localhost:${port}/`, appOrigin: `http://localhost:${port}` };
  const app = createApp({ repository: new MemoryStateRepository(), environment: "test", dataLayer, auth: { mode: "entra", entra, verify: createEntraVerifier({ ...entra, keySet: issuer.keySet }) }, accessPolicy: "role_based", logger: { error() {} } });
  const outer = express();
  outer.get("/__test/id-token", async (req, res) => res.set("Cache-Control", "no-store").json({ token: await issuer.token({ oid: String(req.query.oid), name: "tara", email: "tara@example.invalid", preferred_username: "tara@example.invalid", nonce: String(req.query.nonce || ""), roles: ["JARC.Admin"] }) }));
  outer.use((req, res, next) => app(req, res, next));
  const server = await new Promise((resolve) => { const s = outer.listen(port, "127.0.0.1", () => resolve(s)); });
  return { db: connection.db, close: () => { app.locals.realtime?.closeAll(); server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); } };
}

const COLUMNS = [{ key: "serial", label: "Item", type: "text", required: true }, { key: "state", label: "State", type: "status", options: ["Open", "Done"] }, { key: "notes", label: "Notes", type: "text" }];
const OID = "0d0d0d0d-0000-4000-8000-000000000091";
const COLUMN_FILTER = { key: "notes", op: "contains", value: "north" };
const DONE_ONLY = { op: "and", rules: [{ key: "state", cmp: "in", values: ["Done"] }] };

describe("T0 rollback on the real older releases (headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let b, port, base;
  before(async () => { port = await freePort(); base = `http://localhost:${port}`; b = await launch(BROWSER); });
  after(async () => { await b?.close(); });

  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const rows = () => b.evaluate("document.querySelectorAll('tr[data-record-context]').length");
  const rowNames = () => b.evaluate("[...document.querySelectorAll('tr[data-record-context]')].map((t) => (t.querySelector('td[data-column-key=serial]') || t).textContent.trim().match(/Job \\d/)?.[0] || '?')");
  const signIn = async () => {
    await b.open(`${base}/api/v1/health`, { width: 1440, height: 800 });
    await b.evaluate(`(async () => { const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json(); const { token } = await (await fetch("/__test/id-token?oid=${OID}&nonce=" + start.nonce)).json(); await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }); })()`);
  };
  const openBoard = async (count) => {
    await b.open(`${base}/`, { width: 1440, height: 800 });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 20000), "app shown");
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Rollback board"))?.click()`);
    assert.ok(await b.waitFor(`document.querySelectorAll('tr[data-record-context]').length === ${count}`, 20000), `board rows (${count})`);
    await sleep(200);
  };
  const openView = async (name, count) => {
    await b.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((x) => x.textContent.includes(${JSON.stringify(name)}))?.click()`);
    assert.ok(await b.waitFor(`document.querySelector('.view-tab.active')?.textContent.includes(${JSON.stringify(name)})`, 5000), `view ${name} open`);
    assert.ok(await b.waitFor(`document.querySelectorAll('tr[data-record-context]').length === ${count}`, 5000), `${name}: ${count} rows (has ${await rows()})`);
    await sleep(200);
  };
  const storedView = async (db, id) => (await db.collection("boards").findOne({ name: "Rollback board" })).savedViews.find((v) => String(v.id) === String(id));
  const waitStored = async (db, id, ok, what) => { let v = null; for (let i = 0; i < 80; i += 1) { v = await storedView(db, id); if (v && ok(v)) return v; await sleep(100); } assert.fail(`${what}: ${JSON.stringify(v)}`); };

  REFS.forEach((ref, i) => {
    describe(`rollback to ${ref}`, () => {
      const fake = new FakeMongoClient();
      let issuer, viewId, boardId, oldDir;
      before(async () => { issuer = await createTokenIssuer(); oldDir = path.join(sourceFor(ref, i), "server"); });

      test(`1. T0 saves a view with a column-header filter (real UI)`, async () => {
        const s = await serve(THIS, { fake, issuer, port });
        try {
          await signIn();
          const ws = (await api("POST", "/workspaces", { name: "Rollback" })).body.workspace;
          let board = (await api("POST", `/workspaces/${ws.id}/boards`, { name: "Rollback board", columns: COLUMNS })).body.board;
          boardId = board.id;
          const records = Array.from({ length: 6 }, (_, n) => ({ values: { serial: `Job ${n + 1}`, state: n % 2 ? "Open" : "Done", notes: n < 2 ? "north yard" : "south yard" } }));
          assert.equal((await api("POST", `/boards/${board.id}/records/batch`, { records })).status, 201);
          board = (await api("GET", `/boards/${board.id}`)).body.board;
          const patched = await api("PATCH", `/boards/${board.id}`, { expectedVersion: board.version, savedViews: [{ name: "Yard work", state: { view: "table", filter: DONE_ONLY } }] });
          assert.equal(patched.status, 200, JSON.stringify(patched.body).slice(0, 300));
          viewId = patched.body.board.savedViews[0].id;
          await openBoard(6);
          await openView("Yard work", 3);
          await b.evaluate("document.querySelector('th[data-column-key=notes] [data-action=column-menu]').click()"); await sleep(150);
          assert.equal(await click("[data-action=filter-column][data-key=notes]"), true, "Filter… in the column menu");
          assert.ok(await b.waitFor("!!document.querySelector('form[data-action=column-filter-form]')", 3000));
          await b.evaluate("(() => { const f = document.querySelector('form[data-action=column-filter-form]'); f.querySelector('[name=op]').value = 'contains'; f.querySelector('[name=value]').value = 'north'; f.requestSubmit(); })()");
          assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length === 1", 5000), "Done AND north: Job 1");
          assert.ok(await b.waitFor("!!document.querySelector('[data-action=save-active-view]')", 3000));
          await click("[data-action=save-active-view]");
          const v = await waitStored(s.db, viewId, (x) => x.state?.columnFilter, "T0 stored the column filter");
          assert.deepEqual(JSON.parse(v.state.columnFilter), COLUMN_FILTER);
        } finally { await s.close(); }
      });

      test(`2. ${ref} (real server + its browser assets): opens the view without the column filter, edits it and saves; columnFilter is kept`, async () => {
        const s = await serve(oldDir, { fake, issuer, port });
        try {
          const index = await (await fetch(`${base}/assets/BoardModel.js`)).text();
          assert.equal(index.includes("columnFilterSetting"), false, `${ref} serves its own (pre-T0) browser code`);
          await signIn();
          await openBoard(6);
          assert.equal(await b.evaluate("typeof BoardModel.columnFilterFrom"), "undefined", `the page runs ${ref}'s browser code (not a cached T0 copy)`);
          // What a person sees on the older release: the view's own conditions apply, the column filter does not (3 rows, not 1).
          await openView("Yard work", 3);
          assert.deepEqual((await rowNames()).sort(), ["Job 1", "Job 3", "Job 5"], "the view's own condition (Done), no column filter");
          assert.equal(await b.evaluate("!!document.querySelector('[data-action=save-active-view]')"), false, "the view does not show as changed on opening");
          // Rename (view menu → Rename view).
          assert.equal(await click(".view-tab.active [data-action=view-menu]"), true, "view menu"); await sleep(150);
          assert.equal(await click("[data-action=rename-view]"), true, "Rename view"); await sleep(150);
          await b.evaluate("(() => { const f = document.querySelector('form[data-action=rename-view-form]'); f.querySelector('[name=name]').value = 'Yard work (old)'; f.requestSubmit(); })()");
          await waitStored(s.db, viewId, (x) => x.name === "Yard work (old)", "renamed");
          assert.equal(JSON.parse((await storedView(s.db, viewId)).state.columnFilter).value, "north", "rename keeps it");
          // Change sort (Notes A→Z), hide a column (State), change a filter condition (State in Done → Done or Open).
          await b.evaluate("document.querySelector('th[data-column-key=notes] [data-action=column-menu]').click()"); await sleep(150);
          assert.equal(await click("[data-action=sort-column][data-direction=asc]"), true, "sort A→Z"); await sleep(200);
          await b.evaluate("document.querySelector('th[data-column-key=state] [data-action=column-menu]').click()"); await sleep(150);
          assert.equal(await click("[data-action=hide-column]"), true, "hide State"); await sleep(200);
          assert.equal(await b.evaluate("!!document.querySelector('th[data-column-key=state]')"), false, "State hidden");
          assert.equal(await click("[data-action=view-filter]"), true, "Filter conditions…");
          assert.ok(await b.waitFor("!!document.querySelector('form[data-action=view-filter-form] select[name=values]')", 3000), "condition editor");
          await b.evaluate("(() => { const f = document.querySelector('form[data-action=view-filter-form]'); for (const o of f.querySelector('select[name=values]').options) o.selected = o.value === 'Done' || o.value === 'Open'; f.requestSubmit(); })()");
          assert.ok(await b.waitFor("document.querySelectorAll('tr[data-record-context]').length === 6", 5000), `Done or Open: 6 rows on ${ref} (column filter still not applied)`);
          assert.ok(await b.waitFor("!!document.querySelector('[data-action=save-active-view]')", 3000), "changed");
          await click("[data-action=save-active-view]");
          const v = await waitStored(s.db, viewId, (x) => x.state?.sortKey === "notes" && (x.state?.filter?.rules?.[0]?.values || []).length === 2, `${ref} saved the view`);
          assert.equal(v.name, "Yard work (old)");
          assert.deepEqual(v.state.hiddenColumns, ["state"]);
          assert.deepEqual(v.state.filter.rules[0].values.sort(), ["Done", "Open"]);
          assert.equal(typeof v.state.columnFilter, "string", `${ref} kept columnFilter after "Save to this view"`);
          assert.deepEqual(JSON.parse(v.state.columnFilter), COLUMN_FILTER, "unchanged");
          // Duplicate on the older release: the original keeps columnFilter; the copy is made without it (that release
          // doesn't know the setting), so the copy shows every record of its conditions on T0 too.
          assert.equal(await click(".view-tab.active [data-action=view-menu]"), true, "view menu"); await sleep(150);
          assert.equal(await click("[data-action=duplicate-view]"), true, "Duplicate view");
          let copy = null;
          for (let n = 0; n < 80 && !copy; n += 1) { copy = (await s.db.collection("boards").findOne({ name: "Rollback board" })).savedViews.find((x) => x.name === "Yard work (old) copy"); if (!copy) await sleep(100); }
          assert.ok(copy, "copy stored");
          assert.equal("columnFilter" in copy.state, false, "the older release's copy has no column filter");
          assert.deepEqual(JSON.parse((await storedView(s.db, viewId)).state.columnFilter), COLUMN_FILTER, "the original keeps it");
          // A reload on the older release: still opens (without the column filter), nothing lost.
          await openBoard(6);
          await openView("Yard work (old)", 6);
        } finally { await s.close(); }
      });

      test(`3. T0 again (redeployed): the view opens with the column filter on top of ${ref}'s edits`, async () => {
        const s = await serve(THIS, { fake, issuer, port });
        try {
          await signIn();
          await openBoard(6);
          assert.equal(await b.evaluate("typeof BoardModel.columnFilterFrom"), "function", "the page runs T0's browser code again");
          await openView("Yard work (old)", 2);
          assert.deepEqual((await rowNames()).sort(), ["Job 1", "Job 2"], "north only (Done or Open)");
          assert.equal(await b.evaluate("!!document.querySelector('th[data-column-key=state]')"), false, "State still hidden");
          assert.equal(await b.evaluate("!!document.querySelector('[data-action=save-active-view]')"), false, "unchanged");
          assert.deepEqual(JSON.parse((await storedView(s.db, viewId)).state.columnFilter), COLUMN_FILTER);
          assert.ok(boardId);
        } finally { await s.close(); }
      });
    });
  });
});
