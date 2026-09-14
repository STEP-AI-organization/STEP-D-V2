import { NextResponse, type NextRequest } from "next/server";

/**
 * 로그인 관문 — **엣지에서 먼저 거른다.**
 *
 * 그전까지 관문은 `components/shell/auth-guard.tsx`(클라이언트 컴포넌트) 하나였다. 그래서
 * 로그인하지 않은 사람도 **앱 셸 HTML + 번들 전체를 받은 뒤에야** 로그인으로 밀려났다.
 * 대가가 둘이다 — ① 앱이 한 번 번쩍였다 사라져서 고장으로 보인다 ② 인증되지 않은 요청에
 * 번들 바이트가 나간다(프로덕션은 프록시 경유라 바이트가 곧 과금이다).
 *
 * ## 이건 보안 장치가 아니다
 * 쿠키가 **있는지**만 본다. 유효한지·만료됐는지·누구 것인지는 여기서 모른다(HttpOnly 값을
 * 검증하려면 서버를 불러야 하고, 그러면 모든 내비게이션마다 왕복이 붙는다).
 * 진짜 방어는 그대로 서버에 있다 — 세션 검증과 테넌트 RLS. 이 파일을 통째로 지워도
 * 남의 데이터는 나오지 않는다. 여기서 줄이는 건 **낭비지 위험이 아니다.**
 *
 * 그래서 `AuthGuard` 를 걷어내지 않았다. 쿠키는 있는데 세션이 죽은 경우(만료·강제 로그아웃)는
 * 여기를 통과하고 AuthGuard 가 잡는다. 둘은 겹치는 게 아니라 각자 다른 경우를 맡는다.
 *
 * ## 실패 방향을 "통과" 로 잡았다
 * 판단이 서지 않으면 **들여보낸다.** 관문이 오작동했을 때 나오는 증상이 "쓸데없는 바이트가
 * 나갔다" 여야지 "아무도 못 들어온다" 면 안 된다. 로그인 자체가 막히면 고칠 방법이 배포뿐이다.
 *
 * ## 로컬 개발을 막지 않는다
 * 서버는 단일 테넌트 개발 모드로 뜰 수 있다(`authRequired=false` · 로그인도 쿠키도 없다).
 * 그 상태에서 쿠키가 없다고 밀어내면 로컬에서 앱을 아예 못 연다. 그래서 **프록시 경유일 때만**
 * 건다 — `NEXT_PUBLIC_API_URL=/api/proxy/api` 는 배포본에서만 잡히는 값이다(루트 CLAUDE.md
 * "배포" 참조). 새 스위치 env 를 만들지 않은 건 이 리포 원칙이기도 하다: env 는 시크릿과
 * 인프라 위치만 담고, 동작 스위치는 만들지 않는다.
 */

/** 서버가 굽는 세션 쿠키 (`apps/server/src/auth/auth.ts` SESSION_COOKIE). */
const SESSION_COOKIE = "stepd_session";

/**
 * 로그인 없이 열려야 하는 화면.
 *
 * `/landing` 은 `next.config.ts` 의 `beforeFiles` 리라이트로 정적 HTML 을 서빙한다.
 * 미들웨어는 리라이트 **전에** 돌아서 원래 경로(`/landing`)로 보이므로 여기 적는다.
 */
const PUBLIC_PATHS = new Set([
  "/login",
  "/register",
  "/invite",
  "/terms",
  "/privacy",
  "/data-deletion",
  "/landing",
]);

/** 프록시 경유 = 배포본. 로컬 직결(값 없음·절대 URL)에서는 관문을 걸지 않는다. */
const GATE_ENABLED = (process.env.NEXT_PUBLIC_API_URL ?? "").startsWith("/api/proxy");

export function middleware(request: NextRequest) {
  if (!GATE_ENABLED) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  // 돌아올 곳을 들고 간다 — 로그인 후 대시보드로만 보내면 하던 일을 다시 찾아가야 한다.
  // (`app/login/page.tsx` 가 `next` 를 읽어 그리로 보낸다.)
  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  /**
   * 안 도는 곳을 정확히 적는다 — 미들웨어는 호출당 과금이라 정적 자산까지 태울 이유가 없다.
   *
   * ⚠️ **`api` 를 빼는 건 필수다.** `/api/proxy/*` 로는 고객사 시스템이 API 키로 붙는다
   *    (`x-api-key` · 루트 CLAUDE.md "용어"). 그쪽은 세션 쿠키가 없으므로 관문을 걸면
   *    남의 연동이 통째로 끊긴다.
   * ⚠️ 마지막 `\\..*` 는 확장자가 있는 요청(=`public/` 자산)을 통과시킨다. 로그인 화면이
   *    쓰는 `login_background_image1.jpg` 와 `fonts/` 가 여기 걸린다 — 막으면 로그인
   *    화면이 깨진 채로 뜬다.
   */
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
