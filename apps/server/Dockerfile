# STEP-D Server — Cloud Run image
# Includes ffmpeg for video processing.

FROM node:22-bookworm-slim AS base

# Install ffmpeg + build deps for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm@latest

# ── deps layer (cached) ──────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app/apps/server
COPY apps/server/package.json ./
RUN pnpm install --no-frozen-lockfile

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app
# Copy all monorepo files needed (no node_modules, handled separately)
COPY package.json ./
COPY apps/server apps/server
# Overwrite server node_modules from deps layer
COPY --from=deps /app/apps/server/node_modules /app/apps/server/node_modules

EXPOSE 4000
ENV NODE_ENV=production
WORKDIR /app/apps/server
CMD ["npx", "tsx", "src/index.ts"]