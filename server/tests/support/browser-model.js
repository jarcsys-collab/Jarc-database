// TEST-ONLY: loads the unchanged browser files (StorageService.js, ResourceApiAdapter.js, BoardModel.js) into an
// isolated context with the few browser globals they use, so tests can drive the real frontend model in Node.
const fs = require("fs"), path = require("path"), vm = require("vm");

const ASSETS = path.resolve(__dirname, "..", "..", "..", "site", "assets");

function memoryStorage() {
  const store = new Map();
  return { store, getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } };
}

// Returns { window, events, localStorage, newModel(options) } — each newModel() is one "browser tab" sharing the
// same localStorage unless a separate one is passed.
function loadBrowser({ localStorage = memoryStorage() } = {}) {
  const events = [];
  const window = { location: { search: "" }, localStorage, sessionStorage: memoryStorage(), dispatchEvent: (e) => { events.push(e); }, addEventListener() {} };
  const context = vm.createContext({
    window, console, URLSearchParams, AbortController, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  });
  for (const file of ["ResourceApiAdapter.js", "StorageService.js", "BoardModel.js"]) vm.runInContext(fs.readFileSync(path.join(ASSETS, file), "utf8"), context, { filename: file });
  const newResourceModel = ({ baseUrl, fetchImpl = (...args) => fetch(...args), timeoutMs = 5000 } = {}) => {
    const adapter = new window.ResourceApiAdapter({ baseUrl, fetch: fetchImpl, timeoutMs });
    const storage = new window.StorageService(adapter);
    return new window.BoardModel(storage);
  };
  return { window, events, localStorage, newResourceModel };
}

module.exports = { loadBrowser, memoryStorage };
