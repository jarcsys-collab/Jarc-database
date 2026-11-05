// The test browser helper cleans up after itself: the browser really ends, its profile goes, nothing keeps the tests open, and what a stopped run left behind
// is removed by the next one, without ever touching a running test's profile or anything else in the folder.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, sweepProfiles } = require("./support/headless-browser");

const BROWSER = findBrowser();
const exited = (proc) => proc.exitCode !== null || proc.signalCode !== null;
const hogs = (n) => Array.from({ length: n }, () => spawn(process.execPath, ["-e", "for(;;)Math.sqrt(Math.random())"], { stdio: "ignore" }));

describe("Closing a test browser", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  test("the browser really ends and its profile is gone", async () => {
    const b = await launch(BROWSER), { profile, process: proc } = b;
    assert.equal(fs.existsSync(profile), true);
    await b.close();
    assert.equal(exited(proc), true); assert.equal(fs.existsSync(profile), false);
  });
  test("it's named for its owner, so a later sweep can tell whether it's still in use", async () => {
    const b = await launch(BROWSER);
    try { assert.ok(path.basename(b.profile).startsWith(`jarc-browser-${process.pid}-`)); } finally { await b.close(); }
  });
  test("closing twice is harmless", async () => {
    const b = await launch(BROWSER);
    await b.close(); await b.close();
    assert.equal(exited(b.process), true);
  });
  test("a browser that already died: close still finishes and tidies up, and a waiting call gets an answer instead of hanging", async () => {
    const b = await launch(BROWSER), { profile, process: proc } = b;
    proc.kill(); for (let i = 0; i < 100 && !exited(proc); i += 1) await sleep(50);
    assert.equal(await Promise.race([b.evaluate("1 + 1").then(() => "answered"), sleep(15000).then(() => "hung")]), "answered");
    await b.close();
    assert.equal(fs.existsSync(profile), false);
  });
  // Saturates the computer on purpose, which would disturb every other test in a full run, so it runs only when asked for: JARC_TEST_CPU_LOAD=1.
  test("with every CPU busy, the browser still ends and leaves no profile", { skip: process.env.JARC_TEST_CPU_LOAD ? false : "only when asked for, as it saturates the CPU" }, async () => {
    const load = hogs(os.cpus().length); let b;
    try {
      b = await launch(BROWSER); await b.close();
      assert.equal(exited(b.process), true, "a forced kill can't finish under this load, so this needs the graceful close");
      assert.equal(fs.existsSync(b.profile), false);
    } finally { load.forEach((p) => p.kill()); await b?.close(); }
  });
});

describe("Sweeping up after a stopped run", () => {
  const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarc-sweep-test-"));
  const make = (dir, name) => { const p = path.join(dir, name); fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, "file"), "x"); return p; };
  const age = (p, ms) => { const at = new Date(Date.now() - ms); fs.utimesSync(p, at, at); };
  const deadPid = async () => { const c = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" }); await new Promise((r) => c.on("exit", r)); return c.pid; };
  test("removes a profile whose owner has gone, keeps one whose owner is running", async () => {
    const dir = folder();
    try {
      const gone = make(dir, `jarc-browser-${await deadPid()}-aBc123`), mine = make(dir, `jarc-browser-${process.pid}-aBc123`);
      await sweepProfiles(dir);
      assert.equal(fs.existsSync(gone), false); assert.equal(fs.existsSync(mine), true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test("an old-style profile goes only once it's old: it might belong to a run still going", async () => {
    const dir = folder();
    try {
      const old = make(dir, "jarc-browser-AbC123"), fresh = make(dir, "jarc-browser-XyZ789");
      age(old, 2 * 60 * 60 * 1000);
      await sweepProfiles(dir);
      assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(fresh), true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test("a limit stops it after that many, so tidying up can't keep a test file open", async () => {
    const dir = folder();
    try {
      for (const suffix of ["AAAAA1", "AAAAA2", "AAAAA3", "AAAAA4"]) age(make(dir, `jarc-browser-${suffix}`), 2 * 60 * 60 * 1000);
      assert.equal((await sweepProfiles(dir, Date.now(), { limit: 3 })).length, 3);
      assert.equal(fs.readdirSync(dir).length, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test("nothing else in the folder is touched, however old", async () => {
    const dir = folder();
    try {
      const folders = [make(dir, "jarc-browsers"), make(dir, "my-jarc-browser-1-aBc123"), make(dir, "jarc-browser-reference-copy"), make(dir, "Product_Database_JARC")];
      const files = [path.join(dir, "jarc-browser-notes.xlsx"), path.join(dir, "jarc-browser-AbC123")]; // the second has a profile's exact name, but it's a file
      for (const f of files) fs.writeFileSync(f, "keep");
      for (const p of [...folders, ...files]) age(p, 90 * 24 * 60 * 60 * 1000);
      await sweepProfiles(dir);
      for (const p of [...folders, ...files]) assert.equal(fs.existsSync(p), true, p);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
