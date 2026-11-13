// Guided forms ("SuperForms") on screen (real app on the fake MongoDB, headless browser; generic synthetic data from
// tests/support/superform-fixture.js — the same definitions the migration planner produces). Covers: activation (a draft
// is invisible to members; the designer publishes it and keeps every guided setting), the buyer workflow (steps, required
// answers, searchable multi-select with chips, status choices, exact decimals, bounds, a suggestion that is never filled
// in by itself, documents per party type, review, one record from a double click, Pending, Item ID left empty, upload
// verified by the server, Activity History, opening the record), the seller workflow on a phone (stale answers and files
// of hidden questions never sent, no sideways scrolling), a failed upload retried without a second record or file,
// documents checked by the server (browser counts are no proof), undo history kept, a viewer refused, accessible names,
// Enter to go on, the simple form unchanged, an ended session.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const { findBrowser, launch, freePort, waitForServer } = require("./support/headless-browser");
const F = require("./support/superform-fixture");

const BROWSER = findBrowser();
const NATIVE = F.NATIVE, GUIDED = F.GUIDED;
const key = (label) => F.COLUMNS.find((c) => c.label === label).key;
const PDF = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF";

describe("guided forms in the app (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed", concurrency: false }, () => {
  let server, base, board, guidedForm; const browsers = {};
  const OIDS = { admin: "0d0d0d0d-0000-4000-8000-000000000091", mia: "0d0d0d0d-0000-4000-8000-000000000092", vic: "0d0d0d0d-0000-4000-8000-000000000093", sam: "0d0d0d0d-0000-4000-8000-000000000094" };
  const signIn = (b, who, isAdmin) => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OIDS[who]}&name=${who}&email=${who}@example.invalid&admin=${isAdmin ? 1 : 0}&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const call = (b, method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1" + ${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) }, ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`} }); let json = null; try { json = await r.json(); } catch {} return { status: r.status, body: json }; })()`);
  const api = (method, p, body, who = "admin") => call(browsers[who], method, p, body);
  const records = async (q) => (await api("GET", `/boards/${board.id}/records?q=${encodeURIComponent(q)}&limit=10`)).body.items;
  const attachments = async (id) => { const r = await api("GET", `/records/${id}/attachments`); return r.body.items || r.body.attachments || []; };

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port)], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    for (const who of Object.keys(OIDS)) { browsers[who] = await launch(BROWSER); await browsers[who].open(`${base}/api/v1/health`, { width: 1440 }); await signIn(browsers[who], who, who === "admin"); }
    const ws = (await api("POST", "/workspaces", { name: "Fictional Workspace" })).body.workspace;
    for (const [who, role] of [["mia", "MEMBER"], ["sam", "MEMBER"], ["vic", "VIEWER"]]) assert.equal((await api("POST", `/workspaces/${ws.id}/members`, { userId: (await api("GET", "/me", undefined, who)).body.user.id, role })).status, 201);
    const b = await api("POST", `/workspaces/${ws.id}/boards`, { name: F.BOARD_NAME, columns: F.COLUMNS, groups: F.GROUPS });
    assert.equal(b.status, 201, JSON.stringify(b.body)); board = b.body.board;
    const n = await api("POST", `/boards/${board.id}/forms`, F.definition(NATIVE)); assert.equal(n.status, 201, JSON.stringify(n.body));
    const s = await api("POST", `/boards/${board.id}/forms`, F.definition(GUIDED)); assert.equal(s.status, 201, JSON.stringify(s.body)); guidedForm = s.body.form;
  });
  after(async () => { for (const b of Object.values(browsers)) await b?.close(); server?.kill(); });

  // ---- Screen helpers
  const openBoard = async (b, width = 1440) => {
    await b.open(`${base}/`, { width });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item')", 15000), "app shown");
    await b.evaluate(`[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes(${JSON.stringify(F.BOARD_NAME)}))?.click()`);
    assert.ok(await b.waitFor("!!document.querySelector('[data-action=form-menu]')", 10000), "Forms button shown");
  };
  const menuNames = async (b) => { await b.evaluate("document.querySelector('[data-action=form-menu]').click()"); assert.ok(await b.waitFor("!!document.querySelector('.forms-menu') && !document.querySelector('.forms-menu .forms-menu-loading')", 5000), "the list has loaded"); return b.evaluate("[...document.querySelectorAll('.forms-menu [data-action=form-fill]')].map((x) => x.textContent.trim())"); };
  const openForm = async (b, name, selector = ".form-fill") => {
    await b.evaluate("document.querySelector('[data-action=form-menu]').click()");
    assert.ok(await b.waitFor(`[...document.querySelectorAll('.forms-menu [data-action=form-fill]')].some((x) => x.textContent.includes(${JSON.stringify(name)}))`, 5000), `menu has ${name}`);
    await b.evaluate(`[...document.querySelectorAll('.forms-menu [data-action=form-fill]')].find((x) => x.textContent.includes(${JSON.stringify(name)})).click()`);
    assert.ok(await b.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, 5000), "form open");
  };
  const type = (b, k, value) => b.evaluate(`(() => { const el = document.querySelector('.form-wizard [name="field:${k}"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const value = (b, k) => b.evaluate(`document.querySelector('.form-wizard [name="field:${k}"]').value`);
  const choose = (b, k, v) => b.evaluate(`(() => { const el = [...document.querySelectorAll('.form-wizard [name="field:${k}"]')].find((x) => x.value === ${JSON.stringify(v)}); el.click(); })()`);
  const next = (b) => b.evaluate("document.querySelector('[data-action=form-wizard-next]').click()");
  const stepTitle = (b) => b.evaluate("document.querySelector('.wizard-step:not([hidden]) h3').textContent.replace(/\\s+/g, ' ').trim()");
  const errorOf = (b, k) => b.evaluate(`(() => { const e = document.querySelector('.form-wizard [data-field="${k}"] .field-error'); return e.hidden ? "" : e.textContent; })()`);
  const shown = (b, k) => b.evaluate(`!document.querySelector('.form-wizard [data-field="${k}"]').hidden`);
  const addFiles = (b, k, files) => b.evaluate(`(() => { const dt = new DataTransfer(); ${files.map(([n, body, t]) => `dt.items.add(new File([${JSON.stringify(body)}], ${JSON.stringify(n)}, { type: ${JSON.stringify(t)} }));`).join("")} const el = document.querySelector('.form-wizard [data-files-input="${k}"]'); el.files = dt.files; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const noOverflow = (b) => b.evaluate("document.documentElement.scrollWidth <= window.innerWidth");
  const doneTitle = (b) => b.evaluate("document.querySelector('.wizard-done-title')?.textContent || ''");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const row = (serial) => `tr:has([aria-label="Name: ${serial}"])`; // the primary column of this board is "Name"
  const cell = (serial, k) => `${row(serial)} td[data-column-key="${k}"] .cell-display`;
  const upload = (who, recordId, column, name) => browsers[who].evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1/records/${recordId}/attachments?column=${encodeURIComponent(column)}", { method: "POST", headers: { "Content-Type": "application/pdf", "X-File-Name": ${JSON.stringify(name)}, "X-CSRF-Token": csrfToken }, body: new Blob([${JSON.stringify(PDF)}]) }); return r.status; })()`);
  const submit = (b, times = 1) => b.evaluate(`(() => { const f = document.querySelector('.form-wizard'); for (let i = 0; i < ${times}; i += 1) f.requestSubmit(); })()`);
  // Steps 1–3 with a valid agreement; returns at the Documents step.
  async function fillTerm(b, { name, kind }) {
    await type(b, "serial", name); await choose(b, key("Party Type"), kind); await next(b);
    await type(b, key("Due Rule"), "30D"); await next(b);
    await type(b, key("% Down"), "10"); await next(b);
    assert.match(await stepTitle(b), /Supporting documents/);
  }

  test("a real click or tap opens the Forms menu ON SCREEN under its button (desktop and phone); a load failure says why", async () => {
    const b = browsers.admin;
    for (const width of [1440, 390]) {
      await openBoard(b, width);
      const btn = await b.evaluate("(() => { const r = document.querySelector('[data-action=form-menu]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, bottom: r.bottom }; })()");
      if (width < 768) await b.tap(btn.x, btn.y, { settle: 800 });
      else { for (const type of ["mousePressed", "mouseReleased"]) await b.send("Input.dispatchMouseEvent", { type, x: btn.x, y: btn.y, button: "left", clickCount: 1 }); await sleep(800); }
      const m = await b.evaluate("(() => { const el = document.querySelector('.forms-menu'); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: innerWidth, vh: innerHeight }; })()");
      assert.ok(m, `menu exists at ${width}px`);
      assert.ok(m.top >= 0 && m.bottom <= m.vh && m.left >= 0 && m.right <= m.vw, `menu inside the window at ${width}px: ${JSON.stringify(m)}`);
      assert.ok(m.top >= btn.bottom - 1 || m.bottom <= m.vh, "placed under its button (or kept inside the window)");
      await b.evaluate("document.querySelector('#overlay-root').innerHTML = ''");
    }
    assert.equal(await b.evaluate("FormsPanel.loadFailure({ code: 'FORBIDDEN', requestId: 'req-12345678' })"), "Forms couldn't load: you don't have access to this board's forms. (reference req-12345678)");
    assert.equal(await b.evaluate("FormsPanel.loadFailure({ code: 'INTERNAL_ERROR' })"), "Forms couldn't load: the JARC server didn't answer. Try again in a moment.");
  });
  test("the Forms menu opens at once while the list loads, reuses it on the next open, makes one request for repeated clicks, and forgets it after a save", async () => {
    const b = browsers.admin; await openBoard(b);
    // Every forms-list request takes 800 ms and is counted (the page's own adapter, in this browser only).
    await b.evaluate(`(() => { window.__formLists = 0; const real = ResourceApiAdapter.prototype.request; ResourceApiAdapter.prototype.request = function (m, p, ...rest) { if (m === "GET" && String(p).endsWith("/forms")) { window.__formLists += 1; return new Promise((ok) => setTimeout(ok, 800)).then(() => real.call(this, m, p, ...rest)); } return real.call(this, m, p, ...rest); }; })()`);
    const at = async (cond, max = 5000) => b.evaluate(`new Promise((res) => { const t0 = performance.now(); const tick = () => { if (${cond}) return res(performance.now() - t0); if (performance.now() - t0 > ${max}) return res(null); requestAnimationFrame(tick); }; tick(); })`);
    await b.evaluate("document.querySelector('[data-action=form-menu]').click(); document.querySelector('[data-action=form-menu]').click(); document.querySelector('[data-action=form-menu]').click();");
    const shown = await at("!!document.querySelector('.forms-menu .forms-menu-loading')", 300);
    assert.ok(shown !== null, "the menu is on screen with a loading line before the list arrives");
    assert.ok(await at(`[...document.querySelectorAll('.forms-menu [data-action=form-fill]')].some((x) => x.textContent.includes(${JSON.stringify(NATIVE.name)}))`, 5000) !== null, "the list replaces it");
    assert.equal(await b.evaluate("window.__formLists"), 1, "three quick clicks: one request");
    assert.equal(await b.evaluate("!!document.querySelector('.forms-menu .forms-menu-loading')"), false);
    await b.evaluate("document.querySelector('#overlay-root').innerHTML = ''");
    // Next open: the list from this page at once (no loading line), refreshed in the background.
    await b.evaluate("document.querySelector('[data-action=form-menu]').click()");
    assert.ok(await at("document.querySelectorAll('.forms-menu [data-action=form-fill]').length >= 1", 200) !== null, "the earlier list is shown at once");
    assert.equal(await b.evaluate("!!document.querySelector('.forms-menu .forms-menu-loading')"), false);
    await sleep(1000); assert.equal(await b.evaluate("window.__formLists"), 2, "refreshed once in the background");
    // A save forgets the cached list: the next open loads again.
    await b.evaluate("document.querySelector('#overlay-root').innerHTML = ''");
    await b.evaluate("document.querySelector('[data-action=form-menu]').click()"); await at("!!document.querySelector('.forms-menu [data-action=form-edit]')", 3000);
    await b.evaluate("document.querySelector('.forms-menu [data-action=form-edit]').click()"); assert.ok(await at("!!document.querySelector('.form-designer')", 3000) !== null);
    await b.evaluate("document.querySelector('.form-designer').requestSubmit()");
    assert.ok(await at("!document.querySelector('.form-designer')", 5000) !== null, "saved");
    await b.evaluate("document.querySelector('[data-action=form-menu]').click()");
    assert.ok(await at("!!document.querySelector('.forms-menu .forms-menu-loading')", 300) !== null, "after a save the list is loaded again, not taken from memory");
    await at("document.querySelectorAll('.forms-menu [data-action=form-fill]').length >= 1", 5000);
    await b.evaluate("document.querySelector('#overlay-root').innerHTML = ''");
  });
  test("a form window hides the page behind it from screen readers without making it inert, keeps focus inside, and restores it on close", async () => {
    const b = browsers.mia; await openBoard(b);
    await openForm(b, NATIVE.name);
    assert.deepEqual(await b.evaluate("(() => { const s = document.querySelector('.app-shell'); return [s.getAttribute('aria-hidden'), s.hasAttribute('inert')]; })()"), ["true", false]);
    assert.equal(await b.evaluate("document.querySelector('.form-fill').closest('[aria-modal=true], .overlay') !== null"), true);
    // Focus outside the window (e.g. after clicking the backdrop): Tab brings it back inside.
    await b.evaluate("document.activeElement?.blur(); document.body.focus();");
    await b.key("Tab");
    assert.equal(await b.evaluate("document.querySelector('#overlay-root').contains(document.activeElement)"), true, "Tab goes back into the window");
    // A script (or a re-render) focusing a control behind the window: focus is sent back into the window.
    assert.equal(await b.evaluate("(() => { document.querySelector('.app-shell [data-action=form-menu]').focus(); return document.querySelector('#overlay-root').contains(document.activeElement); })()"), true, "focus can't stay on the hidden page");
    await b.evaluate("document.querySelector('.form-fill [data-action=close-overlay]').click()");
    await sleep(200);
    assert.deepEqual(await b.evaluate("(() => { const s = document.querySelector('.app-shell'); return [s.hasAttribute('aria-hidden'), s.hasAttribute('inert')]; })()"), [false, false]);
  });
  test("the draft guided form is invisible to members; the simple form is listed", async () => {
    const b = browsers.mia; await openBoard(b);
    assert.deepEqual(await menuNames(b), [NATIVE.name]);
    assert.equal((await api("GET", `/forms/${guidedForm.id}`, undefined, "mia")).status, 404);
    const refused = await api("POST", `/forms/${guidedForm.id}/submit`, { submissionKey: crypto.randomUUID(), values: { serial: "x" } }, "mia");
    assert.equal(refused.status, 409); assert.equal(refused.body.error.code, "FORM_NOT_PUBLISHED");
  });
  test("an admin publishes it in the designer, which keeps every guided setting unchanged", async () => {
    const before = (await api("GET", `/forms/${guidedForm.id}`)).body.form;
    const b = browsers.admin; await openBoard(b);
    await b.evaluate("document.querySelector('[data-action=form-menu]').click()");
    assert.ok(await b.waitFor("!!document.querySelector('.forms-menu') && !document.querySelector('.forms-menu .forms-menu-loading')", 5000));
    await b.evaluate(`document.querySelector('.forms-menu [data-action=form-edit][data-id="${guidedForm.id}"]').click()`);
    assert.ok(await b.waitFor("!!document.querySelector('.form-designer')", 5000));
    assert.ok(await b.evaluate("document.querySelectorAll('.form-designer [name=section]').length") > 0, "steps shown in the designer");
    await b.evaluate("(() => { const s = document.querySelector('.form-designer [name=status]'); s.value = 'published'; })()");
    await b.evaluate("document.querySelector('.form-designer').requestSubmit()");
    assert.ok(await b.waitFor("!document.querySelector('.form-designer')", 5000), "saved");
    const after = (await api("GET", `/forms/${guidedForm.id}`)).body.form;
    assert.equal(after.status, "published"); assert.equal(after.version, before.version + 1);
    for (const k of ["fields", "sections", "calculations", "layout", "review", "groupId", "schemaVersion"]) assert.deepEqual(after[k], before[k], k);
    guidedForm = after;
  });

  test("buyer workflow on desktop: guided steps, validation, choices, exact numbers, suggestion, documents, review, one record", async () => {
    const b = browsers.mia; await openBoard(b);
    assert.deepEqual(await menuNames(b), [GUIDED.name, NATIVE.name].sort(), "both forms, by name");
    await openBoard(b); await openForm(b, GUIDED.name, ".form-wizard");
    assert.deepEqual(await b.evaluate("[...document.querySelectorAll('.wizard-progress-title')].map((x) => x.textContent)"), ["Classification", "Payment terms", "Financial details", "Supporting documents", "Review & submit"]);
    assert.equal(await b.evaluate("document.querySelector('.wizard-progress li.is-current button').getAttribute('aria-current')"), "step");
    // Required answers, on screen and in the same words as the server.
    await next(b);
    assert.match(await stepTitle(b), /Classification/, "can't go on yet");
    assert.match(await errorOf(b, key("Party Type")), /"Party Type" is required/);
    assert.match(await errorOf(b, "serial"), /"Agreement name" is required/);
    assert.equal(await b.evaluate(`document.querySelector('.form-wizard [data-field="${key("Party Type")}"] [role=radiogroup]').getAttribute('aria-invalid')`), "true");
    // Status choices in the board's colours; the searchable multi-select with chips.
    assert.deepEqual(await b.evaluate(`[...document.querySelectorAll('.form-wizard [data-field="${key("Party Type")}"] .status-swatch')].map((x) => getComputedStyle(x).backgroundColor)`), ["rgb(87, 155, 252)", "rgb(116, 175, 204)"]);
    await type(b, "serial", "Buyer agreement"); await choose(b, key("Party Type"), F.BUYER);
    assert.equal(await errorOf(b, "serial"), "", "a fixed answer's error disappears at once");
    assert.equal(await errorOf(b, key("Party Type")), "");
    assert.equal(await b.evaluate(`document.querySelector('.form-wizard [data-field="${key("Party Type")}"] [role=radiogroup]').getAttribute('aria-invalid')`), null);
    await type(b, key("Party Name"), "Fictional Party");
    await b.evaluate(`(() => { const s = document.querySelector('[data-picker-search="${key("Code")}"]'); s.value = "T-3"; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    assert.deepEqual(await b.evaluate(`[...document.querySelectorAll('[data-picker="${key("Code")}"] .choice-picker-option')].filter((o) => !o.hidden).map((o) => o.textContent.trim())`), ["T-30"]);
    await choose(b, key("Code"), "T-30"); await choose(b, key("Code"), "T-01");
    assert.deepEqual(await b.evaluate(`[...document.querySelectorAll('[data-picker="${key("Code")}"] .choice-picker-chip span')].map((x) => x.textContent)`), ["T-01", "T-30"]);
    await b.evaluate(`document.querySelector('[data-picker="${key("Code")}"] [data-action=form-chip-remove][data-value="T-01"]').click()`);
    assert.deepEqual(await b.evaluate(`[...document.querySelectorAll('[data-picker="${key("Code")}"] .choice-picker-chip span')].map((x) => x.textContent)`), ["T-30"]);
    await choose(b, key("Mode of Payment"), "Transfer"); await choose(b, key("Mode of Payment"), "Card");
    await next(b);
    assert.match(await stepTitle(b), /Step 2 of 5 Payment terms/);
    assert.equal(await b.evaluate("document.activeElement?.id"), "wizard-step-1", "focus moves to the new step");
    await type(b, key("Due Rule"), "45D"); await choose(b, key("Payment Frequency"), "15 days"); await type(b, key("Frequency"), "12"); await type(b, key("Months Ahead"), "1.5");
    await next(b);
    assert.match(await errorOf(b, key("Months Ahead")), /at most 0 decimal places/);
    await type(b, key("Months Ahead"), "2");
    assert.equal(await errorOf(b, key("Months Ahead")), "", "cleared as soon as it is valid");
    await next(b);
    // Exact decimals, bounds, and a suggestion that is never filled in by itself.
    assert.match(await stepTitle(b), /Financial details/);
    await type(b, key("% Down"), "4.17");
    assert.match(await b.evaluate(`document.querySelector('[data-field="${key("% Balance")}"] .calc-preview').textContent`), /Suggestion: 95\.83/);
    assert.equal(await value(b, key("% Balance")), "", "not filled in by itself");
    await b.evaluate(`document.querySelector('[data-field="${key("% Balance")}"] [data-action=form-calc-use]').click()`);
    assert.equal(await value(b, key("% Balance")), "95.83");
    await type(b, key("% Monthly"), "101"); await next(b);
    assert.match(await errorOf(b, key("% Monthly")), /at most 100/);
    await type(b, key("% Monthly"), "7.99"); await type(b, key("Principal"), "1234.50"); await next(b);
    // Documents for a buyer agreement; a wrong file type is refused on the spot.
    assert.equal(await shown(b, key("Credit Form")), true);
    assert.equal(await shown(b, key("Accreditation")), false);
    await addFiles(b, key("Credit Form"), [["credit.pdf", PDF, "application/pdf"], ["tool.exe", "MZ", "application/octet-stream"]]);
    assert.match(await errorOf(b, key("Credit Form")), /tool\.exe: only PDF, JPEG, PNG or WebP/);
    assert.deepEqual(await b.evaluate(`[...document.querySelectorAll('[data-file-list="${key("Credit Form")}"] .wizard-file-name')].map((x) => x.textContent)`), ["credit.pdf"]);
    await next(b);
    // Review, then a double submit.
    assert.match(await stepTitle(b), /Review & submit/);
    const review = await b.evaluate("Object.fromEntries([...document.querySelectorAll('.wizard-review-row')].map((r) => [r.querySelector('dt').textContent, r.querySelector('dd').textContent]))");
    assert.equal(review["% Down"], "4.17 %"); assert.equal(review.Code, "T-30"); assert.equal(review["Mode of Payment"], "Transfer, Card"); assert.equal(review["Credit Form"], "credit.pdf"); assert.equal(review.Accreditation, undefined, "hidden question not reviewed");
    await submit(b, 2);
    assert.ok(await b.waitFor("!!document.querySelector('.wizard-done')", 10000), "submitted");
    assert.ok(await b.waitFor("document.querySelector('.wizard-uploads .wizard-upload-state')?.textContent === 'Uploaded'", 10000), "upload finished");
    assert.match(await b.evaluate("document.querySelector('.wizard-done').textContent"), /The new agreement was added to Pending/);
    assert.ok(await b.waitFor("document.querySelector('.wizard-done-title')?.textContent === 'Submitted'", 8000), "Submitted only once the server confirmed the document");
    const found = await records("Buyer agreement");
    assert.equal(found.length, 1, "one record from a double click");
    const r = found[0];
    assert.equal(r.groupId, F.PENDING, "Pending");
    assert.equal(r.values[key("% Down")], "4.17"); assert.equal(r.values[key("% Balance")], "95.83"); assert.equal(r.values[key("Principal")], "1234.50");
    assert.deepEqual(r.values[key("Code")], ["T-30"]); assert.deepEqual(r.values[key("Mode of Payment")], ["Transfer", "Card"]);
    assert.ok([undefined, ""].includes(r.values[key("Item ID")]), "Item ID left empty"); assert.ok([undefined, ""].includes(r.values[key("Record Status")]), "no status set");
    assert.ok([undefined, ""].includes(r.values[key("Down Amount")]), "unanswered amount is not 0");
    assert.deepEqual((await attachments(r.id)).map((a) => [a.name, a.columnKey]), [["credit.pdf", key("Credit Form")]]);
    assert.match(await b.evaluate("document.querySelector('.wizard-done-record code').textContent"), new RegExp(r.id));
    const act = await api("GET", "/activity?limit=50");
    assert.ok(act.body.items.some((a) => a.action === "form.submitted" && a.summary === `Submitted form ${GUIDED.name} (1 document to attach)`));
    assert.ok(act.body.items.some((a) => a.action === "form.documents.complete" && a.summary === `Documents for form ${GUIDED.name}: all 1 attached`));
    // The success screen opens the new record.
    await b.evaluate("document.querySelector('[data-action=form-open-record]').click()");
    assert.ok(await b.waitFor("!!document.querySelector('[data-action=record-form]')", 10000), "record opened");
  });

  test("seller workflow on a phone: no sideways scrolling, and the answers and files of hidden questions are never sent", async () => {
    const b = browsers.sam; await openBoard(b, 390); await openForm(b, GUIDED.name, ".form-wizard");
    assert.equal(await noOverflow(b), true);
    await fillTerm(b, { name: "Seller agreement", kind: F.BUYER });
    await addFiles(b, key("Credit Form"), [["buyer-only.pdf", PDF, "application/pdf"]]);
    assert.equal(await noOverflow(b), true);
    // Back to step 1: now a seller agreement.
    await b.evaluate("document.querySelector('[data-action=form-wizard-goto][data-index=\"0\"]').click()");
    await choose(b, key("Party Type"), F.SELLER);
    for (let i = 0; i < 3; i += 1) await next(b);
    assert.equal(await shown(b, key("Accreditation")), true); assert.equal(await shown(b, key("Credit Form")), false);
    await addFiles(b, key("Accreditation"), [["accreditation.pdf", PDF, "application/pdf"]]);
    await next(b); assert.equal(await noOverflow(b), true);
    await submit(b);
    assert.ok(await b.waitFor("document.querySelector('.wizard-uploads .wizard-upload-state')?.textContent === 'Uploaded'", 10000));
    const [r] = await records("Seller agreement");
    assert.deepEqual((await attachments(r.id)).map((a) => [a.name, a.columnKey]), [["accreditation.pdf", key("Accreditation")]], "the hidden question's file was not uploaded");
    assert.equal(r.values[key("Party Type")], F.SELLER);
  });

  test("a failed upload is reported and retried without a second record or file", async () => {
    const b = browsers.mia; await openBoard(b); await openForm(b, GUIDED.name, ".form-wizard");
    await fillTerm(b, { name: "Retry agreement", kind: F.BUYER });
    await addFiles(b, key("Deviation Form"), [["deviation.pdf", PDF, "application/pdf"]]);
    await b.evaluate("(() => { const orig = ResourceApiAdapter.prototype.uploadAttachment; window.__failOnce = true; ResourceApiAdapter.prototype.uploadAttachment = function (...a) { if (window.__failOnce) { window.__failOnce = false; return Promise.reject({ status: 0, code: 'OFFLINE', message: 'The connection was lost during the upload. Try again.' }); } return orig.apply(this, a); }; })()");
    await next(b); await submit(b);
    // Present AND visible: the button only exists once the success screen is shown.
    assert.ok(await b.waitFor("(() => { const r = document.querySelector('.wizard-done [data-action=form-upload-retry]'); return Boolean(r) && !r.hidden; })()", 15000), "retry offered");
    assert.match(await b.evaluate("document.querySelector('.wizard-upload-error').textContent"), /The record is saved, but its documents are incomplete\. Missing: Deviation Form\. 1 file wasn't uploaded/);
    assert.equal(await doneTitle(b), "Saved — documents incomplete", "never reported as fully submitted");
    await b.evaluate("document.querySelector('[data-action=form-upload-retry]').click()");
    assert.ok(await b.waitFor("document.querySelector('.wizard-uploads .wizard-upload-state')?.textContent === 'Uploaded'", 10000));
    assert.ok(await b.waitFor("document.querySelector('.wizard-done-title')?.textContent === 'Submitted'", 8000), "complete after the retry");
    assert.equal(await b.evaluate("document.querySelector('[data-action=form-upload-retry]').hidden"), true);
    const acts = (await api("GET", "/activity?limit=100")).body.items.filter((a) => a.action.startsWith("form.documents."));
    assert.ok(acts.some((a) => a.action === "form.documents.incomplete" && /0 of 1 attached; missing Deviation Form/.test(a.summary)));
    assert.ok(acts.some((a) => a.action === "form.documents.complete" && /all 1 attached/.test(a.summary)));
    const found = await records("Retry agreement");
    assert.equal(found.length, 1);
    assert.equal((await attachments(found[0].id)).length, 1);
  });

  test("the server never takes the browser's file counts as proof: it checks what is really attached", async () => {
    const values = { serial: "Proof agreement", [key("Party Type")]: F.BUYER }, k = crypto.randomUUID();
    const s = await api("POST", `/forms/${guidedForm.id}/submit`, { submissionKey: k, values, files: { [key("Credit Form")]: 2 } }, "mia");
    assert.equal(s.status, 201); assert.deepEqual(s.body.submission, { key: k, status: "awaiting-files" });
    const complete = (who = "mia") => api("POST", `/forms/${guidedForm.id}/submissions/${k}/complete`, undefined, who);
    let c = await complete();
    assert.equal(c.body.status, "incomplete", "announced, not uploaded");
    assert.deepEqual(c.body.files.find((x) => x.key === key("Credit Form")), { key: key("Credit Form"), label: "Credit Form", expected: 2, uploaded: 0 });
    assert.deepEqual(c.body.missing, ["Credit Form"]);
    assert.equal((await complete("sam")).status, 404, "someone else's submission isn't theirs to check");
    assert.equal((await complete("vic")).status, 403);
    // A file uploaded to ANOTHER question or by someone else doesn't count.
    assert.equal(await upload("mia", s.body.record.id, key("Deviation Form"), "other.pdf"), 201);
    assert.equal(await upload("admin", s.body.record.id, key("Credit Form"), "admins.pdf"), 201);
    assert.equal((await complete()).body.status, "incomplete");
    assert.equal(await upload("mia", s.body.record.id, key("Credit Form"), "one.pdf"), 201);
    assert.equal((await complete()).body.status, "incomplete", "1 of 2");
    assert.equal(await upload("mia", s.body.record.id, key("Credit Form"), "two.pdf"), 201);
    c = await complete();
    assert.equal(c.body.status, "done"); assert.deepEqual(c.body.missing, []);
    // Repeating the check changes nothing and logs nothing new; the same attempt still returns the one record.
    const before = (await api("GET", "/activity?limit=100")).body.items.filter((a) => a.action.startsWith("form.documents.")).length;
    assert.equal((await complete()).body.status, "done");
    assert.equal((await api("GET", "/activity?limit=100")).body.items.filter((a) => a.action.startsWith("form.documents.")).length, before);
    const again = await api("POST", `/forms/${guidedForm.id}/submit`, { submissionKey: k, values, files: { [key("Credit Form")]: 2 } }, "mia");
    assert.equal(again.status, 200); assert.equal(again.body.repeated, true); assert.equal(again.body.submission.status, "done");
    assert.equal((await records("Proof agreement")).length, 1);
    assert.equal((await api("POST", `/forms/${guidedForm.id}/submissions/not-a-key/complete`, undefined, "mia")).status, 400);
  });

  test("submitting keeps the person's undo history: an earlier change can still be undone, and the new record stays", async () => {
    const b = browsers.mia; await openBoard(b);
    // An undoable change on the board first: clear one record's "Due Rule".
    assert.ok(await b.waitFor(`!!document.querySelector(${JSON.stringify(cell("Buyer agreement", key("Due Rule")))})`, 8000));
    await b.evaluate(`document.querySelector(${JSON.stringify(cell("Buyer agreement", key("Due Rule")))}).focus()`);
    await b.key("Delete");
    assert.ok(await b.waitFor("['live','saved'].includes(document.querySelector('.save-state')?.dataset.state)", 8000)); await sleep(300);
    assert.equal((await records("Buyer agreement"))[0].values[key("Due Rule")], "");
    // Submit the guided form (no documents).
    await openForm(b, GUIDED.name, ".form-wizard");
    await fillTerm(b, { name: "Undo-safe agreement", kind: F.BUYER }); await next(b); await submit(b);
    assert.ok(await b.waitFor("document.querySelector('.wizard-done-title')?.textContent === 'Submitted'", 8000));
    await b.evaluate("document.querySelector('[data-action=form-open-record]').click()");
    assert.ok(await b.waitFor("!!document.querySelector('[data-action=record-form]')", 8000), "the new record opens");
    await b.evaluate("document.querySelector('#overlay-root [data-action=close-overlay]')?.click()");
    await sleep(2500); // let the live update of this submission arrive
    assert.ok(await b.waitFor(`!!document.querySelector(${JSON.stringify(row("Undo-safe agreement"))})`, 8000), "the new record is on the board");
    await b.evaluate("document.activeElement?.blur()");
    await b.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
    assert.ok(await b.waitFor("['live','saved'].includes(document.querySelector('.save-state')?.dataset.state)", 8000)); await sleep(800);
    assert.equal((await records("Buyer agreement"))[0].values[key("Due Rule")], "45D", "the earlier change was undone");
    assert.equal((await records("Undo-safe agreement")).length, 1, "undo didn't remove the new record");
    assert.ok(await b.evaluate(`!!document.querySelector(${JSON.stringify(row("Undo-safe agreement"))})`), "still on the board");
  });

  test("a viewer is refused by the server, with a clear message, and nothing is saved", async () => {
    const b = browsers.vic; await openBoard(b); await openForm(b, GUIDED.name, ".form-wizard");
    await fillTerm(b, { name: "Viewer agreement", kind: F.SELLER }); await next(b); await submit(b);
    assert.ok(await b.waitFor("!document.querySelector('.wizard-error').hidden", 8000));
    assert.match(await b.evaluate("document.querySelector('.wizard-error').textContent"), /needs Member access/);
    assert.equal((await records("Viewer agreement")).length, 0);
  });

  test("accessible: every control is named, choices are grouped, errors are described, Enter goes on", async () => {
    const b = browsers.mia; await openBoard(b); await openForm(b, GUIDED.name, ".form-wizard");
    const unnamed = await b.evaluate(`[...document.querySelectorAll('.form-wizard input:not([type=hidden]), .form-wizard select')].filter((el) => {
      const named = el.getAttribute('aria-label') || (el.id && document.querySelector('label[for="' + el.id + '"]')) || el.closest('label') || el.getAttribute('aria-labelledby');
      return !named; }).map((el) => el.name || el.className)`);
    assert.deepEqual(unnamed, []);
    assert.ok(await b.evaluate("[...document.querySelectorAll('.form-wizard [role=radiogroup]')].every((g) => document.getElementById(g.getAttribute('aria-labelledby')))"));
    assert.ok(await b.evaluate(`document.querySelector('.form-wizard [name="field:serial"]').getAttribute('aria-describedby').split(' ').every((id) => document.getElementById(id))`));
    await type(b, "serial", "Keyboard agreement"); await choose(b, key("Party Type"), F.BUYER);
    await b.evaluate(`document.querySelector('.form-wizard [name="field:serial"]').focus()`);
    await b.key("Enter");
    assert.ok(await b.waitFor("document.querySelector('.wizard-step:not([hidden]) h3').textContent.includes('Payment terms')", 3000), "Enter moves to the next step");
    // Cancel discards the unsent answers: reopening starts empty.
    await b.evaluate("document.querySelector('[data-action=form-wizard-cancel]').click()");
    await openForm(b, GUIDED.name, ".form-wizard");
    assert.equal(await b.evaluate("!!document.querySelector('.wizard-restored')"), false);
    assert.equal(await value(b, "serial"), "");
    await b.evaluate("document.querySelector('[data-action=form-wizard-cancel]').click()");
  });

  test("the simple (one-page) form still works beside it", async () => {
    const b = browsers.mia; await openBoard(b); await openForm(b, NATIVE.name);
    await b.evaluate(`(() => { const set = (n, v) => { const el = document.querySelector('#overlay-root [name="' + n + '"]'); el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }; set("field:serial", "Simple agreement"); set("field:${key("Party Type")}", "${F.SELLER}"); })()`);
    await b.evaluate("document.querySelector('.form-fill').requestSubmit()");
    assert.ok(await b.waitFor("!!document.querySelector('.form-done')", 5000));
    const [r] = await records("Simple agreement");
    assert.equal(r.groupId, NATIVE.groupId); assert.equal(r.values[key("Party Type")], F.SELLER);
  });

  test("an ended session loses nothing: after signing in again the answers come back, and one record is made", async () => {
    const b = browsers.sam; await openBoard(b); await openForm(b, GUIDED.name, ".form-wizard");
    await fillTerm(b, { name: "Expired agreement", kind: F.SELLER }); await type(b, key("% Down"), "12.5"); await next(b);
    await b.evaluate("fetch('/__test/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expireSessions: true }) })");
    await submit(b);
    assert.ok(await b.waitFor("!!document.querySelector('.entra-login')", 8000), "the sign-in screen replaced the page");
    await signIn(browsers.admin, "admin", true);
    assert.equal((await records("Expired agreement")).length, 0, "nothing saved");
    await signIn(b, "sam", false);
    await openBoard(b); await openForm(b, GUIDED.name, ".form-wizard");
    assert.ok(await b.evaluate("!!document.querySelector('.wizard-restored')"), "restored, with a notice");
    assert.equal(await value(b, "serial"), "Expired agreement");
    assert.equal(await b.evaluate(`[...document.querySelectorAll('.form-wizard [name="field:${key("Party Type")}"]')].find((x) => x.checked)?.value`), F.SELLER);
    assert.equal(await value(b, key("% Down")), "12.5");
    for (let i = 0; i < 4; i += 1) await next(b);
    assert.match(await stepTitle(b), /Review & submit/);
    await submit(b);
    assert.ok(await b.waitFor("!!document.querySelector('.wizard-done')", 10000));
    const found = await records("Expired agreement");
    assert.equal(found.length, 1); assert.equal(found[0].values[key("% Down")], "12.5");
    await openForm(b, GUIDED.name, ".form-wizard");
    assert.equal(await b.evaluate("!!document.querySelector('.wizard-restored')"), false, "the draft is gone after submitting");
  });
});
