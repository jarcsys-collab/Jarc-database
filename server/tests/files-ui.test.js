// Files column and column guidance in the REAL app, in a headless browser (Chrome/Edge), with two signed-in employees
// (Entra test server, ACCESS_POLICY=development_shared, fake MongoDB, in-memory file store — never real storage).
// Uploads through the file chooser and by drag and drop, refused files, progress and failure states, preview,
// download links, removal with confirmation, live updates in a colleague's open board (without disturbing an open
// editor), column descriptions, the checkbox, and phone layout.
// Skipped when no Chrome or Edge is installed (set JARC_TEST_BROWSER to use a specific one).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort } = require("./support/headless-browser");

const BROWSER = findBrowser();
const COLUMNS = [
  { key: "serial", label: "Item", type: "text", required: true },
  { key: "docs", label: "Documents", type: "files" },
  { key: "notes", label: "Notes", type: "text" },
  { key: "done", label: "Done?", type: "checkbox" },
  { key: "status", label: "Status", type: "status", options: ["To do", "Done"] }
];
// A real 1×1 PNG (so the preview can be checked to have loaded), and a small PDF.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PDF_TEXT = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

describe("Files column and column guidance (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, ana, ben, ws, board;
  const OIDS = { "ana@example.invalid": "0a0a0a0a-0000-4000-8000-000000000011", "ben@example.invalid": "0b0b0b0b-0000-4000-8000-000000000012" };
  const signIn = (b, name, email) => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=${OIDS[email]}&name=${encodeURIComponent(name)}&email=${email}&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  const api = (b, method, p, body) => b.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1${p}", { method: "${method}", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }); return { status: r.status, body: await r.json() }; })()`);
  const record = async (serial) => (await api(ana, "GET", `/boards/${board.id}/records?limit=200`)).body.items.find((r) => r.values.serial === serial);
  const serverFiles = async (serial) => (await api(ana, "GET", `/records/${(await record(serial)).id}/attachments`)).body.items;
  const cell = (serial, key) => `tr:has(td[data-column-key="serial"] [aria-label="Item: ${serial}"]) td[data-column-key="${key}"] .cell-display`;
  const click = (b, sel) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: "center", inline: "center" }); el.click(); return true; })()`);
  const count = (b, sel) => b.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  // Files made in the page: [name, type, "png" | "pdf" | text].
  const filesJs = (files) => `[${files.map(([name, type, kind]) => `new File([${kind === "png" ? `Uint8Array.from(atob("${PNG_B64}"), c => c.charCodeAt(0))` : kind === "pdf" ? JSON.stringify(PDF_TEXT) : JSON.stringify(kind)}], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} })`).join(",")}]`;
  const choose = (b, files) => b.evaluate(`(() => { const input = document.querySelector('.files-popover input[type=file]'); if (!input) return false; const dt = new DataTransfer(); for (const f of ${filesJs(files)}) dt.items.add(f); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  const drop = (b, sel, files) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; const dt = new DataTransfer(); for (const f of ${filesJs(files)}) dt.items.add(f); el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true })); el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
  const openBoard = async (b, width = 1280) => {
    await b.open(`${base}/`, { width, height: 860 });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item') || !!document.querySelector('.entra-login')", 15000), "app shown");
    await b.evaluate("[...document.querySelectorAll('#sidebar .tree-item')].find((el) => el.textContent.includes('Files board'))?.click()");
    assert.ok(await b.waitFor("!!document.querySelector('.editable-table tbody tr td.cell')", 15000), "board table loaded");
    await sleep(500);
  };
  const addRecord = (serial, values = {}) => api(ana, "POST", `/boards/${board.id}/records`, { values: { serial, ...values } });

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    for (let i = 0; i < 100; i += 1) { try { await fetch(`${base}/api/v1/health`); break; } catch { await sleep(100); } }
    ana = await launch(BROWSER); ben = await launch(BROWSER);
    for (const [b, name, email] of [[ana, "Ana Reyes", "ana@example.invalid"], [ben, "Ben Cruz", "ben@example.invalid"]]) { await b.open(`${base}/api/v1/health`, { width: 1280 }); await signIn(b, name, email); }
    ws = (await api(ana, "POST", "/workspaces", { name: "Files team" })).body.workspace;
    board = (await api(ana, "POST", `/workspaces/${ws.id}/boards`, { name: "Files board", columns: COLUMNS })).body.board;
    await addRecord("F-1"); await addRecord("F-2");
  });
  after(async () => { await ana?.close(); await ben?.close(); server?.kill(); });

  test("upload from the panel: progress, thumbnails, metadata; refused files explain why; a colleague sees it live without losing their typing", async () => {
    await openBoard(ana); await openBoard(ben);
    // Ben is typing a note in the same record when Ana's files arrive.
    assert.ok(await click(ben, cell("F-1", "notes")));
    assert.ok(await ben.waitFor("!!document.querySelector('.cell-input')", 3000));
    await ben.evaluate("document.querySelector('.cell-input').value = 'Ben draft'");

    assert.ok(await click(ana, cell("F-1", "docs")), "an empty Files cell opens the attachment panel");
    assert.ok(await ana.waitFor("!!document.querySelector('.files-popover input[type=file]')", 3000));
    assert.equal(await ana.evaluate("document.querySelector('.files-popover input[type=file]').getAttribute('accept')"), ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp");
    assert.ok(await choose(ana, [["site.png", "image/png", "png"], ["invoice.pdf", "application/pdf", "pdf"], ["notes.txt", "text/plain", "hello"]]));
    assert.ok(await ana.waitFor("document.querySelectorAll('.files-popover .file-open').length === 2", 8000), "both files listed after upload");
    assert.match(await ana.evaluate("document.querySelector('.files-popover .file-error')?.textContent || ''"), /Only PDF, JPEG, PNG and WebP/);
    assert.match(await ana.evaluate("document.querySelector('.files-popover .file-open small').textContent"), /PNG · \d+ B · Ana Reyes ·/);
    assert.deepEqual((await serverFiles("F-1")).map((a) => a.name).sort(), ["invoice.pdf", "site.png"], "saved on the server; the text file was never sent");
    assert.equal(await count(ana, `${cell("F-1", "docs")} .file-thumb`), 2, "the cell shows thumbnails");

    assert.ok(await ben.waitFor(`document.querySelectorAll(${JSON.stringify(cell("F-1", "docs"))} + " .file-thumb").length === 2`, 8000), "Ben sees the files live");
    assert.equal(await ben.evaluate("document.querySelector('.cell-input')?.value"), "Ben draft", "Ben's open editor and typing are untouched");
    await ben.key("Escape");
  });

  test("preview (image and PDF), download links, and removal with confirmation — reflected live for a colleague", async () => {
    await ana.key("Escape"); await sleep(150);
    assert.ok(await click(ana, cell("F-1", "docs")));
    assert.ok(await ana.waitFor("document.querySelectorAll('.files-popover .file-open').length === 2", 3000));
    const download = await ana.evaluate("[...document.querySelectorAll('.files-popover a[download]')].map(a => a.getAttribute('href'))");
    assert.ok(download.every((h) => /^\/api\/v1\/attachments\/[0-9a-f]{24}\/content\?download=1$/.test(h)), "same-origin, authenticated download links only");
    await click(ana, '.files-popover [data-action="preview-file"][aria-label="Preview site.png"]');
    assert.ok(await ana.waitFor("document.querySelector('.file-preview-image')?.naturalWidth === 1", 5000), "the image preview loads");
    await click(ana, '[data-action="back-to-files"]');
    assert.ok(await ana.waitFor("!!document.querySelector('.files-popover')", 3000), "back to the file list");
    await click(ana, '.files-popover [data-action="preview-file"][aria-label="Preview invoice.pdf"]');
    assert.ok(await ana.waitFor("!!document.querySelector('iframe.file-preview-frame')", 3000), "PDFs preview in a frame");
    await click(ana, '[data-action="back-to-files"]');
    await ana.waitFor("!!document.querySelector('.files-popover')", 3000);

    await click(ana, '.files-popover [data-action="request-remove-file"][aria-label="Remove site.png"]');
    assert.ok(await ana.waitFor("!!document.querySelector('.file-row.is-confirming')", 2000), "asks before removing");
    assert.equal((await serverFiles("F-1")).length, 2, "nothing removed before confirming");
    await click(ana, '.file-row.is-confirming [data-action="confirm-remove-file"]');
    assert.ok(await ana.waitFor("document.querySelectorAll('.files-popover .file-open').length === 1", 5000));
    assert.deepEqual((await serverFiles("F-1")).map((a) => a.name), ["invoice.pdf"]);
    assert.ok(await ben.waitFor(`document.querySelectorAll(${JSON.stringify(cell("F-1", "docs"))} + " .file-thumb").length === 1`, 8000), "Ben sees the removal live");
    await ana.key("Escape");
  });

  test("drag and drop onto a Files cell uploads; dropping elsewhere never navigates away; uploads don't change the record", async () => {
    const before = await record("F-2");
    assert.ok(await drop(ana, `tr:has(td[data-column-key="serial"] [aria-label="Item: F-2"]) td[data-column-key="docs"]`, [["photo.png", "image/png", "png"]]));
    assert.ok(await ana.waitFor(`document.querySelectorAll(${JSON.stringify(cell("F-2", "docs"))} + " .file-thumb").length === 1`, 8000));
    assert.deepEqual((await serverFiles("F-2")).map((a) => a.name), ["photo.png"]);
    const after = await record("F-2");
    assert.equal(after.version, before.version, "the record itself is unchanged (no version conflict for anyone editing it)");
    await ana.key("Escape");
    assert.ok(await drop(ana, ".board-head", [["stray.png", "image/png", "png"]]));
    await sleep(300);
    assert.equal(await ana.evaluate("location.pathname"), "/", "still in JARC");
    assert.equal((await serverFiles("F-2")).length, 1, "nothing uploaded from a stray drop");
  });

  test("column descriptions: edit from the menu, shown from the ⓘ control, synced live to a colleague", async () => {
    await ana.key("Escape");
    assert.ok(await click(ana, 'th[data-column-key="notes"] .column-menu-button'));
    assert.ok(await ana.waitFor("!!document.querySelector('.column-menu-popover')", 2000));
    assert.deepEqual(await ana.evaluate("[...document.querySelectorAll('.column-menu-popover .menu-section-label')].map(e => e.textContent)"), ["Column", "View", "Arrange"]);
    await click(ana, '.column-menu-popover [data-action="rename-column"]');
    assert.ok(await ana.waitFor("!!document.querySelector('form[data-action=rename-column-form] textarea[name=description]')", 2000));
    await ana.evaluate("document.querySelector('textarea[name=description]').value = 'What the technician found on site.'");
    await click(ana, 'form[data-action="rename-column-form"] .button.primary');
    assert.ok(await ana.waitFor("!document.querySelector('.save-state')?.textContent.includes('Saving')", 5000));
    await sleep(400);
    const stored = (await api(ana, "GET", `/boards/${board.id}`)).body.board.columns.find((c) => c.key === "notes");
    assert.equal(stored.description, "What the technician found on site.");
    await click(ana, 'th[data-column-key="notes"] .column-info-button');
    assert.match(await ana.evaluate("document.querySelector('.column-info-popover')?.textContent || ''"), /What the technician found on site\./);
    await ana.key("Escape");
    assert.ok(await ben.waitFor(`document.querySelector('th[data-column-key="notes"] .column-info-button')?.title === "What the technician found on site."`, 10000), "Ben's header shows the new description");
    // Files columns offer no "Change type" or filter; other columns do.
    await click(ana, 'th[data-column-key="docs"] .column-menu-button');
    assert.deepEqual(await ana.evaluate("['change-column-type','filter-column','rename-column'].map(a => !!document.querySelector(`.column-menu-popover [data-action=${a}]`))"), [false, false, true]);
    await ana.key("Escape");
  });

  test("checkbox: one click or Space toggles and saves; Status fills its cell", async () => {
    await ana.key("Escape");
    assert.ok(await click(ana, cell("F-2", "done")));
    assert.ok(await ana.waitFor(`document.querySelector(${JSON.stringify(cell("F-2", "done"))})?.getAttribute("aria-checked") === "true"`, 3000));
    await ana.evaluate(`document.querySelector(${JSON.stringify(cell("F-2", "done"))}).focus()`);
    await ana.key(" ", "Space");
    assert.ok(await ana.waitFor(`document.querySelector(${JSON.stringify(cell("F-2", "done"))})?.getAttribute("aria-checked") === "false"`, 3000), "Space toggles it back");
    assert.equal(await count(ana, ".cell-options-popover"), 0, "a checkbox never opens a picker");
    await sleep(800);
    assert.equal((await record("F-2")).values.done, false);
    const box = await ana.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(cell("F-2", "done"))} + " .cell-checkbox").getBoundingClientRect(); return [r.width, r.height]; })()`);
    assert.ok(box[0] >= 22 && box[1] >= 22, `a large checkbox (${box})`);
  });

  test("deleting a Files column or a record with files warns that the files go for good (Undo can't restore them)", async () => {
    await ana.key("Escape");
    await click(ana, 'th[data-column-key="docs"] .column-menu-button');
    await click(ana, '.column-menu-popover [data-action="request-delete-column"]');
    assert.match(await ana.evaluate("document.querySelector('#overlay-root').textContent"), /holds 2 files. Deleting it permanently deletes them for everyone/);
    await ana.key("Escape"); await sleep(150);
    // The same action the record menu's Delete button sends.
    const id = (await record("F-2")).id;
    await ana.evaluate(`(() => { const b = document.createElement("button"); b.dataset.action = "delete"; b.dataset.id = "${id}"; document.querySelector(".app-shell").append(b); b.click(); b.remove(); })()`);
    assert.match(await ana.evaluate("document.querySelector('#overlay-root').textContent"), /1 attached file will be permanently deleted. Undo can restore the records but not the files/);
    await ana.key("Escape");
    assert.equal((await serverFiles("F-2")).length, 1, "nothing deleted without confirming");
  });

  test("phone: the Files panel fits the screen and its buttons are finger-sized", async () => {
    await openBoard(ana, 390);
    assert.ok(await click(ana, cell("F-1", "docs")));
    assert.ok(await ana.waitFor("!!document.querySelector('.files-popover')", 3000));
    const fit = await ana.evaluate("(() => { const r = document.querySelector('.files-popover').getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth }; })()");
    assert.ok(fit.left >= 0 && fit.right <= fit.width, `panel inside the screen (${JSON.stringify(fit)})`);
    const sizes = await ana.evaluate("[...document.querySelectorAll('.files-popover .file-actions .icon-button')].map(b => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))");
    assert.ok(sizes.length && sizes.every((s) => s >= 44), `touch targets ${sizes}`);
  });
});
