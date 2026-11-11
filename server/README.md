# JARC Database server

Node.js/Express server for JARC Database. One process serves:

- the existing frontend from `../site` at `/`
- the JSON API under `/api/v1`

Same origin, so the browser needs no CORS configuration. Only this server talks to MongoDB; the browser never does.

## Run locally

```sh
cd server
npm install
npm start          # http://127.0.0.1:3000/  (memory mode, no database)
npm test           # all backend tests; no database or network needed
npm run test:keep  # the same, also saving the full output to tests/.diagnostics/run-<time>.txt (last 10 kept)
```

A browser test that fails leaves `tests/.diagnostics/<time>-<file>-<test>/` with a screenshot, the page's HTML, its recent
console messages and uncaught errors, and the error (`JARC_TEST_DIAGNOSTICS=0` turns that off). The folder is ignored by Git.

`npm run dev` restarts on file changes. Settings: copy `.env.example` to `.env` (never commit `.env`).

### Data stores

| `DATA_STORE` | What it does |
|---|---|
| `memory` (default) | Stage 9 behaviour: transitional `GET/PUT /api/v1/state` kept in server memory (cleared on restart). |
| `mongodb` | Connects to MongoDB with the official driver, creates missing collections and indexes, and (outside production) serves the pre-auth resource API. Needs `MONGODB_URI` and `MONGODB_DB_NAME`. |

`MONGODB_DB_NAME` must be exactly `jarc_database`. The Atlas cluster is shared with another application, so any
other name (or a connection string whose path names another database) stops the server at startup. The connection
string is never logged or returned by the API.

## Storage modes in the browser

| URL | Mode | Where data is saved |
|---|---|---|
| `http://127.0.0.1:3000/` | LOCAL (default) | this browser's localStorage, exactly as before |
| `http://127.0.0.1:3000/?storage=api` | API (transitional) | server memory, through `GET/PUT /api/v1/state` |
| `http://127.0.0.1:3000/?storage=resource` | RESOURCE (development, needs `DATA_STORE=mongodb`) | MongoDB, through the resource endpoints below |

The modes never share data, and nothing is copied from one to another. In resource mode the browser loads workspaces,
then board summaries, then records page by page (200 per request) for the board being opened: up to 2,000 records
load at once, larger boards show "Load more". Saves send only what changed, with each item's expected version; a 409
loads the latest server copy instead of overwriting. Per-user state (selection, settings, favourites, last view,
recent items, local contacts) stays in that browser. Restoring a backup is disabled in resource mode.

## Endpoints

| Method and path | Purpose |
|---|---|
| `GET /api/v1` | API name and version |
| `GET /api/v1/health` | Liveness. With MongoDB it adds `"database": "connected" \| "unavailable"` (still 200; `status` becomes `degraded`). |
| `GET /api/v1/health/ready` | Readiness: 200 when the database answers, 503 `SERVICE_UNAVAILABLE` when it doesn't. |
| `GET /api/v1/state` | **Transitional, development only.** The saved state document, or `null` |
| `PUT /api/v1/state` | **Transitional, development only.** Replaces the state document (validated, 10 MB limit) |

### Resource API (`DATA_STORE=mongodb`)

Who is calling depends on `AUTH_MODE`:

| `AUTH_MODE` | Identity | Where |
|---|---|---|
| `dev` (default outside production) | the fixed "Local developer (pre-auth)" user, treated as a JARC administrator; responses carry `X-JARC-Auth: development-pre-auth` | development and tests only — refused in production |
| `entra` | Microsoft Entra ID sign-in, then a JARC server session (HttpOnly cookie); needs `DATA_STORE=mongodb` | **required in production**; the server won't start without it and every required `ENTRA_*` value |

Sign-in uses only the standard `openid profile email` scopes of the existing SPA registration — no custom API
permission, no client secret. The browser gets a single-use nonce (`POST /api/v1/auth/sign-in/start`, tied to an
HttpOnly cookie), signs in at Microsoft (authorization code + PKCE) and sends the ID token once to
`POST /api/v1/auth/session`. The server verifies it against the tenant's published keys — RS256 signature, issuer,
audience (the SPA client ID), tenant, version 2.0, expiry/not-before, issued within 10 minutes, the nonce, the user's
`oid` — and refuses access tokens and app-only tokens (401). Email and name in the request body are never trusted.

The session cookie `__Host-jarc_session` is `Secure; HttpOnly; SameSite=Strict; Path=/`; MongoDB stores only a
SHA-256 hash of it, bound to the tenant + object ID (re-checked on every request). Sessions end after `SESSION_IDLE_MINUTES` idle (default 30) and
`SESSION_MAX_HOURS` (default 8), or at sign-out (`POST /api/v1/auth/sign-out`); signing in again replaces the old
session. Requests that change data (POST/PUT/PATCH/DELETE) need the session's `X-CSRF-Token` header and an
`Origin` matching `ENTRA_REDIRECT_URI`. Users are created on first sign-in, keyed by tenant + object ID (email is
display-only); a disabled user gets 403 `ACCOUNT_DISABLED` and their session ends.

### Access policy (`ACCESS_POLICY`)

| Value | Who can do what |
|---|---|
| `role_based` (default; also when unset, empty or unrecognised) | The workspace roles below and the `JARC.Admin` app role. |
| `development_shared` | **Development collaboration.** Every signed-in employee of the configured tenant can create workspaces and acts as WORKSPACE_ADMIN in every workspace: see, create, edit and delete boards, columns, groups and records, edit and delete workspaces, move boards. New workspaces are visible to everyone at once (they live in MongoDB). |

`development_shared` changes only who may do what after sign-in. Microsoft sign-in, the session cookie, CSRF, the
tenant/audience/issuer/expiry checks and disabled-account lockout all still apply, and these stay restricted:
imports (`JARC.Admin` only) and membership changes (a real WORKSPACE_ADMIN membership or `JARC.Admin`), so nothing
granted by the shared policy outlives it. The server logs a warning at startup while it is on; signed-in responses
(`/auth/session`, `/me`) report `accessPolicy` and `canCreateWorkspaces`.

**Switching back to role-based access before production rollout**
1. Set `ACCESS_POLICY=role_based` (or remove the variable) and redeploy. No data migration is needed.
2. From then on employees see only workspaces they are members of; `JARC.Admin` holders see all.
3. Each workspace created during shared development has its creator as WORKSPACE_ADMIN; everyone else needs to be added.
   A `JARC.Admin` (or that creator) adds members with `POST /api/v1/workspaces/:id/members`. Review
   `workspaceMembers` and assign `JARC.Admin` in Entra (Enterprise applications → Users and groups) first, so every
   workspace has the right admins.
4. Data, boards and records are unchanged; activity history keeps the real employee who made each change.

## Search index and slow-request log

| Setting | Values | Effect |
|---|---|---|
| `RECORD_SEARCH_INDEX` | `off` (default), `shadow`, `on` | `off` writes nothing. `shadow` keeps the `recordSearch` collection current and compares it with the regular search, logging only counts. `on` answers plain searches from it once it has caught up (searches with status, priority or assignee filters stay on the records). The collection is derived from `records` and rebuilt by the catch up at start; `records` is never written. |
| `SLOW_REQUEST_MS` | milliseconds, default `2000`, `0` turns it off | Logs slower API requests: method, route pattern, status and time only. |
| `MONGO_SLOW_COMMAND_MS` | milliseconds, default `500` (at least 1) | MongoDB commands at least this slow are listed on System Health: command and collection name, time, result. Never a filter or a document. |

## System Health, Integration Reliability and Activity History (JARC administrators)

The **System Health** page (sidebar, shown only to people with the JARC.Admin role; the server checks the role on every
request and answers 403 to anyone else) reads two read-only endpoints:

| Endpoint | What it returns |
|---|---|
| `GET /api/v1/admin/system-health` | Backend and MongoDB status (ping time), API requests by **route pattern** (count, average, p50, p95, p99, server-error rate), slowest and failing endpoints, a per-minute trend for the last hour, recent errors (500s, 403s, 413s, 429s) with their request ID, slow MongoDB commands, monday.com and Google Drive health (last success, last failure and its code, retries, time-outs, rate limits, recent history), and background jobs (monday.com jobs, Excel/CSV imports, the search index, and — for Google Drive administrators only — the attachment import's runs). |
| `GET /api/v1/admin/activity` | The audit trail (`activities`), newest first: `q` (summary or field name), `action` (`record.updated`, or a prefix such as `record.`), `actor` (name), `boardId`, `from`, `to` (ISO dates), `limit` (1–100, default 50) and `before` (the `next` cursor of the previous page). Values of fields whose names look like secrets are shown as `[redacted]`; long values are cut to 200 characters. |

How it works and what it keeps:

- Every API response carries **`X-Request-Id`** (the caller's own when it is 8–64 letters, digits, `.`, `_` or `-`; otherwise a new
  one). It is written into server log lines for errors, into new activity entries (`requestId`), and listed with recent errors, so
  one failure can be followed from the browser to the log and the audit trail. Browser errors carry it as `error.requestId`.
- Figures are kept **in memory with fixed limits** (200 route patterns × 200 recent timings, 2,000 overall timings, 50 recent
  errors, 50 slow commands, 60 one-minute buckets, 50 history entries per integration) and reset when the server restarts.
  Nothing new is written to MongoDB: there is no new collection and no new index.
- Recorded: route patterns, status and error codes, durations, MongoDB command and collection names, integration status and
  reason codes. Never: URLs as sent, query strings, request or response bodies, cookies, tokens, names or record values.
- The monday.com and Google Drive clients already retried with backoff (only where safe: reads, resumable upload chunks) and
  time out; they now also report each attempt. Their behaviour is unchanged.
- Activity History is a view of the existing append-only `activities` collection; there is still no API to change or delete
  entries, and the identity in each entry comes from the signed-in session, never from the request.

### Account Management (`ACCOUNT_MANAGEMENT`, Phases M4.3–M4.4A)

| Value | Effect |
|---|---|
| `off` (default) | Unchanged behaviour. |
| `staged` (observation mode; allowed in production) | New sign-ins are recorded as **pending** accounts; the Super Admin reviews people in **Settings → Account Management** and records roles and workspaces. Roles and pending status are **not enforced** (`ACCESS_POLICY` / `JARC_BETA_OPEN_EDITING` still decide access, and the page says so). Blocking applies immediately. |
| `enforced` (refused at startup in production until separately approved) | Account roles decide access: Super Admin (every workspace, account management), Admin (manages assigned workspaces), Editor (edits assigned workspaces), Viewer (reads assigned workspaces). Membership roles are capped by the account role. Pending accounts reach nothing but their own session. `development_shared` and beta open editing are **ignored**; the `JARC.Admin` app role alone grants nothing. Users who signed in before Account Management ("not reviewed") keep exactly their membership roles until reviewed. |

`JARC_SUPER_ADMIN_TENANT_ID` + `JARC_SUPER_ADMIN_OBJECT_ID` (optional `JARC_SUPER_ADMIN_EMAIL`) name the intended first
Super Admin. Being configured grants nothing: that person signs in with exactly these verified Entra claims **and** the
`JARC.Admin` app role, then claims the role once with a typed confirmation. Every account change is recorded in
`accountAudit`. See `monday-migration/m43-account-management.md` for the transition plan.

Permissions per workspace: **VIEWER** reads; **MEMBER** edits boards, records, columns (add/rename), groups and views;
**WORKSPACE_ADMIN** also deletes or retypes columns, removes options, archives/deletes/moves boards, edits the
workspace and manages members; **SYSTEM_ADMIN** (the `JARC.Admin` app role) creates and deletes workspaces and
imports data. Not a member → 404; not allowed → 403. Every check uses the stored resource's workspace.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/auth/config` | Public: sign-in settings for the browser (tenant, SPA client ID, authority, scopes, redirect URI) |
| POST | `/api/v1/auth/sign-in/start` | Public: a single-use sign-in nonce (10 minutes) |
| POST | `/api/v1/auth/session` | Public: `{ idToken }` → verified → session cookie + `{ user, isSystemAdmin, csrfToken, expiresAt }` |
| GET | `/api/v1/auth/session` | The current session (user, CSRF token, expiry) |
| POST | `/api/v1/auth/sign-out` | Ends the session and clears the cookie |
| GET | `/api/v1/me` | The signed-in user, admin flag and workspace roles |
| GET / POST | `/api/v1/workspaces/:workspaceId/members` | List (any member) / add an existing user by `userId` or exact `email` (admins) |
| PATCH / DELETE | `/api/v1/workspaces/:workspaceId/members/:memberId` | Change role / remove (admins); the last admin can't be demoted or removed |

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/api/v1/workspaces` | POST: `{ name, description?, icon?, color?, position? }` |
| GET / PATCH / DELETE | `/api/v1/workspaces/:workspaceId` | PATCH needs `expectedVersion`; DELETE needs `?expectedVersion=` and cascades |
| GET / POST | `/api/v1/workspaces/:workspaceId/boards` | POST: `{ name, columns?, groups?, savedViews?, ... }` |
| GET / PATCH / DELETE | `/api/v1/boards/:boardId` | DELETE cascades to the board's records |
| GET / POST | `/api/v1/boards/:boardId/records` | GET: `limit` (1–200, default 50), `cursor`, `sort` (`position`\|`createdAt`\|`updatedAt`), `dir`, `groupId`, `status`, `archived` |
| GET / PATCH / DELETE | `/api/v1/records/:recordId` | PATCH `{ expectedVersion, values?, groupId?, position?, archived?, pinned? }`; a stale version → 409 |
| POST | `/api/v1/boards/:boardId/records/batch` | Create up to 5,000 records in one transaction (CSV import, duplicate board, undo) |
| PATCH | `/api/v1/boards/:boardId/records` | `{ items: [{ id, expectedVersion, ...changes }] }` — bulk edits and reorders; one stale version → 409, nothing written |
| POST | `/api/v1/boards/:boardId/records/delete` | `{ records: [{ id, expectedVersion }] }` — multi-delete; already-deleted records are skipped |
| POST | `/api/v1/boards/:boardId/columns` | Add a column (`index`, `copyFrom` to duplicate); existing records are filled in the same transaction |
| DELETE | `/api/v1/boards/:boardId/columns/:key` | Delete a column and its values (`?expectedVersion=&dryRun=`) |
| POST | `/api/v1/boards/:boardId/columns/:key/type` | Change type; values converted with the app's rules (`?dryRun=true` → `{ affected }`) |
| PUT | `/api/v1/boards/:boardId/columns/:key/options` | Rename/remove options; values that used them are rewritten (`?dryRun=true`) |
| DELETE | `/api/v1/boards/:boardId/groups/:groupId` | Delete a group, moving its records (`?expectedVersion=&moveTo=<groupId>|none`) |
| POST | `/api/v1/boards/:boardId/move` | Move a board (and its records) to another workspace |
| GET | `/api/v1/boards/:boardId/activity` | Board history, newest first (`limit` ≤ 200). Read-only |
| POST | `/api/v1/imports[?dryRun=true]` | Development migration of a state document or browser backup; all or nothing, refuses repeats |

Labels, column order, visibility, widths, adding/renaming groups and saved views use `PATCH /api/v1/boards/:boardId`.
Board lists include `recordCount` (active records).

IDs are 24-character strings (`id`); dates are ISO 8601. Errors always use
`{ "error": { "code": "...", "message": "...", "details"? } }`. Unknown `/api` paths return a JSON 404.

## Microsoft sign-in in the browser (resource mode, `AUTH_MODE=entra`)

Open `http://localhost:3000/?storage=resource` (use `localhost`, not `127.0.0.1`: it must match the registered
redirect URI). The page reads `GET /api/v1/auth/config`, loads MSAL Browser from this server
(`/vendor/msal-browser.min.js`, pinned, no CDN) and shows **Sign in with Microsoft**. After Microsoft's sign-in page
(authorization code flow with PKCE, your organization's accounts only) the app returns to the same URL, exchanges the
ID token for a JARC session once, clears MSAL's cache and only then loads data. After that the browser holds no
token: the session cookie is sent automatically and changes carry the CSRF token (same origin only). A refresh keeps
you signed in until the session ends; an expired session or disabled account gets its own screen. Sign-out ends the
JARC session, signs out of Microsoft and returns to the sign-in page.

Required on the existing SPA registration: the redirect URI (`http://localhost:3000/` locally, the https production
URL later) under **Single-page application**, with both implicit-grant boxes (access tokens, ID tokens) left
unchecked — authorization code + PKCE returns the ID token from the token endpoint — and the `JARC.Admin` app role
(assigned to JARC administrators) under **App roles**. No API permission beyond Microsoft Graph `openid`, `profile`,
`email` is needed (MSAL also adds `offline_access`); no client secret, certificate or exposed API scope. Entra only
puts `email` in a member's ID token when the `email` optional claim is added under **Token configuration**; without
it JARC shows `preferred_username` (usually the work address) instead.
Local mode (`/`) and `?storage=api` keep the temporary sign-in.

## Temporary parts

- `MemoryStateRepository` keeps the state **in server memory only**. Restarting the server clears it.
- `GET/PUT /api/v1/state` (TRANSITIONAL) saves the whole document at once with no authentication. Resource mode no
  longer needs it; it stays until resource mode replaces API mode everywhere. It is disabled when `NODE_ENV=production`.
- `AUTH_MODE=dev` is for local development only (no Microsoft sign-in; the temporary browser sign-in is used).

## Google Drive attachment storage

Off unless `GOOGLE_DRIVE_ENABLED=true`: while off, no Google code runs and its routes don't exist. Code: `integrations/google-drive/` and `routes/google-drive.js`.

- **People:** employees sign in with Microsoft, and JARC checks their workspace role on every request as it does for any attachment. They never need a Google account, and no Google token or Drive ID reaches a browser.
- **Bytes and metadata:** new files go to Drive. The `attachments` document keeps the original name, type, size, SHA-256, uploader, record and `storage: { provider: "gdrive", key: <Drive file ID> }`. In Drive a file is named `<attachment ID>.<ext>`.
- **Existing files:** read from wherever their document says. Nothing is moved.
- **Scope:** only `drive.file`. It can't reach folders or files JARC didn't create, so JARC creates and uses its own folder, "JARC Attachments". Service accounts can't own files, so this is a normal Google account connected by OAuth.
- **Who sees and who manages:** every signed-in employee sees the Google Drive card with its state (Connected, Not connected, Reconnect required, Unavailable). Only the people whose Entra object IDs are in `GOOGLE_DRIVE_ADMIN_OIDS`, within `ENTRA_TENANT_ID`, can connect, reconnect, test or disconnect it. Only they see the Google account, the folder and error details. The server checks this on every management request and again on the return from Google. `JARC.Admin` alone doesn't grant it, and an empty list means nobody. Attachments themselves follow the usual record permissions.
- **Connecting:** a Google Drive administrator, on the Integrations page, with the account in `GOOGLE_DRIVE_ACCOUNT_EMAIL`. The OAuth state is single use, valid for 10 minutes, and bound to the provider, the session and the browser. Nothing is saved until a test file has been written, read back and removed.
- **Tokens:** the refresh token is encrypted (AES-256-GCM, `GOOGLE_DRIVE_TOKEN_KEY`) in `integrations`. Replacing that key means reconnecting; files aren't affected. If Google refuses the token, the connection shows "Reconnect required" and Drive attachments answer 503 until it's reconnected.
- **Removing:** moves the file to Google Drive Trash, marked `jarcKind: removed`, so a file restored there is never removed again by the sweep. It doesn't return to the record by itself: find it by the attachment ID in the activity log. Google empties Trash on its own schedule.
- **Disconnecting:** JARC forgets the token, and only revokes it at Google while no attachment is stored in Drive. Google says revoking removes everything granted to the project, and doesn't say `drive.file` access to existing files returns afterwards. So don't remove JARC's access in the Google account, or delete the Cloud project, while Drive holds attachments. Connecting and **Test connection** check a sample of existing files and warn if any can't be reached.
- **Publishing status:** the OAuth client must be **In production** in Google Cloud. In Testing, refresh tokens with this scope expire after 7 days. Reconnect once after changing it.
- **Migration:** the monday.com migration refuses `gdrive` as a target.

To turn it on:

1. Add `https://<JARC address>/api/v1/integrations/google-drive/callback` to the OAuth client's Authorized redirect URIs.
2. Set `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REDIRECT_URI`, `GOOGLE_DRIVE_TOKEN_KEY`, `GOOGLE_DRIVE_ACCOUNT_EMAIL` and `ATTACHMENTS_GDRIVE_MAX_TOTAL_MB`, plus `GOOGLE_DRIVE_ADMIN_OIDS` (your Entra object ID: Entra admin center → Users → your profile → Object ID), then `GOOGLE_DRIVE_ENABLED=true`.
3. As a Google Drive administrator, choose **Connect Google Drive** on the Integrations page. New attachments still go to the current store.
4. When it has been checked, set `ATTACHMENTS_STORE=gdrive`. Setting it back only affects new uploads; files already in Drive stay readable as long as Google Drive stays enabled.

## Machine Installation Database attachment import (temporary)

The monday.com records migration (M5) left the board's files on monday.com. This one-off import moves them into Google Drive, onto the records they belong to (`services/mid-attachment-run.js`, `routes/mid-attachments.js`; the file writer it shares with the migration tool is `files/migration-writer.js`). It runs **inside the server**, because only the server holds the Google Drive connection.

- **Switched on only for the import:** while `MID_ATTACHMENTS_MIGRATION` is unset, its routes don't exist and its worker does nothing. When it's set, it also needs `MID_MIGRATION_MONDAY_TOKEN`, a monday.com token that can read the board (a secret), plus `GOOGLE_DRIVE_ENABLED=true`. `MID_MIGRATION_CONCURRENCY` (1–3, default 2) sets how many files run at once. Remove all three when the import is done.
- **Who:** only Google Drive administrators (`GOOGLE_DRIVE_ADMIN_OIDS`), from the Integrations page. `JARC.Admin` alone isn't enough. Every endpoint is checked on the server.
- **The plan:** `node server/scripts/mid-attachments-plan.js` builds it from the Git-ignored local migration files, into `monday-migration/mid-attachments-plan.json`. It contains real file names, so it never belongs in Git. The administrator uploads it on the Integrations page, and the server checks every entry against production. Its SHA-256 names the run (`mid-…`).
- **Steps, each started by hand:**
  1. **Dry run:** read-only. It checks the record, the item mapping, the Files column and any existing attachment, plus Google Drive and JARC capacity, and optionally that monday.com still has every file at the expected size (about 80 seconds for 6,000 files). It runs in the background: the request returns a check ID at once and the page shows its progress. The result is kept in server memory only, for 2 hours, one dry run at a time.
  2. **Prepare:** from a completed dry run less than an hour old, with nothing blocked. It records the run and one entry per file in the background. Repeating it, or finishing one a restart interrupted, adds nothing; an existing prepared run is kept as it is.
  3. **Start the 20-file pilot, then the full run** (the full run is refused until a pilot has finished with at least one file imported). Each start needs an explicit confirmation and enough storage, and records a read-only snapshot of the board's records, item mappings, attachments and storage use, which Verify compares against. No database backup is required. You can pause, resume or stop at any time.
  - **What "enough storage" means:** Google Drive's free space comes from the account's actual quota as Google reports it at that moment (`about.storageQuota`), whatever plan the account has, never from an assumed size. It must cover what's still to import plus a margin (256 MB, or 5% if larger). Separately, JARC's own `ATTACHMENTS_GDRIVE_MAX_TOTAL_MB` must leave room for what's still to import, counting everything already stored in Drive. Each file also reserves its size against that limit before it's stored.
  4. **Verify:** a read-only reconciliation of the attachments, mappings and the run's Drive files, comparing size and SHA-256, plus re-downloading a sample.
  5. **Roll back**, typing `ROLLBACK <run>` to confirm: this run's Drive files go to Trash, and its attachments, asset mappings and storage counters are removed. Nothing else changes.
- **Each file:** the server gets a fresh download link from monday.com and reads the file to exactly the inventoried size, computing its SHA-256. The migration's own writer then stores it with a pre-generated Drive ID, so it can't be duplicated, and verifies it. The file is tagged `jarcKind: mig` and `jarcRun` in Drive, so the sweep never touches it.
  - **Temporary problems** retry with backoff, up to 5 attempts.
  - **A full or disconnected Drive, or a refused monday.com token,** pauses the run.
  - **Permanent problems,** such as a missing record or a file gone from monday.com, fail that file only.
- **What's kept:** original names (JFIF names too, served as JPEG), HEIC as download-only, and CSV as download-only. Records are never written.

- **A file whose content isn't the type its name says** (monday.com infers the type from the name, so a JPEG saved as `photo.png` is planned as PNG): the bytes' signature decides. When they are another accepted *image* type, the file is stored as that type, named with its real extension (`photo.jpg`), with the original name in `imported.originalName` and `imported.typeCorrection: { declaredType, detectedType, originalName }`. Content that matches no accepted type, or a different kind (a "PNG" that is really a PDF, CSV or HTML), is still refused with `UNSUPPORTED_FILE_TYPE`. The upload guard checks the bytes against the type they are stored as, so validation is unchanged.
- **One failed file** of a finished (completed, paused or stopped) run, from its row on the Integrations page:
  - **Inspect** (`GET …/runs/<run>/items/<asset>/inspect`): read-only. It downloads the file from monday.com and reports its size, SHA-256, the type its name implied, the type its content shows, and whether a retry would pass the type check. It writes nothing.
  - **Retry this file** (`POST …/runs/<run>/items/<asset>/retry`, typing `RETRY <asset>` to confirm): only a failed file, only when no other file of the run is waiting. That file goes back in line and the run runs with an allowance of exactly one, then ends completed again. Files already imported are not touched. The failed attempt's leftover document, and any Drive object under its old ID, are removed before the file is stored under a new one, and the unique indexes (one attachment per source asset, one mapping per asset) make a second copy impossible. The first failure stays on the item as `previousError`.
## Search index, forms and imports

**Search index** (`RECORD_SEARCH_INDEX`, `services/record-search-index.js`). With `on`, global and board search, including status, priority and assignee filters, answer from the `recordSearch` collection, once a catch up has verified it complete. A failed update takes it out of use until it has been repaired and verified again; until then search answers from the records. `node scripts/search-index.js verify|rebuild --target local --db <db>` checks or repairs it (production verify is read-only; a production rebuild needs `--confirm-production`).

**Forms** (`routes/forms.js`, `services/form-service.js`). Internal only: every route needs a signed-in session and the usual workspace role. Admins design forms, members submit them, and a submission is an ordinary record change. No public form exists, and a definition can't create one.

**Excel and CSV imports** (`routes/imports.js`, `services/import-job-service.js`, `services/workbook-runner.js`, `workers/workbook-worker.js`, `domain/spreadsheet.js`, `domain/workbook-structure.js`). A guided wizard makes a **new board** from a file, such as a monday.com export. Up to 25 MB and 100,000 rows; a wide file reaches the 25 MB limit first (about 40,000 rows at 84 columns). Files are read and every row is checked on a worker thread, so the app stays responsive. Imported columns are text unless chosen otherwise, which keeps IDs, leading zeros and dates as written. A file with an unclear structure needs a person's decision before it can start. The job is paced for Atlas Flex, resumes after a restart, and every row has a fixed `legacyId`, so an interrupted batch can run again without repeating a row. A file's rows are kept in `importBatches` only until its job ends (7 days at most if abandoned). `.xls` and password-protected workbooks are refused. Importing into an existing board is refused until a safe undo exists. A new board can be removed again through the import, in paced batches, as long as nobody has changed it.

## Optional features

Each has its own switch. Only `true` or `false` are accepted; anything else stops startup. Unset means **off in production** and on elsewhere.

| Variable | Feature | Production default |
| --- | --- | --- |
| `JARC_FEATURE_FORMS` | Native forms | off |
| `JARC_FEATURE_IMPORTS` | Excel and CSV import wizard (new boards only) | off |

While a feature is off:

- **API:** its routes aren't mounted, so every path answers `404` like an unknown path, including for administrators and direct API calls. Without a session the answer stays `401`.
- **Screens:** the Forms button and the Excel and CSV import option are hidden. The browser asks `GET /api/v1/features`, and shows nothing if it can't tell.
- **Background work:** the import worker doesn't run. An unfinished import waits, for as long as its uploaded rows are kept (7 days).
- **Database:** its collections and indexes aren't created at startup. Forms and imports already stored are kept and return when the feature is on again.

The existing browser import of CSV and JSON files (up to 5,000 rows) is not part of this switch.

**Who may import:** JARC's usual rules: a signed-in session and the MEMBER role in the workspace, the same as creating a board. With `ACCESS_POLICY=development_shared` or `JARC_BETA_OPEN_EDITING=true`, that means every signed-in employee, in every workspace.

## API tokens

Other systems (Power BI, Power Automate, n8n, Excel, scripts) read JARC through a read-only API with a token. It is off in every environment until switched on.

| Variable | Values | Effect |
|---|---|---|
| `JARC_FEATURE_API_TOKENS` | `true` or `false`, default off | While off, the paths don't exist, the Developer Center (profile menu → Developer) and the board and column API items are hidden, and nothing is added to the database. Needs `AUTH_MODE=entra`. |
| `JARC_API_TOKEN_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Required when on | Tokens are stored as digests keyed with this secret. Replacing it ends every existing token. |
| `JARC_API_TOKEN_RATE_PER_MINUTE` | 10 to 6000, default 120 | Requests per minute for each token, counted per server process. |

Switching it on creates the `apiTokens` and `apiTokenAudit` collections and the `board_id` index on `records`.

**Who may create or rotate a token:** only its owner, with their own active membership of the workspace at any role (`VIEWER` and above, after any enforced account-role cap): a read-only token never reads more than that membership already can. The boards are always chosen explicitly, and a board created later is never added to an existing token. An owner can always revoke their own token while signed in, whatever their current role and even with no membership left, and nobody can revoke another person's token. `ACCESS_POLICY=development_shared`, `JARC_BETA_OPEN_EDITING`, the `JARC.Admin` app role and the Super Admin account role don't qualify.

**What a token can do:** read the boards chosen for it, in one workspace, for at most 366 days. Each request also checks the owner: if they are disabled, blocked or no longer a member, the token stops at once. An owner who stays a member with a lower role keeps read access through the token, and can still rotate it. Columns hidden on the board are returned, because hiding isn't a permission; JARC has no column-level permissions. Archived workspaces, boards and records need `includeArchived=true`.

Management, with a session and CSRF: `GET /api/v1/me/api-tokens`, `GET /api/v1/me/api-tokens/options`, `POST /api/v1/me/api-tokens`, `POST /api/v1/me/api-tokens/:id/rotate`, `POST /api/v1/me/api-tokens/:id/revoke`.

Reading, with `Authorization: Bearer <token>` only: `GET /api/v1/external/` + `me`, `workspaces`, `workspaces/:id/boards`, `boards/:id`, `boards/:id/columns`, `boards/:id/columns/:columnId`, `boards/:id/columns/:columnId/values`, `boards/:id/groups`, `boards/:id/records` (with `?columns=a,b`), `boards/:id/records/:recordId/columns/:columnId`, `records/:id`.

**Board and column IDs:** a board's API ID is its existing ID, and a column's is its existing `key`, unique on its board. Neither changes when something is renamed, reordered, hidden or moved, or when a column's type changes, so existing boards need no migration. IDs are identifiers, not secrets. Deleting a column records its key on the board (`retiredColumns`), and that key can't go to another column; undo may restore the same column, with the same type, within 24 hours. Columns deleted before this existed left no record, but JARC generates a random key for each new column, so they can only be reused by a direct API call that names the old key.

**Record IDs:** a record's permanent ID is its existing `_id` (no migration, no second ID field). Boards on the server show it as a read-only **Record ID** column (not "Item ID", because imported and migrated boards can have their own *Item ID* business column, such as monday.com item numbers or codes like BH-112…, which stay ordinary columns). The row menu offers **Copy Record ID** and **API Information** (`GET /api/v1/external/records/:id`). It doesn't change on rename, edit, group move or reorder, and a deleted record's ID is never reused. **Moving a record to another board creates a new Record ID**: the move is a delete and a create. Sorting and exact search use the reserved key `__record_id` in `orderBy` and filters (`{ key: "__record_id", cmp: "in", values: [ids] }`); no column may use that key.

Full usage, with Power BI, Power Automate, n8n, JavaScript and cURL examples, is in JARC under **Developer → Documentation** (profile menu). **Developer → Boards & Columns** lists every board's and column's API ID and address, the board and column menus have **API Information**, and the API Explorer previews responses through the person's own session (`GET /api/v1/me/api-explorer/boards/:boardId`). Tokens belong in a secure backend or approved secret store, never in public JavaScript.

## Limits on large selections

Nothing processes part of a selection without saying so.

| Action | Limit | Past the limit |
| --- | --- | --- |
| Export from the toolbar | None. Every record of the view, read page by page | A failure partway downloads nothing and says so |
| Export from the selection bar | Every selected record, including any a later search hides | Not applicable |
| Select all | 5,000 records | Nothing is selected. A message gives the count and the limit, and points to Export |
| Shift-click a range on a partly loaded board | The rows loaded so far | A message says rows still loading aren't included |
| Duplicating or deleting a group with its records on a large board | Not available | Refused with a message; nothing changes |
| `POST` and `PATCH` record batches in the API | 5,000 per request, in one transaction | Refused with `400` |
| Browser import of CSV or JSON | 5,000 rows | Refused before anything is written |
| Excel and CSV import wizard | New boards only; 100,000 rows, 25 MB | Refused before anything is written |

## Search cutover

The search index (`RECORD_SEARCH_INDEX=on`) is the intended implementation. Reading record cells directly remains only as a temporary recovery path: search uses it whenever the index isn't verified, and `RECORD_SEARCH_INDEX=off` selects it as the rollback. Remove that path, and the shadow comparison, once production has been verified on the index.

1. Keep `RECORD_SEARCH_INDEX=shadow` until the cutover is approved.
2. Confirm the index matches the records, read-only: `node server/scripts/search-index.js verify --target production --railway-stdin`. It must report 0 missing, 0 stale and 0 extra.
3. Check the logs for `[search-index] shadow difference`. A difference within seconds of an edit is normal, because the index updates just after a save. Anything else needs explaining first.
4. Set `RECORD_SEARCH_INDEX=on`. Railway restarts the service; search keeps answering from the records until the log says `[search-index] on: ready`.
5. Verify global search, search on a large board, filtered views, and a search after an edit and after a deletion.

**Rollback:** set `RECORD_SEARCH_INDEX=shadow`. Search answers from the records right after the restart. Records are never changed by the index, so no data needs restoring. `recordSearch` can be rebuilt at any time.
