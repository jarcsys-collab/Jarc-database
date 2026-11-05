// The test browser helper cleans up after itself: the browser really ends, its profile goes, nothing keeps the tests open, and what a stopped run left behind
// is removed by the next one, without ever touching a running test's profile or anything else in the folder.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const { findBrowser, freePort, launch, sleep, shutDown, sweepProfiles, waitForServer } = require("./support/headless-browser");

const BROWSER = findBrowser();
const exited = (proc) => proc.exitCode !== null || proc.signalCode !== null;
const hogs = (n) => Array.from({ length: n }, () => spawn(process.execPath, ["-e", "for(;;)Math.sqrt(Math.random())"], { stdio: "ignore" }));
// close() never waits without limit, so on a saturated computer a browser can end just after it returns. What matters: it does end, and its profile goes with it.
const endsWithin = async (proc, profile, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end && (!exited(proc) || fs.existsSync(profile))) await sleep(100); return { exited: exited(proc), profileGone: !fs.existsSync(profile) }; };

describe("Closing a test browser", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  test("the browser really ends and its profile is gone", async () => {
    const b = await launch(BROWSER), { profile, process: proc } = b;
    assert.equal(fs.existsSync(profile), true);
    await b.close();
    assert.deepEqual(await endsWithin(proc, profile), { exited: true, profileGone: true });
  });
  test("it's named for its owner, so a later sweep can tell whether it's still in use", async () => {
    const b = await launch(BROWSER);
    try { assert.ok(path.basename(b.profile).startsWith(`jarc-browser-${process.pid}-`)); } finally { await b.close(); }
  });
  test("closing twice is harmless", async () => {
    const b = await launch(BROWSER);
    await b.close(); await b.close();
    assert.equal((await endsWithin(b.process, b.profile)).exited, true);
  });
  test("a browser that already died: close still finishes and tidies up, and a waiting call gets an answer instead of hanging", async () => {
    const b = await launch(BROWSER), { profile, process: proc } = b;
    proc.kill(); for (let i = 0; i < 100 && !exited(proc); i += 1) await sleep(50);
    assert.equal(await Promise.race([b.evaluate("1 + 1").then(() => "answered"), sleep(15000).then(() => "hung")]), "answered");
    await b.close();
    assert.equal((await endsWithin(proc, profile)).profileGone, true);
  });
  // Saturates the computer on purpose, which would disturb every other test in a full run, so it runs only when asked for: JARC_TEST_CPU_LOAD=1.
  test("with every CPU busy, the browser still ends and leaves no profile", { skip: process.env.JARC_TEST_CPU_LOAD ? false : "only when asked for, as it saturates the CPU" }, async () => {
    const load = hogs(os.cpus().length); let b;
    try {
      b = await launch(BROWSER); await b.close();
      assert.equal(exited(b.process), true, "a forced kill can't finish under this load, so this needs the graceful close");
      assert.deepEqual((await endsWithin(b.process, b.profile, 30000)).profileGone, true);
    } finally { load.forEach((p) => p.kill()); await b?.close(); }
  });
});

describe("A test server that never becomes ready", () => {
  test("is stopped when the wait gives up, so it can't hold the test file open", async () => {
    const idle = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const ended = new Promise((resolve) => idle.once("exit", resolve));
    try {
      await assert.rejects(waitForServer(`http://127.0.0.1:${await freePort()}`, { timeoutMs: 400, child: idle }), /did not become ready within 0.4 s/);
      assert.equal(await Promise.race([ended.then(() => "stopped"), sleep(15000).then(() => "still running")]), "stopped");
    } finally { idle.kill(); }
  });
});

describe("A browser stuck in shutdown", () => {
  test("stopping it ends within its limits without holding the tests open, and its profile goes when it finally ends", async () => {
    // A stand-in: a real browser can't be made to hang on request. It ignores being stopped, as a browser does on a saturated computer.
    const stuck = Object.assign(new EventEmitter(), { pid: 2 ** 30, exitCode: null, signalCode: null, unrefCalled: false, kill: () => true, unref() { this.unrefCalled = true; } });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "jarc-stuck-test-"));
    try {
      const started = Date.now();
      assert.equal(await shutDown(stuck, profile), false, "it says the browser hasn't ended");
      assert.ok(Date.now() - started < 30000, "and doesn't wait without limit");
      assert.equal(stuck.unrefCalled, true, "it can't keep the tests open");
      fs.mkdirSync(profile, { recursive: true }); fs.writeFileSync(path.join(profile, "still-here"), "x"); // the browser was still holding its files
      stuck.exitCode = 1; stuck.emit("exit", 1);
      for (let i = 0; i < 100 && fs.existsSync(profile); i += 1) await sleep(50);
      assert.equal(fs.existsSync(profile), false, "removed as soon as it ended");
    } finally { fs.rmSync(profile, { recursive: true, force: true }); }
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
