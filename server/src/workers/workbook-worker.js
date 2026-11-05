// Runs on a worker thread, so reading and checking a large workbook never holds up the people using the app.
//   { op: "read", buffer, name, sheet, choices, settings } reads a file, then sends its rows back in pieces, one at a time, as asked.
//   { op: "check", choices, settings, notes }              takes rows in pieces, ends with { done: true }, and checks them.
// The thread ends by itself once it has nothing left to do, never with process.exit, which can drop a message still on its way.
// Both answer { type: "result", analysis, validation, ... }. Failures answer { type: "failed", ... } with a message safe to show.
const { parentPort } = require("worker_threads");
const { readTable } = require("../domain/spreadsheet");
const { analyzeTable, validateTable } = require("../domain/workbook-structure");

const PIECE_ROWS = 100, PIECE_BYTES = 4 * 1024 * 1024;
const nextMessage = () => new Promise((resolve) => parentPort.once("message", resolve));

function check(table, choices, settings, notes) {
  const analysis = analyzeTable(table, choices);
  const columns = settings?.columns ? analysis.columns.map((c) => { const own = settings.columns.find((s) => s.index === c.index); return own ? { ...c, ...own } : c; }) : analysis.columns;
  const validation = analysis.headerLine === null ? null : validateTable(table, analysis, { ...settings, columns, itemColumn: analysis.itemColumn }, notes);
  return { analysis: { ...analysis, columns }, validation };
}

async function run(job) {
  if (job.op === "read") {
    const { kind, sheet, sheets, table, notes } = readTable(Buffer.from(job.buffer), { name: job.name, sheet: job.sheet });
    const checked = check(table, job.choices, job.settings, notes);
    parentPort.postMessage({ type: "result", kind, sheet, sheets, notes, rowsInFile: table.length, ...checked });
    // Rows follow one piece at a time: the app stores each before asking for the next.
    let rows = [], bytes = 0;
    const send = async () => { if (!rows.length) return true; parentPort.postMessage({ type: "rows", rows }); rows = []; bytes = 0; return (await nextMessage())?.op === "more"; };
    for (const r of table) {
      const size = r.cells.reduce((sum, c) => sum + Buffer.byteLength(c, "utf8") + 8, 16);
      if (rows.length && (rows.length >= PIECE_ROWS || bytes + size > PIECE_BYTES) && !await send()) return;
      rows.push([r.line, r.cells]); bytes += size;
    }
    await send();
    parentPort.postMessage({ type: "end" });
    return;
  }
  const table = [];
  for (;;) { const m = await nextMessage(); if (m.done) break; for (const [line, cells] of m.rows) table.push({ line, cells }); parentPort.postMessage({ type: "ack" }); }
  parentPort.postMessage({ type: "result", ...check(table, job.choices, job.settings, job.notes) });
}

nextMessage().then(run).catch((error) => parentPort.postMessage({ type: "failed", status: error?.status, code: error?.code, message: error?.status ? error.message : "This file couldn't be read." }));
