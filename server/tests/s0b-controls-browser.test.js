// S0-B controls a person can see, in the REAL app in ONE headless browser, in-process on the fake MongoDB (role_based, synthetic
// data only). Every check uses tests/support/interactable.js (real visibility, size, viewport/scroll reachability, clipping,
// elementFromPoint obstruction, focus) and real DevTools clicks, never DOM existence:
//   - a saved view whose condition names a Connect column the reader can't open: the refusal is shown (no rows, no count, no
//     linked names), and its "Go to Main Table" and "Choose another view" buttons really work (desktop and 390 px phone);
//   - a Connect cell holding more than 100 links: the server stops at its bound and the Connect and Mirror cells carry a visible
//     "partial" mark (light and dark); complete cells carry none;
//   - the reader who can't open the linked board sees a lock in those cells, never a partial mark, names or a count.
// Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { ObjectId } = require("mongodb");
const { createApp } = require("../src/app");
const { MemoryStateRepository } = require("../src/repositories/memory-state-repository");
const { MongoConnection } = require("../src/db/connection");
const { ensureDatabase } = require("../src/db/bootstrap");
const { createDataLayer } = require("../src/data-layer");
const { MemoryFileStore } = require("../src/files/file-store");
const { createEntraVerifier } = require("../src/auth/entra-token");
const { createTokenIssuer } = require("./support/entra-tokens");
const { FakeMongoClient } = require("./support/fake-mongo");
const { findBrowser, launch, sleep, freePort } = require("./support/headless-browser");
const { verifyControl, checkInteractable, summary } = require("./support/interactable");

const BROWSER = findBrowser();
const OIDS = { admin: "0e0e0e0e-0000-4000-8000-0000000000c1", mia: "0e0e0e0e-0000-4000-8000-0000000000c2" };
const REFUSED = ".view-refused";
const ROWS = "document.querySelectorAll('.editable-table tbody tr[data-record-context]').length";
const row = (name) => `[...document.querySelectorAll('tr[data-record-context]')].find((t) => t.textContent.includes(${JSON.stringify(name)}))`;

describe("S0-B controls in the real app: refused view actions, partial marks, locks (headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let app, server, base, b, connection, projects;
  const page = () => ({ evaluate: (e) => b.evaluate(e), send: (m, p) => b.send(m, p) });
  const signIn = (who, isAdmin = false) => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${who}&email=${who}@example.invalid&admin=${isAdmin ? 1 : 0}&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: r.status === 204 ? null : await r.json() }; })()`);
  const freshBrowser = async (who, isAdmin) => { await b?.close(); b = await launch(BROWSER); await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn(who, isAdmin); };
  const openProjects = async ({ width = 1440, height = 900, theme = "light" } = {}) => {
    await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
    await b.open(`${base}/`, { width, height });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "app shown");
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Projects"))?.click()`);
    assert.ok(await b.waitFor(`${ROWS} > 0`, 20000), "rows");
    await b.evaluate(`(() => { const d = document.documentElement, t = ${JSON.stringify(theme)}; d.dataset.theme = t; new MutationObserver(() => { if (d.dataset.theme !== t) d.dataset.theme = t; }).observe(d, { attributes: true, attributeFilter: ["data-theme"] }); })()`);
    await sleep(300);
  };
  const openView = async (name) => {
    await b.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((x) => x.textContent.includes(${JSON.stringify(name)}))?.click()`);
    assert.ok(await b.waitFor(`!!document.querySelector(${JSON.stringify(REFUSED)})`, 8000), `${name}: the refusal is shown`);
    await sleep(150);
  };

  before(async () => {
    const issuer = await createTokenIssuer();
    const port = await freePort();
    base = `http://localhost:${port}`;
    const entra = { ...issuer.config, redirectUri: `${base}/`, appOrigin: base };
    const fake = new FakeMongoClient();
    connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
    await connection.connect();
    await ensureDatabase(connection.db);
    const dataLayer = createDataLayer({ connection, logger: { error() {} }, fileStore: new MemoryFileStore(), recordSearch: "off" });
    app = createApp({ repository: new MemoryStateRepository(), environment: "test", dataLayer, auth: { mode: "entra", entra, verify: createEntraVerifier({ ...entra, keySet: issuer.keySet }) }, accessPolicy: "role_based", logger: { error() {} } });
    const outer = express();
    outer.get("/__test/id-token", async (req, res) => {
      const email = String(req.query.email || "");
      const claims = { oid: String(req.query.oid), name: String(req.query.name || ""), email, preferred_username: email, nonce: String(req.query.nonce || "") };
      if (req.query.admin === "1") claims.roles = ["JARC.Admin"];
      res.set("Cache-Control", "no-store").json({ token: await issuer.token(claims) });
    });
    outer.use((req, res, next) => app(req, res, next));
    server = await new Promise((resolve) => { const s = outer.listen(port, "127.0.0.1", () => resolve(s)); });
    await freshBrowser("mia");
    const miaId = (await api("GET", "/me")).body.user.id;
    await freshBrowser("admin", true);
    const wsA = (await api("POST", "/workspaces", { name: "Projects space" })).body.workspace, wsB = (await api("POST", "/workspaces", { name: "Clients space" })).body.workspace;
    assert.equal((await api("POST", `/workspaces/${wsA.id}/members`, { userId: miaId, role: "MEMBER" })).status, 201); // not in Clients space
    const clients = (await api("POST", `/workspaces/${wsB.id}/boards`, { name: "Clients", columns: [{ key: "serial", label: "Client", type: "text", required: true }, { key: "value", label: "Value", type: "number" }] })).body.board;
    const made = (await api("POST", `/boards/${clients.id}/records/batch`, { records: Array.from({ length: 120 }, (_, i) => ({ values: { serial: `Synthetic client ${i + 1}`, value: 1 } })) })).body.items.map((r) => r.id);
    assert.equal(made.length, 120);
    projects = (await api("POST", `/workspaces/${wsA.id}/boards`, { name: "Projects", columns: [{ key: "serial", label: "Project", type: "text", required: true }, { key: "client", label: "Clients", type: "connect", link: { boardId: clients.id }, multiple: true }, { key: "total", label: "Total value", type: "mirror", mirror: { via: "client", column: "value", show: "sum" } }] })).body.board;
    assert.ok(projects, "board with Connect and Mirror columns");
    const items = (await api("POST", `/boards/${projects.id}/records/batch`, { records: [{ values: { serial: "Synthetic small", client: made.slice(0, 2) } }, { values: { serial: "Synthetic big", client: made.slice(0, 100) } }, { values: { serial: "Synthetic none" } }] })).body.items;
    // More than 100 links in one cell can't be written through the API (100 max): put the 101st+ straight into the stored cell,
    // as a pre-S0-B import could have, so the server's own cell bound marks it partial.
    const big = items.find((r) => r.values.serial === "Synthetic big");
    await connection.db.collection("records").updateOne({ _id: new ObjectId(big.id) }, { $set: { "values.client": made.slice(0, 110) } });
    const fresh = (await api("GET", `/boards/${projects.id}`)).body.board;
    const saved = await api("PATCH", `/boards/${projects.id}`, { expectedVersion: fresh.version, savedViews: [{ name: "Linked only", state: { view: "table", filter: { op: "and", rules: [{ key: "client", cmp: "notEmpty" }] } } }, { name: "Everything", state: { view: "table" } }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 200));
  });
  after(async () => { await b?.close(); app?.locals?.realtime?.closeAll?.(); await new Promise((r) => (server ? server.close(r) : r())); });

  test("owner, light and dark: the cut cell's Connect and Mirror cells carry a visible partial mark; complete cells none", async () => {
    for (const theme of ["light", "dark"]) {
      await openProjects({ theme });
      assert.ok(await b.waitFor(`!!${row("Synthetic big")}?.querySelector('td[data-column-key=client] .relation-partial') && !!${row("Synthetic big")}?.querySelector('td[data-column-key=total] .relation-partial')`, 10000), `${theme}: partial marks on the cut row`);
      for (const key of ["client", "total"]) {
        const sel = `tr[data-record-context]:has([aria-label^="Project: Synthetic big"]) td[data-column-key=${key}] .relation-partial`;
        const r = await checkInteractable(page(), sel, { focus: false, minWidth: 6, minHeight: 6 });
        assert.equal(r.ok, true, `${theme} ${key}: the partial mark is really visible ${JSON.stringify(summary(r))}`);
        const label = await b.evaluate(`document.querySelector(${JSON.stringify(sel)}).getAttribute("aria-label")`);
        assert.match(label, /^Partial: Only the first 100 linked records are included/, `${theme} ${key}: says why`);
      }
      assert.equal(await b.evaluate(`${row("Synthetic small")}.querySelectorAll('.relation-partial').length`), 0, `${theme}: a complete row has no mark`);
      assert.equal(await b.evaluate(`${row("Synthetic none")}.querySelectorAll('.relation-partial').length`), 0, `${theme}: an empty row has no mark`);
    }
  });

  test("restricted reader: locks only in Connect / Mirror cells (no names, no count, no partial mark)", async () => {
    await freshBrowser("mia");
    await openProjects();
    assert.ok(await b.waitFor(`!!${row("Synthetic big")}?.querySelector('td[data-column-key=client] .relation-locked')`, 10000), "lock shown");
    const lock = await checkInteractable(page(), 'tr[data-record-context]:has([aria-label^="Project: Synthetic big"]) td[data-column-key=client] .relation-locked', { focus: false });
    assert.equal(lock.ok, true, `the lock is really visible ${JSON.stringify(summary(lock))}`);
    const cells = await b.evaluate("[...document.querySelectorAll('tr[data-record-context] td[data-column-key=client], tr[data-record-context] td[data-column-key=total]')].map((td) => ({ text: td.textContent.replace(/\\s+/g, ' ').trim(), partial: !!td.querySelector('.relation-partial') }))");
    assert.ok(cells.length >= 6);
    for (const c of cells) { assert.doesNotMatch(c.text, /Synthetic client|\d/, `no names or counts (${c.text})`); assert.equal(c.partial, false, "no partial mark for a restricted reader"); }
  });

  test("restricted reader, desktop: the refused view shows nothing under its name; Go to Main Table and Choose another view really work", async () => {
    await openProjects();
    await openView("Linked only");
    const refused = await b.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(REFUSED)}); return { text: s.textContent, role: s.getAttribute("role"), table: !!document.querySelector('.editable-table tbody tr[data-record-context]') }; })()`);
    assert.equal(refused.role, "alert");
    assert.equal(refused.table, false, "no rows under the view's name");
    assert.match(refused.text, /“Linked only” can't be shown/);
    assert.doesNotMatch(refused.text, /Synthetic|\d+ (records|matching)/, "no record names, no count");
    const main = await verifyControl(page(), `${REFUSED} [data-action="main-table"]`, { click: true, expect: `!document.querySelector(${JSON.stringify(REFUSED)}) && ${ROWS} === 3`, closeWith: null, minWidth: 40, minHeight: 24 });
    assert.equal(main.ok, true, `Go to Main Table ${JSON.stringify(summary(main))}`);
    await openView("Linked only");
    const other = await verifyControl(page(), `${REFUSED} [data-action="views-menu"]`, { click: true, expect: "!!document.querySelector('#overlay-root .views-menu')", minWidth: 40, minHeight: 24 });
    assert.equal(other.ok, true, `Choose another view opens the views menu and Escape closes it ${JSON.stringify(summary(other))}`);
    // Choosing another view from the menu leaves the refusal.
    await b.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((x) => x.textContent.includes("Everything"))?.click()`);
    assert.ok(await b.waitFor(`!document.querySelector(${JSON.stringify(REFUSED)}) && ${ROWS} === 3`, 8000), "another view shows its rows");
  });

  test("restricted reader, 390 px phone and dark: the refusal's buttons are tappable", async () => {
    await openProjects({ width: 390, height: 844, theme: "dark" });
    await openView("Linked only");
    const main = await verifyControl(page(), `${REFUSED} [data-action="main-table"]`, { click: "touch", expect: `!document.querySelector(${JSON.stringify(REFUSED)})`, closeWith: null, minWidth: 40, minHeight: 24 });
    assert.equal(main.ok, true, `phone: Go to Main Table ${JSON.stringify(summary(main))}`);
    await openView("Linked only");
    const other = await verifyControl(page(), `${REFUSED} [data-action="views-menu"]`, { click: "touch", expect: "!!document.querySelector('#overlay-root .views-menu')", minWidth: 40, minHeight: 24 });
    assert.equal(other.ok, true, `phone: Choose another view ${JSON.stringify(summary(other))}`);
    assert.ok((await b.evaluate("document.documentElement.scrollWidth - innerWidth")) <= 1, "no page-level sideways scroll");
  });

  test("owner (can open the linked board): the same view is not refused and shows its two linked rows", async () => {
    await freshBrowser("admin", true);
    await openProjects();
    await b.evaluate(`[...document.querySelectorAll('.view-tabs [role=tab]')].find((x) => x.textContent.includes("Linked only"))?.click()`);
    assert.ok(await b.waitFor(`!document.querySelector(${JSON.stringify(REFUSED)}) && ${ROWS} === 2`, 8000), "owner sees the linked rows");
  });
});
