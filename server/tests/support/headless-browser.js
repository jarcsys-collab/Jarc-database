// TEST-ONLY: a locally installed Chrome or Edge, headless, driven over the DevTools protocol with exact device
// emulation (window sizes alone can't go below ~500 px on some platforms). Used for layout checks; tests skip when no
// browser is found. Override with JARC_TEST_BROWSER=<path to chrome/msedge>.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");

const CANDIDATES = [
  process.env.JARC_TEST_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
];
const findBrowser = () => CANDIDATES.find((p) => p && fs.existsSync(p)) || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// ---- Cleaning up. On Windows a forced kill can't finish while the CPU is saturated (the process stays until there's CPU to spare, holding its profile
// and keeping the test process open), but a browser asked to close does finish. So: ask first, force only if that fails, and never wait without limit.
const PROFILE_PREFIX = "jarc-browser-", STALE_MS = 60 * 60 * 1000, GRACEFUL_MS = 20000, FORCED_MS = 5000, SWEEP_LIMIT = 10;
const running = new Set(), leftProfiles = new Set();
const removeProfile = async (profile) => {
  try { await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); leftProfiles.delete(profile); return true; }
  catch { leftProfiles.add(profile); return false; } // still locked: the exit handler or a later run's sweep takes it
};
const forceStop = (proc) => {
  if (process.platform !== "win32") { try { proc.kill("SIGKILL"); } catch { /* already gone */ } return; }
  // /T also stops the browser's own helper processes, which a plain kill would leave behind.
  spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", timeout: 10000 });
};
const hasExited = (proc) => proc.exitCode !== null || proc.signalCode !== null;
const waitForExit = (proc, ms) => (hasExited(proc) ? Promise.resolve(true) : new Promise((resolve) => {
  const timer = setTimeout(() => { proc.off("exit", done); resolve(false); }, ms), done = () => { clearTimeout(timer); resolve(true); };
  proc.once("exit", done);
}));
// Stops a browser and removes its profile. Never throws, and always ends. Answers whether the browser really exited.
async function shutDown(proc, profile, askToClose = null) {
  running.delete(proc);
  let exited = hasExited(proc);
  if (!exited && askToClose) { try { askToClose(); exited = await waitForExit(proc, GRACEFUL_MS); } catch { /* no connection: force it */ } }
  if (!exited) { forceStop(proc); exited = await waitForExit(proc, FORCED_MS); }
  if (!exited) { proc.unref(); proc.once("exit", () => { removeProfile(profile).catch(() => {}); }); } // it will go when the CPU frees up: it mustn't keep the tests open until then, and its profile goes with it
  await removeProfile(profile);
  return exited;
}
// A test process that's stopped from outside can't clean up after itself, so whoever launches a browser next does: a profile whose owner has gone, or an
// old one from before profiles named their owner. A running test's profile is never touched.
// Only a folder with exactly the name this helper generates (the prefix, an optional owner, six random characters) is ever considered.
const PROFILE_NAME = /^jarc-browser-(?:(\d+)-)?[A-Za-z0-9]{6}$/;
const ownerOf = (name) => { const owner = PROFILE_NAME.exec(name)?.[1]; return owner ? Number(owner) : null; };
const isRunning = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
function stopBrowsersUsing(profile) {
  if (process.platform === "win32") spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|msedge)\\.exe$' -and $_.CommandLine -and $_.CommandLine.Contains($env:JARC_STALE_PROFILE) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: "ignore", timeout: 30000, env: { ...process.env, JARC_STALE_PROFILE: `--user-data-dir=${profile}` } });
  else spawnSync("pkill", ["-f", `--user-data-dir=${profile}`], { stdio: "ignore", timeout: 10000 });
}
async function sweepProfiles(directory = os.tmpdir(), now = Date.now(), { limit = Infinity } = {}) {
  const swept = [];
  let names; try { names = await fs.promises.readdir(directory); } catch { return swept; }
  for (const name of names.filter((n) => PROFILE_NAME.test(n))) {
    if (swept.length >= limit) break;
    const profile = path.join(directory, name), owner = ownerOf(name), info = await fs.promises.lstat(profile).catch(() => null);
    if (!info?.isDirectory()) continue;
    if (owner !== null ? isRunning(owner) : now - info.mtimeMs < STALE_MS) continue;
    if (!await removeProfile(profile)) { stopBrowsersUsing(profile); await sleep(500); if (!await removeProfile(profile)) continue; }
    swept.push(name);
  }
  return swept;
}
let swept = false;
// A few at a time: tidying up mustn't keep a test file open, and each file that launches a browser takes its turn.
const sweepOnce = () => { if (!swept) { swept = true; sweepProfiles(os.tmpdir(), Date.now(), { limit: SWEEP_LIMIT }).catch(() => {}); } };
// The last chance when a test ends without closing its browser, including after a failure.
function cleanUpAtExit() {
  for (const proc of running) { try { proc.kill(); } catch { /* already gone */ } }
  for (const profile of leftProfiles) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* a later run's sweep takes it */ } }
}
let exitHooked = false;
const hookExit = () => {
  if (exitHooked) return; exitHooked = true;
  process.once("exit", cleanUpAtExit);
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.once(signal, () => process.exit(code));
};

async function launch(executable = findBrowser(), { attempts = 2, startupMs = 60000 } = {}) {
  hookExit(); sweepOnce();
  let port, profile, proc, target;
  // Waits (on every try) until the browser's debugging endpoint lists a page. Under heavy load (many browsers starting
  // in parallel) the endpoint can answer before the page exists, so a short or try-counted wait gave up too early.
  for (let attempt = 1; attempt <= attempts && !target; attempt += 1) {
    port = await freePort();
    profile = fs.mkdtempSync(path.join(os.tmpdir(), `${PROFILE_PREFIX}${process.pid}-`)); leftProfiles.add(profile);
    proc = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    running.add(proc);
    const deadline = Date.now() + startupMs;
    while (!target && Date.now() < deadline) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { /* not listening yet */ }
      if (!target) await sleep(100);
    }
    if (!target) await shutDown(proc, profile);
  }
  if (!target) throw new Error("The headless browser didn't start.");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try { await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); }); }
  catch (error) { await shutDown(proc, profile); throw error; }
  let id = 0; const pending = new Map();
  // The page's recent console messages and uncaught errors, kept for failure diagnostics (see keepFailureDiagnostics).
  const events = [];
  const remember = (line) => { events.push(`${new Date().toISOString()} ${line}`.slice(0, 2000)); if (events.length > 300) events.shift(); };
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === "Runtime.consoleAPICalled") remember(`console.${msg.params.type}: ${(msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ")}`);
    else if (msg.method === "Runtime.exceptionThrown") remember(`uncaught: ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || "error"}`);
    else if (msg.method === "Log.entryAdded") remember(`${msg.params.entry.level} (${msg.params.entry.source}): ${msg.params.entry.text}${msg.params.entry.url ? ` ${msg.params.entry.url}` : ""}`);
  });
  // A browser that died mustn't leave a test waiting forever for an answer.
  ws.addEventListener("close", () => { for (const answer of pending.values()) answer({}); pending.clear(); });
  const send = (method, params = {}) => new Promise((resolve) => { if (ws.readyState !== WebSocket.OPEN) { resolve({}); return; } const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  let closing = null;
  const browser = {
    send,
    // Failure diagnostics: a screenshot, the page's HTML, its URL and size, and the recent console messages and errors.
    async saveDiagnostics(dir, info = {}) {
      fs.mkdirSync(dir, { recursive: true });
      const shot = await send("Page.captureScreenshot", { format: "png" });
      if (shot.result?.data) fs.writeFileSync(path.join(dir, "screenshot.png"), Buffer.from(shot.result.data, "base64"));
      const page = await this.evaluate("({ url: location.href, width: innerWidth, height: innerHeight, focused: document.activeElement ? document.activeElement.tagName + (document.activeElement.dataset?.action ? '[' + document.activeElement.dataset.action + ']' : '') : null, overlay: document.querySelector('#overlay-root')?.children.length || 0, html: document.documentElement.outerHTML })").catch((e) => ({ error: String(e?.message || e) }));
      if (page.html) fs.writeFileSync(path.join(dir, "page.html"), page.html);
      fs.writeFileSync(path.join(dir, "console.log"), `${events.join("\n")}\n`);
      fs.writeFileSync(path.join(dir, "info.json"), JSON.stringify({ ...info, url: page.url, viewport: { width: page.width, height: page.height }, focused: page.focused, overlayOpen: page.overlay, pageError: page.error || null, savedAt: new Date().toISOString() }, null, 2));
      return dir;
    },
    // The browser's own process, so a test can see that it really ended.
    get process() { return proc; }, get profile() { return profile; },
    // Sets an exact CSS viewport; phones (< 768 px) also get touch input, like a real phone.
    async viewport({ width, height = 800 }) {
      const mobile = width < 768;
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      await send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
      await send("Emulation.setEmitTouchEventsForMouse", { enabled: mobile, configuration: "mobile" });
    },
    // The page's prefers-reduced-motion ("reduce" | "no-preference"), independent of this computer's own setting.
    async motionPreference(value) { await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value }] }); },
    // Opens a file (absolute path) or URL at an exact CSS viewport width and waits for its stylesheets.
    async open(target, { width, height = 800 }) {
      await this.viewport({ width, height });
      const url = /^https?:/.test(target) ? target : "file:///" + target.split(path.sep).join("/");
      await send("Page.navigate", { url });
      for (let i = 0; i < 100; i += 1) { if (await this.evaluate("document.readyState === 'complete' && [...document.styleSheets].length > 0")) break; await sleep(50); }
    },
    // A finger tap at a point (touchstart → touchend), as a phone delivers it; then lets the page react.
    async tap(x, y, { settle = 120 } = {}) {
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(settle);
    },
    // Taps the centre of the first element matching a selector; returns false when it isn't visible.
    async tapOn(selector, options) {
      const box = await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
      if (!box) return false;
      await this.tap(box.x, box.y, options);
      return true;
    },
    // A key press as a keyboard sends it (Enter and Space also activate the focused button).
    async key(key, code = key) {
      const codes = { Escape: 27, Enter: 13, " ": 32, ArrowDown: 40, ArrowUp: 38, Tab: 9 }, text = key === "Enter" ? String.fromCharCode(13) : key === " " ? " " : undefined;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key === " " ? "Space" : code, windowsVirtualKeyCode: codes[key] || 0, ...(text ? { text } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key === " " ? "Space" : code, windowsVirtualKeyCode: codes[key] || 0 });
      await sleep(80);
    },
    async waitFor(expression, timeoutMs = 5000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) { if (await this.evaluate(expression)) return true; await sleep(50); }
      return false;
    },
    async evaluate(expression) {
      const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || "evaluate failed");
      return res.result?.result?.value;
    },
    // Safe to call twice, and after the browser has already died.
    close() {
      closing ??= shutDown(proc, profile, () => { if (ws.readyState !== WebSocket.OPEN) throw new Error("not connected"); ws.send(JSON.stringify({ id: ++id, method: "Browser.close" })); })
        .finally(() => { try { ws.close(); } catch { /* already closed */ } });
      return closing;
    }
  };
  live.add(browser);
  const forget = () => live.delete(browser);
  const close = browser.close.bind(browser);
  browser.close = () => { forget(); return close(); };
  return browser;
}

// ---- Failure diagnostics. Under `node --test` (each test file is its own process, and every browser test loads this module),
// a failed test leaves tests/.diagnostics/<time>-<file>-<test>/ for each browser that file has open: screenshot.png,
// page.html, console.log and info.json (the error). The folder is ignored by Git; delete it whenever you like. Data in these
// tests is synthetic. JARC_TEST_DIAGNOSTICS=0 switches it off.
const live = new Set();
const DIAGNOSTICS = path.resolve(__dirname, "..", ".diagnostics");
const safePart = (text) => String(text || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "test";
async function saveFailure(t) {
  if (t.passed !== false || !live.size) return;
  const file = safePart(path.basename(process.argv[1] || "test", ".js")), stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let n = 0;
  for (const b of [...live]) {
    n += 1;
    const dir = path.join(DIAGNOSTICS, `${stamp}-${file}-${safePart(t.name)}${live.size > 1 ? `-browser${n}` : ""}`);
    try {
      await Promise.race([b.saveDiagnostics(dir, { test: t.name, file: process.argv[1] ? path.basename(process.argv[1]) : null, error: String(t.error?.cause?.stack || t.error?.stack || t.error || "").slice(0, 8000) }), sleep(15000)]);
      process.stderr.write(`[diagnostics] ${t.name}: saved to ${dir}\n`);
    } catch (error) { process.stderr.write(`[diagnostics] couldn't save for ${t.name}: ${error?.message || error}\n`); }
  }
}
if (process.env.NODE_TEST_CONTEXT && process.env.JARC_TEST_DIAGNOSTICS !== "0") require("node:test").afterEach(saveFailure);

// Waits until a test server started as a child process answers /api/v1/health, and FAILS if it never does. (An earlier
// loop gave up silently after 10 s; under a full parallel run the server could still be starting, and the first request
// from the browser then failed with "Failed to fetch" in an unrelated-looking place.)
async function waitForServer(base, { timeoutMs = 60000, child = null } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child && child.exitCode !== null) throw new Error(`The test server exited early (code ${child.exitCode}).`);
    try { const res = await fetch(`${base}/api/v1/health`); if (res.ok) return; } catch { /* not listening yet */ }
    await sleep(100);
  }
  // Whoever asked gets an error instead of a handle to the server, so nobody else can stop it, and it would hold the test file open for good.
  if (child && child.exitCode === null) child.kill();
  throw new Error(`The test server at ${base} did not become ready within ${timeoutMs / 1000} s.`);
}

module.exports = { findBrowser, launch, sleep, freePort, waitForServer, shutDown, sweepProfiles, DIAGNOSTICS };
