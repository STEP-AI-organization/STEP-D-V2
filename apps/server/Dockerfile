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

WORKDIR /app

# ── deps layer (cached) ──────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/ 2>/dev/null || true
RUN pnpm install --frozen-lockfile

# ── build ─────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./ 2>/dev/null || true
COPY apps/server/tsconfig.json apps/server/
COPY apps/server/src apps/server/src
RUN pnpm --filter server build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/apps/server/dist /app/apps/server/dist
COPY --from=deps /app/apps/server/node_modules /app/apps/server/node_modules 2>/dev/null || true

EXPOSE 4000
CMD ["node", "/app/apps/server/dist/index.js"]