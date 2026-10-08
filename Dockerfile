# syntax=docker/dockerfile:1

# =============================================================================
# NetOps Policy Manager — Nuxt 4 (frontend + Nitro server) fullstack image.
# Multi-stage: install deps + build, then ship a slim runtime with only the
# production node_modules and the Nitro .output bundle.
# =============================================================================

# Node 24 to match .nvmrc / package.json engines (>=22 <25).
ARG NODE_VERSION=24

# -----------------------------------------------------------------------------
# Stage 1 — build: install ALL deps (incl. dev) and produce .output
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

# Build toolchain for native modules (argon2 needs node-gyp + python + g++).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=development
ENV HUSKY=0

# Install dependencies against the lockfile for reproducible builds.
# postinstall runs `nuxt prepare`, which needs the full source, so copy it
# before install.
COPY package.json package-lock.json ./
COPY . .
RUN npm ci

# Produce the Nitro node-server bundle at .output/.
RUN npm run build

# Drop dev dependencies so we can copy a lean node_modules into runtime.
RUN npm prune --omit=dev

# -----------------------------------------------------------------------------
# Stage 2 — runtime: minimal image that just runs the built server
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Nitro node-server listens on HOST:PORT; bind all interfaces inside the container.
ENV HOST=0.0.0.0
ENV PORT=3000

# Run as the built-in non-root `node` user.
USER node

# The Nitro output is self-contained; it bundles server code and references
# production node_modules only for native addons (argon2, etc.).
COPY --chown=node:node --from=build /app/.output ./.output
COPY --chown=node:node --from=build /app/node_modules ./node_modules

EXPOSE 3000

# All config (DATABASE_URL, ITOP_DATABASE_URL, N8N_*, SESSION_*, MFA_*, AD_*)
# is injected at runtime via environment variables — never baked into the image.
CMD ["node", ".output/server/index.mjs"]
