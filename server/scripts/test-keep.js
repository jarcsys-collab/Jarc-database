#!/usr/bin/env node
// TEST-ONLY: runs the test suite (or the test files given) exactly like `npm test`, and also keeps the full output of the run
// in tests/.diagnostics/run-<time>.txt, so a failure that doesn't happen again on a rerun can still be read afterwards.
// Browser-test failures add their screenshots and page state next to it (tests/support/headless-browser.js). The folder is
// ignored by Git; the last 10 runs are kept. Never loads server/.env.
//
//   npm run test:keep                      the whole suite
//   npm run test:keep -- tests/x.test.js   some files
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DIR = path.resolve(__dirname, "..", "tests", ".diagnostics");
const KEEP = 10;
fs.mkdirSync(DIR, { recursive: true });
const file = path.join(DIR, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
const runs = fs.readdirSync(DIR).filter((f) => /^run-.*\.txt$/.test(f)).sort();
for (const old of runs.slice(0, Math.max(0, runs.length - (KEEP - 1)))) fs.rmSync(path.join(DIR, old), { force: true });

const child = spawn(process.execPath, ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=spec", `--test-reporter-destination=${file}`, ...process.argv.slice(2)], { cwd: path.resolve(__dirname, ".."), stdio: "inherit" });
child.on("exit", (code, signal) => {
  process.stderr.write(`\nFull output of this run: ${file}\n`);
  process.exitCode = code ?? (signal ? 1 : 0);
});
