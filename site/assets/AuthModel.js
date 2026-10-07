// TEMPORARY FRONTEND-ONLY ACCESS SCREEN — NOT SECURITY.
// The sign-in check below runs entirely in the browser: the expected values ship inside this public file and the
// "signed in" flag is a browser-storage entry, so anyone can read or bypass it. It must not protect real or shared data.
// Replace with server-side authentication (planned: Microsoft Entra ID via the backend) before production use.
// Do not add further credentials, secrets or environment variables here.
class AuthModel {
  constructor(storage = window.jarcStorage) {
    this.storage = storage; // per-device preferences + temporary session values via StorageService (Stage 6)
    this.username = "medtek";
    this.password = "123";
    this.error = "";
    this.failedAttempts = Number(this.storage.getSessionValue("failedAttempts") || 0);
    this.lockedUntil = Number(this.storage.getSessionValue("lockedUntil") || 0);
    this.rememberedUsername = this.storage.getPreference("rememberedUsername") || "";
    this.lastLogin = this.storage.getPreference("lastLogin") || "";
    this.lockedScreen = this.storage.getSessionValue("screenLocked") === "1";
    this.authenticated = !this.lockedScreen && (this.storage.getPreference("persistentSignIn") === "active" || this.storage.getSessionValue("signIn") === "active");
    this.lastActivity = Number(this.storage.getSessionValue("lastActivity") || Date.now());
    this.timeoutMinutes = 30;
  }

  login(username, password, rememberSession, rememberUsername) {
    if (Date.now() < this.lockedUntil) {
      this.error = `Too many attempts. Try again in ${this.lockSeconds} seconds.`;
      return false;
    }
    if (username === this.username && password === this.password) {
      this.authenticated = true;
      this.lockedScreen = false;
      this.error = "";
      this.failedAttempts = 0;
      this.lockedUntil = 0;
      this.storage.removeSessionValue("screenLocked");
      this.storage.setSessionValue("failedAttempts", "0");
      this.storage.removeSessionValue("lockedUntil");
      if (rememberSession) {
        this.storage.setPreference("persistentSignIn", "active");
        this.storage.removeSessionValue("signIn");
      } else {
        this.storage.setSessionValue("signIn", "active");
        this.storage.removePreference("persistentSignIn");
      }
      rememberUsername ? this.storage.setPreference("rememberedUsername", username) : this.storage.removePreference("rememberedUsername");
      this.rememberedUsername = rememberUsername ? username : "";
      this.lastLogin = new Date().toISOString();
      this.storage.setPreference("lastLogin", this.lastLogin);
      this.touch();
      return true;
    }
    this.failedAttempts += 1;
    this.storage.setSessionValue("failedAttempts", String(this.failedAttempts));
    const remaining = Math.max(0, 5 - this.failedAttempts);
    this.error = `Username or password is incorrect. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`;
    if (this.failedAttempts >= 5) {
      this.lockedUntil = Date.now() + 30000;
      this.storage.setSessionValue("lockedUntil", String(this.lockedUntil));
      this.failedAttempts = 0;
      this.storage.setSessionValue("failedAttempts", "0");
      this.error = "Sign-in paused for 30 seconds after repeated attempts.";
    }
    return false;
  }

  touch() {
    if (!this.authenticated) return;
    this.lastActivity = Date.now();
    this.storage.setSessionValue("lastActivity", String(this.lastActivity));
  }

  checkTimeout() {
    if (!this.authenticated) return false;
    if (Date.now() - this.lastActivity < this.timeoutMinutes * 60000) return false;
    this.lock("Your session was locked after 30 minutes of inactivity.");
    return true;
  }

  lock(message = "Workspace locked. Sign in to continue.") {
    this.authenticated = false;
    this.lockedScreen = true;
    this.error = message;
    this.storage.setSessionValue("screenLocked", "1");
  }

  logout() {
    this.authenticated = false;
    this.lockedScreen = false;
    this.error = "";
    this.storage.removePreference("persistentSignIn");
    this.storage.removeSessionValue("signIn");
    this.storage.removeSessionValue("screenLocked");
  }

  get lockSeconds() { return Math.max(0, Math.ceil((this.lockedUntil - Date.now()) / 1000)); }
  get attemptsRemaining() { return Math.max(0, 5 - this.failedAttempts); }
  get sessionMinutesRemaining() { return Math.max(0, Math.ceil((this.timeoutMinutes * 60000 - (Date.now() - this.lastActivity)) / 60000)); }
}

window.AuthModel = AuthModel;
