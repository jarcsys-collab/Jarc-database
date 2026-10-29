#!/usr/bin/env node
// Safe view of a Railway service's variables (Phase M4.2A). Pipe Railway's JSON into it; raw values never reach the
// terminal:
//
//   railway variables --service <JARC service> --environment production --json | node server/scripts/railway-variables-filter.js
//
// Prints every variable NAME. Values only for settings that are not secrets (access policy, beta flag, Entra tenant
// and client IDs, storage settings, Railway's own deployment metadata). MONGODB_URI is reduced to its scheme, host
// and database path; anything else is shown as "(set, hidden)".
"use strict";
const SHOW = new Set([
  "NODE_ENV", "DATA_STORE", "MONGODB_DB_NAME", "AUTH_MODE", "ACCESS_POLICY", "JARC_BETA_OPEN_EDITING",
  "ENTRA_TENANT_ID", "ENTRA_SPA_CLIENT_ID", "ENTRA_REDIRECT_URI", "ENTRA_ADMIN_ROLE", "SESSION_IDLE_MINUTES", "SESSION_MAX_HOURS",
  "ATTACHMENTS_MAX_TOTAL_MB", "ATTACHMENTS_STORE", "ATTACHMENTS_S3_REGION", "ATTACHMENTS_S3_FORCE_PATH_STYLE", "ATTACHMENTS_S3_MAX_TOTAL_MB", "ATTACHMENTS_MIGRATION_MAX_FILE_MB",
  "MONDAY_INTEGRATION_ENABLED", "MONDAY_API_VERSION", "HOST", "PORT",
  "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_SERVICE_NAME", "RAILWAY_PROJECT_NAME", "RAILWAY_PUBLIC_DOMAIN", "RAILWAY_GIT_BRANCH", "RAILWAY_GIT_COMMIT_SHA", "RAILWAY_GIT_REPO_NAME", "RAILWAY_GIT_REPO_OWNER"
]);
const SECRETISH = /SECRET|PASSWORD|TOKEN|KEY|PRIVATE|CREDENTIAL|SIGNING|COOKIE/i;

function summarize(vars) {
  const out = [];
  for (const name of Object.keys(vars).sort()) {
    const value = String(vars[name] ?? "");
    if (name === "MONGODB_URI") {
      const m = /^(mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^/?#]+)(\/[^?#]*)?/i.exec(value);
      out.push([name, m ? `${m[1]}://<credentials hidden>@${m[2]}${m[3] && m[3] !== "/" ? m[3] : ""}` : "(set, not a mongodb address)"]);
    } else if (SHOW.has(name) && !SECRETISH.test(name)) out.push([name, value]);
    else out.push([name, value ? "(set, hidden)" : "(empty)"]);
  }
  return out;
}

if (require.main === module) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { raw += c; });
  process.stdin.on("end", () => {
    let vars;
    try { vars = JSON.parse(raw); } catch { process.stdout.write("Input is not Railway's JSON output (use --json). Nothing was printed.\n"); process.exitCode = 2; return; }
    if (!vars || typeof vars !== "object" || Array.isArray(vars)) { process.stdout.write("Unexpected input shape. Nothing was printed.\n"); process.exitCode = 2; return; }
    for (const [k, v] of summarize(vars)) process.stdout.write(`${k} = ${v}\n`);
  });
}
module.exports = { summarize, SHOW };
