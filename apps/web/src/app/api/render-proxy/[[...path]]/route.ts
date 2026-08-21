import { NextRequest, NextResponse } from "next/server";
import { getIdToken } from "@/lib/gcp-auth";

export const runtime = "nodejs";

/**
 * 렌더 전용 프록시 — `clips/:id/export` 만 **stepd-render** 서비스로 보낸다.
 *
 * 왜 별도 프록시인가: 렌더(ffmpeg 인코딩)는 서버가 하는 가장 무거운 작업인데 예전엔 메인
 * 서버(stepd-server · 2vCPU · concurrency 10)에서 동기로 돌아, 렌더 두 개가 같은 인스턴스에
 * 붙으면 2vCPU 를 나눠 써 둘 다 기어갔다(사용자 2026-08-21 "동시에 하면 다 느려"). stepd-render
 * 는 **concurrency=1 · 4vCPU** 라 Cloud Run 이 렌더 하나당 인스턴스를 하나씩 서버리스로 띄운다
 * → 동시 렌더가 서로 CPU 를 안 뺏고, 메인 API 서버는 렌더에 안 눌린다.
 *
 * ⚠️ **하드닝**: 이 프록시는 export 경로 하나만 통과시킨다. stepd-render 는 같은 이미지라 모든
 * 라우트를 갖지만(발행·결제 포함), 여기로는 렌더만 닿게 해 오용을 막는다.
 */
// stepd-render 서비스 URL (projectnumber 형 — 메인 프록시가 같은 형을 써서 검증됨 · 오디언스로도 통과).
const RENDER_RUN_URL = (process.env.RENDER_RUN_URL
  || "https://stepd-render-872105344568.us-central1.run.app").replace(/\/$/, "");

// 연결 단계 오류(응답 전) — 죽은 keep-alive 소켓 재사용 등. 안전하게 재시도(메인 프록시와 같은 규칙).
const RETRYABLE_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ETIMEDOUT",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
]);
function connErrorCode(e: unknown): string | undefined {
  const cause = (e as { cause?: { code?: string } })?.cause;
  return cause?.code ?? (e as { code?: string })?.code;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  return proxy(request, params);
}

async function proxy(request: NextRequest, paramsPromise: Promise<{ path?: string[] }>) {
  const { path } = await paramsPromise;
  const upstreamPath = path ? `/${path.join("/")}` : "";
  // export 만 허용 — 다른 경로는 이 프록시로 못 간다.
  if (!/^\/api\/clips\/[^/]+\/export$/.test(upstreamPath)) {
    return NextResponse.json(
      { error: "render_proxy_forbidden", message: "이 프록시는 렌더(export)만 허용합니다.", path: upstreamPath },
      { status: 404 },
    );
  }
  const upstreamUrl = `${RENDER_RUN_URL}${upstreamPath}${request.nextUrl.search}`;

  try {
    const token = await getIdToken(RENDER_RUN_URL);   // ← 렌더 서비스 URL 을 오디언스로
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.set("Authorization", token);

    const body = request.body ? await request.arrayBuffer() : undefined;

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 120 : 400));
      try {
        const upstreamRes = await fetch(upstreamUrl, {
          method: request.method,
          headers,
          body,
          redirect: "manual",
        });
        const resHeaders = new Headers(upstreamRes.headers);
        resHeaders.delete("content-encoding");
        resHeaders.delete("content-length");
        return new NextResponse(upstreamRes.body, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: resHeaders,
        });
      } catch (e) {
        lastErr = e;
        const code = connErrorCode(e);
        if (!code || !RETRYABLE_CODES.has(code)) break;
        console.warn(`[render-proxy] ${request.method} ${upstreamPath} 연결 실패(${code}) — 재시도 ${attempt + 1}/2`);
      }
    }
    throw lastErr;
  } catch (e) {
    const code = connErrorCode(e);
    const base = e instanceof Error ? e.message : String(e);
    const message = code ? `${base} (${code})` : base;
    console.error(`[render-proxy] ${request.method} ${upstreamPath} 실패:`, e);
    return NextResponse.json(
      { error: "render_proxy_failed", message, path: upstreamPath },
      { status: 502 },
    );
  }
}
