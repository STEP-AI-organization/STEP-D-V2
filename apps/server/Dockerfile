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
    python3-venv \
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
# ── 프로그램 AI 자동채움 (경량 파이썬) ─────────────────────────────────────────
# /api/programs/:id/autofill 이 core.common.autofill_program 을 스폰한다. 이 모듈은 **google-genai
# 만** 쓰는 가벼운 유틸이라(torch·mediapipe 같은 무거운 파이프라인은 워커 이미지 Dockerfile.worker 에만)
# 서버에도 얹는다. 예전엔 서버 이미지에 core/ 도 google-genai 도 없어 프로덕션에서 autofill 이 조용히
# 실패했다(사용자 2026-08-20 · 로컬 dev 는 venv 가 있어 됐던 것). REPO_ROOT=/app 이라 core→/app/core,
# CORE_PYTHON 은 google-genai 만 든 경량 venv. venv 를 core COPY 앞에 둬 레이어 캐시를 살린다.
RUN python3 -m venv /opt/autofillvenv \
 && /opt/autofillvenv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/autofillvenv/bin/pip install --no-cache-dir google-genai
ENV CORE_PYTHON=/opt/autofillvenv/bin/python
COPY core core
# 쇼츠 프레임 템플릿 — shorts-template.ts 가 /app/assets/shorts-template 에서 읽는다.
# 빼먹으면 편집기 템플릿 목록이 프로덕션에서만 빈 배열이 된다(로컬은 멀쩡해서 안 보인다).
COPY assets/shorts-template assets/shorts-template
# 렌더 폰트 — Pretendard (OFL). ASS 스타일이 Fontname=Pretendard 로 굽는다.
# 미설치면 libass 가 Noto 로 폴백해 조용히 다른 모양이 나간다 — fc-cache 까지 해야 잡힌다.
COPY assets/fonts /usr/share/fonts/opentype/pretendard
# 자막 서체 — 지마켓 산스(사용자 확정 2026-08-28). 파일은 assets/invoice-fonts 에 있는데,
# 예전엔 앱 디렉토리로만 복사돼 **fontconfig 가 못 보는 자리**였다. 그 상태로 ASS Fontname 만
# 바꾸면 libass 가 말없이 Noto 로 대체한다 — 폰트 교체가 조용히 무효가 되는 전형적인 자리라
# 여기 복사와 captionAssStyle 의 이름은 반드시 세트로 움직인다.
COPY assets/invoice-fonts /usr/share/fonts/truetype/gmarket
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