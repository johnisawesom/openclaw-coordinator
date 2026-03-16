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

# Copy lockfile + package.json
COPY --chown=node:node package.json package-lock.json* ./

# Install production deps only
RUN npm ci --omit=dev --prefer-offline --no-audit --progress=false

# ── Build stage (dev deps + tsc) ─────────────────────────────────────────────
FROM base AS build

# Copy lockfile + package.json + tsconfig + src
COPY --chown=node:node package.json package-lock.json* tsconfig.json ./
COPY --chown=node:node src/ ./src/

# Install all deps (incl dev for tsc)
RUN npm ci --prefer-offline --no-audit --progress=false

# Build
RUN npm run build

# ── Final release stage ──────────────────────────────────────────────────────
FROM base AS release

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=256

# Copy production node_modules from deps
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# Copy built dist from build stage
COPY --from=build --chown=node:node /app/dist ./dist

# Copy package.json (needed for "type": "module" etc.)
COPY --chown=node:node package.json ./

# Expose Fly health port
EXPOSE 8080

# Healthcheck (optional but recommended for Fly)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Start the app (dist/index.js – confirm this matches your tsc outDir + entry)
CMD ["node", "dist/index.js"]
