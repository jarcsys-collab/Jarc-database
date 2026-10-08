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

### Resource API — DEVELOPMENT / PRE-AUTH ONLY (`DATA_STORE=mongodb`, not production)

No authentication or authorization exists yet. These routes are not mounted when `NODE_ENV=production`, and every
change is attributed to a fixed development user, "Local developer (pre-auth)". Responses carry the header
`X-JARC-Auth: development-pre-auth`.

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

## Temporary parts

- `MemoryStateRepository` keeps the state **in server memory only**. Restarting the server clears it.
- `GET/PUT /api/v1/state` (TRANSITIONAL) saves the whole document at once with no authentication. Resource mode no
  longer needs it; it stays until resource mode replaces API mode everywhere. It is disabled when `NODE_ENV=production`.
- The resource API has no sign-in yet. Microsoft Entra authentication and per-workspace permissions come later.
