// TEST-ONLY: a locally installed Chrome or Edge, headless, driven over the DevTools protocol with exact device
// emulation (window sizes alone can't go below ~500 px on some platforms). Used for layout checks; tests skip when no
// browser is found. Override with JARC_TEST_BROWSER=<path to chrome/msedge>.
const { spawn } = require("child_process");
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

async function launch(executable = findBrowser()) {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "jarc-browser-"));
  const proc = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 100 && !target; i += 1) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { await sleep(100); }
  }
  if (!target) { proc.kill(); throw new Error("The headless browser didn't start."); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (event) => { const msg = JSON.parse(event.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
  const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  await send("Page.enable");
  return {
    send,
    // Sets an exact CSS viewport; phones (< 768 px) also get touch input, like a real phone.
    async viewport({ width, height = 800 }) {
      const mobile = width < 768;
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      await send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
      await send("Emulation.setEmitTouchEventsForMouse", { enabled: mobile, configuration: "mobile" });
    },
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
    async key(key, code = key) {
      for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: key === "Escape" ? 27 : 0 });
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
    async close() { try { ws.close(); } catch { /* already closed */ } proc.kill(); await sleep(200); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* browser still holds files */ } }
  };
}

module.exports = { findBrowser, launch, sleep, freePort };
