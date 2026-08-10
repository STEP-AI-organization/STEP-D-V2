# STEP-D Server — Cloud Run image
# Includes ffmpeg for video processing.

FROM node:22-bookworm-slim AS base

# Install ffmpeg + build deps for native modules.
# fonts-noto-cjk + fontconfig: libass needs a CJK font installed or Korean subtitle
# burn-in (construct F, /clips/:id/export) renders tofu boxes (□) instead of 한글.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-noto-cjk \
    fontconfig \
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
# Install deps — ignore build scripts, then only rebuild esbuild (the only one that needs it)
RUN pnpm install --no-frozen-lockfile --ignore-scripts && pnpm rebuild esbuild

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app
# Copy all monorepo files needed (no node_modules, handled separately)
COPY package.json ./
COPY apps/server apps/server
# 쇼츠 프레임 템플릿 — shorts-template.ts 가 /app/assets/shorts-template 에서 읽는다.
# 빼먹으면 편집기 템플릿 목록이 프로덕션에서만 빈 배열이 된다(로컬은 멀쩡해서 안 보인다).
COPY assets/shorts-template assets/shorts-template
# Overwrite server node_modules from deps layer
COPY --from=deps /app/apps/server/node_modules /app/apps/server/node_modules

EXPOSE 4000
ENV NODE_ENV=production
WORKDIR /app/apps/server
CMD ["npx", "tsx", "src/index.ts"]