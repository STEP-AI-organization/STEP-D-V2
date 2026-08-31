import { NextResponse } from "next/server";

/**
 * 지금 프로덕션에 떠 있는 배포의 커밋. **수십 바이트짜리 응답이고 오리진을 부르지 않는다.**
 *
 * 왜 필요한가 — 2026-08-31: 낡은 탭들이 11 MB 엔드포인트를 8초마다 부르고 있었는데, 코드를
 * 고쳐 배포해도 **이미 열린 탭에는 밀어 넣을 방법이 없었다.** 브라우저는 새로고침 전까지
 * 받아 둔 스크립트를 계속 돈다. 사람에게 "각자 새로고침하세요" 라고 부탁하는 것 말고는
 * 수단이 없었고, 쓰는 사람이 여럿이면 그건 수단이 아니다.
 *
 * 이 라우트가 그 수단이다. 번들에 박힌 빌드 커밋(`APP_BUILD_SHA`)과 여기 값이 다르면
 * 그 탭은 낡은 것이므로 **스스로 새로고침한다**(`components/shell/sidebar.tsx`).
 *
 * `force-dynamic` 이 필수다 — 캐시되면 영원히 옛 커밋을 돌려주고 아무도 갱신되지 않는다.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { sha: process.env.VERCEL_GIT_COMMIT_SHA ?? "" },
    { headers: { "cache-control": "no-store" } },
  );
}
