import { NextRequest, NextResponse } from "next/server";
import { getIdToken } from "@/lib/gcp-auth";
import { HOP_BY_HOP } from "@/lib/proxy-headers";

export const runtime = "nodejs";

/**
 * 렌더 전용 프록시 — `clips/:id/export` 만 **stepd-render** 서비스로 보낸다.
 *
 * 왜 별도 프록시인가: 렌더(ffmpeg 인코딩)는 서버가 하는 가장 무거운 작업인데 예전엔 메인 서버
 * (2vCPU · concurrency 10)에서 동기로 돌아 동시 렌더가 서로 CPU 를 뺏었다. stepd-render 는
 * concurrency=1 · 4vCPU 라 Cloud Run 이 렌더 하나당 인스턴스를 서버리스로 팬아웃한다.
 *
 * ⚠️ **하드닝**: export 경로 하나만 통과시킨다(다른 라우트는 404).
 */
const RENDER_RUN_URL = (process.env.RENDER_RUN_URL
  || "https://stepd-render-872105344568.us-central1.run.app").replace(/\/$/, "");

/** undici 는 TypeError("fetch failed") 로 감싸고 실제 원인은 e.cause.code 에 있다. */
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
    // 홉바이홉 헤더를 지운다 — 메인 프록시와 같은 이유이자 **같은 사고**다. transfer-encoding 이
    // 그대로 넘어가면 undici 가 UND_ERR_INVALID_ARG 로 던져 렌더 요청이 502 가 된다.
    // (근거는 메인 프록시 HOP_BY_HOP 주석 — 정본은 거기 하나로 둔다.)
    for (const h of HOP_BY_HOP) headers.delete(h);
    headers.set("Authorization", token);
    // 메인 프록시와 같은 이유 — keep-alive 죽은 소켓 재사용(ECONNRESET)을 원천 차단한다.
    // 매 요청 새 연결(재시도 없음).
    headers.set("connection", "close");

    const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const hasBody = bytes !== undefined && request.method !== "GET" && request.method !== "HEAD";

    const upstreamRes = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: hasBody ? bytes : undefined,
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
