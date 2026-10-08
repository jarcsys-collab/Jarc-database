# JARC Database server

Node.js/Express server for JARC Database. One process serves:

- the existing frontend from `../site` at `/`
- the JSON API under `/api/v1`

Same origin, so the browser needs no CORS configuration.

## Run locally

```sh
cd server
npm install
npm start          # http://127.0.0.1:3000/
npm test           # API, validation and ApiAdapter tests (no database or network needed)
```

`npm run dev` restarts on file changes. Optional settings: copy `.env.example` to `.env` (never commit `.env`).

## Storage modes in the browser

| URL | Mode | Where data is saved |
|---|---|---|
| `http://127.0.0.1:3000/` | LOCAL (default) | this browser's localStorage, exactly as before |
| `http://127.0.0.1:3000/?storage=api` | API (development) | the server, through `GET/PUT /api/v1/state` |

The two modes never share data. API mode works only when the page is served by this server.

## Endpoints

| Method and path | Purpose |
|---|---|
| `GET /api/v1` | API name and version |
| `GET /api/v1/health` | `{ "status": "ok", "service": "jarc-database-api", "environment", "timestamp" }` |
| `GET /api/v1/state` | **Transitional, development only.** The saved state document, or `null` |
| `PUT /api/v1/state` | **Transitional, development only.** Replaces the state document (validated, 10 MB limit) |

Errors always use `{ "error": { "code": "...", "message": "..." } }`. Unknown `/api` paths return a JSON 404.

## Temporary parts (Stage 9)

- `MemoryStateRepository` keeps the state **in server memory only**. Restarting the server clears it. It is not
  production persistence.
- `GET/PUT /api/v1/state` saves the whole document at once with no authentication. It exists only to prove the
  browser's `ApiAdapter`. It is disabled when `NODE_ENV=production`.
- These are replaced by MongoDB-backed resource endpoints (`/api/v1/workspaces`, `/api/v1/boards`,
  `/api/v1/records`) with sign-in, permissions and per-record version checks in later stages.
