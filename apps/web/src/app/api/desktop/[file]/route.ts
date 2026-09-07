import { NextRequest, NextResponse } from "next/server";
import { getIdToken } from "@/lib/gcp-auth";
import { HOP_BY_HOP } from "@/lib/proxy-headers";

export const runtime = "nodejs";
// 캐시되면 새 버전을 발행해도 옛 latest.yml 이 계속 나가고, 아무 PC 도 갱신되지 않는다.
export const dynamic = "force-dynamic";

/**
 * 데스크톱 앱(STEPAISTUDIO) 자동 업데이트 피드 — **웹 도메인에서 서버로 가는 통로.**
 *
 * ## 왜 이 파일이 필요한가
 *
 * 앱은 `https://stepd.stepai.kr/api/desktop/latest.yml` 을 본다. 그런데 이 도메인의
 * `/api/*` 는 **Next.js 가 받는다** — 서버(Cloud Run)로 저절로 가지 않는다. 그리고
 * Cloud Run 은 IAM 으로 잠겨 있어(`domain:stepai.kr` + 배포 SA · allUsers 없음) 앱이
 * 직접 부르면 **403** 이다.
 *
 * 그래서 통로가 필요하다. 이걸 빠뜨리면 업데이터는 404 만 보고 **영원히 조용히** 갱신을
 * 안 한다 — 아무 오류도 안 뜨고, 편집자는 지금까지도 수동 설치였으니 이상함도 못 느낀다.
 * (실제로 이 상태로 만들었다가 배포 직전에 잡았다.)
 *
 * ## 설치본 바이트는 여기를 안 지난다
 *
 * `redirect: "manual"` 로 받아서 **302 를 그대로 흘려보낸다.** 서버는 GCS 서명 URL 로
 * 302 하므로, 앱은 그 URL 로 직접 간다 — 100MB 설치본이 Vercel 을 통과하지 않는다.
 * 여기서 `redirect: "follow"` 로 쓰면 그 바이트가 전부 Vercel 대역폭(FOT) 청구가 된다.
 * 몸통을 흘려보내는 건 `latest.yml`(1KB 남짓) 뿐이다.
 *
 * ⚠️ **세션을 요구하지 않는다.** 업데이트는 로그인 전에도 받아야 한다 — 로그인 화면이
 *    깨진 버전을 고치는 것이 그 업데이트의 목적일 수 있다. 대신 이름을 좁혀서 잠근다.
 */
const CLOUD_RUN_URL = (process.env.CLOUD_RUN_URL
  || "https://stepd-server-872105344568.us-central1.run.app").replace(/\/$/, "");

/**
 * 내줄 수 있는 이름 — **서버의 `desktopObject` 와 같은 규칙.** 두 겹으로 좁힌다.
 * 여기서 한 번 막으면 잘못된 이름이 Cloud Run 까지 가지도 않는다.
 */
const ALLOWED = /^[A-Za-z0-9._-]+\.(yml|exe|blockmap|zip)$/;

export async function GET(request: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!ALLOWED.test(file)) {
    return NextResponse.json({ error: "bad_name" }, { status: 400 });
  }

  const upstreamUrl = `${CLOUD_RUN_URL}/api/desktop/${file}`;
  try {
    const token = await getIdToken(CLOUD_RUN_URL);
    const headers = new Headers();
    for (const h of HOP_BY_HOP) headers.delete(h);
    headers.set("Authorization", token);
    // 메인 프록시와 같은 이유 — keep-alive 죽은 소켓 재사용(ECONNRESET) 차단.
    headers.set("connection", "close");

    const res = await fetch(upstreamUrl, { method: "GET", headers, redirect: "manual" });

    const out = new Headers(res.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    // 302 면 `location` 이 살아 있어야 한다 — 그게 GCS 직행 경로다.
    return new NextResponse(res.body, { status: res.status, statusText: res.statusText, headers: out });
  } catch (e) {
    console.error(`[desktop-feed] ${file} 실패:`, e);
    // ⚠️ 502 가 아니라 404 로 답한다. electron-updater 는 404 를 "업데이트 없음" 으로
    //    조용히 넘기지만 5xx 는 오류로 요란하게 남기고 재시도한다 — 서버가 잠깐 죽은 것이
    //    편집자 로그를 채울 일은 아니다.
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
}
