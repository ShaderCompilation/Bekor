# Development image: runs the API, worker and migrations from source with tsx (no build step).
# Build context is the repository root (see compose.yaml).
FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ENV CI=true
RUN npm install --global pnpm@12.14.0 && npm cache clean --force
RUN mkdir /app && chown node:node /app
WORKDIR /app
USER node
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile
