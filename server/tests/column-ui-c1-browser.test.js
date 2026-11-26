// Column System C1 in the REAL app, in a headless browser (Chrome/Edge), against the Entra test server (shared access, fake
// MongoDB, synthetic data): the Add Column picker (search, synonyms, keyboard, one-click create, inline rename, Recent,
// "Add column to the right", Connect / Mirror only with the switch on), the header menu (scope groups, Change type limited
// to the registry's targets, S0-A refusal unchanged), the settings panel, dark mode, the phone bottom sheet and placement
// near the viewport's edges. Every change is checked on the server. Skipped without Chrome or Edge.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const OID = "0a0a0a0a-0000-4000-8000-0000000000c1";
const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "ref", label: "Reference", type: "text" },
  { key: "status", label: "Status", type: "status", options: ["To do", "Working", "Done"] },
  { key: "qty", label: "Qty", type: "number" },
  { key: "due", label: "Due", type: "date" },
  { key: "notes", label: "Notes", type: "text" }
];
// The page's /features answer, with Connect boards switched off while localStorage.__c1Relations is "off" (production today).
const FEATURES_WRAPPER = `(() => {
  const original = window.fetch.bind(window);
  window.fetch = async (url, init) => {
    const res = await original(url, init);
    if (/\\/api\\/v1\\/features(\\?|$)/.test(String(url)) && localStorage.getItem("__c1Relations") === "off" && res.ok) {
      const body = await res.clone().json(); body.features = { ...(body.features || {}), connectBoards: false };
      return new Response(JSON.stringify(body), { status: res.status, headers: { "Content-Type": "application/json" } });
    }
    return res;
  };
})();`;

describe("Column C1: Add Column picker, header menu, settings (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, b, board;
  const signIn = () => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OID}&name=Ana%20Reyes&email=ana.c1@example.invalid&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const api = (method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const columns = async () => (await api("GET", `/boards/${board.id}`)).body.board.columns;
  const click = (sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "nearest", inline: "nearest" }); el.click(); return true; })()`);
  const text = (sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? null`);
  const saved = () => b.waitFor("!document.querySelector('.save-state')?.textContent.includes('Saving')", 6000).then(() => sleep(300));
  const inViewport = (sel) => b.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return !!r && r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5; })()`);
  const openBoard = async ({ width = 1440, height = 900, theme = "light", relations = "on" } = {}) => {
    await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
    await b.open(`${base}/api/v1/health`, { width, height });
    await b.evaluate(`localStorage.setItem("__c1Relations", ${JSON.stringify(relations)})`);
    await b.open(`${base}/`, { width, height });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item') || !!document.querySelector('.entra-login')", 15000), "app shown");
    assert.equal(await b.evaluate("!!document.querySelector('.entra-login')"), false, "signed in");
    await b.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await b.evaluate("[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes('Inventory'))?.click()");
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table tbody tr td.cell')", 15000), "board table loaded");
    await sleep(300);
  };
  const openPicker = async () => {
    assert.ok(await click(".editable-table thead .add-column-button"), "+ button");
    assert.ok(await b.waitFor("!!document.querySelector('#overlay-root .column-picker .column-picker-option')", 5000), "picker open");
    await sleep(120);
  };
  const typeSearch = async (q) => { await b.evaluate(`(() => { const i = document.querySelector('.column-picker [data-action=column-type-search]'); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(80); };
  const options = () => b.evaluate("[...document.querySelectorAll('.column-picker .column-picker-option')].map((o) => o.dataset.type)");
  const openMenu = async (key) => {
    assert.ok(await click(`.editable-table thead th[data-column-key="${key}"] .column-menu-button`), "menu button");
    assert.ok(await b.waitFor("!!document.querySelector('#overlay-root .column-menu-popover')", 4000), "menu open");
  };

  before(async () => {
    let port; do { port = await freePort(); } while ([4527, 9361, 9362, 9339].includes(port));
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    await waitForServer(base, { child: server });
    b = await launch(BROWSER);
    await b.open(`${base}/api/v1/health`, { width: 1440 }); await signIn();
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: FEATURES_WRAPPER });
    const ws = (await api("POST", "/workspaces", { name: "Warehouse" })).body.workspace;
    board = (await api("POST", `/workspaces/${ws.id}/boards`, { name: "Inventory", columns: COLUMNS })).body.board;
    // Reference holds mixed values: as a Number column some would be lost (a leading zero, words), so S0-A refuses it.
    const refs = ["0042", "12", "1,250.50", "N/A", "7", "abc-9"];
    for (let i = 0; i < 12; i += 1) {
      const r = await api("POST", `/boards/${board.id}/records`, { values: { serial: `Part ${i + 1}`, ref: refs[i % refs.length], status: ["To do", "Working", "Done"][i % 3], qty: i * 3, notes: `Synthetic note ${i + 1}` } });
      assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 200));
    }
  });
  after(async () => { await b?.close(); server?.kill(); });

  test("picker: opens under +, inside the screen, Essentials first; Connect boards only while the switch is on", async () => {
    await openBoard({ relations: "off" });
    await openPicker();
    assert.equal(await inViewport("#overlay-root .column-picker"), true);
    const headings = await b.evaluate("[...document.querySelectorAll('.column-picker .column-picker-heading')].map((h) => h.textContent)");
    assert.deepEqual(headings.slice(0, 2), ["Essentials", "More"]);
    const types = await options();
    assert.deepEqual(types.slice(0, 5), ["status", "owner", "date", "number", "text"], "the essentials, in the design's order");
    assert.ok(!types.includes("connect") && !types.includes("mirror"), "Connect / Mirror hidden while relationsAvailable is false");
    assert.equal(await b.evaluate("document.activeElement?.dataset.action"), "column-type-search", "the search field has focus");
    await b.key("Escape");
    assert.equal(await b.evaluate("!!document.querySelector('.column-picker')"), false, "Escape closes it");
    await openBoard({ relations: "on" });
    await openPicker();
    const withRelations = await options();
    assert.ok(withRelations.includes("connect"), "Connect boards listed when the switch is on");
    assert.ok(!withRelations.includes("mirror"), "Mirror needs a Connect column first");
    await b.key("Escape");
  });

  test("picker: local synonym search, Best match, a friendly empty answer; keyboard arrows, type-to-search", async () => {
    await openBoard({ relations: "off" });
    await openPicker();
    for (const [q, type] of [["deadline", "date"], ["qty", "number"], ["assignee", "owner"], ["url", "link"], ["tick", "checkbox"], ["stage", "status"]]) {
      await typeSearch(q);
      assert.equal((await options())[0], type, `"${q}" → ${type}`);
    }
    assert.match(await text(".column-picker .column-picker-option .column-picker-best"), /Best match/);
    await typeSearch("zzzz-nothing");
    assert.match(await text(".column-picker-empty"), /No column type matches/);
    await typeSearch("");
    // Arrows move the highlight (aria-activedescendant) while focus stays in the field.
    const active = () => b.evaluate("document.querySelector('.column-picker .column-picker-option.is-active')?.dataset.type");
    assert.equal(await active(), "status");
    await b.key("ArrowDown"); assert.equal(await active(), "owner");
    await b.key("ArrowDown"); assert.equal(await active(), "date");
    await b.key("ArrowUp"); assert.equal(await active(), "owner");
    assert.equal(await b.evaluate("document.querySelector('.column-picker [data-action=column-type-search]').getAttribute('aria-activedescendant') === document.querySelector('.column-picker-option.is-active').id"), true);
    // Tab to an option, then type: the letters go to the search field.
    await b.evaluate("document.querySelector('.column-picker .column-picker-option').focus()");
    await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "e", code: "KeyE", text: "e" }); await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "e", code: "KeyE" });
    await b.send("Input.dispatchKeyEvent", { type: "char", key: "m", text: "m" }); await sleep(120);
    assert.equal(await b.evaluate("document.activeElement?.dataset.action"), "column-type-search", "type-to-search moved focus to the field");
    await b.key("Escape");
  });

  test("one click creates the column on the server, then its name is typed over in the header; Recent remembers it", async () => {
    await openBoard({ relations: "off" });
    const before = (await columns()).length;
    await openPicker();
    await typeSearch("amount");
    await b.key("Enter"); // the highlighted Best match: Number
    assert.ok(await b.waitFor("document.activeElement?.classList.contains('column-rename-input')", 8000), "inline rename focused");
    await saved();
    let cols = await columns();
    assert.equal(cols.length, before + 1);
    const created = cols.at(-1);
    assert.deepEqual([created.type, created.label], ["number", "Number"], "created with the default name");
    assert.equal(await b.evaluate("document.activeElement.value"), "Number");
    assert.equal(await b.evaluate("document.activeElement.selectionEnd - document.activeElement.selectionStart"), "Number".length, "the name is selected");
    await b.evaluate("document.activeElement.value = 'Unit cost'"); await b.key("Enter"); await saved();
    cols = await columns();
    assert.equal(cols.find((c) => c.key === created.key).label, "Unit cost");
    assert.equal(await text(`.editable-table thead th[data-column-key="${created.key}"] .column-label`), "Unit cost");
    // Escape keeps the name it was created with (the column already exists).
    await openPicker();
    await click('.column-picker-option[data-type="checkbox"]');
    assert.ok(await b.waitFor("document.activeElement?.classList.contains('column-rename-input')", 8000));
    await b.evaluate("document.activeElement.value = 'Not kept'"); await b.key("Escape"); await saved();
    assert.ok((await columns()).some((c) => c.type === "checkbox" && c.label === "Checkbox"));
    await openPicker();
    assert.deepEqual(await b.evaluate("[...document.querySelectorAll('.column-picker .is-recent .column-picker-option')].map((o) => o.dataset.type)"), ["checkbox", "number"], "Recent: newest first");
    await b.key("Escape");
  });

  test("Add column to the right: placed right after that column, on the server", async () => {
    await openBoard({ relations: "off" });
    await openMenu("status");
    await click('.column-menu-popover [data-action="add-column-right"]');
    assert.ok(await b.waitFor("!!document.querySelector('.column-picker[data-insert-after=\"status\"]')", 4000), "the picker, for the right of Status");
    assert.match(await text(".column-picker-title small"), /After Status/);
    assert.equal(await inViewport("#overlay-root .column-picker"), true);
    await click('.column-picker-option[data-type="date"]');
    assert.ok(await b.waitFor("document.activeElement?.classList.contains('column-rename-input')", 8000));
    await b.evaluate("document.activeElement.value = 'Shipped'"); await b.key("Enter"); await saved();
    const keys = (await columns()).map((c) => c.label);
    assert.equal(keys[keys.indexOf("Status") + 1], "Shipped", "right after Status");
    const shown = await b.evaluate("[...document.querySelectorAll('.editable-table thead th[data-column-key] .column-label')].map((s) => s.textContent)");
    assert.equal(shown[shown.indexOf("Status") + 1], "Shipped");
  });

  test("header menu: board items under 'Everyone on this board', sort / filter / group under 'Only you'; Change type lists only the registry's targets", async () => {
    await openBoard({ relations: "off" });
    await openMenu("status");
    const scopes = await b.evaluate("[...document.querySelectorAll('.column-menu-popover .column-scope > span')].map((s) => s.textContent)");
    assert.deepEqual(scopes, ["Everyone on this board", "Only you", "Everyone on this board"], "board, view, then Delete (board)");
    assert.match(await text(".column-menu-popover .column-scope.is-view small"), /Not saved/);
    const groups = await b.evaluate(`(() => { const out = {}; let scope = ""; for (const el of document.querySelector('.column-menu-popover').children) { if (el.classList.contains('column-scope')) scope = el.querySelector('span').textContent; else if (el.dataset.action) (out[scope] ||= []).push(el.dataset.action); } return out; })()`);
    for (const a of ["rename-column", "edit-column-description", "column-settings", "edit-column-options", "change-column-type", "add-column-right", "duplicate-column", "hide-column", "move-column-menu", "column-width"]) assert.ok(groups["Everyone on this board"].includes(a), `board: ${a}`);
    for (const a of ["sort-column", "filter-column", "column-group-by"]) assert.ok(groups["Only you"].includes(a), `view: ${a} in ${JSON.stringify(groups)}`);
    assert.ok(await b.evaluate("!!document.querySelector('.column-menu-popover [data-action=request-delete-column]')"), "delete (admin under shared access)");
    // Change type: a page inside the same menu, with only the registry's targets (never Files, Connect, Mirror or Group).
    await click('.column-menu-popover [data-action="change-column-type"]');
    assert.ok(await b.waitFor("!!document.querySelector('.column-menu-popover [data-action=choose-new-type]')", 3000));
    const targets = await b.evaluate("[...document.querySelectorAll('.column-menu-popover [data-action=choose-new-type]')].map((x) => x.dataset.type)");
    assert.deepEqual(targets, await b.evaluate("ColumnTypes.conversionTargets({ key: 'status', type: 'status' })"));
    assert.ok(!targets.some((t) => ["files", "connect", "mirror", "group", "status"].includes(t)));
    assert.equal(await inViewport("#overlay-root .column-menu-popover"), true);
    await click(".column-menu-popover .column-menu-back");
    assert.ok(await b.waitFor("!!document.querySelector('.column-menu-popover [data-action=column-settings]')", 3000), "‹ Back to the menu");
    // Group by from the menu: for this person only, never saved on the board.
    await click('.column-menu-popover [data-action="column-group-by"]');
    assert.ok(await b.waitFor("!!document.querySelector('.view-group, .board-group-head, [data-group]')", 4000), "grouped by Status");
    await b.key("Escape");
    // A text column has no Group by and no labels; the primary column can be frozen (this person's setting).
    await openMenu("notes");
    const notes = await b.evaluate("[...document.querySelectorAll('.column-menu-popover [data-action]')].map((x) => x.dataset.action)");
    assert.ok(!notes.includes("column-group-by") && !notes.includes("edit-column-options"));
    await b.key("Escape");
    await openMenu("serial");
    assert.ok(await b.evaluate("!!document.querySelector('.column-menu-popover [data-action=toggle-sticky-name]')"));
    assert.ok(!(await b.evaluate("!!document.querySelector('.column-menu-popover [data-action=change-column-type], .column-menu-popover [data-action=request-delete-column]')")), "the primary column: no type change, no delete");
    await b.key("Escape");
  });

  test("S0-A: Change type from the new menu still runs the server's dry run and shows the refusal; nothing changes", async () => {
    await openBoard({ relations: "off" });
    await openMenu("ref");
    await click('.column-menu-popover [data-action="change-column-type"]');
    assert.ok(await b.waitFor("!!document.querySelector('.column-menu-popover [data-action=choose-new-type][data-type=number]')", 3000));
    await click('.column-menu-popover [data-action=choose-new-type][data-type=number]');
    assert.ok(await b.waitFor("!!document.querySelector('.conversion-refused')", 8000), "refusal dialog");
    assert.match(await text(".conversion-lead"), /Your data has not been changed/);
    assert.equal(await b.evaluate("!!document.querySelector('[data-action=confirm-change-type]')"), false, "no convert button");
    await click(".conversion-refused .button.primary");
    assert.equal((await columns()).find((c) => c.key === "ref").type, "text", "still text on the server");
  });

  test("settings panel: details and default value saved for everyone; labels use the existing editor", async () => {
    await openBoard({ relations: "off" });
    await openMenu("notes");
    await click('.column-menu-popover [data-action="column-settings"]');
    assert.ok(await b.waitFor("!!document.querySelector('.column-settings-panel form[data-action=column-settings-form]')", 4000));
    assert.match(await text(".column-settings-panel .column-scope-tag"), /Everyone on this board/);
    assert.equal(await b.evaluate("!!document.querySelector('.column-settings-panel .option-editor')"), false, "no labels for text");
    await b.evaluate("(() => { const f = document.querySelector('[data-action=column-settings-form]'); f.label.value = 'Remarks'; f.description.value = 'Anything worth knowing'; f.defaultValue.value = 'None yet'; f.required.checked = true; f.requestSubmit(); })()");
    await saved();
    const notes = (await columns()).find((c) => c.key === "notes");
    assert.deepEqual([notes.label, notes.description, notes.defaultValue, notes.required], ["Remarks", "Anything worth knowing", "None yet", true]);
    await openMenu("status");
    await click('.column-menu-popover [data-action="edit-column-options"]');
    assert.ok(await b.waitFor("document.querySelectorAll('.column-settings-panel .option-editor .option-row').length === 3", 4000), "labels first, in the panel");
    await b.evaluate("(() => { const rows = document.querySelectorAll('.option-editor .option-row'); rows[0].querySelector('.option-name').value = 'Queued'; document.querySelector('.option-editor').requestSubmit(); })()");
    await saved();
    assert.deepEqual((await columns()).find((c) => c.key === "status").options, ["Queued", "Working", "Done"]);
  });

  test("dark mode: the picker and menu use the dark surface and readable text", async () => {
    await openBoard({ theme: "dark", relations: "off" });
    await b.evaluate("document.documentElement.dataset.theme = 'dark'"); await sleep(100);
    const lum = (sel, prop) => b.evaluate(`(() => { const c = getComputedStyle(document.querySelector(${JSON.stringify(sel)}))[${JSON.stringify(prop)}].match(/[\\d.]+/g).map(Number); return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; })()`);
    await openPicker();
    assert.ok(await lum(".column-picker", "backgroundColor") < 0.3, "dark background");
    assert.ok(await lum(".column-picker-option strong", "color") > 0.7, "light text");
    await b.key("Escape");
    await openMenu("status");
    assert.ok(await lum(".column-menu-popover", "backgroundColor") < 0.3);
    await b.key("Escape");
  });

  test("phones: the picker is a bottom sheet with 44 px rows and a 16 px search field; the menu fits the screen", async () => {
    await openBoard({ width: 390, height: 844, relations: "off" });
    await b.evaluate("document.querySelector('.editable-table thead .add-column-button').scrollIntoView({ inline: 'center' })"); await sleep(150);
    assert.ok(await b.tapOn(".editable-table thead .add-column-button"));
    assert.ok(await b.waitFor("!!document.querySelector('.column-picker .column-picker-option')", 5000));
    await sleep(200);
    const box = await b.evaluate("(() => { const r = document.querySelector('.column-picker').getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, top: r.top, w: innerWidth, h: innerHeight }; })()");
    assert.equal(Math.round(box.left), 0); assert.equal(Math.round(box.right), box.w); assert.ok(Math.abs(box.bottom - box.h) <= 1, "docked at the bottom"); assert.ok(box.top > 0);
    assert.ok(await b.evaluate("[...document.querySelectorAll('.column-picker-option')].every((o) => o.getBoundingClientRect().height >= 44)"));
    assert.ok(await b.evaluate("parseFloat(getComputedStyle(document.querySelector('.column-picker [data-action=column-type-search]')).fontSize) >= 16"));
    await b.key("Escape"); await sleep(150);
    await b.evaluate("document.querySelector('.editable-table thead th[data-column-key=\"status\"] .column-menu-button').scrollIntoView({ inline: 'center' })"); await sleep(150);
    assert.ok(await b.tapOn('.editable-table thead th[data-column-key="status"] .column-menu-button'));
    assert.ok(await b.waitFor("!!document.querySelector('.column-menu-popover')", 4000));
    assert.equal(await inViewport(".column-menu-popover"), true);
    await b.key("Escape");
  });

  test("edges: near the right edge it aligns to the button, near the bottom it opens above; always inside the screen", async () => {
    for (const [width, height] of [[1440, 900], [900, 700]]) {
      await openBoard({ width, height, relations: "off" });
      await openPicker();
      const r = await b.evaluate("(() => { const p = document.querySelector('.column-picker').getBoundingClientRect(), a = document.querySelector('.editable-table thead .add-column-button').getBoundingClientRect(); return { pt: p.top, pb: p.bottom, ab: a.bottom, at: a.top }; })()");
      assert.equal(await inViewport("#overlay-root .column-picker"), true, `${width}px`);
      assert.ok(r.pt >= r.ab - 1 || r.pb <= r.at + 1, `${width}px: below or above the + button, never over it`);
      await b.key("Escape");
    }
    // Moved to the bottom of the screen: the picker flips above its anchor.
    await openBoard({ width: 1100, height: 700, relations: "off" });
    await b.evaluate("(() => { const a = document.querySelector('.editable-table thead .add-column-button'); a.getBoundingClientRect = () => ({ left: innerWidth - 40, right: innerWidth - 4, top: innerHeight - 40, bottom: innerHeight - 4, width: 36, height: 36 }); })()");
    await click(".editable-table thead .add-column-button");
    assert.ok(await b.waitFor("!!document.querySelector('.column-picker .column-picker-option')", 4000)); await sleep(150);
    const flip = await b.evaluate("(() => { const p = document.querySelector('.column-picker').getBoundingClientRect(), a = document.querySelector('.editable-table thead .add-column-button').getBoundingClientRect(); return { pb: p.bottom, at: a.top, pr: p.right, w: innerWidth }; })()");
    assert.ok(flip.pb <= flip.at + 1, `above the anchor ${JSON.stringify(flip)}`); assert.ok(flip.pr <= flip.w - 7, "inside the right edge");
    assert.equal(await inViewport("#overlay-root .column-picker"), true);
    await b.key("Escape");
  });
});
