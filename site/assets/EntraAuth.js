// Microsoft Entra ID sign-in for resource mode (Stage 12C), using MSAL Browser (authorization code flow with PKCE).
//
// Used only when the page runs with ?storage=resource AND the server reports AUTH_MODE=entra (GET /api/v1/auth/config).
// Local mode, the transitional /state mode and AUTH_MODE=dev keep the temporary AuthModel sign-in.
//
//   page load  → GET /api/v1/auth/session: a valid JARC session (HttpOnly cookie)? → signed in (MSAL isn't even loaded)
//   sign in    → POST /api/v1/auth/sign-in/start (a single-use nonce tied to this browser)
//              → MSAL redirect to Microsoft: scopes openid profile email only, with that nonce
//   returning  → MSAL handles the response (PKCE) → the ID token is sent ONCE to POST /api/v1/auth/session, where the
//                server verifies it (signature, issuer, audience, tenant, freshness, nonce) and sets the session cookie
//              → MSAL's cache is cleared, the original URL (e.g. ?storage=resource) restored
//   sign out   → POST /api/v1/auth/sign-out, then Microsoft's sign-out page, back to JARC's sign-in page
//
// No access token, client secret or custom API permission is involved. Tokens are never logged or kept.
class EntraAuth {
  static LIBRARY_URL = "/vendor/msal-browser.min.js";
  static RETURN_KEY = "jarc-auth-return";          // where to come back to after Microsoft (path + query)
  static SIGNED_OUT_KEY = "jarc-auth-signed-out";  // set before a Microsoft sign-out redirect
  static SCOPES = Object.freeze(["openid", "profile", "email"]);

  constructor(config, adapter, { location = window.location, history = window.history, session = window.sessionStorage } = {}) {
    this.config = config;
    this.adapter = adapter;
    this.location = location;
    this.history = history;
    this.session = session;
  }

  // The storage mode for a page that is the landing point of a Microsoft redirect (sign-in response at the redirect
  // URI, or the page after sign-out), which arrives without the original ?storage=resource.
  static pendingReturnMode(location = window.location, session = window.sessionStorage) {
    try {
      const target = session.getItem(EntraAuth.RETURN_KEY);
      if (!target) return null;
      const returning = EntraAuth.isRedirectResponse(location) || session.getItem(EntraAuth.SIGNED_OUT_KEY) === "1";
      return returning ? new URL(target, location.origin).searchParams.get("storage") : null;
    } catch { return null; }
  }
  static isRedirectResponse(location = window.location) { return /(^|[#&?])(code|error)=/.test(`${location.hash}${location.search}`); }

  // Loads the MSAL library from this server once (a test can provide window.msal beforehand).
  static loadLibrary(doc = document) {
    if (window.msal) return Promise.resolve(window.msal);
    return new Promise((resolve, reject) => {
      const script = doc.createElement("script");
      script.src = EntraAuth.LIBRARY_URL;
      script.onload = () => (window.msal ? resolve(window.msal) : reject(new Error("Microsoft sign-in library didn't load.")));
      script.onerror = () => reject(new StorageError(StorageError.CODES.SERVICE_UNAVAILABLE, "Microsoft sign-in couldn't be loaded. Check your connection, then try again."));
      doc.head.appendChild(script);
    });
  }

  async msalApp() {
    if (this.app) return this.app;
    const msal = await EntraAuth.loadLibrary();
    this.app = new msal.PublicClientApplication({
      auth: {
        clientId: this.config.clientId,
        authority: this.config.authority,           // single tenant: https://login.microsoftonline.com/<tenant>
        redirectUri: this.config.redirectUri,
        navigateToLoginRequestUrl: false            // JARC restores the original URL itself
      },
      cache: { cacheLocation: "sessionStorage" },
      system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } }
    });
    await this.app.initialize();
    return this.app;
  }

  // Back from Microsoft: put the original path and query (e.g. ?storage=resource) back in the address bar.
  restoreReturnUrl() {
    let target = null;
    try {
      target = this.session.getItem(EntraAuth.RETURN_KEY);
      this.session.removeItem(EntraAuth.RETURN_KEY);
      this.session.removeItem(EntraAuth.SIGNED_OUT_KEY);
    } catch { /* session storage blocked: the URL stays as it is */ }
    if (!target) return;
    const url = new URL(target, this.location.origin);
    if (url.origin === this.location.origin && `${this.location.pathname}${this.location.search}` !== `${url.pathname}${url.search}`) {
      this.history.replaceState(null, "", `${url.pathname}${url.search}`);
    }
  }
  returningFromSignOut() { try { return this.session.getItem(EntraAuth.SIGNED_OUT_KEY) === "1"; } catch { return false; } }
  rememberReturnUrl() {
    try { this.session.setItem(EntraAuth.RETURN_KEY, `${this.location.pathname}${this.location.search}`); } catch { /* best effort */ }
  }

  // Microsoft's sign-in page (organizational accounts of the configured tenant only), with a server-issued nonce.
  async signIn() {
    const { nonce } = await this.adapter.http.request("POST", "/auth/sign-in/start");
    this.rememberReturnUrl();
    const app = await this.msalApp();
    await app.handleRedirectPromise(); // clears any interaction left over from an earlier attempt
    return app.loginRedirect({ scopes: [...EntraAuth.SCOPES], nonce, prompt: "select_account" });
  }

  // Finishes a sign-in after Microsoft's redirect: the ID token goes to the server once, then MSAL's cache is cleared.
  async completeSignIn() {
    const app = await this.msalApp();
    let result = null;
    try { result = await app.handleRedirectPromise(); }
    finally { this.restoreReturnUrl(); }
    const idToken = result?.idToken;
    try { await app.clearCache?.(); } catch { /* best effort: the session cookie is what JARC uses from now on */ }
    if (!idToken) return null;
    return this.adapter.http.request("POST", "/auth/session", JSON.stringify({ idToken }));
  }

  // Ends the JARC session, then signs out of Microsoft and returns to JARC's sign-in page in the same storage mode.
  async signOut() {
    try { await this.adapter.http.request("POST", "/auth/sign-out"); } catch { /* already signed out or expired */ }
    this.adapter.useCsrfToken(null);
    this.rememberReturnUrl();
    try { this.session.setItem(EntraAuth.SIGNED_OUT_KEY, "1"); } catch { /* best effort */ }
    this.location.assign(`${this.config.authority}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(this.config.redirectUri)}`);
  }

  // Resource-mode startup. Returns { mode: "dev" } (temporary sign-in as before) or, in Entra mode,
  // { mode: "entra", entra, state: "signed-out" | "denied" | "error" | "signed-in", me? }. Protected data is only requested once a
  // server session exists.
  static async prepare(adapter) {
    const config = await adapter.http.request("GET", "/auth/config");
    if (config?.mode !== "entra") return { mode: "dev" };
    const entra = new EntraAuth(config, adapter);
    let session = null;
    try {
      if (EntraAuth.isRedirectResponse(entra.location)) session = await entra.completeSignIn();
      else {
        if (entra.returningFromSignOut()) entra.restoreReturnUrl(); // back from Microsoft sign-out: restore ?storage=…
        session = await adapter.http.request("GET", "/auth/session");
      }
    } catch (error) {
      // Microsoft returned an error or the sign-in was cancelled: offer to try again.
      if (!(error instanceof StorageError)) return { mode: "entra", entra, state: "error" };
      if (error.code === StorageError.CODES.ACCOUNT_DISABLED || error.code === StorageError.CODES.FORBIDDEN) return { mode: "entra", entra, state: "denied" };
      if (error.code !== StorageError.CODES.UNAUTHENTICATED) throw error;
    }
    if (!session) return { mode: "entra", entra, state: "signed-out" };
    adapter.useCsrfToken(session.csrfToken);
    adapter.setAccount(session.user.id);
    return { mode: "entra", entra, state: "signed-in", me: session };
  }
}

// The signed-in Microsoft user, in the shape the controller already uses for the temporary sign-in.
class EntraSession {
  constructor(entra, me) {
    this.entra = entra;
    this.authenticated = true;
    this.username = me.user.displayName || me.user.email || "Signed-in user";
    this.email = me.user.email || "";
    this.isSystemAdmin = Boolean(me.isSystemAdmin);
    this.lockedScreen = false; this.error = ""; this.lockSeconds = 0; this.attemptsRemaining = 5; this.sessionMinutesRemaining = 0;
  }
  touch() {}
  checkTimeout() { return false; } // the server enforces idle and absolute session expiry
  lock() { this.authenticated = false; } // back to the Microsoft sign-in screen
  logout() { this.authenticated = false; return this.entra.signOut(); }
}

window.EntraAuth = EntraAuth;
window.EntraSession = EntraSession;
