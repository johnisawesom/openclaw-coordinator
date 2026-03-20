# syntax=docker/dockerfile:1

# ── Base stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS base

# Install minimal deps (certificates for HTTPS to Qdrant etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Run as non-root
USER node

WORKDIR /app

# ── Deps stage (production deps only) ────────────────────────────────────────
FROM base AS deps

COPY --chown=node:node package.json ./

RUN npm install --omit=dev --no-audit --progress=false

# ── Build stage (dev deps + tsc) ─────────────────────────────────────────────
FROM base AS build

COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node src/ ./src/

RUN npm install --no-audit --progress=false

RUN npm run build

# ── Final release stage ──────────────────────────────────────────────────────
FROM base AS release

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=256

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]
