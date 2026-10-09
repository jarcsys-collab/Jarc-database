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
```

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
