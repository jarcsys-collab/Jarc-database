// TEST-ONLY simulated MSAL Browser (the subset JARC uses). Runs in Node test contexts and, injected before page load,
// in a real browser. It never contacts Microsoft: "redirects" go straight back to the redirect URI, and the ID token
// for the requested nonce comes from a test token source (a local test key).
//
// Controls (window.__fakeMsal): setNextLogin({ oid, name, email, admin }), setFailure("none" | "error"),
// calls() — a log of MSAL calls without token values. idTokenSource({ person, nonce }) can be replaced by tests.
(function install(window) {
  const store = window.sessionStorage;
  const read = (key, fallback) => { try { const v = store.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
  const write = (key, value) => store.setItem(key, JSON.stringify(value));
  const log = (entry) => write("fake-msal-calls", [...read("fake-msal-calls", []), entry]);
  class BrowserAuthError extends Error { constructor(code) { super(code); this.name = "BrowserAuthError"; this.errorCode = code; } }

  class PublicClientApplication {
    constructor(config) {
      this.config = config;
      log({ call: "construct", clientId: config.auth.clientId, authority: config.auth.authority, redirectUri: config.auth.redirectUri, navigateToLoginRequestUrl: config.auth.navigateToLoginRequestUrl, cacheLocation: config.cache?.cacheLocation, keys: Object.keys(config.auth).sort() });
    }
    async initialize() { log({ call: "initialize" }); }
    async handleRedirectPromise() {
      const loc = window.location;
      const pending = read("fake-msal-pending", null);
      if (!/code=fake-code/.test(loc.hash) || !pending) { log({ call: "handleRedirectPromise", result: null }); return null; }
      store.removeItem("fake-msal-pending");
      window.history.replaceState(null, "", `${loc.pathname}${loc.search}`); // MSAL removes the response from the URL
      if (read("fake-msal-failure", "none") === "error") { log({ call: "handleRedirectPromise", result: "error" }); throw new BrowserAuthError("user_cancelled"); }
      write("fake-msal-cache", { account: pending.person.oid });
      const idToken = await window.__fakeMsal.idTokenSource(pending);
      log({ call: "handleRedirectPromise", result: "idToken" });
      return { account: { homeAccountId: `${pending.person.oid}.tenant`, username: pending.person.email, name: pending.person.name }, idToken, accessToken: "fake-graph-access-token-must-never-be-sent" };
    }
    async loginRedirect(request) {
      const person = read("fake-msal-next-login", null);
      log({ call: "loginRedirect", scopes: request.scopes, prompt: request.prompt, hasNonce: typeof request.nonce === "string" && request.nonce.length >= 32 });
      if (person) write("fake-msal-pending", { person, nonce: request.nonce });
      window.location.assign(`${this.config.auth.redirectUri}#code=fake-code&state=fake-state`);
    }
    async clearCache() { store.removeItem("fake-msal-cache"); log({ call: "clearCache" }); }
    async acquireTokenSilent() { log({ call: "acquireTokenSilent" }); throw new BrowserAuthError("not_used_by_jarc"); }
  }

  window.__fakeMsal = {
    setNextLogin: (person) => write("fake-msal-next-login", person),
    setFailure: (mode) => write("fake-msal-failure", mode),
    calls: () => read("fake-msal-calls", []),
    // Default for browser tests: the TEST-ONLY server mints an ID token for this nonce, signed with its local test key.
    idTokenSource: async ({ person, nonce }) => {
      const res = await window.fetch(`/__test/id-token?oid=${encodeURIComponent(person.oid)}&name=${encodeURIComponent(person.name)}&email=${encodeURIComponent(person.email)}&admin=${person.admin ? 1 : 0}&nonce=${encodeURIComponent(nonce)}`);
      return (await res.json()).token;
    }
  };
  window.msal = { PublicClientApplication, BrowserAuthError };
})(typeof window !== "undefined" ? window : globalThis.window);
