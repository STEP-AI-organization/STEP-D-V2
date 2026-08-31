import { NextRequest, NextResponse } from "next/server";
import { getIdToken } from "@/lib/gcp-auth";
import { HOP_BY_HOP } from "@/lib/proxy-headers";

export const runtime = "nodejs";

const CLOUD_RUN_URL = (process.env.CLOUD_RUN_URL || "https://stepd-server-872105344568.us-central1.run.app").replace(/\/$/, "");

/** undici 는 TypeError("fetch failed") 로 감싸고 실제 원인은 e.cause.code 에 있다. 진단용으로 실어 보낸다. */
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

/**
 * 낡은 탭이 보낸 `/api/state` 요청인가.
 *
 * 2026-08-31: 사이드바 연결 표시등이 이 **11 MB** 엔드포인트를 8초마다 불렀고, 탭 하나당
 * 시간당 ~5 GB 가 오리진에서 흘러 Vercel **Fast Origin Transfer** 로 청구됐다(3시간 34.5 GB).
 * 코드는 고쳤지만 **이미 열려 있는 탭에는 새 코드를 밀어 넣을 방법이 없다** — 브라우저는
 * 새로고침하기 전까지 받아 둔 스크립트를 계속 돈다. 그래서 여기서 끊는다.
 *
 * 판별: 살아 있는 번들은 `x-stepd-app` 을 붙인다(fetchState). 없으면 낡은 탭이다.
 *
 * ⚠️ **API 키로 붙는 고객사 시스템은 통과시킨다.** 그쪽은 우리 번들이 아니라 헤더가 없고,
 *    막으면 남의 연동이 끊긴다. 세션 쿠키를 들고 오는 브라우저 요청만 대상으로 한다.
 */
function isStaleTabState(request: NextRequest, upstreamPath: string): boolean {
  if (upstreamPath !== "/api/state") return false;
  if (request.headers.get("x-stepd-app")) return false;          // 살아 있는 번들
  if (request.headers.get("authorization")) return false;        // API 키 호출 — 남의 시스템
  return request.headers.has("cookie");                          // 쿠키 = 브라우저 탭
}

async function proxy(request: NextRequest, paramsPromise: Promise<{ path?: string[] }>) {
  const { path } = await paramsPromise;
  const upstreamPath = path ? `/${path.join("/")}` : "";
  const upstreamUrl = `${CLOUD_RUN_URL}${upstreamPath}${request.nextUrl.search}`;

  // 오리진을 아예 부르지 않는다 — 요청이 아니라 **11 MB 응답 본문**이 비용이기 때문이다.
  // 낡은 탭은 이 응답으로 "서버 미연결" 을 띄우고, 그게 사람에게 새로고침하라는 신호가 된다.
  if (isStaleTabState(request, upstreamPath)) {
    return NextResponse.json(
      { error: "stale_client", message: "새 버전이 배포됐습니다 — 새로고침해 주세요." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const token = await getIdToken();
    const headers = new Headers(request.headers);
    headers.delete("host");
    // 본문을 버퍼로 다시 보내므로 원본 길이 헤더는 버린다 — 안 맞으면 업스트림이 끊는다.
    headers.delete("content-length");
    for (const h of HOP_BY_HOP) headers.delete(h);
    headers.set("Authorization", token);

    // **keep-alive 소켓 재사용 차단.** Vercel 서버리스 함수가 freeze/thaw 되면 undici 풀에 남은
    // 소켓이 죽어 있어, 그걸 재사용한 요청이 ECONNRESET 으로 죽는다(저장·렌더·채택이 "됐다 안 됐다"
    // 하던 것 중 하나). Connection: close 면 매 요청이 새 연결이라 재사용할 죽은 소켓이 없다.
    // 대가는 요청마다 handshake ~수십 ms(Cloud Run 이 가까워 무시할 만하다).
    //
    // ⚠️ 이 줄은 **UND_ERR_INVALID_ARG 와 무관하다.** 2026-08-21 에 그 오류까지 여기서 막힌다고
    //    적어 뒀는데 틀렸다 — 진짜 원인은 위 HOP_BY_HOP(transfer-encoding 통과)이었고, 그 뒤로도
    //    같은 오류가 계속 났다(2026-08-28 "삭제 실패 · fetch failed (UND_ERR_INVALID_ARG)").
    //    두 오류는 원인이 다르므로 대책도 둘 다 필요하다.
    headers.set("connection", "close");

    // GET/HEAD 는 본문이 있으면 안 된다(undici 가 거부) — 브라우저가 빈 스트림을 줘도 안 싣는다.
    const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const hasBody = bytes !== undefined && request.method !== "GET" && request.method !== "HEAD";

    const upstreamRes = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: hasBody ? bytes : undefined,
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
    // 예외를 그대로 두면 **빈 500** 이 나가서 원인을 알 수 없다(2026-08-11 "간헐 로그인 실패" 삽질의
    // 원인). 사유 + undici 원인 코드를 실어 보낸다 — 토스트·로그에 코드가 그대로 보여 재발 시 진단이 된다.
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
