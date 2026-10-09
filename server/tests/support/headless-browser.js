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
    // Opens a file at an exact CSS viewport width and waits for its stylesheets.
    async open(file, { width, height = 800 }) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 768 });
      await send("Page.navigate", { url: "file:///" + file.split(path.sep).join("/") });
      for (let i = 0; i < 50; i += 1) { if (await this.evaluate("document.readyState === 'complete' && [...document.styleSheets].length > 0")) break; await sleep(50); }
    },
    async evaluate(expression) {
      const res = await send("Runtime.evaluate", { expression, returnByValue: true });
      if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || "evaluate failed");
      return res.result?.result?.value;
    },
    async close() { try { ws.close(); } catch { /* already closed */ } proc.kill(); await sleep(200); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* browser still holds files */ } }
  };
}

module.exports = { findBrowser, launch };
