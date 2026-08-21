import { NextRequest, NextResponse } from "next/server";
import { getIdToken } from "@/lib/gcp-auth";

export const runtime = "nodejs";

const CLOUD_RUN_URL = (process.env.CLOUD_RUN_URL || "https://stepd-server-872105344568.us-central1.run.app").replace(/\/$/, "");

/**
 * 업스트림(Cloud Run)으로의 **연결 단계**에서 undici 가 던지는 코드들.
 *
 * 이 오류들은 응답을 받기 전에 난다 — 요청이 서버에 닿지 못했거나(연결 거부·DNS),
 * 재사용한 keep-alive 소켓이 이미 죽어 있던 경우다. Vercel 서버리스 함수가 얼었다 깨어나면
 * (freeze/thaw) 풀에 남은 소켓이 죽어 있어 **첫 요청만 ECONNRESET → "fetch failed"**,
 * 재시도하면 새 소켓이라 통과한다 — 사용자가 본 "됐다 안 됐다 · 바로 누르면 실패" 의 정체다.
 *
 * ⚠️ HTTP 4xx/5xx 는 여기 없다. 그건 서버가 **실제로 응답한** 것이라 재시도하지 않고 그대로
 * 흘려보낸다(예: 409 게이트, 400 검증). 재시도는 오직 fetch 가 **던졌을 때**만.
 */
const RETRYABLE_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ETIMEDOUT",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
]);

/** undici 는 TypeError("fetch failed") 로 감싸고 실제 원인은 e.cause.code 에 있다. */
function connErrorCode(e: unknown): string | undefined {
  const cause = (e as { cause?: { code?: string } })?.cause;
  return cause?.code ?? (e as { code?: string })?.code;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  return proxy(request, params);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  return proxy(request, params);
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  return proxy(request, params);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  return proxy(request, params);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  return proxy(request, params);
}

async function proxy(request: NextRequest, paramsPromise: Promise<{ path?: string[] }>) {
  const { path } = await paramsPromise;
  const upstreamPath = path ? `/${path.join("/")}` : "";
  const upstreamUrl = `${CLOUD_RUN_URL}${upstreamPath}${request.nextUrl.search}`;

  try {
    const token = await getIdToken();
    const headers = new Headers(request.headers);
    headers.delete("host");
    // 본문을 버퍼로 다시 보내므로 원본 길이 헤더는 버린다 — 안 맞으면 업스트림이 끊는다.
    headers.delete("content-length");
    headers.set("Authorization", token);

    // body 를 ArrayBuffer 로 미리 버퍼링한다 — 스트림이 아니라서 재시도에 그대로 다시 실린다.
    const body = request.body ? await request.arrayBuffer() : undefined;

    // 연결 오류(RETRYABLE_CODES)면 새 소켓으로 다시 시도한다 — 죽은 keep-alive 소켓 재사용이
    // 원인인 "fetch failed" 를 흡수한다(저장·렌더·채택이 "됐다 안 됐다" 하던 그것).
    //
    // ⚠️ 재시도는 fetch 가 **던졌을 때만** — 응답을 받기 전(연결 단계) 실패다. HTTP 상태
    // (4xx/5xx)는 서버가 실제로 응답한 것이라 재시도하지 않고 그대로 반환한다(409 게이트·400
    // 검증 등이 두 번 돌면 안 된다). 죽은 소켓 재사용은 요청을 쓰는 순간 끊겨(ECONNRESET)
    // 서버엔 닿지 않으므로 재시도가 안전하다. 설령 드물게 서버가 받은 뒤 끊겼더라도, 사용자가
    // 에러를 보고 손으로 다시 누르는 것과 위험이 같다 — 자동 재시도가 새 위험을 더하지 않는다.
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
        // fetch 가 이미 압축을 풀었으므로 둘 다 지운다. content-length 를 남기면
        // 압축 크기가 그대로 실려 응답이 잘린다.
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
        if (!code || !RETRYABLE_CODES.has(code)) break;   // 재시도 불가 → 즉시 중단
        console.warn(`[proxy] ${request.method} ${upstreamPath} 연결 실패(${code}) — 재시도 ${attempt + 1}/2`);
      }
    }
    throw lastErr;
  } catch (e) {
    // 예외를 그대로 두면 **빈 500** 이 나가서 원인을 알 수 없다. 실제로 그것 때문에
    // "간헐적으로 로그인이 안 된다"를 한참 헤맸다(2026-08-11). 사유 + undici 원인 코드를
    // 실어 보낸다 — 토스트·로그에 ECONNRESET 등이 그대로 보여 재발 시 진단이 된다.
    const code = connErrorCode(e);
    const base = e instanceof Error ? e.message : String(e);
    const message = code ? `${base} (${code})` : base;
    console.error(`[proxy] ${request.method} ${upstreamPath} 실패:`, e);
    return NextResponse.json(
      { error: "proxy_failed", message, path: upstreamPath },
      { status: 502 },
    );
  }
}
