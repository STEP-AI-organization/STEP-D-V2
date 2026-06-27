# Deno binary — yt-dlp >=2026 requires an external JS runtime to decrypt
# YouTube's "n" throttling parameter. Deno is the default supported runtime.
FROM denoland/deno:bin AS deno-bin

FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8010 \
    DATABASE_URL=sqlite:////data/app.db \
    STORAGE_DIR=/data \
    FFMPEG_BINARY=ffmpeg \
    FFPROBE_BINARY=ffprobe

COPY --from=deno-bin /deno /usr/local/bin/deno

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates fonts-noto-cjk nodejs fontconfig \
    && rm -rf /var/lib/apt/lists/*

COPY apps/api/assets/fonts/ /usr/share/fonts/truetype/gmarket/
RUN fc-cache -fv

COPY apps/api/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY apps/api/ ./

RUN mkdir -p /data

EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
