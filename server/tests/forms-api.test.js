// Native forms through the real routes on the fake MongoDB: design rights, submission rights, validation, conditions,
// duplicate prevention, audit, and that nothing can reach a form without a session or make one public.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const { cleanForm, submittedValues, fieldApplies } = require("../src/domain/form");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();

const BOARD = { groups: [{ id: "grp_aaaaaa", name: "A" }], columns: [{ key: "serial", label: "Item", type: "text" }, { key: "state", label: "State", type: "status", options: ["New", "Done"] }, { key: "why", label: "Why", type: "text" }, { key: "n", label: "Count", type: "number" }, { key: "ok", label: "OK", type: "checkbox" }, { key: "kind", label: "Kind", type: "text" }, { key: "doc", label: "Doc", type: "files" }] };
const FORM = (over = {}) => ({ name: "F", status: "published", mode: "create", fields: [{ key: "serial" }, { key: "state" }, { key: "why", required: true, showWhen: { key: "state", cmp: "is", values: ["Done"] } }, { key: "kind", hidden: true, defaultValue: "Swap" }], ...over });

describe("form definitions", () => {
  test("a valid definition is cleaned; the item name is always required on a create form", () => {
    const f = cleanForm(FORM(), BOARD);
    assert.equal(f.fields[0].required, true);
    assert.equal(f.status, "published");
  });
  test("anything unknown is refused, including an attempt to make a form public", () => {
    for (const extra of [{ public: true }, { isPublic: true }, { anonymous: true }, { token: "x" }]) assert.throws(() => cleanForm(FORM(extra), BOARD), /not allowed|unknown|Unexpected|isn't|allowed/i, JSON.stringify(extra));
  });
  test("bad definitions are refused", () => {
    const bad = [{ fields: [] }, { fields: [{ key: "nope" }] }, { fields: [{ key: "serial" }, { key: "serial" }] }, { fields: [{ key: "state" }] }, { fields: [{ key: "serial", hidden: true, defaultValue: "x" }] }, { fields: [{ key: "serial" }, { key: "why", hidden: true, required: true }] }, { fields: [{ key: "serial" }, { key: "doc", hidden: true }] }, { fields: [{ key: "serial" }, { key: "why", showWhen: { key: "why", cmp: "hasValue" } }] }, { fields: [{ key: "serial" }, { key: "why", showWhen: { key: "absent", cmp: "hasValue" } }] }, { fields: [{ key: "serial" }, { key: "why", showWhen: { key: "serial", cmp: "matches", values: ["x"] } }] }, { fields: [{ key: "serial" }, { key: "__proto__" }] }, { groupId: "grp_nothere" }, { uniqueKey: "n" }, { mode: "publish" }, { status: "public" }];
    for (const over of bad) assert.throws(() => cleanForm(FORM(over), BOARD), undefined, JSON.stringify(over));
  });
});

describe("submitted values", () => {
  const form = cleanForm(FORM(), BOARD);
  test("a condition decides whether a field is required and accepted", () => {
    assert.deepEqual(submittedValues(form, BOARD, { serial: "A", state: "New" }).missing, []);
    assert.deepEqual(submittedValues(form, BOARD, { serial: "A", state: "Done" }).missing, ["Why"]);
    assert.equal(submittedValues(form, BOARD, { serial: "A", state: "Done", why: "x" }).values.why, "x");
    assert.throws(() => submittedValues(form, BOARD, { serial: "A", state: "New", why: "x" }), /doesn't apply/);
  });
  test("only this form's visible fields can be sent; hidden fields only ever hold the default", () => {
    assert.throws(() => submittedValues(form, BOARD, { serial: "A", n: 3 }), /doesn't accept/);
    assert.throws(() => submittedValues(form, BOARD, { serial: "A", kind: "Other" }), /doesn't accept/);
    assert.equal(submittedValues(form, BOARD, { serial: "A" }).values.kind, "Swap");
  });
  test("a query operator or nested value is refused, so it can never reach the duplicate check's query", () => {
    for (const bad of [{ $ne: null }, { $gt: "" }, ["$where"], [{ a: 1 }], { nested: { x: 1 } }]) assert.throws(() => submittedValues(form, BOARD, { serial: bad }), undefined, JSON.stringify(bad));
  });
  test("choices are limited to the column's options", () => {
    assert.throws(() => submittedValues(form, BOARD, { serial: "A", state: "Invented" }), /one of its choices/);
  });
  test("a loop in conditions never applies and can't hang", () => {
    const loop = { fields: [{ key: "a", showWhen: { key: "b", cmp: "hasValue" } }, { key: "b", showWhen: { key: "a", cmp: "hasValue" } }] };
    assert.equal(fieldApplies(loop.fields[0], loop, { a: "1", b: "1" }), false);
  });
  test("an update form leaves unanswered cells alone, except a hidden default", () => {
    const update = cleanForm(FORM({ mode: "update", fields: [{ key: "why", defaultValue: "kept" }, { key: "kind", hidden: true, defaultValue: "Swap" }] }), BOARD);
    assert.deepEqual(submittedValues(update, BOARD, {}).values, { kind: "Swap" });
  });
});

describe("forms API and screens (real app, headless browser, role_based)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, ws; const browsers = {};
  const OIDS = { admin: "0d0d0d0d-0000-4000-8000-000000000071", mia: "0d0d0d0d-0000-4000-8000-000000000072", vic: "0d0d0d0d-0000-4000-8000-000000000073", out: "0d0d0d0d-0000-4000-8000-000000000074" };
  const signIn = (b, who, isAdmin) => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${who}&email=${who}@example.invalid&admin=${isAdmin ? 1 : 0}&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const call = (b, method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1" + ${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) }, ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`} }); let json = null; try { json = await r.json(); } catch {} return { status: r.status, body: json }; })()`);
  const api = (method, p, body, who) => call(browsers[who || "anon"], method, p, body);
  const uuid = () => crypto.randomUUID();
  let board, form;
  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    for (const who of ["admin", "mia", "vic", "out", "anon"]) { browsers[who] = await launch(BROWSER); await browsers[who].open(`${base}/api/v1/health`, { width: 1440 }); if (who !== "anon") await signIn(browsers[who], who, who === "admin"); }
    ws = (await api("POST", "/workspaces", { name: "Forms" }, "admin")).body.workspace;
    for (const [who, role] of [["mia", "MEMBER"], ["vic", "VIEWER"]]) assert.equal((await api("POST", `/workspaces/${ws.id}/members`, { userId: (await api("GET", "/me", undefined, who)).body.user.id, role }, "admin")).status, 201);
    board = (await api("POST", `/workspaces/${ws.id}/boards`, { name: "Requests", columns: BOARD.columns }, "admin")).body.board;
  });
  after(async () => { for (const b of Object.values(browsers)) await b?.close(); server?.kill(); });
  const definition = (over = {}) => ({ name: "Swap", status: "published", fields: [{ key: "serial" }, { key: "state" }, { key: "why", required: true, showWhen: { key: "state", cmp: "is", values: ["Done"] } }], confirmation: "Thanks", ...over });

  test("no session → 401 on every route; no route is unauthenticated", async () => {
    const id = "0".repeat(24);
    for (const [m, p] of [["GET", `/boards/${board.id}/forms`], ["POST", `/boards/${board.id}/forms`], ["GET", `/forms/${id}`], ["PATCH", `/forms/${id}`], ["DELETE", `/forms/${id}`], ["POST", `/forms/${id}/submit`]]) assert.equal((await api(m, p, m === "GET" ? undefined : {})).status, 401, `${m} ${p}`);
  });
  test("only a workspace admin can design a form", async () => {
    for (const who of ["mia", "vic"]) assert.equal((await api("POST", `/boards/${board.id}/forms`, definition(), who)).status, 403, who);
    assert.equal((await api("POST", `/boards/${board.id}/forms`, definition(), "out")).status, 404, "not a member: it doesn't exist");
    const r = await api("POST", `/boards/${board.id}/forms`, definition(), "admin");
    assert.equal(r.status, 201); form = r.body.form;
  });
  test("a public flag is refused by the API too", async () => {
    assert.equal((await api("POST", `/boards/${board.id}/forms`, definition({ public: true }), "admin")).status, 400);
    assert.equal((await api("PATCH", `/forms/${form.id}`, definition({ expectedVersion: form.version, public: true }), "admin")).status, 400);
  });
  test("a member submits and gets a record; viewers and outsiders can't", async () => {
    const values = { serial: "Req 1", state: "New" };
    assert.equal((await api("POST", `/forms/${form.id}/submit`, { submissionKey: uuid(), values }, "vic")).status, 403);
    assert.equal((await api("POST", `/forms/${form.id}/submit`, { submissionKey: uuid(), values }, "out")).status, 404);
    const r = await api("POST", `/forms/${form.id}/submit`, { submissionKey: uuid(), values }, "mia");
    assert.equal(r.status, 201); assert.equal(r.body.record.values.serial, "Req 1"); assert.equal(r.body.confirmation, "Thanks");
  });
  test("required and conditional answers are enforced by the server, and an invalid value saves nothing", async () => {
    const r = await api("POST", `/forms/${form.id}/submit`, { submissionKey: uuid(), values: { serial: "Req 2", state: "Done" } }, "mia");
    assert.equal(r.status, 400); assert.match(r.body.error.message, /Please answer: Why/);
    assert.equal((await api("POST", `/forms/${form.id}/submit`, { submissionKey: uuid(), values: { serial: "Req 2", n: 1 } }, "mia")).status, 400);
    assert.equal((await api("GET", `/boards/${board.id}/records?q=${encodeURIComponent("Req 2")}&limit=5`, undefined, "admin")).body.items.length, 0);
  });
  test("the same attempt sent twice makes one record; someone else can't reuse its key", async () => {
    const submissionKey = uuid(), body = { submissionKey, values: { serial: "Req once" } };
    const results = await Promise.all([api("POST", `/forms/${form.id}/submit`, body, "mia"), api("POST", `/forms/${form.id}/submit`, body, "mia")]);
    assert.ok(results.filter((x) => x.status === 201).length === 1, results.map((x) => x.status).join());
    const again = await api("POST", `/forms/${form.id}/submit`, body, "mia");
    assert.equal(again.status, 200); assert.equal(again.body.repeated, true);
    assert.equal((await api("POST", `/forms/${form.id}/submit`, body, "admin")).status, 409);
    assert.equal((await api("GET", `/boards/${board.id}/records?q=${encodeURIComponent("Req once")}&limit=5`, undefined, "admin")).body.items.length, 1);
  });
  test("a refused attempt can be corrected and sent again with the same key", async () => {
    const submissionKey = uuid();
    assert.equal((await api("POST", `/forms/${form.id}/submit`, { submissionKey, values: { serial: "Req fix", state: "Invented" } }, "mia")).status, 400);
    assert.equal((await api("POST", `/forms/${form.id}/submit`, { submissionKey, values: { serial: "Req fix", state: "New" } }, "mia")).status, 201);
  });
  test("uniqueKey refuses a value another active record has", async () => {
    const f = (await api("POST", `/boards/${board.id}/forms`, definition({ name: "Unique", uniqueKey: "serial" }), "admin")).body.form;
    assert.equal((await api("POST", `/forms/${f.id}/submit`, { submissionKey: uuid(), values: { serial: "Only one" } }, "mia")).status, 201);
    const dup = await api("POST", `/forms/${f.id}/submit`, { submissionKey: uuid(), values: { serial: "Only one" } }, "mia");
    assert.equal(dup.status, 409); assert.equal(dup.body.error.code, "DUPLICATE_RECORD");
  });
  test("a draft is invisible to members and can't be submitted", async () => {
    const f = (await api("POST", `/boards/${board.id}/forms`, definition({ name: "Draft", status: "draft" }), "admin")).body.form;
    assert.equal((await api("GET", `/forms/${f.id}`, undefined, "mia")).status, 404);
    assert.ok(!(await api("GET", `/boards/${board.id}/forms`, undefined, "mia")).body.items.some((x) => x.id === f.id));
    assert.ok((await api("GET", `/boards/${board.id}/forms`, undefined, "admin")).body.items.some((x) => x.id === f.id));
    assert.equal((await api("POST", `/forms/${f.id}/submit`, { submissionKey: uuid(), values: { serial: "No" } }, "mia")).status, 409);
  });
  test("an update form changes the chosen record only, checks its version, and stays on this board", async () => {
    const created = (await api("POST", `/boards/${board.id}/records`, { values: { serial: "To edit", why: "old" } }, "admin")).body.record;
    const f = (await api("POST", `/boards/${board.id}/forms`, definition({ name: "Edit", mode: "update", fields: [{ key: "why" }] }), "admin")).body.form;
    assert.equal((await api("POST", `/forms/${f.id}/submit`, { submissionKey: uuid(), values: { why: "new" }, recordId: "not-an-id", expectedVersion: 1 }, "mia")).status, 400);
    assert.equal((await api("POST", `/forms/${f.id}/submit`, { submissionKey: uuid(), values: { why: "new" }, recordId: "a".repeat(24), expectedVersion: 1 }, "mia")).status, 404);
    assert.equal((await api("POST", `/forms/${f.id}/submit`, { submissionKey: uuid(), values: { why: "new" }, recordId: created.id, expectedVersion: 99 }, "mia")).status, 409);
    const ok = await api("POST", `/forms/${f.id}/submit`, { submissionKey: uuid(), values: { why: "new" }, recordId: created.id, expectedVersion: created.version }, "mia");
    assert.equal(ok.status, 201); assert.equal(ok.body.record.values.why, "new"); assert.equal(ok.body.record.values.serial, "To edit");
  });
  test("a submission is in the activity log, by its submitter", async () => {
    const r = await api("GET", "/activity?limit=50", undefined, "admin");
    assert.equal(r.status, 200);
    assert.ok(r.body.items.some((a) => a.action === "form.submitted" && a.summary.startsWith("Submitted form")));
  });
  test("deleting needs the current version", async () => {
    const f = (await api("POST", `/boards/${board.id}/forms`, definition({ name: "Gone" }), "admin")).body.form;
    assert.equal((await api("DELETE", `/forms/${f.id}?expectedVersion=9`, undefined, "admin")).status, 409);
    assert.equal((await api("DELETE", `/forms/${f.id}?expectedVersion=${f.version}`, undefined, "mia")).status, 403);
    assert.equal((await api("DELETE", `/forms/${f.id}?expectedVersion=${f.version}`, undefined, "admin")).status, 200);
    assert.equal((await api("GET", `/forms/${f.id}`, undefined, "admin")).status, 404);
  });

  // ---- The screens
  const openBoard = async (b, width = 1440) => {
    await b.open(`${base}/`, { width });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "app shown");
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes("Requests"))?.click()`);
    assert.ok(await b.waitFor("!!document.querySelector('[data-action=form-menu]')", 10000), "Forms button shown");
  };
  const setField = (b, name, value) => b.evaluate(`(() => { const el = document.querySelector('#overlay-root [name="${name}"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const pickMenu = async (b, text) => { await b.evaluate("document.querySelector('[data-action=form-menu]').click()"); assert.ok(await b.waitFor(`[...document.querySelectorAll('.forms-menu button')].some((x) => x.textContent.includes(${JSON.stringify(text)}))`, 5000), `menu has ${text}`); await b.evaluate(`[...document.querySelectorAll('.forms-menu button')].find((x) => x.textContent.includes(${JSON.stringify(text)})).click()`); };

  test("an admin designs and publishes a form on screen", async () => {
    const b = browsers.admin; await openBoard(b);
    await pickMenu(b, "New form");
    assert.ok(await b.waitFor("!!document.querySelector('.form-designer')", 5000));
    await setField(b, "name", "Screen form");
    await b.evaluate("document.querySelector('[data-action=form-field-add]').click()");
    assert.equal(await b.evaluate("document.querySelectorAll('.form-design-field').length"), 2);
    assert.equal(await b.evaluate("document.querySelector('.form-designer [name=name]').value"), "Screen form", "adding a field keeps what was typed");
    await b.evaluate(`(() => { const row = document.querySelectorAll('.form-design-field')[1]; row.querySelector('[name=key]').value = "why"; row.querySelector('[name=label]').value = "Why, exactly?"; row.querySelector('[name=required]').checked = true; })()`);
    await b.evaluate("document.querySelector('[data-action=form-field-add]').click()");
    await b.evaluate(`(() => { const rows = document.querySelectorAll('.form-design-field'); const row = rows[1]; row.querySelector('[name=key]').value = "why"; })()`);
    await b.evaluate(`(() => { const rows = document.querySelectorAll('.form-design-field'); rows[2].querySelector('[name=key]').value = "state"; const why = rows[1]; })()`);
    await b.evaluate("document.querySelector('[data-action=form-field-up][data-index=\\'2\\']').click()");
    await b.evaluate(`(() => { const row = [...document.querySelectorAll('.form-design-field')].find((r) => r.querySelector('[name=key]').value === "why"); row.querySelector('[name=whenKey]').value = "state"; row.querySelector('[name=whenCmp]').value = "is"; row.querySelector('[name=whenValues]').value = "Done"; })()`);
    await setField(b, "status", "published"); await setField(b, "confirmation", "Got it, thanks.");
    await b.evaluate("document.querySelector('.form-designer').requestSubmit()");
    assert.ok(await b.waitFor("!document.querySelector('.form-designer')", 5000), "saved and closed");
    const list = (await api("GET", `/boards/${board.id}/forms`, undefined, "admin")).body.items.find((x) => x.name === "Screen form");
    assert.equal(list.status, "published");
    assert.deepEqual(list.fields.map((x) => x.key), ["serial", "state", "why"]);
    assert.deepEqual(list.fields[2].showWhen, { key: "state", cmp: "is", values: ["Done"] });
  });
  for (const [label, width] of [["desktop", 1440], ["phone width", 390]]) {
    test(`a member fills it in, with its condition, on ${label}, and no page overflow`, async () => {
      const b = browsers.mia, name = `Screen ${width}`; await openBoard(b, width);
      await pickMenu(b, "Screen form");
      assert.ok(await b.waitFor("!!document.querySelector('.form-fill')", 5000));
      assert.equal(await b.evaluate("document.querySelector('.form-fill [data-field=why]').hidden"), true, "doesn't apply yet");
      assert.equal(await b.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, "no sideways scroll");
      await setField(b, "field:serial", name); await setField(b, "field:state", "Done");
      assert.equal(await b.evaluate("document.querySelector('.form-fill [data-field=why]').hidden"), false, "now it applies");
      assert.equal(await b.evaluate("document.querySelector('[name=\"field:why\"]').required"), true);
      await setField(b, "field:why", "Because");
      await b.evaluate("document.querySelector('.form-fill').requestSubmit()");
      assert.ok(await b.waitFor("!!document.querySelector('.form-done')", 5000), "confirmed");
      assert.match(await b.evaluate("document.querySelector('.form-done').textContent"), /Got it, thanks\./);
      const found = (await api("GET", `/boards/${board.id}/records?q=${encodeURIComponent(name)}&limit=5`, undefined, "admin")).body.items;
      assert.equal(found.length, 1); assert.equal(found[0].values.why, "Because");
    });
  }
  test("a member and a viewer don't see the designer controls", async () => {
    for (const who of ["mia", "vic"]) { const b = browsers[who]; await openBoard(b); await b.evaluate("document.querySelector('[data-action=form-menu]').click()"); assert.ok(await b.waitFor("!!document.querySelector('.forms-menu [data-action=form-fill]') && !document.querySelector('.forms-menu .forms-menu-loading')", 5000), `${who}: the list has loaded`); assert.equal(await b.evaluate("document.querySelectorAll('.forms-menu [data-action=form-new], .forms-menu [data-action=form-edit]').length"), 0, who); }
  });
  test("the same form text can't inject markup", async () => {
    const f = (await api("POST", `/boards/${board.id}/forms`, definition({ name: "<img src=x onerror=window.__x=1>", description: "<script>window.__x=1</script>", fields: [{ key: "serial", label: "<b id=hax>x</b>", help: "<i id=hax2>y</i>" }] }), "admin")).body.form;
    const b = browsers.mia; await openBoard(b); await pickMenu(b, "<img");
    assert.ok(await b.waitFor("!!document.querySelector('.form-fill')", 5000));
    assert.equal(await b.evaluate("!document.querySelector('#hax') && !document.querySelector('#hax2') && !window.__x"), true);
    assert.ok(f.id);
  });
});
