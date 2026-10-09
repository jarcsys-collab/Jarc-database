# JARC Database production image (Railway): one service serving the API (server/) and the frontend (site/).
#
# The repository root has no package.json, so buildpack detection (Nixpacks) finds no Node.js project and installs no
# node/npm. This Dockerfile pins the runtime instead. server/src/app.js serves ../../site, so both folders keep their
# repository layout under /app.
#
# No secrets are baked in: MONGODB_URI, ENTRA_* and the rest come from Railway's service variables at runtime.
FROM node:22-bookworm-slim

WORKDIR /app

# Production by default: the server refuses to start without AUTH_MODE=entra and its settings (fails closed), and the
# development APIs are disabled. Listen on all interfaces; Railway provides PORT.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Dependencies first (cached until package.json or the lockfile changes); exact versions from the lockfile.
COPY server/package.json server/package-lock.json server/
RUN npm ci --prefix server --omit=dev --no-audit --no-fund && npm cache clean --force

# Only what runs: the backend source and the static frontend (no tests, no .env).
COPY server/src server/src
COPY site site

USER node

# node directly (not npm) so Railway's SIGTERM reaches the server's graceful shutdown.
CMD ["node", "server/src/server.js"]
