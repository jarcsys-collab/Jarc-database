class AuthModel {
  constructor() {
    this.username = "medtek";
    this.password = "123";
    this.error = "";
    this.failedAttempts = Number(sessionStorage.getItem("medtek-failed-attempts") || 0);
    this.lockedUntil = Number(sessionStorage.getItem("medtek-locked-until") || 0);
    this.rememberedUsername = localStorage.getItem("medtek-remembered-username") || "";
    this.lastLogin = localStorage.getItem("medtek-last-login") || "";
    this.lockedScreen = sessionStorage.getItem("medtek-screen-locked") === "1";
    this.authenticated = !this.lockedScreen && (localStorage.getItem("medtek-auth-session") === "active" || sessionStorage.getItem("medtek-auth-session") === "active");
    this.lastActivity = Number(sessionStorage.getItem("medtek-last-activity") || Date.now());
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
      sessionStorage.removeItem("medtek-screen-locked");
      sessionStorage.setItem("medtek-failed-attempts", "0");
      sessionStorage.removeItem("medtek-locked-until");
      if (rememberSession) {
        localStorage.setItem("medtek-auth-session", "active");
        sessionStorage.removeItem("medtek-auth-session");
      } else {
        sessionStorage.setItem("medtek-auth-session", "active");
        localStorage.removeItem("medtek-auth-session");
      }
      rememberUsername ? localStorage.setItem("medtek-remembered-username", username) : localStorage.removeItem("medtek-remembered-username");
      this.rememberedUsername = rememberUsername ? username : "";
      this.lastLogin = new Date().toISOString();
      localStorage.setItem("medtek-last-login", this.lastLogin);
      this.touch();
      return true;
    }
    this.failedAttempts += 1;
    sessionStorage.setItem("medtek-failed-attempts", String(this.failedAttempts));
    const remaining = Math.max(0, 5 - this.failedAttempts);
    this.error = `Username or password is incorrect. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`;
    if (this.failedAttempts >= 5) {
      this.lockedUntil = Date.now() + 30000;
      sessionStorage.setItem("medtek-locked-until", String(this.lockedUntil));
      this.failedAttempts = 0;
      sessionStorage.setItem("medtek-failed-attempts", "0");
      this.error = "Sign-in paused for 30 seconds after repeated attempts.";
    }
    return false;
  }

  touch() {
    if (!this.authenticated) return;
    this.lastActivity = Date.now();
    sessionStorage.setItem("medtek-last-activity", String(this.lastActivity));
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
    sessionStorage.setItem("medtek-screen-locked", "1");
  }

  logout() {
    this.authenticated = false;
    this.lockedScreen = false;
    this.error = "";
    localStorage.removeItem("medtek-auth-session");
    sessionStorage.removeItem("medtek-auth-session");
    sessionStorage.removeItem("medtek-screen-locked");
  }

  get lockSeconds() { return Math.max(0, Math.ceil((this.lockedUntil - Date.now()) / 1000)); }
  get attemptsRemaining() { return Math.max(0, 5 - this.failedAttempts); }
  get sessionMinutesRemaining() { return Math.max(0, Math.ceil((this.timeoutMinutes * 60000 - (Date.now() - this.lastActivity)) / 60000)); }
}

window.AuthModel = AuthModel;
