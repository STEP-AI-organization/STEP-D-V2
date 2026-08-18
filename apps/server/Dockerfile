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
# 렌더 폰트 — Pretendard (OFL). ASS 스타일이 Fontname=Pretendard 로 굽는다.
# 미설치면 libass 가 Noto 로 폴백해 조용히 다른 모양이 나간다 — fc-cache 까지 해야 잡힌다.
COPY assets/fonts /usr/share/fonts/opentype/pretendard
RUN fc-cache -f
# canvas(@napi-rs/canvas) 정적 오버레이 PNG 렌더가 리포 상대경로(assets/fonts)로 Pretendard 를
# 등록한다(overlay-canvas.ts). 미설치면 fontconfig 경로로 폴백하지만, 두 경로가 같은 파일을
# 가리키게 여기도 복사한다 — shorts-template 과 같은 /app/assets 규칙.
COPY assets/fonts assets/fonts
# 인보이스 PDF 폰트 — jsPDF 는 TTF 만 임베드한다(Pretendard OTF 는 CFF 라 못 쓴다).
# invoice.ts 가 리포 상대경로(assets/invoice-fonts)로 읽는다 — 빼먹으면 메일 발송만 조용히 실패.
COPY assets/invoice-fonts assets/invoice-fonts
# Overwrite server node_modules from deps layer
COPY --from=deps /app/apps/server/node_modules /app/apps/server/node_modules

EXPOSE 4000
ENV NODE_ENV=production
WORKDIR /app/apps/server
CMD ["npx", "tsx", "src/index.ts"]