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
| `http://127.0.0.1:3000/?storage=api` | API (development) | the server, through `GET/PUT /api/v1/state` |

The frontend does not use the resource endpoints yet.

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
| POST | `/api/v1/imports[?dryRun=true]` | Development migration of a state document or browser backup; all or nothing, refuses repeats |

IDs are 24-character strings (`id`); dates are ISO 8601. Errors always use
`{ "error": { "code": "...", "message": "...", "details"? } }`. Unknown `/api` paths return a JSON 404.

## Temporary parts

- `MemoryStateRepository` keeps the state **in server memory only**. Restarting the server clears it.
- `GET/PUT /api/v1/state` saves the whole document at once with no authentication. It stays until the frontend moves
  to the resource endpoints. It is disabled when `NODE_ENV=production`.
- The resource API has no sign-in yet. Microsoft Entra authentication and per-workspace permissions come later.
