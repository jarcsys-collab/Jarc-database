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
then board summaries, then records for the board being opened: up to 2,000 records load at once (pages of 1,000),
larger boards start with a page of 200 and load the rest as needed. Saves send only what changed, with each item's
expected version; a 409 loads the latest server copy instead of overwriting. Per-user state (selection, settings,
favourites, last view, recent items, local contacts) stays in that browser. Restoring a backup is disabled in resource mode.

**Saved copies of boards (Microsoft sign-in only; `site/assets/BoardCache.js`).** A board loaded completely (≤ 2,000
records) is kept in the browser's IndexedDB, per signed-in JARC user, as the server last confirmed it (never an unsaved
edit; no tokens, cookies, comments or file contents). After a reload it is shown at once, marked "Showing the copy saved
in this browser · checking for changes…", and replaced by the server's copy through the live-update path (no save is
overwritten; a cell being edited is redrawn only when the person leaves it). A copy is used only after the server has
confirmed the session and listed the board for that person, and only if the board's version is unchanged. Other people's
copies are deleted when someone signs in, all copies on sign-out or a refused account, copies of boards no longer listed
when the board list loads; copies expire after 3 days and are bounded (40 MB, 40 boards, least recently used first).
IndexedDB unavailable or failing: boards load from the server as before. `localStorage["jarc-board-cache"] = "off"`
switches it off in one browser. In memory, at most 20 boards / 30,000 records stay loaded (least recently opened are let
go of and load again when opened). The open board is read again every 60 s only while live updates are disconnected.
Timings: `window.jarcPerf.entries` (`board-open` with its source — memory, saved copy, server — and `board-refresh`).

**Board numbers and links (`src/domain/board-public-id.js`).** Every board has a public number (`publicId`, from 100001) for
its link: `/boards/100001`. It is allocated once from an atomic counter (`counters._id = "boardPublicId"`, `$inc`) when the
board is inserted (any path: app, monday.com integration, imports), unique (`boards` index `uniq_board_public_id`, partial),
never changed by rename, move or archive, never reused, never accepted from a client. The board's `_id` stays its identity
everywhere else (records, permissions, API tokens, `/api/v1/external`, caches). The browser resolves a number only among the
boards the server listed for that person; older links by `_id` keep working and are rewritten to the number in place. Boards
from before numbers existed get theirs from `scripts/board-public-ids.js` (`plan` read-only; `apply`, idempotent; production
needs `--confirm-production` and its own approval); until then their links use the `_id`. The board API adds `publicId`.

**Keyboard shortcuts (`site/assets/KeyboardShortcuts.js`).** One registry (key, Mac/Windows labels, context, availability,
handler) behind `AppController.onKeydown` and the list shown with `?`; Quick search (Ctrl/⌘ B) over the boards already
listed. Grid keys stay in `AppController.cellKey`, copy/cut/paste in the clipboard events. A shortcut does nothing — and the
key is left to the browser — while typing, while an input method composes, behind a dialog, or where its action isn't possible.

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

The `JARC.Admin` app role is read at sign-in and kept for the session's life. For the sensitive administrator writes
(Account Management under `/accounts`, the monday.com integration's changes, and Employee Management access and membership
changes while `ACCOUNT_MANAGEMENT` isn't `enforced`), a session whose administrator sign-in is older than 60 minutes gets
403 `REAUTH_REQUIRED`: the session stays valid, and signing in again re-reads the role from Microsoft. Reads and ordinary
requests are never affected. `GET /api/v1/auth/session` reports `adminFreshUntil` for a session carrying the role; the app
shows "For security, sign in again to continue this administrator action." with a **Sign in again** button. Under the
same rule, a session carrying the claim is also asked to sign in again for workspace member changes and the legacy state
import (`POST /api/v1/imports`), even when the person acts through a real Workspace admin membership: a known, accepted side
effect; sessions without the claim are never affected.

Each sign-in also records whether the `JARC.Admin` role was present (`users.adminRoleSeenAt` / `adminRoleClearedAt`; the first
sign-in records it either way). This is what JARC saw at the person's **last sign-in**, never a live Microsoft Entra check.
Employee Management Suspend / Revoke and Account Management Block of someone whose JARC access is active are refused, for every
administrator, when the person is a **recognised JARC administrator** (409 `TARGET_JARC_ADMIN`: an active Super Admin, the
configured `JARC_SUPER_ADMIN_*` identity, or the role seen at their last sign-in or in a live session) or when that status is
**unknown** (409 `ADMIN_STATUS_UNKNOWN`: no sign-in recorded since this check was introduced and no live session; the person
signs in to JARC once, or IT disables them in Microsoft Entra ID). `error.details.basis` names the reason. The record **never
expires**: it is cleared only by a later sign-in without the role, so a leaver whose role was removed in Entra and who never
signs in again stays protected. A Super Admin can only be demoted while another usable Super Admin (account active and JARC
access active) remains. No operation (membership removal or demotion, Suspend, Revoke, Block) may leave a workspace without a
usable Workspace admin.

The live-update stream (`GET /api/v1/events`) fails closed: if its periodic access re-read or session check fails, or the
session's `JARC.Admin` claim, the JARC access status or the account changed, the stream ends and the browser reconnects.

### Access policy (`ACCESS_POLICY`)

| Value | Who can do what |
|---|---|
| `role_based` (default; also when unset or empty) | The workspace roles below and the `JARC.Admin` app role. |
| `development_shared` | **Development collaboration.** Every signed-in employee of the configured tenant can create workspaces and acts as WORKSPACE_ADMIN in every workspace: see, create, edit and delete boards, columns, groups and records, edit and delete workspaces, move boards. New workspaces are visible to everyone at once (they live in MongoDB). |

Any other `ACCESS_POLICY` value (another spelling, case or surrounding spaces) **stops startup** with a configuration error
naming the allowed values, so a typo can never switch shared access on or off silently. `JARC_BETA_OPEN_EDITING` is parsed the
same way: `true` turns it on; unset, empty or `false` leave it off; anything else stops startup.

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
`accountAudit`. Blocking an account (or, under `enforced`, giving it a role below Admin) is refused with 409
`LAST_USABLE_WORKSPACE_ADMIN`, naming the workspaces, when it would leave a workspace without a usable Workspace admin. See `monday-migration/m43-account-management.md` for the transition plan.

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
| GET / POST | `/api/v1/boards/:boardId/records` | GET: `limit` (1–1000, default 50; at most 200 with `filter`, `orderBy`, `q` or `group`), `cursor`, `sort` (`position`\|`createdAt`\|`updatedAt`), `dir`, `groupId`, `status`, `archived` |
| GET / PATCH / DELETE | `/api/v1/records/:recordId` | PATCH `{ expectedVersion, values?, groupId?, position?, archived?, pinned? }`; a stale version → 409 |
| POST | `/api/v1/boards/:boardId/records/batch` | Create up to 5,000 records in one transaction (CSV import, duplicate board, undo) |
| PATCH | `/api/v1/boards/:boardId/records` | `{ items: [{ id, expectedVersion, ...changes }] }` — bulk edits and reorders; one stale version → 409, nothing written |
| POST | `/api/v1/boards/:boardId/records/delete` | `{ records: [{ id, expectedVersion }] }` — multi-delete; already-deleted records are skipped |
| POST | `/api/v1/boards/:boardId/columns` | Add a column (`index`, `copyFrom` to duplicate); existing records are filled in the same transaction |
| DELETE | `/api/v1/boards/:boardId/columns/:key` | Delete a column and its values (`?expectedVersion=&dryRun=`) |
| POST | `/api/v1/boards/:boardId/columns/:key/type` | Change type `{ expectedVersion, type, multiple?, previewToken? }`; only when lossless on every record, else `400 CONVERSION_REFUSED` (see below; `?dryRun=true` → `{ dryRun, affected, ...counts, previewToken }`) |
| PUT | `/api/v1/boards/:boardId/columns/:key/options` | Rename/remove options; values that used them are rewritten (`?dryRun=true`) |
| DELETE | `/api/v1/boards/:boardId/groups/:groupId` | Delete a group, moving its records (`?expectedVersion=&moveTo=<groupId>|none`) |
| POST | `/api/v1/boards/:boardId/move` | Move a board (and its records) to another workspace |
| GET | `/api/v1/boards/:boardId/activity` | Board history, newest first (`limit` ≤ 200). Read-only |
| POST | `/api/v1/imports[?dryRun=true]` | Development migration of a state document or browser backup; all or nothing, refuses repeats |

Labels, column order, visibility, widths, adding/renaming groups and saved views use `PATCH /api/v1/boards/:boardId`.
Board lists include `recordCount` (active records).

**Column display settings** (`settings`, optional, G3 / D12). Display only: stored values never change, and sorting, filters,
search, CSV export (raw stored values) and every API keep the raw value. One allow-listed shape per type, checked by the
registry shared with the browser (`site/assets/ColumnTypes.js` `cleanSettings`, through `domain/column-types.js`), at most
4 KB of JSON; unknown keys, wrong kinds and out-of-range values are `400 VALIDATION_ERROR`:
- number: `precision` (0–6; absent = automatic), `thousands` (default `true`), `prefix` / `suffix` (≤ 8 characters, no `<` `>`), `align` (`right` | `left`)
- date: `displayFormat` (`medium` "Mar 5, 2026" | `long` | `iso` | `dmy` | `mdy`), `weekday` (default `false`)
- text: `wrap` (default `false`, up to 3 lines); link: `display` (`url` | `text`: the address without `https://` / `www.`)

**Storage:** never inside `columns`. They are kept in the board's optional top-level field `columnSettings`
(`{ <column key>: <settings> }`, absent when no column has any), written in the same versioned update as the columns, and
merged into `columns[].settings` when the session API returns a board. An entry is used only if it fits the column's current
type, so an entry for a deleted column or for a column whose type changed is ignored (and dropped on the next column write).
Values equal to the default are not stored (no migration; existing boards are unchanged). `PATCH /boards/:id` with `columns`:
a column sent **without** `settings` keeps the stored ones (pages that don't know the field never erase it); `settings: null`
clears them; an object replaces them. `POST …/columns` accepts them (a duplicate gets the ones the page sends); a type change
keeps only the keys the new type defines; deleting a column removes its entry. The same permission as other column edits
(MEMBER; not on read-only synced boards). The external Board API, CSV export and the Fabric API don't expose them.
`GET /api/v1/features` has `columnSettings: true` (a capability of this version, not a switch); the browser sends `settings`
only when it is true, and if a write is refused it asks `/features` again and, when the server no longer has the capability,
sends the same write once more without them.

**Rollback procedure (G3):** redeploy the previous release (`3f51351`, or any later one); there is no data step. Releases
before G3 never read or write `columnSettings` and update boards field by field, so every board keeps working (edits, add /
duplicate / delete column, type changes; tested in `tests/column-settings-g3-rollback.test.js` against `3f51351` on the same
data), the settings simply aren't shown, and they show again when G3 is redeployed. Pages opened before the rollback stop
sending settings by themselves (above); a reload is enough otherwise. Only if the owner ever wants the settings gone (a data
change needing approval): `db.boards.updateMany({ columnSettings: { $exists: true } }, { $unset: { columnSettings: "" } })`.

**Column type changes** (`src/domain/column-conversion.js`, `BoardSchemaService.changeType`). A change is made only when it
is lossless on **every** record of the board (one column of every record is read; never loaded rows or a sample), and it is
checked again inside the transaction that writes. Otherwise nothing is written and the answer is `400 CONVERSION_REFUSED`
(`409` with `reason: "PREVIEW_STALE"`), whose message ends with **"Your data has not been changed."** and whose `details` are
`{ from, to, total, populated, convertible, incompatible, lossy, examples, reason, allowed: false, tooLarge, rewrites, limits }`:
- `reason`: `INCOMPATIBLE_VALUES`, `PEOPLE_REFERENCES` (People columns with values can't change type), `TOO_MANY_OPTIONS`
  (a Dropdown would need more than its option limit), `BOARD_TOO_LARGE` or `PREVIEW_STALE`.
- `lossy` counts values by cause: `truncatedMulti` (several entries → one; several-value Dropdown → one value, Status, Text…),
  `leadingZero` (`00123` → number), `longNumber` (more than 15 significant digits), `invalidDate`, `ambiguousDate`
  (`03/04/2026`), `tooManyOptions` (labels over the limit), `peopleReferences`.
- `examples`: at most 3 values that don't fit, masked (digits → 9, letters → a, at most 20 characters); never logged.
- Strict rules: **Number** accepts `-`, digits and one `.` only (no thousands separators, spaces, `+`, exponent or leading
  zeros, at most 15 significant digits); **Date** accepts real `YYYY-MM-DD` dates only; **Link / Email / Phone** use the value
  rules below; **Checkbox** accepts `true` / `yes` / `1` (ticked) and empty.
- **BOARD_TOO_LARGE:** boards with more than **2,000** records, or more than 2,000 values to rewrite, are refused (with their
  counts) until the resumable converter exists. Add a new column of the type you need instead.
- **Stale preview:** the dry run returns a `previewToken` over the board version and the column's values; sending it with the
  change refuses it (`409 PREVIEW_STALE`) if any value changed in between. A stale `expectedVersion` is `409 CONFLICT`.
- Refused before any value is read (`400 VALIDATION_ERROR`): the Item column, to or from Connect, Mirror, Files or Group.
  A duplicated column (`copyFrom`) must keep the original's type and one/several setting, and a Connect column's linked
  board (`link.boardId`) can't be changed once set.

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

**Who may manage tokens:** only the JARC API administrators, the Microsoft Entra object IDs in `JARC_API_ADMIN_OIDS` (comma-separated GUIDs, at most 20), matched within `ENTRA_TENANT_ID` against the identity verified at sign-in. Unset or empty means nobody (the startup log says how many are configured). They list every owner's tokens, see API Activity and the API Explorer, create and rotate tokens (rotating only their own) with read access to the workspace (`VIEWER` and above: under open access, every shared workspace, whoever created or imported its boards), and revoke anyone's token, which records who did it. Everyone else gets `403 API_ADMIN_REQUIRED` from every management route and keeps their normal access to boards. `ACCESS_POLICY=development_shared`, `JARC_BETA_OPEN_EDITING`, workspace roles, the `JARC.Admin` app role and the Super Admin account role don't make anyone an API administrator. The boards are always chosen explicitly, and a board created later is never added to an existing token.

**What a token can do:** read the boards chosen for it, in one workspace, until its expiry: at most 5 calendar years after it was created (in UTC; a token created on 29 February may last until 28 February). Tokens keep working if their owner stops being an API administrator, until they expire or are revoked. Each request also checks the owner: if they are disabled, blocked or no longer a member, the token stops at once. An owner who stays a member with a lower role keeps read access through the token, and can still rotate it. Columns hidden on the board are returned, because hiding isn't a permission; JARC has no column-level permissions. Archived workspaces, boards and records need `includeArchived=true`.

Management, with a session and CSRF, for API administrators only: `GET /api/v1/me/api-tokens`, `GET /api/v1/me/api-tokens/options`, `GET /api/v1/me/api-tokens/activity`, `POST /api/v1/me/api-tokens`, `POST /api/v1/me/api-tokens/:id/rotate`, `POST /api/v1/me/api-tokens/:id/revoke`.

Reading, with `Authorization: Bearer <token>` only: `GET /api/v1/external/` + `me`, `workspaces`, `workspaces/:id/boards`, `boards/:id`, `boards/:id/columns`, `boards/:id/columns/:columnId`, `boards/:id/columns/:columnId/values`, `boards/:id/groups`, `boards/:id/records` (with `?columns=a,b`), `boards/:id/records/:recordId/columns/:columnId`, `records/:id`.

**Board and column IDs:** a board's API ID is its existing ID, and a column's is its existing `key`, unique on its board. Neither changes when something is renamed, reordered, hidden or moved, or when a column's type changes, so existing boards need no migration. IDs are identifiers, not secrets. Deleting a column records its key on the board (`retiredColumns`), and that key can't go to another column; undo may restore the same column, with the same type, within 24 hours. Columns deleted before this existed left no record, but JARC generates a random key for each new column, so they can only be reused by a direct API call that names the old key.

**Record IDs:** a record's permanent ID is its existing `_id` (no migration, no second ID field). Boards on the server show it as a read-only **Record ID** column (not "Item ID", because imported and migrated boards can have their own *Item ID* business column, such as monday.com item numbers or codes like BH-112…, which stay ordinary columns). The row menu offers **Copy Record ID** and **API Information** (`GET /api/v1/external/records/:id`). It doesn't change on rename, edit, group move or reorder, and a deleted record's ID is never reused. **Moving a record to another board creates a new Record ID**: the move is a delete and a create. Sorting and exact search use the reserved key `__record_id` in `orderBy` and filters (`{ key: "__record_id", cmp: "in", values: [ids] }`); no column may use that key.

**Link, Email and Phone values** (`src/validation/record-values.js`). Every new write into a column of these types is checked on the server: record create, update and batches, form submissions, spreadsheet imports into an existing board and monday.com imports. Text and every other column type are not checked. A refusal is `400 VALIDATION_ERROR` with `details: { field, reason }` and a message naming the column; the value is never repeated in the message, the details or the log.
- **Link:** `http://` or `https://` URLs, also `mailto:` and `tel:`, or text without a scheme (`www.example.com` is stored as typed and isn't clickable until it has `https://`). Any other scheme is refused (`javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, `about:`, `ftp:`, …), including when it is disguised by case, leading spaces, tabs, new lines or other control characters, HTML entities, percent-encoding or full-width letters. Control and invisible characters are refused anywhere. At most 2,048 characters.
- **Email:** one address (`name@example.com`); a `mailto:` prefix is removed. **Phone:** digits, a leading `+`, spaces, `( ) - .` and an optional extension (`x 12`, `ext. 12`, `#12`); a `tel:` prefix is removed. Surrounding spaces are trimmed for all three.
- **Values stored before this rule are never changed or deleted.** They read back exactly as stored (the session API also lists such cells in `unsafeValues` where a route passes the board), and the app opens only `http`, `https`, `mailto` and `tel` links. Saving one again, even unchanged, is refused: replace or clear it. Other columns of the same edit are unaffected.
- **Token API:** values are returned exactly as stored, as before; the API builds no URL or link field from them. A **Connect** cell (record IDs of another board) is returned only when the linked board is one of the token's boards in a workspace its owner can read; otherwise the value is `null` and the record lists the column's ID (`columnId`, the column key) in `restricted` (a single cell has `restricted: true`), with no IDs and no count. A **Mirror** cell is worked out in JARC when it is shown and is never returned by the token API or the API Explorer: its value is always `null` (no stored placeholder), and it is not listed in `restricted`.

Full usage, with Power BI, Power Automate, n8n, JavaScript and cURL examples, is in JARC under **Developer → Documentation** (profile menu). **Developer → Boards & Columns** lists every board's and column's API ID and address, the board and column menus have **API Information**, and the API Explorer previews responses through the person's own session (`GET /api/v1/me/api-explorer/boards/:boardId`). Tokens belong in a secure backend or approved secret store, never in public JavaScript.

## Fabric Data (read-only sales and inventory data)

Two datasets from a **separate** MongoDB (Microsoft Fabric's), read only (`src/fabric/`): `sales` (the `FactSales` collection) and `inventory` (`FactInventory`). The names are a constant allow-list in `src/fabric/datasets.js`; no other collection in that database is ever named, listed, counted, queried or returned, and none is used for sign-in or permissions (those stay with Microsoft Entra ID and the OID lists below). Nothing lists collections. Each dataset returns only its verified fields, in the source's order (fields added upstream later are never returned). It is off in every environment until switched on. While off, none of the `FABRIC_*` variables are checked (they may be set), its paths don't exist, `/api/v1/features` doesn't mention it and no database client is created.

| Variable | Values | Effect |
|---|---|---|
| `JARC_FEATURE_FABRIC_DATA` | `true` or `false`, default off | Needs `AUTH_MODE=entra`. |
| `FABRIC_MONGODB_URI` | Required when on. `mongodb://` or `mongodb+srv://` | A secret: never logged or returned. Must not be `MONGODB_URI` or share a host with it, and may not name another database in its path. The login must have **only** the `read` role on the Fabric database: on first connect JARC checks `connectionStatus`, and any other role or action switches Fabric Data off (`FABRIC_UNSAFE_CREDENTIALS`) until the server restarts. |
| `FABRIC_MONGODB_DB_NAME` | Required when on. Letters, digits, `_`, `-` (at most 64) | Never `jarc_database` (or `MONGODB_DB_NAME`). Use the name exactly as it exists on the Fabric cluster. |
| `FABRIC_DATA_READER_OIDS` | Entra object IDs (GUIDs; commas, semicolons or spaces), at most 50 | Who may read Fabric Data (both datasets), within `ENTRA_TENANT_ID`. Empty: nobody. `JARC.Admin`, open access, beta open editing and workspace roles grant nothing here. |
| `FABRIC_DATA_COST_READER_OIDS` | GUIDs, at most 50; each must also be a reader | (Name kept for compatibility.) Who also sees the **sensitive financial and inventory fields**: sales `landed_cost`, and `Text`, `Custom`, `custom_1` and `Custom.2` until their business meaning is confirmed; inventory `Cost_Amount_Expected`, `Cost_Amount_Actual`, `Cost_Amount_Non_Invtbl`, their `_ACY` versions, `landed_cost`, `distributors_price` and `trade_price` (and, in the invoice views, cost, profit and margin). For everyone else they are never projected or returned, are left out of `/schema`, and naming one is refused exactly like a field that doesn't exist. `Sales_Amount_*` are not sensitive. |
| `FABRIC_API_ADMIN_OIDS` | GUIDs, at most 20; each must also be a reader | Who may issue and revoke Fabric API tokens (also needs `JARC_FEATURE_API_TOKENS=true`). |
| `FABRIC_API_RATE_PER_MINUTE` | 1 to 600, default 60 | Requests per minute for each Fabric API token. |
| `FABRIC_QUERY_TIME_MS` | 1000 to 30000, default 8000 | `maxTimeMS` of every Fabric query (a timeout is `503 FABRIC_TIMEOUT`). The driver also drops a socket silent for this + 2 s (`503 FABRIC_TIMEOUT`). |
| `FABRIC_POOL_SIZE` | 1 to 10, default 5 | Connections to the Fabric database. At most this − 1 (at least 1) Fabric operations run at once in the process; others wait up to 1 s, and each person or token may have at most 3 Fabric requests running. Beyond that: `503 FABRIC_BUSY` with `Retry-After`. A request waiting over 2 s for a pooled connection is also `FABRIC_BUSY`. |
| `FABRIC_MAX_WINDOW_ROWS` | 1000 to 200000, default 50000 | The most source rows one invoice list may group, and the most rows a records request with `q` or any filter other than `company` may look through (counted with the query's index over its date window and company; `422 FABRIC_RANGE_TOO_LARGE` above it). |
| `FABRIC_UNINDEXED_SCAN_MAX` | 0 to 50000, default 20000 | **Small-collection mode:** a dataset with at most this many documents (`estimatedDocumentCount`, from metadata, re-read right before every unindexed query) may be read without its index — still with `maxTimeMS`, an inclusion projection and a limit, sorted in memory over the projected fields only. Above it, a missing index is `503 FABRIC_INDEX_REQUIRED`. `0`: never without an index. (Today FactInventory, about 5,700 documents, is in this mode; FactSales is not.) |
| `FABRIC_INVOICE_VIEWS` | `true` or `false`, default `false` | Mounts the v1 invoice endpoints (`/invoices…`, grouping, totals, cost KPIs) on the **session** API until their business semantics are approved. Never under `/external/fabric`. |

**The Fabric database login (Atlas → Database Access):** give it the built-in role `read` on the Fabric database itself (Specific Privileges → `read@<FABRIC_MONGODB_DB_NAME>`). Atlas's "Only read any database" (`readAnyDatabase`), `readWrite`, `atlasAdmin`, custom roles and any second role are all refused as unsafe. The check runs once per process, on the first Fabric request: after changing the login's roles (either way), restart JARC.

The connection is made on the first Fabric request, apart from JARC's (its own pool, `secondaryPreferred`, no retryable writes), and is never part of `/api/v1/health/ready`: JARC starts and stays ready whether Fabric is reachable or not.

**Indexes:** JARC's reader can't create them. A query uses the index for its sort (`hint`); without it, a dataset above `FABRIC_UNINDEXED_SCAN_MAX` answers `503 FABRIC_INDEX_REQUIRED` before any query is sent, and `GET /api/v1/fabric/status` lists what's missing. The data owner creates (Atlas → Collections → … → Indexes; if the pipeline drops and reloads a collection, it must recreate them):

- FactSales `fabric_invoice_date`: `{ invoice_date: -1, Company: 1, invoice_id: 1, _id: 1 }` — sales records (exactly this one or its reverse) and the invoice list.
- FactSales `fabric_invoice_detail`: `{ Company: 1, invoice_id: 1, Line_No: 1, _id: 1 }` — the invoice views only (an invoice, its lines and a line).
- FactInventory `fabric_inventory_date`: `{ Posting_Date: -1, Company: 1, Entry_No: 1, _id: 1 }` — inventory records sorted by date.
- FactInventory `fabric_inventory_entry`: `{ Company: 1, Entry_No: 1, _id: 1 }` — inventory records sorted by entry number. Because this index isn't led by the date, `sort=entryNo` always needs `company` (`~` for none) and refuses `dateFrom` / `dateTo` (400): it lists one company in entry order (`/schema` says so per sort: `requiresCompany`, `dateRange`).

**Date window:** `dateFrom` / `dateTo` (UTC days, inclusive). Without them, the 30 days ending at the dataset's **latest date** (from the index, or one bounded aggregate in small mode; cached 60 s), or today when that isn't known. At most 92 days, except inventory in small mode, which may also be read with no dates at all (the whole collection, page by page). Inventory `Expiration_Date` values before 1900 (Business Central's blank `0001-01-01`) are returned as `null`.

Routes (GET/HEAD only, `Cache-Control: no-store`, 30 requests per 10 s per person), under `/api/v1/fabric` (session) and `/api/v1/external/fabric` (Fabric API token; the token's dataset scopes decide which datasets it reads, otherwise `403 INSUFFICIENT_SCOPE`):

- `GET /status` — per dataset: mode (`indexed`, `small` or `unavailable`), estimate, missing indexes, earliest and latest date.
- `GET /:dataset/schema` — fields (name, type, filterable, sortable, searchable), filters, sorts, default columns, date field, record key.
- `GET /:dataset/records` — `dateFrom`, `dateTo`, `company` (`~` = none), `q`, the dataset's filters (sales: `salesDataSource`, `salesType`, `customerId`, `invoiceNo`; inventory: `entryType`, `documentType`, `locationCode`, `itemNo`, `open`), `sort` (sales `date`; inventory `date`, `entryNo`), `dir`, `limit` (1–200, default 100), `cursor`, `fields` (default: the default columns). No totals. Cursors are signed with a key made when the server starts and bound to the dataset, window, filters, search, sort and direction: a changed, forged or pre-restart cursor is `400 VALIDATION_ERROR` ("start again from the first page").
- `GET /:dataset/records/:id` — every permitted field; `404 FABRIC_RECORD_NOT_FOUND` once the source has been refreshed.

`:dataset` is `sales` or `inventory`; anything else (another collection's name, `FactSales`, `Sales`, …) is the same `404 NOT_FOUND`, which never repeats the name. With `FABRIC_INVOICE_VIEWS=true` the session API also has `/invoices`, `/invoices/:company/:invoiceNo` (`~` = no company), `…/lines` and `…/lines/:lineId`; `/sales-lines` was replaced by `/sales/records`. Fabric paths and queries are never written to the server log. The pages `/fabric/inventory`, `/fabric/sales`, `/fabric/api` and `/fabric/{inventory|sales}/records/:id` (and `/fabric/invoices…` with the invoice views) serve the app while it's on.

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
